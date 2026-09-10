/**
 * 工具 schema 生成的金样比对。判据是 `spec/golden/tool_schemas.json`——
 * 由**旧仓真实的** `_schema_from_metadata` 产出，18 条规则各一个最小用例。
 *
 * **整体比，不挑字段。** 只显式剥掉 `title` 一个键（Pydantic 从字段名派生它，
 * 不携带信息）。这样 Python 哪天多吐一个键，测试会红，而不是被我悄悄忽略掉——
 * 「只比我关心的那几个字段」等于让我自己决定哪里可以出错。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SAFETY_LIMITS } from './safety-tables.js'
import type { ParameterSpec, SkillSpec } from './skill-kernel.js'
import {
  effectiveBounds,
  explainValidationError,
  isStrictParam,
  parametersFromSpec,
  siParams,
} from './tool-schema.js'

interface GoldenCase {
  readonly properties: Record<string, Record<string, unknown>>
  readonly required: readonly string[]
  readonly tool_call_id_present: boolean
  readonly si_params: Record<string, boolean>
  readonly effective_bounds: Record<string, readonly (number | null)[]>
  readonly validation_error: string
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/tool_schemas.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, GoldenCase>

/** 导出脚本里的 CASES 逐条对应的 TS 声明。**参数与 Python 那边逐字同形。** */
const CASES: Record<string, ParameterSpec[]> = {
  plain_string: [{ name: 'label', type: 'string', description: '标签', required: true }],
  plain_int: [{ name: 'steps', type: 'integer', description: '步数', required: true }],
  int_with_range: [
    { name: 'steps', type: 'integer', description: '步数', minValue: 1, maxValue: 100, required: true },
  ],
  bool_flag: [
    { name: 'enabled', type: 'boolean', description: '开关', required: false, default: true },
  ],
  enum_str: [
    {
      name: 'direction',
      type: 'string',
      description: '方向',
      allowedValues: ['X+', 'X-', 'Z+'],
      required: true,
    },
  ],
  enum_int: [
    { name: 'channel', type: 'integer', description: '通道', allowedValues: [1, 2, 3], required: true },
  ],
  dim_strict_current: [
    {
      name: 'setpoint_a',
      type: 'float',
      unit: 'A',
      description: '隧道电流设定点',
      minValue: 1e-12,
      maxValue: 100e-9,
      required: true,
    },
  ],
  dim_strict_length: [
    {
      name: 'x_m',
      type: 'float',
      unit: 'm',
      description: 'X 坐标',
      minValue: -1.5e-6,
      maxValue: 1.5e-6,
      required: true,
    },
  ],
  dim_lenient_bias: [
    {
      name: 'bias_v',
      type: 'float',
      unit: 'V',
      description: '偏压',
      minValue: -10.0,
      maxValue: 10.0,
      required: true,
    },
  ],
  dim_only_max: [
    { name: 'tip_lift', type: 'float', unit: 'm', description: '下压深度', maxValue: 1e-7, required: false },
  ],
  dim_only_min: [
    { name: 'dwell_s', type: 'float', unit: 's', description: '停留', minValue: 0.001, required: false },
  ],
  dim_no_bounds: [{ name: 'angle_deg', type: 'float', unit: 'deg', description: '角度', required: false }],
  float_no_unit: [
    { name: 'ratio', type: 'float', description: '比例', minValue: 0.0, maxValue: 1.0, required: true },
  ],
  no_description: [
    { name: 'x_m', type: 'float', unit: 'm', minValue: -1e-6, maxValue: 1e-6, required: true },
  ],
  enum_mixed_type: [
    { name: 'channel', type: 'string', description: '通道', allowedValues: [1, 2], required: true },
  ],
  enum_bool: [
    { name: 'flag', type: 'boolean', description: '旗标', allowedValues: [true, false], required: true },
  ],
  enum_float_rejected: [
    { name: 'ratio', type: 'float', description: '比例', allowedValues: [0.5, 1.0], required: true },
  ],
  dim_enum: [
    {
      name: 'bias_v',
      type: 'float',
      unit: 'V',
      description: '偏压档',
      allowedValues: ['low', 'high'],
      required: true,
    },
  ],
  enum_single: [{ name: 'mode', type: 'string', description: '模式', allowedValues: ['only'], required: true }],
  enum_mixed_values: [
    { name: 'who', type: 'string', description: '谁', allowedValues: ['auto', 1], required: true },
  ],
  envelope_only: [
    { name: 'center_x_m', type: 'float', unit: 'm', description: '中心 X', required: true },
  ],
}

const specOf = (name: string): SkillSpec => ({
  name,
  description: `${name} 的说明`,
  parameters: CASES[name] ?? [],
})

