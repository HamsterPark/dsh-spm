/**
 * `line_profile`: values along a straight line in one archived scan frame, and the
 * steps on it — the Python reference's `vista_spm.measure.line_profile` and
 * `change_points`, with its argument rules, reply keys, units, decimals and messages.
 *
 * ## What it does
 *
 * The end points `p1`, `p2` are `{x, y}` in display pixels of the frame's full image or
 * `{x_nm, y_nm}` in scan-frame nm; they may lie on the frame's edge (1e-6 scan px of
 * slack, then clamped). The frame is flattened over its whole area (default `plane`),
 * then sampled bilinearly at `n = min(400, max(2, ceil(L) + 1))` points from p1 to p2
 * (`L` = the line's length in scan pixels) on `max(1, round(w))` parallel lines spread
 * across the band width `w` (scan px), whose finite samples are averaged. A sample
 * that touches a pixel never acquired is NaN on that line; `null` in the reply when every
 * line is.
 *
 * Steps come from {@link changePoints}: binary segmentation into straight segments
 * (a split must gain more than `max(25, 6 ln n) σ²`), splits closer than the merge
 * distance form one transition, and a transition is a step when the lines on either side
 * differ by at least 4 σ at its middle, σ being the per-sample noise from the median
 * absolute first difference. The reply lists the samples, the segments and the steps;
 * one plot of the profile is archived as a derived frame.
 *
 * ## Same numbers as the reference
 *
 * - sampling is scipy's `map_coordinates(order=1, mode='nearest')` bit for bit
 *   (`dsh-spm-numerics`' `mapCoordinates`): weights `1 − t` and `1 − (1 − t)`, every one
 *   of the four neighbours multiplied in (a NaN neighbour makes the sample NaN even at
 *   weight 0), and a coordinate outside the frame (the first and last half pixel of a
 *   line on the edge) keeps its fraction while the neighbours are clamped;
 * - the line length is CPython's `math.hypot` ({@link pyHypot}), because the sample count
 *   is `ceil(L) + 1`;
 * - prefix sums, the sum of squared residuals, the split search, medians, means
 *   (`npMean`, numpy's pairwise sum) and the averaging over lines follow numpy's
 *   operation order;
 * - only the straight-line fit of a segment ({@link linfit}) is another algorithm: numpy
 *   solves it by SVD (`polyfit`), this by the centred closed form; both are backward
 *   stable, so slopes and heights agree to rounding error (see `measure-profile.parity.test.ts`).
 *
 * Never throws: invalid arguments come back as `{ ok: false, error }`.
 */
import { linspace, mapCoordinates, matOf, npMean, npStd } from 'dsh-spm-numerics'
import { linePlot } from './draw.js'
import { ArgError, argsObject, channelDirectionArgs, checkKeys, failure, flattenArgs, frameArg, isObj, numArg, type Obj, type ViewToolResult } from './args.js'
import { entryScale, kindWord, type FrameArchive, type FrameEntry } from './archive.js'
import { flatten, FlattenError, nanMedian, type FlattenMode } from './flatten.js'
import { nativeToScanNm, scanNmToNative, type ScanGeometry } from './geometry.js'
import { pyG, pyRound, pyRoundInt } from './pyfmt.js'
import { pyHypot, pyMax, pyMin, pyMod } from './pymath.js'
import type { Direction } from './scan-data.js'
import { formatKey, formatValues, roundTo, type ChannelFormat } from './units.js'

/** At most this many samples along a line (longer lines are sampled more sparsely). */
export const MAX_PROFILE_SAMPLES = 400
/** A step is reported when the two sides differ by at least this many noise sigmas. */
export const STEP_MIN_JUMP_SIGMA = 4
/** Height of the profile plot in pixels; its width is `max(600, display_max)` (both through {@link plotPx}). */
export const PROFILE_PLOT_HEIGHT = 400

/**
 * The pixels matplotlib gives a side of `px` pixels: the reference makes a figure of
 * `px / 100` inches at 100 dpi, and the canvas is `int(inches · dpi)` in float64, so
 * some sizes lose a pixel (803 → 802; 107 of the widths 600..2048).
 */
export function plotPx(px: number): number {
  return Math.trunc((px / 100) * 100)
}

// ── shared by the measurement tools ──────────────────────────────────────

/** Has a 2-D grid of values: a scan, a partial scan, or a derived map with values (`is_image`). */
export function isImage(e: FrameEntry): boolean {
  return e.geometry !== null && (e.kind === 's' || e.kind === 'p' || e.kind === 'm') && e.channels.length > 0
}

