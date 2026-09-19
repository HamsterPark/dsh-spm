/**
 * 扫描图自动预处理：**量出来 → 选处理方式 → 说清楚为什么**。
 * 旧仓 `mast/vision/scan_prep.py`（855 行）整份。
 *
 * ## 这个模块在补哪一块
 *
 * 仓里早就有**动词**（`plane_subtract` / `level_lines` / `subtract_poly2d` /
 * `destripe`）。缺的是**判断**：这一帧该用哪一个、为什么、以及同一组图怎么保持一致。
 * 这里就是那个判断，外加一个仓里没有的处理原语
 * （**在主 terrace 上拟合的逐行平场**）。
 *
 * ## 它**不**判什么（这是刻意的）
 *
 * 「这一帧上有什么」的结论一律**转发**既有判据，不在这里重造：
 *
 * | 问题 | 转发给 |
 * |---|---|
 * | 有没有原子晶格 | {@link assessAtomicPhase}（批 4b） |
 * | 扫到一半针尖变没变 | {@link detectTipChange} |
 * | 正反扫一不一致 | {@link fwdBwdInstability} |
 * | 坏行 / 尖峰 / 反馈振荡 | {@link detectScanArtifacts} |
 *
 * 理由不是省事：这四条在仓里的版本都**实测推翻过** sxm_auto 用的那一版
 * （峰强度 SNR 分不开针尖抖动；单点分割 max-t 的 AUC 0.510；零位移互相关在
 * 真机上饱和）。**两套判据并存等于在同一段模型上下文里放两句互相打架的结论。**
 *
 * 本模块唯一保留的频域量是 `finePeriodicSnr`，它**只决定色阶**（有精细周期结构时
 * 把色阶收紧，否则会被压成一团）—— 名字里没有 `lattice` 就是为了不让它被读成结论。
 *
 * ## 被否决的三条候选判据（在这里留字，在测试里留钉）
 *
 * 它们最容易被后人「顺手加回来」：
 *
 * 1. **行中位数跳变比 + 行中位数谱的高频占比**：13 张实测分别挤在 4.49–10.03 与
 *    0.018–0.264，且排序与任何真实差别都不对应（晶格帧 0004 的跳变比最大而高频
 *    占比最小）。**什么都区分不出来。** 换成 `lineGain` 与行相关。
 * 2. **中值滤波做高通**：中心像素常常就是自己窗口的中位数，残差是**精确的 0**。
 *    13 张里精确零占 10%–48%，MAD 随之塌掉 —— 0004 上 7.49 pm → 0.42 pm，
 *    会让 `sepOverRough` 虚高约 18 倍，于是每一帧都成了「有台阶」。**用均值滤波。**
 * 3. **只靠「直方图双峰」判台阶**：它把 0004 的针尖/漂移突变判成台阶并去「保护」它，
 *    宽色阶把晶格压没了。加 `rowPurity`：真台阶横跨画面，大多数行同时含两个高度
 *    （0001=0.14、0008=0.19）；行向分层严格按行切（0004=0.91）。**>0.70 判为伪台阶。**
 *
 * ## 判据在纯噪声上的误报
 *
 * `lineGain` / `bowGain` 按构造 ≥1（更大的拟合空间不可能让残差变大），所以阈值就是
 * 判据的全部内容。512×512 的纯高斯白噪声上，逐行一阶平场多用 2×512−3 个自由度 ⇒
 * `lineGain ≈ 1.002`；二阶曲面多 3 个 ⇒ `bowGain ≈ 1.000006`。
 * 离 1.30 / 1.15 极远，**过拟合点不着这两条判据**。
 *
 * ## 纯函数
 *
 * 零 IO、零配置读取、不碰硬件、不抛异常（除了明确的形状错误）。
 * 阈值全部由参数传入（`kernel` 的 `ScanPrepThresholds`），所以合成数据测得动。
 *
 * ## 容差表（每一条连推导写在被测函数上）
 *
 * | 量 | 容差 | 尺度是谁 |
 * |---|---|---|
 * | `shape` / `deadRows` / `analysisRows` / `nPeaks` | **0** | 计数与下标 |
 * | `nanFrac` / `rowPurity` | **0** | 计数比 |
 * | `planeRmsPm` / `lineGain` / `bowGain` / `roughnessPm` / `stepSepPm` | {@link FLATTEN_REL_TOL} | 残差的 std |
 * | `finePeriodicSnr` / `finePeriodNm` / `fineAngleDeg` | {@link FINE_PEAK_REL_TOL} | 一次 `fft2` |
 * | `rowcorrMedian` | {@link FLATTEN_REL_TOL} | 同残差 |
 * | `method` / `clip` / `why` / `notes` / `stepLike` / `fineStructure` | **0** | 判决与原文 |
 */
import {
  formatG,
  pyFixed,
  pyFloatRepr,
  scanPrepNumericMapping,
  type ScanPrepThresholds,
} from 'dsh-spm-kernel'
import {
  fft2,
  findPeaks,
  gaussianFilter1d,
  histogram,
  hanning,
  matOf,
  npMean,
  npSum,
  percentile,
  polyval,
  type Mat,
} from 'dsh-spm-numerics'
import { assessAtomicPhase, type AtomicPhaseResult } from './atomic-phase.js'
import { interp, nanMedian, nanStd, npMedian } from './nd.js'
import { polyfit } from './lsq.js'
import { uniformFilter2d } from './ndfilters.js'
import { polySubtract } from './plane.js'
import { detectScanArtifacts, type ScanArtifacts } from './scan-artifacts.js'
import { detectTipChange, type TipChange } from './tip-change.js'
import { fwdBwdInstability } from './tip-metrics.js'

/** 处理方式 → 人话。 */
export const METHOD_LABEL: Readonly<Record<string, string>> = {
  plane: '扣平面',
  poly2: '扣二阶曲面',
  line: '逐行一阶平场',
  masked_line: '只在主 terrace 上拟合的逐行平场',
}

export const METHODS: readonly string[] = ['plane', 'poly2', 'line', 'masked_line']

/**
 * 平场残差派生量的相对容差。
 *
 * 这一族（`plane_rms_pm` / `line_gain` / `bow_gain` / `roughness_pm` /
 * `rowcorr_median`）全部是**残差的统计量**，而残差 `a − A·c` 是往 A 正交补上的
 * 投影 —— 系数在近零奇异方向上的误差**几乎不改变它**。于是这里的主项不是
 * `κ·eps`（那是系数的），而是
 *
 * * 一次 `std` 的成对求和：`O(eps·log₂n)`，`n = 65536` ⇒ `16·eps`；
 * * QR 与 SVD 两条回代路径在残差上的差：`O(eps·√n)` 量级的**投影**扰动。
 *
 * `1e−9` 比这个界（`≈ 1e−14`）宽五个量级，理由与 `CELL_REL_TOL` 同：
 * **这一族真正会犯的错是选错了平场方式**（`line_gain` 差一整个档，不是最后一位）。
 * 把容差收到理论界只会让下一个人去调它。**实测占比见测试。**
 */
export const FLATTEN_REL_TOL = 1e-9

