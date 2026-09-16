/**
 * **未知**表面的实空间原胞：a₁、a₂、以及**真正测出来的** γ
 * （旧仓 `mast/vision/lattice_cell.py`）。
 *
 * ## 它与 K1（`lattice-peaks.ts`）的分界
 *
 * K1 回答「扫描器把一个**已知**的晶格扭曲了多少」——它的入口参数里有 `surface`，
 * 查的是 `SURFACE_LATTICE_NM`。这里问的是相反的一件事：「这个表面的原胞**是多少**」。
 * 新体系上线时手里只有图，表里根本没有它的条目，而「先测后定」正是它进表的前提。
 *
 * 两处必须说清的差别（旧仓模块注释的原话）：
 *
 * * **γ 是测量值，不是约定。** `lattice_multiframe._independent_pair` 会把选出的
 *   一对基矢**强制**成 120°（`solve_affine` 的第三个方程写死了 cos120°）。
 *   六角面上强制 120° 是对的；**矩形面上它是错的**，而你事先并不知道是哪一种。
 * * **峰位做亚像素精修。** K1 取的是整数 bin，径向量化误差约 `1/r` ——
 *   20 nm 帧上 `|k|≈50 px` 时是 2%，正好和真实的晶格各向异性同量级。
 *
 * **候选峰仍然向 K1 要**：它带着两批独立标定过的脊点剔除。再写一份找峰只会让
 * 两处慢慢漂开（旧仓 `decode_reply` 那句「提到这里是为了让它只有一份」）。
 *
 * ## 容差
 *
 * | 件 | 容差 | 推导 |
 * |---|---|---|
 * | `reason` / `scanDir` / `indexed` / `indexedTotal` / `nPeaks` / `nRidge` / 告警原文 | **0** | 标签与计数 |
 * | `a1Nm` / `a2Nm` / `gammaDeg` / `areaNm2` / `a1AngleDeg` / `snr` | {@link CELL_REL_TOL} | 见下 |
 * | `combineUpDown` 的每一项 | 同上 | 它只做中位数与两个数的平均 —— 不引入新的量级 |
 * | `superstructureTest` 的 `amplitude` / `control*` | {@link coherentAbsTol} | **相消**，见下 |
 *
 * ### `CELL_REL_TOL = 1e−9`
 *
 * 这一条**不是**「浮点误差有多大」，是「**离散判据翻不翻**」：
 *
 * 1. 峰位（`argmax`）是离散的，金样里每一格的冠军都领先一个量级（见 K1 抬头）；
 * 2. 精修用 3×3 功率质心 —— 九个**同号**的数，没有相消，相对误差 ~`9·eps`；
 * 3. 之后是一次 2×2 求逆（κ = a₁/a₂ ≈ 1.1）、一次 Gauss 约化（**整数**系数）、
 *    一次 `acos`。全部是 O(1) 次运算，误差不累积；
 * 4. 剩下唯一的量级来源是**谱本身**：`fftRelTol(192²) ≈ 3e−14`。
 *
 * ⇒ 界在 `1e−13` 量级，取 `1e−9` 留四个量级的余量。**为什么敢留这么松**：
 * 这一族真正会犯的错不是精度，是**挑错了那一对基矢**（a₂ 报成一半、a₁ 报成两倍）——
 * 那种错在数字上差 2 倍，不是差 1e−13。一条 1e−9 的断言照样当场抓住它，
 * 而把它收到 1e−14 只会让金样在下一次合法的 FFT 实现变化上变红。
 *
 * > 这是 `numerics-3.md` 第六节第二条的另一面：**一条容差要么推得出来，要么别写**。
 * > 这里推得出来的是「离散判据的裕度」，不是「最后一位」。
 *
 * ### 相消：`superstructureTest` 只能给**绝对**容差
 *
 * `_max_over_neighbourhood` 算的是 `Σ hw·e^{-2πik·r}` —— 对一个**对照**波矢，
 * 这个和是 3.6 万个 ~1e−11 的数相加得到 ~1e−14，**相消了三个量级**。
 * 相消毁掉相对精度、不毁绝对精度（`numerics.md` 第四节第一条），所以容差按
 * `Σ|hw|` 定：见 {@link coherentAbsTol}。
 *
 * ⚠️ 还有第二个理由：numpy 那两次是 **`@` 矩阵乘**，走的是 BLAS 的分块累加，
 * **不是** `np.add.reduce` 的成对求和 —— 也就是说这一处**没有可照抄的累加顺序**
 * （`pairwise.ts` 能逐位复刻的是后者）。判决离阈值最近的一格是 `1.294`
 * （闸在 1.2 / 1.5，余量 8%），而这条界给出的相对误差在 `1e−7` 量级。
 */
import { formatG, pyFixed, pyMod } from 'dsh-spm-kernel'
import {
  EPS,
  fft2,
  hanning,
  matAt,
  matOf,
  npMean,
  npStd,
  npSum,
  Pcg64,
  type Mat,
} from 'dsh-spm-numerics'
import { npMedian } from './nd.js'
import { scaleGate as scaleGateOf } from './atomic-phase.js'
import { findLatticePeaks, PEAK_BAND_NM, type LatticePeak } from './lattice-peaks.js'

/** 两个基矢的夹角落在这个区间之外就不算「独立」（求逆病态，第二个基矢是噪声）。 */
export const MIN_INDEPENDENT_DEG = 20.0

