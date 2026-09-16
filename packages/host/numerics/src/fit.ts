/**
 * 最小二乘：平面、二维多项式、RANSAC —— **容差由条件数决定，不由我决定**。
 *
 * ## 容差：`64 · κ(A)² · eps`（系数的相对误差）
 *
 * numpy 的 `lstsq` 走 **SVD**，误差按 `κ(A) · eps`；这里走**正规方程**
 * （`AᵀA x = Aᵀb`，Cholesky 解），而正规方程**把条件数平方**：
 * `κ(AᵀA) = κ(A)²`。
 *
 * 金样里把 `κ(A)` 一起录了下来，于是这条容差是**可验算的**，不是一句声明：
 *
 * - 平面（3 列）：`κ = 33.6` ⇒ `κ² · eps = 2.5e-13`，留 64 倍余量 ⇒ `1.6e-11`
 * - 二维二次（6 列）：`κ = 931.8` ⇒ `κ² · eps = 1.9e-10`（`x²` 与 `x` 的量级
 *   差一个 `w`，条件数随之涨）
 *
 * ## 实测比这个界好得多 —— 而那一条也钉住了
 *
 * 两格实测的最坏相对差都是 **`0.5 · κ · eps`**（平面 `3.7e-15`、多项式
 * `1.2e-13`），也就是**没有平方**：这两个系统还远没到正规方程开始吃亏的地方。
 *
 * 所以测试里有两条断言而不是一条：
 *
 * 1. 落在 `64 · κ² · eps` 里 —— 那是**这个算法的保证**，对调用方可能送进来的
 *    任何设计矩阵都成立；
 * 2. 落在 `4 · κ · eps` 里 —— 那是**现在实际达到的水平**。
 *
 * 只留第一条的话，这一格有六千倍余量，等于什么都没测；只留第二条的话，
 * 哪天真来了一个病态基组，一次合法的精度退化会被当成回归。**两条各管一件事。**
 *
 * **为什么不直接写 SVD**：正规方程在 3–6 列上又快又短，而这一层的调用方
 * （扣背景、找倾斜）的设计矩阵是几何坐标 —— 条件数由图的尺寸决定。
 * 等哪天有人拿它去拟合一个病态的基组，再换 SVD，**并且那时这两条都要跟着改**。
 *
 * ## RANSAC 的判据不是「等于哪个数」
 *
 * 它是随机算法：同一份输入、同一个种子给同一个答案（见 `rng.ts`），
 * 但换个种子答案会动一点。所以金样录的是**两个参照**——
 * 「只用内点拟合」的系数与「全都用上」的系数 —— 判据是
 * **离前者近、离后者远**。那才是这个算法要保证的事。
 */
import { matAt, type Mat } from './mat.js'
import { Xoshiro128 } from './rng.js'
import { EPS } from './stats.js'

/**
 * 正规方程解的**保证**：`64 · κ² · eps`。对任何设计矩阵都成立。见文件抬头。
 */
export function lstsqRelTol(cond: number): number {
  return 64 * cond * cond * EPS
}

/**
 * 正规方程解**现在实际达到的水平**：`4 · κ · eps`（没有平方）。
 *
 * 它比 {@link lstsqRelTol} 紧得多，而两条都在测试里 —— 理由见文件抬头那一节。
 * 哪天它红了，先去看是不是有人送进来一个病态的基组：那时该改的是这一条，
 * 不是上面那条。
 */
export function lstsqObservedTol(cond: number): number {
  return 4 * cond * EPS
}

/**
 * 对称正定矩阵的 Cholesky 分解 `M = L·Lᵀ`，`M` 按**行优先** `p×p` 给，回下三角 `L`。
 *
 * **不满秩就抛** —— 一个不满秩的系统解出来的是「某一个解」，而调用方会把它当成
 * 「那个解」。抛出来的消息里带主元与它的位置：一个「第 3 个主元是 −2e−17」
 * 与一个「第 0 个主元是 0」说的不是同一件事。
 *
 * 抽出来是因为它有**两个**调用方（{@link solveNormalEquations} 解方程、
 * `curve-fit.ts` 的 `pcov` 求逆），而这两件事只有最后一步不同。
 * 按 `filters.ts` 抬头那条：一样的东西别写两遍；**长得像但语义不同的才要分**，
 * 而这两处的语义是同一件（同一个矩阵的同一个分解）。
 */
