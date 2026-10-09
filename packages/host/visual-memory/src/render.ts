/**
 * Pixels: contrast, grey levels, never-acquired colour, nearest-neighbour
 * scaling, views of exact regions, and the `<visual …/>` labels.
 *
 * Rules (VISUAL-HARNESS §4.3, Python `frames.py`):
 *
 * - contrast: black and white at the `clip_pct` / `100 - clip_pct` percentiles
 *   (numpy `linear` method) of the finite values of the shown region; a flat
 *   region falls back to its min/max, a constant one is mid grey;
 * - grey levels `rint(255 · clip((z - lo) / (hi - lo), 0, 1))`;
 * - pixels never acquired are one flat dark blue ({@link NAN_RGB}) so they are
 *   never read as "lowest";
 * - scaling is integer only: whole-pixel nearest-neighbour enlargement, or a
 *   NaN-aware block mean for frames larger than the display;
 * - nothing is ever drawn inside an image; frame ids, scales, coordinates and
 *   values travel in the label text block placed before the image.
 */
import { checkGeometry, nativeToScanNm, type ScalePair, type ScanGeometry } from './geometry.js'
import { blockMean } from './flatten.js'
import { encodePngRgb } from './png.js'
import { pyFixed, pyRound, rint } from './pyfmt.js'

export const CLIP_PCT_DEFAULT = 0.5
/** Never-acquired pixels: one flat dark blue. */
export const NAN_RGB: readonly [number, number, number] = [24, 32, 104]
export const NAN_NAME = 'dark blue'

/** A region outside the frame, or otherwise invalid. */
export class RegionError extends RangeError {
  override readonly name = 'RegionError'
}

/**
 * numpy `percentile(sorted, q)` with the default `linear` method on an
 * ascending, finite, non-empty array — including numpy's `_lerp`, which
 * computes `b - (b - a)·(1 - t)` for `t >= 0.5`.
 */
export function percentileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  const vi = (n - 1) * (q / 100)
  const lo = Math.floor(vi)
  const hi = Math.min(lo + 1, n - 1)
  const t = vi - lo
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  const diff = b - a
  return t >= 0.5 ? b - diff * (1 - t) : a + diff * t
}

/** `[lo, hi]`: the `clipPct` / `100 - clipPct` percentiles of the finite values. */
export function colourLimits(values: ArrayLike<number>, clipPct = CLIP_PCT_DEFAULT): [number, number] {
  const fin: number[] = []
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] as number
    if (Number.isFinite(v)) fin.push(v)
  }
  if (fin.length === 0) return [0, 1]
  const sorted = Float64Array.from(fin).sort()
  const c = Math.min(Math.max(clipPct, 0), 49)
  let lo = percentileSorted(sorted, c)
  let hi = percentileSorted(sorted, 100 - c)
  if (!(hi > lo)) {
    lo = sorted[0] as number
    hi = sorted[sorted.length - 1] as number
  }
  return [lo, hi]
}

/** RGB pixels (`R = G = B` grey, {@link NAN_RGB} where not finite). */
export function greyRgb(z: ArrayLike<number>, lo: number, hi: number): Uint8Array {
  const out = new Uint8Array(z.length * 3)
  const scale = hi - lo
  for (let i = 0; i < z.length; i += 1) {
    const v = z[i] as number
    if (!Number.isFinite(v)) {
      out[i * 3] = NAN_RGB[0]
      out[i * 3 + 1] = NAN_RGB[1]
      out[i * 3 + 2] = NAN_RGB[2]
      continue
    }
    const norm = hi > lo ? (v - lo) / scale : 0.5
    const g = rint(Math.min(1, Math.max(0, norm)) * 255)
    out[i * 3] = g
    out[i * 3 + 1] = g
    out[i * 3 + 2] = g
  }
  return out
}

/** Integer nearest-neighbour enlargement of an RGB image (each pixel → `s × s`). */
export function upscaleRgb(rgb: Uint8Array, w: number, h: number, s: number): Uint8Array {
  if (s <= 1) return rgb
  const W = w * s
  const out = new Uint8Array(W * h * s * 3)
  for (let y = 0; y < h; y += 1) {
    const row = new Uint8Array(W * 3)
    for (let x = 0; x < w; x += 1) {
      const r = rgb[(y * w + x) * 3] as number
      const g = rgb[(y * w + x) * 3 + 1] as number
      const b = rgb[(y * w + x) * 3 + 2] as number
      for (let k = 0; k < s; k += 1) {
        const o = (x * s + k) * 3
        row[o] = r
        row[o + 1] = g
        row[o + 2] = b
      }
    }
    for (let k = 0; k < s; k += 1) out.set(row, (y * s + k) * W * 3)
  }
  return out
}

