/**
 * `AutoApproach` —— 启动粗动进针，等它到设定点，然后**用电流确认它真的进针了**。
 *
 * 四相定计划（`open` → `start` → `wait` → `verify`），全部 `optional: false`：
 * 任何一相失败都中止整个组合。它是本仓第一个走 GraphExecutor **静态计划**的技能
 * （`WaitScanComplete` 是流式、`SetBiasRamp` 是先算后排）。
 *
 * ## 「模块停了」不等于「进针了」
 *
 * 模块停下的原因不止一个：到了设定点会停，**电机量程走完了**也停，外部停止、模块报错
 * 都停。2026-07-10 #42：一次进针在 **0.17 pA / 设定点 500 pA** 上报了成功，agent 照样
 * 去扫图。所以停下之后要拿隧穿电流确认——而且要拿**互相一致**的读数确认
 * （见 `kernel/src/engage.ts` 里 `settleEngagement` 那段 2026-08-05）。
 *
 * ## 与旧仓的差异
 *
 * - **D-APPROACH-1 · 进针参数组的切换与放回不移植。** 旧仓 `run_composite` 会
 *   `apply_approach_preset` → 跑图 → `finally: restore_zctrl`（缺陷⑫：中止时也要放回，
 *   与「中止不动手」刻意相反，判据是「这个状态是不是我改的」）。它依赖 `zctrl_presets`
 *   参数组存储，本仓还没有——而那份存储同时也是 `CreateZCtrlPreset` 卡着的东西，
 *   两者该一起落。**没配参数组本来就是旧仓支持的正常配置**（那时它原样沿用当前增益，
 *   也就是本仓现在的行为），所以这不是半个闸；但 `finally` 放回那一条是真的债，
 *   补参数组时必须连它一起补。
 * - **D-APPROACH-2 · 串扰报告不移植。** `_maybe_report_crosstalk` 每 15 s 读一次
 *   lock-in X 报「≈还剩多少步」，它**不驱动任何决策**（旧仓自己的注释写着），而 lock-in
 *   链路本仓还没有。
 */
