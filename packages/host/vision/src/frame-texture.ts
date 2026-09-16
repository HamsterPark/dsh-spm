/**
 * 一帧上「**晶格有多强、条纹有多强、哪一块清楚**」（旧仓 `mast/vision/frame_texture.py`）。
 *
 * 它与三件既有判据的分界，三条都不重叠：
 *
 * | | 问什么 |
 * |---|---|
 * | `assessAtomicPhase` | **有没有**原子相（三态）。本模块假设你已经知道有 |
 * | `judgeCorrugation` / `judgeFrame` | **整帧**起伏，不分空间频率 —— 一道台阶就能把它抬起来 |
 * | `rowJumpMadPm`（`AssessFrameTrust`） | 逐行跳动的**稳健**统计量（抗台阶、无量纲于频率） |
 * | **本模块** | **带限**幅值 —— 与晶格幅值**同单位可比**，于是那句话有完整形式：「晶格 4.7 pm，而条纹 5.6 pm」 |
 *
 * ## 两个口径必须一起给，而且**两边都不加窗**
 *
 * `amplitudePm`（带通峰峰值）是**上界**（环带宽 ±35%，带内一切都算进来）；
 * `coherentPm`（整帧相干）**不是「原子起伏」，是「整帧的相位一致性」** ——
 * 真实晶格在几十纳米上会因帧内漂移与压电非线性慢慢失相，于是这个数随视野变大
 * 而塌掉（同一根针尖：5 nm 帧 4.42 pm、20 nm 帧 1.92 pm、30 nm 帧 0.13 pm）。
 *
 * ⚠️ 旧仓开发时给相干那一侧加了 Hanning、带通那一侧没加，于是纯正弦上
 * `coherence` 得到 **1.03** —— 一个定义上不可能超过 1 的量超过了 1。
 * **两个口径必须用同一个窗**（这里是「都不加」），否则比值不是「带内有多少是
 * 周期的」，而是「两种窗的差」。
 *
 * ## 容差
 *
 * | 件 | 容差 | 推导 |
 * |---|---|---|
 * | `reason` / `ok` / 网格形状 / `tileNm` | **0** | 标签与形状 |
 * | `amplitudePm` / `streakPm` / `tileRatio` | {@link TEXTURE_REL_TOL} | 一次 `fft2` + 一次 `ifft2` + 一次 `mean(band²)`（**同号，无相消**）⇒ `3·fftRelTol(N)`，取 `1e−9` 留余量 |
 * | `coherentPm` / `coherentMedianPm` | {@link coherentAbsTol}（绝对） | `Σ z·e^{-ik·r}` 是**相消**的和 —— 相消毁掉相对精度、不毁绝对精度 |
 *
 * `coherentPm` 那一条要紧：`hex` 那一格的第二个方向读到 **0.28 pm**，
 * 而同一格第一个方向是 38 pm。给它一个**相对**容差等于对一个由相消得来的
 * 小数字要求相对精度 —— 那是在要求一件不成立的事（`numerics.md` 第四节第一条）。
 * 金样比对按「同一字段在整批上的最大绝对值」归一（`golden.ts`），
 * 于是这一条自动落在 38 pm 的尺度上。
 */
import {
  fft2,
  ifft2,
  hanning,
  matAt,
  matOf,
  npMean,
  npSum,
  type Mat,
} from 'dsh-spm-numerics'
import { npMedian } from './nd.js'
import { lstsqPlane } from './plane.js'

/** 一块里至少要装下这么多个晶格周期，装不下就**整个不给块图**。 */
export const MIN_PERIODS_PER_TILE = 8.0

/** 条纹带的慢轴上界（行）。放宽到 154 行时崩塌后的坏帧读数被地形抬到 59 pm，
 * 与好帧的 49 pm **反了过来**。下界是 Nyquist（2 行）。 */
export const STREAK_ROWS = 16.0

/** 条纹带的快轴宽度（频率格）。 */
export const STREAK_FX_BINS = 1.5

/** 「其余结构」的周期带（nm）—— 块级比值的分母。 */
export const OTHER_PERIOD_NM: readonly [number, number] = [0.15, 2.5]

/** 见文件抬头那张表。 */
export const TEXTURE_REL_TOL = 1e-9

