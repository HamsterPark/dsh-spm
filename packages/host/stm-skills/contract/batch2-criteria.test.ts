/**
 * 批 2 的完成判据（PLAN §8.4），逐条。
 *
 * 它们不是「又几条测试」，是 Phase 2 能不能收工的那张清单。每一条都对应一次
 * 真机上发生过的事，或者一次差点发生的事。
 */
import { Context, SystemPrompt, ToolRuntime } from 'dsh-spm-compat'
import {
  AbortRequestedError,
  BusyError,
  SkillKernel,
  emptyHardwareState,
  isAbortSafe,
  physicallyAbsurdViolations,
  type HardwareState,
  type SkillCallRecord,
} from 'dsh-spm-kernel'
import * as records from 'dsh-spm-stm-records'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'
import { gatedSafeCall } from '../src/gated-call.js'
import { defineSkillTool } from '../src/tool.js'

const S0 = emptyHardwareState('T0')

/** 一台可脚本化的假仪器：记下每一条发出去的动词。 */
function fakeInstrument(): {
  call: (m: string, ...a: unknown[]) => Promise<SkillCallRecord>
  sent: { verb: string; args: unknown[] }[]
} {
  const sent: { verb: string; args: unknown[] }[] = []
  return {
    sent,
    call: (method: string, ...args: unknown[]) => {
      sent.push({ verb: method, args })
      return Promise.resolve({ method, args, values: [0.25, 0.5, 0.75, 1] })
    },
  }
}

let ctx: Context
beforeEach(async () => {
  ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  ctx.plugin(records, {})
  await new Promise<void>((r) => ctx.inject(['stmRecords', 'tools'], () => r()))
})
afterEach(async () => {
  await ctx.registry.delete(records)
})

// ── 判据 ①：中止 ────────────────────────────────────────────────────────────

describe('① 中止：两层，各管各的', () => {
  it('闩上之后**工具入口一律拒**，而且不假定是人停的', async () => {
    // 真机 2026-08-13：环境监控把一次「读不到」判成硬故障、退了针并挂上急停闩，
    // 而每一次调用都在告诉用户**是他停的** —— 他没有。于是他去翻自己的操作记录，
    // 而不是去看那一行环境告警。
    let latched = false
    const inst = fakeInstrument()
    const k = new SkillKernel({
      snapshot: () => S0,
      safeCall: inst.call,
      abortLatched: () => latched,
      record: ctx.stmRecords.fromKernel,
    })
    const o1 = await k.run(IMPLEMENTED['GetBias']!, {})
    expect(o1.kind).toBe('ok')

    latched = true
    const o2 = await k.run(IMPLEMENTED['SetBias']!, { bias_v: 0.5 })
    expect(o2.kind).toBe('refused')
    expect(o2.code).toBe('abort_latched')
    expect(o2.text).toContain('本次运行处于中止状态——拒绝执行新的仪器动作')
    expect(o2.text).toContain('**没有留下中止原因**')
    expect(o2.text).toContain('去看服务日志里最近的 CRITICAL 行')
    // **结束本轮**，不让模型接着试下一个技能
    expect(o2.concludeTurn).toBe(true)
  })

  it('有原因时如实转述，不换成「用户已中止」', async () => {
    const k = new SkillKernel({
      snapshot: () => S0,
      abortLatched: () => true,
      abortReason: () => '看门狗：隧道电流连续 6 拍贴轨',
    })
    const o = await k.run(IMPLEMENTED['SetBias']!, { bias_v: 0.5 })
    expect(o.text).toContain('中止原因:看门狗：隧道电流连续 6 拍贴轨')
    expect(o.text).not.toContain('没有留下中止原因')
  })

  it('**动词那一层**：写被拒，而退针与停扫放行', async () => {
    // 少了这一层的后果很具体：中止落在某个技能中段时，它自己的清理动作
    // 会被自己触发的那道闸拒掉 —— 人按了中止，针却留在原地。
    const inst = fakeInstrument()
    const call = gatedSafeCall({ call: inst.call, abortLatched: () => true })

    expect((await call('Bias_Set', 0.5)).error).toContain('不在中止安全名单里')
    expect((await call('ZCtrl_SetpntSet', 1e-10)).error).toContain('不在中止安全名单里')

    expect((await call('ZCtrl_Withdraw', 1, -1)).error).toBeUndefined()
    expect((await call('Scan_Action', 1, 0)).error).toBeUndefined()
    // 读一律放行 —— 中止之后最该做的事就是搞清楚现在是什么状况
    expect((await call('Bias_Get')).error).toBeUndefined()
    expect((await call('ZCtrl_ZPosGet')).error).toBeUndefined()

    expect(inst.sent.map((c) => c.verb)).toEqual([
      'ZCtrl_Withdraw', 'Scan_Action', 'Bias_Get', 'ZCtrl_ZPosGet',
    ])
  })

  it('`Scan_Action` **带参数判**：停扫放行，起扫拒', () => {
    // 一个只看动词名的白名单会把起扫也放过去 —— 中止之后起一次扫描。
    expect(isAbortSafe('Scan_Action', [1, 0])).toBe(true)
    expect(isAbortSafe('Scan_Action', [0, 0])).toBe(false)
  })

  it('中止时**不回滚**：回滚会把仪器又动一遍', async () => {
    let rolledBack = false
    const k = new SkillKernel({ snapshot: () => S0 })
    const o = await k.run(
      {
        spec: { name: '_Probe', description: 'p', parameters: [] },
        // **必须是真的那个类**：内核按类身份分「中止」与「异常」，
        // 一个只是名字像的错误会被当成普通异常，于是回滚 —— 而回滚会把仪器又动一遍。
        execute: () => Promise.reject(new AbortRequestedError('操作员中止')),
        rollback: () => {
          rolledBack = true
          return Promise.resolve()
        },
      },
      {},
    )
    expect(o.kind).toBe('aborted')
    expect(rolledBack).toBe(false)
  })
})