/** The frame argument of a measurement tool: an archived frame with a grid of values. */
export function imageEntry(archive: FrameArchive, args: Obj, key = 'frame'): FrameEntry {
  const e = frameArg(archive, args[key], key, true)
  if (!isImage(e)) throw new ArgError(`${key}: ${e.fid} is a ${kindWord(e)}; this tool needs a scan frame`)
  return e
}

/** nm per native pixel along x and y (`_pixel_nm`). */
export function pixelNm(e: FrameEntry): [number, number] {
  const dx = e.nm_per_px as number
  return [dx, e.extra.nm_per_px_y || dx]
}

/** The frame's values with the background removed over the whole frame (`_flat_frame`). */
export function flatFrame(archive: FrameArchive, e: FrameEntry, channel: string, direction: Direction, mode: FlattenMode, highpassNm: number): Float64Array {
  const [dx, dy] = pixelNm(e)
  try {
    return flatten(archive.values(e, channel, direction), e.nx, e.ny, mode, { nmPerPx: Math.sqrt(dx * dy), highpassNm })
  } catch (err) {
    if (err instanceof FlattenError) throw new ArgError(err.message)
    throw err
  }
}

// ── change points ──────────────────────────────────────────────────────────

export interface ProfileStep {
  /** Index of the transition's first sample in the input (non-finite samples included). */
  readonly index: number
  /** Middle of the transition (x units). */
  readonly x: number
  /** Right side minus left side at `x`. */
  readonly height: number
  /** Distance between the first and the last split of the transition. */
  readonly width: number
}

export interface ProfileSegment {
  readonly start: number
  readonly end: number
  readonly slope: number
  readonly mean: number
  readonly n: number
}

export interface ChangePoints {
  readonly steps: ProfileStep[]
  /** Per-sample noise (robust, from first differences). */
  readonly sigma: number
  readonly segments: ProfileSegment[]
}

export interface ChangePointOptions {
  readonly maxSplits?: number
  readonly minSeg?: number
  readonly minHeightSigma?: number
  /** Splits closer than this (x units) are one transition; default 6 % of the range, at least 4 samples. */
  readonly merge?: number | null
}

function diff(v: Float64Array): Float64Array {
  const out = new Float64Array(Math.max(0, v.length - 1))
  for (let i = 0; i < out.length; i += 1) out[i] = (v[i + 1] as number) - (v[i] as number)
  return out
}

/** `1.4826 · median(|v − median(v)|)` of the finite values; 0 when there are none. */
export function madSigma(v: ArrayLike<number>): number {
  const fin: number[] = []
  for (let i = 0; i < v.length; i += 1) if (Number.isFinite(v[i] as number)) fin.push(v[i] as number)
  if (fin.length === 0) return 0
  const m = nanMedian(fin)
  return 1.4826 * nanMedian(fin.map((x) => Math.abs(x - m)))
}

/** `np.concatenate([[0.0], np.cumsum(v)])`: sequential prefix sums. */
function prefix(v: Float64Array): Float64Array {
  const p = new Float64Array(v.length + 1)
  if (v.length > 0) p[1] = v[0] as number
  for (let i = 1; i < v.length; i += 1) p[i + 1] = (p[i] as number) + (v[i] as number)
  return p
}

/** Sum of squared residuals of the best straight line, from the six sums (`_linfit_sse`). */
function linfitSse(n: number, sx: number, sy: number, sxx: number, sxy: number, syy: number): number {
  const vx = sxx - (sx * sx) / n
  const vxy = sxy - (sx * sy) / n
  const vy = syy - (sy * sy) / n
  const sse = vx > 1e-12 * Math.max(1, sxx) ? vy - (vxy * vxy) / vx : vy
  return Number.isNaN(sse) || sse >= 0 ? sse : 0
}

/**
 * Slope and intercept of the least-squares line through `(x, y)` — the reference's
 * `_linfit` (`np.polyfit(x, y, 1)`; `(0, mean(y))` for fewer than two points or a
 * single x). Centred closed form: `slope = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²`, `intercept = ȳ − slope·x̄`.
 */
export function linfit(x: Float64Array, y: Float64Array): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of x) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (x.length < 2 || hi - lo === 0) return [0, y.length > 0 ? npMean(y) : 0]
  const mx = npMean(x)
  const my = npMean(y)
  const dxx = new Float64Array(x.length)
  const dxy = new Float64Array(x.length)
  for (let i = 0; i < x.length; i += 1) {
    const u = (x[i] as number) - mx
    dxx[i] = u * u
    dxy[i] = u * ((y[i] as number) - my)
  }
  const slope = npMean(dxy) / npMean(dxx)
  return [slope, my - slope * mx]
}

