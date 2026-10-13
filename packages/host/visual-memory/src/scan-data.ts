/**
 * Scan data as the archive keeps it: every channel and direction, oriented,
 * SI units, float32, NaN where nothing was acquired.
 *
 * ## Orientation (verified against the reader)
 *
 * `.sxm` frames are read with `dsh-spm-nanonis-files`. Its `sxmOrientedFrames`
 * is the single place that orients a frame: rows are flipped when
 * `:SCAN_DIR:` is `up` so that row 0 is always the frame's top (high-v) edge,
 * and the backward pass is mirrored left-right so that both passes share one
 * geometry. A channel stored backward-only comes back from that reader as its
 * `forward`; it is filed here under `backward` again, as the reference does.
 * Tests write synthetic files in acquisition order (bottom row first for `up`,
 * backward rows right-to-left) and check the archived arrays.
 *
 * ## Geometry
 *
 * `{cx_nm, cy_nm, w_nm, h_nm, angle_deg, nx, ny}` from `:SCAN_OFFSET:`,
 * `:SCAN_RANGE:`, `:SCAN_ANGLE:` and `:SCAN_PIXELS:` (metres → nm), the same
 * fields the judge's footprint rule uses.
 */
import { firstFloat, pyFloat, readSxm, sxmOrientedFrames, type SxmHeader } from 'dsh-spm-nanonis-files'
import { defaultChannel, findChannel } from './channels.js'
import { checkGeometry, type ScanGeometry } from './geometry.js'
import { unitForChannel } from './units.js'

export const DIRECTIONS = ['forward', 'backward'] as const
export type Direction = (typeof DIRECTIONS)[number]

export function isDirection(v: unknown): v is Direction {
  return v === 'forward' || v === 'backward'
}

/** A file or array set the archive cannot ingest; the message says what is missing. */
export class IngestError extends Error {
  override readonly name = 'IngestError'
}

/** One scan frame, ready to archive. Array keys are `"<channel>/<direction>"`. */
export interface ScanData {
  readonly arrays: ReadonlyMap<string, Float32Array>
  readonly channels: readonly string[]
  readonly channelDirections: Readonly<Record<string, readonly Direction[]>>
  readonly units: Readonly<Record<string, string>>
  readonly geometry: ScanGeometry
  readonly nm_per_px: number
  readonly nm_per_px_y: number
  readonly bias_v: number | null
  readonly setpoint_a: number | null
  /** SI unit of the setpoint: A for current feedback, Hz for frequency feedback. */
  readonly setpoint_unit: string
  readonly scan_dir: string | null
  readonly acquired_rows: number
  readonly rec_time: string
  readonly feedback: string | null
  readonly source_name: string
  readonly default_channel: string
}

export function arrayKey(channel: string, direction: Direction): string {
  return `${channel}/${direction}`
}

function floats(value: unknown): number[] {
  const out: number[] = []
  for (const tok of String(value ?? '').replaceAll(';', ' ').trim().split(/\s+/)) {
    if (tok === '') continue
    const v = pyFloat(tok)
    if (v !== null && Number.isFinite(v)) out.push(v)
  }
  return out
}

/** `{cx_nm, …}` from a parsed `.sxm` header, or null when a geometry key is missing. */
export function frameGeometry(header: SxmHeader): ScanGeometry | null {
  const rng = floats(header['scan_range'])
  const off = floats(header['scan_offset'])
  const px = header.scan_pixels
  if (rng.length < 1 || off.length < 2 || px === undefined) return null
  const ang = floats(header['scan_angle'])
  const w = rng[0] as number
  const h = rng.length > 1 ? (rng[1] as number) : w
  return {
    cx_nm: (off[0] as number) * 1e9,
    cy_nm: (off[1] as number) * 1e9,
    w_nm: w * 1e9,
    h_nm: h * 1e9,
    angle_deg: ang.length > 0 ? (ang[0] as number) : 0,
    nx: px[0],
    ny: px[1],
  }
}

