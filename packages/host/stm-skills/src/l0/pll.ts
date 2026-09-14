/**
 * PLL（锁相环）—— qPlus / 非接触 AFM 的**调频**子系统。
 *
 * 锁相放大器（`lockin.ts`）测的是「在一个已知的调制上，信号响应多少」；PLL 测的是
 * 另一件事：**一支音叉的共振频率被力梯度推移了多少**。`Δf` 就是 nc-AFM 的信号本身，
 * 而它的前提是环真的锁住了 —— 中心频率对、激励够、相位环与幅度环都在跑。
 *
 * ## 这一族里最要紧的两个数：`f₀` 与 `Q`
 *
 * `AcquirePLLFreqSweep` 扫一遍频率找共振峰，交出 `resonance_freq_hz` 与 `q_factor`。
 * 它们是判断「这支传感器还好不好」的基本量：Q 掉一个数量级通常意味着针尖撞过、
 * 或者音叉上沾了东西。
 *
 * ## D-SKILL-1 在这一族里最赤裸的一次
 *
 * `PLLSignalAnalyzer` 把 `str(rec.return_value)` 塞进 `data` —— 也就是把
 * **整个三段信封 `("", b'', [...])` 的 Python repr** 当成示波器数据交给模型。
 * 我们这一侧信封在线协议层就没了，交出去的是 body 本身。
 *
 * ## 「给了才写」，`in` 判不算数
 *
 * `ConfigurePLL` / `ConfigurePLLExcitation` 判的是 `params[k] != null` 而不是
 * `k in params`：模型那条路上 schema 会把每一个可选字段都实例化出来，没设的以
 * `null` 到达 —— 用 `in` 判的话每一个都「给了」，于是 `PLL_CenterFreqSet(mod, null)`。
 * 与 `ConfigureLockInDemod` 是同一条（批 3d 记过）。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, cell, fail, ok } from './common.js'

type Exec = (ctx: SkillContext, params: Readonly<Record<string, unknown>>) => Promise<SkillResultLike>

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
/** 调制器 / 解调器下标，缺省 1。 */
const idx = (p: Readonly<Record<string, unknown>>, k: string, dflt = 1): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
/** 「调用方**真的给了**这个值吗」。`null` 与 `undefined` 都算没给。 */
const given = (p: Readonly<Record<string, unknown>>, k: string): boolean =>
  p[k] !== undefined && p[k] !== null
const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' ? (p[k] as number) : dflt

/** body 的第 i 位当成数，取不出给 `null`。 */
const at = (rec: SkillCallRecord, i: number): number | null => {
  const v = body(rec)[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `decode_reply`：body 只有一个元素就解一层，否则原样给出。 */


// ── 配置与状态 ─────────────────────────────────────────────────────────────

export const ConfigurePLL: Skill = {
  spec: S.ConfigurePLLSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const mod = idx(params, 'modulator_index')

    if (given(params, 'center_freq_hz')) {
      const r = await ctx.safeCall('PLL_CenterFreqSet', mod, n(params, 'center_freq_hz'))
      if (failed(r)) return fail(r.error ?? '')
    }
    if (given(params, 'freq_shift_hz')) {
      const r = await ctx.safeCall('PLL_FreqShiftSet', mod, n(params, 'freq_shift_hz'))
      if (failed(r)) return fail(r.error ?? '')
    }
    // 增益与时间常数是**一对**：给了 P 就下发，没给 T 时用 1e-3 顶上。
    if (given(params, 'amp_p_gain')) {
      const tc = given(params, 'amp_time_constant_s') ? n(params, 'amp_time_constant_s') : 1e-3
      const r = await ctx.safeCall('PLL_AmpCtrlGainSet', mod, n(params, 'amp_p_gain'), tc)
      if (failed(r)) return fail(r.error ?? '')
    }
    if (given(params, 'phas_p_gain')) {
      const tc = given(params, 'phas_time_constant_s') ? n(params, 'phas_time_constant_s') : 1e-3
      const r = await ctx.safeCall('PLL_PhasCtrlGainSet', mod, n(params, 'phas_p_gain'), tc)
      if (failed(r)) return fail(r.error ?? '')
    }

    return ok({ modulator_index: mod })
  },
}

/**
 * 五个读一次问齐。**读不到的那一格不写这个键**——与「读到了」分得开。
 *
 * 技能永远 `success`：它报的是「问到了什么」，而一个问不到激励幅度的 PLL
 * 仍然回答得了中心频率。
 */
export const GetPLLStatus: Skill = {
  spec: S.GetPLLStatusSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const mod = idx(params, 'modulator_index')
    const data: Record<string, unknown> = { modulator_index: mod }

    const cf = await ctx.safeCall('PLL_CenterFreqGet', mod)
    if (!failed(cf) && at(cf, 0) !== null) data['center_freq_hz'] = at(cf, 0)

    const fs = await ctx.safeCall('PLL_FreqShiftGet', mod)
    if (!failed(fs) && at(fs, 0) !== null) data['freq_shift_hz'] = at(fs, 0)

    const ag = await ctx.safeCall('PLL_AmpCtrlGainGet', mod)
    if (!failed(ag) && body(ag).length >= 3) {
      data['amp_p_gain'] = at(ag, 0)
      data['amp_time_constant_s'] = at(ag, 1)
      data['amp_i_gain'] = at(ag, 2)
    }

    const pg = await ctx.safeCall('PLL_PhasCtrlGainGet', mod)
    if (!failed(pg) && body(pg).length >= 2) {
      data['phas_p_gain'] = at(pg, 0)
      data['phas_time_constant_s'] = at(pg, 1)
    }

    const ex = await ctx.safeCall('PLL_ExcitationGet', mod)
    if (!failed(ex) && at(ex, 0) !== null) data['excitation_v'] = at(ex, 0)

    return ok(data)
  },
}

