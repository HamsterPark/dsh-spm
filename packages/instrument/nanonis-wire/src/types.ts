/**
 * Nanonis 类型码表：请求参数编码 + 回复字段解码。
 *
 * 镜像的是**真实客户端** `nanonis_spm`（经 MAST 的 `nanonis_patch.py` 打补丁）——
 * 就是跟真机说话的那份代码。字节金样在 `spec/golden/wire_types.json`。
 *
 * 671 个方法里真实用到的码（其余不实现，用到时会明确抛错而不是猜）：
 *   请求 i I H h f d b · *f *i *I · +*i +*b · 2f · +*c *+c
 *   回复 i I H f d · *f *i *I *d · **f **I **i **c · +*i +*c · *+c *+d *-c · 2f · *2c
 */

import { ERROR_HEADER_LEN, WireFrameError } from './frame.js'

const SCALAR_SIZE: Readonly<Record<string, number>> = { H: 2, h: 2, I: 4, i: 4, f: 4, d: 8, b: 1, B: 1 }
const INT_FMTS = new Set(['H', 'h', 'I', 'i', 'b', 'B'])

export class WireTypeError extends Error {
  override readonly name = 'WireTypeError'
}

// ────────────────────────────── 请求侧 ──────────────────────────────

function putScalar(out: number[], fmt: string, v: number): void {
  const size = SCALAR_SIZE[fmt]
  if (size === undefined) throw new WireTypeError(`未知标量格式 ${JSON.stringify(fmt)}`)
  const buf = new DataView(new ArrayBuffer(size))
  const n = INT_FMTS.has(fmt) ? Math.trunc(v) : v
  if (fmt === 'H') buf.setUint16(0, n, false)
  else if (fmt === 'h') buf.setInt16(0, n, false)
  else if (fmt === 'I') buf.setUint32(0, n, false)
  else if (fmt === 'i') buf.setInt32(0, n, false)
  else if (fmt === 'b') buf.setInt8(0, n)
  else if (fmt === 'B') buf.setUint8(0, n)
  else if (fmt === 'f') buf.setFloat32(0, n, false)
  else buf.setFloat64(0, n, false)
  for (let i = 0; i < size; i++) out.push(buf.getUint8(i))
}

function putI32(out: number[], v: number): void {
  putScalar(out, 'i', v)
}

function putBytes(out: number[], b: Uint8Array): void {
  for (const x of b) out.push(x)
}

const utf8 = new TextEncoder()

/**
 * 编码一个请求参数。分支顺序逐字复刻客户端的 `send`（`nanonis_patch.py:169-195`）。
 *
 * **`c` 的二义**：同一个格式串，`str` 与数组产出完全不同的字节——客户端是按 Python
 * 类型选的编码，格式串本身不说是哪种（`STM-Bench/stmsim/wire/spec.py` 的
 * `array_string_args` 就是为消这个歧而存在）。TS 里对应 `string` 与 `string[]`。
 */
export function encodeArg(value: unknown, fmt: string): Uint8Array {
  const out: number[] = []
  if (fmt.includes('*')) {
    if (fmt.includes('c')) {
      if (typeof value === 'string') {
        const b = utf8.encode(value)
        putI32(out, b.length)
        putBytes(out, b)
      } else {
        const items = (value as readonly string[]).map((s) => utf8.encode(s))
        putI32(out, 4 * items.length) // 总字节数：只数长度前缀，与客户端一致
        putI32(out, items.length)
        for (const b of items) {
          putI32(out, b.length)
          putBytes(out, b)
        }
      }
      return Uint8Array.from(out)
    }
    const elem = fmt.slice(-1)
    const arr = (value ?? []) as readonly number[]
    if (fmt.includes('+')) putI32(out, arr.length) // +*X 自带计数
    for (const x of arr) putScalar(out, elem, x)
    return Uint8Array.from(out)
  }
  if (fmt.includes('2')) {
    // 请求侧的 2X **自带** rows/cols；回复侧它们是两个独立声明字段（不对称，实测）
    const rows = (value ?? []) as readonly (readonly number[])[]
    const elem = fmt.slice(-1)
    putI32(out, rows.length)
    putI32(out, rows[0]?.length ?? 0)
    for (const row of rows) for (const x of row) putScalar(out, elem, x)
    return Uint8Array.from(out)
  }
  putScalar(out, fmt, value as number)
  return Uint8Array.from(out)
}

