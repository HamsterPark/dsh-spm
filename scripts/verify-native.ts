#!/usr/bin/env node
/** Installed native simulator acceptance, through dsh ToolRuntime and durable kernel records. */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { NATIVE_TOOLS, nativePorts, redact } from './native-session.ts'
import { NativeReadProbe } from './native-probe.ts'

const HELP = 'node scripts/verify-native.ts --install-dir PROFILE_DIR --pid PID [--ports 6501,6502,6503,6504] --evidence NEW_FILE'

async function importFrom(req: NodeJS.Require, name: string): Promise<any> { return await import(pathToFileURL(req.resolve(name)).href) }

async function main(): Promise<void> {
  const { values: v } = parseArgs({ options: {
    'install-dir': { type: 'string' }, pid: { type: 'string' }, ports: { type: 'string' }, evidence: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (v.help) { console.log(HELP); return }
  if (!v['install-dir'] || !v.pid || !v.evidence) throw new Error(HELP)
  const installDir = resolve(v['install-dir']), pid = Number(v.pid), ports = nativePorts(v.ports), evidencePath = resolve(v.evidence)
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('--pid 必须是正整数')
  await mkdir(dirname(evidencePath), { recursive: true })
  // Reserve the unique report before touching the simulator, so no prior evidence can be replaced.
  await writeFile(evidencePath, JSON.stringify({ ok: false, stage: 'starting', at: new Date().toISOString() }) + '\n', { flag: 'wx' })
  const runId = `native-acceptance-${randomUUID()}`, recordsPath = `${evidencePath}.sqlite`, resultsPath = `${evidencePath}.results.jsonl`
  const report: any = { version: 1, runId, at: new Date().toISOString(), node: process.version, platform: process.platform, simulator: { pid, ports }, recordsPath, resultsPath, calls: [], comparisons: [], cleanup: {} }
  const fibers: any[] = []
  let ctx: any, initialBias: number | undefined, biasTouched = false, scanTouched = false
  const cleanupErrors: string[] = []
  // Reuse one data-role socket: the native simulator can reject rapid reconnects.
  // Construction does not connect; the first read follows runtime identity checks.
  const probe = new NativeReadProbe(ports[2]!)
  try {
    const req = createRequire(join(installDir, 'package.json'))
    const pluginPath = await realpath(req.resolve('dsh-spm/minimal'))
    const repo = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
    const rel = relative(repo, pluginPath)
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw new Error('验收必须加载仓库之外的安装包')
    const dshManifest = req.resolve('@deepseek-ai/dsh/package.json'), dshReq = createRequire(dshManifest)
    const version = JSON.parse(await readFile(dshManifest, 'utf8')).version
    if (version !== '0.1.5-rc.2') throw new Error(`dsh 版本不符：${version}`)
    const pluginReq = createRequire(req.resolve('dsh-spm/package.json'))
    if (await realpath(dshReq.resolve('@deepseek-ai/cordis')) !== await realpath(pluginReq.resolve('@deepseek-ai/cordis'))) throw new Error('宿主与插件的 Cordis 模块不是同一实例')
    report.runtime = { pluginPath, dshVersion: version }
    const [cordis, prompt, tools, commands, hello, runtime] = await Promise.all([
      importFrom(dshReq, '@deepseek-ai/cordis'), importFrom(dshReq, '@deepseek-ai/dsh-system-prompt'),
      importFrom(dshReq, '@deepseek-ai/dsh-tools'), importFrom(dshReq, '@deepseek-ai/dsh-commands'),
      importFrom(req, 'dsh-spm'), import(pathToFileURL(pluginPath).href),
    ])
    ctx = new cordis.Context()
    fibers.push(ctx.plugin(prompt.default ?? prompt.SystemPrompt), ctx.plugin(tools.default ?? tools.ToolRuntime, { mode: 'native' }), ctx.plugin(commands.default ?? commands.CommandRuntime ?? commands.Commands))
    await Promise.all(fibers.map((f) => f.await()))
    const apps = [ctx.plugin(hello), ctx.plugin(runtime, { nativeSimulator: { pid, ports }, recordsPath, resultsPath, runId })]
    fibers.push(...apps)
    await Promise.all(apps.map((f) => f.await()))
    if (!ctx.minimalSpm) throw new Error('原生模拟器运行层未激活')
    const names = ctx.tools.schemas().map((tool: any) => tool.name).sort()
    if (JSON.stringify(names) !== JSON.stringify(NATIVE_TOOLS)) throw new Error(`工具目录不符：${names.join(',')}`)
    report.toolCatalog = names
    const dispatch = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
      const callId = `${runId}-${report.calls.length + 1}`
      const result = await ctx.tools.execute({ callId, name, arguments: args, signal: new AbortController().signal })
      const text = result.content?.map((part: any) => part.text ?? '').join('\n') ?? ''
      report.calls.push({ callId, name, arguments: args, isError: result.isError, text })
      if (result.isError === true) throw new Error(`${name}: ${text}`)
      if (name === 'stm_hello') return {}
      const rows = (await readFile(resultsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      const row = rows.find((item) => item.toolCallId === callId)
      if (row?.kind !== 'ok') throw new Error(`${name}: ${row?.text ?? '没有成功的持久结果'}`)
      return row.data
    }
    // Activation identifies the exact native process before these independent reads connect.
    const initialStatus = await probe.read('Scan.StatusGet')
    report.initialScanStatus = initialStatus
    if (initialStatus !== 0) throw new Error('模拟器正在扫描；验收拒绝中断现有扫描。请先停止扫描再运行验收。')
    const feedback = await probe.read('ZCtrl.OnOffGet')
    report.initialZControllerOn = feedback === 1
    if (feedback !== 1) throw new Error('扫描验收要求 Z controller feedback 已开启；请先在 Nanonis 模拟器中开启反馈。此次未改变偏压或启动扫描。')
    initialBias = await probe.read('Bias.Get')
    report.initialBiasV = initialBias
    if (Math.abs(initialBias) > 10) throw new Error('原偏压超出 SetBias 恢复范围，拒绝写入')
    await dispatch('stm_hello')
    for (const [name, field] of [['GetBias', 'bias_v'], ['GetCurrent', 'current_a'], ['GetZPosition', 'z_pos_m']]) {
      const data = await dispatch(name!)
      if (typeof data[field!] !== 'number' || !Number.isFinite(data[field!])) throw new Error(`${name} 没有返回有限读数`)
    }
    const initialToolScan = await dispatch('GetScanStatus')
    if (initialToolScan.scan_running !== false) throw new Error('工具扫描状态与独立读回不符')
    // The bundled STM simulator starts with a -0.2..0.8 V band gap. Stay
    // above it so the closed feedback loop can maintain tunnelling current.
    const values = [1, 1.5]
    for (const value of values) {
      biasTouched = true
      await dispatch('SetBias', { bias_v: String(value) })
      const read = await dispatch('GetBias')
      const direct = await probe.read('Bias.Get')
      if (typeof read.bias_v !== 'number' || Math.abs(read.bias_v - value) > 1e-6 || Math.abs(direct - read.bias_v) > 1e-6) throw new Error('偏压工具结果与独立读回不符')
      report.comparisons.push({ requestedBiasV: value, toolBiasV: read.bias_v, directBiasV: direct, toleranceV: 1e-6 })
    }
    // Mark before dispatch so any partially successful start is stopped in finally.
    scanTouched = true
    await dispatch('StartScan', { direction: 'down' })
    const running = await dispatch('GetScanStatus')
    const directRunning = await probe.read('Scan.StatusGet')
    if (running.scan_running !== true || directRunning !== 1) throw new Error('StartScan 后未观测到运行状态')
    await dispatch('StopScan')
    const stopped = await dispatch('GetScanStatus')
    const directStopped = await probe.read('Scan.StatusGet')
    if (stopped.scan_running !== false || directStopped !== 0) throw new Error('StopScan 后未观测到停止状态')
    report.scan = { running, directRunning, stopped, directStopped }
    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = redact(error instanceof Error ? error.message : String(error))
  } finally {
    // Cleanup uses the same installed tool dispatcher, never a raw write or external process termination.
    if (ctx?.tools && scanTouched) {
      try {
        const result = await ctx.tools.execute({ callId: `${runId}-cleanup-stop`, name: 'StopScan', arguments: {}, signal: new AbortController().signal })
        const status = await probe.read('Scan.StatusGet')
        report.cleanup.scanStopped = result.isError !== true && status === 0
        if (!report.cleanup.scanStopped) throw new Error('未能确认扫描已停止')
      } catch (error) { cleanupErrors.push(`停止扫描：${String(error)}`) }
    }
    if (ctx?.tools && biasTouched && initialBias !== undefined) {
      try {
        const result = await ctx.tools.execute({ callId: `${runId}-cleanup-bias`, name: 'SetBias', arguments: { bias_v: String(initialBias) }, signal: new AbortController().signal })
        const value = await probe.read('Bias.Get')
        report.cleanup.restoredBiasV = value
        if (result.isError === true || Math.abs(value - initialBias) > 1e-6) throw new Error('未能确认原偏压已恢复')
      } catch (error) { cleanupErrors.push(`恢复偏压：${String(error)}`) }
    }
    try { await probe.close() } catch (error) { cleanupErrors.push(`关闭独立读取连接：${String(error)}`) }
    for (const fiber of [...fibers].reverse()) {
      try { await fiber.dispose() } catch (error) { cleanupErrors.push(`关闭插件：${String(error)}`) }
    }
    report.cleanup.errors = cleanupErrors
    if (cleanupErrors.length) report.ok = false
    try {
      report.persistedResults = (await readFile(resultsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(recordsPath, { readOnly: true })
      try { report.persistedActions = db.prepare('SELECT action_type, status, tool_call_id FROM actions ORDER BY hlc').all() } finally { db.close() }
      for (const call of report.calls.filter((call: any) => call.name !== 'stm_hello')) {
        if (!report.persistedActions.some((row: any) => row.tool_call_id === call.callId && row.status === 'succeeded')) {
          report.ok = false; report.persistenceError = `持久动作记录缺失：${call.callId}`
        }
      }
      report.reopenedAfterDispose = true
    } catch (error) { report.ok = false; report.persistenceError = String(error) }
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify({ ok: report.ok, evidence: evidencePath, error: report.error, cleanup: report.cleanup }))
  if (!report.ok) process.exitCode = 1
}

main().catch((error) => { console.error(redact(error instanceof Error ? error.message : String(error))); process.exitCode = 1 })
