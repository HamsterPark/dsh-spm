/**
 * 批 5a 的技能层：**金样驱动不到的那些格**。
 *
 * 通用轨迹金样（`export_skill_traces.py`）直调 `execute`，于是：
 *
 * * **`validateParams` 一格都没录** —— 而 D-TIP-1 那道闸就装在那里；
 * * 它那台假仪器里**没有针尖登记表**（holder 是进程级的，导出器不碰它），
 *   于是每一格都是「未登记 ⇒ 通用档」，按针尖分档那一半一条都走不到。
 *
 * 判据本体的逐格验收在 `kernel/src/tip-conditioning.test.ts`（264 格对旧仓）；
 * 这里验的是**技能这一层**：闸装在哪一层、拒绝之后有没有真的什么都不发、
 * 方案表填进去的值有没有下到线上、以及每一条错误分支的文案。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  processTipRegistry,
  setCurrentTip,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { TipShape } from './tip-shape.js'
import { TipPulse } from '../composite/tip-pulse.js'
import { BiasPulseWithReadback, TipShapeWithReadback } from './readback-skills.js'
import {
  CONDITIONING_REQUIRED_SKILLS,
  FORGE_REQUIRED_SKILLS,
  makeTipConditioningSelfCheck,
  makeTipForgeSelfCheck,
} from './tip-selfcheck.js'

interface RigOptions {
  bias?: number | 'error' | 'unreadable'
  fail?: Set<string>
  /** 子技能的应答：名字 → 结果。缺省成功、空 data。 */
  sub?: (name: string, params: Record<string, unknown>) => SkillResultLike
}

function rig(opts: RigOptions = {}): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
  runs: { skill: string; params: Record<string, unknown> }[]
} {
  const calls: { verb: string; args: unknown[] }[] = []
  const runs: { skill: string; params: Record<string, unknown> }[] = []
  let clock = 1_000_000
  const safeCall = (m: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    calls.push({ verb: m, args })
    clock += 1
    if (opts.fail?.has(m) === true) {
      return Promise.resolve({ method: m, args, error: '模拟故障：连接被对端关闭' })
    }
    if (m === 'Bias_Get') {
      if (opts.bias === 'error') return Promise.resolve({ method: m, args, error: 'NanonisError: 没有这条命令' })
      if (opts.bias === 'unreadable') return Promise.resolve({ method: m, args, values: [] })
      return Promise.resolve({ method: m, args, values: [opts.bias ?? 0.02] })
    }
    if (m === 'FolMe_XYPosGet') return Promise.resolve({ method: m, args, values: [1e-9, 2e-9] })
    return Promise.resolve({ method: m, args, values: [0] })
  }
  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    now: () => (clock += 1),
    sleep: () => Promise.resolve(),
    runSkill: (name: string, params: Record<string, unknown>) => {
      runs.push({ skill: name, params })
      return Promise.resolve(opts.sub?.(name, params) ?? { success: true, data: {} })
    },
    markers: { emit: () => {} },
  } as unknown as SkillContext
  return { ctx, calls, runs }
}

const QPLUS = { name: 'W-qPlus', material: 'W', fabrication: 'etched', form: 'qplus' }
const W_ETCHED = { name: '钨腐蚀针', material: 'W', fabrication: 'etched', form: 'stm_wire' }

afterEach(() => {
  setCurrentTip(null)
  processTipRegistry.overrides = {}
})

// ── TipShape ────────────────────────────────────────────────────────────────

