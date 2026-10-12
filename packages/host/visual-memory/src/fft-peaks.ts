/**
 * `stm_fft_peaks`: the strongest peaks of a frame's 2-D Fourier spectrum, and one
 * numbered image of that spectrum (VISUAL-HARNESS §4.4). The Python reference's
 * `vista_spm.measure` `spectrum_peaks`, `_spectrum_image` and `fft_peaks`, step by
 * step: the region (or frame) keeps its longest run of acquired rows, gaps are
 * filled with the mean, a plane is removed, the mean is removed, a Hann window
 * applied and the frame zero-padded to SciPy's `next_fast_len` of twice its size
 * (once its size above 1024 pixels). On the log-magnitude spectrum, local maxima
 * (5 x 5) outside the central DC lobe (2 bins per axis, `2/field`), within the
 * Nyquist circle and in one half plane (one of each ±k pair) are ranked by
 * strength: log-magnitude above the 30th percentile of its annulus of the same
 * |k| (2 bins wide), in units of that annulus' lower spread (30th minus 5th
 * percentile over 1.121, floored at a quarter of the median spread). Peaks
 * weaker than 3 are dropped. Each listed peak is refined by a parabola through
 * its row and column neighbours and reported as k = 1/period in cycles per nm,
 * its direction in the scan frame (0..180 deg, from +x toward +y) and its
 * components.
 *
 * It measures; it does not say what a peak is. Read-only: only the archive is
 * touched (the spectrum image is archived as a derived frame, like the
 * reference's `Archive.add_derived`).
 *
 * ## Exactness against the reference
 *
 * Everything outside the transform is the reference's arithmetic in its order
 * (fftfreq, the DC lobe, the annulus bins, the percentiles, `np.interp`, the
 * rounding). Three things differ in the last bits and are the reason the
 * parity test (`measure-fft-blobs.parity.test.ts`) states tolerances:
 *
 * - the FFT: pocketfft in SciPy, a mixed-radix Cooley–Tukey here (radix 4, 2, 3,
 *   5, 7, 11, which covers every `next_fast_len` size), both accurate to a few
 *   units of 1e-16 of the spectrum's norm; a bin far below the peak carries
 *   that error relative to its own (small) magnitude;
 * - `log10`, `cos`, `sin`: V8's and the C runtime's differ in the last bit for
 *   a few percent of inputs;
 * - `hypot`: NumPy's (the C runtime's) is `sqrt(x*x + y*y)` on the exporter's
 *   platform — 0 mismatches in 200,000 random pairs — which is what
 *   {@link npHypot} computes. It matters because annulus bins are
 *   `floor(|k| / dk)` and Pythagorean bin offsets such as (6, 8) land exactly
 *   on a bin edge, where the last bit of |k| picks the annulus. CPython's
 *   `math.hypot` (a peak's |k|) is correctly rounded instead: `pyHypot`.
 */
import { mapCoordinates, matOf, npSum } from 'dsh-spm-numerics'
import { ArgError, argsObject, channelDirectionArgs, checkKeys, failure, flattenArgs, numArg, regionArg, type ViewToolResult } from './args.js'
import { entryScale, type FrameArchive } from './archive.js'
import { fitSurface } from './flatten.js'
import { flatFrame, imageEntry, pixelNm } from './line-profile.js'
import { Canvas, drawMarks, type Mark } from './draw.js'
import { pyG, pyRound } from './pyfmt.js'
import { pyHypot, pyMod } from './pymath.js'
import { crop, greyRgb, percentileSorted, regionToNative, upscaleRgb, type LabelAttr } from './render.js'

export const FFT_PEAKS_DEFAULT = 6
export const MAX_FFT_PEAKS = 20
/** Peaks weaker than this (robust units over their annulus) are not listed. */
export const MIN_PEAK_STRENGTH = 3

/** A region too small for a spectrum (the reference's `ValueError`). */
export class SpectrumSizeError extends RangeError {
  override readonly name = 'SpectrumSizeError'
}

// ── small pieces (also used by detect-blobs.ts) ────────────────────────────

/** NumPy's `hypot` (and complex `abs`) on the exporter's platform: `sqrt(x*x + y*y)` (see the module comment). */
export function npHypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}

/** `math.degrees`: CPython multiplies by the constant 180/pi. */
export function degrees(rad: number): number {
  return rad * (180.0 / Math.PI)
}

