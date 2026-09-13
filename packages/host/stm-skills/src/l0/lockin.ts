/**
 * 锁相放大器 —— dI/dV 的全部前提都在这一族上。
 *
 * ## 一条贯穿全族的纪律：**调制错了信号，曲线依然完美**
 *
 * 一个调制在错误信号上的锁相，会产出一条**完全干净、形状完全像 dI/dV 的曲线**，
 * 而它不是 dI/dV——图上没有任何地方看得出不对。所以这一族里最要紧的不是那些 setter，
 * 是 `GetLockInConfig` 里的 `modulated_signal`：**能不能读回来**。
 *
 * 旧仓 2026-07-13 之前只有 set 没有 get，于是每一次「锁相已配置好」都是这个技能
 * 把自己的请求又念了一遍给自己听。
 *
 * ## 顺序：先设值，后开调制
 *
 * 旧仓原先**先开调制**，于是隧道结会被上一次残留的幅度/频率激励一小段时间
 * （2026-07-03 复盘）。现在四个值先写下去，最后才开。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { scalarInt } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, num, ok } from './common.js'

type Exec = (ctx: SkillContext, params: Readonly<Record<string, unknown>>) => Promise<SkillResultLike>

/** 调制器 / 解调器下标，缺省 1。 */
const idx = (p: Readonly<Record<string, unknown>>, k: string, dflt = 1): number => {
  const v = p[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}
/** 「调用方**真的给了**这个值吗」。`null` 与 `undefined` 都算没给。 */
const given = (p: Readonly<Record<string, unknown>>, k: string): boolean =>
  p[k] !== undefined && p[k] !== null
const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' ? (p[k] as number) : dflt

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

// ── 配置：调制侧 ───────────────────────────────────────────────────────────

/**
 * `ConfigureLockIn` —— 设调制的频率 / 幅度 / 相位，然后开关调制。
 *
 * **给了才写**，而且 `0` 也算给了：`amplitude_v = 0` 是「开之前先把它变安全」，
 * 旧仓那一版的 `> 0` / `!= 0` 守卫让这件事做不到。频率 0 仍然跳过——
 * 那不是一个合法的调制频率。
 *
 * `data` 里的 `*_written` 三个标志是判据的一半：**没写的那个字段报 `null`**，
 * 而不是报一个它从没设过的值。旧仓那一版无条件报 `phase_deg: 0.0`——
 * 一个宣称了某个相位、而那个寄存器它根本没碰过的返回值。
 */
export const ConfigureLockIn: Skill = {
  spec: S.ConfigureLockInSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const modOn = params['mod_on'] === true
    const modulator = 1

    let frequencyWritten = false
    let amplitudeWritten = false
    let phaseWritten = false

    if (given(params, 'frequency_hz') && n(params, 'frequency_hz') > 0) {
      const r = await ctx.safeCall('LockIn_ModPhasFreqSet', modulator, n(params, 'frequency_hz'))
      if (failed(r)) return fail(r.error ?? '')
      frequencyWritten = true
    }
    if (given(params, 'amplitude_v') && n(params, 'amplitude_v') >= 0) {
      const r = await ctx.safeCall('LockIn_ModAmpSet', modulator, n(params, 'amplitude_v'))
      if (failed(r)) return fail(r.error ?? '')
      amplitudeWritten = true
    }
    if (given(params, 'phase_deg')) {
      const r = await ctx.safeCall('LockIn_ModPhasSet', modulator, n(params, 'phase_deg'))
      if (failed(r)) return fail(r.error ?? '')
      phaseWritten = true
    }

    // **最后**才开/关——此刻那几个值已经在位了
    const r = await ctx.safeCall('LockIn_ModOnOffSet', modulator, modOn ? 1 : 0)
    if (failed(r)) return fail(r.error ?? '')

    return ok({
      mod_on: modOn,
      amplitude_v: amplitudeWritten ? n(params, 'amplitude_v') : null,
      amplitude_written: amplitudeWritten,
      frequency_hz: frequencyWritten ? n(params, 'frequency_hz') : null,
      frequency_written: frequencyWritten,
      phase_deg: phaseWritten ? n(params, 'phase_deg') : null,
      phase_written: phaseWritten,
    })
  },
}

/**
 * `ConfigureLockInDemod` —— 解调侧的五组子设置，**给了哪个写哪个**。
 *
 * ⚠️ 判据是 `params[k] != null`，**不是** `k in params`：模型那条路上
 * schema 会把每一个可选字段都实例化出来，没设的以 `null` 到达 ——
 * 用 `in` 判的话每一个都「给了」，于是把 `null` 送进硬件 setter
 * （真机上是 struct.pack 失败，或者一次写坏的写入）。
 */
