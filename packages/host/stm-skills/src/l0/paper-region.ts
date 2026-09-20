/**
 * 批 7b-3 的四个 paper 纯函数技能 —— `DiffScans_ChangeDetect`（scan_diff）·
 * `DeconvolveTip_RL`（deconvolution）· `SegmentRegion_UNet` / `DetectAtoms_FCN`
 * （region_analysis 的可移植那一半）。
 *
 * 与批 4c 的九个**同一形状**：吃文件路径、`context` 收下不用、
 * 产物是几个标量加一张 `.npy`。底座（`loadImage2d` / `siblingNpy` /
 * `encodeNpyFrame`）批 4c 已建，这一批一件新原语都不拉。
 *
 * ## 容差表（测试引用这些，**不许写字面量**）
 *
 * | 件 | 对的是 | 容差 | 推导 |
 * |---|---|---|---|
 * | `shift_px` / `overlap_shape` / `n_atoms` / `positions` / `n_classes` / `dominant_class` | 整数 | **0** | 它们是下标与计数 |
 * | `class_areas` | `count / size` | **0** | 分子是整数、分母是整数，两边同一次除法 |
 * | `rms_before` / `rms_after` / `rms_improvement` | `np.sqrt(np.nanmean(·²))` | `STD_REL_TOL(n)` | 一次 nanmean，同 `paper-data.ts` 那条 |
 * | `iterations_used` | RL 的收敛判据 | **0** | 它是**整数**，见下面「为什么这一格不许有容差」 |
 * | 反卷积写出的 `.npy` | `fftconvolve` × 30 轮 | {@link rlOutputRelTol} | 每轮两次卷积，见下 |
 *
 * ## ⚠️ `fftconvolve` ↔ `correlate2d`：两处**必须**对上，否则整幅图平移一格
 *
 * 旧仓的 RL 用 `scipy.signal.fftconvolve(x, psf, mode='same')`，本仓只有
 * `correlate2d`（**不翻核**，`numerics/src/correlate.ts`）。恒等式是
 * `conv(x, b) = correlate(x, flip(b))` —— 但那只在**核的两个尺寸都是奇数**时
 * 连原点一起对得上：
 *
 * ```
 * scipy 的 same-卷积取 full 的 [ (M−1)//2 … ]，
 * 而 correlate2d 的原点是 (M−1)>>1 —— 翻核之后偏移变成 M − 1 − (M−1)>>1 = M//2。
 * M 奇数：(M−1)//2 == M//2  ✓
 * M 偶数：差 1               ✗
 * ```
 *
 * `make_gaussian_psf` 造出来的核**恒为奇数**（`int(6σ) | 1`），所以缺省那一路
 * 不会碰到；但 `psf_mode='custom'` 读的是磁盘上任意一张图。偶数核上差的这一格
 * **不会报错**，只会把整幅反卷积结果平移一个像素 —— 而一张平移一个像素的
 * 形貌图看起来完全正常。{@link convolveSame} 的补零就是为它写的，
 * 金样里有一格 4×4 的自定义 PSF 专门验它（同 `morphology.ts` 抬头 ②：
 * 奇数尺寸看不出来的那一类错，只有偶数那一格分得开）。
 *
 * ## 为什么 `iterations_used` 这一格不许有容差
 *
 * RL 的收敛判据是 `change < 1e-6`，而 `change` 是两次迭代之差的相对量。
 * 两侧的卷积一个走 FFT、一个直接算，`change` 本身只在最后几位不同 ——
 * 但**判据是一次比较**，落在边界上就换答案。所以金样这一格的设计纪律是
 * 「离 1e-6 远」：录的每一格要么远没收敛（跑满 `iterations`）、
 * 要么 `change` 比 1e-6 小好几个数量级。导出器把每一格的 `change` 轨迹一起录，
 * 余量看得见（`rl_facts`）。
 *
 * ## ML 那一支不移 —— 而 `method` 说实话
 *
 * `SegmentRegion_UNet` / `DetectAtoms_FCN` 都有 `model_path` 分支（torch）。
 * 照 `Denoise_AE` 的先例（`paper-image.ts:305`）：**不移 ML，只留启发式，
 * 并让 `method` 报真的跑了哪一条**（`'heuristic'`），
 * 而不是照 `DetectAtomJump` 报请求的那一条。
 *
 * 巧的是**这一条在旧仓里本来就成立**：两个技能的 `except` 分支里
 * `method = "heuristic"`（`region_analysis.py:139` 与 `:290`），
 * 而 torch 装不上时走的正是那一支。所以这里不是「本仓与旧仓不一样」，
 * 是「本仓永远走旧仓的那一支」—— 与 `scan-prep-skills.ts:26` 同形。
 */
