/**
 * 安全闸门对金样。金样由**真 `mast/core/safety.py`** 与 `execution_context.py` 跑出来。
 *
 * 这一段的判据密度比前面高一个量级，因为 Phase 2 是承重墙：后面 400 多个技能
 * 全部穿过这些闸，**抄错一个子串就是 400 多次错**。所以表逐行比、判定逐条比、
 * **报错原文逐字比**。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseQuantity } from './si.js'
import {
  envelopeViolations,
  isAbortSafe,
  isCalibrationChange,
  isCoarseDriveChange,
  isCoarseSampleApproach,
  isElectricalPulse,
  isProtectionDisable,
  isReadVerb,
  isTipShaping,
  isUnguardedLateralCoarseMove,
  modeRefusal,
  physicallyAbsurdViolations,
  type OperatingMode,
  type SkillMetaLike,
} from './safety.js'
import {
  ABORT_SAFE_WRITES,
  CAP_BIAS_PULSE,
  CAP_TIP_SHAPING,
  DEFAULT_SAFETY_LIMITS,
  GLOBAL_CHECKS,
  PHYSICAL_ABSURD,
  SEMI_DEPTH_NAME_PATTERNS,
  SEMI_TIP_LIFT_MAX_M,
} from './safety-tables.js'

interface Golden {
  limits: Record<string, number>
  global_checks: [string, string, string, string][]
  physical_absurd: [string, string, number, string][]
  caps: { CAP_BIAS_PULSE: string; CAP_TIP_SHAPING: string; SEMI_TIP_LIFT_MAX_M: number; SEMI_DEPTH_NAME_PATTERNS: string[] }
  abort_safe_writes: Record<string, [number, number[]] | null>
  is_read: Record<string, boolean>
  is_read_summary: { total: number; read: number }
  absurd_cases: { case: string; args: Record<string, unknown>; violations: string[] }[]
  hard_gate_cases: { fn: string; case: string; skill: string; params: Record<string, unknown>; result: boolean }[]
  capability_cases: { fn: string; case: string; caps: string[]; params: Record<string, unknown>; result: boolean }[]
  mode_refusal_cases: { case: string; mode: string; kind: string; args: Record<string, unknown>; refusal: string | null }[]
  abort_cases: { method: string; args: unknown[]; allowed: boolean }[]
  envelope_cases: { case: string; args: Record<string, unknown>; violations: string[]; violated: boolean; sides: string[] }[]
  spec_bound_cases: { case: string; value: string; guard: string[]; validate_params: string[] }[]
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/safety.json', import.meta.url)), 'utf8'),
) as Golden

/** 与导出脚本里的 `meta()` 同形：只要 (参数名, 单位)。 */
function meta(params: [string, string][], caps: string[] = [], name = '_Probe'): SkillMetaLike {
  return { name, parameters: params.map(([n, u]) => ({ name: n, unit: u })), capabilities: caps }
}

/** 与导出脚本里的 ABSURD_CASES 一一对应：只重复**输入**。 */
const ABSURD_INPUTS: Record<string, [string, string][]> = {
  setpoint_1p5A: [['setpoint_a', 'A']],
  setpoint_100p_ok: [['setpoint_a', 'A']],
  setpoint_si_string: [['setpoint_a', 'A']],
  setpoint_si_prefix_ok: [['setpoint_a', 'A']],
  bias_1e6V: [['bias_v', 'V']],
  bias_minus3_ok: [['bias_v', 'V']],
  p_gain_3m: [['p_gain', 'm']],
  p_gain_ok: [['p_gain', 'm']],
  p_gain_dimensionless: [['p_gain', '']],
  i_gain_fast: [['i_gain', 'm/s']],
  unknown_param: [['bias_v', 'V']],
  non_numeric: [['label', '']],
  bool_not_number: [['flag', '']],
}

