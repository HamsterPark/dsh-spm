/**
 * Generic Sweeper 与 Lock-In 扫频 —— 以及旧仓在这上面栽过的四次。
 *
 * `GenSwp_*` 把一路信号在两个限值之间 ramp，沿途记录采集通道；
 * `LockInFreqSwp_*` 做的是频率扫描（找共振）。两者的 `Start` 回包结构**完全一样**
 * （`["i","i","*+c","i","i","2f"]`），所以解析共用一份。
 *
 * ## 四次，每一次都只有真机能照出来
 *
 * **① 采集通道从来没被设上。** 旧仓取 `return_value[-1]` ——那是整个 Variables 表
 * `[size, count, names]`——然后在**它**里面找 `"Current (A)"`，永远找不到。
 * 于是那一整段是死代码，而调用方以为自己记下了电流（2026-07-03 复盘）。
 *
 * **② `PropsSet` 的参数没有「不改」这个哨兵。** 于是 `AcquireBiasSweep` 里那次
 * `PropsSet(0, 1e6, 0, 0, 1, 2, 0)` 把 `ConfigureBiasSweep` 刚设好的 100/10 ms
 * 安定时间**清成 0**，并且每次采集都把压摆率开到 1e6。所以取数那一支
 * **根本不调 `PropsSet`** —— 时序归配置，取数只管起跑。
 *
 * **③ 扫描期间必须断开 Z 反馈。** `GenSwp_Start` 的 `Z-Ctrl=1` 才是定高扫描；
 * 不给的话反馈一直开着，而**扫到 0 V 附近时它会把针尖压进表面**。
 * 同一次还要 `Reset_signal=1`：否则偏压被留在扫描终点上，而不是回到扫描前的值。
 *
 * **④ 取到的「曲线」其实是两个表头整数。** 旧仓取 `parsed[2][0]` / `[1]` ——
 * 那是 names_size 与 num_channels，不是轨迹。真正的二维数据在 `Variables[5]`。
 *
 * ## 还有一条形状上的：**兜底值必须等于声明的缺省值**
 *
 * `execute()` 里的 `params.get(k, <兜底>)` 与 `ParameterSpec` 的 `default` 曾经
 * 各写各的（20.0 vs 4.0、3 vs 1）。组合路径上参数**不经过注册表回填**，于是省略
 * 一个参数时拿到的是 `execute` 里那个数，而模型/界面看到的是声明里那个数 ——
 * **广告与实际是两个积分时间**（review 2026-05-30 #138）。
 * 本仓把兜底写成与声明同一个值，并让一条变异盯着它。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { channelIdsFromBuffer, scalarInt } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok, pyStr } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/** `decode_reply`：body 只有一个元素就解一层，否则原样。 */
