/**
 * SciPy's `least_squares` the way `_fit_blob` calls it: the Trust Region Reflective
 * method (`method='trf'`) with bounds, linear loss, `x_scale` 1, a '2-point'
 * finite-difference Jacobian and the exact trust-region solver (one SVD per
 * iteration). Ported step by step, in SciPy's order, from SciPy 1.17
 * (`optimize/_lsq/least_squares.py`, `trf.py` `trf_bounds` / `select_step`,
 * `common.py`, `optimize/_numdiff.py` `approx_derivative`): the same tests,
 * the same step selection, the same trust-radius updates, the same termination
 * statuses and the same `nfev` / `njev` counts.
 *
 * ## Tolerance against SciPy
 *
 * Not bit-exact, and it cannot be: the residuals call `exp`, `cos` and `sin`,
 * and V8's `Math.exp` differs from the C runtime NumPy uses in the last bit for
 * about one input in eleven (measured on the exporter's machine). SciPy also
 * sums through BLAS (blocked) and takes its SVD from LAPACK `gesdd`; here sums
 * are sequential and the SVD is a Householder QR followed by one-sided Jacobi
 * on the 7 x 7 triangle. Each iteration therefore agrees to rounding, and the
 * iterates agree to about 1e-12 relative on a well-conditioned fit (pinned by
 * `measure-fft-blobs.parity.test.ts` against `least_squares` itself). A
 * decision that sits on a rounding boundary (a step accepted with
 * `actual_reduction` of order 1e-17, `ftol` met by a hair) can take one more or
 * one fewer iteration; the result then differs by that last step, which is
 * below the fit's own `ftol` / `xtol` resolution.
 *
 * ## Next to `curveFit` and `lstsqQr`
 *
 * Moved here from visual-memory (2026-10-13); its caller is `stm_detect_blobs`
 * (`detect-blobs.ts`, the reference's `_fit_blob`). This package has two other
 * least-squares solvers, for other callers, and none replaces another:
 * - `curveFit` (`curve-fit.ts`): Levenberg–Marquardt without bounds, `curve_fit`'s
 *   `lmdif` side, judged by the parameter uncertainty rather than SciPy's path;
 * - `lstsqQr` (`lsq.ts`): linear least squares by Householder QR.
 * This one is the bounded Trust Region Reflective method, followed step by step
 * because where it stops decides what the blob tool reports: `success` and the
 * final `x` choose between a Gaussian fit and the moments fallback.
 */

const EPS = Number.EPSILON

export interface TrfOptions {
  /** Default `100 * n`, like SciPy. */
  readonly maxNfev?: number
  readonly ftol?: number
  readonly xtol?: number
  readonly gtol?: number
}

export interface TrfResult {
  readonly x: Float64Array
  /** `0.5 * sum(f**2)` at `x`. */
  readonly cost: number
  readonly fun: Float64Array<ArrayBufferLike>
  readonly nfev: number
  readonly njev: number
  /** 0: `maxNfev` reached; 1: `gtol`; 2: `ftol`; 3: `xtol`; 4: `ftol` and `xtol`. */
  readonly status: number
  readonly success: boolean
  readonly optimality: number
  /** -1 at a lower bound, 1 at an upper bound, else 0 (within `xtol`). */
  readonly activeMask: Int8Array
}

/** SciPy's `ValueError`s: infeasible start, non-finite residuals, a degenerate step. */
export class LeastSquaresError extends Error {
  override readonly name = 'LeastSquaresError'
}

type Fun = (x: Float64Array) => Float64Array<ArrayBufferLike>

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += (a[i] as number) * (b[i] as number)
  return s
}

function norm(a: ArrayLike<number>): number {
  return Math.sqrt(dot(a, a))
}

function normInf(a: ArrayLike<number>): number {
  let m = 0
  for (let i = 0; i < a.length; i += 1) {
    const v = Math.abs(a[i] as number)
    if (v > m || Number.isNaN(v)) m = v
  }
  return m
}

const VIEW = new DataView(new ArrayBuffer(8))

