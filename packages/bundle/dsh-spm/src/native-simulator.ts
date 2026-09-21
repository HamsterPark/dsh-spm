/** Attach to an existing Windows Mimea + Sim-Engine pair; never own either process. */
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { type Context } from 'dsh-spm-compat'
import { InstrumentService, type CallOptions, type CallRecord, type LinkFactory } from 'dsh-spm-instrument'
import { REFRESH_VERBS } from 'dsh-spm-instrument-state'
import { NANONIS_METHODS, RoleLink, type RequestOptions } from 'dsh-spm-nanonis-wire'

const exec = promisify(execFile)
const DEFAULT_NATIVE_PORTS = [6501, 6502, 6503, 6504] as const
const ENGINE_PORTS = [6555, 6556, 6557] as const

export interface NativeSimulatorOptions {
  readonly pid: number
  readonly ports?: readonly number[]
}

export interface NativeProcessIdentity {
  readonly pid: number
  readonly parentPid: number
  readonly executable: string
  readonly createdAt: string
}

export interface NativeTcpConnection {
  readonly pid: number
  readonly localAddress: string
  readonly localPort: number
  readonly remoteAddress: string
  readonly remotePort: number
  readonly state: 'Listen' | 'Established'
}

export interface NativeSimulatorSnapshot {
  readonly processes: readonly NativeProcessIdentity[]
  readonly connections: readonly NativeTcpConnection[]
}

export interface NativeSimulatorIdentity {
  readonly mimea: NativeProcessIdentity
  readonly engine: NativeProcessIdentity
}

type SnapshotReader = () => Promise<NativeSimulatorSnapshot>

/** A single OS snapshot; no command text contains caller-provided strings. */
export async function inspectNativeSimulator(): Promise<NativeSimulatorSnapshot> {
  if (process.platform !== 'win32') throw new Error('native_simulator_unsupported: Windows is required')
  const script = `
$ErrorActionPreference = 'Stop'
$nativeProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Nanonis Mimea.exe', 'Sim-Engine.exe') } | ForEach-Object {
  @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; executable = $_.ExecutablePath; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') }
})
$nativeConnections = @(Get-NetTCPConnection -State Listen,Established | ForEach-Object {
  @{ pid = [int]$_.OwningProcess; localAddress = $_.LocalAddress; localPort = [int]$_.LocalPort; remoteAddress = $_.RemoteAddress; remotePort = [int]$_.RemotePort; state = $_.State.ToString() }
})
@{ processes = $nativeProcesses; connections = $nativeConnections } | ConvertTo-Json -Depth 5 -Compress
`
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15_000, maxBuffer: 4_000_000,
  })
  const value = JSON.parse(stdout.trim()) as NativeSimulatorSnapshot
  if (!Array.isArray(value.processes) || !Array.isArray(value.connections)) {
    throw new Error('native_simulator_identity: incomplete OS snapshot')
  }
  return value
}

