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
 * pixels are identical, only the container differs.
 *
 * ## Determinism
 *
 * Filters are chosen per row with the usual minimum-sum-of-absolute-values
 * heuristic and compressed at a fixed zlib level, so the same pixels always give
 * the same bytes (with the same zlib build).
 *
 * The decoder reads what this module writes plus the other common 8-bit,
 * non-interlaced layouts (grey, grey + alpha, RGB, RGBA); it exists for derived
 * images and tests, not as a general-purpose PNG reader.
 */
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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Apply filter `type` to one scanline; `prev` is the previous raw row (zeros for row 0). */
function filterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array): void {
  for (let i = 0; i < row.length; i += 1) {
    const x = row[i] as number
    const a = i >= bpp ? (row[i - bpp] as number) : 0
    const b = prev[i] as number
    const c = i >= bpp ? (prev[i - bpp] as number) : 0
    let v: number
    switch (type) {
      case 0: v = x; break
      case 1: v = x - a; break
      case 2: v = x - b; break
      case 3: v = x - ((a + b) >> 1); break
      default: v = x - paeth(a, b, c)
    }
    out[i] = v & 0xff
  }
}

function filterCost(row: Uint8Array): number {
  let s = 0
  for (let i = 0; i < row.length; i += 1) {
    const v = row[i] as number
    s += v < 128 ? v : 256 - v
  }
  return s
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
  const raw = new Uint8Array(height * (stride + 1))
  let prev: Uint8Array = new Uint8Array(stride)
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride))
  for (let y = 0; y < height; y += 1) {
    const row = rgb.subarray(y * stride, (y + 1) * stride)
    let best = 0
    let bestCost = Infinity
    for (let t = 0; t < 5; t += 1) {
      const out = candidates[t] as Uint8Array
      filterRow(t, row, prev, bpp, out)
      const cost = filterCost(out)
      if (cost < bestCost) {
        bestCost = cost
        best = t
      }
    }
    raw[y * (stride + 1)] = best
    raw.set(candidates[best] as Uint8Array, y * (stride + 1) + 1)
    prev = row
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
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = out.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (row[i - channels] as number) : 0
      const b = prev[i] as number
      const c = i >= channels ? (prev[i - channels] as number) : 0
      const x = src[i] as number
      let v: number
      switch (type) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: v = x + paeth(a, b, c); break
        default: throw new PngError(`unknown PNG filter type ${type} in row ${y}`)
      }
      row[i] = v & 0xff
    }
    prev = row
  }
  return { width, height, channels, data: out }
}

/** Any decoded PNG as 8-bit RGB (alpha is dropped, grey is replicated). */
export function toRgb(img: DecodedPng): Uint8Array {
  const n = img.width * img.height
  if (img.channels === 3) return img.data
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i += 1) {
    if (img.channels <= 2) {
      const g = img.data[i * img.channels] as number
      out[i * 3] = g
      out[i * 3 + 1] = g
      out[i * 3 + 2] = g
    } else {
      out[i * 3] = img.data[i * 4] as number
      out[i * 3 + 1] = img.data[i * 4 + 1] as number
      out[i * 3 + 2] = img.data[i * 4 + 2] as number
    }
  }
  return out
}
