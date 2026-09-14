/**
 * 通用 PI 控制器（两代）、MCVA5 前放、PLL 分析、OC Sync、针尖记录器。
 *
 * **全部选配，全部默认关**（设置 → 硬件模块）。
 *
 * ## 同一个模块的两代，而且不是同一套 API
 *
 * Nanonis 把通用 PI 控制器发了两次：
 *
 * - `PICtrl_*` —— **V5e** 那一代。**带下标**：每一次调用都要 `Controller_Index`，
 *   因为它有好几路。操作员的机器是 V5e，所以这一代才是要紧的那个。
 * - `GenPICtrl_*` —— **V5** 那一代。单例、没有下标，而且多一段 V5e 没有的模拟输出。
 *
 * 两代都包，是因为**许可证文件不会告诉你机箱里装的是哪一代**。
 * 一次「模块不可用」的错意味着你手上是另一代 —— 换技能，不是改设置。
 *
 * ## 一个通用 PI 环是什么
 *
 * 指给它任意一路输入信号、给一个设定点，它就驱动任意一路输出直到输入对上。
 * 那是一把**非常锋利**的工具：输出可以是压电、可以是偏压、可以是激光、可以是加热器。
 * **模块自己不知道，也警告不了你。** 这就是闭合这样一个环要 CONFIRM 的理由。
 *
 * ## 限值先写，再写别的
 *
 * `ConfigurePiController` 与 Kelvin 环同一条顺序：**护栏先架好**。
 * 后面任何一步失败时，手上已经是一组带界的参数，而不是一个整定好了、
 * 界还停在上一次（可能大开）的环。
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { cell, fail, formatG6, ok } from './common.js'
import { f, failed, given, i, multiRead, offByDefault, onByDefault, step } from './optional-common.js'

// ── 通用 PI 控制器 · V5e（带下标）────────────────────────────────────────────

export const ConfigurePiController: Skill = {
  spec: S.ConfigurePiControllerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = i(params, 'controller_index')
    const lo = f(params, 'output_lower_limit')
    const hi = f(params, 'output_upper_limit')
    // **拒，不换过来**：一对反了的输出限意味着调用方把两个数搞混了，
    // 而这个环会立刻把输出推到轨上 —— 那一路输出可能是压电、偏压或者加热器。
    if (lo >= hi) {
      return fail(
        `output_lower_limit (${formatG6(lo)}) 必须小于 output_upper_limit (${formatG6(hi)})` +
          '——限值反了，环会立刻把输出推到轨上',
      )
    }

    // 护栏先架好 —— 后面哪一步失败，手上都已经是一组带界的参数。
    let s = await step(ctx, 'PICtrl_CtrlChPropsSet', idx, lo, hi)
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'PICtrl_InputChSet', idx, i(params, 'input_index'))
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'PICtrl_CtrlChSet', idx, i(params, 'control_signal_index'))
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'PICtrl_PropsSet', idx,
      f(params, 'setpoint'),
      given(params, 'p_gain') ? f(params, 'p_gain') : 1.0,
      given(params, 'i_gain') ? f(params, 'i_gain') : 0.0,
      given(params, 'slope') ? i(params, 'slope') : 0,
    )
    if (s.error !== null) return fail(s.error)

    return ok(
      {
        controller_index: idx,
        setpoint: f(params, 'setpoint'),
        output_limits: [lo, hi],
        // **配完环仍然是开路的。** 这个 `false` 不是读回来的，是这个技能的约定：
        // 它只整定，闭合是另一个技能的、要单独确认的动作。
        controller_on: false,
      },
      `PI 控制器 ${idx} 已配置：输出限 [${formatG6(lo)}, ${formatG6(hi)}]` +
        '（环仍开路——需 SetPiControllerOnOff 才闭合）',
    )
  },
}

/**
 * 闭合 / 断开一个通用 PI 环。
 *
 * 两句 summary **说的是两件不同的事**：闭合之后环在**自主驱动**那一路输出；
 * 断开之后输出**停在环最后给的值**上——不是回零，不是回到你设它之前的样子。
 * 那个停住的值是这个技能唯一能交代清楚的东西。
 */
