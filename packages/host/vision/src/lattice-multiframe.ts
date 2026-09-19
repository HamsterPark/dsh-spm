/**
 * 旧仓 `mast/vision/lattice_multiframe.py` 里 `AssessAtomicConsistency` 用到的那三件：
 * `_independent_pair`(47) · `collect_observation`(54) · `assess_atomic_consistency`(110)。
 *
 * 它向 K1（`findLatticePeaks`）与 `assessAtomicPhase` 要数，两件都在本包里。
 *
 * > **来处**：批 6c 落在 `stm-skills/src/l0/vision-lattice-multiframe.ts`（那一轮
 * > `packages/host/vision/` 由批 6b 主用），由收尾支线按该批交接 §8 搬来。
 * > 判据、容差、抬头一个字未改，只改了 import 路径。
 *
 * ## 单帧做不到的那件事
 *
 * 单帧的角向集中度能排除白噪声与准周期抖动，**排除不掉**「针尖在这一帧里恰好以
 * 某个空间频率抖」—— 那种假象在一帧内可以非常像晶格。真晶格的判据是它
 * **跨帧重现同一组格矢**：抖动的频率与方向帧间不重复，晶格的重复。
 *
 * ## 四个态指向四种**不同的下一步**（2026-08-19 真机第一次跑就撞上）
 *
 * | verdict | 什么情况 | 下一步 |
 * |---|---|---|
 * | `consistent` | 多帧都有、且是同一个晶格 | 可以拿去定标 |
 * | `inconsistent` | 多帧都有、但互相对不上 | 查针尖（双针尖 / 抖动） |
 * | `absent` | 帧都可用、都没有晶格 | 换成像条件或修针 |
 * | `undetermined` | 帧压根用不了（残帧 / 标度不符） | **重扫**，别碰针尖 |
 *
 * 第一版只有前两个 + `undetermined`，而且在 `n_frames ≥ 3` 时把「量到晶格的帧不够」
 * 一律报成 `inconsistent`。真机 3 帧里 2 帧是残帧 ⇒「本次采集不完整」被报成了
 * 「这个晶格是假的」—— 一个会让人去修针尖的结论，而针尖什么事都没有。
 *
 * ## 容差
 *
 * 这一层自己只做**归约与几何**：`np.std` / `np.mean`（成对，逐位）、
 * `np.linalg.norm`、`atan2` / `acos` / `exp(1j·)`。真正的数值在 K1 与
 * `assessAtomicPhase` 那边，容差由它们各自的常量给。
 * 这一层唯一的新容差是三角函数那 1 ulp：见 {@link CONSISTENCY_REL_TOL}。
 *
 * ⚠️ **没有搬 `angle_conditioning` 与 `calibrate_multi_angle`。**
 * 它们的唯一消费方是 `CalibratePiezoMultiAngle`，而那个技能要
 * `lattice_calibration.solve_affine`（`scipy.optimize.fsolve` 的多分支求根）——
 * 不在本批。消融精神：没有消费方的件不写。
 */
import { EPS, npMean, npStd, type Mat } from 'dsh-spm-numerics'
import { assessAtomicPhase } from './atomic-phase.js'
import { findLatticePeaks, type LatticeResult } from './lattice-peaks.js'
import { pyFixed } from 'dsh-spm-kernel'

/** 帧间晶格周期的相对一致性阈值 —— 超过就不是同一个晶格。 */
export const CONSISTENCY_PERIOD_TOL = 0.06
/** 帧间晶格取向的一致性阈值（度）。漂移会让取向缓慢转，但一帧内转不了几度。 */
export const CONSISTENCY_ANGLE_TOL_DEG = 4.0
/** 一对基矢的长度相对差上限。六角晶格三个方向的 |K| 本该相等，压电畸变让它们差
 * 百分之几 —— 20% 只挡得住「配到了别的结构」，挡不住正常畸变。 */
export const PAIR_LENGTH_TOL = 0.2
/** 收一组格矢所需的最低角向集中度。真晶格实测 97–7645，针尖抖动 1.8–3.3 ——
 * 两者差两个数量级，所以这个门槛极不敏感；它挡的是白噪声凑出来的假峰。 */
export const MIN_CONCENTRATION = 20.0

/** 这些原因说明**帧不可用**，而不是「这帧上没有晶格」。
 * 区别是实质性的：残帧不能作为「晶格是假的」的证据，而可用帧上量不到晶格可以。 */
export const UNUSABLE_REASONS: ReadonlySet<string> = new Set([
  'incomplete_frame',
  'too_small',
  'not_2d',
  'all_nan',
  'no_finite_data',
])