/** C `nextafter(x, toward)` for finite `x`. */
export function nextAfter(x: number, toward: number): number {
  if (Number.isNaN(x) || Number.isNaN(toward)) return NaN
  if (x === toward) return toward
  if (x === 0) return toward > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE
  VIEW.setFloat64(0, x)
  let bits = VIEW.getBigUint64(0)
  bits += (toward > x) === (x > 0) ? 1n : -1n
  VIEW.setBigUint64(0, bits)
  return VIEW.getFloat64(0)
}

function inBounds(x: ArrayLike<number>, lb: ArrayLike<number>, ub: ArrayLike<number>): boolean {
  for (let i = 0; i < x.length; i += 1) {
    if (!((x[i] as number) >= (lb[i] as number) && (x[i] as number) <= (ub[i] as number))) return false
  }
  return true
}

/** `find_active_constraints(x, lb, ub, rtol)`. */
function activeConstraints(x: Float64Array, lb: Float64Array, ub: Float64Array, rtol: number): Int8Array {
  const n = x.length
  const active = new Int8Array(n)
  for (let i = 0; i < n; i += 1) {
    const xi = x[i] as number
    const l = lb[i] as number
    const u = ub[i] as number
    if (rtol === 0) {
      if (xi <= l) active[i] = -1
      if (xi >= u) active[i] = 1
      continue
    }
    const lowerDist = xi - l
    const upperDist = u - xi
    const lowerThreshold = rtol * Math.max(1, Math.abs(l))
    const upperThreshold = rtol * Math.max(1, Math.abs(u))
    if (Number.isFinite(l) && lowerDist <= Math.min(upperDist, lowerThreshold)) active[i] = -1
    if (Number.isFinite(u) && upperDist <= Math.min(lowerDist, upperThreshold)) active[i] = 1
  }
  return active
}

/** `make_strictly_feasible(x, lb, ub, rstep)`. */
function makeStrictlyFeasible(x: Float64Array, lb: Float64Array, ub: Float64Array, rstep: number): Float64Array {
  const out = Float64Array.from(x)
  const active = activeConstraints(x, lb, ub, rstep)
  for (let i = 0; i < x.length; i += 1) {
    const l = lb[i] as number
    const u = ub[i] as number
    if (active[i] === -1) out[i] = rstep === 0 ? nextAfter(l, u) : l + rstep * Math.max(1, Math.abs(l))
    else if (active[i] === 1) out[i] = rstep === 0 ? nextAfter(u, l) : u - rstep * Math.max(1, Math.abs(u))
    if ((out[i] as number) < l || (out[i] as number) > u) out[i] = 0.5 * (l + u)
  }
  return out
}

/** `CL_scaling_vector(x, g, lb, ub)`: Coleman–Li scaling `v` and its derivative sign `dv`. */
function clScaling(x: Float64Array, g: Float64Array, lb: Float64Array, ub: Float64Array): { v: Float64Array; dv: Float64Array } {
  const n = x.length
  const v = new Float64Array(n).fill(1)
  const dv = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    if ((g[i] as number) < 0 && Number.isFinite(ub[i] as number)) {
      v[i] = (ub[i] as number) - (x[i] as number)
      dv[i] = -1
    }
    if ((g[i] as number) > 0 && Number.isFinite(lb[i] as number)) {
      v[i] = (x[i] as number) - (lb[i] as number)
      dv[i] = 1
    }
  }
  return { v, dv }
}

/** `step_size_to_bound(x, s, lb, ub)`: the step along `s` to the first bound, and which bounds it hits. */
function stepSizeToBound(x: Float64Array, s: Float64Array, lb: Float64Array, ub: Float64Array): { step: number; hits: Int8Array } {
  const n = x.length
  const steps = new Float64Array(n).fill(Infinity)
  for (let i = 0; i < n; i += 1) {
    const si = s[i] as number
    if (si !== 0) steps[i] = Math.max(((lb[i] as number) - (x[i] as number)) / si, ((ub[i] as number) - (x[i] as number)) / si)
  }
  let min = Infinity
  for (const v of steps) if (v < min || Number.isNaN(v)) min = v
  const hits = new Int8Array(n)
  for (let i = 0; i < n; i += 1) if (steps[i] === min) hits[i] = Math.sign(s[i] as number)
  return { step: min, hits }
}

