/**
 * Z 稳定判据 + **两台方向判定机**对 `spec/golden/z_settle.json` 逐格比。
 *
 * 金样由旧仓真实的 `_z_settle.ZSettle` / `RetractForSampleChange._judge_recede` /
 * `RelocateCoarseXY._judge_recede` 录制（`tools/spec-export/export_z_settle.py`）。
 *
 * **两台判定机都录、都比。** 它们在旧仓就是两个函数，措辞与电流那一支的判法都不同；
 * 谁把它们合并了，这份金样会当场变红（同 D-CHANNELS-1 / D-PIEZO-1 —— 两个看起来
 * 一样的东西，正是将来有人重构时最想合并的东西）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { processInstrumentProfile } from './instrument-profile.js'
import {
  DEFAULT_POLL_S,
  DEFAULT_WINDOW_N,
  TOL_FRACTION_OF_THRESHOLD,
  Z_NOISE_FLOOR_A,
  Z_SETTLE_STATE_LABELS,
  approachPrescription,
  clearanceLadder,
  judgeRecedeClearance,
  judgeRecedeLadder,
  newZSettle,
  noDisplacement,
  retractLadder,
  settleTimeoutS,
  settleToleranceM,
  zConverged,
  zSettleDict,
  zSettleMeasuresGap,
  zSettleUsable,
  type ClearanceRung,
  type ZSettle,
  type ZSettleState,
} from './z-settle.js'

const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/z_settle.json', import.meta.url)), 'utf8'),
) as {
  constants: Record<string, unknown>
  budget: Record<string, { timeout_s: number; tolerance_m: number }>
  states: Record<string, Record<string, unknown>>
  judge_ladder: Record<string, { verdict: string; why: string }>
  judge_clearance: Record<string, { verdict: string; why: string }>
  no_displacement: Record<string, { stuck: boolean; why: string }>
  approach_prescription: Record<string, string>
  retract_ladder: Record<string, number[]>
  clearance_ladder: Record<string, number[]>
}

/** 与导出那侧的 `_settle(**kw)` 逐字同形（默认 `tol_m` / `timeout_s` 也一样）。 */
function st(kw: Partial<ZSettle>): ZSettle {
  return { ...newZSettle(5e-10, 20.0), ...kw }
}

const STATES: Record<string, ZSettle> = {
  tracking: st({ zM: 1.0e-7, currentA: 1.2e-10, setpointA: 1.0e-10, settled: true,
    state: 'tracking', elapsedS: 4.3, samples: 43, driftM: 1e-13, excursionM: 4.7e-8,
    loopConfirmedOn: true }),
  at_rail: st({ zM: -1.5e-6, currentA: 1e-14, setpointA: 1.0e-10, settled: true,
    state: 'out_of_range', elapsedS: 5.4, samples: 54, driftM: 0.0, excursionM: 3.24e-7,
    loopConfirmedOn: true }),
  moving: st({ zM: 4.658e-7, currentA: 1e-13, setpointA: 1.0e-10, settled: false,
    state: 'moving', elapsedS: 20.0, samples: 200, driftM: 5.5e-8, excursionM: 4.65e-7,
    loopConfirmedOn: true }),
  moving_loop_off: st({ zM: 1.0e-7, settled: false, state: 'moving', elapsedS: 20.0,
    samples: 200, driftM: 3e-9, loopConfirmedOn: false }),
  moving_loop_unknown: st({ zM: 1.0e-7, settled: false, state: 'moving', elapsedS: 20.0,
    samples: 200, driftM: 3e-9, loopConfirmedOn: null }),
  moving_one_sample: st({ zM: 1.0e-7, settled: false, state: 'moving', elapsedS: 20.0,
    samples: 1, driftM: null }),
  unreadable: st({ settled: false, state: 'unreadable', elapsedS: 0.6, samples: 5,
    loopConfirmedOn: true }),
  aborted: st({ settled: false, state: 'aborted', elapsedS: 1.2, samples: 12 }),
  tracking_no_setpoint_err: st({ zM: 1.0e-7, currentA: 1.2e-10, setpointA: null,
    setpointWhy: 'ZCtrl_SetpntGet 报错:模拟故障：连接被对端关闭', settled: true,
    state: 'tracking', elapsedS: 4.3, samples: 43, driftM: 0.0, excursionM: 4.7e-8,
    loopConfirmedOn: true }),
  tracking_no_setpoint_unparsable: st({ zM: 1.0e-7, currentA: 1.2e-10, setpointA: null,
    setpointWhy: 'ZCtrl_SetpntGet 回包读不懂(shape=list,repr 前 120 字:[])', settled: true,
    state: 'tracking', elapsedS: 4.3, samples: 43, driftM: 0.0, excursionM: 4.7e-8,
    loopConfirmedOn: true }),
}