/** 对照波矢的个数。取够多才看得出候选是不是落在对照的分布里。 */
export const N_CONTROLS = 8

/** 向 K1 要多少个峰。**12 不是随手写的** —— 被剔掉的脊点也消耗迭代次数，
 * 18 次预算会在够到任何真峰之前用光（真机 10 帧实测 6 → 7/10、12 → 10/10）。 */
export const PEAK_BUDGET = 12

/** 一个观测峰的分数指标离整数多远还算「被指标上」。 */
export const INDEX_TOL = 0.15

/** 一个周期至少要占这么多像素。**按「每周期像素数」定，不按 nm/px** ——
 * `scale_gate` 的 0.02/0.05 是在 0.25 nm 的晶格上标的，换体系会算错
 * 参考系统曾有一批帧因此被判成「没有原子」；该观测尚未在本仓独立验证。 */
export const MIN_PX_PER_PERIOD = 4.0

/** 一个晶格峰要可信，它的周期在这一帧里至少要重复这么多次。**几何约束，不是经验值**：
 * 谱心附近有直流裙边，周期越长的候选越靠近谱心、越容易赢在背景上。 */
export const CELL_MIN_PERIODS_IN_FRAME = 12.0

/** 参与配对枚举的最强峰个数。 */
export const MAX_PAIR_CANDIDATES = 8

/** 一对基矢要算「解释得了这张谱」，被它指标上的峰必须占到候选总功率的这么多。 */
export const INDEX_POWER_MIN = 0.9

/** 见文件抬头「`CELL_REL_TOL = 1e−9`」那一节。 */
export const CELL_REL_TOL = 1e-9

/**
 * 相干求和的**绝对**容差：`2·n·eps·Σ|hw| / wsum`。
 *
 * `amp = 2·|Σ hw·e^{-ik·r}| / wsum`，而 n 次乘加的累积误差上界是 `n·eps·Σ|hw|`
 * （最坏情形；实际是随机游走的 `√n`）。两侧的累加顺序不同（numpy 走 BLAS 分块），
 * 所以差至多两倍这个界 —— 系数里的 2 就是它。
 */
export function coherentAbsTol(n: number, sumAbs: number, wsum: number): number {
  return wsum > 0 ? (2 * n * EPS * sumAbs) / wsum : 0
}

/** 一帧上量出的实空间原胞。`ok=false` 时 `reason` 说明为什么量不了。 */
export interface CellResult {
  readonly ok: boolean
  readonly reason: string
  /** 较长的那个基矢，纳米。 */
  readonly a1Nm: number | null
  /** 较短的那个基矢，纳米。 */
  readonly a2Nm: number | null
  /** 两个基矢的夹角，度。**测量值**，没有被强制成 60/90/120°。 */
  readonly gammaDeg: number | null
  readonly a1AngleDeg: number | null
  readonly areaNm2: number | null
  readonly snr: readonly [number, number]
  /** 选中的这一对基矢把几个 / 共几个候选峰指标成了整数。
   * `indexed === 2` 意味着「只解释了它们自己」—— 弱证据。 */
  readonly indexed: number
  readonly indexedTotal: number
  readonly nPeaks: number
  readonly nRidge: number
  readonly scanDir: string
  readonly warnings: readonly string[]
}

function emptyCell(reason: string, over: Partial<CellResult> = {}): CellResult {
  return {
    ok: false,
    reason,
    a1Nm: null,
    a2Nm: null,
    gammaDeg: null,
    a1AngleDeg: null,
    areaNm2: null,
    snr: [0, 0],
    indexed: 0,
    indexedTotal: 0,
    nPeaks: 0,
    nRidge: 0,
    scanDir: '',
    warnings: [],
    ...over,
  }
}

/** 去均值 + Hanning + `fftshift(fft2)` 的**功率**谱（`|F|²`）。 */
function powerSpectrum(image: Mat): Mat {
  const ny = image.rows
  const nx = image.cols
  const n = ny * nx
  const fin: number[] = []
  for (let i = 0; i < n; i += 1) {
    const v = image.data[i] as number
    if (Number.isFinite(v)) fin.push(v)
  }
  const fill = fin.length > 0 ? npMean(fin) : 0
  const filled = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = image.data[i] as number
    filled[i] = Number.isFinite(v) ? v : fill
  }
  const mean = npMean(filled)
  const wy = hanning(ny)
  const wx = hanning(nx)
  const win = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) win[r * nx + c] = (filled[r * nx + c] as number) - mean
  }
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) win[r * nx + c] = (win[r * nx + c] as number) * (wy[r] as number) * (wx[c] as number)
  }
  const spec = fft2(matOf(ny, nx, win))
  const out = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    const sr = (r + Math.ceil(ny / 2)) % ny
    for (let c = 0; c < nx; c += 1) {
      const sc = (c + Math.ceil(nx / 2)) % nx
      const re = matAt(spec.re, sr, sc)
      const im = matAt(spec.im, sr, sc)
      // `np.abs(F) ** 2` —— **先取模再平方**，不是 `re²+im²`。
      // 两者数学上相同、浮点上差一个平方根的舍入，而这个数是 `snr` 的分子。
      const m = Math.hypot(re, im)
      out[r * nx + c] = m * m
    }
  }
  return matOf(ny, nx, out)
}