/** `intersect_trust_region(x, s, Delta)`: the two `t` with `||x + t s|| = Delta`, ascending. */
function intersectTrustRegion(x: Float64Array, s: Float64Array, delta: number): [number, number] {
  const a = dot(s, s)
  if (a === 0) throw new LeastSquaresError('`s` is zero.')
  const b = dot(x, s)
  const c = dot(x, x) - delta * delta
  if (c > 0) throw new LeastSquaresError('`x` is not within the trust region.')
  const d = Math.sqrt(b * b - a * c)
  const q = -(b + (b < 0 || Object.is(b, -0) ? -d : d)) // copysign(d, b)
  const t1 = q / a
  const t2 = c / q
  return t1 < t2 ? [t1, t2] : [t2, t1]
}

/** `J.dot(s)` for an `m x n` row-major `J`. */
function matVec(J: Float64Array, m: number, n: number, s: ArrayLike<number>): Float64Array {
  const out = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    let acc = 0
    for (let j = 0; j < n; j += 1) acc += (J[i * n + j] as number) * (s[j] as number)
    out[i] = acc
  }
  return out
}

/** `J.T.dot(f)`. */
function matTVec(J: Float64Array, m: number, n: number, f: ArrayLike<number>): Float64Array {
  const out = new Float64Array(n)
  for (let j = 0; j < n; j += 1) {
    let acc = 0
    for (let i = 0; i < m; i += 1) acc += (J[i * n + j] as number) * (f[i] as number)
    out[j] = acc
  }
  return out
}

/** `evaluate_quadratic(J, g, s, diag)`: `0.5 s'(J'J + diag)s + g's`. */
function evaluateQuadratic(J: Float64Array, m: number, n: number, g: Float64Array, s: Float64Array, diag: Float64Array): number {
  const Js = matVec(J, m, n, s)
  let q = dot(Js, Js)
  let sd = 0
  for (let i = 0; i < n; i += 1) sd += (s[i] as number) * (diag[i] as number) * (s[i] as number)
  q += sd
  return 0.5 * q + dot(s, g)
}

/** `build_quadratic_1d(J, g, s, diag, s0)`: coefficients of the quadratic along `s` (from `s0`). */
function buildQuadratic1d(
  J: Float64Array, m: number, n: number, g: Float64Array, s: Float64Array, diag: Float64Array, s0?: Float64Array,
): [number, number, number] {
  const v = matVec(J, m, n, s)
  let a = dot(v, v)
  let sds = 0
  for (let i = 0; i < n; i += 1) sds += (s[i] as number) * (diag[i] as number) * (s[i] as number)
  a += sds
  a *= 0.5
  let b = dot(g, s)
  let c = 0
  if (s0 !== undefined) {
    const u = matVec(J, m, n, s0)
    b += dot(u, v)
    c = 0.5 * dot(u, u) + dot(g, s0)
    let s0ds = 0
    let s0ds0 = 0
    for (let i = 0; i < n; i += 1) {
      s0ds += (s0[i] as number) * (diag[i] as number) * (s[i] as number)
      s0ds0 += (s0[i] as number) * (diag[i] as number) * (s0[i] as number)
    }
    b += s0ds
    c += 0.5 * s0ds0
  }
  return [a, b, c]
}

/** `minimize_quadratic_1d(a, b, lb, ub, c)`: the minimum of `a t^2 + b t + c` on `[lb, ub]` (first on ties). */
function minimizeQuadratic1d(a: number, b: number, lb: number, ub: number, c = 0): [number, number] {
  const t = [lb, ub]
  if (a !== 0) {
    const extremum = (-0.5 * b) / a
    if (lb < extremum && extremum < ub) t.push(extremum)
  }
  let best = 0
  let bestY = NaN
  t.forEach((ti, k) => {
    const y = ti * (a * ti + b) + c
    if (k === 0 || y < bestY || (Number.isNaN(y) && !Number.isNaN(bestY))) {
      best = k
      bestY = y
    }
  })
  return [t[best] as number, bestY]
}

