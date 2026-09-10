/**
 * `ctx.stmWatchdog` —— 0.5 秒采一次隧道电流，持续贴轨就退针；外加人可以按的 `/estop`。
 *
 * 判据全在 `dsh-spm-kernel` 的 `TipWatchdog`（零 I/O、金样驱动）。这一层只做接线：
 * **从哪读**（`ctx.instrument` 的 monitor 角色）、**多久读一次**（0.5 s）、
 * **开火了做什么**（`emergencyRetract`）、**怎么停**（`ctx.effect` 回滚）。
 *
 * 四处刻意的选择：
 *
 * 1. **看门狗自己去读 `Current_Get`，不复用 1 Hz 状态缓存。** 它要 0.5 s 一次，
 *    而且这条路要尽可能短——多经过一层缓存就多一处可能卡住的地方。与 Python 同构。
 * 2. **`countHealth: false`。** 高频只读不进熔断记账（1.5/1.6 定的规则）。
 * 3. **急停闩上之后，写动词一律拒绝，只放行退针与停扫。** 闩不会自己解开——
 *    要人确认现场安全后调 `reset()`。
 * 4. **链路断（`stale`）走告警，不改提示块。** 1.8b 记下的缺口在这里补上：
 *    Python 那侧断链也是走告警，而提示块的措辞是模型读的契约，不在移植段里顺手改。
 */
import { type Context, Service, type CommandDefinition } from 'dsh-spm-compat'
import { ThresholdLadder, TipWatchdog, type WatchdogOutcome } from 'dsh-spm-kernel'
import { emergencyRetract, type EstopCall, type EstopResult } from './estop.js'
import type {} from 'dsh-spm-instrument'
import type {} from 'dsh-spm-instrument-state'

export const name = 'mast-watchdog'

/** 前置放大器满量程的**出厂默认**（安培）。与 Python 的 `cm_sat_current_a` 同源。 */
export const SHIPPED_SATURATION_A = 9e-8

export interface Config {
  /** 采样周期（毫秒）。默认 500。0 或负数 = 不自动轮询（只留 `/estop` 与手动 tick）。 */
  readonly intervalMs?: number
  /** 窗口里要有几个读数。默认 8 ⇒ 连续 4 秒。 */
  readonly windowSize?: number
  /**
   * 固定阈值（安培）。**只给测试与显式覆盖**——生产路径上写死一个数正是
   * 2026-08-10 那次「武装着却打不着火」的成因。
   */
  readonly thresholdA?: number
  /** 出厂默认阈值。活值与历史好值都没有时的最后一档。 */
  readonly shippedThresholdA?: number
}

/** 看门狗对外发的事。1.10 的 SSE hub 会把它们转成前端事件。 */
export type WatchdogEvent =
  | { readonly kind: 'fire'; readonly heldMs: number; readonly threshold: number; readonly readings: readonly number[] }
  | { readonly kind: 'estop'; readonly reason: string; readonly result: EstopResult }
  | { readonly kind: 'threshold-degraded'; readonly level: string; readonly value: number | null }
  | { readonly kind: 'stale-link'; readonly sinceTimestamp: string }
  | { readonly kind: 'reset' }

