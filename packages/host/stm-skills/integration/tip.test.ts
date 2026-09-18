/**
 * 批 5a 对**真 stmsim**：修针那一串命令，以及方案表填进去的值真的下到了线上。
 *
 * ## 这条缝验的是单测与金样都验不到的两件事
 *
 * 1. **那 11 个参数的顺序**。`TipShaper_PropsSet` 是本仓参数最多的一条写命令，而
 *    单测里回包是我自己摆的 —— 抄错两个位置，夹具照样绿。这里写完之后
 *    **用 `TipShaper_PropsGet` 读回来比**：顺序错一位，那一格当场变红。
 *    （`TipShapeWithReadback`（批 3j）从来没做过这件事：它 `wait=0` 边跑边采，
 *    没有一个「写下去的东西读回来」的比对点。）
 * 2. **`TipShaper_Start(wait=1)` 真的会回来。** 单测里它是一次同步返回；这里是一台
 *    真的在跑四段 Z 轨迹的模拟器（`switch_off_delay + t1 + settle + t2 + end_wait`
 *    之后才回话），而 `timeout_ms=-1` 是「永远等」。
 *
 * ## 一条**没有**在这里验的，以及为什么
 *
 * 针尖安全包络（D-TIP-1）装在 `validateParams`，也就是**内核 K6** —— 而这台夹具
 * 不过内核（同 `scan-composites.test.ts` 的抬头：内核的闸门在 `runsub.test.ts` /
 * `skill-kernel.test.ts` 里单独验）。包络的 264 格在
 * `kernel/src/tip-conditioning.test.ts`，技能这一层在 `l0/tail-l0-tip.test.ts`。
 * **这里验的是仪器那一侧。**
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  processTipRegistry,
  setCurrentTip,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  setCurrentTip(null)
  processTipRegistry.overrides = {}
  for (const fn of cleanup.splice(0)) fn()
})

/**
 * **整组集成测试共用一台仪器，而仪器有状态**（批 4d §6.2 那一课）。
 *
 * 这一组会改**偏压**（为了证明「跟随此刻的成像偏压」得先把它设成一个不常见的值），
 * 所以存档 / 还原。同 `scan-composites.test.ts`：「这个状态是不是我改的」是判据。
 *
 * ⚠️ **还有一样还不回去**：`TipShape` 真的会往表面扎一下，而 stmsim 会在那儿留下
 * 一个团簇或坑（`world.tip_shaper_start` → `surface.add_feature`）。表面记忆没有撤销
 * 接口 —— 这与「跑过一次真扫描之后 `_grab` 换了一条路」是同一类**不可还原**的改变。
 * 写在这里而不是假装没有：下一个在这台模拟器上加只读测试的人需要知道。
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

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

class Rig {
  readonly calls: { verb: string; args: unknown[] }[] = []
  readonly subs: string[] = []
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
    const ctx = {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.subs.push(name)
        const skill = IMPLEMENTED[name]
        if (skill === undefined) return Promise.resolve({ success: false, error: `注册表里没有 ${name}` })
        return skill.execute(ctx, params)
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'integration',
      rootCallId: 'tip',
      approvalSource: 'operator',
    } as unknown as SkillContext
    return ctx
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

/** 短一点的四段：默认那组加起来近一秒，真等没必要。 */
const FAST = {
  switch_off_delay_s: 0.02,
  lift_time_1_s: 0.02,
  bias_settling_s: 0.02,
  lift_time_2_s: 0.02,
  end_wait_s: 0.02,
}