/**
 * Thin SVD of an `rows x n` row-major matrix (`rows >= n`) and `U' f`: Householder
 * QR, then one-sided Jacobi on the `n x n` triangle. Singular values descending.
 */
function svdApply(A: Float64Array, rows: number, n: number, f: Float64Array): { s: Float64Array; V: Float64Array; uf: Float64Array } {
  const R = Float64Array.from(A)
  const qf = Float64Array.from(f)
  const v = new Float64Array(rows)
  for (let k = 0; k < n; k += 1) {
    let alpha = 0
    for (let i = k; i < rows; i += 1) alpha += (R[i * n + k] as number) ** 2
    alpha = Math.sqrt(alpha)
    if (alpha === 0) continue
    const x0 = R[k * n + k] as number
    if (x0 > 0) alpha = -alpha
    // v = x - alpha e_k, normalized so that H = I - 2 v v' / (v' v)
    for (let i = k; i < rows; i += 1) v[i] = R[i * n + k] as number
    v[k] = x0 - alpha
    let vv = 0
    for (let i = k; i < rows; i += 1) vv += (v[i] as number) ** 2
    if (vv === 0) continue
    for (let j = k; j < n; j += 1) {
      let t = 0
      for (let i = k; i < rows; i += 1) t += (v[i] as number) * (R[i * n + j] as number)
      t = (2 * t) / vv
      for (let i = k; i < rows; i += 1) R[i * n + j] = (R[i * n + j] as number) - t * (v[i] as number)
    }
    let t = 0
    for (let i = k; i < rows; i += 1) t += (v[i] as number) * (qf[i] as number)
    t = (2 * t) / vv
    for (let i = k; i < rows; i += 1) qf[i] = (qf[i] as number) - t * (v[i] as number)
  }
  // one-sided Jacobi on the upper triangle W (n x n), columns made orthogonal: W V = U S
  const W = new Float64Array(n * n)
  for (let i = 0; i < n; i += 1) for (let j = i; j < n; j += 1) W[i * n + j] = R[i * n + j] as number
  const V = new Float64Array(n * n)
  for (let i = 0; i < n; i += 1) V[i * n + i] = 1
  for (let sweep = 0; sweep < 60; sweep += 1) {
    let rotated = false
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        let a = 0
        let b = 0
        let c = 0
        for (let i = 0; i < n; i += 1) {
          const wp = W[i * n + p] as number
          const wq = W[i * n + q] as number
          a += wp * wp
          b += wq * wq
          c += wp * wq
        }
        if (c === 0 || Math.abs(c) <= EPS * Math.sqrt(a * b)) continue
        rotated = true
        const zeta = (b - a) / (2 * c)
        const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta))
        const cs = 1 / Math.sqrt(1 + t * t)
        const sn = cs * t
        for (let i = 0; i < n; i += 1) {
          const wp = W[i * n + p] as number
          const wq = W[i * n + q] as number
          W[i * n + p] = cs * wp - sn * wq
          W[i * n + q] = sn * wp + cs * wq
          const vp = V[i * n + p] as number
          const vq = V[i * n + q] as number
          V[i * n + p] = cs * vp - sn * vq
          V[i * n + q] = sn * vp + cs * vq
        }
      }
    }
    if (!rotated) break
  }
  const sv = new Float64Array(n)
  for (let j = 0; j < n; j += 1) {
    let acc = 0
    for (let i = 0; i < n; i += 1) acc += (W[i * n + j] as number) ** 2
    sv[j] = Math.sqrt(acc)
  }
  const order = Array.from({ length: n }, (_, j) => j).sort((x, y) => (sv[y] as number) - (sv[x] as number) || x - y)
  const s = new Float64Array(n)
  const Vs = new Float64Array(n * n)
  const uf = new Float64Array(n)
  order.forEach((j, k) => {
    const sj = sv[j] as number
    s[k] = sj
    for (let i = 0; i < n; i += 1) Vs[i * n + k] = V[i * n + j] as number
    if (sj > 0) {
      let acc = 0
      for (let i = 0; i < n; i += 1) acc += ((W[i * n + j] as number) / sj) * (qf[i] as number)
      uf[k] = acc
    }
  })
  return { s, V: Vs, uf }
}