describe('TipShape', () => {
  it('成功：`bias_v` 缺省 = 此刻的成像偏压，两个偏压都下到线上', async () => {
    const { ctx, calls } = rig({ bias: 0.02 })
    const r = await TipShape.execute(ctx, { tip_lift_m: -2e-9 })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({
      bias_v: 0.02, bias_v_source: 'read', bias_lift_v: 0.02,
      change_bias: false, lift_height_m: 2e-9, completed: true,
    })
    const props = calls.find((c) => c.verb === 'TipShaper_PropsSet')!
    // (switch_off, change_bias=2, bias, tip_lift, t1, bias_lift, settle, lift_height, t2, end_wait, restore=1)
    expect(props.args).toEqual([0.1, 2, 0.02, -2e-9, 0.1, 0.02, 0.1, 2e-9, 0.1, 0.1, 1])
    expect(calls.map((c) => c.verb)).toEqual([
      'Bias_Get', 'FolMe_XYPosGet', 'TipShaper_PropsSet', 'TipShaper_Start',
    ])
  })

  it('登记一支钨针 ⇒ `bias_v` 由方案表给（4.0 V），来源是 `policy`，**不读偏压**', async () => {
    setCurrentTip(W_ETCHED)
    const { ctx, calls } = rig()
    const r = await TipShape.execute(ctx, {})
    expect(r.data).toMatchObject({ bias_v: 4.0, bias_v_source: 'policy', tip_registered: true, tip_name: '钨腐蚀针' })
    expect(calls.map((c) => c.verb)).not.toContain('Bias_Get')
    expect(r.data?.['tip_policy']).toBe('shaper_bias_v=4.0（针尖方案表）')
  })

  it('显式给的 `bias_v` 胜过方案表，来源是 `explicit`', async () => {
    setCurrentTip(W_ETCHED)
    const { ctx } = rig()
    const r = await TipShape.execute(ctx, { bias_v: 1.5 })
    expect(r.data).toMatchObject({ bias_v: 1.5, bias_v_source: 'explicit' })
  })

  it('**超包络拒绝、不夹紧**：覆写收紧到 ±1 V 之后，2 V 被拒且一次调用都不发', async () => {
    processTipRegistry.overrides = { max_abs_pulse_v: 1.0 }
    const { ctx, calls } = rig()
    const r = await TipShape.execute(ctx, { bias_v: 2.0 })
    expect(r.success).toBe(false)
    expect(r.error).toContain('超出未登记针尖的通用档的安全上限 ±1 V')
    expect(r.error).toContain('拒绝而不是夹到上限')
    expect(calls).toEqual([]) // 闸在任何硬件动作之前
  })

  it('读不到偏压 ⇒ 拒绝，**不回落到 3 V**（报错那一支）', async () => {
    const { ctx, calls } = rig({ bias: 'error' })
    const r = await TipShape.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe(
      '读不到当前偏压(Bias_Get 报错:NanonisError: 没有这条命令),' +
        '而 bias_v 既没有显式给出、方案表也没有 —— 拒绝用写死的 3 V 代替。',
    )
    expect(calls.map((c) => c.verb)).toEqual(['Bias_Get'])
  })

  it('读不到偏压 ⇒ 拒绝（回包读不懂那一支，D-SKILL-2）', async () => {
    const { ctx } = rig({ bias: 'unreadable' })
    const r = await TipShape.execute(ctx, {})
    expect(r.error).toBe(
      '读不到当前偏压(Bias_Get 回包读不懂(values=[])),' +
        '而 bias_v 既没有显式给出、方案表也没有 —— 拒绝用写死的 3 V 代替。',
    )
  })

  it('`TipShaper_PropsSet` 报错 ⇒ 原样透传，不再发 Start', async () => {
    const { ctx, calls } = rig({ fail: new Set(['TipShaper_PropsSet']) })
    const r = await TipShape.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe('模拟故障：连接被对端关闭')
    expect(calls.map((c) => c.verb)).not.toContain('TipShaper_Start')
  })

  it('`TipShaper_Start` 报错 ⇒ 原样透传', async () => {
    const { ctx } = rig({ fail: new Set(['TipShaper_Start']) })
    const r = await TipShape.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe('模拟故障：连接被对端关闭')
  })

  it('`lift_height_m` 显式给 `0` 仍然是 0 —— 「不抬」是合法意图（D-ZERO-1）', async () => {
    const { ctx, calls } = rig()
    const r = await TipShape.execute(ctx, { tip_lift_m: -2e-9, lift_height_m: 0 })
    expect(r.data?.['lift_height_m']).toBe(0)
    expect((calls.find((c) => c.verb === 'TipShaper_PropsSet')!.args as number[])[7]).toBe(0)
  })

  it('`change_bias=false` **不等于不加电**：`bias_lift_v` 照样下发', async () => {
    const { ctx, calls } = rig({ bias: 0.02 })
    await TipShape.execute(ctx, { change_bias: false, bias_lift_v: 3.0 })
    const props = calls.find((c) => c.verb === 'TipShaper_PropsSet')!
    expect((props.args as number[])[1]).toBe(2) // change_bias = 2 (False)
    expect((props.args as number[])[5]).toBe(3.0) // bias_lift 照样是 3 V
  })

  it('读不到针尖位置 ⇒ **什么都不报**（缺键就是读不到）', async () => {
    const { ctx } = rig({ fail: new Set(['FolMe_XYPosGet']) })
    const r = await TipShape.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).not.toHaveProperty('x_m')
  })
})

