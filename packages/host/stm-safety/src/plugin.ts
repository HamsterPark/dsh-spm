/**
 * `ctx.stmSafety` —— 把 kernel 的闸门接到 dsh 的工具管线上。
 *
 * ## 为什么拒绝走 `guard` 而不是 `tools/pre-execute`
 *
 * `ctx.tools.guard` 是**单调**的：它只能拒，`undefined` 表示「不改变现状」，
 * 而且**没有任何 guard 能把另一个 guard 的拒绝翻回放行**。安全件正需要这个性质——
 * 一个能被后来者覆盖的拒绝，等于没有拒绝。
 *
 * `tools/pre-execute` 是可以回 `allow` 的瀑布，所以它只用来做**要人审**（`ask`）的那一类。
 *
 * ## 判定顺序就是判据本身（PLAN §8.1 的 K7）
 *
 * 物理荒谬 → 可调包络 → 操作模式 → 硬闸。**物理荒谬排第一**：它给出的重试信号最干脆
 * （改量级，不是「把上限调高」），而且就算某个技能的上界被放宽了它依然成立。
 *
 * 样品门控单独一条，**方向相反**（fail-open，见 kernel 的说明），所以不混在这条链里。
 */
import { type Context, Service, type CommandDefinition } from 'dsh-spm-compat'
import {
  DEFAULT_SAFETY_LIMITS,
  checkSampleScope,
  envelopeViolations,
  isCalibrationChange,
  isCoarseDriveChange,
  approvalDigest,
  isCoarseSampleApproach,
  isProtectionDisable,
  isUnguardedLateralCoarseMove,
  modeRefusal,
  physicallyAbsurdViolations,
  type ExperimentPointers,
  type OperatingMode,
  type SafetyLimits,
  type SkillMetaLike,
} from 'dsh-spm-kernel'

export const name = 'mast-safety'

/** 技能声明：闸门要靠它拿单位与能力标签。 */
export interface SkillDeclaration extends SkillMetaLike {
  readonly tags?: readonly string[] | undefined
  readonly category?: string | undefined
}

/** 机器可判的拒绝码。**判据不落在文案上**（PLAN §3.2-16）。 */
export type RefusalCode =
  | 'physically_absurd'
  | 'envelope'
  | 'operating_mode'
  | 'sample_gate'
  | 'hard_gate'

export type SafetyVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly code: RefusalCode; readonly reason: string }
  | { readonly kind: 'ask'; readonly code: 'hard_gate'; readonly reason: string; readonly gate: string }

export interface DecideOptions {
  /** 谁发起的。**`llm` 来源撞上硬闸一律拒**，不是问——模型不能给自己批准。 */
  readonly approvalSource?: 'llm' | 'human' | 'auto' | undefined
}

/** 五条硬闸，逐条带上「为什么它要人」。 */
const HARD_GATES: readonly {
  readonly id: string
  readonly test: (skill: string, args: Readonly<Record<string, unknown>>) => boolean
  readonly why: string
}[] = [
  {
    id: 'coarse_sample_approach',
    test: isCoarseSampleApproach,
    why: '粗 Z 步进没有电流反馈停止，步数或步长过大会把针撞进样品——这是唯一一类物理上危险的动作',
  },
  {
    id: 'calibration_change',
    test: (s) => isCalibrationChange(s),
    why: '改写标定刻度会改变此后所有读数与写入的含义，包括安全包络自己用的那些数',
  },
  {
    id: 'coarse_drive_change',
    test: (s) => isCoarseDriveChange(s),
    why: '改粗动的频率/幅值之后，同样的步数对应的物理位移变了',
  },
  {
    id: 'unguarded_lateral_coarse_move',
    test: isUnguardedLateralCoarseMove,
    why: '横向粗动没有反馈能告诉你撞上了侧壁',
  },
  {
    id: 'protection_disable',
    test: isProtectionDisable,
    why: '关掉一层硬件保护（SafeTip / Z 软限位）之后，出事时没有第二道网',
  },
]

export interface Config {
  /** 起手的操作模式。缺省 = 未绑定 ⇒ **模式闸放行**（「别自作主张」的一层）。 */
  readonly mode?: OperatingMode | undefined
  readonly limits?: SafetyLimits | undefined
}