export class TipWatchdogService extends Service {
  private readonly wd: TipWatchdog
  private readonly ladder: ThresholdLadder
  private readonly listeners = new Set<(e: WatchdogEvent) => void>()
  private liveThreshold: (() => number) | undefined
  private stopped = false
  private lastStaleReported = ''

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'stmWatchdog')
    const intervalMs = config.intervalMs ?? 500
    this.wd = new TipWatchdog({
      windowSize: config.windowSize ?? 8,
      intervalMs: intervalMs > 0 ? intervalMs : 500,
    })
    this.ladder = new ThresholdLadder({
      fixed: config.thresholdA,
      shipped: config.shippedThresholdA ?? SHIPPED_SATURATION_A,
    })

    ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const loop = async (): Promise<void> => {
        await this.tick()
        if (!this.stopped) timer = setTimeout(() => void loop(), intervalMs)
      }
      if (intervalMs > 0) timer = setTimeout(() => void loop(), intervalMs)
      return () => {
        this.stopped = true
        if (timer !== undefined) clearTimeout(timer)
      }
    })

    // `/estop` —— 人按的那个。注册成命令而不是工具：**它不该经过模型**。
    ctx.effect(() =>
      ctx.commands.register({
        name: 'estop',
        description: '急停：立刻退针并闩住。闩上之后所有写动词被拒，只放行退针与停扫。',
        handler: async (): Promise<{ kind: 'success' | 'error'; text: string }> => {
          const r = await this.estop('操作员按下 /estop')
          return r.confirmed
            ? { kind: 'success', text: `已退针并闩住（经由 ${r.viaRole} 角色）。确认现场安全后用 /estop-reset 解闩。` }
            : { kind: 'error', text: `退针**没有确认**：${r.steps.map((s) => `${s.method}@${s.role}${s.error === undefined ? ' ok' : ` 失败(${s.error})`}`).join('；')}` }
        },
      } satisfies CommandDefinition as CommandDefinition),
    )
  }

  /** 闩上了吗。上闩 = 一次确认过的退针之后。 */
  get latched(): boolean {
    return this.wd.latched
  }

  /** 接一个「现读阈值」的活值来源。1.10 的设置卡落地后由它接上 `cm_sat_current_a`。 */
  useThresholdSource(read: () => number): () => void {
    this.liveThreshold = read
    return () => {
      this.liveThreshold = undefined
    }
  }

  onEvent(fn: (e: WatchdogEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 跑一个 tick：读电流、判、必要时退针。**永不抛**。 */
  async tick(): Promise<WatchdogOutcome> {
    if (this.stopped) return { kind: 'skipped' }

    const t = this.ladder.resolve(this.liveThreshold)
    if (t.changed) {
      this.emit({ kind: 'threshold-degraded', level: t.level, value: t.value })
    }

    const rec = await this.ctx.instrument.call('Current_Get', [], {
      role: 'monitor',
      countHealth: false,
    })
    const raw = rec.error === undefined ? rec.values?.[0] : undefined
    const current = typeof raw === 'number' && Number.isFinite(raw) ? raw : null

    this.reportStaleLink()

    const out = this.wd.tick({ current, threshold: t.value })
    if (out.kind === 'fire') {
      this.emit({ kind: 'fire', heldMs: out.heldMs, threshold: out.threshold, readings: out.readings })
      const r = await this.retract(`隧道电流连续 ${(out.heldMs / 1000).toFixed(1)} s 超过 ${out.threshold.toExponential(2)} A`)
      this.wd.confirmRetract(r.confirmed)
    }
    return out
  }

  /** 人或上层主动急停。与看门狗开火走**同一条**退针路径。 */
  async estop(reason: string): Promise<EstopResult> {
    const r = await this.retract(reason)
    this.wd.confirmRetract(r.confirmed)
    return r
  }

  /** 解闩。**要人确认现场安全之后才该调**——所以不给模型，只给命令与 UI。 */
  reset(): void {
    this.wd.reset()
    this.emit({ kind: 'reset' })
  }

  private async retract(reason: string): Promise<EstopResult> {
    const call: EstopCall = (method, args, role) =>
      this.ctx.instrument.call(method, args, {
        role,
        lockTimeoutMs: 2_000,
        countHealth: false,
      })
    const result = await emergencyRetract(call)
    this.emit({ kind: 'estop', reason, result })
    return result
  }

  /**
   * 1.8b 记下的缺口：链路断了的时候提示块里一个字都不提。补在这里而不是改提示块——
   * 提示块的措辞是模型读的契约，而「链路断了」本来就该走告警（Python 同构）。
   */
  private reportStaleLink(): void {
    const s = this.ctx.instrumentState?.snapshot()
    if (s === undefined) return
    if (s.stale && s.timestamp !== this.lastStaleReported) {
      this.lastStaleReported = s.timestamp
      this.emit({ kind: 'stale-link', sinceTimestamp: s.timestamp })
    } else if (!s.stale) {
      this.lastStaleReported = ''
    }
  }

  private emit(e: WatchdogEvent): void {
    for (const fn of this.listeners) fn(e)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new TipWatchdogService(ctx, config)
}

/**
 * `instrumentState` 也列进 `inject`：告警要读 `stale`。少了它看门狗照样能退针，
 * 但**断链再也没人喊**——又是一个安静的安全回退。宁可整个不装。
 */
export const inject = ['instrument', 'instrumentState', 'commands']

export const watchdogProvider = { name, inject, apply }

declare module '@deepseek-ai/cordis' {
  interface Context {
    stmWatchdog: TipWatchdogService
  }
}
