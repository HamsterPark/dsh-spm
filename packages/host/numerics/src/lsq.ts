/**
 * 一般最小二乘 —— Householder QR。`np.linalg.lstsq` 的对面。
 *
 * > **来处**：批 6b 落在 `vision/src/lsq.ts`（那一轮 `numerics/` 由批 6c 主用），
 * > 由收尾支线按该批交接 §7 搬来。实现与容差一个字未改。
 * >
 * > ⚠️ **同一个文件里的 `polyfit` 没有跟过来。** 本包已经住着另一个
 * > `polyfit`（`savgol.ts`，走列缩放 + 正规方程），两者**不是同一个函数**：
 * > 同一份 `n=256, deg=3` 的数据上系数相对差 `5e−9`（不是最后一位），
 * > 退化输入上一个回解、一个抛。`export *` 撞名，而统一成一份会同时改动
 * > `spec/golden/numerics.json` 与 `spec/golden/scan_prep.json`。
 * > 详见 `docs/handoff/move-home.md` 与 `spec/deviations.md` 的 `D-LSQ-?`。
 *
 * ## 为什么不用 `solveNormalEquations`
 *
 * `numerics/fit.ts` 那一份走正规方程 + Cholesky，**条件数会被平方**。
 * 第一个消费方的设计阵是 `scan_prep.poly_subtract(order=2)` 的
 * `[1, x, x², y, xy, y²]`，x/y 取 `0…nx−1` **没有中心化**（旧仓怎么写的就怎么算）。
 * 256 边长上 κ(A) ≈ 1e6 ⇒ κ(AᵀA) ≈ 1e12 —— float64 只剩四位。
 * 而 `bow_gain = std(扣平面残差) / std(扣二阶残差)` 要跟 1.15 比大小，
 * 残差里带四位有效数字是不够看的。
 *
 * QR 的误差随 **κ** 不是 κ²，这就是全部理由。
 *
 * ## 容差
 *
 * 对面是 LAPACK 的 `gelsd`（SVD）。两个算法都向后稳定，**系数**的相对误差
 * 各自都在 `κ·eps` 量级，于是两边之差也在那个量级 ——
 * 用 `lstsqObservedTol(κ)` 那一族的口径。
 *
 * ⚠️ 而在 `scan_prep` 那一层真正被比的不是系数，是**残差** `a − A·c`。
 * 残差是往 A 的正交补上的投影：系数在近零奇异方向上的误差**几乎不改变残差**。
 * 所以残差派生量（`plane_rms_pm` / `line_gain` / `bow_gain`）的容差比系数小得多，
 * 由 `vision/scan-prep.ts` 的 `FLATTEN_REL_TOL` 单独给，连推导写在那里。
 */

/**
 * 解 `min‖A·c − b‖`，`A` 按**列**给（每列长 m），返回长 p 的系数。
 *
 * 就地做 Householder 正交化；`p ≤ m` 时有解，否则抛 —— 一个欠定的
 * 最小二乘在这里只会是调用方算错了 `n_terms`，而悄悄给一个最小范数解
 * 会让那个错一路活到结果里。
 */
export function lstsqQr(cols: readonly Float64Array[], b: Float64Array): Float64Array {
  const p = cols.length
  const m = b.length
  if (p === 0) return new Float64Array(0)
  if (m < p) throw new RangeError(`lstsqQr: 行数 ${m} 少于列数 ${p}`)
  // R 就地写在 A 的拷贝上（列主序），y 是 Qᵀb。
  const a: Float64Array[] = cols.map((c) => Float64Array.from(c))
  const y = Float64Array.from(b)
  const betas = new Float64Array(p)
  const vs: Float64Array[] = []
  for (let k = 0; k < p; k += 1) {
    const ak = a[k] as Float64Array
    let norm = 0
    for (let i = k; i < m; i += 1) norm += (ak[i] as number) * (ak[i] as number)
    norm = Math.sqrt(norm)
    if (norm === 0) {
      vs.push(new Float64Array(0))
      continue
    }
    const alpha = (ak[k] as number) >= 0 ? -norm : norm
    const v = new Float64Array(m - k)
    for (let i = k; i < m; i += 1) v[i - k] = ak[i] as number
    v[0] = (v[0] as number) - alpha
    let vv = 0
    for (let i = 0; i < v.length; i += 1) vv += (v[i] as number) * (v[i] as number)
    if (vv === 0) {
      vs.push(new Float64Array(0))
      continue
    }
    betas[k] = 2 / vv
    vs.push(v)
    // 作用到剩下的列与 y 上。
    for (let j = k; j < p; j += 1) {
      const aj = a[j] as Float64Array
      let dot = 0
      for (let i = k; i < m; i += 1) dot += (v[i - k] as number) * (aj[i] as number)
      dot *= betas[k] as number
      for (let i = k; i < m; i += 1) aj[i] = (aj[i] as number) - dot * (v[i - k] as number)
    }
    let dy = 0
    for (let i = k; i < m; i += 1) dy += (v[i - k] as number) * (y[i] as number)
    dy *= betas[k] as number
    for (let i = k; i < m; i += 1) y[i] = (y[i] as number) - dy * (v[i - k] as number)
  }
  // 回代。
  const c = new Float64Array(p)
  for (let k = p - 1; k >= 0; k -= 1) {
    let s = y[k] as number
    for (let j = k + 1; j < p; j += 1) s -= ((a[j] as Float64Array)[k] as number) * (c[j] as number)
    const d = (a[k] as Float64Array)[k] as number
    c[k] = d === 0 ? 0 : s / d
  }
  return c
}