export const SetPiControllerOnOff: Skill = {
  spec: S.SetPiControllerOnOffSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = i(params, 'controller_index')
    const on = params['on'] === true
    const rec = await ctx.safeCall('PICtrl_OnOffSet', idx, on ? 1 : 0)
    if (failed(rec)) return fail(`PICtrl_OnOffSet failed: ${rec.error ?? ''}`)
    return ok(
      { controller_index: idx, controller_on: on },
      on
        ? `PI 控制器 ${idx} 已闭合——它现在正在自主驱动输出`
        : `PI 控制器 ${idx} 已开路（输出停在环最后给的值）`,
    )
  },
}

export const GetPiController: Skill = {
  spec: S.GetPiControllerSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = i(params, 'controller_index')
    return multiRead(
      [
        ['controller_on', () => ctx.safeCall('PICtrl_OnOffGet', idx)],
        ['input_signal', () => ctx.safeCall('PICtrl_InputChGet', idx)],
        ['control_signal', () => ctx.safeCall('PICtrl_CtrlChGet', idx)],
        ['props', () => ctx.safeCall('PICtrl_PropsGet', idx)],
        ['output_limits', () => ctx.safeCall('PICtrl_CtrlChPropsGet', idx)],
      ],
      { controller_index: idx },
    )
  },
}

// ── 通用 PI 控制器 · V5（单例，带模拟输出）──────────────────────────────────

export const SetGenericPiOutput: Skill = {
  spec: S.SetGenericPiOutputSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const v = f(params, 'value')
    const rec = await ctx.safeCall('GenPICtrl_AOValSet', v)
    if (failed(rec)) return fail(`GenPICtrl_AOValSet failed: ${rec.error ?? ''}`)
    return ok({ value: v }, `通用 PI(V5) 模拟输出 = ${formatG6(v)}（物理单位）`)
  },
}

export const GetGenericPiController: Skill = {
  spec: S.GetGenericPiControllerSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['controller_on', () => ctx.safeCall('GenPICtrl_OnOffGet')],
      ['props', () => ctx.safeCall('GenPICtrl_PropsGet')],
      ['output_value', () => ctx.safeCall('GenPICtrl_AOValGet')],
      ['output_props', () => ctx.safeCall('GenPICtrl_AOPropsGet')],
      ['modulation_channel', () => ctx.safeCall('GenPICtrl_ModChGet')],
      ['demod_channel', () => ctx.safeCall('GenPICtrl_DemodChGet')],
    ]),
}

// ── MCVA5 前放 ──────────────────────────────────────────────────────────────

/**
 * 三项各写各的，**一个都不给就拒**。
 *
 * 那句拒绝存在是因为一次「什么都没改」的成功，和一次改好了的成功，在返回值上
 * 长得一样。`changed` 那张表是这个技能唯一说得清「我到底动了什么」的地方。
 */
export const ConfigurePreamp: Skill = {
  spec: S.ConfigurePreampSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const pre = i(params, 'preamp')
    const ch = i(params, 'channel')
    const touched: string[] = []

    for (const [key, verb] of [
      ['gain', 'MCVA5_GainSet'],
      ['coupling', 'MCVA5_CouplingSet'],
      ['input_mode', 'MCVA5_InputModeSet'],
    ] as const) {
      if (!given(params, key)) continue
      // 动词写成字面量而不是走上面那张表的变量：安全工具靠 grep `safeCall('…')`
      // 找 Nanonis 调用。这里的 `verb` 只用来拼报文，真正发出去的是下面三条之一。
      const rec =
        key === 'gain'
          ? await ctx.safeCall('MCVA5_GainSet', pre, ch, i(params, 'gain'))
          : key === 'coupling'
            ? await ctx.safeCall('MCVA5_CouplingSet', pre, ch, i(params, 'coupling'))
            : await ctx.safeCall('MCVA5_InputModeSet', pre, ch, i(params, 'input_mode'))
      if (failed(rec)) return fail(`${verb} failed: ${rec.error ?? ''}`)
      touched.push(key)
    }

    if (touched.length === 0) return fail('gain / coupling / input_mode 至少要给一个')
    return ok(
      { preamp: pre, channel: ch, changed: touched },
      `MCVA5 前放 ${pre}/${ch} 已设置：${touched.join(', ')}`,
    )
  },
}

