import { describe, expect, it } from 'vitest'
import { FrameIdError, frameId, isFrameId, isFrameKind, KIND_WORDS, parseFrameId } from './frame-id.js'

describe('frame ids', () => {
  it('pads the turn to four digits and leaves the index unpadded', () => {
    expect(frameId(7, 's', 0)).toBe('t0007.s0')
    expect(frameId(0, 'p', 12)).toBe('t0000.p12')
    expect(frameId(12345, 'm', 3)).toBe('t12345.m3')
  })

  it('parses what it writes, ignoring surrounding whitespace', () => {
    expect(parseFrameId('t0007.s0')).toEqual({ turn: 7, kind: 's', index: 0 })
    expect(parseFrameId('  t12345.d2 ')).toEqual({ turn: 12345, kind: 'd', index: 2 })
    for (const kind of ['s', 'p', 'd', 'm'] as const) {
      const id = frameId(3, kind, 4)
      expect(parseFrameId(id)).toEqual({ turn: 3, kind, index: 4 })
    }
  })

  it('rejects malformed ids with a message that shows the expected form', () => {
    for (const bad of ['t7.s0', 't0007.x0', 't0007.s', 'T0007.s0', '0007.s0', '', 't0007.s0x']) {
      expect(() => parseFrameId(bad)).toThrow(FrameIdError)
      expect(isFrameId(bad)).toBe(false)
    }
    expect(() => parseFrameId('nope')).toThrow(/expected like 't0007\.s0'/)
    expect(isFrameId(42)).toBe(false)
    expect(isFrameId(' t0001.m0 ')).toBe(true)
  })

  it('rejects negative or fractional components and unknown kinds', () => {
    expect(() => frameId(-1, 's', 0)).toThrow(/turn/)
    expect(() => frameId(1.5, 's', 0)).toThrow(/turn/)
    expect(() => frameId(1, 's', -2)).toThrow(/index/)
    expect(() => frameId(1, 'x' as never, 0)).toThrow(/kind/)
  })

  it('names the kinds', () => {
    expect(KIND_WORDS).toEqual({ s: 'scan', p: 'partial scan', d: 'spectrum', m: 'derived image' })
    expect(isFrameKind('d')).toBe(true)
    expect(isFrameKind('q')).toBe(false)
  })
})
