/**
 * 扫描图预处理链对 `spec/golden/scan_prep.json` 的逐条比对（批 6b）。
 *
 * **容差不在这个文件里**：每一条都引用被测件自己导出的那个容差
 * （`FLATTEN_REL_TOL` / `FINE_PEAK_REL_TOL` / `OSC_REL_TOL` /
 * `TIP_CHANGE_REL_TOL` / `FB_INSTABILITY_ABS_TOL`），理由写在那些件的 docstring 里。
 * **这里没有一个字面量容差。**
 *
 * 帧一律**从 `.sxm` 的字节读回来** —— 两边各自重建同一个输入本身就是一处
 * 没有人在看的差异（批 4a 那条 `noiseFloor` 4.4e−14）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCAN_PREP_DEFAULTS, resolveScanPrepThresholds, scanPrepFromMapping, scanPrepNumericMapping } from 'dsh-spm-kernel'
import { matOf, npStd, type Mat } from 'dsh-spm-numerics'
import { readSxm, sxmOrientedFrames } from 'dsh-spm-nanonis-files'
import { diffTree, formatMismatches, scalesOf, toGolden } from './golden.js'
import { nanStd } from './nd.js'
import { medianFilter1d, medianFilter2d, uniformFilter1d, uniformFilter2d } from './ndfilters.js'
import { polySubtract } from './plane.js'
import {
  FINE_PEAK_REL_TOL,
  FLATTEN_REL_TOL,
  acquiredRowSpan,
  applyFlatten,
  dominantTerraceMask,
  finePeriodicPeak,
  harmoniseBatch,
  heightLevels,
  lineSubtract,
  measureFrame,
  planFor,
  rowCorrelation,
  rowMedianLevel,
  type FlattenPlan,
  type FrameMetrics,
} from './scan-prep.js'
import { OSC_REL_TOL, badRowFrac, detectScanArtifacts } from './scan-artifacts.js'
import { TIP_CHANGE_REL_TOL, TIP_CHANGE_TR_NOT_PORTED, detectTipChange, lodDc, rowChannels } from './tip-change.js'
import { FB_INSTABILITY_ABS_TOL, fwdBwdInstability } from './tip-metrics.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/scan_prep.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const TH = resolveScanPrepThresholds(null)

const framesCache = new Map<string, { fwd: Mat; bwd: Mat | null; nmPerPx: number | null }>()
function frameOf(key: string): { fwd: Mat; bwd: Mat | null; nmPerPx: number | null } {
  const hit = framesCache.get(key)
  if (hit !== undefined) return hit
  const raw = Buffer.from(GOLDEN['sxm_files'][key] as string, 'base64')
  const or = sxmOrientedFrames(readSxm(raw), key === 'current_only' ? 'Current' : 'Z')
  const out = { fwd: or.forward as Mat, bwd: or.backward, nmPerPx: or.nm_per_px }
  framesCache.set(key, out)
  return out
}

/** 逐条比一棵树；`tol` 必须来自被测件自己导出的容差。 */
function expectTree(actual: unknown, want: unknown, tol: number, scales = scalesOf(want)): void {
  const ms = diffTree(toGolden(actual), want, tol, scales)
  expect(ms.length === 0 || formatMismatches(ms)).toBe(true)
}

/**
 * `measureFrame` 的缓存 —— **同一张帧、同一种 `bwd` 选择只量一次**。
 *
 * 不是优化：这个文件里有一百多处要同一份 `FrameMetrics`（`plan_for` /
 * `apply_flatten` / `harmonise` 各自都要），而每一次都是一整套
 * `assessAtomicPhase` + `detectTipChange` + `detectScanArtifacts`。
 * 不缓存时这个文件把 CPU 占满，**同一个 worker 池里批 4b 那条 4.2 s 的
 * `AssessAtomicResolution > hex` 就会撞上 vitest 5 s 的缺省预算** ——
 * 而一次超时会让 `run.ts` 的基线判脏、**整趟演练拒跑**（green-8 §3.4 第 1 条）。
 * 「挂住 ≠ 通过」的另一面：**别人的预算也是我的责任**。
 */
const metricsCache = new Map<string, FrameMetrics>()
function metricsOf(key: string, useBwd: boolean): FrameMetrics {
  const ck = `${key}|${useBwd ? 'bwd' : 'no'}`
  const hit = metricsCache.get(ck)
  if (hit !== undefined) return hit
  const f = key === 'shape_mismatch' ? frameOf('plane') : frameOf(key)
  const bwd =
    key === 'shape_mismatch'
      ? matOf(64, f.fwd.cols, f.fwd.data.slice(0, 64 * f.fwd.cols))
      : useBwd
        ? f.bwd
        : null
  const m = measureFrame(f.fwd, { bwd, nmPerPx: f.nmPerPx, thresholds: TH })
  metricsCache.set(ck, m)
  return m
}

