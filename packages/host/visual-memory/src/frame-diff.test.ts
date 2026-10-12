/**
 * `stm_frame_diff` on synthetic frames with known answers (the reference's
 * `tests/test_measure.py` diff tests, ported): a known sub-pixel shift is
 * recovered on plain and rotated frames and something new in b is reported as
 * a changed region; frames of different geometry are resampled; identical
 * frames show no change; the difference is archived with its values so
 * `read_values` and `inspect` work on it; every refusal says what to change;
 * and the tool answers through a real dsh dispatcher with its image.
 *
 * The surfaces are sums of cosines defined in scan-frame nm, so a shifted
 * frame is sampled exactly, not interpolated.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef } from 'dsh-spm-compat'
import { afterEach, describe, expect, it } from 'vitest'
import { FrameArchive, INDEX_NAME } from './archive.js'
import { bandpass, clipPolygon, divergingRgb, frameDiff, lowpass, MAX_REGIONS, sameGeometry } from './frame-diff.js'
import { nativeToScanNm, type ScanGeometry } from './geometry.js'
import { nelderMead } from './nelder-mead.js'
import { mirrorIndex, shiftConstant, splineFilter3 } from './ndinterp.js'
import { decodePng, encodePngRgb, pngSize, toRgb } from './png.js'
import * as plugin from './plugin.js'
import { corrLength, nccSurface, register } from './register.js'
import { inspect, readValues } from './views.js'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.registry.delete(plugin)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vm-diff-'))
  dirs.push(d)
  return d
}

/** A seeded uniform generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Surface = (X: number, Y: number) => number

/** A broadband texture: 160 cosines, wavelengths 0.4..3 nm, a few pm high. */
function texture(seed: number): Surface {
  const r = rng(seed)
  const waves = Array.from({ length: 160 }, () => {
    const lambda = 0.4 + 2.6 * r()
    const theta = 2 * Math.PI * r()
    return { kx: (2 * Math.PI * Math.cos(theta)) / lambda, ky: (2 * Math.PI * Math.sin(theta)) / lambda, phi: 2 * Math.PI * r(), amp: 1e-12 * (0.5 + r()) }
  })
  return (X, Y) => waves.reduce((s, w) => s + w.amp * Math.cos(w.kx * X + w.ky * Y + w.phi), 0)
}

function geom(nx = 96, ny = 96, w = 9.6, h = 9.6, cx = 0, cy = 0, angle = 0): ScanGeometry {
  return { cx_nm: cx, cy_nm: cy, w_nm: w, h_nm: h, angle_deg: angle, nx, ny }
}

/** The surface sampled at the pixel centres of a frame. */
function sample(g: ScanGeometry, f: Surface): { rows: number; cols: number; data: Float64Array } {
  const data = new Float64Array(g.nx * g.ny)
  for (let r = 0; r < g.ny; r += 1) {
    for (let c = 0; c < g.nx; c += 1) data[r * g.nx + c] = f(...nativeToScanNm(g, c + 0.5, r + 0.5))
  }
  return { rows: g.ny, cols: g.nx, data }
}

function add(archive: FrameArchive, turn: number, g: ScanGeometry, f: Surface, more: Record<string, Surface> = {}): string {
  const arrays: Record<string, { rows: number; cols: number; data: Float64Array }> = { Z: sample(g, f) }
  for (const [k, s] of Object.entries(more)) arrays[k] = sample(g, s)
  return archive.addPartial(turn, arrays, { geometry: g }).fid
}

function ok(r: ReturnType<typeof frameDiff>): Record<string, any> {
  if (!r.ok) throw new Error(r.error)
  return r.reply as Record<string, any>
}

function err(r: ReturnType<typeof frameDiff>): string {
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}

/** Image pixels in the colour of the region marks, as [x, y]. */
function markPixels(png: Uint8Array): [number, number][] {
  const im = decodePng(png)
  const rgb = toRgb(im)
  const out: [number, number][] = []
  for (let i = 0; i < im.width * im.height; i += 1) {
    if (rgb[i * 3] === 20 && rgb[i * 3 + 1] === 20 && rgb[i * 3 + 2] === 20) out.push([i % im.width, Math.floor(i / im.width)])
  }
  return out
}

