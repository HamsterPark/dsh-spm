/**
 * 批 3i 里**通用金样驱动不到**的格子。
 *
 * 这一批的金样只走到了两条路：合成信号表里没有振幅通道（`unavailable`），
 * 以及压电那边读不到（`unknown`）。也就是说**真正要紧的那几条判据一格都没录到**：
 * 有 qPlus 的机器、激励开着、基线取过 —— 那才是这条撞针判据存在的场合。
 *
 * 所以这里摆一台**有 qPlus 的机器**。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { CheckTipCrashByAmplitude, ReadTipOscillationAmplitude, processQPlusBaseline } from './qplus.js'
import { makeCheckPiezoRange } from './piezo-check.js'
import { ConfigureScopeTrigger, SetPatternExperiment, SetWaveformSignal } from './misc-setters.js'

/** 一台**有** qPlus 的机器：信号表第 2 路是振幅通道。 */
const NAMES_WITH_QPLUS = ['Current (A)', 'Z (m)', 'OCD1 Amplitude (m)']
const NAMES_STM_ONLY = ['Current (A)', 'Z (m)', 'Bias (V)']

function rig(opts: {
  names?: string[]
  amplitude?: number
  excitationOn?: number | null
  excitationV?: number | null
  fail?: Set<string>
} = {}): { ctx: SkillContext; calls: { verb: string; args: unknown[] }[] } {
  const calls: { verb: string; args: unknown[] }[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push({ verb: m, args: a })
      if (opts.fail?.has(m) === true) {
        return Promise.resolve({ method: m, args: a, error: '模拟故障：连接被对端关闭' })
      }
      if (m === 'Signals_NamesGet') {
        return Promise.resolve({ method: m, args: a, values: [opts.names ?? NAMES_WITH_QPLUS] })
      }
      if (m === 'Signals_ValGet') {
        return Promise.resolve({ method: m, args: a, values: [opts.amplitude ?? 1e-10] })
      }
      if (m === 'PLL_OutOnOffGet') {
        const v = opts.excitationOn === undefined ? 1 : opts.excitationOn
        return Promise.resolve({ method: m, args: a, values: v === null ? [] : [v] })
      }
      if (m === 'PLL_ExcitationGet') {
        const v = opts.excitationV === undefined ? 0.5 : opts.excitationV
        return Promise.resolve({ method: m, args: a, values: v === null ? [] : [v] })
      }
      return Promise.resolve({ method: m, args: a, values: [1] })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
    markers: { emit: () => {} },
  } as unknown as SkillContext
  return { ctx, calls }
}

const verbs = (c: { verb: string }[]): string[] => c.map((x) => x.verb)

beforeEach(() => {
  processQPlusBaseline.amplitude = null
  processQPlusBaseline.signalIndex = null
  delete processQPlusBaseline.persist
})

// ── qPlus：一台真有音叉的机器 ──────────────────────────────────────────────

describe('ReadTipOscillationAmplitude —— 有 qPlus 的机器', () => {
  it('按名字认出振幅通道并读它', async () => {
    const { ctx, calls } = rig({ amplitude: 1.5e-10 })
    const r = await ReadTipOscillationAmplitude.execute(ctx, {})
    expect(r.data).toMatchObject({
      status: 'ok', amplitude: 1.5e-10, signal_index: 2, signal_name: 'OCD1 Amplitude (m)',
    })
    expect(verbs(calls)).toEqual(['Signals_NamesGet', 'Signals_ValGet'])
    expect(calls[1]?.args).toEqual([2, 1])
  })

  it('**显式下标跳过整张信号表** —— 通道名不在关键词里时的出口', async () => {
    const { ctx, calls } = rig()
    await ReadTipOscillationAmplitude.execute(ctx, { signal_index: 7 })
    expect(verbs(calls)).toEqual(['Signals_ValGet'])
    expect(calls[0]?.args).toEqual([7, 1])
  })

  it('取基线：记住振幅**和那条通道**，下次不必再扫表', async () => {
    const a = rig({ amplitude: 2e-10 })
    const r = await ReadTipOscillationAmplitude.execute(a.ctx, { set_baseline: true })
    expect(r.data?.['baseline_set']).toBe(true)
    expect(processQPlusBaseline).toMatchObject({ amplitude: 2e-10, signalIndex: 2 })

    const b = rig({ amplitude: 3e-10 })
    await ReadTipOscillationAmplitude.execute(b.ctx, {})
    expect(verbs(b.calls)).toEqual(['Signals_ValGet']) // 没再扫信号表
  })

  it('落盘失败**只记不抛** —— 内存里已经是新的了', async () => {
    processQPlusBaseline.persist = () => {
      throw new Error('磁盘满了')
    }
    const { ctx } = rig({ amplitude: 2e-10 })
    const r = await ReadTipOscillationAmplitude.execute(ctx, { set_baseline: true })
    expect(r.success).toBe(true)
    expect(processQPlusBaseline.amplitude).toBe(2e-10)
  })

  it('STM-only 的机器：`unavailable`，而且**不是故障**', async () => {
    const { ctx } = rig({ names: NAMES_STM_ONLY })
    const r = await ReadTipOscillationAmplitude.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ status: 'unavailable', amplitude: null })
  })

  it('读数解析不出 ⇒ **失败**，不是「振幅是 0」', async () => {
    const { ctx } = rig()
    const c = {
      ...ctx,
      safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> =>
        m === 'Signals_ValGet'
          ? Promise.resolve({ method: m, args: a, values: [] })
          : ctx.safeCall(m, ...a),
    } as unknown as SkillContext
    const r = await ReadTipOscillationAmplitude.execute(c, { signal_index: 2 })
    expect(r.success).toBe(false)
    expect(r.error).toContain('振幅读数无法解析')
  })
})

