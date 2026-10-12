/**
 * Argument checks shared by the visual-memory and measurement tools, with the
 * Python reference's (`vista_spm.viewtools`) messages: each says what to change.
 * The tools catch {@link ArgError} (and `ArchiveError`) through {@link failure},
 * so a bad argument becomes an error reply, never a throw.
 */
import { ArchiveError, channelDirections, hasValues, type FrameArchive, type FrameEntry } from './archive.js'
import { FLATTEN_MODES, HIGHPASS_NM_DEFAULT, type FlattenMode } from './flatten.js'
import type { Region } from './render.js'
import { DIRECTIONS, type Direction } from './scan-data.js'

export const MAX_QUESTION_CHARS = 1024
export const MAX_LABEL_CHARS = 128
export const MAX_HIGHPASS_NM = 10000
export const MAX_CLIP_PCT = 25

/** An invalid argument; the message says what to change. */
export class ArgError extends Error {
  override readonly name = 'ArgError'
}

/** One image of a reply: PNG bytes, the label text block, a file name for the attachment. */
export interface ViewImage {
  readonly png: Uint8Array
  readonly label: string
  readonly name: string
}

export type ViewToolResult =
  | { readonly ok: true; readonly reply: Record<string, unknown>; readonly images: readonly ViewImage[] }
  | { readonly ok: false; readonly error: string }

export type Obj = Record<string, unknown>

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function sortedList(xs: Iterable<string>): string {
  return `[${[...xs].sort().map((x) => `'${x}'`).join(', ')}]`
}

export function checkKeys(obj: unknown, allowed: ReadonlySet<string>, required: readonly string[], where: string): asserts obj is Obj {
  if (!isObj(obj)) throw new ArgError(`${where} must be an object`)
  const extra = Object.keys(obj).filter((k) => !allowed.has(k))
  if (extra.length > 0) throw new ArgError(`${where}: unknown field(s) ${sortedList(extra)}; allowed: ${sortedList(allowed)}`)
  const missing = required.filter((k) => obj[k] === undefined || obj[k] === null)
  if (missing.length > 0) throw new ArgError(`${where}: missing required field(s) ${sortedList(missing)}`)
}

export function strArg(
  obj: Obj,
  key: string,
  where: string,
  opts: { readonly def?: string; readonly maxLen?: number; readonly choices?: readonly string[] } = {},
): string | undefined {
  const v = obj[key] ?? opts.def
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ArgError(`${where}.${key} must be a string`)
  const maxLen = opts.maxLen ?? 256
  if (v.length < 1 || v.length > maxLen) throw new ArgError(`${where}.${key} must have 1..${maxLen} characters`)
  if (opts.choices !== undefined && !opts.choices.includes(v)) {
    throw new ArgError(`${where}.${key} must be one of ${JSON.stringify(opts.choices)}, not ${JSON.stringify(v)}`)
  }
  return v
}

export function numArg(
  obj: Obj,
  key: string,
  where: string,
  opts: { readonly def?: number; readonly lo?: number; readonly hi?: number; readonly integer?: boolean; readonly loExclusive?: boolean } = {},
): number | undefined {
  const v = obj[key] ?? opts.def
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number') throw new ArgError(`${where}.${key} must be a number`)
  if (opts.integer === true && !Number.isInteger(v)) throw new ArgError(`${where}.${key} must be an integer`)
  if (!Number.isFinite(v)) throw new ArgError(`${where}.${key} must be finite`)
  if (opts.lo !== undefined && (opts.loExclusive === true ? v <= opts.lo : v < opts.lo)) {
    throw new ArgError(`${where}.${key} must be ${opts.loExclusive === true ? '>' : '>='} ${opts.lo}`)
  }
  if (opts.hi !== undefined && v > opts.hi) throw new ArgError(`${where}.${key} must be <= ${opts.hi}`)
  return v
}

export function questionArg(args: Obj): void {
  const q = args['question']
  if (typeof q !== 'string' || q.trim() === '') throw new ArgError('question must be a non-empty string')
  if (q.length > MAX_QUESTION_CHARS) throw new ArgError(`question is longer than ${MAX_QUESTION_CHARS} characters`)
}

export function viewsArg(args: Obj, max: number): unknown[] {
  const views = args['views']
  if (!Array.isArray(views) || views.length === 0) throw new ArgError('views must be a non-empty list')
  if (views.length > max) throw new ArgError(`at most ${max} views per call (got ${views.length})`)
  return views
}