function head(m: Mat, rows: number, cols: number): number[][] {
  const out: number[][] = []
  for (let r = 0; r < rows; r += 1) {
    const row: number[] = []
    for (let c = 0; c < cols; c += 1) row.push(m.data[r * m.cols + c] as number)
    out.push(row)
  }
  return out
}

// ── 1. scipy.ndimage 的三件（容差 0） ─────────────────────────────────────

describe('scipy.ndimage 的三件', () => {
  it('`uniform_filter1d` 是**跑动和** —— 一个 NaN 污染这一行的每一个后继输出', () => {
    // scipy 实测（`uniform_filter1d(arange(20) 第 5 位换成 nan, 5)`）：
    // 下标 0..2 有值，下标 3 起 **17 个全是 NaN**。窗口里有 NaN 本来只该影响 5 个。
    const x = new Float64Array(20)
    for (let i = 0; i < 20; i += 1) x[i] = i
    x[5] = NaN
    const y = uniformFilter1d(x, 5, 'reflect')
    expect(y[0]).toBe(0.8)
    expect(y[1]).toBe(1.2)
    expect(y[2]).toBe(2.0)
    for (let i = 3; i < 20; i += 1) expect(Number.isNaN(y[i] as number)).toBe(true)
  })

  it('`uniform_filter` 的 size 1 那一轴是恒等（scipy 跳过 size ≤ 1 的轴）', () => {
    const m = matOf(3, 4, Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))
    const got = uniformFilter2d(m, 1, 3)
    // scipy 实测 `uniform_filter(b, (1,3))` 的第一行：[1/3, 1, 2, 8/3]
    expect(got.data[0]).toBeCloseTo(1 / 3, 15)
    expect(got.data[1]).toBe(1)
    expect(got.data[2]).toBe(2)
    expect(got.data[3]).toBeCloseTo(8 / 3, 15)
  })

  it('`median_filter` 偶数窗取**上**中位（rank = size/2），不是两个中位数的平均', () => {
    // scipy 实测 `median_filter([0,9,1,2,8,3,4,5], size=4, mode='reflect')`。
    const x = Float64Array.from([0, 9, 1, 2, 8, 3, 4, 5])
    expect(Array.from(medianFilter1d(x, 4, 'reflect'))).toEqual([9, 1, 2, 8, 3, 4, 5, 5])
    // 奇数窗（size 3）在 reflect 与 nearest 下这一串恰好相同 —— 两种模式都钉住。
    expect(Array.from(medianFilter1d(x, 3, 'reflect'))).toEqual([0, 1, 2, 2, 3, 4, 4, 5])
    expect(Array.from(medianFilter1d(x, 3, 'nearest'))).toEqual([0, 1, 2, 2, 3, 4, 4, 5])
  })

  it('`median_filter` 二维 3×3', () => {
    const b = matOf(3, 3, Float64Array.from([0, 1, 2, 3, 100, 5, 6, 7, 8]))
    expect(Array.from(medianFilter2d(b, 3, 'reflect').data)).toEqual([1, 2, 2, 3, 5, 5, 6, 7, 8])
  })
})

// ── 2. 基本量 ─────────────────────────────────────────────────────────────

describe('基本量（poly_subtract / line_subtract / row_correlation / …）', () => {
  for (const row of GOLDEN['primitives'] as any[]) {
    it(`${row.frame}`, () => {
      const { fwd, nmPerPx } = frameOf(row.frame)
      const p1 = polySubtract(fwd, 1)
      const p2 = polySubtract(fwd, 2)
      const ln = lineSubtract(fwd, 1)
      expectTree(nanStd(p1.data), row.poly1_std, FLATTEN_REL_TOL)
      expectTree(nanStd(p2.data), row.poly2_std, FLATTEN_REL_TOL)
      expectTree(nanStd(ln.data), row.line_std, FLATTEN_REL_TOL)
      expectTree(head(p1, 2, 6), row.poly1_head, FLATTEN_REL_TOL)
      expectTree(head(p2, 2, 6), row.poly2_head, FLATTEN_REL_TOL)
      expectTree(head(ln, 2, 6), row.line_head, FLATTEN_REL_TOL)
      const rc = rowCorrelation(ln)
      expectTree(Array.from(rc.slice(0, 8)), row.row_corr_head, FLATTEN_REL_TOL)
      // 下标与计数：**容差 0**。
      expect(acquiredRowSpan(fwd)).toEqual(row.acquired_row_span)
      const lv = heightLevels(p1)
      expect(lv.nPeaks).toBe(row.height_levels.n_peaks)
      expectTree(lv.separation, row.height_levels.separation, FLATTEN_REL_TOL)
      expectTree(lv.rowPurity, row.height_levels.row_purity, 0)
      expectTree(foldedPeak(finePeriodicPeak(ln, nmPerPx ?? 0, TH)), toCamelPeak(row.fine_peak), FINE_PEAK_REL_TOL)
    })
  }
})

