/**
 * `FullScan` —— 一步式扫描：配置 → 设速度 → 起扫 → 等它扫完 → **扫完之后判撞针**。
 *
 * 与 `ScanAt` 的分工：`ScanAt` 是**意图级**入口（说扫哪、多大，参数由策略表定），
 * 这一个是**几何级**入口（调用方自己给框）。旧仓两条都留着，因为 `FullScan` 是一批
 * L4 流程（`AcquireBiasImagingSeries` / `AngleSeriesCalibration` / `TrackDrift`）的
 * 计划步，它们已经算好了框。
 *
 * ## 它是撞针状态机的**记录侧**
 *
 * `crashGuard` 在开跑前问一次（同一个点撞满阈值就拒绝原地重扫），
 * `recordCrash` 在判出撞针时记一次，`noteRecovery` 在扫干净时清一次。
 * 三件事合起来才是那台状态机 —— 只问不记，它永远是空的。
 *
 * ⚠️ **拒绝没有降级路径。** 旧仓这一处不是 `try/except → 放行`，是真的返回失败。
 * 理由在 `kernel/src/tip-crash-tracker.ts` 的抬头：在原地修针修不好一个一直把针撞坏的
 * 位置，而当时没有任何东西记着「这个地方已经把针撞坏两次了」，一整段机时就原地烧掉了。
 *
 * ## 扫完的撞针检测：三态，而且**默认探的是真正采到的那几路**
 *
 * 判据在内核（`crashVerdict`）：方差接近零、或者出现 NaN。这里只负责把每一路读回来。
 *
 * | | |
 * |---|---|
 * | `status` 三态 | 一路都没读到是 `skipped`，**永远不是 `ok`**。「我没发现撞针」与「我没能看」是两句话 |
 * | 通道清单问仪器 | 写死的 `14`（Z-controller）在标准模拟器上是 **30** ⇒ 探针打空 ⇒ 撞针检查在**每一次扫描**上报 `skipped`（2026-06-29） |
 * | 一路坏掉不带走整趟 | 读某一路抛了就记它自己一个 `error`，接着读下一路 |
 *
 * ## 与旧仓的差异
 *
 * - **视觉判语（`_vision_verdict`）不移植。** 旧仓从 `buffer.active` 取最近一次针尖
 *   质量判定贴进 `data`，整段包在 `try/except → {}`。视觉链路本仓还没有，接一个永远
 *   返回空的读口，等于给下一个人留一条永远不亮的分支（同 D-SCAN-4 / D-GRAPH-2）。
 *   **代价说清**：2026-07-10 #88 那次，视觉模型一路说 tip=bad 而 agent 照旧旁白
 *   「图像质量正常」—— 因为它手上只有撞针检查。补视觉链路时必须连它一起补。
 */
