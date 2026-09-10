/**
 * 从技能声明生成**模型看到的那份工具 schema**——`_schema_from_metadata` 的逐字移植。
 *
 * 这份文件的产物是模型唯一读得到「这个参数怎么写、范围多少」的地方，所以
 * **描述文案逐字相等**是判据的一部分，不是文档洁癖：
 *
 * - 有量纲的浮点被声明成 **`string`**。原因是 provider 侧受约束解码对 JSON *数字*
 *   的语法有缺陷：2026-08-04 实测 12/12 全损（`3e-12` 到达时变成 `3`，`1.8e-07` 变成
 *   `1.8`），换成字符串通道 12/12 逐字节正确。代价是 `minimum`/`maximum` 到不了 schema，
 *   于是范围只能写进描述——**抄错一个词，模型就会用错写法**。
 * - `title` 不生成。Pydantic 从字段名派生它（`x_m` → `"X M"`），它不携带任何模型
 *   读不到的信息，而多一个键就多一处要对齐的东西。测试比对时显式剥掉这一个键、
 *   其余**整体逐字比**——这样 Python 哪天多吐一个键，测试会红而不是被我悄悄忽略。
 *
 * ⚠️ 广告与执行必须由**同一个表达式**算出来。2026-08-10 真机：`_si_params` 只看
 * `spec.min/max`，而 schema 侧算的是**与安全包络求交之后**的界。于是 16 个米制参数
 * 的描述逐字写着「前缀不可省略——裸数字会被拒绝」，解析侧却欣然接受 `"2.2"` 并当成
 * 2.2 **米**。这里的 `effectiveBounds()` 是那唯一的表达式，内核 K1 也走它。
 */
import { DEFAULT_SAFETY_LIMITS, type SafetyLimits } from './safety-tables.js'
import { formatG, formatSi, needsStrictPrefix } from './si.js'
import type { ParameterSpec, SkillSpec } from './skill-kernel.js'

/** 参数名 → 约束它的那对 `SafetyLimits` 字段。名字含义不含糊的才进表：错一条映射
 * 会悄悄收紧一个无关参数，那比不管它更糟。 */
const ENVELOPE_FIELDS: ReadonlyMap<string, readonly [keyof SafetyLimits, keyof SafetyLimits]> =
  new Map<string, readonly [keyof SafetyLimits, keyof SafetyLimits]>([
    ['setpoint_a', ['setpoint_min_a', 'setpoint_max_a']],
    ['bias_v', ['bias_min_v', 'bias_max_v']],
    ['z_pos_m', ['z_min_m', 'z_max_m']],
    ['center_x_m', ['xy_min_m', 'xy_max_m']],
    ['center_y_m', ['xy_min_m', 'xy_max_m']],
    ['x_m', ['xy_min_m', 'xy_max_m']],
    ['y_m', ['xy_min_m', 'xy_max_m']],
    ['width_m', ['scan_size_min_m', 'scan_size_max_m']],
    ['height_m', ['scan_size_min_m', 'scan_size_max_m']],
  ])

/**
 * 这两个量纲上**裸尾数（0.1 … 1000）在这台仪器上不可能是合法值**，所以前缀强制，
 * 与调用方有没有想起来写 min/max 无关。
 *
 * 为什么按量纲判而不是继续靠范围：`needsStrictPrefix` 对**未知范围答 false**
 * （「不知道范围」确实不是「裸数字不可能」的证据，那条规则本身没错），
 * 后果却是**范围写得越少、防护越松**——实测 23 个米制参数因此完全没有强制前缀。
 * 刻意不含 `V`/`s`/`Hz`/`deg`：那几个量纲上 1 附近就是常用值，强制前缀是纯噪声。
 */
const STRICT_BY_DIMENSION: ReadonlySet<string> = new Set(['m', 'A'])

/** JSON Schema 的类型名。技能声明里 v1 与 JSON Schema 两套别名都认。 */
const TYPE_MAP: Readonly<Record<string, 'string' | 'integer' | 'number' | 'boolean'>> = {
  int: 'integer',
  float: 'number',
  str: 'string',
  bool: 'boolean',
  integer: 'integer',
  number: 'number',
  string: 'string',
  boolean: 'boolean',
}

