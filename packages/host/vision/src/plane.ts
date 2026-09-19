/**
 * K2 平面族 —— 旧仓 `mast/vision/tilt.py` 的 `noise_floor`(22) + `_lstsq_plane`(14)
 * + `fit_plane_robust`(65) + `plane_subtract`(12)，外加 `mast/data/processors.py`
 * 的那一份 **OLS** `plane_subtract`(11)。
 *
 * ## 两个 `plane_subtract`，**行为不同**，所以不许合并
 *
 * | | 拟合 | 内点阈 | 谁在调 |
 * |---|---|---|---|
 * | `planeSubtractOls`（`data/processors`） | 全部像素的最小二乘 | 没有内点这回事 | `ExtractClusters` 的 `level='plane'`、`AssessClusterRoundness` |
 * | `planeSubtractRobust`（`vision/tilt`） | RANSAC + 内点重拟合 | **3 × 噪声底**，自适应 | `AssessFrameTrust`、`MeasureStepHeight` |
 *
 * 这是 D-CHANNELS-1 / D-NUM-9 的形状：两个同名函数，合并会**默默改掉每一张图的数**。
 * 台阶上的点在稳健那一版里是**外点**（于是台阶被完整保留），在 OLS 那一版里
 * 参与拟合（于是一列规则台阶在最小二乘意义下**就是**一个斜面，会被整个减掉）。
 *
 * ## 为什么不能用 `numerics.ransacPlane` 顶掉 `fitPlaneRobust`（本批核出来的）
 *
 * 三处语义不同，每一处都会悄悄改数：
 *
 * 1. **内点判据是 `<` 不是 `<=`**（旧仓 `resid < thresh`，numerics 是 `<= threshold`）。
 *    在合成的无噪数据上这一个字符决定了内点是全部还是零个；
 * 2. **`numerics.ransacPlane` 不认 NaN** —— 它在整张 `Mat` 上算残差，而真机的
 *    半张图是 NaN。旧仓先 `finite` 掩膜再抽样，抽样空间本身就不含 NaN；
 * 3. **阈值是算出来的，不是传进来的**：`3 × noiseFloor(arr)`，而 `noiseFloor`
 *    为 0 时还有一条「按高度尺度导出一个小阈值」的退路。少了那条退路，
 *    合成的无噪帧上 `|r| < 0` 永远不成立 ⇒ 一个内点都找不到。
 *
 * ⇒ 这里自己写一份，**并在交接里记一笔**：不是「numerics 不好用」，是这两件
 * 事本来就不是同一件（`numerics-2.md` 第五节第三条的那半）。
 *
 * ## 容差
 *
 * | 件 | 对的是 | 容差 | 为什么 |
 * |---|---|---|---|
 * | `noiseFloor` | `tilt.noise_floor` | **0** | 一次差分 + 两次取中位数 + 两次乘除，全是闭式；中位数只搬数 |
 * | `lstsqPlane` / `planeSubtractOls` | `np.linalg.lstsq` | `lstsqObservedTol(κ)` | 本仓**中心化之后**走正规方程（κ≈1，误差 `eps`），numpy 走 SVD（误差 `κ·eps`）—— **大的那一边是 numpy**。κ 由导出器随金样一起录 |
 * | `fitPlaneRobust` 的 `inlierRatio` | 同上 | **0** | 它是**两个整数的比**。见下面那条 deviation |
 * | `fitPlaneRobust` 的 `a/b/c` | 同上 | `lstsqObservedTol(κ)` | 内点集相同 ⇒ 精拟合就是同一个最小二乘 |
 *
 * ## ⚠️ RANSAC 抽样序列与 numpy **不一致**，判据因此换了一条
 *
 * 旧仓用 `np.random.default_rng(42)`（PCG64），本仓用 `Xoshiro128`（D-NUM-7）。
 * 两边抽到的三点子集不同 ⇒ **best_plane 不同**。
 *
 * 但结果仍然可以逐条比，理由是这个算法的**第二步**：三点解只用来筛内点，
 * 真正的答案是「用全部内点再拟合一次」。所以判据是
 *
 * > **内点集相同 ⇒ 精拟合相同（到 lstsq 的容差）。**
 *
 * 而「内点集相同」由 `inlierRatio` 逐位相等钉住 —— 它是整数比，容差 0，
 * 不相等就当场红。金样的输入刻意让**最大台面唯一**（面积不并列）：并列时
 * `count > best_count` 保留的是**先抽到的那个**，而「先抽到谁」正是两边不同的
 * 那件事。这不是把判据放松，是把它换成一条**两边都成立**的。
 */