/** 相干求和的**绝对**容差 —— 与 `lattice-cell.ts` 的同名件同一条推导。 */
export { coherentAbsTol } from './lattice-cell.js'

/** 一个晶格方向上的幅值，**两个口径一起给**（单独报其中一个都会被读错）。 */
export interface DirectionAmplitude {
  readonly angleDeg: number
  readonly periodNm: number
  /** **带通**峰峰值起伏，皮米（`2√2 × rms`）。它是**上界**。 */
  readonly amplitudePm: number
  /** **整帧相干**峰峰值起伏，皮米（`4|⟨z·e^{-ik·r}⟩|`）。见抬头。 */
  readonly coherentPm: number
  /** `coherentPm / amplitudePm` ∈ (0, 1]。读作「这个方向在整帧尺度上有多相干」。 */
  readonly coherence: number
}

/** 逐块的「晶格 / 其余」比值图。`ok=false` 时 `reason` 说明为什么没给。 */
export interface TileLatticeMap {
  readonly ok: boolean
  readonly reason: string
  readonly grid: readonly (readonly number[])[]
  readonly tileNm: number | null
  readonly periodsPerTile: number | null
  readonly goodFraction: number | null
  readonly medianRatio: number | null
  readonly goodRatio: number | null
  /** **局域**原子起伏：逐块投影到晶格波矢，取各块峰峰值的中位数，皮米。
   * 这是本模块唯一一个可以当「原子起伏有多高」引用的数 —— 它**不随视野变化**。 */
  readonly coherentMedianPm: number | null
  /** 帧**几何**上下两排块各自的中位比值。⚠️ 刻意**不叫**「先扫 / 后扫」：
   * 定向之后 row 0 恒为帧顶，而它是先扫还是后扫取决于 `:SCAN_DIR:`。
   * 这个纯函数看不到文件头，所以只报几何位置，扫描顺序由技能层映射。 */
  readonly topBandMedian: number | null
  readonly bottomBandMedian: number | null
  readonly warnings: readonly string[]
}

function emptyTiles(reason: string, over: Partial<TileLatticeMap> = {}): TileLatticeMap {
  return {
    ok: false,
    reason,
    grid: [],
    tileNm: null,
    periodsPerTile: null,
    goodFraction: null,
    medianRatio: null,
    goodRatio: null,
    coherentMedianPm: null,
    topBandMedian: null,
    bottomBandMedian: null,
    warnings: [],
    ...over,
  }
}

/** `np.fft.fftfreq(n)` 的第 `k` 个。 */
function fftFreq(k: number, n: number): number {
  return k < Math.floor((n + 1) / 2) ? k / n : (k - n) / n
}

/** `0.65·f0 < fr < 1.35·f0` 的环 —— 与 `herringbone.bandpass` 逐字同源。 */
export function ringMask(rows: number, cols: number, periodPx: number): Uint8Array {
  const out = new Uint8Array(rows * cols)
  const f0 = 1.0 / periodPx
  for (let r = 0; r < rows; r += 1) {
    const fy = fftFreq(r, rows)
    for (let c = 0; c < cols; c += 1) {
      const fx = fftFreq(c, cols)
      const fr = Math.hypot(fy, fx)
      out[r * cols + c] = fr > 0.65 * f0 && fr < 1.35 * f0 ? 1 : 0
    }
  }
  return out
}

/**
 * 以 `angleDeg` 为中心的**双侧**角向扇区（±k 都留）。
 *
 * 实信号的谱有 `F(−k) = F*(k)`，扇区必须成对留，否则 `ifft` 出来是复的。
 */
export function angleMask(rows: number, cols: number, angleDeg: number, halfWidthDeg: number): Uint8Array {
  const out = new Uint8Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    const fy = fftFreq(r, rows)
    for (let c = 0; c < cols; c += 1) {
      const fx = fftFreq(c, cols)
      const ang = (Math.atan2(fy, fx) * 180) / Math.PI
      // `np.abs((ang - a + 90) % 180 - 90)` —— **Python 的模**（结果恒非负）。
      let m = (ang - angleDeg + 90) % 180
      if (m < 0) m += 180
      out[r * cols + c] = Math.abs(m - 90) <= halfWidthDeg ? 1 : 0
    }
  }
  return out
}

