/**
 * 批 2 —— **一次写、不回读**的那些。
 *
 * 形状统一：下发 → 有 `error` 就原样透传 → 否则把**请求值**回给调用方。
 *
 * 「回请求值而不是回读值」是有意的，也是这一批与下一批的分界：
 * 有回读的技能（`SetSetpoint` / `SetZCtrlGain` / `SetScanBuffer` / `ZControllerOnOff`）
 * 在 `writes-verified.ts`，它们**读回来核对，不符就还原**。
 * 这一批没有回读，所以 `data` 说的是「我请求了什么」，不是「硬件现在是什么」——
 * 两者的区别在 2026-08-10 那次事故里是全部要害。
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'

/**
 * 一次写。`args` 从入参算出下发实参，`data` 算出回给调用方的东西。
 *
 * **实参顺序照 Nanonis 的 `args` 表**，不照参数声明的顺序——
 * 两者在 `SetHomeProps` 上正好相反（声明是 rel_or_abs 在前，
 * 而 `data` 里 home_position_m 在前），照声明写会把两个数对调。
 */
function write(
  spec: Skill['spec'],
  verb: string,
  args: (p: Readonly<Record<string, unknown>>) => unknown[],
  data: (p: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Skill {
  return {
    spec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const rec = await ctx.safeCall(verb, ...args(params))
      if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
      return ok(data(params))
    },
  }
}

/** 取一个数值入参。 */
const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number => {
  const v = p[k]
  return typeof v === 'number' ? v : dflt
}
/** 取一个布尔入参（缺省值由声明给）。 */
const b = (p: Readonly<Record<string, unknown>>, k: string, dflt: boolean): boolean => {
  const v = p[k]
  return typeof v === 'boolean' ? v : dflt
}
/** Nanonis 的布尔是 0/1。 */
const i01 = (v: boolean): number => (v ? 1 : 0)

// ── bias ────────────────────────────────────────────────────────────────────

/**
 * `SetBias` —— **不带 slew 的那一半**。
 *
 * 带 `slew_rate_v_per_s` 的斜坡在 `SetBiasRamp`（批 3 的图技能）里，
 * 旧仓 2026-05-19 把它从这里拆了出去：一次斜坡是**带 sleep 的写循环**，
 * 它得自己可中断、每一步的进度要看得见、长斜坡要能跨重启续跑。
 * `SetBias` 自身保持原子。
 */
export const SetBias = write(
  S.SetBiasSpec,
  'Bias_Set',
  (p) => [n(p, 'bias_v')],
  (p) => ({ bias_v: n(p, 'bias_v') }),
)

export const SetBiasRange = write(
  S.SetBiasRangeSpec,
  'Bias_RangeSet',
  (p) => [n(p, 'range_index')],
  (p) => ({ range_index: n(p, 'range_index') }),
)

// ── zcontrol ────────────────────────────────────────────────────────────────

export const SetTipLift = write(
  S.SetTipLiftSpec,
  'ZCtrl_TipLiftSet',
  (p) => [n(p, 'tip_lift_m')],
  (p) => ({ tip_lift_m: n(p, 'tip_lift_m') }),
)

export const SetZPosition = write(
  S.SetZPositionSpec,
  'ZCtrl_ZPosSet',
  (p) => [n(p, 'z_pos_m')],
  (p) => ({ z_pos_m: n(p, 'z_pos_m') }),
)

export const SetSwitchOffDelay = write(
  S.SetSwitchOffDelaySpec,
  'ZCtrl_SwitchOffDelaySet',
  (p) => [n(p, 'delay_s')],
  (p) => ({ delay_s: n(p, 'delay_s') }),
)

export const SetHomeProps = write(
  S.SetHomePropsSpec,
  'ZCtrl_HomePropsSet',
  // args = [Relative_or_Absolute, Home_position_m] —— 与声明顺序相反
  (p) => [n(p, 'rel_or_abs'), n(p, 'home_position_m')],
  (p) => ({ rel_or_abs: n(p, 'rel_or_abs'), home_position_m: n(p, 'home_position_m') }),
)

// ── piezo ───────────────────────────────────────────────────────────────────

export const SetPiezoTilt = write(
  S.SetPiezoTiltSpec,
  'Piezo_TiltSet',
  (p) => [n(p, 'tilt_x_deg'), n(p, 'tilt_y_deg')],
  (p) => ({ tilt_x_deg: n(p, 'tilt_x_deg'), tilt_y_deg: n(p, 'tilt_y_deg') }),
)

export const SetPiezoRange = write(
  S.SetPiezoRangeSpec,
  'Piezo_RangeSet',
  (p) => [n(p, 'range_x_m'), n(p, 'range_y_m'), n(p, 'range_z_m')],
  (p) => ({
    range_x_m: n(p, 'range_x_m'),
    range_y_m: n(p, 'range_y_m'),
    range_z_m: n(p, 'range_z_m'),
  }),
)

export const SetDriftCompensation = write(
  S.SetDriftCompensationSpec,
  'Piezo_DriftCompSet',
  // args = [on, Vx, Vy, Vz, Sat_Lim]。后四个的缺省是 0 —— 关补偿时它们无意义，
  // 但**必须发**，Nanonis 的这条命令没有短参数形式。
  (p) => [i01(b(p, 'enable', false)), n(p, 'vx'), n(p, 'vy'), n(p, 'vz'), 0],
  (p) => ({ enabled: b(p, 'enable', false) }),
)

// ── folme ───────────────────────────────────────────────────────────────────

export const SetTipSpeed = write(
  S.SetTipSpeedSpec,
  'FolMe_SpeedSet',
  (p) => [n(p, 'speed_m_s'), i01(b(p, 'custom_speed', true))],
  (p) => ({ speed_m_s: n(p, 'speed_m_s'), custom_speed: b(p, 'custom_speed', true) }),
)

export const SetFolMeOversampling = write(
  S.SetFolMeOversamplingSpec,
  'FolMe_OversamplSet',
  (p) => [n(p, 'oversampling')],
  (p) => ({ oversampling: n(p, 'oversampling') }),
)

// ── current ─────────────────────────────────────────────────────────────────

export const SetCurrentGain = write(
  S.SetCurrentGainSpec,
  'Current_GainSet',
  (p) => [n(p, 'gain_index'), n(p, 'filter_index')],
  (p) => ({ gain_index: n(p, 'gain_index'), filter_index: n(p, 'filter_index') }),
)

export const SIMPLE_WRITES: Readonly<Record<string, Skill>> = {
  SetBias, SetBiasRange,
  SetTipLift, SetZPosition, SetSwitchOffDelay, SetHomeProps,
  SetPiezoTilt, SetPiezoRange, SetDriftCompensation,
  SetTipSpeed, SetFolMeOversampling,
  SetCurrentGain,
}