import { lstsqObservedTol, matAt, matOf, npMean, solveNormalEquations, Xoshiro128, type Mat } from 'dsh-spm-numerics'
import { lstsqQr } from './lsq.js'
import { finiteOf, nanMax, nanMin, npMedian } from './nd.js'

/**
 * RANSAC **下游**那一族对旧仓的相对容差。**只用在这一族**，别处各按各的。
 *
 * ## 为什么这一族不能逐位比
 *
 * 三点假设只是搜索启发式，真正的答案是「用全部内点重拟合」。两边抽到的三点子集
 * 不同 ⇒ 那个假设平面不同 ⇒ **落在带边缘上的若干点归属不同** ⇒ 重拟合的
 * 输入集差几个点。
 *
 * 实测（128×128 的台面帧，`sigma=None`）：内点率 `0.390625` 对 `0.390380859375`，
 * 差 **4 个点 / 16384**；由此 `std` 的相对差 `4.7e-5`。
 *
 * ## 这个数怎么来的
 *
 * 上界写得出来：Δn 个点各自的残差按定义 ≤ `thresh = 3σ`，重拟合是内点集上的最小二乘，
 * 于是统计量的相对变化不超过 `(Δn/n) · 3σ / z 的量程` 量级 —— 上面那一格是
 * `(4/16384) · (14.7pm/480pm) ≈ 7e-6`，而**实测 4.7e-5**（差一个数量级，
 * 因为几个边缘点正好落在角上、对斜率的杠杆最大）。
 *
 * `1e-3` 是实测最坏值的 **20 倍余量**，与 `convRelTol` 那条（41 倍）同一个口径。
 *
 * ## ⚠️ 想要逐位，就**别让它抽签**
 *
 * 给一个显式的 `sigma`，大到「整个台面都在带内、而隔壁台面都在带外」——
 * 那时**每一个**够好的三点假设都圈出同一个内点集，重拟合于是逐位相同。
 * 金样里 `terraces_sigma60pm` 那一格就是这么造的，它按 {@link planeRelTol} 比。
 *
 * > 「一组分辨不出两种候选的金样，不是判据」的反面：
 * > **一组容差盖得住一切的金样，也不是判据。** 所以两格都留着。
 */
export const RANSAC_REL_TOL = 1e-3

/** MAD → σ 的一致性因子（高斯分布下 `σ = 1.4826 × MAD`）。 */
export const MAD_TO_SIGMA = 1.4826

/** RANSAC 的内点阈 = 这个倍数 × 噪声底。3σ 覆盖 99.7% 的高斯噪声。 */
export const RANSAC_SIGMA_MULT = 3.0

/** RANSAC 迭代次数。 */
export const RANSAC_TRIALS = 200

/** 与旧仓同一个种子。**换种子 = 换一份金样**，要当成一次有意的改动。 */
export const RANSAC_SEED = 42

/**
 * 从**行内**相邻像素差分估计噪声底（与输入同单位）。
 *
 * 行内差分把任何低频成分（倾斜、台阶包络、曲率）差掉，剩下的才是逐点噪声；
 * 除以 `√2` 是因为两个独立噪声样本相减方差翻倍。用 MAD 不用标准差，
 * 因为台阶跨过的那些像素在差分里是巨大的离群值。
 */
export function noiseFloor(m: Mat): number {
  if (m.cols < 2) return 0
  const diffs: number[] = []
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 1; c < m.cols; c += 1) {
      const d = matAt(m, r, c) - matAt(m, r, c - 1)
      if (Number.isFinite(d)) diffs.push(d)
    }
  }
  if (diffs.length === 0) return 0
  const med = npMedian(diffs)
  const mad = npMedian(diffs.map((d) => Math.abs(d - med)))
  return (mad * MAD_TO_SIGMA) / Math.SQRT2
}

