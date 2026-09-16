/**
 * 起伏门与它的阈值表 —— 对 `spec/golden/analysis.json` 的 `corrugation_gate` 一节
 * 逐格比对。
 *
 * 这一件**零 numpy**（旧仓那份 259 行连 numpy 都没 import），所以这里**没有容差**：
 * 输入的那几个数原样进来，出去的是一个四态词与一句话。
 * 一句话里印着 `%.1f` / `%g` / `%.0%` 的数，于是**逐字相等**顺带把那几位钉住了。
 *
 * ## 判定顺序本身是判据
 *
 * ```
 * 帧不可用 → 尺度不匹配 → 无阈值 → low → high → normal
 * ```
 *
 * 四个 `undecidable` 的成因指向**不同的下一步**（换地方重扫 / 换视野重扫 / 去标定），
 * 而顺序决定了同时缺两样时说哪一句。金样里 `no_threshold_no_ref` 与
 * `ref_without_threshold` 两格分的正是这件事。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { judgeCorrugation, lowGate, resolveThresholdPair, type FrameUsability } from './corrugation-gate.js'
import {
  DEFAULT_SCAN_PREP_PROFILE,
  availableScanPrepProfiles,
  resolveScanPrepThresholds,
  scanPrepProfiles,
} from './scan-prep-thresholds.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/analysis.json', import.meta.url)), 'utf8'),
) as Record<string, any>

describe('judgeCorrugation —— 逐格对旧仓（容差 0）', () => {
  for (const c of GOLDEN['corrugation_gate'] as any[]) {
    it(c.key as string, () => {
      const vin = c.verdict_in as { usable: boolean; reason: string; corrugation_rms_m: number | null }
      const verdict: FrameUsability = {
        usable: vin.usable,
        reason: vin.reason,
        corrugationRmsM: vin.corrugation_rms_m,
      }
      const kw = c.kwargs as Record<string, unknown>
      const got = judgeCorrugation(verdict, {
        thresholdPm: (kw['threshold_pm'] ?? null) as number | null,
        refScanNm: (kw['ref_scan_nm'] ?? null) as number | null,
        thisScanNm: (kw['this_scan_nm'] ?? null) as number | null,
        ...(kw['rel_tol'] !== undefined ? { relTol: kw['rel_tol'] as number } : {}),
        ...(kw['profile_name'] !== undefined ? { profileName: kw['profile_name'] as string } : {}),
        ...(kw['provenance'] !== undefined ? { provenance: kw['provenance'] as string } : {}),
      })
      expect(got).toEqual(c.result)
    })
  }

  it('`low` 用的是**判据①那个对象**，不是抄过来的 15e-12', () => {
    // 旧仓刻意做成一个取值函数：这里一旦写下 `15e-12`，仓里就有了第二个下限，
    // 而两个下限迟早不一样。本仓做成注入点 —— 改了它，那一档跟着动。
    const before = lowGate.m
    try {
      lowGate.m = 1e-12
      const v = judgeCorrugation({ usable: true, reason: '', corrugationRmsM: 9e-12 }, {
        thresholdPm: 40, refScanNm: 100, thisScanNm: 100,
      })
      expect(v.verdict).toBe('normal') // 9 pm 现在**高于**那道门了
    } finally {
      lowGate.m = before
    }
  })
})

describe('resolveThresholdPair —— 阈值与它的视野同源', () => {
  const profile = { name: 'p', corrugationHighPm: 40, corrugationRefScanNm: 100 }

  it('两个都没给 ⇒ 走 profile 的那一对', () => {
    expect(resolveThresholdPair(null, null, profile)).toEqual({
      thresholdPm: 40, refScanNm: 100, source: 'profile:p',
    })
  })

  it('给了阈值 ⇒ **缺的那半留 null**，绝不用 profile 去补', () => {
    expect(resolveThresholdPair(400, null, profile)).toEqual({
      thresholdPm: 400, refScanNm: null, source: 'explicit',
    })
  })

  it('给了视野 ⇒ 同上（反方向）', () => {
    expect(resolveThresholdPair(null, 10, profile)).toEqual({
      thresholdPm: null, refScanNm: 10, source: 'explicit',
    })
  })

  it('profile 没名字时 source 是 `profile:?`', () => {
    expect(resolveThresholdPair(null, null, {}).source).toBe('profile:?')
  })
})

describe('scan-prep profile', () => {
  it('内建那一套的起伏门**出厂就是判不了**', () => {
    const th = resolveScanPrepThresholds(null)
    expect([th.name, th.corrugationHighPm, th.corrugationRefScanNm]).toEqual([
      DEFAULT_SCAN_PREP_PROFILE, null, null,
    ])
  })

  it('名字不认识 ⇒ 回落到默认，**并把这件事写进 provenance**', () => {
    const th = resolveScanPrepThresholds('no-such-profile')
    expect(th.name).toBe(DEFAULT_SCAN_PREP_PROFILE)
    expect(th.provenance.startsWith("(请求的 profile 'no-such-profile' 不存在,已回落到")).toBe(true)
  })

  it('外部 profile 同名覆盖内建', () => {
    const saved = { ...scanPrepProfiles.external }
    try {
      scanPrepProfiles.external[DEFAULT_SCAN_PREP_PROFILE] = {
        name: DEFAULT_SCAN_PREP_PROFILE, provenance: '外部的', corrugationHighPm: 7, corrugationRefScanNm: 8,
      }
      expect(resolveScanPrepThresholds(null).corrugationHighPm).toBe(7)
      expect(availableScanPrepProfiles()[DEFAULT_SCAN_PREP_PROFILE]).toBe('外部的')
    } finally {
      for (const k of Object.keys(scanPrepProfiles.external)) delete scanPrepProfiles.external[k]
      Object.assign(scanPrepProfiles.external, saved)
    }
  })
})