/** 与导出脚本里的 ENVELOPE_CASES 一一对应：只重复**输入**。 */
const ENVELOPE_INPUTS: Record<string, [string, string][]> = {
  setpoint_100n_at_ceiling: [['setpoint_a', 'A']],
  setpoint_ceiling_as_float: [['setpoint_a', 'A']],
  setpoint_100p5n_over: [['setpoint_a', 'A']],
  setpoint_101n_over: [['setpoint_a', 'A']],
  setpoint_1p_at_floor: [['setpoint_a', 'A']],
  setpoint_0p9p_below_floor: [['setpoint_a', 'A']],
  tip_lift_neg_100n_at_floor: [['tip_lift_m', 'm']],
  tip_lift_neg_100p5n_under: [['tip_lift_m', 'm']],
  bias_neg10_one_ulp_below: [['bias_v', 'V']],
  bias_neg_over_slack: [['bias_v', 'V']],
  bias_pos10_one_ulp_above: [['bias_v', 'V']],
  bias_pos_over_slack: [['bias_v', 'V']],
  z_pos_zero: [['z_pos', 'm']],
  z_pos_just_below_zero: [['z_pos', 'm']],
  z_offset_1600n_at_ceiling: [['z_offset_m', 'm']],
  z_offset_neg_1600n_at_floor: [['z_offset_m', 'm']],
}

const KIND_TO_META: Record<string, { params: [string, string][]; caps: string[] }> = {
  pulse: { params: [], caps: [CAP_BIAS_PULSE] },
  shaping_shallow: { params: [['tip_lift', 'm']], caps: [CAP_TIP_SHAPING] },
  shaping_deep: { params: [['tip_lift', 'm']], caps: [CAP_TIP_SHAPING] },
  plain: { params: [['bias_v', 'V']], caps: [] },
}

describe('金样：表逐行相同', () => {
  it('可调包络的 14 个字段', () => {
    expect({ ...DEFAULT_SAFETY_LIMITS }).toEqual(golden.limits)
  })

  it('全局包络检查表 19 行，顺序也一样', () => {
    expect(GLOBAL_CHECKS.map((r) => [...r])).toEqual(golden.global_checks)
  })

  it('物理荒谬表 11 行，**含人话提示逐字**', () => {
    expect(PHYSICAL_ABSURD.map((r) => [...r])).toEqual(golden.physical_absurd)
  })

  it('能力标签与 SEMI 上限', () => {
    expect(CAP_BIAS_PULSE).toBe(golden.caps.CAP_BIAS_PULSE)
    expect(CAP_TIP_SHAPING).toBe(golden.caps.CAP_TIP_SHAPING)
    expect(SEMI_TIP_LIFT_MAX_M).toBe(golden.caps.SEMI_TIP_LIFT_MAX_M)
    expect([...SEMI_DEPTH_NAME_PATTERNS]).toEqual(golden.caps.SEMI_DEPTH_NAME_PATTERNS)
  })

  it('中止安全写表 24 条，规则形状也一样', () => {
    const ours = Object.fromEntries(
      Object.entries(ABORT_SAFE_WRITES).map(([k, v]) => [k, v === null ? null : [v[0], [...v[1]]]]),
    )
    expect(ours).toEqual(golden.abort_safe_writes)
  })
})

describe('金样：_is_read 对全部 671 个动词', () => {
  it('逐动词判定相同', () => {
    const ours: Record<string, boolean> = {}
    for (const m of Object.keys(golden.is_read)) ours[m] = isReadVerb(m)
    expect(ours).toEqual(golden.is_read)
  })

  it('分母对得上：297/671 判为读', () => {
    expect(golden.is_read_summary).toEqual({ total: 671, read: 297 })
  })
})

describe('金样：物理荒谬（**报错原文逐字**）', () => {
  for (const c of golden.absurd_cases) {
    it(`${c.case} ⇒ ${c.violations.length === 0 ? '放行' : '拒绝'}`, () => {
      const params = ABSURD_INPUTS[c.case]
      expect(params, `用例 ${c.case} 没有对应输入`).toBeDefined()
      expect(physicallyAbsurdViolations(meta(params!), c.args)).toEqual(c.violations)
    })
  }
})

