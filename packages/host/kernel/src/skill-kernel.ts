/**
 * `SkillKernel.run()` —— **唯一的 choke point**。
 *
 * 后面 400 多个技能全部从这里穿过。每一道闸写错一次，错的就是 400 多次；
 * 而每一道闸**漏掉**一次，漏的也是 400 多次。所以这个文件比别处啰嗦：
 * 每一段都写清它挡的是什么、以及那件事在真机上长什么样。
 *
 * 阶段编号与 PLAN §8.1 对齐（K0–K18），顺序**就是**判据：
 *
 * ```
 * K0 覆盖 → K1 SI 解析 → K2 中止闩 → K3 样品闸 → K5 快照+计时
 *   → K6 参数校验 → K7 荒谬/包络/模式/硬闸 → K8 前置条件 → K9 锁
 *   → K11 执行 → K12 写回缓存 → K13 组文本 → K15 状态增量 → K18 异常
 * ```
 *
 * **K5 在闸门之前**：被拒绝的调用也要有快照与耗时，否则「为什么被拒」事后无从复原。
 */
import { argsHash } from './args-hash.js'
import type { HardwareState } from './hardware-state.js'
import { checkStatePreconditions, type ComputedCheck } from './preconditions.js'
import { SIParseError, parseQuantity } from './si.js'
import { isStrictParam, siParams } from './tool-schema.js'

// ── 契约类型 ────────────────────────────────────────────────────────────────

export interface ParameterSpec {
  readonly name: string
  readonly type: string
  readonly description?: string | undefined
  readonly unit?: string | null | undefined
  readonly required?: boolean | undefined
  readonly minValue?: number | null | undefined
  readonly maxValue?: number | null | undefined
  readonly allowedValues?: readonly (string | number | boolean)[] | undefined
  readonly default?: unknown
}

export interface SkillSpec {
  readonly name: string
  readonly description: string
  readonly parameters: readonly ParameterSpec[]
  readonly preconditions?: readonly string[] | undefined
  readonly capabilities?: readonly string[] | undefined
  readonly tags?: readonly string[] | undefined
  readonly category?: string | undefined
  readonly safetyLevel?: 'AUTO' | 'CONFIRM' | 'DANGEROUS' | undefined
}

/** 技能结果里模型不该看到、但记录要留的键。 */
export const AUDIT_ONLY_KEYS: readonly string[] = ['safe_mode_raw']

/** 工具返回给模型的文本上限（字符）。超了落盘并留引用。 */
export const TOOL_RETURN_CAP = 2000

export type OutcomeKind = 'ok' | 'failed' | 'refused' | 'aborted' | 'busy' | 'rolled_back'

export type RefusalCode =
  | 'si_parse'
  | 'abort_latched'
  | 'sample_gate'
  | 'invalid_params'
  | 'safety'
  | 'precondition_failed'
  | 'precondition_crashed'
  | 'busy'

export interface SkillOutcome {
  readonly kind: OutcomeKind
  readonly code?: RefusalCode | undefined
  /** 聚合用的签名：**同一类失败给同一个签名**，好让重复失败被折叠而不是刷屏。 */
  readonly signature: string
  /** 给模型看的文本（已去掉审计专用键、已截断）。 */
  readonly text: string
  /** 超长时落盘的引用。 */
  readonly textRef?: string | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
  /** 这次调用让状态缓存发生的变化（K15，进 RunLedger）。 */
  readonly stateDelta?: Readonly<Record<string, unknown>> | undefined
  readonly elapsedMs: number
  readonly argsHash: string
  /** 结束本轮（中止闩之类）。 */
  readonly concludeTurn?: boolean | undefined
}

/** 技能执行时拿到的上下文。**`markers` 必填**——见下面构造期的检查。 */
/**
 * 一次仪器调用的记录——**结构化接口，不 import 仪器包**。
 *
 * 内核零 dsh 依赖，而 `dsh-spm-instrument` 是个 Cordis Service。所以这里只声明
 * 内核与技能真正读到的那几个字段，接线时由宿主把真的 `CallRecord` 喂进来。
 *
 * `values` 对应 Python 那边三段信封 `(error_string, raw_bytes, body)` 的 **body**。
 */
export interface SkillCallRecord {
  readonly method: string
  readonly args: readonly unknown[]
  readonly values?: readonly unknown[] | undefined
  readonly error?: string | undefined
}

