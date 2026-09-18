/**
 * 批 5b 的五个「真的跟仪器说话」的技能对**真 stmsim** 跑一遍（DoD ④）。
 *
 * ## 哪几个有 e2e、哪几个**不该有**
 *
 * | 技能 | 有没有 | 为什么 |
 * |---|---|---|
 * | `MonitorCurrent` / `MonitorCurrentFFT` | ✅ | **轮询类**。单测里的 `sleep` 是把假钟往前拨，往返是零成本；真链路上每一拍都是一次 TCP 往返，而「拍数」「实际采样率」正是这两个技能报出去的东西 |
 * | `WatchScanLines` | ✅ | 它对四个回包的**形状**都有假设，而自己造的回包会照着假设长 |
 * | `BiasSettleChange` | ✅ | 本仓第一条「非执行器组合 ↔ 真子技能 ↔ 真仪器」的缝：`Bias_Get` 的读数要真的能喂回 `SetBiasRamp` |
 * | `AcquirePSD` | ✅ | 见下：模拟器上这个模块**可能根本没装**，而「没装」与「装了但读不出」要分得开 |
 * | `ClassifyUnexplainedCurrent` / `RecoverTipFromSaturation` | ❌ | 两个都会**动针尖与反馈**（关反馈量 I(V)、粗动退 800 步）。在共用的那台模拟器上跑它们会把后面每一条集成测试的初始状态改掉，而它们一次裸动词都不发 —— 缝在 `ctx.runSkill` 上，那一层由 `runsub.test.ts` 单独验 |
 * | `BatchRegionsScan` | ❌ | 它排的是 `ConfigureScan/SetScanSpeed/StartScan/WaitScanComplete/SaveScan`，五个**都已经**由 `scan-composites.test.ts` 对真模拟器验过；再跑一遍只是把同一条链跑两次，而代价是改掉共用模拟器的帧几何 |
 *
 * ⚠️ 与 `scan-composites.test.ts` 同一条纪律：**整组 `integration` 共用一台模拟器**，
 * 所以这一组自己**存档 + 还原**偏压。改了就要放回去。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`），
 * 所以这里 `spawn: false`。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

class Rig {
  readonly calls: string[] = []
  readonly subs: string[] = []
  readonly #inst: { call: SafeCallish }

  constructor(inst: { call: SafeCallish }) {
    this.#inst = inst
  }

  ctx(): SkillContext {
    const S0 = emptyHardwareState('stmsim')
    const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      this.calls.push(m)
      return this.#inst.call(m, a)
    }
    const ctx = {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.subs.push(name)
        const s = IMPLEMENTED[name]
        if (s === undefined) return Promise.resolve({ success: false, error: `注册表里没有 ${name}` })
        return s.execute(ctx, params)
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'integration',
      rootCallId: 'current-diag',
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

/** 进来时的偏压。`BiasSettleChange` 那一格会改它，跑完放回去。 */
let savedBiasV: number | null = null

beforeAll(async () => {
  const rig = await instrument()
  const rec = await rig.ctx().safeCall('Bias_Get')
  const v = (rec.values ?? [])[0]
  savedBiasV = typeof v === 'number' ? v : null
  cleanup.splice(0).forEach((fn) => fn())
}, 60_000)

afterAll(async () => {
  if (savedBiasV === null) return
  const rig = await instrument()
  await rig.ctx().safeCall('Bias_Set', savedBiasV)
  cleanup.splice(0).forEach((fn) => fn())
}, 60_000)

