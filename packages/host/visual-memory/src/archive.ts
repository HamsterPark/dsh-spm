/**
 * The session's lossless visual memory: every frame the instrument produced,
 * addressable forever (VISUAL-HARNESS §4.1–4.3).
 *
 * ## On disk
 *
 *     <root>/index.jsonl          one JSON record per frame, append-only
 *     <root>/t0007.s0.a0.npy      one lossless array per channel × direction
 *     <root>/t0007.s0.a1.npy      (float32 '<f4'; the record's extra.array_keys
 *     …                            names them: "Z/forward", "Z/backward", …)
 *     <root>/t0007.s0.png         the default rendering ("what the model saw")
 *     <root>/t0007.m0.png         a derived image a measurement tool produced
 *
 * Files are written first (each atomically: temporary file, fsync, rename) and
 * the index line last, so an index line always has its files. Re-opening a root
 * restores the index; a damaged line, or one whose files are missing, is skipped
 * and reported in {@link FrameArchive.loadWarnings}. The archive is the durable
 * source of truth for frames; it does not depend on the dsh session log.
 *
 * ## Frames
 *
 * Ids are `t<turn:04d>.<kind><i>` ({@link frameId}); `i` counts the frames of a
 * kind within a turn. A scan keeps every channel and direction as oriented
 * float32 arrays in SI units with NaN for rows never acquired, plus its
 * geometry, pixel size, bias, setpoint, scan direction, acquired rows and times.
 *
 * Everything here is synchronous: one call writes or reads whole files and
 * finishes before any other archive call can start, so concurrent tool calls
 * in one Node process cannot interleave inside it.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MAX_FILE_BYTES } from 'dsh-spm-nanonis-files'
import { ChannelError, resolveChannel as resolveChannelName } from './channels.js'
import { flatten, FlattenError, HIGHPASS_NM_DEFAULT, isFlattenMode, type FlattenMode } from './flatten.js'
import { FrameIdError, frameId, KIND_NAMES, KIND_WORDS, parseFrameId, type FrameKind } from './frame-id.js'
import {
  checkGeometry,
  DISPLAY_MAX_DEFAULT,
  displaySize,
  scaleFromValue,
  scalePair,
  scaleText,
  scaleValue,
  type ScalePair,
  type ScanGeometry,
} from './geometry.js'
import { decodeNpyFloat32, encodeNpyFloat32 } from './npy32.js'
import { decodePng, encodePngRgb, pngSize, toRgb } from './png.js'
import { pyG, pyRound } from './pyfmt.js'
import {
  CLIP_PCT_DEFAULT,
  crop,
  fmtNum,
  planView,
  renderValues,
  RegionError,
  upscaleRgb,
  viewCornersNm,
  visualLabel,
  type LabelAttr,
  type Region,
} from './render.js'
import {
  arrayKey,
  DIRECTIONS,
  IngestError,
  loadSxm,
  scanFromArrays,
  type ArrayInput,
  type Direction,
  type PartialGeometry,
  type PartialMeta,
  type ScanData,
} from './scan-data.js'
import { channelFormat, displayUnit, formatValue, rangeAttr, robustSpan, unitKey, type ChannelFormat } from './units.js'

export const INDEX_NAME = 'index.jsonl'
const CACHE_FRAMES = 8

/** A request the archive cannot satisfy; the message says what to change. */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError'
}

/** Kind-specific facts of a frame. */
export interface FrameExtra {
  /** `"<channel>/<direction>"` of each array file, in file order (`a0`, `a1`, …). */
  readonly array_keys?: readonly string[]
  readonly channel_directions?: Readonly<Record<string, readonly Direction[]>>
  /** Robust value span (SI) per channel over all its directions, which sets the decimals. */
  readonly span?: Readonly<Record<string, number | null>>
  readonly nm_per_px_y?: number
  readonly feedback?: string | null
  /** SI unit of the feedback setpoint (`A`, or `Hz` for frequency feedback). */
  readonly setpoint_unit?: string
  readonly source_path?: string | null
  /** Default rendering: its label attributes, size, and the values shown black and white. */
  readonly render?: {
    readonly label_attrs: readonly LabelAttr[]
    readonly image_size: readonly [number, number]
    readonly unit?: string
    readonly black?: number | null
    readonly white?: number | null
  }
  /** Derived images: producing tool, source frame ids, description, label attributes. */
  readonly tool?: string | null
  readonly sources?: readonly string[]
  readonly description?: string | null
  readonly label_attrs?: readonly LabelAttr[]
}

