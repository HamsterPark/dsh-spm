/**
 * 批 3c —— **收口整模块**的 L0 长尾。
 *
 * 七个模块在这一批里从「半完成」变成「完成」。里头没有一个带判据：形状与
 * `reads-hw.ts` / `writes-simple.ts` 完全一样，动词、实参、body 映射与逐字文案
 * 全部来自轨迹金样。
 *
 * 唯一的例外是 `CheckScanForCrash`，它在 `crash.ts` 里——那一个有判据。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, bool, fail, int, num, ok, pyStr } from './common.js'

type Exec = (ctx: SkillContext, params: Readonly<Record<string, unknown>>) => Promise<SkillResultLike>

function read(
  spec: Skill['spec'],
  verb: string,
  map: (rec: SkillCallRecord) => SkillResultLike,
): Skill {
  const execute: Exec = async (ctx) => {
    const rec = await ctx.safeCall(verb)
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return map(rec)
  }
  return { spec, execute }
}

function write(
  spec: Skill['spec'],
  verb: string,
  args: (p: Readonly<Record<string, unknown>>) => unknown[],
  data: (p: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Skill {
  const execute: Exec = async (ctx, params) => {
    const rec = await ctx.safeCall(verb, ...args(params))
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok(data(params))
  }
  return { spec, execute }
}

const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' ? (p[k] as number) : dflt
const b = (p: Readonly<Record<string, unknown>>, k: string, dflt: boolean): boolean =>
  typeof p[k] === 'boolean' ? (p[k] as boolean) : dflt
const s = (p: Readonly<Record<string, unknown>>, k: string, dflt = ''): string =>
  typeof p[k] === 'string' ? (p[k] as string) : dflt

// ── signals ────────────────────────────────────────────────────────────────

/**
 * `Signals_AddRTGet` 的 body 是位置式的：
 * `[名字表字节数, 路数, 可用名字表, 名1字节数, Internal 23 的名字, 名2字节数, Internal 24 的名字]`
 */
export const GetSignalsAddRT = read(S.GetSignalsAddRTSpec, 'Signals_AddRTGet', (r) => {
  const v = body(r)
  const data: Record<string, unknown> = { raw: [...v] }
  if (v.length >= 7) {
    const names = v[2]
    data['available_rt_signals'] = Array.isArray(names)
      ? names.map((x) => pyStr(x))
      : [pyStr(names)]
    data['num_rt_signals'] = int(r, 1)
    data['internal_23_signal'] = pyStr(v[4])
    data['internal_24_signal'] = pyStr(v[6])
  }
  return ok(data)
})

// ── current ────────────────────────────────────────────────────────────────

export const GetCurrentBEEM = read(S.GetCurrentBEEMSpec, 'Current_BEEMGet', (r) =>
  ok({ beem_current_a: num(r, 0) ?? 0 }),
)

/**
 * 增益档表 + 当前档号。**档号越界时不报 `gain`**——一个越界的下标配上一个
 * 「第 N 档」的说法，读的人会以为那一档存在。
 */
export const GetCurrentGains = read(S.GetCurrentGainsSpec, 'Current_GainsGet', (r) => {
  const v = body(r)
  const data: Record<string, unknown> = {}
  if (v.length >= 4) {
    const gains = Array.isArray(v[2]) ? (v[2] as unknown[]).map((g) => String(g)) : []
    data['gains'] = gains
    const idx = int(r, 3)
    data['gain_index'] = idx
    if (idx !== null && idx >= 0 && idx < gains.length) {
      const name = gains[idx] as string
      data['gain'] = name
      // 档名是**跨阻**（V/A），而 DAC 摆幅 ±10 V ⇒ 满量程电流 = 10 / 跨阻
      const r10 = Number(name.replaceAll(' ', ''))
      data['full_scale_a'] = Number.isFinite(r10) && r10 !== 0 ? 10.0 / r10 : null
    }
  }
  const fs = data['full_scale_a']
  const summary =
    typeof fs === 'number' && fs !== 0
      ? `增益档 ${String(data['gain'])}(第 ${String(data['gain_index'])} 档),满量程 ${fmtG3(fs)} A`
      : '读回增益档'
  return ok(data, summary)
})

/** Python 的 `%.3g`。 */
function fmtG3(v: number): string {
  const sci = v.toExponential(2)
  const exp = Number(sci.slice(sci.indexOf('e') + 1))
  const strip = (x: string): string => (x.includes('.') ? x.replace(/\.?0+$/, '') : x)
  if (exp < -4 || exp >= 3) {
    const mant = strip(sci.slice(0, sci.indexOf('e')))
    const a = Math.abs(exp)
    return `${mant}e${exp < 0 ? '-' : '+'}${a < 10 ? `0${a}` : a}`
  }
  return strip(v.toFixed(Math.max(0, 2 - exp)))
}

