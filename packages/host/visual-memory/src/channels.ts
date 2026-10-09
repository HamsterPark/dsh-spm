/**
 * Channel names: resolving what the model asked for, and choosing the default.
 *
 * Nanonis channel names vary between instruments ("Z", "z", "Frequency shift",
 * "Current (A)"), so a request is matched exactly, then case-insensitively, then
 * ignoring whitespace/punctuation, then ignoring a trailing unit, then through a
 * few aliases (height/topography → Z, I/It → Current, df/Δf → the channel in Hz).
 * Same rules as the Python reference (`frames.resolve_channel`).
 */
import { stripUnit, unitForChannel } from './units.js'

/** An unknown channel; the message lists the channels that exist. */
export class ChannelError extends Error {
  override readonly name = 'ChannelError'
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[\s_.-]+/g, '')
}

/** The channel `name` refers to by name rules alone, or undefined. */
export function findChannel(channels: readonly string[], name: string): string | undefined {
  if (channels.includes(name)) return name
  const low = name.toLowerCase()
  const ci = channels.find((c) => c.toLowerCase() === low)
  if (ci !== undefined) return ci
  const n = norm(name)
  const nm = channels.find((c) => norm(c) === n)
  if (nm !== undefined) return nm
  const nu = norm(stripUnit(name))
  return channels.find((c) => norm(stripUnit(c)) === nu)
}

const ALIASES: Readonly<Record<string, string>> = {
  height: 'z',
  topography: 'z',
  topo: 'z',
  it: 'current',
  i: 'current',
  tunnelingcurrent: 'current',
  tunnellingcurrent: 'current',
}

const DF_NAMES = new Set(['df', 'δf', 'deltaf', 'frequencyshift', 'freqshift'])

/** Resolve a requested channel name. Throws {@link ChannelError}. */
export function resolveChannel(
  name: string,
  channels: readonly string[],
  units?: Readonly<Record<string, string>>,
): string {
  const found = findChannel(channels, name)
  if (found !== undefined) return found
  const n = norm(name)
  const alias = ALIASES[n]
  if (alias !== undefined) {
    const a = findChannel(channels, alias)
    if (a !== undefined) return a
  }
  if (DF_NAMES.has(n)) {
    const hz = channels.find((c) => unitForChannel(c, units) === 'Hz' || c.toLowerCase().includes('freq'))
    if (hz !== undefined) return hz
  }
  throw new ChannelError(`no channel ${JSON.stringify(name)}; this frame has ${JSON.stringify(channels)}`)
}

/** Peak-to-peak of the finite values (0 when there are none). */
export function span(values: ArrayLike<number> | undefined): number {
  if (values === undefined) return 0
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] as number
    if (Number.isFinite(v)) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  return hi >= lo ? hi - lo : 0
}

/** A frame whose Z varies by less than this was taken at constant height. */
export const CONSTANT_HEIGHT_Z_RANGE_M = 1e-12

/**
 * The default channel of a scan: Z, unless Z varies by less than 1 pm (constant
 * height); then Current, then a frequency-shift channel, then the first channel
 * that varies at all.
 */
export function defaultChannel(
  channels: readonly string[],
  values: (channel: string) => ArrayLike<number> | undefined,
  units?: Readonly<Record<string, string>>,
): string {
  const z = findChannel(channels, 'Z')
  if (z !== undefined && span(values(z)) >= CONSTANT_HEIGHT_Z_RANGE_M) return z
  const cur = findChannel(channels, 'Current')
  if (cur !== undefined && span(values(cur)) > 0) return cur
  for (const c of channels) {
    if ((c.toLowerCase().includes('freq') || unitForChannel(c, units) === 'Hz') && span(values(c)) > 0) return c
  }
  for (const c of channels) {
    if (c !== z && span(values(c)) > 0) return c
  }
  return z ?? (channels[0] as string)
}
