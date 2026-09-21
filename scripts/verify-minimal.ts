#!/usr/bin/env node
/**
 * Installed-artifact acceptance runner for docs/MINIMUM-USABLE-PLAN.md M3/M4.
 *
 * This file deliberately has no workspace imports.  Resolve every runtime module
 * from --install-dir so a successful run proves that the copied tarball and its
 * installed dependency closure work without reaching back into this checkout.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface Options {
  command: 'values' | 'failure' | 'inspect' | 'model'
  installDir: string
  packageName: string
  python?: string
  simulatorRoot?: string
  ports: number[]
  recordsPath: string
  resultsPath: string
  evidencePath: string
  values: number[]
  tolerance: number
  runId: string
  dshHome?: string
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}`)
  console.error(`usage:
  node scripts/verify-minimal.ts values --install-dir DIR --python FILE --simulator-root DIR --ports P1,P2,P3,P4 --records FILE --results FILE --evidence FILE [--values 0.125,-0.375]
  node scripts/verify-minimal.ts failure --install-dir DIR --python FILE --simulator-root DIR --ports P1,P2,P3,P4 --records FILE --results FILE --evidence FILE
  node scripts/verify-minimal.ts inspect --install-dir DIR --records FILE --results FILE --evidence FILE
  node scripts/verify-minimal.ts model --install-dir DIR --records FILE --results FILE --evidence FILE

values starts the packaged runtime, sets two simulator values through the raw
Nanonis protocol, independently reads Bias.Get, and invokes GetBias through the
real dsh ToolRuntime dispatcher. failure stops the runtime-owned simulator (the
provider must expose stopSimulator), then proves GetBias fails and leaves a
durable result. inspect runs in a new process and only reads persisted evidence.
model mode is intentionally delegated to scripts/model-minimal.ts, which owns
native dsh session-event correlation; M3 JSONL is never treated as M4 proof.`)
  process.exit(2)
}

function parseArgs(argv: string[]): Options {
  const command = argv.shift() as Options['command'] | undefined
  if (!command || !['values', 'failure', 'inspect', 'model'].includes(command)) usage()
  const flags = new Map<string, string>()
  while (argv.length > 0) {
    const key = argv.shift()!
    if (!key.startsWith('--')) usage(`unexpected argument ${key}`)
    const value = argv.shift()
    if (value === undefined || value.startsWith('--')) usage(`missing value for ${key}`)
    flags.set(key.slice(2), value)
  }
  const required = (name: string): string => flags.get(name) ?? usage(`--${name} is required`)
  const installDir = resolve(required('install-dir'))
  const recordsPath = resolve(required('records'))
  const resultsPath = resolve(required('results'))
  const evidencePath = resolve(required('evidence'))
  const ports = (flags.get('ports') ?? '').split(',').filter(Boolean).map(Number)
  if ((command === 'values' || command === 'failure') && ports.length !== 4) usage('--ports must contain four comma-separated ports')
  if (ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)) usage('ports must be integers in 1024..65535')
  const values = (flags.get('values') ?? '0.125,-0.375').split(',').map(Number)
  if (values.length !== 2 || values.some((v) => !Number.isFinite(v) || Math.abs(v) > 10) || values[0] === values[1]) {
    usage('--values must contain two distinct finite voltages within ±10 V')
  }
  const python = flags.get('python')
  const simulatorRoot = flags.get('simulator-root')
  if ((command === 'values' || command === 'failure') && (!python || !simulatorRoot)) {
    usage(`${command} requires --python and --simulator-root`)
  }
  const tolerance = Number(flags.get('tolerance') ?? '0.000001')
  if (!Number.isFinite(tolerance) || tolerance <= 0) usage('--tolerance must be a finite positive number')
  return {
    command, installDir, packageName: flags.get('package') ?? 'dsh-spm',
    python, simulatorRoot, ports,
    recordsPath, resultsPath, evidencePath, values,
    tolerance,
    runId: flags.get('run-id') ?? randomUUID(),
    dshHome: flags.get('dsh-home') === undefined ? process.env['DSH_HOME'] : resolve(flags.get('dsh-home')!),
  }
}

function within(child: string, parent: string): boolean {
  const r = relative(resolve(parent), resolve(child))
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r))
}

async function importFrom(req: NodeJS.Require, specifier: string): Promise<Record<string, any>> {
  return await import(pathToFileURL(req.resolve(specifier)).href) as Record<string, any>
}

async function packageFact(req: NodeJS.Require, name: string): Promise<{ version: string; packageJson: string }> {
  const packageJson = req.resolve(`${name}/package.json`)
  const pkg = JSON.parse(await readFile(packageJson, 'utf8')) as { version?: string }
  return { version: pkg.version ?? 'unknown', packageJson }
}

const HEADER = 40
function requestFrame(name: string, body: Uint8Array): Buffer {
  const encoded = Buffer.from(name, 'utf8')
  if (encoded.length > 32) throw new Error(`wire command too long: ${name}`)
  const out = Buffer.alloc(HEADER + body.length)
  encoded.copy(out)
  out.writeUInt32BE(body.length, 32)
  out.writeUInt16BE(1, 36)
  Buffer.from(body).copy(out, HEADER)
  return out
}

async function rawRequest(port: number, name: string, body = new Uint8Array()): Promise<Buffer> {
  const frame = requestFrame(name, body)
  return await new Promise((resolveReply, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => finish(new Error(`${name}: timeout`)), 5_000)
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      error ? reject(error) : resolveReply(value!)
    }
    socket.once('error', (e) => finish(e))
    socket.once('close', () => finish(new Error(`${name}: connection closed before a complete reply`)))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      if (all.length < HEADER) return
      const size = all.readUInt32BE(32)
      if (all.length < HEADER + size) return
      if (!all.subarray(0, 32).equals(frame.subarray(0, 32))) return finish(new Error(`${name}: wrong echo`))
      finish(undefined, all.subarray(HEADER, HEADER + size))
    })
    socket.once('connect', () => socket.write(frame))
  })
}

function checkError(body: Buffer, valueBytes: number): void {
  if (body.length < valueBytes + 8) throw new Error(`short Nanonis response (${body.length} bytes)`)
  const status = body.readInt32BE(valueBytes)
  const length = body.readInt32BE(valueBytes + 4)
  if (status !== 0) throw new Error(`Nanonis status ${status}: ${body.subarray(valueBytes + 8, valueBytes + 8 + length).toString('utf8')}`)
}
async function setBias(port: number, value: number): Promise<void> {
  const arg = Buffer.alloc(4); arg.writeFloatBE(value)
  checkError(await rawRequest(port, 'Bias.Set', arg), 0)
}
async function readBias(port: number): Promise<number> {
  const body = await rawRequest(port, 'Bias.Get'); checkError(body, 4)
  return body.readFloatBE(0)
}

function resultText(result: any): string {
  return Array.isArray(result?.content) ? result.content.map((x: any) => typeof x?.text === 'string' ? x.text : '').join('\n') : ''
}
function biasFromResult(result: any): number {
  const text = resultText(result)
  const match = text.match(/(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*V\b/i)
  if (!match) throw new Error(`GetBias model-facing result has no numeric value with V unit: ${text.slice(0, 500)}`)
  const value = Number(match[1])
  if (!Number.isFinite(value)) throw new Error('GetBias returned a non-finite bias')
  return value
}

async function activate(o: Options): Promise<{ ctx: any; provider: any; fibers: any[]; facts: Json }> {
  const req = createRequire(join(o.installDir, 'package.json'))
  const pluginPath = req.resolve(`${o.packageName}/minimal`)
  if (!within(pluginPath, o.installDir)) throw new Error(`plugin resolved outside install dir: ${pluginPath}`)
  const dshReq = createRequire(req.resolve('@deepseek-ai/dsh/package.json'))
  const [cordis, prompt, tools, commands, helloPlugin, plugin, cordisFact] = await Promise.all([
    importFrom(dshReq, '@deepseek-ai/cordis'), importFrom(dshReq, '@deepseek-ai/dsh-system-prompt'),
    importFrom(dshReq, '@deepseek-ai/dsh-tools'), importFrom(dshReq, '@deepseek-ai/dsh-commands'),
    importFrom(req, o.packageName), import(pathToFileURL(pluginPath).href), packageFact(dshReq, '@deepseek-ai/cordis'),
  ])
  const dshPackages = [
    '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-commands',
  ]
  const dshFacts = await Promise.all(dshPackages.map(async (name) => ({ name, ...await packageFact(dshReq, name) })))
  const wrongVersions = dshFacts.filter((fact) => fact.version !== '0.1.5-rc.2')
  if (wrongVersions.length) throw new Error(`dsh packages must be 0.1.5-rc.2: ${wrongVersions.map((x) => `${x.name}=${x.version}`).join(', ')}`)
  if (cordisFact.version !== '4.0.2') throw new Error(`Cordis must be 4.0.2, got ${cordisFact.version}`)
  const pluginReq = createRequire(req.resolve(`${o.packageName}/package.json`))
  const pluginCordis = pluginReq.resolve('@deepseek-ai/cordis/package.json')
  if (resolve(pluginCordis) !== resolve(cordisFact.packageJson)) {
    throw new Error(`Cordis module identity split:\nhost ${cordisFact.packageJson}\nplugin ${pluginCordis}`)
  }
  const Context = cordis.Context
  const ctx = new Context()
  const fibers: any[] = [
    ctx.plugin(prompt.default ?? prompt.SystemPrompt),
    ctx.plugin(tools.default ?? tools.ToolRuntime, { mode: 'native' }),
    ctx.plugin(commands.default ?? commands.CommandRuntime ?? commands.Commands),
  ]
  await Promise.all(fibers.map((fiber) => fiber.await()))
  const config = {
    python: o.python, root: o.simulatorRoot, ports: o.ports,
    recordsPath: o.recordsPath, resultsPath: o.resultsPath, runId: o.runId,
  }
  const applicationFibers = [ctx.plugin(helloPlugin), ctx.plugin(plugin, config)]
  fibers.push(...applicationFibers)
  try {
    await Promise.all(applicationFibers.map((fiber) => fiber.await()))
  } catch (error) {
    await Promise.allSettled([...fibers].reverse().map((fiber) => fiber.dispose()))
    throw error
  }
  if (ctx.minimalSpm === undefined) {
    const states = fibers.map((fiber) => `${fiber.name}:${String(fiber.state)}`).join(', ')
    await Promise.allSettled([...fibers].reverse().map((fiber) => fiber.dispose()))
    throw new Error(
      `current minimal runtime did not provide ctx.minimalSpm (fibers ${states}; ` +
      `tools=${ctx.tools !== undefined}, systemPrompt=${ctx.systemPrompt !== undefined}, commands=${ctx.commands !== undefined})`,
    )
  }
  const names = ctx.tools.schemas().map((x: any) => x.name).filter((x: unknown): x is string => typeof x === 'string')
  const expectedNames = ['GetBias', 'stm_hello']
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expectedNames)) {
    await Promise.allSettled([...fibers].reverse().map((fiber) => fiber.dispose()))
    throw new Error(`tool catalog must be exactly ${expectedNames.join(', ')}; got ${names.sort().join(', ')}`)
  }
  return {
    ctx, provider: ctx.minimalSpm, fibers,
    facts: { pluginPath, cordisVersion: cordisFact.version, dshPackages: dshFacts, cordisPackageJson: cordisFact.packageJson, toolNames: expectedNames },
  }
}

async function dispatch(ctx: any, callId: string, name = 'GetBias'): Promise<any> {
  return await ctx.tools.execute({ callId, name, arguments: {}, signal: new AbortController().signal })
}

async function closeRuntime(runtime: { ctx: any; fibers: any[] }): Promise<void> {
  for (const fiber of [...runtime.fibers].reverse()) await fiber.dispose()
}

async function persisted(o: Options): Promise<Json> {
  const describe = async (path: string): Promise<Json> => {
    try {
      const s = await stat(path)
      const bytes = await readFile(path)
      return { path, size: s.size, sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch (e) { return { path, missing: true, error: (e as Error).message } }
  }
  let events: Json[] = []
  try {
    events = (await readFile(o.resultsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Json)
  } catch { /* reported by file fact */ }
  let actions: Json[] = []
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(o.recordsPath, { readOnly: true })
    try {
      actions = db.prepare(
        `SELECT id, action_type, status, error, tool_call_id, hlc
           FROM actions ORDER BY hlc DESC LIMIT 50`,
      ).all().map((row) => row as Json)
    } finally { db.close() }
  } catch { /* missing/invalid DB is reported by the file fact and empty actions */ }
  return { records: await describe(o.recordsPath), results: await describe(o.resultsPath), events, actions }
}

