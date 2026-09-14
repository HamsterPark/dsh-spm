/**
 * 用户输出与数字线 —— 驱动**不是显微镜**的那些硬件。
 *
 * 用户输出是 Nanonis 用来驱动**外部**设备的模拟通道：一个锁相参考、一个栅压、
 * 一台压电放大器、一个激光快门、一条延时线。数字线是触发它们的 TTL 输出：
 * 相机、脉冲发生器、斩波器。旧仓 2026-07-13 之前对这 16 条命令**一个技能都没有**
 * ——智能体能扫图、能扫谱、能打脉冲、能读机器里每一路信号，**却打不开一个输出**。
 *
 * ## 这一族与 `SetBias` 不同的那一点
 *
 * **本仓不知道这个输出口上接的是什么。** 偏压就是偏压，它的安全包络是显微镜自己的
 * 性质，可以写死在安全表里；而一个用户输出可能是伏特、微米、毫瓦，也可能是一个
 * **0 = 开、5 = 关**的快门 —— 编一个界出来，那是一个关于「什么都不是」的界。
 *
 * Nanonis **知道**：每一路输出都带着操作员配置的物理限值（`UserOut_LimitsGet/Set`），
 * 单位与值相同。于是：
 *
 * 1. `SetUserOutput` **读那对限值，越界就拒**。本仓不发明安全包络，它遵守仪器上
 *    已经配好的那一个。而**限值读不到就不写** —— 未知的边界不等于没有边界。
 * 2. `SetUserOutputLimits` **是一个技能**，所以限值并不是智能体跨不过去的屏障。
 *
 * ## 同一句话，在这里成立，在 Z 压电上不成立
 *
 * 这个文件的第一版扣着 `SetUserOutputLimits` 不给，理由是那条软件安全的通则：
 * 「一个能放宽自己护栏的智能体，等于没有护栏」。操作员 2026-07-13 驳回了它，
 * 而他是对的：
 *
 * > 「nanonis 自己的硬件输出很小的，我们在硬件接线的时候就会注意的。」
 *
 * 一个 Nanonis 用户输出是**小信号模拟线**，真正的保护住在**接线**里——放大器、
 * 联锁、以及「你把什么接上去」这个选择。Nanonis 的限值是配置上的方便，
 * **不是最后一道物理屏障**，把它当成物理屏障，等于把另一个领域的威胁模型
 * 搬进一个专门负责物理输出的层。
 *
 * **而批 3f 的 `limits.ts`（Z 压电限值）把同一条论证驳回了**：
 *
 * > 那条理由对一个用户输出成立，对 Z 压电不成立 ——
 * > **没有任何接线能拦住压电把针尖撞进去。**
 *
 * 同一句话一次成立、一次不成立，判据是**有没有物理层**。这不是两处不一致，
 * 是同一条判据在两种硬件上给出两个答案。两边留下的东西也因此一样：
 * 放宽合法、CONFIRM 闸、**每一次都连同改前/改后与一个 `widened` 标志留痕**。
 *
 * ## 中止之后**不清零**
 *
 * 这一族没有一个在中止后的放行清单上，所以操作员一按中止，它们全被拒。
 * 但注意**没做**的那件事：本仓**不会**在中止时把输出清零。清零听起来安全，
 * 而它不是 —— 一个常闭接法的快门在 0 上是**开着的**。本仓不知道接线，
 * 所以它停止写入，而不是猜哪个值叫「关」。你的装置若有一个安全的静置值，
 * 请把它放在一次显式的技能调用后面。
 *
 * 取值语义（官方协议 TCPProtocol_Mimea_V5e）：输出序号**从 1 起算**；
 * 输出值是**已标定的物理单位，不是伏特**；模式 0=User Output / 1=Monitor /
 * 2=Calc.Signal；端口 0=A…3=D，4+ 是扩展 DIO；数字线是端口内的 1..8。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, formatG6, ok, pyStr } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt

/** 输出模式。认不出的**原样说「unknown」**，不编一个名字。 */
const MODES: Readonly<Record<number, string>> = {
  0: 'User Output', 1: 'Monitor', 2: 'Calc.Signal',
}
/** 端口名。4 以上是扩展 DIO，按 `expanded_N` 报。 */
const PORTS: Readonly<Record<number, string>> = { 0: 'A', 1: 'B', 2: 'C', 3: 'D' }
const portName = (p: number): string => PORTS[p] ?? `expanded_${p}`

