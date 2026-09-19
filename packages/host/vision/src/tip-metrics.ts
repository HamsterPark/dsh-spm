/**
 * `mast/vision/tip_metrics.py` 的四件：`_detrend`（去行中值 + 去平面，**结果是
 * float32**）· `_fft_sharpness` · `_edge_resolution` · `_fwd_bwd_instability`。
 *
 * > **来处**：后两件（含它们的容差与 `edgeResolution` 的两档）由批 6c 落在
 * > `stm-skills/src/l0/vision-tip-metrics.ts`（那一轮本包由批 6b 主用），
 * > 由收尾支线按批 6c 交接 §8 搬来并**并进本文件**。
 * >
 * > ⚠️ 合并时撞上**两份 `fwdBwdInstability`**（批 6b 也往本文件加了一份）。
 * > 它们**不是同一条判据**，处置与证据见本抬头最后一节。
 *
 * ## 这两件的精度**是它们语义的一部分**
 *
 * 批 4a 那一课（D-VISION-3）在这里第二次出现，而且更彻底：
 *
 * | | 旧仓做什么 | 本仓做什么 |
 * |---|---|---|
 * | `_detrend` 的返回 | `.astype(np.float32)` | {@link detrend32} 每个元素 `Math.fround` |
 * | `_detrend(h) / std` | float32 数组 ÷ **Python 标量** ⇒ NEP 50 弱标量 ⇒ **仍是 float32** | 逐元素 `fround` |
 * | `np.fft.fft2(float32)` | **complex64** —— 整个 FFT 在单精度里做 | **float64**，见下 |
 *
 * ⇒ 前两条照抄得了，第三条**照抄不了**：复现单精度 pocketfft 要把每一次蝶形运算
 * 都降到 float32，而本仓的 `fft2` 是 float64 的。所以这里**只**把输入降到 float32，
 * 变换本身留在 float64，并把差额写成一条推得出来的容差（{@link fftSharpnessRelTol}）。
 *
 * ### 容差：`8 · eps32 · sharp`（相对），而这个 `sharp` 出现在自己的容差里
 *
 * 推导：单精度 FFT 的本底噪声约 `eps32 · max|F|`（每个 bin 的绝对误差与**整幅谱的
 * 最大值**挂钩，不与这个 bin 自己挂钩 —— 相消毁掉相对精度那条的另一面）。
 * 而 `sharp = peak / median`，也就是 `median ≈ peak / sharp`，于是
 *
 * ```
 * Δmedian / median ≈ eps32·peak / (peak/sharp) = eps32 · sharp
 * ```
 *
 * 取 8 倍余量。**它随 sharp 线性放大**，所以一张锐得离谱的帧（`sharp ≈ 5234`）
 * 容差是 `5e−3`，而一张噪声帧（`sharp ≈ 3.6`）容差是 `3e−6`。
 * 这正是该有的形状：判据是 `sharp < 8`，**而紧的那一档正好落在闸门附近**。
 *
 * 实测（本机，金样**十一格**）：最坏 `1.6e−3`，占容差 `0.32`；
 * 而离闸门最近的一格（`noise`，**3.559**，闸门 8.0）余量 **2.2 倍**，容差只占那段余量的 `1.5e−6`。
 *
 * ## `_edge_resolution` / `_fwd_bwd_instability` 那条链**整条都在 float32 里**
 *
 * 上面那张表在这两件上更长一截：
 *
 * | 步 | 旧仓 | 本仓 |
 * |---|---|---|
 * | `judge_frame.detrended` | `.astype(np.float32)` | 一样（{@link detrend} 逐元素 `fround`） |
 * | `hn = h / std` | float32 ÷ **Python 弱标量** ⇒ 仍是 float32 | 逐元素 `fround` |
 * | `ndi.gaussian_filter(hn, 1.0)` | scipy **保留 dtype** ⇒ float32 | float64 |
 * | `np.gradient` / `np.hypot` | float32 | float64 |
 * | `np.percentile` / `np.median` | float32 | float64 |
 * | `np.fft.fft2(float32)` | numpy ≥ 2.0 回 **complex64** | float64 |
 *
 * 前两条照抄得了，后面几条照抄不了（复现单精度 pocketfft 与 scipy 的单精度
 * `correlate1d` 要把每一次乘加都降到 float32，而本仓的滤波与 FFT 是 float64 的）。
 * 于是差额写成推得出来的容差：{@link EDGE_RESOLUTION_REL_TOL} 与 {@link instabilityAbsTol}。
 *
 * ## ⚠️ `edgeResolution` 有**两档**容差，因为它有两种入口
 *
 * | 入口 | `hn` 是什么 | 容差 | 实测占比 |
 * |---|---|---|---|
 * | 技能（`AssessTipSharpness`） | `judgeFrame` 的 float32 残差 ÷ float32 的 std | {@link EDGE_RESOLUTION_REL_TOL}（`16·eps32`） | **0.032** |
 * | 判据本体（金样的 `edge_resolution` 节） | 导出器直接喂的 **float64** 数组 ⇒ scipy 全程 float64 | {@link EDGE_RESOLUTION_F64_TOL}（`64·eps`） | **0.028** |
 *
 * 第二档不能沿用第一档：`16·eps32` 在一条 float64 的链上留了**五十亿倍**余量
 * （实测占 `2e−10`），那样的断言等于没写。
 * 「一条容差要么推得出来，要么就别写」的另一面是：**推得出来的那条要配对入口**。
 *
 * `fwd_bwd_instability` 没有这个问题 —— 它自己内部就会把两帧降到 float32
 * （`detrend`），无论调用方喂什么。实测最坏占 **0.0045**（技能路径）/ **0.0023**（判据本体）。
 *
 * ## 两份 `fwdBwdInstability` 只留了一份，而**它们真的不一样**
 *
 * 批 6b 与批 6c 并行，各自从同一个 Python 函数移了一份：6b 落在本文件，
 * 6c 落在 `l0/vision-tip-metrics.ts`。合并时先问的是「它们真的一样吗」。
 *
 * **不一样，而且分界线很清楚**：旧仓取窗口用的是 `xc[cy−ry : cy+ry+1, …]`，
 * 那是一次 **Python 切片** —— 负起点**回绕**、终点截断、绕过头就是空窗。
 * 6c 那份照抄了这条语义；6b 那份把越界的位移**跳过**（夹紧）。
 * 两者在 `ry < cy` 时完全一致，也就是 **H ≥ 4 且 W ≥ 4 的帧上没有区别**
 * （实测差 `≤ 4.4e−16`，而容差是 `7.6e−6`）—— 所以没有一格金样分得开它们。
 *
 * 分得开的输入是**行数 ≤ 3 的帧**，而那**不是一个假想的形状**：
 * `scan_prep.measureFrame` 喂进来的是 `acquiredRowSpan` 切出来的**已扫行段**，
 * 一张刚开扫的帧就只有一两行。对着旧仓那段 Python 实跑（`h × 64` 的合成帧）：
 *
 * | 行数 | 旧仓 Python | 6c（切片语义） | 6b（夹紧） |
 * |---|---|---|---|
 * | 3 | `0.73831` | `0.73831` ✔ | `0.70016` ✘ |
 * | 2（宽 256） | `0.86786` | `0.86786` ✔ | `0.86359` ✘ |
 * | ≥ 4 | — | ✔ | ✔ |
 *
 * ⇒ **留 6c 那一份**（本文件下面那个），6b 那份连同它的 `FB_MAX_SHIFT_FRAC`
 * 一起删掉。留下的 {@link FB_INSTABILITY_ABS_TOL} 是 6b 的**容差**，不是它的实现 ——
 * `scan_prep` 那两份测试按它断言，与 {@link instabilityAbsTol} 是同一个量的两条
 * 独立推导（一条按 `64·eps32` 定常、一条按 `8·eps32·log₂n` 随帧长），两条都留着。
 *
 * ⚠️ **两份都没能复现的一格**：`H = 1`（只扫了一行）。那时 `[x, y, 1]` 的平面拟合
 * 秩亏，numpy 的 `lstsq` 给最小范数解、照常去趋势，而本仓 {@link lstsqPlane} 回
 * `null` ⇒ {@link detrend} 整帧变 NaN ⇒ 这个量变 NaN（6b 那份走 `detrend32`，
 * 系数退化成 0，给出一个 `~1e−13` 的假「完全一致」）。两种都不是旧仓的答案
 * （实跑 `1×64` 是 `0.78273`）。**没有金样，本轮不改** —— 见 `spec/deviations.md`
 * 的 `D-TIPMETRIC-1`。
 */
