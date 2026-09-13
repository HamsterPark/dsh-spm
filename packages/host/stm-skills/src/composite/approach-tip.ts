/**
 * `ApproachTip` —— 面对一句朴素的「进针」，用**风险最低**的办法建立隧道。
 *
 * 进针这件事本身是**含糊的**：针尖可能已经在隧穿范围内（把反馈打开就行），也可能还
 * 很远（要走带电流反馈的粗进针）。这个选择带着撞针的风险，所以它**不能**取决于模型
 * 重读一个标志位再手工升级。
 *
 * 于是确定性地分两相：
 *
 * 1. `TryEngageController` —— 打开 Z 控制器看有没有隧穿电流（**不动马达**）。
 *    这一相顺带把「其实已经在隧穿了」那种情况透明地处理掉。
 * 2. **只有**反馈够不到隧穿时（`needs_auto_approach`）才退到 `AutoApproach`——
 *    Nanonis 的电流反馈进针模块，它在设定点处**硬件停止**，所以没有撞针风险。
 *    这**有意不是**开环的粗 Z 步进（`MotorMove` z-approach），那个一直待在人审闸
 *    后面，这里一次都不碰。
 *
 * ## 两条判据，同一个形状，同一个修法
 *
 * 粗进针跑完之后还要**自己再测一次**电流：2026-07-10 一次过期的续跑让
 * `AutoApproach` 一相都没跑就报了成功，agent 于是在 **0.17 pA / 设定点 500 pA** 上
 * 「确认」进针成功，然后去扫图（#42/#75）。
 *
 * 而那次复核**也**曾经是单次瞬时读数（2026-08-05）——它就长在第一处的下游，
 * 于是真机上一次成功的进针可能被同一个瞬态**判死两遍**。现在两处都走
 * `settleEngagement`。
 *
 * ## 与旧仓的差异
 *
 * - **D-APPROACH-1**（进针参数组）同 `AutoApproach`：这里也套了一层
 *   `apply_approach_preset` / `finally: restore_zctrl`，理由是**第一相就可能进成**，
 *   那一段整个在 `AutoApproach` 之外。一并欠着。
 * - **D-APPROACH-3 · dI/dV 标定窗与 qPlus 旁证不移植。** `_didv_calibration_window`
 *   要短开 lock-in 调制读一次 dI/dV 记进标定库，`_approach_evidence` 要 qPlus 振幅；
 *   两条链路本仓都还没有。**qPlus 那条是有代价的**：它回答的是电流回答不了的问题
 *   ——「针尖还自由吗」，而一根已经犁进表面的针被阻尼到不动，正好是纯电流判据读成
 *   「健康地停在设定点」的那个状态。补 lock-in 链路时必须连它一起补。
 */