/**
 * Steps in a profile by binary segmentation into straight segments — the reference's
 * `change_points`, same defaults (8 splits, segments of at least 3 samples, steps of
 * at least 4 σ). Non-finite samples are dropped first; fewer than `2·minSeg + 1`
 * finite samples give no steps, σ = 0 and no segments.
 */
export function changePoints(x: ArrayLike<number>, y: ArrayLike<number>, options: ChangePointOptions = {}): ChangePoints {
  const maxSplits = options.maxSplits ?? 8
  const minSeg = options.minSeg ?? 3
  const minHeightSigma = options.minHeightSigma ?? STEP_MIN_JUMP_SIGMA
  const ok: number[] = []
  for (let i = 0; i < x.length; i += 1) if (Number.isFinite(x[i] as number) && Number.isFinite(y[i] as number)) ok.push(i)
  const n = ok.length
  const xs = Float64Array.from(ok, (i) => x[i] as number)
  const ys = Float64Array.from(ok, (i) => y[i] as number)
  if (n < 2 * minSeg + 1) return { steps: [], sigma: 0, segments: [] }
  const d = diff(ys)
  let sigma = madSigma(d) / Math.sqrt(2)
  if (sigma <= 0) sigma = d.length > 0 ? pyMax(1e-12, npStd(d) / Math.sqrt(2)) : 1e-12
  const terms = [new Float64Array(n).fill(1), xs, ys, xs.map((v) => v * v), xs.map((v, i) => v * (ys[i] as number)), ys.map((v) => v * v)]
  const [pn, px, py, pxx, pxy, pyy] = terms.map(prefix) as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array]
  const sse = (a: number, b: number): number =>
    linfitSse(
      (pn[b] as number) - (pn[a] as number),
      (px[b] as number) - (px[a] as number),
      (py[b] as number) - (py[a] as number),
      (pxx[b] as number) - (pxx[a] as number),
      (pxy[b] as number) - (pxy[a] as number),
      (pyy[b] as number) - (pyy[a] as number),
    )
  const penalty = pyMax(25, 6 * Math.log(n)) * sigma * sigma
  const segments: [number, number][] = [[0, n]]
  const splits: number[] = []
  for (let round = 0; round < maxSplits; round += 1) {
    let best: { gain: number; t: number; seg: [number, number] } | null = null
    for (const seg of segments) {
      const [s, e] = seg
      if (e - s < 2 * minSeg + 1) continue
      const whole = sse(s, e)
      // np.argmax: the first maximum, or the first NaN
      let k = -1
      let gk = NaN
      for (let t = s + minSeg; t <= e - minSeg; t += 1) {
        const gain = whole - (sse(s, t) + sse(t, e))
        if (k < 0 || (!Number.isNaN(gk) && (gain > gk || Number.isNaN(gain)))) {
          k = t
          gk = gain
        }
      }
      if (best === null || gk > best.gain) best = { gain: gk, t: k, seg }
    }
    if (best === null || best.gain < penalty) break
    const [s, e] = best.seg
    segments.splice(segments.indexOf(best.seg), 1)
    segments.push([s, best.t], [best.t, e])
    splits.push(best.t)
  }
  const sorted = [...segments].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const segOut: ProfileSegment[] = sorted.map(([s, e]) => ({
    start: xs[s] as number,
    end: xs[e - 1] as number,
    slope: linfit(xs.subarray(s, e), ys.subarray(s, e))[0],
    mean: npMean(ys.subarray(s, e)),
    n: e - s,
  }))
  let merge = options.merge
  if (merge === undefined || merge === null) {
    const spacing = n > 1 ? nanMedian(diff(xs)) : 0
    merge = pyMax(4 * spacing, 0.06 * ((xs[n - 1] as number) - (xs[0] as number)))
  }
  const segByStart = new Map(segments.map(([a, b]) => [a, b]))
  const segByEnd = new Map(segments.map(([a, b]) => [b, a]))
  const mid = (t: number): number => 0.5 * ((xs[t - 1] as number) + (xs[t] as number))
  const groups: number[][] = []
  for (const t of [...splits].sort((a, b) => a - b)) {
    const last = groups.at(-1)
    if (last !== undefined && mid(t) - mid(last.at(-1) as number) <= merge) last.push(t)
    else groups.push([t])
  }
  const steps: ProfileStep[] = []
  for (const grp of groups) {
    const t0 = grp[0] as number
    const t1 = grp.at(-1) as number
    const s0 = segByEnd.get(t0) as number
    const e1 = segByStart.get(t1) as number
    const [sl, il] = linfit(xs.subarray(s0, t0), ys.subarray(s0, t0))
    const [sr, ir] = linfit(xs.subarray(t1, e1), ys.subarray(t1, e1))
    const xm = 0.25 * ((xs[t0 - 1] as number) + (xs[t0] as number) + (xs[t1 - 1] as number) + (xs[t1] as number))
    const h = sr * xm + ir - (sl * xm + il)
    if (Math.abs(h) >= minHeightSigma * sigma) {
      steps.push({ index: ok[t0] as number, x: xm, height: h, width: mid(t1) - mid(t0) })
    }
  }
  return { steps, sigma, segments: segOut }
}

