/**
 * 谱分析的小件：频率轴（`shiftedFreq`）。从 visual-memory 的测试搬来，随代码一起。
 */
import { describe, expect, it } from 'vitest'
import { shiftedFreq } from './fft.js'

describe('频率轴', () => {
  it('shiftedFreq = fftshift(fftfreq(n, d))，奇数长度也照 numpy', () => {
    expect(Array.from(shiftedFreq(5, 0.5))).toEqual([-0.8, -0.4, 0, 0.4, 0.8])
    expect(Array.from(shiftedFreq(4, 1))).toEqual([-0.5, -0.25, 0, 0.25])
  })
})
