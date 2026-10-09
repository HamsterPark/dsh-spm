import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveError, entryScale, entrySummary, FrameArchive, hasValues, INDEX_NAME, mergeAttrs } from './archive.js'
import { encodePngRgb, decodePng } from './png.js'
import { encodeSyntheticSxm, type SyntheticSxm } from './synthetic-sxm.js'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vm-archive-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 16 × 8 frame, 8 nm × 4 nm: a tilted plane plus a bump, Z in metres. */
function zFrame(nx = 16, ny = 8): Float32Array {
  return Float32Array.from({ length: nx * ny }, (_, i) => {
    const r = Math.floor(i / nx)
    const c = i % nx
    return (2e-12 * c + 1e-12 * r + (c === 5 && r === 3 ? 50e-12 : 0))
  })
}

function sxm(over: Partial<SyntheticSxm> = {}): Uint8Array {
  const nx = over.nx ?? 16
  const ny = over.ny ?? 8
  return encodeSyntheticSxm({
    nx,
    ny,
    widthM: 8e-9,
    heightM: 4e-9,
    offsetXM: 1e-9,
    offsetYM: 2e-9,
    scanDir: 'down',
    biasV: -0.5,
    channels: [
      { name: 'Z', unit: 'm', forward: zFrame(nx, ny), backward: zFrame(nx, ny).map((v) => v + 1e-12) },
      { name: 'Current', unit: 'A', forward: Float32Array.from({ length: nx * ny }, (_, i) => 1e-10 + i * 1e-12) },
    ],
    ...over,
  })
}

function writeSxm(dir: string, name: string, bytes: Uint8Array = sxm()): string {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

describe('adding scans', () => {
  it('stores every channel and direction, a default PNG and an index line', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'frames'), { displayMax: 64 })
    const e = a.addScan(0, writeSxm(root, 'scan_001.sxm'), { simS: 12.5 })
    expect(e).toMatchObject({
      fid: 't0000.s0', turn: 0, kind: 's', index: 0, source_name: 'scan_001.sxm',
      channels: ['Z', 'Current'], directions: ['forward', 'backward'], nx: 16, ny: 8,
      display_scale: 4, display_size: [64, 32], scan_dir: 'down', acquired_rows: 8, sim_s: 12.5,
      units: { Z: 'm', Current: 'A' }, default_channel: 'Z',
    })
    expect(e.bias_v).toBeCloseTo(-0.5, 12)
    expect(e.extra.array_keys).toEqual(['Z/forward', 'Z/backward', 'Current/forward'])
    for (const f of [INDEX_NAME, 't0000.s0.a0.npy', 't0000.s0.a1.npy', 't0000.s0.a2.npy', 't0000.s0.png']) {
      expect(existsSync(join(a.root, f))).toBe(true)
    }
    const png = decodePng(readFileSync(join(a.root, 't0000.s0.png')))
    expect([png.width, png.height, png.channels]).toEqual([64, 32, 3])
    const obs = a.observation('t0000.s0')
    expect(obs.label).toMatch(/^<visual kind="current" frame="t0000\.s0" channel="Z" direction="forward" flatten="plane" scale="4" size="64x32" region="0,0,64,32" field_nm="8x4" z_range_pm="-?\d+\.\d\.\.\d+\.\d"\/>$/)
    expect(Buffer.from(obs.png).equals(readFileSync(join(a.root, 't0000.s0.png')))).toBe(true)
    expect(a.observation('t0000.s0', 'inspection').label.startsWith('<visual kind="inspection"')).toBe(true)
  })

  it('numbers frames per turn and kind, and remembers the latest turn', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const p = writeSxm(root, 'a.sxm')
    expect(a.addScan(3, p).fid).toBe('t0003.s0')
    expect(a.addScan(3, p).fid).toBe('t0003.s1')
    expect(a.addScan(1, p).fid).toBe('t0001.s0')
    expect(a.addPartial(3, { Z: [[1e-10, 2e-10]] }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1 } }).fid).toBe('t0003.p0')
    expect(a.currentTurn).toBe(3)
    a.setTurn(9)
    expect(a.currentTurn).toBe(9)
    a.setTurn(-4)
    expect(a.currentTurn).toBe(0)
    expect(() => a.setTurn(1.5)).toThrow(ArchiveError)
    expect(a.frames().map((e) => e.fid)).toEqual(['t0003.s0', 't0003.s1', 't0001.s0', 't0003.p0'])
    expect(a.frames({ turn: 3 }).map((e) => e.fid)).toEqual(['t0003.s0', 't0003.s1', 't0003.p0'])
    expect(a.frames({ kind: 'p' }).map((e) => e.fid)).toEqual(['t0003.p0'])
    expect(a.latest()?.fid).toBe('t0001.s0')
    expect(a.latest('p')?.fid).toBe('t0003.p0')
    expect(a.latest('m')).toBeUndefined()
    expect(() => a.addScan(-1, p)).toThrow(/turn must be an integer >= 0/)
  })

  it('refuses missing, oversized-by-content or unreadable files with an ArchiveError', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'))
    expect(() => a.addScan(0, join(root, 'nope.sxm'))).toThrow(/no such \.sxm file/)
    expect(() => a.addScanBytes(0, new TextEncoder().encode('garbage'), { sourceName: 'g.sxm' })).toThrow(ArchiveError)
    expect(() => a.addPartial(0, {}, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1 } })).toThrow(/no arrays/)
    expect(() => new FrameArchive(join(root, 'g'), { displayMax: 32 })).toThrow(/at least 64/)
    expect(a.frames()).toEqual([])
  })
})