/**
 * 开关 PLL 输出与两个控制器。
 *
 * **只有输出那一条的失败算整趟失败**：两个控制器的开关是在输出已经建立之后的调节，
 * 而输出没开的话后面两条都无从谈起。
 */
export const PLLOnOff: Skill = {
  spec: S.PLLOnOffSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const mod = idx(params, 'modulator_index')
    const outputOn = params['output_on'] === true
    const phaseOn = params['phase_ctrl_on'] !== false
    const ampOn = params['amp_ctrl_on'] !== false

    const r = await ctx.safeCall('PLL_OutOnOffSet', mod, outputOn ? 1 : 0)
    if (failed(r)) return fail(r.error ?? '')
    await ctx.safeCall('PLL_PhasCtrlOnOffSet', mod, phaseOn ? 1 : 0)
    await ctx.safeCall('PLL_AmpCtrlOnOffSet', mod, ampOn ? 1 : 0)

    return ok({ output_on: outputOn, phase_ctrl_on: phaseOn, amp_ctrl_on: ampOn })
  },
}

export const ConfigurePLLExcitation: Skill = {
  spec: S.ConfigurePLLExcitationSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const mod = idx(params, 'modulator_index')
    const r = await ctx.safeCall('PLL_ExcitationSet', mod, n(params, 'excitation_v'))
    if (failed(r)) return fail(r.error ?? '')
    if (given(params, 'output_range')) {
      await ctx.safeCall('PLL_ExcRangeSet', mod, n(params, 'output_range'))
    }
    return ok({ excitation_v: n(params, 'excitation_v'), modulator_index: mod })
  },
}

/**
 * 扫一遍频率找共振峰。
 *
 * ## D-PLL-1：`f₀` / `Q` **不写回仪器档案**
 *
 * 旧仓 2026-07-31 把这两个数写进 `instrument_profile` 的实测槽位，理由是
 * 「不然想知道当前音叉的 f₀/Q 就得重扫一次」。本仓还没有那份可写的档案存储
 * （`processLockInProfile` 是只读接线），而**写一个没有读者的值**只会让下一个人
 * 以为有人在用它。留在返回值里，等有消费者时再接。
 */
export const AcquirePLLFreqSweep: Skill = {
  spec: S.AcquirePLLFreqSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const mod = idx(params, 'modulator_index')

    let rec = await ctx.safeCall('PLLFreqSwp_Open', mod)
    if (failed(rec)) return fail(rec.error ?? '')

    rec = await ctx.safeCall(
      'PLLFreqSwp_ParamsSet',
      mod,
      n(params, 'num_points'),
      n(params, 'period_s'),
      given(params, 'settling_time_s') ? n(params, 'settling_time_s') : 0.1,
    )
    if (failed(rec)) return fail(rec.error ?? '')

    const direction = params['sweep_up'] !== false ? 1 : 0
    rec = await ctx.safeCall('PLLFreqSwp_Start', mod, 1, direction)
    if (failed(rec)) return fail(rec.error ?? '')

    const data: Record<string, unknown> = { completed: true }
    if (body(rec).length >= 8) {
      data['resonance_freq_hz'] = at(rec, 6)
      data['q_factor'] = at(rec, 7)
    }
    return ok(data)
  },
}

