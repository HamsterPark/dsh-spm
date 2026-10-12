/**
 * `scipy.ndimage` 的三件 —— `uniform_filter` · `median_filter`（一维与二维）。
 *
 * > **来处**：批 6b 落在 `vision/src/ndfilters.ts`（那一轮 `numerics/` 由批 6c 主用），
 * > 由收尾支线按该批交接 §7 搬来。判据、容差、抬头一个字未改，只改了 import 路径。
 * > 按 `vision/nd.ts` 抬头那条标准（**它有没有第二个消费方**），这三件的答案都是
 * > 「有」：它们对的是 `scipy.ndimage` 本身，不是视觉那一族的判据。
 *
 * ## `uniformFilter1d` 是**跑动和**，而这不是实现细节
 *
 * scipy 的 `NI_UniformFilter1D` 先把第一个窗口加起来，之后每挪一格做一次
 * `sum += 进来的 − 出去的`。于是：
 *
 * > **一个 NaN 进了窗口，这一行剩下的每一个输出都是 NaN** ——
 * > 哪怕那个 NaN 早就滑出窗口了。
 *
 * 因为 `NaN − NaN = NaN`，跑动和一旦被污染就再也回不来。实测
 * （`uniform_filter1d(arange(20) 第 5 位换成 nan, 5)`）：下标 3 起 **17 个全是 NaN**，
 * 而「窗口里有 NaN」本来只该影响 5 个。
 *
 * 这件事在 `scan_prep.measure_frame` 里直接决定判据：粗糙度
 * `rough = MAD(plane − uniform_filter(plane, (1,9)))` 的输入是**带 NaN 的**帧
 * （未扫完的帧是常态），于是**每一行只有第一个 NaN 之前的那一段参与了粗糙度**。
 * 换成「逐窗口独立求和」会让未扫完的帧多出一大片有限值，`rough` 变，
 * `sep_over_rough` 跟着变，而 `sep_over_rough > step_sep` 是「有没有台阶」那道闸。
 * **照抄跑动和，不是照抄一个 bug，是照抄那道闸的输入。**
 *
 * ## 容差
 *
 * | 件 | 容差 | 为什么 |
 * |---|---|---|
 * | `medianFilter1d` / `medianFilter2d` | **0** | 输出是输入里的某一个元素，逐位搬运。偶数窗取**上**中位（scipy 的 rank = `size/2`），这是选择不是舍入 |
 * | `uniformFilter1d` / `uniformFilter2d` | **0** | 跑动和照抄，于是两边是同一串浮点加减；每一步都是 `sum += a − b` 与 `sum / size` |
 *
 * 两件的容差都是 0，**而这正是它们该待在这一层的理由**：
 * 零容差的那一档是替有容差的那些档报警的人（`numerics-2.md` 第五节第一条）。
 *
 * ## 中值滤波不再给每个窗口整个排序（2026-10-13）
 *
 * 原先每个窗口做一次 `Array.prototype.sort((a, b) => a − b)` 再取第 `rank` 个：
 * 15 × 15 的窗口在 256² 的图上要 4 秒（`detect_blobs` 的大半时间），现在 0.3 秒左右。
 * 取的是**同一个元素**，只是不排序：
 *
 * - **窗口里没有 NaN**：V8 的排序是稳定的（TimSort），而 `a − b` 在没有 NaN 时是全序：
 *   有限值相减只有相等才得 0（渐进下溢），溢出成 ±∞ 也不改符号；`∞ − ∞` 得 NaN，
 *   排序把它当作相等，而两个同号的 ∞ 本来就相等。于是第 `rank` 个就是第 `rank`
 *   小的值、相等的值取窗口里最先出现的那个。相等的非零值逐位相同；**只有 −0 与 +0
 *   相等而位不同**，所以选出 0 时，按窗口顺序数到第 `rank − (负数个数)` 个零取它。
 *   找第 `rank` 小用三路划分的快速选择；剩下的段短了插入排序，划分轮数超出预算就把剩下
 *   那段整段排序（内省选择）。
 * - **窗口里有 NaN**：比较器把 NaN 当作与谁都「相等」，那不再是一个序，结果取决于
 *   TimSort 每一步比了谁 —— 这种窗口**照旧走那一次排序**，所以逐位不变。
 *
 * 与旧实现逐位相同由 `ndfilters.test.ts` 钉住：旧实现留在测试文件里作参照，逐位比对
 * 两百多万个二维窗口（一百万以上含 NaN，也有别的位型的 NaN）与二十多万个一维窗口，
 * 含 ±0、±∞、大量相等值、五种边界、奇偶窗，外加一个逼到整段排序的窗口。
 */
