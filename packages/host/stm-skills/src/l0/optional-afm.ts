/**
 * AFM 那一侧的选配模块：Kelvin 控制器（KPFM）、CPD 补偿、干涉仪、光杠杆、激光。
 *
 * **全部选配，全部默认关**（设置 → 硬件模块）。
 *
 * 这些是 AFM 有而 STM 没有的模块。本仓的主干是一条 STM 流水线，这里没有一件在
 * 隧穿路径上。该模块属于选配能力，所以技能先写好并默认关闭；只有仪器 profile
 * 明确声明对应能力后才允许调用。
 *
 * ## 为什么闭合 Kelvin 环要 CONFIRM
 *
 * KPFM 环调制偏压、解调受力，然后**伺服直流偏压**直到静电力归零 ——
 * 那个直流偏压**就是**接触电位差。要害在中间那一步：**这个环驱动偏压**。
 * 它不是一个测量，是一个会自己动手的回路。
 *
 * ## 限值先写，再写别的
 *
 * 与 `ConfigurePiController` 同一条顺序。后面任何一步失败时，手上已经是一组带界的
 * 参数，而不是一个整定好了、界还停在上一次（可能大开）的环。
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, formatG6, ok } from './common.js'
import { f, failed, given, i, multiRead, offByDefault, onByDefault, step } from './optional-common.js'

// ── Kelvin 控制器（KPFM）────────────────────────────────────────────────────

export const ConfigureKelvinController: Skill = {
  spec: S.ConfigureKelvinControllerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const hi = f(params, 'bias_high_limit_v')
    const lo = f(params, 'bias_low_limit_v')
    // **拒，不换过来** —— 反了的一对界会让 Kelvin 环立刻把偏压推到轨上。
    if (lo >= hi) {
      return fail(
        `bias_low_limit_v (${formatG6(lo)} V) 必须小于 bias_high_limit_v (${formatG6(hi)} V)` +
          '——限值反了，Kelvin 环会立刻把偏压推到轨上',
      )
    }

    // 护栏先架好。
    let s = await step(ctx, 'KelvinCtrl_BiasLimitsSet', hi, lo)
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'KelvinCtrl_CtrlSignalSet',
      given(params, 'control_signal_index') ? i(params, 'control_signal_index') : 0,
    )
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'KelvinCtrl_GainSet',
      given(params, 'p_gain') ? f(params, 'p_gain') : 1.0,
      given(params, 'time_constant_s') ? f(params, 'time_constant_s') : 0.01,
      given(params, 'slope') ? i(params, 'slope') : 0,
    )
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'KelvinCtrl_SetpntSet',
      given(params, 'setpoint') ? f(params, 'setpoint') : 0.0,
    )
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'KelvinCtrl_ModParamsSet',
      given(params, 'modulation_frequency_hz') ? f(params, 'modulation_frequency_hz') : 1000.0,
      given(params, 'modulation_amplitude') ? f(params, 'modulation_amplitude') : 0.1,
      given(params, 'modulation_phase_deg') ? f(params, 'modulation_phase_deg') : 0.0,
    )
    if (s.error !== null) return fail(s.error)

    return ok(
      {
        bias_high_limit_v: hi,
        bias_low_limit_v: lo,
        setpoint: given(params, 'setpoint') ? f(params, 'setpoint') : 0.0,
        // 配完环仍然是关的 —— 同 `ConfigurePiController`。
        controller_on: false,
      },
      `Kelvin 控制器已配置：偏压限 [${formatG6(lo)}, ${formatG6(hi)}] V` +
        '（环仍关闭——需 SetKelvinControllerOnOff 才生效）',
    )
  },
}

/**
 * 闭合 / 断开 Kelvin 环。
 *
 * 调制与控制器是**两条独立的开关**，而且调制那一条可以单独跳过
 * （`modulation_on=false`）—— 有些机器的调制走的是外部源，
 * 这里再写一遍会把那个源顶掉。
 */
export const SetKelvinControllerOnOff: Skill = {
  spec: S.SetKelvinControllerOnOffSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const on = params['on'] === true

    if (onByDefault(params, 'modulation_on')) {
      const s = await step(
        ctx, 'KelvinCtrl_ModOnOffSet',
        onByDefault(params, 'ac_mode') ? 1 : 0,
        on ? 1 : 0,
      )
      if (s.error !== null) return fail(s.error)
    }

    const s = await step(ctx, 'KelvinCtrl_CtrlOnOffSet', on ? 1 : 0)
    if (s.error !== null) return fail(s.error)

    return ok(
      { controller_on: on },
      on
        ? 'Kelvin 环已闭合——它现在正在自主驱动偏压'
        : 'Kelvin 环已断开（偏压停在环最后给的值）',
    )
  },
}

