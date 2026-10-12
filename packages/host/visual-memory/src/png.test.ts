import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { crc32, decodePng, encodePngRgb, PngError, pngSize, toRgb } from './png.js'

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/** A hand-built PNG with chosen colour type and per-row filters (unfiltered input rows). */
function handPng(width: number, height: number, colourType: number, channels: number, rows: Uint8Array[], filters: number[], depth = 8, interlace = 0): Uint8Array {
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr[8] = depth
  ihdr[9] = colourType
  ihdr[12] = interlace
  const stride = width * channels
  const raw = new Uint8Array(height * (stride + 1))
  let prev: Uint8Array = new Uint8Array(stride)
  rows.forEach((row, y) => {
    const f = filters[y] ?? 0
    raw[y * (stride + 1)] = f
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (row[i - channels] as number) : 0
      const b = prev[i] as number
      const c = i >= channels ? (prev[i - channels] as number) : 0
      const p = a + b - c
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const pred = [0, a, b, (a + b) >> 1, pr][f] as number
      raw[y * (stride + 1) + 1 + i] = ((row[i] as number) - pred) & 0xff
    }
    prev = row
  })
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

describe('PNG encoder', () => {
  it('writes exactly IHDR, IDAT and IEND, as 8-bit truecolour without interlace', () => {
    const png = encodePngRgb(3, 2, Uint8Array.from({ length: 18 }, (_, i) => i * 14))
    const types: string[] = []
    let off = 8
    const v = new DataView(png.buffer, png.byteOffset)
    while (off < png.length) {
      const len = v.getUint32(off)
      types.push(String.fromCharCode(...png.subarray(off + 4, off + 8)))
      off += 12 + len
    }
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(png[24]).toBe(8) // bit depth
    expect(png[25]).toBe(2) // colour type 2 = RGB
    expect(png[28]).toBe(0) // no interlace
    expect(pngSize(png)).toEqual({ width: 3, height: 2 })
  })

  it('round-trips pixels exactly through the decoder for every filter the heuristic picks', () => {
    const w = 37
    const h = 23
    const rgb = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 3
        // smooth ramps (Sub/Up/Average/Paeth win) next to noise (None wins)
        rgb[i] = y < 8 ? (x * 7) & 0xff : (x * 131 + y * 71) & 0xff
        rgb[i + 1] = y < 16 ? (y * 11) & 0xff : (x * x + y) & 0xff
        rgb[i + 2] = (x + y) * 3
      }
    }
    const img = decodePng(encodePngRgb(w, h, rgb, { level: 6 }))
    expect(img).toMatchObject({ width: w, height: h, channels: 3 })
    expect(Buffer.from(img.data).equals(Buffer.from(rgb))).toBe(true)
  })

  it('is deterministic', () => {
    const rgb = Uint8Array.from({ length: 64 * 3 }, (_, i) => (i * 37) & 0xff)
    expect(Buffer.from(encodePngRgb(8, 8, rgb)).equals(Buffer.from(encodePngRgb(8, 8, rgb)))).toBe(true)
  })

  it('rejects a wrong buffer length or size', () => {
    expect(() => encodePngRgb(2, 2, new Uint8Array(11))).toThrow(PngError)
    expect(() => encodePngRgb(0, 2, new Uint8Array(0))).toThrow(/positive/)
  })
})

/** A seeded uniform generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Rows of every kind the encoder treats differently, mixed: noise (None wins), ramps across and
 * down (Sub, Up), smooth fields (Average, Paeth), flats, zero rows, copies of the row above
 * (recognised without filtering) and small changes to it.
 */
