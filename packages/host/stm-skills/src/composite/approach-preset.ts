/**
 * 进针前切到 `approach` 参数组，结束时**放回去**。
 *
 * ## 为什么切
 *
 * 进针参数（快增益）能让进针快很多，但它们**不适合成像**——把进针组的快增益一路
 * 带进扫图，出来的每一张图都带着它。所以这是一次**临时**改动，而临时改动的定义是
 * 「有人负责放回去」。
 *
 * ## 缺陷⑫：判据是「这个状态是不是我改的」
 *
 * 放回去这件事在 `finally` 里，**中止时更要做**——与「中止不动手」（缺陷⑪）刻意
 * 相反。两者不矛盾：缺陷⑪说的是不要在中止时**发起**新动作，缺陷⑫说的是把**自己
 * 造成的**改动撤掉。一个把仪器留在自己改过的状态里就走人的流程，比没跑过更坏。
 *
 * 唯一的例外写在 {@link restoreZctrl} 里：软停时**不还设定点**。
 *
 * ## 永不抛
 *
 * 切参数组是为了让进针快一点，它失败不该把进针带走。每一条路都返回一段**留痕**，
 * 而不是一个异常。
 */
import {
  PRESET_APPROACH,
  PresetRejected,
  resolvePreset,
  valuesMatch,
  type ResolvedPreset,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import type { PresetSkillDeps } from '../l0/zctrl-presets.js'
import { processPresetStore } from '../l0/frames.js'

/** `SetZCtrlGain` 的三个数。顺序与它的入参一致。 */
const GAIN_KEYS = ['p_gain', 'time_constant_s', 'i_gain'] as const

export interface ZctrlSnapshot {
  readonly gains: Readonly<Record<string, number>>
  /** `null` = 进针组不改设定点，所以没有要放回的设定点。 */
  readonly setpointA: number | null
}

/** 留痕。进 `data`，给人看「谁改了什么、放回去没有」。 */
export type ZctrlNote = Record<string, unknown>

/** 当前 P/T/I 三个数；**读不到给 `null`**（与「读到了 0」必须分得开）。 */
async function readGains(ctx: SkillContext): Promise<Record<string, number> | null> {
  let res: SkillResultLike
  try {
    res = await ctx.runSkill('GetZCtrlGain', {})
  } catch {
    return null
  }
  if (!res.success) return null
  const data = (res.data ?? {}) as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const key of GAIN_KEYS) {
    const v = data[key]
    // **缺一个就是读不到**，不拿两个数凑一组。
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    out[key] = v
  }
  return out
}

