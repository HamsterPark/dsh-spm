/**
 * `createInstrumentCalls` —— 宿主交给内核的两条出口：缺省的 `safeCall`，与带 recv 预算的 `budgetedCall`。
 *
 * 六件事：① 秒换成毫秒传给 `send`；② 取整与下限；③ 中止闩上时同一道门（`send` 一次都不被调用）；
 * ④ 缺省路径不带任何传输层选项；⑤ 经真 `SkillKernel` 的 `ctx.slowCall` 夹到 900 s；
 * ⑥ **缩比的真 TCP**：回复晚于缺省超时 —— 这是本模块最重要的回归保护。
 *
 * 为什么 ⑥ 是缩比的：钉定的 STM-Bench 把 `ZSpectr_Start` 的回复封顶在 4 s，又没有注入延迟的开关，
 * 集成测试里没法复现「回复晚于缺省的 5 s 超时」。这里用进程内的真 `net.createServer` 把同一件事缩小到
 * 毫秒级：缺省超时 60 ms，服务器 200 ms 才回。
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'dsh-spm-compat'
import { InstrumentService, type CallOptions, type CallRecord, type LinkFactory, type Role } from 'dsh-spm-instrument'
import { SkillKernel, emptyHardwareState, type Skill } from 'dsh-spm-kernel'
import { NANONIS_METHODS, RoleLink } from 'dsh-spm-nanonis-wire'
import { createInstrumentCalls } from './instrument-calls.js'

/** 先登记的后清理：服务要先关，服务器才等得到连接都断开。 */
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** 真 `InstrumentService` + 注入的 link 工厂（要「真服务 + 假 link」的用例都从这里造）。 */
function serviceWith(createLink: LinkFactory, ports?: Partial<Record<Role, number>>): InstrumentService {
  const svc = new InstrumentService(new Context(), NANONIS_METHODS, {
    simulated: true,
    createLink,
    ...(ports === undefined ? {} : { ports }),
  })
  cleanup.push(() => svc.closeAll())
  return svc
}

/** `send` 的替身：回一条成功的记录。 */
const okRecord = (method: string, args: readonly unknown[], _opts?: CallOptions): Promise<CallRecord> =>
  Promise.resolve({
    method,
    command: method,
    role: 'main',
    args: args.map((value) => ({ value, fmt: '' })),
    values: [],
    elapsedMs: 0,
    at: 0,
    simulated: true,
  })

describe('createInstrumentCalls · 宿主的两条出口', () => {
  it('① budgetedCall 把秒换成毫秒作为 timeoutMs 传给 send；预算不在实参里', async () => {
    const send = vi.fn(okRecord)
    const { budgetedCall } = createInstrumentCalls({ send, abortLatched: () => false })
    await budgetedCall('ZSpectr_Start', 120, 1, '')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('ZSpectr_Start', [1, ''], { timeoutMs: 120_000 })
  })

  it('② 秒向上取整成毫秒，至少 1 ms（0 毫秒的超时是立刻到期，不是「不限」）', async () => {
    const send = vi.fn(okRecord)
    const { budgetedCall } = createInstrumentCalls({ send, abortLatched: () => false })
    await budgetedCall('X_Start', 1.5)
    await budgetedCall('X_Start', 1.0004)
    await budgetedCall('X_Start', 0.0004)
    // 不对 79.02 × 1000 这类浮点乘积做精确相等，所以取这三个数
    expect(send.mock.calls.map((c) => c[2])).toEqual([{ timeoutMs: 1500 }, { timeoutMs: 1001 }, { timeoutMs: 1 }])
  })

  it('③ 中止闩上 ⇒ 起扫被拒、send 一次都没被调用；读与停扫放行并带着换算好的 timeoutMs', async () => {
    const send = vi.fn(okRecord)
    const { safeCall, budgetedCall } = createInstrumentCalls({ send, abortLatched: () => true })
    const refused = await budgetedCall('ZSpectr_Start', 120, 1, '')
    expect(refused.error).toMatch(/^abort_latched:/)
    // safeCall 是同一道门
    expect((await safeCall('ZSpectr_Start', 1, '')).error).toMatch(/^abort_latched:/)
    expect(send).not.toHaveBeenCalled()
    // 读永远放行；`ZSpectr_Stop` 是中止安全写
    await budgetedCall('ZSpectr_Stop', 30)
    await budgetedCall('ZSpectr_PropsGet', 2)
    expect(send.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['ZSpectr_Stop', { timeoutMs: 30_000 }],
      ['ZSpectr_PropsGet', { timeoutMs: 2_000 }],
    ])
  })

  it('④ safeCall 不带任何传输层选项（第三个参数是 undefined）—— 缺省路径不碰传输层', async () => {
    const send = vi.fn(okRecord)
    const { safeCall } = createInstrumentCalls({ send, abortLatched: () => false })
    await safeCall('Bias_Get')
    await safeCall('Bias_Set', 0.5)
    expect(send.mock.calls).toEqual([
      ['Bias_Get', []],
      ['Bias_Set', [0.5]],
    ])
    expect(send.mock.calls.every((c) => c[2] === undefined)).toBe(true)
  })

  it('⑤ 经真 SkillKernel：slowCall 请求 1000 s ⇒ 夹到 900 s，send 收到 timeoutMs 900000', async () => {
    const send = vi.fn(okRecord)
    const { safeCall, budgetedCall } = createInstrumentCalls({ send, abortLatched: () => false })
    const kernel = new SkillKernel({ snapshot: () => emptyHardwareState('T0'), safeCall, budgetedCall })
    const probe: Skill = {
      spec: { name: '_Probe', description: 'p', parameters: [] },
      execute: async (ctx) => {
        const r = await ctx.slowCall('ZSpectr_Start', 1000, 1, '')
        return { success: true, data: { recv_timeout_s: r.recvTimeoutS } }
      },
    }
    const out = await kernel.run(probe, {})
    expect(out.kind).toBe('ok')
    // 上限是台架的属性，内核夹过之后才到宿主；报给技能的也是夹过的那个数
    expect(out.data?.['recv_timeout_s']).toBe(900)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('ZSpectr_Start', [1, ''], { timeoutMs: 900_000 })
  })
})

