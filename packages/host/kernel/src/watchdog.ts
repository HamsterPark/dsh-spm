/**
 * 针尖看门狗的判定核心 —— 逐字移植 `mast/core/watchdog.py` 的 `SafetyWatchdog`。
 * **零 I/O**：读数、阈值、抑制状态全部由调用方每 tick 喂进来，所以能被金样逐步驱动。
 *
 * 这是整棵树上**唯一一条会自己动手保护针尖的路**（其余都是拒绝型防护）。
 * 判据：滑动窗口内**每一个**读数都超阈值 ⇒ 退针。窗口 = 8 × 0.5 s = **连续 4 秒**。
 *
 * ## 2026-08-10：它武装着，但打不着火
 *
 * 那天一次真实撞针，电流贴轨在 **10.0 nA**、Z 顶在量程上限、连续 20 个采样 17 位有效
 * 数字完全相同。**看门狗没响。** 因为启动时没传阈值，吃了写死的默认 100 nA——比实际
 * 的轨高一个数量级。而同一个物理量在树里有两个数：一个在设置里被标定过，
 * 一个写死在看门狗里从不暴露。**被标定的那个没握着执行器，没标定的那个握着。**
 *
 * 所以这里**没有自己的数**：阈值每 tick 由调用方现读（`resolveThreshold` 的五级阶梯），
 * 读不到时**绝不静默回退**——每一级降级都要说话。
 * `spec/golden/watchdog.json` 的 `threshold_getter_raises` 一条就是那次事故的复现：
 * 阈值退到出厂默认 90 nA，而轨在 10 nA ⇒ **fired = 0**。
 *
 * ## 抑制为什么是活谓词，不是配对的 disable/enable
 *
 * 蓄意扎针期间电流本来就该贴轨，而扎针可以持续到 10 秒 > 窗口的 4 秒。所以必须知道
 * 「现在是不是我们自己在故意动针尖」。**配对调用有一个致命形状**：某条路径抛异常、
 * 提前 return、或者忘了写 finally ⇒ **安全网静默地永久关闭**，而从外面看和武装着
 * 一模一样。活谓词不可能卡住：令牌一还，下一 tick 就恢复。
 *
 * 抑制期间**清空窗口** ⇒ 恢复后要重新攒满才可能开火，这就是天然的 4 秒余波期，
 * 不需要再加一个旋钮。
 */

/** 一次 tick 的输入。全部由调用方现读——这一层不碰任何 I/O。 */
export interface WatchdogTick {
  /** 电流读数（安培）。`null` = 没读到或形状不对 ⇒ **跳过这一 tick，窗口保留**。 */
  readonly current: number | null
  /** 本 tick 生效的阈值（安培）。`null` = 解析不出来 ⇒ 本 tick 不判（下 tick 再试）。 */
  readonly threshold: number | null
  /** 正在进行的蓄意针尖动作的名字；空/缺席 = 没有。非空 ⇒ 抑制并清窗。 */
  readonly suppressedBy?: string | undefined
  /**
   * MAST 此刻是不是在驱动仪器。**缺席（`undefined`）⇒ 视为 `true`（照常武装）**。
   * 这个失败方向是刻意的：读不清就武装，不是「读不清就闭嘴」。
   */
  readonly mastDriving?: boolean | undefined
}

export type WatchdogOutcome =
  /** 蓄意针尖动作期间：不判，窗口已清空。 */
  | { readonly kind: 'suppressed'; readonly by: string }
  /** 阈值解析不出来：本 tick 不判。**不是静默失效**——调用方要喊。 */
  | { readonly kind: 'no-threshold' }
  /** 读不到 / 形状不对：跳过，窗口保留（**绝不塞 0 占位**）。 */
  | { readonly kind: 'skipped' }
  /** 一切正常（窗口没满，或有读数低于阈值）。 */
  | { readonly kind: 'quiet' }
  /** 贴轨了，但判定为**人工操作**：记录，不退针。这个判定自己会过期。 */
  | { readonly kind: 'human'; readonly heldMs: number }
  /** 贴轨且该退针，但上一次退针没确认、还在冷却中。 */
  | { readonly kind: 'cooling'; readonly heldMs: number }
  /** 闩已上（上一次退针确认过），此后不再开火，直到 `reset()`。 */
  | { readonly kind: 'latched' }
  /** **开火**：调用方去退针，然后必须调 `confirmRetract(...)` 告诉我们成没成。 */
  | {
      readonly kind: 'fire'
      readonly heldMs: number
      readonly threshold: number
      readonly readings: readonly number[]
    }

