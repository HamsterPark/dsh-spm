/**
 * SSE hub 的测试。**起一个真的 `WebServer`，用真 HTTP 请求打它**——
 * 这一段要证明的正是「dsh 的 webServer 能不能 hold 住响应做流式」（spike 第 9 条），
 * 拿替身验等于把要验的那件事假设掉了。
 */
import { get } from 'node:http'
import { Context, Service, WebServer } from 'dsh-spm-compat'
import { afterEach, describe, expect, it } from 'vitest'
import { EventPayloadTooLarge, EventRing, formatSse, parseSince } from './events.js'
import { mastUiHostProvider } from './plugin.js'

// 第一版这里直接 import 了 @deepseek-ai/dsh-host-webserver —— **被我们自己的防腐层规则挡了**。
// 正确做法是从 compat 拿：那道墙的意义就是「上游 API 一漂只有一个文件变红」，
// 测试文件也不例外。

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakeState extends Service {
  private fns = new Set<(s: unknown) => void>()
  snap = { timestamp: 'T0', stale: false, bias_v: 1.5, current_a: 1e-10 }
  constructor(ctx: Context) {
    super(ctx, 'instrumentState')
  }
  snapshot(): unknown {
    return this.snap
  }
  onChanged(fn: (s: unknown) => void): () => void {
    this.fns.add(fn)
    return () => this.fns.delete(fn)
  }
  fire(): void {
    for (const fn of this.fns) fn(this.snap)
  }
}

class FakeWatchdog extends Service {
  private fns = new Set<(e: unknown) => void>()
  latched = false
  constructor(ctx: Context) {
    super(ctx, 'stmWatchdog')
  }
  onEvent(fn: (e: unknown) => void): () => void {
    this.fns.add(fn)
    return () => this.fns.delete(fn)
  }
  fire(e: unknown): void {
    for (const fn of this.fns) fn(e)
  }
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

interface Host {
  ctx: Context
  port: number
  st: FakeState
  wd: FakeWatchdog
  svc: Context['mastEvents']
}

async function host(): Promise<Host> {
  const ctx = new Context()
  const st = new FakeState(ctx)
  const wd = new FakeWatchdog(ctx)
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }) // 0 = 让 OS 分配端口
  ctx.plugin(mastUiHostProvider, { heartbeatMs: 50 })
  const svc = await new Promise<Context['mastEvents']>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ctx.mastEvents 没挂上')), 5_000)
    ctx.inject(['mastEvents', 'webServer'], (c) => {
      clearTimeout(t)
      resolve(c.mastEvents)
    })
  })
  const port = (ctx as unknown as { webServer: { port: number } }).webServer.port
  cleanup.push(() => void ctx.registry.delete(mastUiHostProvider))
  cleanup.push(() => void ctx.registry.delete(WebServer))
  return { ctx, port, st, wd, svc }
}

/** 连上 SSE，收 `ms` 毫秒的原文。返回 (原文, 关闭函数)。 */
function openSse(port: number, lastEventId?: string): { text: () => string; close: () => void; ready: Promise<void> } {
  let buf = ''
  let close = (): void => {}
  const ready = new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (lastEventId !== undefined) headers['last-event-id'] = lastEventId
    const req = get({ host: '127.0.0.1', port, path: '/mast/events', headers }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        buf += c
      })
      resolve()
    })
    req.on('error', reject)
    close = (): void => {
      req.destroy()
    }
  })
  return { text: () => buf, close, ready }
}

function fetchJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        b += c
      })
      res.on('end', () => resolve(JSON.parse(b)))
    }).on('error', reject)
  })
}

