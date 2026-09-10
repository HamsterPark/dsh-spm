/**
 * DoD ② 的**真考场**：`parametersFromSpec` 对旧仓 515 个真技能、1642 个参数。
 *
 * 合成用例（`tool-schema.test.ts`，21 条）钉的是**生成规则**——一条规则一个最小
 * 用例，一条失败能立刻说出是哪条规则错了。这一份钉的是**那些规则跑在真实组合上
 * 会得到什么**：真技能里有同时带单位、枚举、边界、长中文描述的参数，
 * 而合成用例按定义覆盖不到它们的组合。
 *
 * 两者缺一不可：
 * - 只有合成用例 ⇒ 覆盖不到真实组合；
 * - 只有真技能 ⇒ 一条失败说不清是哪条规则错了。
 *
 * **不是循环论证**：spec 来自 `skills.json`（Python 的 `_get_metadata_raw`），
 * 金样来自 Python 的 `_schema_from_metadata`。这里比的是**两份生成实现**，
 * 输入同源正是要求。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parametersFromSpec } from './tool-schema.js'
import type { ParameterSpec, SkillSpec } from './skill-kernel.js'

interface GoldenSkill {
  name: string
  description: string
  parameters?: {
    name: string
    type: string
    description?: string | null
    unit?: string | null
    required?: boolean | null
    min_value?: number | null
    max_value?: number | null
    allowed_values?: (string | number | boolean)[] | null
    default?: unknown
  }[] | null
}

const url = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const raw = JSON.parse(readFileSync(url('../../../../spec/golden/skills.json'), 'utf8')) as
  | Record<string, GoldenSkill>
  | GoldenSkill[]
const skills = Array.isArray(raw) ? raw : Object.values(raw)

const real = JSON.parse(
  readFileSync(url('../../../../spec/golden/tool_schemas_real.json'), 'utf8'),
) as Record<string, { properties?: Record<string, Record<string, unknown>>; required?: string[]; error?: string }>

/** 金样里的参数声明 → 我们的 `ParameterSpec`。与 `gen-skill-specs.ts` 同一套映射。 */
function toSpec(s: GoldenSkill): SkillSpec {
  const parameters: ParameterSpec[] = (s.parameters ?? []).map((p) => ({
    name: p.name,
    type: p.type,
    ...(p.description != null && p.description !== '' ? { description: p.description } : {}),
    ...(p.unit != null && p.unit !== '' ? { unit: p.unit } : {}),
    required: p.required === true,
    ...(p.min_value != null ? { minValue: p.min_value } : {}),
    ...(p.max_value != null ? { maxValue: p.max_value } : {}),
    ...(p.allowed_values != null && p.allowed_values.length > 0
      ? { allowedValues: p.allowed_values }
      : {}),
    ...(p.default !== undefined && p.default !== null ? { default: p.default } : {}),
  }))
  return { name: s.name, description: s.description, parameters }
}

/**
 * 键序无关的规范化。
 *
 * 第一版直接 `JSON.stringify` 比 —— 于是 515 个技能里有一大半「不相等」，
 * 差的只是 `type` 和 `description` 谁先谁后。**键序不是判据**：
 * Pydantic 按声明顺序吐，我们按代码顺序吐，两者都对。
 */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  )
}

/** Pydantic 从字段名派生的 `title`——唯一允许剥掉的键（同合成用例）。 */
const stripTitle = (p: Record<string, unknown>): Record<string, unknown> => {
  const { title: _t, ...rest } = p
  return rest
}

describe('DoD ② · 515 个真技能的模型面 parity', () => {
  it('金样覆盖了 skills.json 里的每一个名字', () => {
    expect(skills.filter((s) => real[s.name] === undefined).map((s) => s.name)).toEqual([])
  })

  it('**没有一个技能建不出 schema**', () => {
    const broken = Object.entries(real).filter(([, v]) => v.error !== undefined)
    expect(broken.map(([n, v]) => `${n}: ${v.error}`)).toEqual([])
  })

  it('1642 个参数的 properties 与 required 逐字相等（只剥 title）', () => {
    const mismatched: string[] = []
    for (const s of skills) {
      const want = real[s.name]!
      const got = parametersFromSpec(toSpec(s))
      const wantProps = Object.fromEntries(
        Object.entries(want.properties ?? {}).map(([k, v]) => [k, stripTitle(v)]),
      )
      if (canon(got.properties) !== canon(wantProps)) {
        // 报**第一个不一样的参数**，而不是整个技能——515 个技能的 diff 没法读
        for (const key of new Set([...Object.keys(got.properties), ...Object.keys(wantProps)])) {
          const a = canon(got.properties[key])
          const b = canon(wantProps[key])
          if (a !== b) mismatched.push(`${s.name}.${key}\n  got  ${a}\n  want ${b}`)
        }
      }
      if (canon(got.required) !== canon(want.required ?? [])) {
        mismatched.push(
          `${s.name} required\n  got  ${JSON.stringify(got.required)}\n  want ${JSON.stringify(want.required)}`,
        )
      }
    }
    expect(mismatched.slice(0, 8).join('\n')).toBe('')
    expect(mismatched).toHaveLength(0)
  })
})
