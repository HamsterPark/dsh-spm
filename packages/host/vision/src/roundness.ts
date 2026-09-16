/**
 * 团簇「圆不圆」的**单一真源** —— 旧仓 `mast/vision/roundness.py`（359 行）。
 *
 * ## 旧判据错在哪：不是阈值定歪了，是它量的根本不是「圆」
 *
 * `circularity = 4πA/P²` 里的 `P` 数的是像素化边界暴露在背景的**边**数。这个口径下
 * 轴对齐正方形恒等于 **π/4 = 0.7854**（与边长无关，精确），而数字化圆盘的
 * **上确界只有 4π²/64 = 0.6169**。阈值 0.65 卡在两者之间：
 *
 * > **任何圆盘，不论多大多完美，都过不了；而一个轴对齐的方块永远过得了。**
 *
 * 所以 2026-08-11 起没有 `circularity` 字段了，而且**不做静默别名**：旧阈值 0.65
 * 填进 `min_axis_ratio` 会把闸门放宽到「长短轴差 35%」，而它照跑不误。
 *
 * ## 新判据：r(θ) 的相对离散，**减掉同面积完美圆盘那一份**
 *
 * ```
 * radialDispersion      = std(r) / mean(r)          r = 边界像素到质心的距离
 * radialDispersionFloor = 同一个量，量在一个同面积的合成完美圆盘上
 * radialDispersionExcess= sqrt(max(0, rd² − floor²))
 * equivalentAxisRatio   = 把 excess 反解成「同样离散的椭圆的短轴/长轴」
 * ```
 *
 * 不减 floor 就是**换个地方重建同一个系统性偏差**：完美圆盘的 rd 本身随面积变
 * （A=20 → 0.121，A=2000 → 0.011，**6 倍量程差，全是像素化**），
 * 一个固定阈值会系统性地判小团簇「不圆」。
 *
 * `floor` 是**推导出来的，不是拟合的**：画一个同面积的圆盘，用**同一段代码**量它，
 * 在八个亚像素中心上平均。没有可调常数，没有对某几帧的记忆。
 *
 * ## 判不了的时候要说出来
 *
 * * `A < 20 px`：完美圆盘在 1% 噪声下 excess 的 95 分位对应轴比 0.773（A=20）、
 *   0.642（A=12）—— 一个完美的圆有 5% 的概率被读成「差 36%」。这条线以下
 *   返回理由，不返回一个数；
 * * 边界像素 < 6：算不出 std。
 *
 * ## 容差
 *
 * | 件 | 对的是 | 容差 | 为什么 |
 * |---|---|---|---|
 * | `dispersionOfMask` 的边界掩膜 | `mask & ~ndi.binary_erosion(mask)` | **0** | 腐蚀只搬布尔位；错一位就是多/少一圈边界像素 |
 * | `dispersion` / `floor` / `excess` | `roundness.*` | `sumRelTol(n)` | 里面只有一次 `std/mean`，而本仓的 `sum` 是 Neumaier、numpy 是成对求和（D-NUM-1） |
 * | `axisRatio` | `axis_ratio_from_dispersion` | `Q_STEP`（=0.001）的一半 | 它是**在 981 格上插值**的结果；把容差写成格距的一半，说的是「不许挑到隔壁那一格」，而不是一个凭感觉的小数 |
 * | `backgroundLevel` | `np.histogram(x, 96)` | **0** | 数个数 + 取两个 edge 的平均 |
 *
 * ⚠️ 与 `vision.barker_quality.circularity_score` 的关系：那一个也是 `std(r)/mean(r)`，
 * 但它是**整帧针尖质量**（多个 feature、多个高度层、取中位数、**不减 floor**），
 * 量的是另一个问题，数值不可与这里互比。这是 D-CHANNELS-1 的形状 ——
 * 两个看起来一样的函数行为不一样，而合并会默默改掉判决。
 */
import {
  crossSE,
  greyErosion,
  histogram,
  matAt,
  matOf,
  mean,
  std,
  sumRelTol,
  type Mat,
} from 'dsh-spm-numerics'
import { autoRange, eigvalsh2, interp } from './nd.js'

