/**
 * `scripts/model-minimal.ts` 在真模型会话之后读**持久会话日志**做验收：工具调用、与调用配对的工具结果、
 * 请求头里的路由与工具目录、模型请求数。那条脚本只有联网加模拟器才能整条跑，所以 dsh 改了日志形状时
 * （0.1.7 起会话 V4：工具结果成了独立的 `role: 'tool'` 消息），它会在验收的最后一步才坏。
 *
 * 这里用**真的** `AgentLoop` 产出一份同形状的事件流（脚本化的只有模型适配器与一个假工具），
 * 再用脚本里同一个取数函数去读，把「脚本读到的」钉在「dsh 真的写的」上。
 */
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Context, defineTool, SystemPrompt, ToolRuntime } from 'dsh-spm-compat'
import { describe, expect, it } from 'vitest'
import { pairedToolResult } from '../../../../scripts/minimal-session-log.ts'

/** 第 1 次回复调一次 `read_bias`，第 2 次回复一段文本。 */
class TwoStep extends LlmAdapter {
  requests = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.requests === 1) {
      yield { type: 'tool-call-delta', index: 0, id: 'c1' as ToolCallId, name: 'read_bias', argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: '偏压是 0.125 V' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Row {
  readonly type: string
  readonly seq: number
  readonly data: any
}

async function runOneToolRound(): Promise<{ events: Row[]; requests: number }> {
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  ctx.plugin(SessionStore)
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(AgentRegistry)
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentLoop, { agents: [] })
  await new Promise<void>((r) => ctx.inject(['agentLoop', 'agents', 'llm', 'tools'], () => r()))
  const model = new TwoStep()
  ctx.llm.registerAdapter(['script'], model)
  ctx.tools.register(
    defineTool({
      name: 'read_bias',
      description: '假的读偏压工具',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('bias_v=0.125 V'),
    }),
  )
  const events: Row[] = []
  ctx.on('session/event', (_session, event) => {
    events.push({ type: event.type, seq: Number(event.seq), data: event.data })
  })
  const handle = await ctx.agents.create({ sessionId: 'session-v4-reads' as SessionId, agentOptions: { provider: 'script', model: 'm' } })
  try {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '读一下偏压' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
  } finally {
    await handle.dispose()
  }
  return { events, requests: model.requests }
}

describe('model-minimal.ts 读的会话事件形状（真 AgentLoop 产出）', () => {
  it('工具调用事件带 name 与 callId', async () => {
    const { events } = await runOneToolRound()
    const calls = events.filter((e) => e.type === 'tool/call')
    expect(calls.map((e) => e.data.name)).toEqual(['read_bias'])
    expect(String(calls[0]!.data.callId)).toBe('c1')
  })

  it('pairedToolResult 按 callId 配出工具结果：role:tool、isError:false、文本里有读数', async () => {
    const { events } = await runOneToolRound()
    const result = pairedToolResult(events, 'c1')
    expect(result, '没有配到 c1 的 tool/result').toBeDefined()
    expect(result!.data.message.role).toBe('tool')
    expect(result!.data.message.isError).toBe(false)
    expect(JSON.stringify(result!.data.message)).toMatch(/-?\d+(?:\.\d+)?\s*V\b/)
    expect(pairedToolResult(events, 'nope')).toBeUndefined()
  })

  it('请求头里有路由与工具目录；助手消息数等于模型请求数', async () => {
    const { events, requests } = await runOneToolRound()
    const header = [...events].reverse().find((e) => e.type === 'request/header')?.data?.header
    expect(header?.config?.provider).toBe('script')
    expect(header?.config?.model).toBe('m')
    expect((header?.tools ?? []).map((tool: { name: string }) => tool.name)).toContain('read_bias')
    const assistant = events.filter((e) => e.type === 'assistant/message' || e.type === 'assistant/attempt')
    expect(assistant).toHaveLength(requests)
  })
})