// ── next_fast_len and the transform ────────────────────────────────────────

/**
 * `scipy.fft.next_fast_len(n)` for complex transforms (pocketfft's
 * `good_size_cmplx`): the smallest `2^a 3^b 5^c 7^d 11^e >= n`. It sets the padded
 * size and so the frequency bins; the golden pins it for n = 1..2200.
 */
export function nextFastLen(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`next_fast_len needs a positive integer, got ${n}`)
  for (let k = n; ; k += 1) {
    let r = k
    for (const p of [2, 3, 5, 7, 11]) while (r % p === 0) r /= p
    if (r === 1) return k
  }
}

interface FftPlan {
  readonly n: number
  readonly stages: readonly { readonly p: number; readonly m: number }[]
  readonly twRe: Float64Array
  readonly twIm: Float64Array
  readonly sRe: Float64Array
  readonly sIm: Float64Array
}

const PLANS = new Map<number, FftPlan>()

/** Radix 4 first, then 2, then odd factors (KISS FFT's order); twiddles `exp(-2 pi i t / n)`. */
function fftPlan(n: number): FftPlan {
  const cached = PLANS.get(n)
  if (cached !== undefined) return cached
  const stages: { p: number; m: number }[] = []
  let m = n
  let p = 4
  let maxP = 1
  while (m > 1) {
    while (m % p !== 0) {
      p = p === 4 ? 2 : p === 2 ? 3 : p + 2
      if (p * p > m) p = m
    }
    m /= p
    stages.push({ p, m })
    maxP = Math.max(maxP, p)
  }
  const twRe = new Float64Array(n)
  const twIm = new Float64Array(n)
  for (let t = 0; t < n; t += 1) {
    const a = (-2 * Math.PI * t) / n
    twRe[t] = Math.cos(a)
    twIm[t] = Math.sin(a)
  }
  const plan = { n, stages, twRe, twIm, sRe: new Float64Array(maxP), sIm: new Float64Array(maxP) }
  PLANS.set(n, plan)
  return plan
}

/** Decimation in time, out of place: `out[outOff + k]` = DFT of `in[inOff + j * fstride]`, k < n / fstride. */
function fftWork(
  plan: FftPlan, stage: number,
  outRe: Float64Array, outIm: Float64Array, outOff: number,
  inRe: Float64Array, inIm: Float64Array, inOff: number, fstride: number,
): void {
  const { p, m } = plan.stages[stage] as { p: number; m: number }
  if (m === 1) {
    for (let q = 0; q < p; q += 1) {
      outRe[outOff + q] = inRe[inOff + q * fstride] as number
      outIm[outOff + q] = inIm[inOff + q * fstride] as number
    }
  } else {
    for (let q = 0; q < p; q += 1) fftWork(plan, stage + 1, outRe, outIm, outOff + q * m, inRe, inIm, inOff + q * fstride, fstride * p)
  }
  const { n, twRe, twIm, sRe, sIm } = plan
  for (let u = 0; u < m; u += 1) {
    for (let q = 0, k = u; q < p; q += 1, k += m) {
      sRe[q] = outRe[outOff + k] as number
      sIm[q] = outIm[outOff + k] as number
    }
    for (let q1 = 0, k = u; q1 < p; q1 += 1, k += m) {
      let tw = 0
      let accRe = sRe[0] as number
      let accIm = sIm[0] as number
      for (let q = 1; q < p; q += 1) {
        tw += fstride * k
        if (tw >= n) tw -= n
        const tr = twRe[tw] as number
        const ti = twIm[tw] as number
        const xr = sRe[q] as number
        const xi = sIm[q] as number
        accRe += xr * tr - xi * ti
        accIm += xr * ti + xi * tr
      }
      outRe[outOff + k] = accRe
      outIm[outOff + k] = accIm
    }
  }
}

/** In-place forward DFT of one line (no normalisation, like `numpy.fft.fft`). */
function fftLine(plan: FftPlan, re: Float64Array, im: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
  if (plan.n === 1) {
    outRe[0] = re[0] as number
    outIm[0] = im[0] as number
    return
  }
  fftWork(plan, 0, outRe, outIm, 0, re, im, 0, 1)
}

/**
 * `abs(fft2(z, s=(Py, Px)))` of a real `ny x nx` row-major array, zero-padded at the
 * end of each axis; row-major `Py x Px`, not shifted.
 */
