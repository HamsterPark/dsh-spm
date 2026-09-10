/**
 * 投影 `mast.instrumentState` —— 回答「**模型当时看到的是哪一份仪器状态**」。
 *
 * ## 它与 SSE 的分工（决策 D7）
 *
 * SSE 回答「**现在**仪器什么样」——全局、高频、易失、不进会话。
 * 投影回答「**那一步**模型看到的是什么」——按会话、低频、可回放。
 * 两者不是冗余：一个人问「现在偏压多少」，另一个人问「模型做那个决定时以为偏压是多少」。
 *
 * ## 为什么它是个纯 fold
 *
 * dsh 的投影是「对**已提交**会话事件的纯同步 fold」，框架负责订阅、水位缓存与变更通知，
 * 我们只写 `init` / `apply` / `view`。**必须同步**（异步会把消费者的一致性切面撕开），
 * **状态必须是纯 JSON**（缓存要持久化）。
 *
 * ## 它折的是什么
 *
 * 1.8b 让实时状态块经 `systemPrompt.context()` 进模型，而 dsh 把这类内容落成一条
 * `form: 'snapshot'` 的**用户角色消息**，带按贡献者名字分开的 `sections`。
 * 所以这个 fold 只做一件事：从那条消息里把**我们那一段**挑出来。
 *
 * **只留最新的一份，不留历史**——这不是省事：投影本来就是「重放到第 N 个事件时的状态」，
 * 回放引擎重放到哪儿，fold 就给到哪儿的那一份。留全量既无界又多余。
 */

import { z } from 'zod'

/** 我们那段实时状态块在提示装配里的名字（与 `instrument-state` 里的常量同源）。 */
export const LIVE_STATE_SECTION = 'stm-live-state'

/** 投影出去的整值。**纯 JSON**——投影缓存要持久化它。 */
export interface MastInstrumentStateView {
  /** 模型最近一次看到的实时状态块**原文**；从没看到过就是 `null`。 */
  readonly lastSeenText: string | null
  /** 那一份是在哪个 seq 上进的模型输入。 */
  readonly lastSeenSeq: number | null
  /** 模型一共看到过几份**不同的**快照（同一份重发不计）。 */
  readonly count: number
}

export const EMPTY_VIEW: MastInstrumentStateView = {
  lastSeenText: null,
  lastSeenSeq: null,
  count: 0,
}

/** 够 fold 用的最小事件形状。真正的 `SessionEvent` 比这宽，但我们只看这几处。 */
export interface FoldableEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

interface SnapshotSource {
  readonly kind?: unknown
  readonly form?: unknown
  readonly sections?: readonly { readonly name?: unknown; readonly text?: unknown }[]
}

/**
 * 纯转移：上一份状态 + 一个已提交事件 → 下一份状态。
 *
 * **不关心的事件必须返回同一个引用**（`Object.is` 相等）——框架靠引用相等判断
 * 「这一步有没有变化」，返回一个内容相同的新对象会让每个事件都触发一次下游工作。
 */
export function applyEvent(
  state: MastInstrumentStateView,
  event: FoldableEvent,
): MastInstrumentStateView {
  if (event.type !== 'user/message') return state
  const data = event.data as { source?: SnapshotSource } | undefined
  const src = data?.source
  if (src === undefined || src.kind !== 'plugin' || src.form !== 'snapshot') return state
  const sections = src.sections
  if (!Array.isArray(sections)) return state

  const ours = sections.find((s) => s.name === LIVE_STATE_SECTION)
  const text = typeof ours?.text === 'string' ? ours.text : undefined
  if (text === undefined || text === '') return state
  // 同一份重发（dsh 只在内容变了时才产出新快照，但重放/分叉时可能重复）不计数
  if (text === state.lastSeenText) return state

  return { lastSeenText: text, lastSeenSeq: event.seq, count: state.count + 1 }
}

/**
 * 投影单元的定义体。`stateVersion` 在**序列化字段或 fold 语义改变时必须 +1**，
 * 否则旧版本缓存的行会被继续往前叠加成垃圾。
 */
export const MAST_INSTRUMENT_STATE_KEY = 'mast.instrumentState'
export const MAST_INSTRUMENT_STATE_VERSION = 1

/** 状态与线上视图同形，所以一个 schema 够用。**纯 JSON**——缓存要持久化它。 */
const viewSchema = z.object({
  lastSeenText: z.string().nullable(),
  lastSeenSeq: z.number().nullable(),
  count: z.number(),
})

/**
 * 投影单元。交给 `ctx.sessionProjections.register()`。
 *
 * `view` 直接把 `state` 交出去（两者同形）——**必须复用同一个引用**：
 * 框架拿前后两次 `view()` 的结果做 `Object.is` 比较来决定要不要发布，
 * 每次造个新对象就等于每个事件都发布一次。
 */
export const mastInstrumentStateProjection = {
  key: MAST_INSTRUMENT_STATE_KEY,
  stateVersion: MAST_INSTRUMENT_STATE_VERSION,
  stateSchema: viewSchema,
  init: (): MastInstrumentStateView => EMPTY_VIEW,
  apply: applyEvent,
  wire: {
    viewSchema,
    view: (state: MastInstrumentStateView): MastInstrumentStateView => state,
  },
} as const

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'mast.instrumentState': MastInstrumentStateView
  }
  interface SessionProjectionMap {
    'mast.instrumentState': MastInstrumentStateView
  }
}