import {
  EPS,
  fft2,
  gaussianFilter2d,
  ifft2,
  matAt,
  matOf,
  median,
  percentile,
  type Complex2d,
  type Mat,
} from 'dsh-spm-numerics'
import { detrend, EPS32 } from './frame-validity.js'
import { gradient2d, npMedian } from './nd.js'
import { lstsqPlane } from './plane.js'

/**
 * `detrend32` 的容差：**一个 float32 的 ulp**（相对 `eps32`）。
 *
 * 推导：它的输出是 `astype(np.float32)` 的结果，也就是一个**量化过**的数。
 * 量化之前两边的差额是那次最小二乘的（本仓正规方程、numpy SVD）：
 * `(n·eps + 64·κ²·eps)·pedestal`，κ = 384（`[x, y, 1]`，192×192，**没有中心化**）
 * ⇒ `2.1e−18`，而一个 float32 ulp 在 `1.9e−10` 上是 `2.3e−17` —— **大 11 倍**。
 * 于是两边**几乎总是**落在同一个 float32 上；「几乎总是」不是「总是」，
 * 所以给一个 ulp，不给零。
 *
 * ⚠️ 别把它收成 0：那会让这条断言在一个**合法**的最后一位差异上变红，
 * 而红的时候没人知道该改它还是改代码（`numerics-3.md` 第六节第二条）。
 */
