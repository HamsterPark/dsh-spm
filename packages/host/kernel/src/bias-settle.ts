/**
 * 改偏压的**领域知识**：穿零保护 + 稳定等待。旧仓 `composite/bias_settle.py` 的
 * 六个常量与那条三分支策略，零旧仓函数、零 numpy。
 *
 * ## 为什么这是一个判据而不是一句注释
 *
 * Z 反馈是**恒流**的：它调节针尖高度让隧道电流等于设定点。而隧道电流大致正比于
 * 偏压 —— 偏压趋近 0，电流也趋近 0。反馈看到「电流不够」，唯一的反应是**把针尖
 * 往表面推**，一直推到量程尽头。于是
 *
 * ```
 * bias 从 +1 V 直接设到 −1 V → 中途经过 0 V → 电流塌到 0 → 反馈全力推进 → 扎进样品
 * ```
 *
 * 这是教科书级的常识，但它在代码里**看不出来**：`SetBias(bias_v=-1.0)` 是一次
 * 完全合法的调用，参数在范围内，全局 ±10 V 的安全门不会拦，日志里只会留下一行
 * 「设置偏压成功」。所以这条通道存在的意义是**让「改偏压」这个动作自带领域知识**，
 * 而不是指望每次调用它的人（或模型）都记得。
 *
 * ## 三分支，而分支本身就是那句领域知识
 *
 * | 条件 | 策略 | 为什么 |
 * |---|---|---|
 * | 变号 | `ramp_through_zero`，{@link CROSS_ZERO_SLEW_V_PER_S} | 停在死区里的每一毫秒反馈都在把针尖往下推，所以要**快**跨过去 |
 * | \|Δ\| > {@link RAMP_THRESHOLD_V} | `ramp`，{@link SETTLE_DEFAULT_SLEW_V_PER_S} | 偏压跳变会让反馈产生瞬态 |
 * | 其余 | `direct` | 一步设过去，但仍然等一个稳定时间 |
 *
 * ⚠️ **死区宽度与穿零时的 slew 是真机验证项**（旧仓抬头原话）：`SetBiasRamp` 在 0
 * 附近的实际行为（会不会停在某一步上）必须在真机上确认过才能收紧这里的参数。
 * 本仓真机 0 次，所以照移，一个数都不调。
 */

/**
 * 穿零死区半宽（V）。\|V\| 小于它的时候隧道电流已经小到反馈无法维持，
 * **绝不能在这个区间里停留**。
 */
export const ZERO_DEADBAND_V = 0.05

/** 穿零时的斜坡速率（V/s）。要足够快地跨过死区，又不能快到让反馈完全跟丢。 */
export const CROSS_ZERO_SLEW_V_PER_S = 2.0

/** 超过这个变化幅度就走斜坡（而不是一步设过去）。 */
export const RAMP_THRESHOLD_V = 0.5

/**
 * 常规斜坡速率（V/s）。
 *
 * ⚠️ 旧仓 `bias_settle.py` 里它就叫 `DEFAULT_SLEW_V_PER_S`，与 `bias_ramp.py`
 * 里那个**同名同值**的常量撞了。本仓 kernel 的导出是平的（`export *`），
 * 所以这里加前缀 —— 两个数**各归各的文件**，哪天其中一个改了，
 * 另一个不会跟着动（那正是它们本来就是两个常量的理由）。
 */
export const SETTLE_DEFAULT_SLEW_V_PER_S = 1.0

/** 偏压改变后的默认稳定等待（s）。 */
export const DEFAULT_SETTLE_S = 2.0

/** 小幅变化的稳定等待（s）。 */
export const SMALL_CHANGE_SETTLE_S = 0.5

/** 一次偏压变更该怎么走。 */
export interface BiasChangePlan {
  readonly strategy: 'direct' | 'ramp' | 'ramp_through_zero'
  readonly slewVPerS: number
  readonly crossesZero: boolean
  /** `|target − start|`。调用方拿它算缺省稳定时间。 */
  readonly deltaV: number
}

/**
 * 起点 + 终点 → 走哪一条。
 *
 * ⚠️ `crossesZero` 的判据是 `(start > 0) !== (target > 0) && start !== 0 && target !== 0`
 * —— **两端都不是 0 才算穿零**。从 0 V 出发或停到 0 V 都不算：前者本来就在死区里
 * （另一道闸管），后者由 `allow_stop_in_deadband` 管。旧仓逐字如此，这里照移。
 */
export function planBiasChange(startV: number, targetV: number): BiasChangePlan {
  const crossesZero = startV > 0 !== targetV > 0 && startV !== 0 && targetV !== 0
  const deltaV = Math.abs(targetV - startV)
  if (crossesZero) {
    return {
      strategy: 'ramp_through_zero',
      slewVPerS: CROSS_ZERO_SLEW_V_PER_S,
      crossesZero,
      deltaV,
    }
  }
  if (deltaV > RAMP_THRESHOLD_V) {
    return { strategy: 'ramp', slewVPerS: SETTLE_DEFAULT_SLEW_V_PER_S, crossesZero, deltaV }
  }
  return { strategy: 'direct', slewVPerS: SETTLE_DEFAULT_SLEW_V_PER_S, crossesZero, deltaV }
}

/**
 * 缺省稳定时间（s）。**小幅且不穿零**才给短的那一个。
 *
 * `delta <= RAMP_THRESHOLD_V` 用的是 `<=` 而不是 `<`：恰好 0.5 V 的改动走 `direct`
 * （`planBiasChange` 是 `>`），两边必须用同一条线，否则会出现「走 direct 却等 2 s」
 * 这种谁都解释不了的组合。
 */
export function defaultSettleS(deltaV: number, crossesZero: boolean): number {
  return deltaV <= RAMP_THRESHOLD_V && !crossesZero ? SMALL_CHANGE_SETTLE_S : DEFAULT_SETTLE_S
}

/**
 * 目标偏压落在死区里、而 Z 反馈**不是明确关着**时，这次改动要被拒。
 *
 * 三态是要点：`feedbackOn` 为 `null`（读不到）时**照样拒** —— 旧仓写的是
 * `feedback_on is not False`。「不知道反馈开没开」与「反馈开着」在这一格上要做
 * 同一件事，因为猜错的代价是一根针尖。
 */
export function deadbandRefused(
  targetV: number,
  allowStopInDeadband: boolean,
  feedbackOn: boolean | null,
): boolean {
  return Math.abs(targetV) < ZERO_DEADBAND_V && !allowStopInDeadband && feedbackOn !== false
}
