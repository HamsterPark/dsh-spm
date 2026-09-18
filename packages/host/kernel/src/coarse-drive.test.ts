/**
 * 粗动驱动四道锁对 `spec/golden/coarse_drive.json` 逐格比。
 *
 * 金样由旧仓真实的 `mast/core/coarse_drive.py` 录制
 * （`tools/spec-export/export_coarse_drive.py`），**整段拒绝文本进金样** ——
 * 那几句是直接给人（和模型）看的，措辞就是契约。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ABSOLUTE_MAX_AMPLITUDE_V,
  ABSOLUTE_MAX_FREQUENCY_HZ,
  COARSE_READBACK_REL_TOL,
  DRIVE_ALL_KEYS,
  SETTINGS_KEY,
  UNDECLARED,
  authorize,
  expectedFrequencyHz,
  formatCoarseDriveBlock,
  getDeclaration,
  isDeclared,
  maxAmplitudeV,
  processCoarseDrive,
  readbackMatches,
  sanitizeDeclaration,
} from './coarse-drive.js'

const G = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/coarse_drive.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    settings_key: string
    absolute_max_amplitude_v: number
    absolute_max_frequency_hz: number
    readback_rel_tol: number
    all_keys: string[]
    undeclared_text: string
  }
  sanitize: Record<string, Record<string, unknown>>
  authorize: Record<string, Record<string, { ok: boolean; reason: string }>>
  readback_matches: Record<string, Record<string, { ok: boolean; reason: string }>>
  format_block: Record<string, string>
  declaration: Record<string, { stored: Record<string, unknown>; max_amplitude_v: number | null; expected_frequency_hz: number | null; is_declared: boolean }>
}

/** 与 `export_coarse_drive.py` 的 `DECLARATIONS` **逐条同形**。 */
const DECLARATIONS: Record<string, Record<string, unknown>> = {
  undeclared: {},
  amp_only: { max_amplitude_v: 220.0 },
  amp_and_freq: {
    max_amplitude_v: 220.0, expected_frequency_hz: 1000.0,
    declared_by: 'spec-export', notes: '金样夹具',
  },
  over_absolute: { max_amplitude_v: 401.0 },
}

/** 与 `SANITIZE_CASES` 逐条同形。 */
const SANITIZE_RAW: Record<string, unknown> = {
  not_a_dict: 7,
  empty: {},
  unknown_dropped: { nope: 1 },
  over_absolute_dropped: { max_amplitude_v: 401.0 },
  at_absolute_kept: { max_amplitude_v: 400.0 },
  negative_dropped: { max_amplitude_v: -1.0 },
  nan_dropped: { max_amplitude_v: Number.NaN },
  inf_dropped: { max_amplitude_v: Number.POSITIVE_INFINITY },
  numeric_string: { max_amplitude_v: '220' },
  freq_over_dropped: { expected_frequency_hz: 20001.0 },
  text_trimmed: { declared_by: '  甲  ', notes: 'x'.repeat(300) },
  stamp_kept: { declared_at: 1_700_000_000.0 },
  full: DECLARATIONS['amp_and_freq'] as Record<string, unknown>,
}

/** 与 `AUTHORIZE_CASES` 逐条同形。 */
const AUTHORIZE_ARGS: Record<string, [unknown, unknown]> = {
  not_a_number: ['abc', null],
  none: [null, null],
  nan: [Number.NaN, null],
  inf: [Number.POSITIVE_INFINITY, null],
  negative: [-1.0, null],
  over_absolute: [401.0, null],
  at_absolute: [400.0, null],
  freq_not_a_number: [30.0, 'abc'],
  freq_over_absolute: [30.0, 20001.0],
  freq_negative: [30.0, -1.0],
  under_ceiling: [30.0, 1000.0],
  at_ceiling: [220.0, null],
  over_ceiling: [260.0, null],
  zero: [0.0, null],
  fractional: [12.5, null],
}

/** 与 `READBACK_CASES` 逐条同形。 */
const READBACK_ARGS: Record<string, [unknown, unknown]> = {
  unreadable_amp: [null, null],
  amp_not_a_number: ['abc', null],
  amp_nan: [Number.NaN, null],
  amp_within: [30.0, 1000.0],
  amp_at_ceiling: [220.0, 1000.0],
  amp_inside_tolerance: [224.0, 1000.0],
  amp_outside_tolerance: [225.0, 1000.0],
  amp_way_over: [390.0, 1000.0],
  freq_unreadable_but_declared: [30.0, 'abc'],
  freq_mismatch_warns_not_refuses: [30.0, 500.0],
  freq_within_10pct: [30.0, 1050.0],
  freq_absent: [30.0, null],
}

/**
 * 旧仓那几句里印的「你发过来的是什么」用的是 Python 的 `repr`。
 *
 * 数值与字符串本仓照印（`-1.0` / `'abc'` 只是格式）；**`None` 不照印** ——
 * 同 D-SKILL-2：为了逐字去伪造一个 `None`，等于让诊断指向一门这里没有在跑的语言。
 * 期望值**从金样算出来**，于是旧仓哪天改了那句话，这条登记会跟着变、不会悄悄过期。
 */
function ourRepr(reason: string): string {
  return reason.replace('驱动幅度不是一个数值:None', '驱动幅度不是一个数值:null')
}

function install(decl: Record<string, unknown>): void {
  processCoarseDrive.source = () => decl
}

