/**
 * `mast/vision/tip_metrics.py` 里被原子相判据用到的那两件：
 * `_detrend`（去行中值 + 去平面，**结果是 float32**）与 `_fft_sharpness`。
 *
 * ## 这两件的精度**是它们语义的一部分**
 *
 * 批 4a 那一课（D-VISION-3）在这里第二次出现，而且更彻底：
 *
 * | | 旧仓做什么 | 本仓做什么 |
 * |---|---|---|
 * | `_detrend` 的返回 | `.astype(np.float32)` | {@link detrend32} 每个元素 `Math.fround` |
 * | `_detrend(h) / std` | float32 数组 ÷ **Python 标量** ⇒ NEP 50 弱标量 ⇒ **仍是 float32** | 逐元素 `fround` |
 * | `np.fft.fft2(float32)` | **complex64** —— 整个 FFT 在单精度里做 | **float64**，见下 |
 *
 * ⇒ 前两条照抄得了，第三条**照抄不了**：复现单精度 pocketfft 要把每一次蝶形运算
 * 都降到 float32，而本仓的 `fft2` 是 float64 的。所以这里**只**把输入降到 float32，
 * 变换本身留在 float64，并把差额写成一条推得出来的容差（{@link fftSharpnessRelTol}）。
 *
 * ### 容差：`8 · eps32 · sharp`（相对），而这个 `sharp` 出现在自己的容差里
 *
 * 推导：单精度 FFT 的本底噪声约 `eps32 · max|F|`（每个 bin 的绝对误差与**整幅谱的
 * 最大值**挂钩，不与这个 bin 自己挂钩 —— 相消毁掉相对精度那条的另一面）。
 * 而 `sharp = peak / median`，也就是 `median ≈ peak / sharp`，于是
 *
 * ```
 * Δmedian / median ≈ eps32·peak / (peak/sharp) = eps32 · sharp
 * ```
 *
 * 取 8 倍余量。**它随 sharp 线性放大**，所以一张锐得离谱的帧（`sharp ≈ 5234`）
 * 容差是 `5e−3`，而一张噪声帧（`sharp ≈ 3.6`）容差是 `3e−6`。
 * 这正是该有的形状：判据是 `sharp < 8`，**而紧的那一档正好落在闸门附近**。
 *
 * 实测（本机，金样**十一格**）：最坏 `1.6e−3`，占容差 `0.32`；
 * 而离闸门最近的一格（`noise`，**3.559**，闸门 8.0）余量 **2.2 倍**，容差只占那段余量的 `1.5e−6`。
 */
import { fft2, matAt, matOf, type Mat } from 'dsh-spm-numerics'
import { EPS32 } from './frame-validity.js'
import { npMedian } from './nd.js'
import { lstsqPlane } from './plane.js'

/**
 * `detrend32` 的容差：**一个 float32 的 ulp**（相对 `eps32`）。
 *
 * 推导：它的输出是 `astype(np.float32)` 的结果，也就是一个**量化过**的数。
 * 量化之前两边的差额是那次最小二乘的（本仓正规方程、numpy SVD）：
 * `(n·eps + 64·κ²·eps)·pedestal`，κ = 384（`[x, y, 1]`，192×192，**没有中心化**）
 * ⇒ `2.1e−18`，而一个 float32 ulp 在 `1.9e−10` 上是 `2.3e−17` —— **大 11 倍**。
 * 于是两边**几乎总是**落在同一个 float32 上；「几乎总是」不是「总是」，
 * 所以给一个 ulp，不给零。
 *
 * ⚠️ 别把它收成 0：那会让这条断言在一个**合法**的最后一位差异上变红，
 * 而红的时候没人知道该改它还是改代码（`numerics-3.md` 第六节第二条）。
 */
export const DETREND_ULP_TOL = EPS32

/** 见文件抬头那一节。**注意它以 `sharp` 自己为参数** —— 这条容差随锐度线性放大。 */
export function fftSharpnessRelTol(sharp: number): number {
  return 8 * EPS32 * Math.max(1, Math.abs(sharp))
}

