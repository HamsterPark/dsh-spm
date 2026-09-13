/**
 * 批 3f 接上**真 stmsim**。
 *
 * 三件事只有真东西答得了：
 *
 * 1. **`SetZLimits` 的「写 → 启用 → 读回」在真回包上闭不闭得上。** 它是这一族里
 *    形状最复杂的一个（四次调用、一个三态的 `enabled`、一次逐位比对），
 *    而合成回包是精确回显 —— 那条路上它永远对。
 * 2. **PLL 的读在真机上给的是什么形状。** 旧仓那十格在空 body 上抛 `IndexError`；
 *    本仓给一个值。真机既可能没装 PLL 模块（那就是 `NeedModule`），
 *    也可能装了而回包比我假设的短 —— 两种都得不炸。
 * 3. **脚本那道闸拦在硬件调用之前。** 白名单是空的时候，`RunNanonisScript`
 *    必须**一次 TCP 都不发**就拒 —— 这条只有在真的能发 TCP 的地方验才算数。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { emptyHardwareState, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { SetZLimits, SetWithdrawRate } from '../src/l0/limits.js'
import { GetPLLStatus, GetPLLAddOnOff, GetPLLSignalAnlzrFFTProps } from '../src/l0/pll.js'
import { ListNanonisScripts, RunNanonisScript, scriptAllowlistPath } from '../src/l0/nanonis-script.js'

const PORTS = [16501, 16502, 16503, 16504]

/** 白名单**故意不摆** —— 出厂状态就是空的，而空清单是这道闸的默认答案。 */
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-spm-int-script-'))
mkdirSync(join(ROOT, 'config'), { recursive: true })
scriptAllowlistPath.current = (): string => join(ROOT, 'config', 'nanonis_scripts.json')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

function instrument(timeoutMs = 10_000): Promise<{ ctx: SkillContext; calls: string[] }> {
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
      const calls: string[] = []
      const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
        calls.push(m)
        return inst.call(m, a)
      }
      resolve({
        calls,
        ctx: {
          signal: new AbortController().signal,
          safeCall,
          emergencyCall: safeCall,
          runSkill: (n: string) => Promise.resolve({ success: false, error: `本夹具不分发：${n}` }),
          now: () => Date.now(),
          sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
          state: () => S0,
          refreshState: () => Promise.resolve(S0),
          markers: { emit: () => {} },
          depth: 0,
          owner: 'integration',
          rootCallId: 'limits',
          approvalSource: 'operator',
        } as unknown as SkillContext,
      })
    })
  })
}

describe('对真 stmsim：Z 限值的「写 → 启用 → 读回」', () => {
  it('一对合法的限值：写下去、读回来、**逐位对得上**', async () => {
    const { ctx, calls } = await instrument()
    const r = await SetZLimits.execute(ctx, { z_high_limit_m: 5e-7, z_low_limit_m: -5e-7 })
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    // 四次调用的顺序本身是判据：先读旧值（为了 `widened`）、写、启用、再读
    expect(calls).toEqual([
      'ZCtrl_LimitsGet', 'ZCtrl_LimitsSet', 'ZCtrl_LimitsEnabledSet', 'ZCtrl_LimitsGet',
    ])
    const d = r.data as { verified: boolean; enabled: boolean | null; before: number[] | null }
    expect(d.verified).toBe(true)
    expect(d.enabled).toBe(true)
    // `before` 是真读回来的一对数（或者 null）—— 不是我摆的
    expect(d.before === null || d.before.length === 2).toBe(true)
  })

  it('`enable=false`：**读回启用状态，而且不自动启用**', async () => {
    const { ctx, calls } = await instrument()
    const r = await SetZLimits.execute(ctx, {
      z_high_limit_m: 4e-7, z_low_limit_m: -4e-7, enable: false,
    })
    expect(r.success).toBe(true)
    expect(calls).toContain('ZCtrl_LimitsEnabledGet')
    // 调用方说了 enable=false，悄悄做相反的事是它自己的 bug
    expect(calls).not.toContain('ZCtrl_LimitsEnabledSet')
    const enabled = (r.data as { enabled: boolean | null }).enabled
    expect(enabled === true || enabled === false || enabled === null).toBe(true)
  })

  it('退针速率：写后回读，`before` 是真值', async () => {
    const { ctx } = await instrument()
    const r = await SetWithdrawRate.execute(ctx, { rate_m_per_s: 2e-6 })
    expect(r.error ?? '').toBe('')
    const d = r.data as { verified: boolean; before: number | null; rate_m_per_s: number }
    expect(d.verified).toBe(true)
    expect(typeof d.rate_m_per_s).toBe('number')
  })
})

describe('对真 stmsim：PLL 的读**不炸**', () => {
  it('三个读：装了就给值，没装就给一句可执行的错 —— 两种都不抛', async () => {
    const { ctx } = await instrument()
    for (const skill of [GetPLLStatus, GetPLLAddOnOff, GetPLLSignalAnlzrFFTProps]) {
      const r = await skill.execute(ctx, {})
      // 旧仓这一族在空 body 上抛 IndexError（金样里十格记着 `raised`）。
      // 这里要的只有一条：**它是一个返回值，不是一次异常**。
      expect(typeof r.success).toBe('boolean')
      if (r.success) expect(r.data).toBeDefined()
      else expect(r.error ?? '').not.toBe('')
    }
  })

  it('`GetPLLStatus` **永远 success** —— 它报的是「问到了什么」', async () => {
    const { ctx } = await instrument()
    const r = await GetPLLStatus.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ modulator_index: 1 })
    // 读不到的那一组字段**不出现**（与「读到了 0」分得开）
    for (const [k, v] of Object.entries(r.data ?? {})) {
      expect(v, k).not.toBeNull()
    }
  })
})

describe('对真 stmsim：脚本那道闸拦在硬件调用之前', () => {
  it('白名单是空的 ⇒ 拒，**一次 TCP 都不发**', async () => {
    // 这条只有在真的能发 TCP 的地方验才算数：单测里「没发」和「发不出去」
    // 在调用记录上长得一样。
    const { ctx, calls } = await instrument()
    const r = await RunNanonisScript.execute(ctx, { slot: 3 })
    expect(r.success).toBe(false)
    expect(r.error).toContain('脚本白名单为空')
    expect(calls).toEqual([])
  })

  it('`ListNanonisScripts` 照样答得出来（它读的是文件，不是仪器）', async () => {
    const { ctx, calls } = await instrument()
    const r = await ListNanonisScripts.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ count: 0 })
    expect(calls).toEqual([])
  })
})
