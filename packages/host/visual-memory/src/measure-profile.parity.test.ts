/**
 * Parity of `stm_line_profile` and `stm_frame_stats` with the Python reference
 * (VISUAL-HARNESS §5).
 *
 * `spec/golden/measure_profile.json` is produced by
 * `tools/spec-export/export_measure_profile.py`, which runs VISTA-SPM's
 * `vista_spm/measure.py` (`line_profile`, `stats`, `change_points`) on synthetic frames
 * in two archives (display_max 768 and 64) and records every call in order, the exact
 * inputs and outputs of `change_points` inside each profile, and CPython's
 * `math.hypot`. The reference file hashes are in the golden.
 *
 * Tolerances, and why:
 * - parsed replies, the key order the model reads, image labels and sizes: exact. Every
 *   number in a reply is rounded (to the channel's decimals, 3–5 decimals of nm, 4
 *   significant digits of a slope), and the differences below are 10^7 times smaller
 *   than any of those steps;
 * - error messages: exact, except where the shared argument helpers write a name or a
 *   list as JSON (`"Z"`, `["forward"]`) and the reference as a Python repr (`'Z'`,
 *   `['forward']`), and where the archive puts the frame id before a channel error
 *   (spec/deviations.md D-VMEM-7); those cases are compared after that one rewrite;
 * - `math.hypot`: exact (`pyHypot` is CPython's algorithm);
 * - the band averages along each line, before rounding: exact without flattening (the
 *   same float32 values, scipy's bilinear operation order, numpy's sequential sum over
 *   the lines); with a fitted background 1e-9 of the profile's span, the flattening
 *   tolerance of `parity.test.ts` (numpy's SVD `lstsq` against a projection);
 * - `change_points` on the reference's own inputs: split positions, step indices,
 *   transition positions and widths, segment bounds, sizes and means, and sigma exact
 *   (same operations in the same order); slopes and step heights within 1e-11 of the
 *   largest |y| (per x unit for slopes, scaled by the x range) — numpy solves the line
 *   fit by SVD, `linfit` in closed form, both backward stable, so they differ by a few
 *   eps times the condition of the centred design, about 1e-15 relative measured here.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import golden from '../../../../spec/golden/measure_profile.json' with { type: 'json' }
import { FrameArchive } from './archive.js'
import { frameStats } from './frame-stats.js'
import { changePoints, lineProfile, MAX_PROFILE_SAMPLES, measureLine, type ChangePoints } from './line-profile.js'
import { NotesStore } from './notes.js'
import { pngSize } from './png.js'
import { pyHypot } from './pymath.js'
import type { PartialGeometry, PartialMeta } from './scan-data.js'
import { defineVisualTools } from './tools.js'

type Num = number | string | null

function num(v: Num): number {
  if (v === 'NaN' || v === null) return Number.NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  return v as number
}

const nums = (vs: readonly Num[]): Float64Array => Float64Array.from(vs.map(num))

function f32(b64: string): Float32Array {
  const bytes = Buffer.from(b64, 'base64')
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

/** Every key of a parsed reply, depth first in insertion order: the order the model reads. */
function keyPaths(obj: unknown, path = '$'): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => keyPaths(v, `${path}[${i}]`))
  if (obj === null || typeof obj !== 'object') return []
  return Object.entries(obj).flatMap(([k, v]) => [`${path}.${k}`, ...keyPaths(v, `${path}.${k}`)])
}

/** The reference's message as the shared helpers word it (D-VMEM-7): JSON names, the frame id before a channel error. */
function sharedHelperWording(message: string, fid: string): string {
  return message
    .replace(/\[('[^']*'(?:, '[^']*')*)\]/g, (_, items: string) => JSON.stringify(items.split(', ').map((s) => s.slice(1, -1))))
    .replace(/'([^']*)'/g, (m, s: string, at: number, all: string) => (/(like |flatten=)$/.test(all.slice(0, at)) ? m : JSON.stringify(s)))
    .replace(/channel: no channel/, `channel: ${fid}: no channel`)
}

