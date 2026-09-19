/**
 * 帧法倾斜与台阶主导判据 —— 旧仓 `mast/vision/tilt.py` 里 `plane.ts` **没有**带走的
 * 那一半：`detrend_quadratic`(42) · `structure_dominance`(28) ·
 * `step_dominance_multiscale`(27) · `_segmentation_step_signal`(23) ·
 * `assess_steps`(36) · `_rotate_slope`(13) · `estimate_tilt`(158)。
 *
 * 平面拟合那一族（`noise_floor` / `_lstsq_plane` / `fit_plane_robust` /
 * `plane_subtract`）在 {@link ./plane.js}，**这里不重写第二份** —— 本文件只
 * `import` 它们。旧仓那份 `tilt.plane_subtract` 就是 `planeSubtractRobust`。
 *
 * ## 两个判据的盲区**正好互补**，所以必须一起用（旧仓抬头的原话）
 *
 * | 判据 | 盲区 | 失效方向 |
 * |---|---|---|
 * | 多尺度结构主导比 | 台面宽度 < 分块尺寸 ⇒ 比值塌回 1.00 | **往「看起来很干净」那一侧** |
 * | 分割器的 STEP 占比 | 完全平行于快扫轴的台阶（逐行中位数差分对齐把它吸收掉） | 同上 |
 *
 * 前者不做行对齐，水平台阶抓得到；后者在密集区抓得到。两个取**或**。
 *
 * ## ⚠️ 本仓**没有**分割器那一路，于是它走旧仓自己的 fail-open 分支
 *
 * `_segmentation_step_signal` 的整个函数体是一个 `try: from
 * mast.vision.seg_scale_adaptive import …` 加一个 `except Exception: return
 * (False, 0.0)`，注释写着「分割坏掉不能让调平失效」。本仓
 * `segment_scale_adaptive` **零命中**（`seg-texture.ts` 只搬了它的三条链，
 * 抬头明写「不移 `segment_scale_adaptive`」），所以这里**天然落在那条 except 上**。
 *
 * 照移的做法不是把 `[false, 0]` 写死，而是把分割器做成一个**注入口**
 * （{@link SegStepSignal}）：
 *
 * * 缺省不注入 ⇒ 与旧仓「缺依赖」那一支逐字同义；
 * * 注入了会抛的 ⇒ 走旧仓 `except` 那一支（**这一支有单测**）；
 * * 哪天 `segment_scale_adaptive` 真落了，接上来就行，**不用改这个文件**。
 *
 * 金样两侧都录了（`assess_steps.*.verdict_seg` / `verdict_noseg` 与
 * `seg_signal`），所以「差在哪儿」是量出来的，不是我说的 —— 见交接 §5 与
 * `spec/deviations.md` 本批那条。
 *
 * ## 容差
 *
 * | 件 | 对的是 | 容差 | 为什么 |
 * |---|---|---|---|
 * | `structureDominance` / `stepDominanceMultiscale` | numpy `std` + `np.median` | {@link DOMINANCE_REL_TOL} | 输入是 `detrendQuadratic` 的残差，误差随它 |
 * | `detrendQuadratic` 的每个像素 | `np.linalg.lstsq`（SVD） | {@link detrendAbsTol} | **绝对**容差：去趋势是相消，尺度是基座不是残差 |
 * | `estimateTilt` 的角度 / `z_span` | `fit_plane_robust` 下游 | {@link RANSAC_REL_TOL}（`plane.ts`） | 两边 RANSAC 抽样不同 ⇒ 内点集差几个点（D-VISION-1） |
 * | `estimateTilt` 的 `valid` / `invalid_reason` / 两个 bool | 同上 | **0** | 它们是**结论**，不是数 |
 * | `estimateTilt` 的 `noise_floor_m` | `noise_floor` | **0** | 一次差分 + 两次中位数，闭式（同 `plane.ts`） |
 * | `circleTiltResolutionDeg` / `zSpanForFrame` | `math.degrees/atan/tan/sqrt` | {@link TILT_TRIG_REL_TOL} | 一次 `sqrt`/`tan`，libm 之间差 ≤ 1 ulp |
 *
 * ## 三处**在本仓不可达**的分支（都在金样里留着对面的答案）
 *
 * 1. `frame_not_2d` —— `Mat` 由 `matOf` 保证是二维的，一维输入在本仓根本构造不出来。
 *    旧仓 `np.asarray([...])` 的 `ndim == 1` 在这里最接近的形状是 `1×N` 的 `Mat`，
 *    而那一格走的是 `frame_too_small`。**两边的答案都录在金样里**，不是我说它不可达。
 * 2. `estimate_tilt` 的 `fit_failed` —— 它要 `fit_plane_robust` 交 `None`，
 *    而那只在有限像素 < 3 时发生；64×64 上那意味着 NaN 占比 99.9%，
 *    **`too_many_nan` 在它前面**（0.20 的线）。金样 `estimate_tilt.unreachable`
 *    那一节把这条推理逐格量出来。
 * 3. `detrend_quadratic` 的两条退回一阶（`LinAlgError` / 系数非有限）——
 *    设计矩阵恒为有限、`lstsq` 对秩亏也给最小范数解。本仓的 `lstsqQr` 会**抛**，
 *    所以这里保留 `catch` 并退回 `planeSubtractRobust`，与旧仓同形。
 */
