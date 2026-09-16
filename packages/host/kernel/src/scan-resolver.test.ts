/**
 * `resolveScan` 对 `spec/golden/scan_resolver.json` 逐格比。
 *
 * 金样由旧仓真实的 `resolve_scan` 录制（`tools/spec-export/export_scan_resolver.py`），
 * 断言的是**整个 `trace` 逐键逐字** —— 优先级链的产物是「谁赢了」，不是最终那几个数。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CLAMP_BOUNDS,
  DEFAULT_V_TIP_MAX,
  FACTORY_LOOKUP,
  PURPOSE_AUTO,
  SOURCE_DEFAULT,
  SOURCE_EXPLICIT,
  SOURCE_INTENT,
  SOURCE_KEEP,
  SOURCE_PREFS,
  SOURCE_PREFS_DERIVED,
  SOURCE_TIER_FACTORY,
  SOURCE_TIER_OPERATOR,
  pyNum,
  resolveScan,
  summaryLines,
  waitBudgetS,
  type ResolverTier,
  type TierLookup,
} from './scan-resolver.js'

interface GoldenTier {
  name: string
  upper_size_m: number | null
  pixels: number
  line_time_s: number
  setpoint_a: number | null
  p_gain: number | null
  time_constant_s: number | null
  source: string
  _factory_filled: string[]
}

interface GoldenCase {
  intent: {
    center_x_m: number
    center_y_m: number
    size_m: unknown
    purpose: unknown
    explicit: Record<string, unknown>
  }
  prefs: Record<string, unknown>
  v_tip_max_m_s: number
  tiers: 'factory' | 'operator' | 'broken_pi'
  resolved?: {
    tier_name: string
    configure_scan: Record<string, unknown>
    set_scan_buffer: { pixels: number; lines: number }
    set_setpoint: { setpoint_a: number } | null
    set_bias: { bias_v: number } | null
    set_zctrl_gain: { p_gain: number; time_constant_s: number; i_gain: number } | null
    trace: Record<string, { value: unknown; source: string; tier: string | null; human: string | null }>
    warnings: string[]
    estimated_scan_s: number
    summary: string[]
  }
  raised?: { type: string; text: string }
}

const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/scan_resolver.json', import.meta.url)), 'utf8'),
) as {
  constants: {
    clamp: Record<string, [number, number]>
    default_v_tip_max: number
    purpose_auto: string
    atomic_tiers: string[]
    atomic_working_point: { bias_v: number; setpoint_a: number }
    sources: Record<string, string>
    wait_headroom_frac: number
    wait_headroom_s: number
  }
  operator_tiers: GoldenTier[]
  broken_pi_tiers: GoldenTier[]
  wait_budget: { estimated_scan_s: unknown; floor_s: number; budget_s: number }[]
  cases: Record<string, GoldenCase>
}

/** 金样里那张档位表 → 本仓的查表口。 */
function lookupOf(tiers: GoldenTier[]): TierLookup {
  const conv = (t: GoldenTier): ResolverTier => ({
    name: t.name,
    upperSizeM: t.upper_size_m,
    pixels: t.pixels,
    lineTimeS: t.line_time_s,
    ...(t.setpoint_a === null ? {} : { setpointA: t.setpoint_a }),
    ...(t.p_gain === null ? {} : { pGain: t.p_gain }),
    ...(t.time_constant_s === null ? {} : { timeConstantS: t.time_constant_s }),
    source: t.source === 'operator' ? 'operator' : 'factory',
    factoryFilled: t._factory_filled,
  })
  const list = tiers.map(conv)
  return {
    tierForSize: (sizeM) => {
      const size = Number.isFinite(sizeM) ? sizeM : 0
      for (const t of list) {
        if (t.upperSizeM === null) return t
        if (size <= t.upperSizeM * (1 + 1e-9)) return t
      }
      return list[list.length - 1] as ResolverTier
    },
    tierByName: (name) => list.find((t) => t.name.toLowerCase() === name.trim().toLowerCase()) ?? null,
    tierNames: () => list.map((t) => t.name),
  }
}

const LOOKUPS: Record<GoldenCase['tiers'], TierLookup> = {
  factory: FACTORY_LOOKUP,
  operator: lookupOf(G.operator_tiers),
  broken_pi: lookupOf(G.broken_pi_tiers),
}

/** `<nan>` 是导出脚本给 NaN 的替身（`allow_nan=False` 进不了 JSON）。 */
function unmarshalSize(v: unknown): unknown {
  return v === '<nan>' ? Number.NaN : v
}

/**
 * 旧仓 **TypeError** 的那几格不逐字比 —— 它抛的是缺陷不是规格（见批 4d 的登记）。
 * 本仓在这几格给一个值，那个值由下面 `TypeError 的那四格` 那一组单独钉。
 */
