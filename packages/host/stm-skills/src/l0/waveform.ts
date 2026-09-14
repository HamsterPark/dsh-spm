/**
 * 函数发生器（`FunGen1Ch_*` / `FunGen2Ch_*`）—— 两台不同的机器，一个技能面。
 *
 * ## 单通道收频率，双通道收**周期**
 *
 * `FunGen2Ch_PropsSet` 的那个参数是**周期（秒）**，不是频率。把频率直接透传过去，
 * 一次 1 kHz 的请求会被设成 **1000 秒**的周期 —— 差六个数量级，
 * **静悄悄地，在一台谁也看不见的硬件上**。所以这里换算：`period = 1 / frequency`。
 *
 * 这是本仓第二次撞上「两个看着一样的参数其实是倒数关系」这类单位陷阱
 * （另一次在 `advanced-ops.ts`：`Scan_WaitEndOfScan` 收的是毫秒）。
 * 两次的共同点是**错了不会报错**，只会安静地做另一件事。
 *
 * ## 动词写成字面量，两条分支多花三行
 *
 * 本仓每一件安全工具（中止后放行清单的核对、安全审计、API 覆盖清点）都靠
 * grep `safeCall('…')` 把 Nanonis 动词读出来。**藏在变量后面的动词对它们全都不可见。**
 * 旧仓的注释记着这件事是怎么被发现的：它自己的守卫发现这个文件把
 * `FunGen*_Stop` 加进了中止放行清单，然后把它报成了一个幽灵 ——
 * 因为调用点写的是 `safe_call(verb)`。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt
const gen = (p: Readonly<Record<string, unknown>>): string =>
  String(p['generator'] ?? '').trim().toLowerCase()

const SHAPES: Readonly<Record<string, number>> = {
  sine: 0, square: 1, triangle: 2, sawtooth: 3, ramp: 4,
}

const badGenerator = (g: string): SkillResultLike =>
  fail(`generator 必须是 '1ch' 或 '2ch'，收到 '${g}'`)

export const ConfigureWaveform: Skill = {
  spec: S.ConfigureWaveformSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const g = gen(params)
    const amp = f(params, 'amplitude')
    const freq = f(params, 'frequency_hz')
    const pol = int(params, 'polarity')
    const dir = int(params, 'direction')

    if (g === '1ch') {
      const rec = await ctx.safeCall('FunGen1Ch_PropsSet', amp, freq, pol, dir)
      if (failed(rec)) return fail(rec.error ?? '')
      return ok({ generator: '1ch', amplitude: amp, frequency_hz: freq })
    }
    if (g !== '2ch') return badGenerator(g)

    const ch = int(params, 'channel', 1) || 1
    const shape = String(params['shape'] ?? 'sine').trim().toLowerCase()
    const code = SHAPES[shape]
    if (code === undefined) {
      return fail(`shape 必须是 ${pyKeys(SHAPES)} 之一，收到 '${shape}'`)
    }

    let rec = await ctx.safeCall('FunGen2Ch_WaveformSet', ch, code)
    if (failed(rec)) return fail(`WaveformSet failed: ${rec.error ?? ''}`)

    // **双通道收的是周期，不是频率**（见文件抬头）。这一行就是那六个数量级。
    const periodS = 1.0 / freq
    const addZero = 0
    rec = await ctx.safeCall('FunGen2Ch_PropsSet', ch, amp, periodS, pol, dir, addZero)
    if (failed(rec)) return fail(`PropsSet failed: ${rec.error ?? ''}`)

    return ok({
      generator: '2ch', channel: ch, shape, amplitude: amp,
      frequency_hz: freq, period_s: periodS,
    })
  },
}

/** Python 的 `list(dict)` —— 只在那一句报错里用。 */
const pyKeys = (d: Readonly<Record<string, unknown>>): string =>
  `[${Object.keys(d).map((k) => `'${k}'`).join(', ')}]`

