import { Context } from 'dsh-spm-compat'
import { RoleLinkError } from 'dsh-spm-nanonis-wire'
import { describe, expect, it } from 'vitest'
import { InstrumentService, type CallRecord, type Role } from './instrument.js'

/**
 * 注入假 `RoleLink` 工厂。这里测的是**接线**——熔断该不该记账、角色怎么选、
 * 记录有没有产出——而不是 socket 行为（那在 1.4 的单测与 stmsim 集成里）。
 */
type Reply = { body?: Uint8Array; error?: RoleLinkError }

/** body = float32 值 + 零错误段；用于让一次调用「成功」。 */
function okBody(value: number): Uint8Array {
  const b = Buffer.alloc(12)
  b.writeFloatBE(value, 0) // 8 字节错误段全零
  return new Uint8Array(b)
}

/** body = 只有错误段（仪器拒绝）：status≠0，长度恒等式成立。 */
function nanonisError(desc: string): Uint8Array {
  const d = Buffer.from(desc, 'utf8')
  const b = Buffer.alloc(8 + d.length)
  b.writeInt32BE(1, 0)
  b.writeInt32BE(d.length, 4)
  d.copy(b, 8)
  return new Uint8Array(b)
}

const METHODS = {
  Bias_Get: { command: 'Bias.Get', args: [], returns: ['f'] },
  Bias_Set: { command: 'Bias.Set', args: [{ name: 'v', fmt: 'f' }], returns: [] },
  ZCtrl_Withdraw: {
    command: 'ZCtrl.Withdraw',
    args: [{ name: 'wait', fmt: 'I' }, { name: 'timeout', fmt: 'i' }],
    returns: [],
  },
} as const

function service(replies: Reply[] | (() => Reply), opts: { simulated?: boolean } = {}) {
  const calls: { role: Role; command: string }[] = []
  let i = 0
  const next = typeof replies === 'function' ? replies : () => replies[Math.min(i++, replies.length - 1)]!
  const ctx = new Context()
  const svc = new InstrumentService(ctx, METHODS, {
    simulated: opts.simulated ?? true,
    createLink: (role) =>
      ({
        connected: true,
        connect: async () => {},
        close: async () => {},
        request: async (command: string) => {
          calls.push({ role, command })
          const r = next()
          if (r.error) throw r.error
          return r.body ?? new Uint8Array(8)
        },
      }) as never,
  })
  return { svc, calls }
}

describe('call 永不抛，成败都回一条 CallRecord', () => {
  it('成功：带 values，无 error', async () => {
    const { svc } = service([{ body: okBody(1.5) }])
    const rec = await svc.call('Bias_Get', [])
    expect(rec.values).toEqual([1.5])
    expect(rec.error).toBeUndefined()
    expect(rec.command).toBe('Bias.Get')
    expect(rec.simulated).toBe(true) // 真机与模拟器只差这一位，rigGuard 据此拒绝
  })

  it('协议表里没有的方法：回 UnknownMethod，不抛', async () => {
    const { svc } = service([{ body: okBody(0) }])
    const rec = await svc.call('No_Such_Verb', [])
    expect(rec.error).toMatch(/^UnknownMethod:/)
  })

  it('传输层失败：回带前缀的 error，不抛', async () => {
    const { svc } = service([{ error: new RoleLinkError('没回', 'Timeout') }])
    const rec = await svc.call('Bias_Get', [])
    expect(rec.error).toMatch(/^Timeout:/)
    expect(rec.values).toBeUndefined()
  })

  it('参数按 args 顺序配对成 ArgValue', async () => {
    const { svc } = service([{ body: new Uint8Array(8) }])
    const rec = await svc.call('ZCtrl_Withdraw', [1, -1])
    expect(rec.args).toEqual([
      { value: 1, fmt: 'I' },
      { value: -1, fmt: 'i' },
    ])
  })
})

