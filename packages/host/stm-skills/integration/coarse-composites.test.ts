/**
 * 批 5c 对**真 stmsim** 跑一遍（DoD ④）—— 粗动那一族。
 *
 * ## 这条缝验的是什么
 *
 * 1. **粗动驱动读回闸建立在真读数上。** `Motor_FreqAmpGet` 在模拟器里回的是世界模型
 *    自己的 `coarse.freq_hz / amp_v`（出厂 300 Hz / 180 V），不是一个常数桩。
 *    声明一个低于它的上限 ⇒ 真的被拒；声明一个高于它的 ⇒ 真的放行。
 *    这道闸**没有别的金样覆盖到「读到了一个真数再比」这一步**。
 * 2. **`settleAndReadZ` 在一台真的会走的反馈环上收敛。** 模拟器的
 *    `zctrl_set(True)` 明写着它复刻的就是这条例程（`world.py:435`：
 *    「closing the loop from the withdraw rail extends Z at the I-gain speed … this is
 *    how MAST's settle routine re-engages after a Withdraw」）。2026-08-04 那个缺陷
 *    正是「读了一个还在爬的 Z」，而只有在一台真的会爬的环上才证得了修好了。
 * 3. **步进计数器那一支是真的 `unavailable`。** 这台模拟器默认不支持
 *    `Motor_StepCounterGet`（`tipwork_module.py`：`NeedModule`），
 *    于是「如实记录，不是通过」那句话第一次被一台真的不支持它的控制器逼出来。
 *
 * ## 为什么**一步粗动都不发**
 *
 * `Motor_StartMove` 在这台模拟器里是**真的动**（`world.motor_move` 改
 * `coarse.coarse_gap_m`，每步 0.28 µm ± 15 %，且 `Z-` 在隧穿态下直接判撞针）。
 * 整组 `integration` 共用**同一台**模拟器，所以一次不可逆的粗动会顺着影响后面每一条
 * 扫描测试 —— 而那种红最难查（`scan-composites.test.ts` 的抬头记着上一次）。
 *
 * 所以这里全部走**不动马达**的路径：
 *   · 驱动闸拒绝（发一次读，停在第一道写之前）；
 *   · `prewithdraw_steps: 0` + `dry_run: true` 的完整相链（清障阶梯为空，横移不发）；
 *   · `settleAndReadZ` 直接跑（只碰压电，`ZCtrl_Withdraw` / `ZCtrl_OnOffSet`，可恢复）。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`），所以 `spawn: false`。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  processCoarseDrive,
  processInstrumentProfile,
  processVacuum,
  zSettleUsable,
  zSettleWhy,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'
import { settleAndReadZ } from '../src/composite/z-settle.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  processInstrumentProfile.source = null
  processCoarseDrive.source = null
  processVacuum.source = null
  processVacuum.config = {}
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

function instrument(timeoutMs = 10_000): Promise<Rig> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      resolve(new Rig(c.instrument as { call: SafeCallish }))
    })
  })
}

class Rig {
  readonly calls: string[] = []
  readonly subs: string[] = []
  readonly #inst: { call: SafeCallish }

  constructor(inst: { call: SafeCallish }) {
    this.#inst = inst
  }

  ctx(): SkillContext {
    const S0 = emptyHardwareState('stmsim')
    const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      this.calls.push(m)
      return this.#inst.call(m, a)
    }
    const ctx = {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.subs.push(name)
        const skill = IMPLEMENTED[name]
        if (skill === undefined) return Promise.resolve({ success: false, error: `注册表里没有 ${name}` })
        return skill.execute(ctx, params)
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'integration',
      rootCallId: 'coarse-composites',
      approvalSource: 'operator',
    } as unknown as SkillContext
    return ctx
  }
}

/** 这台机器**真的**报的驱动幅度 / 频率。闸的两侧都以它为准，不写死 180。 */
let drive: { freqHz: number; ampV: number } | null = null
/** Z 反馈开关在这一组跑之前是什么样 —— 跑完放回去（同 `scan-composites` 的存档/还原）。 */
let zctrlWasOn: boolean | null = null