export const PLLSignalAnalyzer: Skill = {
  spec: S.PLLSignalAnalyzerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let rec = await ctx.safeCall('PLLSignalAnlzr_Open')
    if (failed(rec)) return fail(rec.error ?? '')

    rec = await ctx.safeCall('PLLSignalAnlzr_ChSet', n(params, 'channel_index'))
    if (failed(rec)) return fail(rec.error ?? '')

    const data: Record<string, unknown> = { channel_index: n(params, 'channel_index') }
    const osci = await ctx.safeCall('PLLSignalAnlzr_OsciDataGet')
    // D-SKILL-1：旧仓这里塞的是 `str(整个三段信封)`。我们手上只有 body。
    if (!failed(osci)) data['osci_data'] = [...body(osci)]

    if (params['get_fft'] === true) {
      const fftRec = await ctx.safeCall('PLLSignalAnlzr_FFTDataGet')
      if (!failed(fftRec)) data['fft_data'] = [...body(fftRec)]
    }
    return ok(data)
  },
}

// ── 单动词：读 ─────────────────────────────────────────────────────────────

/**
 * 一个「读一次、映一下」的 PLL 读技能。
 *
 * `raw` 永远在（`decode_reply` 的等价物），映出来的字段**取不出就不写这个键**——
 * 旧仓这里是 `int(v[0])`，空 body 上直接抛 `IndexError`（金样里那一格记着
 * `raised`）。一个只读技能以一句看不懂的异常失败，和「没问出来」是两件事。
 */
function pllRead(
  spec: Skill['spec'],
  verb: string,
  indexKey: string | null,
  map: (rec: SkillCallRecord) => Record<string, unknown>,
): Skill {
  const execute: Exec = async (ctx, params) => {
    const i = indexKey === null ? 1 : idx(params, indexKey)
    const rec = indexKey === null ? await ctx.safeCall(verb) : await ctx.safeCall(verb, i)
    if (failed(rec)) return fail(rec.error ?? '')
    const base: Record<string, unknown> = indexKey === null ? {} : { [indexKey]: i }
    return ok({ ...base, raw: cell(rec), ...map(rec) })
  }
  return { spec, execute }
}

/** 一个开关位（0/1）。取不出就**不写这个键**。 */
const flagAt = (rec: SkillCallRecord, key: string): Record<string, unknown> => {
  const v = at(rec, 0)
  return v === null ? {} : { [key]: v !== 0 }
}
/** 一个整数字段。取不出就不写。 */
const intAt = (rec: SkillCallRecord, key: string, i = 0): Record<string, unknown> => {
  const v = at(rec, i)
  return v === null ? {} : { [key]: Math.trunc(v) }
}
/** 一个浮点字段。取不出就不写。 */
const floatAt = (rec: SkillCallRecord, key: string, i = 0): Record<string, unknown> => {
  const v = at(rec, i)
  return v === null ? {} : { [key]: v }
}

/** 激励输出量程索引 → 人读的量程。认不出的**原样印出来**，不编一个。 */
const EXC_RANGE: Readonly<Record<number, string>> = {
  0: '10V', 1: '1V', 2: '0.1V', 3: '0.01V', 4: '0.001V',
}
const FFT_WINDOW: Readonly<Record<number, string>> = {
  0: 'None', 1: 'Hanning', 2: 'Hamming', 3: 'Blackman-Harris',
  4: 'Exact Blackman', 5: 'Blackman', 6: 'Flat Top',
  7: '4 Term B-Harris', 8: '7 Term B-Harris', 9: 'Low Sidelobe',
}
const FFT_AVG: Readonly<Record<number, string>> = {
  0: 'None', 1: 'Vector', 2: 'RMS', 3: 'Peak Hold',
}
const FFT_WEIGHT: Readonly<Record<number, string>> = { 0: 'Linear', 1: 'Exponential' }

