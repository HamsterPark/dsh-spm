/**
 * 二维配准要的两件：`scipy.signal.correlate2d(mode='same')` 与 `numpy.hanning`。
 *
 * 放一个文件里是因为它们服务**同一条路** —— 「两张帧差了多少」：
 * 先用汉宁窗把边缘的不连续压下去，再看相关面的峰在哪一格。
 *
 * ## 容差：`correlate2d` = `convRelTol(taps)`，`taps = 核的元素个数`
 *
 * 每个输出是 `taps` 次乘加的顺序累加，界 `taps · eps`；`convRelTol` 就是
 * 「`k` 抽头卷积」那条（`4·k·eps`，4 倍余量），k 在这里是 `b.rows · b.cols`。
 * 与 `filters.ts` 共用同一条式子**不是偷懒**：那里的 k 是一维核长、这里是二维核的
 * 元素个数，而两处的 k 都是「一个输出经过多少次乘加」—— 同一个量。
 *
 * ### 而这一件另有一档**零容差**的金样，理由值得单说
 *
 * 输入全取小整数时，乘积与部分和都在 `2⁵³` 以内，于是**浮点加法在整数上是精确的**：
 * 我们与 scipy 必须**逐位相同**，一位都不能差。
 *
 * 这一档才是真正在测这个函数的那一档 —— 因为这一族唯一会犯的错不是精度，
 * **是对齐**（原点偏一格、行列对调、把相关写成了卷积），而对齐错了在浮点档上
 * 表现为「差得离谱」，在整数档上表现为「差得离谱且一眼看得出差在哪一格」。
 *
 * ## ⚠️ `mode='same'` 的原点是 `(Mb−1)//2`，**和本仓形态学的 `size>>1` 不一样**
 *
 * | | 原点 | 4×4 的核 |
 * |---|---|---|
 * | `scipy.signal.correlate2d(mode='same')` | `(Mb − 1) // 2` | **1** |
 * | `scipy.ndimage.grey_erosion(size=…)` | `Mb // 2` | **2** |
 *
 * 两个都是 scipy、两个都叫「中心」，而偶数尺寸时**差一格**。实测（探针：一张
 * 只有一个 1 的图 × 一个 `arange` 的核）四种尺寸逐一确认。
 * 猜错了整张相关面平移一格，于是漂移向量整体偏一个像素 ——
 * 而一个「漂了 1 px」的读数是完全合法的读数。
 *
 * 金样里因此有 **2×2 与 4×4** 两格偶数核：奇数核上 `(Mb−1)//2 == Mb//2`，
 * 两种猜法完全同解，**照不出这个错**。
 *
 * ## 为什么不能拿本仓已有的两件顶替
 *
 * | 已有 | 顶不了的地方 |
 * |---|---|
 * | `correlate1d`（`filters.ts`） | 它是**一维**的，而 `gaussianFilter2d` 那种「沿两轴各做一次」只对**可分离**核成立。一张帧与另一张帧的互相关不可分离 |
 * | `phaseCrossCorrelation`（`fft.ts`） | 它给的是**一个位移**不是一张相关面，而且它是**循环**的（FFT 隐含周期延拓）并且默认把每个频点归一化。`correlate2d` 是**补零**的、不归一化的 —— 两者在有漂移的帧上给的峰不在同一格 |
 *
 * ## `hanning` 的容差：`2·eps`（相对，按窗的尺度 1 归一）
 *
 * numpy 算的是 `0.5 + 0.5·cos(π·n/(M−1))`，`n = 1−M, 3−M, …, M−1`。
 * 唯一的误差源是 `cos`：**V8 的 `Math.cos` 与 C 的 libm 不保证同一串二进制位**
 * （两边都不是正确舍入的），差至多 1 ulp。`|cos| ≤ 1` ⇒ 绝对差 ≤ `eps`，
 * 再乘 0.5 ⇒ `0.5·eps`；按窗的尺度（最大值恰为 1）归一就是相对 `0.5·eps`。
 * 取 4 倍余量 ⇒ `2·eps`。
 *
 * **实测在这台机器上是 0，而我们故意不断言它。** 这与 `interpolate.ts` 那一对
 * 「保证 + 实测 0」不同：那里逐位相同是**算法**保证的（同样的四则运算、同样的顺序），
 * 这里逐位相同只是**这台机器上这两个 libm 恰好一致**。
 * 把它写成断言，等于让一次换 Node 版本变成一次「数值回归」。
 *
 * ## ⚠️ `hanning(1)` 是 `[1]`，不是 `[0]`
 *
 * `M = 1` 时 `M − 1 = 0`，那个式子除零。numpy **单独判**并回 `[1.0]`。
 * 而 `hanning(2)` 是 `[0, 0]` —— 一个把整条信号乘成零的窗，也是对的。
 * 两格金样都录：前者写成除零会给 `NaN`（`NaN` 会穿过每一条 `>` `<` 检查，同 D-SI-1），
 * 后者是「窗宽 2 没有意义」这件事的唯一证据。
 */
