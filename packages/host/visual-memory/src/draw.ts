/**
 * Drawing for derived images: numbered marks on measurement images and line
 * plots of profiles and spectra, on a small RGB canvas with its own bitmap
 * font (no dependencies).
 *
 * The Python reference draws these with Pillow (`measure._draw_marks`) and
 * matplotlib (`measure._plot_png`, `frames.render_spectrum`). What an image
 * shows follows it: where rings and numbers go, the mark colour, which values
 * are plotted against what, one panel per spectrum column on a shared x axis,
 * axis labels with units. The pixels are this module's own
 * (spec/deviations.md D-VMEM-6): a hand-made bitmap font instead of DejaVu
 * Sans, no anti-aliasing, and a plot layout of its own.
 *
 * Coordinates are pixel indices, as in Pillow: (x, y) is the centre of pixel
 * (x, y), x to the right and y down; fractional coordinates go to the nearest
 * pixel. Whatever falls outside the canvas is clipped. The same input always
 * gives the same pixels, hence the same PNG bytes.
 *
 * ## Font
 *
 * Every printable ASCII character, plus µ Δ ° Å ² ³ ± × · (units such as µV,
 * Δf), is a glyph of at most 5 × 9 font pixels in a cell 6 wide: capitals and
 * digits are 5 × 7, the two rows below the baseline hold descenders. Any other
 * character shows as an empty box. Text is drawn at an integer scale (each
 * font pixel a `scale × scale` block; default 2, 14 px capitals) inside a box
 * with one font pixel of padding on every side for the optional outline: the
 * font pixels around the glyphs, painted first in another colour, which keeps
 * text legible on any image. The glyphs were designed for this module, row by
 * row, in the sheet below.
 */
import { encodePngRgb } from './png.js'
import { pyRoundInt } from './pyfmt.js'
import { niceStep } from './render.js'

/** An 8-bit sRGB colour `[r, g, b]`. */
export type Rgb = readonly [number, number, number]

/** Rings and numbers on measurement images (Python `MARK_RGB`). */
export const MARK_RGB: Rgb = [255, 214, 0]

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

// ── font ────────────────────────────────────────────────────────────────────

const GLYPH_W = 5
/** Rows of a glyph: 7 down to the baseline, 2 below it. */
const GLYPH_H = 9
const CAP_ROWS = 7
/** Font pixels from one character to the next. */
const ADVANCE = 6
/** Font pixels around the glyphs of a text box, where the outline goes. */
const PAD = 1
const TEXT_SCALE_DEFAULT = 2

/**
 * The glyphs, one band of characters at a time: a line per row of font pixels,
 * five columns per glyph (`#` ink, `.` blank), glyphs in the band's order.
 * The last band is µ Δ ° Å ² ³ ± × · and the box shown for any other character.
 */