/**
 * 受限带 FFT 峰三个量的相对容差。
 *
 * `snr = F[峰] / median(F[环])`。分子分母各是一次 `fft2` 的模，绝对误差都由
 * **整幅谱的最大系数** `‖F‖∞` 定（批 4b §9①），而这里的分子**就是**带内最大、
 * 分母是同一个环上的中位 —— 两者同量级，于是相对口径站得住。
 *
 * `period_nm` / `angle_deg` 是**下标查出来的**（`1/freq[pi]`、`atan2(fy, fx)`），
 * 一次除法 / 一次 `atan2` ⇒ `4·eps`。它们与 `snr` 共用这条容差只是为了少一个名字；
 * ⚠️ 真正的风险不在这个数上，在 **`argmax` 会不会挑到另一格** —— 那由构造避免：
 * 金样的合成帧里带内主峰比次峰高一个量级以上（测试里有一条「抖一下，峰位不动」
 * 的结构性断言钉住它，同批 4b `lattice.test.ts` 那一条）。
 */
export const FINE_PEAK_REL_TOL = 1e-9

// ═══════════════════════════════════════════════════════════════════════
// 基本量
// ═══════════════════════════════════════════════════════════════════════

/** `1.4826 × 中位绝对偏差`。空 / 全非有限 ⇒ `NaN`。 */
export function mad(xs: Float64Array | readonly number[]): number {
  const a: number[] = []
  for (let i = 0; i < xs.length; i += 1) {
    const v = (xs as readonly number[])[i] as number
    if (Number.isFinite(v)) a.push(v)
  }
  if (a.length === 0) return NaN
  const med = npMedian(a)
  return 1.4826 * npMedian(a.map((v) => Math.abs(v - med)))
}

// `polySubtract` 住在 `plane.ts`（order 1 与 2 走两条求解路，见那一份的抬头）。

/** `np.nanmean`。 */
function nanMean(xs: Float64Array): number {
  const a: number[] = []
  for (let i = 0; i < xs.length; i += 1) {
    const v = xs[i] as number
    if (Number.isFinite(v)) a.push(v)
  }
  return a.length === 0 ? NaN : npMean(a)
}

/**
 * 逐行减去一条多项式。
 *
 * `mask` 把**拟合**限制在选中的像素上（主 terrace），而**修正仍施加到整行** ——
 * 这就是台阶能活下来的原因。
 *
 * ⚠️ 可用像素太少的行**不去拿垃圾拟合**，而是从邻行的系数线性插值补上：
 * 否则一条几乎全 NaN 的行会甩出一个荒谬的斜率，**再被减到整行上**。
 *
 * 仓里既有的 `line_by_line_level` 没有 mask 参数、也不处理 NaN ——
 * 遇到有台阶或未扫完的帧会把台阶吃掉 / 整行变 NaN。
 */
export function lineSubtract(img: Mat, order = 1, mask: Uint8Array | null = null): Mat {
  const ny = img.rows
  const nx = img.cols
  const ord = Math.max(0, Math.trunc(order))
  const need = Math.max(ord + 2, Math.trunc(0.15 * nx))
  const coeffs: Array<Float64Array | null> = new Array(ny).fill(null)
  for (let r = 0; r < ny; r += 1) {
    const xs: number[] = []
    const ys: number[] = []
    for (let c = 0; c < nx; c += 1) {
      const v = img.data[r * nx + c] as number
      if (!Number.isFinite(v)) continue
      if (mask !== null && mask[r * nx + c] !== 1) continue
      xs.push(c)
      ys.push(v)
    }
    if (xs.length >= need) coeffs[r] = polyfit(Float64Array.from(xs), Float64Array.from(ys), ord)
  }
  const valid: number[] = []
  for (let r = 0; r < ny; r += 1) if (coeffs[r] !== null) valid.push(r)
  if (valid.length === 0) {
    const m = nanMean(img.data)
    const out = new Float64Array(ny * nx)
    const sub = Number.isFinite(m) ? m : 0
    for (let i = 0; i < out.length; i += 1) out[i] = (img.data[i] as number) - sub
    return matOf(ny, nx, out)
  }
  // 逐个系数按行号线性插值（`np.interp`，两端外推成端点值）。
  const filled: Float64Array[] = []
  for (let k = 0; k <= ord; k += 1) {
    const fp = valid.map((r) => (coeffs[r] as Float64Array)[k] as number)
    const col = new Float64Array(ny)
    for (let r = 0; r < ny; r += 1) col[r] = interp(r, valid, fp)
    filled.push(col)
  }
  const out = new Float64Array(ny * nx)
  const p = new Float64Array(ord + 1)
  for (let r = 0; r < ny; r += 1) {
    for (let k = 0; k <= ord; k += 1) p[k] = (filled[k] as Float64Array)[r] as number
    for (let c = 0; c < nx; c += 1) out[r * nx + c] = (img.data[r * nx + c] as number) - polyval(p, c)
  }
  return matOf(ny, nx, out)
}

/**
 * 属于**主** terrace 的像素 —— masked 逐行平场的拟合域。
 *
 * 主 terrace = 平滑后的高度直方图里最高的那个峰；半宽取
 * `max(3×粗糙度, 峰间距/3)`，于是既包住这一层的起伏，又够不到隔壁那一层。
 */
export function dominantTerraceMask(flat: Mat, roughness: number, separation: number): Uint8Array {
  const n = flat.rows * flat.cols
  const out = new Uint8Array(n)
  const v: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(flat.data[i] as number)) v.push(flat.data[i] as number)
  if (v.length === 0) return out.fill(1)
  const lo = percentile(v, 0.3)
  const hi = percentile(v, 99.7)
  if (!(hi > lo)) {
    for (let i = 0; i < n; i += 1) out[i] = Number.isFinite(flat.data[i] as number) ? 1 : 0
    return out
  }
  const h = histogram(v, 256, [lo, hi])
  const centers = new Float64Array(256)
  for (let i = 0; i < 256; i += 1) centers[i] = 0.5 * ((h.edges[i] as number) + (h.edges[i + 1] as number))
  const smooth = gaussianFilter1d(Float64Array.from(h.counts, (c) => c), 4)
  let am = 0
  for (let i = 1; i < smooth.length; i += 1) if ((smooth[i] as number) > (smooth[am] as number)) am = i
  const main = centers[am] as number
  const rough = Number.isFinite(roughness) ? roughness : 0
  const sep = Number.isFinite(separation) ? separation : 0
  const half = Math.max(3.0 * rough, sep > 0 ? sep / 3.0 : 0, 1e-13)
  for (let i = 0; i < n; i += 1) {
    const x = flat.data[i] as number
    out[i] = Number.isFinite(x) && Math.abs(x - main) < half ? 1 : 0
  }
  return out
}

/**
 * 每一行与下一行的相关系数。**数据太少的行给 `NaN`，不是 0。**
 *
 * 给 0 会把「这行没数据」和「这行与邻行完全不相关」混成一件事，
 * 而中位数会被前者拖低 —— 一张扫了一半的图会因此被标成「噪声帧」。
 *
 * ⚠️ 刻意**不用** `nanmean`/`nanstd`：一整行 NaN 会让它们每次都发一条
 * RuntimeWarning，而一批未完成的扫描于是把控制台埋掉 ——
 * 那些警告说的东西 `ok` 掩膜已经说过了。本仓照移这套「填 0 再按计数归一」的算法，
 * **因为它的浮点结果与 nanmean 那条路不同**（分母是 `cnt` 不是 `nx`）。
 */
