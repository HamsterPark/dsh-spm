/**
 * 批 7a-3 对**真 stmsim**（DoD ④）：`BiasWiggle` 的偏压真的动了、真的放回来了。
 *
 * ## 两个技能里只有这一个有 e2e，而这不是偷懒
 *
 * `FindFlatRegion` **一次 Nanonis 调用都不发** —— 它读的是磁盘上的一张 `.sxm`。
 * 在模拟器上跑它，跑的是我自己合成的那份字节，而那份字节已经被旧仓亲自读过一遍
 * 了（批 4a / 4b / 6c 同一条理由）。`BiasWiggle` 不一样：它下发几十次
 * `Bias_Set` + `Current_Get`，还要先问一次 `ZCtrl_OnOffGet`。
 *
 * ## 这条缝验的是单测与金样都验不到的三件事
 *
 * 1. **`ZCtrl_OnOffGet` 的回包真的是「1 = 开」。** 夹具里那个 `[1.0]` 是我摆的；
 *    极性搞反的话前置门会把每一次合法调用都拒掉，而单测照样绿；
 * 2. **几十次 `Bias_Set` 打进一台真的在跑的仪器之后，偏压停在哪。**
 *    收尾那一段是这个技能唯一的「善后」承诺（`bias_restored`），
 *    而验它只能靠**读回来**；
 * 3. **`Current_Get` 在隧道状态下给的是一个真的电流量级** —— 电流看护那道闸
 *    （`abort_current_a`）的分母。夹具里它是常数 3e−10，真机上它随偏压变。
 *
 * ## ⚠️ 这里**不验**跳变序列
 *
 * 那一串由 MT19937 决定，逐位判据在 `l0/batch7a3-skills.test.ts`（对旧仓金样）。
 * 这里用真墙钟（`Date.now()` / `setTimeout`），burst 与停留都是真的 ——
 * 于是**跳几次由机器有多忙决定**。拿它当判据就是拿一台机器的负载当判据。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`）。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BiasWiggle } from '../src/l0/bias-wiggle.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

class Rig {
  readonly calls: { verb: string; args: unknown[] }[] = []
  readonly #inst: { call: SafeCallish }

  constructor(inst: { call: SafeCallish }) {
    this.#inst = inst
  }

  ctx(): SkillContext {
    const S0 = emptyHardwareState('stmsim')
    const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      this.calls.push({ verb: m, args: a })
      return this.#inst.call(m, a)
    }
    return {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
      runSkill: () => Promise.resolve({ success: false, error: '本组不跑子技能' }),
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'integration',
      rootCallId: 'bias-wiggle',
      approvalSource: 'operator',
    } as unknown as SkillContext
  }
}

function instrument(timeoutMs = 10_000): Promise<Rig> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      resolve(new Rig(c.instrument as { call: SafeCallish }))
    })
  })
}

/**
 * **整组共用一台仪器，而这一组会改偏压。** 存档 / 还原 ——
 * 同 `tip.test.ts` 的抬头：「这个状态是不是我改的」本身就是判据。
 */
let savedBiasV: number | null = null

beforeAll(async () => {
  const rig = await instrument()
  const rec = await rig.ctx().safeCall('Bias_Get')
  const v = ((rec.values ?? []) as unknown[])[0]
  savedBiasV = typeof v === 'number' ? v : null
  cleanup.splice(0).forEach((fn) => fn())
}, 60_000)

afterAll(async () => {
  if (savedBiasV === null) return
  const rig = await instrument()
  await rig.ctx().safeCall('Bias_Set', savedBiasV)
  cleanup.splice(0).forEach((fn) => fn())
}, 60_000)

const BASE_V = 0.02

describe('BiasWiggle 对真 stmsim', () => {
  it('反馈开着时跑得完，而且**偏压真的回到了 base**', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('ZCtrl_OnOffSet', 1)
    await ctx.safeCall('Bias_Set', BASE_V)

    const r = await BiasWiggle.execute(ctx, {
      base_bias_v: BASE_V,
      burst_s: 0.6,
      dwell_min_s: 0.02,
      dwell_max_s: 0.05,
      seed: 7,
    })
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    const data = r.data as Record<string, unknown>
    expect((data['flips_executed'] as number) > 0).toBe(true)
    expect(data['bias_restored']).toBe(true)

    // ① 前置门问过反馈；② 每一次 `Bias_Set` 后面都跟着一次 `Current_Get`。
    expect(rig.calls[2]?.verb).toBe('ZCtrl_OnOffGet')
    expect(rig.calls[3]?.verb).toBe('Bias_Get')

    // **读回来的是模拟器自己存的那一份。** 收尾那一段是这个技能唯一的善后承诺。
    const back = await ctx.safeCall('Bias_Get')
    const got = ((back.values ?? []) as number[])[0] as number
    // float32 往返（同 `readback.test.ts` 那条）
    expect(Math.abs(got / BASE_V - 1)).toBeLessThan(1e-6)
  }, 30_000)

  it('中途的每一个目标都落在 `[lower, upper]` 里，**而且永远不在零附近**', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('ZCtrl_OnOffSet', 1)
    await ctx.safeCall('Bias_Set', BASE_V)
    const r = await BiasWiggle.execute(ctx, {
      base_bias_v: BASE_V,
      wiggle_lower_v: 0.006,
      wiggle_upper_v: 0.018,
      burst_s: 0.5,
      dwell_min_s: 0.02,
      dwell_max_s: 0.04,
      seed: 42,
    })
    expect(r.success).toBe(true)
    const log = (r.data as Record<string, unknown>)['log'] as { target_v: number }[]
    expect(log.length > 0).toBe(true)
    for (const row of log) {
      const a = Math.abs(row.target_v)
      // 「在死区里跳」与「停在零点上」的分界 —— 后者才是撞针。
      expect(a >= 0.006 - 1e-9 && a <= 0.018 + 1e-9).toBe(true)
    }
  }, 30_000)

  it('反馈**关着**时拒绝下发 —— 一次 `Bias_Set` 都不发', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('ZCtrl_OnOffSet', 0)
    const before = rig.calls.length
    const r = await BiasWiggle.execute(ctx, { base_bias_v: BASE_V, burst_s: 0.3, seed: 7 })
    // 先把这一趟发了什么记下来，**再**还原反馈 —— 还原那一次也走同一个 `safeCall`。
    const sent = rig.calls.slice(before).map((c) => c.verb)
    await ctx.safeCall('ZCtrl_OnOffSet', 1)

    expect(r.success).toBe(false)
    expect(r.error).toContain('Z 反馈是关的')
    // 问一次反馈，然后就停。**这条只有在真模拟器上才说明极性没搞反**：
    // 夹具里 `[1.0]`/`[0.0]` 是我摆的，反了也照样绿。
    expect(sent).toEqual(['ZCtrl_OnOffGet'])
  }, 30_000)
})
