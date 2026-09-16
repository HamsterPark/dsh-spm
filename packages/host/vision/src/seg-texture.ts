/**
 * `mast/vision/seg_scale_adaptive.py` 的**判据切片** —— 原子相判据要的那三件：
 * `align_rows_mediandiff` → `level_iterative` → `flatten_robust`，
 * 以及径向谱上的带内取峰 `_radial_profile` → `_band_peak` → `detect_texture`。
 *
 * **只移这一条链**（约 90 行），不移 `segment_scale_adaptive`（它要 skimage 的
 * disk / otsu / tophat，而且没有消费方 —— 消融精神）。盘点表里那条
 * 「`seg_scale_adaptive:segment_scale_adaptive` 要 210 + 40 行」说的是另一件事，
 * 它解锁的是 `AnalyzeFrameTilt`，不是这一族。
 *
 * ## 容差
 *
 * | 件 | 容差 | 推导 |
 * |---|---|---|
 * | `detectTexture` 的 `T`（周期，像素） | **0** | 它是 `1/f0`，而 `f0` 是**第 `best` 个 bin 的中点** —— `best` 是整数下标，bins 由 `linspace` 定死。做得到逐位就不给容差 |
 * | `detectTexture` 的 `snr` | {@link BAND_PEAK_REL_TOL} | `prof[best] / median(prof)`：两个数各自是一次 `bincount` 累加 + 一次高斯卷积 |
 * | `flattenRobust` 的每个像素 | {@link flattenAbsTol}（**绝对**） | 去背景是相消 ⇒ 尺度是基座不是残差；主项是正规方程形成 `AᵀA` 的 `n·eps`，不是 κ。推导写在那个函数上 |
 *
 * ### `T` 为什么可以要求逐位
 *
 * 因为它是**下标**。`_band_peak` 把带内的功率摊进 **160** 个频率 bin，
 * 取最强峰里**频率最高**的那个的 bin 中点。只有当两个相邻 bin 的 prominence
 * 正好在 `rel_prom` 那条线的两侧、差一个 ulp 时，答案才会翻 —— 而那种金样
 * 「一格分辨不出两种候选」，不该存在（批 4a 那四次「掷骰子」）。
 * 本批金样里最挤的一格领先 1.9 倍。
 *
 * ### `flattenRobust` 里那个**离散**的东西
 *
 * `level_iterative` 每一轮都按 `|r − med(r)| < 2.5·σ` 重挑内点 —— 一个像素在
 * 阈值上翻边，下一轮的系数就变。这与 D-VISION-1（RANSAC 的内点集）是同一个形状，
 * 但**严重程度差得远**：那边内点是随机抽样定的（两边根本不是同一批点），
 * 这边是一条确定的阈值，只有**正好落在阈值上**的像素才会分岔。
 * 36864 个像素、残差铺开在 `1e−11` 的量程上、扰动量级 `1e−24` ⇒
 * 期望翻边像素数 `4e−9`。所以这一条按普通容差处理，不像 D-VISION-1 那样分两层。
 */
import {
  EPS,
  findPeaks,
  gaussianFilter1d,
  hanning,
  lstsqRelTol,
  matAt,
  matOf,
  npMean,
  solveNormalEquations,
  fft2,
  type Mat,
} from 'dsh-spm-numerics'
import { npMedian, madOf } from './nd.js'

/** `_band_peak` 的频率 bin 数。 */
export const BAND_BINS = 160

/** `DEFAULTS` 里本族用得到的那几个（其余 30 个没有消费方，**不移**）。 */
export const SEG_DEFAULTS = {
  atomicBandNm: [0.18, 0.8] as readonly [number, number],
  arrayBandNm: [0.8, 4.0] as readonly [number, number],
  latSnr: 4.0,
  peakRelProm: 0.35,
} as const

/**
 * 带内取峰的相对容差。
 *
 * `snr = prof[best] / median(prof)`。`prof` 的每一格是 `bincount` 把带内若干个
 * 功率值累加起来（**同号，无相消**，`≤ N/160` 项）再除以计数，然后过一次
 * `σ=2` 的高斯（9 个抽头）。于是
 *
 * ```
 * 谱本身 fftRelTol(N) ≈ 3e−14  +  累加 (N/160)·eps ≈ 5e−14  +  卷积 4·9·eps ≈ 8e−15
 * ```
 *
 * 分子分母各一份 ⇒ 约 `2e−13`。取 `1e−9`（四个量级余量），理由同
 * `lattice-cell.ts` 的 `CELL_REL_TOL`：这一族真正会犯的错是**挑错了 bin**，
 * 那在数字上差百分之几十。
 */
