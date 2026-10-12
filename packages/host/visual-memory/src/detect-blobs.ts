/**
 * `stm_detect_blobs`: compact bright (or dark) features of a frame, each located,
 * measured and numbered on one image (VISUAL-HARNESS §4.4). The Python
 * reference's `vista_spm.measure` `find_blobs`, `_fit_blob`, `_moments_blob`,
 * `_blob_geometry` and `detect_blobs`, step by step:
 *
 * 1. the plane-flattened frame (sign-flipped for `dark`), gaps filled with its
 *    median, minus a median background `background_nm` wide, is the residual; its
 *    noise is 1.4826 x MAD;
 * 2. the residual is smoothed (Gaussian, sigma = 0.15 nm in pixels, 0.7..2), and
 *    local maxima (window `2 * round(min_sep_nm / px) + 1`) above 6 robust sigmas
 *    of the smoothed residual, inside the region, are candidates, strongest first;
 * 3. a candidate within 2.5 nm (at least 3 px) of a kept one is merged into it
 *    unless the smoothed residual dips below 80 % of the candidate's height on the
 *    straight line between them (no saddle, one blob);
 * 4. every pixel belongs to its nearest kept candidate; each candidate's
 *    half-maximum region (4-connected) sets a start width, and an elliptical
 *    Gaussian plus a constant is fitted to the residual of the pixels it owns
 *    within `3 sigma + 2` pixels ({@link leastSquares}); when the fit fails or
 *    wanders off, intensity moments of the half-maximum region take its place
 *    (`fit: "moments"`);
 * 5. blobs narrower than one pixel (FWHM of the minor axis), lower than 3 noise
 *    sigmas or than `min_height` are dropped; the highest `max_n` are kept and
 *    numbered in reading order.
 *
 * Read-only: only the archive is touched (the marked image is archived as a
 * derived frame).
 *
 * ## Where this differs from the reference (spec/deviations.md)
 *
 * - D-VMEM-9: `max_n` at most 50 (the reference allows 200).
 * - D-VMEM-10: a pixel equally far from two candidates belongs to the earlier
 *   (stronger) one. The reference asks SciPy's `cKDTree`, which returns the
 *   earlier one only while there are at most 16 candidates (one leaf); beyond
 *   that its tree's traversal order decides, which depends on the build.
 *
 * ## Exactness against the reference
 *
 * The array steps follow the reference's arithmetic in its order: medians and
 * maxima pick input values, the Gaussian kernel is SciPy's
 * (`exp(-0.5 / sigma^2 * x^2)`, normalised by NumPy's pairwise sum, symmetric
 * taps summed outside-in as `NI_Correlate1D` does), sums over pixels are NumPy's
 * pairwise sums. What differs is the last bit of `exp` (V8 vs. the C runtime),
 * the block mean and bilinear resampling of the background, and the optimizer
 * (see `least-squares.ts`); the parity test states the tolerances.
 */
import { npSum } from 'dsh-spm-numerics'
import {
  ArgError,
  argsObject,
  channelDirectionArgs,
  checkKeys,
  failure,
  numArg,
  regionArg,
  strArg,
  type ViewToolResult,
} from './args.js'
import { entryScale, type FrameArchive, type FrameEntry } from './archive.js'
import { flatten, HIGHPASS_NM_DEFAULT, medianBackground, nanMedian } from './flatten.js'
import { degrees, imageEntry, maximumFilter, paintMarks, pixelNm, type Mark, type MarkPainter } from './fft-peaks.js'
import { nativeToScanNm, type ScanGeometry } from './geometry.js'
import { leastSquares, LeastSquaresError } from './least-squares.js'
import { decodePng, toRgb } from './png.js'
import { pyG, pyRound, pyRoundInt, rint } from './pyfmt.js'
import { pyHypot, pyMod } from './pymath.js'
import { CLIP_PCT_DEFAULT, planView, regionToNative, renderValues, type LabelAttr, type Region, type View } from './render.js'
import { formatKey, formatValue } from './units.js'