export const DETREND_ULP_TOL = EPS32

/** 见文件抬头那一节。**注意它以 `sharp` 自己为参数** —— 这条容差随锐度线性放大。 */
export function fftSharpnessRelTol(sharp: number): number {
  return 8 * EPS32 * Math.max(1, Math.abs(sharp))
}

/**
 * `tip_metrics._detrend` —— **减行中值，再减一个最小二乘平面，最后降到 float32**。
 *
 * 三步缺一不可：
 *
 * * 行中值那一步是 Gwyddion 的逐行对齐，它吃掉慢轴的行间偏置；
 * * 平面那一步的设计阵是 `[x, y, 1]`（x/y 取 `0…n−1`，**没有中心化**），
 *   条件数随边长线性涨 —— 所以系数只保证到 `lstsqObservedTol(κ)`，κ 随金样录；
 * * 最后那次 `astype(np.float32)` **不是省内存**：`judge_frame` 的
 *   `corrugation_rms_m` 就取在这份 float32 上（D-VISION-3），
 *   而 `_fft_sharpness` 的整幅谱也从它出发。
 */
export function detrend32(m: Mat): Mat {
  const { rows, cols } = m
  const n = rows * cols
  const rowMed = new Float64Array(rows)
  const row = new Float64Array(cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) row[c] = matAt(m, r, c)
    rowMed[r] = npMedian(row)
  }
  const leveled = new Float64Array(n)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) leveled[r * cols + c] = matAt(m, r, c) - (rowMed[r] as number)
  }
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      xs[i] = c
      ys[i] = r
    }
  }
  // **走 `lstsqPlane`（批 4a 那一份），不写第二份** —— 它先把 x/y 中心化，
  // 于是正规方程不吃 `κ²`。理由见那一份的抬头。
  const coef = lstsqPlane(xs, ys, leveled) ?? [0, 0, 0]
  const a0 = coef[0] as number
  const a1 = coef[1] as number
  const a2 = coef[2] as number
  const out = new Float64Array(n)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      out[i] = Math.fround((leveled[i] as number) - (a0 * c + a1 * r + a2))
    }
  }
  return matOf(rows, cols, out)
}

/** `_fft_sharpness` 的三样：锐度、被分辨的周期（nm）、有没有晶格。 */
export interface FftSharpness {
  readonly sharpness: number
  readonly resolvedNm: number | null
  readonly hasLattice: boolean
}

