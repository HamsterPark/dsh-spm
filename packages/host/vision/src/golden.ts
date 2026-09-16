/**
 * 金样比对的**归一化规则** —— 「一个逐元素的相对比较不是容差，是抽签」的树形版。
 *
 * ## 规则
 *
 * `numerics.md` 第四节第一条给的是数组的做法：**按 `max|want|` 归一**，
 * 不要逐元素相对比 —— 因为一个近零的输出是**相消**的结果，而相消毁掉相对精度、
 * 不毁绝对精度。
 *
 * 技能的返回值是一棵**树**，不是一个数组，可是同一件事照样成立：
 * `edge_x_m = −0.2 nm` 是由 `cx + (x_px − (nx−1)/2)·nm_per_px` 相消得来的，
 * 在一张 20 nm 的帧上它的绝对误差与 20 nm 那个尺度挂钩，而不是与 0.2 nm 挂钩。
 *
 * ⇒ 所以归一化的分母不是「这一个数」，是「**同一个字段在这批金样里的最大绝对值**」。
 * 那批数就是这个量的尺度 —— 与数组那条规则是同一条，只是把「数组的元素」
 * 换成了「同一字段的各个用例」。
 *
 * ```
 * |actual − want| ≤ tol × max(|want| 在该字段的全部用例上)
 * ```
 *
 * ## 什么**不**按容差比
 *
 * 字符串、布尔、`null`、整数计数 —— 逐字/逐位相等。
 * 字符串尤其要紧：它们里面印着 `%.1f` / `%.0f` 的数，于是**一条字符串断言等于
 * 一条「这个数精确到那一位」的断言**，而且它还顺带钉住了措辞。
 */

/** 金样里 NaN / ±inf 的字符串占位（见导出器的 `_plain`）。 */
export type GoldenValue = unknown

/** 把金样里的占位符还原成数。 */
export function fromGolden(v: unknown): unknown {
  if (v === 'NaN') return NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  if (Array.isArray(v)) return v.map(fromGolden)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = fromGolden(x)
    return out
  }
  return v
}

/** 把 `NaN` / `±Infinity` 换回金样的占位符，好让结构比对能用 `toEqual`。 */
export function toGolden(v: unknown): unknown {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN'
    if (v === Infinity) return 'Infinity'
    if (v === -Infinity) return '-Infinity'
    return v
  }
  if (Array.isArray(v)) return v.map(toGolden)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = toGolden(x)
    return out
  }
  return v
}

/** 遍历一棵树，对每个**数值**叶子调用 `f(path, value)`。 */
function walkNumbers(v: unknown, path: string, f: (path: string, x: number) => void): void {
  if (typeof v === 'number') {
    f(path, v)
    return
  }
  if (Array.isArray(v)) {
    // 数组的下标**不进路径** —— 同一个字段的一串值本来就该共用一个尺度。
    for (const x of v) walkNumbers(x, path, f)
    return
  }
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walkNumbers(x, `${path}.${k}`, f)
  }
}

/** 按字段路径算出归一化尺度：该字段在**整批**金样上的最大绝对值。 */
export function scalesOf(expected: unknown): Map<string, number> {
  const out = new Map<string, number>()
  walkNumbers(expected, '', (path, x) => {
    if (!Number.isFinite(x)) return
    const cur = out.get(path) ?? 0
    if (Math.abs(x) > cur) out.set(path, Math.abs(x))
  })
  return out
}

/** 一处对不上。 */
export interface Mismatch {
  readonly path: string
  readonly actual: unknown
  readonly want: unknown
  readonly diff?: number
  readonly allowed?: number
}

/**
 * 逐叶子比一棵树。数值按 `scales` 归一后用 `tol`；其余**逐字相等**。
 *
 * 返回**全部**对不上的地方（不是第一处）—— 一条只报第一处的断言，
 * 会让「同一个根因的十处」看起来像「十个问题」，而修完第一处又红一次。
 */
export function diffTree(actual: unknown, want: unknown, tol: number, scales: Map<string, number>, path = ''): Mismatch[] {
  const out: Mismatch[] = []
  if (typeof want === 'number' && typeof actual === 'number') {
    if (Number.isNaN(want) !== Number.isNaN(actual)) {
      out.push({ path, actual, want })
      return out
    }
    if (Number.isNaN(want)) return out
    if (!Number.isFinite(want) || !Number.isFinite(actual)) {
      if (want !== actual) out.push({ path, actual, want })
      return out
    }
    // 尺度取「该字段的全批最大绝对值」，退不到就用它自己（那时它就是尺度）。
    // **查表时把数组下标抹掉** —— 与 `scalesOf` 同一个约定：同一个字段的一串值
    // 本来就该共用一个尺度（数组那条规则：按 `max|want|` 归一，不逐元素相对比）。
    const key = path.replace(/\[\d+\]/g, '')
    const scale = Math.max(scales.get(key) ?? 0, Math.abs(want))
    const allowed = tol * scale
    const diff = Math.abs(actual - want)
    if (!(diff <= allowed)) out.push({ path, actual, want, diff, allowed })
    return out
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(actual)) {
      out.push({ path, actual, want })
      return out
    }
    if (actual.length !== want.length) {
      out.push({ path: `${path}.length`, actual: actual.length, want: want.length })
      return out
    }
    want.forEach((w, i) => out.push(...diffTree(actual[i], w, tol, scales, `${path}[${i}]`)))
    return out
  }
  if (want !== null && typeof want === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push({ path, actual, want })
      return out
    }
    const a = actual as Record<string, unknown>
    const w = want as Record<string, unknown>
    const keys = new Set([...Object.keys(a), ...Object.keys(w)])
    for (const k of keys) {
      if (!(k in w)) {
        out.push({ path: `${path}.${k}`, actual: a[k], want: '<缺这个键>' })
        continue
      }
      if (!(k in a)) {
        out.push({ path: `${path}.${k}`, actual: '<缺这个键>', want: w[k] })
        continue
      }
      out.push(...diffTree(a[k], w[k], tol, scales, `${path}.${k}`))
    }
    return out
  }
  if (actual !== want) out.push({ path, actual, want })
  return out
}

/** 把 `Mismatch[]` 印成人能读的一段（进断言消息）。 */
export function formatMismatches(ms: readonly Mismatch[], limit = 12): string {
  const head = ms.slice(0, limit).map((m) => {
    const d = m.diff === undefined ? '' : `（差 ${m.diff.toExponential(3)}，允许 ${(m.allowed ?? 0).toExponential(3)}）`
    return `  ${m.path || '<根>'}: 得到 ${JSON.stringify(m.actual)}，金样 ${JSON.stringify(m.want)}${d}`
  })
  const more = ms.length > limit ? `\n  …还有 ${ms.length - limit} 处` : ''
  return `${ms.length} 处对不上：\n${head.join('\n')}${more}`
}
