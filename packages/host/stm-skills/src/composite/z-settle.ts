/**
 * 退针 → 合环 → **等 Z 不再走**，然后读它。
 *
 * 判据全在内核（`kernel/src/z-settle.ts`：为什么不能睡一个固定时长、什么叫「稳定」、
 * 到轨为什么不是失败）。这个文件只做一件事：**去问**，并且把问不到如实说出来。
 *
 * 与 `wait-scan-complete.ts` 同一条分层 —— 轮询住在技能层（它要发调用），
 * 判据住在内核（它全是值）。
 *
 * ## 这里的每一条都有它防的东西
 *
 * | | |
 * |---|---|
 * | **每次先退针** | 稳定后的 Z 只有在每次都从同一个地方起步时才是间距的函数（旧仓 docstring 第 1 条） |
 * | **窗口至少 3** | 窗口为 1 时净漂移恒为 0 ⇒ 第一个读数就被判「收敛」——同一个缺陷，用一个差一错重建 |
 * | **轮询读不进台账** | 5 s × 10 Hz = 100 次往返；一百条记录会把结果自己埋了 |
 * | **`ZCtrl_OnOffGet` 只记不判** | 实时控制器按设计滞后于写入，t=0 的 OFF 可能纯属延迟 |
 * | **setpoint 读不到要留下理由** | 下游的危险判据是相对的；2026-08-10 现场想查「为什么读不到」时，台账里连 setpoint 本身都没有 |
 */
import {
  newZSettle,
  settleTimeoutS,
  settleToleranceM,
  zConverged,
  type SkillContext,
  type ZSettle,
} from 'dsh-spm-kernel'
import { num } from '../l0/common.js'
import { verifyZController } from '../l0/verify.js'

export interface SettleOptions {
  /** 覆盖这台机器自己的 `z_settle_timeout_s` 预算。生产路径不传。 */
  readonly timeoutS?: number | undefined
  readonly pollIntervalS?: number | undefined
  readonly windowN?: number | undefined
  /** 默认 `true`。见抬头第一行。 */
  readonly withdrawFirst?: boolean | undefined
}

const failed = (rec: { error?: string | undefined }): boolean =>
  rec.error !== undefined && rec.error !== ''

/**
 * 退针、合环、等 Z 停下来。
 *
 * **它永不抛、也永不猜**：预算内没收敛就报 `moving` 且不带可用的 Z，
 * 而不是把它恰好路过的那个值递出去。
 */
export async function settleAndReadZ(ctx: SkillContext, opts: SettleOptions = {}): Promise<ZSettle> {
  // 窗口为 1 时净漂移由构造恒等于 0，于是第一个读数就会被判收敛 ——
  // **那个缺陷，用一个差一错重建了一遍。**
  const windowN = Math.max(3, Math.trunc(opts.windowN ?? 5))
  const pollIntervalS = opts.pollIntervalS ?? 0.1

  const out = newZSettle(settleToleranceM(), opts.timeoutS ?? settleTimeoutS())

  // 0. 每一次都是同一个初始条件 —— 否则基线与各级不是同一个测量，
  //    **即使两个读数都收敛了也仍然不可比**。
  if (opts.withdrawFirst !== false) await ctx.safeCall('ZCtrl_Withdraw', 1, -1)

  // 1. 合环，让压电去找表面。
  await ctx.safeCall('ZCtrl_OnOffSet', 1)

  // 1b. 问**实时控制器**它闭没闭 —— **只为留痕**。`settle: false`，因为下面本来
  //     就要轮询好几秒，再叠一个等待循环什么也买不到。而且**不拿它当闸**：
  //     RT 控制器按设计滞后于写入，t=0 的 OFF 可能纯属延迟。真要是环没合上，
  //     Z 不会动，下面的超时会报出来 —— 并引用这个读数，
  //     而那句话正是告诉操作员该去查接线还是该调大预算的那一句。
  const v = await verifyZController(ctx, { expect: true, settle: false })
  out.loopConfirmedOn = v.verified ? v.on : null

  // 读不到 setpoint 时，**为什么**读不到必须留下来（2026-08-10）。
  // 两种成因指向完全不同的下一步：TCP/模块报错 vs 回包读不懂。
  const recSp = await ctx.safeCall('ZCtrl_SetpntGet')
  if (failed(recSp)) {
    out.setpointA = null
    out.setpointWhy = `ZCtrl_SetpntGet 报错:${recSp.error ?? ''}`
  } else {
    out.setpointA = num(recSp, 0)
    if (out.setpointA === null) {
      const raw = recSp.values ?? []
      out.setpointWhy =
        `ZCtrl_SetpntGet 回包读不懂(shape=${Array.isArray(raw) ? 'list' : typeof raw}` +
        `,repr 前 120 字:${JSON.stringify(raw).slice(0, 120)})`
    }
  }

  // 2. 轮询 Z 直到它不再走。
  const t0 = ctx.now()
  const window: number[] = []
  let zLo: number | null = null
  let zHi: number | null = null
  let readsOk = 0

  for (;;) {
    if (ctx.signal.aborted) {
      out.state = 'aborted'
      out.elapsedS = (ctx.now() - t0) / 1000
      return out
    }

    const recZ = await ctx.safeCall('ZCtrl_ZPosGet')
    const recC = await ctx.safeCall('Current_Get')
    const z = failed(recZ) ? null : num(recZ, 0)
    const cur = failed(recC) ? null : num(recC, 0)
    out.elapsedS = (ctx.now() - t0) / 1000
    out.samples += 1

    if (z !== null) {
      readsOk += 1
      out.zM = z
      out.currentA = cur
      window.push(z)
      if (window.length > windowN) window.shift()
      zLo = zLo === null ? z : Math.min(zLo, z)
      zHi = zHi === null ? z : Math.max(zHi, z)
      out.excursionM = zHi - zLo

      if (window.length >= windowN) {
        out.driftM = Math.abs((window[window.length - 1] as number) - (window[0] as number))
        const c = zConverged(out.driftM, out.tolM, cur, out.excursionM)
        if (c.settled && c.state !== null) {
          out.settled = true
          out.state = c.state
          return out
        }
      }
    }

    if (out.elapsedS >= out.timeoutS) break
    if (out.samples >= windowN && readsOk === 0) {
      // 一整个窗口的尝试，一条能解析的 Z 都没有。把预算的剩余部分等完，
      // 也不可能把一条死掉的读回链路变成一个读数，而调用方**现在**就需要这个诊断
      // ——「读不到 Z」与「这台机器比声明的慢」是两种不同的修法。
      break
    }
    if (pollIntervalS > 0) {
      await ctx.sleep(Math.min(pollIntervalS, Math.max(0.0, out.timeoutS - out.elapsedS)) * 1000)
    }
  }

  out.state = out.zM !== null ? 'moving' : 'unreadable'
  return out
}