describe('轮询类对真 stmsim：一拍就是一次真往返', () => {
  it('MonitorCurrent：拍数、时刻表与统计都由真链路给', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['MonitorCurrent']!.execute(rig.ctx(), {
      duration_s: 0.4,
      poll_hz: 20.0,
      // 阈值定在一个真机上到不了的量级：这一格要验的是**采样**，不是接触判定
      contact_threshold_a: 1e-3,
      min_contact_samples: 3,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    const n = d['n_samples'] as number

    // ① 真的采到了东西 —— 而且**每一拍都对应一次 `Current_Get`**。
    //    这一条是单测验不到的：假 context 的 `sleep` 是零成本，真链路不是。
    expect(n).toBeGreaterThan(1)
    expect(rig.calls.filter((c) => c === 'Current_Get').length).toBeGreaterThanOrEqual(n)
    expect((d['samples_a'] as unknown[]).length).toBe(n)
    expect((d['timestamps_s'] as unknown[]).length).toBe(n)

    // ② 时刻表是**单调**的，而且都落在窗口里。排拍写成
    //    `nextPoll = now() + period` 的话这一条照样成立 —— 所以它不是那道闸的判据，
    //    它是「这几个数确实是从这台仪器上来的」的判据。
    const ts = d['timestamps_s'] as number[]
    for (let i = 1; i < ts.length; i += 1) expect(ts[i] as number).toBeGreaterThan(ts[i - 1] as number)
    expect(d['actual_duration_s'] as number).toBeGreaterThanOrEqual(0.4)

    // ③ 统计量与样本对得上（`min ≤ mean ≤ max`，而且都是真数不是 NaN）。
    const mn = d['min_abs_a'] as number
    const mx = d['max_abs_a'] as number
    const mean = d['mean_abs_a'] as number
    expect(Number.isFinite(mean)).toBe(true)
    expect(mn).toBeLessThanOrEqual(mean)
    expect(mean).toBeLessThanOrEqual(mx)
    // 没有接触 ⇒ `contact_at_s` 是 **null**，不是 -1（旧仓的 `-1.0` 只活在它自己
    // 那个局部变量里，交出去的那一刻就变成 None 了）
    expect(d['contact_detected']).toBe(false)
    expect(d['contact_at_s']).toBeNull()
  }, 120_000)

  it('MonitorCurrentFFT：`actual_fs_hz` 是**量出来的**，不是请求的那个数', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['MonitorCurrentFFT']!.execute(rig.ctx(), {
      duration_s: 0.4,
      poll_hz: 50.0,
      window: 'hann',
      detrend: true,
      output: 'magnitude',
    })
    expect(res.error ?? '').toBe('')
    const d = res.data as Record<string, unknown>
    const n = d['n_samples'] as number
    expect(n).toBeGreaterThanOrEqual(4)

    // ① 谱的长度是 `⌊n/2⌋+1` —— rfft 的那一半。
    expect((d['spectrum'] as unknown[]).length).toBe((n >> 1) + 1)
    expect((d['freqs_hz'] as unknown[]).length).toBe((n >> 1) + 1)

    // ② 频率刻度由**实测**采样率定：`nyquist = fs/2`、`df = fs/n`、
    //    `freqs[k] = k/(n·d)`。三者必须自洽 —— 而在真链路上 `fs` 拿不到整数。
    const fs = d['actual_fs_hz'] as number
    expect(Number.isFinite(fs)).toBe(true)
    expect(fs).toBeGreaterThan(0)
    expect(d['nyquist_hz'] as number).toBeCloseTo(fs / 2, 9)
    expect(d['df_hz'] as number).toBeCloseTo(fs / n, 9)
    const freqs = d['freqs_hz'] as number[]
    expect(freqs[0]).toBe(0)
    expect(freqs[freqs.length - 1] as number).toBeLessThanOrEqual(fs / 2 + 1e-9)

    // ③ 谱里没有 NaN。去趋势之后整条为零是**合法**的（一条恒定的电流），
    //    但 NaN 不是 —— 一个 NaN 穿得过每一条 `>` 检查（同 D-SI-1）。
    for (const v of d['spectrum'] as number[]) expect(Number.isFinite(v)).toBe(true)
  }, 120_000)
})