describe('TipShape 对真 stmsim', () => {
  it('11 个参数**读回来逐位对得上** —— 顺序错一位这一格就红', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    const r = await IMPLEMENTED['TipShape']!.execute(ctx, {
      ...FAST,
      bias_v: 0.3,
      change_bias: true,
      tip_lift_m: -1.5e-9,
      bias_lift_v: 0.25,
      lift_height_m: 2.5e-9,
      restore_feedback: false,
    })
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)

    // **读回来的是模拟器自己存的那一份**，不是我们写下去的那个数组。
    const back = await ctx.safeCall('TipShaper_PropsGet')
    const v = (back.values ?? []) as number[]
    expect(v).toHaveLength(11)
    const close = (got: number, want: number): void => {
      // float32 往返（同 `readback.test.ts` 那条）：比相对误差，不比精确相等。
      expect(Math.abs(want === 0 ? got : got / want - 1)).toBeLessThan(1e-6)
    }
    close(v[0]!, 0.02) // switch_off_delay
    expect(v[1]).toBe(1) // change_bias = True
    close(v[2]!, 0.3) // bias_v
    close(v[3]!, -1.5e-9) // tip_lift_m
    close(v[4]!, 0.02) // lift_time_1
    close(v[5]!, 0.25) // bias_lift_v
    close(v[6]!, 0.02) // bias_settling
    close(v[7]!, 2.5e-9) // lift_height_m
    close(v[8]!, 0.02) // lift_time_2
    close(v[9]!, 0.02) // end_wait
    expect(v[10]).toBe(2) // restore_feedback = False
  }, 60_000)

  it('`bias_v` 留空 ⇒ 跟随**仪器上此刻的**成像偏压（不是写死的 3 V）', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    // 先把成像偏压设成一个不常见的值，再让 TipShape 自己去读。
    await ctx.safeCall('Bias_Set', 0.037)
    const r = await IMPLEMENTED['TipShape']!.execute(ctx, { ...FAST, tip_lift_m: -1e-9 })
    expect(r.success).toBe(true)
    const d = r.data as { bias_v: number; bias_v_source: string; bias_lift_v: number }
    expect(d.bias_v_source).toBe('read')
    expect(Math.abs(d.bias_v / 0.037 - 1)).toBeLessThan(1e-6)
    // `bias_lift_v` 省略 ⇒ 跟随 `bias_v`：**它是无条件施加的那一个**。
    expect(d.bias_lift_v).toBe(d.bias_v)
    // 读偏压那一步真的发生过（不是从某个缓存里拿的）
    expect(rig.calls.map((c) => c.verb)).toContain('Bias_Get')
  }, 60_000)

  it('登记一支钨腐蚀针 ⇒ 下到线上的是方案表的 4 V，**一次 `Bias_Get` 都不发**', async () => {
    setCurrentTip({ name: '钨腐蚀针', material: '钨', fabrication: '电化学腐蚀', form: 'stm_wire' })
    const rig = await instrument()
    const ctx = rig.ctx()
    const r = await IMPLEMENTED['TipShape']!.execute(ctx, { ...FAST, tip_lift_m: -1e-9 })
    expect(r.success).toBe(true)
    expect((r.data as { bias_v_source: string }).bias_v_source).toBe('policy')
    expect(rig.calls.map((c) => c.verb)).not.toContain('Bias_Get')
    const back = await ctx.safeCall('TipShaper_PropsGet')
    expect(Math.abs(((back.values ?? []) as number[])[2]! / 4.0 - 1)).toBeLessThan(1e-6)
  }, 60_000)
})

describe('TipPulse 对真 stmsim', () => {
  it('计划是「快照 + N 发」，每一发都是真的 `Bias_Pulse`，而偏压被硬件放回去了', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('Bias_Set', 0.05)
    const r = await IMPLEMENTED['TipPulse']!.execute(ctx, { count: 2, duration_s: 0.02, pulse_v: 1.0 })
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    expect(rig.subs).toEqual(['GetBias', 'BiasPulse', 'BiasPulse'])
    const d = r.data as { original_bias_v: number; pulse_v: number; count: number }
    // 快照读到的是**仪器上真的那个值**
    expect(Math.abs(d.original_bias_v / 0.05 - 1)).toBeLessThan(1e-6)
    expect(d.pulse_v).toBe(1.0)
    expect(d.count).toBe(2)
    // 打完两发之后偏压回到脉冲之前（`Bias_Pulse` 由硬件计时并自己恢复）
    const now = await ctx.safeCall('Bias_Get')
    expect(Math.abs(((now.values ?? []) as number[])[0]! / 0.05 - 1)).toBeLessThan(1e-6)
  }, 60_000)

  it('没给 `pulse_v` ⇒ 方案表按当前针尖填，**下到线上的就是那个数**', async () => {
    setCurrentTip({ name: '铂铱针', material: 'PtIr', fabrication: 'cut', form: 'stm_wire' })
    const rig = await instrument()
    const ctx = rig.ctx()
    const r = await IMPLEMENTED['TipPulse']!.execute(ctx, { duration_s: 0.02 })
    expect(r.success).toBe(true)
    // 铂铱那一档是 3.0 V（钨是 5.0）——同一次调用，不同的针，不同的电压。
    expect((r.data as { pulse_v: number }).pulse_v).toBe(3.0)
    expect((r.data as { tip_name: string }).tip_name).toBe('铂铱针')
  }, 60_000)
})