// ── TipPulse ────────────────────────────────────────────────────────────────

describe('TipPulse', () => {
  it('成功：方案表填参数，计划是「快照 + N 发」', async () => {
    const { ctx, runs } = rig({
      sub: (name) => (name === 'GetBias' ? { success: true, data: { bias_v: 0.05 } } : { success: true, data: {} }),
    })
    const r = await TipPulse.execute(ctx, { count: 2 })
    expect(r.success).toBe(true)
    expect(runs.map((x) => x.skill)).toEqual(['GetBias', 'BiasPulse', 'BiasPulse'])
    expect(runs[1]!.params).toEqual({ width_s: 0.1, bias_v: 3.0, z_hold: 1, absolute: true })
    expect(r.data).toMatchObject({ pulse_v: 3.0, duration_s: 0.1, count: 2, original_bias_v: 0.05 })
    expect(r.data?.['tip_policy']).toBe(
      'pulse_count=2（调用方指定）；pulse_duration_s=0.1（通用默认）；pulse_v=3.0（通用默认）',
    )
  })

  it('登记一支钨腐蚀针 ⇒ 打的是 5 V 而不是 3 V（同一个调用，不同的针）', async () => {
    setCurrentTip(W_ETCHED)
    const { ctx, runs } = rig()
    await TipPulse.execute(ctx, {})
    expect(runs[1]!.params).toMatchObject({ bias_v: 5.0 })
  })

  it('`validateParams`：6 发超出通用档的 5 发上限（**K6，硬件之前**）', () => {
    expect(TipPulse.validateParams?.({ count: 6 })).toEqual([
      'pulse_count=6 超出未登记针尖的通用档的上限 5 发。拒绝执行。',
    ])
  })

  it('`validateParams`：qPlus 上 3 发就超（声明上限是 50 —— K6 的范围检查放行它）', () => {
    setCurrentTip(QPLUS)
    expect(TipPulse.validateParams?.({ count: 3 })).toEqual([
      'pulse_count=3 超出当前针尖（W-qPlus）的上限 2 发。拒绝执行。',
    ])
    expect(TipPulse.validateParams?.({ count: 2 })).toEqual([])
  })

  it('`validateParams` **不看时长** —— 方案表对它没有上限（与旧仓逐字相同）', () => {
    expect(TipPulse.validateParams?.({ duration_s: 999 })).toEqual([])
  })

  it('**出厂默认落在自己包络之外**那一条：没给任何参数也会被拒', async () => {
    // 旧仓真出过这个形状：`NobleTipWorkflow.pulse_v` 出厂 10 V > 通用档当时的 6 V
    // ⇒ 没有登记针尖时，大修相一发脉冲都打不出去。这里用覆写把包络收到 2 V 复现它。
    processTipRegistry.overrides = { max_abs_pulse_v: 2.0 }
    const { ctx, runs } = rig()
    const r = await TipPulse.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('pulse_v=3 V 超出未登记针尖的通用档的安全上限 ±2 V')
    expect(runs).toEqual([]) // 一个子技能都没排
  })

  it('子技能失败 ⇒ 中止，报文带着那一步的原因，而参数痕迹照样在', async () => {
    const { ctx } = rig({
      sub: (name) => (name === 'BiasPulse' ? { success: false, error: '模拟故障' } : { success: true, data: {} }),
    })
    const r = await TipPulse.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe('BiasPulse failed: 模拟故障')
    expect(r.data).toMatchObject({ pulse_v: 3.0, tip_registered: false })
  })

  it('`GetBias` 没给出偏压 ⇒ `original_bias_v` 是 null，不是 0', async () => {
    const { ctx } = rig()
    const r = await TipPulse.execute(ctx, {})
    expect(r.data?.['original_bias_v']).toBeNull()
  })
})