/** `2 sqrt(2 ln 2)`: FWHM per Gaussian sigma. */
export const FWHM_PER_SIGMA = 2.0 * Math.sqrt(2.0 * Math.log(2.0))
/** The reference's `MAX_BLOBS` is 200; this port caps at 50 (spec/deviations.md D-VMEM-9). */
export const MAX_BLOBS = 50
export const BLOBS_DEFAULT = 50
export const MIN_SEP_NM_DEFAULT = 0.3
export const BACKGROUND_NM_DEFAULT = 3.0
export const THRESHOLD_SIGMA = 6.0

/** Fewer than 64 acquired pixels (the reference's `ValueError`). */
export class BlobError extends RangeError {
  override readonly name = 'BlobError'
}

/** One blob as `find_blobs` returns it: native coordinates, SI height (sign removed), sigmas in px. */
export interface Blob {
  /** Amplitude above the local background (SI, positive for the requested polarity). */
  readonly A: number
  /** Centre in native pixel-centre coordinates (pixel i at i). */
  readonly x0: number
  readonly y0: number
  /** Gaussian sigmas along the axes rotated by `theta` (px). */
  readonly sa: number
  readonly sb: number
  /** Rotation of the `sa` axis, radians, image axes (y down). */
  readonly theta: number
  readonly c: number
  readonly fit: 'gaussian' | 'moments'
  /** Continuous native coordinates (0 = left / top edge): `x0 + 0.5`, `y0 + 0.5`. */
  readonly col: number
  readonly row: number
  readonly height: number
  readonly peak_sigma: number
}

export interface BlobResult {
  readonly blobs: Blob[]
  /** Robust noise of the residual and of the smoothed residual (SI). */
  readonly noise: number
  readonly noise_smoothed: number
  readonly threshold: number
  readonly smoothing_px: number
  readonly n_candidates: number
  readonly truncated: boolean
  readonly sign: number
}

export interface FindBlobsOptions {
  readonly dxNm: number
  readonly dyNm: number
  readonly polarity?: 'bright' | 'dark'
  readonly backgroundNm?: number
  /** SI, like the residual. */
  readonly minHeight?: number | null
  readonly minSepNm?: number | null
  readonly maxN?: number
  /** `[i0, j0, i1, j1]` native, half-open: where candidates may lie. */
  readonly box?: readonly [number, number, number, number] | null
  readonly thresholdSigma?: number
}

// ── array pieces ────────────────────────────────────────────────────────────

/** `_mad_sigma`: 1.4826 x the median absolute deviation of the finite values; 0 for none. */
export function madSigma(v: ArrayLike<number>): number {
  const fin: number[] = []
  for (let i = 0; i < v.length; i += 1) if (Number.isFinite(v[i] as number)) fin.push(v[i] as number)
  if (fin.length === 0) return 0.0
  const med = nanMedian(fin)
  return 1.4826 * nanMedian(fin.map((x) => Math.abs(x - med)))
}

/** SciPy's `_gaussian_kernel1d(sigma, 0, radius)`: `exp(-0.5 / sigma^2 * x^2)` over its pairwise sum. */
export function scipyGaussianKernel(sigma: number, truncate = 4.0): Float64Array {
  const lw = Math.trunc(truncate * sigma + 0.5)
  const sigma2 = sigma * sigma
  const phi = new Float64Array(2 * lw + 1)
  for (let i = -lw; i <= lw; i += 1) phi[i + lw] = Math.exp((-0.5 / sigma2) * (i * i))
  const sum = npSum(phi)
  for (let i = 0; i < phi.length; i += 1) phi[i] = (phi[i] as number) / sum
  return phi
}

function reflectIndex(i: number, n: number): number {
  // scipy 'reflect' (d c b a | a b c d | d c b a)
  const p = 2 * n
  const m = ((i % p) + p) % p
  return m >= n ? p - 1 - m : m
}

/**
 * SciPy's `gaussian_filter(a, sigma)` (mode 'reflect', truncate 4): axis 0 then
 * axis 1; each output is `x[i] w0 + sum_{k = lw..1} (x[i-k] + x[i+k]) w_k`, the
 * order `NI_Correlate1D` uses for a symmetric kernel.
 */