import { lstsqObservedTol, lstsqQr, matAt, matOf, type Mat } from 'dsh-spm-numerics'
import { finiteOf, nanStd, npMedian } from './nd.js'
import { planeSubtractRobust, fitPlaneRobust, noiseFloor } from './plane.js'

// ── 常量（物理常数级：改动 = 改代码 + 重新验证）────────────────────────────

/**
 * 结构主导比的触发阈。**实测标定**（旧仓 2026-07-30，15.4 pm 噪声 / 240 pm 台阶）：
 *
 * | 输入 | 比值 |
 * |---|---|
 * | 纯高斯噪声 270 次 | 最大 **1.0664** |
 * | 纯倾斜面 | 1.0611 |
 * | 压电弯曲（4 倍强曲率也一样） | 1.061 |
 * | 台面 ≥16 px | ≥ 3.02 |
 * | 台面 8 px | 1.653 |
 * | 台面 ≤5 px | 1.06 ← 与噪声无法区分 |
 *
 * 1.4 落在误报天花板（1.0664）之上 31%、最弱真信号（1.653）之下 16%。
 *
 * **为什么前面要二阶去趋势**：只扣一阶时压电弯曲把比值抬到 1.808 —— 高于
 * 台面 8 px 的密集台阶（1.717）。也就是说在一阶下**不存在**任何阈值能既抓住
 * 密集台阶又不把弯曲误判成台阶。
 */
export const STRUCTURE_RATIO_THRESHOLD = 1.4

/**
 * **硬限制**：台面宽度小于约 6 个像素时本判据与纯噪声无法区分（实测 1.06）。
 * 分块再小也没用 —— 分块必须装得下若干像素才估得出局部 σ，而那个尺寸已经跨过台阶了。
 * 这一档由分割器那一路负责，这也正是两个判据必须取「或」的原因之一。
 */
export const DOMINANCE_MIN_TERRACE_PX = 6

/** 多尺度扫描用的分块边长（px）。比值只在**台面宽度 > 分块尺寸**时抬得起来。 */
export const DOMINANCE_TILES: readonly number[] = [4, 8, 16, 32, 64]

/** 帧短边小于这个像素数时不做拟合 —— 点太少，拟合出来的斜率没有意义。 */
export const MIN_FRAME_PX = 64

/** NaN 占比超过这个值就判无效（实时扫描中未采集的行是 NaN）。 */
export const MAX_NAN_FRAC = 0.2

/** 最少内点比。低于它说明这一帧上根本没有一个占多数的平面。 */
export const MIN_INLIER_RATIO = 0.5

