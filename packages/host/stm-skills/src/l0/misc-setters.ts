/**
 * 写这一侧最后八个洞 —— **读得到、却设不了的那些设置**。
 *
 * 2026-07-13 的清点发现仪器接触面在**两个方向上都不对称**。37 个设置写得进、
 * 读不回来（那一半修在 `writes-verified.ts`：每个要紧的写技能现在都回读核对）。
 * 这八个是另一半：本仓**读得到**它们，却没有办法**改**它们 ——
 * 于是智能体看得见一处配错，而拿它没办法。
 *
 * 单个都小。合起来是「一个能观察仪器的智能体」与「一个能操作仪器的智能体」之差。
 *
 * ## 三个带回读的，五个不带
 *
 * 带回读的那三个（波形信号 / 图案实验 / point-and-shoot）改的是**后面每一次动作
 * 的含义**：同样一个 1 V 正弦波，接在空闲输出上是无害的测试信号，接在隧道结上
 * 就是 1 V 的偏压调制 —— **发生器分不出这两者的区别**。所以它们写完再读一眼，
 * 把读到的原样交出去（`readback`，读不到就是 `null`）。
 *
 * 另外五个是单值寄存器，写进去就是写进去了，再读一遍只多一趟往返。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/** 一个整数入参。**给了就用，`0` 也算给了**（D-ZERO-1）。 */
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt
const flt = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const str = (p: Readonly<Record<string, unknown>>, k: string, dflt: string): string =>
  typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : dflt

/**
 * `decode_reply` 的等价物：body 只有一个元素就解一层，否则原样给出。
 *
 * D-SKILL-1：旧仓这一族的 `_rv` 有六份拷贝，只有 `readback.py` 那份做对了；
 * 另外五份把三段信封整个交出去，一直留到 2026-08-13 的真机只读全扫才被量出来。
 * 我们这一侧 `values` 就是 body，信封在线协议层已经没了。
 */
function cell(rec: SkillCallRecord): unknown {
  const b = body(rec)
  return b.length === 1 ? b[0] : [...b]
}

// ── 三个带回读的 ───────────────────────────────────────────────────────────

export const SetWaveformSignal: Skill = {
  spec: S.SetWaveformSignalSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const ch = int(params, 'channel')
    const sig = int(params, 'signal_index')
    const rec = await ctx.safeCall('FunGen2Ch_SignalSet', ch, sig)
    if (failed(rec)) return fail(`FunGen2Ch_SignalSet failed: ${rec.error ?? ''}`)
    const back = await ctx.safeCall('FunGen2Ch_SignalGet', ch)
    return ok(
      { channel: ch, signal_index: sig, readback: failed(back) ? null : cell(back) },
      `函数发生器通道 ${ch} 现在驱动信号 ${sig}`,
    )
  },
}

export const SetPatternExperiment: Skill = {
  spec: S.SetPatternExperimentSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const exp = int(params, 'experiment')
    // Pattern_PropsSet(Selected_experiment, Basename, External_VI_path,
    //                  Pre_measure_delay_s, Save_scan_channels)
    const rec = await ctx.safeCall(
      'Pattern_PropsSet',
      exp,
      str(params, 'basename', 'mast_pattern'),
      typeof params['external_vi_path'] === 'string' ? params['external_vi_path'] : '',
      flt(params, 'pre_measure_delay_s', 0.1),
      params['save_scan_channels'] === true ? 1 : 0,
    )
    if (failed(rec)) return fail(`Pattern_PropsSet failed: ${rec.error ?? ''}`)
    const back = await ctx.safeCall('Pattern_PropsGet')
    return ok(
      { experiment: exp, readback: failed(back) ? null : cell(back) },
      `图案实验 = ${exp}`,
    )
  },
}