/**
 * 3×3 功率加权质心 → `(fy, fx)`，单位「每像素的周数」。
 *
 * 与 `herringbone.stripe_peak` 的精修逐行同构：**非方帧上两轴各自按轴长归一**。
 */
function refinePeak(P: Mat, iy: number, ix: number): [number, number] {
  const ny = P.rows
  const nx = P.cols
  const cy = ny >> 1
  const cx = nx >> 1
  const y0 = Math.max(0, iy - 1)
  const y1 = Math.min(ny, iy + 2)
  const x0 = Math.max(0, ix - 1)
  const x1 = Math.min(nx, ix + 2)
  let tot = 0
  let sy = 0
  let sx = 0
  for (let r = y0; r < y1; r += 1) {
    for (let c = x0; c < x1; c += 1) {
      const w = matAt(P, r, c)
      tot += w
      sy += w * r
      sx += w * c
    }
  }
  if (tot <= 0) return [(iy - cy) / ny, (ix - cx) / nx]
  return [(sy / tot - cy) / ny, (sx / tot - cx) / nx]
}

/**
 * 把一对基矢约化成最短的一对（Gauss / Lagrange 约化）。
 *
 * 没有这一步，「选了哪两个峰」会改变报出来的 a₁/a₂ —— 同一个晶格可以由无穷多组
 * 基矢张成。约化之后结果是**规范的**，两帧才可比。
 *
 * ⚠️ **方向不能反**：每一轮必须让 `a1` 是**较短**的那个，再拿它去约 `a2`。
 * 反过来 `mu` 恒为 0，循环第一步就 break —— 函数看起来跑完了却什么都没约化，
 * 而这个缺陷被「取最强两个峰通常本来就是原胞对」掩盖着（旧仓 24 帧里 21 帧
 * 被报成两倍多的超胞）。
 */
function gaussReduce(a1In: readonly [number, number], a2In: readonly [number, number]): [[number, number], [number, number]] {
  let a1: [number, number] = [a1In[0], a1In[1]]
  let a2: [number, number] = [a2In[0], a2In[1]]
  for (let i = 0; i < 32; i += 1) {
    if (a1[0] * a1[0] + a1[1] * a1[1] > a2[0] * a2[0] + a2[1] * a2[1]) {
      const t = a1
      a1 = a2
      a2 = t
    }
    const denom = a1[0] * a1[0] + a1[1] * a1[1]
    if (denom <= 0) break
    const mu = Math.round((a1[0] * a2[0] + a1[1] * a2[1]) / denom)
    if (mu === 0) break
    a2 = [a2[0] - mu * a1[0], a2[1] - mu * a1[1]]
  }
  return [a1, a2]
}

/** 一个精修过的候选峰：`|k|`、`k`（nm⁻¹）、信噪。 */
type Cand = readonly [number, readonly [number, number], number]

/**
 * 从候选峰里挑出**真正的原胞基矢**：能把其余观测峰指标成整数的那一对。
 *
 * ## 为什么不能只按功率取最强的两个
 *
 * 真机上这么做会错三种，而且每一种都给出一个**看起来完全合理**的晶格常数：
 * 挑中二阶峰 `2b₂` ⇒ a₂ 变成真值的**一半**；挑中条纹在带边留下的弱峰 ⇒ a₁ 变成
 * 两倍；挑中一个噪声方向 ⇒ γ 从 89° 变成 46.8°。这三帧的第二个峰信噪是
 * 4202/4066/1219，而**正确**的帧里最低的是 3641 —— 区间重叠，
 * 「信噪阈值」分不开它们。**试过，不行，别再试。**
 *
 * ## 得分必须按**功率**记，不能数个数
 *
 * 数个数时一个功率微弱的杂峰会左右结果：基底取 `(b₁, b₂/2)` 能把杂峰连同真峰
 * 一起指标上，比正确的那一对**多解释一个峰**，于是永远赢。实测后果是 a₁ 被报成
 * 真值的两倍而 γ 完全正确 —— 一个只错在一个维度上、看起来极其可信的结果。
 *
 * ## 第二道：基矢**自己**必须是强峰
 *
 * 只有指标化这一道时，行列式往哪个方向取都救不了：选中 `b₂/2` 要行列式取大才排得掉，
 * 选中 `2b₂` 要取小 —— 同一个旋钮不可能同时满足。真正区分它们的是**强度**
 * （基频永远比自己的谐波强）。这不是启发式，是衍射的常识。
 */