/** One archived frame (the record stored in `index.jsonl`). */
export interface FrameEntry {
  readonly fid: string
  readonly turn: number
  readonly kind: FrameKind
  readonly index: number
  readonly source_name: string
  readonly channels: readonly string[]
  readonly directions: readonly Direction[]
  readonly nx: number
  readonly ny: number
  /** Scan geometry; null for frames without one (plain derived images). */
  readonly geometry: ScanGeometry | null
  readonly nm_per_px: number | null
  /** `k` of the display convention (`0.5` = block mean of 2). */
  readonly display_scale: number
  readonly display_size: readonly [number, number]
  readonly bias_v: number | null
  readonly setpoint_a: number | null
  readonly scan_dir: string | null
  readonly acquired_rows: number | null
  readonly rec_time: string
  readonly sim_s: number | null
  /** Channel → SI unit. */
  readonly units: Readonly<Record<string, string>>
  readonly default_channel: string | null
  readonly extra: FrameExtra
}

/** The display scale of a frame as an exact pair. */
export function entryScale(e: FrameEntry): ScalePair {
  return scaleFromValue(e.display_scale)
}

/** `scan` / `partial scan` / `spectrum` / `derived image`, for error messages. */
export function kindWord(e: FrameEntry): string {
  return KIND_WORDS[e.kind]
}

/** `scan` / `partial` / `spectrum` / `derived`: the kind the model reads in replies. */
export function kindName(e: FrameEntry): string {
  return KIND_NAMES[e.kind]
}

/** Has a 2-D grid of values (scan, partial scan, or a derived map with values). */
export function hasValues(e: FrameEntry): boolean {
  return e.geometry !== null && e.channels.length > 0 && (e.extra.array_keys?.length ?? 0) > 0
}

export function channelDirections(e: FrameEntry, channel: string): readonly Direction[] {
  return e.extra.channel_directions?.[channel] ?? e.directions
}

function r(v: number | null | undefined, digits: number): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : pyRound(v, digits)
}

/**
 * Compact, JSON-safe description of a frame as the model reads it (history,
 * recovery, tool replies) — the reference's `FrameEntry.summary()`.
 *
 * Keys: `frame`, `turn`, `kind` (scan, partial, spectrum, derived); scans add
 * `source, channels, directions, size_px, field_nm, center_nm, angle_deg,
 * nm_per_px, display_scale` (a number, plus `display_scale_frac` such as "1/2"
 * when it is not an integer), `display_size_px, default_channel`,
 * `rows_acquired` and `rows_total` (only when rows are missing) and `feedback`;
 * derived images add `tool, frames, description, image_size_px` (and `channels`);
 * any kind may add `bias_v`, `setpoint_pa` (`setpoint_hz` for frequency
 * feedback), `scan_dir`, `rec_time`, `sim_s`. Units travel in the key suffix.
 */
export function entrySummary(e: FrameEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { frame: e.fid, turn: e.turn, kind: kindName(e) }
  if (e.kind === 's' || e.kind === 'p') {
    const g = e.geometry as ScanGeometry
    const s = entryScale(e)
    out['source'] = e.source_name
    out['channels'] = [...e.channels]
    out['directions'] = [...e.directions]
    out['size_px'] = [e.nx, e.ny]
    out['field_nm'] = [r(g.w_nm, 4), r(g.h_nm, 4)]
    out['center_nm'] = [r(g.cx_nm, 4), r(g.cy_nm, 4)]
    out['angle_deg'] = r(g.angle_deg, 3)
    out['nm_per_px'] = r(e.nm_per_px, 5)
    out['display_scale'] = s.den === 1 ? s.num : r(s.num / s.den, 6)
    if (s.den !== 1) out['display_scale_frac'] = scaleText(s)
    out['display_size_px'] = [...e.display_size]
    out['default_channel'] = e.default_channel
    if (e.acquired_rows !== null && e.acquired_rows < e.ny) {
      out['rows_acquired'] = e.acquired_rows
      out['rows_total'] = e.ny
    }
    if (e.extra.feedback !== undefined && e.extra.feedback !== null && e.extra.feedback !== '') out['feedback'] = e.extra.feedback
  } else if (e.kind === 'd') {
    out['source'] = e.source_name
    out['columns'] = [...e.channels]
    out['n_points'] = e.nx
  } else {
    out['tool'] = e.extra.tool ?? null
    if (e.extra.sources !== undefined && e.extra.sources.length > 0) out['frames'] = [...e.extra.sources]
    if (e.extra.description !== undefined && e.extra.description !== null && e.extra.description !== '') {
      out['description'] = e.extra.description
    }
    out['image_size_px'] = [...(e.extra.render?.image_size ?? e.display_size)]
    if (e.channels.length > 0) out['channels'] = [...e.channels]
  }
  if (e.bias_v !== null) out['bias_v'] = r(e.bias_v, 6)
  if (e.setpoint_a !== null) {
    const { factor, unit } = displayUnit(e.extra.setpoint_unit ?? 'A')
    out[unitKey('setpoint', unit)] = Number(pyG(e.setpoint_a * factor, 6))
  }
  if (e.scan_dir !== null && e.scan_dir !== '') out['scan_dir'] = e.scan_dir
  if (e.rec_time !== '') out['rec_time'] = e.rec_time
  if (e.sim_s !== null) out['sim_s'] = r(e.sim_s, 3)
  return out
}

