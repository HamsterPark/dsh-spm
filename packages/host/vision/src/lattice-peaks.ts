/**
 * **K1 —— 二维布拉格峰**（旧仓 `mast/vision/lattice_calibration.py` 的取峰那一半）。
 *
 * 这是「晶格判据底座」的一半：`measure_cell`（原胞）、`assess_atomic_phase`
 * 的判据 3b（这些峰是不是同一个晶格）、`collect_observation`（跨帧一致性）
 * 三处都向它要峰，**而且都只向它要**。旧仓的抬头写着为什么只许有一份：
 * 再写一份找峰「只会让两处慢慢漂开」。
 *
 * ## 容差：{@link latticePeakRelTol}，而**一半的字段其实是零容差的**
 *
 * | 件 | 容差 | 推导 |
 * |---|---|---|
 * | `kx` / `ky` / `nPeaks` / `nRidge` / `hexagonal` / `reason` / 告警原文 | **0** | 它们是**下标与标签**。一个「差不多的下标」不是精度问题，是另一个峰 |
 * | `periodNm` | `4·eps` | `span·nm_per_px / r`：`r = hypot(整数, 整数)`（两边各一次，至多差 1 ulp），再一次除法 ⇒ ≤ 2 ulp，取 4 留余量 |
 * | `angleDeg` | `4·eps`（按 180° 归一） | 一次 `atan2(整数, 整数)`。V8 与 C 的 libm 都不是正确舍入的，差至多 1 ulp |
 * | `power` | `fftRelTol(ny·nx)`，**尺度是 `‖F‖∞`** | 它是 `|fft2(flat·win)|` 的一个元素 —— 误差整条来自那次 FFT，而一次 FFT 的**绝对**误差由整幅谱的最大系数定，不由这个系数自己定。一个比峰小五个量级的脊点，它的绝对误差和峰的一样大 |
 * | `periodMeanNm` / `periodSpread` / `directionBalance` | 同上取大者 | 三个 `periodNm` 的 `np.mean`（`npMean` 逐位复刻成对求和）与一次比值 |
 *
 * ⇒ 整表按 {@link latticePeakRelTol}`(ny, nx)` = `max(4·eps, fftRelTol(ny·nx))` 比，
 * 按「同一字段在整批金样上的最大绝对值」归一（`golden.ts` 那条规则）。
 * **下标与计数被它接住**：它们的差要么是 0，要么 ≥ 1，而容差在 1e−14 量级。
 *
 * ### 为什么峰**位**可以要求逐位相同
 *
 * `argmax` 是**离散**判据，而离散判据在输入没有鉴别力时「答案由最后一位浮点决定」
 * （批 4a 那四次「掷骰子」）。这一层的做法与那四次相同：**改输入，不改容差** ——
 * 金样里的每一格都合成成「峰比它的邻居高一个量级」的样子，于是 `fftRelTol`
 * 级别的扰动挪不动 `argmax`。反过来，一格真的会因为 1e−15 而换峰的用例，
 * 它的答案本来就没有定义，不该进金样（D-NUM-18 的形状）。
 *
 * ## 两处 numpy 语义，写错都不会报错
 *
 * 1. **`np.argmax` 平局取第一个**（C 序：行优先、下标小的先）。局部极大被
 *    `_PEAK_MIN_SEP_PX` 的方框逐个抹掉，抹的顺序就是取峰的顺序 ——
 *    平局取后一个会让**整串峰**换一个次序，而每一个仍然是合法的峰。
 * 2. **`angle_deg % 180` 是 Python 的模**（`pyMod`）。`arctan2` 给 (−180, 180]，
 *    JS 的 `%` 对负数给负数，于是 `−150 % 180` 在两边分别是 `30` 与 `−150`，
 *    「独立方向」的去重当场换一组结果。
 */
import { pyMod } from 'dsh-spm-kernel'
import {
  EPS,
  fft2,
  fftRelTol,
  hanning,
  matAt,
  matOf,
  npMean,
  type Mat,
} from 'dsh-spm-numerics'
import { finiteOf, npMedian } from './nd.js'
import { lstsqPlane } from './plane.js'

