/**
 * 频谱分析仪（`SpectrumAnlzr_*`）—— **图为什么噪**是在这儿问出来的。
 *
 * 把任意一路信号的噪声谱摆出来，于是「这张图不对」能变成一个可查的原因：
 *
 * | 看到什么 | 是什么 |
 * |---|---|
 * | 50 Hz 及其谐波上的峰 | 市电串入、地环路 |
 * | 几百赫兹处宽缓的鼓包 | 楼体 / 隔振台 |
 * | 朝 DC 抬起 | 漂移、热 |
 * | 单纯太高的平本底 | 前放、增益、走线 |
 *
 * ## 三项配置决定这条谱值不值得看
 *
 * 旧仓一直能**读**谱、配不了分析仪：窗、平均、AC 耦合全没包出来。于是 agent 看着一条
 * 它没有办法让它可信的谱——没平均（每个峰都是巧合）、矩形窗（每个峰都被抹开）、
 * DC 耦合（有意思的几个数量级压在偏置底下）。
 *
 * ## `band_rms` 才是「到底有多少噪声」那一个数
 *
 * 一张图回答不了「反馈环实际要与之共处的噪声有多大」。那一对游标框出的频段 RMS
 * 回答得了，所以先 `SetSpectrumAnalyzerBand`，再读 `GetSpectrumAnalyzerData.band_rms`。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { formatG } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { cell, fail, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/**
 * 分析仪实例号。**Nanonis 从 1 开始数**，所以 0 不是一个实例号而是一个没填 ——
 * 这一个位置上把 0 顶成 1 是对的。
 */
const inst = (p: Readonly<Record<string, unknown>>): number =>
  typeof p['instance'] === 'number' && p['instance'] >= 1 ? Math.trunc(p['instance']) : 1

/**
 * 一个整数配置项。**`0` 是一个值，不是「没给」**（D-ZERO-1）。
 *
 * 旧仓这四项写的是 `int(params.get(k, d) or d)`，而 `0 or d` 在 Python 里是 `d` ——
 * 于是 `fft_window=0`（**矩形窗**，描述里明写着的那个值）和 `averaging_mode=0`
 * （**不平均**）两个都下发不出去，调用方却以为下发了。
 *
 * 这与批 3d 那条「幅度 0 要写得下去」是同一个形状**第二次**出现：一个合法的 0 被
 * 一个图省事的默认值写法吃掉，而症状是「我选了矩形窗，谱看起来像加了窗」——
 * 图上看不出任何错。
 */
const intParam = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/** 框出 band RMS 的那一对游标。`CursorPosSet/Get` 的 `Cursor_type`。 */
const CURSOR_BAND = 0

export const ConfigureSpectrumAnalyzer: Skill = {
  spec: S.ConfigureSpectrumAnalyzerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const i = inst(params)
    const window = intParam(params, 'fft_window', 1)
    const avgMode = intParam(params, 'averaging_mode', 1)
    const weighting = intParam(params, 'weighting_mode', 0)
    const count = intParam(params, 'averaging_count', 20)
    const ac = params['ac_coupling'] !== false

    let rec = await ctx.safeCall('SpectrumAnlzr_FFTWindowSet', i, window)
    if (failed(rec)) return fail(`SpectrumAnlzr_FFTWindowSet failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('SpectrumAnlzr_AveragSet', i, avgMode, weighting, count)
    if (failed(rec)) return fail(`SpectrumAnlzr_AveragSet failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('SpectrumAnlzr_ACCouplingSet', i, ac ? 1 : 0)
    if (failed(rec)) return fail(`SpectrumAnlzr_ACCouplingSet failed: ${rec.error ?? ''}`)

    return ok(
      { instance: i, averaging_count: count, ac_coupling: ac },
      `频谱分析仪 #${i} 已配置：平均 ${count} 次，${ac ? 'AC' : 'DC'} 耦合`,
    )
  },
}

export const SetSpectrumAnalyzerBand: Skill = {
  spec: S.SetSpectrumAnalyzerBandSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const lo = typeof params['f_low_hz'] === 'number' ? params['f_low_hz'] : 0
    const hi = typeof params['f_high_hz'] === 'number' ? params['f_high_hz'] : 0
    // **拒，不换过来**：一个「反过来的频段」多半是调用方把两个数搞混了，
    // 而悄悄换过来会让下一个 band_rms 报的是一个谁也没要的频段里的噪声。
    // 与 `RunBiasSweep` 的限值刻意不同——那边换过来是对的，见那边的注释。
    if (lo >= hi) {
      return fail(`f_low_hz (${formatG(lo, 6)}) 必须小于 f_high_hz (${formatG(hi, 6)})`)
    }
    const i = inst(params)
    const rec = await ctx.safeCall('SpectrumAnlzr_CursorPosSet', i, CURSOR_BAND, lo, hi)
    if (failed(rec)) return fail(`SpectrumAnlzr_CursorPosSet failed: ${rec.error ?? ''}`)
    return ok(
      { instance: i, f_low_hz: lo, f_high_hz: hi },
      `频谱 RMS 频带 = [${formatG(lo, 6)}, ${formatG(hi, 6)}] Hz`,
    )
  },
}

/**
 * 谱、band RMS、DC 值，以及**当前设置** —— 后者是为了让读的人判断这条谱可不可信。
 *
 * 六个读各自独立：**读不到的那一格给 `null`**，别的照样交出去。技能永远 `success`
 * ——它报的是「问到了什么」，而一个问不到 `averaging` 的谱仍然是一条谱。
 *
 * 动词写成字面量：本仓每一件安全工具（中止策略核对、安全审计、API 覆盖清点）
 * 都靠 grep `safeCall('…')` 找 Nanonis 调用，藏在变量后面的动词对它们全都不可见。
 */
export const GetSpectrumAnalyzerData: Skill = {
  spec: S.GetSpectrumAnalyzerDataSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const i = inst(params)
    const data: Record<string, unknown> = { instance: i }
    for (const [key, thunk] of [
      ['band_rms', (): Promise<SkillCallRecord> => ctx.safeCall('SpectrumAnlzr_BandRMSGet', i)],
      ['dc', (): Promise<SkillCallRecord> => ctx.safeCall('SpectrumAnlzr_DCGet', i)],
      ['band', (): Promise<SkillCallRecord> => ctx.safeCall('SpectrumAnlzr_CursorPosGet', i, CURSOR_BAND)],
      ['averaging', (): Promise<SkillCallRecord> => ctx.safeCall('SpectrumAnlzr_AveragGet', i)],
      ['fft_window', (): Promise<SkillCallRecord> => ctx.safeCall('SpectrumAnlzr_FFTWindowGet', i)],
      ['ac_coupling', (): Promise<SkillCallRecord> => ctx.safeCall('SpectrumAnlzr_ACCouplingGet', i)],
    ] as const) {
      const rec = await thunk()
      data[key] = failed(rec) ? null : cell(rec)
    }
    return ok(data)
  },
}

export const SPECTRUM: Readonly<Record<string, Skill>> = {
  ConfigureSpectrumAnalyzer,
  SetSpectrumAnalyzerBand,
  GetSpectrumAnalyzerData,
}