/**
 * `tip_metrics._detrend` —— **减行中值，再减一个最小二乘平面，最后降到 float32**。
 *
 * 三步缺一不可：
 *
 * * 行中值那一步是 Gwyddion 的逐行对齐，它吃掉慢轴的行间偏置；
 * * 平面那一步的设计阵是 `[x, y, 1]`（x/y 取 `0…n−1`，**没有中心化**），
 *   条件数随边长线性涨 —— 所以系数只保证到 `lstsqObservedTol(κ)`，κ 随金样录；
 * * 最后那次 `astype(np.float32)` **不是省内存**：`judge_frame` 的
 *   `corrugation_rms_m` 就取在这份 float32 上（D-VISION-3），
 *   而 `_fft_sharpness` 的整幅谱也从它出发。
 */
export function detrend32(m: Mat): Mat {
  const { rows, cols } = m
  const n = rows * cols
  const rowMed = new Float64Array(rows)
  const row = new Float64Array(cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) row[c] = matAt(m, r, c)
    rowMed[r] = npMedian(row)
  }
  const leveled = new Float64Array(n)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) leveled[r * cols + c] = matAt(m, r, c) - (rowMed[r] as number)
  }
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      xs[i] = c
      ys[i] = r
    }
  }
  // **走 `lstsqPlane`（批 4a 那一份），不写第二份** —— 它先把 x/y 中心化，
  // 于是正规方程不吃 `κ²`。理由见那一份的抬头。
  const coef = lstsqPlane(xs, ys, leveled) ?? [0, 0, 0]
  const a0 = coef[0] as number
  const a1 = coef[1] as number
  const a2 = coef[2] as number
  const out = new Float64Array(n)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      out[i] = Math.fround((leveled[i] as number) - (a0 * c + a1 * r + a2))
    }
  }
  return matOf(rows, cols, out)
}

/** `_fft_sharpness` 的三样：锐度、被分辨的周期（nm）、有没有晶格。 */
export interface FftSharpness {
  readonly sharpness: number
  readonly resolvedNm: number | null
  readonly hasLattice: boolean
}

/** `has_lattice` 的阈值。`_fft_sharpness` 内部写死 8.0，与 `sharpness_min` 的缺省同值
 * 但**不是同一个旋钮** —— 调用方传 `sharpness_min` 改不了这一个。 */
export const HAS_LATTICE_SHARP = 8.0

/**
 * 峰在背景之上凸出多少（`max|F| / median|F|`，只看 `r > 3` 的环外）。
 *
 * ⚠️ `hn` 必须是**已经降到 float32 的那一份**（`detrend32(h)` 再逐元素 `fround`
 * 地除以 std）—— 见文件抬头。这里不替调用方做那次除法，因为除数 `std` 来自
 * `flattenRobust`，而那是另一个模块的产物。
 */
export function fftSharpness(hn: Mat, nmPerPx: number | null): FftSharpness {
  const ny = hn.rows
  const nx = hn.cols
  const N = ny
  const cy = ny >> 1
  const cx = nx >> 1
  const spec = fft2(hn)
  let peak = -Infinity
  let bestIdx = -1
  let bestMag = -Infinity
  const ring: number[] = []
  for (let r = 0; r < ny; r += 1) {
    const sr = (r + Math.ceil(ny / 2)) % ny
    for (let c = 0; c < nx; c += 1) {
      const sc = (c + Math.ceil(nx / 2)) % nx
      const mag = Math.hypot(matAt(spec.re, sr, sc), matAt(spec.im, sr, sc))
      const rr = Math.hypot(r - cy, c - cx)
      if (rr > 3.0) {
        ring.push(mag)
        if (mag > peak) peak = mag
      }
      // `np.argmax(mag * ring)` —— 环外一律乘 0，**平局取第一个**（C 序）。
      const masked = rr > 3.0 ? mag : 0
      if (masked > bestMag) {
        bestMag = masked
        bestIdx = r * nx + c
      }
    }
  }
  if (ring.length === 0) return { sharpness: 0, resolvedNm: null, hasLattice: false }
  const med = npMedian(ring) + 1e-9
  const sharp = peak / med
  const hasLat = sharp > HAS_LATTICE_SHARP
  const py = Math.floor(bestIdx / nx)
  const px = bestIdx % nx
  const rad = Math.hypot(py - cy, px - cx)
  const resNm = rad > 0 && nmPerPx && nmPerPx > 0 ? (N / rad) * nmPerPx : null
  return { sharpness: sharp, resolvedNm: hasLat ? resNm : null, hasLattice: hasLat }
}
