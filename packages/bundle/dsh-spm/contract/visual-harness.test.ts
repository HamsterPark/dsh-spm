/**
 * 视觉线束挂在最小运行栈的本机模式上（`Config.visualHarness`），走**真的** dsh 工具调度器
 * （`ToolRuntime` 的 guard 与 `tools/execute` 瀑布、`dsh-agent` 的事件派发）。本机连接与仪器
 * 是替身（同 `native-runtime.test.ts`）：不连真模拟器。
 *
 * 钉住两件事：
 * 1. **开关关着时一字不变**：工具目录、提示段、回复文本、工具值的形状、JSONL 都与挂线束之前
 *    相同（提示段与回复按改动前的原文比）；
 * 2. **开关开着**：视觉工具与提示段在场；控制器保存目录里新出现的扫描帧在下一次调用入档，随
 *    该次结果出图；同一步里的第二个动作被一动一观拒绝，SQLite 与 JSONL 各有一行；下一步放行。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef, type ToolExecutionResult } from 'dsh-spm-compat'
import { StmsimProcess } from 'dsh-spm-instrument-stmsim'
import { ACT_GATE_REFUSAL } from 'dsh-spm-kernel'
import { VISUAL_HARNESS_PROMPT, VISUAL_HARNESS_PROMPT_NAME, VISUAL_TOOL_NAMES, encodeSyntheticSxm, pngSize } from 'dsh-spm-visual-memory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as minimal from '../src/minimal.js'
import { NativeSimulatorConnection, NativeSimulatorInstrument } from '../src/native-simulator.js'
import { NATIVE_VISUAL_PROMPT, type VisualHarnessConfig } from '../src/visual-harness.js'

/** 挂线束之前 minimal.ts 里那段本机提示的原文。 */
const NATIVE_PROMPT_BEFORE =
  '已接入本机 Nanonis STM Simulator。只提供偏压、电流、Z 位置、扫描状态、设置偏压、单帧扫描启停。' +
  '依照用户请求逐步调用工具。设置偏压和扫描启停均回读确认。读数必须引用本次工具结果，失败时不得声称成功。' +
  'StartScan 要求操作员已在 Nanonis 中开启 Z 反馈，不支持持续扫描覆盖。关闭本会话只断开连接，不关闭模拟器。'

const SXM = encodeSyntheticSxm({
  nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 0, offsetYM: 0, scanDir: 'down',
  channels: [{ name: 'Z', unit: 'm', forward: Float32Array.from({ length: 128 }, (_, i) => 1e-12 * (i % 16)) }],
})

class TestCommands extends Service {
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(): () => void { return () => {} }
}