/**
 * 把金样的峰摆成本仓的形状，**并把角度折到 `(−90, 90]`**。
 *
 * ## 为什么必须折（这是一条 deviation，不是测试写松了）
 *
 * 输入是实数帧，所以谱满足 `|F(−k)| = |F(k)|` —— 在精确算术里 ±k 那一对是一个
 * **精确的平局**，而 `np.argmax` / 本仓的扫描都取「先遇到的最大值」。
 * 谁先到手完全由那一对的**最后一位浮点**决定，而两边的 FFT 是两个实现。
 * 实测：同一张 `axis_wave` 上一边 `+63.435°`、一边 `−116.565°` —— **差正好 180°**，
 * 也就是同一条周期结构的两个等价法向。
 *
 * `snr` 与 `period_nm` 对 ±k **完全相同**，所以只有角度要折。
 * 同 D-LATTICE-1（批 4b 对孪生峰的处置），理由一字不差。
 */
function toCamelPeak(p: any): unknown {
  return { snr: p.snr, periodNm: p.period_nm, angleDeg: foldAngle(p.angle_deg as number) }
}

/** 折到 `(−90, 90]`。 */
function foldAngle(a: number): number {
  if (!Number.isFinite(a)) return a
  let x = a
  while (x > 90) x -= 180
  while (x <= -90) x += 180
  return x
}

/** 本仓这一侧同样折一次（两边用同一个函数，不给容差留活口）。 */
function foldedPeak(p: { snr: number; periodNm: number; angleDeg: number }): unknown {
  return { snr: p.snr, periodNm: p.periodNm, angleDeg: foldAngle(p.angleDeg) }
}

describe('主 terrace 掩膜', () => {
  for (const row of GOLDEN['terrace_mask'] as any[]) {
    it(`${row.frame}`, () => {
      const { fwd } = frameOf(row.frame)
      const m = metricsOf(row.frame as string, false)
      expectTree(m.roughness, row.roughness, FLATTEN_REL_TOL)
      expectTree(m.separation, row.separation, FLATTEN_REL_TOL)
      const base = rowMedianLevel(polySubtract(fwd, 1))
      const mask = dominantTerraceMask(base, m.roughness, m.separation)
      // 掩膜是**布尔**：容差 0。
      let n = 0
      for (let i = 0; i < mask.length; i += 1) n += mask[i] as number
      expect(n).toBe(row.n_true)
      const perRow: number[] = []
      for (let r = 0; r < 12; r += 1) {
        let k = 0
        for (let c = 0; c < fwd.cols; c += 1) k += mask[r * fwd.cols + c] as number
        perRow.push(k)
      }
      expect(perRow).toEqual(row.row_counts)
    })
  }
})

describe('受限带 FFT 峰 —— 轴向死区那道闸的两侧', () => {
  for (const [i, row] of (GOLDEN['fine_peak'] as any[]).entries()) {
    it(`${row.frame}${row.guard_deg === undefined ? '' : ` guard=${String(row.guard_deg)}`}`, () => {
      const { fwd, nmPerPx } = frameOf(row.frame)
      const th = row.guard_deg === undefined ? TH : { ...SCAN_PREP_DEFAULTS, axisGuardDeg: row.guard_deg as number }
      expectTree(
        foldedPeak(finePeriodicPeak(lineSubtract(fwd, 1), nmPerPx ?? 0, th)),
        toCamelPeak(row.peak),
        FINE_PEAK_REL_TOL,
      )
      expect(i).toBeGreaterThanOrEqual(0)
    })
  }

  it('死区真的在做决定：同一张 0° 的帧，20° 死区挡住它、5° 死区放它进来', () => {
    const wide = (GOLDEN['fine_peak'] as any[]).find((r) => r.frame === 'axis_wave' && r.guard_deg === undefined)
    const narrow = (GOLDEN['fine_peak'] as any[]).find((r) => r.frame === 'axis_wave' && r.guard_deg === 5.0)
    // 一格分辨不出两种候选的金样不是判据：这两格必须**跨过** `finePeriodicSnr` 那条线。
    expect(wide.peak.snr).toBeLessThan(TH.finePeriodicSnr)
    expect(narrow.peak.snr).toBeGreaterThan(TH.finePeriodicSnr)
  })
})

// ── 3. 转发判据本体 ───────────────────────────────────────────────────────

