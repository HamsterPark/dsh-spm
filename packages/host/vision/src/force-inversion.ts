/**
 * 旧仓 `mast/vision/force_inversion.py` —— Δf(z) → F(z)、U(z) 的 **Sader–Jarvis 反演**，
 * 以及「这次反演能不能信」的两条读数。
 *
 * > **来处**：批 6c 落在 `stm-skills/src/l0/vision-force-inversion.ts`（那一轮
 * > `packages/host/vision/` 由批 6b 主用），由收尾支线按该批交接 §8 搬来。
 * > 判据、容差、抬头一个字未改，只改了 import 路径。
 *
 * ## 物理
 *
 * 调频 AFM 记的是频移不是力。Sader 与 Jarvis（APL 84, 1801, 2004）的闭式反演：
 *
 * ```
 * F(z) = 2k ∫_z^∞ [ (1 + √A/(8√(π(t−z)))) Ω(t) − A^{3/2}/√(2(t−z)) Ω′(t) ] dt,  Ω = Δf/f₀
 * ```
 *
 * 两个修正项在 `t → z` 上都发散。**第一段区间按 `1/√(t−z)` 解析积分**
 * （`∫₀^h dt/√t = 2√h`），其余按梯形 —— 那正是前几个点稳得住的原因。
 *
 * ## 两条「别信这个数」的读数，各自挡一种假象
 *
 * * **正向残差**：把反演出的力再推回正向积分，与实测 Δf 比。残差大 = 这次反演
 *   没有描述这组数据 —— 无论曲线看起来多漂亮；
 * * **适定性**：Sader 等（Nat. Nanotechnol. 13, 1088, 2018）证明，变化比振幅还快的
 *   力律**根本无法**从 Δf 恢复。这里报振幅 / 衰减长度之比，配一个三态标签 ——
 *   **门限未标定**，所以它是「换个振幅再测一遍」的建议，不是对数值的裁决。
 *
 * ## 容差
 *
 * 整条链在旧仓是 float64。三处不逐位：
 *
 * | 件 | 为什么 | 容差 |
 * |---|---|---|
 * | `a ** 1.5`（`c2`）与 Chebyshev 节点的 `cos` | V8 与 CPython 各自的 libm 都不是正确舍入的，差至多 1 ulp | 进 {@link forceAbsTolFactor} |
 * | `force(zz) @ u`（正向积分的那次矩阵乘） | numpy 走 BLAS，累加顺序不是成对 | 同上 |
 * | `_decay_length` 的 `np.polyfit` | 本仓走正规方程 + 列缩放 | `polyfitRelTol(κ)`，κ 随金样录 |
 *
 * 其余**全部逐位**：`np.gradient(omega, z)` 与 `np.trapezoid` 走
 * {@link gradient1d} / {@link trapezoid}（两件容差都是 0，累加顺序照抄）、
 * `np.cumsum` 是顺序累加、`np.interp` 是一次线性插值、
 * `np.mean` / `np.std` 走成对求和。
 */
import {
  gradient1d,
  npMean,
  npStd,
  polyfit,
  savgolFilter,
  sumRelTol,
  trapezoid,
} from 'dsh-spm-numerics'
import { interp } from './nd.js'
import { polyfitRelTol } from './spectroscopy.js'

export { polyfitRelTol }

/** 1 eV 折合的焦耳。 */
export const EV_J = 1.602176634e-19
/** A/λ 低于它就是「小振幅」，舒舒服服的那一档。 */
export const WELL_POSED_MAX = 0.3
/** A/λ 高于它反演就可疑了。**这两个门限都未标定** —— 它们标注情形，不下结论。 */
export const CAUTION_MAX = 3.0
/** 正向残差超过它，就说明这次反演没有描述这组数据。 */
export const MAX_FORWARD_RESIDUAL = 0.1
/** 正向积分的 Chebyshev 节点数（旧仓 `n_nodes` 的缺省）。 */
export const FORWARD_NODES = 64

