/**
 * `stm_frame_diff`: compare two archived scan frames (VISTA-SPM
 * `measure.diff`, `make_diff_tool`), as a pure function over the archive.
 *
 * 1. Both frames are flattened the same way (default highpass: a median
 *    background of `highpass_nm` = 3 nm, so steps and the bow of piezo creep
 *    do not dominate the correlation).
 * 2. Frames of the same geometry are compared pixel by pixel (within the
 *    region, display pixels of `frame_a`); otherwise both are resampled
 *    bilinearly onto a grid in `frame_a`'s axes covering their overlap in
 *    scan-frame nm, at the coarser pixel size ({@link commonGrid}).
 * 3. With `align` (default) `frame_b` is registered to `frame_a`
 *    ({@link register}) on lightly smoothed copies (highpass) or band-passed
 *    copies (other flattenings); the shift is reported in grid pixels and
 *    scan-frame nm with the correlation peak and a confidence.
 * 4. The difference `b − shifted a`, its median offset and a plane removed, is
 *    archived as a derived frame WITH its values (channel `diff`), so
 *    `stm_read_values` and `stm_inspect` work on it; its image is a diverging
 *    map (red = higher in b, blue = lower, white = unchanged, gray = outside
 *    the overlap).
 * 5. Changed regions: 8-connected pixels above 5 robust noise sigmas (and
 *    at least 0.2 nm across), strongest first, at most {@link MAX_REGIONS}
 *    listed and numbered on the image.
 *
 * It measures change; it does not say why something changed.
 *
 * Reply keys, their order, units in the key suffixes, decimals and error
 * messages follow the reference; `measure_diff.json` pins them
 * (`measure-diff.parity.test.ts`). Adapted for dsh: the tool names in the
 * description (`stm_read_values`, `stm_inspect`) and the argument ranges,
 * moved from the schema into the parameter descriptions (dsh's schema has no
 * ranges).
 */
import { gaussianFilter2d, labelConnected, mapCoordinates, matOf, npSum } from 'dsh-spm-numerics'
import { channelDirections, entryScale, kindWord, type FrameArchive, type FrameEntry } from './archive.js'
import {
  ArgError,
  argsObject,
  boolArg,
  channelDirectionArgs,
  checkKeys,
  failure,
  flattenArgs,
  frameArg,
  MAX_HIGHPASS_NM,
  regionArg,
  type ViewToolResult,
} from './args.js'
import { ChannelError, resolveChannel } from './channels.js'
import { Canvas, drawMarks } from './draw.js'
import { blockMean, fitSurface, flatten, FLATTEN_MODES, HIGHPASS_NM_DEFAULT, nanMedian, type FlattenMode } from './flatten.js'
import { nativeToScanNm, scalePair, scaleText, scanNmToNative, type ScanGeometry } from './geometry.js'
import { shiftConstant } from './ndinterp.js'
import { pyG, pyRepr, pyRound, rint } from './pyfmt.js'
import { register, type Registration } from './register.js'
import { fmtNum, percentileSorted, planView, regionToNative, upscaleRgb, type LabelAttr } from './render.js'
import { DIRECTIONS, type Direction } from './scan-data.js'
import { formatKey, formatValue } from './units.js'

/** At most this many changed regions are listed (and numbered on the image). */
export const MAX_REGIONS = 30

/** Gray for pixels outside the overlap. */
export const OUTSIDE_RGB: readonly [number, number, number] = [64, 64, 64]

/** Colour of the region marks (dark on the light map). */
export const DIFF_MARK_RGB: readonly [number, number, number] = [20, 20, 20]

const KEYS: ReadonlySet<string> = new Set(['frame_a', 'frame_b', 'region', 'channel', 'direction', 'align', 'flatten', 'highpass_nm'])

