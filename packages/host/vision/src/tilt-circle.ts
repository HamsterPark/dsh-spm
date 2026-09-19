/**
 * 恒流内接圆测倾斜的拟合 —— 旧仓 `mast/vision/tilt.py` 的 `CircleTilt`(37) +
 * 四个 `CIRCLE_*` 常量 + `fit_circle_tilt`(99)。`TiltProbeCircle` 的判据本体。
 *
 * ## 模型是**线性**的，所以一次最小二乘就够
 *
 * 反馈开着让针尖沿一个圆走一圈，恒流下 Z 跟随表面，于是
 *
 * ```
 * Z(θ) = slope_x · r·cos θ + slope_y · r·sin θ + C   [ + drift · (t − t̄) ]
 * ```
 *
 * 对 `(A, B, C[, D])` 是线性的 —— 不需要迭代，也不需要初值。
 *
 * ## 为什么用圆而不是拟合整帧
 *
 * 整圈在几秒内跑完，两个方向是在**同一个时间尺度**上测的；而一帧图的慢扫轴跨越
 * 整帧时长（几十分钟），那段时间的热漂移与真实倾斜无法区分。
 * 所以这里 `slow_axis_trusted` 恒为 `true`，而帧法（`tilt-frame.ts`）恒为 `false`。
 *
 * ## 否决判据：**不能用残差 RMS 当主判据**
 *
 * 台阶的基频分量会被正弦拟合**吸收成一个假倾斜**：半圈抬高 `h` 的方波，其基频
 * 振幅是 `0.64h`，剩给残差的只有高次谐波。旧仓 2026-07-30 的实测标定
 * （24 点、15.4 pm 噪声、240 pm 原子台阶）：
 *
 * | 输入 | 残差RMS/σ | max\|残差\|/σ | 最大相邻跳变/σ |
 * |---|---|---|---|
 * | 平面（40 seed 最大） | 1.20 | 3.56 | 5.18 |
 * | 120 pm 台阶（最小） | 1.31 | 2.77 | 4.42 ← **半个原子台阶测不出** |
 * | 240 pm 台阶（最小） | 2.55 | 6.00 | 11.14 |
 * | 500 pm 污染物（最小） | 5.95 | 26.81 | 32.01 |
 *
 * 所以主判据是**残差里的相邻点跳变**（环形，最后一点接回第一点）：
 * 台阶是一个**不连续**，而正弦拟合无论如何都消不掉不连续。
 *
 * ## 容差
 *
 * | 件 | 容差 | 推导 |
 * |---|---|---|
 * | `n_points` / `valid` / `invalid_reason` / `slow_axis_trusted` | **0** | 计数与结论 |
 * | 角度与残差比 | {@link CIRCLE_REL_TOL} | 设计阵 `[cos, sin, 1(, t)]` 的 κ ≈ 1（正交），QR 与 SVD 之差在 `eps` 量级；再叠一次 `atan` 的 1 ulp |
 * | `downhill_deg` | 同上 | `atan2` + Python 取模（走 `pyMod`，**不是** `((x%360)+360)%360`） |
 */
import { pyMod } from 'dsh-spm-kernel'
import { lstsqQr } from 'dsh-spm-numerics'

/** 圆法的残差否决线：`max|残差| / σ` 超过它就判「这圈不是一个单一斜面」。平面实测最大 3.56。 */
export const CIRCLE_MAX_RESIDUAL_SIGMA = 4.5

/** 圆法的**主**否决线：残差里最大相邻跳变 / σ。平面实测最大 5.18。 */
export const CIRCLE_MAX_JUMP_SIGMA = 7.0

/** 残差 RMS 只作诊断展示，**不参与否决**（分辨力太低，见抬头那张表）。 */
export const CIRCLE_RESIDUAL_MAX_RATIO = 4.0

/** 至少要几个点才拟合（3 个参数 A/B/C，冗余度太低的拟合没有残差可言）。 */
export const CIRCLE_MIN_POINTS = 8

/**
 * **角度一族**（`tilt_x_deg` / `tilt_y_deg` / `slope_mag_deg` / `downhill_deg`）
 * 的相对容差。
 *
 * 设计阵的三列 `[cos θ, sin θ, 1]` 在均匀取点的圆上**互相正交**（`n = 24` 时
 * κ = 1.41），于是 QR 与 LAPACK 的 SVD 各自 `κ·eps`；再叠 `atan` / `atan2`
 * 各 1 ulp ⇒ `≈ 1e−15`。**实测最坏 `7.9e−15`**（`radius_clamped_low` 那一格）。
 *
 * 取 `1e−12`（约 100 倍余量）。这几个数是**真的拿去调硬件**的那几个，
 * 所以它们不跟下面那条宽的共用一把尺子 —— 一条盖得住一切的容差不是判据。
 */