/**
 * `z ≈ a·x + b·y + c` 的最小二乘解，**点表形式**。点少于 3 个或解不出给 `null`。
 *
 * ## 为什么要**先把 x / y 中心化**
 *
 * 旧仓走 `np.linalg.lstsq`（SVD），本仓走正规方程 —— 而正规方程**把条件数平方**。
 * 一张 128×128 的图，裸设计矩阵 `[x, y, 1]` 的 κ 在 `10³` 量级
 * （列 `x`、`y` 的均值 63.5 与常数列几乎共线），平方之后 `10⁶`，
 * 误差界 `64·κ²·eps ≈ 10⁻⁸` —— 对一个要跟 numpy 比到最后几位的量，那不是容差。
 *
 * 中心化之后三列**互相正交**（`Σx' = Σy' = 0`，全网格上还有 `Σx'y' = 0`），
 * κ 掉到个位数，正规方程的误差退回 `eps` 量级。斜率 `a`/`b` 不受平移影响，
 * 截距按 `c = c' − a·x̄ − b·ȳ` 还原 —— 数学上是同一个平面。
 *
 * ⇒ 于是两边之差由**numpy 那一侧**主导（SVD 在 κ≈10³ 上的 `κ·eps`），
 * 而那正是 `lstsqObservedTol(κ)` 说的那个数。κ 由导出器随金样录下来
 * （`condition_numbers`），不写死。
 */
export function lstsqPlane(
  xs: readonly number[] | Float64Array,
  ys: readonly number[] | Float64Array,
  zs: readonly number[] | Float64Array,
): [number, number, number] | null {
  const n = zs.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i += 1) {
    mx += (xs as readonly number[])[i] as number
    my += (ys as readonly number[])[i] as number
  }
  mx /= n
  my /= n
  const cx = new Float64Array(n)
  const cy = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    cx[i] = ((xs as readonly number[])[i] as number) - mx
    cy[i] = ((ys as readonly number[])[i] as number) - my
  }
  const c1 = new Float64Array(n).fill(1)
  try {
    const sol = solveNormalEquations([cx, cy, c1], Float64Array.from(zs as readonly number[]))
    const a = sol[0] as number
    const b = sol[1] as number
    const c = (sol[2] as number) - a * mx - b * my
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null
    return [a, b, c]
  } catch {
    return null
  }
}

/** 稳健平面拟合的产出。系数单位是 **z 单位 / 像素**。 */
export interface RobustPlane {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly inlierRatio: number
}

/** 3×3 线性方程组（`np.linalg.solve`）。奇异给 `null` —— 抽到共线的三点只是这一轮没用。 */
function solve3(rows: readonly [number, number, number][], rhs: readonly number[]): [number, number, number] | null {
  const m: number[][] = rows.map((r, i) => [r[0], r[1], r[2], rhs[i] as number])
  for (let col = 0; col < 3; col += 1) {
    let piv = col
    for (let r = col + 1; r < 3; r += 1) {
      if (Math.abs((m[r] as number[])[col] as number) > Math.abs((m[piv] as number[])[col] as number)) piv = r
    }
    const pr = m[piv] as number[]
    const pv = pr[col] as number
    if (!Number.isFinite(pv) || pv === 0) return null
    m[piv] = m[col] as number[]
    m[col] = pr
    for (let r = 0; r < 3; r += 1) {
      if (r === col) continue
      const rr = m[r] as number[]
      const f = (rr[col] as number) / pv
      for (let k = col; k < 4; k += 1) rr[k] = (rr[k] as number) - f * (pr[k] as number)
    }
  }
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i += 1) {
    const rr = m[i] as number[]
    out[i] = (rr[3] as number) / (rr[i] as number)
  }
  return out.every(Number.isFinite) ? out : null
}

/**
 * 噪声自适应的稳健平面拟合。拟合不出来给 `null`。
 *
 * 与写死 `residual_threshold=1e-10`（100 pm）的那一版的关键差别：在原子级平整的
 * 表面上 100 pm 比整个高度起伏还大，于是几乎所有点都算内点，RANSAC 退化成普通
 * 最小二乘、稳健性白给；而在起伏大的表面上它又太小。这里的阈值随图自适应。
 */
