/**
 * **numpy 的成对求和**（`np.add.reduce` 对连续 float64 的那条路），
 * 以及踩在它上面的 `np.mean` / `np.var` / `np.std`。
 *
 * ## 容差：**0**
 *
 * 这不是「顺便严一点」，是这一族本来就做得到 —— **累加顺序是可以照抄的**。
 * `sumRelTol(n)` 那条界（`numerics-2.md` / D-NUM-1）是在「本仓 `pySum` 用
 * Neumaier 补偿、numpy 用成对」这个前提下推的：两种**不同的**算法之间只能给界。
 * 而把 numpy 那一种**照着写一遍**，两边就是同一串浮点运算，差为 0。
 *
 * 实测（本机，numpy 2.4.4，n = 3/7/8/9/17/100/128/129/300/1000/4096）：
 * 十一组**全部逐位相同**（按 `float.hex()` 比）。
 *
 * > 「写容差之前先问这一步到底做了几次浮点运算」（`numerics-3.md` 第六节第一条）。
 * > 这里的答案是「**和 numpy 一样多、一样的顺序**」，所以答案是 0 次分岔。
 *
 * ## 为什么要有它（而不是继续用 `sum` + 容差）
 *
 * 批 4b 这一族里 `.mean()` / `.std()` 出现在**判据的分母**上：
 * `angular_concentration` 是「最大 bin ÷ 中位 bin」、`_band_peak` 的信噪是
 * 「峰 ÷ 中位」、`fast_axis_period_nm` 的 `base` 是一个 `median`。
 * 这些数再去和一个阈值比 —— 也就是说**一个相对 1e−15 的差可以翻一次判决**。
 * 一条有容差的断言挡不住那种翻转（它只说「数差不多」），而一条零容差的断言
 * 一旦红了，红的原因一定是算法本身。
 *
 * ## 算法（照抄 `numpy/_core/src/umath/loops_utils.h` 的 `pairwise_sum`）
 *
 * ```
 * n < 8            顺序累加，从 0.0 起头
 * n ≤ 128          8 个累加器各吃 n/8 个，再按 ((r0+r1)+(r2+r3)) + ((r4+r5)+(r6+r7)) 合并，余数顺序补
 * n > 128          对半切（**切点向下取到 8 的整数倍**），两半各自递归再相加
 * ```
 *
 * 那个「切点向下取到 8 的整数倍」不是优化，是**判据**：改成朴素的 `n/2`
 * 会让 n = 300 这类长度走另一棵树，于是每个数的最后一两位都不一样。
 *
 * ## 射程（说清楚它**不**覆盖什么）
 *
 * 它对的是「**一条连续的一维 float64**」的整体归约 —— 也就是
 * `arr.sum()` / `arr.mean()` / `arr[mask].mean()`（布尔索引产出连续副本）
 * / `arr2d.mean(axis=1)`（最后一轴连续，逐行走这条路）。
 *
 * **不**覆盖：`axis=0` 的归约（numpy 走的是逐行累加，不是成对）、非连续切片、
 * float32（另一套 SIMD 展开）。那几条各自还是要 `sumRelTol`。
 */

/** numpy 的 `PW_BLOCKSIZE`。 */
const PW_BLOCKSIZE = 128

function pairwise(a: Float64Array | readonly number[], off: number, n: number): number {
  if (n < 8) {
    let res = 0
    for (let i = 0; i < n; i += 1) res += a[off + i] as number
    return res
  }
  if (n <= PW_BLOCKSIZE) {
    const r0 = new Float64Array(8)
    for (let k = 0; k < 8; k += 1) r0[k] = a[off + k] as number
    let i = 8
    const stop = n - (n % 8)
    for (; i < stop; i += 8) {
      for (let k = 0; k < 8; k += 1) r0[k] = (r0[k] as number) + (a[off + i + k] as number)
    }
    let res =
      ((r0[0] as number) + (r0[1] as number) + ((r0[2] as number) + (r0[3] as number))) +
      ((r0[4] as number) + (r0[5] as number) + ((r0[6] as number) + (r0[7] as number)))
    for (; i < n; i += 1) res += a[off + i] as number
    return res
  }
  let n2 = n >> 1
  n2 -= n2 % 8
  return pairwise(a, off, n2) + pairwise(a, off + n2, n - n2)
}

/** `np.sum(a)` —— 一条连续一维 float64 的整体和。**逐位**等于 numpy。 */
export function npSum(a: Float64Array | readonly number[]): number {
  return pairwise(a, 0, a.length)
}

/** `np.mean(a)`。空数组给 `NaN`（同 numpy 的 `RuntimeWarning` + `nan`）。 */
export function npMean(a: Float64Array | readonly number[]): number {
  return a.length === 0 ? NaN : npSum(a) / a.length
}

/**
 * `np.var(a, ddof)` —— 照抄 numpy 的三步：
 * `mean = pairwise(a)/n` → `d = a − mean`、`d *= d` → `pairwise(d)/(n − ddof)`。
 *
 * ⚠️ **中心化用的那个 `mean` 也必须是成对求和的那一个**。用别的方式算均值
 * （哪怕更准）都会让每个 `d` 的最后一位不同，于是方差整体分岔 ——
 * 「更准」在这里是错的，判据是「和对面一样」。
 */
export function npVar(a: Float64Array | readonly number[], ddof = 0): number {
  const n = a.length
  if (n === 0) return NaN
  const m = npSum(a) / n
  const d = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const t = (a[i] as number) - m
    d[i] = t * t
  }
  return npSum(d) / (n - ddof)
}

/** `np.std(a, ddof)`。 */
export function npStd(a: Float64Array | readonly number[], ddof = 0): number {
  const v = npVar(a, ddof)
  return Number.isNaN(v) ? NaN : Math.sqrt(v)
}
