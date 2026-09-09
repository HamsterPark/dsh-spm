/**
 * 一个角色一条 TCP 连接。单往返、有界等待、优雅关闭。
 *
 * 上面还有两层，都不在这里：熔断在课时 1.5，角色路由与 `ctx.instrument` 在 1.6。
 * 这一层只管「一条连接上一次干净的往返」。
 *
 * 三条硬约束来自旧仓真机事故（PLAN §3.2-9）：
 *   1. **强杀会永久损坏端口** ⇒ 只 `end()` 发 FIN，**永不 `destroy()` 在途请求**；
 *      关闭时先有界等待在途那一次做完。
 *   2. **回声必须逐字节相符** ⇒ 不符意味着流已失步，唯一安全处置是断链，不是返回 `[]`。
 *   3. **空回包 = 断链**，不是「这次没数据」。
 *
 * 错误消息一律带机器可判的前缀（`RoleBusy:` / `Timeout:` / `EmptyReply:` / `WrongEcho:` /
 * `NotConnected:`），上层按前缀分流——**不靠解析中文**（PLAN §3.2-16：判据不落在文案上）。
 */
import { Socket } from 'node:net'
import { HEADER_LEN, encodeRequestFrame, echoMatches, parseReplyHeader } from './frame.js'

/** Nanonis 侧 5 秒收超时是硬约束，不是可调偏好。 */
export const DEFAULT_TIMEOUT_MS = 5_000
/** 拿不到连接就等这么久；超时返回 `RoleBusy:`，**不排队**。 */
export const DEFAULT_WAIT_MS = 30_000

export class RoleLinkError extends Error {
  override readonly name = 'RoleLinkError'
  constructor(
    message: string,
    /** 机器可判前缀，例如 `'RoleBusy'`。上层按它分流，别去匹配 message。 */
    readonly kind: 'RoleBusy' | 'Timeout' | 'EmptyReply' | 'WrongEcho' | 'NotConnected' | 'SocketError',
  ) {
    super(`${kind}: ${message}`)
  }
}

export interface RoleLinkOptions {
  readonly host?: string
  readonly port: number
  readonly timeoutMs?: number
  readonly waitMs?: number
}

export interface RequestOptions {
  readonly timeoutMs?: number
  /** 急停走 2 s、关闭走 5 s（PLAN §7.1）；默认 30 s。 */
  readonly waitMs?: number
}

export class RoleLink {
  readonly host: string
  readonly port: number
  private readonly defaultTimeoutMs: number
  private readonly defaultWaitMs: number

  private socket: Socket | null = null
  /** 在途的那一次往返。同一时刻至多一个——Node 是单线程，但 await 之间会交错。 */
  private inFlight: Promise<unknown> | null = null

