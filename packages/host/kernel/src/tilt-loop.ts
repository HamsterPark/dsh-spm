/**
 * 自动调平闭环的**判定核心** —— 旧仓 `mast/skills/composite/auto_tilt.py` 里
 * 那些不碰仪器、不读时钟的算术：触发 / 验收 / 硬红线三条阈、控制律 `Δtilt = G·s`、
 * 限步与限幅、收敛判据，以及标定那一侧的响应矩阵求逆与条件数。
 *
 * 判定搬进 `kernel` 的先例是 `engage.ts`（「每一条判据对应一次真机事故」）。
 * 同一条理由在这里更强：**猜错符号不是把倾斜去掉，是把它加倍**，
 * 而这件事的全部证据就是这几行算术。
 *
 * ## `kernel` 不依赖 `numerics`（PLAN 的结构约束），所以条件数在这里自己算
 *
 * 只有 2×2，闭式解写得出来，见 {@link cond2x2}。**这不是「再写一份」** ——
 * `numerics` 里没有 `cond`，而把一个 2×2 的奇异值搬去 `numerics` 只会让
 * `kernel` 反过来依赖它。
 *
 * ## 为什么这一层一条时钟、一次 `safeCall` 都没有
 *
 * 旧仓那 654 行里真正做决定的不到 60 行，其余是 TCP、`time.sleep` 与报文。
 * 把这 60 行摘出来，它们就能被一张**表**验证（金样 `tilt.json` 的
 * `thresholds` / `control_law` / `calibration` 三节），而不是靠排一遍完整的假仪器。
 */

// ── 触发 / 验收判据（偏好级，可在设置里改）────────────────────────────────
//
// 统一物理量是「这一帧的斜坡吃掉多少 Z 量程」`z_span = L·tan(θ)`。用它而不是
// 「粗扫一个角度阈值、精扫另一个」：同样 0.3° 在 1 µm 帧上吃掉 5.2 nm 的 Z，
// 在 10 nm 帧上只吃 52 pm —— 粗扫敏感、精扫宽容自动成立，少一个自由度，
// 而且「防 Z 打满 / 防帧角撞边」这个物理动机直接可见。

/** 触发调平：帧内斜坡吃掉的 Z 量程超过总量程的这个比例。 */
export const DEFAULT_Z_BUDGET_FRAC = 0.05

/** 触发调平：斜坡高过表面自身起伏这个倍数时，形貌已被斜坡淹没。 */
export const DEFAULT_K_TOPO = 10.0

/** 硬红线：超过总量程这个比例，帧边缘有 rail / 撞边风险，必须调。 */
export const Z_SPAN_HARD_LIMIT_FRAC = 0.2

/** 验收阈 = 触发阈 × 这个系数（迟滞，防边界抖动反复触发）。 */
export const ACCEPT_FRAC_OF_TRIGGER = 0.5

/**
 * 单次施加的最大倾斜增量（度）。tilt 阶跃会让扫描平面突转 → Z 瞬态；
 * **小步 + 反馈开着是防撞针的硬要求**，这是「试错 nudge」根本不知道的安全细节。
 */
export const MAX_TILT_STEP_DEG = 1.0

/** 每小步之后的稳定时间（秒）。 */
export const TILT_STEP_SETTLE_S = 1.0

/** 闭环最多迭代几轮。 */
export const MAX_ITERATIONS = 3

/** 一轮之后残差没降到上一轮的这个比例以下 = 发散（标定失效 / 表面变了 / 针尖事件）。 */
export const CONVERGENCE_RATIO = 0.7

/**
 * 标定用的试探步长（度）。小到无害，大到可测：0.2° 在 100 nm 跨度上产生 350 pm
 * 的斜坡，远高于典型噪声底。
 */
export const CALIB_STEP_DEG = 0.2

/** 标定健全性：测到的响应幅度必须落在试探步长的这个倍数区间内。 */
export const CALIB_RESPONSE_MIN = 0.3
/** 同上，上界。 */
export const CALIB_RESPONSE_MAX = 3.0

/** 响应矩阵奇异判据：`|det|` 低于它就拒绝求逆。 */
export const TILT_DET_EPSILON = 1e-9

/** 三条阈，单位全是**米**（「斜坡吃掉多少 Z」）。 */
export interface TiltThresholds {
  readonly trigger: number
  readonly accept: number
  readonly hard: number
}

