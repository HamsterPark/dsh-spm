/**
 * 挂着视觉线束的本机最小运行栈，由**真的** `dsh-agent-loop` 驱动一整个回合（不联网、无密钥）。
 *
 * 只有三样是替身：模型（脚本化的 `LlmAdapter`）、本机连接与仪器（同 `native-runtime.test.ts`）、
 * 附件服务。其余都是真包：AgentLoop、AgentRegistry、SessionStore、SessionProjectionRegistry、
 * LlmRuntime、ToolRuntime、SystemPrompt，以及本仓的最小运行栈本身（`visualHarness` 开）。
 *
 * 回合：模型第 1 次回 StartScan + SetBias（同一条消息里的两个动作）；扫描在模型思考时结束，控制器
 * 存下一帧；第 2 次回 GetScanStatus；第 3 次回文本。钉住：
 * - 同一步的第二个动作被一动一观拒绝，第 2 次请求带着两个结果；
 * - 新帧在下一次调用（GetScanStatus）入档，那次结果带着观测图进第 3 次请求；
 * - 视觉线束的提示段与工具在每次请求里；JSONL 三次调用各一行（被拒的是 refused）。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef } from 'dsh-spm-compat'
import { ACT_GATE_REFUSAL } from 'dsh-spm-kernel'
import { VISUAL_TOOL_NAMES, encodeSyntheticSxm, pngSize } from 'dsh-spm-visual-memory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as minimal from '../src/minimal.js'
import { NativeSimulatorConnection, NativeSimulatorInstrument } from '../src/native-simulator.js'

const SXM = encodeSyntheticSxm({
  nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 0, offsetYM: 0, scanDir: 'down',
  channels: [{ name: 'Z', unit: 'm', forward: Float32Array.from({ length: 128 }, (_, i) => 1e-12 * (i % 16)) }],
})

type Reply = { readonly calls: readonly (readonly [id: string, name: string, args: string])[] } | { readonly text: string }

/** 脚本化的模型：按次序回放；`before(i)` 在第 i 次请求回复之前跑（模拟模型思考时仪器那边发生的事）。 */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: readonly Reply[], private readonly before: (i: number) => void) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const i = this.requests.length
    const reply = this.script[i]
    this.requests.push(options)
    if (reply === undefined) throw new Error(`脚本只有 ${this.script.length} 次回复`)
    this.before(i)
    if ('text' in reply) {
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    for (const [index, [id, name, args]] of reply.calls.entries()) {
      yield { type: 'tool-call-delta', index, id: id as ToolCallId, name, argumentsDelta: args }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class TestCommands extends Service {
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(): () => void { return () => {} }
}

class FakeAttachments extends Service {
  constructor(ctx: Context) { super(ctx, 'attachments') }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef> {
    const { width, height } = pngSize(input.data)
    return Promise.resolve({
      attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`,
      mediaType: 'image/png', bytes: input.data.length, width, height,
      ...(input.name === undefined ? {} : { name: input.name }),
    } as unknown as ImageAttachmentRef)
  }
}

type ToolResultBlock = Extract<ContentBlock, { type: 'tool-result' }>
const toolResults = (messages: readonly Message[] | undefined): ToolResultBlock[] =>
  (messages ?? []).flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === 'tool-result')
const textOf = (blocks: readonly ContentBlock[]): string => blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
const systemText = (messages: readonly Message[]): string =>
  messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n')

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('真 agent-loop 驱动、挂着视觉线束的本机运行栈', () => {
  it('第二个动作被拒；扫描帧在下一次调用入档，结果带着观测图进下一次请求', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'visual-loop-'))
    dirs.push(dir)
    const saveDir = mkdtempSync(join(dir, 'save-'))
    const root = join(dir, 'visual')
    const resultsPath = join(dir, 'results.jsonl')

    vi.spyOn(NativeSimulatorConnection.prototype, 'start').mockResolvedValue()
    vi.spyOn(NativeSimulatorConnection.prototype, 'assertOwned').mockResolvedValue()
    vi.spyOn(NativeSimulatorConnection.prototype, 'assertCurrent').mockResolvedValue()
    vi.spyOn(NativeSimulatorConnection.prototype, 'stop').mockResolvedValue()
    vi.spyOn(NativeSimulatorInstrument.prototype, 'closeAll').mockResolvedValue()
    const sim = { bias: 0.125, running: false }
    const methods: string[] = []
    vi.spyOn(NativeSimulatorInstrument.prototype, 'call').mockImplementation(async (method, args) => {
      methods.push(method)
      if (method === 'Bias_Set') sim.bias = Number(args[0])
      if (method === 'Scan_Action') sim.running = Number(args[0]) === 0
      const values: Record<string, unknown[]> = {
        Bias_Get: [sim.bias], ZCtrl_OnOffGet: [1], Scan_StatusGet: [sim.running ? 1 : 0], Scan_PropsGet: [0],
      }
      return { method, command: method, args: [], role: 'main', values: values[method] ?? [], at: Date.now(), elapsedMs: 1, simulated: true }
    })

    const ctx = new Context()
    new TestCommands(ctx)
    new FakeAttachments(ctx)
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(SessionStore)
    ctx.plugin(SessionProjectionRegistry)
    ctx.plugin(AgentRegistry)
    ctx.plugin(LlmRuntime)
    ctx.plugin(AgentLoop, { agents: [] })
    const runtime = ctx.plugin(minimal, {
      nativeSimulator: { pid: 123 }, recordsPath: join(dir, 'records.sqlite'), resultsPath,
      visualHarness: { root, saveDir },
    })
    await runtime.await()
    await new Promise<void>((r) => ctx.inject(['agentLoop', 'agents', 'llm', 'tools', 'minimalSpm'], () => r()))

    const model = new ScriptedModel([
      { calls: [['c1', 'StartScan', '{}'], ['c2', 'SetBias', '{"bias_v":"0.3"}']] },
      { calls: [['c3', 'GetScanStatus', '{}']] },
      { text: '扫完了，帧已入档。' },
    ], (i) => {
      // 模型想第 2 步的时候扫描结束，控制器自动保存了一帧
      if (i === 1) {
        sim.running = false
        writeFileSync(join(saveDir, 'scan001.sxm'), SXM)
      }
    })
    ctx.llm.registerAdapter(['script'], model)

    const handle = await ctx.agents.create({ sessionId: 'visual-loop' as SessionId, agentOptions: { provider: 'script', model: 'm' } })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '扫一帧，再把偏压设到 0.3 V' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    } finally {
      await handle.dispose()
    }

    expect(model.requests).toHaveLength(3)
    for (const request of model.requests) {
      // 线束的提示段与工具在每一次请求里
      expect(systemText(request.messages)).toContain('# Instrument task')
      expect(systemText(request.messages)).toContain('视觉线束已开启')
      expect(request.tools?.map((t) => t.name).sort()).toEqual([...minimal.NATIVE_TOOL_NAMES, ...VISUAL_TOOL_NAMES].sort())
    }

    // 第 2 次请求：c1 的结果（没有新帧）与 c2 的拒绝
    const second = toolResults(model.requests[1]?.messages)
    expect(second.map((b) => [String(b.toolCallId), b.isError === true])).toEqual([['c1', false], ['c2', true]])
    expect(textOf(second[0]!.content)).toBe('StartScan: running (readback verified)\nlatest_frame: null')
    expect(textOf(second[1]!.content)).toBe(`Error: ${ACT_GATE_REFUSAL}`)
    expect(methods).not.toContain('Bias_Set')

    // 第 3 次请求：c3 的结果带着新帧与观测图
    const third = toolResults(model.requests[2]?.messages)
    expect(third.map((b) => String(b.toolCallId))).toEqual(['c1', 'c2', 'c3'])
    const c3 = third[2]!
    expect(c3.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    expect(textOf(c3.content)).toMatch(/^GetScanStatus: stopped\nnew_frames: \[\{"frame":"t0001\.s0","turn":1,"kind":"scan","source":"scan001\.sxm",/)
    expect(c3.content[2]).toMatchObject({ type: 'image', attachment: { name: 't0001.s0.png', mediaType: 'image/png' } })

    // JSONL：三次调用各一行，被拒的那次是 refused
    const lines = readFileSync(resultsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((l) => [l['toolCallId'], l['skill'], l['kind']])).toEqual([
      ['c1', 'StartScan', 'ok'], ['c2', 'SetBias', 'refused'], ['c3', 'GetScanStatus', 'ok'],
    ])

    await runtime.dispose()
  })
})