export function fft2Magnitude(z: ArrayLike<number>, ny: number, nx: number, Py: number, Px: number): Float64Array {
  const re = new Float64Array(Py * Px)
  const im = new Float64Array(Py * Px)
  const rowPlan = fftPlan(Px)
  const inRe = new Float64Array(Px)
  const inIm = new Float64Array(Px)
  const oRe = new Float64Array(Px)
  const oIm = new Float64Array(Px)
  for (let r = 0; r < ny; r += 1) {
    inRe.fill(0)
    for (let c = 0; c < nx; c += 1) inRe[c] = z[r * nx + c] as number
    fftLine(rowPlan, inRe, inIm, oRe, oIm)
    re.set(oRe, r * Px)
    im.set(oIm, r * Px)
  }
  const colPlan = fftPlan(Py)
  const cRe = new Float64Array(Py)
  const cIm = new Float64Array(Py)
  const coRe = new Float64Array(Py)
  const coIm = new Float64Array(Py)
  for (let c = 0; c < Px; c += 1) {
    for (let r = 0; r < Py; r += 1) {
      cRe[r] = re[r * Px + c] as number
      cIm[r] = im[r * Px + c] as number
    }
    fftLine(colPlan, cRe, cIm, coRe, coIm)
    for (let r = 0; r < Py; r += 1) {
      re[r * Px + c] = coRe[r] as number
      im[r * Px + c] = coIm[r] as number
    }
  }
  const mag = new Float64Array(Py * Px)
  for (let i = 0; i < mag.length; i += 1) mag[i] = npHypot(re[i] as number, im[i] as number)
  return mag
}

/** `fftshift(fftfreq(n, d))`. */
export function shiftedFreq(n: number, d: number): Float64Array {
  const val = 1.0 / (n * d)
  const half = Math.floor(n / 2)
  const N = Math.floor((n - 1) / 2) + 1
  const out = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const j = (((i - half) % n) + n) % n // fftshift: out[i] = in[(i - n//2) mod n]
    out[i] = (j < N ? j : j - n) * val
  }
  return out
}

/** `np.interp(x, arange(n), fp)` (NumPy's formula, end values outside). */
export function interpIndex(x: number, fp: Float64Array): number {
  const n = fp.length
  if (Number.isNaN(x)) return x
  if (x < 0) return fp[0] as number
  if (x > n - 1) return fp[n - 1] as number
  const j = Math.min(Math.floor(x), n - 1)
  if (j === n - 1) return fp[j] as number
  if (j === x) return fp[j] as number
  const slope = ((fp[j + 1] as number) - (fp[j] as number)) / (j + 1 - j)
  let out = slope * (x - j) + (fp[j] as number)
  if (Number.isNaN(out)) {
    out = slope * (x - (j + 1)) + (fp[j + 1] as number)
    if (Number.isNaN(out) && fp[j] === fp[j + 1]) out = fp[j] as number
  }
  return out
}

/** `scipy.ndimage.maximum_filter(a, size, mode='nearest')` on a row-major `rows x cols` array (separable). */
export function maximumFilter(a: Float64Array, rows: number, cols: number, size: number): Float64Array {
  const half = size >> 1
  const tmp = new Float64Array(a.length)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let m = -Infinity
      for (let k = c - half; k <= c + half; k += 1) {
        const v = a[r * cols + Math.min(cols - 1, Math.max(0, k))] as number
        if (v > m || Number.isNaN(v)) m = v
      }
      tmp[r * cols + c] = m
    }
  }
  const out = new Float64Array(a.length)
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      let m = -Infinity
      for (let k = r - half; k <= r + half; k += 1) {
        const v = tmp[Math.min(rows - 1, Math.max(0, k)) * cols + c] as number
        if (v > m || Number.isNaN(v)) m = v
      }
      out[r * cols + c] = m
    }
  }
  return out
}

// ── spectrum_peaks ──────────────────────────────────────────────────────────

/** `_longest_finite_rows`: the longest run of rows with at least one acquired pixel (the first on ties). */
export function longestFiniteRows(z: ArrayLike<number>, nx: number, ny: number): { start: number; rows: number } {
  let best = 0
  let cur = 0
  let start = 0
  let bestStart = 0
  for (let r = 0; r < ny; r += 1) {
    let ok = false
    for (let c = 0; c < nx; c += 1) {
      if (Number.isFinite(z[r * nx + c] as number)) {
        ok = true
        break
      }
    }
    if (ok) {
      if (cur === 0) start = r
      cur += 1
      if (cur > best) {
        best = cur
        bestStart = start
      }
    } else {
      cur = 0
    }
  }
  return { start: bestStart, rows: best }
}

