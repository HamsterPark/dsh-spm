/**
 * 三个「一张图进来、一张图出去」的 paper 技能 —— `SubtractPoly2D`（background）·
 * `Destripe_MorphOpen`（image_filters）· `Denoise_AE`（denoise）。
 *
 * ## 容差表（测试引用这些，**不许写字面量**）
 *
 * | 件 | 对的是 | 容差 | 推导 |
 * |---|---|---|---|
 * | `poly2dSubtract` 的输出 | `np.linalg.lstsq` + 求值 | {@link lstsqRelTol}(κ) | 本仓走正规方程（κ 平方），numpy 走 SVD。κ 随金样录（`condition_numbers.poly2d_*`） |
 * | `destripe` 的输出 | 逐行搬运 + 一次线性插值 | **0** | 输出要么是输入里某一行**原样**，要么是 `(1−w)·a + w·b` —— 两次乘一次加，两边同一个顺序。给它容差等于把「搬错了一行」藏起来 |
 * | `destripe` 的 `stripes_removed` | `int(np.sum(opened))` | **0** | 它是个计数 |
 * | `destripe` 的**判据**（哪几行是条纹） | `np.median` / `np.std` | **0**（离散） | 三档 normalized（硬 3.843 / 软 2.114 / 干净 0.0，阈 3.0 与 1.5）离各自阈值最近处有 **28%** 余量，浮点差在 1e-15 —— 不是抽签。**判语本身由金样钉着**（哪几行算条纹），余量塌了它会先红 |
 * | `gaussianFilter2d` 的输出 | `scipy.ndimage.gaussian_filter` | {@link convRelTol}(k) ×2 | 可分离，两轴各一次一维相关；本仓照抄了 scipy 的轴序与累加顺序 |
 * | `noise_estimate` | `np.std` | {@link sumRelTol}(n) | 一次两遍法 `std`（D-NUM-1） |
 */
import { writeFileSync } from 'node:fs'
import {
  encodeNpyFrame,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  gaussianFilter2d,
  matOf,
  solveNormalEquations,
  std,
  type Mat,
} from 'dsh-spm-numerics'
import { npMedian } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { ImageLoadError, loadImage2d, matRows, siblingNpy } from './paper-common.js'
import { fail, ok } from './common.js'

function messageOf(e: unknown): string {
  return e instanceof ImageLoadError ? e.message : e instanceof Error ? e.message : String(e)
}

