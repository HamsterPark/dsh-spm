/**
 * FFT、互相关、相位互相关 —— **本层唯一一件「算错了看不出来」的东西**。
 *
 * ## 容差：`8 · eps · log₂N`（相对，按谱的模长归一）
 *
 * radix-2 FFT 的误差界是 `O(eps · log₂N)`（每一级一次复数乘加，共 log₂N 级）。
 * N=64 时 `6 · 2.22e-16 ≈ 1.3e-15`；取 8 倍余量 ⇒ `1.1e-14`。
 *
 * **Bluestein 那一路更松**：它把长度 N 的 DFT 变成长度 M ≥ 2N−1 的卷积，
 * 于是误差按 `log₂M` 走，而且多了两次逐点乘。容差同式子、用 M 代 N，
 * 实测 N=61（M=128）的相对误差在 `1e-15` 量级。
 *
 * 归一化按 numpy：**正变换不除，`ifft` 除以 N**（`norm='backward'`）。
 * 这是**约定不是精度** —— 选错了整条谱差一个常数因子，而曲线形状完全正常。
 *
 * ## 峰位约定就是漂移方向的符号
 *
 * `phaseCrossCorrelation(reference, moving)` 给的是
 * **「把 moving 移动多少才能对上 reference」**。实测（`export_numerics.py`）：
 *
 * ```
 * b = roll(a, +3, +5)   ⇒   phase_cross_correlation(a, b) = [-3, -5]
 * ```
 *
 * 也就是**负的**那一个。算式是 `ifft2(F_a · conj(F_b) / |F_a · conj(F_b)|)`
 * 取模的峰位，再折到负半轴。
 *
 * 一次符号翻转或一次轴对调**不会报错**：漂移补偿会往反方向走，
 * 而图看起来只是「漂得更快了」。所以金样用**不对称**的位移（3 ≠ 5、且有零有负）
 * 逐格钉住。
 */
import { matOf, type Mat } from './mat.js'
import { EPS } from './stats.js'

/** 一段复数谱：实部与虚部各一条。**不用 `{re, im}[]`** —— 那是 N 个对象。 */
export interface Complex {
  readonly re: Float64Array
  readonly im: Float64Array
}

/** 与 numpy 比一次长度 N 的 FFT 时该用的相对容差。见文件抬头。 */
export function fftRelTol(n: number): number {
  return 8 * EPS * Math.max(1, Math.log2(Math.max(n, 2)))
}

const isPow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0

/**
 * 一维 DFT。长度是 2 的幂走 radix-2，否则走 Bluestein。
 *
 * `inverse` 只改旋转因子的符号，**不除 N** —— 除以 N 在 {@link ifft} 里做，
 * 好让「归一化在哪一步」只有一个答案。
 */
function dft(re: Float64Array, im: Float64Array, inverse: boolean): Complex {
  const n = re.length
  if (n === 0) return { re: new Float64Array(0), im: new Float64Array(0) }
  if (n === 1) return { re: Float64Array.from(re), im: Float64Array.from(im) }
  return isPow2(n) ? radix2(re, im, inverse) : bluestein(re, im, inverse)
}

/** 原地 radix-2（Cooley–Tukey，DIT）。输入被复制，不改调用方的数组。 */
function radix2(reIn: Float64Array, imIn: Float64Array, inverse: boolean): Complex {
  const n = reIn.length
  const re = Float64Array.from(reIn)
  const im = Float64Array.from(imIn)

  // 位反转置换
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] as number
      re[i] = re[j] as number
      re[j] = tr
      const ti = im[i] as number
      im[i] = im[j] as number
      im[j] = ti
    }
  }

  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    // 每一级**重算**旋转因子而不是递推相乘：递推的相位误差会随级数累积，
    // 而 `Math.cos/sin` 每次都是从一个精确的角度出发。
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = i + k + len / 2
        const xr = re[b] as number
        const xi = im[b] as number
        const tr = xr * wr - xi * wi
        const ti = xr * wi + xi * wr
        re[b] = (re[a] as number) - tr
        im[b] = (im[a] as number) - ti
        re[a] = (re[a] as number) + tr
        im[a] = (im[a] as number) + ti
      }
    }
  }
  return { re, im }
}