export function encodeArgs(args: readonly { value: unknown; fmt: string }[]): Uint8Array {
  const parts = args.map((a) => encodeArg(a.value, a.fmt))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ────────────────────────────── 回复侧 ──────────────────────────────

class Reader {
  pos = 0
  private readonly view: DataView
  constructor(readonly body: Uint8Array) {
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  }
  need(n: number): void {
    if (this.pos + n > this.body.length) {
      throw new WireTypeError(`回复 body 不够读：在 ${this.pos} 处要 ${n} 字节，总共只有 ${this.body.length}`)
    }
  }
  scalar(fmt: string): number {
    const size = SCALAR_SIZE[fmt]
    if (size === undefined) throw new WireTypeError(`未知标量格式 ${JSON.stringify(fmt)}`)
    this.need(size)
    const p = this.pos
    this.pos += size
    if (fmt === 'H') return this.view.getUint16(p, false)
    if (fmt === 'h') return this.view.getInt16(p, false)
    if (fmt === 'I') return this.view.getUint32(p, false)
    if (fmt === 'i') return this.view.getInt32(p, false)
    if (fmt === 'b') return this.view.getInt8(p)
    if (fmt === 'B') return this.view.getUint8(p)
    if (fmt === 'f') return this.view.getFloat32(p, false)
    return this.view.getFloat64(p, false)
  }
  str(len: number): string {
    this.need(len)
    const s = new TextDecoder().decode(this.body.subarray(this.pos, this.pos + len))
    this.pos += len
    return s
  }
  lenPrefixedStr(): string {
    return this.str(this.scalar('i'))
  }
}

/** `*X`/`-*X` 走客户端的 `decodeArrayPrepended`：**步长 8(d) / 否则 4**——即使 `H`/`h` 只有 2 字节。 */
function starStride(elem: string): number {
  if (elem === 'd') return 8
  const size = SCALAR_SIZE[elem]
  if (size !== undefined && size !== 4) {
    // 见 spec/deviations.md D-WIRE-3：客户端会按 4 字节跨过一个 2 字节的元素，
    // 读出的数组是错的。671 个方法里没有一个用 *H/*h/*b/*B，所以这条从不触发；
    // 一旦将来有了，明确抛错远好过静默读出垃圾。
    throw new WireTypeError(
      `*${elem} 的客户端步长是 4，而元素只有 ${size} 字节——这会读出错位的数组。` +
        `当前 671 个方法里没有这种用法；真出现了要先决定跟客户端还是跟仪器。`,
    )
  }
  return 4
}

/**
 * 解码回复 body 里声明的返回字段；剩下的尾部就是错误段，原样返回给调用方。
 *
 * 计数来源分三种，都由**已经读到的字段**决定，所以必须顺序解码：
 *   `*X` `-*X` `*+X` `*-c` `*+c` → 前一个（或前两个）int 字段
 *   `**X` `**c`                  → **第一个**字段（Variables[0]）
 *   `+*X` `+*c`                  → 自带计数，不看别人
 */
export function decodeReturns(
  body: Uint8Array,
  fmts: readonly string[],
): { values: unknown[]; errorSection: Uint8Array } {
  const r = new Reader(body)
  const values: unknown[] = []
  const asInt = (i: number): number => {
    const v = values[i]
    if (typeof v !== 'number') throw new WireTypeError(`字段 ${i} 应是计数用的整数，实际是 ${JSON.stringify(v)}`)
    return v
  }

  for (let i = 0; i < fmts.length; i++) {
    const fmt = fmts[i]!
    const elem = fmt.slice(-1)
    if (SCALAR_SIZE[fmt] !== undefined) {
      values.push(r.scalar(fmt))
    } else if (fmt === '*2c') {
      const rows = asInt(i - 2)
      const cols = asInt(i - 1)
      values.push(Array.from({ length: rows }, () => Array.from({ length: cols }, () => r.lenPrefixedStr())))
    } else if (fmt.startsWith('2')) {
      const rows = asInt(i - 2)
      const cols = asInt(i - 1)
      values.push(Array.from({ length: rows }, () => Array.from({ length: cols }, () => r.scalar(elem))))
    } else if (fmt === '*-c') {
      values.push(r.str(asInt(i - 1)))
    } else if (fmt === '+*c') {
      values.push(r.lenPrefixedStr())
    } else if (fmt === '*+c') {
      values.push(Array.from({ length: asInt(i - 1) }, () => r.lenPrefixedStr()))
    } else if (fmt === '**c') {
      values.push(Array.from({ length: asInt(0) }, () => r.lenPrefixedStr()))
    } else if (fmt.startsWith('+*')) {
      values.push(Array.from({ length: r.scalar('i') }, () => r.scalar(elem)))
    } else if (fmt.startsWith('**')) {
      values.push(Array.from({ length: asInt(0) }, () => r.scalar(elem)))
    } else if (fmt.startsWith('*+')) {
      values.push(Array.from({ length: asInt(i - 1) }, () => r.scalar(elem)))
    } else if (fmt.startsWith('*') || fmt.startsWith('-*')) {
      starStride(elem) // 只为触发 D-WIRE-3 的检查；实际步长与元素大小一致
      values.push(Array.from({ length: asInt(i - 1) }, () => r.scalar(elem)))
    } else {
      throw new WireTypeError(`未实现的格式码 ${JSON.stringify(fmt)}`)
    }
  }

  const errorSection = body.subarray(r.pos)
  if (errorSection.length !== 0 && errorSection.length < ERROR_HEADER_LEN) {
    throw new WireFrameError(`声明字段读完后剩 ${errorSection.length} 字节，放不下 ${ERROR_HEADER_LEN} 字节的错误段`)
  }
  return { values, errorSection }
}
