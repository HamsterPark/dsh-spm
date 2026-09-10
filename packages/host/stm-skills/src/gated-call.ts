/**
 * `safeCall` 的**动词级中止门** —— 「正在做的收得了尾」那一层。
 *
 * 中止是**两层**的，管的是两件不同的事：
 *
 * | 层 | 位置 | 管什么 |
 * |---|---|---|
 * | 工具入口 | 内核 K2 + `stm-safety` 的 guard | **别开新的**：模型不许在中止后再起一个技能 |
 * | 动词 | 这里 | **正在做的收得了尾**：已经在跑的技能仍然发得出退针与停扫 |
 *
 * 少了这一层的后果是具体的：一次中止落在某个技能的中段时，它自己的清理动作
 * （退针、停扫）会被自己触发的那道闸拒掉 —— **人按了中止，针却留在原地**。
 *
 * 判据来自 `ABORT_SAFE_WRITES`（24 条），它按 **Nanonis 动词**索引，
 * 而且**带参数**：`Scan_Action(1, …)` 是停扫、放行；`Scan_Action(0, …)` 是**起扫**、
 * 拒。一个只看动词名的白名单会把起扫也放过去。
 *
 * 读一律放行 —— 中止之后最该做的事就是搞清楚现在是什么状况。
 */
import { isAbortSafe, isReadVerb, type SafeCall, type SkillCallRecord } from 'dsh-spm-kernel'

export interface GatedCallOptions {
  /** 底层的调用出口（通常是 `ctx.instrument.call` 的适配）。 */
  readonly call: SafeCall
  /** 中止闩上了吗。 */
  readonly abortLatched: () => boolean
}

/**
 * 包一层动词级的中止门。**返回记录，不抛** —— 与 `safeCall` 的约定一致：
 * 抛出去会绕过技能里所有按 `record.error` 判的分支，也绕过调用的记账。
 */
export function gatedSafeCall(opts: GatedCallOptions): SafeCall {
  return (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    if (!opts.abortLatched()) return opts.call(method, ...args)
    // 读永远放行：中止之后最该做的事就是搞清楚现在是什么状况。
    if (isReadVerb(method)) return opts.call(method, ...args)
    if (isAbortSafe(method, args)) return opts.call(method, ...args)
    return Promise.resolve({
      method,
      args,
      error:
        `abort_latched: 中止已闩上——'${method}' 不在中止安全名单里，拒绝下发。` +
        `退针（ZCtrl_Withdraw）与停扫（Scan_Action(1,…)）仍然可发。`,
    })
  }
}