import {
  GraphExecutor,
  WaitProgress,
  abortFacts,
  engageFailureText,
  engageVerdictToDict,
  parseRunning,
  progressToDict,
  scalarFloat,
  settleEngagement,
  type CompositeStep,
  type EngageVerdict,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import type { PresetSkillDeps } from '../l0/zctrl-presets.js'
import { applyApproachPreset, restoreZctrl, type ZctrlNote } from './approach-preset.js'

const PHASE_OPEN = '_phase_open_module'
const PHASE_START = '_phase_start_approach'
const PHASE_WAIT = '_phase_wait_complete'
const PHASE_VERIFY = '_phase_verify_status'

/**
 * 粗动进针最多跑多久，到点就停模块并报「未完成」。
 *
 * 这**只是一道兜底**：模块一到设定点等待就立刻结束，所以一个宽松的上限在正常进针上
 * 不花任何代价，却能避免截断一次合法的长距离粗动。参考系统观测表明 300–900 s
 * 可能短于完整行程，因此这里使用 30 分钟；该范围尚未在本仓独立验证。
 */
export const DEFAULT_WAIT_TIMEOUT_S = 1800.0
/** 状态轮询节奏。 */
export const POLL_INTERVAL_S = 0.5
/** 起跑宽限窗口：这么久还一次没读到 running，就当启动被拒（再用电流复核一次）。 */
export const GRACE_S = 3.0
/**
 * 等待相里多久读一次 Z。**不跟状态轮询同一个节奏**：本机一个啄木鸟循环实测约 4.6 s，
 * 1 Hz 就能分辨，而每 0.5 s 再加一个来回是把这条链路上的流量翻倍去换一个已经够用的
 * 分辨率。
 */
export const Z_SAMPLE_EVERY_S = 1.0
/** 连着这么多次轮询报错就撤，别耗满那个（很长的）超时。 */
export const MAX_CONSECUTIVE_ERRORS = 5

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const first = (rec: SkillCallRecord): number | null => scalarFloat((rec.values ?? [])[0])

export interface ApproachKnobs {
  readonly pollIntervalS?: number
  readonly graceS?: number
  readonly zSampleEveryS?: number
  readonly engageBudgetS?: number
  readonly engageIntervalS?: number
  /** 进针参数组的两路真源（自定义组存储 + 仪器档案）。没接 = 档案没配，如实跳过切换。 */
  readonly presets?: PresetSkillDeps
}

class Approach {
  readonly #ctx: SkillContext
  readonly #timeoutS: number
  readonly #k: Required<Omit<ApproachKnobs, 'presets'>>
  readonly #knobs: ApproachKnobs
  readonly #stopFailures: string[] = []
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>, knobs: ApproachKnobs) {
    this.#ctx = ctx
    this.#knobs = knobs
    const t = params['wait_timeout_s']
    this.#timeoutS = typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_WAIT_TIMEOUT_S
    this.#k = {
      pollIntervalS: knobs.pollIntervalS ?? POLL_INTERVAL_S,
      graceS: knobs.graceS ?? GRACE_S,
      zSampleEveryS: knobs.zSampleEveryS ?? Z_SAMPLE_EVERY_S,
      engageBudgetS: knobs.engageBudgetS ?? 20.0,
      engageIntervalS: knobs.engageIntervalS ?? 1.0,
    }
  }

  get #nowS(): number {
    return this.#ctx.now() / 1000
  }

  async run(): Promise<SkillResultLike> {
    // 缺陷⑫：进针前切到进针参数组，**结束时放回去** —— 中止时更要放。
    // 切失败不该把进针带走，所以它永不抛，只留痕。
    const [snapshot, presetNote] = await applyApproachPreset(
      this.#ctx,
      this.#knobs.presets ?? {},
      'AutoApproach',
    )
    let restoreNote: ZctrlNote = {}
    try {
      this.#ex = new GraphExecutor('AutoApproach', {
        now: () => this.#ctx.now(),
        run: (skill) => this.#phase(skill),
        checkAbort: () => this.#ctx.signal.aborted,
      })
      this.#ex.setPartialDefault('approach_started', false)

      const allGood = await this.#ex.runPlan(PLAN)

      const p = this.#ex.progress
      const finalRunning = p.partialData['final_running']
      // `finally` 的语义写成显式的一句：**跑完与跑砸走同一条放回路**。
      restoreNote = await restoreZctrl(this.#ctx, snapshot, 'AutoApproach')
      const data: Record<string, unknown> = {
        approach_started: p.partialData['approach_started'] === true,
        running: typeof finalRunning === 'boolean' ? finalRunning : null,
        wait_progress: p.partialData['wait_progress'] ?? null,
        _progress: progressToDict(p),
        // 缺陷⑬：「用户喊停」与「它自己失败了」是两句话，而下游要判这件事不能去猜
        // `error` 的措辞（那正是 #46）。
        ...abortFacts(p),
        ...presetNote,
        ...restoreNote,
      }
      if (!allGood) {
        return { success: false, error: p.abortedReason || 'AutoApproach aborted', data }
      }
      return { success: true, data }
    } catch (exc) {
      // 图本身炸了也要放回去 —— 这一条正是缺陷⑫ 的全部内容。
      await restoreZctrl(this.#ctx, snapshot, 'AutoApproach')
      throw exc
    }
  }

  #phase(skillName: string): Promise<StepResult> {
    if (skillName === PHASE_OPEN) return this.#open()
    if (skillName === PHASE_START) return this.#start()
    if (skillName === PHASE_WAIT) return this.#wait()
    if (skillName === PHASE_VERIFY) return this.#verify()
    return Promise.resolve({ success: false, error: `Unknown phase: ${skillName}` })
  }

  async #open(): Promise<StepResult> {
    const rec = await this.#ctx.safeCall('AutoApproach_Open')
    return failed(rec) ? { success: false, error: rec.error ?? '' } : { success: true }
  }

  async #start(): Promise<StepResult> {
    const rec = await this.#ctx.safeCall('AutoApproach_OnOffSet', 1)
    if (failed(rec)) return { success: false, error: rec.error ?? '' }
    this.#ex.setPartial('approach_started', true)
    return { success: true }
  }

  // ── 等待相 ───────────────────────────────────────────────────────────

  /**
   * 真的**等**粗动进针跑完。
   *
   * 老实现只发一次 `OnOffGet` 就不管模块是还在逼近、已经完成、**还是压根拒绝启动**，
   * 一律返回成功——于是 `ApproachTip` 宣布「已进针、停在设定点」，而电机可能还在走
   * （或者从来没起来过）。
   */
  async #wait(): Promise<StepResult> {
    const start = this.#nowS
    const progress = new WaitProgress()
    let observedRunning = false
    let consecutiveErrors = 0
    let zLastT: number | null = null

    for (;;) {
      if (this.#ctx.signal.aborted) {
        // 中止时**先把模块停下**再返回：它还在跑意味着针尖还在往表面压。
        await this.#stopModule()
        this.#ex.setPartial('aborted', true)
        this.#ex.setPartial('wait_progress', progress.toDict())
        return {
          success: false,
          error: `aborted by user — AutoApproach module stopped${this.#stopNote()}`,
          data: { wait_progress: progress.toDict(), stop_failures: [...this.#stopFailures] },
        }
      }

      const elapsed = this.#nowS - start
      const rec = await this.#ctx.safeCall('AutoApproach_OnOffGet')
      if (failed(rec)) {
        // 偶发的轮询失败重试几次；链路真的死了就撤，别在那个（很长的）超时上空转。
        consecutiveErrors += 1
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || elapsed >= this.#timeoutS) {
          this.#ex.setPartial('wait_progress', progress.toDict())
          return {
            success: false,
            error: `OnOffGet failed persistently: ${rec.error}`,
            data: { wait_progress: progress.toDict() },
          }
        }
        await this.#sleep(this.#k.pollIntervalS)
        continue
      }
      consecutiveErrors = 0

      const running = parseRunning(rec.values ?? null)
      // 读不懂与读到 0 在**循环里**的处置一样（都往「可能停了」走），但**记下来**：
      // 事后要能分出「模块报停了」和「我们没问出来」。
      if (running === null) progress.statusUnreadableN += 1
      progress.noteRunning(running === true, elapsed)

      const nowT = this.#nowS
      if (this.#k.zSampleEveryS > 0 && (zLastT === null || nowT - zLastT >= this.#k.zSampleEveryS)) {
        zLastT = nowT
        progress.noteZ(await this.#readZ())
      }

      if (running === true) {
        observedRunning = true
      } else {
        if (observedRunning && !(await this.#confirmStopped(progress))) {
          // 复读说它还在跑 —— 那个「停了」是一次读数，不是一个事实。
          await this.#sleep(this.#k.pollIntervalS)
          continue
        }
        if (observedRunning) return this.#afterStop(progress)
        if (elapsed >= this.#k.graceS) return this.#afterNoStart(progress)
      }

      if (elapsed >= this.#timeoutS) return this.#afterTimeout(progress)
      await this.#sleep(this.#k.pollIntervalS)
    }
  }

  /** 跑过、现在停了。**停下不是到达设定点的证明**——拿电流确认。 */
  async #afterStop(progress: WaitProgress): Promise<StepResult> {
    const v = await this.#judge()
    this.#ex.setPartial('wait_progress', progress.toDict())
    if (v.engaged === true) {
      this.#ex.setPartial('running_after_start', false)
      return {
        success: true,
        data: {
          running: false,
          completed: true,
          engagement: engageVerdictToDict(v),
          wait_progress: progress.toDict(),
        },
      }
    }
    await this.#stopModule()
    return {
      success: false,
      error: engageFailureText(v, { stopped: true, progress }) + this.#stopNote(),
      data: {
        engagement: engageVerdictToDict(v),
        wait_progress: progress.toDict(),
        stop_failures: [...this.#stopFailures],
      },
    }
  }

  /** 宽限窗口内一次都没读到 running：要么启动被拒，要么比第一次轮询还快就完成了。 */
  async #afterNoStart(progress: WaitProgress): Promise<StepResult> {
    const v = await this.#judge()
    this.#ex.setPartial('wait_progress', progress.toDict())
    if (v.engaged === true) {
      this.#ex.setPartial('running_after_start', false)
      return {
        success: true,
        data: {
          running: false,
          completed: true,
          note: 'completed before first poll (current confirms)',
          engagement: engageVerdictToDict(v),
          wait_progress: progress.toDict(),
        },
      }
    }
    return {
      success: false,
      error: engageFailureText(v, { stopped: false, progress }) + this.#stopNote(),
      data: {
        engagement: engageVerdictToDict(v),
        wait_progress: progress.toDict(),
        stop_failures: [...this.#stopFailures],
      },
    }
  }

  /**
   * 到了上限还在跑 ⇒ **不许报成功**。停掉模块，如实说它到哪一步了。
   *
   * 这个上限砍掉的可能是一趟完全健康、只是 4 K 下步长太短的进针（2026-08-08 实测：
   * 1800 s 走掉约 2000 个粗动步，仍未到表面）。「跑满了预算」和「卡住了」是两件事，
   * 而下一步该做什么完全取决于是哪一件——前者只要再调一次，后者再调一次没有意义。
   */
  async #afterTimeout(progress: WaitProgress): Promise<StepResult> {
    await this.#stopModule()
    this.#ex.setPartial('running_after_start', true)
    this.#ex.setPartial('timed_out', true)
    this.#ex.setPartial('wait_progress', progress.toDict())
    const why =
      `AutoApproach did not reach the setpoint within ${this.#timeoutS.toFixed(0)}s — ` +
      `stopped the module。${progress.motionText()}` +
      (progress.zTravelM > 0
        ? ' 仍在推进却被预算砍断 —— 这不是「卡住」,**再调一次 AutoApproach 会从当前粗动位置继续**(必要时把 wait_timeout_s 调大)。'
        : '')
    return {
      success: false,
      error: why + this.#stopNote(),
      data: { wait_progress: progress.toDict(), stop_failures: [...this.#stopFailures] },
    }
  }

  async #verify(): Promise<StepResult> {
    const rec = await this.#ctx.safeCall('AutoApproach_OnOffGet')
    if (failed(rec)) return { success: false, error: `verify OnOffGet failed: ${rec.error}` }
    const running = parseRunning(rec.values ?? null)
    this.#ex.setPartial('final_running', running)
    return { success: true, data: { running } }
  }

  // ── 读与停 ───────────────────────────────────────────────────────────

  /**
   * 当前 Z 压电位置；读不到返回 `null`。
   *
   * **不从监控库拿**，虽然 aux 采集器正好也在 1 Hz 读同一个量：那个采集器可以是关着的
   * （出厂就关），而一个只在监控开着时才有的进展判据，会在最需要它的那台机器上恰好不
   * 存在。这里多一个来回，换的是「这条判据自己站得住」。
   */
  async #readZ(): Promise<number | null> {
    const rec = await this.#ctx.safeCall('ZCtrl_ZPosGet')
    return failed(rec) ? null : first(rec)
  }

  /**
   * 再读一次确认模块**真的**停了。`true` = 确实停了。
   *
   * 读到一个「停了」之后，下游会做两件不可逆的事：判一次「进针失败」，并且主动把模块
   * 停掉。如果那个读数是一次瞬态，代价就是掐掉一趟正在走的进针，而症状看起来和
   * 「模块自己停了」一模一样。
   *
   * 这与 `settleEngagement` 是同一条纪律：**结论不建立在单次读数上**。电流那一路早就
   * 这么做了，模块状态这一路一直没有——而它决定的事情更重（那一路只是判定，这一路会
   * 动手停机器）。
   *
   * 读不到时返回 `true`：不推翻已经读到的那个「停了」。否则一条坏链路会让等待循环永远
   * 结束不了——那是把一个已知的失败换成一个静默的挂起。
   *
   * **诚实备注**：截至 2026-08-08 这个闩从未在真机上被触发过。要证明它在承重，看
   * `status_flap_n`；它长期为 0 就说明这条防线至今没派上用场，那也是一个结论。
   */
  async #confirmStopped(progress: WaitProgress): Promise<boolean> {
    const rec = await this.#ctx.safeCall('AutoApproach_OnOffGet')
    if (failed(rec)) return true
    const again = parseRunning(rec.values ?? null)
    if (again === true) {
      progress.statusFlapN += 1
      return false
    }
    if (again === null) progress.statusUnreadableN += 1
    return true
  }

  /** 有没有隧穿，由**互相一致**的读数判。只有最后一对读数进调用记录。 */
  async #judge(): Promise<EngageVerdict> {
    return settleEngagement({
      readPair: async () => {
        const cur = await this.#ctx.safeCall('Current_Get')
        const sp = await this.#ctx.safeCall('ZCtrl_SetpntGet')
        return [failed(cur) ? null : first(cur), failed(sp) ? null : first(sp)] as const
      },
      now: () => this.#nowS,
      sleep: (s) => this.#sleep(s),
      checkAbort: () => this.#ctx.signal.aborted,
      budgetS: this.#k.engageBudgetS,
      intervalS: this.#k.engageIntervalS,
    })
  }

  /**
   * 尽力停机，**永不抛**。
   *
   * 「没停下来」必须留下痕迹（2026-08-10）。原来整段包在 `except: pass` 里：停机命令
   * 根本没下发，而调用方拿到的东西和停成功时**一模一样**——接下来它只会报「进针失败」，
   * 一个字都不会提「而且模块可能还在走」。进针模块还在跑意味着针尖还在往表面压，
   * 这是这个文件里代价最高的一种不知情。
   *
   * `AutoApproach_OnOffSet(0)` 在 `ABORT_SAFE_WRITES` 里（按动词加实参判：0 = 停、放行；
   * 1 = 开，会**重新开始**逼近、拒），所以中止闩上了它照样发得出去。
   */
  async #stopModule(): Promise<void> {
    const rec = await this.#ctx.safeCall('AutoApproach_OnOffSet', 0)
    if (failed(rec)) this.#stopFailures.push(`AutoApproach_OnOffSet(0): ${rec.error}`)
  }

  /** 停机没做成时顶进 error 文本的一行。空串 = 命令确实发出去了。 */
  #stopNote(): string {
    if (this.#stopFailures.length === 0) return ''
    return (
      '\n⚠️ **进针模块的停机命令没有成功下发**(' +
      this.#stopFailures.join('；') +
      ')。模块可能仍在推进针尖 —— 请立即到 Nanonis 的 Auto Approach ' +
      '面板确认它已停止,不要假设本技能已经把它停下了。'
    )
  }

  #sleep(seconds: number): Promise<void> {
    return this.#ctx.sleep(seconds * 1000)
  }
}

/** 四相定计划。全部 `optional: false`：任何一相失败都中止整个组合。 */
const PLAN: readonly CompositeStep[] = [
  { stepId: 'open_module', skillName: PHASE_OPEN, params: {}, checkpointAfter: false, tags: ['setup', 'open'] },
  // 关键状态变更 —— 落检查点
  { stepId: 'start_approach', skillName: PHASE_START, params: {}, tags: ['write', 'start'] },
  { stepId: 'wait_complete', skillName: PHASE_WAIT, params: {}, checkpointAfter: false, tags: ['read', 'wait'] },
  // 终态 —— 落检查点
  { stepId: 'verify_status', skillName: PHASE_VERIFY, params: {}, tags: ['read', 'verify'] },
]

/** 测试与组合技能用的旋钮出口；生产路径一律走默认值。 */
export function makeAutoApproach(knobs: ApproachKnobs = {}): Skill {
  return {
    spec: S.AutoApproachSpec,
    execute: (ctx, params) => new Approach(ctx, params, knobs).run(),
  }
}

export const AutoApproach: Skill = makeAutoApproach()