import { boundaryIndex, type BoundaryMode } from './filters.js'
import { matOf, type Mat } from './mat.js'

/**
 * scipy 的窗口约定：`size1 = ⌊size/2⌋` 在左、`size2 = size − size1 − 1` 在右。
 * 奇数对称；**偶数偏左**（`size=4` ⇒ `[i−2, i+1]`，实测钉住）。
 */
export function windowSpan(size: number): { left: number; right: number } {
  const s = Math.trunc(size)
  const left = Math.floor(s / 2)
  return { left, right: s - left - 1 }
}

/**
 * `scipy.ndimage.uniform_filter1d` —— **跑动和**，见文件抬头。
 *
 * `size <= 1` 时 scipy 返回输入的拷贝（窗口就是它自己）。
 */
export function uniformFilter1d(x: Float64Array | readonly number[], size: number, mode: BoundaryMode = 'reflect'): Float64Array {
  const n = x.length
  const out = new Float64Array(n)
  const s = Math.trunc(size)
  if (n === 0) return out
  if (s <= 1) {
    for (let i = 0; i < n; i += 1) out[i] = x[i] as number
    return out
  }
  const { left } = windowSpan(s)
  const tap = (i: number): number => {
    const k = boundaryIndex(i, n, mode)
    return k === null ? 0 : (x[k] as number)
  }
  // 第一个窗口：逐项相加（与 scipy 的初始化同一串加法）。
  let sum = 0
  for (let j = 0; j < s; j += 1) sum += tap(j - left)
  out[0] = sum / s
  for (let i = 1; i < n; i += 1) {
    sum += tap(i - left + s - 1) - tap(i - left - 1)
    out[i] = sum / s
  }
  return out
}

/** `scipy.ndimage.uniform_filter(m, (sizeY, sizeX))` —— 可分离，先 y 后 x（与 scipy 同序）。 */
export function uniformFilter2d(m: Mat, sizeY: number, sizeX: number, mode: BoundaryMode = 'reflect'): Mat {
  let cur = m
  if (Math.trunc(sizeY) > 1) {
    const out = new Float64Array(m.rows * m.cols)
    const col = new Float64Array(m.rows)
    for (let c = 0; c < m.cols; c += 1) {
      for (let r = 0; r < m.rows; r += 1) col[r] = cur.data[r * m.cols + c] as number
      const f = uniformFilter1d(col, sizeY, mode)
      for (let r = 0; r < m.rows; r += 1) out[r * m.cols + c] = f[r] as number
    }
    cur = matOf(m.rows, m.cols, out)
  }
  if (Math.trunc(sizeX) > 1) {
    const out = new Float64Array(m.rows * m.cols)
    const row = new Float64Array(m.cols)
    for (let r = 0; r < m.rows; r += 1) {
      for (let c = 0; c < m.cols; c += 1) row[c] = cur.data[r * m.cols + c] as number
      const f = uniformFilter1d(row, sizeX, mode)
      for (let c = 0; c < m.cols; c += 1) out[r * m.cols + c] = f[c] as number
    }
    cur = matOf(m.rows, m.cols, out)
  }
  return cur === m ? matOf(m.rows, m.cols, Float64Array.from(m.data)) : cur
}

