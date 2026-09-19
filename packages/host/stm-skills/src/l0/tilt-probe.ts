/**
 * `TiltProbeCircle` —— 恒流内接圆测倾斜（Nanonis SmarTilt 做法的自研版）。
 *
 * Nanonis 界面上的 **SmarTilt** 按钮做的事是：反馈开着（恒流），让针尖在当前扫描框的
 * **内接圆**上跑一圈，由 `Z(θ)` 解出样品倾斜。手册里有这个功能，但 **TCP 协议不暴露它**
 * （`nanonis_spm` 里没有任何 SmarTilt / AutoTilt 命令）。所以要自动调平，这一圈必须自己跑。
 *
 * 拟合本体在 `dsh-spm-vision` 的 `tilt-circle.ts`；这一层只有 I/O 与三条**顺序**上的判据。
 *
 * ## 安全性：为什么它是 CONFIRM 而不是 DANGEROUS
 *
 * 反馈必须开着（恒流跟随表面），半径受当前扫描框约束并夹在
 * `[MIN_RADIUS_M, MAX_RADIUS_M]` 里，每一步都是 Follow-Me 的小位移。
 * 这与 DANGEROUS 的 `MoveProbeXY`（任意大位移）本质不同，与 `MoveToXY` 一致。
 * 前置条件 `z_controller_on` / `scan_not_running` 由声明带着走，**不在这一层重写**。
 *
 * ## 三条顺序判据，每条都是「不这么写会怎样」
 *
 * 1. **起点在开圈之前读，回起点写在 `finally` 里。** 异常、abort、硬件报错都不能把
 *    针尖丢在圆周上某个随机角度 —— 那会让调用方之后的**一切位置推理**都错位。
 * 2. **噪声底在圆上估，而且只在第 0 点估。** 与测量点同一工作条件。
 *    ⚠️ 第 0 点的**横移失败**时那次估计被 `continue` 跳过，而 `k == 0` 只来一次 ⇒
 *    噪声底一路 `null` 到底、最后落成 `0.0`，于是**残差否决整条失效**
 *    （`noise > 0` 是它的前提）。这是旧仓的行为，照移；它在金样
 *    `tilt.json` 的 `skills.TiltProbeCircle.first_move_fails` 那一格里。
 * 3. **有效点不足是显式失败，不是「成功但点少」。** 拟合本身还有一条
 *    `CIRCLE_MIN_POINTS`，两道闸给的是两句不同的话。
 */
import {
  formatG,
  pyFixed,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { CIRCLE_MIN_POINTS, fitCircleTilt, madOf } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { body, num } from './common.js'

/**
 * 半径相对当前扫描框短边的默认比例。0.4 = 内接圆（0.5）留一点余量，别贴着框边 ——
 * 框边正是漂移和压电非线性最大的地方。
 */
export const DEFAULT_RADIUS_FRAC = 0.4

/**
 * 半径的绝对下限（米）。保证圆足够大、倾斜产生的 Z 起伏高过噪声：
 * 0.1° 在 20 nm 半径上产生 35 pm，已是典型噪声底的两倍多。
 */
export const MIN_RADIUS_M = 2e-9
/** 半径的绝对上限（米）。 */
export const MAX_RADIUS_M = 5e-7

/** Python 的 `f"{x:.3g}"`。 */
function g3(x: number): string {
  return formatG(x, 3)
}

/** Python 的 `f"{x:+.{n}f}"`。 */
function signed(x: number, n: number): string {
  const s = pyFixed(x, n)
  return s.startsWith('-') ? s : `+${s}`
}

/** 回包里的头两个浮点（`_two_floats`）。取不出给 `null`。 */
function twoFloats(rec: SkillCallRecord): [number, number] | null {
  const b = body(rec)
  if (b.length < 2) return null
  const x = num(rec, 0)
  const y = num(rec, 1)
  return x === null || y === null ? null : [x, y]
}

/** 回包里的第一个浮点（`_first_float`）。 */
function firstFloat(rec: SkillCallRecord): number | null {
  return body(rec).length === 0 ? null : num(rec, 0)
}

/** 几何解析的产出。`ok: false` 时 `why` 是给模型看的那句话。 */
export type Geometry =
  | { readonly ok: true; readonly cx: number; readonly cy: number; readonly radius: number; readonly note: string }
  | { readonly ok: false; readonly why: string }

/**
 * `(cx, cy, radius, note)`。任何一项拿不到就带着原因失败。
 *
 * ⚠️ **只给了 `center_x_m` 一个**时，旧仓那一行
 * `cx, cy = pos if cx is None or cy is None else (cx, cy)` 会把**两个都**换成实测位置
 * —— 给了一半等于没给。照移，并在金样里留一格（`half_center`）。
 */
export async function resolveGeometry(
  ctx: SkillContext,
  params: Readonly<Record<string, unknown>>,
): Promise<Geometry> {
  const asNum = (k: string): number | null => {
    const v = params[k]
    if (v === null || v === undefined || v === '') return null
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }
  let cx = asNum('center_x_m')
  let cy = asNum('center_y_m')
  let radius = asNum('radius_m')
  let note = ''

  if (cx === null || cy === null) {
    const rec = await ctx.safeCall('FolMe_XYPosGet', 1)
    const pos = rec.error === undefined || rec.error === '' ? twoFloats(rec) : null
    if (pos === null) return { ok: false, why: '读不到针尖当前位置(FolMe_XYPosGet)' }
    cx = pos[0]
    cy = pos[1]
  }

  if (radius === null) {
    const rec = await ctx.safeCall('Scan_FrameGet')
    let width: number | null = null
    let height: number | null = null
    if (rec.error === undefined || rec.error === '') {
      const b = body(rec)
      if (b.length >= 4) {
        const w = num(rec, 2)
        const h = num(rec, 3)
        if (w !== null && h !== null) {
          width = Math.abs(w)
          height = Math.abs(h)
        }
      }
    }
    // Python 的 `if not width or not height` —— `0.0` 与 `None` 同义。
    if (width === null || width === 0 || height === null || height === 0) {
      return { ok: false, why: '读不到当前扫描框尺寸,无法推导圆半径 —— 请显式给 radius_m' }
    }
    radius = Math.min(width, height) * DEFAULT_RADIUS_FRAC
    // ⚠️ 这句话里印的是**夹紧之前**的半径（旧仓的顺序），而下面那一行才夹。
    note = `半径由扫描框推导: min(${g3(width)}, ${g3(height)}) × ${DEFAULT_RADIUS_FRAC} = ${g3(radius)} m`
  }

  return { ok: true, cx, cy, radius: Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, radius)), note }
}