// ── the archives, rebuilt from the golden ────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'measure-parity-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const archives: Record<string, FrameArchive> = {
  main: new FrameArchive(join(dir, 'main'), { displayMax: golden.constants.display_max.main }),
  small: new FrameArchive(join(dir, 'small'), { displayMax: golden.constants.display_max.small }),
}
type GoldenFrame = { archive: string; turn: number; geometry: PartialGeometry; meta: PartialMeta; shape: number[]; arrays: Record<string, string> }
const frames = golden.frames as unknown as Record<string, GoldenFrame>
const made: Record<string, string> = {}
for (const name of golden.frame_order) {
  if (name === golden.derived_map.name) {
    const m = golden.derived_map
    made[name] = (archives[m.archive] as FrameArchive).addDerived(m.turn, new Uint8Array(Buffer.from(m.png_b64, 'base64')), {
      tool: m.tool,
      sources: m.sources,
      geometry: m.geometry,
      units: m.units,
      arrays: { 'diff/forward': { rows: m.shape[0] as number, cols: m.shape[1] as number, data: f32(m.array) } },
    }).fid
    continue
  }
  const f = frames[name] as GoldenFrame
  const arrays = Object.fromEntries(
    Object.entries(f.arrays).map(([k, b64]) => [k, { rows: f.shape[0] as number, cols: f.shape[1] as number, data: f32(b64) }]),
  )
  made[name] = (archives[f.archive] as FrameArchive).addPartial(f.turn, arrays, { ...f.meta, geometry: f.geometry }).fid
}

type Call = (typeof golden.calls)[number]
const SHARED_HELPER_ERRORS = new Set([
  'line_profile/bad_flatten',
  'line_profile/unknown_frame',
  'line_profile/unknown_channel',
  'line_profile/missing_direction',
  'stats/unknown_frame',
  'stats/missing_direction',
])

function run(c: Call) {
  const archive = archives[c.archive] as FrameArchive
  return c.tool === 'line_profile' ? lineProfile(archive, c.args) : frameStats(archive, c.args)
}

interface CpWant {
  steps: { index: number; x: number; height: number; width: number }[]
  sigma: number
  segments: { start: number; end: number; slope: number; mean: number; n: number }[]
}

function maxAbs(v: ArrayLike<number>): number {
  let m = 0
  for (let i = 0; i < v.length; i += 1) if (Number.isFinite(v[i] as number)) m = Math.max(m, Math.abs(v[i] as number))
  return m
}

/** Max minus min of the finite values (0 when there are none). */
function span(v: ArrayLike<number>): number {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] as number
    if (Number.isFinite(x)) {
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
  }
  return hi >= lo ? hi - lo : 0
}

/** Compare change points: positions exact, slopes and heights within 1e-11 of the data's scale. */
function expectChangePoints(got: ChangePoints, want: CpWant, x: Float64Array, y: Float64Array): void {
  const fin = x.filter((v, i) => Number.isFinite(v) && Number.isFinite(y[i] as number))
  const xRange = fin.length > 0 ? Math.max(...fin) - Math.min(...fin) : 1
  const yScale = maxAbs(y.filter((_, i) => Number.isFinite(x[i] as number)))
  const heightTol = 1e-11 * Math.max(yScale, 1e-300)
  const slopeTol = heightTol / Math.max(xRange, 1e-300)
  expect(got.sigma).toBe(want.sigma)
  expect(got.steps.map((s) => [s.index, s.x, s.width])).toEqual(want.steps.map((s) => [s.index, s.x, s.width]))
  got.steps.forEach((s, i) => expect(Math.abs(s.height - (want.steps[i] as CpWant['steps'][number]).height)).toBeLessThanOrEqual(heightTol))
  expect(got.segments.map((g) => [g.start, g.end, g.n, g.mean])).toEqual(want.segments.map((g) => [g.start, g.end, g.n, g.mean]))
  got.segments.forEach((g, i) => expect(Math.abs(g.slope - (want.segments[i] as CpWant['segments'][number]).slope)).toBeLessThanOrEqual(slopeTol))
}