/** `has_lattice` 的阈值。`_fft_sharpness` 内部写死 8.0，与 `sharpness_min` 的缺省同值
 * 但**不是同一个旋钮** —— 调用方传 `sharpness_min` 改不了这一个。 */
export const HAS_LATTICE_SHARP = 8.0

/**
 * 峰在背景之上凸出多少（`max|F| / median|F|`，只看 `r > 3` 的环外）。
 *
 * ⚠️ `hn` 必须是**已经降到 float32 的那一份**（`detrend32(h)` 再逐元素 `fround`
 * 地除以 std）—— 见文件抬头。这里不替调用方做那次除法，因为除数 `std` 来自
 * `flattenRobust`，而那是另一个模块的产物。
 */
export function fftSharpness(hn: Mat, nmPerPx: number | null): FftSharpness {
  const ny = hn.rows
  const nx = hn.cols
  const N = ny
  const cy = ny >> 1
  const cx = nx >> 1
  const spec = fft2(hn)
  let peak = -Infinity
  let bestIdx = -1
  let bestMag = -Infinity
  const ring: number[] = []
  for (let r = 0; r < ny; r += 1) {
    const sr = (r + Math.ceil(ny / 2)) % ny
    for (let c = 0; c < nx; c += 1) {
      const sc = (c + Math.ceil(nx / 2)) % nx
      const mag = Math.hypot(matAt(spec.re, sr, sc), matAt(spec.im, sr, sc))
      const rr = Math.hypot(r - cy, c - cx)
      if (rr > 3.0) {
        ring.push(mag)
        if (mag > peak) peak = mag
      }
      // `np.argmax(mag * ring)` —— 环外一律乘 0，**平局取第一个**（C 序）。
      const masked = rr > 3.0 ? mag : 0
      if (masked > bestMag) {
        bestMag = masked
        bestIdx = r * nx + c
      }
    }
  }
  if (ring.length === 0) return { sharpness: 0, resolvedNm: null, hasLattice: false }
  const med = npMedian(ring) + 1e-9
  const sharp = peak / med
  const hasLat = sharp > HAS_LATTICE_SHARP
  const py = Math.floor(bestIdx / nx)
  const px = bestIdx % nx
  const rad = Math.hypot(py - cy, px - cx)
  const resNm = rad > 0 && nmPerPx && nmPerPx > 0 ? (N / rad) * nmPerPx : null
  return { sharpness: sharp, resolvedNm: hasLat ? resNm : null, hasLattice: hasLat }
}

// ── 批 6c（搬家并入）：`_edge_resolution` ──────────────────────────────

/**
 * `_edge_resolution` 的相对容差：**`16 · eps32`**。
 *
 * 推导（逐段，全部相对于**场自己的尺度**，因为 `hn` 已经按 std 归一 ⇒ 尺度就是 1）：
 *
 * 1. 两次可分离的 float32 高斯（σ=1 ⇒ 9 抽头）：每次至多 `9·eps32`，共 `18·eps32`
 *    —— 但那是相对 `Σ|w·x|` 的界，而高斯核和为 1、`|hn|` 的尺度是 1，
 *    所以它就是 `sm` 的绝对误差；
 * 2. `np.gradient` 是一次相邻差分再除以 2 ⇒ 绝对误差不放大（`≤ 18·eps32`）；
 * 3. 输出只用到 `gmax = percentile(g, 99.9)` 与 `step = p97 − p3`，**两个都是大数**：
 *    `gmax` 是梯度的前 0.1%，`step` 是一个单位方差场的 94% 跨度（≈ 2–4）。
 *    两者都不做相消 ⇒ 相对误差各 `≲ 18·eps32 / O(1)`；
 * 4. `0.8·step/gmax` 把两份相对误差相加 ⇒ `≈ 4·eps32`（`gmax` 的分母 O(0.1–1)
 *    把第 3 条抬到 4 倍左右）。
 *
 * 取 **16** 留 4 倍余量。实测（技能路径）占比 **0.032**。
 *
 * ⚠️ 这条容差**照不出阈值翻转**：`gmax/gmed < 6.0` 与 `step < 0.3` 是两道判决闸，
 * 一格落在闸门上的金样会让 float32/float64 的差额变成一次 `no_step` 与 `measured`
 * 的对调。顶着它的是另外两件**零容差**的判据：`verdict` 逐字、`widthPx === null`
 * 逐位（「一个『是不是』的问题，用『差多少』永远问不出来」）。
 */
