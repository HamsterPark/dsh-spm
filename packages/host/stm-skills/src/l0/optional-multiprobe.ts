/**
 * 多探针：N 个各自独立的扫描器，每个有自己的 Z 环、偏压与电流。
 *
 * **选配硬件，默认关**（设置 → 硬件模块）。
 *
 * 一台四探针 STM 是**四台共用一块样品的显微镜**。每一条 `MProbe*` 调用的**第一个**
 * 实参都是 `Scanner_Index`，而那几根探针里的每一根都能独立地扎进样品。
 *
 * ## 两项必须显式处理的约束
 *
 * **① 探针号不是可选的，而且没有一个说得通的缺省。**
 * 本仓**不**把 `probe` 缺省成 0 —— 一个省掉下标、然后拿到探针 0 的智能体，
 * 会选择错误的探针。它在每一处都是必填。
 *
 * **② 单探针那些技能不知道探针的存在。** `SetBias` / `ZControllerOnOff` /
 * `WithdrawTip` 作用在 Nanonis 的**主通道**上。在一台多探针机器上那是某一根特定的
 * 探针（当前「活动扫描器」那一根），不是全部。要动第 N 根只能用这个文件里的技能 ——
 * 这也正是 `WithdrawProbe` 要与普通 `WithdrawTip` 并存的理由：按下中止会经主通道
 * 退针，**而且**因为 `MProbeZCtrl_Withdraw` 在中止后的放行清单里，
 * 智能体仍然能把每一根探针逐一退回。
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { cell, fail, formatG6, ok, pyExp } from './common.js'
import { f, failed, given, i, offByDefault, onByDefault, step } from './optional-common.js'

/** 每一条 `MProbe*` 的第一个实参。**必填，没有缺省。** */
const probeOf = (p: Readonly<Record<string, unknown>>): number => i(p, 'probe')

// ── 每根探针自己的 Z 环 ─────────────────────────────────────────────────────

/**
 * 设定点 / 增益 / 开关，一次配完。
 *
 * **增益那一对要先读再写**：`MProbeZCtrl_GainSet` 吃的是 (P, I) 两个，
 * 而调用方常常只想改其中一个。省掉的那个若按 0 写下去，**I 增益归零就是一个死环**
 * ——它看上去还开着，实际上再也追不上设定点。
 */
export const SetProbeZController: Skill = {
  spec: S.SetProbeZControllerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)

    if (given(params, 'setpoint')) {
      const s = await step(ctx, 'MProbeZCtrl_SetpntSet', probe, f(params, 'setpoint'))
      if (s.error !== null) return fail(s.error)
    }

    if (given(params, 'p_gain') || given(params, 'i_gain')) {
      const cur = await ctx.safeCall('MProbeZCtrl_GainGet', probe)
      if (failed(cur)) return fail(`MProbeZCtrl_GainGet failed: ${cur.error ?? ''}`)
      const got = cell(cur)
      const pair = Array.isArray(got) && got.length >= 2 ? got : [0.0, 0.0]
      const s = await step(
        ctx, 'MProbeZCtrl_GainSet', probe,
        given(params, 'p_gain') ? f(params, 'p_gain') : Number(pair[0]),
        given(params, 'i_gain') ? f(params, 'i_gain') : Number(pair[1]),
      )
      if (s.error !== null) return fail(s.error)
    }

    const on = params['on'] === true
    const s = await step(ctx, 'MProbeZCtrl_OnOffSet', probe, on ? 1 : 0)
    if (s.error !== null) return fail(s.error)

    return ok(
      { probe, controller_on: on },
      `探针 ${probe} 的 Z 反馈已${on ? '闭合' : '断开'}`,
    )
  },
}

/**
 * 五个读一次问齐。**读不到的那一格给 `null`**，别的照常交出去。
 *
 * 动词写成字面量：本仓每一件安全工具（中止策略核对、安全审计、API 覆盖清点）
 * 都靠 grep `safeCall('…')` 找 Nanonis 调用，藏在变量后面的动词对它们全都不可见。
 */
