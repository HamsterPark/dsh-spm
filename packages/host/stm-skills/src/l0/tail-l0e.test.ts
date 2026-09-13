/**
 * 批 3e 那五个收口模块里**通用金样驱动不到**的格子。
 *
 * 轨迹金样把每条由回包决定的分支都钉住了，这里补的是另一类：
 * **一个合法的 `0` 能不能下发**、`NeedModule` 与别的错分不分得开、
 * 以及那条「不像位置的坐标就不报」的守卫。
 */
import { describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { AtomTrackStatusGet, ConfigureAtomTrack } from './atom-track.js'
import { AcquireOsciTrace, GetOsciTimebases, SetOsciTimebase } from './osci.js'
import { ConfigureSpectrumAnalyzer, GetSpectrumAnalyzerData, SetSpectrumAnalyzerBand } from './spectrum.js'
import { BiasPulse, RunBiasSweep } from './bias-sweep.js'
import { TIP_XY_MAX_M, parseTipXy, tipXyFields } from './tip-xy.js'

function rig(opts: { replies?: Record<string, unknown[]>; fail?: Set<string>; failText?: string } = {}): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
} {
  const calls: { verb: string; args: unknown[] }[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push({ verb: m, args: a })
      if (opts.fail?.has(m) === true) {
        return Promise.resolve({
          method: m,
          args: a,
          error: opts.failText ?? '模拟故障：连接被对端关闭',
        })
      }
      return Promise.resolve({ method: m, args: a, values: opts.replies?.[m] ?? [1] })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
  } as unknown as SkillContext
  return { ctx, calls }
}

const verbs = (calls: { verb: string }[]): string[] => calls.map((c) => c.verb)

// ── AtomTrack ──────────────────────────────────────────────────────────────

