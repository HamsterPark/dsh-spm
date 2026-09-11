/**
 * `WaitScanComplete` —— 等当前这一帧扫完，或者等到超时。
 *
 * 本仓**第一个流式动态计划**：每一次轮询是它自己的一步（`poll_<i>`），步数事先不
 * 知道，最后补一个 `finalize`。GraphExecutor 四条恢复守卫里有两条就是被这个形状咬
 * 出来的（`totalSteps == 0` 那个分母、跑完清断点），所以它同时是执行器的验收。
 *
 * 轮 `Scan_StatusGet`，**不用** Nanonis 自己的 `Scan_WaitEndOfScan`：后者会把 TCP
 * 套接字堵满整个超时，Stop 按钮失灵、模型也不知道扫描什么时候结束了。
 *
 * ## 硬约束：中止与超时都**先停扫再返回**
 *
 * dsh 的超时同样触发 `ctx.signal`。**绝不把仪器留在运动中** —— 所以这两条路都要先
 * 发 `Scan_Action(1, 0)`。那个动词在 `ABORT_SAFE_WRITES` 里，中止闩上了照样发得出去
 * （见 `gated-call.ts`：闸门按**动词加参数**判，`Scan_Action(1, …)` 是停扫、放行，
 * `Scan_Action(0, …)` 是起扫、拒）。
 *
 * ## 与旧仓的差异
 *
 * - **D-SCAN-2 · 轮询自己那道中止检查不移植。** 旧仓在 `_phase_poll` 开头又查了一次
 *   `check_abort`，为的是抓执行器查过之后、这一步开跑之前翻过来的中止。在本仓那两处
 *   之间**没有 await**（执行器同步查完就调分发器），所以第二道检查永远和第一道同答案
 *   ——它唯一可观测的作用是让 `abort_facts` 自相矛盾：金样 `abort_inside_poll` 那格
 *   `outcome: "aborted"`、`error: "aborted by user"`，而同一份 data 里
 *   `aborted: false, aborted_by_operator: false`。下游按 `abort_facts` 判「是不是有人
 *   喊停」会得到「没有」——那正是 #46 那一族（判据与事实对不上）的翻版。去掉之后所有
 *   中止都走执行器，`abort_facts` 只有一个答案。
 * - **D-SCAN-3 · 不接断点。** dsh 的一次工具调用不跨进程续跑，而「续跑一次等待」
 *   本来也没有意义（重新等就是了）。接一个永远不会被读的断点，只会让人以为这里有
 *   续跑语义。
 */