export const BAND_PEAK_REL_TOL = 1e-9

/**
 * `flattenRobust` 的**绝对**容差（米）：`3 · (n·eps + 64·κ²·eps) · pedestal`。
 *
 * 三件事，缺一条这个数就说不清：
 *
 * 1. **绝对，不是相对。** 去背景是 `h − 面`，残差 ~1e−10 而被减掉的面 ~1e−9 ——
 *    **相消**。对一个由相消得来的小数字要求相对精度是在要求一件不成立的事
 *    （`numerics.md` 第四节第一条）。尺度是 `pedestal = max|h|`，随金样录。
 * 2. **`n·eps` 是主项，不是 `κ`。** 本仓走正规方程，而形成 `AᵀA` 的每一格是
 *    **n = 36864 次**乘加的顺序累加 ⇒ 相对误差上界 `n·eps ≈ 8.2e−12`；
 *    Cholesky 那一步只贡献 `κ²·eps`（κ = 13.6 ⇒ `4.1e−14`）。
 *    numpy 走 SVD，**不形成** `AᵀA`，所以两边的差额整条来自这一项。
 *    实测 `6.2e−14`（≈ `√n·eps`，随机游走），占这条界的 **0.75%**。
 * 3. **3 倍**：三轮最小二乘。每一轮都从原始 `h` 重算残差（只有内点集是继承的），
 *    所以是三次独立的同量级误差，不累乘。
 */
export function flattenAbsTol(nPixels: number, cond: number, pedestal: number): number {
  return 3 * (nPixels * EPS + lstsqRelTol(cond)) * Math.abs(pedestal)
}

/**
 * Gwyddion 的逐行对齐：**相邻两行之差的中位数**的累积和。
 *
 * 它与 `tip_metrics._detrend` 的「减行中值」不是一件事：那边把每一行**各自**
 * 拉到 0（会吃掉沿慢轴的真实结构），这边只把**行与行之间的偏置**拿掉。
 */
export function alignRowsMedianDiff(m: Mat): Mat {
  const { rows, cols } = m
  const out = new Float64Array(rows * cols)
  const d = new Float64Array(Math.max(0, rows - 1))
  const buf = new Float64Array(cols)
  for (let r = 0; r + 1 < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) buf[c] = matAt(m, r + 1, c) - matAt(m, r, c)
    d[r] = npMedian(buf)
  }
  // `np.concatenate([[0.0], np.cumsum(d)])` —— 第 0 行不动。
  let acc = 0
  for (let r = 0; r < rows; r += 1) {
    if (r > 0) acc += d[r - 1] as number
    for (let c = 0; c < cols; c += 1) out[r * cols + c] = matAt(m, r, c) - acc
  }
  return matOf(rows, cols, out)
}

/** `_vander(shape, order=2)` 的六列：`[1, x, y, x², xy, y²]`，x/y ∈ [−0.5, 0.5)。 */
export function vander2(rows: number, cols: number): Float64Array[] {
  const n = rows * cols
  const one = new Float64Array(n)
  const cx = new Float64Array(n)
  const cy = new Float64Array(n)
  const cxx = new Float64Array(n)
  const cxy = new Float64Array(n)
  const cyy = new Float64Array(n)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      const x = c / cols - 0.5
      const y = r / rows - 0.5
      one[i] = 1
      cx[i] = x
      cy[i] = y
      cxx[i] = x * x
      cxy[i] = x * y
      cyy[i] = y * y
    }
  }
  // 顺序**照抄** `_vander`：`o=1` 给 `x, y`；`o=2` 给 `x², x·y, y²`。
  return [one, cx, cy, cxx, cxy, cyy]
}

/**
 * 迭代稳健去背景：三轮「拟合 → 按 `|r − med| < 2.5σ` 重挑内点」。
 *
 * ⚠️ 返回的是**最后一次拟合**的残差，而那一次拟合用的是**上一轮**挑出的内点
 * （挑内点在拟合之后）。差一轮的实现看起来一样、答案不一样。
 */