/**
 * 这一层自己引入的**相对**容差：`16 · eps`。
 *
 * 推导：本层只做四件事 —— `np.linalg.norm`（一次平方和 + `sqrt`）、
 * `atan2` / `acos` / `cos` / `sin`（V8 与 CPython 的 libm 各至多 1 ulp）、
 * 成对归约（{@link npMean} / {@link npStd} 逐位）、一次除法。
 * 最长的那条链是 `angle_spread_deg`：`cos`+`sin` → 成对均值 → `hypot` → `acos` → 除 6，
 * 六步各至多 1–2 ulp ⇒ `≤ 12·eps`。取 **16**。
 *
 * ⚠️ 它**不**盖住 K1 与 `assessAtomicPhase` 送进来的数（`period_nm` 一族）——
 * 那些的尺度与容差在 `vision` 那一侧，金样比对时由该字段自己的容差接管。
 */
export const CONSISTENCY_REL_TOL = 16 * EPS

/** 一帧上量到的两个独立倒格矢（1/nm，图像坐标系），连同它的扫描角。 */
export interface FrameObservation {
  readonly angleDeg: number
  readonly k1: readonly [number, number]
  readonly k2: readonly [number, number]
  readonly periodMeanNm: number
  readonly periodSpread: number
  readonly latticeAngleDeg: number
  readonly label: string
  readonly nmPerPx: number
  readonly lineTimeS: number
}

/** 一格 `per_frame`。`ok=false` 时带 `reason` 与 `why`。 */
export type ConsistencyRow = Record<string, unknown>

/** `assess_atomic_consistency` 的产物。 */
export interface AtomicConsistency {
  readonly verdict: string
  readonly n_frames: number
  readonly n_atomic: number
  readonly n_unusable: number
  readonly n_no_lattice: number
  readonly period_spread: number
  readonly angle_spread_deg: number
  readonly reason: string
  readonly per_frame: readonly ConsistencyRow[]
  readonly warnings: readonly string[]
}

/**
 * `math.degrees` / `np.degrees` 的那个常数（`180/π`，**一次**除法定死）。
 *
 * ⚠️ 别写成 `x * 180 / Math.PI` —— 那是「先乘后除」两次舍入，与 CPython 的
 * `x * radToDeg` 最后一位不同，而这一族的角度会进 `<= 4.0` 与 `> 15.0` 两条比较。
 */
const RAD_TO_DEG = 180 / Math.PI
/** `np.radians` 的那个常数。 */
const DEG_TO_RAD = Math.PI / 180

type Vec2 = [number, number]

function norm2(v: Vec2): number {
  return Math.hypot(v[0], v[1])
}

/**
 * `_independent_pair` —— 挑一对夹角接近 60°/120° **且长度相近**的独立基矢（1/nm）。
 *
 * ⚠️ **长度那一条不是装饰。** 第一版只按夹角挑，于是真机 2026-08-19 的 60° 帧上，
 * 一个 `|k| = 10 px`、周期 0.8 nm、沿慢轴方向的**低频结构**（漂移或反馈残留，
 * 不是晶格）与真峰 `|k| = 34.5` 凑成了「夹角合适」的一对 —— 量出周期 0.5160 nm，
 * 正好是真值的两倍。那一帧的 z rms 是 22.8 pm，而同批 0° 帧只有 7.7 pm：
 * 图上确实多了东西。长度判据把这类污染挡在**配对之前**，比事后按周期剔除离群帧
 * 更早、更便宜。
 */
export function independentPair(pk: LatticeResult, spanNm: number): [Vec2, Vec2] | null {
  const reps: Vec2[] = []
  for (const q of pk.peaks) {
    let v: Vec2 = [q.kx / spanNm, q.ky / spanNm]
    // ±K 等价，只留上半平面代表元
    if (v[1] < 0 || (Math.abs(v[1]) < 1e-12 && v[0] < 0)) v = [-v[0], -v[1]]
    const dup = reps.some((w) => Math.hypot(v[0] - w[0], v[1] - w[1]) < 0.05 * Math.max(norm2(v), 1e-9))
    if (!dup) reps.push(v)
  }
  if (reps.length < 2) return null
  let best: [Vec2, Vec2] | null = null
  let bestErr = 1e9
  for (let i = 0; i < reps.length; i += 1) {
    for (let j = i + 1; j < reps.length; j += 1) {
      const a = reps[i] as Vec2
      const b = reps[j] as Vec2
      const na = norm2(a)
      const nb = norm2(b)
      if (na < 1e-9 || nb < 1e-9) continue
      if (Math.abs(na - nb) / Math.max(na, nb) > PAIR_LENGTH_TOL) continue // 长度差太多 —— 不是同一套格矢
      const dot = a[0] * b[0] + a[1] * b[1]
      const ang = Math.acos(Math.min(1, Math.max(-1, dot / (na * nb)))) * RAD_TO_DEG
      const err = Math.min(Math.abs(ang - 60.0), Math.abs(ang - 120.0))
      if (err < bestErr) {
        bestErr = err
        best = [a, b]
      }
    }
  }
  if (best === null || bestErr > 15.0) return null
  const [a, b] = best
  // 统一成夹角 120° 的一对 —— `solve_affine` 的第三个方程就是 cos120°。
  return a[0] * b[0] + a[1] * b[1] > 0.0 ? [a, [-b[0], -b[1]]] : [a, b]
}

