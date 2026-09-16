/**
 * 压电范围对账 —— **第三态是要害**。
 *
 * 把 `unknown` 折成 `ok`，这个自检就变成一句永远为真的安慰话，
 * 而那正是它要防的东西（2026-08-16：配置比实际大 23 %，54 分钟的修针工作全丢）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PIEZO_TOLERANCE_FRAC, halfRange, reconcilePiezoRange } from './index.js'

const HALF = 1219.4999e-9 // 真机实测的 XY 半程

describe('三态', () => {
  it('一致 ⇒ ok', () => {
    const v = reconcilePiezoRange(HALF, HALF, HALF)
    expect(v.verdict).toBe('ok')
    expect(v.relativeDifference).toBeLessThan(1e-12)
  })

  it('**2026-08-16 那一组**：配置 1.5 µm、仪器 1219.5 nm ⇒ mismatch，且配置更大', () => {
    const v = reconcilePiezoRange(HALF, HALF, 1.5e-6)
    expect(v.verdict).toBe('mismatch')
    expect(v.configuredExceeds).toBe(true)
    // 差 23 % —— 那次事故的数
    expect((v.relativeDifference as number) * 100).toBeCloseTo(23.0, 0)
  })

  it('**仪器读不到 ⇒ unknown，不是 ok**', () => {
    // 折成「一致」= 一句它没有依据的安慰话。
    expect(reconcilePiezoRange(null, HALF, 1.5e-6).verdict).toBe('unknown')
    expect(reconcilePiezoRange(HALF, null, 1.5e-6).verdict).toBe('unknown')
    expect(reconcilePiezoRange(null, null, 1.5e-6).verdict).toBe('unknown')
  })

  it('**配置读不到也是 unknown** —— 对账要两边都在', () => {
    expect(reconcilePiezoRange(HALF, HALF, null).verdict).toBe('unknown')
  })

  it('unknown 时三个派生字段全是 `null`，**不编一个出来**', () => {
    const v = reconcilePiezoRange(null, null, null)
    expect(v.minInstrumentHalfM).toBeNull()
    expect(v.relativeDifference).toBeNull()
    expect(v.configuredExceeds).toBeNull()
  })
})

describe('两轴取小 —— **包络要保守**', () => {
  it('X 与 Y 不一样时按小的那个判', () => {
    // 按大的判会放过一个 X 到不了的目标。
    const v = reconcilePiezoRange(1000e-9, 2000e-9, 1500e-9)
    expect(v.minInstrumentHalfM).toBe(1000e-9)
    expect(v.configuredExceeds).toBe(true)
  })
})

describe('容差', () => {
  it('出厂 2 % —— 比读数抖动大得多，比那次事故的 23 % 小得多', () => {
    expect(DEFAULT_PIEZO_TOLERANCE_FRAC).toBe(0.02)
    expect(reconcilePiezoRange(1000e-9, 1000e-9, 1019e-9).verdict).toBe('ok')
    expect(reconcilePiezoRange(1000e-9, 1000e-9, 1021e-9).verdict).toBe('mismatch')
  })

  it('边界是**闭**的：正好等于容差算一致', () => {
    // 同 qPlus 那一格：要用**除得尽**的数。整数那一对**正好**是 0.02，
    // 纳米那一对除不尽，落在容差**外面** —— 差的不是阈值，是那一对数。
    //
    // 两个数都**钉住**，不只写在注释里（2026-09-16：原注释印的是
    // 0.020000000000000004，而真值是 0.02000000000000002 —— 一个没人查的数
    // 迟早是错的，而它正好印在「别去改阈值」那句话旁边）。
    expect(Math.abs(1020 - 1000) / 1000).toBe(0.02)
    expect((1020e-9 - 1000e-9) / 1000e-9).toBe(0.02000000000000002)
    expect((1020e-9 - 1000e-9) / 1000e-9).not.toBe(0.02)

    expect(reconcilePiezoRange(1000, 1000, 1020, 0.02).verdict).toBe('ok')
    expect(reconcilePiezoRange(1000e-9, 1000e-9, 1020e-9).verdict).toBe('mismatch')
  })

  it('容差可以调，`0` 表示一点都不许差', () => {
    expect(reconcilePiezoRange(1000e-9, 1000e-9, 1000.001e-9, 0).verdict).toBe('mismatch')
  })

  it('仪器半程是 0 时不炸，而且照样判 mismatch', () => {
    expect(reconcilePiezoRange(0, 0, 1e-6).verdict).toBe('mismatch')
  })
})

describe('halfRange —— 回的是全程', () => {
  it('半程 = 全程 / 2', () => {
    expect(halfRange(2438.9e-9)).toBeCloseTo(1219.45e-9, 15)
  })

  it('负的量程取绝对值 —— 让它在对账里显出来，而不是在这里静默拒绝', () => {
    expect(halfRange(-2000e-9)).toBe(1000e-9)
  })

  it('读不到就是 `null`', () => {
    expect(halfRange(null)).toBeNull()
  })
})