export interface SpectrumPeak {
  /** |k| in cycles per nm. */
  readonly k_per_nm: number
  readonly period_nm: number
  /** Direction of k in the scan frame, 0..180 deg from +x toward +y. */
  readonly angle_deg: number
  readonly kx_per_nm: number
  readonly ky_per_nm: number
  /** k along the frame's own axes: right and up. */
  readonly ku: number
  readonly kv: number
  readonly strength: number
}

export interface Spectrum {
  readonly peaks: SpectrumPeak[]
  /** log10 magnitude, fftshifted, row-major `padded[0] x padded[1]` (row 0 = most negative ky). */
  readonly logmag: Float64Array
  readonly fx: Float64Array
  readonly fy: Float64Array
  readonly k_min: number
  readonly k_nyq: number
  readonly dc_lobe_per_nm: [number, number]
  /** `[ny, nx]` analysed (after the longest run of acquired rows). */
  readonly shape: [number, number]
  /** `[Py, Px]`. */
  readonly padded: [number, number]
  readonly pad: number
}

export interface SpectrumOptions {
  readonly nPeaks?: number
  readonly minStrength?: number
  /** The frame's scan angle: peaks are rotated into the scan frame by it. */
  readonly angleDeg?: number
}

/**
 * `spectrum_peaks(z, dx_nm, dy_nm, n_peaks, min_strength, angle_deg)` on a row-major
 * `ny x nx` array (row 0 = top). Throws {@link SpectrumSizeError} when fewer than 8 x 8
 * pixels remain.
 */