export const EDGE_RESOLUTION_REL_TOL = 16 * EPS32

/**
 * 同一个函数**喂 float64 时**的容差：**`64 · eps`**。
 *
 * 推导：这条路上一次降精度都没有，只有四步浮点 —— 两次可分离高斯（σ=1 ⇒ 9 抽头，
 * 各 `≤ 9·eps`）、一次中心差分（不放大绝对误差）、一次 `hypot`（1 ulp）。
 * `percentile` 与 `median` 是**选元素**，0 次运算。合计 `≈ 20·eps`，取 64 留 3 倍余量。
 * 实测占比 **0.028**（也就是真实差额约 `2·eps`）。
 */
export const EDGE_RESOLUTION_F64_TOL = 64 * EPS

/** `_edge_resolution` 的两个读数：像素宽与纳米宽（`null` = 这张图上判不了）。 */
export interface EdgeResolution {
  readonly widthPx: number | null
  readonly widthNm: number | null
}

/** 相干梯度离群的判据线（`gmax/gmed`）。低于它就没有「一条台阶」可言。 */
export const EDGE_GRADIENT_OUTLIER_MIN = 6.0
/** 台阶在归一化高度上至少要有这么高（std 的倍数）。 */
export const EDGE_STEP_MIN = 0.3
/** 梯度峰值的绝对地板 —— 低于它整幅图是平的。 */
export const EDGE_GMAX_MIN = 1e-6

/**
 * `tip_metrics._edge_resolution` —— 最陡台阶的 10–90 上升宽度（像素）。
 *
 * `hn` 必须是**按 std 归一之后**的那一份（`judgeFrame` 的 `detrended` 逐元素
 * `fround(v/std)`），因为 {@link EDGE_STEP_MIN} 是一个**无量纲**阈值。
 *
 * 三条出局（任一成立就 `null`）：梯度峰太小、台阶太矮、梯度峰不够离群。
 * 第三条是这个判据的核心 —— **真台阶是一个相干的梯度离群点**，
 * 而白噪声的梯度处处一样，没有「边缘」可以去量分辨率。
 *
 * ⚠️ 回 `null` 有**两种**含义，而它们在这一个数字上分不开：
 * 「这块地方本来就没有台阶」与「针尖钝到把台阶抹平了」。调用方要看同一帧的
 * `fft_sharpness` 与 `corrugation_rms_m` 才分得开 —— 别把 `null` 读成「针尖没问题」。
 */
export function edgeResolution(hn: Mat, nmPerPx: number | null): EdgeResolution {
  const sm = gaussianFilter2d(hn, 1.0)
  const { gy, gx } = gradient2d(sm)
  const g = new Float64Array(sm.rows * sm.cols)
  for (let i = 0; i < g.length; i += 1) g[i] = Math.hypot(gy.data[i] as number, gx.data[i] as number)
  const gmax = percentile(g, 99.9)
  const gmed = median(g) + 1e-9
  const step = percentile(sm.data, 97.0) - percentile(sm.data, 3.0)
  if (gmax < EDGE_GMAX_MIN || step < EDGE_STEP_MIN || gmax / gmed < EDGE_GRADIENT_OUTLIER_MIN) {
    return { widthPx: null, widthNm: null }
  }
  // `np.clip(0.8·step/gmax, 0.5, rows/2)` —— 下界是 Nyquist（两个采样点分不开
  // 比 0.5 px 更窄的上升沿），上界是半帧（比半帧还宽的「边缘」不是边缘）。
  const widthPx = Math.min(Math.max((0.8 * step) / gmax, 0.5), hn.rows / 2)
  const widthNm = nmPerPx !== null && nmPerPx > 0 ? widthPx * nmPerPx : null
  return { widthPx, widthNm }
}