/**
 * 峰表整体的相对容差（推导见文件抬头那张表）。
 *
 * `4·eps` 那一档管的是 `periodNm` / `angleDeg`（各一两次舍入），
 * `fftRelTol` 那一档管的是 `power`（它整条误差来自那次 FFT）。
 * 取大者 —— 一张表用一个数，而这个数由**表里最松的那一项**定。
 */
export function latticePeakRelTol(rows: number, cols: number): number {
  return Math.max(4 * EPS, fftRelTol(rows * cols))
}

/** 已知表面的**最近邻原子间距** a（nm）。旧仓 `SURFACE_LATTICE_NM` 逐条。 */
export const SURFACE_LATTICE_NM: Readonly<Record<string, number>> = {
  'Au(111)': 0.2884,
  'Ag(111)': 0.2889,
  'Cu(111)': 0.2556,
  'Pt(111)': 0.2775,
  HOPG: 0.2464,
  'NaCl(100)': 0.399,
  'Si(111)-1x1': 0.384,
}

/** 正方晶格的表面：一阶峰周期就是 a 本身，没有 √3/2 那一步。 */
export const SQUARE_SURFACES: ReadonlySet<string> = new Set(['NaCl(100)'])

/** 一阶峰的搜索带（纳米周期）。与 `ATOMIC_BAND_NM` 必须同一区间。 */
export const PEAK_BAND_NM: readonly [number, number] = [0.18, 0.8]

/** 峰之间的最小间隔（像素）。小于它的两个极大是同一个峰的肩膀。 */
export const PEAK_MIN_SEP_PX = 8

/** 认定「六重对称」时相邻峰夹角与 60° 的最大偏差。 */
export const HEX_ANGLE_TOL_DEG = 8.0

/** 脊分的阈值。两批互相独立的样本把空隙落在同一处：真峰 ≤ 0.137、脊点 ≥ 0.525。 */
export const RIDGE_SCORE_MAX = 0.145

/** 取脊邻居的半径范围（像素）。下界必须大于 `PEAK_MIN_SEP_PX` 才不会量到峰自己。 */
export const RIDGE_SPAN_PX: readonly [number, number] = [9, 18]

/**
 * 该表面 FFT 一阶峰对应的实空间周期（nm）；未知表面给 `null`。
 *
 * 六角面是原子**行间距** `d = √3/2·a`，不是最近邻距离 `a`。两者差 15.5%，
 * 而典型的压电偏差是 10% —— 跳过这一步会得到一个看起来很合理的错数。
 */
export function firstOrderPeriodNm(surface: string): number | null {
  const a = SURFACE_LATTICE_NM[surface]
  // 旧仓写的是 `if not a`，所以 0 与缺席同义（表里没有 0，这一条只是照移）。
  if (!a) return null
  return SQUARE_SURFACES.has(surface) ? a : (a * Math.sqrt(3)) / 2
}

/** 倒空间里的一个一阶峰。`kx`/`ky` 以像素为单位，原点在谱中心。 */
export interface LatticePeak {
  readonly kx: number
  readonly ky: number
  readonly power: number
  readonly periodNm: number
  readonly angleDeg: number
}

/** 一帧上的晶格测量。`ok=false` 时 `reason` 说明为什么量不了。 */
export interface LatticeResult {
  readonly ok: boolean
  readonly reason: string
  readonly nPeaks: number
  readonly peaks: readonly LatticePeak[]
  readonly hexagonal: boolean
  readonly periodsNm: readonly number[]
  readonly periodMeanNm: number | null
  readonly periodSpread: number | null
  readonly anglesDeg: readonly number[]
  readonly latticeAngleDeg: number | null
  readonly directionBalance: number | null
  /** 被 `isRidgePoint` 剔掉的那些极大**本身** —— 见 `assess_atomic_phase` 判据 3b。 */
  readonly ridgePeaks: readonly LatticePeak[]
  /** 被剔掉的个数。**必须是字段，不能只写进 `warnings`**：下游要用它把
   * 「看了，看到的全是脊」与「没法看」分开，而那句告警是给人读的中文。 */
  readonly nRidge: number
  readonly warnings: readonly string[]
}