/** Header text before `:SCANIT_END:` (or the data marker), decoded as Latin-1. */
function headerText(bytes: Uint8Array, maxBytes = 1_048_576): string {
  const chunk = bytes.subarray(0, Math.min(bytes.length, maxBytes))
  const text = new TextDecoder('latin1').decode(chunk)
  const end = text.indexOf(':SCANIT_END:')
  if (end >= 0) return text.slice(0, end)
  const marker = text.indexOf('\x1a\x04')
  return marker >= 0 ? text.slice(0, marker) : ''
}

/** Channel name → SI unit from the `:DATA_INFO:` block (the reader drops units). */
export function sxmChannelUnits(bytes: Uint8Array): Record<string, string> {
  const lines = headerText(bytes).split(/\r?\n/)
  const units: Record<string, string> = {}
  const start = lines.findIndex((l) => l.trim().toUpperCase() === ':DATA_INFO:')
  if (start < 0) return units
  for (const line of lines.slice(start + 1)) {
    const s = line.trim()
    if (s === '' || s.startsWith(':')) break
    const parts = line.split('\t').map((p) => p.trim()).filter((p) => p !== '')
    if (parts.length >= 3 && parts[1] !== 'Name') units[parts[1] as string] = parts[2] as string
  }
  return units
}

/**
 * The setpoint's SI unit: the header's unit field, else a unit written after the
 * number (`"2.0E-10 A"`), else amperes (current feedback).
 */
function setpointUnit(unitField: unknown, valueField: unknown): string {
  const u = String(unitField ?? '').trim()
  if (u !== '') return u
  const toks = String(valueField ?? '').split(/\s+/).filter((t) => t !== '')
  const last = toks.at(-1)
  return toks.length >= 2 && last !== undefined && /^\p{L}+$/u.test(last) ? last : 'A'
}

/** `"ON"` / `"OFF"` from the Z-controller status or the `on` column of its table. */
function feedbackState(header: SxmHeader): string | null {
  const status = header['z-controller>controller_status']
  if (status !== undefined && status !== null && String(status) !== '') return String(status).trim().toUpperCase()
  const toks = String(header['z-controller'] ?? '').trim().split('\t').map((t) => t.trim())
  if (toks.length >= 2 && (toks[1] === '0' || toks[1] === '1')) return toks[1] === '1' ? 'ON' : 'OFF'
  return null
}

function acquiredRows(a: Float32Array, nx: number, ny: number): number {
  let n = 0
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      if (Number.isFinite(a[r * nx + c] as number)) {
        n += 1
        break
      }
    }
  }
  return n
}

function finish(
  arrays: Map<string, Float32Array>,
  channels: string[],
  units: Record<string, string>,
  geometry: ScanGeometry,
  meta: {
    bias_v: number | null
    setpoint_a: number | null
    setpoint_unit: string
    scan_dir: string | null
    rec_time: string
    feedback: string | null
    source_name: string
    acquired_rows?: number | undefined
  },
): ScanData {
  const channelDirections: Record<string, Direction[]> = {}
  for (const c of channels) channelDirections[c] = DIRECTIONS.filter((d) => arrays.has(arrayKey(c, d)))
  const anyDir = (c: string): Float32Array | undefined => arrays.get(arrayKey(c, 'forward')) ?? arrays.get(arrayKey(c, 'backward'))
  const def = defaultChannel(channels, anyDir, units)
  const firstName = findChannel(channels, 'Z') ?? (channels[0] as string)
  const first = arrays.get(arrayKey(firstName, 'forward')) ?? (arrays.values().next().value as Float32Array)
  return {
    arrays,
    channels,
    channelDirections,
    units,
    geometry,
    nm_per_px: geometry.w_nm / geometry.nx,
    nm_per_px_y: geometry.h_nm / geometry.ny,
    bias_v: meta.bias_v,
    setpoint_a: meta.setpoint_a,
    setpoint_unit: meta.setpoint_unit,
    scan_dir: meta.scan_dir,
    acquired_rows: meta.acquired_rows ?? acquiredRows(first, geometry.nx, geometry.ny),
    rec_time: meta.rec_time,
    feedback: meta.feedback,
    source_name: meta.source_name,
    default_channel: def,
  }
}

