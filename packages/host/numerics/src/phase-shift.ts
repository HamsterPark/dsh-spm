/**
 * `phase_shift` —— 两帧之间的**整像素**平移 + 相关峰锐度。
 *
 * 旧仓 `coarse_step_calib.py:57-71`（15 行）。它是 `CalibrateCoarseStep` 的尺子：
 * 用有标定的压电去量没有位置反馈的粗动马达，靠的就是「同一个压电中心扫两帧，
 * 整幅图相位相关求位移」。
 *
 * ## 为什么不能拿 `phaseCrossCorrelation` 顶
 *
 * 那一个（`fft.ts:492`）给的是**亚像素位移 + `error` + `phase`**，
 * **不给锐度**。而这个技能唯一的自证判据是 `_MIN_CORR_SNR = 12.0`：
 * 峰／中位比低于它就**拒答**——那说明两帧之间没有可对齐的共同特征
 * （坑跑出视野，或表面太平），这时报一个位移就是报一个凑出来的数。
 * 没有 SNR 这一路，那道闸整个不存在。
 *
 * 两者还有一处算法差别：`phaseCrossCorrelation` 的归一化分母是
 * `max(|·|, 100·eps)`（照 skimage），这一条是 `max(|·|, 1e-30)`（照旧仓）。
 * **不要合并**：`100·eps ≈ 2.2e-14` 与 `1e-30` 之间差 16 个数量级，
 * 一格谱幅落在两者之间时，归一化之后一个是「单位相位」另一个是「几乎为零」。
 *
 * ## 容差：`snr` 走**相对**，`dx`/`dy` 走 **0**
 *
 * | 量 | 容差 | 推导 |
 * |---|---|---|
 * | `dx` / `dy` | **0** | 它们是 `argmax` 的下标减一个整数 —— 选错峰是选错格，不是差一点 |
 * | `snr` | {@link phaseShiftSnrRelTol} | 见下 |
 *
 * `snr = max(c) / max(median(|c|), 1e-12)`，而 `c` 经过 **三次二维变换**
 * （两次 `fft2` + 一次 `ifft2`），每次是「先沿轴 1 再沿轴 0」两趟一维 FFT
 * ⇒ 每次贡献 `fftRelTol(rows) + fftRelTol(cols)`。逐元素的那几步
 * （加窗、复乘、归一化、取模）各 O(eps)，在上面那一项面前可以忽略。
 *
 * 分子是相关峰：对得上的两帧上它是 O(1)，**没有相消**。
 * 分母是中位数那一格：它是 N² 个单位相位求和再除 N²，绝对误差
 * ≈ `eps·log₂(N²)/N`，而它自己的量级是 `1/N` ⇒ **相对**误差同样落在
 * `fftRelTol` 那一档（中位数的**选取**本身是稳的：N² 个样本里相邻次序统计量
 * 的间距远大于浮点误差）。
 *
 * ⇒ `3 · (fftRelTol(rows) + fftRelTol(cols))`，取 **8 倍**（约 2.7 倍余量，
 * 同 `xcorrErrorSqAbsTol` 的写法）。
 *
 * 轴长不是 2 的幂时本仓走 **Bluestein**（`fft.ts:146`），**不是**朴素 DFT ——
 * 误差仍然是 `O(eps·log N)`，只是常数大一些。金样里有一格 17×17
 * （`phase_shift/odd_side_17`）实测仍在这条界之内。
 *
 * ⚠️ **那一格不是凑数**：`fftshift` 的方向（`roll(+n//2)` 还是 `roll(−n//2)`）
 * 在**偶数**边长上给同一个答案（`+n/2 ≡ −n/2 mod n`）—— 全是 2 的幂的金样里，
 * 那道闸没有输入。
 */
import { hanning } from './correlate.js'
import { fft2, fftRelTol, ifft2 } from './fft.js'
import { matOf, type Mat } from './mat.js'
import { npSum } from './pairwise.js'
import { median } from './stats.js'

/** 见文件抬头那张表。 */
export function phaseShiftSnrRelTol(rows: number, cols: number): number {
  return 8 * (fftRelTol(rows) + fftRelTol(cols))
}

/** 帧太小（任一边 < 16）时的下限 —— 相位相关在那个尺寸上没有意义。 */
export const PHASE_SHIFT_MIN_SIDE = 16

export interface PhaseShift {
  /** x 方向整像素位移（列）。 */
  readonly dx: number
  /** y 方向整像素位移（行）。 */
  readonly dy: number
  /** 峰／中位比。低于 `_MIN_CORR_SNR` 就该拒答。 */
  readonly snr: number
}

/** `np.nan_to_num` —— NaN→0，±inf→±最大有限 double。 */
function nanToNum(v: number): number {
  if (Number.isNaN(v)) return 0
  if (v === Infinity) return Number.MAX_VALUE
  if (v === -Infinity) return -Number.MAX_VALUE
  return v
}