describe('金样：五条硬闸', () => {
  const fns: Record<string, (s: string, p: Record<string, unknown>) => boolean> = {
    is_coarse_sample_approach: isCoarseSampleApproach,
    is_calibration_change: (s) => isCalibrationChange(s),
    is_coarse_drive_change: (s) => isCoarseDriveChange(s),
    is_unguarded_lateral_coarse_move: isUnguardedLateralCoarseMove,
    is_protection_disable: isProtectionDisable,
  }
  for (const c of golden.hard_gate_cases) {
    it(`${c.fn} · ${c.case} ⇒ ${c.result}`, () => {
      expect(fns[c.fn]!(c.skill, c.params)).toBe(c.result)
    })
  }
})

describe('金样：能力标签（含 2026-08-11 的 bias_lift_v 教训）', () => {
  for (const c of golden.capability_cases) {
    it(`${c.fn} · ${c.case} ⇒ ${c.result}`, () => {
      expect(
        c.fn === 'is_tip_shaping' ? isTipShaping(c.caps) : isElectricalPulse(c.caps, c.params),
      ).toBe(c.result)
    })
  }
})

describe('金样：模式闸（拒绝原文逐字）', () => {
  for (const c of golden.mode_refusal_cases) {
    it(`${c.case} ⇒ ${c.refusal === null ? '放行' : '拒绝'}`, () => {
      const k = KIND_TO_META[c.kind]!
      const m = meta(k.params, k.caps)
      const mode = c.mode === 'UNKNOWN' ? null : (c.mode as OperatingMode)
      expect(modeRefusal('_Probe', m, c.args, mode)).toBe(c.refusal)
    })
  }
})

describe('金样：中止之后还能不能发', () => {
  for (const c of golden.abort_cases) {
    it(`${c.method}(${JSON.stringify(c.args)}) ⇒ ${c.allowed ? '放行' : '拒绝'}`, () => {
      expect(isAbortSafe(c.method, c.args)).toBe(c.allowed)
    })
  }
})