const bump = (x0: number, y0: number, sig: number, amp: number): Surface => (X, Y) => amp * Math.exp(-((X - x0) ** 2 + (Y - y0) ** 2) / (2 * sig * sig))

describe('frameDiff: registration and change', () => {
  for (const angle of [0, 25]) {
    it(`recovers a known sub-pixel shift and finds what is new in b (frame at ${angle} deg)`, () => {
      const archive = new FrameArchive(tmp())
      const g = geom(96, 96, 9.6, 9.6, 1.5, -2, angle)
      const tex = texture(1)
      const shift = [0.137, -0.262] // nm, scan frame: the surface moved by this
      const [bx, by] = nativeToScanNm(g, 70.5, 25.5)
      const fa = add(archive, 0, g, tex)
      const fb = add(archive, 1, g, (X, Y) => tex(X - (shift[0] as number), Y - (shift[1] as number)) + bump(bx, by, 0.2, 30e-12)(X, Y))
      const r = frameDiff(archive, { frame_a: fa, frame_b: fb })
      const body = ok(r)
      const reg = body['registration']
      // A 96-px frame: within about 0.1 px, as the reference does on frames this size.
      expect(Math.abs(reg.shift_nm[0] - (shift[0] as number))).toBeLessThan(0.015)
      expect(Math.abs(reg.shift_nm[1] - (shift[1] as number))).toBeLessThan(0.015)
      expect(reg.confidence).toBeGreaterThan(1.5)
      expect(reg.ncc_peak).toBeGreaterThan(0.95)
      expect(body['same_geometry']).toBe(true)
      expect(body['flatten']).toBe('highpass')
      expect(body['highpass_nm']).toBe(3)
      const regions = body['difference'].regions
      expect(regions[0].sign).toBe('+')
      expect(Math.hypot(regions[0].x_nm - bx, regions[0].y_nm - by)).toBeLessThan(0.3)
      expect(regions[0].peak_change_pm).toBeGreaterThan(15)
      expect(Object.keys(body['difference'])).toEqual(['frame', 'offset_removed_pm', 'plane_removed', 'noise_pm', 'threshold_pm', 'n_regions', 'regions'])
      expect(Object.keys(regions[0])).toEqual(['sign', 'x_nm', 'y_nm', 'area_nm2', 'peak_change_pm', 'id'])
      // The difference is a derived frame with values: read_values and inspect work on it.
      const dfid = body['difference'].frame as string
      expect(dfid).toBe('t0001.m0')
      const de = archive.get(dfid)
      expect(de.channels).toEqual(['diff'])
      expect(de.units).toEqual({ diff: 'm' })
      expect(Array.from(archive.array(dfid, 'diff').data).filter(Number.isFinite).length).toBeGreaterThan(1000)
      if (!r.ok) throw new Error(r.error)
      expect(r.images).toHaveLength(1)
      expect(r.images[0]?.label).toContain('derived="diff"')
      expect(r.images[0]?.label).toContain(`frames="${fa},${fb}"`)
      expect(r.images[0]?.label).toMatch(/color="red \+, blue -, white 0, full color at \+-[0-9.]+ pm"/)
      expect(pngSize(r.images[0]?.png as Uint8Array)).toEqual({ width: 768, height: 768 })
      // The region is numbered on the image with a dark ring (a colour the map itself never takes).
      expect(r.images[0]?.label).toContain(`marks="${regions.length} numbered regions"`)
      const marked = markPixels(r.images[0]?.png as Uint8Array)
      expect(marked.length).toBeGreaterThan(20)
      expect(marked.some(([x, y]) => Math.hypot(x - 70.5 * 8, y - 25.5 * 8) < 80)).toBe(true)
      const read = readValues(archive, { question: 'q', views: [{ label: 'd', frame: dfid, rows: 2, columns: 2 }] })
      if (!read.ok) throw new Error(read.error)
      expect((read.reply['views'] as Record<string, unknown>[])[0]).toHaveProperty('values_pm')
      const shown = inspect(archive, { question: 'q', views: [{ label: 'd', frame: dfid, region: { x: 0, y: 0, width: 64, height: 64 } }] })
      expect(shown.ok).toBe(true)
    })
  }

  it('survives steps, a creep bow that changes and a large shift, with the default highpass', () => {
    const archive = new FrameArchive(tmp())
    const g = geom()
    const r = rng(7)
    const atoms = Array.from({ length: 18 }, () => [16 * r() - 8, 16 * r() - 8] as const)
    const terrace: Surface = (X, Y) =>
      60e-12 * (0.5 + 0.5 * Math.tanh((X + 0.3 * Y - 1.5) / 0.3)) + atoms.reduce((s, [ax, ay]) => s + bump(ax, ay, 0.3, 60e-12)(X, Y), 0)
    const bowA: Surface = (X, Y) => 4e-12 * (X * X + 0.5 * Y * Y)
    const bowB: Surface = (X, Y) => 2.5e-12 * (0.3 * X * X + Y * Y) + 4e-12 * (X + Y)
    const shift = [2.6, -0.4]
    const fa = add(archive, 0, g, (X, Y) => terrace(X, Y) + bowA(X, Y))
    const fb = add(archive, 1, g, (X, Y) => terrace(X - (shift[0] as number), Y - (shift[1] as number)) + bowB(X, Y))
    const body = ok(frameDiff(archive, { frame_a: fa, frame_b: fb }))
    expect(body['registration'].shift_nm[0]).toBeCloseTo(shift[0] as number, 0)
    expect(body['registration'].shift_nm[1]).toBeCloseTo(shift[1] as number, 0)
    expect(body['registration'].peak_at_search_limit).toBe(false)
    const plane = ok(frameDiff(archive, { frame_a: fa, frame_b: fb, flatten: 'plane' }))
    expect(plane['flatten']).toBe('plane')
    expect(plane).not.toHaveProperty('highpass_nm')
  })

  it('resamples frames of different size and rotation onto their overlap; identical frames show no change', () => {
    const archive = new FrameArchive(tmp())
    const tex = texture(2)
    const ga = geom(96, 96, 9.6, 9.6)
    const fa = add(archive, 0, ga, tex)
    const fb = add(archive, 1, geom(80, 80, 8, 8, 0.8, -0.5, 10), tex)
    const body = ok(frameDiff(archive, { frame_a: fa, frame_b: fb }))
    expect(body['same_geometry']).toBe(false)
    expect(body['grid'].resampled).toBe(true)
    expect(body['grid'].field_nm[0]).toBeLessThan(9.6)
    expect(Math.abs(body['registration'].shift_nm[0])).toBeLessThan(0.02)
    expect(Math.abs(body['registration'].shift_nm[1])).toBeLessThan(0.02)
    const fc = add(archive, 2, ga, tex)
    const same = ok(frameDiff(archive, { frame_a: fa, frame_b: fc }))
    expect(Math.abs(same['registration'].shift_nm[0])).toBeLessThan(1e-3)
    expect(Math.abs(same['registration'].shift_nm[1])).toBeLessThan(1e-3)
    expect(same['difference'].n_regions).toBe(0)
    const shown = frameDiff(archive, { frame_a: fa, frame_b: fc })
    if (!shown.ok) throw new Error(shown.error)
    expect(markPixels(shown.images[0]?.png as Uint8Array)).toEqual([])
    const unaligned = ok(frameDiff(archive, { frame_a: fa, frame_b: fc, align: false }))
    expect(unaligned).not.toHaveProperty('registration')
    expect(unaligned['align']).toBe(false)
    expect(unaligned['difference'].noise_pm).toBe(0)
  })

  it('reports a moved feature as a region of each sign, strongest at its new and old places', () => {
    const archive = new FrameArchive(tmp())
    const g = geom()
    const tex = texture(3)
    const fa = add(archive, 0, g, (X, Y) => tex(X, Y) + bump(0.4, 0.6, 0.25, 40e-12)(X, Y))
    const fb = add(archive, 1, g, (X, Y) => tex(X, Y) + bump(1.4, 0.6, 0.25, 40e-12)(X, Y))
    const regions = ok(frameDiff(archive, { frame_a: fa, frame_b: fb }))['difference'].regions as Record<string, any>[]
    expect(new Set(regions.map((x) => x['sign']))).toEqual(new Set(['+', '-']))
    const plus = regions.find((x) => x['sign'] === '+') as Record<string, number>
    const minus = regions.find((x) => x['sign'] === '-') as Record<string, number>
    expect(Math.hypot((plus['x_nm'] as number) - 1.4, (plus['y_nm'] as number) - 0.6)).toBeLessThan(0.2)
    expect(Math.hypot((minus['x_nm'] as number) - 0.4, (minus['y_nm'] as number) - 0.6)).toBeLessThan(0.2)
    expect(minus['peak_change_pm']).toBeLessThan(0)
  })

  it('lists at most 30 regions, strongest first, and counts the rest', () => {
    const archive = new FrameArchive(tmp())
    const g = geom()
    const tex = texture(4)
    const spots: Surface[] = []
    for (let i = 0; i < 8; i += 1) for (let j = 0; j < 5; j += 1) spots.push(bump(-3.8 + 1.1 * j, 3.8 - 1.0 * i, 0.12, (18 + 0.5 * (i * 5 + j)) * 1e-12))
    const fa = add(archive, 0, g, tex)
    const fb = add(archive, 1, g, (X, Y) => tex(X, Y) + spots.reduce((s, f) => s + f(X, Y), 0))
    const d = ok(frameDiff(archive, { frame_a: fa, frame_b: fb, align: false }))['difference']
    expect(d.n_regions).toBe(40)
    expect(d.regions_listed).toBe(MAX_REGIONS)
    expect(d.regions).toHaveLength(MAX_REGIONS)
    expect(d.regions.map((x: Record<string, number>) => x['id'])).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
  })

  it('compares a region, the Current channel and the backward pass, rows not acquired included', () => {
    const archive = new FrameArchive(tmp())
    const g = geom()
    const tex = texture(5)
    const cur = (s: Surface): Surface => (X, Y) => 1e-10 + 2 * s(X, Y)
    const fa = add(archive, 0, g, tex, { 'Z/backward': tex, Current: cur(tex), 'Current/backward': cur(tex) })
    const moved: Surface = (X, Y) => tex(X - 0.3, Y + 0.1)
    const fb = add(archive, 1, g, moved, { 'Z/backward': moved, Current: cur(moved), 'Current/backward': cur(moved) })
    const body = ok(frameDiff(archive, { frame_a: fa, frame_b: fb, channel: 'current', direction: 'backward', flatten: 'line', region: { x: 80, y: 80, width: 480, height: 400 } }))
    expect(body['channel']).toBe('Current')
    expect(body['grid'].size_px).toEqual([60, 50])
    expect(body['registration'].shift_nm[0]).toBeCloseTo(0.3, 1)
    expect(body['difference']).toHaveProperty('noise_pa')
    const partial = sample(g, moved)
    partial.data.fill(NaN, 60 * 96)
    const fp = archive.addPartial(2, { Z: partial }, { geometry: g }).fid
    const withGaps = ok(frameDiff(archive, { frame_a: fa, frame_b: fp }))
    expect(withGaps['registration'].shift_nm[0]).toBeCloseTo(0.3, 1)
    const values = archive.array(withGaps['difference'].frame, 'diff').data
    expect(Number.isNaN(values[95 * 96] as number)).toBe(true)
    // Rows missing in frame a, and in a resampled frame.
    const fq = archive.addPartial(3, { Z: partial }, { geometry: g }).fid
    expect(ok(frameDiff(archive, { frame_a: fq, frame_b: fa }))['registration'].shift_nm[0]).toBeCloseTo(-0.3, 1)
    const g2 = geom(80, 80, 8, 8, 0.4, 0.2, 5)
    const p2 = sample(g2, moved)
    p2.data.fill(NaN, 50 * 80)
    const fr = archive.addPartial(4, { Z: p2 }, { geometry: g2 }).fid
    const resampled = ok(frameDiff(archive, { frame_a: fq, frame_b: fr }))
    expect(resampled['grid'].resampled).toBe(true)
    expect(Math.abs(resampled['registration'].shift_nm[0])).toBeLessThan(0.05)
  })

  it('draws a block-mean difference image for a grid larger than the display', () => {
    const archive = new FrameArchive(tmp(), { displayMax: 64 })
    const tex = texture(6)
    const fa = add(archive, 0, geom(), tex)
    const fb = add(archive, 1, geom(), (X, Y) => tex(X - 0.1, Y))
    const r = frameDiff(archive, { frame_a: fa, frame_b: fb, region: { x: 5, y: 5, width: 30, height: 25 } })
    const body = ok(r)
    expect(body['grid'].size_px).toEqual([60, 50])
    if (!r.ok) throw new Error(r.error)
    expect(r.images[0]?.label).toContain('scale="1"')
    const full = frameDiff(archive, { frame_a: fa, frame_b: fb })
    if (!full.ok) throw new Error(full.error)
    expect(pngSize(full.images[0]?.png as Uint8Array)).toEqual({ width: 48, height: 48 })
    expect(full.images[0]?.label).toContain('scale="1/2"')
  })
})