describe('环形重放与 SSE 编码（纯逻辑）', () => {
  it('seq 单调递增且不复用——客户端拿它当 Last-Event-ID', () => {
    const r = new EventRing({ capacity: 3, clock: () => 1 })
    expect(r.lastSeq).toBe(0)
    for (let i = 0; i < 5; i++) r.push('alert', { i })
    expect(r.lastSeq).toBe(5)
    expect(r.oldestSeq).toBe(3) // 只留最后三条，但 seq 没有回绕
  })

  it('要不到的那一段明说 dropped，而不是安静少给', () => {
    const r = new EventRing({ capacity: 3, clock: () => 1 })
    for (let i = 0; i < 5; i++) r.push('alert', { i })
    const out = r.since(1) // 环里最老的是 3，第 2 条已经没了
    expect(out[0]!.type).toBe('dropped')
    expect(out[0]!.data).toMatchObject({ fromSeq: 2, toSeq: 2 })
    expect(out.slice(1).map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('跟得上的客户端不该收到 dropped', () => {
    const r = new EventRing({ capacity: 3, clock: () => 1 })
    for (let i = 0; i < 3; i++) r.push('alert', { i })
    expect(r.since(2).map((e) => e.seq)).toEqual([3])
    expect(r.since(3)).toEqual([])
  })

  it('超限载荷直接抛——帧里只放指针与标量', () => {
    const r = new EventRing()
    expect(() => r.push('frame_saved', { png: 'x'.repeat(5000) })).toThrow(EventPayloadTooLarge)
    // 指针是合法的
    expect(() => r.push('frame_saved', { ref: 'frame:abc123', w: 512, h: 512 })).not.toThrow()
  })

  it('SSE 帧是 id/event/data 三行加一个空行', () => {
    const r = new EventRing({ clock: () => 7 })
    expect(formatSse(r.push('alert', { a: 1 }))).toBe('id: 1\nevent: alert\ndata: {"a":1}\n\n')
  })

  it('Last-Event-ID 优先于 ?since=，都没有就是 0', () => {
    expect(parseSince('42', '/mast/events?since=7')).toBe(42)
    expect(parseSince(undefined, '/mast/events?since=7')).toBe(7)
    expect(parseSince(undefined, '/mast/events')).toBe(0)
    expect(parseSince('不是数字', undefined)).toBe(0)
  })
})

describe('对真 WebServer 的 SSE', () => {
  it('连上就有响应头与 open 注释，然后逐条推事件', async () => {
    const h = await host()
    const sse = openSse(h.port)
    await sse.ready
    await sleep(60)
    expect(sse.text()).toContain(': open')

    h.svc.emit('alert', { what: 'hello' })
    await sleep(60)
    expect(sse.text()).toContain('event: alert')
    expect(sse.text()).toContain('"what":"hello"')
    expect(h.svc.clientCount).toBe(1)
    sse.close()
  })

  it('Last-Event-ID 续传：只补没看过的那几条', async () => {
    const h = await host()
    for (let i = 1; i <= 3; i++) h.svc.emit('alert', { i })

    const sse = openSse(h.port, '2') // 我看到第 2 条了
    await sse.ready
    await sleep(60)
    const t = sse.text()
    expect(t).toContain('id: 3')
    expect(t).not.toContain('id: 1')
    expect(t).not.toContain('id: 2')
    sse.close()
  })

  it('心跳会来——中间的代理会掐掉长时间没数据的连接', async () => {
    const h = await host() // heartbeatMs = 50
    const sse = openSse(h.port)
    await sse.ready
    await sleep(180)
    expect(sse.text().split(': ping').length - 1).toBeGreaterThanOrEqual(2)
    sse.close()
  })

  it('客户端断开后从名单里摘掉——不摘的话写一个死 socket', async () => {
    const h = await host()
    const sse = openSse(h.port)
    await sse.ready
    await sleep(60)
    expect(h.svc.clientCount).toBe(1)
    sse.close()
    await sleep(120)
    expect(h.svc.clientCount).toBe(0)
  })

  it('/snapshot 给「现在是什么样」加当前 seq，供降级轮询接着往下续', async () => {
    const h = await host()
    h.svc.emit('alert', { a: 1 })
    const snap = (await fetchJson(h.port, '/mast/events/snapshot')) as {
      lastSeq: number
      hardwareState: { bias_v: number } | null
      latched: boolean | null
    }
    expect(snap.lastSeq).toBe(1)
    expect(snap.hardwareState?.bias_v).toBe(1.5)
    expect(snap.latched).toBe(false)
  })
})

describe('生产者接线', () => {
  it('状态缓存每次变都发一帧 hardware_state，且只有标量', async () => {
    const h = await host()
    const sse = openSse(h.port)
    await sse.ready
    h.st.fire()
    await sleep(60)
    expect(sse.text()).toContain('event: hardware_state')
    expect(sse.text()).toContain('"bias_v":1.5')
    sse.close()
  })

  it('看门狗的四类事件各自映射到闭集里的一个类型', async () => {
    const h = await host()
    const sse = openSse(h.port)
    await sse.ready
    h.wd.fire({ kind: 'fire', heldMs: 4000, threshold: 5e-9, readings: [1, 2, 3] })
    h.wd.fire({ kind: 'estop', reason: '撞针', result: { confirmed: true, viaRole: 'emergency', steps: [] } })
    h.wd.fire({ kind: 'threshold-degraded', level: 'shipped', value: 9e-8 })
    h.wd.fire({ kind: 'stale-link', sinceTimestamp: 'T7' })
    await sleep(80)
    const t = sse.text()
    expect(t).toContain('event: current_monitor')
    expect(t).toContain('event: estop_latch')
    expect(t).toContain('event: safety')
    expect(t).toContain('event: alert')
    // 开火那帧只带读数**个数**，不带整个数组——帧里只放标量
    expect(t).toContain('"n":3')
    sse.close()
  })

  it('三个装载依赖缺任何一个都整个不装载', async () => {
    for (const missing of ['webServer', 'instrumentState', 'stmWatchdog'] as const) {
      const ctx = new Context()
      if (missing !== 'instrumentState') new FakeState(ctx)
      if (missing !== 'stmWatchdog') new FakeWatchdog(ctx)
      if (missing !== 'webServer') ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      ctx.plugin(mastUiHostProvider, {})
      const got = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 300)
        ctx.inject(['mastEvents'], () => {
          clearTimeout(t)
          resolve(true)
        })
      })
      expect(got, `缺 ${missing} 时不该装上`).toBe(false)
      ctx.registry.delete(mastUiHostProvider)
      ctx.registry.delete(WebServer)
    }
  })
})
