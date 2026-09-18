/**
 * `bias-settle.ts` 的三分支与那条死区拒绝。
 *
 * 技能层的金样（`batch5b.json` 的 `bias/*` 十格）已经把**报文与调用序列**钉住了，
 * 这里只补两件它排不出来的：
 *
 * 1. **从 0 V 出发 / 停到 0 V 不算穿零** —— 那一格在技能层要先过死区闸，
 *    而死区闸会把它拦在判据之前；
 * 2. 两条阈值线（`>` 与 `<=`）**必须在同一个点上分**，否则会出现
 *    「走 `direct` 却等 2 s」这种谁都解释不了的组合。
 */
import { describe, expect, it } from 'vitest'
import {
  CROSS_ZERO_SLEW_V_PER_S,
  DEFAULT_SETTLE_S,
  RAMP_THRESHOLD_V,
  SETTLE_DEFAULT_SLEW_V_PER_S,
  SMALL_CHANGE_SETTLE_S,
  ZERO_DEADBAND_V,
  deadbandRefused,
  defaultSettleS,
  planBiasChange,
} from './bias-settle.js'

describe('planBiasChange：穿零要**两端都不是 0**', () => {
  it('变号 ⇒ 快斜坡', () => {
    const p = planBiasChange(1.0, -1.0)
    expect(p.strategy).toBe('ramp_through_zero')
    expect(p.slewVPerS).toBe(CROSS_ZERO_SLEW_V_PER_S)
    expect(p.crossesZero).toBe(true)
  })

  it('从 0 V 出发、或停到 0 V ⇒ **不算穿零**（另有闸管这两种）', () => {
    expect(planBiasChange(0, -1.0).crossesZero).toBe(false)
    expect(planBiasChange(1.0, 0).crossesZero).toBe(false)
    // 幅度都超过阈值，所以它们走的是普通斜坡而不是快斜坡
    expect(planBiasChange(0, -1.0).slewVPerS).toBe(SETTLE_DEFAULT_SLEW_V_PER_S)
  })

  it('两条阈值线在**同一个点**上分：恰好 `RAMP_THRESHOLD_V` 走 direct + 短稳定', () => {
    const exact = planBiasChange(1.0, 1.0 + RAMP_THRESHOLD_V)
    expect(exact.strategy).toBe('direct')
    expect(defaultSettleS(exact.deltaV, exact.crossesZero)).toBe(SMALL_CHANGE_SETTLE_S)

    const justOver = planBiasChange(1.0, 1.0 + RAMP_THRESHOLD_V * 1.001)
    expect(justOver.strategy).toBe('ramp')
    expect(defaultSettleS(justOver.deltaV, justOver.crossesZero)).toBe(DEFAULT_SETTLE_S)
  })

  it('穿零一律等长的那个稳定时间，哪怕幅度很小', () => {
    const tiny = planBiasChange(0.06, -0.06)
    expect(tiny.deltaV).toBeLessThan(RAMP_THRESHOLD_V)
    expect(defaultSettleS(tiny.deltaV, tiny.crossesZero)).toBe(DEFAULT_SETTLE_S)
  })
})

describe('deadbandRefused：**三态**，「不知道」与「开着」做同一件事', () => {
  it('目标在死区里：开着拒、不知道也拒、明确关着才放行', () => {
    const target = ZERO_DEADBAND_V / 2
    expect(deadbandRefused(target, false, true)).toBe(true)
    expect(deadbandRefused(target, false, null)).toBe(true)
    expect(deadbandRefused(target, false, false)).toBe(false)
  })

  it('显式开口（`allow_stop_in_deadband`）压过前两种', () => {
    expect(deadbandRefused(ZERO_DEADBAND_V / 2, true, true)).toBe(false)
  })

  it('目标在死区外一律放行 —— 死区的边界是**开**的（`<`）', () => {
    expect(deadbandRefused(ZERO_DEADBAND_V, false, true)).toBe(false)
    expect(deadbandRefused(-ZERO_DEADBAND_V, false, true)).toBe(false)
  })
})
