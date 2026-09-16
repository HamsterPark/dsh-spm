/**
 * `ctx.runSkill` → `GraphExecutor` 的步骤分发器。
 *
 * 本仓前四个组合技能（`WaitScanComplete` / `SetBiasRamp` / `AutoApproach` /
 * `ApproachTip`）都把**相**当步骤跑（`skillName` 是 `_phase_*` 这种本地分发键），
 * 所以它们的 `run` 直接就是自己的方法。批 4d 的两个是本仓第一批**真的把子技能排进
 * 计划**的组合，于是需要这一层把两个形状接起来：
 *
 * | | `SkillResultLike` | `StepResult` |
 * |---|---|---|
 * | `error` | `string \| undefined` | `string`（可选，但**不许是** `undefined`） |
 * | `data` | `Record \| undefined` | `Record \| null` |
 *
 * ⚠️ **不许在这里加判据。** 它只搬形状 —— 子步的闸门由 `ctx.runSkill` 再进一次内核
 * 保证（D-KERNEL-1），这里多写一句 `if` 就是旧仓那份「手写的第二份闸门清单」的开头。
 *
 * `undefined` → `''` / `null` 这两步不是装饰：`exactOptionalPropertyTypes` 下
 * 「这个键不存在」与「这个键是 undefined」是两种类型，而执行器按 `result.error ||
 * '(no error message)'` 读它。
 */
import type { SkillContext, StepResult } from 'dsh-spm-kernel'

export function runSubSkill(
  ctx: SkillContext,
  name: string,
  params: Readonly<Record<string, unknown>>,
): Promise<StepResult> {
  return ctx.runSkill(name, params).then((r) => ({
    success: r.success,
    error: r.error ?? '',
    data: r.data ?? null,
  }))
}
