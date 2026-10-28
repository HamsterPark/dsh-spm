/**
 * 幂等调用在传输层失败之后，停一会儿再做一次。移植自旧仓 `skills/builtins/spectroscopy.py`
 * 的 `_call_idempotent`（v7.1.0）。
 *
 * **只给「把属性设成绝对值」「读」「Open」用**：发两次与发一次让控制器停在同一个状态。
 * 起扫、运动、脉冲永远不用 —— 重做一次就是让仪器再做一次。
 *
 * 只重做仪器层标了 `transport` 的失败：控制器答的错误（参数被锁、越界）重做一万次也一样；
 * 中止门的拒绝与测试替身的记录不带标记，原样放行。连接层对任何命令都不重发，
 * 这里是本仓唯一的一次重做（见 spec/deviations.md D-CONN-?）。两次尝试都经 `ctx.safeCall`，
 * 所以都进宿主的调用留痕。
 */
import { resendIsSafe, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'

/** 重做之前停多久：给控制器把手头那条做完。 */
export const IDEMPOTENT_RETRY_PAUSE_MS = 1_000

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

export async function callIdempotent(
  ctx: Pick<SkillContext, 'safeCall' | 'sleep'>,
  method: string,
  ...args: unknown[]
): Promise<SkillCallRecord> {
  const first = await ctx.safeCall(method, ...args)
  if (!failed(first) || first.transport === undefined) return first
  // 纵深防御：即使有人把每到一次就做一次事的命令包了进来，也不重做
  if (!resendIsSafe(method, args)) return first
  await ctx.sleep(IDEMPOTENT_RETRY_PAUSE_MS)
  const again = await ctx.safeCall(method, ...args)
  if (!failed(again)) return again
  // 英文后缀逐字照参考：第二次的原因在前，第一次的原因不丢
  return { ...again, error: `${again.error ?? ''} (retried once after a transport failure; first attempt: ${first.error ?? ''})` }
}