describe('可调包络（金样只给表，行为在这里钉）', () => {
  it('超出上限就违规，边界值本身放行', () => {
    const m = meta([['bias_v', 'V']])
    expect(envelopeViolations(m, { bias_v: 11 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
    expect(envelopeViolations(m, { bias_v: 10 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(0)
    expect(envelopeViolations(m, { bias_v: -11 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
  })

  it('名字按子串匹配：bias_start_v 也走偏压包络', () => {
    const m = meta([['bias_start_v', 'V']])
    expect(envelopeViolations(m, { bias_start_v: -50 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
  })

  it('**单位不匹配就不检查**——同名不同量纲的参数不该被套上偏压包络', () => {
    const m = meta([['bias_v', 'ratio']])
    expect(envelopeViolations(m, { bias_v: 1e6 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(0)
  })

  it('z_offset 走对称的相对包络，负向退针不该被拒', () => {
    const m = meta([['z_offset_m', 'm']])
    expect(envelopeViolations(m, { z_offset_m: -1e-7 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(0)
  })

  it('有量纲参数以字符串到达，前缀形也要能查', () => {
    const m = meta([['setpoint_a', 'A']])
    expect(envelopeViolations(m, { setpoint_a: '100p' }, DEFAULT_SAFETY_LIMITS)).toHaveLength(0)
    expect(envelopeViolations(m, { setpoint_a: '1' }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
  })
})

describe('包络边界的相对容差 1e-9', () => {
  it('E0 · 前提：`100n` 解析出来比 1e-7 大——这个浮点陷阱存在', () => {
    // 它是下面所有格子的前提。要是 si.ts 哪天改成十进制精确解析，这条红了，说明那些格子
    // 已经不再证明任何东西，得回来重审。
    expect(parseQuantity('100n', { strict: false })).toBeGreaterThan(1e-7)
    expect(parseQuantity('1600n', { strict: false })).toBeGreaterThan(1.6e-6)
  })

  describe('E1 · 金样：每一格都与参考实现的结论一致', () => {
    it('输入表与金样的用例一一对应——少一边都会让一格悄悄没人测', () => {
      expect(Object.keys(ENVELOPE_INPUTS).sort()).toEqual(golden.envelope_cases.map((c) => c.case).sort())
    })

    for (const c of golden.envelope_cases) {
      it(`${c.case} ⇒ ${c.violated ? `越界 ${c.sides.join('/')}` : '放行'}`, () => {
        const params = ENVELOPE_INPUTS[c.case]
        expect(params, `用例 ${c.case} 没有对应输入`).toBeDefined()
        const got = envelopeViolations(meta(params!), c.args, DEFAULT_SAFETY_LIMITS)
        expect(got.length > 0).toBe(c.violated)
        // 参考实现的消息里是 minimum / maximum；这里的违规带着值与界，哪一侧由大小关系看出来
        const sides = [...new Set(got.map((v) => (v.value < v.min ? 'minimum' : 'maximum')))].sort()
        expect(sides).toEqual(c.sides)
      })
    }
  })

  it('E2 · 容差向外放、按界的绝对值算；界为 0 时容差为 0；违规里是原界', () => {
    const bias = meta([['bias_v', 'V']])
    // 负下界：-10 的下沿是 -10.00000001。写成 min * (1 - slack) 会把它向内收到 -9.99999999，
    // 于是合法的 -10 反而被拒。
    expect(envelopeViolations(bias, { bias_v: -10 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(0)
    expect(envelopeViolations(bias, { bias_v: -10.000000001 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(0)
    expect(envelopeViolations(bias, { bias_v: -10.00000002 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
    expect(envelopeViolations(bias, { bias_v: 10.00000002 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
    // 界为 0：abs(0) = 0，没有容差。别「修」成加一个绝对下限。
    const z = meta([['z_pos', 'm']])
    expect(envelopeViolations(z, { z_pos: 0 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(0)
    expect(envelopeViolations(z, { z_pos: -1e-30 }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
    // 相对容差：1e-7 的界，容差只有 1e-16。绝对容差 1e-9 会把 101n 也放过去。
    const sp = meta([['setpoint_a', 'A']])
    expect(envelopeViolations(sp, { setpoint_a: '100.5n' }, DEFAULT_SAFETY_LIMITS)).toHaveLength(1)
    // 违规里带的是配置里的原界，不是放宽后的
    const [v] = envelopeViolations(bias, { bias_v: 11 }, DEFAULT_SAFETY_LIMITS)
    expect(v).toEqual({ param: 'bias_v', value: 11, min: -10, max: 10 })
  })
})

describe('D-LIMITS-? 的前提：参考实现的两层对「写成上限本身」的值给不同的答案', () => {
  it('规格界 [1e-12, 100e-9] 的 `SetSetpoint`：只有 `100n` 一格 guard 放行而 validate_params 拒', () => {
    expect(golden.spec_bound_cases.map((c) => c.value)).toEqual(['100n', '100.5n', '101n', '1p', '0.9p'])
    const split = golden.spec_bound_cases.filter((c) => (c.guard.length === 0) !== (c.validate_params.length === 0))
    expect(split.map((c) => c.case)).toEqual(['100n_at_ceiling'])
    expect(split[0]!.guard).toEqual([])
    expect(split[0]!.validate_params[0]).toContain('above maximum')
    // 真越界两层都拒，恰在下限两层都放行——容差只吸收浮点噪声
    for (const c of golden.spec_bound_cases.filter((c) => c.case !== '100n_at_ceiling')) {
      expect(c.guard.length > 0, c.case).toBe(c.validate_params.length > 0)
    }
  })
})