afterEach(() => {
  processCoarseDrive.source = null
})

describe('粗动驱动 · 常量与未声明那段话', () => {
  it('常量逐个', () => {
    expect(SETTINGS_KEY).toBe(G.constants.settings_key)
    expect(ABSOLUTE_MAX_AMPLITUDE_V).toBe(G.constants.absolute_max_amplitude_v)
    expect(ABSOLUTE_MAX_FREQUENCY_HZ).toBe(G.constants.absolute_max_frequency_hz)
    expect(COARSE_READBACK_REL_TOL).toBe(G.constants.readback_rel_tol)
    expect([...DRIVE_ALL_KEYS].sort()).toEqual([...G.constants.all_keys].sort())
  })

  it('未声明那段话**逐字**', () => {
    expect(UNDECLARED).toBe(G.constants.undeclared_text)
  })
})

describe('粗动驱动 · `sanitize` 逐格对旧仓', () => {
  for (const [name, want] of Object.entries(G.sanitize)) {
    it(name, () => {
      expect(sanitizeDeclaration(SANITIZE_RAW[name])).toEqual(want)
    })
  }
})

describe('粗动驱动 · 声明读口', () => {
  for (const [dname, want] of Object.entries(G.declaration)) {
    it(dname, () => {
      install(DECLARATIONS[dname]!)
      const stored = { ...getDeclaration() }
      delete stored['declared_at']
      expect(stored).toEqual(want.stored)
      expect(maxAmplitudeV()).toEqual(want.max_amplitude_v)
      expect(expectedFrequencyHz()).toEqual(want.expected_frequency_hz)
      expect(isDeclared()).toBe(want.is_declared)
    })
  }

  it('宿主没接读口 = 没有声明', () => {
    processCoarseDrive.source = null
    expect(getDeclaration()).toEqual({})
    expect(isDeclared()).toBe(false)
  })

  it('读口抛了 = 没有声明（**而没有声明正是这道闸要拒的那件事**）', () => {
    processCoarseDrive.source = () => {
      throw new Error('boom')
    }
    expect(isDeclared()).toBe(false)
    expect(authorize(30.0).ok).toBe(false)
    expect(readbackMatches(30.0).ok).toBe(false)
  })
})

describe('粗动驱动 · `authorize` 逐格对旧仓', () => {
  for (const [dname, cases] of Object.entries(G.authorize)) {
    describe(dname, () => {
      for (const [name, want] of Object.entries(cases)) {
        it(name, () => {
          install(DECLARATIONS[dname]!)
          const [a, f] = AUTHORIZE_ARGS[name]!
          expect(authorize(a, f)).toEqual({ ok: want.ok, reason: ourRepr(want.reason) })
        })
      }
    })
  }
})

describe('粗动驱动 · `readbackMatches` 逐格对旧仓', () => {
  for (const [dname, cases] of Object.entries(G.readback_matches)) {
    describe(dname, () => {
      for (const [name, want] of Object.entries(cases)) {
        it(name, () => {
          install(DECLARATIONS[dname]!)
          const [a, f] = READBACK_ARGS[name]!
          expect(readbackMatches(a, f)).toEqual({ ok: want.ok, reason: ourRepr(want.reason) })
        })
      }
    })
  }
})

describe('粗动驱动 · 提示块', () => {
  for (const [dname, want] of Object.entries(G.format_block)) {
    it(dname, () => {
      install(DECLARATIONS[dname]!)
      expect(formatCoarseDriveBlock()).toBe(want)
    })
  }

  it('**永不为空，也永不给出一个可以照着做的数**', () => {
    processCoarseDrive.source = null
    const block = formatCoarseDriveBlock()
    expect(block).not.toBe('')
    expect(block).toContain('不要尝试自己设定')
  })
})

describe('粗动驱动 · 那两条「不夹紧」的判据', () => {
  it('越界请求被**拒绝**，而不是被悄悄降到上限', () => {
    install(DECLARATIONS['amp_only']!)
    const v = authorize(260.0)
    expect(v.ok).toBe(false)
    // 夹紧会把「300 V 会烧掉这只叠堆」变成「按 220 V 跑了」而调用方以为自己要的是 260。
    expect(v.reason).toContain('【不会自动降到上限】')
    expect(v.reason).toContain('260')
    expect(v.reason).toContain('220')
  })

  it('绝对上限排在本机声明**之前** —— 任何配置都放宽不了它', () => {
    // 一个填到顶的声明也授权不了一个超绝对上限的请求。
    install({ max_amplitude_v: 400.0 })
    expect(authorize(401.0).reason).toContain('超过绝对上限')
    expect(authorize(400.0).ok).toBe(true)
  })

  it('读回**读不到就是拒绝** —— 一道失败模式是「通过」的检查不是检查', () => {
    install(DECLARATIONS['amp_only']!)
    expect(readbackMatches(null).ok).toBe(false)
    expect(readbackMatches(undefined).ok).toBe(false)
    expect(readbackMatches('').ok).toBe(false)
    expect(readbackMatches(Number.NaN).ok).toBe(false)
  })

  it('频率不符只**警告**不拒绝：它让里程表漂，不会烧掉叠堆', () => {
    install(DECLARATIONS['amp_and_freq']!)
    const v = readbackMatches(30.0, 500.0)
    expect(v.ok).toBe(true)
    expect(v.reason).toContain('里程表会漂')
  })
})
