/**
 * 一帧形貌里最主要的那道台阶边 —— 旧仓 `mast/vision/step_edge.py`（179 行，
 * 只 import numpy，零跨模块调用）。
 *
 * ## 为什么需要它
 *
 * 台阶是表面态驻波最干净的散射体，可是要沿台阶法向布一排谱，先得知道台阶在哪、朝哪。
 * `MeasureStepHeight` 走的是 Z 直方图，回的是**高度**而不是一条线；本件补的正是这条线。
 *
 * ## 做法，以及为什么**不去平面再分台面**
 *
 * 梯度模最大的那一撮像素 → 用结构张量（**倍角**平均）定出这些边共同的方向 →
 * 把候选像素投到法向上取最密的那一簇 → 对这一簇拟合直线。
 *
 * 一列规则的台阶在最小二乘意义下**就是**一个斜面：去平面会把楼梯本身减掉，
 * 剩下的锯齿再按高度分类，分出来的不是台面。台阶与斜面的区别不在高度分布，
 * 在于台阶是分段平的、跳变是突然的 —— 那是梯度里的东西。
 *
 * 倍角平均是必须的：梯度在一道边的两侧方向相反，直接平均会互相抵消；
 * 倍角把 `+g` 与 `−g` 当成同一个方向，这正是「无向的线」该有的算法。
 *
 * ## 找不到就说找不到
 *
 * 找不到相干的梯度脊回 `no_step`，那簇不直回 `undecidable` ——
 * **一条编出来的边会让整排谱落在错的地方，而每条谱都会「成功」**。
 *
 * ## 两个角度都报
 *
 * `angleDeg` 是**图像坐标**里的方向（0° = 快扫轴），`angleScanDeg` 是同一条边在
 * **扫描/样品坐标**里的方向；读图的人把行 0 放在窗口的高 y 边，数组的慢轴因此沿 −y，
 * 两者差一个负号（模 180°）。**只报一个的那一次，用错的人不会发现。**
 *
 * ## 容差
 *
 * | 件 | 容差 | 为什么 |
 * |---|---|---|
 * | `_box` 的 3×3 平滑 | **0** | 照抄 numpy 的**累积和**写法（两次 `cumsum` + 四项加减），每一步都是一次加法、顺序一样 |
 * | `nEdgePx` / `verdict` / `reasons` | **0** | 计数与词表 |
 * | `angleDeg` / `straightness` / `stepHeightM` | `sumRelTol(n)` | 结构张量是两条求和，TLS 是一个 2×2 闭式 |
 *
 * ⚠️ `np.linalg.svd` 的第一右奇异向量**符号是任意的**（LAPACK 不保证）。本仓用
 * `MᵀM` 的主特征向量替它 —— 而这在数值上是同一件事，**因为下游两处都对符号免疫**：
 * `angle` 取 `% 180`，`resid` 取平方。要是哪天有人拿它的符号当方向用，
 * 那条路在 numpy 那侧一样不成立。
 */
import { histogram, matAt, matOf, mean, type Mat } from 'dsh-spm-numerics'
import { autoRange, gradient2d, nanMean, npMedian } from './nd.js'

/** 边候选的门限：梯度中位数之上这么多个稳健 σ。 */
export const EDGE_SIGMA = 6.0
/** 边界像素到拟合直线的 RMS 距离上限，以帧短边为单位。超过 = 这不是一条直边。 */
export const MAX_STRAIGHTNESS = 0.06
/** 边界像素至少要有这么多。 */
export const MIN_EDGE_PIXELS = 24
/** 候选像素的梯度至少要有中位梯度的这么多倍，否则那只是斜面或噪声。 */
export const MIN_SEPARATION_SIGMA = 4.0

export interface StepEdgeResult {
  readonly verdict: 'step_edge' | 'no_step' | 'undecidable'
  readonly xPx: number | null
  readonly yPx: number | null
  readonly angleDeg: number | null
  readonly angleScanDeg: number | null
  readonly stepHeightM: number | null
  readonly straightness: number | null
  readonly nEdgePx: number
  readonly upperFraction: number | null
  readonly reasons: readonly string[]
  readonly warnings: readonly string[]
  readonly notes: Readonly<Record<string, number>>
}

function blank(verdict: StepEdgeResult['verdict'], over: Partial<StepEdgeResult> = {}): StepEdgeResult {
  return {
    verdict,
    xPx: null,
    yPx: null,
    angleDeg: null,
    angleScanDeg: null,
    stepHeightM: null,
    straightness: null,
    nEdgePx: 0,
    upperFraction: null,
    reasons: [],
    warnings: [],
    notes: {},
    ...over,
  }
}

