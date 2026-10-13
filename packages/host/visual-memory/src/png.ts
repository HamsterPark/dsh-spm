/**
 * Minimal PNG codec on `node:zlib` (no dependencies).
 *
 * ## Why the encoder only writes 8-bit RGB
 *
 * Observations are grey, but they are written as 8-bit truecolour (colour type
 * 2, R = G = B) with no ancillary chunks. dsh's local attachment store keeps a
 * PNG byte-for-byte only when the image is 8-bit sRGB without metadata; a
 * greyscale PNG (colour type 0) is re-encoded as lossy JPEG on save
 * (`docs/dsh/facts.md` §9). Lossless grey levels, the flat NaN colour and an
 * attachment id equal to the sha256 of our own bytes all depend on this choice.
 * The Python reference writes greyscale when nothing is missing; the decoded
 * pixels are identical, only the container differs (spec/deviations.md D-VMEM-1).
 *
 * ## Determinism
 *
 * Filters are chosen per row with the usual minimum-sum-of-absolute-values
 * heuristic and compressed at a fixed zlib level, so the same pixels always give
 * the same bytes (with the same zlib build).
 *
 * ## Speed
 *
 * The per-byte loops have no branches: the five filter sums of a row come from
 * one pass, the Paeth predictor is picked with arithmetic, and a row equal to
 * the one above is recognised with one native comparison. Coverage
 * instrumentation counts every branch taken, and with a branch per byte the
 * coding of an image took about 18 times as long in a coverage run. The
 * filter choices, hence the bytes, are those of the straightforward encoder;
 * `png.test.ts` keeps that encoder and compares the two on random images.
 *
 * The decoder reads what this module writes plus the other common 8-bit,
 * non-interlaced layouts (grey, grey + alpha, RGB, RGBA); it exists for derived
 * images and tests, not as a general-purpose PNG reader.
 */
import { Buffer } from 'node:buffer'
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A malformed or unsupported PNG. */
export class PngError extends Error {
  override readonly name = 'PngError'
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 (ISO 3309), as PNG chunks use it. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i += 1) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

// The Paeth predictor (PNG §9.4) of left a, up b and upper-left c is a when
// |b − c| <= |a − c| and |b − c| <= |a + b − 2c|, else b when |a − c| <= |a + b − 2c|,
// else c. The loops below pick it with arithmetic, written out in place: a
// helper function would not be inlined under coverage instrumentation.

/** A filtered byte's cost in the filter heuristic: its magnitude read as a signed byte. */
const COST = Uint8Array.from({ length: 256 }, (_, v) => (v < 128 ? v : 256 - v))

/**
 * Filters 1–4 (Sub, Up, Average, Paeth) of one scanline into `out[0..3]`, and
 * the filter type the heuristic picks: the least sum of {@link COST} over the
 * filtered bytes, the lowest type on a tie (type 0, None, is the row itself).
 * `prev` is the previous raw row, zeros for the first.
 */