/** `solve_lsq_trust_region(n, m, uf, s, V, Delta, initial_alpha)` (Moré's algorithm on the SVD). */
function solveLsqTrustRegion(
  n: number, m: number, uf: Float64Array, s: Float64Array, V: Float64Array, delta: number, initialAlpha: number,
): { p: Float64Array; alpha: number } {
  const suf = new Float64Array(n)
  for (let i = 0; i < n; i += 1) suf[i] = (s[i] as number) * (uf[i] as number)
  const phiAndDerivative = (alpha: number): [number, number] => {
    const q = new Float64Array(n)
    let num = 0
    for (let i = 0; i < n; i += 1) {
      const si = s[i] as number
      const sui = suf[i] as number
      const denom = si * si + alpha
      q[i] = sui / denom
      num += (sui * sui) / (denom * denom * denom)
    }
    const pNorm = norm(q)
    return [pNorm - delta, -num / pNorm]
  }
  const fullRank = m >= n ? (s[n - 1] as number) > EPS * m * (s[0] as number) : false
  const vDot = (w: Float64Array): Float64Array => {
    const out = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      let acc = 0
      for (let j = 0; j < n; j += 1) acc += (V[i * n + j] as number) * (w[j] as number)
      out[i] = acc
    }
    return out
  }
  if (fullRank) {
    const w = new Float64Array(n)
    for (let i = 0; i < n; i += 1) w[i] = (uf[i] as number) / (s[i] as number)
    const p = vDot(w).map((v) => -v)
    if (norm(p) <= delta) return { p, alpha: 0 }
  }
  let alphaUpper = norm(suf) / delta
  let alphaLower = 0
  if (fullRank) {
    const [phi, phiPrime] = phiAndDerivative(0)
    alphaLower = -phi / phiPrime
  }
  let alpha = !fullRank && initialAlpha === 0 ? Math.max(0.001 * alphaUpper, (alphaLower * alphaUpper) ** 0.5) : initialAlpha
  for (let it = 0; it < 10; it += 1) {
    if (alpha < alphaLower || alpha > alphaUpper) alpha = Math.max(0.001 * alphaUpper, (alphaLower * alphaUpper) ** 0.5)
    const [phi, phiPrime] = phiAndDerivative(alpha)
    if (phi < 0) alphaUpper = alpha
    const ratio = phi / phiPrime
    alphaLower = Math.max(alphaLower, alpha - ratio)
    alpha -= ((phi + delta) * ratio) / delta
    if (Math.abs(phi) < 0.01 * delta) break
  }
  const w = new Float64Array(n)
  for (let i = 0; i < n; i += 1) w[i] = (suf[i] as number) / ((s[i] as number) * (s[i] as number) + alpha)
  const p = vDot(w).map((v) => -v)
  const scale = delta / norm(p)
  for (let i = 0; i < n; i += 1) p[i] = (p[i] as number) * scale
  return { p, alpha }
}

/** `update_tr_radius(Delta, actual, predicted, step_norm, bound_hit)`. */
function updateTrRadius(delta: number, actual: number, predicted: number, stepNorm: number, boundHit: boolean): [number, number] {
  let ratio: number
  if (predicted > 0) ratio = actual / predicted
  else if (predicted === actual && actual === 0) ratio = 1
  else ratio = 0
  if (ratio < 0.25) delta = 0.25 * stepNorm
  else if (ratio > 0.75 && boundHit) delta *= 2.0
  return [delta, ratio]
}

