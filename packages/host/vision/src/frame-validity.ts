/**
 * 「这一帧能不能拿来判」以及「哪些行是真扫出来的」—— 旧仓
 * `mast/vision/frame_validity.py` 的 `judge_frame`(60) + `acquired_row_mask`(77)，
 * 外加它依赖的 `mast/vision/tip_metrics.py:_detrend`(8)。
 *
 * ## `acquiredRowMask`：未扫的行有**两种**形态
 *
 * | 数据来源 | 未扫的行 |
 * |---|---|
 * | 存成 `.sxm` 之后 | **全 NaN** |
 * | `Scan_FrameDataGrab` 的活体缓冲 | **全零** |
 *
 * 只查 NaN 会把活体缓冲里那片零**当成真数据** —— 零是有限值，`isfinite` 一路放行。
 * 实测 `assess_atomic_phase`：同一批数据含 40% 未扫时 162.4，只取已扫的 143 行 818.4，
 * **差 5 倍**。
 *
 * 判据是「**整行**都有限」，不是「这一行有任何有限值」。差别是**正在扫的那一行**：
 * 它一半有数一半是 NaN，而任何平面/直线拟合碰上一个 NaN 就整幅返回 NaN。
 * 实测差的就是那一行，而它把整个技能打成「flat or unreadable」。
 *
 * ⚠️ **整帧全零是另一件事**：反馈关掉 / 没接上时「测出来就是零」，而
 * 「测出来是零」和「没测」必须是两句话。一整帧零里没有任何东西能把这两者分开，
 * 所以那时**不裁**，让下游按 `dead_flat` 去说。
 *
 * ## `judgeFrame` 的两档，以及为什么第二档是**比值**
 *
 * 第一档「去趋势后精确为 0」来自两张无效帧样本（实测）。
 * 第二档是比值 `std / ptp < 1e-7`：一张**带倾斜**的死平帧残差是 ~2e-15 而不是 0，
 * 第一档放它过去。
 *
 * 用比值而不是一个米数，是因为绝对阈值在本仓咬过两次
 * （`assess_tip_classical` 的 `1e-9 m` 守卫让 Au(111) 台阶图 13/13 全部早退 ——
 * 单原子台阶才 236 pm）。比值无量纲，量程换了它不动。
 *
 * ## 容差：`corrugationRmsM` 是 **float32** 上的 std
 *
 * `_detrend` 的最后一步是 `.astype(np.float32)`，而 `np.std` 对一个 float32 数组
 * **在 float32 里累加**。于是这个物理量的最后几位由一次降精度和一串 float32 加法
 * 决定 —— 本仓在 float64 里累加（走 `numerics.std`），两边**必然**在第七位上分岔。
 *
 * ⇒ 容差 {@link CORRUGATION_REL_TOL}`(n)` = `8 · eps32 · log₂n`：
 * numpy 对 float32 用成对求和，误差界 `O(eps32 · log₂n)`，系数 8 是 3 倍余量
 * （与 `numerics.sumRelTol` 同一条推导，只是把 `eps` 换成 `eps32`）。
 * **降精度那一步照抄**（`toFloat32`），否则差的就不是第七位而是第二位了。
 */
import { matAt, matOf, ptp, type Mat } from 'dsh-spm-numerics'
import { finiteOf, nanMean, std32, toFloat32 } from './nd.js'
import { lstsqPlane } from './plane.js'

/** 拒判时对用户/模型说的话。**这是本模块的产品** —— 它把「判不了」和「判出来不好」分开。 */
export const DEAD_FLAT_REASON =
  '这一帧是死平的（去趋势后起伏为 0）——不是针尖的问题，是数据的问题。' +
  '换一块地方重扫一张再判；不要据此去修针尖。'

/** 去趋势残差 / 原始峰峰值的下限。**低于它就是浮点舍入，不是形貌。** */
export const FLAT_RATIO_MIN = 1e-7

/** float32 的机器精度。 */
export const EPS32 = 2 ** -23