function numOrDefault(params: Readonly<Record<string, unknown>>, key: string, d: number): number {
  const v = params[key]
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
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

// ──────────────────────────────────────────────────────────────────────────
// 1. SubtractPoly2D
// ──────────────────────────────────────────────────────────────────────────

/**
 * 二维多项式背景：`f(x,y) = Σ aᵢⱼ · xⁱ · yʲ`，坐标先归一化到 `[−1, 1]`。
 *
 * ## ⚠️ 设计阵是**张量积**，而 `numerics.fitPoly2d` 顶不了它
 *
 * `fitPoly2d` 是**固定的二阶六项**（`1, x, y, x², xy, y²`）。这里是
 * `order_x` 与 `order_y` **各自** 1..6 的张量积 ⇒ `(order_x+1)·(order_y+1)` 项，
 * 缺省 2×2 就是 **9 项**（不是 6）。拿六项去顶，`order_x=3` 那一格会
 * 少掉 `x³` 那一列 —— 而它**不会报错**，只会把一个立方的衬底留在图上，
 * 于是「减完背景之后剩下的东西」里多了一层看起来完全合理的起伏。
 *
 * ## 那条 `i + j > order_x + order_y` 的裁剪是**死代码**
 *
 * 旧仓第 352 行写着 `elif i + j > order_x + order_y: continue`。而循环是
 * `for i in range(order_x + 1)` / `for j in range(order_y + 1)` ⇒
 * `i + j` 的最大值**正好**是 `order_x + order_y`，那个 `>` 一次都不成立。
 * 所以项数恒为 `(order_x+1)·(order_y+1)`，`n_coefficients` 那个字段就是证据
 * （金样 `order31` 那一格是 **8** = 4×2，不是「总阶数 ≤ 4」的那 9 项）。
 * 照移，包括那条 `continue` 不写 —— 写一条永不成立的分支进来，
 * 下一个人会花半天去想它在挡什么。
 *
 * ## `mask` 是**排除**，不是选择
 *
 * `valid = ~mask.ravel()` —— 掩膜为真的像素**不参与拟合**，但背景仍然在
 * **整张图**上求值再减掉。把它读反了（拿掩膜内的点去拟合）不会报错，
 * 只会让分子自己定义它脚下的衬底。
 */
export function poly2dSubtract(
  image: Mat, orderX: number, orderY: number, mask: Uint8Array | null,
): { corrected: Mat; coeffs: number[] } {
  const ny = image.rows
  const nx = image.cols
  const n = ny * nx
  const xn = new Float64Array(n)
  const yn = new Float64Array(n)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      xn[r * nx + c] = (2.0 * c) / (nx - 1) - 1.0
      yn[r * nx + c] = (2.0 * r) / (ny - 1) - 1.0
    }
  }
  const terms: Float64Array[] = []
  for (let i = 0; i <= orderX; i += 1) {
    for (let j = 0; j <= orderY; j += 1) {
      const col = new Float64Array(n)
      for (let k = 0; k < n; k += 1) col[k] = (xn[k] as number) ** i * (yn[k] as number) ** j
      terms.push(col)
    }
  }
  const keep: number[] = []
  for (let k = 0; k < n; k += 1) if (mask === null || mask[k] === 0) keep.push(k)
  const fitCols = mask === null
    ? terms
    : terms.map((col) => Float64Array.from(keep, (k) => col[k] as number))
  const z = mask === null ? image.data : Float64Array.from(keep, (k) => image.data[k] as number)
  const coeffs = solveNormalEquations(fitCols, Float64Array.from(z))

  const out = new Float64Array(n)
  for (let k = 0; k < n; k += 1) {
    let bg = 0
    for (let t = 0; t < terms.length; t += 1) bg += ((terms[t] as Float64Array)[k] as number) * (coeffs[t] as number)
    out[k] = (image.data[k] as number) - bg
  }
  return { corrected: matOf(ny, nx, out), coeffs: Array.from(coeffs) }
}

