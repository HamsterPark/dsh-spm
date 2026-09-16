/**
 * 高度直方图上的台面位置 —— `MeasureStepHeight` 的 `_levels`(31)。
 *
 * ## 为什么台阶高度值得一个单独的判据
 *
 * 调平那条链路里已经有一个够用的稳健平面拟合（`fitPlaneRobust`），它的内点阈
 * **随噪声底自适应**，于是台阶上的点成为外点、拟合只落在单个台面上，减掉之后
 * **台阶被完整保留**。而 agent 手上唯一能调的去斜入口 `SubtractPlane_RANSAC`
 * 的内点阈**写死 100 pm**：在原子级平整的表面上 100 pm 比整个高度起伏还大，
 * 几乎所有点都算内点，RANSAC 退化成普通最小二乘。
 *
 * 2026-08-26 合成对照（注入 3 台面 × 235.455 pm，倾斜 0.8 pm/px）：
 *
 * ```
 * 噪声      写死 100 pm 的那版        自适应那版
 *          inlier  峰间距            inlier  峰间距
 *  2 pm    0.795   161.8 pm (−31%)   0.581   235.5 pm (−0.02%)
 * 16 pm    0.786   115.0 pm (−51%)   0.581   233.9 pm (−0.7%)
 * ```
 *
 * **能调到的那个把台阶低估三到五成，而且噪声越大错得越离谱** —— 而台阶高度是
 * Z 压电标定的基准（Au(111) d111 = 235.455 pm），用错的那个去标定，Z 会被标歪同样的幅度。
 *
 * ## `min_sep` 取得比半个台阶大
 *
 * 再小就会把同一个台面的肩部当成第二个台面（2026-08-26 踩过：一版 `min_sep=80 pm`
 * 报出一堆 `0.65×d111`）。
 *
 * ## 容差
 *
 * | 件 | 容差 | 为什么 |
 * |---|---|---|
 * | `np.percentile(v, [0.2, 99.8])` | **0** | 闭式插值（`numerics.percentile`） |
 * | `np.histogram` 的计数 | **0** | 数个数 |
 * | 三点滑动平均 | `sumRelTol(3)` | `a[i−1]·t + a[i]·t + a[i+1]·t`，**乘在里面**（numpy 就是这么算的），不是 `(a+a+a)/3` |
 * | 峰位 `centre[i]` | **0** | 两个 edge 的平均 |
 *
 * ⚠️ 峰的挑选用的是 `>=` 比较，**平台会挑到第一个**；三点滑动平均那点浮点差只要
 * 改变一次 `>=` 的结果，挑出来的峰就整格挪。所以金样的输入刻意让台面峰**彼此远离**
 * （3 个台面 × 235 pm，而 `min_sep` 是 110 pm），而不是靠容差去接住一次挑错。
 */
import { histogram, percentile } from 'dsh-spm-numerics'
import { finiteOf } from './nd.js'

export const LEVELS_BINS = 220
export const LEVELS_REL_HEIGHT = 0.1
export const LEVELS_MIN_SEP_PM = 110.0

/** 一个台面：`[高度 pm, 平滑后的峰高]`。 */
export type Level = readonly [number, number]

/** 高度直方图上的台面位置，按高度排序。点不够或分布退化时给空表。 */
export function levelsOf(
  zPm: readonly number[] | Float64Array,
  bins: number = LEVELS_BINS,
  rel: number = LEVELS_REL_HEIGHT,
  minSep: number = LEVELS_MIN_SEP_PM,
): Level[] {
  const v = finiteOf(zPm)
  if (v.length < 500) return []
  const lo = percentile(v, 0.2)
  const hi = percentile(v, 99.8)
  if (!(hi > lo)) return []
  const h = histogram(v, bins, [lo, hi])
  const centre = new Float64Array(bins)
  for (let i = 0; i < bins; i += 1) centre[i] = 0.5 * ((h.edges[i + 1] as number) + (h.edges[i] as number))
  // `np.convolve(hist, np.ones(3)/3.0, mode="same")` —— 系数**乘在每一项里**。
  const t = 1 / 3
  const smooth = new Float64Array(bins)
  for (let i = 0; i < bins; i += 1) {
    let s = 0
    for (let j = Math.max(0, i - 1); j <= Math.min(bins - 1, i + 1); j += 1) s += (h.counts[j] as number) * t
    smooth[i] = s
  }
  let top = 0
  for (let i = 0; i < bins; i += 1) if ((smooth[i] as number) > top) top = smooth[i] as number
  const peaks: [number, number][] = []
  for (let i = 1; i < bins - 1; i += 1) {
    const s = smooth[i] as number
    if (!(s >= (smooth[i - 1] as number) && s >= (smooth[i + 1] as number))) continue
    if (s <= top * rel) continue
    const c = centre[i] as number
    let near = -1
    for (let k = 0; k < peaks.length; k += 1) {
      if (Math.abs(c - ((peaks[k] as [number, number])[0] as number)) < minSep) {
        near = k
        break
      }
    }
    if (near < 0) peaks.push([c, s])
    else if (s > ((peaks[near] as [number, number])[1] as number)) peaks[near] = [c, s]
  }
  // `sorted(peaks)` —— 元组排序：先比高度位置，再比峰高。
  peaks.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return peaks
}
