/**
 * 批 3j 里**通用金样驱动不到**的格子。
 *
 * 通用驱动器给的是常数回包（电流与 Z 恒为 0.25），于是这三个技能在金样里只走得到
 * 一条路：没噪声、Δz 恒为 0、电流从没升上去。**这一族真正要做的那件事一格都没录到**
 * ——一发扎针到底有没有在表面上留下东西。
 *
 * 所以这里摆一台**会动的机器**：z 在开火之后跳上去，电流先饱和再回到 setpoint。
 * 判据本体的逐格验收在 `kernel/src/z-trace.test.ts`（对 `spec/golden/z_trace.json`）；
 * 这里验的是**技能这一层**：采集循环、落盘、摘要、以及几条只有夹具能造出来的失败。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import {
  BiasPulseWithReadback,
  CaptureSignalBuffer,
  TipShapeWithReadback,
  processTraceDeps,
  stageBoundaries,
} from './readback-skills.js'
import {
  TRACE_SCHEMA,
  captureIsEmpty,
  channelBlock,
  saveTrace,
  scalar,
  stats,
  traceRef,
  type ReadbackCapture,
} from './readback-stream.js'
import { resolvedLiftHeightM, shaperBiasDefault } from './tip-policy.js'

const zGolden = JSON.parse(
  readFileSync(
    new URL('../../../../../spec/golden/z_trace.json', import.meta.url),
    'utf8',
  ),
) as {
  stage_boundaries: {
    name: string
    shaper_start_t: number | null
    params: Record<string, unknown>
    out: Record<string, unknown>[]
  }[]
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

interface RigOptions {
  /** 第 n 帧的 Z（米）。`null` = 这一帧读不出数。 */
  z?: (frame: number) => number | null
  /** 第 n 帧的电流（安）。 */
  current?: (frame: number) => number | null
  bias?: number | null | 'error' | 'unreadable'
  fireError?: string
  /** 开火那次调用自身阻塞多少毫秒（固件忽略 wait=0 的形状）。 */
  fireBlockMs?: number
  /** 第 n 次 `safeCall` 之后置中止闩。 */
  abortAfter?: number
  /** **时钟不往前走** —— 「挂住 ≠ 通过」那条守卫的实验条件。 */
  frozenClock?: boolean
  fail?: Set<string>
}

function rig(opts: RigOptions = {}): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
} {
  const calls: { verb: string; args: unknown[] }[] = []
  const abort = new AbortController()
  let clock = 1_000_000
  let zFrame = 0
  let iFrame = 0
  const reply = (m: string, args: unknown[], values: unknown[]): Promise<SkillCallRecord> =>
    Promise.resolve({ method: m, args, values })

  const safeCall = (m: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    calls.push({ verb: m, args })
    clock += 1
    if (opts.abortAfter !== undefined && calls.length >= opts.abortAfter) abort.abort()
    if (opts.fail?.has(m) === true) {
      return Promise.resolve({ method: m, args, error: '模拟故障：连接被对端关闭' })
    }
    if (m === 'Bias_Pulse' || m === 'TipShaper_Start') {
      clock += opts.fireBlockMs ?? 0
      return opts.fireError === undefined
        ? reply(m, args, [])
        : Promise.resolve({ method: m, args, error: opts.fireError })
    }
    if (m === 'Current_Get') {
      const v = (opts.current ?? ((): number => 100e-12))(iFrame++)
      return reply(m, args, v === null ? [] : [v])
    }
    if (m === 'ZCtrl_ZPosGet') {
      const v = (opts.z ?? ((): number => 0))(zFrame++)
      return reply(m, args, v === null ? [] : [v])
    }
    if (m === 'Bias_Get') {
      if (opts.bias === 'error') {
        return Promise.resolve({ method: m, args, error: 'NanonisError: 没有这条命令' })
      }
      if (opts.bias === 'unreadable') return reply(m, args, [])
      return reply(m, args, [opts.bias ?? 0.02])
    }
    // FolMe_XYPosGet 之类：给一对**像样的**坐标（0.25 m 会被量级判据挡掉）
    if (m === 'FolMe_XYPosGet') return reply(m, args, [1e-9, 2e-9])
    return reply(m, args, [0])
  }

  const ctx = {
    signal: abort.signal,
    safeCall,
    emergencyCall: safeCall,
    now: () => (opts.frozenClock === true ? 1_000_000 : (clock += 1)),
    sleep: (ms: number) => {
      if (opts.frozenClock !== true) clock += ms
      return Promise.resolve()
    },
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
    markers: { emit: () => {} },
  } as unknown as SkillContext
  return { ctx, calls }
}

