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
 *   one image per view, in request order. Derived images are cropped as stored.
 * - `read_values(question, views[1..64])` samples archived physical values at
 *   cell centers — display pixel `x + floor(((2c+1)·w) / (2C))`, likewise for
 *   y — at most 4096 samples per call, in the model unit carried by the key
 *   (`values_pm`, `values_pa`, …), rounded to the channel's decimals (about
 *   1/100 of its value span), `null` where nothing was acquired.
 *
 * Replies follow the reference's model-facing vocabulary: a frame id is under
 * `frame`, units are key suffixes (`black_pm`, `image_size_px`, `corners_nm`),
 * there is no `unit` or `visual_kind` field, and spelling is American.
 *
 * Invalid arguments come back as `{ ok: false, error }` with a message that says
 * what to change; these functions never throw.
 */
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
  viewsArg,
  type ViewImage,
  type ViewToolResult,
} from './args.js'
import { ArchiveError, entryScale, kindName, type FrameArchive, type FrameEntry, type RenderMeta } from './archive.js'
import { CLIP_PCT_DEFAULT } from './render.js'
import { type FlattenMode } from './flatten.js'
import { displayToScanNm, type ScalePair, type ScanGeometry } from './geometry.js'
import { pyRound } from './pyfmt.js'
import type { Region } from './render.js'
import { type Direction } from './scan-data.js'
import { formatKey, formatValues, type ChannelFormat } from './units.js'

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
const INSPECT_DERIVED_KEYS: ReadonlySet<string> = new Set(['label', 'frame', 'region'])
const TOP_KEYS: ReadonlySet<string> = new Set(['question', 'views'])

interface InspectPlan {
  readonly label: string
  readonly e: FrameEntry
  readonly scan?: { channel: string; direction: Direction; flatten: FlattenMode; highpassNm: number; clipPct: number }
  readonly region: Region | null
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
    const allowed = new Set([...INSPECT_SCAN_KEYS])
    const plans: InspectPlan[] = views.map((v, k) => {
      const where = `views[${k + 1}]`
      checkKeys(v, allowed, ['label', 'frame'], where)
      const label = labelArg(v, where)
      const e = frameArg(archive, v['frame'], `${where}.frame`)
      if (e.kind === 's' || e.kind === 'p') {
        only(v, INSPECT_SCAN_KEYS, where, 'a scan')
        const [channel, direction] = channelDirectionArgs(archive, e, v, where)
        const [flatten, highpassNm] = flattenArgs(v, where)
        const clipPct = numArg(v, 'clip_pct', where, { def: CLIP_PCT_DEFAULT, lo: 0, hi: MAX_CLIP_PCT }) as number
        return { label, e, scan: { channel, direction, flatten, highpassNm, clipPct }, region: regionArg(e, v, where) }
      }
      if (e.kind === 'd') throw new ArgError(`${where}: ${e.fid} is a spectrum; spectra cannot be inspected yet`)
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

interface ReadPlan {
  readonly label: string
  readonly e: FrameEntry
  readonly channel: string
  readonly direction: Direction
  readonly rows: number
  readonly cols: number
  readonly region: readonly [number, number, number, number]
}

function readScan(archive: FrameArchive, i: number, p: ReadPlan): Record<string, unknown> {
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

/** `read_values(question, views)`: see the module comment. Never throws. */
export function readValues(archive: FrameArchive, args: unknown): ViewToolResult {
  try {
    checkKeys(args, TOP_KEYS, ['question', 'views'], 'arguments')
    questionArg(args)
    const views = viewsArg(args, MAX_READ_VIEWS)
    let total = 0
    const plans: ReadPlan[] = views.map((v, k) => {
      const i = k + 1
      const where = `views[${i}]`
      checkKeys(v, READ_SCAN_KEYS, ['label', 'frame'], where)
      const label = labelArg(v, where)
      const e = frameArg(archive, v['frame'], `${where}.frame`, true)
      if (e.kind === 'd') throw new ArgError(`${where}: ${e.fid} is a spectrum; spectra cannot be read yet`)
      const [channel, direction] = channelDirectionArgs(archive, e, v, where)
      const rows = numArg(v, 'rows', where, { lo: 1, hi: MAX_READ_SAMPLES, integer: true })
      const cols = numArg(v, 'columns', where, { lo: 1, hi: MAX_READ_SAMPLES, integer: true })
      if (rows === undefined || cols === undefined) throw new ArgError(`${where}: a scan view needs rows and columns`)
      const reg = regionArg(e, v, where)
      const region: [number, number, number, number] =
        reg === null ? [0, 0, e.display_size[0], e.display_size[1]] : [reg.x, reg.y, reg.width, reg.height]
      total += rows * cols
      if (total > MAX_READ_SAMPLES) throw new ArgError(`at most ${MAX_READ_SAMPLES} samples per call; views 1..${i} already ask for ${total}`)
      return { label, e, channel, direction, rows, cols, region }
    })
    const out = plans.map((p, k) => readScan(archive, k + 1, p))
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