export const ConfigureLockInDemod: Skill = {
  spec: S.ConfigureLockInDemodSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const demod = idx(params, 'demodulator')

    if (given(params, 'signal_index')) {
      const r = await ctx.safeCall('LockIn_DemodSignalSet', demod, n(params, 'signal_index'))
      if (failed(r)) return fail(r.error ?? '')
    }
    if (given(params, 'harmonic')) {
      const r = await ctx.safeCall('LockIn_DemodHarmonicSet', demod, n(params, 'harmonic'))
      if (failed(r)) return fail(r.error ?? '')
    }
    // 滤波的阶与截止是**一对**：给了任意一个就下发，另一个用哨兵
    // （阶 `-1` = 不改，截止 `0.0` = 不改）
    if (given(params, 'lp_order') || given(params, 'lp_cutoff_hz')) {
      const order = given(params, 'lp_order') ? n(params, 'lp_order') : -1
      const cutoff = given(params, 'lp_cutoff_hz') ? n(params, 'lp_cutoff_hz') : 0.0
      const r = await ctx.safeCall('LockIn_DemodLPFilterSet', demod, order, cutoff)
      if (failed(r)) return fail(r.error ?? '')
    }
    if (given(params, 'hp_order') || given(params, 'hp_cutoff_hz')) {
      const order = given(params, 'hp_order') ? n(params, 'hp_order') : -1
      const cutoff = given(params, 'hp_cutoff_hz') ? n(params, 'hp_cutoff_hz') : 0.0
      const r = await ctx.safeCall('LockIn_DemodHPFilterSet', demod, order, cutoff)
      if (failed(r)) return fail(r.error ?? '')
    }
    if (given(params, 'phase_deg')) {
      const r = await ctx.safeCall('LockIn_DemodPhasSet', demod, n(params, 'phase_deg'))
      if (failed(r)) return fail(r.error ?? '')
    }

    return ok({ demodulator: demod })
  },
}

// ── 读回：整份配置 ─────────────────────────────────────────────────────────

/** 一次读：成功就取 body 的第 0 位，失败或解不出**不写这个键**。 */
async function readInto(
  data: Record<string, unknown>,
  key: string,
  call: () => Promise<SkillCallRecord>,
  pick: (rec: SkillCallRecord) => unknown,
): Promise<void> {
  const rec = await call()
  if (failed(rec)) return
  if (body(rec).length === 0) return
  data[key] = pick(rec)
}

/**
 * `GetLockInConfig` —— 把调制侧与解调侧一次读齐。
 *
 * 后半段那六个字段是 **2026-07-13 补上的读回那一半**：在那之前每一个都只能 set、
 * 读不回来，于是「锁相已配置好」全靠技能自己复述自己的请求。
 * `modulated_signal` 是其中最要紧的那个（见文件抬头）。
 *
 * 那六格 **`null` 表示读不到**，不是 0。
 */
export const GetLockInConfig: Skill = {
  spec: S.GetLockInConfigSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const mod = idx(params, 'modulator')
    const data: Record<string, unknown> = { modulator: mod }

    await readInto(data, 'mod_on', () => ctx.safeCall('LockIn_ModOnOffGet', mod), (r) =>
      Boolean(body(r)[0]),
    )
    await readInto(data, 'amplitude', () => ctx.safeCall('LockIn_ModAmpGet', mod), (r) =>
      num(r, 0),
    )
    await readInto(data, 'frequency_hz', () => ctx.safeCall('LockIn_ModPhasFreqGet', mod), (r) =>
      num(r, 0),
    )
    await readInto(data, 'phase_deg', () => ctx.safeCall('LockIn_ModPhasGet', mod), (r) =>
      num(r, 0),
    )

    const demod = idx(params, 'demodulator', mod)
    data['demodulator'] = demod

    // 动词字面量：见 `reads-config.ts` 抬头那段。
    for (const [key, thunk] of [
      ['modulated_signal', (): Promise<SkillCallRecord> => ctx.safeCall('LockIn_ModSignalGet', mod)],
      ['harmonic', (): Promise<SkillCallRecord> => ctx.safeCall('LockIn_ModHarmonicGet', mod)],
      ['mod_phase_register', (): Promise<SkillCallRecord> => ctx.safeCall('LockIn_ModPhasRegGet', mod)],
      ['demod_phase_register', (): Promise<SkillCallRecord> => ctx.safeCall('LockIn_DemodPhasRegGet', demod)],
      ['demod_rt_signals', (): Promise<SkillCallRecord> => ctx.safeCall('LockIn_DemodRTSignalsGet', demod)],
      ['demod_sync_filter', (): Promise<SkillCallRecord> => ctx.safeCall('LockIn_DemodSyncFilterGet', demod)],
    ] as const) {
      const rec = await thunk()
      // **`null` = 读不到**（调用失败或解不出），不是 0。
      data[key] = failed(rec) ? null : scalarInt(rec.values ?? null)
    }

    return ok(data)
  },
}

// ── 解调侧的六个读 ─────────────────────────────────────────────────────────

/**
 * 解调侧的单动词读。
 *
 * `map` 解不出来时（回包短了、位置不对）返回 `null` ⇒ 交出 **`raw` 兜底**，
 * 而不是几个 `null` 字段。两者的区别是「这是什么我看不懂，原样给你」
 * 与「我看懂了，它是空的」——后者会被当成一个读数。
 */
