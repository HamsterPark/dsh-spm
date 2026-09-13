/**
 * 用完把 lock-in 调制关回去 —— 「一对括号」的**右半边**（旧仓缺陷⑪，真机 2026-08-05）。
 *
 * `ApplyLockInPreset(mod_on=true)` → `AutoPhase` 一趟跑完，调制留在**开着**，用户
 * 手动关回。「谁开谁关」在链式调用下断了：开的那个技能早就返回了，关的责任落在一个
 * 从没打算承担它的技能上。用户口径是「流程结束 = OFF」，所以由**终端消费者**
 * （用完 lock-in 信号、后面没有下一步的那个）负责关，不靠调用方记得。
 *
 * ## 为什么不与「开跑前确认它关着」合并成一个带 flag 的函数
 *
 * 两者的**声称**不同，极性因此相反：
 *
 * - 开跑前那半要说的话是「我发现它开着，替你关了」——这句话需要知道**之前的状态**，
 *   所以读不到就**不动手**；
 * - 这一条说的是「我把它关了」。这句话不需要知道之前的状态：目标状态是确定的，而对
 *   一个已经关着的调制再写一次 OFF 对硬件是空操作。所以**读不到状态照样关** ——
 *   否则「读不回状态」会变成「调制留在开着」，那正是缺陷⑪本身。
 *
 * **判据不同就是两个函数。** 合并成一个带 flag 的只会让下一个人挑错分支。
 */
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { scalarInt } from 'dsh-spm-kernel'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/**
 * 调制开着没有：`true` / `false` / **`null`（读不到）**。永不抛。
 *
 * 三态是必须的——「没读到」被当成「关着」的话，收尾留痕就会说一句它没有依据的话。
 */
async function readModOn(ctx: SkillContext): Promise<boolean | null> {
  const rec = await ctx.safeCall('LockIn_ModOnOffGet', 1)
  if (failed(rec)) return null
  const v = scalarInt(rec.values ?? null)
  return v === null ? null : v !== 0
}

/**
 * 关调制，并**如实说关成了没有**。
 *
 * `modulation_off_after` 三态：`true` / `false` / **`null`（写了但回读不到）** ——
 * 「没确认」既不等于「没关上」，也不等于「关上了」。
 */
export async function closeModulation(
  ctx: SkillContext,
  skillName: string,
): Promise<Record<string, unknown>> {
  const note: Record<string, unknown> = { modulation_closed_by: skillName || '(unnamed)' }
  note['modulation_was_on_before'] = await readModOn(ctx)

  // **只关调制。不传 amplitude / frequency / phase** —— 旧仓缺陷⑧ 就是关的时候
  // 顺手带了个省略的幅度，把 0.02 V 清成 0。关它不需要重写任何值。
  const off = await ctx.safeCall('LockIn_ModOnOffSet', 1, 0)
  if (failed(off)) {
    note['modulation_off_after'] = false
    note['modulation_note'] =
      `用完 lock-in 后关调制**失败**:${off.error ?? ''}。调制可能仍开着 —— ` +
      '它会在电流通道上叠一层纹波,污染后面每一条判据。请手动关闭。'
    return note
  }

  const after = await readModOn(ctx)
  note['modulation_off_after'] = after === null ? null : !after
  if (after === null) {
    note['modulation_note'] =
      '已发出关调制命令,但回读不到调制状态 —— **没确认**它关上了。' +
      '「写进去了」和「我们看见它在里面」是两句话。'
  } else if (after) {
    note['modulation_note'] =
      '发出了关调制命令,回读却仍是开着 —— **不要按已关闭继续**,请手动确认。'
  } else {
    note['modulation_note'] =
      `${skillName} 用完 lock-in,已把调制关回 OFF(幅度/频率原样保留)。` +
      '要接着做 dI/dV,请先用 ApplyLockInPreset 重新打开调制 —— ' +
      '调制关着时 lock-in 通道上没有信号,而曲线照样画得出来。'
  }
  return note
}