// ── sampling ──────────────────────────────────────────────────────────────

/**
 * The band average along a line: `n` samples from `(c1, r1)` to `(c2, r2)` (native
 * continuous coordinates; pixel centres at `i + 0.5`) on `max(1, round(wn))` lines
 * `wn / lines` apart across a band `wn` scan pixels wide, each line sampled with scipy's
 * `map_coordinates(order=1, mode='nearest')` (`mapCoordinates`); NaN where no line has a
 * finite sample (`np.nanmean` over the lines, summed in order).
 */
export function bandProfile(
  z: Float64Array,
  nx: number,
  ny: number,
  ends: readonly [number, number, number, number],
  n: number,
  wn: number,
): Float64Array {
  const [c1, r1, c2, r2] = ends
  const L = pyHypot(c2 - c1, r2 - r1)
  const t = linspace(0, 1, n)
  const cs = t.map((v) => c1 + v * (c2 - c1) - 0.5)
  const rs = t.map((v) => r1 + v * (r2 - r1) - 0.5)
  const nLines = Math.max(1, pyRoundInt(wn))
  const nc = -(r2 - r1) / L
  const nr = (c2 - c1) / L
  const grid = matOf(ny, nx, z)
  const tot = new Float64Array(n)
  const cnt = new Int32Array(n)
  for (let k = 0; k < nLines; k += 1) {
    const o = (k - (nLines - 1) / 2) * (wn / nLines)
    const line = mapCoordinates(grid, rs.map((r) => r + o * nr), cs.map((c) => c + o * nc), 1, 'nearest')
    line.forEach((v, i) => {
      if (!Number.isNaN(v)) {
        tot[i] = (tot[i] as number) + v
        cnt[i] = (cnt[i] as number) + 1
      }
    })
  }
  return tot.map((s, i) => s / (cnt[i] as number))
}

// ── the tool ─────────────────────────────────────────────────────────────

const LINE_PROFILE_KEYS: ReadonlySet<string> = new Set(['frame', 'p1', 'p2', 'channel', 'direction', 'width_px', 'flatten', 'highpass_nm'])
const POINT_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'x_nm', 'y_nm'])

/** An end point as native continuous coordinates, clamped onto the frame (`_point_to_native`). */
export function pointToNative(e: FrameEntry, p: unknown, where: string): [number, number] {
  if (!isObj(p)) throw new ArgError(`${where} must be an object {x, y} (display px) or {x_nm, y_nm} (scan nm)`)
  checkKeys(p, POINT_KEYS, [], where)
  const hasPx = 'x' in p || 'y' in p
  const hasNm = 'x_nm' in p || 'y_nm' in p
  if (hasPx === hasNm) throw new ArgError(`${where}: give either x and y (display px) or x_nm and y_nm (scan nm)`)
  let col: number
  let row: number
  if (hasPx) {
    const x = numArg(p, 'x', where)
    const y = numArg(p, 'y', where)
    if (x === undefined || y === undefined) throw new ArgError(`${where}: give both x and y`)
    const s = entryScale(e)
    col = (x * s.den) / s.num
    row = (y * s.den) / s.num
  } else {
    const X = numArg(p, 'x_nm', where)
    const Y = numArg(p, 'y_nm', where)
    if (X === undefined || Y === undefined) throw new ArgError(`${where}: give both x_nm and y_nm`)
    ;[col, row] = scanNmToNative(e.geometry as ScanGeometry, X, Y)
  }
  const tol = 1e-6
  if (!(-tol <= col && col <= e.nx + tol && -tol <= row && row <= e.ny + tol)) {
    const [W, H] = e.display_size
    throw new ArgError(`${where} lies outside ${e.fid} (display image ${W}x${H}, i.e. 0 <= x <= ${W}, 0 <= y <= ${H})`)
  }
  return [pyMin(pyMax(col, 0), e.nx), pyMin(pyMax(row, 0), e.ny)]
}

