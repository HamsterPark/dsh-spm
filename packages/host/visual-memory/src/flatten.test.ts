import { describe, expect, it } from 'vitest'
import {
  blockMean,
  fitSurface,
  flatten,
  FlattenError,
  isFlattenMode,
  medianBackground,
  nanMedian,
  projectOnto,
  rowOffsets,
} from './flatten.js'

function grid(nx: number, ny: number, f: (c: number, r: number) => number): Float64Array {
  const out = new Float64Array(nx * ny)
  for (let r = 0; r < ny; r += 1) for (let c = 0; c < nx; c += 1) out[r * nx + c] = f(c, r)
  return out
}

function maxAbsFinite(a: ArrayLike<number>): number {
  let m = 0
  for (let i = 0; i < a.length; i += 1) if (Number.isFinite(a[i] as number)) m = Math.max(m, Math.abs(a[i] as number))
  return m
}

describe('surface fits', () => {
  it('removes an exact plane, leaving rounding noise only', () => {
    const z = grid(9, 7, (c, r) => 5 + 0.3 * c - 1.7 * r)
    expect(maxAbsFinite(flatten(z, 9, 7, 'plane'))).toBeLessThan(1e-12)
  })

  it('poly2 removes a quadratic surface that a plane leaves behind', () => {
    const z = grid(11, 8, (c, r) => 2 + 0.1 * c - 0.2 * r + 0.05 * c * c - 0.03 * c * r + 0.07 * r * r)
    expect(maxAbsFinite(flatten(z, 11, 8, 'poly2'))).toBeLessThan(1e-12)
    expect(maxAbsFinite(flatten(z, 11, 8, 'plane'))).toBeGreaterThan(0.1)
  })

  it('line removes per-row offsets on top of a plane', () => {
    const offsets = [0, 3, -2, 7, 1]
    const z = grid(6, 5, (c, r) => 0.5 * c + (offsets[r] as number))
    expect(maxAbsFinite(flatten(z, 6, 5, 'line'))).toBeLessThan(1e-12)
    expect(maxAbsFinite(flatten(z, 6, 5, 'plane'))).toBeGreaterThan(1)
  })

  it('fits only finite pixels and keeps NaN where nothing was acquired', () => {
    const z = grid(5, 4, (c, r) => (r === 3 ? Number.NaN : 1 + 2 * c + 3 * r))
    const out = flatten(z, 5, 4, 'plane')
    expect(maxAbsFinite(out)).toBeLessThan(1e-12)
    for (let c = 0; c < 5; c += 1) expect(out[15 + c]).toBeNaN()
  })

  it('stays well defined when the acquired pixels make the terms dependent (one row of a partial scan)', () => {
    const z = grid(8, 6, (c, r) => (r === 0 ? 10 + 0.25 * c : Number.NaN))
    const out = flatten(z, 8, 6, 'plane')
    expect(maxAbsFinite(out)).toBeLessThan(1e-12)
    expect(Number.isFinite(out[0] as number)).toBe(true)
    const q = flatten(z, 8, 6, 'poly2') // x² still independent of 1, x on one row
    expect(maxAbsFinite(q)).toBeLessThan(1e-12)
  })

  it('leaves the frame unflattened when there are fewer finite pixels than terms', () => {
    const z = grid(4, 4, (c, r) => (r === 0 && c < 2 ? 7 + c : Number.NaN))
    expect(fitSurface(z, 4, 4, 1)).toEqual(new Float64Array(16))
    const out = flatten(z, 4, 4, 'plane')
    expect(out[0]).toBe(7)
    expect(out[1]).toBe(8)
    const five = grid(5, 1, (c) => c * c)
    expect(fitSurface(five, 5, 1, 2)).toEqual(new Float64Array(5)) // 5 < 6 terms
  })

  it('returns an unchanged float64 copy for none', () => {
    const z = Float32Array.from([1.5, Number.NaN, 3])
    const out = flatten(z, 3, 1, 'none')
    expect(out).toBeInstanceOf(Float64Array)
    expect([...out.slice(0, 1), ...out.slice(2)]).toEqual([1.5, 3])
    expect(out[1]).toBeNaN()
  })

  it('rejects unknown modes, wrong shapes and a highpass without pixel size', () => {
    const z = new Float64Array(6)
    expect(() => flatten(z, 3, 2, 'median' as never)).toThrow(FlattenError)
    expect(() => flatten(z, 4, 2, 'plane')).toThrow(/2 rows x 4 columns/)
    expect(() => flatten(z, 3, 2, 'highpass')).toThrow(/pixel size/)
    expect(() => flatten(z, 3, 2, 'highpass', { nmPerPx: 0 })).toThrow(/pixel size/)
    expect(isFlattenMode('poly2')).toBe(true)
    expect(isFlattenMode('poly3')).toBe(false)
  })
})

