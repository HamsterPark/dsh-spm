/**
 * `tilt-loop.ts`（调平闭环的判定核心）+ `formatSiReadable` + 档案的**写口**
 * 对 `spec/golden/tilt.json` 的逐格比对。
 *
 * ## 容差
 *
 * | 节 | 容差 | 出处 |
 * |---|---|---|
 * | `tiltThresholds` / `tiltDelta` / `clampTiltAxis` / `tiltSubSteps` | **0** | 全是乘、加、`min`、`ceil` —— 闭式，两边同一串运算 |
 * | `cond2x2` | {@link TILT_COND_REL_TOL} | 对面是 LAPACK `gesdd`，两边各自 `eps·cond` |
 * | `formatSiReadable` | **0**（逐字） | 它的产物是一句**人读的话**，措辞就是契约 |
 * | `setTiltCalibration` 的拒写理由 | **0** | 是非题 |
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCEPT_FRAC_OF_TRIGGER,
  CALIB_RESPONSE_MAX,
  CALIB_RESPONSE_MIN,
  CALIB_STEP_DEG,
  CONVERGENCE_RATIO,
  DEFAULT_K_TOPO,
  DEFAULT_Z_BUDGET_FRAC,
  MAX_ITERATIONS,
  MAX_TILT_STEP_DEG,
  HYPOT_REL_TOL,
  TILT_DET_EPSILON,
  cond2x2RelTol,
  TILT_STEP_SETTLE_S,
  Z_SPAN_HARD_LIMIT_FRAC,
  calibResponseInRange,
  clampTiltAxis,
  cond2x2,
  responseToG,
  tiltConverging,
  tiltDelta,
  tiltSubSteps,
  tiltThresholds,
  type Matrix2,
} from './tilt-loop.js'
import { formatSiReadable } from './si.js'
import {
  TILT_CAL_MAX_COND,
  getTiltCalibration,
  processInstrumentProfile,
  setTiltCalibration,
} from './instrument-profile.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/tilt.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const num = (v: unknown): number =>
  v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : (v as number)

afterEach(() => {
  processInstrumentProfile.source = null
  processInstrumentProfile.write = null
  processInstrumentProfile.nowS = () => Date.now() / 1000
})

describe('kernel/tilt-loop · 常量', () => {
  it('十一个常量逐字（偏好级，但改一个就是换一套判据）', () => {
    const c = G['constants']
    expect(DEFAULT_Z_BUDGET_FRAC).toBe(c['default_z_budget_frac'])
    expect(DEFAULT_K_TOPO).toBe(c['default_k_topo'])
    expect(Z_SPAN_HARD_LIMIT_FRAC).toBe(c['z_span_hard_limit_frac'])
    expect(ACCEPT_FRAC_OF_TRIGGER).toBe(c['accept_frac_of_trigger'])
    expect(MAX_TILT_STEP_DEG).toBe(c['max_tilt_step_deg'])
    expect(TILT_STEP_SETTLE_S).toBe(c['tilt_step_settle_s'])
    expect(MAX_ITERATIONS).toBe(c['max_iterations'])
    expect(CONVERGENCE_RATIO).toBe(c['convergence_ratio'])
    expect(CALIB_STEP_DEG).toBe(c['calib_step_deg'])
    expect(CALIB_RESPONSE_MIN).toBe(c['calib_response_min'])
    expect(CALIB_RESPONSE_MAX).toBe(c['calib_response_max'])
    expect(TILT_CAL_MAX_COND).toBe(c['tilt_cal_max_cond'])
  })
})

describe('kernel/tilt-loop · 三条阈（容差 0）', () => {
  for (const [name, c] of Object.entries(G['thresholds'] as Record<string, any>)) {
    it(`${name}`, () => {
      const got = tiltThresholds(c['surface_rms_m'] === null ? null : num(c['surface_rms_m']), num(c['z_range_m']))
      expect(got.trigger).toBe(num(c['trigger']))
      expect(got.accept).toBe(num(c['accept']))
      expect(got.hard).toBe(num(c['hard']))
    })
  }

  it('取的是 `min` 不是 `max` —— 那正是「图明显倾斜」一次也触发不了的那条缺陷', () => {
    const topo = G['thresholds']['topo_wins']
    // `10 × 1e-9 = 1e-8` 小于 `0.05 × 1.5e-6 = 7.5e-8` ⇒ 形貌那一项赢。
    expect(num(topo['trigger'])).toBe(DEFAULT_K_TOPO * 1.0e-9)
    expect(num(topo['trigger'])).toBeLessThan(DEFAULT_Z_BUDGET_FRAC * 1.5e-6)
  })

  it('`0` 与缺省同义（与 D-ZERO-1 刻意相反，理由写在函数上）', () => {
    expect(tiltThresholds(0, 1.5e-6)).toEqual(tiltThresholds(null, 1.5e-6))
    expect(tiltThresholds(-1e-9, 1.5e-6)).toEqual(tiltThresholds(null, 1.5e-6))
  })

  it('`no_action_needed` 里那句空 reason **不可达**：`trigger < hard` 恒成立', () => {
    const cases = G['no_action_reason_unreachable']['cases'] as any[]
    expect(cases.length).toBeGreaterThanOrEqual(15)
    for (const c of cases) {
      expect(c['trigger_lt_hard'], JSON.stringify(c)).toBe(true)
      // 本仓这一侧自己也算一遍，别只信金样。
      const got = tiltThresholds(c['surface_rms_m'] === null ? null : num(c['surface_rms_m']), num(c['z_range_m']))
      expect(got.trigger).toBeLessThan(got.hard)
    }
  })
})

describe('kernel/tilt-loop · 控制律（容差 0）', () => {
  for (const [name, c] of Object.entries(G['control_law'] as Record<string, any>)) {
    it(`${name}`, () => {
      const g = (c['g'] as number[][]).map((r) => r.map(num)) as unknown as Matrix2
      const [dx, dy] = tiltDelta(g, num((c['slope'] as unknown[])[0]), num((c['slope'] as unknown[])[1]))
      expect(dx).toBe(num((c['delta'] as unknown[])[0]))
      expect(dy).toBe(num((c['delta'] as unknown[])[1]))
      // `mag` 走 `hypot` ⇒ D-HYPOT-1（两种语言不是同一个函数，实测差 1 ULP）。
      const mag = Math.hypot(dx, dy)
      const wm = num(c['mag'])
      expect(Math.abs(mag - wm), `mag ${mag} vs ${wm}`).toBeLessThanOrEqual(HYPOT_REL_TOL * Math.abs(wm))
      expect(tiltSubSteps(mag)).toBe(c['n_sub'])
    })
  }

  it('`max(1, …)`：`|Δ| == 0` 时仍然是 1 小步', () => {
    // `ceil(0) == 0` ⇒ 0 小步 = **一次都不写**，却照样走到「复测 → 验收」，
    // 那时报出来的 `applied` 描述的是一次没发生过的施加。
    expect(tiltSubSteps(0)).toBe(1)
    expect(tiltSubSteps(1e-300)).toBe(1)
    expect(tiltSubSteps(MAX_TILT_STEP_DEG)).toBe(1)
    expect(tiltSubSteps(MAX_TILT_STEP_DEG + 1e-12)).toBe(2)
  })

  it('收敛判据是 `<= 上一轮 × 0.7`', () => {
    expect(tiltConverging(0.7, 1.0)).toBe(true)
    expect(tiltConverging(0.7000001, 1.0)).toBe(false)
    expect(tiltConverging(0, 1.0)).toBe(true)
  })
})

describe('kernel/tilt-loop · 单轴限幅（容差 0）', () => {
  for (const [name, c] of Object.entries(G['clamp'] as Record<string, any>)) {
    it(`${name}`, () => {
      const got = clampTiltAxis(num(c['target']), num(c['limit']))
      expect(got.truncated).toBe(c['truncated'])
      expect(got.value).toBe(num(c['value']))
    })
  }

  it('`-0` 的符号不丢（`copysign(limit, -0.0)` 给 `-limit`）', () => {
    // 这一格在旧仓走 `math.copysign`，而 `Math.sign(-0)` 是 `-0`（假值）——
    // 写成 `Math.sign(t) < 0` 会把它当正号。
    expect(clampTiltAxis(-0, 5).truncated).toBe(false)
    expect(clampTiltAxis(-0, 0).value).toBe(-0)
    expect(Object.is(clampTiltAxis(-0, 0).value, -0)).toBe(true)
  })
})

describe('kernel/tilt-loop · 响应矩阵与条件数', () => {
  for (const [name, c] of Object.entries(G['cond2x2'] as Record<string, any>)) {
    it(`cond2x2/${name}`, () => {
      const m = (c['m'] as number[][]).map((r) => r.map(num)) as unknown as Matrix2
      const got = cond2x2(m)
      const w = num(c['cond'])
      if (!Number.isFinite(w)) {
        expect(Number.isFinite(got)).toBe(false)
        return
      }
      // 容差**随条件数走**：向后稳定的两边，`cond` 的相对误差 ≈ `eps·cond`。
      expect(Math.abs(got - w), `${got} vs ${w}`).toBeLessThanOrEqual(cond2x2RelTol(w) * Math.abs(w))
    })
  }

  it('那条容差不是一个常数 —— 近奇异那一格的实测相对差 4.4e−9', () => {
    const c = G['cond2x2']['near_singular']
    const w = num(c['cond'])
    const got = cond2x2((c['m'] as number[][]) as unknown as Matrix2)
    const rel = Math.abs(got - w) / Math.abs(w)
    expect(rel).toBeGreaterThan(1e-10) // 一个常数 1e-14 会在这里红
    expect(rel).toBeLessThanOrEqual(cond2x2RelTol(w))
  })

  it('`responseToG` 的奇异闸：`|det| < 1e-9`', () => {
    expect(responseToG([[1, 1], [1, 1]]).g).toBeNull()
    expect(responseToG([[1, 0], [0, 1e-10]]).g).toBeNull()
    const sol = responseToG([[1, 0], [0, 1]])
    expect(sol.det).toBe(1)
    // G = −M⁻¹：要抵消测到的斜率 s，施加 Δtilt = G·s。
    // （`−(−0/1)` 是 `+0`，两边都是 —— 这一位不是装饰，它决定 `-0` 印不印得出来。）
    expect(sol.g).toEqual([[-1, 0], [0, -1]])
    expect(TILT_DET_EPSILON).toBe(1e-9)
  })

  it('`calibResponseInRange` 两端闭合', () => {
    expect(calibResponseInRange(CALIB_RESPONSE_MIN)).toBe(true)
    expect(calibResponseInRange(CALIB_RESPONSE_MAX)).toBe(true)
    expect(calibResponseInRange(CALIB_RESPONSE_MIN - 1e-12)).toBe(false)
    expect(calibResponseInRange(CALIB_RESPONSE_MAX + 1e-12)).toBe(false)
    expect(calibResponseInRange(NaN)).toBe(false)
  })
})

describe('kernel/si · formatSiReadable（逐字）', () => {
  for (const [name, c] of Object.entries(G['format_si_readable'] as Record<string, any>)) {
    it(`${name}`, () => {
      expect(formatSiReadable(num(c['value']), c['unit'] as string)).toBe(c['text'])
    })
  }

  it('与 `formatSi` **不是**近义词 —— 10 V 不该印成 `10000m`', () => {
    expect(formatSiReadable(10.0, 'V')).toBe('10 V')
    expect(formatSiReadable(0, 'm')).toBe('0 m')
    expect(formatSiReadable(0, '')).toBe('0')
  })

  it('`nan` / `inf` 落到最后那行 `%.4g`，不是「转不了」那条退路', () => {
    expect(formatSiReadable(NaN, 'm')).toBe('nan m')
    expect(formatSiReadable(Infinity, 'm')).toBe('inf m')
    expect(formatSiReadable(-Infinity, 'm')).toBe('-inf m')
  })

  it('转不了的输入原样 `str()` 出去（格式化函数不许把技能带走）', () => {
    expect(formatSiReadable('nope', 'm')).toBe('nope')
    expect(formatSiReadable(null, 'm')).toBe('None')
    expect(formatSiReadable(undefined, 'm')).toBe('None')
    expect(formatSiReadable({}, 'm')).toBe('[object Object]')
  })
})

describe('kernel/instrument-profile · setTiltCalibration', () => {
  function withSink(): { profile: Record<string, unknown>; patches: Record<string, unknown>[] } {
    const profile: Record<string, unknown> = {}
    const patches: Record<string, unknown>[] = []
    processInstrumentProfile.source = () => profile
    processInstrumentProfile.write = (p) => {
      patches.push({ ...p })
      Object.assign(profile, p)
    }
    processInstrumentProfile.nowS = () => 1_700_000_000
    return { profile, patches }
  }

  for (const [name, c] of Object.entries(G['set_tilt_calibration'] as Record<string, any>)) {
    it(`${name}：与旧仓同样的**写 / 不写**`, () => {
      withSink()
      const cond = num(c['cond'])
      const got = setTiltCalibration(c['g'], Number.isNaN(cond) ? NaN : cond)
      const pythonWrote = c['stored'] !== null
      expect(got.ok, JSON.stringify(c)).toBe(pythonWrote)
      if (!pythonWrote) {
        // 没写 ⇒ 档案里一个键都不该多出来（「未写入」这三个字是报文里的承诺）。
        expect(getTiltCalibration().state).toBe('never')
      }
    })
  }

  it('恰好等于上限放行、超一点点拒绝（闭区间）', () => {
    withSink()
    expect(setTiltCalibration([[1, 0], [0, 1]], TILT_CAL_MAX_COND).ok).toBe(true)
    withSink()
    const over = setTiltCalibration([[1, 0], [0, 1]], TILT_CAL_MAX_COND + 1e-9)
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.why).toBe('cond_too_high')
  })

  it('五条拒写理由各一条（旧仓只有一个 `None`，见 deviations）', () => {
    withSink()
    expect((setTiltCalibration('nope', 1) as { why: string }).why).toBe('bad_matrix')
    expect((setTiltCalibration([[1, 0]], 1) as { why: string }).why).toBe('bad_matrix')
    expect((setTiltCalibration([[NaN, 0], [0, 1]], 1) as { why: string }).why).toBe('not_finite')
    expect((setTiltCalibration([[1, 0], [0, 1]], NaN) as { why: string }).why).toBe('cond_unknown')
    expect((setTiltCalibration([[1, 0], [0, 1]], null) as { why: string }).why).toBe('cond_unknown')
    expect((setTiltCalibration([[1, 0], [0, 1]], 99) as { why: string }).why).toBe('cond_too_high')
    // 宿主没接写口 —— 旧仓没有这一态。**不许静默成功。**
    processInstrumentProfile.write = null
    expect((setTiltCalibration([[1, 0], [0, 1]], 1) as { why: string }).why).toBe('no_sink')
  })

  it('`tilt_cal_cond` 与时间戳**无条件**一起写', () => {
    const { patches } = withSink()
    const r = setTiltCalibration([[1, 2], [3, 4]], 2.5)
    expect(r.ok).toBe(true)
    expect(patches).toEqual([
      {
        tilt_cal_g11: 1,
        tilt_cal_g12: 2,
        tilt_cal_g21: 3,
        tilt_cal_g22: 4,
        tilt_cal_cond: 2.5,
        tilt_cal_updated_at: 1_700_000_000,
      },
    ])
    expect(getTiltCalibration()).toEqual({
      state: 'ok',
      g: [[1, 2], [3, 4]],
      cond: 2.5,
      updatedAt: 1_700_000_000,
    })
  })
})
