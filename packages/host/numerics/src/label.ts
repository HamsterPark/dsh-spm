/**
 * 连通域（union-find）与 SSIM。
 *
 * ## 连通域的容差：**0**
 *
 * 它数的是**整数标签**，没有容差可言。但**邻接数是语义**：
 * 一条对角线在 4-邻接下是 n 个分开的域，在 8-邻接下是 1 个。
 * 金样里同一张掩膜录了两遍（`count4 = 5`、`count8 = 4`），
 * 于是「默认用哪个」这件事不可能被含糊过去。
 *
 * 标签的**编号顺序**也照 scipy：按**行优先扫到的先后**编，1 起算，0 是背景。
 * 编号顺序看起来无关紧要，直到有人拿 `labels == 1` 去取「第一个域」。
 *
 * ## SSIM 的容差：`64 · eps`（绝对）
 *
 * skimage 的 `structural_similarity` 缺省用 **7×7 均匀窗**（不是高斯），
 * 每个窗里算均值/方差/协方差再合成。误差来自那 49 次累加与几次除法，
 * 界在 `k · eps` 量级；SSIM 本身是 `[-1, 1]` 的量，所以用**绝对**容差。
 *
 * ⚠️ **`data_range` 必须显式给。** skimage 不给的话会按 dtype 猜，
 * 而它对 float 图的猜测（`1.0`）在一张以米为单位的形貌图上差着九个数量级 ——
 * 于是 C1/C2 两个稳定化常数完全失效，SSIM 退化成一个只反映噪声的数。
 */
import { matAt, type Mat } from './mat.js'
import { EPS, mean } from './stats.js'

export interface LabelResult {
  /** 行优先展平的标签。**0 是背景**，域从 1 起算。 */
  readonly labels: Int32Array
  readonly count: number
  /** 每个域的像素数，下标 0 对应标签 1。 */
  readonly sizes: Int32Array
}

/**
 * 连通域标记。`connectivity` 取 `4` 或 `8`。
 *
 * 两遍扫描 + union-find：第一遍给临时标签并记合并关系，第二遍按
 * **行优先首次出现的顺序**重编号（与 scipy 一致，见文件抬头）。
 */
export function labelConnected(mask: Mat, connectivity: 4 | 8 = 4): LabelResult {
  const { rows, cols } = mask
  const n = rows * cols
  const parent = new Int32Array(n).fill(-1)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] as number
    // 路径压缩
    let c = i
    while (parent[c] !== r) {
      const next = parent[c] as number
      parent[c] = r
      c = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  const on = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < rows && c < cols && matAt(mask, r, c) !== 0
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (!on(r, c)) continue
      const i = r * cols + c
      parent[i] = i
      // 只看**已经扫过**的邻居（上、左，以及 8-邻接下的左上、右上）
      if (on(r - 1, c)) union(i, (r - 1) * cols + c)
      if (on(r, c - 1)) union(i, r * cols + c - 1)
      if (connectivity === 8) {
        if (on(r - 1, c - 1)) union(i, (r - 1) * cols + c - 1)
        if (on(r - 1, c + 1)) union(i, (r - 1) * cols + c + 1)
      }
    }
  }

  const labels = new Int32Array(n)
  const renumber = new Map<number, number>()
  const sizes: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (parent[i] === -1) continue
    const root = find(i)
    let lab = renumber.get(root)
    if (lab === undefined) {
      lab = renumber.size + 1
      renumber.set(root, lab)
      sizes.push(0)
    }
    labels[i] = lab
    sizes[lab - 1] = (sizes[lab - 1] as number) + 1
  }
  return { labels, count: renumber.size, sizes: Int32Array.from(sizes) }
}

/** SSIM 的绝对容差。见文件抬头。 */
export const SSIM_ABS_TOL = 64 * EPS

/**
 * skimage 的 `structural_similarity`（二维、均匀窗、显式 `data_range`）。
 *
 * `win_size` 必须是**奇数**且不大于两边的短边 —— skimage 在这两条上都抛，
 * 而一个悄悄夹到边界的窗宽会让两次调用给出不可比的分数。
 */
export function ssim(a: Mat, b: Mat, dataRange: number, winSize = 7): number {
  if (a.rows !== b.rows || a.cols !== b.cols) {
    throw new RangeError(`SSIM 要两张同形状的图：${a.rows}×${a.cols} vs ${b.rows}×${b.cols}`)
  }
  if (winSize % 2 === 0) throw new RangeError(`win_size 必须是奇数：得到 ${winSize}`)
  if (winSize > Math.min(a.rows, a.cols)) {
    throw new RangeError(`win_size ${winSize} 大于图的短边 ${Math.min(a.rows, a.cols)}`)
  }
  if (!(dataRange > 0)) {
    throw new RangeError(`data_range 必须显式给且为正：得到 ${dataRange}（见 label.ts 抬头）`)
  }
  const K1 = 0.01
  const K2 = 0.03
  const C1 = (K1 * dataRange) ** 2
  const C2 = (K2 * dataRange) ** 2
  const half = (winSize - 1) / 2
  const npx = winSize * winSize
  // skimage 用 `ddof=1` 的无偏方差（它的 `cov_norm = NP / (NP - 1)`）
  const covNorm = npx / (npx - 1)

  const scores: number[] = []
  for (let r = half; r < a.rows - half; r += 1) {
    for (let c = half; c < a.cols - half; c += 1) {
      let sa = 0
      let sb = 0
      let saa = 0
      let sbb = 0
      let sab = 0
      for (let dr = -half; dr <= half; dr += 1) {
        for (let dc = -half; dc <= half; dc += 1) {
          const x = matAt(a, r + dr, c + dc)
          const y = matAt(b, r + dr, c + dc)
          sa += x
          sb += y
          saa += x * x
          sbb += y * y
          sab += x * y
        }
      }
      const ux = sa / npx
      const uy = sb / npx
      const vx = covNorm * (saa / npx - ux * ux)
      const vy = covNorm * (sbb / npx - uy * uy)
      const vxy = covNorm * (sab / npx - ux * uy)
      const num = (2 * ux * uy + C1) * (2 * vxy + C2)
      const den = (ux * ux + uy * uy + C1) * (vx + vy + C2)
      scores.push(num / den)
    }
  }
  return mean(scores)
}
