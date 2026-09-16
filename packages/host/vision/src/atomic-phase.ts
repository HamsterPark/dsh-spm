/**
 * **原子相判据环** —— 「这一帧上有没有原子分辨」（旧仓 `mast/vision/atomic_phase.py`）。
 *
 * 盘点里那条「剩下最大的一块杠杆」说的就是它：它直接或间接挡着
 * AssessAtomicResolution · AnalyseAtomicLattice · AssessAtomicPhase ·
 * ScanUntilAtomicResolution · VerifyAtomicResolution · ScanPublicationFrame ·
 * AchieveAtomicResolution —— **「原子分辨」这条主线的每一环**。
 *
 * ## 核心那一条：**角向集中度**，不是「FFT 里有个峰」
 *
 * 晶格在倒空间是**离散的布拉格点**（角向极不均匀），针尖抖动是**弥散环**
 * （角向均匀）。峰强度类判据分不开准周期抖动 —— 旧仓实测 30 个抖动种子
 * **全部**产生了合格的谱峰。实测分离度：真晶格 97–7645，带通抖动 1.8–3.3。
 *
 * ## 两条判据的**咬合关系**，必须连同用例一起搬（盘点 §3.3 点名的那一处）
 *
 * `atomic_phase.py:650-665` 记着 2026-08-24 的原话：
 *
 * > **一条修复删掉了另一条修复赖以工作的证据。单跑那条用例才发现；
 * > 两条各自都对，叠起来是错的。**
 *
 * 事情是这样的：脊判据（`isRidgePoint`）放宽之后，对角条纹的 12 个极大被剔光
 * 只剩一对 ±k，于是「峰在不在同一个半径上」这条判据**拿不到输入**，
 * 一张 `conc = 443283` 的条纹当场通过。
 *
 * ⇒ 所以这里有两条互相咬着的规矩，**两条都在代码里、两条都有变异**：
 *
 * 1. **半径散布要在「全部局部极大」上算** —— `peaks + ridgePeaks`，不是幸存的那些。
 *    剔脊是为了**定标**（混进去会污染 `periodSpread`）；而「这是不是一个晶格」
 *    要看全部极大，因为条纹的极大散布在各个半径上，那正是它的破绽；
 * 2. **「一个峰都没剩下，因为候选全是脊」是一条证据，不是一次读不到** ——
 *    `reason === 'too_few_peaks' && nRidge >= 2` ⇒ `peaks_are_ridges`。
 *    没有这一条，剔得越干净反而越畅通（0569 那张噪声帧带着 conc 315.1 一路通关）。
 *
 * ## 容差
 *
 * | 件 | 容差 | 推导 |
 * |---|---|---|
 * | `scale` / `reasons` / `warnings` / `passed` / `halfPassed` | **0** | 标签与判决 |
 * | `periodNm` / `periodFastAxisNm` | **0** | 都是 bin 中点的倒数（`bandPeak` / `rfftfreq`）—— 下标定死了它们 |
 * | `angularConcentration` / `orderRatio` / `snr` | {@link CONC_REL_TOL} | 「最大 bin ÷ 中位 bin」，两端各一次 `fftRelTol` + 一次 bin 内平均 |
 * | `fftSharpness` | {@link fftSharpnessRelTol}`(sharp)` | **单精度 FFT**，见 `tip-metrics.ts` 抬头 |
 *
 * `CONC_REL_TOL = 1e−9`：与 `CELL_REL_TOL` 同一条理由 —— 界在 `1e−13` 量级，
 * 而这一族真正会犯的错（环取错了半径、角度 bin 分错）在数字上差几十倍。
 */
import {
  fft2,
  ifft2,
  hanning,
  matAt,
  matOf,
  npMean,
  npStd,
  type Mat,
} from 'dsh-spm-numerics'
import { acquiredRowMask, cropRows } from './frame-validity.js'
import { npMedian, nanMedian, nanStd } from './nd.js'
import { findLatticePeaks } from './lattice-peaks.js'
import { detectTexture, flattenRobust } from './seg-texture.js'
import { detrend32, fftSharpness, fftSharpnessRelTol } from './tip-metrics.js'

