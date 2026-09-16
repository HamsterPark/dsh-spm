/**
 * 扫描**线**上的原子分辨判据 —— 旧仓 `mast/vision/atomic_lines.py`（202 行，
 * 只 import numpy，无任何跨模块调用）。
 *
 * ## 为什么按线判，而不是按帧判
 *
 * 旧仓实测中，一张 5 nm / 256 px 的图按 0.768 s/线需要 **6.6 分钟**，按帧判一个回合
 * 就是分钟级。因此采用边扫边判的方式
 *
 * 该流程在扫描过程中周期性查看扫描线，直到出现规则跳动。
 *
 * 按线判是 `0.768 s × 2（正反扫）= 1.54 s` 一条线。旧仓实测中每 22 秒可拿到 14 条新线，
 * **回合快 18 倍**。
 *
 * ## 它回答的**不是**帧级判据那个问题
 *
 * 一条线只有一个方向，**判不了「是不是二维晶格」**。旧仓实测的负例帧上的峰周期也是
 * 0.263 nm，与正例一样 —— 区分正负的是**强度**，不是那个周期存在与否。
 * 所以输出叫 **advisory（建议）**，用途只有一个：「值得不值得停下来扫一整帧」。
 *
 * ## 阈值 115 的来历，以及那一档**假正例**
 *
 * ```
 * 真正例（二维判据 passed）  121.3 129.0 142.8 153.7 164.3 184.9 211.5 224.5
 * 假正例（线上过线、二维判据 not_a_lattice）      99.8 104.0
 * 负例                          5.8 5.9 6.7 6.7 9.3 16.8
 * ```
 *
 * 出厂第一版取 80 —— 那时候还没有假正例这一档。实测撞上一次：线级 104/99.8 连过两轮，
 * 扫了确认帧，二维角向集中度只有 **4.14**，周期 0.625 nm、`not_a_lattice` ——
 * 线上确实有强的 0.25 nm 周期，但那是沿快扫方向的**一维条纹**，不是晶格。
 *
 * ⚠️ 必须喂 **Z 通道**：旧仓实测中 Z 的 SNR 中位 211–225，而电流通道只有 52–82。
 * 恒流反馈下电流是误差信号，规则跳动主要落在 Z 上。
 *
 * ## 容差：去趋势那一步换了算法，所以容差写在**它**身上
 *
 * `np.polyfit(x, y, 3)` 走**列归一化的 Vandermonde + SVD**；本仓走
 * **中心化 + 缩放的单项式基 + 正规方程**（`u = (x − x̄)/((n−1)/2) ∈ [−1, 1]`）。
 *
 * 为什么不照抄 `vander(x, 4)`：`x = 0…255` 的三次 Vandermonde 条件数在 `1e7` 量级，
 * 正规方程把它**平方** ⇒ `1e14 · eps ≈ 0.02`，那不是容差，那是没有答案。
 * 中心化 + 缩放之后条件数掉到两位数，正规方程才站得住。
 *
 * 而**去趋势的残差本身与基无关**（它是 y 到三次子空间正交补的投影），
 * 所以换基不换答案，只换误差：
 *
 * | 件 | 容差 | 来历 |
 * |---|---|---|
 * | `detrended` | `lstsqRelTol(κ_u)`，按 `max\|y\|` 归一 | κ_u = 缩放基的条件数，由导出器随金样录下来 |
 * | `periodNm` / `peakWidthBins` / `binsInBand` | **0** | 它们是**下标**：`argmax` 挑中哪一格、半高宽数了几格 |
 * | `lineSnr` | `4 · lstsqRelTol(κ_u) + fftRelTol(n)` | 功率是幅度的平方（误差 ×2），比值再 ×2；FFT 那一份按 `numerics` 的界 |
 *
 * ⚠️ `periodNm` 零容差是有代价的：它要求 `argmax` 挑中**同一格**。金样的输入因此
 * 刻意让峰**孤立**（合成的单一周期 + 宽带底噪），而不是靠容差去接住一次挑错 ——
 * 挑到隔壁那一格是整整一个频率格的跳，给多少容差都接不住（同 D-NUM-14 那条）。
 */
import { fft, fftRelTol, lstsqRelTol, matAt, mean, percentile, solveNormalEquations, type Mat } from 'dsh-spm-numerics'
import { finiteOf, npMedian } from './nd.js'
import { pyFixed } from 'dsh-spm-kernel'

/** 物理上可能的晶格周期区间（nm）。例如 Au(111) 0.288、HOPG 0.246，另含亚 nm 晶格。 */
export const PERIOD_MIN_NM = 0.15
export const PERIOD_MAX_NM = 0.45

