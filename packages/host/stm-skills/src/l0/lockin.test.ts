/**
 * 锁相与留痕两族里**通用金样驱动不到**的那些格子。
 *
 * 轨迹金样已经把每条分支都钉住了（`ConfigureLockIn` 的五格、`DrawScanMarker` 的
 * 四格……），这里补的是另一类：**顺序**、**没写的字段报什么**、以及两处
 * 刻意不同的解析纪律。
 */
import { describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { ConfigureLockIn, ConfigureLockInDemod, GetLockInConfig } from './lockin.js'
import { DrawScanMarker, ListScanMarkers, logChannels, markerColor } from './datalog-marks.js'

function rig(opts: { errorAt?: number; replies?: Record<string, unknown[]>; fail?: Set<string> } = {}): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
} {
  const calls: { verb: string; args: unknown[] }[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      const i = calls.length
      calls.push({ verb: m, args: a })
      if (i === opts.errorAt || opts.fail?.has(m) === true) {
        return Promise.resolve({ method: m, args: a, error: '模拟故障：连接被对端关闭' })
      }
      return Promise.resolve({ method: m, args: a, values: opts.replies?.[m] ?? [1] })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
  } as unknown as SkillContext
  return { ctx, calls }
}

describe('ConfigureLockIn —— 顺序与「没写就别说」', () => {
  it('**先设值，最后才开调制**', async () => {
    const { ctx, calls } = rig()
    await ConfigureLockIn.execute(ctx, {
      mod_on: true, frequency_hz: 973, amplitude_v: 0.02, phase_deg: 90,
    })
    // 旧仓原先先开调制，于是隧道结被上一次残留的幅度/频率激励一小段时间
    expect(calls.map((c) => c.verb)).toEqual([
      'LockIn_ModPhasFreqSet',
      'LockIn_ModAmpSet',
      'LockIn_ModPhasSet',
      'LockIn_ModOnOffSet',
    ])
  })

  it('**幅度 0 要写得下去** —— 那是「开之前先把它变安全」', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigureLockIn.execute(ctx, { mod_on: true, amplitude_v: 0 })
    expect(calls.map((c) => c.verb)).toEqual(['LockIn_ModAmpSet', 'LockIn_ModOnOffSet'])
    expect(calls[0]?.args).toEqual([1, 0])
    expect(r.data).toMatchObject({ amplitude_v: 0, amplitude_written: true })
  })

  it('频率 0 **跳过** —— 那不是一个合法的调制频率', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigureLockIn.execute(ctx, { mod_on: true, frequency_hz: 0 })
    expect(calls.map((c) => c.verb)).toEqual(['LockIn_ModOnOffSet'])
    expect(r.data).toMatchObject({ frequency_hz: null, frequency_written: false })
  })

  it('**没写的字段报 `null`，不是 0** —— 别宣称一个没碰过的寄存器', async () => {
    const { ctx } = rig()
    const r = await ConfigureLockIn.execute(ctx, { mod_on: true })
    expect(r.data).toEqual({
      mod_on: true,
      amplitude_v: null, amplitude_written: false,
      frequency_hz: null, frequency_written: false,
      phase_deg: null, phase_written: false,
    })
  })

  it('任何一步失败就停，后面的不发', async () => {
    const { ctx, calls } = rig({ errorAt: 0 })
    const r = await ConfigureLockIn.execute(ctx, { mod_on: true, frequency_hz: 973, amplitude_v: 0.02 })
    expect(r.success).toBe(false)
    expect(calls.map((c) => c.verb)).toEqual(['LockIn_ModPhasFreqSet'])
  })
})

describe('ConfigureLockInDemod —— 给了才写', () => {
  it('一个都没给就一次调用都不发', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigureLockInDemod.execute(ctx, {})
    expect(calls).toEqual([])
    expect(r.data).toEqual({ demodulator: 1 })
  })

  it('**`null` 算没给** —— 模型那条路上每个可选字段都会以 null 到达', async () => {
    const { ctx, calls } = rig()
    await ConfigureLockInDemod.execute(ctx, {
      signal_index: null, harmonic: null, lp_order: null, hp_cutoff_hz: null, phase_deg: null,
    })
    // 用 `in` 判的话这里会把五个 null 送进硬件 setter
    expect(calls).toEqual([])
  })

  it('滤波的阶与截止是一对：给了一个，另一个用哨兵', async () => {
    const { ctx, calls } = rig()
    await ConfigureLockInDemod.execute(ctx, { lp_cutoff_hz: 100 })
    expect(calls).toEqual([{ verb: 'LockIn_DemodLPFilterSet', args: [1, -1, 100] }])

    const b = rig()
    await ConfigureLockInDemod.execute(b.ctx, { hp_order: 2 })
    expect(b.calls).toEqual([{ verb: 'LockIn_DemodHPFilterSet', args: [1, 2, 0] }])
  })
})

