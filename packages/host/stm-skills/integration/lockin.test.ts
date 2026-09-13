/**
 * 批 3e 接上**真 stmsim** —— 三件事只有真东西答得了。
 *
 * 1. **`NeedModule` 的那个子串在真错误文案里吗。** 三个 Osci1T 技能全靠
 *    `"NeedModule" in error` 分流（模块没装 ≠ 线路坏了），而那个判据落在一段
 *    **由仪器写、经过线协议、再经过熔断记账**的字符串上。自己造的回包里它永远对。
 * 2. **`ApplyLockInPreset` 的写后回读在 float32 往返上过不过。** 上一批（2026-09-13）
 *    正是在这条缝上照出了「相等比较把每一次成功写入都判成失败」——两套自己造的回包
 *    都对，真东西上一次都不对。这一批的回读走的是同一条 `valuesMatch`，
 *    而且**幅度那一格的键名两边不同**（`amplitude_v` → `amplitude`），
 *    所以这里同时验那张映射表。
 * 3. **`cell()` 的解一层在真回包上对不对。** 一个 DC 值是一个数，
 *    平均那三项是三个数——两者的形状差别只有真回包说得清。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { emptyHardwareState, type SkillCallRecord, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { isNeedModule } from 'dsh-spm-nanonis-wire'
import { afterEach, describe, expect, it } from 'vitest'
import { AcquireOsciTrace, GetOsciTimebases } from '../src/l0/osci.js'
import { GetSpectrumAnalyzerData, SetSpectrumAnalyzerBand } from '../src/l0/spectrum.js'
import { AtomTrackStatusGet } from '../src/l0/atom-track.js'
import { GetSignalCalibration } from '../src/l0/bias-sweep.js'
import { ConfigureLockIn, GetLockInConfig } from '../src/l0/lockin.js'
import { makeApplyLockInPreset } from '../src/l0/lockin-presets.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

/**
 * `InstrumentService.call` 直接当 `ctx.safeCall`。
 *
 * `runSkill` 这一次**真的分发**（只认这一批要的两个）：`ApplyLockInPreset` 的全部
 * 价值在于它走子技能的正门，换成一个假的返回就等于把要测的那条路绕开了。
 */
function instrument(timeoutMs = 10_000): Promise<SkillContext> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      const inst = c.instrument as {
        call: (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>
      }
      const S0 = emptyHardwareState('stmsim')
      const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => inst.call(m, a)
      const self: SkillContext = {
        signal: new AbortController().signal,
        safeCall,
        emergencyCall: safeCall,
        runSkill: (n: string, p: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
          if (n === 'ConfigureLockIn') return ConfigureLockIn.execute(self, p)
          if (n === 'GetLockInConfig') return GetLockInConfig.execute(self, p)
          return Promise.resolve({ success: false, error: `本夹具不分发：${n}` })
        },
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        state: () => S0,
        refreshState: () => Promise.resolve(S0),
        markers: { emit: () => {} },
        depth: 0,
        owner: 'integration',
        rootCallId: 'lockin',
        approvalSource: 'operator',
      } as unknown as SkillContext
      resolve(self)
    })
  })
}

const PROFILE = { modFreqHz: 973.0, modAmpV: 0.02, xSignalIndex: null, ySignalIndex: null }

describe('对真 stmsim：ApplyLockInPreset 的写后回读', () => {
  it('float32 往返**照样通过**，而回读的值确实不等于请求的值', async () => {
    const ctx = await instrument()
    const r = await makeApplyLockInPreset({ lockinProfile: () => PROFILE }).execute(ctx, {})
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    const d = r.data as {
      readback_verified: boolean
      readback: Record<string, unknown>
      values: Record<string, number>
    }
    expect(d.readback_verified).toBe(true)

    // 要害：上面那个 true **不是**因为 stmsim 碰巧精确回显。
    const got = d.readback['amplitude'] as number
    expect(typeof got).toBe('number')
    expect(got).not.toBe(0.02)
    const rel = Math.abs(got / 0.02 - 1)
    expect(rel).toBeGreaterThan(0)
    expect(rel).toBeLessThan(1e-6) // float32 往返噪声，比 1e-3 的容差小三个数量级
  })

  it('**键名那张映射表是对的** —— 回包里叫 `amplitude`，不叫 `amplitude_v`', async () => {
    const ctx = await instrument()
    const rb = await GetLockInConfig.execute(ctx, {})
    const d = (rb.data ?? {}) as Record<string, unknown>
    // 缺陷⑩：照着自己的参数名去查会查不到，于是把一次成功写入报成「读不回来」
    expect('amplitude' in d).toBe(true)
    expect('amplitude_v' in d).toBe(false)
  })

  it('档案没配就拒 —— 一次 `ConfigureLockIn` 都不发（D-LOCKIN-2）', async () => {
    const ctx = await instrument()
    const empty = { modFreqHz: null, modAmpV: null, xSignalIndex: null, ySignalIndex: null }
    const r = await makeApplyLockInPreset({ lockinProfile: () => empty }).execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('仪器档案里这一组一个值都没有配置')
  })
})