function randomImage(rand: () => number, w: number, h: number): Uint8Array {
  const stride = w * 3
  const rgb = new Uint8Array(h * stride)
  const byte = (): number => Math.floor(rand() * 256)
  for (let y = 0; y < h; y += 1) {
    const row = rgb.subarray(y * stride, (y + 1) * stride)
    const above = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride)
    const kind = Math.floor(rand() * 8)
    const [s, t] = [byte(), byte()]
    for (let i = 0; i < stride; i += 1) {
      const x = Math.floor(i / 3)
      row[i] = [
        byte(),
        (s + x * t) & 0xff,
        ((above[i] as number) + 7) & 0xff,
        (128 + 100 * Math.sin(x / (1 + t / 16) + y / 5 + (i % 3))) & 0xff,
        s,
        0,
        above[i] as number,
        ((above[i] as number) + (rand() < 0.05 ? 1 : 0)) & 0xff,
      ][kind] as number
    }
  }
  return rgb
}

describe('PNG encoder against the straightforward one', () => {
  /**
   * The encoder's filter stage before it was rewritten without per-byte branches: each filter
   * in turn, then its cost, the first least one wins. Kept as the oracle for the bytes.
   */
  function straightforward(width: number, height: number, rgb: Uint8Array): Uint8Array {
    const paeth = (a: number, b: number, c: number): number => {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      if (pa <= pb && pa <= pc) return a
      return pb <= pc ? b : c
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
        for (let i = 0; i < row.length; i += 1) {
          const x = row[i] as number
          const a = i >= bpp ? (row[i - bpp] as number) : 0
          const b = prev[i] as number
          const c = i >= bpp ? (prev[i - bpp] as number) : 0
          let v: number
          switch (t) {
            case 0: v = x; break
            case 1: v = x - a; break
            case 2: v = x - b; break
            case 3: v = x - ((a + b) >> 1); break
            default: v = x - paeth(a, b, c)
          }
          out[i] = v & 0xff
        }
        let cost = 0
        for (const v of out) cost += v < 128 ? v : 256 - v
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
    new DataView(ihdr.buffer).setUint32(0, width)
    new DataView(ihdr.buffer).setUint32(4, height)
    ihdr[8] = 8
    ihdr[9] = 2
    const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const idat = new Uint8Array(deflateSync(raw, { level: 9 }))
    return new Uint8Array(Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]))
  }

  it('writes the same bytes on random images of every row kind, including 1- and 2-pixel-wide ones', () => {
    const rand = rng(20261013)
    for (let k = 0; k < 400; k += 1) {
      const w = k < 20 ? 1 + (k % 2) : 1 + Math.floor(rand() * 40)
      const h = 1 + Math.floor(rand() * 24)
      const rgb = randomImage(rand, w, h)
      expect(Buffer.from(encodePngRgb(w, h, rgb)).equals(Buffer.from(straightforward(w, h, rgb))), `image ${k}, ${w}x${h}`).toBe(true)
    }
  })

  it('writes the same bytes on whole images: blank, black, noise and a scan-like enlargement', () => {
    const rand = rng(7)
    const w = 96
    const h = 64
    const blocks = new Uint8Array(w * h * 3)
    for (let i = 0; i < blocks.length; i += 1) blocks[i] = (Math.floor(i / 3 / 8) % 12) * 20 + Math.floor(i / (w * 3) / 8) * 9
    const images = [new Uint8Array(w * h * 3).fill(255), new Uint8Array(w * h * 3), Uint8Array.from({ length: w * h * 3 }, () => Math.floor(rand() * 256)), blocks]
    for (const rgb of images) expect(Buffer.from(encodePngRgb(w, h, rgb)).equals(Buffer.from(straightforward(w, h, rgb)))).toBe(true)
  })
})