// ── imaging：背景图 ─────────────────────────────────────────────────────────

/**
 * `timed_out` 读 body 的第 0 位。
 *
 * 旧仓这里错过：它读的是**信封的第 0 位**（成功时永远是空的 error 串），于是
 * `timed_out` **永远是 False**，哪怕真的超时了。本仓在 wire 层就把信封拆了，
 * 但这一条仍然要记着——「读错了位置」在两种形状下都发生得了。
 */
export const ScanBackgroundDelete: Skill = {
  spec: S.ScanBackgroundDeleteSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall(
      'Scan_BackgroundDelete',
      b(params, 'wait_until_deleted', true) ? 1 : 0,
      n(params, 'timeout_ms', -1),
      b(params, 'delete_all', false) ? 1 : 0,
    )
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok({
      delete_all: b(params, 'delete_all', false),
      timed_out: bool(rec, 0) ?? false,
    })
  },
}

export const ScanBackgroundPaste: Skill = {
  spec: S.ScanBackgroundPasteSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall(
      'Scan_BackgroundPaste',
      b(params, 'wait_until_pasted', true) ? 1 : 0,
      n(params, 'timeout_ms', -1),
    )
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok({ timed_out: bool(rec, 0) ?? false })
  },
}

// ── folme：point & shoot ───────────────────────────────────────────────────

export const GetPointShootProps = read(S.GetPointShootPropsSpec, 'FolMe_PSPropsGet', (r) => {
  const v = body(r)
  if (v.length < 7) return ok({ raw: [...v] })
  return ok({
    auto_resume: Boolean(v[0]),
    use_own_basename: Boolean(v[1]),
    basename_size: int(r, 2),
    basename: pyStr(v[3]),
    ext_vi_path_size: int(r, 4),
    ext_vi_path: pyStr(v[5]),
    pre_measure_delay_s: num(r, 6),
  })
})

export const SetPointShootExperiment = write(
  S.SetPointShootExperimentSpec,
  'FolMe_PSExpSet',
  (p) => [n(p, 'experiment_index')],
  (p) => ({ experiment_index: n(p, 'experiment_index') }),
)

export const SetPointShootOnOff = write(
  S.SetPointShootOnOffSpec,
  'FolMe_PSOnOffSet',
  (p) => [b(p, 'enable', true) ? 1 : 0],
  (p) => ({ enabled: b(p, 'enable', true) }),
)

// ── util ───────────────────────────────────────────────────────────────────

export const GetRTOversample = read(S.GetRTOversampleSpec, 'Util_RTOversamplGet', (r) =>
  ok({ rt_oversampling: int(r, 0) }),
)

export const SetRTFreq = write(
  S.SetRTFreqSpec,
  'Util_RTFreqSet',
  (p) => [n(p, 'frequency_hz')],
  (p) => ({ rt_frequency_hz: n(p, 'frequency_hz') }),
)

export const SetRTOversample = write(
  S.SetRTOversampleSpec,
  'Util_RTOversamplSet',
  (p) => [n(p, 'oversampling', 1)],
  (p) => ({ rt_oversampling: n(p, 'oversampling', 1) }),
)

export const LoadLayout = write(
  S.LoadLayoutSpec,
  'Util_LayoutLoad',
  (p) => [s(p, 'file_path'), b(p, 'use_session', false) ? 1 : 0],
  (p) => ({ file_path: s(p, 'file_path'), use_session: b(p, 'use_session', false) }),
)

export const SaveLayout = write(
  S.SaveLayoutSpec,
  'Util_LayoutSave',
  (p) => [s(p, 'file_path'), b(p, 'use_session', false) ? 1 : 0],
  (p) => ({ file_path: s(p, 'file_path'), use_session: b(p, 'use_session', false) }),
)

export const SaveSettings = write(
  S.SaveSettingsSpec,
  'Util_SettingsSave',
  (p) => [s(p, 'file_path'), b(p, 'use_session', false) ? 1 : 0],
  (p) => ({
    action: s(p, 'action', 'save'),
    file_path: s(p, 'file_path'),
    use_session: b(p, 'use_session', false),
  }),
)

/** 解锁面板。它与 `LockNanonisUI` 是一对，而那一个是 DANGEROUS——解锁不是。 */
export const UnlockNanonisUI = write(S.UnlockNanonisUISpec, 'Util_UnLock', () => [], () => ({
  locked: false,
}))

