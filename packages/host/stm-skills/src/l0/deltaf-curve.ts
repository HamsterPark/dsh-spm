/**
 * `AcquireDeltaFCurve` —— 采一条 Δf(z) 力谱曲线，并留下可分析的 `.dat`。
 *
 * `AcquireZSpectr` 把存盘名写死成空串，所以它不落文件；而力谱的整个分析半段
 * （`InvertForceSaderJarvis` 一族）都要读 `.dat`。于是这一条自己走 `safeCall`，
 * 照 `AcquireSTS` 的样子传 `save_basename`。
 *
 * ## 三处要害（旧仓的 docstring 自己写着为什么）
 *
 * ### ① 采之前先读 PLL 状态，**输出没开就直接失败**
 *
 * 不读的话采回来的是一条噪声，而它在数据上与一条真曲线**长得一样**
 * （都是 200 个浮点）。反演那一棒不会发现。
 *
 * ### ② 两个「往下挖几层」的解包器，各自记着一次真机误判
 *
 * | 件 | 回包形状 | 只看一层会怎样 |
 * |---|---|---|
 * | `_first_number` | `(error, raw_bytes, [值])` —— 数在**第二层** | 顶层只有一个空错误串和一坨字节 ⇒ 每一读都回 `None` ⇒ **一台正在跑的 PLL 被报成「关着」** |
 * | `_string_list` | `(error, raw, [size, count, [名字…]])` —— 名字在**第三层** | 第二层是一个首元素为整数的列表 ⇒ 判「不是名字表」⇒ **一台答得好好的仪器被报成「信号表读不到」** |
 *
 * 本仓 `SkillCallRecord.values` **就是** body（信封在 wire 层拆掉了），
 * 于是这两个解包器各少一层：`firstNumber` 在 body 的**顶层**找第一个数，
 * `stringList` 在 body 里递归找第一个全是字符串的列表。
 * **层数是判据的一部分**，所以这件事写在这里，而不只写在 commit 里。
 *
 * ### ③ `.dat` 归属三道闸，缺一不可
 *
 * 找到了 · 名字里带这个 basename · **比采集开始前那道水位线新**。
 * 任何一道不过就不是这次的测量 —— 而「继承上一个点的文件」是唯一一种
 * 会安静地毁掉一整轮的错误（旧仓 `_attach_dat` 的 docstring 原话）。
 *
 * ⚠️ 候选目录只有一路（问仪器要 session 目录），已登记在 **D-FRAME-1 / D-STS-4**。
 * 与之配套：旧仓 `_attach_dat` 结尾那次 `record_scan_path(latest)` 写的是
 * **落盘登记表**（D-FRAME-1 的第 ② 路），本仓没有那张表，也没有会去读它的调用方
 * ⇒ 不搬。它对 `SkillResult` 一个字节都不贡献。
 *
 * ⚠️ **两次 `Util_SessionPathGet`**：水位线一次、归属一次。旧仓也是两次
 * （`_watermark` 与 `_attach_dat` 各调一次 `_candidate_save_dirs`），
 * 调用序列因此逐条对得上。
 */
import { statSync } from 'node:fs'
import { basename as pathBasename } from 'node:path'
import {
  pyFixed,
  reshapeSpectrum,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'
import { existingDirs, findLatestSaved, sessionDir } from './frames.js'
import { lastString } from './reads-hw.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

const DF_HINTS = ['freq. shift', 'freq shift', 'frequency shift'] as const
const AMP_HINTS = ['amplitude'] as const
const OSC_HINTS = ['oc ', 'ocd', 'osc', 'pll', 'excitation'] as const

/** Nanonis 自动保存的 `.dat` 最多算多新（旧仓 `max_age_s=120`）。 */
const SAVED_DAT_MAX_AGE_S = 120

/**
 * `_first_number` —— body **顶层**第一个数（布尔按 `float(bool)` 算）。
 *
 * 见抬头 ②：旧仓从三段信封往下挖两层，挖到的正是本仓的 body 顶层。
 */
export function firstNumber(rec: SkillCallRecord): number | null {
  for (const v of body(rec)) {
    if (typeof v === 'boolean') return v ? 1.0 : 0.0
    if (typeof v === 'number') return v
  }
  return null
}

/** `_string_list` —— body 里第一个「非空且全是字符串」的列表。 */
export function stringList(value: unknown): string[] | null {
  if (typeof value === 'string') return null
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => typeof v === 'string')) {
      return value.map((v) => String(v))
    }
    for (const item of value) {
      const got = stringList(item)
      if (got !== null && got.length > 0) return got
    }
  }
  return null
}