const SHEET: readonly (readonly [string, string])[] = [
  [
    '!"#$%&\'()*+,',
    `
    ..#.. .#.#. .#.#. ..#.. ##... .##.. ..#.. ...#. .#... ..... ..... .....
    ..#.. .#.#. .#.#. .#### ##..# #..#. ..#.. ..#.. ..#.. ..#.. ..#.. .....
    ..#.. ..... ##### #.#.. ...#. #.#.. ..... .#... ...#. #.#.# ..#.. .....
    ..#.. ..... .#.#. .###. ..#.. .#... ..... .#... ...#. .###. ##### .....
    ..#.. ..... ##### ..#.# .#... #.#.# ..... .#... ...#. #.#.# ..#.. .....
    ..... ..... .#.#. ####. #..## #..#. ..... ..#.. ..#.. ..#.. ..#.. ..##.
    ..#.. ..... .#.#. ..#.. ...## .##.# ..... ...#. .#... ..... ..... ..##.
    ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ...#.
    ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..#..
    `,
  ],
  [
    '-./:;<=>?@[\\',
    `
    ..... ..... ....# ..... ..... ...#. ..... .#... .###. .###. .###. #....
    ..... ..... ...#. ..##. ..##. ..#.. ..... ..#.. #...# #...# .#... .#...
    ..... ..... ...#. ..##. ..##. .#... ##### ...#. ....# #.### .#... .#...
    ##### ..... ..#.. ..... ..... #.... ..... ....# ...#. #.#.# .#... ..#..
    ..... ..... .#... ..... ..... .#... ##### ...#. ..#.. #.### .#... ...#.
    ..... ..##. .#... ..##. ..##. ..#.. ..... ..#.. ..... #.... .#... ...#.
    ..... ..##. #.... ..##. ..##. ...#. ..... .#... ..#.. .###. .###. ....#
    ..... ..... ..... ..... ...#. ..... ..... ..... ..... ..... ..... .....
    ..... ..... ..... ..... ..#.. ..... ..... ..... ..... ..... ..... .....
    `,
  ],
  [
    ']^_`{|}~',
    `
    .###. ..#.. ..... .#... ...## ..#.. ##... .....
    ...#. .#.#. ..... ..#.. ..#.. ..#.. ..#.. .....
    ...#. #...# ..... ..... ..#.. ..#.. ..#.. .#...
    ...#. ..... ..... ..... .#... ..#.. ...#. #.#.#
    ...#. ..... ..... ..... ..#.. ..#.. ..#.. ...#.
    ...#. ..... ..... ..... ..#.. ..#.. ..#.. .....
    .###. ..... ..... ..... ...## ..#.. ##... .....
    ..... ..... ##### ..... ..... ..#.. ..... .....
    ..... ..... ..... ..... ..... ..#.. ..... .....
    `,
  ],
  [
    '0123456789',
    `
    .###. ..#.. .###. .###. ...#. ##### ..##. ##### .###. .###.
    #...# .##.. #...# #...# ..##. #.... .#... ....# #...# #...#
    #..## #.#.. ....# ....# .#.#. ####. #.... ...#. #...# #...#
    #.#.# ..#.. ...#. ..##. #..#. ....# ####. ..#.. .###. .####
    ##..# ..#.. ..#.. ....# ##### ....# #...# .#... #...# ....#
    #...# ..#.. .#... #...# ...#. #...# #...# .#... #...# ...#.
    .###. .###. ##### .###. ...#. .###. .###. .#... .###. .##..
    ..... ..... ..... ..... ..... ..... ..... ..... ..... .....
    ..... ..... ..... ..... ..... ..... ..... ..... ..... .....
    `,
  ],
  [
    'ABCDEFGHIJKLM',
    `
    .###. ####. .###. ####. ##### ##### .###. #...# .###. ..### #...# #.... #...#
    #...# #...# #...# #...# #.... #.... #...# #...# ..#.. ...#. #..#. #.... ##.##
    #...# #...# #.... #...# #.... #.... #.... #...# ..#.. ...#. #.#.. #.... #.#.#
    ##### ####. #.... #...# ####. ####. #.### ##### ..#.. ...#. ##... #.... #.#.#
    #...# #...# #.... #...# #.... #.... #...# #...# ..#.. ...#. #.#.. #.... #...#
    #...# #...# #...# #...# #.... #.... #...# #...# ..#.. #..#. #..#. #.... #...#
    #...# ####. .###. ####. ##### #.... .#### #...# .###. .##.. #...# ##### #...#
    ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... .....
    ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... .....
    `,
  ],
  [
    'NOPQRSTUVWXYZ',
    `
    #...# .###. ####. .###. ####. .###. ##### #...# #...# #...# #...# #...# #####
    #...# #...# #...# #...# #...# #...# ..#.. #...# #...# #...# #...# #...# ....#
    ##..# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# .#.#. .#.#. ...#.
    #.#.# #...# ####. #...# ####. .###. ..#.. #...# #...# #.#.# ..#.. ..#.. ..#..
    #..## #...# #.... #.#.# #.#.. ....# ..#.. #...# #...# #.#.# .#.#. ..#.. .#...
    #...# #...# #.... #..#. #..#. #...# ..#.. #...# .#.#. #.#.# #...# ..#.. #....
    #...# .###. #.... .##.# #...# .###. ..#.. .###. ..#.. .#.#. #...# ..#.. #####
    ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... .....
    ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... .....
    `,
  ],
  [
    'abcdefghijklm',
    `
    ..... #.... ..... ....# ..... ..##. ..... #.... ..#.. ...#. #.... .##.. .....
    ..... #.... ..... ....# ..... .#... ..... #.... ..... ..... #.... ..#.. .....
    .###. ####. .###. .#### .###. .#... .#### #.##. .##.. ..##. #..#. ..#.. ##.#.
    ....# #...# #...# #...# #...# ####. #...# ##..# ..#.. ...#. #.#.. ..#.. #.#.#
    .#### #...# #.... #...# ##### .#... #...# #...# ..#.. ...#. ##... ..#.. #.#.#
    #...# #...# #...# #...# #.... .#... #...# #...# ..#.. ...#. #.#.. ..#.. #.#.#
    .#### ####. .###. .#### .###. .#... .#### #...# .###. ...#. #..#. .###. #.#.#
    ..... ..... ..... ..... ..... ..... ....# ..... ..... #..#. ..... ..... .....
    ..... ..... ..... ..... ..... ..... .###. ..... ..... .##.. ..... ..... .....
    `,
  ],
  [
    'nopqrstuvwxyz',
    `
    ..... ..... ..... ..... ..... ..... .#... ..... ..... ..... ..... ..... .....
    ..... ..... ..... ..... ..... ..... .#... ..... ..... ..... ..... ..... .....
    #.##. .###. ####. .#### #.##. .#### ####. #...# #...# #...# #...# #...# #####
    ##..# #...# #...# #...# ##..# #.... .#... #...# #...# #...# .#.#. #...# ...#.
    #...# #...# #...# #...# #.... .###. .#... #...# #...# #.#.# ..#.. #...# ..#..
    #...# #...# #...# #...# #.... ....# .#..# #..## .#.#. #.#.# .#.#. #...# .#...
    #...# .###. ####. .#### #.... ####. ..##. .##.# ..#.. .#.#. #...# .#### #####
    ..... ..... #.... ....# ..... ..... ..... ..... ..... ..... ..... ....# .....
    ..... ..... #.... ....# ..... ..... ..... ..... ..... ..... ..... .###. .....
    `,
  ],
  [
    '\u00b5\u0394\u00b0\u00c5\u00b2\u00b3\u00b1\u00d7\u00b7\ufffd',
    `
    ..... ..#.. .##.. ..#.. .##.. ###.. ..#.. ..... ..... #####
    ..... ..#.. #..#. .#.#. #..#. ...#. ..#.. ..... ..... #...#
    #...# .#.#. #..#. ..#.. ..#.. .##.. ##### .#.#. ..... #...#
    #...# .#.#. .##.. .###. .#... ...#. ..#.. ..#.. ..##. #...#
    #...# #...# ..... #...# ####. ###.. ..#.. .#.#. ..##. #...#
    #..## #...# ..... ##### ..... ..... ..... ..... ..... #...#
    ###.# ##### ..... #...# ..... ..... ##### ..... ..... #####
    #.... ..... ..... ..... ..... ..... ..... ..... ..... .....
    #.... ..... ..... ..... ..... ..... ..... ..... ..... .....
    `,
  ],
]

/** Characters drawn with another character's glyph. */
const ALIASES: readonly (readonly [string, string])[] = [
  ['\u03bc', '\u00b5'], // Greek mu → micro sign
  ['\u2212', '-'], // minus sign
  ['\u2013', '-'], // en dash
  ['\u00a0', ' '], // no-break space
]

