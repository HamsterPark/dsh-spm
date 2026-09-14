/**
 * `.npy` **读** —— `kernel/src/npy.ts` 写的那一半的反面。
 *
 * ## 容差：**没有**
 *
 * 这一件对的是**字节**，不是数值。金样里存的是 `np.lib.format.write_array` 真写出来
 * 的那串字节（base64），解出来的每个元素与 numpy 的 `tolist()` **逐位相同**——
 * 因为两边读的是同一串 IEEE-754 小端字节，中间没有一次算术。
 *
 * 所以这里没有「差不多对」的空间：要么解对，要么解错。
 *
 * ## 为什么读比写难
 *
 * 写只需要产出**一种**合法形态；读要接住 numpy 会产出的**每一种**：
 *
 * - **v1.0 与 v2.0 的头长字段宽度不同**（`<u2` vs `<u4`）。v2.0 是给超长头准备的
 *   （几千维的结构化 dtype），而一个只认 v1.0 的读者遇到它会把头长读成两个乱码字节，
 *   然后从一个错误的偏移开始读数据 —— **不报错，给出一整张错的图**。
 * - **`fortran_order`**：同一串字节，行优先与列优先解出来是转置关系。一张转置的
 *   扫描图看起来完全正常（尤其方形帧），而 X 与 Y 已经换了。
 * - **dtype**：`<f8` / `<f4` / `<i4` 的步长不同。步长错了会读出一串量级荒唐的数，
 *   而「荒唐」在 p 量级的电流上没有人一眼看得出来。
 *
 * 三条都不是「精度问题」，是**静默给出错误答案**的三条路。所以三条各有金样。
 */

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const

/** 认得出的 dtype 描述符 → 每元素字节数。**只认小端**（numpy 在本仓这条链上只写小端）。 */
const DTYPES: Readonly<Record<string, { bytes: number; read: (v: DataView, o: number) => number }>> = {
  '<f8': { bytes: 8, read: (v, o) => v.getFloat64(o, true) },
  '<f4': { bytes: 4, read: (v, o) => v.getFloat32(o, true) },
  '<i4': { bytes: 4, read: (v, o) => v.getInt32(o, true) },
  '<i8': { bytes: 8, read: (v, o) => Number(v.getBigInt64(o, true)) },
  '<u4': { bytes: 4, read: (v, o) => v.getUint32(o, true) },
  '|b1': { bytes: 1, read: (v, o) => v.getUint8(o) },
}

/** 解出来的一份数组：**行优先展平**的值 + 它的形状。 */
export interface NpyArray {
  readonly shape: readonly number[]
  readonly dtype: string
  /** **永远是行优先（C order）**——`fortran_order` 的文件在这里已经被转置回来了。 */
  readonly values: Float64Array
}

/** 读不动。**它是一个值，不是一次崩溃**——调用方要把这句话原样报给用户。 */
export class NpyParseError extends Error {
  override readonly name = 'NpyParseError'
}

/**
 * 头部那个 ASCII 字典。
 *
 * numpy 写的是 Python 的 `repr(dict)`，不是 JSON：键用单引号、`True`/`False`
 * 大写、shape 是元组。**不要拿 `JSON.parse` 去碰它** —— 那样得靠一串替换把
 * Python 字面量改写成 JSON，而每多一条替换就多一种它悄悄改错的方式。
 * 这里只取三个已知的键，取不到就抛。
 */
function parseHeaderDict(dict: string): { descr: string; fortran: boolean; shape: number[] } {
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(dict)
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(dict)
  const shape = /'shape'\s*:\s*\(([^)]*)\)/.exec(dict)
  if (descr === null || fortran === null || shape === null) {
    throw new NpyParseError(`.npy 头部读不懂：${dict.trim()}`)
  }
  const dims = (shape[1] as string)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const n = Number(s)
      if (!Number.isInteger(n) || n < 0) throw new NpyParseError(`.npy 形状里有不是自然数的项：'${s}'`)
      return n
    })
  return { descr: descr[1] as string, fortran: fortran[1] === 'True', shape: dims }
}

/**
 * `.npy` 字节 → 数组。
 *
 * `fortran_order` 的文件**在这里就转置回行优先**，而不是把这个标志传给调用方：
 * 一个「记得自己是列优先」的数组，迟早会被某个忘了检查它的人按行优先读一遍。
 * 把歧义消灭在读的那一刻，是这个函数的职责。
 */