/** body 的第 i 位当成数，取不出给 `null`。 */
const at = (rec: SkillCallRecord, i: number): number | null => {
  const v = body(rec)[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ── 读 ─────────────────────────────────────────────────────────────────────

export const GetUserOutputLimits: Skill = {
  spec: S.GetUserOutputLimitsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const raw = int(params, 'raw')
    const rec = await ctx.safeCall('UserOut_LimitsGet', idx, raw)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({
      output_index: idx,
      upper_limit: at(rec, 0),
      lower_limit: at(rec, 1),
      raw: raw !== 0,
      note: '单位是该通道的物理单位（可能不是伏特）——由 Nanonis 里的校准决定。',
    })
  },
}

export const GetUserOutputMode: Skill = {
  spec: S.GetUserOutputModeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const rec = await ctx.safeCall('UserOut_ModeGet', idx)
    if (failed(rec)) return fail(rec.error ?? '')
    const mode = at(rec, 0)
    return ok({
      output_index: idx,
      mode: mode === null ? null : Math.trunc(mode),
      mode_name: mode === null ? 'unknown' : (MODES[Math.trunc(mode)] ?? 'unknown'),
    })
  },
}

export const GetUserOutputMonitorChannel: Skill = {
  spec: S.GetUserOutputMonitorChannelSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const rec = await ctx.safeCall('UserOut_MonitorChGet', idx)
    if (failed(rec)) return fail(rec.error ?? '')
    const v = at(rec, 0)
    return ok({ output_index: idx, monitor_channel_index: v === null ? null : Math.trunc(v) })
  },
}

export const GetDigitalLineTTL: Skill = {
  spec: S.GetDigitalLineTTLSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const port = int(params, 'port')
    const rec = await ctx.safeCall('DigLines_TTLValGet', port)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ port, port_name: portName(port), ttl_values: [...body(rec)] })
  },
}

/** 算术运算码 ↔ 符号。认不出的**原样把码印出来**。 */
const OPS: Readonly<Record<string, number>> = { '+': 0, '-': 1, '*': 2, '/': 3 }
const OP_NAMES: Readonly<Record<number, string>> = { 0: '+', 1: '-', 2: '*', 3: '/' }

export const GetCalculatedOutputConfig: Skill = {
  spec: S.GetCalculatedOutputConfigSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const cfg = await ctx.safeCall('UserOut_CalcSignalConfigGet', idx)
    const nm = await ctx.safeCall('UserOut_CalcSignalNameGet', idx)
    if (failed(cfg)) return fail(cfg.error ?? '')
    const opCode = at(cfg, 1)
    const s1 = at(cfg, 0)
    const s2 = at(cfg, 2)
    const nameBody = failed(nm) ? [] : body(nm)
    return ok({
      output_index: idx,
      signal_1: s1 === null ? null : Math.trunc(s1),
      // 认不出的运算码**原样交出去**（旧仓的 `.get(op, op)`）：一个编出来的
      // 符号会让读的人以为自己知道这路输出在算什么。
      operation: opCode === null ? null : (OP_NAMES[Math.trunc(opCode)] ?? Math.trunc(opCode)),
      signal_2: s2 === null ? null : Math.trunc(s2),
      name: nameBody.length > 0 ? nameBody[0] : null,
    })
  },
}

// ── 写 ─────────────────────────────────────────────────────────────────────