export function spectrumPeaks(zIn: ArrayLike<number>, nxIn: number, nyIn: number, dxNm: number, dyNm: number, options: SpectrumOptions = {}): Spectrum {
  const nPeaks = options.nPeaks ?? FFT_PEAKS_DEFAULT
  const minStrength = options.minStrength ?? MIN_PEAK_STRENGTH
  const angleDeg = options.angleDeg ?? 0
  const run = longestFiniteRows(zIn, nxIn, nyIn)
  const ny = run.rows
  const nx = nxIn
  if (ny < 8 || nx < 8) throw new SpectrumSizeError('the region needs at least 8 x 8 acquired pixels for a spectrum')
  const z = new Float64Array(ny * nx)
  // np.nanmean: the pairwise sum of the array with NaN as 0, over the count of finite values
  const zeroed = new Float64Array(ny * nx)
  let count = 0
  for (let i = 0; i < z.length; i += 1) {
    const v = zIn[run.start * nx + i] as number
    z[i] = v
    if (Number.isFinite(v)) {
      zeroed[i] = v
      count += 1
    }
  }
  const fill = npSum(zeroed) / count
  for (let i = 0; i < z.length; i += 1) if (!Number.isFinite(z[i] as number)) z[i] = fill
  const plane = fitSurface(z, nx, ny, 1)
  for (let i = 0; i < z.length; i += 1) z[i] = (z[i] as number) - (plane[i] as number)
  const mean = npSum(z) / z.length
  const winY = hanningWindow(ny)
  const winX = hanningWindow(nx)
  const zw = new Float64Array(z.length)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) zw[r * nx + c] = ((z[r * nx + c] as number) - mean) * ((winY[r] as number) * (winX[c] as number))
  }
  const pad = Math.max(ny, nx) <= 1024 ? 2 : 1
  const Py = nextFastLen(pad * ny)
  const Px = nextFastLen(pad * nx)
  const raw = fft2Magnitude(zw, ny, nx, Py, Px)
  const spec = new Float64Array(Py * Px)
  const hy = Math.floor(Py / 2)
  const hx = Math.floor(Px / 2)
  let specMax = -Infinity
  for (let r = 0; r < Py; r += 1) {
    const rr = (r - hy + Py) % Py
    for (let c = 0; c < Px; c += 1) {
      const v = raw[rr * Px + ((c - hx + Px) % Px)] as number
      spec[r * Px + c] = v
      if (v > specMax) specMax = v
    }
  }
  const floorAdd = specMax * 1e-12
  const logm = new Float64Array(spec.length)
  for (let i = 0; i < spec.length; i += 1) logm[i] = Math.log10((spec[i] as number) + 1e-30 + floorAdd)
  const fx = shiftedFreq(Px, dxNm)
  const fy = shiftedFreq(Py, dyNm)
  const Lx = nx * dxNm
  const Ly = ny * dyNm
  const kMin = 2.0 / Math.min(Lx, Ly)
  const kNyq = 0.5 / Math.max(dxNm, dyNm)
  const dk = 2.0 * Math.max(1.0 / (Px * dxNm), 1.0 / (Py * dyNm))
  const n = Py * Px
  const bins = new Int32Array(n)
  const kr = new Float64Array(n)
  let nb = 0
  for (let r = 0; r < Py; r += 1) {
    const kv = -(fy[r] as number)
    for (let c = 0; c < Px; c += 1) {
      const k = npHypot(fx[c] as number, kv)
      kr[r * Px + c] = k
      const b = Math.floor(k / dk)
      bins[r * Px + c] = b
      if (b + 1 > nb) nb = b + 1
    }
  }
  // annulus statistics: 30th percentile and (p30 - p5) / 1.121 per bin
  const groups: number[][] = Array.from({ length: nb }, () => [])
  for (let i = 0; i < n; i += 1) (groups[bins[i] as number] as number[]).push(logm[i] as number)
  const loc = new Float64Array(nb)
  const scl = new Float64Array(nb)
  groups.forEach((g, b) => {
    if (g.length === 0) return
    const sorted = Float64Array.from(g).sort()
    const p5 = percentileSorted(sorted, 5.0)
    const p30 = percentileSorted(sorted, 30.0)
    loc[b] = p30
    scl[b] = (p30 - p5) / 1.121
  })
  const positive = Array.from(scl).filter((v) => v > 0)
  const floorScl = positive.length > 0 ? Math.max(1e-6, median(positive) * 0.25) : 1e-6
  const strength = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const b = bins[i] as number
    strength[i] = ((logm[i] as number) - (loc[b] as number)) / Math.max(scl[b] as number, floorScl)
  }
  const maxf = maximumFilter(logm, Py, Px, 5)
  const cand: number[] = []
  for (let r = 0; r < Py; r += 1) {
    const kv = -(fy[r] as number)
    for (let c = 0; c < Px; c += 1) {
      const i = r * Px + c
      const ku = fx[c] as number
      const a = (ku * Lx) / 2.0
      const b = (kv * Ly) / 2.0
      const dcLobe = a * a + b * b < 1.0
      const half = kv > 0 || (kv === 0 && ku > 0)
      if (logm[i] === maxf[i] && !dcLobe && half && (kr[i] as number) <= kNyq * 1.0001) cand.push(i)
    }
  }
  // Python's sorted(key=-strength) is stable: ties keep row-major order
  cand.sort((i, j) => {
    const si = -(strength[i] as number)
    const sj = -(strength[j] as number)
    return si < sj ? -1 : sj < si ? 1 : 0
  })
  const peaks: SpectrumPeak[] = []
  const ang = angleDeg * (Math.PI / 180)
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  for (const i of cand) {
    const s = strength[i] as number
    if (s < minStrength || peaks.length >= nPeaks) break
    const r = Math.floor(i / Px)
    const c = i - r * Px
    let dr = 0
    let dc = 0
    if (r > 0 && r < Py - 1) dr = vertex(logm[i - Px] as number, logm[i] as number, logm[i + Px] as number)
    if (c > 0 && c < Px - 1) dc = vertex(logm[i - 1] as number, logm[i] as number, logm[i + 1] as number)
    const ku = interpIndex(c + dc, fx)
    const kv = -interpIndex(r + dr, fy)
    const k = pyHypot(ku, kv)
    const kx = ca * ku - sa * kv
    const ky = sa * ku + ca * kv
    peaks.push({
      k_per_nm: k,
      period_nm: k > 0 ? 1.0 / k : Infinity,
      angle_deg: pyMod(degrees(Math.atan2(ky, kx)), 180.0),
      kx_per_nm: kx,
      ky_per_nm: ky,
      ku,
      kv,
      strength: s,
    })
  }
  return {
    peaks,
    logmag: logm,
    fx,
    fy,
    k_min: kMin,
    k_nyq: kNyq,
    dc_lobe_per_nm: [2.0 / Lx, 2.0 / Ly],
    shape: [ny, nx],
    padded: [Py, Px],
    pad,
  }
}

