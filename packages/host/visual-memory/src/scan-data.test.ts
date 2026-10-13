import { describe, expect, it } from 'vitest'
import { decodeNpyFloat32, encodeNpyFloat32, NpyShapeError } from './npy32.js'
import { arrayKey, frameGeometry, IngestError, isDirection, loadSxm, scanFromArrays, sxmChannelUnits } from './scan-data.js'
import { encodeSyntheticSxm, type SyntheticSxm } from './synthetic-sxm.js'

/** The intended (oriented) image: row 0 = top edge, value 10·row + col. */
function oriented(nx: number, ny: number, add = 0): Float32Array {
  return Float32Array.from({ length: nx * ny }, (_, i) => 10 * Math.floor(i / nx) + (i % nx) + add)
}

function spec(over: Partial<SyntheticSxm> = {}): SyntheticSxm {
  const nx = 4
  const ny = 3
  return {
    nx,
    ny,
    widthM: 8e-9,
    heightM: 6e-9,
    offsetXM: 1e-9,
    offsetYM: -2e-9,
    angleDeg: 30,
    scanDir: 'up',
    biasV: 0.1,
    setpointA: 5e-11,
    feedbackOn: true,
    channels: [
      { name: 'Z', unit: 'm', forward: oriented(nx, ny), backward: oriented(nx, ny, 100) },
      { name: 'Current', unit: 'A', forward: oriented(nx, ny, 1000) },
      { name: 'Frequency Shift', unit: 'Hz', backward: oriented(nx, ny, 2000) },
    ],
    ...over,
  }
}