describe('frameDiff: refusals', () => {
  function setup(): { archive: FrameArchive; fa: string; fb: string; root: string } {
    const root = tmp()
    // A spectrum record restored from the index (this archive does not ingest spectra yet).
    writeFileSync(join(root, INDEX_NAME), `${JSON.stringify({ fid: 't0000.d0', turn: 0, kind: 'd', index: 0, channels: ['Bias (V)', 'Current (A)'], nx: 64 })}\n`)
    writeFileSync(join(root, 't0000.d0.png'), encodePngRgb(2, 2, new Uint8Array(12)))
    const archive = new FrameArchive(root)
    const tex = texture(8)
    const fa = add(archive, 1, geom(), tex)
    const fb = add(archive, 2, geom(), (X, Y) => tex(X - 0.2, Y))
    return { archive, fa, fb, root }
  }

  it('says what to change', () => {
    const { archive, fa, fb } = setup()
    const plain = archive.addDerived(3, encodePngRgb(4, 4, new Uint8Array(48)), { tool: 'fft_peaks', sources: [fa] }).fid
    const diffFrame = ok(frameDiff(archive, { frame_a: fa, frame_b: fb }))['difference'].frame as string
    const far = add(archive, 4, geom(96, 96, 9.6, 9.6, 500), texture(8))
    const edge = add(archive, 5, geom(96, 96, 9.6, 9.6, 8.6), texture(8))
    const g32 = geom(32, 32, 3.2, 3.2)
    const full = add(archive, 6, g32, texture(8))
    const oneRow = sample(g32, texture(8))
    oneRow.data.fill(NaN, 32)
    const sparse = archive.addPartial(7, { Z: oneRow }, { geometry: g32 }).fid
    const cases: [unknown, RegExp | string][] = [
      [['t0001.p0'], 'diff: arguments must be a JSON object, got list'],
      [null, 'diff: arguments must be a JSON object, got NoneType'],
      ['x', 'diff: arguments must be a JSON object, got str'],
      [true, 'diff: arguments must be a JSON object, got bool'],
      [3, 'diff: arguments must be a JSON object, got int'],
      [2.5, 'diff: arguments must be a JSON object, got float'],
      [{ frame_a: fa }, "diff: arguments: missing required field(s) ['frame_b']"],
      [{ frame_a: fa, frame_b: fb, bogus: 1 }, /^diff: arguments: unknown field\(s\) \['bogus'\]; allowed: \['align', 'channel'/],
      [{ frame_a: 7, frame_b: fb }, "diff: frame_a must be a frame id like 't0007.s0'"],
      [{ frame_a: 't0000.d0', frame_b: fb }, 'diff: frame_a: t0000.d0 is a spectrum; this tool needs a scan frame'],
      [{ frame_a: plain, frame_b: fb }, `diff: frame_a: ${plain} is a derived image without values; use the frame it was derived from (${fa})`],
      [{ frame_a: diffFrame, frame_b: fb }, 'diff: diff compares scan frames (kinds s or p)'],
      [{ frame_a: fa, frame_b: 't0042.s0' }, /^diff: frame_b: no frame 't0042\.s0'; turns 0\.\.7 exist/],
      [{ frame_a: fa, frame_b: fb, channel: 'Current' }, "diff: arguments.channel: no channel 'Current'; this frame has ['Z']"],
      [{ frame_a: fa, frame_b: fb, align: 'yes' }, 'diff: arguments.align must be true or false'],
      [{ frame_a: fa, frame_b: fb, flatten: 'plane', highpass_nm: 2 }, "diff: arguments.highpass_nm only applies with flatten='highpass'"],
      [{ frame_a: fa, frame_b: fb, region: { x: 0, y: 0, width: 100, height: 100 } }, 'diff: the compared region must be at least 16 x 16 scan pixels'],
      [{ frame_a: fa, frame_b: far }, `diff: ${fa} and ${far} do not overlap`],
      [{ frame_a: fa, frame_b: edge, region: { x: 0, y: 0, width: 300, height: 768 } }, `diff: ${fa} and ${edge} do not overlap inside the region`],
      [{ frame_a: fa, frame_b: edge }, `diff: the overlap of ${fa} and ${edge} is only 10x96 pixels of 0.1 nm`],
      [{ frame_a: full, frame_b: sparse }, 'diff: too few pixels overlap after alignment to form a difference'],
    ]
    for (const [args, want] of cases) {
      const got = err(frameDiff(archive, args))
      if (typeof want === 'string') expect(got).toBe(want)
      else expect(got).toMatch(want)
    }
  })

  it('reads null optional arguments as absent (spec/deviations.md D-VMEM-11)', () => {
    const archive = new FrameArchive(tmp())
    const tex = texture(14)
    const fa = add(archive, 0, geom(), tex)
    const fb = add(archive, 1, geom(), (X, Y) => tex(X - 0.2, Y))
    const without = (r: Record<string, any>) => ({ ...r, difference: { ...r['difference'], frame: null } })
    const plain = without(ok(frameDiff(archive, { frame_a: fa, frame_b: fb })))
    for (const k of ['align', 'flatten', 'highpass_nm', 'channel', 'direction', 'region']) {
      expect([k, without(ok(frameDiff(archive, { frame_a: fa, frame_b: fb, [k]: null })))]).toEqual([k, plain])
    }
    // As in the reference, highpass_nm (even null) does not go with another flattening.
    expect(err(frameDiff(archive, { frame_a: fa, frame_b: fb, flatten: 'plane', highpass_nm: null }))).toBe(
      "diff: arguments.highpass_nm only applies with flatten='highpass'",
    )
  })

  it('names the channel and passes frame_b lacks', () => {
    const archive = new FrameArchive(tmp())
    const tex = texture(9)
    const fa = add(archive, 0, geom(), tex, { 'Z/backward': tex, Current: tex })
    const fb = add(archive, 1, geom(), tex)
    expect(err(frameDiff(archive, { frame_a: fa, frame_b: fb, channel: 'Current' }))).toBe("diff: frame_b: no channel 'Current'; this frame has ['Z']")
    expect(err(frameDiff(archive, { frame_a: fa, frame_b: fb, direction: 'backward' }))).toBe("diff: frame_b t0001.p0 channel 'Z' has only ['forward']")
  })
})

describe('the pieces', () => {
  it('register recovers a shift as a pure function', () => {
    const g = geom(120, 120, 12, 12)
    const tex = texture(10)
    const a = sample(g, tex).data
    const b = sample(g, (X, Y) => tex(X - 0.37, Y + 0.24)).data
    const r = register(lowpass(a, 120, 120, 0.1), lowpass(b, 120, 120, 0.1), 120, 120)
    expect(Math.abs(r.dx - 3.7)).toBeLessThan(0.1)
    expect(Math.abs(r.dy - 2.4)).toBeLessThan(0.1)
    expect(r.refined).toBe(true)
    expect(r.limit_px).toBe(48)
    expect(() => register(a, b, 10, 10)).toThrow(/register needs two 10x10 arrays/)
  })

  it('the correlation surface is the normalized correlation over the overlap', () => {
    const r = rng(11)
    const rows = 12
    const cols = 9
    const a = Float64Array.from({ length: rows * cols }, () => r() - 0.5)
    const b = Float64Array.from({ length: rows * cols }, () => r() - 0.5)
    const ones = new Float64Array(rows * cols).fill(1)
    const lim = 3
    const got = nccSurface(a, ones, b, ones, rows, cols, lim, 0)
    for (const [dy, dx] of [[0, 0], [2, -3], [-3, 1]] as const) {
      let C = 0
      let EA = 0
      let EB = 0
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const ys = y - dy
          const xs = x - dx
          if (ys < 0 || ys >= rows || xs < 0 || xs >= cols) continue
          C += (b[y * cols + x] as number) * (a[ys * cols + xs] as number)
          EA += (a[ys * cols + xs] as number) ** 2
          EB += (b[y * cols + x] as number) ** 2
        }
      }
      expect(got[(dy + lim) * (2 * lim + 1) + dx + lim]).toBeCloseTo(C / Math.sqrt(EA * EB), 13)
    }
    // Too little overlap scores -1; an all-zero frame correlates to 0; heights in metres work as well.
    expect(nccSurface(a, ones, b, ones, rows, cols, lim, 1e9).every((v) => v === -1)).toBe(true)
    expect(nccSurface(new Float64Array(rows * cols), ones, b, ones, rows, cols, lim, 0).every((v) => v === 0)).toBe(true)
    const tiny = nccSurface(a.map((v) => v * 1e-11), ones, b.map((v) => v * 1e-11), ones, rows, cols, lim, 0)
    got.forEach((v, i) => expect(tiny[i]).toBeCloseTo(v, 13))
    expect(corrLength(a, ones, rows, cols, 3)).toBe(1)
    // A flat frame (its mean exact, so exactly zero once the mean is removed): no correlation
    // anywhere, so the search's first shift, which Nelder-Mead (every value 1) keeps.
    const flat = register(new Float64Array(16 * 16).fill(0.25), Float64Array.from({ length: 256 }, () => r()), 16, 16)
    expect([flat.ncc_peak, flat.at_search_edge, flat.dx, flat.dy, flat.refined]).toEqual([0, true, -6, -6, true])
  })

  it('Nelder-Mead minimises a bowl and checks its simplex', () => {
    const res = nelderMead((x) => ((x[0] as number) - 1) ** 2 + ((x[1] as number) + 2) ** 2, [[0, 0], [0.3, 0], [0, 0.3]], { xatol: 1e-8, fatol: 1e-12, maxiter: 400 })
    expect(res.x[0]).toBeCloseTo(1, 6)
    expect(res.x[1]).toBeCloseTo(-2, 6)
    expect(res.nfev).toBeGreaterThan(res.nit)
    expect(nelderMead(() => NaN, [[0, 0], [1, 0], [0, 1]], { xatol: 1e-3, fatol: 1e-3, maxiter: 5 }).fun).toBeNaN()
    expect(() => nelderMead(() => 0, [[0, 0], [1, 0]], { xatol: 1, fatol: 1, maxiter: 1 })).toThrow(/N \+ 1 vertices/)
  })

  it('interpolation kernels: identity shifts, mirror folding, constant edges, shape checks', () => {
    const r = rng(12)
    const a = Float64Array.from({ length: 20 * 17 }, () => r())
    expect(shiftConstant(a, 20, 17, 0, 0, 1)).toEqual(a)
    const c = splineFilter3(a, 20, 17)
    shiftConstant(c, 20, 17, 0, 0, 3).forEach((v, i) => expect(v).toBeCloseTo(a[i] as number, 13))
    expect([-1, -2, -5, -9, 0, 4, 5, 6, 9, 10].map((i) => mirrorIndex(i, 5))).toEqual([1, 2, 3, 1, 0, 4, 3, 2, 1, 2])
    expect(mirrorIndex(-3, 1)).toBe(0)
    const shifted = shiftConstant(a, 20, 17, 0.5, -0.5, 1)
    expect(shifted[0]).toBe(0) // its source lies outside the frame
    expect(() => shiftConstant(a, 20, 16, 0, 0, 1)).toThrow(/is not 20 rows x 16 columns/)
  })

  it('geometry, polygon clip, filters and colours', () => {
    const g = { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1, angle_deg: 0, nx: 8, ny: 8 }
    expect(sameGeometry(g, { ...g })).toBe(true)
    expect(sameGeometry(g, { ...g, cx_nm: 2e-9 })).toBe(false)
    expect(sameGeometry(g, { ...g, ny: 9 })).toBe(false)
    expect(clipPolygon([[5, 5], [6, 5], [6, 6]], [0, 0, 1, 1])).toEqual([])
    const z = Float64Array.from({ length: 64 }, (_, i) => (i === 9 ? NaN : Math.sin(i)))
    expect(Number.isNaN(lowpass(z, 8, 8, 0.1)[9] as number)).toBe(true)
    expect(Number.isNaN(bandpass(z, 8, 8, 0.1)[9] as number)).toBe(true)
    expect(Array.from(divergingRgb([1, -1, 0, NaN], 1))).toEqual([255, 38, 38, 38, 38, 255, 255, 255, 255, 64, 64, 64])
  })
})