// ── 两个读回技能：D-TIP-1 的闸真的接上了 ────────────────────────────────────

describe('D-TIP-1 · 两个读回技能的 `validateParams`', () => {
  it('BiasPulseWithReadback：`bias_v` 按方案表的 `pulse_v` 判', () => {
    processTipRegistry.overrides = { max_abs_pulse_v: 3.0 }
    expect(BiasPulseWithReadback.validateParams?.({ bias_v: 8.0 })).toEqual([
      'pulse_v=8 V 超出未登记针尖的通用档的安全上限 ±3 V。拒绝而不是夹到上限——' +
        '夹了你会以为自己用的是原来那个值。确需更大幅度请先确认针尖类型登记正确，' +
        '或在设置里调整该针尖的方案上限。',
    ])
    expect(BiasPulseWithReadback.validateParams?.({ bias_v: 3.0 })).toEqual([])
  })

  it('TipShapeWithReadback：**本仓新增** —— 与孪生兄弟 TipShape 同一条判据', () => {
    setCurrentTip(QPLUS)
    processTipRegistry.overrides = { max_abs_pulse_v: 0.5 }
    const errs = TipShapeWithReadback.validateParams?.({ bias_v: 1.0, bias_lift_v: -2.0 }) ?? []
    expect(errs).toHaveLength(2)
    expect(errs[0]).toContain('shaper_bias_v=1 V 超出当前针尖（W-qPlus）的安全上限 ±0.5 V')
    // qPlus 那一句**多说一件事**：音叉坏了要拆机
    expect(errs[0]).toContain('qPlus 石英音叉损坏不可逆')
    expect(errs[1]).toContain('shaper_lift_v=-2 V')
  })

  it('没给那两个偏压 ⇒ 没有可判的东西，不拦（方案表 qPlus 档不填 shaper 偏压）', () => {
    setCurrentTip(QPLUS)
    expect(TipShapeWithReadback.validateParams?.({})).toEqual([])
  })
})

// ── 两个自检：那句「✅ 可以开工」 ───────────────────────────────────────────

const ALL_INSTALLED = (): Promise<readonly string[]> =>
  Promise.resolve([...CONDITIONING_REQUIRED_SKILLS, ...FORGE_REQUIRED_SKILLS])