export function rowCorrelation(img: Mat): Float64Array {
  const ny = img.rows
  const nx = img.cols
  if (ny < 2) return new Float64Array(0)
  const ok = new Uint8Array(ny)
  const cnt = new Float64Array(ny)
  const meanRow = new Float64Array(ny)
  const b = new Float64Array(ny * nx)
  const s = new Float64Array(ny)
  for (let r = 0; r < ny; r += 1) {
    let k = 0
    const filled = new Float64Array(nx)
    for (let c = 0; c < nx; c += 1) {
      const v = img.data[r * nx + c] as number
      const fin = Number.isFinite(v)
      if (fin) k += 1
      filled[c] = fin ? v : 0
    }
    ok[r] = k / nx > 0.5 ? 1 : 0
    cnt[r] = Math.max(k, 1)
    // `filled.sum(axis=1) / cnt` —— numpy 的 axis-1 是**成对求和**，走 `npSum`。
    meanRow[r] = npSum(filled) / (cnt[r] as number)
    const dev = new Float64Array(nx)
    const sq = new Float64Array(nx)
    for (let c = 0; c < nx; c += 1) {
      const v = img.data[r * nx + c] as number
      dev[c] = Number.isFinite(v) ? v - (meanRow[r] as number) : 0
      sq[c] = (dev[c] as number) * (dev[c] as number)
      b[r * nx + c] = dev[c] as number
    }
    s[r] = Math.sqrt(npSum(sq) / (cnt[r] as number)) + 1e-30
  }
  const out = new Float64Array(ny - 1)
  const prod = new Float64Array(nx)
  for (let r = 0; r + 1 < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) prod[c] = (b[r * nx + c] as number) * (b[(r + 1) * nx + c] as number)
    out[r] = npSum(prod) / (nx * (s[r] as number) * (s[r + 1] as number))
    if (!(ok[r] === 1 && ok[r + 1] === 1)) out[r] = NaN
  }
  return out
}

/**
 * 真正采到数据的那一段行 `[r0, r1)` —— **最长的连续「大部分像素有限」行段**。
 *
 * 为什么需要：未扫完的帧下半部是整片 NaN。把它填成中位数再交给
 * {@link detectTipChange}（它不吃 NaN），那片**人造的常数平台**会在边界上造出一个
 * 巨大的行 DC 跳变 —— 一个**由填充制造的「针尖突变」**。
 * 所以转发之前先把分析限制在采到的那一段上，并在结果里说明用了哪一段。
 */
export function acquiredRowSpan(img: Mat, minFiniteFrac = 0.5): [number, number] {
  const ny = img.rows
  const nx = img.cols
  if (ny === 0) return [0, 0]
  let best: [number, number] = [0, 0]
  let start: number | null = null
  for (let i = 0; i <= ny; i += 1) {
    let good = false
    if (i < ny) {
      let k = 0
      for (let c = 0; c < nx; c += 1) if (Number.isFinite(img.data[i * nx + c] as number)) k += 1
      good = k / nx > minFiniteFrac
    }
    if (good && start === null) start = i
    else if (!good && start !== null) {
      if (i - start > best[1] - best[0]) best = [start, i]
      start = null
    }
  }
  return best
}

/** `fine_periodic_peak` 的三样。 */
export interface FinePeak {
  readonly snr: number
  readonly periodNm: number
  readonly angleDeg: number
}

/**
 * 受限带 FFT 峰，对**局部 |q| 环背景**打分。
 *
 * ⚠️ **这只是色阶的触发器，不是「有没有晶格」的判据。** 那个判据在
 * {@link assessAtomicPhase} 里，它用角向集中度而不是峰强度 —— 峰强度实测分不开
 * 针尖抖动造出来的准周期条纹（30 个种子 30 个都能给出 SNR 15–38 的合格谱峰）。
 * 这里还留着它，是因为「要不要把色阶收紧」这个用途**容错得多**：
 * 判错的代价是色标略紧，而漏判会把真实的起伏压成一团。
 *
 * 两条扫描轴附近 ±`axisGuardDeg` 是**死区**：扫描线噪声与逐行平场恰好在轴上留下
 * 强脊。死区取 20° 而不是 12°，是因为 12° 下一张团簇图的纯条纹伪影仍能拿到
 * SNR 29.7（改成 20° 后降到 3.8，而真峰 22.8/45.6 不受影响）。
 * 代价是恰好沿扫描轴的周期结构会漏 —— **那只会让色阶宽一点，不会损坏数据。**
 */
export function finePeriodicPeak(img: Mat, nmPerPx: number, th: ScanPrepThresholds): FinePeak {
  const none: FinePeak = { snr: 0, periodNm: NaN, angleDeg: NaN }
  const ny = img.rows
  const nx = img.cols
  if (Math.min(ny, nx) < 16) return none
  if (!(nmPerPx !== 0 && Number.isFinite(nmPerPx) && nmPerPx > 0)) return none
  const finiteVals: number[] = []
  for (let i = 0; i < ny * nx; i += 1) if (Number.isFinite(img.data[i] as number)) finiteVals.push(img.data[i] as number)
  if (finiteVals.length === 0) return none
  const mu = npMean(finiteVals)
  const wy = hanning(ny)
  const wx = hanning(nx)
  const g = new Float64Array(ny * nx)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      const v = img.data[r * nx + c] as number
      const d = Number.isFinite(v) ? v - mu : 0
      g[r * nx + c] = d * (wy[r] as number) * (wx[c] as number)
    }
  }
  const spec = fft2(matOf(ny, nx, g))
  const cy = Math.floor(ny / 2)
  const cx = Math.floor(nx / 2)
  // fftshift 之后 (sy, sx) 的值来自 (sy−cy mod ny, sx−cx mod nx)。
  const magAt = (sy: number, sx: number): number => {
    const r = ((sy - cy) % ny + ny) % ny
    const c = ((sx - cx) % nx + nx) % nx
    const i = r * nx + c
    return Math.hypot(spec.re.data[i] as number, spec.im.data[i] as number)
  }
  const guard = th.axisGuardDeg
  const bandIdx: number[] = []
  const freqOf = new Float64Array(ny * nx)
  const periodOf = new Float64Array(ny * nx)
  const angleOf = new Float64Array(ny * nx)
  for (let sy = 0; sy < ny; sy += 1) {
    for (let sx = 0; sx < nx; sx += 1) {
      const fy = (sy - cy) / ny
      const fx = (sx - cx) / nx
      const freq = Math.hypot(fy, fx)
      const periodPx = freq > 0 ? 1.0 / Math.max(freq, 1e-30) : Infinity
      const periodNm = periodPx * nmPerPx
      // 角度取在**频率**空间 (fy, fx) 而不是像素索引空间：方帧上两者相同，
      // 矩形帧上只有前者是物理方向。
      const ang = (Math.atan2(fy, fx) * 180) / Math.PI
      const axisDist = Math.abs((((ang + 90.0) % 180.0) + 180.0) % 180.0 - 90.0)
      const i = sy * nx + sx
      freqOf[i] = freq
      periodOf[i] = periodNm
      angleOf[i] = ang
      if (
        periodNm >= th.finePeriodMinNm &&
        periodNm <= th.finePeriodMaxNm &&
        periodPx >= 3.0 &&
        axisDist > guard &&
        Math.abs(axisDist - 90.0) > guard
      ) {
        bandIdx.push(i)
      }
    }
  }
  if (bandIdx.length < 50) return none
  let pi = bandIdx[0] as number
  let pv = -Infinity
  for (const i of bandIdx) {
    const v = magAt(Math.floor(i / nx), i % nx)
    if (v > pv) {
      pv = v
      pi = i
    }
  }
  const fPeak = freqOf[pi] as number
  if (!(fPeak > 0)) return none
  const ringTol = Math.max(1.0 / Math.max(ny, nx), 0.08 * fPeak)
  const ring: number[] = []
  for (const i of bandIdx) {
    if (Math.abs((freqOf[i] as number) - fPeak) < ringTol) ring.push(magAt(Math.floor(i / nx), i % nx))
  }
  const bg = ring.length > 0 ? npMedian(ring) : 0
  if (!Number.isFinite(bg) || bg <= 0) return none
  return { snr: pv / bg, periodNm: periodOf[pi] as number, angleDeg: angleOf[pi] as number }
}