export const SetPointShootProps: Skill = {
  spec: S.SetPointShootPropsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const autoResume = params['auto_resume'] === true
    // FolMe_PSPropsSet(Auto_resume, Use_own_basename, Basename,
    //                  External_VI_path, Pre_measure_delay_s)
    const rec = await ctx.safeCall(
      'FolMe_PSPropsSet',
      autoResume ? 1 : 0,
      params['use_own_basename'] !== false ? 1 : 0,
      str(params, 'basename', 'mast_ps'),
      typeof params['external_vi_path'] === 'string' ? params['external_vi_path'] : '',
      flt(params, 'pre_measure_delay_s', 0.1),
    )
    if (failed(rec)) return fail(`FolMe_PSPropsSet failed: ${rec.error ?? ''}`)
    const back = await ctx.safeCall('FolMe_PSPropsGet')
    return ok(
      { auto_resume: autoResume, readback: failed(back) ? null : cell(back) },
      `point-and-shoot 已配置（扫描${autoResume ? '自动续跑' : '不自动续跑'}）`,
    )
  },
}

// ── 五个单值寄存器 ─────────────────────────────────────────────────────────

export const SetLockInDemodPhaseRegister: Skill = {
  spec: S.SetLockInDemodPhaseRegisterSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const d = int(params, 'demodulator')
    const reg = int(params, 'phase_register')
    const rec = await ctx.safeCall('LockIn_DemodPhasRegSet', d, reg)
    if (failed(rec)) return fail(`LockIn_DemodPhasRegSet failed: ${rec.error ?? ''}`)
    return ok({ demodulator: d, phase_register: reg }, `解调器 ${d} 的相位寄存器 = ${reg}`)
  },
}

export const SetLockInFrequencySweepSignal: Skill = {
  spec: S.SetLockInFrequencySweepSignalSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const sig = int(params, 'signal_index')
    const rec = await ctx.safeCall('LockInFreqSwp_SignalSet', sig)
    if (failed(rec)) return fail(`LockInFreqSwp_SignalSet failed: ${rec.error ?? ''}`)
    return ok({ signal_index: sig }, `锁相频率扫描的信号 = ${sig}`)
  },
}

export const SetPllExcitationAdd: Skill = {
  spec: S.SetPllExcitationAddSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const m = int(params, 'modulator')
    const add = params['add'] === true
    const rec = await ctx.safeCall('PLL_AddOnOffSet', m, add ? 1 : 0)
    if (failed(rec)) return fail(`PLL_AddOnOffSet failed: ${rec.error ?? ''}`)
    return ok(
      { modulator: m, add },
      `PLL 调制器 ${m} 的激励${add ? '已接入输出' : '已断开'}`,
    )
  },
}

export const SetPllDemodHarmonic: Skill = {
  spec: S.SetPllDemodHarmonicSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const d = int(params, 'demodulator')
    const h = int(params, 'harmonic')
    const rec = await ctx.safeCall('PLL_DemodHarmonicSet', d, h)
    if (failed(rec)) return fail(`PLL_DemodHarmonicSet failed: ${rec.error ?? ''}`)
    return ok({ demodulator: d, harmonic: h }, `PLL 解调器 ${d} 锁定 ${h} 次谐波`)
  },
}

/**
 * 示波器触发。
 *
 * ⚠️ 旧仓这里写的是 `int(params.get(k, 1) or 1)` —— **`trigger_mode = 0`
 * 与 `trigger_slope = 0` 因此一次也下发不出去**（D-ZERO-1，本仓第三次撞上）。
 * 两者的 `0` 都是声明里写着的合法值（关触发 / 下降沿）。
 */
export const ConfigureScopeTrigger: Skill = {
  spec: S.ConfigureScopeTriggerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const mode = int(params, 'trigger_mode', 1)
    const level = flt(params, 'trigger_level', 0.0)
    // Osci1T_TrigSet(TriggerMode, TriggerSlope, TriggerLevel, TriggerHysteresis)
    const rec = await ctx.safeCall(
      'Osci1T_TrigSet',
      mode,
      int(params, 'trigger_slope', 1),
      level,
      flt(params, 'trigger_hysteresis', 0.0),
    )
    if (failed(rec)) return fail(`Osci1T_TrigSet failed: ${rec.error ?? ''}`)
    return ok({ trigger_mode: mode, trigger_level: level }, '示波器触发已配置')
  },
}

export const MISC_SETTERS: Readonly<Record<string, Skill>> = {
  SetWaveformSignal,
  SetLockInDemodPhaseRegister,
  SetLockInFrequencySweepSignal,
  SetPllExcitationAdd,
  SetPllDemodHarmonic,
  ConfigureScopeTrigger,
  SetPatternExperiment,
  SetPointShootProps,
}
