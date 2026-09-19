/**
 * 尺度自适应分割里的**层结构**那一半 —— 旧仓 `mast/vision/seg_scale_adaptive.py`
 * 的 `kde_layers`(15) + `_hist_modes`(30)。
 *
 * ## 只移这两个，不移 `segment_scale_adaptive`
 *
 * 旧仓那个文件 589 行、21 个顶层符号；本批切走的是 **45 行**
 * （`_hist_modes` 第 211–240 共 30 行 + `kde_layers` 第 243–257 共 15 行；
 * 两段之间那两个空行不算，算上就是 49 —— 两个数都核过）。
 *
 * `segment_scale_adaptive`（210 行）与 `summarize_segmentation`（41 行）连同
 * 七八个形态学助手（`_remove_small` / `_remove_streaks` / `_boundary_band` /
 * `_disk` …）**这一轮不移**：它们要 `skimage`（`threshold_otsu` / `white_tophat` /
 * `disk`）与 `ndi.percentile_filter` / `binary_dilation` / `find_objects`，
 * 而本仓此刻没有一个技能要它的返回值 —— `FindFlatRegion` 的 `same_terrace`
 * 只要层标签，批 7a-1 的 `estimate_tilt` 把它做成了**注入口**、缺省就落在旧仓
 * 自己那条 `except Exception: return (False, 0.0)` 上。
 *
 * > **半移一个 210 行的分割器，比不移它坏**：那时它既没有金样、又看起来在。
 *
 * ⚠️ **将来那 251 行进来时是往这个文件里加，不是再建一个。** 文件名照旧仓
 * （`seg_scale_adaptive.py`）就是为了让那次合并没有第二个落点可选。
 *
 * ## 依赖闭包（自己往下追了一层）
 *
 * `kde_layers` **不是一个闭包** —— 它函数体里调 `_hist_modes`，而那一件在
 * `blockers-7a.md` 的账上没有名字。往下追到底：
 *
 * ```
 * kde_layers ──► np.gradient(2D) · np.hypot · np.percentile · np.digitize
 *            │   · ndi.median_filter
 *            └─► _hist_modes ──► np.percentile · np.linspace
 *                             · np.histogram(**边界数组**入口) · ndi.gaussian_filter1d
 *                             · scipy.find_peaks · np.argsort / sort / delete
 * ```
 *
 * 其中本仓缺的四件（二维 `gradient` · `linspace` · `digitize` · 按边界数组的
 * `histogram`）落在 `numerics/np-grid.ts`，其余全已有。**再往下没有 `mast.*`。**
 *
 * ## 这一层在做什么（一句话）
 *
 * 一张扣掉一阶平面的形貌图，**高度直方图上的峰就是台面层**。
 * 取梯度低的那些像素（台面内部，不含台阶）做直方图，平滑，找峰，
 * 把**谷太浅**的相邻峰并掉（一个倾斜的台面会在直方图上裂成两个假峰），
 * 剩下的峰之间取中点当分界，`digitize` 出逐像素的层号，最后中值滤波去掉
 * 边界上的椒盐。
 *
 * ## 容差：**全部 0**
 *
 * | 件 | 为什么是 0 |
 * |---|---|
 * | `histModes` 的峰位 | 它返回的是 `ctr[pk]` —— **直方图的格心**，一个搬运出来的数。选错峰是选错格，不是差几个 ulp |
 * | `kdeLayers` 的 `labels` | 整数标签 |
 * | `kdeLayers` 的 `peaks` | 同 `histModes` |
 *
 * 中间量（`cnt` 的高斯平滑、`np.percentile`、`np.hypot`）都是有容差的运算，
 * 但**它们没有一个出现在输出里** —— 输出是下标与格心。所以这一族与
 * `vision/index.ts` 抬头说的一样：**零容差那一档，替有容差的那些档报警**。
 *
 * ## ⚠️ 一处**照移**的旧仓写法
 *
 * `_hist_modes` 在「`hi <= lo`」与「一个峰都没有」两条路上返回
 * `[median(sel)]` —— **一个长度 1 的表**，而 `kde_layers` 看到 `len(peaks) == 1`
 * 就交出**全零标签**。于是「这帧是死平的」与「这帧只有一层台面」给出同一个答案。
 * 那不是缺陷（两种情况下「同层约束自动满足」都成立），但它让调用方分不开
 * 这两件事 —— `FindFlatRegion` 因此在 `layer_labels` 只有一个唯一值时
 * 直接把约束关掉（见那个技能）。**照移，并写下来。**
 */
import {
  argsortDesc,
  digitize,
  findPeaks,
  gaussianFilter1d,
  gradient2dUniform,
  histogramFromEdges,
  linspace,
  matOf,
  medianFilter2d,
  percentile,
  type Mat,
} from 'dsh-spm-numerics'
import { pyRound } from 'dsh-spm-kernel'