/** `height_levels` 的三样。 */
export interface HeightLevels {
  readonly nPeaks: number
  readonly separation: number
  readonly rowPurity: number
}

/**
 * 高度直方图上的能级（高度单位同输入）。
 *
 * `rowPurity` 是这一条的**全部价值**：在两个最强峰之间的谷底切一刀，问
 * **有多少行完全落在同一侧**（>95% 或 <5%）。真台阶横跨画面 ⇒ 大多数行同时含两个
 * 高度 ⇒ 纯度低；针尖突变 / z 漂移严格按行切 ⇒ 纯度高。
 * 只数峰会把后者当成台阶去保护，然后用宽色阶把真正的精细结构压没（实测：0004）。
 */
export function heightLevels(flat: Mat): HeightLevels {
  const none: HeightLevels = { nPeaks: 0, separation: 0, rowPurity: NaN }
  const n = flat.rows * flat.cols
  const v: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(flat.data[i] as number)) v.push(flat.data[i] as number)
  if (v.length <= 100) return none
  const lo = percentile(v, 0.3)
  const hi = percentile(v, 99.7)
  if (!(hi > lo)) return none
  const h = histogram(v, 256, [lo, hi])
  const centers = new Float64Array(256)
  for (let i = 0; i < 256; i += 1) centers[i] = 0.5 * ((h.edges[i] as number) + (h.edges[i + 1] as number))
  const smooth = gaussianFilter1d(Float64Array.from(h.counts, (c) => c), 4)
  let smax = -Infinity
  for (let i = 0; i < smooth.length; i += 1) smax = Math.max(smax, smooth[i] as number)
  const pk = findPeaks(smooth, { prominence: smax * 0.1, distance: 10 })
  const peaks = pk.peaks
  if (peaks.length <= 1) return { nPeaks: peaks.length, separation: 0, rowPurity: NaN }
  let cmin = Infinity
  let cmax = -Infinity
  for (let i = 0; i < peaks.length; i += 1) {
    const c = centers[peaks[i] as number] as number
    cmin = Math.min(cmin, c)
    cmax = Math.max(cmax, c)
  }
  // 最高的两个峰（`np.argsort` 稳定，等高时按下标序取后两个）。
  const order = Array.from(peaks, (_v, i) => i).sort((a, b) => {
    const va = smooth[peaks[a] as number] as number
    const vb = smooth[peaks[b] as number] as number
    return va === vb ? a - b : va - vb
  })
  const two = order.slice(-2).map((i) => peaks[i] as number).sort((a, b) => a - b)
  const pLo = two[0] as number
  const pHi = two[1] as number
  let vi = pLo
  for (let i = pLo; i <= pHi; i += 1) if ((smooth[i] as number) < (smooth[vi] as number)) vi = i
  const cut = centers[vi] as number
  const fracs: number[] = []
  for (let r = 0; r < flat.rows; r += 1) {
    let k = 0
    let up = 0
    for (let c = 0; c < flat.cols; c += 1) {
      const x = flat.data[r * flat.cols + c] as number
      if (!Number.isFinite(x)) continue
      k += 1
      if (x > cut) up += 1
    }
    if (k > 10) fracs.push(up / k)
  }
  const purity = fracs.length > 0 ? npMean(fracs.map((f) => (f < 0.05 || f > 0.95 ? 1 : 0))) : NaN
  return { nPeaks: peaks.length, separation: cmax - cmin, rowPurity: purity }
}

// ═══════════════════════════════════════════════════════════════════════
// 一帧的全部测量
// ═══════════════════════════════════════════════════════════════════════

/**
 * 一帧上量到的全部东西。
 *
 * 单位约定：高度类的量以**输入数组的单位**为准（`.sxm` 的 Z 通道是米），
 * 带 `Pm` 后缀的字段已换算成皮米。
 */
export interface FrameMetrics {
  readonly shape: readonly [number, number]
  readonly nmPerPx: number | null
  readonly nanFrac: number
  readonly deadRows: number
  /** 实际参与转发判据的行段 `[r0, r1)` —— 见 {@link acquiredRowSpan}。 */
  readonly analysisRows: readonly [number, number]

  readonly planeRmsPm: number
  readonly lineGain: number
  readonly bowGain: number
  readonly roughnessPm: number

  readonly nPeaks: number
  readonly stepSepPm: number
  readonly sepOverRough: number
  readonly rowPurity: number

  readonly finePeriodicSnr: number
  readonly finePeriodNm: number
  readonly fineAngleDeg: number

  readonly rowcorrMedian: number

  /** 转发 {@link assessAtomicPhase}。`null` = 没算成。 */
  readonly atomic: AtomicDigest | null
  /** 转发 {@link detectTipChange}。 */
  readonly tipChange: TipChangeDigest | null
  /** 转发 {@link detectScanArtifacts}。 */
  readonly artifacts: ArtifactsDigest | null
  /** 转发 {@link fwdBwdInstability}。 */
  readonly fbInstability: number | null

  /** 哪些转发判据没算成，以及为什么。空 = 全都算了。 */
  readonly delegateErrors: Readonly<Record<string, string>>

  /** 内部量：masked 逐行平场要用（单位同输入）。 */
  readonly roughness: number
  readonly separation: number
}

/** 转发给模型的原子相摘要（旧仓在 `_atomic()` 里现摆的那个 dict）。 */
export interface AtomicDigest {
  readonly passed: boolean
  readonly scale: string | null
  readonly period_fast_axis_nm: number | null
  readonly period_radial_nm: number | null
  readonly angular_concentration: number
  readonly fft_sharpness: number
  readonly snr: number
  readonly reasons: readonly string[]
  readonly warnings: readonly string[]
}

