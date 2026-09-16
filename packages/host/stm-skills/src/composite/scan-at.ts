/**
 * `ScanAt` —— 扫图的**意图级**入口：说「扫哪、多大」，参数由策略层定。
 *
 * 在它之前，模型扫一张图要自己填 `width_m` / `height_m` / `line_time_s`，而「这个尺度
 * 下该扫多快、取多少像素」不是它的知识 —— 那是用户按仪器、按样品积累出来的东西。
 * 结果就是模型每次现编一个数字，编得对不对没人知道。
 *
 * ScanAt 把这件事倒过来：**「不填」是默认路径**，策略层（内核的
 * {@link resolveScan}）按用户的按-尺度参数表把参数补齐。模型只在用户**逐字点名过**
 * 某个值时才传它，而每个传进来的值都会带上来源记录显示给用户 —— 「这个 `line_time`
 * 标着『用户显式』，但我没说过」是一眼能看出来的。
 *
 * ## 这一层只发调用与拼报文
 *
 * 判据全在内核：`resolveScan` 是纯函数（零 I/O，判据全是值），
 * `waitBudgetS` 是那条等待预算公式的**单一真源**。这里剩下的是三件事 ——
 * 排计划、把子技能报上来的东西提成 partial、以及**判结局**。
 *
 * ## 「每一步都成功」不等于「扫完了」
 *
 * `WaitScanComplete` 在**每一种**扫描结束方式上都报 success —— 超时、扫完、以及中途
 * 被停下。不在这里拦住，一次被截断的扫描会以「扫完了」的面目出现在结果里。
 *
 * 而两种截断要**分开报**，因为用户要做的事不同：
 *
 * | | 是什么 | 下一步 |
 * |---|---|---|
 * | `wait_timed_out` | 参数估短了 | 调大 `wait_timeout_s` 再来 |
 * | `wait_stopped_early` | 有人 / 有东西把它停了 | 去查是谁停的（用户按了 Stop / Nanonis 自停 / 安全停机） |
 *
 * 合成一句会把人送去调一个根本没问题的参数。
 *
 * ## 超时之后必须停扫，而中途停止**刻意不停**
 *
 * 一个还在跑的扫描会挡住之后的每一步（改帧、移动、换参数全要求 `scan_not_running`），
 * 留着它等于让下一个动作莫名其妙失败。
 *
 * ⚠️ `wait_stopped_early` 那条路上扫描**已经停了**（判据就是 `Scan_StatusGet` 读到 0
 * 之后才去数行数的）。再补一发 `Scan_Action(1, 0)` 是对着一台已停的扫描发一条无意义的
 * 硬件命令 ——「失败了就顺手停一下」看着对称，但它把一个只读的结论变成了一次写操作。
 */
