/**
 * 批 7b-2 对**真 stmsim**（DoD ④）—— 只验「自己造的回包证不了」的那几件。
 *
 * 八个技能里四个有 e2e，四个没有，逐条说理由：
 *
 * | 技能 | 有没有 | 为什么 |
 * |---|---|---|
 * | `AcquireSignalPoint` | ✅ | `nanonisScalar` 的先序遍历是照**我理解的**回包形状写的。真机上 `Signals_ValGet(i, 0)` 的 body 到底长什么样，只有真东西答得了 |
 * | `MeasureBarrierHeight` | ✅ | 整条链压在**一个键名**上：`AcquireSTS` 的 `data['Current (A)']`。它不在，`_read_at` 就恒回 `null`，整个技能安静地退化成 `undetermined` —— 而单测与金样里那个键是**我摆的** |
 * | `AcquireDeltaFCurve` | ✅ | `ZSpectr_ChsSet` 收的是**一个列表实参**、`ZSpectr_PropsSet` 收六个 —— 编码对不对只有发出去才知道；顺带 `PLL_OutOnOffGet` 的 1/0 极性 |
 * | `RunGridExperiment` | ◐ | **模拟器没有 Pattern 模块**（`stmsim/` 里 `Pattern_` 零命中）。所以这一条验的是**编码**：九个混合类型的实参真的打得出去、而且失败被如实报成失败 —— 不是那条状态判据 |
 * | `MapBarrierHeight` / `CleanTipUntilBarrier` | ❌ | 它们一次裸动词都不发，全是 `ctx.runSkill`；而被调的那个（`MeasureBarrierHeight`）在这里已经跑过真链路了 |
 * | `AcquireBiasSeries` / `CalibrateCoarseStep` | ❌ | 它们压在 `ScanAt` 上，而 `ScanAt` 在模拟器上是一次真扫描（几十秒）。**而且它们今天的行为由「`ScanAt` 不返回路径」决定** —— 那条由 `l0/batch7b2-skills.test.ts` 直接量着 `ScanAt` 的回包键 |
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`）。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  slowCallFrom,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'
import { parseDeltaF } from '../src/l0/deltaf-curve.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

interface Rig {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
}

function instrument(timeoutMs = 20_000): Promise<Rig> {
  const c = new Context()
  cleanup.push(() => void c.registry.delete(stmsimProvider))
  c.plugin(SystemPrompt, {})
  c.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    c.inject(['instrument'], (got) => {
      clearTimeout(timer)
      const inst = got.instrument as { call: SafeCallish }
      const calls: { verb: string; args: unknown[] }[] = []
      const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
        calls.push({ verb: m, args: a })
        return inst.call(m, a)
      }
      const S0 = emptyHardwareState('stmsim')
      const ctx: SkillContext = {
        signal: new AbortController().signal,
        safeCall,
        emergencyCall: safeCall,
        slowCall: slowCallFrom(safeCall, (m, _t, ...a) => safeCall(m, ...a)),
        // **子技能真的再走一遍同一条链路** —— `MeasureBarrierHeight` 的价值
        // 全在这里：它底下那几个（ConfigureSTS* / AcquireSTS）打的是真 TCP。
        runSkill: (name: string, params: Readonly<Record<string, unknown>>) => {
          const sub = IMPLEMENTED[name]
          if (sub === undefined) {
            return Promise.resolve({ success: false, error: `没有这个技能: ${name}` })
          }
          return sub.execute(ctx, params)
        },
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        state: () => S0,
        refreshState: () => Promise.resolve(S0),
        markers: { emit: () => {} },
        depth: 0,
        owner: 'integration',
        rootCallId: 'batch7b2',
        approvalSource: 'human',
      }
      resolve({ ctx, calls })
    })
  })
}

describe('批 7b-2 对真 stmsim', () => {
  it('AcquireSignalPoint：真回包里那个数找得到，而且 std 是真的抖动', async () => {
    const { ctx, calls } = await instrument()
    const r = await IMPLEMENTED['AcquireSignalPoint']!.execute(ctx, {
      samples: 5,
      signal_indices: '0,14',
      sample_interval_s: 0.002,
    })
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    const d = r.data as Record<string, number>
    // **不是 null、不是 NaN** —— 那正是「回包形状我猜错了」会长出来的样子。
    for (const k of ['current_a', 'current_std', 'sig0_mean', 'sig0_std', 'sig14_mean', 'sig14_std']) {
      expect(Number.isFinite(d[k]), `${k} = ${String(d[k])}`).toBe(true)
    }
    expect(d['n_samples']).toBe(5)
    // 5 次采样 × 3 路 = 15 次调用，顺序是 Current, sig0, sig14 轮着来。
    expect(calls.map((c) => c.verb)).toEqual(
      Array.from({ length: 5 }, () => ['Current_Get', 'Signals_ValGet', 'Signals_ValGet']).flat(),
    )
    expect(calls[1]?.args).toEqual([0, 0])
    expect(calls[2]?.args).toEqual([14, 0])
  }, 60_000)

  it('MeasureBarrierHeight：`AcquireSTS` 在真机上**真的**给出 `Current (A)` 这个键', async () => {
    const { ctx } = await instrument()
    // 先单独跑一次子技能链，把那个键名钉死 —— 整条势垒链压在它上面。
    await IMPLEMENTED['ConfigureSTS']!.execute(ctx, {
      start_v: 0.04, end_v: 0.06, num_points: 8, z_offset_m: 0.0,
    })
    const sts = await IMPLEMENTED['AcquireSTS']!.execute(ctx, { save_basename: '' })
    const sd = (sts.data ?? {}) as Record<string, unknown>
    expect(sd['spectrum_parsed'], `AcquireSTS 没解出谱：${String(sts.error ?? '')}`).toBe(true)
    // ⭐ 这一行就是这条 e2e 的全部理由。
    expect(Array.isArray(sd['Current (A)']), `通道名是 ${JSON.stringify(sd['channel_names'])}`).toBe(true)
  }, 120_000)

  it('MeasureBarrierHeight：整条链在真仪器上跑得完，而且给的是一个判读而不是一句「判不了」', async () => {
    const { ctx } = await instrument()
    // ⚠️ **用缺省的六档，不要收成四档。** 自动噪声底是「最远两档均值×2」，
    // 于是它**总是**把最后两档吃掉；四档进来只剩 2 个可用点，而拟合要 3 个 ——
    // 第一版就是这么红的（真机 I(0)=80 pA → I(0.3)=0.088 pA，一条很干净的指数，
    // 只是点不够）。缺省那六档前密后疏，正是为这件事设计的。
    const r = await IMPLEMENTED['MeasureBarrierHeight']!.execute(ctx, {
      bias_v: 0.05,
      points_per_step: 5,
    })
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    const d = r.data as Record<string, unknown>
    // 方向确认这一步在真机上必须过 —— 退开 0.1 nm 电流要真的掉下去。
    // **它是整条链的第一道闸**，而夹具里那个比值是我摆的。
    const dir = d['direction_check'] as Record<string, unknown>
    expect(typeof dir['base_pa']).toBe('number')
    expect(typeof dir['ratio']).toBe('number')
    expect(d['verdict'], JSON.stringify(d)).not.toBe('undetermined')
    expect(typeof d['phi_ev']).toBe('number')
    // κ 与 φ 的关系是一个恒等式，真机上也得成立。
    const phi = d['phi_ev'] as number
    const kappa = d['kappa_per_nm'] as number
    expect(Math.abs((kappa / 5.123) ** 2 / phi - 1)).toBeLessThan(1e-12)
  }, 180_000)

  /**
   * ⚠️ **这台模拟器跑的是 `polar-spm`，它没有 PLL 模块**
   * （globalSetup 里的 `profile: 'polar-spm'`，而 PLL 要 `polar-spm-qplus`）。
   * 换 profile 是改**整组**集成测试共用的那一份 globalSetup —— 不在这一批动。
   *
   * 于是这个技能在真仪器上走到的是**第一道闸**，而那一格正好是它最要紧的一条：
   * 「读不到 PLL 状态就别采」。下面第二条把 ZSpectr 那一串**单独**打出去，
   * 于是编码那一半照样有真东西验过。
   */
  it('AcquireDeltaFCurve：PLL 模块不在 ⇒ 第一句就停，**一条 ZSpectr 都不发**', async () => {
    const { ctx, calls } = await instrument()
    const r = await IMPLEMENTED['AcquireDeltaFCurve']!.execute(ctx, {
      z_sweep_distance_m: 2e-10,
      num_points: 16,
      channel_indexes: '17,0,16',
    })
    expect(r.success).toBe(false)
    expect(r.error ?? '').toContain('读不到 PLL 输出状态')
    // `NeedModule` 那个子串在真文案里 —— 同 `lockin.test.ts` 那一条。
    expect(r.error ?? '').toContain('NeedModule')
    // **不采一条噪声**：问完就停，一次 `ZSpectr_*` 都没发。
    expect(calls.map((c) => c.verb)).toEqual(['PLL_OutOnOffGet'])
  }, 60_000)

  it('AcquireDeltaFCurve：ZSpectr 那一串真的编得出去，`parseDeltaF` 认得真回包', async () => {
    const { ctx } = await instrument()
    await ctx.safeCall('ZSpectr_Open')
    // ⭐ `ZSpectr_ChsSet` 收的是**一个列表实参**，不是三个整数 —— 编错了发不出去。
    const chs = await ctx.safeCall('ZSpectr_ChsSet', [17, 0, 16])
    expect(chs.error ?? '').toBe('')
    const range = await ctx.safeCall('ZSpectr_RangeSet', 0.0, 2e-10)
    expect(range.error ?? '').toBe('')
    // 六个实参，`bwd=1` = 也采回程 —— 回程那一列正是 `parseDeltaF` 要整列跳过的。
    const props = await ctx.safeCall('ZSpectr_PropsSet', 1, 16, 1, 1, 2, 1)
    expect(props.error ?? '').toBe('')
    const rec = await ctx.safeCall('ZSpectr_Start', 1, '')
    expect(rec.error ?? '').toBe('')

    // ⭐ 把**真回包**喂给真的那个解析器（不是我造的块）。
    const data: Record<string, unknown> = {}
    expect(parseDeltaF(rec, data)).toBe(true)
    const names = data['channel_names'] as string[]
    expect(names.length).toBeGreaterThan(1)
    expect(Array.isArray(data['z_rel'])).toBe(true)
    expect(Array.isArray(data['freq_shift_hz'])).toBe(true)
    expect(typeof data['df_min_hz']).toBe('number')
    // 回程那一列在真回包里**确实存在**，而 `freq_shift_hz` 取的是正程那一条：
    // 两者若被混到一起，`df_min_hz` 会取到两条里的最小值。
    expect(names.some((n) => n.includes('[bwd]')), JSON.stringify(names)).toBe(true)
    const fwd = data['freq_shift_hz'] as number[]
    expect(fwd.length).toBe(data['num_points'])
  }, 120_000)

  it('RunGridExperiment：九个实参编得出去；模拟器没有 Pattern 模块 ⇒ **如实报失败**', async () => {
    const { ctx, calls } = await instrument()
    const r = await IMPLEMENTED['RunGridExperiment']!.execute(ctx, {
      nx: 2, ny: 3,
      center_x_m: 1e-8, center_y_m: -2e-8,
      width_m: 4e-8, height_m: 3e-8, angle_deg: 30.0,
      wait_timeout_s: 10.0,
    })
    // `Pattern_GridSet(1, nx, ny, 0, cx, cy, w, h, angle)` —— 第 4 个实参**必须是 0**，
    // 给 1 时 Nanonis 按当前扫描框定网格并静默丢掉用户的几何。
    const set = calls.find((c) => c.verb === 'Pattern_GridSet')
    expect(set?.args).toEqual([1, 2, 3, 0, 1e-8, -2e-8, 4e-8, 3e-8, 30.0])
    // 模拟器不认这个动词 ⇒ 这一趟必须**失败**，而且说得出是哪一步。
    expect(r.success).toBe(false)
    expect(r.error ?? '').toContain('Pattern_GridSet failed')
    // 失败之后**不许继续往下开实验**。
    expect(calls.filter((c) => c.verb === 'Pattern_ExpStart')).toEqual([])
  }, 60_000)
})