export const CIRCLE_REL_TOL = 1e-12

/**
 * **残差派生量与漂移系数**（`residual_*` / `max_*_ratio` / `drift_rate_m_s`）
 * 的相对容差。
 *
 * 为什么比角度那条宽三个量级，两条原因叠在一起：
 *
 * 1. **相消**：残差是 `z − A·c`，两个近乎相等的数相减。`|z| ≈ 1e−9`、
 *    `|resid| ≈ 7e−13` ⇒ 相对精度被放大 `≈ 1.4e3` 倍；
 * 2. **小分量**：`drift_rate` 是解向量里最小的那个分量，而最小二乘的误差界写在
 *    **范数**上（同批 6c 的 `coef_ratio` 那一条）。
 *
 * `1.4e3 × 4·κ·eps ≈ 2e−12`，而**实测最坏 `1.1e−11`**（`radius_clamped_high`
 * 的 `drift_rate_m_s`）。取 `1e−9`，约 90 倍余量。
 *
 * ⚠️ 这条宽容差**只给这几个诊断字段**。它们不参与调硬件，参与的是
 * `max_jump_ratio > 7` 这个比较 —— 而那一条在 4.1 与 39.9 之间做判断，
 * 不在第十二位上。
 */
export const CIRCLE_RESIDUAL_REL_TOL = 1e-9

/** 圆拟合的结果。字段名与旧仓 `CircleTilt.as_dict()` 逐字一致。 */
export interface CircleTilt {
  readonly valid: boolean
  readonly invalid_reason: string
  readonly tilt_x_deg: number
  readonly tilt_y_deg: number
  readonly slope_mag_deg: number
  /** 下坡方向（度，从 +x 轴逆时针）。 */
  readonly downhill_deg: number
  readonly residual_rms_m: number
  readonly residual_ratio: number
  readonly max_residual_ratio: number
  readonly max_jump_ratio: number
  /** 由圆闭合差估出的线性漂移速率（米/秒），**已从数据里扣除**。 */
  readonly drift_rate_m_s: number
  readonly n_points: number
  /** **两个方向同样可信** —— 整圈在几秒内跑完，不像帧法那样慢轴混着漂移。 */
  readonly slow_axis_trusted: boolean
}

function base(n: number, extra: Partial<CircleTilt> = {}): CircleTilt {
  return {
    valid: false,
    invalid_reason: '',
    tilt_x_deg: 0.0,
    tilt_y_deg: 0.0,
    slope_mag_deg: 0.0,
    downhill_deg: 0.0,
    residual_rms_m: 0.0,
    residual_ratio: 0.0,
    max_residual_ratio: 0.0,
    max_jump_ratio: 0.0,
    drift_rate_m_s: 0.0,
    n_points: n,
    slow_axis_trusted: true,
    ...extra,
  }
}

/** {@link fitCircleTilt} 的可选项。 */
export interface FitCircleOptions {
  /** 每个点的采样时刻。给了就顺带拟合一个**线性漂移项**并扣除。 */
  readonly timesS?: readonly number[] | null
  readonly noiseFloorM?: number
}

/**
 * 把恒流内接圆上的 `Z(θ)` 拟合成倾斜。
 *
 * `timesS` 给出每个点的采样时刻时，顺带拟合一个**线性漂移项**并扣除 ——
 * 圆虽然跑得快，但几秒里仍可能漂几十皮米，而漂移在圆上表现为一个与 θ 无关、
 * 与时间线性相关的分量，正好可以从倾斜里分离出来。**这就是「圆闭合差」的严格版。**
 *
 * 漂移列只在 `t.length === n` **且**全部有限**且** `max(t) − min(t) > 0` 时才加 ——
 * 三个条件缺一个，那一列就是常数，与截距列共线。
 */
