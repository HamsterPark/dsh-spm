/**
 * Parity with the Python reference (VISUAL-HARNESS §5).
 *
 * `spec/golden/visual_memory.json` is produced by
 * `tools/spec-export/export_visual_memory.py`, which runs VISTA-SPM's
 * `vista_spm/frames.py`, `archive.py` and `viewtools.py` on synthetic
 * inputs; the reference file hashes are recorded in the golden. Since the TS
 * port follows the reference's current model-facing vocabulary (2026-10-09), the
 * golden also pins model units, decimals, rounding, and the summaries, labels and
 * parsed `inspect` / `read_values` replies of a small synthetic archive, and the
 * metric graph paper on scan images (spacing, line pixels, rendered pixels, and an
 * archive that draws it), exactly. Spectra are compared in `spectra.parity.test.ts`.
 *
 * Tolerances, and why:
 * - archive summaries, labels and parsed replies: exact (values are rounded to
 *   the channel's decimals, so the fitting differences below could only show
 *   at a rounding boundary);
 * - integer and string results (scales, sizes, views, sampling, labels,
 *   grey levels, pixels): exact;
 * - colour limits computed from the SAME flattened values: exact (same
 *   percentile formula, numpy's lerp included);
 * - scan-nm transforms: 1e-12 nm absolute — same operation order, but
 *   `Math.cos`/`Math.sin` and the C library may differ in the last bit;
 * - flattening: 1e-9 of the frame's value span — numpy's SVD `lstsq` and the
 *   projection here are different backward-stable algorithms;
 * - block means: 1e-12 relative — numpy sums pairwise, this package in row order.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import golden from '../../../../spec/golden/visual_memory.json' with { type: 'json' }
import { blockMean, flatten, type FlattenMode } from './flatten.js'
import { displaySize, displayToScanNm, scalePair, scaleText, scanNmToDisplay, type ScanGeometry } from './geometry.js'
import { decodePng } from './png.js'
import {
  colourLimits,
  fmtNum,
  greyRgb,
  GRID_COLOUR_NAME,
  GRID_MAX_CELLS,
  GRID_MIN_CELL_PX,
  GRID_RGB,
  gridLines,
  niceStep,
  planView,
  renderValues,
  viewCornersNm,
  viewGrid,
  visualLabel,
  type LabelAttr,
} from './render.js'
import { entryFromRecord, entrySummary, FrameArchive } from './archive.js'
import type { PartialMeta } from './scan-data.js'
import { decimalsFor, displayUnit, npRound, rangeAttr, robustSpan, roundTo, unitKey } from './units.js'
import { inspect, readValues, sampleAxis } from './views.js'

type Num = number | string | null

function num(v: Num): number {
  if (v === 'NaN' || v === null) return Number.NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  return v as number
}

function flat(rows: readonly (readonly Num[])[]): Float64Array {
  return Float64Array.from(rows.flat().map(num))
}

const NX = golden.frames.nx
const NY = golden.frames.ny
const inputs: Record<string, Float32Array> = {
  frame: Float32Array.from(flat(golden.frames.frame as Num[][])),
  one_row: Float32Array.from(flat(golden.frames.one_row as Num[][])),
}

function span(a: Float64Array): number {
  let lo = Infinity
  let hi = -Infinity
  for (const v of a) {
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  }
  return hi - lo
}

describe('parity with the Python reference: geometry', () => {
  it('records which reference it was exported from', () => {
    expect(golden.reference.frames_py_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(golden.reference.archive_py_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('display scale and size', () => {
    for (const c of golden.scale) {
      const s = scalePair(c.nx, c.ny, c.display_max)
      expect({ num: s.num, den: s.den }).toEqual({ num: c.num, den: c.den })
      expect(displaySize(c.nx, c.ny, s)).toEqual(c.display_size)
      expect(scaleText(s)).toBe(c.text)
    }
  })

  it('display ↔ scan-frame nm, rotated and downsampled frames included', () => {
    let n = 0
    for (const t of golden.transforms) {
      const g = t.geometry as ScanGeometry
      const s = scalePair(g.nx, g.ny, t.display_max)
      for (const p of t.points) {
        const [X, Y] = displayToScanNm(g, s, p.x, p.y)
        expect(Math.abs(X - p.X)).toBeLessThanOrEqual(1e-12)
        expect(Math.abs(Y - p.Y)).toBeLessThanOrEqual(1e-12)
        const [bx, by] = scanNmToDisplay(g, s, p.X, p.Y)
        expect(Math.abs(bx - p.back_x)).toBeLessThanOrEqual(1e-9)
        expect(Math.abs(by - p.back_y)).toBeLessThanOrEqual(1e-9)
        n += 1
      }
    }
    expect(n).toBeGreaterThan(40)
  })

  it('views of exact regions and the corners of a rotated view', () => {
    for (const c of golden.views) {
      const region = c.region === null ? null : { x: c.region[0] as number, y: c.region[1] as number, width: c.region[2] as number, height: c.region[3] as number }
      const v = planView(c.nx, c.ny, { num: c.num, den: c.den }, region, c.display_max)
      expect([...v.region_px]).toEqual(c.region_px)
      expect([...v.native]).toEqual(c.native)
      expect([...v.image_size]).toEqual(c.image_size)
      expect([v.up, v.down]).toEqual([c.up, c.down])
      expect(v.magnification).toBe(c.magnification)
    }
    const k = golden.corners
    const g = k.geometry as ScanGeometry
    const r = k.region
    const v = planView(g.nx, g.ny, scalePair(g.nx, g.ny, k.display_max), { x: r[0] as number, y: r[1] as number, width: r[2] as number, height: r[3] as number }, k.display_max)
    expect(viewCornersNm(g, v)).toEqual(k.corners_nm)
  })

  it('read_values cell-centre sampling', () => {
    for (const c of golden.sample_axis) {
      expect(sampleAxis(c.x0, c.w, c.n, { num: c.num, den: c.den }, c.n_native)).toEqual({ display: c.display, native: c.native })
    }
  })
})

describe('parity with the Python reference: pixels', () => {
  for (const c of golden.flatten) {
    it(`flatten ${c.mode}${c.mode === 'highpass' ? ` ${c.highpass_nm} nm` : ''} of ${c.input}, then contrast and grey levels`, () => {
      const want = flat(c.values as Num[][])
      const got = flatten(inputs[c.input] as Float32Array, NX, NY, c.mode as FlattenMode, { nmPerPx: c.nm_per_px, highpassNm: c.highpass_nm })
      const tol = 1e-9 * span(want)
      for (let i = 0; i < want.length; i += 1) {
        const w = want[i] as number
        const v = got[i] as number
        if (Number.isNaN(w)) expect(v).toBeNaN()
        else expect(Math.abs(v - w)).toBeLessThanOrEqual(tol)
      }
      // From the reference's own flattened values the rest must agree exactly.
      const [lo, hi] = colourLimits(want, 0.5)
      expect([lo, hi]).toEqual(c.colour_limits.map(num))
      const rgb = greyRgb(want, lo, hi)
      const grey = (c.grey as number[][]).flat()
      const nan = (c.nan as number[][]).flat()
      grey.forEach((g, i) => {
        if (nan[i] === 1) expect([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]).toEqual([24, 32, 104])
        else expect(rgb[i * 3]).toBe(g)
      })
    })
  }

  it('block means', () => {
    const want = flat(golden.block_mean.values as Num[][])
    const got = blockMean(inputs.frame as Float32Array, NX, NY, golden.block_mean.f)
    expect(got.data.length).toBe(want.length)
    want.forEach((w, i) => {
      if (Number.isNaN(w)) expect(got.data[i]).toBeNaN()
      else expect(Math.abs((got.data[i] as number) - w)).toBeLessThanOrEqual(1e-12 * Math.abs(w))
    })
  })

  it('rendered views are pixel-identical', () => {
    const plane = flat((golden.flatten.find((f) => f.input === 'frame' && f.mode === 'plane') as { values: Num[][] }).values)
    for (const c of golden.render) {
      const region = c.region === null ? null : { x: c.region[0] as number, y: c.region[1] as number, width: c.region[2] as number, height: c.region[3] as number }
      const view = planView(NX, NY, scalePair(NX, NY, 48), region, c.display_max)
      const r = renderValues(plane, NX, view, c.clip_pct)
      expect([r.lo, r.hi]).toEqual(c.limits.map(num))
      const img = decodePng(r.png)
      expect([img.width, img.height]).toEqual([c.width, c.height])
      expect(Buffer.from(img.data).equals(Buffer.from(Uint8Array.from(c.rgb as number[])))).toBe(true)
    }
  })
})

describe('parity with the Python reference: text', () => {
  it('fixed-decimal numbers', () => {
    for (const c of golden.fmt_num) expect(fmtNum(num(c.value as Num), c.digits)).toBe(c.text)
  })

  it('labels', () => {
    for (const c of golden.labels) expect(visualLabel(c.kind, c.attrs as unknown as LabelAttr[])).toBe(c.label)
  })
})

describe('parity with the Python reference: units and rounding', () => {
  const u = golden.units

  it('model units, unit keys and range attributes', () => {
    for (const c of u.display_unit) expect(displayUnit(c.si)).toEqual({ factor: c.factor, unit: c.unit })
    for (const c of u.unit_key) expect(unitKey(c.name, c.unit)).toBe(c.key)
    for (const c of u.range_attr) expect(rangeAttr(c.channel, c.unit)).toBe(c.attr)
  })

  it('decimals from the value span', () => {
    for (const c of u.decimals_for) expect(decimalsFor(c.span === null ? null : num(c.span as Num))).toBe(c.decimals)
  })

  it('single values round like Python, arrays like numpy', () => {
    for (const c of u.rounding) {
      expect(roundTo(c.value, c.decimals)).toBe(c.round_to)
      expect(npRound(c.value, c.decimals)).toBe(c.np_round)
    }
  })

  it('robust spans', () => {
    for (const c of u.robust_span) {
      const got = robustSpan(...(c.arrays as Num[][]).map((a) => a.map(num)))
      if (c.span === null) expect(got).toBeNull()
      else expect(got).toBeCloseTo(c.span, 12)
    }
  })
})

/** Every key of a parsed reply, depth first in insertion order: the order the model reads. */
function keyPaths(obj: unknown, path = '$'): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => keyPaths(v, `${path}[${i}]`))
  if (obj === null || typeof obj !== 'object') return []
  return Object.entries(obj).flatMap(([k, v]) => [`${path}.${k}`, ...keyPaths(v, `${path}.${k}`)])
}

