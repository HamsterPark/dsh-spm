import { pyFixed as kernelPyFixed, pyRound as kernelPyRound } from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { pyFixed, pyG, pyRound, pyRoundInt, rint } from './pyfmt.js'

/**
 * Expected values were produced by CPython 3.14 / numpy 2.4 (`round`, f-strings,
 * `np.rint`) for these exact inputs. Most inputs are chosen where JavaScript's
 * own formatting disagrees: exact binary ties (dyadic values) and values just
 * below or above a tie.
 */
const CASES: readonly (readonly [number, { r1: number; r2: number; r4: number; r0: number; f0: string; f1: string; f2: string; g1: string; g4: string; g6: string }])[] = [
  [0.125, { r1: 0.1, r2: 0.12, r4: 0.125, r0: 0, f0: '0', f1: '0.1', f2: '0.12', g1: '0.1', g4: '0.125', g6: '0.125' }],
  [0.375, { r1: 0.4, r2: 0.38, r4: 0.375, r0: 0, f0: '0', f1: '0.4', f2: '0.38', g1: '0.4', g4: '0.375', g6: '0.375' }],
  [2.675, { r1: 2.7, r2: 2.67, r4: 2.675, r0: 3, f0: '3', f1: '2.7', f2: '2.67', g1: '3', g4: '2.675', g6: '2.675' }],
  [-0.125, { r1: -0.1, r2: -0.12, r4: -0.125, r0: -0, f0: '-0', f1: '-0.1', f2: '-0.12', g1: '-0.1', g4: '-0.125', g6: '-0.125' }],
  [0.03125, { r1: 0, r2: 0.03, r4: 0.0312, r0: 0, f0: '0', f1: '0.0', f2: '0.03', g1: '0.03', g4: '0.03125', g6: '0.03125' }],
  [0.09375, { r1: 0.1, r2: 0.09, r4: 0.0938, r0: 0, f0: '0', f1: '0.1', f2: '0.09', g1: '0.09', g4: '0.09375', g6: '0.09375' }],
  [-0.03125, { r1: -0, r2: -0.03, r4: -0.0312, r0: -0, f0: '-0', f1: '-0.0', f2: '-0.03', g1: '-0.03', g4: '-0.03125', g6: '-0.03125' }],
  [12.625, { r1: 12.6, r2: 12.62, r4: 12.625, r0: 13, f0: '13', f1: '12.6', f2: '12.62', g1: '1e+01', g4: '12.62', g6: '12.625' }],
  [12.635, { r1: 12.6, r2: 12.63, r4: 12.635, r0: 13, f0: '13', f1: '12.6', f2: '12.63', g1: '1e+01', g4: '12.63', g6: '12.635' }],
  [0.0001234, { r1: 0, r2: 0, r4: 0.0001, r0: 0, f0: '0', f1: '0.0', f2: '0.00', g1: '0.0001', g4: '0.0001234', g6: '0.0001234' }],
  [0.000123456, { r1: 0, r2: 0, r4: 0.0001, r0: 0, f0: '0', f1: '0.0', f2: '0.00', g1: '0.0001', g4: '0.0001235', g6: '0.000123456' }],
  [1e-5, { r1: 0, r2: 0, r4: 0, r0: 0, f0: '0', f1: '0.0', f2: '0.00', g1: '1e-05', g4: '1e-05', g6: '1e-05' }],
  [9.99995e-5, { r1: 0, r2: 0, r4: 0.0001, r0: 0, f0: '0', f1: '0.0', f2: '0.00', g1: '0.0001', g4: '0.0001', g6: '9.99995e-05' }],
  [123456, { r1: 123456, r2: 123456, r4: 123456, r0: 123456, f0: '123456', f1: '123456.0', f2: '123456.00', g1: '1e+05', g4: '1.235e+05', g6: '123456' }],
  [100, { r1: 100, r2: 100, r4: 100, r0: 100, f0: '100', f1: '100.0', f2: '100.00', g1: '1e+02', g4: '100', g6: '100' }],
  [99.995, { r1: 100, r2: 100, r4: 99.995, r0: 100, f0: '100', f1: '100.0', f2: '100.00', g1: '1e+02', g4: '100', g6: '99.995' }],
  [1234.5, { r1: 1234.5, r2: 1234.5, r4: 1234.5, r0: 1234, f0: '1234', f1: '1234.5', f2: '1234.50', g1: '1e+03', g4: '1234', g6: '1234.5' }],
  [2.5, { r1: 2.5, r2: 2.5, r4: 2.5, r0: 2, f0: '2', f1: '2.5', f2: '2.50', g1: '2', g4: '2.5', g6: '2.5' }],
  [-2.5, { r1: -2.5, r2: -2.5, r4: -2.5, r0: -2, f0: '-2', f1: '-2.5', f2: '-2.50', g1: '-2', g4: '-2.5', g6: '-2.5' }],
  [1.5, { r1: 1.5, r2: 1.5, r4: 1.5, r0: 2, f0: '2', f1: '1.5', f2: '1.50', g1: '2', g4: '1.5', g6: '1.5' }],
  [127.5, { r1: 127.5, r2: 127.5, r4: 127.5, r0: 128, f0: '128', f1: '127.5', f2: '127.50', g1: '1e+02', g4: '127.5', g6: '127.5' }],
  [6.02e23, { r1: 6.02e23, r2: 6.02e23, r4: 6.02e23, r0: 6.02e23, f0: '601999999999999995805696', f1: '601999999999999995805696.0', f2: '601999999999999995805696.00', g1: '6e+23', g4: '6.02e+23', g6: '6.02e+23' }],
  [1e-17, { r1: 0, r2: 0, r4: 0, r0: 0, f0: '0', f1: '0.0', f2: '0.00', g1: '1e-17', g4: '1e-17', g6: '1e-17' }],
  [-0.04, { r1: -0, r2: -0.04, r4: -0.04, r0: -0, f0: '-0', f1: '-0.0', f2: '-0.04', g1: '-0.04', g4: '-0.04', g6: '-0.04' }],
  [7, { r1: 7, r2: 7, r4: 7, r0: 7, f0: '7', f1: '7.0', f2: '7.00', g1: '7', g4: '7', g6: '7' }],
]

