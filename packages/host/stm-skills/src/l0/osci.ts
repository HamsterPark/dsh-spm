/**
 * Nanonis 的 1 通道示波器（`Osci1T_*`）—— 按**硬件 RT 速率**取一段缓冲时间序列。
 *
 * 板上按 RT 环速率（V5e 上 ~20 kHz）录进缓冲区，然后一次 TCP 调用把整个缓冲区交出来。
 * 端到端延迟因此由**缓冲区长度**决定，不由 TCP 往返决定。
 *
 * ## `NeedModule` 是配置问题，不是线路故障
 *
 * 这三个技能都要求 Nanonis 里已经**加载了** Osci1T 模块（自带的模拟器默认没有）。
 * 描述里带 `NeedModule` 的错与「连接被对端关闭」的处置**完全相反**：前者重连一百次
 * 也没用，该做的是告诉操作员去打开那个模块（或者改走 `CaptureSignalBuffer` 的
 * 轮询快路）；后者才该重连并计入熔断。
 *
 * 所以 `Osci1T_Run` 的错分两种走法，而**不带 `NeedModule` 的错继续往下跑** ——
 * `Run` 是幂等的启动，它失败不代表取不到数。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { isNeedModule } from 'dsh-spm-nanonis-wire'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/** 模块没装吗。**只有这一种错**走「去打开模块」那条路。 */
function needsModule(rec: SkillCallRecord): boolean {
  return failed(rec) && isNeedModule(rec.error ?? '')
}

/**
 * 一个数，取不出给 `null`。
 *
 * `*d` 的元素在协议的两种形态下可能是裸数、也可能裹成 1-元素包，两种都接。
 */
function oneNumber(v: unknown): number | null {
  const x = Array.isArray(v) && v.length === 1 ? v[0] : v
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

/**
 * 一整条采样。有一个点取不出就整条作废（`null`）。
 *
 * 严格是因为**一条中间掉了几个点的时间序列，形状看起来完全正常**：
 * 后面每一次 FFT、每一个峰位都按等间隔采样算，而它已经不是等间隔的了。
 */
function samplesOf(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null
  const out: number[] = []
  for (const item of v) {
    const x = oneNumber(item)
    if (x === null) return null
    out.push(x)
  }
  return out
}

export const AcquireOsciTrace: Skill = {
  spec: S.AcquireOsciTraceSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const dataToGet = typeof params['data_to_get'] === 'number' ? params['data_to_get'] : 0
    const signalIndex = typeof params['signal_index'] === 'number' ? params['signal_index'] : -1

    const recRun = await ctx.safeCall('Osci1T_Run')
    if (needsModule(recRun)) {
      return fail(
        'Osci1T module is not loaded in this Nanonis configuration. On the bundled ' +
          'simulator try the v2 config that includes the Oscilloscope module, or fall ' +
          'back to CaptureSignalBuffer for a polled-rate trace.',
      )
    }

    // 通道是**可选**的赋值：`-1 = 保持现有`。它失败不该让取数失败——
    // 保持现有通道取到的仍然是一条真的曲线，只是不是你点的那一路。
    if (signalIndex >= 0) await ctx.safeCall('Osci1T_ChSet', signalIndex)

    const rec = await ctx.safeCall('Osci1T_DataGet', dataToGet)
    if (failed(rec)) return fail(`Osci1T_DataGet failed: ${rec.error ?? ''}`)

    // 布局：t0 (float64) + dt (float64) + n (int32) + n×float64
    const d = body(rec)
    if (d.length < 4) return fail(`Unexpected response shape: ${d.length} fields`)
    const t0 = oneNumber(d[0])
    const dt = oneNumber(d[1])
    const n = oneNumber(d[2])
    const samples = samplesOf(d[3])
    if (t0 === null || dt === null || n === null || samples === null) {
      // D-OSCI-1：旧仓这里印的是 Python 异常的 repr，复刻不了也不值得复刻 ——
      // 模型要的信息是「这个回包解不开」，而哪一个字段解不开才是可执行的部分。
      return fail(
        'Decode error: 回包的四个字段里有解不开的 —— ' +
          `t0=${t0 === null ? '解不开' : 'ok'}, dt=${dt === null ? '解不开' : 'ok'}, ` +
          `n=${n === null ? '解不开' : 'ok'}, samples=${samples === null ? '解不开' : 'ok'}。`,
      )
    }

    const nSamples = Math.trunc(n)
    const fs = dt > 0 ? 1.0 / dt : 0.0
    return ok({
      t0_s: t0,
      dt_s: dt,
      n_samples: nSamples,
      duration_s: nSamples * dt,
      fs_hz: fs,
      nyquist_hz: fs / 2.0,
      samples,
      source: 'nanonis_osci1t',
    })
  },
}

export const GetOsciTimebases: Skill = {
  spec: S.GetOsciTimebasesSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    // 先把模块跑起来，时基表才是填好的。
    const recRun = await ctx.safeCall('Osci1T_Run')
    if (needsModule(recRun)) {
      return fail(
        'Osci1T module is not loaded in this Nanonis configuration — no hardware ' +
          'timebases to list. Use the polled fast-path (CaptureSignalBuffer) and its ' +
          'poll_hz knob to choose a sample rate instead.',
      )
    }
    const rec = await ctx.safeCall('Osci1T_TimebaseGet')
    if (failed(rec)) return fail(`Osci1T_TimebaseGet failed: ${rec.error ?? ''}`)

    // `returns = ["i", "i", "*f"]` → [当前档位下标, 档位数, 每档的 dt（秒）]
    const d = body(rec)
    if (d.length < 3 || !Array.isArray(d[2])) {
      return fail(`Unexpected TimebaseGet shape: ${JSON.stringify(d)}`)
    }
    const currentIndex = oneNumber(d[0])
    const dts = samplesOf(d[2])
    if (currentIndex === null || dts === null) {
      return fail('Decode error: 时基表里有解不开的项。')
    }
    return ok({
      timebases: dts.map((dt, i) => ({ index: i, dt_s: dt, fs_hz: dt > 0 ? 1.0 / dt : 0.0 })),
      n_timebases: dts.length,
      current_index: Math.trunc(currentIndex),
    })
  },
}

export const SetOsciTimebase: Skill = {
  spec: S.SetOsciTimebaseSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = typeof params['timebase_index'] === 'number' ? Math.trunc(params['timebase_index']) : 0
    const recRun = await ctx.safeCall('Osci1T_Run')
    if (needsModule(recRun)) {
      return fail(
        'Osci1T module is not loaded in this Nanonis configuration — cannot set a ' +
          'hardware timebase.',
      )
    }
    const rec = await ctx.safeCall('Osci1T_TimebaseSet', idx)
    if (failed(rec)) return fail(`Osci1T_TimebaseSet failed: ${rec.error ?? ''}`)
    return ok({ timebase_index: idx })
  },
}

export const OSCI: Readonly<Record<string, Skill>> = {
  AcquireOsciTrace,
  GetOsciTimebases,
  SetOsciTimebase,
}