/** 环带 ∩ 角向扇区。`angleDeg = null` ⇒ 整环。 */
export function directionalBandpass(image: Mat, periodPx: number, angleDeg: number | null, halfWidthDeg = 15.0): Mat {
  const ny = image.rows
  const nx = image.cols
  let keep = ringMask(ny, nx, periodPx)
  if (angleDeg !== null) {
    const am = angleMask(ny, nx, angleDeg, halfWidthDeg)
    const k = new Uint8Array(ny * nx)
    for (let i = 0; i < k.length; i += 1) k[i] = keep[i] === 1 && am[i] === 1 ? 1 : 0
    keep = k
  }
  const mean = npMean(image.data)
  const spec = fft2(matOf(ny, nx, Float64Array.from(image.data, (v) => v - mean)))
  const re = new Float64Array(ny * nx)
  const im = new Float64Array(ny * nx)
  for (let i = 0; i < re.length; i += 1) {
    if (keep[i] === 1) {
      re[i] = spec.re.data[i] as number
      im[i] = spec.im.data[i] as number
    }
  }
  const inv = ifft2({ re: matOf(ny, nx, re), im: matOf(ny, nx, im) })
  return inv.re
}

/** 带通分量 → 峰峰值皮米（`2√2 × rms × 1e12`）。 */
export function ppPm(band: Mat): number {
  const sq = Float64Array.from(band.data, (v) => v * v)
  const rms = Math.sqrt(npMean(sq))
  return 2.0 * Math.sqrt(2.0) * rms * 1e12
}

/** 相干求和 `4|⟨z·e^{-ik·r}⟩| × 1e12`（= 峰峰值皮米）。 */
function coherentPmOf(hz: Float64Array, rx: Float64Array, ry: Float64Array, kx: number, ky: number): number {
  let re = 0
  let im = 0
  for (let i = 0; i < hz.length; i += 1) {
    const ph = -2 * Math.PI * ((rx[i] as number) * kx + (ry[i] as number) * ky)
    const z = hz[i] as number
    re += z * Math.cos(ph)
    im += z * Math.sin(ph)
  }
  return (4.0 * Math.hypot(re, im) * 1e12) / hz.length
}

/**
 * **逐方向**的晶格起伏，峰峰值皮米。**输入必须是米。**
 *
 * `directions` 是 `(角度°, 周期nm)` 的序列 —— 通常来自 `findLatticePeaks` 或
 * `measureCell`。本函数**不自己找峰**：找峰有一份经过两批标定的实现（含脊点剔除），
 * 再写一份只会让两处慢慢漂开。
 *
 * 量不了的方向（周期太小、图太小）会被**跳过，不返回占位值**。
 */
export function latticeAmplitudePm(
  imageM: Mat,
  nmPerPx: number,
  directions: readonly (readonly [number, number])[],
  halfWidthDeg = 15.0,
): DirectionAmplitude[] {
  const ny = imageM.rows
  const nx = imageM.cols
  if (Math.min(ny, nx) < 16 || !(nmPerPx && nmPerPx > 0)) return []
  const n = ny * nx
  const fin: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(imageM.data[i] as number)) fin.push(imageM.data[i] as number)
  if (fin.length === 0) return []
  const fill = npMean(fin)
  const h = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = imageM.data[i] as number
    h[i] = Number.isFinite(v) ? v : fill
  }
  const hm = matOf(ny, nx, h)
  const rx = new Float64Array(n)
  const ry = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      rx[r * nx + c] = c * nmPerPx
      ry[r * nx + c] = r * nmPerPx
    }
  }
  const mean = npMean(h)
  const hz = Float64Array.from(h, (v) => v - mean)
  const out: DirectionAmplitude[] = []
  for (const [ang, perNm] of directions) {
    const perPx = perNm / nmPerPx
    // 与 `stripe_corrugation_pm` 同一道门。
    if (!(perPx >= 3.0)) continue
    const band = directionalBandpass(hm, perPx, ang, halfWidthDeg)
    const amp = ppPm(band)
    if (!Number.isFinite(amp)) continue
    const th = (ang * Math.PI) / 180
    const ampC = coherentPmOf(hz, rx, ry, Math.cos(th) / perNm, Math.sin(th) / perNm)
    let a180 = ang % 180
    if (a180 < 0) a180 += 180
    out.push({
      angleDeg: a180,
      periodNm: perNm,
      amplitudePm: amp,
      coherentPm: ampC,
      coherence: amp > 0 ? Math.min(1.0, ampC / amp) : 0,
    })
  }
  return out
}