/**
 * **这一族的安全模型就在这个技能里。**
 *
 * 本仓不知道这个输出口接的是什么，所以它不发明一个界 —— 它读操作员在仪器上配好的
 * 那一对，越界就拒。而**限值读失败是一次拒绝，不是一张通行证**：
 * 未知的包络不是敞开的包络。
 */
export const SetUserOutput: Skill = {
  spec: S.SetUserOutputSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const value = f(params, 'value')

    const lim = await ctx.safeCall('UserOut_LimitsGet', idx, 0)
    if (failed(lim)) {
      return fail(
        `拒绝写入：无法读取输出 ${idx} 的物理限值（${lim.error ?? ''}）。` +
          'MAST 不知道这个输出口接的是什么，读不到用户配置的限值就不写——' +
          '未知的边界不等于没有边界。',
      )
    }
    const upper = at(lim, 0)
    const lower = at(lim, 1)
    if (upper === null || lower === null) {
      return fail(`拒绝写入：输出 ${idx} 的限值回读格式异常（${pyFloatList(body(lim))}）。`)
    }
    // 仪器给的那一对**不保证谁大谁小**，所以这里自己排一次序 ——
    // 一个「上限比下限小」的配置不该让每一次写入都被判成越界。
    const lo = Math.min(lower, upper)
    const hi = Math.max(lower, upper)
    if (!(lo <= value && value <= hi)) {
      return fail(
        `拒绝写入：${formatG6(value)} 超出输出 ${idx} 的物理限值 ` +
          `[${formatG6(lo)}, ${formatG6(hi)}]（该限值由用户在 Nanonis 中配置，` +
          '是这个通道的安全包络）。若确需更大范围，请在' +
          'Nanonis 界面上调整该输出的 Limits——智能体不能拓宽自己的护栏。',
      )
    }

    const rec = await ctx.safeCall('UserOut_ValSet', idx, value)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({
      output_index: idx,
      value,
      limits: { lower: lo, upper: hi },
      note: '值的单位由该通道的 Nanonis 校准决定，未必是伏特。',
    })
  },
}

/**
 * Python 的 `{list!r}`，**元素按浮点印**——限值那一对是 `float`，
 * 于是 `1.0` 要印成 `1.0` 而不是 `1`。
 */
function pyFloatList(v: readonly unknown[]): string {
  return `[${v.map((x) => (typeof x === 'number' ? pyStr(x) : String(x))).join(', ')}]`
}

/**
 * 同上，但**元素按整数印**。
 *
 * 数字线号在旧仓那边是 `int(x)` 的结果，`str([1, 9])` 给 `[1, 9]`；
 * 按浮点印会得到 `[1.0, 9.0]` —— 两个列表印出来不一样，而这句话是模型读的。
 * （本仓第三次撞上 `str(int)` 与 `str(float)` 的分岔，见 `pyStr` 那一族。）
 */
function pyIntList(v: readonly number[]): string {
  return `[${v.map((x) => String(Math.trunc(x))).join(', ')}]`
}

export const SetUserOutputMode: Skill = {
  spec: S.SetUserOutputModeSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const mode = int(params, 'mode')
    const rec = await ctx.safeCall('UserOut_ModeSet', idx, mode)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ output_index: idx, mode, mode_name: MODES[mode] ?? 'unknown' })
  },
}

export const SetUserOutputMonitorChannel: Skill = {
  spec: S.SetUserOutputMonitorChannelSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const ch = int(params, 'monitor_channel_index')
    const rec = await ctx.safeCall('UserOut_MonitorChSet', idx, ch)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ output_index: idx, monitor_channel_index: ch })
  },
}

/**
 * 改护栏 —— **不拒，但写下来**。
 *
 * 操作员的接线才是真屏障（见文件抬头），所以这不是一道闸；留下的是**诚实的记账**：
 * 改前是什么、改后是什么、以及一个显式的 `widened`。一次放宽从此是
 * **合法的、看得见的、有归属的**；唯一不许的是「悄悄地」。
 */