/**
 * `(触发阈, 验收阈, 硬红线)`。
 *
 * **有两个独立的调平理由，取「或」而不是「与」**：
 *
 * * **安全**：斜坡吃掉太多 Z 量程，帧角上有 rail / 撞边风险
 *   （`z_span > z_budget_frac × z_range`）；
 * * **数据质量**：斜坡把形貌淹没了 —— 这正是用户说的「图明显是倾斜的」
 *   （`z_span > k_topo × 表面起伏`）。
 *
 * 任一成立就该调平，所以触发阈取两者的**较小值**。
 *
 * ⚠️ 旧仓这里**一度写的是 `max`**，等价于「两个都超才调」，而表面起伏那一项永远
 * 小得多 —— 于是「图明显倾斜」这个最主要的场景**一次也触发不了**。
 * 这条缺陷是这个函数存在的全部理由，`min` 那一行是它的现场。
 *
 * `surfaceRmsM` 缺省（没有帧可参考，例如只做了一次圆测量）时只用安全判据。
 * **不要把圆拟合的残差当表面起伏塞进来**：圆是特意跑在平地上的，它的残差按构造
 * 就是噪声，那样算出来的阈值是个噪声阈值，不是形貌阈值。
 *
 * ⚠️ `surfaceRmsM` 走旧仓的 `if surface_rms_m and float(...) > 0` ——
 * **0 与缺省同义**（与 D-ZERO-1 刻意相反）：0 的表面起伏会让触发阈变成 0，
 * 于是每一帧都要调平。
 */
export function tiltThresholds(surfaceRmsM: number | null | undefined, zRangeM: number): TiltThresholds {
  const safety = DEFAULT_Z_BUDGET_FRAC * zRangeM
  let trigger = safety
  if (surfaceRmsM !== null && surfaceRmsM !== undefined && surfaceRmsM > 0) {
    trigger = Math.min(trigger, DEFAULT_K_TOPO * surfaceRmsM)
  }
  return { trigger, accept: trigger * ACCEPT_FRAC_OF_TRIGGER, hard: Z_SPAN_HARD_LIMIT_FRAC * zRangeM }
}

/** 2×2，按行。`G` 存的是 `−M⁻¹`：要抵消测到的斜率 `s`，施加 `Δtilt = G·s`。 */
export type Matrix2 = readonly [readonly [number, number], readonly [number, number]]

/** 控制律 `Δtilt = G·s`。**行优先**，写错就是把 x 的补偿加到 y 上。 */
export function tiltDelta(g: Matrix2, slopeX: number, slopeY: number): [number, number] {
  return [g[0][0] * slopeX + g[0][1] * slopeY, g[1][0] * slopeX + g[1][1] * slopeY]
}

/**
 * 一次增量要拆成几小步：`max(1, ceil(|Δ| / MAX_TILT_STEP_DEG))`。
 *
 * `max(1, …)` 那一层不是防御性编程 —— `|Δ| == 0` 时 `ceil(0) == 0`，
 * 而 0 小步意味着**一次都不写**，却照样往下走到「复测 → 验收」。
 * 那时报出来的 `applied` 描述的是一次没发生过的施加。
 */
export function tiltSubSteps(magDeg: number): number {
  return Math.max(1, Math.ceil(magDeg / MAX_TILT_STEP_DEG))
}

/**
 * 单轴限幅：越界**夹到边界并置 `truncated`**，不是拒绝。
 *
 * 与本仓「越界一律拒绝、不夹紧」的通则**相反**，而这是旧仓的现状、也说得通：
 * 这里夹的是一个由闭环自己算出来的中间量（不是用户给的参数），
 * 而夹完之后 `truncated_at_limit` 会**跟着每一轮的 history 走**——
 * 「我夹过」这件事没有被藏起来。参数侧的越界仍然一律拒绝。
 */
export function clampTiltAxis(target: number, limitDeg: number): { readonly value: number; readonly truncated: boolean } {
  if (Math.abs(target) > limitDeg) {
    // Python 的 `math.copysign(limit, target)` —— `target` 是 `-0` 时给 `-limit`。
    return { value: Math.sign(target) < 0 || Object.is(target, -0) ? -limitDeg : limitDeg, truncated: true }
  }
  return { value: target, truncated: false }
}

/**
 * 这一轮算不算**在收敛**：`newSpan <= span × CONVERGENCE_RATIO`。
 *
 * 判据写成「没收敛」的反面，是因为调用点上那一支要回滚 —— 而回滚的目标是
 * **原始**倾斜，不是上一轮。一个「差不多在降」的闭环会把针尖一路带到量程边上。
 */
export function tiltConverging(newSpanM: number, prevSpanM: number): boolean {
  return !(newSpanM > prevSpanM * CONVERGENCE_RATIO)
}

/** 标定：一个轴的响应幅度算不算合理（闭区间，两端都放行）。 */
export function calibResponseInRange(mag: number): boolean {
  return CALIB_RESPONSE_MIN <= mag && mag <= CALIB_RESPONSE_MAX
}