/** 技能发一次仪器调用。对应旧仓的 `context.safe_call`。 */
export type SafeCall = (method: string, ...args: unknown[]) => Promise<SkillCallRecord>

export interface SkillContext {
  readonly signal: AbortSignal
  /**
   * 发一次仪器调用。**永不抛**——失败表达成 `record.error`，
   * 与旧仓 `safe_call` 同一约定（抛出去会绕过 `nanonis_calls` 的记账）。
   */
  readonly safeCall: SafeCall
  readonly state: () => HardwareState
  readonly refreshState: () => Promise<HardwareState>
  readonly markers: { emit: (kind: string, data?: Record<string, unknown>) => void }
  readonly depth: number
  readonly owner: string
  readonly rootCallId: string
  readonly approvalSource: 'llm' | 'human' | 'auto'
}

export interface Skill {
  readonly spec: SkillSpec
  execute(ctx: SkillContext, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike>
  rollback?(ctx: SkillContext): Promise<void>
  validateParams?(params: Readonly<Record<string, unknown>>): string[]
}

export interface SkillResultLike {
  readonly success: boolean
  readonly error?: string | undefined
  readonly summary?: string | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
}

// ── K1：哪些参数强制 SI 前缀 ────────────────────────────────────────────────

// `isStrictParam` / `siParams` **住在 `tool-schema.ts`**，不在这里。
//
// 2.10 时这里有过一份自己的实现，而 2.12 把 schema 生成移植过来之后，两份就是两个
// 答案了——这正是 2026-08-10 那次事故的形状（广告说「前缀不可省略」，解析却放行裸
// 数字，16 个米制参数受影响）。**一个技能的严格性只能有一个来源**：模型读到的描述
// 与这里的解析必须由同一个表达式算出。所以内核向 schema 侧要，而不是各算各的。

// ── 内核 ────────────────────────────────────────────────────────────────────

/** 一次调用要问的外部世界。全部注入 ⇒ 内核本身零 I/O、可完全脚本化测试。 */
export interface KernelDeps {
  /** 管理员覆盖后的有效声明（K0）。**建工具与执行各调一次同一个函数**。 */
  readonly effectiveSpec?: ((spec: SkillSpec) => SkillSpec) | undefined
  /** 中止闩上了吗（K2）。 */
  readonly abortLatched?: (() => boolean) | undefined
  /** 样品闸（K3）：返回拒绝文案或 `null`。 */
  readonly sampleGate?: ((spec: SkillSpec) => string | null) | undefined
  /** 安全闸（K7）：返回拒绝文案或 `null`。 */
  readonly safetyGate?:
    | ((spec: SkillSpec, params: Readonly<Record<string, unknown>>) => string | null)
    | undefined
  /** 状态快照（K5/K8）。 */
  readonly snapshot: () => HardwareState
  /** 刷新状态（K8：前置不满足时**先刷新再判**）。 */
  readonly refreshState?: (() => Promise<HardwareState>) | undefined
  /** 计算型前置（K8）。 */
  readonly computedChecks?: Readonly<Record<string, ComputedCheck>> | undefined
  /** 成功后把结果写回缓存（K12）。 */
  readonly applyPatch?: ((fields: Readonly<Record<string, unknown>>) => void) | undefined
  /** 重入锁（K9）。返回释放函数；拿不到就抛 `BusyError`。 */
  readonly acquireLock?:
    | ((skill: string, rootCallId: string) => Promise<() => void>)
    | undefined
  /**
   * K16 记录一次调用。**每一个结局都会到这里，包括被拒的**。
   *
   * 注入而不是内建：内核仍然零 I/O，而记录的去处（SQLite / 内存 / 什么都不做）
   * 是宿主的事。抛出去也没关系——`finish` 吃掉它。
   */
  readonly record?: ((rec: KernelRecord) => void) | undefined
  /** 技能发仪器调用的出口（K11）。缺席时技能会拿到一条带 error 的记录。 */
  readonly safeCall?: SafeCall | undefined
  /** 超长文本落盘（K13），返回引用。 */
  readonly offload?: ((skill: string, full: string) => string) | undefined
  readonly clock?: (() => number) | undefined
}

/** 交给 `KernelDeps.record` 的一条。 */
export interface KernelRecord {
  readonly spec: SkillSpec
  /** K1 解析成功后是**解析过的**参数；解析失败时是原样入参。 */
  readonly params: Readonly<Record<string, unknown>>
  readonly outcome: SkillOutcome
  readonly approvalSource: 'llm' | 'human' | 'auto'
  readonly owner?: string | undefined
  readonly rootCallId?: string | undefined
  readonly depth: number
}

export class BusyError extends Error {
  override readonly name = 'BusyError'
}

export class AbortRequestedError extends Error {
  override readonly name = 'AbortRequestedError'
}

export interface RunOptions {
  readonly depth?: number | undefined
  readonly owner?: string | undefined
  readonly rootCallId?: string | undefined
  readonly approvalSource?: 'llm' | 'human' | 'auto' | undefined
  readonly signal?: AbortSignal | undefined
  readonly markers?: SkillContext['markers'] | undefined
}

export class SkillKernel {
  constructor(private readonly deps: KernelDeps) {}