/**
 * 主导比一族的相对容差。
 *
 * `ratio = std(残差) / median(分块 std(残差))`。分子分母都是同一份残差的二阶矩，
 * 而残差本身按 {@link detrendAbsTol} 走 —— 一个**绝对**误差 `δ` 在比值上表现为
 * 相对误差 `≈ 2δ/σ`。本批最小的那格残差 σ 是 `1.0e−11`（噪声底 10 pm），
 * 而 `detrendAbsTol` 在那一格给 `≈ 4e−22` ⇒ `8e−11`。
 *
 * 取 `1e−9`（约 12 倍余量），口径同 `seg-texture.ts` 的 `BAND_PEAK_REL_TOL`：
 * 这一族真正会犯的错是**挑错了分块 / 少数一格**，那在数字上差百分之几十。
 */
export const DOMINANCE_REL_TOL = 1e-9

/**
 * RANSAC 谱宽超过它的金样格子**只比结论**，不比数。
 *
 * 导出器对每一格跑 12 个抽样种子，量出 `(a, b, inlier_ratio)` 的最大相对谱宽
 * （`tilt.json` 的 `ransac_spread`）。主路那几格是 **0**（棋盘噪声让内点恒为全部），
 * 而台阶帧那两格是 **1.93** —— 一条 `4 × 1.93 = 7.7` 的相对容差盖得住任何东西，
 * 那不是判据，是一张通行证（`plane.ts` 抬头：「一组容差盖得住一切的金样，
 * 也不是判据」）。
 *
 * 那两格仍然值钱，值钱的是它们的**结论**：关掉台阶闸之后 `step_dense` 换成
 * `low_inliers`。0.05 这个线本身不是物理量，它只回答「这个数还算不算一个数」。
 */
export const LOTTERY_SPREAD = 0.05

/**
 * 一次 `atan` / `tan` / `sqrt` / `degrees` 的相对容差。
 *
 * CPython 的 `math.atan` 与 V8 的 `Math.atan` 都不是 correctly-rounded，
 * 各自的误差界是 1 ulp 量级；两边之差 ≤ 2 ulp ⇒ `4.5e−16`。
 * 取 `1e−12`（三个量级余量）—— 这一族会犯的错是**弧度当度用**（差 57 倍）
 * 或**符号反了**，不是最后一位。
 */
export const TILT_TRIG_REL_TOL = 1e-12

/**
 * `detrendQuadratic` 每个像素的**绝对**容差（与输入同单位）。
 *
 * 去趋势是**相消**：输出是 `z − 曲面`，量级远小于 `z` 自己，所以相对容差在这里
 * 是抽签（`numerics.md` 第四节第一条）。尺度要取**基座**，也就是 `max|z|`。
 *
 * 两边的差由三部分构成：
 *
 * ```
 * 系数解的差      κ·eps      （numpy 的 gelsd 与本仓的列缩放 Householder QR，各自 κ·eps）
 * 曲面求值的差    6·eps      （6 项相加）
 * 相减            1·eps
 * ```
 *
 * ⇒ `(κ + 7)·eps·基座`，再乘 8 倍余量。κ 由导出器随金样录
 * （`condition_numbers`），**不写死** —— 64×64 上 `[x², y², xy, x, y, 1]`
 * 不中心化的 κ 实测 `1.1e5` 量级，而它随边长平方增长。
 */
export function detrendAbsTol(cond: number, pedestal: number): number {
  const EPS = Number.EPSILON
  return 8 * (Math.abs(cond) + 7) * EPS * Math.abs(pedestal)
}

/** 设计矩阵条件数对应的系数相对容差 —— 与 `plane.ts` 的 `planeRelTol` 同一口径。 */
export function detrendCoeffRelTol(cond: number): number {
  return lstsqObservedTol(cond)
}

// ── 二阶去趋势 ──────────────────────────────────────────────────────────────