/** The reference's tool description, with dsh's tool names. */
export const FRAME_DIFF_DESCRIPTION =
  'Compare two archived scan frames without changing the instrument. Both are flattened the same way ' +
  '(default highpass: a median background of highpass_nm = 3 nm is removed, so steps and the bow of ' +
  'piezo creep do not dominate; plane keeps large features); frames ' +
  'with different geometry are resampled onto their overlap in scan-frame nm (at the coarser pixel ' +
  'size), and region (display pixels of frame_a) restricts the comparison. With align=true (default) ' +
  'the content of frame_b is registered to frame_a by sub-pixel normalized cross-correlation: ' +
  'registration.shift_nm is the displacement of the image content from frame_a to frame_b in ' +
  'scan-frame nm (shift_px in grid pixels), with the correlation peak and confidence = main peak / the ' +
  "best correlation farther away than twice the image's correlation length (close to 1 means " +
  'ambiguous, e.g. a bare periodic lattice or parallel stripes; peak_at_search_limit means the shift ' +
  'was not found). The aligned difference (b minus shifted a, median offset and plane removed) is ' +
  'returned as a derived image (red = higher in b, blue = lower in b, white = unchanged, gray = outside ' +
  'the overlap) and archived with its values (difference.frame), so stm_read_values and stm_inspect work on ' +
  'it. Changed regions above 5 robust noise sigmas are numbered with centroid (x_nm, y_nm), sign, ' +
  'area_nm2 and peak change (peak_change_pm for Z). It measures change; it does not say why something ' +
  'changed. Keys carry their unit: _nm, _deg, _px, and for channel values _pm (Z), _pa (current), _hz (frequency shift), _v (voltage).'