describe('detectScanArtifacts', () => {
  for (const row of GOLDEN['scan_artifacts'] as any[]) {
    it(`${row.frame}${row.with_bwd === true ? ' (带反扫)' : ''}`, () => {
      const f = frameOf(row.frame)
      const got = detectScanArtifacts(f.fwd, row.with_bwd === true ? f.bwd : null)
      const want = parseArtifacts(row.result as string)
      // 布尔与计数比：**容差 0**。
      expect(got.hasArtifact).toBe(want.has_artifact)
      expect(got.oscillation).toBe(want.oscillation)
      expect(got.badRowFrac).toBe(want.bad_row_frac)
      expect(got.spikeFrac).toBe(want.spike_frac)
      expect(got.oscillationCyclesPerLine).toBe(want.oscillation_cycles_per_line)
      expect(got.driftPx).toBe(want.drift_px)
      // 两个 float32 FFT 极大之比。
      expectTree(got.oscillationSeverity, want.oscillation_severity, OSC_REL_TOL)
    })
  }

  it('`badRowFrac` 那条抄近道与整份逐位相同（不靠人记得，靠一条断言）', () => {
    for (const row of GOLDEN['scan_artifacts'] as any[]) {
      const f = frameOf(row.frame)
      expect(badRowFrac(f.fwd)).toBe(detectScanArtifacts(f.fwd).badRowFrac)
    }
  })

  it('早退那一支的 0 是「**没算**」：死平帧的 `driftPx` 是 `null` 不是 0', () => {
    const f = frameOf('dead_flat')
    const got = detectScanArtifacts(f.fwd, f.fwd)
    expect(got.driftPx).toBeNull()
    expect(got.badRowFrac).toBe(0)
  })
})

/** 旧仓 pydantic 模型的 `str()` —— 金样里存的是那一行。 */
function parseArtifacts(s: string): Record<string, any> {
  const out: Record<string, any> = {}
  for (const m of s.matchAll(/(\w+)=(True|False|None|[-\d.e+]+)/g)) {
    const k = m[1] as string
    const v = m[2] as string
    out[k] = v === 'True' ? true : v === 'False' ? false : v === 'None' ? null : Number(v)
  }
  return out
}

describe('detectTipChange', () => {
  for (const row of GOLDEN['tip_change'] as any[]) {
    const label = `${row.frame}${row.nm_per_px === undefined ? '' : ` nmpp=${String(row.nm_per_px)}`}${
      row.threshold === undefined ? '' : ` tau=${String(row.threshold)}`
    }`
    it(label, () => {
      const f = frameOf(row.frame)
      const nmPerPx = row.nm_per_px === undefined ? f.nmPerPx : (row.nm_per_px as number)
      const got = detectTipChange(f.fwd, { nmPerPx, threshold: row.threshold ?? null })
      const want = parseTipChange(row.result as string)
      // 判决、行号、表名、阈值：**容差 0**。
      expect(got.changed).toBe(want.changed)
      expect(got.changeRow).toBe(want.change_row)
      expect(got.calib).toBe(want.calib)
      expect(got.threshold).toBe(want.threshold)
      expect(got.method).toBe('v2cal-lagk')
      expectTree(got.score, want.score, TIP_CHANGE_REL_TOL)
      expectTree(got.lod, want.lod, TIP_CHANGE_REL_TOL)
      expectTree(got.channelScores, want.channel_scores, TIP_CHANGE_REL_TOL)
    })
  }

  it('逐行通道与 `lod_dc`', () => {
    for (const row of GOLDEN['tip_change'] as any[]) {
      if (row.channels === undefined) continue
      const f = frameOf(row.frame)
      const { channels, bragg } = rowChannels(f.fwd)
      expect(bragg !== null).toBe(row.has_bragg)
      for (const [k, want] of Object.entries(row.channels as Record<string, number[]>)) {
        const got = channels[k]
        expect(got !== undefined || `缺通道 ${k}`).toBe(true)
        expectTree(Array.from((got as Float64Array).slice(0, 6)), want, TIP_CHANGE_REL_TOL)
      }
      expectTree(lodDc(channels['dc'] as Float64Array), row.lod_dc, TIP_CHANGE_REL_TOL)
    }
  })

  it('**`tr` 通道没有移** —— 而这里要说得出它不在（消融精神，不是漏了）', () => {
    // 消费方 `measureFrame` 给的是**一帧**，`tr` 在旧仓这条路上也从来没跑过。
    for (const row of GOLDEN['tip_change'] as any[]) {
      if (row.channels === undefined) continue
      expect(Object.keys(row.channels as Record<string, unknown>)).not.toContain(TIP_CHANGE_TR_NOT_PORTED)
    }
  })
})

