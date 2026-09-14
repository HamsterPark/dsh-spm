/**
 * 高速扫描器（HSSwp）与任意波 / RF 源（APRFGen）。
 *
 * **两个都是选配硬件，都默认关**（设置 → 硬件模块）。
 *
 * 这两个是整套选配里**最锋利**的，而且锋利的方向相反：
 *
 * - **HSSwp** 扫的是**任意一路信号** —— 你用索引告诉它是哪一路。指到偏压上它是一次
 *   快速偏压扫描，指到压电上**它在移动针尖**。模块自己不知道你想的是哪一种。
 *   它还能在扫描期间把 Z 反馈抬掉（`ZCtrlOffSet`）——做谱学时那正是你要的，
 *   而如果被扫的那路信号会牵动 Z，那就是一次撞针。
 * - **APRFGen** 往外送 RF **功率**。`StartRfGenerator` 之所以 DANGEROUS，不是因为它
 *   移动了什么，而是因为**打进隧道结的 dBm 是能量**，而智能体对多少算多没有手感。
 *
 * 所以两个都各带一个显式的停止技能，而且两边的停止动词
 * （`HSSwp_Stop`、`APRFGen_SwpStop`，以及 OFF 形态的 `APRFGen_RFOutOnOffSet`）
 * **都在中止后的放行清单里** —— 按下中止必须能杀掉一次正在跑的扫描、切掉 RF，
 * 而不是因为中止标志立着就让它们继续跑。
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { formatG } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, formatG6, ok, pyStr } from './common.js'
import {
  cell, f, failed, given, i, offByDefault, onByDefault, signalChannels, step,
} from './optional-common.js'

/** `APRFGen_FreqSwpStart(Direction)`：0 = 向下，1 = 向上。 */
const DIRECTIONS: Readonly<Record<string, number>> = { up: 1, down: 0 }
/** `APRFGen_RFOutOnOffSet(RF_Output)`：0 = 关，1 = 开。 */
const RF_OFF = 0
const RF_ON = 1

// ── 高速扫描器 ──────────────────────────────────────────────────────────────

/**
 * 一次把整台扫描器配完：扫哪一路、扫到哪、几个点、时序、采哪几路、Z 要不要抬。
 *
 * ## D-ZERO-1 第四次：`num_sweeps = 0` 那个无限标志翻不起来
 *
 * 声明里写着 `0 = 一直连续扫到被停止为止`，`min_value = 0`，而代码里也确实有
 * `1 if n == 0 else 0` 这一支 —— 但 `n = int(params.get("num_sweeps", 1) or 1)`
 * 里的 `or 1` 让 `n` **永远不可能是 0**。于是那个分支是死的，
 * 而一次「连续扫到我喊停」的请求会安安静静地变成**扫一次**。
 *
 * 本仓让 0 通过。这条与批 3e 那三处是同一条判据（**`0` 在这个参数上是不是一个
 * 合法值**），而这里还多一条理由：`StopHighSpeedSweep` 存在，
 * 且 `HSSwp_Stop` 在中止后的放行清单里 —— **停得下来，才敢让它无限。**
 */
