/**
 * 这一层自己要、而 `dsh-spm-numerics` 这一轮**没有**的那几个 numpy 语义。
 *
 * ## 为什么它们在这里而不在 numerics 里
 *
 * 批 4a 与「numerics 加 `find_peaks` / `pcov` / `correlate2d`」是**同一轮的两条
 * 支线**，而两条支线同时改一个文件的下场本仓量过（2.26：四条支线三条抢同四个
 * 共享文件）。所以这一轮的规矩是：numerics 归那条支线，本批要的 numpy 语义
 * 落在本包里，**并在交接里逐条列出来**，由主线合并时决定搬不搬。
 *
 * 判断「该不该搬」的问题只有一个，而且不是「长得像不像」：
 * **它有没有第二个消费方？** `nanMedian` / `gradient2d` 有（整个 `mast/vision/`
 * 都在用），`eigvalsh2` 只在本包出现三次。见 D-NUM-9 那条：两份**行为本该不同**
 * 的东西长得一样，合并才是 bug；这里是反过来的一半 —— 行为本该相同，所以
 * 合并的候选**只有** `nanMedian` / `nanStd` / `gradient2d` / `interp`。
 *
 * ## 容差
 *
 * 这一族**全部零容差**，因为它们要么只搬数（`nanMedian` 是排序取中，`bincount`
 * 数个数，`eigvalsh2` 是闭式），要么是定长的几次乘加（`gradient2d` 每格两次减法
 * 一次除法）。给它们容差等于把一次「挑错了元素」藏起来 —— 而挑错元素正是
 * 这一族唯一会犯的错（`numerics-2.md` 第五节第一条）。
 *
 * 唯一的例外是 `nanStd`，它走 `numerics.std`，容差归那一份。
 */
import { matAt, matOf, mean, percentile, std, type Mat } from 'dsh-spm-numerics'

/** 有限值（`isfinite`）。numpy 的 `nan*` 一族丢的是 NaN，`±inf` 它留着 —— 这里一并丢，
 * 因为本层的调用方一个都没有「inf 是数据」的用法，而留着 inf 会让中位数变成 inf。 */