import {
  EXTENSION_FRACTION,
  GraphExecutor,
  MAX_EXTENSIONS,
  START_GRACE_S,
  abortErrorText,
  abortFacts,
  extensionVerdict,
  grabChannel,
  measureLines,
  parseBufferGet,
  progressToDict,
  scalarInt,
  stillStarting,
  terminalVerdict,
  waitOutcome,
  type BufferGet,
  type CompositeStep,
  type LineMeasurement,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'

const POLL_PREFIX = '_phase_poll_'
const FINALIZE = '_phase_finalize'
/** 轮询间隔的默认值。参数没声明（旧仓也没有），组合技能可以传。 */
const DEFAULT_POLL_INTERVAL_S = 0.5

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

class Wait {
  readonly #ctx: SkillContext
  readonly #startMs: number
  readonly #timeoutS: number
  readonly #pollIntervalS: number
  readonly #stopOnTimeout: boolean
  #deadlineS: number
  #extensions = 0
  #lastLines: number | null = null
  #frameRestarted = false
  /** 见过 `Scan_StatusGet != 0` 了吗。**「还没起来」和「已经停了」是两件事。** */
  #seenRunning = false
  #polls = 0
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#startMs = ctx.now()
    const timeoutMs = typeof params['timeout_ms'] === 'number' ? params['timeout_ms'] : -1
    this.#timeoutS = timeoutMs < 0 ? Number.POSITIVE_INFINITY : timeoutMs / 1000
    this.#deadlineS = this.#timeoutS
    const pi = params['poll_interval_s']
    this.#pollIntervalS = typeof pi === 'number' && pi > 0 ? pi : DEFAULT_POLL_INTERVAL_S
    // 超时默认**停扫**（2026-07-03 复盘）：老代码在扫描**还跑着**的情况下报成功，
    // 于是批量/整帧流程接着去保存、重配、重启一次活着的扫描。一次跑过头的扫描要么
    // 卡住了要么估错了，停掉它是安全的。
    this.#stopOnTimeout = params['stop_on_timeout'] !== false
  }

  get #elapsedS(): number {
    return (this.#ctx.now() - this.#startMs) / 1000
  }

  async run(): Promise<SkillResultLike> {
    this.#ex = new GraphExecutor('WaitScanComplete', {
      now: () => this.#ctx.now(),
      run: (skill, p) => this.#phase(skill, p),
      checkAbort: () => this.#ctx.signal.aborted,
    })
    // 续跑友好的默认值（本仓不接断点，但保持同一组键，读的人不必分两套）
    for (const [k, v] of [
      ['scan_done', false], ['timed_out', false], ['stopped_early', false],
      ['frame_restarted', false], ['lines_verified', false], ['polls', 0],
    ] as const) {
      this.#ex.setPartialDefault(k, v)
    }

    await this.#ex.runPlan(this.#plan())

    const p = this.#ex.progress
    const partial = p.partialData
    const aborted = p.aborted

    // 中止是在**任何一步开跑之前**被执行器拦下的，我们自己还没发过停扫。
    // 硬约束在这里兑现：先把扫描停掉，再返回。
    if (aborted) await this.#stopScan()

    const num = (k: string): number | null => {
      const v = partial[k]
      return typeof v === 'number' ? v : null
    }
    const flag = (k: string): boolean => partial[k] === true

    const data: Record<string, unknown> = {
      timed_out: flag('timed_out'),
      stopped_early: flag('stopped_early'),
      // 「它从没开始」与「它跑了一半被停下」是两个事实，指向的下一步也不同。
      never_started: flag('never_started'),
      outcome: waitOutcome(aborted, partial['outcome'] as string | undefined),
      // 缺陷⑬：「用户喊停」「超时」「它自己失败了」是三句话。
      ...abortFacts(p),
      lines_done: num('lines_done'),
      lines_total: num('lines_total'),
      lines_verified: flag('lines_verified'),
      // 「换帧了」和「卡住了」是两句话，所以这里是两个字段而不是一个。
      frame_restarted: flag('frame_restarted'),
      polls: num('polls') ?? this.#polls,
      elapsed_s: num('elapsed_s') ?? this.#elapsedS,
      // 等的是**什么**、最后等了**多久**。每一种结局上都有，不只超时那一种：
      // 一个只在需要它的那条路上才存在的数字，恰好在有人来问的时候不在。
      budget_s: Number.isFinite(this.#timeoutS) ? this.#timeoutS : null,
      deadline_s: Number.isFinite(this.#deadlineS) ? this.#deadlineS : null,
      extensions: num('extensions') ?? this.#extensions,
      // 停在**哪一步**。「组合停了」加一句光秃秃的理由正是 #90 没法诊断的原因——
      // 用户看得见它停在第 5 点，而没人说得出第 5 点是跑了、跳了、还是没到。
      // 在 `AUDIT_ONLY_KEYS` 里：记录要留，模型不必读一张 12 步的清单。
      _progress: progressToDict(p),
    }

    // `stopped_early` 保持 success=true，理由和 `timed_out` 一样：这个技能的职责是
    // **等**，而它等对了——扫描确实停了。一帧被截断能不能接受是调用方的判断。
    if (aborted) return { success: false, error: abortErrorText(p), data }
    return { success: true, data }
  }

  // ── 计划：一次轮询一步，最后 finalize ────────────────────────────────

  async *#plan(): AsyncGenerator<CompositeStep> {
    const maxPolls = this.#maxPolls()
    this.#ex.setTotalSteps(maxPolls + 1) // +1 finalize

    for (let i = 0; i < maxPolls; i += 1) {
      // 上一轮到了终态就别再轮了
      if (this.#ex.progress.partialData['scan_done'] === true) break
      if (this.#ex.progress.aborted) return
      yield {
        stepId: `poll_${i}`,
        skillName: `${POLL_PREFIX}${i}`,
        params: { index: i },
        // 一次抖动不该让整场等待中止；`finalize` 是必需的。
        optional: true,
        checkpointAfter: false,
        tags: ['poll', `i=${i}`],
      }
      if (this.#ex.progress.aborted) return
    }

    // 无论如何都发一个 finalize，好让结果永远是完整形状的。
    yield { stepId: 'finalize', skillName: FINALIZE, params: {}, optional: false }
  }

  /**
   * 轮询步数的硬上限，好让进度条有个分母。
   *
   * 从这次等待**合法能到达的最长死线**推，不是从基础预算推：轮询预算与时间预算是同
   * 一个循环上的两个限制，把其中一个按更短的视野来定，会让延期**永远到不了**——也就是
   * 一段读起来像守卫的死代码。（第一版就是这样：轮询在第 2 次用光，从没延期过。）
   */
  #maxPolls(): number {
    if (!Number.isFinite(this.#timeoutS)) return 100000
    const maxDeadline = this.#timeoutS * (1 + MAX_EXTENSIONS * EXTENSION_FRACTION)
    return Math.max(1, Math.trunc(maxDeadline / this.#pollIntervalS) + 2)
  }

  // ── 阶段分发 ─────────────────────────────────────────────────────────

  async #phase(skillName: string, _params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    if (skillName.startsWith(POLL_PREFIX)) return this.#poll()
    if (skillName === FINALIZE) return this.#finalize()
    return { success: false, error: `Unknown phase: ${skillName}` }
  }

  async #poll(): Promise<StepResult> {
    const elapsed = this.#elapsedS

    // 到了一半才播种参照点，**只播一次**。没有它的话第一次到点无从比较、于是永远
    // 延期不了——那条守卫会变成读起来像守卫的死代码。（数行要抓一整帧，所以它不待在
    // 每轮的路径上：一次等待多一次读，不是每 0.5 秒多一次。）
    if (this.#lastLines === null && Number.isFinite(this.#timeoutS) && elapsed >= 0.5 * this.#timeoutS) {
      this.#lastLines = (await this.#measure()).linesDone
    }

    if (elapsed >= this.#deadlineS) {
      // ⚠️ 延期批下来之后**穿透**到下面的 StatusGet + sleep，不是直接返回。旧仓这里
      // 没有 `return`，而我第一版加了一个：那让每一次延期白烧一个轮询步、还少读一次
      // 状态，于是 `extension_granted` 那一格在轮询预算用光时结局变成 `unknown`
      // ——「没有任何东西说过它完成了」，而扫描其实好好地在跑。
      const gaveUp = await this.#expired(elapsed)
      if (gaveUp !== null) return gaveUp
    }

    const rec = await this.#ctx.safeCall('Scan_StatusGet')
    this.#polls += 1
    if (failed(rec)) {
      // 一次读失败：睡一下接着轮。**不算失败步骤**——抖动是可恢复的。
      await this.#ctx.sleep(this.#pollIntervalS * 1000)
      return {}
    }

    const status = scalarInt((rec.values ?? [])[0])
    if (status === null) {
      // ⚠️ **读不出状态不是「它在跑」的证据。**
      //
      // 旧仓这里是 `parsed[2][0]` —— 空 body 上抛 IndexError，那一步被 `optional`
      // 吞掉（金样 `empty@0` 的 `failed_steps: ["poll_0"]` 就是它）。我第一版换成
      // `scalarInt` 之后写了 `status !== 0`，于是 `null !== 0` 为真 ⇒ **把一次没读到
      // 当成看见它在跑**，`seenRunning` 被一个不存在的读数点亮。代价是
      // `never_started` 那条守卫从此再也不可能成立——2026-08-13 那条竞态会重新变成
      // 「中途停止 (0/256 行)」。
      //
      // 读不到就接着等：与本类「不可测不是被截断」同一条纪律。
      await this.#ctx.sleep(this.#pollIntervalS * 1000)
      return {}
    }
    if (status !== 0) {
      // 看见它在跑了。从这一刻起，再读到 0 就**确实**是「停了」。
      this.#seenRunning = true
    } else if (!this.#seenRunning && elapsed < START_GRACE_S) {
      const probe = await this.#measure()
      if (stillStarting(this.#seenRunning, elapsed, probe)) {
        await this.#ctx.sleep(this.#pollIntervalS * 1000)
        return { success: true, data: { timed_out: false, waiting_for_start: true } }
      }
    }

    if (status === 0) return this.#terminal()

    await this.#ctx.sleep(this.#pollIntervalS * 1000)
    return {}
  }

  /** 扫描停了。问一次缓冲区它到底扫完没有。 */
  async #terminal(): Promise<StepResult> {
    const lines = await this.#measure()
    const v = terminalVerdict(this.#seenRunning, lines)
    const set = (k: string, x: unknown): void => this.#ex.setPartial(k, x)
    set('scan_done', true)
    set('timed_out', false)
    set('never_started', v.neverStarted)
    set('stopped_early', v.stoppedEarly)
    set('outcome', v.outcome)
    if (lines.linesDone !== null) set('lines_done', lines.linesDone)
    if (lines.linesTotal !== null) set('lines_total', lines.linesTotal)
    set('lines_verified', lines.linesVerified)
    set('elapsed_s', this.#elapsedS)
    return { success: true, data: { timed_out: false, ...lines } }
  }

  /**
   * 预算到点了。它是卡住了，还是只是比预计慢？
   *
   * 批下延期返回 `null`（**接着轮**），放弃时返回那一步的结果。
   */
  async #expired(elapsed: number): Promise<StepResult | null> {
    const v = await extensionVerdict({
      extensions: this.#extensions,
      prev: this.#lastLines,
      measure: () => this.#measure(),
      timeoutS: this.#timeoutS,
      elapsedS: elapsed,
    })
    this.#lastLines = v.lastLines
    if (v.frameRestarted) this.#frameRestarted = true
    if (v.grant) {
      this.#extensions += 1
      this.#deadlineS = v.deadlineS
      this.#ex.setPartial('deadline_s', this.#deadlineS)
      this.#ex.setPartial('extensions', this.#extensions)
      return null
    }

    if (this.#stopOnTimeout) await this.#stopScan()
    const set = (k: string, x: unknown): void => this.#ex.setPartial(k, x)
    set('scan_done', true)
    set('timed_out', true)
    set('outcome', this.#frameRestarted ? 'restarted' : 'timed_out')
    set('frame_restarted', this.#frameRestarted)
    set('elapsed_s', elapsed)
    // 读的人要分「预算太小」与「扫描挂了」，靠的就是这两个数。它们的缺席正是
    // 2026-08-05 那次先被诊断成「显式的 wait_timeout_s 被忽略了」的原因——那句话
    // 引的是**估计值**，从来没引过预算，于是它支持不了任何一个结论。
    set('budget_s', Number.isFinite(this.#timeoutS) ? this.#timeoutS : null)
    set('last_lines_done', this.#lastLines)
    return {
      success: true,
      data: {
        timed_out: true,
        budget_s: Number.isFinite(this.#timeoutS) ? this.#timeoutS : null,
        deadline_s: this.#deadlineS,
        elapsed_s: elapsed,
        extensions: this.#extensions,
        lines_done: this.#lastLines,
        frame_restarted: this.#frameRestarted,
        scan_stopped: this.#stopOnTimeout,
      },
    }
  }

  #finalize(): StepResult {
    this.#ex.setPartial('elapsed_s', (this.#ex.progress.partialData['elapsed_s'] as number | undefined) ?? this.#elapsedS)
    this.#ex.setPartial('polls', this.#polls)
    return { success: true }
  }

  // ── 两次读 ───────────────────────────────────────────────────────────

  /**
   * 这一帧有几行真的带着数据。**一次性、读不到就 fail open。**
   *
   * 两次调用：`Scan_BufferGet` 拿配置行数与通道号（真机上通道号是 1-元组），
   * `Scan_FrameDataGrab` 拿帧——整行 NaN 的那些就是没采到的。
   *
   * 抓一整帧要搬约 1 MB（512²），这就是它**不待在每轮路径上**的原因：0.5 秒一轮的话
   * 那是 2 MB/s 的 TCP，压在扫描自己用的那条套接字上。
   */
  async #measure(): Promise<LineMeasurement> {
    let buffer: BufferGet | null = null
    const recBuf = await this.#ctx.safeCall('Scan_BufferGet')
    if (!failed(recBuf)) buffer = parseBufferGet(recBuf.values ?? null)
    const recFrame = await this.#ctx.safeCall('Scan_FrameDataGrab', grabChannel(buffer), 1)
    return measureLines(buffer, failed(recFrame) ? null : (recFrame.values ?? null))
  }

  /** 停扫。**永不抛** —— 停不掉也不该改变这次等待的结局。 */
  async #stopScan(): Promise<void> {
    await this.#ctx.safeCall('Scan_Action', 1, 0)
  }
}

export const WaitScanComplete: Skill = {
  spec: S.WaitScanCompleteSpec,
  execute: (ctx, params) => new Wait(ctx, params).run(),
}
