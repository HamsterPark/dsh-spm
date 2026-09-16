/**
 * `AutoCrop_UnscannedRegion`（scan_crop）与 `DetectAtomJump`（atom_jump）。
 *
 * ## 容差表（测试引用这些）
 *
 * | 件 | 对的是 | 容差 | 推导 |
 * |---|---|---|---|
 * | `detectSolidEdges` 的四个切边 | 旧仓同名函数 | **0** | 它们是**行数**。判据里的 `np.mean(布尔)` 是 `k/n`，一个整数比 |
 * | `cropUnscanned` 的 `bbox` 与输出 | 同上 | **0** | 输出是输入的一个**切片** —— 每个数原样搬过来 |
 * | `tolerance` 的缺省（`0.02 · ptp`） | `np.ptp` | **0** | 一次减法 |
 * | `statisticalDetect` 的 `z_score` / `confidence` | `np.mean` / `np.std` | {@link sumRelTol}(n) | 两次均值一次两遍法 `std`（D-NUM-1） |
 * | `jumped` | `z > threshold` | **0**（离散） | 金样里那两格离阈值各有一倍余量 |
 */
import { writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  encodeNpyFrame,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { matOf, mean, ptp, std, type Mat } from 'dsh-spm-numerics'
import { npMedian } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import {
  ImageLoadError,
  SUPPORTED_SPECTRUM_EXT,
  loadImage2d,
  loadSpectrum,
  matRows,
  siblingNpy,
} from './paper-common.js'
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

// ──────────────────────────────────────────────────────────────────────────
// AutoCrop_UnscannedRegion
// ──────────────────────────────────────────────────────────────────────────

/** 一行/一列里有多大比例贴着自己的中位，才算「实心」。 */
export const CROP_ROW_THRESH = 0.85
/** 一次往里扫多少行/列。**块**扫描是为了容忍实心区里画的标尺与十字线。 */
export const CROP_BLOCK_SIZE = 20
/** 一个块里有多大比例是实心行/列，才继续往里切。 */
export const CROP_BLOCK_THRESH = 0.6
/** 小于这个比例的切边当成没切（噪声）。 */
export const CROP_MIN_PCT = 0.08
/** 没给 `tolerance` 时按峰谷的这个比例取。 */
export const CROP_DEFAULT_TOL_FRAC = 0.02

/**
 * 找四条实心边。返回**要切掉多少行/列**（不是坐标）。
 *
 * ## 两条保险，各挡一件事
 *
 * | | |
 * |---|---|
 * | `min_crop_pct` | 切几行不叫「有一条没扫到的边」，那是噪声。低于 8% 归零 |
 * | `t + b >= 0.9·h` ⇒ 全归零 | **整幅都像实心的**时候，答案不是「全切掉」，是「一刀不切」。金样 `loose_default_tolerance` 走的正是它：容差给松了之后每一行都「实心」，而一张被切成 0×0 的图对调用方毫无用处 |
 *
 * 第二条尤其要紧，因为它是**唯一**一处「判据自己说我判过头了」。
 */
export function detectSolidEdges(
  arr: Mat, colorTol: number,
): [number, number, number, number] {
  const h = arr.rows
  const w = arr.cols
  const rowSolid = new Uint8Array(h)
  for (let r = 0; r < h; r += 1) {
    const row = arr.data.subarray(r * w, (r + 1) * w)
    const med = npMedian(row)
    let close = 0
    for (let c = 0; c < w; c += 1) if (Math.abs((row[c] as number) - med) < colorTol) close += 1
    rowSolid[r] = close / w >= CROP_ROW_THRESH ? 1 : 0
  }
  const colSolid = new Uint8Array(w)
  const col = new Float64Array(h)
  for (let c = 0; c < w; c += 1) {
    for (let r = 0; r < h; r += 1) col[r] = arr.data[r * w + c] as number
    const med = npMedian(col)
    let close = 0
    for (let r = 0; r < h; r += 1) if (Math.abs((col[r] as number) - med) < colorTol) close += 1
    colSolid[c] = close / h >= CROP_ROW_THRESH ? 1 : 0
  }

  const scan = (solid: Uint8Array, fromEnd: boolean): number => {
    const n = solid.length
    const at = (i: number): number => solid[fromEnd ? n - 1 - i : i] as number
    let crop = 0
    let i = 0
    while (i < n) {
      const end = Math.min(i + CROP_BLOCK_SIZE, n)
      let acc = 0
      for (let k = i; k < end; k += 1) acc += at(k)
      if (acc / (end - i) >= CROP_BLOCK_THRESH) {
        crop = end
        i = end
      } else break
    }
    return crop
  }

  let t = scan(rowSolid, false)
  let b = scan(rowSolid, true)
  let l = scan(colSolid, false)
  let r = scan(colSolid, true)
  const minH = Math.trunc(h * CROP_MIN_PCT)
  const minW = Math.trunc(w * CROP_MIN_PCT)
  if (t < minH) t = 0
  if (b < minH) b = 0
  if (l < minW) l = 0
  if (r < minW) r = 0
  if (t + b >= h * 0.9) { t = 0; b = 0 }
  if (l + r >= w * 0.9) { l = 0; r = 0 }
  return [t, b, l, r]
}

/**
 * 反复切，直到没得切或者次数用完。
 *
 * `max_iter` 不是「多做几遍求稳」—— 它是判据：**切掉一条边会露出另一条**。
 * 金样那张图上边框与左边框取的是**不同的常数**，于是左边那 14 列在第一趟里
 * 根本不是实心的（上半截是上边框的值）。`max_iter=1` 与 `3` 因此给出不同的形状。
 */
export function cropUnscanned(
  arr: Mat, colorTol: number, maxIter: number,
): { cropped: Mat; bbox: [number, number, number, number] } {
  const origH = arr.rows
  const origW = arr.cols
  let totalT = 0
  let totalB = 0
  let totalL = 0
  let totalR = 0
  let cur = arr
  for (let it = 0; it < maxIter; it += 1) {
    const [t, b, l, r] = detectSolidEdges(cur, colorTol)
    if (t === 0 && b === 0 && l === 0 && r === 0) break
    totalT += t
    totalB += b
    totalL += l
    totalR += r
    const h = cur.rows
    const w = cur.cols
    cur = slice(cur, t, b > 0 ? h - b : h, l, r > 0 ? w - r : w)
  }
  return { cropped: cur, bbox: [totalT, origH - totalB, totalL, origW - totalR] }
}

function slice(m: Mat, r0: number, r1: number, c0: number, c1: number): Mat {
  const rows = Math.max(0, r1 - r0)
  const cols = Math.max(0, c1 - c0)
  const out = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) out[r * cols + c] = m.data[(r0 + r) * m.cols + (c0 + c)] as number
  }
  return matOf(rows, cols, out)
}