function cell(rec: SkillCallRecord): unknown {
  const b = body(rec)
  return b.length === 1 ? b[0] : [...b]
}
const at = (rec: SkillCallRecord, i: number): number | null => {
  const v = body(rec)[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * `*_Swp.Start` 回包里的二维扫描数据，逐行。
 *
 * Variables 是 `[names_size, num_channels, channel_names, rows, cols, data_2d]`,
 * **第一行是被扫的那路信号**，之后每一行是一路记录通道。
 * 取不到可解的数组就给 `null` —— 一份「有 acquisition_complete 但没有曲线」的返回
 * 仍然说得出实话，而一个编出来的空数组会被当成「扫到了，是平的」。
 */
export function sweepRows(rec: SkillCallRecord): number[][] | null {
  const v = body(rec)
  if (v.length < 6) return null
  const arr = v[5]
  if (!Array.isArray(arr) || arr.length === 0) return null
  if (arr.every((r) => Array.isArray(r))) {
    return (arr as unknown[][]).map((r) => r.map((x) => Number(x)))
  }
  // 一维回来时当成单行——真机上 `2f` 解出来是二维，这一支是给短回包留的
  return [arr.map((x) => Number(x))]
}

/** 通道名在 `Variables[2]`（那个 `*+c` 槽），**不是**回包的原始字节。 */
export function sweepChannelNames(rec: SkillCallRecord): string[] | null {
  const v = body(rec)
  if (v.length < 3) return null
  const names = v[2]
  return Array.isArray(names) ? names.map((n) => String(n)) : null
}

/** 在 `Signals_MeasNamesGet` 的回包里找那张**名字表**（最后一个字符串数组）。 */
function measNames(rec: SkillCallRecord): string[] | null {
  const v = body(rec)
  for (let i = v.length - 1; i >= 0; i -= 1) {
    const item = v[i]
    if (Array.isArray(item) && item.length > 0 && typeof item[0] === 'string') {
      return item.map((x) => String(x))
    }
  }
  return null
}

/** 把电流通道设成采集通道。**找不到就不设**——不编一个索引出来。 */
async function setCurrentAcqChannel(ctx: SkillContext): Promise<void> {
  const rec = await ctx.safeCall('Signals_MeasNamesGet')
  if (failed(rec)) return
  const names = measNames(rec)
  if (names === null) return
  const idx = names.indexOf('Current (A)')
  if (idx < 0) return
  await ctx.safeCall('GenSwp_AcqChsSet', [idx], ['Current (A)'])
}

// ── Generic Sweeper ────────────────────────────────────────────────────────

/** `period_ms` 的声明缺省。**兜底值与它必须是同一个数**（见文件抬头 #138）。 */
const BIAS_SWEEP_PERIOD_MS = 4.0

export const ConfigureBiasSweep: Skill = {
  spec: S.ConfigureBiasSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const lower = f(params, 'lower_v')
    const upper = f(params, 'upper_v')
    const numSteps = int(params, 'num_steps')
    const periodMs = f(params, 'period_ms', BIAS_SWEEP_PERIOD_MS)

    let rec = await ctx.safeCall('GenSwp_Open')
    if (failed(rec)) return fail(rec.error ?? '')

    rec = await ctx.safeCall('GenSwp_SwpSignalSet', 'Bias (V)')
    if (failed(rec)) return fail(rec.error ?? '')

    await setCurrentAcqChannel(ctx)

    rec = await ctx.safeCall('GenSwp_LimitsSet', lower, upper)
    if (failed(rec)) return fail(rec.error ?? '')

    // GenSwp_PropsSet(初始安定 ms, 最大压摆, 步数, 每步 ms, autosave, 保存对话框, 安定 ms)
    rec = await ctx.safeCall('GenSwp_PropsSet', 100, 1e6, numSteps, periodMs, 1, 2, 10)
    if (failed(rec)) return fail(rec.error ?? '')

    return ok({ lower_v: lower, upper_v: upper, num_steps: numSteps, period_ms: periodMs })
  },
}

export const AcquireBiasSweep: Skill = {
  spec: S.AcquireBiasSweepSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    await ctx.safeCall('GenSwp_Open')
    await ctx.safeCall('GenSwp_SwpSignalSet', 'Bias (V)')
    await setCurrentAcqChannel(ctx)

    // **这里刻意不调 `GenSwp_PropsSet`**（文件抬头 ②）：它的安定/压摆参数没有
    // 「不改」哨兵，调一次就把配置阶段刚设好的时序清掉。
    //
    // GenSwp_Start(Get_data, 方向, 保存基名, Reset_signal, Z-Ctrl)
    // Z-Ctrl=1 ⇒ 扫描期间**断开 Z 反馈**（定高）；不断开的话扫到 0 V 附近
    // 反馈会把针尖压进表面。Reset_signal=1 ⇒ 扫完把偏压放回扫描前的值。
    const rec = await ctx.safeCall('GenSwp_Start', 1, 0, '', 1, 1)
    if (failed(rec)) return fail(rec.error ?? '')

    const data: Record<string, unknown> = { acquisition_complete: true }
    const rows = sweepRows(rec)
    if (rows !== null) {
      if (rows.length >= 1) {
        data['bias'] = rows[0]
        data['num_points'] = (rows[0] as number[]).length
      }
      if (rows.length >= 2) data['current'] = rows[1]
      if (rows.length >= 3) data['dIdV'] = rows[2]
    }
    const names = sweepChannelNames(rec)
    if (names !== null) data['channel_names'] = names
    return ok(data)
  },
}

