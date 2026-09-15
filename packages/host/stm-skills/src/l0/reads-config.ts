/**
 * 「把这一族的设置一次读齐」—— 六个聚合读。
 *
 * 每个技能问一串 getter，**一个读失败只把它自己那一格置空，不带走整批**。
 *
 * ## `_unreadable` 为什么必须有
 *
 * 失败那一格填的是 `null`，而 `null` 也可能是一个**真值**（这个字段就是没配）。
 * 两者长得一模一样，所以另外列一份「哪几格没读到」。
 * 这是本仓那条「读不到 ≠ 零 / ≠ 否」在聚合读上的形态。
 *
 * ## 动词写成字面量，不走表驱动
 *
 * 每个 `ctx.safeCall('Piezo_RangeGet')` 里的动词都是**字面量**，挨着它的键。
 * 旧仓在这里栽过：一个表驱动的循环让 API 覆盖普查报了 40 项「读不到的设置」，
 * 而它们其实全都读得到——**调用照常发生，而所有靠 grep 找 Nanonis 调用的工具
 * 一个都看不见它**。本仓今天还没有那套普查，但代价与收益的比例没有变：
 * 字面量不要钱。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { cell } from './common.js'

/**
 * 跑一串读，把结果按键装起来。**永远 success**——「问了一圈」这件事本身成立，
 * 每一格自己说自己读没读到。
 */
async function readMany(
  reads: readonly (readonly [string, () => Promise<SkillCallRecord>])[],
  extra: Record<string, unknown> = {},
): Promise<SkillResultLike> {
  const out: Record<string, unknown> = { ...extra }
  const failed: string[] = []
  for (const [key, thunk] of reads) {
    const rec = await thunk()
    if (rec.error !== undefined && rec.error !== '') {
      out[key] = null
      failed.push(key)
    } else {
      out[key] = cell(rec)
    }
  }
  // **说清楚是哪几格**：`null` 也可能是一个真值
  if (failed.length > 0) out['_unreadable'] = failed
  return { success: true, data: out }
}

export const GetPiezoConfig: Skill = {
  spec: S.GetPiezoConfigSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    readMany([
      ['range', () => ctx.safeCall('Piezo_RangeGet')],
      ['calibration', () => ctx.safeCall('Piezo_CalibrGet')],
      ['sensitivity', () => ctx.safeCall('Piezo_SensGet')],
      ['hysteresis_on', () => ctx.safeCall('Piezo_HystOnOffGet')],
      ['hysteresis_values', () => ctx.safeCall('Piezo_HystValsGet')],
      ['xyz_limits', () => ctx.safeCall('Piezo_XYZLimitsGet')],
      ['drift_comp', () => ctx.safeCall('Piezo_DriftCompGet')],
      ['tilt', () => ctx.safeCall('Piezo_TiltGet')],
    ]),
}

/**
 * PLL 的读分**两个下标**：调制器 `m` 与解调器 `d`，缺省都是 1。
 *
 * 两者一并交出去——少了它们，同一份 `data` 说不清读的是哪一路。
 */
export const GetPllConfig: Skill = {
  spec: S.GetPllConfigSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const m = idx(params['modulator'])
    const d = idx(params['demodulator'])
    return readMany(
      [
        ['excitation_on', () => ctx.safeCall('PLL_OutOnOffGet', m)],
        ['amp_ctrl_setpoint', () => ctx.safeCall('PLL_AmpCtrlSetpntGet', m)],
        ['amp_ctrl_bandwidth', () => ctx.safeCall('PLL_AmpCtrlBandwidthGet', m)],
        ['phase_ctrl_bandwidth', () => ctx.safeCall('PLL_PhasCtrlBandwidthGet', m)],
        ['freq_exc_overwrite', () => ctx.safeCall('PLL_FreqExcOverwriteGet', m)],
        ['demod_phase_ref', () => ctx.safeCall('PLL_DemodPhasRefGet', d)],
        ['demod_harmonic', () => ctx.safeCall('PLL_DemodHarmonicGet', d)],
        ['input_range', () => ctx.safeCall('PLL_InpRangeGet', d)],
        ['add_on_off', () => ctx.safeCall('PLL_AddOnOffGet', m)],
      ],
      { modulator: m, demodulator: d },
    )
  },
}

