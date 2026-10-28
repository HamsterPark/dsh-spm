/**
 * `gatedBudgetedCall` —— 带 recv 预算的那条路，过的是 `gatedSafeCall` 同一道中止门。
 *
 * `budgetedCall` 是绕过 `safeCall` 的第二条路。这里钉三件事：
 *   1. 闩上之后，起扫（`ZSpectr_Start`）被拒，而且**底层一次都没被调用**；
 *   2. 放行的（读、中止安全写）把预算原样作为第二个参数转交；
 *   3. 放行/拒绝与 `gatedSafeCall` 在同一张 `(动词, 实参)` 表上逐条一致 —— 钉住「同一道门，
 *      不是第二份判据」。
 *
 * 变异 `gated-budgeted-call-same-gate` 的见证在这里（运行器只在变异文件所在的 scope 里找见证，
 * bundle 里的适配器测试它看不到）。
 */
import { describe, expect, it } from 'vitest'
import type { BudgetedCall, SafeCall } from 'dsh-spm-kernel'
import { gatedBudgetedCall, gatedSafeCall } from './gated-call.js'

/** 底层出口：记下被调用时收到的全部实参（预算版是 method, recvTimeoutS, ...args）。 */
function spies() {
  const budgetedSeen: unknown[][] = []
  const plainSeen: unknown[][] = []
  const budgeted: BudgetedCall = (method, recvTimeoutS, ...args) => {
    budgetedSeen.push([method, recvTimeoutS, ...args])
    return Promise.resolve({ method, args, values: [] })
  }
  const plain: SafeCall = (method, ...args) => {
    plainSeen.push([method, ...args])
    return Promise.resolve({ method, args, values: [] })
  }
  return { budgetedSeen, plainSeen, budgeted, plain }
}

describe('gatedBudgetedCall · 套的是 gatedSafeCall 那同一道中止门', () => {
  it('G1 闩上 ⇒ 起扫被拒：`abort_latched:` 开头，底层 0 次调用，拒绝记录的 args 不含预算', async () => {
    const s = spies()
    const call = gatedBudgetedCall({ call: s.budgeted, abortLatched: () => true })
    const rec = await call('ZSpectr_Start', 120, 1, '')
    expect(rec.error).toMatch(/^abort_latched:/)
    expect(s.budgetedSeen).toEqual([])
    expect(rec.method).toBe('ZSpectr_Start')
    // 预算不是实参：记录里只有调用方给的那两个
    expect(rec.args).toEqual([1, ''])
  })

  it('G2 闩上 ⇒ 读与中止安全写放行，预算原样作为第二个参数转交', async () => {
    const s = spies()
    const call = gatedBudgetedCall({ call: s.budgeted, abortLatched: () => true })
    // 读永远放行；`ZSpectr_Stop` 在 ABORT_SAFE_WRITES 里，不限实参
    expect((await call('ZSpectr_PropsGet', 7)).error).toBeUndefined()
    expect((await call('ZSpectr_Stop', 9)).error).toBeUndefined()
    expect(s.budgetedSeen).toEqual([
      ['ZSpectr_PropsGet', 7],
      ['ZSpectr_Stop', 9],
    ])
  })

  it('G3 没闩 ⇒ 方法、预算、实参按序原样转交，什么都不拦', async () => {
    const s = spies()
    const call = gatedBudgetedCall({ call: s.budgeted, abortLatched: () => false })
    const rec = await call('ZSpectr_Start', 855, 1, 'Fe_atom')
    expect(rec.error).toBeUndefined()
    expect(s.budgetedSeen).toEqual([['ZSpectr_Start', 855, 1, 'Fe_atom']])
  })

  it('G4 与 gatedSafeCall 对拍：闩上时，同一张 (动词, 实参) 表上放行/拒绝逐条一致', async () => {
    const table: readonly (readonly [string, readonly unknown[]])[] = [
      ['ZSpectr_PropsGet', []], // 读
      ['BiasSpectr_TimingGet', []], // 读
      ['ZSpectr_Stop', []], // 中止安全写，不限实参
      ['ZCtrl_Withdraw', [1, -1]], // 退针
      ['Scan_Action', [1, 0]], // 重载动词：停扫放行
      ['Scan_Action', [0, 0]], // 重载动词：起扫拒
      ['ZSpectr_Start', [1, '']], // 起扫拒
      ['BiasSpectr_Start', [1, '']], // 起扫拒
      ['ZSpectr_Open', []], // 一般写拒
      ['Motor_StartMove', [0, 100, 0, 1]], // 运动拒
      ['Bias_Set', [0.5]], // 一般写拒
    ]
    const s = spies()
    const plain = gatedSafeCall({ call: s.plain, abortLatched: () => true })
    const budgeted = gatedBudgetedCall({ call: s.budgeted, abortLatched: () => true })
    let allowed = 0
    let refused = 0
    for (const [method, args] of table) {
      const a = await plain(method, ...args)
      const b = await budgeted(method, 30, ...args)
      expect(b.error === undefined, `${method}(${JSON.stringify(args)}) 放行与否应与 gatedSafeCall 一致`).toBe(
        a.error === undefined,
      )
      // 被拒时，连文案都是同一份
      expect(b.error).toBe(a.error)
      if (a.error === undefined) allowed += 1
      else refused += 1
    }
    // 两种结局都得出现，否则「一致」可能只是两边一律放行
    expect(allowed).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
  })
})