export interface WatchdogConfig {
  /** 窗口里要有几个读数。默认 8。 */
  readonly windowSize?: number
  /** 采样周期（毫秒）。默认 500。窗口时长 = 两者相乘。 */
  readonly intervalMs?: number
  /** 退针没确认时，隔多久才允许再试。默认 30 秒。 */
  readonly retriggerCooldownMs?: number
  /** 贴轨持续超过这么久就**不再按人工处理**。默认 20 秒。 */
  readonly humanRailOverrideMs?: number
  /** 注入时钟（毫秒）。测试要确定性。 */
  readonly clock?: () => number
}

export class TipWatchdog {
  private readonly windowSize: number
  private readonly intervalMs: number
  private readonly retriggerCooldownMs: number
  private readonly humanRailOverrideMs: number
  private readonly clock: () => number

  private readonly buffer: number[] = []
  /** 当前这一段连续贴轨是什么时候开始的；没在贴轨就是 `null`。 */
  private railSince: number | null = null
  private lastTriggerAt: number | null = null
  private latchedFlag = false

  constructor(config: WatchdogConfig = {}) {
    this.windowSize = config.windowSize ?? 8
    this.intervalMs = config.intervalMs ?? 500
    this.retriggerCooldownMs = config.retriggerCooldownMs ?? 30_000
    this.humanRailOverrideMs = config.humanRailOverrideMs ?? 20_000
    this.clock = config.clock ?? (() => Date.now())
  }

  /** 窗口时长：连续这么久全部超阈值才开火。 */
  get windowMs(): number {
    return this.windowSize * this.intervalMs
  }

  /** 闩上了吗。上闩 = 一次**确认过的**退针之后，停止监视直到 `reset()`。 */
  get latched(): boolean {
    return this.latchedFlag
  }

  /** 当前窗口里的读数（只读，给遥测与开火时的证据）。 */
  get readings(): readonly number[] {
    return this.buffer
  }

  /** 跑一个 tick。**永不抛**。 */
  tick(input: WatchdogTick): WatchdogOutcome {
    const by = input.suppressedBy
    if (by !== undefined && by !== '') {
      // 清窗 ⇒ 恢复后要重新攒满，这就是余波期
      this.buffer.length = 0
      this.railSince = null
      return { kind: 'suppressed', by }
    }

    const threshold = input.threshold
    if (threshold === null) return { kind: 'no-threshold' }

    if (input.current === null) {
      // **绝不往窗口里塞占位值**。一个假的 0 永远低于阈值，会冲淡「全部超阈」这个
      // 判据，从而延迟甚至掩盖一次真的撞针过流。跳过这一 tick，窗口只留有效读数。
      return { kind: 'skipped' }
    }

    this.buffer.push(Math.abs(input.current))
    if (this.buffer.length > this.windowSize) this.buffer.shift()

    const railed =
      this.buffer.length >= this.windowSize && this.buffer.every((v) => v > threshold)
    if (!railed) {
      this.railSince = null
      return { kind: 'quiet' }
    }

    const now = this.clock()
    if (this.railSince === null) this.railSince = now
    const heldMs = Math.max(0, now - this.railSince)

    // 现在动仪器的是人吗？操作员在 Nanonis 面板上手动修针时 MAST 一条命令都不发，
    // 而他扎针打出来的贴轨和撞针长得一样。在他手里把针拔走的系统，他会直接关掉。
    // **但这是推断**（「MAST 安静」不等于「有人在操作」），所以它自己会过期：
    // 持续显著超过人工扎针上界的贴轨，是「不是人在扎针」的正面证据。
    const mastDriving = input.mastDriving ?? true
    if (!mastDriving && heldMs < this.humanRailOverrideMs) {
      return { kind: 'human', heldMs }
    }

    if (this.latchedFlag) return { kind: 'latched' }
    const last = this.lastTriggerAt
    if (last !== null && now - last < this.retriggerCooldownMs) {
      return { kind: 'cooling', heldMs }
    }

    this.lastTriggerAt = now
    return { kind: 'fire', heldMs, threshold, readings: [...this.buffer] }
  }

