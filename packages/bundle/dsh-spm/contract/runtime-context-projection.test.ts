/**
 * 投影 `mast.instrumentState` 折的是 dsh 自己产出的运行时上下文快照：`instrument-state` 用
 * `systemPrompt.context()` 登记实时状态块，`dsh-agent-loop` 在请求前把当前上下文落成一条
 * `form: 'snapshot'` 的 user/message。stm-ui 的单元测试喂手写事件，只证明「形状对就能折」；
 * 这里整条链都是真的——真插件登记、真 AgentLoop 产出、真投影注册表折——替身只有模型
 * （脚本化的 `LlmAdapter`）与仪器（只回两个读数的进程内服务）。
 *
 * dsh 0.1.7 起快照来源从 `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', … }`
 * 改成了生产者自己的 kind：`{ kind: 'runtime-context', form: 'snapshot', sections }`（上游类型注释：
 * "there is no shared catch-all `plugin` kind"）。手写事件的单元测试对此照绿，只有这一条会红。
 */
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Context, Service, SystemPrompt, ToolRuntime } from 'dsh-spm-compat'
import { formatLiveState, instrumentStateProvider, LIVE_STATE_NAME } from 'dsh-spm-instrument-state'
import { applyEvent, EMPTY_VIEW, LIVE_STATE_SECTION, mastInstrumentStateProjection, type FoldableEvent } from 'dsh-spm-stm-ui'
import { describe, expect, it } from 'vitest'

/** 脚本化的模型：回一句话，不调工具。 */
class OneReply extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '好的' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 仪器替身：只回偏压与电流，其余动词都读不到。 */
class TwoReadings extends Service {
  constructor(ctx: Context) {
    super(ctx, 'instrument')
  }
  call(method: string): Promise<{ values?: readonly unknown[]; error?: string }> {
    const values: Record<string, readonly unknown[]> = { Bias_Get: [0.125], Current_Get: [1.2e-10] }
    const v = values[method]
    return Promise.resolve(v === undefined ? { error: `${method}: 替身不回这个动词` } : { values: v })
  }
}

describe('运行时上下文快照 → mast.instrumentState', () => {
  it('真 AgentLoop 产出的快照被 stm-ui 的 fold 与投影注册表认出来', async () => {
    // 两头各有一个常量：instrument-state 登记用 LIVE_STATE_NAME，stm-ui 折的时候找 LIVE_STATE_SECTION
    expect(LIVE_STATE_SECTION, 'stm-ui 折的段名必须就是 instrument-state 登记的段名').toBe(LIVE_STATE_NAME)

    const ctx = new Context()
    new TwoReadings(ctx)
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(SessionStore)
    ctx.plugin(SessionProjectionRegistry)
    ctx.plugin(AgentRegistry)
    ctx.plugin(LlmRuntime)
    ctx.plugin(AgentLoop, { agents: [] })
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    await new Promise<void>((r) => ctx.inject(['agentLoop', 'agents', 'llm', 'sessionProjections', 'instrumentState'], () => r()))
    ctx.llm.registerAdapter(['script'], new OneReply())
    ctx.sessionProjections.register(mastInstrumentStateProjection)

    const block = formatLiveState(await ctx.instrumentState.refresh())
    expect(block).toContain('- Bias voltage: 0.125 V')

    const events: FoldableEvent[] = []
    ctx.on('session/event', (_session, event) => {
      events.push({ type: event.type, seq: Number(event.seq), data: event.data })
    })

    let projected: unknown
    const handle = await ctx.agents.create({ sessionId: 'runtime-context' as SessionId, agentOptions: { provider: 'script', model: 'm' } })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '现在偏压多少' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      // dispose 会把会话从 store 里拿掉，投影要在那之前读
      projected = ctx.sessionProjections.stateOf(handle.agent.session, 'mast.instrumentState')
    } finally {
      await handle.dispose()
    }

    // 快照消息本身：kind 写成字面量，上游再改名时这一条直接指出变了什么
    const snapshots = events.filter((e) => e.type === 'user/message' && (e.data as { source?: { form?: unknown } }).source?.form === 'snapshot')
    expect(snapshots).toHaveLength(1)
    const snapshot = snapshots[0]!
    expect((snapshot.data as { source: unknown }).source).toMatchObject({
      kind: 'runtime-context',
      form: 'snapshot',
      sections: [{ name: LIVE_STATE_SECTION, text: block }],
    })

    // 纯 fold 与框架里的投影单元给出同一个答案：模型看到的就是这一份
    const expected = { lastSeenText: block, lastSeenSeq: snapshot.seq, count: 1 }
    expect(events.reduce(applyEvent, EMPTY_VIEW)).toEqual(expected)
    expect(projected).toEqual(expected)
  })
})