describe('re-opening a root', () => {
  it('restores the index, the turn and the archived values from disk', () => {
    const root = tmp()
    const dir = join(root, 'frames')
    const a = new FrameArchive(dir, { displayMax: 64 })
    a.addScan(2, writeSxm(root, 's.sxm'))
    const before = a.array('t0002.s0', 'Z', 'backward')
    const b = new FrameArchive(dir, { displayMax: 64 })
    expect(b.loadWarnings).toEqual([])
    expect(b.currentTurn).toBe(2)
    expect(b.get('t0002.s0')).toEqual(a.get('t0002.s0'))
    const after = b.array('t0002.s0', 'Z', 'backward')
    expect([...after.data]).toEqual([...before.data])
    expect(after).toMatchObject({ channel: 'Z', direction: 'backward', unit: 'm', rows: 8, cols: 16 })
    expect(b.addScan(2, join(root, 's.sxm')).fid).toBe('t0002.s1') // allocation continues
  })

  it('skips damaged lines, frames with missing files and reports duplicates', () => {
    const root = tmp()
    const dir = join(root, 'frames')
    const a = new FrameArchive(dir, { displayMax: 64 })
    const p = writeSxm(root, 's.sxm')
    a.addScan(0, p)
    a.addScan(1, p)
    const lines = readFileSync(join(dir, INDEX_NAME), 'utf8').trim().split('\n')
    appendFileSync(join(dir, INDEX_NAME), 'not json\n')
    appendFileSync(join(dir, INDEX_NAME), '\n')
    appendFileSync(join(dir, INDEX_NAME), `${JSON.stringify({ fid: 't0000.s9', turn: 0, kind: 's' })}\n`)
    appendFileSync(join(dir, INDEX_NAME), `${JSON.stringify({ fid: 't0000.s9', turn: 1, kind: 's', index: 9 })}\n`)
    appendFileSync(join(dir, INDEX_NAME), `${JSON.stringify({ fid: 't0000.s9', turn: 0, kind: 's', index: 9 })}\n`)
    appendFileSync(join(dir, INDEX_NAME), '[1, 2]\n')
    appendFileSync(join(dir, INDEX_NAME), `${lines[0]}\n`) // duplicate of t0000.s0
    unlinkSync(join(dir, 't0001.s0.a1.npy'))
    const b = new FrameArchive(dir, { displayMax: 64 })
    expect(b.frames().map((e) => e.fid)).toEqual(['t0000.s0'])
    expect(b.loadWarnings).toEqual([
      expect.stringMatching(/^t0001\.s0: missing t0001\.s0\.a1\.npy; skipped$/),
      expect.stringMatching(/^index line 3 skipped: /),
      expect.stringMatching(/^index line 5 skipped: record lacks index$/),
      expect.stringMatching(/^index line 6 skipped: record t0000\.s9 disagrees/),
      expect.stringMatching(/^index line 7 skipped: record t0000\.s9 lacks channels/),
      expect.stringMatching(/^index line 8 skipped: record is not an object$/),
      'index line 9: duplicate t0000.s0; later record kept',
    ])
  })

  it('rejects an array file whose shape disagrees with its frame', () => {
    const root = tmp()
    const dir = join(root, 'frames')
    const a = new FrameArchive(dir, { displayMax: 64 })
    a.addScan(0, writeSxm(root, 's.sxm'))
    const other = new FrameArchive(join(root, 'other'), { displayMax: 64 })
    other.addPartial(0, { Z: [[1, 2, 3]] }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1 } })
    writeFileSync(join(dir, 't0000.s0.a0.npy'), readFileSync(join(other.root, 't0000.p0.a0.npy')))
    const b = new FrameArchive(dir, { displayMax: 64 })
    expect(() => b.array('t0000.s0', 'Z')).toThrow(/array file 0 is 1x3, the frame is 8x16/)
  })
})

