import { describe, expect, it } from 'vitest'
import { ChannelError, defaultChannel, findChannel, resolveChannel, span } from './channels.js'
import { columnUnit, displayUnit, maxAbs, roundValue, stripUnit, unitForChannel } from './units.js'

describe('display units', () => {
  it('reports Z in pm, current in pA, and switches to the finer unit below 10', () => {
    expect(displayUnit('m', 3e-10)).toEqual({ factor: 1e12, unit: 'pm' })
    expect(displayUnit('A', 1.5e-10)).toEqual({ factor: 1e12, unit: 'pA' }) // 150 pA
    expect(displayUnit('A', 5e-12)).toEqual({ factor: 1e15, unit: 'fA' }) // 5 pA < 10
    expect(displayUnit('Hz', 25)).toEqual({ factor: 1, unit: 'Hz' })
    expect(displayUnit('Hz', 2)).toEqual({ factor: 1e3, unit: 'mHz' })
    expect(displayUnit('V', 0.5)).toEqual({ factor: 1e3, unit: 'mV' })
    expect(displayUnit('A', null)).toEqual({ factor: 1e12, unit: 'pA' })
    expect(displayUnit('A', Number.NaN)).toEqual({ factor: 1e12, unit: 'pA' })
    expect(displayUnit('furlong', 3)).toEqual({ factor: 1, unit: 'furlong' })
    expect(displayUnit('', 3)).toEqual({ factor: 1, unit: '' })
  })

  it('rounds to 0.1 of a known unit and to 4 significant digits otherwise', () => {
    expect(roundValue(123.456, 'pm')).toBe(123.5)
    expect(roundValue(0.25, 'pA')).toBe(0.2) // ties to even, like Python's round
    expect(roundValue(0.35, 'pA')).toBe(0.3) // 0.35 is stored just below the tie
    expect(roundValue(123456.7, 'furlong')).toBe(123500)
    expect(roundValue(0.000123456, '')).toBe(0.0001235)
    expect(roundValue(Number.NaN, 'pm')).toBeNull()
    expect(roundValue(Infinity, 'pm')).toBeNull()
  })

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
    expect(maxAbs([1, -3, Number.NaN, 2])).toBe(3)
    expect(maxAbs([Number.NaN])).toBeNull()
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