  /**
   * 退针的结果。**只有确认过的退针才上闩。**
   *
   * 没确认就上闩的话，一次失败的退针会把这张网**整个 session 永久解除武装**
   * （2026-07-03 复查）。所以没确认时闩保持清空，靠冷却让我们过一会儿重试，
   * 而不是每 tick 刷屏。
   */
  confirmRetract(confirmed: boolean): void {
    if (confirmed) this.latchedFlag = true
  }

  /** 恢复：清闩、清窗。人确认现场安全之后才该调。 */
  reset(): void {
    this.latchedFlag = false
    this.buffer.length = 0
    this.railSince = null
    this.lastTriggerAt = null
  }
}

// ── 阈值阶梯 ────────────────────────────────────────────────────────────────

/** 阈值是从哪一级拿到的。**每一次降级都要说话**——静默回退正是 2026-08-10 的本体。 */
export type ThresholdLevel = 'fixed' | 'live' | 'last-good' | 'shipped' | 'none'

export interface ThresholdResult {
  readonly value: number | null
  readonly level: ThresholdLevel
  /** 是否处在降级态。只在**边沿**为真一次，供调用方决定说不说话（不刷屏）。 */
  readonly changed: boolean
}

export interface ThresholdLadderConfig {
  /** 固定值。**只给测试与显式覆盖**——生产路径上写死一个数正是那次事故的成因。 */
  readonly fixed?: number | undefined
  /** 出厂默认。读不到活值也没有历史好值时的最后一档。 */
  readonly shipped?: number | undefined
}

/**
 * 五级阶梯：固定值 → 活值 → 上次的好值 → 出厂默认 → 放弃（本 tick 不判）。
 *
 * `lookup(name) || DEFAULT` 那个形状——名字写错就得到一个**能跑的错版本**——
 * 正是这次事故的本体，修的时候不能把它再种一次。
 */
export class ThresholdLadder {
  private lastGood: number | null
  private degraded = false
  private readonly shipped: number | undefined
  private readonly fixed: number | undefined

  constructor(config: ThresholdLadderConfig = {}) {
    this.fixed = config.fixed
    this.shipped = config.shipped
    this.lastGood = config.fixed ?? null
  }

  /** `read` 现读一次活值；抛或返回非正/非有限值都算读不到。 */
  resolve(read: (() => number) | undefined): ThresholdResult {
    if (this.fixed !== undefined) return { value: this.fixed, level: 'fixed', changed: false }

    if (read !== undefined) {
      let v: number
      try {
        v = Number(read())
      } catch {
        v = Number.NaN
      }
      if (Number.isFinite(v) && v > 0) {
        const changed = this.degraded
        this.degraded = false
        this.lastGood = v
        return { value: v, level: 'live', changed }
      }
    }

    // ── 到这里就是降级了 ──
    const changed = !this.degraded
    this.degraded = true
    if (this.lastGood !== null) return { value: this.lastGood, level: 'last-good', changed }
    if (this.shipped !== undefined) {
      this.lastGood = this.shipped
      return { value: this.shipped, level: 'shipped', changed }
    }
    // 连出厂默认都没有 ⇒ 本 tick 不判。**这不是静默失效**：下一 tick 还会重试。
    return { value: null, level: 'none', changed }
  }
}