import { writeFileSync } from 'node:fs'
import {
  encodeNpyFrame,
  formatG,
  pyFixed,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  correlate2d,
  convRelTol,
  greyDilation,
  labelConnected,
  matOf,
  mean,
  percentile,
  rectSE,
  std,
  type Mat,
} from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { driftXcorr } from './paper-data.js'
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

function intOrDefault(params: Readonly<Record<string, unknown>>, key: string, d: number): number {
  return Math.trunc(numOrDefault(params, key, d))
}

function strOf(params: Readonly<Record<string, unknown>>, key: string): string {
  const v = params[key]
  return v === null || v === undefined ? '' : String(v)
}

/** 写一个 `.npy`。写不动**不算失败**（旧仓是 `logger.warning` + `None`）。 */
function writeNpy(dst: string, m: Mat): string | null {
  try {
    writeFileSync(dst, encodeNpyFrame(matRows(m)))
    return dst
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 1. DiffScans_ChangeDetect
// ──────────────────────────────────────────────────────────────────────────

/** 旧仓 `scan_diff._UPSAMPLE` —— 亚像素求峰之后**四舍五入成整数**再切片。 */
export const DIFF_UPSAMPLE = 10

export interface DiffScansResult {
  readonly diff: Mat
  readonly shiftPx: readonly [number, number]
  readonly overlapShape: readonly [number, number]
  readonly rmsBefore: number
  readonly rmsAfter: number
  readonly rmsImprovement: number
}

/** `np.sqrt(np.nanmean(x²))` —— **NaN 不参与**，而分母也跟着少一个。 */
function nanRms(a: Mat, b: Mat): number {
  let acc = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 1) {
    const d = (a.data[i] as number) - (b.data[i] as number)
    const sq = d * d
    if (Number.isNaN(sq)) continue
    acc += sq
    n += 1
  }
  return n === 0 ? NaN : Math.sqrt(acc / n)
}

/** `np.squeeze` 之后那个形状的 `repr` —— 单行图印成 `(N,)`。 */
function pyShape(m: Mat): string {
  return m.rows === 1 ? `(${m.cols},)` : `(${m.rows}, ${m.cols})`
}

function crop(m: Mat, r0: number, r1: number, c0: number, c1: number): Mat {
  const rows = r1 - r0
  const cols = c1 - c0
  const out = new Float64Array(Math.max(0, rows) * Math.max(0, cols))
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) out[r * cols + c] = m.data[(r0 + r) * m.cols + (c0 + c)] as number
  }
  return matOf(Math.max(0, rows), Math.max(0, cols), out)
}

/**
 * 旧仓 `diff_scans`：估整数像素漂移 → 切到重叠区 → 作差。
 *
 * 约定（旧仓 docstring 逐字）：`shift = phase_cross_correlation(A, B)`，
 * 于是 `A[i, j]` 对应 `B[i − dy, j − dx]`。**整数**位移让重叠区可以直接切片，
 * 差图因此是精确的（零插值）。
 *
 * `rms_before` 拿的是 **B 在 A 的重叠坐标上、没有对齐**的那一块 ——
 * 两块在同一个窗口里比，所以 `rms_improvement` 量的确实是「配准去掉了多少」。
 *
 * ## 那道 `ndim != 2` 的闸：**本仓的等价条件是 `rows === 1`**
 *
 * 旧仓在 `np.squeeze` 之后判 `arr.ndim != 2`，而本仓 `loadImage2d` 恒返回一张
 * `Mat`（二维）。两者**不是**「本仓少了一道闸」——它们逐格等价：
 *
 * | npy 形状 | `np.squeeze` 之后 | 本仓 `Mat` |
 * |---|---|---|
 * | `(N, M)`，N,M > 1 | `(N, M)` ✓ 放行 | `N×M`，`rows > 1` ✓ |
 * | `(M,)` / `(1, M)` / `(N, 1)` | 一维 ⇒ **拒** | `1×M` / `1×N`，`rows === 1` ⇒ 拒 |
 * | `(k, N, M)` | `(k, N·M)` ✓ | `k×(N·M)` ✓ |
 *
 * 报文里的形状也照着摆：`rows === 1` 时印 `(cols,)`（squeeze 之后的一维形状）。
 * **唯一对不上的是 `(1,1)`**：旧仓 squeeze 成 0 维印 `()`，本仓印 `(1,)`。
 * 那一格没录进金样，见 deviation。
 */