/** Each glyph's rows as 5-bit masks, bit 4 = the left column. */
const GLYPHS: ReadonlyMap<string, Uint8Array> = (() => {
  const glyphs = new Map<string, Uint8Array>([[' ', new Uint8Array(GLYPH_H)]])
  for (const [band, sheet] of SHEET) {
    const chars = Array.from(band)
    const lines = sheet.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    const row = new RegExp(`^[.#]{5}( [.#]{5}){${chars.length - 1}}$`)
    if (lines.length !== GLYPH_H || !lines.every((l) => row.test(l))) throw new Error(`font sheet: malformed band ${band}`)
    chars.forEach((ch, i) => {
      const rows = new Uint8Array(GLYPH_H)
      lines.forEach((line, r) => {
        for (let c = 0; c < GLYPH_W; c += 1) if (line[i * (GLYPH_W + 1) + c] === '#') rows[r] = (rows[r] as number) | (1 << (GLYPH_W - 1 - c))
      })
      glyphs.set(ch, rows)
    })
  }
  for (const [alias, ch] of ALIASES) glyphs.set(alias, glyphs.get(ch) as Uint8Array)
  return glyphs
})()

const PLACEHOLDER = GLYPHS.get('\ufffd') as Uint8Array

/** The font pixels of `s` in its text box: (6n + 1) × 11 for n characters, 0 × 11 when empty. */
function textMask(s: string): { mask: Uint8Array; w: number; h: number } {
  const chars = Array.from(s)
  const w = chars.length === 0 ? 0 : ADVANCE * chars.length - 1 + 2 * PAD
  const h = GLYPH_H + 2 * PAD
  const mask = new Uint8Array(w * h)
  chars.forEach((ch, k) => {
    const rows = GLYPHS.get(ch) ?? PLACEHOLDER
    for (let r = 0; r < GLYPH_H; r += 1) {
      for (let c = 0; c < GLYPH_W; c += 1) {
        if (((rows[r] as number) >> (GLYPH_W - 1 - c)) & 1) mask[(PAD + r) * w + PAD + ADVANCE * k + c] = 1
      }
    }
  })
  return { mask, w, h }
}

function measure(s: string, scale: number): { width: number; height: number } {
  const n = Array.from(s).length
  return { width: (n === 0 ? 0 : ADVANCE * n - 1 + 2 * PAD) * scale, height: (GLYPH_H + 2 * PAD) * scale }
}

/** Whether a font pixel next to (fx, fy), diagonals included, is ink. */
function nearInk(mask: Uint8Array, w: number, h: number, fx: number, fy: number): boolean {
  for (let j = Math.max(0, fy - 1); j <= Math.min(h - 1, fy + 1); j += 1) {
    for (let i = Math.max(0, fx - 1); i <= Math.min(w - 1, fx + 1); i += 1) if (mask[j * w + i] === 1) return true
  }
  return false
}

// ── canvas ──────────────────────────────────────────────────────────────────

function positiveInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer, got ${v}`)
  return v
}

/** Channels rounded and clamped to 0..255 (non-finite → 0). */
function rgbOf(c: Rgb): Rgb {
  const byte = (v: number): number => (Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : 0)
  return [byte(c[0]), byte(c[1]), byte(c[2])]
}

function put(cv: Canvas, x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return
  const o = (y * cv.width + x) * 3
  cv.rgb[o] = c[0]
  cv.rgb[o + 1] = c[1]
  cv.rgb[o + 2] = c[2]
}

/**
 * Fill the integer box [x, x + w) × [y, y + h), clipped. A grey box is filled
 * natively; otherwise the first row is written pixel by pixel and copied to
 * the others, so a whole canvas costs one row of JavaScript.
 */
function fillBox(cv: Canvas, x: number, y: number, w: number, h: number, c: Rgb): void {
  const x0 = Math.max(0, x)
  const x1 = Math.min(cv.width, x + w)
  const y0 = Math.max(0, y)
  const y1 = Math.min(cv.height, y + h)
  if (x1 <= x0 || y1 <= y0) return
  const rgb = cv.rgb
  const stride = cv.width * 3
  if (c[0] === c[1] && c[1] === c[2]) {
    if (x0 === 0 && x1 === cv.width) rgb.fill(c[0], y0 * stride, y1 * stride)
    else for (let j = y0; j < y1; j += 1) rgb.fill(c[0], j * stride + x0 * 3, j * stride + x1 * 3)
    return
  }
  const start = y0 * stride + x0 * 3
  const end = y0 * stride + x1 * 3
  for (let o = start; o < end; o += 3) {
    rgb[o] = c[0]
    rgb[o + 1] = c[1]
    rgb[o + 2] = c[2]
  }
  for (let j = y0 + 1; j < y1; j += 1) rgb.copyWithin(j * stride + x0 * 3, start, end)
}

function lerp(a: number, b: number, t: number): number {
  return t === 0 ? a : t === 1 ? b : a + (b - a) * t
}

/**
 * Liang–Barsky: the parameters `[t0, t1]` of the part of the segment from
 * (x0, y0) to (x1, y1) inside `[xmin, xmax] × [ymin, ymax]`, or null.
 */
function clipSegment(x0: number, y0: number, x1: number, y1: number, xmin: number, ymin: number, xmax: number, ymax: number): [number, number] | null {
  let t0 = 0
  let t1 = 1
  const dx = x1 - x0
  const dy = y1 - y0
  const edges: readonly (readonly [number, number])[] = [[-dx, x0 - xmin], [dx, xmax - x0], [-dy, y0 - ymin], [dy, ymax - y0]]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
    } else if (p < 0) {
      t0 = Math.max(t0, q / p)
    } else {
      t1 = Math.min(t1, q / p)
    }
  }
  return t0 <= t1 ? [t0, t1] : null
}

/** An RGB image to draw on: 8-bit, row-major, 3 bytes per pixel. */
export class Canvas {
  readonly width: number
  readonly height: number
  readonly rgb: Uint8Array

  /** A `width × height` canvas filled with `background` (default white). */
  constructor(width: number, height: number, background: Rgb = WHITE) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`canvas size must be positive integers, got ${width}x${height}`)
    }
    this.width = width
    this.height = height
    this.rgb = new Uint8Array(width * height * 3)
    const bg = rgbOf(background)
    if (bg.some((v) => v !== 0)) fillBox(this, 0, 0, width, height, bg)
  }

  /** A canvas holding a copy of `rgb` (`width × height` pixels, 3 bytes each). */
  static fromRgb(width: number, height: number, rgb: Uint8Array): Canvas {
    const canvas = new Canvas(width, height, BLACK)
    if (rgb.length !== canvas.rgb.length) {
      throw new RangeError(`expected ${canvas.rgb.length} RGB bytes for ${width}x${height}, got ${rgb.length}`)
    }
    canvas.rgb.set(rgb)
    return canvas
  }

  /** One pixel; nothing happens outside the canvas. */
  pixel(x: number, y: number, c: Rgb): void {
    if (Number.isFinite(x) && Number.isFinite(y)) put(this, Math.round(x), Math.round(y), rgbOf(c))
  }

  /**
   * A straight line between two pixel centres (Bresenham, ends included). A
   * thicker line is `thickness` pixels across its minor axis, from
   * `⌊(thickness − 1) / 2⌋` before the 1-px line: rows y − 0 and y + 1 of a
   * 2-px horizontal line, for example.
   */
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, thickness = 1): void {
    const t = positiveInt('line thickness', thickness)
    if (![x0, y0, x1, y1].every(Number.isFinite)) return
    const m = t + 1 // clip with a margin, so no thick line shows its cut
    const k = clipSegment(x0, y0, x1, y1, -m, -m, this.width - 1 + m, this.height - 1 + m)
    if (k === null) return
    let x = Math.round(lerp(x0, x1, k[0]))
    let y = Math.round(lerp(y0, y1, k[0]))
    const xe = Math.round(lerp(x0, x1, k[1]))
    const ye = Math.round(lerp(y0, y1, k[1]))
    const dx = Math.abs(xe - x)
    const dy = -Math.abs(ye - y)
    const sx = x < xe ? 1 : -1
    const sy = y < ye ? 1 : -1
    const xMajor = dx >= -dy
    const first = -Math.floor((t - 1) / 2)
    const col = rgbOf(c)
    let err = dx + dy
    for (;;) {
      for (let s = first; s < first + t; s += 1) put(this, xMajor ? x : x + s, xMajor ? y + s : y, col)
      if (x === xe && y === ye) return
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x += sx
      }
      if (e2 <= dx) {
        err += dx
        y += sy
      }
    }
  }

  /**
   * A circle of radius `r` around (cx, cy): the pixels whose centres lie at a
   * distance in `[r − thickness/2, r + thickness/2)` from it.
   */
  ring(cx: number, cy: number, r: number, c: Rgb, thickness = 1): void {
    const t = positiveInt('ring thickness', thickness)
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(Number.isFinite(r) && r >= 0)) return
    const outer = r + t / 2
    const inner = Math.max(0, r - t / 2)
    const col = rgbOf(c)
    const i1 = Math.min(this.width - 1, Math.floor(cx + outer))
    const j1 = Math.min(this.height - 1, Math.floor(cy + outer))
    for (let j = Math.max(0, Math.ceil(cy - outer)); j <= j1; j += 1) {
      for (let i = Math.max(0, Math.ceil(cx - outer)); i <= i1; i += 1) {
        const d2 = (i - cx) ** 2 + (j - cy) ** 2
        if (d2 >= inner * inner && d2 < outer * outer) put(this, i, j, col)
      }
    }
  }

  /** The `w × h` pixels from (x, y): their 1-px border, or all of them when `filled`. */
  rect(x: number, y: number, w: number, h: number, c: Rgb, filled = false): void {
    if (![x, y, w, h].every(Number.isFinite)) return
    const x0 = Math.round(x)
    const y0 = Math.round(y)
    const rw = Math.round(w)
    const rh = Math.round(h)
    if (rw < 1 || rh < 1) return
    const col = rgbOf(c)
    if (filled) {
      fillBox(this, x0, y0, rw, rh, col)
      return
    }
    fillBox(this, x0, y0, rw, 1, col)
    fillBox(this, x0, y0 + rh - 1, rw, 1, col)
    fillBox(this, x0, y0, 1, rh, col)
    fillBox(this, x0 + rw - 1, y0, 1, rh, col)
  }

  /**
   * `s` in the box {@link textSize} gives, its top-left corner at (x, y); the
   * baseline is `8 · scale` px below it. With `outline`, the font pixels
   * around the glyphs (diagonals included) are painted in that colour first.
   */
  text(x: number, y: number, s: string, c: Rgb, opts: { scale?: number; outline?: Rgb } = {}): void {
    const scale = positiveInt('text scale', opts.scale ?? TEXT_SCALE_DEFAULT)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const { mask, w, h } = textMask(s)
    const x0 = Math.round(x)
    const y0 = Math.round(y)
    const paint = (col: Rgb, at: (fx: number, fy: number) => boolean): void => {
      for (let fy = 0; fy < h; fy += 1) {
        for (let fx = 0; fx < w; fx += 1) if (at(fx, fy)) fillBox(this, x0 + fx * scale, y0 + fy * scale, scale, scale, col)
      }
    }
    if (opts.outline !== undefined) paint(rgbOf(opts.outline), (fx, fy) => mask[fy * w + fx] === 0 && nearInk(mask, w, h, fx, fy))
    paint(rgbOf(c), (fx, fy) => mask[fy * w + fx] === 1)
  }

  /**
   * The box {@link text} draws in: `(6n + 1) · scale × 11 · scale` px for n
   * characters (width 0 when `s` is empty); default scale 2.
   */
  textSize(s: string, scale = TEXT_SCALE_DEFAULT): { width: number; height: number } {
    return measure(s, positiveInt('text scale', scale))
  }

  /** The canvas as a PNG ({@link encodePngRgb}: 8-bit RGB, no ancillary chunks). */
  png(): Uint8Array {
    return encodePngRgb(this.width, this.height, this.rgb)
  }
}

// ── marks ───────────────────────────────────────────────────────────────────

/** DejaVu Sans, the reference's font: capital height per em. */
const REF_CAP_EM = 0.729

/** A numbered mark at image coordinates: `(x, y)` centre, radius `r` (image pixels), label `text`. */
export interface Mark {
  readonly x: number
  readonly y: number
  readonly r: number
  readonly text: string
}

/**
 * The reference's `_draw_marks`: a 2-px ring of radius `r` around each mark
 * (unless `ring` is false) and its text to the upper right, the outlined
 * text's lower-left corner at `(x + 0.72 r + 1, y − 0.72 r − 1)`, moved inside
 * the image where it would leave it. Rings and text are `colour` (default
 * {@link MARK_RGB}); the text is outlined in black like the reference's, or in
 * white when `colour` itself is dark (the reference's dark `diff` marks): a
 * black outline would fill the counters of dark digits. All rings are drawn
 * before any text, so no ring crosses a number. The text scale follows the
 * image like the reference's font size, `clamp(round(0.022 · max(W, H)), 13,
 * 22)` px: the smallest scale whose capitals are at least as tall as DejaVu
 * Sans's at that size (2 up to 886 px, 3 above). Marks at a non-finite
 * position are skipped.
 */
export function drawMarks(
  canvas: Canvas,
  marks: readonly Mark[],
  opts: { colour?: Rgb; ring?: boolean } = {},
): void {
  const colour = opts.colour ?? MARK_RGB
  const outline = 0.299 * colour[0] + 0.587 * colour[1] + 0.114 * colour[2] >= 128 ? BLACK : WHITE
  const { width: W, height: H } = canvas
  const size = Math.min(22, Math.max(13, pyRoundInt(0.022 * Math.max(W, H))))
  const scale = Math.ceil((REF_CAP_EM * size) / CAP_ROWS)
  if (opts.ring ?? true) for (const m of marks) canvas.ring(m.x, m.y, m.r, colour, 2)
  for (const m of marks) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue
    const r = Number.isFinite(m.r) && m.r > 0 ? m.r : 0
    const box = canvas.textSize(m.text, scale)
    // outlined capitals end one font pixel below the baseline: 9 font pixels below the box top
    const x = Math.round(m.x + 0.72 * r + 1)
    const y = Math.round(m.y - 0.72 * r - 1) - (PAD + CAP_ROWS + 1) * scale
    canvas.text(Math.max(0, Math.min(x, W - box.width)), Math.max(0, Math.min(y, H - box.height)), m.text, colour, { scale, outline })
  }
}

// ── line plots ──────────────────────────────────────────────────────────────

/** One curve, `y` against `x`; a non-finite x or y breaks the line. */
export interface PlotSeries {
  readonly x: ArrayLike<number>
  readonly y: ArrayLike<number>
  readonly colour?: Rgb
  readonly dashed?: boolean
}

/** One panel: its y label (with the unit), curves, marker lines and labelled points. */
export interface PlotPanel {
  readonly yLabel: string
  readonly series: readonly PlotSeries[]
  readonly vlines?: readonly { x: number; colour?: Rgb; text?: string }[]
  readonly points?: readonly { x: number; y: number; text?: string }[]
}

export interface LinePlotOptions {
  /** The image size in px, exactly: the panels, margins and axis labels share it. */
  readonly width: number
  readonly height: number
  /** Under the last panel, with the unit. */
  readonly xLabel: string
  readonly panels: readonly PlotPanel[]
  /** The x axis limits; default the extent of the finite samples of all series. */
  readonly xRange?: readonly [number, number]
}

/** Ticks on an axis: the step, the values (multiples of it) and their labels. */
export interface Ticks {
  readonly step: number
  readonly values: readonly number[]
  readonly labels: readonly string[]
}

/** Series colours in order; the first is the reference's single-curve blue. */
const SERIES_RGB: readonly Rgb[] = [
  [31, 78, 156],
  [255, 127, 14],
  [44, 160, 44],
  [148, 103, 189],
  [140, 86, 75],
  [227, 119, 194],
  [127, 127, 127],
  [23, 190, 207],
]
/** Marker lines and points: the reference's red for profile steps. */
const MARKER_RGB: Rgb = [214, 39, 40]
const GRID_LINE_RGB: Rgb = [222, 222, 222]
const AXIS_RGB: Rgb = [0, 0, 0]
const NOTE_RGB: Rgb = [110, 110, 110]

const PLOT_SCALE = 2 // all plot text: 12 px per character
const LINE_H = (GLYPH_H + 2 * PAD) * PLOT_SCALE // 22 px per line of text
const LEFT_PAD = 6
const RIGHT_PAD = 16
const TITLE_TOP = 4 // y label, from the top of its panel
const PLOT_TOP = 32 // plot area, from the top of its panel
const PANEL_GAP = 16 // from the bottom of a plot area to the next panel
const TICK_LEN = 5
/** Below the last panel: x tick labels and the x label. */
const X_BAND = -PANEL_GAP + 1 + TICK_LEN + 2 + LINE_H + 2 + LINE_H + 4
const MIN_PLOT_PX = 20
const X_TICK_PX = 70 // least spacing of x ticks before label widths are checked
const Y_TICK_PX = 36
const LABEL_GAP = 12 // least space between neighbouring tick labels
const LINE_PX = 2
const POINT_R = 4
const SERIES_DASH: readonly [number, number] = [8, 4]
const VLINE_DASH: readonly [number, number] = [6, 4]

/**
 * Tick values on `[lo, hi]`: the multiples of the smallest 1, 2 or 5 × 10^n
 * step giving at most `maxIntervals` intervals, made finer while fewer than
 * two fall inside. Labels share the step's decimals (`0.0 0.2 … 1.0`), or are
 * written with exponents beyond 6 decimals or from 10^7 (`2e-9`, `1.5e7`).
 */
export function niceTicks(lo: number, hi: number, maxIntervals: number): Ticks {
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) throw new RangeError(`ticks need finite lo < hi, got ${lo} and ${hi}`)
  let t = ticksForStep(lo, hi, niceStep((hi - lo) / Math.max(1, Math.floor(maxIntervals))))
  for (let i = 0; i < 64 && t.values.length < 2; i += 1) t = ticksForStep(lo, hi, niceStep(t.step / 2.5))
  return t
}

function ticksForStep(lo: number, hi: number, step: number): Ticks {
  const values: number[] = []
  for (let k = Math.ceil(lo / step - 1e-9); k <= Math.floor(hi / step + 1e-9); k += 1) values.push(k * step + 0) // + 0: no -0
  return { step, values, labels: tickLabels(values, step) }
}

function tickLabels(values: readonly number[], step: number): string[] {
  let decimals = 0
  for (let v = step; decimals < 12 && Math.abs(v - Math.round(v)) > 1e-6 * v; v *= 10) decimals += 1
  const big = values.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  if (decimals <= 6 && big < 1e7) return values.map((v) => v.toFixed(decimals))
  const e = Math.floor(Math.log10(step) + 1e-9)
  return values.map((v) =>
    v === 0 ? '0' : v.toExponential(Math.max(0, Math.floor(Math.log10(Math.abs(v)) + 1e-9) - e)).replace('e+', 'e'),
  )
}

/**
 * {@link niceTicks} for an axis `lengthPx` long: about one tick per
 * `spacingPx`, then coarser while neighbouring labels (`extent` px along the
 * axis) would come closer than {@link LABEL_GAP}, keeping at least two ticks.
 */
function axisTicks(lo: number, hi: number, lengthPx: number, spacingPx: number, extent: (label: string) => number): Ticks {
  let t = niceTicks(lo, hi, Math.floor(lengthPx / spacingPx))
  for (;;) {
    const spacing = (t.step / (hi - lo)) * (lengthPx - 1)
    if (Math.max(...t.labels.map(extent)) + LABEL_GAP <= spacing) return t
    const coarser = ticksForStep(lo, hi, niceStep(t.step * (1 + 1e-6)))
    if (coarser.values.length < 2) return t
    t = coarser
  }
}

/** `[lo, hi]`, or ±5 % around a single value (±0.5 around 0) when the span is nil. */
function widen(lo: number, hi: number): [number, number] {
  if (hi - lo > 1e-12 * Math.max(Math.abs(lo), Math.abs(hi))) return [lo, hi]
  const mid = (lo + hi) / 2
  const d = mid === 0 ? 0.5 : 0.05 * Math.abs(mid)
  return [mid - d, mid + d]
}

function eachPoint(s: PlotSeries, see: (x: number, y: number) => void): void {
  const n = Math.min(s.x.length, s.y.length)
  for (let i = 0; i < n; i += 1) {
    const x = s.x[i] as number
    const y = s.y[i] as number
    if (Number.isFinite(x) && Number.isFinite(y)) see(x, y)
  }
}

function xLimits(opts: LinePlotOptions): [number, number] {
  if (opts.xRange !== undefined) {
    const [a, b] = opts.xRange
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError(`xRange must be two finite numbers, got ${a} and ${b}`)
    return widen(Math.min(a, b), Math.max(a, b))
  }
  let lo = Infinity
  let hi = -Infinity
  for (const p of opts.panels) {
    for (const s of p.series) {
      eachPoint(s, (x) => {
        lo = Math.min(lo, x)
        hi = Math.max(hi, x)
      })
    }
  }
  return lo <= hi ? widen(lo, hi) : [0, 1]
}

/** A panel's y limits: its data and points within `[x0, x1]`, 5 % added on each side; `empty` when there are none. */
function yLimits(p: PlotPanel, x0: number, x1: number): { lo: number; hi: number; empty: boolean } {
  const tol = 1e-9 * (x1 - x0)
  let lo = Infinity
  let hi = -Infinity
  const see = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < x0 - tol || x > x1 + tol) return
    lo = Math.min(lo, y)
    hi = Math.max(hi, y)
  }
  for (const s of p.series) eachPoint(s, see)
  for (const q of p.points ?? []) see(q.x, q.y)
  if (!(lo <= hi)) return { lo: 0, hi: 1, empty: true }
  const [a, b] = widen(lo - 0.05 * (hi - lo), hi + 0.05 * (hi - lo))
  return { lo: a, hi: b, empty: false }
}

interface Dash {
  phase: number
}

/** A dashed line; `dash.phase` carries the pattern on from one segment of a polyline to the next. */
function dashedLine(
  cv: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: Rgb,
  pattern: readonly [number, number],
  dash: Dash,
): void {
  const [on, off] = pattern
  const period = on + off
  const len = Math.hypot(x1 - x0, y1 - y0)
  const start = dash.phase
  dash.phase = (start + len) % period
  const m = LINE_PX + 1
  const k = clipSegment(x0, y0, x1, y1, -m, -m, cv.width - 1 + m, cv.height - 1 + m)
  if (k === null || !(len > 0)) return
  const at = (s: number): [number, number] => [x0 + ((x1 - x0) * s) / len, y0 + ((y1 - y0) * s) / len]
  let s = k[0] * len
  let phase = (start + s) % period
  while (s < k[1] * len) {
    const step = Math.min(k[1] * len - s, (phase < on ? on : period) - phase)
    if (phase < on) cv.line(...at(s), ...at(s + step), c, LINE_PX)
    s += step
    phase = (phase + step) % period
  }
}

function drawSeries(area: Canvas, s: PlotSeries, sx: (x: number) => number, sy: (y: number) => number, c: Rgb): void {
  const n = Math.min(s.x.length, s.y.length)
  const dash: Dash | null = s.dashed === true ? { phase: 0 } : null
  let px = 0
  let py = 0
  let run = 0
  for (let i = 0; i <= n; i += 1) {
    const x = i < n ? (s.x[i] as number) : Number.NaN
    const y = i < n ? (s.y[i] as number) : Number.NaN
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const qx = sx(x)
      const qy = sy(y)
      if (run > 0 && dash !== null) dashedLine(area, px, py, qx, qy, c, SERIES_DASH, dash)
      else if (run > 0) area.line(px, py, qx, qy, c, LINE_PX)
      px = qx
      py = qy
      run += 1
      continue
    }
    if (run === 1) area.rect(Math.round(px) - 1, Math.round(py) - 1, 3, 3, c, true) // a sample between two breaks
    run = 0
    if (dash !== null) dash.phase = 0
  }
}

function disc(cv: Canvas, cx: number, cy: number, r: number, c: Rgb): void {
  for (let j = Math.ceil(cy - r); j <= Math.floor(cy + r); j += 1) {
    for (let i = Math.ceil(cx - r); i <= Math.floor(cx + r); i += 1) if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) put(cv, i, j, c)
  }
}

/** Copy `src` into `dst` with its top-left corner at (x, y), clipped. */
function blit(dst: Canvas, src: Canvas, x: number, y: number): void {
  const i0 = Math.max(0, -x)
  const i1 = Math.min(src.width, dst.width - x)
  for (let j = Math.max(0, -y); j < Math.min(src.height, dst.height - y) && i1 > i0; j += 1) {
    dst.rgb.set(src.rgb.subarray((j * src.width + i0) * 3, (j * src.width + i1) * 3), ((y + j) * dst.width + x + i0) * 3)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi))
}

/** `s` at the plot scale, at scale 1 when that is too wide for `maxWidth`, cut short with "..." when that is too. */
function fitText(s: string, maxWidth: number): { text: string; scale: number } {
  if (measure(s, PLOT_SCALE).width <= maxWidth) return { text: s, scale: PLOT_SCALE }
  const chars = Array.from(s)
  let text = s
  for (let n = chars.length; n > 0 && measure(text, 1).width > maxWidth; n -= 1) text = `${chars.slice(0, n - 1).join('')}...`
  return { text, scale: 1 }
}

/** `[x, y, width, height]` of something drawn in a plot area. */
type Box = readonly [number, number, number, number]

const overlaps = (a: Box, b: Box): boolean => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

/**
 * Text in a plot area, outlined in white, at the first of `spots` (top-left
 * corners) where it lies inside the area clear of the boxes `taken`, else at
 * the first spot moved inside; its box is added to `taken`.
 */
function placeLabel(area: Canvas, taken: Box[], s: string, spots: readonly (readonly [number, number])[], c: Rgb): void {
  const { width: w, height: h } = measure(s, PLOT_SCALE)
  const free = ([x, y]: readonly [number, number]): boolean =>
    x >= 0 && y >= 0 && x + w <= area.width && y + h <= area.height && !taken.some((b) => overlaps(b, [x, y, w, h]))
  const [x, y] = spots.find(free) ?? (spots[0] as readonly [number, number])
  const box: Box = [clamp(x, 0, area.width - w), clamp(y, 0, area.height - h), w, h]
  taken.push(box)
  area.text(box[0], box[1], s, c, { scale: PLOT_SCALE, outline: WHITE })
}

/** Grid, marker lines, curves, points and labels of one panel, in plot-area pixels. */
function drawPanel(
  area: Canvas,
  panel: PlotPanel,
  xTicks: Ticks,
  yTicks: Ticks,
  sx: (x: number) => number,
  sy: (y: number) => number,
  empty: boolean,
): void {
  const { width: pw, height: ph } = area
  for (const v of xTicks.values) area.line(sx(v), 0, sx(v), ph - 1, GRID_LINE_RGB)
  for (const v of yTicks.values) area.line(0, sy(v), pw - 1, sy(v), GRID_LINE_RGB)
  // marker lines and points outside the x range are left out, labels included
  const shown = (x: number): boolean => Number.isFinite(x) && Math.round(sx(x)) >= 0 && Math.round(sx(x)) < pw
  const vlines = (panel.vlines ?? []).filter((v) => shown(v.x))
  for (const v of vlines) dashedLine(area, sx(v.x), 0, sx(v.x), ph - 1, v.colour ?? MARKER_RGB, VLINE_DASH, { phase: 0 })
  panel.series.forEach((s, i) => drawSeries(area, s, sx, sy, s.colour ?? (SERIES_RGB[i % SERIES_RGB.length] as Rgb)))
  const points = (panel.points ?? [])
    .filter((p) => shown(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: Math.round(sx(p.x)), y: Math.round(sy(p.y)), text: p.text }))
  for (const p of points) disc(area, p.x, p.y, POINT_R, MARKER_RGB)
  // labels keep off the dots and each other
  const taken: Box[] = points.map((p) => [p.x - POINT_R, p.y - POINT_R, 2 * POINT_R + 1, 2 * POINT_R + 1])
  // a marker line's label at the top, right of the line, lower when that is taken; left of it near the right edge
  for (const v of vlines) {
    if (!v.text) continue
    const vx = Math.round(sx(v.x))
    const w = measure(v.text, PLOT_SCALE).width
    const rows = Array.from({ length: Math.max(1, Math.floor((ph - 2) / LINE_H)) }, (_, i) => 2 + i * LINE_H)
    const spots = [...rows.map((y) => [vx + LINE_PX + 1, y] as const), ...rows.map((y) => [vx - 2 - w, y] as const)]
    placeLabel(area, taken, v.text, spots, v.colour ?? MARKER_RGB)
  }
  // a point's label to its upper right (outlined capitals ending a row above the dot), else upper left, lower right, lower left
  for (const p of points) {
    if (!p.text) continue
    const w = measure(p.text, PLOT_SCALE).width
    const [right, left] = [p.x + POINT_R + 2, p.x - POINT_R - 2 - w]
    const [above, below] = [p.y - POINT_R - 1 - (PAD + CAP_ROWS + 1) * PLOT_SCALE, p.y + POINT_R + 2]
    placeLabel(area, taken, p.text, [[right, above], [left, above], [right, below], [left, below]], MARKER_RGB)
  }
  if (empty) {
    const { width, height } = measure('no data', PLOT_SCALE)
    area.text(Math.round((pw - width) / 2), Math.round((ph - height) / 2), 'no data', NOTE_RGB, { scale: PLOT_SCALE })
  }
}

/**
 * The reference's matplotlib line plots, a profile (one panel) and a spectrum
 * (one panel per column), drawn here as an image of exactly `width × height`
 * px. Panels stack top to bottom, each with its y label above its plot area,
 * and share the height above the x axis band (the bottom 42 px, its tick
 * labels and label): each gets the same whole number of pixels, and the first
 * ones a pixel more when the height does not divide evenly.
 *
 * - limits: x spans `xRange`, or exactly the finite samples of all series
 *   (marker lines and points outside it are left out); each panel's y spans
 *   its data and points within that x range plus 5 % on each side, like
 *   matplotlib's margins (±5 %, or ±0.5 around 0, for a single value); a
 *   panel with no data in range says "no data";
 * - ticks: {@link niceTicks}, as many as fit without crowding their labels,
 *   with light grid lines; y tick labels on every panel, x ones at the bottom;
 * - series: 2-px lines in their colour or the next of a fixed palette (first
 *   the reference's blue), dashed on request; a non-finite x or y breaks the
 *   line, and a lone sample between breaks is a dot;
 * - marker lines: dashed, red by default, with an optional label at the top,
 *   right of the line (where the reference numbers the steps of a profile);
 * - points: red dots with an optional label to their upper right;
 * - a label that would cover another label or a dot, or leave the plot area,
 *   moves to the next free place: a line lower or the other side of its line,
 *   another corner of its dot.
 *
 * Text is 2× the font (14-px capitals; the reference's tick labels are
 * 12 pt at 100 dpi); a label too wide for the image drops to 1× and is then
 * cut short with "...".
 */
export function linePlot(opts: LinePlotOptions): { png: Uint8Array; width: number; height: number } {
  const W = positiveInt('plot width', opts.width)
  const H = positiveInt('plot height', opts.height)
  const { panels } = opts
  const n = panels.length
  if (n === 0) throw new RangeError('linePlot needs at least one panel')
  // the height above the x axis band, shared: `base` px each, one more for the first `extra` panels
  const base = Math.floor((H - X_BAND) / n)
  const extra = H - X_BAND - base * n
  if (base - PLOT_TOP - PANEL_GAP < MIN_PLOT_PX) {
    const least = X_BAND + n * (PLOT_TOP + PANEL_GAP + MIN_PLOT_PX)
    throw new RangeError(`plot height ${H} is too small for ${n} panel(s): it needs at least ${least} px`)
  }
  const panelTop = (k: number): number => k * base + Math.min(k, extra)
  const plotHeight = (k: number): number => base + (k < extra ? 1 : 0) - PLOT_TOP - PANEL_GAP
  const labelWidth = (s: string): number => measure(s, PLOT_SCALE).width

  const [x0, x1] = xLimits(opts)
  const yLims = panels.map((p) => yLimits(p, x0, x1))
  const yTicks = yLims.map(({ lo, hi }, k) => axisTicks(lo, hi, plotHeight(k), Y_TICK_PX, () => LINE_H))
  const left = LEFT_PAD + Math.max(...yTicks.flatMap((t) => t.labels.map(labelWidth))) + TICK_LEN + 3
  let pw = W - left - RIGHT_PAD
  if (pw < MIN_PLOT_PX) throw new RangeError(`plot width ${W} leaves less than ${MIN_PLOT_PX} px for the plot area`)
  let xTicks = axisTicks(x0, x1, pw, X_TICK_PX, labelWidth)
  // room on the right for half of the widest x tick label
  const right = Math.ceil(Math.max(...xTicks.labels.map(labelWidth)) / 2) + 2
  if (right > RIGHT_PAD && W - left - right >= MIN_PLOT_PX) {
    pw = W - left - right
    xTicks = axisTicks(x0, x1, pw, X_TICK_PX, labelWidth)
  }
  const sx = (x: number): number => ((x - x0) / (x1 - x0)) * (pw - 1)

  const canvas = new Canvas(W, H)
  panels.forEach((panel, k) => {
    const top = panelTop(k) + PLOT_TOP
    const ph = plotHeight(k)
    const { lo, hi, empty } = yLims[k] as { lo: number; hi: number; empty: boolean }
    const yt = yTicks[k] as Ticks
    const sy = (y: number): number => ((hi - y) / (hi - lo)) * (ph - 1)
    const area = new Canvas(pw, ph)
    drawPanel(area, panel, xTicks, yt, sx, sy, empty)
    blit(canvas, area, left, top)
    canvas.rect(left - 1, top - 1, pw + 2, ph + 2, AXIS_RGB)
    for (const v of xTicks.values) {
      const x = left + Math.round(sx(v))
      canvas.line(x, top + ph + 1, x, top + ph + TICK_LEN, AXIS_RGB)
    }
    yt.values.forEach((v, i) => {
      const y = top + Math.round(sy(v))
      canvas.line(left - 1 - TICK_LEN, y, left - 2, y, AXIS_RGB)
      const s = yt.labels[i] as string
      // capitals centred on the tick: 4.5 font pixels below the box top
      canvas.text(left - TICK_LEN - 3 - labelWidth(s), clamp(y - Math.floor(4.5 * PLOT_SCALE), 0, H - LINE_H), s, AXIS_RGB, {
        scale: PLOT_SCALE,
      })
    })
    const title = fitText(panel.yLabel, W - LEFT_PAD - 2)
    canvas.text(LEFT_PAD, panelTop(k) + TITLE_TOP, title.text, AXIS_RGB, { scale: title.scale })
  })

  const below = H - X_BAND - PANEL_GAP + 1 + TICK_LEN + 2
  xTicks.values.forEach((v, i) => {
    const s = xTicks.labels[i] as string
    const w = labelWidth(s)
    canvas.text(clamp(Math.round(left + sx(v) - w / 2), 0, W - w), below, s, AXIS_RGB, { scale: PLOT_SCALE })
  })
  const xl = fitText(opts.xLabel, W - 4)
  const xw = measure(xl.text, xl.scale).width
  canvas.text(clamp(Math.round(left + (pw - xw) / 2), 0, W - xw), below + LINE_H + 2, xl.text, AXIS_RGB, { scale: xl.scale })
  return { png: canvas.png(), width: W, height: H }
}