function emptyResult(reason: string, over: Partial<LatticeResult> = {}): LatticeResult {
  return {
    ok: false,
    reason,
    nPeaks: 0,
    peaks: [],
    hexagonal: false,
    periodsNm: [],
    periodMeanNm: null,
    periodSpread: null,
    anglesDeg: [],
    latticeAngleDeg: null,
    directionBalance: null,
    ridgePeaks: [],
    nRidge: 0,
    warnings: [],
    ...over,
  }
}

/**
 * 去一次平面（旧仓 `_plane_subtract`）。倾斜的背景在谱心附近堆起一座低频山，
 * 会淹掉一阶峰。
 *
 * 有限像素不足 16 个时退到「减掉均值」——**那一支不是兜底，是判据**：
 * 三个未知数配十几个方程解出来的平面是噪声，减掉它比不减更糟。
 *
 * ⚠️ **拟合走 {@link lstsqPlane}（批 4a 那一份），不再写第二份。**
 * 那一份的抬头写着为什么要先把 x/y 中心化：裸设计阵 `[x, y, 1]` 的 κ 在 10³ 量级，
 * 正规方程把它平方 ⇒ 误差界 `10⁻⁸`，而中心化之后三列互相正交、κ 掉到个位数。
 *
 * **第一版没走它，代价当场可见**：`half`（四成是零的帧）那一格，谱上一个脊点的
 * `|F|` 与 numpy 差 `2.4e−22`，**是 FFT 自己精度的 42 倍** —— 那个差额根本不是
 * FFT 的，是「两边减掉的平面不一样」。这正是「十份 `cell()`」那一课的形状：
 * 一份本地重写的最小二乘，和一份已经被两批金样验过的，**差别看不见直到它咬人**。
 */
export function planeSubtractLstsq(m: Mat): Mat {
  const { rows, cols } = m
  const n = rows * cols
  const idx: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(m.data[i] as number)) idx.push(i)
  const out = new Float64Array(n)
  if (idx.length < 16) {
    const mean = npMean(finiteOf(m.data))
    for (let i = 0; i < n; i += 1) out[i] = (m.data[i] as number) - mean
    return matOf(rows, cols, out)
  }
  const xs = new Float64Array(idx.length)
  const ys = new Float64Array(idx.length)
  const zs = new Float64Array(idx.length)
  for (let k = 0; k < idx.length; k += 1) {
    const i = idx[k] as number
    xs[k] = i % cols
    ys[k] = Math.floor(i / cols)
    zs[k] = m.data[i] as number
  }
  const coef = lstsqPlane(xs, ys, zs)
  if (coef === null) {
    const mean = npMean(finiteOf(m.data))
    for (let i = 0; i < n; i += 1) out[i] = (m.data[i] as number) - mean
    return matOf(rows, cols, out)
  }
  const [a0, a1, a2] = coef
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out[r * cols + c] = matAt(m, r, c) - (a0 * c + a1 * r + a2)
    }
  }
  return matOf(rows, cols, out)
}

/**
 * 这个「峰」是不是**一条脊上的一点**（而不是一个孤立的布拉格点）。
 *
 * ## 判据：脊分（唯一判别量）
 *
 * 脊分 = 峰外 9–18 像素范围内邻居的**中位数** ÷ 峰值，沿两轴各算取大者。
 * 脊上的点邻居也高 ⇒ 接近 1；紧致的布拉格峰 ⇒ 很小。
 *
 * 取中位数而不是均值是有意的：六角晶格里相邻的两个真峰相距约 `|k|`，
 * 可能正好落进 9–18 的窗口，均值会被那一个邻居拽高，中位数不会。
 *
 * 两批互相独立的标定（5 组合成 + 1 帧真机 36 个峰；演示当晚 129 帧 ×2 方向）
 * 把空隙落在同一处：真峰 0.015–0.137、脊点 0.525–1.166，阈值 0.145 在两批里
 * 都在空隙中间。
 *
 * ## 2026-08-24：「只查轴上的峰」那条前置条件删掉了
 *
 * 原来有一条「扫描噪声只住在 `kx≈0` 或 `ky≈0`，不在轴上的峰一律不碰」。
 * 它挡住的不是误报，**是这个判据自己的射程**：一条平行于 kx 轴、位于
 * `ky = ±10` 的横向脊不过原点，于是被整个放过 —— 而那正是 0569 那张
 * 「角向集中度 315.1、剖面只有 ±1 pm」的噪声帧通关的原因。
 */