  private now(): number {
    return (this.deps.clock ?? Date.now)()
  }

  /**
   * 跑一个技能。**永不抛**——所有失败都表达成 `SkillOutcome`。
   *
   * 抛出去的失败会绕过记录（K16）、绕过写回（K12）、绕过锁的释放。
   * 一条不进记录的失败，事后等于没发生过。
   */
  async run(
    skill: Skill,
    rawParams: Readonly<Record<string, unknown>>,
    opts: RunOptions = {},
  ): Promise<SkillOutcome> {
    const started = this.now()
    const hash = argsHash(rawParams)
    const depth = opts.depth ?? 0
    // **`markers` 缺席就是构造期错误**，不是运行期降级：没有 markers 的技能跑完
    // 什么都不留下，而「跑过但没留痕」比「没跑」更难查（换区不翻代那次事故）。
    const markers = opts.markers ?? { emit: (): void => {} }
    // ── K0 管理员覆盖：**建工具与执行各调一次同一个函数** ──
    const spec = (this.deps.effectiveSpec ?? ((s: SkillSpec) => s))(skill.spec)
    // 记录用的参数：K1 解析成功后换成解析过的（记 `'100p'` 还是 `1e-10`，
    // 决定了事后能不能按数值查——schema 那四个生成列读的就是这里）
    let recorded: Readonly<Record<string, unknown>> = rawParams

    // K16 记录**挂在这个漏斗上**，不在各个 return 点。
    // 六个结局分散在十几个 return 里，靠人记得「这里也要记一笔」＝ 迟早漏。
    // 旧仓漏的正是被闸门拒掉的那一类：那两道闸原来在 recorder 定义**之上**、
    // 直接 return，于是一次被拒的调用哪个记录库都没进过——而记录层存在的意义
    // 就是回答「为什么什么都没发生」。
    const finish = (o: Omit<SkillOutcome, 'elapsedMs' | 'argsHash'>): SkillOutcome => {
      const outcome: SkillOutcome = { ...o, elapsedMs: this.now() - started, argsHash: hash }
      try {
        this.deps.record?.({
          spec,
          params: recorded,
          outcome,
          approvalSource: opts.approvalSource ?? 'llm',
          owner: opts.owner,
          rootCallId: opts.rootCallId,
          depth,
        })
      } catch {
        // 记录永不打断技能（旧仓每一处都写着 logging must never break the skill）
      }
      return outcome
    }

    // ── K1 SI 解析 ──
    let params: Record<string, unknown>
    try {
      params = this.parseSi(spec, rawParams)
      recorded = params
    } catch (e) {
      const msg = e instanceof SIParseError ? e.message : String(e)
      return finish({
        kind: 'refused',
        code: 'si_parse',
        signature: `si_parse:${spec.name}`,
        // 文案前缀逐字保留：既有会话与测试都按它读
        text: `[${spec.name}] precondition_failed: ${msg}`,
      })
    }

    // ── K2 中止闩 ──
    if (this.deps.abortLatched?.() === true) {
      return finish({
        kind: 'refused',
        code: 'abort_latched',
        signature: 'abort_latched',
        text: `[${spec.name}] 中止已闩上——只有退针与停扫还能发。要继续请先解闩。`,
        concludeTurn: true,
      })
    }

    // ── K3 样品闸（**depth 0 才判**，子步继承上层的准入） ──
    if (depth === 0) {
      const gate = this.deps.sampleGate?.(spec) ?? null
      if (gate !== null) {
        return finish({ kind: 'refused', code: 'sample_gate', signature: `sample_gate:${spec.name}`, text: gate })
      }
    }

    // ── K5 快照 + 计时（**在闸门之前**：被拒绝的调用也要有快照） ──
    const before = this.deps.snapshot()

    // ── K6 参数校验 ──
    const invalid = [...this.validateParams(spec, params), ...(skill.validateParams?.(params) ?? [])]
    if (invalid.length > 0) {
      return finish({
        kind: 'refused',
        code: 'invalid_params',
        signature: `invalid_params:${spec.name}`,
        text: `[${spec.name}] invalid_params: ${invalid.join('；')}`,
      })
    }

    // ── K7 荒谬 → 包络 → 模式 → 硬闸（顺序在 stmSafety 里，这里只问结论） ──
    const refusal = this.deps.safetyGate?.(spec, params) ?? null
    if (refusal !== null) {
      return finish({ kind: 'refused', code: 'safety', signature: `safety:${spec.name}`, text: refusal })
    }

    // ── K8 前置条件：**不满足时先刷新再判**，两个入口都做 ──
    const pre = await this.checkPreconditions(spec, before)
    if (pre.kind === 'crashed') {
      // 前置检查自己抛了 ⇒ **fail-closed**：判据坏了不等于条件满足
      return finish({
        kind: 'refused',
        code: 'precondition_crashed',
        signature: `precondition_crashed:${spec.name}`,
        text: `[${spec.name}] precondition_crashed: 前置条件检查本身出错（${pre.error}）——按 fail-closed 拒绝。`,
      })
    }
    if (pre.violations.length > 0) {
      return finish({
        kind: 'refused',
        code: 'precondition_failed',
        signature: `precondition_failed:${spec.name}`,
        text: `[${spec.name}] precondition_failed: ${pre.violations.join('；')}`,
      })
    }

    // ── K9 重入锁（超时是 `busy`，**不回滚**：没跑过的东西没有可回滚的） ──
    let release: (() => void) | null = null
    if (this.deps.acquireLock !== undefined) {
      try {
        release = await this.deps.acquireLock(spec.name, opts.rootCallId ?? hash)
      } catch (e) {
        return finish({
          kind: 'busy',
          code: 'busy',
          signature: `busy:${spec.name}`,
          text: `[${spec.name}] busy: ${(e as Error).message}`,
        })
      }
    }

    const ctx: SkillContext = {
      signal: opts.signal ?? new AbortController().signal,
      state: () => this.deps.snapshot(),
      // 没接仪器时给一条**带 error 的记录**，而不是抛：技能里所有分支都按
      // `record.error` 判，抛出去会绕过它们、也绕过 `nanonis_calls` 的记账。
      safeCall:
        this.deps.safeCall ??
        ((method, ...args): Promise<SkillCallRecord> =>
          Promise.resolve({ method, args, error: 'no_instrument: 这个内核没有接仪器' })),
      refreshState: this.deps.refreshState ?? (async () => this.deps.snapshot()),
      markers,
      depth,
      owner: opts.owner ?? 'llm',
      rootCallId: opts.rootCallId ?? hash,
      approvalSource: opts.approvalSource ?? 'llm',
    }

    try {
      // ── K11 执行 ──
      const result = await skill.execute(ctx, params)

      // ── K12 写回缓存：成功才写 `data`，**但 `_verified_state` 总是写** ──
      if (result.success && result.data !== undefined) this.deps.applyPatch?.(result.data)
      const verified = result.data?.['_verified_state']
      if (verified !== null && typeof verified === 'object') {
        this.deps.applyPatch?.(verified as Record<string, unknown>)
      }
      // **成败都记**——被拒绝、失败的调用同样要留痕
      markers.emit(result.success ? 'skill_ok' : 'skill_failed', { skill: spec.name })

      // ── K13 组文本 ──
      const { text, textRef } = this.composeText(spec.name, result)

      // ── K15 状态增量 ──
      const after = this.deps.snapshot()
      const delta = diffState(before, after)

      return finish({
        kind: result.success ? 'ok' : 'failed',
        signature: result.success ? `ok:${spec.name}` : `failed:${spec.name}:${result.error ?? ''}`,
        text,
        textRef,
        data: result.data,
        stateDelta: delta,
      })
    } catch (e) {
      // ── K18 异常 ──
      markers.emit('skill_crashed', { skill: spec.name, error: (e as Error).message })
      // **中止与占用不回滚**：中止是人喊停，回滚会把仪器又动一遍；
      // 占用意味着**我们根本没跑**，没有可回滚的东西。
      if (e instanceof AbortRequestedError) {
        return finish({
          kind: 'aborted',
          signature: `aborted:${spec.name}`,
          text: `[${spec.name}] aborted: ${e.message}`,
        })
      }
      if (e instanceof BusyError) {
        return finish({ kind: 'busy', code: 'busy', signature: `busy:${spec.name}`, text: `[${spec.name}] busy: ${e.message}` })
      }
      let rolledBack = false
      if (skill.rollback !== undefined) {
        try {
          await skill.rollback(ctx)
          rolledBack = true
        } catch (re) {
          markers.emit('rollback_failed', { skill: spec.name, error: (re as Error).message })
        }
      }
      return finish({
        kind: rolledBack ? 'rolled_back' : 'failed',
        signature: `crashed:${spec.name}`,
        text: `[${spec.name}] ${rolledBack ? 'rolled_back' : 'failed'}: ${(e as Error).message}`,
      })
    } finally {
      release?.()
    }
  }