const PY_CRASHES = new Set(
  Object.entries(G.cases)
    .filter(([, c]) => c.raised?.type === 'TypeError')
    .map(([k]) => k),
)

describe('resolveScan · 金样逐格', () => {
  it('金样里确实有那四格 Python 崩掉的', () => {
    expect([...PY_CRASHES].sort()).toEqual([
      'unparsable_angle_falls_to_keep',
      'unparsable_bias_is_not_sent',
      'unparsable_line_time_falls_to_default',
      'unparsable_prefs_speed_falls_to_tier',
    ])
  })

  for (const [name, c] of Object.entries(G.cases)) {
    if (PY_CRASHES.has(name)) continue
    it(name, () => {
      const run = (): ReturnType<typeof resolveScan> =>
        resolveScan(
          {
            centerXM: c.intent.center_x_m,
            centerYM: c.intent.center_y_m,
            sizeM: unmarshalSize(c.intent.size_m),
            purpose: c.intent.purpose,
            explicit: c.intent.explicit,
          },
          { tiers: LOOKUPS[c.tiers], prefs: c.prefs, vTipMaxMS: c.v_tip_max_m_s },
        )

      if (c.raised !== undefined) {
        expect(c.raised.type).toBe('ValueError')
        expect(run).toThrow(c.raised.text)
        return
      }
      const r = run()
      const want = c.resolved!
      expect(r.tierName).toBe(want.tier_name)
      expect(r.configureScan).toEqual(want.configure_scan)
      expect(r.setScanBuffer).toEqual(want.set_scan_buffer)
      expect(r.setSetpoint).toEqual(want.set_setpoint)
      expect(r.setBias).toEqual(want.set_bias)
      expect(r.setZctrlGain).toEqual(want.set_zctrl_gain)
      expect(r.warnings).toEqual(want.warnings)
      expect(r.estimatedScanS).toBe(want.estimated_scan_s)
      // trace 逐键逐字。**顺序不在这一行比** —— 导出脚本的 `sort_keys=True` 已经把
      // JSON 里的键排过序了。真正钉住插入序的是下面那句 `summary`：它是一个**列表**，
      // 而 `summary_lines` 正是按插入序生成的。
      expect(Object.keys(r.trace).sort()).toEqual(Object.keys(want.trace).sort())
      for (const [k, v] of Object.entries(want.trace)) {
        const got = r.trace[k]!
        expect({ key: k, value: got.value, source: got.source, tier: got.tier, human: got.human }).toEqual({
          key: k,
          value: v.value,
          source: v.source,
          tier: v.tier,
          human: v.human,
        })
      }
      // `None` → `null` 沿用 D-SCAN-5：期望值**从金样算出来**（一个 `.replace`），
      // 不是抄一遍 —— 旧仓哪天改了这句话，这里会跟着变，不会悄悄过期。
      expect(summaryLines(r)).toEqual(want.summary.map((s) => s.replace(' = None ←', ' = null ←')))
    })
  }
})

describe('常数与旧仓一致', () => {
  it('clamp 表逐项', () => {
    expect(Object.fromEntries(Object.entries(CLAMP_BOUNDS).map(([k, v]) => [k, [...v]]))).toEqual(
      G.constants.clamp,
    )
  })

  it('针尖速度兜底上限', () => {
    expect(DEFAULT_V_TIP_MAX).toBe(G.constants.default_v_tip_max)
  })

  it('source 闭集', () => {
    expect({
      explicit: SOURCE_EXPLICIT,
      tier_operator: SOURCE_TIER_OPERATOR,
      tier_factory: SOURCE_TIER_FACTORY,
      prefs: SOURCE_PREFS,
      prefs_derived: SOURCE_PREFS_DERIVED,
      default: SOURCE_DEFAULT,
      keep: SOURCE_KEEP,
      intent: SOURCE_INTENT,
    }).toEqual(G.constants.sources)
    expect(PURPOSE_AUTO).toBe(G.constants.purpose_auto)
  })

  it('原子意图工作点就是旧仓流程表里那两个数', () => {
    const r = resolveScan({ centerXM: 0, centerYM: 0, sizeM: 4e-9, purpose: 'atomic_verify' })
    expect(r.setBias).toEqual({ bias_v: G.constants.atomic_working_point.bias_v })
    expect(r.setSetpoint).toEqual({ setpoint_a: G.constants.atomic_working_point.setpoint_a })
  })
})

