import { Context } from 'dsh-spm-compat'
import { CONNECT_FAILED, MODULE_OPEN_RECV_MS, NOT_RESENT_HINT } from 'dsh-spm-kernel'
import { NANONIS_METHODS, RoleLinkError } from 'dsh-spm-nanonis-wire'
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

// ── 传输层：失败标记、不重发、可能已执行的提示、模块加载宽限 ──────────────────
//
// 语义搬自旧仓 `test_connection_no_double_action.py` 与 `test_connection_open_grace_and_root_cause.py`
// 里与连接池接线有关的那几格；重发次数与「根因优先」的文案属于旧仓的连接池，本仓不重发（D-CONN-?）。
// 动词与实参格式一律取 `NANONIS_METHODS`，不手写 fmt。

const RL = (kind: RoleLinkError['kind']): RoleLinkError => new RoleLinkError('测试注入', kind)

interface Sent { readonly role: Role; readonly command: string; readonly timeoutMs: number | undefined }

/** 真服务 + 假 link。`connect` 给了就每次都走一遍建连（link 报未连接）。 */
function wired(
  reply: (command: string) => Reply,
  opts: { connect?: () => Promise<void>; methods?: ConstructorParameters<typeof InstrumentService>[1] } = {},
) {
  const sent: Sent[] = []
  const svc = new InstrumentService(new Context(), opts.methods ?? NANONIS_METHODS, {
    simulated: true,
    createLink: (role) =>
      ({
        connected: opts.connect === undefined,
        connect: opts.connect ?? (async () => {}),
        close: async () => {},
        request: async (command: string, _body: Uint8Array, o: { timeoutMs?: number } = {}) => {
          sent.push({ role, command, timeoutMs: o.timeoutMs })
          const r = reply(command)
          if (r.error) throw r.error
          return r.body ?? new Uint8Array(8)
        },
      }) as never,
  })
  return { svc, sent }
}

describe('传输失败的结构化标记', () => {
  it('I1 只有传输层的失败带标记：四种可能已送达，NotConnected 没送达，连不上记 ConnectFailed', async () => {
    for (const kind of ['Timeout', 'EmptyReply', 'WrongEcho', 'SocketError'] as const) {
      const { svc } = wired(() => ({ error: RL(kind) }))
      expect((await svc.call('Bias_Get', [])).transport, kind).toEqual({ kind, maybeDelivered: true })
    }
    const notConnected = wired(() => ({ error: RL('NotConnected') }))
    expect((await notConnected.svc.call('Bias_Get', [])).transport).toEqual({ kind: 'NotConnected', maybeDelivered: false })

    const refused = wired(() => ({}), { connect: async () => { throw new RoleLinkError('连不上', 'SocketError') } })
    const rec = await refused.svc.call('Bias_Get', [])
    expect(rec.transport).toEqual(CONNECT_FAILED)
    expect(refused.sent).toHaveLength(0)
  })

  it('I1 不是传输失败的都不带：忙锁、仪器拒绝、协议表里没有、熔断短路、编码出错、宿主建连时的检查', async () => {
    const busy = wired(() => ({ error: RL('RoleBusy') }))
    expect((await busy.svc.call('Bias_Get', [])).transport).toBeUndefined()

    const rejected = wired(() => ({ body: nanonisError('NeedModule: PLL 没加载') }))
    const r1 = await rejected.svc.call('Bias_Get', [])
    expect(r1.error).toMatch(/^NanonisError:/)
    expect(r1.transport).toBeUndefined()

    expect((await rejected.svc.call('No_Such_Verb', [])).transport).toBeUndefined()

    const tripped = wired(() => ({ error: RL('Timeout') }))
    for (let i = 0; i < 3; i++) await tripped.svc.call('Bias_Get', [])
    const shorted = await tripped.svc.call('Bias_Get', [])
    expect(shorted.error).toMatch(/^comms_circuit_open:/)
    expect(shorted.transport).toBeUndefined()

    // 编码出错（`WireTypeError`）：命令没成形，重做一次也一样
    const weird = { Weird_Set: { command: 'Weird.Set', args: [{ name: 'x', fmt: 'Q' }], returns: [] } }
    const bad = wired(() => ({}), { methods: weird })
    const r2 = await bad.svc.call('Weird_Set', [1])
    expect(r2.error).toBeDefined()
    expect(r2.transport).toBeUndefined()

    // 宿主在建连时的检查（原生模拟器的身份校验抛的就是普通 Error）不是传输失败
    const identity = wired(() => ({}), { connect: async () => { throw new Error('native_simulator_identity: 进程变了') } })
    const r3 = await identity.svc.call('Bias_Get', [])
    expect(r3.error).toMatch(/^native_simulator_identity:/)
    expect(r3.transport).toBeUndefined()
  })
})