/** 原子晶格周期的搜索带（nm）。与 `PEAK_BAND_NM` 必须同一区间。 */
export const ATOMIC_BAND_NM: readonly [number, number] = [0.18, 0.8]

/** 满权重档的上界（**严格小于**）。 */
export const SCALE_FULL_NMPP = 0.02
/** 过渡带的上界（**闭**）。 */
export const SCALE_OFF_NMPP = 0.05

/** 条纹判据的第二个条件：起伏太小的帧上不下「不是同一个晶格」这个结论。 */
export const STREAK_RMS_MIN_PM = 40.0

/** 一阶峰半径散布的上限（变异系数）。 */
export const PEAK_RADIUS_CV_MAX = 0.2

/**
 * 视野里至少要装下这么多个周期，否则**判不了**（不是「没有」）。
 *
 * ⚠️ 与 `lattice-cell.ts` 的 {@link CELL_MIN_PERIODS_IN_FRAME}`= 12` **是两件事**，
 * 旧仓两处都叫 `_MIN_PERIODS_IN_FRAME`：
 *
 * | | 值 | 它在挡什么 |
 * |---|---|---|
 * | 这里（判据） | **5** | `seg_scale_adaptive` 把可搜周期上限压到 `min(H,W)/4` ⇒ 短边不足约 4.75 个周期时，晶格那根谱线**根本不在搜索区间里** |
 * | `measureCell`（测量） | **12** | 谱心的直流裙边：周期越长的候选越靠近谱心，越容易赢在背景上而不是赢在结构上 |
 *
 * 这是 D-PIEZO-1 的形状（「名字一样的两件事，连发现它们不一样都要先花一分钟」）。
 * 本仓给了两个不同的名字，**并且两个都导出** —— 合并会让判据在 2.4 倍的尺度上错。
 */
export const PHASE_MIN_PERIODS_IN_FRAME = 5.0

/** 角向集中度的出厂下限。 */
export const DEFAULT_CONCENTRATION_MIN = 20.0

/** 见文件抬头那张表。 */
export const CONC_REL_TOL = 1e-9

/** 全部可能的出局词。**下游按这个闭集分「判不了」与「没有」**。 */
export const ALL_REASONS: readonly string[] = [
  'unknown_pixel_size',
  'scale_gate',
  'insufficient_data',
  'too_few_periods',
  'dependency_unavailable',
  'dead_flat',
  'no_lattice_peak',
  'not_a_lattice',
  'fft_not_sharp',
  'peaks_are_ridges',
  'peaks_not_one_lattice',
  'fast_axis_no_peak',
  'radial_fast_axis_disagree',
  'period_below_lattice',
  'period_far_above_lattice',
  'scale_reduced',
]

/**
 * 这一帧的像素尺度够不够分辨原子。`null` = **不知道**像素尺度。
 *
 * 三档不是三个数，是三句话：`full` = 证据足；`reduced` = 判得出但证据撑不住
 * 一次针尖验收；`off` = 物理上分辨不了。
 */
export function scaleGate(nmPerPx: number | null | undefined): 'full' | 'reduced' | 'off' | null {
  if (nmPerPx === null || nmPerPx === undefined || !Number.isFinite(nmPerPx) || nmPerPx <= 0) return null
  if (nmPerPx < SCALE_FULL_NMPP) return 'full'
  if (nmPerPx <= SCALE_OFF_NMPP) return 'reduced'
  return 'off'
}

/** `(选中掩码, 相对中心的角度)`，环宽 ±`rel`。 */
function ringMask(rows: number, cols: number, radiusPx: number, rel = 0.2): { sel: Uint8Array; ang: Float64Array } {
  const cy = rows >> 1
  const cx = cols >> 1
  const sel = new Uint8Array(rows * cols)
  const ang = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const dy = r - cy
      const dx = c - cx
      const rr = Math.hypot(dy, dx)
      const i = r * cols + c
      sel[i] = rr > (1 - rel) * radiusPx && rr < (1 + rel) * radiusPx ? 1 : 0
      ang[i] = Math.atan2(dy, dx)
    }
  }
  return { sel, ang }
}