/** 转发给模型的针尖突变摘要。 */
export interface TipChangeDigest {
  readonly changed: boolean
  readonly change_row: number | null
  readonly score: number
  readonly threshold: number
  readonly lod: number | null
  readonly calib: string
  readonly channel_scores: Readonly<Record<string, number>>
}

/** 转发给模型的伪影摘要。 */
export interface ArtifactsDigest {
  readonly has_artifact: boolean
  readonly oscillation: boolean
  readonly oscillation_severity: number
  readonly drift_px: number | null
  readonly bad_row_frac: number
  readonly spike_frac: number
}

/**
 * 量一帧。**纯函数**：不读文件、不读配置、不碰硬件。
 *
 * `z` 是正扫，`bwd` 是**已经镜像回来**的反扫 —— 不镜像的话正反扫比较是拿一张图
 * 和它自己的镜像比。
 *
 * ⚠️ 三件必须按这个顺序发生，换一个顺序就换了判据：
 * ① 粗糙度走**均值**滤波高通（中值滤波会让残差出现大量精确的 0，MAD 塌成 0，
 * 实测 13 张里精确零占 10%–48%、粗糙度被低估到 1/18，于是**每一帧都成了「有台阶」**）；
 * ② 转发判据之前先把分析限制在 {@link acquiredRowSpan} 那一段；
 * ③ `tipChange.change_row` 要**换算回整帧坐标**（报告里的行号必须能对上原图）。
 */
export function measureFrame(
  z: Mat,
  opts: { bwd?: Mat | null; nmPerPx?: number | null; thresholds: ScanPrepThresholds },
): FrameMetrics {
  const th = opts.thresholds
  const bwd = opts.bwd ?? null
  const nmPerPx = opts.nmPerPx ?? null
  const ny = z.rows
  const nx = z.cols
  const n = ny * nx
  let nFinite = 0
  const finiteMask = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(z.data[i] as number)) {
      finiteMask[i] = 1
      nFinite += 1
    }
  }
  const nanFrac = 1.0 - nFinite / n
  let deadRows = 0
  for (let r = 0; r < ny; r += 1) {
    let any = false
    for (let c = 0; c < nx; c += 1) if (finiteMask[r * nx + c] === 1) any = true
    if (!any) deadRows += 1
  }

  const plane = polySubtract(z, 1)
  const poly2 = polySubtract(z, 2)
  const lined = lineSubtract(z, 1)
  const anyFinite = nFinite > 0
  const sPlane = anyFinite ? nanStd(plane.data) : 0
  const sPoly2 = anyFinite ? nanStd(poly2.data) : 0
  const sLine = anyFinite ? nanStd(lined.data) : 0

  // 像素级粗糙度：**均值**滤波高通（见函数抬头 ①）。
  const masked = new Float64Array(n)
  for (let i = 0; i < n; i += 1) masked[i] = finiteMask[i] === 1 ? (plane.data[i] as number) : NaN
  const smoothed = uniformFilter2d(matOf(ny, nx, masked), 1, 9)
  const hp = new Float64Array(n)
  for (let i = 0; i < n; i += 1) hp[i] = (plane.data[i] as number) - (smoothed.data[i] as number)
  const roughRaw = mad(hp)
  const rough = Number.isFinite(roughRaw) ? roughRaw : 0

  const levels = heightLevels(plane)
  const sep = levels.separation

  const errors: Record<string, string> = {}
  const [r0, r1] = acquiredRowSpan(z)
  const span = r1 > r0 ? sliceRows(lined, r0, r1) : lined
  let spanBwd: Mat | null = null
  if (bwd !== null) {
    if (bwd.rows === ny && bwd.cols === nx) {
      const lb = lineSubtract(bwd, 1)
      spanBwd = r1 > r0 ? sliceRows(lb, r0, r1) : lb
    } else {
      errors['fb_instability'] = `正反扫形状不一致: (${ny}, ${nx}) vs (${bwd.rows}, ${bwd.cols})`
    }
  }

  let atomic: AtomicDigest | null = null
  if (nmPerPx !== null && nmPerPx !== 0) {
    atomic = safeDelegate('atomic', errors, (): AtomicDigest => {
      const res: AtomicPhaseResult = assessAtomicPhase(span, { nmPerPx })
      return {
        passed: res.passed,
        scale: res.scale,
        period_fast_axis_nm: res.periodFastAxisNm,
        period_radial_nm: res.periodNm,
        angular_concentration: res.angularConcentration,
        fft_sharpness: res.fftSharpness,
        snr: res.snr,
        reasons: res.reasons,
        warnings: res.warnings,
      }
    })
  } else {
    errors['atomic'] = '没有像素尺度(nm/px),任何「有没有原子相」的结论都没有根据'
  }

  const tipChange = safeDelegate('tip_change', errors, (): TipChangeDigest => {
    const res: TipChange = detectTipChange(fillNaN(span), { nmPerPx })
    return {
      changed: res.changed,
      // 行号换算回**整帧**坐标 —— 报告里的行号必须能对上原图。
      change_row: res.changeRow === null ? null : res.changeRow + r0,
      score: res.score,
      threshold: res.threshold,
      lod: res.lod,
      calib: res.calib,
      channel_scores: res.channelScores,
    }
  })

  const artifacts = safeDelegate('artifacts', errors, (): ArtifactsDigest => {
    const res: ScanArtifacts = detectScanArtifacts(fillNaN(span), spanBwd === null ? null : fillNaN(spanBwd))
    return {
      has_artifact: res.hasArtifact,
      oscillation: res.oscillation,
      oscillation_severity: res.oscillationSeverity,
      drift_px: res.driftPx,
      bad_row_frac: res.badRowFrac,
      spike_frac: res.spikeFrac,
    }
  })

  let fb: number | null = null
  if (spanBwd !== null) {
    // ⚠️ 直接用 `fwdBwdInstability`，**不**走 `assess_tip_classical`：后者开头的
    // `std < 1e-9` 早退守卫是按无量纲 / pm 输入写的，而 `.sxm` 的 Z 通道是米
    // （典型 std ≈ 1e−10 m）—— 参考系统的一组帧全部早退，这个量恒为 `None`；
    // 该观测尚未在本仓独立验证。
    // 这个量自带归一化，与量纲无关。
    fb = safeDelegate('fb_instability', errors, () => fwdBwdInstability(fillNaN(span), fillNaN(spanBwd as Mat)))
  }

  const peak = finePeriodicPeak(lined, nmPerPx ?? 0, th)
  const rc = rowCorrelation(lined)
  let rcMed = NaN
  if (rc.length > 0) {
    let anyF = false
    for (let i = 0; i < rc.length; i += 1) if (Number.isFinite(rc[i] as number)) anyF = true
    if (anyF) rcMed = nanMedian(rc)
  }

  return {
    shape: [ny, nx],
    nmPerPx: nmPerPx !== null && nmPerPx !== 0 ? nmPerPx : null,
    nanFrac,
    deadRows,
    analysisRows: [r0, r1],
    planeRmsPm: sPlane * 1e12,
    lineGain: sLine > 0 ? sPlane / sLine : 1.0,
    bowGain: sPoly2 > 0 ? sPlane / sPoly2 : 1.0,
    roughnessPm: rough * 1e12,
    nPeaks: levels.nPeaks,
    stepSepPm: sep * 1e12,
    sepOverRough: rough > 0 ? sep / rough : 0,
    rowPurity: levels.rowPurity,
    finePeriodicSnr: peak.snr,
    finePeriodNm: peak.periodNm,
    fineAngleDeg: peak.angleDeg,
    rowcorrMedian: rcMed,
    atomic,
    tipChange,
    artifacts,
    fbInstability: fb,
    delegateErrors: errors,
    roughness: rough,
    separation: sep,
  }
}

