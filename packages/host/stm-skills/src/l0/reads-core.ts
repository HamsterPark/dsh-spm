/**
 * 批 1 只读 L0 —— bias / current / zcontrol / scan / folme 一族。
 *
 * 每一条的动词、实参、body 逐位映射、以及**每条失败分支的逐字文案**，
 * 都来自 `spec/golden/skill_traces.json`（旧仓真实实现跑出来的）。
 * `traces.test.ts` 拿同一份轨迹逐条比——抄错一个字会当场变红。
 *
 * 为什么错误文案值得逐字：它是模型读到的**唯一**线索。
 * 「读到的 tip lift 不是一个数」和「读失败」对模型是两件事——
 * 前者要它去核对面板，后者要它重试。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { bool, body, fail, int, num, numList, ok, strList } from './common.js'

type Exec = (ctx: SkillContext, params: Readonly<Record<string, unknown>>) => Promise<SkillResultLike>

/** 单动词读技能的骨架。`map` 只在没有 `error` 时被调用。 */
function read(
  spec: Skill['spec'],
  verb: string,
  map: (rec: SkillCallRecord) => SkillResultLike,
  args: (params: Readonly<Record<string, unknown>>) => unknown[] = () => [],
): Skill {
  const execute: Exec = async (ctx, params) => {
    const rec = await ctx.safeCall(verb, ...args(params))
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return map(rec)
  }
  return { spec, execute }
}

// ── bias / current ──────────────────────────────────────────────────────────

export const GetBias = read(S.GetBiasSpec, 'Bias_Get', (r) => {
  const v = num(r)
  return v === null
    ? fail('读到的偏压值不是一个数(回包解不出) —— 拒绝把它当成读数。多半是 Nanonis 数值字段的元组包装没解开。')
    : ok({ bias_v: v })
})

export const GetCurrent = read(S.GetCurrentSpec, 'Current_Get', (r) => {
  const v = num(r)
  return v === null
    ? fail(
        '读到的电流值不是一个数(回包解不出) —— 拒绝把它当成读数。' +
          '这多半是 Nanonis 数值字段的元组包装没解开,不是电流异常。',
      )
    : ok({ current_a: v })
})

export const GetBiasCalibration = read(S.GetBiasCalibrationSpec, 'Bias_CalibrGet', (r) =>
  // D-SKILL-1：旧仓这里走 `else parsed`，把整个信封当成 calibration 交出去。
  ok({ calibration: num(r, 0), offset: num(r, 1) ?? 0 }),
)

// ── zcontrol ────────────────────────────────────────────────────────────────

export const GetSetpoint = read(S.GetSetpointSpec, 'ZCtrl_SetpntGet', (r) =>
  ok({ setpoint_a: num(r, 0) }),
)

export const GetZPosition = read(S.GetZPositionSpec, 'ZCtrl_ZPosGet', (r) => {
  const v = num(r)
  return v === null
    ? fail('读到的 Z 位置不是一个数(回包解不出) —— 拒绝把它当成读数。多半是 Nanonis 数值字段的元组包装没解开。')
    : ok({ z_pos_m: v })
})

export const GetTipLift = read(S.GetTipLiftSpec, 'ZCtrl_TipLiftGet', (r) => {
  const v = num(r)
  return v === null
    ? fail('读到的 tip lift 不是一个数(回包解不出) —— 拒绝把它当成读数。扎针深度用错数量级的后果落在针尖上,宁可失败。')
    : ok({ tip_lift_m: v })
})

export const GetZLimitsEnabled = read(S.GetZLimitsEnabledSpec, 'ZCtrl_LimitsEnabledGet', (r) => {
  const v = bool(r)
  return v === null
    ? fail('读不到 Z 限位的启用状态(回包解不出一个数)—— **不要**把它当成「限位已关闭」。')
    : ok({ enabled: v })
})