/**
 * 扣掉二阶曲面（给结构主导判据做前处理）。拟合失败时退回一阶（稳健平面）。
 *
 * 项的顺序**逐字照移旧仓**：`[x², y², xy, x, y, 1]`。
 * ⚠️ 与 `scan-prep.ts` 的 `polySubtract(m, 2)` **不是**同一个函数，也不许合并：
 * 那一份的项序是 `[1, x, x², y, xy, y²]`、NaN 不足时退回「减均值」、
 * 判据是 `idx.length < nTerms + 1`；这一份的门槛是 `finite < 6`、退路是**稳健平面**。
 * 两份在同一张图上给出的最后几位不同，而那几位进 `structureDominance` 的分母。
 * 这是 D-CHANNELS-1 的形状。
 *
 * **为什么是二次而不是一次**：压电扫描管的弯曲是二次的。只扣平面时它在残差里留下
 * 一个大尺度起伏，把结构主导比抬到 1.808 —— 高于台面 8 px 的密集台阶（1.717）。
 * 二次面能拟合弯曲、拟合不了阶梯，这一步把两者彻底分开。
 *
 * 用普通最小二乘而不是稳健拟合：这里的目的是**移除低频背景**，不是估一个要拿去
 * 调硬件的物理量；台阶把二次拟合带偏一点，残差里仍然留着台阶。
 */
export function detrendQuadratic(m: Mat): Mat {
  const { rows: ny, cols: nx } = m
  const n = ny * nx
  const idx: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(m.data[i] as number)) idx.push(i)
  // 旧仓 `if finite.sum() < 6: return arr` —— 6 是项数，不是项数 + 1。
  // 恰好 6 个有限点时它**照样拟合**（一个恰定解），照移。
  if (idx.length < 6) return m

  const k = idx.length
  const cols: Float64Array[] = [
    new Float64Array(k),
    new Float64Array(k),
    new Float64Array(k),
    new Float64Array(k),
    new Float64Array(k),
    new Float64Array(k),
  ]
  const rhs = new Float64Array(k)
  for (let t = 0; t < k; t += 1) {
    const i = idx[t] as number
    const x = i % nx
    const y = Math.floor(i / nx)
    ;(cols[0] as Float64Array)[t] = x * x
    ;(cols[1] as Float64Array)[t] = y * y
    ;(cols[2] as Float64Array)[t] = x * y
    ;(cols[3] as Float64Array)[t] = x
    ;(cols[4] as Float64Array)[t] = y
    ;(cols[5] as Float64Array)[t] = 1
    rhs[t] = m.data[i] as number
  }
  // 列缩放之后再 QR：裸 `[x², y², xy, x, y, 1]` 在 64 边长上 κ ≈ 1e5，
  // 而列范数彼此差 6 个量级（`x²` 的列范数 ~1e5，常数列 ~64）。
  // 缩放只改中间量，解回乘一遍还原 —— 与 `polySubtract` 的 order ≥ 2 同一招。
  const scale = new Float64Array(6)
  for (let c = 0; c < 6; c += 1) {
    const col = cols[c] as Float64Array
    let s = 0
    for (let t = 0; t < k; t += 1) s += (col[t] as number) * (col[t] as number)
    s = Math.sqrt(s)
    scale[c] = s === 0 ? 1 : s
    for (let t = 0; t < k; t += 1) col[t] = (col[t] as number) / (scale[c] as number)
  }
  let coeff: Float64Array
  try {
    const raw = lstsqQr(cols, rhs)
    coeff = new Float64Array(6)
    for (let c = 0; c < 6; c += 1) coeff[c] = (raw[c] as number) / (scale[c] as number)
  } catch {
    // 旧仓 `except np.linalg.LinAlgError: return plane_subtract(arr)`。
    return planeSubtractRobust(m)
  }
  for (let c = 0; c < 6; c += 1) {
    if (!Number.isFinite(coeff[c] as number)) return planeSubtractRobust(m)
  }
  const out = new Float64Array(n)
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const surf =
        (coeff[0] as number) * x * x +
        (coeff[1] as number) * y * y +
        (coeff[2] as number) * x * y +
        (coeff[3] as number) * x +
        (coeff[4] as number) * y +
        (coeff[5] as number)
      out[y * nx + x] = (m.data[y * nx + x] as number) - surf
    }
  }
  return matOf(ny, nx, out)
}

// ── 台阶主导判据 ────────────────────────────────────────────────────────────