export const GetPreamp: Skill = {
  spec: S.GetPreampSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const pre = i(params, 'preamp')
    const ch = i(params, 'channel')
    return multiRead(
      [
        ['gain', () => ctx.safeCall('MCVA5_GainGet', pre, ch)],
        ['coupling', () => ctx.safeCall('MCVA5_CouplingGet', pre, ch)],
        ['input_mode', () => ctx.safeCall('MCVA5_InputModeGet', pre, ch)],
      ],
      { preamp: pre, channel: ch },
    )
  },
}

// ── PLL 分析：Zoom FFT / 相位扫描 / 信号分析仪 ───────────────────────────────

export const RunPllZoomFft: Skill = {
  spec: S.RunPllZoomFftSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let s = await step(ctx, 'PLLZoomFFT_Open')
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'PLLZoomFFT_ChSet', i(params, 'channel_index'))
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'PLLZoomFFT_PropsSet',
      given(params, 'fft_window') ? i(params, 'fft_window') : 1,
      given(params, 'averaging_mode') ? i(params, 'averaging_mode') : 0,
      given(params, 'weighting_mode') ? i(params, 'weighting_mode') : 0,
      given(params, 'count') ? i(params, 'count') : 10,
    )
    if (s.error !== null) return fail(s.error)

    if (onByDefault(params, 'restart_averaging')) {
      s = await step(ctx, 'PLLZoomFFT_AvgRestart')
      if (s.error !== null) return fail(s.error)
    }

    return ok(
      { channel_index: i(params, 'channel_index') },
      'PLL Zoom FFT 已启动 —— 用 GetPllZoomFftData 读频谱',
    )
  },
}

export const GetPllZoomFftData: Skill = {
  spec: S.GetPllZoomFftDataSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['spectrum', () => ctx.safeCall('PLLZoomFFT_DataGet')],
      ['props', () => ctx.safeCall('PLLZoomFFT_PropsGet')],
      ['channel', () => ctx.safeCall('PLLZoomFFT_ChGet')],
    ]),
}

export const RunPllPhaseSweep: Skill = {
  spec: S.RunPllPhaseSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = i(params, 'modulator_index')
    const rec = await ctx.safeCall(
      'PLLPhasSwp_Start',
      idx,
      onByDefault(params, 'get_data') ? 1 : 0,
    )
    if (failed(rec)) return fail(`PLLPhasSwp_Start failed: ${rec.error ?? ''}`)
    return ok(
      { modulator_index: idx, curve: cell(rec) },
      `PLL 相位扫描完成（调制器 ${idx}）`,
    )
  },
}

export const StopPllPhaseSweep: Skill = {
  spec: S.StopPllPhaseSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = i(params, 'modulator_index')
    const rec = await ctx.safeCall('PLLPhasSwp_Stop', idx)
    if (failed(rec)) return fail(`PLLPhasSwp_Stop failed: ${rec.error ?? ''}`)
    return ok({ modulator_index: idx }, `PLL 相位扫描已停止（调制器 ${idx}）`)
  },
}

/**
 * 信号分析仪：通道 + 时基 + FFT 属性，一次配完。
 *
 * 时基那一段**先读再写**：`TimebaseSet` 吃的是一对（时基, 刷新率），
 * 而调用方常常只想改其中一个。省掉的那个若按缺省写下去，就是悄悄改了一个
 * 调用方没提过的设置。
 */
export const ConfigurePllSignalAnalyzer: Skill = {
  spec: S.ConfigurePllSignalAnalyzerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let s = await step(ctx, 'PLLSignalAnlzr_Open')
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'PLLSignalAnlzr_ChSet', i(params, 'channel_index'))
    if (s.error !== null) return fail(s.error)

    if (given(params, 'timebase') || given(params, 'update_rate')) {
      const cur = await ctx.safeCall('PLLSignalAnlzr_TimebaseGet')
      if (failed(cur)) return fail(`PLLSignalAnlzr_TimebaseGet failed: ${cur.error ?? ''}`)
      const got = cell(cur)
      // 读不出那一对时退回 `(0.0, 1)` —— 与旧仓同一个兜底。
      const pair = Array.isArray(got) && got.length >= 2 ? got : [0.0, 1]
      s = await step(
        ctx, 'PLLSignalAnlzr_TimebaseSet',
        given(params, 'timebase') ? f(params, 'timebase') : Number(pair[0]),
        given(params, 'update_rate') ? i(params, 'update_rate') : Math.trunc(Number(pair[1])),
      )
      if (s.error !== null) return fail(s.error)
    }

    s = await step(
      ctx, 'PLLSignalAnlzr_FFTPropsSet',
      given(params, 'fft_window') ? i(params, 'fft_window') : 1,
      given(params, 'averaging_mode') ? i(params, 'averaging_mode') : 0,
      given(params, 'weighting_mode') ? i(params, 'weighting_mode') : 0,
      given(params, 'count') ? i(params, 'count') : 10,
    )
    if (s.error !== null) return fail(s.error)

    return ok({ channel_index: i(params, 'channel_index') }, 'PLL 信号分析仪已配置')
  },
}

