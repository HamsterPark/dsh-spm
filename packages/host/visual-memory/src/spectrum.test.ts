import { describe, expect, it } from 'vitest'
import { decodePng } from './png.js'
import { IngestError } from './scan-data.js'
import { inRange, loadDat, nanExtent, renderSpectrumPlot, SPECTRUM_RGB, SpectrumError, spectrumPlotSize } from './spectrum.js'
import { encodeSyntheticDat, formatE6, syntheticDatText } from './synthetic-dat.js'

/** The reference's test spectrum (`tests/test_frames.write_dat`): 21 points from -0.5 to 0.5 V. */
function sts(n = 21): Uint8Array {
  const v = Array.from({ length: n }, (_, i) => -0.5 + i / (n - 1))
  return encodeSyntheticDat({
    header: {
      Experiment: 'bias spectroscopy', 'X (m)': 1.25e-9, 'Y (m)': -2e-9, 'Bias>Bias (V)': 0.5, 'Z-Controller>Setpoint': 1e-10,
    },
    columns: [['Bias calc (V)', v], ['Current (A)', v.map((x) => x * 2e-10)], ['LI Demod 1 X (A)', v.map((x) => 1e-12 + 1e-13 * x)]],
  })
}

describe('the synthetic .dat writer', () => {
  it('writes numbers like %.6E and the controller layout', () => {
    expect([1.23456e-1, -2e-11, 0, 5e100, Number.NaN, -Infinity, Infinity].map(formatE6)).toEqual([
      '1.234560E-01', '-2.000000E-11', '0.000000E+00', '5.000000E+100', 'NAN', '-INF', 'INF',
    ])
    expect(syntheticDatText({ header: { Hold: false, Gain: 2.5 }, columns: [] })).toBe('Hold\tFALSE\t\nGain\t2.500000E+00\t\n\n[DATA]\n\n')
    expect(syntheticDatText({ header: { Experiment: 'x', 'Num Pixel': 2, Hold: true, 'Z (m)': 1e-9 }, columns: [['A (V)', [1, 2]], ['B', [3, 4]]] })).toBe(
      'Experiment\tx\t\nNum Pixel\t2\t\nHold\tTRUE\t\nZ (m)\t1.000000E-09\t\n\n[DATA]\nA (V)\tB\n1.000000E+00\t3.000000E+00\n2.000000E+00\t4.000000E+00\n',
    )
  })
})

describe('loading a .dat file', () => {
  it('keeps every column in file order with its SI unit, and the header facts', () => {
    const d = loadDat(sts(), 's.dat')
    expect([...d.columns.keys()]).toEqual(['Bias calc (V)', 'Current (A)', 'LI Demod 1 X (A)'])
    expect(d.units).toEqual({ 'Bias calc (V)': 'V', 'Current (A)': 'A', 'LI Demod 1 X (A)': 'A' })
    expect(d.columns.get('Bias calc (V)')?.[0]).toBe(-0.5)
    expect(d.columns.get('Current (A)')?.[2]).toBe(-8e-11)
    expect(d.columns.get('Bias calc (V)')).toBeInstanceOf(Float64Array)
    expect(d).toMatchObject({ experiment: 'bias spectroscopy', bias_v: 0.5, setpoint_a: 1e-10, setpoint_unit: 'A', rec_time: '', source_name: 's.dat' })
    expect(d.x_nm).toBeCloseTo(1.25, 12)
    expect(d.y_nm).toBeCloseTo(-2, 12)
  })

  it('reads header values like the reference: the first finite number, the save date first, the setpoint unit', () => {
    const d = loadDat(encodeSyntheticDat({
      header: {
        'X (m)': 'nan 1.5E-9', 'Bias>Bias (V)': 'n/a', 'Z-Controller>Setpoint': '-2.5;Hz', 'Z-Controller>Setpoint unit': 'Hz',
        Date: '12.10.2026 10:00:00', 'Saved Date': '',
      },
      columns: [['Z rel (m)', [0, 1e-10]]],
    }), 'z.dat')
    expect(d.x_nm).toBeCloseTo(1.5, 12)
    expect(d.y_nm).toBeNull()
    expect(d).toMatchObject({ bias_v: null, setpoint_a: -2.5, setpoint_unit: 'Hz', rec_time: '12.10.2026 10:00:00', experiment: '' })
    expect(loadDat(encodeSyntheticDat({ header: { 'Z-Controller>Setpoint': '5E-11 A', 'Saved Date': 's', Date: 'd' }, columns: [['I', [1]]] }), 'a.dat'))
      .toMatchObject({ setpoint_a: 5e-11, setpoint_unit: 'A', rec_time: 's' })
    expect(loadDat(encodeSyntheticDat({ columns: [['Index', [1, 2]]] }), 'u.dat').units).toEqual({ Index: '' })
  })

  it('refuses a file without data columns', () => {
    expect(() => loadDat(new TextEncoder().encode('Experiment\tx\t\n'), 'e.dat')).toThrow(IngestError)
    expect(() => loadDat(new TextEncoder().encode('Experiment\tx\t\n[DATA]\nA\tB\n'), 'e.dat')).toThrow(/^e\.dat: no data columns$/)
  })
})