/** 下标：缺省 1，`0` 也当成没给（同旧仓的 `int(x or 1)`）。 */
function idx(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n !== 0 ? Math.trunc(n) : 1
}

export const GetScanPatternConfig: Skill = {
  spec: S.GetScanPatternConfigSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    readMany([
      ['grid', () => ctx.safeCall('Pattern_GridGet')],
      ['line', () => ctx.safeCall('Pattern_LineGet')],
      ['experiment', () => ctx.safeCall('Pattern_PropsGet')],
    ]),
}

/** `which` 决定读哪半边：`bias` / `z` / `both`（缺省）。 */
export const GetSpectroscopyConfig: Skill = {
  spec: S.GetSpectroscopyConfigSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const which = String(params['which'] ?? '') || 'both'
    const reads: (readonly [string, () => Promise<SkillCallRecord>])[] = []
    if (which === 'bias' || which === 'both') {
      reads.push(
        ['bias_props', () => ctx.safeCall('BiasSpectr_PropsGet')],
        ['bias_adv_props', () => ctx.safeCall('BiasSpectr_AdvPropsGet')],
        ['bias_mls_mode', () => ctx.safeCall('BiasSpectr_MLSModeGet')],
        ['bias_mls_values', () => ctx.safeCall('BiasSpectr_MLSValsGet')],
        ['bias_status', () => ctx.safeCall('BiasSpectr_StatusGet')],
      )
    }
    if (which === 'z' || which === 'both') {
      reads.push(
        ['z_props', () => ctx.safeCall('ZSpectr_PropsGet')],
        ['z_adv_props', () => ctx.safeCall('ZSpectr_AdvPropsGet')],
        ['z_retract_delay', () => ctx.safeCall('ZSpectr_RetractDelayGet')],
        ['z_status', () => ctx.safeCall('ZSpectr_StatusGet')],
      )
    }
    // `which` 一并交出去：它决定了下面少了哪半边，而一份少了半边的 data
    // 与一份「那半边全读不到」的 data 长得不一样，但**看起来一样可信**。
    return readMany(reads, { which })
  },
}

/**
 * `TipShaper_PropsGet` 那 11 个数的字段名。
 *
 * ⚠️ **写与读的两个约定不一样**，这是个活陷阱：`PropsSet` 吃
 * `0 = 不改 / 1 = True / 2 = False`，而 `PropsGet` 回 `0 = False / 1 = True`。
 * 下面按 GET 的约定解——这里解的就是 GET 的回包。
 */
const TIP_SHAPER_PROPS: readonly (readonly [string, string])[] = [
  ['switch_off_delay_s', 's'], // 开环之前 Z 平均这么久
  ['change_bias', ''],
  ['bias_v', 'V'], // 第一段 Z 斜坡**之前**加上
  ['tip_lift_m', 'm'], // 第一段斜坡，相对当前 Z
  ['lift_time_1_s', 's'],
  ['bias_lift_v', 'V'], // 第一段斜坡**之后**立刻加上
  ['bias_settling_s', 's'],
  ['lift_height_m', 'm'], // 第二段斜坡的高度
  ['lift_time_2_s', 's'],
  ['end_wait_s', 's'],
  ['restore_feedback', ''],
]

/**
 * 给那 11 个数挂上协议里的字段名。`props` 原样留着——**具名是一次解释，
 * 而原始数组是这次解释的证据**。
 *
 * **长度对不上就一个都不具名。** 仪器回了别的个数，说明这张表编码的映射已经
 * 不知道还适不适用；「能对上几个先对几个」是更坏的失败：它看起来很权威，
 * 而分歧点之后的每一个字段都被悄悄错位了。
 */