/** 跑一个转发判据；失败**只记一行**，绝不把整个分析拖垮。 */
function safeDelegate<T>(name: string, errors: Record<string, string>, fn: () => T): T | null {
  try {
    return fn()
  } catch (e) {
    const err = e as Error
    errors[name] = `${err.name}: ${err.message}`
    return null
  }
}

/** 取 `[r0, r1)` 那几行。 */
function sliceRows(m: Mat, r0: number, r1: number): Mat {
  const out = new Float64Array((r1 - r0) * m.cols)
  for (let r = r0; r < r1; r += 1) {
    for (let c = 0; c < m.cols; c += 1) out[(r - r0) * m.cols + c] = m.data[r * m.cols + c] as number
  }
  return matOf(r1 - r0, m.cols, out)
}

/** `_fill` —— 把 NaN 换成有限像素的中位数（全非有限时换 0）。 */
export function fillNaN(m: Mat): Mat {
  let anyNan = false
  for (let i = 0; i < m.data.length; i += 1) if (!Number.isFinite(m.data[i] as number)) anyNan = true
  if (!anyNan) return m
  const med = nanMedian(m.data)
  const sub = Number.isFinite(med) ? med : 0
  const out = new Float64Array(m.data.length)
  for (let i = 0; i < out.length; i += 1) {
    const v = m.data[i] as number
    out[i] = Number.isFinite(v) ? v : sub
  }
  return matOf(m.rows, m.cols, out)
}

// ═══════════════════════════════════════════════════════════════════════
// 决策
// ═══════════════════════════════════════════════════════════════════════

/** 一帧的处理方案 + 为什么。`why` 是决策依据，`notes` 是给人的提醒。 */
export interface FlattenPlan {
  readonly method: string
  readonly clip: readonly [number, number]
  readonly why: readonly string[]
  readonly notes: readonly string[]
  readonly stepLike: boolean
  readonly fineStructure: boolean
  readonly profile: string
  readonly provenance: string
}

/**
 * Python 的 `f"{x:.Nf}"`（四舍六入五成双）。走 `kernel` 的 `pyFixed`，不另写第二份。
 *
 * ⚠️ 非有限值单列：Python 的 `f"{nan:.2f}"` 给 `'nan'`、`f"{inf:.2f}"` 给 `'inf'`。
 * 而 `row_purity` **本来就可能是 NaN**（一个只有一个高度峰的帧），
 * 于是 `'nan'` 这三个字母真的会印进报告 —— 那是诚实的。
 */
function fx(x: number, d: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  // ⚠️ **负零**：Python 的 `f"{-0.0:.1f}"` 给 `'-0.0'`，而 `kernel` 的 `pyFixed` 给 `'0.0'`
  // （JS 的 `toFixed` 判 `x < 0`，而 `-0 < 0` 是假）。`round(s, 3)` 把一个很小的负数
  // 变成 `-0` 之后，这一格就印在报文里 —— 「最接近的通道是 `dc`(-0.0)」。
  // 这是 `formatG` 早就处理过的同一件事（`coverage-gaps.test.ts`：`formatG(-0, 6) === '-0'`），
  // 而 `pyFixed` 漏了。**本批不改 kernel 那一份**（共享文件，波及别人的金样），
  // 交接里写成一条给主线的欠账。
  if (Object.is(x, -0)) return `-${pyFixed(0, d)}`
  return pyFixed(x, d)
}

/** `f"{x:.0%}"` / `f"{x:.1%}"` —— 乘 100 再定点，带 `%`。 */
function pct(x: number, d: number): string {
  return `${fx(x * 100, d)}%`
}

/** 测量 → 处理方案 + 人能读的依据。 */
export function planFor(
  m: FrameMetrics,
  th: ScanPrepThresholds,
  override: string | null = null,
): FlattenPlan {
  const why: string[] = []
  const notes: string[] = []

  const multilevel = m.nPeaks >= th.stepPeaks && m.sepOverRough > th.stepSep
  const rowSplit = Number.isFinite(m.rowPurity) && m.rowPurity > th.stepPurity
  const stepLike = multilevel && !rowSplit
  const curved = m.bowGain > th.bowGain
  const needsLine = m.lineGain > th.lineGain
  const fine = m.finePeriodicSnr > th.finePeriodicSnr

  if (multilevel && rowSplit) {
    notes.push(
      `直方图上有两个高度能级,但 ${pct(m.rowPurity, 0)} 的行整行落在其中一个上 —— ` +
        `这是**行向分层**(针尖突变或 z 漂移),不是台阶边缘。所以按普通帧平掉,` +
        `而不是当台阶保护起来(保护它会顺带用宽色阶把精细结构压没)。`,
    )
  }

  let method: string
  let clip: readonly [number, number]
  if (override !== null && override !== '' && override !== 'auto') {
    if (!METHODS.includes(override)) {
      throw new RangeError(`未知的 flatten 方式 '${override}',可选 ${METHODS.join(', ')}`)
    }
    method = override
    why.push(`处理方式由调用方指定为 \`${method}\`(${METHOD_LABEL[method] as string}),自动判定被跳过`)
  } else if (stepLike && needsLine) {
    method = 'masked_line'
    why.push(
      `有台阶(${m.nPeaks} 个高度峰,间距 ${fx(m.sepOverRough, 1)} 倍粗糙度,` +
        `行纯度 ${fx(m.rowPurity, 2)} ≤ ${g(th.stepPurity)})且行间漂移显著` +
        `(line_gain ${fx(m.lineGain, 2)} > ${g(th.lineGain)}) → 每一行只在主 terrace 上` +
        `拟合,台阶才活得下来`,
    )
  } else if (stepLike) {
    method = curved ? 'poly2' : 'plane'
    why.push(
      `有台阶(${m.nPeaks} 个峰,${fx(m.sepOverRough, 1)} 倍粗糙度)但各行本来就平` +
        `(line_gain ${fx(m.lineGain, 2)} < ${g(th.lineGain)}) → 保守处理,只` +
        `${METHOD_LABEL[method] as string}`,
    )
  } else if (needsLine) {
    method = 'line'
    why.push(
      `单一平坦区域,行间漂移占主导(line_gain ${fx(m.lineGain, 2)} > ` + `${g(th.lineGain)}) → 逐行一阶平场`,
    )
  } else if (curved) {
    method = 'poly2'
    why.push(`面是弯的(bow_gain ${fx(m.bowGain, 2)} > ${g(th.bowGain)},压电弯曲/蠕变) → 基线改用二阶曲面`)
  } else {
    method = 'plane'
    why.push(`扣平面之后已经够平(line_gain ${fx(m.lineGain, 2)},bow_gain ${fx(m.bowGain, 2)}) → 只扣平面`)
  }

  // ── 色阶：**精细结构优先于台阶** ──
  // 分辨出来的精细起伏是更稀有的收获，而宽色阶会把它压成一团；
  // 台阶高度即使被压，也还能从 `stepSepPm` 这个数字读到。
  if (fine) {
    clip = [th.clipLatticeLo, th.clipLatticeHi]
    why.push(
      `带内有周期 ${fx(m.finePeriodNm, 3)} nm 的精细结构(受限带 FFT 峰对局部环` +
        `背景 SNR ${fx(m.finePeriodicSnr, 0)} > ${g(th.finePeriodicSnr)}) → 色阶收紧到 ` +
        `${g(clip[0])}–${g(clip[1])} 百分位,把起伏展开`,
    )
  } else if (stepLike) {
    clip = [th.clipStepLo, th.clipStepHi]
    why.push(`色阶放宽到 ${g(clip[0])}–${g(clip[1])} 百分位,保住 ${fx(m.stepSepPm, 0)} pm 的台阶高度`)
  } else {
    clip = [th.clipDefaultLo, th.clipDefaultHi]
    why.push(`无精细周期结构、无台阶 → 默认色阶 ${g(clip[0])}–${g(clip[1])} 百分位`)
  }

  for (const nline of frameNotes(m, th, fine)) notes.push(nline)
  return {
    method,
    clip,
    why,
    notes,
    stepLike,
    fineStructure: fine,
    profile: th.name,
    provenance: th.provenance,
  }
}