/** `check_termination(dF, F, dx_norm, x_norm, ratio, ftol, xtol)`. */
function checkTermination(dF: number, F: number, dxNorm: number, xNorm: number, ratio: number, ftol: number, xtol: number): number | null {
  const ftolOk = dF < ftol * F && ratio > 0.25
  const xtolOk = dxNorm < xtol * (xtol + xNorm)
  if (ftolOk && xtolOk) return 4
  if (ftolOk) return 2
  if (xtolOk) return 3
  return null
}

/**
 * `approx_derivative(fun, x0, method='2-point', f0, bounds)`: forward differences with
 * steps `sqrt(eps) * sign(x0) * max(1, |x0|)`, turned around (or shortened) where a step
 * would leave the bounds. Row-major `m x n`.
 */
function jacobian2Point(fun: Fun, x0: Float64Array, f0: Float64Array, lb: Float64Array, ub: Float64Array): Float64Array {
  const n = x0.length
  const m = f0.length
  const rstep = EPS ** 0.5
  const h = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const xi = x0[i] as number
    h[i] = rstep * (xi >= 0 ? 1 : -1) * Math.max(1.0, Math.abs(xi))
    // _adjust_scheme_to_bounds(x0, h, 1, '1-sided', lb, ub)
    const lowerDist = xi - (lb[i] as number)
    const upperDist = (ub[i] as number) - xi
    const xs = xi + (h[i] as number)
    const violated = xs < (lb[i] as number) || xs > (ub[i] as number)
    const fitting = Math.abs(h[i] as number) <= Math.max(lowerDist, upperDist)
    if (violated && fitting) h[i] = -(h[i] as number)
    if (!fitting) h[i] = upperDist >= lowerDist ? upperDist : -lowerDist
  }
  const J = new Float64Array(m * n)
  for (let i = 0; i < n; i += 1) {
    const x1 = Float64Array.from(x0)
    x1[i] = (x0[i] as number) + (h[i] as number)
    const dx = (x0[i] as number) + (h[i] as number) - (x0[i] as number)
    const f1 = fun(x1)
    for (let k = 0; k < m; k += 1) J[k * n + i] = ((f1[k] as number) - (f0[k] as number)) / dx
  }
  return J
}

function allFinite(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i += 1) if (!Number.isFinite(a[i] as number)) return false
  return true
}

/**
 * `scipy.optimize.least_squares(fun, x0, bounds=(lb, ub), max_nfev=...)` with the defaults
 * above. Throws {@link LeastSquaresError} where SciPy raises `ValueError`.
 */