function filterRow(row: Uint8Array, prev: Uint8Array, bpp: number, out: readonly Uint8Array[]): number {
  const [f1, f2, f3, f4] = out as [Uint8Array, Uint8Array, Uint8Array, Uint8Array]
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let s4 = 0
  // the first pixel has no left neighbour (a = c = 0): Sub is None and Paeth is Up
  for (let i = 0; i < bpp; i += 1) {
    const x = row[i] as number
    const b = prev[i] as number
    const up = (x - b) & 0xff
    const avg = (x - (b >> 1)) & 0xff
    f1[i] = x
    f2[i] = up
    f3[i] = avg
    f4[i] = up
    s0 += COST[x] as number
    s1 += COST[x] as number
    s2 += COST[up] as number
    s3 += COST[avg] as number
    s4 += COST[up] as number
  }
  for (let i = bpp; i < row.length; i += 1) {
    const x = row[i] as number
    const a = row[i - bpp] as number
    const b = prev[i] as number
    const c = prev[i - bpp] as number
    const pa = Math.abs(b - c)
    const pb = Math.abs(a - c)
    const pc = Math.abs(a + b - 2 * c)
    const takeA = +(pa <= pb) & +(pa <= pc)
    const takeB = (1 - takeA) & +(pb <= pc)
    const sub = (x - a) & 0xff
    const up = (x - b) & 0xff
    const avg = (x - ((a + b) >> 1)) & 0xff
    const pth = (x - c - takeA * (a - c) - takeB * (b - c)) & 0xff
    f1[i] = sub
    f2[i] = up
    f3[i] = avg
    f4[i] = pth
    s0 += COST[x] as number
    s1 += COST[sub] as number
    s2 += COST[up] as number
    s3 += COST[avg] as number
    s4 += COST[pth] as number
  }
  const sums = [s0, s1, s2, s3, s4]
  let best = 0
  for (let t = 1; t < 5; t += 1) if ((sums[t] as number) < (sums[best] as number)) best = t
  return best
}

export interface PngOptions {
  /** zlib level 0–9. Default 9: observations are written once and read many times. */
  readonly level?: number
}

/**
 * Encode `width × height` 8-bit RGB pixels (row-major, 3 bytes per pixel) as a
 * PNG with exactly the IHDR, IDAT and IEND chunks.
 */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array, options: PngOptions = {}): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PngError(`PNG size must be positive integers, got ${width}x${height}`)
  }
  if (rgb.length !== width * height * 3) {
    throw new PngError(`expected ${width * height * 3} RGB bytes for ${width}x${height}, got ${rgb.length}`)
  }
  const bpp = 3
  const stride = width * bpp
  const raw = new Uint8Array(height * (stride + 1)) // zeros: each row's filter type, then its filtered bytes
  const zero = new Uint8Array(stride)
  const filtered = [1, 2, 3, 4].map(() => new Uint8Array(stride))
  for (let y = 0; y < height; y += 1) {
    const off = y * (stride + 1)
    const row = rgb.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? zero : rgb.subarray((y - 1) * stride, y * stride)
    if (Buffer.compare(row, prev) === 0) {
      // Up gives zeros, the least sum; only an all-zero row has None, also zeros, before it
      raw[off] = Buffer.compare(row, zero) === 0 ? 0 : 2
      continue
    }
    const type = filterRow(row, prev, bpp, filtered)
    raw[off] = type
    raw.set(type === 0 ? row : (filtered[type - 1] as Uint8Array), off + 1)
  }
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // no interlace
  const idat = new Uint8Array(deflateSync(raw, { level: options.level ?? 9 }))
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export interface DecodedPng {
  readonly width: number
  readonly height: number
  /** 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA. */
  readonly channels: number
  /** Row-major samples, `channels` bytes per pixel. */
  readonly data: Uint8Array
}

const CHANNELS_BY_COLOUR_TYPE: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** Width and height from the IHDR chunk, without decoding the pixels. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  checkSignature(png)
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (png.length < 24 || String.fromCharCode(...png.subarray(12, 16)) !== 'IHDR') {
    throw new PngError('PNG does not start with an IHDR chunk')
  }
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function checkSignature(png: Uint8Array): void {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new PngError('not a PNG (bad signature)')
}

