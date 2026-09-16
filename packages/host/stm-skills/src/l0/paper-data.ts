/**
 * `paper.data_processing` 整族 —— `SubtractPlane_RANSAC` · `LevelLines_Median` ·
 * `CorrectDrift_XCorr` · `FindEmptySpot`。
 *
 * 四个都**只读文件、不碰硬件**。判据（数值）写在下面每个函数自己的抬头里，
 * **连同容差与它的推导**；外壳只负责把文件读进来、把参数按旧仓的口径取出来、
 * 把产出摆成 `SkillResult.data` 并落一个 `.npy`。
 *
 * ## 这一族的容差表（测试引用这些常量，**不许写字面量**）
 *
 * | 件 | 对的是 | 容差 | 推导 |
 * |---|---|---|---|
 * | `ransacPlaneSubtract` 的 `inlier_ratio` | 旧仓同名函数 | **0** | 它是**两个整数的商**（内点数 / 像素数），而在这份金样的输入上内点集是定死的（见下） |
 * | `ransacPlaneSubtract` 的 `plane_coefficients` | `np.linalg.lstsq` | {@link lstsqRelTol}(κ) | 本仓走正规方程（κ 平方），numpy 走 SVD。κ 随金样录（`condition_numbers.plane_32x32`） |
 * | `rms_before` / `rms_after` | `np.std` | {@link sumRelTol}(n) | 一次两遍法 `std`；本仓 `sum` 是 Neumaier、numpy 是成对求和（D-NUM-1） |
 * | `levelLines` 的输出（`median`） | `np.median` 逐行相减 | **0** | 每个输出是 `行元素 − 该行中位`，**一次减法**。中位本身是输入里的元素原样（或两个的平均） |
 * | `levelLines` 的输出（`poly`） | `np.polyfit` + `polyval` | {@link lstsqRelTol}(κ_vander) | `polyfit` 照抄了 numpy 的列缩放，κ 随金样录 |
 * | `driftXcorr` 的 `shift` | `skimage.phase_cross_correlation` | **0** | 答案恒为 `k/uf`，两边做同样两次「整数 ÷ uf」（`numerics-2.md` D-NUM-3 一族） |
 * | `driftXcorr` 的 `error` | 同上 | 见 {@link xcorrErrorSqAbsTol} + 本文件 §`ERROR_SQ_SCALE` | D-NUM-21：只能在**平方**上给容差 |
 * | `driftXcorr` 的 `phase` | 同上 | {@link xcorrPhaseAbsTol}(n)，**绝对**（弧度） | 一个复数的相对误差 δ 最多把辐角挪 δ 弧度 |
 * | `findEmptySpot` 的 `best_cell_*` | `np.argmin` | **0** | 它是一个下标。「差不多的下标」不是精度问题，是另一格 |
 * | `findEmptySpot` 的 `roughness_map` | `np.std` | {@link sumRelTol}(cell) | 同 `rms_before` |
 */
import { writeFileSync } from 'node:fs'
import {
  encodeNpyFrame,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  EPS,
  Xoshiro128,
  hanningWindow2d,
  matOf,
  mean,
  phaseCrossCorrelation,
  polyfit,
  polyval,
  solveNormalEquations,
  std,
  sumRelTol,
  type Mat,
} from 'dsh-spm-numerics'
import { npMedian } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { ImageLoadError, loadImage2d, matRows, siblingNpy } from './paper-common.js'
import { fail, ok } from './common.js'

// ──────────────────────────────────────────────────────────────────────────
// 共用外壳
// ──────────────────────────────────────────────────────────────────────────

/**
 * 旧仓 `SubtractPlane_RANSAC._load_image`：**读不动就给 `None`**，一个字都不说。
 *
 * ⚠️ 这是照移一处**很钝**的错误处理：`try: return load_image_2d(path) except: return None`
 * 把「没给路径」「文件不存在」「不是个 .npy」三件事压成同一句
 * 「No image data available.」。两个技能（本条与 `LevelLines_Median`）共用它，
 * 而同族的另外两个（`FindEmptySpot` / `CorrectDrift_XCorr`）**把异常带出来了**。
 * 一个族里两种做法 —— 照移，欠账记在交接里。
 */
function loadQuiet(path: unknown): Mat | null {
  const p = String(path ?? '')
  if (p === '') return null
  try {
    return loadImage2d(p)
  } catch {
    return null
  }
}

