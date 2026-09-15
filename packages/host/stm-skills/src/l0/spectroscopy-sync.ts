/**
 * 谱学与外部世界的同步 —— TTL 线、脉冲序列、备用 Z 设定点、第二退回条件。
 *
 * 这一族让一次谱学测量与**外面那台机器**对上拍：每取一个点闪一次 TTL（触发相机、
 * 斩波器、延时线），或者让一个脉冲序列跟着走。偏压谱与 Z 谱各有一套同名的命令，
 * 由 `which` 选。
 *
 * ## 动词写成字面量
 *
 * 两条分支（`BiasSpectr_*` / `ZSpectr_*`）多花三行，换的是安全工具看得见它们：
 * 中止后放行清单的核对、安全审计、API 覆盖清点，全都靠 grep `safeCall('…')`。
 * 一个藏在变量后面的动词对它们全都不可见。
 *
 * ## `_firstInt` 只认整数，不认浮点
 *
 * 「谱学在不在跑」这个状态位是整数 `1`。一个浮点回来**不是**「跑着」也不是
 * 「没跑」，是**没问出来** —— 于是 `null`。把浮点也收下会让一个读不懂的回包
 * 变成一句确定的「没在跑」。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { cell, fail, ok, pyExp } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt
const given = (p: Readonly<Record<string, unknown>>, k: string): boolean =>
  p[k] !== undefined && p[k] !== null

const POLARITY: Readonly<Record<string, number>> = { low_active: 0, high_active: 1 }
/** 谱学模块「正在跑」的状态码。 */
const RUNNING = 1

/**
 * 回包里第一个**整数**（广度优先，布尔算整数）。
 *
 * **浮点不算。** 见文件抬头：一个浮点回来是「没问出来」，不是一个状态。
 */
export function firstInt(v: unknown): number | null {
  const stack: unknown[] = [v]
  let seen = 0
  while (stack.length > 0 && seen < 64) {
    seen += 1
    const x = stack.shift()
    if (Array.isArray(x)) {
      stack.unshift(...x)
      continue
    }
    if (typeof x === 'boolean') return x ? 1 : 0
    if (typeof x === 'number' && Number.isInteger(x)) return x
  }
  return null
}

export const SetSpectroscopyTtlSync: Skill = {
  spec: S.SetSpectroscopyTtlSyncSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const which = String(params['which'] ?? '')
    const line = int(params, 'line')
    const pol = POLARITY[String(params['polarity'] ?? 'high_active')] ?? POLARITY['high_active'] as number
    const tOn = f(params, 'time_to_on_s')
    const dur = f(params, 'on_duration_s', 1e-3) || 1e-3

    // 动词字面量，两条分支 —— 见文件抬头。
    const rec = which === 'bias'
      ? await ctx.safeCall('BiasSpectr_TTLSyncSet', line, pol, tOn, dur)
      : await ctx.safeCall('ZSpectr_TTLSyncSet', line, pol, tOn, dur)
    const back = which === 'bias'
      ? await ctx.safeCall('BiasSpectr_TTLSyncGet')
      : await ctx.safeCall('ZSpectr_TTLSyncGet')
    if (failed(rec)) return fail(`TTL sync set failed (${which}): ${rec.error ?? ''}`)

    // `line = 0` 是**关掉同步**，所以那句话也换一种说法。
    return ok(
      {
        which,
        line,
        polarity: params['polarity'] ?? null,
        time_to_on_s: tOn,
        on_duration_s: dur,
        readback: cell(back),
      },
      `${which} 谱学 TTL 同步已${line === 0 ? '关闭' : '设置'}` +
        (line === 0 ? '' : `：线 ${line}，延迟 ${g(tOn)} s，持续 ${g(dur)} s`),
    )
  },
}

/** Python 的 `{x:g}`。 */
const g = (v: number): string => {
  const s = v.toPrecision(6)
  return String(Number(s))
}

export const SetSpectroscopyPulseSync: Skill = {
  spec: S.SetSpectroscopyPulseSyncSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const which = String(params['which'] ?? '')
    const touched: string[] = []

    // **给了才写**（`!= null`，不是 `in`）：模型那条路上两个可选字段都会以
    // `null` 到达，用 `in` 判的话每次都会往硬件发一个 null。
    if (given(params, 'digital_sync')) {
      const v = int(params, 'digital_sync')
      const rec = which === 'bias'
        ? await ctx.safeCall('BiasSpectr_DigSyncSet', v)
        : await ctx.safeCall('ZSpectr_DigSyncSet', v)
      if (failed(rec)) return fail(`digital sync set failed: ${rec.error ?? ''}`)
      touched.push(`digital_sync=${v}`)
    }

    if (given(params, 'pulse_sequence_nr')) {
      const seq = int(params, 'pulse_sequence_nr')
      const periods = int(params, 'pulse_periods', 1) || 1
      const rec = which === 'bias'
        ? await ctx.safeCall('BiasSpectr_PulseSeqSyncSet', seq, periods)
        : await ctx.safeCall('ZSpectr_PulseSeqSyncSet', seq, periods)
      if (failed(rec)) return fail(`pulse-sequence sync set failed: ${rec.error ?? ''}`)
      touched.push(`pulse_seq=${seq}×${periods}`)
    }

    // 一个都没给 ⇒ 拒。一次什么都没做的调用不该报成功。
    if (touched.length === 0) return fail('digital_sync / pulse_sequence_nr 至少要给一个')

    return ok(
      { which, changed: touched },
      `${which} 谱学同步已设置：${touched.join(', ')}`,
    )
  },
}

