import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameArchive } from './archive.js'
import { decodePng, encodePngRgb } from './png.js'
import { encodeSyntheticSxm } from './synthetic-sxm.js'
import { inspect, MAX_READ_SAMPLES, readValues, sampleAxis, type ViewToolResult } from './views.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Z(c, r) = (2c + r) pm, plus a 50 pm bump at (5, 3); 16 × 8 px over 8 × 4 nm, centred at (1, 2) nm. */
function zFrame(): Float32Array {
  return Float32Array.from({ length: 128 }, (_, i) => {
    const r = Math.floor(i / 16)
    const c = i % 16
    return 2e-12 * c + 1e-12 * r + (c === 5 && r === 3 ? 50e-12 : 0)
  })
}

function setup(): { a: FrameArchive; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'vm-views-'))
  dirs.push(root)
  const a = new FrameArchive(join(root, 'frames'), { displayMax: 64 })
  a.addScanBytes(
    0,
    encodeSyntheticSxm({
      nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 1e-9, offsetYM: 2e-9, scanDir: 'down',
      channels: [
        { name: 'Z', unit: 'm', forward: zFrame(), backward: zFrame() },
        { name: 'Current', unit: 'A', forward: new Float32Array(128).fill(2e-10) },
      ],
    }),
    { sourceName: 's.sxm' },
  )
  return { a, root }
}

