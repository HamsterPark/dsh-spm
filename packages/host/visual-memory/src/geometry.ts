/**
 * Display scale and the display ↔ scan-frame transforms (VISUAL-HARNESS §4.3).
 *
 * ## The convention
 *
 * A frame of `nx × ny` pixels is shown at scale `k`:
 *
 * - `max(nx, ny) <= D`: integer nearest-neighbour upscaling,
 *   `k = max(1, D // max(nx, ny))` (never smoothed);
 * - larger frames: integer block-mean downsampling by `f = ceil(max(nx, ny) / D)`,
 *   `k = 1/f`, image size `ceil(nx/f) × ceil(ny/f)` (edge blocks may be partial).
 *
 * `k` is carried as the exact pair `(num, den)`; `k = num/den` is never stored
 * as a float that has to be re-rounded.
 *
 * Display coordinates `(x, y)` are continuous with the origin at the top-left
 * CORNER of the image, `x` to the right and `y` down. Row 0 is the frame's top
 * (high-v) edge — the orientation `sxmOrientedFrames` produces. The native
 * continuous coordinate is `(x/k, y/k)`; native pixel `i` covers `[i, i+1)` and
 * its centre is `i + 0.5`. Scan-frame nanometres:
 *
 *     u = -w/2 + (x/k)·w/nx ,   v = +h/2 - (y/k)·h/ny
 *     X = cx + cos(a)·u - sin(a)·v ,   Y = cy + sin(a)·u + cos(a)·v
 *
 * with `a` the scan angle. This equals the judge-side
 * `pixel_to_scan_nm(geom, x/k - 0.5, y/k - 0.5)` of the Python reference.
 *
 * ## Exactness
 *
 * The operations are written in the same order as the Python reference
 * (`col * (w / nx)`, `angle * (π / 180)`, left-to-right sums), so for the same
 * inputs both produce the same doubles. The inverse transform is exact up to the
 * last bits of the forward one (tests pin the round trip to 1e-9 nm).
 */

export const DISPLAY_MAX_DEFAULT = 768

/** Scan geometry of a frame: centre and size in nm, angle in degrees, pixels. */
export interface ScanGeometry {
  readonly cx_nm: number
  readonly cy_nm: number
  readonly w_nm: number
  readonly h_nm: number
  readonly angle_deg: number
  readonly nx: number
  readonly ny: number
}

/** `k = num / den`: `(s, 1)` for upscaling by `s`, `(1, f)` for block means of `f`. */
export interface ScalePair {
  readonly num: number
  readonly den: number
}

/** Invalid sizes or geometry. */
export class GeometryError extends RangeError {
  override readonly name = 'GeometryError'
}

function checkPositiveInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 1) throw new GeometryError(`${name} must be a positive integer, got ${v}`)
}

export function scalePair(nx: number, ny: number, displayMax = DISPLAY_MAX_DEFAULT): ScalePair {
  checkPositiveInt('nx', nx)
  checkPositiveInt('ny', ny)
  checkPositiveInt('display_max', displayMax)
  const big = Math.max(nx, ny)
  if (big <= displayMax) return { num: Math.max(1, Math.floor(displayMax / big)), den: 1 }
  return { num: 1, den: Math.ceil(big / displayMax) }
}

/** The pair as a float (`0.5` = block mean of 2). */
export function scaleValue(s: ScalePair): number {
  return s.num / s.den
}

/** Inverse of {@link scaleValue} for values that came from a pair. */
export function scaleFromValue(k: number): ScalePair {
  if (!(k > 0) || !Number.isFinite(k)) throw new GeometryError(`display scale must be positive, got ${k}`)
  return k >= 1 ? { num: Math.round(k), den: 1 } : { num: 1, den: Math.round(1 / k) }
}

/** `"3"` or `"1/2"`, as labels show the scale. */
export function scaleText(s: ScalePair): string {
  return s.den === 1 ? String(s.num) : `1/${s.den}`
}

/** `[W, H]` of the full display image. */
export function displaySize(nx: number, ny: number, s: ScalePair): [number, number] {
  if (s.den === 1) return [nx * s.num, ny * s.num]
  return [Math.ceil(nx / s.den), Math.ceil(ny / s.den)]
}

function radians(deg: number): number {
  // CPython's math.radians multiplies by the constant pi/180.
  return deg * (Math.PI / 180)
}

export function checkGeometry(g: ScanGeometry): void {
  checkPositiveInt('nx', g.nx)
  checkPositiveInt('ny', g.ny)
  for (const k of ['cx_nm', 'cy_nm', 'angle_deg'] as const) {
    if (!Number.isFinite(g[k])) throw new GeometryError(`${k} must be finite, got ${g[k]}`)
  }
  for (const k of ['w_nm', 'h_nm'] as const) {
    if (!(Number.isFinite(g[k]) && g[k] > 0)) throw new GeometryError(`${k} must be positive and finite, got ${g[k]}`)
  }
}

/** Continuous native coordinates (0 = left/top edge of the frame) → scan-frame nm. */
export function nativeToScanNm(g: ScanGeometry, col: number, row: number): [number, number] {
  const u = -g.w_nm / 2 + col * (g.w_nm / g.nx)
  const v = g.h_nm / 2 - row * (g.h_nm / g.ny)
  const a = radians(g.angle_deg)
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [g.cx_nm + c * u - s * v, g.cy_nm + s * u + c * v]
}

/** Inverse of {@link nativeToScanNm}. */
export function scanNmToNative(g: ScanGeometry, X: number, Y: number): [number, number] {
  const a = radians(g.angle_deg)
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = X - g.cx_nm
  const dy = Y - g.cy_nm
  const u = c * dx + s * dy
  const v = -s * dx + c * dy
  return [(u + g.w_nm / 2) * (g.nx / g.w_nm), (g.h_nm / 2 - v) * (g.ny / g.h_nm)]
}

/** Display coordinates of a frame shown at scale `s` → scan-frame nm. */
export function displayToScanNm(g: ScanGeometry, s: ScalePair, x: number, y: number): [number, number] {
  return nativeToScanNm(g, (x * s.den) / s.num, (y * s.den) / s.num)
}

/** Inverse of {@link displayToScanNm}. */
export function scanNmToDisplay(g: ScanGeometry, s: ScalePair, X: number, Y: number): [number, number] {
  const [col, row] = scanNmToNative(g, X, Y)
  return [(col * s.num) / s.den, (row * s.num) / s.den]
}