/** Parameters of the dsh tool: the reference's schema, ranges moved into the descriptions. */
export function frameDiffParameters(displayMax: number) {
  return {
    frame_a: {
      type: 'string',
      required: true,
      description: "The earlier (reference) scan frame id, e.g. 't0007.s0' (saved scan) or 't0007.p0' (partial scan).",
    },
    frame_b: { type: 'string', required: true, description: "The later scan frame id, e.g. 't0008.s0'." },
    region: {
      type: 'object',
      additionalProperties: false,
      description:
        "Rectangle in display pixels of frame_a's full image that restricts the comparison: origin at the top-left " +
        'corner, x to the right, y down. x and y are integers >= 0, width and height integers >= 1, and the ' +
        `rectangle must lie inside frame_a's display image (at most ${displayMax}x${displayMax}; every frame summary ` +
        'gives its display_size).',
      properties: {
        x: { type: 'integer', required: true },
        y: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
    channel: {
      type: 'string',
      description: "Channel, e.g. 'Z' or 'Current' (1 to 64 characters). Default: the frame's default channel.",
    },
    direction: { type: 'string', enum: [...DIRECTIONS], description: 'Scan pass. Default forward.' },
    flatten: {
      type: 'string',
      enum: [...FLATTEN_MODES],
      description:
        'Background removed from both frames before registering and subtracting. Default highpass (median ' +
        'background of highpass_nm), so steps and the bow of piezo creep do not dominate the correlation; use ' +
        'plane to compare large features.',
    },
    highpass_nm: {
      type: 'number',
      description: `Background width in nm for flatten='highpass': more than 0, at most ${MAX_HIGHPASS_NM}. Default ${HIGHPASS_NM_DEFAULT}.`,
    },
    align: { type: 'boolean', description: 'Register b to a before subtracting. Default true.' },
  } as const
}

// ── geometry ────────────────────────────────────────────────────────────────

type GeometryLike = { readonly [k: string]: number | null | undefined }

function num(g: GeometryLike, k: string): number {
  return Number(g[k] ?? 0) || 0
}

/** The reference's `_same_geometry`: centre, size and angle within 1e-9 (relative to the value, at least absolute), same pixels. */
export function sameGeometry(ga: GeometryLike, gb: GeometryLike): boolean {
  for (const k of ['cx_nm', 'cy_nm', 'w_nm', 'h_nm', 'angle_deg']) {
    if (Math.abs(num(ga, k) - num(gb, k)) > 1e-9 * Math.max(1.0, Math.abs(num(ga, k)))) return false
  }
  return Math.trunc(Number(ga['nx'])) === Math.trunc(Number(gb['nx'])) && Math.trunc(Number(ga['ny'])) === Math.trunc(Number(gb['ny']))
}

export type Point = readonly [number, number]

/** Sutherland–Hodgman clip of a polygon by the axis-aligned box `[u0, v0, u1, v1]` (`_clip_polygon`). */
export function clipPolygon(subject: readonly Point[], box: readonly [number, number, number, number]): Point[] {
  const [u0, v0, u1, v1] = box
  const cross = (val: number, axis: 0 | 1) => (p: Point, q: Point): Point => {
    const t = (val - p[axis]) / (q[axis] - p[axis])
    return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
  }
  const edges: readonly [(p: Point) => boolean, (p: Point, q: Point) => Point][] = [
    [(p) => p[0] >= u0, cross(u0, 0)],
    [(p) => p[0] <= u1, cross(u1, 0)],
    [(p) => p[1] >= v0, cross(v0, 1)],
    [(p) => p[1] <= v1, cross(v1, 1)],
  ]
  let poly: Point[] = [...subject]
  for (const [inside, at] of edges) {
    if (poly.length === 0) break
    const out: Point[] = []
    poly.forEach((cur, i) => {
      const prev = poly[(i - 1 + poly.length) % poly.length] as Point
      if (inside(cur)) {
        if (!inside(prev)) out.push(at(prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(at(prev, cur))
    })
    poly = out
  }
  return poly
}

function radians(deg: number): number {
  return deg * (Math.PI / 180)
}

/** Scan-frame nm → the frame's own axes (u right, v up) about its centre (`_uv_of`). */
function uvOf(g: ScanGeometry, X: number, Y: number): Point {
  const a = radians(g.angle_deg)
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dX = X - g.cx_nm
  const dY = Y - g.cy_nm
  return [c * dX + s * dY, -s * dX + c * dY]
}

/** Pixel size `(x, y)` of a scan frame in nm (`_pixel_nm`). */
function pixelNm(e: FrameEntry): [number, number] {
  const dx = e.nm_per_px as number
  return [dx, e.extra.nm_per_px_y || dx]
}

/** Two frames resampled onto one grid. */
export interface CommonGrid {
  readonly A: Float64Array
  readonly B: Float64Array
  readonly grid: ScanGeometry
  /** Grid spacing (nm), the coarser pixel size of the two. */
  readonly s: number
}

/**
 * The reference's `_common_grid`: both frames resampled (bilinear, NaN outside
 * a frame or next to a missing pixel) onto a grid in frame a's axes covering
 * their overlap within `boxA` (native pixels of a), spacing = the coarser pixel
 * size. Throws {@link ArgError} when they do not overlap or the overlap is
 * under 16 × 16 grid pixels.
 */
export function commonGrid(ea: FrameEntry, eb: FrameEntry, za: Float64Array, zb: Float64Array, boxA: readonly [number, number, number, number]): CommonGrid {
  const ga = ea.geometry as ScanGeometry
  const gb = eb.geometry as ScanGeometry
  const s = Math.max(...pixelNm(ea), ...pixelNm(eb))
  const [i0, j0, i1, j1] = boxA
  const ua0 = -ga.w_nm / 2 + (i0 * ga.w_nm) / ga.nx
  const ua1 = -ga.w_nm / 2 + (i1 * ga.w_nm) / ga.nx
  const va1 = ga.h_nm / 2 - (j0 * ga.h_nm) / ga.ny
  const va0 = ga.h_nm / 2 - (j1 * ga.h_nm) / ga.ny
  const corners: Point[] = [[0, 0], [gb.nx, 0], [gb.nx, gb.ny], [0, gb.ny]]
  const quad = corners.map(([c, r]) => uvOf(ga, ...nativeToScanNm(gb, c, r)))
  const poly = clipPolygon(quad, [ua0, va0, ua1, va1])
  if (poly.length < 3) {
    const whole = i0 === 0 && j0 === 0 && i1 === ea.nx && j1 === ea.ny
    throw new ArgError(`${ea.fid} and ${eb.fid} do not overlap${whole ? '' : ' inside the region'}`)
  }
  const us = poly.map((p) => p[0])
  const vs = poly.map((p) => p[1])
  const uMin = Math.min(...us)
  const vMax = Math.max(...vs)
  const gw = Math.floor((Math.max(...us) - uMin) / s)
  const gh = Math.floor((vMax - Math.min(...vs)) / s)
  if (gw < 16 || gh < 16) throw new ArgError(`the overlap of ${ea.fid} and ${eb.fid} is only ${gw}x${gh} pixels of ${pyG(s, 3)} nm`)
  const a = radians(ga.angle_deg)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const X = new Float64Array(gw * gh)
  const Y = new Float64Array(gw * gh)
  for (let j = 0; j < gh; j += 1) {
    const v = vMax - (j + 0.5) * s
    for (let i = 0; i < gw; i += 1) {
      const u = uMin + (i + 0.5) * s
      X[j * gw + i] = ga.cx_nm + cos * u - sin * v
      Y[j * gw + i] = ga.cy_nm + sin * u + cos * v
    }
  }
  const sample = (e: FrameEntry, z: Float64Array): Float64Array => {
    const g = e.geometry as ScanGeometry
    const rows = new Float64Array(X.length)
    const cols = new Float64Array(X.length)
    for (let k = 0; k < X.length; k += 1) {
      const [c, r] = scanNmToNative(g, X[k] as number, Y[k] as number)
      cols[k] = c - 0.5
      rows[k] = r - 0.5
    }
    const out = mapCoordinates(matOf(e.ny, e.nx, z.map((v) => (Number.isFinite(v) ? v : 0))), rows, cols, 1, 'constant', 0)
    const m = mapCoordinates(matOf(e.ny, e.nx, z.map((v) => (Number.isFinite(v) ? 1 : 0))), rows, cols, 1, 'constant', 0)
    return out.map((v, k) => {
      const c = cols[k] as number
      const r = rows[k] as number
      const inside = c >= -0.5 && c <= e.nx - 0.5 && r >= -0.5 && r <= e.ny - 0.5
      return (m[k] as number) > 0.999 && inside ? v : NaN
    })
  }
  const uc = uMin + (gw * s) / 2
  const vc = vMax - (gh * s) / 2
  const grid: ScanGeometry = {
    cx_nm: ga.cx_nm + cos * uc - sin * vc,
    cy_nm: ga.cy_nm + sin * uc + cos * vc,
    w_nm: gw * s,
    h_nm: gh * s,
    angle_deg: ga.angle_deg,
    nx: gw,
    ny: gh,
  }
  return { A: sample(ea, za), B: sample(eb, zb), grid, s }
}

// ── filters ─────────────────────────────────────────────────────────────────

function clip(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

function gaussian(z: Float64Array, rows: number, cols: number, sigma: number): Float64Array {
  return gaussianFilter2d(matOf(rows, cols, z), sigma).data
}

/** Light NaN-aware smoothing (0.5 nm, 0.7..3 px) so registration follows features, not pixel noise (`_lowpass`). */
export function lowpass(z: Float64Array, rows: number, cols: number, sNm: number): Float64Array {
  const sig = clip(0.5 / sNm, 0.7, 3.0)
  const numr = gaussian(z.map((v) => (Number.isFinite(v) ? v : 0)), rows, cols, sig)
  const den = gaussian(z.map((v) => (Number.isFinite(v) ? 1 : 0)), rows, cols, sig)
  return z.map((v, i) => (Number.isFinite(v) && (den[i] as number) > 0.5 ? (numr[i] as number) / Math.max(den[i] as number, 1e-9) : NaN))
}

/** The difference of two Gaussians: background wider than 2 nm (at least 8 px) removed, then `lowpass` (`_bandpass`). */
export function bandpass(z: Float64Array, rows: number, cols: number, sNm: number): Float64Array {
  let count = 0
  const zeroFilled = z.map((v) => {
    if (Number.isNaN(v)) return 0
    count += 1
    return v
  })
  const mean = npSum(zeroFilled) / count
  const zf = z.map((v) => (Number.isFinite(v) ? v : mean))
  const bg = gaussian(zf, rows, cols, Math.max(8.0, 2.0 / sNm))
  const hp = zf.map((v, i) => v - (bg[i] as number))
  const lp = gaussian(hp, rows, cols, clip(0.5 / sNm, 0.7, 3.0))
  return z.map((v, i) => (Number.isFinite(v) ? (lp[i] as number) : NaN))
}

/** `out(p) = a(p − d)` (bilinear); NaN where the source is outside or next to a NaN (`_shift_image`). */
function shiftImage(a: Float64Array, rows: number, cols: number, dy: number, dx: number): Float64Array {
  const out = shiftConstant(a.map((v) => (Number.isFinite(v) ? v : 0)), rows, cols, dy, dx, 1)
  const m = shiftConstant(a.map((v) => (Number.isFinite(v) ? 1 : 0)), rows, cols, dy, dx, 1)
  return out.map((v, i) => ((m[i] as number) > 0.999 ? v : NaN))
}

// ── image ───────────────────────────────────────────────────────────────────

/**
 * The diverging map (`_diverging_rgb`): `t = clip(d / L, −1, 1)`; red = higher
 * in b, blue = lower, white = 0; NaN (outside the overlap) gray.
 */
export function divergingRgb(d: ArrayLike<number>, L: number): Uint8Array {
  const out = new Uint8Array(d.length * 3)
  for (let i = 0; i < d.length; i += 1) {
    const v = d[i] as number
    if (!Number.isFinite(v)) {
      out.set(OUTSIDE_RGB, i * 3)
      continue
    }
    const t = clip(v / L, -1.0, 1.0)
    const pos = clip(t, 0, 1)
    const neg = clip(-t, 0, 1)
    out[i * 3] = rint(255 * (1 - neg * 0.85))
    out[i * 3 + 1] = rint(255 * (1 - 0.85 * (pos + neg)))
    out[i * 3 + 2] = rint(255 * (1 - pos * 0.85))
  }
  return out
}

/** A numbered mark on the difference image: centre, radius (image pixels), text. */
export interface Mark {
  readonly x: number
  readonly y: number
  readonly r: number
  readonly text: string
}

/**
 * PNG of the difference image with its numbered region marks, dark rings and
 * numbers as the reference draws them (`_draw_marks(…, colour=(20, 20, 20))`;
 * the pixels are draw.ts's, spec/deviations.md D-VMEM-6).
 */
function diffPng(rgb: Uint8Array, width: number, height: number, marks: readonly Mark[]): Uint8Array {
  const canvas = Canvas.fromRgb(width, height, rgb)
  drawMarks(canvas, marks, { colour: DIFF_MARK_RGB })
  return canvas.png()
}

// ── the tool ────────────────────────────────────────────────────────────────

function imageEntry(archive: FrameArchive, args: Record<string, unknown>, key: string): FrameEntry {
  const e = frameArg(archive, args[key], key, true)
  const isImage = e.geometry !== null && (e.kind === 's' || e.kind === 'p' || e.kind === 'm') && e.channels.length > 0
  if (!isImage) throw new ArgError(`${key}: ${e.fid} is a ${kindWord(e)}; this tool needs a scan frame`)
  return e
}

function flatFrame(archive: FrameArchive, e: FrameEntry, ch: string, direction: Direction, mode: FlattenMode, hp: number): Float64Array {
  const [dx, dy] = pixelNm(e)
  return flatten(archive.values(e, ch, direction), e.nx, e.ny, mode, { nmPerPx: Math.sqrt(dx * dy), highpassNm: hp })
}

/** 1.4826 × the median absolute deviation of the finite values (`_mad_sigma`; here never empty). */
function madSigma(v: Float64Array): number {
  const fin = v.filter((x) => Number.isFinite(x))
  const med = nanMedian(fin)
  return 1.4826 * nanMedian(fin.map((x) => Math.abs(x - med)))
}

function percentile(values: Float64Array, q: number): number {
  return percentileSorted(Float64Array.from(values).sort(), q)
}

function crop(z: Float64Array, cols: number, box: readonly [number, number, number, number]): Float64Array {
  const [i0, j0, i1, j1] = box
  const w = i1 - i0
  const out = new Float64Array(w * (j1 - j0))
  for (let r = j0; r < j1; r += 1) out.set(z.subarray(r * cols + i0, r * cols + i1), (r - j0) * w)
  return out
}

/**
 * What {@link frameDiff} computed on the way, for the parity test (the golden
 * exporter captures the same from the reference). Filled when passed.
 */
export interface DiffTrace {
  commonGrid?: CommonGrid
  registerInputs?: { readonly a: Float64Array; readonly b: Float64Array; readonly rows: number; readonly cols: number }
  registration?: Registration
  /** Every Nelder–Mead evaluation: `[dy, dx, value]`. */
  readonly evaluations: [number, number, number][]
  diverging?: { readonly L: number; readonly rgb: Uint8Array; readonly width: number; readonly height: number }
  marks?: readonly Mark[]
}

interface Region {
  sign: '+' | '-'
  x_nm: number
  y_nm: number
  area_nm2: number
  peak: number | null
  c: number
  r: number
  score: number
  n: number
}

/** `diff(frame_a, frame_b, …)`: see the module comment. Never throws. */
export function frameDiff(archive: FrameArchive, args: unknown, trace?: DiffTrace): ViewToolResult {
  try {
    const a = argsObject(args)
    checkKeys(a, KEYS, ['frame_a', 'frame_b'], 'arguments')
    const ea = imageEntry(archive, a, 'frame_a')
    const eb = imageEntry(archive, a, 'frame_b')
    if (ea.kind === 'm' || eb.kind === 'm') throw new ArgError('diff compares scan frames (kinds s or p)')
    const [ch, direction] = channelDirectionArgs(archive, ea, a, 'arguments')
    let chB: string
    try {
      chB = resolveChannel(ch, eb.channels, eb.units)
    } catch (err) {
      throw err instanceof ChannelError ? new ArgError(`frame_b: ${err.message}`) : err
    }
    const dirsB = channelDirections(eb, chB)
    if (!dirsB.includes(direction)) throw new ArgError(`frame_b ${eb.fid} channel ${pyRepr(chB)} has only ${pyRepr(dirsB)}`)
    const align = boolArg(a, 'align', 'arguments', true)
    const [mode, hp] = flattenArgs(a, 'arguments', 'highpass')
    const region = regionArg(ea, a, 'arguments')
    const box = regionToNative(region, ea.nx, ea.ny, entryScale(ea))
    const za = flatFrame(archive, ea, ch, direction, mode, hp)
    const zb = flatFrame(archive, eb, chB, direction, mode, hp)
    const ga = ea.geometry as ScanGeometry
    const same = sameGeometry(ga as unknown as GeometryLike, eb.geometry as unknown as GeometryLike)
    let A: Float64Array
    let B: Float64Array
    let grid: ScanGeometry
    let sx: number
    let sy: number
    if (same) {
      const [i0, j0, i1, j1] = box
      A = crop(za, ea.nx, box)
      B = crop(zb, eb.nx, box)
      ;[sx, sy] = pixelNm(ea)
      const [Xc, Yc] = nativeToScanNm(ga, (i0 + i1) / 2.0, (j0 + j1) / 2.0)
      grid = { cx_nm: Xc, cy_nm: Yc, w_nm: (i1 - i0) * sx, h_nm: (j1 - j0) * sy, angle_deg: ga.angle_deg, nx: i1 - i0, ny: j1 - j0 }
      if (Math.min(grid.nx, grid.ny) < 16) throw new ArgError('the compared region must be at least 16 x 16 scan pixels')
    } else {
      const cg = commonGrid(ea, eb, za, zb, box)
      if (trace !== undefined) trace.commonGrid = cg
      A = cg.A
      B = cg.B
      grid = cg.grid
      sx = cg.s
      sy = cg.s
    }
    const { nx, ny } = grid
    let reg: Registration | null = null
    let dxPx = 0.0
    let dyPx = 0.0
    if (align) {
      const sNm = Math.sqrt(sx * sy)
      const prep = mode === 'highpass' ? lowpass : bandpass // highpass already removed the background
      const pa = prep(A, ny, nx, sNm)
      const pb = prep(B, ny, nx, sNm)
      if (trace !== undefined) trace.registerInputs = { a: pa, b: pb, rows: ny, cols: nx }
      reg = register(pa, pb, ny, nx, 0.4, trace === undefined ? undefined : (d, f) => trace.evaluations.push([d[0] as number, d[1] as number, f]))
      if (trace !== undefined) trace.registration = reg
      dxPx = reg.dx
      dyPx = reg.dy
    }
    const aShifted = align ? shiftImage(A, ny, nx, dyPx, dxPx) : A
    let D = B.map((v, i) => v - (aShifted[i] as number))
    if (D.filter((v) => Number.isFinite(v)).length < 64) throw new ArgError('too few pixels overlap after alignment to form a difference')
    const offset = nanMedian(D)
    D = D.map((v) => v - offset)
    const plane = fitSurface(D, nx, ny, 1)
    D = D.map((v, i) => v - (plane[i] as number))
    const sigma = madSigma(D)
    const finA = A.filter((v) => Number.isFinite(v)) // not empty: D has finite pixels
    const spanA = percentile(finA, 99.5) - percentile(finA, 0.5)
    const thr = Math.max(5.0 * sigma, 1e-6 * spanA, 1e-30) // identical frames: no "changes" from rounding
    const fmt = archive.fmt(ea, ch)
    const root = 0.2 / Math.sqrt(sx * sy)
    const minArea = Math.max(4, Math.ceil(root * root))
    const regions: Region[] = []
    for (const sign of [1.0, -1.0]) {
      const lab = labelConnected(matOf(ny, nx, D.map((v) => (Number.isFinite(v) && sign * v > thr ? 1 : 0))), 8)
      const pixels: number[][] = Array.from({ length: lab.count }, () => [])
      lab.labels.forEach((l, i) => {
        if (l > 0) (pixels[l - 1] as number[]).push(i)
      })
      for (const px of pixels) {
        if (px.length < minArea) continue
        const w = px.map((i) => Math.abs(D[i] as number))
        const sw = npSum(w)
        const c = npSum(w.map((v, k) => v * (((px[k] as number) % nx) + 0.5))) / sw
        const r = npSum(w.map((v, k) => v * (Math.floor((px[k] as number) / nx) + 0.5))) / sw
        const [X, Y] = nativeToScanNm(grid, c, r)
        const peak = sign * w.reduce((m, v) => (v > m ? v : m), -Infinity)
        regions.push({
          sign: sign > 0 ? '+' : '-',
          x_nm: pyRound(X, 4),
          y_nm: pyRound(Y, 4),
          area_nm2: pyRound(px.length * sx * sy, 4),
          peak: formatValue(fmt, peak),
          c,
          r,
          score: Math.abs(peak) * px.length,
          n: px.length,
        })
      }
    }
    regions.sort((p, q) => q.score - p.score)
    const nTotal = regions.length
    const listed = regions.slice(0, MAX_REGIONS)
    // The derived map with values.
    const dm = archive.displayMax
    const scale = scalePair(nx, ny, dm)
    const absFin = D.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v))
    const L = Math.max(1.5 * thr, percentile(absFin, 99.5), 1e-30)
    const view = planView(nx, ny, scale, null, dm)
    const small = view.down === 1 ? { nx, ny, data: D } : blockMean(D, nx, ny, view.down)
    const smallRgb = divergingRgb(small.data, L)
    if (trace !== undefined) trace.diverging = { L, rgb: smallRgb, width: small.nx, height: small.ny }
    const rgb = upscaleRgb(smallRgb, small.nx, small.ny, view.up)
    const marks: Mark[] = listed.map((rg, k) => ({
      x: (rg.c * view.up) / view.down,
      y: (rg.r * view.up) / view.down,
      r: Math.max(7.0, (Math.sqrt(rg.n / Math.PI) * view.up) / view.down + 4.0),
      text: String(k + 1),
    }))
    if (trace !== undefined) trace.marks = marks
    const png = diffPng(rgb, view.image_size[0], view.image_size[1], marks)
    const attrs: LabelAttr[] = [
      ['channel', ch],
      ['direction', direction],
      ['map', 'b minus aligned a'],
      ['color', `red +, blue -, white 0, full color at +-${fmtNum(L * fmt.factor, fmt.decimals)} ${fmt.unit}`],
      ['scale', scaleText(scale)],
      ['marks', `${marks.length} numbered regions`],
    ]
    const de = archive.addDerived(archive.currentTurn, png, {
      tool: 'diff',
      sources: [ea.fid, eb.fid],
      description: `${eb.fid} minus aligned ${ea.fid} (${ch} ${direction})`,
      labelAttrs: attrs,
      arrays: { 'diff/forward': { rows: ny, cols: nx, data: D } },
      geometry: grid,
      units: { diff: ea.units[ch] ?? '' },
    })
    const block = archive.observation(de.fid)
    const body: Record<string, unknown> = { instrument_unchanged: true, frame_a: ea.fid, frame_b: eb.fid, channel: ch, direction, flatten: mode }
    if (mode === 'highpass') body['highpass_nm'] = hp
    body['same_geometry'] = same
    body['grid'] = {
      nm_per_px: [pyRound(sx, 6), pyRound(sy, 6)],
      size_px: [nx, ny],
      field_nm: [pyRound(grid.w_nm, 4), pyRound(grid.h_nm, 4)],
      center_nm: [pyRound(grid.cx_nm, 4), pyRound(grid.cy_nm, 4)],
      resampled: !same,
    }
    body['align'] = align
    if (reg !== null) {
      const a = radians(grid.angle_deg)
      const du = dxPx * sx
      const dv = -dyPx * sy
      const dX = Math.cos(a) * du - Math.sin(a) * dv
      const dY = Math.sin(a) * du + Math.cos(a) * dv
      body['registration'] = {
        shift_nm: [pyRound(dX, 4), pyRound(dY, 4)],
        shift_px: [pyRound(dxPx, 3), pyRound(dyPx, 3)],
        ncc_peak: pyRound(reg.ncc_peak, 4),
        second_peak: Number.isFinite(reg.second_peak) ? pyRound(reg.second_peak, 4) : null,
        second_peak_min_distance_px: pyRound(reg.exclusion_px, 1),
        confidence: Number.isFinite(reg.confidence) ? pyRound(reg.confidence, 3) : null,
        search_limit_px: reg.limit_px,
        peak_at_search_limit: reg.at_search_edge,
      }
    }
    const difference: Record<string, unknown> = {
      frame: de.fid,
      [formatKey(fmt, 'offset_removed')]: formatValue(fmt, offset),
      plane_removed: true,
      [formatKey(fmt, 'noise')]: formatValue(fmt, sigma),
      [formatKey(fmt, 'threshold')]: formatValue(fmt, thr),
      n_regions: nTotal,
      regions: listed.map((rg, k) => ({
        sign: rg.sign,
        x_nm: rg.x_nm,
        y_nm: rg.y_nm,
        area_nm2: rg.area_nm2,
        [formatKey(fmt, 'peak_change')]: rg.peak,
        id: k + 1,
      })),
    }
    if (nTotal > listed.length) difference['regions_listed'] = listed.length
    body['difference'] = difference
    return { ok: true, reply: body, images: [{ png: block.png, label: block.label, name: `${de.fid}.png` }] }
  } catch (err) {
    return failure('diff', err)
  }
}