function bestIndexingPair(cands: readonly Cand[]): { k1: Cand | null; k2: Cand | null; n: number; total: number } {
  const pool = cands.slice(0, MAX_PAIR_CANDIDATES)
  let totalP = 0
  for (const c of pool) totalP += Math.max(c[2], 0)
  if (totalP === 0) totalP = 1.0
  // (基矢功率和, det, k1, k2, n_indexed)
  const qualified: { base: number; det: number; k1: Cand; k2: Cand; n: number }[] = []
  let fbFrac = -1.0
  let fbK1: Cand | null = null
  let fbK2: Cand | null = null
  let fbN = 0
  let fbBase = -1.0
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const k1 = pool[i] as Cand
      const k2 = pool[j] as Cand
      const dot = k1[1][0] * k2[1][0] + k1[1][1] * k2[1][1]
      const cosang = Math.min(1.0, Math.abs(dot / (k1[0] * k2[0])))
      if ((Math.acos(cosang) * 180) / Math.PI < MIN_INDEPENDENT_DEG) continue
      const a = k1[1][0]
      const b = k1[1][1]
      const c = k2[1][0]
      const d = k2[1][1]
      const det = Math.abs(a * d - b * c)
      if (det < 1e-12) continue
      const idet = a * d - b * c
      // `np.linalg.inv` 的 2×2 闭式。`hl = c[1] @ Binv` ⇒ 行向量乘矩阵。
      const inv00 = d / idet
      const inv01 = -b / idet
      const inv10 = -c / idet
      const inv11 = a / idet
      let nIdx = 0
      let pIdx = 0
      for (const cc of pool) {
        const h = cc[1][0] * inv00 + cc[1][1] * inv10
        const l = cc[1][0] * inv01 + cc[1][1] * inv11
        const dev = Math.max(Math.abs(h - Math.round(h)), Math.abs(l - Math.round(l)))
        if (dev <= INDEX_TOL) {
          nIdx += 1
          pIdx += Math.max(cc[2], 0)
        }
      }
      const frac = pIdx / totalP
      const baseP = Math.max(k1[2], 0) + Math.max(k2[2], 0)
      if (frac >= INDEX_POWER_MIN) qualified.push({ base: baseP, det, k1, k2, n: nIdx })
      if (frac > fbFrac || (frac === fbFrac && baseP > fbBase)) {
        fbFrac = frac
        fbK1 = k1
        fbK2 = k2
        fbN = nIdx
        fbBase = baseP
      }
    }
  }
  if (qualified.length > 0) {
    // 先按两个基矢的功率和（基频最强），**精确并列**时再看行列式。
    // Python 与 JS 的排序都稳定 —— 两者全等时保持枚举顺序。
    const sorted = [...qualified].sort((x, y) => y.base - x.base || y.det - x.det)
    const top = sorted[0] as { base: number; det: number; k1: Cand; k2: Cand; n: number }
    return { k1: top.k1, k2: top.k2, n: top.n, total: pool.length }
  }
  return { k1: fbK1, k2: fbK2, n: fbN, total: pool.length }
}

/** `measureCell` 的可选项。 */
export interface MeasureCellOptions {
  readonly bandNm?: readonly [number, number] | null
  readonly maxPeaks?: number
  readonly scanDir?: string
}

/**
 * 从一帧原子分辨图量出实空间原胞。
 *
 * 图必须已经过几何归位（`sxmOrientedFrames`）。**纯函数**：不读文件、不碰硬件、不抛。
 */
