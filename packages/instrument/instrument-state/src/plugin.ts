/**
 * `ctx.instrumentState` —— 1 Hz 后台刷新的仪器状态缓存。
 *
 * 这一层做接线：**从哪读**（`ctx.instrument` 的 monitor 角色）、**多久读一次**（默认 1 s）、
 * **怎么停**（插件卸载时 `ctx.effect` 回滚），以及**怎么送进模型**——每轮请求自带的实时状态块
 * （`systemPrompt.context`）与按需刷新的 `stm_get_state` 工具。
 * 判据全在 `cache.ts`，那里零 I/O、由金样逐步驱动。
 *
 * 三处刻意的选择：
 *
 * 1. **`countHealth: false`**。1 Hz 的只读轮询不进熔断记账——四个角色共用一个熔断器，
 *    而 `recordSuccess` 无条件清零连败计数，一个高频后台轮询会把别人的连败一直洗掉，
 *    「连续三次失败」这个条件永远凑不齐（1.5/1.6 定的规则，这里是第一个消费者）。
 * 2. **`inject` 是装载依赖**（`instrument` / `systemPrompt` / `tools`）。缺任何一样这个插件
 *    根本不装载，而不是装上以后安静地少做一半事。
 * 3. **刷新循环用 `setTimeout` 自排，不用 `setInterval`**。一次刷新是 11 个串行往返，
 *    真机上可能超过一秒；`setInterval` 会把慢刷新排成越堆越长的队，而我们要的语义是
 *    「上一轮结束后再等 1 秒」。
 */
import { type Context, Service, defineTool } from 'dsh-spm-compat'
import { HardwareStateCache, REFRESH_VERBS, type HistoryChannel, type StateReader } from './cache.js'
import { LIVE_STATE_NAME, formatLiveState } from './live-state.js'
import type { HardwareState } from 'dsh-spm-kernel'
// 只为把 `dsh-spm-instrument` 对 `Context` 的类型增补拉进来（`ctx.instrument`）。
// `import type {}` 不产生任何运行时 import——增补是类型层的，运行时靠 Cordis 的服务注册表。
import type {} from 'dsh-spm-instrument'

export const name = 'mast-instrument-state'

export interface Config {
  /** 刷新周期（毫秒）。0 或负数 = 不自动刷新，只由调用方手动 `refresh()`。 */
  readonly intervalMs?: number
}

export class InstrumentStateService extends Service {
  private readonly cache: HardwareStateCache
  private readonly listeners = new Set<(s: HardwareState) => void>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'instrumentState')
    this.cache = new HardwareStateCache()

    const intervalMs = config.intervalMs ?? 1_000
    // 这个 effect **无条件登记**：即使不自动刷新，也要在卸载时把停机闩合上——
    // 手动 `refresh()` 撞上已卸载的上下文同样会抛。
    ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const tick = async (): Promise<void> => {
        await this.refresh() // 永不抛：读不到就是读不到（D-STATE-1 + 下面的停机闩）
        if (!this.stopped) timer = setTimeout(() => void tick(), intervalMs)
      }
      if (intervalMs > 0) timer = setTimeout(() => void tick(), intervalMs)
      return () => {
        this.stopped = true
        if (timer !== undefined) clearTimeout(timer)
      }
    })
  }

  /**
   * 卸载闩。**`ctx.instrument` 在上下文失活后会抛** `cannot get required service
   * "instrument" in inactive context`（2026-09-09 探针实测）——而真机上一轮刷新是 11 个
   * 串行往返，卸载落在中间几乎是常态，那就是一个**没人接的 Promise rejection**。
   *
   * 不在循环外面包 try/catch：那样会把「读不到」和「代码写错了」一起吞掉。改成读之前
   * 先看这一位——「正在卸载」本来就该表达成「这一读没落地」，而缓存对没落地早有说法
   * （carry-forward + stale）。
   */
  private stopped = false

  /** 最近一次刷新的快照。**不碰网络**，随便调。 */
  snapshot(): HardwareState {
    return this.cache.snapshot()
  }

  history(ch: HistoryChannel): readonly number[] {
    return this.cache.history(ch)
  }

  /** 写回：一个成功的写技能回报的硬件事实，立刻进缓存，不等下一个 tick。 */
  applyPatch(fields: Readonly<Record<string, unknown>>): void {
    this.cache.applyPatch(fields)
    this.emit()
  }

  /** 立刻跑一轮 11 个读。前置条件不满足时先刷新再判，走的就是这条（K8，Phase 2）。 */
  async refresh(): Promise<HardwareState> {
    const s = await this.cache.refresh(this.reader)
    this.emit()
    return s
  }

  /** 每次快照更新都会叫一次。返回退订函数。 */
  onChanged(fn: (s: HardwareState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private readonly reader: StateReader = async (verb, args) => {
    // 同步地看一眼再取服务：两者之间没有 await，所以这一位为假时上下文一定还活着。
    if (this.stopped) return null
    const rec = await this.ctx.instrument.call(verb, [...args], {
      role: 'monitor',
      countHealth: false,
    })
    return rec.error === undefined ? (rec.values ?? null) : null
  }

  private emit(): void {
    const s = this.cache.snapshot()
    for (const fn of this.listeners) fn(s)
  }
}

/**
 * 实时状态块在提示里的位置。dsh 自己的 runtime context 占 110/115/120
 * （sandbox / approval / subagent delegation），我们排在它们之后：
 * 这块是**最易变**的，放最后离问题最近。
 */
const LIVE_STATE_ORDER = 200

export function apply(ctx: Context, config: Config = {}): void {
  const svc = new InstrumentStateService(ctx, config)

  // ① 提示段：每次组装提示时现取快照。**`context()` 不是 `section()`**——
  //    见 compat 里那段说明：前者落成 durable 的 user-role 快照进 model history。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: LIVE_STATE_NAME,
      order: LIVE_STATE_ORDER,
      // 空快照渲染成空串，dsh 那侧空文本的 context 不贡献任何东西——不用自己判空。
      text: () => formatLiveState(svc.snapshot()),
    }),
  )

  // ② 工具：模型可以主动要一次**新鲜**读数。提示块最多 1 秒旧，写完想立刻确认时不够。
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'stm_get_state',
        description:
          '读取仪器当前状态：立刻跑一轮真实读取（不是返回缓存），再把结果渲染成实时状态块。' +
          '只读，不改变仪器任何设置。写操作之后想确认是否生效时用它，' +
          '不必等每轮请求自带的那份（那份最多 1 秒旧）。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => {
          const s = await svc.refresh()
          const block = formatLiveState(s)
          // 一个字段都读不出来时说清楚是**读不到**，不是「仪器一切正常」。
          return block === '' ? '仪器没有任何字段读得出来——链路可能断了。' : block
        },
      }),
    ),
  )
}

/**
 * `inject` 是**装载依赖**，不是运行时检查（PLAN §6.1-3）：三样缺任何一样，这个插件
 * **根本不装载**，在插件树上留下明显的一行。
 *
 * `systemPrompt` / `tools` 也列进来是有意的：少了它们，缓存照样能转，但**模型再也看不到
 * 仪器读数**——那是个安静的安全回退，比「插件没装上」难发现得多。宁可整个不装。
 */
export const inject = ['instrument', 'systemPrompt', 'tools']

export const instrumentStateProvider = { name, inject, apply }

/** 动词表转出去，1.9 的看门狗与 1.10 的 SSE 都要按它对齐字段。 */
export { REFRESH_VERBS }

declare module '@deepseek-ai/cordis' {
  interface Context {
    instrumentState: InstrumentStateService
  }
}