describe('GetLockInConfig —— 读回那一半', () => {
  it('**六个读回字段读不到时给 `null`**，不是 0', async () => {
    const { ctx } = rig({
      fail: new Set([
        'LockIn_ModSignalGet', 'LockIn_ModHarmonicGet', 'LockIn_ModPhasRegGet',
        'LockIn_DemodPhasRegGet', 'LockIn_DemodRTSignalsGet', 'LockIn_DemodSyncFilterGet',
      ]),
    })
    const r = await GetLockInConfig.execute(ctx, {})
    const d = r.data as Record<string, unknown>
    // `modulated_signal` 是其中最要紧的：一个调制错信号的锁相会产出一条
    // 完全干净、完全错误的 dI/dV 曲线，而图上看不出任何问题
    for (const k of ['modulated_signal', 'harmonic', 'mod_phase_register',
      'demod_phase_register', 'demod_rt_signals', 'demod_sync_filter']) {
      expect(d[k], k).toBeNull()
    }
  })

  it('调制侧读失败时**不写那个键** —— 与「读到了」分得开', async () => {
    const { ctx } = rig({ fail: new Set(['LockIn_ModAmpGet']) })
    const d = (await GetLockInConfig.execute(ctx, {})).data as Record<string, unknown>
    expect('amplitude' in d).toBe(false)
    expect('mod_on' in d).toBe(true)
  })

  it('解调器缺省跟随调制器', async () => {
    const { ctx, calls } = rig()
    await GetLockInConfig.execute(ctx, { modulator: 2 })
    expect(calls.filter((c) => c.verb === 'LockIn_DemodPhasRegGet')[0]?.args).toEqual([2])

    const b = rig()
    await GetLockInConfig.execute(b.ctx, { modulator: 2, demodulator: 3 })
    expect(b.calls.filter((c) => c.verb === 'LockIn_DemodPhasRegGet')[0]?.args).toEqual([3])
  })

  it('**技能永远 success** —— 它报的是「问到了什么」', async () => {
    const { ctx } = rig({ fail: new Set(['LockIn_ModOnOffGet', 'LockIn_ModAmpGet']) })
    expect((await GetLockInConfig.execute(ctx, {})).success).toBe(true)
  })
})

describe('logChannels —— 与撞针那边刻意不同：严格', () => {
  it('逗号与空格都认', () => {
    expect(logChannels('0, 2, 14')).toEqual([0, 2, 14])
    expect(logChannels('0 2 14')).toEqual([0, 2, 14])
  })

  it('**有一个不是整数，整串作废**', () => {
    // 记的是「哪几路」。默默丢掉一路会让日志里少一个通道而没人知道 ——
    // 这与撞针检测「少探一路无所谓」是两种场合，所以是两条规则。
    expect(logChannels('0, x, 14')).toBeNull()
    expect(logChannels('0,1.5')).toBeNull()
    expect(logChannels('spec-export')).toBeNull()
  })

  it('空串给 null（而不是空表）', () => {
    for (const v of ['', '   ', null, undefined]) expect(logChannels(v)).toBeNull()
  })
})

describe('标记', () => {
  it('颜色名认得出，认不出按红色 —— 不值得为一个颜色让留痕失败', () => {
    expect(markerColor('green')).toBe(0x00ff00)
    expect(markerColor('GREEN')).toBe(0x00ff00)
    expect(markerColor('0x123456')).toBe(0x123456)
    expect(markerColor('不是颜色')).toBe(0xff0000)
    expect(markerColor(undefined)).toBe(0xff0000)
  })

  it('线标记缺终点就拒 —— 不拿起点当终点画一个零长的线', async () => {
    const { ctx, calls } = rig()
    const r = await DrawScanMarker.execute(ctx, { kind: 'line', x_m: 1e-9, y_m: 1e-9 })
    expect(r.success).toBe(false)
    expect(calls).toEqual([])
  })

  it('**两种标记都读不到才算失败** —— 只有一种读不到时另一种照样交出去', async () => {
    const { ctx } = rig({ fail: new Set(['Marks_PointsGet']) })
    const r = await ListScanMarkers.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ points: [] })

    const b = rig({ fail: new Set(['Marks_PointsGet', 'Marks_LinesGet']) })
    expect((await ListScanMarkers.execute(b.ctx, {})).success).toBe(false)
  })
})
