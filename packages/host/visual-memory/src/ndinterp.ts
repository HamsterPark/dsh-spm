/**
 * The three `scipy.ndimage` interpolation calls the frame difference makes,
 * with scipy's own arithmetic (VISTA-SPM `measure.diff`, `register`,
 * `_common_grid`, `_shift_image`):
 *
 * | here | scipy |
 * |---|---|
 * | {@link splineFilter3} | `spline_filter(a, order=3)` (mode `mirror`) |
 * | {@link shiftConstant} | `shift(a, d, order=1, mode='constant')` and `shift(c, d, order=3, mode='constant', prefilter=False)` |
 * | {@link mapCoordinates1} | `map_coordinates(a, [rows, cols], order=1, mode='constant')` |
 *
 * ## Tolerance: none — bit-identical
 *
 * Every output is the same sequence of IEEE operations as scipy's C code
 * (`ni_splines.c`, `ni_interpolation.c`), so the results are the same doubles;
 * the golden `measure_diff.json` (`kernels`) pins them with `Object.is`. The one
 * transcendental call is `pow(z, n - 1)` in the mirror initialisation of the
 * spline filter; V8 and the C library may differ there in the last bit, which
 * moves a coefficient only when `|z|^(n-1)` times the last sample is within an
 * ulp of a rounding boundary of the first one — never seen in the goldens.
 *
 * Why not `dsh-spm-numerics`' `mapCoordinates` / `shiftImage`: they compute the
 * second weight as `x - floor(x)` and multiply `(wr·wc)·v`, scipy as
 * `1 - (1 - x)` and `(v·wr)·wc`, so about a third of the outputs differ in the
 * last bit (within their stated `8·eps`); and order 3 is not there at all
 * (it needs the global spline prefilter).
 *
 * ## The rules, as scipy implements them
 *
 * - **Constant mode:** a sample whose coordinate along either axis lies outside
 *   `[0, n − 1]` is `cval` (0); no interpolation reaches beyond the edge.
 * - **Inside, near an edge:** the stencil's out-of-range indices are folded
 *   with the `mirror` rule (`−1 → 1`, `n → n − 2`): the spline coefficients
 *   are those of the mirror-extended signal, which is what `spline_filter`
 *   computes by default.
 * - **Weights** (`get_spline_interpolation_weights`): order 1 `[1 − x, 1 − (1 − x)]`;
 *   order 3 the cubic B-spline, the last weight being `1 −` the others.
 * - **Sum:** `t = 0; t += (c·w_row)·w_col` over the stencil, column fastest.
 */

const POLE_ORDER_3 = -0.267949192431122706472553658494127633 // sqrt(3) - 2, as scipy writes it

/** scipy's `map_coordinate(i, n, NI_EXTEND_MIRROR)` for an integer index. */
export function mirrorIndex(i: number, n: number): number {
  if (i >= 0 && i <= n - 1) return i
  if (n <= 1) return 0
  const sz2 = 2 * n - 2
  if (i < 0) {
    const v = sz2 * Math.trunc(-i / sz2) + i
    return v <= 1 - n ? v + sz2 : -v
  }
  const v = i - sz2 * Math.trunc(i / sz2)
  return v >= n ? sz2 - v : v
}

/** scipy's `get_spline_interpolation_weights` for orders 1 and 3. */
function splineWeights(x: number, order: 1 | 3, out: Float64Array): void {
  const t = x - Math.floor(x)
  if (order === 1) {
    out[0] = 1.0 - t
  } else {
    const y = t
    const z = 1.0 - t
    out[1] = (y * y * (y - 2.0) * 3.0 + 4.0) / 6.0
    out[2] = (z * z * (z - 2.0) * 3.0 + 4.0) / 6.0
    out[0] = (z * z * z) / 6.0
  }
  let last = 1.0
  for (let i = 0; i < order; i += 1) last -= out[i] as number
  out[order] = last
}

/** One axis of one sample: the stencil's (mirror-folded) indices and weights; null outside `[0, n − 1]`. */
interface Stencil {
  readonly idx: Int32Array
  readonly w: Float64Array
}

function stencil(cc: number, n: number, order: 1 | 3): Stencil | null {
  if (!(cc >= 0 && cc <= n - 1)) return null
  const start = Math.floor(cc) - (order >> 1)
  const idx = new Int32Array(order + 1)
  for (let h = 0; h <= order; h += 1) idx[h] = mirrorIndex(start + h, n)
  const w = new Float64Array(order + 1)
  splineWeights(cc, order, w)
  return { idx, w }
}