/** 一发**真的扎上了**的曲线：开火之后 Z 跳 +0.5 nm，电流先饱和再回 setpoint。 */
function indentCurve(fireFrame: number, stepM: number): Pick<RigOptions, 'z' | 'current'> {
  // 一帧约 3 ms。开火后 5 帧饱和（压入 + 抬回），之后反馈恢复。
  const back = fireFrame + 5
  return {
    z: (n) => (n < fireFrame ? 0 : n < back ? -2e-9 : stepM),
    current: (n) => (n < fireFrame ? 100e-12 : n < back ? 10e-9 : 100e-12),
  }
}

const tmp: string[] = []
function redirectTraces(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spm-traces-'))
  tmp.push(dir)
  processTraceDeps.current = { tracesDir: (): string => dir, stamp: (): string => 'FIXED' }
  return dir
}

afterEach(() => {
  processTraceDeps.current = {}
  while (tmp.length > 0) rmSync(tmp.pop()!, { recursive: true, force: true })
})

// ── 判据这一层：一台会动的机器 ──────────────────────────────────────────────

describe('TipShapeWithReadback —— 一发**真的扎上了**的曲线', () => {
  it('电流定位到第四段 ⇒ 读到真正的台阶，判 `cluster`', async () => {
    redirectTraces()
    const { ctx } = rig(indentCurve(10, 5e-10))
    const r = await TipShapeWithReadback.execute(ctx, {
      bias_v: 0.02, pre_roll_s: 0.035, post_roll_s: 0.4, max_capture_s: 2.0,
      switch_off_delay_s: 0.05, lift_time_1_s: 0.05, bias_settling_s: 0.05,
      lift_time_2_s: 0.05, end_wait_s: 0.05, tip_lift_m: -2e-9,
    })
    expect(r.success).toBe(true)
    const ind = (r.data as { indent: Record<string, unknown> }).indent
    expect(ind['feedback_segment_source']).toBe('current')
    expect(ind['verdict']).toBe('cluster')
    expect(ind['delta_m']).toBeCloseTo(5e-10, 13)
    expect(ind['advice']).toBe('扎上了,表面已形成一个 cluster。')
    // **过程里的瞬态不参与判定**：压到 −2 nm，而结论是 +0.5 nm
    expect(Number(ind['z_min_m'])).toBeCloseTo(-2e-9, 12)
    expect(r.summary).toContain('扎上了(cluster)')
    expect(r.summary).toContain('Δz=+0.50 nm')
  })

  it('同一条曲线**向下**跳 ⇒ `tip_changed_or_pit`（针尖变了，或者扎出一个坑）', async () => {
    redirectTraces()
    const { ctx } = rig(indentCurve(10, -5e-10))
    const r = await TipShapeWithReadback.execute(ctx, {
      bias_v: 0.02, pre_roll_s: 0.035, post_roll_s: 0.4, max_capture_s: 2.0,
      switch_off_delay_s: 0.05, lift_time_1_s: 0.05, bias_settling_s: 0.05,
      lift_time_2_s: 0.05, end_wait_s: 0.05,
    })
    const ind = (r.data as { indent: Record<string, unknown> }).indent
    expect(ind['verdict']).toBe('tip_changed_or_pit')
    expect(r.summary).toContain('针尖改变/坑')
  })

  it('**电流再没回到 setpoint** ⇒ 判不了，而且那句话不是「没扎上」', async () => {
    redirectTraces()
    // 采集在反馈接管**之前**就结束了 —— 168 条历史曲线里 160 条是这一种
    const { ctx } = rig({
      z: (n) => (n < 10 ? 0 : -2e-9),
      current: (n) => (n < 10 ? 100e-12 : 10e-9),
    })
    const r = await TipShapeWithReadback.execute(ctx, {
      bias_v: 0.02, pre_roll_s: 0.035, post_roll_s: 0.4, max_capture_s: 2.0,
      switch_off_delay_s: 0.05, lift_time_1_s: 0.05, bias_settling_s: 0.05,
      lift_time_2_s: 0.05, end_wait_s: 0.05,
    })
    const ind = (r.data as { indent: Record<string, unknown> }).indent
    expect(ind['verdict']).toBe('insufficient_data')
    expect(ind['reason']).toBe('feedback_segment_not_captured')
    expect(String(ind['advice'])).toContain('不要据此加大扎入深度')
    // 默认那句「增大扎入深度」在这种情形下正好是**错的方向**
    expect(String(ind['advice'])).not.toContain('增大向下扎的深度')
  })
})