/** `corrugation_rms_m` 对 numpy 的相对容差。见文件抬头最后一节。 */
export function corrugationRelTol(n: number): number {
  return 8 * EPS32 * Math.max(1, Math.log2(Math.max(n, 2)))
}

/**
 * `tip_metrics._detrend` —— **逐行中值 + OLS 平面 + float32**。
 *
 * 顺序不能换，档次不能少：`judge_frame` 的那两档判据全是在这份结果上量的，
 * 换一种去趋势就等于换了判据。
 */
export function detrend(m: Mat): Mat {
  const { rows, cols } = m
  // ① 逐行中值
  const rowSub = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    const row: number[] = []
    for (let c = 0; c < cols; c += 1) row.push(matAt(m, r, c))
    // `np.median`（不是 nanmedian）—— 行里有 NaN 时中位数就是 NaN，整行变 NaN。
    const med = medianRaw(row)
    for (let c = 0; c < cols; c += 1) rowSub[r * cols + c] = (row[c] as number) - med
  }
  // ② 全部像素的 OLS 平面
  const xs = new Float64Array(rows * cols)
  const ys = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      xs[r * cols + c] = c
      ys[r * cols + c] = r
    }
  }
  const fit = lstsqPlane(xs, ys, rowSub)
  const out = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c
      out[i] = fit === null ? NaN : (rowSub[i] as number) - (fit[0] * c + fit[1] * r + fit[2])
    }
  }
  // ③ **float32**（见文件抬头）
  return matOf(rows, cols, toFloat32(out))
}

/** `np.median` —— 不丢 NaN（有 NaN 就是 NaN），与 `nanMedian` 刻意不同。 */
function medianRaw(xs: readonly number[]): number {
  for (const v of xs) if (Number.isNaN(v)) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return NaN
  const half = n >> 1
  return n % 2 === 1 ? (s[half] as number) : ((s[half - 1] as number) + (s[half] as number)) / 2
}

/** 一帧能不能拿来做针尖判定。`usable=true` 时 `reason` 是空串。 */
export interface FrameVerdict {
  readonly usable: boolean
  readonly reason: string
  /** 去趋势后的起伏 RMS（米）。**拒判时也给** —— 它就是测出来的那个 0。 */
  readonly corrugationRmsM: number
  /** 去趋势后的图。给调用方复用，也保证大家判的是同一份数据。 */
  readonly detrended: Mat | null
}

/** 这张高度图能不能拿来判针尖。 */
export function judgeFrame(m: Mat): FrameVerdict {
  if (m.rows === 0 || m.cols < 2) {
    return {
      usable: false,
      reason: `这一帧不是二维图像或太小（shape=(${m.rows}, ${m.cols})）——数据的问题，不是针尖的问题。`,
      corrugationRmsM: 0,
      detrended: null,
    }
  }
  const finite = finiteOf(m.data)
  if (finite.length === 0) {
    return {
      usable: false,
      reason: '这一帧整幅都不是有限数值（全 NaN/Inf）——数据的问题，不是针尖的问题。',
      corrugationRmsM: 0,
      detrended: null,
    }
  }
  // NaN 洞不该让整帧作废：真机上行尾/未扫完的部分就是 NaN。用有限值算起伏。
  const fillValue = nanMean(m.data)
  const filledData = new Float64Array(m.rows * m.cols)
  for (let i = 0; i < filledData.length; i += 1) {
    const v = m.data[i] as number
    filledData[i] = Number.isFinite(v) ? v : fillValue
  }
  const filled = matOf(m.rows, m.cols, filledData)
  const h = detrend(filled)
  // **float32 的 std** —— 不是「精度低一点」，它决定走第一档还是第二档。
  // 见 `nd.ts` 的 `std32`：`1e-25` 的平方在 float32 里下溢成 0。
  const s = std32(h.data)

  // 第一档：精确为 0。这是无效帧样本走的那一条（实测）。
  if (!Number.isFinite(s) || s <= 0) {
    return { usable: false, reason: DEAD_FLAT_REASON, corrugationRmsM: 0, detrended: h }
  }
  // 第二档：残差相对原始峰峰值小到只可能是浮点舍入。
  const p = finite.length > 0 ? ptp(finiteOf(filledData)) : 0
  if (p > 0 && s / p < FLAT_RATIO_MIN) {
    return {
      usable: false,
      reason:
        `这一帧是死平的（去趋势后残差只有原始起伏的 ${pyExp(s / p)}，` +
        `低于 ${pyExpShort(FLAT_RATIO_MIN)} —— 那是浮点舍入，不是形貌）` +
        `——不是针尖的问题，是数据的问题。` +
        '换一块地方重扫一张再判；不要据此去修针尖。',
      corrugationRmsM: s,
      detrended: h,
    }
  }
  return { usable: true, reason: '', corrugationRmsM: s, detrended: h }
}

