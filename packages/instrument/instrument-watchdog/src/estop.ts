/**
 * 急停：把针从样品上拔开。**这是最后一道防线**，所以它的每一个细节都是事故买来的。
 *
 * 逐字移植 `mast/core/executor.py` 的 `on_anomaly`。四条不能改的形状：
 *
 * 1. **先停粗逼近与马达，再退压电。** 下面的 `ZCtrl_Withdraw` 只退精调 Z；
 *    如果 Nanonis 的 AutoApproach / 马达还在朝样品走，它几步就把这次退针吃掉。
 *    这两步**尽力而为**，失败绝不能挡住退针。
 * 2. **`ZCtrl_Withdraw` 两个参数都必须给。** 旧代码只传一个，在真机上抛 `TypeError`
 *    并被吞进 `record.error` ⇒ **急停从来没跑过**，最后一道防线是死的
 *    （2026-06-10 复查 C1）。`-1` = 一直等到针完全退出来。
 * 3. **emergency 失败要退回 main。** 专用急停口可能没连上或抖动，
 *    而一个活着的 main 口照样能退针（2026-07-28 派发审计「致命三」：
 *    一个卡住的 main socket 曾经把回退退针整个吞掉）。
 * 4. **必须回报「确认了没有」。** 没确认就上闩的话，一次失败的退针会把看门狗
 *    整个 session 解除武装（2026-07-03 复查）。
 */

export type EstopRole = 'emergency' | 'main'

/** 调一个动词。返回带 `error` 的记录（我们这套「不抛」约定，见 1.6）。 */
export type EstopCall = (
  method: string,
  args: readonly unknown[],
  role: EstopRole,
) => Promise<{ readonly error?: string | undefined }>

export interface EstopStep {
  readonly method: string
  readonly role: EstopRole
  readonly error?: string | undefined
}

export interface EstopResult {
  /** 退针**确认**了吗。false ⇒ 看门狗保持武装、冷却后重试，而不是上闩。 */
  readonly confirmed: boolean
  /** 最终是从哪个角色退成功的；都失败就是 `null`。 */
  readonly viaRole: EstopRole | null
  /** 逐步留痕，给记录与事后复盘。 */
  readonly steps: readonly EstopStep[]
}

/** 停粗逼近与马达。**尽力而为**——失败只留痕，绝不挡住退针。 */
const PRE_RETRACT: readonly (readonly [string, readonly unknown[]])[] = [
  ['AutoApproach_OnOffSet', [0]],
  ['Motor_StopMove', []],
]

export async function emergencyRetract(call: EstopCall): Promise<EstopResult> {
  const steps: EstopStep[] = []

  for (const [method, args] of PRE_RETRACT) {
    try {
      const rec = await call(method, args, 'emergency')
      steps.push({ method, role: 'emergency', error: rec.error })
    } catch (e) {
      // 连抛出来都不许挡住退针。留痕就够了。
      steps.push({ method, role: 'emergency', error: (e as Error).message })
    }
  }

  for (const role of ['emergency', 'main'] as const) {
    try {
      // 两个参数都要给：Wait_until_finished=1、Timeout_ms=-1（一直等到退完）
      const rec = await call('ZCtrl_Withdraw', [1, -1], role)
      steps.push({ method: 'ZCtrl_Withdraw', role, error: rec.error })
      if (rec.error === undefined) return { confirmed: true, viaRole: role, steps }
    } catch (e) {
      steps.push({ method: 'ZCtrl_Withdraw', role, error: (e as Error).message })
    }
  }

  return { confirmed: false, viaRole: null, steps }
}
