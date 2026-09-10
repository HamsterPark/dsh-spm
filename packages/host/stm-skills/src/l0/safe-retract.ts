/**
 * `SafeRetract` —— 退针，**然后回读硬件确认它确实停在了收回位**。
 *
 * v1 抄过来的版本是这样的：
 *
 * ```python
 * record = context.safe_call("ZCtrl_Withdraw", 0, 1)
 * return SkillResult(..., data={"retracted": True})   # ← 命令发出去了，不是针退到了
 * ```
 *
 * `(0, 1)` = 不等待、1 ms 超时。命令一发出就报 `retracted: True`，
 * 而压电这时**还在往上爬**。
 *
 * `retracted` 是**三态**：`true` = 已确认，`false` = 回读到了但仍未到位，
 * `null` = 判不了。**绝不臆断为 true。**
 *
 * ## 两个「读不到」的处置相反
 *
 * - `retracted === false` ⇒ `success = false`：回读说了话，说的是「还没到」。
 * - `retracted === null` ⇒ `success = **true**` + 一句大声的「已下发未确认」。
 *   「读不到」被当成「出故障」是本仓在案的旧错（读不到被判成出故障，于是退了针）。
 *   **判据链断了不构成「退针失败」这个断言** —— 调用方要的区分在 `retracted` 里，
 *   不在 `success` 里。
 *
 * 轮询**不看 abort**：退针在 abort 之后也是放行的，而这几秒只读的确认恰恰是在
 * 确认那个 abort 想要的动作 —— 中途放弃只会丢掉证据，命令早已发出。
 * 预算有界（5 s）是这条成立的前提。
 */
import {
  NOT_PARKED,
  PARKED,
  isParked,
  parkEvidence,
  retryUseful,
  type ParkVerdict,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'
import { tipParked, type TipParkOptions } from './tip-park-read.js'

/** 确认预算。Withdraw 是快动作；**超时不代表失败，代表「没确认到」**。 */
const CONFIRM_BUDGET_MS = 5_000
const CONFIRM_POLL_MS = 250

export function makeSafeRetract(opts: TipParkOptions = {}): Skill {
  return {
    spec: S.SafeRetractSpec,
    execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
      // `ZCtrl_Withdraw(wait=0, timeout=1)` —— 不阻塞地下发，确认交给下面的回读。
      // （`WithdrawTip` 走的是另一半：`(1, -1)` 阻塞到仪器说走完。两个形状都在用，
      // 该收敛成一个 —— 收敛前别再抄第三份。）
      const rec = await ctx.safeCall('ZCtrl_Withdraw', 0, 1)
      if (rec.error !== undefined && rec.error !== '') {
        return fail(rec.error, {
          retracted: null,
          note: '退针命令没发出去(TCP 失败),更谈不上到位。',
        })
      }

      const t0 = ctx.now()
      let verdict: ParkVerdict
      // do-while：预算为 0 也**至少读一次**。一次都不读就等于把「没查」当答案。
      for (;;) {
        verdict = await tipParked(ctx, opts)
        if (verdict.state === PARKED) break
        // 配置缺口（如本机没声明 z_extend_sign）等多久都不会变 —— **立刻收工**，
        // 免得报出一个看起来像「超时」其实是「没人填过」的结论。
        if (!retryUseful(verdict)) break
        if (ctx.now() - t0 >= CONFIRM_BUDGET_MS) break
        await ctx.sleep(CONFIRM_POLL_MS)
      }
      const waitedS = (ctx.now() - t0) / 1000

      const park = {
        state: verdict.state,
        reason: verdict.reason,
        evidence: parkEvidence(verdict),
        feedback_on: verdict.feedback_on,
        module_status: verdict.module_status,
        z_m: verdict.z_m,
        rail_m: verdict.rail_m,
        gap_m: verdict.gap_m,
        tolerance_m: verdict.tolerance_m,
        unreadable: [...verdict.unreadable],
        undeclared: [...verdict.undeclared],
        read_at: verdict.read_at,
      }

      if (isParked(verdict)) {
        return ok(
          { retracted: true, park, confirm_waited_s: waitedS },
          `已确认退针到位（${parkEvidence(verdict)}）`,
        )
      }

      if (verdict.state === NOT_PARKED) {
        const msg =
          `退针已下发,但 ${waitedS.toFixed(1)} s 内没有确认到位:${verdict.reason}` +
          `（${parkEvidence(verdict)}）。可能还在走,也可能这条命令没生效 —— ` +
          `两种都没被排除,请复核后再做任何依赖「针已退开」的动作。`
        return { success: false, error: msg, summary: msg, data: { retracted: false, park, confirm_waited_s: waitedS } }
      }

      const msg =
        `退针**已下发未确认**:${verdict.reason}（${parkEvidence(verdict)}）。` +
        `命令发出去了,但判不了它到没到位 —— ` +
        `「判不了」既不是「退到了」也不是「没退到」。`
      return { success: true, data: { retracted: null, park, confirm_waited_s: waitedS }, summary: msg }
    },
  }
}

/** 默认实例：本机 `zExtendSign` **未声明**（旧仓当前状态）。 */
export const SafeRetract = makeSafeRetract()