describe('TipShapeWithReadback —— 偏压缺省与那条无条件施加的孪生兄弟', () => {
  it('省略 `bias_v` ⇒ 跟随**此刻的成像偏压**，并标明来源', async () => {
    redirectTraces()
    const { ctx, calls } = rig({ bias: 0.02 })
    const r = await TipShapeWithReadback.execute(ctx, { max_capture_s: 0.2 })
    expect(calls[0]?.verb).toBe('Bias_Get')
    expect(r.data).toMatchObject({ bias_v: 0.02, bias_v_source: 'read', bias_lift_v: 0.02 })
  })

  it('**读不到就拒绝执行** —— 不回落到写死的 3 V，也不发任何硬件动作', async () => {
    for (const bias of ['error', 'unreadable'] as const) {
      const { ctx, calls } = rig({ bias })
      const r = await TipShapeWithReadback.execute(ctx, {})
      expect(r.success).toBe(false)
      expect(r.error).toContain('拒绝用写死的 3 V 代替')
      expect(calls.map((c) => c.verb)).toEqual(['Bias_Get']) // 一个动作都没发
    }
  })

  it('`bias_lift_v` **省略就跟随 bias_v**，而它是无条件施加的那一个', async () => {
    redirectTraces()
    const { ctx, calls } = rig({ bias: 0.02 })
    // change_bias 关着 —— 但 Bias Lift 照样下发。回包必须写出实际下发的那一组。
    const r = await TipShapeWithReadback.execute(ctx, { change_bias: false, max_capture_s: 0.2 })
    const props = calls.find((c) => c.verb === 'TipShaper_PropsSet')!
    expect(props.args[1]).toBe(2) // change_bias = 关
    expect(props.args[5]).toBe(0.02) // 而 Bias Lift 仍然是 20 mV，不是 3 V
    expect(r.data).toMatchObject({ change_bias: false, bias_lift_v: 0.02 })
  })

  it('`TipShaper_PropsSet` 报错 ⇒ 立刻停，**不进采集循环**', async () => {
    const { ctx, calls } = rig({ bias: 0.02, fail: new Set(['TipShaper_PropsSet']) })
    const r = await TipShapeWithReadback.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe('模拟故障：连接被对端关闭')
    expect(calls.map((c) => c.verb)).toEqual(['Bias_Get', 'TipShaper_PropsSet'])
  })

  it('`start_blocked`：整形那边的绝对下限是 **200 ms**（脉冲那边是 20 ms）', async () => {
    redirectTraces()
    const { ctx } = rig({ bias: 0.02, fireBlockMs: 250 })
    const r = await TipShapeWithReadback.execute(ctx, { max_capture_s: 0.6 })
    const t = (r.data as { timing: Record<string, unknown> }).timing
    expect(t['start_blocked']).toBe(true)
    expect(String((r.data as { warning?: string }).warning)).toContain('AFTER state')
  })
})

