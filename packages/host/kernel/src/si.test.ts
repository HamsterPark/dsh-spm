import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SIParseError, formatSi, needsStrictPrefix, parseQuantity, parseSi } from './si.js'

/**
 * 不手写用例——直接跑 `spec/golden/si_cases.json`，那是从旧仓真实实现录下来的
 * （`tools/spec-export/export_mast_spec.py`）。手写的期望值只能证明「我以为它该这样」。
 */
const golden = JSON.parse(
  readFileSync(new URL('../../../../spec/golden/si_cases.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, { ok: boolean; value?: unknown; error?: string }>>

/** 金样的键是 Python 的 repr()，还原成实际入参。 */
function fromReprKey(key: string): unknown {
  if (key === 'None') return null
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replaceAll("\\'", "'")
  if (key === 'nan') return Number.NaN
  if (key === 'inf') return Number.POSITIVE_INFINITY
  return Number(key)
}

/** 把一次调用规整成与金样条目同形，好直接 deep-equal。 */
function run(fn: () => unknown): { ok: boolean; value?: unknown; error?: string } {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

/**
 * 有意与 Python 不同的行为（`spec/deviations.md`）。**不是跳过**：这里照样断言 TS 的
 * 行为，只是断言的是那份文档说的那样。未登记的差异 = 缺陷（PLAN §12）。
 */
const DEVIATIONS: Record<string, Record<string, { ok: false; errorMatch: RegExp; why: string }>> = {
  parse_quantity_loose: {
    // D-SI-1：NaN 会穿过包络检查（所有与 NaN 的比较都是 false），±∞ 无物理意义
    "'inf'": { ok: false, errorMatch: /无法解析/, why: 'D-SI-1' },
    "'nan'": { ok: false, errorMatch: /无法解析/, why: 'D-SI-1' },
    "'-inf'": { ok: false, errorMatch: /无法解析/, why: 'D-SI-1' },
    // D-SI-2：Python 数字字面量的下划线写法，模型路径上不会出现
    "'1_000'": { ok: false, errorMatch: /无法解析/, why: 'D-SI-2' },
  },
}

const cases = (group: string) => Object.entries(golden[group]!)

/** 该例是登记过的偏差就按 deviations.md 断言，否则按金样断言。 */
function check(group: string, key: string, expected: unknown, actual: ReturnType<typeof run>): void {
  const dev = DEVIATIONS[group]?.[key]
  if (dev) {
    expect(actual.ok, `${dev.why}: 期望 TS 拒绝，但它接受了`).toBe(false)
    expect(actual.error).toMatch(dev.errorMatch)
    return
  }
  expect(actual).toEqual(expected)
}

describe('si.ts 与旧仓逐例对齐（分母 = spec/golden/si_cases.json）', () => {
  it.each(cases('parse_si'))('parse_si(%s)', (key, expected) => {
    check('parse_si', key, expected, run(() => parseSi(fromReprKey(key))))
  })

  it.each(cases('parse_quantity_strict'))('parse_quantity(%s, strict)', (key, expected) => {
    check('parse_quantity_strict', key, expected, run(() => parseQuantity(fromReprKey(key), { strict: true })))
  })

  it.each(cases('parse_quantity_loose'))('parse_quantity(%s, loose)', (key, expected) => {
    check('parse_quantity_loose', key, expected, run(() => parseQuantity(fromReprKey(key), { strict: false })))
  })

  it.each(cases('needs_strict_prefix'))('needs_strict_prefix%s', (key, expected) => {
    const [lo, hi] = key.slice(1, -1).split(', ').map((s) => (s === 'None' ? null : Number(s)))
    check('needs_strict_prefix', key, expected, run(() => needsStrictPrefix(lo!, hi!)))
  })

  it.each(cases('format_si'))('format_si(%s)', (key, expected) => {
    check('format_si', key, expected, run(() => formatSi(fromReprKey(key) as number)))
  })
})

describe('这三条是本模块存在的理由，单独钉住', () => {
  // 2026-08-03 真机事故的两个方向，各一条。
  it('丢了前缀的 3p 变成 3，必须是解析错误而不是一个说得通的数', () => {
    expect(() => parseSi('3')).toThrow(SIParseError)
  })

  it('裸零同样拒绝——那天第二次损坏产出的正是整整齐齐的 0', () => {
    expect(() => parseSi('0')).toThrow(SIParseError)
    expect(parseSi('0p')).toBe(0) // 想表达零就这么写
  })

  it('大小写有意义：3m 是三毫，3M 是三兆，差九个数量级', () => {
    expect(parseSi('3m')).toBe(3e-3)
    expect(parseSi('3M')).toBe(3e6)
  })
})
