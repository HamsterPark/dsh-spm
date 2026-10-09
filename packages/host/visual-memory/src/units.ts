/**
 * Units and rounding as the model reads them (the Python reference's
 * `frames.MODEL_UNITS`, `unit_key`, `decimals_for`, `round_to`, `robust_span`
 * and `archive.ChannelFormat`).
 *
 * - **One model unit per quantity**, everywhere: heights in pm, currents in pA,
 *   voltages in V, frequencies in Hz (forces in pN). Archived arrays keep SI.
 * - **The unit travels in the key**: `values_pm`, `black_pa`, `range_hz`,
 *   `setpoint_pa` (`unitKey`). Replies carry no separate `unit` field.
 * - **Decimals follow the channel's value span**: about 1/100 of the robust span
 *   (0.5th to 99.5th percentile over every direction of the channel), between 1
 *   and 6 decimals (`decimalsFor`).
 *
 * Two roundings, as in the reference: single values use Python's `round` on the
 * exact binary value (`roundTo`); arrays of values use numpy's `np.round`, which
 * multiplies by 10^d, rounds half to even and divides (`npRound`). They differ
 * only when the scaled product itself rounds onto a half. Both turn -0 into 0.
 */
import { pyRound, rint } from './pyfmt.js'
import { percentileSorted } from './render.js'

/** SI unit → `[model unit, factor]`. */
export const MODEL_UNITS: Readonly<Record<string, readonly [string, number]>> = {
  m: ['pm', 1e12],
  A: ['pA', 1e12],
  V: ['V', 1],
  Hz: ['Hz', 1],
  N: ['pN', 1e12],
  deg: ['deg', 1],
  s: ['s', 1],
}

export interface DisplayUnit {
  /** Multiply SI values by this to get values in `unit`. */
  readonly factor: number
  readonly unit: string
}

/** The model unit of an SI unit; an unknown SI unit is reported as it is. */
export function displayUnit(siUnit: string): DisplayUnit {
  const got = MODEL_UNITS[String(siUnit ?? '').trim()]
  return got === undefined ? { factor: 1, unit: String(siUnit ?? '') } : { factor: got[1], unit: got[0] }
}

/** Key suffix of a model unit: `pm` → `pm`, `pA` → `pa`, `Hz` → `hz`, `V` → `v`; `""` for none. */
export function unitSuffix(unit: string): string {
  return String(unit ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** `unitKey('height', 'pm') === 'height_pm'`: model-facing keys carry their unit. */
export function unitKey(name: string, unit: string): string {
  const suf = unitSuffix(unit)
  return suf === '' ? name : `${name}_${suf}`
}

/** Label attribute for the colour scale: `z_range_pm` for Z, else `range_<unit suffix>`. */
export function rangeAttr(channel: string, unit: string): string {
  if (channel.trim().toLowerCase() === 'z' && unit === 'pm') return 'z_range_pm'
  return unit === '' ? 'range' : unitKey('range', unit)
}

/**
 * Decimals that resolve about 1/100 of a value span (in model units), within
 * 1..6: a 50 pm height range → 1, a 4 pA current range → 2, a 0.4 V sweep → 3.
 */
export function decimalsFor(span: number | null | undefined): number {
  if (span === null || span === undefined || !Number.isFinite(span) || span <= 0) return 1
  return Math.trunc(Math.min(6, Math.max(1, 2 - Math.floor(Math.log10(span)))))
}

/** Python `round(v, decimals) + 0.0`; null for NaN or a missing value. */
export function roundTo(v: number | null | undefined, decimals: number): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  return pyRound(v, decimals) + 0
}

/** numpy `np.round(v, decimals) + 0.0` for decimals >= 0; null for NaN. */
export function npRound(v: number, decimals: number): number | null {
  if (!Number.isFinite(v)) return null
  const f = 10 ** decimals
  return rint(v * f) / f + 0
}

/** 99.5th minus 0.5th percentile of the finite values of all arrays; null when there are none. */
export function robustSpan(...arrays: readonly (ArrayLike<number> | undefined)[]): number | null {
  const fin: number[] = []
  for (const a of arrays) {
    if (a === undefined) continue
    for (let i = 0; i < a.length; i += 1) {
      const v = a[i] as number
      if (Number.isFinite(v)) fin.push(v)
    }
  }
  if (fin.length === 0) return null
  const sorted = Float64Array.from(fin).sort()
  return percentileSorted(sorted, 99.5) - percentileSorted(sorted, 0.5)
}

/** How one channel of one frame is reported: the model unit, the factor from SI, the decimals. */
export interface ChannelFormat {
  readonly factor: number
  readonly unit: string
  readonly decimals: number
}

/** `channelFormat('m', 5e-11)` → pm, 1e12, decimals for a 50 pm span. */
export function channelFormat(siUnit: string, spanSi: number | null | undefined): ChannelFormat {
  const { factor, unit } = displayUnit(siUnit)
  return { factor, unit, decimals: decimalsFor(spanSi === null || spanSi === undefined ? null : spanSi * factor) }
}

/** `formatKey(fmt, 'black') === 'black_pm'` for a Z channel. */
export function formatKey(fmt: ChannelFormat, name: string): string {
  return unitKey(name, fmt.unit)
}

/** One SI value in the model unit, rounded like the reference's `ChannelFormat.value`. */
export function formatValue(fmt: ChannelFormat, vSi: number | null | undefined): number | null {
  return roundTo(vSi === null || vSi === undefined ? null : vSi * fmt.factor, fmt.decimals)
}

/** SI values in the model unit, rounded like the reference's `ChannelFormat.values`; NaN → null. */
export function formatValues(fmt: ChannelFormat, valuesSi: ArrayLike<number>): (number | null)[] {
  const out: (number | null)[] = []
  for (let i = 0; i < valuesSi.length; i += 1) out.push(npRound((valuesSi[i] as number) * fmt.factor, fmt.decimals))
  return out
}

const UNIT_BY_NAME: Readonly<Record<string, string>> = {
  z: 'm',
  current: 'A',
  bias: 'V',
  phase: 'deg',
  amplitude: 'm',
  'frequency shift': 'Hz',
  excitation: 'V',
  x: 'm',
  y: 'm',
}

/** SI unit of a channel: the file's `:DATA_INFO:` unit when given, else a guess by name. */
export function unitForChannel(name: string, units?: Readonly<Record<string, string>>): string {
  const given = units?.[name]
  if (given !== undefined && given !== '') return given
  const low = name.trim().toLowerCase()
  const byName = UNIT_BY_NAME[low]
  if (byName !== undefined) return byName
  if (low.includes('freq')) return 'Hz'
  if (low.includes('current')) return 'A'
  const m = /\(([^()]+)\)\s*$/.exec(name)
  return m === null ? '' : (m[1] as string).trim()
}

/** `"Current (A)"` → `"A"`; `"Current [bwd] (A)"` → `"A"`; no unit → `""`. */
export function columnUnit(name: string): string {
  const groups = [...name.matchAll(/\(([^()]*)\)/g)]
  const last = groups.at(-1)
  return last === undefined ? '' : (last[1] as string).trim()
}

/** `"Current (A)"` → `"Current"`. */
export function stripUnit(name: string): string {
  const s = name.replace(/\s*\([^()]*\)\s*$/, '').trim()
  return s === '' ? name : s
}
