/**
 * 重采样 —— `map_coordinates` 与 `shift`，**只做 `order ∈ {0, 1}`**。
 *
 * ## 容差：**保证 `8 · eps`，实测 `0`** —— 两条都留着，而这一对救过一次
 *
 * - `order = 0`（最近邻）：**0**。输出的每一个数都是输入里某一个数原样搬过来，
 *   没有算术。所以错只会错在「挑了哪一格」，而那件事不该被容差盖住。
 * - `order = 1`（双线性）：**保证 `8 · eps`**（相对，按 `max|want|` 归一）。
 *   每个输出点是 4 项 `w·v` 的和，权重来自 `x − floor(x)`：
 *   1 次减法定 frac、4 次乘、3 次加，外加权重本身 1 次舍入 —— 量级 `8 eps ≈ 1.8e−15`。
 *   而**实测是 0**：折叠照抄了 scipy 的运算顺序，连累加顺序都一样，于是逐位相同。
 *   这句话直到 2026-10-13 才对帧边成立：之前它只在帧内的坐标上为真，抬头 ⑤–⑧ 是那一次补上的，
 *   判据是 `spec/golden/interp_edges.json`（带缺测行列的帧、界外与贴边坐标，逐位比）。
 *
 * 那 `8 eps` 的余量是留给「将来换一种累加顺序」的，不是留给现在这一版的，
 * 所以**两条都有测试**：一条按容差比，一条 `Object.is` 逐位比。
 *
 * ### 为什么非要留那条逐位的
 *
 * 写这一版时 `order=1 / reflect` 一度超差 1.09 倍（`1.94e−15` 对 `1.78e−15`）。
 * 第一反应是「界推紧了，重推一个松一点的」—— 而那个「松一点的界」也推得出来
 * （坐标折叠本身的舍入会乘上局部斜率，量级 `8·n·eps`），完全讲得通。
 *
 * **但真正的原因是折叠算错了**（见抬头 ④）。把容差调松会把它盖住整整一年。
 * 当场揪出来的是同一族里那个**零容差**的用例：`order=0 / mirror` 直接红了 0.93。
 *
 * 教训：**给一族数值函数留一个零容差的孪生档**。有容差的那一档报不出来的事，
 * 零容差的那一档会替它喊。
 *
 * ## `order ≥ 2` 直接抛，不近似
 *
 * scipy 的 `order ≥ 2` **先对整张图做一次样条预滤波**（`spline_filter`，
 * 一条前向 + 一条后向的 IIR 递推），得到的系数图才拿去插值。
 * 那一步是**全局**的：改一个像素会影响整张图的输出。
 * 拿三次卷积核去近似它，误差在 1e−2 量级 —— 那不是容差，那是另一个算法。
 *
 * 所以这里抛。`export_numerics.py` 仍然记了 `order=3` 的金样：
 * **记下来是为了证明我们知道它长什么样、并且确实没在复现它**，
 * 将来谁要补这一块，判据现成。
 *
 * ## ⚠️ `wrap` 在这里和 `filters.ts` 里**不是同一个东西**
 *
 * | 名字 | `filters.ts`（scipy 滤波族） | 这里（scipy 插值族） |
 * |---|---|---|
 * | `wrap` | 周期 **`n`**：`a b c d \| a b c d` | 周期 **`n − 1`**：首尾两点重合 |
 *
 * 同一个字符串，同一个库，两族函数里含义不同 —— scipy 自己的文档把插值族的
 * `wrap` 画成 `(d b c d | a b c d | b c a b)`，并注明重合点取哪一个「没有定义」。
 * 于是**这个文件不能复用 `boundaryIndex`**：复用才是 bug，而且是那种
 * 只在图像最后一列附近差一点、看图完全看不出来的 bug。
 *
 * 这一条是 D-CHANNELS-1 的形状：两个长得一样、行为不一样的东西，
 * 正是将来重构最想合并的那一对。所以它们分开住，并且各有一条测试互相指认。
 *
 * ## 三条由金样问出来的约定
 *
 * **① 先折坐标，再插值** —— 不是「先取两个邻居下标、各自折回去」。
 * 两者在 `order = 1` 上大部分时候一样，在 `order = 0` 的 `reflect`/`mirror` 上
 * 当场不一样（折完再四舍五入 ≠ 四舍五入完再折）。
 *
 * **② `order = 0` 的取整是 `floor(x + 0.5)`（四舍五入），不是就近偶数。**
 * 半整数坐标探针（`round_probe`）里 `0.5 → 1`、`2.5 → 3`：
 * 就近偶数会给 `0` 和 `2`。这两条规则在非半整数的坐标上**完全分辨不出来**，
 * 所以那组探针是特意为了分辨它们才加的。
 *
 * **③ `constant` 的界外判据是 `x < 0 || x > n − 1`（严格），整点作废不混合。**
 * 一个点只要有一个轴在界外，**整个点**就是 `cval` —— 不是「界外的邻居取 cval
 * 再和界内的邻居加权平均」。所以 `x = 11.0`（`n = 12`）给真值，
 * `x = 11.001` 给 `cval`，中间没有过渡带。
 *
 * **④ `mirror` 在 `(n−1, n)` 这一段上根本不折坐标** —— 留给之后的整数下标去折。
 * scipy 的 `map_coordinate` 外层判 `x > n−1` 才进来，内层却判 `y >= n` 才翻，
 * 于是 `x = 11.5`（`n = 12`）一路活到取整：`floor(12.0) = 12`，
 * 再由下标折叠给出第 **10** 行。先折坐标的话是 `10.5 → 11` —— **差一行**。
 *
 * 而 `order = 1` 上两种做法**完全同解**（两个邻居折过去正好是对称的那一对），
 * 只有 `order = 0` 的取整分得开。所以这一条也只有零容差的那一档抓得住。
 *
 * ## 又四条，由缺测帧问出来（2026-10-13，`interp_edges.json`）
 *
 * 上面四条的金样是一张有限帧、按容差比，下面四条在那上面要么只差末位、要么根本不出现。
 * 而帧一旦有没扫到的行（部分采集），它们就是「有限值」对「NaN」的差别。
 *
 * **⑤ `nearest` 不折坐标。** scipy 只对其余模式调 `map_coordinate`，`nearest` 的界外坐标原样留着
 * （连 `n = 1` 也不折）：`x = −0.3` 取 `floor = −1`、`t = 0.7`，两个邻点下标都夹回第 0 行。
 * 先把坐标夹到 0 的话，第二个邻点是第 1 行、权重 0 —— 第 1 行缺测时结果就成了 NaN。
 *
 * **⑥ 越界邻点按 `_get_spline_boundary_mode` 延拓**：`constant` 与 `wrap` 改用 `mirror`
 * （周期 2n − 2），`reflect`、`mirror`、`nearest` 照原模式。`wrap` 的**坐标**仍按周期 n − 1 折，
 * 只是 `x = n − 1` 上那个权重为 0 的邻点（下标 n）落到第 n − 2 行，而不是第 1 行。
 *
 * **⑦ 四个邻点都乘进来，权重为 0 的不跳过。** 权重是 `1 − t` 与 `1 − (1 − t)`（scipy 让末位权重
 * 等于 1 减其余），每项是 `(值 · 行权重) · 列权重`，按 C 序从 `0.0` 加起；`order = 0` 也是 `0.0 + 值`。
 *
 * **⑧ NaN 坐标整点取 `cval`**（`nearest` 除外）：`map_coordinate` 里两个比较都不成立、原样返回，
 * 随后 `cc > −1` 也不成立。`nearest` 的 NaN 坐标在 `order = 0` 取第 0 格（scipy 把 `floor(NaN)` 转成
 * 整数再夹边），在 `order = 1` 得 NaN（权重是 NaN）。`reflect` 另有一条 `−1e−15` 判据：
 * (−1e−15, 0) 上的坐标折成 `1e−15 − 1`。
 */