function parseTipChange(s: string): Record<string, any> {
  const scores: Record<string, number> = {}
  const cs = /channel_scores=\{([^}]*)\}/.exec(s)
  if (cs !== null && cs[1] !== undefined) {
    for (const m of cs[1].matchAll(/'(\w+)': ([-\d.e+]+)/g)) scores[m[1] as string] = Number(m[2])
  }
  const pick = (k: string): string | null => {
    const m = new RegExp(`\\b${k}=(True|False|None|'[^']*'|[-\\d.e+]+)`).exec(s)
    return m === null ? null : (m[1] as string)
  }
  const num = (k: string): number | null => {
    const v = pick(k)
    return v === null || v === 'None' ? null : Number(v)
  }
  return {
    changed: pick('changed') === 'True',
    change_row: num('change_row'),
    score: num('score'),
    threshold: num('threshold'),
    lod: num('lod'),
    calib: (pick('calib') ?? '').replace(/'/g, ''),
    channel_scores: scores,
  }
}

describe('fwdBwdInstability', () => {
  for (const row of GOLDEN['fb_instability'] as any[]) {
    it(`${row.frame}`, () => {
      let a: Mat
      let b: Mat
      if (row.frame === 'self') {
        a = frameOf('plane').fwd
        b = a
      } else if (row.frame === 'dead_flat_self') {
        a = frameOf('dead_flat').fwd
        b = a
      } else {
        const f = frameOf(row.frame)
        a = f.fwd
        b = f.bwd as Mat
      }
      const got = fwdBwdInstability(a, b)
      expect(Math.abs(got - (row.value as number)) <= FB_INSTABILITY_ABS_TOL || `${got} vs ${String(row.value)}`).toBe(
        true,
      )
    })
  }

  it('那道除零守卫是 `1e−30` 而不是 `1e−9`：**换一个单位，答案不许换一边**', () => {
    // 2026-08-10 的那条：**一道绝对阈值卡在物理量上就是个 bug**。
    // `na` 是去趋势后的范数，数据以米计 ⇒ `na ≈ n_px × 起伏RMS`，
    // 于是旧的 1e−9 守卫让答案取决于**帧有多少像素**和**数据用什么单位**。
    // 这一格把同一份内容按 ×1e−9 / ×1 / ×1e9 各算一遍：
    //   ① 三个答案必须落在同一个容差里（**判据与量纲无关**）；
    //   ② 一个都不许是 1.0 —— 1.0 正是那道守卫触发时的返回值，
    //      而它落在判决阈值（0.50）的**拒绝一侧**：越平越小的好帧越会被判「针尖坏」。
    // ⚠️ 不要求逐位相同：`detrend32` 会把结果量化到 float32，换一个标度
    // 落在不同的 float32 上 —— 那是精度，不是判据。
    const a = frameOf('plane').fwd
    const b = frameOf('pair_ok').bwd as Mat
    const scale = (m: Mat, k: number): Mat => matOf(m.rows, m.cols, m.data.map((v) => v * k))
    const vals = [1e-9, 1, 1e9].map((k) => fwdBwdInstability(scale(a, k), scale(b, k)))
    for (const v of vals) {
      expect(v).not.toBe(1.0)
      expect(Math.abs(v - (vals[1] as number))).toBeLessThanOrEqual(FB_INSTABILITY_ABS_TOL)
    }
  })
})

// ── 4. measure / plan / apply / harmonise ────────────────────────────────

