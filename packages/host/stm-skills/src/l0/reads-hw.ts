/**
 * 批 1 只读 L0 —— piezo / motor / safe-tip / util / signals 一族。
 *
 * 同 `reads-core.ts`：动词、实参、body 映射与逐字文案都来自轨迹金样。
 */
import { implausibleReadings, type Skill, type SkillCallRecord, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { bool, body, fail, int, num, ok, strList } from './common.js'

type Exec = (ctx: SkillContext, params: Readonly<Record<string, unknown>>) => Promise<SkillResultLike>

function read(
  spec: Skill['spec'],
  verb: string,
  map: (rec: SkillCallRecord) => SkillResultLike,
  args: (params: Readonly<Record<string, unknown>>) => unknown[] = () => [],
): Skill {
  const execute: Exec = async (ctx, params) => {
    const rec = await ctx.safeCall(verb, ...args(params))
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return map(rec)
  }
  return { spec, execute }
}

/**
 * 粗动驱动幅度的**本机上限未声明**时的那段话，逐字。
 *
 * 它同时是 `GetMotorFreqAmp` 的 `note` 与 `SetMotorFreqAmp` 的拒绝理由——
 * 旧仓也是同一个常量（`core/coarse_drive.py::_UNDECLARED`）。
 * 一句话两处用，措辞就不会漂。
 */
export const COARSE_AMP_UNDECLARED =
  '本机粗动驱动幅度上限【尚未声明】,拒绝设置驱动电压。\n' +
  '控制器支持的电压和这台机器的压电叠堆能承受的电压是两个数 —— 有些控制器支持 400 V,' +
  '但有的叠堆 300 V 就烧了,而且没有任何读数会告诉你是哪一种。\n' +
  '请用户在【高级】页填写本机上限(需要 admin PIN)。在那之前 MAST 不会替这台机器猜。'

// ── zcontrol 增益 ───────────────────────────────────────────────────────────

export const GetZCtrlGain = read(S.GetZCtrlGainSpec, 'ZCtrl_GainGet', (r) => {
  const [p, t, i] = [num(r, 0), num(r, 1), num(r, 2)]
  if (p === null || t === null || i === null) return ok({ raw: [...body(r)] })
  // 单位是这里的关键：P 增益是**长度**（米），不是无量纲比例。
  // 量纲对了，物理合理性表才判得对——同名的无量纲增益不会被误判。
  const units = { p_gain: 'm', time_constant_s: 's', i_gain: 'm/s' }
  return ok({
    p_gain: p,
    time_constant_s: t,
    i_gain: i,
    units,
    warnings: implausibleReadings({
      p_gain: [p, units.p_gain],
      i_gain: [i, units.i_gain],
    }),
  })
})

// ── piezo ───────────────────────────────────────────────────────────────────

export const GetPiezoTilt = read(S.GetPiezoTiltSpec, 'Piezo_TiltGet', (r) => {
  const [x, y] = [num(r, 0), num(r, 1)]
  if (x === null || y === null) return ok({ raw: [...body(r)] })
  return ok({ tilt_x_deg: x, tilt_y_deg: y })
})

export const GetPiezoSensitivity = read(S.GetPiezoSensitivitySpec, 'Piezo_SensGet', (r) => {
  const [x, y, z] = [num(r, 0), num(r, 1), num(r, 2)]
  if (x === null || y === null || z === null) return ok({ raw: [...body(r)] })
  return ok({ sens_x: x, sens_y: y, sens_z: z })
})

export const GetDriftCompensation = read(S.GetDriftCompensationSpec, 'Piezo_DriftCompGet', (r) => {
  // returns = [I,f,f,f,I,I,I,f] ⇒ [enabled, vx, vy, vz, xsat, ysat, zsat, _]
  const en = bool(r, 0)
  const [vx, vy, vz] = [num(r, 1), num(r, 2), num(r, 3)]
  if (en === null || vx === null || vy === null || vz === null) return ok({ raw: [...body(r)] })
  return ok({
    enabled: en,
    vx, vy, vz,
    x_saturated: bool(r, 4) ?? false,
    y_saturated: bool(r, 5) ?? false,
    z_saturated: bool(r, 6) ?? false,
  })
})

export const GetPiezoXYZLimits = read(S.GetPiezoXYZLimitsSpec, 'Piezo_XYZLimitsGet', (r) => {
  // returns = [H,f,f,f,f,f,f] ⇒ [enabled, xlo, xhi, ylo, yhi, zlo, zhi]
  const en = bool(r, 0)
  const v = [num(r, 1), num(r, 2), num(r, 3), num(r, 4), num(r, 5), num(r, 6)]
  if (en === null || v.some((x) => x === null)) return ok({ raw: [...body(r)] })
  return ok({
    limits_enabled: en,
    x_low_v: v[0], x_high_v: v[1],
    y_low_v: v[2], y_high_v: v[3],
    z_low_v: v[4], z_high_v: v[5],
  })
})

// ── motor ───────────────────────────────────────────────────────────────────

export const GetMotorFreqAmp = read(
  S.GetMotorFreqAmpSpec,
  'Motor_FreqAmpGet',
  (r) => {
    const f = num(r, 0)
    const a = num(r, 1)
    // **读不到也照样把「上限未声明」这件事说出来**：模型下一步多半要写，
    // 而写会被拒。提前告诉它比让它撞一次再读拒绝理由好。
    return ok({
      frequency_hz: f,
      amplitude_v: a,
      axis: 'all',
      declared_max_amplitude_v: null,
      within_declared_limit: false,
      note: COARSE_AMP_UNDECLARED,
    })
  },
  () => [0],
)

export const MotorGetPos = read(
  S.MotorGetPosSpec,
  'Motor_PosGet',
  (r) => {
    const [x, y, z] = [num(r, 0), num(r, 1), num(r, 2)]
    if (x === null || y === null || z === null) return ok({ raw: [...body(r)] })
    return ok({ x_m: x, y_m: y, z_m: z })
  },
  () => [0, 500],
)

export const GetMotorStepCounter = read(
  S.GetMotorStepCounterSpec,
  'Motor_StepCounterGet',
  (r) => {
    const [x, y, z] = [int(r, 0), int(r, 1), int(r, 2)]
    if (x === null || y === null || z === null) return ok({ raw: [...body(r)] })
    return ok({ step_counter_x: x, step_counter_y: y, step_counter_z: z })
  },
  () => [0, 0, 0],
)

// ── approach / safe tip ─────────────────────────────────────────────────────

export const GetAutoApproachStatus = read(
  S.GetAutoApproachStatusSpec,
  'AutoApproach_OnOffGet',
  (r) => {
    const v = bool(r, 0)
    // D-SKILL-2：旧仓这句里印的是 Python 的回包 repr（`('', b'', [])`）——
    // 我们这一侧信封在 wire 层就拆掉了，只有 body。印我们真有的东西。
    return v === null
      ? fail(
          `AutoApproach_OnOffGet 回来了,但状态位读不懂(values=${JSON.stringify(body(r))})` +
            `—— 这**不是**「没在进针」,是没问出来。`,
          // 失败也带 `running: null` —— **显式的「不知道」**，
          // 调用方拿到的不能是一个缺席的键（那会被当成 false）。
          { running: null },
        )
      : ok({ running: v })
  },
)

export const GetSafeTipStatus = read(S.GetSafeTipStatusSpec, 'SafeTip_OnOffGet', (r) => {
  const v = bool(r, 0)
  // D-SKILL-3：旧仓这里直接 `parsed[2][0]`，空 body 时抛 IndexError ——
  // 一个只读技能以一句看不懂的 IndexError 失败。我们判成「读不出」。
  return v === null
    ? fail('SafeTip_OnOffGet 回来了,但状态位读不懂 —— 这**不是**「保护未开」,是没问出来。')
    : ok({ enabled: v })
})

export const GetSafeTipProps = read(S.GetSafeTipPropsSpec, 'SafeTip_PropsGet', (r) =>
  ok({
    auto_recovery: bool(r, 0) ?? false,
    auto_pause_scan: bool(r, 1) ?? false,
    threshold: num(r, 2) ?? 0,
  }),
)

export const GetSafeTipSignal = read(S.GetSafeTipSignalSpec, 'SafeTip_SignalGet', (r) =>
  ok({ signal_value: num(r, 0) ?? 0 }),
)

// ── util / signals ──────────────────────────────────────────────────────────

/**
 * body 里**最后一个字符串**。
 *
 * `Util.SessionPathGet` 的 `ResponseTypes = ["i", "*-c"]` ⇒ body 是
 * `[路径字节数, 路径]`，路径跟在它的长度后面。**一个解析器两处用**
 * （读与 `SetSessionPath` 的回读）——回读若由另一份单独写的解析器来读，
 * 它可以自己和自己一致而两边都是错的。
 */
export function lastString(rec: SkillCallRecord): string {
  const b = body(rec)
  for (let i = b.length - 1; i >= 0; i--) if (typeof b[i] === 'string') return b[i] as string
  return ''
}

export const GetSessionPath = read(S.GetSessionPathSpec, 'Util_SessionPathGet', (r) =>
  ok({ session_path: lastString(r) }),
)

export const GetAcqPeriod = read(S.GetAcqPeriodSpec, 'Util_AcqPeriodGet', (r) =>
  ok({ acquisition_period_s: num(r, 0) ?? 0 }),
)

export const GetRTFreq = read(S.GetRTFreqSpec, 'Util_RTFreqGet', (r) =>
  ok({ rt_frequency_hz: num(r, 0) ?? 0 }),
)

// ── signals ─────────────────────────────────────────────────────────────────

/**
 * 名字看起来像电流通道吗。
 *
 * Nanonis 按配置把隧道电流挂在好几个显示名下（`Current (A)` / `Current` /
 * `Current 2 (A)`），界面据此**预选**最可能的那一路，省得人翻 128 个通道。
 * 判据刻意窄（`current` 开头），宽了会把 lock-in 的解调电流也算进来。
 */
function isCurrentName(name: string): boolean {
  return name.trim().toLowerCase().startsWith('current')
}

export const ListSignalChannels = read(S.ListSignalChannelsSpec, 'Signals_NamesGet', (r) => {
  // returns = ["i","i","*+c"] ⇒ body = [size, declared_n, names]
  const names = strList(r, 2)
  if (names.length === 0) {
    return fail(`Could not parse signal names from response: ${JSON.stringify(body(r))}`)
  }
  const declared = int(r, 1)
  const channels = names.map((n, i) => ({ index: i, name: n }))
  // **仪器自己说有多少路**与我们解出多少路是两个数。不一致就报出来，
  // 不用 len() 覆盖掉它 —— 真机上名单被截断过一次（51 条），而
  // 「没解出来」和「本机没有」是两句不同的话。
  const truncated = declared !== null && declared > names.length
  return ok({
    channels,
    n_channels: channels.length,
    declared_n: declared,
    truncated,
    current_indices: channels.filter((c) => isCurrentName(c.name)).map((c) => c.index),
  })
})

export const GetSignalValues: Skill = {
  spec: S.GetSignalValuesSpec,
  execute: async (ctx, params) => {
    const idxStr = String(params['signal_indexes'] ?? '')
    const indexes: number[] = []
    const bad: string[] = []
    for (const raw of idxStr.split(',')) {
      const piece = raw.trim()
      if (piece === '') continue
      // 与 Python 的 `int(piece)` 同判据：**只收整数字面量**，
      // `Number('1.5')` 那种宽松解析会把 1.5 悄悄当成通道 1。
      if (/^[+-]?\d+$/.test(piece)) indexes.push(Number(piece))
      else bad.push(piece)
    }
    if (bad.length > 0 || indexes.length === 0) {
      return fail(
        `signal_indexes 解不出通道号:${pyStr(idxStr)}。` +
          (bad.length > 0 ? `这几段不是整数:${pyList(bad)}。` : '一个都没给出。') +
          '格式是逗号分隔的整数,例如 "0" 或 "0,24,30"。(通道清单见 ListSignalChannels。)',
      )
    }
    const wait = params['wait_for_newest'] === true ? 1 : 0
    const rec = await ctx.safeCall('Signals_ValsGet', indexes, wait)
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    // returns = ["i","*f"] ⇒ body = [size, values]。读数在 body[1]，**不是** body[0]
    // （body[0] 只是数组长度）。
    const vals = body(rec)[1]
    return ok({
      signal_indexes: indexes,
      values: Array.isArray(vals) ? vals.map((v) => scalarOr0(v)) : [],
    })
  },
}

export const GetSignalRange: Skill = {
  spec: S.GetSignalRangeSpec,
  execute: async (ctx, params) => {
    const idx = params['signal_index']
    const rec = await ctx.safeCall('Signals_RangeGet', idx)
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    const [max, min] = [num(rec, 0), num(rec, 1)]
    // D-SKILL-1：旧仓兜底把整个信封塞进 `raw`。我们给 body。
    if (max === null || min === null) return ok({ signal_index: idx, raw: [...body(rec)] })
    return ok({ signal_index: idx, max_limit: max, min_limit: min })
  },
}

/** Python 的 `repr(str)`：单引号 + 反斜杠转义。 */
function pyStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Python 的 `repr(list[str])`。 */
function pyList(xs: readonly string[]): string {
  return `[${xs.map(pyStr).join(', ')}]`
}

/** 单元素元组要拆包（`decodeArray` 会吐 `(1.0,)` 这种）。 */
function scalarOr0(v: unknown): number {
  const n = Array.isArray(v) && v.length === 1 ? v[0] : v
  return typeof n === 'number' ? n : Number(n)
}

/**
 * `GetLatestScanFile` **不在这一批**：它不发仪器调用，而是去会话目录里翻
 * 最新的 `.sxm`（轨迹金样里三条轨迹的 data 完全一样，因为假环境里没有目录）。
 * 判据落在文件系统上，跟着 `nanonis-files` 一起做更合适。
 */

export const HW_READS: Readonly<Record<string, Skill>> = {
  GetZCtrlGain,
  GetPiezoTilt, GetPiezoSensitivity, GetDriftCompensation, GetPiezoXYZLimits,
  GetMotorFreqAmp, MotorGetPos, GetMotorStepCounter,
  GetAutoApproachStatus, GetSafeTipStatus, GetSafeTipProps, GetSafeTipSignal,
  GetSessionPath, GetAcqPeriod, GetRTFreq,
  ListSignalChannels, GetSignalValues, GetSignalRange,
}