function pathKey(value: string): string { return win32.normalize(value).toLowerCase() }
function loopback(value: string): boolean { return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' }
function localListener(value: string): boolean { return loopback(value) || value === '0.0.0.0' || value === '::' }
function sameProcess(a: NativeProcessIdentity, b: NativeProcessIdentity): boolean {
  return a.pid === b.pid && a.createdAt === b.createdAt && pathKey(a.executable) === pathKey(b.executable)
}
function validProcess(value: NativeProcessIdentity | undefined): value is NativeProcessIdentity {
  return value !== undefined && Number.isInteger(value.pid) && value.pid > 0 &&
    typeof value.executable === 'string' && win32.isAbsolute(value.executable) &&
    typeof value.createdAt === 'string' && value.createdAt.length > 0
}

/** Require both ends of all three local engine connections, not just an engine process name. */
export function verifyNativeSimulator(
  options: NativeSimulatorOptions,
  snapshot: NativeSimulatorSnapshot,
  expected?: NativeSimulatorIdentity,
): NativeSimulatorIdentity {
  const fail = (reason: string): never => { throw new Error(`native_simulator_identity: ${reason}`) }
  const mimea = snapshot.processes.find((item) => item.pid === options.pid)
  if (!validProcess(mimea) || win32.basename(mimea.executable).toLowerCase() !== 'nanonis mimea.exe') {
    return fail('requested PID is not an identifiable Nanonis Mimea.exe process')
  }
  const enginePath = win32.join(win32.dirname(mimea.executable), 'RT-Engine', 'Sim', 'Sim-Engine.exe')
  const engines = snapshot.processes.filter((item) => validProcess(item) && item.parentPid === mimea.pid && pathKey(item.executable) === pathKey(enginePath))
  if (engines.length !== 1) return fail('Mimea must have one identifiable sibling RT-Engine\\Sim\\Sim-Engine.exe child')
  const engine = engines[0]!
  if (expected !== undefined && (!sameProcess(mimea, expected.mimea) || !sameProcess(engine, expected.engine))) {
    return fail('pinned Mimea or Sim-Engine process identity changed')
  }
  for (const port of options.ports ?? DEFAULT_NATIVE_PORTS) {
    const listeners = snapshot.connections.filter((item) => item.state === 'Listen' && item.localPort === port && localListener(item.localAddress))
    if (listeners.length === 0 || listeners.some((item) => item.pid !== mimea.pid)) {
      return fail(`TCP port ${port} is not exclusively owned by the pinned Mimea process`)
    }
  }
  for (const port of ENGINE_PORTS) {
    const listeners = snapshot.connections.filter((item) => item.state === 'Listen' && item.localPort === port && localListener(item.localAddress))
    if (listeners.length === 0 || listeners.some((item) => item.pid !== engine.pid)) return fail(`simulator backend port ${port} changed owner`)
    const connected = snapshot.connections.some((client) => client.state === 'Established' && client.pid === mimea.pid &&
      client.remotePort === port && loopback(client.localAddress) && loopback(client.remoteAddress) &&
      snapshot.connections.some((server) => server.state === 'Established' && server.pid === engine.pid &&
        server.localPort === client.remotePort && server.remotePort === client.localPort &&
        server.localAddress === client.remoteAddress && server.remoteAddress === client.localAddress))
    if (!connected) return fail(`Mimea is not connected over loopback to its Sim-Engine on ${port}`)
  }
  // An engine process can remain open while Mimea is switched to another backend.
  if (snapshot.connections.some((item) => item.state === 'Established' && item.pid === mimea.pid &&
    (ENGINE_PORTS as readonly number[]).includes(item.remotePort) && (!loopback(item.localAddress) || !loopback(item.remoteAddress)))) {
    return fail('Mimea has a non-loopback instrument backend connection')
  }
  return { mimea: { ...mimea }, engine: { ...engine } }
}

export class NativeSimulatorConnection {
  readonly ports: readonly number[]
  private attached = false
  private epoch = 0
  private pinned: NativeSimulatorIdentity | undefined
  private verification: Promise<void> | undefined

  constructor(readonly options: NativeSimulatorOptions, private readonly inspect: SnapshotReader = inspectNativeSimulator) {
    if (!Number.isInteger(options.pid) || options.pid <= 0) throw new Error('native_simulator_config: pid must be a positive integer')
    const ports = [...(options.ports ?? DEFAULT_NATIVE_PORTS)]
    if (ports.length !== 4 || new Set(ports).size !== 4 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
      throw new Error('native_simulator_config: four distinct TCP ports in 1024..65535 are required')
    }
    this.ports = Object.freeze(ports)
  }

  /** Attachment state, not a claim that a cached process snapshot is current. */
  get running(): boolean { return this.attached }
  get identity(): NativeSimulatorIdentity | undefined {
    return this.pinned === undefined ? undefined : { mimea: { ...this.pinned.mimea }, engine: { ...this.pinned.engine } }
  }

  async start(): Promise<void> {
    if (this.attached) return this.assertCurrent()
    const epoch = ++this.epoch
    const identity = verifyNativeSimulator({ pid: this.options.pid, ports: this.ports }, await this.inspect())
    if (epoch !== this.epoch) throw new Error('native_simulator_detached: attachment cancelled')
    this.pinned = identity
    this.attached = true
  }

  assertRunning(): void {
    if (!this.attached) throw new Error('native_simulator_detached: simulator is not attached; no command was sent')
  }

  assertOwned(): Promise<void> { return this.assertCurrent() }

  /** Fresh identity check at every tool boundary and immediately before each new connection. */
  async assertCurrent(): Promise<void> {
    this.assertRunning()
    if (this.verification !== undefined) return this.verification
    const epoch = this.epoch
    const run = (async () => {
      try {
        const snapshot = await this.inspect()
        this.assertRunning()
        if (epoch !== this.epoch) throw new Error('native_simulator_detached: attachment changed during identity check')
        verifyNativeSimulator({ pid: this.options.pid, ports: this.ports }, snapshot, this.pinned)
      } catch (error) {
        if (epoch === this.epoch) this.attached = false
        throw error
      }
    })()
    this.verification = run
    try { await run } finally { if (this.verification === run) this.verification = undefined }
  }

  /** Detach only. Never send process signals or close the user's simulator application. */
  async stop(): Promise<void> { this.attached = false; this.epoch += 1 }
}

export const NATIVE_SIMULATOR_METHOD_NAMES = Object.freeze([...new Set([
  ...REFRESH_VERBS.map(([method]) => method),
  'Bias_Set', 'ZCtrl_OnOffGet', 'Scan_Action', 'Scan_PropsGet', 'Scan_PropsSet', 'Scan_BufferGet', 'Scan_SpeedGet',
])])

const nativeMethods = Object.fromEntries(NATIVE_SIMULATOR_METHOD_NAMES.map((method) => {
  const spec = NANONIS_METHODS[method as keyof typeof NANONIS_METHODS]
  if (spec === undefined) throw new Error(`native_simulator_config: unknown protocol method ${method}`)
  return [method, spec]
}))
const nativeCommands = new Set<string>(Object.values(nativeMethods).map((spec) => spec.command))

/** Validate at the wire boundary as typed facade methods bypass InstrumentService.call(). */
function assertPermittedRequest(command: string, body: Uint8Array): void {
  if (!nativeCommands.has(command)) throw new Error(`native_simulator_method_blocked: ${command}`)
  const data = Buffer.from(body)
  if (command === 'Bias.Set') {
    const bias = data.length === 4 ? data.readFloatBE(0) : Number.NaN
    if (!Number.isFinite(bias) || Math.abs(bias) > 10) throw new Error('native_simulator_argument_blocked: Bias.Set requires a finite value within ±10 V')
  }
  if (command === 'Scan.Action') {
    if (data.length !== 6 || ![0, 1].includes(data.readUInt16BE(0)) || ![0, 1].includes(data.readUInt32BE(2))) {
      throw new Error('native_simulator_argument_blocked: only scan start/stop with direction 0/1 are permitted')
    }
  }
}

class NativeSimulatorLink extends RoleLink {
  constructor(private readonly simulator: NativeSimulatorConnection, private readonly link: RoleLink, port: number) {
    super({ host: '127.0.0.1', port })
  }
  override get connected(): boolean { return this.link.connected }
  override async connect(): Promise<void> {
    await this.simulator.assertCurrent()
    await this.link.connect()
    try { this.simulator.assertRunning() } catch (error) { await this.link.close(); throw error }
  }
  override request(command: string, body: Uint8Array, opts?: RequestOptions): Promise<Uint8Array> {
    this.simulator.assertRunning()
    assertPermittedRequest(command, body)
    return this.link.request(command, body, opts)
  }
  override close(waitMs?: number): Promise<void> { return this.link.close(waitMs) }
}

export class NativeSimulatorInstrument extends InstrumentService {
  constructor(ctx: Context, private readonly simulator: NativeSimulatorConnection, createLink: LinkFactory = (_role, port) => new RoleLink({ host: '127.0.0.1', port })) {
    const [main, monitor, data, emergency] = simulator.ports
    super(ctx, nativeMethods, {
      simulated: true,
      ports: { main: main!, monitor: monitor!, data: data!, emergency: emergency! },
      createLink: (role, port) => new NativeSimulatorLink(simulator, createLink(role, port), port),
    })
  }

  override call(method: string, args: readonly unknown[], opts: CallOptions = {}): Promise<CallRecord> {
    if (!this.simulator.running) return Promise.resolve({
      method, command: nativeMethods[method]?.command ?? method, role: opts.role ?? 'main',
      args: args.map((value) => ({ value, fmt: '' })),
      error: 'native_simulator_detached: simulator is not attached; no command was sent',
      elapsedMs: 0, at: Date.now(), simulated: true,
    })
    return super.call(method, args, opts)
  }

  override urgentCall(method: string, args: readonly unknown[] = []): Promise<CallRecord> {
    return this.call(method, args, { role: 'emergency', lockTimeoutMs: 2_000, countHealth: false })
  }
}
