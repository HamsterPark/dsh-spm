/**
 * 批 3h 里**通用金样驱动不到**的格子。
 *
 * 三类：
 * 1. `QuitNanonis` / `WaitForScanEndBlocking` 的整张网格 —— 通用驱动器在前者上
 *    每一趟都停在「Z 反馈仍然闭合」，在后者上只录得到「扫描已结束」。
 *    这两张网格由 `spec/golden/advanced_ops.json` 驱动（专用导出器）。
 * 2. **留痕**（`ctx.markers`）—— 金样只录返回值。
 * 3. 那几条单位与类型的坎：周期不是频率、毫秒不是秒、整数不是浮点。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { emptyHardwareState, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { QuitNanonis, WaitForScanEndBlocking } from './advanced-ops.js'
import {
  ConfigureCalculatedOutput, PulseDigitalLine, SetUserOutput,
  SetUserOutputCalibration, SetUserOutputLimits, digitalLines,
} from './user-output.js'
import { ConfigureWaveform, StartWaveform } from './waveform.js'
import { SetPatternCloud } from './pattern.js'
import { firstInt } from './spectroscopy-sync.js'
import { sweepChannelNames, sweepRows } from './sweep.js'

interface Case {
  readonly params: Record<string, unknown>
  readonly calls: { verb: string; args: unknown[] }[]
  readonly success: boolean
  readonly error: string
  readonly summary: string
  readonly data: Record<string, unknown>
}
const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/advanced_ops.json', import.meta.url)),
    'utf8',
  ),
) as { quit: Record<string, Case>; wait: Record<string, Case> }

const S0 = emptyHardwareState('T0')
interface Marker { kind: string; data: Record<string, unknown> }

/** 与专用导出器 `_Ctx` 同形：按动词脚本化的回包。 */
function rig(opts: {
  zFeedback?: number | null
  fail?: Set<string>
  abortAfter?: number
  timeoutStatus?: number
  replies?: Record<string, unknown[]>
} = {}): { ctx: SkillContext; calls: { verb: string; args: unknown[] }[]; markers: Marker[] } {
  const calls: { verb: string; args: unknown[] }[] = []
  const markers: Marker[] = []
  let aborts = 0
  let clock = 1_000_000
  const zf = opts.zFeedback === undefined ? 0 : opts.zFeedback
  const signal = {
    get aborted(): boolean {
      aborts += 1
      return opts.abortAfter !== undefined && aborts > opts.abortAfter
    },
  } as AbortSignal
  const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
    calls.push({ verb: m, args: a })
    if (opts.fail?.has(m) === true) {
      return Promise.resolve({ method: m, args: a, error: '模拟故障：连接被对端关闭' })
    }
    if (opts.replies?.[m] !== undefined) {
      return Promise.resolve({ method: m, args: a, values: opts.replies[m] })
    }
    if (m === 'ZCtrl_OnOffGet') {
      return Promise.resolve({ method: m, args: a, values: zf === null ? [] : [zf] })
    }
    if (m === 'ZCtrl_SwitchOffDelayGet') {
      return Promise.resolve({ method: m, args: a, values: [0.1] })
    }
    if (m === 'Scan_WaitEndOfScan') {
      // 真的那一条会阻塞它被要求等的那段时间 —— 假钟也得跟着走
      clock += Math.max(Number(a[0]), 0)
      return Promise.resolve({ method: m, args: a, values: [opts.timeoutStatus ?? 0, 0, ''] })
    }
    return Promise.resolve({ method: m, args: a, values: [] })
  }
  const ctx = {
    signal, safeCall, emergencyCall: safeCall,
    now: () => clock,
    sleep: (ms: number) => { clock += ms; return Promise.resolve() },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: (k: string, d?: Record<string, unknown>) => markers.push({ kind: k, data: d ?? {} }) },
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
    depth: 0, owner: 't', rootCallId: 't', approvalSource: 'llm',
  } as unknown as SkillContext
  return { ctx, calls, markers }
}