export function measureCell(image: Mat, nmPerPx: number, opts: MeasureCellOptions = {}): CellResult {
  const maxPeaks = opts.maxPeaks ?? PEAK_BUDGET
  const scanDir = opts.scanDir ?? ''
  const ny = image.rows
  const nx = image.cols
  if (Math.min(ny, nx) < 32) return emptyCell('image_too_small')
  if (!(nmPerPx && nmPerPx > 0)) return emptyCell('unknown_pixel_size')

  let band: [number, number] = opts.bandNm ? [opts.bandNm[0], opts.bandNm[1]] : [PEAK_BAND_NM[0], PEAK_BAND_NM[1]]
  if (!opts.bandNm) {
    // 长周期端跟着帧宽收 —— 见 `CELL_MIN_PERIODS_IN_FRAME` 的说明。
    const widthNm = nmPerPx * Math.min(ny, nx)
    const cap = widthNm / CELL_MIN_PERIODS_IN_FRAME
    if (cap <= band[0]) {
      return emptyCell('frame_too_small_for_band', {
        warnings: [
          `视野只有 ${pyFixed(widthNm, 2)} nm，除以最少周期数 ${pyFixed(CELL_MIN_PERIODS_IN_FRAME, 0)} 之后连搜索带的下界` +
            `（${pyFixed(band[0], 2)} nm）都够不到 —— 这一帧装不下足够多的周期，` +
            `量出来的「晶格」会是直流裙边。`,
        ],
      })
    }
    band = [band[0], Math.min(band[1], cap)]
  }
  const found = findLatticePeaks(image, nmPerPx, { bandNm: band, maxPeaks })
  if (!found.ok || found.peaks.length < 2) {
    const extra: string[] = []
    if (found.nRidge >= 2 * Math.max(1, found.peaks.length)) {
      extra.push(
        `带内的极大有 ${found.nRidge} 个被判成脊点、只剩 ${found.peaks.length} 个候选 —— 这一帧的谱被` +
          `条纹主导。「看到的全是脊」与「没法看」是两件事：前者说明` +
          `针尖在闪，后者说明帧本身不可用。`,
      )
    }
    return emptyCell(found.reason || 'too_few_peaks', {
      nPeaks: found.peaks.length,
      nRidge: found.nRidge,
      warnings: [...found.warnings, ...extra],
    })
  }

  const P = powerSpectrum(image)
  const cy = ny >> 1
  const cx = nx >> 1
  // 带内中位功率 —— 每个峰的信噪分母。
  const inBand: number[] = []
  for (let r = 0; r < ny; r += 1) {
    const fy = (r - cy) / ny
    for (let c = 0; c < nx; c += 1) {
      const fx = (c - cx) / nx
      const fr = Math.hypot(fy, fx)
      const per = fr > 0 ? nmPerPx / Math.max(fr, 1e-12) : Infinity
      if (per >= band[0] && per <= band[1]) inBand.push(matAt(P, r, c))
    }
  }
  const bg = inBand.length > 0 ? npMedian(inBand) : 0

  // 精修每一个候选峰，换成 nm⁻¹ 的波矢。上半平面代表元去掉 ±k 重复。
  const cands: Cand[] = []
  for (const pk of found.peaks) {
    const iy = Math.round(cy + pk.ky)
    const ix = Math.round(cx + pk.kx)
    if (!(iy >= 1 && iy < ny - 1 && ix >= 1 && ix < nx - 1)) continue
    let [fy, fx] = refinePeak(P, iy, ix)
    if (fy < 0 || (fy === 0 && fx < 0)) {
      fy = -fy
      fx = -fx
    }
    const k: [number, number] = [fx / nmPerPx, fy / nmPerPx]
    const norm = Math.hypot(k[0], k[1])
    if (!(norm > 0)) continue
    const snr = bg > 0 ? matAt(P, iy, ix) / bg : 0
    const dup = cands.some((c) => Math.abs(norm - c[0]) < 1e-9 && Math.abs(k[0] * c[1][0] + k[1] * c[1][1] - norm * c[0]) < 1e-9)
    if (dup) continue
    cands.push([norm, k, snr] as Cand)
  }
  if (cands.length < 2) {
    return emptyCell('too_few_refined_peaks', { nPeaks: found.peaks.length, nRidge: found.nRidge })
  }
  const sortedCands = [...cands].sort((a, b) => b[2] - a[2])
  const { k1, k2, n: idxScore, total: idxTotal } = bestIndexingPair(sortedCands)
  if (k1 === null || k2 === null) {
    return emptyCell('no_independent_pair', {
      nPeaks: found.peaks.length,
      nRidge: found.nRidge,
      warnings: ['找到的峰全都近乎共线 —— 这是**一维条纹**的样子，不是二维晶格。' + '一维结构没有原胞可言。'],
    })
  }

  const B = [k1[1][0], k1[1][1], k2[1][0], k2[1][1]] as const
  const det = B[0] * B[3] - B[1] * B[2]
  if (Math.abs(det) < 1e-12) return emptyCell('singular_basis')
  // 每周期像素数 —— 用**选中的**基矢来判，而不是用一个绝对的 nm/px 阈值。
  const pxPerPeriod = Math.min(1.0 / (k1[0] * nmPerPx), 1.0 / (k2[0] * nmPerPx))
  if (pxPerPeriod < MIN_PX_PER_PERIOD) {
    return emptyCell('too_few_pixels_per_period', {
      nPeaks: found.peaks.length,
      nRidge: found.nRidge,
      warnings: [
        `最短的那个周期只占 ${pyFixed(pxPerPeriod, 1)} 个像素（下限 ${pyFixed(MIN_PX_PER_PERIOD, 0)}）—— 这么少的采样点` +
          `凑得出峰但量不准周期，亚像素精修也无从做起。` +
          `把视野缩小或把像素加密。`,
      ],
    })
  }
  // `A = inv(B).T` —— **行 = 实空间基矢，纳米**。
  const A0: [number, number] = [B[3] / det, -B[2] / det]
  const A1: [number, number] = [-B[1] / det, B[0] / det]
  let [a1, a2] = gaussReduce(A0, A1)
  let l1 = Math.hypot(a1[0], a1[1])
  let l2 = Math.hypot(a2[0], a2[1])
  if (l1 < l2) {
    const t = a1
    a1 = a2
    a2 = t
    const tl = l1
    l1 = l2
    l2 = tl
  }
  const cosg = (a1[0] * a2[0] + a1[1] * a2[1]) / (l1 * l2)
  let gamma = (Math.acos(Math.max(-1.0, Math.min(1.0, cosg))) * 180) / Math.PI
  if (gamma > 90.0) {
    // 取锐角代表元（等价原胞）。
    a2 = [-a2[0], -a2[1]]
    gamma = 180.0 - gamma
  }
  const warns = [...found.warnings]
  if (scaleGateOf(nmPerPx) === 'off') {
    warns.push(
      `像素尺度 ${pyFixed(nmPerPx, 3)} nm/px 在 \`\`atomic_phase.scale_gate\`\` 那里是 \`\`off\`\`，` +
        `所以 \`\`AssessAtomicResolution\`\` / \`\`AssessAtomicPhase\`\` 会拒判这一帧。` +
        `本模块按**每周期像素数**判（这里 ${pyFixed(pxPerPeriod, 1)} px/周期，够），两者不冲突：` +
        `那道门的 0.05 nm/px 是在 0.25 nm 的晶格上标的，换到 ${pyFixed(1.0 / k2[0], 2)} nm 的周期上` +
        `对应的应当是 ${pyFixed((0.05 * (1.0 / k2[0])) / 0.25, 3)} nm/px。`,
    )
  }
  if (idxScore <= 2 && idxTotal > 2) {
    warns.push(
      `这一对基矢只指标上了它自己（${idxScore}/${idxTotal} 个候选峰）—— 没有独立的峰来印证它` +
        `就是原胞基矢。这时 a₂ 被报成真值一半（选中了二阶峰）这类错误` +
        `查不出来，结果只能当弱证据。`,
    )
  }
  warns.push(
    `γ = ${pyFixed(gamma, 2)}° 是**测量值**，但它含着未校正的扫描器剪切 —— 单帧分不开` +
      `「表面本来就不是直角」与「扫描器把直角扭了」。要分开就换慢轴方向或` +
      `换扫描角重测（calibrate_up_down / calibrate_multi_angle）。`,
  )
  return {
    ok: true,
    reason: '',
    a1Nm: l1,
    a2Nm: l2,
    gammaDeg: gamma,
    a1AngleDeg: pyMod((Math.atan2(a1[1], a1[0]) * 180) / Math.PI, 180),
    areaNm2: Math.abs(l1 * l2 * Math.sin((gamma * Math.PI) / 180)),
    snr: [k1[2], k2[2]],
    indexed: idxScore,
    indexedTotal: idxTotal,
    nPeaks: found.peaks.length,
    nRidge: found.nRidge,
    scanDir: String(scanDir || ''),
    warnings: warns,
  }
}

