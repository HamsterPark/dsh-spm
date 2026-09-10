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
