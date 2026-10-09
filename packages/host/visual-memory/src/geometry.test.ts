import { describe, expect, it } from 'vitest'
import {
  checkGeometry,
  displaySize,
  displayToScanNm,
  GeometryError,
  nativeToScanNm,
  scaleFromValue,
  scalePair,
  scaleText,
  scaleValue,
  scanNmToDisplay,
  scanNmToNative,
  type ScanGeometry,
} from './geometry.js'

describe('display scale', () => {
  it('upscales by the largest whole factor that fits, never below 1', () => {
    expect(scalePair(256, 256, 768)).toEqual({ num: 3, den: 1 })
    expect(scalePair(100, 50, 768)).toEqual({ num: 7, den: 1 })
    expect(scalePair(512, 512, 768)).toEqual({ num: 1, den: 1 })
    expect(scalePair(768, 768, 768)).toEqual({ num: 1, den: 1 })
    expect(scalePair(1, 1, 768)).toEqual({ num: 768, den: 1 })
    expect(scalePair(256, 256)).toEqual({ num: 3, den: 1 }) // D defaults to 768
  })

  it('block-means frames larger than the display by ceil(max/D)', () => {
    expect(scalePair(769, 10, 768)).toEqual({ num: 1, den: 2 })
    expect(scalePair(1536, 768, 768)).toEqual({ num: 1, den: 2 })
    expect(scalePair(1537, 1, 768)).toEqual({ num: 1, den: 3 })
  })

  it('gives the full display size; edge blocks of a block mean may be partial', () => {
    expect(displaySize(100, 50, { num: 7, den: 1 })).toEqual([700, 350])
    expect(displaySize(769, 10, { num: 1, den: 2 })).toEqual([385, 5])
    expect(displaySize(1000, 500, scalePair(1000, 500, 768))).toEqual([500, 250])
  })

  it('round-trips the pair through its float value and prints it', () => {
    for (const s of [{ num: 3, den: 1 }, { num: 1, den: 1 }, { num: 1, den: 3 }, { num: 1, den: 7 }]) {
      expect(scaleFromValue(scaleValue(s))).toEqual(s)
    }
    expect(scaleText({ num: 3, den: 1 })).toBe('3')
    expect(scaleText({ num: 1, den: 2 })).toBe('1/2')
    expect(() => scaleFromValue(0)).toThrow(GeometryError)
    expect(() => scaleFromValue(Number.NaN)).toThrow(GeometryError)
  })

  it('rejects non-positive or fractional sizes', () => {
    expect(() => scalePair(0, 10, 768)).toThrow(/nx/)
    expect(() => scalePair(10, 2.5, 768)).toThrow(/ny/)
    expect(() => scalePair(10, 10, 0)).toThrow(/display_max/)
  })
})

/** Dyadic geometry: every intermediate value below is exact in binary. */
const B: ScanGeometry = { cx_nm: 1, cy_nm: 2, w_nm: 8, h_nm: 4, angle_deg: 0, nx: 16, ny: 8 }
const S4 = { num: 4, den: 1 } // 64 // 16

