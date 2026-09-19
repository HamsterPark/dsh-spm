/**
 * 旧仓 `mast/vision/tip_metrics.py` 里批 4b **没落**的那两件：
 * `_edge_resolution`（19 行）与 `_fwd_bwd_instability`（46 行）。
 *
 * ## ⚠️ 这个文件住错了地方 —— 它该在 `packages/host/vision/tip-metrics.ts`
 *
 * 判断标准只有一条（`vision/nd.ts` 抬头）：**它有没有第二个消费方？**
 * 这两件有两个：`AssessTipSharpness`（本批）与 `PreScanCheck`（批 4d §5.2 在等
 * `_fwd_bwd_instability`）。批 5b §7.3 已经把它们点名要放进 `vision/tip-metrics.ts`
 * —— 那里已经住着同一个 Python 文件的另外两件（`detrend32` / `fftSharpness`）。
 *
 * **这一轮 `packages/host/vision/` 由另一条支线主用，本支线一个字节都不碰。**
 * 所以它们暂住在技能层，搬家时是一次机械移动（本文件零技能层依赖：
 * 只 import `dsh-spm-numerics` 与 `dsh-spm-vision`）。写进交接，由主线统一放。
 *
 * ## 精度：旧仓这一整条链**都在 float32 里**，本仓在 float64
 *
 * 批 4b 在 `tip-metrics.ts` 抬头记过同一件事，这里更长一截：
 *
 * | 步 | 旧仓 | 本仓 |
 * |---|---|---|
 * | `judge_frame.detrended` | `.astype(np.float32)` | 一样（`detrend` 逐元素 `fround`） |
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
 */
import {
  gaussianFilter2d,
  fft2,
  ifft2,
  matAt,
  matOf,
  median,
  percentile,
  EPS,
  type Complex2d,
  type Mat,
} from 'dsh-spm-numerics'
import { detrend, EPS32, gradient2d } from 'dsh-spm-vision'

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
