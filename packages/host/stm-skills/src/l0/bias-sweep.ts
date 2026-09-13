/**
 * Bias Sweeper、偏压脉冲，以及旧仓一直没包出来的最后几个零散 Nanonis 调用。
 *
 * - **`BiasSwp_*`** —— 偏压 ramp + 沿途记录采集通道。与 `BiasSpectr_*`
 *   （偏压谱，`RunSTS` 那一路）**不是一回事**：sweeper 只管 ramp 和记录，没有
 *   谱模块那套 Z 控制时序。定高 I–V、或者在 lock-in 盯着时做一次偏压 ramp 用它。
 * - **`Bias_Pulse`** —— 由硬件计时的单个脉冲。它**留下永久痕迹**，所以发之前
 *   要读一次针尖在哪（见 `tip-xy.ts`）。
 * - **`Signals_CalibrGet` / `Signals_AddRTSet` / `Util_AcqPeriodSet`** ——
 *   旧仓包了 8 个 `Signals_*` 里的 6 个，差的那一个正是「一个数**是什么意思**」；
 *   采集周期以前只读得到、设不了。
 *
 * ## D-BIASSWP-1 · 那个第五个实参不存在
 *
 * 旧仓这里写的是
 *
 * ```python
 * # BiasSwp_PropsSet(Number_of_steps, Period_ms, Autosave, Save_dialog, Settling_ms)
 * context.safe_call("BiasSwp_PropsSet", steps, period, autosave, 0, period)
 * ```
 *
 * 而 `BiasSwp.PropsSet` 只收**四个**（协议表与 `nanonis_spm` 的函数签名一致，
 * 都没有 `Settling_ms`）。真机上那是一次 `TypeError`，被 `safe_call` 兜成
 * `record.error` ⇒ **`RunBiasSweep` 每一次都停在第三步**，一次也没成功过。
 *
 * 金样照不出它：假 context 不检查实参个数。照出它的是**协议表** ——
 * 注释写下了一个不存在的签名，然后代码照着注释写。
 *
 * 所以这里只发四个。**不是**照抄五个然后靠我们的编码层把第五个悄悄丢掉：
 * 那样代码仍然声称设了一个安定时间，而什么都没设。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, num, ok } from './common.js'
import { tipXyFields } from './tip-xy.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt

/**
 * 一个整数入参。**给了就用，`0` 也算给了**（D-ZERO-1）。
 *
 * `sweep_direction = 0`（上限→下限）与 `z_hold = 0`（Z 控制器不变）都是声明里写着的
 * 合法值，而旧仓那两处写的是 `int(params.get(k, d) or d)` —— `0 or 1` 在 Python 里是
 * `1`，于是**这两个 0 一次也下发不出去**，而调用方以为下发了。
 */
const i = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/**
 * 步数 / 周期：**`0` 不是一个值**，它们都必须为正（声明里 `min` 是 2 与 1）。
 * 这一处照旧把 0 顶成缺省——与上面那个刻意不同，因为这里的 0 本来就不合法。
 */
const positive = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && p[k] > 0 ? Math.trunc(p[k] as number) : dflt

