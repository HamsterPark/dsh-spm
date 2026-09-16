/**
 * 灰度形态学 —— 腐蚀 / 膨胀 / 开 / 闭。
 *
 * ## 容差是 **0**，而这不是「我们做得准」
 *
 * 平结构元的形态学**没有算术**：输出的每一个数都是输入里的某一个数原样搬过来
 * （窗口里的最小值 / 最大值），中间一次乘加都没有。所以它对 scipy 的
 * `ndi.grey_erosion` 应当**逐位相等**，测试用 `Object.is` 比，不用容差。
 *
 * 给它一个容差等于把一次「挑错了元素」藏起来 —— 而挑错元素正是这一族唯一会犯的错。
 *
 * ## 谁在等它
 *
 * `Destripe_MorphOpen`：沿一条轴做开运算，把比结构元窄的亮条纹削掉，
 * 而**比它宽的地形留下**。所以细长结构元（`rectSE(1, k)`）不是附赠品，
 * 是那个技能要的形状。
 *
 * ## 两条由金样问出来的约定
 *
 * **① 腐蚀的原点恒为 `size >> 1`，偶数也一样** —— 窗口从 `i - size//2` 起算，
 * 偶数尺寸时偏向左上。猜错了整张图平移一个像素，而一张平移一个像素的形貌图
 * 看起来完全正常。对 3×3 / 5×3 / **4×4** 穷举原点偏移，只有 `[h>>1, w>>1]`
 * 复现 scipy。
 *
 * **② 膨胀用的是翻转过的结构元** —— 形态学的对偶要求 `(f ⊕ B)(x) = max_b f(x − b)`，
 * 而腐蚀是 `min_b f(x + b)`：偏移号相反。写成「翻掩膜 + 原点变 `size − 1 − size>>1`」
 * 与它等价。**奇数尺寸两者恰好一样，所以 3×3 / 5×3 / 十字全都看不出来**；
 * 是那一格 4×4 把它逼了出来（同原点的膨胀在 4×4 上当场红）。
 *
 * 这一条值得记：金样里那个「看着多余」的偶数尺寸，是四个尺寸里唯一有鉴别力的一个。
 * 一组**分辨不出两种候选**的金样不是判据。
 */
import { boundaryIndex, type BoundaryMode } from './filters.js'
import { matOf, type Mat } from './mat.js'

/**
 * 结构元。`mask` 为 `null` 表示**整个矩形都算数**（scipy 的 `size=(h,w)`）；
 * 否则是一张 `rows×cols` 的 0/1 掩膜（scipy 的 `footprint`）。
 */
export interface StructuringElement {
  readonly rows: number
  readonly cols: number
  readonly mask: Uint8Array | null
}

/** 矩形结构元 —— scipy 的 `size=(h, w)`。细长的那两种（`1×k` / `k×1`）也走这里。 */
export function rectSE(rows: number, cols: number): StructuringElement {
  if (!(Number.isInteger(rows) && rows >= 1) || !(Number.isInteger(cols) && cols >= 1)) {
    throw new RangeError(`结构元尺寸必须是正整数：得到 ${rows}×${cols}`)
  }
  return { rows, cols, mask: null }
}

/** 十字结构元（边长 `size`，必须是正奇数 —— 偶数的十字没有中心）。 */
export function crossSE(size: number): StructuringElement {
  if (!(Number.isInteger(size) && size >= 1 && size % 2 === 1)) {
    throw new RangeError(`十字结构元的边长必须是正奇数：得到 ${size}`)
  }
  const mask = new Uint8Array(size * size)
  const c = size >> 1
  for (let i = 0; i < size; i += 1) {
    mask[i * size + c] = 1
    mask[c * size + i] = 1
  }
  return { rows: size, cols: size, mask }
}

/** 翻转结构元（两轴各翻一次）。膨胀要的就是这个，见文件抬头 ②。 */
function reflectSE(se: StructuringElement): StructuringElement {
  if (se.mask === null) return se // 矩形翻过来还是它自己
  const m = new Uint8Array(se.rows * se.cols)
  for (let i = 0; i < se.rows; i += 1) {
    for (let j = 0; j < se.cols; j += 1) {
      m[i * se.cols + j] = se.mask[(se.rows - 1 - i) * se.cols + (se.cols - 1 - j)] as number
    }
  }
  return { rows: se.rows, cols: se.cols, mask: m }
}

/** 滑窗极值。`isMax` 决定取大还是取小；`oy`/`ox` 是窗口原点。 */
function sweep(
  m: Mat,
  se: StructuringElement,
  oy: number,
  ox: number,
  mode: BoundaryMode,
  cval: number,
  isMax: boolean,
): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      let acc = isMax ? -Infinity : Infinity
      for (let i = 0; i < se.rows; i += 1) {
        const rr = boundaryIndex(r + i - oy, m.rows, mode)
        for (let j = 0; j < se.cols; j += 1) {
          if (se.mask !== null && se.mask[i * se.cols + j] === 0) continue
          const cc = boundaryIndex(c + j - ox, m.cols, mode)
          // 任一轴落在 `constant` 的界外 ⇒ 这一格取 cval
          const v = rr === null || cc === null ? cval : (m.data[rr * m.cols + cc] as number)
          if (isMax ? v > acc : v < acc) acc = v
        }
      }
      out[r * m.cols + c] = acc
    }
  }
  return matOf(m.rows, m.cols, out)
}

/** scipy 的 `grey_erosion` —— 窗口最小值，原点 `size >> 1`。 */
export function greyErosion(
  m: Mat,
  se: StructuringElement,
  mode: BoundaryMode = 'reflect',
  cval = 0,
): Mat {
  return sweep(m, se, se.rows >> 1, se.cols >> 1, mode, cval, false)
}

/** scipy 的 `grey_dilation` —— 窗口最大值，**结构元先翻转**（见文件抬头 ②）。 */
export function greyDilation(
  m: Mat,
  se: StructuringElement,
  mode: BoundaryMode = 'reflect',
  cval = 0,
): Mat {
  const f = reflectSE(se)
  return sweep(m, f, se.rows - 1 - (se.rows >> 1), se.cols - 1 - (se.cols >> 1), mode, cval, true)
}

/**
 * 开运算 = 先腐蚀再膨胀。**削掉比结构元窄的亮细节，宽的留下** ——
 * `Destripe_MorphOpen` 要的就是这个性质。
 */
export function greyOpening(
  m: Mat,
  se: StructuringElement,
  mode: BoundaryMode = 'reflect',
  cval = 0,
): Mat {
  return greyDilation(greyErosion(m, se, mode, cval), se, mode, cval)
}

/** 闭运算 = 先膨胀再腐蚀。填掉比结构元窄的暗细节。 */
export function greyClosing(
  m: Mat,
  se: StructuringElement,
  mode: BoundaryMode = 'reflect',
  cval = 0,
): Mat {
  return greyErosion(greyDilation(m, se, mode, cval), se, mode, cval)
}