/** Options of {@link FrameArchive.render}. */
export interface RenderOptions {
  /** Default: the frame's default channel. */
  readonly channel?: string | null
  readonly direction?: Direction
  readonly flatten?: FlattenMode
  readonly clipPct?: number
  /** Display px of the frame's full image; null/omitted = whole frame. */
  readonly region?: Region | null
  readonly displayMax?: number
  readonly highpassNm?: number
  /** `kind` of the `<visual …/>` label (`current`, `inspection`, …). */
  readonly labelKind?: string
  /** Attributes placed first in the label (e.g. index, count, label). */
  readonly labelAttrs?: readonly LabelAttr[]
}

/** What a rendering was (everything the reply text reports about one image). */
export interface RenderMeta {
  readonly frame: string
  /** Model-facing kind: scan, partial, derived. */
  readonly kind: string
  readonly channel?: string
  readonly direction?: Direction
  readonly flatten?: FlattenMode
  /** The background width, only for `flatten: 'highpass'`. */
  readonly highpass_nm?: number | null
  readonly region_px: readonly [number, number, number, number]
  readonly native_px?: readonly [number, number, number, number]
  readonly image_size_px: readonly [number, number]
  readonly magnification: number
  readonly image_px_per_scan_px?: number
  readonly nm_per_image_px?: number
  readonly corners_nm?: Record<string, [number, number]>
  /** The channel's model unit, factor and decimals. */
  readonly fmt?: ChannelFormat
  readonly unit?: string
  /** Values (model unit, rounded) shown as black and white, and the region's extremes. */
  readonly black?: number | null
  readonly white?: number | null
  readonly min?: number | null
  readonly max?: number | null
  readonly tool?: string | null
  readonly label_attrs: readonly LabelAttr[]
  /** The text block that goes right before the image. */
  readonly label: string
}

export interface Rendered {
  readonly png: Uint8Array
  readonly meta: RenderMeta
}

/** Archived values of one channel and direction. */
export interface FrameArray {
  readonly fid: string
  readonly channel: string
  readonly direction: Direction
  /** SI unit of the values. */
  readonly unit: string
  readonly rows: number
  readonly cols: number
  /** Row-major copy; row 0 is the frame's top edge. */
  readonly data: Float32Array
}

export interface ArchiveOptions {
  /** Longest side of a rendered observation (`D`), default 768, at least 64. */
  readonly displayMax?: number
}

export interface DerivedMeta {
  readonly tool: string
  readonly sources?: readonly string[]
  readonly description?: string
  readonly labelAttrs?: readonly LabelAttr[]
  /** Values behind the image (e.g. a difference map), with their geometry and units. */
  readonly arrays?: Readonly<Record<string, ArrayInput>>
  readonly geometry?: PartialGeometry
  readonly units?: Readonly<Record<string, string>>
}

