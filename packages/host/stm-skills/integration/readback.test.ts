/**
 * 写后回读，对**真 stmsim** 跑一遍 —— 这条缝是判据，不是补充覆盖率。
 *
 * ## 它照出来的那个 bug
 *
 * `SetZCtrlGain` / `SetSetpoint` 的回读比对我最早写成了**精确相等**，而旧仓用的是
 * `values_match`（相对容差 `1e-3`）。合成回包是**精确回显**，所以：
 *
 * - 轨迹金样全绿（`mismatch` 那一趟给的是一个明显不同的数，精确与近似都判不符）；
 * - 手写的技能网格也全绿（回包是我摆的）；
 * - 而真机上**每一次**写增益都会失败。
 *
 * Nanonis 在 TCP 上按 float32 打包，`3e-12` 回来是 `2.9999999880125916e-12`。
 * 2026-09-13 第一次把这两个技能接上真 stmsim，报文是：
 *
 * > 写后回读不一致 …… p_gain: 请求 3e-12, 读回 2.9999999880125916e-12(**相差 1 倍**)
 * > ……已还原为写入前的值。**不要进针、不要扫图**
 *
 * 「相差 1 倍」——那句话自己就说清了它在拒绝什么：什么都没差。
 *
 * 两套我自己造的回包都对，真东西上一次都不对。这就是 DoD ④ 要这条缝的理由。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { emptyHardwareState, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { SetSetpoint, SetZCtrlGain } from '../src/l0/writes-verified.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

/** `InstrumentService.call` 直接当 `ctx.safeCall` —— 中间没有任何转译。 */
function instrument(timeoutMs = 10_000): Promise<SkillContext> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      const inst = c.instrument as {
        call: (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>
      }
      const S0 = emptyHardwareState('stmsim')
      const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => inst.call(m, a)
      resolve({
        signal: new AbortController().signal,
        safeCall,
        emergencyCall: safeCall,
        runSkill: (n: string) => Promise.resolve({ success: false, error: `本夹具不分发子技能：${n}` }),
        now: () => Date.now() / 1000,
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        state: () => S0,
        refreshState: () => Promise.resolve(S0),
        markers: { emit: () => {} },
        depth: 0,
        owner: 'integration',
        rootCallId: 'readback',
        approvalSource: 'operator',
      } as unknown as SkillContext)
    })
  })
}

describe('对真 stmsim：float32 往返不该被判成「写后回读不一致」', () => {
  it('SetZCtrlGain 的三个数都是 p 量级，照样通过', async () => {
    const ctx = await instrument()
    const want = { p_gain: 3e-12, time_constant_s: 1e-4, i_gain: 3e-8 }
    const r = await SetZCtrlGain.execute(ctx, want)
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    const d = r.data as { readback_ok: boolean; readback: Record<string, number> }
    expect(d.readback_ok).toBe(true)
    // **回读的值确实不等于请求的值** —— 这一条是这组测试的要害：
    // 它证明上面那个 true 不是因为 stmsim 碰巧精确回显。
    expect(d.readback['p_gain']).not.toBe(want.p_gain)
    // 而**相对**误差在 1e-6 以内 —— float32 往返噪声实测 ~4e-9，
    // 容差 1e-3 在它之上六个数量级。用相对误差而不是 `toBeCloseTo`：
    // 后者是绝对精度，对 p 量级的数没有意义（它要求差 < 5e-21）。
    const rel = Math.abs(d.readback['p_gain']! / want.p_gain - 1)
    expect(rel).toBeGreaterThan(0)
    expect(rel).toBeLessThan(1e-6)
  })

  it('SetSetpoint 150 pA，照样通过', async () => {
    const ctx = await instrument()
    const r = await SetSetpoint.execute(ctx, { setpoint_a: 150e-12 })
    expect(r.error ?? '').toBe('')
    const d = r.data as { readback_ok: boolean; readback: number }
    expect(d.readback_ok).toBe(true)
    expect(d.readback).not.toBe(150e-12)
  })

})