/** `{x, y, width, height}` in display pixels of a frame's full image. */
export interface Region {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Where a rendered image sits in its frame. */
export interface View {
  /** `[x, y, w, h]` in display px of the frame's full image (whole scan pixels). */
  readonly region_px: readonly [number, number, number, number]
  /** `[i0, j0, i1, j1]` native pixels, half-open. */
  readonly native: readonly [number, number, number, number]
  /** `[W, H]` of the rendered image. */
  readonly image_size: readonly [number, number]
  /** Image px per native px (>= 1) … */
  readonly up: number
  /** … or native px per image px (block mean). */
  readonly down: number
  readonly scale: ScalePair
  /** Rendered image px per display px of the full frame image. */
  readonly magnification: number
}

/**
 * Native box `[i0, j0, i1, j1]` covering a display-px region, widened outward to
 * whole native pixels. Throws {@link RegionError} when the region leaves the frame.
 */
export function regionToNative(
  region: Region | null,
  nx: number,
  ny: number,
  s: ScalePair,
): [number, number, number, number] {
  const W = s.den === 1 ? nx * s.num : Math.ceil(nx / s.den)
  const H = s.den === 1 ? ny * s.num : Math.ceil(ny / s.den)
  if (region === null) return [0, 0, nx, ny]
  const { x, y, width: w, height: h } = region
  if (![x, y, w, h].every((v) => Number.isInteger(v))) throw new RegionError('region x, y, width and height must be integers')
  if (w < 1 || h < 1) throw new RegionError('region width and height must be at least 1')
  if (x < 0 || y < 0 || x + w > W || y + h > H) {
    throw new RegionError(
      `region x=${x}, y=${y}, width=${w}, height=${h} leaves the frame's ${W}x${H} display image ` +
        `(x + width <= ${W}, y + height <= ${H})`,
    )
  }
  if (s.den === 1) {
    return [Math.floor(x / s.num), Math.floor(y / s.num), Math.ceil((x + w) / s.num), Math.ceil((y + h) / s.num)]
  }
  return [x * s.den, y * s.den, Math.min(nx, (x + w) * s.den), Math.min(ny, (y + h) * s.den)]
}

/**
 * How a region (or the whole frame) is shown: the largest whole number of image
 * pixels per native pixel that fits `displayMax`, or a block mean when the
 * region has more native pixels than that.
 */
export function planView(nx: number, ny: number, s: ScalePair, region: Region | null, displayMax: number): View {
  const [i0, j0, i1, j1] = regionToNative(region, nx, ny, s)
  const cw = i1 - i0
  const ch = j1 - j0
  const big = Math.max(cw, ch)
  let up: number
  let down: number
  let size: [number, number]
  if (big <= displayMax) {
    up = Math.max(1, Math.floor(displayMax / big))
    down = 1
    size = [cw * up, ch * up]
  } else {
    up = 1
    down = Math.ceil(big / displayMax)
    size = [Math.ceil(cw / down), Math.ceil(ch / down)]
  }
  let reg: [number, number, number, number]
  if (s.den === 1) {
    reg = [i0 * s.num, j0 * s.num, cw * s.num, ch * s.num]
  } else {
    const rx = Math.floor(i0 / s.den)
    const ry = Math.floor(j0 / s.den)
    reg = [rx, ry, Math.ceil(i1 / s.den) - rx, Math.ceil(j1 / s.den) - ry]
  }
  return {
    region_px: reg,
    native: [i0, j0, i1, j1],
    image_size: size,
    up,
    down,
    scale: s,
    magnification: (up / down) * (s.den / s.num),
  }
}

/** The native crop of a row-major `nx`-wide array. */
export function crop(z: ArrayLike<number>, nx: number, box: readonly [number, number, number, number]): Float64Array {
  const [i0, j0, i1, j1] = box
  const w = i1 - i0
  const out = new Float64Array(w * (j1 - j0))
  for (let r = j0; r < j1; r += 1) {
    for (let c = i0; c < i1; c += 1) out[(r - j0) * w + (c - i0)] = z[r * nx + c] as number
  }
  return out
}

export interface RenderedValues {
  readonly png: Uint8Array
  readonly lo: number
  readonly hi: number
}

/**
 * PNG of the view of `zf` (already flattened, row-major, `nx` wide). Colour
 * limits are the percentiles of the native crop, unless given.
 */
export function renderValues(
  zf: ArrayLike<number>,
  nx: number,
  view: View,
  clipPct = CLIP_PCT_DEFAULT,
  limits?: readonly [number, number],
): RenderedValues {
  const [i0, j0, i1, j1] = view.native
  let w = i1 - i0
  let h = j1 - j0
  let values: Float64Array = crop(zf, nx, view.native)
  const [lo, hi] = limits ?? colourLimits(values, clipPct)
  if (view.down > 1) {
    const g = blockMean(values, w, h, view.down)
    values = g.data
    w = g.nx
    h = g.ny
  }
  const rgb = upscaleRgb(greyRgb(values, lo, hi), w, h, view.up)
  return { png: encodePngRgb(w * view.up, h * view.up, rgb), lo, hi }
}

/** Scan-frame nm of the four corners of a view's region, rounded to 1e-4 nm. */
export function viewCornersNm(g: ScanGeometry, view: View): Record<'top_left' | 'top_right' | 'bottom_left' | 'bottom_right', [number, number]> {
  checkGeometry(g)
  const [i0, j0, i1, j1] = view.native
  const at = (c: number, r: number): [number, number] => {
    const [X, Y] = nativeToScanNm(g, c, r)
    return [pyRound(X, 4), pyRound(Y, 4)]
  }
  return { top_left: at(i0, j0), top_right: at(i1, j0), bottom_left: at(i0, j1), bottom_right: at(i1, j1) }
}

/** One label attribute; `null`/`undefined` values are omitted. */
export type LabelAttr = readonly [string, string | number | null | undefined]

function esc(v: string | number): string {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', ' ')
}

/** `<visual kind="current" frame="t0007.s0" …/>`, attributes in the given order. */
export function visualLabel(kind: string, attrs: readonly LabelAttr[]): string {
  const parts = [`kind="${esc(kind)}"`]
  for (const [k, v] of attrs) {
    if (v === null || v === undefined) continue
    parts.push(`${k}="${esc(v)}"`)
  }
  return `<visual ${parts.join(' ')}/>`
}

/** Python `fmt_num`: fixed decimals, `nan` for non-finite values, no sign on a rounded zero. */
export function fmtNum(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return 'nan'
  const out = pyFixed(v, digits)
  return out.startsWith('-') && Number(out) === 0 ? out.slice(1) : out
}
