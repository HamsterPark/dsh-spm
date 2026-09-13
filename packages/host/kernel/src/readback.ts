/**
 * 「仪器收下我发过去的那个数了吗」—— 判断在**这里**做，不交给模型。
 *
 * ## 2026-08-03：把 3.0 和 3e-12 叫做「在 float32 精度范围内」
 *
 * 那天一个 agent 写了一个 Z 增益、读回来，两个数都摆在它眼前：
 *
 * ```
 * requested  3e-12
 * read back  3.0
 * ```
 *
 * 它的结论是：「p_gain = 3.0（= 3e-12）… 偏差都在 float32 表示精度范围内,
 * 数值通道工作正常。」它**逐项走过一遍**，然后说它们相等。
 *
 * 这不是走神，是结构性的：把指数在发出去的路上丢掉的那个弱点，和把丢掉的指数
 * 在读回来的路上当成完好的，**是同一个弱点**。两次错误同源、同向，于是互相印证
 * 而不是互相抵消，结果是一份自洽的「通道健康」报告，而硬件里握着三米的增益。
 *
 * 所以结论是这个函数算出来的一个布尔值，不符就是技能**失败**。
 * **永远不要把两个数放进工具返回值里问它们一不一样**——被问的那个正是弄错的那个。
 */
import { formatG, pyFloatRepr } from './si.js'

/**
 * 「硬件收下了」的相对容差。
 *
 * Nanonis 在 TCP 上按 **float32** 打包，于是一个 float64 的 `3e-12` 回来是
 * `2.9999999880125916e-12`——相对误差约 `4e-9`。`1e-3` 在这个往返噪声之上六个
 * 数量级，同时照样抓得住任何真的损坏：这里要防的失败是**差 1e12 倍**，不是差 0.1 %。
 *
 * **它不是可选的精细化。** 写成精确相等的话，真机上**每一次**
 * `SetZCtrlGain` / `SetSetpoint` 都会判成「写后回读不一致」、回滚、并且报文里
 * 写着「相差 1 倍」然后叫人别进针——合成回包是精确回显，所以金样一次都照不出来，
 * 是对真 stmsim 的那条缝把它照出来的（2026-09-13）。
 */
export const READBACK_REL_TOL = 1e-3

/** `(ok, detail)`。`detail` 在 ok 时为空串。 */
export interface MatchVerdict {
  readonly ok: boolean
  /** 不符时把**两个值和它们的比值**都说出来，而不是留给人再算一遍。 */
  readonly detail: string
}

/** Python 的 `math.isclose(a, b, rel_tol, abs_tol=0.0)`。 */
function isClose(a: number, b: number, relTol: number): boolean {
  if (a === b) return true // ±inf 与两个零都走这里
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= relTol * Math.max(Math.abs(a), Math.abs(b))
}

/**
 * 仪器收下我们发过去的那个数了吗。
 *
 * 非数（`null` / 字符串 / `NaN`）一律**不符**：「读不到」不是「一样」。
 */
export function valuesMatch(
  requested: unknown,
  actual: unknown,
  relTol: number = READBACK_REL_TOL,
): MatchVerdict {
  const pair = bothNumbers(toFloat(requested), toFloat(actual))
  if (pair === null) {
    return { ok: false, detail: `无法比较: 请求 ${repr(requested)}, 读回 ${repr(actual)}` }
  }
  const [want, got] = pair
  if (Number.isNaN(want) || Number.isNaN(got)) {
    return { ok: false, detail: `请求 ${repr(requested)}, 读回 ${repr(actual)}(NaN 不可比较)` }
  }
  if (isClose(want, got, relTol)) return { ok: true, detail: '' }
  if (want === 0) return { ok: false, detail: `请求 0, 读回 ${pyFloatRepr(got)}` }
  return {
    ok: false,
    detail: `请求 ${pyFloatRepr(want)}, 读回 ${pyFloatRepr(got)}(相差 ${formatG(got / want, 3)} 倍)`,
  }
}

/**
 * 两边都得是数。**「读不到」不是「一样」** —— 一个 `null` 回读绝不能被当成
 * 「硬件收下了」，那正是回读这件事要防的东西。
 *
 * 写成返回一对而不是一个布尔，是为了让这道闸**拆得开**：判断写在 `if` 里时，
 * 下游的类型收窄就挂在它身上，把它改成永远为假会让 `tsc` 直接报错——
 * 而一条编不过的变异什么都没验（本仓第四次撞上）。
 */
function bothNumbers(a: number | null, b: number | null): [number, number] | null {
  return a === null || b === null ? null : [a, b]
}

/** Python 的 `float(x)`：认 number 与能整串解析的字符串，别的给 `null`。 */
function toFloat(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null
    return Number(s)
  }
  return null
}


/** `{x!r}` —— 只在「无法比较」那一句里用，所以够用就好。 */
function repr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'number') return pyFloatRepr(v)
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}