describe('CheckTipCrashByAmplitude —— 四态，后两态都不是「没事」', () => {
  it('激励开着 + 有基线 + 振幅塌了 ⇒ **crash**', async () => {
    processQPlusBaseline.amplitude = 1e-10
    const { ctx } = rig({ amplitude: 5e-12 })
    const r = await CheckTipCrashByAmplitude.execute(ctx, {})
    expect(r.data).toMatchObject({ status: 'crash', crash_indicator: true })
    expect(String(r.data?.['note'])).toContain('针尖很可能已接触表面')
  })

  it('激励开着 + 有基线 + 振幅还在 ⇒ ok，**但不排除电流那边**', async () => {
    processQPlusBaseline.amplitude = 1e-10
    const { ctx } = rig({ amplitude: 9e-11 })
    const r = await CheckTipCrashByAmplitude.execute(ctx, {})
    expect(r.data).toMatchObject({ status: 'ok', crash_indicator: false })
    expect(String(r.data?.['note'])).toContain('不排除电流类判据')
  })

  it('**缺陷⑰：开关开着而激励是 0 V ⇒ unavailable** —— 本机实测那一组', async () => {
    processQPlusBaseline.amplitude = 1e-10
    const { ctx, calls } = rig({ excitationOn: 1, excitationV: 0, amplitude: 7e-12 })
    const r = await CheckTipCrashByAmplitude.execute(ctx, {})
    // 振幅只有基线的 7 % —— 拿噪声底跟自由振荡基线比，永远比出「塌了」
    expect(r.data).toMatchObject({ status: 'unavailable', crash_indicator: null })
    expect(String(r.data?.['note'])).toContain('振幅通道无判据能力')
    // **连振幅都不去读** —— 读了也不代表任何东西
    expect(verbs(calls)).toEqual(['PLL_OutOnOffGet', 'PLL_ExcitationGet'])
  })

  it('激励状态读不到 ⇒ unavailable，且 `excitation_on` 是 `null`', async () => {
    const { ctx } = rig({ excitationOn: null })
    const r = await CheckTipCrashByAmplitude.execute(ctx, {})
    expect(r.data).toMatchObject({ status: 'unavailable', excitation_on: null })
    expect(String(r.data?.['note'])).toContain('判不了')
  })

  it('没有基线 ⇒ `no_baseline`，**不是 ok**', async () => {
    const { ctx } = rig({ amplitude: 1e-12 })
    const r = await CheckTipCrashByAmplitude.execute(ctx, {})
    expect(r.data).toMatchObject({ status: 'no_baseline', crash_indicator: null })
    expect(String(r.data?.['note'])).toContain('set_baseline=True')
  })

  it('**技能永远 success** —— 它报的是一个判决，不是一次工具故障', async () => {
    for (const opts of [{}, { excitationOn: null }, { names: NAMES_STM_ONLY }]) {
      const { ctx } = rig(opts)
      expect((await CheckTipCrashByAmplitude.execute(ctx, {})).success, JSON.stringify(opts)).toBe(true)
    }
  })
})

// ── 压电范围对账 ───────────────────────────────────────────────────────────