/** 落一个 `.npy` 到源文件旁边。写不动**不算失败**（旧仓是 `logger.warning` + `None`）。 */
function persist(src: unknown, suffix: string, m: Mat): string | null {
  try {
    const dst = siblingNpy(String(src ?? ''), suffix)
    writeFileSync(dst, encodeNpyFrame(matRows(m)))
    return dst
  } catch {
    return null
  }
}

function numOrDefault(params: Readonly<Record<string, unknown>>, key: string, d: number): number {
  const v = params[key]
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

// ──────────────────────────────────────────────────────────────────────────
// 1. SubtractPlane_RANSAC
// ──────────────────────────────────────────────────────────────────────────

/** RANSAC 抽样的种子。旧仓写死 `np.random.default_rng(42)`，本仓同一个数、另一台 RNG。 */
export const RANSAC_SEED = 42

/**
 * 旧仓 `ransac_plane_subtract`：随机抽三点定平面、数内点、最后拿**全部内点**
 * 再做一次最小二乘，然后把那个平面减掉。
 *
 * ## ⚠️ 抽样序列与 numpy **不同**，而这件事在什么时候要紧
 *
 * `np.random.default_rng(42)` 是 PCG64，本仓是 `Xoshiro128`（D-NUM-7：
 * RNG 求的是**可复现**，不是「与 numpy 相同」）。于是两边抽到的三元组必然不同。
 *
 * **答案相不相同，取决于输入**：
 *
 * * 图上每个像素要么严格在那个平面上、要么离它远得多（金样那张平顶盘图）⇒
 *   任何一组「三点全在背景上」的抽样都给出同一个平面 ⇒ `best_inliers` 恒等于
 *   背景像素数、内点集恒等于背景本身 ⇒ **最后那次全内点最小二乘两边解同一个方程组**。
 *   金样 `ransac_facts` 把那个计数（933 / 1024）单独录了下来，判据落在它上面。
 * * 真机上的一张图有**连续分布的残差**（分子的裙边、台阶的边缘），
 *   于是「先抽到谁」会改掉内点集 —— 那时 `inlier_ratio` 与 `plane_coefficients`
 *   在两个实现之间**没有理由相同**，而且差多少说不出来。
 *
 * 所以这一条登记成 deviation：**本函数在带裙边的真图上与旧仓不逐位一致**，
 * 而金样刻意只放定死的那一类输入（批 4a §9①：改输入，不是改容差）。
 *
 * ## 三点解那一步：奇异就跳过，**不给一个「差不多的」平面**
 *
 * numpy 的 `np.linalg.solve` 对奇异矩阵抛 `LinAlgError`，旧仓 `continue`。
 * 本仓用带部分主元的高斯消元，**主元为 0 就当奇异**。
 * 一个「主元 1e-300 照解不误」的实现会把三个共线的点解成一个斜率 1e300 的平面，
 * 那个平面的内点数是 0，于是它**不会**赢 —— 但它会在别的输入上赢一次，
 * 而那一次没人看得出来。
 */
export function ransacPlaneSubtract(
  image: Mat,
  residualThreshold: number,
  maxTrials: number,
): { leveled: Mat; plane: Float64Array; inlierRatio: number } {
  const ny = image.rows
  const nx = image.cols
  const n = ny * nx
  const xf = new Float64Array(n)
  const yf = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      xf[r * nx + c] = c
      yf[r * nx + c] = r
    }
  }
  const zf = image.data
  const rng = new Xoshiro128(RANSAC_SEED)
  let bestInliers = 0
  let best: Float64Array<ArrayBufferLike> = Float64Array.from([0, 0, 0])

  for (let t = 0; t < maxTrials; t += 1) {
    const idx = sampleThree(rng, n)
    const plane = solve3(
      [xf[idx[0]] as number, yf[idx[0]] as number, 1],
      [xf[idx[1]] as number, yf[idx[1]] as number, 1],
      [xf[idx[2]] as number, yf[idx[2]] as number, 1],
      [zf[idx[0]] as number, zf[idx[1]] as number, zf[idx[2]] as number],
    )
    if (plane === null) continue
    let count = 0
    for (let i = 0; i < n; i += 1) {
      const pred = (plane[0] as number) * (xf[i] as number) + (plane[1] as number) * (yf[i] as number) + (plane[2] as number)
      if (Math.abs((zf[i] as number) - pred) < residualThreshold) count += 1
    }
    if (count > bestInliers) {
      bestInliers = count
      best = plane
    }
  }

  // 最终平面 = 拿**全部内点**再做一次最小二乘。少这一步，结果就是三个带噪的点定的平面。
  const inliers: number[] = []
  for (let i = 0; i < n; i += 1) {
    const pred = (best[0] as number) * (xf[i] as number) + (best[1] as number) * (yf[i] as number) + (best[2] as number)
    if (Math.abs((zf[i] as number) - pred) < residualThreshold) inliers.push(i)
  }
  if (inliers.length >= 3) {
    const cx = new Float64Array(inliers.length)
    const cy = new Float64Array(inliers.length)
    const cone = new Float64Array(inliers.length)
    const cz = new Float64Array(inliers.length)
    for (let k = 0; k < inliers.length; k += 1) {
      const i = inliers[k] as number
      cx[k] = xf[i] as number
      cy[k] = yf[i] as number
      cone[k] = 1
      cz[k] = zf[i] as number
    }
    best = solveNormalEquations([cx, cy, cone], cz)
  }

  const out = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    out[i] = (zf[i] as number) -
      ((best[0] as number) * (xf[i] as number) + (best[1] as number) * (yf[i] as number) + (best[2] as number))
  }
  return {
    leveled: matOf(ny, nx, out),
    plane: best,
    inlierRatio: n > 0 ? bestInliers / n : 0.0,
  }
}