/**
 * `collect_observation` —— 从一帧里取出两个独立倒格矢（1/nm）。取不到就 `null`，**不猜**。
 *
 * 两处必须照移的：
 *
 * * `LatticePeak.kx/ky` 是**像素**单位（谱中心为原点），这里统一换算成 1/nm。
 *   多帧之间视场可以不同，像素单位跨帧不可比，混用会得到一个量纲自洽但物理错误的解；
 * * 周期从**实际配对出来的那两个格矢**算，**不照抄** `pk.periodMeanNm`。后者是
 *   K1 对它找到的**所有**方向取的平均，里面可能混着不是晶格的东西（真机那次
 *   `periods = ['0.2320', '0.8000']`、平均 0.5160，而配对用的是两个 0.22 的真峰）。
 *   报一个和实际用的格矢对不上的周期，是让下游去审一个**本函数并没有使用的数**。
 *
 * 那道角向集中度的门也照移，理由在旧仓注释里：K1 **不判**「这是不是真晶格」
 * （纯白噪声上它照样能凑出 6 个峰），而这个函数的输出**会被喂进定标方程**。
 */
export function collectObservation(
  image: Mat,
  nmPerPx: number,
  angleDeg: number,
  opts: { label?: string; lineTimeS?: number } = {},
): FrameObservation | null {
  const pk = findLatticePeaks(image, nmPerPx)
  if (!pk.ok || pk.nPeaks < 4) return null
  const ap = assessAtomicPhase(image, { nmPerPx, allowReducedScale: true })
  if (ap.angularConcentration < MIN_CONCENTRATION) return null
  const spanNm = Math.min(image.rows, image.cols) * nmPerPx
  if (spanNm <= 0) return null
  const K = independentPair(pk, spanNm)
  if (K === null) return null
  const n1 = norm2(K[0])
  const n2 = norm2(K[1])
  const per = n1 + n2 > 0 ? 2.0 / (n1 + n2) : 0.0
  const spread = Math.abs(n1 - n2) / Math.max(n1, n2, 1e-12)
  return {
    angleDeg,
    k1: K[0],
    k2: K[1],
    periodMeanNm: per,
    periodSpread: spread,
    latticeAngleDeg: Math.atan2(K[0][1], K[0][0]) * RAD_TO_DEG,
    label: opts.label ?? '',
    nmPerPx,
    lineTimeS: opts.lineTimeS ?? 0,
  }
}

/**
 * `assess_atomic_consistency` —— 同一区域重复扫若干帧，判断那个晶格是不是**真的**。
 *
 * ⚠️ 缺帧**算不算证据**取决于它为什么缺：残帧（`UNUSABLE_REASONS`）什么都不证明，
 * 可用帧上量不到晶格才是证据。这两种否定在 `n_unusable` / `n_no_lattice`
 * 两个字段上分开记 —— 合成一个「没量到的帧数」会让上面那张四态表塌成两态。
 */
