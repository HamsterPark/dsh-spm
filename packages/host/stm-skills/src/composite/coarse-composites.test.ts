/**
 * 批 5c 的技能层 —— **每一条错误分支一条**。
 *
 * 判据本身在内核，逐格对旧仓比过了（`kernel/src/z-settle.test.ts` /
 * `coarse-drive.test.ts` / `instrument-profile.test.ts`）。这里验的是**接线**：
 * 那些判据真的被问到了、拒绝真的拦住了整趟、而拒绝的措辞里带着下一步。
 *
 * `spec/golden/skill_traces.json` 已经对旧仓逐调用比过成功路与几条错误注入；
 * 这一份补的是**通用驱动器走不到的分支**：基线不可用、方向没声明、
 * 移动中电流跳闸、急停没能下发、`StepCoarseXY` 的用途上限。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  processCoarseDrive,
  processInstrumentProfile,
  processVacuum,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { processQPlusBaseline } from '../l0/qplus.js'
import { RelocateCoarseXY } from './relocate-coarse-xy.js'
import { RetractForSampleChange } from './retract-for-sample-change.js'
import { NUDGE_MAX_STEPS, StepCoarseXY } from './step-coarse-xy.js'

/** 一台填过的机器：符号声明过、梯子短、粗动驱动也声明过。 */
const PROFILE: Record<string, unknown> = {
  retract_motor_dir: 'z-',
  z_extend_sign: '-1',
  z_recede_min_nm: 1.0,
  z_settle_timeout_s: 1.0,
  retract_total_steps: 11,
  retract_step_max: 100,
  xy_prewithdraw_steps: 11,
  xy_move_chunk_steps: 10,
}
const DRIVE: Record<string, unknown> = { max_amplitude_v: 220.0 }

type Reply = unknown[] | null

interface Script {
  /** 动词 → 一串回包（按该动词第几次被调用取；用尽后重复最后一条）。`null` = 报错。 */
  readonly byVerb?: Record<string, Reply[]>
  readonly sub?: Record<string, { success: boolean; error?: string; data?: Record<string, unknown> }>
  readonly abortAfter?: number
}

/**
 * Z 的**楼梯**：每 5 次读（= 一次 settle 的窗口）下一级，每级 −50 nm。
 *
 * 一次 settle 内恒定 ⇒ 净漂移 0 ⇒ 收敛；而两次 settle 之间差 50 nm ⇒
 * 按 `z_extend_sign = -1` 翻译出来正是**在远离**。恒定 Z 的假回包会让
 * 「测出来是零」那道守卫开火（它判得对），所以这台夹具得让台子真的动。
 */
const Z_STAIRS: Reply[] = Array.from({ length: 400 }, (_v, i) => [1.0e-7 - Math.floor(i / 5) * 50e-9])

/**
 * 默认回包：电流**高于底噪但远低于任何危险线**（5 pA）⇒ settle 收敛成 `tracking`，
 * 而方向判据的电流跳闸不触发（阈值是 `max(3×setpoint, 1 nA)`）。
 */
const DEFAULTS: Record<string, unknown[]> = {
  Current_Get: [5e-12],
  ZCtrl_SetpntGet: [1e-10],
  ZCtrl_OnOffGet: [1],
  Motor_FreqAmpGet: [1000.0, 30.0],
  Motor_StepCounterGet: [1, 2, 3],
  Bias_Get: [0.05],
  Signals_NamesGet: [['Current', 'Z']],
  Signals_ValGet: [1e-12],
}

class Rig {
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly runs: { skill: string; params: Record<string, unknown> }[] = []
  #clock = 1_000_000
  #seen = new Map<string, number>()
  #steps = 0

  constructor(private readonly s: Script = {}) {}