export const SetUserOutputLimits: Skill = {
  spec: S.SetUserOutputLimitsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    let upper = f(params, 'upper_limit')
    let lower = f(params, 'lower_limit')
    const raw = int(params, 'raw')
    // 颠倒的一对**换过来**：这一处的两个数是同一个量的两端，谁写在前面
    // 不改变意思。（与 `SetPiezoLimits` 的「反过来就拒」刻意不同——
    // 那边反过来意味着调用方把两个**不同**的量搞混了。）
    if (upper < lower) [upper, lower] = [lower, upper]

    // 先记下包络原本是什么，台账那一行才说得出**改了什么**，而不只是「改过」。
    // 尽力而为：一次读失败不该拦住一次合法的限值修改。
    const prev = await ctx.safeCall('UserOut_LimitsGet', idx, raw)
    const pu = failed(prev) ? null : at(prev, 0)
    const pl = failed(prev) ? null : at(prev, 1)
    const before = pu === null || pl === null ? null : { upper: pu, lower: pl }

    const rec = await ctx.safeCall('UserOut_LimitsSet', idx, upper, lower, raw)
    if (failed(rec)) return fail(rec.error ?? '')

    const widened = before !== null && (upper > before.upper || lower < before.lower)
    ctx.markers.emit('note', {
      subject: `UserOut[${idx}].limits`,
      reason:
        (widened ? '护栏被放宽' : '护栏被调整') +
        `：${before === null ? 'None' : `{'upper': ${pyStr(before.upper)}, 'lower': ${pyStr(before.lower)}}`}` +
        ` → {'upper': ${pyStr(upper)}, 'lower': ${pyStr(lower)}}`,
      output_index: idx,
      before,
      after: { upper, lower },
      widened,
      raw: raw !== 0,
    })

    return ok({
      output_index: idx,
      upper_limit: upper,
      lower_limit: lower,
      previous: before,
      raw: raw !== 0,
    })
  },
}

/**
 * 改标定 —— **它重新解释了这一路上的每一个数**。
 *
 * 换了每伏对应多少物理单位之后，同一个数值会驱动出不同的电压，而**所有限值
 * 都按新单位重新理解**：一对没动过的限值，含义已经变了。所以它也留痕。
 */
export const SetUserOutputCalibration: Skill = {
  spec: S.SetUserOutputCalibrationSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const cal = f(params, 'calibration_per_volt')
    const off = f(params, 'offset')
    const rec = await ctx.safeCall('UserOut_CalibrSet', idx, cal, off)
    if (failed(rec)) return fail(rec.error ?? '')
    ctx.markers.emit('note', {
      subject: `UserOut[${idx}].calibration`,
      reason:
        `校准被改写：${pyStr(cal)} 物理单位/V，offset=${pyStr(off)}` +
        '（此后同一个数值会驱动不同的电压，且所有限值按新单位重新解释）',
      output_index: idx,
      calibration_per_volt: cal,
      offset: off,
    })
    return ok({ output_index: idx, calibration_per_volt: cal, offset: off })
  },
}

/**
 * 让一路输出承载两路信号做一次算术的**结果**。
 *
 * 配置成了、但命名失败 ⇒ **照样 success，带一句 `warning`**：
 * 说出「哪一半成了」比把整件事报成失败有用 —— 后者会让调用方把已经生效的配置
 * 再下发一遍。
 */