/**
 * 减去最小二乘拟合的二维多项式曲面（`order=1` 即平面）。**NaN 安全**：
 * 只用有限像素拟合，再把曲面从**整幅**图上减掉。
 */
export function polySubtract(m: Mat, order = 1): Mat {
  const { rows, cols } = m
  const n = rows * cols
  if (order !== 1) throw new RangeError(`polySubtract 只移了 order=1：得到 ${order}`)
  const idx: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(m.data[i] as number)) idx.push(i)
  const nTerms = ((order + 1) * (order + 2)) / 2
  const out = new Float64Array(n)
  if (idx.length < nTerms + 1) {
    const fin = idx.map((i) => m.data[i] as number)
    const mean = fin.length > 0 ? npMean(fin) : 0
    for (let i = 0; i < n; i += 1) out[i] = (m.data[i] as number) - mean
    return matOf(rows, cols, out)
  }
  // `terms = [x**j * y**i for i in 0..order for j in 0..order-i]` ⇒ `[1, x, y]`。
  // 拟合走 {@link lstsqPlane}（中心化的正规方程，批 4a 那一份）—— 不写第二份。
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
    for (let c = 0; c < cols; c += 1) {
      out[r * cols + c] = matAt(m, r, c) - (a0 + a1 * c + a2 * r)
    }
  }
  return matOf(rows, cols, out)
}

/**
 * **逐行横向短划**的起伏，峰峰值皮米。**输入必须是米。**
 *
 * 抓的形状：沿快轴延展（`|fx| ≤ 几个频率格`）、沿慢轴在 2–`maxRows` 行之间起伏。
 * 针尖顶端在两个态之间闪变时，图上就是这样一条条横道。
 *
 * ⚠️ **这个数单独看没有意义，必须与同口径的晶格带通幅值一起读**：它随整帧起伏
 * 一起涨 —— 真机实测针尖崩塌**之后**的帧读数（20 pm）反而**低于**好帧（31–44 pm），
 * 因为好帧那片区域地形本来就更丰富。
 *
 * ⚠️ 去趋势用的是 {@link polySubtract}（二维多项式面），**不是**
 * `tip_metrics._detrend`。后者第一步就减掉**行中值**，而行与行之间的偏置
 * **正是这里要量的东西** —— 用它会把信号连同背景一起清零。
 * 这不是绕开单一真源，是这道判据与那一份去趋势不兼容。
 */
export function streakAmplitudePm(
  imageM: Mat,
  nmPerPx: number,
  opts: { maxRows?: number; fxBins?: number } = {},
): number | null {
  const maxRows = opts.maxRows ?? STREAK_ROWS
  const fxBins = opts.fxBins ?? STREAK_FX_BINS
  const H = imageM.rows
  const W = imageM.cols
  if (Math.min(H, W) < 16 || !(nmPerPx && nmPerPx > 0)) return null
  // 背景倾斜/弯曲落在慢轴低频，与条纹带重叠。不减掉的话量到的是样品的倾斜。
  const flat = polySubtract(imageM, 1)
  // 慢轴加窗：帧里装着非整数个周期的地形会从帧边沿泄漏到**所有** fy 上，
  // 把条纹带填满（实测 30 pm 的平滑正弦不加窗时被读成 7.7 pm 的「条纹」）。
  // 窗按 rms 归一，幅值标定不变。
  const wy = hanning(H)
  const wsq = Float64Array.from(wy, (v) => v * v)
  const norm = Math.sqrt(npMean(wsq))
  const h = new Float64Array(H * W)
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) h[r * W + c] = (matAt(flat, r, c) * (wy[r] as number)) / norm
  }
  const keep = new Uint8Array(H * W)
  let any = false
  for (let r = 0; r < H; r += 1) {
    const fy = Math.abs(fftFreq(r, H))
    // `fy` 的单位是「每行的周数」，所以周期（行）= 1/|fy| —— 与 nm/px 无关。
    const keepY = fy >= 1.0 / maxRows && fy <= 0.5
    for (let c = 0; c < W; c += 1) {
      const keepX = Math.abs(fftFreq(c, W)) <= fxBins / W
      const k = keepX && keepY
      keep[r * W + c] = k ? 1 : 0
      if (k) any = true
    }
  }
  if (!any) return null
  const mean = npMean(h)
  const spec = fft2(matOf(H, W, Float64Array.from(h, (v) => v - mean)))
  const re = new Float64Array(H * W)
  const im = new Float64Array(H * W)
  for (let i = 0; i < re.length; i += 1) {
    if (keep[i] === 1) {
      re[i] = spec.re.data[i] as number
      im[i] = spec.im.data[i] as number
    }
  }
  const band = ifft2({ re: matOf(H, W, re), im: matOf(H, W, im) }).re
  const amp = ppPm(band)
  return Number.isFinite(amp) ? amp : null
}