  ctx(): SkillContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const rig = this
    return {
      signal: {
        get aborted(): boolean {
          return rig.s.abortAfter !== undefined && rig.#steps >= rig.s.abortAfter
        },
      } as AbortSignal,
      owner: 'test',
      rootCallId: 'R1',
      depth: 0,
      now: () => {
        this.#clock += 1
        return this.#clock
      },
      sleep: (ms: number) => {
        this.#clock += ms
        return Promise.resolve()
      },
      markers: { emit: () => {} },
      safeCall: (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
        this.calls.push({ method, args })
        this.#steps += 1
        const i = this.#seen.get(method) ?? 0
        this.#seen.set(method, i + 1)
        const list = this.s.byVerb?.[method] ?? (method === 'ZCtrl_ZPosGet' ? Z_STAIRS : undefined)
        const scripted = list === undefined ? undefined : (list[Math.min(i, list.length - 1)] ?? null)
        if (scripted === null) {
          return Promise.resolve({ method, args, error: '连接被对端关闭' } as SkillCallRecord)
        }
        return Promise.resolve({
          method, args, values: scripted ?? DEFAULTS[method] ?? [0.25],
        } as SkillCallRecord)
      },
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.runs.push({ skill: name, params: { ...params } })
        const r = this.s.sub?.[name] ?? { success: true }
        return Promise.resolve(
          r.success
            ? { success: true, data: r.data ?? {} }
            : { success: false, error: r.error ?? '', data: r.data ?? {} },
        )
      },
    } as unknown as SkillContext
  }
}

function install(profile: Record<string, unknown> | null, drive: Record<string, unknown> | null): void {
  processInstrumentProfile.source = profile === null ? null : () => profile
  processCoarseDrive.source = drive === null ? null : () => drive
}

afterEach(() => {
  processInstrumentProfile.source = null
  processCoarseDrive.source = null
  processVacuum.source = null
  processVacuum.config = {}
  processQPlusBaseline.amplitude = null
  processQPlusBaseline.signalIndex = null
})

const RELOCATE = { axis: 'x', direction: '+', steps: 20 }

// ── RetractForSampleChange ──────────────────────────────────────────────────

