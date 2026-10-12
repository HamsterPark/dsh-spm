/**
 * `stm_line_profile` and `stm_frame_stats` on small synthetic frames: the edge cases
 * (lines on and past the frame's edge, rows never acquired, lines shorter than a scan
 * pixel, the band average, a frame without a backward pass, frames that are not scans)
 * and the content blocks a real dsh dispatcher returns. Parity with the reference is
 * `measure-profile.parity.test.ts`.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef } from 'dsh-spm-compat'
import { mapCoordinates, matOf } from 'dsh-spm-numerics'
import { afterEach, describe, expect, it } from 'vitest'
import { FrameArchive, INDEX_NAME } from './archive.js'
import { frameStats } from './frame-stats.js'
import { bandProfile, changePoints, lineProfile, linfit, MAX_PROFILE_SAMPLES, measureLine, plotPx } from './line-profile.js'
import { decodePng, encodePngRgb, pngSize, toRgb } from './png.js'
import * as plugin from './plugin.js'
import { pyHypot, pyMax, pyMin, pyMod } from './pymath.js'
import type { ViewToolResult } from './args.js'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.registry.delete(plugin)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function ok(r: ViewToolResult): Record<string, unknown> {
  if (!r.ok) throw new Error(r.error)
  return r.reply
}

function err(r: ViewToolResult): string {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.reply).slice(0, 120)}`)
  return r.error
}

/** Seeded noise, roughly normal with unit spread: twice the sum of three uniforms (mulberry32) minus 3. */
function noise(seed: number): () => number {
  let a = seed >>> 0
  const uniform = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => 2 * (uniform() + uniform() + uniform() - 1.5)
}

/**
 * 40 x 20 pixels over 8 x 4 nm: a 50 pm step at column 25 with 0.5 pm of noise; rows from
 * `missingFrom` on not acquired. At display_max 120 the display is 120 x 60 (k = 3).
 */
function step(missingFrom = 20): { rows: number; cols: number; data: Float64Array } {
  const next = noise(7)
  const data = Float64Array.from({ length: 40 * 20 }, (_, i) => {
    const x = i % 40
    const y = Math.floor(i / 40)
    const v = (x >= 25 ? 50e-12 : 0) + 0.5e-12 * next()
    return y >= missingFrom ? Number.NaN : v
  })
  return { rows: 20, cols: 40, data }
}

const GEOMETRY = { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 4 }

function archive(displayMax = 120): FrameArchive {
  return new FrameArchive(join(tempDir('measure-'), 'frames'), { displayMax })
}

describe('CPython arithmetic', () => {
  it('hypot is exact where V8 is an ulp off', () => {
    expect(pyHypot(104, 153)).toBe(185)
    expect(Math.hypot(104, 153)).not.toBe(185)
    expect(pyHypot(-3, 4)).toBe(5)
    expect(pyHypot(0, 0)).toBe(0)
    expect(pyHypot(Infinity, Number.NaN)).toBe(Infinity)
    expect(pyHypot(1, Number.NaN)).toBeNaN()
    expect(pyHypot(5e-324, 5e-324)).toBe(5e-324)
  })

  it('float % takes the sign of the divisor; ties of max and min go to the first argument', () => {
    expect(pyMod(-190, 360)).toBe(170)
    expect(pyMod(190, -360)).toBe(-170)
    expect(Object.is(pyMod(-0, 360), 0)).toBe(true)
    expect(Object.is(pyMod(360, -360), -0)).toBe(true)
    expect(Object.is(pyMax(-0, 0), -0)).toBe(true)
    expect(Object.is(pyMin(0, -0), 0)).toBe(true)
  })
})

