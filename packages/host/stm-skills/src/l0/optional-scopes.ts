/**
 * 示波器 —— 高分辨（OsciHR）、双通道（Osci2T）、Signal Chart。
 *
 * **选配硬件。** 这里每一个技能都属于一个默认关着的模块（设置 → 硬件模块）。
 * 关着的意思是**它们根本不在智能体的工具表里** —— 那比「调用被拒」更强：
 * 一个看不见的工具，模型不会去想办法绕过它。
 *
 * ## Nanonis 有三台示波器，而且互不通用
 *
 * - `Osci1T` —— 朴素的单通道示波器。**永远在**，本仓已经包了（`osci.ts`），不在这里。
 * - `Osci2T` —— 双通道，把两路信号放在同一条时基上互相对照。泵浦-探测的主力。
 * - `OsciHR` —— 高分辨那台：**真正的触发**（电平 / 数字、沿、迟滞、预触发、布防模式）、
 *   过采样，外加一段带窗与平均的 PSD。**想「看见」噪声而不只是记录它**，用这台。
 *
 * ## 按「一个决定」成形，不按「一条 API」成形
 *
 * `ConfigureHighResScope` 把触发、采样点数与过采样**一起**收下：Nanonis 那边要发
 * 十条独立的 Set 才表达得完一个决定（「在通道 3 上、上升沿、50 pA 触发，留 1024 点」），
 * 而让模型去串十条调用，就是**十次出错的机会，外加一条都看不出来的返回**。
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { cell, fail, ok } from './common.js'
import { f, failed, given, i, offByDefault, onByDefault, step } from './optional-common.js'

/** `OsciHR_TrigModeSet(Trigger_mode)`：0=立即，1=电平，2=数字。 */
const TRIG_MODES: Readonly<Record<string, number>> = { immediate: 0, level: 1, digital: 2 }
/** 沿：0 = 下降，1 = 上升。 */
const SLOPES: Readonly<Record<string, number>> = { falling: 0, rising: 1 }
/**
 * `OsciHR_OsciDataGet(Osci_index, Data_to_get, Timeout_s)`：
 * 0 = 当前缓冲，1 = 下一次触发，2 = **等**下一次触发。
 */
const DATA_NEXT_TRIGGER = 2

// ── 高分辨示波器 ────────────────────────────────────────────────────────────

export const ConfigureHighResScope: Skill = {
  spec: S.ConfigureHighResScopeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = given(params, 'osci_index') ? i(params, 'osci_index') : 0
    const mode = String(params['trigger_mode'] ?? '') || 'immediate'
    const slope = String(params['trigger_slope'] ?? '') || 'rising'
    const sig = i(params, 'signal_index')
    const samples = given(params, 'samples') ? i(params, 'samples') : 1024

    let s = await step(ctx, 'OsciHR_ChSet', idx, sig)
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'OsciHR_SamplesSet', samples)
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'OsciHR_OversamplSet',
      given(params, 'oversampling_index') ? i(params, 'oversampling_index') : 0,
    )
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'OsciHR_TrigModeSet', TRIG_MODES[mode] ?? TRIG_MODES['immediate'])
    if (s.error !== null) return fail(s.error)

    const trigCh = given(params, 'trigger_channel') ? i(params, 'trigger_channel') : 0
    const slopeVal = SLOPES[slope] ?? SLOPES['rising']

    // 三种触发模式发的是三串不同的动词。动词写成**字面量** ——
    // 安全工具靠 grep `safeCall('…')` 找 Nanonis 调用，
    // 一条藏在变量后面的动词对它们全都不可见。
    if (mode === 'level') {
      s = await step(ctx, 'OsciHR_TrigLevChSet', trigCh)
      if (s.error !== null) return fail(s.error)

      s = await step(
        ctx, 'OsciHR_TrigLevValSet',
        given(params, 'trigger_level') ? f(params, 'trigger_level') : 0.0,
      )
      if (s.error !== null) return fail(s.error)

      s = await step(ctx, 'OsciHR_TrigLevSlopeSet', slopeVal)
      if (s.error !== null) return fail(s.error)

      s = await step(
        ctx, 'OsciHR_TrigLevHystSet',
        given(params, 'trigger_hysteresis') ? f(params, 'trigger_hysteresis') : 0.0,
      )
      if (s.error !== null) return fail(s.error)
    } else if (mode === 'digital') {
      s = await step(ctx, 'OsciHR_TrigDigChSet', trigCh)
      if (s.error !== null) return fail(s.error)

      s = await step(ctx, 'OsciHR_TrigDigSlopeSet', slopeVal)
      if (s.error !== null) return fail(s.error)
    }

    return ok(
      { osci_index: idx, signal_index: sig, samples, trigger_mode: mode },
      `OsciHR#${idx} 已配置：信号 ${sig}，${samples} 点，触发=${mode}`,
    )
  },
}

