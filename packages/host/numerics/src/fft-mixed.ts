/**
 * The mixed-radix FFT of `stm_fft_peaks` (visual-memory `fft-peaks.ts`):
 * `abs(fft2(z, s=(Py, Px)))` of a zero-padded frame, at the padded sizes SciPy's
 * `next_fast_len` picks. Moved here from visual-memory unchanged.
 *
 * ## Why it is not `fft.ts`
 *
 * `fft.ts` transforms a power of two with radix 2 and anything else with
 * Bluestein (a convolution padded to the next power of two of `2n − 1`). The sizes
 * here are `2^a 3^b 5^c 7^d 11^e`, and this transform factors them directly
 * (Cooley–Tukey, decimation in time, radix 4 first, then 2, then the odd factors,
 * KISS FFT's order, with one twiddle table `exp(−2πi t / n)` per size). Even on a
 * power of two it takes radix-4 stages, so the two never round alike: they are
 * different algorithms, both accurate to a few units of 1e-16 of the spectrum's norm.
 * The spectrum's parity tolerances against SciPy's pocketfft
 * (`measure-fft-blobs.parity.test.ts`) were measured with this transform, and
 * `fft-mixed.test.ts` bounds it against `fft2` (1e-13 of the largest bin).
 *
 * ## `npHypot`
 *
 * NumPy's `hypot` (and complex `abs`) on the exporter's platform is
 * `sqrt(x*x + y*y)` — 0 mismatches in 200,000 random pairs — which is what
 * {@link npHypot} computes. It matters downstream: `fft_peaks` bins the spectrum by
 * `floor(|k| / dk)`, and Pythagorean bin offsets such as (6, 8) land exactly on a
 * bin edge, where the last bit of |k| picks the annulus. (CPython's `math.hypot`
 * is correctly rounded instead: visual-memory's `pyHypot`.)
 */

/** NumPy's `hypot` (and complex `abs`) on the exporter's platform: `sqrt(x*x + y*y)` (see the module comment). */
export function npHypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}

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
 * end of each axis; row-major `Py x Px`, not shifted. Rows first, then columns.
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
