/**
 * qPlus 振荡振幅 —— 一个**与电流无关**的撞针证人。
 *
 * 判据全在内核的 `qplus-amplitude.ts` 里（振幅通道怎么认、四态怎么判、
 * 缺陷⑰ 的两条证据）。这个文件只负责**去问**，以及把「问不到」如实说出来。
 *
 * ## 基线住在进程里，落盘由宿主接
 *
 * 自由振荡基线是**跨调用活着**的东西：早上取的基线，下午还得算数。与
 * `processPresetStore` / `processLockInProfile` 同一条（D-PRESET-2）。
 *
 * ⚠️ 旧仓在这里踩过一个坑值得抄下来：档案的 `sanitize()` 会**静默丢掉未登记的
 * 键**，所以基线那两个键必须在 `_CONFIG_SPEC` 里注册过 —— 否则写得干干净净、
 * 读回来永远是 `None`，这个撞针探测器就**永久停在 `no_baseline`**。
 * 本仓这一份是显式的对象，没有那层过滤，但**「写进去了」与「读得回来」
 * 是两句话**这条不变。
 */
import {
  CRASH_FRACTION,
  amplitudeVerdict,
  excitationDriving,
  findAmplitudeChannel,
  rememberedIndex,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { scalarFloat } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/**
 * 进程内的 qPlus 基线。`null` = 还没取过。
 *
 * `signalIndex` 顺带记下来：取基线时认出的那条通道，下次不必再扫整张信号表，
 * 而且给了操作员一个**覆盖名字匹配**的入口（他那台机器的通道名可能不在关键词里）。
 */
export const processQPlusBaseline: {
  amplitude: number | null
  signalIndex: number | null
  persist?: (v: { amplitude: number | null; signalIndex: number | null }) => void
} = { amplitude: null, signalIndex: null }

/** 信号表里的通道名。取不出给空表。 */
function signalNames(rec: SkillCallRecord): string[] {
  const out: string[] = []
  for (const el of body(rec)) {
    if (typeof el === 'string') out.push(el)
    else if (Array.isArray(el)) for (const x of el) if (typeof x === 'string') out.push(x)
  }
  return out
}

/** 回包里第一个数。取不出给 `null`（D-SKILL-1）。 */
function firstNumber(rec: SkillCallRecord): number | null {
  for (const el of body(rec)) {
    const v = scalarFloat(el)
    if (v !== null) return v
  }
  return null
}

const NO_CHANNEL_NOTE =
  '信号表里没有振荡振幅通道 —— 这台机器很可能没有 qPlus 传感器。这不是故障，只是这条判据用不上。'

/** 认出振幅通道。先看记住的那个下标，再扫信号表。**读不到 ⇒ `null`**。 */
async function locateAmplitude(
  ctx: SkillContext,
  signalIndexParam: number,
): Promise<{ index: number; name: string } | null> {
  if (signalIndexParam >= 0) return { index: signalIndexParam, name: '' }
  const remembered = rememberedIndex(processQPlusBaseline.signalIndex)
  if (remembered !== null) return { index: remembered, name: '' }
  const rec = await ctx.safeCall('Signals_NamesGet')
  if (failed(rec)) return null
  return findAmplitudeChannel(signalNames(rec))
}

export const ReadTipOscillationAmplitude: Skill = {
  spec: S.ReadTipOscillationAmplitudeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const asked = typeof params['signal_index'] === 'number'
      ? Math.trunc(params['signal_index'])
      : -1
    const found = await locateAmplitude(ctx, asked)
    if (found === null) {
      // **没有这条通道不是故障**，是「这条判据用不上」。一台 STM-only 的机器
      // 不该因为它看起来像坏了。
      return ok({ status: 'unavailable', amplitude: null, note: NO_CHANNEL_NOTE })
    }

    const rec = await ctx.safeCall('Signals_ValGet', found.index, 1)
    if (failed(rec)) {
      return fail(`读取振幅失败（signal ${found.index}）：${rec.error ?? ''}`)
    }
    const amp = firstNumber(rec)
    if (amp === null) return fail(`振幅读数无法解析（signal ${found.index}）`)

    const data: Record<string, unknown> = {
      status: 'ok',
      amplitude: amp,
      signal_index: found.index,
      signal_name: found.name,
    }
    if (params['set_baseline'] === true) {
      processQPlusBaseline.amplitude = amp
      processQPlusBaseline.signalIndex = found.index
      // 落盘失败**只记不抛**：内存里已经是新的了，把一次成功的取样变成失败更坏。
      try {
        processQPlusBaseline.persist?.({ amplitude: amp, signalIndex: found.index })
      } catch {
        /* 持久化不该弄坏一次读取 */
      }
      data['baseline_set'] = true
    }
    return ok(data)
  },
}

