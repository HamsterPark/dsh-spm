/**
 * Frame ids: `t<turn:04d>.<kind><i>` (VISUAL-HARNESS §4.2).
 *
 * `turn` is the action turn that produced the frame (0 = the observation the
 * session started from); `kind` is one of
 *
 * | kind | meaning |
 * |---|---|
 * | `s` | saved scan (`.sxm`) |
 * | `p` | partial snapshot of a scan in progress |
 * | `d` | saved spectrum (`.dat`) |
 * | `m` | derived image a measurement tool produced |
 *
 * and `i` counts the frames of that kind within the turn. Same grammar as the
 * Python reference (`stmbench.vista.protocol.frame_id`): the turn is zero-padded
 * to at least four digits, the index is not padded.
 */

export const FRAME_KINDS = ['s', 'p', 'd', 'm'] as const
export type FrameKind = (typeof FRAME_KINDS)[number]

/** Human words for the kinds, as tool replies and error messages use them. */
export const KIND_WORDS: Readonly<Record<FrameKind, string>> = {
  s: 'scan',
  p: 'partial scan',
  d: 'spectrum',
  m: 'derived image',
}

const FRAME_RE = /^t(\d{4,})\.([spdm])(\d+)$/

/** A malformed frame id or out-of-range component. */
export class FrameIdError extends RangeError {
  override readonly name = 'FrameIdError'
}

export function isFrameKind(value: unknown): value is FrameKind {
  return typeof value === 'string' && (FRAME_KINDS as readonly string[]).includes(value)
}

/** `frameId(7, 's', 0) === 't0007.s0'`. */
export function frameId(turn: number, kind: FrameKind, index: number): string {
  if (!isFrameKind(kind)) throw new FrameIdError(`frame kind ${JSON.stringify(kind)} is not one of ${FRAME_KINDS.join(', ')}`)
  if (!Number.isSafeInteger(turn) || turn < 0) throw new FrameIdError(`turn must be an integer >= 0, got ${turn}`)
  if (!Number.isSafeInteger(index) || index < 0) throw new FrameIdError(`index must be an integer >= 0, got ${index}`)
  return `t${String(turn).padStart(4, '0')}.${kind}${index}`
}

export interface ParsedFrameId {
  readonly turn: number
  readonly kind: FrameKind
  readonly index: number
}

/** Parse a frame id (surrounding whitespace is ignored). Throws {@link FrameIdError}. */
export function parseFrameId(id: string): ParsedFrameId {
  const m = FRAME_RE.exec(String(id).trim())
  if (m === null) throw new FrameIdError(`not a frame id: ${JSON.stringify(id)} (expected like 't0007.s0')`)
  return { turn: Number(m[1]), kind: m[2] as FrameKind, index: Number(m[3]) }
}

export function isFrameId(id: unknown): boolean {
  return typeof id === 'string' && FRAME_RE.test(id.trim())
}
