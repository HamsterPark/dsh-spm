/**
 * `BiasSettleChange` —— 改偏压的安全通道（穿零保护 + 稳定等待）。
 *
 * 判据全在 `kernel/bias-settle.ts`（六个常量 + 三分支 + 死区拒绝），这里只负责
 * 读起点、读反馈状态、按策略派活、等一会儿。
 *
 * ## 它为什么值得单独是一个技能
 *
 * `SetBias(bias_v=-1.0)` 是一次**完全合法**的调用：参数在范围内，全局 ±10 V 的
 * 安全门不会拦，日志里只留下一行「设置偏压成功」。而如果当时偏压在 +1 V、
 * 反馈开着，这一次调用就是一次**撞针**（恒流反馈在零偏压附近维持不住电流，
 * 会把针尖一直推到量程尽头）。
 *
 * 这条领域知识在代码里看不出来，所以它得**长在一个动作上**，
 * 而不是指望每次调用的人（或模型）都记得。
 *
 * ## 两次读，两条不同的拒绝
 *
 * | 读不到什么 | 怎么办 | 为什么 |
 * |---|---|---|
 * | 当前偏压（`Bias_Get`） | **拒绝** | 不知道起点就判不出会不会穿零 —— 这个技能的全部价值就没了 |
 * | 反馈状态（`ZCtrl_OnOffGet`） | **继续**，但死区那一格按「不是明确关着」处理 | 反馈状态只在目标落进死区时才是判据；其余时候它只是一条上报 |
 *
 * 第二条是三态的要点：`deadbandRefused` 写的是 `feedbackOn !== false` ——
 * 「不知道反馈开没开」与「反馈开着」在那一格上做同一件事。
 */
import {
  ZERO_DEADBAND_V,
  deadbandRefused,
  defaultSettleS,
  formatG,
  planBiasChange,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { bool, fail, num, ok } from '../l0/common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

export const BiasSettleChange: Skill = {
  spec: S.BiasSettleChangeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const targetRaw = params['bias_v']
    const target = typeof targetRaw === 'number' ? targetRaw : Number(targetRaw)
    const allowDeadband = params['allow_stop_in_deadband'] === true

    const recBias = await ctx.safeCall('Bias_Get')
    const start = failed(recBias) ? null : num(recBias, 0)
    if (start === null) {
      return fail(
        '读不到当前偏压(Bias_Get)—— 不知道起点就无法判断这次改变会不会穿过零点,拒绝执行。',
      )
    }

    const recFb = await ctx.safeCall('ZCtrl_OnOffGet')
    const feedbackOn = failed(recFb) ? null : bool(recFb, 0)

    // 目标落在死区里：反馈开着（或**状态未知**）时这是个不能停的地方。
    if (deadbandRefused(target, allowDeadband, feedbackOn)) {
      return fail(
        `目标偏压 ${formatG(target, 4)} V 落在低偏压死区(|V| < ${ZERO_DEADBAND_V} V)内,` +
          `而 Z 反馈${feedbackOn === true ? '开着' : '状态未知'}。恒流反馈在这里` +
          '维持不住电流,会把针尖一直推向表面。先关反馈' +
          '(ZControllerOnOff),或改用一个更大的偏压。',
        {
          bias_v_start: start,
          bias_v_target: target,
          feedback_on: feedbackOn,
          deadband_v: ZERO_DEADBAND_V,
        },
      )
    }

    const plan = planBiasChange(start, target)
    const res =
      plan.strategy === 'direct'
        ? await ctx.runSkill('SetBias', { bias_v: target })
        : await ctx.runSkill('SetBiasRamp', {
            bias_v_end: target,
            bias_v_start: start,
            slew_rate_v_per_s: plan.slewVPerS,
          })

    if (res.success !== true) {
      return fail(`偏压变更失败(${plan.strategy}): ${res.error ?? ''}`, {
        bias_v_start: start,
        bias_v_target: target,
        strategy: plan.strategy,
      })
    }

    const given = params['settle_s']
    const settle =
      typeof given === 'number' && Number.isFinite(given)
        ? given
        : defaultSettleS(plan.deltaV, plan.crossesZero)
    if (settle > 0) await ctx.sleep(settle * 1000)

    return ok(
      {
        bias_v_start: start,
        bias_v: target,
        delta_v: target - start,
        crossed_zero: plan.crossesZero,
        strategy: plan.strategy,
        // `direct` 那一支**不报速率** —— 报一个「没用上的速率」比不报更坏：
        // 下游会以为这一次走了斜坡。
        slew_rate_v_per_s: plan.strategy !== 'direct' ? plan.slewVPerS : null,
        settle_s: settle,
        feedback_on: feedbackOn,
      },
      `偏压 ${formatG(start, 4)} V → ${formatG(target, 4)} V` +
        `(${plan.crossesZero ? '穿零斜坡' : plan.strategy}),稳定 ${formatG(settle, 3)} s`,
    )
  },
}