/** `np.round` —— **四舍六入五成双**，不是 JS 的 `Math.round`（后者把 −0.5 舍成 −0）。 */
function npRound(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** `n × n` 均值平滑，用**累积和**做（照抄旧仓，为了逐位一致）。 */
export function boxFilter(a: Mat, n: number): Mat {
  if (n <= 1) return a
  const pad = n >> 1
  const ny = a.rows
  const nx = a.cols
  const py = ny + 2 * pad
  const px = nx + 2 * pad
  // `np.pad(a, pad, mode="edge")`
  const b = new Float64Array(py * px)
  for (let r = 0; r < py; r += 1) {
    const sr = Math.min(ny - 1, Math.max(0, r - pad))
    for (let c = 0; c < px; c += 1) {
      const sc = Math.min(nx - 1, Math.max(0, c - pad))
      b[r * px + c] = matAt(a, sr, sc)
    }
  }
  // `np.cumsum(np.cumsum(b, axis=0), axis=1)` —— **先沿列往下累，再沿行往右累**。
  //
  // ⚠️ 反过来（先行后列）数学上相同、浮点上**不同**，而这一条会翻判据：
  // 实测 `locate_step_edge` 的候选像素数因此差 2 个（226 对 228），
  // 而候选像素数是我写了「容差 0」的那一档。两次 cumsum 的顺序是**判据的一部分**。
  const col = new Float64Array(py * px)
  for (let c = 0; c < px; c += 1) {
    let acc = 0
    for (let r = 0; r < py; r += 1) {
      acc += b[r * px + c] as number
      col[r * px + c] = acc
    }
  }
  const cum = new Float64Array((py + 1) * (px + 1))
  for (let r = 0; r < py; r += 1) {
    let acc = 0
    for (let c = 0; c < px; c += 1) {
      acc += col[r * px + c] as number
      cum[(r + 1) * (px + 1) + (c + 1)] = acc
    }
  }
  const out = new Float64Array(ny * nx)
  const at = (r: number, c: number): number => cum[r * (px + 1) + c] as number
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      out[r * nx + c] = (at(n + r, n + c) - at(r, n + c) - at(n + r, c) + at(r, c)) / (n * n)
    }
  }
  return matOf(ny, nx, out)
}

/** 边的方向（单位向量），由梯度的**倍角**平均得到。 */
function dominantDirection(gx: readonly number[], gy: readonly number[], w: readonly number[]): [number, number] {
  let a2 = 0
  let b2 = 0
  for (let i = 0; i < gx.length; i += 1) {
    const x = gx[i] as number
    const y = gy[i] as number
    a2 += (w[i] as number) * (x * x - y * y)
    b2 += (w[i] as number) * 2 * x * y
  }
  const th = 0.5 * Math.atan2(b2, a2)
  // 边与平均梯度方向**垂直**
  return [-Math.sin(th), Math.cos(th)]
}