const label = (table: Readonly<Record<number, string>>, i: number): string =>
  table[i] ?? `unknown(${i})`

export const GetPLLAddOnOff = pllRead(S.GetPLLAddOnOffSpec, 'PLL_AddOnOffGet', 'modulator_index',
  (r) => flagAt(r, 'add_on'))
export const GetPLLAmpCtrlOnOff = pllRead(S.GetPLLAmpCtrlOnOffSpec, 'PLL_AmpCtrlOnOffGet', 'modulator_index',
  (r) => flagAt(r, 'amp_ctrl_on'))
export const GetPLLPhasCtrlOnOff = pllRead(S.GetPLLPhasCtrlOnOffSpec, 'PLL_PhasCtrlOnOffGet', 'modulator_index',
  (r) => flagAt(r, 'phase_ctrl_on'))
export const GetPLLDemodFilter = pllRead(S.GetPLLDemodFilterSpec, 'PLL_DemodFilterGet', 'demodulator_index',
  (r) => intAt(r, 'filter_order'))
export const GetPLLDemodHarmonic = pllRead(S.GetPLLDemodHarmonicSpec, 'PLL_DemodHarmonicGet', 'demodulator_index',
  (r) => intAt(r, 'harmonic'))
export const GetPLLFreqRange = pllRead(S.GetPLLFreqRangeSpec, 'PLL_FreqRangeGet', 'modulator_index',
  (r) => floatAt(r, 'frequency_range_hz'))
export const GetPLLInpCalibr = pllRead(S.GetPLLInpCalibrSpec, 'PLL_InpCalibrGet', 'modulator_index',
  (r) => floatAt(r, 'calibration_m_per_v'))

export const GetPLLDemodInput = pllRead(S.GetPLLDemodInputSpec, 'PLL_DemodInputGet', 'demodulator_index',
  (r) => (body(r).length >= 2 ? { ...intAt(r, 'input', 0), ...intAt(r, 'frequency_generator', 1) } : {}))

export const GetPLLInpProps = pllRead(S.GetPLLInpPropsSpec, 'PLL_InpPropsGet', 'modulator_index', (r) => {
  if (body(r).length < 2) return {}
  const a = at(r, 0)
  const b = at(r, 1)
  return a === null || b === null
    ? {}
    : { differential_input: a !== 0, divider_1_10: b !== 0 }
})

export const GetPLLExcRange = pllRead(S.GetPLLExcRangeSpec, 'PLL_ExcRangeGet', 'modulator_index', (r) => {
  const v = at(r, 0)
  if (v === null) return {}
  const i = Math.trunc(v)
  return { output_range_index: i, output_range: label(EXC_RANGE, i) }
})

export const GetPLLSignalAnlzrCh = pllRead(S.GetPLLSignalAnlzrChSpec, 'PLLSignalAnlzr_ChGet', null,
  (r) => intAt(r, 'channel_index'))

export const GetPLLSignalAnlzrTimebase = pllRead(
  S.GetPLLSignalAnlzrTimebaseSpec, 'PLLSignalAnlzr_TimebaseGet', null,
  (r) => (body(r).length >= 2 ? { ...intAt(r, 'timebase_index', 0), ...intAt(r, 'update_rate', 1) } : {}),
)

export const GetPLLSignalAnlzrFFTProps = pllRead(
  S.GetPLLSignalAnlzrFFTPropsSpec, 'PLLSignalAnlzr_FFTPropsGet', null, (r) => {
    if (body(r).length < 4) return {}
    const win = at(r, 0)
    const avg = at(r, 1)
    const wgt = at(r, 2)
    const cnt = at(r, 3)
    if (win === null || avg === null || wgt === null || cnt === null) return {}
    const [w, a, g] = [Math.trunc(win), Math.trunc(avg), Math.trunc(wgt)]
    return {
      fft_window_index: w,
      fft_window: label(FFT_WINDOW, w),
      averaging_mode_index: a,
      averaging_mode: label(FFT_AVG, a),
      weighting_mode_index: g,
      weighting_mode: label(FFT_WEIGHT, g),
      count: Math.trunc(cnt),
    }
  },
)