/** 这一块里最强的那个晶格方向的**局域**峰峰值起伏，皮米。 */
function tileCoherentPm(tile: Mat, nmPerPx: number, directions: readonly (readonly [number, number])[]): number {
  const ny = tile.rows
  const nx = tile.cols
  const n = ny * nx
  const rx = new Float64Array(n)
  const ry = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      rx[r * nx + c] = c * nmPerPx
      ry[r * nx + c] = r * nmPerPx
    }
  }
  const mean = npMean(tile.data)
  const hz = Float64Array.from(tile.data, (v) => v - mean)
  let best = 0
  for (const [ang, perNm] of directions) {
    const th = (ang * Math.PI) / 180
    const amp = coherentPmOf(hz, rx, ry, Math.cos(th) / perNm, Math.sin(th) / perNm)
    if (amp > best) best = amp
  }
  return best
}

/**
 * 一块里「晶格带功率 / 其余结构功率」的平方根（= 幅值比）。
 *
 * 分子分母**同一块、同一个窗**，所以块的尺寸与位置在比值里抵消 ——
 * 这正是它能跨帧尺寸比较、而角向集中度不能的原因。
 */
function tileRatio(tile: Mat, nmPerPx: number, directions: readonly (readonly [number, number])[], halfWidthDeg: number): number {
  const H = tile.rows
  const W = tile.cols
  const n = H * W
  const wy = hanning(H)
  const wx = hanning(W)
  const mean = npMean(tile.data)
  const win = new Float64Array(n)
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) win[r * W + c] = (matAt(tile, r, c) - mean) * (wy[r] as number) * (wx[c] as number)
  }
  const spec = fft2(matOf(H, W, win))
  const P = new Float64Array(n)
  for (let r = 0; r < H; r += 1) {
    const sr = (r + Math.ceil(H / 2)) % H
    for (let c = 0; c < W; c += 1) {
      const sc = (c + Math.ceil(W / 2)) % W
      const m = Math.hypot(matAt(spec.re, sr, sc), matAt(spec.im, sr, sc))
      P[r * W + c] = m * m
    }
  }
  const cy = H >> 1
  const cx = W >> 1
  const lat: number[] = []
  const other: number[] = []
  for (let r = 0; r < H; r += 1) {
    const fy = (r - cy) / H
    for (let c = 0; c < W; c += 1) {
      const fx = (c - cx) / W
      const fr = Math.hypot(fy, fx)
      const per = fr > 0 ? nmPerPx / Math.max(fr, 1e-12) : Infinity
      let inLat = false
      for (const [ang, perNm] of directions) {
        const f0 = nmPerPx / perNm
        if (!(fr > 0.65 * f0 && fr < 1.35 * f0)) continue
        const angm = (Math.atan2(fy, fx) * 180) / Math.PI
        let d = (angm - ang + 90) % 180
        if (d < 0) d += 180
        if (Math.abs(d - 90) <= halfWidthDeg) {
          inLat = true
          break
        }
      }
      const v = P[r * W + c] as number
      if (inLat) lat.push(v)
      else if (per >= OTHER_PERIOD_NM[0] && per <= OTHER_PERIOD_NM[1]) other.push(v)
    }
  }
  const pLat = lat.length > 0 ? npSum(lat) : 0
  const pOth = other.length > 0 ? npSum(other) : 0
  if (pOth <= 0) return 0
  return Math.sqrt(pLat / pOth)
}