// ── piezo ──────────────────────────────────────────────────────────────────

/** body 是 `[gain_aux, gain_x, gain_y, gain_z, xy_en, z_en, aux_en]`。 */
export const GetPiezoHVAInfo = read(S.GetPiezoHVAInfoSpec, 'Piezo_HVAInfoGet', (r) => {
  const v = body(r)
  if (v.length < 7) return ok({ raw: [...v] })
  return ok({
    gain_aux: num(r, 0),
    gain_x: num(r, 1),
    gain_y: num(r, 2),
    gain_z: num(r, 3),
    xy_enabled: bool(r, 4),
    z_enabled: bool(r, 5),
    aux_enabled: bool(r, 6),
  })
})

export const GetPiezoHVAStatusLED = read(
  S.GetPiezoHVAStatusLEDSpec,
  'Piezo_HVAStatusLEDGet',
  (r) => {
    const v = body(r)
    if (v.length < 4) return ok({ raw: [...v] })
    return ok({
      hv_supply: bool(r, 0),
      output_connector: bool(r, 1),
      overheated: bool(r, 2),
      high_temperature: bool(r, 3),
    })
  },
)

export const LoadPiezoHysteresisFile = write(
  S.LoadPiezoHysteresisFileSpec,
  'Piezo_HystFileLoad',
  (p) => [s(p, 'file_path')],
  (p) => ({ file_path: s(p, 'file_path') }),
)

export const SetPiezoHysteresisOnOff = write(
  S.SetPiezoHysteresisOnOffSpec,
  'Piezo_HystOnOffSet',
  (p) => [b(p, 'enable', true) ? 1 : 0],
  (p) => ({ enabled: b(p, 'enable', true) }),
)

export const SetPiezoSensitivity = write(
  S.SetPiezoSensitivitySpec,
  'Piezo_SensSet',
  (p) => [n(p, 'sens_x'), n(p, 'sens_y'), n(p, 'sens_z')],
  (p) => ({ sens_x: n(p, 'sens_x'), sens_y: n(p, 'sens_y'), sens_z: n(p, 'sens_z') }),
)

/**
 * 四条轴的 hysteresis 补偿点，**每条都是一个浮点数的 JSON 列表**。
 *
 * 解析不了就拒，而且**一个点都不下发**：半条曲线比没有曲线更坏。
 */
export const SetPiezoHysteresisValues: Skill = {
  spec: S.SetPiezoHysteresisValuesSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let pts: number[][]
    try {
      pts = (['fast_x', 'fast_y', 'slow_x', 'slow_y'] as const).map((k) =>
        JSON.parse(String(params[k])) as number[],
      )
    } catch {
      return fail(`Invalid JSON in hysteresis points: ${PY_JSON_ERROR}`)
    }
    const [fx, fy, sx, sy] = pts as [number[], number[], number[], number[]]
    const rec = await ctx.safeCall(
      'Piezo_HystValsSet',
      fx.length, fx, fy.length, fy, sx.length, sx, sy.length, sy,
    )
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok({ fast_axis_points: fx.length, slow_axis_points: sx.length })
  },
}

/**
 * Python `json.loads` 那句话，逐字。
 *
 * `JSON.parse` 的英文与 `json.JSONDecodeError` 的英文**不一样**（前者
 * `Unexpected token …`，后者 `Expecting value: line 1 column 1 (char 0)`），
 * 而这句话是模型读的。这里印旧仓那一句。
 *
 * **位置写死在第 1 列**：见 `spec/deviations.md` D-JSON-1 —— 复刻 CPython 的
 * 解析器好报出准确的行列，等于为了一句诊断再写一个 JSON 解析器；
 * 而模型要的信息是「这个参数不是 JSON」，那一句已经说到了。
 */
const PY_JSON_ERROR = 'Expecting value: line 1 column 1 (char 0)'

export const TAIL_L0: Readonly<Record<string, Skill>> = {
  GetSignalsAddRT,
  GetCurrentBEEM,
  GetCurrentGains,
  ScanBackgroundDelete,
  ScanBackgroundPaste,
  GetPointShootProps,
  SetPointShootExperiment,
  SetPointShootOnOff,
  GetRTOversample,
  SetRTFreq,
  SetRTOversample,
  LoadLayout,
  SaveLayout,
  SaveSettings,
  UnlockNanonisUI,
  GetPiezoHVAInfo,
  GetPiezoHVAStatusLED,
  LoadPiezoHysteresisFile,
  SetPiezoHysteresisOnOff,
  SetPiezoHysteresisValues,
  SetPiezoSensitivity,
}