  constructor(opts: RoleLinkOptions) {
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.defaultWaitMs = opts.waitMs ?? DEFAULT_WAIT_MS
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const s = new Socket()
      s.setNoDelay(true) // 单往返协议，攒包只会让每次调用多等一个 RTT
      const onError = (e: Error) => {
        s.destroy()
        reject(new RoleLinkError(`连接 ${this.host}:${this.port} 失败：${e.message}`, 'SocketError'))
      }
      s.once('error', onError)
      s.connect(this.port, this.host, () => {
        s.off('error', onError)
        s.on('error', () => {}) // 之后的错误由每次 request 自己处理，别让它变成未捕获异常
        this.socket = s
        resolve()
      })
    })
  }

  /**
   * 发一条命令，等它那一条回复。**返回 body**（帧头已剥掉，错误段仍在尾部）。
   *
   * 等不到连接空闲就返回 `RoleBusy:` 而**不排队**——排队会让一次卡住的调用把后面所有
   * 调用一起拖死，而仪器控制里「现在做不了」是个正常答案，「十分钟后才做」不是。
   */
  async request(command: string, body: Uint8Array, opts: RequestOptions = {}): Promise<Uint8Array> {
    const waitMs = opts.waitMs ?? this.defaultWaitMs
    await this.acquire(waitMs, command)
    const run = this.roundTrip(command, body, opts.timeoutMs ?? this.defaultTimeoutMs)
    this.inFlight = run.catch(() => {}) // 锁只关心「做完了没」，不关心成败
    try {
      return await run
    } finally {
      this.inFlight = null
    }
  }

  /** 有界等待锁。等到了就占住；等不到抛 `RoleBusy:`，且**不留下等待者**。 */
  private async acquire(waitMs: number, command: string): Promise<void> {
    const deadline = Date.now() + waitMs
    while (this.inFlight !== null) {
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new RoleLinkError(`${command} 等 ${waitMs}ms 仍未拿到 ${this.port} 端口的连接`, 'RoleBusy')
      }
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        this.inFlight,
        new Promise((r) => {
          timer = setTimeout(r, left)
        }),
      ])
      clearTimeout(timer)
      // 醒来后可能被别的等待者抢先——所以是 while 不是 if
    }
  }

  private roundTrip(command: string, body: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    const s = this.socket
    if (s === null || s.destroyed) {
      return Promise.reject(new RoleLinkError(`${command}：连接未建立或已关闭`, 'NotConnected'))
    }
    const frame = encodeRequestFrame(command, body, true)
    const sentName = frame.slice(0, 32)

    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = []
      let done = false
      const finish = (fn: () => void) => {
        if (done) return
        done = true
        clearTimeout(timer)
        s.off('data', onData)
        s.off('close', onClose)
        s.off('error', onError)
        fn()
      }
      /** 断链：只 end() 发 FIN，绝不 destroy——强杀会永久损坏端口。 */
      const drop = (err: RoleLinkError) =>
        finish(() => {
          this.socket = null
          s.end()
          reject(err)
        })

      const timer = setTimeout(
        () => drop(new RoleLinkError(`${command} 超过 ${timeoutMs}ms 未收到回复`, 'Timeout')),
        timeoutMs,
      )

      const onData = (d: Buffer) => {
        chunks.push(d)
        const all = Buffer.concat(chunks)
        if (all.length < HEADER_LEN) return
        const header = parseReplyHeader(new Uint8Array(all.subarray(0, HEADER_LEN)))
        if (all.length < HEADER_LEN + header.bodySize) return // 分片，继续攒
        if (!echoMatches(sentName, header.rawName)) {
          drop(new RoleLinkError(`发的是 ${command}，回的是 ${JSON.stringify(header.name)}`, 'WrongEcho'))
          return
        }
        finish(() => resolve(new Uint8Array(all.subarray(HEADER_LEN, HEADER_LEN + header.bodySize))))
      }

      // 对端先关 = 空回包。这不是「这次没数据」，是链路没了。
      const onClose = () =>
        drop(new RoleLinkError(`${command}：对端在回复前关闭了连接（收到 ${chunks.length} 个分片）`, 'EmptyReply'))
      const onError = (e: Error) => drop(new RoleLinkError(`${command}：${e.message}`, 'SocketError'))

      s.on('data', onData)
      s.once('close', onClose)
      s.once('error', onError)
      s.write(frame)
    })
  }

  /**
   * 优雅关闭：先有界等在途那一次做完，再发 FIN。
   * 等不到也**只 end() 不 destroy**——宁可留一个半开连接给 OS 回收，也不冒永久损坏端口的险。
   */
  async close(waitMs = 5_000): Promise<void> {
    const s = this.socket
    this.socket = null
    if (s === null) return
    if (this.inFlight !== null) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        this.inFlight,
        new Promise((r) => {
          timer = setTimeout(r, waitMs)
        }),
      ])
      clearTimeout(timer)
    }
    await new Promise<void>((resolve) => {
      s.once('close', () => resolve())
      s.end()
      setTimeout(resolve, 1_000).unref() // 对端不回 FIN 也别把关闭挂住
    })
  }
}