export function cholesky(M: Float64Array, p: number): Float64Array {
  const L = new Float64Array(p * p)
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let acc = M[i * p + j] as number
      for (let k = 0; k < j; k += 1) acc -= (L[i * p + k] as number) * (L[j * p + k] as number)
      if (i === j) {
        if (!(acc > 0)) {
          throw new RangeError(`设计矩阵不满秩（Cholesky 第 ${i} 个主元 ${acc}）—— 解不唯一`)
        }
        L[i * p + i] = Math.sqrt(acc)
      } else {
        L[i * p + j] = acc / (L[j * p + j] as number)
      }
    }
  }
  return L
}

/**
 * 解 `AᵀA x = Aᵀb`（Cholesky）。`A` 按**列表**给：`cols[j][i]` 是第 i 行第 j 列。
 *
 * 不满秩就抛 —— 一个不满秩的设计矩阵解出来的系数是「某一个解」，
 * 而调用方会把它当成「那个解」。
 */
export function solveNormalEquations(cols: readonly Float64Array[], b: Float64Array): Float64Array {
  const p = cols.length
  if (p === 0) throw new RangeError('设计矩阵一列都没有')
  const n = b.length
  for (const c of cols) {
    if (c.length !== n) throw new RangeError(`设计矩阵各列长度不齐：${c.length} vs ${n}`)
  }
  // AᵀA（对称）与 Aᵀb
  const M = new Float64Array(p * p)
  const y = new Float64Array(p)
  for (let i = 0; i < p; i += 1) {
    const ci = cols[i] as Float64Array
    for (let j = i; j < p; j += 1) {
      const cj = cols[j] as Float64Array
      let acc = 0
      for (let k = 0; k < n; k += 1) acc += (ci[k] as number) * (cj[k] as number)
      M[i * p + j] = acc
      M[j * p + i] = acc
    }
    let acc = 0
    for (let k = 0; k < n; k += 1) acc += (ci[k] as number) * (b[k] as number)
    y[i] = acc
  }
  return choleskySolve(M, y, p)
}

/**
 * 解对称正定的 `M x = y`（Cholesky 分解 + 前代 + 回代）。`M` 行优先 `p×p`。
 *
 * 与 {@link solveNormalEquations} 的区别是**谁来形成那个矩阵**：那一个从设计矩阵
 * 的列算出 `AᵀA`，这一个收的已经是矩阵本身。`savgol.ts` 要的正是后者
 * （它要解的 `AAᵀ` 不是任何一组列的正规方程矩阵），而两者共用这一份前代回代。
 */
export function choleskySolve(M: Float64Array, y: Float64Array, p: number): Float64Array {
  const L = cholesky(M, p)
  const z = new Float64Array(p)
  for (let i = 0; i < p; i += 1) {
    let acc = y[i] as number
    for (let k = 0; k < i; k += 1) acc -= (L[i * p + k] as number) * (z[k] as number)
    z[i] = acc / (L[i * p + i] as number)
  }
  const x = new Float64Array(p)
  for (let i = p - 1; i >= 0; i -= 1) {
    let acc = z[i] as number
    for (let k = i + 1; k < p; k += 1) acc -= (L[k * p + i] as number) * (x[k] as number)
    x[i] = acc / (L[i * p + i] as number)
  }
  return x
}

/** 平面 / 多项式拟合的设计矩阵列。`x` 是列号、`y` 是行号（像素坐标，不是米）。 */
function designColumns(rows: number, cols: number, terms: readonly ((x: number, y: number) => number)[]): Float64Array[] {
  const n = rows * cols
  const out = terms.map(() => new Float64Array(n))
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      for (let t = 0; t < terms.length; t += 1) {
        ;(out[t] as Float64Array)[i] = (terms[t] as (x: number, y: number) => number)(c, r)
      }
    }
  }
  return out
}

/** 平面的三项：`1, x, y`。 */
const PLANE_TERMS = [() => 1, (x: number) => x, (_x: number, y: number) => y] as const

/** 二维二次的六项：`1, x, y, x², xy, y²`。**顺序就是系数的顺序**。 */
const POLY2_TERMS = [
  () => 1,
  (x: number) => x,
  (_x: number, y: number) => y,
  (x: number) => x * x,
  (x: number, y: number) => x * y,
  (_x: number, y: number) => y * y,
] as const