beforeAll(async () => {
  const rig = await instrument()
  const ctx = rig.ctx()
  const fa = await ctx.safeCall('Motor_FreqAmpGet', 0)
  const v = (fa.values ?? []) as unknown[]
  drive = { freqHz: Number(v[0]), ampV: Number(v[1]) }
  const on = await ctx.safeCall('ZCtrl_OnOffGet')
  zctrlWasOn = Number(((on.values ?? []) as unknown[])[0]) !== 0
  cleanup.splice(0).forEach((fn) => fn())
}, 60_000)

afterAll(async () => {
  if (zctrlWasOn === null) return
  const rig = await instrument()
  // 放回去。模拟器从退针轨合环时会按 I 增益把 Z 伸出去重新找表面 ——
  // 也就是这一组用过的那条路，反着走一次。
  await rig.ctx().safeCall('ZCtrl_OnOffSet', zctrlWasOn ? 1 : 0)
  cleanup.splice(0).forEach((fn) => fn())
}, 60_000)

/** 一台填过的机器。**`xy_prewithdraw_steps: 0`** ⇒ 清障阶梯为空 ⇒ 一步粗动都不发。 */
function profile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    retract_motor_dir: 'z+',
    z_extend_sign: '-1',
    z_recede_min_nm: 1.0,
    z_settle_timeout_s: 8.0,
    xy_prewithdraw_steps: 0,
    xy_move_chunk_steps: 10,
    ...extra,
  }
}

const RELOCATE = { axis: 'x', direction: '+', steps: 20, prewithdraw_steps: 0, dry_run: true }

describe('粗动驱动读回闸 · 对真 stmsim', () => {
  it('**本机上限未声明 ⇒ 拒绝**，而且只发了那一次读', async () => {
    processInstrumentProfile.source = profile
    processCoarseDrive.source = null
    processVacuum.config = { mode: 'off' }
    const rig = await instrument()
    const res = await IMPLEMENTED['RelocateCoarseXY']!.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('尚未声明')
    expect(rig.calls).toEqual(['Motor_FreqAmpGet'])
  }, 60_000)

  it('声明一个**低于本机实际驱动电压**的上限 ⇒ 拿真读数拒，并把两个数都印出来', async () => {
    const real = drive!
    processInstrumentProfile.source = profile
    processCoarseDrive.source = () => ({ max_amplitude_v: Math.floor(real.ampV / 2) })
    processVacuum.config = { mode: 'off' }
    const rig = await instrument()
    const res = await IMPLEMENTED['RelocateCoarseXY']!.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('高于本机声明上限')
    // **真读数**进了报文 —— 这一步是这条缝独有的：金样那侧喂的是合成回包。
    expect(res.error).toContain(String(real.ampV))
    expect(res.error).toContain(String(Math.floor(real.ampV / 2)))
    // ⚠️ 前置检查那张 `checks` 表在**拒绝路径上不进最终 data**（`#checks` 只在整段
    // preflight 走完之后才赋值，旧仓同）。于是拒绝时全部诊断只在 error 那一句里 ——
    // 这是照移，不是改进；登记见交接 §3。
    expect(res.data?.['checks']).toEqual({})
  }, 60_000)

  it('声明的期望频率与本机不符 ⇒ **警告但放行**（它让里程表漂，不会烧叠堆）', async () => {
    const real = drive!
    processInstrumentProfile.source = profile
    processCoarseDrive.source = () => ({
      max_amplitude_v: real.ampV * 2,
      expected_frequency_hz: real.freqHz * 3,
    })
    processVacuum.config = { mode: 'off' }
    const rig = await instrument()
    const res = await IMPLEMENTED['RelocateCoarseXY']!.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(true)
    const drv = (res.data?.['checks'] as Record<string, unknown>)['drive'] as Record<string, unknown>
    expect(drv['ok']).toBe(true)
    expect(String(drv['note'])).toContain('里程表会漂')
  }, 60_000)
})