export function gaussianFilterScipy(a: Float64Array, rows: number, cols: number, sigma: number): Float64Array {
  const w = scipyGaussianKernel(sigma)
  const lw = (w.length - 1) / 2
  const pass = (src: Float64Array, n: number, count: number, at: (line: number, i: number) => number): Float64Array => {
    const out = new Float64Array(src.length)
    const line = new Float64Array(n + 2 * lw)
    for (let l = 0; l < count; l += 1) {
      for (let i = -lw; i < n + lw; i += 1) line[i + lw] = src[at(l, reflectIndex(i, n))] as number
      for (let i = 0; i < n; i += 1) {
        let acc = (line[i + lw] as number) * (w[lw] as number)
        for (let k = lw; k >= 1; k -= 1) acc += ((line[i + lw - k] as number) + (line[i + lw + k] as number)) * (w[lw - k] as number)
        out[at(l, i)] = acc
      }
    }
    return out
  }
  const axis0 = pass(a, rows, cols, (c, r) => r * cols + c)
  return pass(axis0, cols, rows, (r, c) => r * cols + c)
}

/** `numpy.linspace(0, 1, m)`. */
function unitLinspace(m: number): Float64Array {
  const out = new Float64Array(m)
  const step = 1 / (m - 1)
  for (let i = 0; i < m; i += 1) out[i] = i * step
  if (m > 1) out[m - 1] = 1
  return out
}

// ── the elliptical Gaussian ─────────────────────────────────────────────────

/** `_gauss_model(p, xx, yy)`: `A exp(-((u/sa)^2 + (v/sb)^2) / 2) + c`, (u, v) rotated by theta. */
export function gaussModel(p: ArrayLike<number>, xs: ArrayLike<number>, ys: ArrayLike<number>): Float64Array {
  const A = p[0] as number
  const x0 = p[1] as number
  const y0 = p[2] as number
  const sa = p[3] as number
  const sb = p[4] as number
  const th = p[5] as number
  const c = p[6] as number
  const ct = Math.cos(th)
  const st = Math.sin(th)
  const out = new Float64Array(xs.length)
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] as number) - x0
    const dy = (ys[i] as number) - y0
    const u = dx * ct + dy * st
    const v = -dx * st + dy * ct
    const a = u / sa
    const b = v / sb
    out[i] = A * Math.exp(-0.5 * (a * a + b * b)) + c
  }
  return out
}

interface FitInput {
  /** The residual, NaN where nothing was acquired. */
  readonly r: Float64Array
  /** Index of the nearest kept candidate per pixel. */
  readonly owner: Int32Array
  readonly nx: number
  readonly ny: number
}

/**
 * `_fit_blob`: elliptical Gaussian + constant on the owned, finite pixels within `R`
 * of `(row, col)`, in units of the peak above the window's border median; null
 * when there are fewer than 9 pixels, the fit fails, wanders off by more than
 * `max(2, 1.5 sigma0 + 1)` px or grows to the window.
 */
export function fitBlob(inp: FitInput, k: number, row: number, col: number, sigma0: number, R: number): Omit<Blob, 'col' | 'row' | 'height' | 'peak_sigma'> | null {
  const { r, owner, nx, ny } = inp
  const ya = Math.max(0, row - R)
  const yb = Math.min(ny, row + R + 1)
  const xa = Math.max(0, col - R)
  const xb = Math.min(nx, col + R + 1)
  const border: number[] = []
  for (let x = xa; x < xb; x += 1) border.push(r[ya * nx + x] as number)
  for (let x = xa; x < xb; x += 1) border.push(r[(yb - 1) * nx + x] as number)
  for (let y = ya; y < yb; y += 1) border.push(r[y * nx + xa] as number)
  for (let y = ya; y < yb; y += 1) border.push(r[y * nx + xb - 1] as number)
  const xs: number[] = []
  const ys: number[] = []
  const vals: number[] = []
  for (let y = ya; y < yb; y += 1) {
    for (let x = xa; x < xb; x += 1) {
      const v = r[y * nx + x] as number
      if (owner[y * nx + x] === k && Number.isFinite(v)) {
        xs.push(x)
        ys.push(y)
        vals.push(v)
      }
    }
  }
  if (xs.length < 9) return null
  const c0 = border.some((v) => Number.isFinite(v)) ? nanMedian(border) : 0.0
  const A0 = (r[row * nx + col] as number) - c0
  if (!(A0 > 0)) return null
  const vs = Float64Array.from(vals, (v) => (v - c0) / A0)
  const p0 = [1.0, col, row, sigma0, sigma0, 0.0, 0.0]
  const lo = [0.0, col - R, row - R, 0.3, 0.3, -Math.PI, -2.0]
  const hi = [4.0, col + R, row + R, 2.0 * R, 2.0 * R, Math.PI, 2.0]
  let sol
  try {
    sol = leastSquares(
      (p) => {
        const m = gaussModel(p, xs, ys)
        for (let i = 0; i < m.length; i += 1) m[i] = (m[i] as number) - (vs[i] as number)
        return m
      },
      p0, lo, hi, { maxNfev: 400 },
    )
  } catch (err) {
    if (err instanceof LeastSquaresError) return null // a failed fit falls back to moments (reported)
    throw err
  }
  if (!sol.success) return null
  const [A, x0, y0, sa, sb, th, c] = Array.from(sol.x) as [number, number, number, number, number, number, number]
  if (pyHypot(x0 - col, y0 - row) > Math.max(2.0, 1.5 * sigma0 + 1.0)) return null
  if (sa >= 1.95 * R || sb >= 1.95 * R || A <= 0) return null
  return { A: A * A0, x0, y0, sa, sb, theta: th, c: c * A0 + c0, fit: 'gaussian' }
}