/** 边界点少于这个数就算不出 std。 */
export const MIN_BOUNDARY_PX = 6

/** 面积下界。**对合成零假设标定**，不是对用户的帧。 */
export const MIN_AREA_PX = 20

/** 高度加权二阶矩至少要多少个有效像素才肯说话。比 `MIN_AREA_PX` 松 —— 它不依赖**边界**。 */
export const MIN_WEIGHTED_PX = 12

/** 反解 `excess → 椭圆轴比` 时的采样格：`linspace(0.02, 1.0, 981)`，格距 0.001。 */
export const Q_STEP = (1.0 - 0.02) / 980

/** `axisRatio` 的容差 = 半格。「不许挑到隔壁那一格」。 */
export const AXIS_RATIO_ABS_TOL = Q_STEP / 2

/** 轴比 q 的椭圆，r(θ) 的 `std/mean` —— **解析形状，推导不是拟合**。 */
export function ellipseDispersion(q: number): number {
  const n = 4096
  const r = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const t = (2 * Math.PI * i) / n
    r[i] = q / Math.hypot(q * Math.cos(t), Math.sin(t))
  }
  return std(r, 0) / mean(r)
}

let qGridCache: Float64Array | null = null
let qDispCache: Float64Array | null = null

function qTables(): { grid: Float64Array; disp: Float64Array } {
  if (qGridCache === null || qDispCache === null) {
    const n = 981
    const grid = new Float64Array(n)
    const disp = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      // `np.linspace(0.02, 1.0, 981)`：端点精确，中间按 `start + i*step` 算
      // （numpy 也会把最后一个强制设成 stop）。
      grid[i] = i === n - 1 ? 1.0 : 0.02 + (i * (1.0 - 0.02)) / (n - 1)
      disp[i] = ellipseDispersion(grid[i] as number)
    }
    qGridCache = grid
    qDispCache = disp
  }
  return { grid: qGridCache, disp: qDispCache }
}

/**
 * 把相对离散翻译成「同样离散的椭圆的短轴/长轴」。
 *
 * 这是阈值该说的语言：`equivalentAxisRatio >= 0.75` 就是
 * 「不比一个长短轴相差 25% 的椭圆更不规则」。
 */
export function axisRatioFromDispersion(d: number): number {
  const { grid, disp } = qTables()
  const last = disp[disp.length - 1] as number
  const first = disp[0] as number
  if (!(d === d) || d <= last) return 1.0
  if (d >= first) return grid[0] as number
  // `_Q_DISPERSION` 随 q 单调**递减**，而 `np.interp` 要求 xp 递增 ⇒ 两边取负。
  const negDisp = new Float64Array(disp.length)
  for (let i = 0; i < disp.length; i += 1) negDisp[i] = -(disp[i] as number)
  return interp(-d, negDisp, grid)
}

/** `std(r)/mean(r)`，r = 边界像素到**面积质心**的距离。`null` = 边界点不够。 */
export function dispersionOfMask(mask: Mat): number | null {
  const { rows, cols } = mask
  let any = false
  const bin = new Float64Array(rows * cols)
  for (let i = 0; i < rows * cols; i += 1) {
    const on = (mask.data[i] as number) !== 0
    bin[i] = on ? 1 : 0
    if (on) any = true
  }
  if (!any) return null
  // `scipy.ndimage.binary_erosion` 的缺省结构元是十字，`border_value=0`
  // ⇒ 界外算 False ⇒ 贴边的像素一律被腐蚀掉，于是**它们是边界**。
  const eroded = greyErosion(matOf(rows, cols, bin), crossSE(3), 'constant', 0)
  const ey: number[] = []
  const ex: number[] = []
  const ys: number[] = []
  const xs: number[] = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if ((bin[r * cols + c] as number) === 0) continue
      ys.push(r)
      xs.push(c)
      if (matAt(eroded, r, c) === 0) {
        ey.push(r)
        ex.push(c)
      }
    }
  }
  if (ey.length < MIN_BOUNDARY_PX) return null
  const cy = mean(ys)
  const cx = mean(xs)
  const r = ey.map((y, i) => Math.hypot(y - cy, (ex[i] as number) - cx))
  const m = mean(r)
  return m > 0 ? std(r, 0) / m : null
}