export const ConfigureCalculatedOutput: Skill = {
  spec: S.ConfigureCalculatedOutputSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = int(params, 'output_index')
    const s1 = int(params, 'signal_1')
    const s2 = int(params, 'signal_2')
    const op = String(params['operation'] ?? '').trim()
    const code = OPS[op]
    if (code === undefined) {
      return fail(`operation 必须是 + - * / 之一，收到 '${op}'`)
    }
    const rec = await ctx.safeCall('UserOut_CalcSignalConfigSet', idx, s1, code, s2)
    if (failed(rec)) return fail(rec.error ?? '')

    const name = typeof params['name'] === 'string' ? params['name'] : ''
    if (name !== '') {
      const rec2 = await ctx.safeCall('UserOut_CalcSignalNameSet', idx, name)
      if (failed(rec2)) {
        return ok({
          output_index: idx,
          expression: `S${s1} ${op} S${s2}`,
          name: null,
          warning: `配置已生效，但命名失败：${rec2.error ?? ''}`,
        })
      }
    }
    return ok({
      output_index: idx,
      expression: `S${s1} ${op} S${s2}`,
      signal_1: s1,
      signal_2: s2,
      operation: op,
      name: name !== '' ? name : null,
      note: '需把该输出设为 mode 2 (Calc.Signal) 才会生效——用 SetUserOutputMode。',
    })
  },
}

/** `'1,2'` → `[1, 2]`。**有一个不是整数，整串作废**（同 `logChannels`）。 */
export function digitalLines(raw: unknown): number[] | null {
  const toks = String(raw ?? '').replaceAll(',', ' ').split(/\s+/).filter((t) => t !== '')
  const out: number[] = []
  for (const t of toks) {
    if (!/^[+-]?\d+$/.test(t)) return null
    out.push(Number(t))
  }
  return out
}

export const PulseDigitalLine: Skill = {
  spec: S.PulseDigitalLineSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const port = int(params, 'port')
    const lines = digitalLines(params['lines'])
    if (lines === null) {
      return fail(`lines 解析失败：'${String(params['lines'] ?? '')}'（应为 1..8 的逗号分隔列表）`)
    }
    // **端口内的行号是 1..8。** 越界的那一条不是「多脉冲一路」——它是另一个端口
    // 上的一条线，而本仓不知道那条线接着什么。
    if (lines.length === 0 || lines.some((v) => !(v >= 1 && v <= 8))) {
      return fail(`digital line 必须在 1..8 之间，收到 ${pyIntList(lines)}`)
    }
    const width = f(params, 'pulse_width_s')
    const pause = f(params, 'pulse_pause_s', 0.001)
    const n = int(params, 'n_pulses', 1) || 1
    const wait = params['wait_until_finished'] !== false ? 1 : 0

    const rec = await ctx.safeCall('DigLines_Pulse', port, lines, width, pause, n, wait)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({
      port,
      port_name: portName(port),
      lines,
      pulse_width_s: width,
      pulse_pause_s: pause,
      n_pulses: n,
    })
  },
}

export const SetDigitalLineStatus: Skill = {
  spec: S.SetDigitalLineStatusSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const port = int(params, 'port')
    const line = int(params, 'line')
    const status = params['status'] === true ? 1 : 0
    const rec = await ctx.safeCall('DigLines_OutStatusSet', port, line, status)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ port, line, status: status !== 0 })
  },
}

export const ConfigureDigitalLine: Skill = {
  spec: S.ConfigureDigitalLineSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const line = int(params, 'line')
    const port = int(params, 'port')
    const direction = int(params, 'direction')
    const polarity = int(params, 'polarity')
    const rec = await ctx.safeCall('DigLines_PropsSet', line, port, direction, polarity)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({
      line,
      port,
      direction: direction !== 0 ? 'output' : 'input',
      polarity: polarity !== 0 ? 'active_high' : 'active_low',
    })
  },
}

export const USER_OUTPUT: Readonly<Record<string, Skill>> = {
  GetUserOutputLimits,
  GetUserOutputMode,
  GetUserOutputMonitorChannel,
  GetDigitalLineTTL,
  GetCalculatedOutputConfig,
  SetUserOutput,
  SetUserOutputMode,
  SetUserOutputMonitorChannel,
  SetUserOutputLimits,
  SetUserOutputCalibration,
  ConfigureCalculatedOutput,
  PulseDigitalLine,
  SetDigitalLineStatus,
  ConfigureDigitalLine,
}