export function diffScans(a0: Mat, b0: Mat, register: boolean): DiffScansResult {
  if (a0.rows === 1 || b0.rows === 1) {
    throw new RangeError(`both scans must be 2-D (got ${pyShape(a0)} and ${pyShape(b0)})`)
  }
  const ny = Math.min(a0.rows, b0.rows)
  const nx = Math.min(a0.cols, b0.cols)
  // ⚠️ 这一条**够不着**，两侧都一样：`loadImage2d` 对空数组当场抛
  // （`parsed to an empty array`），于是走到这里的 `Mat` 恒有 `rows ≥ 1`、
  // `cols ≥ 1`，而上一道闸又把 `rows === 1` 挡掉了。留着是因为旧仓有它
  // （哪天 `Mat` 的来源变了就是它上场的时候），但**不为它编金样** ——
  // 一格造不出来的输入不是判据（green-8 §2.8）。
  if (ny < 1 || nx < 1) throw new RangeError('scans have no common region to difference')
  const a = crop(a0, 0, ny, 0, nx)
  const b = crop(b0, 0, ny, 0, nx)

  let dy = 0
  let dx = 0
  if (register) {
    const r = driftXcorr(a, b, DIFF_UPSAMPLE, true, null)
    dy = Math.round(r.shift[0])
    dx = Math.round(r.shift[1])
    // 配准跑飞了也要留下一块非空的重叠区。
    dy = Math.max(-(ny - 1), Math.min(ny - 1, dy))
    dx = Math.max(-(nx - 1), Math.min(nx - 1, dx))
  }

  const r0 = Math.max(0, dy)
  const r1 = Math.min(ny, ny + dy)
  const c0 = Math.max(0, dx)
  const c1 = Math.min(nx, nx + dx)
  const aOver = crop(a, r0, r1, c0, c1)
  const bAligned = crop(b, r0 - dy, r1 - dy, c0 - dx, c1 - dx)
  const bSame = crop(b, r0, r1, c0, c1)

  const diff = matOf(
    aOver.rows,
    aOver.cols,
    Float64Array.from(aOver.data, (v, i) => v - (bAligned.data[i] as number)),
  )
  const rmsBefore = nanRms(aOver, bSame)
  const zero = matOf(diff.rows, diff.cols, new Float64Array(diff.data.length))
  const rmsAfter = nanRms(diff, zero)
  const rmsImprovement = rmsBefore > 0 ? (1.0 - rmsAfter / rmsBefore) * 100.0 : 0.0
  return {
    diff,
    shiftPx: [dy, dx],
    overlapShape: [diff.rows, diff.cols],
    rmsBefore,
    rmsAfter,
    rmsImprovement,
  }
}

/**
 * 输出路径，**绝不覆盖两张输入**。旧仓 `_resolve_output_path` 逐字：
 * 给了 `save_path` 就用它（后缀不是 `.npy` 就换成 `.npy`），
 * 否则 `<A 的目录>/<A 的 stem>_diff_<B 的 stem>.npy`；
 * 万一算出来的名字正好是某一张输入，再加一层 `_diff`。
 *
 * ⚠️ `with_suffix('.npy')` 换的是**最后一个**扩展名，不是追加 ——
 * `out.txt` → `out.npy`，不是 `out.txt.npy`。
 */