/**
 * 单一尺度的结构主导比 = 整帧 σ / 分块 σ 的**中位数**。
 *
 * 分块 σ 取中位数（而不是均值）：多数分块只看到局部纹理（晶格 + 噪声），
 * 中位数对少数几个跨台阶的分块免疫。比值说明高度起伏里有多少是大尺度结构。
 *
 * 四条退路都给 `1.0`（= 「看不出结构」），逐条照移：
 * 全是 NaN · 分块数不足 2×2 · 每个分块都不足 2 个有限点 · 局部 σ 为 0。
 */
export function structureDominance(flat: Mat, tile: number): number {
  const fin = finiteOf(flat.data)
  if (fin.length === 0) return 1.0
  const g = nanStd(flat.data)
  const h = flat.rows
  const w = flat.cols
  const ny = Math.floor(h / tile)
  const nx = Math.floor(w / tile)
  if (ny < 2 || nx < 2) return 1.0
  const stds: number[] = []
  for (let i = 0; i < ny; i += 1) {
    for (let j = 0; j < nx; j += 1) {
      const block: number[] = []
      for (let r = i * tile; r < (i + 1) * tile; r += 1) {
        for (let c = j * tile; c < (j + 1) * tile; c += 1) {
          const v = matAt(flat, r, c)
          if (Number.isFinite(v)) block.push(v)
        }
      }
      if (block.length >= 2) stds.push(nanStd(block))
    }
  }
  if (stds.length === 0) return 1.0
  const local = npMedian(stds)
  return local > 0 ? g / local : 1.0
}

/** {@link stepDominanceMultiscale} 的产出。`byTile` 的键是**分块边长**。 */
export interface MultiscaleDominance {
  readonly ratio: number
  /** ⚠️ 旧仓是 `dict[int, float]`；JSON 化之后键是字符串，本仓直接用字符串键。 */
  readonly byTile: Readonly<Record<string, number>>
}

/**
 * 多尺度结构主导比：扫一排分块尺度，取**最大值**。
 *
 * 单一 32 px 分块有个往「看起来很干净」方向失效的盲区：台面宽度小于分块尺寸时，
 * 每个分块内部都含台阶，局部 σ 追平整帧 σ，比值塌回 1.00 —— 与纯平表面无法区分，
 * 而那正是要识别的密集台阶区。旧仓实测（512²、100 nm 视野、台阶 240 pm）：
 *
 * ```
 * 分块    台面宽=128  =64   =32   =16    =8
 *   8        4.39    4.05  3.10  1.89  1.00
 *  16        3.97    3.07  1.88  1.00  1.00
 *  32        3.08    1.88  1.00  1.00  1.00   ← 单尺度的现役参数
 *  64        1.91    1.01  1.00  1.00  1.00
 * ```
 *
 * 一个分块尺度只有在 `tile * 2 <= 短边` 时才参加 —— 少于 2×2 个分块时中位数
 * 没有意义。全都不参加 ⇒ `(1.0, {})`。
 */
export function stepDominanceMultiscale(flat: Mat): MultiscaleDominance {
  const shortSide = Math.min(flat.rows, flat.cols)
  const byTile: Record<string, number> = {}
  let ratio = -Infinity
  let any = false
  for (const tile of DOMINANCE_TILES) {
    if (tile * 2 > shortSide) continue
    const v = structureDominance(flat, tile)
    byTile[String(tile)] = v
    any = true
    if (v > ratio) ratio = v
  }
  if (!any) return { ratio: 1.0, byTile: {} }
  return { ratio, byTile }
}

/**
 * 分割器那一路：`(STEP 是否存在, STEP 面积占比)`。
 *
 * 旧仓是一个函数体内的 `from mast.vision.seg_scale_adaptive import …`；
 * 本仓做成**注入口**，理由见文件抬头。抛了就 `[false, 0]` —— 判据组合是「或」，
 * 缺这一路只会让判据**更宽松**，而另一路仍在。一个分析组件坏掉不该让调平整个失效。
 */
export type SegStepSignal = (image: Mat, nmPerPx: number | null) => readonly [boolean, number]