describe('measureFrame', () => {
  for (const row of GOLDEN['measure_frame'] as any[]) {
    it(`${row.frame}`, () => {
      // `shape_mismatch` 这一格**走不了 .sxm**（同一份头描述两块，形状必然一致），
      // 它是 `delegate_errors['fb_instability']` 那一支唯一的输入 —— 见 `metricsOf`。
      const m = metricsOf(row.frame as string, true)
      const w = row.metrics
      // 计数、下标、形状：**容差 0**。
      expect([...m.shape]).toEqual(w.shape)
      expect([...m.analysisRows]).toEqual(w.analysis_rows)
      expect(m.deadRows).toBe(w.dead_rows)
      expect(m.nPeaks).toBe(w.n_peaks)
      expect(m.nanFrac).toBe(w.nan_frac)
      expectTree(m.rowPurity, w.row_purity, 0)
      expectTree(m.nmPerPx, w.nm_per_px, 0)
      // 残差派生量。
      for (const [got, want] of [
        [m.planeRmsPm, w.plane_rms_pm],
        [m.lineGain, w.line_gain],
        [m.bowGain, w.bow_gain],
        [m.roughnessPm, w.roughness_pm],
        [m.stepSepPm, w.step_sep_pm],
        [m.sepOverRough, w.sep_over_rough],
        [m.rowcorrMedian, w.rowcorr_median],
      ] as const) {
        expectTree(got, want, FLATTEN_REL_TOL)
      }
      expectTree(m.finePeriodicSnr, w.fine_periodic_snr, FINE_PEAK_REL_TOL)
      expectTree(m.finePeriodNm, w.fine_period_nm, FINE_PEAK_REL_TOL)
      // ±k 孪生峰：角度差 180° 是同一条结构的两个等价法向，见 `toCamelPeak`。
      expectTree(foldAngle(m.fineAngleDeg), foldAngle(w.fine_angle_deg as number), FINE_PEAK_REL_TOL)
      // 转发判据的摘要（原文与布尔零容差，数值走各自的容差）。
      expect(m.delegateErrors).toEqual(w.delegate_errors)
      if (w.atomic === null) expect(m.atomic).toBeNull()
      else {
        expect(m.atomic?.passed).toBe(w.atomic.passed)
        expect(m.atomic?.scale).toBe(w.atomic.scale)
        expect([...(m.atomic?.reasons ?? [])]).toEqual(w.atomic.reasons)
        expect([...(m.atomic?.warnings ?? [])]).toEqual(w.atomic.warnings)
      }
      expect(m.tipChange?.changed).toBe(w.tip_change.changed)
      expect(m.tipChange?.change_row).toBe(w.tip_change.change_row)
      expect(m.artifacts?.has_artifact).toBe(w.artifacts.has_artifact)
      expect(m.artifacts?.oscillation).toBe(w.artifacts.oscillation)
      expect(m.artifacts?.bad_row_frac).toBe(w.artifacts.bad_row_frac)
      expect(m.artifacts?.spike_frac).toBe(w.artifacts.spike_frac)
      expect(m.artifacts?.drift_px).toBe(w.artifacts.drift_px)
      // **绝对**容差（`1 − max_ncc` 是一次相消）—— 所以不走按值归一的 `expectTree`。
      if (w.fb_instability === null) expect(m.fbInstability).toBeNull()
      else expect(Math.abs((m.fbInstability as number) - (w.fb_instability as number))).toBeLessThanOrEqual(FB_INSTABILITY_ABS_TOL)
    })
  }
})

describe('planFor —— 判决与原文，容差 0', () => {
  for (const [i, row] of (GOLDEN['plan_for'] as any[]).entries()) {
    it(`${row.frame}${row.override === null ? '' : ` override=${String(row.override)}`}`, () => {
      const m = metricsOf(row.frame as string, row.override === null)
      const plan = planFor(m, TH, row.override as string | null)
      const w = row.plan
      expect(plan.method).toBe(w.method)
      expect([...plan.clip]).toEqual(w.clip_percentile)
      expect(plan.stepLike).toBe(w.step_like)
      expect(plan.fineStructure).toBe(w.fine_structure)
      expect(plan.profile).toBe(w.threshold_profile)
      expect(plan.provenance).toBe(w.threshold_provenance)
      expect([...plan.why]).toEqual(w.why)
      expect([...plan.notes]).toEqual(w.notes)
      expect(i).toBeGreaterThanOrEqual(0)
    })
  }

  it('override 不认识就抛（**四个合法值之外一律拒**）', () => {
    const m = metricsOf('plane', false)
    expect(() => planFor(m, TH, 'nope')).toThrow()
    expect(GOLDEN['plan_override_error']).toContain('nope')
  })

  it('四条平场分支与三档色阶**每一条都有输入**（覆盖率答不出这件事）', () => {
    const auto = (GOLDEN['plan_for'] as any[]).filter((r) => r.override === null)
    const methods = new Set(auto.map((r) => r.plan.method as string))
    expect([...methods].sort()).toEqual(['line', 'masked_line', 'plane', 'poly2'])
    const clips = new Set(auto.map((r) => JSON.stringify(r.plan.clip_percentile)))
    expect(clips.size).toBe(3)
    // 「精细结构优先于台阶」那条纪律：要有**一格两者同时为真**，否则优先级没被验过。
    expect(auto.some((r) => r.plan.fine_structure === true && r.plan.step_like === true)).toBe(true)
    // 「行向分层不是台阶」那句话：要有一格 multilevel 而 `step_like` 为假。
    expect(auto.some((r) => (r.plan.notes as string[]).some((n) => n.includes('行向分层')))).toBe(true)
  })
})

describe('applyFlatten', () => {
  for (const [i, row] of (GOLDEN['apply_flatten'] as any[]).entries()) {
    it(`${row.frame} → ${row.method}`, () => {
      const f = frameOf(row.frame)
      const m = metricsOf(row.frame as string, row.percentiles !== undefined)
      const flat = applyFlatten(f.fwd, row.method as string, m)
      expectTree(nanStd(flat.data), row.std, FLATTEN_REL_TOL)
      expectTree(head(flat, 2, 6), row.head, FLATTEN_REL_TOL)
      expect(i).toBeGreaterThanOrEqual(0)
    })
  }
})