export function leastSquares(fun: Fun, x0In: ArrayLike<number>, lbIn: ArrayLike<number>, ubIn: ArrayLike<number>, options: TrfOptions = {}): TrfResult {
  const n = x0In.length
  const lb = Float64Array.from({ length: lbIn.length }, (_, i) => lbIn[i] as number)
  const ub = Float64Array.from({ length: ubIn.length }, (_, i) => ubIn[i] as number)
  if (lb.length !== n || ub.length !== n) throw new LeastSquaresError('Inconsistent shapes between bounds and `x0`.')
  for (let i = 0; i < n; i += 1) {
    if (!((lb[i] as number) < (ub[i] as number))) throw new LeastSquaresError('Each lower bound must be strictly less than each upper bound.')
  }
  if (!inBounds(x0In, lb, ub)) throw new LeastSquaresError('Initial guess is outside of provided bounds')
  const ftol = options.ftol ?? 1e-8
  const xtol = options.xtol ?? 1e-8
  const gtol = options.gtol ?? 1e-8
  const maxNfev = options.maxNfev ?? 100 * n
  const x0 = makeStrictlyFeasible(Float64Array.from({ length: n }, (_, i) => x0In[i] as number), lb, ub, 1e-10)
  const f0 = fun(x0)
  if (!allFinite(f0)) throw new LeastSquaresError('Residuals are not finite in the initial point.')
  const m = f0.length
  let J = jacobian2Point(fun, x0, f0, lb, ub)

  // trf_bounds
  let x: Float64Array = Float64Array.from(x0)
  let f: Float64Array<ArrayBufferLike> = f0
  let nfev = 1
  let njev = 1
  let cost = 0.5 * dot(f, f)
  let g = matTVec(J, m, n, f)
  let { v } = clScaling(x, g, lb, ub)
  const scaledX0 = new Float64Array(n)
  for (let i = 0; i < n; i += 1) scaledX0[i] = (x0[i] as number) / Math.sqrt(v[i] as number)
  let delta = norm(scaledX0)
  if (delta === 0) delta = 1.0
  let gNorm = 0
  let alpha = 0
  let status: number | null = null
  let actualReduction = -1
  const rowsAug = m + n
  const fAug = new Float64Array(rowsAug)
  const JAug = new Float64Array(rowsAug * n)
  for (;;) {
    const sc = clScaling(x, g, lb, ub)
    v = sc.v
    const dv = sc.dv
    const gv = new Float64Array(n)
    for (let i = 0; i < n; i += 1) gv[i] = (g[i] as number) * (v[i] as number)
    gNorm = normInf(gv)
    if (gNorm < gtol) status = 1
    if (status !== null || nfev === maxNfev) break

    const d = new Float64Array(n)
    const diagH = new Float64Array(n)
    const gH = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      d[i] = Math.sqrt(v[i] as number)
      diagH[i] = (g[i] as number) * (dv[i] as number)
      gH[i] = (d[i] as number) * (g[i] as number)
    }
    fAug.fill(0)
    fAug.set(f)
    JAug.fill(0)
    for (let k = 0; k < m; k += 1) {
      for (let i = 0; i < n; i += 1) JAug[k * n + i] = (J[k * n + i] as number) * (d[i] as number)
    }
    const JH = JAug.subarray(0, m * n)
    for (let i = 0; i < n; i += 1) JAug[(m + i) * n + i] = Math.sqrt(diagH[i] as number)
    const { s, V, uf } = svdApply(JAug, rowsAug, n, fAug)
    const theta = Math.max(0.995, 1 - gNorm)

    actualReduction = -1
    let xNew: Float64Array = x
    let fNew: Float64Array<ArrayBufferLike> = f
    let costNew = cost
    while (actualReduction <= 0 && nfev < maxNfev) {
      const tr = solveLsqTrustRegion(n, m, uf, s, V, delta, alpha)
      alpha = tr.alpha
      const pH = tr.p
      const p = new Float64Array(n)
      for (let i = 0; i < n; i += 1) p[i] = (d[i] as number) * (pH[i] as number)
      const sel = selectStep(x, JH, m, n, diagH, gH, p, pH, d, delta, lb, ub, theta)
      const trial = new Float64Array(n)
      for (let i = 0; i < n; i += 1) trial[i] = (x[i] as number) + (sel.step[i] as number)
      xNew = makeStrictlyFeasible(trial, lb, ub, 0)
      fNew = fun(xNew)
      nfev += 1
      const stepHNorm = norm(sel.stepH)
      if (!allFinite(fNew)) {
        delta = 0.25 * stepHNorm
        continue
      }
      costNew = 0.5 * dot(fNew, fNew)
      actualReduction = cost - costNew
      const [deltaNew, ratio] = updateTrRadius(delta, actualReduction, sel.predicted, stepHNorm, stepHNorm > 0.95 * delta)
      const stepNorm = norm(sel.step)
      status = checkTermination(actualReduction, cost, stepNorm, norm(x), ratio, ftol, xtol)
      if (status !== null) break
      alpha *= delta / deltaNew
      delta = deltaNew
    }
    if (actualReduction > 0) {
      x = xNew
      f = fNew
      cost = costNew
      J = jacobian2Point(fun, x, f, lb, ub)
      njev += 1
      g = matTVec(J, m, n, f)
    } else {
      actualReduction = 0
    }
  }
  const st = status ?? 0
  return {
    x,
    cost,
    fun: f,
    nfev,
    njev,
    status: st,
    success: st > 0,
    optimality: gNorm,
    activeMask: activeConstraints(x, lb, ub, xtol),
  }
}

