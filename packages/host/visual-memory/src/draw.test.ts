import { describe, expect, it } from 'vitest'
import { Canvas, drawMarks, linePlot, MARK_RGB, niceTicks, type LinePlotOptions, type Rgb } from './draw.js'
import { decodePng, pngSize, toRgb } from './png.js'

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]
const RED: Rgb = [255, 0, 0]
const GREY: Rgb = [128, 128, 128]
const SERIES_1: Rgb = [31, 78, 156] // first palette colour
const SERIES_2: Rgb = [255, 127, 14]
const MARKER: Rgb = [214, 39, 40]
const NOTE: Rgb = [110, 110, 110]

interface Img {
  readonly width: number
  readonly height: number
  readonly rgb: Uint8Array
}

function rgbAt(img: Img, x: number, y: number): number[] {
  const o = (y * img.width + x) * 3
  return [img.rgb[o] as number, img.rgb[o + 1] as number, img.rgb[o + 2] as number]
}

/** `[x, y]` of every pixel of `img` that is `colour`. */
function where(img: Img, colour: Rgb): [number, number][] {
  const out: [number, number][] = []
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = rgbAt(img, x, y)
      if (r === colour[0] && g === colour[1] && b === colour[2]) out.push([x, y])
    }
  }
  return out
}

/** `[minX, minY, maxX, maxY]` of some pixels. */
function bounds(px: readonly [number, number][]): [number, number, number, number] {
  const xs = px.map((p) => p[0])
  const ys = px.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function decoded(png: Uint8Array): Img {
  const d = decodePng(png)
  return { width: d.width, height: d.height, rgb: toRgb(d) }
}

/** One character at scale 1, white on black, in its 7 × 11 box: rows of `#` / `.`. */
function glyph(ch: string): string[] {
  const c = new Canvas(7, 11, BLACK)
  c.text(0, 0, ch, WHITE, { scale: 1 })
  return Array.from({ length: 11 }, (_, y) => Array.from({ length: 7 }, (_, x) => (c.rgb[(y * 7 + x) * 3] === 255 ? '#' : '.')).join(''))
}

const inkRows = (g: string[]): number[] => g.flatMap((row, y) => (row.includes('#') ? [y] : []))

describe('font', () => {
  const placeholder = glyph('\ufffd').join('\n')

  it('has a distinct, non-empty glyph for every printable ASCII character, and a blank space', () => {
    expect(placeholder).toContain('#')
    const seen = new Map<string, string>()
    for (let code = 33; code <= 126; code += 1) {
      const ch = String.fromCharCode(code)
      const g = glyph(ch).join('\n')
      expect(g, ch).toContain('#')
      expect(g, ch).not.toBe(placeholder)
      expect(seen.get(g), `${ch} looks like ${seen.get(g)}`).toBeUndefined()
      seen.set(g, ch)
    }
    expect(glyph(' ').join('')).not.toContain('#')
  })

  it('keeps capitals and digits 5 × 7 above the baseline, descenders below it, padding clear', () => {
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') expect(inkRows(glyph(ch)), ch).toEqual([1, 2, 3, 4, 5, 6, 7])
    for (const ch of 'gjpqy') expect(Math.max(...inkRows(glyph(ch))), ch).toBe(9)
    for (let code = 33; code <= 126; code += 1) {
      const g = glyph(String.fromCharCode(code))
      expect(g[0]).toBe('.......')
      expect(g[10]).toBe('.......')
      expect(g.every((row) => row[0] === '.' && row[6] === '.')).toBe(true)
    }
  })

  it('draws µ Δ ° Å ² ³ ± × ·, aliases a few look-alikes, and shows a box for anything else', () => {
    for (const ch of '\u00b5\u0394\u00b0\u00c5\u00b2\u00b3\u00b1\u00d7\u00b7') {
      const g = glyph(ch).join('\n')
      expect(g, ch).toContain('#')
      expect(g, ch).not.toBe(placeholder)
    }
    expect(glyph('\u03bc')).toEqual(glyph('\u00b5')) // Greek mu draws as the micro sign
    expect(glyph('\u2212')).toEqual(glyph('-')) // minus sign
    expect(glyph('\u00a0')).toEqual(glyph(' '))
    expect(glyph('中').join('\n')).toBe(placeholder)
    expect(glyph('\u{1F600}').join('\n')).toBe(placeholder)
  })
})

describe('text', () => {
  it('reports its box: (6n + 1) × 11 font pixels times the scale, default 2', () => {
    const c = new Canvas(4, 4)
    expect(c.textSize('ab', 1)).toEqual({ width: 13, height: 11 })
    expect(c.textSize('12')).toEqual({ width: 26, height: 22 })
    expect(c.textSize('12', 3)).toEqual({ width: 39, height: 33 })
    expect(c.textSize('')).toEqual({ width: 0, height: 22 })
    expect(c.textSize('\u{1F600}x', 1).width).toBe(13) // one character per code point
    expect(() => c.textSize('a', 0)).toThrow(RangeError)
    expect(() => c.text(0, 0, 'a', WHITE, { scale: 1.5 })).toThrow(/text scale must be a positive integer/)
  })

  it('draws inside its box, the outline reaching each edge of it', () => {
    const c = new Canvas(60, 40, BLACK)
    c.text(5, 7, 'Hg', RED, { scale: 2, outline: WHITE })
    expect(bounds([...where(c, RED), ...where(c, WHITE)])).toEqual([5, 7, 5 + 26 - 1, 7 + 22 - 1])
    expect(bounds(where(c, RED))).toEqual([7, 9, 28, 26]) // one scaled font pixel in
    const plain = new Canvas(60, 40, BLACK)
    plain.text(5.4, 6.6, 'Hg', RED) // rounds to (5, 7); default scale 2
    expect(where(plain, RED)).toEqual(where(c, RED))
    expect(where(plain, WHITE)).toEqual([])
  })

  it('paints the outline around the glyph, diagonals included, under it', () => {
    const c = new Canvas(7, 11, BLACK)
    c.text(0, 0, '.', RED, { scale: 1, outline: WHITE })
    expect(where(c, RED)).toEqual([[3, 6], [4, 6], [3, 7], [4, 7]])
    expect(where(c, WHITE)).toHaveLength(4 * 4 - 4)
    c.text(0, 0, '', RED, { outline: WHITE })
    c.text(Number.NaN, 0, 'x', RED)
    expect(where(c, RED)).toHaveLength(4)
  })
})

describe('shapes', () => {
  it('draws a line between pixel centres, thicker across its minor axis', () => {
    const c = new Canvas(20, 10, BLACK)
    c.line(2, 3, 12, 3, WHITE)
    expect(where(c, WHITE)).toEqual(Array.from({ length: 11 }, (_, i) => [2 + i, 3]))
    const back = new Canvas(20, 10, BLACK)
    back.line(12.4, 2.6, 1.6, 3.4, WHITE) // reversed, fractional ends rounded
    expect(where(back, WHITE)).toEqual(where(c, WHITE))
    const diag = new Canvas(10, 10, BLACK)
    diag.line(0, 0, 5, 5, WHITE)
    expect(where(diag, WHITE)).toEqual([0, 1, 2, 3, 4, 5].map((k) => [k, k]))
    const steep = new Canvas(10, 10, BLACK)
    steep.line(0, 0, 2, 6, WHITE)
    expect(where(steep, WHITE).map((p) => p[1])).toEqual([0, 1, 2, 3, 4, 5, 6]) // one pixel per row
    const thick = new Canvas(20, 10, BLACK)
    thick.line(2, 3, 12, 3, WHITE, 2)
    expect(new Set(where(thick, WHITE).map((p) => p[1]))).toEqual(new Set([3, 4]))
    const column = new Canvas(10, 20, BLACK)
    column.line(4, 2, 4, 12, WHITE, 3)
    expect(new Set(where(column, WHITE).map((p) => p[0]))).toEqual(new Set([3, 4, 5]))
    expect(where(column, WHITE)).toHaveLength(33)
  })

  it('clips a line to the canvas instead of walking far-away ends', () => {
    const c = new Canvas(20, 10, BLACK)
    c.line(-1e12, 5, 1e12, 5, WHITE)
    expect(where(c, WHITE)).toEqual(Array.from({ length: 20 }, (_, i) => [i, 5]))
    c.line(-50, -50, -10, -3, RED, 4) // entirely outside
    c.line(Number.NaN, 0, 3, 3, RED)
    c.line(0, Infinity, 3, 3, RED)
    expect(where(c, RED)).toEqual([])
    expect(() => c.line(0, 0, 1, 1, RED, 0)).toThrow(/line thickness must be a positive integer/)
  })

  it('draws a ring: the pixels whose centres lie within thickness / 2 of the circle', () => {
    const c = new Canvas(41, 41, BLACK)
    c.ring(20, 20, 10, WHITE, 2)
    const on = new Set(where(c, WHITE).map(([x, y]) => `${x},${y}`))
    for (const p of ['30,20', '29,20', '10,20', '11,20', '20,10', '20,11', '20,30', '20,29', '27,27']) expect(on.has(p), p).toBe(true)
    for (const p of ['31,20', '28,20', '9,20', '20,20', '28,28', '26,26']) expect(on.has(p), p).toBe(false)
    for (const p of on) {
      const [x, y] = p.split(',').map(Number) as [number, number]
      expect(on.has(`${40 - x},${y}`) && on.has(`${y},${x}`), p).toBe(true) // mirror and diagonal symmetry
    }
    const thin = new Canvas(41, 41, BLACK)
    thin.ring(20, 20, 10, WHITE)
    expect(rgbAt(thin, 30, 20)).toEqual([...WHITE])
    expect(rgbAt(thin, 29, 20)).toEqual([...BLACK])
    expect(rgbAt(thin, 31, 20)).toEqual([...BLACK])
    const dot = new Canvas(5, 5, BLACK)
    dot.ring(2, 2, 0, WHITE)
    expect(where(dot, WHITE)).toEqual([[2, 2]])
    dot.ring(2, 2, -1, RED)
    dot.ring(Number.NaN, 2, 1, RED)
    dot.ring(2, 2, Infinity, RED)
    expect(where(dot, RED)).toEqual([])
    expect(() => dot.ring(2, 2, 1, RED, 1.5)).toThrow(RangeError)
  })

  it('outlines or fills a rectangle and sets single pixels, rounding coordinates', () => {
    const c = new Canvas(10, 10, BLACK)
    c.rect(2, 3, 4, 3, WHITE)
    expect(where(c, WHITE)).toHaveLength(10)
    expect(rgbAt(c, 3, 4)).toEqual([...BLACK]) // the inside stays
    c.rect(1.6, 2.6, 4.4, 3.4, RED, true)
    expect(bounds(where(c, RED))).toEqual([2, 3, 5, 5])
    expect(where(c, RED)).toHaveLength(12)
    c.rect(0, 0, 0, 5, WHITE, true)
    c.rect(0, 0, Number.NaN, 5, WHITE, true)
    c.pixel(7.4, 8.6, WHITE)
    expect(rgbAt(c, 7, 9)).toEqual([...WHITE])
    c.pixel(-1, 0, WHITE)
    c.pixel(10, 0, WHITE)
    c.pixel(Number.NaN, 0, WHITE)
    expect(where(c, WHITE)).toHaveLength(1)
  })

  it('clips every shape at the edges exactly as a larger canvas cropped', () => {
    const draw = (cv: Canvas, ox: number, oy: number): void => {
      cv.line(ox - 9, oy - 9, ox + 40, oy + 40, RED, 3)
      cv.line(ox - 30, oy + 5, ox + 50, oy + 5, WHITE, 2)
      cv.ring(ox + 3, oy + 2, 7, WHITE, 2)
      cv.rect(ox + 15, oy - 4, 10, 30, RED)
      cv.rect(ox - 3, oy + 10, 6, 6, WHITE, true)
      cv.text(ox + 9, oy + 4, 'Ag', WHITE, { scale: 2, outline: RED })
      cv.text(ox - 7, oy - 5, 'W', RED, { scale: 2, outline: WHITE })
    }
    const small = new Canvas(20, 14, BLACK)
    draw(small, 0, 0)
    const big = new Canvas(80, 60, BLACK)
    draw(big, 30, 20)
    const crop: number[] = []
    for (let y = 0; y < 14; y += 1) for (let x = 0; x < 20; x += 1) crop.push(...rgbAt(big, 30 + x, 20 + y))
    expect([...small.rgb]).toEqual(crop)
    expect(where(small, RED).length).toBeGreaterThan(20)
    expect(where(small, WHITE).length).toBeGreaterThan(20)
  })
})

describe('Canvas', () => {
  it('starts white or in a given background, clamping colours to bytes', () => {
    expect(rgbAt(new Canvas(2, 2), 1, 1)).toEqual([255, 255, 255])
    expect(rgbAt(new Canvas(2, 2, [300, -5, 12.6]), 0, 1)).toEqual([255, 0, 13])
    const c = new Canvas(3, 1, BLACK)
    c.pixel(1, 0, [Number.NaN, 7.5, 254.4])
    expect(rgbAt(c, 1, 0)).toEqual([0, 8, 254])
    expect(() => new Canvas(0, 5)).toThrow(/canvas size must be positive integers, got 0x5/)
    expect(() => new Canvas(2.5, 5)).toThrow(RangeError)
  })

  it('copies the pixels it is made from', () => {
    const rgb = Uint8Array.from([1, 2, 3, 4, 5, 6])
    const c = Canvas.fromRgb(2, 1, rgb)
    rgb[0] = 99
    expect([...c.rgb]).toEqual([1, 2, 3, 4, 5, 6])
    expect(() => Canvas.fromRgb(2, 2, rgb)).toThrow(/expected 12 RGB bytes for 2x2, got 6/)
  })

  it('encodes itself as the same PNG every time', () => {
    const c = new Canvas(30, 20, GREY)
    c.text(2, 2, 'Δf', MARK_RGB, { outline: BLACK })
    const png = c.png()
    expect(c.png()).toEqual(png)
    const img = decoded(png)
    expect([img.width, img.height]).toEqual([30, 20])
    expect([...img.rgb]).toEqual([...c.rgb])
  })
})

describe('drawMarks', () => {
  const grey = (w: number, h = w): Canvas => new Canvas(w, h, GREY)

  it('rings each mark and puts its text to the upper right, outlined in black', () => {
    const c = grey(200)
    drawMarks(c, [{ x: 100, y: 100, r: 10, text: '1' }])
    expect(rgbAt(c, 110, 100)).toEqual([...MARK_RGB])
    expect(rgbAt(c, 90, 100)).toEqual([...MARK_RGB])
    expect(rgbAt(c, 100, 100)).toEqual([...GREY])
    // 200 px → the reference's 13-px font → scale 2; box 14 × 22 at (round(100 + 7.2 + 1), round(100 - 7.2 - 1) - 18)
    // '1' is 4 font pixels wide: ink in box columns 1..4, outline in 0..5, of 0..6
    expect(bounds(where(c, BLACK))).toEqual([108, 74, 108 + 11, 74 + 17])
    const text = where(c, MARK_RGB).filter(([x, y]) => y < 90 && x > 106) // the ring starts at row 90
    expect(bounds(text)).toEqual([108 + 2, 74 + 2, 108 + 9, 74 + 15])
  })

  it('moves text inside the image near edges and corners, never cutting it', () => {
    const mark = (x: number, y: number): Canvas => {
      const c = grey(120, 100)
      drawMarks(c, [{ x, y, r: 6, text: '88' }], { ring: false })
      return c
    }
    const middle = mark(40, 60)
    const ink = where(middle, MARK_RGB).length
    const outline = where(middle, BLACK).length
    for (const [x, y] of [[0, 0], [119, 0], [0, 99], [119, 99], [60, 1], [-50, 300]] as const) {
      const c = mark(x, y)
      expect(where(c, MARK_RGB).length, `${x},${y}`).toBe(ink)
      expect(where(c, BLACK).length, `${x},${y}`).toBe(outline)
    }
    expect(bounds(where(mark(119, 0), BLACK))).toEqual([120 - 26, 0, 119, 17])
  })

  it('scales the text with the image like the reference\'s 13–22 px font', () => {
    const capitals = (size: number): number => {
      const c = grey(size)
      drawMarks(c, [{ x: size / 2, y: size / 2, r: 8, text: '1' }], { ring: false })
      const b = bounds(where(c, MARK_RGB))
      return b[3] - b[1] + 1
    }
    expect(capitals(64)).toBe(14)
    expect(capitals(768)).toBe(14)
    expect(capitals(886)).toBe(14)
    expect(capitals(887)).toBe(21)
    expect(capitals(1024)).toBe(21)
  })

  it('draws every ring before any text', () => {
    const a = { x: 30, y: 60, r: 5, text: '8' }
    const alone = grey(120, 100)
    drawMarks(alone, [a], { ring: false })
    const both = grey(120, 100)
    drawMarks(both, [a, { x: 75, y: 48, r: 30, text: '9' }]) // the second ring runs through the first text
    expect(rgbAt(both, 46, 48)).toEqual([...MARK_RGB])
    for (let y = 0; y < 100; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        if (rgbAt(alone, x, y).join() !== GREY.join()) expect(rgbAt(both, x, y), `${x},${y}`).toEqual(rgbAt(alone, x, y))
      }
    }
  })

  it('outlines dark marks in white, can leave rings out, and skips marks without a position', () => {
    const dark: Rgb = [20, 20, 20]
    const c = grey(100)
    drawMarks(c, [{ x: 50, y: 50, r: 9, text: '3' }], { colour: dark })
    expect(where(c, WHITE).length).toBeGreaterThan(0)
    expect(where(c, BLACK)).toEqual([])
    expect(rgbAt(c, 59, 50)).toEqual([...dark])
    const n = grey(100)
    drawMarks(n, [{ x: 50, y: 50, r: 9, text: '3' }], { ring: false })
    expect(rgbAt(n, 59, 50)).toEqual([...GREY])
    const none = grey(100)
    drawMarks(none, [
      { x: Number.NaN, y: 5, r: 3, text: '1' },
      { x: 5, y: Infinity, r: 3, text: '2' },
    ])
    expect([...none.rgb]).toEqual([...grey(100).rgb])
    const noRadius = grey(100)
    drawMarks(noRadius, [{ x: 50, y: 50, r: Number.NaN, text: '4' }])
    expect(bounds(where(noRadius, BLACK))).toEqual([51, 31, 51 + 13, 31 + 17]) // text as for r = 0
  })
})

