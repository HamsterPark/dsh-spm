/**
 * 两件 numpy 的**求导与求积**原语：`np.gradient(y, x)`（非均匀间距）与
 * `np.trapezoid(y, x)`。
 *
 * ## 为什么它们的容差是 **0**
 *
 * 同 `pairwise.ts` 抬头那条：**累加与运算顺序是可以照抄的**。
 * 这两件各自只有几次浮点运算，而 numpy 那几次的**先后**在源码里写得明明白白：
 *
 * | | numpy 怎么算 | 本仓 |
 * |---|---|---|
 * | `gradient` 内点（间距不等） | `a*f[:-2] + b*f[1:-1] + c*f[2:]`（三个临时数组，**从左往右**相加） | `a * fm + b * f0 + c * fp`（JS 的 `+` 同样左结合） |
 * | `gradient` 内点（间距**恰好**相等） | `(f[2:] − f[:-2]) / (2.·dx)` —— **另一条分支**，见下 | 同式 |
 * | `gradient` 两端 | `(f[1] − f[0]) / dx[0]`、`(f[-1] − f[-2]) / dx[-1]` | 同式 |
 * | `trapezoid` | `d * (y[1:] + y[:-1]) / 2.0` 再 `np.sum`（**成对**） | 同式 + {@link npSum} |
 *
 * ⇒ 两边是**同一串**浮点运算，差为 0。
 * 「写容差之前先问这一步到底做了几次浮点运算」（`numerics-3.md` 第六节第一条）——
 * 这里的答案是「和 numpy 一样多、一样的顺序」。
 *
 * ## ⚠️ 那条**「间距恰好相等就退回标量」**的分支（D-NUM-* 之一）
 *
 * numpy 在进 `gradient` 之前先做一次 `if (diff(x) == diff(x)[0]).all(): dx = diff(x)[0]`
 * —— 注释写的是「a consistent speedup」，可**它换的是算法不是速度**：
 * 标量那条路算的是 `(f[i+1] − f[i−1]) / (2·dx)`，非均匀那条路算的是
 * `a·f[i−1] + b·f[i] + c·f[i+1]`，其中 `b = (dx2 − dx1)/(dx1·dx2)` 在等距时
 * **恰好是 0 乘一个数**。两者数学相等，浮点上差一两个 ulp。
 *
 * 第一版没写这一条，`calculus.gradient.uniform` 那一格当场红在最后一位上 ——
 * 而**只有等距那一格分得开**：非等距的格上两条分支给的是完全不同的数
 * （错了会一眼看出来），等距的格上它们只差最后一位（错了看起来完全正常）。
 * 这正是「一格分辨不出两种候选的金样不是判据」的反面：两格缺一不可。
 *
 * ⚠️ 别把 `a`、`b`、`c` 那三个系数折叠成一个更「简洁」的式子。
 * `b = (dx2 − dx1) / (dx1·dx2)` 在**近乎均匀**的网格上是一次相消（分子接近 0），
 * 而那正是 Sader–Jarvis 的 z 轴的形状。换一种代数等价的写法，两边就不再逐位相同，
 * 于是这一族的容差从 0 变成「说不清来源的某个数」。
 *
 * ## 没实现的（各自要什么金样）
 *
 * | 没做 | 一格金样要能分辨什么 |
 * |---|---|
 * | `np.gradient(y)` / `gradient(y, dx)` 的**标量入参** | 数值上它与「等距数组」那一档同解（numpy 自己就是这么归并的），所以**分不开** —— 差别只在签名。等哪天有消费方传标量再加 |
 * | `edge_order = 2` | 一格**两端曲率明显**的曲线：一阶与二阶的端点值差得开；在一条直线上两者同解 |
 * | 多维 / `axis=` | 二维那一档在 `dsh-spm-vision` 的 `gradient2d` 里（间距恒为 1） |
 * | `trapezoid` 的 `dx=` 标量与 `axis=` | 缺省 `dx=1` 时标量那条路与 `x = arange(n)` 同解，分不出来 |
 */