/** 按角度分 bin 取**平均**；空 bin 留 0（同 numpy 的 `np.zeros` 起始值）。 */
function angularBins(values: readonly number[], angles: readonly number[], nBins: number): Float64Array {
  const out = new Float64Array(nBins)
  const buckets: number[][] = Array.from({ length: nBins }, () => [])
  for (let i = 0; i < values.length; i += 1) {
    // `((ang + π) / 2π · n).astype(int) % n` —— `astype(int)` 是**朝零截断**。
    const raw = (((angles[i] as number) + Math.PI) / (2 * Math.PI)) * nBins
    const b = (Math.trunc(raw) % nBins + nBins) % nBins
    ;(buckets[b] as number[]).push(values[i] as number)
  }
  for (let b = 0; b < nBins; b += 1) {
    const v = buckets[b] as number[]
    if (v.length > 0) out[b] = npMean(v)
  }
  return out
}

/** 谱心归位后的 `|fft2(x·win)|²`。 */
function shiftedPower(x: Mat): Mat {
  const ny = x.rows
  const nx = x.cols
  const wy = hanning(ny)
  const wx = hanning(nx)
  const win = new Float64Array(ny * nx)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) win[r * nx + c] = matAt(x, r, c) * (wy[r] as number) * (wx[c] as number)
  }
  const spec = fft2(matOf(ny, nx, win))
  const out = new Float64Array(ny * nx)
  for (let r = 0; r < ny; r += 1) {
    const sr = (r + Math.ceil(ny / 2)) % ny
    for (let c = 0; c < nx; c += 1) {
      const sc = (c + Math.ceil(nx / 2)) % nx
      const m = Math.hypot(matAt(spec.re, sr, sc), matAt(spec.im, sr, sc))
      out[r * nx + c] = m * m
    }
  }
  return matOf(ny, nx, out)
}

/**
 * 功率谱在 `|k| ≈ 1/T` 环上的角向集中度 = **最大 bin ÷ 中位 bin**。
 *
 * 这是分开「真晶格」与「针尖抖动造出的准周期条纹」的那一条。
 */
export function angularConcentration(image: Mat, periodPx: number, nBins = 72): number {
  const ny = image.rows
  const nx = image.cols
  if (Math.min(ny, nx) < 16 || !(periodPx && periodPx >= 3.0)) return 0
  const mean = npMean(image.data)
  const centred = matOf(ny, nx, Float64Array.from(image.data, (v) => v - mean))
  const P = shiftedPower(centred)
  // 频率半径：周期 `T_px` 对应的谱半径是 `N/T`。**N 取行数**（旧仓原样）。
  const f0 = ny / periodPx
  const { sel, ang } = ringMask(ny, nx, f0)
  let cnt = 0
  for (let i = 0; i < sel.length; i += 1) if (sel[i] === 1) cnt += 1
  if (cnt < nBins) return 0
  const vals: number[] = []
  const angs: number[] = []
  for (let i = 0; i < sel.length; i += 1) {
    if (sel[i] === 1) {
      vals.push(P.data[i] as number)
      angs.push(ang[i] as number)
    }
  }
  const bins = angularBins(vals, angs, nBins)
  const med = npMedian(bins)
  if (med <= 0) return 0
  let mx = -Infinity
  for (const v of bins) if (v > mx) mx = v
  return mx / med
}

/**
 * 自相关在半径 `T` 的环上按角度分 bin 后的最大值 ÷ `r(0)`。
 *
 * 读作「沿最好的那个方向平移一个周期后，图像与自己有多像」。
 * **诊断用，不作硬判据** —— 实测它分不开准周期抖动。
 *
 * 刻意**不用**环平均（`radial_ac_ratio`）：那个对六角晶格会把正负抵消掉。
 */
