/**
 * 三种格式共用的两件事：**尺寸闸**与**大端 float32 解码**。
 *
 * ## 这一层收字节，不收路径
 *
 * 旧仓的读取器签名是 `read_sxm(path)`，自己 `open()`。本仓这一层**零 I/O**：
 * 入参是 `Uint8Array`，谁去碰文件系统由技能层决定。
 *
 * 代价是 `_checked_file_size` 那道闸挪了位置 —— 它原本在 `open()` 之前拦住
 * 「2 GiB 的文件别读进内存」，而字节已经在手上时那道闸**已经晚了**。
 * 所以这里导出 {@link MAX_FILE_BYTES} 与 {@link assertReadableSize} 两样，
 * 让技能层在 `readFile` **之前**用 `statSync` 拦一次；这一层再拦一次是兜底，
 * 拦的是「有人把一个巨大的 buffer 递进来」。
 *
 * **两道闸不是重复**：一道防的是读盘，一道防的是解码；前者省的是内存，
 * 后者省的是把一个显然不对的东西当成扫描图去解析。
 */

/** 2 GiB。与旧仓 `MAX_FILE_BYTES` 同值。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

/** `.3ds` 的网格元素上限（512M 个 float64 ≈ 4 GiB）。与旧仓同值。 */
export const MAX_GRID_ELEMENTS = 512 * 1024 * 1024

/** 文件太大就拒。**不截断、不流式** —— 截断会悄悄交出半张图。 */
export function assertReadableSize(byteLength: number, what = '<bytes>'): void {
  if (byteLength > MAX_FILE_BYTES) {
    throw new RangeError(
      `File too large to read (${byteLength} bytes > ${MAX_FILE_BYTES} byte limit): ` +
        `${what}. Refusing to load to avoid exhausting memory.`,
    )
  }
}

/**
 * 头文本的解码：**UTF-8，坏字节换成 U+FFFD**。
 *
 * ⚠️ 这一条是照旧仓来的，而它对**非 UTF-8 的头是错的**：旧仓写的是
 * `content[:header_end].decode("utf-8", errors="replace")`，于是一段 GBK 注释
 * （「探针」）读出来是 `̽��`。金样 `sxm/gbk_comment` 逐字钉着这个乱码。
 *
 * **没有改成 GBK 回退**，理由是这一层的判据是「与旧仓逐字相同」，而注释字段
 * 不驱动任何决策；真要修，该在旧仓与本仓**同时**修，并且先回答「怎么知道
 * 这份头是 GBK 而不是 Latin-1」——`errors="replace"` 不会失败，所以没有
 * 任何信号能分辨这两种猜测。见交接文件。
 */
export function decodeHeaderText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/** 在 `haystack` 里找 `needle` 的字节下标，找不到给 `-1`。 */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * 一段大端 float32 → `Float64Array`。
 *
 * Nanonis 的帧是 **MSBFIRST**（头里 `:SCANIT_TYPE:` 自己写着）。把字节序读反
 * 不会报错，只会得到一张由 1e-38 与 1e38 交替组成的「图」——
 * 而那种图在自动流程里长得像一次噪声很大的扫描。
 */
export function readBigEndianFloat32(bytes: Uint8Array, offset: number, count: number): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float64Array(count)
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(offset + i * 4, false)
  return out
}

/**
 * Python 的 `float(s)` —— **认 `nan` / `inf`，不认下划线与十六进制**。
 *
 * 与 `readback.ts` 的 `toFloat`（只认十进制）刻意不同，而这个不同是**有理由**的：
 * 那边解析的是**调用方给的参数**（一个写成 `0x10` 的 LUT 值会被当成 16 灌进硬件），
 * 这边解析的是**仪器写出来的数据列**，而 Nanonis 在缺点位上就是写 `NaN` 的 ——
 * 在这里拒绝 `NaN` 等于把整行数据丢掉。
 *
 * **同一个词（「解析一个浮点数」）在两个位置上是两条规则，判据是「这个数从哪来」。**
 */
const PY_FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const PY_NONFINITE = /^[+-]?(?:nan|inf(?:inity)?)$/i

export function pyFloat(s: string): number | null {
  const t = s.trim()
  if (PY_FLOAT.test(t)) return Number(t)
  if (PY_NONFINITE.test(t)) {
    if (/nan$/i.test(t)) return NaN
    return t.startsWith('-') ? -Infinity : Infinity
  }
  return null
}

/** 头字段里的第一个浮点（头是自由文本）。取不出给 `fallback`。 */
export function firstFloat(value: unknown, fallback: number | null = null): number | null {
  const tok = String(value ?? '').trim().split(/\s+/)[0]
  if (tok === undefined || tok === '') return fallback
  const v = pyFloat(tok)
  return v === null ? fallback : v
}
