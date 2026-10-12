/**
 * The two visual-memory tools as pure functions over an archive:
 * `inspect` (look again) and `read_values` (read exact values). VISTA's
 * `inspect` / `read_pixels` ported to STM frames, with the Python reference's
 * (`vista_spm.viewtools`) argument rules, reply fields and messages.
 *
 * Both are read-only: they never touch the instrument, only the archive.
 *
 * - `inspect(question, views[1..16])` re-renders each view from the archived
 *   values (not from the stored PNG): channel, direction, flattening, contrast
 *   and an exact region in display pixels of the frame's full image. The region
 *   is widened to whole scan pixels and enlarged by the largest whole number of
 *   image pixels per scan pixel that fits the display size (never smoothed),
 *   one image per view, in request order. A spectrum renders as a line plot
 *   (`x_col`, `y_col`, `x_range` instead of a region); derived images are
 *   cropped as stored.
 * - `read_values(question, views[1..64])` samples archived physical values at
 *   cell centers — display pixel `x + floor(((2c+1)·w) / (2C))`, likewise for
 *   y — at most 4096 samples per call, in the model unit carried by the key
 *   (`values_pm`, `values_pa`, …), rounded to the channel's decimals (about
 *   1/100 of its value span), `null` where nothing was acquired. A spectrum
 *   view reads `n` of the `N` points inside `x_range` at bin centers — point
 *   `floor(((2i+1)·N) / (2n))` of them — from the x column and the `y_cols`,
 *   each column in its own model unit (`column_units`) and decimals.
 *
 * Replies follow the reference's model-facing vocabulary: a frame id is under
 * `frame`, units are key suffixes (`black_pm`, `image_size_px`, `corners_nm`),
 * there is no `unit` or `visual_kind` field, and spelling is American.
 *
 * Invalid arguments come back as `{ ok: false, error }` with a message that says
 * what to change; these functions never throw.
 */
import { pyFloatRepr } from 'dsh-spm-kernel'
import {
  ArgError,
  channelDirectionArgs,
  checkKeys,
  failure,
  flattenArgs,
  frameArg,
  labelArg,
  MAX_CLIP_PCT,
  numArg,
  only,
  questionArg,
  regionArg,
  strArg,
  viewsArg,
  xRangeArg,
  type Obj,
  type ViewImage,
  type ViewToolResult,
} from './args.js'
import { ArchiveError, entryScale, kindName, type FrameArchive, type FrameEntry, type RenderMeta } from './archive.js'
import { CLIP_PCT_DEFAULT } from './render.js'
import { type FlattenMode } from './flatten.js'
import { displayToScanNm, type ScalePair, type ScanGeometry } from './geometry.js'
import { pyG, pyRound } from './pyfmt.js'
import type { Region } from './render.js'
import { type Direction } from './scan-data.js'
import { inRange, nanExtent } from './spectrum.js'
import { formatKey, formatValues, unitKey, type ChannelFormat } from './units.js'

export const MAX_INSPECT_VIEWS = 16
export const MAX_READ_VIEWS = 64
export const MAX_READ_SAMPLES = 4096

export {
  ArgError,
  MAX_CLIP_PCT,
  MAX_HIGHPASS_NM,
  MAX_LABEL_CHARS,
  MAX_QUESTION_CHARS,
  type ViewImage,
  type ViewToolResult,
} from './args.js'

// ── inspect ──────────────────────────────────────────────────────────────

const INSPECT_SCAN_KEYS: ReadonlySet<string> = new Set(['label', 'frame', 'channel', 'direction', 'region', 'flatten', 'highpass_nm', 'clip_pct'])
const INSPECT_SPEC_KEYS: ReadonlySet<string> = new Set(['label', 'frame', 'x_col', 'y_col', 'x_range'])
const INSPECT_DERIVED_KEYS: ReadonlySet<string> = new Set(['label', 'frame', 'region'])
const INSPECT_ALL_KEYS: ReadonlySet<string> = new Set([...INSPECT_SCAN_KEYS, ...INSPECT_SPEC_KEYS])
const TOP_KEYS: ReadonlySet<string> = new Set(['question', 'views'])

interface InspectPlan {
  readonly label: string
  readonly e: FrameEntry
  readonly scan?: { channel: string; direction: Direction; flatten: FlattenMode; highpassNm: number; clipPct: number }
  readonly spectrum?: { xCol: string | null; yCol: string | null; xRange: [number, number] | null }
  readonly region: Region | null
}

/** Python `float(f"{v:.6g}")`; a non-finite value stays, and the reply text carries it as null (spec/deviations.md D-VMEM-14). */
function g6(v: number): number {
  return Number.isFinite(v) ? Number(pyG(v, 6)) : v
}