export function orderRatio(image: Mat, periodPx: number, nBins = 36): number {
  const ny = image.rows
  const nx = image.cols
  if (Math.min(ny, nx) < 16 || !(periodPx && periodPx >= 3.0)) return 0
  const mean = npMean(image.data)
  const x = matOf(ny, nx, Float64Array.from(image.data, (v) => v - mean))
  const spec = fft2(x)
  const n = ny * nx
  const pow = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const re = spec.re.data[i] as number
    const im = spec.im.data[i] as number
    pow[i] = re * re + im * im
  }
  const inv = ifft2({ re: matOf(ny, nx, pow), im: matOf(ny, nx, new Float64Array(n)) })
  const ac = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    const sr = (r + Math.ceil(ny / 2)) % ny
    for (let c = 0; c < nx; c += 1) {
      const sc = (c + Math.ceil(nx / 2)) % nx
      ac[r * nx + c] = matAt(inv.re, sr, sc) / n
    }
  }
  const cy = ny >> 1
  const cx = nx >> 1
  const centre = ac[cy * nx + cx] as number
  if (!Number.isFinite(centre) || centre <= 0) return 0
  const { sel, ang } = ringMask(ny, nx, periodPx, 0.15)
  let any = false
  const vals: number[] = []
  const angs: number[] = []
  for (let i = 0; i < sel.length; i += 1) {
    if (sel[i] === 1) {
      any = true
      vals.push((ac[i] as number) / centre)
      angs.push(ang[i] as number)
    }
  }
  if (!any) return 0
  const bins = angularBins(vals, angs, nBins)
  let mx = -Infinity
  for (const v of bins) if (v > mx) mx = v
  return mx
}

/**
 * 逐行 1-D 功率谱里的原子周期，以及它的信噪比。
 *
 * 每一行独立做 FFT 再把功率谱**平均** —— 慢轴漂移（行与行之间的错位）完全进不来。
 * 代价是只能测到晶格周期在快扫方向上的**投影**。
 *
 * 强峰有多个时取**周期最小**的那个，不取功率最大的：六角晶格的三组波矢在快扫
 * 方向上给出 `a`、`2a`、`2a`，后两个还叠在一起、功率是第一个的两倍 ——
 * 按功率取会稳定地报出两倍晶格常数。而投影只会**放大**周期。
 */