describe('BiasPulseWithReadback', () => {
  it('开火那一发报错 ⇒ 技能失败，错误**原样透传**', async () => {
    const { ctx } = rig({ fireError: 'NanonisError: 幅度超出量程' })
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 0.02, post_roll_s: 0.02, max_capture_s: 0.2,
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe('NanonisError: 幅度超出量程')
  })

  it('开火之前被喊停 ⇒ **没有发出脉冲**，而且说得出这一点', async () => {
    const { ctx, calls } = rig({ abortAfter: 3 })
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 1.0, post_roll_s: 0.02, max_capture_s: 2.0,
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe('Aborted before the pulse was fired — no pulse was applied.')
    expect(calls.some((c) => c.verb === 'Bias_Pulse')).toBe(false)
  })

  it('脉冲发出去了但一个样本都没采到 ⇒ 说**针尖状态未知**，不说「没变」', async () => {
    const { ctx } = rig({ z: () => null, current: () => null })
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 0.005, post_roll_s: 0.02, max_capture_s: 0.1,
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('UNKNOWN')
  })

  it('`start_blocked` 的绝对下限是 **20 ms** —— 200 ms 会让它在短脉冲上永远不触发', async () => {
    redirectTraces()
    // 10 ms 的脉冲：照抄整形那边的 200 ms，这个守卫一次也不会响。
    const { ctx } = rig({ fireBlockMs: 30 })
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 0.02, post_roll_s: 0.0215, max_capture_s: 0.2,
    })
    const t = (r.data as { timing: Record<string, unknown> }).timing
    expect(t['fire_call_blocked_s']).toBeGreaterThanOrEqual(0.02)
    expect(t['start_blocked']).toBe(true)
    expect(String((r.data as { warning?: string }).warning)).toContain('firmware')
  })

  it('**电流通道刻意不传** ⇒ 后窗恒为尾窗（`no_current`）', async () => {
    redirectTraces()
    const { ctx } = rig(indentCurve(8, 5e-10))
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 0.025, post_roll_s: 0.0215, max_capture_s: 0.2,
    })
    const step = (r.data as { step: Record<string, unknown> }).step
    // 四段结构是**扎入**才有的形状；一发脉冲没有那个过程。
    expect(step['feedback_segment_source']).toBe('no_current')
    expect(step['feedback_restored_t']).toBeNull()
  })

  it('针尖坐标读得到时进回包（会留下永久痕迹的动作，「在哪儿」也是结果）', async () => {
    redirectTraces()
    const { ctx } = rig()
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 0.02, post_roll_s: 0.0215, max_capture_s: 0.2,
    })
    expect(r.data).toMatchObject({ x_m: 1e-9, y_m: 2e-9 })
  })
})

// ── 「挂住 ≠ 通过」──────────────────────────────────────────────────────────

describe('圈数预算 —— 时钟不往前走时**不许挂住**', () => {
  it('`CaptureSignalBuffer`：预算耗尽时把这件事写进回包', async () => {
    const { ctx } = rig({ frozenClock: true })
    const r = await CaptureSignalBuffer.execute(ctx, { duration_s: 0.05, poll_hz: 1000 })
    expect(r.success).toBe(true)
    expect((r.data as { budget_exhausted?: boolean }).budget_exhausted).toBe(true)
  })

  it('`BiasPulseWithReadback`：始终到不了开火时刻 ⇒ **说它是时钟，不说它是中止**', async () => {
    const { ctx, calls } = rig({ frozenClock: true })
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 0.02, post_roll_s: 0.02, max_capture_s: 0.1,
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('注入的时钟没有前进')
    expect(calls.some((c) => c.verb === 'Bias_Pulse')).toBe(false)
  })

  it('时钟正常时**不会**有这个键 —— 缺键就是没发生', async () => {
    const { ctx } = rig()
    const r = await CaptureSignalBuffer.execute(ctx, { duration_s: 0.02, poll_hz: 1000 })
    expect(Object.keys(r.data ?? {})).not.toContain('budget_exhausted')
  })
})