import {
  DEFAULT_CRASH_CHANNELS,
  GraphExecutor,
  channelIdsFromBuffer,
  crashEscapeMessage,
  crashGuard,
  crashVerdict,
  getTipCrashTracker,
  parseBufferGet,
  parseFrameGrab,
  progressToDict,
  resolveLineTime,
  waitBudgetS,
  type ChannelSamples,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { runSubSkill } from './run-sub.js'

/** 整帧扫描的等待下限（秒）。 */
export const FULL_SCAN_WAIT_FLOOR_S = 300.0

/** 读不到行数时的假设。512 行是旧仓那个假设，照移 —— 它只影响**预算**，不影响判据。 */
export const ASSUMED_LINES = 512

class Full {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  readonly #calls: string[] = []
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  get #centerX(): unknown {
    return this.#params['center_x_m']
  }

  get #centerY(): unknown {
    return this.#params['center_y_m']
  }

  /** 每线时间 + 来源。公式与档位表在内核，**只有一份**（三份里两份把 0.1 s 当默认）。 */
  #lineTime(): { lineTimeS: number; source: string } {
    const w = num(this.#params['width_m'])
    const h = num(this.#params['height_m'])
    return resolveLineTime(this.#params['line_time_s'], Math.max(w, h))
  }

  /**
   * 等待上限：显式值**直接用**，否则按真实几何估。
   *
   * ⚠️ 与 `ScanAt` **刻意不同**：那边显式值是**下限**（取 max），这边是「给了就用给的」
   * —— 旧仓两处就是两条规矩。`ScanAt` 那条是 2026-08-23 的事故修出来的，而这一个的
   * 调用方全是自己算好了框与预算的流程步。不擅自对齐：`AcquireBiasImagingSeries` 一类
   * 传进来的短预算在它那条路上可能是有意的。
   */
  #waitTimeoutS(lineTimeS: number, nLines: number): number {
    const req = this.#params['wait_timeout_s']
    if (req !== undefined && req !== null) {
      const v = typeof req === 'number' ? req : Number(req)
      if (Number.isFinite(v)) return v
    }
    return waitBudgetS(nLines * lineTimeS * 2, FULL_SCAN_WAIT_FLOOR_S)
  }

  /** `Scan_BufferGet` 问行数。读不到就 `null`，调用方回落到 512 —— 只影响预算。 */
  async #readScanLines(): Promise<number | null> {
    const rec = await this.#ctx.safeCall('Scan_BufferGet')
    this.#calls.push('Scan_BufferGet')
    if (rec.error !== undefined && rec.error !== '') return null
    const buf = parseBufferGet(rec.values ?? [])
    const n = buf?.lines ?? null
    return typeof n === 'number' && n > 0 ? n : null
  }

  /**
   * 撞针检查探哪几路 = **真正采到的那几路**，从 `Scan_BufferGet` 读。
   *
   * 静态的 `[0, 14]` 把 14 写死成「Z」，而 Z-controller 的信号号随装机变
   * （标准模拟器上是 **30**）—— 于是探针打在「通道 #14 不在采集清单里」上，读失败，
   * 撞针检查在**每一次扫描**上报 `skipped`（2026-06-29）。读不到就回落到静态清单。
   */
  async #crashChannels(): Promise<number[]> {
    const rec = await this.#ctx.safeCall('Scan_BufferGet')
    this.#calls.push('Scan_BufferGet')
    if (rec.error === undefined || rec.error === '') {
      // 刻意用 `channelIdsFromBuffer` 这个原语而不是 `parseBufferGet`：撞针检查只要
      // 通道，不该因为回包里 pixels/lines 缺位就退回硬编码探针列表。
      const ids = channelIdsFromBuffer(rec.values ?? [])
      if (ids.length > 0) return ids
    }
    return [...DEFAULT_CRASH_CHANNELS]
  }

  /** 一路的正扫数据，拉平。读不到 / 没有可用采样都是 `null`。 */
  async #grabChannel(channel: number): Promise<ChannelSamples> {
    const rec = await this.#ctx.safeCall('Scan_FrameDataGrab', channel, 1)
    this.#calls.push('Scan_FrameDataGrab')
    if (rec.error !== undefined && rec.error !== '') return { channel, samples: null }
    // `shape2d` 不给 ⇒ 拉平成一维。撞针判据是**全帧**的极差与 NaN，不看形状。
    const flat = parseFrameGrab(rec.values ?? []) as number[] | null
    if (flat === null || flat.length === 0) return { channel, samples: null }
    return { channel, samples: flat }
  }

  #plan(lineTimeS: number, waitTimeoutS: number): CompositeStep[] {
    const centerX = this.#params['center_x_m']
    const centerY = this.#params['center_y_m']
    const width = num(this.#params['width_m'])
    const height = this.#params['height_m']
    const channels = this.#params['channels']

    const cfg: Record<string, unknown> = {
      center_x_m: centerX,
      center_y_m: centerY,
      width_m: width,
      height_m: height,
    }
    if (typeof channels === 'string' && channels !== '') cfg['channels'] = channels

    // 200 nm/s 是 `line_time <= 0` 时的兜底速度（旧仓同值）。`resolveLineTime` 的
    // 下界保证走不到它，留着是因为那个除法的分母还是它。
    const scanSpeed = lineTimeS > 0 ? width / lineTimeS : 200e-9

    return [
      { stepId: 'configure', skillName: 'ConfigureScan', params: cfg, optional: false, checkpointAfter: false, tags: ['setup'] },
      {
        stepId: 'set_speed',
        skillName: 'SetScanSpeed',
        params: {
          fwd_speed: scanSpeed,
          bwd_speed: scanSpeed,
          fwd_line_time: lineTimeS,
          bwd_line_time: lineTimeS,
          keep_const: 0,
        },
        optional: false,
        checkpointAfter: false,
        tags: ['setup'],
      },
      { stepId: 'start_scan', skillName: 'StartScan', params: {}, optional: false, checkpointAfter: false, tags: ['scan'] },
      {
        stepId: 'wait_scan',
        skillName: 'WaitScanComplete',
        params: { timeout_ms: Math.trunc(waitTimeoutS * 1000) },
        optional: false,
        checkpointAfter: true,
        tags: ['wait'],
      },
    ]
  }

  #onStepResult(step: CompositeStep, res: StepResult): void {
    if (step.stepId !== 'wait_scan') return
    const data = (res.data ?? {}) as Record<string, unknown>
    // `WaitScanComplete` 在**每一种**扫描结束方式上都报 success —— 超时、扫完、以及
    // 中途被停下。三种都要提上来，否则「用户在 24 % 处按了 Stop」在这里与「这一帧
    // 做完了」长得一模一样。
    this.#ex.setPartial('wait_timed_out', data['timed_out'] === true)
    this.#ex.setPartial('wait_stopped_early', data['stopped_early'] === true)
    this.#ex.setPartial('wait_outcome', String(data['outcome'] ?? ''))
    for (const key of ['lines_done', 'lines_total']) {
      const v = data[key]
      this.#ex.setPartial(`scan_${key}`, typeof v === 'number' ? Math.trunc(v) : null)
    }
    this.#ex.setPartial('scan_lines_verified', data['lines_verified'] === true)
  }

  #aggregate(): Record<string, unknown> {
    const pd = this.#ex.progress.partialData
    return {
      center_x_m: pd['center_x_m'] ?? null,
      center_y_m: pd['center_y_m'] ?? null,
      width_m: pd['width_m'] ?? null,
      height_m: pd['height_m'] ?? null,
      line_time_s: pd['line_time_s'] ?? null,
      // "ok" | "skipped" | "crash" —— 绝不悄悄把「读不到」说成「看着没事」
      crash_check: pd['crash_check'] ?? null,
      crash_check_channels: pd['crash_check_channels'] ?? null,
      // 等待怎么收的场，以及证据。**成功路径上也带**：「512/512 行,verified」
      // 才让一个干净的结果成为一句**核过的**断言，而不是一句假定。
      wait_outcome: pd['wait_outcome'] ?? null,
      scan_lines_done: pd['scan_lines_done'] ?? null,
      scan_lines_total: pd['scan_lines_total'] ?? null,
      scan_lines_verified: pd['scan_lines_verified'] ?? null,
    }
  }

  async run(): Promise<SkillResultLike> {
    const centerX = this.#centerX
    const centerY = this.#centerY
    const { lineTimeS } = this.#lineTime()

    // ⑫ 撞针状态机的**问**这一侧。拒绝在这里发生，**没有降级路径**。
    const escape = crashGuard(centerX, centerY, (kind, d) => this.#ctx.markers.emit(kind, d))
    if (escape !== null) {
      return {
        success: false,
        error: escape,
        data: { repeated_crash: true, center_x_m: centerX, center_y_m: centerY },
      }
    }

    // **一次**读回真实分辨率，用来估等待预算（不是假设 512 行）。只有调用方没钉
    // `wait_timeout_s` 时才需要问。
    let nLines = ASSUMED_LINES
    if (this.#params['wait_timeout_s'] === undefined || this.#params['wait_timeout_s'] === null) {
      nLines = (await this.#readScanLines()) ?? ASSUMED_LINES
    }
    const waitTimeoutS = this.#waitTimeoutS(lineTimeS, nLines)

    this.#ex = new GraphExecutor('FullScan', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
      onStepResult: (step, res) => this.#onStepResult(step, res),
    })
    this.#ex.setPartial('center_x_m', centerX)
    this.#ex.setPartial('center_y_m', centerY)
    this.#ex.setPartial('width_m', this.#params['width_m'])
    this.#ex.setPartial('height_m', this.#params['height_m'])
    this.#ex.setPartial('line_time_s', lineTimeS)

    const allGood = await this.#ex.runPlan(this.#plan(lineTimeS, waitTimeoutS))
    const p = this.#ex.progress

    if (!allGood) {
      return { success: false, error: p.abortedReason || 'scan aborted', data: this.#withProgress() }
    }
    if (p.partialData['wait_timed_out'] === true) {
      return { success: false, error: `Scan timed out after ${waitTimeoutS}s`, data: this.#withProgress() }
    }
    // ……扫描也可能就这么**停了**。用户按 Stop、Nanonis 自停、安全停机：状态位回 0
    // 而帧的一部分从来没采过。在这里失败正是全部要点 —— 不然这个方法下一步就要拿
    // 一堆 NaN 行去做撞针检查、然后报一张干净的图，而调用方会存盘并往下走。
    // （2026-08-04：观测到停在 24 %，没有产出文件。）
    if (p.partialData['wait_stopped_early'] === true) {
      const done = p.partialData['scan_lines_done']
      const total = p.partialData['scan_lines_total']
      const where = done !== null && done !== undefined && total ? `${done}/${total} 行` : '行数未知'
      return {
        success: false,
        error:
          `扫描中途停止(${where}),这一帧没有扫完。可能是用户按了 Stop、` +
          `Nanonis 自行停止,或安全停机。不要把这一帧当作完整图像使用。`,
        data: { stopped_early: true, ...this.#withProgress() },
      }
    }

    // ── 扫完之后判撞针 ──────────────────────────────────────────────────
    const samples: ChannelSamples[] = []
    for (const ch of await this.#crashChannels()) {
      samples.push(await this.#grabChannel(ch))
    }
    const verdict = crashVerdict(samples)
    this.#ex.setPartial('crash_check', verdict.status)
    this.#ex.setPartial('crash_check_channels', verdict.perChannel)

    if (verdict.crashIndicator) {
      // ⑫ 在扫描中心记这一次。区域一旦撞满阈值，**把逃逸指令现在就说出来** ——
      // 下一次调用会被 `crashGuard` 拒掉，但别让它再撞第三次才听见这句话。
      const count = getTipCrashTracker().recordCrash(centerX, centerY)
      const repeated = getTipCrashTracker().isBlocked(centerX, centerY)
      const base =
        `CRASH_DETECTED: scan data on channel ${verdict.crashChannel} ` +
        `has near-zero variance or NaN`
      return {
        success: false,
        error: repeated ? `${base}\n${crashEscapeMessage(count, centerX, centerY)}` : base,
        data: {
          crash_indicator: true,
          data_range: verdict.dataRange,
          crash_channel: verdict.crashChannel,
          repeated_crash: repeated,
          ...this.#withProgress(),
        },
      }
    }

    // 这个区域扫干净了 —— 针尖在这儿是好的。把旧的撞针计数清掉，
    // 免得一次早已解决的撞针永远挡着一个好点。
    getTipCrashTracker().noteRecovery(centerX, centerY)
    return { success: true, data: this.#withProgress() }
  }

  #withProgress(): Record<string, unknown> {
    return { ...this.#aggregate(), _progress: progressToDict(this.#ex.progress) }
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export const FullScan: Skill = {
  spec: S.FullScanSpec,
  execute: (ctx, params) => new Full(ctx, params).run(),
}