/** 去趋势的多项式阶数。台阶与漂移是低频，不去掉会把晶格峰淹了；阶数再高会开始吃掉晶格本身。 */
export const DETREND_ORDER = 3

/** 一条线至少要这么多有效点才值得算。 */
export const MIN_PIXELS = 32

/** **建议**停下来正经判一帧的线级 SNR 中位。**不是**「有原子分辨」的判据。 */
export const ADVISORY_SNR = 115.0

/** 连续几轮都过建议线才值得停下来。单轮判据会被针尖顶端的反复重构骗。 */
export const ADVISORY_STREAK = 2

/** 一条线的打分。`ok=false` 时只有 `why` 有意义 —— **不回一个 0**（0 会被读成「测了，没有」）。 */
export type LineScore =
  | { ok: false; why: string }
  | {
      ok: true
      period_nm: number
      line_snr: number
      peak_width_bins: number
      n_px: number
      bins_in_band: number
    }

/** 三次去趋势用的基的条件数所对应的容差。见文件抬头那张表。 */
export function detrendRelTol(condU: number): number {
  return lstsqRelTol(condU)
}

/** `lineSnr` 的容差（同上表最后一行）。 */
export function lineSnrRelTol(condU: number, n: number): number {
  return 4 * lstsqRelTol(condU) + fftRelTol(n)
}

/** `np.polyfit(x, y, 3)` + `np.polyval` 的**残差**。基换了，答案没换 —— 见文件抬头。 */
export function detrendCubic(y: readonly number[]): number[] {
  const n = y.length
  if (n === 0) return []
  const xbar = (n - 1) / 2
  const scale = n > 1 ? (n - 1) / 2 : 1
  const cols: Float64Array[] = []
  for (let p = 0; p <= DETREND_ORDER; p += 1) {
    const col = new Float64Array(n)
    for (let i = 0; i < n; i += 1) col[i] = ((i - xbar) / scale) ** p
    cols.push(col)
  }
  let coef: Float64Array
  try {
    coef = solveNormalEquations(cols, Float64Array.from(y))
  } catch {
    // 病态拟合不该让整轮判读挂掉 —— 旧仓在这条路上退回「减均值」。
    const m = mean(y)
    return y.map((v) => v - m)
  }
  return y.map((v, i) => {
    let t = 0
    for (let p = 0; p <= DETREND_ORDER; p += 1) t += (coef[p] as number) * ((cols[p] as Float64Array)[i] as number)
    return v - t
  })
}

