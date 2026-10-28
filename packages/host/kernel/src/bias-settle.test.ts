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
 * 另有 `biasNeedsSafePath`（模型面改偏压的分流判据）对金样 `spec/golden/bias_routing.json` 的逐格比，在文件末尾。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

// ── 分流判据：对 `spec/golden/bias_routing.json` 逐格比 ──────────────────────────────────
//
// 金样由参考实现 7.1.0 的外部动作面录成（`tools/spec-export/export_bias_routing.py`）：对每个（起点，目标）
// 跑它的 `_set_bias`（执行器换成只记录「被请求了哪个技能」的替身），第二个被请求的技能是 `BiasSettleChange`
// 记真、是 `SetBias` 记假；起点为 null 是「读不到」，走的是 `_set_bias` 自己的那一支，不经谓词。起点读得到时
// 导出器另调 `_bias_needs_safe_path`，两者逐格一致才写出。不手改这张表：参考实现换了分流条件，重导金样后
// 这里就会红。`0.3 → 0.8` 这类变化量恰在 0.5 附近的格，浮点的最后一位决定真假，只有参考实现的 IEEE 结果可信。
const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/bias_routing.json', import.meta.url)), 'utf8'),
) as {
  constants: {
    actions: { BIAS_DEADBAND_V: number; BIAS_RAMP_THRESHOLD_V: number }
    bias_settle: { RAMP_THRESHOLD_V: number; ZERO_DEADBAND_V: number }
  }
  targets: number[]
  rows: { start_v: number | null; safe_path: boolean[] }[]
}

describe('biasNeedsSafePath：对参考实现的金样逐格相等', () => {
  it.each(G.rows)('起点 $start_v', ({ start_v, safe_path }) => {
    expect(safe_path).toHaveLength(G.targets.length)
    G.targets.forEach((target, j) => {
      expect(biasNeedsSafePath(start_v, target), `${String(start_v)} → ${target}`).toBe(safe_path[j])
    })
  })

  it('网格没有被悄悄缩小，且含「读不到起点」一行', () => {
    expect(G.rows.length * G.targets.length).toBeGreaterThanOrEqual(380)
    expect(G.rows.some((row) => row.start_v === null)).toBe(true)
  })

  it('两个常量与参考实现里的原件、镜像都相等', () => {
    expect(ZERO_DEADBAND_V).toBe(G.constants.bias_settle.ZERO_DEADBAND_V)
    expect(ZERO_DEADBAND_V).toBe(G.constants.actions.BIAS_DEADBAND_V)
    expect(RAMP_THRESHOLD_V).toBe(G.constants.bias_settle.RAMP_THRESHOLD_V)
    expect(RAMP_THRESHOLD_V).toBe(G.constants.actions.BIAS_RAMP_THRESHOLD_V)
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