  /** K1：有量纲参数走 SI 解析，strict 的拒绝裸数字。 */
  private parseSi(spec: SkillSpec, raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...raw }
    // 名单与 strict 都来自 schema 侧的同一个表达式（见上面那段注释）
    for (const [name, strict] of siParams(spec)) {
      // 没传、或显式传了 null 的，跳过——缺省值由 K6 的必填检查负责，
      // 拿 null 去解析只会把「你没填」报成「你写错了」
      const v = out[name]
      if (!(name in out) || v === null || v === undefined) continue
      if (typeof v === 'number' && !strict) continue // 宽松档接受裸数字
      out[name] = parseQuantity(v, { strict, what: name })
    }
    return out
  }

  /** K6：必填、枚举、范围。**越界要附教学文案**，不是一句冷冰冰的 out of range。 */
  private validateParams(spec: SkillSpec, params: Readonly<Record<string, unknown>>): string[] {
    const out: string[] = []
    for (const p of spec.parameters) {
      const has = p.name in params && params[p.name] !== undefined && params[p.name] !== null
      // **省略 `required` 就是必填**：Python 的 `ParameterSpec.required: bool = True`
      // 是 dataclass 缺省，schema 侧与校验侧读到的都是 True。这里原来写 `=== true`，
      // 于是同一个省略了 required 的参数会被**广告成必填、却不强制** —— 模型漏传时
      // 一路走到技能里才炸，而错误信息里不会有「你少了一个参数」这句话。
      if ((p.required ?? true) && !has) {
        out.push(`缺少必填参数 '${p.name}'`)
        continue
      }
      if (!has) continue
      const v = params[p.name]
      if (p.allowedValues !== undefined && p.allowedValues.length > 0) {
        if (!p.allowedValues.includes(v as string | number | boolean)) {
          out.push(`'${p.name}' 只能是 ${p.allowedValues.map((x) => JSON.stringify(x)).join(' / ')}，收到 ${JSON.stringify(v)}`)
          continue
        }
      }
      if (typeof v === 'number') {
        if (p.minValue !== null && p.minValue !== undefined && v < p.minValue) {
          out.push(explainValidation(p, v, 'min'))
        } else if (p.maxValue !== null && p.maxValue !== undefined && v > p.maxValue) {
          out.push(explainValidation(p, v, 'max'))
        }
      }
    }
    return out
  }

