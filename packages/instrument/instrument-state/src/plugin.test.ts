/**
 * 接线层的测试：**从哪读、多久读一次、怎么停**。判据本身在 `cache.test.ts` 对金样。
 *
 * 仪器用一个同名替身（Cordis 的服务注册表按**字符串名**索引，见 facts.md §6-17），
 * 因为这里要验的是「我们怎么调它」，不是它自己对不对。
 */
import { Context, Service } from 'dsh-spm-compat'
import { describe, expect, it } from 'vitest'
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
    const fake = new FakeInstrument(ctx)
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
    const fake = new FakeInstrument(ctx)
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
    const fake = new FakeInstrument(ctx)
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
      const fake = new FakeInstrument(ctx)
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

  it('没有 ctx.instrument 时整个不装载——inject 是装载依赖，不是运行时检查', async () => {
    const ctx = new Context()
    ctx.plugin(instrumentStateProvider, { intervalMs: 20 })
    await expect(stateOf(ctx, 300)).rejects.toThrow(/没挂上/)
  })

  it('applyPatch 立刻改快照并叫 onChanged——写技能不必等下一个 tick', async () => {
    const ctx = new Context()
    new FakeInstrument(ctx)
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
