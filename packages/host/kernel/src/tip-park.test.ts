/**
 * 退针到位判定的网格金样。
 *
 * 判据必须是网格，不能挑几个点：结论是**三态**，而 `unreadable` 里还要再分两种
 * 成因（读失败 vs 本机没声明过），它们的处置**完全相反**。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MODULE_STATUS,
  NOT_PARKED,
  PARKED,
  RAIL_TOL_FRAC,
  UNREADABLE,
  isParked,
  parkEvidence,
  parkVerdictFromReadings,
  resolveZTravel,
  retryUseful,
  type ZTravel,
} from './tip-park.js'

interface TravelCase {
  input: {
    piezo_z_full_m: number | null
    z_limits_m: number[] | null
    z_limits_enabled: boolean | null
  }
  travel: { lo_m: number; hi_m: number; span_m: number; source: string } | null
}
interface VerdictCase {
  input: Record<string, unknown>
  state: string
  reason: string
  is_parked: boolean
  retry_useful: boolean
  evidence: string
  feedback_on: boolean | null
  module_status: string | null
  z_m: number | null
  rail_m: number | null
  rail_side: string | null
  gap_m: number | null
  tolerance_m: number | null
  travel_source: string | null
  unreadable: string[]
  undeclared: string[]
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/tip_park.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    PARKED: string
    NOT_PARKED: string
    UNREADABLE: string
    rail_tol_frac: number
    module_status: Record<string, string>
  }
  travel: Record<string, TravelCase>
  verdicts: Record<string, VerdictCase>
}

describe('常量表', () => {
  it('三态名字与码表逐字相等', () => {
    expect([PARKED, NOT_PARKED, UNREADABLE]).toEqual([
      golden.constants.PARKED,
      golden.constants.NOT_PARKED,
      golden.constants.UNREADABLE,
    ])
    expect(RAIL_TOL_FRAC).toBe(golden.constants.rail_tol_frac)
    expect(Object.fromEntries(Object.entries(MODULE_STATUS))).toEqual(
      golden.constants.module_status,
    )
  })
})

describe('resolveZTravel —— 全仓唯一的一份 Z 行程算法', () => {
  for (const [name, c] of Object.entries(golden.travel)) {
    it(`${name}`, () => {
      const got = resolveZTravel({
        piezoZFullM: c.input.piezo_z_full_m,
        zLimitsM: c.input.z_limits_m,
        zLimitsEnabled: c.input.z_limits_enabled,
      })
      expect(got).toEqual(c.travel)
    })
  }

  it('软限**未启用**时那对数字不拦任何东西', () => {
    // 手册原话 "has no effect"。对着它算的「Z 逼近量程」告警，
    // 顶死在行程尽头时**不可能响**。
    const off = resolveZTravel({
      piezoZFullM: 720e-9,
      zLimitsM: [-100e-9, 100e-9],
      zLimitsEnabled: false,
    })
    const on = resolveZTravel({
      piezoZFullM: 720e-9,
      zLimitsM: [-100e-9, 100e-9],
      zLimitsEnabled: true,
    })
    expect(off?.span_m).toBe(720e-9)
    expect(on?.span_m).toBe(200e-9)
  })

  it('**没问过**按未启用处理 —— 不知道启没启用时拿它当边界就是猜', () => {
    expect(
      resolveZTravel({ piezoZFullM: 720e-9, zLimitsM: [-100e-9, 100e-9], zLimitsEnabled: null })
        ?.span_m,
    ).toBe(720e-9)
  })

  it('读不到任何一条 ⇒ null，**绝不给一个猜的量程**', () => {
    expect(resolveZTravel({ piezoZFullM: null, zLimitsM: null, zLimitsEnabled: null })).toBeNull()
    expect(resolveZTravel({ piezoZFullM: 0 })).toBeNull()
  })
})

describe('parkVerdictFromReadings —— 17 格逐条对旧仓', () => {
  const travelOf = (v: unknown): ZTravel | null =>
    v === null || v === undefined ? null : (v as ZTravel)

  for (const [name, c] of Object.entries(golden.verdicts)) {
    it(`${name}：结论、文案、证据都相等`, () => {
      const got = parkVerdictFromReadings({
        feedbackOn: (c.input['feedback_on'] ?? null) as boolean | null,
        moduleStatus: (c.input['module_status'] ?? null) as string | null,
        zM: (c.input['z_m'] ?? null) as number | null,
        travel: travelOf(c.input['travel']),
        zExtendSign: (c.input['z_extend_sign'] ?? null) as number | null,
        unreadable: (c.input['unreadable'] ?? []) as readonly string[],
        readAt: 0,
      })
      expect(got.state).toBe(c.state)
      expect(got.reason).toBe(c.reason)
      expect(isParked(got)).toBe(c.is_parked)
      expect(retryUseful(got)).toBe(c.retry_useful)
      expect(parkEvidence(got)).toBe(c.evidence)
      expect({
        feedback_on: got.feedback_on,
        module_status: got.module_status,
        z_m: got.z_m,
        rail_m: got.rail_m,
        rail_side: got.rail_side,
        gap_m: got.gap_m,
        tolerance_m: got.tolerance_m,
        travel_source: got.travel_source,
        unreadable: [...got.unreadable],
        undeclared: [...got.undeclared],
      }).toEqual({
        feedback_on: c.feedback_on,
        module_status: c.module_status,
        z_m: c.z_m,
        rail_m: c.rail_m,
        rail_side: c.rail_side,
        gap_m: c.gap_m,
        tolerance_m: c.tolerance_m,
        travel_source: c.travel_source,
        unreadable: c.unreadable,
        undeclared: c.undeclared,
      })
    })
  }
})

describe('这台判定机存在的三个理由', () => {
  const RT = resolveZTravel({ piezoZFullM: 720e-9 })!

  it('**同一个读数、相反的符号、相反的结论** —— 所以不许猜', () => {
    // 猜错方向会把「针顶在伸长端(朝样品那一侧)」判成已退针。
    const at = (sign: number, zM: number): string =>
      parkVerdictFromReadings({
        feedbackOn: false,
        moduleStatus: 'Off',
        zM,
        travel: RT,
        zExtendSign: sign,
        readAt: 0,
      }).state
    expect(at(-1, 360e-9)).toBe(PARKED)
    expect(at(1, 360e-9)).toBe(NOT_PARKED)
    expect(at(-1, -360e-9)).toBe(NOT_PARKED)
    expect(at(1, -360e-9)).toBe(PARKED)
  })

  it('没声明过 ⇒ `retryUseful` 为 false —— 再轮询是**白等**', () => {
    // 调用方应当立刻停止轮询并如实说是配置缺口，
    // 而不是耗光预算再报一个看起来像超时的东西。
    const v = parkVerdictFromReadings({
      feedbackOn: false,
      moduleStatus: 'Off',
      zM: 360e-9,
      travel: RT,
      zExtendSign: null,
      readAt: 0,
    })
    expect(v.state).toBe(UNREADABLE)
    expect(retryUseful(v)).toBe(false)
    // 读失败那一种相反：再等一下有意义
    const w = parkVerdictFromReadings({
      feedbackOn: null,
      moduleStatus: 'Off',
      zM: 360e-9,
      travel: RT,
      zExtendSign: -1,
      readAt: 0,
    })
    expect(w.state).toBe(UNREADABLE)
    expect(retryUseful(w)).toBe(true)
  })

  it('`Withdrawing` 是**过程**，不是那个状态 —— 而且它不需要行程就能定死', () => {
    const v = parkVerdictFromReadings({
      feedbackOn: false,
      moduleStatus: 'Withdrawing',
      zM: null,
      travel: null,
      zExtendSign: null,
      readAt: 0,
    })
    expect(v.state).toBe(NOT_PARKED)
    // **确定的否定比一个 unreadable 有用得多**：没有行程也没有符号，照样给得出结论
    expect(v.undeclared).toEqual([])
  })

  it('容差是**派生的**：行程随温度腰斩，写死一个纳米数在其中一档上就是错的', () => {
    const rt = parkVerdictFromReadings({
      feedbackOn: false, moduleStatus: 'Off', zM: 0, travel: RT, zExtendSign: -1, readAt: 0,
    })
    const lhe = parkVerdictFromReadings({
      feedbackOn: false, moduleStatus: 'Off', zM: 0,
      travel: resolveZTravel({ piezoZFullM: 339e-9 })!, zExtendSign: -1, readAt: 0,
    })
    expect(rt.tolerance_m).toBeCloseTo(7.2e-9, 12)
    expect(lhe.tolerance_m).toBeCloseTo(3.39e-9, 12)
  })

  it('`isParked` **故意不承担三态** —— 免得有人拿 `!isParked` 当「确认没退到」', () => {
    const unknown = parkVerdictFromReadings({
      feedbackOn: null, moduleStatus: null, zM: null, travel: null, zExtendSign: -1, readAt: 0,
    })
    expect(unknown.state).toBe(UNREADABLE)
    expect(isParked(unknown)).toBe(false) // ← 和 not_parked 一样是 false
  })
})
