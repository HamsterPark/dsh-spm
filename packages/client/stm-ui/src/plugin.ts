/**
 * `ctx.mastEvents` —— `/mast/events` SSE hub 与 `/mast/events/snapshot`。
 *
 * 这是 U0 的宿主面：**全局高频易失状态的唯一出口**（决策 D7）。
 * 生产者是仪器那边的服务（1 Hz 状态缓存、看门狗），消费者是客户端的右栏卡。
 * 两边互不知道对方，只认这条通道——这就是「能力接缝」的形状。
 *
 * 为什么用 SSE 而不是 WebSocket：`EventSource` **自带重连**，而且断线重连时会自动
 * 把上次的 `id:` 放进 `Last-Event-ID` 请求头。续传不需要客户端记任何东西，
 * 也不依赖 WS upgrade 能不能用（PLAN §9.2 的退路是轮询 `/snapshot`，
 * 但有了 SSE 就用不上）。
 */
import { type Context, Service } from 'dsh-spm-compat'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventRing, formatSse, parseSince, type MastEvent, type MastEventType } from './events.js'
import type {} from 'dsh-spm-instrument-state'
import type {} from 'dsh-spm-instrument-watchdog'

export const name = 'mast-ui-host'

export interface Config {
  /** 环里留多少条重放。默认 100。 */
  readonly capacity?: number
  /** 心跳周期（毫秒）。默认 15 秒——中间的代理会掐掉长时间没数据的连接。 */
  readonly heartbeatMs?: number
  /** 路由前缀。默认 `/mast/events`。 */
  readonly path?: string
}

interface Client {
  readonly res: ServerResponse
  /** 这条连接已经写出去的最后一个 seq，用来判「它跟上了没有」。 */
  lastWritten: number
}

export class MastEventsService extends Service {
  private readonly ring: EventRing
  private readonly clients = new Set<Client>()
  private readonly heartbeatMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mastEvents')
    this.ring = new EventRing({ capacity: config.capacity ?? 100 })
    this.heartbeatMs = config.heartbeatMs ?? 15_000
    const base = config.path ?? '/mast/events'

    // prefix 路由：`/mast/events` 与 `/mast/events/snapshot` 都落在这儿
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'prefix',
        path: base,
        handler: (req, res) => {
          const path = (req.url ?? '').split('?')[0] ?? ''
          if (path.endsWith('/snapshot')) return this.serveSnapshot(res)
          return this.serveStream(req, res)
        },
      }),
    )

    // 心跳：中间的代理会掐掉长时间没数据的连接，注释行是 SSE 规范里的合法保活
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const c of this.clients) c.res.write(': ping\n\n')
      }, this.heartbeatMs)
      return () => clearInterval(timer)
    })

    // 关服务时把连接收干净——不收的话进程退不出去
    ctx.effect(() => () => {
      for (const c of this.clients) c.res.end()
      this.clients.clear()
    })

    this.wireProducers(ctx)
  }

  /** 发一条事件给所有在线客户端，并进环。**超限会抛**（帧里只放指针与标量）。 */
  emit(type: MastEventType, data: Readonly<Record<string, unknown>>): MastEvent {
    const e = this.ring.push(type, data)
    const frame = formatSse(e)
    for (const c of this.clients) {
      c.res.write(frame)
      c.lastWritten = e.seq
    }
    return e
  }

  /** 在线连接数（给自检与测试）。 */
  get clientCount(): number {
    return this.clients.size
  }

  get lastSeq(): number {
    return this.ring.lastSeq
  }

  private serveStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 反向代理的缓冲会把「实时」变成「攒一批再给」，这一行是关它的通用开关
      'x-accel-buffering': 'no',
    })
    const since = parseSince(req.headers['last-event-id'], req.url)
    const client: Client = { res, lastWritten: since }
    this.clients.add(client)

    for (const e of this.ring.since(since)) {
      res.write(formatSse(e))
      client.lastWritten = e.seq
    }
    res.write(': open\n\n') // 让客户端立刻知道连上了，不用等第一条数据

    const drop = (): void => void this.clients.delete(client)
    req.on('close', drop)
    req.on('error', drop)
  }

  private serveSnapshot(res: ServerResponse): void {
    // 降级轮询用的：一次性给「现在是什么样」+ 当前 seq，让客户端能接着往下续
    const state = this.ctx.instrumentState?.snapshot()
    const body = JSON.stringify({
      lastSeq: this.ring.lastSeq,
      oldestSeq: this.ring.oldestSeq,
      hardwareState: state ?? null,
      latched: this.ctx.stmWatchdog?.latched ?? null,
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(body)
  }

  /**
   * 把生产者接上来。**只放标量与指针**——`hardware_state` 那一帧是十几个数字，
   * 图像与长文本永远走引用。
   */
  private wireProducers(ctx: Context): void {
    ctx.effect(() =>
      ctx.instrumentState.onChanged((s) => {
        this.emit('hardware_state', {
          t: s.timestamp,
          stale: s.stale,
          bias_v: s.bias_v,
          current_a: s.current_a,
          z_pos_m: s.z_pos_m,
          x_pos_m: s.x_pos_m,
          y_pos_m: s.y_pos_m,
          setpoint_a: s.setpoint_a,
          z_controller_on: s.z_controller_on,
          z_controller_status: s.z_controller_status,
          scan_running: s.scan_running,
          withdrawn: s.withdrawn,
        })
      }),
    )

    ctx.effect(() =>
      ctx.stmWatchdog.onEvent((e) => {
        switch (e.kind) {
          case 'fire':
            // 只发标量：读数数组是证据，但它长度固定、都是数字，进得来
            this.emit('current_monitor', { heldMs: e.heldMs, threshold: e.threshold, n: e.readings.length })
            break
          case 'estop':
            this.emit('estop_latch', {
              reason: e.reason,
              confirmed: e.result.confirmed,
              viaRole: e.result.viaRole,
            })
            break
          case 'threshold-degraded':
            this.emit('safety', { what: 'threshold', level: e.level, value: e.value })
            break
          case 'stale-link':
            this.emit('alert', { what: 'stale-link', since: e.sinceTimestamp })
            break
          case 'reset':
            this.emit('estop_latch', { reason: 'reset', confirmed: false, viaRole: null })
            break
        }
      }),
    )
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new MastEventsService(ctx, config)
}

/**
 * `webServer` 是硬依赖（没有它就没有通道）；两个生产者也是——
 * 少了它们这条通道**空转**：连得上、有心跳、永远没数据。那比连不上更难查。
 */
export const inject = ['webServer', 'instrumentState', 'stmWatchdog']

export const mastUiHostProvider = { name, inject, apply }

declare module '@deepseek-ai/cordis' {
  interface Context {
    mastEvents: MastEventsService
  }
}