describe('RelocateCoarseXY · 完整相链对真 stmsim（不动马达）', () => {
  it('preflight → clear → move(dry) → verify，四个相全过', async () => {
    const real = drive!
    processInstrumentProfile.source = profile
    processCoarseDrive.source = () => ({ max_amplitude_v: real.ampV * 2 })
    processVacuum.config = { mode: 'off' }
    const rig = await instrument()
    const res = await IMPLEMENTED['RelocateCoarseXY']!.execute(rig.ctx(), RELOCATE)
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    // **一步粗动都没发** —— `prewithdraw_steps: 0` 让阶梯为空，`dry_run` 让横移不发。
    expect(rig.calls).not.toContain('Motor_StartMove')
    // 排练命令不了任何东西，所以里程表的入场券是 0。
    expect(res.data?.['lateral_steps_taken']).toBe(0)
    expect(res.data?.['steps']).toBe(20)
    expect(res.data?.['dry_run']).toBe(true)
    // 反馈是真的被关掉了（横移期间开着会让压电去追滑过去的表面）。
    expect(rig.calls).toContain('ZCtrl_OnOffSet')
    expect(rig.calls).toContain('ZCtrl_Withdraw')
  }, 120_000)

  it('脱离确认用的是**真电流**，而它在退针之后确实在噪声底', async () => {
    const real = drive!
    processInstrumentProfile.source = profile
    processCoarseDrive.source = () => ({ max_amplitude_v: real.ampV * 2 })
    processVacuum.config = { mode: 'off' }
    const rig = await instrument()
    const res = await IMPLEMENTED['RelocateCoarseXY']!.execute(rig.ctx(), RELOCATE)
    const clearance = res.data?.['clearance'] as Record<string, unknown>
    expect(clearance['clear']).toBe(true)
    expect(typeof clearance['current_a']).toBe('number')
    expect(Math.abs(clearance['current_a'] as number)).toBeLessThan(1e-11)
    // qPlus 那个证人**绝不许把一次好的脱离判成不合格**：它要么同意（true），
    // 要么弃权（null）。「答不了」不该有「不合格」的权力。
    expect(clearance['qplus_recovered']).not.toBe(false)
    expect(typeof clearance['qplus_note']).toBe('string')
  }, 120_000)

  it('**这台控制器真的不支持步进计数器** ⇒ 如实记录，不是打一个勾', async () => {
    const real = drive!
    processInstrumentProfile.source = profile
    processCoarseDrive.source = () => ({ max_amplitude_v: real.ampV * 2 })
    processVacuum.config = { mode: 'off' }
    const rig = await instrument()
    const res = await IMPLEMENTED['RelocateCoarseXY']!.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(true)
    expect(rig.calls).toContain('Motor_StepCounterGet')
    // ⚠️ 旧仓这句话**从来没有离开过那个步骤** —— `run_composite` 的 `data` 里没有它。
    // 本仓把它顶上来（见 `onStepResult`）：一句专门写来防止「打一个安心的勾」的话，
    // 读不到就等于没写。
    const counter = res.data?.['step_counter'] as Record<string, unknown>
    expect(counter['counter']).toBe('unavailable')
    expect(String(counter['note'])).toContain('仅 Attocube ANC150 支持')
    expect(String(counter['note'])).toContain('这是如实记录,不是通过')
  }, 120_000)

  it('真空互锁转为拒绝时 ⇒ 停在第一道闸，**一次硬件读都不发**', async () => {
    processInstrumentProfile.source = profile
    processCoarseDrive.source = () => ({ max_amplitude_v: 400 })
    // 读不到压强 = fail-closed（一只看不见的规，与一只在放电带里的规没有区别）。
    processVacuum.source = () => null
    const rig = await instrument()
    const res = await IMPLEMENTED['RelocateCoarseXY']!.execute(rig.ctx(), RELOCATE)
    expect(res.success).toBe(false)
    expect(res.error).toContain('真空互锁拒绝粗动')
    expect(rig.calls).toEqual([])
  }, 60_000)
})

