/**
 * SciPy's `least_squares` (bounded TRF, `least-squares.ts`): the refusals SciPy makes
 * and the branches its golden rarely takes. Moved here with the code from
 * visual-memory; parity with SciPy itself, on the blob model that `stm_detect_blobs`
 * fits, stays in visual-memory's `measure-fft-blobs.parity.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { leastSquares, LeastSquaresError, nextAfter } from './least-squares.js'

describe('nextafter', () => {
  it('steps one ulp toward the target, across zero, and keeps NaN', () => {
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
    // an exponential decay fitted from far away: two evaluations are not enough
    const xs = [0, 1, 2, 3]
    const ys = [2, 1.2, 0.7, 0.4]
    const decay = (p: Float64Array) => Float64Array.from(xs, (x, i) => (p[0] as number) * Math.exp(-(p[1] as number) * x) - (ys[i] as number))
    const r = leastSquares(decay, [0.5, 0.1], [0, 0], [10, 5], { maxNfev: 2 })
    expect([r.status, r.success, r.nfev]).toEqual([0, false, 2])
  })
})