/**
 * Bluestein（chirp-z）—— 任意长度。
 *
 * 把 `X[k] = Σ x[j]·w^{jk}` 里的 `jk` 写成 `(j² + k² − (k−j)²)/2`，
 * 于是 DFT 变成一次**卷积**，而卷积用一个长度为 2 的幂的 FFT 做。
 *
 * 它存在是因为 STM 的帧不一定是 2 的幂：一张 500×500 的图、一条 61 点的谱，
 * 都不该被逼着补零到 512 —— **补零会在谱上加一条它自己的窗函数**。
 */
function bluestein(reIn: Float64Array, imIn: Float64Array, inverse: boolean): Complex {
  const n = reIn.length
  let m = 1
  while (m < 2 * n - 1) m <<= 1
  const sign = inverse ? 1 : -1

  // chirp: w^{j²/2}
  const cosT = new Float64Array(n)
  const sinT = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    // `i*i % (2n)` 先取模再算角度：i² 在 i 大时会掉精度，而相位只需要模 2n。
    const j = (i * i) % (2 * n)
    const ang = (sign * Math.PI * j) / n
    cosT[i] = Math.cos(ang)
    sinT[i] = Math.sin(ang)
  }

  const ar = new Float64Array(m)
  const ai = new Float64Array(m)
  for (let i = 0; i < n; i += 1) {
    ar[i] = (reIn[i] as number) * (cosT[i] as number) - (imIn[i] as number) * (sinT[i] as number)
    ai[i] = (reIn[i] as number) * (sinT[i] as number) + (imIn[i] as number) * (cosT[i] as number)
  }
  const br = new Float64Array(m)
  const bi = new Float64Array(m)
  br[0] = cosT[0] as number
  bi[0] = -(sinT[0] as number)
  for (let i = 1; i < n; i += 1) {
    br[i] = br[m - i] = cosT[i] as number
    bi[i] = bi[m - i] = -(sinT[i] as number)
  }

  const fa = radix2(ar, ai, false)
  const fb = radix2(br, bi, false)
  const cr = new Float64Array(m)
  const ci = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    cr[i] = (fa.re[i] as number) * (fb.re[i] as number) - (fa.im[i] as number) * (fb.im[i] as number)
    ci[i] = (fa.re[i] as number) * (fb.im[i] as number) + (fa.im[i] as number) * (fb.re[i] as number)
  }
  const conv = radix2(cr, ci, true)

  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const xr = (conv.re[i] as number) / m
    const xi = (conv.im[i] as number) / m
    re[i] = xr * (cosT[i] as number) - xi * (sinT[i] as number)
    im[i] = xr * (sinT[i] as number) + xi * (cosT[i] as number)
  }
  return { re, im }
}

/** numpy 的 `fft`（不归一化）。 */
export function fft(re: Float64Array | readonly number[], im?: Float64Array): Complex {
  const r = Float64Array.from(re as Iterable<number>)
  return dft(r, im ?? new Float64Array(r.length), false)
}

/** numpy 的 `ifft`（**除以 N**）。 */
export function ifft(spec: Complex): Complex {
  const n = spec.re.length
  const out = dft(spec.re, spec.im, true)
  for (let i = 0; i < n; i += 1) {
    out.re[i] = (out.re[i] as number) / n
    out.im[i] = (out.im[i] as number) / n
  }
  return out
}

/** 二维谱：实部与虚部各一张 `Mat`。 */
export interface Complex2d {
  readonly re: Mat
  readonly im: Mat
}