/** Decode an 8-bit, non-interlaced grey / grey+alpha / RGB / RGBA PNG. */
export function decodePng(png: Uint8Array): DecodedPng {
  checkSignature(png)
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let off = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Uint8Array[] = []
  let sawEnd = false
  while (off + 12 <= png.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8))
    const data = png.subarray(off + 8, off + 8 + len)
    if (off + 12 + len > png.length) throw new PngError(`chunk ${type} runs past the end of the file`)
    if (crc32(png, off + 4, off + 8 + len) !== view.getUint32(off + 8 + len)) throw new PngError(`chunk ${type} has a bad CRC`)
    if (type === 'IHDR') {
      const h = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = h.getUint32(0)
      height = h.getUint32(4)
      const depth = data[8]
      const colourType = data[9] as number
      if (depth !== 8) throw new PngError(`only 8-bit PNGs are supported, got bit depth ${depth}`)
      if (data[12] !== 0) throw new PngError('interlaced PNGs are not supported')
      const ch = CHANNELS_BY_COLOUR_TYPE[colourType]
      if (ch === undefined) throw new PngError(`unsupported PNG colour type ${colourType}`)
      channels = ch
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      sawEnd = true
      break
    }
    off += 12 + len
  }
  if (channels === 0) throw new PngError('PNG has no IHDR chunk')
  if (!sawEnd) throw new PngError('PNG has no IEND chunk')
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0))
  let o = 0
  for (const d of idat) {
    joined.set(d, o)
    o += d.length
  }
  const raw = new Uint8Array(inflateSync(joined))
  const stride = width * channels
  if (raw.length !== height * (stride + 1)) throw new PngError(`PNG pixel data has ${raw.length} bytes, expected ${height * (stride + 1)}`)
  const out = new Uint8Array(height * stride)
  let prev: Uint8Array = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)] as number
    const row = out.subarray(y * stride, (y + 1) * stride)
    unfilterRow(type, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), prev, channels, row, y)
    prev = row
  }
  return { width, height, channels, data: out }
}

/** Undo filter `type` of row `y` (`src`) into `row`; `prev` is the previous decoded row, zeros for the first. */
function unfilterRow(type: number, src: Uint8Array, prev: Uint8Array, bpp: number, row: Uint8Array, y: number): void {
  const n = src.length
  switch (type) {
    case 0:
      row.set(src)
      return
    case 1:
      row.set(src.subarray(0, bpp))
      for (let i = bpp; i < n; i += 1) row[i] = ((src[i] as number) + (row[i - bpp] as number)) & 0xff
      return
    case 2:
      for (let i = 0; i < n; i += 1) row[i] = ((src[i] as number) + (prev[i] as number)) & 0xff
      return
    case 3:
      for (let i = 0; i < bpp; i += 1) row[i] = ((src[i] as number) + ((prev[i] as number) >> 1)) & 0xff
      for (let i = bpp; i < n; i += 1) row[i] = ((src[i] as number) + (((row[i - bpp] as number) + (prev[i] as number)) >> 1)) & 0xff
      return
    case 4:
      // the first pixel has no left neighbour (a = c = 0): Paeth predicts Up
      for (let i = 0; i < bpp; i += 1) row[i] = ((src[i] as number) + (prev[i] as number)) & 0xff
      for (let i = bpp; i < n; i += 1) {
        const a = row[i - bpp] as number
        const b = prev[i] as number
        const c = prev[i - bpp] as number
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        const takeA = +(pa <= pb) & +(pa <= pc)
        const takeB = (1 - takeA) & +(pb <= pc)
        row[i] = ((src[i] as number) + c + takeA * (a - c) + takeB * (b - c)) & 0xff
      }
      return
    default:
      throw new PngError(`unknown PNG filter type ${type} in row ${y}`)
  }
}

/** Any decoded PNG as 8-bit RGB (alpha is dropped, grey is replicated). */
export function toRgb(img: DecodedPng): Uint8Array {
  const n = img.width * img.height
  const ch = img.channels
  if (ch === 3) return img.data
  const out = new Uint8Array(n * 3)
  const data = img.data
  if (ch <= 2) {
    for (let i = 0; i < n; i += 1) {
      const g = data[i * ch] as number
      out[i * 3] = g
      out[i * 3 + 1] = g
      out[i * 3 + 2] = g
    }
    return out
  }
  for (let i = 0; i < n; i += 1) {
    out[i * 3] = data[i * 4] as number
    out[i * 3 + 1] = data[i * 4 + 1] as number
    out[i * 3 + 2] = data[i * 4 + 2] as number
  }
  return out
}