export class StmSafetyService extends Service {
  private readonly skills = new Map<string, SkillDeclaration>()
  private pointers: ExperimentPointers | null = null
  private limits: SafetyLimits
  private currentMode: OperatingMode | null

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'stmSafety')
    this.limits = config.limits ?? DEFAULT_SAFETY_LIMITS
    this.currentMode = config.mode ?? null

    // ① 拒绝走 guard：**单调**，谁都翻不回来
    ctx.effect(() =>
      ctx.tools.guard((exec) => {
        const v = this.decide(exec.name, asArgs(exec.arguments), { approvalSource: 'llm' })
        return v.kind === 'deny' ? v.reason : undefined
      }),
    )

    // ② 要人审的走 pre-execute（它能回 ask，而 guard 不能）
    //
    // **`reason` 里必须带参数摘要**：dsh 的审批请求只有 agent/toolName/callId/reason，
    // **看不到参数**（spike 第 1 条的边界）。而人要批准的是「这一次、带这些参数的调用」，
    // 不是「这个工具」。摘要末尾的 `args#xxxxxx` 让审批卡与内核执行**能对上**——
    // 不等就拒。
    ctx.effect(() =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        const args = asArgs(exec.arguments)
        const v = this.decide(exec.name, args, { approvalSource: 'llm' })
        if (v.kind === 'ask') {
          return { kind: 'ask', reason: `${v.reason}\n${approvalDigest(exec.name, args)}` }
        }
        return next()
      }),
    )

    // ③ `/mode` —— 操作员切档。**注册成命令而不是工具**：模式是人的决定，
    //    不是模型的一个选项。模型能读到当前档（它进提示），但改不了。
    ctx.effect(() =>
      ctx.commands.register({
        name: 'mode',
        description: '查看或切换操作模式：SAFE（不修针）/ SEMI（只允许浅层机械修针）/ AUTO（放行）。不带参数则只显示当前档。',
        handler: (inv): { kind: 'success' | 'error'; text: string } => {
          const want = String((inv as { rawInput?: string }).rawInput ?? '')
            .trim()
            .toUpperCase()
          if (want === '') {
            return { kind: 'success', text: `当前操作模式：${this.currentMode ?? '未绑定（模式闸放行）'}` }
          }
          if (want !== 'SAFE' && want !== 'SEMI' && want !== 'AUTO') {
            return { kind: 'error', text: `不认识的模式 '${want}'。可用：SAFE / SEMI / AUTO。` }
          }
          const before = this.currentMode
          this.currentMode = want
          return { kind: 'success', text: `操作模式：${before ?? '未绑定'} → ${want}` }
        },
      } satisfies CommandDefinition as CommandDefinition),
    )
  }

  /** 登记一个技能的声明。**闸门只认登记过的技能**——没登记的按「没有量纲信息」处理。 */
  registerSkill(decl: SkillDeclaration): () => void {
    this.skills.set(decl.name, decl)
    return () => void this.skills.delete(decl.name)
  }

  get mode(): OperatingMode | null {
    return this.currentMode
  }

  /** 切档。`null` = 解绑（模式闸放行）。 */
  setMode(mode: OperatingMode | null): void {
    this.currentMode = mode
  }

  setLimits(limits: SafetyLimits): void {
    this.limits = limits
  }

  /** 接上记录系统的当前指针。`null` = 记录系统缺席 ⇒ 样品门控一律放行。 */
  setPointers(p: ExperimentPointers | null): void {
    this.pointers = p
  }

  /**
   * 一次完整判定。**顺序就是判据**：荒谬 → 包络 → 模式 → 样品 → 硬闸。
   */
  decide(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    opts: DecideOptions = {},
  ): SafetyVerdict {
    const meta = this.skills.get(toolName)
    if (meta !== undefined) {
      // ① 物理荒谬——排第一，理由见文件头
      const absurd = physicallyAbsurdViolations(meta, args)
      if (absurd.length > 0) {
        return { kind: 'deny', code: 'physically_absurd', reason: `[safety_gate] ${absurd[0]!}` }
      }

      // ② 可调包络
      const env = envelopeViolations(meta, args, this.limits)
      if (env.length > 0) {
        const v = env[0]!
        return {
          kind: 'deny',
          code: 'envelope',
          reason:
            `[safety_gate] envelope: '${v.param}' = ${v.value} 超出安全范围 ` +
            `[${v.min}, ${v.max}]。这是管理员可调的包络——若这台机器确实需要更宽的范围，` +
            `请操作员改设置，不要重试同一个值。`,
        }
      }

      // ③ 操作模式
      const refusal = modeRefusal(toolName, meta, args, this.currentMode)
      if (refusal !== null) {
        return { kind: 'deny', code: 'operating_mode', reason: `[safety_gate] ${refusal}` }
      }

      // ④ 样品门控（**方向相反**：fail-open）
      const sample = checkSampleScope(meta, toolName, this.pointers)
      if (sample !== null) return { kind: 'deny', code: 'sample_gate', reason: sample }
    }

    // ⑤ 硬闸——**它不需要技能声明**，键在技能名与原始参数上
    for (const g of HARD_GATES) {
      if (!g.test(toolName, args)) continue
      const reason =
        `[safety_gate] hard_gate:${g.id}: '${toolName}' 需要操作员在环。${g.why}。`
      // **模型来源一律拒，不是问**：模型不能给自己批准。
      if ((opts.approvalSource ?? 'llm') !== 'human') {
        return {
          kind: 'deny',
          code: 'hard_gate',
          reason: `${reason}这一类动作不能由模型自行批准——请让操作员在界面上确认。`,
        }
      }
      return { kind: 'ask', code: 'hard_gate', reason, gate: g.id }
    }

    return { kind: 'allow' }
  }
}

function asArgs(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function apply(ctx: Context, config: Config = {}): void {
  new StmSafetyService(ctx, config)
}

/** `tools` 是硬依赖：没有工具注册表就没有可以挂闸的地方。 */
export const inject = ['tools', 'commands']

export const stmSafetyProvider = { name, inject, apply }

declare module '@deepseek-ai/cordis' {
  interface Context {
    stmSafety: StmSafetyService
  }
}