export const GetKelvinController: Skill = {
  spec: S.GetKelvinControllerSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['controller_on', () => ctx.safeCall('KelvinCtrl_CtrlOnOffGet')],
      ['setpoint', () => ctx.safeCall('KelvinCtrl_SetpntGet')],
      ['gains', () => ctx.safeCall('KelvinCtrl_GainGet')],
      ['bias_limits', () => ctx.safeCall('KelvinCtrl_BiasLimitsGet')],
      ['modulation', () => ctx.safeCall('KelvinCtrl_ModParamsGet')],
      ['modulation_on', () => ctx.safeCall('KelvinCtrl_ModOnOffGet')],
      ['amplitude', () => ctx.safeCall('KelvinCtrl_AmpGet')],
      ['control_signal', () => ctx.safeCall('KelvinCtrl_CtrlSignalGet')],
    ]),
}

// ── CPD 补偿 ────────────────────────────────────────────────────────────────

/**
 * 扫一遍偏压，**直接找抛物线的顶点**，而不是伺服到它。
 *
 * 与 Kelvin 环是同一个量的两种测法：环是闭环跟随，这个是开环扫一遍。
 */
export const RunCpdCompensation: Skill = {
  spec: S.RunCpdCompensationSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let s = await step(ctx, 'CPDComp_Open')
    if (s.error !== null) return fail(s.error)

    const range = f(params, 'range_v')
    const speed = given(params, 'speed_hz') ? f(params, 'speed_hz') : 100.0
    s = await step(
      ctx, 'CPDComp_ParamsSet',
      speed, range,
      given(params, 'averaging') ? i(params, 'averaging') : 1,
    )
    if (s.error !== null) return fail(s.error)

    return ok(
      { range_v: range, speed_hz: speed },
      `CPD 补偿已启动：±${formatG6(range)} V —— 用 GetCpdCompensation 读结果`,
    )
  },
}

export const GetCpdCompensation: Skill = {
  spec: S.GetCpdCompensationSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['cpd', () => ctx.safeCall('CPDComp_DataGet')],
      ['params', () => ctx.safeCall('CPDComp_ParamsGet')],
    ]),
}

// ── 干涉仪 ──────────────────────────────────────────────────────────────────

export const ConfigureInterferometer: Skill = {
  spec: S.ConfigureInterferometerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let s = await step(
      ctx, 'Interf_CtrlPropsSet',
      given(params, 'integral') ? f(params, 'integral') : 1.0,
      given(params, 'proportional') ? f(params, 'proportional') : 1.0,
      given(params, 'sign') ? i(params, 'sign') : 0,
    )
    if (s.error !== null) return fail(s.error)

    const wPiezo = given(params, 'w_piezo') ? f(params, 'w_piezo') : 0.0
    s = await step(ctx, 'Interf_WPiezoSet', wPiezo)
    if (s.error !== null) return fail(s.error)

    const nulled = offByDefault(params, 'null_deflection')
    if (nulled) {
      s = await step(ctx, 'Interf_CtrlNullDefl')
      if (s.error !== null) return fail(s.error)
    }

    return ok({ w_piezo: wPiezo, nulled }, '干涉仪已配置')
  },
}

export const SetInterferometerOnOff: Skill = {
  spec: S.SetInterferometerOnOffSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // 复位**在开关之前** —— 带着上一次的积分量闭环，是把一个已知的偏差
    // 直接当成起点。
    if (offByDefault(params, 'reset')) {
      const s = await step(ctx, 'Interf_CtrlReset')
      if (s.error !== null) return fail(s.error)
    }
    const on = params['on'] === true
    const s = await step(ctx, 'Interf_CtrlOnOffSet', on ? 1 : 0)
    if (s.error !== null) return fail(s.error)
    return ok({ controller_on: on }, `干涉仪控制环已${on ? '闭合' : '断开'}`)
  },
}

export const GetInterferometer: Skill = {
  spec: S.GetInterferometerSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['value', () => ctx.safeCall('Interf_ValGet')],
      ['controller_on', () => ctx.safeCall('Interf_CtrlOnOffGet')],
      ['gains', () => ctx.safeCall('Interf_CtrlPropsGet')],
      ['w_piezo', () => ctx.safeCall('Interf_WPiezoGet')],
    ]),
}

// ── 光杠杆（beam deflection）─────────────────────────────────────────────────