function pointReport(e: FrameEntry, col: number, row: number): Record<string, number> {
  const s = entryScale(e)
  const [X, Y] = nativeToScanNm(e.geometry as ScanGeometry, col, row)
  return { x_px: pyRound((col * s.num) / s.den, 3), y_px: pyRound((row * s.num) / s.den, 3), x_nm: pyRound(X, 4), y_nm: pyRound(Y, 4) }
}

/** Direction (deg, scan frame, from +x toward +y, -180..180) of a native displacement. */
export function scanAngleDeg(e: FrameEntry, dcol: number, drow: number): number {
  const [dx, dy] = pixelNm(e)
  const a = Math.atan2(-drow * dy, dcol * dx) * (180 / Math.PI) + ((e.geometry as ScanGeometry).angle_deg || 0)
  return pyMod(a + 180, 360) - 180
}

/**
 * The reference's profile plot (`_plot_png` with its `draw`), as large as matplotlib makes
 * a `max(600, display_max)` × 400 figure ({@link plotPx}): the values against the
 * distance from p1, a dashed red line at each step's position numbered at the top, axis
 * labels with units. Drawn by `draw.ts` (pixels differ, D-VMEM-6).
 */
function profilePlot(displayMax: number, m: MeasuredLine, steps: readonly { readonly id: number; readonly position_nm: number }[]): Uint8Array {
  const unit = m.fmt.unit
  return linePlot({
    width: plotPx(Math.max(600, displayMax)),
    height: plotPx(PROFILE_PLOT_HEIGHT),
    xLabel: 'distance from p1 (nm)',
    panels: [
      {
        yLabel: unit === '' ? m.channel : `${m.channel} (${unit})`,
        series: [{ x: m.dist, y: m.vals }],
        vlines: steps.map((s) => ({ x: s.position_nm, text: String(s.id) })),
      },
    ],
  }).png
}

function segmentReport(fmt: ChannelFormat, g: ProfileSegment): Record<string, number | null> {
  return {
    from_nm: pyRound(g.start, 3),
    to_nm: pyRound(g.end, 3),
    [`${formatKey(fmt, 'slope')}_per_nm`]: Number(pyG(g.slope, 4)) + 0,
    [formatKey(fmt, 'mean')]: roundTo(g.mean, fmt.decimals),
  }
}

/** Everything `line_profile` measures before it rounds and archives (exported for the parity test). */
export interface MeasuredLine {
  readonly e: FrameEntry
  readonly channel: string
  readonly direction: Direction
  readonly flatten: FlattenMode
  readonly highpassNm: number
  readonly widthPx: number
  /** `[c1, r1, c2, r2]`: the end points in native continuous coordinates. */
  readonly ends: readonly [number, number, number, number]
  readonly lengthNm: number
  /** Band width in scan pixels. */
  readonly wn: number
  readonly fmt: ChannelFormat
  /** Band averages in SI units, and in the model unit (the change-point input). */
  readonly valsSi: Float64Array
  readonly vals: Float64Array
  /** Distance of every sample from p1, nm. */
  readonly dist: Float64Array
  /** The merge distance handed to {@link changePoints}: 6 % of the length within 4 samples .. max(2 nm, 4 samples). */
  readonly merge: number
  readonly cp: ChangePoints
}