describe('harmoniseBatch', () => {
  const plansOf = (keys: readonly string[], keyer: (i: number) => string): Array<readonly [string, FlattenPlan]> =>
    keys.map((k, i) => [keyer(i), planFor(metricsOf(k, false), TH)] as const)
  const GROUP = ['g_line_a', 'g_line_b', 'g_plane', 'g_steps']

  it('多数票 —— 而**有真台阶的帧既不投票也不被改**', () => {
    const w = (GOLDEN['harmonise_batch'] as any[]).find((r) => r.case === 'majority_wins')
    const before = plansOf(GROUP, () => 'g')
    expect(before.map(([, p]) => p.method)).toEqual(w.before)
    const after = harmoniseBatch(before, TH)
    expect(after.map((p) => p.method)).toEqual(w.after)
    // 被改的那一张，`why` 的最后一句必须说清**为什么改**（这一句是它的产品）。
    const changed = after.findIndex((p, i) => p.method !== (before[i] as any)[1].method)
    expect(changed).toBeGreaterThanOrEqual(0)
    expect(after[changed]?.why.at(-1)).toContain('批次一致性')
    // 台阶那一张一个字都没动。
    expect(after[3]?.method).toBe('masked_line')
    expect(after[3]?.why.at(-1)).not.toContain('批次一致性')
  })

  it('不足 `groupMin` ⇒ 不投票', () => {
    const w = (GOLDEN['harmonise_batch'] as any[]).find((r) => r.case === 'below_group_min')
    const before = plansOf(['g_line_a', 'g_plane'], () => 'g')
    expect(harmoniseBatch(before, TH).map((p) => p.method)).toEqual(w.after)
  })

  it('全票一致 ⇒ 一个字都不加（`nWin === methods.length` 那一支）', () => {
    const w = (GOLDEN['harmonise_batch'] as any[]).find((r) => r.case === 'unanimous')
    const before = plansOf(['g_line_a', 'g_line_b', 'g_line_a'], () => 'g')
    const after = harmoniseBatch(before, TH)
    expect(after.map((p) => p.method)).toEqual(w.after)
    expect(after.map((p) => p.why.length)).toEqual(w.why_len)
  })

  it('**可投票的那一半**不足 `groupMin` ⇒ 不投票（第一道闸拦不住这一格）', () => {
    // 四张同组：两张台阶帧豁免 ⇒ 可投票的只剩两张。`idx.length = 4 ≥ 3` 过得去，
    // 只有 `free.length = 2 < 3` 拦得住。别的用例都被第一道先挡掉了 ——
    // **那道闸于是从不做决定**，演练第一轮正是在这里报的绿。
    const w = (GOLDEN['harmonise_batch'] as any[]).find((r) => r.case === 'free_below_quorum')
    const before = plansOf(['g_line_a', 'g_plane', 'g_steps', 'g_steps'], () => 'g')
    expect(before.map(([, p]) => p.method)).toEqual(w.before)
    expect(harmoniseBatch(before, TH).map((p) => p.method)).toEqual(w.after)
  })

  it('两个分组键 ⇒ 各自不足 `groupMin`', () => {
    const w = (GOLDEN['harmonise_batch'] as any[]).find((r) => r.case === 'two_keys')
    const before = plansOf(['g_line_a', 'g_line_b', 'g_plane'], (i) => (i < 2 ? 'a' : 'b'))
    expect(harmoniseBatch(before, TH).map((p) => p.method)).toEqual(w.after)
  })
})

// ── 5. 阈值 profile ───────────────────────────────────────────────────────

describe('ScanPrepThresholds', () => {
  it('内建 profile 的每一个数值字段与旧仓逐位相同', () => {
    const want = GOLDEN['thresholds'].numeric_mapping as Record<string, number>
    expect(scanPrepNumericMapping(TH)).toEqual(want)
    // 可空字段**没填时整个键不出现** —— 「没标定」与「标成 0」是两件事。
    expect(Object.keys(want)).not.toContain('corrugation_high_pm')
    expect(TH.corrugationHighPm).toBeNull()
  })

  it('名字不认识 ⇒ 回落到默认，**并把这件事写进 provenance**', () => {
    const got = resolveScanPrepThresholds('no-such-profile')
    const want = GOLDEN['thresholds'].unknown_name as Record<string, unknown>
    expect(got.name).toBe(want['name'])
    expect(got.provenance).toBe(want['provenance'])
  })

  for (const row of GOLDEN['thresholds'].from_mapping as any[]) {
    it(`from_mapping: ${row.case}`, () => {
      const { th, dropped } = scanPrepFromMapping(row.mapping as Record<string, unknown>)
      const want = row.result as Record<string, unknown>
      // 逐字段比 —— 键名两侧不同（camel vs snake），所以按值对齐。
      const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
      for (const [k, v] of Object.entries(th)) expect([k, v]).toEqual([k, want[snake(k)]])
      // 丢弃的那一支**要说出来**：静默丢弃与夹紧一样看不出来。
      const isDrop = row.case === 'drops_nullable_out_of_range' || row.case === 'non_numeric_dropped'
      expect(dropped.length > 0).toBe(isDrop)
    })
  }

  it('两种越界处理**并存**：既有字段夹紧，可空字段丢弃', () => {
    const clamp = scanPrepFromMapping({ lineGain: 0.5 })
    expect(clamp.th.lineGain).toBe(1.0) // 夹到下界
    expect(clamp.dropped).toEqual([])
    const drop = scanPrepFromMapping({ corrugationHighPm: 0.0 })
    expect(drop.th.corrugationHighPm).toBeNull() // **不是** 0.1
    expect(drop.dropped.length).toBe(1)
  })
})

