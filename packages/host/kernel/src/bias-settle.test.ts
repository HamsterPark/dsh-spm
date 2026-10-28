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
 *
 * 另有 `biasNeedsSafePath`（模型面改偏压的分流判据）的真值表，文件末尾，由参考实现跑出。
 */
import { describe, expect, it } from 'vitest'
import {
  CROSS_ZERO_SLEW_V_PER_S,
  DEFAULT_SETTLE_S,
  RAMP_THRESHOLD_V,
  SETTLE_DEFAULT_SLEW_V_PER_S,
  SMALL_CHANGE_SETTLE_S,
  ZERO_DEADBAND_V,
  biasNeedsSafePath,
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

// ── 真值表（参考实现跑出来的，不是手写的）──────────────────────────────────────────────
//
// 来源：参考实现 7.1.0 的外部动作面（`vista/actions.py`），在参考项目的 Python 3.13.13 环境里、用该版本的
// 提交快照逐格跑出。对每个（起点，目标）调用它的 `_set_bias`（执行器换成只记录「被请求了哪个技能」的替身）：
// 第二个被请求的技能是 `BiasSettleChange` 记 true、是 `SetBias` 记 false；起点为 null 是「读不到」，走的是
// `_set_bias` 自己的那一支，不经谓词。起点读得到时另调 `_bias_needs_safe_path`，两者逐格一致才收录；
// 参考实现自己的路由测试的 11 例也在格点里，并与它的期望对过。
//
// 格点：20 个起点 × 19 个目标 = 380 格。**格点可增不可减，不要手改这张表**——要改就按上面的做法对着
// 参考实现重新跑一遍再贴。`0.3 → 0.8` 这类变化量恰在 0.5 附近的格，浮点的最后一位决定真假，只有参考实现的
// IEEE 结果可信。
const REFERENCE_TABLE: ReadonlyArray<
  readonly [start: number | null, cells: ReadonlyArray<readonly [target: number, safe: boolean]>]
> = [
  [null, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [-1, [
    [-1, false], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, false], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [-0.3, [
    [-1, true], [-0.3, false], [-0.06, false], [-0.05, false], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, false], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [-0.06, [
    [-1, true], [-0.3, false], [-0.06, false], [-0.05, false], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, false], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [-0.05, [
    [-1, true], [-0.3, false], [-0.06, false], [-0.05, false], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, false], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [-0.02, [
    [-1, true], [-0.3, false], [-0.06, false], [-0.05, false], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, false], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [0, [
    [-1, true], [-0.3, false], [-0.06, false], [-0.05, false], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, false], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [0.02, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [0.05, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [0.06, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [0.3, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, false], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [1, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, false], [1, false], [1.5, false], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [1.5, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, false], [1.5, false], [2, false], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [-1.2, [
    [-1, false], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [-0.1, [
    [-1, true], [-0.3, false], [-0.06, false], [-0.05, false], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, false], [-0.04, true], [0.02, true], [0.4, true],
  ]],
  [0.03, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [0.1, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [0.2, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, true], [1, true], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [0.5, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, false], [0.06, false], [0.3, false], [0.8, false], [1, false], [1.5, true], [2, true], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, false],
  ]],
  [2, [
    [-1, true], [-0.3, true], [-0.06, true], [-0.05, true], [-0.0499, true], [0, true], [0.0499, true],
    [0.05, true], [0.06, true], [0.3, true], [0.8, true], [1, true], [1.5, false], [2, false], [-2, true],
    [-0.5, true], [-0.04, true], [0.02, true], [0.4, true],
  ]],
]

describe('biasNeedsSafePath：真值表逐格等于参考实现', () => {
  it.each(REFERENCE_TABLE)('起点 %s', (start, cells) => {
    for (const [target, safe] of cells) {
      expect(biasNeedsSafePath(start, target), `${String(start)} → ${target}`).toBe(safe)
    }
  })

  it('格点没有被悄悄缩小，且含「读不到起点」一行', () => {
    expect(REFERENCE_TABLE.reduce((n, [, cells]) => n + cells.length, 0)).toBeGreaterThanOrEqual(380)
    expect(REFERENCE_TABLE.some(([start]) => start === null)).toBe(true)
  })

  it('三类改动走安全路径，其余直写（读得出来的几个例子）', () => {
    expect(biasNeedsSafePath(1, -1)).toBe(true) // 变号
    expect(biasNeedsSafePath(0.2, 1.5)).toBe(true) // 大幅，不变号
    expect(biasNeedsSafePath(0.3, 0)).toBe(true) // 变化量不大，但目标落在死区
    expect(biasNeedsSafePath(null, 0.3)).toBe(true) // 起点读不到
    expect(biasNeedsSafePath(0.5, 0.4)).toBe(false)
    expect(biasNeedsSafePath(0, 0.3)).toBe(false) // 从 0 出发不算穿零
    expect(biasNeedsSafePath(0.1, ZERO_DEADBAND_V)).toBe(false) // 死区的边界是开的（`<`）
  })
})