// ── 判据 ②：锁争用 ──────────────────────────────────────────────────────────

describe('② 锁争用：一个 busy，**不排队**', () => {
  it('两个 owner 同时 SetBias ⇒ 后来的立刻 busy', async () => {
    // 「排队」在仪器上不是等待，是**延迟生效**：五秒后那个偏压才落下去，
    // 而那时现场已经不是发出它时的现场了。
    let held = false
    const kernel = new SkillKernel({
      snapshot: () => S0,
      safeCall: (m, ...a) => Promise.resolve({ method: m, args: a, values: [0.25] }),
      acquireLock: () => {
        if (held) return Promise.reject(new BusyError('SetBias 正在被别的 owner 执行'))
        held = true
        return Promise.resolve(() => {
          held = false
        })
      },
    })

    let release: (() => void) | undefined
    const slow = {
      spec: IMPLEMENTED['SetBias']!.spec,
      execute: (): Promise<{ success: boolean }> =>
        new Promise((r) => {
          release = () => r({ success: true })
        }),
    }
    const first = kernel.run(slow, { bias_v: 0.5 }, { owner: 'A' })
    // 让第一个先拿到锁
    await Promise.resolve()
    const second = await kernel.run(IMPLEMENTED['SetBias']!, { bias_v: 0.6 }, { owner: 'B' })

    expect(second.kind).toBe('busy')
    expect(second.text).toContain('正在被别的 owner 执行')
    release?.()
    expect((await first).kind).toBe('ok')
  })

  it('busy **不回滚** —— 我们根本没跑，没有可回滚的东西', async () => {
    let rolledBack = false
    const kernel = new SkillKernel({
      snapshot: () => S0,
      acquireLock: () => Promise.reject(new BusyError('忙')),
    })
    const o = await kernel.run(
      {
        spec: { name: '_Probe', description: 'p', parameters: [] },
        execute: () => Promise.resolve({ success: true }),
        rollback: () => {
          rolledBack = true
          return Promise.resolve()
        },
      },
      {},
    )
    expect(o.kind).toBe('busy')
    expect(rolledBack).toBe(false)
  })
})