export function finiteOf(xs: readonly number[] | Float64Array): number[] {
  const out: number[] = []
  for (let i = 0; i < xs.length; i += 1) {
    const v = (xs as readonly number[])[i] as number
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/**
 * `np.median` —— ⚠️ **不是** `numerics.median`。
 *
 * | | 偶数长度时算什么 |
 * |---|---|
 * | `np.median` | `np.mean(两个中位)` = `(a + b) / 2` |
 * | `np.percentile(x, 50, method='linear')` | `a + (b − a) · 0.5` |
 * | `numerics.median` | 后者（它就是 `percentile(xs, 50)`） |
 *
 * 两个表达式**数学上相等、浮点上不等**，差在最后一位。平时看不见 ——
 * 直到它进了一条 `>=` 比较、或者被乘上 1.4826 再当阈值用：
 * `noiseFloor` 在 128×128 的帧上就因为这一位与旧仓分岔（实测 `2.4558435261610524e-12`
 * 对 `2.455843526160944e-12`），而那一条我写的是**容差 0**。
 *
 * 所以这一层凡是移植 `np.median` / `np.nanmedian` 的地方一律走这一份。
 * `numerics.median` 没有错 —— 它对的是 `np.percentile`，那是另一个函数。
 * 这是 D-CHANNELS-1 的形状：两个看起来该合并的东西，合并会默默改掉判决。
 */
export function npMedian(xs: readonly number[] | Float64Array): number {
  const n = xs.length
  if (n === 0) return NaN
  const s = Array.from(xs as readonly number[]).sort((a, b) => a - b)
  const h = n >> 1
  return n % 2 === 1 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2
}

/** `np.nanmedian`。全是 NaN 时给 `NaN`（同 numpy 的 `RuntimeWarning` + `nan`）。 */
export function nanMedian(xs: readonly number[] | Float64Array): number {
  const f = finiteOf(xs)
  return f.length === 0 ? NaN : npMedian(f)
}

/** `np.nanmean`。 */
export function nanMean(xs: readonly number[] | Float64Array): number {
  const f = finiteOf(xs)
  return f.length === 0 ? NaN : mean(f)
}

/** `np.nanstd`（总体标准差，ddof=0）。 */
export function nanStd(xs: readonly number[] | Float64Array): number {
  const f = finiteOf(xs)
  return f.length === 0 ? NaN : std(f, 0)
}

/** `np.nanmax`。 */
export function nanMax(xs: readonly number[] | Float64Array): number {
  const f = finiteOf(xs)
  let m = -Infinity
  for (const v of f) if (v > m) m = v
  return f.length === 0 ? NaN : m
}

/** `np.nanmin`。 */
export function nanMin(xs: readonly number[] | Float64Array): number {
  const f = finiteOf(xs)
  let m = Infinity
  for (const v of f) if (v < m) m = v
  return f.length === 0 ? NaN : m
}

/** MAD（中位绝对偏差），对 NaN 免疫。`np.median(np.abs(x - np.median(x)))`。 */
export function madOf(xs: readonly number[] | Float64Array): number {
  const f = finiteOf(xs)
  if (f.length === 0) return NaN
  const m = npMedian(f)
  return npMedian(f.map((v) => Math.abs(v - m)))
}

/**
 * `np.std` 作用在一个 **float32** 数组上时的那个答案。
 *
 * ## 它不是「精度低一点的 std」，它会**翻分支**
 *
 * `judgeFrame` 的第一档是「去趋势后 `std` 精确为 0」。一张带倾斜的死平帧，
 * 去趋势残差在 `1e-25` 量级 —— 那个数在 float32 里还表示得出来，
 * 可是**它的平方 `1e-50` 在 float32 里下溢成 0**，于是方差是 0、`std` 是 0，
 * 第一档当场成立。同一串数在 float64 里平方得到 `1e-50`（好好的一个数），
 * `std ≈ 1e-25 ≠ 0` ⇒ 落到第二档，报的是**另一句话**。
 *
 * 实测就是这么撞上的：旧仓给 `DEAD_FLAT_REASON`，本仓第一版给
 * 「残差只有原始起伏的 1.80e-15」。两句都对，但**指向不同的下一步**，
 * 而这一层的产品正是那句话。
 *
 * ⇒ 每一次乘加都 `Math.fround` 一遍。
 * **累加顺序仍与 numpy 的成对求和不同**（那条差异由 `corrugationRelTol` 承担），
 * 这里复现的是 float32 的**量程**，不是它的累加序。
 */
export function std32(xs: readonly number[] | Float64Array): number {
  // **每一步**都要降到 float32，而且要走同一个名字 —— 少任何一处都够把
  // `1e-50` 拉回 float64 的量程，而那一处正是判据所在。
  // 收在一行上也是为了让变异挂得上：四处 `Math.fround` 各挂一条，
  // 拆掉任何一条剩下三条照样把它压成 0，于是那四条演练**每一条都是绿的**。
  const f32 = Math.fround
  const n = xs.length
  if (n === 0) return NaN
  let s = 0
  for (let i = 0; i < n; i += 1) s = f32(s + f32((xs as readonly number[])[i] as number))
  const mean32 = f32(s / n)
  let acc = 0
  for (let i = 0; i < n; i += 1) {
    const d = f32(f32((xs as readonly number[])[i] as number) - mean32)
    acc = f32(acc + f32(d * d))
  }
  return f32(Math.sqrt(f32(acc / n)))
}

/** `np.histogram(x, bins)` —— **不给 range 那一路**：numpy 取 `(min, max)`，
 * 而 `min === max` 时它用 `(min − 0.5, max + 0.5)`（否则 bin 宽为 0）。
 * 这一条分岔在一张常数帧上就会遇到，所以照抄，不自己发明。 */
export function autoRange(xs: readonly number[] | Float64Array): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < xs.length; i += 1) {
    const v = (xs as readonly number[])[i] as number
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  return lo === hi ? [lo - 0.5, hi + 0.5] : [lo, hi]
}

/** `np.ptp(a[np.isfinite(a)])` —— 只在有限值上取极差。全非有限给 `NaN`。 */
export function ptpFinite(m: { readonly data: Float64Array }): number {
  const f = finiteOf(m.data)
  if (f.length === 0) return NaN
  let lo = Infinity
  let hi = -Infinity
  for (const v of f) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo
}

/** `np.percentile(x, q)`，先丢掉非有限值。 */
export function nanPercentile(xs: readonly number[] | Float64Array, q: number): number {
  const f = finiteOf(xs)
  return f.length === 0 ? NaN : percentile(f, q)
}

/**
 * `np.gradient` 的二维版（`gy, gx = np.gradient(z)`，间距 1）。
 *
 * 内部是二阶中心差分 `(a[i+1] − a[i−1]) / 2`，两端是一阶单侧差分。
 * numpy 对**非均匀**间距有另一套公式，这里间距恒为 1，用不到那条。
 */
export function gradient2d(m: Mat): { gy: Mat; gx: Mat } {
  const { rows, cols } = m
  const gy = new Float64Array(rows * cols)
  const gx = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      gy[i] =
        rows === 1
          ? 0
          : r === 0
            ? matAt(m, 1, c) - matAt(m, 0, c)
            : r === rows - 1
              ? matAt(m, rows - 1, c) - matAt(m, rows - 2, c)
              : (matAt(m, r + 1, c) - matAt(m, r - 1, c)) / 2
      gx[i] =
        cols === 1
          ? 0
          : c === 0
            ? matAt(m, r, 1) - matAt(m, r, 0)
            : c === cols - 1
              ? matAt(m, r, cols - 1) - matAt(m, r, cols - 2)
              : (matAt(m, r, c + 1) - matAt(m, r, c - 1)) / 2
    }
  }
  return { gy: matOf(rows, cols, gy), gx: matOf(rows, cols, gx) }
}