/**
 * `_moments_blob`: centroid and second moments of `comp` (pixel indices, row-major
 * like `np.nonzero`), weighted by the residual
 * above half the peak pixel (all equal when none is), with 1/12 per axis for the
 * pixel's own extent.
 */
export function momentsBlob(r: Float64Array, nx: number, comp: readonly number[], row: number, col: number): Omit<Blob, 'col' | 'row' | 'height' | 'peak_sigma'> {
  const xsA: number[] = []
  const ysA: number[] = []
  for (const i of comp) {
    const y = Math.floor(i / nx)
    ysA.push(y)
    xsA.push(i - y * nx)
  }
  const peak = r[row * nx + col] as number
  let w = Float64Array.from(xsA, (x, k) => {
    const v = (r[(ysA[k] as number) * nx + x] as number) - 0.5 * peak
    return Number.isFinite(v) ? Math.max(v, 0.0) : 0.0
  })
  if (!(npSum(w) > 0)) w = new Float64Array(w.length).fill(1)
  const xs = Float64Array.from(xsA)
  const ys = Float64Array.from(ysA)
  const W = npSum(w)
  const x0 = npSum(w.map((wi, k) => wi * (xs[k] as number))) / W
  const y0 = npSum(w.map((wi, k) => wi * (ys[k] as number))) / W
  const cxx = npSum(w.map((wi, k) => wi * (((xs[k] as number) - x0) * ((xs[k] as number) - x0)))) / W + 1.0 / 12
  const cyy = npSum(w.map((wi, k) => wi * (((ys[k] as number) - y0) * ((ys[k] as number) - y0)))) / W + 1.0 / 12
  const cxy = npSum(w.map((wi, k) => wi * ((xs[k] as number) - x0) * ((ys[k] as number) - y0))) / W
  const tr = cxx + cyy
  const det = cxx * cyy - cxy * cxy
  const disc = Math.sqrt(Math.max(0.0, (tr * tr) / 4 - det))
  const l1 = tr / 2 + disc
  const l2 = Math.max(1e-6, tr / 2 - disc)
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
  return { A: peak, x0, y0, sa: Math.sqrt(l1), sb: Math.sqrt(l2), theta: th, c: 0.0, fit: 'moments' }
}

/** Python's `sorted(key=...)` on numbers: stable, and NaN compares equal to everything. */
function byKey<T>(items: T[], key: (t: T) => number): T[] {
  return items.sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    return ka < kb ? -1 : kb < ka ? 1 : 0
  })
}

/**
 * `find_blobs(z, dx_nm, dy_nm, polarity, background_nm, min_height, min_sep_nm, max_n,
 * box)` on a flattened row-major `ny x nx` array in SI units. Throws {@link BlobError}
 * when fewer than 64 pixels were acquired.
 */