/** Every channel and direction of a `.sxm` file. Throws {@link IngestError}. */
export function loadSxm(bytes: Uint8Array, sourceName: string): ScanData {
  let scan
  try {
    scan = readSxm(bytes, sourceName)
  } catch (err) {
    throw new IngestError(`${sourceName}: ${(err as Error).message}`)
  }
  const header = scan.header
  const geometry = frameGeometry(header)
  if (geometry === null) throw new IngestError(`${sourceName}: header has no scan range / offset / pixels`)
  try {
    checkGeometry(geometry)
  } catch (err) {
    throw new IngestError(`${sourceName}: ${(err as Error).message}`)
  }
  const fileUnits = sxmChannelUnits(bytes)
  const names = header.channel_names ?? []
  const flags = header.channel_directions ?? []
  const arrays = new Map<string, Float32Array>()
  const channels: string[] = []
  const units: Record<string, string> = {}
  names.forEach((name, i) => {
    const fr = sxmOrientedFrames(scan, name)
    let fwd = fr.forward
    let bwd = fr.backward
    const flag = flags[i] ?? 'both'
    if (flag.includes('bwd') && !flag.includes('fwd')) {
      // The reader hands a backward-only channel back as "forward".
      bwd = fwd
      fwd = null
    }
    let got = false
    for (const [direction, m] of [['forward', fwd], ['backward', bwd]] as const) {
      if (m === null || m.rows !== geometry.ny || m.cols !== geometry.nx) continue
      arrays.set(arrayKey(name, direction), Float32Array.from(m.data))
      got = true
    }
    if (got && !channels.includes(name)) {
      channels.push(name)
      units[name] = unitForChannel(name, fileUnits)
    }
  })
  if (arrays.size === 0) throw new IngestError(`${sourceName}: no channel data could be read`)
  const recDate = String(header['rec_date'] ?? '').trim()
  const recTime = String(header['rec_time'] ?? '').trim()
  return finish(arrays, channels, units, geometry, {
    bias_v: firstFloat(header['bias']),
    setpoint_a: firstFloat(header['z-controller>setpoint']),
    setpoint_unit: setpointUnit(header['z-controller>setpoint_unit'], header['z-controller>setpoint']),
    scan_dir: String(header['scan_dir'] ?? '').trim().toLowerCase() || null,
    rec_time: `${recDate} ${recTime}`.trim(),
    feedback: feedbackState(header),
    source_name: sourceName,
  })
}

/** A 2-D array given to {@link scanFromArrays}: row-major values plus shape, or rows. */
export type ArrayInput =
  | { readonly rows: number; readonly cols: number; readonly data: ArrayLike<number> }
  | readonly (readonly number[])[]

export interface PartialMeta {
  readonly bias_v?: number | null
  readonly setpoint_a?: number | null
  /** SI unit of the setpoint, default A. */
  readonly setpoint_unit?: string
  readonly scan_dir?: string | null
  readonly rec_time?: string
  /** Channel → SI unit; guessed from the name when absent. */
  readonly units?: Readonly<Record<string, string>>
  readonly acquired_rows?: number
  readonly feedback?: string | null
  readonly source_name?: string
}

/** The geometry a partial frame needs; `nx`/`ny` come from the arrays. */
export interface PartialGeometry {
  readonly cx_nm: number
  readonly cy_nm: number
  readonly w_nm: number
  readonly h_nm: number
  readonly angle_deg?: number
}