/** `select_step`: the best of the trust-region step (pulled back inside), its reflection and the Cauchy step. */
function selectStep(
  x: Float64Array, JH: Float64Array, m: number, n: number, diagH: Float64Array, gH: Float64Array,
  p: Float64Array, pH: Float64Array, d: Float64Array, delta: number, lb: Float64Array, ub: Float64Array, theta: number,
): { step: Float64Array; stepH: Float64Array; predicted: number } {
  const xp = new Float64Array(n)
  for (let i = 0; i < n; i += 1) xp[i] = (x[i] as number) + (p[i] as number)
  if (inBounds(xp, lb, ub)) {
    return { step: p, stepH: pH, predicted: -evaluateQuadratic(JH, m, n, gH, pH, diagH) }
  }
  const { step: pStride, hits } = stepSizeToBound(x, p, lb, ub)
  const rH = Float64Array.from(pH)
  for (let i = 0; i < n; i += 1) if (hits[i] !== 0) rH[i] = -(rH[i] as number)
  let r = new Float64Array(n)
  for (let i = 0; i < n; i += 1) r[i] = (d[i] as number) * (rH[i] as number)
  for (let i = 0; i < n; i += 1) {
    p[i] = (p[i] as number) * pStride
    pH[i] = (pH[i] as number) * pStride
  }
  const xOnBound = new Float64Array(n)
  for (let i = 0; i < n; i += 1) xOnBound[i] = (x[i] as number) + (p[i] as number)
  const [, toTr] = intersectTrustRegion(pH, rH, delta)
  const toBound = stepSizeToBound(xOnBound, r, lb, ub).step
  let rStride = Math.min(toBound, toTr)
  let rStrideL: number
  let rStrideU: number
  if (rStride > 0) {
    rStrideL = ((1 - theta) * pStride) / rStride
    rStrideU = rStride === toBound ? theta * toBound : toTr
  } else {
    rStrideL = 0
    rStrideU = -1
  }
  let rValue = Infinity
  if (rStrideL <= rStrideU) {
    const [a, b, c] = buildQuadratic1d(JH, m, n, gH, rH, diagH, pH)
    const [t, value] = minimizeQuadratic1d(a, b, rStrideL, rStrideU, c)
    rStride = t
    rValue = value
    for (let i = 0; i < n; i += 1) rH[i] = (rH[i] as number) * rStride + (pH[i] as number)
    r = new Float64Array(n)
    for (let i = 0; i < n; i += 1) r[i] = (rH[i] as number) * (d[i] as number)
  }
  for (let i = 0; i < n; i += 1) {
    p[i] = (p[i] as number) * theta
    pH[i] = (pH[i] as number) * theta
  }
  const pValue = evaluateQuadratic(JH, m, n, gH, pH, diagH)
  const agH = new Float64Array(n)
  const ag = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    agH[i] = -(gH[i] as number)
    ag[i] = (d[i] as number) * (agH[i] as number)
  }
  const toTrAg = delta / norm(agH)
  const toBoundAg = stepSizeToBound(x, ag, lb, ub).step
  let agStride = toBoundAg < toTrAg ? theta * toBoundAg : toTrAg
  const [a, b] = buildQuadratic1d(JH, m, n, gH, agH, diagH)
  const [tAg, agValue] = minimizeQuadratic1d(a, b, 0, agStride)
  agStride = tAg
  for (let i = 0; i < n; i += 1) {
    agH[i] = (agH[i] as number) * agStride
    ag[i] = (ag[i] as number) * agStride
  }
  if (pValue < rValue && pValue < agValue) return { step: p, stepH: pH, predicted: -pValue }
  if (rValue < pValue && rValue < agValue) return { step: r, stepH: rH, predicted: -rValue }
  return { step: ag, stepH: agH, predicted: -agValue }
}