/**
 * `rng.choice(n, size=3, replace=False)` —— **不重复**的三个下标。
 *
 * `replace=False` 不是装饰：抽到同一个点两次，三点就必然共线，那一次试验
 * 白跑（`solve3` 给 `null`）。n 很大时这件事几乎不发生，而 `grid_n` 很小的
 * 图上（本函数没有下界）它一跑就撞上。用 `nextInt` 而不是 `floor(nextFloat·n)`：
 * 后者在 n 不是 2 的幂时对前几个数偏一点点，而「看不见的偏差」正是这里不该有的。
 */
function sampleThree(rng: Xoshiro128, n: number): [number, number, number] {
  const a = rng.nextInt(n)
  let b = rng.nextInt(n)
  while (b === a) b = rng.nextInt(n)
  let c = rng.nextInt(n)
  while (c === a || c === b) c = rng.nextInt(n)
  return [a, b, c]
}

/** 3×3 高斯消元（部分主元）。**奇异给 `null`**，不给一个「差不多的」解。 */
function solve3(
  r0: readonly number[], r1: readonly number[], r2: readonly number[], rhs: readonly number[],
): Float64Array | null {
  const m = [
    [r0[0] as number, r0[1] as number, r0[2] as number, rhs[0] as number],
    [r1[0] as number, r1[1] as number, r1[2] as number, rhs[1] as number],
    [r2[0] as number, r2[1] as number, r2[2] as number, rhs[2] as number],
  ]
  for (let col = 0; col < 3; col += 1) {
    let piv = col
    for (let r = col + 1; r < 3; r += 1) {
      if (Math.abs((m[r] as number[])[col] as number) > Math.abs((m[piv] as number[])[col] as number)) piv = r
    }
    if ((m[piv] as number[])[col] === 0) return null
    const tmp = m[col] as number[]
    m[col] = m[piv] as number[]
    m[piv] = tmp
    for (let r = col + 1; r < 3; r += 1) {
      const f = ((m[r] as number[])[col] as number) / ((m[col] as number[])[col] as number)
      for (let k = col; k < 4; k += 1) {
        ;(m[r] as number[])[k] = ((m[r] as number[])[k] as number) - f * ((m[col] as number[])[k] as number)
      }
    }
  }
  const out = new Float64Array(3)
  for (let r = 2; r >= 0; r -= 1) {
    let acc = (m[r] as number[])[3] as number
    for (let k = r + 1; k < 3; k += 1) acc -= ((m[r] as number[])[k] as number) * (out[k] as number)
    out[r] = acc / ((m[r] as number[])[r] as number)
  }
  return out
}

