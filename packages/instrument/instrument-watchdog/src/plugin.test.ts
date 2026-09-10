/**
 * 急停与接线的测试。判据本身在 kernel 的 `watchdog.test.ts` 对金样；
 * 这里验的是**发出去的命令序列**——急停的每一个细节都是事故买来的，
 * 而事故买来的东西只能靠「它到底发了什么」来守住。
 */
import { Context, Service } from 'dsh-spm-compat'
import { describe, expect, it } from 'vitest'
import { emergencyRetract, type EstopCall } from './estop.js'
import { TipWatchdogService, watchdogProvider } from './plugin.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Seen {
  method: string
  args: unknown[]
  role: unknown
  countHealth: unknown
}

class FakeInstrument extends Service {
  readonly seen: Seen[] = []
  /** 方法名（可带 `@role`）→ 错误串；缺席 = 成功。 */
  fail: Record<string, string | undefined> = {}
  current = 1.0e-10

  constructor(ctx: Context) {
    super(ctx, 'instrument')
  }

  call(
    method: string,
    args: readonly unknown[],
    opts: { role?: unknown; countHealth?: unknown } = {},
  ): Promise<{ values?: readonly unknown[]; error?: string }> {
    this.seen.push({ method, args: [...args], role: opts.role, countHealth: opts.countHealth })
    const err = this.fail[`${method}@${String(opts.role)}`] ?? this.fail[method]
    if (err !== undefined) return Promise.resolve({ error: err })
    if (method === 'Current_Get') return Promise.resolve({ values: [this.current] })
    return Promise.resolve({ values: [] })
  }
}

class FakeState extends Service {
  snap = { stale: false, timestamp: 'T0' }
  constructor(ctx: Context) {
    super(ctx, 'instrumentState')
  }
  snapshot(): { stale: boolean; timestamp: string } {
    return this.snap
  }
}

class FakeCommands extends Service {
  readonly registered: { name: string; handler: (i: unknown) => unknown }[] = []
  constructor(ctx: Context) {
    super(ctx, 'commands')
  }
  register(def: unknown): () => void {
    const d = def as { name: string; handler: (i: unknown) => unknown }
    this.registered.push(d)
    return () => void this.registered.splice(this.registered.indexOf(d), 1)
  }
}

function host(ctx: Context): { ins: FakeInstrument; st: FakeState; cmd: FakeCommands } {
  return { ins: new FakeInstrument(ctx), st: new FakeState(ctx), cmd: new FakeCommands(ctx) }
}

function svcOf(ctx: Context, timeoutMs = 2_000): Promise<Context['stmWatchdog']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.stmWatchdog 没挂上')), timeoutMs)
    ctx.inject(['stmWatchdog'], (c) => {
      clearTimeout(timer)
      resolve(c.stmWatchdog)
    })
  })
}