describe('the band average', () => {
  // 3 x 3, the middle row never acquired
  const z = Float64Array.from([1, 2, 3, Number.NaN, Number.NaN, Number.NaN, 7, 8, 9])

  it('samples like scipy: a NaN neighbour at weight 0 gives NaN, a coordinate outside the frame keeps its fraction', () => {
    // along row 0's centre every sample has row 1 as a neighbour, at weight 0 (scipy 1.17: NaN)
    expect([...bandProfile(z, 3, 3, [0.5, 0.5, 2.5, 0.5], 3, 1)].every(Number.isNaN)).toBe(true)
    // 0.3 scan px above it the row coordinate is −0.3: its neighbours −1 and 0 are both row 0 (scipy 1.17: 1, 2, 3)
    expect([...bandProfile(z, 3, 3, [0.5, 0.2, 2.5, 0.2], 3, 1)]).toEqual([1, 2, 3])
  })

  it('averages max(1, round(w)) lines, half to even, and skips a line that is NaN', () => {
    const grid = Float64Array.from({ length: 64 }, (_, i) => (i >= 40 ? Number.NaN : i % 8))
    const mat = matOf(8, 8, grid)
    const cols = Array.from({ length: 9 }, (_, i) => i - 0.5)
    const line = (row: number): Float64Array => mapCoordinates(mat, cols.map(() => row), cols, 1, 'nearest')
    // through row 3.5 (native centre 3), 2.5 scan px wide: round(2.5) = 2 lines, at rows 3 ∓ 0.625
    const two = [line(3 - 0.625), line(3 + 0.625)]
    expect([...bandProfile(grid, 8, 8, [0, 3.5, 8, 3.5], 9, 2.5)]).toEqual([...(two[0] as Float64Array)].map((v, i) => (v + (two[1]?.[i] as number)) / 2))
    // through row 4.5, 3.5 wide: 4 lines; the two below row 4 run into rows never acquired
    const four = [-1.3125, -0.4375, 0.4375, 1.3125].map((o) => line(4 + o))
    expect([...(four[2] as Float64Array)].every(Number.isNaN)).toBe(true)
    expect([...bandProfile(grid, 8, 8, [0, 4.5, 8, 4.5], 9, 3.5)]).toEqual([...(four[0] as Float64Array)].map((v, i) => (v + (four[1]?.[i] as number)) / 2))
  })
})

describe('the plot size', () => {
  it('is what matplotlib makes of a figure px / 100 inches wide at 100 dpi', () => {
    // int(px / 100 * 100) in float64, checked against the reference's _plot_png for every width 600..2048
    expect([600, 768, 802, 803, 804, 805, 400].map(plotPx)).toEqual([600, 768, 802, 802, 803, 805, 400])
    expect([1003, 1012, 1020, 1024, 1606, 2048].map(plotPx)).toEqual([1002, 1011, 1019, 1024, 1605, 2048])
  })

  it('sizes the archived plot and its label that way above display_max 803', () => {
    for (const [displayMax, width] of [[1020, 1019], [1024, 1024]] as const) {
      const a = archive(displayMax)
      const fid = a.addPartial(0, { Z: step() }, { geometry: GEOMETRY }).fid
      const r = lineProfile(a, { frame: fid, p1: { x: 0, y: 5 }, p2: { x: 100, y: 5 } })
      if (!r.ok) throw new Error(r.error)
      const image = r.images[0] as { png: Uint8Array; label: string }
      expect([pngSize(image.png).width, pngSize(image.png).height]).toEqual([width, 400])
      expect(image.label).toContain(` size="${width}x400"/>`)
    }
  })
})

describe('change points', () => {
  const x = Float64Array.from({ length: 30 }, (_, i) => i * 0.1)

  it('needs 2 · minSeg + 1 finite samples', () => {
    expect(changePoints(x.subarray(0, 6), new Float64Array(6))).toEqual({ steps: [], sigma: 0, segments: [] })
    expect(changePoints(x, x.map(() => Number.NaN))).toEqual({ steps: [], sigma: 0, segments: [] })
  })

  it('takes sigma from the spread of the differences when their median is zero, 1e-12 when there is none', () => {
    const clean = changePoints(x, x.map((_, i) => (i >= 15 ? 1 : 0)))
    expect(clean.sigma).toBeGreaterThan(0.1)
    expect(clean.steps).toHaveLength(1)
    expect(clean.steps[0]).toMatchObject({ index: 15, width: 0 })
    expect(clean.steps[0]?.x).toBeCloseTo(1.45, 12)
    expect(changePoints(x, new Float64Array(30))).toMatchObject({ steps: [], sigma: 1e-12, segments: [{ n: 30, slope: 0, mean: 0 }] })
  })

  it('reports indices of the input, non-finite samples included', () => {
    const next = noise(3)
    const y = x.map((_, i) => (i >= 20 ? 2 : 0) + 0.01 * next())
    y[2] = Number.NaN
    y[5] = Number.NaN
    const cp = changePoints(x, y)
    expect(cp.steps.map((s) => s.index)).toEqual([20])
    expect(cp.segments.reduce((n, g) => n + g.n, 0)).toBe(28)
  })

  it('fits a straight line in closed form, and a single x as its mean', () => {
    expect(linfit(Float64Array.from([1, 2, 3]), Float64Array.from([3, 5, 7]))).toEqual([2, 1])
    expect(linfit(Float64Array.from([2, 2]), Float64Array.from([1, 3]))).toEqual([0, 2])
    expect(linfit(new Float64Array(0), new Float64Array(0))).toEqual([0, 0])
  })
})

