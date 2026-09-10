/**
 * `MoveToXY` —— 用 Follow Me 把针尖挪到一个 XY。
 *
 * ## 为什么是**发出去就返回、自己轮询**
 *
 * `FolMe_XYPosSet(x, y, wait=1)` **在 Nanonis 端阻塞到针尖走到为止**，
 * 而我们的 socket 读超时只有 5 s。一次几百 nm 的位移轻易超过 5 s
 * ⇒ 读超时 ⇒ 连接池退休这条 socket ⇒ Nanonis 的**单客户端**口正卡在一次
 * 未完成的事务里 ⇒ 下一次调用回 `WinError 10054` ⇒ 整条链路崩。
 *
 * 真机 2026-08-13：**连续四次**完整 ForgeAuTip 都死在这一个技能上，每次都是第一步。
 * 而它以前不出事只是因为**它以前根本不动**——修好「打完脉冲要换地方」之前，
 * FindCleanSpot 总是返回距离 0，`_relocate` 距离为 0 时不发移动指令。
 * 避坑修复让这次移动第一次真的发生，也就第一次撞上这个五秒天花板。
 *
 * ## 等待预算必须从**距离 ÷ 速度**派生
 *
 * 先后拍过两个常数，两个都错：120 s 太长（单测实打实等了两分钟）；
 * 30 s 太短，而且**估错了一个数量级**——按「FolMe 速度在 µm/s 量级」估的，
 * 真机实测是 **5 nm/s**（30 s 走 147 nm，10 s 走 50 nm，逐位吻合）。
 * 5 nm/s 下一次 1.3 µm 的位移要 **260 秒**。
 *
 * 读不到速度就退回一个保守常数，并在超时文案里说清它是兜底值——
 * **「不知道」不许伪装成「算过了」。**
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, firstTwoFloats, num, ok, pyExp } from './common.js'

/** 0.5 nm。FolMe 的落点精度远好于此，更严的容差会在压电蠕变上空转。 */
const TOL_M = 0.5e-9
const POLL_MS = 200
const FALLBACK_TIMEOUT_S = 300

/** 位置连续这么多拍逐位不变 ⇒ **压电停住了**，不是还在走。 */
const STALL_POLLS = 5

export const MoveToXY: Skill = {
  spec: S.MoveToXYSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const xM = typeof params['x_m'] === 'number' ? (params['x_m'] as number) : 0
    const yM = typeof params['y_m'] === 'number' ? (params['y_m'] as number) : 0
    const wait = params['wait'] !== false

    // 发出去就返回（wait=0），到没到自己轮询。
    const set = await ctx.safeCall('FolMe_XYPosSet', xM, yM, 0)
    if (set.error !== undefined && set.error !== '') return fail(set.error)

    if (!wait) {
      return ok({
        x_m: xM,
        y_m: yM,
        wait: false,
        arrived: null,
        note: '已下发移动指令,未等待到位(wait=false)。',
      })
    }

    let speed: number | null = null
    const sp = await ctx.safeCall('FolMe_SpeedGet')
    if (sp.error === undefined || sp.error === '') {
      const v = num(sp, 0)
      if (v !== null && v > 0) speed = v
    }

    const startRec = await ctx.safeCall('FolMe_XYPosGet', 1)
    const start =
      startRec.error === undefined || startRec.error === '' ? firstTwoFloats(startRec) : null

    let budgetS = FALLBACK_TIMEOUT_S
    let derived = false
    if (speed !== null && start !== null) {
      const dist = Math.hypot(xM - start[0], yM - start[1])
      budgetS = Math.max(5, (dist / speed) * 1.5 + 10)
      derived = true
    }

    const deadline = ctx.now() + budgetS * 1000
    let last: readonly [number, number] | null = null
    let frozen = 0

    while (ctx.now() < deadline) {
      const rec = await ctx.safeCall('FolMe_XYPosGet', 1)
      if (rec.error !== undefined && rec.error !== '') {
        // 位置读不到 ⇒ **不知道到没到**，不是「没到」。继续轮询；
        // 真断链的话下一拍会带着断链错误回来。
        await ctx.sleep(POLL_MS)
        continue
      }
      const pos = firstTwoFloats(rec)
      if (pos !== null) {
        // 位置**一位都没变**的连续次数。压电走到限位就会停在一个逐位相同的读数上，
        // 而「还在走」的读数每拍都在变——**这一个计数器就是两者唯一的区别**。
        frozen = last !== null && pos[0] === last[0] && pos[1] === last[1] ? frozen + 1 : 0
        last = pos
        if (Math.abs(pos[0] - xM) <= TOL_M && Math.abs(pos[1] - yM) <= TOL_M) {
          return ok({
            x_m: pos[0],
            y_m: pos[1],
            wait: true,
            arrived: true,
            requested_x_m: xM,
            requested_y_m: yM,
          })
        }
      }
      await ctx.sleep(POLL_MS)
    }

    const stalled = frozen >= STALL_POLLS
    const why = stalled
      ? // 从前这两种情况共用一句「针尖可能仍在移动中」。那句话对「还在走」是对的，
        // 对「夹住」是**假的**——它永远不会到，而读到这句话的人（和外环）
        // 会去等一个不会发生的事。
        `。**针尖停住了,不是还在走**:位置连续 ${frozen} 拍逐位不变。` +
        `最可能是目标越过了压电范围 —— 先读 GetPiezoConfig 的 range(半程 = range/2),` +
        `确认目标在范围内;这台仪器的实际半程可能小于 config 里的 xy_max_m。**重试不会有帮助。**`
      : `。**这不是「没动」**:指令已经发出去了,针尖可能仍在移动中 ——` +
        `下一步之前先读一次位置,别假定它还在原处。`

    return fail(
      `移动指令已下发,但 ${budgetS.toFixed(0)} s 内没看到针尖到位` +
        (derived
          ? `(预算由距离 ÷ FolMe 速度 ${((speed ?? 0) * 1e9).toFixed(1)} nm/s 派生)`
          : '(**读不到 FolMe 速度,这是兜底值不是算出来的**)') +
        `。目标 (${pyExp(xM, 3)}, ${pyExp(yM, 3)}) m` +
        (last !== null
          ? `,最后读到 (${pyExp(last[0], 3)}, ${pyExp(last[1], 3)}) m`
          : ',而且**一次位置都没读到**') +
        why,
      {
        requested_x_m: xM,
        requested_y_m: yM,
        // 给**代码**看的那一半：光有文案，调用方没法分支。
        stalled,
        stall_polls: frozen,
        last_x_m: last?.[0] ?? null,
        last_y_m: last?.[1] ?? null,
        arrived: false,
        budget_s: budgetS,
        budget_derived: derived,
        folme_speed_m_s: speed,
      },
    )
  },
}
