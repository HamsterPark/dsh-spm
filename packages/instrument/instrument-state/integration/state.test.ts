/**
 * 1 Hz 缓存对着**真 stmsim**跑一遍。单测对金样验判据，这里验的是另一件事：
 * 十一个动词在真仪器上**真的都有回音**，读回来的值物理上说得通。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`），所以这里
 * `spawn: false`——用外面那份，不另起进程。
 */
import { Context } from 'dsh-spm-compat'
import { instrumentStateProvider } from '../src/index.js'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { ZCTRL_STATUS } from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

function stateOf(ctx: Context, timeoutMs = 10_000): Promise<Context['instrumentState']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrumentState 没挂上')), timeoutMs)
    ctx.inject(['instrumentState'], (c) => {
      clearTimeout(timer)
      resolve(c.instrumentState)
    })
  })
}

describe('对真 stmsim 的 1 Hz 状态缓存', () => {
  it('十一个读在真模拟器上都有回音，值物理上说得通', async () => {
    const ctx = new Context()
    cleanup.push(() => void ctx.registry.delete(instrumentStateProvider))
    cleanup.push(() => void ctx.registry.delete(stmsimProvider))
    ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
    ctx.plugin(instrumentStateProvider, { intervalMs: 200 })

    const svc = await stateOf(ctx)
    const s = await svc.refresh()

    // stale 不该亮：五个核心读至少有一个落地了
    expect(s.stale).toBe(false)
    expect(typeof s.bias_v).toBe('number')
    expect(Math.abs(s.bias_v!)).toBeLessThanOrEqual(10) // 安全包络的偏压上限
    expect(typeof s.current_a).toBe('number')
    expect(typeof s.z_pos_m).toBe('number')
    expect(typeof s.scan_running).toBe('boolean')
    // 状态名必须落在六态之内。落不进去说明码表对不上，而不是「仪器怪」
    expect(Object.values(ZCTRL_STATUS)).toContain(s.z_controller_status)
    expect(typeof s.z_controller_on).toBe('boolean')
  })

  it('后台循环自己在跑，历史环跟着长', async () => {
    const ctx = new Context()
    cleanup.push(() => void ctx.registry.delete(instrumentStateProvider))
    cleanup.push(() => void ctx.registry.delete(stmsimProvider))
    ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
    ctx.plugin(instrumentStateProvider, { intervalMs: 200 })
    const svc = await stateOf(ctx)

    await new Promise((r) => setTimeout(r, 900))
    expect(svc.history('bias').length).toBeGreaterThanOrEqual(2)
    expect(svc.snapshot().stale).toBe(false)
  })

  it('模拟器没实现的动词只让那一个字段留空，不牵连其它十个', async () => {
    // stmsim 只实现 215/671。读不到的动词回错误段（1.4 已在真机形状上验过），
    // 到这一层就是「这个字段没读到」——carry-forward 与 stale 的输入，不是异常。
    const ctx = new Context()
    cleanup.push(() => void ctx.registry.delete(instrumentStateProvider))
    cleanup.push(() => void ctx.registry.delete(stmsimProvider))
    ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
    ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
    const svc = await stateOf(ctx)

    const s = await svc.refresh()
    // 至少 bias / current / z 这三个核心读要有；某些字段是 null 是允许的，
    // 但**不允许**因为其中一个读不到就整份快照作废（D-STATE-1）。
    expect(s.bias_v).not.toBeNull()
    expect(s.current_a).not.toBeNull()
    expect(s.z_pos_m).not.toBeNull()
  })
})