// ── CaptureSignalBuffer ─────────────────────────────────────────────────────

describe('CaptureSignalBuffer —— 通道解析与异常检测', () => {
  it('四条**字面动词**分支各走各的', async () => {
    for (const [ch, verb, unit] of [
      ['current', 'Current_Get', 'A'],
      ['z', 'ZCtrl_ZPosGet', 'm'],
      ['bias', 'Bias_Get', 'V'],
      ['14', 'Signals_ValGet', ''],
    ] as const) {
      const { ctx, calls } = rig()
      const r = await CaptureSignalBuffer.execute(ctx, { channel: ch, duration_s: 0.02 })
      expect(new Set(calls.map((c) => c.verb))).toEqual(new Set([verb]))
      expect(r.data).toMatchObject({ channel: ch, unit })
    }
  })

  it('信号索引走 `Signals_ValGet(idx, 0)` —— `wait_for_newest=0`，不吃第二次 Tap 的延迟', async () => {
    const { ctx, calls } = rig()
    await CaptureSignalBuffer.execute(ctx, { channel: '14', duration_s: 0.01 })
    expect(calls[0]?.args).toEqual([14, 0])
  })

  it('**只收整数字面量**（Python 的 `int()`）：`0x10` / `7.5` 都是拒绝', async () => {
    for (const ch of ['0x10', '7.5', '七', 'nope', '1e3']) {
      const { ctx, calls } = rig()
      const r = await CaptureSignalBuffer.execute(ctx, { channel: ch, duration_s: 0.01 })
      expect(r.success, ch).toBe(false)
      expect(r.error).toBe(
        `Unknown channel: '${ch}'. Use 'current'/'z'/'bias' or a signal index 0-127.`,
      )
      expect(calls).toEqual([]) // 拒绝时一次调用都不发
    }
  })

  it('空串回落到 `current`（旧仓的 `params.get("channel") or "current"`）', async () => {
    const { ctx, calls } = rig()
    const r = await CaptureSignalBuffer.execute(ctx, { channel: '', duration_s: 0.01 })
    expect(r.data).toMatchObject({ channel: 'current' })
    expect(calls[0]?.verb).toBe('Current_Get')
  })

  it('**近乎恒定**（不是逐位相同）也要出声 —— 金样驱动不到的那一支', async () => {
    // 逐位相同那一支由常数回包覆盖；这一支要一个**变但几乎不变**的信号。
    let k = 0
    const { ctx } = rig({ current: () => 1e-9 + (k++ % 2) * 1e-19 })
    const r = await CaptureSignalBuffer.execute(ctx, { duration_s: 0.03, poll_hz: 1000 })
    const a = String((r.data as { anomaly?: string }).anomaly)
    expect(a).toContain('近乎恒定')
    expect(a).toContain('极差仅')
  })

  it('一个样本都没采到 ⇒ 失败（**不是一份空统计**）', async () => {
    const { ctx } = rig({ current: () => null })
    const r = await CaptureSignalBuffer.execute(ctx, { duration_s: 0.02 })
    expect(r.success).toBe(false)
    expect(r.error).toBe('No samples collected (TCP errors or aborted)')
  })

  it('`include_samples=false` ⇒ 只回统计量', async () => {
    const { ctx } = rig()
    const r = await CaptureSignalBuffer.execute(ctx, {
      duration_s: 0.02, include_samples: false,
    })
    expect(Object.keys(r.data ?? {})).not.toContain('samples')
    expect(r.data).toHaveProperty('n_samples')
  })
})

// ── 落盘 ────────────────────────────────────────────────────────────────────

const EMPTY_CAPTURE: ReadbackCapture = {
  currentS: [1e-12, 2e-12], currentT: [0.0, 0.001],
  zS: [1e-9], zT: [0.0005],
  fired: true, fireRecord: null, fireTS: 0.01, fireBlockedS: 0.002,
  captureS: 0.05, aborted: false, budgetExhausted: false,
}

