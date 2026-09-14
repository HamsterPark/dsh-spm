/**
 * 二维数组的载体 —— **行优先，一维 `Float64Array`**。
 *
 * ## 容差：**没有**
 *
 * 这一层不做算术，只做下标。它存在是为了把「行还是列」这件事**从每个算法里赶出去**：
 * 扫描帧、FFT 的中间结果、拟合的设计矩阵全是二维，而每写一次 `data[y * w + x]`
 * 就多一次把 `w` 写成 `h` 的机会 —— 那种错在方形帧上完全看不出来。
 *
 * ## 为什么不是 `number[][]`
 *
 * 嵌套数组每一行是一个独立对象：一张 512×512 的帧是 512 个数组 + 26 万个装箱的数。
 * `Float64Array` 是一块连续内存，而且**行长天然齐**——`number[][]` 允许一张
 * 每行不一样长的「图」存在，那种东西在拟合里会静默地少一个方程。
 */

/** 一张行优先的二维表。`data.length === rows * cols` 是构造时就保证的。 */
export interface Mat {
  readonly rows: number
  readonly cols: number
  readonly data: Float64Array
}

/** 形状对不上就抛 —— 一份形状撒谎的矩阵比没有更坏。 */
export class MatShapeError extends RangeError {
  override readonly name = 'MatShapeError'
}

export function matOf(rows: number, cols: number, data: Float64Array | readonly number[]): Mat {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 0 || cols < 0) {
    throw new MatShapeError(`Mat 的形状必须是自然数：得到 ${rows}×${cols}`)
  }
  if (data.length !== rows * cols) {
    throw new MatShapeError(`Mat ${rows}×${cols} 需要 ${rows * cols} 个元素，实得 ${data.length}`)
  }
  return { rows, cols, data: data instanceof Float64Array ? data : Float64Array.from(data) }
}

/** 全零。 */
export function matZeros(rows: number, cols: number): Mat {
  return matOf(rows, cols, new Float64Array(rows * cols))
}

/** 行表 → `Mat`。**行长不齐就抛**，见文件抬头。 */
export function matFromRows(rows: readonly (readonly number[])[]): Mat {
  if (rows.length === 0) return matZeros(0, 0)
  const cols = (rows[0] as readonly number[]).length
  const data = new Float64Array(rows.length * cols)
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] as readonly number[]
    if (row.length !== cols) {
      throw new MatShapeError(`第 0 行 ${cols} 列，第 ${r} 行 ${row.length} 列 —— 这不是一张矩形的图`)
    }
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = row[c] as number
  }
  return matOf(rows.length, cols, data)
}

/** `Mat` → 行表。给要逐行看的地方（金样比对、写 `.npy`）。 */
export function matToRows(m: Mat): number[][] {
  const out: number[][] = []
  for (let r = 0; r < m.rows; r += 1) {
    const row = new Array<number>(m.cols)
    for (let c = 0; c < m.cols; c += 1) row[c] = m.data[r * m.cols + c] as number
    out.push(row)
  }
  return out
}

/** 取一个元素。**越界抛**，不给 `undefined` —— 一个 `undefined` 进算术就是 `NaN`，
 *  而 `NaN` 会穿过每一条 `>` `<` 的检查（同 D-SI-1）。 */
export function matAt(m: Mat, r: number, c: number): number {
  if (r < 0 || r >= m.rows || c < 0 || c >= m.cols) {
    throw new MatShapeError(`下标越界：(${r}, ${c}) 不在 ${m.rows}×${m.cols} 里`)
  }
  return m.data[r * m.cols + c] as number
}

/** 取一行（复制，不是视图 —— 视图会让调用方无意中改到原矩阵）。 */
export function matRow(m: Mat, r: number): Float64Array {
  if (r < 0 || r >= m.rows) throw new MatShapeError(`行下标 ${r} 不在 0..${m.rows - 1}`)
  return m.data.slice(r * m.cols, (r + 1) * m.cols)
}

/** 取一列。 */
export function matCol(m: Mat, c: number): Float64Array {
  if (c < 0 || c >= m.cols) throw new MatShapeError(`列下标 ${c} 不在 0..${m.cols - 1}`)
  const out = new Float64Array(m.rows)
  for (let r = 0; r < m.rows; r += 1) out[r] = m.data[r * m.cols + c] as number
  return out
}

/** 转置。 */
export function matTranspose(m: Mat): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) out[c * m.rows + r] = m.data[r * m.cols + c] as number
  }
  return matOf(m.cols, m.rows, out)
}

/** 子块（`[r0, r1) × [c0, c1)`）。越界抛。 */
export function matSlice(m: Mat, r0: number, r1: number, c0: number, c1: number): Mat {
  if (r0 < 0 || c0 < 0 || r1 > m.rows || c1 > m.cols || r1 < r0 || c1 < c0) {
    throw new MatShapeError(`切片 [${r0}, ${r1}) × [${c0}, ${c1}) 不在 ${m.rows}×${m.cols} 里`)
  }
  const rows = r1 - r0
  const cols = c1 - c0
  const out = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) out[r * cols + c] = m.data[(r0 + r) * m.cols + (c0 + c)] as number
  }
  return matOf(rows, cols, out)
}

/** 逐元素映射。形状照搬。 */
export function matMap(m: Mat, f: (v: number, r: number, c: number) => number): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      out[r * m.cols + c] = f(m.data[r * m.cols + c] as number, r, c)
    }
  }
  return matOf(m.rows, m.cols, out)
}
