/**
 * Sub-pixel registration of two frames on one grid (VISTA-SPM
 * `measure.register`, `_ncc_surface`, `_corr_length`).
 *
 * `register(a, b)` finds the shift `d = (dx, dy)` (pixels, x right, y down) with
 * `b(p) ≈ a(p − d)`: the content moved by `+d` from `a` to `b`.
 *
 * 1. Both are made zero-mean over their acquired pixels (NaN → 0, with masks).
 * 2. The normalized cross-correlation over the valid overlap for every integer
 *    shift `|d| ≤ lim = int(0.4 · min(rows, cols))` (zero padded, no
 *    wrap-around; shifts whose overlap is under 30 % of the smaller frame
 *    score −1).
 * 3. The integer peak, refined by a parabola through its neighbours (±0.5 px).
 * 4. The confidence: the peak over the best correlation farther from it than
 *    twice the image's correlation length (where its autocorrelation first
 *    drops below 0.5), clipped to `2 … max(2, lim/2)` pixels.
 * 5. Nelder–Mead ({@link nelderMead}, the reference's options) maximises the
 *    correlation of the cubic-spline-shifted `a` with `b` over a central window
 *    of at most {@link REFINE_PX}² pixels, starting at the parabolic estimate;
 *    the result is kept when it is no worse and within 1 px of the start.
 *
 * ## Tolerances against the reference
 *
 * - The spline shift, the masks, the correlation sums (numpy's pairwise
 *   order) and Nelder–Mead are bit-identical ({@link shiftConstant},
 *   {@link splineFilter3}, `npSum`, {@link nelderMead}).
 * - The correlation surface is not: scipy's `fftconvolve` (pocketfft, real
 *   transforms) and the radix-2 transform here round differently, about
 *   `eps · log2(N)` of the largest correlation sum. That moves the parabolic
 *   start by ~1e-14 px, and Nelder–Mead then evaluates points that differ by as
 *   much; its branch decisions compare values that differ by far more, so it
 *   takes the same path and the result differs by the same ~1e-14 px. The
 *   parity test bounds it (and every other output) in its header.
 *
 * ## A property of the reference worth knowing
 *
 * The refinement correlates only pixels whose shifted source lies inside the
 * window (`shift(mask, d, order=1) > 0.999`). That set changes when a shift
 * component crosses an integer, so the objective jumps there; with a weak
 * correlation (steps, creep bows, large shifts) the optimum can sit on such a
 * jump and the reported shift snaps to an integer (the golden's
 * `steps_creep_large_shift`: 29.000, 4.000 px). The port keeps it.
 */
import { npMean, npSum } from 'dsh-spm-numerics'
import { nelderMead } from './nelder-mead.js'
import { shiftConstant, splineFilter3 } from './ndinterp.js'
import { rint } from './pyfmt.js'

/** Side of the central window the sub-pixel registration is refined on. */
export const REFINE_PX = 256

/** What {@link register} found; field names follow the reference's dict. */
export interface Registration {
  /** Shift of the content from `a` to `b`, pixels, x right. */
  readonly dx: number
  /** … and y down. */
  readonly dy: number
  readonly ncc_peak: number
  /** Best correlation farther than `exclusion_px` from the peak; NaN when there is none. */
  readonly second_peak: number
  /** `ncc_peak / second_peak`, `Infinity` when the second peak is not positive. */
  readonly confidence: number
  /** The integer search limit `lim`. */
  readonly limit_px: number
  readonly at_search_edge: boolean
  /** Whether the Nelder–Mead refinement replaced the parabolic estimate. */
  readonly refined: boolean
  readonly exclusion_px: number
}

// ── FFT (radix-2, cached twiddles) ──────────────────────────────────────────

interface Plan {
  readonly n: number
  readonly cos: Float64Array
  readonly sin: Float64Array
  readonly rev: Uint32Array
}

const plans = new Map<number, Plan>()

function plan(n: number): Plan {
  let p = plans.get(n)
  if (p === undefined) {
    const half = n >> 1
    const cos = new Float64Array(half)
    const sin = new Float64Array(half)
    for (let k = 0; k < half; k += 1) {
      cos[k] = Math.cos((2 * Math.PI * k) / n)
      sin[k] = Math.sin((2 * Math.PI * k) / n)
    }
    const rev = new Uint32Array(n)
    const bits = Math.round(Math.log2(n))
    for (let i = 0; i < n; i += 1) {
      let r = 0
      for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b)
      rev[i] = r
    }
    p = { n, cos, sin, rev }
    plans.set(n, p)
  }
  return p
}