class FakeAttachments extends Service {
  readonly saved: { data: Uint8Array; name?: string }[] = []
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }): Promise<ImageAttachmentRef> {
    this.saved.push({ data: input.data, ...(input.name === undefined ? {} : { name: input.name }) })
    const { width, height } = pngSize(input.data)
    return Promise.resolve({
      attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`,
      mediaType: 'image/png',
      bytes: input.data.length,
      width,
      height,
      ...(input.name === undefined ? {} : { name: input.name }),
    } as unknown as ImageAttachmentRef)
  }
}

describe('stm_frame_diff through a real dsh dispatcher', () => {
  it('answers with the reply, the label and the image, and refuses with a value', async () => {
    const root = tmp()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    const att = new FakeAttachments(ctx)
    await ctx.plugin(plugin, { root, displayMax: 256 }).await()
    const archive = ctx.frameArchive.archive
    const tex = texture(13)
    const fa = add(archive, 0, geom(), tex)
    const fb = add(archive, 1, geom(), (X, Y) => tex(X - 0.15, Y + 0.05))
    const schema = ctx.tools.schemas().find((s) => s.name === 'stm_frame_diff')
    expect(schema?.description).toContain('without changing the instrument')
    expect(schema?.description).toContain('so stm_read_values and stm_inspect work on it')
    expect(JSON.stringify(schema?.parameters)).toContain('at most 256x256')
    const call = (args: unknown) =>
      ctx.tools.execute({ name: 'stm_frame_diff', callId: `diff-${Math.random()}` as never, arguments: args, signal: new AbortController().signal })
    const res = await call({ frame_a: fa, frame_b: fb })
    expect(res.isError).toBe(false)
    const [text, label, image] = res.content as unknown as [{ type: string; text: string }, { type: string; text: string }, { type: string }]
    const reply = JSON.parse(text.text) as Record<string, any>
    expect(reply['instrument_unchanged']).toBe(true)
    expect(reply['registration'].shift_nm[0]).toBeCloseTo(0.15, 1)
    expect(label.text).toMatch(/^<visual kind="derived" frame="t0001\.m0" derived="diff" frames="t0000\.p0,t0001\.p0"/)
    expect(image.type).toBe('image')
    expect(att.saved[0]?.name).toBe('t0001.m0.png')
    expect(decodePng(att.saved[0]?.data as Uint8Array).width).toBe(192)
    // dsh's own validation refuses a null for a typed optional argument before the tool runs.
    for (const over of [{ align: null }, { flatten: null }, { highpass_nm: null }, { direction: null }]) {
      const res = await call({ frame_a: fa, frame_b: fb, ...over })
      expect(res.isError).toBe(true)
      if (res.isError) expect(res.error.info?.code).toBe('INVALID_ARGS')
    }
    const refused = await call({ frame_a: fa, frame_b: 't0009.s0' })
    expect(refused.isError).toBe(false)
    expect(JSON.parse((refused.content[0] as unknown as { text: string }).text)).toEqual({
      error: expect.stringMatching(/^diff: frame_b: no frame 't0009\.s0'/),
      instrument_unchanged: true,
    })
  })
})
