/**
 * 批 5b 的**手写边角** —— 金样那 71 格走不到的那几条。
 *
 * 这个文件只放两类：
 *
 * 1. **「0 与没给」分得开吗**（D-ZERO-1 一族）。一个合法的 `0` 被 `x || 缺省`
 *    吃掉，症状是「我设了它，可它没生效」，而没有任何一处报错。
 *    这一批里有**五个**这样的口子，其中三个旧仓自己就是 `or` ——
 *    那三个照移，而**照移也要有测试**：不然下一个人会以为它是个 bug 顺手修掉。
 * 2. 金样那台脚本化驱动器排不出来的形状（缓冲里根本没有 Z 通道）。
 *
 * ⚠️ 这里**不重复**金样已经钉住的东西。判决、文案、序列全在 `batch5b.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import {
  emptyHardwareState,
  slowCallFrom,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { IMPLEMENTED } from './index.js'
import { MONITOR_SLEEP_CAP_MS } from './current-monitor.js'
import { MAX_MISSES, MIN_SAMPLES, POLL_MS } from './thermal-settle.js'

const S0 = emptyHardwareState('T0')

interface Harness {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
  runs: { skill: string; params: Record<string, unknown> }[]
}

/** 一个最小夹具：动词与子技能的回答都由一个函数给。 */
function harness(
  onVerb: (verb: string, args: unknown[]) => SkillCallRecord,
  onRun: (skill: string, params: Record<string, unknown>, i: number) => SkillResultLike,
): Harness {
  const calls: { verb: string; args: unknown[] }[] = []
  const runs: { skill: string; params: Record<string, unknown> }[] = []
  let clock = 1_000_000
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    if (calls.length > 5000) throw new Error(`调用预算用尽（${method}）`)
    calls.push({ verb: method, args })
    return Promise.resolve(onVerb(method, args))
  }
  const ctx: SkillContext = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: slowCallFrom(safeCall, (m, _t, ...a) => safeCall(m, ...a)),
    now: () => (clock += 1),
    sleep: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'edges',
    rootCallId: 'edges',
    approvalSource: 'llm',
    runSkill: (n, p) => {
      const i = runs.length
      runs.push({ skill: n, params: { ...p } })
      return Promise.resolve(onRun(n, { ...p }, i))
    },
  }
  return { ctx, calls, runs }
}

const skill = (n: string): Skill => IMPLEMENTED[n] as Skill

const body = (method: string, values: unknown[]): SkillCallRecord => ({ method, args: [], values })

// ──────────────────────────────────────────────────────────────────────────