async function saveEvidence(o: Options, evidence: Record<string, Json>): Promise<void> {
  const out = { version: 1, command: o.command, runId: o.runId, at: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, dshHome: o.dshHome ?? null, ...evidence }
  await writeFile(o.evidencePath, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  console.log(`PASS ${o.command}: ${o.evidencePath}`)
}

async function values(o: Options): Promise<void> {
  const runtime = await activate(o)
  const { ctx, provider, facts } = runtime
  const rows: Json[] = []
  let hello: Json = null
  try {
    if (typeof provider?.simulator?.assertOwned !== 'function') throw new Error('ctx.minimalSpm.simulator does not expose assertOwned()')
    await provider.simulator.assertOwned()
    const helloResult = await dispatch(ctx, `minimal-${o.runId}-hello`, 'stm_hello')
    if (helloResult?.isError === true || !resultText(helloResult).includes('dsh-spm')) throw new Error(`stm_hello failed: ${resultText(helloResult)}`)
    hello = { text: resultText(helloResult) }
    for (let i = 0; i < o.values.length; i++) {
      await setBias(o.ports[0]!, o.values[i]!)
      const direct = await readBias(o.ports[0]!)
      const callId = `minimal-${o.runId}-${i + 1}`
      const result = await dispatch(ctx, callId)
      if (result?.isError === true) throw new Error(`GetBias failed: ${resultText(result)}`)
      const tool = biasFromResult(result)
      if (Math.abs(tool - direct) > o.tolerance) throw new Error(`GetBias ${tool} != independent Bias.Get ${direct}`)
      rows.push({ callId, requested: o.values[i]!, direct, tool, unit: 'V', absoluteError: Math.abs(tool - direct) })
    }
    if ((rows[0] as any).tool === (rows[1] as any).tool) throw new Error('two distinct simulator values produced the same tool value')
  } finally { await closeRuntime(runtime) }
  const disk = await persisted(o) as any
  const ids = new Set(rows.map((row: any) => row.callId))
  if (!Array.isArray(disk.actions) || ![...ids].every((id) =>
    disk.actions.some((x: any) => x?.tool_call_id === id && x?.status === 'succeeded'),
  )) {
    throw new Error('SQLite does not contain both successful GetBias call ids after shutdown')
  }
  for (const row of rows as any[]) {
    const event = disk.events?.find((x: any) => x?.toolCallId === row.callId && x?.skill === 'GetBias')
    if (event?.kind !== 'ok' || typeof event?.data?.bias_v !== 'number' || !Number.isFinite(event.data.bias_v)) {
      throw new Error(`JSONL has no finite successful bias_v for ${row.callId}`)
    }
    if (Math.abs(event.data.bias_v - row.direct) > o.tolerance) {
      throw new Error(`JSONL bias does not match independent read for ${row.callId}`)
    }
    if (!Array.isArray(event.instrumentCalls) || event.instrumentCalls.length !== 1) {
      throw new Error(`JSONL must contain exactly one instrument call for ${row.callId}`)
    }
    const [call] = event.instrumentCalls
    if (call?.method !== 'Bias_Get' || call?.command !== 'Bias.Get' || call?.role !== 'main' || call?.error != null ||
        !Array.isArray(call?.values) || call.values.length !== 1 || typeof call.values[0] !== 'number' ||
        Math.abs(call.values[0] - row.direct) > o.tolerance) {
      throw new Error(`JSONL instrument trace does not prove one successful main Bias_Get for ${row.callId}`)
    }
  }
  await saveEvidence(o, { runtime: facts, hello, comparisons: rows, persisted: disk })
}

async function failure(o: Options): Promise<void> {
  const runtime = await activate(o)
  const { ctx, provider, facts } = runtime
  let result: any
  const callId = `minimal-${o.runId}-disconnected`
  try {
    if (typeof provider?.simulator?.assertOwned !== 'function') throw new Error('ctx.minimalSpm.simulator does not expose assertOwned()')
    await provider.simulator.assertOwned()
    const stop = provider?.stopSimulator ?? provider?.stopStmsim
    if (typeof stop !== 'function') throw new Error('minimal provider does not expose stopSimulator() required for disconnect acceptance')
    await stop.call(provider)
    result = await dispatch(ctx, callId)
    if (result?.isError !== true && !/fail|error|断|连接|拒绝/i.test(resultText(result))) {
      throw new Error(`disconnected GetBias appeared successful: ${resultText(result)}`)
    }
  } finally { await closeRuntime(runtime) }
  const disk = await persisted(o) as any
  if (!Array.isArray(disk.actions) || !disk.actions.some((x: any) => x?.tool_call_id === callId && x?.status === 'failed')) {
    throw new Error('SQLite does not contain the disconnected GetBias failure after shutdown')
  }
  const failureEvent = Array.isArray(disk.events) ? disk.events.find((x: any) =>
    x?.toolCallId === callId && x?.skill === 'GetBias' && x?.kind === 'failed') : undefined
  if (failureEvent === undefined || !String(failureEvent.text).includes('managed_simulator_stopped') ||
      !Array.isArray(failureEvent.instrumentCalls) || failureEvent.instrumentCalls.length !== 1 ||
      failureEvent.instrumentCalls[0]?.method !== 'Bias_Get' || failureEvent.instrumentCalls[0]?.role !== 'main' ||
      !String(failureEvent.instrumentCalls[0]?.error).includes('managed_simulator_stopped') ||
      (Array.isArray(failureEvent.instrumentCalls[0]?.values) &&
       failureEvent.instrumentCalls[0].values.some((value: unknown) => typeof value === 'number' && Number.isFinite(value)))) {
    throw new Error('JSONL does not contain the disconnected GetBias result after shutdown')
  }
  await saveEvidence(o, { runtime: facts, disconnectedResult: { callId, isError: result?.isError === true, text: resultText(result) }, persisted: disk })
}

async function inspect(o: Options): Promise<void> {
  const p = await persisted(o) as any
  if (p.records?.missing || p.results?.missing || !Array.isArray(p.events) || p.events.length === 0 ||
      !Array.isArray(p.actions) || !p.actions.some((x: any) => x?.action_type === 'GetBias')) {
    throw new Error('durable SQLite and JSONL evidence must both exist and contain GetBias records')
  }
  await saveEvidence(o, { persisted: p, processRestartRead: true })
}

async function model(o: Options): Promise<void> {
  void o
  throw new Error(
    'M4 is implemented separately by scripts/model-minimal.ts because native dsh session-event correlation is required. ' +
    'This M3 runner never treats local GetBias JSONL as model-call proof.',
  )
}

const options = parseArgs(process.argv.slice(2))
await ({ values, failure, inspect, model }[options.command])(options)
