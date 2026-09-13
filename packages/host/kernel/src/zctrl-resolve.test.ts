/**
 * `resolvePreset` 的四路 —— 15 格逐条对旧仓。
 *
 * 每一路的**拒绝报文都是「去哪儿改」的指路牌**，所以判据落在文案上，不只落在
 * 「拒了没有」。一句指错路的报错比没有更坏。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_TIERS, tierNames } from './scan-policy.js'
import {
  PresetRejected,
  availableNames,
  resolvePreset,
  type ApproachProfile,
  type StoredPreset,
} from './zctrl-preset.js'

interface ResolveCase {
  name: string
  frame_size_m: number | null
  has_profile: boolean
  preset_names: string[]
  ok?: boolean
  resolved_name?: string
  p_gain?: number
  i_gain?: number
  time_constant_s?: number
  setpoint_a?: number | null
  sources?: Record<string, string>
  notes?: string[]
  trace_lines?: string[]
  gain_params?: Record<string, number>
  error: string
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/zctrl_presets.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    tier_names: string[]
    factory_tier_gains: {
      name: string
      p_gain: number | null
      time_constant_s: number | null
      setpoint_a: number | null
    }[]
  }
  resolve: Record<string, ResolveCase>
  available_names: Record<string, string[]>
}

/** 导出脚本里那两组自定义参数，按名字还原。 */
const CUSTOM: Readonly<Record<string, StoredPreset>> = {
  gentle: { name: 'gentle', p_gain: '3p', i_gain: '180n' },
  firm: {
    name: 'firm',
    p_gain: '5p',
    i_gain: '200n',
    setpoint_a: '150p',
    note: '带设定点的一组',
  },
}

/** 导出脚本里那三份仪器档案。`has_profile` 为假就是没配。 */
function profileFor(c: ResolveCase): ApproachProfile | null {
  if (!c.has_profile) return null
  // 三格分别是：全配、无设定点、只配了一半
  if (c.error.includes('I 增益 为空')) return { pGainM: 3e-12, iGainMPerS: null, setpointA: null }
  if (c.setpoint_a === null) return { pGainM: 3e-12, iGainMPerS: 180e-9, setpointA: null }
  return { pGainM: 3e-12, iGainMPerS: 180e-9, setpointA: 50e-12 }
}

describe('出厂档位表**不带增益** —— 这不是没接线，是没配就该拒', () => {
  it('六档的 p_gain / time_constant_s / setpoint_a 全空，与旧仓一致', () => {
    expect(tierNames()).toEqual(golden.constants.tier_names)
    for (const t of golden.constants.factory_tier_gains) {
      const ours = FACTORY_TIERS.find((x) => x.name === t.name)
      expect(ours, t.name).toBeDefined()
      expect(t.p_gain).toBeNull()
      expect(ours?.pGain).toBeUndefined()
      expect(ours?.timeConstantS).toBeUndefined()
      expect(ours?.setpointA).toBeUndefined()
    }
  })
})

describe('resolvePreset —— 15 格逐条对旧仓', () => {
  for (const [key, c] of Object.entries(golden.resolve)) {
    it(key, () => {
      const presets = c.preset_names.map((n) => CUSTOM[n] as StoredPreset)
      const src = {
        presets,
        approach: profileFor(c),
        frameSizeM: c.frame_size_m,
      }
      if (c.ok !== true) {
        expect(() => resolvePreset(c.name, src)).toThrow(PresetRejected)
        try {
          resolvePreset(c.name, src)
        } catch (e) {
          expect((e as Error).message).toBe(c.error)
        }
        return
      }
      const r = resolvePreset(c.name, src)
      expect(r.name).toBe(c.resolved_name)
      expect(r.pGain).toBe(c.p_gain)
      expect(r.iGain).toBe(c.i_gain)
      expect(r.timeConstantS).toBe(c.time_constant_s)
      expect(r.setpointA).toBe(c.setpoint_a)
      expect(r.sources).toEqual(c.sources)
      expect([...r.notes]).toEqual(c.notes)
      expect(r.traceLines()).toEqual(c.trace_lines)
      expect(r.gainParams()).toEqual(c.gain_params)
    })
  }
})

describe('availableNames', () => {
  it('两个保留名 + 六档 + 自定义组，保序去重', () => {
    expect(availableNames([])).toEqual(golden.available_names['empty'])
    expect(availableNames([CUSTOM['gentle']!, CUSTOM['firm']!])).toEqual(
      golden.available_names['with_two_customs'],
    )
  })

  it('自定义组与档名同名时只出现一次 —— 但这本来就建不出来', () => {
    // `sanitizePreset` 在建的时候就拒了档名重名。这里钉的是**万一**存储里
    // 混进了一个（旧版本留下的、手工改的配置文件），列表也不会出现两行。
    const shadow = { name: 'HIGHRES', p_gain: '3p', i_gain: '180n' } as StoredPreset
    const names = availableNames([shadow])
    expect(names.filter((n) => n.toLowerCase() === 'highres')).toHaveLength(1)
  })
})

describe('几条自己的边界', () => {
  it('`scan` 读不到帧宽就拒 —— 读不到不是挑一档', () => {
    for (const bad of [null, undefined, Number.NaN, Infinity]) {
      expect(() => resolvePreset('scan', { frameSizeM: bad as number })).toThrow(
        /读不到当前扫描帧的尺寸/,
      )
    }
  })

  it('名字两边的空白不算数', () => {
    const r = resolvePreset('  gentle  ', { presets: [CUSTOM['gentle']!] })
    expect(r.name).toBe('gentle')
  })

  it('时间常数是**算**出来的，不是存的', () => {
    const r = resolvePreset('gentle', { presets: [CUSTOM['gentle']!] })
    expect(r.timeConstantS).toBe(r.pGain / r.iGain)
  })

  it('`gainParams()` 就是 `SetZCtrlGain` 的入参 —— 顺序只在这一处', () => {
    const r = resolvePreset('firm', { presets: [CUSTOM['firm']!] })
    expect(Object.keys(r.gainParams())).toEqual(['p_gain', 'time_constant_s', 'i_gain'])
  })
})
