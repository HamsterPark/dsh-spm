/**
 * Savitzky–Golay 平滑（`scipy.signal.savgol_filter`）+ 它要用的 `polyfit` / `polyval`。
 *
 * **它自成一体**：三步都落在本仓已有的件上 —— 系数是一次小最小二乘
 * （`solveNormalEquations`）、内点是一次 `correlate1d`、两端是一次 `polyfit`。
 * 没有新依赖，也没有第二个坑等在后面（对比 `order ≥ 2` 的样条插值，
 * 那一件真的会拖出一条 IIR 预滤波的链，见 D-NUM-11）。
 *
 * ## 三段各有各的容差，而它们**不是同一个数**
 *
 * `mode='interp'` 下这个滤波**由三件不同的东西拼起来**：
 *
 * | 哪一段 | 是什么 | 容差 |
 * |---|---|---|
 * | 系数 `savgolCoeffs` | 解 `A·Aᵀ z = y` 再 `Aᵀz`（**最小范数**解） | `4·κ(A'A'ᵀ)·eps`，A' 是**行缩放**过的 A |
 * | 中间 `halflen … n−halflen` | 上面那串系数与信号的一次 `w` 抽头相关 | 再加 `convRelTol(w)` |
 * | 两端各 `halflen` 个点 | **完全不经过那串系数** —— 对最外 `w` 个样本做一次 `polyfit` 再求值 | `lstsqRelTol(κ(缩放后的 Vandermonde))` |
 *
 * ### 行缩放：**不改答案，只改条件数**
 *
 * `A` 的第 k 行是 `x^k`，于是 `w = 25` 时第 0 行全是 1、第 3 行到 1728 ——
 * `κ(AAᵀ)` 冲到 `1.2e6`，容差按它写就是 `1.1e-9`，等于什么都没测。
 *
 * 把每一行除以自己的 2-范数（`y` 的对应分量同除）**不动那个约束集**：
 * `A'c = y' ⟺ Ac = y`，最小范数解一模一样。而 `κ` 从 `1.2e6` 掉到 **23**，
 * 容差随之收到 `2.1e-14`，实测 `5.1e-15` —— 4 倍余量，这才是一条在测东西的容差。
 * （同一招 numpy 的 `polyfit` 对**列**用，见下面的 {@link polyfit}。）
 *
 * 两端那一段是这一件最容易被忽略的地方：它不是「边界模式」，是**另一个算法**。
 * 拿 `mode='nearest'` 之类去近似它，最外那几个点会差到看得见 ——
 * 而一条谱的最外几个点正是「有没有能隙」要看的地方。
 *
 * 于是 {@link savgolRelTol} 是三项之和：调用方拿到的每个输出至多经过其中两段，
 * 但一条容差要盖住整条曲线。
 *
 * ## ⚠️ 最小范数，不是最小二乘
 *
 * `savgol_coeffs` 解的 `A c = y` 是**欠定**的（`polyorder+1` 个方程、
 * `window_length` 个未知数），scipy 的 `lstsq` 给的是**最小范数**解
 * `c = Aᵀ(AAᵀ)⁻¹ y`。
 *
 * 写成 `(AᵀA)⁻¹Aᵀ y`（正规方程那一套）会怎样：`AᵀA` 是 `w×w` 的、秩只有
 * `polyorder+1`，Cholesky 当场抛 —— 这一个**会报错**，算是运气好。
 * 真正危险的是随手挑一个特解：满足方程但系数乱跳，滤出来的曲线仍然光滑，
 * 只是它平滑的不是原来那条信号。
 *
 * ## 按消融精神只做 `deriv = 0`、`mode = 'interp'`、**奇数**窗长
 *
 * 唯一在移植范围里的消费方是旧仓 `vision/spectral_peaks.py:_savgol`，
 * 它调的是 `savgol_filter(y, w, 3)`（w 已被它自己强制成奇数），全是缺省。
 *
 * | 没做 | 现在的消费方 | 要加时判据是 |
 * |---|---|---|
 * | **`polyorder > 3`** | 无（`_savgol` 写死 3） | 见下面那一节 —— **抛，不近似** |
 * | `deriv > 0` + `delta` | 旧仓只有 gallery 绘图与 `force_inversion` 的**可选**那条路 | `y[deriv] = deriv! / delta^deriv` 一格金样；再加一格 `delta ≠ 1` —— 缺省 1 的时候那个幂次是恒等的，**分不出来** |
 * | 偶数窗长 | 无（`_savgol` 自己 `w += 1`） | `pos = halflen − 0.5` ⇒ 采样点落在两格中间。奇数窗上 `pos` 两种写法同解 |
 * | `mode ≠ 'interp'` | 无 | 那几档走的是 `correlate1d` 的边界模式，**不做两端的 polyfit** —— 是另一条路不是另一个参数 |
 * | `axis`（多维） | 无 | — |
 *
 * ## ⚠️ `polyorder > 3` **抛，不近似** —— 因为那一档的容差我推不出来
 *
 * 行缩放治得了 `A'A'ᵀ` 的条件数，治不了最后那一步重构 `c = A'ᵀz`：高阶上
 * `x^5` 在窗两端与窗中间差着六个数量级，那个和是一次**相消**。
 * 实测 `w=31, polyorder=5`：κ 缩放后只有 588（容差 `5.2e-13`），
 * 而实际偏差 `3.4e-12` —— **超差 6.5 倍**。
 *
 * 那个 6.5 我说不清从哪来。按本层的纪律，**一条说不清来源的容差比没有更坏**：
 * 它会在下一次合法的精度变化上红，而红的时候没人知道该改它还是改代码。
 * 于是这一档和 D-NUM-11（`order ≥ 2` 的样条插值）同一个形状：
 * **金样照录**（`savgol.cases` 里那一格 `supported: false`），
 * 证明我们知道它长什么样、并且确实没在复现它；代码**抛**。
 *
 * 要放开它，判据是：一条把重构那一步的相消也算进去的界（量级
 * `(polyorder+1)·eps·max_k|A'[k][i]·z[k]| / max|c|`），外加至少两格 `polyorder ≥ 4`
 * 的金样验证它。
 */