import { matOf, type Mat } from './mat.js'
import { EPS } from './stats.js'

/**
 * 插值族的边界模式。**名字与 `filters.ts` 的 `BoundaryMode` 一样，`wrap` 的含义不一样**
 * —— 见文件抬头。故意写成独立的类型名，好让读代码的人在这里停一下。
 */
export type InterpMode = 'reflect' | 'nearest' | 'constant' | 'mirror' | 'wrap'

/** 只支持这两阶。`order ≥ 2` 要样条预滤波，见文件抬头。 */
export type InterpOrder = 0 | 1

/**
 * 重采样与 scipy 比时的**保证**相对容差（按 `max|want|` 归一）。见文件抬头。
 *
 * 实测是 `0`（逐位相等），而那一条由另一条测试单独盯着 —— 两条都要，
 * 抬头那段「为什么非要留那条逐位的」讲的就是这一对救过什么。
 */
export function interpRelTol(order: InterpOrder): number {
  return order === 0 ? 0 : 8 * EPS
}

const mod = (a: number, p: number): number => ((a % p) + p) % p

/**
 * 把坐标 `x` 折回来，**折的是连续坐标不是下标**（见抬头 ①）。
 * 折不回来就给 `null`，整个点取 `cval`（抬头 ③、⑧）。
 *
 * ⚠️ **折完不一定落在 `[0, n−1]` 里** —— `mirror` 有意留了一段（抬头 ④），`nearest` 根本不折（抬头 ⑤）。
 * 每一支都照抄 scipy `ni_interpolation.c` 的 `map_coordinate`，包括它的内层判据。
 */