describe('ConfigureAtomTrack —— 使能失败必须失败', () => {
  it('两个使能都不开时**一次 CtrlSet 都不发**', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigureAtomTrack.execute(ctx, {
      integral_gain: 1, frequency_hz: 300, amplitude_m: 2e-11,
      enable_modulation: false, enable_controller: false,
    })
    expect(verbs(calls)).toEqual(['AtomTrack_PropsSet'])
    expect(r.data).toMatchObject({ modulation_enabled: false, controller_enabled: false })
  })

  it('**开调制失败就是整趟失败** —— 咽下去会让调用方相信它开着', async () => {
    const { ctx, calls } = rig({ fail: new Set(['AtomTrack_CtrlSet']) })
    const r = await ConfigureAtomTrack.execute(ctx, {
      integral_gain: 1, frequency_hz: 300, amplitude_m: 2e-11,
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('enable modulation failed')
    // 控制器那一条**不发**：第一步没成，后面的不排
    expect(verbs(calls)).toEqual(['AtomTrack_PropsSet', 'AtomTrack_CtrlSet'])
  })

  it('`CtrlSet` 的第一个实参分调制(0)与控制器(1)', async () => {
    const { ctx, calls } = rig()
    await ConfigureAtomTrack.execute(ctx, {
      integral_gain: 1, frequency_hz: 300, amplitude_m: 2e-11,
    })
    expect(calls.filter((c) => c.verb === 'AtomTrack_CtrlSet').map((c) => c.args)).toEqual([
      [0, 1],
      [1, 1],
    ])
  })
})

describe('AtomTrackStatusGet —— 状态位在 body 第 0 位', () => {
  it('读到 0 就是 Off，读到非 0 就是 On', async () => {
    for (const [body, want] of [[[0], false], [[1], true], [[7], true]] as const) {
      const { ctx } = rig({ replies: { AtomTrack_StatusGet: [...body] } })
      const r = await AtomTrackStatusGet.execute(ctx, { control: 0 })
      expect(r.data).toMatchObject({ control: 'Modulation', status: want })
    }
  })

  it('**取不出就是 Off** —— 旧仓读的是信封第 0 位，于是每一项都报 Off', async () => {
    const { ctx } = rig({ replies: { AtomTrack_StatusGet: [] } })
    expect((await AtomTrackStatusGet.execute(ctx, { control: 1 })).data).toMatchObject({
      control: 'Controller', status: false,
    })
  })

  it('认不出的索引原样印出来，不编一个名字', async () => {
    const { ctx } = rig()
    expect((await AtomTrackStatusGet.execute(ctx, { control: 9 })).data).toMatchObject({
      control: '9',
    })
  })
})

// ── Osci1T ─────────────────────────────────────────────────────────────────

const NEED = 'NanonisError: NeedModule Osci1T'

describe('Osci1T —— NeedModule 与别的错是两回事', () => {
  it('带 NeedModule：拒，并且**不再往下发**', async () => {
    for (const skill of [AcquireOsciTrace, GetOsciTimebases, SetOsciTimebase]) {
      const { ctx, calls } = rig({ fail: new Set(['Osci1T_Run']), failText: NEED })
      const r = await skill.execute(ctx, { timebase_index: 0 })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Osci1T module is not loaded')
      expect(verbs(calls)).toEqual(['Osci1T_Run'])
    }
  })

  it('不带 NeedModule：**照样往下跑** —— `Run` 是幂等的启动', async () => {
    const { ctx, calls } = rig({
      fail: new Set(['Osci1T_Run']),
      replies: { Osci1T_DataGet: [0.0, 5e-5, 3, [1, 2, 3]] },
    })
    const r = await AcquireOsciTrace.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(verbs(calls)).toEqual(['Osci1T_Run', 'Osci1T_DataGet'])
  })
})

describe('AcquireOsciTrace —— 解不开就说解不开', () => {
  it('字段少于四个：报**收到了几个**', async () => {
    const { ctx } = rig({ replies: { Osci1T_DataGet: [0.0, 5e-5, 3] } })
    const r = await AcquireOsciTrace.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe('Unexpected response shape: 3 fields')
  })

  it('**采样里有一个点解不出，整条作废** —— 掉了几个点的序列形状看起来完全正常', async () => {
    const { ctx } = rig({ replies: { Osci1T_DataGet: [0.0, 5e-5, 3, [1, 'x', 3]] } })
    const r = await AcquireOsciTrace.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('samples=解不开')
  })

  it('dt = 0 时采样率报 0，**不除零**', async () => {
    const { ctx } = rig({ replies: { Osci1T_DataGet: [0.0, 0.0, 2, [1, 2]] } })
    const r = await AcquireOsciTrace.execute(ctx, {})
    expect(r.data).toMatchObject({ fs_hz: 0, nyquist_hz: 0, duration_s: 0 })
  })

  it('`signal_index = -1` 不发 ChSet，`0` 发', async () => {
    const a = rig({ replies: { Osci1T_DataGet: [0, 1, 1, [1]] } })
    await AcquireOsciTrace.execute(a.ctx, { signal_index: -1 })
    expect(verbs(a.calls)).not.toContain('Osci1T_ChSet')

    const b = rig({ replies: { Osci1T_DataGet: [0, 1, 1, [1]] } })
    await AcquireOsciTrace.execute(b.ctx, { signal_index: 0 })
    expect(b.calls.find((c) => c.verb === 'Osci1T_ChSet')?.args).toEqual([0])
  })
})

// ── 频谱分析仪 ─────────────────────────────────────────────────────────────

describe('ConfigureSpectrumAnalyzer —— `0` 是一个值（D-ZERO-1）', () => {
  it('**矩形窗（0）下发得下去** —— 旧仓的 `or` 把它换成了 1', async () => {
    const { ctx, calls } = rig()
    await ConfigureSpectrumAnalyzer.execute(ctx, { fft_window: 0 })
    expect(calls[0]?.args).toEqual([1, 0])
  })

  it('**不平均（averaging_mode = 0）也下发得下去**', async () => {
    const { ctx, calls } = rig()
    await ConfigureSpectrumAnalyzer.execute(ctx, { averaging_mode: 0 })
    expect(calls[1]?.args).toEqual([1, 0, 0, 20])
  })

  it('没给就走缺省：Hann(1) + 线性平均(1) + 20 次 + AC', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigureSpectrumAnalyzer.execute(ctx, {})
    expect(calls.map((c) => c.args)).toEqual([[1, 1], [1, 1, 0, 20], [1, 1]])
    expect(r.summary).toBe('频谱分析仪 #1 已配置：平均 20 次，AC 耦合')
  })

  it('实例号 `0` 顶成 1 —— **Nanonis 从 1 开始数**，0 不是一个实例', async () => {
    const { ctx, calls } = rig()
    await ConfigureSpectrumAnalyzer.execute(ctx, { instance: 0 })
    expect(calls[0]?.args?.[0]).toBe(1)
  })
})

describe('SetSpectrumAnalyzerBand —— 反过来就拒，不换', () => {
  it('相等与颠倒都拒，而且**一次调用都不发**', async () => {
    for (const [lo, hi] of [[50, 50], [1000, 1]] as const) {
      const { ctx, calls } = rig()
      const r = await SetSpectrumAnalyzerBand.execute(ctx, { f_low_hz: lo, f_high_hz: hi })
      expect(r.success).toBe(false)
      expect(r.error).toBe(`f_low_hz (${lo}) 必须小于 f_high_hz (${hi})`)
      expect(calls).toEqual([])
    }
  })

  it('文案里的数用 Python 的 `%g`', async () => {
    const { ctx } = rig()
    const r = await SetSpectrumAnalyzerBand.execute(ctx, { f_low_hz: 1e7, f_high_hz: 1 })
    expect(r.error).toBe('f_low_hz (1e+07) 必须小于 f_high_hz (1)')
  })
})

describe('GetSpectrumAnalyzerData —— 读不到那一格给 null', () => {
  it('技能**永远 success**：它报的是「问到了什么」', async () => {
    const { ctx } = rig({
      fail: new Set(['SpectrumAnlzr_BandRMSGet', 'SpectrumAnlzr_AveragGet']),
    })
    const r = await GetSpectrumAnalyzerData.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ band_rms: null, averaging: null })
  })

  it('单元素 body 解一层，多元素保持成表', async () => {
    const { ctx } = rig({
      replies: {
        SpectrumAnlzr_DCGet: [0.25],
        SpectrumAnlzr_CursorPosGet: [1, 1000, 0.5],
      },
    })
    const r = await GetSpectrumAnalyzerData.execute(ctx, {})
    // 一个 DC 值是**一个数**，不是一个只有一个数的表
    expect(r.data?.['dc']).toBe(0.25)
    expect(r.data?.['band']).toEqual([1, 1000, 0.5])
  })
})