describe('lookup', () => {
  it('explains unknown ids', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    expect(() => a.get('t0001.s0')).toThrow(/the archive is empty/)
    a.addScan(1, writeSxm(root, 's.sxm'))
    expect(() => a.get('t0001.s5')).toThrow(/turn 1 has \["t0001\.s0"\]/)
    expect(() => a.get('t0007.s0')).toThrow(/turns 0\.\.1 exist; latest frames: \["t0001\.s0"\]/)
    expect(() => a.get('scan7')).toThrow(/is not a frame id/)
    expect(a.has(' t0001.s0 ')).toBe(true)
    expect(a.has('t0001.s1')).toBe(false)
    expect(a.get(' t0001.s0').fid).toBe('t0001.s0')
  })

  it('summarizes frames compactly', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    a.addScan(0, writeSxm(root, 's.sxm'), { simS: 1.23456 })
    const [s] = a.index()
    expect(s).toMatchObject({
      fid: 't0000.s0', turn: 0, kind: 's', type: 'scan', source: 's.sxm', channels: ['Z', 'Current'],
      directions: ['forward', 'backward'], size_px: [16, 8], field_nm: [8, 4], centre_nm: [1, 2], angle_deg: 0,
      nm_per_px: 0.5, display_scale: '4', display_size: [64, 32], default_channel: 'Z', bias_v: -0.5,
      scan_dir: 'down', rec_time: '09.10.2026 12:00:00', sim_s: 1.235,
    })
    expect(s).not.toHaveProperty('rows_acquired')
  })

  it('returns copies of archived values and resolves channels', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    a.addScan(0, writeSxm(root, 's.sxm'))
    const z1 = a.array('t0000.s0')
    expect(z1.channel).toBe('Z')
    z1.data[0] = 99
    expect(a.array('t0000.s0').data[0]).toBe(0)
    expect(a.array('t0000.s0', 'current').channel).toBe('Current')
    expect(a.array('t0000.s0', 'height').channel).toBe('Z')
    expect(() => a.array('t0000.s0', 'Current', 'backward')).toThrow(/has no backward pass; it has \["forward"\]/)
    expect(() => a.array('t0000.s0', 'phase')).toThrow(/t0000\.s0: no channel "phase"/)
    expect(a.unitOf(a.get('t0000.s0'), 'Current')).toEqual({ factor: 1e12, unit: 'pA' })
  })

  it('evicts cached arrays beyond eight frames and reloads them from disk', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const p = writeSxm(root, 's.sxm')
    for (let t = 0; t < 10; t += 1) a.addScan(t, p)
    const first = a.array('t0000.s0', 'Z')
    expect([...first.data]).toEqual([...zFrame()])
  })
})