export function diffOutputPath(scanA: string, scanB: string, savePath: string): string {
  let dst: string
  if (savePath !== '') {
    dst = /\.npy$/i.test(savePath) ? savePath : withSuffixNpy(savePath)
  } else {
    dst = siblingNpy(scanA, `_diff_${stemOf(scanB)}`)
  }
  if (samePath(dst, scanA) || samePath(dst, scanB)) dst = siblingNpy(dst, '_diff')
  return dst
}

function stemOf(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = p.slice(cut + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

/** `Path.with_suffix('.npy')` —— 换掉最后一个扩展名；本来没有就加上。 */
function withSuffixNpy(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = p.slice(cut + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? `${p}.npy` : `${p.slice(0, cut + 1)}${base.slice(0, dot)}.npy`
}

/**
 * 旧仓的 `_same` 是 `Path.resolve() == Path.resolve()`，**会碰文件系统**
 * （symlink / 大小写 / `..`）。本仓这一侧只做**分隔符归一 + 逐字比**：
 * 一次 `realpath` 在文件不存在时两边行为还不一样，而这道闸防的是
 * 「算出来的输出名正好等于输入名」——那是一次字符串巧合，不是一次链接解析。
 * 登记为一条 deviation。
 */
function samePath(p: string, q: string): boolean {
  return p.replaceAll('\\', '/') === q.replaceAll('\\', '/')
}

export const DiffScans_ChangeDetect: Skill = {
  spec: S.DiffScans_ChangeDetectSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let a: Mat
    let b: Mat
    try {
      a = loadImage2d(strOf(params, 'scan_a_path'))
      b = loadImage2d(strOf(params, 'scan_b_path'))
    } catch (e) {
      return fail(`Failed to load scans: ${messageOf(e)}`)
    }
    const register = params['register'] !== false
    let r: DiffScansResult
    try {
      r = diffScans(a, b, register)
    } catch (e) {
      return fail(`Scan differencing failed: ${messageOf(e)}`)
    }
    const dst = diffOutputPath(
      strOf(params, 'scan_a_path'), strOf(params, 'scan_b_path'), strOf(params, 'save_path'),
    )
    const saved = writeNpy(dst, r.diff)
    const [dy, dx] = r.shiftPx
    return ok(
      {
        shift_px: [dy, dx],
        overlap_shape: [r.overlapShape[0], r.overlapShape[1]],
        rms_before: r.rmsBefore,
        rms_after: r.rmsAfter,
        rms_improvement: r.rmsImprovement,
        output_path: saved,
      },
      `shift=(${signed(dy)},${signed(dx)}) px, overlap ${r.overlapShape[0]}x${r.overlapShape[1]}, ` +
        `RMS ${formatG(r.rmsBefore, 4)}->${formatG(r.rmsAfter, 4)} ` +
        `(${signedF1(r.rmsImprovement)}% better)`,
    )
  },
}

/** Python 的 `f"{n:+d}"`。 */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n)
}

/**
 * Python 的 `f"{x:+.1f}"`。
 *
 * ⚠️ 小数那一半走 kernel 的 {@link pyFixed}，**不自己写一份**：
 * `toFixed` 与 Python 的 `%.1f` 在半分点上不同（round-half-even），
 * 而 `pyFixed` 是批 6b 拿 75 901 格对着 CPython 校过的那一份
 * （连 `-0` 的符号从输入读这一条一起）。这里只补 `+` 号。
 */
function signedF1(x: number): string {
  const s = pyFixed(x, 1)
  return s.startsWith('-') ? s : `+${s}`
}

// ──────────────────────────────────────────────────────────────────────────
// 2. DeconvolveTip_RL
// ──────────────────────────────────────────────────────────────────────────

/** 旧仓 `make_gaussian_psf` —— 边长 `int(6σ) | 1`（**恒为奇数**），至少 3。 */
export function makeGaussianPsf(sigma: number): Mat {
  const size = Math.max(Math.trunc(6 * sigma) | 1, 3)
  const half = size >> 1
  const out = new Float64Array(size * size)
  let total = 0
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      const y = i - half
      const x = j - half
      const v = Math.exp(-(x * x + y * y) / (2 * sigma * sigma))
      out[i * size + j] = v
      total += v
    }
  }
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) / total
  return matOf(size, size, out)
}

