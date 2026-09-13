/**
 * L0 技能共用的读包工具。
 *
 * 旧仓那边一次调用的回包是三段信封 `(error_string, raw_bytes, body)`，
 * 我们这一侧 `SkillCallRecord.values` **就是 body**（信封在 `nanonis-wire` 那层
 * 已经拆掉了）。所以这里只处理「body 的第 i 位是不是一个数」。
 *
 * ## D-SKILL-1 · 取不出数就是 `null`，绝不把信封当读数
 *
 * 旧仓有一族技能写的是
 *
 * ```python
 * val = parsed[2][0] if isinstance(parsed, (list, tuple)) and len(parsed) > 2 else parsed
 * ```
 *
 * ——形状判据不成立时走 `else parsed`，**把整个回包当成读数交出去**。
 * `reply_scalar` 的 docstring 把后果写死了：2026-08-13 那次锁机，抖动中收到一个
 * 两段的截断回包 ⇒ `len(parsed) > 2` 为假 ⇒ `('', b'…')` 被当成电流，一路裸写进
 * 状态缓存，再被环境传感器 `float()` 抛成「硬故障」。
 *
 * 旧仓把这一族修到了 `reply_scalar`，但**没修完**——`GetBiasCalibration` /
 * `GetSetpoint` / `GetScanFrame` 等仍在走 `else parsed`（轨迹金样的 `empty@0`
 * 逐条录着：`calibration` 收到的是 `["", "<bytes 0>", []]`）。
 *
 * 我们这一侧一律走 `scalarFloat`：**取不出数就是 `null`**。与 D-STATE-1 同一个
 * 判据、同一个理由——一个「读数」若不表示测量值，就不该以读数的身份存在。
 */
import { pyFloatRepr, scalarFloat, type SkillCallRecord, type SkillResultLike } from 'dsh-spm-kernel'

/** 回包的 body。 */
export function body(rec: SkillCallRecord): readonly unknown[] {
  return rec.values ?? []
}

/** body 的第 i 位当成数。取不出返回 `null`（D-SKILL-1）。 */
export function num(rec: SkillCallRecord, i = 0): number | null {
  return scalarFloat(body(rec)[i])
}

/** body 的第 i 位当成整数。 */
export function int(rec: SkillCallRecord, i = 0): number | null {
  const v = num(rec, i)
  return v === null ? null : Math.trunc(v)
}

/** body 的第 i 位当成布尔（Nanonis 用 0/1）。 */
export function bool(rec: SkillCallRecord, i = 0): boolean | null {
  const v = num(rec, i)
  return v === null ? null : v !== 0
}

/** body 的第 i 位当成字符串表（信号名之类）。 */
export function strList(rec: SkillCallRecord, i = 0): string[] {
  const v = body(rec)[i]
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

/** body 的第 i 位当成数表。 */
export function numList(rec: SkillCallRecord, i = 0): number[] {
  const v = body(rec)[i]
  if (!Array.isArray(v)) return []
  return v.map((x) => scalarFloat(x)).filter((x): x is number => x !== null)
}

/** 失败。`error` 逐字——它是模型读的东西。 */
export function fail(error: string, data?: Record<string, unknown>): SkillResultLike {
  return data === undefined ? { success: false, error } : { success: false, error, data }
}

/** 成功。 */
export function ok(data: Record<string, unknown>, summary?: string): SkillResultLike {
  return summary === undefined ? { success: true, data } : { success: true, data, summary }
}

/**
 * 单动词只读技能的公共形状：调用 → 有 error 就原样透传 → 否则把 body 映成 data。
 *
 * 「原样透传」是有意的：`record.error` 已经带了机器可判前缀
 * （`comms_circuit_open:` / `NanonisError:` / …），再包一层只会把前缀埋掉。
 */
export function readVerb(
  verb: string,
  map: (rec: SkillCallRecord) => SkillResultLike,
  ...args: unknown[]
): (ctx: { safeCall: (m: string, ...a: unknown[]) => Promise<SkillCallRecord> }) => Promise<SkillResultLike> {
  return async (ctx) => {
    const rec = await ctx.safeCall(verb, ...args)
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return map(rec)
  }
}

/**
 * Python 的 `f"{v:.<n>e}"`。
 *
 * JS 的 `toExponential(3)` 给 `7.500e-7`，Python 给 `7.500e-07` —— 指数位数不同。
 * 文案里的坐标必须逐字对得上，因为读它的人要拿去和面板上的数比。
 */
export function pyExp(v: number, digits: number): string {
  const s = v.toExponential(digits)
  const i = s.indexOf('e')
  const mant = s.slice(0, i)
  let exp = s.slice(i + 1)
  const sign = exp.startsWith('-') ? '-' : '+'
  if (exp.startsWith('-') || exp.startsWith('+')) exp = exp.slice(1)
  if (exp.length < 2) exp = `0${exp}`
  return `${mant}e${sign}${exp}`
}

/** 回包里的头两个数（顺带剥 1-元素包裹）。轮询与量起点**共用这一份解析**。 */
export function firstTwoFloats(rec: SkillCallRecord): readonly [number, number] | null {
  const b = body(rec)
  const out: number[] = []
  for (const v of b) {
    const n = scalarFloat(v)
    if (n === null) return null
    out.push(n)
    if (out.length === 2) break
  }
  return out.length >= 2 ? [out[0]!, out[1]!] : null
}

/**
 * Python 的 `str(x)`。
 *
 * 对**浮点数**，Python 的 `str` 与 `repr` 是同一个东西（`str(1.0)` = `'1.0'`），
 * 而 JS 的 `String(1.0)` 给 `'1'`。协议里声明成字符串的位置上，仪器偶尔回一个数
 * （或者合成回包给一个数），两边就此分岔——而这些串是要印给模型看的。
 */
export function pyStr(v: unknown): string {
  return typeof v === 'number' ? pyFloatRepr(v) : String(v)
}
