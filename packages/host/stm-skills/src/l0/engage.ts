/**
 * `TryEngageController` —— 只靠反馈环能不能建立隧穿；建立不了，**能不能建议粗进针**。
 *
 * 后半句才是这个技能的要害。`needs_auto_approach: true` 是在告诉 agent 去跑
 * **开环粗进针马达** —— 那是这套系统里唯一一个能可靠毁掉针尖的动作，
 * 它没有电流反馈停止机制，**只有 Z 反馈环开着时才安全**。
 *
 * 所以这里有两处 fail-closed，方向相同：
 *
 * 1. **测不出隧穿就不建议粗进针。** 建议粗进针只在电流反馈链**工作**时才安全，
 *    而那条链正是粗进针撞针前的刹车。每一次 `Current_Get` 都失败、或者设定点
 *    读不出/真的是 0 ⇒ 判不了隧穿 ⇒ **绝不**置 `needs_auto_approach` ——
 *    否则「测量链自己坏了」就成了盲目粗进针的触发条件。
 * 2. **确认不了反馈环已断开就不建议粗进针。** 从前这里是「关掉 + 同一口气断言
 *    `z_controller_on: False`」，既不看写入有没有失败，也从不回读硬件。
 *    那个写若失败——或者只是还没生效（Nanonis 手册警告过模块与实时控制器
 *    在通信延迟期间会不一致）——agent 就会带着闭合的反馈环把粗动马达开进表面。
 */
import { type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, num, ok } from './common.js'
import { verifyZController } from './verify.js'

/** Python 的 `f"{x:.2e}"`。 */
function e2(v: number): string {
  const s = v.toExponential(2)
  const i = s.indexOf('e')
  let exp = s.slice(i + 1)
  const sign = exp.startsWith('-') ? '-' : '+'
  if (exp.startsWith('-') || exp.startsWith('+')) exp = exp.slice(1)
  if (exp.length < 2) exp = `0${exp}`
  return `${s.slice(0, i)}e${sign}${exp}`
}

export const TryEngageController: Skill = {
  spec: S.TryEngageControllerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const settleS = typeof params['settle_s'] === 'number' ? (params['settle_s'] as number) : 1.5
    const pollHz = typeof params['poll_hz'] === 'number' ? (params['poll_hz'] as number) : 10
    const frac =
      typeof params['engage_fraction'] === 'number' ? (params['engage_fraction'] as number) : 0.5

    const recSp = await ctx.safeCall('ZCtrl_SetpntGet')
    if (recSp.error !== undefined && recSp.error !== '') {
      return fail(`could not read setpoint: ${recSp.error}`)
    }
    const sp = num(recSp, 0)
    const setpointA = sp === null ? 0 : Math.abs(sp)

    const recOn = await ctx.safeCall('ZCtrl_OnOffSet', 1)
    if (recOn.error !== undefined && recOn.error !== '') {
      return fail(`could not turn on Z-controller: ${recOn.error}`)
    }

    let peak = 0
    let nValid = 0
    const n = Math.max(1, Math.trunc(settleS * pollHz))
    const dtMs = (settleS / n) * 1000

    for (let i = 0; i < n; i++) {
      // 沉降循环**只读**，所以这里的 abort 不是硬件风险（abort 之后读一律放行）——
      // 但一次已经被叫停的运行，不该让人再干等完整个沉降窗口才说话。
      if (ctx.signal.aborted) {
        return fail(
          'aborted by operator while waiting for the feedback to settle — ' +
            'engagement is UNVERIFIED. Do not retry, and do not assume the tip is engaged.',
          { engaged: false, aborted: true },
        )
      }
      const recC = await ctx.safeCall('Current_Get')
      if (recC.error === undefined || recC.error === '') {
        const cur = num(recC, 0)
        if (cur !== null) {
          nValid += 1
          peak = Math.max(peak, Math.abs(cur))
        }
      }
      await ctx.sleep(dtMs)
    }

    const threshold = frac * setpointA

    // ── fail-closed ①：判不了隧穿 ⇒ 关回去，不建议粗进针 ──
    if (nValid === 0 || setpointA <= 0) {
      await ctx.safeCall('ZCtrl_OnOffSet', 0)
      // 对**实时控制器**核对，不是把请求回声当结果。
      // `on === null` 是「判断不出来」，**不是** false。
      const v = await verifyZController(ctx, { expect: false })
      const reason =
        nValid === 0
          ? 'current measurement chain returned no valid reading'
          : 'setpoint is non-positive / unreadable'
      return fail(
        `cannot assess tunnelling (${reason}) — refusing to flag a coarse approach ` +
          `on a broken feedback chain; check the preamp / current range / setpoint.`,
        {
          engaged: false,
          z_controller_on: v.on,
          z_controller_verified: v.verified,
          needs_auto_approach: false,
          peak_current_a: peak,
          setpoint_a: setpointA,
          valid_current_reads: nValid,
        },
      )
    }

    if (peak >= threshold) {
      return ok({
        engaged: true,
        z_controller_on: true,
        needs_auto_approach: false,
        peak_current_a: peak,
        setpoint_a: setpointA,
        message: 'Tunneling established — Z-controller ON, tip engaged.',
      })
    }

    // ── 决策点：要不要建议粗进针 ──
    await ctx.safeCall('ZCtrl_OnOffSet', 0)
    const v = await verifyZController(ctx, { expect: false })

    if (!(v.verified && v.on === false)) {
      // **FAIL CLOSED。** 确认不了环是开的 ⇒ 不建议粗进针。
      // **检查本身的失败绝不能成为危险动作的授权。**
      //
      // 报的是我们**真的知道**的那件事：实时控制器说环还闭着 ⇒ `true`（知道，且很糟）；
      // 读失败 ⇒ `null`（不知道）。把两者压成 null，就丢掉了「你的 OFF 写没生效」
      // 这一个能告诉操作的人的信号。
      const why = v.verified
        ? '实时控制器回报 Z 反馈仍然闭合（Z-Controller 模块可能已显示 Off——' +
          '两者不是一回事，Nanonis 手册要求以实时控制器为准）'
        : `无法确认 Z 反馈是否已断开（ZCtrl_OnOffGet 读取失败：${v.error}）`
      return fail(
        `未能建立隧穿（峰值 |I|=${e2(peak)} A < ${e2(threshold)} A），` +
          `但也**不能**建议粗进针：${why}。反馈环还在的时候跑开环粗进针马达就是撞针。`,
        {
          engaged: false,
          z_controller_on: v.on,
          z_controller_verified: v.verified,
          needs_auto_approach: false, // ← fail-closed 的那一位
          peak_current_a: peak,
          setpoint_a: setpointA,
        },
      )
    }

    return ok({
      engaged: false,
      z_controller_on: false,
      z_controller_verified: true,
      needs_auto_approach: true,
      peak_current_a: peak,
      setpoint_a: setpointA,
      message:
        `Could not reach setpoint by feedback alone (peak |I|=${e2(peak)} A < ${e2(threshold)} A). ` +
        `Z-controller confirmed OFF against the real-time controller. ` +
        `Run AutoApproach (coarse motor) to engage the tip.`,
    })
  },
}
