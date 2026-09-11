/**
 * `.npy` v1.0 编码 —— `GrabScanFrameData` 交出去的是一个**文件路径**，不是数组。
 *
 * 也就是说这个技能的产物是**一份文件**，而它的判据只能落在**字节**上：一个「大概能
 * 用 numpy 读回来」的实现，在 `np.load` 抛异常之前一切看起来都正常——而那时那一帧
 * 已经扫完了，缓冲区里也没有第二份。
 *
 * 所以判据是 `spec/golden/frames_presets.json` 里 8 份**真 numpy 写出来的完整字节**，
 * TS 这侧逐字节比。
 *
 * ## 格式（v1.0）
 *
 * ```
 * \x93NUMPY  \x01\x00  <u2 头长>  <ASCII 头，空格补齐，\n 收尾>  <小端裸数据>
 * ```
 *
 * 头部那段补齐**不是排版**：`10 + 头长` 必须是 **64 的倍数**，好让数据段按 64 字节
 * 对齐（memmap 要的）。补错了 numpy 照样读得出来，但那是运气，不是格式。
 */

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const // \x93NUMPY
/** 数据段的对齐边界。见文件抬头。 */
export const NPY_ALIGN = 64

/** numpy 写 shape 的写法：一维是 `(4,)`，多维是 `(2, 3)`，零维是 `()`。 */
export function npyShapeLiteral(shape: readonly number[]): string {
  if (shape.length === 0) return '()'
  if (shape.length === 1) return `(${shape[0]},)`
  return `(${shape.join(', ')})`
}

/**
 * float64 数组 → `.npy` 字节。
 *
 * `values` 是**行优先**展平的样本，`shape` 是它的形状（两者对不上就抛——一份
 * 形状撒谎的 `.npy` 比没有更坏，读它的人会拿到一张几何错乱的图而不是一个错误）。
 */
export function encodeNpyFloat64(values: readonly number[], shape: readonly number[]): Uint8Array {
  const want = shape.reduce((a, b) => a * b, 1)
  if (values.length !== want) {
    throw new RangeError(`.npy 形状与样本数对不上：shape=${npyShapeLiteral(shape)} 需要 ${want} 个，实得 ${values.length} 个`)
  }
  const dict = `{'descr': '<f8', 'fortran_order': False, 'shape': ${npyShapeLiteral(shape)}, }`
  // `10` = 魔数 6 + 版本 2 + 头长字段 2。补到 64 的倍数，末位留给 `\n`。
  const unpadded = 10 + dict.length + 1
  const headerLen = dict.length + 1 + ((NPY_ALIGN - (unpadded % NPY_ALIGN)) % NPY_ALIGN)
  const header = dict.padEnd(headerLen - 1, ' ') + '\n'

  const out = new Uint8Array(10 + headerLen + values.length * 8)
  out.set(MAGIC, 0)
  out[6] = 1 // major
  out[7] = 0 // minor
  const view = new DataView(out.buffer)
  view.setUint16(8, headerLen, true)
  for (let i = 0; i < header.length; i += 1) out[10 + i] = header.charCodeAt(i)
  let off = 10 + headerLen
  for (const v of values) {
    view.setFloat64(off, v, true)
    off += 8
  }
  return out
}

/** 二维表 → `.npy` 字节。行长不齐就抛——那是一张说不清自己形状的图。 */
export function encodeNpyFrame(rows: readonly (readonly number[])[]): Uint8Array {
  if (rows.length === 0) return encodeNpyFloat64([], [0])
  const cols = (rows[0] as readonly number[]).length
  const flat: number[] = []
  for (const r of rows) {
    if (r.length !== cols) {
      throw new RangeError(`.npy 帧的行长不齐：第一行 ${cols} 列，另有一行 ${r.length} 列`)
    }
    flat.push(...r)
  }
  return encodeNpyFloat64(flat, [rows.length, cols])
}
