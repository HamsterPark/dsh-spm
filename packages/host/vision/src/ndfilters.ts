/**
 * `scipy.ndimage` 的三件 —— `uniform_filter` · `median_filter`（一维与二维）。
 *
 * ## 为什么落在 `vision/` 而不是 `numerics/`
 *
 * **只是这一轮的分工**：批 6c 也在往 `numerics/` 加原语，任务书说「不要改
 * `numerics/` 已有的文件；要加数值原语就写进交接，由主线合并时统一放」。
 * 按 `nd.ts` 抬头那条标准（**它有没有第二个消费方**），这三件的答案都是「有」：
 * 它们对的是 `scipy.ndimage` 本身，不是本族的判据。**搬家的建议写在
 * `docs/handoff/batch-6b.md` §7。**
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
 */
import { boundaryIndex, matOf, type BoundaryMode, type Mat } from 'dsh-spm-numerics'

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
  const { left, right } = windowSpan(s)
  const buf = new Float64Array(s)
  for (let i = 0; i < n; i += 1) {
    let w = 0
    for (let d = -left; d <= right; d += 1) {
      const k = boundaryIndex(i + d, n, mode)
      buf[w] = k === null ? 0 : (x[k] as number)
      w += 1
    }
    const sorted = Array.from(buf.subarray(0, w)).sort((a, b) => a - b)
    out[i] = sorted[rankOfWindow(w)] as number
  }
  return out
}

/** `scipy.ndimage.median_filter(m, size=size)` —— 方形 `size × size` 足迹。 */
export function medianFilter2d(m: Mat, size: number, mode: BoundaryMode = 'reflect'): Mat {
  const s = Math.trunc(size)
  const out = new Float64Array(m.rows * m.cols)
  if (s <= 1) {
    out.set(m.data)
    return matOf(m.rows, m.cols, out)
  }
  const { left, right } = windowSpan(s)
  const buf: number[] = []
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      buf.length = 0
      for (let dy = -left; dy <= right; dy += 1) {
        const ry = boundaryIndex(r + dy, m.rows, mode)
        for (let dx = -left; dx <= right; dx += 1) {
          const rx = boundaryIndex(c + dx, m.cols, mode)
          buf.push(ry === null || rx === null ? 0 : (m.data[ry * m.cols + rx] as number))
        }
      }
      const sorted = buf.slice().sort((a, b) => a - b)
      out[r * m.cols + c] = sorted[rankOfWindow(sorted.length)] as number
    }
  }
  return matOf(m.rows, m.cols, out)
}
