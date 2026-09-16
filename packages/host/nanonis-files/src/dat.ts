/**
 * Nanonis `.dat` —— 单点谱（bias spectroscopy 等）。
 *
 * 布局（旧仓对照实际导出的文件核过）：
 *
 * ```
 * <key>\t<value>
 * ...
 * [DATA]
 * <列名行，制表符分隔>
 * <数值行>
 * ```
 *
 * 两条旧仓自己纠正过的：分隔符是**制表符不是 `=`**；列名行在 `[DATA]`
 * **之后**那一行，不是之前。
 *
 * ## 参差的行：按**众数宽度**补 NaN，不丢整份数据
 *
 * 一次截断的末行、一个多出来的列、一行解析成别的宽度 —— 在 NumPy 2.x 里
 * `np.array([[1,2],[3]])` 直接抛，于是**一行坏行会让整份数据没了**。
 * 旧仓的修法是取众数宽度：短的补 NaN，长的截断。
 *
 * 用众数而不是最大/最小，是因为它**不被一条落单的坏行带偏**——
 * 一次扫描有几百行，坏的通常只有一两行。
 */
import { assertReadableSize, pyFloat } from './common.js'

export interface DatFile {
  readonly header: Readonly<Record<string, string>>
  /** 列名 → 一列数。**NaN 是合法值**（补位，或者仪器自己写的缺点位）。 */
  readonly columns: Readonly<Record<string, Float64Array>>
}

/** 读一个 `.dat`。永不抛（除了尺寸闸）：读不出数据就交一个空的 `columns`。 */
export function readDat(bytes: Uint8Array, what = '<dat>'): DatFile {
  assertReadableSize(bytes.byteLength, what)
  // 旧仓用 `open(path, "r", errors="replace")` —— **本地编码**。
  // 这里固定 UTF-8/替换：见交接文件，那是一处平台相关的分岔，不是我们引入的。
  const text = new TextDecoder('utf-8').decode(bytes)
  const lines = text.split(/\r\n|\n|\r/)

  const header: Record<string, string> = {}
  let dataStart = 0
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i] as string
    if (s.trim() === '[DATA]') {
      dataStart = i + 1
      break
    }
    if (s.trim() === '') continue
    const parts = s.split('\t')
    const key = (parts[0] as string).trim()
    if (key === '') continue
    // 多制表符的行（少见）：第一个制表符之后的全部拼回去
    header[key] = parts.length > 1 ? parts.slice(1).join('\t').trim() : ''
  }
  if (dataStart === 0) return { header, columns: {} }

  let columnNames: string[] = []
  if (dataStart < lines.length) {
    columnNames = (lines[dataStart] as string).split('\t').map((c) => c.trim()).filter((c) => c !== '')
    dataStart += 1
  }

  const values: number[][] = []
  for (const line of lines.slice(dataStart)) {
    const s = line.trim()
    if (s === '') continue
    const row: number[] = []
    let ok = true
    for (const tok of s.split('\t')) {
      const v = pyFloat(tok)
      if (v === null) {
        ok = false
        break
      }
      row.push(v)
    }
    // 解析不了的行**整行跳过**，别的照读 —— 一行垃圾不该让后面的数据消失
    if (ok) values.push(row)
  }
  if (values.length === 0) return { header, columns: {} }

  const widths = values.map((r) => r.length)
  if (new Set(widths).size > 1) {
    const tally = new Map<number, number>()
    for (const w of widths) tally.set(w, (tally.get(w) ?? 0) + 1)
    // 众数；并列时取**先出现**的那个宽度（同 Python `Counter.most_common`
    // 在等计数时保持插入序）
    let ncols = widths[0] as number
    let best = -1
    for (const w of widths) {
      const c = tally.get(w) as number
      if (c > best) {
        best = c
        ncols = w
      }
    }
    for (let i = 0; i < values.length; i++) {
      const row = values[i] as number[]
      values[i] = row.length >= ncols
        ? row.slice(0, ncols)
        : [...row, ...Array<number>(ncols - row.length).fill(NaN)]
    }
  }

  const nRows = values.length
  const nCols = (values[0] as number[]).length
  const columns: Record<string, Float64Array> = {}
  const take = (j: number): Float64Array => {
    const col = new Float64Array(nRows)
    for (let r = 0; r < nRows; r++) col[r] = (values[r] as number[])[j] as number
    return col
  }
  for (let j = 0; j < columnNames.length && j < nCols; j++) {
    columns[columnNames[j] as string] = take(j)
  }
  // 列名缺席或比数据短 ⇒ 剩下的用位置命名，**不丢数据**
  for (let j = columnNames.length; j < nCols; j++) columns[`column_${j}`] = take(j)
  if (Object.keys(columns).length === 0) {
    for (let j = 0; j < nCols; j++) columns[`column_${j}`] = take(j)
  }
  return { header, columns }
}