export function fitPlaneRobust(
  m: Mat,
  opts: { sigma?: number | null; trials?: number; seed?: number } = {},
): RobustPlane | null {
  const { rows, cols } = m
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = matAt(m, r, c)
      if (Number.isFinite(v)) {
        xs.push(c)
        ys.push(r)
        zs.push(v)
      }
    }
  }
  const n = zs.length
  if (n < 3) return null

  let sig = opts.sigma === undefined || opts.sigma === null ? noiseFloor(m) : opts.sigma
  // 噪声底为 0（合成的无噪数据 / 常数面）时退回一个由高度尺度导出的小阈值，
  // 否则内点判据 `|r| < 0` 永远不成立，RANSAC 一个内点都找不到。
  if (!Number.isFinite(sig) || sig <= 0) {
    const spread = n > 0 ? nanMax(zs) - nanMin(zs) : 0
    sig = spread > 0 ? spread * 1e-6 : 1
  }
  const thresh = RANSAC_SIGMA_MULT * sig

  const rng = new Xoshiro128(opts.seed ?? RANSAC_SEED)
  const trials = opts.trials ?? RANSAC_TRIALS
  let bestPlane: [number, number, number] | null = null
  let bestCount = -1
  for (let t = 0; t < trials; t += 1) {
    const pick = rng.sample(n, 3)
    const plane = solve3(
      pick.map((i) => [xs[i] as number, ys[i] as number, 1] as [number, number, number]),
      pick.map((i) => zs[i] as number),
    )
    if (plane === null) continue
    let count = 0
    for (let i = 0; i < n; i += 1) {
      const r = Math.abs((zs[i] as number) - (plane[0] * (xs[i] as number) + plane[1] * (ys[i] as number) + plane[2]))
      if (r < thresh) count += 1
    }
    if (count > bestCount) {
      bestCount = count
      bestPlane = plane
    }
  }

  if (bestPlane === null) {
    const fit = lstsqPlane(xs, ys, zs)
    return fit === null ? null : { a: fit[0], b: fit[1], c: fit[2], inlierRatio: 1 }
  }
  // 用全部内点重拟合一次（RANSAC 的三点解只是用来找内点集的）。
  const ix: number[] = []
  const iy: number[] = []
  const iz: number[] = []
  for (let i = 0; i < n; i += 1) {
    const r = Math.abs(
      (zs[i] as number) - (bestPlane[0] * (xs[i] as number) + bestPlane[1] * (ys[i] as number) + bestPlane[2]),
    )
    if (r < thresh) {
      ix.push(xs[i] as number)
      iy.push(ys[i] as number)
      iz.push(zs[i] as number)
    }
  }
  // ⚠️ 提成一个**有声明返回类型**的函数，而不是内联的 `if (refined !== null)`。
  // 理由是变异演练：把 `ix.length >= 3` 改成 `false` 之后 TS 判那一支不可达、
  // **连带把 `refined !== null` 的收窄一起撤掉**，于是变异编不过 ——
  // 而「一条编不过的变异，那道闸就永远验不到」，本仓撞过十四次。
  // 声明类型挡住了流收窄，这条闸于是验得到。
  const refit = ix.length >= 3 ? refitOnInliers(ix, iy, iz, n) : null
  if (refit !== null) return refit
  return { a: bestPlane[0], b: bestPlane[1], c: bestPlane[2], inlierRatio: Math.max(bestCount, 0) / n }
}

/** 用**全部内点**再拟合一次。三点解只是用来找内点集的。 */
// (导出是为了让那条「不重拟合」的变异挂得上：改掉调用点之后它不会变成一个「没人用的函数」)
export function refitOnInliers(
  ix: readonly number[],
  iy: readonly number[],
  iz: readonly number[],
  n: number,
): RobustPlane | null {
  const refined = lstsqPlane(ix, iy, iz)
  return refined === null ? null : { a: refined[0], b: refined[1], c: refined[2], inlierRatio: ix.length / n }
}

/** 扣掉稳健拟合的那个平面。拟合失败时**原样返回**（同旧仓）。 */
export function planeSubtractRobust(m: Mat, opts: { sigma?: number | null } = {}): Mat {
  const fit = fitPlaneRobust(m, opts)
  if (fit === null) return m
  return applyPlane(m, fit.a, fit.b, fit.c)
}