describe('D-ZERO-1 一族：`0` 与「没给」必须分得开', () => {
  it('WatchScanLines：`max_lines = 0` 是**不限**，不是「一条都不看」', async () => {
    const frame = [
      [1e-9, 2e-9, 3e-9],
      [2e-9, 3e-9, 4e-9],
      [3e-9, 4e-9, 5e-9],
    ]
    const reply = (m: string): SkillCallRecord => {
      if (m === 'Scan_BufferGet') return body(m, [2, [0, 30], 3, 3])
      if (m === 'Signals_NamesGet') return body(m, [10, 2, ['Current (A)', 'Z (m)']])
      if (m === 'Scan_FrameGet') return body(m, [0, 0, 3e-9, 3e-9, 0])
      return body(m, [1, 'Z', 3, 3, frame, 1])
    }
    const h = harness(reply, () => ({ success: true }))
    const got = await skill('WatchScanLines').execute(h.ctx, {
      direction: 1,
      since_line: -1,
      max_lines: 0,
    })
    expect(got.success).toBe(true)
    expect((got.data as Record<string, unknown>)['n_lines_measured']).toBe(3)
  })

  it('WatchScanLines：`since_line = 0` 是一个**游标**，`-1` 才是「没给」', async () => {
    const frame = [
      [1e-9, 2e-9, 3e-9],
      [2e-9, 3e-9, 4e-9],
      [0, 0, 0],
    ]
    const reply = (m: string): SkillCallRecord => {
      if (m === 'Scan_BufferGet') return body(m, [2, [0, 30], 3, 3])
      if (m === 'Signals_NamesGet') return body(m, [10, 2, ['Current (A)', 'Z (m)']])
      if (m === 'Scan_FrameGet') return body(m, [0, 0, 3e-9, 3e-9, 0])
      return body(m, [1, 'Z', 3, 3, frame, 1])
    }
    const withCursor = await skill('WatchScanLines').execute(
      harness(reply, () => ({ success: true })).ctx,
      { direction: 1, since_line: 0 },
    )
    const noCursor = await skill('WatchScanLines').execute(
      harness(reply, () => ({ success: true })).ctx,
      { direction: 1, since_line: -1 },
    )
    // 给了游标 ⇒ 它必须回答「还在不在推进」；没给 ⇒ 这个问题**没有答案**，是 null。
    expect((withCursor.data as Record<string, unknown>)['advancing']).toBe(true)
    expect((withCursor.data as Record<string, unknown>)['n_lines_new']).toBe(1)
    expect((noCursor.data as Record<string, unknown>)['advancing']).toBeNull()
    expect((noCursor.data as Record<string, unknown>)['n_lines_new']).toBe(2)
  })

  it('WaitForThermalSettle：`max_temp_k = 0` 是**一条真阈值**（谁都过不了），不是「不管」', async () => {
    // 温度 4.3 K、速率已经稳；只有绝对值这一条能拦下它。
    const series = [4.35, 4.349, 4.3485, 4.348, 4.3478, 4.3477, 4.3476]
    const run = (_n: string, _p: Record<string, unknown>, i: number): SkillResultLike => ({
      success: true,
      data: { value_k: series[Math.min(i, series.length - 1)] as number },
    })
    const gated = await skill('WaitForThermalSettle').execute(
      harness(() => body('x', []), run).ctx,
      { max_temp_k: 0, timeout_s: POLL_MS / 100, window: MIN_SAMPLES + 1 },
    )
    const open = await skill('WaitForThermalSettle').execute(
      harness(() => body('x', []), run).ctx,
      { timeout_s: 3600, window: MIN_SAMPLES + 1 },
    )
    expect(gated.success).toBe(false)
    expect((gated.data as Record<string, unknown>)['settled']).toBe(false)
    expect(open.success).toBe(true)
    expect((open.data as Record<string, unknown>)['settled']).toBe(true)
    // 「没给」在结果里也说得出来：`max_temp_k` 是 null 而不是某个编出来的数。
    expect((open.data as Record<string, unknown>)['max_temp_k']).toBeNull()
  })

  it('BiasSettleChange：`settle_s = 0` 就是**不等**，不退回缺省的 2 s', async () => {
    const reply = (m: string): SkillCallRecord =>
      m === 'Bias_Get' ? body(m, [1.0]) : body(m, [1])
    const h = harness(reply, () => ({ success: true, data: {} }))
    const got = await skill('BiasSettleChange').execute(h.ctx, { bias_v: 3.0, settle_s: 0 })
    expect((got.data as Record<string, unknown>)['settle_s']).toBe(0)
    expect(got.summary).toContain('稳定 0 s')
  })
})

describe('照移的三处 `or`：**`0` 退回缺省**，而这是旧仓的行为不是本仓的 bug', () => {
  it('RecoverTipFromSaturation：`max_coarse_steps = 0` 退回 800，不是「一步都不许走」', async () => {
    let step = 0
    const run = (n: string): SkillResultLike => {
      if (n === 'GetCurrent') {
        step += 1
        // 前三次（预检）与之后一直饱和 —— 于是阶梯会一直走到预算用完。
        return { success: true, data: { current_a: 1.00036e-8 } }
      }
      return { success: true, data: {} }
    }
    const h = harness(() => body('x', []), run)
    const got = await skill('RecoverTipFromSaturation').execute(h.ctx, { max_coarse_steps: 0 })
    expect(step).toBeGreaterThan(0)
    // 800 的预算吃得下整条阶梯（20+30+50+100+200+400 = 800）
    expect((got.data as Record<string, unknown>)['coarse_steps_used']).toBe(800)
  })

  it('ClassifyUnexplainedCurrent：`repeats = 0` 退回 3 次取中位', async () => {
    const runs: string[] = []
    const run = (n: string): SkillResultLike => {
      runs.push(n)
      if (n === 'GetCurrent') return { success: true, data: { current_a: 1e-12 } }
      if (n === 'GetZControllerState') return { success: true, data: {} }
      return { success: true, data: {} }
    }
    const h = harness(() => body('x', []), run)
    await skill('ClassifyUnexplainedCurrent').execute(h.ctx, {
      test_biases_v: '2.0,0.0',
      repeats: 0,
    })
    // 饱和预检那一轮读了 3 次（不是 0 次、也不是 1 次）
    expect(runs.filter((r) => r === 'GetCurrent')).toHaveLength(3)
  })

  it('WaitForThermalSettle：`window = 0` 退回 6，且**不低于** MIN_SAMPLES', async () => {
    const run = (): SkillResultLike => ({ success: true, data: { value_k: 4.3 } })
    const h = harness(() => body('x', []), run)
    const got = await skill('WaitForThermalSettle').execute(h.ctx, {
      window: 0,
      timeout_s: 3600,
    })
    // 恒温序列 ⇒ 速率 0 ⇒ 一满 MIN_SAMPLES 点就判稳
    expect(got.success).toBe(true)
    expect((got.data as Record<string, unknown>)['n_samples']).toBe(MIN_SAMPLES)
  })
})