const B_TRACK = st({ zM: 1.0e-7, currentA: 1.2e-10, setpointA: 1.0e-10, settled: true,
  state: 'tracking', elapsedS: 4.0, samples: 40, driftM: 0.0, excursionM: 1e-8,
  loopConfirmedOn: true })
const A_RECEDE = st({ zM: 1.0e-7 - 47.67e-9, currentA: 5.4e-14, setpointA: 1.0e-10,
  settled: true, state: 'tracking', elapsedS: 4.1, samples: 41, driftM: 0.0,
  excursionM: 4.8e-8, loopConfirmedOn: true })
const A_APPROACH = st({ zM: 1.0e-7 + 20e-9, currentA: 5.4e-14, setpointA: 1.0e-10,
  settled: true, state: 'tracking', elapsedS: 4.1, samples: 41, driftM: 0.0,
  excursionM: 2.1e-8, loopConfirmedOn: true })
const A_FLAT = st({ zM: 1.0e-7 + 0.2e-9, currentA: 5.4e-14, setpointA: 1.0e-10,
  settled: true, state: 'tracking', elapsedS: 4.1, samples: 41, driftM: 0.0,
  excursionM: 3e-10, loopConfirmedOn: true })
const B_RAIL = st({ zM: -1.5e-6, currentA: 1e-14, setpointA: 1.0e-10, settled: true,
  state: 'out_of_range', elapsedS: 5.0, samples: 50, driftM: 0.0, excursionM: 3e-7,
  loopConfirmedOn: true })
const A_RAIL = B_RAIL
const A_RAIL_FAR = st({ zM: -1.6e-6, currentA: 1e-14, setpointA: 1.0e-10, settled: true,
  state: 'out_of_range', elapsedS: 5.0, samples: 50, driftM: 0.0, excursionM: 3e-7,
  loopConfirmedOn: true })
const A_HOT = st({ zM: 1.0e-7, currentA: 5e-9, setpointA: 1.0e-10, settled: true,
  state: 'tracking', elapsedS: 4.1, samples: 41, driftM: 0.0, excursionM: 1e-8,
  loopConfirmedOn: true })
const A_HOT_NO_SP = st({ zM: 1.0e-7, currentA: 5e-9, setpointA: null,
  setpointWhy: 'ZCtrl_SetpntGet 报错:模拟故障：连接被对端关闭', settled: true,
  state: 'tracking', elapsedS: 4.1, samples: 41, driftM: 0.0, excursionM: 1e-8,
  loopConfirmedOn: true })
const A_WARM = st({ zM: 1.0e-7 - 47.67e-9, currentA: 2e-10, setpointA: 1.0e-10,
  settled: true, state: 'tracking', elapsedS: 4.1, samples: 41, driftM: 0.0,
  excursionM: 4.8e-8, loopConfirmedOn: true })
const B_TRACK_NO_SP = st({ zM: 1.0e-7, currentA: 1.2e-10, setpointA: null,
  setpointWhy: 'ZCtrl_SetpntGet 报错:模拟故障：连接被对端关闭', settled: true,
  state: 'tracking', elapsedS: 4.0, samples: 40, driftM: 0.0, excursionM: 1e-8,
  loopConfirmedOn: true })

const DECLARED: Record<string, unknown> = { z_extend_sign: '-1', z_recede_min_nm: 1.0 }
const NO_SIGN: Record<string, unknown> = { z_recede_min_nm: 1.0 }

/** 与 `export_z_settle.py` 的 `PAIRS` **逐条同形**。 */
const PAIRS: [string, ZSettle | null, ZSettle, Record<string, unknown>][] = [
  ['receding', B_TRACK, A_RECEDE, DECLARED],
  ['approaching_by_z', B_TRACK, A_APPROACH, DECLARED],
  ['ambiguous_flat', B_TRACK, A_FLAT, DECLARED],
  ['both_rail_ambiguous', B_RAIL, A_RAIL, DECLARED],
  ['rail_after_receding', B_TRACK, A_RAIL_FAR, DECLARED],
  ['rail_baseline_then_found', B_RAIL, A_APPROACH, DECLARED],
  ['unsettled_after', B_TRACK, STATES['moving']!, DECLARED],
  ['unsettled_baseline', STATES['moving']!, A_RECEDE, DECLARED],
  ['no_baseline', null, A_RECEDE, DECLARED],
  ['no_sign', B_TRACK, A_RECEDE, NO_SIGN],
  ['current_trip_absolute_floor', B_TRACK, A_HOT, DECLARED],
  ['current_trip_relative', B_TRACK, A_WARM, DECLARED],
  ['current_no_setpoint_anywhere', B_TRACK_NO_SP, A_HOT_NO_SP, DECLARED],
  ['current_no_setpoint_full_scale_ok', B_TRACK_NO_SP, A_HOT_NO_SP,
    { ...DECLARED, preamp_full_scale_a: 1e-8 }],
  ['current_no_setpoint_full_scale_hit', B_TRACK_NO_SP, A_HOT_NO_SP,
    { ...DECLARED, preamp_full_scale_a: 1e-9 }],
]