/** `z − (a·x + b·y + c)`，x = 列号、y = 行号。 */
export function applyPlane(m: Mat, a: number, b: number, c: number): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let col = 0; col < m.cols; col += 1) {
      out[r * m.cols + col] = matAt(m, r, col) - (a * col + b * r + c)
    }
  }
  return matOf(m.rows, m.cols, out)
}

/**
 * `mast/data/processors.py` 的 `plane_subtract` —— **全部像素**的最小二乘，
 * 没有内点这回事。
 *
 * ⚠️ 它碰上**一个** NaN 就整幅返回 NaN（`np.linalg.lstsq` 的性质）。那不是缺陷，
 * 是 `ExtractClusters` 先裁行再调它的全部理由：真机上「半张图」是常态，
 * 而 2026-08-10 那 24 张里 11 张被报成「flat or unreadable scan」正是这一条 ——
 * 报错文案说「flat」，而真相是我们自己把它变成了 NaN。
 */
export function planeSubtractOls(m: Mat): Mat {
  const n = m.rows * m.cols
  const cx = new Float64Array(n)
  const cy = new Float64Array(n)
  const c1 = new Float64Array(n).fill(1)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      cx[r * m.cols + c] = c
      cy[r * m.cols + c] = r
    }
  }
  let sol: Float64Array
  try {
    sol = solveNormalEquations([cx, cy, c1], Float64Array.from(m.data))
  } catch {
    // Cholesky 抛 = 设计矩阵不满秩（1×N 或 N×1 的帧）。numpy 的 SVD 会给一个
    // 最小范数解，这里退回「减掉均值」——**但要说出来**，所以返回 NaN 全幅
    // 会更诚实。旧仓在这条路上从来没到过（帧至少 2×2），照它的形状给 NaN。
    return matOf(m.rows, m.cols, new Float64Array(n).fill(NaN))
  }
  // NaN 一旦进过正规方程，解就是 NaN，减出来整幅 NaN —— 与 numpy 同。
  return applyPlane(m, sol[0] as number, sol[1] as number, sol[2] as number)
}

/** 整帧最小二乘平面的**峰谷值**（「这帧调平了没有」的那个量）。拟合失败给 0。 */
export function planePeakToPeak(m: Mat): number {
  const sub = planeSubtractOls(m)
  // plane = z − 残差；直接按四角求极值更省，但旧仓是 `plane.max() − plane.min()`，
  // 而平面在网格上的极值一定落在四角 —— 两者等价，这里照旧仓逐格算。
  let lo = Infinity
  let hi = -Infinity
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      const p = matAt(m, r, c) - matAt(sub, r, c)
      if (p < lo) lo = p
      if (p > hi) hi = p
    }
  }
  return Number.isFinite(hi - lo) ? hi - lo : 0
}

/**
 * 设计矩阵 `[x, y, 1]` 的条件数所对应的相对容差。见文件抬头那张表。
 *
 * 用 `lstsqObservedTol`（`4·κ·eps`）而**不是** `lstsqRelTol`（`64·κ²·eps`）：
 * 后者是「正规方程在裸设计矩阵上」的保证，而本仓**中心化之后**不在那个档上了；
 * 现在两边之差由 numpy 的 SVD（`κ·eps`）主导。κ 随金样录。
 */
export function planeRelTol(cond: number): number {
  return lstsqObservedTol(cond)
}

/** 有限值个数 —— `finiteOf` 的计数版，省一次数组分配。 */
export function countFinite(m: Mat): number {
  return finiteOf(m.data).length
}

// ── 批 6b：`scan_prep.poly_subtract` 的完整版（order 1 与 2）───────────────