/**
 * 上下扫成对平均，消掉慢轴漂移在 a₂ 上的应变。
 *
 * 上扫与下扫的慢轴推进方向相反，漂移对沿慢轴长度的拉伸/压缩因此**反号**，
 * 取平均即抵消；差值本身就是漂移应变。
 *
 * `minIndexed` 只收「有独立峰印证」的帧：`indexed === 2` 的那一对基矢只解释了
 * 它自己，这种帧上「a₂ 被报成一半」查不出来。
 *
 * 统计量用**中位数**而不是均值：一帧的错解会把均值拖走，而这种错解不是罕见事故，
 * 是「峰没找全」的常态后果。
 */
export function combineUpDown(
  up: readonly CellResult[],
  down: readonly CellResult[],
  opts: { frameHeightNm?: number | null; frameTimeS?: number | null; minIndexed?: number } = {},
): Record<string, unknown> {
  const minIndexed = opts.minIndexed ?? 3
  const usable = (rows: readonly CellResult[]): CellResult[] => rows.filter((c) => c.ok && c.a2Nm && (c.indexed || 0) >= minIndexed)
  const u = usable(up)
  const d = usable(down)
  const nDrop = up.filter((c) => c.ok).length + down.filter((c) => c.ok).length - u.length - d.length
  const out: Record<string, unknown> = {
    ok: false,
    n_up: u.length,
    n_down: d.length,
    n_dropped_low_indexed: nDrop,
    min_indexed: minIndexed,
  }
  if (u.length === 0 || d.length === 0) {
    out['reason'] =
      `可用的上扫 ${u.length} 帧 / 下扫 ${d.length} 帧（另有 ${nDrop} 帧因指标化证据不足被` +
      `剔除）—— 两个方向都要有才谈得上抵消。只有一个方向时，` +
      `a₂ 里的漂移应变留在结果里且看不出来。`
    return out
  }
  const med = (rows: readonly CellResult[], pick: (c: CellResult) => number | null): number | null => {
    const vals = rows.map(pick).filter((v): v is number => v !== null)
    return vals.length > 0 ? npMedian(vals) : null
  }
  const a2u = med(u, (c) => c.a2Nm)
  const a2d = med(d, (c) => c.a2Nm)
  const a1u = med(u, (c) => c.a1Nm)
  const a1d = med(d, (c) => c.a1Nm)
  const gu = med(u, (c) => c.gammaDeg)
  const gd = med(d, (c) => c.gammaDeg)
  const a2 = 0.5 * ((a2u as number) + (a2d as number))
  const a1 = 0.5 * ((a1u as number) + (a1d as number))
  const strain = a2 ? ((a2u as number) - (a2d as number)) / (2.0 * a2) : null
  out['ok'] = true
  out['a1_nm'] = a1
  out['a2_nm'] = a2
  out['gamma_deg'] = gu !== null && gd !== null ? 0.5 * (gu + gd) : null
  out['a1_up_nm'] = a1u
  out['a1_down_nm'] = a1d
  out['a2_up_nm'] = a2u
  out['a2_down_nm'] = a2d
  // 定义是**操作性**的。它的**正负**对应哪个物理漂移方向，取决于一条本仓
  // 没有用一次已知方向的漂移钉过的符号链 —— **别拿这个符号去推方向**。
  out['slow_axis_drift_strain'] = strain
  // 帧间散布，作为不确定度的下限（**不是**测量精度：帧间还有真实的针尖差异）。
  for (const [tag, rows] of [
    ['up', u],
    ['down', d],
  ] as const) {
    for (const [attr, pick] of [
      ['a1_nm', (c: CellResult) => c.a1Nm],
      ['a2_nm', (c: CellResult) => c.a2Nm],
      ['gamma_deg', (c: CellResult) => c.gammaDeg],
    ] as const) {
      const vals = rows.map(pick).filter((v): v is number => v !== null)
      out[`${tag}_${attr}_sd`] = vals.length > 1 ? npStd(vals, 1) : null
    }
  }
  const h = opts.frameHeightNm
  const t = opts.frameTimeS
  if (strain !== null && h && t) {
    const v = (Math.abs(strain) * h) / t
    out['drift_nm_per_h'] = v * 3600.0
    out['drift_note'] =
      `漂移速率 ${pyFixed(v * 3600.0, 2)} nm/h 的**大小**站得住（它就是上下扫的不对称）；` +
      `**方向的符号未经真机确认** —— 定向翻转与慢轴推进方向的符号约定要用` +
      `一次已知方向的漂移去钉，本仓对角度符号也是这么处理的。`
  }
  return out
}