function flipBoth(m: Mat): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      out[r * m.cols + c] = m.data[(m.rows - 1 - r) * m.cols + (m.cols - 1 - c)] as number
    }
  }
  return matOf(m.rows, m.cols, out)
}

/**
 * `scipy.signal.fftconvolve(a, b, mode='same')`，用**已有的** `correlate2d` 拼出来。
 *
 * `conv(a, b) = correlate(a, flip(b))`，而原点只在 `b` 的尺寸为奇数时自动对上
 * （见文件抬头那一段推导）。偶数那一维**在翻转之后的核前面补一行/一列零**：
 * 尺寸变奇数、原点正好挪回 same-卷积要的那一格。
 */
export function convolveSame(a: Mat, b: Mat): Mat {
  const k = flipBoth(b)
  const padR = k.rows % 2 === 0 ? 1 : 0
  const padC = k.cols % 2 === 0 ? 1 : 0
  if (padR === 0 && padC === 0) return correlate2d(a, k)
  const rows = k.rows + padR
  const cols = k.cols + padC
  const out = new Float64Array(rows * cols)
  for (let r = 0; r < k.rows; r += 1) {
    for (let c = 0; c < k.cols; c += 1) out[r * cols + c] = k.data[r * k.cols + c] as number
  }
  return correlate2d(a, matOf(rows, cols, out))
}

/**
 * RL 反卷积写出去那张 `.npy` 的容差。
 *
 * 每一轮两次卷积，每次卷积是 `psf.rows·psf.cols` 次乘加 ⇒ 一轮的相对误差
 * 约 `2·convRelTol(taps)`；`iters` 轮**线性**累计（RL 的更新是乘性的，
 * 相对误差相加而不是相乘放大）。旧仓走 FFT、本仓直接算，两条路的舍入
 * 完全不同 —— 这条容差写的是「两条路各自的累计上界之和」。
 */
export function rlOutputRelTol(psfTaps: number, iters: number): number {
  return 4 * Math.max(1, iters) * convRelTol(psfTaps)
}

export interface RlResult {
  readonly image: Mat
  readonly iterations: number
  /** 每一轮的 `change`。金样把它一起录下来 —— 收敛判据的余量要看得见。 */
  readonly changes: number[]
}

/** 旧仓 `richardson_lucy`，逐行。 */
export function richardsonLucy(image: Mat, psf: Mat, iterations: number, damping: number): RlResult {
  let imgMin = Infinity
  for (const v of image.data) if (v < imgMin) imgMin = v
  const im = matOf(
    image.rows, image.cols,
    Float64Array.from(image.data, (v) => v - imgMin + 1e-12),
  )
  const psfMirror = flipBoth(psf)
  let estimate = im
  const changes: number[] = []

  for (let i = 0; i < iterations; i += 1) {
    // 快照放在**循环顶部**：收敛判据比的是新估计与**紧挨着的上一轮**
    // （旧仓 2026 那次修补的正是这一行 —— 放在底部会与两轮前比，
    // 于是每一轮的变化量被高估，早停要么迟到要么根本不发生）。
    const prev = estimate
    const convolved = convolveSame(estimate, psf)
    for (let k = 0; k < convolved.data.length; k += 1) {
      if ((convolved.data[k] as number) < 1e-30) convolved.data[k] = 1e-30
    }
    const ratio = matOf(
      im.rows, im.cols,
      Float64Array.from(im.data, (v, k) => v / (convolved.data[k] as number)),
    )
    let correction = convolveSame(ratio, psfMirror)
    // ⚠️ 这个 `if` **不是一道闸**，是一次微优化：IEEE-754 与 ECMA-262
    // （`Number::exponentiate` 第一条「指数是 +1 就回 base」）都规定
    // `x ** 1.0` **精确等于** `x`，numpy 同。照移（旧仓就这么写），
    // 但别把它当成判据 —— 变异演练在这里跑出过一次绿色，而那次绿色是对的。
    // 真正做决定的是下一行**施不施加阻尼**，变异打在那里。
    if (damping < 1.0) {
      correction = matOf(
        correction.rows, correction.cols,
        Float64Array.from(correction.data, (v) => v ** damping),
      )
    }
    const next = matOf(
      estimate.rows, estimate.cols,
      Float64Array.from(estimate.data, (v, k) => v * (correction.data[k] as number)),
    )
    const dev = Float64Array.from(next.data, (v, k) => Math.abs(v - (prev.data[k] as number)))
    const mag = Float64Array.from(next.data, (v) => Math.abs(v))
    const change = mean(dev) / (mean(mag) + 1e-30)
    changes.push(change)
    if (change < 1e-6) {
      return {
        image: matOf(next.rows, next.cols, Float64Array.from(next.data, (v) => v + imgMin)),
        iterations: i + 1,
        changes,
      }
    }
    estimate = next
  }
  return {
    image: matOf(estimate.rows, estimate.cols, Float64Array.from(estimate.data, (v) => v + imgMin)),
    iterations,
    changes,
  }
}