/**
 * scipy 的秩滤波取的是排序后第 `rank` 个，而 `median_filter` 的
 * `rank = ⌊n/2⌋` —— **偶数个样本取上中位**，不是两个中位数的平均。
 *
 * 这一条要写下来：`np.median` 会平均，`ndi.median_filter` 不会。
 * 同 D-VISION-2 的形状（两个看起来该合并的东西，合并会默默改掉判决）。
 */
export function rankOfWindow(n: number): number {
  return Math.floor(n / 2)
}

/**
 * `a[0..n)`（无 NaN，会被打乱）排好之后第 `k` 个**值**：三路划分的快速选择，三数取中
 * （段首、段中、段尾）作枢轴。剩下的段不长于 16 时插入排序；划分了 `2⌈log₂ n⌉ + 4` 轮
 * 还没完（枢轴屡屡选坏）就把剩下那段用类型化数组的数值排序排好（内省选择）。
 * −0 与 +0 谁排在前都无妨：选出 0 时由 {@link zeroOfRank} 回到窗口里去认是哪一个。
 */
function selectKth(a: Float64Array, n: number, k: number): number {
  let lo = 0
  let hi = n - 1
  let budget = 2 * Math.ceil(Math.log2(n)) + 4
  while (hi - lo >= 16) {
    if (budget === 0) {
      a.subarray(lo, hi + 1).sort()
      return a[k] as number
    }
    budget -= 1
    const x = a[lo] as number
    const y = a[lo + ((hi - lo) >> 1)] as number
    const z = a[hi] as number
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y
    let lt = lo
    let gt = hi
    let i = lo
    while (i <= gt) {
      const v = a[i] as number
      if (v < pivot) {
        a[i] = a[lt] as number
        a[lt] = v
        lt += 1
        i += 1
      } else if (v > pivot) {
        a[i] = a[gt] as number
        a[gt] = v
        gt -= 1
      } else {
        i += 1
      }
    }
    if (k < lt) hi = lt - 1
    else if (k > gt) lo = gt + 1
    else return pivot
  }
  for (let i = lo + 1; i <= hi; i += 1) {
    const v = a[i] as number
    let j = i - 1
    while (j >= lo && (a[j] as number) > v) {
      a[j + 1] = a[j] as number
      j -= 1
    }
    a[j + 1] = v
  }
  return a[k] as number
}

/**
 * 第 `rank` 个是 0 时，旧实现的稳定排序取的是哪一个零：排在它前面的是全部负数，
 * 再按窗口顺序数零。`win[off .. off + n)` 是窗口，原顺序。
 */
function zeroOfRank(win: Float64Array, off: number, n: number, rank: number): number {
  const end = off + n
  let k = rank
  for (let i = off; i < end; i += 1) if ((win[i] as number) < 0) k -= 1
  for (let i = off; i < end; i += 1) {
    if (win[i] === 0) {
      if (k === 0) return win[i] as number
      k -= 1
    }
  }
  return 0 // 到不了：第 rank 个是 0，它就在窗口里
}

/** 含 NaN 的窗口照旧实现原样做：比较器 `a − b` 的那一次排序，取第 `rank` 个（见文件抬头）。 */
function sortedAt(win: Float64Array, rank: number): number {
  return Array.from(win).sort((a, b) => a - b)[rank] as number
}

/** 越界下标按边界模式折回后的表：`at[t]` 是偏移 `t − left` 处的下标，`constant` 折不回来记 −1。 */
function foldedIndices(n: number, left: number, right: number, mode: BoundaryMode): Int32Array {
  const at = new Int32Array(n + left + right)
  for (let t = 0; t < at.length; t += 1) {
    const k = boundaryIndex(t - left, n, mode)
    at[t] = k === null ? -1 : k
  }
  return at
}