describe('.sxm ingestion through dsh-spm-nanonis-files', () => {
  for (const scanDir of ['up', 'down'] as const) {
    it(`orients rows top-first and un-mirrors the backward pass (scan_dir ${scanDir})`, () => {
      const d = loadSxm(encodeSyntheticSxm(spec({ scanDir })), 'synthetic.sxm')
      expect(d.channels).toEqual(['Z', 'Current', 'Frequency Shift'])
      expect([...(d.arrays.get('Z/forward') as Float32Array)]).toEqual([...oriented(4, 3)])
      expect([...(d.arrays.get('Z/backward') as Float32Array)]).toEqual([...oriented(4, 3, 100)])
      expect([...(d.arrays.get('Current/forward') as Float32Array)]).toEqual([...oriented(4, 3, 1000)])
      // a backward-only channel is filed under backward, not as the reader's "forward"
      expect(d.arrays.has('Frequency Shift/forward')).toBe(false)
      expect([...(d.arrays.get('Frequency Shift/backward') as Float32Array)]).toEqual([...oriented(4, 3, 2000)])
      expect(d.channelDirections).toEqual({ Z: ['forward', 'backward'], Current: ['forward'], 'Frequency Shift': ['backward'] })
      expect(d.scan_dir).toBe(scanDir)
    })
  }

  it('reads geometry (nm), units, bias, setpoint, feedback and time', () => {
    const d = loadSxm(encodeSyntheticSxm(spec()), 'f.sxm')
    expect(d.geometry.nx).toBe(4)
    expect(d.geometry.ny).toBe(3)
    expect(d.geometry.w_nm).toBeCloseTo(8, 12)
    expect(d.geometry.h_nm).toBeCloseTo(6, 12)
    expect(d.geometry.cx_nm).toBeCloseTo(1, 12)
    expect(d.geometry.cy_nm).toBeCloseTo(-2, 12)
    expect(d.geometry.angle_deg).toBe(30)
    expect(d.nm_per_px).toBeCloseTo(2, 12)
    expect(d.nm_per_px_y).toBeCloseTo(2, 12)
    expect(d.units).toEqual({ Z: 'm', Current: 'A', 'Frequency Shift': 'Hz' })
    expect(d.bias_v).toBeCloseTo(0.1, 12)
    expect(d.setpoint_a).toBeCloseTo(5e-11, 20)
    expect(d.feedback).toBe('ON')
    expect(d.rec_time).toBe('09.10.2026 12:00:00')
    expect(d.source_name).toBe('f.sxm')
    expect(d.acquired_rows).toBe(3)
  })

  it('counts acquired rows and picks Current for a constant-height frame', () => {
    const z = new Float32Array(12).fill(1e-9)
    const cur = oriented(4, 3, 1).map((v) => v * 1e-12)
    cur.fill(Number.NaN, 8)
    z.fill(Number.NaN, 8)
    const d = loadSxm(
      encodeSyntheticSxm(spec({ feedbackOn: false, channels: [{ name: 'Z', unit: 'm', forward: z }, { name: 'Current', unit: 'A', forward: cur }] })),
      'ch.sxm',
    )
    expect(d.default_channel).toBe('Current')
    expect(d.acquired_rows).toBe(2)
    expect(d.feedback).toBe('OFF')
  })

  it('reads the setpoint unit from a unit field, else from a unit after the number, else amperes', () => {
    const text = new TextDecoder('latin1').decode(encodeSyntheticSxm(spec({ setpointA: -2.5 })))
    const bytes = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0))
    expect(loadSxm(bytes(text), 'a.sxm').setpoint_unit).toBe('A')
    const trailing = text.replace(':Z-CONTROLLER>SETPOINT:\n-2.500000E+0', ':Z-CONTROLLER>SETPOINT:\n-2.500000E+0 Hz')
    expect(loadSxm(bytes(trailing), 'b.sxm')).toMatchObject({ setpoint_a: -2.5, setpoint_unit: 'Hz' })
    const field = text.replace(':DATA_INFO:', ':Z-CONTROLLER>SETPOINT UNIT:\nHz\n:DATA_INFO:')
    expect(loadSxm(bytes(field), 'c.sxm').setpoint_unit).toBe('Hz')
    expect(scanFromArrays({ Z: [[1]] }, { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1 }, { setpoint_unit: 'Hz' }).setpoint_unit).toBe('Hz')
    expect(scanFromArrays({ Z: [[1]] }, { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1 }, { setpoint_unit: '' }).setpoint_unit).toBe('A')
  })

  it('omits what the header does not say', () => {
    const { biasV: _b, setpointA: _s, feedbackOn: _f, ...rest } = spec()
    const d = loadSxm(encodeSyntheticSxm({ ...rest, angleDeg: 0 }), 'bare.sxm')
    expect(d.bias_v).toBeNull()
    expect(d.setpoint_a).toBeNull()
    expect(d.feedback).toBeNull()
    expect(d.geometry.angle_deg).toBe(0)
  })

  it('refuses files that are not scans, lack geometry, or hold no channel data', () => {
    expect(() => loadSxm(new TextEncoder().encode('no marker here'), 'x.sxm')).toThrow(IngestError)
    const text = new TextDecoder('latin1').decode(encodeSyntheticSxm(spec()))
    const noOffset = text.replace(':SCAN_OFFSET:', ':SCAN_OFFSETX:')
    expect(() => loadSxm(Uint8Array.from(noOffset, (c) => c.charCodeAt(0)), 'g.sxm')).toThrow(/scan range \/ offset \/ pixels/)
    const zeroWidth = encodeSyntheticSxm(spec({ widthM: 0 }))
    expect(() => loadSxm(zeroWidth, 'w.sxm')).toThrow(/w_nm/)
    const full = encodeSyntheticSxm(spec())
    const marker = full.indexOf(0x1a)
    const truncated = full.subarray(0, marker + 2 + 10) // shorter than one 4 × 3 frame
    expect(() => loadSxm(truncated, 't.sxm')).toThrow(/no channel data/)
  })

  it('parses :DATA_INFO: units and geometry fields on their own', () => {
    expect(sxmChannelUnits(encodeSyntheticSxm(spec()))).toEqual({ Z: 'm', Current: 'A', 'Frequency Shift': 'Hz' })
    expect(sxmChannelUnits(new TextEncoder().encode(':SCANIT_END:'))).toEqual({})
    expect(sxmChannelUnits(new TextEncoder().encode('nothing'))).toEqual({})
    expect(sxmChannelUnits(Uint8Array.from([0x3a, 0x44, 0x41, 0x54, 0x41, 0x5f, 0x49, 0x4e, 0x46, 0x4f, 0x3a, 0x0a, 0x09, 0x30, 0x09, 0x5a, 0x09, 0x6d, 0x0a, 0x1a, 0x04]))).toEqual({ Z: 'm' })
    expect(frameGeometry({ scan_range: '1E-9', scan_offset: '0 0', scan_pixels: [8, 4] })).toEqual({
      cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1, angle_deg: 0, nx: 8, ny: 4,
    })
    expect(frameGeometry({ scan_range: '1E-9', scan_offset: '0' , scan_pixels: [8, 4] })).toBeNull()
    expect(frameGeometry({ scan_range: '1E-9 2E-9', scan_offset: '0 0' })).toBeNull()
  })
})