/** 这个参数当前生效的安全包络（没映射到的返回 `[null, null]`）。 */
function envelopeFor(
  p: ParameterSpec,
  limits: SafetyLimits,
): readonly [number | null, number | null] {
  const pair = ENVELOPE_FIELDS.get(p.name)
  if (pair === undefined) return [null, null]
  const lo = limits[pair[0]]
  const hi = limits[pair[1]]
  return [typeof lo === 'number' ? lo : null, typeof hi === 'number' ? hi : null]
}

/**
 * 这个参数**真正**生效的上下界：它自己声明的范围 ∩ 当前安全包络。
 *
 * 「这个参数到底什么范围」**只有这一个答案**——广告出去的严格性（模型读的描述）
 * 与执行时的严格性（解析器要求的）必须同源。只做交集：只会更紧，不会更松。
 */
export function effectiveBounds(
  p: ParameterSpec,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
): readonly [number | null, number | null] {
  let lo = p.minValue ?? null
  let hi = p.maxValue ?? null
  const [gLo, gHi] = envelopeFor(p, limits)
  if (gLo !== null) lo = lo === null ? gLo : Math.max(lo, gLo)
  if (gHi !== null) hi = hi === null ? gHi : Math.min(hi, gHi)
  return [lo, hi]
}

/**
 * 这个参数要不要强制 SI 前缀。判据两条，或的关系：
 * 1. **有效**上下界整段远离 1（`needsStrictPrefix`）；
 * 2. 单位是 `m` 或 `A`。
 *
 * 用 `effectiveBounds` 而不是 `p.minValue/maxValue`——见本文件抬头的 2026-08-10。
 */
export function isStrictParam(
  p: ParameterSpec,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
): boolean {
  if (STRICT_BY_DIMENSION.has((p.unit ?? '').trim())) return true
  const [lo, hi] = effectiveBounds(p, limits)
  return needsStrictPrefix(lo, hi)
}

/**
 * `{参数名: 前缀是否强制}`——模型要**写成文本**的那些参数。
 *
 * 三道筛，缺一不可：
 * - **只有 float**。计数、序号、像素数、比例、开关没有量级可掉，逼模型加引号是纯噪声。
 * - **必须有单位**。
 * - **枚举除外**：一个显式集合已经是精确的，再要求它写 `'5m'` 只会互相打架
 *   （而内核 K1 若不跟着跳过，就会拿去 SI 解析 `"low"`，然后拒掉一次完全合法的调用）。
 */
export function siParams(
  spec: SkillSpec,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
): ReadonlyMap<string, boolean> {
  const out = new Map<string, boolean>()
  for (const p of spec.parameters) {
    if (p.type !== 'float') continue
    if ((p.unit ?? '').trim() === '') continue
    if (p.allowedValues !== undefined && p.allowedValues.length > 0) continue
    out.set(p.name, isStrictParam(p, limits))
  }
  return out
}

/**
 * `allowedValues` 能不能成为真枚举。
 *
 * Python 的判据是 `isinstance(v, (str, int, bool)) and not isinstance(v, float)`——
 * 含浮点的集合**整条失效**，于是 schema 里既没有 `enum` 也没有 `minimum`，
 * 那个约束对模型完全不可见（`validate_params` 仍在执行侧拦，所以不是安全洞，
 * 但模型是撞上去才知道的）。真技能里 0 个参数走这条，照抄不动它。
 *
 * D-SCHEMA-1：JSON 没有 int/float 之分，`1.0` 到了这里就是 `1`。所以 Python 会拒的
 * `[1.0, 2.0]` 在 TS 侧成立。这个差异**不可消除也不可观测**——信息在 JSON 边界就
 * 已经丢了，而 1642 个真参数里 0 个含浮点枚举。
 */
function isRealEnum(vals: readonly (string | number | boolean)[] | undefined): boolean {
  if (vals === undefined || vals.length === 0) return false
  return vals.every((v) => typeof v === 'string' || typeof v === 'boolean' || Number.isInteger(v))
}

/** 枚举的 JSON 类型从**字面量的值**推，不抄 `spec.type`——两者冲突时以值为准。 */
function enumType(
  vals: readonly (string | number | boolean)[],
): 'string' | 'integer' | 'boolean' | undefined {
  if (vals.every((v) => typeof v === 'boolean')) return 'boolean'
  if (vals.every((v) => typeof v === 'string')) return 'string'
  if (vals.every((v) => typeof v === 'number')) return 'integer'
  return undefined // 混合类型：没有单一类型可言，这一键整个不出现
}