function nameTipShaperProps(props: unknown): Record<string, unknown> {
  if (!Array.isArray(props)) return {}
  if (props.length !== TIP_SHAPER_PROPS.length) {
    return {
      props_named: null,
      props_named_error:
        `本机返回 ${props.length} 个值，而协议 ` +
        `(TCP-reference/tcp_protocol.txt, TipShaper.PropsGet) ` +
        `定义了 ${TIP_SHAPER_PROPS.length} 个 —— 字段顺序无法确证，` +
        `故不做具名。请对着协议原文人工核对 props。`,
    }
  }
  const named: Record<string, unknown> = {}
  for (const [i, [key, unit]] of TIP_SHAPER_PROPS.entries()) {
    const value = props[i]
    named[key] = unit === '' ? Boolean(value) : value
    // 0/1/(2) 三个码互不相同，**把原码留着**
    if (unit === '') named[`${key}_raw`] = value
  }
  return { props_named: named }
}

export const GetTipShaperConfig: Skill = {
  spec: S.GetTipShaperConfigSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const res = await readMany([['props', () => ctx.safeCall('TipShaper_PropsGet')]])
    const data = res.data ?? {}
    return { ...res, data: { ...data, ...nameTipShaperProps(data['props']) } }
  },
}

export const GetMiscInstrumentConfig: Skill = {
  spec: S.GetMiscInstrumentConfigSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    readMany([
      ['bias_range', () => ctx.safeCall('Bias_RangeGet')],
      ['current_calibration', () => ctx.safeCall('Current_CalibrGet')],
      ['current_gains', () => ctx.safeCall('Current_GainsGet')],
      ['atom_track', () => ctx.safeCall('AtomTrack_PropsGet', 1)],
      // 轴 0 = 「全部」。**这个实参不是可选的**：裸调会抛 TypeError，而连接池那层
      // 一揽子的 except 把它变成了**这一个字段**上的一句错误串 —— 于是这一格从来
      // 没有携带过读数，而没人发现，因为「单字段错误」看起来和「那个模块没装」
      // 一模一样（2026-07-31）。粗动回读的核对依赖这一次调用。
      ['motor_freq_amp', () => ctx.safeCall('Motor_FreqAmpGet', 0)],
      ['bias_sweep_limits', () => ctx.safeCall('BiasSwp_LimitsGet')],
      ['gen_sweep_limits', () => ctx.safeCall('GenSwp_LimitsGet')],
      ['gen_sweep_signals', () => ctx.safeCall('GenSwp_SwpSignalListGet')],
      ['folme_oversampling', () => ctx.safeCall('FolMe_OversamplGet')],
      ['folme_ps_experiment', () => ctx.safeCall('FolMe_PSExpGet')],
      ['folme_ps_props', () => ctx.safeCall('FolMe_PSPropsGet')],
      ['fungen2_idle', () => ctx.safeCall('FunGen2Ch_IdleGet', 1)],
      ['fungen2_signal', () => ctx.safeCall('FunGen2Ch_SignalGet', 1)],
      ['osci1t_channel', () => ctx.safeCall('Osci1T_ChGet')],
      // 六个 0 = 「只读，别改」。这个动词的 GET 也要带上全套参数位。
      ['osci1t_trigger', () => ctx.safeCall('Osci1T_TrigGet', 0, 0, 0, 0.0, 0.0, 0.0)],
      ['lockin_freqswp_signal', () => ctx.safeCall('LockInFreqSwp_SignalGet')],
    ]),
}

export const CONFIG_READS: Readonly<Record<string, Skill>> = {
  GetPiezoConfig,
  GetPllConfig,
  GetScanPatternConfig,
  GetSpectroscopyConfig,
  GetMiscInstrumentConfig,
  GetTipShaperConfig,
}

