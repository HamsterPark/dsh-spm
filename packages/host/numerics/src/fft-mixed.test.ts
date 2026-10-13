/**
 * The mixed-radix FFT of `stm_fft_peaks` (`fft-mixed.ts`): SciPy's `next_fast_len`
 * (exact, and against the golden `measure_fft_blobs.json` for 1..2200, exported from
 * SciPy itself), and the zero-padded magnitude against this package's `fft2` for radix
 * 2, 3, 5, 7, 11 and 13 (a different algorithm, so within 1e-13 of the largest bin;
 * see the module comment). Its parity with SciPy's pocketfft on whole spectra is
 * visual-memory's `measure-fft-blobs.parity.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fft2 } from './fft.js'
import { fft2Magnitude, nextFastLen, npHypot } from './fft-mixed.js'
import { matOf } from './mat.js'

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/measure_fft_blobs.json', import.meta.url)), 'utf8'),
) as { next_fast_len: { sizes: number[] } }

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

describe('next_fast_len', () => {
  it('is the next 11-smooth size', () => {
    expect([1, 7, 11, 13, 17, 23, 130, 513, 1023, 2047].map(nextFastLen)).toEqual([1, 7, 11, 14, 18, 24, 132, 525, 1024, 2048])
    for (const bad of [0, -3, 1.5, Number.NaN]) expect(() => nextFastLen(bad)).toThrow(RangeError)
  })

  it("equals SciPy's for 1..2200 (measure_fft_blobs.json)", () => {
    const got = golden.next_fast_len.sizes.map((_, i) => nextFastLen(i + 1))
    expect(got).toEqual(golden.next_fast_len.sizes)
  })
})

describe('the zero-padded magnitude', () => {
  it('agrees with fft2 for radix 2, 3, 5, 7, 11 and 13', () => {
    const rnd = seeded(7)
    for (const [ny, nx, Py, Px] of [[6, 10, 12, 20], [7, 11, 7, 11], [5, 9, 15, 18], [3, 13, 6, 13], [1, 4, 1, 8]] as const) {
      const z = Float64Array.from({ length: ny * nx }, rnd)
      const got = fft2Magnitude(z, ny, nx, Py, Px)
      const padded = new Float64Array(Py * Px)
      for (let r = 0; r < ny; r += 1) for (let c = 0; c < nx; c += 1) padded[r * Px + c] = z[r * nx + c] as number
      const want = fft2(matOf(Py, Px, padded))
      let scale = 0
      const ref = new Float64Array(Py * Px)
      for (let i = 0; i < ref.length; i += 1) {
        ref[i] = Math.hypot(want.re.data[i] as number, want.im.data[i] as number)
        scale = Math.max(scale, ref[i] as number)
      }
      got.forEach((v, i) => expect(Math.abs(v - (ref[i] as number))).toBeLessThanOrEqual(1e-13 * scale))
    }
  })

  it("takes NumPy's hypot: sqrt(x*x + y*y), not the correctly rounded one", () => {
    expect(npHypot(3, 4)).toBe(5)
    // A pair where the two differ in the last bit: V8's Math.hypot gave 1.3619685266405934 when
    // this was written. Not asserted: that is the runtime's business, sqrt(x*x + y*y) is IEEE's.
    expect(npHypot(-0.9591946285218, -0.9669043035246432)).toBe(1.3619685266405936)
  })
})