describe('niceTicks', () => {
  it('takes the smallest 1-2-5 step with at most the given number of intervals', () => {
    expect(niceTicks(0, 1, 5)).toMatchObject({ step: 0.2, labels: ['0.0', '0.2', '0.4', '0.6', '0.8', '1.0'] })
    expect(niceTicks(-1.05, 1.05, 8)).toMatchObject({ step: 0.5, labels: ['-1.0', '-0.5', '0.0', '0.5', '1.0'] })
    expect(niceTicks(0, 12.4, 7)).toMatchObject({ step: 2, labels: ['0', '2', '4', '6', '8', '10', '12'] })
    expect(niceTicks(24591.25, 24591.35, 5).labels).toEqual(['24591.26', '24591.28', '24591.30', '24591.32', '24591.34'])
    const t = niceTicks(-1, 1, 2)
    expect(t.labels).toEqual(['-1', '0', '1'])
    expect(Object.is(t.values[1], 0)).toBe(true)
  })

  it('makes the step finer until at least two ticks fall inside', () => {
    expect(niceTicks(0.3, 0.9, 1)).toMatchObject({ step: 0.2, labels: ['0.4', '0.6', '0.8'] })
    expect(niceTicks(0.3, 0.9, 0).labels).toEqual(['0.4', '0.6', '0.8'])
  })

  it('writes exponents beyond 6 decimals or from 10^7', () => {
    expect(niceTicks(0, 3e-9, 3).labels).toEqual(['0', '1e-9', '2e-9', '3e-9'])
    expect(niceTicks(1.1e-7, 1.5e-7, 4).labels).toEqual(['1.1e-7', '1.2e-7', '1.3e-7', '1.4e-7', '1.5e-7'])
    expect(niceTicks(0, 5e7, 5).labels).toEqual(['0', '1e7', '2e7', '3e7', '4e7', '5e7'])
    expect(niceTicks(-2.5e-8, 2.5e-8, 4).labels).toEqual(['-2e-8', '0', '2e-8'])
  })

  it('needs finite lo < hi', () => {
    expect(() => niceTicks(1, 1, 5)).toThrow(/finite lo < hi/)
    expect(() => niceTicks(Number.NaN, 1, 5)).toThrow(RangeError)
  })
})