export function findBlobs(z: ArrayLike<number>, nx: number, ny: number, options: FindBlobsOptions): BlobResult {
  const { dxNm, dyNm } = options
  const sign = options.polarity === 'dark' ? -1.0 : 1.0
  const backgroundNm = options.backgroundNm ?? BACKGROUND_NM_DEFAULT
  const maxN = options.maxN ?? BLOBS_DEFAULT
  const thresholdSigma = options.thresholdSigma ?? THRESHOLD_SIGMA
  const n = nx * ny
  const zz = new Float64Array(n)
  const finite = new Uint8Array(n)
  let nFinite = 0
  for (let i = 0; i < n; i += 1) {
    zz[i] = sign * (z[i] as number)
    if (Number.isFinite(zz[i] as number)) {
      finite[i] = 1
      nFinite += 1
    }
  }
  if (nFinite < 64) throw new BlobError('fewer than 64 acquired pixels')
  const px = Math.sqrt(dxNm * dyNm)
  const fill = nanMedian(zz)
  const zf = Float64Array.from(zz, (v, i) => (finite[i] === 1 ? v : fill))
  const bg = medianBackground(zf, nx, ny, backgroundNm / px)
  const r = new Float64Array(n)
  const rNan = new Float64Array(n)
  const rZero = new Float64Array(n)
  const fin = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    r[i] = (zf[i] as number) - (bg[i] as number)
    rNan[i] = finite[i] === 1 ? (r[i] as number) : NaN
    rZero[i] = finite[i] === 1 ? (r[i] as number) : 0.0
    fin[i] = finite[i] as number
  }
  const noise = madSigma(rNan)
  const sm = Math.min(Math.max(0.15 / px, 0.7), 2.0)
  const smoothed = gaussianFilterScipy(rZero, ny, nx, sm)
  const weight = gaussianFilterScipy(fin, ny, nx, sm)
  const rs = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    rs[i] = (weight[i] as number) > 0.5 ? (smoothed[i] as number) / Math.max(weight[i] as number, 1e-9) : NaN
  }
  let noiseS = madSigma(rs)
  if (noiseS <= 0) noiseS = Math.max(noise, 1e-30)
  const thr = thresholdSigma * noiseS
  const sepNm = options.minSepNm === undefined || options.minSepNm === null ? MIN_SEP_NM_DEFAULT : options.minSepNm
  const rsep = Math.max(1, pyRoundInt(sepNm / px))
  const rsF = Float64Array.from(rs, (v) => (Number.isFinite(v) ? v : -Infinity))
  const maxf = maximumFilter(rsF, ny, nx, 2 * rsep + 1)
  const [i0, j0, i1, j1] = options.box ?? [0, 0, nx, ny]
  let cand: [number, number][] = []
  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const i = row * nx + col
      if (rsF[i] === maxf[i] && (rsF[i] as number) > thr && row >= j0 && row < j1 && col >= i0 && col < i1) cand.push([row, col])
    }
  }
  cand = byKey(cand, ([row, col]) => -(rsF[row * nx + col] as number))
  const kept: [number, number][] = []
  const mergeR = Math.max(3.0, 2.5 / px)
  for (const [rr, cc] of cand) {
    let merged = false
    const peak = rsF[rr * nx + cc] as number
    for (const [kr, kc] of kept) {
      const d = pyHypot(rr - kr, cc - kc)
      if (d > mergeR) continue
      const m = Math.ceil(d) + 1
      const ts = unitLinspace(m)
      let lineMin = Infinity
      for (let t = 0; t < m; t += 1) {
        const y = rint(rr + (ts[t] as number) * (kr - rr))
        const x = rint(cc + (ts[t] as number) * (kc - cc))
        lineMin = Math.min(lineMin, rsF[y * nx + x] as number)
      }
      if (lineMin >= 0.8 * peak) {
        merged = true
        break
      }
    }
    if (!merged) kept.push([rr, cc])
  }
  // Voronoi ownership: the nearest kept candidate, the earlier one on ties (D-VMEM-10)
  const owner = new Int32Array(n).fill(-1)
  const keptRow = Int32Array.from(kept, ([kr]) => kr)
  const keptCol = Int32Array.from(kept, ([, kc]) => kc)
  if (kept.length > 0) {
    for (let row = 0; row < ny; row += 1) {
      for (let col = 0; col < nx; col += 1) {
        let best = Infinity
        let at = -1
        for (let k = 0; k < keptRow.length; k += 1) {
          const dr = row - (keptRow[k] as number)
          const dc = col - (keptCol[k] as number)
          const d2 = dr * dr + dc * dc
          if (d2 < best) {
            best = d2
            at = k
          }
        }
        owner[row * nx + col] = at
      }
    }
  }
  const blobs: Blob[] = []
  const W = 45
  const fitInput = { r: rNan, owner, nx, ny }
  const nFit = Math.min(kept.length, maxN * 4)
  for (let k = 0; k < nFit; k += 1) {
    const [rr, cc] = kept[k] as [number, number]
    const ya = Math.max(0, rr - W)
    const yb = Math.min(ny, rr + W + 1)
    const xa = Math.max(0, cc - W)
    const xb = Math.min(nx, cc + W + 1)
    const half = 0.5 * (rsF[rr * nx + cc] as number)
    const comp = floodFill(rsF, nx, ya, yb, xa, xb, rr, cc, half)
    const area = comp.length
    const sigma0 = Math.min(Math.max(Math.sqrt(area / (2.0 * Math.PI * Math.log(2.0))), 0.7), 20.0)
    const R = Math.trunc(Math.min(Math.max(Math.ceil(3.0 * sigma0) + 2, 4), 40))
    let fit = fitBlob(fitInput, k, rr, cc, sigma0, R)
    if (fit === null) {
      const owned = comp.filter((i) => owner[i] === k)
      fit = momentsBlob(rNan, nx, owned.length > 0 ? owned : comp, rr, cc)
    }
    const fwhmMinor = FWHM_PER_SIGMA * Math.min(fit.sa, fit.sb)
    if (fwhmMinor < 1.0) continue // a single-pixel spike, not a feature
    if (fit.A < 3.0 * noise) continue
    if (options.minHeight !== undefined && options.minHeight !== null && fit.A < options.minHeight) continue
    blobs.push({
      ...fit,
      col: fit.x0 + 0.5,
      row: fit.y0 + 0.5,
      height: fit.A * 1.0,
      peak_sigma: (rsF[rr * nx + cc] as number) / noiseS,
    })
  }
  byKey(blobs, (b) => -b.height)
  const truncated = blobs.length > maxN || kept.length > maxN * 4
  const top = blobs.slice(0, maxN)
  const lineH = Math.max(1.0, 2.0 * sm)
  top.sort((a, b) => {
    const ra = pyRoundInt(a.row / lineH)
    const rb = pyRoundInt(b.row / lineH)
    if (ra !== rb) return ra < rb ? -1 : 1
    return a.col < b.col ? -1 : b.col < a.col ? 1 : 0
  })
  return { blobs: top, noise, noise_smoothed: noiseS, threshold: thr, smoothing_px: sm, n_candidates: kept.length, truncated, sign }
}

