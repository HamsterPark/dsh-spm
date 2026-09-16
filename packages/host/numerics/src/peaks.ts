/**
 * `scipy.signal.find_peaks` —— **这一族的容差几乎全是 0，而那正是它值得单独一个文件的理由**。
 *
 * ## 容差表（先写下来，再写实现）
 *
 * | 给出去的 | 容差 | 推导 |
 * |---|---|---|
 * | `peaks`（峰的下标） | **0** | 它是整数。一个「差不多的下标」不是精度问题，是另一个峰 |
 * | `leftBases` / `rightBases` | **0** | 同上，整数 |
 * | `prominences` | **0** | `x[peak] − max(left_min, right_min)`：**两个操作数都是输入数组里的元素原样**，中间只有一次 IEEE 减法。没有累加、没有相消放大 —— 做得到逐位，就不该给容差 |
 * | `widths` / `leftIps` / `rightIps` / `widthHeights` | **保证 `8·eps`**（相对，按 `max\|want\|` 归一）<br>**实测 0** | 每个数至多经过 5 次舍入：`height = x[peak] − prom·0.5`（1 次；`·0.5` 是 2 的幂，精确）、`height − x[i]`（1）、`x[i±1] − x[i]`（1）、除法（1）、`ip ± frac`（1）。界 `5·eps`，取 8 留余量。而运算顺序是照抄 scipy 的，于是实测逐位相同 —— 两条都断言，理由见 `interpolate.ts` 抬头那一节 |
 *
 * 判峰与筛选用的全是 `<` / `<=` / `>=` 比较，**比较没有容差**：它要么在这一边要么在那一边。
 * 于是这一族唯一会出的错不是精度，是**语义**，而下面三条是语义里最容易写错的。
 *
 * ## ⚠️ 一：`prominence` 的定义
 *
 * 峰的 prominence = **峰高 − 「向左、向右各走到遇见一个比它更高的样本为止，
 * 这两段区间里各自的最小值」的较大者**。
 *
 * ```
 *   x[peak] − max(left_min, right_min)
 * ```
 *
 * 两个「容易写成」的错版本，都给出完全合理的数：
 *
 * - 取 `min(left_min, right_min)` ⇒ 每个峰的 prominence 都偏大，一条噪声上的小包
 *   会越过阈值（走到全局最低点为止那一侧几乎总是 0）；
 * - 只看**直接相邻**的谷 ⇒ 一座大山肩上的小凸起会拿到和主峰一样的 prominence。
 *
 * 向外走的停止条件是「遇到一个**严格更高**的样本」（`x[i] <= x[peak]` 继续），
 * 所以**等高的平台不挡路**，而底座记的是那一段区间里**第一次**取到最小值的位置。
 *
 * ## ⚠️ 二：`distance` 在 `prominence` **之前**筛（这是 scipy 的顺序，不是随便哪个）
 *
 * `find_peaks` 的筛选顺序是 `plateau_size → height → threshold → distance → prominence → width`。
 * 反过来做**不会报错**，只会在某些信号上多留或少留一个峰：
 *
 * ```
 * x = [0, 5, 0, 9.9, 9.8, 9.8, 9.8, 9.8, 10, 0]，prominence = 1，distance = 3
 *   scipy（distance 先）：[8]      —— 下标 3 那个高而**不突出**的峰先把下标 1 挤掉，
 *                                     然后它自己被 prominence 筛掉
 *   prominence 先        ：[1, 8]  —— 下标 3 先被筛掉，于是没人挤下标 1
 * ```
 *
 * **这一格金样就是为这件事录的**（`peaks.order_probe`）。别的输入上两种顺序同解。
 *
 * ## ⚠️ 三：平台峰取**中点、向下取整**，而**紧贴数组两端的极大值不算峰**
 *
 * `[0, 1, 1, 1, 1, 0]` 的峰是下标 **2**（`(2+5)//2 = 3`？不 —— 平台是 `[1, 4]`，
 * `(1+4)//2 = 2`）。四个样本宽的平台给的是**偏左**那一个。
 * 而 `x[n−1]` 再高也不是峰：scipy 的扫描区间是 `[1, n−2]`，两端没有「两个更矮的邻居」。
 * 旧仓 `classical_seg.py` 正是为这条在直方图两端各补了一个 0 才让最外层的台阶露出来。
 *
 * ## 按消融精神，**只做消费方真的传的那几个参数**
 *
 * 旧仓五处真调用传的是：`prominence`（5/5）、`distance`（3/5）、`width=0`（1/5，
 * `vision/spectral_peaks.py`，它要的是 `widths` 这个**属性**而不是筛选 —— `width=0`
 * 对 `widths >= 0` 恒真）。于是这里实现的就是这三个。
 *
 * 没实现的，以及要加时判据是什么：
 *
 * | 没做 | 现在没有消费方 | 加的时候判据是 |
 * |---|---|---|
 * | `height` / `threshold` | 只有旧仓 agents 层的 `tools.py:661` 用，那一层不在移植范围里 | 一格「峰高刚好等于阈值」的金样（`>=` 还是 `>`） |
 * | `wlen` | 无 | 一个**宽底座**上的峰：截断与不截断给不同的 prominence，别的输入分不出来 |
 * | `plateau_size` | 无 | 平台宽度的闭开区间 |
 * | `rel_height ≠ 0.5` | 无（`width` 那一处用的是缺省 0.5） | `prom·rel_height` 不再是 2 的幂乘法，容差要从 `8·eps` 重推 |
 * | `(min, max)` 区间形式的条件 | 无（五处传的全是标量下界） | 上界那一侧的闭开性 |
 *
 * ## D-NUM-?? · 等高峰在 `distance` 里谁赢，scipy **没有定义**
 *
 * scipy 用 `np.argsort`（quicksort，**不稳定**）给峰按高度排序，然后从高到低处理。
 * 两个**等高**且互相在 `distance` 之内的峰，留下哪一个由排序实现决定 ——
 * 换一版 numpy 就可能换一个答案，所以**没有金样能钉住那一侧**。
 *
 * 本仓用**稳定**排序（等高时下标小的排前），于是从高到低处理时**下标大的先赢**。
 * 这是一条真实偏差：它是确定的，但它不保证等于 scipy。
 * 金样里因此没有等高峰 —— 一格分辨不出两种候选的金样不是判据，
 * 一格**答案本身没有定义**的金样更糟。
 */