// ── `_fwd_bwd_instability` ─────────────────────────────────────────────

/**
 * `fwdBwdInstability` 的**绝对**容差。
 *
 * 为什么是绝对：输出是 `1 − max_ncc`，而正反扫一致的帧上 `max_ncc ≈ 1` ——
 * 一次**相消**。相消毁掉相对精度、不毁绝对精度（批 4a §9①），
 * 所以这里唯一说得通的是绝对界。
 *
 * 尺度是 `max_ncc` 自己（归一化过，量级 1）。旧仓整条路在 float32 里
 * （`_detrend` 给 float32，`np.fft.fft2(float32)` 给 complex64），
 * 本仓只照抄输入那次量化、变换留在 float64 ⇒ 差额由**单精度 FFT 的本底**定：
 * `eps32 · log₂n`，`n = 256² = 65536` ⇒ `16·eps32 ≈ 1.9e−6`。取 4 倍余量。
 *
 * ⚠️ 判据是 `不稳定度 < fb_instability_max`（缺省 0.50）。金样的帧因此要么
 * 远在 0.5 以下（一致）、要么远在 0.5 以上（不一致），**不许有一格贴着 0.5**。
 */
export const FB_INSTABILITY_ABS_TOL = 64 * EPS32

/**
 * {@link fwdBwdInstability} 的**绝对**容差 —— 这个量本来就落在 `[0, 1]`。
 *
 * 为什么是绝对而不是相对：它是 `1 − max_ncc`，一条稳定的针尖上那是两个几乎相等的
 * 数相减。相消毁掉相对精度、不毁绝对精度（`numerics.md` 第四节第一条），
 * 而下游的判决线 `0.40` 也是绝对的 —— 拿相对容差去比一个近零的差，是抽签。
 *
 * 推导：整条链在旧仓是 float32（`_detrend` → 两次 `fft2` + 一次 `ifft2` 在
 * complex64 里做，`na`/`nb` 是 float32 的成对求和）。FFT 的**范数型**相对误差是
 * `O(eps·log₂N)`（Higham，N = 像素数），三次变换 ⇒ `3·eps32·log₂N`；
 * 两条范数各 `eps32·log₂N` ⇒ 共 `5·eps32·log₂N`。而 `|max_ncc| ≤ 1`
 * （柯西–施瓦茨），于是这些相对误差就是它的绝对误差。取 **8** 留 1.6 倍余量。
 *
 * 实测（`export_batch6c.py` 的七格 48×48 判据本体 + 技能路径的 128×128）：
 * 最坏占容差 **0.0045**。
 */
export function instabilityAbsTol(nPixels: number): number {
  return 8 * EPS32 * Math.max(1, Math.log2(Math.max(nPixels, 2)))
}

/**
 * `1e-30` —— 防除零，**不是**一道物理判据。
 *
 * 旧仓 2026-08-10 把它从 `1e-9` 改成 `1e-30`，现场原话是
 * 「**一道绝对阈值卡在物理量上就是个 bug**」：`na ≈ n_px × 起伏RMS`，数据以**米**
 * 计 ⇒ 同一帧内容只改边长（32→256 px）或改单位（m→nm）答案就从 1.0 翻到 0.0001。
 * 而 `1.0` 正好落在判决阈值 0.40 的拒绝一侧 —— 一块**越平越好**的好表面越会被判
 * 「针尖坏」。
 */
export const INSTABILITY_ZERO_GUARD = 1e-30

/** 允许的横向平移占边长的比例 —— 吸收压电迟滞的快轴偏移（真机实测 ~6–7 px）。 */
export const INSTABILITY_MAX_SHIFT_FRAC = 0.12

