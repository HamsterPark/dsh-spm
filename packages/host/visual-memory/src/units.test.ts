import { describe, expect, it } from 'vitest'
import { ChannelError, defaultChannel, findChannel, resolveChannel, span } from './channels.js'
import {
  channelFormat,
  columnUnit,
  decimalsFor,
  displayUnit,
  formatKey,
  formatValue,
  formatValues,
  npRound,
  rangeAttr,
  robustSpan,
  roundTo,
  stripUnit,
  unitForChannel,
  unitKey,
  unitSuffix,
} from './units.js'

/** Expected values below were produced by CPython 3.14 / numpy 2.4 for these inputs. */
describe('model units', () => {
  it('reports one unit per quantity: pm, pA, V, Hz, pN', () => {
    expect(displayUnit('m')).toEqual({ factor: 1e12, unit: 'pm' })
    expect(displayUnit('A')).toEqual({ factor: 1e12, unit: 'pA' })
    expect(displayUnit('V')).toEqual({ factor: 1, unit: 'V' })
    expect(displayUnit('Hz')).toEqual({ factor: 1, unit: 'Hz' })
    expect(displayUnit('N')).toEqual({ factor: 1e12, unit: 'pN' })
    expect(displayUnit('deg')).toEqual({ factor: 1, unit: 'deg' })
    expect(displayUnit(' s ')).toEqual({ factor: 1, unit: 's' })
    expect(displayUnit('furlong')).toEqual({ factor: 1, unit: 'furlong' })
    expect(displayUnit('')).toEqual({ factor: 1, unit: '' })
    expect(displayUnit(undefined as never)).toEqual({ factor: 1, unit: '' }) // untyped callers: index lines, JSON
  })

  it('carries the unit in the key', () => {
    expect(unitSuffix('pA')).toBe('pa')
    expect(unitSuffix('µV')).toBe('v')
    expect(unitSuffix('')).toBe('')
    expect(unitSuffix(null as never)).toBe('')
    expect(unitKey('values', 'pm')).toBe('values_pm')
    expect(unitKey('black', 'pA')).toBe('black_pa')
    expect(unitKey('values', '')).toBe('values')
    expect(rangeAttr('Z', 'pm')).toBe('z_range_pm')
    expect(rangeAttr('Current', 'pA')).toBe('range_pa')
    expect(rangeAttr('Frequency Shift', 'Hz')).toBe('range_hz')
    expect(rangeAttr('Bias', 'V')).toBe('range_v')
    expect(rangeAttr('Mystery', '')).toBe('range')
    expect(rangeAttr('Z', 'V')).toBe('range_v')
  })

  it('chooses 1..6 decimals that resolve about 1/100 of the span', () => {
    const cases: [number | null | undefined, number][] = [
      [null, 1], [undefined, 1], [0, 1], [-1, 1], [Number.NaN, 1], [Infinity, 1], [0.0004, 6], [0.004, 5], [0.04, 4],
      [0.4, 3], [4, 2], [40, 1], [400, 1], [4000, 1], [10, 1], [1, 2], [0.1, 3], [100, 1], [99.99, 1], [1e-9, 6],
    ]
    for (const [span, d] of cases) expect(decimalsFor(span)).toBe(d)
  })

  it('rounds single values like Python and arrays like numpy, never returning -0', () => {
    // Python round works on the exact binary value; np.round rounds x·10^d, which may land on a half.
    const cases: [number, number, number, number][] = [
      [248.85000000000002, 1, 248.9, 248.8],
      [2.675, 2, 2.67, 2.68],
      [12.345, 2, 12.35, 12.34],
      [0.125, 2, 0.12, 0.12],
      [1.005, 2, 1, 1],
      [0.25, 1, 0.2, 0.2],
      [2.5, 0, 2, 2],
      [1.5, 0, 2, 2],
    ]
    for (const [v, d, py, np] of cases) {
      expect(roundTo(v, d)).toBe(py)
      expect(npRound(v, d)).toBe(np)
    }
    expect(Object.is(roundTo(-0.04, 1), 0)).toBe(true)
    expect(Object.is(npRound(-0.04, 1), 0)).toBe(true)
    expect(roundTo(Number.NaN, 1)).toBeNull()
    expect(roundTo(null, 1)).toBeNull()
    expect(roundTo(undefined, 1)).toBeNull()
    expect(npRound(Infinity, 1)).toBeNull()
  })

  it('measures the robust span over every array given', () => {
    expect(robustSpan(Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, Number.NaN]))).toBeCloseTo(8.91, 12)
    expect(robustSpan([1, 2, 3, 4, 5], undefined, [6, 7, 8, 9, 10])).toBeCloseTo(8.91, 12)
    expect(robustSpan([Number.NaN])).toBeNull()
    expect(robustSpan()).toBeNull()
  })

  it('formats a channel: key, single value and arrays', () => {
    const fmt = channelFormat('m', 5e-11) // 50 pm span → 1 decimal
    expect(fmt).toEqual({ factor: 1e12, unit: 'pm', decimals: 1 })
    expect(formatKey(fmt, 'values')).toBe('values_pm')
    expect(formatValue(fmt, 1.2345e-11)).toBe(12.3)
    expect(formatValue(fmt, null)).toBeNull()
    expect(formatValues(fmt, [1.2345e-11, Number.NaN, -4e-14])).toEqual([12.3, null, 0])
    expect(channelFormat('A', 4e-12)).toEqual({ factor: 1e12, unit: 'pA', decimals: 2 })
    expect(channelFormat('V', 0.4)).toEqual({ factor: 1, unit: 'V', decimals: 3 })
    expect(channelFormat('Hz', null)).toEqual({ factor: 1, unit: 'Hz', decimals: 1 })
  })
})

