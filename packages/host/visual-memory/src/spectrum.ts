/**
 * Spectra (`.dat`) as the archive keeps them, and the line plot the model sees
 * (the Python reference's `frames.load_dat`, `render_spectrum` and `in_range`).
 *
 * ## Columns
 *
 * A `.dat` file is read with `dsh-spm-nanonis-files` (`readDat`, pinned to
 * MAST's reader by its own golden). Every column stays float64 in SI units, in
 * file order; the first column is the sweep axis. A column's SI unit is the
 * last parenthesised group of its name (`"Current (A)"` → `A`). The header
 * gives the tip position (`X (m)`, `Y (m)` → nm), the bias, the feedback
 * setpoint and its unit, the experiment and the save time.
 *
 * ## The plot
 *
 * One panel per y column, all sharing x, values in model units (bias in V,
 * current in pA, Z in pm). `x_range` (in the x column's model unit) selects the
 * points shown, with a relative tolerance of 1e-9 for unit-conversion rounding.
 * The plot is `W = max(600, D)` pixels wide and `H = max(360, min(W, 90 + 300·n))`
 * high for `n` panels; the reference draws it with matplotlib, which truncates
 * each side to `int(px / 100 · 100)` in double precision, so a few widths above
 * 802 come out one pixel narrower. The size is in every label and `inspect`
 * reply, so it is reproduced here exactly; the pixels themselves are drawn by
 * this package and are not compared with the reference's (spec/deviations.md
 * D-VMEM-13).
 */
import { pyFloatRepr } from 'dsh-spm-kernel'
import { pyFloat, readDat } from 'dsh-spm-nanonis-files'
import { DISPLAY_MAX_DEFAULT } from './geometry.js'
import { encodePngRgb } from './png.js'
import { pyG } from './pyfmt.js'
import { IngestError, setpointUnit } from './scan-data.js'
import { columnUnit, displayUnit, stripUnit } from './units.js'

/** One spectrum, ready to archive. */
export interface SpectrumData {
  /** Column name → values (SI, float64), in file order; the first column is the sweep axis. */
  readonly columns: ReadonlyMap<string, Float64Array>
  /** Column name → SI unit (from the name; `""` when it has none). */
  readonly units: Readonly<Record<string, string>>
  readonly header: Readonly<Record<string, string>>
  readonly experiment: string
  /** Tip position in nm, or null when the file does not say. */
  readonly x_nm: number | null
  readonly y_nm: number | null
  readonly bias_v: number | null
  readonly setpoint_a: number | null
  /** SI unit of the setpoint: A for current feedback, Hz for frequency feedback. */
  readonly setpoint_unit: string
  readonly rec_time: string
  readonly source_name: string
}

/** The first token of a header value that reads as a finite number (the reference's `_first_float`). */
function firstFinite(value: string | undefined): number | null {
  for (const tok of String(value ?? '').replaceAll(';', ' ').split(/\s+/)) {
    if (tok === '') continue
    const v = pyFloat(tok)
    if (v !== null && Number.isFinite(v)) return v
  }
  return null
}

/** Every column and the header facts of a `.dat` file. Throws {@link IngestError}. */
export function loadDat(bytes: Uint8Array, sourceName: string): SpectrumData {
  let dat
  try {
    dat = readDat(bytes, sourceName)
  } catch (err) {
    throw new IngestError(`${sourceName}: ${(err as Error).message}`)
  }
  const columns = new Map(Object.entries(dat.columns))
  if (columns.size === 0) throw new IngestError(`${sourceName}: no data columns`)
  const hdr = dat.header
  const units: Record<string, string> = {}
  for (const name of columns.keys()) units[name] = columnUnit(name)
  const xM = firstFinite(hdr['X (m)'])
  const yM = firstFinite(hdr['Y (m)'])
  return {
    columns,
    units,
    header: { ...hdr },
    experiment: hdr['Experiment'] ?? '',
    x_nm: xM === null ? null : xM * 1e9,
    y_nm: yM === null ? null : yM * 1e9,
    bias_v: firstFinite(hdr['Bias>Bias (V)']),
    setpoint_a: firstFinite(hdr['Z-Controller>Setpoint']),
    setpoint_unit: setpointUnit(hdr['Z-Controller>Setpoint unit'], hdr['Z-Controller>Setpoint']),
    rec_time: hdr['Saved Date'] || (hdr['Date'] ?? ''),
    source_name: sourceName,
  }
}

/** `lo <= x <= hi` with a relative tolerance of 1e-9 (unit-conversion rounding); NaN is never in range. */
export function inRange(x: number, lo: number, hi: number): boolean {
  const eps = 1e-9 * Math.max(1, Math.abs(lo), Math.abs(hi))
  return x >= lo - eps && x <= hi + eps
}

/** Smallest and largest value ignoring NaN (numpy's `nanmin` / `nanmax`); NaN when every value is NaN. */
export function nanExtent(values: ArrayLike<number>): [number, number] {
  let lo = Number.NaN
  let hi = Number.NaN
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] as number
    if (Number.isNaN(v)) continue
    if (!(v >= lo)) lo = v
    if (!(v <= hi)) hi = v
  }
  return [lo, hi]
}