export const SubtractPoly2D: Skill = {
  spec: S.SubtractPoly2DSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let image: Mat
    try {
      image = loadImage2d(String(params['image_path'] ?? ''))
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    const orderX = Math.trunc(numOrDefault(params, 'order_x', 2))
    const orderY = Math.trunc(numOrDefault(params, 'order_y', 2))

    // 掩膜读不动**一声不吭地当没有**（旧仓 `except: pass`）。照移：这是一条
    // 「宁可少一道限制也不要失败」的选择，而它的代价是一个打错的 mask_path
    // 会静默地变成「没有掩膜」。金样 `mask_unreadable` 那一格钉着它。
    let mask: Uint8Array | null = null
    const maskPath = String(params['mask_path'] ?? '')
    if (maskPath !== '') {
      try {
        const m = loadImage2d(maskPath)
        mask = Uint8Array.from(m.data, (v) => (v !== 0 ? 1 : 0))
      } catch {
        mask = null
      }
    }
    let r: { corrected: Mat; coeffs: number[] }
    try {
      r = poly2dSubtract(image, orderX, orderY, mask)
    } catch (e) {
      return fail(`Polynomial subtraction failed: ${(e as Error).message}`)
    }
    return ok({
      corrected_image_shape: [r.corrected.rows, r.corrected.cols],
      order_x: orderX,
      order_y: orderY,
      n_coefficients: r.coeffs.length,
      output_path: persist(params['image_path'], '_poly2d', r.corrected),
    })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Destripe_MorphOpen
// ──────────────────────────────────────────────────────────────────────────

/** `dev_std` 小于它就当整张图没有条纹（旧仓那条早退）。 */
export const DESTRIPE_DEAD_FLAT = 1e-30

/**
 * 去横条纹。名字里的 **MorphOpen 是手写的一维行程开运算**，
 * **不是** `scipy.ndimage.grey_opening`。
 *
 * 拿 `greyOpening(rectSE(k, 1))` 去顶它是错的，而且错得很安静：
 * 形态学开运算是「腐蚀再膨胀」，它把短行程**截掉两端**（长度 ≥ k 的行程也会
 * 被削短、相邻行程会被连起来）；这里要的是**整段留或者整段丢**
 * （`if run_len < min_length: opened[run_start:i] = False`）。
 * 两者在一段长 10、`k=5` 的行程上给出**不同的行数**，而两个结果都是一张
 * 「去过条纹的图」。
 *
 * ## 四道判据，缺一道就换一张图
 *
 * | | |
 * |---|---|
 * | 双阈 | 硬阈标「肯定是」，软阈标「可能是」，而软的**只在挨着硬的时候**才算数 —— 一条孤立的、略高于软阈的行是噪声不是条纹 |
 * | 连接半径 = `min_length` | 同一个参数当两件事用（连接半径 + 行程下限），照移 |
 * | 行程下限 | 一条**单行**的偏移多半是真形貌（一个台阶），不是仪器毛病 |
 * | 替换用**上下最近的非条纹行**线性插值 | 不是删掉、不是置零 —— 图的形状必须留着，下游还要在上面量东西 |
 *
 * ## `dev_std` 早退那一条
 *
 * 一张死平的图上 `deviations` 全是 0 ⇒ `dev_std = 0` ⇒ `normalized = 0/0 = NaN`
 * ⇒ 每一条 `>` 都是假 ⇒ 零条纹。旧仓**在除法之前**判了一次 `< 1e-30` 直接回
 * 原图。两条路的结果一样，但早退那一条说得出「这张图我看过、它是平的」，
 * 而 NaN 那一条只是恰好没有任何东西通过。
 */
export function destripe(
  image: Mat, hardThreshold: number, softThreshold: number, minLength: number,
): { corrected: Mat; nStripes: number } {
  const nrows = image.rows
  const ncols = image.cols
  const result = Float64Array.from(image.data)

  const rowMedians = new Float64Array(nrows)
  for (let r = 0; r < nrows; r += 1) {
    rowMedians[r] = npMedian(image.data.subarray(r * ncols, (r + 1) * ncols))
  }
  const globalMedian = npMedian(rowMedians)
  const deviations = Float64Array.from(rowMedians, (v) => Math.abs(v - globalMedian))
  const devStd = std(deviations)
  if (devStd < DESTRIPE_DEAD_FLAT) return { corrected: matOf(nrows, ncols, result), nStripes: 0 }

  const hard = new Uint8Array(nrows)
  const soft = new Uint8Array(nrows)
  for (let r = 0; r < nrows; r += 1) {
    const nrm = (deviations[r] as number) / devStd
    hard[r] = nrm > hardThreshold ? 1 : 0
    soft[r] = nrm > softThreshold ? 1 : 0
  }
  const stripe = Uint8Array.from(hard)
  for (let i = 0; i < nrows; i += 1) {
    if (soft[i] === 1 && hard[i] === 0) {
      let connected = false
      for (let j = Math.max(0, i - minLength); j < Math.min(nrows, i + minLength + 1); j += 1) {
        if (hard[j] === 1) {
          connected = true
          break
        }
      }
      if (connected) stripe[i] = 1
    }
  }

  // ── 行程开运算（**手写的那一种**，见抬头） ──
  const opened = Uint8Array.from(stripe)
  let runStart: number | null = null
  for (let i = 0; i < nrows; i += 1) {
    if (opened[i] === 1) {
      if (runStart === null) runStart = i
    } else if (runStart !== null) {
      if (i - runStart < minLength) opened.fill(0, runStart, i)
      runStart = null
    }
  }
  if (runStart !== null && nrows - runStart < minLength) opened.fill(0, runStart)

  let nStripes = 0
  for (let i = 0; i < nrows; i += 1) nStripes += opened[i] as number
  for (let i = 0; i < nrows; i += 1) {
    if (opened[i] === 0) continue
    let above: number | null = null
    let below: number | null = null
    for (let j = i - 1; j >= 0; j -= 1) if (opened[j] === 0) { above = j; break }
    for (let j = i + 1; j < nrows; j += 1) if (opened[j] === 0) { below = j; break }
    for (let c = 0; c < ncols; c += 1) {
      if (above !== null && below !== null) {
        const w = (i - above) / (below - above)
        result[i * ncols + c] =
          (1 - w) * (image.data[above * ncols + c] as number) + w * (image.data[below * ncols + c] as number)
      } else if (above !== null) {
        result[i * ncols + c] = image.data[above * ncols + c] as number
      } else if (below !== null) {
        result[i * ncols + c] = image.data[below * ncols + c] as number
      }
    }
  }
  return { corrected: matOf(nrows, ncols, result), nStripes }
}

export const Destripe_MorphOpen: Skill = {
  spec: S.Destripe_MorphOpenSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let image: Mat
    try {
      image = loadImage2d(String(params['image_path'] ?? ''))
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    const hard = numOrDefault(params, 'hard_threshold', 3.0)
    const soft = numOrDefault(params, 'soft_threshold', 1.5)
    const minLength = Math.trunc(numOrDefault(params, 'min_length', 5))
    let r: { corrected: Mat; nStripes: number }
    try {
      r = destripe(image, hard, soft, minLength)
    } catch (e) {
      return fail(`Destripe failed: ${(e as Error).message}`)
    }
    return ok({
      corrected_image_shape: [r.corrected.rows, r.corrected.cols],
      stripes_removed: r.nStripes,
      output_path: persist(params['image_path'], '_destriped', r.corrected),
    })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Denoise_AE
// ──────────────────────────────────────────────────────────────────────────

/**
 * 去噪。旧仓有两条路：训练好的自编码器，和**高斯滤波回退**。
 *
 * ## `model_path` 那一支**没有移**，而 `method` 仍然说实话
 *
 * 本仓没有 `onnxruntime`（Phase 8 才接），所以给了 `model_path` 也只会走回退。
 * 旧仓在这一点上是**对的**：它在 `except` 里把 `method` 改成 `"gaussian"`，
 * 于是返回值说的是**真的跑了哪一条**。照移这条纪律 ——
 * 同族的 `DetectAtomJump` 在同一个位置上说的是**请求的那一条**（见那边的
 * deviation），两个技能一个说实话一个说请求，而这是同一天写的同一个模式。
 *
 * `noise_estimate = std(原图 − 去噪图)` —— 它量的是**被滤掉的那部分**，
 * 于是 σ 越大这个数越大。它不是「图里有多少噪声」，是「我拿掉了多少」。
 */
export const Denoise_AE: Skill = {
  spec: S.Denoise_AESpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let image: Mat
    try {
      image = loadImage2d(String(params['image_path'] ?? ''))
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    const sigma = numOrDefault(params, 'gaussian_sigma', 1.0)
    const denoised = gaussianFilter2d(image, sigma)
    const diff = Float64Array.from(image.data, (v, i) => v - (denoised.data[i] as number))
    return ok({
      denoised_image_shape: [denoised.rows, denoised.cols],
      noise_estimate: std(diff),
      method: 'gaussian',
      output_path: persist(params['image_path'], '_denoised', denoised),
    })
  },
}

export const PAPER_IMAGE: Readonly<Record<string, Skill>> = {
  SubtractPoly2D,
  Destripe_MorphOpen,
  Denoise_AE,
}
