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
 *
 * ## `pcov`（参数协方差）的容差：**由「参数离 scipy 多远」定，不由机器精度定**
 *
 * `pcov = (JᵀJ)⁻¹ · sse/(n−p)`，两个因子各自贡献多少：
 *
 * 1. **`sse/(n−p)`**：同一个文件里已有一条断言 ——「SSE 不比 scipy 的差，相对 `1e-9`」，
 *    而 SSE 在极小点附近是**二次**的，所以两边的 SSE 相对差 ≤ `1e-9`。
 *    贡献到 `perr = √diag` 上是 `5e-10`，**可以忽略**。
 * 2. **`(JᵀJ)⁻¹`**：J 在**我们的** p 上算、scipy 在**它的** p 上算，而
 *    「每个参数与 scipy 的差 < `0.05·perr`」也已经断言过了。J 的元素是 `∂f/∂pⱼ`，
 *    它随 p 变化的自然尺度就是参数自己的尺度 `|p|`，于是
 *    `ΔJ/J ≲ |Δp|/|p| < 0.05 · max(perrᵢ/|pᵢ|)`，而 `Δperr/perr ≲ ΔJ/J`。
 *
 * 于是 {@link pcovRelTol}`(relStep) = 4 · 0.05 · relStep`，`relStep = max(perrᵢ/|pᵢ|)`
 * **从金样自己算出来**（同 `lstsqRelTol(cond)` 的写法 —— 一条可验算的容差，
 * 不是一句声明）。这一格金样上 `relStep = 9.8e-3` ⇒ 容差 `2.0e-3`。
 *
 * **它必须比什么紧**：把分母从 `n−p` 写成 `n` 是这一件最容易犯的错，而它让
 * `perr` 差 `√(n/(n−p)) − 1 = 2.6e-2`（n=80、p=4）。容差 `2.0e-3` 比它紧 **13 倍**，
 * 所以那个错会被照出来。测试里另有一条**结构性**的断言直接钉这件事：
 * 与「用 n−p」的距离必须比与「用 n」的距离小 —— 那一条不依赖任何容差
 * （同 `ransacPlane` 的「离对的近、离错的远」）。
 *
 * **这一件没有零容差的孪生，而那是有理由的**：`pcov` 是 `params` 的函数，
 * 而 `params` 本身就不是零容差的（两种 LM 不会收敛到同一串二进制位）。
 * 一个建立在有容差的量之上的量，不可能逐位。说得出这一点，比硬凑一条零容差断言有用。
 */
import { cholesky, solveNormalEquations } from './fit.js'
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
  /**
   * 参数协方差 `(JᵀJ)⁻¹·sse/(n−p)`，**行优先 p×p**。同 scipy 的
   * `curve_fit(..., absolute_sigma=False)` 回的第二个返回值。
   *
   * **自由度不够或 `JᵀJ` 不满秩时全是 `Infinity`**（同 scipy），不是 0、不是抛：
   * 「这个参数的不确定度是无穷大」是一个真实的、可读的答案，而一个 0
   * 会被读成「钉死了」。
   */
  readonly pcov: Float64Array
  /**
   * 每个参数的标准差 `√diag(pcov)` —— 拟合报告里那根误差棒。
   *
   * 它和 `params` 一起给，因为**一个不带误差棒的拟合值不是一个测量结果**：
   * `E_peak = 0.312 eV` 与 `E_peak = 0.312 ± 0.180 eV` 在下游会得出相反的结论，
   * 而两者在一个只回 `params` 的接口里长得一模一样。
   */
  readonly perr: Float64Array
}

/** 中心差分的相对步长：`∛eps`，见文件抬头。 */
const JAC_STEP = Math.cbrt(EPS)

/** 拟合参数与 scipy 相比的判据：差 < `0.05·perr`。见文件抬头。 */
export const CURVE_FIT_PARAM_FRACTION = 0.05

/**
 * `pcov` / `perr` 与 scipy 比时该用的相对容差。见文件抬头那一节。
 *
 * `relStep` 是**参数自己的相对不确定度里最大的那个**（`max(perrᵢ/|pᵢ|)`），
 * 从金样算得出来 —— 于是这条容差是可验算的，不是一句声明。
 */
export function pcovRelTol(relStep: number): number {
  return 4 * CURVE_FIT_PARAM_FRACTION * relStep
}

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

/** 雅可比（中心差分），**按列存**：`J[j][i] = ∂f(xᵢ)/∂pⱼ`。见文件抬头。 */
function jacobian(model: Model, x: Float64Array, p: Float64Array): Float64Array[] {
  const J: Float64Array[] = []
  for (let j = 0; j < p.length; j += 1) {
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
  return J
}

/**
 * `pcov = (JᵀJ)⁻¹ · sse/(n−p)`，**J 在最终参数上重算一遍**。
 *
 * 不复用循环里最后那一份 J：那一份是在**上一步的** p 上算的，而 p 之后又动过。
 * 差别很小（最后一步的改善 < `ftol`），但「几乎对」的协方差与「对」的协方差
 * 在报告里长得一模一样，而重算一次只多 `2p` 次模型求值。
 *
 * `n − p ≤ 0` 或 `JᵀJ` 不满秩 ⇒ 全 `Infinity`（同 scipy）。
 */
function covariance(J: readonly Float64Array[], cost: number, n: number): Float64Array {
  const np = J.length
  const out = new Float64Array(np * np)
  const dof = n - np
  if (dof <= 0) return out.fill(Infinity)
  // JᵀJ（对称）
  const M = new Float64Array(np * np)
  for (let i = 0; i < np; i += 1) {
    const ci = J[i] as Float64Array
    for (let j = i; j < np; j += 1) {
      const cj = J[j] as Float64Array
      let acc = 0
      for (let k = 0; k < n; k += 1) acc += (ci[k] as number) * (cj[k] as number)
      M[i * np + j] = acc
      M[j * np + i] = acc
    }
  }
  let L: Float64Array
  try {
    L = cholesky(M, np)
  } catch {
    return out.fill(Infinity)
  }
  // L⁻¹（下三角，前代），然后 (JᵀJ)⁻¹ = L⁻ᵀL⁻¹ ⇒ inv[i][j] = Σₖ Linv[k][i]·Linv[k][j]。
  // **写成这个和而不是逐列解方程**：这样对称性是构造出来的，不是碰巧成立的 ——
  // 一个不对称的协方差矩阵会让「参数 i 与 j 的相关系数」随取的是哪一半而变。
  const Linv = new Float64Array(np * np)
  for (let c = 0; c < np; c += 1) {
    Linv[c * np + c] = 1 / (L[c * np + c] as number)
    for (let i = c + 1; i < np; i += 1) {
      let acc = 0
      for (let k = c; k < i; k += 1) acc -= (L[i * np + k] as number) * (Linv[k * np + c] as number)
      Linv[i * np + c] = acc / (L[i * np + i] as number)
    }
  }
  const s2 = cost / dof
  for (let i = 0; i < np; i += 1) {
    for (let j = 0; j < np; j += 1) {
      let acc = 0
      for (let k = Math.max(i, j); k < np; k += 1) {
        acc += (Linv[k * np + i] as number) * (Linv[k * np + j] as number)
      }
      out[i * np + j] = acc * s2
    }
  }
  return out
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
    const J = jacobian(model, x, p)

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
  const pcov = covariance(jacobian(model, x, p), cost, x.length)
  const perr = new Float64Array(np)
  for (let j = 0; j < np; j += 1) perr[j] = Math.sqrt(pcov[j * np + j] as number)
  return { params: p, sse: cost, iterations: it + 1, converged, pcov, perr }
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