export const GetProbeZController: Skill = {
  spec: S.GetProbeZControllerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const data: Record<string, unknown> = { probe }
    for (const [key, thunk] of [
      ['controller_on', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeZCtrl_OnOffGet', probe)],
      ['setpoint', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeZCtrl_SetpntGet', probe)],
      ['gains', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeZCtrl_GainGet', probe)],
      ['z_m', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeZCtrl_ZPosGet', probe)],
      ['limits', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeZCtrl_LimitsGet', probe)],
    ] as const) {
      const rec = await thunk()
      data[key] = failed(rec) ? null : cell(rec)
    }
    return ok(data)
  },
}

/**
 * 把一根探针退回。
 *
 * `MProbeZCtrl_Withdraw` **在中止后的放行清单里** —— 中止之后仍然要能把每一根
 * 探针逐一撤离，否则「停手」在一台四探针机器上只停了四分之一。
 */
export const WithdrawProbe: Skill = {
  spec: S.WithdrawProbeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const rec = await ctx.safeCall('MProbeZCtrl_Withdraw', probe)
    if (failed(rec)) return fail(`MProbeZCtrl_Withdraw failed: ${rec.error ?? ''}`)
    return ok({ probe, withdrawn: true }, `探针 ${probe} 已退回`)
  },
}

// ── 每根探针自己的扫描器 ────────────────────────────────────────────────────

/**
 * 标定系数与速度。
 *
 * 三个系数**先读再写**，理由同 Z 增益那一对：`CalibrSet` 吃三个，
 * 而省掉的那一维若按 1.0 写下去，就是悄悄把一条轴的标定改了。
 */
export const ConfigureProbeScanner: Skill = {
  spec: S.ConfigureProbeScannerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)

    if (given(params, 'factor_x') || given(params, 'factor_y') || given(params, 'factor_z')) {
      const cur = await ctx.safeCall('MProbeScanner_CalibrGet', probe)
      if (failed(cur)) return fail(`MProbeScanner_CalibrGet failed: ${cur.error ?? ''}`)
      const got = cell(cur)
      const c = Array.isArray(got) && got.length >= 3 ? got : [1.0, 1.0, 1.0]
      const s = await step(
        ctx, 'MProbeScanner_CalibrSet', probe,
        given(params, 'factor_x') ? f(params, 'factor_x') : Number(c[0]),
        given(params, 'factor_y') ? f(params, 'factor_y') : Number(c[1]),
        given(params, 'factor_z') ? f(params, 'factor_z') : Number(c[2]),
      )
      if (s.error !== null) return fail(s.error)
    }

    if (given(params, 'speed')) {
      const s = await step(ctx, 'MProbeScanner_SpeedSet', probe, f(params, 'speed'))
      if (s.error !== null) return fail(s.error)
    }

    return ok({ probe }, `探针 ${probe} 扫描器已配置`)
  },
}

export const MoveProbeXY: Skill = {
  spec: S.MoveProbeXYSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const x = f(params, 'x_m')
    const y = f(params, 'y_m')
    const rec = await ctx.safeCall('MProbeScanner_XYPosSet', probe, x, y)
    if (failed(rec)) return fail(`MProbeScanner_XYPosSet failed: ${rec.error ?? ''}`)
    return ok(
      { probe, x_m: x, y_m: y },
      `探针 ${probe} 已移动到 (${pyExp(x, 3)}, ${pyExp(y, 3)}) m`,
    )
  },
}

export const StopProbeScanner: Skill = {
  spec: S.StopProbeScannerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const rec = await ctx.safeCall('MProbeScanner_Stop', probe)
    if (failed(rec)) return fail(`MProbeScanner_Stop failed: ${rec.error ?? ''}`)
    return ok({ probe }, `探针 ${probe} 扫描器已停止`)
  },
}

// ── 每根探针自己的偏压与电流 ────────────────────────────────────────────────

export const SetProbeBias: Skill = {
  spec: S.SetProbeBiasSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const v = f(params, 'bias_v')
    const rec = await ctx.safeCall('MProbeBias_Set', probe, v)
    if (failed(rec)) return fail(`MProbeBias_Set failed: ${rec.error ?? ''}`)
    return ok({ probe, bias_v: v }, `探针 ${probe} 偏压 = ${formatG6(v)} V`)
  },
}

export const PulseProbeBias: Skill = {
  spec: S.PulseProbeBiasSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const width = f(params, 'width_s')
    const value = f(params, 'value_v')
    // MProbeBias_Pulse(Scanner_Index, Wait_Until_Done, Width, Value, ZCtrl_Hold, Abs_Rel)
    const rec = await ctx.safeCall(
      'MProbeBias_Pulse',
      probe,
      onByDefault(params, 'wait') ? 1 : 0,
      width,
      value,
      // `hold_z` 缺省 **true**：反馈还开着的话，一发脉冲会把电流抬高几个数量级，
      // Z 会一路追着它扎进表面。
      onByDefault(params, 'hold_z') ? 1 : 0,
      offByDefault(params, 'relative') ? 1 : 0,
    )
    if (failed(rec)) return fail(`MProbeBias_Pulse failed: ${rec.error ?? ''}`)
    return ok(
      { probe, value_v: value, width_s: width },
      `探针 ${probe} 偏压脉冲：${formatG6(value)} V × ${formatG6(width)} s`,
    )
  },
}

export const GetProbeBias: Skill = {
  spec: S.GetProbeBiasSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const data: Record<string, unknown> = { probe }
    for (const [key, thunk] of [
      ['bias_v', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeBias_Get', probe)],
      ['range', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeBias_RangeGet', probe)],
      ['calibration', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeBias_CalibrGet', probe)],
    ] as const) {
      const rec = await thunk()
      data[key] = failed(rec) ? null : cell(rec)
    }
    return ok(data)
  },
}

export const GetProbeCurrent: Skill = {
  spec: S.GetProbeCurrentSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const data: Record<string, unknown> = { probe }
    for (const [key, thunk] of [
      ['current_a', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeCurrent_Get', probe)],
      ['gains', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('MProbeCurrent_GainsGet', probe)],
    ] as const) {
      const rec = await thunk()
      data[key] = failed(rec) ? null : cell(rec)
    }
    return ok(data)
  },
}

export const ConfigureProbeCurrentGain: Skill = {
  spec: S.ConfigureProbeCurrentGainSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const probe = probeOf(params)
    const gain = i(params, 'gain_index')
    const rec = await ctx.safeCall(
      'MProbeCurrent_GainSet',
      probe,
      gain,
      given(params, 'filter_index') ? i(params, 'filter_index') : 0,
    )
    if (failed(rec)) return fail(`MProbeCurrent_GainSet failed: ${rec.error ?? ''}`)
    return ok({ probe, gain_index: gain }, `探针 ${probe} 前放增益索引 = ${gain}`)
  },
}

export const OPTIONAL_MULTIPROBE: Readonly<Record<string, Skill>> = {
  SetProbeZController,
  GetProbeZController,
  WithdrawProbe,
  ConfigureProbeScanner,
  MoveProbeXY,
  StopProbeScanner,
  SetProbeBias,
  PulseProbeBias,
  GetProbeBias,
  GetProbeCurrent,
  ConfigureProbeCurrentGain,
}