export function fitCircleTilt(
  anglesRad: readonly number[],
  zValues: readonly number[],
  radiusM: number,
  opts: FitCircleOptions = {},
): CircleTilt {
  if (anglesRad.length !== zValues.length) return base(0, { invalid_reason: 'shape_mismatch' })

  // `finite = isfinite(theta) & isfinite(z)` —— 两边同时筛，下标要对齐。
  const keep: number[] = []
  for (let i = 0; i < anglesRad.length; i += 1) {
    if (Number.isFinite(anglesRad[i] as number) && Number.isFinite(zValues[i] as number)) keep.push(i)
  }
  const n = keep.length
  if (n < CIRCLE_MIN_POINTS) return base(n, { invalid_reason: 'too_few_points' })
  if (!(radiusM > 0)) return base(n, { invalid_reason: 'bad_radius' })

  const theta = Float64Array.from(keep, (i) => anglesRad[i] as number)
  const z = Float64Array.from(keep, (i) => zValues[i] as number)

  const cols: Float64Array[] = [
    Float64Array.from(theta, Math.cos),
    Float64Array.from(theta, Math.sin),
    new Float64Array(n).fill(1),
  ]
  let hasDrift = false
  const timesS = opts.timesS ?? null
  if (timesS !== null) {
    // ⚠️ 旧仓是 `np.asarray(times_s)[finite]` —— 掩膜作用在**原始长度**的时间数组上。
    // 所以长度不等时它会抛/截断；这里照它的语义：只有长度与原始角度数组相同时
    // 才谈得上取掩膜，取完之后再比 `t.size == n`。
    if (timesS.length === anglesRad.length) {
      const t = Float64Array.from(keep, (i) => timesS[i] as number)
      let lo = Infinity
      let hi = -Infinity
      let allFinite = true
      for (const v of t) {
        if (!Number.isFinite(v)) allFinite = false
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (allFinite && hi - lo > 0) {
        let s = 0
        for (const v of t) s += v
        const mean = s / n
        cols.push(Float64Array.from(t, (v) => v - mean))
        hasDrift = true
      }
    }
  }

  let coeff: Float64Array
  try {
    coeff = lstsqQr(cols, z)
  } catch {
    return base(n, { invalid_reason: 'fit_failed' })
  }
  for (let i = 0; i < coeff.length; i += 1) {
    if (!Number.isFinite(coeff[i] as number)) return base(n, { invalid_reason: 'fit_failed' })
  }

  const a = coeff[0] as number
  const b = coeff[1] as number
  const driftRate = hasDrift ? (coeff[3] as number) : 0.0

  const resid = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    let pred = 0
    for (let c = 0; c < cols.length; c += 1) pred += (coeff[c] as number) * ((cols[c] as Float64Array)[i] as number)
    resid[i] = (z[i] as number) - pred
  }
  let sq = 0
  let maxResid = 0
  for (const r of resid) {
    sq += r * r
    if (Math.abs(r) > maxResid) maxResid = Math.abs(r)
  }
  const residRms = Math.sqrt(sq / n)

  // 环形的相邻差分（最后一点接回第一点）：台阶是一个**不连续**，
  // 而正弦拟合无论如何都消不掉不连续 —— 这是分离带最好的那个信号。
  //
  // ⚠️ `np.argsort` 缺省是 **quicksort（不稳定）**，而这里按 θ 排。本仓用
  // 「值相同时按下标」的稳定排序：真机上 θ 由 `2πk/n` 生成，互不相同，
  // 两者给同一个序；而并列时稳定排序至少是**可复现**的，quicksort 不是。
  const order = keep.map((_v, i) => i).sort((p, q) => {
    const d = (theta[p] as number) - (theta[q] as number)
    return d !== 0 ? d : p - q
  })
  let maxJump = 0
  for (let i = 0; i < n; i += 1) {
    const cur = resid[order[i] as number] as number
    const nxt = resid[order[(i + 1) % n] as number] as number
    const d = Math.abs(nxt - cur)
    if (d > maxJump) maxJump = d
  }

  const slopeX = a / radiusM
  const slopeY = b / radiusM
  const mag = Math.hypot(slopeX, slopeY)

  const noise = opts.noiseFloorM ?? 0
  const ratio = noise > 0 ? residRms / noise : 0.0
  const jumpRatio = noise > 0 ? maxJump / noise : 0.0
  const peakRatio = noise > 0 ? maxResid / noise : 0.0

  const diag = {
    residual_rms_m: residRms,
    residual_ratio: ratio,
    max_residual_ratio: peakRatio,
    max_jump_ratio: jumpRatio,
    drift_rate_m_s: driftRate,
    n_points: n,
  }

  // 圆上有台阶 / 污染 / 针尖事件时的否决。**RMS 不参与**，见抬头那张表。
  if (noise > 0 && (peakRatio > CIRCLE_MAX_RESIDUAL_SIGMA || jumpRatio > CIRCLE_MAX_JUMP_SIGMA)) {
    return base(n, { invalid_reason: 'residual_too_large', ...diag })
  }

  return base(n, {
    valid: true,
    tilt_x_deg: (Math.atan(slopeX) * 180) / Math.PI,
    tilt_y_deg: (Math.atan(slopeY) * 180) / Math.PI,
    slope_mag_deg: (Math.atan(mag) * 180) / Math.PI,
    // `% 360` 走 Python 的取模 —— `atan2` 给负角时 JS 的 `%` 留负数。
    downhill_deg: pyMod((Math.atan2(-slopeY, -slopeX) * 180) / Math.PI, 360.0),
    ...diag,
  })
}