/**
 * 对称 2×2 的特征值，**升序**（同 `np.linalg.eigvalsh`）。
 *
 * 闭式：`λ = (t ± √(t² − 4d)) / 2`，`t = a + c`、`d = ac − b²`。
 * 判别式取 `max(0, ·)` —— 对称矩阵的判别式在实数域上必然 ≥ 0，负号只可能来自
 * 舍入，而一个 `NaN` 会比一个小负数传得更远。
 */
export function eigvalsh2(a: number, b: number, c: number): [number, number] {
  const t = a + c
  const disc = Math.sqrt(Math.max(0, t * t - 4 * (a * c - b * b)))
  return [(t - disc) / 2, (t + disc) / 2]
}

/**
 * `np.interp(x, xp, fp)` —— `xp` 必须**递增**。界外取端点值（numpy 的缺省），
 * 不外推。
 */
export function interp(x: number, xp: readonly number[] | Float64Array, fp: readonly number[] | Float64Array): number {
  const n = xp.length
  if (n === 0) return NaN
  if (x <= (xp[0] as number)) return fp[0] as number
  if (x >= (xp[n - 1] as number)) return fp[n - 1] as number
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((xp[mid] as number) <= x) lo = mid
    else hi = mid
  }
  const x0 = xp[lo] as number
  const x1 = xp[hi] as number
  const y0 = fp[lo] as number
  const y1 = fp[hi] as number
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}

/** 行优先展平的 `Mat` → 普通二维数组（导出/比对用）。 */
export function toRows(m: Mat): number[][] {
  const out: number[][] = []
  for (let r = 0; r < m.rows; r += 1) {
    const row: number[] = []
    for (let c = 0; c < m.cols; c += 1) row.push(matAt(m, r, c))
    out.push(row)
  }
  return out
}

/** 普通二维数组 → `Mat`。空数组给 `0×0`。 */
export function fromRows(rows: readonly (readonly number[])[]): Mat {
  const ny = rows.length
  const nx = ny === 0 ? 0 : (rows[0] as readonly number[]).length
  const data = new Float64Array(ny * nx)
  for (let r = 0; r < ny; r += 1) {
    const row = rows[r] as readonly number[]
    for (let c = 0; c < nx; c += 1) data[r * nx + c] = row[c] as number
  }
  return matOf(ny, nx, data)
}

/**
 * **float32 一遍**（`np.ndarray.astype(np.float32)`）。
 *
 * `mast.vision.tip_metrics._detrend` 的最后一步是 `.astype(np.float32)`，
 * 而 `judge_frame` 的 `corrugation_rms_m` 就是在那份 float32 上取的 `std` ——
 * 也就是说这条判据的**最后两位由一次降精度决定**。照抄那次降精度，
 * 不照抄的话同一张帧在两边会给出不同的 pm 数，而阈值是按 pm 写的。
 */
export function toFloat32(xs: readonly number[] | Float64Array): Float64Array {
  const out = new Float64Array(xs.length)
  for (let i = 0; i < xs.length; i += 1) out[i] = Math.fround((xs as readonly number[])[i] as number)
  return out
}