describe('可能已执行的命令：只发一次，错误里说清楚', () => {
  it('I2 不可重发的命令传输失败且可能已送达 ⇒ 前缀不变、追加提示；其余情形都不加', async () => {
    const timeout = wired(() => ({ error: RL('Timeout') }))
    const move = await timeout.svc.call('Motor_StartMove', [0, 100, 0, 1])
    expect(move.error).toMatch(/^Timeout:/)
    expect(move.error).toContain('可能已被控制器收到并执行')
    expect(move.error?.endsWith(NOT_RESENT_HINT)).toBe(true)
    // 可重发的命令：不加
    expect((await wired(() => ({ error: RL('Timeout') })).svc.call('Bias_Set', [0.5])).error).not.toContain(NOT_RESENT_HINT)
    // 按第一个实参判：停扫可重发、起扫不可
    expect((await wired(() => ({ error: RL('Timeout') })).svc.call('Scan_Action', [1, 0])).error).not.toContain(NOT_RESENT_HINT)
    expect((await wired(() => ({ error: RL('Timeout') })).svc.call('Scan_Action', [0, 0])).error).toContain(NOT_RESENT_HINT)
    // 命令没发出去：没连上、发送前已断开
    const refused = wired(() => ({}), { connect: async () => { throw new RoleLinkError('连不上', 'SocketError') } })
    expect((await refused.svc.call('Motor_StartMove', [0, 100, 0, 1])).error).not.toContain(NOT_RESENT_HINT)
    expect((await wired(() => ({ error: RL('NotConnected') })).svc.call('Motor_StartMove', [0, 100, 0, 1])).error)
      .not.toContain(NOT_RESENT_HINT)
    // 控制器答了：不是传输失败
    expect((await wired(() => ({ body: nanonisError('Locked') })).svc.call('Motor_StartMove', [0, 100, 0, 1])).error)
      .not.toContain(NOT_RESENT_HINT)
  })

  it('I2 熔断记的是原文：提示只给调用方，不进 lastReason', async () => {
    const { svc } = wired(() => ({ error: RL('Timeout') }))
    const rec = await svc.call('Motor_StartMove', [0, 100, 0, 1])
    expect(rec.error).toContain(NOT_RESENT_HINT)
    expect(svc.comms().lastReason).toMatch(/^Timeout:/)
    expect(svc.comms().lastReason).not.toContain('可能已被控制器收到并执行')
  })

  it('I3 从不重发：可重发与不可重发的命令，传输失败后都只发出过一次', async () => {
    const cases: readonly [string, readonly unknown[]][] = [
      // 实参按本仓协议表的签名给（`DigLines_Pulse` 的第二个实参是线号数组）：编不成帧就根本发不出去
      ['Motor_StartMove', [0, 100, 0, 1]], ['Bias_Pulse', [1, 0.01, 3.0, 0, 0]], ['DigLines_Pulse', [1, [1], 0.01, 0.01, 1, 1]],
      ['TipShaper_Start', [1, 5000]], ['BiasSpectr_Start', [1, '']], ['ZSpectr_Start', [1, '']], ['Script_Run', [1, 1]],
      ['Scan_Action', [0, 0]], ['Scan_Action', [3, 0]], ['AutoApproach_OnOffSet', [1]], ['AutoApproach_OnOffSet', [true]],
      ['Scan_Save', [1, 4000]], ['AtomTrack_DriftComp', []],
      ['Bias_Get', []], ['Bias_Set', [0.5]], ['Scan_Action', [1, 0]], ['Scan_Action', [2, 0]],
      ['AutoApproach_OnOffSet', [0]], ['ZCtrl_Withdraw', [1, -1]], ['Motor_StopMove', []], ['BiasSpectr_Stop', []],
      ['PLLZoomFFT_AvgRestart', []],
    ]
    for (const [method, args] of cases) {
      for (const kind of ['Timeout', 'EmptyReply', 'SocketError'] as const) {
        const { svc, sent } = wired(() => ({ error: RL(kind) }))
        const rec = await svc.call(method, args)
        expect(rec.transport?.kind, `${method} ${kind}`).toBe(kind)
        expect(sent, `${method} ${kind}`).toHaveLength(1)
      }
    }
  })
})

describe('模块首次加载的宽限穿过服务', () => {
  it('I4 Open 与紧跟它的那一条带 30 s 超时，再下一条回到连接的缺省', async () => {
    const { svc, sent } = wired(() => ({}))
    await svc.call('BiasSpectr_Open', [])
    await svc.call('BiasSpectr_LimitsSet', [-1, 1])
    await svc.call('BiasSpectr_PropsSet', [1, 1, 1, 128, 0, 1, 2])
    expect(sent.map((s) => s.timeoutMs)).toEqual([MODULE_OPEN_RECV_MS, MODULE_OPEN_RECV_MS, undefined])
  })

  it('I4 调用方给的更小值被抬到 30 s，更大的保持；失败的 Open 不上膛；宽限只给同一个角色', async () => {
    const { svc, sent } = wired((command) => (command === 'ZSpectr.Open' ? { body: nanonisError('NeedModule') } : {}))
    await svc.call('BiasSpectr_Open', [])
    await svc.call('BiasSpectr_LimitsSet', [-1, 1], { timeoutMs: 1_000 })
    await svc.call('BiasSpectr_Open', [])
    await svc.call('BiasSpectr_Start', [1, ''], { timeoutMs: 600_000 })
    // 控制器拒绝了这次 Open：不上膛
    await svc.call('ZSpectr_Open', [])
    await svc.call('ZSpectr_RangeSet', [0, 1e-9])
    // 别的角色不分享宽限
    await svc.call('BiasSpectr_Open', [])
    await svc.call('Current_Get', [], { role: 'monitor' })
    await svc.call('BiasSpectr_PropsSet', [1, 1, 1, 128, 0, 1, 2])
    expect(sent.map((s) => [s.role, s.command, s.timeoutMs])).toEqual([
      ['main', 'BiasSpectr.Open', MODULE_OPEN_RECV_MS],
      ['main', 'BiasSpectr.LimitsSet', MODULE_OPEN_RECV_MS],
      ['main', 'BiasSpectr.Open', MODULE_OPEN_RECV_MS],
      ['main', 'BiasSpectr.Start', 600_000],
      ['main', 'ZSpectr.Open', MODULE_OPEN_RECV_MS],
      ['main', 'ZSpectr.RangeSet', undefined],
      ['main', 'BiasSpectr.Open', MODULE_OPEN_RECV_MS],
      ['monitor', 'Current.Get', undefined],
      ['main', 'BiasSpectr.PropsSet', MODULE_OPEN_RECV_MS],
    ])
  })
})
