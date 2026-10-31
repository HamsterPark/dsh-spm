/**
 * 投影 fold 的测试。fold 是**纯同步函数**，所以不需要真 session——喂合成事件就够。
 * 要钉住的是三件事：挑对了那一段、不关心的事件返回同一个引用、重放到哪儿就是哪儿的那份。
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW, LIVE_STATE_SECTION, applyEvent, type FoldableEvent } from './projection.js'

/** 造一条「模型看到了实时状态块」的事件（形状照 dsh 的 runtime-context 快照）。 */
function snapshotEvent(seq: number, text: string, extraSections: { name: string; text: string }[] = []): FoldableEvent {
  return {
    type: 'user/message',
    seq,
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'runtime-context',
        form: 'snapshot',
        sections: [...extraSections, { name: LIVE_STATE_SECTION, text }],
      },
    },
  }
}

const BLOCK_A = '## Live instrument state (refreshed every LLM call)\n- Bias voltage: 1.5 V'
const BLOCK_B = '## Live instrument state (refreshed every LLM call)\n- Bias voltage: -2 V'

describe('投影 fold', () => {
  it('从快照消息里挑出我们那一段', () => {
    const s = applyEvent(EMPTY_VIEW, snapshotEvent(7, BLOCK_A))
    expect(s).toEqual({ lastSeenText: BLOCK_A, lastSeenSeq: 7, count: 1 })
  })

  it('别人的 section 不要——同一条快照里可能有好几个贡献者', () => {
    const e = snapshotEvent(3, BLOCK_A, [{ name: 'sandbox-policy', text: '沙箱说明' }])
    expect(applyEvent(EMPTY_VIEW, e).lastSeenText).toBe(BLOCK_A)
  })

  it('不关心的事件**返回同一个引用**——不然每个事件都触发一次下游工作', () => {
    const seen = applyEvent(EMPTY_VIEW, snapshotEvent(0, BLOCK_A))
    for (const e of [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, data: {} },
      // 是 user/message 但不是运行时上下文快照（真的用户说话）
      { type: 'user/message', seq: 3, data: { role: 'user', content: [], source: { kind: 'user' } } },
      // 别的生产者的消息，也不是 snapshot（比如 model-selection 的 notice）
      {
        type: 'user/message',
        seq: 4,
        data: { source: { kind: 'model-selection', form: 'notice', summary: 'x' } },
      },
      // 是 snapshot 但里面没有我们那一段
      {
        type: 'user/message',
        seq: 5,
        data: { source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: '别人', text: 'x' }] } },
      },
      // dsh 0.1.7 之前的来源形状（迁移前的旧会话日志）不再认
      {
        type: 'user/message',
        seq: 6,
        data: {
          source: {
            kind: 'plugin',
            plugin: '@deepseek-ai/dsh-system-prompt',
            form: 'snapshot',
            sections: [{ name: LIVE_STATE_SECTION, text: 'x' }],
          },
        },
      },
      // 所有 context 都为空时 dsh 发的「清空」快照：只有 kind，没有 form。不算新的一份——
      // 模型最近一次看到的实时状态块仍是上一份
      {
        type: 'user/message',
        seq: 7,
        data: {
          content: [{ type: 'text', text: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' }],
          source: { kind: 'runtime-context' },
        },
      },
    ] satisfies FoldableEvent[]) {
      expect(applyEvent(EMPTY_VIEW, e), `${e.type}@${e.seq}`).toBe(EMPTY_VIEW)
      expect(applyEvent(seen, e), `${e.type}@${e.seq}，已看到过一份之后`).toBe(seen)
    }
  })

  it('空块不算「看到过」', () => {
    const e = snapshotEvent(9, '')
    expect(applyEvent(EMPTY_VIEW, e)).toBe(EMPTY_VIEW)
  })

  it('同一份重发不计数，也不换引用', () => {
    const s1 = applyEvent(EMPTY_VIEW, snapshotEvent(1, BLOCK_A))
    const s2 = applyEvent(s1, snapshotEvent(2, BLOCK_A))
    expect(s2).toBe(s1)
    expect(s2.count).toBe(1)
  })

  it('重放到哪儿就是哪儿的那一份——这就是「模型当时看到什么」', () => {
    const events = [
      snapshotEvent(1, BLOCK_A),
      { type: 'assistant/message', seq: 2, data: {} },
      snapshotEvent(3, BLOCK_B),
      { type: 'assistant/message', seq: 4, data: {} },
    ] satisfies FoldableEvent[]

    const upTo = (n: number): ReturnType<typeof applyEvent> =>
      events.filter((e) => e.seq <= n).reduce(applyEvent, EMPTY_VIEW)

    expect(upTo(2).lastSeenText).toBe(BLOCK_A) // 第二步时模型以为偏压是 1.5 V
    expect(upTo(4).lastSeenText).toBe(BLOCK_B) // 第四步时已经是 -2 V
    expect(upTo(4).count).toBe(2)
  })
})