/**
 * 在起点重复读 Z 估噪声底（不动针尖，几十毫秒的事）。
 *
 * 用**相邻差分的 MAD**而不是 `std`：重复读之间若有慢漂移，直接取 std 会把漂移
 * 算进噪声。有效读数少于 3 个就给 `0.0`（= 「量不出来」，而 0 在下游意味着
 * 残差否决不生效 —— 这一条写在技能抬头）。
 */
export async function estimateNoise(ctx: SkillContext, n = 8): Promise<number> {
  const reads: number[] = []
  for (let i = 0; i < n; i += 1) {
    const rec = await ctx.safeCall('ZCtrl_ZPosGet')
    const v = rec.error === undefined || rec.error === '' ? firstFloat(rec) : null
    if (v !== null) reads.push(v)
  }
  if (reads.length < 3) return 0.0
  const diffs: number[] = []
  for (let i = 1; i < reads.length; i += 1) diffs.push((reads[i] as number) - (reads[i - 1] as number))
  if (diffs.length === 0) return 0.0
  // `np.median(np.abs(d − np.median(d)))` —— `madOf` 就是这一式（NaN 免疫）。
  const mad = madOf(diffs)
  return (mad * 1.4826) / Math.SQRT2
}

/** 拟合失败原因 → 给模型的那句话。**逐字**，缺省回落成原因码本身（旧仓 `.get(x, x)`）。 */
export function circleFailureText(reason: string, residRmsM: number, residRatio: number): string {
  switch (reason) {
    case 'residual_too_large':
      return (
        `圆周上的 Z 起伏不符合单一倾斜平面(残差 ${formatG(residRmsM, 3)} m = 噪声底的 ` +
        `${pyFixed(residRatio, 1)} 倍)—— 圆多半跨过了台阶或污染物。换一块更平的地方再测。`
      )
    case 'too_few_points':
      return '有效点太少,无法拟合'
    case 'fit_failed':
      return '正弦拟合失败'
    case 'bad_radius':
      return '半径无效'
    case 'shape_mismatch':
      return '角度与 Z 数组长度不一致'
    default:
      return reason
  }
}