/** `_find` —— 第一个名字里带任一提示词的通道（小写比较）。 */
function findHint(names: readonly string[], hints: readonly string[]): number | null {
  for (let i = 0; i < names.length; i += 1) {
    const low = String(names[i]).toLowerCase()
    if (hints.some((h) => low.includes(h))) return i
  }
  return null
}

/** `_find_amplitude` —— 要**同时**像振幅、又像振荡控制器那一路。 */
function findAmplitude(names: readonly string[]): number | null {
  for (let i = 0; i < names.length; i += 1) {
    const low = String(names[i]).toLowerCase()
    if (AMP_HINTS.some((h) => low.includes(h)) && OSC_HINTS.some((o) => low.includes(o))) return i
  }
  return null
}

/** Python 的 `repr(list_of_str)`（`_channels` 那句诊断要逐字印它）。 */
function pyReprStrList(xs: readonly string[]): string {
  return `[${xs.map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`
}

/** `np.nanmin`；全是 NaN 时给 NaN（同 numpy 的 RuntimeWarning 那一支）。 */
function nanMin(a: readonly number[]): number {
  let best = Number.NaN
  for (const v of a) {
    if (Number.isNaN(v)) continue
    if (Number.isNaN(best) || v < best) best = v
  }
  return best
}

/** `np.nanargmin`；全是 NaN 时给 0（旧仓那一路取不到下标就取第 0 个，见下）。 */
function nanArgMin(a: readonly number[]): number {
  let best = Number.NaN
  let at = 0
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i] as number
    if (Number.isNaN(v)) continue
    if (Number.isNaN(best) || v < best) {
      best = v
      at = i
    }
  }
  return at
}

export interface DeltaFDeps {
  /**
   * `.dat` 的候选目录。缺省与 `GetLatestScanFile` / `AcquireSTS` **同一路**：
   * 问仪器要 session 目录（D-FRAME-1 / D-STS-4）。
   */
  readonly candidateDirs?: (ctx: SkillContext) => Promise<readonly string[]>
  /** 墙钟（秒）。「多旧算旧」要能钉住。 */
  readonly nowS?: () => number
}

async function defaultCandidateDirs(ctx: SkillContext): Promise<string[]> {
  const rec = await ctx.safeCall('Util_SessionPathGet')
  const dir = failed(rec) ? null : sessionDir(lastString(rec))
  return dir === null ? [] : [dir]
}

/** `_watermark` —— 采集之前那些 `.dat` 里最新的一个的 mtime；一个都没有给 `0.0`。 */
function watermarkOf(dirs: readonly string[], nowS: number): number {
  let newest = 0.0
  // 旧仓走 `rglob("*.dat")` 无年龄上限；这里借 `findLatestSaved` 的同一次遍历，
  // 而它带 `maxAgeS` —— 给一个**大到等于「没有上限」**的数（一年），
  // 好让「盘上有一个上周的 .dat」这件事同样把水位线抬起来。
  const found = findLatestSaved(dirs, '.dat', nowS, 365 * 24 * 3600)
  if (found !== null) newest = Math.max(newest, nowS - found.ageS)
  return newest
}