/** 挑一个**保证不是输入本身**的 `.npy` 落点。 */
export function resolveCropOutput(imagePath: string, savePath: string): string {
  let dst = savePath !== ''
    ? (savePath.toLowerCase().endsWith('.npy') ? savePath : `${stripExt(savePath)}.npy`)
    : siblingNpy(imagePath, '_cropped')
  if (same(dst, imagePath)) {
    dst = siblingNpy(imagePath, '_cropped')
    if (same(dst, imagePath)) dst = siblingNpy(imagePath, '_cropped_out')
  }
  return dst
}

function stripExt(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const dot = p.lastIndexOf('.')
  return dot > cut ? p.slice(0, dot) : p
}

function same(a: string, b: string): boolean {
  try {
    return resolvePath(a) === resolvePath(b)
  } catch {
    return a === b
  }
}

export const AutoCrop_UnscannedRegion: Skill = {
  spec: S.AutoCrop_UnscannedRegionSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const imagePath = String(params['image_path'] ?? '')
    let image: Mat
    try {
      image = loadImage2d(imagePath)
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    let maxIter = Math.trunc(numOrDefault(params, 'max_iter', 3))
    if (maxIter < 1) maxIter = 1
    const tolRaw = params['tolerance']
    const tol = tolRaw === null || tolRaw === undefined || tolRaw === ''
      ? CROP_DEFAULT_TOL_FRAC * ptp(image.data)
      : Number(tolRaw)

    let r: { cropped: Mat; bbox: [number, number, number, number] }
    try {
      r = cropUnscanned(image, tol, maxIter)
    } catch (e) {
      return fail(`Crop detection failed: ${(e as Error).message}`)
    }
    const origShape = [image.rows, image.cols]
    const cropShape = [r.cropped.rows, r.cropped.cols]
    const didCrop = cropShape[0] !== origShape[0] || cropShape[1] !== origShape[1]

    let outputPath: string | null = null
    let saveError: string | null = null
    if (didCrop) {
      try {
        const dst = resolveCropOutput(imagePath, String(params['save_path'] ?? ''))
        writeFileSync(dst, encodeNpyFrame(matRows(r.cropped)))
        outputPath = dst
      } catch (e) {
        saveError = `${(e as Error).name}: ${(e as Error).message}`
      }
    }
    // 真切了却**没写成**不算成功：调用方会拿着 `cropped:true` + `output_path:null`
    // 去读一个从来没被写出来的文件（旧仓反馈⑨：一次失败的写不许读成 ok）。
    if (didCrop && outputPath === null) {
      return fail(
        `cropped ${origShape[0]}x${origShape[1]} → ${cropShape[0]}x${cropShape[1]} ` +
          `but failed to write the .npy: ${saveError ?? 'unknown error'}`,
        {
          crop_bbox: r.bbox,
          original_shape: origShape,
          cropped_shape: cropShape,
          output_path: null,
          cropped: true,
        },
      )
    }
    const summary = didCrop
      ? `Cropped ${origShape[0]}x${origShape[1]} → ${cropShape[0]}x${cropShape[1]} (bbox [${r.bbox.join(', ')}])`
      : `No unscanned border detected (${origShape[0]}x${origShape[1]})`
    return ok({
      crop_bbox: r.bbox,
      original_shape: origShape,
      cropped_shape: cropShape,
      output_path: outputPath,
      cropped: didCrop,
      tolerance: tol,
    }, summary)
  },
}