/**
 * Sader–Jarvis 一族的**相对**容差（按字段的全批最大绝对值归一）。
 *
 * 推导：两处 libm（`a**1.5` 与 `cos`）各至多 1 ulp ⇒ `2·eps` 进到每一个被积函数值；
 * 梯形求和本身逐位（{@link trapezoid} 容差 0），于是这 `2·eps` 按求和的误差传播
 * 收进 `sumRelTol(n)`；`head + rest` 的相加、`u` 的累积和、正向积分那次
 * BLAS 点乘各再加一份 ⇒ `4·sumRelTol(n)`。取 **16** 留 4 倍余量。
 * 实测最坏占 **0.0020**（`invert_force_curve/smoothed` 的 `forward_residual`）。
 *
 * ⚠️ 它**不**盖住 `decay_length_m` 与 `amplitude_over_decay_length` ——
 * 那两个再经过一次 `log(−F)` 的直线拟合，用 {@link decayLengthRelTol}。
 * `polyfit` 自己那一份（{@link polyfitRelTol}`(κ)`，κ 与解向量分量比随金样录）
 * 比它小一个量级。
 */
export function forceAbsTolFactor(n: number): number {
  return 16 * sumRelTol(n)
}

/**
 * `decay_length_m` 与它的下游 `amplitude_over_decay_length` 的容差 ——
 * **`16 · forceAbsTolFactor(n)`**（相对）。
 *
 * 为什么它比力本身宽一档（形状推得出来，常数是量出来的）：
 *
 * `λ = −1/slope`，而 `slope` 拟合的是 `log(−F)`。`F` 带着 {@link forceAbsTolFactor}
 * 那一档的**相对**误差 δ，而**相对误差进对数就是绝对扰动** —— 一条最小二乘直线的
 * 斜率对 y 的绝对扰动的敏感度是 `1 / Δ(log F)`，也就是**拟合窗内对数力的跨度**。
 * 尾巴衰减得越慢，那个跨度越小，放大越多。
 *
 * `polyfit` 自己那一份（`lstsqObservedTol(κ)`，本族 κ ≤ 37 ⇒ `3.3e−14`）比它小一个
 * 量级，而金样里随每一格录了 κ 与**解向量的分量比**（`coef_ratio`，这一族恒为 1.0
 * —— 斜率就是缩放坐标系里最大的那个分量），所以那一项不是未知数。
 *
 * 实测（本机，`slow_decay_*` 是最窄的那几格，对数跨度 ≈ 0.9）：放大约 **3.3 倍**。
 * 取 16 留 5 倍余量，最坏占容差 **0.21**（`slow_decay_undecidable`）。
 *
 * ⚠️ 这是一条 `savgolObservedTol` 形状的容差（「现在实际达到的水平」）：
 * 形状推得出来、常数量出来。它红的时候先去看是不是有人送进来一条**更平的尾巴**
 * —— 那时该改的是这一条，不是代码。
 */
export function decayLengthRelTol(n: number): number {
  return 16 * forceAbsTolFactor(n)
}