function ok(r: ViewToolResult): Extract<ViewToolResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`)
  return r
}

function err(r: ViewToolResult): string {
  if (r.ok) throw new Error('expected an error')
  return r.error
}

/** A hand-made spectrum record (spectra are not ingested yet) to reach the spectrum branches. */
function addSpectrumRecord(a: FrameArchive): void {
  writeFileSync(join(a.root, 't0000.d0.png'), encodePngRgb(1, 1, new Uint8Array(3)))
  appendFileSync(
    join(a.root, 'index.jsonl'),
    `${JSON.stringify({ fid: 't0000.d0', turn: 0, kind: 'd', index: 0, source_name: 'sts.dat', channels: ['Bias (V)', 'Current (A)'], directions: [], nx: 10, ny: 1, geometry: null, nm_per_px: null, display_scale: 1, display_size: [0, 0], bias_v: null, setpoint_a: null, scan_dir: null, acquired_rows: null, rec_time: '', sim_s: null, units: {}, default_channel: 'Current (A)', extra: {} })}\n`,
  )
}

describe('inspect', () => {
  it('returns one labelled image per view, in request order, with the view facts', () => {
    const { a } = setup()
    const r = ok(inspect(a, {
      question: 'Is the bump round?',
      views: [
        { label: 'whole', frame: 't0000.s0' },
        { label: 'bump', frame: ' t0000.s0 ', direction: 'backward', region: { x: 16, y: 8, width: 16, height: 8 }, flatten: 'line', clip_pct: 2 },
      ],
    }))
    expect(r.reply).toEqual({ instrument_unchanged: true, view_count: 2, views: expect.any(Array) })
    expect(r.images.map((i) => i.name)).toEqual(['t0000.s0.inspect-1.png', 't0000.s0.inspect-2.png'])
    expect(r.images[0]?.label).toMatch(/^<visual kind="inspection" index="1" count="2" label="whole" frame="t0000\.s0" channel="Z" direction="forward" flatten="plane" scale="4" size="64x32" region="0,0,64,32"/)
    expect(r.images[1]?.label).toContain('index="2" count="2" label="bump"')
    expect(r.images[1]?.label).toContain('magnification="4"')
    const views = r.reply['views'] as Record<string, unknown>[]
    expect(views[1]).toMatchObject({
      index: 2, label: 'bump', frame: 't0000.s0', kind: 'scan', channel: 'Z', direction: 'backward', flatten: 'line',
      region_px: [16, 8, 16, 8], native_px: [4, 2, 8, 4], image_size_px: [64, 32], magnification: 4, image_px_per_scan_px: 16,
      nm_per_image_px: 0.03125,
    })
    expect(Object.keys(views[0] as object)).toEqual([
      'index', 'label', 'frame', 'kind', 'channel', 'direction', 'flatten', 'region_px', 'native_px', 'image_size_px',
      'magnification', 'image_px_per_scan_px', 'nm_per_image_px', 'corners_nm', 'black_pm', 'white_pm', 'min_pm', 'max_pm',
    ])
    const img = decodePng(r.images[1]?.png as Uint8Array)
    expect([img.width, img.height]).toEqual([64, 32])
  })

  it('crops derived images and reports rows still missing in partial scans', () => {
    const { a } = setup()
    a.addDerived(0, encodePngRgb(8, 4, new Uint8Array(96)), { tool: 'stm_fft_peaks', sources: ['t0000.s0'] })
    a.addPartial(0, { Z: { rows: 8, cols: 16, data: zFrame().fill(Number.NaN, 64) } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 } })
    const r = ok(inspect(a, {
      question: 'q',
      views: [
        { label: 'fft', frame: 't0000.m0', region: { x: 0, y: 0, width: 4, height: 2 } },
        { label: 'partial', frame: 't0000.p0' },
      ],
    }))
    const views = r.reply['views'] as Record<string, unknown>[]
    expect(views[0]).toEqual({ index: 1, label: 'fft', frame: 't0000.m0', kind: 'derived', tool: 'stm_fft_peaks', region_px: [0, 0, 4, 2], image_size_px: [64, 32], magnification: 16 })
    expect(views[1]).toMatchObject({ kind: 'partial', rows_acquired: 4, rows_total: 8 })
    expect(r.images[0]?.label.startsWith('<visual kind="inspection" index="1" count="2" label="fft" frame="t0000.m0" derived="stm_fft_peaks"')).toBe(true)
  })

  it('says what to change for every invalid argument', () => {
    const { a } = setup()
    a.addDerived(0, encodePngRgb(8, 4, new Uint8Array(96)), { tool: 'stm_fft_peaks' })
    addSpectrumRecord(a)
    const b = new FrameArchive(a.root, { displayMax: 64 })
    const v = (over: Record<string, unknown>) => ({ question: 'q', views: [{ label: 'v', frame: 't0000.s0', ...over }] })
    const cases: [unknown, RegExp][] = [
      [[1], /^inspect: arguments must be an object$/],
      [{ question: 'q', views: [], extra: 1 }, /unknown field\(s\) \['extra'\]; allowed: \['question', 'views'\]/],
      [{ views: [{}] }, /missing required field\(s\) \['question'\]/],
      [{ question: ' ', views: [{}] }, /question must be a non-empty string/],
      [{ question: 'x'.repeat(1025), views: [{}] }, /question is longer than 1024 characters/],
      [{ question: 'q', views: [] }, /views must be a non-empty list/],
      [{ question: 'q', views: Array.from({ length: 17 }, () => ({ label: 'v', frame: 't0000.s0' })) }, /at most 16 views per call \(got 17\)/],
      [{ question: 'q', views: ['t0000.s0'] }, /views\[1\] must be an object/],
      [v({ zoom: 2 }), /views\[1\]: unknown field\(s\) \['zoom'\]/],
      [{ question: 'q', views: [{ frame: 't0000.s0' }] }, /views\[1\]: missing required field\(s\) \['label'\]/],
      [v({ label: '' }), /views\[1\]\.label must be a non-empty string/],
      [v({ label: 'x'.repeat(129) }), /label is longer than 128 characters/],
      [v({ frame: 7 }), /views\[1\]\.frame must be a frame id like 't0007\.s0'/],
      [v({ frame: 't0009.s0' }), /views\[1\]\.frame: no frame "t0009\.s0"/],
      [v({ channel: 'phase' }), /views\[1\]\.channel: t0000\.s0: no channel "phase"/],
      [v({ channel: 3 }), /views\[1\]\.channel must be a string/],
      [v({ channel: 'x'.repeat(65) }), /views\[1\]\.channel must have 1\.\.64 characters/],
      [v({ direction: 'up' }), /views\[1\]\.direction must be one of \["forward","backward"\], not "up"/],
      [v({ channel: 'Current', direction: 'backward' }), /views\[1\]\.direction: t0000\.s0 channel "Current" has only \["forward"\]/],
      [v({ region: { x: 0, y: 0, width: 4 } }), /views\[1\]\.region: missing required field\(s\) \['height'\]/],
      [v({ region: { x: 0, y: 0, width: 4, height: 4, z: 1 } }), /region: unknown field\(s\) \['z'\]/],
      [v({ region: { x: 60, y: 0, width: 8, height: 4 } }), /leaves t0000\.s0's 64x32 display image \(need x \+ width <= 64 and y \+ height <= 32\)/],
      [v({ region: { x: -1, y: 0, width: 8, height: 4 } }), /region\.x must be >= 0/],
      [v({ region: { x: 0.5, y: 0, width: 8, height: 4 } }), /region\.x must be an integer/],
      [v({ region: { x: 0, y: 0, width: '8', height: 4 } }), /region\.width must be a number/],
      [v({ region: 'all' }), /views\[1\]\.region must be an object/],
      [v({ flatten: 'tilt' }), /flatten must be one of/],
      [v({ highpass_nm: 2 }), /highpass_nm only applies with flatten='highpass'/],
      [v({ flatten: 'highpass', highpass_nm: 0 }), /highpass_nm must be > 0/],
      [v({ flatten: 'highpass', highpass_nm: 20000 }), /highpass_nm must be <= 10000/],
      [v({ clip_pct: 30 }), /clip_pct must be <= 25/],
      [v({ clip_pct: Number.NaN }), /clip_pct must be finite/],
      [{ question: 'q', views: [{ label: 'v', frame: 't0000.m0', channel: 'Z' }] }, /\['channel'\] do not apply to a derived image frame/],
      [{ question: 'q', views: [{ label: 'v', frame: 't0000.d0' }] }, /t0000\.d0 is a spectrum; spectra cannot be inspected yet/],
    ]
    for (const [args, re] of cases) expect(err(inspect(b, args))).toMatch(re)
  })

  it('turns archive errors during rendering into argument errors and unexpected ones into internal errors', () => {
    const { a } = setup()
    const spy = vi.spyOn(a, 'render')
    spy.mockImplementationOnce(() => {
      throw new TypeError('boom')
    })
    expect(err(inspect(a, { question: 'q', views: [{ label: 'v', frame: 't0000.s0' }] }))).toBe('inspect: internal error TypeError: boom')
    spy.mockRestore()
    vi.spyOn(a, 'render').mockImplementationOnce(() => {
      throw new Error('plain')
    })
    expect(err(inspect(a, { question: 'q', views: [{ label: 'v', frame: 't0000.s0' }] }))).toBe('inspect: internal error Error: plain')
  })

  it('reports an archive error raised while rendering a planned view', () => {
    const { a } = setup()
    const real = a.render.bind(a)
    vi.spyOn(a, 'render').mockImplementation((fid, o) => real(fid, { ...o, region: { x: 999, y: 0, width: 1, height: 1 } }))
    expect(err(inspect(a, { question: 'q', views: [{ label: 'v', frame: 't0000.s0' }] }))).toMatch(/^inspect: views\[1\]: region x=999/)
  })
})

describe('read_values', () => {
  it('samples cell centers with the VISTA rule and reports physical values in pm', () => {
    const { a } = setup()
    const r = ok(readValues(a, { question: 'heights', views: [{ label: 'grid', frame: 't0000.s0', rows: 2, columns: 4 }] }))
    expect(r.images).toEqual([])
    expect(r.reply).toMatchObject({
      instrument_unchanged: true, sample_count: 8, view_count: 1,
      sampling: 'cell centers: x + ((2c+1)*width)//(2*columns), y likewise',
    })
    const v = (r.reply['views'] as Record<string, unknown>[])[0] as Record<string, unknown>
    // W = 64: x = 0 + floor((2c+1)·64/8) = 8, 24, 40, 56 → native 2, 6, 10, 14; rows 8, 24 → native 2, 6
    expect(v).toMatchObject({
      index: 1, label: 'grid', frame: 't0000.s0', channel: 'Z', direction: 'forward', decimals: 1,
      region_px: [0, 0, 64, 32], rows: 2, columns: 4, sample_x_px: [8, 24, 40, 56], sample_y_px: [8, 24],
      values_pm: [[6, 14, 22, 30], [10, 18, 26, 34]],
    })
    // display (8.5, 8.5) → native (2.125, 2.125) → u = -2.9375, v = 0.9375 → (cx + u, cy + v)
    expect(v['first_sample_nm']).toEqual([-1.9375, 2.9375])
    // display (56.5, 24.5) → native (14.125, 6.125) → u = 3.0625, v = -1.0625
    expect(v['last_sample_nm']).toEqual([4.0625, 0.9375])
    expect(v).not.toHaveProperty('null_count')
  })

  it('reads a region, the backward pass, other channels, and null where nothing was acquired', () => {
    const { a } = setup()
    a.addPartial(1, { Z: { rows: 8, cols: 16, data: zFrame().fill(Number.NaN, 64) } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 } })
    const r = ok(readValues(a, {
      question: 'q',
      views: [
        { label: 'bump', frame: 't0000.s0', direction: 'backward', region: { x: 20, y: 12, width: 4, height: 4 }, rows: 1, columns: 1 },
        { label: 'current', frame: 't0000.s0', channel: 'Current', rows: 1, columns: 1 },
        { label: 'partial', frame: 't0001.p0', rows: 2, columns: 1 },
      ],
    }))
    const views = r.reply['views'] as Record<string, unknown>[]
    expect(views[0]).toMatchObject({ direction: 'backward', sample_x_px: [22], sample_y_px: [14], values_pm: [[63]] }) // native (5, 3): 10 + 3 + 50
    expect(views[1]).toMatchObject({ decimals: 1, values_pa: [[200]] })
    expect(views[2]).toMatchObject({ sample_x_px: [32], sample_y_px: [8, 24], values_pm: [[18], [null]], null_count: 1 }) // native (8, 2) and (8, 6)
    expect(r.reply['sample_count']).toBe(4)
  })

  it('samples the native pixel under the cell centre of a block-mean display', () => {
    const { a } = setup()
    const e = a.addPartial(2, { Z: { rows: 50, cols: 100, data: Float32Array.from({ length: 5000 }, (_, i) => (i % 100) * 1e-12) } }, {
      geometry: { cx_nm: 0, cy_nm: 0, w_nm: 10, h_nm: 5 },
    })
    expect(e.display_size).toEqual([50, 25])
    const r = ok(readValues(a, { question: 'q', views: [{ label: 'v', frame: e.fid, rows: 1, columns: 3 }] }))
    const v = (r.reply['views'] as Record<string, unknown>[])[0] as Record<string, unknown>
    // centers 50/6, 150/6, 250/6 display px → native floor(2·center) = 16, 50, 83
    expect(v).toMatchObject({ sample_x_px: [8, 25, 41], values_pm: [[16, 50, 83]] })
  })

  it('reads the values behind a derived map, and explains a derived image without values', () => {
    const { a } = setup()
    a.addDerived(0, encodePngRgb(64, 32, new Uint8Array(64 * 32 * 3)), {
      tool: 'stm_frame_diff', arrays: { diff: { rows: 8, cols: 16, data: zFrame() } }, geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 }, units: { diff: 'm' },
    })
    a.addDerived(0, encodePngRgb(4, 4, new Uint8Array(48)), { tool: 'stm_detect_blobs', sources: ['t0000.s0'] })
    a.addDerived(0, encodePngRgb(4, 4, new Uint8Array(48)), { tool: 'stm_detect_blobs' })
    const r = ok(readValues(a, { question: 'q', views: [{ label: 'd', frame: 't0000.m0', rows: 1, columns: 1 }] }))
    expect((r.reply['views'] as Record<string, unknown>[])[0]).toMatchObject({ channel: 'diff', decimals: 1, values_pm: [[expect.any(Number)]] })
    expect(err(readValues(a, { question: 'q', views: [{ label: 'd', frame: 't0000.m1', rows: 1, columns: 1 }] }))).toBe(
      "read_values: views[1].frame: t0000.m1 is a derived image without values; use the frame it was derived from (t0000.s0)",
    )
    expect(err(readValues(a, { question: 'q', views: [{ label: 'd', frame: 't0000.m2', rows: 1, columns: 1 }] }))).toMatch(/derived from \(see history\)/)
  })

  it('enforces the per-call limits and the scan-view fields', () => {
    const { a } = setup()
    addSpectrumRecord(a)
    const b = new FrameArchive(a.root, { displayMax: 64 })
    const view = { label: 'v', frame: 't0000.s0', rows: 1, columns: 1 }
    expect(err(readValues(b, { question: 'q', views: Array.from({ length: 65 }, () => view) }))).toMatch(/at most 64 views per call \(got 65\)/)
    expect(err(readValues(b, { question: 'q', views: [{ ...view, rows: 64, columns: 64 }, view] }))).toBe(
      'read_values: at most 4096 samples per call; views 1..2 already ask for 4097',
    )
    expect(ok(readValues(b, { question: 'q', views: [{ ...view, rows: 64, columns: 64 }] })).reply['sample_count']).toBe(MAX_READ_SAMPLES)
    expect(err(readValues(b, { question: 'q', views: [{ label: 'v', frame: 't0000.s0', rows: 2 }] }))).toMatch(/a scan view needs rows and columns/)
    expect(err(readValues(b, { question: 'q', views: [{ ...view, rows: 0 }] }))).toMatch(/rows must be >= 1/)
    expect(err(readValues(b, { question: 'q', views: [{ ...view, columns: 4097 }] }))).toMatch(/columns must be <= 4096/)
    expect(err(readValues(b, { question: 'q', views: [{ ...view, flatten: 'plane' }] }))).toMatch(/unknown field\(s\) \['flatten'\]/)
    expect(err(readValues(b, { question: 'q', views: [{ ...view, frame: 't0000.d0' }] }))).toMatch(/spectra cannot be read yet/)
  })
})

describe('cell-centre sampling', () => {
  it('follows x + floor(((2c+1)·w) / (2n)) and maps to native pixels', () => {
    expect(sampleAxis(0, 64, 4, { num: 4, den: 1 }, 16)).toEqual({ display: [8, 24, 40, 56], native: [2, 6, 10, 14] })
    expect(sampleAxis(10, 5, 2, { num: 1, den: 1 }, 100)).toEqual({ display: [11, 13], native: [11, 13] })
    expect(sampleAxis(0, 50, 3, { num: 1, den: 2 }, 100)).toEqual({ display: [8, 25, 41], native: [16, 50, 83] })
    expect(sampleAxis(0, 3, 1, { num: 1, den: 4 }, 10)).toEqual({ display: [1], native: [6] })
    expect(sampleAxis(0, 3, 1, { num: 1, den: 4 }, 5).native).toEqual([4]) // clipped to the frame
  })
})