export const GenSwpStop: Skill = {
  spec: S.GenSwpStopSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('GenSwp_Stop')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ stopped: true })
  },
}

export const GenSwpAcqChsGet: Skill = {
  spec: S.GenSwpAcqChsGetSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('GenSwp_AcqChsGet')
    if (failed(rec)) return fail(rec.error ?? '')
    const v = body(rec)
    if (v.length < 2) return ok({ raw: cell(rec) })
    const data: Record<string, unknown> = {
      num_channels: scalarInt(v[0]),
      // 数组元素的强转走仓里那一份（`channelIdsFromBuffer`）：`*i` 回来是
      // 一串 1-元组，自己写一遍 `int(x)` 必抛（KNOWN_ISSUES §2.21）。
      channel_indexes: channelIdsFromBuffer(v),
    }
    if (v.length >= 5 && Array.isArray(v[4])) {
      data['channel_names'] = (v[4] as unknown[]).map((x) => String(x))
    }
    return ok(data)
  },
}

export const GenSwpPropsGet: Skill = {
  spec: S.GenSwpPropsGetSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('GenSwp_PropsGet')
    if (failed(rec)) return fail(rec.error ?? '')
    const v = body(rec)
    if (v.length < 4) return ok({ raw: cell(rec) })
    // [初始安定 ms, 最大压摆, 步数, 每步 ms, autosave, 保存对话框, 安定 ms]
    const data: Record<string, unknown> = {
      initial_settling_time_ms: at(rec, 0),
      max_slew_rate: at(rec, 1),
      num_steps: trunc(at(rec, 2)),
      period_ms: at(rec, 3),
    }
    if (v.length >= 7) {
      data['autosave'] = trunc(at(rec, 4))
      data['save_dialog'] = trunc(at(rec, 5))
      data['settling_time_ms'] = at(rec, 6)
    }
    return ok(data)
  },
}

const trunc = (v: number | null): number | null => (v === null ? null : Math.trunc(v))

export const GenSwpSwpSignalGet: Skill = {
  spec: S.GenSwpSwpSignalGetSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('GenSwp_SwpSignalGet')
    if (failed(rec)) return fail(rec.error ?? '')
    const v = body(rec)
    // `["i","*-c"]` = [名字长度, 名字]。**这条命令不返回扫描方向** ——
    // 旧仓那一版把 `parsed[1]` 当成 `sweep_direction` 去 `int()`，
    // 既取错了槽、又取了一个不存在的字段，在真的名字串上直接炸。
    if (v.length >= 2) return ok({ channel_name: pyStr(v[1]) })
    return ok({ raw: cell(rec) })
  },
}

// ── Lock-In 扫频 ───────────────────────────────────────────────────────────

/** 积分/安定周期数的声明缺省。**兜底与声明同一个数**（#138）。 */
const LOCKIN_SWEEP_PERIODS = 1