function viewSummary(i: number, label: string, e: FrameEntry, meta: RenderMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { index: i, label, frame: e.fid, kind: kindName(e) }
  if (e.kind === 's' || e.kind === 'p') {
    const fmt = meta.fmt as ChannelFormat
    out['channel'] = meta.channel
    out['direction'] = meta.direction
    out['flatten'] = meta.flatten
    if (meta.highpass_nm !== undefined && meta.highpass_nm !== null) out['highpass_nm'] = meta.highpass_nm
    Object.assign(out, {
      region_px: meta.region_px,
      native_px: meta.native_px,
      image_size_px: meta.image_size_px,
      magnification: meta.magnification,
      image_px_per_scan_px: meta.image_px_per_scan_px,
      nm_per_image_px: meta.nm_per_image_px,
      corners_nm: meta.corners_nm,
    })
    if (meta.grid_nm !== undefined && meta.grid_nm !== null) out['grid_nm'] = meta.grid_nm
    out[formatKey(fmt, 'black')] = meta.black ?? null
    out[formatKey(fmt, 'white')] = meta.white ?? null
    out[formatKey(fmt, 'min')] = meta.min ?? null
    out[formatKey(fmt, 'max')] = meta.max ?? null
    if (e.acquired_rows !== null && e.acquired_rows < e.ny) {
      out['rows_acquired'] = e.acquired_rows
      out['rows_total'] = e.ny
    }
  } else if (e.kind === 'd') {
    const xUnit = meta.x_unit as string
    Object.assign(out, {
      x_col: meta.x_col,
      x_unit: xUnit,
      y: meta.y,
      n_points: meta.n_points,
      [unitKey('x_shown', xUnit)]: (meta.x_shown as readonly [number, number]).map(g6),
      image_size_px: meta.image_size_px,
    })
  } else {
    Object.assign(out, { tool: meta.tool ?? null, region_px: meta.region_px, image_size_px: meta.image_size_px, magnification: meta.magnification })
  }
  return out
}

/** `inspect(question, views)`: see the module comment. Never throws. */
export function inspect(archive: FrameArchive, args: unknown): ViewToolResult {
  try {
    checkKeys(args, TOP_KEYS, ['question', 'views'], 'arguments')
    questionArg(args)
    const views = viewsArg(args, MAX_INSPECT_VIEWS)
    const plans: InspectPlan[] = views.map((v, k) => {
      const where = `views[${k + 1}]`
      checkKeys(v, INSPECT_ALL_KEYS, ['label', 'frame'], where)
      const label = labelArg(v, where)
      const e = frameArg(archive, v['frame'], `${where}.frame`)
      if (e.kind === 's' || e.kind === 'p') {
        only(v, INSPECT_SCAN_KEYS, where, 'a scan')
        const [channel, direction] = channelDirectionArgs(archive, e, v, where)
        const [flatten, highpassNm] = flattenArgs(v, where)
        const clipPct = numArg(v, 'clip_pct', where, { def: CLIP_PCT_DEFAULT, lo: 0, hi: MAX_CLIP_PCT }) as number
        return { label, e, scan: { channel, direction, flatten, highpassNm, clipPct }, region: regionArg(e, v, where) }
      }
      if (e.kind === 'd') {
        only(v, INSPECT_SPEC_KEYS, where, 'a spectrum')
        const xCol = strArg(v, 'x_col', where, { maxLen: 64 }) ?? null
        const yCol = strArg(v, 'y_col', where, { maxLen: 64 }) ?? null
        return { label, e, spectrum: { xCol, yCol, xRange: xRangeArg(v, where) }, region: null }
      }
      only(v, INSPECT_DERIVED_KEYS, where, 'a derived image')
      return { label, e, region: regionArg(e, v, where) }
    })
    const n = plans.length
    const images: ViewImage[] = []
    const out: Record<string, unknown>[] = []
    plans.forEach((p, k) => {
      const i = k + 1
      let rendered
      try {
        rendered = archive.render(p.e.fid, {
          labelKind: 'inspection',
          labelAttrs: [['index', i], ['count', n], ['label', p.label]],
          region: p.region,
          ...(p.scan === undefined
            ? {}
            : { channel: p.scan.channel, direction: p.scan.direction, flatten: p.scan.flatten, highpassNm: p.scan.highpassNm, clipPct: p.scan.clipPct }),
          ...(p.spectrum === undefined ? {} : { xCol: p.spectrum.xCol, yCol: p.spectrum.yCol, xRange: p.spectrum.xRange }),
        })
      } catch (err) {
        if (err instanceof ArchiveError) throw new ArgError(`views[${i}]: ${err.message}`)
        throw err
      }
      images.push({ png: rendered.png, label: rendered.meta.label, name: `${p.e.fid}.inspect-${i}.png` })
      out.push(viewSummary(i, p.label, p.e, rendered.meta))
    })
    return { ok: true, reply: { instrument_unchanged: true, view_count: n, views: out }, images }
  } catch (err) {
    return failure('inspect', err)
  }
}