/** `np.hanning(n)`。`n === 1` 时是 `[1]`（同 numpy）。 */
export function hanning(n: number): Float64Array {
  const w = new Float64Array(n)
  if (n === 1) {
    w[0] = 1
    return w
  }
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** 一条扫描线的「规则跳动」得分。 */
export function lineScore(line: readonly number[] | Float64Array, nmPerPx: number): LineScore {
  const y0 = finiteOf(line)
  if (y0.length < MIN_PIXELS) {
    return { ok: false, why: `这条线只有 ${y0.length} 个有效点，不足 ${MIN_PIXELS}` }
  }
  const n = y0.length
  const y = detrendCubic(y0)
  const w = hanning(n)
  const spec = fft(Float64Array.from(y.map((v, i) => v * (w[i] as number))))
  const half = (n >> 1) + 1
  const sp = new Float64Array(half)
  for (let i = 0; i < half; i += 1) {
    sp[i] = Math.hypot(spec.re[i] as number, spec.im[i] as number) ** 2
  }
  // `np.fft.rfftfreq(n, d=1.0)` = k / n
  const bandIdx: number[] = []
  const periodNm = new Float64Array(half)
  for (let i = 0; i < half; i += 1) {
    const freq = i / n
    periodNm[i] = freq > 0 ? nmPerPx / Math.max(freq, 1e-12) : Infinity
    const p = periodNm[i] as number
    if (p >= PERIOD_MIN_NM && p <= PERIOD_MAX_NM) bandIdx.push(i)
  }
  if (bandIdx.length < 3) {
    return {
      ok: false,
      why:
        `${pyFixed(nmPerPx, 4)} nm/px 的尺度下，${n} 点的线在 ` +
        `${pyFixed(PERIOD_MIN_NM, 2)}–${pyFixed(PERIOD_MAX_NM, 2)} nm 这个周期区间里` +
        `只有 ${bandIdx.length} 个频率格 —— 撑不起一个峰`,
    }
  }
  let k = bandIdx[0] as number
  for (const i of bandIdx) if ((sp[i] as number) > (sp[k] as number)) k = i
  const peak = sp[k] as number
  const med = npMedian(bandIdx.map((i) => sp[i] as number))
  const halfPeak = peak / 2
  let lo = k
  let hi = k
  while (lo > 1 && (sp[lo - 1] as number) >= halfPeak) lo -= 1
  while (hi < sp.length - 1 && (sp[hi + 1] as number) >= halfPeak) hi += 1
  return {
    ok: true,
    period_nm: periodNm[k] as number,
    line_snr: med > 0 ? peak / med : Infinity,
    peak_width_bins: hi - lo + 1,
    n_px: n,
    bins_in_band: bandIdx.length,
  }
}

/**
 * 哪些行是**扫出来了**的。判据是「不全零 且 全有限」。
 *
 * 第一版真去跟上一份做 diff，而且**恒等于「没变」**：`np.isclose` 的默认
 * `atol=1e-8` 比整个 Z 量程 ~1e-10 m 大 100 倍，0 和信号都被判成相等。
 * **容差大于信号 = 判据在量一个不存在的东西。**
 */
export function usableRows(img: Mat): Uint8Array {
  const out = new Uint8Array(img.rows)
  for (let r = 0; r < img.rows; r += 1) {
    let allFinite = 1
    let allZero = 1
    for (let c = 0; c < img.cols; c += 1) {
      const v = matAt(img, r, c)
      if (!Number.isFinite(v)) allFinite = 0
      const z = Number.isNaN(v) ? 0 : v
      if (z !== 0) allZero = 0
    }
    out[r] = allZero === 1 ? 0 : allFinite
  }
  return out
}

export interface LineAdvisory {
  ok: boolean
  why?: string
  n_rows_offered?: number
  n_lines_scored?: number
  n_lines_skipped?: number
  line_snr_median?: number
  line_snr_p90?: number | null
  period_median_nm?: number
  peak_width_median_bins?: number
  advisory_snr?: number
  worth_a_frame?: boolean
  advisory?: string
}

/**
 * 把 {@link lineScore} 铺到给定的行上，回一份**建议**。
 *
 * 统计用**中位数**不用均值：掠过一个台阶、一次针尖跳变的坏线会把均值拽走，
 * 而要看的是「多数线上都有规则跳动」。
 */
export function frameLineAdvisory(
  img: Mat,
  nmPerPx: number,
  opts: { rows?: Uint8Array | null; advisorySnr?: number } = {},
): LineAdvisory {
  const advisorySnr = opts.advisorySnr ?? ADVISORY_SNR
  const rows = opts.rows ?? usableRows(img)
  const idx: number[] = []
  for (let r = 0; r < rows.length; r += 1) if (rows[r] === 1) idx.push(r)
  const scored: Extract<LineScore, { ok: true }>[] = []
  const skipped: Extract<LineScore, { ok: false }>[] = []
  for (const j of idx) {
    const row: number[] = []
    for (let c = 0; c < img.cols; c += 1) row.push(matAt(img, j, c))
    const s = lineScore(row, nmPerPx)
    if (s.ok) scored.push(s)
    else skipped.push(s)
  }
  if (scored.length === 0) {
    const why = skipped.length > 0 ? (skipped[0] as Extract<LineScore, { ok: false }>).why : '这一帧里没有已扫出来的行'
    return { ok: false, n_rows_offered: idx.length, why }
  }
  const snr = scored.map((s) => s.line_snr)
  const per = scored.map((s) => s.period_nm)
  const wid = scored.map((s) => s.peak_width_bins)
  const med = npMedian(snr)
  return {
    ok: true,
    n_lines_scored: snr.length,
    n_lines_skipped: skipped.length,
    line_snr_median: med,
    line_snr_p90: snr.length > 4 ? percentile(snr, 90) : null,
    period_median_nm: npMedian(per),
    peak_width_median_bins: npMedian(wid),
    advisory_snr: advisorySnr,
    worth_a_frame: med >= advisorySnr,
    // 措辞刻意是「建议」不是「判定」：一条线判不了二维晶格。
    advisory:
      med >= advisorySnr
        ? `线上的规则跳动够强（中位 ${pyFixed(med, 1)} ≥ ${pyFixed(advisorySnr, 0)}）—— **建议**停下来扫一整帧，` +
          '交二维判据定夺。一条线判不了「是不是晶格」。'
        : `线上的规则跳动还不够（中位 ${pyFixed(med, 1)} < ${pyFixed(advisorySnr, 0)}）—— 建议接着打磨。` +
          '注意单轮下跌不等于针尖变差：真机实测无损伤时轮间也会从 222 晃到 149。',
  }
}
