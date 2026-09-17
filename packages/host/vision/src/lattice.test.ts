/**
 * 晶格判据底座对 `spec/golden/lattice.json` 的逐条比对（批 4b）。
 *
 * **容差不在这个文件里**：每一条都引用被测件自己导出的那个容差
 * （`latticePeakRelTol` / `CELL_REL_TOL` / `TEXTURE_REL_TOL` / `BAND_PEAK_REL_TOL` /
 * `flattenAbsTol` / `DETREND_ULP_TOL` / `fftSharpnessRelTol` / `CONC_REL_TOL` /
 * `coherentAbsTol`），理由写在那些件的 docstring 里。**这里没有一个字面量容差。**
 *
 * 实测占比（本机 2026-09-16，每一条的最坏那一格）：峰表 `2.1e−2`（`rect_weak.power`）·
 * 原胞 `5.8e−5` · 纹理 `1.4e−5` · 去背景 `1.1e−4` · 带内取峰 `5.0e−4` ·
 * 角向集中度 `8.0e−4` · FFT 锐度 `2.9e−2` · 超结构 `3.7e−7`。
 * **一条没人量过的容差只是一个数**（`numerics-3.md` 第二节）。
 *
 * 帧一律**从 `.sxm` 的字节读回来** —— 两边各自重建同一个输入本身就是一处
 * 没有人在看的差异（批 4a 那条 `noiseFloor` 4.4e−14）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matOf, type Mat } from 'dsh-spm-numerics'
import { checkAtomicWindow } from 'dsh-spm-kernel'
import { readSxm, sxmOrientedFrames } from 'dsh-spm-nanonis-files'
import { diffTree, formatMismatches, fromGolden, scalesOf, toGolden } from './golden.js'
import { findLatticePeaks, firstOrderPeriodNm, latticePeakRelTol, type LatticeResult } from './lattice-peaks.js'
import {
  CELL_REL_TOL,
  coherentAbsTol,
  coherentScale,
  combineUpDown,
  measureCell,
  superstructureTest,
  type CellResult,
} from './lattice-cell.js'
import {
  latticeAmplitudePm,
  streakAmplitudePm,
  TEXTURE_REL_TOL,
  tileLatticeMap,
  type TileLatticeMap,
} from './frame-texture.js'
import { BAND_PEAK_REL_TOL, detectTexture, flattenAbsTol, flattenRobust } from './seg-texture.js'
import {
  DETREND_ULP_TOL,
  HAS_LATTICE_SHARP,
  detrend32,
  fftSharpness,
  fftSharpnessRelTol,
} from './tip-metrics.js'
import {
  angularConcentration,
  assessAtomicPhase,
  CONC_REL_TOL,
  fastAxisPeriodNm,
  orderRatio,
  scaleGate,
  type AtomicPhaseResult,
} from './atomic-phase.js'
import { npStd } from 'dsh-spm-numerics'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/lattice.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const COND = GOLDEN['condition_numbers'] as Record<string, number>

/** 把一份金样里的 `.sxm` 字节解回定向后的正扫帧。 */
const framesCache = new Map<string, { fwd: Mat; nmPerPx: number }>()
function frameOf(key: string): { fwd: Mat; nmPerPx: number } {
  const hit = framesCache.get(key)
  if (hit) return hit
  const raw = Buffer.from(GOLDEN['sxm_files'][key] as string, 'base64')
  const scan = readSxm(raw)
  const or = sxmOrientedFrames(scan, key === 'current_only' ? 'Current' : 'Z')
  const out = { fwd: or.forward as Mat, nmPerPx: or.nm_per_px as number }
  framesCache.set(key, out)
  return out
}

/** 逐条比一棵树；`tol` 必须来自被测件自己导出的容差。 */
function expectTree(actual: unknown, want: unknown, tol: number, scales = scalesOf(want)): void {
  const ms = diffTree(toGolden(actual), want, tol, scales)
  expect(ms.length === 0 || formatMismatches(ms)).toBe(true)
}