describe('line_profile', () => {
  it('measures a step, reports both ends, and archives one plot', () => {
    const a = archive()
    const fid = a.addPartial(0, { Z: step() }, { geometry: GEOMETRY }).fid
    const r = lineProfile(a, { frame: fid, p1: { x: 3, y: 30 }, p2: { x: 117, y: 30 }, flatten: 'none' })
    const body = ok(r)
    expect(body).toMatchObject({ frame: fid, channel: 'Z', direction: 'forward', flatten: 'none', length_nm: 7.6, direction_deg: 0, n_samples: 39 })
    expect(body['p1']).toEqual({ x_px: 3, y_px: 30, x_nm: -3.8, y_nm: 0 })
    const steps = body['steps'] as Record<string, number>[]
    expect(steps).toHaveLength(1)
    expect(steps[0]?.['height_pm']).toBeCloseTo(50, 0)
    // the edge lies at 4.8 nm; a transition segment has at least 3 samples, so its middle is within one sample (0.2 nm)
    expect(Math.abs((steps[0]?.['position_nm'] as number) - 4.8)).toBeLessThanOrEqual(0.2 + 1e-9)
    const plot = (body['plot'] as { frame: string }).frame
    expect(plot).toBe('t0000.m0')
    expect(a.get(plot).extra).toMatchObject({ tool: 'line_profile', sources: [fid], description: 'profile of Z forward from p1 to p2' })
    expect(r.ok && r.images.map((i) => [i.name, pngSize(i.png).width, pngSize(i.png).height])).toEqual([['t0000.m0.png', 600, 400]])
    // the plot shows the profile in the reference's blue and the step as a red marker line
    const rgb = r.ok ? toRgb(decodePng(r.images[0]?.png as Uint8Array)) : new Uint8Array(0)
    const count = (c: readonly number[]): number => {
      let k = 0
      for (let i = 0; i < rgb.length; i += 3) if (rgb[i] === c[0] && rgb[i + 1] === c[1] && rgb[i + 2] === c[2]) k += 1
      return k
    }
    expect(count([31, 78, 156])).toBeGreaterThan(500)
    expect(count([214, 39, 40])).toBeGreaterThan(100)
    expect(r.ok && r.images[0]?.label).toBe(
      `<visual kind="derived" frame="t0000.m0" derived="line_profile" frames="${fid}" channel="Z" direction="forward" flatten="none" ` +
        'plot="line profile" x="distance from p1 [nm]" y="Z [pm]" size="600x400"/>',
    )
    // the plot is a derived image without values: measured frames only
    expect(err(lineProfile(a, { frame: plot, p1: { x: 0, y: 0 }, p2: { x: 10, y: 10 } }))).toBe(
      `line_profile: frame: ${plot} is a derived image without values; use the frame it was derived from (${fid})`,
    )
  })

  it('takes end points on the far edge and within 1e-6 scan px outside it, and refuses points beyond', () => {
    const a = archive()
    const fid = a.addPartial(0, { Z: step() }, { geometry: GEOMETRY }).fid
    const m = measureLine(a, { frame: fid, p1: { x: -2e-6, y: -2e-6 }, p2: { x: 120, y: 60 } })
    expect(m.ends).toEqual([0, 0, 40, 20])
    expect(ok(lineProfile(a, { frame: fid, p1: { x_nm: -4, y_nm: 2 }, p2: { x_nm: 4, y_nm: -2 } }))['n_samples']).toBe(46)
    const outside = 'line_profile: p2 lies outside t0000.p0 (display image 120x60, i.e. 0 <= x <= 120, 0 <= y <= 60)'
    expect(err(lineProfile(a, { frame: fid, p1: { x: 0, y: 0 }, p2: { x: 120.0001, y: 0 } }))).toBe(outside)
    expect(err(lineProfile(a, { frame: fid, p1: { x: 0, y: 0 }, p2: { x_nm: 4.1, y_nm: 0 } }))).toBe(outside)
    expect(err(lineProfile(a, { frame: fid, p1: { x: 0, y: -1 }, p2: { x: 5, y: 5 } }))).toBe(outside.replace('p2', 'p1'))
  })

  it('refuses a line shorter than one scan pixel and samples one that long twice', () => {
    const a = archive()
    const fid = a.addPartial(0, { Z: step() }, { geometry: GEOMETRY }).fid
    const short = 'line_profile: p1 and p2 are less than one scan pixel apart'
    expect(err(lineProfile(a, { frame: fid, p1: { x: 30, y: 30 }, p2: { x: 30, y: 30 } }))).toBe(short)
    expect(err(lineProfile(a, { frame: fid, p1: { x: 30, y: 30 }, p2: { x: 32.9, y: 30 } }))).toBe(short)
    const one = ok(lineProfile(a, { frame: fid, p1: { x: 30, y: 30 }, p2: { x: 33, y: 30 } }))
    expect(one).toMatchObject({ n_samples: 2, distance_nm: [0, 0.2], spacing_nm: 0.2, steps: [], segments: [], noise_per_sample_pm: 0 })
  })

  it('gives null where the line runs into rows never acquired and finds steps on the rest', () => {
    const a = archive()
    const fid = a.addPartial(0, { Z: step(12) }, { geometry: GEOMETRY }).fid
    const down = ok(lineProfile(a, { frame: fid, p1: { x: 90, y: 0 }, p2: { x: 90, y: 60 }, flatten: 'none' }))
    const values = down['values_pm'] as (number | null)[]
    expect(values.slice(0, 11).every((v) => v !== null)).toBe(true)
    expect(values.slice(13).every((v) => v === null)).toBe(true)
    // along the last acquired row's centre every sample touches row 12: all null, no segments
    const edge = ok(lineProfile(a, { frame: fid, p1: { x: 0, y: 34.5 }, p2: { x: 120, y: 34.5 } }))
    expect((edge['values_pm'] as unknown[]).every((v) => v === null)).toBe(true)
    expect(edge).toMatchObject({ steps: [], segments: [], noise_per_sample_pm: 0 })
    // a band of three lines keeps the one above
    const band = ok(lineProfile(a, { frame: fid, p1: { x: 0, y: 34.5 }, p2: { x: 120, y: 34.5 }, width_px: 9, flatten: 'none' }))
    expect((band['values_pm'] as unknown[]).every((v) => v !== null)).toBe(true)
    expect((band['steps'] as unknown[]).length).toBe(1)
    expect(band).toMatchObject({ width_px: 9, width_nm: 0.6 })
  })

  it('samples at most 400 points however long the line', () => {
    const a = archive(768)
    const data = Float64Array.from({ length: 600 * 4 }, (_, i) => ((i % 600) >= 300 ? 1e-10 : 0))
    const fid = a.addPartial(0, { Z: { rows: 4, cols: 600, data } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 60, h_nm: 0.4 } }).fid
    const body = ok(lineProfile(a, { frame: fid, p1: { x: 0, y: 2 }, p2: { x: 600, y: 2 }, flatten: 'none' }))
    expect(body['n_samples']).toBe(MAX_PROFILE_SAMPLES)
    expect(body['spacing_nm']).toBeCloseTo(60 / 399, 5)
    expect((body['steps'] as Record<string, number>[]).map((s) => s['height_pm'])).toEqual([100])
  })

  it('refuses a backward pass the frame does not have, and arguments that are not an object', () => {
    const a = archive()
    const fid = a.addPartial(0, { Z: step() }, { geometry: GEOMETRY }).fid
    expect(err(lineProfile(a, { frame: fid, direction: 'backward', p1: { x: 0, y: 0 }, p2: { x: 9, y: 9 } }))).toBe(
      "line_profile: arguments.direction: t0000.p0 channel 'Z' has only ['forward']",
    )
    expect(err(lineProfile(a, null))).toBe('line_profile: arguments must be a JSON object, got NoneType')
    expect(err(lineProfile(a, 'frame'))).toBe('line_profile: arguments must be a JSON object, got str')
  })
})