describe('睡眠上限：它的产物是**中止检查的机会**，不是采到的那几个数', () => {
  it('MonitorCurrent：一拍 50 ms 要分成好几觉睡，而不是一口气睡到下一拍', async () => {
    // ⚠️ 这道闸在金样上**看不见**：分片睡与一口气睡，最后落在同一个时刻上
    // （`min(剩余, 上限)` 的和就是剩余），于是 `timestamps_s` 与 `n_samples`
    // 一模一样。它真正的产物是「这一拍里 `signal.aborted` 被问了几次」——
    // 一个 60 秒窗口的监控，一口气睡过去就意味着中止要等到下一拍才生效。
    //
    // 所以这一条**直接数睡眠次数**：那正是被拆掉时会消失的东西。
    let clock = 1_000_000
    let sleeps = 0
    const naps: number[] = []
    const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> =>
      Promise.resolve({ method, args, values: [1e-11] })
    const ctx = {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      slowCall: slowCallFrom(safeCall, (m, _t, ...a) => safeCall(m, ...a)),
      now: () => (clock += 1),
      sleep: (ms: number) => {
        sleeps += 1
        naps.push(ms)
        clock += ms
        return Promise.resolve()
      },
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'edges',
      rootCallId: 'edges',
      approvalSource: 'llm',
      runSkill: () => Promise.resolve({ success: true }),
    } as unknown as SkillContext
    const got = await skill('MonitorCurrent').execute(ctx, {
      duration_s: 0.2,
      poll_hz: 20.0,
      contact_threshold_a: 1e-3,
    })
    expect(got.success).toBe(true)
    const n = (got.data as Record<string, unknown>)['n_samples'] as number
    expect(n).toBe(4) // 0.2 s / 50 ms
    // 每一拍要睡 ≥ 4 觉（50 ms 拆成 10/10/10/10/余），也就是每拍至少四次中止检查。
    expect(sleeps).toBeGreaterThanOrEqual(4 * (n - 1))
    // 而**没有任何一觉超过上限** —— 那正是「上限」这两个字的内容。
    expect(Math.max(...naps)).toBeLessThanOrEqual(MONITOR_SLEEP_CAP_MS)
  })
})

describe('金样那台驱动器排不出来的形状', () => {
  it('WatchScanLines：缓冲里**只有电流**时拒绝，并说清缓冲里有哪些', async () => {
    const reply = (m: string): SkillCallRecord => {
      if (m === 'Scan_BufferGet') return body(m, [1, [0], 8, 8])
      if (m === 'Signals_NamesGet') return body(m, [10, 1, ['Current (A)']])
      return body(m, [0, 0, 8e-9, 8e-9, 0])
    }
    const h = harness(reply, () => ({ success: true }))
    const got = await skill('WatchScanLines').execute(h.ctx, { direction: 1 })
    expect(got.success).toBe(false)
    expect(got.error).toContain('找不到 Z 通道')
    // **一次帧抓取都不发** —— 通道号不知道的时候去抓帧，得到的是一个对不齐的回包
    expect(h.calls.map((c) => c.verb)).not.toContain('Scan_FrameDataGrab')
  })

  it('WaitForThermalSettle：**读得到又读不到**交替时 `misses` 会清零', async () => {
    // 4 次读不到 → 1 次读到 → 又 4 次读不到：`MAX_MISSES` 是**连续**的，
    // 所以这一串不该触发放弃（它只该在超时那一条上结束）。
    const pattern = [null, null, null, null, 4.2, null, null, null, null]
    const run = (_n: string, _p: Record<string, unknown>, i: number): SkillResultLike => {
      const v = pattern[Math.min(i, pattern.length - 1)]
      return { success: true, data: v === null ? {} : { value_k: v } }
    }
    const h = harness(() => body('x', []), run)
    const got = await skill('WaitForThermalSettle').execute(h.ctx, {
      timeout_s: (POLL_MS / 1000) * 9,
    })
    expect(got.success).toBe(false)
    // 走的是**超时**那一句，不是「连续 N 次读不到」那一句
    expect(got.error).toContain('仍未稳')
    expect(got.error).not.toContain(`连续 ${MAX_MISSES} 次`)
  })
})
