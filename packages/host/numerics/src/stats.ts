/**
 * 统计 —— 以及本层第一条**真的有理由的容差**。
 *
 * ## `sum` / `mean` 对 numpy 的容差：`8 · eps · log₂N`（相对）
 *
 * 三种求和算法，三个答案：
 *
 * | | 算法 | 误差界 |
 * |---|---|---|
 * | `numpy.sum` | **成对求和**（pairwise，分治到 8 个元素的块） | `O(eps · log₂N)` |
 * | Python 3.12+ `sum()` | **Neumaier 补偿求和** | `O(eps)`，基本是精确的 |
 * | 朴素 `for` 累加 | 顺序相加 | `O(eps · N)` |
 *
 * 实测（`export_numerics.py` 的 2048 个标准正态）：numpy 与 `pySum` 的相对差
 * `1.77e-16 ≈ 0.8 · eps`。理论上界 `eps · log₂2048 = 11 · eps ≈ 2.4e-15`。
 *
 * **本仓用 `pySum`**（`kernel/src/si.ts`）——不是因为它对 numpy 更近，是因为
 * 技能金样那一侧要的是 CPython 的答案（`AutoPhase` 的 `x_mean` 就卡在这一位上，
 * 2026-09-13）。**一个仓里只能有一个 `sum`**，否则「均值」会随调用方而变。
 *
 * 于是对 numpy 的比对必须带容差，而 `8 · eps · log₂N` 是那个上界留了 3 倍余量的写法。
 * **它不是试出来的**：把 `8` 改成 `1`，2048 那一格仍然过（0.8 < 11），
 * 改成 `0.1` 才会红 —— 余量在这里买的是「换一批输入不必回来改数」。
 *
 * ## `percentile` 的容差：**0**
 *
 * numpy 的 `linear` 法是一个闭式：`vi = q/100·(n−1)`，然后在
 * `sorted[⌊vi⌋]` 与 `sorted[⌈vi⌉]` 之间线性插。没有累加，所以**逐位相同**做得到，
 * 而做得到就不该给容差 —— 一个不必要的容差会把一次真的算错藏起来。
 *
 * ⚠️ `linear` 是 numpy 的**缺省**，别的方法（`lower` / `midpoint` / `nearest`）
 * 给的是**另一个数**，不是同一个数的不同精度。
 */
import { pySum } from 'dsh-spm-kernel'

/** float64 的机器精度。 */
export const EPS = Number.EPSILON

/**
 * 与 numpy 比一个求和类结果时该用的相对容差。见文件抬头。
 *
 * 写成函数而不是常数，因为**它随 N 变**：一条 64 点的曲线与一张 512×512 的帧
 * 不该共用一个数。
 */
export function sumRelTol(n: number): number {
  return 8 * EPS * Math.max(1, Math.log2(Math.max(n, 2)))
}

/** 和。走 `pySum`（Neumaier）——**全仓一个 `sum`**，见文件抬头。 */
export function sum(xs: readonly number[] | Float64Array): number {
  return pySum(xs as Iterable<number>)
}

/** 均值。空表给 `NaN`（同 numpy 的 `RuntimeWarning` + `nan`，不是 0）。 */
export function mean(xs: readonly number[] | Float64Array): number {
  return xs.length === 0 ? NaN : sum(xs) / xs.length
}

/**
 * 标准差。**两遍法**（先算均值再算离差平方和），与 numpy 同。
 *
 * 不用「平方和减均值平方」那个一遍公式：它在均值远大于标准差时会做一次
 * **灾难性相消**——p 量级的电流上一个 150 pA 的均值配 0.5 pA 的抖动，
 * 一遍公式能把方差算成负数。
 *
 * `ddof` 同 numpy：`0` 是总体标准差，`1` 是样本标准差。
 */
export function std(xs: readonly number[] | Float64Array, ddof = 0): number {
  const n = xs.length
  if (n - ddof <= 0) return NaN
  const m = mean(xs)
  const dev = new Float64Array(n)
  for (let i = 0; i < n; i += 1) dev[i] = ((xs as readonly number[])[i] as number - m) ** 2
  return Math.sqrt(sum(dev) / (n - ddof))
}

/** 极差（`max − min`）。空表给 `NaN`。 */
export function ptp(xs: readonly number[] | Float64Array): number {
  if (xs.length === 0) return NaN
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < xs.length; i += 1) {
    const v = (xs as readonly number[])[i] as number
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo
}

/**
 * numpy 的 `percentile(..., method='linear')`。容差 **0**，见文件抬头。
 *
 * `q` 是 **0–100**（不是 0–1）——numpy 的约定，而把两者搞混的那个错
 * 会给出一个完全合理的数：`percentile(x, 0.95)` 是「第 0.95 百分位」，
 * 也就是几乎最小值，而调用方想要的是几乎最大值。
 */
export function percentile(xs: readonly number[] | Float64Array, q: number): number {
  const n = xs.length
  if (n === 0) return NaN
  if (!(q >= 0 && q <= 100)) {
    throw new RangeError(`percentile 的 q 是 0–100（不是 0–1）：得到 ${q}`)
  }
  const s = Float64Array.from(xs as Iterable<number>).sort()
  if (n === 1) return s[0] as number
  const vi = (q / 100) * (n - 1)
  const lo = Math.floor(vi)
  const hi = Math.min(lo + 1, n - 1)
  const frac = vi - lo
  const a = s[lo] as number
  const b = s[hi] as number
  // 与 numpy 同一个式子（`a + (b−a)·frac`），不是 `a·(1−frac) + b·frac` ——
  // 两者数学上相等、浮点上不等，而这一件的容差是 0。
  return a + (b - a) * frac
}

/** 中位数 = 第 50 百分位。 */
export function median(xs: readonly number[] | Float64Array): number {
  return percentile(xs, 50)
}

export interface Histogram {
  readonly counts: Int32Array
  readonly edges: Float64Array
}

/**
 * numpy 的 `histogram(x, bins, range)`。容差 **0**（它数的是个数）。
 *
 * ⚠️ **归属规则：左闭右开，最后一个 bin 的右边界也闭。** 也就是说落在
 * `range[1]` 上的样本进**最后一个** bin，而不是被丢掉。这条在
 * 「最高的那个 bin 是哪个」上会翻结论 —— 而那正是这个函数的调用方要的答案。
 */
export function histogram(
  xs: readonly number[] | Float64Array,
  bins: number,
  range: readonly [number, number],
): Histogram {
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError(`bins 必须是正整数：${bins}`)
  const [lo, hi] = range
  if (!(hi > lo)) throw new RangeError(`histogram 的 range 必须 lo < hi：得到 [${lo}, ${hi}]`)
  const counts = new Int32Array(bins)
  const width = (hi - lo) / bins
  for (let i = 0; i < xs.length; i += 1) {
    const v = (xs as readonly number[])[i] as number
    if (!(v >= lo && v <= hi)) continue // 区间外不计（同 numpy）；NaN 也落这里
    // 最后一个 bin 右闭：`v === hi` 时 idx 会算成 bins，夹回去。
    const idx = Math.min(bins - 1, Math.floor((v - lo) / width))
    counts[idx] = (counts[idx] as number) + 1
  }
  const edges = new Float64Array(bins + 1)
  for (let i = 0; i <= bins; i += 1) edges[i] = lo + width * i
  return { counts, edges }
}