/**
 * 撞针判据。**四态，而后两态都不是「没事」。**
 *
 * 缺陷⑰：先问激励在不在驱动音叉 —— 不知道的时候，振幅这个数不代表任何东西。
 */
export const CheckTipCrashByAmplitude: Skill = {
  spec: S.CheckTipCrashByAmplitudeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const recOn = await ctx.safeCall('PLL_OutOnOffGet', 1)
    const on = failed(recOn) ? null : firstNumber(recOn) !== null
      ? firstNumber(recOn) !== 0
      : null
    const recV = await ctx.safeCall('PLL_ExcitationGet', 1)
    const excV = failed(recV) ? null : firstNumber(recV)

    const driving = excitationDriving(on, excV)
    if (driving !== true) {
      const note = driving === null
        ? '读不到 PLL 激励状态 —— **判不了**是否撞针。' +
          '音叉有没有被驱动不知道的时候,振幅读数不代表任何东西。'
        : `PLL 激励关闭(输出 ${on === true ? '开' : '关'},` +
          `激励 ${excV ?? 0} V)—— **振幅通道无判据能力**:` +
          '音叉没被驱动,读到的是未驱动解调器的噪声底,' +
          '拿它跟自由振荡基线比永远比出「塌了」。这不是撞针提示。'
      return ok({
        status: 'unavailable',
        crash_indicator: null,
        excitation_on: driving === null ? null : on,
        note,
      })
    }

    const read = await ReadTipOscillationAmplitude.execute(ctx, {
      signal_index: params['signal_index'] ?? -1,
    })
    // **一次失败的读不是一个判决。** 如实报成「判不了」。
    if (!read.success) {
      return ok({
        status: 'unavailable',
        crash_indicator: null,
        note: `振幅读取失败，无法判断：${read.error ?? ''}`,
      })
    }
    if (read.data?.['status'] !== 'ok') {
      return ok({
        status: 'unavailable',
        crash_indicator: null,
        note: read.data?.['note'] ?? '没有可用的振幅通道',
      })
    }

    const amp = read.data['amplitude'] as number
    const verdict = amplitudeVerdict(amp, processQPlusBaseline.amplitude)
    if (verdict.status === 'no_baseline') {
      return ok({
        status: 'no_baseline',
        crash_indicator: null,
        amplitude: amp,
        note:
          '没有自由振荡基线，无法判断振幅是否塌了。' +
          '请在针尖确认未接触时先调用 ReadTipOscillationAmplitude(set_baseline=True)。',
      })
    }

    const base = processQPlusBaseline.amplitude as number
    const frac = verdict.fraction as number
    const crashed = verdict.status === 'crash'
    return ok({
      status: verdict.status,
      crash_indicator: crashed,
      amplitude: amp,
      baseline: base,
      fraction_of_baseline: Math.round(frac * 1e4) / 1e4,
      threshold_fraction: CRASH_FRACTION,
      note: crashed
        ? `振幅 ${amp} 只有自由振荡基线 ${base} 的 ` +
          `${(frac * 100).toFixed(1)}%（阈值 ${(CRASH_FRACTION * 100).toFixed(0)}%）—— ` +
          '针尖很可能已接触表面。退针后振幅应恢复；' +
          '若退针后仍不恢复，则不是撞针而是振荡回路本身的问题。'
        : `振幅为基线的 ${(frac * 100).toFixed(1)}%，针尖仍在自由振荡。` +
          '（这不排除电流类判据发现的问题。）',
    })
  },
}

export const QPLUS: Readonly<Record<string, Skill>> = {
  ReadTipOscillationAmplitude,
  CheckTipCrashByAmplitude,
}
