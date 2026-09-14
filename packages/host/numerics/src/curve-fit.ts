/**
 * 非线性最小二乘（Levenberg–Marquardt）—— `curve_fit` 的那一半。
 *
 * ## 容差：**不按机器精度写，按「离极小点多远」写**
 *
 * scipy 的 `curve_fit` 走 MINPACK 的 `lmdif`，它有自己的信赖域策略、自己的
 * 变量缩放、自己的停机判据。**两种实现不会收敛到同一串二进制位**，
 * 而要求它们相同是在要求一件没有道理的事。
 *
 * 有道理的是这个：两边都该落进**同一个极小点的不确定域**里。而那个域的大小
 * 由噪声定，金样里录着 `perr = sqrt(diag(pcov))`（scipy 自己算的参数标准差）。
 * 于是判据写成：
 *
 * > 每个参数与 scipy 的差 < **0.05 · perr**（即不确定度的 5%）
 *
 * 外加一条更强的：**残差平方和不比 scipy 的差**（相对 1e-9）。后者才是
 * 最小二乘真正在优化的量 —— 两个不同的参数向量可以有几乎相同的 SSE，
 * 而那时「谁更对」是没有意义的问题。
 *
 * **为什么两条一起要**：只比 SSE 的话，一个跑到别的局部极小的实现也可能
 * 碰巧有相近的 SSE；只比参数的话，一次「几乎没动就停了」会因为初值离真值近
 * 而蒙混过关。
 *
 * ## 数值雅可比
 *
 * 用**中心差分**，步长 `h = max(|p|, 1) · ∛eps ≈ |p| · 6.06e-6`。
 * 前向差分的截断误差是 `O(h)`，中心是 `O(h²)`；而 `∛eps` 正是中心差分
 * 截断误差与舍入误差相等的那一点 —— 不是随手挑的。
 */
import { solveNormalEquations } from './fit.js'
import { EPS, sum } from './stats.js'

/** `f(x, params) → y`。 */
export type Model = (x: number, params: Float64Array) => number

export interface CurveFitResult {
  readonly params: Float64Array
  /** 残差平方和。 */
  readonly sse: number
  readonly iterations: number
  /** 收敛了吗。**没收敛也把结果给出来**，但这个标志要说实话。 */
  readonly converged: boolean
}

/** 中心差分的相对步长：`∛eps`，见文件抬头。 */
const JAC_STEP = Math.cbrt(EPS)

function residuals(model: Model, xs: Float64Array, ys: Float64Array, p: Float64Array): Float64Array {
  const r = new Float64Array(xs.length)
  for (let i = 0; i < xs.length; i += 1) r[i] = (ys[i] as number) - model(xs[i] as number, p)
  return r
}

function sse(r: Float64Array): number {
  const sq = new Float64Array(r.length)
  for (let i = 0; i < r.length; i += 1) sq[i] = (r[i] as number) ** 2
  return sum(sq)
}

/**
 * Levenberg–Marquardt。
 *
 * `ftol` 是**相对**的 SSE 改善阈值：连续一步改善不到这个比例就停。
 * 缺省 `1e-12` —— 比 float64 能分辨的相对改善（`~1e-16`）宽四个数量级，
 * 于是停机是因为「到了」，不是因为「浮点抖不动了」。
 */
export function curveFit(
  model: Model,
  xs: Float64Array | readonly number[],
  ys: Float64Array | readonly number[],
  p0: Float64Array | readonly number[],
  opts: { maxIterations?: number; ftol?: number } = {},
): CurveFitResult {
  const x = Float64Array.from(xs as Iterable<number>)
  const y = Float64Array.from(ys as Iterable<number>)
  if (x.length !== y.length) throw new RangeError(`x 与 y 长度不等：${x.length} vs ${y.length}`)
  const np = p0.length
  if (x.length < np) throw new RangeError(`${x.length} 个点拟合不了 ${np} 个参数`)

  const maxIterations = opts.maxIterations ?? 200
  const ftol = opts.ftol ?? 1e-12
  let p = Float64Array.from(p0 as Iterable<number>)
  let r = residuals(model, x, y, p)
  let cost = sse(r)
  let lambda = 1e-3
  let converged = false
  let it = 0

  for (; it < maxIterations; it += 1) {
    // 雅可比（中心差分），按列存
    const J: Float64Array[] = []
    for (let j = 0; j < np; j += 1) {
      const h = Math.max(Math.abs(p[j] as number), 1) * JAC_STEP
      const pp = Float64Array.from(p)
      const pm = Float64Array.from(p)
      pp[j] = (p[j] as number) + h
      pm[j] = (p[j] as number) - h
      const col = new Float64Array(x.length)
      for (let i = 0; i < x.length; i += 1) {
        col[i] = (model(x[i] as number, pp) - model(x[i] as number, pm)) / (2 * h)
      }
      J.push(col)
    }

    let improved = false
    // 内层：λ 加大到这一步真的下降为止（LM 的信赖域就是这么实现的）
    for (let inner = 0; inner < 30; inner += 1) {
      // (JᵀJ + λ·diag(JᵀJ)) δ = Jᵀr —— Marquardt 的缩放形式，
      // 用对角线而不是单位阵：参数量级差几个数量级时，单位阵那版
      // 会让大参数几乎不动。
      let delta: Float64Array
      try {
        delta = solveDamped(J, r, lambda)
      } catch {
        lambda *= 10
        continue
      }
      const trial = new Float64Array(np)
      for (let j = 0; j < np; j += 1) trial[j] = (p[j] as number) + (delta[j] as number)
      const rt = residuals(model, x, y, trial)
      const ct = sse(rt)
      if (ct < cost) {
        const rel = (cost - ct) / Math.max(cost, Number.MIN_VALUE)
        p = trial
        r = rt
        cost = ct
        lambda = Math.max(lambda / 10, 1e-12)
        improved = true
        if (rel < ftol) converged = true
        break
      }
      lambda *= 10
      if (lambda > 1e12) break
    }
    if (!improved || converged) {
      converged = converged || !improved
      break
    }
  }
  return { params: p, sse: cost, iterations: it + 1, converged }
}

/** 解 `(JᵀJ + λ·diag(JᵀJ)) δ = Jᵀr`。 */
function solveDamped(J: readonly Float64Array[], r: Float64Array, lambda: number): Float64Array {
  const np = J.length
  // 把阻尼折进设计矩阵：给每一列追加一行 `sqrt(λ·(JᵀJ)ⱼⱼ)`，
  // 于是仍然是一个普通的最小二乘 —— 复用 `solveNormalEquations`，
  // 而不是在这里写第二份 Cholesky。
  const diag = new Float64Array(np)
  for (let j = 0; j < np; j += 1) {
    const c = J[j] as Float64Array
    let acc = 0
    for (let i = 0; i < c.length; i += 1) acc += (c[i] as number) ** 2
    diag[j] = acc
  }
  const n = r.length
  const cols: Float64Array[] = []
  for (let j = 0; j < np; j += 1) {
    const ext = new Float64Array(n + np)
    ext.set(J[j] as Float64Array, 0)
    ext[n + j] = Math.sqrt(lambda * Math.max(diag[j] as number, EPS))
    cols.push(ext)
  }
  const b = new Float64Array(n + np)
  b.set(r, 0)
  return solveNormalEquations(cols, b)
}