export const SetSpectroscopyZControl: Skill = {
  spec: S.SetSpectroscopyZControlSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const use = params['use_alternate_setpoint'] === true
    const setpoint = f(params, 'setpoint')
    const settling = f(params, 'settling_time_s', 0.1) || 0.1
    const revert = params['revert_z_offset'] !== false

    let rec = await ctx.safeCall('BiasSpectr_AltZCtrlSet', use ? 1 : 0, setpoint, settling)
    if (failed(rec)) return fail(`BiasSpectr_AltZCtrlSet failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('BiasSpectr_ZOffRevertSet', revert ? 1 : 0)
    if (failed(rec)) return fail(`BiasSpectr_ZOffRevertSet failed: ${rec.error ?? ''}`)

    const back = await ctx.safeCall('BiasSpectr_AltZCtrlGet')

    return ok(
      {
        use_alternate_setpoint: use,
        setpoint,
        revert_z_offset: revert,
        readback: cell(back),
      },
      `谱学 Z 控制已设置：备用设定点${use ? `启用 = ${pyExp(setpoint, 3)} A` : '关闭'}`,
    )
  },
}

export const SetZSpectroscopySecondRetract: Skill = {
  spec: S.SetZSpectroscopySecondRetractSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const enable = params['enable'] === true
    const threshold = f(params, 'threshold')
    const signalIndex = int(params, 'signal_index')
    const comparison = int(params, 'comparison')
    // ZSpectr_RetractSecondSet(第二条件, 阈值, 信号序号, 比较方式)
    const rec = await ctx.safeCall(
      'ZSpectr_RetractSecondSet', enable ? 1 : 0, threshold, signalIndex, comparison,
    )
    if (failed(rec)) return fail(`ZSpectr_RetractSecondSet failed: ${rec.error ?? ''}`)
    const back = await ctx.safeCall('ZSpectr_RetractSecondGet')
    return ok(
      { enabled: enable, signal_index: signalIndex, threshold, readback: cell(back) },
      `Z 谱学第二退回条件已${enable ? '启用' : '关闭'}`,
    )
  },
}

export const SetMlsLockinPerSegment: Skill = {
  spec: S.SetMlsLockinPerSegmentSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const enable = params['enable'] === true
    const rec = await ctx.safeCall('BiasSpectr_MLSLockinPerSegSet', enable ? 1 : 0)
    if (failed(rec)) {
      return fail(`BiasSpectr_MLSLockinPerSegSet failed: ${rec.error ?? ''}`)
    }
    return ok({ enabled: enable }, `MLS 分段锁相已${enable ? '启用' : '关闭'}`)
  },
}

/**
 * 两路谱学在不在跑。**技能永远 `success`** —— 它报的是「问到了什么」，
 * 而读不到的那一路是 `null`，不是 `false`。
 */
export const GetSpectroscopyStatus: Skill = {
  spec: S.GetSpectroscopyStatusSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const which = String(params['which'] ?? '') || 'both'
    const data: Record<string, unknown> = { which }

    if (which === 'bias' || which === 'both') {
      const rec = await ctx.safeCall('BiasSpectr_StatusGet')
      const v = failed(rec) ? null : firstInt(cell(rec))
      data['bias_running'] = v === null ? null : v === RUNNING
    }
    if (which === 'z' || which === 'both') {
      const rec = await ctx.safeCall('ZSpectr_StatusGet')
      const v = failed(rec) ? null : firstInt(cell(rec))
      data['z_running'] = v === null ? null : v === RUNNING
    }
    const running = (['bias_running', 'z_running'] as const).filter((k) => data[k] === true)
    return ok(
      data,
      running.length > 0 ? `谱学运行中：${running.join(', ')}` : '谱学未在运行',
    )
  },
}

export const SPECTROSCOPY_SYNC: Readonly<Record<string, Skill>> = {
  SetSpectroscopyTtlSync,
  SetSpectroscopyPulseSync,
  SetSpectroscopyZControl,
  SetZSpectroscopySecondRetract,
  SetMlsLockinPerSegment,
  GetSpectroscopyStatus,
}
