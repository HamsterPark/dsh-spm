import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveError, channelDirections, entryFromRecord, entryScale, entrySummary, FrameArchive, hasValues, INDEX_NAME, mergeAttrs } from './archive.js'
import { encodePngRgb, decodePng } from './png.js'
import { loadDat } from './spectrum.js'
import { encodeSyntheticDat } from './synthetic-dat.js'
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
      't0000.s9: missing t0000.s9.png; skipped', // an index line needs only fid, turn, kind and index
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
    expect(() => a.get('t0001.s5')).toThrow(/turn 1 has \['t0001\.s0'\]/)
    expect(() => a.get('t0007.s0')).toThrow(/turns 0\.\.1 exist; latest frames: \['t0001\.s0'\]/)
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
      frame: 't0000.s0', turn: 0, kind: 'scan', source: 's.sxm', channels: ['Z', 'Current'],
      directions: ['forward', 'backward'], size_px: [16, 8], field_nm: [8, 4], center_nm: [1, 2], angle_deg: 0,
      nm_per_px: 0.5, display_scale: 4, display_size_px: [64, 32], default_channel: 'Z', bias_v: -0.5,
      scan_dir: 'down', rec_time: '09.10.2026 12:00:00', sim_s: 1.235,
    })
    expect(s).not.toHaveProperty('rows_acquired')
    expect(s).not.toHaveProperty('display_scale_frac')
    for (const k of ['fid', 'type', 'unit', 'centre_nm', 'display_size']) expect(s).not.toHaveProperty(k)
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
    expect(() => a.array('t0000.s0', 'Current', 'backward')).toThrow(/has no backward pass; it has \['forward'\]/)
    expect(() => a.array('t0000.s0', 'phase')).toThrow(/^no channel 'phase'; this frame has \['Z', 'Current'\]$/)
    // Current 100..227 pA: robust span 125.7 pA → 1 decimal
    expect(a.fmt(a.get('t0000.s0'), 'Current')).toEqual({ factor: 1e12, unit: 'pA', decimals: 1 })
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
      region_px: [16, 8, 16, 8], native_px: [4, 2, 8, 4], image_size_px: [64, 32], magnification: 4,
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
    expect(hp.meta.flatten).toBe('highpass')
    expect(hp.meta.highpass_nm).toBe(1)
    expect(hp.meta.label).toContain('flatten="highpass" highpass_nm="1" scale=')
    expect(hp.meta.label).toContain('rows_acquired="6/8"')
    const cur = a.render('t0005.p0', { channel: 'Current', flatten: 'none' })
    expect(cur.meta.unit).toBe('pA')
    expect(cur.meta.label).toContain('range_pa="3.0..3.0"')
    expect([cur.meta.min, cur.meta.max, cur.meta.black, cur.meta.white]).toEqual([3, 3, 3, 3])
    expect(a.index()[0]).toMatchObject({ rows_acquired: 6, rows_total: 8, kind: 'partial' })
  })

  it('reports an empty value range for a region that was never acquired', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const z = zFrame().fill(Number.NaN, 64)
    a.addPartial(0, { Z: { rows: 8, cols: 16, data: z } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 } })
    const r = a.render('t0000.p0', { region: { x: 0, y: 20, width: 64, height: 12 } })
    expect([r.meta.min, r.meta.max]).toEqual([null, null])
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
    expect(r.meta).toMatchObject({ image_size_px: [50, 25], image_px_per_scan_px: 0.5, nm_per_image_px: 0.2, magnification: 1 })
    expect(entrySummary(e)).toMatchObject({ display_scale: 0.5, display_scale_frac: '1/2', display_size_px: [50, 25] })
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
    expect(a.observation(e.fid).label).toBe('<visual kind="derived" frame="t0004.m0" derived="stm_fft_peaks" frames="t0003.s0" peaks="3" size="10x6"/>')
    const whole = a.render(e.fid)
    expect(whole.meta.label.startsWith('<visual kind="derived"')).toBe(true)
    expect(whole.meta.magnification).toBe(1)
    const cut = a.render(e.fid, { region: { x: 2, y: 1, width: 4, height: 2 }, labelKind: 'inspection' })
    expect(cut.meta).toMatchObject({ kind: 'derived', region_px: [2, 1, 4, 2], image_size_px: [64, 32], magnification: 16 })
    expect(cut.meta.label).toContain('kind="inspection"')
    expect(cut.meta.label).toContain('size="64x32"')
    const img = decodePng(cut.png)
    const src = decodePng(testPng(10, 6))
    expect([...img.data.subarray(0, 3)]).toEqual([...src.data.subarray((1 * 10 + 2) * 3, (1 * 10 + 2) * 3 + 3)])
    expect(() => a.render(e.fid, { region: { x: 8, y: 0, width: 4, height: 2 } })).toThrow(/leaves the 10x6 derived image/)
    expect(() => a.array(e.fid)).toThrow(/without archived values/)
    expect(entrySummary(e)).toEqual({
      frame: 't0004.m0', turn: 4, kind: 'derived', tool: 'stm_fft_peaks', frames: ['t0003.s0'], description: 'log magnitude', image_size_px: [10, 6],
    })
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
    expect(entrySummary(e)).toMatchObject({ feedback: 'ON', setpoint_pa: 123.456 })
    expect(entrySummary(e)).not.toHaveProperty('setpoint_a')
  })

  it('refuses to render a spectrum record without values and to resolve channels of a plain image', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    writeFileSync(join(a.root, 't0000.d0.png'), encodePngRgb(1, 1, new Uint8Array(3)))
    appendFileSync(
      join(a.root, INDEX_NAME),
      `${JSON.stringify({ fid: 't0000.d0', turn: 0, kind: 'd', index: 0, source_name: '', channels: ['Bias (V)'], directions: [], nx: 1, ny: 1, geometry: null, nm_per_px: null, display_scale: 1, display_size: [0, 0], bias_v: null, setpoint_a: null, scan_dir: null, acquired_rows: null, rec_time: '', sim_s: null, units: {}, default_channel: 'Bias (V)', extra: {} })}\n`,
    )
    const b = new FrameArchive(a.root, { displayMax: 64 })
    expect(() => b.render('t0000.d0')).toThrow(/^t0000\.d0 is a spectrum without archived values$/)
    expect(entrySummary(b.get('t0000.d0'))).toEqual({ frame: 't0000.d0', turn: 0, kind: 'spectrum', source: '', columns: ['Bias (V)'], n_points: 1 })
    const m = b.addDerived(0, encodePngRgb(2, 2, new Uint8Array(12)), { tool: 'x' })
    expect(() => b.resolveChannel(m)).toThrow(/derived image without channels/)
    expect(b.has(undefined as never)).toBe(false)
    expect(() => b.get(null as never)).toThrow(/is not a frame id/)
  })

  it('falls back sensibly when an index line lacks the optional extras', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const e = a.addScanBytes(0, sxm({ setpointA: 2e-10 }), { sourceName: 's.sxm' })
    const want = a.fmt(e, 'Current')
    const wantLabel = a.render(e.fid).meta.label
    a.addDerived(0, encodePngRgb(4, 2, new Uint8Array(24)), { tool: 'stm_fft_peaks', sources: [e.fid] })
    // What an older or hand-written index line may lack.
    type Rec = Record<string, unknown> & { extra: Record<string, unknown> }
    const [scan, derived] = readFileSync(a.indexPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec) as [Rec, Rec]
    scan['nm_per_px'] = null
    for (const k of ['span', 'nm_per_px_y', 'setpoint_unit', 'channel_directions']) delete scan.extra[k]
    derived.extra = {}
    const noGeometry = { ...scan, fid: 't0000.s1', index: 1, geometry: null }
    writeFileSync(a.indexPath, `${[scan, derived, noGeometry].map((l) => JSON.stringify(l)).join('\n')}\n`)
    for (const f of ['png', 'a0.npy', 'a1.npy', 'a2.npy']) copyFileSync(join(a.root, `t0000.s0.${f}`), join(a.root, `t0000.s1.${f}`))

    const b = new FrameArchive(a.root, { displayMax: 64 })
    expect(b.loadWarnings).toEqual([])
    const s = b.get('t0000.s0')
    expect(b.fmt(s, 'Current')).toEqual(want) // span recomputed from the archived arrays
    expect(b.fmt(s, 'Mystery')).toEqual({ factor: 1, unit: '', decimals: 1 })
    expect(b.render('t0000.s0').meta.label).toBe(wantLabel) // nm per pixel from the geometry
    expect(entrySummary(s)).toMatchObject({ nm_per_px: null, setpoint_pa: 200 })
    expect(channelDirections(s, 'Current')).toEqual(['forward', 'backward'])
    expect(hasValues({ ...s, extra: {} })).toBe(false)
    expect(() => b.values({ ...s, fid: 't0009.s0', extra: {} }, 'Z')).toThrow(/scan without archived values/)
    expect(() => b.render('t0000.s1')).toThrow(/has no scan geometry/)
    const m = b.get('t0000.m0')
    expect(entrySummary(m)).toEqual({ frame: 't0000.m0', turn: 0, kind: 'derived', tool: null, image_size_px: [4, 2] })
    expect(b.observation('t0000.m0').label).toBe('<visual kind="derived"/>')
    expect(b.render('t0000.m0').meta).toMatchObject({ tool: null, label: '<visual kind="derived" frame="t0000.m0" size="4x2"/>' })
  })

  it('reads index records like the reference: defaults for what is missing, refusal of malformed fields', () => {
    const sts = entryFromRecord({
      fid: 't0005.d0', turn: 5, kind: 'd', index: 0, channels: ['Bias (V)'], nx: 64, geometry: {},
      extra: { position_nm: [1.234567, -2.5], experiment: 'bias spectroscopy' },
    })
    expect(sts).toMatchObject({ source_name: '', directions: [], geometry: null, display_scale: 1, rec_time: '', units: {} })
    expect(entrySummary(sts)).toEqual({
      frame: 't0005.d0', turn: 5, kind: 'spectrum', source: '', columns: ['Bias (V)'], n_points: 64,
      position_nm: [1.2346, -2.5], experiment: 'bias spectroscopy',
    })
    // Empty text and empty lists count as absent, as in Python.
    const bare = entryFromRecord({ fid: 't0005.d1', turn: 5, kind: 'd', index: 1, rec_time: null, extra: { position_nm: [], experiment: '' } })
    expect(entrySummary(bare)).toEqual({ frame: 't0005.d1', turn: 5, kind: 'spectrum', source: '', columns: [], n_points: 0 })
    // A scan record without geometry still summarizes, with nulls where the geometry would be.
    const scan = entryFromRecord({ fid: 't0006.s0', turn: 6, kind: 's', index: 0, scan_dir: '', feedback: 'ON' })
    expect(entrySummary(scan)).toEqual({
      frame: 't0006.s0', turn: 6, kind: 'scan', source: '', channels: [], directions: [], size_px: [0, 0],
      field_nm: [null, null], center_nm: [null, null], angle_deg: null, nm_per_px: null, display_scale: 1,
      display_size_px: [0, 0], default_channel: null,
    })
    expect(() => entryFromRecord({ fid: 't0005.d2', turn: 5, kind: 'd', index: 2, channels: 'Bias' })).toThrow(/malformed channels$/)
    expect(() => entryFromRecord({ fid: 't0005.d2', turn: 5, kind: 'd', index: 2, units: 3, extra: [] })).toThrow(/malformed units, extra$/)
  })
})