import {
  GraphExecutor,
  abortFacts,
  progressToDict,
  resolveScan,
  summaryLines,
  waitBudgetS,
  type CompositeStep,
  type ResolveScanOptions,
  type ResolvedScan,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
  type TierLookup,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { runSubSkill } from './run-sub.js'

/** 整帧扫描的等待下限（秒）。**只有这一项是各家可以不同的**，公式在内核。 */
export const SCAN_WAIT_FLOOR_S = 300.0

/**
 * 参数名 → resolver 的 explicit 键。
 *
 * PI 增益**刻意不在列**：「用 P=1e-11 扫」不是人话。要调就去档位表里调，
 * 或者直接用 `SetZCtrlGain`。
 */
const EXPLICIT_KEYS = ['bias_v', 'setpoint_a', 'line_time_s', 'pixels', 'angle_deg', 'channels'] as const

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export interface ScanAtDeps {
  /** 档位表。不接 = 出厂表（内核的 `FACTORY_LOOKUP`）。 */
  readonly tiers?: TierLookup
  /** 实验默认参数偏好。不接 = 没设过。 */
  readonly prefs?: Readonly<Record<string, unknown>>
  /** 针尖横向速度上限（m/s）。不接 = 内核的兜底 2 µm/s。 */
  readonly vTipMaxMS?: number
}

class Scan {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  readonly #deps: ScanAtDeps
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>, deps: ScanAtDeps) {
    this.#ctx = ctx
    this.#params = params
    this.#deps = deps
  }

  #resolve(): ResolvedScan {
    const explicit: Record<string, unknown> = {}
    for (const key of EXPLICIT_KEYS) {
      const v = this.#params[key]
      if (v !== undefined && v !== null) explicit[key] = v
    }
    // 三个可选口按**没接就不放进去**装配（`exactOptionalPropertyTypes`）：
    // 「宿主没接档位表」与「宿主接了个 undefined」在类型上是两件事，
    // 而内核那边靠 `?? 默认值` 分辨它们。
    const opts: Mutable<ResolveScanOptions> = {}
    if (this.#deps.tiers !== undefined) opts.tiers = this.#deps.tiers
    if (this.#deps.prefs !== undefined) opts.prefs = this.#deps.prefs
    if (this.#deps.vTipMaxMS !== undefined) opts.vTipMaxMS = this.#deps.vTipMaxMS
    return resolveScan(
      {
        centerXM: this.#params['center_x_m'],
        centerYM: this.#params['center_y_m'],
        sizeM: this.#params['size_m'],
        purpose: this.#params['purpose'],
        explicit,
      },
      opts,
    )
  }

  /**
   * 完成等待上限。
   *
   * **显式值是下限，不是上限**（取 `max`）。
   *
   * 从前这里是「给了就用给的」，后果 2026-08-23 在真机上出现：`PokeConditionTip` 的
   * 簇图步把流程表里的常数 300 s 无条件传了进来（它那一路算不出帧时），而真机当时是
   * 512 px 的帧 ⇒ **扎针本体已经做完**，却因为等待超时把整步判成 abort。上游那段注释
   * 写的是「算不出来就由 ScanAt 自己按解析出来的几何去估」—— 而传了值就永远估不成，
   * 注释描述的是一个代码不具备的行为。
   *
   * 为什么取 `max` 而不是「算得出就忽略显式值」：`ForgeAuTip` 把表值覆写成
   * `forge_scan_timeout_s = 1300`，那条路上「忽略显式值」会把预算**缩短**。取 max 两个
   * 方向都安全：预算永远不小于「调用方的意图」与「这一帧物理上要多久」中的大者。
   *
   * 2026-08-23 现场定的调子：**时间不是问题** —— 自主跑一整夜是可接受的，把一根好针尖
   * 因为等待预算而判失败不是。等待上限只该防「永远不回来」，不该防「比表里那个数慢」。
   */
  #waitTimeoutS(estimatedS: number): number {
    const derived = waitBudgetS(estimatedS, SCAN_WAIT_FLOOR_S)
    const explicit = this.#params['wait_timeout_s']
    if (explicit === undefined || explicit === null) return derived
    const v = typeof explicit === 'number' ? explicit : Number(explicit)
    if (!Number.isFinite(v)) return derived
    return Math.max(v, derived)
  }

  #plan(r: ResolvedScan): CompositeStep[] {
    const steps: CompositeStep[] = []
    // 1. bias 排在最前：偏压变了，后面的 setpoint / 反馈才在正确的工作点上。
    //    `SetBias` 刻意不要求 `z_controller_on`（STS 常需要关反馈改 bias），
    //    这里不改那个既有语义。
    if (r.setBias !== null) {
      steps.push({ stepId: 'set_bias', skillName: 'SetBias', params: { ...r.setBias }, optional: false, tags: ['setup'] })
    }
    if (r.setSetpoint !== null) {
      steps.push({ stepId: 'set_setpoint', skillName: 'SetSetpoint', params: { ...r.setSetpoint }, optional: false, tags: ['setup'] })
    }
    // 3. Z 反馈 PI —— 档位表里配过才有
    if (r.setZctrlGain !== null) {
      steps.push({ stepId: 'set_gain', skillName: 'SetZCtrlGain', params: { ...r.setZctrlGain }, optional: false, tags: ['setup'] })
    }
    // 4. 帧几何 + 通道 + 速度（`ConfigureScan` 自己会由 line_time 推导速度）
    steps.push({ stepId: 'configure', skillName: 'ConfigureScan', params: { ...r.configureScan }, optional: false, tags: ['setup'] })
    // 5. 分辨率 —— **必须排在 ConfigureScan 之后**：`ConfigureScan` 内部调
    //    `Scan_BufferSet(channels, 0, 0)`，0/0 的语义（保持还是重置）尚未在真机上
    //    证实。排在后面，无论哪种语义结果都正确。
    steps.push({ stepId: 'set_buffer', skillName: 'SetScanBuffer', params: { ...r.setScanBuffer }, optional: false, tags: ['setup'] })
    steps.push({ stepId: 'start_scan', skillName: 'StartScan', params: {}, optional: false, tags: ['scan'] })
    steps.push({
      stepId: 'wait_scan',
      skillName: 'WaitScanComplete',
      params: { timeout_ms: Math.trunc(this.#waitTimeoutS(r.estimatedScanS) * 1000) },
      optional: false,
      checkpointAfter: true,
      tags: ['wait'],
    })
    return steps
  }

  #onStepResult(step: CompositeStep, res: StepResult): void {
    const data = (res.data ?? {}) as Record<string, unknown>
    if (step.stepId === 'wait_scan') {
      this.#ex.setPartial('wait_timed_out', data['timed_out'] === true)
      this.#ex.setPartial('wait_stopped_early', data['stopped_early'] === true)
      this.#ex.setPartial('scan_lines_done', data['lines_done'] ?? null)
      this.#ex.setPartial('scan_lines_total', data['lines_total'] ?? null)
      // 超时报文要印的那几样证据，**无条件**提上来：一个只在需要它的那条路上才算出来
      // 的数，正好在有人要它的时候是缺的。
      for (const key of ['budget_s', 'elapsed_s', 'extensions', 'lines_done', 'lines_total']) {
        if (data[key] !== undefined && data[key] !== null) this.#ex.setPartial(key, data[key])
      }
    } else if (step.stepId === 'set_buffer') {
      this.#ex.setPartial('pixels', data['pixels'] ?? null)
      this.#ex.setPartial('lines', data['lines'] ?? null)
      this.#ex.setPartial('resolution_verified', data['verified'] === true)
    } else if (step.stepId === 'configure') {
      this.#ex.setPartial('angle_deg', data['angle_deg'] ?? null)
      this.#ex.setPartial('linear_speed_m_s', data['linear_speed_m_s'] ?? null)
    }
  }

  async run(): Promise<SkillResultLike> {
    // 先解析一次，把 trace 与档位记下来 —— 无论后面成功还是失败，用户都要能看到
    // 「这次打算用什么参数、每个数字哪来的」。**失败时尤其需要。**
    let r: ResolvedScan
    try {
      r = this.#resolve()
    } catch (exc) {
      return { success: false, error: exc instanceof Error ? exc.message : String(exc) }
    }
    const snapshot: Record<string, unknown> = {
      tier_name: r.tierName,
      center_x_m: r.configureScan['center_x_m'],
      center_y_m: r.configureScan['center_y_m'],
      size_m: r.configureScan['width_m'],
      line_time_s: r.configureScan['line_time_s'],
      requested_pixels: r.setScanBuffer.pixels,
      estimated_scan_s: r.estimatedScanS,
      // `isInt` 是 `summaryLines` 的一个渲染提示（JS 只有一种数），**不进报文**：
      // 它对读报文的人与模型都没有消费方，而多一个字段就多一处要解释的东西。
      param_trace: Object.fromEntries(
        Object.entries(r.trace).map(([k, v]) => [
          k,
          { value: v.value, source: v.source, tier: v.tier, human: v.human },
        ]),
      ),
      param_summary: summaryLines(r),
      policy_warnings: r.warnings,
    }

    this.#ex = new GraphExecutor('ScanAt', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
      onStepResult: (step, res) => this.#onStepResult(step, res),
    })

    const allGood = await this.#ex.runPlan(this.#plan(r))
    const p = this.#ex.progress
    // 停止这件事的**机器可读**版本放顶层：下游要判「用户喊停」还是「它自己失败了」，
    // 不该去猜一句人话的措辞 —— 那正是 #46 的翻版（判据落在措辞上，措辞一改就失效）。
    const data: Record<string, unknown> = {
      ...p.partialData,
      ...snapshot,
      _progress: progressToDict(p),
      ...abortFacts(p),
    }

    // 超时之后把扫描停掉 —— **在判结局之前**，与旧仓的顺序一样：它是对仪器状态的
    // 补救，跟这一趟最后报成功还是失败无关。**中途停止那条路刻意不在这里**（见抬头）。
    if (p.partialData['wait_timed_out'] === true) {
      // `Scan_Action(1, …)` 在 `ABORT_SAFE_WRITES` 里，中止闩上了照样发得出去。
      // 它失败不改变结局：我们已经在失败路径上了，而「停扫也没停成」是另一条消息。
      const rec = await this.#ctx.safeCall('Scan_Action', 1, 0)
      if (rec.error !== undefined && rec.error !== '') data['stop_after_timeout_error'] = rec.error
    }

    if (!allGood) {
      return { success: false, error: p.abortedReason || 'scan aborted', data }
    }

    if (p.partialData['wait_stopped_early'] === true) {
      return { success: false, error: stoppedEarlyText(p.partialData), data }
    }
    if (p.partialData['wait_timed_out'] === true) {
      return { success: false, error: timedOutText(p.partialData, r.estimatedScanS), data }
    }
    return { success: true, data }
  }
}