describe('linePlot', () => {
  const ramp = (n: number, step = 1): number[] => Array.from({ length: n }, (_, i) => i * step)

  /** Columns of the plot-area frame whose top edge is row `y`: the longest black run in it. */
  function frameAt(img: Img, y: number): [number, number] {
    let best: [number, number] = [0, -1]
    let start = -1
    for (let x = 0; x <= img.width; x += 1) {
      const black = x < img.width && rgbAt(img, x, y).every((v) => v === 0)
      if (black && start < 0) start = x
      if (!black && start >= 0) {
        if (x - 1 - start > best[1] - best[0]) best = [start, x - 1]
        start = -1
      }
    }
    return best
  }

  it('fills exactly the requested size, the panels sharing its height and the first ones the odd pixels', () => {
    const panels = [0, 1, 2].map((k) => ({ yLabel: `y${k} (pA)`, series: [{ x: [0, 1, 2], y: [k, k + 1, k] }] }))
    // above the 42-px x axis band: 600 = 200 + 200 + 200 px, 602 = 201 + 201 + 200 px
    const cases = [
      { height: 642, tops: [0, 200, 400], shares: [200, 200, 200] },
      { height: 644, tops: [0, 201, 402], shares: [201, 201, 200] },
    ]
    for (const { height, tops, shares } of cases) {
      const r = linePlot({ width: 600, height, xLabel: 'Bias (V)', panels })
      expect([r.width, r.height]).toEqual([600, height])
      const img = decoded(r.png)
      expect([img.width, img.height]).toEqual([600, height])
      const frame = frameAt(img, 31)
      expect(frame[1] - frame[0]).toBeGreaterThan(450)
      tops.forEach((top, k) => {
        expect(frameAt(img, top + 31), `top of panel ${k}`).toEqual(frame)
        // the plot area is the panel's share less 48 px; the frame's bottom edge is the row after it
        expect(frameAt(img, top + 32 + (shares[k] as number) - 48), `bottom of panel ${k}`).toEqual(frame)
      })
      const lowest = Math.max(...where(img, BLACK).map((p) => p[1])) // the x label, at the bottom
      expect(height - 1 - lowest).toBe(10) // under its capitals: 6 px of descender rows and pad, then the 4-px margin
    }
    for (const [width, height, n] of [[768, 400, 1], [768, 802, 1], [768, 768, 4], [600, 600, 4]] as const) {
      const r = linePlot({ width, height, xLabel: 'Bias (V)', panels: Array.from({ length: n }, (_, k) => panels[k % 3] as (typeof panels)[0]) })
      expect(pngSize(r.png), `${n} panel(s) in ${width} x ${height}`).toEqual({ width, height })
    }
  })

  it('breaks a line at a non-finite value and dots a lone sample', () => {
    const img = decoded(
      linePlot({
        width: 500,
        height: 292,
        xLabel: 'x (nm)',
        panels: [{ yLabel: 'y (pm)', series: [{ x: ramp(11), y: [1, 2, 1, 2, Number.NaN, 2, Infinity, 2, 1, 2, 1] }] }],
      }).png,
    )
    const [fl, fr] = frameAt(img, 31)
    const col = (x: number): number => fl + 1 + Math.round((x / 10) * (fr - fl - 2))
    const cols = new Set(where(img, SERIES_1).map((p) => p[0]))
    for (const x of [0, 3, 5, 7, 10]) expect(cols.has(col(x)), `x = ${x}`).toBe(true)
    for (let c = col(3) + 2; c < col(5) - 1; c += 1) expect(cols.has(c), `column ${c}`).toBe(false)
    for (let c = col(5) + 2; c < col(7) - 1; c += 1) expect(cols.has(c), `column ${c}`).toBe(false)
    expect([...cols].filter((c) => Math.abs(c - col(5)) <= 1)).toHaveLength(3) // the lone sample: a 3 × 3 dot
  })

  it('keeps everything inside the plot area for an x range narrower than the data', () => {
    const img = decoded(
      linePlot({
        width: 500,
        height: 242,
        xLabel: 'x (nm)',
        xRange: [4, 2],
        panels: [
          {
            yLabel: 'y (pm)',
            series: [{ x: ramp(101, 0.1), y: ramp(101, 0.1).map((v) => v * v) }],
            vlines: [{ x: 0.5, text: 'out' }],
            points: [{ x: 9, y: 1 }],
          },
        ],
      }).png,
    )
    const [fl, fr] = frameAt(img, 31)
    const xs = where(img, SERIES_1).map((p) => p[0])
    expect(Math.min(...xs)).toBe(fl + 1)
    expect(Math.max(...xs)).toBe(fr - 1)
    expect(where(img, MARKER)).toEqual([]) // marker line, label and point outside the range
  })

  it('draws dashed marker lines with labels at the top, moved apart and kept inside', () => {
    const green: Rgb = [0, 160, 0]
    const blue: Rgb = [0, 0, 200]
    const purple: Rgb = [160, 0, 160]
    const img = decoded(
      linePlot({
        width: 600,
        height: 282,
        xLabel: 'distance from p1 (nm)',
        xRange: [0, 10],
        panels: [
          {
            yLabel: 'Z (pm)',
            series: [{ x: [0, 10], y: [0, 1] }],
            vlines: [
              { x: 5, colour: green, text: 'A' },
              { x: 5.05, colour: blue, text: 'B' },
              { x: 9.98, colour: purple, text: 'C' },
              { x: Number.NaN, text: 'nowhere' },
              { x: 2 },
            ],
          },
        ],
      }).png,
    )
    const [fl, fr] = frameAt(img, 31)
    const col = (x: number): number => fl + 1 + Math.round((x / 10) * (fr - fl - 2))
    const dash = where(img, MARKER).filter(([x]) => x === col(2))
    expect(dash.length).toBeGreaterThan(80) // about 6 of every 10 rows of the 192-px area
    expect(dash.length).toBeLessThan(140)
    const topOf = (c: Rgb, minX: number): number => Math.min(...where(img, c).filter(([x]) => x >= minX).map((p) => p[1]))
    expect(col(5.05) - col(5)).toBeLessThan(10) // the labels would overlap …
    expect(topOf(green, col(5) + 3)).toBe(32 + 2 + 2) // … so A stays at the top
    expect(topOf(blue, col(5.05) + 3)).toBe(32 + 2 + 22 + 2) // and B moves one line down
    expect(where(img, purple).filter(([x]) => x > col(9.98) + 1)).toEqual([]) // C to the left of its line
    expect(where(img, purple).filter(([x]) => x < col(9.98) - 3).length).toBeGreaterThan(10)
  })

  it('draws labelled points as red dots with the label to their upper right', () => {
    const r = (): Uint8Array =>
      linePlot({
        width: 600,
        height: 282,
        xLabel: 'Bias (V)',
        panels: [
          {
            yLabel: 'dI/dV (nS)',
            series: [{ x: [0, 10], y: [0, 1] }],
            points: [{ x: 2, y: 0.2, text: 'peak' }, { x: 8, y: 0.8 }, { x: Number.NaN, y: 1, text: 'gone' }],
          },
        ],
      }).png
    const png = r()
    expect(r()).toEqual(png) // deterministic
    const img = decoded(png)
    const [fl, fr] = frameAt(img, 31)
    const px = fl + 1 + Math.round(0.2 * (fr - fl - 2))
    const py = 32 + Math.round(((1.05 - 0.2) / 1.1) * (240 - 48 - 1))
    expect(rgbAt(img, px, py)).toEqual([...MARKER])
    const label = where(img, MARKER).filter(([x, y]) => x > px + 5 && y < py - 5 && x < px + 60)
    expect(label.length).toBeGreaterThan(20)
    expect(Math.max(...label.map((p) => p[1]))).toBeLessThan(py - 5)
  })

  it('colours several series from the palette, dashes on request, and says "no data" for an empty panel', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ x: [0, 1], y: [i, i + 0.5] }))
    const opts: LinePlotOptions = {
      width: 400,
      height: 3 * 150 + 42,
      xLabel: 't (s)',
      panels: [
        { yLabel: 'many (pA)', series: many },
        { yLabel: 'flat (pA)', series: [{ x: [0, 1, 2], y: [3, 3, 3], dashed: true }, { x: [0, 2], y: [3.1, 3.1], colour: RED }] },
        { yLabel: 'none (pA)', series: [{ x: [0, 1], y: [Number.NaN, Number.NaN] }], vlines: [{ x: 0.5 }] },
      ],
    }
    const img = decoded(linePlot(opts).png)
    const rows = (c: Rgb): number[] => where(img, c).map((p) => p[1])
    expect(rows(SERIES_2).every((y) => y < 150)).toBe(true) // second colour, first panel
    expect(rows(SERIES_1).some((y) => y < 150)).toBe(true) // first and ninth series
    const dashed = rows(SERIES_1).filter((y) => y >= 150 && y < 300).length
    const solid = rows(RED).filter((y) => y >= 150 && y < 300).length
    expect(dashed).toBeGreaterThan(0.4 * solid)
    expect(dashed).toBeLessThan(0.85 * solid)
    const note = rows(NOTE)
    expect(note.length).toBeGreaterThan(30)
    expect(note.every((y) => y >= 300 && y < 450)).toBe(true)
  })

  it('makes room for wide x tick labels and fits or shortens long axis labels', () => {
    const r = linePlot({
      width: 600,
      height: 2 * 120 + 42,
      xLabel: 'x '.repeat(200),
      xRange: [24591.25, 24591.35],
      panels: [
        { yLabel: 'a'.repeat(40), series: [{ x: [24591.2, 24591.4], y: [0, 1] }] },
        { yLabel: 'b'.repeat(120), series: [{ x: [24591.2, 24591.4], y: [1e-9, 3e-9] }] },
      ],
    })
    const img = decoded(r.png)
    expect(frameAt(img, 31)[1]).toBe(600 - (Math.ceil(98 / 2) + 2)) // half of '24591.30' (98 px) and 2 px
    const ink = where(img, BLACK)
    expect(Math.max(...ink.map((p) => p[0]))).toBeLessThan(599)
    const titleRows = (top: number): [number, number][] => ink.filter(([, y]) => y >= top + 4 && y < top + 4 + 22)
    expect(Math.max(...titleRows(0).map((p) => p[0]))).toBeLessThan(600 - 2) // 40 characters at scale 1
    expect(Math.max(...titleRows(120).map((p) => p[0]))).toBeLessThan(600 - 2) // 120 cut short
    expect(Math.max(...titleRows(120).map((p) => p[0]))).toBeGreaterThan(500)
  })

  it('spans x over the finite samples of all series, or 0..1 without any, leaving out markers beyond it', () => {
    const one = decoded(
      linePlot({ width: 400, height: 192, xLabel: 'x', panels: [{ yLabel: 'y', series: [{ x: [3], y: [5] }], vlines: [{ x: 3 }] }] }).png,
    )
    expect(where(one, SERIES_1).length).toBe(9) // a single sample: a dot
    const empty = decoded(linePlot({ width: 400, height: 192, xLabel: 'x', panels: [{ yLabel: 'y', series: [] }] }).png)
    expect(where(empty, NOTE).length).toBeGreaterThan(30)
    const img = decoded(
      linePlot({
        width: 400,
        height: 2 * 150 + 42,
        xLabel: 'x',
        panels: [
          {
            yLabel: 'y',
            series: [{ x: [0, 1], y: [0, 1] }],
            vlines: [{ x: 4, text: 'far' }, { x: 1 }],
            points: [{ x: -1, y: 0.5, text: 'gone' }],
          },
          { yLabel: 'z', series: [{ x: [Number.NaN, 2, 3], y: [0, Number.NaN, 1] }] }, // only (3, 1) counts
        ],
      }).png,
    )
    const [fl, fr] = frameAt(img, 31)
    const at1 = fl + 1 + Math.round((1 / 3) * (fr - fl - 2)) // x spans 0..3
    const red = where(img, MARKER).map((p) => p[0])
    expect(red.length).toBeGreaterThan(40)
    expect(new Set(red)).toEqual(new Set([at1, at1 + 1])) // the 2-px marker line at x = 1, nothing for x = 4 or -1
  })

  it('refuses no panels, sizes that leave no plot area, and a non-finite x range', () => {
    const panel = { yLabel: 'y', series: [{ x: [0, 1], y: [0, 1] }] }
    expect(() => linePlot({ width: 600, height: 242, xLabel: 'x', panels: [] })).toThrow(/at least one panel/)
    expect(() => linePlot({ width: 600, height: 109, xLabel: 'x', panels: [panel] })).toThrow(
      /plot height 109 is too small for 1 panel\(s\): it needs at least 110 px/,
    )
    expect(linePlot({ width: 600, height: 110, xLabel: 'x', panels: [panel] }).height).toBe(110)
    expect(() => linePlot({ width: 600, height: 313, xLabel: 'x', panels: [panel, panel, panel, panel] })).toThrow(/at least 314 px/)
    expect(() => linePlot({ width: 600, height: 242.5, xLabel: 'x', panels: [panel] })).toThrow(/plot height must be a positive integer/)
    expect(() => linePlot({ width: 0, height: 242, xLabel: 'x', panels: [panel] })).toThrow(/plot width must be a positive integer/)
    expect(() => linePlot({ width: 80, height: 242, xLabel: 'x', panels: [panel] })).toThrow(/leaves less than 20 px/)
    expect(() => linePlot({ width: 600, height: 242, xLabel: 'x', xRange: [0, Number.NaN], panels: [panel] })).toThrow(/xRange/)
  })
})