/** 拟合一个平面，给 `[c, cx, cy]`（`z ≈ c + cx·x + cy·y`）。 */
export function fitPlane(m: Mat): Float64Array {
  return solveNormalEquations(designColumns(m.rows, m.cols, PLANE_TERMS), m.data)
}

/** 拟合二维二次多项式，给六个系数（顺序见 `POLY2_TERMS`）。 */
export function fitPoly2d(m: Mat): Float64Array {
  return solveNormalEquations(designColumns(m.rows, m.cols, POLY2_TERMS), m.data)
}

/** 按系数求值（同 `fitPlane` / `fitPoly2d` 的项顺序）。 */
export function evalPlane(coef: Float64Array, x: number, y: number): number {
  return (coef[0] as number) + (coef[1] as number) * x + (coef[2] as number) * y
}

export interface RansacResult {
  readonly coef: Float64Array
  /** 每个像素是不是内点。**行优先展平**，与 `Mat.data` 同序。 */
  readonly inliers: Uint8Array
  readonly nInliers: number
  readonly iterations: number
}

/**
 * RANSAC 平面拟合。**可种子** —— 见 `rng.ts` 抬头那段。
 *
 * `threshold` 是残差的绝对阈值，单位与 `z` 相同。**没有缺省值**：
 * 「多远算离群」只有调用方知道（一张原子分辨的图与一张几百 nm 的形貌图
 * 差着好几个数量级），而随手给一个缺省会让它在错误的量级上悄悄工作。
 */
export function ransacPlane(
  m: Mat,
  threshold: number,
  opts: { iterations?: number; seed?: number } = {},
): RansacResult {
  if (!(threshold > 0)) throw new RangeError(`RANSAC 的 threshold 必须为正：得到 ${threshold}`)
  const n = m.rows * m.cols
  if (n < 3) throw new RangeError(`RANSAC 平面至少要 3 个点，实得 ${n}`)
  const iterations = opts.iterations ?? 200
  const rng = new Xoshiro128(opts.seed ?? 1)
  const cols = designColumns(m.rows, m.cols, PLANE_TERMS)

  let bestMask: Uint8Array | null = null
  let bestCount = -1
  for (let it = 0; it < iterations; it += 1) {
    const pick = rng.sample(n, 3)
    // 三点定一个平面。共线（含重合）时 Cholesky 会抛，跳过这一次抽样 ——
    // **不是失败**：抽到三个共线的点只是这一轮没用。
    let coef: Float64Array
    try {
      coef = solveNormalEquations(
        cols.map((c) => Float64Array.from(pick.map((i) => c[i] as number))),
        Float64Array.from(pick.map((i) => m.data[i] as number)),
      )
    } catch {
      continue
    }
    const mask = new Uint8Array(n)
    let count = 0
    for (let r = 0; r < m.rows; r += 1) {
      for (let c = 0; c < m.cols; c += 1) {
        const i = r * m.cols + c
        if (Math.abs((m.data[i] as number) - evalPlane(coef, c, r)) <= threshold) {
          mask[i] = 1
          count += 1
        }
      }
    }
    if (count > bestCount) {
      bestCount = count
      bestMask = mask
    }
  }
  if (bestMask === null || bestCount < 3) {
    throw new RangeError(`RANSAC 没找到 ≥3 个内点（阈值 ${threshold}）—— 阈值可能比噪声还小`)
  }
  // **用全部内点再拟合一次**：三点定的那个平面只是用来筛内点的，
  // 拿它当结果等于扔掉了其余几百个点的信息。
  const idx: number[] = []
  for (let i = 0; i < n; i += 1) if (bestMask[i] === 1) idx.push(i)
  const coef = solveNormalEquations(
    cols.map((c) => Float64Array.from(idx.map((i) => c[i] as number))),
    Float64Array.from(idx.map((i) => m.data[i] as number)),
  )
  return { coef, inliers: bestMask, nInliers: bestCount, iterations }
}

/** 扣掉一个平面（`z − 拟合值`）。 */
export function subtractPlane(m: Mat, coef: Float64Array): Float64Array {
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      out[r * m.cols + c] = matAt(m, r, c) - evalPlane(coef, c, r)
    }
  }
  return out
}