/** `scipy.ndimage.median_filter` 的一维情形。容差 **0**（输出是输入里的某一个元素）。 */
export function medianFilter1d(x: Float64Array | readonly number[], size: number, mode: BoundaryMode = 'reflect'): Float64Array {
  const n = x.length
  const out = new Float64Array(n)
  const s = Math.trunc(size)
  if (n === 0) return out
  if (s <= 1) {
    for (let i = 0; i < n; i += 1) out[i] = x[i] as number
    return out
  }
  const sel = new Float64Array(s) // 无穷大的 size 在这里抛 RangeError，与原先一样
  if (!Number.isFinite(s)) return out.fill(NaN) // NaN 的 size：窗口是空的，原先取到 undefined，即 NaN
  const { left, right } = windowSpan(s)
  const at = foldedIndices(n, left, right, mode)
  // 补好边的信号：第 i 个窗口是 padded[i .. i + s)
  const padded = new Float64Array(at.length)
  for (let t = 0; t < at.length; t += 1) {
    const k = at[t] as number
    padded[t] = k < 0 ? 0 : (x[k] as number)
  }
  const rank = rankOfWindow(s)
  for (let i = 0; i < n; i += 1) {
    let hasNaN = false
    for (let d = 0; d < s; d += 1) {
      const v = padded[i + d] as number
      sel[d] = v
      if (v !== v) hasNaN = true
    }
    if (hasNaN) {
      out[i] = sortedAt(sel, rank)
    } else {
      const v = selectKth(sel, s, rank)
      out[i] = v === 0 ? zeroOfRank(padded, i, s, rank) : v
    }
  }
  return out
}

/** `(r, c)` 处的窗口按原顺序（先行后列）从补好边的矩阵抄进 `win`；返回窗口里有没有 NaN。 */
function gatherWindow(padded: Float64Array, pc: number, r: number, c: number, s: number, win: Float64Array): boolean {
  let w = 0
  let hasNaN = false
  for (let dy = 0; dy < s; dy += 1) {
    const base = (r + dy) * pc + c
    for (let dx = 0; dx < s; dx += 1) {
      const v = padded[base + dx] as number
      win[w] = v
      if (v !== v) hasNaN = true
      w += 1
    }
  }
  return hasNaN
}

/** `scipy.ndimage.median_filter(m, size=size)` —— 方形 `size × size` 足迹。 */
export function medianFilter2d(m: Mat, size: number, mode: BoundaryMode = 'reflect'): Mat {
  const s = Math.trunc(size)
  const out = new Float64Array(m.rows * m.cols)
  if (s <= 1) {
    out.set(m.data)
    return matOf(m.rows, m.cols, out)
  }
  if (out.length === 0) return matOf(m.rows, m.cols, out) // 没有窗口，也就不必补边
  // NaN 或无穷大的 size：每个窗口都是空的，原先取到 undefined，即 NaN
  if (!Number.isFinite(s)) return matOf(m.rows, m.cols, out.fill(NaN))
  const { left, right } = windowSpan(s)
  const rowAt = foldedIndices(m.rows, left, right, mode)
  const colAt = foldedIndices(m.cols, left, right, mode)
  // 补好边的矩阵：(r, c) 处的窗口是它第 r .. r + s − 1 行、第 c .. c + s − 1 列那一块
  const pc = colAt.length
  const padded = new Float64Array(rowAt.length * pc)
  for (let t = 0; t < rowAt.length; t += 1) {
    const ry = rowAt[t] as number
    for (let u = 0; u < pc; u += 1) {
      const rx = colAt[u] as number
      padded[t * pc + u] = ry < 0 || rx < 0 ? 0 : (m.data[ry * m.cols + rx] as number)
    }
  }
  const n = s * s
  const sel = new Float64Array(n)
  const rank = rankOfWindow(n)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      let v: number
      if (gatherWindow(padded, pc, r, c, s, sel)) {
        v = sortedAt(sel, rank)
      } else {
        v = selectKth(sel, n, rank)
        if (v === 0) {
          gatherWindow(padded, pc, r, c, s, sel) // 选择打乱了 sel：认零要原顺序的窗口
          v = zeroOfRank(sel, 0, n, rank)
        }
      }
      out[r * m.cols + c] = v
    }
  }
  return matOf(m.rows, m.cols, out)
}