describe('PNG decoder', () => {
  const row = (vals: number[]): Uint8Array => Uint8Array.from(vals)

  it('undoes every filter on random rows of every layout', () => {
    const rand = rng(99)
    for (const [colourType, channels] of [[0, 1], [4, 2], [2, 3], [6, 4]] as const) {
      for (let k = 0; k < 40; k += 1) {
        const w = 1 + Math.floor(rand() * 20)
        const h = 1 + Math.floor(rand() * 12)
        const rows = Array.from({ length: h }, () => Uint8Array.from({ length: w * channels }, () => (rand() < 0.5 ? Math.floor(rand() * 256) : 128)))
        const filters = rows.map(() => Math.floor(rand() * 5))
        const img = decodePng(handPng(w, h, colourType, channels, rows, filters))
        expect([img.width, img.height, img.channels]).toEqual([w, h, channels])
        expect(Buffer.from(img.data).equals(Buffer.concat(rows)), `layout ${channels}, image ${k}`).toBe(true)
      }
    }
  })

  it('reads grey, grey+alpha and RGBA with all five filters', () => {
    const grey = [row([0, 10, 20, 250]), row([5, 15, 25, 35]), row([9, 9, 9, 9]), row([1, 2, 3, 4]), row([200, 100, 50, 25])]
    const g = decodePng(handPng(4, 5, 0, 1, grey, [0, 1, 2, 3, 4]))
    expect(g.channels).toBe(1)
    expect([...g.data]).toEqual(grey.flatMap((r) => [...r]))
    expect([...toRgb(g).subarray(0, 6)]).toEqual([0, 0, 0, 10, 10, 10])

    const ga = [row([1, 255, 2, 128]), row([3, 0, 4, 64])]
    const d2 = decodePng(handPng(2, 2, 4, 2, ga, [4, 3]))
    expect(d2.channels).toBe(2)
    expect([...d2.data]).toEqual([1, 255, 2, 128, 3, 0, 4, 64])
    expect([...toRgb(d2)]).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4])

    const rgba = [row([10, 20, 30, 40, 50, 60, 70, 80])]
    const d4 = decodePng(handPng(2, 1, 6, 4, rgba, [1]))
    expect(d4.channels).toBe(4)
    expect([...toRgb(d4)]).toEqual([10, 20, 30, 50, 60, 70])
  })

  it('refuses what it does not support, and damaged files', () => {
    const good = encodePngRgb(2, 2, new Uint8Array(12))
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow(/signature/)
    expect(() => pngSize(new Uint8Array(4))).toThrow(PngError)
    const badCrc = good.slice()
    badCrc[30] = (badCrc[30] as number) ^ 0xff // inside the IHDR CRC / IDAT
    expect(() => decodePng(badCrc)).toThrow(PngError)
    expect(() => decodePng(handPng(1, 1, 0, 1, [row([1])], [0], 16))).toThrow(/8-bit/)
    expect(() => decodePng(handPng(1, 1, 0, 1, [row([1])], [0], 8, 1))).toThrow(/interlaced/)
    expect(() => decodePng(handPng(1, 1, 3, 1, [row([1])], [0]))).toThrow(/colour type 3/)
    expect(() => decodePng(handPng(1, 1, 0, 1, [row([1])], [7]))).toThrow(/filter type 7/)
    const noEnd = good.subarray(0, good.length - 12)
    expect(() => decodePng(noEnd)).toThrow(/IEND/)
    const truncated = good.subarray(0, 40)
    expect(() => decodePng(truncated)).toThrow(PngError)
  })

  it('rejects a PNG whose pixel data has the wrong size, and one without IHDR', () => {
    const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdr = new Uint8Array(13)
    new DataView(ihdr.buffer).setUint32(0, 2)
    new DataView(ihdr.buffer).setUint32(4, 2)
    ihdr[8] = 8
    ihdr[9] = 2
    const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(new Uint8Array(3)))), chunk('IEND', new Uint8Array(0))]
    const bad = Buffer.concat(parts)
    expect(() => decodePng(new Uint8Array(bad))).toThrow(/pixel data/)
    const noHeader = Buffer.concat([sig, chunk('IEND', new Uint8Array(0))])
    expect(() => decodePng(new Uint8Array(noHeader))).toThrow(/IHDR/)
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})
