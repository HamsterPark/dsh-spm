/**
 * Lock-in 参数组的解析 —— **没配就拒，绝不编一个数出来**。
 *
 * 与 `zctrl-resolve.test.ts` 同一条纪律：一台仪器的 dI/dV 调制幅度不可能有出厂默认，
 * 而 20 mV 的调制是一次**真实的物理动作**，加在谁也没确认过的隧道结上。
 */
import { describe, expect, it } from 'vitest'
import {
  LOCKIN_PHASE_NOTE,
  LOCKIN_READBACK_KEYS,
  PRESET_DIDV,
  PresetRejected,
  listLockInPresets,
  resolveLockInPreset,
  type LockInProfile,
} from './index.js'

const FULL: LockInProfile = {
  modFreqHz: 973.0,
  modAmpV: 0.02,
  xSignalIndex: 86,
  ySignalIndex: 87,
}
const EMPTY: LockInProfile = {
  modFreqHz: null,
  modAmpV: null,
  xSignalIndex: null,
  ySignalIndex: null,
}

describe('resolveLockInPreset', () => {
  it('组名认得出，**未知组名直接拒**（不猜）', () => {
    expect(resolveLockInPreset(PRESET_DIDV, FULL).name).toBe('didv')
    expect(resolveLockInPreset('DIDV', FULL).name).toBe('didv') // 大小写不敏感
    expect(() => resolveLockInPreset('iv', FULL)).toThrow(PresetRejected)
    expect(() => resolveLockInPreset('iv', FULL)).toThrow(
      "没有名为 'iv' 的 lock-in 参数组;目前只有 didv。",
    )
  })

  it('配好了：两个值都下发，**每个数说清自己从哪儿来**', () => {
    const r = resolveLockInPreset(PRESET_DIDV, FULL)
    expect(r.values).toEqual({ frequency_hz: 973, amplitude_v: 0.02 })
    expect(r.sources).toEqual({
      frequency_hz: '仪器档案 lockin_mod_freq_hz',
      amplitude_v: '仪器档案 lockin_mod_amp_v',
    })
    expect(r.unset).toEqual([])
    expect(r.usable).toBe(true)
    expect(r.why()).toBe('将下发 frequency_hz=973.0、amplitude_v=0.02')
  })

  it('`why()` 里的数用 **Python 的 `str(float)`** —— `973.0` 不是 `973`', () => {
    // JS 的 `String(973.0)` 给 `'973'`。这句话是印给人看的，而操作员要拿它和
    // 面板上的数比。
    expect(resolveLockInPreset(PRESET_DIDV, FULL).why()).toContain('973.0')
  })

  it('**一个都没配**：可解析、但 `usable: false`，并说去哪儿填', () => {
    // 「这台机器还没配 lock-in」是一个**答案**，不是一次异常 ——
    // `ListLockInPresets` 要把它连同指路一起报出来。
    const r = resolveLockInPreset(PRESET_DIDV, EMPTY)
    expect(r.usable).toBe(false)
    expect(r.values).toEqual({})
    expect(r.unset).toEqual(['lockin_mod_freq_hz', 'lockin_mod_amp_v'])
    expect(r.why()).toBe(
      '仪器档案里这一组一个值都没有配置(lockin_mod_freq_hz、lockin_mod_amp_v)。' +
        '请在「设置 → 仪器档案 → lock-in」里填写 —— 这组数只由用户输入,不经模型。',
    )
  })

  it('档案整个没接 ⇒ 与「一个都没填」同义', () => {
    expect(resolveLockInPreset(PRESET_DIDV, null).usable).toBe(false)
    expect(resolveLockInPreset().usable).toBe(false)
  })

  it('只配了一半：**填了的下发，没填的连键名都不出现**', () => {
    const r = resolveLockInPreset(PRESET_DIDV, { ...EMPTY, modAmpV: 0.02 })
    expect(r.values).toEqual({ amplitude_v: 0.02 })
    expect(r.skillParams()).toEqual({ mod_on: true, amplitude_v: 0.02 })
    expect(Object.keys(r.skillParams())).not.toContain('frequency_hz')
    expect(r.why()).toBe('将下发 amplitude_v=0.02;档案未填、因而不下发:lockin_mod_freq_hz')
  })

  it('NaN / Infinity 按**没配**处理 —— 一个不是数的数不该下发', () => {
    expect(resolveLockInPreset(PRESET_DIDV, { ...EMPTY, modAmpV: NaN }).usable).toBe(false)
    expect(resolveLockInPreset(PRESET_DIDV, { ...EMPTY, modFreqHz: Infinity }).unset).toEqual([
      'lockin_mod_freq_hz',
      'lockin_mod_amp_v',
    ])
  })

  it('`0` 是一个值，不是「没填」', () => {
    // 幅度 0 = 「开之前先把它变安全」。把它当成未配置，就是让那件事做不到。
    const r = resolveLockInPreset(PRESET_DIDV, { ...EMPTY, modAmpV: 0 })
    expect(r.values).toEqual({ amplitude_v: 0 })
    expect(r.usable).toBe(true)
  })
})

describe('skillParams / asDict —— 调制侧 phase 永不出现', () => {
  it('`phase_deg` 不在下发参数里（D-LOCKIN-1）', () => {
    const p = resolveLockInPreset(PRESET_DIDV, FULL).skillParams()
    expect('phase_deg' in p).toBe(false)
  })

  it('但 `asDict` 里**明说**它是 `null`，免得有人以为是漏了', () => {
    const d = resolveLockInPreset(PRESET_DIDV, FULL).asDict()
    expect(d['phase_deg']).toBeNull()
    expect(d['phase_note']).toBe(LOCKIN_PHASE_NOTE)
    expect(String(d['phase_note'])).toContain('写同值也拒')
  })

  it('`mod_on` 跟着调用方走', () => {
    expect(resolveLockInPreset(PRESET_DIDV, FULL).skillParams(false)['mod_on']).toBe(false)
  })
})

describe('listLockInPresets', () => {
  it('保留组只有 didv 一个，配没配都在表里', () => {
    for (const profile of [FULL, EMPTY, null]) {
      const rows = listLockInPresets(profile)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.['name']).toBe('didv')
      expect(typeof rows[0]?.['why']).toBe('string')
    }
  })
})

describe('回读键名', () => {
  it('**两边不同名** —— 缺陷⑩ 就在这条缝上', () => {
    expect(LOCKIN_READBACK_KEYS).toEqual({
      frequency_hz: 'frequency_hz',
      amplitude_v: 'amplitude',
    })
  })
})
