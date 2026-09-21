import { connect, type Socket } from 'node:net'

export type NativeReadCommand = 'Bias.Get' | 'Scan.StatusGet' | 'ZCtrl.OnOffGet'

/** Independent read-only Nanonis probe. One connection for the entire acceptance run. */
export class NativeReadProbe {
  private socket: Socket | undefined
  private connecting: Promise<void> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private buffer = Buffer.alloc(0)
  private failure: Error | undefined
  private closing = false
  private closed = false
  private pending: {
    command: NativeReadCommand; header: Buffer; timer: NodeJS.Timeout
    resolve: (value: number) => void; reject: (error: Error) => void
  } | undefined

  private readonly port: number
  private readonly timeoutMs: number
  constructor(port: number, timeoutMs = 5_000) {
    this.port = port
    this.timeoutMs = timeoutMs
  }

  read(command: NativeReadCommand): Promise<number> {
    const result = this.tail.then(() => this.request(command))
    this.tail = result.catch(() => {})
    return result
  }

  private fail(error: Error): void {
    this.failure ??= error
    if (this.pending) {
      const pending = this.pending
      this.pending = undefined
      clearTimeout(pending.timer)
      pending.reject(this.failure)
    }
    // Never issue RST when a native Nanonis request is still in flight.
    this.socket?.end()
    this.socket?.unref()
  }

  private async connected(): Promise<void> {
    if (this.failure) throw this.failure
    if (this.closing || this.closed) throw new Error('native probe is closed')
    if (this.connecting) return this.connecting
    const socket = connect({ host: '127.0.0.1', port: this.port })
    this.socket = socket
    socket.on('data', (chunk) => this.receive(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => {
      this.closed = true
      if (this.pending) this.fail(new Error(`${this.pending.command}: connection closed before complete reply`))
    })
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) { this.fail(error); reject(error) } else resolve()
      }
      const timer = setTimeout(() => finish(new Error('native probe connect timeout')), this.timeoutMs)
      socket.once('connect', () => finish())
      socket.once('error', finish)
      socket.once('close', () => finish(new Error('native probe closed during connect')))
    })
    return this.connecting
  }

  private async request(command: NativeReadCommand): Promise<number> {
    await this.connected()
    if (this.failure) throw this.failure
    if (this.closing) throw new Error('native probe is closing')
    const header = Buffer.alloc(40)
    Buffer.from(command).copy(header)
    header.writeUInt16BE(1, 36)
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`${command}: timeout`)), this.timeoutMs)
      this.pending = { command, header, timer, resolve, reject }
      this.socket!.write(header, (error) => { if (error) this.fail(error) })
    })
  }

  private receive(chunk: Buffer): void {
    if (this.failure || this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    const pending = this.pending
    if (!pending) { this.fail(new Error('native probe received an unsolicited reply')); return }
    if (this.buffer.length < 40) return
    const size = this.buffer.readUInt32BE(32)
    if (size < 12 || size > 1024 * 1024) { this.fail(new Error(`${pending.command}: invalid reply size`)); return }
    if (!this.buffer.subarray(0, 32).equals(pending.header.subarray(0, 32))) { this.fail(new Error(`${pending.command}: wrong reply echo`)); return }
    if (this.buffer.length < 40 + size) return
    const body = this.buffer.subarray(40, 40 + size)
    const status = body.readUInt32BE(4), errorSize = body.readUInt32BE(8)
    if (errorSize > size - 12) { this.fail(new Error(`${pending.command}: invalid error length`)); return }
    if (status !== 0) { this.fail(new Error(`${pending.command}: ${body.subarray(12, 12 + errorSize).toString('utf8')}`)); return }
    const value = pending.command === 'Bias.Get' ? body.readFloatBE(0) : body.readUInt32BE(0)
    if (!Number.isFinite(value)) { this.fail(new Error(`${pending.command}: non-finite result`)); return }
    this.buffer = this.buffer.subarray(40 + size)
    if (this.buffer.length !== 0) { this.fail(new Error(`${pending.command}: unexpected trailing reply`)); return }
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  async close(): Promise<void> {
    this.closing = true
    await this.tail
    const socket = this.socket
    if (!socket || this.closed) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.unref(); resolve() }, 1_000)
      socket.once('close', () => { clearTimeout(timer); resolve() })
      socket.end()
    })
  }
}