import { EPS } from './stats.js'

/**
 * `widths` / `leftIps` / `rightIps` 的**保证**：`8·eps`（相对）。见文件抬头那张表。
 *
 * 写成常数而不是函数：它不随长度变 —— 每个宽度是**至多 5 次舍入**的结果，
 * 与信号有多长、有多少个峰都无关。
 */
export const PEAK_WIDTH_REL_TOL = 8 * EPS

/** 一次 `find_peaks` 的结果。**没算的属性是 `null`，不是空数组** —— 两者不是一回事。 */
export interface FindPeaksResult {
  /** 峰的下标，升序。 */
  readonly peaks: Int32Array
  /** 每个峰的 prominence。没要 `prominence` 也没要 `width` 时为 `null`。 */
  readonly prominences: Float64Array | null
  /** prominence 搜索时左侧取到最小值的下标。 */
  readonly leftBases: Int32Array | null
  /** 右侧同上。 */
  readonly rightBases: Int32Array | null
  /** 半高宽（样本数）。没要 `width` 时为 `null`。 */
  readonly widths: Float64Array | null
  /** 量宽度的那条水平线的高度 `x[peak] − prom·0.5`。 */
  readonly widthHeights: Float64Array | null
  /** 左交点的插值位置。 */
  readonly leftIps: Float64Array | null
  /** 右交点。 */
  readonly rightIps: Float64Array | null
}

/** `findPeaks` 的条件。**全是下界**（同五处消费方传的形式），见文件抬头。 */
export interface FindPeaksOptions {
  /** 最小 prominence（**闭**：`prominences >= prominence` 留下）。 */
  readonly prominence?: number
  /** 相邻两个峰的最小间隔（样本数，向上取整）。**在 prominence 之前筛。** */
  readonly distance?: number
  /** 最小宽度（闭）。传 `0` 等于「只要 `widths` 这个属性，不筛」。 */
  readonly width?: number
}

/**
 * scipy 的 `_local_maxima_1d`：**两个直接邻居都更矮**的样本；等高的平台取中点、
 * 向下取整；**紧贴两端的极大值不算**。见文件抬头第三条。
 */
