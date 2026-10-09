/**
 * Background removal before display (VISUAL-HARNESS §4.3, Python `frames.flatten`).
 *
 * | mode | what is subtracted |
 * |---|---|
 * | `none` | nothing |
 * | `plane` | least-squares plane |
 * | `line` | plane, then each row's median offset |
 * | `poly2` | least-squares second-order surface |
 * | `highpass` | plane, then a median background `highpass_nm` wide |
 *
 * Only finite pixels take part in a fit; pixels that were never acquired (NaN)
 * stay NaN. A frame with fewer finite pixels than the model has terms (3 / 6)
 * is left unflattened.
 *
 * ## Fitting
 *
 * The design uses centred, normalised coordinates
 * `xs = (col - (nx-1)/2) / nx`, `ys = (row - (ny-1)/2) / ny` like the reference,
 * and the fit is the orthogonal projection of the data onto the span of the
 * terms (two-pass modified Gram–Schmidt). A projection is what a least-squares
 * fit IS at the data points, and it stays well defined when the terms are
 * linearly dependent on the acquired pixels — a partial scan with one acquired
 * row makes `ys` constant, where a plain QR back-substitution divides by
 * rounding noise. numpy's `lstsq` (SVD, minimum norm) gives the same fitted
 * values up to rounding.
 *
 * ## Tolerance against the reference
 *
 * Fitted surfaces agree with numpy to ~1e-12 relative (different but backward
 * stable algorithms). Medians and the median filter are exact (they pick input
 * values). Block means sum in row-major order, numpy sums pairwise, so
 * downsampled values may differ in the last bits.
 */
import { mapCoordinates, matOf, medianFilter2d } from 'dsh-spm-numerics'
import { pyRoundInt } from './pyfmt.js'

export const FLATTEN_MODES = ['none', 'plane', 'line', 'poly2', 'highpass'] as const
export type FlattenMode = (typeof FLATTEN_MODES)[number]

export const HIGHPASS_NM_DEFAULT = 3

/** Invalid flattening request (unknown mode, missing pixel size). */
export class FlattenError extends RangeError {
  override readonly name = 'FlattenError'
}

export function isFlattenMode(v: unknown): v is FlattenMode {
  return typeof v === 'string' && (FLATTEN_MODES as readonly string[]).includes(v)
}

function checkShape(z: ArrayLike<number>, nx: number, ny: number): void {
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1 || z.length !== nx * ny) {
    throw new FlattenError(`array of ${z.length} values is not ${ny} rows x ${nx} columns`)
  }
}

/**
 * Least-squares fit of a plane (`order` 1) or second-order surface (`order` 2)
 * to the finite pixels. Returns the fitted value at every finite pixel and 0
 * elsewhere (and 0 everywhere when there are too few finite pixels).
 */
export function fitSurface(z: ArrayLike<number>, nx: number, ny: number, order: 1 | 2): Float64Array {
  checkShape(z, nx, ny)
  const idx: number[] = []
  for (let i = 0; i < z.length; i += 1) if (Number.isFinite(z[i] as number)) idx.push(i)
  const out = new Float64Array(z.length)
  const nTerms = order === 1 ? 3 : 6
  if (idx.length < nTerms) return out
  const m = idx.length
  const xs = new Float64Array(m)
  const ys = new Float64Array(m)
  const data = new Float64Array(m)
  for (let k = 0; k < m; k += 1) {
    const i = idx[k] as number
    const r = Math.floor(i / nx)
    const c = i - r * nx
    xs[k] = (c - (nx - 1) / 2) / Math.max(nx, 1)
    ys[k] = (r - (ny - 1) / 2) / Math.max(ny, 1)
    data[k] = z[i] as number
  }
  const terms: Float64Array[] = [new Float64Array(m).fill(1), xs, ys]
  if (order === 2) {
    terms.push(
      xs.map((x) => x * x),
      xs.map((x, k) => x * (ys[k] as number)),
      ys.map((y) => y * y),
    )
  }
  const fitted = projectOnto(terms, data)
  for (let k = 0; k < m; k += 1) out[idx[k] as number] = fitted[k] as number
  return out
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += (a[i] as number) * (b[i] as number)
  return s
}

/** Orthogonal projection of `y` onto span(columns); dependent columns are dropped. */
export function projectOnto(columns: readonly Float64Array[], y: Float64Array): Float64Array {
  const basis: Float64Array[] = []
  for (const col of columns) {
    const v = Float64Array.from(col)
    const norm0 = Math.sqrt(dot(v, v))
    if (norm0 === 0) continue
    for (let pass = 0; pass < 2; pass += 1) {
      for (const q of basis) {
        const d = dot(q, v)
        for (let i = 0; i < v.length; i += 1) v[i] = (v[i] as number) - d * (q[i] as number)
      }
    }
    const norm = Math.sqrt(dot(v, v))
    if (norm <= 1e-10 * norm0) continue
    for (let i = 0; i < v.length; i += 1) v[i] = (v[i] as number) / norm
    basis.push(v)
  }
  const out = new Float64Array(y.length)
  for (const q of basis) {
    const d = dot(q, y)
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) + d * (q[i] as number)
  }
  return out
}