export function levelIterative(m: Mat, order = 2, iters = 3, clip = 2.5): Mat {
  const { rows, cols } = m
  const n = rows * cols
  if (order !== 2) throw new RangeError(`levelIterative 只移了 order=2：得到 ${order}`)
  const A = vander2(rows, cols)
  const b = Float64Array.from(m.data)
  let mask = new Uint8Array(n).fill(1)
  let coef: Float64Array = new Float64Array(A.length)
  for (let it = 0; it < iters; it += 1) {
    let kept = 0
    for (let i = 0; i < n; i += 1) if (mask[i] === 1) kept += 1
    const colsSel: Float64Array[] = A.map(() => new Float64Array(kept))
    const bSel = new Float64Array(kept)
    let k = 0
    for (let i = 0; i < n; i += 1) {
      if (mask[i] !== 1) continue
      for (let j = 0; j < A.length; j += 1) (colsSel[j] as Float64Array)[k] = (A[j] as Float64Array)[i] as number
      bSel[k] = b[i] as number
      k += 1
    }
    coef = solveNormalEquations(colsSel, bSel)
    const r = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      let acc = 0
      for (let j = 0; j < A.length; j += 1) acc += (coef[j] as number) * ((A[j] as Float64Array)[i] as number)
      r[i] = (b[i] as number) - acc
    }
    const medR = npMedian(r)
    const dev = new Float64Array(n)
    for (let i = 0; i < n; i += 1) dev[i] = Math.abs((r[i] as number) - medR)
    const s = 1.4826 * npMedian(dev) + 1e-12
    const next = new Uint8Array(n)
    let cnt = 0
    for (let i = 0; i < n; i += 1) {
      if ((dev[i] as number) < clip * s) {
        next[i] = 1
        cnt += 1
      }
    }
    mask = next
    if (cnt < n * 0.2) break
  }
  const out = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    let acc = 0
    for (let j = 0; j < A.length; j += 1) acc += (coef[j] as number) * ((A[j] as Float64Array)[i] as number)
    out[i] = (b[i] as number) - acc
  }
  return matOf(rows, cols, out)
}

/** `flatten_robust` = 逐行对齐 + 迭代二阶去背景。 */
export function flattenRobust(m: Mat): Mat {
  return levelIterative(alignRowsMedianDiff(m))
}

/** `_radial_profile` 的两条平行数组：频率半径与功率。 */
export interface RadialProfile {
  readonly fr: Float64Array
  readonly power: Float64Array
}

/**
 * `_radial_profile` —— 加窗后的 `|rfft2|²`，与每个 bin 的频率半径。
 *
 * ⚠️ 本仓没有 `rfft2`，这里用 `fft2` 取前 `W//2 + 1` 列。两者**数学上等价**，
 * 而浮点上 numpy 的实输入变换与复变换差在最后一位 —— 这一份差额被
 * {@link BAND_PEAK_REL_TOL} 接住，而下游（160 个 bin 的直方图）本来就把它摊平了。
 */
export function radialProfile(m: Mat): RadialProfile {
  const H = m.rows
  const W = m.cols
  const mean = npMean(m.data)
  const wy = hanning(H)
  const wx = hanning(W)
  const win = new Float64Array(H * W)
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) win[r * W + c] = (matAt(m, r, c) - mean) * (wy[r] as number) * (wx[c] as number)
  }
  const spec = fft2(matOf(H, W, win))
  const nf = Math.floor(W / 2) + 1
  const fr = new Float64Array(H * nf)
  const power = new Float64Array(H * nf)
  for (let r = 0; r < H; r += 1) {
    // `np.fft.fftfreq(H)`：前半 `k/H`，后半 `(k−H)/H`。
    const fy = r < Math.floor((H + 1) / 2) ? r / H : (r - H) / H
    for (let c = 0; c < nf; c += 1) {
      const fx = c / W
      const re = matAt(spec.re, r, c)
      const im = matAt(spec.im, r, c)
      const mag = Math.hypot(re, im)
      fr[r * nf + c] = Math.hypot(fy, fx)
      power[r * nf + c] = mag * mag
    }
  }
  return { fr, power }
}

/** `np.linspace(a, b, num)` 逐位 —— numpy 走 `i·step + a`，**最后一格直接置成 `b`**。 */
export function linspace(a: number, b: number, num: number): Float64Array {
  const out = new Float64Array(num)
  if (num === 0) return out
  const step = (b - a) / (num - 1)
  for (let i = 0; i < num; i += 1) out[i] = i * step + a
  out[num - 1] = b
  return out
}

/** 带内取峰的结果。`T` 为 `null` 表示这个带里没有强峰。 */
export interface BandPeak {
  readonly tPx: number | null
  readonly snr: number
}

