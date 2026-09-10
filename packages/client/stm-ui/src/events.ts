/**
 * `/mast/events` 的事件模型与环形重放 —— **纯逻辑，不碰 HTTP**。
 *
 * 为什么仪器实时状态走 SSE 而不走 session 投影（决策 D7）：
 * 1 Hz × 10 小时 = **36000 个事件/会话**，投进 session log 会把回放拖垮；
 * 而且**仪器是一台，会话是 N 个**——没有会话的时候状态也在变，无处可投。
 * 所以：全局高频易失走 SSE，按会话低频要回放才走投影。
 *
 * 三条硬约束，每条都有它防的东西：
 *
 * 1. **帧里永远只有指针与标量。** 一张图内联进来就能把整条通道堵死，而 SSE 是
 *    单向长连接、堵住了客户端只会「看起来卡住」。所以 `push` 对超限的载荷**直接抛**
 *    ——在生产端炸，比在传输中默默截断好。
 * 2. **客户端遇到未知 `type` 必须忽略。** 事件类型是闭集但会长；老客户端遇到新类型
 *    应当跳过而不是报错，否则加一个事件类型就要求所有客户端同步升级。
 * 3. **重放有缺口就明说。** 环只有 100 条；断线太久的客户端要不到完整历史时，
 *    收到的第一条是 `dropped`，让它知道自己**漏了**而不是以为一切正常。
 */

/** 事件类型闭集（PLAN §9.2）。加类型要同时更新客户端的忽略规则。 */
export const MAST_EVENT_TYPES = [
  'hardware_state',
  'comms',
  'current_monitor',
  'scan_progress',
  'frame_saved',
  'vision_event',
  'alert',
  'estop_latch',
  'safety',
  'experiment',
  'conduct_status',
  'conduct_gate',
  'conduct_alert',
  'artifact_saved',
  'skill_recommendation',
  'wishlist_changed',
  'narration',
  /** 环里已经没有你要的那一段了——**这是缺口通告，不是数据**。 */
  'dropped',
] as const

export type MastEventType = (typeof MAST_EVENT_TYPES)[number]

export interface MastEvent {
  readonly seq: number
  readonly type: MastEventType
  readonly at: number
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * 单个事件载荷的字节上限。**不是性能调优，是通道的生存条件**：
 * 一张 512×512 的图 base64 进来就是几百 KB，一条就够把 1 Hz 的状态流挤到几秒之后。
 */
export const MAX_EVENT_BYTES = 4096

export class EventPayloadTooLarge extends Error {
  override readonly name = 'EventPayloadTooLarge'
}

export interface RingOptions {
  /** 环里留多少条。默认 100。 */
  readonly capacity?: number
  readonly clock?: () => number
}

/**
 * 环形重放缓冲。`seq` **单调递增且不复用**——客户端拿它做 `Last-Event-ID`，
 * 复用过的 seq 会让「我看到哪儿了」这句话失去意义。
 */
export class EventRing {
  private readonly capacity: number
  private readonly clock: () => number
  private readonly buf: MastEvent[] = []
  private nextSeq = 1

  constructor(opts: RingOptions = {}) {
    this.capacity = opts.capacity ?? 100
    this.clock = opts.clock ?? (() => Date.now())
  }

  /** 最新的 seq；还没有事件时是 0。 */
  get lastSeq(): number {
    return this.nextSeq - 1
  }

  /** 环里最老的那条的 seq；空环是 0。 */
  get oldestSeq(): number {
    return this.buf.length === 0 ? 0 : this.buf[0]!.seq
  }

  /**
   * 发一条。**超限直接抛**——在生产端炸比在传输中默默截断好：
   * 截断了的话，客户端收到一条语法正确、语义残缺的事件，没人会发现。
   */
  push(type: MastEventType, data: Readonly<Record<string, unknown>>): MastEvent {
    const json = JSON.stringify(data)
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > MAX_EVENT_BYTES) {
      throw new EventPayloadTooLarge(
        `事件 ${type} 的载荷 ${bytes} 字节，超过上限 ${MAX_EVENT_BYTES}。` +
          '帧里只放指针与标量——图像与长文本走引用（PLAN §9.2）。',
      )
    }
    const e: MastEvent = { seq: this.nextSeq++, type, at: this.clock(), data }
    this.buf.push(e)
    if (this.buf.length > this.capacity) this.buf.shift()
    return e
  }

  /**
   * 重放 `since` 之后的事件。
   *
   * `since` 比环里最老的还老 ⇒ **有缺口**：第一条给 `dropped`，
   * 把「你漏了从哪到哪」说清楚，而不是安静地少给几条。
   */
  since(sinceSeq: number): readonly MastEvent[] {
    if (this.buf.length === 0) return []
    const oldest = this.oldestSeq
    if (sinceSeq > 0 && sinceSeq < oldest - 1) {
      const gap: MastEvent = {
        seq: oldest - 1,
        type: 'dropped',
        at: this.clock(),
        data: { fromSeq: sinceSeq + 1, toSeq: oldest - 1, capacity: this.capacity },
      }
      return [gap, ...this.buf]
    }
    return this.buf.filter((e) => e.seq > sinceSeq)
  }
}

/**
 * 把一条事件编成 SSE 帧。
 *
 * `id:` 用 seq —— 浏览器的 `EventSource` 断线重连时会**自动**把它放进
 * `Last-Event-ID` 请求头，所以续传不需要客户端记任何东西。
 */
export function formatSse(e: MastEvent): string {
  return `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`
}

/**
 * 从请求里解析「我看到哪儿了」。
 * 优先 `Last-Event-ID` 头（`EventSource` 自动带），退回 `?since=`（手写客户端与轮询降级用）。
 * 解析不出来就是 0 = 从环里现有的最早处开始。
 */
export function parseSince(header: string | string[] | undefined, url: string | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header
  const fromHeader = Number(raw)
  if (Number.isInteger(fromHeader) && fromHeader >= 0) return fromHeader
  if (url !== undefined) {
    const m = /[?&]since=(\d+)/.exec(url)
    if (m !== null) return Number(m[1])
  }
  return 0
}