  /**
   * K8：前置条件。**不满足时先 `refreshState()` 再判一次**。
   *
   * 缓存最多 1 秒旧，而一个刚刚成功的写技能会在**下一步**的前置里被自己的陈值挡住
   * ——2026-08-10 真机上 `ZControllerOnOff(True)` 成功且回读 verified，
   * 紧接着 `MoveToXY` 报 `z_controller_on is False`。1.8 的 carry-forward 修了缓存
   * 那一半，**这里修的是判定那一半，两半都要**。
   */
  private async checkPreconditions(
    spec: SkillSpec,
    state: HardwareState,
  ): Promise<{ kind: 'ok'; violations: string[] } | { kind: 'crashed'; error: string }> {
    const names = spec.preconditions ?? []
    if (names.length === 0) return { kind: 'ok', violations: [] }
    try {
      let v = checkStatePreconditions(names, state, this.deps.computedChecks ?? {})
      if (v.length > 0 && this.deps.refreshState !== undefined) {
        const fresh = await this.deps.refreshState()
        v = checkStatePreconditions(names, fresh, this.deps.computedChecks ?? {})
      }
      return { kind: 'ok', violations: v }
    } catch (e) {
      return { kind: 'crashed', error: (e as Error).message }
    }
  }

  /**
   * K13：组给模型看的文本。
   *
   * **失败带全部 `data`（去掉审计专用键），成功只带 `detail`。** 两条路的取舍不同：
   * 诊断只在失败时要紧而失败量有界；成功路径上无差别附加整个 `data` 会让每一次工具
   * 返回都变长。
   *
   * 而原来的兜底**惩罚做得更用心的一方**：「没设 summary 的技能，把整个 data 送过去」
   * ⇒ 谁认真写了一句人话摘要，谁就把自己的诊断数据静音了。2026-08-10 真机上
   * `AutoTilt` 跑完，模型收到的整条消息只有 `AutoTilt: rolled_back(diverged)`，
   * 而逐轮的斜率向量、残余 Z、是否限幅全在 `data` 里**没穿过来**——
   * 整夜的排查因此在找一个「发散」机制，而现象只支持「降得不够快」。
   */
  private composeText(name: string, r: SkillResultLike): { text: string; textRef?: string } {
    const head = r.summary ?? (r.success ? `${name}: ok` : `[${name}] failed: ${r.error ?? 'unknown'}`)
    let full = head + explanationSuffix(r.data, r.success)
    let textRef: string | undefined
    if (full.length > TOOL_RETURN_CAP) {
      textRef = this.deps.offload?.(name, full)
      full =
        full.slice(0, TOOL_RETURN_CAP) +
        (textRef !== undefined ? `\n…（全文已落盘：${textRef}）` : '\n…（已截断）')
    }
    return textRef === undefined ? { text: full } : { text: full, textRef }
  }
}

