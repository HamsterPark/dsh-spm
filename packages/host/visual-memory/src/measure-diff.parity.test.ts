/**
 * Parity of `stm_frame_diff` with the Python reference (VISUAL-HARNESS §5).
 *
 * `spec/golden/measure_diff.json` is produced by
 * `tools/spec-export/export_measure_diff.py`, which runs VISTA-SPM's
 * `measure.diff` on synthetic frames in a temporary archive (the reference
 * file hashes are recorded in it) and captures what the reference computed on
 * the way: the registration inputs and result, every Nelder–Mead evaluation,
 * the resampled grid, the unmarked difference image and the region marks.
 *
 * Tolerances, and why:
 * - scipy kernels on the golden's inputs (spline filter, order-1/3 shifts,
 *   order-1 `map_coordinates`), Nelder–Mead on analytic functions (every
 *   evaluation, `nit`, `nfev`), the polygon clip, the same-geometry test and the
 *   diverging colour map: exact (`Object.is`) — the same IEEE operations in the
 *   same order.
 * - `register` on the reference's own (captured) inputs: the correlation
 *   surface comes from different FFTs (scipy's pocketfft vs radix-2 here),
 *   which agree to about `eps · log2(N)` of the correlation sums, so the peaks
 *   differ by ~1e-16 and the parabolic start by ~1e-14 px. Nelder–Mead must then
 *   take the same path: the same number of evaluations, the points and the
 *   values differing only by that perturbation carried through its affine steps
 *   (measured ≤ 1.3e-13 px and ≤ 1.3e-15). Tolerances are 100 times the
 *   measured maxima: peaks 1e-13, start 1e-12 px, points and result 1e-11 px,
 *   values 1e-13. The integer outputs (search limit, exclusion radius, edge
 *   flag, refined) exactly.
 * - End to end (each side flattens, resamples and filters its own copy of the
 *   frames): the fitted planes (numpy's SVD `lstsq` vs a projection here) and
 *   the Gaussian kernels (`np.exp` vs `Math.exp`, scipy's symmetric
 *   accumulation) add ~1e-15 relative; measured ≤ 5.1e-14 px and ≤ 2.2e-15 on
 *   the path, ≤ 2.4e-13 on the peaks; tolerances 1e-11 px, 1e-13 and 1e-11.
 *   Everything the model reads is rounded, so the replies, their key order,
 *   the labels and the frame summaries must be equal; the archived difference
 *   values (float32) within one float32 ulp (measured ≤ 0.51); the unmarked
 *   image pixel-identical; the marks within 1e-6 image px.
 * - Except where Nelder–Mead starts ON one of the objective's jumps (register.ts:
 *   the overlap mask changes at integer shifts). Identical frames start at 0 px plus
 *   the FFT's rounding noise, whose sign decides whether the first column takes
 *   part (5e-15 px in the reference): there the path is not compared, the shift is
 *   within the optimizer's own resolution (`xatol` = 2e-3 px), the difference's
 *   NaN pattern (and so the image) may differ along the frame edge, and the
 *   reply must be equal up to the sign of a rounded zero shift.
 * - Parsed replies keep the sign of a rounded zero like Python's (`-0.0`); JSON
 *   text from `JSON.stringify` prints it as `0`.
 * - Error messages: equal, every one.
 * - The numbered marks are drawn by `draw.ts`, not Pillow (spec/deviations.md
 *   D-VMEM-6): positions, radii and texts are compared, not their pixels.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapCoordinates, matOf } from 'dsh-spm-numerics'
import { afterAll, describe, expect, it } from 'vitest'
import golden from '../../../../spec/golden/measure_diff.json' with { type: 'json' }
import { entrySummary, FrameArchive } from './archive.js'
import { clipPolygon, divergingRgb, FRAME_DIFF_DESCRIPTION, frameDiff, frameDiffParameters, sameGeometry, type DiffTrace, type Point } from './frame-diff.js'
import { decodePng } from './png.js'
import { nelderMead } from './nelder-mead.js'
import { shiftConstant, splineFilter3 } from './ndinterp.js'
import { register } from './register.js'

type Arr = { shape: number[]; f32?: string; f64?: string; u8?: string }
type Num = number | string | null

function bytes(b64: string): DataView {
  const u8 = Uint8Array.from(Buffer.from(b64, 'base64'))
  return new DataView(u8.buffer)
}

function f64(a: Arr): Float64Array {
  const v = bytes(a.f64 as string)
  return Float64Array.from({ length: v.byteLength / 8 }, (_, i) => v.getFloat64(i * 8, true))
}

function f32(a: Arr): Float32Array {
  const v = bytes(a.f32 as string)
  return Float32Array.from({ length: v.byteLength / 4 }, (_, i) => v.getFloat32(i * 4, true))
}

function u8(a: Arr): Uint8Array {
  return Uint8Array.from(Buffer.from(a.u8 as string, 'base64'))
}

function num(v: Num): number {
  if (v === 'NaN' || v === null) return NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  return v as number
}

/** Positions where two arrays are not the same double (`Object.is`). */
function differing(got: ArrayLike<number>, want: ArrayLike<number>): number[] {
  expect(got.length).toBe(want.length)
  const out: number[] = []
  for (let i = 0; i < want.length; i += 1) if (!Object.is(got[i], want[i])) out.push(i)
  return out
}

