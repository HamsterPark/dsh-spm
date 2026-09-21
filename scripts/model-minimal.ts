#!/usr/bin/env node
/** Native dsh rc.2 M4 acceptance: real headless Agent/Session, then disk replay. */
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readSessionRows } from './minimal-session-log.ts'

interface Options {
  installDir: string; dshHome: string; profile: string; credentialFile: string
  model: string; python: string; simulatorRoot: string; evidence: string
  ports: number[]; timeoutMs: number; maxRequests: number
  inspectExisting?: string
}

let failureControlPath: string | undefined

function usage(message?: string): never {
  if (message) console.error(`error: ${message}`)
  console.error('usage: node scripts/model-minimal.ts --install-dir DIR --dsh-home DIR --profile NAME --credential-file FILE --model PROVIDER/MODEL --python FILE --simulator-root DIR --ports P1,P2,P3,P4 --evidence FILE [--timeout-ms 120000] [--max-requests 4] [--inspect-existing RUN_ID]')
  process.exit(2)
}

function options(argv: string[]): Options {
  const flags = new Map<string, string>()
  while (argv.length) {
    const key = argv.shift()!
    const value = argv.shift()
    if (!key.startsWith('--') || value === undefined || value.startsWith('--')) usage(`bad argument ${key}`)
    flags.set(key.slice(2), value)
  }
  const need = (key: string): string => flags.get(key) ?? usage(`--${key} is required`)
  const model = need('model')
  if (!model.includes('/') || /\s/.test(model)) usage('--model must be PROVIDER/MODEL')
  const timeoutMs = Number(flags.get('timeout-ms') ?? 120_000)
  const maxRequests = Number(flags.get('max-requests') ?? 4)
  const ports = need('ports').split(',').map(Number)
  if (ports.length !== 4 || ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)) usage('--ports must contain four ports in 1024..65535')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 300_000) usage('--timeout-ms must be 10000..300000')
  if (!Number.isInteger(maxRequests) || maxRequests < 2 || maxRequests > 8) usage('--max-requests must be 2..8')
  const dshHome = resolve(need('dsh-home'))
  const evidence = resolve(need('evidence'))
  const relEvidence = relative(dshHome, evidence)
  if (relEvidence === '..' || relEvidence.startsWith(`..${sep}`) || isAbsolute(relEvidence)) usage('--evidence must be inside the supplied clean --dsh-home')
  return {
    installDir: resolve(need('install-dir')), dshHome,
    profile: need('profile'), credentialFile: resolve(need('credential-file')), model,
    python: resolve(need('python')), simulatorRoot: resolve(need('simulator-root')),
    evidence, ports, timeoutMs, maxRequests, inspectExisting: flags.get('inspect-existing'),
  }
}

async function filesBelow(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const visit = async (dir: string): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd'))) out.set(path, (await stat(path)).mtimeMs)
    }
  }
  await visit(root)
  return out
}

async function eventsFrom(path: string): Promise<any[]> {
  const rows = await readSessionRows(path)
  return rows.map((row) => row.event ?? row).filter((row) => typeof row?.type === 'string')
}