/** The reference's test spectrum (`tests/test_frames.write_dat`): 21 points from -0.5 to 0.5 V, three columns. */
function stsDat(extra: readonly (readonly [string, number[]])[] = []): Uint8Array {
  const v = Array.from({ length: 21 }, (_, i) => -0.5 + i / 20)
  return encodeSyntheticDat({
    header: {
      Experiment: 'bias spectroscopy', 'X (m)': 1.25e-9, 'Y (m)': -2e-9, 'Bias>Bias (V)': 0.5, 'Z-Controller>Setpoint': 1e-10,
    },
    columns: [['Bias calc (V)', v], ['Current (A)', v.map((x) => x * 2e-10)], ['LI Demod 1 X (A)', v.map((x) => 1e-12 + 1e-13 * x)], ...extra],
  })
}

const STS_COLUMNS = ['Bias calc (V)', 'Current (A)', 'LI Demod 1 X (A)']

describe('spectra', () => {
  it('keep a copy of the file, every column as float64 and the default plot, like the reference', () => {
    const root = tmp()
    const path = join(root, 's.dat')
    writeFileSync(path, stsDat())
    const a = new FrameArchive(join(root, 'arch'), { displayMax: 64 })
    a.addScan(2, writeSxm(root, 'f.sxm'))
    const d = a.addSpectrum(2, path, { simS: 3 })
    expect(d).toMatchObject({
      fid: 't0002.d0', turn: 2, kind: 'd', index: 0, source_name: 's.dat', channels: STS_COLUMNS, directions: [], nx: 21, ny: 1,
      geometry: null, nm_per_px: null, display_scale: 1, display_size: [600, 600], bias_v: 0.5, setpoint_a: 1e-10, scan_dir: null,
      acquired_rows: null, rec_time: '', sim_s: 3, units: { 'Bias calc (V)': 'V', 'Current (A)': 'A', 'LI Demod 1 X (A)': 'A' },
      default_channel: 'Current (A)',
    })
    expect(d.extra).toMatchObject({ array_keys: STS_COLUMNS, experiment: 'bias spectroscopy', setpoint_unit: 'A', source_path: path })
    expect(d.extra.render?.image_size).toEqual([600, 600])
    expect(readFileSync(join(a.root, 't0002.d0.dat')).equals(readFileSync(path))).toBe(true)
    for (const f of ['t0002.d0.a0.npy', 't0002.d0.a1.npy', 't0002.d0.a2.npy', 't0002.d0.png']) expect(existsSync(join(a.root, f))).toBe(true)
    expect(entrySummary(d)).toEqual({
      frame: 't0002.d0', turn: 2, kind: 'spectrum', source: 's.dat', columns: STS_COLUMNS, n_points: 21, position_nm: [1.25, -2],
      experiment: 'bias spectroscopy', bias_v: 0.5, setpoint_pa: 100, sim_s: 3,
    })
    const obs = a.observation(d.fid)
    expect(obs.label).toBe('<visual kind="current" frame="t0002.d0" plot="spectrum" x="Bias calc [V]" y="Current [pA]; LI Demod 1 X [pA]" points="21" size="600x600"/>')
    const img = decodePng(obs.png)
    expect([img.width, img.height, img.channels]).toEqual([600, 600, 3])
    // Re-rendered from the archived columns: one y column, an x range.
    const r = a.render(d.fid, { yCol: 'Current', xRange: [-0.1, 0.1], labelKind: 'inspection', labelAttrs: [['index', 1]] })
    expect(r.meta).toMatchObject({
      frame: 't0002.d0', kind: 'spectrum', x_col: 'Bias calc (V)', x_unit: 'V', y: [{ column: 'Current (A)', unit: 'pA' }], n_points: 5,
      x_shown: [-0.1, 0.1], region_px: [0, 0, 600, 390], image_size_px: [600, 390], magnification: 1,
    })
    expect(r.meta.label).toBe('<visual kind="inspection" index="1" frame="t0002.d0" plot="spectrum" x="Bias calc [V]" y="Current [pA]" points="5" size="600x390" x_range="-0.1..0.1"/>')
    expect(a.render(d.fid, { xCol: 'current', yCol: ['bias calc', 'LI Demod 1 X'], displayMax: 800 }).meta).toMatchObject({
      x_col: 'Current (A)', x_unit: 'pA', y: [{ column: 'Bias calc (V)', unit: 'V' }, { column: 'LI Demod 1 X (A)', unit: 'pA' }],
      n_points: 21, x_shown: [-100, 100], image_size_px: [800, 690],
    })
    expect(() => a.render(d.fid, { region: { x: 0, y: 0, width: 5, height: 5 } })).toThrow(/^t0002\.d0 is a spectrum: use x_range instead of region$/)
    expect(() => a.render(d.fid, { xRange: [900, 1000] })).toThrow(/^x_range 900\.0\.\.1000\.0 V contains no samples \(x spans -0\.5\.\.0\.5 V\)$/)
    expect(() => a.render(d.fid, { yCol: 'Phase' })).toThrow(/^no channel 'Phase'; this frame has \['Bias calc \(V\)', 'Current \(A\)', 'LI Demod 1 X \(A\)'\]$/)
    // Re-opened: the same record, the columns bit for bit.
    const b = new FrameArchive(a.root, { displayMax: 64 })
    expect(b.loadWarnings).toEqual([])
    expect(b.frames().map((e) => e.fid)).toEqual(['t0002.s0', 't0002.d0'])
    expect(b.get(d.fid)).toEqual(d)
    const want = loadDat(stsDat(), 's.dat').columns
    for (const c of STS_COLUMNS) expect([...b.column(b.get(d.fid), c)]).toEqual([...(want.get(c) as Float64Array)])
    expect(b.addSpectrumBytes(2, stsDat(), { sourceName: 'again.dat' }).fid).toBe('t0002.d1')
  })

  it('report each column in its model unit with decimals from its span, and resolve column names like channels', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const d = a.addSpectrumBytes(0, stsDat(), { sourceName: 's.dat' })
    expect(a.fmt(d, 'Bias calc (V)')).toEqual({ factor: 1, unit: 'V', decimals: 3 }) // span 0.99 V
    expect(a.fmt(d, 'Current (A)')).toEqual({ factor: 1e12, unit: 'pA', decimals: 1 }) // span 198 pA
    expect(a.fmt(d, 'Mystery')).toEqual({ factor: 1, unit: '', decimals: 1 })
    expect(a.resolveColumn(d, 'current')).toBe('Current (A)')
    expect(a.resolveColumn(d, 'It')).toBe('Current (A)')
    expect(() => a.resolveColumn(d, '')).toThrow(/^no channel ''; this frame has/)
    expect(() => a.column(d, 'Current')).toThrow(/^t0000\.d0 has no column 'Current'; it has \['Bias calc \(V\)', /)
    expect(() => a.array(d.fid)).toThrow(/^t0000\.d0 is a spectrum; read its columns with column\(\)$/)
    expect(() => a.values(d, 'Current (A)')).toThrow(/^t0000\.d0 is a spectrum; its values are columns$/)
    const s = a.addScan(0, writeSxm(root, 's.sxm'))
    expect(() => a.column(s, 'Z')).toThrow(/^t0000\.s0 is a scan, not a spectrum$/)
  })

  it('plot up to the first 4 columns other than x by default, or x itself when it is the only column', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 768 })
    const ramp = Array.from({ length: 21 }, (_, i) => i * 1e-12)
    const wide = a.addSpectrumBytes(0, stsDat([['LI Demod 1 Y (A)', ramp], ['Current [bwd] (A)', ramp], ['Z (m)', ramp]]), { sourceName: 'w.dat' })
    expect(a.render(wide.fid).meta.y?.map((c) => c.column)).toEqual(['Current (A)', 'LI Demod 1 X (A)', 'LI Demod 1 Y (A)', 'Current [bwd] (A)'])
    expect(wide.display_size).toEqual([768, 768])
    expect(a.observation(wide.fid).label).toContain('y="Current [pA]; LI Demod 1 X [pA]; LI Demod 1 Y [pA]; Current [bwd] [pA]" points="21" size="768x768"')
    const one = a.addSpectrumBytes(0, encodeSyntheticDat({ columns: [['Index', [1, 2, 3]]] }), { sourceName: 'one.dat' })
    expect(one).toMatchObject({ channels: ['Index'], default_channel: 'Index', nx: 3, display_size: [768, 390] })
    expect(a.observation(one.fid).label).toBe('<visual kind="current" frame="t0000.d1" plot="spectrum" x="Index []" y="Index []" points="3" size="768x390"/>')
    expect(entrySummary(one)).toEqual({ frame: 't0000.d1', turn: 0, kind: 'spectrum', source: 'one.dat', columns: ['Index'], n_points: 3 })
  })

  it('refuse missing or empty files, and arrays that disagree with the record', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    expect(() => a.addSpectrum(0, join(root, 'nope.dat'))).toThrow(/^no such \.dat file: /)
    expect(() => a.addSpectrumBytes(0, new TextEncoder().encode('Experiment\tx\t\n'), { sourceName: 'e.dat' })).toThrow(ArchiveError)
    expect(() => a.addSpectrumBytes(0, new TextEncoder().encode('Experiment\tx\t\n'), { sourceName: 'e.dat' })).toThrow(/^e\.dat: no data columns$/)
    expect(a.frames()).toEqual([])
    a.addSpectrumBytes(0, stsDat(), { sourceName: 's.dat' })
    const other = new FrameArchive(join(root, 'other'), { displayMax: 64 })
    other.addSpectrumBytes(0, encodeSyntheticDat({ columns: [['A (V)', [1, 2]]] }), { sourceName: 'o.dat' })
    writeFileSync(join(a.root, 't0000.d0.a1.npy'), readFileSync(join(other.root, 't0000.d0.a0.npy')))
    const b = new FrameArchive(a.root, { displayMax: 64 })
    expect(() => b.render('t0000.d0')).toThrow(/^t0000\.d0: array file 1 is 2, the spectrum has 21 points$/)
    unlinkSync(join(a.root, 't0000.d0.a2.npy'))
    expect(new FrameArchive(a.root, { displayMax: 64 }).loadWarnings).toEqual(['t0000.d0: missing t0000.d0.a2.npy; skipped'])
  })

  it('recompute a span the record lacks from the archived columns, and reload evicted columns from disk', () => {
    const root = tmp()
    const a = new FrameArchive(join(root, 'f'), { displayMax: 64 })
    const d = a.addSpectrumBytes(0, stsDat(), { sourceName: 's.dat' })
    const rec = JSON.parse(readFileSync(a.indexPath, 'utf8').trim()) as Record<string, unknown> & { extra: Record<string, unknown> }
    delete rec.extra['span']
    writeFileSync(a.indexPath, `${JSON.stringify(rec)}\n`)
    const b = new FrameArchive(a.root, { displayMax: 64 })
    expect(b.fmt(b.get(d.fid), 'Current (A)')).toEqual(a.fmt(d, 'Current (A)'))
    for (let t = 1; t < 10; t += 1) b.addSpectrumBytes(t, stsDat(), { sourceName: 's.dat' })
    expect([...b.column(b.get(d.fid), 'Bias calc (V)')]).toEqual([...a.column(d, 'Bias calc (V)')])
  })
})

describe('attribute merging', () => {
  it('behaves like dict.update: replace in place, append new keys', () => {
    expect(mergeAttrs([['a', 1], ['b', 2]], [['b', 3], ['c', 4]])).toEqual([['a', 1], ['b', 3], ['c', 4]])
  })
})