export function assessAtomicConsistency(
  frames: readonly Mat[],
  nmPerPx: number,
  anglesDeg: readonly number[] = [],
): AtomicConsistency {
  const angs = anglesDeg.length > 0 ? anglesDeg : frames.map(() => 0.0)
  const obs: FrameObservation[] = []
  const rows: ConsistencyRow[] = []
  for (let i = 0; i < frames.length; i += 1) {
    const img = frames[i] as Mat
    const o = collectObservation(img, nmPerPx, i < angs.length ? (angs[i] as number) : 0.0, { label: `frame${i}` })
    const row: ConsistencyRow = { index: i, ok: o !== null }
    if (o !== null) {
      obs.push(o)
      row['period_nm'] = o.periodMeanNm
      row['period_spread'] = o.periodSpread
      row['lattice_angle_deg'] = o.latticeAngleDeg
    } else {
      // 为什么没量到，决定了缺帧算不算证据 —— 残帧什么都不证明。
      const pk = findLatticePeaks(img, nmPerPx)
      row['reason'] = pk.reason || 'no_peaks'
      row['why'] = UNUSABLE_REASONS.has(pk.reason) ? 'unusable' : 'no_lattice'
    }
    rows.push(row)
  }
  const nUnusable = rows.filter((r) => r['why'] === 'unusable').length
  const nNoLattice = rows.filter((r) => r['why'] === 'no_lattice').length
  const base = {
    n_frames: frames.length,
    n_atomic: obs.length,
    n_unusable: nUnusable,
    n_no_lattice: nNoLattice,
    per_frame: rows,
  }
  if (frames.length < 2) {
    return {
      verdict: 'undetermined',
      ...base,
      period_spread: NaN,
      angle_spread_deg: NaN,
      reason: 'need_two_frames',
      warnings: [],
    }
  }
  if (obs.length < 2) {
    const warnings: string[] = []
    let verdict = 'undetermined'
    let reason = ''
    if (obs.length === 0) {
      if (nUnusable === 0 && nNoLattice >= 2) {
        verdict = 'absent'
        reason = `no_lattice_in_${nNoLattice}_usable_frames`
        warnings.push(
          `${nNoLattice} 帧都完整、都没有晶格 —— 这是一个**明确的否定**，不是` +
            '「判不了」。下一步是换成像条件或修针尖，不是重扫。',
        )
      } else {
        verdict = 'undetermined'
        reason = 'no_usable_frame'
        warnings.push(`${nUnusable}/${frames.length} 帧用不了（残帧 / 标度不符），一帧晶格都没量到 —— 先把帧扫完整。`)
      }
    } else if (nNoLattice >= 2 && nUnusable === 0) {
      // 帧本身可用、却量不到晶格 —— 这时孤零零那一帧的晶格才真可疑。
      verdict = 'inconsistent'
      reason = `only_1_of_${nNoLattice + obs.length}_usable_frames_shows_a_lattice`
      warnings.push(
        `${nNoLattice} 帧完整可用却量不到晶格，只有 1 帧有 —— 那一帧的晶格可疑：` + '针尖时好时坏，或者它本身就是假象。',
      )
    } else {
      verdict = 'undetermined'
      reason = `only_${obs.length}_frames_show_a_lattice`
      if (nUnusable > 0) {
        warnings.push(
          `${nUnusable}/${frames.length} 帧根本用不了（残帧 / 标度不符），判不了一致性 —— ` +
            '这是**采集**没完成，不是晶格有问题。重扫完整帧再判。',
        )
      }
    }
    return { verdict, ...base, period_spread: NaN, angle_spread_deg: NaN, reason, warnings }
  }

  const per = Float64Array.from(obs, (o) => o.periodMeanNm)
  const periodSpread = npStd(per) / Math.max(npMean(per), 1e-12)
  // 取向要在扣掉各自扫描角之后比 —— 转了台子当然会转
  const reArr = new Float64Array(obs.length)
  const imArr = new Float64Array(obs.length)
  for (let i = 0; i < obs.length; i += 1) {
    const o = obs[i] as FrameObservation
    const th = (o.latticeAngleDeg + o.angleDeg) * 6.0 * DEG_TO_RAD // 六角 60° 周期
    reArr[i] = Math.cos(th)
    imArr[i] = Math.sin(th)
  }
  const angleSpreadDeg = (Math.acos(Math.min(1, Math.max(0, Math.hypot(npMean(reArr), npMean(imArr))))) * RAD_TO_DEG) / 6.0

  const okP = periodSpread <= CONSISTENCY_PERIOD_TOL
  const okA = angleSpreadDeg <= CONSISTENCY_ANGLE_TOL_DEG
  const warnings: string[] = []
  let verdict: string
  let reason = ''
  if (okP && okA) {
    verdict = 'consistent'
    if (obs.length < frames.length) {
      warnings.push(
        `${obs.length}/${frames.length} 帧量到晶格，量到的那些互相一致。缺的那几帧是真丢了分辨` +
          '还是只是那一帧质量差，这里判不了。',
      )
    }
  } else {
    verdict = 'inconsistent'
    reason = `period_spread=${pyFixed(periodSpread, 3)} angle_spread=${pyFixed(angleSpreadDeg, 2)}deg`
    warnings.push(
      '跨帧不重现同一组格矢 —— 每帧自己看着像晶格，但它们不是同一个晶格。' + '针尖抖动 / 双针尖是最常见的来源。',
    )
  }
  return { verdict, ...base, period_spread: periodSpread, angle_spread_deg: angleSpreadDeg, reason, warnings }
}