import { npSum } from './pairwise.js'

/**
 * `np.gradient(y, x)` —— **x 是一个坐标数组**（非均匀间距那条分支），`edge_order=1`。
 *
 * 内点用二阶精度的非均匀中心差分，两端用一阶单侧差分。三个系数与 numpy 逐字同式：
 *
 * ```
 * a = −dx2 / (dx1·(dx1 + dx2))
 * b = (dx2 − dx1) / (dx1·dx2)
 * c =  dx1 / (dx2·(dx1 + dx2))
 * ```
 *
 * 容差 **0**（见文件抬头）。`n < 2` 抛：一个点上没有导数，而回 `[0]` 会让调用方
 * 以为它量到了一条平的曲线。
 */
export function gradient1d(y: readonly number[] | Float64Array, x: readonly number[] | Float64Array): Float64Array {
  const n = y.length
  if (x.length !== n) throw new RangeError(`gradient1d 的 x 与 y 长度不等：${x.length} vs ${n}`)
  if (n < 2) throw new RangeError(`gradient1d 至少要 2 个点（edge_order=1）：得到 ${n}`)
  const at = (a: readonly number[] | Float64Array, i: number): number => a[i] as number
  const out = new Float64Array(n)
  const diff = new Float64Array(n - 1)
  for (let i = 0; i < n - 1; i += 1) diff[i] = at(x, i + 1) - at(x, i)
  // numpy 的 `if (diffx == diffx[0]).all(): diffx = diffx[0]` —— 见文件抬头那一节。
  // **逐位相等**，不是「差不多相等」：numpy 用的就是 `==`。
  let uniform = true
  for (let i = 1; i < n - 1; i += 1) {
    if (diff[i] !== diff[0]) {
      uniform = false
      break
    }
  }
  if (uniform) {
    const dx = diff[0] as number
    for (let i = 1; i < n - 1; i += 1) out[i] = (at(y, i + 1) - at(y, i - 1)) / (2.0 * dx)
    out[0] = (at(y, 1) - at(y, 0)) / dx
    out[n - 1] = (at(y, n - 1) - at(y, n - 2)) / dx
    return out
  }
  for (let i = 1; i < n - 1; i += 1) {
    const dx1 = diff[i - 1] as number
    const dx2 = diff[i] as number
    const a = -dx2 / (dx1 * (dx1 + dx2))
    const b = (dx2 - dx1) / (dx1 * dx2)
    const c = dx1 / (dx2 * (dx1 + dx2))
    out[i] = a * at(y, i - 1) + b * at(y, i) + c * at(y, i + 1)
  }
  out[0] = (at(y, 1) - at(y, 0)) / (diff[0] as number)
  out[n - 1] = (at(y, n - 1) - at(y, n - 2)) / (diff[n - 2] as number)
  return out
}

/**
 * `np.trapezoid(y, x)` —— 梯形积分，**求和走成对**（{@link npSum}）。
 *
 * 容差 **0**（见文件抬头）。`n < 2` 回 `0`（同 numpy：空的差分数组求和是 0）。
 */
export function trapezoid(y: readonly number[] | Float64Array, x: readonly number[] | Float64Array): number {
  const n = y.length
  if (x.length !== n) throw new RangeError(`trapezoid 的 x 与 y 长度不等：${x.length} vs ${n}`)
  if (n < 2) return 0
  const terms = new Float64Array(n - 1)
  for (let i = 0; i < n - 1; i += 1) {
    // numpy：`d * (y[1:] + y[:-1]) / 2.0` —— **先乘后除**，两个临时数组各一次舍入。
    terms[i] = (((x[i + 1] as number) - (x[i] as number)) * ((y[i + 1] as number) + (y[i] as number))) / 2.0
  }
  return npSum(terms)
}
