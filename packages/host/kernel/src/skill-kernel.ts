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
import { SIParseError, needsStrictPrefix, parseQuantity } from './si.js'

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
export interface SkillContext {
  readonly signal: AbortSignal
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

/**
 * 一个参数要不要**强制**带 SI 前缀。
 *
 * 判据两条，或的关系：
 * 1. 该参数的有效上下界整个远小于 1（量程小到裸数字必然是量级错）——`needsStrictPrefix`
 * 2. 单位是 `m` 或 `A`——**长度与电流是 STM 上最容易掉量级的两个量纲**
 *
 * 这是**唯一**算 strict 的地方：工具 schema 的生成与这里的解析共用它，
 * 否则「schema 说可以裸写、解析却拒绝」这种自相矛盾会直接变成模型的死循环。
 */
export function isStrictParam(p: ParameterSpec): boolean {
  const unit = (p.unit ?? '').toLowerCase()
  if (unit === 'm' || unit === 'a') return true
  return needsStrictPrefix(p.minValue ?? null, p.maxValue ?? null)
}

/** 有量纲参数的名单（要走 SI 解析的那些）。 */
export function siParams(spec: SkillSpec): ParameterSpec[] {
  return spec.parameters.filter((p) => (p.unit ?? '') !== '')
}

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
  /** 超长文本落盘（K13），返回引用。 */
  readonly offload?: ((skill: string, full: string) => string) | undefined
  readonly clock?: (() => number) | undefined
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
    const finish = (o: Omit<SkillOutcome, 'elapsedMs' | 'argsHash'>): SkillOutcome => ({
      ...o,
      elapsedMs: this.now() - started,
      argsHash: hash,
    })

    // ── K0 管理员覆盖：**建工具与执行各调一次同一个函数** ──
    const spec = (this.deps.effectiveSpec ?? ((s: SkillSpec) => s))(skill.spec)

    // ── K1 SI 解析 ──
    let params: Record<string, unknown>
    try {
      params = this.parseSi(spec, rawParams)
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
    for (const p of siParams(spec)) {
      if (!(p.name in out)) continue
      const v = out[p.name]
      if (typeof v === 'number' && !isStrictParam(p)) continue // 宽松档接受裸数字
      out[p.name] = parseQuantity(v, { strict: isStrictParam(p), what: p.name })
    }
    return out
  }

  /** K6：必填、枚举、范围。**越界要附教学文案**，不是一句冷冰冰的 out of range。 */
  private validateParams(spec: SkillSpec, params: Readonly<Record<string, unknown>>): string[] {
    const out: string[] = []
    for (const p of spec.parameters) {
      const has = p.name in params && params[p.name] !== undefined && params[p.name] !== null
      if (p.required === true && !has) {
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