describe('CheckPiezoRange —— 让两边的数字见面', () => {
  const limits = (xy: number): (() => { xy_max_m: number }) => () => ({ xy_max_m: xy })

  it('**2026-08-16 那一组**：配置 1.5 µm、仪器半程 1219.5 nm', async () => {
    const { ctx } = rig()
    const c = {
      ...ctx,
      safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> =>
        Promise.resolve({ method: m, args: a, values: [2438.9999e-9, 2438.9999e-9, 3000e-9] }),
    } as unknown as SkillContext
    const skill = makeCheckPiezoRange({ effectiveLimits: limits(1.5e-6) as never })
    const r = await skill.execute(c, {})
    expect(r.data).toMatchObject({ verdict: 'mismatch', configured_exceeds_instrument: true })
    expect(String(r.summary)).toContain('**配置比仪器大**')
    // 报文要说清该把它改成多少 —— 一句「对不上」没有可执行的部分
    expect(String(r.summary)).toContain('请把 xy_max_m 改成')
  })

  it('配置比仪器**小**：不撞限位，只是浪费面积 —— 两句话不一样', async () => {
    const { ctx } = rig()
    const c = {
      ...ctx,
      safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> =>
        Promise.resolve({ method: m, args: a, values: [4000e-9, 4000e-9, 3000e-9] }),
    } as unknown as SkillContext
    const r = await makeCheckPiezoRange({ effectiveLimits: limits(1.5e-6) as never }).execute(c, {})
    expect(r.data).toMatchObject({ verdict: 'mismatch', configured_exceeds_instrument: false })
    expect(String(r.summary)).toContain('白白浪费可用面积')
    expect(String(r.summary)).not.toContain('配置比仪器大')
  })

  it('一致 ⇒ ok', async () => {
    const { ctx } = rig()
    const c = {
      ...ctx,
      safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> =>
        Promise.resolve({ method: m, args: a, values: [3e-6, 3e-6, 3e-6] }),
    } as unknown as SkillContext
    const r = await makeCheckPiezoRange({ effectiveLimits: limits(1.5e-6) as never }).execute(c, {})
    expect(r.data).toMatchObject({ verdict: 'ok' })
    expect(String(r.summary)).toContain('**一致**')
  })

  it('**仪器读不到 ⇒ unknown**，而且技能仍然 success', async () => {
    const { ctx } = rig({ fail: new Set(['Piezo_RangeGet']) })
    const r = await makeCheckPiezoRange().execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ verdict: 'unknown' })
    expect(String(r.data?.['undecidable'])).toContain('判不了,不是「一致」')
  })

  it('没接生效限值 ⇒ 退回出厂默认（**而那正是要核对的那个数**）', async () => {
    const { ctx } = rig()
    const c = {
      ...ctx,
      safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> =>
        Promise.resolve({ method: m, args: a, values: [2438.9999e-9, 2438.9999e-9, 3e-6] }),
    } as unknown as SkillContext
    const r = await makeCheckPiezoRange().execute(c, {})
    expect(r.data?.['configured_half_xy_m']).toBe(1.5e-6)
  })

  it('**它从不改变任何东西** —— 只发一条读', async () => {
    const { ctx, calls } = rig()
    await makeCheckPiezoRange().execute(ctx, {})
    expect(verbs(calls)).toEqual(['Piezo_RangeGet'])
  })
})

// ── misc_setters：D-ZERO-1 第三次 ──────────────────────────────────────────

describe('ConfigureScopeTrigger —— `0` 是一个值（D-ZERO-1）', () => {
  it('**`trigger_mode = 0` 下发得下去** —— 旧仓的 `or` 把它换成了 1', async () => {
    const { ctx, calls } = rig()
    await ConfigureScopeTrigger.execute(ctx, { trigger_mode: 0 })
    expect(calls[0]?.args?.[0]).toBe(0)
  })

  it('**`trigger_slope = 0`（下降沿）也下发得下去**', async () => {
    const { ctx, calls } = rig()
    await ConfigureScopeTrigger.execute(ctx, { trigger_slope: 0 })
    expect(calls[0]?.args?.[1]).toBe(0)
  })

  it('没给就走缺省 1 / 1 / 0 / 0', async () => {
    const { ctx, calls } = rig()
    await ConfigureScopeTrigger.execute(ctx, {})
    expect(calls[0]?.args).toEqual([1, 1, 0, 0])
  })
})

describe('三个带回读的 —— 读不到就是 `null`', () => {
  it('回读失败**不让整趟失败**（写已经成了）', async () => {
    const { ctx } = rig({ fail: new Set(['FunGen2Ch_SignalGet']) })
    const r = await SetWaveformSignal.execute(ctx, { channel: 1, signal_index: 24 })
    expect(r.success).toBe(true)
    expect(r.data?.['readback']).toBeNull()
  })

  it('写失败 ⇒ 整趟失败，**不去读**', async () => {
    const { ctx, calls } = rig({ fail: new Set(['Pattern_PropsSet']) })
    const r = await SetPatternExperiment.execute(ctx, { experiment: 2 })
    expect(r.success).toBe(false)
    expect(verbs(calls)).toEqual(['Pattern_PropsSet'])
  })
})
