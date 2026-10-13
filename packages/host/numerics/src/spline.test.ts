/**
 * scipy's spline filter and constant-mode shifts (`spline.ts`), moved here with the
 * code from visual-memory: the kernels' edge rules, the golden `measure_diff.json`
 * (`kernels`, exported from scipy itself) bit for bit, and the order-1 shift against
 * this package's general `shiftImage` — the same doubles, so the two entries cannot
 * drift apart.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shiftImage } from './interpolate.js'
import { matOf } from './mat.js'
import { mirrorIndex, shiftConstant, splineFilter3 } from './spline.js'

interface Arr {
  shape: number[]
  f64: string
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/measure_diff.json', import.meta.url)), 'utf8'),
) as {
  kernels: {
    spline_filter: { input: Arr; output: Arr }[]
    shift: { input: Arr; order: number; shifts: number[][]; outputs: Arr[] }[]
  }
}

function f64(a: Arr): Float64Array {
  const u8 = Uint8Array.from(Buffer.from(a.f64, 'base64'))
  const v = new DataView(u8.buffer)
  return Float64Array.from({ length: v.byteLength / 8 }, (_, i) => v.getFloat64(i * 8, true))
}

/** Positions where two arrays are not the same double (`Object.is`). */
function differing(got: ArrayLike<number>, want: ArrayLike<number>): number[] {
  expect(got.length).toBe(want.length)
  const out: number[] = []
  for (let i = 0; i < want.length; i += 1) if (!Object.is(got[i], want[i])) out.push(i)
  return out
}

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('the kernels', () => {
  it('identity shifts, mirror folding, constant edges, shape checks', () => {
    const r = seeded(12)
    const a = Float64Array.from({ length: 20 * 17 }, () => r())
    expect(shiftConstant(a, 20, 17, 0, 0, 1)).toEqual(a)
    const c = splineFilter3(a, 20, 17)
    shiftConstant(c, 20, 17, 0, 0, 3).forEach((v, i) => expect(v).toBeCloseTo(a[i] as number, 13))
    expect([-1, -2, -5, -9, 0, 4, 5, 6, 9, 10].map((i) => mirrorIndex(i, 5))).toEqual([1, 2, 3, 1, 0, 4, 3, 2, 1, 2])
    expect(mirrorIndex(-3, 1)).toBe(0)
    const shifted = shiftConstant(a, 20, 17, 0.5, -0.5, 1)
    expect(shifted[0]).toBe(0) // its source lies outside the frame
    expect(() => shiftConstant(a, 20, 16, 0, 0, 1)).toThrow(/is not 20 rows x 16 columns/)
  })
})

describe('parity with scipy (measure_diff.json kernels), bit for bit', () => {
  it('spline_filter(order=3), mirror boundary', () => {
    for (const c of golden.kernels.spline_filter) {
      const [rows, cols] = c.input.shape as [number, number]
      expect(differing(splineFilter3(f64(c.input), rows, cols), f64(c.output))).toEqual([])
    }
  })

  it('shift(order=1 and 3, mode constant), cubic on prefiltered coefficients', () => {
    let n = 0
    for (const c of golden.kernels.shift) {
      const [rows, cols] = c.input.shape as [number, number]
      const input = f64(c.input)
      c.shifts.forEach((d, k) => {
        const got = shiftConstant(input, rows, cols, d[0] as number, d[1] as number, c.order as 1 | 3)
        expect(differing(got, f64(c.outputs[k] as Arr)), `order ${c.order} shift ${d}`).toEqual([])
        n += 1
      })
    }
    expect(n).toBe(36)
  })
})

describe("the order-1 shift is interpolate.ts' shiftImage in mode constant", () => {
  it('the same doubles: fractional, integer, negative and out-of-frame shifts, NaN pixels, single rows and columns', () => {
    const r = seeded(20261013)
    const shapes = [[1, 1], [1, 7], [6, 1], [2, 2], [5, 8], [13, 9], [32, 17]] as const
    const shifts = [[0, 0], [0.25, -0.75], [-1, 2], [1.5, 0.5], [-0.5, -0.5], [3, -3], [7.9, 0.1], [-40, 2], [0, 1e-9]] as const
    let compared = 0
    for (const [rows, cols] of shapes) {
      const a = Float64Array.from({ length: rows * cols }, () => r() * 200 - 100)
      if (a.length > 4) a[3] = Number.NaN
      for (const [dy, dx] of shifts) {
        const got = shiftConstant(a, rows, cols, dy, dx, 1)
        const want = shiftImage(matOf(rows, cols, a), dy, dx, 1, 'constant', 0).data
        expect(differing(got, want), `${rows}x${cols} shift (${dy}, ${dx})`).toEqual([])
        compared += 1
      }
    }
    expect(compared).toBe(shapes.length * shifts.length)
  })
})