/** 一次反演的全部产物（旧仓 `ForceInversionResult` 的可用子集）。 */
export interface ForceInversionResult {
  readonly verdict: string
  readonly f_min_n: number | null
  readonly z_f_min_m: number | null
  readonly z_df_min_m: number | null
  readonly z_offset_fmin_minus_dfmin_m: number | null
  readonly e_bind_ev: number | null
  readonly decay_length_m: number | null
  readonly forward_residual: number | null
  readonly amplitude_over_decay_length: number | null
  readonly well_posedness: string
  readonly background_used: boolean
  readonly n_points: number
  readonly z_m: readonly number[]
  readonly force_n: readonly number[]
  readonly energy_ev: readonly number[]
  readonly reasons: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * `sader_jarvis` —— 每个 `z`（米，**离表面越远越大**）上的力（牛顿）。
 *
 * ⚠️ `d_omega` 走 `np.gradient(omega, z)` 的**非均匀**那条分支（坐标是数组），
 * 它与「均匀间距 + 标量 dx」那条**数学相等、浮点不等**。照抄的是前者
 * （{@link gradient1d}），因为旧仓传的就是数组。
 */
export function saderJarvis(
  z: Float64Array,
  df: Float64Array,
  opts: { f0Hz: number; kNPerM: number; amplitudeM: number },
): Float64Array {
  const n = z.length
  const omega = Float64Array.from(df, (v) => v / opts.f0Hz)
  const dOmega = gradient1d(omega, z)
  const a = opts.amplitudeM
  const out = new Float64Array(n)
  const c1 = Math.sqrt(a) / (8 * Math.sqrt(Math.PI)) // Ω/√(t−z) 那一项的权重
  const c2 = a ** 1.5 / Math.sqrt(2.0) // Ω′/√(t−z) 那一项的权重
  for (let i = 0; i < n - 1; i += 1) {
    const m = n - i - 1
    const t = new Float64Array(m)
    const integ = new Float64Array(m)
    for (let j = 0; j < m; j += 1) {
      const tj = z[i + 1 + j] as number
      t[j] = tj
      const sq = Math.sqrt(tj - (z[i] as number))
      integ[j] = (1.0 + c1 / sq) * (omega[i + 1 + j] as number) - (c2 * (dOmega[i + 1 + j] as number)) / sq
    }
    // 第一段解析、其余梯形 —— 见文件抬头。
    const h = (t[0] as number) - (z[i] as number)
    const head =
      (omega[i] as number) * h + 2 * Math.sqrt(h) * (c1 * (omega[i] as number) - c2 * (dOmega[i] as number))
    const rest = m > 1 ? trapezoid(integ, t) : 0.0
    out[i] = 2.0 * opts.kNPerM * (head + rest)
  }
  out[n - 1] = n > 1 ? (out[n - 2] as number) : 0.0
  return out
}

/**
 * `forward_df` —— 一条给定的力律会产生什么样的 Δf。**闭环的那一半**。
 *
 * Gauss–Chebyshev 求积（`n_nodes` 个节点）。
 *
 * ⚠️ 旧仓还有一条 `a < 1e-13` 的**小振幅极限**支路（有限差分的 `−f₀/(2k)·F′`）。
 * **本仓不实现它**：`amplitude_m` 的声明下界就是 `1e-13`，而另外两条来源
 * （`.dat` 头 / 振幅列）都要 `1e-13 < v < 1e-8` —— 也就是说那一支
 * **从这个技能出发无论如何走不到**。按消融精神不写，并在这里说明要验它
 * 需要什么：一格 `a ≤ 1e-13` 的入参，而且那一格的答案要与本式在
 * `a → 0` 的极限**不同**（否则两种候选分不开）。
 */
export function forwardDf(
  z: Float64Array,
  force: (zz: number) => number,
  opts: { f0Hz: number; kNPerM: number; amplitudeM: number; nNodes?: number },
): Float64Array {
  const a = opts.amplitudeM
  if (a < 1e-13) {
    throw new RangeError(
      `forwardDf 的小振幅极限（a < 1e-13 m）本仓没有实现：得到 ${a}。` +
        '它在 InvertForceSaderJarvis 这条路上不可达（声明下界就是 1e-13），见函数注释。',
    )
  }
  const nNodes = opts.nNodes ?? FORWARD_NODES
  const u = new Float64Array(nNodes)
  for (let j = 0; j < nNodes; j += 1) u[j] = Math.cos(((2 * (j + 1) - 1) * Math.PI) / (2 * nNodes))
  const pre = -opts.f0Hz / (opts.kNPerM * a * nNodes)
  const out = new Float64Array(z.length)
  for (let i = 0; i < z.length; i += 1) {
    let acc = 0
    for (let j = 0; j < nNodes; j += 1) acc += force((z[i] as number) + a * (1.0 + (u[j] as number))) * (u[j] as number)
    out[i] = pre * acc
  }
  return out
}

/**
 * `_decay_length` —— 力极小之外那条吸引尾巴的指数衰减长度（米）。
 *
 * 取不到（尾巴上正值不足 6 个 / 拟合出来的斜率非负）就回 `null`。
 * **`null` 不是「衰减长度很长」** —— 它是「这条尾巴不是一条指数」，
 * 而上游的适定性判据看到 `null` 会说 `unknown`，不说 `small_amplitude`。
 */
export function decayLength(z: Float64Array, f: Float64Array, iMin: number): number | null {
  const stop = Math.min(iMin + 1 + Math.max(20, Math.trunc((f.length - iMin) / 2)), f.length)
  const zz: number[] = []
  const ff: number[] = []
  for (let i = iMin + 1; i < stop; i += 1) {
    const v = -(f[i] as number)
    if (v > 0) {
      zz.push(z[i] as number)
      ff.push(Math.log(v))
    }
  }
  if (zz.length < 6) return null
  const slope = polyfit(zz, ff, 1)[0] as number
  return slope < 0 ? -1.0 / slope : null
}

/**
 * `invert_force_curve` —— 整套测量：扣背景、反演、并说清这次能信到什么程度。
 *
 * ⚠️ 三条判决的**次序**是判据不是风格：
 *
 * 1. `df_min_at_edge` ⇒ **`undecidable`**。扫程没跨过拐点 ⇒ 势阱没有被夹住，
 *    出来的深度是「某个东西的下界」，不是对阱深的测量；
 * 2. `f_min ≥ 0` 或 `|f_min| < 3·scatter` ⇒ `no_well`（没有阱 / 阱在噪声里）；
 * 3. 振幅相对衰减长度太大**且**正向残差超标 ⇒ `undecidable`。
 *
 * 把第 1 条排在后面，会让一条没夹住阱的曲线先被判成 `no_well` —— 一个
 * 「这里没有键」的**肯定**结论，而实情是「没测到」。
 */
export function invertForceCurve(
  zM: readonly number[] | Float64Array,
  dfHz: readonly number[] | Float64Array,
  opts: {
    f0Hz: number
    kNPerM: number
    amplitudeM: number
    backgroundDfHz?: Float64Array | null
    smoothPoints?: number
  },
): ForceInversionResult {
  const warns: string[] = []
  const z0 = Float64Array.from(zM as Iterable<number>)
  const df0 = Float64Array.from(dfHz as Iterable<number>)
  const none = (verdict: string, reasons: string[], nPoints = 0): ForceInversionResult => ({
    verdict,
    f_min_n: null,
    z_f_min_m: null,
    z_df_min_m: null,
    z_offset_fmin_minus_dfmin_m: null,
    e_bind_ev: null,
    decay_length_m: null,
    forward_residual: null,
    amplitude_over_decay_length: null,
    well_posedness: '',
    background_used: false,
    n_points: nPoints,
    z_m: [],
    force_n: [],
    energy_ev: [],
    reasons,
    warnings: [],
  })
  if (z0.length !== df0.length) return none('undecidable', ['shape_mismatch'])
  const keep: number[] = []
  for (let i = 0; i < z0.length; i += 1) {
    if (Number.isFinite(z0[i] as number) && Number.isFinite(df0[i] as number)) keep.push(i)
  }
  if (keep.length < 20) return none('undecidable', ['too_few_points'], keep.length)
  const order = keep.slice().sort((a, b) => (z0[a] as number) - (z0[b] as number) || a - b)
  const z = Float64Array.from(order, (i) => z0[i] as number)
  let df = Float64Array.from(order, (i) => df0[i] as number)

  let backgroundUsed = false
  const bg = opts.backgroundDfHz ?? null
  if (bg !== null) {
    if (bg.length === z.length) {
      df = Float64Array.from(df, (v, i) => v - (bg[i] as number))
      backgroundUsed = true
    } else {
      warns.push('background_length_mismatch')
    }
  }
  const sp = opts.smoothPoints ?? 0
  if (sp && sp >= 5) {
    // `int(smooth_points) | 1` —— 偶数进来就加一位变奇数（SG 的窗必须是奇数）。
    const w = Math.trunc(sp) | 1
    if (w < z.length) df = Float64Array.from(savgolFilter(df, w, 3))
  }

  let iDf = 0
  for (let i = 1; i < df.length; i += 1) if ((df[i] as number) < (df[iDf] as number)) iDf = i
  if (iDf === 0 || iDf === z.length - 1) warns.push('df_min_at_edge')

  const f = saderJarvis(z, df, opts)
  // 最后一段带着半无穷积分的截断误差，判决不看它。
  const tail = Math.max(4, Math.trunc(z.length / 10))
  const coreStart = 1
  const coreStop = z.length - tail
  let iF = coreStart
  for (let i = coreStart; i < coreStop; i += 1) if ((f[i] as number) < (f[iF] as number)) iF = i
  const fMin = f[iF] as number

  // U(z) = −∫_z^∞ F，远端归零
  const u = new Float64Array(z.length)
  let acc = 0
  u[0] = -0
  for (let i = 1; i < z.length; i += 1) {
    acc += ((z[i] as number) - (z[i - 1] as number)) * 0.5 * ((f[i - 1] as number) + (f[i] as number))
    u[i] = -acc
  }
  const uLast = u[z.length - 1] as number
  for (let i = 0; i < u.length; i += 1) u[i] = (u[i] as number) - uLast
  let uMin = Infinity
  for (let i = coreStart; i < coreStop; i += 1) if ((u[i] as number) < uMin) uMin = u[i] as number
  const eBind = -uMin

  const lam = decayLength(z, f, iF)
  const ratio = lam !== null && lam > 0 ? opts.amplitudeM / lam : null
  const posed =
    ratio === null
      ? 'unknown'
      : ratio < WELL_POSED_MAX
        ? 'small_amplitude'
        : ratio < CAUTION_MAX
          ? 'caution'
          : 'large_amplitude'

  const back = forwardDf(z, (zz) => interp(zz, z, f), opts)
  let maxAbsDf = 0
  for (const v of df) if (Math.abs(v) > maxAbsDf) maxAbsDf = Math.abs(v)
  const scale = maxAbsDf || 1.0
  const sq = new Float64Array(coreStop - coreStart)
  for (let i = coreStart; i < coreStop; i += 1) sq[i - coreStart] = ((back[i] as number) - (df[i] as number)) ** 2
  const residual = Math.sqrt(npMean(sq)) / scale

  // 「有没有阱」拿阱深与**远端的散布**比 —— 那里已经没有短程力可找了
  const farStart = Math.max(coreStart, coreStop - Math.max(10, Math.trunc(z.length / 5)))
  const far = f.slice(farStart, coreStop)
  let scatter = 0
  if (far.length > 3) {
    const m = npMean(far)
    scatter = npStd(Float64Array.from(far, (v) => v - m))
  }

  const reasons: string[] = []
  let verdict = 'well'
  if (warns.includes('df_min_at_edge')) {
    verdict = 'undecidable'
    reasons.push('minimum_not_bracketed')
  } else if (fMin >= 0) {
    verdict = 'no_well'
    reasons.push('no_attractive_minimum')
  } else if (Math.abs(fMin) < 3 * scatter) {
    verdict = 'no_well'
    reasons.push('minimum_within_noise')
  } else if ((posed === 'caution' || posed === 'large_amplitude') && residual > MAX_FORWARD_RESIDUAL) {
    verdict = 'undecidable'
    reasons.push('inversion_does_not_describe_the_data')
  }
  if (posed === 'large_amplitude') warns.push('amplitude_exceeds_the_force_decay_length')

  return {
    verdict,
    f_min_n: fMin,
    z_f_min_m: z[iF] as number,
    z_df_min_m: z[iDf] as number,
    z_offset_fmin_minus_dfmin_m: (z[iF] as number) - (z[iDf] as number),
    e_bind_ev: eBind / EV_J,
    decay_length_m: lam,
    forward_residual: residual,
    amplitude_over_decay_length: ratio,
    well_posedness: posed,
    background_used: backgroundUsed,
    n_points: z.length,
    z_m: Array.from(z),
    force_n: Array.from(f),
    energy_ev: Array.from(u, (v) => v / EV_J),
    reasons,
    warnings: warns,
  }
}
