/**
 * SI 前缀量 —— 数量级由**字母**承载，不由指数承载。
 *
 * 逐字移植自旧仓 `mast/core/si_quantity.py`。行为由 `spec/golden/si_cases.json`
 * 钉住（131 条，含报错原文）。
 *
 * 为什么存在：2026-08-03 真机上，模型被要求 `p_gain=3e-12`，发出来的是 `3`。
 * 它自己的思考块里写的是 3e-12，指数在「想」和「调用工具」之间蒸发了。没有任何东西
 * 拦住它，因为 **`3` 是一个完全合法的浮点数**——错误是静默的，差 10¹² 倍。第二次尝试
 * 给它十进制写法 `0.0000000000030`，发出来的是 `0`，同样合法。
 *
 * 出路是把数量级放进一个**必需的**前缀字母里：`3p` 掉了 `p` 就变成 `3`，而 `3` 在这里
 * 是**解析错误**，不是一个说得通的数。静默的 1e12 误差变成模型看得见、可以重试的拒绝。
 */

/** 前缀 → 因子。**大小写有意义**：`m` 是毫、`M` 是兆——大小写不敏感的解析器会把 3 毫
 *  变成 3 兆，正是本模块要防的那类错误。 */
export const SI_PREFIXES: Readonly<Record<string, number>> = {
  a: 1e-18,
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  'µ': 1e-6, // MICRO SIGN
  'μ': 1e-6, // GREEK SMALL LETTER MU —— 多数键盘打出来的是这个
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
}

/** 前缀组**不是**可选的。整个机制就在这里。 */
const PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*([afpnuµμmkMG])\s*$/

export class SIParseError extends Error {
  override readonly name = 'SIParseError'
}