export const ConfigureLockInSweep: Skill = {
  spec: S.ConfigureLockInSweepSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const lower = f(params, 'lower_hz')
    const upper = f(params, 'upper_hz')
    const numSteps = int(params, 'num_steps')
    const intPeriods = int(params, 'integration_periods', LOCKIN_SWEEP_PERIODS)
    const setPeriods = int(params, 'settling_periods', LOCKIN_SWEEP_PERIODS)

    let rec = await ctx.safeCall('LockInFreqSwp_Open')
    if (failed(rec)) return fail(rec.error ?? '')

    rec = await ctx.safeCall('LockInFreqSwp_LimitsSet', lower, upper)
    if (failed(rec)) return fail(rec.error ?? '')

    rec = await ctx.safeCall(
      'LockInFreqSwp_PropsSet', numSteps, intPeriods, 0.0, setPeriods, 0.0, 1, 2, '',
    )
    if (failed(rec)) return fail(rec.error ?? '')

    return ok({
      lower_hz: lower,
      upper_hz: upper,
      num_steps: numSteps,
      integration_periods: intPeriods,
      settling_periods: setPeriods,
    })
  },
}

export const AcquireLockInSweep: Skill = {
  spec: S.AcquireLockInSweepSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    await ctx.safeCall('LockInFreqSwp_Open')
    await ctx.safeCall('LockInFreqSwp_PropsSet', 0, 0, 0.0, 0, 0.0, 1, 2, '')

    const rec = await ctx.safeCall('LockInFreqSwp_Start', 1, 0)
    if (failed(rec)) return fail(rec.error ?? '')

    const data: Record<string, unknown> = { acquisition_complete: true }
    const rows = sweepRows(rec)
    if (rows !== null) {
      if (rows.length >= 1) {
        data['frequency'] = rows[0]
        data['num_points'] = (rows[0] as number[]).length
      }
      if (rows.length >= 2) data['amplitude'] = rows[1]
      if (rows.length >= 3) data['phase'] = rows[2]
    }
    const names = sweepChannelNames(rec)
    if (names !== null) data['channel_names'] = names
    return ok(data)
  },
}

export const GetLockInSweepLimits: Skill = {
  spec: S.GetLockInSweepLimitsSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('LockInFreqSwp_LimitsGet')
    if (failed(rec)) return fail(rec.error ?? '')
    if (body(rec).length < 2) return ok({ raw: cell(rec) })
    return ok({ lower_hz: at(rec, 0), upper_hz: at(rec, 1) })
  },
}

export const GetLockInSweepProps: Skill = {
  spec: S.GetLockInSweepPropsSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('LockInFreqSwp_PropsGet')
    if (failed(rec)) return fail(rec.error ?? '')
    const v = body(rec)
    if (v.length < 7) return ok({ raw: cell(rec) })
    const data: Record<string, unknown> = {
      num_steps: trunc(at(rec, 0)),
      integration_periods: trunc(at(rec, 1)),
      min_integration_time_s: at(rec, 2),
      settling_periods: trunc(at(rec, 3)),
      min_settling_time_s: at(rec, 4),
      autosave: trunc(at(rec, 5)),
      save_dialog: trunc(at(rec, 6)),
    }
    // `["H","H","f","H","f","I","I","i","*-c"]`：第 7 位是基名的**长度**，
    // 第 8 位才是基名本身。旧仓返回的是那个长度整数。
    if (v.length >= 9) data['basename'] = v[8] ? pyStr(v[8]) : ''
    return ok(data)
  },
}

export const GetLockInSweepSignal: Skill = {
  spec: S.GetLockInSweepSignalSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('LockInFreqSwp_SignalGet')
    if (failed(rec)) return fail(rec.error ?? '')
    const v = at(rec, 0)
    if (v === null) return ok({ raw: cell(rec) })
    return ok({ sweep_signal_index: Math.trunc(v) })
  },
}

export const SWEEP: Readonly<Record<string, Skill>> = {
  ConfigureBiasSweep,
  AcquireBiasSweep,
  ConfigureLockInSweep,
  AcquireLockInSweep,
  GetLockInSweepLimits,
  GetLockInSweepProps,
  GetLockInSweepSignal,
  GenSwpAcqChsGet,
  GenSwpPropsGet,
  GenSwpStop,
  GenSwpSwpSignalGet,
}