describe('stats', () => {
  it('reports raw and plane-subtracted statistics and no pass comparison without a backward pass', () => {
    const a = archive()
    const fid = a.addPartial(0, { Z: step(15) }, { geometry: GEOMETRY }).fid
    const body = ok(frameStats(a, { frame: fid }))
    expect(Object.keys(body)).toEqual([
      'instrument_unchanged', 'frame', 'channel', 'direction', 'region_px', 'native_px', 'n_pixels', 'n_not_acquired', 'decimals',
      'mean_pm', 'std_pm', 'min_pm', 'max_pm', 'percentiles_pm', 'plane_subtracted', 'line_noise_index', 'rows_acquired_fraction',
      'rows_acquired', 'rows_total',
    ])
    expect(body).toMatchObject({ n_pixels: 800, n_not_acquired: 200, rows_acquired: 15, rows_total: 20, rows_acquired_fraction: 0.75 })
    const acquired = step(15).data.filter(Number.isFinite)
    expect([body['min_pm'], body['max_pm']]).toEqual([Math.min(...acquired), Math.max(...acquired)].map((v) => Math.round(v * 1e13) / 10))
    expect((body['plane_subtracted'] as Record<string, number>)['peak_to_valley_pm']).toBeGreaterThan(40)
    expect(body['line_noise_index']).toBeLessThan(0.5)
  })

  it('compares the two passes when the channel has both', () => {
    const a = archive()
    const z = step()
    const fid = a.addPartial(0, { Z: z, 'Z/backward': { ...z, data: z.data.map((v) => v + 3e-12) } }, { geometry: GEOMETRY }).fid
    expect(ok(frameStats(a, { frame: fid }))['forward_backward']).toEqual({ correlation: 1, rms_difference_pm: 0 })
    expect(ok(frameStats(a, { frame: fid, direction: 'backward' }))['mean_pm']).toBeCloseTo(ok(frameStats(a, { frame: fid }))['mean_pm'] as number + 3, 6)
  })

  it('measures a region, and refuses one with fewer than 4 acquired pixels', () => {
    const a = archive()
    const fid = a.addPartial(0, { Z: step(15) }, { geometry: GEOMETRY }).fid
    expect(ok(frameStats(a, { frame: fid, region: { x: 3, y: 4, width: 10, height: 5 } }))).toMatchObject({
      region_px: [3, 4, 10, 5], native_px: [1, 1, 5, 3], n_pixels: 8,
    })
    expect(err(frameStats(a, { frame: fid, region: { x: 0, y: 42, width: 3, height: 18 } }))).toBe('stats: the region has fewer than 4 acquired pixels')
  })

  it('measures a derived map with values; refuses a grid region its image does not show', () => {
    const a = archive(64)
    const data = Float64Array.from({ length: 256 }, (_, i) => 1e-12 * (i % 7))
    // a 16 x 16 grid shown at k = 4 would be 64 px wide; this map's image is 100 px wide
    const map = a.addDerived(0, encodePngRgb(100, 100, new Uint8Array(30000)), {
      tool: 'stm_frame_diff', geometry: { cx_nm: 0, cy_nm: 0, w_nm: 3, h_nm: 3 }, units: { diff: 'm' }, arrays: { 'diff/forward': { rows: 16, cols: 16, data } },
    }).fid
    expect(ok(frameStats(a, { frame: map }))).toMatchObject({ channel: 'diff', n_pixels: 256, rows_acquired: null })
    expect(err(frameStats(a, { frame: map, region: { x: 70, y: 0, width: 10, height: 10 } }))).toBe(
      "stats: region x=70, y=0, width=10, height=10 leaves the frame's 64x64 display image (x + width <= 64, y + height <= 64)",
    )
  })
})