/** Python 的 `f"{x:.2e}"`。JS 的 `toExponential(2)` 指数位数不补零（`e-8` vs `e-08`）。 */
function pyExp(x: number): string {
  const s = x.toExponential(2)
  return s.replace(/e([+-])(\d)$/, 'e$10$2')
}

/** Python 的 `f"{x:.0e}"`。 */
function pyExpShort(x: number): string {
  const s = x.toExponential(0)
  return s.replace(/e([+-])(\d)$/, 'e$10$2')
}

/**
 * **已扫完**的行 —— 整行都是有限值，且在给出的**每一帧**上同时成立（取交集）。
 *
 * 传多帧时取交集是有意的：正反扫一致性要逐点比，只有**两侧都扫到**的行才可比。
 */
export function acquiredRowMask(...frames: readonly Mat[]): Uint8Array {
  const masks: Uint8Array[] = []
  for (const a of frames) {
    if (a.rows === 0 || a.cols === 0) return new Uint8Array(0)
    const finite = new Uint8Array(a.rows)
    const zeroRow = new Uint8Array(a.rows)
    for (let r = 0; r < a.rows; r += 1) {
      let allFinite = 1
      let allZero = 1
      for (let c = 0; c < a.cols; c += 1) {
        const v = matAt(a, r, c)
        if (!Number.isFinite(v)) allFinite = 0
        // `np.nan_to_num`：NaN → 0，于是一行 NaN 也算「全零行」。
        const z = Number.isNaN(v) ? 0 : v
        if (z !== 0) allZero = 0
      }
      finite[r] = allFinite
      zeroRow[r] = allZero
    }
    let anyZero = false
    let allZeroRows = true
    for (let r = 0; r < a.rows; r += 1) {
      if (zeroRow[r] === 1) anyZero = true
      else allZeroRows = false
    }
    // 整帧全零是另一件事（见文件抬头），那时不裁。
    if (anyZero && !allZeroRows) {
      for (let r = 0; r < a.rows; r += 1) if (zeroRow[r] === 1) finite[r] = 0
    }
    masks.push(finite)
  }
  if (masks.length === 0) return new Uint8Array(0)
  let n = Infinity
  for (const m of masks) n = Math.min(n, m.length)
  const out = new Uint8Array(n).fill(1)
  for (const m of masks) {
    for (let i = 0; i < n; i += 1) if (m[i] === 0) out[i] = 0
  }
  return out
}

/** 按行掩膜裁一张图（保留 `mask[r] === 1` 的行，顺序不变）。 */
export function cropRows(m: Mat, mask: Uint8Array): Mat {
  const keep: number[] = []
  for (let r = 0; r < Math.min(m.rows, mask.length); r += 1) if (mask[r] === 1) keep.push(r)
  const out = new Float64Array(keep.length * m.cols)
  keep.forEach((r, i) => {
    for (let c = 0; c < m.cols; c += 1) out[i * m.cols + c] = matAt(m, r, c)
  })
  return matOf(keep.length, m.cols, out)
}