describe('saveTrace —— 让这条曲线**取得到**', () => {
  it('落成一个自描述的 JSON：两个通道**各存各的时间戳**', () => {
    const dir = redirectTraces()
    const saved = saveTrace({
      capture: EMPTY_CAPTURE, skill: 'TipShapeWithReadback',
      meta: { tip_lift_m: -2e-9 }, stages: [{ stage: 'pre_roll' }],
      deps: processTraceDeps.current,
    })
    expect(saved['trace_path']).toBe(join(dir, 'TipShapeWithReadback_FIXED.json'))
    const doc = JSON.parse(readFileSync(saved['trace_path']!, 'utf8')) as Record<string, unknown>
    expect(doc['schema']).toBe(TRACE_SCHEMA)
    expect(doc['event_t_s']).toBe(0.01)
    // 两条通道点数不一样 —— 每帧先读电流再读 Z，任一次失败就只有另一条记了点。
    // 把它们当同一根时间轴对齐是错的，所以这里不对齐。
    expect(doc['channels']).toEqual({
      z: { unit: 'm', n: 1, t_s: [0.0005], samples: [1e-9] },
      current: { unit: 'A', n: 2, t_s: [0.0, 0.001], samples: [1e-12, 2e-12] },
    })
    expect(doc['meta']).toEqual({ tip_lift_m: -2e-9 })
  })

  it('**取第一个没被占用的名字** —— 别信钟，去问目录', () => {
    const dir = redirectTraces()
    const a = saveTrace({ capture: EMPTY_CAPTURE, skill: 'X', meta: {}, deps: processTraceDeps.current })
    const b = saveTrace({ capture: EMPTY_CAPTURE, skill: 'X', meta: {}, deps: processTraceDeps.current })
    expect(a['trace_path']).not.toBe(b['trace_path'])
    expect(b['trace_path']).toBe(join(dir, 'X_FIXED_01.json'))
    expect(readdirSync(dir).length).toBe(2)
  })

  it('技能名里的非字母数字换成下划线，且截到 40 字', () => {
    const dir = redirectTraces()
    const saved = saveTrace({
      capture: EMPTY_CAPTURE, skill: 'a/b c'.repeat(20), meta: {},
      deps: processTraceDeps.current,
    })
    const base = saved['trace_path']!.slice(dir.length + 1)
    expect(base.startsWith('a_b_ca_b_c')).toBe(true)
    expect(base).toBe(`${'a_b_c'.repeat(8)}_FIXED.json`)
  })

  it('**落盘失败也出声**，而且不带走一次成功的硬件动作', () => {
    const saved = saveTrace({
      capture: EMPTY_CAPTURE, skill: 'X', meta: {},
      deps: { tracesDir: (): string => { throw new TypeError('盘满了') } },
    })
    expect(saved['trace_path']).toBeUndefined()
    expect(saved['trace_error']).toBe('TypeError: 盘满了')
    expect(traceRef(saved)).toBe(' | ⚠️ 原始曲线未落盘: TypeError: 盘满了')
  })

  it('`traceRef`：成功、失败、以及**本来就没采**，三句话各不相同', () => {
    expect(traceRef({ trace_path: 'C:\\x.json' })).toBe(' | 原始曲线: C:\\x.json')
    expect(traceRef({})).toBe('')
  })

  it('技能把指针写进**摘要** —— 摘要是唯一穿过工具边界的东西', async () => {
    const dir = redirectTraces()
    const { ctx } = rig()
    const r = await BiasPulseWithReadback.execute(ctx, {
      bias_v: 5, width_s: 0.01, pre_roll_s: 0.02, post_roll_s: 0.0215, max_capture_s: 0.2,
    })
    expect(r.summary).toContain(` | 原始曲线: ${join(dir, 'BiasPulseWithReadback_FIXED.json')}`)
  })
})

// ── 小件 ────────────────────────────────────────────────────────────────────