// ── 判据 ③：蜜罐 ────────────────────────────────────────────────────────────

describe('③ 蜜罐：setpoint_a = 1.5 被荒谬拒，并给出写法', () => {
  it('1.5 A 在这台仪器上不可能是本意', () => {
    // 2026-07-27 真机：instrument_control 发了 setpoint_a=1.5 —— 1.5 **安培**，
    // 意图是 1.5 nA。**连发十一次**。
    const v = physicallyAbsurdViolations(
      { name: 'SetSetpoint', description: 's', parameters: [{ name: 'setpoint_a', type: 'float', unit: 'A', required: true }] },
      { setpoint_a: 1.5 },
    )
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('物理荒谬值')
    expect(v[0]).toContain('1.5')
  })

  it('拒绝文案里必须有**能用的写法** —— 只说「不行」等于让它去猜', async () => {
    const t = defineSkillTool(IMPLEMENTED['SetSetpoint']!, {
      kernel: new SkillKernel({ snapshot: () => S0 }),
    })
    const props = (t.parameters as { properties: Record<string, { description?: string }> }).properties
    expect(props['setpoint_a']?.description).toContain('100p')
    expect(props['setpoint_a']?.description).toContain('前缀不可省略')
  })

  it('同一个数走 SI 解析：`100p` 进得去，裸 `1e-10` 被拒', async () => {
    let seen: unknown
    const kernel = new SkillKernel({
      snapshot: () => S0,
      safeCall: (m, ...a) => Promise.resolve({ method: m, args: a, values: [1e-10] }),
    })
    const probe = {
      spec: IMPLEMENTED['SetSetpoint']!.spec,
      execute: (_c: unknown, p: Readonly<Record<string, unknown>>) => {
        seen = p['setpoint_a']
        return Promise.resolve({ success: true })
      },
    }
    const good = await kernel.run(probe, { setpoint_a: '100p' })
    expect(good.kind).toBe('ok')
    expect(seen).toBe(1e-10)

    const bad = await kernel.run(probe, { setpoint_a: '1e-10' })
    expect(bad.kind).toBe('refused')
    expect(bad.code).toBe('si_parse')
  })
})

// ── 判据 ④：ZControllerOnOff(true) 后立刻 MoveToXY 过前置 ────────────────────

describe('④ 2026-08-10 的反例：写回成功、缓存却是陈值', () => {
  it('`ZControllerOnOff(true)` 之后**立刻** `MoveToXY` 必须过前置', async () => {
    // 真机原样：`ZControllerOnOff(True)` 成功且回读 verified，紧接着 `MoveToXY`
    // 报 `z_controller_on is False` —— 缓存最多旧 1 秒，而一个刚刚成功的写技能
    // 会在下一步被**自己的陈值**挡住，于是死循环。
    //
    // 1.8 的 carry-forward 修了缓存那一半；K8「不满足时先刷新再判」修的是判定
    // 那一半。**两半都要**，这条测试钉的是合起来的效果。
    let cached: HardwareState = { ...S0, z_controller_on: false }
    let hardware = false

    const kernel = new SkillKernel({
      snapshot: () => cached,
      // 刷新 = 去问硬件，而不是复用缓存
      refreshState: () => {
        cached = { ...cached, z_controller_on: hardware }
        return Promise.resolve(cached)
      },
      safeCall: (m, ...a) => {
        if (m === 'ZCtrl_OnOffSet') hardware = a[0] === 1
        if (m === 'ZCtrl_OnOffGet') return Promise.resolve({ method: m, args: a, values: [hardware ? 1 : 0] })
        return Promise.resolve({ method: m, args: a, values: [0.25, 0.5] })
      },
      applyPatch: (fields) => {
        cached = { ...cached, ...fields }
      },
    })

    const on = await kernel.run(IMPLEMENTED['ZControllerOnOff']!, { enable: true })
    expect(on.kind).toBe('ok')
    expect(on.data?.['verified']).toBe(true)

    // **紧接着**，缓存这一刻可能仍是旧的
    const move = await kernel.run(IMPLEMENTED['MoveToXY']!, { x_m: 1e-9, y_m: 1e-9, wait: false })
    expect(move.kind, `前置条件把刚打开的 Z 控制器判成关着了：${move.text}`).not.toBe('refused')
  })

  it('缓存是陈值时 K8 **先刷新再判**，刷新后仍不满足才拒', async () => {
    let refreshed = 0
    const kernel = new SkillKernel({
      snapshot: () => ({ ...S0, z_controller_on: false }),
      refreshState: () => {
        refreshed += 1
        return Promise.resolve({ ...S0, z_controller_on: false })
      },
      safeCall: (m, ...a) => Promise.resolve({ method: m, args: a, values: [0.25, 0.5] }),
    })
    const o = await kernel.run(IMPLEMENTED['MoveToXY']!, { x_m: 1e-9, y_m: 1e-9, wait: false })
    expect(refreshed).toBeGreaterThan(0) // 判之前**真的去问过硬件**
    expect(o.kind).toBe('refused')
    expect(o.code).toBe('precondition_failed')
  })
})