describe('highpass', () => {
  it('removes slow background and keeps a narrow bump', () => {
    const nx = 40
    const ny = 30
    const z = grid(nx, ny, (c, r) => 0.02 * c * c + (Math.hypot(c - 20, r - 15) < 1.5 ? 5 : 0))
    const out = flatten(z, nx, ny, 'highpass', { nmPerPx: 0.1, highpassNm: 1.2 }) // 12 px window
    expect(out[15 * nx + 20]).toBeGreaterThan(3)
    expect(Math.abs(out[3 * nx + 5] as number)).toBeLessThan(0.2)
  })

  it('uses the median filter directly for narrow windows (block size 1)', () => {
    const z = grid(9, 9, (c, r) => (c === 4 && r === 4 ? 9 : 1))
    const bg = medianBackground(z, 9, 9, 3) // ceil(3/15) = 1 → d = 1, size 3
    expect(bg[4 * 9 + 4]).toBe(1)
    expect(bg.length).toBe(81)
  })

  it('works on a block-averaged copy for wide windows and interpolates back', () => {
    // width 40 px → blocks of ceil(40/15) = 3, window round(40/3) | 1 = 13 on the 7 × 5 copy
    const z = grid(20, 14, (c) => (c < 10 ? 1 : 3))
    const bg = medianBackground(z, 20, 14, 40)
    expect(bg.length).toBe(280)
    expect(bg[0]).toBe(1) // left edge clamps to the first block
    expect(bg[19]).toBe(3) // right edge clamps to the last block
    for (let c = 1; c < 20; c += 1) expect(bg[c] as number).toBeGreaterThanOrEqual(bg[c - 1] as number) // monotone ramp
  })

  it('fills never-acquired pixels with the median before filtering', () => {
    const z = grid(6, 6, (_c, r) => (r >= 4 ? Number.NaN : 2))
    expect([...medianBackground(z, 6, 6, 3)].every((v) => v === 2)).toBe(true)
    const all = grid(3, 3, () => Number.NaN)
    expect([...medianBackground(all, 3, 3, 3)].every((v) => v === 0)).toBe(true)
  })
})

describe('row offsets, medians, block means, projection', () => {
  it('takes each row median like numpy (mean of the two middle values), 0 for empty rows', () => {
    const z = Float64Array.from([1, 2, 3, 10, Number.NaN, Number.NaN, Number.NaN, Number.NaN, 5, Number.NaN, 7, Number.NaN])
    expect([...rowOffsets(z, 4, 3)]).toEqual([2.5, 0, 6])
    expect(nanMedian([3, 1, 2])).toBe(2)
    expect(nanMedian([Number.NaN])).toBeNaN()
  })

  it('averages blocks with partial edges and ignores NaN', () => {
    // 5 x 3, blocks of 2: columns {0,1},{2,3},{4}; rows {0,1},{2}
    const z = grid(5, 3, (c, r) => r * 10 + c)
    z[1] = Number.NaN
    const b = blockMean(z, 5, 3, 2)
    expect(b.nx).toBe(3)
    expect(b.ny).toBe(2)
    expect([...b.data]).toEqual([(0 + 10 + 11) / 3, (2 + 3 + 12 + 13) / 4, (4 + 14) / 2, (20 + 21) / 2, (22 + 23) / 2, 24])
    const allNan = blockMean(Float64Array.from([Number.NaN, Number.NaN]), 2, 1, 2)
    expect(allNan.data[0]).toBeNaN()
    expect(blockMean(z, 5, 3, 1).data).not.toBe(z)
  })

  it('projects onto the span of the columns, dropping dependent and zero columns', () => {
    const ones = Float64Array.from([1, 1, 1, 1])
    const twos = Float64Array.from([2, 2, 2, 2])
    const zero = new Float64Array(4)
    const x = Float64Array.from([0, 1, 2, 3])
    const y = Float64Array.from([1, 3, 5, 7.5])
    const fit = projectOnto([ones, twos, zero, x], y)
    // least-squares line through (0,1),(1,3),(2,5),(3,7.5): slope 10.75/5 = 2.15, intercept 4.125 - 2.15·1.5 = 0.9
    const want = [0.9, 3.05, 5.2, 7.35]
    fit.forEach((v, i) => expect(v).toBeCloseTo(want[i] as number, 12))
  })
})