/** numpy `median` of the finite values (mean of the two middle values when even); NaN if none. */
export function nanMedian(values: ArrayLike<number>): number {
  const fin: number[] = []
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] as number
    if (Number.isFinite(v)) fin.push(v)
  }
  if (fin.length === 0) return NaN
  fin.sort((a, b) => a - b)
  const h = fin.length >> 1
  return fin.length % 2 === 1 ? (fin[h] as number) : ((fin[h - 1] as number) + (fin[h] as number)) / 2
}

/** Each row's median of finite values; 0 for a row with none. */
export function rowOffsets(z: ArrayLike<number>, nx: number, ny: number): Float64Array {
  checkShape(z, nx, ny)
  const out = new Float64Array(ny)
  const row = new Float64Array(nx)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) row[c] = z[r * nx + c] as number
    const m = nanMedian(row)
    out[r] = Number.isFinite(m) ? m : 0
  }
  return out
}

export interface Grid {
  readonly nx: number
  readonly ny: number
  readonly data: Float64Array
}

/** NaN-aware mean over `f × f` blocks; edge blocks may be partial; an all-NaN block is NaN. */
export function blockMean(z: ArrayLike<number>, nx: number, ny: number, f: number): Grid {
  checkShape(z, nx, ny)
  const step = Math.trunc(f)
  if (step <= 1) return { nx, ny, data: Float64Array.from(z) }
  const ox = Math.ceil(nx / step)
  const oy = Math.ceil(ny / step)
  const out = new Float64Array(ox * oy)
  for (let by = 0; by < oy; by += 1) {
    for (let bx = 0; bx < ox; bx += 1) {
      let sum = 0
      let n = 0
      for (let r = by * step; r < Math.min(ny, (by + 1) * step); r += 1) {
        for (let c = bx * step; c < Math.min(nx, (bx + 1) * step); c += 1) {
          const v = z[r * nx + c] as number
          if (Number.isFinite(v)) {
            sum += v
            n += 1
          }
        }
      }
      out[by * ox + bx] = n === 0 ? NaN : sum / n
    }
  }
  return { nx: ox, ny: oy, data: out }
}

/**
 * A median-filtered background `widthPx` pixels wide (at least 3). Wide windows
 * are computed on a block-averaged copy (blocks of `ceil(width / 15)`, so the
 * median window stays within about 15 pixels) and interpolated back bilinearly —
 * the reference's `median_background`, including its Python rounding (ties to
 * even) for the odd window size.
 */
export function medianBackground(z: ArrayLike<number>, nx: number, ny: number, widthPx: number): Float64Array {
  checkShape(z, nx, ny)
  const fill = nanMedian(z)
  const zf = new Float64Array(z.length)
  for (let i = 0; i < z.length; i += 1) {
    const v = z[i] as number
    zf[i] = Number.isFinite(v) ? v : Number.isFinite(fill) ? fill : 0
  }
  const width = Math.max(3, widthPx)
  const d = Math.max(1, Math.ceil(width / 15))
  const small = d > 1 ? blockMean(zf, nx, ny, d) : { nx, ny, data: zf }
  const size = Math.max(3, pyRoundInt(width / d) | 1)
  const bg = medianFilter2d(matOf(small.ny, small.nx, small.data), size, 'nearest')
  if (d === 1) return Float64Array.from(bg.data)
  const rows = new Float64Array(nx * ny)
  const cols = new Float64Array(nx * ny)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      rows[r * nx + c] = (r + 0.5) / d - 0.5
      cols[r * nx + c] = (c + 0.5) / d - 0.5
    }
  }
  return mapCoordinates(bg, rows, cols, 1, 'nearest')
}

export interface FlattenOptions {
  /** Pixel size in nm (geometric mean of x and y); required for `highpass`. */
  readonly nmPerPx?: number | null
  readonly highpassNm?: number
}

/** A float64 copy of `z` with the background removed; NaN pixels stay NaN. */
export function flatten(
  z: ArrayLike<number>,
  nx: number,
  ny: number,
  mode: FlattenMode,
  options: FlattenOptions = {},
): Float64Array {
  checkShape(z, nx, ny)
  if (!isFlattenMode(mode)) throw new FlattenError(`flatten must be one of ${FLATTEN_MODES.join(', ')}, not ${JSON.stringify(mode)}`)
  const zz = Float64Array.from(z)
  if (mode === 'none') return zz
  const fit = fitSurface(zz, nx, ny, mode === 'poly2' ? 2 : 1)
  const out = new Float64Array(zz.length)
  for (let i = 0; i < zz.length; i += 1) out[i] = (zz[i] as number) - (fit[i] as number)
  if (mode === 'line') {
    const off = rowOffsets(out, nx, ny)
    for (let r = 0; r < ny; r += 1) {
      const o = off[r] as number
      for (let c = 0; c < nx; c += 1) out[r * nx + c] = (out[r * nx + c] as number) - o
    }
  } else if (mode === 'highpass') {
    const px = options.nmPerPx
    if (px === undefined || px === null || !(px > 0)) throw new FlattenError('highpass flattening needs the pixel size')
    const bg = medianBackground(out, nx, ny, (options.highpassNm ?? HIGHPASS_NM_DEFAULT) / px)
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) - (bg[i] as number)
  }
  for (let i = 0; i < zz.length; i += 1) if (!Number.isFinite(zz[i] as number)) out[i] = NaN
  return out
}