/**
 * 减去最小二乘拟合的二维多项式曲面（`order=1` 即平面）。**NaN 安全**：
 * 只用有限像素拟合，再把曲面从**整幅**图上减掉。
 *
 * 与 `data.processors.plane_subtract` 的区别：那个只有一阶，而且遇到 NaN 会把整幅图
 * 算成 NaN（`lstsq` 吃到 NaN）。**未完成的扫描是常态。**
 *
 * 项的顺序照移：`[x^j · y^i for i in 0..order for j in 0..order−i]`
 * ⇒ order 1 是 `[1, x, y]`，order 2 是 `[1, x, x², y, xy, y²]`。
 *
 * ## ⚠️ 两个 order 走**两条**求解路，而这不是随手写的
 *
 * | order | 解法 | 为什么 |
 * |---|---|---|
 * | 1 | {@link lstsqPlane}（**中心化**正规方程，批 4a 那一份） | 中心化之后 κ ≈ 1，正规方程不吃亏；而裸 `[x,y,1]` 的 κ ≈ 384，QR 反而更差 |
 * | ≥2 | 列缩放 + Householder QR（{@link lstsqQr}） | `[1,x,x²,y,xy,y²]` 在 256 边长上 κ(A) ≈ 1e6 ⇒ κ(AᵀA) ≈ 1e12，正规方程只剩四位 |
 *
 * 一个函数两条路看着别扭，而**合成一条会有一侧变差**：
 * 统一走 QR 会让 order 1 的结果换一串数（批 4b 的 `frame_texture` 金样全要重录，
 * 而换来的是更差的条件数）；统一走正规方程会让 order 2 只剩四位有效数字，
 * 而 `bow_gain` 要拿它跟 1.15 比大小。**这是 D-CHANNELS-1 的反面**：
 * 两条路**必须**不同，理由写在这里。
 */
export function polySubtract(m: Mat, order = 1): Mat {
  const { rows, cols } = m
  const n = rows * cols
  const ord = Math.max(0, Math.trunc(order))
  const nTerms = ((ord + 1) * (ord + 2)) / 2
  const idx: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(m.data[i] as number)) idx.push(i)
  const out = new Float64Array(n)
  if (idx.length < nTerms + 1) {
    const fin = idx.map((i) => m.data[i] as number)
    const mu = fin.length > 0 ? npMean(fin) : 0
    for (let i = 0; i < n; i += 1) out[i] = (m.data[i] as number) - mu
    return matOf(rows, cols, out)
  }
  if (ord === 1) {
    const xs = new Float64Array(idx.length)
    const ys = new Float64Array(idx.length)
    const zs = new Float64Array(idx.length)
    for (let k = 0; k < idx.length; k += 1) {
      const i = idx[k] as number
      xs[k] = i % cols
      ys[k] = Math.floor(i / cols)
      zs[k] = m.data[i] as number
    }
    const coef = lstsqPlane(xs, ys, zs) ?? [0, 0, 0]
    const a1 = coef[0] as number
    const a2 = coef[1] as number
    const a0 = coef[2] as number
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) out[r * cols + c] = matAt(m, r, c) - (a0 + a1 * c + a2 * r)
    }
    return matOf(rows, cols, out)
  }
  const powers: Array<[number, number]> = []
  for (let i = 0; i <= ord; i += 1) for (let j = 0; j <= ord - i; j += 1) powers.push([j, i])
  const scale = new Float64Array(powers.length)
  const colsA = powers.map(([jx, iy], t) => {
    const col = new Float64Array(idx.length)
    for (let k = 0; k < idx.length; k += 1) {
      const i = idx[k] as number
      col[k] = Math.pow(i % cols, jx) * Math.pow(Math.floor(i / cols), iy)
    }
    let s = 0
    for (let k = 0; k < col.length; k += 1) s += (col[k] as number) * (col[k] as number)
    s = Math.sqrt(s)
    scale[t] = s === 0 ? 1 : s
    for (let k = 0; k < col.length; k += 1) col[k] = (col[k] as number) / (scale[t] as number)
    return col
  })
  const rhs = new Float64Array(idx.length)
  for (let k = 0; k < idx.length; k += 1) rhs[k] = m.data[idx[k] as number] as number
  const raw = lstsqQr(colsA, rhs)
  const coef = new Float64Array(powers.length)
  for (let t = 0; t < powers.length; t += 1) coef[t] = (raw[t] as number) / (scale[t] as number)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let s = 0
      for (let t = 0; t < powers.length; t += 1) {
        const p = powers[t] as [number, number]
        s += (coef[t] as number) * Math.pow(c, p[0]) * Math.pow(r, p[1])
      }
      out[r * cols + c] = matAt(m, r, c) - s
    }
  }
  return matOf(rows, cols, out)
}