/**
 * 带内 `[t_lo, t_hi]`（像素周期）的强峰。
 *
 * **`T` 取强峰里周期最小的那个**（= 频率最高的那个 bin），不取功率最大的：
 * 六角晶格的三组波矢在一维投影上给出 `a`、`2a`、`2a`，后两个叠在一起、
 * 功率是第一个的两倍 —— 按功率取会稳定地报出两倍晶格常数。
 * （这一条与 `fastAxisPeriodNm` 出于同一个理由，那边防的是投影，这边防的是 moiré。）
 */
export function bandPeak(fr: Float64Array, power: Float64Array, tLo: number, tHi: number, relProm: number): BandPeak {
  if (tHi <= tLo * 1.1) return { tPx: null, snr: 0 }
  const nb = BAND_BINS
  const bins = linspace(1.0 / tHi, 1.0 / tLo, nb + 1)
  const prof = new Float64Array(nb)
  const cnt = new Float64Array(nb)
  for (let i = 0; i < fr.length; i += 1) {
    // `np.digitize(x, bins) - 1` = `searchsorted(bins, x, 'right') - 1`。
    const idx = searchSortedRight(bins, fr[i] as number) - 1
    if (idx >= 0 && idx < nb) {
      prof[idx] = (prof[idx] as number) + (power[i] as number)
      cnt[idx] = (cnt[idx] as number) + 1
    }
  }
  const avg = new Float64Array(nb)
  for (let i = 0; i < nb; i += 1) avg[i] = (prof[i] as number) / ((cnt[i] as number) + 1e-9)
  const sm = gaussianFilter1d(avg, 2.0)
  const base = npMedian(sm) + 1e-30
  const res = findPeaks(sm, { prominence: base * 0.5 })
  if (res.peaks.length === 0) return { tPx: null, snr: 0 }
  const proms = res.prominences as Float64Array
  let maxProm = -Infinity
  for (const p of proms) if (p > maxProm) maxProm = p
  let best = -1
  for (let i = 0; i < res.peaks.length; i += 1) {
    if ((proms[i] as number) >= relProm * maxProm) {
      const idx = res.peaks[i] as number
      // `cand.max()` —— 最大的**下标**（= 最高频率 = 最小周期）。
      if (idx > best) best = idx
    }
  }
  if (best < 0) return { tPx: null, snr: 0 }
  const f0 = 0.5 * ((bins[best] as number) + (bins[best + 1] as number))
  return { tPx: 1.0 / f0, snr: (sm[best] as number) / base }
}

/** `np.searchsorted(bins, x, side='right')`。 */
function searchSortedRight(bins: Float64Array, x: number): number {
  let lo = 0
  let hi = bins.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < (bins[mid] as number)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** `detect_texture` 的两档。 */
export interface TextureBands {
  readonly atomic: readonly [number, number] | null
  readonly array: readonly [number, number] | null
}

/** `detect_texture(h, nmpp, DEFAULTS)` —— 原子带与超原子带各一个强峰。 */
export function detectTexture(
  flat: Mat,
  nmPerPx: number,
  opts: { atomicBandNm?: readonly [number, number]; latSnr?: number; peakRelProm?: number } = {},
): TextureBands {
  const atomicBand = opts.atomicBandNm ?? SEG_DEFAULTS.atomicBandNm
  const latSnr = opts.latSnr ?? SEG_DEFAULTS.latSnr
  const relProm = opts.peakRelProm ?? SEG_DEFAULTS.peakRelProm
  const { fr, power } = radialProfile(flat)
  const short = Math.min(flat.rows, flat.cols)
  const pick = (band: readonly [number, number]): readonly [number, number] | null => {
    const lo = Math.max(2.5, band[0] / nmPerPx)
    const hi = Math.min(short / 4.0, band[1] / nmPerPx)
    const { tPx, snr } = bandPeak(fr, power, lo, hi, relProm)
    return tPx !== null && snr >= latSnr && tPx >= 3.0 ? ([tPx, snr] as const) : null
  }
  return { atomic: pick(atomicBand), array: pick(SEG_DEFAULTS.arrayBandNm) }
}

/** 给调用方：这一层的稳健尺度（`1.4826·MAD + 1e−12`，与 `levelIterative` 同一条）。 */
export function robustSigma(xs: readonly number[] | Float64Array): number {
  return 1.4826 * madOf(xs) + 1e-12
}