export const DeconvolveTip_RL: Skill = {
  spec: S.DeconvolveTip_RLSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let image: Mat
    try {
      image = loadImage2d(strOf(params, 'image_path'))
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    const psfMode = params['psf_mode'] === undefined ? 'gaussian' : String(params['psf_mode'])
    const iterations = intOrDefault(params, 'iterations', 30)
    const damping = numOrDefault(params, 'damping', 0.8)

    let psf: Mat
    if (psfMode === 'custom') {
      const psfPath = strOf(params, 'psf_path')
      if (psfPath === '') return fail("psf_path required when psf_mode='custom'")
      try {
        psf = loadImage2d(psfPath)
      } catch (e) {
        return fail(`Failed to load PSF: ${messageOf(e)}`)
      }
    } else {
      psf = makeGaussianPsf(numOrDefault(params, 'psf_sigma', 2.0))
    }

    let r: RlResult
    try {
      r = richardsonLucy(image, psf, iterations, damping)
    } catch (e) {
      return fail(`Deconvolution failed: ${messageOf(e)}`)
    }
    return ok({
      deconvolved_image_shape: [r.image.rows, r.image.cols],
      iterations_used: r.iterations,
      psf_mode: psfMode,
      output_path: writeNpy(siblingNpy(strOf(params, 'image_path'), '_deconv'), r.image),
    })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 3. SegmentRegion_UNet（启发式那一半）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 旧仓 `heuristic_segment` —— 按高度分位阈值切 `n_classes` 档。
 *
 * `np.quantile(image, np.linspace(0,1,n+1)[1:-1])` ⇒ n−1 个阈值；
 * 然后 **`seg[image > th] = i+1` 逐条覆盖**（不是区间判定）——
 * 所以最后一条阈值赢，等价于「严格大于第 k 个阈值的都归第 k+1 档」。
 *
 * ⚠️ `np.quantile` 吃 0–1，本仓 `percentile` 吃 0–100 —— 中间多一次 `×100 ÷100`
 * 的往返，而它**不是恒等变换**：`(1/10)·100 = 10` 精确，而
 * `10/100 = 0.10000000000000000555 ≠ 1/10`。于是虚拟下标 `q·(n−1)`
 * 会与 numpy 差一个 ULP。
 *
 * **它改不动答案的条件是：阈值严格落在两个样本之间。** 那时一个 ULP 只挪动
 * 插值出来的 `th` 的最后一位，而 `image > th` 的归属不变；只有当某个像素
 * **恰好等于** `th` 时才会翻面。
 *
 * 金样按这条造：`frame_curved` 是 576 个**两两不同**的光滑二次值，
 * `n_classes` 取 2 / 3 / 5 / 10 四档，四档的 `class_areas` 容差 **0**。
 * 其中 `n_classes=10` 那一格是证据 —— `i/10·100` 在 float64 上确实不精确
 * （上面那串数），而它照样逐位对得上。
 *
 * **不为它另写一个 `quantile`**：那是第二份实现，而本批的前提是零新原语。
 */
export function heuristicSegment(image: Mat, nClasses: number): Int32Array {
  const seg = new Int32Array(image.data.length)
  for (let i = 1; i <= nClasses - 1; i += 1) {
    const q = i / nClasses
    const th = percentile(image.data, q * 100)
    for (let k = 0; k < image.data.length; k += 1) {
      if ((image.data[k] as number) > th) seg[k] = i
    }
  }
  return seg
}

export const SegmentRegion_UNet: Skill = {
  spec: S.SegmentRegion_UNetSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let image: Mat
    try {
      image = loadImage2d(strOf(params, 'image_path'))
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    const nClasses = intOrDefault(params, 'n_classes', 3)
    const seg = heuristicSegment(image, nClasses)

    // `np.unique(seg, return_counts=True)` —— **升序**的标签与各自的像素数。
    const counts = new Map<number, number>()
    for (const v of seg) counts.set(v, (counts.get(v) ?? 0) + 1)
    const uniq = [...counts.keys()].sort((x, y) => x - y)
    const total = seg.length
    const classAreas: Record<string, number> = {}
    let dominant = uniq[0] ?? 0
    let best = -1
    for (const u of uniq) {
      const c = counts.get(u) as number
      classAreas[String(u)] = c / total
      // `np.argmax` 取**第一个**最大值 —— 并列时标签小的赢。
      if (c > best) {
        best = c
        dominant = u
      }
    }
    return ok({
      method: 'heuristic',
      n_classes: uniq.length,
      class_areas: classAreas,
      dominant_class: dominant,
    })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 4. DetectAtoms_FCN（启发式那一半）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 旧仓 `heuristic_detect_atoms` —— 局部极大 + 一道 `> std` 的闸 + 连通域质心。
 *
 * 三处照移，每一处都能悄悄换掉答案：
 *
 * 1. `leveled = image − mean(image)`。**不是**减平面，就是减一个常数；
 * 2. `maximum_filter(size=2d+1)` ⇒ 本仓 `greyDilation` 配一个**全一奇数**矩形
 *    结构元。两者在奇数尺寸上恒等（`morphology.ts` 抬头 ②），
 *    边界都是 scipy 的 `'reflect'`；
 * 3. `label(peaks)` 用 scipy 的**缺省结构元 = 四邻接**（不是八）。
 *    换成八邻接会把对角相邻的两个峰并成一个质心，而那个质心落在两个原子中间 ——
 *    一个「合理」的、不存在的原子。
 */
export function heuristicDetectAtoms(image: Mat, minDistance: number): number[][] {
  const m = mean(image.data)
  const leveled = matOf(image.rows, image.cols, Float64Array.from(image.data, (v) => v - m))
  const size = minDistance * 2 + 1
  const localMax = greyDilation(leveled, rectSE(size, size))
  const sd = std(leveled.data)
  const peaks = matOf(
    leveled.rows, leveled.cols,
    Float64Array.from(leveled.data, (v, i) =>
      v === (localMax.data[i] as number) && v > sd ? 1 : 0),
  )
  const lab = labelConnected(peaks, 4)
  const sumY = new Float64Array(lab.count)
  const sumX = new Float64Array(lab.count)
  for (let r = 0; r < peaks.rows; r += 1) {
    for (let c = 0; c < peaks.cols; c += 1) {
      const id = lab.labels[r * peaks.cols + c] as number
      if (id === 0) continue
      sumY[id - 1] = (sumY[id - 1] as number) + r
      sumX[id - 1] = (sumX[id - 1] as number) + c
    }
  }
  const out: number[][] = []
  for (let i = 0; i < lab.count; i += 1) {
    const n = lab.sizes[i] as number
    out.push([(sumY[i] as number) / n, (sumX[i] as number) / n])
  }
  return out
}

export const DetectAtoms_FCN: Skill = {
  spec: S.DetectAtoms_FCNSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    let image: Mat
    try {
      image = loadImage2d(strOf(params, 'image_path'))
    } catch (e) {
      return fail(`Failed to load image: ${messageOf(e)}`)
    }
    const coords = heuristicDetectAtoms(image, intOrDefault(params, 'min_distance_px', 5))
    return ok({
      method: 'heuristic',
      n_atoms: coords.length,
      positions: coords,
    })
  },
}

export const PAPER_REGION: Readonly<Record<string, Skill>> = {
  DiffScans_ChangeDetect,
  DeconvolveTip_RL,
  SegmentRegion_UNet,
  DetectAtoms_FCN,
}