/** Sub-bin offset of a parabola through three samples, within ±0.5; 0 unless it opens downward. */
function vertex(l0: number, l1: number, l2: number): number {
  const den = l0 - 2 * l1 + l2
  return den < 0 ? Math.min(0.5, Math.max(-0.5, (0.5 * (l0 - l2)) / den)) : 0.0
}

/** `numpy.hanning(m)`. */
function hanningWindow(m: number): Float64Array {
  if (m === 1) return Float64Array.of(1)
  const out = new Float64Array(m)
  for (let k = 0; k < m; k += 1) out[k] = 0.5 + 0.5 * Math.cos((Math.PI * (1 - m + 2 * k)) / (m - 1))
  return out
}

function median(values: readonly number[]): number {
  const s = Float64Array.from(values).sort()
  const h = s.length >> 1
  return s.length % 2 === 1 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2
}

// ── the spectrum image ──────────────────────────────────────────────────────

export interface SpectrumImage {
  /** RGB, `size x size`. */
  readonly rgb: Uint8Array
  /** Half width of the shown k range, cycles per nm: the image covers [-K, K]^2. */
  readonly K: number
  readonly size: number
}

/**
 * `_spectrum_image`: the log-magnitude spectrum resampled bilinearly onto a square
 * grid over [-K, K]^2 (centre k = 0, right +ku, up +kv), K = 1.35 x the farthest
 * listed peak but at least 3 k_min and at most Nyquist; grey from its 1st to 99.9th
 * percentile; enlarged by the largest whole factor that fits `displayMax`.
 */
export function spectrumImage(res: Spectrum, displayMax: number): SpectrumImage {
  const kmax = res.peaks.reduce((m, p) => Math.max(m, p.k_per_nm), 0.0)
  const K = kmax === 0 ? res.k_nyq : Math.min(res.k_nyq, Math.max(1.35 * kmax, 3.0 * res.k_min))
  const { fx, fy } = res
  const dfx = (fx[1] as number) - (fx[0] as number)
  const dfy = (fy[1] as number) - (fy[0] as number)
  const G = Math.trunc(Math.min(Math.max((2.0 * K) / Math.min(dfx, dfy), 64), displayMax))
  const g = new Float64Array(G)
  for (let i = 0; i < G; i += 1) g[i] = (((i + 0.5) / G) * 2.0) * K - K
  const rows = new Float64Array(G * G)
  const cols = new Float64Array(G * G)
  for (let r = 0; r < G; r += 1) {
    const kv = g[G - 1 - r] as number
    for (let c = 0; c < G; c += 1) {
      cols[r * G + c] = ((g[c] as number) - (fx[0] as number)) / dfx
      rows[r * G + c] = (-kv - (fy[0] as number)) / dfy
    }
  }
  const [Py, Px] = res.padded
  const img = mapCoordinates(matOf(Py, Px, res.logmag), rows, cols, 1, 'nearest')
  const sorted = Float64Array.from(img).sort()
  const lo = percentileSorted(sorted, 1.0)
  const hi = percentileSorted(sorted, 99.9)
  const up = Math.max(1, Math.floor(displayMax / G))
  return { rgb: upscaleRgb(greyRgb(img, lo, hi), G, G, up), K, size: G * up }
}

/** The reference's marks on the spectrum image: peak `i` at its (ku, kv), radius max(7, 1.8 % of the size). */
export function spectrumMarks(res: Spectrum, K: number, size: number): Mark[] {
  const marks: Mark[] = []
  res.peaks.forEach((p, k) => {
    const x = ((p.ku + K) / (2 * K)) * size
    const y = ((K - p.kv) / (2 * K)) * size
    if (x >= 0 && x <= size && y >= 0 && y <= size) marks.push({ x, y, r: Math.max(7.0, size * 0.018), text: String(k + 1) })
  })
  return marks
}

// ── the tool ────────────────────────────────────────────────────────────────

const FFT_KEYS: ReadonlySet<string> = new Set(['frame', 'region', 'channel', 'direction', 'n_peaks', 'flatten', 'highpass_nm'])

/** Turns an RGB image and its marks into the PNG that is archived (a parameter so tests can see the marks). */
export type MarkPainter = (rgb: Uint8Array, width: number, height: number, marks: readonly Mark[]) => Uint8Array