/** 走 {@link SegStepSignal}，任何异常都吞成 `[false, 0]`（旧仓 `except Exception`）。 */
export function segmentationStepSignal(
  image: Mat,
  nmPerPx: number | null,
  provider?: SegStepSignal,
): readonly [boolean, number] {
  if (provider === undefined) return [false, 0.0]
  try {
    const [present, frac] = provider(image, nmPerPx)
    return [Boolean(present), Number(frac)]
  } catch {
    return [false, 0.0]
  }
}

/** 台阶主导判据的结果。字段名与旧仓 `StepVerdict.as_dict()` 逐字一致。 */
export interface StepVerdict {
  readonly step_dominated: boolean
  readonly ratio_multiscale: number
  readonly ratio_by_tile: Readonly<Record<string, number>>
  readonly step_area_frac: number
  readonly step_present: boolean
  /** `dominance` / `segmentation` / `both` / `none` —— 哪个判据触发的（诊断用）。 */
  readonly triggered_by: string
}

/** {@link assessSteps} 的可选项。 */
export interface AssessStepsOptions {
  readonly nmPerPx?: number | null
  readonly useSegmentation?: boolean
  readonly segSignal?: SegStepSignal
}

/**
 * 台阶是否主导这幅图的高度起伏（= 倾斜拟合是否可信）。两个判据取**或**。
 *
 * ⚠️ 阈值判的是 `ratio >= STRUCTURE_RATIO_THRESHOLD`（闭区间，**不是** `>`）。
 * 恰好等于 1.4 时**算命中** —— 台阶那一侧是安全的一侧，边界归它。
 */
export function assessSteps(image: Mat, opts: AssessStepsOptions = {}): StepVerdict {
  const nmPerPx = opts.nmPerPx ?? null
  const useSeg = opts.useSegmentation ?? true
  // 二阶去趋势：压电弯曲必须先扣掉，否则它会伪装成台阶（见 detrendQuadratic）。
  const flat = detrendQuadratic(image)
  const { ratio, byTile } = stepDominanceMultiscale(flat)
  const dominanceHit = ratio >= STRUCTURE_RATIO_THRESHOLD

  let segHit = false
  let area = 0.0
  if (useSeg) {
    const sig = segmentationStepSignal(image, nmPerPx, opts.segSignal)
    segHit = sig[0]
    area = sig[1]
  }

  let trigger: string
  if (dominanceHit && segHit) trigger = 'both'
  else if (dominanceHit) trigger = 'dominance'
  else if (segHit) trigger = 'segmentation'
  else trigger = 'none'

  return {
    step_dominated: dominanceHit || segHit,
    ratio_multiscale: ratio,
    ratio_by_tile: byTile,
    step_area_frac: area,
    step_present: segHit,
    triggered_by: trigger,
  }
}

// ── 倾斜估计 ────────────────────────────────────────────────────────────────

/**
 * 帧坐标系的斜率向量 → 压电坐标系。
 *
 * 扫描框相对压电坐标系转了 `angleDeg`，斜率向量随之转回去。**符号约定未在真机上
 * 核实** —— 所以调平例程自己扫的探察帧一律用 `scan_angle = 0`，把这个未知量从闭环里
 * 彻底消掉；这里的旋转只用于解释既有的、非零角度的帧。
 */
export function rotateSlope(slopeFast: number, slopeSlow: number, angleDeg: number): [number, number] {
  const theta = (angleDeg * Math.PI) / 180
  const cosT = Math.cos(theta)
  const sinT = Math.sin(theta)
  return [slopeFast * cosT - slopeSlow * sinT, slopeFast * sinT + slopeSlow * cosT]
}

/**
 * 一帧图的倾斜估计。字段名与旧仓 `TiltEstimate.as_dict()` 逐字一致。
 *
 * `valid` 为 `false` 时其余数值**不可用于调平决策** —— `invalid_reason` 说明为什么。
 * 这是刻意做成显式字段而不是「返回 null」的：调用方拿到一个带原因的结构，
 * 能把「为什么不调平」如实报告给用户。
 */