describe('x ranges and extents', () => {
  it('include the ends with a relative tolerance of 1e-9 and never NaN', () => {
    expect(inRange(0.1 + 1e-10, -0.1, 0.1)).toBe(true)
    expect(inRange(0.1 + 2e-9, -0.1, 0.1)).toBe(false)
    expect(inRange(1000 + 9e-7, 0, 1000)).toBe(true) // eps = 1e-9 · 1000
    expect(inRange(Number.NaN, -1, 1)).toBe(false)
  })

  it('take the extent without NaN, like nanmin / nanmax', () => {
    expect(nanExtent([Number.NaN, 2, -1, Number.NaN, 5])).toEqual([-1, 5])
    expect(nanExtent([Number.NaN])).toEqual([Number.NaN, Number.NaN])
    expect(nanExtent([-Infinity, 3])).toEqual([-Infinity, 3])
  })
})

describe('the plot', () => {
  it('has the reference size: W = max(600, D), H = max(360, min(W, 90 + 300·n)), truncated like matplotlib', () => {
    expect(spectrumPlotSize(64, 1)).toEqual([600, 390])
    expect(spectrumPlotSize(64, 3)).toEqual([600, 600])
    expect(spectrumPlotSize(768, 1)).toEqual([768, 390])
    expect(spectrumPlotSize(768, 2)).toEqual([768, 690])
    expect(spectrumPlotSize(768, 4)).toEqual([768, 768])
    expect(spectrumPlotSize(1536, 4)).toEqual([1536, 1290])
    expect(spectrumPlotSize(803, 1)).toEqual([802, 390]) // 8.03 · 100 = 802.9999999999999
    expect(spectrumPlotSize(803, 3)).toEqual([802, 802])
    expect(spectrumPlotSize(1000, 0)).toEqual([1000, 360])
  })

  it('shows the points inside x_range, in model units, one panel per column', () => {
    const d = loadDat(sts(), 's.dat')
    const p = renderSpectrumPlot(d.columns, d.units, { xCol: 'Bias calc (V)', yCols: ['Current (A)', 'LI Demod 1 X (A)'], xRange: [0.2, -0.2], widthPx: 768 })
    expect(p.meta).toEqual({
      x_col: 'Bias calc (V)', x_unit: 'V', n_points: 9, x_shown: [-0.2, 0.2],
      y: [{ column: 'Current (A)', unit: 'pA' }, { column: 'LI Demod 1 X (A)', unit: 'pA' }],
    })
    const img = decodePng(p.png)
    expect([img.width, img.height, p.width, p.height]).toEqual([768, 690, 768, 690])
    let blue = 0 // the curves are drawn in the reference's colour
    for (let i = 0; i < img.data.length; i += 3) {
      if (img.data[i] === SPECTRUM_RGB[0] && img.data[i + 1] === SPECTRUM_RGB[1] && img.data[i + 2] === SPECTRUM_RGB[2]) blue += 1
    }
    expect(blue).toBeGreaterThan(500)
    const all = renderSpectrumPlot(d.columns, d.units, { xCol: 'Current (A)', yCols: ['Bias calc (V)'] })
    expect(all.meta).toMatchObject({ x_unit: 'pA', n_points: 21, x_shown: [-100, 100] })
    expect([all.width, all.height]).toEqual([768, 390])
  })

  it('refuses more panels than the reference height leaves room for (the tools ask for at most four)', () => {
    const d = loadDat(sts(), 's.dat')
    const nine = Array.from({ length: 9 }, () => 'Current (A)')
    expect(() => renderSpectrumPlot(d.columns, d.units, { xCol: 'Bias calc (V)', yCols: nine, widthPx: 64 })).toThrow(SpectrumError)
    expect(() => renderSpectrumPlot(d.columns, d.units, { xCol: 'Bias calc (V)', yCols: nine, widthPx: 64 })).toThrow(/too small for 9 panel/)
    expect(renderSpectrumPlot(d.columns, d.units, { xCol: 'Bias calc (V)', yCols: nine.slice(1), widthPx: 64 }).height).toBe(600)
  })

  it('says where x lies when x_range holds no point', () => {
    const d = loadDat(sts(), 's.dat')
    const plot = (xRange: [number, number]) => () => renderSpectrumPlot(d.columns, d.units, { xCol: 'Bias calc (V)', yCols: ['Current (A)'], xRange })
    expect(plot([900, 1000])).toThrow(SpectrumError)
    expect(plot([900, 1000])).toThrow(/^x_range 900\.0\.\.1000\.0 V contains no samples \(x spans -0\.5\.\.0\.5 V\)$/)
    expect(plot([1e-6, 2e-6])).toThrow(/^x_range 1e-06\.\.2e-06 V contains no samples/)
    expect(() => renderSpectrumPlot(d.columns, d.units, { xCol: 'nope', yCols: [] })).toThrow(/^no column 'nope'$/)
    expect(() => renderSpectrumPlot(d.columns, d.units, { xCol: 'Bias calc (V)', yCols: ['nope'] })).toThrow(/^no column 'nope'$/)
  })
})