function writeFileDurable(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

function appendLineDurable(path: string, line: string): void {
  const fd = openSync(path, 'a')
  try {
    writeSync(fd, Buffer.from(`${line}\n`, 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Robust value span (SI) of every channel over all its directions (sets its decimals). */
function spansOf(data: ScanData): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const c of data.channels) {
    out[c] = robustSpan(...(data.channelDirections[c] ?? []).map((d) => data.arrays.get(arrayKey(c, d))))
  }
  return out
}

/** Python `dict.update` on an ordered attribute list. */
export function mergeAttrs(base: readonly LabelAttr[], updates: readonly LabelAttr[]): LabelAttr[] {
  const out: LabelAttr[] = [...base]
  for (const [k, v] of updates) {
    const i = out.findIndex(([kk]) => kk === k)
    if (i >= 0) out[i] = [k, v]
    else out.push([k, v])
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate one parsed index line into an entry. Throws with the reason. */
function entryFromRecord(rec: unknown): FrameEntry {
  if (!isRecord(rec)) throw new ArchiveError('record is not an object')
  const missing = ['fid', 'turn', 'kind', 'index'].filter((k) => !(k in rec))
  if (missing.length > 0) throw new ArchiveError(`record lacks ${missing.join(', ')}`)
  const parsed = parseFrameId(String(rec['fid']))
  if (parsed.turn !== rec['turn'] || parsed.kind !== rec['kind'] || parsed.index !== rec['index']) {
    throw new ArchiveError(`record ${String(rec['fid'])} disagrees with its turn/kind/index`)
  }
  if (!Array.isArray(rec['channels']) || !Array.isArray(rec['display_size']) || !isRecord(rec['extra'])) {
    throw new ArchiveError(`record ${String(rec['fid'])} lacks channels, display_size or extra`)
  }
  return rec as unknown as FrameEntry
}

/** Per-session lossless frame store (see the module comment). */
export class FrameArchive {
  readonly root: string
  readonly displayMax: number
  /** Index lines skipped on re-open, with the reason. */
  readonly loadWarnings: string[] = []
  private readonly entries = new Map<string, FrameEntry>()
  private readonly order: string[] = []
  private readonly cache = new Map<string, ReadonlyMap<string, Float32Array>>()
  private turn = 0

  constructor(root: string, options: ArchiveOptions = {}) {
    const dm = options.displayMax ?? DISPLAY_MAX_DEFAULT
    if (!Number.isInteger(dm) || dm < 64) throw new ArchiveError(`display_max must be an integer of at least 64, got ${dm}`)
    this.root = root
    this.displayMax = dm
    mkdirSync(root, { recursive: true })
    this.restore()
  }

  get indexPath(): string {
    return join(this.root, INDEX_NAME)
  }

  /** The latest turn seen (or set by the host); derived images are filed under it. */
  get currentTurn(): number {
    return this.turn
  }

  setTurn(turn: number): void {
    if (!Number.isSafeInteger(turn)) throw new ArchiveError(`turn must be an integer, got ${turn}`)
    this.turn = Math.max(0, turn)
  }

  private restore(): void {
    if (!existsSync(this.indexPath)) return
    const lines = readFileSync(this.indexPath, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.trim() === '') return
      let e: FrameEntry
      try {
        e = entryFromRecord(JSON.parse(line))
      } catch (err) {
        this.loadWarnings.push(`index line ${i + 1} skipped: ${(err as Error).message}`)
        return
      }
      const missing = this.filesOf(e).filter((f) => !existsSync(join(this.root, f)))
      if (missing.length > 0) {
        this.loadWarnings.push(`${e.fid}: missing ${missing.join(', ')}; skipped`)
        return
      }
      if (this.entries.has(e.fid)) {
        this.loadWarnings.push(`index line ${i + 1}: duplicate ${e.fid}; later record kept`)
        this.order.splice(this.order.indexOf(e.fid), 1)
      }
      this.entries.set(e.fid, e)
      this.order.push(e.fid)
      this.turn = Math.max(this.turn, e.turn)
    })
  }

  private filesOf(e: FrameEntry): string[] {
    return [`${e.fid}.png`, ...(e.extra.array_keys ?? []).map((_, i) => `${e.fid}.a${i}.npy`)]
  }

  private allocate(turn: number, kind: FrameKind): { fid: string; index: number } {
    if (!Number.isSafeInteger(turn) || turn < 0) throw new ArchiveError(`turn must be an integer >= 0, got ${turn}`)
    let next = 0
    for (const e of this.entries.values()) if (e.turn === turn && e.kind === kind) next = Math.max(next, e.index + 1)
    return { fid: frameId(turn, kind, next), index: next }
  }

  private commit(e: FrameEntry): FrameEntry {
    appendLineDurable(this.indexPath, JSON.stringify(e))
    this.entries.set(e.fid, e)
    this.order.push(e.fid)
    this.turn = Math.max(this.turn, e.turn)
    return e
  }

  private saveArrays(fid: string, arrays: ReadonlyMap<string, Float32Array>, rows: number, cols: number): string[] {
    const keys = [...arrays.keys()]
    keys.forEach((k, i) => {
      writeFileDurable(join(this.root, `${fid}.a${i}.npy`), encodeNpyFloat32(arrays.get(k) as Float32Array, [rows, cols]))
    })
    return keys
  }

  private cachePut(fid: string, arrays: ReadonlyMap<string, Float32Array>): void {
    this.cache.delete(fid)
    this.cache.set(fid, arrays)
    while (this.cache.size > CACHE_FRAMES) this.cache.delete(this.cache.keys().next().value as string)
  }

  private arrays(e: FrameEntry): ReadonlyMap<string, Float32Array> {
    const hit = this.cache.get(e.fid)
    if (hit !== undefined) {
      this.cachePut(e.fid, hit)
      return hit
    }
    const keys = e.extra.array_keys ?? []
    if (keys.length === 0) throw new ArchiveError(`${e.fid} is a ${kindWord(e)} without archived values`)
    const out = new Map<string, Float32Array>()
    keys.forEach((k, i) => {
      const grid = decodeNpyFloat32(readFileSync(join(this.root, `${e.fid}.a${i}.npy`)))
      if (grid.rows !== e.ny || grid.cols !== e.nx) {
        throw new ArchiveError(`${e.fid}: array file ${i} is ${grid.rows}x${grid.cols}, the frame is ${e.ny}x${e.nx}`)
      }
      out.set(k, grid.data)
    })
    this.cachePut(e.fid, out)
    return out
  }

  // ── adding frames ──────────────────────────────────────────────────────

  /** Archive a saved `.sxm` (every channel and direction). */
  addScan(turn: number, sxmPath: string, meta: { readonly simS?: number } = {}): FrameEntry {
    if (!existsSync(sxmPath)) throw new ArchiveError(`no such .sxm file: ${sxmPath}`)
    const size = statSync(sxmPath).size
    if (size > MAX_FILE_BYTES) throw new ArchiveError(`${basename(sxmPath)} is too large to archive (${size} bytes)`)
    return this.addScanBytes(turn, new Uint8Array(readFileSync(sxmPath)), {
      sourceName: basename(sxmPath),
      sourcePath: sxmPath,
      ...(meta.simS === undefined ? {} : { simS: meta.simS }),
    })
  }

  /** Archive `.sxm` bytes already in memory. */
  addScanBytes(
    turn: number,
    bytes: Uint8Array,
    meta: { readonly sourceName: string; readonly sourcePath?: string; readonly simS?: number },
  ): FrameEntry {
    let data: ScanData
    try {
      data = loadSxm(bytes, meta.sourceName)
    } catch (err) {
      throw new ArchiveError((err as IngestError).message)
    }
    return this.addScanData(turn, 's', data, meta.simS ?? null, meta.sourcePath ?? null)
  }

  /**
   * Archive a snapshot of a scan in progress. `arrays`: `{"Z/forward": 2-D, …}`
   * oriented (row 0 = top edge, backward un-mirrored), SI units, NaN rows not yet
   * acquired.
   */
  addPartial(
    turn: number,
    arrays: Readonly<Record<string, ArrayInput>>,
    meta: PartialMeta & { readonly geometry: PartialGeometry; readonly simS?: number },
  ): FrameEntry {
    let data: ScanData
    try {
      data = scanFromArrays(arrays, meta.geometry, meta)
    } catch (err) {
      throw new ArchiveError((err as IngestError).message)
    }
    return this.addScanData(turn, 'p', data, meta.simS ?? null, null)
  }

  private addScanData(turn: number, kind: 's' | 'p', data: ScanData, simS: number | null, sourcePath: string | null): FrameEntry {
    const g = data.geometry
    const scale = scalePair(g.nx, g.ny, this.displayMax)
    const directions = DIRECTIONS.filter((d) => data.channels.some((c) => data.channelDirections[c]?.includes(d)))
    const span = spansOf(data)
    const { fid, index } = this.allocate(turn, kind)
    const keys = this.saveArrays(fid, data.arrays, g.ny, g.nx)
    const base: FrameEntry = {
      fid,
      turn,
      kind,
      index,
      source_name: data.source_name,
      channels: [...data.channels],
      directions,
      nx: g.nx,
      ny: g.ny,
      geometry: { ...g },
      nm_per_px: data.nm_per_px,
      display_scale: scaleValue(scale),
      display_size: displaySize(g.nx, g.ny, scale),
      bias_v: data.bias_v,
      setpoint_a: data.setpoint_a,
      scan_dir: data.scan_dir,
      acquired_rows: data.acquired_rows,
      rec_time: data.rec_time,
      sim_s: simS,
      units: { ...data.units },
      default_channel: data.default_channel,
      extra: {
        array_keys: keys,
        channel_directions: data.channelDirections,
        span,
        nm_per_px_y: data.nm_per_px_y,
        feedback: data.feedback,
        setpoint_unit: data.setpoint_unit,
        source_path: sourcePath,
      },
    }
    this.cachePut(fid, data.arrays)
    const direction = channelDirections(base, data.default_channel)[0] ?? 'forward'
    const { png, meta } = this.renderScan(base, { direction })
    writeFileDurable(join(this.root, `${fid}.png`), png)
    const entry: FrameEntry = {
      ...base,
      extra: {
        ...base.extra,
        render: {
          label_attrs: meta.label_attrs,
          image_size: meta.image_size_px,
          ...(meta.unit === undefined ? {} : { unit: meta.unit }),
          black: meta.black ?? null,
          white: meta.white ?? null,
        },
      },
    }
    return this.commit(entry)
  }

  /**
   * Archive an image a measurement tool produced. With `arrays` (+ `geometry`,
   * `units`) the values behind it can be read back like a scan's.
   */
  addDerived(turn: number, png: Uint8Array, meta: DerivedMeta): FrameEntry {
    const { width, height } = pngSize(png)
    decodePng(png) // reject a PNG that cannot be cropped later
    let data: ScanData | null = null
    if (meta.arrays !== undefined) {
      if (meta.geometry === undefined) throw new ArchiveError('a derived image with values needs its geometry')
      try {
        data = scanFromArrays(meta.arrays, meta.geometry, meta.units === undefined ? {} : { units: meta.units })
      } catch (err) {
        throw new ArchiveError((err as IngestError).message)
      }
    }
    const { fid, index } = this.allocate(turn, 'm')
    let entry: FrameEntry = {
      fid,
      turn,
      kind: 'm',
      index,
      source_name: meta.tool,
      channels: data === null ? [] : [...data.channels],
      directions: data === null ? [] : DIRECTIONS.filter((d) => data.channels.some((c) => data.channelDirections[c]?.includes(d))),
      nx: data === null ? width : data.geometry.nx,
      ny: data === null ? height : data.geometry.ny,
      geometry: data === null ? null : { ...data.geometry },
      nm_per_px: data === null ? null : data.nm_per_px,
      display_scale: data === null ? 1 : scaleValue(scalePair(data.geometry.nx, data.geometry.ny, this.displayMax)),
      display_size: [width, height],
      bias_v: null,
      setpoint_a: null,
      scan_dir: null,
      acquired_rows: null,
      rec_time: '',
      sim_s: null,
      units: data === null ? {} : { ...data.units },
      default_channel: data === null ? null : (data.channels[0] as string),
      extra: {
        tool: meta.tool,
        sources: [...(meta.sources ?? [])],
        description: meta.description ?? null,
        label_attrs: [...(meta.labelAttrs ?? [])],
      },
    }
    if (data !== null) {
      const keys = this.saveArrays(fid, data.arrays, data.geometry.ny, data.geometry.nx)
      entry = {
        ...entry,
        extra: {
          ...entry.extra,
          array_keys: keys,
          channel_directions: data.channelDirections,
          span: spansOf(data),
          nm_per_px_y: data.nm_per_px_y,
        },
      }
      this.cachePut(fid, data.arrays)
    }
    writeFileDurable(join(this.root, `${fid}.png`), png)
    entry = { ...entry, extra: { ...entry.extra, render: { label_attrs: this.derivedLabelAttrs(entry), image_size: [width, height] } } }
    return this.commit(entry)
  }

  // ── lookup ─────────────────────────────────────────────────────────────

  /** The frame with this id. Throws {@link ArchiveError} with a helpful message. */
  get(fid: string): FrameEntry {
    const key = String(fid ?? '').trim()
    const e = this.entries.get(key)
    if (e !== undefined) return e
    throw new ArchiveError(this.unknownMessage(key))
  }

  has(fid: string): boolean {
    return this.entries.has(String(fid ?? '').trim())
  }

  private unknownMessage(key: string): string {
    let turn: number
    try {
      turn = parseFrameId(key).turn
    } catch (err) {
      if (!(err instanceof FrameIdError)) throw err
      return `${JSON.stringify(key)} is not a frame id (expected like 't0007.s0'); latest frames: ${JSON.stringify(this.order.slice(-6))}`
    }
    const same = this.order.filter((f) => this.entries.get(f)?.turn === turn)
    if (same.length > 0) return `no frame ${JSON.stringify(key)}; turn ${turn} has ${JSON.stringify(same)}`
    if (this.order.length === 0) return `no frame ${JSON.stringify(key)}; the archive is empty`
    return `no frame ${JSON.stringify(key)}; turns 0..${this.turn} exist; latest frames: ${JSON.stringify(this.order.slice(-6))}`
  }

  /** Frames in archive order, optionally of one turn and/or kind. */
  frames(filter: { readonly turn?: number; readonly kind?: FrameKind } = {}): FrameEntry[] {
    return this.order
      .map((f) => this.entries.get(f) as FrameEntry)
      .filter((e) => (filter.turn === undefined || e.turn === filter.turn) && (filter.kind === undefined || e.kind === filter.kind))
  }

  /** The most recent frame of a kind (default: saved scans). */
  latest(kind: FrameKind = 's'): FrameEntry | undefined {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const e = this.entries.get(this.order[i] as string) as FrameEntry
      if (e.kind === kind) return e
    }
    return undefined
  }

  /** Every frame's summary, in archive order. */
  index(): Record<string, unknown>[] {
    return this.frames().map(entrySummary)
  }

  // ── values ─────────────────────────────────────────────────────────────

  /** Resolve a channel request (default: the frame's default channel). */
  resolveChannel(e: FrameEntry, channel?: string | null): string {
    if (channel === undefined || channel === null || channel.trim() === '') {
      if (e.default_channel === null) throw new ArchiveError(`${e.fid} is a ${kindWord(e)} without channels`)
      return e.default_channel
    }
    try {
      return resolveChannelName(channel, e.channels, e.units)
    } catch (err) {
      if (err instanceof ChannelError) throw new ArchiveError(`${e.fid}: ${err.message}`)
      throw err
    }
  }

  /** Archived values (SI) of a resolved channel and direction; the cached array, do not mutate. */
  values(e: FrameEntry, channel: string, direction: Direction = 'forward'): Float32Array {
    const a = this.arrays(e).get(arrayKey(channel, direction))
    if (a === undefined) {
      throw new ArchiveError(`${e.fid} channel ${JSON.stringify(channel)} has no ${direction} pass; it has ${JSON.stringify(channelDirections(e, channel))}`)
    }
    return a
  }

  /** Archived values of one channel and direction (a copy, SI units). */
  array(fid: string, channel?: string | null, direction: Direction = 'forward'): FrameArray {
    const e = this.get(fid)
    if (!hasValues(e)) throw new ArchiveError(`${e.fid} is a ${kindWord(e)} without archived values`)
    const ch = this.resolveChannel(e, channel)
    const data = Float32Array.from(this.values(e, ch, direction))
    return { fid: e.fid, channel: ch, direction, unit: e.units[ch] ?? '', rows: e.ny, cols: e.nx, data }
  }

  /**
   * How a channel of this frame is reported: model unit, factor from SI and
   * decimals from the channel's robust span (the reference's `Archive.fmt`).
   */
  fmt(e: FrameEntry, channel: string): ChannelFormat {
    let span = e.extra.span?.[channel]
    if ((span === undefined || span === null) && (e.extra.array_keys?.length ?? 0) > 0) {
      span = robustSpan(...channelDirections(e, channel).map((d) => this.arrays(e).get(arrayKey(channel, d))))
    }
    return channelFormat(e.units[channel] ?? '', span ?? null)
  }

  // ── rendering ──────────────────────────────────────────────────────────

  /**
   * Re-render a frame from its archived values (not from the stored PNG).
   * Scans: channel, direction, flattening, contrast and an exact region; derived
   * images: an exact crop of the stored image. `meta.label` is the text block
   * that goes before the image.
   */
  render(fid: string, options: RenderOptions = {}): Rendered {
    const e = this.get(fid)
    if (e.kind === 's' || e.kind === 'p') return this.renderScan(e, options)
    if (e.kind === 'm') return this.renderDerived(e, options)
    throw new ArchiveError(`${e.fid} is a ${kindWord(e)}; spectra are not rendered by this archive yet`)
  }

  private renderScan(e: FrameEntry, o: RenderOptions): Rendered {
    const g = e.geometry
    if (g === null) throw new ArchiveError(`${e.fid} has no scan geometry`)
    checkGeometry(g)
    const ch = this.resolveChannel(e, o.channel)
    const direction = o.direction ?? 'forward'
    const mode = o.flatten ?? 'plane'
    if (!isFlattenMode(mode)) throw new ArchiveError(`flatten must be one of none, plane, line, poly2, highpass`)
    const clipPct = o.clipPct ?? CLIP_PCT_DEFAULT
    const highpassNm = o.highpassNm ?? HIGHPASS_NM_DEFAULT
    const dm = o.displayMax ?? this.displayMax
    const z = this.values(e, ch, direction)
    const nmx = e.nm_per_px ?? g.w_nm / g.nx
    const nmy = e.extra.nm_per_px_y ?? nmx
    let zf: Float64Array
    try {
      zf = flatten(z, e.nx, e.ny, mode, { nmPerPx: Math.sqrt(nmx * nmy), highpassNm })
    } catch (err) {
      if (err instanceof FlattenError) throw new ArchiveError(err.message)
      throw err
    }
    const scale = entryScale(e)
    let view
    try {
      view = planView(e.nx, e.ny, scale, o.region ?? null, dm)
    } catch (err) {
      if (err instanceof RegionError) throw new ArchiveError(err.message)
      throw err
    }
    const { png, lo, hi } = renderValues(zf, e.nx, view, clipPct)
    const fmt = this.fmt(e, ch)
    const [i0, j0, i1, j1] = view.native
    const cropped = crop(zf, e.nx, view.native)
    let vmin = Infinity
    let vmax = -Infinity
    for (const v of cropped) {
      if (Number.isFinite(v)) {
        if (v < vmin) vmin = v
        if (v > vmax) vmax = v
      }
    }
    const [x, y, w, h] = view.region_px
    const updates: LabelAttr[] = [['frame', e.fid], ['channel', ch], ['direction', direction], ['flatten', mode]]
    if (mode === 'highpass') updates.push(['highpass_nm', pyG(highpassNm, 6)])
    updates.push(
      ['scale', scaleText(scale)],
      ['size', `${view.image_size[0]}x${view.image_size[1]}`],
      ['region', `${x},${y},${w},${h}`],
      ['field_nm', `${pyG((i1 - i0) * nmx, 4)}x${pyG((j1 - j0) * nmy, 4)}`],
    )
    if (o.region !== undefined && o.region !== null) updates.push(['magnification', pyG(view.magnification, 4)])
    updates.push([rangeAttr(ch, fmt.unit), `${fmtNum(lo * fmt.factor, fmt.decimals)}..${fmtNum(hi * fmt.factor, fmt.decimals)}`])
    if (e.acquired_rows !== null && e.acquired_rows < e.ny) updates.push(['rows_acquired', `${e.acquired_rows}/${e.ny}`])
    const attrs = mergeAttrs(o.labelAttrs ?? [], updates)
    const meta: RenderMeta = {
      frame: e.fid,
      kind: kindName(e),
      channel: ch,
      direction,
      flatten: mode,
      highpass_nm: mode === 'highpass' ? highpassNm : null,
      region_px: [x, y, w, h],
      native_px: [i0, j0, i1, j1],
      image_size_px: view.image_size,
      magnification: pyRound(view.magnification, 4),
      image_px_per_scan_px: view.down === 1 ? view.up : pyRound(1 / view.down, 6),
      nm_per_image_px: pyRound((nmx * view.down) / view.up, 6),
      corners_nm: viewCornersNm(g, view),
      fmt,
      unit: fmt.unit,
      black: formatValue(fmt, lo),
      white: formatValue(fmt, hi),
      min: vmax >= vmin ? formatValue(fmt, vmin) : null,
      max: vmax >= vmin ? formatValue(fmt, vmax) : null,
      label_attrs: attrs,
      label: visualLabel(o.labelKind ?? 'current', attrs),
    }
    return { png, meta }
  }

  private derivedLabelAttrs(e: FrameEntry): LabelAttr[] {
    const attrs: LabelAttr[] = [['frame', e.fid], ['derived', e.extra.tool ?? null]]
    if (e.extra.sources !== undefined && e.extra.sources.length > 0) attrs.push(['frames', e.extra.sources.join(',')])
    return mergeAttrs(mergeAttrs(attrs, e.extra.label_attrs ?? []), [['size', `${e.display_size[0]}x${e.display_size[1]}`]])
  }

  private renderDerived(e: FrameEntry, o: RenderOptions): Rendered {
    let png: Uint8Array = new Uint8Array(readFileSync(join(this.root, `${e.fid}.png`)))
    const [W, H] = e.display_size
    let attrs = mergeAttrs(o.labelAttrs ?? [], this.derivedLabelAttrs(e))
    let regionPx: [number, number, number, number] = [0, 0, W, H]
    let size: [number, number] = [W, H]
    let magnification = 1
    const region = o.region ?? null
    if (region !== null) {
      const { x, y, width: w, height: h } = region
      if (![x, y, w, h].every((v) => Number.isInteger(v)) || w < 1 || h < 1 || x < 0 || y < 0 || x + w > W || y + h > H) {
        throw new ArchiveError(`region x=${x}, y=${y}, width=${w}, height=${h} leaves the ${W}x${H} derived image`)
      }
      const rgb = toRgb(decodePng(png))
      const cut = new Uint8Array(w * h * 3)
      for (let row = 0; row < h; row += 1) cut.set(rgb.subarray(((y + row) * W + x) * 3, ((y + row) * W + x + w) * 3), row * w * 3)
      magnification = Math.max(1, Math.floor((o.displayMax ?? this.displayMax) / Math.max(w, h)))
      png = encodePngRgb(w * magnification, h * magnification, upscaleRgb(cut, w, h, magnification))
      regionPx = [x, y, w, h]
      size = [w * magnification, h * magnification]
      attrs = mergeAttrs(attrs, [['region', `${x},${y},${w},${h}`], ['magnification', String(magnification)], ['size', `${size[0]}x${size[1]}`]])
    }
    const kind = o.labelKind === undefined || o.labelKind === 'current' ? 'derived' : o.labelKind
    return {
      png,
      meta: {
        frame: e.fid,
        kind: kindName(e),
        tool: e.extra.tool ?? null,
        region_px: regionPx,
        image_size_px: size,
        magnification,
        label_attrs: attrs,
        label: visualLabel(kind, attrs),
      },
    }
  }

  /** The frame's stored default image with its label (no re-rendering). */
  observation(fid: string, kind = 'current'): { readonly label: string; readonly png: Uint8Array } {
    const e = this.get(fid)
    const png = new Uint8Array(readFileSync(join(this.root, `${e.fid}.png`)))
    const attrs = e.extra.render?.label_attrs ?? []
    const labelKind = e.kind === 'm' && kind === 'current' ? 'derived' : kind
    return { label: visualLabel(labelKind, attrs), png }
  }
}
