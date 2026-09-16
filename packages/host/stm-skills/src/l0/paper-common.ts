/**
 * 批 4c 的共用外壳 —— **只做 IO 与格式分派，一个判据都不写**。
 *
 * 对的是旧仓 `mast/data/loaders.py` 的 `load_image_2d` / `load_spectrum`：
 * 一族「一张图进来、一张图出去」的技能从前全都裸调 `np.load(path)`，于是
 * 只吃 `.npy`；那两个函数按扩展名分派到**已有的**读法上，让技能吃得下
 * 用户手上真正存在的格式。
 *
 * ## 三档扩展名，**本仓只落了有读法的那些**
 *
 * | 扩展名 | 旧仓 | 本仓 |
 * |---|---|---|
 * | `.npy` | `np.load` | `decodeNpy` ✓ |
 * | `.sxm` | `read_sxm` + 挑通道 | `readSxm` + `pickImageChannel` ✓ |
 * | `.dat` | `read_dat` + 列拼成二维 | `readDat` + 同一条拼法 ✓ |
 * | `.3ds`（谱） | `read_3ds` 的 cube | `read3ds` ✓ |
 * | `.npz` / `.sm4` / `.txt` / `.csv` / `.asc` | 各有读法 | **没有** —— 本仓没有 zip、没有 `.sm4`、没有 `read_txt` |
 *
 * 缺的三种**当场说清楚**（报「这个仓读不了 .npz」），而不是让 `decodeNpy`
 * 去撞一个「魔数不对」——后者会让人去查文件，而文件没有问题。
 * 见 deviation：那是一条**少做了什么**，不是一条「换了个做法」。
 *
 * ## 报文逐字抄旧仓
 *
 * `image file not found: {p}` / `spectrum file not found: {p}` / `{name}: parsed to an
 * empty array` —— 这些串会原样出现在技能的 `error` 里，也就是模型读的那一句。
 * 抄的是**旧仓写的那一半**；操作系统那一半（`ENOENT` / `[WinError 2]`）
 * 两侧归一化成 `<oserror>`（D-ANALYSIS-1）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { pickImageChannel } from 'dsh-spm-kernel'
import { readDat, readSxm, read3ds } from 'dsh-spm-nanonis-files'
import { decodeNpy, matOf, type Mat } from 'dsh-spm-numerics'

/** 读不动。**它是一个值，不是一次崩溃** —— 调用方要把这句话原样报给模型。 */
export class ImageLoadError extends Error {
  override readonly name = 'ImageLoadError'
}

/** 旧仓 `SUPPORTED_SPECTRUM_EXT`，**逐字**（`DetectAtomJump` 靠它分「路径还是 JSON」）。 */
export const SUPPORTED_SPECTRUM_EXT: readonly string[] =
  ['.npy', '.npz', '.dat', '.txt', '.csv', '.asc', '.3ds']

/**
 * 旧仓认得、而本仓**没有读法**的那几种。碰上它们**当场说清楚**。
 *
 * 写成「缺的那一份名单」而不是「有的那一份」是有意的：旧仓最后那一支是
 * `np.load(p)`（认不出的扩展名一律当 `.npy` 试一次），本仓照移了那一支。
 * 用白名单的话，一个旧仓能读、本仓也能读的新扩展名会被这一层误拒 ——
 * 而黑名单只在**我确实知道读不了**的那几种上说话。
 */
const UNIMPLEMENTED_EXT = new Set(['.npz', '.sm4', '.txt', '.csv', '.asc', '.tsv', '.xyz'])

/** 一份读出来的数组：行优先展平 + 形状（`decodeNpy` 的形状，原样）。 */
export interface LoadedArray {
  readonly shape: readonly number[]
  readonly values: Float64Array
}

function unsupported(ext: string, p: string): never {
  throw new ImageLoadError(
    `${basename(p)}: 本仓读不了 ${ext} —— 已实现的是 .npy / .sxm / .dat（.3ds 只在谱那一路）。` +
      '这是一条登记过的缺口，不是文件的问题。',
  )
}

function bytesOf(p: string, what: 'image' | 'spectrum'): Uint8Array {
  if (!existsSync(p)) {
    throw new ImageLoadError(`${what} file not found: ${p}`)
  }
  return new Uint8Array(readFileSync(p))
}

/** `.dat` 的数值列拼成 `(n_points, n_cols)`。旧仓 `_stack_columns` 那一行。 */
function stackColumns(p: string): LoadedArray {
  const d = readDat(bytesOf(p, 'image'), basename(p))
  const cols = Object.values(d.columns)
  if (cols.length === 0) throw new ImageLoadError(`${basename(p)}: no numeric data columns`)
  const rows = (cols[0] as Float64Array).length
  const values = new Float64Array(rows * cols.length)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols.length; c += 1) {
      values[r * cols.length + c] = (cols[c] as Float64Array)[r] as number
    }
  }
  return { shape: [rows, cols.length], values }
}