/** In-place transform of one contiguous line; `inverse` does not divide by n. */
function fft1(re: Float64Array, im: Float64Array, p: Plan, inverse: boolean): void {
  const n = p.n
  for (let i = 0; i < n; i += 1) {
    const j = p.rev[i] as number
    if (i < j) {
      const tr = re[i] as number
      re[i] = re[j] as number
      re[j] = tr
      const ti = im[i] as number
      im[i] = im[j] as number
      im[j] = ti
    }
  }
  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let k = 0; k < half; k += 1) {
      const wr = p.cos[k * step] as number
      const wi = sign * (p.sin[k * step] as number)
      for (let a = k; a < n; a += len) {
        const b = a + half
        const br = re[b] as number
        const bi = im[b] as number
        const xr = br * wr - bi * wi
        const xi = br * wi + bi * wr
        const ar = re[a] as number
        const ai = im[a] as number
        re[b] = ar - xr
        im[b] = ai - xi
        re[a] = ar + xr
        im[a] = ai + xi
      }
    }
  }
}

/** In-place 2-D transform of a `rows × cols` complex array (both powers of two). */
function fft2(re: Float64Array, im: Float64Array, rows: number, cols: number, inverse: boolean): void {
  const pr = plan(cols)
  const lr = new Float64Array(cols)
  const li = new Float64Array(cols)
  for (let r = 0; r < rows; r += 1) {
    lr.set(re.subarray(r * cols, (r + 1) * cols))
    li.set(im.subarray(r * cols, (r + 1) * cols))
    fft1(lr, li, pr, inverse)
    re.set(lr, r * cols)
    im.set(li, r * cols)
  }
  // Columns in blocks of up to 16, gathered row by row: each row's cache line is read once per block.
  const pc = plan(rows)
  const B = Math.min(16, cols)
  const cr = Array.from({ length: B }, () => new Float64Array(rows))
  const ci = Array.from({ length: B }, () => new Float64Array(rows))
  for (let c0 = 0; c0 < cols; c0 += B) {
    const nb = Math.min(B, cols - c0)
    for (let r = 0; r < rows; r += 1) {
      const o = r * cols + c0
      for (let j = 0; j < nb; j += 1) {
        ;(cr[j] as Float64Array)[r] = re[o + j] as number
        ;(ci[j] as Float64Array)[r] = im[o + j] as number
      }
    }
    for (let j = 0; j < nb; j += 1) fft1(cr[j] as Float64Array, ci[j] as Float64Array, pc, inverse)
    for (let r = 0; r < rows; r += 1) {
      const o = r * cols + c0
      for (let j = 0; j < nb; j += 1) {
        re[o + j] = (cr[j] as Float64Array)[r] as number
        im[o + j] = (ci[j] as Float64Array)[r] as number
      }
    }
  }
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** `v · 2^k` with the largest magnitude in [1, 2) (unchanged when all zero). */
function toUnitScale(v: Float64Array): Float64Array {
  let m = 0
  for (const x of v) m = Math.max(m, Math.abs(x))
  if (!(m > 0 && Number.isFinite(m))) return v
  const k = 2 ** -Math.floor(Math.log2(m))
  return v.map((x) => x * k)
}

/** Two real `rows × cols` arrays as one zero-padded complex `P × Q` array (`x + i·y`), transformed. */
function packed(x: Float64Array, y: Float64Array, rows: number, cols: number, P: number, Q: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(P * Q)
  const im = new Float64Array(P * Q)
  for (let r = 0; r < rows; r += 1) {
    re.set(x.subarray(r * cols, (r + 1) * cols), r * Q)
    im.set(y.subarray(r * cols, (r + 1) * cols), r * Q)
  }
  fft2(re, im, P, Q, false)
  return { re, im }
}

/**
 * The reference's `_ncc_surface`: `NCC[(dy + lim)·(2·lim + 1) + (dx + lim)]` of
 * `b(p)` with `a(p − d)` over the valid overlap, for integer shifts `|d| ≤ lim`
 * (zero padded, no wrap-around); `−1` where the overlap count is under
 * `minOverlap`. `a`, `b` are zero where their masks `ma`, `mb` are 0.
 *
 * The four correlation sums (`Σ b·a`, `Σ mb·a²`, `Σ b²·ma`, `Σ mb·ma` over each
 * shifted overlap) come from five transforms of size `P × Q` (the next powers of
 * two of `rows + lim`, `cols + lim`, enough for lags up to `lim` without
 * wrap-around): three forward transforms of real pairs packed as `x + i·y`,
 * two inverse ones that each return two real correlations as `re + i·im`.
 */
export function nccSurface(
  a: Float64Array,
  ma: Float64Array,
  b: Float64Array,
  mb: Float64Array,
  rows: number,
  cols: number,
  lim: number,
  minOverlap: number,
): Float64Array {
  const P = nextPow2(rows + lim)
  const Q = nextPow2(cols + lim)
  // A packed pair shares one transform's rounding, so both halves are brought to the masks'
  // scale first (heights in metres are ~1e-11): by a power of two, which is exact and leaves
  // the normalized correlation unchanged.
  const an = toUnitScale(a)
  const bn = toUnitScale(b)
  const sq = (v: Float64Array): Float64Array => v.map((x) => x * x)
  const z1 = packed(bn, mb, rows, cols, P, Q) // B + i·MB
  const z2 = packed(an, ma, rows, cols, P, Q) // A + i·MA
  const z3 = packed(sq(bn), sq(an), rows, cols, P, Q) // B2 + i·A2
  // Unpack each pair (X[k] = (Z[k] + conj Z[−k]) / 2, Y[k] = (Z[k] − conj Z[−k]) / 2i) and form
  //   Y1 = B·conj(A) + i·B2·conj(MA)        → C + i·EB
  //   Y2 = MB·(conj(A2) + i·conj(MA))       → EA + i·NO
  // writing Y1 over z1 and Y2 over z2 (each pair k, −k is read before either is written).
  const out = (k: number, kk: number): [number, number, number, number] => {
    const br = ((z1.re[k] as number) + (z1.re[kk] as number)) / 2
    const bi = ((z1.im[k] as number) - (z1.im[kk] as number)) / 2
    const mbr = ((z1.im[k] as number) + (z1.im[kk] as number)) / 2
    const mbi = ((z1.re[kk] as number) - (z1.re[k] as number)) / 2
    const ar = ((z2.re[k] as number) + (z2.re[kk] as number)) / 2
    const ai = ((z2.im[k] as number) - (z2.im[kk] as number)) / 2
    const mar = ((z2.im[k] as number) + (z2.im[kk] as number)) / 2
    const mai = ((z2.re[kk] as number) - (z2.re[k] as number)) / 2
    const b2r = ((z3.re[k] as number) + (z3.re[kk] as number)) / 2
    const b2i = ((z3.im[k] as number) - (z3.im[kk] as number)) / 2
    const a2r = ((z3.im[k] as number) + (z3.im[kk] as number)) / 2
    const a2i = ((z3.re[kk] as number) - (z3.re[k] as number)) / 2
    const p1r = br * ar + bi * ai
    const p1i = bi * ar - br * ai
    const p2r = b2r * mar + b2i * mai
    const p2i = b2i * mar - b2r * mai
    const qr = a2r + mai
    const qi = mar - a2i
    return [p1r - p2i, p1i + p2r, mbr * qr - mbi * qi, mbr * qi + mbi * qr]
  }
  for (let u = 0; u < P; u += 1) {
    const uu = (P - u) % P
    for (let v = 0; v < Q; v += 1) {
      const k = u * Q + v
      const kk = uu * Q + ((Q - v) % Q)
      if (kk < k) continue
      const y = out(k, kk)
      const yy = kk === k ? y : out(kk, k)
      z1.re[k] = y[0]
      z1.im[k] = y[1]
      z2.re[k] = y[2]
      z2.im[k] = y[3]
      z1.re[kk] = yy[0]
      z1.im[kk] = yy[1]
      z2.re[kk] = yy[2]
      z2.im[kk] = yy[3]
    }
  }
  fft2(z1.re, z1.im, P, Q, true)
  fft2(z2.re, z2.im, P, Q, true)
  // scipy transforms an all-zero signal to exact zeros (correlation 0 everywhere, e.g. a flat
  // frame); here its packed partner would leave rounding noise in place of those zeros.
  const aZero = an.every((x) => x === 0)
  const bZero = bn.every((x) => x === 0)
  const n = P * Q
  const side = 2 * lim + 1
  const ncc = new Float64Array(side * side)
  for (let dy = -lim; dy <= lim; dy += 1) {
    const row = ((dy + P) % P) * Q
    for (let dx = -lim; dx <= lim; dx += 1) {
      const k = row + ((dx + Q) % Q)
      const C = aZero || bZero ? 0 : (z1.re[k] as number) / n
      const EB = bZero ? 0 : (z1.im[k] as number) / n
      const EA = aZero ? 0 : (z2.re[k] as number) / n
      const NO = (z2.im[k] as number) / n
      const den = Math.sqrt(Math.max(EA, 0) * Math.max(EB, 0))
      let v = den > 0 ? C / den : 0
      if (NO < minOverlap) v = -1
      ncc[(dy + lim) * side + (dx + lim)] = v
    }
  }
  return ncc
}

/** Radius (px) at which the image's normalized autocorrelation first falls below 0.5 (`_corr_length`). */
export function corrLength(a0: Float64Array, ma: Float64Array, rows: number, cols: number, lim: number): number {
  const acf = nccSurface(a0, ma, a0, ma, rows, cols, Math.max(1, lim), 0.3 * npSum(ma))
  const side = 2 * Math.max(1, lim) + 1
  for (let r = 1; r <= lim; r += 1) {
    const ring: number[] = []
    for (let y = -lim; y <= lim; y += 1) {
      for (let x = -lim; x <= lim; x += 1) {
        if (rint(Math.sqrt(y * y + x * x)) === r) ring.push(acf[(y + lim) * side + (x + lim)] as number)
      }
    }
    if (ring.length > 0 && npMean(ring) < 0.5) return r
  }
  return lim
}

/** numpy `nanmean`: the mean of the non-NaN values (NaN when there are none). */
function nanMean(a: Float64Array): number {
  let count = 0
  const filled = a.map((v) => {
    if (Number.isNaN(v)) return 0
    count += 1
    return v
  })
  return npSum(filled) / count
}

/** `a[y0:y0+h, x0:x0+w]` of a row-major `cols`-wide array. */
function window(a: Float64Array, cols: number, y0: number, x0: number, h: number, w: number): Float64Array {
  const out = new Float64Array(h * w)
  for (let r = 0; r < h; r += 1) out.set(a.subarray((y0 + r) * cols + x0, (y0 + r) * cols + x0 + w), r * w)
  return out
}

/**
 * The reference's `register(a, b, max_shift_frac=0.4)` for two `rows × cols`
 * arrays on one grid (NaN where not acquired). See the module comment.
 * `onEvaluate` sees every Nelder–Mead evaluation (shift `[dy, dx]`, value), in order.
 */
export function register(
  a: Float64Array,
  b: Float64Array,
  rows: number,
  cols: number,
  maxShiftFrac = 0.4,
  onEvaluate?: (d: readonly number[], f: number) => void,
): Registration {
  if (a.length !== rows * cols || b.length !== rows * cols) throw new RangeError(`register needs two ${rows}x${cols} arrays`)
  const ma = a.map((v) => (Number.isFinite(v) ? 1 : 0))
  const mb = b.map((v) => (Number.isFinite(v) ? 1 : 0))
  const meanA = nanMean(a)
  const meanB = nanMean(b)
  const a0 = a.map((v, i) => ((ma[i] as number) > 0 ? v - meanA : 0))
  const b0 = b.map((v, i) => ((mb[i] as number) > 0 ? v - meanB : 0))
  const lim = Math.max(1, Math.trunc(maxShiftFrac * Math.min(rows, cols)))
  const side = 2 * lim + 1
  const ncc = nccSurface(a0, ma, b0, mb, rows, cols, lim, 0.3 * Math.min(npSum(ma), npSum(mb)))
  let best = 0
  for (let i = 1; i < ncc.length; i += 1) if ((ncc[i] as number) > (ncc[best] as number)) best = i
  const k0 = Math.floor(best / side)
  const k1 = best - k0 * side
  const peak = ncc[best] as number
  const parab = (axis: 0 | 1): number => {
    const k = axis === 0 ? k0 : k1
    if (!(k > 0 && k < side - 1)) return 0
    const at = (o: number): number => (axis === 0 ? (ncc[(k0 + o) * side + k1] as number) : (ncc[k0 * side + k1 + o] as number))
    const m1 = at(-1)
    const p1 = at(1)
    const curv = m1 - 2 * peak + p1
    return curv < 0 ? Math.min(0.5, Math.max(-0.5, (0.5 * (m1 - p1)) / curv)) : 0
  }
  const dy0 = k0 - lim + parab(0)
  const dx0 = k1 - lim + parab(1)
  // The best alternative alignment: the highest correlation farther from the peak than twice the
  // image's own correlation length (a ridge or a lattice gives a high one: ambiguous).
  const ell = corrLength(a0, ma, rows, cols, Math.min(lim, 32))
  const excl = Math.min(Math.max(2 * ell, 2), Math.max(2, lim / 2))
  let second = -Infinity
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const v = ncc[y * side + x] as number
      if (Math.sqrt((y - k0) * (y - k0) + (x - k1) * (x - k1)) > excl && v > -1 && v > second) second = v
    }
  }
  if (second === -Infinity) second = NaN
  // Refine on a central window of at most REFINE_PX² (the shift is global; the cost stays bounded).
  const wy = Math.min(rows, REFINE_PX)
  const wx = Math.min(cols, REFINE_PX)
  const y0w = (rows - wy) >> 1
  const x0w = (cols - wx) >> 1
  const coeffs = splineFilter3(window(a0, cols, y0w, x0w, wy, wx), wy, wx)
  const maW = window(ma, cols, y0w, x0w, wy, wx)
  const mbW = window(mb, cols, y0w, x0w, wy, wx)
  const b0W = window(b0, cols, y0w, x0w, wy, wx)
  // Buffers reused by every evaluation: the selected pixels of the shifted a and of b, and products.
  const su = new Float64Array(wy * wx)
  const sv = new Float64Array(wy * wx)
  const prod = new Float64Array(wy * wx)
  const negNcc = (d: readonly number[]): number => {
    const sa = shiftConstant(coeffs, wy, wx, d[0] as number, d[1] as number, 3)
    const valid = shiftConstant(maW, wy, wx, d[0] as number, d[1] as number, 1)
    let m = 0
    for (let i = 0; i < sa.length; i += 1) {
      if ((valid[i] as number) > 0.999 && (mbW[i] as number) > 0) {
        su[m] = sa[i] as number
        sv[m] = b0W[i] as number
        m += 1
      }
    }
    if (m < 16) return 1.0
    const u = su.subarray(0, m)
    const v = sv.subarray(0, m)
    const p = prod.subarray(0, m)
    const mu = npMean(u)
    const mv = npMean(v)
    for (let i = 0; i < m; i += 1) {
      u[i] = (u[i] as number) - mu
      v[i] = (v[i] as number) - mv
    }
    for (let i = 0; i < m; i += 1) p[i] = (u[i] as number) * (u[i] as number)
    const uu = npSum(p)
    for (let i = 0; i < m; i += 1) p[i] = (v[i] as number) * (v[i] as number)
    const den = Math.sqrt(uu * npSum(p))
    if (!(den > 0)) return 1.0
    for (let i = 0; i < m; i += 1) p[i] = (u[i] as number) * (v[i] as number)
    return -(npSum(p) / den)
  }
  let dy = dy0
  let dx = dx0
  let refined = false
  const f0 = negNcc([dy0, dx0])
  const objective = (d: readonly number[]): number => {
    const f = negNcc(d)
    onEvaluate?.(d, f)
    return f
  }
  const sol = nelderMead(objective, [[dy0, dx0], [dy0 + 0.3, dx0], [dy0, dx0 + 0.3]], { xatol: 2e-3, fatol: 1e-9, maxiter: 120 })
  const [ry, rx] = sol.x as [number, number]
  if (sol.fun <= f0 && Math.abs(ry - dy0) <= 1.0 && Math.abs(rx - dx0) <= 1.0) {
    dy = ry
    dx = rx
    refined = true
  }
  return {
    dx,
    dy,
    ncc_peak: peak,
    second_peak: second,
    confidence: second > 0 ? peak / second : Infinity, // NaN and 0 included, as `if second and second > 0`
    limit_px: lim,
    at_search_edge: Math.abs(k0 - lim) >= lim || Math.abs(k1 - lim) >= lim,
    refined,
    exclusion_px: excl,
  }
}