export const GetPLLFreqSwpParams = pllRead(
  S.GetPLLFreqSwpParamsSpec, 'PLLFreqSwp_ParamsGet', 'modulator_index',
  (r) => (body(r).length >= 3
    ? { ...intAt(r, 'num_points', 0), ...floatAt(r, 'period_s', 1), ...floatAt(r, 'settling_time_s', 2) }
    : {}),
)

// ── 单动词：写 ─────────────────────────────────────────────────────────────

/** 一次写：下发 → 有 error 就原样透传 → 否则把**请求值**回给调用方。 */
function pllWrite(
  spec: Skill['spec'],
  verb: string,
  indexKey: string | null,
  args: (p: Readonly<Record<string, unknown>>, i: number) => unknown[],
  data: (p: Readonly<Record<string, unknown>>, i: number) => Record<string, unknown>,
): Skill {
  const execute: Exec = async (ctx, params) => {
    const i = indexKey === null ? 1 : idx(params, indexKey)
    const rec = await ctx.safeCall(verb, ...args(params, i))
    if (failed(rec)) return fail(rec.error ?? '')
    return ok(data(params, i))
  }
  return { spec, execute }
}

export const SetPLLAmpCtrlBandwidth = pllWrite(
  S.SetPLLAmpCtrlBandwidthSpec, 'PLL_AmpCtrlBandwidthSet', 'modulator_index',
  (p, i) => [i, n(p, 'bandwidth_hz')],
  (p, i) => ({ modulator_index: i, bandwidth_hz: n(p, 'bandwidth_hz') }),
)
export const SetPLLPhasCtrlBandwidth = pllWrite(
  S.SetPLLPhasCtrlBandwidthSpec, 'PLL_PhasCtrlBandwidthSet', 'modulator_index',
  (p, i) => [i, n(p, 'bandwidth_hz')],
  (p, i) => ({ modulator_index: i, bandwidth_hz: n(p, 'bandwidth_hz') }),
)
export const SetPLLAmpCtrlSetpnt = pllWrite(
  S.SetPLLAmpCtrlSetpntSpec, 'PLL_AmpCtrlSetpntSet', 'modulator_index',
  (p, i) => [i, n(p, 'setpoint_m')],
  (p, i) => ({ modulator_index: i, setpoint_m: n(p, 'setpoint_m') }),
)
export const SetPLLDemodFilter = pllWrite(
  S.SetPLLDemodFilterSpec, 'PLL_DemodFilterSet', 'demodulator_index',
  (p, i) => [i, n(p, 'filter_order')],
  (p, i) => ({ demodulator_index: i, filter_order: n(p, 'filter_order') }),
)
export const SetPLLDemodInput = pllWrite(
  S.SetPLLDemodInputSpec, 'PLL_DemodInputSet', 'demodulator_index',
  (p, i) => [i, n(p, 'input'), n(p, 'frequency_generator')],
  (p, i) => ({
    demodulator_index: i,
    input: n(p, 'input'),
    frequency_generator: n(p, 'frequency_generator'),
  }),
)
export const SetPLLDemodPhasRef = pllWrite(
  S.SetPLLDemodPhasRefSpec, 'PLL_DemodPhasRefSet', 'demodulator_index',
  (p, i) => [i, n(p, 'phase_reference_deg')],
  (p, i) => ({ demodulator_index: i, phase_reference_deg: n(p, 'phase_reference_deg') }),
)
export const SetPLLFreqExcOverwrite = pllWrite(
  S.SetPLLFreqExcOverwriteSpec, 'PLL_FreqExcOverwriteSet', 'modulator_index',
  (p, i) => [i, n(p, 'excitation_overwrite_index'), n(p, 'frequency_overwrite_index')],
  (p, i) => ({
    modulator_index: i,
    excitation_overwrite_index: n(p, 'excitation_overwrite_index'),
    frequency_overwrite_index: n(p, 'frequency_overwrite_index'),
  }),
)
export const SetPLLFreqRange = pllWrite(
  S.SetPLLFreqRangeSpec, 'PLL_FreqRangeSet', 'modulator_index',
  (p, i) => [i, n(p, 'frequency_range_hz')],
  (p, i) => ({ modulator_index: i, frequency_range_hz: n(p, 'frequency_range_hz') }),
)
export const SetPLLInpCalibr = pllWrite(
  S.SetPLLInpCalibrSpec, 'PLL_InpCalibrSet', 'modulator_index',
  (p, i) => [i, n(p, 'calibration_m_per_v')],
  (p, i) => ({ modulator_index: i, calibration_m_per_v: n(p, 'calibration_m_per_v') }),
)
export const SetPLLInpRange = pllWrite(
  S.SetPLLInpRangeSpec, 'PLL_InpRangeSet', 'modulator_index',
  (p, i) => [i, n(p, 'input_range_m')],
  (p, i) => ({ modulator_index: i, input_range_m: n(p, 'input_range_m') }),
)
export const SetPLLInpProps = pllWrite(
  S.SetPLLInpPropsSpec, 'PLL_InpPropsSet', 'modulator_index',
  (p, i) => [i, p['differential_input'] === true ? 1 : 0, p['divider_1_10'] === true ? 1 : 0],
  (p, i) => ({
    modulator_index: i,
    differential_input: p['differential_input'],
    divider_1_10: p['divider_1_10'],
  }),
)
export const PLLFreqShiftAutoCenter = pllWrite(
  S.PLLFreqShiftAutoCenterSpec, 'PLL_FreqShiftAutoCenter', 'modulator_index',
  (_p, i) => [i],
  (_p, i) => ({ modulator_index: i }),
)
export const PLLPerfectPLLUpdtZTC = pllWrite(
  S.PLLPerfectPLLUpdtZTCSpec, 'PLL_PerfectPLLUpdtZTC', 'modulator_index',
  (_p, i) => [i],
  (_p, i) => ({ modulator_index: i }),
)
export const StopPLLFreqSwp = pllWrite(
  S.StopPLLFreqSwpSpec, 'PLLFreqSwp_Stop', 'modulator_index',
  (_p, i) => [i],
  (_p, i) => ({ modulator_index: i }),
)
export const PLLSignalAnlzrTrigAuto = pllWrite(
  S.PLLSignalAnlzrTrigAutoSpec, 'PLLSignalAnlzr_TrigAuto', null,
  () => [],
  () => ({}),
)
export const SetPLLSignalAnlzrTrig = pllWrite(
  S.SetPLLSignalAnlzrTrigSpec, 'PLLSignalAnlzr_TrigSet', null,
  (p) => [
    n(p, 'trigger_mode'), n(p, 'trigger_source'), n(p, 'trigger_slope'),
    n(p, 'trigger_level'), n(p, 'trigger_position_s'), n(p, 'arming_mode'),
  ],
  (p) => ({
    trigger_mode: n(p, 'trigger_mode'),
    trigger_source: n(p, 'trigger_source'),
    trigger_slope: n(p, 'trigger_slope'),
    trigger_level: n(p, 'trigger_level'),
    trigger_position_s: n(p, 'trigger_position_s'),
    arming_mode: n(p, 'arming_mode'),
  }),
)