export function labelArg(view: Obj, where: string): string {
  const lab = view['label']
  if (typeof lab !== 'string' || lab.trim() === '') throw new ArgError(`${where}.label must be a non-empty string`)
  if (lab.length > MAX_LABEL_CHARS) throw new ArgError(`${where}.label is longer than ${MAX_LABEL_CHARS} characters`)
  return lab
}

export function frameArg(archive: FrameArchive, value: unknown, where: string, needValues = false): FrameEntry {
  if (typeof value !== 'string' || value.trim() === '') throw new ArgError(`${where} must be a frame id like 't0007.s0'`)
  let e: FrameEntry
  try {
    e = archive.get(value.trim())
  } catch (err) {
    if (err instanceof ArchiveError) throw new ArgError(`${where}: ${err.message}`)
    throw err
  }
  if (needValues && e.kind === 'm' && !hasValues(e)) {
    const src = e.extra.sources !== undefined && e.extra.sources.length > 0 ? e.extra.sources.join(', ') : 'see history'
    throw new ArgError(`${where}: ${e.fid} is a derived image without values; use the frame it was derived from (${src})`)
  }
  return e
}

export function only(v: Obj, allowed: ReadonlySet<string>, where: string, what: string): void {
  const extra = Object.keys(v).filter((k) => !allowed.has(k))
  if (extra.length > 0) throw new ArgError(`${where}: ${sortedList(extra)} do not apply to ${what} frame; allowed: ${sortedList(allowed)}`)
}

export function channelDirectionArgs(archive: FrameArchive, e: FrameEntry, v: Obj, where: string): [string, Direction] {
  const req = strArg(v, 'channel', where, { maxLen: 64 })
  let ch: string
  try {
    ch = archive.resolveChannel(e, req)
  } catch (err) {
    if (err instanceof ArchiveError) throw new ArgError(`${where}.channel: ${err.message}`)
    throw err
  }
  const direction = strArg(v, 'direction', where, { def: 'forward', choices: DIRECTIONS }) as Direction
  const has = channelDirections(e, ch)
  if (!has.includes(direction)) throw new ArgError(`${where}.direction: ${e.fid} channel ${JSON.stringify(ch)} has only ${JSON.stringify(has)}`)
  return [ch, direction]
}

export function regionArg(e: FrameEntry, v: Obj, where: string): Region | null {
  const reg = v['region']
  if (reg === undefined || reg === null) return null
  const keys = new Set(['x', 'y', 'width', 'height'])
  checkKeys(reg, keys, [...keys], `${where}.region`)
  const x = numArg(reg, 'x', `${where}.region`, { lo: 0, integer: true }) as number
  const y = numArg(reg, 'y', `${where}.region`, { lo: 0, integer: true }) as number
  const w = numArg(reg, 'width', `${where}.region`, { lo: 1, integer: true }) as number
  const h = numArg(reg, 'height', `${where}.region`, { lo: 1, integer: true }) as number
  const [W, H] = e.display_size
  if (x + w > W || y + h > H) {
    throw new ArgError(
      `${where}.region x=${x}, y=${y}, width=${w}, height=${h} leaves ${e.fid}'s ${W}x${H} display image ` +
        `(need x + width <= ${W} and y + height <= ${H})`,
    )
  }
  return { x, y, width: w, height: h }
}

export function flattenArgs(v: Obj, where: string): [FlattenMode, number] {
  const mode = strArg(v, 'flatten', where, { def: 'plane', choices: FLATTEN_MODES }) as FlattenMode
  const hp = numArg(v, 'highpass_nm', where, { def: HIGHPASS_NM_DEFAULT, lo: 0, hi: MAX_HIGHPASS_NM, loExclusive: true }) as number
  if (v['highpass_nm'] !== undefined && mode !== 'highpass') throw new ArgError(`${where}.highpass_nm only applies with flatten='highpass'`)
  return [mode, hp]
}

export function failure(tool: string, err: unknown): ViewToolResult {
  if (err instanceof ArgError || err instanceof ArchiveError) return { ok: false, error: `${tool}: ${err.message}` }
  const e = err as Error
  return { ok: false, error: `${tool}: internal error ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}` }
}