// ── ⑥ 缩比的真 TCP ──────────────────────────────────────────────────────────

/** 一帧回复的头：32 字节名字回声 + 4 字节 body 长度 + 4 字节（send_response 与填充）。 */
const HEADER_LEN = 40

type Handler = (sock: Socket, frame: Buffer) => void

/** 进程内的真 TCP 服务器（回环、临时端口）。抄 `role-link.test.ts` 的 fakeServer。 */
async function fakeServer(handler: Handler): Promise<Server> {
  const server = createServer((sock) => {
    const chunks: Buffer[] = []
    sock.on('data', (d) => {
      chunks.push(d)
      const all = Buffer.concat(chunks)
      if (all.length < HEADER_LEN) return
      const bodySize = all.readUInt32BE(32)
      if (all.length < HEADER_LEN + bodySize) return
      chunks.length = 0
      handler(sock, all.subarray(0, HEADER_LEN + bodySize))
    })
    // 客户端超时后已经半关了，迟到的回复写上去会报错 —— 这里不关心
    sock.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return server
}

/** 成功回复：逐字回声名字段 + 全零的 8 字节错误段（成功、没有返回字段的 error-only 形状）。 */
function replyOk(sock: Socket, frame: Buffer): void {
  const err = Buffer.alloc(8)
  const head = Buffer.concat([frame.subarray(0, 32), Buffer.alloc(8)])
  head.writeUInt32BE(err.length, 32)
  sock.write(Buffer.concat([head, err]))
}

describe('createInstrumentCalls · ⑥ 缩比的真 TCP', () => {
  it('⑥ 回复晚于缺省超时 ⇒ safeCall 得 Timeout，budgetedCall 同一条命令成功', async () => {
    const SHORT_MS = 60 // 缩比的「缺省 5 s」
    const LATE_MS = 200 // 缩比的「一条要跑很久的扫掠」
    const timers: NodeJS.Timeout[] = []
    cleanup.push(() => timers.forEach((t) => clearTimeout(t)))
    const server = await fakeServer((sock, frame) => {
      timers.push(setTimeout(() => replyOk(sock, frame), LATE_MS))
    })
    const port = (server.address() as AddressInfo).port
    const svc = serviceWith((_role, p) => new RoleLink({ port: p, timeoutMs: SHORT_MS }), { main: port })
    const { safeCall, budgetedCall } = createInstrumentCalls({
      send: (method, args, opts) => svc.call(method, args, opts),
      abortLatched: () => false,
    })

    // 缺省路径：传输层用它自己的缺省超时，慢回复来不及 —— 连接随之断开
    const slow = await safeCall('ZSpectr_Start', 1, '')
    expect(slow.error).toMatch(/^Timeout:/)

    // 带预算的路径：同一条命令、同一台服务器，等得到
    const t0 = performance.now()
    const waited = await budgetedCall('ZSpectr_Start', 1, 1, '')
    const elapsedMs = performance.now() - t0
    expect(waited.error).toBeUndefined()
    // 真的等到了那个迟到的回复（比缺省超时长），而不是别的原因提前返回
    expect(elapsedMs).toBeGreaterThan(SHORT_MS)
  })
})

describe('模块首次加载的宽限 · 缩比的真 TCP', () => {
  it('I5 Open 与紧跟它的那一条等得到迟到的回复，再下一条照常按缺省超时', async () => {
    // 宽限是 30 s 的下限，与缩比的缺省超时（60 ms）无关；回复 200 ms 才到，只有带宽限的两条等得到
    const SHORT_MS = 60
    const LATE_MS = 200
    const timers: NodeJS.Timeout[] = []
    cleanup.push(() => timers.forEach((t) => clearTimeout(t)))
    const server = await fakeServer((sock, frame) => {
      timers.push(setTimeout(() => replyOk(sock, frame), LATE_MS))
    })
    const port = (server.address() as AddressInfo).port
    const svc = serviceWith((_role, p) => new RoleLink({ port: p, timeoutMs: SHORT_MS }), { main: port })

    const open = await svc.call('ZSpectr_Open', [])
    const next = await svc.call('ZSpectr_RangeSet', [0, 1e-9])
    const third = await svc.call('ZSpectr_PropsSet', [1, 128, 1, 1, 2, 1])
    expect(open.error).toBeUndefined()
    expect(next.error).toBeUndefined()
    expect(third.error).toMatch(/^Timeout:/)
    expect(third.transport).toEqual({ kind: 'Timeout', maybeDelivered: true })
  })
})