import { correlate1d, convRelTol } from './filters.js'
import { choleskySolve, lstsqObservedTol, lstsqRelTol, solveNormalEquations } from './fit.js'
import { EPS } from './stats.js'

/**
 * numpy 的 `polyval(p, x)`：`p` **高次在前**（`p[0]·xⁿ + … + p[n]`）。
 *
 * Horner，与 numpy 同一个循环 —— 展开成 `Σ p[i]·x^(n−i)` 是另一个舍入序列，
 * 而且在 `|x| > 1` 时更差。
 */
export function polyval(p: readonly number[] | Float64Array, x: number): number {
  let acc = 0
  for (let i = 0; i < p.length; i += 1) acc = acc * x + ((p as readonly number[])[i] as number)
  return acc
}

/**
 * numpy 的 `polyfit(x, y, deg)`，回**高次在前**的 `deg+1` 个系数。
 *
 * **照抄 numpy 的列缩放**：设计矩阵每一列先除以自己的 2-范数再解，解完再除回去。
 * 那一步不改数学解，改的是条件数 —— 一条 `x = 0…24` 的三次 Vandermonde
 * 不缩放时 `κ ≈ 1e5`，缩放之后降到 `1e2` 量级。
 * 不照抄的话我们与 numpy 的差会跑到 `κ²` 那一档去，而那时「是不是算错了」
 * 和「是不是病态」分不开。
 *
 * 走正规方程（同 `fitPlane` 一族），容差 {@link lstsqRelTol}（把 κ 平方）。
 */
export function polyfit(
  xs: readonly number[] | Float64Array,
  ys: readonly number[] | Float64Array,
  deg: number,
): Float64Array {
  if (!Number.isInteger(deg) || deg < 0) throw new RangeError(`polyfit 的阶必须是自然数：${deg}`)
  const n = xs.length
  if (ys.length !== n) throw new RangeError(`polyfit 的 x 与 y 长度不等：${n} vs ${ys.length}`)
  if (n < deg + 1) throw new RangeError(`${n} 个点拟合不了 ${deg} 阶多项式（要 ${deg + 1} 个）`)
  const order = deg + 1
  // numpy 的 `vander`：第 j 列是 x^(deg−j)，于是系数高次在前
  const cols: Float64Array[] = []
  const scale = new Float64Array(order)
  for (let j = 0; j < order; j += 1) {
    const c = new Float64Array(n)
    let acc = 0
    for (let i = 0; i < n; i += 1) {
      c[i] = ((xs as readonly number[])[i] as number) ** (deg - j)
      acc += (c[i] as number) ** 2
    }
    scale[j] = Math.sqrt(acc)
    for (let i = 0; i < n; i += 1) c[i] = (c[i] as number) / (scale[j] as number)
    cols.push(c)
  }
  const sol = solveNormalEquations(cols, Float64Array.from(ys as Iterable<number>))
  for (let j = 0; j < order; j += 1) sol[j] = (sol[j] as number) / (scale[j] as number)
  return sol
}