/**
 * 三条轴各走一条**字面量**动词。
 *
 * 旧仓这里曾经把动词放进一张表、再 `safe_call(verb, …)`，注释还写着「grep 照样
 * 看得见」——**看不见，那句注释就是错的**，是一次 AST 检查把这个谎揭出来的。
 * 本仓每一件安全工具都靠 grep `safeCall('…')` 找 Nanonis 调用：
 * 一条藏在变量后面的动词**在安全网之外，而看上去在里面**。
 */
export const ConfigureBeamDeflection: Skill = {
  spec: S.ConfigureBeamDeflectionSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const axis = String(params['axis'] ?? '')
    const sig = [
      String(params['name'] ?? ''),
      String(params['units'] ?? ''),
      f(params, 'calibration'),
      given(params, 'offset') ? f(params, 'offset') : 0.0,
    ] as const

    const [verb, rec] =
      axis === 'vertical'
        ? (['BeamDefl_VerConfigSet', await ctx.safeCall('BeamDefl_VerConfigSet', ...sig)] as const)
        : axis === 'horizontal'
          ? (['BeamDefl_HorConfigSet', await ctx.safeCall('BeamDefl_HorConfigSet', ...sig)] as const)
          : axis === 'sum'
            ? (['BeamDefl_IntConfigSet', await ctx.safeCall('BeamDefl_IntConfigSet', ...sig)] as const)
            : ([null, null] as const)

    if (verb === null || rec === null) {
      return fail(`未知 axis：'${axis}'（应为 vertical/horizontal/sum）`)
    }
    if (failed(rec)) return fail(`${verb} failed: ${rec.error ?? ''}`)
    return ok({ axis, calibration: f(params, 'calibration') }, `光杠杆 ${axis} 轴已标定`)
  },
}

export const GetBeamDeflection: Skill = {
  spec: S.GetBeamDeflectionSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['vertical', () => ctx.safeCall('BeamDefl_VerConfigGet')],
      ['horizontal', () => ctx.safeCall('BeamDefl_HorConfigGet')],
      ['sum', () => ctx.safeCall('BeamDefl_IntConfigGet')],
    ]),
}

export const AutoZeroBeamDeflection: Skill = {
  spec: S.AutoZeroBeamDeflectionSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall(
      'BeamDefl_AutoOffset',
      given(params, 'deflection_signal') ? i(params, 'deflection_signal') : 0,
    )
    if (failed(rec)) return fail(`BeamDefl_AutoOffset failed: ${rec.error ?? ''}`)
    // **没有 data** —— 旧仓这一条只给 summary。归零之后偏转是多少，
    // 得去 `GetBeamDeflection` 问，而不是由这个技能复述一个它没读过的数。
    return { success: true, summary: '光杠杆偏转已自动归零' }
  },
}

// ── 激光 ────────────────────────────────────────────────────────────────────

export const SetLaserOnOff: Skill = {
  spec: S.SetLaserOnOffSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const on = params['on'] === true
    const rec = await ctx.safeCall('Laser_OnOffSet', on ? 1 : 0)
    if (failed(rec)) return fail(`Laser_OnOffSet failed: ${rec.error ?? ''}`)
    return ok({ laser_on: on }, `激光已${on ? '开启' : '关闭'}`)
  },
}

/**
 * 只改功率设定值，**不碰开关**。
 *
 * summary 末尾那句「（激光开关未变）」不是客套：设一个功率与开一束激光是两件事，
 * 而一个把它们合起来做的技能，会在操作员以为自己只是在调参数的时候点亮激光。
 */
export const SetLaserPower: Skill = {
  spec: S.SetLaserPowerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const sp = f(params, 'setpoint')
    const rec = await ctx.safeCall('Laser_PropsSet', sp)
    if (failed(rec)) return fail(`Laser_PropsSet failed: ${rec.error ?? ''}`)
    return ok({ setpoint: sp }, `激光功率设定值 = ${formatG6(sp)}（激光开关未变）`)
  },
}

export const GetLaser: Skill = {
  spec: S.GetLaserSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['laser_on', () => ctx.safeCall('Laser_OnOffGet')],
      ['power', () => ctx.safeCall('Laser_PowerGet')],
      ['setpoint', () => ctx.safeCall('Laser_PropsGet')],
    ]),
}

export const OPTIONAL_AFM: Readonly<Record<string, Skill>> = {
  ConfigureKelvinController,
  SetKelvinControllerOnOff,
  GetKelvinController,
  RunCpdCompensation,
  GetCpdCompensation,
  ConfigureInterferometer,
  SetInterferometerOnOff,
  GetInterferometer,
  ConfigureBeamDeflection,
  GetBeamDeflection,
  AutoZeroBeamDeflection,
  SetLaserOnOff,
  SetLaserPower,
  GetLaser,
}
