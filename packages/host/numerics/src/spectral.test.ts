/**
 * 谱分析的小件：频率轴（`shiftedFreq`、`rfftfreq`）、单边谱（`rfft`）与汉明窗。
 * 2026-10-13 随代码从 visual-memory 与 stm-skills 搬来；`MonitorCurrentFFT` 的轨迹金样
 * （stm-skills `traces.test.ts`）照旧从技能那一侧钉住它们的输出。
 */
import { describe, expect, it } from 'vitest'
import { hamming, hanning } from './correlate.js'
import { fft, rfft, rfftfreq, shiftedFreq } from './fft.js'

describe('频率轴', () => {
  it('shiftedFreq = fftshift(fftfreq(n, d))，奇数长度也照 numpy', () => {
    expect(Array.from(shiftedFreq(5, 0.5))).toEqual([-0.8, -0.4, 0, 0.4, 0.8])
    expect(Array.from(shiftedFreq(4, 1))).toEqual([-0.5, -0.25, 0, 0.25])
  })

  it('rfftfreq 是 k/(n·d)：⌊n/2⌋+1 格，每格一次除法', () => {
    expect(Array.from(rfftfreq(8, 0.5))).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(rfftfreq(7, 1).length).toBe(4)
    const n = 1000
    const d = 1 / 997.3
    rfftfreq(n, d).forEach((v, k) => expect(v).toBe(k / (n * d)))
  })
})

describe('单边谱', () => {
  it('rfft 是 fft 的前 ⌊n/2⌋+1 格，逐位相同；空序列给空谱', () => {
    for (const n of [1, 2, 7, 8, 61, 64]) {
      const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + 0.25 * i)
      const half = rfft(x)
      const full = fft(x)
      expect(half.re.length).toBe((n >> 1) + 1)
      half.re.forEach((v, k) => expect(Object.is(v, full.re[k])).toBe(true))
      half.im.forEach((v, k) => expect(Object.is(v, full.im[k])).toBe(true))
    }
    expect(rfft([]).re.length).toBe(0)
  })
})

describe('汉明窗', () => {
  it('对称、两端 0.08、中点 1；M = 0 与 1 照 numpy；窗长必须是整数', () => {
    const w = hamming(5)
    expect(w[0]).toBeCloseTo(0.08, 15)
    expect(w[2]).toBe(1)
    w.forEach((v, k) => expect(v).toBe(w[4 - k]))
    expect(Array.from(hamming(0))).toEqual([])
    expect(Array.from(hamming(1))).toEqual([1])
    expect(() => hamming(2.5)).toThrow(RangeError)
  })

  it('与汉宁窗同式同序，只差两个系数', () => {
    const m = 33
    const hm = hamming(m)
    const hn = hanning(m)
    for (let k = 0; k < m; k += 1) {
      const c = Math.cos((Math.PI * (1 - m + 2 * k)) / (m - 1))
      expect(hm[k]).toBe(0.54 + 0.46 * c)
      expect(hn[k]).toBe(0.5 + 0.5 * c)
    }
  })
})