class FakeAttachments extends Service {
  readonly saved: string[] = []
  constructor(ctx: Context) { super(ctx, 'attachments') }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef> {
    this.saved.push(input.name ?? '')
    const { width, height } = pngSize(input.data)
    return Promise.resolve({
      attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`,
      mediaType: 'image/png', bytes: input.data.length, width, height,
      ...(input.name === undefined ? {} : { name: input.name }),
    } as unknown as ImageAttachmentRef)
  }
}

const agent = (id: string): Agent =>
  ({ id, options: {}, session: { requestHeader: () => undefined } }) as unknown as Agent

function preStep(ctx: Context, who: Agent, step: number): Promise<unknown> {
  return agentEvents(ctx, who).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

const texts = (r: ToolExecutionResult): string[] =>
  r.content.filter((b) => b.type === 'text').map((b) => (b as unknown as { text: string }).text)

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

/** 本机模式的最小运行栈，接在替身仪器上；`visual` 缺席即开关关着。 */
async function nativeRuntime(visual?: (dirs: { root: string; saveDir: string }) => VisualHarnessConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'visual-runtime-'))
  const root = join(dir, 'visual')
  const saveDir = mkdtempSync(join(dir, 'save-'))
  const resultsPath = join(dir, 'results.jsonl')
  vi.spyOn(NativeSimulatorConnection.prototype, 'start').mockResolvedValue()
  vi.spyOn(NativeSimulatorConnection.prototype, 'assertOwned').mockResolvedValue()
  vi.spyOn(NativeSimulatorConnection.prototype, 'assertCurrent').mockResolvedValue()
  vi.spyOn(NativeSimulatorConnection.prototype, 'stop').mockResolvedValue()
  vi.spyOn(NativeSimulatorInstrument.prototype, 'closeAll').mockResolvedValue()
  const sim = { bias: 0.125, running: false }
  const wire = vi.spyOn(NativeSimulatorInstrument.prototype, 'call').mockImplementation(async (method, args) => {
    if (method === 'Bias_Set') sim.bias = Number(args[0])
    if (method === 'Scan_Action') sim.running = Number(args[0]) === 0
    const values: Record<string, unknown[]> = {
      Bias_Get: [sim.bias], Current_Get: [1e-10], ZCtrl_ZPosGet: [2e-9], ZCtrl_OnOffGet: [1],
      Scan_StatusGet: [sim.running ? 1 : 0], Scan_PropsGet: [0],
    }
    return { method, command: method, args: [], role: 'main', values: values[method] ?? [], at: Date.now(), elapsedMs: 1, simulated: true }
  })
  const ctx = new Context()
  new TestCommands(ctx)
  const attachments = new FakeAttachments(ctx)
  const prompt = ctx.plugin(SystemPrompt)
  await prompt.await()
  const tools = ctx.plugin(ToolRuntime)
  await tools.await()
  const runtime = ctx.plugin(minimal, {
    nativeSimulator: { pid: 123 }, recordsPath: join(dir, 'records.sqlite'), resultsPath,
    ...(visual === undefined ? {} : { visualHarness: visual({ root, saveDir }) }),
  })
  await runtime.await()
  cleanups.push(async () => {
    await runtime.dispose()
    await tools.dispose()
    await prompt.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  let n = 0
  const call = (name: string, who?: Agent, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> => {
    n += 1
    return ctx.tools.execute({
      name, callId: `call-${n}` as never, arguments: args, signal: new AbortController().signal,
      ...(who === undefined ? {} : { agent: who }),
    })
  }
  const jsonl = (): Record<string, unknown>[] =>
    readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  const sections = async () => (await ctx.systemPrompt.assemble()).sections
  return { ctx, runtime, call, jsonl, sections, wire, sim, root, saveDir, attachments }
}

describe('开关关着：与挂视觉线束之前一字不差', () => {
  it('工具目录、提示段、回复文本、JSONL 都不变；没有闸门，也不入档', async () => {
    const rt = await nativeRuntime()
    expect(minimal.NATIVE_PROMPT).toBe(NATIVE_PROMPT_BEFORE)
    expect(rt.ctx.tools.schemas().map((s) => s.name).sort()).toEqual([...minimal.NATIVE_TOOL_NAMES].sort())
    const sections = await rt.sections()
    expect(sections.find((s) => s.name === 'native-nanonis-simulator')?.text).toBe(NATIVE_PROMPT_BEFORE)
    expect(sections.map((s) => s.name)).not.toContain(VISUAL_HARNESS_PROMPT_NAME)

    const a = agent('session-a')
    expect((await rt.call('GetBias', a)).content).toEqual([{ type: 'text', text: 'GetBias: 0.125 V' }])
    writeFileSync(join(rt.saveDir, 'scan001.sxm'), SXM)
    expect((await rt.call('StartScan', a)).content).toEqual([{ type: 'text', text: 'StartScan: running (readback verified)' }])
    // 没有闸门：同一步里的第二个动作照样执行
    expect((await rt.call('SetBias', a, { bias_v: '0.25' })).content).toEqual([{ type: 'text', text: 'SetBias: 0.25 V (readback verified)' }])
    expect((await rt.call('GetScanStatus', a)).content).toEqual([{ type: 'text', text: 'GetScanStatus: running' }])

    const lines = rt.jsonl()
    expect(lines.map((l) => [l['skill'], l['kind']])).toEqual([
      ['GetBias', 'ok'], ['StartScan', 'ok'], ['SetBias', 'ok'], ['GetScanStatus', 'ok'],
    ])
    expect(lines.some((l) => 'observation' in l)).toBe(false)
    expect(rt.ctx.get('frameArchive')).toBeUndefined()
    expect(rt.attachments.saved).toEqual([])
  })
})

describe('开关开着：视觉线束挂在本机模式上', () => {
  it('视觉工具与提示段在场；读类回复没有新帧时与关着时相同', async () => {
    const rt = await nativeRuntime(({ root, saveDir }) => ({ root, saveDir }))
    expect(rt.ctx.tools.schemas().map((s) => s.name).sort()).toEqual([...minimal.NATIVE_TOOL_NAMES, ...VISUAL_TOOL_NAMES].sort())
    const sections = await rt.sections()
    expect(sections.find((s) => s.name === 'native-nanonis-simulator')?.text).toBe(NATIVE_PROMPT_BEFORE + NATIVE_VISUAL_PROMPT)
    expect(sections.find((s) => s.name === VISUAL_HARNESS_PROMPT_NAME)?.text).toBe(VISUAL_HARNESS_PROMPT)
    expect((await rt.call('GetBias', agent('session-a'))).content).toEqual([{ type: 'text', text: 'GetBias: 0.125 V' }])
  })

  it('扫描帧在下一次调用入档并出图；同一步的第二个动作被拒（两份记录都有）；下一步放行', async () => {
    const rt = await nativeRuntime(({ root, saveDir }) => ({ root, saveDir }))
    writeFileSync(join(rt.saveDir, 'old.sxm'), SXM) // 接入前就在的文件不算观测
    const a = agent('session-a')

    const scan = await rt.call('StartScan', a)
    expect(scan.content).toEqual([{ type: 'text', text: 'StartScan: running (readback verified)\nlatest_frame: null' }])

    const second = await rt.call('SetBias', a, { bias_v: '0.25' })
    expect(second.isError && second.error.message).toBe(ACT_GATE_REFUSAL)
    expect(rt.wire.mock.calls.some(([method]) => method === 'Bias_Set')).toBe(false)

    // 扫描结束：控制器自动保存了一帧
    rt.sim.running = false
    writeFileSync(join(rt.saveDir, 'scan001.sxm'), SXM)
    const status = await rt.call('GetScanStatus', a)
    expect(status.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    const [text, label] = texts(status)
    // 带图时每个文本块以换行结尾（同 stm_inspect，facts.md §9.6）
    expect(text).toMatch(/^GetScanStatus: stopped\nnew_frames: \[\{"frame":"t0001\.s0","turn":1,"kind":"scan","source":"scan001\.sxm",.*\]\n$/)
    expect(label).toMatch(/^<visual kind="current" frame="t0001\.s0" channel="Z" direction="forward" .*\/>\n$/)
    expect(status.content[2]).toMatchObject({ type: 'image', attachment: { name: 't0001.s0.png', mediaType: 'image/png' } })
    expect(rt.attachments.saved).toEqual(['t0001.s0.png'])

    await preStep(rt.ctx, a, 2)
    const bias = await rt.call('SetBias', a, { bias_v: '0.25' })
    expect(bias.content).toEqual([{ type: 'text', text: 'SetBias: 0.25 V (readback verified)\nlatest_frame: "t0001.s0"' }])

    // 每会话一份视觉记忆：帧在 session-a 的档案里，回看工具读得到
    expect(readdirSync(join(rt.root, 'sessions', 'session-a', 'frames'))).toContain('index.jsonl')
    const view = await rt.call('stm_inspect', a, { question: 'q', views: [{ label: 'v', frame: 't0001.s0' }] })
    expect(JSON.parse(texts(view)[0] as string)).toMatchObject({ view_count: 1 })

    // 两份证据：被拒的那一次在 JSONL 里是 refused，在 SQLite 里是闸门记的那一行
    const lines = rt.jsonl()
    expect(lines.map((l) => [l['toolCallId'], l['skill'], l['kind']])).toEqual([
      ['call-1', 'StartScan', 'ok'], ['call-2', 'SetBias', 'refused'], ['call-3', 'GetScanStatus', 'ok'], ['call-4', 'SetBias', 'ok'],
    ])
    expect(lines[1]).toMatchObject({ text: ACT_GATE_REFUSAL, instrumentCalls: [] })
    expect(lines[0]?.['observation']).toEqual({ frames: [], show: [], latestFrame: null, notArchived: [] })
    expect(lines[2]?.['observation']).toMatchObject({ frames: [{ id: 't0001.s0' }], show: ['t0001.s0'] })
    const rows = rt.ctx.stmRecords.store.db
      .prepare('SELECT action_type, status, error, tool_call_id FROM actions ORDER BY hlc')
      .all() as { action_type: string; status: string; error: string | null; tool_call_id: string }[]
    expect(rows.map((r) => [r.tool_call_id, r.action_type, r.status])).toEqual([
      ['call-1', 'StartScan', 'succeeded'], ['call-2', 'SetBias', 'failed'], ['call-3', 'GetScanStatus', 'succeeded'], ['call-4', 'SetBias', 'succeeded'],
    ])
    expect(rows[1]?.error).toBe(ACT_GATE_REFUSAL)
  })

  it('卸载时视觉工具、提示段与闸门一起走', async () => {
    const rt = await nativeRuntime(({ root, saveDir }) => ({ root, saveDir }))
    await rt.runtime.dispose()
    expect(rt.ctx.tools.schemas()).toEqual([])
    expect((await rt.sections()).map((s) => s.name)).not.toContain(VISUAL_HARNESS_PROMPT_NAME)
  })
})

describe('受管模式：保存目录问 stmsim', () => {
  it('不给 saveDir 时每次调用问 Util_SessionPathGet；两次读之间存下的帧在第二次入档并出图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'visual-managed-'))
    const saveDir = mkdtempSync(join(dir, 'session-'))
    vi.spyOn(StmsimProcess.prototype, 'start').mockResolvedValue()
    vi.spyOn(StmsimProcess.prototype, 'assertOwned').mockResolvedValue()
    vi.spyOn(StmsimProcess.prototype, 'stop').mockResolvedValue()
    vi.spyOn(minimal.ManagedSimulatorInstrument.prototype, 'closeAll').mockResolvedValue()
    const wire = vi.spyOn(minimal.ManagedSimulatorInstrument.prototype, 'call').mockImplementation(async (method) => ({
      method, command: method, args: [], role: 'main', at: Date.now(), elapsedMs: 1, simulated: true,
      values: method === 'Bias_Get' ? [0.5] : method === 'Util_SessionPathGet' ? [saveDir.length, saveDir] : [],
    }))
    const ctx = new Context()
    new TestCommands(ctx)
    new FakeAttachments(ctx)
    const prompt = ctx.plugin(SystemPrompt)
    const tools = ctx.plugin(ToolRuntime)
    await prompt.await()
    await tools.await()
    const runtime = ctx.plugin(minimal, {
      recordsPath: join(dir, 'records.sqlite'), resultsPath: join(dir, 'results.jsonl'),
      stateIntervalMs: 0, watchdogIntervalMs: 3_600_000, visualHarness: { root: join(dir, 'visual') },
    })
    cleanups.push(async () => {
      await runtime.dispose()
      await tools.dispose()
      await prompt.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    await runtime.await()
    expect(ctx.tools.schemas().map((s) => s.name).sort()).toEqual([...minimal.MINIMAL_TOOL_NAMES, ...VISUAL_TOOL_NAMES].sort())
    const call = (id: string) => ctx.tools.execute({
      name: 'GetBias', callId: id as never, arguments: {}, signal: new AbortController().signal, agent: agent('session-m'),
    })
    expect((await call('m1')).content).toEqual([{ type: 'text', text: 'GetBias: 0.5 V' }])
    writeFileSync(join(saveDir, 'scan001.sxm'), SXM)
    const second = await call('m2')
    expect(second.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    expect(texts(second)[0]).toMatch(/^GetBias: 0\.5 V\nnew_frames: \[\{"frame":"t0000\.s0","turn":0,"kind":"scan","source":"scan001\.sxm",/)
    expect(wire.mock.calls.filter(([method]) => method === 'Util_SessionPathGet')).toHaveLength(2)
  })
})

describe('配错的开关在接入模拟器之前失败', () => {
  it('本机模式缺 saveDir、保存目录不存在：都不接入', async () => {
    const start = vi.spyOn(NativeSimulatorConnection.prototype, 'start').mockResolvedValue()
    const dir = mkdtempSync(join(tmpdir(), 'visual-config-'))
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
    const base = { nativeSimulator: { pid: 123 }, recordsPath: join(dir, 'r.sqlite'), resultsPath: join(dir, 'r.jsonl') }
    const ctx = new Context()
    await expect(minimal.apply(ctx, { ...base, visualHarness: { root: join(dir, 'v') } })).rejects.toThrow(/本机 Nanonis 模式必须给 saveDir/)
    await expect(minimal.apply(ctx, { ...base, visualHarness: { root: join(dir, 'v'), saveDir: join(dir, 'missing') } })).rejects.toThrow(/不存在/)
    expect(start).not.toHaveBeenCalled()
  })
})