export const RunBiasSweep: Skill = {
  spec: S.RunBiasSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let lo = f(params, 'lower_limit_v')
    let hi = f(params, 'upper_limit_v')
    // **颠倒的限值换过来，不拒**。与 `SetSpectrumAnalyzerBand` 刻意不同：
    // 那边反过来意味着调用方把两个量搞混了，而这里 `sweep_direction` 是另一个
    // 独立参数——「从 1 V 扫到 −1 V」是一个**说得通的意思**，换过来之后它照旧成立。
    if (lo > hi) [lo, hi] = [hi, lo]
    const steps = positive(params, 'steps', 256)
    const period = positive(params, 'period_ms', 10)
    const zOff = params['z_controller_off'] !== false ? 1 : 0
    const direction = i(params, 'sweep_direction', 1)
    const autosave = params['autosave'] !== false ? 1 : 0

    let rec = await ctx.safeCall('BiasSwp_Open')
    if (failed(rec)) return fail(`BiasSwp_Open failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('BiasSwp_LimitsSet', lo, hi)
    if (failed(rec)) return fail(`BiasSwp_LimitsSet failed: ${rec.error ?? ''}`)

    // BiasSwp_PropsSet(Number_of_steps, Period_ms, Autosave, Save_dialog_box)
    // —— 四个，见文件抬头 D-BIASSWP-1。
    rec = await ctx.safeCall('BiasSwp_PropsSet', steps, period, autosave, 0)
    if (failed(rec)) return fail(`BiasSwp_PropsSet failed: ${rec.error ?? ''}`)

    // BiasSwp_Start(Get_data, Sweep_direction, Z_Controller_status, Save_base_name, Reset_bias)
    rec = await ctx.safeCall('BiasSwp_Start', 1, direction, zOff, 'mast_biasswp', 1)
    if (failed(rec)) return fail(`BiasSwp_Start failed: ${rec.error ?? ''}`)

    return ok({
      lower_limit_v: lo,
      upper_limit_v: hi,
      steps,
      period_ms: period,
      z_controller_off: zOff !== 0,
      data: [...body(rec)],
    })
  },
}

/** 一个原始值的一个单位对应多少物理量。读不出那一位给 `null`，不给 0。 */
export const GetSignalCalibration: Skill = {
  spec: S.GetSignalCalibrationSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = i(params, 'signal_index', 0)
    const rec = await ctx.safeCall('Signals_CalibrGet', idx)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ signal_index: idx, calibration: num(rec, 0), offset: num(rec, 1) })
  },
}

export const SetAdditionalRealtimeSignals: Skill = {
  spec: S.SetAdditionalRealtimeSignalsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const s1 = i(params, 'signal_1', 0)
    const s2 = i(params, 'signal_2', 0)
    const rec = await ctx.safeCall('Signals_AddRTSet', s1, s2)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ signal_1: s1, signal_2: s2 })
  },
}

export const SetAcquisitionPeriod: Skill = {
  spec: S.SetAcquisitionPeriodSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const p = f(params, 'period_s')
    const rec = await ctx.safeCall('Util_AcqPeriodSet', p)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ period_s: p })
  },
}

/**
 * 由硬件计时的单个偏压脉冲。
 *
 * `z_hold` 缺省 **1 = 保持**：反馈若还开着，一发脉冲会把电流抬高几个数量级，
 * Z 会一路追着它直接扎进表面。
 *
 * 发之前先读一次针尖位置 —— 脉冲**改变表面**（那通常正是它的目的），
 * 所以扫描图要的是它真正的坐标，不是一个最多差一个刷新周期的缓存值。
 * 读不到就什么都不报（`tip-xy.ts` 抬头那条）。
 */
export const BiasPulse: Skill = {
  spec: S.BiasPulseSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const widthS = f(params, 'width_s')
    const biasV = f(params, 'bias_v')
    const zHold = i(params, 'z_hold', 1)
    const absolute = params['absolute'] !== false
    const spot = await tipXyFields(ctx)
    // Bias_Pulse(Wait_until_done, Bias_pulse_width_s, Bias_value_V,
    //            Z_Controller_on_hold, Pulse_absolute_relative) —— 1=相对, 2=绝对
    const rec = await ctx.safeCall('Bias_Pulse', 1, widthS, biasV, zHold, absolute ? 2 : 1)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ width_s: widthS, bias_v: biasV, z_hold: zHold, absolute, ...spot })
  },
}

export const BIAS_SWEEP: Readonly<Record<string, Skill>> = {
  RunBiasSweep,
  GetSignalCalibration,
  SetAdditionalRealtimeSignals,
  SetAcquisitionPeriod,
  BiasPulse,
}