/** 直方图的格数（旧仓 `np.linspace(lo, hi, 257)` ⇒ **256 格**）。 */
export const HIST_BINS = 256

/** 直方图的取值范围：样本的第 0.5 与第 99.5 百分位。掐掉两端的离群值。 */
export const HIST_LO_PCT = 0.5
export const HIST_HI_PCT = 99.5

/** 计数曲线的平滑尺度（格）。 */
export const HIST_SMOOTH_SIGMA = 2.0

/** 「强峰」的 prominence 下限 = 这个比例 × 计数曲线的最大值。 */
export const PEAK_PROM_FRAC = 0.04

/** 相邻两个层峰的最小间隔，缺省 = 这个倍数 × 噪声底。 */
export const PEAK_SEP_SIGMA = 4.0

/**
 * 最小间隔的**格数**下限 —— 噪声底极小时不让它退化成「每个毛刺都是一层」。
 *
 * ## ⚠️ 这道闸**没有可分辨的输入**（批 7a-3 量过，写下来）
 *
 * 240 组合成样本（间隔 2–16 格 × `valleyRel` 0.55–0.01 × 四种高度比）逐一比过
 * `max(6, …)` 与 `max(1, …)`，**零处不同**。理由是它被另外两道挡住了：
 * σ=2 的平滑把 6 格以内的两个峰糊成一个鼓包，而就算它们还分得开，
 * `valley > valleyRel · min(峰)` 也会先把它们并掉 ——
 * 两个等高高斯隔 6 格时谷峰比是 **0.64**，仍高于出厂的 0.55。
 *
 * 所以它照移、保留，但**没有为它编金样**（编不出来）。
 * 同批 6c §4.2：「一道闸可以被另一道闸挡住，于是它永远不做决定」；
 * 覆盖率对它一言不发（那一行每次都跑到）。
 */
export const MIN_SEP_BINS = 6

/** 谷 > 这个比例 × 较矮的那个峰 ⇒ 两个峰其实是**一个倾斜的台面**，并掉。 */
export const VALLEY_REL = 0.55

/** 最多留几层。 */
export const MAX_LEVELS = 8

/** 只拿梯度低于这个百分位的像素做直方图（台面内部，不含台阶）。 */
export const LOW_GRAD_PCT = 60

/** 低梯度样本少于这么多就退回整帧 —— 一个百分位在几十个样本上没有意义。 */
export const MIN_SEL_SIZE = 100

/** 层标签的中值滤波窗口（去掉分界上的椒盐）。 */
export const LABEL_MEDIAN_SIZE = 5

/** {@link histModes} / {@link kdeLayers} 的五个可调项（旧仓同名参数）。 */
export interface KdeLayersOptions {
  /** prominence 下限的比例，缺省 {@link PEAK_PROM_FRAC}。 */
  readonly prom?: number
  /** 相邻峰的最小间隔（与输入同单位）。**`0` 与缺省一样**走 `4 × sigN`（Python 的 `or`）。 */
  readonly minSep?: number | null
  /** 谷深合并的比例，缺省 {@link VALLEY_REL}。 */
  readonly valleyRel?: number
  /** 最多留几层，缺省 {@link MAX_LEVELS}。 */
  readonly maxLevels?: number
  /** 低梯度像素的百分位，缺省 {@link LOW_GRAD_PCT}。 */
  readonly lowGradPct?: number
}

/**
 * 一维样本的直方图峰 + 谷深合并 —— 旧仓 `_hist_modes`。**升序返回峰位。**
 *
 * 取值范围掐在 `[p0.5, p99.5]`；`hi <= lo`（样本几乎是常数）⇒ 返回
 * `[median(sel)]`，见文件抬头那条照移。
 */
