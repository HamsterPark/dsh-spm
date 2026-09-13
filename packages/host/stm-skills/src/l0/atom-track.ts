/**
 * Atom Tracking —— 让针尖**锁住一个原子**，然后拿这个锁去量漂移。
 *
 * 四个技能：配参数并开关、把测得的漂移灌进漂移补偿、启动倾斜/漂移补偿、读一项状态。
 *
 * ## 两条判据，各自对着一次「静默地成功」
 *
 * **① 使能失败必须失败。** `AtomTrack_CtrlSet` 的 `returns` 是空表，于是只有
 * `error` 有意义——旧仓那一版把它咽了下去（技能照报 `success=true`），
 * 调用方于是相信调制与控制器已经开着，而它们没有。
 *
 * **② 状态位在 body 的第 0 位，不是信封的第 0 位。** `AtomTrack_StatusGet` 的
 * `returns=["H"]`，读 `parsed[0]`（那是信封里的**空错误串**）会让真机上**每一项**
 * 控制都报 Off——一个永远说「没开」的读，而它从来没看过硬件。这是 D-SKILL-1 那一族。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, int, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt

/** `AtomTrack_CtrlSet` 的第一个实参：0=调制、1=控制器、2=漂移测量。 */
const CTRL_MODULATION = 0
const CTRL_CONTROLLER = 1

/** 读回来的那一项叫什么。索引认不出就原样把数字印出来。 */
const CTRL_NAMES: Readonly<Record<number, string>> = {
  0: 'Modulation',
  1: 'Controller',
  2: 'Drift Measurement',
}

export const ConfigureAtomTrack: Skill = {
  spec: S.ConfigureAtomTrackSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // AtomTrack_PropsSet(I_gain, Freq_Hz, Amp_m, Phase_deg, Switch_off_delay_s)
    const recProps = await ctx.safeCall(
      'AtomTrack_PropsSet',
      n(params, 'integral_gain'),
      n(params, 'frequency_hz'),
      n(params, 'amplitude_m'),
      n(params, 'phase_deg', 0.0),
      n(params, 'switch_off_delay_s', 0.5),
    )
    if (failed(recProps)) return fail(recProps.error ?? '')

    const modulationEnabled = params['enable_modulation'] !== false
    const controllerEnabled = params['enable_controller'] !== false
    if (modulationEnabled) {
      const rec = await ctx.safeCall('AtomTrack_CtrlSet', CTRL_MODULATION, 1)
      // **咽下去的失败会让调用方相信调制已经开着。**
      if (failed(rec)) return fail(`enable modulation failed: ${rec.error ?? ''}`)
    }
    if (controllerEnabled) {
      const rec = await ctx.safeCall('AtomTrack_CtrlSet', CTRL_CONTROLLER, 1)
      if (failed(rec)) return fail(`enable controller failed: ${rec.error ?? ''}`)
    }

    return ok({
      integral_gain: n(params, 'integral_gain'),
      frequency_hz: n(params, 'frequency_hz'),
      amplitude_m: n(params, 'amplitude_m'),
      modulation_enabled: modulationEnabled,
      controller_enabled: controllerEnabled,
    })
  },
}

export const AtomTrackDriftComp: Skill = {
  spec: S.AtomTrackDriftCompSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('AtomTrack_DriftComp')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ drift_compensation_applied: true })
  },
}

export const AtomTrackQuickCompStart: Skill = {
  spec: S.AtomTrackQuickCompStartSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const compType = n(params, 'compensation_type')
    const rec = await ctx.safeCall('AtomTrack_QuickCompStart', compType)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ compensation_type: compType === 0 ? 'Tilt' : 'Drift', started: true })
  },
}

export const AtomTrackStatusGet: Skill = {
  spec: S.AtomTrackStatusGetSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const control = n(params, 'control')
    const rec = await ctx.safeCall('AtomTrack_StatusGet', control)
    if (failed(rec)) return fail(rec.error ?? '')
    // body 的第 0 位（`returns=["H"]`）。取不出 ⇒ `false`：这一格是「开/关」，
    // 旧仓在这里读的是信封第 0 位，于是每一项都报 Off。
    return ok({
      control: CTRL_NAMES[control] ?? String(control),
      status: (int(rec, 0) ?? 0) !== 0,
    })
  },
}

export const ATOM_TRACK: Readonly<Record<string, Skill>> = {
  ConfigureAtomTrack,
  AtomTrackDriftComp,
  AtomTrackQuickCompStart,
  AtomTrackStatusGet,
}