/**
 * 把一个峰折到**上半平面代表元**上。
 *
 * ## 为什么必须折（这是一条 deviation，不是测试写松了）
 *
 * 实信号的谱满足 `|F(−k)| = |F(k)|` —— **在精确算术里 ±k 那一对是一个精确的平局**，
 * 而 `np.argmax` 的平局规则是「取 C 序里第一个」。于是**谁排在前面完全由
 * 那一对的最后一位浮点决定**：
 *
 * * 金样 `hex` 的第一对功率**逐位相同**（`0x1.25d0cc830519dp-22` ×2）⇒ numpy
 *   取了 C 序靠前的 `kx = −15`；
 * * 同一格的**第三对**在 numpy 自己那儿就差一个 ulp
 *   （`…cec75` vs `…cec74`）—— 也就是说 **numpy 也不保证这个对称**；
 * * 本仓的 `fft2` 在第一对上差一个 ulp，于是取了 `kx = +15`。
 *
 * 这是 D-NUM-18 的形状：「**一格答案本身没有定义的金样更糟**」。
 * 下游没有一个消费方看得见这个差别 —— `uniq` 按 `angle mod 180` 去重、
 * `measureCell` 把候选折到上半平面、半径散布取 `hypot` —— 所以本仓**不去追**它，
 * 而是把比对做在定义得出来的那一侧：折叠之后的峰集合。
 *
 * **其余每一个字段照旧逐条比**（`nPeaks` / `nRidge` / `periodsNm` / `anglesDeg` /
 * `hexagonal` / `latticeAngleDeg` / `directionBalance` / `warnings`）——
 * 它们全都与这个符号无关，而且都是下游真正读的东西。
 */
function canonPeak(p: { kx: number; ky: number; power: number; periodNm: number; angleDeg: number }): Record<string, unknown> {
  const flip = p.ky < 0 || (p.ky === 0 && p.kx < 0)
  let a = p.angleDeg % 180
  if (a < 0) a += 180
  return { kx: flip ? -p.kx : p.kx, ky: flip ? -p.ky : p.ky, power: p.power, period_nm: p.periodNm, angle_deg: a }
}

/** 金样那一侧的同一个折叠。 */
function canonPeakGolden(p: any): Record<string, unknown> {
  return canonPeak({ kx: p.kx, ky: p.ky, power: p.power, periodNm: p.period_nm, angleDeg: p.angle_deg })
}

function peakDict(r: LatticeResult): Record<string, unknown> {
  const pk = canonPeak
  return {
    ok: r.ok,
    reason: r.reason,
    n_peaks: r.nPeaks,
    peaks: r.peaks.map(pk),
    hexagonal: r.hexagonal,
    periods_nm: [...r.periodsNm],
    period_mean_nm: r.periodMeanNm,
    period_spread: r.periodSpread,
    angles_deg: [...r.anglesDeg],
    lattice_angle_deg: r.latticeAngleDeg,
    direction_balance: r.directionBalance,
    ridge_peaks: r.ridgePeaks.map(pk),
    n_ridge: r.nRidge,
    warnings: [...r.warnings],
  }
}

function cellDict(c: CellResult): Record<string, unknown> {
  return {
    ok: c.ok,
    reason: c.reason,
    a1_nm: c.a1Nm,
    a2_nm: c.a2Nm,
    gamma_deg: c.gammaDeg,
    a1_angle_deg: c.a1AngleDeg,
    area_nm2: c.areaNm2,
    snr: [...c.snr],
    indexed: c.indexed,
    indexed_total: c.indexedTotal,
    n_peaks: c.nPeaks,
    n_ridge: c.nRidge,
    scan_dir: c.scanDir,
    warnings: [...c.warnings],
  }
}

function tilesDict(t: TileLatticeMap): Record<string, unknown> {
  return {
    ok: t.ok,
    reason: t.reason,
    grid: t.grid.map((r) => [...r]),
    tile_nm: t.tileNm,
    periods_per_tile: t.periodsPerTile,
    good_fraction: t.goodFraction,
    median_ratio: t.medianRatio,
    good_ratio: t.goodRatio,
    coherent_median_pm: t.coherentMedianPm,
    top_band_median: t.topBandMedian,
    bottom_band_median: t.bottomBandMedian,
    warnings: [...t.warnings],
  }
}

function phaseDict(r: AtomicPhaseResult): Record<string, unknown> {
  return {
    passed: r.passed,
    scale: r.scale,
    nm_per_px: r.nmPerPx,
    period_nm: r.periodNm,
    period_fast_axis_nm: r.periodFastAxisNm,
    snr: r.snr,
    angular_concentration: r.angularConcentration,
    order_ratio: r.orderRatio,
    fft_sharpness: r.fftSharpness,
    expected_a_nm: r.expectedANm,
    slow_axis_trusted: r.slowAxisTrusted,
    half_concentrations: r.halfConcentrations === null ? null : [...r.halfConcentrations],
    half_passed: r.halfPassed === null ? null : [...r.halfPassed],
    reasons: [...r.reasons],
    warnings: [...r.warnings],
  }
}