export function fastAxisPeriodNm(
  image: Mat,
  nmPerPx: number,
  opts: { bandNm?: readonly [number, number]; relProm?: number } = {},
): { periodNm: number | null; snr: number } {
  const bandNm = opts.bandNm ?? ATOMIC_BAND_NM
  const relProm = opts.relProm ?? 0.35
  const ny = image.rows
  const nx = image.cols
  if (nx < 8 || !(nmPerPx && nmPerPx > 0)) return { periodNm: null, snr: 0 }
  // 逐行去均值去斜（一行里的背景就是一条直线，不必上二阶）。
  const xs = new Float64Array(nx)
  for (let c = 0; c < nx; c += 1) xs[c] = c
  const xm = npMean(xs)
  const xc = new Float64Array(nx)
  let denom = 0
  for (let c = 0; c < nx; c += 1) {
    xc[c] = (xs[c] as number) - xm
    denom += (xc[c] as number) * (xc[c] as number)
  }
  if (denom === 0) denom = 1
  const win = hanning(nx)
  const nf = Math.floor(nx / 2) + 1
  const spec = new Float64Array(nf)
  const rowBuf = new Float64Array(nx)
  for (let r = 0; r < ny; r += 1) {
    let rowMean = 0
    for (let c = 0; c < nx; c += 1) rowBuf[c] = matAt(image, r, c)
    rowMean = npMean(rowBuf)
    let slope = 0
    for (let c = 0; c < nx; c += 1) slope += ((rowBuf[c] as number) - rowMean) * (xc[c] as number)
    slope /= denom
    const wr = new Float64Array(nx)
    for (let c = 0; c < nx; c += 1) wr[c] = ((rowBuf[c] as number) - rowMean - slope * (xc[c] as number)) * (win[c] as number)
    const f = fft2(matOf(1, nx, wr))
    // `P.mean(axis=0)` 是**沿轴 0** 的归约 —— numpy 逐行累加到输出上，
    // 不走成对求和。照抄那个顺序。
    for (let k = 0; k < nf; k += 1) {
      const re = f.re.data[k] as number
      const im = f.im.data[k] as number
      spec[k] = (spec[k] as number) + (re * re + im * im)
    }
  }
  for (let k = 0; k < nf; k += 1) spec[k] = (spec[k] as number) / ny

  const freq = new Float64Array(nf)
  for (let k = 0; k < nf; k += 1) freq[k] = k / nx
  const periodPx = new Float64Array(nf)
  const periodNmArr = new Float64Array(nf)
  for (let k = 0; k < nf; k += 1) {
    periodPx[k] = (freq[k] as number) > 0 ? 1.0 / Math.max(freq[k] as number, 1e-12) : Infinity
    periodNmArr[k] = (periodPx[k] as number) * nmPerPx
  }
  const selIdx: number[] = []
  for (let k = 0; k < nf; k += 1) {
    if ((periodNmArr[k] as number) >= bandNm[0] && (periodNmArr[k] as number) <= bandNm[1] && (periodPx[k] as number) >= 3.0) {
      selIdx.push(k)
    }
  }
  if (selIdx.length === 0) return { periodNm: null, snr: 0 }
  const nonDc: number[] = []
  for (let k = 0; k < nf; k += 1) if ((freq[k] as number) > 0) nonDc.push(spec[k] as number)
  const base = npMedian(nonDc) + 1e-30
  let bandMax = -Infinity
  for (const k of selIdx) if ((spec[k] as number) > bandMax) bandMax = spec[k] as number
  const peakSnr = bandMax / base
  // 峰要在带内显著，否则报「带里最大的那个 bin」等于报噪声。
  if (peakSnr < 1.0 + relProm) return { periodNm: null, snr: peakSnr }
  const strong = selIdx.filter((k) => (spec[k] as number) >= relProm * bandMax)
  if (strong.length === 0) return { periodNm: null, snr: peakSnr }
  // `np.argmin(band_periods[strong])` —— 平局取**第一个**。
  let jBest = strong[0] as number
  for (const k of strong) if ((periodNmArr[k] as number) < (periodNmArr[jBest] as number)) jBest = k
  return { periodNm: periodNmArr[jBest] as number, snr: (spec[jBest] as number) / base }
}

/** `assessAtomicPhase` 的结果。 */
export interface AtomicPhaseResult {
  readonly passed: boolean
  readonly scale: 'full' | 'reduced' | 'off' | null
  readonly nmPerPx: number | null
  readonly periodNm: number | null
  readonly periodFastAxisNm: number | null
  readonly snr: number
  readonly angularConcentration: number
  readonly orderRatio: number
  readonly fftSharpness: number
  readonly expectedANm: number | null
  readonly slowAxisTrusted: boolean
  readonly halfConcentrations: readonly [number, number] | null
  readonly halfPassed: readonly [boolean, boolean] | null
  readonly reasons: readonly string[]
  readonly warnings: readonly string[]
}

/** `assessAtomicPhase` 的阈值与开关（缺省与旧仓逐字相同）。 */
export interface AtomicPhaseOptions {
  readonly nmPerPx: number | null
  readonly expectedANm?: number | null
  readonly snrMin?: number
  readonly concentrationMin?: number
  readonly sharpnessMin?: number
  readonly bandNm?: readonly [number, number]
  readonly toleranceFrac?: number
  readonly maxProjectionRatio?: number
  readonly allowReducedScale?: boolean
  readonly checkHalves?: boolean
}