function install(profile: Record<string, unknown>): void {
  processInstrumentProfile.source = () => profile
}

afterEach(() => {
  processInstrumentProfile.source = null
})

describe('Z 稳定 · 常量', () => {
  it('逐个对旧仓', () => {
    expect(Z_NOISE_FLOOR_A).toBe(G.constants['noise_floor_a'])
    expect(TOL_FRACTION_OF_THRESHOLD).toBe(G.constants['tol_fraction_of_threshold'])
    expect(DEFAULT_POLL_S).toBe(G.constants['default_poll_s'])
    expect(DEFAULT_WINDOW_N).toBe(G.constants['default_window_n'])
    expect(Z_SETTLE_STATE_LABELS).toEqual(G.constants['state_labels'])
  })
})

describe('Z 稳定 · 预算与收敛带', () => {
  const profiles: Record<string, Record<string, unknown>> = {
    empty: {}, declared: DECLARED,
    custom: { z_recede_min_nm: 2.5, z_settle_timeout_s: 9.0 },
  }
  for (const [name, want] of Object.entries(G.budget)) {
    it(name, () => {
      install(profiles[name]!)
      expect(settleTimeoutS()).toBe(want.timeout_s)
      expect(settleToleranceM()).toBeCloseTo(want.tolerance_m, 20)
    })
  }

  it('收敛带**从决策阈值派生** —— 调高阈值自动配一条更宽的带', () => {
    install({ z_recede_min_nm: 4.0 })
    expect(settleToleranceM()).toBeCloseTo(2e-9, 20)
    // 而它必须比阈值紧，否则一个「已稳定」的读数仍能漂够翻转它要喂的那个结论。
    expect(settleToleranceM()).toBeLessThan(4e-9)
  })
})

describe('Z 稳定 · 每一种读数形状的 `as_dict`', () => {
  for (const [name, want] of Object.entries(G.states)) {
    it(name, () => {
      expect(zSettleDict(STATES[name]!)).toEqual(want)
    })
  }

  it('`usable` 只认收敛了的两态；`measuresGap` 更窄，只认握着结的那一种', () => {
    expect(zSettleUsable(STATES['tracking']!)).toBe(true)
    expect(zSettleUsable(STATES['at_rail']!)).toBe(true)
    expect(zSettleUsable(STATES['moving']!)).toBe(false)
    // 到轨的读数**可用**（能比、能揭示一次逼近），但它不是一把尺子：
    // 两个界分不出「台子移出了量程」和「台子根本没动」。
    expect(zSettleMeasuresGap(STATES['at_rail']!)).toBe(false)
    expect(zSettleMeasuresGap(STATES['tracking']!)).toBe(true)
  })
})

describe('Z 稳定 · 收敛判据（`zConverged`）', () => {
  it('窗口静止 + 有隧道结 ⇒ tracking', () => {
    expect(zConverged(1e-13, 5e-10, 1.2e-10, 1e-8)).toEqual({ settled: true, state: 'tracking' })
  })
  it('窗口静止 + 电流在底噪 + 压电确实走过 ⇒ out_of_range', () => {
    expect(zConverged(1e-13, 5e-10, 1e-14, 1e-8)).toEqual({ settled: true, state: 'out_of_range' })
  })
  it('**一个还没开始跑的环也是不动的** ⇒ 既没电流也没走过 ⇒ 不算收敛', () => {
    expect(zConverged(0.0, 5e-10, 1e-14, 0.0)).toEqual({ settled: false, state: null })
    expect(zConverged(0.0, 5e-10, null, 0.0)).toEqual({ settled: false, state: null })
  })
  it('还在走 ⇒ 不算收敛（哪怕有隧道结）', () => {
    expect(zConverged(5.5e-8, 5e-10, 1.2e-10, 4e-7)).toEqual({ settled: false, state: null })
  })
})

describe('Z 稳定 · 梯子版方向判定（`RetractForSampleChange`）', () => {
  for (const [name, base, after, profile] of PAIRS) {
    it(name, () => {
      install(profile)
      const sp = base === null ? null : base.setpointA
      const got = judgeRecedeLadder(base, after, sp)
      expect({ verdict: got.verdict, why: got.why }).toEqual(G.judge_ladder[name])
    })
  }
})