export interface TiltEstimate {
  readonly valid: boolean
  readonly invalid_reason: string
  readonly tilt_x_deg: number
  readonly tilt_y_deg: number
  readonly tilt_fast_deg: number
  readonly tilt_slow_deg: number
  readonly slope_mag_deg: number
  readonly z_span_m: number
  /** **慢扫轴的斜率不可信** —— 它混着整帧时长内的热漂移。帧法恒为 `false`。 */
  readonly slow_axis_trusted: boolean
  readonly inlier_ratio: number
  readonly noise_floor_m: number
  /** `scanAngleDeg ≠ 0` 时为 `true`：帧→压电的旋转用了未在真机上核实的方向约定。 */
  readonly rotation_applied: boolean
  readonly step: StepVerdict | null
}

/** {@link estimateTilt} 的入参。`widthM` / `heightM` 是**帧的物理尺寸**。 */
export interface EstimateTiltOptions {
  readonly widthM: number
  readonly heightM: number
  readonly scanAngleDeg?: number
  readonly nmPerPx?: number | null
  readonly checkSteps?: boolean
  readonly segSignal?: SegStepSignal
}

function invalid(reason: string, extra: Partial<TiltEstimate> = {}): TiltEstimate {
  return {
    valid: false,
    invalid_reason: reason,
    tilt_x_deg: 0.0,
    tilt_y_deg: 0.0,
    tilt_fast_deg: 0.0,
    tilt_slow_deg: 0.0,
    slope_mag_deg: 0.0,
    z_span_m: 0.0,
    slow_axis_trusted: false,
    inlier_ratio: 0.0,
    noise_floor_m: 0.0,
    rotation_applied: false,
    step: null,
    ...extra,
  }
}

/**
 * 从一帧高度图估计表面倾斜（物理角度，压电坐标系）。
 *
 * `widthM` / `heightM` 用来把「z 单位 / 像素」的拟合系数换成**无量纲斜率**再取反正切。
 * 少了这一步，系数是没有物理意义的数字 —— 而这正是旧仓既有的 `ransac_plane_subtract`
 * 停下来的地方（四份平面拟合代码，三份把系数算完就丢掉）。
 *
 * 五道闸按**这个顺序**，顺序本身是判据：
 *
 * 1. `frame_not_2d`（本仓不可达，见抬头）
 * 2. `frame_too_small` —— 短边 < {@link MIN_FRAME_PX}
 * 3. `too_many_nan` —— NaN 占比 > {@link MAX_NAN_FRAC}
 * 4. `geometry_missing` —— 没有物理尺寸就换算不出角度
 * 5. `step_dense` —— 台阶主导时**拒绝给出倾斜数字**。给一个「大概齐」的角度比不给
 *    更糟：下游会拿它去调硬件，而旧仓 2026-07-28 的审计实例里这个数字偏了 **13 倍**。
 * 6. `low_inliers` —— 内点比 < {@link MIN_INLIER_RATIO}
 *
 * ⚠️ 第 3 道闸在第 4 道**前面**：一张既没几何又满是 NaN 的帧报的是 `too_many_nan`。
 * 顺序照移，不重排。
 */