/** Pydantic 从字段名派生的 `title`——唯一允许剥掉的键。 */
const stripTitle = (p: Record<string, unknown>): Record<string, unknown> => {
  const { title: _title, ...rest } = p
  return rest
}

describe('parametersFromSpec —— 18 条生成规则逐字对旧仓', () => {
  it('金样与用例表一一对应，没有谁多出一条', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(golden).sort())
  })

  for (const name of Object.keys(golden)) {
    it(`${name}：properties 整体逐字相等（只剥 title）`, () => {
      const got = parametersFromSpec(specOf(name))
      const want = Object.fromEntries(
        Object.entries(golden[name]!.properties).map(([k, v]) => [k, stripTitle(v)]),
      )
      expect(got.properties).toEqual(want)
    })

    it(`${name}：required 相等`, () => {
      expect(parametersFromSpec(specOf(name)).required).toEqual([...golden[name]!.required])
    })

    it(`${name}：si_params 相等（广告与执行同源）`, () => {
      expect(Object.fromEntries(siParams(specOf(name)))).toEqual(golden[name]!.si_params)
    })

    it(`${name}：校验失败文案逐字相等`, () => {
      // `enum_float_rejected` 是唯一对不上的一条，理由在下面 D-SCHEMA-1 那条测试里。
      if (name === 'enum_float_rejected') return
      expect(explainValidationError(specOf(name))).toBe(golden[name]!.validation_error)
    })

    it(`${name}：effective_bounds 相等`, () => {
      const got = Object.fromEntries(
        specOf(name).parameters.map((p) => [p.name, [...effectiveBounds(p)]]),
      )
      expect(got).toEqual(
        Object.fromEntries(Object.entries(golden[name]!.effective_bounds).map(([k, v]) => [k, [...v]])),
      )
    })
  }
})

describe('生成规则本身的形状', () => {
  it('tool_call_id 是注入字段，**不出现在给模型的 schema 里**', () => {
    // 金样里它被单独记了一笔：Python 侧确实建了这个字段
    expect(Object.values(golden).every((c) => c.tool_call_id_present)).toBe(true)
    // 而我们这一侧根本不需要它——dsh 的工具调用自带 id，不用往参数里塞
    for (const name of Object.keys(CASES)) {
      expect(parametersFromSpec(specOf(name)).properties['tool_call_id']).toBeUndefined()
    }
  })

  it('有量纲的浮点一律是 string，不是 number —— provider 的数字通道会吃掉指数', () => {
    for (const name of ['dim_strict_current', 'dim_strict_length', 'dim_lenient_bias', 'no_description']) {
      const p = parametersFromSpec(specOf(name))
      expect(Object.values(p.properties)[0]?.type).toBe('string')
      expect(Object.values(p.properties)[0]?.minimum).toBeUndefined()
    }
  })

  it('strict 参数的范围用 SI 记法印，宽松参数用朴素记法 —— 否则等于用它拒收的格式给答案', () => {
    expect(parametersFromSpec(specOf('dim_strict_current')).properties['setpoint_a']?.description).toContain(
      '范围 1p … 100n A',
    )
    expect(parametersFromSpec(specOf('dim_lenient_bias')).properties['bias_v']?.description).toContain(
      '范围 -10 … 10 V',
    )
  })

  it('枚举压过字符串通道：有量纲的枚举不进 si_params，也不会被要求写成 5m', () => {
    expect(siParams(specOf('dim_enum')).size).toBe(0)
    const p = parametersFromSpec(specOf('dim_enum')).properties['bias_v']
    expect(p?.enum).toEqual(['low', 'high'])
    expect(p?.description).toBe('偏压档 (unit: V)') // 没有「写成字符串」那一段
  })

  it('含浮点的 allowed_values **整条失效**：模型既看不到 enum 也看不到范围', () => {
    // 照抄旧仓行为。真技能里 0 个参数走这条（查过 1642 个参数），
    // 所以这是一条活着的死分支，不是现役缺陷——但它就在那儿。
    const p = parametersFromSpec(specOf('enum_float_rejected')).properties['ratio']
    expect(p?.enum).toBeUndefined()
    expect(p?.minimum).toBeUndefined()
    expect(p?.type).toBe('number')
  })
})