// ──────────────────────────────────────────────────────────────────────────

describe('K1：一阶布拉格峰', () => {
  it('firstOrderPeriodNm —— 六角面是行间距 √3/2·a，正方面就是 a（容差 0）', () => {
    for (const [surface, want] of Object.entries(GOLDEN['first_order_period'] as Record<string, number | null>)) {
      expect([surface, firstOrderPeriodNm(surface)]).toEqual([surface, want])
    }
  })

  it('findLatticePeaks —— 峰位逐位、功率按 fftRelTol', () => {
    for (const c of GOLDEN['lattice_peaks'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const got = findLatticePeaks(fwd, c.nm_per_px as number, {
        bandNm: c.band_nm as [number, number],
        maxPeaks: c.max_peaks as number,
      })
      const want = { ...c.result }
      want.peaks = (c.result.peaks as any[]).map(canonPeakGolden)
      want.ridge_peaks = (c.result.ridge_peaks as any[]).map(canonPeakGolden)
      // ⚠️ `power` 的**尺度是这一帧谱里最大的那个系数**，不是它自己。
      // 一次 FFT 的绝对误差由 `‖F‖∞` 定 —— 一个比峰小五个量级的脊点，
      // 它的绝对误差和峰的一样大。拿它自己当分母等于对一个由相消得来的小数字
      // 要求相对精度（`numerics.md` 第四节第一条），而那正是这一格第一次红的原因：
      // `stripe` 的脊点差 `5.8e−25`，用脊点自己归一是 9.4 倍超差，
      // 用这一帧的峰归一是 **0.008%**。
      const scales = scalesOf(fromGolden(GOLDEN['lattice_peaks']))
      const powScale = c.spectrum_max as number
      scales.set('.peaks.power', powScale)
      scales.set('.ridge_peaks.power', powScale)
      expectTree(peakDict(got), want, latticePeakRelTol(fwd.rows, fwd.cols), scales)
    }
  })

  it('金样的鉴别力：把帧扰动 1e−12 相对，峰位**一个都不动**', () => {
    // 这不是在测实现，是在**验金样**（批 4a §9①：「一格分辨不出两种候选的金样
    // 不是判据」）。`argmax` 是离散的，所以要证明的是「这一格的答案不是掷骰子」。
    // 扰动量 `1e−12` 比 `fftRelTol(192²) ≈ 3e−14` 大 30 倍 —— 峰位还不动，
    // 说明冠军的领先幅度远在浮点噪声之上。
    for (const c of GOLDEN['lattice_peaks'] as any[]) {
      if (!c.result.ok) continue
      const { fwd } = frameOf(c.file as string)
      const jittered = matOf(
        fwd.rows,
        fwd.cols,
        Float64Array.from(fwd.data, (v, i) => (v as number) * (1 + (i % 2 === 0 ? 1e-12 : -1e-12))),
      )
      const base = findLatticePeaks(fwd, c.nm_per_px as number, {
        bandNm: c.band_nm as [number, number],
        maxPeaks: c.max_peaks as number,
      })
      const jit = findLatticePeaks(jittered, c.nm_per_px as number, {
        bandNm: c.band_nm as [number, number],
        maxPeaks: c.max_peaks as number,
      })
      const key = (r: LatticeResult) => r.peaks.map((p) => `${Math.abs(p.kx)},${Math.abs(p.ky)}`).sort()
      expect([c.name, key(jit)]).toEqual([c.name, key(base)])
    }
  })
})

describe('实空间原胞', () => {
  it('measureCell 与旧仓逐条', () => {
    const scales = scalesOf(fromGolden(GOLDEN['measure_cell']))
    for (const c of GOLDEN['measure_cell'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const got = measureCell(fwd, c.nm_per_px as number, { scanDir: c.scan_dir as string })
      expectTree(cellDict(got), c.result, CELL_REL_TOL, scales)
    }
  })

  it('combineUpDown —— 上下扫消掉慢轴漂移应变', () => {
    const cellOf = (key: string, dir: string): CellResult => {
      const { fwd, nmPerPx } = frameOf(key)
      return measureCell(fwd, nmPerPx, { scanDir: dir })
    }
    const scales = scalesOf(fromGolden(GOLDEN['combine_up_down']))
    for (const c of GOLDEN['combine_up_down'] as any[]) {
      const up = (c.up as string[]).map((k) => cellOf(k, 'up'))
      const down = (c.down as string[]).map((k) => cellOf(k, 'down'))
      const got = combineUpDown(up, down, {
        minIndexed: c.min_indexed as number,
        frameHeightNm: c.frame_height_nm as number | null,
        frameTimeS: c.frame_time_s as number | null,
      })
      expectTree(got, c.result, CELL_REL_TOL, scales)
    }
  })

  it('superstructureTest —— 三个判决各一格，对照波矢逐位等于 numpy 的 PCG64', () => {
    for (const c of GOLDEN['superstructure'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const cell = measureCell(fwd, c.nm_per_px as number)
      const got = superstructureTest(fwd, c.nm_per_px as number, cell)
      const want = c.result as any[]
      expect([c.name, got.length]).toEqual([c.name, want.length])
      if (got.length === 0) continue
      // 相消 ⇒ **绝对**容差，尺度由这一帧自己的 `Σ|hw|/wsum` 定。
      const wsumScale = coherentScale(fwd, 1)
      const abs = coherentAbsTol(fwd.rows * fwd.cols, wsumScale, fwd.rows * fwd.cols)
      for (let i = 0; i < got.length; i += 1) {
        const g = got[i] as (typeof got)[number]
        const w = want[i]
        expect([c.name, g.label, g.verdict, g.note]).toEqual([c.name, w.label, w.verdict, w.note])
        expect([c.name, 'amp', Math.abs((g.amplitude as number) - (w.amplitude as number)) <= abs]).toEqual([c.name, 'amp', true])
        expect([c.name, 'cmax', Math.abs((g.controlMax as number) - (w.control_max as number)) <= abs]).toEqual([
          c.name,
          'cmax',
          true,
        ])
        expect([c.name, 'cmed', Math.abs((g.controlMedian as number) - (w.control_median as number)) <= abs]).toEqual([
          c.name,
          'cmed',
          true,
        ])
      }
    }
  })
})

describe('帧纹理', () => {
  it('latticeAmplitudePm / streakAmplitudePm / tileLatticeMap', () => {
    for (const c of GOLDEN['frame_texture'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const nmpp = c.nm_per_px as number
      const dirs = (c.directions as [number, number][]).map((d) => [d[0], d[1]] as const)
      const amps = latticeAmplitudePm(fwd, nmpp, dirs)
      const want = c.amplitudes as any[]
      const scales = scalesOf(fromGolden(GOLDEN['frame_texture']))
      expectTree(
        amps.map((a) => ({
          angle_deg: a.angleDeg,
          period_nm: a.periodNm,
          amplitude_pm: a.amplitudePm,
          coherent_pm: a.coherentPm,
          coherence: a.coherence,
        })),
        want,
        TEXTURE_REL_TOL,
        scales,
      )
      expectTree({ streak_pm: streakAmplitudePm(fwd, nmpp) }, { streak_pm: c.streak_pm }, TEXTURE_REL_TOL)
      const tiles = tileLatticeMap(
        fwd,
        nmpp,
        amps.map((a) => [a.angleDeg, a.periodNm] as const),
        { tileNm: c.tile_nm as number, goodRatio: 0.6 },
      )
      expectTree(tilesDict(tiles), c.tiles, TEXTURE_REL_TOL, scales)
    }
  })

  it('tileLatticeMap 的五条拒绝路径', () => {
    for (const c of GOLDEN['frame_texture_reject'] as any[]) {
      let m = frameOf(c.file as string).fwd
      if (c.name === 'incomplete') {
        // 金样那一格把前三分之一之外的行全置成 NaN。
        const d = Float64Array.from(m.data)
        for (let r = Math.floor(m.rows / 3); r < m.rows; r += 1) for (let k = 0; k < m.cols; k += 1) d[r * m.cols + k] = NaN
        m = matOf(m.rows, m.cols, d)
      }
      const dirs = (c.directions as [number, number][]).map((d) => [d[0], d[1]] as const)
      const tiles = tileLatticeMap(m, c.nm_per_px as number, dirs, { tileNm: c.tile_nm as number, goodRatio: 0.6 })
      expectTree(tilesDict(tiles), c.tiles, TEXTURE_REL_TOL)
    }
  })

  it('streakAmplitudePm 的两条早退给 null，不是 0', () => {
    for (const c of GOLDEN['streak_edge'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const got = streakAmplitudePm(fwd, c.nm_per_px as number)
      if (c.value === null) expect([c.name, got]).toEqual([c.name, null])
      else expectTree({ v: got }, { v: c.value }, TEXTURE_REL_TOL)
    }
  })
})

describe('原子相判据环', () => {
  it('scaleGate 三档 + 两种「不知道」（容差 0）', () => {
    const table = GOLDEN['scale_gate'] as Record<string, string | null>
    for (const [repr, want] of Object.entries(table)) {
      const v = repr === 'None' ? null : repr === 'nan' ? NaN : Number(repr)
      expect([repr, scaleGate(v)]).toEqual([repr, want])
    }
  })

  it('flattenRobust —— 对角线 + 左上角 4×4 + std（**绝对**容差，尺度是基座）', () => {
    for (const c of GOLDEN['flatten_robust'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const flat = flattenRobust(fwd)
      const cond = fwd.rows === 256 ? COND['vander2_256x256'] : fwd.rows === 128 ? COND['vander2_128x128'] : COND['vander2_64x64']
      const abs = flattenAbsTol(fwd.rows * fwd.cols, cond as number, c.pedestal as number)
      const near = (g: number, w: number, what: string, i: number) =>
        expect([c.name, what, i, Math.abs(g - w) <= abs]).toEqual([c.name, what, i, true])
      for (let i = 0; i < Math.min(flat.rows, flat.cols); i += 1) {
        near(flat.data[i * flat.cols + i] as number, (c.diag as number[])[i] as number, 'diag', i)
      }
      for (let r = 0; r < 4; r += 1) {
        for (let k = 0; k < 4; k += 1) {
          near(flat.data[r * flat.cols + k] as number, ((c.corner as number[][])[r] as number[])[k] as number, 'corner', r * 4 + k)
        }
      }
      near(npStd(flat.data), c.std as number, 'std', 0)
    }
  })

  it('detectTexture —— 周期是 bin 下标（容差 0），信噪按 BAND_PEAK_REL_TOL', () => {
    for (const c of GOLDEN['detect_texture'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const tex = detectTexture(flattenRobust(fwd), c.nm_per_px as number)
      const asList = (v: readonly [number, number] | null) => (v === null ? null : [v[0], v[1]])
      expectTree({ atomic: asList(tex.atomic), array: asList(tex.array) }, { atomic: c.atomic, array: c.array }, BAND_PEAK_REL_TOL)
    }
  })

  it('detrend32 + fftSharpness —— float32 那一步照抄，FFT 留在 float64', () => {
    // 抬头那段容差推导引了一个数：「离闸门最近的一格（noise，3.559），余量 2.2 倍」。
    // **把它钉住** —— 2026-09-17 那个数原本写的是 3.63，而金样里根本没有这个值
    //（最小的两格是 3.559 与 3.732）。余量那句话是对的，错的只是那个数 ——
    // **一个只写在注释里、没人查的数迟早是错的，而它偏偏印在推导的正中间。**
    {
      const sharps = (GOLDEN['tip_metrics'] as any[]).map((c) => c.sharpness as number)
      const nearest = Math.min(...sharps)
      expect(nearest).toBeCloseTo(3.559, 3)
      expect(HAS_LATTICE_SHARP / nearest).toBeGreaterThan(2.2)
      expect(HAS_LATTICE_SHARP / nearest).toBeLessThan(2.3)
    }
    for (const c of GOLDEN['tip_metrics'] as any[]) {
      const { fwd } = frameOf(c.file as string)
      const det = detrend32(fwd)
      const diag: number[] = []
      for (let i = 0; i < Math.min(det.rows, det.cols); i += 1) diag.push(det.data[i * det.cols + i] as number)
      // `_detrend` 的输出是 float32 —— **逐位**（`Math.fround` 与 `astype` 同一件事），
      // 而它前面那次最小二乘的差额只有一个 ulp 的 1/11（推导见 `DETREND_ULP_TOL`）。
      expectTree({ d: diag }, { d: c.detrend_diag }, DETREND_ULP_TOL)
      // ⚠️ **一条结构性判据，因为上面那条看不见它。**
      //
      // `DETREND_ULP_TOL` 是一个 ulp，而去掉 `Math.fround` 只会把每个值挪**半个**
      // ulp —— 于是「输出是不是 float32」这件事在那条断言下面是隐形的
      // （变异演练当场照出来：`phase-detrend-output-is-float32` 第一轮是**绿的**）。
      // 补这一条：输出的每一个数都必须**是它自己的 float32**。零容差，
      // 而且它照的正是那次 `astype(np.float32)` 在不在（D-VISION-3 的第二次）。
      const notF32 = Array.from(det.data).findIndex((v) => v !== Math.fround(v))
      expect([c.name, 'float32', notF32]).toEqual([c.name, 'float32', -1])
      const std = c.std as number
      const hn = matOf(
        det.rows,
        det.cols,
        Float64Array.from(det.data, (v) => Math.fround((v as number) / (std || 1.0))),
      )
      const got = fftSharpness(hn, c.nm_per_px as number)
      const tol = fftSharpnessRelTol(c.sharpness as number)
      expect([c.name, got.hasLattice]).toEqual([c.name, c.has_lattice])
      expectTree({ s: got.sharpness }, { s: c.sharpness }, tol)
      if (c.resolved_nm === null) expect([c.name, got.resolvedNm]).toEqual([c.name, null])
      else expectTree({ r: got.resolvedNm }, { r: c.resolved_nm }, tol)
    }
  })

  it('angularConcentration / orderRatio / fastAxisPeriodNm', () => {
    const scales = scalesOf(fromGolden(GOLDEN['concentration']))
    for (const c of GOLDEN['concentration'] as any[]) {
      const { fwd, nmPerPx } = frameOf(c.file as string)
      const flat = flattenRobust(fwd)
      const t = c.period_px as number
      const conc = t >= 3.0 ? angularConcentration(flat, t) : 0
      const order = t >= 3.0 ? orderRatio(flat, t) : 0
      const fast = fastAxisPeriodNm(flat, nmPerPx)
      expectTree(
        { angular_concentration: conc, order_ratio: order, fast_axis: [fast.periodNm, fast.snr] },
        { angular_concentration: c.angular_concentration, order_ratio: c.order_ratio, fast_axis: c.fast_axis },
        CONC_REL_TOL,
        scales,
      )
    }
  })

  // **一格一个 `it`**，不是一个 `it` 里跑十八格。两个理由：
  // ① 一格 256² 的判据环要做四次 FFT + 三轮最小二乘 + 半帧递归，十八格加起来
  //    超过 vitest 的缺省 5 秒超时 —— 而**超时失败与「拆掉也没人喊」长得不一样
  //    但同样没验到东西**（批 3d 那条）；
  // ② 红的时候直接看得出是哪一帧。
  const PHASE_SCALES = scalesOf(fromGolden(GOLDEN['atomic_phase']))
  for (const c of GOLDEN['atomic_phase'] as any[]) {
    it(`assessAtomicPhase / ${c.name}`, () => {
      const scales = PHASE_SCALES
      const { fwd } = frameOf(c.file as string)
      const kw = c.kwargs as Record<string, unknown>
      const got = assessAtomicPhase(fwd, {
        nmPerPx: c.nm_per_px as number | null,
        expectedANm: (kw['expected_a_nm'] as number | undefined) ?? null,
        allowReducedScale: (kw['allow_reduced_scale'] as boolean | undefined) ?? false,
      })
      // 判决与出局词先逐字比 —— 它们是这一层的产品，容差 0。
      expect([c.name, got.passed, [...got.reasons], [...got.warnings], got.scale]).toEqual([
        c.name,
        c.result.passed,
        c.result.reasons,
        c.result.warnings,
        c.result.scale,
      ])
      // 数值那一档按**最松**的那一项（`fftSharpness` 的单精度差额）。
      expectTree(phaseDict(got), c.result, Math.max(CONC_REL_TOL, fftSharpnessRelTol(c.result.fft_sharpness as number)), scales)
    })
  }
})

describe('成像条件窗口', () => {
  it('checkAtomicWindow —— 读不到条件时**放行**（容差 0）', () => {
    for (const c of GOLDEN['imaging_window'] as any[]) {
      const v = checkAtomicWindow(c.bias_v as number | null, c.setpoint_a as number | null, c.surface as string | null)
      expect([c.bias_v, c.setpoint_a, c.surface, v.ok, v.reason, v.detailZh, v.biasMaxV, v.setpointMinA]).toEqual([
        c.bias_v,
        c.setpoint_a,
        c.surface,
        c.result.ok,
        c.result.reason,
        c.result.detail_zh,
        c.result.bias_max_v,
        c.result.setpoint_min_a,
      ])
    }
  })
})