export const RunHighResScope: Skill = {
  spec: S.RunHighResScopeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    if (onByDefault(params, 'rearm')) {
      const s = await step(ctx, 'OsciHR_TrigRearm')
      if (s.error !== null) return fail(s.error)
    }
    const s = await step(ctx, 'OsciHR_Run')
    if (s.error !== null) return fail(s.error)
    return { success: true, summary: 'OsciHR 已启动' }
  },
}

/**
 * 取曲线，可选再取一段 PSD。
 *
 * ⚠️ **PSD 那一读失败不许把曲线扔掉。** 曲线已经在手上了 —— 把它换成一句
 * 「PSD 读不到」的失败，是拿有的东西换没有的。那一条错进 `psd_error`，
 * 于是「我没取到 PSD」与「我什么都没取到」在返回值上分得开。
 */
export const GetHighResScopeData: Skill = {
  spec: S.GetHighResScopeDataSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = given(params, 'osci_index') ? i(params, 'osci_index') : 0
    const timeout = given(params, 'timeout_s') ? f(params, 'timeout_s') : 10.0
    const mode = onByDefault(params, 'wait_for_trigger') ? DATA_NEXT_TRIGGER : 0

    const rec = await ctx.safeCall('OsciHR_OsciDataGet', idx, mode, timeout)
    if (failed(rec)) return fail(`OsciHR_OsciDataGet failed: ${rec.error ?? ''}`)
    const data: Record<string, unknown> = { osci_index: idx, trace: cell(rec) }

    if (offByDefault(params, 'include_psd')) {
      const psd = await ctx.safeCall('OsciHR_PSDDataGet', mode, timeout)
      if (failed(psd)) data['psd_error'] = String(psd.error ?? '')
      else data['psd'] = cell(psd)
    }

    return ok(data, `OsciHR#${idx} 数据已取回`)
  },
}

/** 四个读各自独立 —— **一个不被支持的 getter 不该把其余三个也抹掉**。 */
export const GetHighResScopeStatus: Skill = {
  spec: S.GetHighResScopeStatusSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = given(params, 'osci_index') ? i(params, 'osci_index') : 0
    const data: Record<string, unknown> = { osci_index: idx }
    for (const [key, thunk] of [
      ['signal_index', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('OsciHR_ChGet', idx)],
      ['samples', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('OsciHR_SamplesGet')],
      ['oversampling_index', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('OsciHR_OversamplGet')],
      ['trigger_mode', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('OsciHR_TrigModeGet')],
    ] as const) {
      const rec = await thunk()
      data[key] = failed(rec) ? null : cell(rec)
    }
    return ok(data)
  },
}

// ── 双通道示波器 ────────────────────────────────────────────────────────────

export const ConfigureDualScope: Skill = {
  spec: S.ConfigureDualScopeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const a = i(params, 'channel_a')
    const b = i(params, 'channel_b')

    let s = await step(ctx, 'Osci2T_ChSet', a, b)
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'Osci2T_TimebaseSet',
      given(params, 'timebase_index') ? i(params, 'timebase_index') : 0,
    )
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'Osci2T_TrigSet',
      given(params, 'trigger_mode') ? i(params, 'trigger_mode') : 0,
      given(params, 'trigger_channel') ? i(params, 'trigger_channel') : 0,
      given(params, 'trigger_slope') ? i(params, 'trigger_slope') : 1,
      given(params, 'trigger_level') ? f(params, 'trigger_level') : 0.0,
      given(params, 'trigger_hysteresis') ? f(params, 'trigger_hysteresis') : 0.0,
      given(params, 'trigger_position') ? f(params, 'trigger_position') : 0.0,
    )
    if (s.error !== null) return fail(s.error)

    return ok({ channel_a: a, channel_b: b }, `Osci2T 已配置：A=${a} B=${b}`)
  },
}

export const GetDualScopeData: Skill = {
  spec: S.GetDualScopeDataSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    if (onByDefault(params, 'run_first')) {
      const s = await step(ctx, 'Osci2T_Run')
      if (s.error !== null) return fail(s.error)
    }
    const s = await step(
      ctx, 'Osci2T_DataGet',
      given(params, 'data_to_get') ? i(params, 'data_to_get') : 1,
    )
    if (s.error !== null) return fail(s.error)
    return ok({ trace: cell(s.rec) }, 'Osci2T 双通道数据已取回')
  },
}

// ── Signal Chart ────────────────────────────────────────────────────────────

export const ConfigureSignalChart: Skill = {
  spec: S.ConfigureSignalChartSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let s = await step(ctx, 'SignalChart_Open')
    if (s.error !== null) return fail(s.error)

    const a = i(params, 'channel_a')
    const b = i(params, 'channel_b')
    s = await step(ctx, 'SignalChart_ChsSet', a, b)
    if (s.error !== null) return fail(s.error)

    return ok({ channel_a: a, channel_b: b }, 'Signal Chart 已设置')
  },
}

export const OPTIONAL_SCOPES: Readonly<Record<string, Skill>> = {
  ConfigureHighResScope,
  RunHighResScope,
  GetHighResScopeData,
  GetHighResScopeStatus,
  ConfigureDualScope,
  GetDualScopeData,
  ConfigureSignalChart,
}