export function histModes(
  sel: readonly number[] | Float64Array,
  sigN: number,
  opts: KdeLayersOptions = {},
): number[] {
  const prom = opts.prom ?? PEAK_PROM_FRAC
  const valleyRel = opts.valleyRel ?? VALLEY_REL
  const maxLevels = opts.maxLevels ?? MAX_LEVELS
  const lo = percentile(sel, HIST_LO_PCT)
  const hi = percentile(sel, HIST_HI_PCT)
  if (!(hi > lo)) return [percentile(sel, 50)]

  const edges = linspace(lo, hi, HIST_BINS + 1)
  const raw = histogramFromEdges(sel, edges)
  const cnt = gaussianFilter1d(Float64Array.from(raw), HIST_SMOOTH_SIGMA)
  const ctr = new Float64Array(HIST_BINS)
  for (let i = 0; i < HIST_BINS; i += 1) ctr[i] = 0.5 * ((edges[i + 1] as number) + (edges[i] as number))
  const binw = (ctr[1] as number) - (ctr[0] as number)

  // `min_sep or 4·sig_n` —— Python 的 `or`：`None` **与 `0`** 都走右边。
  const sepRaw = opts.minSep === undefined || opts.minSep === null || opts.minSep === 0
    ? PEAK_SEP_SIGMA * sigN
    : opts.minSep
  const sepBins = Math.max(MIN_SEP_BINS, Math.trunc(pyRound(sepRaw / binw, 0)))

  // `find_peaks` 跑在**两端补零**的曲线上：不补的话贴着端点的那个层峰
  // 不算极大值（scipy 的 `_local_maxima_1d` 不认两端），而最低那一层
  // 恰恰常常贴着左端。
  let cntMax = -Infinity
  for (let i = 0; i < cnt.length; i += 1) cntMax = Math.max(cntMax, cnt[i] as number)
  const padded = new Float64Array(HIST_BINS + 2)
  padded.set(cnt, 1)
  const fp = findPeaks(padded, { prominence: cntMax * prom, distance: sepBins })
  if (fp.peaks.length === 0) return [percentile(sel, 50)]

  // `np.clip(pk − 1, 0, len(ctr) − 1)` —— 去掉补的那一格。
  const clipped = Int32Array.from([...fp.peaks].map((p) => Math.min(HIST_BINS - 1, Math.max(0, p - 1))))
  const order = argsortDesc(fp.prominences as Float64Array).slice(0, maxLevels)
  let pk = Int32Array.from([...order].map((i) => clipped[i] as number)).sort()

  // 谷深合并：两个峰之间的谷太浅 ⇒ 那是**一个倾斜的台面**裂成的两个假峰。
  let merged = true
  while (merged && pk.length > 1) {
    merged = false
    for (let j = 0; j < pk.length - 1; j += 1) {
      const a = pk[j] as number
      const b = pk[j + 1] as number
      let valley = Infinity
      for (let i = a; i <= b; i += 1) valley = Math.min(valley, cnt[i] as number)
      if (valley > valleyRel * Math.min(cnt[a] as number, cnt[b] as number)) {
        const dropIdx = (cnt[a] as number) >= (cnt[b] as number) ? j + 1 : j
        pk = Int32Array.from([...pk].filter((_v, i) => i !== dropIdx))
        merged = true
        break
      }
    }
  }
  return [...pk].map((i) => ctr[i] as number)
}

/** {@link kdeLayers} 的产出。`labels` 与输入同形，值是 `0 … peaks.length−1`。 */
export interface LayerMap {
  readonly peaks: readonly number[]
  readonly labels: Int32Array
  readonly rows: number
  readonly cols: number
}

/**
 * 逐像素的台面层标签 —— 旧仓 `kde_layers`。
 *
 * `coarse` 是**扣掉一阶平面之后**的形貌（旧仓的调用方自己扣；
 * ⚠️ 不能用 `flatten_robust`，它的逐行中位数差分会把层结构本身揉掉 ——
 * 实测一道 240 pm 的垂直台阶经它处理后 KDE 只剩一个峰）。
 * `sigN` 是噪声底（行内差分的 MAD），决定两个层峰至少要隔多远。
 *
 * 只有一个峰时 `labels` **全零**（见文件抬头那条照移）。
 */
export function kdeLayers(coarse: Mat, sigN: number, opts: KdeLayersOptions = {}): LayerMap {
  const lowGradPct = opts.lowGradPct ?? LOW_GRAD_PCT
  const [gy, gx] = gradient2dUniform(coarse)
  const g = new Float64Array(coarse.rows * coarse.cols)
  for (let i = 0; i < g.length; i += 1) g[i] = Math.hypot(gy.data[i] as number, gx.data[i] as number)
  const cut = percentile(g, lowGradPct)
  let sel: number[] = []
  for (let i = 0; i < g.length; i += 1) {
    if ((g[i] as number) < cut) sel.push(coarse.data[i] as number)
  }
  if (sel.length < MIN_SEL_SIZE) sel = Array.from(coarse.data)

  const peaks = histModes(sel, sigN, opts)
  const n = coarse.rows * coarse.cols
  if (peaks.length === 1) {
    return { peaks, labels: new Int32Array(n), rows: coarse.rows, cols: coarse.cols }
  }
  const bounds = new Float64Array(peaks.length - 1)
  for (let i = 0; i < bounds.length; i += 1) bounds[i] = 0.5 * ((peaks[i + 1] as number) + (peaks[i] as number))
  const rawLab = new Float64Array(n)
  for (let i = 0; i < n; i += 1) rawLab[i] = digitize(coarse.data[i] as number, bounds)
  const smoothed = medianFilter2d(matOf(coarse.rows, coarse.cols, rawLab), LABEL_MEDIAN_SIZE)
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i += 1) labels[i] = smoothed.data[i] as number
  return { peaks, labels, rows: coarse.rows, cols: coarse.cols }
}