/**
 * Python 在 f-string 里对一个 float 的默认写法 —— `str(x)`，而 Python 3 的
 * `str(float)` 就是 `repr(float)`。于是 `str(2.0)` 是 `'2.0'` 而 JS 的
 * `String(2.0)` 是 `'2'`。**这些数会印在给模型看的依据里**，走 `pyFloatRepr`。
 */
function g(v: number): string {
  return pyFloatRepr(v)
}

/**
 * 值得告诉人的事。**关于样品 / 针尖的结论一律用转发判据的原话。**
 *
 * 这是本模块的产品之一：`plan_for` 决定怎么处理，这里决定**说什么**。
 * 三条纪律：
 *
 * 1. **原子相是三态** —— 有 / 没有 / **判不了**。`scale_gate` 与
 *    `unknown_pixel_size` 那一支的措辞是「**判不了**,不是「没有」」，
 *    而且它会顺带说清「受限带 FFT 里确实有周期结构，那只够决定色阶」；
 * 2. **针尖突变的否定要带 `lod`** —— 「没检出」加上「这一帧本可以看见 ≥ lod」
 *    才是一句可证伪的话，还要提醒那个阈值**故意吝啬**（它要能中止一次十分钟的扫描）；
 * 3. **正反扫一致那一句要带口径** —— 那个量用的是允许横向位移的互相关，
 *    已经补偿了压电迟滞造成的快轴偏移；零位移的裸相关在真机上会饱和。
 */
export function frameNotes(m: FrameMetrics, th: ScanPrepThresholds, fine: boolean): string[] {
  const notes: string[] = []

  if (m.nanFrac > th.nanAnnotate) {
    notes.push(
      `扫描未完成:${pct(m.nanFrac, 0)} 的画面没有采到(${m.deadRows} 个空行)。` +
        (m.analysisRows[1] - m.analysisRows[0] < m.shape[0]
          ? `下面的判据只在第 ${m.analysisRows[0]}–${m.analysisRows[1]} 行(真正采到的那一段)上算。`
          : ''),
    )
  }

  const a = m.atomic
  if (a !== null) {
    if (a.passed) {
      notes.push(
        `原子相判据通过(mast.vision.atomic_phase):快扫方向周期 ` +
          `${fx(a.period_fast_axis_nm ?? NaN, 3)} nm,角向集中度 ${fx(a.angular_concentration, 0)}。` +
          `引用晶格常数请用快轴这个数 —— 径向周期 ` +
          `${fx(a.period_radial_nm ?? NaN, 3)} nm 会被慢轴漂移拉偏。`,
      )
    } else if (a.reasons.includes('scale_gate') || a.reasons.includes('unknown_pixel_size')) {
      notes.push(
        `原子相**判不了**,不是「没有」:像素尺度 ` +
          `${fx(m.nmPerPx ?? NaN, 4)} nm/px 在尺度门之外(reasons=${pyList(a.reasons)})。` +
          `要结论就换更小的视野再扫一帧。` +
          (fine
            ? ` 顺带一提,受限带 FFT 里确实有周期 ${fx(m.finePeriodNm, 3)} nm 的` +
              `结构(SNR ${fx(m.finePeriodicSnr, 0)}) —— 那只够用来决定色阶,` +
              `不足以支持「有原子分辨」。`
            : ''),
      )
    } else if (fine) {
      notes.push(
        `受限带 FFT 里有周期 ${fx(m.finePeriodNm, 3)} nm 的结构` +
          `(SNR ${fx(m.finePeriodicSnr, 0)},只用于色阶),但原子相判据**没过**` +
          `(reasons=${pyList(a.reasons)}) —— 峰强度分不开针尖抖动造出的准周期条纹,` +
          `以 atomic_phase 的结论为准。`,
      )
    }
  } else if (fine) {
    notes.push(
      `受限带 FFT 里有周期 ${fx(m.finePeriodNm, 3)} nm 的结构` +
        `(SNR ${fx(m.finePeriodicSnr, 0)})。**这只用来决定色阶**;` +
        `原子相判据没跑成(${m.delegateErrors['atomic'] ?? '未知原因'}),所以不能说这是晶格。`,
    )
  }

  const tc = m.tipChange
  if (tc !== null) {
    if (tc.changed) {
      notes.push(
        `扫描中途针尖变了(mast.vision.tip_change v2:校准 z ${fx(tc.score, 1)} ` +
          `> 阈 ${fx(tc.threshold, 1)},${tc.calib}),大约在第 ` +
          `${tc.change_row} 行。这一行以下是另一根针尖成的像,定量分析前先裁掉。`,
      )
    } else if (tc.lod !== null) {
      const scores = Object.entries(tc.channel_scores)
      let best: [string, number] | null = null
      for (const [k, v] of scores) if (best === null || v > best[1]) best = [k, v]
      notes.push(
        `没检出针尖突变(校准 z ${fx(tc.score, 1)} < 阈 ${fx(tc.threshold, 1)}),` +
          `而这一帧本可以看见 ≥ ${g3(tc.lod)}(输入单位)的行 DC 跳变。` +
          (best !== null ? `最接近的通道是 \`${best[0]}\`(${fx(best[1], 1)})。` : '') +
          '注意这个默认阈值是实测 FPR≈1% 的工作点,**故意吝啬**' +
          '(它要能中止一次十分钟的扫描),所以幅度/噪声型的变化可能压在阈下。',
      )
    }
  }

  if (Number.isFinite(m.rowcorrMedian) && m.rowcorrMedian < th.rowcorrPoor) {
    notes.push(`噪声帧:相邻行相关中位数只有 ${fx(m.rowcorrMedian, 2)}`)
  }

  const art = m.artifacts
  if (art !== null) {
    if (art.bad_row_frac > th.badRowFracAnnotate) {
      notes.push(`${pct(art.bad_row_frac, 1)} 的扫描线受扰(mast.vision.scan_artifacts)`)
    }
    if (art.oscillation) {
      notes.push(
        `反馈振荡:轴上谱峰强度 ${fx(art.oscillation_severity, 1)}(mast.vision.scan_artifacts) —— 调 Z 控制器增益`,
      )
    }
  }

  if (m.fbInstability !== null) {
    if (m.fbInstability < th.fbInstabilityMax) {
      notes.push(`正反扫一致(不稳定度 ${fx(m.fbInstability, 2)} < ${g(th.fbInstabilityMax)}):图上的结构是真的`)
    } else {
      notes.push(
        `正反扫不一致(不稳定度 ${fx(m.fbInstability, 2)} ≥ ${g(th.fbInstabilityMax)}) —— 细节存疑。` +
          `(这个量用的是允许横向位移的互相关,已经补偿了压电迟滞造成的` +
          `快轴偏移;零位移的裸相关在真机上会饱和,不能拿来判。)`,
      )
    }
  }

  for (const [name, err] of Object.entries(m.delegateErrors)) {
    notes.push(`判据 \`${name}\` 没跑成:${err}`)
  }
  return notes
}