const floorCache = new Map<number, number>()

/** 量 floor 时用的八个亚像素中心。定心相位会让读数摆动，取平均是为了让 floor 不去追某一个相位。 */
const SUBPIXEL_OFFSETS: readonly (readonly [number, number])[] = [
  [0.0, 0.0],
  [0.5, 0.0],
  [0.0, 0.5],
  [0.5, 0.5],
  [0.25, 0.25],
  [0.25, 0.75],
  [0.75, 0.25],
  [0.13, 0.37],
]

/** 同面积**完美圆盘**的 radial dispersion —— 这个量的零点。 */
export function dispersionFloor(areaPx: number): number {
  const a = Math.trunc(areaPx)
  if (a < 1) return 0
  const hit = floorCache.get(a)
  if (hit !== undefined) return hit
  const radius = Math.sqrt(a / Math.PI)
  const n = Math.trunc(2 * radius + 9)
  const c = (n - 1) / 2
  const vals: number[] = []
  for (const [ox, oy] of SUBPIXEL_OFFSETS) {
    const disk = new Float64Array(n * n)
    for (let r = 0; r < n; r += 1) {
      for (let col = 0; col < n; col += 1) {
        disk[r * n + col] = Math.hypot(col - c - ox, r - c - oy) <= radius ? 1 : 0
      }
    }
    const v = dispersionOfMask(matOf(n, n, disk))
    if (v !== null) vals.push(v)
  }
  const out = vals.length > 0 ? mean(vals) : 0
  floorCache.set(a, out)
  return out
}

/** 一个团簇的圆度读数。`ok=false` 时只有 `reason` 有意义。 */
export interface Roundness {
  readonly ok: boolean
  readonly areaPx: number
  readonly dispersion: number | null
  readonly floor: number | null
  readonly excess: number | null
  readonly axisRatio: number | null
  readonly reason: string | null
}

/** `Roundness.as_dict()` —— 进 `SkillResult.data` 的那五个键，键名逐字照移。 */
export function roundnessDict(r: Roundness): Record<string, number | string | null> {
  return {
    radial_dispersion: r.dispersion,
    radial_dispersion_floor: r.floor,
    radial_dispersion_excess: r.excess,
    equivalent_axis_ratio: r.axisRatio,
    roundness_undecidable: r.ok ? null : (r.reason ?? '判不了'),
  }
}

/** 量一个连通域圆不圆。**判不了就说判不了**，不返回一个凑出来的数。 */
export function assessMask(mask: Mat, minAreaPx: number = MIN_AREA_PX): Roundness {
  let area = 0
  for (let i = 0; i < mask.rows * mask.cols; i += 1) if ((mask.data[i] as number) !== 0) area += 1
  if (area < minAreaPx) {
    const q = axisRatioFromDispersion(dispersionFloor(Math.max(area, 1)))
    return {
      ok: false,
      areaPx: area,
      dispersion: null,
      floor: null,
      excess: null,
      axisRatio: null,
      reason:
        `只有 ${area} 像素,低于 ${minAreaPx} —— 这个尺度上像素化本身` +
        `就能让一个**完美的圆**读出 ${q.toFixed(2)} 的轴比,给出的数会比没有数更糟。面积/峰高照常可用。`,
    }
  }
  const d = dispersionOfMask(mask)
  if (d === null) {
    return {
      ok: false,
      areaPx: area,
      dispersion: null,
      floor: null,
      excess: null,
      axisRatio: null,
      reason: `边界像素不足 ${MIN_BOUNDARY_PX} 个,算不出离散`,
    }
  }
  const f = dispersionFloor(area)
  const ex = Math.sqrt(Math.max(0, d * d - f * f))
  return { ok: true, areaPx: area, dispersion: d, floor: f, excess: ex, axisRatio: axisRatioFromDispersion(ex), reason: null }
}

