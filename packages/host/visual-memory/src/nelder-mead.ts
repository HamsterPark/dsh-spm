/**
 * scipy's Nelder–Mead (`scipy.optimize.minimize(method='Nelder-Mead')`,
 * `_minimize_neldermead`), the optimizer the reference's sub-pixel
 * registration uses (`measure.register`: `xatol=2e-3`, `fatol=1e-9`,
 * `maxiter=120`, an explicit initial simplex).
 *
 * ## Tolerance: none — the same evaluations in the same order
 *
 * Nelder–Mead is a sequence of affine combinations of simplex vertices and
 * comparisons of function values. Written with scipy's coefficients and
 * operation order (`xbar = (sim[0] + … + sim[N−1]) / N`,
 * `xr = 2·xbar − sim[N]`, `xe = 3·xbar − 2·sim[N]`, `xc = 1.5·xbar − 0.5·sim[N]`,
 * `xcc = 0.5·xbar + 0.5·sim[N]`, shrink `sim[0] + 0.5·(sim[j] − sim[0])`) and
 * the same branch conditions, a function that is itself bit-identical yields
 * the same evaluated points, values, `nit` and `nfev`; the golden
 * `measure_diff.json` (`kernels.nelder_mead`) pins every evaluation.
 *
 * The vertices are reordered by numpy's `argsort`, which for three values
 * keeps ties in their original order (pinned by the golden's `argsort` probe);
 * the sort here is stable. Not ported: `bounds`, `adaptive`, callbacks,
 * `return_all` and the default simplex — the reference passes none of them.
 */

export interface NelderMeadOptions {
  /** Absolute spread of the simplex vertices at convergence. */
  readonly xatol: number
  /** Absolute spread of the function values at convergence. */
  readonly fatol: number
  /** Iteration limit; scipy counts the initial simplex as iteration 1. */
  readonly maxiter: number
}

export interface NelderMeadResult {
  /** The best vertex. */
  readonly x: number[]
  /** `min(fsim)` (NaN if any vertex value is NaN, as numpy's `min`). */
  readonly fun: number
  readonly nit: number
  readonly nfev: number
}

/** numpy `min` of a 1-D float array: NaN propagates. */
function npMin(xs: readonly number[]): number {
  let m = xs[0] as number
  for (const v of xs) {
    if (Number.isNaN(v)) return NaN
    if (v < m) m = v
  }
  return m
}

/** numpy `max` of a 1-D float array: NaN propagates. */
function npMax(xs: readonly number[]): number {
  let m = xs[0] as number
  for (const v of xs) {
    if (Number.isNaN(v)) return NaN
    if (v > m) m = v
  }
  return m
}

/**
 * Minimise `f` from `initialSimplex` (`N + 1` vertices of dimension `N`).
 * `f` receives a copy of the vertex.
 */
export function nelderMead(f: (x: readonly number[]) => number, initialSimplex: readonly (readonly number[])[], opts: NelderMeadOptions): NelderMeadResult {
  const n = initialSimplex.length - 1
  if (n < 1 || initialSimplex.some((v) => v.length !== n)) throw new RangeError('the initial simplex needs N + 1 vertices of dimension N')
  const rho = 1
  const chi = 2
  const psi = 0.5
  const sigma = 0.5
  let nfev = 0
  const call = (x: readonly number[]): number => {
    nfev += 1
    return f([...x])
  }
  let sim = initialSimplex.map((v) => [...v])
  let fsim = sim.map((v) => call(v))
  const sort = (): void => {
    // numpy argsort on N + 1 values: insertion order kept on ties; NaN last.
    const ind = fsim.map((_, i) => i).sort((i, j) => {
      const a = fsim[i] as number
      const b = fsim[j] as number
      if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1
      return a < b ? -1 : a > b ? 1 : 0
    })
    sim = ind.map((i) => sim[i] as number[])
    fsim = ind.map((i) => fsim[i] as number)
  }
  sort()
  let iterations = 1
  while (iterations < opts.maxiter) {
    const s0 = sim[0] as number[]
    const spread = npMax(sim.slice(1).flatMap((v) => v.map((x, k) => Math.abs(x - (s0[k] as number)))))
    const fspread = npMax(fsim.slice(1).map((v) => Math.abs((fsim[0] as number) - v)))
    if (spread <= opts.xatol && fspread <= opts.fatol) break
    const worst = sim[n] as number[]
    const xbar = new Array<number>(n).fill(0)
    for (let k = 0; k < n; k += 1) {
      let acc = (sim[0] as number[])[k] as number
      for (let j = 1; j < n; j += 1) acc += (sim[j] as number[])[k] as number
      xbar[k] = acc / n
    }
    const combo = (a: number, b: number): number[] => xbar.map((x, k) => a * x - b * (worst[k] as number))
    const xr = combo(1 + rho, rho)
    const fxr = call(xr)
    let doshrink = false
    if (fxr < (fsim[0] as number)) {
      const xe = combo(1 + rho * chi, rho * chi)
      const fxe = call(xe)
      if (fxe < fxr) {
        sim[n] = xe
        fsim[n] = fxe
      } else {
        sim[n] = xr
        fsim[n] = fxr
      }
    } else if (fxr < (fsim[n - 1] as number)) {
      sim[n] = xr
      fsim[n] = fxr
    } else if (fxr < (fsim[n] as number)) {
      const xc = combo(1 + psi * rho, psi * rho)
      const fxc = call(xc)
      if (fxc <= fxr) {
        sim[n] = xc
        fsim[n] = fxc
      } else doshrink = true
    } else {
      const xcc = xbar.map((x, k) => (1 - psi) * x + psi * (worst[k] as number))
      const fxcc = call(xcc)
      if (fxcc < (fsim[n] as number)) {
        sim[n] = xcc
        fsim[n] = fxcc
      } else doshrink = true
    }
    if (doshrink) {
      for (let j = 1; j <= n; j += 1) {
        sim[j] = (sim[j] as number[]).map((x, k) => (s0[k] as number) + sigma * (x - (s0[k] as number)))
        fsim[j] = call(sim[j] as number[])
      }
    }
    iterations += 1
    sort()
  }
  return { x: [...(sim[0] as number[])], fun: npMin(fsim), nit: iterations, nfev }
}