const RIGS: Readonly<Record<string, Parameters<typeof rig>[0]>> = {
  ok: {},
  no_save: {},
  quit_no_response: { fail: new Set(['Util_Quit']) },
  scan_stop_failed: { fail: new Set(['Scan_Action']) },
  withdraw_failed: { fail: new Set(['ZCtrl_Withdraw']) },
  still_closed: { zFeedback: 1 },
  verify_unreadable: { zFeedback: null },
  verify_failed: { fail: new Set(['ZCtrl_OnOffGet']) },
}

describe('QuitNanonis —— 逐格对旧仓（专用金样）', () => {
  for (const [key, want] of Object.entries(golden.quit)) {
    it(`${key}：结局与报文都相等`, async () => {
      const r = rig(RIGS[key]!)
      const got = await QuitNanonis.execute(r.ctx, want.params)
      expect(got.success).toBe(want.success)
      expect(got.error ?? '').toBe(want.error)
      expect(got.summary ?? '').toBe(want.summary)
    })
  }

  it('**三步的顺序本身是判据**：停扫 → 退针 → 向实时控制器确认 → 才退出', async () => {
    const r = rig()
    await QuitNanonis.execute(r.ctx, {})
    const verbs = r.calls.map((c) => c.verb)
    expect(verbs[0]).toBe('Scan_Action')
    expect(verbs[1]).toBe('ZCtrl_Withdraw')
    // 确认那一步问的是 Z 反馈，而**不是**问模块的意见
    expect(verbs).toContain('ZCtrl_OnOffGet')
    expect(verbs[verbs.length - 1]).toBe('Util_Quit')
    // 确认在退出**之前**
    expect(verbs.indexOf('ZCtrl_OnOffGet')).toBeLessThan(verbs.indexOf('Util_Quit'))
  })

  it('退针失败 ⇒ **一次 `Util_Quit` 都不发**', async () => {
    const r = rig({ fail: new Set(['ZCtrl_Withdraw']) })
    const got = await QuitNanonis.execute(r.ctx, {})
    expect(got.success).toBe(false)
    expect(r.calls.map((c) => c.verb)).not.toContain('Util_Quit')
  })

  it('**确认不了也拒** —— `on=null` 不是 `on=false`（fail-closed）', async () => {
    // 测量链路的失败绝不能成为危险动作的触发条件。
    const r = rig({ zFeedback: null })
    const got = await QuitNanonis.execute(r.ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('无法确认 Z 反馈状态')
    expect(r.calls.map((c) => c.verb)).not.toContain('Util_Quit')
  })

  it('停扫失败**不拦着退针**，只留一条痕', async () => {
    const r = rig({ fail: new Set(['Scan_Action']) })
    const got = await QuitNanonis.execute(r.ctx, {})
    expect(got.success).toBe(true)
    expect(r.calls.map((c) => c.verb)).toContain('Util_Quit')
    expect(r.markers.some((m) => String(m.data['reason']).includes('停止扫描失败'))).toBe(true)
  })

  it('**退出没有回音不算失败** —— socket 是它自己拆的', async () => {
    const r = rig({ fail: new Set(['Util_Quit']) })
    const got = await QuitNanonis.execute(r.ctx, {})
    expect(got.success).toBe(true)
    expect(got.data).toMatchObject({ quit_sent: true, response: null, tip_retracted: true })
    // 既不报失败，也不假装收到了
    expect(String(got.summary)).toContain('未收到响应——这是正常的')
  })
})

const WAIT_RIGS: Readonly<Record<string, Parameters<typeof rig>[0]>> = {
  finished: { timeoutStatus: 0 },
  timed_out: { timeoutStatus: 1 },
  aborted: { timeoutStatus: 1, abortAfter: 2 },
  call_failed: { fail: new Set(['Scan_WaitEndOfScan']) },
}

describe('WaitForScanEndBlocking —— 逐格对旧仓（专用金样）', () => {
  for (const [key, want] of Object.entries(golden.wait)) {
    it(`${key}：结局、报文与调用次数都相等`, async () => {
      const r = rig(WAIT_RIGS[key]!)
      const got = await WaitForScanEndBlocking.execute(r.ctx, want.params)
      expect(got.success).toBe(want.success)
      expect(got.error ?? '').toBe(want.error)
      expect(got.summary ?? '').toBe(want.summary)
      expect(r.calls.length).toBe(want.calls.length)
    })
  }

  it('**`Scan_WaitEndOfScan` 收的是毫秒** —— 传秒会短等 1000 倍', async () => {
    const r = rig({ timeoutStatus: 1 })
    await WaitForScanEndBlocking.execute(r.ctx, { timeout_s: 10 })
    // 1 秒一片 ⇒ 每片 1000 ms，10 秒的预算正好 10 片
    expect(r.calls.every((c) => c.args[0] === 1000)).toBe(true)
    expect(r.calls.length).toBe(10)
  })

  it('中止时那句话必须说清楚：**扫描本身没有被停**', async () => {
    const r = rig({ timeoutStatus: 1, abortAfter: 2 })
    const got = await WaitForScanEndBlocking.execute(r.ctx, { timeout_s: 10 })
    expect(got.success).toBe(false)
    expect(got.error).toContain('**扫描本身没有被停**')
    expect(got.data).toMatchObject({ aborted: true })
  })

  it('等到上限是 **success + `timed_out: true`**，不是失败', async () => {
    const r = rig({ timeoutStatus: 1 })
    const got = await WaitForScanEndBlocking.execute(r.ctx, { timeout_s: 3 })
    expect(got.success).toBe(true)
    expect(got.data).toMatchObject({ timed_out: true })
  })

  it('**读不出超时位就当作「已结束」** —— 反过来猜会把一次读故障变成长等待', async () => {
    const r = rig({ replies: { Scan_WaitEndOfScan: [] } })
    const got = await WaitForScanEndBlocking.execute(r.ctx, { timeout_s: 100 })
    expect(got.success).toBe(true)
    expect(got.data).toMatchObject({ timed_out: false })
    expect(r.calls.length).toBe(1)
  })
})

// ── 用户输出：安全包络由仪器给 ─────────────────────────────────────────────

describe('SetUserOutput —— 本仓不发明包络，它遵守仪器上那一个', () => {
  it('界内放行，界外拒，**两端都是闭的**', async () => {
    for (const [value, okExpected] of [[0.25, true], [0.5, true], [0.3, true],
      [0.2499, false], [0.5001, false]] as const) {
      const r = rig({ replies: { UserOut_LimitsGet: [0.5, 0.25] } })
      const got = await SetUserOutput.execute(r.ctx, { output_index: 1, value })
      expect(got.success, String(value)).toBe(okExpected)
    }
  })

  it('**限值读不到就不写** —— 未知的边界不等于没有边界', async () => {
    const r = rig({ fail: new Set(['UserOut_LimitsGet']) })
    const got = await SetUserOutput.execute(r.ctx, { output_index: 1, value: 0.3 })
    expect(got.success).toBe(false)
    expect(got.error).toContain('未知的边界不等于没有边界')
    // **一次写都不发**
    expect(r.calls.map((c) => c.verb)).not.toContain('UserOut_ValSet')
  })

  it('仪器给的一对**不保证谁大谁小**，自己排序', async () => {
    // 上下颠倒的配置不该让每一次写入都被判成越界
    const r = rig({ replies: { UserOut_LimitsGet: [0.25, 0.5] } })
    const got = await SetUserOutput.execute(r.ctx, { output_index: 1, value: 0.4 })
    expect(got.success).toBe(true)
    expect(got.data).toMatchObject({ limits: { lower: 0.25, upper: 0.5 } })
  })
})

describe('SetUserOutputLimits —— 放宽合法，但要留痕', () => {
  it('`widened` 与留痕一起出现', async () => {
    const r = rig({ replies: { UserOut_LimitsGet: [1, -1] } })
    await SetUserOutputLimits.execute(r.ctx, {
      output_index: 2, upper_limit: 5, lower_limit: -5,
    })
    const note = r.markers.find((m) => m.kind === 'note')
    expect(note?.data).toMatchObject({ subject: 'UserOut[2].limits', widened: true })
    expect(String(note?.data['reason'])).toContain('护栏被放宽')
  })

  it('收紧不算放宽', async () => {
    const r = rig({ replies: { UserOut_LimitsGet: [5, -5] } })
    await SetUserOutputLimits.execute(r.ctx, {
      output_index: 2, upper_limit: 1, lower_limit: -1,
    })
    expect(r.markers[0]?.data['widened']).toBe(false)
    expect(String(r.markers[0]?.data['reason'])).toContain('护栏被调整')
  })

  it('颠倒的一对**换过来** —— 同一个量的两端，谁写在前面不改变意思', async () => {
    const r = rig({ replies: { UserOut_LimitsGet: [1, -1] } })
    const got = await SetUserOutputLimits.execute(r.ctx, {
      output_index: 2, upper_limit: -3, lower_limit: 3,
    })
    expect(got.data).toMatchObject({ upper_limit: 3, lower_limit: -3 })
  })

  it('改标定也留痕 —— 它**重新解释了这一路上的每一个数**', async () => {
    const r = rig()
    await SetUserOutputCalibration.execute(r.ctx, {
      output_index: 3, calibration_per_volt: 2, offset: 0,
    })
    expect(String(r.markers[0]?.data['reason'])).toContain('所有限值按新单位重新解释')
  })
})

describe('ConfigureCalculatedOutput —— 配置成了、命名失败，说哪一半成了', () => {
  it('命名失败**不把整件事报成失败**', async () => {
    const r = rig({ fail: new Set(['UserOut_CalcSignalNameSet']) })
    const got = await ConfigureCalculatedOutput.execute(r.ctx, {
      output_index: 1, signal_1: 0, signal_2: 1, operation: '-', name: 'diff',
    })
    // 报成失败会让调用方把已经生效的配置再下发一遍
    expect(got.success).toBe(true)
    expect(got.data?.['name']).toBeNull()
    expect(String(got.data?.['warning'])).toContain('配置已生效，但命名失败')
  })

  it('认不出的运算符就拒，**一次调用都不发**', async () => {
    const r = rig()
    const got = await ConfigureCalculatedOutput.execute(r.ctx, {
      output_index: 1, signal_1: 0, signal_2: 1, operation: '^',
    })
    expect(got.success).toBe(false)
    expect(r.calls).toEqual([])
  })
})

describe('数字线：1..8 是端口内的行号', () => {
  it('越界的那一条不是「多脉冲一路」，是另一个端口上的线', async () => {
    const r = rig()
    const got = await PulseDigitalLine.execute(r.ctx, {
      port: 0, lines: '1,9', pulse_width_s: 0.001,
    })
    expect(got.success).toBe(false)
    expect(got.error).toBe('digital line 必须在 1..8 之间，收到 [1, 9]')
    expect(r.calls).toEqual([])
  })

  it('`digitalLines` 严格到整数', () => {
    expect(digitalLines('1,2')).toEqual([1, 2])
    expect(digitalLines('1 2')).toEqual([1, 2])
    expect(digitalLines('1.5')).toBeNull()
    expect(digitalLines('x')).toBeNull()
    expect(digitalLines('')).toEqual([])
  })
})

// ── 单位与类型的三条坎 ─────────────────────────────────────────────────────

describe('ConfigureWaveform —— 双通道收的是**周期**，不是频率', () => {
  it('1 kHz ⇒ 周期 1 ms（差六个数量级的那一行）', async () => {
    const r = rig()
    const got = await ConfigureWaveform.execute(r.ctx, {
      generator: '2ch', amplitude: 1, frequency_hz: 1000, shape: 'sine',
    })
    const props = r.calls.find((c) => c.verb === 'FunGen2Ch_PropsSet')
    expect(props?.args[2]).toBe(1e-3)
    expect(got.data).toMatchObject({ period_s: 1e-3, frequency_hz: 1000 })
  })

  it('单通道**直接收频率** —— 同一个参数名，两台机器两种量', async () => {
    const r = rig()
    await ConfigureWaveform.execute(r.ctx, {
      generator: '1ch', amplitude: 1, frequency_hz: 1000,
    })
    expect(r.calls[0]?.args[1]).toBe(1000)
  })

  it('认不出的波形 / 发生器就拒', async () => {
    for (const p of [
      { generator: '3ch', amplitude: 1, frequency_hz: 1 },
      { generator: '2ch', amplitude: 1, frequency_hz: 1, shape: 'noise' },
    ]) {
      const r = rig()
      expect((await ConfigureWaveform.execute(r.ctx, p)).success, JSON.stringify(p)).toBe(false)
    }
  })

  it('`periods = 0` 是**连续输出**，不是「跑零个周期」', async () => {
    const r = rig()
    const got = await StartWaveform.execute(r.ctx, { generator: '1ch', periods: 0 })
    expect(got.data).toMatchObject({ mode: 'continuous' })
    const b = rig()
    expect((await StartWaveform.execute(b.ctx, { generator: '1ch', periods: 5 })).data)
      .toMatchObject({ mode: 'burst' })
  })
})

describe('SetPatternCloud —— 合法的 JSON 还不够', () => {
  it('**`"5"` 解得干干净净**，然后在下一行炸掉 —— 所以这里拦住它', async () => {
    // 模型少写一对方括号是最可能的那个错，而旧仓那一版在这里抛 TypeError：
    // 到不了 SkillResult，没有错误分支、没有重试，一个死掉的回合。
    const r = rig()
    const got = await SetPatternCloud.execute(r.ctx, { x_coords: '5', y_coords: '5' })
    expect(got.success).toBe(false)
    expect(got.error).toContain('必须是 JSON 数组')
    expect(got.error).toContain('单个点也要写成数组')
    expect(r.calls).toEqual([])
  })

  it('长度不等就拒', async () => {
    const r = rig()
    const got = await SetPatternCloud.execute(r.ctx, {
      x_coords: '[1,2]', y_coords: '[3]',
    })
    expect(got.success).toBe(false)
    expect(r.calls).toEqual([])
  })

  it('真的数组放行', async () => {
    const r = rig()
    const got = await SetPatternCloud.execute(r.ctx, {
      x_coords: '[1e-9, 2e-9]', y_coords: '[3e-9, 4e-9]',
    })
    expect(got.success).toBe(true)
    expect(r.calls[0]?.args).toEqual([1, 2, [1e-9, 2e-9], [3e-9, 4e-9]])
  })
})

describe('firstInt —— 只认整数，不认浮点', () => {
  it('浮点回来是**没问出来**，不是一个状态', () => {
    // 收下浮点会让一个读不懂的回包变成一句确定的「没在跑」。
    expect(firstInt([0.25])).toBeNull()
    expect(firstInt([1])).toBe(1)
    expect(firstInt([[[3]]])).toBe(3)
    expect(firstInt([true])).toBe(1)
    expect(firstInt([])).toBeNull()
    expect(firstInt(['x'])).toBeNull()
  })
})

describe('扫频回包：曲线在 Variables[5]，通道名在 [2]', () => {
  const rec = (values: unknown[]): SkillCallRecord => ({ method: '', args: [], values })

  it('二维数组逐行取出来，**第一行是被扫的那路信号**', () => {
    const r = rec([2, 2, ['Bias', 'Current'], 2, 3, [[0, 1, 2], [9, 8, 7]]])
    expect(sweepRows(r)).toEqual([[0, 1, 2], [9, 8, 7]])
    expect(sweepChannelNames(r)).toEqual(['Bias', 'Current'])
  })

  it('**取不到可解的数组就给 `null`** —— 不编一个空数组冒充「扫到了，是平的」', () => {
    expect(sweepRows(rec([1, 2, [], 0, 0]))).toBeNull()
    expect(sweepRows(rec([1, 2, [], 0, 0, []]))).toBeNull()
    expect(sweepChannelNames(rec([1, 2]))).toBeNull()
  })

  it('表头那两个整数**不是曲线** —— 旧仓取的正是它们', () => {
    const r = rec([2, 2, ['a', 'b'], 1, 3, [[5, 6, 7]]])
    expect(sweepRows(r)).toEqual([[5, 6, 7]])
    expect(sweepRows(r)).not.toEqual([2, 2])
  })
})