describe('急停发出去的命令序列', () => {
  const record = (): { calls: [string, unknown[], string][]; call: EstopCall } => {
    const calls: [string, unknown[], string][] = []
    const call: EstopCall = (m, a, r) => {
      calls.push([m, [...a], r])
      return Promise.resolve({})
    }
    return { calls, call }
  }

  it('先停粗逼近与马达，再退压电——顺序反了这次退针会被几步走回去', async () => {
    const { calls, call } = record()
    const r = await emergencyRetract(call)
    expect(calls.map((c) => c[0])).toEqual(['AutoApproach_OnOffSet', 'Motor_StopMove', 'ZCtrl_Withdraw'])
    expect(r.confirmed).toBe(true)
    expect(r.viaRole).toBe('emergency')
  })

  it('ZCtrl_Withdraw 两个参数都要给——只传一个在真机上抛 TypeError，急停从没跑过', async () => {
    const { calls, call } = record()
    await emergencyRetract(call)
    const w = calls.find((c) => c[0] === 'ZCtrl_Withdraw')!
    expect(w[1]).toEqual([1, -1]) // Wait_until_finished=1, Timeout_ms=-1（一直等）
  })

  it('停粗逼近失败**不许**挡住退针', async () => {
    const calls: [string, string][] = []
    const call: EstopCall = (m, _a, r) => {
      calls.push([m, r])
      if (m !== 'ZCtrl_Withdraw') return Promise.reject(new Error('马达口没连上'))
      return Promise.resolve({})
    }
    const r = await emergencyRetract(call)
    expect(r.confirmed).toBe(true)
    expect(calls.map((c) => c[0])).toContain('ZCtrl_Withdraw')
  })

  it('emergency 失败要退回 main——一个活着的 main 口照样能退针', async () => {
    const calls: [string, string][] = []
    const call: EstopCall = (m, _a, r) => {
      calls.push([m, r])
      if (m === 'ZCtrl_Withdraw' && r === 'emergency') return Promise.resolve({ error: 'Timeout: 急停口没回话' })
      return Promise.resolve({})
    }
    const r = await emergencyRetract(call)
    expect(r.confirmed).toBe(true)
    expect(r.viaRole).toBe('main')
    expect(calls.filter((c) => c[0] === 'ZCtrl_Withdraw').map((c) => c[1])).toEqual(['emergency', 'main'])
  })

  it('两个角色都失败 ⇒ confirmed=false，逐步留痕', async () => {
    const call: EstopCall = (m) =>
      Promise.resolve(m === 'ZCtrl_Withdraw' ? { error: 'SocketError: 断了' } : {})
    const r = await emergencyRetract(call)
    expect(r.confirmed).toBe(false)
    expect(r.viaRole).toBeNull()
    expect(r.steps.filter((s) => s.method === 'ZCtrl_Withdraw')).toHaveLength(2)
  })
})