export const StartWaveform: Skill = {
  spec: S.StartWaveformSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const g = gen(params)
    const periods = int(params, 'periods')
    const wait = params['wait_until_finished'] === true ? 1 : 0
    if (g !== '1ch' && g !== '2ch') return badGenerator(g)
    // 动词字面量，两条分支 —— 见文件抬头。
    const rec = g === '1ch'
      ? await ctx.safeCall('FunGen1Ch_Start', periods, wait)
      : await ctx.safeCall('FunGen2Ch_Start', periods, wait)
    if (failed(rec)) return fail(rec.error ?? '')
    // `periods = 0` 是**连续输出**，不是「跑零个周期」——
    // 那是这个参数上 0 不算「没给」的原因。
    return ok({ generator: g, periods, mode: periods === 0 ? 'continuous' : 'burst' })
  },
}

export const StopWaveform: Skill = {
  spec: S.StopWaveformSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const g = gen(params)
    if (g !== '1ch' && g !== '2ch') return badGenerator(g)
    const rec = g === '1ch'
      ? await ctx.safeCall('FunGen1Ch_Stop')
      : await ctx.safeCall('FunGen2Ch_Stop')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ generator: g, stopped: true })
  },
}

export const GetWaveformStatus: Skill = {
  spec: S.GetWaveformStatusSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const g = gen(params)
    if (g !== '1ch' && g !== '2ch') return badGenerator(g)

    if (g === '1ch') {
      const st = await ctx.safeCall('FunGen1Ch_StatusGet')
      const pr = await ctx.safeCall('FunGen1Ch_PropsGet')
      const idle = await ctx.safeCall('FunGen1Ch_IdleGet')
      if (failed(st)) return fail(st.error ?? '')
      return ok({
        generator: g,
        status: [...body(st)],
        props: failed(pr) ? [] : [...body(pr)],
        extra: failed(idle) ? [] : [...body(idle)],
        // 只有双通道有这两样；单通道**明说是 `null`**，不给一个空表冒充「读到了」。
        channel_on: null,
        output_signal: null,
      })
    }

    const ch = int(params, 'channel', 1) || 1
    const st = await ctx.safeCall('FunGen2Ch_StatusGet')
    const pr = await ctx.safeCall('FunGen2Ch_PropsGet', ch)
    const idle = await ctx.safeCall('FunGen2Ch_WaveformGet', ch)
    const on = await ctx.safeCall('FunGen2Ch_OnOffGet', ch)
    const sig = await ctx.safeCall('FunGen2Ch_SignalGet', ch)
    if (failed(st)) return fail(st.error ?? '')
    return ok({
      generator: g,
      status: [...body(st)],
      props: failed(pr) ? [] : [...body(pr)],
      extra: failed(idle) ? [] : [...body(idle)],
      channel_on: failed(on) ? null : [...body(on)],
      output_signal: failed(sig) ? null : [...body(sig)],
    })
  },
}

export const SetWaveformIdleValue: Skill = {
  spec: S.SetWaveformIdleValueSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const g = gen(params)
    const val = f(params, 'idle_value')
    if (g !== '1ch' && g !== '2ch') return badGenerator(g)
    const rec = g === '1ch'
      ? await ctx.safeCall('FunGen1Ch_IdleSet', val)
      : await ctx.safeCall('FunGen2Ch_IdleSet', int(params, 'device', 1) || 1, val)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ generator: g, idle_value: val })
  },
}

export const SetWaveformChannelOnOff: Skill = {
  spec: S.SetWaveformChannelOnOffSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const ch = int(params, 'channel')
    const on = params['on'] === true ? 1 : 0
    const rec = await ctx.safeCall('FunGen2Ch_OnOffSet', ch, on)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ channel: ch, on: on !== 0 })
  },
}

export const WAVEFORM: Readonly<Record<string, Skill>> = {
  ConfigureWaveform,
  StartWaveform,
  StopWaveform,
  GetWaveformStatus,
  SetWaveformIdleValue,
  SetWaveformChannelOnOff,
}