/**
 * The 4-connected region of `v > level` containing `(row, col)` within the window
 * (scipy `label`'s component), as pixel indices in row-major order.
 */
function floodFill(v: Float64Array, nx: number, ya: number, yb: number, xa: number, xb: number, row: number, col: number, level: number): number[] {
  const start = row * nx + col
  if (!((v[start] as number) > level)) return []
  const seen = new Set<number>([start])
  const stack: number[] = [start]
  while (stack.length > 0) {
    const i = stack.pop() as number
    const y = Math.floor(i / nx)
    const x = i - y * nx
    const next: [number, number][] = [[y - 1, x], [y + 1, x], [y, x - 1], [y, x + 1]]
    for (const [y2, x2] of next) {
      if (y2 < ya || y2 >= yb || x2 < xa || x2 >= xb) continue
      const j = y2 * nx + x2
      if (!seen.has(j) && (v[j] as number) > level) {
        seen.add(j)
        stack.push(j)
      }
    }
  }
  return [...seen].sort((a, b) => a - b)
}

// ── geometry and the tool ───────────────────────────────────────────────────

export interface BlobGeometry {
  readonly fwhm_x_nm: number
  readonly fwhm_y_nm: number
  readonly fwhm_major_nm: number
  readonly fwhm_minor_nm: number
  readonly elongation: number
  /** Major axis, scan frame, 0..180 deg from +x toward +y. */
  readonly axis_angle_deg: number
}