export const SubtractPlane_RANSAC: Skill = {
  spec: S.SubtractPlane_RANSACSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const image = loadQuiet(params['image_path'])
    if (image === null) return fail('No image data available.')
    const threshold = numOrDefault(params, 'residual_threshold', 1e-10)
    const maxTrials = Math.trunc(numOrDefault(params, 'max_trials', 100))
    let r: { leveled: Mat; plane: Float64Array; inlierRatio: number }
    try {
      r = ransacPlaneSubtract(image, threshold, maxTrials)
    } catch (e) {
      return fail(`RANSAC plane subtraction failed: ${(e as Error).message}`)
    }
    return ok({
      inlier_ratio: r.inlierRatio,
      plane_coefficients: Array.from(r.plane),
      rms_before: std(image.data),
      rms_after: std(r.leveled.data),
      output_path: persist(params['image_path'], '_ransac', r.leveled),
    })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 2. LevelLines_Median
// ──────────────────────────────────────────────────────────────────────────

/**
 * 逐行平场：每一行减掉自己的中位数（或者自己的多项式拟合）。
 *
 * ## ⚠️ `method` 认不出来时**什么都不做**，而且不报错
 *
 * 旧仓写的是 `if median … elif poly …` —— 没有 `else`。于是
 * `method="zzz"` 走完整个循环、一行都没改，返回值里 `method: "zzz"`、
 * `rms_after == rms_before`。照移。这条路是这个技能里唯一一个
 * 「成功了但什么也没发生」的出口，而**只有 `rms` 那两个数说得出来**
 * （金样 `unknown_method` 那一格就是为它录的）。
 *
 * ## `np.median` 不是 `numerics.median`
 *
 * 偶数长度时前者是 `(a+b)/2`、后者是 `a + (b−a)·0.5` —— 两个表达式数学上相等、
 * 浮点上不等（D-VISION-2）。这一行是**每个像素都要减的那个数**，
 * 所以差的那一位会落到整张图上。走 `npMedian`。
 */
export function levelLines(image: Mat, method: string, polyOrder: number): Mat {
  const out = Float64Array.from(image.data)
  const nx = image.cols
  const x = new Float64Array(nx)
  for (let c = 0; c < nx; c += 1) x[c] = c
  for (let r = 0; r < image.rows; r += 1) {
    const row = out.subarray(r * nx, (r + 1) * nx)
    if (method === 'median') {
      const m = npMedian(row)
      for (let c = 0; c < nx; c += 1) row[c] = (row[c] as number) - m
    } else if (method === 'poly') {
      const coeffs = polyfit(x, row, polyOrder)
      for (let c = 0; c < nx; c += 1) row[c] = (row[c] as number) - polyval(coeffs, c)
    }
  }
  return matOf(image.rows, nx, out)
}

export const LevelLines_Median: Skill = {
  spec: S.LevelLines_MedianSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const image = loadQuiet(params['image_path'])
    if (image === null) return fail('No image data available.')
    const method = params['method'] === undefined || params['method'] === null
      ? 'median' : String(params['method'])
    const polyOrder = Math.trunc(numOrDefault(params, 'poly_order', 1))
    let leveled: Mat
    try {
      leveled = levelLines(image, method, polyOrder)
    } catch (e) {
      return fail(`Line leveling failed: ${(e as Error).message}`)
    }
    return ok({
      method,
      rms_before: std(image.data),
      rms_after: std(leveled.data),
      output_path: persist(params['image_path'], '_leveled', leveled),
    })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 3. CorrectDrift_XCorr
// ──────────────────────────────────────────────────────────────────────────

/**
 * 旧仓 `_prepare_for_registration`：**非有限像素换成有限值的均值 → 扣直流 →
 * 乘一个可分离的二维汉宁窗**。
 *
 * 三步各挡一件事，而**只有第一步是政策**：
 *
 * | 步 | 挡的是 |
 * |---|---|
 * | 非有限值 → 有限值的均值 | 一个 NaN 会穿过整个 FFT，把整张互相关面变成 NaN（同 D-SI-1） |
 * | 扣直流 | 零频那一项在 SPM 图上比任何结构都大几个数量级，它会让峰**永远在原点** |
 * | 汉宁窗 | 帧边的不连续 = 一条横贯全谱的假频率，而它正好沿扫描方向 —— 也就是漂移最常见的方向 |
 *
 * `hanningWindow2d` 在 numerics 里（只做窗，不做前两步），理由写在那边的抬头：
 * 「NaN 该换成什么」是政策不是数值算法，那一层不替调用方决定。
 * 于是这两步留在这里 —— 它们是**这个技能的**判据。
 */
export function prepareForRegistration(img: Mat): Mat {
  const n = img.rows * img.cols
  const finite: number[] = []
  for (let i = 0; i < n; i += 1) {
    const v = img.data[i] as number
    if (Number.isFinite(v)) finite.push(v)
  }
  const fill = finite.length > 0 ? mean(finite) : 0.0
  const clean = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = img.data[i] as number
    clean[i] = Number.isFinite(v) ? v : fill
  }
  const dc = mean(clean)
  for (let i = 0; i < n; i += 1) clean[i] = (clean[i] as number) - dc
  const win = hanningWindow2d(img.rows, img.cols)
  for (let i = 0; i < n; i += 1) clean[i] = (clean[i] as number) * (win.data[i] as number)
  return matOf(img.rows, img.cols, clean)
}

/**
 * 旧仓 `drift_xcorr`。两个缺省与 skimage **刻意相反**，而它们不是「调参」：
 *
 * | | skimage 缺省 | 这里 |
 * |---|---|---|
 * | `normalization` | `'phase'` | **`null`**（普通互相关） |
 * | 预处理 | 无 | **扣直流 + 汉宁窗** |
 *
 * `normalization=None` 的理由写在旧仓 `CorrectDrift_XCorr` 的类 docstring 里：
 * 相位归一化把每个频点白化成单位模长，于是**没有信号的地方由噪声投票**
 * （D-NUM-20）。SPM 的行噪声是一条横贯整帧的脊，白化之后它与真结构一样有份量，
 * 而它锁定的是一个大位移的假峰 —— 那个数会被拿去驱动漂移补偿硬件。
 */
export function driftXcorr(
  ref: Mat, target: Mat, upsampleFactor: number, window: boolean, normalization: 'phase' | null,
): { shift: [number, number]; error: number; phase: number } {
  const a = window ? prepareForRegistration(ref) : ref
  const b = window ? prepareForRegistration(target) : target
  return phaseCrossCorrelation(a, b, upsampleFactor, normalization)
}

/**
 * `error` 这一条容差的**尺度**（D-NUM-21 的推广）。
 *
 * numerics 那条写的是「只能在平方上给**绝对**容差」，推导是：
 * `error² = |1 − r|`，`r = |CC|²/(src·tgt)`，而 `r ≈ 1` 时那是两个几乎相等的数
 * 相减 ⇒ 绝对误差就是 `r` 的相对精度。
 *
 * 但 `r` 不总在 1 附近：相位归一化那一档上 `r` 能到 `1e27`（skimage 拿**白化后**
 * 的 `CCmax` 去除**没白化**的两条功率和），这时 `Δ(1−r) ≈ r·δ` —— 按绝对值给
 * 容差就成了一句空话。两种情形合起来正好是一条式子：
 *
 * ```
 * |a² − w²| ≤ max(1, w²) · 32 · fftRelTol(n)
 * ```
 *
 * `max(1, w²)` 这一项就是「r 在 1 附近时退化成绝对、r 很大时退化成相对」。
 * 测试引用这个函数，不写字面量。
 */
export function xcorrErrorSqScale(wantErrorSq: number): number {
  return Math.max(1, Math.abs(wantErrorSq))
}

export const CorrectDrift_XCorr: Skill = {
  spec: S.CorrectDrift_XCorrSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let ref: Mat
    let target: Mat
    try {
      ref = loadImage2d(String(params['ref_path'] ?? ''))
      target = loadImage2d(String(params['target_path'] ?? ''))
    } catch (e) {
      return fail(`Failed to load images: ${messageOf(e)}`)
    }
    const upsample = Math.trunc(numOrDefault(params, 'upsample_factor', 10))
    const window = params['window'] === undefined ? true : Boolean(params['window'])
    const norm = String(params['normalization'] ?? 'none').toLowerCase() === 'phase' ? 'phase' : null

    // ⚠️ 形状不等这一句**照抄 skimage 的原话**。旧仓的报文是
    // `f"Cross-correlation failed: {exc}"`，而那个 `exc` 就是 skimage 抛的
    // `ValueError("images must be same shape")` —— 也就是说这句话是**模型读的那一句**。
    // 本仓 `phaseCrossCorrelation` 抛的是自己的中文措辞（它有自己的调用方），
    // 所以这一层先判一次。判据没变（形状不等就拒），变的只是谁来说这句话。
    if (ref.rows !== target.rows || ref.cols !== target.cols) {
      return fail('Cross-correlation failed: images must be same shape')
    }
    let r: { shift: [number, number]; error: number; phase: number }
    try {
      r = driftXcorr(ref, target, upsample, window, norm)
    } catch (e) {
      return fail(`Cross-correlation failed: ${messageOf(e)}`)
    }
    return ok({
      shift_y_px: r.shift[0],
      shift_x_px: r.shift[1],
      correlation_error: r.error,
      phase_diff: r.phase,
    })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 4. FindEmptySpot
// ──────────────────────────────────────────────────────────────────────────

/**
 * 把图切成 `grid_n × grid_n` 格，每格扣掉自己的均值再量 `std`，**最平的那一格赢**。
 *
 * ## `np.inf` 是一句话，不是一个占位符
 *
 * `roughness` 初值是 `np.full((n, n), np.inf)`，而空格子（`cell_h == 0`，
 * 也就是格子比像素还细）**跳过不填**。于是一张比格子还小的图上整张表都是 `inf`，
 * `argmin` 照样给 `(0, 0)` —— 而 `min_roughness: Infinity` 是**唯一**说得出
 * 「这一格里一个像素都没有」的字段。把 `inf` 换成一个大数、或者干脆换成 0，
 * 都会让「判不了」看起来像「非常粗糙」或者「完美平坦」。
 *
 * ## `argmin` 的并列是抽签，所以金样里没有并列
 *
 * `np.argmin` 在并列时给**第一个**，而两边的 `std` 在最后一位上没有理由相同
 * （本仓 `sum` 是 Neumaier、numpy 是成对求和）。一张「几格同样平」的图上
 * 谁赢由那一位决定。金样那张图每一格的幅度两两不等，最平的那一格领先 2 倍。
 */
export function findEmptySpot(image: Mat, gridN: number): {
  bestRow: number; bestCol: number; roughness: number[][]
} {
  const cellH = Math.floor(image.rows / gridN)
  const cellW = Math.floor(image.cols / gridN)
  const roughness: number[][] = []
  for (let r = 0; r < gridN; r += 1) roughness.push(new Array<number>(gridN).fill(Infinity))
  for (let r = 0; r < gridN; r += 1) {
    for (let c = 0; c < gridN; c += 1) {
      const patch: number[] = []
      for (let i = r * cellH; i < (r + 1) * cellH && i < image.rows; i += 1) {
        for (let j = c * cellW; j < (c + 1) * cellW && j < image.cols; j += 1) {
          patch.push(image.data[i * image.cols + j] as number)
        }
      }
      if (patch.length === 0) continue
      const m = mean(patch)
      ;(roughness[r] as number[])[c] = std(patch.map((v) => v - m))
    }
  }
  let best = Infinity
  let at = 0
  for (let k = 0; k < gridN * gridN; k += 1) {
    const v = (roughness[Math.floor(k / gridN)] as number[])[k % gridN] as number
    if (v < best) {
      best = v
      at = k
    }
  }
  return { bestRow: Math.floor(at / gridN), bestCol: at % gridN, roughness }
}

export const FindEmptySpot: Skill = {
  spec: S.FindEmptySpotSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let image: Mat
    try {
      image = loadImage2d(String(params['image_path'] ?? ''))
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    const gridN = Math.trunc(numOrDefault(params, 'grid_n', 4))
    const width = numOrDefault(params, 'scan_width_m', 100e-9)
    const height = numOrDefault(params, 'scan_height_m', 100e-9)
    let r: { bestRow: number; bestCol: number; roughness: number[][] }
    try {
      r = findEmptySpot(image, gridN)
    } catch (e) {
      return fail(`Region search failed: ${(e as Error).message}`)
    }
    const cellW = width / gridN
    const cellH = height / gridN
    return ok({
      best_cell_row: r.bestRow,
      best_cell_col: r.bestCol,
      center_x_m: (r.bestCol + 0.5) * cellW - width / 2,
      center_y_m: (r.bestRow + 0.5) * cellH - height / 2,
      min_roughness: (r.roughness[r.bestRow] as number[])[r.bestCol] as number,
      roughness_map: r.roughness,
    })
  },
}

/** `str(exc)` —— 旧仓那些报文里拼的就是它。`ImageLoadError` 的 `message` 已经是那一句。 */
function messageOf(e: unknown): string {
  return e instanceof ImageLoadError ? e.message : e instanceof Error ? e.message : String(e)
}

/** 这一族按 `sumRelTol` 走的那几个字段的尺度（测试引用它，见文件抬头的容差表）。 */
export const STD_REL_TOL = (n: number): number => sumRelTol(n) + 2 * EPS

export const PAPER_DATA: Readonly<Record<string, Skill>> = {
  SubtractPlane_RANSAC,
  LevelLines_Median,
  CorrectDrift_XCorr,
  FindEmptySpot,
}