// ── 6. 结构性判据（不比金样，证明金样自己有鉴别力） ────────────────────────

describe('金样自己有没有鉴别力', () => {
  it('把帧抖 `1e−12` 相对量，`fine_periodic_peak` 的峰位一个都不动', () => {
    // `argmax` 是离散判据，而「这一格的答案不是掷骰子」这件事只能这么证
    // （同批 4b `lattice.test.ts` 那一条）。抖动量比 `fftRelTol(128²)` 大三个量级。
    for (const key of ['lattice', 'axis_wave', 'steps_flat']) {
      const { fwd, nmPerPx } = frameOf(key)
      const base = finePeriodicPeak(lineSubtract(fwd, 1), nmPerPx ?? 0, TH)
      const jittered = matOf(
        fwd.rows,
        fwd.cols,
        fwd.data.map((v, i) => v * (1 + 1e-12 * (i % 2 === 0 ? 1 : -1))),
      )
      const got = finePeriodicPeak(lineSubtract(jittered, 1), nmPerPx ?? 0, TH)
      expect(got.periodNm).toBeCloseTo(base.periodNm, 9)
      expect(foldAngle(got.angleDeg)).toBeCloseTo(foldAngle(base.angleDeg), 9)
    }
  })

  it('`dead_flat` **刻意不进** measure/plan 那几节 —— 它的答案是掷骰子', () => {
    // 扣平面之后只剩浮点舍入（~1e−25），两边的最小二乘是两个算法。
    // 批 4a §9①：一个答案是掷骰子的用例不是判据，修法是**改输入**。
    const frames = (GOLDEN['measure_frame'] as any[]).map((r) => r.frame as string)
    expect(frames).not.toContain('dead_flat')
    expect(frames).toContain('near_flat')
    // 而它在**两条早退**那几节里在，因为那两支是确定的。
    expect((GOLDEN['scan_artifacts'] as any[]).map((r) => r.frame)).toContain('dead_flat')
    expect((GOLDEN['tip_change'] as any[]).map((r) => r.frame)).toContain('dead_flat')
    const f = frameOf('dead_flat')
    expect(npStd(f.fwd.data)).toBe(0)
  })

  it('伪影那三件**真的跑过** —— 而不是被 `std < 1e-9` 那道早退全挡在门外', () => {
    // D-SCANART-1：Z 以米计，真机上这条早退几乎总是成立。
    // 所以必须有 nm 级起伏的帧，否则 `_oscillation`/`_drift_px`/`_spike_frac`
    // 移过来就是三段没有闸的代码（批 4b §9② 的形状）。
    const rows = GOLDEN['scan_artifacts'] as any[]
    const parsed = rows.map((r) => parseArtifacts(r.result as string))
    expect(parsed.some((p) => p.oscillation === true)).toBe(true)
    expect(parsed.some((p) => p.oscillation === false && p.oscillation_severity > 0)).toBe(true)
    expect(parsed.some((p) => p.spike_frac > 0.02)).toBe(true)
    expect(parsed.some((p) => p.spike_frac > 0 && p.spike_frac <= 0.02)).toBe(true)
    expect(parsed.some((p) => p.bad_row_frac > 0.05)).toBe(true)
    expect(parsed.some((p) => p.bad_row_frac > 0 && p.bad_row_frac <= 0.05)).toBe(true)
    expect(parsed.some((p) => p.drift_px !== null && p.drift_px > 3)).toBe(true)
    expect(parsed.some((p) => p.drift_px === 0)).toBe(true)
  })

  it('针尖突变的**两张空库**都有输入，而且判决两侧都有', () => {
    const rows = (GOLDEN['tip_change'] as any[]).map((r) => parseTipChange(r.result as string))
    expect(rows.some((r) => r.calib === 'vigil-c1')).toBe(true)
    expect(rows.some((r) => r.calib === 'vigil-c2')).toBe(true)
    expect(rows.some((r) => r.changed === true)).toBe(true)
    expect(rows.some((r) => r.changed === false && r.lod !== null)).toBe(true)
    expect(rows.some((r) => r.lod === null)).toBe(true)
  })
})
