/**
 * Nanonis TCP 链路的通信熔断器。逐条移植自旧仓 `mast/core/comms_health.py`。
 *
 * **为什么存在**（旧仓 docstring 里的现场记录，trace 5305868e s82–130）：链路断掉时，
 * 每一次硬件读写都**各自**超时 5 秒才放弃。那次追踪里 GetBias → GetCurrent →
 * GetZPosition → SetBias → ZControllerOnOff 逐个抛 `TimeoutError`——**十九次各约 5 秒的停顿**，
 * 一个工具一个工具地撞，约 90 秒里操作员只能看着系统对着一个死 socket 磕头。
 * 而且反复强连重连会**把脆弱的 Nanonis 端口撞到要重启 Nanonis 才能恢复**。
 *
 * 熔断器只做一件事：**决定一次调用能不能被尝试**，它自己从不发命令。
 * 链路死了的时候「快速失败并报告」严格优于「每条命令挂 5 秒」——因为停机/退针命令
 * 本来也到不了一台不答 TCP 的 Nanonis。
 *
 * **只观察 TCP 级失败**：超时、连接错误、重连失败。**Nanonis 返回的应用错误串算成功**——
 * 那意味着这一次往返**成功了**，只是仪器说「这个模块没加载」。一次合法地去戳未加载模块的
 * 运行不该把链路熔断掉。（1.4 的集成测试已经证实：未实现的动词回错误段且连接还活着。）
 *
 * 纯状态机：注入时钟、零 I/O、零 dsh。四个角色共用**一个**实例（PLAN §7.1）。
 */

export const CLOSED = 'closed'
export const OPEN = 'open'
export const HALF_OPEN = 'half_open'
export type BreakerState = typeof CLOSED | typeof OPEN | typeof HALF_OPEN

/** 连续多少次 TCP 失败开闸。短阈值 = 早点停手，对脆弱端口更友好。 */
export const FAIL_THRESHOLD = 3
/** 开闸后多久放一次探针。够长，免得对着死端口每几百毫秒重探一次。 */
export const OPEN_COOLDOWN_S = 20
/** 比这更早的失败不算「连续」——慢速滴漏的失败永远不该攒成一次熔断。 */
export const STREAK_WINDOW_S = 30

export interface BreakerOptions {
  readonly failThreshold?: number
  readonly openCooldownS?: number
  readonly streakWindowS?: number
  /** 单调秒。默认 `performance.now()/1000`；测试注入假时钟。 */
  readonly clock?: () => number
}

export interface BreakerSnapshot {
  readonly state: BreakerState
  readonly streak: number
  readonly failThreshold: number
  readonly cooldownRemainingS: number
  readonly trippedTotal: number
  readonly lastReason: string
}

export class CommsCircuitBreaker {
  private readonly failThreshold: number
  private readonly openCooldownS: number
  private readonly streakWindowS: number
  private readonly clock: () => number

  private streak = 0
  private lastFailAt = 0
  private openUntil = 0
  private probeInFlight = false
  private trippedTotal = 0
  private lastReason = ''

  constructor(opts: BreakerOptions = {}) {
    this.failThreshold = Math.max(1, Math.trunc(opts.failThreshold ?? FAIL_THRESHOLD))
    this.openCooldownS = opts.openCooldownS ?? OPEN_COOLDOWN_S
    this.streakWindowS = opts.streakWindowS ?? STREAK_WINDOW_S
    this.clock = opts.clock ?? (() => performance.now() / 1000)
  }

  /** 状态是**推导**出来的，不是存的——存一份就多一处可能与 streak/openUntil 不一致。 */
  state(): BreakerState {
    if (this.streak < this.failThreshold) return CLOSED
    if (this.probeInFlight) return HALF_OPEN
    if (this.clock() >= this.openUntil) return HALF_OPEN // 冷却已过，下一次 allow() 就是探针
    return OPEN
  }

  isOpen(): boolean {
    return this.state() === OPEN
  }

  /**
   * 现在能不能**尝试**一次调用。
   *
   * CLOSED → 恒真。OPEN → 冷却期内恒假；冷却过了**只放一个**探针进去
   * （放行的同时置 `probeInFlight`，其余调用一律挡住，直到那个探针用
   * `recordSuccess`/`recordFailure` 报回来）。
   */
  allow(): boolean {
    if (this.streak < this.failThreshold) return true
    if (this.probeInFlight) return false // 已经有探针在外面，别再放
    if (this.clock() >= this.openUntil) {
      this.probeInFlight = true
      return true
    }
    return false
  }

  /** 一次 TCP 往返完成了——**哪怕 Nanonis 回的是应用错误**。清零并关闸。 */
  recordSuccess(): void {
    this.streak = 0
    this.lastFailAt = 0
    this.openUntil = 0
    this.probeInFlight = false
    this.lastReason = ''
  }

  /** TCP 级失败：超时 / 连接错误 / 重连失败。1.4 的 `RoleLinkError.kind` 决定该不该调这里。 */
  recordFailure(reason = ''): void {
    const now = this.clock()
    if (this.streak > 0 && now - this.lastFailAt > this.streakWindowS) {
      this.streak = 1 // 上一批太老，算不上「连续」——重新起一段，慢速滴漏永远不触发
    } else {
      this.streak += 1
    }
    this.lastFailAt = now
    this.lastReason = String(reason ?? '').slice(0, 200)
    const wasProbe = this.probeInFlight
    this.probeInFlight = false
    if (this.streak >= this.failThreshold) {
      // 探针失败要**重新武装整段冷却**，不是接着原来那段走
      if (this.openUntil <= now || wasProbe) this.trippedTotal += 1
      this.openUntil = now + this.openCooldownS
    }
  }

  cooldownRemainingS(): number {
    if (this.streak < this.failThreshold) return 0
    return Math.max(0, this.openUntil - this.clock())
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state(),
      streak: this.streak,
      failThreshold: this.failThreshold,
      cooldownRemainingS:
        this.streak >= this.failThreshold
          ? Math.round(Math.max(0, this.openUntil - this.clock()) * 100) / 100
          : 0,
      trippedTotal: this.trippedTotal,
      lastReason: this.lastReason,
    }
  }
}

/**
 * 短路时回给模型的话。**逐字来自旧仓**（`COMMS_DOWN_MESSAGE`）。
 *
 * 它必须明说「别逐个工具重试，立刻停手并 handoff」——熔断存在的全部意义就是终结
 * 那场一个工具一个工具的磕头行军。这类**模型会读到的钉住短语**将来集中到
 * `messages.ts`（PLAN §3.2-16），现在先跟着状态机放。
 */
export function formatCommsDown(breaker: CommsCircuitBreaker): string {
  const snap = breaker.snapshot()
  const cd = snap.cooldownRemainingS || OPEN_COOLDOWN_S
  return (
    `comms_circuit_open: Nanonis TCP 通信连续超时(≥${snap.failThreshold} 次)已熔断,暂停发命令 ` +
    `~${Math.round(cd)}s 以免反复重连撞坏脆弱的 Nanonis 端口。通信已判定中断——请勿逐个工具` +
    `重试,应立即停止硬件操作、向操作员/上层报告并 handoff,等待连接恢复后再继续。`
  )
}