/** `_blob_geometry`: FWHM along the frame's x and y (nm), along the major and minor axes, elongation, major-axis angle. */
export function blobGeometry(e: FrameEntry, b: Blob): BlobGeometry {
  const [dx, dy] = pixelNm(e)
  const { sa, sb, theta: th } = b
  const c = Math.cos(th)
  const s = Math.sin(th)
  const sxx = sa * sa * (c * c) + sb * sb * (s * s)
  const syy = sa * sa * (s * s) + sb * sb * (c * c)
  const majorTh = sa >= sb ? th : th + Math.PI / 2
  const ang = pyMod(-degrees(majorTh) + (e.geometry?.angle_deg || 0.0), 180.0)
  return {
    fwhm_x_nm: FWHM_PER_SIGMA * Math.sqrt(sxx) * dx,
    fwhm_y_nm: FWHM_PER_SIGMA * Math.sqrt(syy) * dy,
    fwhm_major_nm: FWHM_PER_SIGMA * Math.max(sa, sb) * Math.sqrt(dx * dy),
    fwhm_minor_nm: FWHM_PER_SIGMA * Math.min(sa, sb) * Math.sqrt(dx * dy),
    elongation: Math.max(sa, sb) / Math.max(Math.min(sa, sb), 1e-9),
    axis_angle_deg: ang,
  }
}

/** `_render_rgb`: the plane-flattened frame (or the region around `box`) as an RGB image at the inspect magnification. */
export function renderBox(z: Float64Array, e: FrameEntry, box: readonly [number, number, number, number], displayMax: number): { rgb: Uint8Array; view: View } {
  const s = entryScale(e)
  const [i0, j0, i1, j1] = box
  let region: Region | null = null
  if (!(i0 === 0 && j0 === 0 && i1 === e.nx && j1 === e.ny)) {
    const x = Math.floor((i0 * s.num) / s.den)
    const y = Math.floor((j0 * s.num) / s.den)
    const w = Math.max(1, Math.ceil(((i1 - i0) * s.num) / s.den))
    const h = Math.max(1, Math.ceil(((j1 - j0) * s.num) / s.den))
    const [W, H] = e.display_size
    region = { x, y, width: Math.min(w, W - x), height: Math.min(h, H - y) }
  }
  const view = planView(e.nx, e.ny, s, region, displayMax)
  const { png } = renderValues(z, e.nx, view, CLIP_PCT_DEFAULT)
  return { rgb: toRgb(decodePng(png)), view }
}

/** `_image_xy`: native continuous coordinates to pixels of a rendered view. */
function imageXy(view: View, col: number, row: number): [number, number] {
  const [i0, j0] = view.native
  return [((col - i0) * view.up) / view.down, ((row - j0) * view.up) / view.down]
}

/** The reference's ring per blob: at its centroid, radius `max(9, 0.65 FWHM_major + 6)` image px. */
export function blobMarks(blobs: readonly Blob[], view: View): Mark[] {
  return blobs.map((b, k) => {
    const [x, y] = imageXy(view, b.col, b.row)
    const r = Math.max(9.0, ((0.65 * FWHM_PER_SIGMA * Math.max(b.sa, b.sb) * view.up) / view.down) + 6.0)
    return { x, y, r, text: String(k + 1) }
  })
}

const BLOB_KEYS: ReadonlySet<string> = new Set([
  'frame', 'region', 'channel', 'direction', 'polarity', 'min_height', 'min_sep_nm', 'background_nm', 'max_n',
])

/**
 * `detect_blobs(archive, args)`: see the module comment. Never throws; invalid
 * arguments come back as `{ ok: false, error }` with the reference's message.
 */
