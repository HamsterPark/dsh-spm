/**
 * Units: SI as archived, display units as the model reads them.
 *
 * Archived arrays keep the file's SI values (m, A, Hz, V). Replies convert to a
 * display unit chosen from a short ladder per SI unit: Z in pm, current in pA
 * (fA when the frame never reaches 10 pA), frequency shift in Hz (mHz below
 * 10 Hz), voltages in mV. The finer unit is used when the largest magnitude
 * would be below 10 in the coarse one. Values in a known display unit are
 * rounded to 0.1 of that unit; anything else keeps 4 significant digits.
 * Same ladder and rounding as the Python reference (`frames.display_unit`,
 * `frames.round_value`).
 */
import { pyG, pyRound } from './pyfmt.js'

/** SI unit → `[display unit, factor]` from the coarse to the fine choice. */
export const UNIT_LADDER: Readonly<Record<string, readonly (readonly [string, number])[]>> = {
  m: [['pm', 1e12]],
  A: [['pA', 1e12], ['fA', 1e15]],
  V: [['mV', 1e3], ['µV', 1e6]],
  Hz: [['Hz', 1], ['mHz', 1e3]],
  N: [['pN', 1e12], ['fN', 1e15]],
  deg: [['deg', 1]],
  s: [['ms', 1e3], ['µs', 1e6]],
}

const KNOWN_DISPLAY_UNITS = new Set(Object.values(UNIT_LADDER).flatMap((l) => l.map(([u]) => u)))

export interface DisplayUnit {
  /** Multiply SI values by this to get values in `unit`. */
  readonly factor: number
  readonly unit: string
}

export function displayUnit(siUnit: string, maxAbs: number | null | undefined): DisplayUnit {
  const ladder = UNIT_LADDER[String(siUnit ?? '').trim()]
  if (ladder === undefined) return { factor: 1, unit: String(siUnit ?? '') }
  let [unit, factor] = ladder[0] as readonly [string, number]
  const finer = ladder[1]
  if (finer !== undefined && maxAbs !== null && maxAbs !== undefined && Number.isFinite(maxAbs) && maxAbs * factor < 10) {
    ;[unit, factor] = finer
  }
  return { factor, unit }
}

/** Rounded to 0.1 of a known display unit, 4 significant digits otherwise; NaN → null. */
export function roundValue(v: number, unit: string): number | null {
  if (!Number.isFinite(v)) return null
  if (KNOWN_DISPLAY_UNITS.has(unit)) return pyRound(v, 1)
  return Number(pyG(v, 4))
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

/** Largest finite |value|, or null when there is none. */
export function maxAbs(values: ArrayLike<number>): number | null {
  let m = -Infinity
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] as number
    if (Number.isFinite(v)) {
      const a = Math.abs(v)
      if (a > m) m = a
    }
  }
  return m === -Infinity ? null : m
}