export const SPECTRUM_MIN_WIDTH = 600
export const SPECTRUM_MIN_HEIGHT = 360
export const SPECTRUM_PANEL_PX = 300
/** The plotted series' colour. */
export const SPECTRUM_RGB = '#1f4e9c'

/** matplotlib's canvas side for a figure of `px / 100` inches at 100 dpi. */
function canvasPx(px: number): number {
  return Math.trunc((px / 100) * 100)
}

/** `[W, H]` of a spectrum plot with `panels` panels, drawn `widthPx` wide (at least 600). */
export function spectrumPlotSize(widthPx: number, panels: number): [number, number] {
  const w = Math.max(SPECTRUM_MIN_WIDTH, Math.trunc(widthPx))
  const h = Math.max(SPECTRUM_MIN_HEIGHT, Math.min(w, 90 + SPECTRUM_PANEL_PX * panels))
  return [canvasPx(w), canvasPx(h)]
}

/** A plot request the columns cannot satisfy (an `x_range` without points); the message says why. */
export class SpectrumError extends Error {
  override readonly name = 'SpectrumError'
}

/** One plotted column and its model unit, as the reply lists it. */
export interface SpectrumColumn {
  readonly column: string
  readonly unit: string
}

/** What a spectrum plot shows (the reference's `render_spectrum` meta). */
export interface SpectrumPlotMeta {
  readonly x_col: string
  readonly x_unit: string
  readonly y: readonly SpectrumColumn[]
  /** Points shown (inside `x_range`). */
  readonly n_points: number
  /** Smallest and largest x shown, in the x column's model unit. */
  readonly x_shown: readonly [number, number]
}

export interface SpectrumPlot {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  readonly meta: SpectrumPlotMeta
}

export interface SpectrumPlotOptions {
  readonly xCol: string
  /** One panel each, top to bottom. */
  readonly yCols: readonly string[]
  /** `[low, high]` in the x column's model unit; null for every point. */
  readonly xRange?: readonly [number, number] | null
  /** Plot width before the minimum of 600 (default: the default display size). */
  readonly widthPx?: number
}

/** Axis label of a column: `"Bias (V)"`, or the column name when it has no unit. */
function axisLabel(column: string, unit: string): string {
  return unit === '' ? column : `${stripUnit(column)} (${unit})`
}

/**
 * Line plots of `yCols` against `xCol`, one panel each with a shared x, values
 * in model units. Throws {@link SpectrumError} when `xRange` holds no point.
 */
export function renderSpectrumPlot(
  columns: ReadonlyMap<string, Float64Array>,
  units: Readonly<Record<string, string>>,
  options: SpectrumPlotOptions,
): SpectrumPlot {
  const { xCol, yCols } = options
  const xsSi = columns.get(xCol)
  if (xsSi === undefined) throw new SpectrumError(`no column ${JSON.stringify(xCol)}`)
  const { factor: fx, unit: ux } = displayUnit(units[xCol] ?? '')
  const xs = xsSi.map((v) => v * fx)
  let sel = Array.from(xs, (_, i) => i)
  if (options.xRange !== undefined && options.xRange !== null) {
    const [lo, hi] = [...options.xRange].sort((a, b) => a - b) as [number, number]
    sel = sel.filter((i) => inRange(xs[i] as number, lo, hi))
    if (sel.length === 0) {
      const [xmin, xmax] = nanExtent(xs)
      throw new SpectrumError(
        `x_range ${pyFloatRepr(lo)}..${pyFloatRepr(hi)} ${ux} contains no samples (x spans ${pyG(xmin, 4)}..${pyG(xmax, 4)} ${ux})`,
      )
    }
  }
  const xShown = Float64Array.from(sel, (i) => xs[i] as number)
  const [width, height] = spectrumPlotSize(options.widthPx ?? DISPLAY_MAX_DEFAULT, yCols.length)
  const y: SpectrumColumn[] = []
  const panels = yCols.map((yc) => {
    const ysSi = columns.get(yc)
    if (ysSi === undefined) throw new SpectrumError(`no column ${JSON.stringify(yc)}`)
    const { factor: fy, unit: uy } = displayUnit(units[yc] ?? '')
    y.push({ column: yc, unit: uy })
    return {
      yLabel: axisLabel(yc, uy),
      series: [{ x: xShown, y: Float64Array.from(sel, (i) => (ysSi[i] as number) * fy), colour: SPECTRUM_RGB }],
    }
  })
  const plot = linePlot({ width, height, xLabel: axisLabel(xCol, ux), panels })
  const [xmin, xmax] = nanExtent(xShown)
  return {
    png: plot.png,
    width: plot.width,
    height: plot.height,
    meta: { x_col: xCol, x_unit: ux, y, n_points: sel.length, x_shown: [xmin, xmax] },
  }
}

// TEMPORARY: a blank plot of the right size until the shared drawing module
// (`src/draw.ts`, `linePlot`) lands on feat/visual-tools.
function linePlot(spec: {
  readonly width: number
  readonly height: number
  readonly xLabel: string
  readonly panels: readonly { readonly yLabel: string; readonly series: readonly { readonly x: ArrayLike<number>; readonly y: ArrayLike<number>; readonly colour?: string }[] }[]
}): { png: Uint8Array; width: number; height: number } {
  const { width, height } = spec
  return { png: encodePngRgb(width, height, new Uint8Array(width * height * 3).fill(255)), width, height }
}