// ── read_values ──────────────────────────────────────────────────────────

const READ_SCAN_KEYS: ReadonlySet<string> = new Set(['label', 'frame', 'channel', 'direction', 'region', 'rows', 'columns'])
const READ_SPEC_KEYS: ReadonlySet<string> = new Set(['label', 'frame', 'x_col', 'y_cols', 'x_range', 'n'])
const READ_ALL_KEYS: ReadonlySet<string> = new Set([...READ_SCAN_KEYS, ...READ_SPEC_KEYS])

/**
 * Cell-centre sampling along one axis (VISTA's `read_pixels` rule). Returns the
 * display pixel `x0 + floor(((2c+1)·w) / (2n))` of every cell and the native
 * pixel read there: `disp // num` for an upscaled frame, the native pixel under
 * the cell's exact centre for a block-mean display.
 */
export function sampleAxis(x0: number, w: number, n: number, s: ScalePair, nNative: number): { display: number[]; native: number[] } {
  const display: number[] = []
  const native: number[] = []
  for (let c = 0; c < n; c += 1) {
    const disp = x0 + Math.floor(((2 * c + 1) * w) / (2 * n))
    const nat = s.den === 1 ? Math.floor(disp / s.num) : Math.floor((x0 + ((2 * c + 1) * w) / (2 * n)) * s.den)
    display.push(disp)
    native.push(Math.min(nNative - 1, Math.max(0, nat)))
  }
  return { display, native }
}

interface ScanReadPlan {
  readonly what: 'scan'
  readonly label: string
  readonly e: FrameEntry
  readonly channel: string
  readonly direction: Direction
  readonly rows: number
  readonly cols: number
  readonly region: readonly [number, number, number, number]
}

interface SpectrumReadPlan {
  readonly what: 'spectrum'
  readonly label: string
  readonly e: FrameEntry
  readonly xCol: string
  readonly yCols: readonly string[]
  /** Indices of the points inside x_range (every point without one). */
  readonly sel: readonly number[]
  readonly n: number
  readonly xRange: readonly [number, number] | null
}

function readScan(archive: FrameArchive, i: number, p: ScanReadPlan): Record<string, unknown> {
  const { e } = p
  const [x, y, w, h] = p.region
  const s = entryScale(e)
  const xs = sampleAxis(x, w, p.cols, s, e.nx)
  const ys = sampleAxis(y, h, p.rows, s, e.ny)
  const z = archive.values(e, p.channel, p.direction)
  const fmt = archive.fmt(e, p.channel)
  const values = ys.native.map((r) => formatValues(fmt, xs.native.map((c) => z[r * e.nx + c] as number)))
  const nulls = values.reduce((n, row) => n + row.filter((v) => v === null).length, 0)
  const g = e.geometry as ScanGeometry
  const first = displayToScanNm(g, s, (xs.display[0] as number) + 0.5, (ys.display[0] as number) + 0.5)
  const last = displayToScanNm(g, s, (xs.display.at(-1) as number) + 0.5, (ys.display.at(-1) as number) + 0.5)
  const out: Record<string, unknown> = {
    index: i,
    label: p.label,
    frame: e.fid,
    channel: p.channel,
    direction: p.direction,
    region_px: [x, y, w, h],
    rows: p.rows,
    columns: p.cols,
    sample_x_px: xs.display,
    sample_y_px: ys.display,
    first_sample_nm: [pyRound(first[0], 4), pyRound(first[1], 4)],
    last_sample_nm: [pyRound(last[0], 4), pyRound(last[1], 4)],
    decimals: fmt.decimals,
    [formatKey(fmt, 'values')]: values,
  }
  if (nulls > 0) out['null_count'] = nulls
  return out
}