import {
  engageEvidence,
  engageVerdictToDict,
  fmtA,
  processApproachRefusalLatch,
  settleEngagement,
  ENGAGE_AGREE_N,
  type ApproachRefusalLatch,
  type EngageVerdict,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import type { PresetSkillDeps } from '../l0/zctrl-presets.js'
import { applyApproachPreset, restoreZctrl } from './approach-preset.js'

export interface ApproachTipDeps {
  /** 逃逸闸。默认用进程那一把——记的一侧与读的一侧必须是同一个实例。 */
  readonly latch?: ApproachRefusalLatch
  readonly engageBudgetS?: number
  readonly engageIntervalS?: number
  /** 进针参数组的两路真源。没接 = 档案没配，如实跳过切换。 */
  readonly presets?: PresetSkillDeps
}

/**
 * 这次执行属于哪一条驱动链（群跑 / 私聊 / 信号 API）。
 *
 * 拒绝本身是**进程全局**的（一根针一块样品），但它的**清除**按链计——
 * 见 `approach-refusal.ts` 里那段 2026-07-28 致命一(c)。
 */
function chainScope(ctx: SkillContext): string {
  const owner = ctx.owner || ''
  const runId = ctx.rootCallId || ''
  return owner || runId ? `${owner}#${runId}` : ''
}

/**
 * 粗进针跑完之后那次复核的失败文案 —— **只有测到的值**。
 *
 * 它替掉的那张猜测清单（「粗动量程耗尽 / Z 在极限 / 状态过期」）每次失败都印，
 * 而三条一条都没被看过。2026-08-05 三条全是假的，agent 老老实实去查了电机量程。
 */
export function verifyFailureText(v: EngageVerdict): string {
  if (v.aborted) {
    return (
      'post-approach verification 被中止 —— **进针状态未知**,' +
      `不要按「已进针」继续。${engageEvidence(v)}`
    )
  }
  if (v.engaged === null) {
    return (
      'post-approach verification 判不出结果:预算耗尽前始终没有出现 ' +
      `${ENGAGE_AGREE_N} 次一致的电流读数` +
      (v.unreadableN ? `(其中 ${v.unreadableN} 次根本读不到电流/设定点)` : '') +
      `。${engageEvidence(v)}。**这不等于没进针**,也不等于进针了。` +
      '不要扫图;先确认反馈已合上、电流量程合适。'
    )
  }
  return (
    'post-approach verification FAILED:电流**稳定地**没有达到进针判据,' +
    `针尖未进入隧穿,不要扫图。${engageEvidence(v)}。`
  )
}

interface StepNote {
  skill: string
  success: boolean
  [k: string]: unknown
}

class Tip {
  readonly #ctx: SkillContext
  readonly #settleS: number
  readonly #latch: ApproachRefusalLatch
  readonly #presets: PresetSkillDeps
  readonly #budgetS: number
  readonly #intervalS: number
  readonly #steps: StepNote[] = []

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>, d: ApproachTipDeps) {
    this.#ctx = ctx
    const s = params['settle_s']
    this.#settleS = typeof s === 'number' && Number.isFinite(s) ? s : 1.5
    this.#latch = d.latch ?? processApproachRefusalLatch
    this.#budgetS = d.engageBudgetS ?? 20.0
    this.#intervalS = d.engageIntervalS ?? 1.0
    this.#presets = d.presets ?? {}
  }

  get #scope(): string {
    return chainScope(this.#ctx)
  }

  /**
   * 切进针参数组 → 跑 → **无论如何放回去**。
   *
   * 套在最外层而不是只套在 `AutoApproach` 上，是因为**第一相就可能进成**
   * （`TryEngageController` 直接建立隧穿，根本不走粗动）。那一段同样受增益快慢
   * 影响，而它整段都在 `AutoApproach` 之外。
   *
   * 嵌套是免费的：里层看到增益已经是进针组的值，就不写、也不需要放回。
   */
  async run(): Promise<SkillResultLike> {
    const [snapshot, note] = await applyApproachPreset(this.#ctx, this.#presets, 'ApproachTip')
    let res: SkillResultLike
    try {
      res = await this.#approach()
    } finally {
      Object.assign(note, await restoreZctrl(this.#ctx, snapshot, 'ApproachTip'))
    }
    return { ...res, data: { ...(res.data ?? {}), ...note } }
  }

  async #approach(): Promise<SkillResultLike> {
    // ── 第一相：安全 engage（反馈开，不动马达）。顺带认出「已经在隧穿」。 ──
    const eng = await this.#ctx.runSkill('TryEngageController', { settle_s: this.#settleS })
    const engData = (eng.data ?? {}) as Record<string, unknown>
    this.#steps.push({
      skill: 'TryEngageController',
      success: eng.success === true,
      // `?? null` 而不是留 `undefined`：这一条要进 `data.steps`，而 `undefined`
      // 在 JSON 里会**整个键消失**——「没报这个字段」和「报了个空」是两件事。
      engaged: engData['engaged'] ?? null,
      needs_auto_approach: engData['needs_auto_approach'] ?? null,
      // 成功的那一趟 `error` 是空串，不是 null（旧仓 `SkillResult.error` 默认 `""`）
      error: eng.error ?? '',
    })

    if (eng.success !== true) {
      const err = `engage phase failed: ${eng.error ?? 'unknown'}`
      this.#latch.record(err, { source: 'ApproachTip', owner: this.#scope })
      return { success: false, error: err, data: { phase: 'engage', steps: this.#steps } }
    }

    if (engData['engaged'] === true) {
      this.#latch.clear('ApproachTip engaged via Z-controller', { owner: this.#scope })
      return {
        success: true,
        data: {
          engaged: true,
          method: 'engage_controller',
          auto_approach_used: false,
          peak_current_a: engData['peak_current_a'] ?? null,
          setpoint_a: engData['setpoint_a'] ?? null,
          message:
            'Tip already within tunnelling range — engaged via the Z-controller; ' +
            'no coarse approach needed.',
          steps: this.#steps,
        },
      }
    }

    // ── 第二相：反馈够不到隧穿 ⇒ 针尖还远。走电流反馈的粗进针。 ──
    if (engData['needs_auto_approach'] !== true) {
      // **不在一个「也许」上开粗进针。** engage 既没建立隧穿、也没说需要粗进针，
      // 那就是两个判据自相矛盾——停下来，别猜。
      const err =
        'engage did not establish tunnelling and did not flag needs_auto_approach — ' +
        'stopping rather than approaching on a maybe; check the tip/Z state.'
      this.#latch.record(err, { source: 'ApproachTip', owner: this.#scope })
      return {
        success: false,
        error: err,
        data: { engaged: false, auto_approach_used: false, steps: this.#steps },
      }
    }

    // 升级这件事**在新证据上决定了**，它取代任何更早的拒绝——这正是
    // 「再调一次 ApproachTip」成为逃逸闸的出路（而不是「等 TTL 过期」）的原因。
    this.#latch.clear('ApproachTip escalating to AutoApproach', { owner: this.#scope })
    const app = await this.#ctx.runSkill('AutoApproach', {})
    const appData = (app.data ?? {}) as Record<string, unknown>
    this.#steps.push({
      skill: 'AutoApproach',
      success: app.success === true,
      data: appData,
      error: app.error ?? '',
    })
    if (app.success !== true) {
      return {
        success: false,
        error: `auto-approach phase failed: ${app.error ?? 'unknown'}`,
        data: {
          engaged: false,
          method: 'auto_approach',
          auto_approach_used: true,
          steps: this.#steps,
        },
      }
    }

    // ── 最后一道防线：**自己测一次**，不管那个组合技能声称了什么。 ──
    const v = await this.#verify()
    if (v.engaged !== true) {
      return {
        success: false,
        error: verifyFailureText(v),
        data: {
          engaged: false,
          method: 'auto_approach',
          auto_approach_used: true,
          measured_current_a: v.currentA,
          setpoint_a: v.setpointA,
          engagement: engageVerdictToDict(v),
          steps: this.#steps,
        },
      }
    }
    return {
      success: true,
      data: {
        engaged: true,
        method: 'auto_approach',
        auto_approach_used: true,
        measured_current_a: v.currentA,
        setpoint_a: v.setpointA,
        engagement: engageVerdictToDict(v),
        message:
          'Tip was too far to engage by feedback alone — ran the current-feedback ' +
          `AutoApproach; tunnelling verified at |I|=${fmtA(v.currentA)} vs setpoint ` +
          `${fmtA(v.setpointA)} (${v.agreedN} 次一致读数).`,
        steps: this.#steps,
      },
    }
  }

  /** 复核走**只读技能**，不走裸动词——它们各自带着自己的读包判据。 */
  async #verify(): Promise<EngageVerdict> {
    return settleEngagement({
      readPair: async () => {
        const cur = await this.#ctx.runSkill('GetCurrent', {})
        const sp = await this.#ctx.runSkill('GetSetpoint', {})
        return [num(cur, 'current_a'), num(sp, 'setpoint_a')] as const
      },
      now: () => this.#ctx.now() / 1000,
      sleep: (s) => this.#ctx.sleep(s * 1000),
      checkAbort: () => this.#ctx.signal.aborted,
      budgetS: this.#budgetS,
      intervalS: this.#intervalS,
    })
  }
}

function num(r: SkillResultLike, key: string): number | null {
  if (r.success !== true) return null
  const v = (r.data ?? {})[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function makeApproachTip(deps: ApproachTipDeps = {}): Skill {
  return {
    spec: S.ApproachTipSpec,
    execute: (ctx, params) => new Tip(ctx, params, deps).run(),
  }
}

export const ApproachTip: Skill = makeApproachTip()

