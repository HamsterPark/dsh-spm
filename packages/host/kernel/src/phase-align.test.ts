/**
 * 相位对齐的算术 —— 两条语言差异，各自单独钉住。
 *
 * 这两条都不是「风格问题」：一条把目标相位挪了 360°，另一条让金样在最后两位上
 * 对不上。它们的共同点是**在小数据上看不见**。
 */
import { describe, expect, it } from 'vitest'
import { pyMean, pySum } from './si.js'
import {
  AUTOPHASE_MIN_SIGNAL,
  PHASE_READBACK_TOL_DEG,
  foldDeg,
  phaseMatches,
  phaseTarget,
  pyMod,
  sampleSd,
  signalMagnitude,
} from './phase-align.js'

describe('pyMod —— Python 取模，不是 JS 取余', () => {
  it('负数上两者符号相反', () => {
    expect(pyMod(-80, 360)).toBe(280)
    expect(-80 % 360).toBe(-80) // JS 的余数，对照
  })

  it('正数原样穿过去 —— **不绕一圈**', () => {
    // `((a % n) + n) % n` 会对正数也走一遍 +360 再取余，而那一来一回在浮点上
    // 不是恒等变换：目标相位会在最后一两位上和 Python 分岔。
    const a = 206.56505117707799
    expect(pyMod(a, 360)).toBe(a)
    expect(pyMod(a, 360) - 180).toBe(26.565051177077976)
  })

  it('正好整除时给 0，不给 n —— 而且零的符号取自**除数**（CPython 的 copysign）', () => {
    expect(pyMod(360, 360)).toBe(0)
    expect(Object.is(pyMod(-360, 360), 0)).toBe(true) // JS 的 % 在这里给 -0
    expect(Object.is(-360 % 360, -0)).toBe(true)
  })
})

describe('foldDeg —— 折进 [-180, 180)', () => {
  it('两端与跨零：**180° 折成 −180°**（上端是开的）', () => {
    expect(foldDeg(0)).toBe(0)
    expect(foldDeg(180)).toBe(-180)
    expect(foldDeg(-180)).toBe(-180)
    expect(foldDeg(190)).toBe(-170)
    expect(foldDeg(-260)).toBe(100)
  })
})

describe('phaseTarget —— 算出来的是增量', () => {
  it('signal_to_x：把信号转到 X 轴', () => {
    const { deltaDeg, targetDeg } = phaseTarget('signal_to_x', 0, 2e-9, 1e-9)
    expect(deltaDeg).toBeCloseTo(26.565, 3)
    expect(targetDeg).toBeCloseTo(26.565, 3)
  })

  it('crosstalk_to_y：**多转 −90°**，信号轴于是落在 X', () => {
    const a = phaseTarget('signal_to_x', 0, 2e-9, 1e-9)
    const b = phaseTarget('crosstalk_to_y', 0, 2e-9, 1e-9)
    expect(b.deltaDeg).toBe(a.deltaDeg - 90)
  })

  it('**加到当前相位上** —— 它是增量，不是目标', () => {
    // 起点不同 ⇒ 目标不同。把它当目标写下去，等于把相位转到一个谁也没要的地方。
    expect(phaseTarget('signal_to_x', 30, 1e-9, 0).targetDeg).toBe(30)
    expect(phaseTarget('signal_to_x', -30, 1e-9, 0).targetDeg).toBe(-30)
  })

  it('跨零那一格：−170° 起、−90° 增量 ⇒ **+100°**，不是 −260°', () => {
    const { targetDeg } = phaseTarget('crosstalk_to_y', -170, 1e-9, 0)
    expect(targetDeg).toBe(100)
    expect(targetDeg).toBeGreaterThanOrEqual(-180)
    expect(targetDeg).toBeLessThan(180)
  })
})

describe('pySum —— CPython 3.12 起的 Neumaier 补偿求和', () => {
  it('朴素相加在这一串上就差最后两位', () => {
    const xs = [2.0e-9, 2.2e-9, 1.8e-9]
    expect(pySum(xs)).toBe(6e-9)
    expect(xs.reduce((a, b) => a + b, 0)).toBe(5.999999999999999e-9)
  })

  it('均值因此也不同 —— 金样是逐字节比的', () => {
    expect(pyMean([2.0e-9, 2.2e-9, 1.8e-9])).toBe(2e-9)
  })

  it('空表给 NaN', () => {
    expect(pySum([])).toBe(0)
    expect(Number.isNaN(pyMean([]))).toBe(true)
  })
})

describe('sampleSd —— n−1，少于两个点给 0', () => {
  it('与旧仓那一串逐位相同', () => {
    expect(sampleSd([2.0e-9, 2.2e-9, 1.8e-9])).toBe(1.9999999999999993e-10)
    expect(sampleSd([1.0e-9, 1.1e-9, 0.9e-9])).toBe(9.999999999999996e-11)
  })

  it('一个点：0（不是 NaN）', () => {
    expect(sampleSd([1e-9])).toBe(0)
    expect(sampleSd([])).toBe(0)
  })

  it('全一样的样本给 0', () => {
    expect(sampleSd([1e-15, 1e-15, 1e-15])).toBe(0)
  })
})

describe('噪声底与回读容差', () => {
  it('|R| 是两路的模', () => {
    expect(signalMagnitude(3, 4)).toBe(5)
    expect(signalMagnitude(1e-15, 1e-15)).toBeLessThan(AUTOPHASE_MIN_SIGNAL)
    expect(signalMagnitude(2e-9, 1e-9)).toBeGreaterThan(AUTOPHASE_MIN_SIGNAL)
  })

  it('**读不到不是一样** —— `null` 回读一律不符', () => {
    expect(phaseMatches(26.5, null)).toBe(false)
    expect(phaseMatches(26.5, 26.5)).toBe(true)
  })

  it('0.5° 是**绝对**容差 —— 相位跨零，相对容差在 0° 附近要求无穷精度', () => {
    expect(PHASE_READBACK_TOL_DEG).toBe(0.5)
    expect(phaseMatches(0, 0.4)).toBe(true)
    expect(phaseMatches(0, 0.6)).toBe(false)
    // 同样的 0.4°，在 179° 上也算符合——相对容差在这里会松到 0.18°
    expect(phaseMatches(179, 179.4)).toBe(true)
  })
})