export const GetWithdrawRate = read(S.GetWithdrawRateSpec, 'ZCtrl_WithdrawRateGet', (r) =>
  ok({ withdraw_rate_m_per_s: num(r, 0) ?? 0 }),
)

export const GetHomeProps = read(S.GetHomePropsSpec, 'ZCtrl_HomePropsGet', (r) => {
  // body = [rel_or_abs, home_position_m]；1 = absolute
  const mode = int(r, 0)
  return ok({
    mode: mode === 0 ? 'relative' : 'absolute',
    home_position_m: num(r, 1) ?? 0,
  })
})

export const GetZCtrlList = read(S.GetZCtrlListSpec, 'ZCtrl_CtrlListGet', (r) => {
  // returns = ["i","i","*+c","i"] ⇒ body = [size, n, names, active_index]
  const names = strList(r, 2)
  return ok({ controllers: names, active_index: int(r, 3) ?? 0 })
})

// ── scan ────────────────────────────────────────────────────────────────────

export const GetScanFrame = read(S.GetScanFrameSpec, 'Scan_FrameGet', (r) => {
  const [cx, cy, w, h, a] = [num(r, 0), num(r, 1), num(r, 2), num(r, 3), num(r, 4)]
  if (cx === null || cy === null || w === null || h === null || a === null) {
    return ok({ raw: [...body(r)] })
  }
  return ok({ center_x_m: cx, center_y_m: cy, width_m: w, height_m: h, angle_deg: a })
})

export const GetScanXYPosition = read(
  S.GetScanXYPositionSpec,
  'Scan_XYPosGet',
  (r) => ok({ x_m: num(r, 0) ?? 0, y_m: num(r, 1) ?? 0 }),
  // 实参 1 = 「等一次完整的读」，旧仓写死的
  () => [1],
)

export const GetScanSpeed = read(S.GetScanSpeedSpec, 'Scan_SpeedGet', (r) => {
  const [fs, bs, ft, bt, kc, ratio] = [
    num(r, 0), num(r, 1), num(r, 2), num(r, 3), int(r, 4), num(r, 5),
  ]
  if (fs === null || bs === null || ft === null || bt === null || kc === null || ratio === null) {
    return ok({ raw: [...body(r)] })
  }
  return ok({
    fwd_speed_m_s: fs, bwd_speed_m_s: bs, fwd_time_s: ft, bwd_time_s: bt,
    keep_constant: kc, speed_ratio: ratio,
  })
})

export const GetScanBuffer = read(S.GetScanBufferSpec, 'Scan_BufferGet', (r) => {
  // body = [num_channels, channel_indexes, pixels, lines]
  const n = int(r, 0)
  const px = int(r, 2)
  const lines = int(r, 3)
  if (n === null || px === null || lines === null) return ok({ raw: [...body(r)] })
  return ok({ num_channels: n, channel_indexes: numList(r, 1), pixels: px, lines })
})

// ── folme ───────────────────────────────────────────────────────────────────

export const GetTipSpeed = read(S.GetTipSpeedSpec, 'FolMe_SpeedGet', (r) => {
  const v = num(r, 0)
  const custom = bool(r, 1)
  if (v === null || custom === null) return ok({ raw: [...body(r)] })
  return ok({ speed_m_s: v, custom_speed: custom })
})

export const GetPointShootOnOff = read(S.GetPointShootOnOffSpec, 'FolMe_PSOnOffGet', (r) => {
  const v = bool(r, 0)
  return v === null ? ok({ raw: [...body(r)] }) : ok({ enabled: v })
})

/** 这一批的全部技能，按名字索引。 */
export const CORE_READS: Readonly<Record<string, Skill>> = {
  GetBias, GetCurrent, GetBiasCalibration,
  GetSetpoint, GetZPosition, GetTipLift, GetZLimitsEnabled, GetWithdrawRate,
  GetHomeProps, GetZCtrlList,
  GetScanFrame, GetScanXYPosition, GetScanSpeed, GetScanBuffer,
  GetTipSpeed, GetPointShootOnOff,
}