export function estimateTilt(m: Mat, opts: EstimateTiltOptions): TiltEstimate {
  const ny = m.rows
  const nx = m.cols
  if (Math.min(ny, nx) < MIN_FRAME_PX) return invalid('frame_too_small')

  const size = ny * nx
  let finite = 0
  for (let i = 0; i < size; i += 1) if (Number.isFinite(m.data[i] as number)) finite += 1
  const nanFrac = 1.0 - finite / size
  if (nanFrac > MAX_NAN_FRAC) return invalid('too_many_nan')

  const widthM = opts.widthM
  const heightM = opts.heightM
  if (!(widthM > 0 && heightM > 0)) return invalid('geometry_missing')

  const sigma = noiseFloor(m)

  const checkSteps = opts.checkSteps ?? true
  const step = checkSteps
    ? assessSteps(m, {
        nmPerPx: opts.nmPerPx ?? null,
        ...(opts.segSignal === undefined ? {} : { segSignal: opts.segSignal }),
      })
    : null
  if (step !== null && step.step_dominated) {
    return invalid('step_dense', { noise_floor_m: sigma, step })
  }

  const fit = fitPlaneRobust(m, { sigma })
  if (fit === null) return invalid('fit_failed', { noise_floor_m: sigma, step })

  if (fit.inlierRatio < MIN_INLIER_RATIO) {
    return invalid('low_inliers', { inlier_ratio: fit.inlierRatio, noise_floor_m: sigma, step })
  }

  // 系数 → 无量纲斜率：除以像素的物理边长。
  // 列方向（x/nx）是快扫轴，行方向（y/ny）是慢扫轴。
  const mPerPxX = widthM / nx
  const mPerPxY = heightM / ny
  const slopeFast = fit.a / mPerPxX
  const slopeSlow = fit.b / mPerPxY

  const scanAngleDeg = opts.scanAngleDeg ?? 0
  const rotated = Math.abs(scanAngleDeg) > 1e-9
  const [slopeX, slopeY] = rotated ? rotateSlope(slopeFast, slopeSlow, scanAngleDeg) : [slopeFast, slopeSlow]

  const mag = Math.hypot(slopeX, slopeY)
  const diagM = Math.hypot(widthM, heightM)

  return {
    valid: true,
    invalid_reason: '',
    tilt_x_deg: degrees(Math.atan(slopeX)),
    tilt_y_deg: degrees(Math.atan(slopeY)),
    tilt_fast_deg: degrees(Math.atan(slopeFast)),
    tilt_slow_deg: degrees(Math.atan(slopeSlow)),
    slope_mag_deg: degrees(Math.atan(mag)),
    z_span_m: diagM * mag,
    // 帧法**恒为 false**：慢扫轴上图像顶部与底部相隔整帧时长，那段时间里的热漂移
    // 与真实倾斜无法区分。要两个方向都可信，用恒流内接圆（TiltProbeCircle）。
    slow_axis_trusted: false,
    inlier_ratio: fit.inlierRatio,
    noise_floor_m: sigma,
    rotation_applied: rotated,
    step,
  }
}

/** `math.degrees`。单独一个函数是为了让它在金样比对里有名字。 */
function degrees(rad: number): number {
  return (rad * 180) / Math.PI
}

/** `math.radians`。 */
function radians(deg: number): number {
  return (deg * Math.PI) / 180
}

// ── 圆法的两个标量（`AutoTilt` 要的那两件）───────────────────────────────

/**
 * 圆法能分辨的最小倾斜角（度，1σ）= `σ_z·√(2/n) / r`。
 *
 * 这是个**硬的测量下限**，与算法无关：要测更小的倾斜，只能加大半径、加密取点或
 * 降低噪声。旧仓实测（15.4 pm 噪声、20 nm 半径、24 点）1σ ≈ 0.013°，
 * 200 次里的最大偏差 0.068°。
 *
 * **调平例程的验收阈必须留在这个分辨率之上** —— 否则「残余倾斜没达标」只是在追噪声。
 * 三个入参任一不为正就给 `0.0`（= 「这个问题答不了」，而 0 在下游是
 * 「不抬高验收阈」，与旧仓同）。
 */
export function circleTiltResolutionDeg(noiseFloorM: number, radiusM: number, nPoints: number): number {
  if (!(radiusM > 0 && nPoints > 0 && noiseFloorM > 0)) return 0.0
  return degrees((noiseFloorM * Math.sqrt(2.0 / nPoints)) / radiusM)
}

/**
 * 给定倾斜角与帧对角线，算这一帧会吃掉多少 Z 量程（米）= `L · tan(θ)`。
 *
 * 这是触发判据用的**统一物理量**。用它而不是「粗扫一个角度阈值、精扫另一个」的
 * 好处：同样 0.3° 在 1 µm 帧上吃掉 5.2 nm 的 Z，在 10 nm 帧上只吃 52 pm ——
 * 「粗扫敏感、精扫宽容」自动成立，少一个自由度，而且**防 Z 打满**这个物理动机
 * 直接可见。
 */
export function zSpanForFrame(slopeMagDeg: number, frameDiagonalM: number): number {
  return frameDiagonalM * Math.tan(radians(slopeMagDeg))
}