describe('explainValidationError —— 模型读的那段教学文案', () => {
  it('D-SCHEMA-1 在这里**变得可观测**：Python 印 1.0，JSON 到 TS 只剩 1', () => {
    // 别处这条偏差都藏得住（含浮点的 allowed_values 在 schema 里整条失效）。
    // 唯独这段文案会把值印出来，于是差异露头。信息在 JSON 边界就丢了，无从恢复；
    // 1642 个真参数里 0 个含浮点枚举，所以这是记在账上的差异，不是待修的缺陷。
    expect(golden['enum_float_rejected']!.validation_error).toContain('{0.5, 1.0}')
    expect(explainValidationError(specOf('enum_float_rejected'))).toContain('{0.5, 1}')
  })

  it('旧仓自身的不一致，照抄不改（一）：这句话读的是声明的 min/max，不是有效界', () => {
    // `center_x_m` 的范围全部来自安全包络。描述里写着「范围 -1.5u … 1.5u m」，
    // 而这句话里是「见参数说明」—— 同一个参数，两处说法。
    expect(parametersFromSpec(specOf('envelope_only')).properties['center_x_m']?.description).toContain(
      '范围 -1.5u … 1.5u m',
    )
    expect(explainValidationError(specOf('envelope_only'))).toContain('允许范围：见参数说明。')
  })

  it('旧仓自身的不一致，照抄不改（二）：枚举这一行不过滤浮点', () => {
    // schema 里 `enum_float_rejected` 看不到 enum，这段话里却列出了合法值。
    expect(parametersFromSpec(specOf('enum_float_rejected')).properties['ratio']?.enum).toBeUndefined()
    expect(explainValidationError(specOf('enum_float_rejected'))).toContain('ratio ∈ {')
  })

  it('前缀 `precondition_failed:` 是**故意**的 —— StallGuard 按签名聚合重复失败', () => {
    // 一个反复发同一个坏值的模型，靠这个签名才会升级到强制停止。
    expect(explainValidationError(specOf('plain_string'))).toMatch(/^\[plain_string\] precondition_failed: /)
  })
})

describe('effectiveBounds —— 广告与执行的唯一表达式', () => {
  const centerX: ParameterSpec = { name: 'center_x_m', type: 'float', unit: 'm', required: true }

  it('自己不写范围的参数，界从安全包络来', () => {
    // 2026-08-10 的 16 个米制参数正是这个形状：写得越规范，防护掉得越干净
    expect(effectiveBounds(centerX)).toEqual([
      DEFAULT_SAFETY_LIMITS.xy_min_m,
      DEFAULT_SAFETY_LIMITS.xy_max_m,
    ])
  })

  it('只做交集：包络只会让界更紧，不会更松', () => {
    const wide: ParameterSpec = { ...centerX, minValue: -1, maxValue: 1 }
    expect(effectiveBounds(wide)).toEqual([DEFAULT_SAFETY_LIMITS.xy_min_m, DEFAULT_SAFETY_LIMITS.xy_max_m])
    const narrow: ParameterSpec = { ...centerX, minValue: -1e-9, maxValue: 1e-9 }
    expect(effectiveBounds(narrow)).toEqual([-1e-9, 1e-9])
  })

  it('管理员收紧包络后，schema 广告的范围**跟着收紧**', () => {
    const tightened = { ...DEFAULT_SAFETY_LIMITS, setpoint_max_a: 10e-9 }
    const spec: SkillSpec = {
      name: 'X',
      description: 'x',
      parameters: [
        { name: 'setpoint_a', type: 'float', unit: 'A', description: '设定点', minValue: 1e-12, maxValue: 100e-9, required: true },
      ],
    }
    expect(parametersFromSpec(spec, tightened).properties['setpoint_a']?.description).toContain(
      '范围 1p … 10n A',
    )
  })

  it('声明里省略 `required` ⇒ **必填**，广告与执行两侧同一个答案', () => {
    // Python 的 `ParameterSpec.required: bool = True` 是 dataclass 缺省，
    // schema 侧与 validate 侧读到的都是 True。1642 个真参数全都显式写了 required，
    // 所以这一格在金样里不可观测 —— 但 TS 里省略是合法的，两侧一旦分头猜就会
    // 出现「广告成必填、却不强制」。这条测试是它唯一的看守。
    const spec: SkillSpec = {
      name: 'X',
      description: 'x',
      parameters: [{ name: 'q', type: 'string', description: '问' }],
    }
    const out = parametersFromSpec(spec)
    expect(out.required).toEqual(['q'])
    expect(out.properties['q']?.default).toBeUndefined() // 必填就不发 default
  })

  it('m 与 A 无条件 strict，V 不是 —— 1 附近就是常用值的量纲上强制前缀是噪声', () => {
    expect(isStrictParam({ name: 'q', type: 'float', unit: 'm' })).toBe(true)
    expect(isStrictParam({ name: 'q', type: 'float', unit: 'A' })).toBe(true)
    expect(isStrictParam({ name: 'q', type: 'float', unit: 'V', minValue: -10, maxValue: 10 })).toBe(false)
  })
})
