/**
 * qPlus 振幅判据 —— **四态里有两态是「判不了」**，而它们最容易被折进「没事」。
 */
import { describe, expect, it } from 'vitest'
import {
  CRASH_FRACTION,
  amplitudeVerdict,
  excitationDriving,
  findAmplitudeChannel,
  looksLikeAmplitudeChannel,
  rememberedIndex,
} from './index.js'

describe('认振幅通道 —— **两组词都要命中**', () => {
  it('操作员那台机器的通道名', () => {
    expect(looksLikeAmplitudeChannel('OCD1 Amplitude')).toBe(true)
    expect(looksLikeAmplitudeChannel('OC D1 Amplitude (m)')).toBe(true)
    expect(looksLikeAmplitudeChannel('PLL Amplitude')).toBe(true)
    expect(looksLikeAmplitudeChannel('Osc Amp')).toBe(true)
  })

  it('**只带 amplitude 不算** —— 信号表里带这个词的还有别的', () => {
    // 激励幅度、幅度设定点都带 amplitude，而它们都不是「音叉现在摆多大」。
    // 认错一条，撞针判据从此读的是一个常数。
    expect(looksLikeAmplitudeChannel('Bias Amplitude')).toBe(false)
    expect(looksLikeAmplitudeChannel('Amplitude Setpoint')).toBe(false)
    expect(looksLikeAmplitudeChannel('Current (A)')).toBe(false)
  })

  it('只带振荡线索也不算', () => {
    expect(looksLikeAmplitudeChannel('PLL Frequency Shift')).toBe(false)
    expect(looksLikeAmplitudeChannel('OCD1 Phase')).toBe(false)
  })

  it('大小写与多余空白都归一', () => {
    expect(looksLikeAmplitudeChannel('  ocd1    AMPLITUDE  ')).toBe(true)
  })

  it('找第一条命中的，找不到给 `null`（**不是故障**）', () => {
    expect(findAmplitudeChannel(['Current (A)', 'Z (m)', 'OCD1 Amplitude'])).toEqual({
      index: 2,
      name: 'OCD1 Amplitude',
    })
    // 一台没有 qPlus 的 STM —— 正常配置，不该看起来像坏了
    expect(findAmplitudeChannel(['Current (A)', 'Z (m)'])).toBeNull()
    expect(findAmplitudeChannel([])).toBeNull()
  })
})

describe('缺陷⑰ · 激励要**两条证据**', () => {
  it('开关开着**并且**幅度 > 0 才算在驱动', () => {
    expect(excitationDriving(true, 0.5)).toBe(true)
  })

  it('**开关开着而幅度是 0，音叉照样没被驱动** —— 本机实测的那一组', () => {
    // 2026-08-06：STM 模式下 excitation_on=0 / excitation_v=0 V，
    // 而振幅通道上那 7–8 pm 是未驱动解调器的噪声底。
    expect(excitationDriving(true, 0)).toBe(false)
    expect(excitationDriving(false, 0.5)).toBe(false)
    expect(excitationDriving(false, 0)).toBe(false)
  })

  it('**任一条读不到就是「判不了」**，不是「没驱动」', () => {
    // 不知道音叉有没有被驱动的时候，振幅这个数不代表任何东西。
    expect(excitationDriving(null, 0.5)).toBeNull()
    expect(excitationDriving(true, null)).toBeNull()
    expect(excitationDriving(null, null)).toBeNull()
  })

  it('负的激励幅度也算没驱动', () => {
    expect(excitationDriving(true, -0.1)).toBe(false)
  })
})

describe('撞针判据 —— 没有基线就判不了', () => {
  it('塌到基线一成以下 ⇒ crash', () => {
    expect(amplitudeVerdict(1e-12, 1e-10)).toEqual({ status: 'crash', fraction: 0.01 })
  })

  it('阈值是**开区间**：正好 10 % 不算撞', () => {
    // ⚠️ 这一格要用**除得尽**的一对数。`1e-11 / 1e-10` 不是 0.1，是
    // 0.09999999999999999 —— 于是它落在阈值**下面**，判 crash。
    // 写下来是因为下一个人会把这当成阈值差一个 ULP 去「修」它：
    // 差的不是阈值，是那一对数除不尽。
    expect(amplitudeVerdict(1, 10).status).toBe('ok')
    expect(amplitudeVerdict(1e-11, 1e-10).status).toBe('crash')
    expect(1e-11 / 1e-10).not.toBe(0.1)
    expect(CRASH_FRACTION).toBe(0.1)
  })

  it('**刻意不是 0** —— 热漂移与前放偏置会留一点残余', () => {
    // 要求精确为零会漏掉真正的撞针。
    expect(amplitudeVerdict(1e-13, 1e-10).status).toBe('crash')
  })

  it('没有基线 / 基线非正 ⇒ `no_baseline`，**不是 ok**', () => {
    // 0 V 的振幅本身不表示任何事：振子可能根本没在跑。
    for (const base of [null, 0, -1]) {
      expect(amplitudeVerdict(0, base).status, String(base)).toBe('no_baseline')
      expect(amplitudeVerdict(0, base).fraction).toBeNull()
    }
  })
})

describe('记住的下标 —— `-1` 是哨兵不是下标', () => {
  it('负数一律不当下标用', () => {
    // 把 -1 传给 Signals_ValGet，读到的是控制器对一个负通道号做的任何事。
    expect(rememberedIndex(-1)).toBeNull()
    expect(rememberedIndex(-7)).toBeNull()
  })

  it('0 是一个合法下标', () => {
    expect(rememberedIndex(0)).toBe(0)
  })

  it('不是数就没有', () => {
    for (const v of [null, undefined, '3', NaN, true]) expect(rememberedIndex(v)).toBeNull()
  })
})