/** 一个候选超结构波矢的检验结果。 */
export interface SuperstructureResult {
  readonly label: string
  readonly periodNm: number | null
  readonly amplitude: number | null
  readonly controlMedian: number | null
  readonly controlMax: number | null
  readonly ratioToControl: number | null
  /** 三态：`present` / `absent` / `undetermined`。 */
  readonly verdict: string
  readonly note: string
}

/**
 * 在 `k0` 附近的细网格上取相干幅值的最大 —— **有偏**统计量，必须配对照。
 *
 * 用**可分离**的两次矩阵乘法算整片网格（逐点双重循环在 512² 的图上要 6 亿次
 * 复数运算）：`A(kx,ky) = Σ_y e^{-2πi·y·ky}·[Σ_x hw(y,x)·e^{-2πi·x·kx}]`。
 */
function maxOverNeighbourhood(
  hw: Mat,
  xNm: Float64Array,
  yNm: Float64Array,
  wsum: number,
  k0: readonly [number, number],
  span: number,
  step: number,
): number {
  if (!(wsum > 0)) return 0
  const n = Math.round(span / step)
  const nk = 2 * n + 1
  const kx = new Float64Array(nk)
  const ky = new Float64Array(nk)
  for (let i = 0; i < nk; i += 1) {
    const off = (i - n) * step
    kx[i] = k0[0] + off
    ky[i] = k0[1] + off
  }
  const ny = hw.rows
  const nx = hw.cols
  // T = hw @ Ex  ⇒ (ny, nk) 复数
  const tRe = new Float64Array(ny * nk)
  const tIm = new Float64Array(ny * nk)
  for (let r = 0; r < ny; r += 1) {
    for (let j = 0; j < nk; j += 1) {
      let re = 0
      let im = 0
      const kj = kx[j] as number
      for (let c = 0; c < nx; c += 1) {
        const ph = -2 * Math.PI * (xNm[c] as number) * kj
        const z = matAt(hw, r, c)
        re += z * Math.cos(ph)
        im += z * Math.sin(ph)
      }
      tRe[r * nk + j] = re
      tIm[r * nk + j] = im
    }
  }
  // A = Ey @ T ⇒ (nk, nk) 复数；取 max |A|
  let best = 0
  for (let i = 0; i < nk; i += 1) {
    const ki = ky[i] as number
    for (let j = 0; j < nk; j += 1) {
      let re = 0
      let im = 0
      for (let r = 0; r < ny; r += 1) {
        const ph = -2 * Math.PI * ki * (yNm[r] as number)
        const cr = Math.cos(ph)
        const ci = Math.sin(ph)
        const ar = tRe[r * nk + j] as number
        const ai = tIm[r * nk + j] as number
        re += cr * ar - ci * ai
        im += cr * ai + ci * ar
      }
      const m = Math.hypot(re, im)
      if (m > best) best = m
    }
  }
  return (2.0 * best) / wsum
}

/** `superstructureTest` 的可选项（缺省与旧仓逐字相同）。 */
export interface SuperstructureOptions {
  readonly fractions?: readonly (readonly [number, number])[]
  readonly searchSpanPerNm?: number
  readonly searchStepPerNm?: number
  readonly nControls?: number
  readonly seed?: number
}

/** 这一族相干求和的**尺度**（`Σ|hw| / wsum`），容差要用它 —— 见 {@link coherentAbsTol}。 */
export function coherentScale(hw: Mat, wsum: number): number {
  let s = 0
  for (let i = 0; i < hw.data.length; i += 1) s += Math.abs(hw.data[i] as number)
  return wsum > 0 ? s / wsum : 0
}

/**
 * 半序（或任意分数序）位置上有没有真实的调制 —— **带空白对照**。
 *
 * 「在半序位置上做精细搜索取最大值」是一个**有偏**统计量：纯噪声上它也给出一个
 * 正数，而且搜索范围越大给得越高。2026-09-03 夜实测，(0,½) 处得 0.58–0.80 pm，
 * 看着像信号；**把同一个统计量搬到没有任何结构的对照波矢上，得到 0.37–0.91 pm**
 * —— 两者不可区分，于是结论从「有弱超结构」翻成「1 pm 水平上没有」。
 *
 * 所以它**永远同时算对照**，并且**只报比值与判决**，不单独给一个「半序幅值」
 * 让人误读。
 *
 * ⚠️ 对照波矢由 `np.random.default_rng(seed)` 抽 —— 本仓用逐位复刻的 {@link Pcg64}
 * （`numerics/src/pcg64.ts`）。**这一处必须是 numpy 的那 8 个点**：判决就是
 * 「候选 ÷ 对照最大值」，换 8 个同样合法的点会换一个判决。
 * 这与 D-VISION-1（RANSAC 的抽样序列**不**追 numpy）是同一条判据的两侧：
 * 追不追，看的是**对面有没有一个被比的答案**。
 */
