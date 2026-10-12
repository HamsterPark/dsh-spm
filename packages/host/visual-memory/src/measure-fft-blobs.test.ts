/**
 * Unit tests of the pieces behind `stm_fft_peaks` and `stm_detect_blobs` that the
 * parity golden does not reach on its own: the transform against the numerics
 * package's FFT, the small NumPy/Python helpers, the optimizer's refusals and
 * rarely taken branches, and the tools' answers for frames they cannot use.
 * Parity with the reference itself is `measure-fft-blobs.parity.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fft2, greyDilation, matOf, rectSE } from 'dsh-spm-numerics'
import { afterAll, describe, expect, it } from 'vitest'
import { FrameArchive } from './archive.js'
import { blobGeometry, BlobError, detectBlobs, findBlobs, gaussModel, MAX_BLOBS, scipyGaussianKernel } from './detect-blobs.js'
import {
  fft2Magnitude,
  fftPeaks,
  interpIndex,
  longestFiniteRows,
  maximumFilter,
  nextFastLen,
  pyMod,
  pyTypeName,
  shiftedFreq,
  spectrumPeaks,
  SpectrumError,
} from './fft-peaks.js'
import { leastSquares, LeastSquaresError, nextAfter } from './least-squares.js'
import { encodePngRgb } from './png.js'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

describe('the transform', () => {
  it('next_fast_len is the next 11-smooth size', () => {
    expect([1, 7, 11, 13, 17, 23, 130, 513, 1023, 2047].map(nextFastLen)).toEqual([1, 7, 11, 14, 18, 24, 132, 525, 1024, 2048])
    for (const bad of [0, -3, 1.5, Number.NaN]) expect(() => nextFastLen(bad)).toThrow(RangeError)
  })

  it('the padded magnitude agrees with the numerics FFT for radix 2, 3, 5, 7, 11 and 13', () => {
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

  it('shifted frequencies follow numpy, odd lengths included', () => {
    expect(Array.from(shiftedFreq(5, 0.5))).toEqual([-0.8, -0.4, 0, 0.4, 0.8])
    expect(Array.from(shiftedFreq(4, 1))).toEqual([-0.5, -0.25, 0, 0.25])
  })

  it('interp at index positions: ends, knots, between, NaN', () => {
    const fp = Float64Array.from([10, 20, 40])
    expect([interpIndex(-1, fp), interpIndex(5, fp), interpIndex(2, fp), interpIndex(1, fp), interpIndex(1.25, fp)]).toEqual([10, 40, 40, 20, 25])
    expect(interpIndex(Number.NaN, fp)).toBeNaN()
  })

  it('the separable maximum filter equals grey dilation with a square (nearest)', () => {
    const rnd = seeded(3)
    const a = Float64Array.from({ length: 9 * 11 }, rnd)
    a[17] = -Infinity
    const want = greyDilation(matOf(9, 11, a), rectSE(5, 5), 'nearest')
    expect(Array.from(maximumFilter(a, 9, 11, 5))).toEqual(Array.from(want.data))
  })

  it('keeps the longest run of acquired rows, the first on ties', () => {
    const z = Float64Array.from({ length: 8 * 2 }, () => 1)
    for (const r of [2, 5]) z.fill(Number.NaN, r * 2, r * 2 + 2)
    expect(longestFiniteRows(z, 2, 8)).toEqual({ start: 0, rows: 2 })
    z[1 * 2] = Number.NaN // a row half acquired still counts
    expect(longestFiniteRows(z, 2, 8)).toEqual({ start: 0, rows: 2 })
    expect(longestFiniteRows(new Float64Array(4).fill(Number.NaN), 2, 2)).toEqual({ start: 0, rows: 0 })
  })

  it('refuses fewer than 8 x 8 pixels', () => {
    expect(() => spectrumPeaks(new Float64Array(7 * 9), 9, 7, 0.1, 0.1)).toThrow(SpectrumError)
  })
})

describe('Python and NumPy semantics', () => {
  it('float modulo takes the sign of the divisor and can round up to it', () => {
    expect([pyMod(-30, 180), pyMod(190, 180), pyMod(-1e-17, 180), pyMod(0, 180), pyMod(-0, -180)]).toEqual([150, 10, 180, 0, -0])
  })

  it('type names for the not-an-object refusal', () => {
    expect([null, undefined, [], 'x', true, 3, 2.5, {}].map(pyTypeName)).toEqual(['NoneType', 'NoneType', 'list', 'str', 'bool', 'int', 'float', 'dict'])
  })

  it('SciPy\'s Gaussian kernel: radius int(4 sigma + 0.5), normalised', () => {
    const k = scipyGaussianKernel(0.82)
    expect(k.length).toBe(2 * 3 + 1)
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15)
    expect(k[0]).toBe(k[6])
  })

  it('nextafter', () => {
    expect(nextAfter(1, 2)).toBe(1 + Number.EPSILON)
    expect(nextAfter(1, 0)).toBe(1 - Number.EPSILON / 2)
    expect(nextAfter(-1, 0)).toBe(-1 + Number.EPSILON / 2)
    expect(nextAfter(0, -1)).toBe(-Number.MIN_VALUE)
    expect(nextAfter(3, 3)).toBe(3)
    expect(nextAfter(Number.NaN, 1)).toBeNaN()
  })
})

describe('least squares (TRF): refusals and branches', () => {
  const line = (p: Float64Array) => Float64Array.from([p[0] as number - 1, (p[1] as number) - 2])

  it('refuses what SciPy refuses', () => {
    expect(() => leastSquares(line, [0, 0], [0, 1], [1, 1])).toThrow('strictly less')
    expect(() => leastSquares(line, [5, 0], [0, 0], [1, 1])).toThrow('outside of provided bounds')
    expect(() => leastSquares(line, [0, 0], [0], [1])).toThrow('Inconsistent shapes')
    expect(() => leastSquares(() => Float64Array.of(Number.NaN), [0.5], [0], [1])).toThrow(LeastSquaresError)
  })

  it('stops on gtol at an exact solution', () => {
    const r = leastSquares(line, [0, 0], [-5, -5], [5, 5])
    expect(r.status).toBe(1)
    expect(Array.from(r.x).map((v) => Number(v.toFixed(9)))).toEqual([1, 2])
  })

  it('shrinks the trust region where a trial step makes the residuals non-finite', () => {
    const f = (p: Float64Array) => Float64Array.of(Math.sqrt((p[0] as number) - 1) - 0.01)
    const r = leastSquares(f, [50], [0], [100])
    expect(r.success).toBe(true)
    expect(r.x[0]).toBeCloseTo(1.0001, 6)
  })

  it('handles a rank-deficient Jacobian', () => {
    const f = (p: Float64Array) => {
      const s = (p[0] as number) + (p[1] as number)
      return Float64Array.of(s - 3, 2 * s - 6.1)
    }
    const r = leastSquares(f, [0, 0], [-10, -10], [10, 10])
    expect(r.success).toBe(true)
    expect((r.x[0] as number) + (r.x[1] as number)).toBeCloseTo(3.04, 9)
  })

  it('stops at max_nfev with status 0', () => {
    const r = leastSquares((p) => gaussModel(p, [0, 1, 2, 3], [0, 0, 0, 0]).map((v, i) => v - [0.1, 0.5, 1, 0.5][i]!), [0.5, 1, 0, 1, 1, 0, 0], [0, -5, -5, 0.1, 0.1, -4, -1], [4, 5, 5, 9, 9, 4, 1], { maxNfev: 2 })
    expect([r.status, r.success, r.nfev]).toEqual([0, false, 2])
  })
})

describe('find_blobs edges', () => {
  it('refuses fewer than 64 acquired pixels', () => {
    const z = new Float64Array(16 * 16).fill(Number.NaN)
    z.fill(0, 0, 63)
    expect(() => findBlobs(z, 16, 16, { dxNm: 0.1, dyNm: 0.1 })).toThrow(BlobError)
  })

  it('finds one Gaussian on a flat frame, and the geometry reads it', () => {
    const n = 48
    const z = new Float64Array(n * n)
    const rnd = seeded(11)
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        const dx = c + 0.5 - 20.3
        const dy = r + 0.5 - 25.6
        z[r * n + c] = 50e-12 * Math.exp(-0.5 * ((dx / 2.4) ** 2 + (dy / 1.4) ** 2)) + 1e-12 * rnd()
      }
    }
    const res = findBlobs(z, n, n, { dxNm: 0.2, dyNm: 0.2 })
    expect(res.blobs.length).toBe(1)
    const b = res.blobs[0]!
    expect(b.fit).toBe('gaussian')
    expect(b.col).toBeCloseTo(20.3, 2)
    expect(b.row).toBeCloseTo(25.6, 2)
    const e = { nm_per_px: 0.2, extra: {}, geometry: { angle_deg: 0 } } as never
    const g = blobGeometry(e, b)
    expect(g.fwhm_x_nm).toBeCloseTo(2.3548 * 2.4 * 0.2, 2)
    expect(g.fwhm_y_nm).toBeCloseTo(2.3548 * 1.4 * 0.2, 2)
    expect(g.elongation).toBeCloseTo(2.4 / 1.4, 1)
    expect(Math.min(g.axis_angle_deg, 180 - g.axis_angle_deg)).toBeLessThan(1)
  })
})

describe('the tools on frames they cannot use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-units-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'frames')
  // a spectrum frame, as an index record read back (the archive takes spectra from MAST's files)
  const arc0 = new FrameArchive(root, { displayMax: 64 })
  void arc0
  writeFileSync(join(root, 't0005.d0.png'), encodePngRgb(1, 1, new Uint8Array(3)))
  writeFileSync(
    join(root, 'index.jsonl'),
    `${JSON.stringify({ fid: 't0005.d0', turn: 5, kind: 'd', index: 0, source_name: 'sts', channels: ['Bias (V)'], nx: 8, ny: 1 })}\n`,
  )
  const arc = new FrameArchive(root, { displayMax: 64 })

  it('a spectrum is not a scan frame', () => {
    expect(fftPeaks(arc, { frame: 't0005.d0' })).toEqual({ ok: false, error: 'fft_peaks: frame: t0005.d0 is a spectrum; this tool needs a scan frame' })
    expect(detectBlobs(arc, { frame: 't0005.d0' })).toEqual({ ok: false, error: 'detect_blobs: frame: t0005.d0 is a spectrum; this tool needs a scan frame' })
  })

  it('caps max_n at 50 (spec/deviations.md D-VMEM-9)', () => {
    expect(MAX_BLOBS).toBe(50)
    const e = arc.addPartial(6, { Z: { rows: 16, cols: 16, data: new Float32Array(256) } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 3.2, h_nm: 3.2 } })
    expect(detectBlobs(arc, { frame: e.fid, max_n: 51 })).toEqual({ ok: false, error: 'detect_blobs: arguments.max_n must be <= 50' })
    expect(detectBlobs(arc, { frame: e.fid, max_n: 50 }).ok).toBe(true)
  })
})