export function isRidgePoint(F: Mat, cy: number, cx: number, kx: number, ky: number): boolean {
  const ny = F.rows
  const nx = F.cols
  const xi = Math.round(cx + kx)
  const yi = Math.round(cy + ky)
  if (!(xi >= 0 && xi < nx && yi >= 0 && yi < ny)) return false
  const pw = matAt(F, yi, xi)
  if (!(pw > 0)) return false
  const [lo, hi] = RIDGE_SPAN_PX
  const offs: number[] = []
  for (let o = lo; o <= hi; o += 1) offs.push(o)
  for (let o = lo; o <= hi; o += 1) offs.push(-o)
  const vy: number[] = []
  const vx: number[] = []
  for (const d of offs) {
    if (yi + d >= 0 && yi + d < ny) vy.push(matAt(F, yi + d, xi))
    if (xi + d >= 0 && xi + d < nx) vx.push(matAt(F, yi, xi + d))
  }
  if (vy.length === 0 || vx.length === 0) return false
  const score = Math.max(npMedian(vy) / pw, npMedian(vx) / pw)
  return score >= RIDGE_SCORE_MAX
}

/** `findLatticePeaks` 的可选项。 */
export interface LatticePeakOptions {
  readonly bandNm?: readonly [number, number]
  readonly maxPeaks?: number
}

/**
 * 二维功率谱里的一阶布拉格峰。
 *
 * 峰取的是**二维局部极大**，不是径向剖面的极大 —— 径向会把三组方向平均掉，
 * 而三组方向之间的差异正是畸变的全部信息。
 *
 * 循环上限给 `maxPeaks·3` 而不是 2 倍：**被剔掉的脊点也消耗迭代次数**，
 * 上限给太紧会让真峰在噪声重的帧上被饿死。
 */
