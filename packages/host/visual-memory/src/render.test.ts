import { describe, expect, it } from 'vitest'
import { decodePng } from './png.js'
import {
  colourLimits,
  crop,
  fmtNum,
  greyRgb,
  NAN_RGB,
  percentileSorted,
  planView,
  rangeAttr,
  regionToNative,
  RegionError,
  renderValues,
  upscaleRgb,
  viewCornersNm,
  visualLabel,
} from './render.js'

describe('contrast', () => {
  it('interpolates percentiles like numpy (linear, with its lerp for t >= 0.5)', () => {
    expect(percentileSorted([1, 2, 3, 4], 50)).toBe(2.5)
    expect(percentileSorted([1, 2, 3, 4], 0)).toBe(1)
    expect(percentileSorted([1, 2, 3, 4], 100)).toBe(4)
    expect(percentileSorted([0, 10], 75)).toBe(7.5) // 10 - 10·0.25
    const hundred = Float64Array.from({ length: 101 }, (_, i) => i)
    expect(percentileSorted(hundred, 0.5)).toBe(0.5)
    expect(percentileSorted(hundred, 99.5)).toBe(99.5)
  })

  it('takes the clip percentiles of the finite values, clamped to 0..49', () => {
    const v = [Number.NaN, ...Array.from({ length: 101 }, (_, i) => i)]
    expect(colourLimits(v, 0.5)).toEqual([0.5, 99.5])
    expect(colourLimits(v, 0)).toEqual([0, 100])
    expect(colourLimits(v, -5)).toEqual([0, 100])
    expect(colourLimits(v, 80)).toEqual([49, 51]) // clamped to 49
    expect(colourLimits(v)).toEqual([0.5, 99.5])
  })

  it('falls back to min/max for a flat region, and to 0..1 with nothing finite', () => {
    // 0.1 % of the values are high: the 0.5 / 99.5 percentiles are both 0
    const v = [...Array<number>(999).fill(0), 7]
    expect(colourLimits(v, 0.5)).toEqual([0, 7])
    expect(colourLimits([Number.NaN, Infinity])).toEqual([0, 1])
    expect(colourLimits([3, 3, 3])).toEqual([3, 3])
  })
})

describe('grey levels and scaling', () => {
  it('maps lo → 0, hi → 255, clips outside, rounds half to even, colours NaN', () => {
    const rgb = greyRgb([0, 10, -5, 15, 5, Number.NaN], 0, 10)
    const greys = [0, 255, 0, 255, 128] // 5/10·255 = 127.5 → 128 (even)
    greys.forEach((g, i) => expect([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]).toEqual([g, g, g]))
    expect([...rgb.subarray(15, 18)]).toEqual([...NAN_RGB])
  })

  it('shows a constant region as mid grey', () => {
    expect([...greyRgb([4, 4], 4, 4).subarray(0, 3)]).toEqual([128, 128, 128])
  })

  it('enlarges each pixel into an s × s block', () => {
    const rgb = Uint8Array.from([1, 2, 3, 4, 5, 6]) // 2 × 1
    expect([...upscaleRgb(rgb, 2, 1, 2)]).toEqual([1, 2, 3, 1, 2, 3, 4, 5, 6, 4, 5, 6, 1, 2, 3, 1, 2, 3, 4, 5, 6, 4, 5, 6])
    expect(upscaleRgb(rgb, 2, 1, 1)).toBe(rgb)
  })
})

