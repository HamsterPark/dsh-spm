#!/usr/bin/env node
/** Small native dsh launcher for an explicitly identified, already running Nanonis simulator. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readSessionRows } from './minimal-session-log.ts'

export const NATIVE_TOOLS = ['GetBias', 'GetCurrent', 'GetScanStatus', 'GetZPosition', 'SetBias', 'StartScan', 'StopScan', 'stm_hello']
let interrupted = false
let activeShutdown: ((reason: string) => void) | undefined
const interrupt = (): void => { interrupted = true; activeShutdown?.('user-interrupt') }

const HELP = `用法：
  node scripts/native-session.ts --install-dir PROFILE_DIR --dsh-home DIR --pid PID [--ports 6501,6502,6503,6504] [--credential-file FILE] [--prompt "读取偏压、电流和扫描状态"]

省略 --prompt 进入交互命令循环；输入 exit 退出。每条命令建立一个独立、持久保存的 dsh 会话。
--profile 默认 minimal；--model 默认 deepseek-official/deepseek-flash。
凭据优先取 DEEPSEEK_API_KEY；--credential-file 接受单个密钥或 dsh 的 .credentials.yaml。
--timeout-ms 默认 120000；--max-requests 默认 8。不会启动或关闭 Nanonis 模拟器。`

interface Options {
  installDir: string; dshHome: string; profile: string; pid: number; ports: number[]
  model: string; credentialFile?: string; prompt?: string; timeoutMs: number; maxRequests: number
}

export function nativePorts(value = '6501,6502,6503,6504'): number[] {
  const ports = value.split(',').map(Number)
  if (ports.length !== 4 || new Set(ports).size !== 4 || ports.some((n) => !Number.isInteger(n) || n < 1024 || n > 65535)) {
    throw new Error('--ports 必须是四个不同的 1024..65535 端口')
  }
  return ports
}

function parse(argv: string[]): Options | undefined {
  const { values: v } = parseArgs({ args: argv, options: {
    'install-dir': { type: 'string' }, 'dsh-home': { type: 'string' }, profile: { type: 'string', default: 'minimal' },
    pid: { type: 'string' }, ports: { type: 'string' }, model: { type: 'string', default: 'deepseek-official/deepseek-flash' },
    'credential-file': { type: 'string' }, prompt: { type: 'string' }, 'timeout-ms': { type: 'string', default: '120000' },
    'max-requests': { type: 'string', default: '8' }, help: { type: 'boolean' },
  } })
  if (v.help) { console.log(HELP); return }
  if (!v['install-dir'] || !v['dsh-home'] || !v.pid) throw new Error(HELP)
  const pid = Number(v.pid), timeoutMs = Number(v['timeout-ms']), maxRequests = Number(v['max-requests'])
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('--pid 必须是正在运行的模拟器进程 ID')
  if (!/^[a-z][a-z0-9_-]*$/.test(v.profile!)) throw new Error('--profile 格式不正确')
  if (!/^[^\s/]+\/[^\s]+$/.test(v.model!)) throw new Error('--model 必须是 PROVIDER/MODEL')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 600000) throw new Error('--timeout-ms 范围为 10000..600000')
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 20) throw new Error('--max-requests 范围为 1..20')
  return {
    installDir: resolve(v['install-dir']), dshHome: resolve(v['dsh-home']), profile: v.profile!, pid,
    ports: nativePorts(v.ports), model: v.model!, credentialFile: v['credential-file'], prompt: v.prompt, timeoutMs, maxRequests,
  }
}

export function redact(text: string, secret = ''): string {
  return (secret ? text.split(secret).join('[REDACTED]') : text)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(DEEPSEEK_API_KEY\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
}

async function credential(o: Options, dshRequire: NodeJS.Require): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim()
  if (!o.credentialFile) throw new Error('需要 DEEPSEEK_API_KEY 环境变量或 --credential-file；凭据不会写入会话或报告')
  const raw = (await readFile(resolve(o.credentialFile), 'utf8')).trim()
  if (raw && !/[\r\n]/.test(raw) && !/^version\s*:/.test(raw)) return raw
  let document: any
  try {
    const yaml = dshRequire('js-yaml') as { load: (text: string) => unknown }
    document = yaml.load(raw)
  } catch { throw new Error('凭据文件不是可解析的 dsh YAML；未输出其内容') }
  const value = document?.version === 1 ? document.refs?.DEEPSEEK_API_KEY : undefined
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error('dsh 凭据文件没有有效的 refs.DEEPSEEK_API_KEY')
  return value.trim()
}

async function sessionFiles(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>()
  const visit = async (dir: string): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) files.set(path, (await stat(path)).mtimeMs)
    }
  }
  await visit(root)
  return files
}

async function prepareProfile(o: Options): Promise<void> {
  const file = join(o.dshHome, 'profiles', o.profile, 'package.json')
  if (resolve(dirname(file)) !== o.installDir) throw new Error('--install-dir 必须指向所选 home 下的 profiles/<profile>')
  const pkg = JSON.parse(await readFile(file, 'utf8'))
  const bundles = pkg.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('dsh-spm')) throw new Error('所选 profile 尚未安装 dsh-spm')
  const allowed = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-spm']
  if (bundles.some((name: string) => !allowed.includes(name))) throw new Error('此启动器只接受专用的 base/headless/dsh-spm profile')
  if (!bundles.includes('@deepseek-ai/dsh-headless')) {
    pkg.dsh.profile.bundles = allowed
    await writeFile(file, JSON.stringify(pkg, null, 2) + '\n')
  }
}

async function runOne(o: Options, task: string, apiKey: string, dshBin: string): Promise<boolean> {
  if (interrupted) return false
  const runId = `native-${randomUUID()}`
  const directory = join(o.dshHome, 'nanonis-runs', runId)
  await mkdir(directory, { recursive: true })
  const guardPath = join(directory, 'guard.mjs'), overlay = join(directory, 'runtime.patch.yml')
  const control = join(directory, 'control.json'), recordsPath = join(directory, 'actions.sqlite'), resultsPath = join(directory, 'results.jsonl')
  const shutdownFile = join(directory, 'shutdown-request.json')
  const [provider, ...modelParts] = o.model.split('/')
  const model = modelParts.join('/')
  await writeFile(guardPath, `import { existsSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export const name = 'native-simulator-tool-guard'
export const inject = ['tools', 'minimalSpm']
export function apply(ctx) {
  const names = ctx.tools.schemas().map(x => x.name).sort()
  const expected = ${JSON.stringify(NATIVE_TOOLS)}
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Native tool catalog mismatch: ' + names.join(','))
  const state = { tools: names, requestCount: 0, shutdownRequested: false, transportClosed: false }
  const save = () => writeFileSync(${JSON.stringify(control)}, JSON.stringify(state))
  save()
  let shutdown
  const confirmNativeSocketsClosed = async () => {
    if (process.platform !== 'win32') throw new Error('Native shutdown socket confirmation is Windows-only')
    const command = '$ErrorActionPreference = "Stop"; @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.OwningProcess -eq ' + process.pid + ' -and $_.RemotePort -in @(${o.ports.join(',')}) }).Count'
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000 })
      const count = stdout.trim()
      if (count === '0') return
      if (!/^\\d+$/.test(count)) throw new Error('Cannot inspect native TCP shutdown state')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Native TCP sockets remain open; refusing forced process exit')
  }
  const checkShutdown = () => {
    if (shutdown || !existsSync(${JSON.stringify(shutdownFile)})) return
    state.shutdownRequested = true; save()
    // First prohibit further instrument commands and drain/FIN the owned TCP
    // links. Only then enter dsh's appExit lifecycle (which itself has a 5 s limit).
    shutdown = (async () => {
      await ctx.minimalSpm.stopSimulator()
      await ctx.minimalSpm.instrument.closeAll()
      await confirmNativeSocketsClosed()
      state.transportClosed = true; save()
      ctx.get('appExit')(1)
    })().catch(error => {
      state.shutdownError = String(error); save()
      // Keep the host alive for operator inspection rather than forcing TCP teardown.
    })
  }
  const timer = setInterval(checkShutdown, 100)
  ctx.effect(() => () => clearInterval(timer))
  checkShutdown()
  ctx.on('agent/request', (payload, next) => {
    if (state.shutdownRequested) return shutdown.then(() => { throw new Error('Native session is shutting down') })
    state.requestCount += 1; save()
    if (state.requestCount > ${o.maxRequests}) throw new Error('Native session request limit exceeded')
    return next()
  })
}
`)
  const disabled = ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-result-pruner', 'tool-todo', 'tool-goal', 'tool-ralph', 'tool-web', 'plan-mode', 'session-title-llm', 'llm-retry']
  await writeFile(overlay, [
    `- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(provider)}\n    model: ${JSON.stringify(model)}`,
    `- id: mast-minimal-runtime\n  config:\n    nativeSimulator:\n      pid: ${o.pid}\n      ports: [${o.ports.join(', ')}]\n    recordsPath: ${JSON.stringify(recordsPath)}\n    resultsPath: ${JSON.stringify(resultsPath)}\n    runId: ${JSON.stringify(runId)}`,
    ...disabled.map((id) => `- id: ${id}\n  disabled: true`),
    `- insert:\n    - id: native-tool-guard\n      name: ${JSON.stringify(pathToFileURL(guardPath).href)}`,
  ].join('\n') + '\n')
  const before = await sessionFiles(join(o.dshHome, 'sessions'))
  const prompt = '你正在控制经过身份核验的本机 Nanonis 模拟器。请用实际工具完成用户命令，并报告测量值及单位。只能执行用户本次要求的操作；不能把设置请求当成已读回的结果。工具失败必须如实报告，不自行放宽连续扫描检查。用户命令：\n' + task
  const child = spawn(process.execPath, [dshBin, '--profile', o.profile, '--patch', overlay, prompt], {
    cwd: o.installDir, env: { ...process.env, DSH_HOME: o.dshHome, DEEPSEEK_API_KEY: apiKey, DSH_TOOLS_MODE: 'native', DSH_TELEMETRY_DISABLED: '1' },
    // Own process group: parent Ctrl+C is handled by the cooperative file path,
    // not delivered simultaneously to dsh's escalating signal handler.
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true,
  })
  const output: Buffer[] = [], errors: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
  const exit = await new Promise<{ code: number | null; timedOut: boolean; interrupted: boolean; needsManualCleanup: boolean }>((done, reject) => {
    let timedOut = false
    let shutdownRequested = false, finished = false
    let cleanupTimer: NodeJS.Timeout | undefined
    const finish = (code: number | null, needsManualCleanup = false): void => {
      if (finished) return
      finished = true; clearTimeout(timer); clearTimeout(cleanupTimer); activeShutdown = undefined
      done({ code, timedOut, interrupted, needsManualCleanup })
    }
    activeShutdown = (reason): void => {
      if (shutdownRequested) return
      shutdownRequested = true
      void writeFile(shutdownFile, JSON.stringify({ reason, at: new Date().toISOString() }) + '\n').catch((error) => console.error(redact(String(error), apiKey)))
      console.error('正在等待 dsh 完成当前请求并正常断开模拟器连接……')
      cleanupTimer = setTimeout(() => {
        // Do not force-kill a process that may still own a native TCP request.
        // Leave its PID and shutdown file in a report for explicit operator recovery.
        child.unref()
        ;(child.stdout as unknown as { unref?: () => void }).unref?.()
        ;(child.stderr as unknown as { unref?: () => void }).unref?.()
        finish(null, true)
      }, 30000)
    }
    const timer = setTimeout(() => { timedOut = true; activeShutdown?.('timeout') }, o.timeoutMs)
    if (interrupted) activeShutdown('user-interrupt')
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(cleanupTimer); activeShutdown = undefined; reject(error) })
    child.once('close', (code) => finish(code))
  })
  const stdout = redact(Buffer.concat(output).toString('utf8'), apiKey).trim()
  const stderr = redact(Buffer.concat(errors).toString('utf8'), apiKey).trim()
  if (exit.needsManualCleanup) {
    interrupted = true
    process.exitCode = 1
    const report = { version: 1, ok: false, runId, process: exit, childPid: child.pid, simulatorPid: o.pid, shutdownFile, recordsPath, resultsPath,
      error: '协作退出在 30 秒内未完成。dsh 子进程仍保留，未强制终止。请先检查 Nanonis TCP 状态，再处理该 dsh 进程；本报告不声称记录已完整关闭。', diagnostics: stderr }
    await writeFile(join(directory, 'session-evidence.json'), redact(JSON.stringify(report, null, 2), apiKey) + '\n')
    throw new Error(`需要人工检查 dsh 进程 ${child.pid}；未强制关闭模拟器连接。记录：${directory}`)
  }
  const after = await sessionFiles(join(o.dshHome, 'sessions'))
  const changed = [...after].filter(([path, mtime]) => !before.has(path) || mtime > before.get(path)!).map(([path]) => path)
  const events = (await Promise.all(changed.map(async (path) => ({ path, rows: await readSessionRows(path) })))).map(({ path, rows }) => ({ path, events: rows.map((row: any) => row.event ?? row) }))
  const toolCalls = events.flatMap(({ path, events: rows }) => rows.filter((e: any) => e.type === 'tool/call').map((e: any) => ({ sessionLog: path, callId: e.data.callId, name: e.data.name, arguments: e.data.arguments })))
  const toolResults = events.flatMap(({ events: rows }) => rows.filter((e: any) => e.type === 'tool/result').map((e: any) => e.data))
  let guard: any = null
  try { guard = JSON.parse(await readFile(control, 'utf8')) } catch { /* startup failures have no guard */ }
  let localResults: any[] = []
  try { localResults = (await readFile(resultsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) } catch { /* startup failures have no results */ }
  const nativeCalls = toolCalls.filter((call) => call.name !== 'stm_hello')
  const unrecordedCalls = nativeCalls.filter((call) => !localResults.some((row) => row.toolCallId === call.callId))
  let actions: any[] = []
  let persistenceError: string | undefined
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(recordsPath, { readOnly: true })
    try { actions = db.prepare('SELECT action_type, status, tool_call_id FROM actions ORDER BY hlc').all() } finally { db.close() }
    if (nativeCalls.some((call) => !actions.some((row) => row.tool_call_id === call.callId))) persistenceError = '至少一次工具调用缺少 SQLite 动作记录'
  } catch (error) { persistenceError = redact(error instanceof Error ? error.message : String(error), apiKey) }
  const requestHeaders = events.flatMap(({ events: rows }) => rows.filter((event: any) => event.type === 'request/header').map((event: any) => event.data?.header))
  const wrongRequest = requestHeaders.some((header: any) => header?.config?.provider !== provider || header?.config?.model !== model ||
    JSON.stringify((header?.tools ?? []).map((tool: any) => tool.name).sort()) !== JSON.stringify(NATIVE_TOOLS))
  const evidence = {
    version: 1, runId, at: new Date().toISOString(), model: o.model, externalSimulator: { pid: o.pid, ports: o.ports },
    process: exit, requestCount: guard?.requestCount ?? null, toolCatalog: guard?.tools ?? null,
    sessionFiles: changed, toolCalls, toolResults, localResults, unrecordedCalls, persistedActions: actions, persistenceError,
    requestHeadersVerified: requestHeaders.length > 0 && !wrongRequest,
    recordsPath, resultsPath, finalText: stdout, diagnostics: stderr,
  }
  await writeFile(join(directory, 'session-evidence.json'), redact(JSON.stringify(evidence, null, 2), apiKey) + '\n')
  if (stdout) console.log(stdout)
  const ok = exit.code === 0 && !exit.timedOut && !exit.interrupted && guard !== null && unrecordedCalls.length === 0 &&
    persistenceError === undefined && requestHeaders.length > 0 && !wrongRequest
  if (!ok) console.error(`会话未完成：${exit.timedOut ? '达到超时限制' : `退出码 ${exit.code}`}\n${stderr.slice(-2000)}`)
  console.log(`记录：${directory}`)
  return ok
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2))
  if (!o) return
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  await prepareProfile(o)
  const req = createRequire(join(o.installDir, 'package.json'))
  const dshManifest = req.resolve('@deepseek-ai/dsh/package.json')
  const dshRequire = createRequire(dshManifest)
  const apiKey = await credential(o, dshRequire)
  const dshBin = join(dirname(dshManifest), 'lib', 'bin.js')
  if (o.prompt !== undefined) {
    if (!o.prompt.trim()) throw new Error('--prompt 不能为空')
    if (!await runOne(o, o.prompt, apiKey, dshBin)) process.exitCode = 1
    return
  }
  if (!process.stdin.isTTY) throw new Error('非交互启动需要 --prompt')
  console.log('Nanonis 模拟器命令台。每条命令使用独立会话；请输入完整指令。输入 exit 退出。')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  readline.on('SIGINT', () => { interrupt(); if (!activeShutdown) readline.close() })
  try {
    for (;;) {
      if (interrupted) break
      const task = (await readline.question('Nanonis > ')).trim()
      if (/^(exit|quit|退出)$/i.test(task)) break
      if (!task) continue
      try { await runOne(o, task, apiKey, dshBin) } catch (error) { console.error(redact(error instanceof Error ? error.message : String(error), apiKey)) }
    }
  } finally { readline.close(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(redact(error instanceof Error ? error.message : String(error))); process.exitCode = 1 })
}