/** Columns, x_range and n of a spectrum view, in the reference's order of checks. */
function planSpectrumRead(archive: FrameArchive, label: string, e: FrameEntry, v: Obj, where: string): SpectrumReadPlan {
  const names = e.channels
  if (names.length === 0) throw new ArgError(`${where}: ${e.fid} is a spectrum without columns`)
  const xReq = strArg(v, 'x_col', where, { maxLen: 64 })
  let xCol: string
  let yCols: string[]
  try {
    xCol = xReq === undefined ? (names[0] as string) : archive.resolveColumn(e, xReq)
    const yReq = v['y_cols']
    if (yReq === undefined || yReq === null) {
      yCols = names.filter((c) => c !== xCol)
    } else {
      if (!Array.isArray(yReq) || yReq.length === 0 || !yReq.every((c) => typeof c === 'string')) {
        throw new ArgError(`${where}.y_cols must be a list of column names`)
      }
      yCols = yReq.map((c: string) => archive.resolveColumn(e, c))
    }
  } catch (err) {
    if (err instanceof ArchiveError) throw new ArgError(`${where}: ${err.message}`)
    throw err
  }
  const fmt = archive.fmt(e, xCol)
  const xs = archive.column(e, xCol).map((x) => x * fmt.factor)
  let sel = Array.from(xs, (_, i) => i)
  const xRange = xRangeArg(v, where)
  if (xRange !== null) {
    sel = sel.filter((i) => inRange(xs[i] as number, xRange[0], xRange[1]))
    if (sel.length === 0) {
      const [lo, hi] = nanExtent(xs)
      throw new ArgError(
        `${where}.x_range ${pyFloatRepr(xRange[0])}..${pyFloatRepr(xRange[1])} ${fmt.unit} contains no samples; ` +
          `x spans ${pyG(lo, 6)}..${pyG(hi, 6)} ${fmt.unit}`,
      )
    }
  }
  const n = numArg(v, 'n', where, { def: sel.length, lo: 1, hi: MAX_READ_SAMPLES, integer: true }) as number
  return { what: 'spectrum', label, e, xCol, yCols, sel, n: Math.min(n, sel.length), xRange }
}

function readSpectrum(archive: FrameArchive, i: number, p: SpectrumReadPlan): Record<string, unknown> {
  const N = p.sel.length
  const idx = Array.from({ length: p.n }, (_, k) => p.sel[Math.floor(((2 * k + 1) * N) / (2 * p.n))] as number)
  const columns = [p.xCol, ...p.yCols]
  const units: string[] = []
  const decimals: number[] = []
  const values: (number | null)[][] = []
  for (const c of columns) {
    const fmt = archive.fmt(p.e, c)
    const col = archive.column(p.e, c)
    units.push(fmt.unit)
    decimals.push(fmt.decimals)
    values.push(formatValues(fmt, idx.map((k) => col[k] as number)))
  }
  const out: Record<string, unknown> = {
    index: i,
    label: p.label,
    frame: p.e.fid,
    kind: kindName(p.e),
    column_names: columns,
    column_units: units,
    column_decimals: decimals,
    n: p.n,
    points_in_range: N,
    sample_index: idx,
    values,
  }
  if (p.xRange !== null) out[unitKey('x_range', units[0] as string)] = [p.xRange[0], p.xRange[1]]
  return out
}

/** `read_values(question, views)`: see the module comment. Never throws. */
export function readValues(archive: FrameArchive, args: unknown): ViewToolResult {
  try {
    checkKeys(args, TOP_KEYS, ['question', 'views'], 'arguments')
    questionArg(args)
    const views = viewsArg(args, MAX_READ_VIEWS)
    let total = 0
    const plans: (ScanReadPlan | SpectrumReadPlan)[] = views.map((v, k) => {
      const i = k + 1
      const where = `views[${i}]`
      checkKeys(v, READ_ALL_KEYS, ['label', 'frame'], where)
      const label = labelArg(v, where)
      const e = frameArg(archive, v['frame'], `${where}.frame`, true)
      let plan: ScanReadPlan | SpectrumReadPlan
      if (e.kind === 'd') {
        only(v, READ_SPEC_KEYS, where, 'a spectrum')
        plan = planSpectrumRead(archive, label, e, v, where)
        total += plan.n * (1 + plan.yCols.length)
      } else {
        only(v, READ_SCAN_KEYS, where, 'a scan')
        const [channel, direction] = channelDirectionArgs(archive, e, v, where)
        const rows = numArg(v, 'rows', where, { lo: 1, hi: MAX_READ_SAMPLES, integer: true })
        const cols = numArg(v, 'columns', where, { lo: 1, hi: MAX_READ_SAMPLES, integer: true })
        if (rows === undefined || cols === undefined) throw new ArgError(`${where}: a scan view needs rows and columns`)
        const reg = regionArg(e, v, where)
        const region: [number, number, number, number] =
          reg === null ? [0, 0, e.display_size[0], e.display_size[1]] : [reg.x, reg.y, reg.width, reg.height]
        plan = { what: 'scan', label, e, channel, direction, rows, cols, region }
        total += rows * cols
      }
      if (total > MAX_READ_SAMPLES) throw new ArgError(`at most ${MAX_READ_SAMPLES} samples per call; views 1..${i} already ask for ${total}`)
      return plan
    })
    const out = plans.map((p, k) => (p.what === 'spectrum' ? readSpectrum(archive, k + 1, p) : readScan(archive, k + 1, p)))
    return {
      ok: true,
      reply: {
        instrument_unchanged: true,
        sampling: 'cell centers: x + ((2c+1)*width)//(2*columns), y likewise',
        sample_count: total,
        view_count: out.length,
        views: out,
      },
      images: [],
    }
  } catch (err) {
    return failure('read_values', err)
  }
}
