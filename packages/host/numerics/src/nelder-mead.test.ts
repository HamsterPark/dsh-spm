/**
 * scipy's Nelder–Mead (`nelder-mead.ts`), moved here with the code from visual-memory:
 * a bowl and the simplex check, and the golden `measure_diff.json` (`kernels`), exported
 * from scipy by the reference's options — every evaluation, `nit` and `nfev`, exactly
 * (`Object.is`), and numpy's `argsort` tie order that the vertex sort relies on.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nelderMead } from './nelder-mead.js'

interface NelderMeadCase {
  function: string
  options: { initial_simplex: number[][]; xatol: number; fatol: number; maxiter: number }
  evals: number[][]
  nit: number
  nfev: number
  x: number[]
  fun: number
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/measure_diff.json', import.meta.url)), 'utf8'),
) as { kernels: { nelder_mead: NelderMeadCase[]; argsort: { values: number[]; order: number[] }[] } }

/** Positions where two arrays are not the same double (`Object.is`). */
function differing(got: ArrayLike<number>, want: ArrayLike<number>): number[] {
  expect(got.length).toBe(want.length)
  const out: number[] = []
  for (let i = 0; i < want.length; i += 1) if (!Object.is(got[i], want[i])) out.push(i)
  return out
}

describe('Nelder-Mead', () => {
  it('minimises a bowl and checks its simplex', () => {
    const res = nelderMead((x) => ((x[0] as number) - 1) ** 2 + ((x[1] as number) + 2) ** 2, [[0, 0], [0.3, 0], [0, 0.3]], { xatol: 1e-8, fatol: 1e-12, maxiter: 400 })
    expect(res.x[0]).toBeCloseTo(1, 6)
    expect(res.x[1]).toBeCloseTo(-2, 6)
    expect(res.nfev).toBeGreaterThan(res.nit)
    expect(nelderMead(() => NaN, [[0, 0], [1, 0], [0, 1]], { xatol: 1e-3, fatol: 1e-3, maxiter: 5 }).fun).toBeNaN()
    expect(() => nelderMead(() => 0, [[0, 0], [1, 0]], { xatol: 1, fatol: 1, maxiter: 1 })).toThrow(/N \+ 1 vertices/)
  })
})

describe('parity with scipy (measure_diff.json kernels), bit for bit', () => {
  it("the reference's options: the same evaluations, nit and nfev", () => {
    const fns: Record<string, (x: number, y: number) => number> = {
      bowl: (x, y) => (x - 0.3) * (x - 0.3) + 2.0 * (y + 0.7) * (y + 0.7) + 0.5 * x * y,
      rosenbrock: (x, y) => (1.0 - x) * (1.0 - x) + 100.0 * (y - x * x) * (y - x * x),
      constant: () => 1.0,
      plateau: (x, y) => (x * x + y * y > 0.25 ? 1.0 : -0.5 + x * x),
    }
    expect([...new Set(golden.kernels.nelder_mead.map((c) => c.function))].sort()).toEqual(Object.keys(fns).sort())
    for (const c of golden.kernels.nelder_mead) {
      const f = fns[c.function] as (x: number, y: number) => number
      const evals: number[][] = []
      const res = nelderMead((d) => {
        const v = f(d[0] as number, d[1] as number)
        evals.push([d[0] as number, d[1] as number, v])
        return v
      }, c.options.initial_simplex, { xatol: c.options.xatol, fatol: c.options.fatol, maxiter: c.options.maxiter })
      expect(evals.length, c.function).toBe(c.evals.length)
      expect(differing(evals.flat(), c.evals.flat()), c.function).toEqual([])
      expect([res.nit, res.nfev]).toEqual([c.nit, c.nfev])
      expect(differing([...res.x, res.fun], [...c.x, c.fun])).toEqual([])
    }
  })

  it("numpy's argsort keeps ties in order, like the stable sort Nelder-Mead uses here", () => {
    for (const c of golden.kernels.argsort) {
      expect(c.values.map((_, i) => i).sort((i, j) => (c.values[i] as number) - (c.values[j] as number))).toEqual(c.order)
    }
  })
})