/** Every key of a reply, depth first in insertion order, as the exporter writes them. */
function keyPaths(obj: unknown, path = '$'): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => keyPaths(v, `${path}[${i}]`))
  if (obj === null || typeof obj !== 'object') return []
  return Object.entries(obj).flatMap(([k, v]) => [`${path}.${k}`, ...keyPaths(v, `${path}.${k}`)])
}

/** The value with every -0 replaced by 0. */
function unsignedZeros(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unsignedZeros)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unsignedZeros(x)]))
  return Object.is(v, -0) ? 0 : v
}

describe('measure_diff golden: provenance', () => {
  it('records which reference it was exported from', () => {
    for (const k of ['measure_py_sha256', 'frames_py_sha256', 'archive_py_sha256', 'viewtools_py_sha256', 'protocol_py_sha256'] as const) {
      expect(golden.reference[k]).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(golden.constants).toEqual({ refine_px: 256, max_regions: 30, highpass_nm_default: 3 })
  })
})

describe('parity with the Python reference: scipy kernels, bit for bit', () => {
  it('spline_filter(order=3), mirror boundary', () => {
    for (const c of golden.kernels.spline_filter) {
      const [rows, cols] = c.input.shape as [number, number]
      expect(differing(splineFilter3(f64(c.input), rows, cols), f64(c.output))).toEqual([])
    }
  })

  it('shift(order=1 and 3, mode constant), cubic on prefiltered coefficients', () => {
    let n = 0
    for (const c of golden.kernels.shift) {
      const [rows, cols] = c.input.shape as [number, number]
      const input = f64(c.input)
      c.shifts.forEach((d, k) => {
        const got = shiftConstant(input, rows, cols, d[0] as number, d[1] as number, c.order as 1 | 3)
        expect(differing(got, f64(c.outputs[k] as Arr)), `order ${c.order} shift ${d}`).toEqual([])
        n += 1
      })
    }
    expect(n).toBe(36)
  })

  it("map_coordinates(order=1, mode constant), edges and out-of-range points included (numerics' mapCoordinates)", () => {
    for (const c of golden.kernels.map_coordinates) {
      const [rows, cols] = c.input.shape as [number, number]
      expect(differing(mapCoordinates(matOf(rows, cols, f64(c.input)), c.rows, c.cols, 1, 'constant', 0), f64(c.output))).toEqual([])
    }
  })

  it("Nelder-Mead with the reference's options: the same evaluations, nit and nfev", () => {
    const fns: Record<string, (x: number, y: number) => number> = {
      bowl: (x, y) => (x - 0.3) * (x - 0.3) + 2.0 * (y + 0.7) * (y + 0.7) + 0.5 * x * y,
      rosenbrock: (x, y) => (1.0 - x) * (1.0 - x) + 100.0 * (y - x * x) * (y - x * x),
      constant: () => 1.0,
      plateau: (x, y) => (x * x + y * y > 0.25 ? 1.0 : -0.5 + x * x),
    }
    for (const c of golden.kernels.nelder_mead) {
      const f = fns[c.function] as (x: number, y: number) => number
      const evals: number[][] = []
      const res = nelderMead((d) => {
        const v = f(d[0] as number, d[1] as number)
        evals.push([d[0] as number, d[1] as number, v])
        return v
      }, c.options.initial_simplex, { xatol: c.options.xatol, fatol: c.options.fatol, maxiter: c.options.maxiter })
      expect(evals.length, c.function).toBe(c.evals.length)
      expect(differing(evals.flat(), c.evals.flat()), c.function).toEqual([])
      expect([res.nit, res.nfev]).toEqual([c.nit, c.nfev])
      expect(differing([...res.x, res.fun], [...c.x, c.fun])).toEqual([])
    }
  })

  it("numpy's argsort keeps ties in order, like the stable sort Nelder-Mead uses here", () => {
    for (const c of golden.kernels.argsort) {
      expect(c.values.map((_, i) => i).sort((i, j) => (c.values[i] as number) - (c.values[j] as number))).toEqual(c.order)
    }
  })

  it('polygon clip, same-geometry test and the diverging colour map', () => {
    for (const c of golden.kernels.clip_polygon) {
      const got = clipPolygon(c.subject as unknown as Point[], c.box as unknown as [number, number, number, number])
      expect(got.map((p) => [...p])).toEqual(c.clipped)
    }
    for (const c of golden.kernels.same_geometry) {
      expect(sameGeometry(c.a as never, c.b as never), JSON.stringify(c.b)).toBe(c.same)
    }
    for (const c of golden.kernels.diverging) {
      expect(divergingRgb(f64(c.d), c.L)).toEqual(u8(c.rgb))
    }
  })
})

type Capture = {
  register?: { result: Record<string, Num | boolean>; shape: number[]; a?: Arr; b?: Arr }
  minimize?: { x0: number[]; evals: number[][]; x: number[]; fun: number; nit: number; nfev: number }
  common_grid?: { grid: Record<string, number>; s: number; A?: Arr; B?: Arr }
  diverging?: { L: number; shape: number[]; rgb_sha256: string; rgb?: Arr }
  marks?: { marks: (number | string)[][]; colour: number[]; ring: boolean; image_size: number[] }
}

function expectRegistration(
  got: ReturnType<typeof register>,
  want: Record<string, Num | boolean>,
  tol: { shift: number; peak: number },
): void {
  expect([got.limit_px, got.exclusion_px, got.at_search_edge, got.refined]).toEqual([want['limit_px'], want['exclusion_px'], want['at_search_edge'], want['refined']])
  expect(Math.abs(got.ncc_peak - num(want['ncc_peak'] as Num))).toBeLessThanOrEqual(tol.peak)
  const second = num(want['second_peak'] as Num)
  if (Number.isNaN(second)) expect(got.second_peak).toBeNaN()
  else expect(Math.abs(got.second_peak - second)).toBeLessThanOrEqual(tol.peak)
  const conf = num(want['confidence'] as Num)
  if (Number.isFinite(conf)) expect(Math.abs(got.confidence - conf)).toBeLessThanOrEqual(1e-11 * conf)
  else expect(got.confidence).toBe(conf)
  expect(Math.abs(got.dx - num(want['dx'] as Num))).toBeLessThanOrEqual(tol.shift)
  expect(Math.abs(got.dy - num(want['dy'] as Num))).toBeLessThanOrEqual(tol.shift)
}

function expectEvaluations(got: readonly number[][], want: readonly number[][], tol: { x: number; f: number }): void {
  expect(got.length).toBe(want.length)
  let dx = 0
  let df = 0
  got.forEach((g, i) => {
    const w = want[i] as number[]
    dx = Math.max(dx, Math.abs((g[0] as number) - (w[0] as number)), Math.abs((g[1] as number) - (w[1] as number)))
    df = Math.max(df, Math.abs((g[2] as number) - (w[2] as number)))
  })
  expect(dx).toBeLessThanOrEqual(tol.x)
  expect(df).toBeLessThanOrEqual(tol.f)
}

describe("parity with the Python reference: register on the reference's own inputs", () => {
  const cases = golden.calls.filter((c) => (c as { capture?: Capture }).capture?.register?.a !== undefined)
  it('covers plain, rotated-resampled, weakly correlated and partly acquired pairs', () => {
    expect(cases.map((c) => c.name)).toEqual(['subpixel_shift', 'steps_creep_large_shift', 'resampled_rotated', 'rows_not_acquired'])
  })
  for (const c of cases) {
    it(`${c.name}: same correlation peak, same Nelder-Mead path, same shift`, () => {
      const cap = (c as { capture: Capture }).capture
      const reg = cap.register as Required<NonNullable<Capture['register']>>
      const [rows, cols] = reg.shape as [number, number]
      const evals: number[][] = []
      const got = register(f64(reg.a), f64(reg.b), rows, cols, 0.4, (d, f) => evals.push([d[0] as number, d[1] as number, f]))
      expectRegistration(got, reg.result, { shift: 1e-11, peak: 1e-13 })
      const nm = cap.minimize as NonNullable<Capture['minimize']>
      expect(Math.abs((evals[0]?.[0] as number) - (nm.x0[0] as number))).toBeLessThanOrEqual(1e-12)
      expect(Math.abs((evals[0]?.[1] as number) - (nm.x0[1] as number))).toBeLessThanOrEqual(1e-12)
      expectEvaluations(evals, nm.evals, { x: 1e-11, f: 1e-13 })
    })
  }
})

// ── end to end ──────────────────────────────────────────────────────────────

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function buildArchives(): Record<string, FrameArchive> {
  const root = mkdtempSync(join(tmpdir(), 'vm-diff-parity-'))
  dirs.push(root)
  const out: Record<string, FrameArchive> = {}
  for (const [name, dm] of Object.entries(golden.archives)) out[name] = new FrameArchive(join(root, name), { displayMax: dm })
  const arrays = golden.arrays as Record<string, Arr>
  for (const fr of golden.frames) {
    const data: Record<string, { rows: number; cols: number; data: Float32Array }> = {}
    for (const [k, ref] of fr.arrays as [string, string][]) {
      const a = arrays[ref as string] as Arr
      data[k] = { rows: a.shape[0] as number, cols: a.shape[1] as number, data: f32(a) }
    }
    const e = (out[fr.archive] as FrameArchive).addPartial(fr.turn, data, { geometry: fr.geometry, ...(fr.meta as object) })
    expect(e.fid).toBe(fr.fid)
  }
  const png = Uint8Array.from(Buffer.from(golden.plain_png_b64, 'base64'))
  ;(out['main'] as FrameArchive).addDerived(golden.plain_png_turn, png, {
    tool: 'fft_peaks',
    sources: ['t0000.p0'],
    description: 'a plot',
    labelAttrs: [['plot', 'spectrum']],
  })
  return out
}

describe('parity with the Python reference: diff, end to end', () => {
  const archives = buildArchives()
  const results = new Map<string, { result: ReturnType<typeof frameDiff>; trace: DiffTrace }>()
  for (const c of golden.calls) {
    const trace: DiffTrace = { evaluations: [] }
    results.set(c.name, { result: frameDiff(archives[c.archive] as FrameArchive, c.args, trace), trace })
  }
  const ok = golden.calls.filter((c) => !c.is_error)
  // Identical frames: the parabolic start is 0 px plus the FFT's rounding noise (5e-15 px in the
  // reference), i.e. on the objective's jump at an integer shift; see the header.
  const ON_A_JUMP: ReadonlySet<string> = new Set(['identical'])
  const errors = golden.calls.filter((c) => c.is_error)

  it('covers every case of the golden', () => {
    expect(ok.length).toBe(18)
    expect(errors.length).toBe(21)
  })

  for (const c of ok) {
    it(`${c.name}: the same reply, key order, image label and derived frame`, () => {
      const { result } = results.get(c.name) as { result: ReturnType<typeof frameDiff> }
      if (!result.ok) throw new Error(result.error)
      if (ON_A_JUMP.has(c.name)) expect(unsignedZeros(result.reply)).toEqual(unsignedZeros(c.reply))
      else expect(result.reply).toEqual(c.reply)
      expect(keyPaths(JSON.parse(JSON.stringify(result.reply)))).toEqual(c.key_paths)
      const img = result.images[0]
      expect(result.images).toHaveLength(1)
      const { width, height } = decodePng(img?.png as Uint8Array)
      expect([width, height]).toEqual((c as { image: { size: number[] } }).image.size)
      expect(img?.label).toBe((c as { image: { label: string } }).image.label)
      const derived = (c as { derived: { frame: string; summary: unknown; observation_label: string; values: Arr } }).derived
      const archive = archives[c.archive] as FrameArchive
      expect(entrySummary(archive.get(derived.frame))).toEqual(derived.summary)
      expect(archive.observation(derived.frame).label).toBe(derived.observation_label)
      const got = archive.array(derived.frame, 'diff')
      const want = f32(derived.values)
      expect(got.data.length).toBe(want.length)
      // One float32 ulp; on a jump, the change a shift of 2·xatol can make: 2 · 2e-3 · the largest
      // step between neighbouring pixels of frame a, along each of the two axes.
      const ea = archive.get((c.args as { frame_a: string }).frame_a)
      const za = archive.values(ea, 'Z', 'forward')
      let step = 0
      for (let i = 0; i + 1 < za.length; i += 1) {
        if ((i + 1) % ea.nx !== 0) step = Math.max(step, Math.abs((za[i + 1] as number) - (za[i] as number)))
        if (i + ea.nx < za.length) step = Math.max(step, Math.abs((za[i + ea.nx] as number) - (za[i] as number)))
      }
      const jumpTol = 2 * 2 * 2e-3 * step
      let worst = 0
      for (let i = 0; i < want.length; i += 1) {
        const w = want[i] as number
        const g = got.data[i] as number
        if (!Number.isNaN(w) && !Number.isNaN(g) && ON_A_JUMP.has(c.name)) expect(Math.abs(g - w)).toBeLessThanOrEqual(jumpTol)
        else if (!Number.isNaN(w) && !Number.isNaN(g)) worst = Math.max(worst, Math.abs(g - w) / Math.max(Math.abs(w) * 2 ** -23, 1e-45))
        else if (Number.isNaN(w) !== Number.isNaN(g)) {
          // Only a start on the objective's jump may move the overlap's edge by one pixel.
          const r = Math.floor(i / got.cols)
          const col = i % got.cols
          expect([c.name, ON_A_JUMP.has(c.name) && (r === 0 || col === 0 || r === got.rows - 1 || col === got.cols - 1)]).toEqual([c.name, true])
        }
      }
      expect(worst).toBeLessThanOrEqual(1)
    })

    it(`${c.name}: the same intermediate results (grid, registration path, image, marks)`, () => {
      const { trace } = results.get(c.name) as { trace: DiffTrace }
      const cap = (c as { capture: Capture }).capture
      if (cap.common_grid !== undefined) {
        const cg = trace.commonGrid as NonNullable<DiffTrace['commonGrid']>
        expect(cg.s).toBe(cap.common_grid.s)
        const g = cap.common_grid.grid
        for (const k of ['nx', 'ny', 'angle_deg'] as const) expect(cg.grid[k]).toBe(g[k])
        for (const k of ['cx_nm', 'cy_nm', 'w_nm', 'h_nm'] as const) expect(Math.abs(cg.grid[k] - (g[k] as number))).toBeLessThanOrEqual(1e-12)
        for (const [mine, theirs] of [[cg.A, cap.common_grid.A], [cg.B, cap.common_grid.B]] as const) {
          if (theirs === undefined) continue
          const want = f64(theirs)
          let span = 0
          for (const v of want) if (Number.isFinite(v)) span = Math.max(span, Math.abs(v))
          for (let i = 0; i < want.length; i += 1) {
            if (Number.isNaN(want[i] as number)) expect(mine[i]).toBeNaN()
            else expect(Math.abs((mine[i] as number) - (want[i] as number))).toBeLessThanOrEqual(1e-12 * span)
          }
        }
      } else expect(trace.commonGrid).toBeUndefined()
      if (cap.register !== undefined && ON_A_JUMP.has(c.name)) {
        expectRegistration(trace.registration as NonNullable<DiffTrace['registration']>, cap.register.result, { shift: 2e-3, peak: 1e-11 })
      } else if (cap.register !== undefined) {
        expectRegistration(trace.registration as NonNullable<DiffTrace['registration']>, cap.register.result, { shift: 1e-11, peak: 1e-11 })
        expectEvaluations(trace.evaluations, (cap.minimize as NonNullable<Capture['minimize']>).evals, { x: 1e-11, f: 1e-13 })
      } else expect(trace.registration).toBeUndefined()
      const div = cap.diverging as NonNullable<Capture['diverging']>
      const mine = trace.diverging as NonNullable<DiffTrace['diverging']>
      expect([mine.height, mine.width, 3]).toEqual(div.shape)
      expect(Math.abs(mine.L - div.L)).toBeLessThanOrEqual(1e-12 * div.L)
      if (div.rgb !== undefined) expect(differing(mine.rgb, u8(div.rgb))).toEqual([])
      if (!ON_A_JUMP.has(c.name)) expect(createHash('sha256').update(mine.rgb).digest('hex')).toBe(div.rgb_sha256)
      const marks = (cap.marks as NonNullable<Capture['marks']>).marks
      expect((trace.marks ?? []).map((m) => m.text)).toEqual(marks.map((m) => m[3]))
      ;(trace.marks ?? []).forEach((m, i) => {
        const w = marks[i] as number[]
        expect(Math.abs(m.x - (w[0] as number))).toBeLessThanOrEqual(1e-6)
        expect(Math.abs(m.y - (w[1] as number))).toBeLessThanOrEqual(1e-6)
        expect(Math.abs(m.r - (w[2] as number))).toBeLessThanOrEqual(1e-6)
      })
    })
  }

  it('refuses with the same messages', () => {
    for (const c of errors) {
      const { result } = results.get(c.name) as { result: ReturnType<typeof frameDiff> }
      expect(result.ok, c.name).toBe(false)
      if (result.ok) continue
      expect(Object.keys(c.reply)).toEqual(['error', 'instrument_unchanged'])
      expect([c.name, result.error]).toEqual([c.name, (c.reply as { error: string }).error])
    }
  })

  it('archives the frames and derived maps with the same summaries, in the same order', () => {
    for (const [name, arch] of Object.entries(archives)) {
      expect(arch.index()).toEqual((golden.index as Record<string, unknown[]>)[name])
    }
  })
})

describe('parity with the Python reference: the tool definition', () => {
  it("is the reference's diff tool: description (with dsh's tool names), parameters, enums, required fields", () => {
    const ref = golden.tool
    expect(ref.name).toBe('diff')
    expect(FRAME_DIFF_DESCRIPTION).toBe(ref.description.replace('so read_values and inspect work', 'so stm_read_values and stm_inspect work'))
    const params = frameDiffParameters(768)
    const schema = ref.input_schema as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] }
    expect(Object.keys(params).sort()).toEqual(Object.keys(schema.properties).sort())
    for (const [k, p] of Object.entries(params)) {
      const want = schema.properties[k] as { type: string; enum?: string[] }
      expect([k, p.type]).toEqual([k, want.type])
      expect([k, 'enum' in p ? [...p.enum] : undefined]).toEqual([k, want.enum])
      expect([k, 'required' in p && p.required === true]).toEqual([k, schema.required.includes(k)])
    }
  })
})