/**
 * `.sxm` → 一路通道的**正扫**帧（没有正扫就退到反扫）。
 *
 * ⚠️ 这里读的是 `readSxm` 交出来的**裸块**，不经 `sxmOrientedFrames` ——
 * 与旧仓 `_channels_to_image` 一样（它读 `frame["forward"]`）。
 * 也就是说：**反扫那一路没有被镜像回来**。
 *
 * 这件事在这里是对的，因为这一族技能拿到的是**一张**图（减背景、去条纹、
 * 找空地），而不是拿两路互相比。要比两路的那个技能是
 * `LoadScanFrameFromFile`，它走 `sxmOrientedFrames`，抬头写明了为什么
 * （批 4a 的 `analysis-common.ts` 同一条）。两条路并存是有意的，
 * 但**得说出来** —— 一个「顺手也归位一下」的实现会让这一族与旧仓分岔，
 * 而分岔出来的数看起来完全正常。
 */
function sxmImage(p: string, prefer: string | null): LoadedArray {
  const scan = readSxm(bytesOf(p, 'image'), basename(p))
  const names = Object.keys(scan.channels)
  const ch = pickImageChannel(names, prefer)
  const frame = scan.channels[ch]
  const img = frame?.forward ?? frame?.backward ?? null
  if (img === null) {
    throw new ImageLoadError(`${basename(p)}: channel '${ch}' has no forward/backward frame`)
  }
  return { shape: [img.rows, img.cols], values: img.data }
}

/**
 * 旧仓 `load_image_2d`：任意支持的格式 → 一张二维 float64 图。
 *
 * 末尾那三步照移，**顺序要紧**：
 * `squeeze` → 空数组就抛 → `ndim > 2` 时把后面的轴并进列。
 * 少做 `squeeze` 的话，一份 `(1, 64, 64)` 的 `.npy` 会走进第三步被摊成
 * `(1, 4096)` —— 一张宽 4096 的图，每一条判据都还算得下去。
 */
export function loadImage2d(path: string, prefer: string | null = null): Mat {
  const p = String(path)
  const ext = extname(p).toLowerCase()
  let arr: LoadedArray
  if (ext === '.sxm') arr = sxmImage(p, prefer)
  else if (ext === '.dat') arr = stackColumns(p)
  else if (UNIMPLEMENTED_EXT.has(ext)) unsupported(ext, p)
  // 旧仓最后那一支也是 `np.load(p)` —— 认不出的扩展名当 `.npy` 试一次。
  else arr = decodeNpyFile(p, 'image')

  const shape = arr.shape.filter((d) => d !== 1) // np.squeeze
  if (arr.values.length === 0) throw new ImageLoadError(`${basename(p)}: parsed to an empty array`)
  if (shape.length === 0) return matOf(1, 1, arr.values)
  if (shape.length === 1) return matOf(1, shape[0] as number, arr.values)
  const rows = shape[0] as number
  return matOf(rows, arr.values.length / rows, arr.values)
}

/**
 * 旧仓 `load_spectrum`：一维/二维谱，或者 `.3ds` 的三维 cube。
 *
 * 与 {@link loadImage2d} 的区别是**它不摊平** —— `.3ds` 的 `(ny, nx, n)` 原样交出去，
 * 因为调用方（`DetectAtomJump`）问的第一件事是 `len(trace)`，而那是**第 0 轴**的长度。
 */
export function loadSpectrum(path: string): LoadedArray {
  const p = String(path)
  const ext = extname(p).toLowerCase()
  if (ext === '.dat') return stackColumns(p)
  if (ext === '.3ds') {
    const g = read3ds(bytesOf(p, 'spectrum'), basename(p))
    if (g.grid.length === 0) throw new ImageLoadError(`${basename(p)}: .3ds file parsed to an empty grid`)
    return {
      shape: [g.params.ny, g.params.nx, g.params.n_points],
      values: flatten3d(g.grid),
    }
  }
  if (UNIMPLEMENTED_EXT.has(ext)) return unsupported(ext, p)
  return decodeNpyFile(p, 'spectrum')
}

function flatten3d(cube: readonly (readonly Float64Array[])[]): Float64Array {
  const out: number[] = []
  for (const row of cube) for (const px of row) out.push(...px)
  return Float64Array.from(out)
}

function decodeNpyFile(p: string, what: 'image' | 'spectrum'): LoadedArray {
  const a = decodeNpy(bytesOf(p, what))
  return { shape: a.shape, values: a.values }
}

/** `<dir>/<stem><suffix>.npy` —— 旧仓那一族的 `_src.with_name(f"{_src.stem}_xxx.npy")`。 */
export function siblingNpy(src: string, suffix: string): string {
  const s = String(src)
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  const dir = cut < 0 ? '' : s.slice(0, cut + 1)
  const base = s.slice(cut + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot <= 0 ? base : base.slice(0, dot)
  return `${dir}${stem}${suffix}.npy`
}

/** `Mat` → 行的二维表（`encodeNpyFrame` 吃这个形状）。 */
export function matRows(m: Mat): number[][] {
  const out: number[][] = []
  for (let r = 0; r < m.rows; r += 1) {
    out.push(Array.from(m.data.subarray(r * m.cols, (r + 1) * m.cols)))
  }
  return out
}