/** Python 的 `f"{x:.3g}"`。 */
function g3(v: number): string {
  return formatG(v, 3)
}

/** Python 的 `str(list_of_str)` —— `['a', 'b']`。 */
function pyList(xs: readonly string[]): string {
  return `[${xs.map((s) => `'${s}'`).join(', ')}]`
}

/** 减去每行的中位数（NaN 安全）。 */
export function rowMedianLevel(a: Mat): Mat {
  const out = Float64Array.from(a.data)
  for (let r = 0; r < a.rows; r += 1) {
    const vals: number[] = []
    for (let c = 0; c < a.cols; c += 1) {
      const v = a.data[r * a.cols + c] as number
      if (Number.isFinite(v)) vals.push(v)
    }
    if (vals.length === 0) continue
    const med = npMedian(vals)
    for (let c = 0; c < a.cols; c += 1) out[r * a.cols + c] = (out[r * a.cols + c] as number) - med
  }
  return matOf(a.rows, a.cols, out)
}

/**
 * 把选定的处理方式施加到一帧上。
 *
 * ⚠️ `masked_line` 的主 terrace 是从**去掉逐行偏置之后**的图上找的。理由：
 * masked_line 只在「有台阶 AND 行漂移显著」时才被选中，而行漂移一旦大过台阶高度，
 * 扣平面残差的高度直方图就被漂移糊掉，「最高的那个峰」选出来的是**漂移的中位数**
 * 而不是主 terrace —— 掩膜于是选中一堆跨越两个能级的像素，拟合被台阶带偏，
 * 台阶反而被削掉。合成实测：1 nm 量级的行漂移下，不去偏置的掩膜让重建残差
 * 从 5 pm 涨到 **148 pm**。
 *
 * 掩膜**只用来挑参与拟合的像素**，真正的修正仍然拟合在原图上，
 * 所以这一步不会把台阶洗掉。
 */
export function applyFlatten(z: Mat, method: string, m: FrameMetrics): Mat {
  if (method === 'plane') return polySubtract(z, 1)
  if (method === 'poly2') return polySubtract(z, 2)
  if (method === 'line') return lineSubtract(z, 1)
  if (method === 'masked_line') {
    const base = rowMedianLevel(polySubtract(z, 1))
    return lineSubtract(z, 1, dominantTerraceMask(base, m.roughness, m.separation))
  }
  throw new RangeError(`未知的 flatten 方式 '${method}',可选 ${METHODS.join(', ')}`)
}

// ═══════════════════════════════════════════════════════════════════════
// 批次一致性
// ═══════════════════════════════════════════════════════════════════════

/**
 * 同一组图按多数票统一处理方式。`items` 是 `[(分组键, 方案), …]`。
 *
 * **为什么要这件事**：两帧之间的对比度差异必须来自**样品**。同尺寸同偏压的一组图里，
 * 一张扣平面、另一张逐行平场，看图的人会读成样品变了。
 *
 * ⚠️ **有真台阶的帧豁免** —— 它们要的是保护性处理（`masked_line`），被多数票剥掉
 * 就等于把台阶平掉。它们**也不参与投票**：一张台阶帧的 `lineGain` 反映的是台阶，
 * 不是行漂移。
 */
export function harmoniseBatch(
  items: readonly (readonly [string, FlattenPlan])[],
  th: ScanPrepThresholds,
): FlattenPlan[] {
  const out = items.map(([, p]) => p)
  const groups = new Map<string, number[]>()
  items.forEach(([key], i) => {
    const g0 = groups.get(key)
    if (g0 === undefined) groups.set(key, [i])
    else g0.push(i)
  })
  for (const [key, idx] of groups) {
    // ⚠️ 这两道里**只有第二道在做决定**：`free ⊆ idx`，所以
    // `free.length >= groupMin` 蕴含 `idx.length >= groupMin` —— 第一道
    // 拆掉一个字都不变（演练照此把变异打在第二道上，同 green-8 §2.8）。
    // **不删它**：它是旧仓那两句的逐字照移，而「这一组一共几张」与
    // 「其中几张可投票」是两个会被人分别改动的量。
    if (idx.length < th.groupMin) continue
    const free = idx.filter((i) => !(out[i] as FlattenPlan).stepLike)
    if (free.length < th.groupMin) continue
    const methods = free.map((i) => (out[i] as FlattenPlan).method)
    // `max(set(methods), key=methods.count)` —— 平局时 CPython 取 set 迭代序里
    // 先出现的那个。本仓按**首次出现的顺序**取，这是两边唯一可复现的口径
    // （集合迭代序在 CPython 里由哈希定，不是语言保证）。见 deviations。
    const counts = new Map<string, number>()
    for (const mth of methods) counts.set(mth, (counts.get(mth) ?? 0) + 1)
    let winner = methods[0] as string
    let nWin = 0
    for (const [mth, c] of counts) {
      if (c > nWin) {
        winner = mth
        nWin = c
      }
    }
    if (nWin === methods.length) continue
    for (const i of free) {
      const p = out[i] as FlattenPlan
      if (p.method === winner) continue
      out[i] = {
        ...p,
        method: winner,
        why: [
          ...p.why,
          `批次一致性:改用 \`${winner}\`(${METHOD_LABEL[winner] as string}) —— ` +
            `分组 ${key} 里 ${free.length} 张可投票的帧中有 ${nWin} 张选了它。` +
            `打算互相比较的图必须用同一种处理,否则对比度差异会被读成样品变了。`,
        ],
      }
    }
  }
  return out
}

/** 报告尾部那行「判据阈值:…」—— `sorted(numeric_mapping().items())` 的 `%g`。 */
export function thresholdLine(th: ScanPrepThresholds): string {
  const entries = Object.entries(scanPrepNumericMapping(th)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.map(([k, v]) => `\`${k}\`=${formatG(v, 6)}`).join(', ')
}
