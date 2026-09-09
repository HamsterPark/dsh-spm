import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HEADER_LEN, encodeRequestFrame } from './frame.js'
import { RoleLink, RoleLinkError } from './role-link.js'
import { decodeReturns, encodeArg } from './types.js'

/**
 * 用进程内假服务器而不是真 stmsim：这里要测的是**故障**——回声不符、空回包、超时、
 * 并发抢锁——真模拟器不会按需产生这些。与真 stmsim 的往返在 `integration/` 里。
 */
type Handler = (sock: Socket, frame: Buffer) => void

async function fakeServer(handler: Handler): Promise<{ port: number; server: Server }> {
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
    sock.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as { port: number }).port, server }
}

/** 正常回复：逐字回声名字段 + body + 零错误段。 */
function replyOk(sock: Socket, frame: Buffer, body: Uint8Array = new Uint8Array()): void {
  const err = Buffer.alloc(8) // status=0, desc_len=0
  const full = Buffer.concat([Buffer.from(body), err])
  const head = Buffer.concat([frame.subarray(0, 32), Buffer.alloc(8)])
  head.writeUInt32BE(full.length, 32)
  sock.write(Buffer.concat([head, full]))
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

async function link(handler: Handler, opts: { timeoutMs?: number; waitMs?: number } = {}) {
  const { port, server } = await fakeServer(handler)
  const l = new RoleLink({ port, ...opts })
  await l.connect()
  cleanup.push(async () => {
    await l.close(100)
    await new Promise<void>((r) => server.close(() => r()))
  })
  return l
}

describe('正常往返', () => {
  it('拿回 body，帧头已剥掉、错误段还在尾部', async () => {
    const l = await link((s, f) => replyOk(s, f, encodeArg(1.5, 'f')))
    const body = await l.request('Bias.Get', new Uint8Array())
    const { values, errorSection } = decodeReturns(body, ['f'])
    expect(values).toEqual([1.5])
    expect(errorSection.length).toBe(8)
  })

  it('回复分成多个 TCP 分片也能拼回来', async () => {
    const l = await link((s, f) => {
      const err = Buffer.alloc(8)
      const full = Buffer.concat([Buffer.from(encodeArg(2.5, 'f')), err])
      const head = Buffer.concat([f.subarray(0, 32), Buffer.alloc(8)])
      head.writeUInt32BE(full.length, 32)
      const whole = Buffer.concat([head, full])
      // 故意切在帧头中间——真 TCP 随时会这么干
      s.write(whole.subarray(0, 17))
      setTimeout(() => s.write(whole.subarray(17, 41)), 5)
      setTimeout(() => s.write(whole.subarray(41)), 10)
    })
    const { values } = decodeReturns(await l.request('Bias.Get', new Uint8Array()), ['f'])
    expect(values).toEqual([2.5])
  })
})

describe('三条硬约束', () => {
  it('回声不符 ⇒ WrongEcho 并断链（不是返回空数组）', async () => {
    const l = await link((s, f) => {
      const wrong = Buffer.concat([f.subarray(0, 40)])
      Buffer.from('Other.Verb').copy(wrong, 0) // 名字段改掉
      wrong.writeUInt32BE(8, 32)
      s.write(Buffer.concat([wrong, Buffer.alloc(8)]))
    })
    await expect(l.request('Bias.Get', new Uint8Array())).rejects.toThrow(/^WrongEcho:/)
    // 断链意味着后续调用要先重连——不匹配代表流已失步，继续用这条连接只会读到更多别人的回复
    expect(l.connected).toBe(false)
  })

  it('对端在回复前关闭 ⇒ EmptyReply（不是「这次没数据」）', async () => {
    const l = await link((s) => s.end())
    await expect(l.request('Bias.Get', new Uint8Array())).rejects.toThrow(/^EmptyReply:/)
    expect(l.connected).toBe(false)
  })

  it('超时 ⇒ Timeout 并断链', async () => {
    const l = await link(() => {}, { timeoutMs: 60 }) // 服务器什么都不回
    await expect(l.request('Bias.Get', new Uint8Array())).rejects.toThrow(/^Timeout:/)
    expect(l.connected).toBe(false)
  })
})

describe('有界等待，不排队', () => {
  it('第二个调用等不到就 RoleBusy，而不是排在后面', async () => {
    let release: (() => void) | undefined
    const l = await link((s, f) => {
      release = () => replyOk(s, f)
    })
    const first = l.request('Slow.Verb', new Uint8Array(), { timeoutMs: 2_000 })
    await new Promise((r) => setTimeout(r, 20)) // 让 first 真正占住锁
    // 「现在做不了」在仪器控制里是正常答案，「十分钟后才做」不是
    await expect(l.request('Bias.Get', new Uint8Array(), { waitMs: 30 })).rejects.toThrow(/^RoleBusy:/)
    release!()
    await expect(first).resolves.toBeInstanceOf(Uint8Array)
  })

  it('前一个做完后，锁能被下一个拿到', async () => {
    const l = await link((s, f) => replyOk(s, f))
    await l.request('A.Verb', new Uint8Array())
    await expect(l.request('B.Verb', new Uint8Array())).resolves.toBeInstanceOf(Uint8Array)
  })
})

describe('优雅关闭', () => {
  it('close 会等在途那一次做完，不掐断它', async () => {
    let release: (() => void) | undefined
    const l = await link((s, f) => {
      release = () => replyOk(s, f)
    })
    const inFlight = l.request('Slow.Verb', new Uint8Array(), { timeoutMs: 2_000 })
    await new Promise((r) => setTimeout(r, 20))
    const closing = l.close(1_000)
    release!()
    // 强杀在途请求会永久损坏 Nanonis 端口（PLAN §3.2-9），所以这一条必须是 resolve 不是 reject
    await expect(inFlight).resolves.toBeInstanceOf(Uint8Array)
    await closing
  })

  it('没连接时 request 明确报 NotConnected', async () => {
    const l = new RoleLink({ port: 1 })
    await expect(l.request('Bias.Get', new Uint8Array())).rejects.toThrow(/^NotConnected:/)
  })
})

describe('错误按前缀分流，不靠解析文案', () => {
  it('kind 字段是机器可判的', async () => {
    const l = await link(() => {}, { timeoutMs: 40 })
    const e = await l.request('X.Y', new Uint8Array()).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(RoleLinkError)
    expect((e as RoleLinkError).kind).toBe('Timeout')
  })
})

describe('发出的帧就是我们成帧器产的', () => {
  it('服务器收到的字节与 encodeRequestFrame 一致', async () => {
    let seen: Buffer | undefined
    const l = await link((s, f) => {
      seen = Buffer.from(f)
      replyOk(s, f)
    })
    const body = encodeArg(1.5, 'f')
    await l.request('Bias.Set', body)
    expect(seen!.toString('hex')).toBe(
      Buffer.from(encodeRequestFrame('Bias.Set', body, true)).toString('hex'),
    )
  })
})