export function detectBlobs(archive: FrameArchive, args: unknown, paint: MarkPainter = paintMarks): ViewToolResult {
  try {
    const a = argsObject(args)
    checkKeys(a, BLOB_KEYS, ['frame'], 'arguments')
    const e = imageEntry(archive, a)
    const [ch, direction] = channelDirectionArgs(archive, e, a, 'arguments')
    const polarity = strArg(a, 'polarity', 'arguments', { def: 'bright', choices: ['bright', 'dark'] }) as 'bright' | 'dark'
    const fmt = archive.fmt(e, ch)
    const mh = numArg(a, 'min_height', 'arguments', { lo: 0 })
    const sep = numArg(a, 'min_sep_nm', 'arguments', { lo: 0, hi: 100, loExclusive: true })
    const bgnm = numArg(a, 'background_nm', 'arguments', { def: BACKGROUND_NM_DEFAULT, lo: 0, hi: 1000, loExclusive: true }) as number
    const maxN = numArg(a, 'max_n', 'arguments', { def: BLOBS_DEFAULT, lo: 1, hi: MAX_BLOBS, integer: true }) as number
    const region = regionArg(e, a, 'arguments')
    const box = regionToNative(region, e.nx, e.ny, entryScale(e))
    const [dx, dy] = pixelNm(e)
    if (bgnm < 3.0 * Math.sqrt(dx * dy)) {
      throw new ArgError(`background_nm must be at least 3 scan pixels (${pyG(3 * Math.sqrt(dx * dy), 3)} nm here)`)
    }
    const z = flatten(archive.values(e, ch, direction), e.nx, e.ny, 'plane', { nmPerPx: Math.sqrt(dx * dy), highpassNm: HIGHPASS_NM_DEFAULT })
    let res: BlobResult
    try {
      res = findBlobs(z, e.nx, e.ny, {
        dxNm: dx,
        dyNm: dy,
        polarity,
        backgroundNm: bgnm,
        minHeight: mh === undefined ? null : mh / fmt.factor,
        minSepNm: sep ?? null,
        maxN,
        box,
      })
    } catch (err) {
      if (err instanceof BlobError) throw new ArgError(err.message)
      throw err
    }
    const { rgb, view } = renderBox(z, e, box, archive.displayMax)
    const g = e.geometry as ScanGeometry
    const s = entryScale(e)
    const blobsOut = res.blobs.map((b, k) => {
      const geo = blobGeometry(e, b)
      const [X, Y] = nativeToScanNm(g, b.col, b.row)
      return {
        id: k + 1,
        x_px: pyRound((b.col * s.num) / s.den, 2),
        y_px: pyRound((b.row * s.num) / s.den, 2),
        x_nm: pyRound(X, 4),
        y_nm: pyRound(Y, 4),
        [formatKey(fmt, 'height')]: formatValue(fmt, res.sign * b.height),
        fwhm_x_nm: pyRound(geo.fwhm_x_nm, 3),
        fwhm_y_nm: pyRound(geo.fwhm_y_nm, 3),
        fwhm_major_nm: pyRound(geo.fwhm_major_nm, 3),
        fwhm_minor_nm: pyRound(geo.fwhm_minor_nm, 3),
        elongation: pyRound(geo.elongation, 2),
        axis_angle_deg: pyRound(geo.axis_angle_deg, 1),
        fit: b.fit,
      }
    })
    const marks = blobMarks(res.blobs, view)
    const [W, H] = view.image_size
    const png = paint(rgb, W, H, marks)
    const [x, y, w, h] = view.region_px
    const attrs: LabelAttr[] = [
      ['channel', ch],
      ['direction', direction],
      ['flatten', 'plane'],
      ['region', `${x},${y},${w},${h}`],
      ['magnification', pyG(view.magnification, 4)],
      ['marks', `${marks.length} numbered rings`],
    ]
    const de = archive.addDerived(archive.currentTurn, png, {
      tool: 'detect_blobs',
      sources: [e.fid],
      description: `${polarity} blobs in ${ch} ${direction}`,
      labelAttrs: attrs,
    })
    const obs = archive.observation(de.fid)
    const body = {
      instrument_unchanged: true,
      frame: e.fid,
      channel: ch,
      direction,
      polarity,
      region_px: [x, y, w, h],
      n_blobs: blobsOut.length,
      truncated_to_max_n: res.truncated,
      detection: {
        background_nm: bgnm,
        smoothing_px: pyRound(res.smoothing_px, 2),
        [formatKey(fmt, 'noise')]: formatValue(fmt, res.noise),
        [formatKey(fmt, 'threshold_smoothed')]: formatValue(fmt, res.threshold),
        [formatKey(fmt, 'min_height')]: mh ?? null,
        min_sep_nm: sep ?? MIN_SEP_NM_DEFAULT,
      },
      blobs: blobsOut,
      image: { frame: de.fid, size_px: [W, H], image_px_per_display_px: pyRound(view.magnification, 4) },
    }
    return { ok: true, reply: body, images: [{ png: obs.png, label: obs.label, name: `${de.fid}.png` }] }
  } catch (err) {
    return failure('detect_blobs', err)
  }
}