export function findLatticePeaks(image: Mat, nmPerPx: number, opts: LatticePeakOptions = {}): LatticeResult {
  const bandNm = opts.bandNm ?? PEAK_BAND_NM
  const maxPeaks = opts.maxPeaks ?? 6
  const ny = image.rows
  const nx = image.cols
  if (Math.min(ny, nx) < 32) return emptyResult('image_too_small')
  if (!(nmPerPx && nmPerPx > 0)) return emptyResult('unknown_pixel_size')

  const n = ny * nx
  let nFinite = 0
  for (let i = 0; i < n; i += 1) if (Number.isFinite(image.data[i] as number)) nFinite += 1
  const frac = nFinite / n
  if (frac < 0.5) {
    // 半张图都没有的帧做不了二维谱：缺的那半会被当成常数，谱上多出一片
    // 与扫描无关的结构。这正是「扫了几行就停」的帧的样子。
    return emptyResult('incomplete_frame', { warnings: [`有效像素只有 ${fmtPct(100 * frac)}%`] })
  }
  const fillMean = npMean(finiteOf(image.data))
  const filled = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = image.data[i] as number
    filled[i] = Number.isFinite(v) ? v : fillMean
  }
  const flat = planeSubtractLstsq(matOf(ny, nx, filled))

  const wy = hanning(ny)
  const wx = hanning(nx)
  const windowed = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) windowed[r * nx + c] = matAt(flat, r, c) * (wy[r] as number) * (wx[c] as number)
  }
  const spec = fft2(matOf(ny, nx, windowed))
  const cy = ny >> 1
  const cx = nx >> 1
  // `fftshift` + `abs`。移位按 numpy：新下标 `i` 取旧下标 `(i + (n+1)//2) % n`
  // 的那一格（等价于把 `n//2` 挪到中心）。
  const Fd = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    const sr = (r + Math.ceil(ny / 2)) % ny
    for (let c = 0; c < nx; c += 1) {
      const sc = (c + Math.ceil(nx / 2)) % nx
      Fd[r * nx + c] = Math.hypot(matAt(spec.re, sr, sc), matAt(spec.im, sr, sc))
    }
  }
  // DC 与最低频：`F[cy-3:cy+4, cx-3:cx+4] = 0`。Python 的切片**自动夹到边界**，
  // 而负的起点会从另一头数起 —— 本函数的下界 `min(ny,nx) ≥ 32` 挡住了那一支。
  for (let r = Math.max(0, cy - 3); r < Math.min(ny, cy + 4); r += 1) {
    for (let c = Math.max(0, cx - 3); c < Math.min(nx, cx + 4); c += 1) Fd[r * nx + c] = 0
  }
  const F = matOf(ny, nx, Fd)

  // 周期（nm）= 视场 / |k|。视场沿两轴可能不同，这里用平均值定带；
  // **带只是搜索范围，不参与定量**。
  const spanPx = 0.5 * (nx + ny)
  const period = new Float64Array(n)
  const work = new Float64Array(n)
  let bandAny = false
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      const i = r * nx + c
      const rr = Math.hypot(c - cx, r - cy)
      const p = rr > 0 ? (spanPx * nmPerPx) / Math.max(rr, 1e-9) : Infinity
      period[i] = p
      const inBand = p >= bandNm[0] && p <= bandNm[1]
      if (inBand) bandAny = true
      work[i] = inBand ? (Fd[i] as number) : 0
    }
  }
  if (!bandAny) return emptyResult('band_empty')

  const peaks: LatticePeak[] = []
  const ridged: LatticePeak[] = []
  let nRidge = 0
  for (let iter = 0; iter < maxPeaks * 3; iter += 1) {
    // `np.argmax`：平局取**第一个**（C 序）。所以这里是严格大于。
    let best = 0
    for (let i = 1; i < n; i += 1) if ((work[i] as number) > (work[best] as number)) best = i
    if ((work[best] as number) <= 0) break
    const yi = Math.floor(best / nx)
    const xi = best % nx
    const y0 = Math.max(0, yi - PEAK_MIN_SEP_PX)
    const y1 = Math.min(ny, yi + PEAK_MIN_SEP_PX + 1)
    const x0 = Math.max(0, xi - PEAK_MIN_SEP_PX)
    const x1 = Math.min(nx, xi + PEAK_MIN_SEP_PX + 1)
    const pk: LatticePeak = {
      kx: xi - cx,
      ky: yi - cy,
      power: Fd[best] as number,
      periodNm: period[best] as number,
      angleDeg: (Math.atan2(yi - cy, xi - cx) * 180) / Math.PI,
    }
    const ridge = isRidgePoint(F, cy, cx, xi - cx, yi - cy)
    if (ridge) {
      nRidge += 1
      ridged.push(pk)
    } else {
      peaks.push(pk)
    }
    for (let r = y0; r < y1; r += 1) for (let c = x0; c < x1; c += 1) work[r * nx + c] = 0
    if (!ridge && peaks.length >= maxPeaks) break
  }
  if (peaks.length < 2) {
    // **`nRidge` 必须跟着这条路一起出去。** 「一个峰都没剩下，因为候选全是脊」
    // 和「这帧上本来就什么都没有」是完全不同的两件事，而下游只有拿到这个数才分得开。
    return emptyResult('too_few_peaks', {
      nPeaks: peaks.length,
      peaks,
      nRidge,
      ridgePeaks: ridged,
      warnings: nRidge ? [`剔掉 ${nRidge} 个脊上的点后不足两个一阶峰`] : [],
    })
  }

  // 每个峰有一个 ±k 的孪生。取角度落在 [0,180) 的那一半作为独立方向。
  const uniq: LatticePeak[] = []
  for (const p of peaks) {
    const a = pyMod(p.angleDeg, 180)
    const dup = uniq.some((q) => {
      const d = Math.abs(a - pyMod(q.angleDeg, 180))
      return Math.min(d, 180 - d) < 10
    })
    if (!dup) uniq.push(p)
  }
  // Python 的 `sort` 与 JS 的 `Array#sort` 都是**稳定**的 —— 等功率时保持
  // 取峰顺序。这一条要紧：换成不稳定排序会让等功率的两个方向互换，
  // 而 `latticeAngleDeg` 取的是 `min(angles)`，`periods` 的顺序也会跟着变。
  const sorted = [...uniq].sort((a, b) => b.power - a.power)
  const dirs = sorted.slice(0, 3)
  const periods = dirs.map((p) => p.periodNm)
  const angles = dirs.map((p) => pyMod(p.angleDeg, 180))
  const meanP = npMean(periods)
  const spread = meanP ? (Math.max(...periods) - Math.min(...periods)) / meanP : null

  // 三方向幅值平衡度 —— 「原子圆不圆」。**只报告，不做闸门**：它与
  // `angular_concentration` 是反着走的（2026-08-24 实测相关 −0.347），
  // 拿它当闸会挡掉「原子最圆」的那一张。
  let dirBal: number | null = null
  if (dirs.length >= 3) {
    const ps = dirs.filter((d) => d.power > 0).map((d) => d.power)
    if (ps.length >= 3 && Math.max(...ps) > 0) dirBal = Math.min(...ps) / Math.max(...ps)
  }

  let hexagonal = false
  const warns: string[] = []
  if (nRidge) {
    // **说出来。** 静默剔除会让「为什么这帧只有两个方向」无从回答，
    // 而且掩盖了「这台机器的行噪声大到能挤进一阶峰」这条真实信息。
    warns.push(`剔掉 ${nRidge} 个脊上的点（是一条脊的一段，不是一阶峰）`)
  }
  if (dirs.length >= 3) {
    const a = [...angles].sort((x, y) => x - y)
    const gaps = [(a[1] as number) - (a[0] as number), (a[2] as number) - (a[1] as number), 180 - ((a[2] as number) - (a[0] as number))]
    hexagonal = gaps.every((g) => Math.abs(g - 60) <= HEX_ANGLE_TOL_DEG)
    if (!hexagonal) {
      warns.push(`三个方向的夹角 ${fmtRound1List(gaps)} 偏离 60° 超过 ${fmtPct(HEX_ANGLE_TOL_DEG)}°`)
    }
  } else {
    warns.push(`只找到 ${dirs.length} 个独立方向，六重对称无从判起`)
  }

  return {
    ok: true,
    reason: '',
    nPeaks: peaks.length,
    peaks,
    hexagonal,
    periodsNm: periods,
    periodMeanNm: meanP,
    periodSpread: spread,
    anglesDeg: angles,
    latticeAngleDeg: angles.length > 0 ? Math.min(...angles) : null,
    directionBalance: dirBal,
    ridgePeaks: ridged,
    nRidge,
    warnings: warns,
  }
}