export function decodeNpy(bytes: Uint8Array): NpyArray {
  if (bytes.length < 10) throw new NpyParseError(`.npy 太短：只有 ${bytes.length} 字节，连魔数都不够`)
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) throw new NpyParseError('.npy 魔数不对 —— 这不是一个 .npy 文件')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const major = bytes[6] as number

  // **v1.0 的头长是 `<u2`，v2.0 起是 `<u4`。** 认错宽度不会报错，
  // 只会从一个错误的偏移开始读数据。
  let headerLen: number
  let dataStart: number
  if (major === 1) {
    headerLen = view.getUint16(8, true)
    dataStart = 10 + headerLen
  } else if (major === 2 || major === 3) {
    headerLen = view.getUint32(8, true)
    dataStart = 12 + headerLen
  } else {
    throw new NpyParseError(`.npy 版本 ${major}.${bytes[7]} 不认识`)
  }
  if (dataStart > bytes.length) {
    throw new NpyParseError(`.npy 头长 ${headerLen} 超出文件（${bytes.length} 字节）`)
  }

  const headStart = major === 1 ? 10 : 12
  let dict = ''
  for (let i = headStart; i < dataStart; i += 1) dict += String.fromCharCode(bytes[i] as number)
  const { descr, fortran, shape } = parseHeaderDict(dict)

  const spec = DTYPES[descr]
  if (spec === undefined) {
    throw new NpyParseError(`.npy 的 dtype '${descr}' 还没支持（本仓只读小端的 f8/f4/i4/i8/u4/b1）`)
  }
  const count = shape.reduce((a, b) => a * b, 1)
  const need = count * spec.bytes
  if (dataStart + need > bytes.length) {
    // **短了就抛，绝不把剩下的补零。** 一份缺了尾巴的帧补零之后，
    // 图的下半截是一片平坦的「干净表面」——那正是撞针检测要找的形状。
    throw new NpyParseError(
      `.npy 数据段短了：形状 ${JSON.stringify(shape)} × ${spec.bytes} 字节需要 ${need}，` +
        `实有 ${bytes.length - dataStart}`,
    )
  }

  const raw = new Float64Array(count)
  for (let i = 0; i < count; i += 1) raw[i] = spec.read(view, dataStart + i * spec.bytes)
  if (!fortran || shape.length < 2) return { shape, dtype: descr, values: raw }

  // 列优先 → 行优先。**只有二维及以上才有区别**（一维两者相同）。
  const out = new Float64Array(count)
  const strides = fortranStrides(shape)
  const idx = new Array<number>(shape.length).fill(0)
  for (let flat = 0; flat < count; flat += 1) {
    let src = 0
    for (let d = 0; d < shape.length; d += 1) src += (idx[d] as number) * (strides[d] as number)
    out[flat] = raw[src] as number
    for (let d = shape.length - 1; d >= 0; d -= 1) {
      idx[d] = (idx[d] as number) + 1
      if ((idx[d] as number) < (shape[d] as number)) break
      idx[d] = 0
    }
  }
  return { shape, dtype: descr, values: out }
}

/** 列优先的步长：第 0 维步长 1，之后逐维乘上前一维的长度。 */
function fortranStrides(shape: readonly number[]): number[] {
  const s = new Array<number>(shape.length).fill(1)
  for (let d = 1; d < shape.length; d += 1) {
    s[d] = (s[d - 1] as number) * (shape[d - 1] as number)
  }
  return s
}

/** 二维 `.npy` → 行表。不是二维就抛——一张说不清自己形状的图比没有更坏。 */
export function decodeNpyFrame(bytes: Uint8Array): number[][] {
  const arr = decodeNpy(bytes)
  if (arr.shape.length !== 2) {
    throw new NpyParseError(`期望二维，实得 ${arr.shape.length} 维 ${JSON.stringify(arr.shape)}`)
  }
  const [rows, cols] = arr.shape as [number, number]
  const out: number[][] = []
  for (let r = 0; r < rows; r += 1) {
    const row = new Array<number>(cols)
    for (let c = 0; c < cols; c += 1) row[c] = arr.values[r * cols + c] as number
    out.push(row)
  }
  return out
}
