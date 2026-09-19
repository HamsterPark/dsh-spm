/**
 * `kde_layers` 那条链上的四件 numpy 原语 —— `linspace` / `digitize` /
 * **按显式边界**的 `histogram` / 二维 `gradient`。
 *
 * ## 为什么单开一个文件，而不是并进 `calculus.ts` / `stats.ts`
 *
 * 纯粹是**并行纪律**：这一轮 7a 三条支线同时开工，共享文件只许写在各自的锚点里，
 * 而 `calculus.ts`（批 6c 的 `np.gradient(y, x)` 与 `np.trapezoid`）与 `stats.ts`
 * （`histogram(x, bins, range)`）都没有锚点。**这不是一个归属判断** ——
 * `gradient2dUniform` 与 `gradient1d` 是同一个 numpy 函数的两条分支，
 * `histogramFromEdges` 与 `histogram` 是同一个 numpy 函数的两条入口，
 * 收尾支线应当把这四件并回去。写在这里是为了让那次合并是**机械移动**。
 *
 * ## 容差：四件**全部为 0**
 *
 * | 件 | 对的是 | 为什么是 0 |
 * |---|---|---|
 * | `linspace` | `np.linspace(a, b, n)` | 逐字照抄 numpy 的式子（`i·step + start`，**末项直接置 stop**）。见下 |
 * | `digitize` | `np.digitize(x, bins)` | 它返回的是**下标**，整数 |
 * | `histogramFromEdges` | `np.histogram(x, bins=<边界数组>)` | 它数的是**个数**，整数 |
 * | `gradient2dUniform` | `np.gradient(f)`（二维、间距 1） | 中心差分是 `(f[i+1]−f[i−1])/2`，两端是一次减法。**没有累加** ⇒ 逐位 |
 *
 * 给它们容差等于把一次「挑错了格子」藏起来，而挑错格子正是这一族唯一会犯的错
 * （`numerics/index.ts` 抬头那一段）。
 */
import { matOf, type Mat } from './mat.js'

/**
 * `np.linspace(start, stop, num)`（`endpoint=True`）。**容差 0。**
 *
 * ⚠️ 照抄 numpy 的两步：先 `y[i] = i · step + start`（`step = (stop−start)/(num−1)`），
 * **再把最后一项直接置成 `stop`**。那一步不是收尾修饰 —— 不置的话
 * `255 · step + start` 与 `stop` 通常差一两个 ulp，而这个数组是要当
 * **直方图边界**用的：最后一格的右边界差一个 ulp，恰好落在上面的样本就换一个格子。
 */
export function linspace(start: number, stop: number, num: number): Float64Array {
  if (!Number.isInteger(num) || num < 0) throw new RangeError(`linspace 的 num 必须是非负整数：${num}`)
  const y = new Float64Array(num)
  if (num === 0) return y
  const div = num - 1
  if (div > 0) {
    const step = (stop - start) / div
    for (let i = 0; i < num; i += 1) y[i] = i * step
  }
  for (let i = 0; i < num; i += 1) y[i] = (y[i] as number) + start
  if (num > 1) y[num - 1] = stop
  return y
}

/**
 * `np.digitize(x, bins)`（`bins` 递增、`right=False`）。**容差 0。**
 *
 * 返回 `i` 使得 `bins[i−1] <= x < bins[i]`；小于 `bins[0]` 给 0，
 * 大于等于 `bins[-1]` 给 `bins.length`。numpy 自己就是
 * `searchsorted(bins, x, side='right')` —— 这里逐字同义。
 *
 * ⚠️ 边界是**左闭**：`x === bins[k]` 落进 `k+1`，不是 `k`。这一个字符决定一个
 * 恰好落在层间分界上的像素归哪一层，而那正是 `kde_layers` 的输出。
 */