/**
 * 把帧切成方块，逐块问「这一块的晶格压不压得住其余结构」。
 *
 * `directions` 与 {@link latticeAmplitudePm} 同源，一般是整帧上找到的两三个
 * 布拉格方向 —— **块内不重新找峰**：一块里只有几个周期，找峰会锁到噪声上，
 * 而「整帧知道晶格在哪个方向，逐块问它在不在」才是这张图要回答的问题。
 *
 * 纯函数。给不出图时返回 `ok=false` + `reason`，**不返回一张全零的图**。
 */
export function tileLatticeMap(
  image: Mat,
  nmPerPx: number,
  directions: readonly (readonly [number, number])[],
  opts: { tileNm?: number; goodRatio?: number; halfWidthDeg?: number } = {},
): TileLatticeMap {
  const tileNm = opts.tileNm ?? 4.0
  const goodRatio = opts.goodRatio ?? 0.6
  const halfWidthDeg = opts.halfWidthDeg ?? 15.0
  if (!(nmPerPx && nmPerPx > 0)) return emptyTiles('bad_input')
  if (directions.length === 0) {
    return emptyTiles('no_directions', {
      warnings: ['没有给晶格方向 —— 块图问的是「这一块上' + '那个方向的晶格在不在」，方向未知时无从问起。'],
    })
  }
  const H = image.rows
  const W = image.cols
  const n = H * W
  let nFinite = 0
  const fin: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(image.data[i] as number)) {
      nFinite += 1
      fin.push(image.data[i] as number)
    }
  }
  if (nFinite / n < 0.5) return emptyTiles('incomplete_frame')
  const fill = npMean(fin)
  const h = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = image.data[i] as number
    h[i] = Number.isFinite(v) ? v : fill
  }
  const hm = matOf(H, W, h)

  let perMin = Infinity
  for (const [, p] of directions) if (p < perMin) perMin = p
  const tPx = Math.round(tileNm / nmPerPx)
  const periods = tileNm / perMin
  if (periods < MIN_PERIODS_PER_TILE) {
    return emptyTiles('tile_too_small', {
      tileNm,
      periodsPerTile: periods,
      warnings: [
        `每块只装得下 ${fmt1(periods)} 个周期（下限 ${fmt0(MIN_PERIODS_PER_TILE)}）—— 块再小，` +
          `块内谱就分不开晶格与噪声。要么把 tile_nm 调大，` +
          `要么这一帧的视野本来就不够切块。`,
      ],
    })
  }
  if (tPx < 16) {
    return emptyTiles('tile_too_few_pixels', {
      tileNm,
      periodsPerTile: periods,
      warnings: [`每块只有 ${tPx} 像素（下限 16）—— 像素太少，块内谱没有分辨率。`],
    })
  }
  const ny = Math.floor(H / tPx)
  const nx = Math.floor(W / tPx)
  if (ny < 1 || nx < 1) return emptyTiles('frame_smaller_than_tile', { tileNm, periodsPerTile: periods })

  const grid: number[][] = []
  const coh: number[] = []
  const flatGrid: number[] = []
  for (let iy = 0; iy < ny; iy += 1) {
    const row: number[] = []
    for (let ix = 0; ix < nx; ix += 1) {
      const sub = new Float64Array(tPx * tPx)
      for (let r = 0; r < tPx; r += 1) {
        for (let c = 0; c < tPx; c += 1) sub[r * tPx + c] = matAt(hm, iy * tPx + r, ix * tPx + c)
      }
      const t = matOf(tPx, tPx, sub)
      const v = tileRatio(t, nmPerPx, directions, halfWidthDeg)
      row.push(v)
      flatGrid.push(v)
      coh.push(tileCoherentPm(t, nmPerPx, directions))
    }
    grid.push(row)
  }
  let good = 0
  for (const v of flatGrid) if (v >= goodRatio) good += 1
  return {
    ok: true,
    reason: '',
    grid,
    tileNm,
    periodsPerTile: periods,
    goodFraction: good / flatGrid.length,
    medianRatio: npMedian(flatGrid),
    goodRatio,
    coherentMedianPm: npMedian(coh),
    topBandMedian: npMedian(grid[0] as number[]),
    bottomBandMedian: npMedian(grid[ny - 1] as number[]),
    warnings: [],
  }
}

/** Python 的 `"%.1f"`。 */
function fmt1(x: number): string {
  return x.toFixed(1)
}
/** Python 的 `"%.0f"`。 */
function fmt0(x: number): string {
  return x.toFixed(0)
}