function foldCoord(x: number, n: number, mode: InterpMode): number | null {
  if (n <= 0) return null
  if (mode === 'nearest') return x // 抬头 ⑤：邻点下标由 foldIndex 夹回帧内
  if (x >= 0 && x <= n - 1) return x // 界内原样 —— 下面每一支都只管界外
  if (Number.isNaN(x)) return null // 抬头 ⑧
  if (n === 1) return mode === 'constant' ? null : 0
  switch (mode) {
    case 'constant':
      return null
    case 'wrap': {
      // 周期 n−1：首尾两点重合。**不是** filters.ts 的周期 n。
      const sz = n - 1
      return x < 0 ? x + sz * (Math.trunc(-x / sz) + 1) : x - sz * Math.trunc(x / sz)
    }
    case 'reflect': {
      // 关于 −0.5 与 n−0.5 翻折，周期 2n（边界样本重复一次）
      const p = 2 * n
      if (x < 0) {
        const y = x < -p ? p * Math.trunc(-x / p) + x : x
        // scipy 的 −1e−15 判据（抬头 ⑧）：免得贴着 0 的坐标折成恰好 −1
        return y < -n ? y + p : (y > -1e-15 ? 1e-15 : -y) - 1
      }
      const y = x >= p ? x - p * Math.trunc(x / p) : x
      return y < n ? y : p - y - 1
    }
    case 'mirror': {
      // 关于 0 与 n−1 翻折，周期 2n−2（边界样本不重复）
      const p = 2 * n - 2
      if (x < 0) {
        const y = p * Math.trunc(-x / p) + x
        return y <= 1 - n ? y + p : -y
      }
      const y = x - p * Math.trunc(x / p)
      return y >= n ? p - y : y // ← `>= n` 而不是 `> n−1`：那一段是抬头 ④
    }
  }
}

/**
 * 折完坐标、取完整之后，**邻点下标还可能越界**，这里按 scipy `_get_spline_boundary_mode`
 * 选的模式再折（抬头 ⑥）：`constant` 与 `wrap` 用 `mirror`，其余照原模式。
 *
 * `mirror` 的 (n−1, n) 那一段（抬头 ④）与 `nearest` 的界外坐标（抬头 ⑤）会真的用到这里，
 * 其余情形越界的那一格权重恰为 0 —— 但它照样乘进结果（抬头 ⑦），NaN · 0 = NaN，
 * 所以这一格落在哪一行决定缺测怎么传。
 */
function foldIndex(i: number, n: number, mode: InterpMode): number {
  if (i >= 0 && i < n) return i
  if (n <= 1) return 0
  switch (mode) {
    case 'reflect': {
      const p = 2 * n
      const m = mod(i, p)
      return m >= n ? p - 1 - m : m
    }
    case 'nearest':
      // 夹边界。NaN 下标（来自 NaN 坐标）落到第 0 格：scipy 把 floor(NaN) 转成整数时
      // 得到最小的负整数（x86）或 0（ARM），夹完都是 0
      return i >= n ? n - 1 : 0
    default: {
      // constant、wrap、mirror：周期 2n − 2
      const p = 2 * n - 2
      const m = mod(i, p)
      return m >= n ? p - m : m
    }
  }
}