/** 模型读到的一个参数。 */
export interface SchemaProperty {
  type?: 'string' | 'integer' | 'number' | 'boolean'
  description?: string
  enum?: readonly (string | number | boolean)[]
  const?: string | number | boolean
  minimum?: number
  maximum?: number
  default?: unknown
}

export interface ToolParameters {
  readonly type: 'object'
  readonly properties: Record<string, SchemaProperty>
  readonly required: string[]
}

/**
 * 把界写成**要求模型使用的那种记法**。
 *
 * strict 的参数被告知要写 `'3p'`，那它的范围就得读作 `1f … 1u`——在那里印
 * 「0 … 0.001」等于用一种这个字段拒收的格式把答案告诉它。
 * 反过来，`formatSi` 从不吐裸尾数（它的输出必须能被解析回去），所以 ±10 V 会渲染成
 * `-10000m … 10000m`：正确，且没法读。1 附近，朴素写法赢。
 */
function showBound(v: number, strict: boolean): string {
  if (v === 0) return '0'
  if (strict) return formatSi(v)
  return Math.abs(v) >= 1e-3 && Math.abs(v) < 1e4 ? formatG(v, 6) : formatSi(v)
}

/** 有量纲参数的描述：原描述 + 范围 + 怎么写。 */
function dimensionedDescription(
  description: string,
  unit: string,
  lo: number | null,
  hi: number | null,
  strict: boolean,
): string {
  const hint: string[] = description !== '' ? [description] : []
  if (lo !== null && hi !== null) {
    hint.push(`范围 ${showBound(lo, strict)} … ${showBound(hi, strict)} ${unit}`)
  } else if (hi !== null) {
    hint.push(`最大 ${showBound(hi, strict)} ${unit}`)
  } else if (lo !== null) {
    hint.push(`最小 ${showBound(lo, strict)} ${unit}`)
  }
  hint.push(
    strict
      ? "**写成带 SI 前缀的字符串**,如 '3p'(=3e-12)、'180n'(=1.8e-7)。" +
          '前缀不可省略 —— 裸数字会被拒绝,因为一个丢了量级的裸数字仍然是合法数字,错一万亿倍也无人察觉。'
      : `**写成字符串**,如 '0.05'、'5e-3' 或带 SI 前缀的 '5m'(单位 ${unit})。`,
  )
  return hint.join(' ')
}

/** 从技能声明生成模型看到的那份工具参数 schema。 */
export function parametersFromSpec(
  spec: SkillSpec,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
): ToolParameters {
  const properties: Record<string, SchemaProperty> = {}
  const required: string[] = []
  const si = siParams(spec, limits)

  for (const p of spec.parameters) {
    // 声明缺省 required 时按**必填**算（与 Python 的 `getattr(spec,"required",True)` 一致）
    const isRequired = p.required ?? true
    if (isRequired) required.push(p.name)

    // 单位后缀在**所有分支之前**加：枚举分支也带着它
    const unit = (p.unit ?? '').trim()
    let description = p.description ?? ''
    if (unit !== '') description = `${description} (unit: ${unit})`.trim()

    const prop: SchemaProperty = {}
    const finish = (): void => {
      if (description !== '') prop.description = description
      if (!isRequired) prop.default = p.default ?? null
      properties[p.name] = prop
    }

    if (isRealEnum(p.allowedValues)) {
      const vals = p.allowedValues as readonly (string | number | boolean)[]
      const t = enumType(vals)
      if (t !== undefined) prop.type = t
      // 单值给 `const` 而不是 `enum`——形状不同，模型读到的也不同
      if (vals.length === 1) prop.const = vals[0]!
      else prop.enum = vals
      finish()
      continue
    }

    const [lo, hi] = effectiveBounds(p, limits)
    const jsonType = TYPE_MAP[p.type] ?? 'string'

    // 有量纲的浮点走**字符串**通道（见本文件抬头）
    if (jsonType === 'number' && unit !== '') {
      prop.type = 'string'
      description = dimensionedDescription(
        description,
        unit,
        lo,
        hi,
        si.get(p.name) ?? isStrictParam(p, limits),
      )
      finish()
      continue
    }

    prop.type = jsonType
    const numeric = jsonType === 'number' || jsonType === 'integer'
    if (numeric && lo !== null) prop.minimum = lo
    if (numeric && hi !== null) prop.maximum = hi
    finish()
  }

  return { type: 'object', properties, required: required.sort() }
}