/**
 * 三份数据一起取。
 *
 * `rearm` 那一条的错**不看**：重新布防失败不代表读不到东西，而把已经在缓冲里的
 * 那一段丢掉换一句报错，是把有的东西换成了没有的。
 */
export const GetPllSignalAnalyzerData: Skill = {
  spec: S.GetPllSignalAnalyzerDataSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    if (offByDefault(params, 'rearm')) await ctx.safeCall('PLLSignalAnlzr_TrigRearm')
    return multiRead([
      ['trace', () => ctx.safeCall('PLLSignalAnlzr_OsciDataGet')],
      ['spectrum', () => ctx.safeCall('PLLSignalAnlzr_FFTDataGet')],
      ['trigger', () => ctx.safeCall('PLLSignalAnlzr_TrigGet')],
    ])
  },
}

// ── OC Sync + 针尖记录器 ────────────────────────────────────────────────────

export const ConfigureOcSync: Skill = {
  spec: S.ConfigureOcSyncSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let s = await step(
      ctx, 'OCSync_AnglesSet',
      f(params, 'ch1_on_deg'), f(params, 'ch1_off_deg'),
      f(params, 'ch2_on_deg'), f(params, 'ch2_off_deg'),
    )
    if (s.error !== null) return fail(s.error)

    // 两路用同一个联动标志 —— 旧仓就是这么发的（`LinkAnglesSet(link, link)`）。
    const link = offByDefault(params, 'link_channels') ? 1 : 0
    s = await step(ctx, 'OCSync_LinkAnglesSet', link, link)
    if (s.error !== null) return fail(s.error)

    return ok(
      { ch1_on_deg: f(params, 'ch1_on_deg'), ch1_off_deg: f(params, 'ch1_off_deg') },
      'OC Sync 相位角已设置',
    )
  },
}

export const GetOcSync: Skill = {
  spec: S.GetOcSyncSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['angles', () => ctx.safeCall('OCSync_AnglesGet')],
      ['links', () => ctx.safeCall('OCSync_LinkAnglesGet')],
    ]),
}

export const ConfigureTipRecorder: Skill = {
  spec: S.ConfigureTipRecorderSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const size = i(params, 'buffer_size')
    let s = await step(ctx, 'TipRec_BufferSizeSet', size)
    if (s.error !== null) return fail(s.error)

    const clear = offByDefault(params, 'clear')
    if (clear) {
      s = await step(ctx, 'TipRec_BufferClear')
      if (s.error !== null) return fail(s.error)
    }
    return ok({ buffer_size: size, cleared: clear }, `针尖记录器缓冲区 = ${size} 条`)
  },
}

export const GetTipRecorderData: Skill = {
  spec: S.GetTipRecorderDataSpec,
  execute: (ctx: SkillContext): Promise<SkillResultLike> =>
    multiRead([
      ['moves', () => ctx.safeCall('TipRec_DataGet')],
      ['buffer_size', () => ctx.safeCall('TipRec_BufferSizeGet')],
    ]),
}

export const OPTIONAL_CONTROLLERS: Readonly<Record<string, Skill>> = {
  ConfigurePiController,
  SetPiControllerOnOff,
  GetPiController,
  SetGenericPiOutput,
  GetGenericPiController,
  ConfigurePreamp,
  GetPreamp,
  RunPllZoomFft,
  GetPllZoomFftData,
  RunPllPhaseSweep,
  StopPllPhaseSweep,
  ConfigurePllSignalAnalyzer,
  GetPllSignalAnalyzerData,
  ConfigureOcSync,
  GetOcSync,
  ConfigureTipRecorder,
  GetTipRecorderData,
}