describe('parity with the Python reference: measurement tools', () => {
  it('records which reference it was exported from', () => {
    for (const k of ['measure', 'frames', 'archive', 'viewtools', 'protocol']) {
      expect((golden.reference as Record<string, unknown>)[`${k}_py_sha256`]).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(golden.constants.max_profile_samples).toBe(MAX_PROFILE_SAMPLES)
  })

  it('rebuilds the archives with the same frame ids', () => {
    expect(made).toEqual(golden.frame_ids)
  })

  it("describes both tools in the reference's words (ranges go to the parameters)", () => {
    const tools = defineVisualTools({ archive: archives['main'] as FrameArchive, notes: new NotesStore(join(dir, 'notes')), attachments: () => undefined })
    const described = new Map(tools.map((t) => [t.name, t.description]))
    expect(described.get('stm_line_profile')).toBe(golden.descriptions.line_profile)
    expect(described.get('stm_frame_stats')).toBe(golden.descriptions.stats)
  })

  it("computes CPython's math.hypot bit for bit", () => {
    for (const c of golden.hypot) expect(pyHypot(num(c.a), num(c.b))).toBe(num(c.hypot))
    expect(golden.hypot.length).toBeGreaterThan(400)
  })

  describe('change_points on its own', () => {
    for (const c of golden.change_points) {
      it(c.name, () => {
        const x = nums(c.x)
        const y = nums(c.y)
        const kw = c.kwargs as { max_splits?: number; min_seg?: number; min_height_sigma?: number; merge?: number }
        const got = changePoints(x, y, {
          ...(kw.max_splits === undefined ? {} : { maxSplits: kw.max_splits }),
          ...(kw.min_seg === undefined ? {} : { minSeg: kw.min_seg }),
          ...(kw.min_height_sigma === undefined ? {} : { minHeightSigma: kw.min_height_sigma }),
          ...(kw.merge === undefined ? {} : { merge: kw.merge }),
        })
        expectChangePoints(got, c as unknown as CpWant, x, y)
      })
    }
  })

  describe('the tools, call by call', () => {
    for (const c of golden.calls) {
      it(`${c.tool} ${c.name}`, () => {
        const r = run(c)
        if (c.is_error) {
          if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.reply).slice(0, 200)}`)
          const want = (c.reply as { error: string }).error
          const fid = (c.args as { frame?: string } | null)?.frame ?? ''
          expect(r.error).toBe(SHARED_HELPER_ERRORS.has(`${c.tool}/${c.name}`) ? sharedHelperWording(want, fid) : want)
          return
        }
        if (!r.ok) throw new Error(r.error)
        expect(r.reply).toEqual(c.reply)
        expect(keyPaths(r.reply)).toEqual(c.key_paths)
        expect(r.images.map((i) => i.label)).toEqual(c.labels)
        expect(r.images.map((i) => { const s = pngSize(i.png); return [s.width, s.height] })).toEqual(c.image_sizes)
      })
    }
  })

  describe('inside each profile: the samples and the change points', () => {
    const profiles = golden.calls.filter((c) => c.tool === 'line_profile' && !c.is_error)
    for (const c of profiles) {
      it(c.name, () => {
        const want = (c as unknown as { change_points: { x: Num[]; y: Num[]; kwargs: { merge: number } } & CpWant }).change_points
        const x = nums(want.x)
        const y = nums(want.y)
        const m = measureLine(archives[c.archive] as FrameArchive, c.args)
        expect(m.merge).toBe(want.kwargs.merge)
        expect([...m.dist]).toEqual([...x])
        const raw = (c.args as { flatten?: string }).flatten === 'none'
        const tol = 1e-9 * span(y)
        m.vals.forEach((v, i) => {
          const w = y[i] as number
          if (Number.isNaN(w)) expect(v).toBeNaN()
          else if (raw) expect(v).toBe(w)
          else expect(Math.abs(v - w)).toBeLessThanOrEqual(tol)
        })
        expectChangePoints(changePoints(x, y, { merge: want.kwargs.merge }), want, x, y)
      })
    }
  })
})