describe('rendering', () => {
  it('re-renders a region, records magnification and corners in nm', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    a.addScan(0, writeSxm(root, 's.sxm'))
    const r = a.render('t0000.s0', {
      region: { x: 16, y: 8, width: 16, height: 8 }, labelKind: 'inspection', labelAttrs: [['index', 1], ['count', 1], ['label', 'bump']],
    })
    expect(r.meta).toMatchObject({
      frame: 't0000.s0', kind: 'scan', channel: 'Z', direction: 'forward', flatten: 'plane',
      region_px: [16, 8, 16, 8], native_px: [4, 2, 8, 4], image_size: [64, 32], magnification: 4,
      image_px_per_scan_px: 16, nm_per_image_px: 0.03125, unit: 'pm',
      corners_nm: { top_left: [-1, 3], top_right: [1, 3], bottom_left: [-1, 2], bottom_right: [1, 2] },
    })
    expect(r.meta.label).toMatch(/^<visual kind="inspection" index="1" count="1" label="bump" frame="t0000\.s0" channel="Z" direction="forward" flatten="plane" scale="4" size="64x32" region="16,8,16,8" field_nm="2x1" magnification="4" z_range_pm="/)
    const img = decodePng(r.png)
    expect([img.width, img.height]).toEqual([64, 32])
    expect(entryScale(a.get('t0000.s0'))).toEqual({ num: 4, den: 1 })
  })

  it('labels highpass flattening with its width, other channels with their unit, missing rows with a count', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const z = zFrame().fill(Number.NaN, 96)
    a.addPartial(5, { Z: { rows: 8, cols: 16, data: z }, Current: { rows: 8, cols: 16, data: new Float32Array(128).fill(3e-12) } }, {
      geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 },
    })
    const hp = a.render('t0005.p0', { flatten: 'highpass', highpassNm: 1 })
    expect(hp.meta.flatten).toBe('highpass 1.00 nm')
    expect(hp.meta.label).toContain('rows_acquired="6/8"')
    const cur = a.render('t0005.p0', { channel: 'Current', flatten: 'none' })
    expect(cur.meta.unit).toBe('fA')
    expect(cur.meta.label).toContain('range_fA="3000.0..3000.0"')
    expect(cur.meta.value_range).toEqual([3000, 3000])
    expect(a.index()[0]).toMatchObject({ rows_acquired: '6/8', type: 'partial scan' })
  })

  it('reports an empty value range for a region that was never acquired', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const z = zFrame().fill(Number.NaN, 64)
    a.addPartial(0, { Z: { rows: 8, cols: 16, data: z } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 } })
    const r = a.render('t0000.p0', { region: { x: 0, y: 20, width: 64, height: 12 } })
    expect(r.meta.value_range).toEqual([null, null])
    const img = decodePng(r.png)
    expect([...img.data.subarray(0, 3)]).toEqual([24, 32, 104])
  })

  it('downsamples frames larger than the display', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const big = Float32Array.from({ length: 100 * 50 }, (_, i) => (i % 100) * 1e-12)
    const e = a.addPartial(0, { Z: { rows: 50, cols: 100, data: big } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 10, h_nm: 5 } })
    expect(e.display_scale).toBe(0.5)
    expect(e.display_size).toEqual([50, 25])
    expect(entryScale(e)).toEqual({ num: 1, den: 2 })
    const r = a.render(e.fid, { flatten: 'none' })
    expect(r.meta).toMatchObject({ image_size: [50, 25], image_px_per_scan_px: 0.5, nm_per_image_px: 0.2, magnification: 1 })
    expect(entrySummary(e)['display_scale']).toBe('1/2')
  })

  it('refuses bad render requests with ArchiveErrors', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    a.addScan(0, writeSxm(root, 's.sxm'))
    expect(() => a.render('t0000.s0', { region: { x: 60, y: 0, width: 8, height: 8 } })).toThrow(/leaves the frame's 64x32/)
    expect(() => a.render('t0000.s0', { flatten: 'tilt' as never })).toThrow(/flatten must be one of/)
    expect(() => a.render('t0000.s0', { channel: 'nope' })).toThrow(ArchiveError)
    expect(() => a.render('t0000.s0', { direction: 'backward', channel: 'Current' })).toThrow(/no backward pass/)
  })

  it('uses the first direction a backward-only default channel has', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const e = a.addScanBytes(0, sxm({ channels: [{ name: 'Z', unit: 'm', backward: zFrame() }] }), { sourceName: 'b.sxm' })
    expect(e.directions).toEqual(['backward'])
    expect(a.observation(e.fid).label).toContain('direction="backward"')
  })
})