export function digitize(x: number, bins: Float64Array | readonly number[]): number {
  let lo = 0
  let hi = bins.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < ((bins as readonly number[])[mid] as number)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * `np.histogram(x, bins=<显式边界数组>)` 的 **counts**。**容差 0。**
 *
 * ## 为什么不能用 `histogram`（`stats.ts` 那一份）
 *
 * 那一份对的是 `np.histogram(x, bins=<整数>, range=(lo, hi))` ——
 * numpy 在**整数 bins** 这条路上走的是「算术定位」（`floor((v−lo)/width)`）；
 * 给一个**边界数组**时它走的是另一条路，`_search_sorted_inclusive`：
 *
 * ```python
 * np.concatenate((sa.searchsorted(bin_edges[:-1], 'left'),
 *                 sa.searchsorted(bin_edges[-1:], 'right')))
 * ```
 *
 * 两条路的**归属规则相同**（左闭右开，最后一格右闭），但**算法不同**：
 * 一个用乘除定位，一个逐边界比较。在一个样本恰好落在内部边界上时（而 KDE 的
 * 输入里这件事会真的发生 —— `linspace` 的边界与 `percentile` 的端点同源），
 * 两者可以差一个计数。`kde_layers` 的调用形式是 `bins=np.linspace(lo, hi, 257)`
 * ⇒ 必须走这一条。
 *
 * 落在 `[edges[0], edges[-1]]` 之外的样本不计；`NaN` 也不计（numpy 的排序把
 * NaN 排在末尾，于是每一次 `searchsorted` 都数不到它）。
 */
export function histogramFromEdges(
  xs: readonly number[] | Float64Array,
  edges: Float64Array | readonly number[],
): Int32Array {
  const nb = edges.length - 1
  if (nb < 1) throw new RangeError(`histogramFromEdges 至少要两个边界：得到 ${edges.length}`)
  const counts = new Int32Array(nb)
  const last = (edges as readonly number[])[nb] as number
  for (let i = 0; i < xs.length; i += 1) {
    const v = (xs as readonly number[])[i] as number
    if (Number.isNaN(v)) continue
    // `digitize` 给的是「左闭右开」的格号；最后一格右闭要单独接一下。
    if (v === last) {
      counts[nb - 1] = (counts[nb - 1] as number) + 1
      continue
    }
    const k = digitize(v, edges) - 1
    if (k < 0 || k >= nb) continue
    counts[k] = (counts[k] as number) + 1
  }
  return counts
}

/**
 * `np.gradient(f)` 的二维、**间距 1**、`edge_order=1` 那一档 —— 返回 `[gy, gx]`
 * （轴 0 在前，与 numpy 同序）。**容差 0。**
 *
 * * 内部：`(f[i+1] − f[i−1]) / 2`（numpy 在等距时走的就是这条减法，
 *   **不是**三系数那条 —— 见 `calculus.ts` 的 D-NUM-24，那换的是算法不是速度）；
 * * 两端（`edge_order=1`）：`f[1] − f[0]` 与 `f[-1] − f[-2]`。
 *
 * 轴长小于 2 时 numpy 抛 `ValueError`，这里同样抛。
 */
export function gradient2dUniform(m: Mat): readonly [Mat, Mat] {
  if (m.rows < 2 || m.cols < 2) {
    throw new RangeError(`np.gradient 要求每个轴至少 2 个样本：shape=(${m.rows}, ${m.cols})`)
  }
  const at = (r: number, c: number): number => m.data[r * m.cols + c] as number
  const gy = new Float64Array(m.rows * m.cols)
  const gx = new Float64Array(m.rows * m.cols)
  for (let c = 0; c < m.cols; c += 1) {
    gy[c] = at(1, c) - at(0, c)
    gy[(m.rows - 1) * m.cols + c] = at(m.rows - 1, c) - at(m.rows - 2, c)
    for (let r = 1; r < m.rows - 1; r += 1) gy[r * m.cols + c] = (at(r + 1, c) - at(r - 1, c)) / 2
  }
  for (let r = 0; r < m.rows; r += 1) {
    gx[r * m.cols] = at(r, 1) - at(r, 0)
    gx[r * m.cols + m.cols - 1] = at(r, m.cols - 1) - at(r, m.cols - 2)
    for (let c = 1; c < m.cols - 1; c += 1) gx[r * m.cols + c] = (at(r, c + 1) - at(r, c - 1)) / 2
  }
  return [matOf(m.rows, m.cols, gy), matOf(m.rows, m.cols, gx)]
}

/**
 * `np.argsort(v)[::-1]` —— 从大到小的下标。
 *
 * ## ⚠️ 与 numpy **只在并列时**可能不同，而那不是可以容差掉的东西
 *
 * numpy 的 `argsort` 缺省是 `quicksort`（实为 introsort），**不稳定**；这里是
 * 稳定排序再翻转。值两两不同时两边给出**同一个**排列（排序的答案唯一）；
 * 有并列时谁在前由各自的实现决定。
 *
 * 唯一的消费方 `_hist_modes` 拿它取「prominence 最大的前 `max_levels` 个峰」，
 * 然后**把取出来的下标再排序一遍**（`np.sort(pk[order])`）—— 所以只有
 * **并列恰好跨在截断线上**时答案才会不同。金样那一格（`many_layers`）刻意让
 * 每个峰的 prominence 两两不同，于是那道截断闸有输入、而且两边同解。
 *
 * 这是批 6c §9② 那一课的形状：**排序键在数学上恰好相等**是一种掷骰子，
 * 躲开它的办法是破坏并列本身，不是给它一条容差。
 */
export function argsortDesc(values: readonly number[] | Float64Array): Int32Array {
  const idx = Array.from({ length: values.length }, (_v, i) => i)
  idx.sort((a, b) => {
    const va = (values as readonly number[])[a] as number
    const vb = (values as readonly number[])[b] as number
    if (va < vb) return -1
    if (va > vb) return 1
    return a - b
  })
  idx.reverse()
  return Int32Array.from(idx)
}