/** 去掉只给记录看的键。 */
export function stripAuditOnly(
  data: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  if (!AUDIT_ONLY_KEYS.some((k) => k in data)) return { ...data }
  return Object.fromEntries(Object.entries(data).filter(([k]) => !AUDIT_ONLY_KEYS.includes(k)))
}

/** 结论之外，把**支撑它的东西**也带过工具边界。 */
export function explanationSuffix(
  data: Readonly<Record<string, unknown>> | undefined,
  success: boolean,
): string {
  if (data === undefined || Object.keys(data).length === 0) return ''
  if (!success) return '\n' + JSON.stringify(stripAuditOnly(data))
  const detail = data['detail']
  return typeof detail === 'string' && detail.trim() !== '' ? '\ndetail: ' + detail : ''
}

/** 越界时的**教学文案**：说清范围、给一个能用的写法，而不是让模型猜。 */
export function explainValidation(p: ParameterSpec, value: number, which: 'min' | 'max'): string {
  const bound = which === 'min' ? p.minValue : p.maxValue
  const unit = p.unit ?? ''
  const strict = isStrictParam(p)
  const hint = strict
    ? `这个参数要求**带 SI 前缀的字符串**（如 '100p'、'1n'）——不要写裸数字，也不要用 '1e-10' 这种指数写法。`
    : ''
  return (
    `'${p.name}' = ${value}${unit === '' ? '' : ' ' + unit} ` +
    `${which === 'min' ? '小于下限' : '超过上限'} ${bound}${unit === '' ? '' : ' ' + unit}。${hint}`
  )
}

/** K15：两份快照之间**非时变字段**的差。时间戳与 `stale` 不算变化。 */
export function diffState(a: HardwareState, b: HardwareState): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(a) as (keyof HardwareState)[]) {
    if (k === 'timestamp' || k === 'stale') continue
    const av = a[k]
    const bv = b[k]
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length === bv.length && av.every((x, i) => x === bv[i])) continue
    } else if (av === bv) continue
    out[k] = bv
  }
  return out
}