export function superstructureTest(
  image: Mat,
  nmPerPx: number,
  cell: CellResult,
  opts: SuperstructureOptions = {},
): SuperstructureResult[] {
  const fractions = opts.fractions ?? ([
    [0.5, 0.0],
    [0.0, 0.5],
    [0.5, 0.5],
  ] as const)
  const span = opts.searchSpanPerNm ?? 0.06
  const step = opts.searchStepPerNm ?? 0.005
  const nControls = opts.nControls ?? N_CONTROLS
  const seed = opts.seed ?? 0
  if (!cell.ok || cell.a1Nm === null) return []
  const ny = image.rows
  const nx = image.cols
  const n = ny * nx
  const fin: number[] = []
  for (let i = 0; i < n; i += 1) {
    const v = image.data[i] as number
    if (Number.isFinite(v)) fin.push(v)
  }
  const fill = fin.length > 0 ? npMean(fin) : 0
  const filled = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = image.data[i] as number
    filled[i] = Number.isFinite(v) ? v : fill
  }
  const mean = npMean(filled)
  const wy = hanning(ny)
  const wx = hanning(nx)
  const hwData = new Float64Array(n)
  let wsum = 0
  const winData = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      const w = (wy[r] as number) * (wx[c] as number)
      winData[r * nx + c] = w
      hwData[r * nx + c] = ((filled[r * nx + c] as number) - mean) * w
    }
  }
  // `np.sum(win)` —— 二维连续数组的整体归约走**成对求和**（`pairwise.ts` 逐位复刻）。
  wsum = npSum(winData)
  const hw = matOf(ny, nx, hwData)
  const xNm = new Float64Array(nx)
  const yNm = new Float64Array(ny)
  for (let c = 0; c < nx; c += 1) xNm[c] = c * nmPerPx
  for (let r = 0; r < ny; r += 1) yNm[r] = r * nmPerPx

  const ang = ((cell.a1AngleDeg ?? 0) * Math.PI) / 180
  const g = ((cell.gammaDeg ?? 90) * Math.PI) / 180
  const A = [
    (cell.a1Nm as number) * Math.cos(ang),
    (cell.a1Nm as number) * Math.sin(ang),
    (cell.a2Nm as number) * Math.cos(ang + g),
    (cell.a2Nm as number) * Math.sin(ang + g),
  ]
  const detA = (A[0] as number) * (A[3] as number) - (A[1] as number) * (A[2] as number)
  // `B = inv(A).T` —— 行 = 倒格矢 b₁, b₂。
  const b1: [number, number] = [(A[3] as number) / detA, -(A[2] as number) / detA]
  const b2: [number, number] = [-(A[1] as number) / detA, (A[0] as number) / detA]

  const rng = Pcg64.fromSeed(seed)
  const controls: number[] = []
  for (let i = 0; i < nControls; i += 1) {
    // 对照点：分数坐标取在明显不是 0 / ½ / 1 的地方，且落在同一个 |k| 量级上。
    let u = 0
    let v = 0
    for (;;) {
      u = rng.uniform(0.15, 0.85)
      v = rng.uniform(0.15, 0.85)
      if (Math.min(Math.abs(u - 0.5), Math.abs(v - 0.5)) > 0.12 && u + v > 0.25) break
    }
    const k0: [number, number] = [u * b1[0] + v * b2[0], u * b1[1] + v * b2[1]]
    controls.push(maxOverNeighbourhood(hw, xNm, yNm, wsum, k0, span, step))
  }
  const cMed = controls.length > 0 ? npMedian(controls) : null
  const cMax = controls.length > 0 ? Math.max(...controls) : null

  const out: SuperstructureResult[] = []
  for (const [fu, fv] of fractions) {
    const k0: [number, number] = [fu * b1[0] + fv * b2[0], fu * b1[1] + fv * b2[1]]
    const norm = Math.hypot(k0[0], k0[1])
    const amp = maxOverNeighbourhood(hw, xNm, yNm, wsum, k0, span, step)
    const ratio = cMax && cMax > 0 ? amp / cMax : null
    let verdict = 'undetermined'
    let note = '没有对照，判不了'
    if (ratio !== null) {
      if (ratio > 1.5) {
        verdict = 'present'
        note = `候选幅值是对照最大值的 ${pyFixed(ratio, 2)} 倍 —— 跳出了噪声本底。`
      } else if (ratio < 1.2) {
        verdict = 'absent'
        note =
          `候选幅值只有对照最大值的 ${pyFixed(ratio, 2)} 倍 —— 与「什么都没有」不可区分。` +
          `注意这不是「幅值为零」：细网格取最大在纯噪声上也给正数，` +
          `所以能说的是**在这个本底之上没有**。`
      } else {
        verdict = 'undetermined'
        note = `候选 / 对照 = ${pyFixed(ratio, 2)}，落在两可之间。要下结论就加长积分` + `（更大的帧）或换更干净的针尖。`
      }
    }
    out.push({
      label: `(${formatG(fu, 6)},${formatG(fv, 6)})`,
      periodNm: norm > 0 ? 1.0 / norm : null,
      amplitude: amp,
      controlMedian: cMed,
      controlMax: cMax,
      ratioToControl: ratio,
      verdict,
      note,
    })
  }
  return out
}

export type { LatticePeak }