/** {@link responseToG} 的产出。`g` 为 `null` = 响应矩阵奇异。 */
export interface ResponseSolution {
  readonly det: number
  readonly g: Matrix2 | null
}

/**
 * `M` → `G = −M⁻¹`。`|det| < `{@link TILT_DET_EPSILON}` 时给 `null`（两轴响应共线）。
 *
 * `M` 的**列** = 每个 tilt 轴引起的测量斜率变化。响应是**二维向量**：x 轴的一步
 * 可能主要出现在测到的 y 上（轴交换），这正是要把它解成矩阵而不是两个标量的原因。
 */
export function responseToG(m: Matrix2): ResponseSolution {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0]
  if (Math.abs(det) < TILT_DET_EPSILON) return { det, g: null }
  const inv: Matrix2 = [
    [m[1][1] / det, -m[0][1] / det],
    [-m[1][0] / det, m[0][0] / det],
  ]
  return {
    det,
    g: [
      [-inv[0][0], -inv[0][1]],
      [-inv[1][0], -inv[1][1]],
    ],
  }
}

/**
 * `np.linalg.cond(M)`（**2-范数**）—— 2×2 的闭式解。
 *
 * ```
 * p = hypot(a + d, b − c)      q = hypot(a − d, b + c)
 * σmax = (p + q) / 2           σmin = |p − q| / 2
 * ```
 *
 * ## 为什么不走 `√((S ± √(S² − 4·det²)) / 2)`
 *
 * 那个式子在 `S² ≫ 4·det²`（= 近奇异，也就是这道闸真正要判的那一档）上
 * **相消**：`S − √(S² − 4det²)` 的有效位数按 `det²/S²` 掉。而 `p`、`q` 两个
 * `hypot` 各自向后稳定，`|p − q|` 只在两轴响应几乎相同时相消，
 * 而那对应 σmin ≈ 0 —— 那时 cond 本来就要报 `Infinity`，不是要报得准。
 *
 * ## 容差
 *
 * 对面是 LAPACK `gesdd`。两边都向后稳定 ⇒ σ 的绝对误差 `≈ eps·σmax`，
 * 于是 `cond` 的相对误差 `≈ eps·cond`。这道闸的线在 **10**，
 * 而 `eps·10 ≈ 2e−15` —— 判据落在 `TILT_COND_REL_TOL` 上，金样逐格录 cond。
 *
 * σmin 为 0 时给 `Infinity`（numpy 同：`cond` 对奇异矩阵给 `inf`）。
 */
export function cond2x2(m: Matrix2): number {
  const a = m[0][0]
  const b = m[0][1]
  const c = m[1][0]
  const d = m[1][1]
  const p = Math.hypot(a + d, b - c)
  const q = Math.hypot(a - d, b + c)
  const sMax = (p + q) / 2
  const sMin = Math.abs(p - q) / 2
  if (sMin === 0) return Infinity
  return sMax / sMin
}

/**
 * {@link cond2x2} 对 numpy 的相对容差 —— **随 cond 走，不是一个常数**。
 *
 * 推导见 {@link cond2x2}：两边都向后稳定 ⇒ σ 的**绝对**误差 `≈ eps·σmax`，
 * 于是 `cond = σmax/σmin` 的**相对**误差 `≈ eps·cond`。乘 4 倍余量，
 * 口径与 `numerics` 的 `lstsqObservedTol` 同族。
 *
 * ⚠️ 第一版写成了一个常数 `1e−14`，而那在 `cond ≈ 4e7` 的那一格上差三个量级
 * （实测相对差 `4.4e−9`，而 `eps·cond = 8.9e−9`）—— **容差不随被测量的条件数走，
 * 就是在替某一格调参**。
 */
export function cond2x2RelTol(cond: number): number {
  return 4 * Number.EPSILON * Math.max(1, Math.abs(cond))
}

/**
 * `Math.hypot` 与 CPython 的 `math.hypot` **不是同一个函数**（D-HYPOT-1）。
 *
 * 实测：`hypot(1e−7, 1e−7)` 两边差 1 ULP，`hypot(3e−7, 2e−7)` 一样。
 * 换成 `sqrt(x² + y²)` 不解决问题（D-HYPOT-1 的原话），而且它在 `1e−200` 上下溢。
 *
 * 本批的消费方是**补偿增量的幅度**、**帧对角线**与**合成倾斜角**。
 * 三处都只用来跟阈值比大小或印给人看，最后一位在那两处都表示不出来 ——
 * 所以这一族按 2 ULP 的相对差比，其余字段照旧逐字。
 */
export const HYPOT_REL_TOL = 4.5e-16