/**
 * `np.nanmean` —— 全是 NaN 时给 NaN（同 numpy 的 RuntimeWarning 那一支）。
 *
 * ⚠️ **累加必须走 `npSum`（成对求和），不能顺序累**。`np.nanmean` 的实现是
 * `_replace_nan(a, 0)` 之后走 `np.sum(arr) / 有效个数`，而 `np.sum` 在
 * 1024 个元素上是成对的。第一版写成顺序累加，`phase_shift` 的 `snr` 与金样
 * 差了 **1e−10 相对** —— 不是 FFT 的锅，是这一行：两种求和在 N=1024 上差
 * `~eps·N` 的绝对量，而它一路传到 `c` 的中位那一格上放大了 `snr` 倍。
 */
function nanMean(a: Float64Array): number {
  const filled = new Float64Array(a.length)
  let n = 0
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i] as number
    if (Number.isNaN(v)) {
      filled[i] = 0
      continue
    }
    filled[i] = v
    n += 1
  }
  return n === 0 ? Number.NaN : npSum(filled) / n
}

/** 去 NaN 均值 + `nan_to_num`。 */
function centred(m: Mat): Float64Array {
  const mean = nanMean(m.data)
  const out = new Float64Array(m.data.length)
  for (let i = 0; i < m.data.length; i += 1) out[i] = nanToNum((m.data[i] as number) - mean)
  return out
}

/**
 * `b` 相对 `a` 的整体平移（像素）+ 峰锐度。用相位相关，对亮度变化不敏感。
 *
 * 形状对不上、或任一边 < {@link PHASE_SHIFT_MIN_SIDE} ⇒ `null`
 * （旧仓返回 `(None, None, None)`）。
 */
export function phaseShift(a: Mat, b: Mat): PhaseShift | null {
  if (a.rows !== b.rows || a.cols !== b.cols) return null
  const rows = a.rows
  const cols = a.cols
  if (Math.min(rows, cols) < PHASE_SHIFT_MIN_SIDE) return null

  const A = centred(a)
  const B = centred(b)
  // 可分离的二维汉宁窗。**不走 `hanningWindow2d`**：那一份的抬头写明它只做窗，
  // 而这里要的乘法顺序与旧仓一致（`hanning(rows)[:,None] * hanning(cols)[None,:]`），
  // 两者同式 —— 用它也对，但那会让这一行的出处指向另一个函数的抬头。
  const wr = hanning(rows)
  const wc = hanning(cols)
  const aw = new Float64Array(rows * cols)
  const bw = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const w = (wr[r] as number) * (wc[c] as number)
      aw[r * cols + c] = (A[r * cols + c] as number) * w
      bw[r * cols + c] = (B[r * cols + c] as number) * w
    }
  }

  const FA = fft2(matOf(rows, cols, aw))
  const FB = fft2(matOf(rows, cols, bw))
  const n = rows * cols
  const rre = new Float64Array(n)
  const rim = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    // R = FA · conj(FB)
    const ar = FA.re.data[i] as number
    const ai = FA.im.data[i] as number
    const br = FB.re.data[i] as number
    const bi = -(FB.im.data[i] as number)
    const re = ar * br - ai * bi
    const im = ar * bi + ai * br
    // `R /= np.maximum(np.abs(R), 1e-30)` —— 分母照旧仓，**不是** skimage 的 `100·eps`。
    const mag = Math.max(Math.hypot(re, im), 1e-30)
    rre[i] = re / mag
    rim[i] = im / mag
  }
  const inv = ifft2({ re: matOf(rows, cols, rre), im: matOf(rows, cols, rim) })

  // `np.fft.fftshift`：`shifted[i] = x[(i − n//2) mod n]`（`roll(x, n//2)`）。
  const h0 = Math.floor(rows / 2)
  const h1 = Math.floor(cols / 2)
  const c = new Float64Array(n)
  for (let i = 0; i < rows; i += 1) {
    const sr = (((i - h0) % rows) + rows) % rows
    for (let j = 0; j < cols; j += 1) {
      const sc = (((j - h1) % cols) + cols) % cols
      c[i * cols + j] = inv.re.data[sr * cols + sc] as number
    }
  }

  // `np.argmax` —— C 序里**第一个**最大值。
  let best = -Infinity
  let at = 0
  for (let i = 0; i < n; i += 1) {
    const v = c[i] as number
    if (v > best) {
      best = v
      at = i
    }
  }
  const iy = Math.floor(at / cols)
  const ix = at % cols
  const absC = new Float64Array(n)
  for (let i = 0; i < n; i += 1) absC[i] = Math.abs(c[i] as number)
  const snr = best / Math.max(median(absC), 1e-12)
  return { dx: ix - h1, dy: iy - h0, snr }
}