/** 沿一个轴做一遍。`axis 0` = 每一列，`axis 1` = 每一行。 */
function alongAxis(re: Mat, im: Mat, axis: 0 | 1, inverse: boolean): Complex2d {
  const { rows, cols } = re
  const outRe = new Float64Array(rows * cols)
  const outIm = new Float64Array(rows * cols)
  const n = axis === 0 ? rows : cols
  const outer = axis === 0 ? cols : rows
  const br = new Float64Array(n)
  const bi = new Float64Array(n)
  for (let o = 0; o < outer; o += 1) {
    for (let i = 0; i < n; i += 1) {
      const idx = axis === 0 ? i * cols + o : o * cols + i
      br[i] = re.data[idx] as number
      bi[i] = im.data[idx] as number
    }
    const f = dft(br, bi, inverse)
    for (let i = 0; i < n; i += 1) {
      const idx = axis === 0 ? i * cols + o : o * cols + i
      outRe[idx] = f.re[i] as number
      outIm[idx] = f.im[i] as number
    }
  }
  return { re: matOf(rows, cols, outRe), im: matOf(rows, cols, outIm) }
}

/** numpy 的 `fft2`（不归一化）。**先轴 1 再轴 0**，与 numpy 同。 */
export function fft2(m: Mat): Complex2d {
  const zero = matOf(m.rows, m.cols, new Float64Array(m.rows * m.cols))
  const a = alongAxis(m, zero, 1, false)
  return alongAxis(a.re, a.im, 0, false)
}

/** numpy 的 `ifft2`（**除以 rows·cols**）。 */
export function ifft2(s: Complex2d): Complex2d {
  const a = alongAxis(s.re, s.im, 0, true)
  const b = alongAxis(a.re, a.im, 1, true)
  const n = b.re.rows * b.re.cols
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    re[i] = (b.re.data[i] as number) / n
    im[i] = (b.im.data[i] as number) / n
  }
  return { re: matOf(b.re.rows, b.re.cols, re), im: matOf(b.re.rows, b.re.cols, im) }
}

/**
 * 相位互相关 —— **`reference` 与 `moving` 的顺序决定符号，见文件抬头**。
 *
 * 返回的是「把 `moving` 移动多少才能对上 `reference`」，与 skimage 的
 * `phase_cross_correlation(reference, moving)` 同一个约定：
 * `moving = roll(reference, +d)` 时它给 `−d`。
 *
 * **只做整像素**（`upsample_factor=1`）。亚像素那一档要在峰的邻域上再做一次
 * 上采样 DFT，而那一档的判据是另一件事（它会把一次「没漂」变成
 * 「漂了 0.3 个像素」），等有调用方再说。
 */
export function phaseCrossCorrelation(reference: Mat, moving: Mat): { shift: [number, number] } {
  if (reference.rows !== moving.rows || reference.cols !== moving.cols) {
    throw new RangeError(
      `相位互相关要两张同形状的图：${reference.rows}×${reference.cols} vs ${moving.rows}×${moving.cols}`,
    )
  }
  const A = fft2(reference)
  const B = fft2(moving)
  const n = reference.rows * reference.cols
  const pr = new Float64Array(n)
  const pi = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    // A · conj(B)
    const ar = A.re.data[i] as number
    const ai = A.im.data[i] as number
    const br = B.re.data[i] as number
    const bi = B.im.data[i] as number
    const cr = ar * br + ai * bi
    const ci = ai * br - ar * bi
    const mag = Math.hypot(cr, ci)
    // **模为零时置零而不是除零**：一个常数图的直流以外全是 0，
    // 而 0/0 会给 NaN，然后 argmax 会挑到一个任意的位置。
    pr[i] = mag === 0 ? 0 : cr / mag
    pi[i] = mag === 0 ? 0 : ci / mag
  }
  const cc = ifft2({ re: matOf(reference.rows, reference.cols, pr), im: matOf(reference.rows, reference.cols, pi) })

  let best = -Infinity
  let bi2 = 0
  for (let i = 0; i < n; i += 1) {
    const v = Math.hypot(cc.re.data[i] as number, cc.im.data[i] as number)
    if (v > best) {
      best = v
      bi2 = i
    }
  }
  const { rows, cols } = reference
  let dy = Math.floor(bi2 / cols)
  let dx = bi2 % cols
  // 折到负半轴：超过一半的位移读成「往回移」。这一步就是符号的来源。
  if (dy > rows / 2) dy -= rows
  if (dx > cols / 2) dx -= cols
  return { shift: [dy, dx] }
}