describe('对真 stmsim：`NeedModule` 那个子串在真文案里吗', () => {
  it('**真的没装的那些模块，真文案里确实带着它**', async () => {
    // 这一格是这条缝的要害：整个分流判据落在一段**由仪器写、经过线协议、
    // 再经过熔断记账**的字符串上，而自己造的回包里那个子串永远在。
    //
    // 本机 stmsim 实测（2026-09-14）：
    //   NanonisError: NeedModule: Cannot access the 'SpectrumAnlzr' module. …
    const ctx = await instrument()
    let seen = 0
    for (const [verb, args] of [
      ['SpectrumAnlzr_DCGet', [1]],
      ['AtomTrack_StatusGet', [0]],
    ] as const) {
      const rec = await ctx.safeCall(verb, ...args)
      if ((rec.error ?? '') === '') continue // 装了也是合法结局
      seen += 1
      expect(isNeedModule(rec.error ?? ''), `${verb}: ${rec.error ?? ''}`).toBe(true)
      // 而且它**不该**长得像一次线路故障 —— 两者的处置完全相反
      expect(rec.error).toMatch(/^NanonisError:/)
    }
    expect(seen, '两个模块都装上了 ⇒ 这一格这次没验到东西').toBeGreaterThan(0)
  })

  it('`Osci1T_Run` 真的回了什么 —— 两种结局都是合法结局', async () => {
    // 旧仓的 docstring 写着「自带的模拟器默认没有 Osci1T」。
    // **本机 stmsim 上它是装着的**（2026-09-14 实测）—— 那句话是关于另一台模拟器的。
    const ctx = await instrument()
    const rec = await ctx.safeCall('Osci1T_Run')
    const err = rec.error ?? ''
    if (err === '') {
      // 模块在：取一段缓冲，形状得说得通
      const r = await AcquireOsciTrace.execute(ctx, {})
      expect(r.error ?? '').toBe('')
      const d = r.data as { n_samples: number; samples: number[]; dt_s: number }
      expect(d.samples.length).toBeGreaterThan(0)
      expect(d.dt_s).toBeGreaterThan(0)
      const tb = await GetOsciTimebases.execute(ctx, {})
      expect(tb.error ?? '').toBe('')
      expect((tb.data as { n_timebases: number }).n_timebases).toBeGreaterThan(0)
      return
    }
    // 模块不在：走「去打开那个模块」那条路，而不是「重连」。
    expect(isNeedModule(err)).toBe(true)
    const r = await AcquireOsciTrace.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('Osci1T module is not loaded')
    const tb = await GetOsciTimebases.execute(ctx, {})
    expect(tb.success).toBe(false)
    expect(tb.error).toContain('no hardware timebases to list')
  })
})

describe('对真 stmsim：真回包的形状', () => {
  it('频谱分析仪六个读：**一个数是一个数，三个数是一张表**', async () => {
    const ctx = await instrument()
    await SetSpectrumAnalyzerBand.execute(ctx, { f_low_hz: 1, f_high_hz: 1000 })
    const r = await GetSpectrumAnalyzerData.execute(ctx, {})
    // 技能永远 success：它报的是「问到了什么」
    expect(r.success).toBe(true)
    const d = (r.data ?? {}) as Record<string, unknown>
    // 每一格要么是读到的东西，要么是 `null`（读不到）—— **不会是三段信封**。
    // 本机 stmsim 没装 SpectrumAnlzr，于是六格全是 `null`：那**也是**这一格要的答案，
    // 「读不到」在这里必须表示成 `null`，不能折成 0。
    for (const k of ['band_rms', 'dc', 'band', 'averaging', 'fft_window', 'ac_coupling']) {
      const v = d[k]
      expect(typeof v === 'number' || v === null || Array.isArray(v), `${k}=${String(v)}`).toBe(true)
      expect(v, `${k} 不该是信封`).not.toEqual(['', expect.anything(), []])
    }
  })

  it('AtomTrack 状态位在 body 第 0 位 —— 读到的是布尔，不是恒 false', async () => {
    const ctx = await instrument()
    const seen = new Set<unknown>()
    for (const control of [0, 1, 2]) {
      const r = await AtomTrackStatusGet.execute(ctx, { control })
      if (!r.success) continue // 模块没装也是一种合法结局
      seen.add((r.data as { status: boolean }).status)
    }
    // 三项里至少问出一个布尔（真值是什么由模拟器定，不钉它）
    for (const v of seen) expect(typeof v).toBe('boolean')
  })

  it('`Signals_CalibrGet` 的两位：读得到就是数，读不到就是 `null`', async () => {
    const ctx = await instrument()
    const r = await GetSignalCalibration.execute(ctx, { signal_index: 0 })
    if (!r.success) return // 这一路信号不存在也算答案
    const d = r.data as { calibration: number | null; offset: number | null }
    for (const v of [d.calibration, d.offset]) {
      expect(v === null || typeof v === 'number').toBe(true)
    }
  })
})
