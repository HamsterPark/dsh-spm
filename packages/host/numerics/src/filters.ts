/**
 * 可分离滤波：高斯与拉普拉斯 —— 以及**边界模式是语义，不是精度**。
 *
 * ## 容差：`4 · k · eps`（相对），k = 核长 `2·lw+1`
 *
 * 核本身是**可以逐位复现**的：scipy 的 `gaussian_filter1d` 用
 * `exp(-0.5·(x/σ)²)` 除以自己的和，半宽 `lw = int(truncate·σ + 0.5)`。
 * 实测（`export_numerics.py` 的探针）σ=1/2 时核与 scipy **逐位相同**，
 * σ=0.8 时差 `2.8e-17`（归一化那一次除法的舍入顺序）。
 *
 * 剩下的误差只来自那 `k = 2lw+1` 次乘加，顺序相加的界是 `k · eps`。
 * 容差取 **4 倍余量**：σ=2.5、truncate=4 时 k=21，
 * 容差 `4 · 21 · 2.22e-16 ≈ 1.9e-14`。
 *
 * 余量买的是「换一批输入不必回来改数」，**不是**「让我这版通过」——
 * 把 4 改成 1 现有金样仍然全过，改成 0.01 才会红。
 *
 * ## 五种边界模式，而 scipy 与 numpy.pad 的名字**正好拧着**
 *
 * | scipy 的名字 | 序列（`a b c d` 的左边补什么） | numpy.pad 叫它 |
 * |---|---|---|
 * | `reflect` | `d c b a \| a b c d` —— **边界元素重复一次** | `symmetric` |
 * | `mirror` | `d c b \| a b c d` —— 边界元素**不**重复 | `reflect` |
 * | `nearest` | `a a a a \| a b c d` | `edge` |
 * | `constant` | `0 0 0 0 \| a b c d` | `constant` |
 * | `wrap` | `a b c d \| a b c d` | `wrap` |
 *
 * **`reflect` 与 `mirror` 在两个库里的含义是交换的。** 认错了不会报错，
 * 只会让图像四条边各差一点 —— 而扣背景、找台阶、算漂移全都从边上开始受影响。
 * 五种各有金样，谁也别想靠「差不多」蒙混过去。
 */
import { matOf, type Mat } from './mat.js'
import { EPS } from './stats.js'

export type BoundaryMode = 'reflect' | 'nearest' | 'constant' | 'mirror' | 'wrap'

/** 与 scipy 比一次 `k` 抽头卷积时该用的相对容差。见文件抬头。 */
export function convRelTol(kernelLength: number): number {
  return 4 * kernelLength * EPS
}

/**
 * 越界的下标 `i` 按边界模式折回 `[0, n)`，**`constant` 折不回来就给 `null`**。
 *
 * 只算下标不取值，于是**滤波与形态学共用这一份**。两处都要回答「第 i 个样本在哪儿」，
 * 而本仓刚为十份 `cell()` 付过一次「同一个动作被手写十遍」的账
 * （见 `stm-skills/src/l0/common.ts`）—— 那一次十份里有三份行为不一样，而谁都不知道。
 *
 * ## ⚠️ **插值不共用这一份，而那不是疏忽**
 *
 * `interpolate.ts` 有自己的一份折叠，因为 **scipy 的 `wrap` 在滤波族里周期是 `n`、
 * 在插值族里周期是 `n − 1`**（首尾两点重合）。同一个字符串，同一个库，两族含义不同。
 * 在这里复用才是 bug —— 而且是只在图像最后一行/列附近差一点的那种。
 *
 * 十份 `cell()` 的教训是「一样的东西别写十遍」，不是「长得像就合并」。
 * 这两条边界折叠**长得一模一样、行为不一样**，正是 D-CHANNELS-1 的形状。
 *
 * 写成折下标而不是先 pad 出一条长数组：pad 要多分配一份内存，
 * 而一张 512×512 的帧沿两轴各 pad 一次就是三份拷贝。
 */
export function boundaryIndex(i: number, n: number, mode: BoundaryMode): number | null {
  if (n <= 0) return null
  if (i >= 0 && i < n) return i
  switch (mode) {
    case 'constant':
      return null
    case 'nearest':
      return i < 0 ? 0 : n - 1
    case 'wrap':
      return ((i % n) + n) % n
    case 'reflect': {
      // (d c b a | a b c d | d c b a) —— 周期 2n，边界元素重复
      const p = 2 * n
      const m = ((i % p) + p) % p
      return m >= n ? p - 1 - m : m
    }
    case 'mirror': {
      // (d c b | a b c d | c b a) —— 周期 2n−2，边界元素不重复
      if (n === 1) return 0
      const p = 2 * n - 2
      const m = ((i % p) + p) % p
      return m >= n ? p - m : m
    }
  }
}