/** 一帧形貌里最主要的那道台阶边（像素坐标）。**不抛异常。** */
export function locateStepEdge(
  image: Mat,
  opts: {
    edgeSigma?: number
    maxStraightness?: number
    minEdgePixels?: number
    minSeparationSigma?: number
  } = {},
): StepEdgeResult {
  const edgeSigma = opts.edgeSigma ?? EDGE_SIGMA
  const maxStraightness = opts.maxStraightness ?? MAX_STRAIGHTNESS
  const minEdgePixels = opts.minEdgePixels ?? MIN_EDGE_PIXELS
  const minSeparationSigma = opts.minSeparationSigma ?? MIN_SEPARATION_SIGMA

  const ny = image.rows
  const nx = image.cols
  if (Math.min(ny, nx) < 32) return blank('undecidable', { reasons: ['frame_too_small'] })
  let anyFinite = false
  for (let i = 0; i < image.data.length; i += 1) {
    if (Number.isFinite(image.data[i] as number)) {
      anyFinite = true
      break
    }
  }
  if (!anyFinite) return blank('undecidable', { reasons: ['frame_all_nan'] })

  const fill = nanMean(image.data)
  const filled = new Float64Array(ny * nx)
  for (let i = 0; i < filled.length; i += 1) {
    const v = image.data[i] as number
    filled[i] = Number.isFinite(v) ? v : fill
  }
  const z = boxFilter(matOf(ny, nx, filled), 3)
  const { gy, gx } = gradient2d(z)
  const g = new Float64Array(ny * nx)
  for (let i = 0; i < g.length; i += 1) g[i] = Math.hypot(gx.data[i] as number, gy.data[i] as number)

  const med = npMedian(g)
  const mad = 1.4826 * npMedian(Array.from(g, (v) => Math.abs(v - med)))
  const thr = med + edgeSigma * Math.max(mad, 1e-30)
  const candIdx: number[] = []
  for (let i = 0; i < g.length; i += 1) if ((g[i] as number) >= thr) candIdx.push(i)
  if (candIdx.length < minEdgePixels) {
    return blank('no_step', { nEdgePx: candIdx.length, reasons: ['no_gradient_ridge'] })
  }
  const sigma = med
  const gCand = candIdx.map((i) => g[i] as number)
  if (npMedian(gCand) < minSeparationSigma * Math.max(sigma, 1e-30)) {
    // 最强的那道「边」只比典型斜率高一点点：这是倾斜，不是台阶。
    return blank('no_step', {
      nEdgePx: candIdx.length,
      reasons: ['terraces_not_separated'],
      notes: { ridge_over_median_gradient: thr / Math.max(sigma, 1e-30) },
    })
  }

  const [ex, ey] = dominantDirection(
    candIdx.map((i) => gx.data[i] as number),
    candIdx.map((i) => gy.data[i] as number),
    gCand,
  )
  // `np.nonzero` —— 行优先
  let ii = candIdx.map((i) => Math.floor(i / nx))
  let jj = candIdx.map((i) => i % nx)
  const mi = mean(ii)
  const mj = mean(jj)
  const proj = ii.map((i, k) => ((jj[k] as number) - mj) * -ey + (i - mi) * ex)
  let lo0 = Infinity
  let hi0 = -Infinity
  for (const p of proj) {
    if (p < lo0) lo0 = p
    if (p > hi0) hi0 = p
  }
  const span = hi0 - lo0 || 1.0
  const nb = Math.max(8, Math.trunc(span / 3.0))
  const h = histogram(proj, nb, autoRange(proj))
  let k = 0
  for (let i = 1; i < nb; i += 1) if ((h.counts[i] as number) > (h.counts[k] as number)) k = i
  const lo = h.edges[k] as number
  const hi = h.edges[k + 1] as number
  const padW = 0.5 * (hi - lo)
  const keep: number[] = []
  for (let i = 0; i < proj.length; i += 1) {
    const p = proj[i] as number
    if (p >= lo - padW && p <= hi + padW) keep.push(i)
  }
  ii = keep.map((i) => ii[i] as number)
  jj = keep.map((i) => jj[i] as number)
  if (ii.length < minEdgePixels) {
    return blank('undecidable', { nEdgePx: ii.length, reasons: ['too_few_edge_pixels'] })
  }

  const y0 = mean(ii)
  const x0 = mean(jj)
  const off = Math.max(4, Math.trunc(0.05 * Math.min(ny, nx)))
  const clip = (v: number, n: number): number => Math.min(n - 1, Math.max(0, v))
  const hiVals: number[] = []
  const loVals: number[] = []
  for (let i = 0; i < ii.length; i += 1) {
    const a = ii[i] as number
    const b = jj[i] as number
    hiVals.push(matAt(image, clip(npRound(a + ex * off), ny), clip(npRound(b - ey * off), nx)))
    loVals.push(matAt(image, clip(npRound(a - ex * off), ny), clip(npRound(b + ey * off), nx)))
  }
  const sep = Math.abs(nanMean(hiVals) - nanMean(loVals))
  const frac = candIdx.length / (ny * nx)

  // 总体最小二乘：方向 = 边界像素的主轴
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < ii.length; i += 1) {
    const dx = (jj[i] as number) - x0
    const dy = (ii[i] as number) - y0
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  const [dxv, dyv] = principalAxis(sxx, sxy, syy)
  let sq = 0
  for (let i = 0; i < ii.length; i += 1) {
    const dx = (jj[i] as number) - x0
    const dy = (ii[i] as number) - y0
    const r = dx * -dyv + dy * dxv
    sq += r * r
  }
  const straight = Math.sqrt(sq / ii.length) / Math.min(ny, nx)
  const angle = mod180((Math.atan2(dyv, dxv) * 180) / Math.PI)
  const notes = { ridge_gradient_threshold: thr, median_gradient: sigma, edge_fraction: frac }
  const common = {
    xPx: x0,
    yPx: y0,
    angleDeg: angle,
    angleScanDeg: mod180(-angle),
    stepHeightM: sep,
    straightness: straight,
    nEdgePx: ii.length,
    upperFraction: frac,
    notes,
  }
  if (straight > maxStraightness) {
    return blank('undecidable', { ...common, reasons: ['edge_not_straight'] })
  }
  return blank('step_edge', common)
}

/** Python 的 `x % 180`（结果与除数同号），不是 JS 的余数。 */
function mod180(x: number): number {
  const r = x % 180
  return r !== 0 && r < 0 ? r + 180 : r
}

/** 对称 2×2 的**主**特征向量（最大特征值那个），已归一化。符号任意 —— 见文件抬头。 */
function principalAxis(sxx: number, sxy: number, syy: number): [number, number] {
  if (sxy === 0) return sxx >= syy ? [1, 0] : [0, 1]
  const t = sxx + syy
  const d = Math.sqrt(Math.max(0, t * t - 4 * (sxx * syy - sxy * sxy)))
  const lmax = (t + d) / 2
  const vx = sxy
  const vy = lmax - sxx
  const n = Math.hypot(vx, vy)
  return n > 0 ? [vx / n, vy / n] : [1, 0]
}