export const ConfigureHighSpeedSweep: Skill = {
  spec: S.ConfigureHighSpeedSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const chs = signalChannels(params['acquire_channels'])
    if (chs === null) {
      return fail(
        `acquire_channels 解析失败：'${String(params['acquire_channels'] ?? '')}'` +
          '（应为逗号分隔的信号索引）',
      )
    }

    const sig = i(params, 'sweep_signal_index')
    // 第二个实参 0 = 不是定时扫描
    let s = await step(ctx, 'HSSwp_SwpChSignalSet', sig, 0)
    if (s.error !== null) return fail(s.error)

    const relative = offByDefault(params, 'relative_limits')
    s = await step(
      ctx, 'HSSwp_SwpChLimitsSet', relative ? 1 : 0,
      f(params, 'start'), f(params, 'stop'),
    )
    if (s.error !== null) return fail(s.error)

    const points = given(params, 'points') ? i(params, 'points') : 256
    s = await step(ctx, 'HSSwp_SwpChNumPtsSet', points)
    if (s.error !== null) return fail(s.error)

    s = await step(
      ctx, 'HSSwp_SwpChTimingSet',
      given(params, 'initial_settling_time_s') ? f(params, 'initial_settling_time_s') : 1e-3,
      given(params, 'settling_time_s') ? f(params, 'settling_time_s') : 1e-4,
      given(params, 'integration_time_s') ? f(params, 'integration_time_s') : 1e-4,
      given(params, 'max_slew_time_s') ? f(params, 'max_slew_time_s') : 1.0,
    )
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'HSSwp_SwpChBwdSwSet', onByDefault(params, 'backward_sweep') ? 1 : 0)
    if (s.error !== null) return fail(s.error)

    // `0` 算给了（D-ZERO-1）：它翻起那个无限标志，而这正是声明承诺的事。
    const n = given(params, 'num_sweeps') ? i(params, 'num_sweeps') : 1
    s = await step(ctx, 'HSSwp_NumSweepsSet', Math.max(n, 1), n === 0 ? 1 : 0)
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'HSSwp_AcqChsSet', chs)
    if (s.error !== null) return fail(s.error)

    // HSSwp_ZCtrlOffSet(Z_Controller_Off, Z_Controller_Index, Z_Averaging_Time,
    //                   Z_Offset, Z_Control_Time)
    const zOff = offByDefault(params, 'z_controller_off')
    s = await step(
      ctx, 'HSSwp_ZCtrlOffSet', zOff ? 1 : 0, 0, 0.05,
      given(params, 'z_offset_m') ? f(params, 'z_offset_m') : 0.0, 0.05,
    )
    if (s.error !== null) return fail(s.error)

    return ok(
      {
        sweep_signal_index: sig,
        start: f(params, 'start'),
        stop: f(params, 'stop'),
        relative_limits: relative,
        points,
        acquire_channels: chs,
        z_controller_off: zOff,
      },
      // ⚠️ 这一句里 `信号`/`点` 是**声明成 int** 的参数（印整数），
      // 而 `start`/`stop` 是**声明成 float** 的（Python `str(-1.0)` 给 `'-1.0'`，
      // 而 JS 的 `String(-1)` 给 `'-1'`）—— 所以两者用的不是同一个转换。
      `HSSwp 已配置：信号 ${sig}，${pyStr(f(params, 'start'))}→${pyStr(f(params, 'stop'))}` +
        `（${relative ? '相对' : '绝对'}），${points} 点` +
        (zOff ? '，Z 反馈将关闭' : ''),
    )
  },
}

export const RunHighSpeedSweep: Skill = {
  spec: S.RunHighSpeedSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const wait = onByDefault(params, 'wait')
    const timeout = given(params, 'timeout_s') ? f(params, 'timeout_s') : 60.0
    const rec = await ctx.safeCall('HSSwp_Start', wait ? 1 : 0, timeout)
    if (failed(rec)) return fail(`HSSwp_Start failed: ${rec.error ?? ''}`)
    return ok(
      { waited: wait, result: cell(rec) },
      wait ? '高速扫描完成' : '高速扫描已启动（后台运行）',
    )
  },
}

export const StopHighSpeedSweep: Skill = {
  spec: S.StopHighSpeedSweepSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('HSSwp_Stop')
    if (failed(rec)) return fail(`HSSwp_Stop failed: ${rec.error ?? ''}`)
    return { success: true, summary: '高速扫描已停止' }
  },
}

export const GetHighSpeedSweepStatus: Skill = {
  spec: S.GetHighSpeedSweepStatusSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const data: Record<string, unknown> = {}
    for (const [key, thunk] of [
      ['status', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('HSSwp_StatusGet')],
      ['sweepable_signals', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('HSSwp_SwpChSigListGet')],
      ['sweep_signal', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('HSSwp_SwpChSignalGet')],
      ['limits', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('HSSwp_SwpChLimitsGet')],
      ['points', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('HSSwp_SwpChNumPtsGet')],
      ['acquire_channels', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('HSSwp_AcqChsGet')],
    ] as const) {
      const rec = await thunk()
      data[key] = failed(rec) ? null : cell(rec)
    }
    return ok(data)
  },
}

// ── 任意波 / RF 源 ──────────────────────────────────────────────────────────

/**
 * 设频率与功率，**但不开输出**。
 *
 * 两条 Set 的第一个实参都是 `Force_RF_On = 0`：设值，**不要**顺手把输出打开。
 * 那正是这个技能与 `StartRfGenerator` 分开的全部理由 —— 配置与通电是两个决定。
 */
export const ConfigureRfGenerator: Skill = {
  spec: S.ConfigureRfGeneratorSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const freq = f(params, 'frequency_hz')
    const power = f(params, 'power_dbm')

    let s = await step(ctx, 'APRFGen_FreqSet', 0, freq)
    if (s.error !== null) return fail(s.error)

    s = await step(ctx, 'APRFGen_PowerSet', 0, power)
    if (s.error !== null) return fail(s.error)

    return ok(
      { frequency_hz: freq, power_dbm: power, output_on: false },
      // `:.6g` 与 `:.4g` —— 两个不同的精度，逐字照旧仓
      `RF 已配置：${formatG(freq, 6)} Hz，${formatG(power, 4)} dBm（输出仍关闭）`,
    )
  },
}