/**
 * 轴比，但**用每一个点的高度当权重** —— 不二值化。
 *
 * `assessMask` 走「二值化 → 边界像素到质心的径向离散」，阈值以上的高低起伏全被丢掉，
 * 于是**结果完全由阈值切在哪儿决定**。这里改成算高度加权的协方差矩阵，
 * 轴比 = `√(λ_min/λ_max)`；落在阈值附近的点权重接近 0，所以阈值挪一点结果几乎不动。
 *
 * 一百针实测（阈值挪 ±20% 时轴比的变化，越小越好）：边界离散 0.0532 / 加权 0.0125；
 * 在标注「阈值不够低」的 13 张上 0.2451 / 0.0084 —— **稳 29 倍**。
 *
 * `base` **必须是背景众数，不能用 mean** —— mean 被团簇本身拉走了，那正是自指阈值的病根。
 */
export function weightedAxisRatio(height: Mat, mask: Mat, base: number): number | null {
  if (height.rows !== mask.rows || height.cols !== mask.cols) return null
  const ys: number[] = []
  const xs: number[] = []
  const w: number[] = []
  for (let r = 0; r < mask.rows; r += 1) {
    for (let c = 0; c < mask.cols; c += 1) {
      if ((mask.data[r * mask.cols + c] as number) === 0) continue
      let v = matAt(height, r, c) - base
      if (!(v > 0)) v = 0 // `np.clip(·, 0, None)`；NaN 走 `np.where(isfinite)` → 0
      if (!Number.isFinite(v)) v = 0
      if (v > 0) {
        ys.push(r)
        xs.push(c)
        w.push(v)
      }
    }
  }
  if (w.length < MIN_WEIGHTED_PX) return null
  let tot = 0
  for (const v of w) tot += v
  if (!(tot > 0)) return null
  let cy = 0
  let cx = 0
  for (let i = 0; i < w.length; i += 1) {
    cy += (w[i] as number) * (ys[i] as number)
    cx += (w[i] as number) * (xs[i] as number)
  }
  cy /= tot
  cx /= tot
  let cyy = 0
  let cxx = 0
  let cxy = 0
  for (let i = 0; i < w.length; i += 1) {
    const dy = (ys[i] as number) - cy
    const dx = (xs[i] as number) - cx
    cyy += (w[i] as number) * dy * dy
    cxx += (w[i] as number) * dx * dx
    cxy += (w[i] as number) * dy * dx
  }
  cyy /= tot
  cxx /= tot
  cxy /= tot
  const [lo, hi] = eigvalsh2(cyy, cxy, cxx)
  if (!(hi > 0) || lo < 0) return null
  return Math.sqrt(lo / hi)
}

/**
 * 背景高度 = 直方图**众数**，不是 mean。
 *
 * mean 被团簇本身拉走 —— 簇越大拉得越多，于是「背景在哪」这个问题的答案
 * 取决于要测的东西有多大。众数不受这个影响（只要背景仍占多数像素）。
 *
 * ⚠️ `np.histogram(fl, bins=96)` **不给 range** ⇒ numpy 取 `(min, max)`，
 * 而本仓 `histogram` 要显式 range。那条 `min === max ⇒ (min−0.5, max+0.5)`
 * 的分岔在一张常数帧上就会遇到，见 `nd.autoRange`。
 */
export function backgroundLevel(height: Mat, bins = 96): number | null {
  const fl: number[] = []
  for (let i = 0; i < height.rows * height.cols; i += 1) {
    const v = height.data[i] as number
    if (Number.isFinite(v)) fl.push(v)
  }
  if (fl.length < 16) return null
  const h = histogram(fl, bins, autoRange(fl))
  let k = 0
  for (let i = 1; i < h.counts.length; i += 1) {
    if ((h.counts[i] as number) > (h.counts[k] as number)) k = i
  }
  return ((h.edges[k] as number) + (h.edges[k + 1] as number)) / 2
}

/** `dispersion` / `floor` / `excess` 对 numpy 的相对容差（见文件抬头那张表）。 */
export function dispersionRelTol(nBoundaryPx: number): number {
  return sumRelTol(nBoundaryPx)
}