describe('熔断记账：只有 TCP 级失败才算失败', () => {
  it('仪器自己拒绝（错误段 status≠0）算链路**成功**', async () => {
    // 1.5 的 app-error 规则；1.4 的集成测试已在真 stmsim 上证实过这个形状
    const { svc } = service([{ body: nanonisError('NeedModule: PLL 没加载') }])
    const rec = await svc.call('Bias_Get', [])
    expect(rec.error).toMatch(/^NanonisError:/)
    expect(svc.comms().streak).toBe(0) // 没记失败
    expect(svc.comms().state).toBe('closed')
  })

  it('三次 TCP 超时后熔断，第四次直接短路且**没碰 socket**', async () => {
    const { svc, calls } = service(() => ({ error: new RoleLinkError('没回', 'Timeout') }))
    for (let i = 0; i < 3; i++) await svc.call('Bias_Get', [])
    expect(svc.comms().state).toBe('open')
    const before = calls.length
    const rec = await svc.call('Bias_Get', [])
    expect(rec.error).toMatch(/^comms_circuit_open:/)
    expect(calls.length).toBe(before) // 关键：短路时一次 socket 都没发
  })

  it('RoleBusy 不记熔断——那是「有人在用」，不是链路坏了', async () => {
    const { svc } = service(() => ({ error: new RoleLinkError('忙', 'RoleBusy') }))
    for (let i = 0; i < 5; i++) await svc.call('Bias_Get', [])
    expect(svc.comms().streak).toBe(0)
    expect(svc.comms().state).toBe('closed') // 否则一次并发争抢就能熔断整条链路
  })

  it('countHealth=false 的高频只读不进记账', async () => {
    const { svc } = service(() => ({ error: new RoleLinkError('没回', 'Timeout') }))
    for (let i = 0; i < 5; i++) await svc.call('Bias_Get', [], { countHealth: false })
    expect(svc.comms().streak).toBe(0)
  })
})

describe('急停通道', () => {
  it('走 emergency 角色，且熔断开着也照发', async () => {
    const { svc, calls } = service(() => ({ error: new RoleLinkError('没回', 'Timeout') }))
    for (let i = 0; i < 3; i++) await svc.call('Bias_Get', [])
    expect(svc.comms().state).toBe('open')

    const before = calls.length
    await svc.urgentCall('ZCtrl_Withdraw', [1, -1])
    // 熔断的意义是别对着死链路磕头，但退针值得试一次——不试的代价是针还扎在样品上
    expect(calls.length).toBe(before + 1)
    expect(calls.at(-1)!.role).toBe('emergency')
  })
})

describe('onRecord 是 records 与差分测试的挂点', () => {
  it('每次调用都推一条，取消登记后不再推', async () => {
    const { svc } = service(() => ({ body: okBody(0.5) }))
    const seen: CallRecord[] = []
    const off = svc.onRecord((r) => seen.push(r))
    await svc.call('Bias_Get', [])
    await svc.call('Bias_Get', [])
    expect(seen).toHaveLength(2)
    off()
    await svc.call('Bias_Get', [])
    expect(seen).toHaveLength(2)
  })

  it('被拒绝的调用也进记录——闸门在记录之后（§3.2-4）', async () => {
    const { svc } = service(() => ({ error: new RoleLinkError('没回', 'Timeout') }))
    const seen: CallRecord[] = []
    svc.onRecord((r) => seen.push(r))
    for (let i = 0; i < 4; i++) await svc.call('Bias_Get', [])
    expect(seen).toHaveLength(4)
    expect(seen.at(-1)!.error).toMatch(/^comms_circuit_open:/) // 短路那次也有记录
  })
})

describe('作为 Cordis Service 挂到 ctx 上', () => {
  it('注册名是 instrument，inject 拿得到，且拿到的是**代理不是原实例**', async () => {
    const ctx = new Context()
    const svc = new InstrumentService(ctx, METHODS, { createLink: () => ({}) as never })
    expect(svc.name).toBe('instrument')

    const got = await new Promise<InstrumentService>((resolve) => {
      ctx.inject(['instrument'], (c) => resolve(c.instrument))
    })

    // **不能用引用相等判断**：Cordis 从 ctx 上取到的是按上下文包的代理（它的 tracker /
    // extend symbol 就是干这个的），不是构造出来的那个对象。2026-09-09 接线时踩到——
    // 第一版写的是 toBe(svc)，测试超时了 5 秒才失败，看着像「服务没挂上」。
    expect(got).not.toBe(svc)
    expect(got.name).toBe('instrument')
    expect(got.simulated).toBe(svc.simulated)
    expect(got.comms().state).toBe('closed') // 方法照常能调
  })

  it('inject 缺件时回调根本不跑——装载依赖不是运行时检查（PLAN §6.1-3）', async () => {
    const ctx = new Context()
    new InstrumentService(ctx, METHODS, { createLink: () => ({}) as never })
    let ran = false
    ctx.inject(['instrument', 'stmSafety'], () => {
      ran = true
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(ran).toBe(false) // stmSafety 还不存在（1.6 之后才有），所以整个回调不装载
  })
})