// ── Bias sweeper / pulse ───────────────────────────────────────────────────

describe('RunBiasSweep', () => {
  it('**颠倒的限值换过来** —— 与频带那条刻意不同', async () => {
    const { ctx, calls } = rig()
    const r = await RunBiasSweep.execute(ctx, { lower_limit_v: 1, upper_limit_v: -1 })
    expect(calls.find((c) => c.verb === 'BiasSwp_LimitsSet')?.args).toEqual([-1, 1])
    expect(r.data).toMatchObject({ lower_limit_v: -1, upper_limit_v: 1 })
  })

  it('**`sweep_direction = 0` 下发得下去**（D-ZERO-1）', async () => {
    // 旧仓写的是 `int(params.get(k, 1) or 1)` ⇒ `0 or 1` = 1
    // ⇒ 「从上限扫到下限」一次也选不出来。
    const { ctx, calls } = rig()
    await RunBiasSweep.execute(ctx, { lower_limit_v: -1, upper_limit_v: 1, sweep_direction: 0 })
    expect(calls.find((c) => c.verb === 'BiasSwp_Start')?.args?.[1]).toBe(0)
  })

  it('`BiasSwp_PropsSet` 只发**四个**实参（D-BIASSWP-1）', async () => {
    // 协议表与 `nanonis_spm` 的签名都只有四个；旧仓发五个 ⇒ 真机上每次 TypeError。
    const { ctx, calls } = rig()
    await RunBiasSweep.execute(ctx, { lower_limit_v: -1, upper_limit_v: 1 })
    expect(calls.find((c) => c.verb === 'BiasSwp_PropsSet')?.args).toHaveLength(4)
  })

  it('步数 / 周期的 `0` 走缺省 —— 那两个 0 本来就不合法', async () => {
    const { ctx, calls } = rig()
    await RunBiasSweep.execute(ctx, {
      lower_limit_v: -1, upper_limit_v: 1, steps: 0, period_ms: 0,
    })
    expect(calls.find((c) => c.verb === 'BiasSwp_PropsSet')?.args).toEqual([256, 10, 1, 0])
  })
})

describe('BiasPulse —— 打在哪儿也是结果的一部分', () => {
  it('**先读位置，后发脉冲**', async () => {
    const { ctx, calls } = rig({ replies: { FolMe_XYPosGet: [1e-9, 2e-9] } })
    const r = await BiasPulse.execute(ctx, { width_s: 0.5, bias_v: 5 })
    expect(verbs(calls)).toEqual(['FolMe_XYPosGet', 'Bias_Pulse'])
    expect(r.data).toMatchObject({ x_m: 1e-9, y_m: 2e-9 })
  })

  it('位置读不到：**什么都不报**，脉冲照发', async () => {
    const { ctx } = rig({ fail: new Set(['FolMe_XYPosGet']) })
    const r = await BiasPulse.execute(ctx, { width_s: 0.5, bias_v: 5 })
    expect(r.success).toBe(true)
    expect('x_m' in (r.data ?? {})).toBe(false)
  })

  it('绝对 = 2、相对 = 1，`z_hold` 的 `0` 下发得下去（D-ZERO-1）', async () => {
    const { ctx, calls } = rig()
    await BiasPulse.execute(ctx, { width_s: 0.5, bias_v: 5, absolute: false, z_hold: 0 })
    expect(calls.find((c) => c.verb === 'Bias_Pulse')?.args).toEqual([1, 0.5, 5, 0, 1])
  })
})

describe('parseTipXy —— 不像位置的坐标不报', () => {
  it('量级守卫：**一台扫描台的横向行程不到 1 mm**', () => {
    expect(parseTipXy({ method: '', args: [], values: [1e-9, 2e-9] })).toEqual([1e-9, 2e-9])
    expect(parseTipXy({ method: '', args: [], values: [TIP_XY_MAX_M, 0] })).toBeNull()
    // 一个解析残渣会把标记放到无效位置，下游范围计算也会失效
    expect(parseTipXy({ method: '', args: [], values: [3e8, 0] })).toBeNull()
  })

  it('NaN / 少一位 / 出错，一律 `null`', () => {
    expect(parseTipXy({ method: '', args: [], values: [NaN, 0] })).toBeNull()
    expect(parseTipXy({ method: '', args: [], values: [1e-9] })).toBeNull()
    expect(parseTipXy({ method: '', args: [], values: [], error: '断了' })).toBeNull()
  })

  it('`tipXyFields` 读不到时给空对象 —— **缺键就是「读不到」**', async () => {
    const { ctx } = rig({ replies: { FolMe_XYPosGet: [5, 5] } })
    expect(await tipXyFields(ctx)).toEqual({})
  })
})