export const TiltProbeCircle: Skill = {
  spec: S.TiltProbeCircleSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // 旧仓 `int(params.get("n_points") or 24)` —— **0 与缺席同义**（`or`）。
    const nRaw = Number(params['n_points'] ?? 0)
    const nPoints = Math.trunc(Number.isFinite(nRaw) && nRaw !== 0 ? nRaw : 24)
    // ⚠️ `float(params.get("settle_s") or 0.0)` —— 缺席是 **0.0**，
    // 而声明里的 `default` 是 0.05。两个数不一样，而旧仓走的是这一个。
    const sRaw = Number(params['settle_s'] ?? 0)
    const settleS = Number.isFinite(sRaw) ? sRaw : 0

    const geom = await resolveGeometry(ctx, params)
    if (!geom.ok) return { success: false, error: geom.why }
    const { cx, cy, radius, note } = geom

    const nRawNoise = params['noise_floor_m']
    let noise: number | null =
      nRawNoise === null || nRawNoise === undefined || nRawNoise === '' ? null : Number(nRawNoise)

    // 记下起点，无论成败都要回来。
    const recStart = await ctx.safeCall('FolMe_XYPosGet', 1)
    const start = recStart.error === undefined || recStart.error === '' ? twoFloats(recStart) : null

    const angles: number[] = []
    const zVals: number[] = []
    const times: number[] = []
    const t0 = ctx.now()
    let failures = 0
    let aborted = false

    for (let k = 0; k < nPoints; k += 1) {
      if (ctx.signal.aborted) {
        aborted = true
        break
      }
      const theta = (2.0 * Math.PI * k) / nPoints
      const x = cx + radius * Math.cos(theta)
      const y = cy + radius * Math.sin(theta)

      const recMove = await ctx.safeCall('FolMe_XYPosSet', x, y, 1)
      if (recMove.error !== undefined && recMove.error !== '') {
        failures += 1
        continue
      }
      if (settleS > 0) await ctx.sleep(settleS * 1000)

      if (k === 0 && noise === null) noise = await estimateNoise(ctx)

      const recZ = await ctx.safeCall('ZCtrl_ZPosGet')
      const z = recZ.error === undefined || recZ.error === '' ? firstFloat(recZ) : null
      if (z === null) {
        failures += 1
        continue
      }
      angles.push(theta)
      zVals.push(z)
      times.push((ctx.now() - t0) / 1000)
    }

    // `finally` 那一段：回起点。**abort 也要回** —— 旧仓把它写在 finally 里，
    // 所以中止那一支也发这一次（本仓的中止闸放行 Follow-Me 的收尾，同 `ABORT_SAFE_WRITES`）。
    if (start !== null) await ctx.safeCall('FolMe_XYPosSet', start[0], start[1], 1)

    if (aborted) {
      return {
        success: false,
        error: '用户中止 —— 圆周测量未完成',
        data: { points_done: zVals.length },
      }
    }

    if (zVals.length < CIRCLE_MIN_POINTS) {
      return {
        success: false,
        error:
          `圆周上只取到 ${zVals.length} 个有效点` +
          `(需要 ≥${CIRCLE_MIN_POINTS};${failures} 次读写失败)`,
        data: { points_done: zVals.length, failures },
      }
    }

    const fit = fitCircleTilt(angles, zVals, radius, { timesS: times, noiseFloorM: noise ?? 0.0 })

    const data: Record<string, unknown> = {
      valid: fit.valid,
      invalid_reason: fit.invalid_reason,
      tilt_x_deg: fit.tilt_x_deg,
      tilt_y_deg: fit.tilt_y_deg,
      slope_mag_deg: fit.slope_mag_deg,
      downhill_deg: fit.downhill_deg,
      residual_rms_m: fit.residual_rms_m,
      residual_ratio: fit.residual_ratio,
      max_residual_ratio: fit.max_residual_ratio,
      max_jump_ratio: fit.max_jump_ratio,
      drift_rate_m_s: fit.drift_rate_m_s,
      n_points: fit.n_points,
      slow_axis_trusted: fit.slow_axis_trusted,
      center_x_m: cx,
      center_y_m: cy,
      radius_m: radius,
      noise_floor_m: noise ?? 0.0,
      failed_points: failures,
      elapsed_s: (ctx.now() - t0) / 1000,
    }
    if (note !== '') data['geometry_note'] = note

    if (!fit.valid) {
      // 测量失败是**显式失败**，不是「成功但数值可疑」。台阶穿圆时给一个数字，
      // 下游会拿它去调硬件。
      return { success: false, error: circleFailureText(fit.invalid_reason, fit.residual_rms_m, fit.residual_ratio), data }
    }

    return {
      success: true,
      data,
      summary:
        `倾斜 ${pyFixed(fit.slope_mag_deg, 4)}° ` +
        `(x=${signed(fit.tilt_x_deg, 4)}°, y=${signed(fit.tilt_y_deg, 4)}°), ` +
        `下坡方向 ${pyFixed(fit.downhill_deg, 0)}°, ` +
        `半径 ${pyFixed(radius * 1e9, 1)} nm / ${zVals.length} 点`,
    }
  },
}