export const PLL: Readonly<Record<string, Skill>> = {
  ConfigurePLL,
  GetPLLStatus,
  PLLOnOff,
  ConfigurePLLExcitation,
  AcquirePLLFreqSweep,
  PLLSignalAnalyzer,
  GetPLLAddOnOff,
  SetPLLAmpCtrlBandwidth,
  GetPLLAmpCtrlOnOff,
  SetPLLAmpCtrlSetpnt,
  GetPLLDemodFilter,
  SetPLLDemodFilter,
  GetPLLDemodHarmonic,
  GetPLLDemodInput,
  SetPLLDemodInput,
  SetPLLDemodPhasRef,
  GetPLLExcRange,
  SetPLLFreqExcOverwrite,
  GetPLLFreqRange,
  SetPLLFreqRange,
  PLLFreqShiftAutoCenter,
  GetPLLInpCalibr,
  SetPLLInpCalibr,
  GetPLLInpProps,
  SetPLLInpProps,
  SetPLLInpRange,
  PLLPerfectPLLUpdtZTC,
  SetPLLPhasCtrlBandwidth,
  GetPLLPhasCtrlOnOff,
  GetPLLSignalAnlzrCh,
  GetPLLSignalAnlzrFFTProps,
  GetPLLSignalAnlzrTimebase,
  PLLSignalAnlzrTrigAuto,
  SetPLLSignalAnlzrTrig,
  GetPLLFreqSwpParams,
  StopPLLFreqSwp,
}
