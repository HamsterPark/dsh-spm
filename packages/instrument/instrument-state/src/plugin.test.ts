/**
 * 接线层的测试：**从哪读、多久读一次、怎么停**。判据本身在 `cache.test.ts` 对金样。
 *
 * 仪器用一个同名替身（Cordis 的服务注册表按**字符串名**索引，见 facts.md §6-17），
 * 因为这里要验的是「我们怎么调它」，不是它自己对不对。
 */
import { Context, Service, SystemPrompt, renderContextSections } from 'dsh-spm-compat'
import { describe, expect, it } from 'vitest'
import { LIVE_STATE_NAME } from './live-state.js'
import { instrumentStateProvider } from './plugin.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface SeenCall {
  method: string
  args: unknown[]
  role: unknown
  countHealth: unknown
}

class FakeInstrument extends Service {
  readonly seen: SeenCall[] = []
  reply: Record<string, unknown[] | undefined> = { Bias_Get: [1.5], Current_Get: [1.2e-10] }
  delayMs = 0

  constructor(ctx: Context) {
    super(ctx, 'instrument')
  }

  call(
    method: string,
    args: readonly unknown[],
    opts: { role?: unknown; countHealth?: unknown } = {},
  ): Promise<{ values?: readonly unknown[]; error?: string }> {
    this.seen.push({ method, args: [...args], role: opts.role, countHealth: opts.countHealth })
    const v = this.reply[method]
    const rec = v === undefined ? { error: 'Timeout: 没这个动词' } : { values: v }
    return this.delayMs === 0 ? Promise.resolve(rec) : sleep(this.delayMs).then(() => rec)
  }
}

/** 工具注册表的替身：只记下注册了什么。真的那份要拖进整个 dsh-tools 运行时。 */
class FakeTools extends Service {
  readonly registered: { name: string; execute: (args: unknown) => Promise<unknown> }[] = []

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: unknown): () => void {
    const t = tool as { name: string; execute: (args: unknown) => Promise<unknown> }
    this.registered.push(t)
    return () => void this.registered.splice(this.registered.indexOf(t), 1)
  }
}

/**
 * 把三个装载依赖都备齐。`systemPrompt` 用的是**真的那份**——它只是个注册表，没有 I/O，
 * 而这段要验的正是「我们那块确实进了 assembly」，用替身等于验了个寂寞。
 */
function host(ctx: Context): { fake: FakeInstrument; tools: FakeTools } {
  const fake = new FakeInstrument(ctx)
  const tools = new FakeTools(ctx)
  ctx.plugin(SystemPrompt, {})
  return { fake, tools }
}

/** 等 `ctx.instrumentState` 挂上来；超时 = 没装载（`inject` 不满足时 Cordis 静默不装）。 */
function stateOf(ctx: Context, timeoutMs = 2_000): Promise<Context['instrumentState']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrumentState 没挂上')), timeoutMs)
    ctx.inject(['instrumentState'], (c) => {
      clearTimeout(timer)
      resolve(c.instrumentState)
    })
  })
}

describe('ctx.instrumentState 的接线', () => {
  it('1 Hz 循环按周期跑，读到的值进快照', async () => {
    const ctx = new Context()
    const { fake } = host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 20 })
    const svc = await stateOf(ctx)

    await sleep(120)
    ctx.registry.delete(instrumentStateProvider)

    expect(fake.seen.length).toBeGreaterThanOrEqual(11 * 2) // 至少两轮，每轮 11 个读
    expect(svc.snapshot().bias_v).toBe(1.5)
    expect(svc.snapshot().current_a).toBe(1.2e-10)
    // 其余九个读不到 ⇒ 那些字段是 null，而不是 0。核心读有落地 ⇒ 链路是好的
    expect(svc.snapshot().z_pos_m).toBeNull()
    expect(svc.snapshot().stale).toBe(false)
  })

  it('每个读都走 monitor 角色且 countHealth:false —— 高频轮询不许洗掉别人的连败计数', async () => {
    const ctx = new Context()
    const { fake } = host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 }) // 关掉自动刷新，手动跑一轮
    const svc = await stateOf(ctx)

    await svc.refresh()
    expect(fake.seen).toHaveLength(11)
    for (const c of fake.seen) {
      expect(c.role, `${c.method} 的角色`).toBe('monitor')
      expect(c.countHealth, `${c.method} 的记账`).toBe(false)
    }
    ctx.registry.delete(instrumentStateProvider)
  })

  it('插件卸载后循环停下——不然卸载完的 profile 还在每秒打仪器', async () => {
    const ctx = new Context()
    const { fake } = host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 20 })
    await stateOf(ctx)
    await sleep(80)

    ctx.registry.delete(instrumentStateProvider)
    const after = fake.seen.length
    await sleep(120)
    expect(fake.seen.length).toBe(after)
  })

  it('卸载正落在一轮刷新中间时：立刻收手，且不留下没人接的 rejection', async () => {
    // 真机上一轮是 11 个串行往返，卸载落在中间几乎是常态。而 `ctx.instrument` 在上下文
    // 失活后**会抛**（`cannot get required service … in inactive context`，探针实测）——
    // 循环里没人接就是 unhandledRejection，默认会把进程打挂。
    // 光看调用次数分辨不出「安静收手」和「抛了一下」，所以这里直接盯 unhandledRejection。
    const rejections: unknown[] = []
    const onRej = (e: unknown): void => void rejections.push(e)
    process.on('unhandledRejection', onRej)
    try {
      const ctx = new Context()
      const { fake } = host(ctx)
      fake.delayMs = 12
      ctx.plugin(instrumentStateProvider, { intervalMs: 5 })
      await stateOf(ctx)

      await sleep(60) // 落在第一轮的中间（11 个读 × 12 ms）
      expect(fake.seen.length).toBeGreaterThan(0)
      expect(fake.seen.length).toBeLessThan(11)
      const atDelete = fake.seen.length
      ctx.registry.delete(instrumentStateProvider)

      await sleep(300) // 足够那一轮走完，也足够排两三轮新的
      expect(fake.seen.length, '卸载之后一个读都不该再发').toBe(atDelete)
      expect(rejections, '卸载不该留下没人接的 rejection').toEqual([])
    } finally {
      process.off('unhandledRejection', onRej)
    }
  })

  it('三个装载依赖缺任何一个都整个不装载——不是装上以后安静地少做一半事', async () => {
    // 少了 systemPrompt / tools 时缓存照样能转，但**模型再也看不到仪器读数**。
    // 那是个安静的安全回退，比「插件没装上」难发现得多，所以宁可整个不装。
    for (const missing of ['instrument', 'systemPrompt', 'tools'] as const) {
      const ctx = new Context()
      if (missing !== 'instrument') new FakeInstrument(ctx)
      if (missing !== 'tools') new FakeTools(ctx)
      if (missing !== 'systemPrompt') ctx.plugin(SystemPrompt, {})
      ctx.plugin(instrumentStateProvider, { intervalMs: 20 })
      await expect(stateOf(ctx, 300), `缺 ${missing} 时`).rejects.toThrow(/没挂上/)
    }
  })

  it('applyPatch 立刻改快照并叫 onChanged——写技能不必等下一个 tick', async () => {
    const ctx = new Context()
    host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    const svc = await stateOf(ctx)

    const seen: (boolean | null)[] = []
    const off = svc.onChanged((s) => seen.push(s.z_controller_on))
    svc.applyPatch({ z_controller_on: true })
    expect(svc.snapshot().z_controller_on).toBe(true)
    expect(seen).toEqual([true])

    off()
    svc.applyPatch({ scan_running: false })
    expect(seen).toEqual([true]) // 退订之后不再叫
    expect(svc.snapshot().scan_running).toBe(false) // 但 false 照样写进去了
    ctx.registry.delete(instrumentStateProvider)
  })
})