/** Python 的 `"%.0f"`（四舍六入五成双，`pyRound` 那一条在整数位上的特例）。 */
function fmtPct(x: number): string {
  // 这一族的数（百分比、角度容差）都远离「正好一半」，`toFixed` 与 Python 同解；
  // 而 `np.round(x, 1)` 那一支走 `fmtRound1List`，它另有一条理由。
  return x.toFixed(0)
}

/**
 * `str(np.round(gaps, 1).tolist())` —— **numpy 的 `round` 是半数取偶**，
 * 而且印出来的是 Python 的 `repr(list[float])`：`[59.9, 60.1, 60.0]`。
 *
 * 一个整数值的 float 在 Python 里印成 `60.0`（不是 `60`）—— 这一句进的是模型
 * 读的那段中文，所以 `pyStr` 的那条教训在这里也成立。
 */
function fmtRound1List(xs: readonly number[]): string {
  const one = (x: number): string => {
    const scaled = x * 10
    const r = Math.round(scaled)
    // 半数取偶：只在**精确**落在 .5 上时才生效。
    const half = Math.abs(scaled - Math.trunc(scaled)) === 0.5
    const v = half ? (Math.floor(scaled / 2) * 2 === scaled - 0.5 ? scaled - 0.5 : scaled + 0.5) / 10 : r / 10
    return Number.isInteger(v) ? `${v}.0` : String(v)
  }
  return `[${xs.map(one).join(', ')}]`
}