function demodRead(
  spec: Skill['spec'],
  verb: string,
  map: (rec: SkillCallRecord, demod: number) => Record<string, unknown> | null,
): Skill {
  const execute: Exec = async (ctx, params) => {
    const demod = idx(params, 'demodulator')
    const rec = await ctx.safeCall(verb, demod)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok(map(rec, demod) ?? { demodulator: demod, raw: [...body(rec)] })
  }
  return { spec, execute }
}

/** body 的第 i 位取整数；取不出给 `null`。 */
const at = (r: SkillCallRecord, i: number): number | null => {
  const v = body(r)[i]
  return typeof v === 'number' ? Math.trunc(v) : null
}

export const GetDemodSignal = demodRead(S.GetDemodSignalSpec, 'LockIn_DemodSignalGet', (r, d) => {
  const v = scalarInt(r.values ?? null)
  return v === null ? null : { demodulator: d, signal_index: v }
})

export const GetDemodPhase = demodRead(S.GetDemodPhaseSpec, 'LockIn_DemodPhasGet', (r, d) => {
  const v = num(r, 0)
  return v === null ? null : { demodulator: d, phase_deg: v }
})

export const GetDemodPhasReg = demodRead(S.GetDemodPhasRegSpec, 'LockIn_DemodPhasRegGet', (r, d) => {
  const v = scalarInt(r.values ?? null)
  return v === null ? null : { demodulator: d, phase_register_index: v }
})

export const GetDemodHarmonic = demodRead(S.GetDemodHarmonicSpec, 'LockIn_DemodHarmonicGet', (r, d) => {
  const v = scalarInt(r.values ?? null)
  return v === null ? null : { demodulator: d, harmonic: v }
})

export const GetDemodLPFilter = demodRead(S.GetDemodLPFilterSpec, 'LockIn_DemodLPFilterGet', (r, d) => {
  // **两位都要有**：阶与截止是一对，只有一个解得出来不成立
  if (body(r).length < 2) return null
  return { demodulator: d, lp_filter_order: at(r, 0), lp_cutoff_hz: num(r, 1) }
})

export const GetDemodHPFilter = demodRead(S.GetDemodHPFilterSpec, 'LockIn_DemodHPFilterGet', (r, d) => {
  if (body(r).length < 2) return null
  return { demodulator: d, hp_filter_order: at(r, 0), hp_cutoff_hz: num(r, 1) }
})

// ── 调制/解调侧的五个写 ────────────────────────────────────────────────────

function lockinWrite(
  spec: Skill['spec'],
  verb: string,
  which: 'modulator' | 'demodulator',
  arg: (p: Readonly<Record<string, unknown>>) => unknown,
  data: (p: Readonly<Record<string, unknown>>, i: number) => Record<string, unknown>,
): Skill {
  const execute: Exec = async (ctx, params) => {
    const i = idx(params, which)
    const rec = await ctx.safeCall(verb, i, arg(params))
    if (failed(rec)) return fail(rec.error ?? '')
    return ok(data(params, i))
  }
  return { spec, execute }
}

export const SetModSignal = lockinWrite(
  S.SetModSignalSpec, 'LockIn_ModSignalSet', 'modulator',
  (p) => n(p, 'signal_index'),
  (p, i) => ({ modulator: i, signal_index: n(p, 'signal_index') }),
)

export const SetModPhasReg = lockinWrite(
  S.SetModPhasRegSpec, 'LockIn_ModPhasRegSet', 'modulator',
  (p) => n(p, 'phase_register_index'),
  (p, i) => ({ modulator: i, phase_register_index: n(p, 'phase_register_index') }),
)

export const SetModHarmonic = lockinWrite(
  S.SetModHarmonicSpec, 'LockIn_ModHarmonicSet', 'modulator',
  (p) => n(p, 'harmonic'),
  (p, i) => ({ modulator: i, harmonic: n(p, 'harmonic') }),
)

export const SetDemodSyncFilter = lockinWrite(
  S.SetDemodSyncFilterSpec, 'LockIn_DemodSyncFilterSet', 'demodulator',
  (p) => (p['sync_filter_on'] === true ? 1 : 0),
  (p, i) => ({ demodulator: i, sync_filter_on: p['sync_filter_on'] === true }),
)

export const SetDemodRTSignals = lockinWrite(
  S.SetDemodRTSignalsSpec, 'LockIn_DemodRTSignalsSet', 'demodulator',
  (p) => n(p, 'rt_signals'),
  (p, i) => ({ demodulator: i, rt_signals: n(p, 'rt_signals') }),
)

export const LOCKIN: Readonly<Record<string, Skill>> = {
  GetLockInConfig,
  ConfigureLockIn,
  ConfigureLockInDemod,
  GetDemodSignal,
  GetDemodPhase,
  GetDemodPhasReg,
  GetDemodHarmonic,
  GetDemodLPFilter,
  GetDemodHPFilter,
  SetModSignal,
  SetModPhasReg,
  SetModHarmonic,
  SetDemodSyncFilter,
  SetDemodRTSignals,
}