describe('RetractForSampleChange · 基线那道 fail-closed', () => {
  it('基线读不到 Z ⇒ **拒绝**，而且一步粗动都不发', async () => {
    install(PROFILE, DRIVE)
    const rig = new Rig({ byVerb: { ZCtrl_ZPosGet: [null] } })
    const res = await RetractForSampleChange.execute(rig.ctx(), {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('退针方向自检无法建立基线 Z')
    // 它曾经降级成只看电流 —— 而「|I| ≈ 0」对远离、还没进量程、前放坏掉**同样成立**。
    expect(res.error).toContain('不会盲退几千步')
    // 处方在拒绝里：这台机器真的更慢就去调预算。
    expect(res.error).toContain('z_settle_timeout_s')
    expect(rig.calls.map((c) => c.method)).not.toContain('Motor_StartMove')
  })

  it('基线阶段被中止 ⇒ 说「被中止」，不是「读不到」', async () => {
    install(PROFILE, DRIVE)
    const rig = new Rig({ abortAfter: 3 })
    const res = await RetractForSampleChange.execute(rig.ctx(), {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('aborted')
    expect(rig.calls.map((c) => c.method)).not.toContain('Motor_StartMove')
  })
})

describe('RetractForSampleChange · 逐级自检', () => {
  it('某一级电流跳闸 ⇒ 判**逼近**、停马达、撤针，只赔这一级的步数', async () => {
    install(PROFILE, DRIVE)
    // 基线在噪声底；第 4 次 `Current_Get` 起给一个大电流（第 1 级 settle 里）。
    const rig = new Rig({
      byVerb: { Current_Get: [[1e-14], [1e-14], [1e-14], [1e-14], [1e-14], [5e-9]] },
    })
    const res = await RetractForSampleChange.execute(rig.ctx(), {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('**逼近**样品')
    expect(res.error).toContain('退针方向很可能配置反了')
    const verbs = rig.calls.map((c) => c.method)
    expect(verbs).toContain('Motor_StopMove')
    expect(verbs.filter((v) => v === 'Motor_StartMove')).toHaveLength(1)
    const rungs = (res.data?.['rungs'] ?? []) as Record<string, unknown>[]
    expect(rungs).toHaveLength(1)
    expect(rungs[0]?.['verdict']).toBe('approaching')
    // 失败时**不把逼近那一级算进已退步数** —— 它赔掉了，但方向是错的。
    expect(res.data?.['total_steps_retracted']).toBe(0)
  })

  it('本机没声明 `z_extend_sign` ⇒ `no_sign`，而处方与「没收敛」**不同**', async () => {
    const { z_extend_sign: _drop, ...noSign } = PROFILE
    install(noSign, DRIVE)
    const rig = new Rig()
    const res = await RetractForSampleChange.execute(rig.ctx(), {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('**无法进行**')
    // 「调大预算」那张方子对一个没填的符号是**把人指向没坏的东西**。
    expect(res.error).not.toContain('z_settle_timeout_s')
    expect(res.error).toContain('z_extend_sign')
    expect(res.error).toContain('「猜一个」和「猜对了」长得一模一样')
  })

  it('某一级读不到稳定 Z ⇒ `unsettled`，**不是** `approaching`，且梯子停在这一级', async () => {
    install(PROFILE, DRIVE)
    // 基线收敛；第 1 级的 settle 里 Z 一直在走 ⇒ 超时。
    const drifting: Reply[] = [[1.0e-7], [1.0e-7], [1.0e-7], [1.0e-7], [1.0e-7], [1.0e-7]]
    for (let i = 0; i < 400; i += 1) drifting.push([1.0e-7 + i * 1e-8])
    const rig = new Rig({ byVerb: { ZCtrl_ZPosGet: drifting } })
    const res = await RetractForSampleChange.execute(rig.ctx(), {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('**没有得出结论**(不是判定为逼近)')
    // 下一级是这一级的 10 倍 —— 那正是小探针级存在的理由。
    expect(res.error).toContain('下一级步数是这一级的 10 倍')
    expect(rig.calls.filter((c) => c.method === 'Motor_StartMove')).toHaveLength(1)
  })

  it('粗动命令本身失败 ⇒ 说清是哪一级、几步', async () => {
    install(PROFILE, DRIVE)
    const rig = new Rig({ byVerb: { Motor_StartMove: [null] } })
    const res = await RetractForSampleChange.execute(rig.ctx(), {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('coarse retract (rung 0, 1 steps) failed')
  })
})

// ── RelocateCoarseXY ────────────────────────────────────────────────────────

describe('RelocateCoarseXY · 前置检查按「最便宜且最有决定性」排', () => {
  it('轴/方向无效 ⇒ 一次调用都不发', async () => {
    install(PROFILE, DRIVE)
    const rig = new Rig()
    const res = await RelocateCoarseXY.execute(rig.ctx(), { axis: 'z', direction: '+', steps: 1 })
    expect(res.success).toBe(false)
    expect(res.error).toContain('无效的轴/方向')
    expect(rig.calls).toHaveLength(0)
  })

  it('真空互锁拒绝 ⇒ 停在第一道闸，**一次硬件读都不发**', async () => {
    install(PROFILE, DRIVE)
    processVacuum.source = () => null // 读不到压强 = fail-closed
    const rig = new Rig()
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('真空互锁拒绝粗动')
    expect(rig.calls).toHaveLength(0)
  })

  it('**本机粗动上限未声明 ⇒ 拒绝**（沉默不是同意）', async () => {
    install(PROFILE, null)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig()
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('粗动驱动核对失败')
    expect(res.error).toContain('尚未声明')
    // 读回那一次是发了的 —— 「读不到就是拒绝」要先去读。
    expect(rig.calls.map((c) => c.method)).toEqual(['Motor_FreqAmpGet'])
    expect(rig.calls.map((c) => c.method)).not.toContain('Motor_StartMove')
  })

  it('驱动幅度读不回来 ⇒ 也是拒绝（一道看不见时会通过的检查不是检查）', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig({ byVerb: { Motor_FreqAmpGet: [null] } })
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('读不到当前粗动驱动幅度')
  })

  it('当前驱动幅度高于本机声明 ⇒ 拒绝，并指向 Nanonis 界面', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig({ byVerb: { Motor_FreqAmpGet: [[1000.0, 390.0]] } })
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('高于本机声明上限')
  })

  it('落点复核**此刻永远放行**，而它把「地图没移植」说出来了', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig({ byVerb: { ZCtrl_ZPosGet: [null] } })
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    // 停在清障基线上（下一道闸），说明落点那一条放行了。
    expect(res.success).toBe(false)
    const checks = res.data?.['checks'] as Record<string, unknown>
    const dest = checks['destination'] as Record<string, unknown>
    expect(dest['blocked']).toBe(false)
    expect(dest['map_available']).toBe(false)
    expect(String(dest['reason'])).toContain('粗动大地图未移植')
  })

  it('`allow_revisit` 只跳过那条**效率**约束，安全检查一条不跳', async () => {
    install(PROFILE, null) // 驱动没声明 ⇒ 安全那道闸照样拒
    processVacuum.config = { mode: 'off' }
    const rig = new Rig()
    const res = await RelocateCoarseXY.execute(rig.ctx(), { ...RELOCATE, allow_revisit: true })
    expect(res.success).toBe(false)
    expect(res.error).toContain('粗动驱动核对失败')
  })
})

describe('RelocateCoarseXY · 清障与横移', () => {
  const ok = { byVerb: {} as Record<string, Reply[]> }

  it('清障基线不可用 ⇒ **不会盲退**', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig({ byVerb: { ZCtrl_ZPosGet: [null] } })
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('清障退针自检无法建立基线')
    expect(rig.calls.map((c) => c.method)).not.toContain('Motor_StartMove')
  })

  it('横移前把偏压降到 0.5 V，**而本来就低于它就不碰**', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const low = new Rig({ ...ok, byVerb: { Bias_Get: [[0.05]], ZCtrl_ZPosGet: [null] } })
    await RelocateCoarseXY.execute(low.ctx(), RELOCATE)
    expect(low.calls.filter((c) => c.method === 'Bias_Set')).toHaveLength(0)

    const high = new Rig({ byVerb: { Bias_Get: [[2.0]], ZCtrl_ZPosGet: [null] } })
    await RelocateCoarseXY.execute(high.ctx(), RELOCATE)
    const sets = high.calls.filter((c) => c.method === 'Bias_Set')
    // 降一次（0.5 V），panic 里再放回一次（2.0 V）——「谁改谁恢复」。
    expect(sets.map((c) => c.args[0])).toEqual([0.5, 2.0])
  })

  it('移动中电流跳闸 ⇒ 立刻停 + 撤针，并报**已经走了多少步**', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    // 清障全程电流在底噪；第一块横移之后给一个 50 pA。
    const currents: Reply[] = []
    // 前 16 次读是清障那一路（基线 5 + 两级各 5 + 脱离确认 1）；第 17 次是**第一块横移之后**。
    for (let i = 0; i < 16; i += 1) currents.push([5e-12])
    currents.push([5e-11])
    const rig = new Rig({ byVerb: { Current_Get: currents } })
    const res = await RelocateCoarseXY.execute(rig.ctx(), { ...RELOCATE, steps: 20 })
    expect(res.success).toBe(false)
    expect(res.error).toContain('横向移动中检测到电流')
    expect(res.error).toContain('已立即停止粗动并撤针')
    // **失败也移动过** —— 里程表的入场券。
    expect(res.data?.['lateral_steps_taken']).toBe(10)
    expect(res.data?.['steps']).toBe(10)
  })

  it('`dry_run` 一条移动命令都不发，而 `lateral_steps_taken` 是 0', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig()
    const res = await RelocateCoarseXY.execute(rig.ctx(), { ...RELOCATE, dry_run: true })
    expect(res.success).toBe(true)
    // 清障阶梯**照跑**（它是真的退针），横移那几块不发。
    const moves = rig.calls.filter((c) => c.method === 'Motor_StartMove')
    expect(moves.every((c) => c.args[0] === 5)).toBe(true) // 5 = z−，清障方向
    expect(res.data?.['lateral_steps_taken']).toBe(0)
    expect(res.data?.['steps']).toBe(20)
    expect(rig.runs.map((r) => r.skill)).not.toContain('ApproachTip')
  })

  it('急停**没能下发**时，一次「各项判据都过了」的移动照样判失败', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const currents: Reply[] = []
    // 前 16 次读是清障那一路（基线 5 + 两级各 5 + 脱离确认 1）；第 17 次是**第一块横移之后**。
    for (let i = 0; i < 16; i += 1) currents.push([5e-12])
    currents.push([5e-11]) // 触发 panic
    const rig = new Rig({
      byVerb: { Current_Get: currents, Motor_StopMove: [[0], null] },
    })
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.data?.['panic_failures']).toEqual(['Motor_StopMove: 连接被对端关闭'])
    expect(res.error).toContain('紧急停止未能完整下发')
    expect(res.error).toContain('不要假设本技能已经把针尖收回去了')
  })

  it('重新进针失败 ⇒ 说清**横移已经完成**，不要再移动一次', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig({ sub: { ApproachTip: { success: false, error: '没找到表面' } } })
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('**横向移动本身已经完成**')
    expect(res.error).toContain('不要再移动一次')
    expect(res.data?.['lateral_steps_taken']).toBe(20)
  })

  it('步进计数器读不回来 ⇒ **如实记录，不是通过**', async () => {
    install(PROFILE, DRIVE)
    processVacuum.config = { mode: 'off' }
    const rig = new Rig({ byVerb: { Motor_StepCounterGet: [null] } })
    const res = await RelocateCoarseXY.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(true)
    const prog = res.data?.['_progress'] as Record<string, unknown>
    expect(JSON.stringify(prog)).toContain('verify')
  })
})

// ── StepCoarseXY ────────────────────────────────────────────────────────────

describe('StepCoarseXY · 一层薄壳', () => {
  it('转调 `RelocateCoarseXY(allow_revisit=true)`，参数逐个透传', async () => {
    const rig = new Rig()
    const res = await StepCoarseXY.execute(rig.ctx(), { axis: 'y', direction: '-', steps: 2 })
    expect(res.success).toBe(true)
    expect(rig.runs).toHaveLength(1)
    expect(rig.runs[0]).toEqual({
      skill: 'RelocateCoarseXY',
      params: { axis: 'y', direction: '-', steps: 2, allow_revisit: true, reapproach: true, dry_run: false },
    })
    expect(res.data?.['delegated_to']).toBe('RelocateCoarseXY')
    expect(res.data?.['requested_steps']).toBe(2)
  })

  it('`steps` 不给 ⇒ 默认挪一步', async () => {
    const rig = new Rig()
    await StepCoarseXY.execute(rig.ctx(), { axis: 'x', direction: '+' })
    expect(rig.runs[0]?.params['steps']).toBe(1)
  })

  it('`prewithdraw_steps` 给了才透传（留空 = 用档案的默认）', async () => {
    const withIt = new Rig()
    await StepCoarseXY.execute(withIt.ctx(), { axis: 'x', direction: '+', prewithdraw_steps: 5 })
    expect(withIt.runs[0]?.params['prewithdraw_steps']).toBe(5)
    const without = new Rig()
    await StepCoarseXY.execute(without.ctx(), { axis: 'x', direction: '+' })
    expect('prewithdraw_steps' in (without.runs[0]?.params ?? {})).toBe(false)
  })

  it(`超过 ${NUDGE_MAX_STEPS} 步**拒绝**，而且一次子技能都不调`, async () => {
    const rig = new Rig()
    const res = await StepCoarseXY.execute(rig.ctx(), {
      axis: 'x', direction: '+', steps: NUDGE_MAX_STEPS + 1,
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('那是换区')
    expect(res.error).toContain('RelocateCoarseXY')
    expect(rig.runs).toHaveLength(0)
  })

  it('内层失败时 error 原样上浮，`data` 仍带着里程表要的那几个键', async () => {
    const rig = new Rig({
      sub: {
        RelocateCoarseXY: {
          success: false, error: '真空互锁拒绝粗动:读不到压强',
          data: { lateral_steps_taken: 3, direction: 'x+' },
        },
      },
    })
    const res = await StepCoarseXY.execute(rig.ctx(), { axis: 'x', direction: '+', steps: 3 })
    expect(res.success).toBe(false)
    expect(res.error).toBe('真空互锁拒绝粗动:读不到压强')
    expect(res.data?.['lateral_steps_taken']).toBe(3)
  })
})