describe('frames these tools do not measure', () => {
  /** An archive re-opened from an index with a spectrum and a scan whose record lost its pixel size. */
  function restored(): FrameArchive {
    const root = join(tempDir('measure-restored-'), 'frames')
    const a = new FrameArchive(root, { displayMax: 120 })
    a.addPartial(0, { Z: step() }, { geometry: GEOMETRY })
    const rec = JSON.parse(readFileSync(join(root, INDEX_NAME), 'utf8').trim()) as Record<string, unknown>
    const spectrum = { fid: 't0001.d0', turn: 1, kind: 'd', index: 0, source_name: 'sts.dat', channels: ['Bias (V)', 'Current (A)'], nx: 64 }
    writeFileSync(join(root, 't0001.d0.png'), encodePngRgb(4, 4, new Uint8Array(48)))
    writeFileSync(join(root, INDEX_NAME), `${JSON.stringify({ ...rec, nm_per_px: 0, extra: { ...(rec['extra'] as object), nm_per_px_y: 0 } })}\n${JSON.stringify(spectrum)}\n`)
    return new FrameArchive(root, { displayMax: 120 })
  }

  it('refuses spectra: these tools need a scan frame', () => {
    const a = restored()
    expect(a.loadWarnings).toEqual([])
    expect(err(frameStats(a, { frame: 't0001.d0' }))).toBe('stats: frame: t0001.d0 is a spectrum; this tool needs a scan frame')
    expect(err(lineProfile(a, { frame: 't0001.d0', p1: { x: 0, y: 0 }, p2: { x: 5, y: 5 } }))).toBe(
      'line_profile: frame: t0001.d0 is a spectrum; this tool needs a scan frame',
    )
  })

  it('cannot high-pass flatten a frame without a pixel size, and says so', () => {
    expect(err(lineProfile(restored(), { frame: 't0000.p0', p1: { x: 0, y: 30 }, p2: { x: 120, y: 30 }, flatten: 'highpass' }))).toBe(
      'line_profile: highpass flattening needs the pixel size',
    )
  })
})