describe('TipConditioningSelfCheck', () => {
  it('依赖缺席 ⇒ **进 blockers，不是 warnings**（这一批改的就是这个）', async () => {
    const { ctx } = rig()
    const r = await makeTipConditioningSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    const data = r.data as { ready: boolean; blockers: string[]; warnings: string[] }
    expect(data.ready).toBe(false)
    expect(r.summary).toContain('❌ 还不能开工')
    expect(data.warnings).toEqual([]) // 旧仓这两条会落进这里，于是 ready 为真
    expect(data.blockers.some((b) => b.startsWith('扫描地图可读: '))).toBe(true)
    expect(data.blockers.some((b) => b.startsWith('Z 噪声底: '))).toBe(true)
  })

  it('登记针尖之后，「针尖已登记」这一项**真的会绿**，并印出 qPlus 的登记常数', async () => {
    setCurrentTip({ ...QPLUS, qplus_k_n_per_m: 1800, qplus_q: 25000, qplus_f0_hz: 32768 })
    const { ctx } = rig()
    const r = await makeTipConditioningSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    const checks = (r.data as { checks: { check: string; ok: boolean | null; detail: string }[] }).checks
    const tip = checks.find((c) => c.check === '针尖已登记')!
    expect(tip.ok).toBe(true)
    expect(tip.detail).toBe('W-qPlus（W/qplus），登记常数 k=1800 N/m、Q=25000、f0=32768 Hz')
    // 10 V 大修脉冲在 qPlus 档的包络内（2026-08-10 现场把它定到 10 V）
    expect(checks.find((c) => c.check === '10 V 脉冲在包络内')?.ok).toBe(true)
  })

  it('覆写把 qPlus 收回 3 V ⇒ 那一发大修脉冲当场被这个自检照出来', async () => {
    setCurrentTip(QPLUS)
    processTipRegistry.overrides = { max_abs_pulse_v: 3.0 }
    const { ctx } = rig()
    const r = await makeTipConditioningSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    const checks = (r.data as { checks: { check: string; ok: boolean | null }[] }).checks
    expect(checks.find((c) => c.check === '10 V 脉冲在包络内')?.ok).toBe(false)
  })

  it('Tip Shaper 读不到 ⇒ blocking', async () => {
    const { ctx } = rig({ fail: new Set(['TipShaper_PropsGet']) })
    const r = await makeTipConditioningSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    const data = r.data as { blockers: string[] }
    expect(data.blockers.some((b) => b.startsWith('Tip Shaper 模块: 读不到'))).toBe(true)
  })

  it('没接 `installed` ⇒ 去问 `IMPLEMENTED`，报的是**本仓还缺哪几个**', async () => {
    const { ctx } = rig()
    const r = await makeTipConditioningSelfCheck().execute(ctx, {})
    const data = r.data as { missing_skills: string[] }
    expect(data.missing_skills).toContain('PrepareNobleTip')
    expect(data.missing_skills).not.toContain('GetBias') // 这个早就移了
  })
})

describe('TipForgeSelfCheck', () => {
  it('**旧仓在这里说「✅ 可以开工」；本仓说不能**', async () => {
    const { ctx } = rig()
    const r = await makeTipForgeSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    const data = r.data as { ready: boolean; blockers: string[] }
    expect(data.ready).toBe(false)
    expect(data.blockers.some((b) => b.startsWith('衬底可解析: '))).toBe(true)
    expect(data.blockers.some((b) => b.startsWith('表面态判据自测: '))).toBe(true)
  })

  it('原子相判据**真的跑了一遍**：合成晶格通过、噪声被拒', async () => {
    const { ctx } = rig()
    const r = await makeTipForgeSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    const checks = (r.data as { checks: { check: string; ok: boolean | null; detail: string }[] }).checks
    const dry = checks.find((c) => c.check === '原子相判据自测')!
    expect(dry.ok).toBe(true)
    expect(dry.detail).toBe('合成晶格通过、纯噪声被拒')
  })

  it('扎针深度包络**真的判了** —— 这个自检存在的全部理由', async () => {
    const { ctx } = rig()
    const ok = await makeTipForgeSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    expect(
      (ok.data as { checks: { check: string; ok: boolean | null }[] }).checks
        .find((c) => c.check === '0.3 nm 浅扎在包络内')?.ok,
    ).toBe(true)

    // 把深度包络收到 0.1 nm ⇒ 同一次自检当场变红（旧仓这一项会落进 `except → None`）
    processTipRegistry.overrides = { max_poke_depth_m: 1e-10 }
    const bad = await makeTipForgeSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, {})
    const item = (bad.data as { checks: { check: string; ok: boolean | null; detail: string }[] }).checks
      .find((c) => c.check === '0.3 nm 浅扎在包络内')!
    expect(item.ok).toBe(false)
    expect(item.detail).toContain('下压深度超出未登记针尖的通用档的上限 1.000e-10 m')
  })

  it('`substrate` 原样带回报文（留空就是空串）', async () => {
    const { ctx } = rig()
    const r = await makeTipForgeSelfCheck({ installed: ALL_INSTALLED }).execute(ctx, { substrate: 'Au(111)' })
    expect((r.data as { substrate: string }).substrate).toBe('Au(111)')
  })
})