describe('Python-compatible rounding', () => {
  for (const [v, want] of CASES) {
    it(`round / f / g of ${v}`, () => {
      expect(pyRound(v, 1)).toBe(want.r1)
      expect(pyRound(v, 2)).toBe(want.r2)
      expect(pyRound(v, 4)).toBe(want.r4)
      expect(pyRoundInt(v)).toBe(want.r0)
      expect(pyFixed(v, 0)).toBe(want.f0)
      expect(pyFixed(v, 1)).toBe(want.f1)
      expect(pyFixed(v, 2)).toBe(want.f2)
      expect(pyG(v, 1)).toBe(want.g1)
      expect(pyG(v, 4)).toBe(want.g4)
      expect(pyG(v, 6)).toBe(want.g6)
    })
  }

  it('differs from JavaScript exactly on binary ties', () => {
    // The reason this module exists: JS rounds ties away from zero.
    expect((0.125).toFixed(2)).toBe('0.13')
    expect(pyFixed(0.125, 2)).toBe('0.12')
    expect((12.625).toPrecision(4)).toBe('12.63')
    expect(pyG(12.625, 4)).toBe('12.62')
  })

  it('passes zero and non-finite values through', () => {
    expect(pyRound(0, 3)).toBe(0)
    expect(pyRound(-0, 3)).toBe(-0)
    expect(pyRound(NaN, 1)).toBeNaN()
    expect(pyRound(Infinity, 1)).toBe(Infinity)
    expect(pyFixed(NaN, 1)).toBe('nan')
    expect(pyFixed(-Infinity, 1)).toBe('-inf')
    expect(pyG(Infinity, 4)).toBe('inf')
    expect(pyG(0, 4)).toBe('0')
    expect(pyG(-0, 4)).toBe('-0')
    expect(pyG(5, 0)).toBe('5') // precision 0 is treated as 1, like Python
  })

  it('handles subnormal and huge magnitudes exactly', () => {
    expect(pyG(5e-324, 4)).toBe('4.941e-324')
    expect(pyG(1.7976931348623157e308, 4)).toBe('1.798e+308')
    expect(pyG(9.9995, 4)).toBe('9.999') // 9.9995 is stored just below the tie
    expect(pyG(9.99951, 4)).toBe('10') // rounding carries into a new decade
  })
})

describe('agreement with the kernel helpers', () => {
  // dsh-spm-kernel already has CPython-validated pyRound / pyFixed (spec/deviations.md D-LANG-3,
  // limited to |v| < 1e21). This module computes exactly with BigInt and adds `%g`; on the
  // kernel's range the two must agree everywhere.
  it('matches kernel pyRound and pyFixed on dyadic ties, near-ties and random doubles', () => {
    const values: number[] = []
    for (let k = 1; k <= 12; k += 1) for (let j = -40; j <= 40; j += 1) values.push(j / 2 ** k) // exact ties
    let s = 11
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
    for (let i = 0; i < 2000; i += 1) values.push((rnd() - 0.5) * 10 ** Math.floor(rnd() * 12 - 4))
    values.push(2.675, 1.005, 248.85000000000002, -0.0004, -0, 0)
    for (const v of values) {
      for (const d of [0, 1, 2, 3, 4, 6]) {
        expect(pyFixed(v, d)).toBe(kernelPyFixed(v, d))
        expect(Object.is(pyRound(v, d), kernelPyRound(v, d)) || pyRound(v, d) === kernelPyRound(v, d)).toBe(true)
      }
    }
  })
})

describe('numpy rint', () => {
  it('rounds half to even and keeps the sign of zero', () => {
    const cases: [number, number][] = [
      [0.5, 0], [1.5, 2], [2.5, 2], [-1.5, -2], [127.5, 128], [128.5, 128], [3.49999, 3], [254.5, 254], [254.6, 255],
    ]
    for (const [v, want] of cases) expect(rint(v)).toBe(want)
    expect(Object.is(rint(-0.5), -0)).toBe(true)
  })
})