describe('ctx.stmWatchdog 的接线', () => {
  it('轮询只读 Current_Get，走 monitor 角色且 countHealth:false', async () => {
    const ctx = new Context()
    const { ins } = host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0 })
    const svc = await svcOf(ctx)

    await svc.tick()
    expect(ins.seen).toHaveLength(1)
    expect(ins.seen[0]!.method).toBe('Current_Get')
    expect(ins.seen[0]!.role).toBe('monitor')
    expect(ins.seen[0]!.countHealth).toBe(false)
    ctx.registry.delete(watchdogProvider)
  })

  it('连续贴轨到窗口满就退针，并上闩', async () => {
    const ctx = new Context()
    const { ins } = host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0, windowSize: 3, thresholdA: 5e-9 })
    const svc = await svcOf(ctx)
    ins.current = 1e-8 // 贴轨

    const events: string[] = []
    svc.onEvent((e) => events.push(e.kind))
    for (let i = 0; i < 3; i++) await svc.tick()

    expect(events).toContain('fire')
    expect(events).toContain('estop')
    expect(svc.latched).toBe(true)
    const verbs = ins.seen.filter((s) => s.method !== 'Current_Get').map((s) => s.method)
    expect(verbs).toEqual(['AutoApproach_OnOffSet', 'Motor_StopMove', 'ZCtrl_Withdraw'])
    ctx.registry.delete(watchdogProvider)
  })

  it('退针没确认 ⇒ **不上闩**（一次失败的退针不该把网整个 session 解除武装）', async () => {
    const ctx = new Context()
    const { ins } = host(ctx)
    ins.fail = { ZCtrl_Withdraw: 'SocketError: 断了' }
    ctx.plugin(watchdogProvider, { intervalMs: 0, windowSize: 2, thresholdA: 5e-9 })
    const svc = await svcOf(ctx)
    ins.current = 1e-8
    for (let i = 0; i < 2; i++) await svc.tick()
    expect(svc.latched).toBe(false)
    ctx.registry.delete(watchdogProvider)
  })

  it('阈值降级要发事件——静默回退正是 2026-08-10 的本体', async () => {
    const ctx = new Context()
    host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0, shippedThresholdA: 9e-8 })
    const svc = await svcOf(ctx)
    const seen: { kind: string; level?: string }[] = []
    svc.onEvent((e) => seen.push(e as { kind: string; level?: string }))
    await svc.tick() // 没有活值来源 ⇒ 直接退到出厂默认，且要说一句
    expect(seen.find((e) => e.kind === 'threshold-degraded')?.level).toBe('shipped')
    ctx.registry.delete(watchdogProvider)
  })

  it('接上活值来源之后就跟着它，并且恢复也说一句', async () => {
    const ctx = new Context()
    host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0 })
    const svc = await svcOf(ctx)
    const levels: string[] = []
    svc.onEvent((e) => {
      if (e.kind === 'threshold-degraded') levels.push(e.level)
    })
    await svc.tick() // shipped
    svc.useThresholdSource(() => 5e-9)
    await svc.tick() // live（恢复，说一句）
    await svc.tick() // 还是 live，不再刷屏
    expect(levels).toEqual(['shipped', 'live'])
    ctx.registry.delete(watchdogProvider)
  })

  it('链路断（stale）走告警，不改提示块——1.8b 记下的缺口补在这里', async () => {
    const ctx = new Context()
    const { st } = host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0, thresholdA: 5e-9 })
    const svc = await svcOf(ctx)
    const seen: string[] = []
    svc.onEvent((e) => seen.push(e.kind))

    await svc.tick()
    expect(seen).not.toContain('stale-link')
    st.snap = { stale: true, timestamp: 'T7' }
    await svc.tick()
    await svc.tick() // 同一个陈时间戳 ⇒ 只喊一次，不刷屏
    expect(seen.filter((k) => k === 'stale-link')).toHaveLength(1)
    ctx.registry.delete(watchdogProvider)
  })

  it('/estop 注册成**命令**不是工具——急停是操作员的手，不是模型的一个选项', async () => {
    const ctx = new Context()
    const { cmd } = host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0 })
    const svc = await svcOf(ctx)

    const estop = cmd.registered.find((c) => c.name === 'estop')
    expect(estop, '/estop 没注册').toBeDefined()
    const out = (await estop!.handler({})) as { kind: string; text: string }
    expect(out.kind).toBe('success')
    expect(svc.latched).toBe(true)
    ctx.registry.delete(watchdogProvider)
  })

  it('reset 解闩之后重新武装', async () => {
    const ctx = new Context()
    const { ins } = host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0, windowSize: 2, thresholdA: 5e-9 })
    const svc = await svcOf(ctx)
    ins.current = 1e-8
    for (let i = 0; i < 2; i++) await svc.tick()
    expect(svc.latched).toBe(true)
    svc.reset()
    expect(svc.latched).toBe(false)
    for (let i = 0; i < 2; i++) await svc.tick()
    expect(svc.latched).toBe(true) // 又退了一次
    ctx.registry.delete(watchdogProvider)
  })

  it('三个装载依赖缺任何一个都整个不装载', async () => {
    for (const missing of ['instrument', 'instrumentState', 'commands'] as const) {
      const ctx = new Context()
      if (missing !== 'instrument') new FakeInstrument(ctx)
      if (missing !== 'instrumentState') new FakeState(ctx)
      if (missing !== 'commands') new FakeCommands(ctx)
      ctx.plugin(watchdogProvider, { intervalMs: 0 })
      await expect(svcOf(ctx, 300), `缺 ${missing} 时`).rejects.toThrow(/没挂上/)
    }
  })

  it('卸载后轮询停下，且不留没人接的 rejection', async () => {
    const rejections: unknown[] = []
    const onRej = (e: unknown): void => void rejections.push(e)
    process.on('unhandledRejection', onRej)
    try {
      const ctx = new Context()
      const { ins } = host(ctx)
      ctx.plugin(watchdogProvider, { intervalMs: 10 })
      await svcOf(ctx)
      await sleep(80)
      expect(ins.seen.length).toBeGreaterThan(2)
      ctx.registry.delete(watchdogProvider)
      const at = ins.seen.length
      await sleep(120)
      expect(ins.seen.length).toBe(at)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRej)
    }
  })
})

describe('TipWatchdogService 是 Service', () => {
  it('挂在 ctx.stmWatchdog 上', async () => {
    const ctx = new Context()
    host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0 })
    const svc = await svcOf(ctx)
    expect(svc).toBeInstanceOf(Object)
    expect(typeof svc.estop).toBe('function')
    expect(TipWatchdogService.name).toBe('TipWatchdogService')
    ctx.registry.delete(watchdogProvider)
  })
})