const grid = (rows: Num[][]) => ({ rows: rows.length, cols: (rows[0] as Num[]).length, data: flat(rows) })
/** Heights stored as integers of 1 pm (null: not acquired yet), as the exporter makes them. */
const pmGrid = (rows: readonly (readonly (number | null)[])[]) => ({
  rows: rows.length,
  cols: (rows[0] ?? []).length,
  data: Float64Array.from(rows.flat().map((k) => (k === null ? Number.NaN : Math.fround(k * 1e-12)))),
})

describe('parity with the Python reference: archive summaries and tool replies', () => {
  const A = golden.archive
  const dir = mkdtempSync(join(tmpdir(), 'vm-parity-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const arc = new FrameArchive(join(dir, 'frames'), { displayMax: A.display_max })
  const inp = A.inputs
  const made = [
    arc.addPartial(2, { 'Z/forward': grid(inp.z_forward as Num[][]), 'Z/backward': grid(inp.z_backward as Num[][]), 'Current/forward': grid(inp.current as Num[][]) }, {
      ...(inp.meta_a as PartialMeta),
      geometry: inp.geometry_a,
    }),
    arc.addPartial(3, { Z: grid(inp.flat_z as Num[][]), 'Frequency Shift': grid(inp.df as Num[][]) }, {
      ...(inp.meta_b as PartialMeta),
      geometry: inp.geometry_b,
    }),
    arc.addDerived(3, new Uint8Array(Buffer.from(inp.png_plain_b64, 'base64')), {
      tool: 'stm_fft_peaks', sources: ['t0002.p0'], description: 'log magnitude', labelAttrs: [['peaks', 3]],
    }),
    arc.addDerived(3, new Uint8Array(Buffer.from(inp.png_map_b64, 'base64')), {
      tool: 'stm_frame_diff', sources: ['t0002.p0', 't0002.p0'], geometry: inp.geometry_a, units: { diff: 'm' },
      arrays: { 'diff/forward': grid(inp.diff as Num[][]) },
    }),
    arc.addPartial(4, { Z: pmGrid(inp.k_c) }, { ...(inp.meta_c as PartialMeta), geometry: inp.geometry_c, simS: inp.sim_s_c }),
  ]

  it('allocates the same frame ids and writes the same summaries, keys in the same order', () => {
    expect(made.map((e) => e.fid)).toEqual(A.frames)
    expect(arc.index()).toEqual(A.index)
    expect(keyPaths(arc.index())).toEqual(A.index_key_paths)
  })

  it('labels the stored observations the same way', () => {
    for (const [fid, label] of Object.entries(A.observations)) expect(arc.observation(fid).label).toBe(label)
  })

  it('answers inspect with the same reply, key order and labels', () => {
    for (const c of A.inspect) {
      expect(c.is_error).toBe(false)
      const r = inspect(arc, c.args)
      if (!r.ok) throw new Error(r.error)
      expect(r.reply).toEqual(c.reply)
      expect(keyPaths(r.reply)).toEqual(c.key_paths)
      expect(r.images.map((i) => i.label)).toEqual(c.labels)
    }
  })

  it('answers read_values with the same reply and key order', () => {
    for (const c of A.read_values) {
      expect(c.is_error).toBe(false)
      const r = readValues(arc, c.args)
      if (!r.ok) throw new Error(r.error)
      expect(r.reply).toEqual(c.reply)
      expect(keyPaths(r.reply)).toEqual(c.key_paths)
    }
  })
})

describe('parity with the Python reference: index records read back', () => {
  it('summarizes a saved scan and spectra the same way, keys in the same order', () => {
    for (const c of golden.summaries) {
      const s = entrySummary(entryFromRecord(c.record))
      expect(s).toEqual(c.summary)
      expect(keyPaths(s)).toEqual(c.key_paths)
    }
  })
})

function regionOf(r: readonly number[] | null) {
  return r === null ? null : { x: r[0] as number, y: r[1] as number, width: r[2] as number, height: r[3] as number }
}

describe('parity with the Python reference: graph paper', () => {
  const G = golden.grid

  it('uses the same colour, cell limits and nice steps', () => {
    expect([...GRID_RGB]).toEqual(G.constants.rgb)
    expect(GRID_COLOUR_NAME).toBe(G.constants.colour_name)
    expect([GRID_MAX_CELLS, GRID_MIN_CELL_PX]).toEqual([G.constants.max_cells, G.constants.min_cell_px])
    for (const c of G.nice_step) expect(niceStep(c.x)).toBe(c.step)
  })

  it('gives every view the same spacing and line pixels, downsampled and anisotropic views included', () => {
    for (const c of G.views) {
      const v = planView(c.nx, c.ny, { num: c.num, den: c.den }, regionOf(c.region), c.display_max)
      const g = viewGrid(v, c.nm_per_px_x, c.nm_per_px_y)
      expect(g.spacing_nm).toBe(c.spacing_nm)
      const [i0, j0, i1, j1] = v.native
      expect(gridLines(i0, i1, g.spacing_nm / c.nm_per_px_x, v.up, v.down, v.image_size[0])).toEqual(c.xs)
      expect(gridLines(j0, j1, g.spacing_nm / c.nm_per_px_y, v.up, v.down, v.image_size[1])).toEqual(c.ys)
    }
  })

  it('renders views with the grid pixel-identically', () => {
    const plane = flat((golden.flatten.find((f) => f.input === 'frame' && f.mode === 'plane') as { values: Num[][] }).values)
    for (const c of G.render) {
      const view = planView(NX, NY, scalePair(NX, NY, 48), regionOf(c.region), c.display_max)
      const g = viewGrid(view, c.nm_per_px_x, c.nm_per_px_y)
      expect(g.spacing_nm).toBe(c.spacing_nm)
      const r = renderValues(plane, NX, view, c.clip_pct, undefined, g)
      expect([r.lo, r.hi]).toEqual(c.limits.map(num))
      const img = decodePng(r.png)
      expect([img.width, img.height]).toEqual([c.width, c.height])
      expect(Buffer.from(img.data).equals(Buffer.from(Uint8Array.from(c.rgb as number[])))).toBe(true)
    }
  })

  describe('an archive that draws it', () => {
    const GA = G.archive
    const inp = golden.archive.inputs
    const dir = mkdtempSync(join(tmpdir(), 'vm-parity-grid-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const arc = new FrameArchive(join(dir, 'frames'), { displayMax: GA.display_max, grid: true })
    const made = [
      arc.addPartial(2, { 'Z/forward': grid(inp.z_forward as Num[][]), 'Z/backward': grid(inp.z_backward as Num[][]), 'Current/forward': grid(inp.current as Num[][]) }, {
        ...(inp.meta_a as PartialMeta),
        geometry: inp.geometry_a,
      }),
      arc.addPartial(4, { Z: pmGrid(inp.k_c) }, { ...(inp.meta_c as PartialMeta), geometry: inp.geometry_c, simS: inp.sim_s_c }),
    ]
    const rgbOf = (png: Uint8Array) => Buffer.from(decodePng(png).data)

    it('labels and draws the stored observations the same way', () => {
      expect(made.map((e) => e.fid)).toEqual(GA.frames)
      const want = GA.observation_rgb as Record<string, number[]>
      for (const [fid, label] of Object.entries(GA.observations)) {
        const obs = arc.observation(fid)
        expect(obs.label).toBe(label)
        expect(rgbOf(obs.png).equals(Buffer.from(Uint8Array.from(want[fid] as number[])))).toBe(true)
      }
    })

    it('answers inspect with grid_nm per view, the same key order, labels and pixels', () => {
      const c = GA.inspect
      expect(c.is_error).toBe(false)
      const r = inspect(arc, c.args)
      if (!r.ok) throw new Error(r.error)
      expect(r.reply).toEqual(c.reply)
      expect(keyPaths(r.reply)).toEqual(c.key_paths)
      expect(r.images.map((i) => i.label)).toEqual(c.labels)
      r.images.forEach((im, i) => {
        expect(rgbOf(im.png).equals(Buffer.from(Uint8Array.from(c.rgb[i] as number[])))).toBe(true)
      })
    })
  })
})