// ──────────────────────────────────────────────────────────────────────────
// DetectAtomJump
// ──────────────────────────────────────────────────────────────────────────

/** 少于这么多点就**不判**（回 `false, 0.0`）。 */
export const JUMP_MIN_POINTS = 10
/** `std` 小于它就当这条曲线是常数（回 `false, 0.0`）。 */
export const JUMP_DEAD_FLAT = 1e-30

/**
 * 「操控过程中原子跳了没有」的统计回退：把曲线从中间劈开，比两半的均值。
 *
 * ## ⚠️ 这个判据的 z 分数**上限是 2**，而缺省阈值是 3
 *
 * 设两半的均值差 `d`、组内标准差 `s`，则整条曲线的方差是 `s² + (d/2)²`，
 * 于是
 *
 * ```
 * z = d / √(s² + d²/4) ≤ d / (d/2) = 2      （s → 0 时取等）
 * ```
 *
 * **与跳变有多大无关** —— 跳得越高，分母跟着长。所以 `threshold = 3.0`
 * （缺省）时 `jumped` **永远是 `False`**，这个技能在缺省参数下报不出它
 * 名字里那件事。参数的下界是 1.0，也就是说只有 `threshold < 2` 才可能为真。
 *
 * 照移（金样 `threshold_1_jump` 是唯一一格 `true`），**没有修**：
 * 修它要动的是判据本身（换成 Welch t 或者真的 CUSUM），而那是另一个技能。
 * 欠账记在 deviation 与交接里。
 *
 * `confidence = min(1, z / (2·threshold))` —— 注意它拿**阈值**当尺度，
 * 于是同一条曲线在 `threshold=1` 上「置信度 1.0」、在 `threshold=3` 上「0.33」。
 * 那不是置信度，是「离阈值多远」。照移。
 */
export function statisticalDetect(
  trace: readonly number[] | Float64Array, threshold: number,
): { jumped: boolean; confidence: number } {
  if (trace.length < JUMP_MIN_POINTS) return { jumped: false, confidence: 0.0 }
  const mid = Math.floor(trace.length / 2)
  const first = Array.from(trace).slice(0, mid)
  const second = Array.from(trace).slice(mid)
  const stdAll = std(trace)
  if (stdAll < JUMP_DEAD_FLAT) return { jumped: false, confidence: 0.0 }
  const z = Math.abs(mean(second) - mean(first)) / stdAll
  return { jumped: z > threshold, confidence: Math.min(1.0, z / (threshold * 2)) }
}

export const DetectAtomJump: Skill = {
  spec: S.DetectAtomJumpSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const raw = params['current_trace']
    let values: Float64Array
    let traceLength: number
    try {
      const s = typeof raw === 'string' ? raw : ''
      if (s !== '' && SUPPORTED_SPECTRUM_EXT.some((e) => s.toLowerCase().endsWith(e))) {
        const a = loadSpectrum(s)
        values = a.values
        // ⚠️ `len(trace)` 在 numpy 上是**第 0 轴**的长度，不是元素个数。
        // 一份 `(64, 2)` 的 `.dat` 报的是 64。拿 `.size` 顶它会把
        // 「64 个采样点」说成「128 个」，而两个数都像一条合理的曲线长度。
        traceLength = a.shape.length > 0 ? (a.shape[0] as number) : a.values.length
      } else if (typeof raw === 'string') {
        const parsed = JSON.parse(raw) as unknown
        values = Float64Array.from((parsed as number[]).map((v) => Number(v)))
        traceLength = values.length
      } else {
        values = Float64Array.from((raw as number[]).map((v) => Number(v)))
        traceLength = values.length
      }
    } catch (e) {
      return fail(`Failed to load current trace: ${messageOf(e)}`)
    }
    const threshold = numOrDefault(params, 'threshold', 3.0)
    const r = statisticalDetect(values, threshold)
    // ⚠️ **这里与旧仓刻意不同**：旧仓写 `"cnn" if model_path else "statistical"`
    // —— 它报的是**请求**的那一条，而 CNN 抛异常落回统计时那句话就是假的。
    // 本仓没有 CNN 那一支，于是照抄会让这个字段**永远**说谎。
    // 同族的 `Denoise_AE` 在同一个位置上报的是真的跑了哪一条 —— 本仓跟它。
    // 见 deviation；金样 `model_path_says_cnn` 那一格把旧仓那一侧也钉住了。
    return ok({
      jumped: r.jumped,
      confidence: r.confidence,
      trace_length: traceLength,
      method: 'statistical',
    })
  },
}

export const PAPER_CROP: Readonly<Record<string, Skill>> = {
  AutoCrop_UnscannedRegion,
  DetectAtomJump,
}