/**
 * 参数校验失败时模型读到的那段话——`_explain_validation` 的逐字移植。
 *
 * 为什么它必须存在：**dsh 在 `execute` 之前就按 schema 校验参数**（漏了必填、类型
 * 不对、枚举不在集合里），失败时模型读到的是 `invalid arguments: missing required
 * property "x"`。旧仓当年专门挂了这个钩子，理由写在它的 docstring 里：pydantic 的
 * 样板话「不是模型能据此行动的东西」。换成 dsh 之后，同一句样板话换了种语言而已。
 *
 * `precondition_failed:` 这个前缀是**故意**的：StallGuard 按签名聚合重复失败，
 * 一个反复发同一个坏值的模型仍然会升级到强制停止。
 *
 * ⚠️ 两处旧仓自身的不一致，照抄不改：
 * 1. 这里读的是 `p.minValue/maxValue`，**不是 `effectiveBounds`**。所以一个范围
 *    全部来自安全包络的参数（`center_x_m`），描述里写着「范围 -1.5u … 1.5u m」，
 *    这句话里却是「见参数说明」。
 * 2. 枚举这一行**不过滤浮点**（schema 那边会把含浮点的 allowed_values 整条丢掉）。
 *    于是一个 schema 里看不到 enum 的参数，在这段话里反而列出了它的合法值。
 */
export function explainValidationError(
  spec: SkillSpec,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
): string {
  const rows: string[] = []
  for (const p of spec.parameters) {
    // 枚举优先：有显式集合时，**合法值本身就是答案**，印它碰巧落在的数值区间
    // 只是真相里没用的那一半。
    const choices = p.allowedValues
    if (choices !== undefined && choices.length > 0) {
      rows.push(`${p.name} ∈ {${choices.map(pyRepr).join(', ')}}`)
      continue
    }
    const lo = p.minValue ?? null
    const hi = p.maxValue ?? null
    if (lo === null && hi === null) continue
    const u = (p.unit ?? '') !== '' ? ` ${p.unit}` : ''
    rows.push(
      lo !== null && hi !== null
        ? `${p.name} ∈ [${formatG(lo, 3)}, ${formatG(hi, 3)}]${u}`
        : `${p.name} ` +
          (lo !== null ? `≥ ${formatG(lo, 3)}${u}` : `≤ ${formatG(hi as number, 3)}${u}`),
    )
  }
  const allowed = rows.length > 0 ? rows.join('；') : '见参数说明'

  const si = siParams(spec, limits)
  const tick = (n: string): string => `\`${n}\``
  let fmt = ''
  if (si.size > 0) {
    const names = [...si.keys()]
    const strict = names.filter((n) => si.get(n) === true)
    fmt = `注意这些有量纲的参数要**写成字符串**：${names.slice(0, 6).map(tick).join('、')}。`
    if (strict.length > 0) {
      fmt +=
        `其中 ${strict.slice(0, 6).map(tick).join('、')} ` +
        `**必须带 SI 前缀**（如 '3p'、'180n'、'150p'），裸数字会被拒绝。`
    }
  }

  return (
    `[${spec.name}] precondition_failed: 参数超出允许范围。` +
    `允许范围：${allowed}。${fmt}` +
    '这是**数值/单位**问题，不是硬件故障 —— ' +
    "（100 pA = '100p'，1 nA = '1n'，100 nm = '100n' m）。" +
    '**不要重复发送同一个值**；若不确定正确量级，说明情况并结束本回合。'
  )
}

/**
 * Python `repr()` 之于枚举值。
 *
 * 字符串带单引号、布尔是 `True`/`False`——这两条能对上。**数字对不上**：
 * Python 的 `1.0` 印成 `1.0`，而 JSON 里它到了这边就是 `1`（D-SCHEMA-1）。
 * 信息在 JSON 边界就丢了，这里无从恢复。1642 个真参数里 0 个含浮点枚举。
 */
function pyRepr(v: string | number | boolean): string {
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}