describe('derived images', () => {
  function testPng(w: number, h: number): Uint8Array {
    return encodePngRgb(w, h, Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * 7) & 0xff))
  }

  it('archives a plain image and crops it on request', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const e = a.addDerived(4, testPng(10, 6), { tool: 'stm_fft_peaks', sources: ['t0003.s0'], description: 'log magnitude', labelAttrs: [['peaks', 3]] })
    expect(e).toMatchObject({ fid: 't0004.m0', kind: 'm', nx: 10, ny: 6, display_size: [10, 6], geometry: null, channels: [] })
    expect(hasValues(e)).toBe(false)
    expect(a.observation(e.fid).label).toBe('<visual kind="derived" frame="t0004.m0" derived="stm_fft_peaks" source="t0003.s0" peaks="3" size="10x6"/>')
    const whole = a.render(e.fid)
    expect(whole.meta.label.startsWith('<visual kind="derived"')).toBe(true)
    expect(whole.meta.magnification).toBe(1)
    const cut = a.render(e.fid, { region: { x: 2, y: 1, width: 4, height: 2 }, labelKind: 'inspection' })
    expect(cut.meta).toMatchObject({ region_px: [2, 1, 4, 2], image_size: [64, 32], magnification: 16 })
    expect(cut.meta.label).toContain('kind="inspection"')
    expect(cut.meta.label).toContain('size="64x32"')
    const img = decodePng(cut.png)
    const src = decodePng(testPng(10, 6))
    expect([...img.data.subarray(0, 3)]).toEqual([...src.data.subarray((1 * 10 + 2) * 3, (1 * 10 + 2) * 3 + 3)])
    expect(() => a.render(e.fid, { region: { x: 8, y: 0, width: 4, height: 2 } })).toThrow(/leaves the 10x6 derived image/)
    expect(() => a.array(e.fid)).toThrow(/without archived values/)
    expect(entrySummary(e)).toMatchObject({ tool: 'stm_fft_peaks', sources: ['t0003.s0'], description: 'log magnitude', image_size: [10, 6] })
  })

  it('keeps the values behind a derived map readable', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const e = a.addDerived(1, testPng(16, 8), {
      tool: 'stm_frame_diff',
      arrays: { 'diff/forward': { rows: 8, cols: 16, data: zFrame() } },
      geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 },
      units: { diff: 'm' },
    })
    expect(hasValues(e)).toBe(true)
    expect(e.channels).toEqual(['diff'])
    expect(a.array(e.fid).unit).toBe('m')
    expect(entrySummary(e)['channels']).toEqual(['diff'])
    const reopened = new FrameArchive(a.root, { displayMax: 64 })
    expect([...reopened.array(e.fid, 'diff').data]).toEqual([...zFrame()])
  })

  it('refuses a broken PNG or values without geometry', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    expect(() => a.addDerived(0, new Uint8Array(10), { tool: 'x' })).toThrow(/PNG/)
    expect(() => a.addDerived(0, testPng(2, 2), { tool: 'x', arrays: { d: [[1]] } })).toThrow(/needs its geometry/)
    expect(() => a.addDerived(0, testPng(2, 2), { tool: 'x', arrays: {}, geometry: { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1 } })).toThrow(/no arrays/)
  })
})

describe('edges of the lookup and summary', () => {
  it('summarizes feedback and setpoint when the file has them', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const e = a.addScanBytes(0, sxm({ feedbackOn: true, setpointA: 1.23456e-10 }), { sourceName: 'fb.sxm' })
    expect(entrySummary(e)).toMatchObject({ feedback: 'ON', setpoint_a: 1.235e-10 })
  })

  it('refuses to render a spectrum record and to resolve channels of a plain image', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    writeFileSync(join(a.root, 't0000.d0.png'), encodePngRgb(1, 1, new Uint8Array(3)))
    appendFileSync(
      join(a.root, INDEX_NAME),
      `${JSON.stringify({ fid: 't0000.d0', turn: 0, kind: 'd', index: 0, source_name: '', channels: ['Bias (V)'], directions: [], nx: 1, ny: 1, geometry: null, nm_per_px: null, display_scale: 1, display_size: [0, 0], bias_v: null, setpoint_a: null, scan_dir: null, acquired_rows: null, rec_time: '', sim_s: null, units: {}, default_channel: 'Bias (V)', extra: {} })}\n`,
    )
    const b = new FrameArchive(a.root, { displayMax: 64 })
    expect(() => b.render('t0000.d0')).toThrow(/is a spectrum; spectra are not rendered/)
    expect(entrySummary(b.get('t0000.d0'))).toMatchObject({ type: 'spectrum', tool: null, image_size: [0, 0] })
    const m = b.addDerived(0, encodePngRgb(2, 2, new Uint8Array(12)), { tool: 'x' })
    expect(() => b.resolveChannel(m)).toThrow(/derived image without channels/)
    expect(b.has(undefined as never)).toBe(false)
    expect(() => b.get(null as never)).toThrow(/is not a frame id/)
  })
})

describe('attribute merging', () => {
  it('behaves like dict.update: replace in place, append new keys', () => {
    expect(mergeAttrs([['a', 1], ['b', 2]], [['b', 3], ['c', 4]])).toEqual([['a', 1], ['b', 3], ['c', 4]])
  })
})