/**
 * `tip_metrics._fwd_bwd_instability` —— `1 − max_ncc` ∈ `[0, 1]`。
 *
 * 0 = 正反扫走出同一条形貌（针尖稳），1 = 不相关（针尖变了 / 反馈在振）。
 *
 * **允许横向平移**是这条判据的要害：正反扫之间有压电迟滞造成的快轴偏移，
 * 零平移的逐点判据在真实数据上会饱和 —— 7287 张真实扫描上相关性
 * `0.29 → 0.58`（Agent-B，2026-07-23）。合成数据没有这个偏移，所以旧判据
 * 「只在实验台上看起来没问题」。
 *
 * ⚠️ 两帧必须**已经几何归位**（反扫块在 `.sxm` 里是镜像存的）。不翻的话这道判据
 * 是在拿一张图和它自己的镜像比 —— 真机 76 帧实测，错法在**两个方向**上都会说谎
 * （有横向结构的帧假失败，`f(y)` 型的帧假通过）。归位归 `sxmOrientedFrames`。
 */
export function fwdBwdInstability(fwd: Mat, bwd: Mat, maxShiftFrac = INSTABILITY_MAX_SHIFT_FRAC): number {
  const a = centered(detrend(fwd))
  const b = centered(detrend(bwd))
  const na = Math.sqrt(dot(a.data, a.data))
  const nb = Math.sqrt(dot(b.data, b.data))
  if (na < INSTABILITY_ZERO_GUARD || nb < INSTABILITY_ZERO_GUARD) return 1.0
  const fa = fft2(a)
  const fb = fft2(b)
  const prod = mulConj(fa, fb)
  const xc = ifft2(prod)
  const H = a.rows
  const W = a.cols
  const cy = H >> 1
  const cx = W >> 1
  const ry = Math.max(2, Math.trunc(maxShiftFrac * H))
  const rx = Math.max(2, Math.trunc(maxShiftFrac * W))
  // `np.fft.fftshift` 之后取中心窗。这里不真的搬一次数组：
  // shifted[r][c] = raw[(r + ceil(H/2)) % H][(c + ceil(W/2)) % W]。
  const shiftR = Math.ceil(H / 2)
  const shiftC = Math.ceil(W / 2)
  const at = (r: number, c: number): number =>
    matAt(xc.re, (r + shiftR) % H, (c + shiftC) % W) / (na * nb)
  // Python 切片语义：负的起点会**回绕**，绕过头就是空窗（`win.size == 0` ⇒ 退回全局 max）。
  const r0 = cy - ry < 0 ? H + (cy - ry) : cy - ry
  const c0 = cx - rx < 0 ? W + (cx - rx) : cx - rx
  const r1 = Math.min(cy + ry + 1, H)
  const c1 = Math.min(cx + rx + 1, W)
  let maxNcc = -Infinity
  if (r0 < r1 && c0 < c1) {
    for (let r = r0; r < r1; r += 1) for (let c = c0; c < c1; c += 1) maxNcc = Math.max(maxNcc, at(r, c))
  } else {
    for (let r = 0; r < H; r += 1) for (let c = 0; c < W; c += 1) maxNcc = Math.max(maxNcc, at(r, c))
  }
  return Math.min(Math.max(1.0 - maxNcc, 0.0), 1.0)
}

/** `a − a.mean()`。`_detrend` 的残差**按构造**均值近零，所以这一步几乎是恒等 —— 照移。 */
function centered(m: Mat): Mat {
  let acc = 0
  for (let i = 0; i < m.data.length; i += 1) acc += m.data[i] as number
  const mu = acc / m.data.length
  const out = new Float64Array(m.data.length)
  for (let i = 0; i < out.length; i += 1) out[i] = (m.data[i] as number) - mu
  return matOf(m.rows, m.cols, out)
}

function dot(a: Float64Array, b: Float64Array): number {
  let acc = 0
  for (let i = 0; i < a.length; i += 1) acc += (a[i] as number) * (b[i] as number)
  return acc
}

/** `fft2(a) * conj(fft2(b))`。 */
function mulConj(fa: Complex2d, fb: Complex2d): Complex2d {
  const n = fa.re.data.length
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const ar = fa.re.data[i] as number
    const ai = fa.im.data[i] as number
    const br = fb.re.data[i] as number
    const bi = fb.im.data[i] as number
    re[i] = ar * br + ai * bi
    im[i] = ai * br - ar * bi
  }
  return { re: matOf(fa.re.rows, fa.re.cols, re), im: matOf(fa.re.rows, fa.re.cols, im) }
}