// ── 判据 ⑤：硬闸七件套对 llm 来源一律拒 ─────────────────────────────────────

describe('⑤ 硬闸七件套：`llm` 来源一律拒', () => {
  const SEVEN = [
    'MotorMove', 'MotorMoveClosedLoop', 'EnableSafeTip', 'SetZLimitsEnabled',
    'SetBiasCalibration', 'SetCurrentCalibration', 'SetMotorFreqAmp',
  ]

  it('七个都在已移植清单里', () => {
    expect(SEVEN.filter((n) => IMPLEMENTED[n] === undefined)).toEqual([])
  })

  it('内核挂上安全闸后七个都被拒，而且**七次都留了痕**', async () => {
    // 闸门本体在 `stm-safety`（那里有它自己的 23 条测试）；这里钉的是
    // **七个技能都真的会经过它** —— 一个没接上闸的技能，闸写得再对也没用。
    //
    // 参数要给合法的：安全闸在 K7，而 K6 的必填检查在它前面。
    // 用 `{}` 跑会在 K6 就被拒，于是「七个都被闸拦住」这句话根本没验到。
    const PARAMS: Record<string, Record<string, unknown>> = {
      MotorMove: { direction: 'x+', steps: 1 },
      MotorMoveClosedLoop: { target_x_m: 1e-9, target_y_m: 1e-9, target_z_m: 1e-9 },
      EnableSafeTip: { enabled: true },
      SetZLimitsEnabled: { enabled: true },
      SetBiasCalibration: { calibration: 1, offset: 0 },
      // 校准系数的合法区间是 [0.001, 1000]（它是**倍率**，不是电流值）
      SetCurrentCalibration: { calibration: 1, offset: 0 },
      SetMotorFreqAmp: { frequency_hz: 1000, amplitude_v: 30 },
    }
    const denied: string[] = []
    const kernel = new SkillKernel({
      snapshot: () => S0,
      safetyGate: (spec) =>
        SEVEN.includes(spec.name) ? `[safety_gate] hard_gate: '${spec.name}' 需要人在环。` : null,
      safeCall: (m, ...a) => Promise.resolve({ method: m, args: a, values: [0.25] }),
      record: ctx.stmRecords.fromKernel,
    })
    for (const name of SEVEN) {
      const o = await kernel.run(IMPLEMENTED[name]!, PARAMS[name]!, { approvalSource: 'llm' })
      if (o.kind === 'refused' && o.code === 'safety') denied.push(name)
    }
    expect(denied).toEqual(SEVEN)

    // 「为什么什么都没发生」要答得出 —— 被拒的七次一条不少
    const rows = ctx.stmRecords.store.db
      .prepare("SELECT action_type, error FROM actions WHERE status = 'failed' ORDER BY hlc")
      .all() as { action_type: string; error: string }[]
    expect(rows.map((r) => r.action_type)).toEqual(SEVEN)
    expect(rows.every((r) => r.error.includes('需要人在环'))).toBe(true)
  })
})