/**
 * 这一帧上有没有原子分辨。判据**取与**，外加一道尺度门。
 *
 * 纯函数：输入一个二维高度数组与显式阈值，输出结果。不读配置、不碰硬件、不抛异常。
 */
export function assessAtomicPhase(image: Mat, opts: AtomicPhaseOptions): AtomicPhaseResult {
  const bandNm = opts.bandNm ?? ATOMIC_BAND_NM
  const snrMin = opts.snrMin ?? 4.0
  const concentrationMin = opts.concentrationMin ?? DEFAULT_CONCENTRATION_MIN
  const sharpnessMin = opts.sharpnessMin ?? 8.0
  const toleranceFrac = opts.toleranceFrac ?? 0.15
  const maxProjectionRatio = opts.maxProjectionRatio ?? 2.0
  const allowReducedScale = opts.allowReducedScale ?? false
  const checkHalves = opts.checkHalves ?? true
  const expectedANm = opts.expectedANm ?? null

  const reasons: string[] = []
  const warns: string[] = []
  const scale = scaleGate(opts.nmPerPx)
  const nmpp = scale !== null ? (opts.nmPerPx as number) : null
  const expected = expectedANm && expectedANm > 0 ? expectedANm : null

  const fail = (...why: string[]): AtomicPhaseResult => ({
    passed: false,
    scale,
    nmPerPx: nmpp,
    periodNm: null,
    periodFastAxisNm: null,
    snr: 0,
    angularConcentration: 0,
    orderRatio: 0,
    fftSharpness: 0,
    expectedANm: expected,
    slowAxisTrusted: false,
    halfConcentrations: null,
    halfPassed: null,
    reasons: why,
    warnings: [...warns],
  })

  // 像素尺度未知 —— 周期换算不出纳米，任何「原子相」结论都没有根据。
  if (scale === null) return fail('unknown_pixel_size')
  if (scale === 'off') return fail('scale_gate')

  let h = image
  if (Math.min(h.rows, h.cols) < 16) return fail('insufficient_data')

  // ── 还没扫到的行不算数（**必须排在填 NaN 之前**）─────────────────────
  //
  // 扫描进行中（或被提前停掉）时，帧缓冲里**还没扫到的行是全零**。把那片零
  // 一起做 FFT 等于往谱里注入一大块结构，角向集中度会被压下去 ——
  // 实测同一批数据整帧 **162.4**、只取已扫的 143 行 **818.4**（差 5 倍），
  // 而 `concentration_min` 出厂是 20：一张好针尖的半张帧完全可能掉到线下，
  // 于是上层会**接着去磨一根本来就好的针尖**。
  const acquired = acquiredRowMask(h)
  let nDropped = h.rows
  for (let r = 0; r < acquired.length; r += 1) if (acquired[r] === 1) nDropped -= 1
  if (nDropped > 0) {
    h = cropRows(h, acquired)
    // 扫出来的太少 —— **说「判不了」，不说「没有」**。
    if (Math.min(h.rows, h.cols) < 16) return fail('insufficient_data')
  }

  // ── 视野里装不下足够多的周期 ⇒ **判不了**，不是「没有」────────────────
  //
  // 上面那道闸数的是**像素**，可真正的约束是**周期数**：`seg_scale_adaptive`
  // 把可搜周期上限压到 `min(H, W) / 4`，于是短边不足约 4.75 个周期时，
  // 晶格那根谱线**根本不在搜索区间里**。
  // `expected_a_nm` 缺席时退到原子带**下限**，免得把「2 nm 视野里找 0.8 nm 周期」
  // 这类正当调用一起判成判不了。
  const periodForGate = expected ?? bandNm[0]
  if (periodForGate > 0 && Math.min(h.rows, h.cols) * (nmpp as number) < PHASE_MIN_PERIODS_IN_FRAME * periodForGate) {
    return fail('too_few_periods')
  }

  // `np.nan_to_num(h, nan=median)` —— 中位取的是**有限值**的中位。
  let anyNonFinite = false
  for (let i = 0; i < h.data.length; i += 1) if (!Number.isFinite(h.data[i] as number)) anyNonFinite = true
  if (anyNonFinite) {
    const med = nanMedian(h.data)
    const fill = Number.isFinite(med) ? med : 0
    h = matOf(
      h.rows,
      h.cols,
      Float64Array.from(h.data, (v) => (Number.isNaN(v) ? fill : v)),
    )
  }

  const flat = flattenRobust(h)
  const std = npStd(flat.data)
  if (!Number.isFinite(std) || std <= 0) return fail('dead_flat')

  // ── 判据 1：原子带里有没有显著谱峰 ──
  const tex = detectTexture(flat, nmpp as number, { atomicBandNm: bandNm, latSnr: snrMin })
  let periodNm: number | null = null
  let snr = 0
  let tPx = 0
  if (tex.atomic) {
    tPx = tex.atomic[0]
    snr = tex.atomic[1]
    periodNm = tPx * (nmpp as number)
  } else {
    reasons.push('no_lattice_peak')
  }

  // ── 判据 2：离散布拉格点，不是弥散环（核心）──
  const conc = tPx >= 3.0 ? angularConcentration(flat, tPx) : 0
  if (conc < concentrationMin) reasons.push('not_a_lattice')

  // ── 判据 3：布拉格峰锐度 ──
  const det = detrend32(h)
  const hn = matOf(
    det.rows,
    det.cols,
    // float32 数组 ÷ Python 弱标量 ⇒ **结果仍是 float32**（NEP 50）。
    Float64Array.from(det.data, (v) => Math.fround(v / std)),
  )
  const sharpRes = fftSharpness(hn, nmpp)
  const sharp = sharpRes.sharpness
  if (sharp < sharpnessMin) reasons.push('fft_not_sharp')

  // ── 判据 3b：这些峰是**同一个晶格**的吗 ──
  // 补角向集中度的盲区：一条穿过原点的弥散条纹在角度上也是集中的，照样拿得到
  // 60 分；但条纹上的「峰」半径各不相同，而真晶格的一阶峰同半径。
  const lat = findLatticePeaks(h, nmpp as number)
  if (!lat.ok && lat.reason === 'too_few_peaks' && lat.nRidge >= 2) {
    // 见文件抬头第 2 条：**剔得越干净反而越畅通**，那正是这一支存在的理由。
    reasons.push('peaks_are_ridges')
  }
  // 见文件抬头第 1 条：**全部**局部极大，不是幸存的那些。
  const all = [...lat.peaks, ...lat.ridgePeaks]
  if (all.length >= 3) {
    const rs = all.map((pk) => Math.hypot(pk.kx, pk.ky))
    const m = npMean(rs)
    const cv = m > 0 ? npStd(rs) / m : 0
    // **两条并且** —— 单用任何一条都会误伤。
    const rmsPm = nanStd(flat.data) * 1e12
    if (cv > PEAK_RADIUS_CV_MAX && rmsPm >= STREAK_RMS_MIN_PM) reasons.push('peaks_not_one_lattice')
  }

  // ── 判据 4：逐行谱也要看到它（可信的那个方向）──
  const fast = fastAxisPeriodNm(flat, nmpp as number, { bandNm })
  if (fast.periodNm === null) {
    // 二维谱说有、逐行说没有 —— 那是慢轴方向的周期性（行噪声 / 干扰），不是晶格。
    reasons.push('fast_axis_no_peak')
  } else if (periodNm !== null && Math.abs(fast.periodNm - periodNm) > 0.5 * Math.max(fast.periodNm, periodNm)) {
    // **判否，不是告警。** 这一条 2026-08-24 从 `warnings` 挪过来：
    // 判据 4 的整个用意是「二维谱会被慢轴假象骗，逐行谱才是可信的那个方向」。
    // 上面那支（逐行谱**什么也没看到**）判否；这一支是逐行谱看到了、但看到的是
    // **另一个周期**。两支说的是同一件事，一支判否一支只记一笔是漏接。
    // ⚠️ 阈值 0.5 **没有动过** —— 只改了它的归属。
    reasons.push('radial_fast_axis_disagree')
  }

  // 诊断量：平移一个周期后图像与自己有多像。**不作判据**（实测分不开抖动）。
  const order = tPx >= 3.0 ? orderRatio(flat, tPx) : 0

  // ── 与已知晶格常数比对（下界严、上界松）──
  if (expected !== null && fast.periodNm !== null) {
    if (fast.periodNm < expected * (1 - toleranceFrac)) {
      // 投影只会让周期变大 —— 明显更小的周期不是这个晶格。
      reasons.push('period_below_lattice')
    } else if (fast.periodNm > expected * maxProjectionRatio) {
      reasons.push('period_far_above_lattice')
    } else if (fast.periodNm > expected * (1 + toleranceFrac)) {
      // 合理的取向投影，不是问题，但要说出来。
      warns.push('period_consistent_with_oblique_lattice')
    }
  }

  if (scale === 'reduced') {
    warns.push('scale_reduced')
    if (!allowReducedScale) reasons.push('scale_reduced')
  }

  // ── 帧内前后两半：针尖是不是**在这一帧中途**变了 ──
  //
  // 2026-08-23 真机：`MakeAtomicResolutionTip` 拿整帧的 `passed` 判了
  // `atomic_tip_ready`，而那一帧按扫描顺序切开是前半 conc 5731.9（过）/
  // 后半 conc 17.0（不是晶格）。整帧的 136.2 是两种状态的混合值 ——
  // **证书说的是过去式**。
  //
  // 守卫按**物理量**，不按行数：每一半在慢轴上要装得下约 8 个周期。
  // 原来写的是 `h.shape[0] >= 32`，而 0421 的裁切（半帧 1.05 nm ≈ 4.2 周期）
  // 两半都回 0.0 ⇒ 下游算成比值 0 ⇒ **假阳性**：一个窄帧被判成「针尖变了」。
  let halves: readonly [number, number] | null = null
  let halfOk: readonly [boolean, boolean] | null = null
  const halfNm = (h.rows / 2) * (nmpp ?? 0)
  if (checkHalves && reasons.length === 0 && halfNm >= 2.0) {
    const mid = h.rows >> 1
    const sub = (r0: number, r1: number): Mat => {
      const rows = r1 - r0
      const d = new Float64Array(rows * h.cols)
      for (let r = 0; r < rows; r += 1) for (let c = 0; c < h.cols; c += 1) d[r * h.cols + c] = matAt(h, r0 + r, c)
      return matOf(rows, h.cols, d)
    }
    const kw: AtomicPhaseOptions = {
      nmPerPx: nmpp,
      expectedANm: expected,
      snrMin,
      concentrationMin,
      sharpnessMin,
      bandNm,
      toleranceFrac,
      maxProjectionRatio,
      allowReducedScale,
      checkHalves: false,
    }
    const first = assessAtomicPhase(sub(0, mid), kw)
    const second = assessAtomicPhase(sub(mid, h.rows), kw)
    halves = [first.angularConcentration, second.angularConcentration]
    halfOk = [first.passed, second.passed]
    // ⚠️ 这里**只报告，不判定**。试过在这里直接判否，两次都错 ——
    // 判定放到真正发证的地方（`MakeAtomicResolutionTip`）。
  }

  return {
    passed: reasons.length === 0,
    scale,
    nmPerPx: nmpp,
    periodNm,
    periodFastAxisNm: fast.periodNm,
    snr: Math.max(snr, fast.periodNm !== null ? fast.snr : 0),
    angularConcentration: conc,
    orderRatio: order,
    fftSharpness: sharp,
    expectedANm: expected,
    slowAxisTrusted: false,
    halfConcentrations: halves,
    halfPassed: halfOk,
    reasons,
    warnings: warns,
  }
}

export { fftSharpnessRelTol }