describe('把状态送进模型的两条路', () => {
  it('实时状态块进 assembly，名字与内容都对得上', async () => {
    const ctx = new Context()
    host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    const svc = await stateOf(ctx)
    await svc.refresh()

    const sections = renderContextSections(await ctx.systemPrompt.assemble())
    const ours = sections.find((s) => s.name === LIVE_STATE_NAME)
    expect(ours, `assembly 里没有 ${LIVE_STATE_NAME}`).toBeDefined()
    expect(ours!.text).toContain('## Live instrument state')
    expect(ours!.text).toContain('- Bias voltage: 1.5 V')
    ctx.registry.delete(instrumentStateProvider)
  })

  it('块的文本每次组装现取——不是装载那一刻定死的', async () => {
    const ctx = new Context()
    host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    const svc = await stateOf(ctx)

    const textNow = async (): Promise<string> =>
      renderContextSections(await ctx.systemPrompt.assemble()).find((s) => s.name === LIVE_STATE_NAME)
        ?.text ?? ''

    // 还没读过任何东西 ⇒ 空块 ⇒ dsh 那侧空文本的 context 不贡献任何 section
    expect(await textNow()).toBe('')
    await svc.refresh()
    expect(await textNow()).toContain('- Bias voltage: 1.5 V')
    svc.applyPatch({ bias_v: -0.75 })
    expect(await textNow()).toContain('- Bias voltage: -0.75 V')
    ctx.registry.delete(instrumentStateProvider)
  })

  it('stm_get_state 注册进工具表，跑一次是真去读而不是回缓存', async () => {
    const ctx = new Context()
    const { fake, tools } = host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    await stateOf(ctx)

    const tool = tools.registered.find((t) => t.name === 'stm_get_state')
    expect(tool, '工具没注册').toBeDefined()

    const before = fake.seen.length
    const out = await tool!.execute({})
    expect(fake.seen.length - before, '要真跑一轮 11 个读').toBe(11)
    expect(out).toContain('## Live instrument state')
    ctx.registry.delete(instrumentStateProvider)
  })

  it('一个字段都读不出来时说的是「读不到」，不是「一切正常」', async () => {
    const ctx = new Context()
    const { fake, tools } = host(ctx)
    fake.reply = {} // 所有动词都读不到
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    await stateOf(ctx)

    const tool = tools.registered.find((t) => t.name === 'stm_get_state')!
    expect(await tool.execute({})).toMatch(/读得出来|链路可能断了/)
    ctx.registry.delete(instrumentStateProvider)
  })

  it('插件卸载后提示块与工具都跟着撤——ctx.effect 的回滚', async () => {
    const ctx = new Context()
    const { tools } = host(ctx)
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    const svc = await stateOf(ctx)
    await svc.refresh()
    expect(tools.registered.map((t) => t.name)).toContain('stm_get_state')

    ctx.registry.delete(instrumentStateProvider)
    // 卸载是**异步**的：`registry.delete` 之后 disposer 排在后面跑（disposer 本身可以是
    // 异步的）。同一 tick 断言会看到「还挂着」——第一版就这么红了一次。
    await sleep(50)
    expect(tools.registered).toHaveLength(0)
    const sections = renderContextSections(await ctx.systemPrompt.assemble())
    expect(sections.find((s) => s.name === LIVE_STATE_NAME)).toBeUndefined()
  })
})