/** `_attach_dat` —— 三道闸（找到了 · 名字带 basename · 比水位线新）。 */
function attachDat(
  dirs: readonly string[],
  basename: string,
  watermark: number,
  nowS: number,
): string | null {
  const latest = findLatestSaved(dirs, '.dat', nowS, SAVED_DAT_MAX_AGE_S)
  if (latest === null) return null
  let mtime: number
  try {
    mtime = statSync(latest.path).mtimeMs / 1000
  } catch {
    return null
  }
  if (mtime < watermark - 1e-6) return null
  if (basename !== '' && !pathBasename(latest.path).includes(basename)) return null
  return latest.path
}

/** `_parse` —— 把扫掠块摊成通道，并挑出四路要用的。返回「解出来了吗」。 */
export function parseDeltaF(rec: SkillCallRecord, data: Record<string, unknown>): boolean {
  const spec = reshapeSpectrum(body(rec))
  const names = Object.keys(spec.channels)
  if (names.length === 0) {
    data['parse_error'] = spec.reason !== '' ? spec.reason : 'empty channel map'
    return false
  }
  data['channel_names'] = names
  data['num_points'] = Math.trunc(spec.numPoints)
  for (const name of names) {
    const low = name.toLowerCase()
    const a = (spec.channels[name] ?? []).map((x) => Number(x))
    // 回程那一路整列跳过 —— 它与正程同名，不分开的话 `df_min_hz` 会取到两条里的最小值。
    if (low.includes('[bwd]')) continue
    if (low.includes('z rel')) {
      data['z_rel'] = a
    } else if (DF_HINTS.some((h) => low.includes(h))) {
      data['freq_shift_hz'] = a
      if (a.length > 0) {
        data['df_min_hz'] = nanMin(a)
        if ('z_rel' in data) {
          data['z_at_df_min_m'] = (data['z_rel'] as number[])[nanArgMin(a)]
        }
      }
    } else if (low.includes('current')) {
      data['current_a'] = a
    } else if (AMP_HINTS.some((h) => low.includes(h))) {
      data['amplitude_m'] = a
    }
  }
  return 'z_rel' in data || 'freq_shift_hz' in data
}