async function readSetpoint(ctx: SkillContext): Promise<number | null> {
  let res: SkillResultLike
  try {
    res = await ctx.runSkill('GetSetpoint', {})
  } catch {
    return null
  }
  if (!res.success) return null
  const v = ((res.data ?? {}) as Record<string, unknown>)['setpoint_a']
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 用户喊停了没有。读不到就是 false（fail-open）。**永不抛**。 */
function operatorStopped(ctx: SkillContext): boolean {
  try {
    return ctx.signal.aborted === true
  } catch {
    return false
  }
}

/**
 * 进针前切到 `approach` 参数组。返回 `[回滚快照, 留痕]`。
 *
 * 快照为 `null` 表示**没有要放回去的东西**（没切：档案没配 / 读不到 / 本来就是那组值）。
 *
 * 走 `ApplyZCtrlPreset` **正门** ⇒ 一个数字都不经过这里，也不经过模型。
 */
export async function applyApproachPreset(
  ctx: SkillContext,
  deps: PresetSkillDeps = {},
  skillName = '',
): Promise<[ZctrlSnapshot | null, ZctrlNote]> {
  const note: ZctrlNote = { zctrl_preset: PRESET_APPROACH, zctrl_preset_applied: false }
  try {
    let preset: ResolvedPreset
    try {
      preset = resolvePreset(PRESET_APPROACH, {
        presets: (deps.store ?? processPresetStore).list(),
        approach: deps.approachProfile?.() ?? null,
      })
    } catch (exc) {
      // 档案没配 ⇒ **如实跳过**。这里绝不能拿一组「常见值」顶上：进针参数是用户
      // 输入的，编一个出来会以本机标定的名义跑一次真实的进针。
      const why = exc instanceof PresetRejected ? exc.message : String(exc)
      note['zctrl_preset_note'] =
        `仪器档案里没有可用的进针参数组,本次进针**沿用当前 Z 控制器增益**(即改动前的行为):${why}`
      return [null, note]
    }

    const before = await readGains(ctx)
    if (before === null) {
      note['zctrl_preset_note'] =
        '读不到当前 Z 控制器增益 —— **不切换**,进针沿用当前增益。' +
        '(能不能把它放回去,取决于切换前读到了什么;读不到就切,等于拿一个' +
        '没人会知道来历的永久改动换一点速度。)'
      return [null, note]
    }
    note['zctrl_before'] = { ...before }

    const want = preset.gainParams() as unknown as Record<string, number>
    let same = GAIN_KEYS.every((k) => valuesMatch(want[k], before[k]).ok)

    let spBefore: number | null = null
    const wantSp = preset.setpointA
    if (wantSp !== null) {
      spBefore = await readSetpoint(ctx)
      if (spBefore === null) {
        note['zctrl_preset_note'] =
          '进针参数组要改设定点,但读不到当前设定点 —— **不切换**(放不回去就不该改)。'
        return [null, note]
      }
      same = same && valuesMatch(wantSp, spBefore).ok
    }

    if (same) {
      // 用户可能刚人肉切过，或者这是嵌套调用（ApproachTip → AutoApproach）。
      // **不写 = 不用放回去**，嵌套因此是免费的。
      note['zctrl_preset_applied'] = null
      note['zctrl_preset_note'] = '当前已经是进针参数组的值,未改动。'
      return [null, note]
    }

    const res = await ctx.runSkill('ApplyZCtrlPreset', { preset: PRESET_APPROACH })
    const ok = res.success === true
    note['zctrl_preset_applied'] = ok
    note['zctrl_preset_trace'] = ((res.data ?? {}) as Record<string, unknown>)['trace']
    note['zctrl_preset_note'] = ok
      ? `${skillName} 开跑前已切到进针参数组(值来自仪器档案,不经模型);结束时会放回调用前的增益。`
      : `切进针参数组失败:${res.error ?? 'unknown'};` +
        '进针继续,但用的是切换失败后的增益 —— 结束时仍会尝试放回原值。'
    // **失败也返回快照**：`ApplyZCtrlPreset` 可能已经写进了增益、随后在设定点上失败。
    // 「调用失败」不等于「什么都没改」。
    return [{ gains: before, setpointA: spBefore }, note]
  } catch (exc) {
    note['zctrl_preset_note'] =
      `切进针参数组时出错:${exc instanceof Error ? exc.message : String(exc)};进针沿用当前增益。`
    return [null, note]
  }
}

/**
 * 把 Z 控制器放回 `snapshot` 记下的值。没有快照就什么都不做。**永不抛**。
 *
 * `SetZCtrlGain` / `SetSetpoint` 自己会写后回读比对，所以它们的 `success` 已经是
 * 「硬件确实收下了」而不是「命令发出去了」。
 */
export async function restoreZctrl(
  ctx: SkillContext,
  snapshot: ZctrlSnapshot | null,
  skillName = '',
): Promise<ZctrlNote> {
  if (snapshot === null) return {}
  const note: ZctrlNote = {}
  let ok = true
  try {
    if (snapshot.gains !== undefined) {
      const res = await ctx.runSkill('SetZCtrlGain', { ...snapshot.gains })
      ok = res.success === true
      note['zctrl_restored_gains'] = { ...snapshot.gains }
      if (!ok) note['zctrl_restore_error'] = res.error ?? 'unknown'
    }
    let sp = snapshot.setpointA
    if (sp !== null && operatorStopped(ctx)) {
      // 软停时**不还设定点**（缺陷⑬ 要求四：软停只停不动）。
      //
      // 增益和设定点在这里不是一回事：改增益只是改反馈环的响应，**不命令任何位移**；
      // 而改设定点会让 Z 环把针尖挪到新的电流目标上 —— 那是一次运动。一个刚被叫停
      // 的流程不该以「归还」的名义再动一次针。
      //
      // 于是软停后现场是：增益=调用前，设定点=进针组的值。**这个组合要说出来**，
      // 别让人以为一切都回去了。
      note['zctrl_setpoint_left_at_approach'] = true
      note['zctrl_setpoint_note'] =
        `用户叫停 —— **没有还原设定点**(还原会让针尖移动,而软停只停不动)。` +
        `当前设定点仍是进针组的值;调用前是 ${sp}。要还原请显式 SetSetpoint。`
      sp = null
    }
    if (sp !== null) {
      const resSp = await ctx.runSkill('SetSetpoint', { setpoint_a: sp })
      if (resSp.success !== true) {
        ok = false
        note['zctrl_restore_error'] = resSp.error ?? 'unknown'
      }
      note['zctrl_restored_setpoint_a'] = sp
    }
  } catch (exc) {
    note['zctrl_restored'] = null
    note['zctrl_restore_note'] =
      `放回调用前的 Z 控制器参数时出错:${exc instanceof Error ? exc.message : String(exc)} —— ` +
      '**增益可能仍停在进针组**,请核对后再扫图(进针组的快增益会一路带进成像)。'
    return note
  }
  note['zctrl_restored'] = ok
  note['zctrl_restore_note'] = ok
    ? `${skillName} 结束,Z 控制器已放回调用前的值。`
    : '放回调用前的 Z 控制器参数**失败** —— 增益可能仍停在进针组,' +
      '请核对后再扫图(进针组的快增益会一路带进成像)。'
  return note
}