function localMaxima1d(x: Float64Array): Int32Array {
  const n = x.length
  const mid: number[] = []
  let i = 1
  const iMax = n - 1
  while (i < iMax) {
    if ((x[i - 1] as number) < (x[i] as number)) {
      let ahead = i + 1
      // 等高的平台一路走过去。`ahead < iMax` ⇒ 顶到最后一个样本的平台不算峰。
      while (ahead < iMax && (x[ahead] as number) === (x[i] as number)) ahead += 1
      if ((x[ahead] as number) < (x[i] as number)) {
        // 中点向下取整：四个样本宽的平台给偏左那一个
        mid.push((i + (ahead - 1)) >> 1)
        i = ahead
      }
    }
    i += 1
  }
  return Int32Array.from(mid)
}

/** {@link peakProminences} 的三样东西。 */
export interface Prominences {
  readonly prominences: Float64Array
  readonly leftBases: Int32Array
  readonly rightBases: Int32Array
}

/**
 * scipy 的 `peak_prominences`。**容差 0**，定义见文件抬头第一条。
 *
 * 不接 `wlen`（没有消费方）—— 搜索区间恒为整条信号。
 */
export function peakProminences(x: Float64Array, peaks: Int32Array): Prominences {
  const n = x.length
  const prom = new Float64Array(peaks.length)
  const lb = new Int32Array(peaks.length)
  const rb = new Int32Array(peaks.length)
  for (let p = 0; p < peaks.length; p += 1) {
    const peak = peaks[p] as number
    if (!(peak >= 0 && peak < n)) throw new RangeError(`峰的下标 ${peak} 不在 0..${n - 1}`)
    const h = x[peak] as number

    let i = peak
    lb[p] = peak
    let leftMin = h
    while (i >= 0 && (x[i] as number) <= h) {
      if ((x[i] as number) < leftMin) {
        leftMin = x[i] as number
        lb[p] = i
      }
      i -= 1
    }

    i = peak
    rb[p] = peak
    let rightMin = h
    while (i < n && (x[i] as number) <= h) {
      if ((x[i] as number) < rightMin) {
        rightMin = x[i] as number
        rb[p] = i
      }
      i += 1
    }

    // **max** 不是 min：见文件抬头第一条。
    prom[p] = h - Math.max(leftMin, rightMin)
  }
  return { prominences: prom, leftBases: lb, rightBases: rb }
}

/** {@link peakWidths} 的四样东西。 */
export interface Widths {
  readonly widths: Float64Array
  readonly widthHeights: Float64Array
  readonly leftIps: Float64Array
  readonly rightIps: Float64Array
}

/**
 * scipy 的 `peak_widths`，`rel_height = 0.5`（半高宽）。容差见文件抬头那张表。
 *
 * 量的是**相对 prominence 的半高**（`x[peak] − prom/2`），不是**绝对**半高
 * （`x[peak]/2`）—— 一条坐在基线 0.4 上的峰，两者差着整条基线。
 *
 * 交点在样本之间时线性插值；搜索被 `leftBases` / `rightBases` 夹住，
 * 于是相邻的两个峰不会互相吞掉对方的宽度。
 */
export function peakWidths(x: Float64Array, peaks: Int32Array, prom: Prominences): Widths {
  const w = new Float64Array(peaks.length)
  const wh = new Float64Array(peaks.length)
  const lip = new Float64Array(peaks.length)
  const rip = new Float64Array(peaks.length)
  for (let p = 0; p < peaks.length; p += 1) {
    const peak = peaks[p] as number
    const iMin = prom.leftBases[p] as number
    const iMax = prom.rightBases[p] as number
    // `·0.5` 是 2 的幂，精确；整个式子只有这一次舍入
    const height = (x[peak] as number) - (prom.prominences[p] as number) * 0.5
    wh[p] = height

    let i = peak
    while (iMin < i && height < (x[i] as number)) i -= 1
    let left = i
    if ((x[i] as number) < height) {
      left += (height - (x[i] as number)) / ((x[i + 1] as number) - (x[i] as number))
    }

    i = peak
    while (i < iMax && height < (x[i] as number)) i += 1
    let right = i
    if ((x[i] as number) < height) {
      right -= (height - (x[i] as number)) / ((x[i - 1] as number) - (x[i] as number))
    }

    lip[p] = left
    rip[p] = right
    w[p] = right - left
  }
  return { widths: w, widthHeights: wh, leftIps: lip, rightIps: rip }
}