describe('`WatchScanLines` 对真 stmsim：不停扫看一眼', () => {
  it('四个回包的形状都是解析器假设的那个，且**不停扫**', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['WatchScanLines']!.execute(rig.ctx(), {
      direction: 1,
      since_line: -1,
      max_lines: 8,
    })
    // 顺序本身是判据：先问缓冲（要通道号），再问信号名、视野，最后才抓帧。
    expect(rig.calls).toEqual([
      'Scan_BufferGet',
      'Signals_NamesGet',
      'Scan_FrameGet',
      'Scan_FrameDataGrab',
    ])
    // **一条停扫指令都没发过** —— 这个技能的全部价值就是它不停扫。
    expect(rig.calls).not.toContain('Scan_Action')
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    expect(typeof d['nm_per_px']).toBe('number')
    expect((d['scan_channels'] as number[]).length).toBeGreaterThan(0)
    expect(d['n_lines_total'] as number).toBeGreaterThan(0)

    // ⚠️ 这一格照出的那件事：**模拟器刚起来时缓冲是一片零**（批 4c 在
    // `ComputeDriftVector` 上撞到的同一个事实）。于是 `n_lines_done` 多半是 0，
    // 而这个技能对那种情况**有一句专门的话** —— 它绝不把「一行都没有」
    // 说成「表面是平的」。
    const done = d['n_lines_done'] as number
    const obs = d['observations'] as string[]
    expect(obs.length).toBeGreaterThan(0)
    if (done === 0) {
      expect(obs[0]).toContain('这不等于「表面是平的」')
      expect(d['advancing']).toBe(false)
    } else {
      expect(typeof d['rms_roughness_m']).toBe('number')
      expect(d['last_line_index'] as number).toBeGreaterThanOrEqual(0)
    }
  }, 120_000)
})

describe('`BiasSettleChange` 对真 stmsim：读回来的起点要真的能喂回子技能', () => {
  it('小幅改动走 `direct`，而起点是**读出来的**不是猜的', async () => {
    const rig = await instrument()
    const before = await rig.ctx().safeCall('Bias_Get')
    const start = Number((before.values ?? [])[0])
    expect(Number.isFinite(start)).toBe(true)

    const target = start + 0.1
    const res = await IMPLEMENTED['BiasSettleChange']!.execute(rig.ctx(), {
      bias_v: target,
      settle_s: 0.05,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    expect(d['strategy']).toBe('direct')
    expect(d['bias_v_start'] as number).toBeCloseTo(start, 6)
    // `direct` 那一支**不报速率**
    expect(d['slew_rate_v_per_s']).toBeNull()
    expect(rig.subs).toEqual(['SetBias'])

    // 真的写下去了：再读一次，仪器上就是那个数。
    const after = await rig.ctx().safeCall('Bias_Get')
    expect(Number((after.values ?? [])[0])).toBeCloseTo(target, 5)
  }, 120_000)

  it('目标落在低偏压死区里 ⇒ **拒绝**，而且一次写都没发', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['BiasSettleChange']!.execute(rig.ctx(), { bias_v: 0.01 })
    // 反馈开着（模拟器起手就在隧道状态），所以这一条必须拦下来
    expect(res.success).toBe(false)
    expect(res.error).toContain('低偏压死区')
    expect(rig.subs).toEqual([])
    expect(rig.calls).toEqual(['Bias_Get', 'ZCtrl_OnOffGet'])
  }, 120_000)
})

describe('`AcquirePSD` 对真 stmsim：装没装那个模块，要说得出来', () => {
  it('要么回一条形状完整的谱，要么**失败并点名是哪个动词** —— 没有第三种', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['AcquirePSD']!.execute(rig.ctx(), { instance: 1 })
    const d = res.data as Record<string, unknown>
    const per = d['per_range'] as Record<string, unknown>[]

    // 第一步永远是起分析仪（幂等，失败也不早退）
    expect(rig.calls[0]).toBe('SpectrumAnlzr_Run')

    if (res.success) {
      // 成功 ⇒ **至少一个频段**，而且顶层的向后兼容字段与第一个频段一致。
      // 「成功 + 零个频段」正是这个技能最坏的那种失败：调用方拿 `data["psd"]`
      // 会得到 `undefined`，而 `success` 说一切正常。
      expect(per.length).toBeGreaterThan(0)
      const first = per[0] as Record<string, unknown>
      expect(d['psd']).toEqual(first['psd'])
      expect(d['n_bins']).toEqual(first['n_bins'])
      expect(d['f_max_hz'] as number).toBeCloseTo(
        (first['f0_hz'] as number) + ((first['n_bins'] as number) - 1) * (first['df_hz'] as number),
        9,
      )
      for (const v of first['psd'] as number[]) expect(Number.isFinite(v)).toBe(true)
    } else {
      // 失败 ⇒ 报文里**点名那个动词**（`ChSet` / `DataGet` / 形状不对），
      // 而不是一句「AcquirePSD aborted」。
      expect(res.error ?? '').not.toBe('')
      expect(res.error).toMatch(/DataGet|ChSet|Unexpected response shape|PSD decode error/)
      expect(per.length).toBe(0)
    }
  }, 120_000)
})