describe('arrays of a scan in progress', () => {
  const geometry = { cx_nm: 0, cy_nm: 0, w_nm: 4, h_nm: 2 }

  it('accepts row lists and flat arrays, with or without a direction in the key', () => {
    const d = scanFromArrays(
      {
        Z: [[1e-10, 2e-10], [Number.NaN, Number.NaN]],
        'Z/backward': { rows: 2, cols: 2, data: [1e-10, 1e-10, Number.NaN, Number.NaN] },
        'Current/forward': { rows: 2, cols: 2, data: Float64Array.from([1e-11, 2e-11, 3e-11, 4e-11]) },
      },
      geometry,
      { bias_v: 0.5, scan_dir: ' DOWN ', units: { Current: 'A' } },
    )
    expect(d.channels).toEqual(['Z', 'Current'])
    expect(d.geometry).toEqual({ ...geometry, angle_deg: 0, nx: 2, ny: 2 })
    expect(d.acquired_rows).toBe(1)
    expect(d.scan_dir).toBe('down')
    expect(d.units).toEqual({ Z: 'm', Current: 'A' })
    expect(d.source_name).toBe('scan in progress')
    expect(d.bias_v).toBe(0.5)
    expect([...(d.arrays.get(arrayKey('Z', 'forward')) as Float32Array)].slice(0, 2)).toEqual([Math.fround(1e-10), Math.fround(2e-10)])
  })

  it('takes acquired rows and metadata from the caller when given', () => {
    const d = scanFromArrays({ Z: [[1, 2]] }, { ...geometry, angle_deg: 15 }, {
      acquired_rows: 0, rec_time: 'now', feedback: 'ON', source_name: 'live', setpoint_a: 1e-10, scan_dir: null,
    })
    expect(d.acquired_rows).toBe(0)
    expect(d.geometry.angle_deg).toBe(15)
    expect(d.rec_time).toBe('now')
    expect(d.feedback).toBe('ON')
    expect(d.source_name).toBe('live')
    expect(d.setpoint_a).toBe(1e-10)
    expect(d.scan_dir).toBeNull()
  })

  it('refuses inconsistent input with a message naming the array', () => {
    expect(() => scanFromArrays({}, geometry)).toThrow(/no arrays/)
    expect(() => scanFromArrays({ 'Z/up': [[1]] }, geometry)).toThrow(/direction must be forward or backward/)
    expect(() => scanFromArrays({ Z: [[1, 2], [3]] }, geometry)).toThrow(/not rectangular/)
    expect(() => scanFromArrays({ Z: { rows: 2, cols: 2, data: [1, 2, 3] } }, geometry)).toThrow(/3 values, not 2x2/)
    expect(() => scanFromArrays({ Z: [[1, 2]], Current: [[1], [2]] }, geometry)).toThrow(/has shape 2x1, others 1x2/)
    expect(() => scanFromArrays({ Z: [] }, geometry)).toThrow(/not a 2-D frame/)
    expect(() => scanFromArrays({ Z: [[1]] }, { cx_nm: 0, cy_nm: 0, w_nm: 1 } as never)).toThrow(/geometry lacks h_nm/)
    expect(() => scanFromArrays({ Z: [[1]] }, { ...geometry, w_nm: -1 })).toThrow(/w_nm/)
    expect(isDirection('forward')).toBe(true)
    expect(isDirection('up')).toBe(false)
  })
})

describe('float32 .npy files', () => {
  it('round-trip exactly, NaN included, with a 64-byte aligned header numpy can read', () => {
    const v = Float32Array.from([1.5, -2.25, Number.NaN, 3e-12, 0, 7])
    const bytes = encodeNpyFloat32(v, [2, 3])
    const headerLen = new DataView(bytes.buffer).getUint16(8, true)
    expect((10 + headerLen) % 64).toBe(0)
    expect(new TextDecoder().decode(bytes.subarray(10, 10 + headerLen))).toContain("'descr': '<f4'")
    const back = decodeNpyFloat32(bytes)
    expect(back.rows).toBe(2)
    expect(back.cols).toBe(3)
    expect(back.data[2]).toBeNaN()
    expect([...back.data].filter((x) => !Number.isNaN(x))).toEqual([1.5, -2.25, Math.fround(3e-12), 0, 7])
  })

  it('reads 1-D arrays as one row and refuses other ranks or a wrong count', () => {
    expect(decodeNpyFloat32(encodeNpyFloat32([1, 2], [2]))).toMatchObject({ rows: 1, cols: 2 })
    expect(() => decodeNpyFloat32(encodeNpyFloat32([1, 2], [1, 1, 2]))).toThrow(NpyShapeError)
    expect(() => encodeNpyFloat32([1, 2, 3], [2, 2])).toThrow(/needs 4 values, got 3/)
  })
})