import { convRelTol } from './filters.js'
import { matOf, type Mat } from './mat.js'
import { EPS } from './stats.js'

/** 与 numpy 比一条汉宁窗时该用的相对容差（按窗的尺度 1 归一）。见文件抬头。 */
export const HANNING_REL_TOL = 2 * EPS

/**
 * numpy 的 `hanning(M)`：`0.5 + 0.5·cos(π·n/(M−1))`，`n = 1−M, 3−M, …, M−1`。
 *
 * **式子照抄 numpy 的写法**（先 `π·n` 再除 `M−1`，不是 `π·n/(M−1)` 先算商）——
 * 两者数学上相等、浮点上不等，而这一件的容差只有 `2·eps`。
 */
export function hanning(m: number): Float64Array {
  if (!Number.isInteger(m)) throw new RangeError(`hanning 的窗长必须是整数：得到 ${m}`)
  if (m < 1) return new Float64Array(0)
  if (m === 1) return Float64Array.from([1])
  const out = new Float64Array(m)
  for (let k = 0; k < m; k += 1) {
    const n = 1 - m + 2 * k
    out[k] = 0.5 + 0.5 * Math.cos((Math.PI * n) / (m - 1))
  }
  return out
}

/**
 * 可分离的二维汉宁窗 `outer(hanning(rows), hanning(cols))` —— 旧仓
 * `_prepare_for_registration` 里那一行。容差 `2·HANNING_REL_TOL`（两个因子各一份）。
 *
 * **只做窗**：`_prepare_for_registration` 另外两步（把非有限值换成有限值的均值、
 * 扣直流）**不在这一层** —— 「NaN 该换成什么」是一条政策而不是一个数值算法，
 * 而扣直流就是 `mean`，本仓已有。这一层不替调用方决定怎么对待坏像素。
 */
export function hanningWindow2d(rows: number, cols: number): Mat {
  const wr = hanning(rows)
  const wc = hanning(cols)
  const data = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = (wr[r] as number) * (wc[c] as number)
  }
  return matOf(rows, cols, data)
}

/** 与 scipy 比一次 `correlate2d` 时该用的相对容差：核有多少个抽头就有多少次乘加。 */
export function correlate2dRelTol(b: Mat): number {
  return convRelTol(b.rows * b.cols)
}

/**
 * `scipy.signal.correlate2d(a, b, mode='same', boundary='fill', fillvalue=0)`。
 *
 * ```
 * out[i][j] = Σ_{k,l} a[i + k − oy][j + l − ox] · b[k][l]，  界外算 0
 * oy = (b.rows − 1) >> 1，ox = (b.cols − 1) >> 1
 * ```
 *
 * **不翻核**（那是相关，不是卷积）；输出形状是 **`a` 的形状**（不是 `b` 的）。
 * 原点约定与偶数核的坑见文件抬头。
 *
 * 按消融精神只做 `mode='same'` + 零补边：旧仓两处真调用（`ComputeDriftVector`
 * 与 `TrackDrift_ReferenceScan`）传的都是这一组，而且两个输入**同形状**。
 * `'full'` / `'valid'` 与别的 `boundary` **没实现**，因为现在没有消费方；
 * 要加时判据是一格「`a` 与 `b` 不同形状」的金样 —— `'same'` 取的是
 * `'full'` 的哪一段中心，只有不同形状分得开。
 */
export function correlate2d(a: Mat, b: Mat): Mat {
  if (b.rows === 0 || b.cols === 0) throw new RangeError('correlate2d 的核不能是空的')
  const oy = (b.rows - 1) >> 1
  const ox = (b.cols - 1) >> 1
  const out = new Float64Array(a.rows * a.cols)
  for (let i = 0; i < a.rows; i += 1) {
    for (let j = 0; j < a.cols; j += 1) {
      let acc = 0
      for (let k = 0; k < b.rows; k += 1) {
        const r = i + k - oy
        if (r < 0 || r >= a.rows) continue
        for (let l = 0; l < b.cols; l += 1) {
          const c = j + l - ox
          if (c < 0 || c >= a.cols) continue
          acc += (a.data[r * a.cols + c] as number) * (b.data[k * b.cols + l] as number)
        }
      }
      out[i * a.cols + j] = acc
    }
  }
  return matOf(a.rows, a.cols, out)
}