/** 按边界模式取下标 `i` 处的值。`i` 可以是负的或超出末尾。 */
function tap(xs: Float64Array, i: number, mode: BoundaryMode, cval: number): number {
  const k = boundaryIndex(i, xs.length, mode)
  return k === null ? cval : (xs[k] as number)
}

/**
 * 高斯核。`lw = int(truncate·σ + 0.5)`，长度 `2lw+1`，和归一化到 1。
 *
 * **与 scipy 同一个式子**（见文件抬头的实测）。`σ ≤ 0` 抛：一个零宽的高斯
 * 不是「不滤波」，是一个没有定义的东西，而悄悄当成不滤波会让调用方
 * 以为自己平滑过了。
 */
export function gaussianKernel(sigma: number, truncate = 4.0): Float64Array {
  if (!(sigma > 0)) throw new RangeError(`高斯核的 σ 必须为正：得到 ${sigma}`)
  const lw = Math.trunc(truncate * sigma + 0.5)
  const k = new Float64Array(2 * lw + 1)
  let acc = 0
  for (let i = -lw; i <= lw; i += 1) {
    const v = Math.exp(-0.5 * (i / sigma) ** 2)
    k[i + lw] = v
    acc += v
  }
  for (let i = 0; i < k.length; i += 1) k[i] = (k[i] as number) / acc
  return k
}

/** 一维相关（不翻核）。高斯核对称，两者等价；这里按 scipy 的 `correlate1d` 写。 */
export function correlate1d(
  xs: Float64Array,
  kernel: Float64Array,
  mode: BoundaryMode = 'reflect',
  cval = 0,
): Float64Array {
  const n = xs.length
  const lw = (kernel.length - 1) / 2
  const out = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    let acc = 0
    for (let j = 0; j < kernel.length; j += 1) {
      acc += (kernel[j] as number) * tap(xs, i + j - lw, mode, cval)
    }
    out[i] = acc
  }
  return out
}

/** scipy 的 `gaussian_filter1d`。 */
export function gaussianFilter1d(
  xs: Float64Array | readonly number[],
  sigma: number,
  mode: BoundaryMode = 'reflect',
  truncate = 4.0,
  cval = 0,
): Float64Array {
  return correlate1d(Float64Array.from(xs as Iterable<number>), gaussianKernel(sigma, truncate), mode, cval)
}

/**
 * scipy 的 `gaussian_filter`（二维）。**沿每一轴各做一次一维**——
 * 那正是「可分离」的意思，也是 scipy 自己的做法，所以两边的舍入顺序一致。
 */
export function gaussianFilter2d(
  m: Mat,
  sigma: number,
  mode: BoundaryMode = 'reflect',
  truncate = 4.0,
  cval = 0,
): Mat {
  const k = gaussianKernel(sigma, truncate)
  // 先沿轴 0（行方向，即每一列），再沿轴 1 —— 与 scipy 的轴序一致。
  const afterAxis0 = new Float64Array(m.rows * m.cols)
  const col = new Float64Array(m.rows)
  for (let c = 0; c < m.cols; c += 1) {
    for (let r = 0; r < m.rows; r += 1) col[r] = m.data[r * m.cols + c] as number
    const f = correlate1d(col, k, mode, cval)
    for (let r = 0; r < m.rows; r += 1) afterAxis0[r * m.cols + c] = f[r] as number
  }
  const out = new Float64Array(m.rows * m.cols)
  const row = new Float64Array(m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) row[c] = afterAxis0[r * m.cols + c] as number
    const f = correlate1d(row, k, mode, cval)
    for (let c = 0; c < m.cols; c += 1) out[r * m.cols + c] = f[c] as number
  }
  return matOf(m.rows, m.cols, out)
}

/**
 * scipy 的 `laplace`（二维）。
 *
 * ⚠️ **它是 `[1, −2, 1]` 沿每一轴各做一次再相加**，不是那个 3×3 的九点核。
 * 两者在一张平坦的图上都给 0，在一条 45° 的台阶上给出不同的边缘强度 ——
 * 而「台阶有多陡」正是调用它的那个技能要的答案。
 */
export function laplace2d(m: Mat, mode: BoundaryMode = 'reflect', cval = 0): Mat {
  const k = Float64Array.from([1, -2, 1])
  const out = new Float64Array(m.rows * m.cols)
  const col = new Float64Array(m.rows)
  for (let c = 0; c < m.cols; c += 1) {
    for (let r = 0; r < m.rows; r += 1) col[r] = m.data[r * m.cols + c] as number
    const f = correlate1d(col, k, mode, cval)
    for (let r = 0; r < m.rows; r += 1) out[r * m.cols + c] = f[r] as number
  }
  const row = new Float64Array(m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) row[c] = m.data[r * m.cols + c] as number
    const f = correlate1d(row, k, mode, cval)
    for (let c = 0; c < m.cols; c += 1) {
      out[r * m.cols + c] = (out[r * m.cols + c] as number) + (f[c] as number)
    }
  }
  return matOf(m.rows, m.cols, out)
}
