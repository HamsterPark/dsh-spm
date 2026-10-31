/**
 * 宿主把仪器调用交给内核的两条出口：`safeCall`（缺省路径）与 `budgetedCall`（慢命令，带 recv 预算）。
 *
 * 传输层本来就收按调用的超时（`CallOptions.timeoutMs` → `RoleLink.request` → `roundTrip`）；
 * 缺的只是宿主一侧「秒 → 毫秒、并传 `{ timeoutMs }`」的适配，以及让这条路过同一道中止门。
 * 抽成独立模块是为了能单测：`minimal.ts` 的装配函数里没法单独拿到它。
 *
 * 两条出口共用同一个 `send`，所以宿主在 `send` 里做的事（原生模式的中止分支、留痕）两条路都有。
 */
import type { CallOptions, CallRecord } from 'dsh-spm-instrument'
import type { BudgetedCall, SafeCall } from 'dsh-spm-kernel'
import { gatedBudgetedCall, gatedSafeCall } from 'dsh-spm-stm-skills'

export interface InstrumentCallsDeps {
  /**
   * 真正发出一次调用（含宿主自己的中止分支与留痕）。`opts` 缺席 = 走传输层的缺省超时。
   */
  readonly send: (method: string, args: readonly unknown[], opts?: CallOptions) => Promise<CallRecord>
  /** 中止闩上了吗。两条出口都过同一道动词级中止门。 */
  readonly abortLatched: () => boolean
}

export interface InstrumentCalls {
  /** 缺省路径：**不带任何传输层选项**，传输层用它自己的缺省超时。 */
  readonly safeCall: SafeCall
  /** 慢命令：把 recv 超时抬到 `recvTimeoutS` 秒（内核已按上限夹过）。 */
  readonly budgetedCall: BudgetedCall
}

export function createInstrumentCalls(d: InstrumentCallsDeps): InstrumentCalls {
  // 只传两个实参：缺省路径一个字节都不碰传输层的超时。
  const safeCall = gatedSafeCall({
    abortLatched: d.abortLatched,
    call: (method, ...args) => d.send(method, args),
  })
  // 向上取整、至少 1 ms：`0` 毫秒的超时是立刻到期，不是「不限」。
  const budgetedCall = gatedBudgetedCall({
    abortLatched: d.abortLatched,
    call: (method, recvTimeoutS, ...args) =>
      d.send(method, args, { timeoutMs: Math.max(1, Math.ceil(recvTimeoutS * 1000)) }),
  })
  return { safeCall, budgetedCall }
}