function interpolate(a: Float64Array, cols: number, r: Stencil, c: Stencil): number {
  let t = 0.0
  for (let i = 0; i < r.idx.length; i += 1) {
    const base = (r.idx[i] as number) * cols
    const wr = r.w[i] as number
    for (let j = 0; j < c.idx.length; j += 1) t += ((a[base + (c.idx[j] as number)] as number) * wr) * (c.w[j] as number)
  }
  return t
}

function checkShape(a: ArrayLike<number>, rows: number, cols: number): void {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || a.length !== rows * cols) {
    throw new RangeError(`array of ${a.length} values is not ${rows} rows x ${cols} columns`)
  }
}

/**
 * `scipy.ndimage.shift(a, (dy, dx), order, mode='constant', cval=0)`:
 * `out[p] = a(p − d)`, content moved by `+d`. For order 3, `a` must already be
 * spline coefficients ({@link splineFilter3}; scipy's `prefilter=False`).
 */
export function shiftConstant(a: Float64Array, rows: number, cols: number, dy: number, dx: number, order: 1 | 3): Float64Array {
  checkShape(a, rows, cols)
  // scipy adds the negated shift to the output index: k + (−d).
  const rs = Array.from({ length: rows }, (_, k) => stencil(k + -dy, rows, order))
  const cs = Array.from({ length: cols }, (_, k) => stencil(k + -dx, cols, order))
  const out = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    const R = rs[r] as Stencil | null
    if (R === null) continue
    for (let c = 0; c < cols; c += 1) {
      const C = cs[c] as Stencil | null
      if (C !== null) out[r * cols + c] = interpolate(a, cols, R, C)
    }
  }
  return out
}

/** `scipy.ndimage.map_coordinates(a, [rows, cols], order=1, mode='constant', cval=0)`. */
export function mapCoordinates1(
  a: Float64Array,
  rows: number,
  cols: number,
  rowCoords: ArrayLike<number>,
  colCoords: ArrayLike<number>,
): Float64Array {
  checkShape(a, rows, cols)
  if (rowCoords.length !== colCoords.length) throw new RangeError(`${rowCoords.length} row and ${colCoords.length} column coordinates`)
  const out = new Float64Array(rowCoords.length)
  for (let k = 0; k < out.length; k += 1) {
    const R = stencil(rowCoords[k] as number, rows, 1)
    const C = R === null ? null : stencil(colCoords[k] as number, cols, 1)
    if (R !== null && C !== null) out[k] = interpolate(a, cols, R, C)
  }
  return out
}

/** One line of `spline_filter1d(order=3, mode='mirror')`, in place (`ni_splines.c`). */
function filterLine(c: Float64Array, n: number): void {
  const z = POLE_ORDER_3
  const gain = (1.0 - z) * (1.0 - 1.0 / z)
  for (let i = 0; i < n; i += 1) c[i] = (c[i] as number) * gain
  // causal initialisation, mirror boundary
  const zn1 = Math.pow(z, n - 1)
  let zi = z
  c[0] = (c[0] as number) + zn1 * (c[n - 1] as number)
  for (let i = 1; i < n - 1; i += 1) {
    c[0] = (c[0] as number) + zi * ((c[i] as number) + zn1 * (c[n - 1 - i] as number))
    zi *= z
  }
  c[0] = (c[0] as number) / (1 - zn1 * zn1)
  for (let i = 1; i < n; i += 1) c[i] = (c[i] as number) + z * (c[i - 1] as number)
  // anticausal initialisation, mirror boundary
  c[n - 1] = ((z * (c[n - 2] as number) + (c[n - 1] as number)) * z) / (z * z - 1)
  for (let i = n - 2; i >= 0; i -= 1) c[i] = z * ((c[i + 1] as number) - (c[i] as number))
}

/**
 * `scipy.ndimage.spline_filter(a, order=3)`: cubic B-spline coefficients with
 * the mirror boundary, along axis 0 then axis 1 (an axis of length 1 is left as is).
 */
export function splineFilter3(a: Float64Array, rows: number, cols: number): Float64Array {
  checkShape(a, rows, cols)
  const out = Float64Array.from(a)
  if (rows > 1) {
    const line = new Float64Array(rows)
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) line[r] = out[r * cols + c] as number
      filterLine(line, rows)
      for (let r = 0; r < rows; r += 1) out[r * cols + c] = line[r] as number
    }
  }
  if (cols > 1) {
    const line = new Float64Array(cols)
    for (let r = 0; r < rows; r += 1) {
      line.set(out.subarray(r * cols, (r + 1) * cols))
      filterLine(line, cols)
      out.set(line, r * cols)
    }
  }
  return out
}