describe('channel unit names', () => {
  it('takes the file unit, else guesses by name, else the trailing (unit)', () => {
    expect(unitForChannel('Z', { Z: 'm' })).toBe('m')
    expect(unitForChannel('Z')).toBe('m')
    expect(unitForChannel('Current')).toBe('A')
    expect(unitForChannel('Frequency Shift')).toBe('Hz')
    expect(unitForChannel('OC D1 Freq.')).toBe('Hz')
    expect(unitForChannel('Tip current 2')).toBe('A')
    expect(unitForChannel('Bias (V)')).toBe('V')
    expect(unitForChannel('Mystery')).toBe('')
    expect(unitForChannel('Z', { Z: '' })).toBe('m')
  })

  it('parses spectrum column names', () => {
    expect(columnUnit('Current (A)')).toBe('A')
    expect(columnUnit('Current [bwd] (A)')).toBe('A')
    expect(columnUnit('Index')).toBe('')
    expect(stripUnit('Current (A)')).toBe('Current')
    expect(stripUnit('(A)')).toBe('(A)')
  })
})

describe('channel names', () => {
  const chans = ['Z', 'Current', 'Frequency Shift', 'Bias (V)']

  it('matches exactly, case-insensitively, ignoring punctuation and a trailing unit', () => {
    expect(findChannel(chans, 'Z')).toBe('Z')
    expect(findChannel(chans, 'current')).toBe('Current')
    expect(findChannel(chans, 'frequency_shift')).toBe('Frequency Shift')
    expect(findChannel(chans, 'Bias')).toBe('Bias (V)')
    expect(findChannel(chans, 'phase')).toBeUndefined()
  })

  it('resolves aliases and df names, and lists the channels when nothing matches', () => {
    expect(resolveChannel('height', chans)).toBe('Z')
    expect(resolveChannel('topography', chans)).toBe('Z')
    expect(resolveChannel('It', chans)).toBe('Current')
    expect(resolveChannel('df', chans)).toBe('Frequency Shift')
    expect(resolveChannel('Δf', ['OC M1 Freq. Shift'])).toBe('OC M1 Freq. Shift')
    expect(resolveChannel('df', ['Amp', 'Tuning'], { Tuning: 'Hz' })).toBe('Tuning')
    expect(() => resolveChannel('phase', chans)).toThrow(ChannelError)
    expect(() => resolveChannel('df', ['Z'])).toThrow(/this frame has \["Z"\]/)
    expect(() => resolveChannel('height', ['Current'])).toThrow(ChannelError)
  })

  it('defaults to Z, falling back for constant-height frames', () => {
    const values = (m: Record<string, number[]>) => (c: string) => m[c]
    expect(defaultChannel(['Z', 'Current'], values({ Z: [0, 2e-12], Current: [1, 2] }))).toBe('Z')
    expect(defaultChannel(['Z', 'Current'], values({ Z: [0, 5e-13], Current: [1e-10, 2e-10] }))).toBe('Current')
    expect(defaultChannel(['Z', 'Current', 'Frequency Shift'], values({ Z: [0, 0], Current: [1, 1], 'Frequency Shift': [-3, -2] }))).toBe('Frequency Shift')
    expect(defaultChannel(['Z', 'Amp'], values({ Z: [1, 1], Amp: [1, 3] }))).toBe('Amp')
    expect(defaultChannel(['Z', 'Amp'], values({ Z: [1, 1], Amp: [2, 2] }))).toBe('Z')
    expect(defaultChannel(['Amp'], values({ Amp: [2, 2] }))).toBe('Amp')
  })

  it('measures the span of the finite values', () => {
    expect(span([1, Number.NaN, -2])).toBe(3)
    expect(span([Number.NaN])).toBe(0)
    expect(span(undefined)).toBe(0)
  })
})