describe('regions and views', () => {
  it('widens an upscaled region outward to whole native pixels', () => {
    const s = { num: 3, den: 1 } // 10 × 8 frame shown at 30 × 24
    expect(regionToNative(null, 10, 8, s)).toEqual([0, 0, 10, 8])
    expect(regionToNative({ x: 4, y: 2, width: 5, height: 7 }, 10, 8, s)).toEqual([1, 0, 3, 3])
    expect(regionToNative({ x: 0, y: 0, width: 30, height: 24 }, 10, 8, s)).toEqual([0, 0, 10, 8])
  })

  it('maps a block-mean region to native pixels and clips the last partial block', () => {
    const s = { num: 1, den: 2 } // 9 × 5 frame shown at 5 × 3
    expect(regionToNative({ x: 1, y: 1, width: 4, height: 2 }, 9, 5, s)).toEqual([2, 2, 9, 5])
  })

  it('refuses regions outside the display image or with bad sizes', () => {
    const s = { num: 3, den: 1 }
    expect(() => regionToNative({ x: 25, y: 0, width: 6, height: 1 }, 10, 8, s)).toThrow(/leaves the frame's 30x24 display image/)
    expect(() => regionToNative({ x: -1, y: 0, width: 1, height: 1 }, 10, 8, s)).toThrow(RegionError)
    expect(() => regionToNative({ x: 0, y: 0, width: 0, height: 1 }, 10, 8, s)).toThrow(/at least 1/)
    expect(() => regionToNative({ x: 0.5, y: 0, width: 1, height: 1 }, 10, 8, s)).toThrow(/integers/)
  })

  it('enlarges a region by the largest whole factor that fits, reporting its magnification', () => {
    const s = { num: 3, den: 1 }
    const whole = planView(10, 8, s, null, 30)
    expect(whole).toMatchObject({ native: [0, 0, 10, 8], image_size: [30, 24], up: 3, down: 1, region_px: [0, 0, 30, 24], magnification: 1 })
    const v = planView(10, 8, s, { x: 3, y: 3, width: 6, height: 6 }, 30)
    expect(v).toMatchObject({ native: [1, 1, 3, 3], image_size: [30, 30], up: 15, region_px: [3, 3, 6, 6], magnification: 5 })
  })

  it('block-means a region with more native pixels than the display', () => {
    const v = planView(1000, 600, { num: 1, den: 2 }, null, 300)
    expect(v).toMatchObject({ up: 1, down: 4, image_size: [250, 150], region_px: [0, 0, 500, 300] })
    expect(v.magnification).toBe(0.5)
    const part = planView(9, 5, { num: 1, den: 2 }, { x: 1, y: 1, width: 4, height: 2 }, 768)
    expect(part).toMatchObject({ native: [2, 2, 9, 5], region_px: [1, 1, 4, 2], up: 109, image_size: [763, 327] })
  })

  it('crops a native box', () => {
    const z = Float64Array.from({ length: 12 }, (_, i) => i) // 4 × 3
    expect([...crop(z, 4, [1, 1, 3, 3])]).toEqual([5, 6, 9, 10])
  })
})

describe('renderValues', () => {
  it('renders the crop with its own contrast and integer upscaling', () => {
    // 4 × 2 frame; view of native [1,0,3,2] at 3x → 6 × 6 image
    const z = Float64Array.from([0, 1, 2, 3, 4, 5, 6, Number.NaN])
    const view = planView(4, 2, { num: 3, den: 1 }, { x: 3, y: 0, width: 6, height: 6 }, 6)
    const r = renderValues(z, 4, view, 0)
    expect([r.lo, r.hi]).toEqual([1, 6])
    const img = decodePng(r.png)
    expect([img.width, img.height]).toEqual([6, 6])
    const px = (x: number, y: number) => [...img.data.subarray((y * 6 + x) * 3, (y * 6 + x) * 3 + 3)]
    expect(px(0, 0)).toEqual([0, 0, 0]) // value 1 = black
    expect(px(5, 5)).toEqual([255, 255, 255]) // value 6 = white
    expect(px(3, 0)).toEqual([51, 51, 51]) // value 2: (2-1)/5·255 = 51
    expect(px(2, 2)).toEqual([0, 0, 0]) // still inside the 3 × 3 block of value 1
  })

  it('uses given limits and block-means before colouring', () => {
    const z = Float64Array.from([0, 2, 4, 6, 8, 10, 12, 14]) // 4 × 2, mean blocks of 2
    const view = planView(4, 2, { num: 1, den: 1 }, null, 2)
    expect(view.down).toBe(2)
    const r = renderValues(z, 4, view, 0.5, [0, 14])
    const img = decodePng(r.png)
    expect([img.width, img.height]).toEqual([2, 1])
    // block means 5 and 9 over [0, 14] → rint(5/14·255) = 91, rint(9/14·255) = 164
    expect([img.data[0], img.data[3]]).toEqual([91, 164])
  })
})

describe('corners and labels', () => {
  it('gives the scan-frame nm of a view\'s corners, rounded to 1e-4', () => {
    const g = { cx_nm: 1, cy_nm: 2, w_nm: 8, h_nm: 4, angle_deg: 0, nx: 16, ny: 8 }
    const v = planView(16, 8, { num: 4, den: 1 }, { x: 8, y: 4, width: 8, height: 4 }, 64)
    // native box [2, 1, 4, 2]: u = -4 + col/2, v = 2 - row/2
    expect(viewCornersNm(g, v)).toEqual({ top_left: [-2, 3.5], top_right: [-1, 3.5], bottom_left: [-2, 3], bottom_right: [-1, 3] })
  })

  it('writes attributes in order, omits null, escapes markup', () => {
    expect(visualLabel('inspection', [['index', 1], ['label', 'a "b" <c> & d\ne'], ['skip', null], ['gone', undefined], ['frame', 't0001.s0']])).toBe(
      '<visual kind="inspection" index="1" label="a &quot;b&quot; &lt;c&gt; &amp; d e" frame="t0001.s0"/>',
    )
  })

  it('names the colour-scale attribute and formats numbers like Python', () => {
    expect(rangeAttr('Z', 'pm')).toBe('z_range_pm')
    expect(rangeAttr('Current', 'pA')).toBe('range_pA')
    expect(rangeAttr('Frequency Shift', 'mHz')).toBe('range_mHz')
    expect(rangeAttr('X', 'µV')).toBe('range_µV')
    expect(rangeAttr('X', '')).toBe('range_value')
    expect(rangeAttr('Z', 'm/s')).toBe('range_ms')
    expect(fmtNum(-23.15)).toBe('-23.1') // -23.15 is stored as -23.149999…
    expect(fmtNum(0.125, 2)).toBe('0.12')
    expect(fmtNum(-0.04)).toBe('0.0') // a rounded zero carries no sign
    expect(fmtNum(-0.06)).toBe('-0.1')
    expect(fmtNum(Number.NaN)).toBe('nan')
  })
})