export const StartRfGenerator: Skill = {
  spec: S.StartRfGeneratorSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('APRFGen_RFOutOnOffSet', RF_ON)
    if (failed(rec)) return fail(`APRFGen_RFOutOnOffSet failed: ${rec.error ?? ''}`)
    return ok({ output_on: true }, 'RF 输出已开启')
  },
}

/**
 * 停扫描**并且**切输出。
 *
 * ⚠️ **扫描停不下来时照样切输出** —— 一次失败的停扫正是你最需要把输出关掉的时候。
 * 把这两条写成「前一条失败就返回」会让最危险的那一格恰好走不到第二条。
 * 停扫的那句错不丢，它进 summary。
 */
export const StopRfGenerator: Skill = {
  spec: S.StopRfGeneratorSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const swp = await ctx.safeCall('APRFGen_SwpStop')
    const sweepErr = failed(swp) ? (swp.error ?? '') : ''

    const rec = await ctx.safeCall('APRFGen_RFOutOnOffSet', RF_OFF)
    if (failed(rec)) return fail(`APRFGen_RFOutOnOffSet(off) failed: ${rec.error ?? ''}`)

    return ok(
      { output_on: false },
      sweepErr !== ''
        ? `RF 输出已关闭（扫描停止报错：${sweepErr}）`
        : 'RF 扫描已停止，输出已关闭',
    )
  },
}

/**
 * 一次有界的频率扫描。
 *
 * `Infinite` 那一位**永远写 0** —— 与 HSSwp 的 `num_sweeps` 刻意相反：
 * 一次无限的 RF 扫描是持续往隧道结里灌功率，而这里没有一个「扫到你喊停」的用例
 * 值得抵掉那个风险。旧仓的注释把话说死了：
 * 「**an agent must never start an unbounded RF sweep**」。
 */
export const RunRfFrequencySweep: Skill = {
  spec: S.RunRfFrequencySweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const lo = f(params, 'lower_hz')
    const hi = f(params, 'upper_hz')
    if (lo >= hi) {
      return fail(`lower_hz (${formatG6(lo)}) 必须小于 upper_hz (${formatG6(hi)})`)
    }

    let s = await step(ctx, 'APRFGen_FreqSwpLimitsSet', lo, hi)
    if (s.error !== null) return fail(s.error)

    // APRFGen_FreqSwpPropsSet(Mode, Dwell_s, Repetitions, Infinite, Points,
    //                         Off_s, AutoOff)
    const autoOff = onByDefault(params, 'auto_off')
    const points = given(params, 'points') ? i(params, 'points') : 101
    const dwell = given(params, 'dwell_s') ? f(params, 'dwell_s') : 0.01
    s = await step(
      ctx, 'APRFGen_FreqSwpPropsSet', 0,
      dwell,
      given(params, 'repetitions') ? f(params, 'repetitions') : 1,
      0, // Infinite —— 见上
      points,
      0.0,
      autoOff ? 1 : 0,
    )
    if (s.error !== null) return fail(s.error)

    const dir = DIRECTIONS[String(params['direction'] ?? '') || 'up'] ?? DIRECTIONS['up']
    s = await step(ctx, 'APRFGen_FreqSwpStart', dir)
    if (s.error !== null) return fail(s.error)

    return ok(
      { lower_hz: lo, upper_hz: hi, points, dwell_s: dwell, auto_off: autoOff },
      `RF 频率扫描已启动：${formatG(lo, 6)}→${formatG(hi, 6)} Hz，${points} 点` +
        (autoOff ? '，结束后自动关输出' : '，结束后输出保持开启'),
    )
  },
}

export const GetRfGeneratorStatus: Skill = {
  spec: S.GetRfGeneratorStatusSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const data: Record<string, unknown> = {}
    for (const [key, thunk] of [
      ['output_on', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('APRFGen_RFOutOnOffGet')],
      ['frequency_hz', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('APRFGen_FreqGet')],
      ['power_dbm', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('APRFGen_PowerGet')],
      ['freq_sweep_limits', (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('APRFGen_FreqSwpLimitsGet')],
    ] as const) {
      const rec = await thunk()
      data[key] = failed(rec) ? null : cell(rec)
    }
    return ok(data)
  },
}

export const OPTIONAL_SWEEPERS: Readonly<Record<string, Skill>> = {
  ConfigureHighSpeedSweep,
  RunHighSpeedSweep,
  StopHighSpeedSweep,
  GetHighSpeedSweepStatus,
  ConfigureRfGenerator,
  StartRfGenerator,
  StopRfGenerator,
  RunRfFrequencySweep,
  GetRfGeneratorStatus,
}
