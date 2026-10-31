/**
 * 一动一观闸门跑在**真的** `dsh-agent-loop` 上（facts.md §9.5）。
 *
 * act-gate.test.ts 手动派发 `agent/pre-step`；这里由真 `AgentLoop` 驱动一整个回合，钉住闸门
 * 依赖、却只有 agent-loop 自己才能证明的那条时序：
 * 1. 第 S 步的全部 `tool/result` 都在第 S+1 步的 `agent/pre-step` **之前**提交进会话日志；
 * 2. 第 S+1 步的请求由日志推导，带着第 S 步的全部结果（被拒的那个也在）；
 * 3. 所以同一条 assistant 消息里的第二个动作被拒，下一步的动作放行。
 *
 * 只有模型是替身：脚本化的 `LlmAdapter`（第 1 次请求回两个动作 c1、c2，第 2 次回一个动作 c3，
 * 第 3 次回文本）。其余全是真包：AgentLoop、AgentRegistry、SessionStore、
 * SessionProjectionRegistry、LlmRuntime、ToolRuntime、SystemPrompt。
 * dsh 升级时这里先红；红了就照 facts.md §9.5 重新核对闸门的回执时机。
 */
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Context, SystemPrompt, ToolRuntime } from 'dsh-spm-compat'
import { ACT_GATE_REFUSAL, SkillKernel, emptyHardwareState, type Skill } from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { ActGateService } from '../src/act-gate.js'
import { defineSkillTool } from '../src/tool.js'

const S0 = emptyHardwareState('T0')

/** 一次模型回复：若干个工具调用（参数一律 `{}`），或者一段文本。 */
type Reply = { readonly calls: readonly (readonly [id: string, name: string])[] } | { readonly text: string }

/** 脚本化的模型：按次序回放，并记下每次请求带的消息。 */
class ScriptedModel extends LlmAdapter {
  readonly requests: RequestMessage[][] = []
  constructor(private readonly script: readonly Reply[]) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.script[this.requests.length]
    this.requests.push(options.messages)
    if (reply === undefined) throw new Error(`脚本只有 ${this.script.length} 次回复`)
    if ('text' in reply) {
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    for (const [index, [id, name]] of reply.calls.entries()) {
      yield { type: 'tool-call-delta', index, id: id as ToolCallId, name, argumentsDelta: '{}' }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

// dsh 0.2：工具结果是独立的 `role: 'tool'` 消息（toolCallId / isError 在消息上），
// 不再是 user 消息里的 `tool-result` 块。
type ToolResultMessage = Extract<RequestMessage, { role: 'tool' }>

const toolResultsIn = (messages: readonly RequestMessage[]): ToolResultMessage[] =>
  messages.filter((m): m is ToolResultMessage => m.role === 'tool')

/** 一次请求里的全部工具结果：`[调用 id, 是否出错]`，按出现顺序。 */
const resultsOf = (messages: readonly RequestMessage[] | undefined): [string, boolean][] =>
  toolResultsIn(messages ?? []).map((m) => [String(m.toolCallId), m.isError === true])

/** 被拒结果的正文。 */
const refusalText = (messages: readonly RequestMessage[] | undefined, callId: string): string =>
  toolResultsIn(messages ?? [])
    .filter((m) => String(m.toolCallId) === callId)
    .flatMap((m): readonly ContentBlock[] => m.content)
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('')

describe('真 agent-loop 驱动的一动一观', () => {
  it('同一步的第二个动作被拒；两个结果都在下一步的 pre-step 之前提交、进了下一次请求；下一步的动作放行', async () => {
    const ctx = new Context()
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(SessionStore)
    ctx.plugin(SessionProjectionRegistry)
    ctx.plugin(AgentRegistry)
    ctx.plugin(LlmRuntime)
    ctx.plugin(AgentLoop, { agents: [] })
    await new Promise<void>((r) => ctx.inject(['agentLoop', 'agents', 'llm', 'tools'], () => r()))

    const model = new ScriptedModel([
      { calls: [['c1', 'SetBias'], ['c2', 'StartScan']] },
      { calls: [['c3', 'StartScan']] },
      { text: '扫完了' },
    ])
    ctx.llm.registerAdapter(['script'], model)

    const ran: string[] = []
    const gate = new ActGateService(ctx)
    for (const name of ['SetBias', 'StartScan']) {
      const skill: Skill = {
        spec: { name, description: `假技能 ${name}`, parameters: [], category: 'write', tags: [] },
        execute: () => {
          ran.push(name)
          return Promise.resolve({ success: true, summary: `${name}: ok` })
        },
      }
      ctx.tools.register(defineSkillTool(skill, { kernel: new SkillKernel({ snapshot: () => S0 }) }))
      gate.registerSkill(skill.spec)
    }

    // 一条时间线：pre-step 与会话日志里的工具事件，按发生顺序
    const timeline: string[] = []
    ctx.on('agent/pre-step', (payload, next) => {
      timeline.push(`pre-step ${payload.turn}.${payload.step}`)
      return next()
    })
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/call') timeline.push(`tool/call ${String(event.data.callId)}`)
      if (event.type === 'tool/result') timeline.push(`tool/result ${String(event.data.message.toolCallId)}`)
    })

    const handle = await ctx.agents.create({ sessionId: 'act-gate-loop' as SessionId, agentOptions: { provider: 'script', model: 'm' } })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '设偏压，然后扫一张' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    } finally {
      await handle.dispose()
    }

    expect(timeline).toEqual([
      'pre-step 1.1',
      'tool/call c1',
      'tool/result c1',
      'tool/call c2', // 同一条 assistant 消息里的第二个动作……
      'tool/result c2', // ……被拒，结果照样提交
      'pre-step 1.2', // 回执落在这里：此刻 c1、c2 的结果都已在日志里
      'tool/call c3',
      'tool/result c3',
      'pre-step 1.3',
    ])
    expect(ran).toEqual(['SetBias', 'StartScan']) // c1 与 c3 跑了，c2 没跑

    expect(model.requests).toHaveLength(3)
    expect(resultsOf(model.requests[0])).toEqual([])
    expect(resultsOf(model.requests[1])).toEqual([
      ['c1', false],
      ['c2', true],
    ])
    expect(refusalText(model.requests[1], 'c2')).toBe(`Error: ${ACT_GATE_REFUSAL}`)
    expect(resultsOf(model.requests[2])).toEqual([
      ['c1', false],
      ['c2', true],
      ['c3', false],
    ])
  })
})