// ── through a real dsh dispatcher ─────────────────────────────────────────

class FakeAttachments extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }): Promise<ImageAttachmentRef> {
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

async function host(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  new FakeAttachments(ctx)
  await ctx.plugin(plugin, { root: tempDir('measure-tools-'), displayMax: 120 }).await()
  ctx.frameArchive.addPartial(0, { Z: step() }, { geometry: GEOMETRY })
  return ctx
}

let n = 0
async function call(ctx: Context, name: string, args: unknown) {
  n += 1
  return ctx.tools.execute({ name, callId: `measure-${n}` as never, arguments: args, signal: new AbortController().signal })
}

function texts(content: readonly { type: string }[]): string[] {
  return content.filter((b) => b.type === 'text').map((b) => (b as unknown as { text: string }).text)
}

describe('the dsh tools', () => {
  it('stm_line_profile returns the reply, then the plot with its label', async () => {
    const ctx = await host()
    const res = await call(ctx, 'stm_line_profile', { frame: 't0000.p0', p1: { x: 3, y: 30 }, p2: { x: 117, y: 30 } })
    expect(res.isError).toBe(false)
    expect(res.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    const [reply, label] = texts(res.content)
    expect(JSON.parse(reply as string)).toMatchObject({ instrument_unchanged: true, plot: { frame: 't0000.m0' } })
    expect(label).toMatch(/^<visual kind="derived" frame="t0000\.m0" derived="line_profile" .* size="600x400"\/>\n$/)
    const image = res.content[2] as { type: 'image'; attachment: ImageAttachmentRef }
    expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 600, height: 400, name: 't0000.m0.png' })
  })

  it('stm_frame_stats returns text only; refusals are values', async () => {
    const ctx = await host()
    const res = await call(ctx, 'stm_frame_stats', { frame: 't0000.p0', region: { x: 0, y: 0, width: 60, height: 30 } })
    expect(res.content.map((b) => b.type)).toEqual(['text'])
    expect(JSON.parse(texts(res.content)[0] as string)).toMatchObject({ native_px: [0, 0, 20, 10], n_pixels: 200 })
    const bad = await call(ctx, 'stm_frame_stats', { frame: 't0000.p0', channel: 'Current' })
    expect(bad.isError).toBe(false)
    expect(JSON.parse(texts(bad.content)[0] as string)).toEqual({
      error: "stats: arguments.channel: no channel 'Current'; this frame has ['Z']",
      instrument_unchanged: true,
    })
    const unknown = await call(ctx, 'stm_line_profile', { frame: 't0000.p0', p1: { x: 0, y: 0 }, p2: { x: 9, y: 9 }, bogus: 1 })
    expect(JSON.parse(texts(unknown.content)[0] as string).error).toBe(
      "line_profile: arguments: unknown field(s) ['bogus']; allowed: ['channel', 'direction', 'flatten', 'frame', 'highpass_nm', 'p1', 'p2', 'width_px']",
    )
  })

  it('leaves malformed points to dsh, which rejects them before the tool runs', async () => {
    const ctx = await host()
    const res = await call(ctx, 'stm_line_profile', { frame: 't0000.p0', p1: { x: 0, y: 0, z: 1 }, p2: { x: 9, y: 9 } })
    expect(res.isError).toBe(true)
    if (res.isError) expect(res.error.info?.code).toBe('INVALID_ARGS')
  })

  it('puts the ranges into the parameter descriptions', async () => {
    const ctx = await host()
    const schema = ctx.tools.schemas().find((s) => s.name === 'stm_line_profile')
    expect(JSON.stringify(schema?.parameters)).toContain('Band width in display pixels averaged across the line, 1 to 120. Default 1.')
    const stats = ctx.tools.schemas().find((s) => s.name === 'stm_frame_stats')
    expect(JSON.stringify(stats?.parameters)).toContain('at most 120x120')
  })
})