/** The reference's `_draw_marks`: numbered rings in the mark colour (spec/deviations.md D-VMEM-6 for the pixels). */
export const paintMarks: MarkPainter = (rgb, width, height, marks) => {
  const canvas = Canvas.fromRgb(width, height, rgb)
  drawMarks(canvas, marks)
  return canvas.png()
}

/**
 * `fft_peaks(archive, args)`: see the module comment. Never throws; invalid
 * arguments come back as `{ ok: false, error }` with the reference's message.
 */
export function fftPeaks(archive: FrameArchive, args: unknown, paint: MarkPainter = paintMarks): ViewToolResult {
  try {
    const a = argsObject(args)
    checkKeys(a, FFT_KEYS, ['frame'], 'arguments')
    const e = imageEntry(archive, a)
    const [ch, direction] = channelDirectionArgs(archive, e, a, 'arguments')
    const [mode, hp] = flattenArgs(a, 'arguments')
    const nPeaks = numArg(a, 'n_peaks', 'arguments', { def: FFT_PEAKS_DEFAULT, lo: 1, hi: MAX_FFT_PEAKS, integer: true }) as number
    const region = regionArg(e, a, 'arguments')
    const box = regionToNative(region, e.nx, e.ny, entryScale(e))
    const [dx, dy] = pixelNm(e)
    const flat = flatFrame(archive, e, ch, direction, mode, hp)
    const [i0, j0, i1, j1] = box
    const angle = e.geometry?.angle_deg || 0.0
    let res: Spectrum
    try {
      res = spectrumPeaks(crop(flat, e.nx, box), i1 - i0, j1 - j0, dx, dy, { nPeaks, angleDeg: angle })
    } catch (err) {
      if (err instanceof SpectrumSizeError) throw new ArgError(err.message)
      throw err
    }
    const img = spectrumImage(res, archive.displayMax)
    const marks = spectrumMarks(res, img.K, img.size)
    const png = paint(img.rgb, img.size, img.size, marks)
    const attrs: LabelAttr[] = [
      ['channel', ch],
      ['direction', direction],
      ['region', region === null ? null : `${region.x},${region.y},${region.width},${region.height}`],
      ['spectrum', 'log magnitude'],
      ['k_half_width_per_nm', pyG(img.K, 4)],
      ['axes', 'center k=0, right +x, up +y (frame axes)'],
      ['marks', `${marks.length} numbered peaks`],
    ]
    const de = archive.addDerived(archive.currentTurn, png, {
      tool: 'fft_peaks',
      sources: [e.fid],
      description: `log-magnitude spectrum of ${ch} ${direction}`,
      labelAttrs: attrs,
    })
    const obs = archive.observation(de.fid)
    const [ny, nx] = res.shape
    const body: Record<string, unknown> = {
      instrument_unchanged: true,
      frame: e.fid,
      channel: ch,
      direction,
      flatten: mode,
      region_px: region === null ? null : [region.x, region.y, region.width, region.height],
      native_px: [...box],
      analysed_px: [nx, ny],
      field_nm: [pyRound(nx * dx, 4), pyRound(ny * dy, 4)],
      window: 'hann',
      zero_padding: res.pad,
      k_resolution_per_nm: pyRound(1.0 / Math.min(nx * dx, ny * dy), 5),
      dc_lobe_excluded_per_nm: res.dc_lobe_per_nm.map((v) => pyRound(v, 5)),
      k_nyquist_per_nm: pyRound(res.k_nyq, 5),
      peaks: res.peaks.map((p, k) => ({
        id: k + 1,
        k_per_nm: pyRound(p.k_per_nm, 5),
        period_nm: pyRound(p.period_nm, 4),
        angle_deg: pyRound(p.angle_deg, 2),
        kx_per_nm: pyRound(p.kx_per_nm, 5),
        ky_per_nm: pyRound(p.ky_per_nm, 5),
        strength: pyRound(p.strength, 2),
      })),
      image: {
        frame: de.fid,
        size_px: [img.size, img.size],
        k_half_width_per_nm: pyRound(img.K, 5),
        per_nm_per_image_px: pyRound((2 * img.K) / img.size, 6),
      },
    }
    if (res.peaks.length === 0) body['note'] = `no local maximum reached strength ${MIN_PEAK_STRENGTH}`
    return { ok: true, reply: body, images: [{ png: obs.png, label: obs.label, name: `${de.fid}.png` }] }
  } catch (err) {
    return failure('fft_peaks', err)
  }
}