async function run(o: Options): Promise<void> {
  // The secret is read only in this process and passed only in the child's environment.
  const apiKey = o.inspectExisting ? '' : (await readFile(o.credentialFile, 'utf8')).trim()
  if (!o.inspectExisting && (!apiKey || /[\r\n]/.test(apiKey))) throw new Error('credential file must contain exactly one non-empty token')
  const redact = (text: string): string => apiKey ? text.split(apiKey).join('[REDACTED]') : text
  const [provider, ...modelParts] = o.model.split('/')
  const model = modelParts.join('/')
  const req = createRequire(join(o.installDir, 'package.json'))
  const dshBin = join(dirname(req.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  const profilePackage = JSON.parse(await readFile(join(o.dshHome, 'profiles', o.profile, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  const bundles = profilePackage.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@deepseek-ai/dsh-headless') || !bundles.includes('dsh-spm')) {
    throw new Error(`profile ${o.profile} must compose @deepseek-ai/dsh-headless and dsh-spm; got ${bundles.join(',')}`)
  }
  const sessionsRoot = join(o.dshHome, 'sessions')
  const before = o.inspectExisting ? new Map<string, number>() : await filesBelow(sessionsRoot)
  const runId = o.inspectExisting ?? `m4-${randomUUID()}`
  const overlay = join(dirname(o.evidence), `${runId}.patch.yml`)
  const controlPath = join(dirname(o.evidence), `${runId}.control.json`)
  failureControlPath = controlPath
  const guardPlugin = join(dirname(o.evidence), `${runId}.guard.mjs`)
  const recordsPath = join(dirname(o.evidence), `${runId}.sqlite`)
  const resultsPath = join(dirname(o.evidence), `${runId}.results.jsonl`)
  await mkdir(dirname(overlay), { recursive: true })
  const disabled = ['tool-bash','tool-pwsh','tool-jobs','tool-fs','tool-fs-search','tool-skill','tool-subagent-control','tool-subagent-list-agents','tool-subagent','tool-subagent-fork','tool-workflow','tool-result-pruner','tool-todo','tool-goal','tool-ralph','tool-web']
  if (!o.inspectExisting) await writeFile(guardPlugin, `
import { connect } from 'node:net'
import { writeFileSync } from 'node:fs'
export const name = 'dsh-spm-m4-guard'
export const inject = ['tools', 'minimalSpm']
const controlPath = ${JSON.stringify(controlPath)}
const expectedTools = ['GetBias', 'stm_hello']
const maxRequests = ${o.maxRequests}
const biasPort = ${o.ports[0]}
function readBias() {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: biasPort })
    const frame = Buffer.alloc(40); Buffer.from('Bias.Get').copy(frame); frame.writeUInt16BE(1, 36)
    const chunks = []; const timer = setTimeout(() => finish(new Error('Bias.Get timeout')), 5000)
    let done = false
    function finish(error, value) { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value) }
    socket.once('error', finish); socket.on('data', (chunk) => {
      chunks.push(chunk); const all = Buffer.concat(chunks); if (all.length < 52) return
      const size = all.readUInt32BE(32); if (all.length < 40 + size) return
      const body = all.subarray(40, 40 + size); const status = body.readInt32BE(4)
      if (status !== 0) return finish(new Error('Bias.Get status ' + status))
      finish(undefined, body.readFloatBE(0))
    }); socket.once('connect', () => socket.write(frame))
  })
}
export async function apply(ctx) {
  const tools = ctx.tools.schemas().map((x) => x.name).sort()
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) throw new Error('M4 tool catalog mismatch: ' + tools.join(','))
  const directBiasV = await readBias()
  const state = { tools, directBiasV, requestCount: 0 }
  writeFileSync(controlPath, JSON.stringify(state))
  ctx.on('agent/request', (payload, next) => {
    state.requestCount += 1; writeFileSync(controlPath, JSON.stringify(state))
    if (state.requestCount > maxRequests) throw new Error('M4 request limit exceeded: ' + state.requestCount)
    return next()
  })
}
`, 'utf8')
  if (!o.inspectExisting) await writeFile(overlay, [
    `- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(provider)}\n    model: ${JSON.stringify(model)}`,
    `- id: mast-minimal-runtime\n  config:\n    python: ${JSON.stringify(o.python)}\n    root: ${JSON.stringify(o.simulatorRoot)}\n    ports: [${o.ports.join(', ')}]\n    profile: reference-stm\n    approached: true\n    recordsPath: ${JSON.stringify(recordsPath)}\n    resultsPath: ${JSON.stringify(resultsPath)}\n    runId: ${JSON.stringify(runId)}`,
    ...disabled.map((id) => `- id: ${id}\n  disabled: true`),
    `- id: plan-mode\n  disabled: true`,
    `- id: session-title-llm\n  disabled: true`,
    `- id: llm-retry\n  disabled: true`,
    `- insert:\n    - id: m4-guard\n      name: ${JSON.stringify(new URL(`file:///${guardPlugin.replace(/\\/g, '/')}`).href)}`,
  ].join('\n'), 'utf8')

  const stdout: Buffer[] = [], stderr: Buffer[] = []
  if (!o.inspectExisting) {
  const prompt = 'Call stm_hello exactly once. Then call GetBias exactly once. Use the tools; do not infer or invent either result. Report the measured bias with unit V. Do not perform any write or shell action.'
  const child = spawn(process.execPath, [dshBin, '--profile', o.profile, '--patch', overlay, prompt], {
    cwd: o.installDir,
    env: { ...process.env, DSH_HOME: o.dshHome, DSH_TOOLS_MODE: 'native', DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: apiKey, STMSIM_PYTHON: o.python, STMSIM_ROOT: o.simulatorRoot, STMSIM_PORTS: o.ports.join(','), PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid !== undefined) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      else child.kill('SIGKILL')
      reject(new Error(`native dsh timed out after ${o.timeoutMs} ms`))
    }, o.timeoutMs)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }) })
  })
  if (exit.code !== 0) throw new Error(`native dsh failed code=${exit.code} signal=${exit.signal}: ${redact(Buffer.concat(stderr).toString('utf8')).slice(-4000)}`)
  }

  // This process opens the files only after native dsh exited: restart-style durable replay evidence.
  const after = await filesBelow(sessionsRoot)
  const changed = o.inspectExisting ? [...after.keys()] : [...after].filter(([path, mtime]) => !before.has(path) || mtime > before.get(path)!).map(([path]) => path)
  if (!o.inspectExisting) await writeFile(`${o.evidence}.receipt.json`, JSON.stringify({
    version: 1, runId, model: o.model, profile: o.profile, sessionsRoot,
    paths: { controlPath, recordsPath, resultsPath }, changedSessionFiles: changed,
  }, null, 2) + '\n', 'utf8')
  const candidates = await Promise.all(changed.map(async (path) => ({ path, events: await eventsFrom(path) })))
  const chosen = candidates.find((x) => x.events.some((e) => e.type === 'tool/call' && e.data?.name === 'GetBias'))
  if (!chosen) throw new Error(`no durable native session contains GetBias; changed JSONL files: ${changed.join(', ')}`)
  const events = chosen.events
  const calls = events.filter((e) => e.type === 'tool/call')
  const results = events.filter((e) => e.type === 'tool/result')
  const names = calls.map((e) => e.data?.name)
  if (JSON.stringify(names) !== JSON.stringify(['stm_hello', 'GetBias'])) throw new Error(`native tool calls must be exactly stm_hello,GetBias; got ${names.join(',')}`)
  const getBias = calls[1]
  const resultCallId = (event: any): unknown => event.data?.message?.content?.find((block: any) => block?.type === 'tool-result')?.toolCallId
  const result = results.find((e) => resultCallId(e) === getBias.data.callId)
  if (!result) throw new Error(`no durable tool/result paired with GetBias callId ${getBias.data.callId}`)
  const resultBlock = result.data?.message?.content?.find((block: any) => block?.type === 'tool-result')
  if (resultBlock?.isError !== false) throw new Error(`durable GetBias tool/result isError is not false: ${JSON.stringify(resultBlock?.isError)}`)
  const resultText = JSON.stringify(result.data.message)
  if (!/-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*V\b/i.test(resultText)) throw new Error('durable GetBias tool/result has no numeric V value')
  const requests = events.filter((e) => e.type === 'assistant/message' || e.type === 'assistant/attempt').length
  if (requests < 2 || requests > o.maxRequests) throw new Error(`model request count ${requests} outside 2..${o.maxRequests}`)
  const header = [...events].reverse().find((e) => e.type === 'request/header')?.data?.header
  if (header?.config?.provider !== provider || header?.config?.model !== model) throw new Error(`durable request route mismatch: ${JSON.stringify(header)}`)
  const durableTools = (header?.tools ?? []).map((tool: any) => tool.name).sort()
  if (JSON.stringify(durableTools) !== JSON.stringify(['GetBias', 'stm_hello'])) throw new Error(`durable request tool catalog mismatch: ${durableTools.join(',')}`)
  const sessionId = chosen.path.split(/[\\/]/).at(-2) ?? chosen.path
  const control = JSON.parse(await readFile(controlPath, 'utf8')) as { tools: string[]; directBiasV: number; requestCount: number }
  if (control.requestCount !== requests) throw new Error(`live request guard counted ${control.requestCount}, durable log has ${requests}`)
  const resultBias = Number(resultText.match(/(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*V\b/i)?.[1])
  if (!Number.isFinite(control.directBiasV) || Math.abs(resultBias - control.directBiasV) > 1e-6) throw new Error(`GetBias ${resultBias} differs from independent Bias.Get ${control.directBiasV}`)
  const localResults = (await readFile(resultsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const local = localResults.find((row) => row.toolCallId === getBias.data.callId)
  if (!local) throw new Error(`local result JSONL has no row for native callId ${getBias.data.callId}`)
  if (!Array.isArray(local.instrumentCalls) || local.instrumentCalls.length !== 1 || local.instrumentCalls[0]?.method !== 'Bias_Get' || local.instrumentCalls[0]?.error !== undefined) {
    throw new Error(`GetBias call ${getBias.data.callId} has wrong instrument trace: ${JSON.stringify(local.instrumentCalls)}`)
  }
  const traceBias = local.instrumentCalls[0]?.values?.[0]
  if (local.data?.bias_v !== traceBias || Math.abs(local.data.bias_v - resultBias) > 1e-6) {
    throw new Error(`bias evidence mismatch: local=${local.data?.bias_v}, trace=${traceBias}, tool=${resultBias}`)
  }
  const assistantMessages = events.filter((e) => e.type === 'assistant/message')
  const finalAssistantText = assistantMessages.at(-1)?.data?.message?.content
    ?.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n') ?? ''
  if (!finalAssistantText.includes(String(resultBias)) || !finalAssistantText.includes('V')) throw new Error('final assistant text does not preserve the measured V value')
  const requestUsage = assistantMessages.map((e) => e.data?.usage).filter(Boolean)
  const sumKnown = (key: string): number | null => requestUsage.every((item) => typeof item[key] === 'number')
    ? requestUsage.reduce((sum, item) => sum + item[key], 0)
    : null
  const auxiliaryTitleRequests = events.filter((e) => e.type === 'session/title-llm-request').length
  const usage = {
    requests: requestUsage,
    knownAgentTotals: {
      inputTokens: sumKnown('inputTokens'),
      outputTokens: sumKnown('outputTokens'),
      totalTokens: sumKnown('totalTokens'),
      cacheReadTokens: sumKnown('cacheReadTokens'),
      reasoningTokens: sumKnown('reasoningTokens'),
    },
    auxiliaryTitleRequests,
    auxiliaryUsage: auxiliaryTitleRequests === 0 ? 'not applicable' : null,
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(recordsPath, { readOnly: true })
  const action = db.prepare('SELECT action_type, status, tool_call_id FROM actions WHERE tool_call_id = ?').get(getBias.data.callId) as
    | { action_type: string; status: string; tool_call_id: string }
    | undefined
  db.close()
  if (action?.action_type !== 'GetBias' || action.status !== 'succeeded') throw new Error(`SQLite action correlation failed: ${JSON.stringify(action)}`)
  const evidence = {
    version: 1, runId, sessionId, sessionLog: chosen.path, reopenedAfterExit: true,
    model: { provider, model }, requestCount: requests, totalObservedModelRequests: requests + usage.auxiliaryTitleRequests, usage,
    toolCalls: calls.map((e) => ({ seq: e.seq, callId: e.data.callId, name: e.data.name, arguments: e.data.arguments })),
    toolResult: { seq: result.seq, callId: getBias.data.callId, text: resultText },
    toolCatalog: control.tools, independentBiasV: control.directBiasV,
    localEvidence: { recordsPath, resultsPath, sqliteAction: action, instrumentCalls: local.instrumentCalls },
    finalText: finalAssistantText,
    processOutput: o.inspectExisting ? null : redact(Buffer.concat(stdout).toString('utf8')).trim(),
    replayed: Boolean(o.inspectExisting),
  }
  await writeFile(o.evidence, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ ok: true, evidence: o.evidence, sessionId, requestCount: requests, toolCalls: names }))
}

const selected = options(process.argv.slice(2))
try {
  await run(selected)
} catch (error) {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(DEEPSEEK_API_KEY\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .slice(-2000)
  let control: { tools?: string[]; requestCount?: number } | undefined
  if (failureControlPath) {
    try { control = JSON.parse(await readFile(failureControlPath, 'utf8')) } catch { /* boot can fail before the guard writes */ }
  }
  await mkdir(dirname(selected.evidence), { recursive: true })
  await writeFile(selected.evidence, JSON.stringify({
    version: 1,
    ok: false,
    stage: 'native-m4',
    at: new Date().toISOString(),
    model: selected.model,
    profile: selected.profile,
    requestCount: control?.requestCount ?? null,
    toolCatalog: control?.tools ?? null,
    error: message,
  }, null, 2) + '\n', 'utf8')
  console.error(`native M4 failed; evidence=${selected.evidence}; error=${message}`)
  process.exitCode = 1
}