/** 复刻 Python 的 `repr()`，因为报错原文里嵌了 `{text!r}`，而那些句子是模型读的。
 *  已知偏差见 `spec/deviations.md`：JS 只有一种数字类型，分不出 Python 的 int/float。 */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'string') return `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : !Number.isFinite(v) ? (v > 0 ? 'inf' : '-inf') : String(v)
  return String(v)
}

/** Python 的 `%.{digits}g`。JS 没有等价物：`toPrecision` 留尾零，且切换成指数形式的
 *  阈值也不同（JS 是 exp < -6，Python 是 exp < -4）。
 *
 *  2026-09-09 起对外：课时 1.8b 的实时状态提示块要用 `{bias_v:g}` 印偏压——
 *  它天然在 1 附近，`formatSi` 会印成 `-2000m`，正确但没法看。 */
export function formatG(v: number, digits: number): string {
  // **负零保号**：Python 的 `f"{-0.0:g}"` 是 `-0`，而 JS 的 `String(-0)` 是 `0`。
  // 一个 `-0` 出现在界或读数里，多半意味着上游做了一次乘负或取反 ——
  // 把符号擦掉，就把那条线索也擦掉了。
  if (Object.is(v, -0)) return `-${formatG(0, digits)}`
  if (Number.isNaN(v)) return 'nan'
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf'
  if (v === 0) return '0'
  const sci = v.toExponential(digits - 1)
  const exp = Number(sci.slice(sci.indexOf('e') + 1))
  const strip = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)
  if (exp < -4 || exp >= digits) {
    const mantissa = strip(sci.slice(0, sci.indexOf('e')))
    const abs = Math.abs(exp)
    return `${mantissa}e${exp < 0 ? '-' : '+'}${abs < 10 ? `0${abs}` : abs}`
  }
  return strip(v.toFixed(Math.max(0, digits - 1 - exp)))
}

/**
 * `"3p"` → `3e-12`。其它一律抛 {@link SIParseError}。
 *
 * **刻意没有 `float(text)` 兜底**。有兜底就等于把要防的失败原样放回来：`3p` 变成 `3`
 * 会开开心心解析成功，然后差一万亿倍，而且没人知道。这个函数的全部价值就是它会说不。
 *
 * 裸零也拒绝：零是无量纲的，看着人畜无害，但那天观察到的**第二次**损坏正是把
 * `0.0000000000030` 变成了整整齐齐的 `0`。想表达零就写 `0p`。
 */
export function parseSi(text: unknown, what = '值'): number {
  if (typeof text === 'number') {
    throw new SIParseError(
      `${what} 必须写成带 SI 前缀的字符串(如 '3p'),不能是裸数字 ${pyRepr(text)}。` +
        '裸数字一旦在传输中丢掉指数就变成另一个合法数字且无人察觉 —— ' +
        '前缀掉了则直接解析失败,这正是要求前缀的原因。',
    )
  }
  const s = String(text ?? '').trim()
  const m = PATTERN.exec(s)
  if (!m) {
    throw new SIParseError(
      `${what} = ${pyRepr(text)} 无法解析。必须是「数字 + SI 前缀」,前缀不可省略,` +
        `例如 3p(=3e-12)、180n(=1.8e-07)、150p(=1.5e-10)。` +
        `可用前缀: a f p n u/µ m k M G(**区分大小写**: m=毫, M=兆)。`,
    )
  }
  return Number(m[1]) * SI_PREFIXES[m[2]!]!
}

/**
 * 对这个参数来说，裸尾数（0.1 … 1000）是不可能的值吗？
 *
 * true ⇒ 前缀必需：丢掉指数会产生一个这个参数**永远不可能**合法持有的数，与其让边界
 * 检查成为打字错误和仪器之间唯一的东西，不如直接拒绝。
 * false ⇒ 单位一在这里是合法尺度（伏特、秒、度），`"-2"` 有意义，前缀保持可选。
 * 这类参数仍然走字符串，只是不能拿前缀当数量级校验和。
 *
 * **边界未知一律答 false**：「我们不知道范围」不是「裸数字不可能」的证据。
 */
export function needsStrictPrefix(minValue: number | null, maxValue: number | null): boolean {
  const hi = maxValue === null || maxValue === undefined ? null : Math.abs(maxValue)
  const lo = minValue === null || minValue === undefined ? null : Math.abs(minValue)
  if (hi !== null && hi < 0.1) return true // 整个范围远在单位一**之下**
  if (lo !== null && lo > 1000) return true // 整个范围远在单位一**之上**
  return false
}

/**
 * 解析写成字符串的量。`strict` 要求带 SI 前缀。
 *
 * 非严格档仍然接受前缀（`"5m"`），操作员和模型任何时候都可以写面板形式；它只是**额外**
 * 接受 `"-2"`、`"0.05"`、`"5e-3"`——这些是尺度在一附近的量的自然写法。
 *
 * 真的 number 原样通过。这在模型路径上不是漏洞（工具 schema 声明该字段是 string，模型
 * 发不出 number），它是给本来就持有数字的内部调用者（composite 技能、执行器、测试）用的。
 */
export function parseQuantity(text: unknown, opts: { strict: boolean; what?: string }): number {
  const what = opts.what ?? '值'
  if (typeof text === 'number') return text
  if (opts.strict) return parseSi(text, what)
  const s = String(text ?? '').trim()
  if (!s) throw new SIParseError(`${what} 不能为空。`)
  try {
    return parseSi(s, what)
  } catch {
    // 落到十进制/科学计数法
  }
  // Number() 比 Python 的 float() 宽：它吃 '0x10'、'0b1'、'Infinity'。收窄成 Python 认的形状。
  const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : Number.NaN
  if (!Number.isNaN(n)) return n
  throw new SIParseError(
    `${what} = ${pyRepr(text)} 无法解析。写成数值字符串,可以带 SI 前缀 ` +
      `(如 '5m' = 0.005)也可以是普通十进制/科学计数法(如 '0.05'、'5e-3')。`,
  )
}

/**
 * `3e-12` → `"3p"`。反向用，把存着的值显示回去。
 *
 * 与 {@link parseSi} 往返自洽，所以操作员在界面上读到的就是他能打回去的。六位有效数字
 * 是因为五位不够用——进针时间常数是 16.667 µs，`%.4g` 会渲染成 `16.67u`，每次显示/编辑
 * 循环悄悄丢一位。
 */
export function formatSi(value: number, digits = 6): string {
  if (value === 0) return '0p'
  for (const prefix of ['G', 'M', 'k', '', 'm', 'u', 'n', 'p', 'f', 'a']) {
    const factor = prefix === '' ? 1 : SI_PREFIXES[prefix]!
    const scaled = value / factor
    if (Math.abs(scaled) >= 1 && Math.abs(scaled) < 1000) {
      const mantissa = formatG(scaled, digits)
      // 没有前缀的数量级打不回去（本函数的输出是要能被打回输入框的），降一个数量级。
      if (prefix === '') return `${formatG(Number(mantissa) * 1000, digits)}m`
      return `${mantissa}${prefix}`
    }
  }
  return formatG(value, digits)
}

/**
 * Python 的 `repr(float)`。
 *
 * 文案里出现的数必须逐字对得上，而 JS 的 `String()` 与 Python 的 `repr()`
 * 在两处不同：
 *
 * | 值 | Python | JS |
 * |---|---|---|
 * | `5.0` | `5.0` | `5` |
 * | `5e-8` | `5e-08` | `5e-8` |
 *
 * 前者是整值浮点的小数点，后者是指数位数。两处都会让「请求 5.0」变成
 * 「请求 5」——一个数看起来像整数还是像浮点，在**量级错**的诊断里是有意义的。
 */
export function pyFloatRepr(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : Number.isNaN(v) ? 'nan' : '-inf'
  if (Object.is(v, -0)) return '-0.0' // 同 `formatG`：Python 的 `repr(-0.0)`
  const s = String(v)
  const e = s.indexOf('e')
  if (e < 0) {
    // 整值浮点：Python 印 `5.0`，JS 印 `5`
    return Number.isInteger(v) && !s.includes('.') ? `${s}.0` : s
  }
  const mant = s.slice(0, e)
  let exp = s.slice(e + 1)
  const sign = exp.startsWith('-') ? '-' : '+'
  if (exp.startsWith('-') || exp.startsWith('+')) exp = exp.slice(1)
  if (exp.length < 2) exp = `0${exp}`
  return `${mant}e${sign}${exp}`
}