describe('waitBudgetS', () => {
  for (const row of G.wait_budget) {
    it(`est=${String(row.estimated_scan_s)} floor=${row.floor_s}`, () => {
      expect(waitBudgetS(row.estimated_scan_s, row.floor_s)).toBe(row.budget_s)
    })
  }

  it('余量与常数与旧仓一致', () => {
    // 1000 × 1.3 + 30 = 1330，下限压不住它 ⇒ 这一格直接读出那两个常数
    expect(waitBudgetS(1000, 0)).toBe(1000 * G.constants.wait_headroom_frac + G.constants.wait_headroom_s)
  })
})

describe('TypeError 的那四格：本仓给一个值，而那个值不是 0', () => {
  const base = { centerXM: 0, centerYM: 0, sizeM: 1e-7 }

  it('解不出的 line_time ⇒ 落回内建默认 0.5，trace 说得出它是默认', () => {
    const r = resolveScan({ ...base, explicit: { line_time_s: 'slow' } })
    expect(r.trace['line_time_s']).toEqual({
      value: 0.5,
      source: SOURCE_DEFAULT,
      tier: null,
      human: null,
    })
    expect(r.configureScan['line_time_s']).toBe(0.5)
  })

  it('解不出的 angle ⇒ **不下发**，而且不印一个 `0°`', () => {
    const r = resolveScan({ ...base, explicit: { angle_deg: 'tilted' } })
    expect(r.trace['angle_deg']).toEqual({
      value: null,
      source: SOURCE_EXPLICIT,
      tier: null,
      human: null,
    })
    expect('angle_deg' in r.configureScan).toBe(false)
  })

  it('解不出的 bias ⇒ 不下发，而且不印一个 `0 V`', () => {
    const r = resolveScan({ ...base, explicit: { bias_v: 'high' } })
    expect(r.setBias).toBeNull()
    expect(r.trace['bias_v']?.human).toBeNull()
  })

  it('解不出的偏好扫描速度 ⇒ 回落档位表，不是让整次扫描失败', () => {
    const r = resolveScan(base, { prefs: { scan_speed_nm_s: 'fast' } })
    expect(r.trace['line_time_s']?.source).toBe(SOURCE_TIER_FACTORY)
    expect(r.trace['line_time_s']?.value).toBe(1.0)
  })
})

describe('pyNum —— 两处比旧仓严', () => {
  it('十六进制写法拒绝（JS 的 Number 会给 16）', () => {
    expect(Number('0x10')).toBe(16)
    expect(pyNum('0x10')).toBeNull()
  })

  it('下划线写法拒绝（而 Python 的 float 会给 1000）', () => {
    expect(pyNum('1_000')).toBeNull()
  })

  it('旧仓认的照认：空白、bool、科学记数', () => {
    expect(pyNum(' 5 ')).toBe(5)
    expect(pyNum(true)).toBe(1)
    expect(pyNum('1e-9')).toBe(1e-9)
  })

  it('nan / inf 是「没有值」，不是一个数', () => {
    expect(pyNum(Number.NaN)).toBeNull()
    expect(pyNum(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('旧仓抛 OverflowError 的那一格：本仓给一个值', () => {
  it('pixels = inf ⇒ 落回内建默认 256（旧仓是一次未捕获的异常）', () => {
    const r = resolveScan({
      centerXM: 0,
      centerYM: 0,
      sizeM: 1e-7,
      explicit: { pixels: Number.POSITIVE_INFINITY },
    })
    expect(r.setScanBuffer).toEqual({ pixels: 256, lines: 256 })
    expect(r.trace['pixels']?.source).toBe(SOURCE_DEFAULT)
  })
})

describe('档位表由外面注入', () => {
  it('不给 ⇒ 出厂表（而出厂表**不带增益**，于是 PI 一律 keep-current）', () => {
    const r = resolveScan({ centerXM: 0, centerYM: 0, sizeM: 1e-7 })
    expect(r.tierName).toBe('highres')
    expect(r.setZctrlGain).toBeNull()
    expect(r.trace['p_gain']?.source).toBe(SOURCE_KEEP)
  })

  it('操作员表里用户填过的字段，偏好盖不掉它', () => {
    const r = resolveScan(
      { centerXM: 0, centerYM: 0, sizeM: 1e-8 },
      { tiers: LOOKUPS.operator, prefs: { scan_lines: 512 } },
    )
    expect(r.trace['pixels']).toEqual({
      value: 128,
      source: SOURCE_TIER_OPERATOR,
      tier: 'fine',
      human: null,
      isInt: true,
    })
  })

  it('同一张表里**回填**的那个字段，偏好盖得掉', () => {
    const r = resolveScan(
      { centerXM: 0, centerYM: 0, sizeM: 1e-6 },
      { tiers: LOOKUPS.operator, prefs: { line_time_s: 0.9 } },
    )
    expect(r.trace['line_time_s']?.source).toBe(SOURCE_PREFS)
  })
})