describe('stageBoundaries —— 对 `spec/golden/z_trace.json` 逐格', () => {
  for (const c of zGolden.stage_boundaries) {
    it(c.name, () => {
      expect(stageBoundaries(c.shaper_start_t, c.params)).toEqual(c.out)
    })
  }
})

describe('scalar / stats / channelBlock', () => {
  it('取不出数就是 `null`（D-STREAM-1：不在多元素 body 上猜一路）', () => {
    expect(scalar({ method: 'm', args: [], values: [1.5] })).toBe(1.5)
    expect(scalar({ method: 'm', args: [], values: [[1.5]] })).toBe(1.5)
    expect(scalar({ method: 'm', args: [], values: [] })).toBeNull()
    expect(scalar({ method: 'm', args: [], values: [[1.5, 2.5]] })).toBeNull()
    expect(scalar({ method: 'm', args: [], values: ['1.5'] })).toBeNull()
  })

  it('空表的统计量**全是 null，不是 0**', () => {
    expect(stats([])).toEqual({ n: 0, min: null, max: null, mean: null, std: null })
    expect(channelBlock([], [], 'm')).toEqual({
      samples_m: [], t_s: [], n: 0, min_m: null, max_m: null, mean_m: null, std_m: null,
    })
  })

  it('总体标准差（除以 n），不是样本标准差', () => {
    const s = stats([1, 2, 3, 4])
    expect(s.mean).toBe(2.5)
    expect(s.std).toBeCloseTo(Math.sqrt(1.25), 15)
  })

  it('`captureIsEmpty`：两条通道都空才算空', () => {
    expect(captureIsEmpty({ ...EMPTY_CAPTURE, currentS: [], zS: [] })).toBe(true)
    expect(captureIsEmpty({ ...EMPTY_CAPTURE, currentS: [], zS: [1] })).toBe(false)
    expect(captureIsEmpty(EMPTY_CAPTURE)).toBe(false)
  })
})

describe('resolvedLiftHeightM —— **0.0 是一个真实的高度**（D-ZERO-1 那一族）', () => {
  it('没给第二段高度 ⇒ 压进去多少就抬回来多少', () => {
    expect(resolvedLiftHeightM({ tip_lift_m: -2e-9 })).toBe(2e-9)
  })

  it('**显式给 0.0 仍然是 0.0** —— 「不抬」是合法意图，只是不该是缺省意图', () => {
    expect(resolvedLiftHeightM({ lift_height_m: 0.0, tip_lift_m: -2e-9 })).toBe(0)
  })

  it('两个都没给 ⇒ 0.0（裸技能的缺省，靠 restore_feedback 把针拽回来）', () => {
    expect(resolvedLiftHeightM({})).toBe(0)
  })

  it('读不懂的值当没给', () => {
    expect(resolvedLiftHeightM({ lift_height_m: '五纳米', tip_lift_m: -2e-9 })).toBe(2e-9)
    expect(resolvedLiftHeightM({ lift_height_m: true, tip_lift_m: -2e-9 })).toBe(2e-9)
  })
})

describe('shaperBiasDefault', () => {
  it('读得到就用它，`why` 是空串', async () => {
    const { ctx } = rig({ bias: 0.05 })
    expect(await shaperBiasDefault(ctx)).toEqual({ v: 0.05, why: '' })
  })

  it('报错 / 读不懂 / 非有限，三句话各不相同', async () => {
    expect((await shaperBiasDefault(rig({ bias: 'error' }).ctx)).why).toContain('Bias_Get 报错:')
    // D-SKILL-2：旧仓印的是 Python 的回包 repr，这一侧只有 body，印我们真有的
    expect((await shaperBiasDefault(rig({ bias: 'unreadable' }).ctx)).why).toBe(
      'Bias_Get 回包读不懂(values=[])',
    )
    expect((await shaperBiasDefault(rig({ bias: Number.NaN }).ctx)).why).toBe('Bias_Get 读回 nan')
  })
})