/** 中途停止那句 —— **不是超时，调大 timeout 不解决问题**。 */
export function stoppedEarlyText(pd: Readonly<Record<string, unknown>>): string {
  const done = pd['scan_lines_done']
  const total = pd['scan_lines_total']
  const where = done !== null && done !== undefined && total ? `(扫到 ${done}/${total} 行)` : '(行数未知)'
  return (
    `扫描中途停止${where} —— 这一帧没有扫完,不要当作扫好的图使用。` +
    `可能是用户按了 Stop、Nanonis 自行停止,或安全停机;` +
    `**不是**超时,调大 timeout 不解决问题。`
  )
}

/**
 * 超时那句 —— **报文里必须有哪几个数（2026-08-05）**。
 *
 * 它从前只印那个**估计值**，别的什么都没有：不印真正等了多久的预算、不印实际耗时、
 * 不印行数。于是真机上一次真实的超时被这一句话诊断了两遍 —— 一次判成「这条路上没加
 * +30 % 余量」、一次判成「显式的 `wait_timeout_s` 被忽略了」。**两条都是假的**（代码
 * 两件事都做了），而这句话没法告诉任何人，因为它里面唯一的那个数正好**不是**预算。
 */
export function timedOutText(pd: Readonly<Record<string, unknown>>, estimatedS: number): string {
  const bits: string[] = []
  if (estimatedS) bits.push(`按解析参数估计需要 ${Math.round(estimatedS)} s`)
  const budget = pd['budget_s']
  if (typeof budget === 'number') bits.push(`等待预算 ${Math.round(budget)} s`)
  const waited = pd['elapsed_s']
  if (typeof waited === 'number') bits.push(`实际等了 ${Math.round(waited)} s`)
  const ext = pd['extensions']
  if (ext) bits.push(`其中因扫描仍在推进延长过 ${ext} 次`)
  const done = pd['lines_done']
  const total = pd['lines_total']
  if (done !== null && done !== undefined) bits.push(`放弃时已采 ${done}/${total ? total : '?'} 行`)
  const hint = bits.length > 0 ? `(${bits.join(';')})` : ''
  return (
    `扫描在等待预算内没有完成${hint} —— 帧不完整,不要当作扫好的图使用。` +
    '若「已采行数」几乎等于总行数,那是估计帧时偏小而不是扫描卡住:' +
    '显式传一个更大的 wait_timeout_s 即可。'
  )
}

export function makeScanAt(deps: ScanAtDeps = {}): Skill {
  return { spec: S.ScanAtSpec, execute: (ctx, params) => new Scan(ctx, params, deps).run() }
}

export const ScanAt: Skill = makeScanAt()