function toGrid(key: string, a: ArrayInput): { rows: number; cols: number; data: Float32Array } {
  if (Array.isArray(a)) {
    const rows = a.length
    const cols = rows > 0 ? (a[0] as readonly number[]).length : 0
    const data = new Float32Array(rows * cols)
    a.forEach((row: readonly number[], r: number) => {
      if (row.length !== cols) throw new IngestError(`array ${JSON.stringify(key)} is not rectangular`)
      for (let c = 0; c < cols; c += 1) data[r * cols + c] = row[c] as number
    })
    return { rows, cols, data }
  }
  const g = a as { rows: number; cols: number; data: ArrayLike<number> }
  if (g.data.length !== g.rows * g.cols) {
    throw new IngestError(`array ${JSON.stringify(key)} has ${g.data.length} values, not ${g.rows}x${g.cols}`)
  }
  return { rows: g.rows, cols: g.cols, data: Float32Array.from(g.data) }
}

/**
 * Wrap arrays captured from a scan in progress. Keys are `"Z/forward"` (or `"Z"`
 * for the forward pass); arrays must already be oriented (row 0 = top edge,
 * backward un-mirrored), in SI units, NaN for rows not yet acquired.
 */
export function scanFromArrays(
  arrays: Readonly<Record<string, ArrayInput>>,
  geometry: PartialGeometry,
  meta: PartialMeta = {},
): ScanData {
  const out = new Map<string, Float32Array>()
  const channels: string[] = []
  let shape: [number, number] | null = null
  for (const [key, a] of Object.entries(arrays)) {
    const slash = key.indexOf('/')
    const name = slash < 0 ? key : key.slice(0, slash)
    const direction = slash < 0 ? 'forward' : key.slice(slash + 1)
    if (!isDirection(direction)) throw new IngestError(`array key ${JSON.stringify(key)}: direction must be forward or backward`)
    const g = toGrid(key, a)
    if (g.rows < 1 || g.cols < 1) throw new IngestError(`array ${JSON.stringify(key)} is not a 2-D frame`)
    if (shape === null) shape = [g.rows, g.cols]
    else if (shape[0] !== g.rows || shape[1] !== g.cols) {
      throw new IngestError(`array ${JSON.stringify(key)} has shape ${g.rows}x${g.cols}, others ${shape[0]}x${shape[1]}`)
    }
    out.set(arrayKey(name, direction), g.data)
    if (!channels.includes(name)) channels.push(name)
  }
  if (shape === null) throw new IngestError('no arrays given')
  const missing = (['cx_nm', 'cy_nm', 'w_nm', 'h_nm'] as const).filter((k) => typeof geometry[k] !== 'number')
  if (missing.length > 0) throw new IngestError(`geometry lacks ${missing.join(', ')}`)
  const g: ScanGeometry = {
    cx_nm: geometry.cx_nm,
    cy_nm: geometry.cy_nm,
    w_nm: geometry.w_nm,
    h_nm: geometry.h_nm,
    angle_deg: geometry.angle_deg ?? 0,
    nx: shape[1],
    ny: shape[0],
  }
  try {
    checkGeometry(g)
  } catch (err) {
    throw new IngestError((err as Error).message)
  }
  const units: Record<string, string> = {}
  for (const c of channels) units[c] = unitForChannel(c, meta.units)
  return finish(out, channels, units, g, {
    bias_v: meta.bias_v ?? null,
    setpoint_a: meta.setpoint_a ?? null,
    setpoint_unit: meta.setpoint_unit === undefined || meta.setpoint_unit === '' ? 'A' : meta.setpoint_unit,
    scan_dir: meta.scan_dir === undefined || meta.scan_dir === null ? null : meta.scan_dir.trim().toLowerCase() || null,
    rec_time: meta.rec_time ?? '',
    feedback: meta.feedback ?? null,
    source_name: meta.source_name ?? 'scan in progress',
    acquired_rows: meta.acquired_rows,
  })
}