/**
 * scipy 的 `_select_by_peak_distance`。**等高时下标大的赢**，见文件抬头最后一节。
 */
function selectByDistance(peaks: Int32Array, heights: Float64Array, distance: number): Uint8Array {
  const m = peaks.length
  const keep = new Uint8Array(m).fill(1)
  const d = Math.ceil(distance)
  // 按高度**升序**的稳定排序：等高时下标小的在前，于是从后往前处理时下标大的先赢。
  const order = Array.from({ length: m }, (_v, i) => i).sort((a, b) => {
    const ha = heights[a] as number
    const hb = heights[b] as number
    return ha === hb ? a - b : ha - hb
  })
  for (let i = m - 1; i >= 0; i -= 1) {
    const j = order[i] as number
    if (keep[j] === 0) continue
    let k = j - 1
    while (k >= 0 && (peaks[j] as number) - (peaks[k] as number) < d) {
      keep[k] = 0
      k -= 1
    }
    k = j + 1
    while (k < m && (peaks[k] as number) - (peaks[j] as number) < d) {
      keep[k] = 0
      k += 1
    }
  }
  return keep
}

const subsetI32 = (a: Int32Array, keep: Uint8Array): Int32Array =>
  Int32Array.from([...a].filter((_v, i) => keep[i] === 1))
const subsetF64 = (a: Float64Array, keep: Uint8Array): Float64Array =>
  Float64Array.from([...a].filter((_v, i) => keep[i] === 1))

/**
 * scipy 的 `find_peaks`。**筛选顺序是 `distance` 再 `prominence` 再 `width`**，
 * 见文件抬头第二条 —— 那不是实现细节，是答案的一部分。
 */
export function findPeaks(
  xs: Float64Array | readonly number[],
  opts: FindPeaksOptions = {},
): FindPeaksResult {
  const x = Float64Array.from(xs as Iterable<number>)
  let peaks = localMaxima1d(x)

  if (opts.distance !== undefined) {
    if (!(opts.distance >= 1)) throw new RangeError(`find_peaks 的 distance 必须 ≥ 1：得到 ${opts.distance}`)
    peaks = subsetI32(peaks, selectByDistance(peaks, Float64Array.from([...peaks].map((i) => x[i] as number)), opts.distance))
  }

  const wantProm = opts.prominence !== undefined || opts.width !== undefined
  if (!wantProm) {
    return {
      peaks,
      prominences: null, leftBases: null, rightBases: null,
      widths: null, widthHeights: null, leftIps: null, rightIps: null,
    }
  }

  let prom = peakProminences(x, peaks)
  if (opts.prominence !== undefined) {
    const min = opts.prominence
    const keep = Uint8Array.from([...prom.prominences].map((v) => (min <= v ? 1 : 0)))
    peaks = subsetI32(peaks, keep)
    prom = {
      prominences: subsetF64(prom.prominences, keep),
      leftBases: subsetI32(prom.leftBases, keep),
      rightBases: subsetI32(prom.rightBases, keep),
    }
  }

  if (opts.width === undefined) {
    return {
      peaks,
      prominences: prom.prominences, leftBases: prom.leftBases, rightBases: prom.rightBases,
      widths: null, widthHeights: null, leftIps: null, rightIps: null,
    }
  }

  let wid = peakWidths(x, peaks, prom)
  const minW = opts.width
  const keepW = Uint8Array.from([...wid.widths].map((v) => (minW <= v ? 1 : 0)))
  peaks = subsetI32(peaks, keepW)
  prom = {
    prominences: subsetF64(prom.prominences, keepW),
    leftBases: subsetI32(prom.leftBases, keepW),
    rightBases: subsetI32(prom.rightBases, keepW),
  }
  wid = {
    widths: subsetF64(wid.widths, keepW),
    widthHeights: subsetF64(wid.widthHeights, keepW),
    leftIps: subsetF64(wid.leftIps, keepW),
    rightIps: subsetF64(wid.rightIps, keepW),
  }
  return {
    peaks,
    prominences: prom.prominences, leftBases: prom.leftBases, rightBases: prom.rightBases,
    widths: wid.widths, widthHeights: wid.widthHeights, leftIps: wid.leftIps, rightIps: wid.rightIps,
  }
}