export function makeAcquireDeltaFCurve(deps: DeltaFDeps = {}): Skill {
  const nowS = deps.nowS ?? ((): number => Date.now() / 1000)
  const candidateDirs = deps.candidateDirs ?? defaultCandidateDirs
  return {
    spec: S.AcquireDeltaFCurveSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const modRaw = params['modulator_index']
      const mod = modRaw === undefined || modRaw === null || Number(modRaw) === 0
        ? 1
        : Math.trunc(Number(modRaw))

      const out = await ctx.safeCall('PLL_OutOnOffGet', mod)
      if (failed(out)) return fail(`读不到 PLL 输出状态: ${out.error ?? ''}`)
      const on = firstNumber(out)
      const requireOn = params['require_pll_on'] === undefined ? true : params['require_pll_on'] === true
      if (requireOn && (on === null || on === 0)) {
        return fail(
          'PLL 输出是关的,采不到力谱。先 PLLOnOff 打开输出、' +
            '设好振幅,等振荡起振(约 3 倍 Q/πf0)再来。',
        )
      }
      const f0 = firstNumber(await ctx.safeCall('PLL_CenterFreqGet', mod))
      const dfRest = firstNumber(await ctx.safeCall('PLL_FreqShiftGet', mod))
      const ampSet = firstNumber(await ctx.safeCall('PLL_AmpCtrlSetpntGet', mod))

      // ── 通道：显式给就用，留空按名字找 ──
      let chans: number[]
      const raw = String(params['channel_indexes'] ?? '').trim()
      if (raw !== '') {
        const parsed: number[] = []
        for (const piece of raw.replace(/;/g, ',').split(',')) {
          const s = piece.trim()
          if (s === '') continue
          if (!/^[+-]?\d+$/.test(s)) {
            return fail(`channel_indexes 读不成整数列表: '${raw}'`)
          }
          parsed.push(Number.parseInt(s, 10))
        }
        chans = parsed
      } else {
        const rec = await ctx.safeCall('Signals_NamesGet')
        const names = failed(rec) ? null : stringList(body(rec))
        if (names === null || names.length === 0) {
          return fail('读不到信号表,请显式给 channel_indexes(频移、电流、振幅)')
        }
        const dfI = findHint(names, DF_HINTS)
        const curI = findHint(names, ['current'])
        const ampI = findAmplitude(names)
        if (dfI === null) {
          return fail(`信号表里没有频移通道(有的是 ${pyReprStrList(names.slice(0, 24))}…)`)
        }
        chans = [dfI]
        for (const i of [curI, ampI]) {
          if (i !== null && !chans.includes(i)) chans.push(i)
        }
      }

      await ctx.safeCall('ZSpectr_Open')
      await ctx.safeCall('ZSpectr_ChsSet', chans)
      const zOffRaw = params['z_offset_m']
      const zOff = zOffRaw === undefined || zOffRaw === null || Number(zOffRaw) === 0 ? 0.0 : Number(zOffRaw)
      const distance = Number(params['z_sweep_distance_m'])
      await ctx.safeCall('ZSpectr_RangeSet', zOff, distance)
      const nRaw = params['num_points']
      const n = nRaw === undefined || nRaw === null || Number(nRaw) === 0 ? 200 : Math.trunc(Number(nRaw))
      const bwd = (params['backward_sweep'] === undefined ? true : params['backward_sweep'] === true) ? 1 : 2
      await ctx.safeCall('ZSpectr_PropsSet', bwd, n, 1, 1, 2, 1)
      const saveBasename = String(params['save_basename'] ?? '')

      // 水位线要在**起扫之前**取 —— 取晚了，这次自己写出来的文件会把它抬上去。
      const dirsBefore = existingDirs(await candidateDirs(ctx))
      const watermark = watermarkOf(dirsBefore, nowS())

      const rec = await ctx.safeCall('ZSpectr_Start', 1, saveBasename)
      if (failed(rec)) return fail(`Δf(z) 采集失败: ${rec.error ?? ''}`)

      const data: Record<string, unknown> = {
        acquisition_complete: true,
        num_points: n,
        z_sweep_distance_m: distance,
        z_offset_m: zOff,
        f0_hz: f0,
        df_rest_hz: dfRest,
        amplitude_setpoint_m: ampSet,
        sign_convention: 'z_rel 从 0 起、向表面为负',
        save_basename: saveBasename !== '' ? saveBasename : null,
      }
      const parsed = parseDeltaF(rec, data)
      data['spectrum_parsed'] = parsed
      const dirsAfter = existingDirs(await candidateDirs(ctx))
      const path = attachDat(dirsAfter, saveBasename, watermark, nowS())
      if (path !== null) {
        data['path'] = path
      } else {
        const warnings = (data['warnings'] as string[] | undefined) ?? []
        warnings.push('dat_attribution_failed')
        data['warnings'] = warnings
      }
      if (!parsed && path === null) {
        return fail('曲线块解不开,也没找到对应的 .dat', data)
      }
      const dfMin = data['df_min_hz']
      const summary =
        `Δf(z) ${n} 点,扫程 ${pyFixed(distance * 1e12, 0)} pm` +
        (typeof dfMin === 'number' ? `,最小 ${pyFixed(dfMin, 2)} Hz` : '') +
        (path !== null ? `,存为 ${path}` : ',未找到存盘文件')
      return ok(data, summary)
    },
  }
}

export const AcquireDeltaFCurve: Skill = makeAcquireDeltaFCurve()

/** 这一族（`builtins.deltaf_curve`，1/1）。 */
export const DELTAF_CURVE: Readonly<Record<string, Skill>> = { AcquireDeltaFCurve }