/**
 * `scipy.signal.savgol_coeffs(window_length, polyorder)`（`use='conv'`，`deriv=0`）。
 *
 * **最小范数解** `c = Aᵀ(AAᵀ)⁻¹ y`，见文件抬头那一节。
 * `A[k][i] = x[i]^k`，`x = flip(arange(−pos, w−pos))`，奇数窗时 `pos = w>>1`。
 *
 * 回的系数按**卷积**顺序（`savgol_filter` 随后会把它翻过来喂给相关）。
 */
export function savgolCoeffs(windowLength: number, polyorder: number): Float64Array {
  if (!Number.isInteger(windowLength) || windowLength < 1) {
    throw new RangeError(`窗长必须是正整数：${windowLength}`)
  }
  if (windowLength % 2 === 0) {
    throw new RangeError(`窗长必须是**奇数**：得到 ${windowLength}（偶数窗没有消费方，见文件抬头）`)
  }
  if (!Number.isInteger(polyorder) || polyorder < 0 || polyorder >= windowLength) {
    throw new RangeError(`polyorder 必须是 0..${windowLength - 1} 的整数：得到 ${polyorder}`)
  }
  if (polyorder > MAX_POLYORDER) {
    throw new RangeError(
      `polyorder > ${MAX_POLYORDER} 没有实现：最小范数解的重构在高阶上相消，` +
      `而那一档的容差推不出来（实测 w=31/po=5 超差 6.5 倍）。见 savgol.ts 抬头`,
    )
  }
  const w = windowLength
  const pos = w >> 1
  const order = polyorder + 1
  // A 的**行**（每行一个幂次），各自除以自己的 2-范数 —— 行缩放不动那个约束集，
  // 最小范数解一模一样，改的只有条件数。见文件抬头。
  const rows: Float64Array[] = []
  const scale = new Float64Array(order)
  for (let k = 0; k < order; k += 1) {
    const r = new Float64Array(w)
    let acc = 0
    for (let i = 0; i < w; i += 1) {
      const xi = w - 1 - pos - i // = flip(arange(−pos, w−pos))[i]
      r[i] = xi ** k
      acc += (r[i] as number) ** 2
    }
    scale[k] = Math.sqrt(acc)
    for (let i = 0; i < w; i += 1) r[i] = (r[i] as number) / (scale[k] as number)
    rows.push(r)
  }
  // 要解的是 `(A'A'ᵀ) z = y'`。`solveNormalEquations` 会先从「列」乘出 `AᵀA`，
  // 而这里的矩阵已经在手上了 —— 直接摆出来，交给共用的 `choleskySolve`。
  const M = new Float64Array(order * order)
  for (let i = 0; i < order; i += 1) {
    for (let j = 0; j < order; j += 1) {
      let acc = 0
      for (let t = 0; t < w; t += 1) {
        acc += ((rows[i] as Float64Array)[t] as number) * ((rows[j] as Float64Array)[t] as number)
      }
      M[i * order + j] = acc
    }
  }
  const y = new Float64Array(order)
  y[0] = 1 / (scale[0] as number) // deriv = 0 ⇒ y = [1, 0, …, 0]，再随行一起缩放
  const z = choleskySolve(M, y, order)
  const c = new Float64Array(w)
  for (let i = 0; i < w; i += 1) {
    let acc = 0
    for (let k = 0; k < order; k += 1) {
      acc += ((rows[k] as Float64Array)[i] as number) * (z[k] as number)
    }
    c[i] = acc
  }
  return c
}

/** 实现了的最高阶。见文件抬头那一节 —— 再高的容差推不出来，所以抛。 */
export const MAX_POLYORDER = 3