describe('Z 稳定 · 清障版方向判定（`RelocateCoarseXY`）', () => {
  for (const [name, base, after, profile] of PAIRS) {
    const want = G.judge_clearance[name]!
    if (want.verdict === 'n/a') continue
    it(name, () => {
      install(profile)
      const got = judgeRecedeClearance(base!, after)
      expect({ verdict: got.verdict, why: got.why }).toEqual(want)
    })
  }

  it('**两台判定机刻意不是同一台** —— 至少一格上它们的措辞不同', () => {
    const differing = Object.keys(G.judge_ladder).filter(
      (k) => G.judge_clearance[k]?.verdict !== 'n/a' && G.judge_ladder[k]?.why !== G.judge_clearance[k]?.why,
    )
    expect(differing.length).toBeGreaterThan(0)
    // 而最要紧的那一格：读不到 setpoint 时，梯子版拿**照成像条件定的绝对地板**去判，
    // 清障版改用一个与工作点无关的界、或者干脆**不判电流**并把这件事写进结论。
    // 2026-08-10 真机上正是前者把一次正常退针判成了「方向搞反」。
    expect(G.judge_ladder['current_no_setpoint_anywhere']?.verdict).toBe('approaching')
    expect(G.judge_clearance['current_no_setpoint_anywhere']?.verdict).toBe('ambiguous')
    expect(G.judge_clearance['current_no_setpoint_anywhere']?.why).toContain('**没判**')
  })
})

describe('Z 稳定 · 「测出来是零」那道守卫', () => {
  const RUNGS: Record<string, ClearanceRung[]> = {
    empty: [],
    no_ruler_abstains: [{ hasRuler: false, dzM: 0.0 }],
    mixed_ruler_abstains: [{ hasRuler: true, dzM: 0.0 }, { hasRuler: false, dzM: 0.0 }],
    dz_none_abstains: [{ hasRuler: true, dzM: null }],
    moved_ok: [{ hasRuler: true, dzM: 1e-9 }, { hasRuler: true, dzM: 4.7e-8 }],
    stuck: [{ hasRuler: true, dzM: 1e-10 }, { hasRuler: true, dzM: 2e-10 }],
    stuck_exactly_at_threshold: [{ hasRuler: true, dzM: 1e-9 }],
    negative_dz_uses_abs: [{ hasRuler: true, dzM: -2e-10 }],
  }
  const COMMANDED: Record<string, number> = { negative_dz_uses_abs: 111 }
  for (const [name, want] of Object.entries(G.no_displacement)) {
    it(name, () => {
      install(DECLARED)
      expect(noDisplacement(RUNGS[name]!, COMMANDED[name] ?? 11)).toEqual(want)
    })
  }

  it('**没尺子就没有意见** —— 到轨的那种梯子不可能误报', () => {
    install(DECLARED)
    // 一根起点就在压电量程外的针：每一级都合法地 ambiguous，而马达工作得好好的。
    expect(noDisplacement([{ hasRuler: false, dzM: 0 }, { hasRuler: false, dzM: 0 }], 11).stuck)
      .toBe(false)
  })
})

describe('Z 稳定 · 拒绝时的处方按证据分岔', () => {
  const WHY: Record<string, string> = {
    from_z: 'Z 压电缩回 20.0 nm',
    from_current_floor:
      '电流 5e-09 A 高于阈值 1e-09 A(由**绝对地板**决定:setpoint 读到 1e-10 A,' +
      '相对项 3e-10 A,地板 1e-09 A);读数已收敛',
    from_current_relative:
      '电流 2e-10 A 高于阈值 3e-10 A(由**相对项 3×setpoint**决定:...);读数已收敛',
    from_current_unsettled:
      '电流 5e-09 A 高于阈值 1e-09 A(由**绝对地板**决定:...);⚠️ **这次读数未收敛**(超时)',
  }
  for (const [name, want] of Object.entries(G.approach_prescription)) {
    it(name, () => {
      expect(approachPrescription(WHY[name]!)).toBe(want)
    })
  }
})

describe('Z 稳定 · 两条梯子', () => {
  for (const [key, want] of Object.entries(G.retract_ladder)) {
    it(`retract ${key}`, () => {
      const [total, stepMax] = key.split('@').map(Number) as [number, number]
      expect(retractLadder(total, stepMax)).toEqual(want)
    })
  }
  for (const [key, want] of Object.entries(G.clearance_ladder)) {
    it(`clearance ${key}`, () => {
      expect(clearanceLadder(Number(key))).toEqual(want)
    })
  }

  it('**第一级永远是一步** —— 最小风险探针（够得着的总数下）', () => {
    for (const total of [1, 5, 11, 111, 3000]) {
      expect(retractLadder(total, 1000)[0]).toBe(1)
      expect(clearanceLadder(total)[0]).toBe(1)
    }
  })
})

describe('Z 稳定 · 五种结局的人话都不是空的', () => {
  for (const name of Object.keys(Z_SETTLE_STATE_LABELS) as ZSettleState[]) {
    it(name, () => {
      expect(Z_SETTLE_STATE_LABELS[name]).not.toBe('')
    })
  }
})