describe('display → scan-frame nm (hand-computed)', () => {
  it('maps corners, centre and a pixel centre of an unrotated frame exactly', () => {
    expect(scalePair(16, 8, 64)).toEqual(S4)
    // u = -w/2 + (x/k)·w/nx ; v = +h/2 - (y/k)·h/ny ; X = cx + u ; Y = cy + v
    expect(displayToScanNm(B, S4, 0, 0)).toEqual([-3, 4]) // u=-4, v=2
    expect(displayToScanNm(B, S4, 32, 16)).toEqual([1, 2]) // centre
    expect(displayToScanNm(B, S4, 64, 32)).toEqual([5, 0]) // u=4, v=-2
    expect(displayToScanNm(B, S4, 2, 2)).toEqual([-2.75, 3.75]) // centre of native pixel (0, 0)
    expect(nativeToScanNm(B, 0.5, 0.5)).toEqual([-2.75, 3.75])
  })

  it('rotates about the frame centre by the scan angle (30°)', () => {
    const g = { ...B, angle_deg: 30 }
    const r3 = Math.sqrt(3)
    // top-left: u=-4, v=2 → X = 1 - 4·cos30 - 2·sin30 = -2√3, Y = 2 - 4·sin30 + 2·cos30 = √3
    const tl = displayToScanNm(g, S4, 0, 0)
    expect(tl[0]).toBeCloseTo(-2 * r3, 12)
    expect(tl[1]).toBeCloseTo(r3, 12)
    // top-right: u=4, v=2 → X = 2√3, Y = 4 + √3
    const tr = displayToScanNm(g, S4, 64, 0)
    expect(tr[0]).toBeCloseTo(2 * r3, 12)
    expect(tr[1]).toBeCloseTo(4 + r3, 12)
    // bottom-left: u=-4, v=-2 → X = 2 - 2√3, Y = -√3
    const bl = displayToScanNm(g, S4, 0, 32)
    expect(bl[0]).toBeCloseTo(2 - 2 * r3, 12)
    expect(bl[1]).toBeCloseTo(-r3, 12)
    // the centre does not move
    expect(displayToScanNm(g, S4, 32, 16)).toEqual([1, 2])
  })

  it('rotates by 90° so that +u points along +Y', () => {
    const g = { ...B, angle_deg: 90 }
    const [X, Y] = displayToScanNm(g, S4, 0, 0) // u=-4, v=2 → X = cx - v = -1, Y = cy + u = -2
    expect(X).toBeCloseTo(-1, 12)
    expect(Y).toBeCloseTo(-2, 12)
  })

  it('uses native coordinates through the block-mean factor', () => {
    const g: ScanGeometry = { cx_nm: 0, cy_nm: 0, w_nm: 1000, h_nm: 500, angle_deg: 0, nx: 1000, ny: 500 }
    const s = scalePair(1000, 500, 768) // 1/2
    expect(displayToScanNm(g, s, 250, 125)).toEqual([0, 0])
    expect(displayToScanNm(g, s, 0, 0)).toEqual([-500, 250])
    expect(displayToScanNm(g, s, 1, 0)).toEqual([-498, 250]) // one display px = two native px = 2 nm
  })
})

describe('scan-frame nm → display', () => {
  it('inverts the forward transform exactly on dyadic inputs', () => {
    expect(scanNmToDisplay(B, S4, -3, 4)).toEqual([0, 0])
    expect(scanNmToDisplay(B, S4, 1, 2)).toEqual([32, 16])
    expect(scanNmToNative(B, -2.75, 3.75)).toEqual([0.5, 0.5])
  })

  it('round-trips arbitrary points to 1e-9 nm on rotated and downsampled frames', () => {
    const geoms: [ScanGeometry, number][] = [
      [{ cx_nm: 12.3, cy_nm: -45.6, w_nm: 20, h_nm: 15, angle_deg: 30, nx: 256, ny: 192 }, 768],
      [{ cx_nm: -0.75, cy_nm: 3.1, w_nm: 7.5, h_nm: 7.5, angle_deg: -117.25, nx: 100, ny: 100 }, 768],
      [{ cx_nm: 100, cy_nm: 200, w_nm: 300, h_nm: 100, angle_deg: 45, nx: 1500, ny: 500 }, 768],
    ]
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (const [g, dm] of geoms) {
      const s = scalePair(g.nx, g.ny, dm)
      const [W, H] = displaySize(g.nx, g.ny, s)
      for (let i = 0; i < 200; i += 1) {
        const x = rnd() * W
        const y = rnd() * H
        const [X, Y] = displayToScanNm(g, s, x, y)
        const [x2, y2] = scanNmToDisplay(g, s, X, Y)
        const [X2, Y2] = displayToScanNm(g, s, x2, y2)
        expect(Math.abs(x2 - x)).toBeLessThan(1e-9)
        expect(Math.abs(y2 - y)).toBeLessThan(1e-9)
        expect(Math.hypot(X2 - X, Y2 - Y)).toBeLessThan(1e-9)
      }
    }
  })
})

describe('geometry validation', () => {
  it('accepts a sound geometry and names the bad field otherwise', () => {
    expect(() => checkGeometry(B)).not.toThrow()
    expect(() => checkGeometry({ ...B, w_nm: 0 })).toThrow(/w_nm/)
    expect(() => checkGeometry({ ...B, h_nm: Number.NaN })).toThrow(/h_nm/)
    expect(() => checkGeometry({ ...B, cx_nm: Infinity })).toThrow(/cx_nm/)
    expect(() => checkGeometry({ ...B, nx: 0 })).toThrow(/nx/)
  })
})