/** Validate the arguments and measure the line; throws {@link ArgError} / `ArchiveError`. */
export function measureLine(archive: FrameArchive, args: unknown): MeasuredLine {
  const a = argsObject(args)
  checkKeys(a, LINE_PROFILE_KEYS, ['frame', 'p1', 'p2'], 'arguments')
  const e = imageEntry(archive, a)
  const [channel, direction] = channelDirectionArgs(archive, e, a, 'arguments')
  const [mode, hp] = flattenArgs(a, 'arguments')
  const widthPx = numArg(a, 'width_px', 'arguments', { def: 1, lo: 1, hi: archive.displayMax }) as number
  const [c1, r1] = pointToNative(e, a['p1'], 'p1')
  const [c2, r2] = pointToNative(e, a['p2'], 'p2')
  const L = pyHypot(c2 - c1, r2 - r1)
  if (L < 1) throw new ArgError('p1 and p2 are less than one scan pixel apart')
  const [dx, dy] = pixelNm(e)
  const lengthNm = pyHypot((c2 - c1) * dx, (r2 - r1) * dy)
  const z = flatFrame(archive, e, channel, direction, mode, hp)
  const n = Math.min(MAX_PROFILE_SAMPLES, Math.max(2, Math.ceil(L) + 1))
  const s = entryScale(e)
  const wn = (widthPx * s.den) / s.num
  const valsSi = bandProfile(z, e.nx, e.ny, [c1, r1, c2, r2], n, wn)
  const fmt = archive.fmt(e, channel)
  const vals = valsSi.map((v) => v * fmt.factor)
  const dist = linspace(0, 1, n).map((v) => v * lengthNm)
  const spacing = lengthNm / (n - 1)
  // np.clip(0.06 · length, 4 · spacing, max(2, 4 · spacing))
  const lo = 4 * spacing
  const atLeast = 0.06 * lengthNm > lo ? 0.06 * lengthNm : lo
  const hi = pyMax(2, 4 * spacing)
  const merge = atLeast < hi ? atLeast : hi
  const cp = changePoints(dist, vals, { merge })
  return { e, channel, direction, flatten: mode, highpassNm: hp, widthPx, ends: [c1, r1, c2, r2], lengthNm, wn, fmt, valsSi, vals, dist, merge, cp }
}

/** `line_profile(frame, p1, p2, …)`: see the module comment. Never throws. */
export function lineProfile(archive: FrameArchive, args: unknown): ViewToolResult {
  try {
    const m = measureLine(archive, args)
    const { e, channel: ch, direction, flatten: mode, highpassNm: hp, widthPx, lengthNm, wn, fmt, cp } = m
    const [c1, r1, c2, r2] = m.ends
    const [dx, dy] = pixelNm(e)
    const n = m.dist.length
    const steps = cp.steps.map((st, i) => {
      const f = st.x / lengthNm
      const [X, Y] = nativeToScanNm(e.geometry as ScanGeometry, c1 + f * (c2 - c1), r1 + f * (r2 - r1))
      return {
        id: i + 1,
        position_nm: pyRound(st.x, 3),
        [formatKey(fmt, 'height')]: roundTo(st.height, fmt.decimals),
        transition_nm: pyRound(st.width, 3),
        x_nm: pyRound(X, 4),
        y_nm: pyRound(Y, 4),
      }
    })
    const png = profilePlot(archive.displayMax, m, steps)
    const de = archive.addDerived(archive.currentTurn, png, {
      tool: 'line_profile',
      sources: [e.fid],
      description: `profile of ${ch} ${direction} from p1 to p2`,
      labelAttrs: [
        ['channel', ch],
        ['direction', direction],
        ['flatten', mode],
        ['plot', 'line profile'],
        ['x', 'distance from p1 [nm]'],
        ['y', `${ch} [${fmt.unit}]`],
      ],
    })
    const reply: Record<string, unknown> = { instrument_unchanged: true, frame: e.fid, channel: ch, direction, flatten: mode }
    if (mode === 'highpass') reply['highpass_nm'] = hp
    Object.assign(reply, {
      p1: pointReport(e, c1, r1),
      p2: pointReport(e, c2, r2),
      length_nm: pyRound(lengthNm, 4),
      direction_deg: pyRound(scanAngleDeg(e, c2 - c1, r2 - r1), 3),
      width_px: widthPx,
      width_nm: pyRound(wn * Math.sqrt(dx * dy), 4),
      n_samples: n,
      spacing_nm: pyRound(lengthNm / (n - 1), 5),
      decimals: fmt.decimals,
      distance_nm: [...m.dist].map((v) => pyRound(v, 4)),
      [formatKey(fmt, 'values')]: formatValues(fmt, m.valsSi),
      steps,
      segments: cp.segments.map((g) => segmentReport(fmt, g)),
      [formatKey(fmt, 'noise_per_sample')]: roundTo(cp.sigma, fmt.decimals),
      step_min_jump_sigma: STEP_MIN_JUMP_SIGMA,
      plot: { frame: de.fid },
    })
    const obs = archive.observation(de.fid)
    return { ok: true, reply, images: [{ png: obs.png, label: obs.label, name: `${de.fid}.png` }] }
  } catch (err) {
    return failure('line_profile', err)
  }
}