describe('StepCoarseXY · 对真 stmsim', () => {
  it('转调 `RelocateCoarseXY(allow_revisit=true)` 并走完同一条相链', async () => {
    const real = drive!
    processInstrumentProfile.source = profile
    processCoarseDrive.source = () => ({ max_amplitude_v: real.ampV * 2 })
    processVacuum.config = { mode: 'off' }
    const rig = await instrument()
    const res = await IMPLEMENTED['StepCoarseXY']!.execute(rig.ctx(), {
      axis: 'y', direction: '-', steps: 2, prewithdraw_steps: 0, dry_run: true,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    expect(rig.subs).toEqual(['RelocateCoarseXY'])
    expect(res.data?.['delegated_to']).toBe('RelocateCoarseXY')
    expect(res.data?.['allow_revisit']).toBe(true)
    expect(rig.calls).not.toContain('Motor_StartMove')
  }, 120_000)

  it('超过用途上限 ⇒ 拒绝，一次调用都不发', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['StepCoarseXY']!.execute(rig.ctx(), {
      axis: 'x', direction: '+', steps: 61,
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('那是换区')
    expect(rig.calls).toEqual([])
  }, 60_000)
})

describe('`settleAndReadZ` · 在一台真的会走的反馈环上', () => {
  it('从退针轨合环 ⇒ **等到 Z 不再走**再读，而不是读一个还在爬的数', async () => {
    processInstrumentProfile.source = profile
    const rig = await instrument()
    const settle = await settleAndReadZ(rig.ctx(), { pollIntervalS: 0.05, windowN: 5 })
    // 2026-08-04 的缺陷是「固定睡 1.5 s 然后读」—— 读到的是斜坡上的一点。
    // 这一条要的就是：在一台真的会爬的环上，它**收敛了**。
    expect(zSettleUsable(settle), zSettleWhy(settle)).toBe(true)
    expect(settle.state === 'tracking' || settle.state === 'out_of_range').toBe(true)
    expect(settle.zM).not.toBeNull()
    // 判据测的是**净漂移**，而它必须落在收敛带里（band = 阈值的一半 = 0.5 nm）。
    expect(settle.driftM).not.toBeNull()
    expect(Math.abs(settle.driftM as number)).toBeLessThanOrEqual(settle.tolM)
    // 至少走完了一个窗口 —— 一个窗口都没满就「收敛」正是那个差一错。
    expect(settle.samples).toBeGreaterThanOrEqual(5)
    // 这条路上一步粗动都没有。
    expect(rig.calls).not.toContain('Motor_StartMove')
  }, 120_000)

  it('`ZCtrl_OnOffGet` 只进台账、**不当闸**（实时控制器按设计滞后于写入）', async () => {
    processInstrumentProfile.source = profile
    const rig = await instrument()
    const settle = await settleAndReadZ(rig.ctx(), { pollIntervalS: 0.05, windowN: 5 })
    expect(rig.calls).toContain('ZCtrl_OnOffGet')
    // 读到什么都行 —— 它只让一次超时能说出「反馈到底合没合上」。
    expect([true, false, null]).toContain(settle.loopConfirmedOn)
  }, 120_000)
})

describe('ReadCalibrations · 对真 stmsim', () => {
  it('**零 TCP**：它读的是进程内的档案，一条硬件调用都不发', async () => {
    processInstrumentProfile.source = () => ({
      tilt_cal_g11: 1, tilt_cal_g12: 0, tilt_cal_g21: 0, tilt_cal_g22: 1,
      tilt_cal_cond: 1.02, tilt_cal_updated_at: 1_699_000_000,
    })
    const rig = await instrument()
    const res = await IMPLEMENTED['ReadCalibrations']!.execute(rig.ctx(), {})
    expect(res.success).toBe(true)
    expect(rig.calls).toEqual([])
    expect((res.data?.['tilt'] as Record<string, unknown>)['available']).toBe(true)
    // 没接档案时它说的是另一句话 —— 这一批的全部要害。
    processInstrumentProfile.source = null
    const none = await IMPLEMENTED['ReadCalibrations']!.execute(rig.ctx(), {})
    expect(String((none.data?.['tilt'] as Record<string, unknown>)['why'])).toContain('读不到仪器档案')
  }, 60_000)
})