/**
 * `savgol_filter(y, window_length, polyorder)` —— `deriv=0`、`mode='interp'`。
 *
 * 三段拼起来（见文件抬头）：中间一次 `w` 抽头相关，**两端各 `w>>1` 个点由一次
 * `polyfit` 重算**。两端那一段不是「边界模式」，是另一个算法。
 *
 * `window_length > y.length` 抛（同 scipy）：`mode='interp'` 下窗比信号还长时
 * 那个多项式是欠定的，而一个欠定的拟合给出的光滑曲线看起来完全正常。
 */
export function savgolFilter(
  ys: Float64Array | readonly number[],
  windowLength: number,
  polyorder: number,
): Float64Array {
  const x = Float64Array.from(ys as Iterable<number>)
  const n = x.length
  if (windowLength > n) {
    throw new RangeError(`mode='interp' 要 window_length ≤ 点数：${windowLength} > ${n}`)
  }
  const c = savgolCoeffs(windowLength, polyorder)
  // `ndi.convolve1d(x, c)` = `correlate1d(x, reverse(c))`（奇数核，origin=0）。
  //
  // ⚠️ **今天这一行是个恒等式，而它仍然该在**：`deriv = 0` 的 SG 系数恒对称，
  // 于是翻不翻结果一样 —— **没有任何金样能照出去掉它**（实测：去掉，全绿）。
  // 它在这里是为了哪天补 `deriv > 0`：那时系数反对称，翻错整条导数变号。
  // 按仓里的规矩这种「现在验不到」的行要写下来，不能让它看起来像被验过了。
  const rev = Float64Array.from(c).reverse()
  const out = correlate1d(x, rev, 'constant', 0)

  const half = windowLength >> 1
  if (half > 0) {
    fitEdge(x, 0, windowLength, 0, half, polyorder, out)
    fitEdge(x, n - windowLength, n, n - half, n, polyorder, out)
  }
  return out
}

/** scipy 的 `_fit_edge`：拿 `[start, stop)` 这一窗拟一个多项式，填 `[iStart, iStop)`。 */
function fitEdge(
  x: Float64Array,
  start: number,
  stop: number,
  iStart: number,
  iStop: number,
  polyorder: number,
  out: Float64Array,
): void {
  const m = stop - start
  const xx = new Float64Array(m)
  const yy = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    xx[i] = i
    yy[i] = x[start + i] as number
  }
  const p = polyfit(xx, yy, polyorder)
  for (let i = iStart; i < iStop; i += 1) out[i] = polyval(p, i - start)
}

/**
 * `savgolFilter` 与 scipy 比时的**保证**（相对，按 `max|want|` 归一）。
 *
 * 三项之和，每一项对应文件抬头那张表里的一段：
 *
 * 1. `4·condNormal·eps` —— 系数那一步解的是 `A'A'ᵀ z = y'`。**这里 κ 不平方**：
 *    那个矩阵本来就是要解的那一个，不是又乘出来的一个；
 * 2. `convRelTol(w)` —— 中间那一段的 `w` 次乘加；
 * 3. `lstsqRelTol(condEdge)` —— 两端的 `polyfit` 走正规方程，**那一步 κ 要平方**。
 *
 * 两个 κ 都从金样里读（`np.linalg.cond` 一起录了），于是这条容差是**可验算的**。
 */
export function savgolRelTol(condNormal: number, condEdge: number, windowLength: number): number {
  return 4 * condNormal * EPS + convRelTol(windowLength) + lstsqRelTol(condEdge)
}

/**
 * `savgolFilter` **现在实际达到的水平**：第 3 项换成 `lstsqObservedTol`（κ 不平方）。
 *
 * 两条都在测试里，理由同 `fit.ts` 抬头那一节：只留保证的话两端那一项有几千倍
 * 余量、等于什么都没测；只留实测的话哪天真来了一个病态的窗，一次**合法**的
 * 精度退化会被当成回归。
 */
export function savgolObservedTol(condNormal: number, condEdge: number, windowLength: number): number {
  return 4 * condNormal * EPS + convRelTol(windowLength) + lstsqObservedTol(condEdge)
}

/** {@link savgolCoeffs} 单独比时的容差：只有第 1 项。 */
export function savgolCoeffsRelTol(condNormal: number): number {
  return 4 * condNormal * EPS
}