/** 在折过的坐标上取一个值。`order` 决定最近邻还是双线性。 */
function sampleFolded(m: Mat, ry: number, cx: number, order: InterpOrder, mode: InterpMode): number {
  if (order === 0) {
    // floor(x + 0.5) —— 四舍五入，不是就近偶数（抬头 ②）
    const r = foldIndex(Math.floor(ry + 0.5), m.rows, mode)
    const c = foldIndex(Math.floor(cx + 0.5), m.cols, mode)
    return 0 + (m.data[r * m.cols + c] as number) // scipy 从 0.0 加起：−0 出来是 +0（抬头 ⑦）
  }
  const r0 = Math.floor(ry)
  const c0 = Math.floor(cx)
  const fr = ry - r0
  const fc = cx - c0
  // 抬头 ⑦：权重 `1 − t` 与 `1 − (1 − t)`，每项 `(值 · 行权重) · 列权重`，按 C 序累加，
  // 权重为 0 的邻点也算。2026-10-12 之前这里先乘权重、跳过零权重、末位权重取 t：
  // 约三成的点末位不同，部分采集帧上 NaN 的语义也不同（visual-memory 剖线移植时发现）。
  const wr0 = 1 - fr
  const wc0 = 1 - fc
  const wr = [wr0, 1 - wr0]
  const wc = [wc0, 1 - wc0]
  let acc = 0
  for (let dr = 0; dr <= 1; dr += 1) {
    const r = foldIndex(r0 + dr, m.rows, mode)
    for (let dc = 0; dc <= 1; dc += 1) {
      acc += ((m.data[r * m.cols + foldIndex(c0 + dc, m.cols, mode)] as number) * (wr[dr] as number)) * (wc[dc] as number)
    }
  }
  return acc
}

/** `order ≥ 2` 的拒绝理由写在这里，好让抛出来的那句话自己解释清楚。 */
function checkOrder(order: number): asserts order is InterpOrder {
  if (order !== 0 && order !== 1) {
    throw new RangeError(
      `重采样只支持 order 0（最近邻）与 1（双线性），得到 ${order}。` +
        'scipy 的 order ≥ 2 会先对整张图做一次样条预滤波（全局 IIR 递推），' +
        '不做那一步而直接用样条核去插值，误差在 1e-2 量级 —— 那是另一个算法，不是容差。',
    )
  }
}

/**
 * scipy 的 `ndi.map_coordinates`（二维）。
 *
 * `rowCoords[k]` / `colCoords[k]` 是第 k 个采样点的行/列坐标（**浮点、可越界**），
 * 返回长度同为 `k` 的一维结果 —— 与 scipy 的 `coordinates=[rows, cols]` 对齐。
 */
export function mapCoordinates(
  m: Mat,
  rowCoords: ArrayLike<number>,
  colCoords: ArrayLike<number>,
  order: InterpOrder,
  mode: InterpMode = 'constant',
  cval = 0,
): Float64Array {
  checkOrder(order)
  if (rowCoords.length !== colCoords.length) {
    throw new RangeError(`行列坐标个数对不上：${rowCoords.length} vs ${colCoords.length}`)
  }
  const out = new Float64Array(rowCoords.length)
  for (let k = 0; k < out.length; k += 1) {
    const ry = foldCoord(rowCoords[k] as number, m.rows, mode)
    const cx = foldCoord(colCoords[k] as number, m.cols, mode)
    // 任一轴折不回来 ⇒ 整个点作废（抬头 ③），不是只把那一维换成 cval
    out[k] = ry === null || cx === null ? cval : sampleFolded(m, ry, cx, order, mode)
  }
  return out
}

/**
 * scipy 的 `ndi.shift`（二维）。**名字加了 `Image` 后缀**：这个包是扁平导出的，
 * 一个叫 `shift` 的顶层名字迟早会被某个局部变量遮住，而那种遮蔽不报错。
 *
 * ⚠️ **方向**：`shiftImage(a, s)` 给的是 `out[i] = a[i − s]` —— 内容往 **`+s`** 方向搬。
 * 正号是「往下/往右挪」。符号搞反了图还是一张好图，只是漂移补偿会**加倍**而不是归零。
 */
export function shiftImage(
  m: Mat,
  rowShift: number,
  colShift: number,
  order: InterpOrder,
  mode: InterpMode = 'constant',
  cval = 0,
): Mat {
  checkOrder(order)
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    const ry = foldCoord(r - rowShift, m.rows, mode)
    for (let c = 0; c < m.cols; c += 1) {
      const cx = foldCoord(c - colShift, m.cols, mode)
      out[r * m.cols + c] = ry === null || cx === null ? cval : sampleFolded(m, ry, cx, order, mode)
    }
  }
  return matOf(m.rows, m.cols, out)
}
