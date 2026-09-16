/**
 * FFT、互相关、相位互相关 —— **本层唯一一件「算错了看不出来」的东西**。
 *
 * ## 容差：`8 · eps · log₂N`（相对，按谱的模长归一）
 *
 * radix-2 FFT 的误差界是 `O(eps · log₂N)`（每一级一次复数乘加，共 log₂N 级）。
 * N=64 时 `6 · 2.22e-16 ≈ 1.3e-15`；取 8 倍余量 ⇒ `1.1e-14`。
 *
 * **Bluestein 那一路更松**：它把长度 N 的 DFT 变成长度 M ≥ 2N−1 的卷积，
 * 于是误差按 `log₂M` 走，而且多了两次逐点乘。容差同式子、用 M 代 N，
 * 实测 N=61（M=128）的相对误差在 `1e-15` 量级。
 *
 * 归一化按 numpy：**正变换不除，`ifft` 除以 N**（`norm='backward'`）。
 * 这是**约定不是精度** —— 选错了整条谱差一个常数因子，而曲线形状完全正常。
 *
 * ## 峰位约定就是漂移方向的符号
 *
 * `phaseCrossCorrelation(reference, moving)` 给的是
 * **「把 moving 移动多少才能对上 reference」**。实测（`export_numerics.py`）：
 *
 * ```
 * b = roll(a, +3, +5)   ⇒   phase_cross_correlation(a, b) = [-3, -5]
 * ```
 *
 * 也就是**负的**那一个。算式是 `ifft2(F_a · conj(F_b) / |F_a · conj(F_b)|)`
 * 取模的峰位，再折到负半轴。
 *
 * 一次符号翻转或一次轴对调**不会报错**：漂移补偿会往反方向走，
 * 而图看起来只是「漂得更快了」。所以金样用**不对称**的位移（3 ≠ 5、且有零有负）
 * 逐格钉住。
 *
 * ## 亚像素档的容差是 **0**，而这和「很准」没关系
 *
 * `upsampleFactor = uf` 时，答案恒为
 * `round(整峰 · uf)/uf + (上采样峰 − dftshift)/uf` —— **两项都是 `k/uf` 的形式**。
 * 我们和 skimage 做的是同样两次「整数 ÷ uf」再相加，IEEE 的除法是正确舍入的，
 * 于是只要**挑中同一格**，两边就逐位相同。
 *
 * 所以这一档唯一会出的错不是精度，是 **argmax 挑到了隔壁那一格** ——
 * 而那种错一跳就是整整 `1/uf`，给多少容差都接不住。测试因此用 `Object.is` 比。
 *
 * ## ⚠️ 这个算法在**平坦帧**上会报出一个纯属虚构的位移
 *
 * 相位互相关把每个频点都归一化成单位模长 —— **于是没有信号的地方由噪声说了算**。
 * 两张几乎相同的平坦帧，skimage 报的是 `(5, 5)`（金样 `near_flat`）；
 * 而一张真正的常数图相关面是全平的，`argmax` 只会挑第 0 格，
 * 亚像素档下那一格等于 `−dftshift/uf`（`uf=10` 时是 `−0.7`）。
 *
 * 再加上 `uf = 10` 时输出的量子是 0.1 px 且恒为 0.1 的整数倍，
 * 调用方要判「漂没漂」**必须**自己看峰有多尖、再设一个阈值。
 * 拿 `!== 0` 去判等于每一帧都在补偿噪声，而那会**制造**漂移。
 *
 * ## `normalization`：**归一化是可关的，而关掉它是另一个算法不是另一档精度**
 *
 * skimage 的 `phase_cross_correlation(..., normalization=...)` 有两档：
 *
 * | | 互功率谱 | 峰由谁说了算 |
 * |---|---|---|
 * | `'phase'`（skimage 缺省） | `A·conj(B) / max(\|·\|, 100·eps)` | **每个频点一票** —— 没有信号的地方由噪声投票（D-NUM-14） |
 * | `null` | `A·conj(B)` 原样 | **按功率加权** —— 低频与强结构说了算 |
 *
 * 旧仓 `drift_xcorr` 明确传 `normalization=None`，并在注释里写明理由：
 * **对 SPM 的行噪声更稳**。一条横贯整帧的噪声线在谱上是一条高频的脊，
 * 相位归一化把它抬到和真信号一样的份量，于是峰被它拽走。
 *
 * 所以这一档不是「更准」也不是「更快」，**是把「谁有投票权」这件事交给调用方**。
 * 两档在同一对帧上给**不同的位移**（金样 `xcorr_raw` 那两格就是为此录的：
 * 同一对几乎平坦的帧，`'phase'` 报 `(5, 5)`，`null` 报 `(0, 0)`）。
 *
 * ## `error` 与 `phase`：两个判据，各有各的容差
 *
 * ```
 * phase = atan2(Im CCmax, Re CCmax)
 * error = √| 1 − |CCmax|² / (src_amp · target_amp) |
 * ```
 *
 * - **`phase` 的容差是 `fftRelTol(N)`，而且是绝对的（弧度）**：一个复数的相对误差 `δ`
 *   最多把辐角挪 `δ` 弧度。对齐得上的一对帧峰是**正实数**，`phase ≈ 0`；
 *   `phase` 明显不为 0 说的是「两张图差着一个全局的符号/偏置」。
 *   ⚠️ 比较时要**按角度**比（`atan2(sin Δ, cos Δ)`）：`+π` 与 `−π` 是同一个角，
 *   而一个朴素的减法会在那里报出 `2π` 的差。
 *
 * - **`error` 只能在平方上给容差**。`1 − |CC|²/amp` 在对得上的一对帧上是
 *   **两个几乎相等的数相减** —— 相消把相对精度全毁了，而 `√` 又把剩下的放大：
 *   `d√u = du/(2√u)`，`u → 0` 时任意大。
 *   所以判据写在 `error²` 上：它就是那个差本身，而那个比值 ≈ 1，于是它的
 *   **绝对**误差就是比值的相对误差：
 *
 *   | 来源 | 相对 |
 *   |---|---|
 *   | `CCmax`（两次 `fft2` + 一次 `ifft2`） | `3·fftRelTol` |
 *   | 平方 ⇒ `\|CCmax\|²` | `6·fftRelTol` |
 *   | `src_amp`、`target_amp` 各 = `Σ\|F\|²`（谱 `2·fftRelTol` + 求和 `sumRelTol`，而两者同式） | 各 `3·fftRelTol` |
 *   | 两者相乘 | `6·fftRelTol` |
 *   | **合计** | **`12·fftRelTol`** |
 *
 *   取 `32·fftRelTol`（约 2.7 倍余量）。
 *
 *   **这条推导有一个给调用方的直接后果**：`error` 本身只到
 *   `√(32·fftRelTol(N))` ≈ **8e−7**（N = 1024）的绝对精度 ——
 *   也就是说 `error = 1e−8` 与 `error = 1e−7` 是同一个数。
 *   谁拿 `error` 当「配准好不好」的阈值，**阈值不能设在 `1e−6` 以下**。
 */
import { matOf, type Mat } from './mat.js'
import { EPS, sum } from './stats.js'

/** 一段复数谱：实部与虚部各一条。**不用 `{re, im}[]`** —— 那是 N 个对象。 */
export interface Complex {
  readonly re: Float64Array
  readonly im: Float64Array
}

/** 与 numpy 比一次长度 N 的 FFT 时该用的相对容差。见文件抬头。 */
export function fftRelTol(n: number): number {
  return 8 * EPS * Math.max(1, Math.log2(Math.max(n, 2)))
}

/**
 * `phase`（弧度）的**绝对**容差：一个复数的相对误差最多把辐角挪同样多的弧度。
 * 见文件抬头那一节。比较时要按角度比 —— `+π` 与 `−π` 是同一个角。
 */
export function xcorrPhaseAbsTol(n: number): number {
  return fftRelTol(n)
}

/**
 * **`error²`** 的绝对容差。不是 `error` 的 —— `error` 是一个相消之后开的方，
 * 在对得上的一对帧上没有相对精度可言。见文件抬头那一节。
 */
export function xcorrErrorSqAbsTol(n: number): number {
  return 32 * fftRelTol(n)
}

const isPow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0

/**
 * 一维 DFT。长度是 2 的幂走 radix-2，否则走 Bluestein。
 *
 * `inverse` 只改旋转因子的符号，**不除 N** —— 除以 N 在 {@link ifft} 里做，
 * 好让「归一化在哪一步」只有一个答案。
 */
function dft(re: Float64Array, im: Float64Array, inverse: boolean): Complex {
  const n = re.length
  if (n === 0) return { re: new Float64Array(0), im: new Float64Array(0) }
  if (n === 1) return { re: Float64Array.from(re), im: Float64Array.from(im) }
  return isPow2(n) ? radix2(re, im, inverse) : bluestein(re, im, inverse)
}

/** 原地 radix-2（Cooley–Tukey，DIT）。输入被复制，不改调用方的数组。 */
function radix2(reIn: Float64Array, imIn: Float64Array, inverse: boolean): Complex {
  const n = reIn.length
  const re = Float64Array.from(reIn)
  const im = Float64Array.from(imIn)

  // 位反转置换
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] as number
      re[i] = re[j] as number
      re[j] = tr
      const ti = im[i] as number
      im[i] = im[j] as number
      im[j] = ti
    }
  }

  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    // 每一级**重算**旋转因子而不是递推相乘：递推的相位误差会随级数累积，
    // 而 `Math.cos/sin` 每次都是从一个精确的角度出发。
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = i + k + len / 2
        const xr = re[b] as number
        const xi = im[b] as number
        const tr = xr * wr - xi * wi
        const ti = xr * wi + xi * wr
        re[b] = (re[a] as number) - tr
        im[b] = (im[a] as number) - ti
        re[a] = (re[a] as number) + tr
        im[a] = (im[a] as number) + ti
      }
    }
  }
  return { re, im }
}

/**
 * Bluestein（chirp-z）—— 任意长度。
 *
 * 把 `X[k] = Σ x[j]·w^{jk}` 里的 `jk` 写成 `(j² + k² − (k−j)²)/2`，
 * 于是 DFT 变成一次**卷积**，而卷积用一个长度为 2 的幂的 FFT 做。
 *
 * 它存在是因为 STM 的帧不一定是 2 的幂：一张 500×500 的图、一条 61 点的谱，
 * 都不该被逼着补零到 512 —— **补零会在谱上加一条它自己的窗函数**。
 */
function bluestein(reIn: Float64Array, imIn: Float64Array, inverse: boolean): Complex {
  const n = reIn.length
  let m = 1
  while (m < 2 * n - 1) m <<= 1
  const sign = inverse ? 1 : -1

  // chirp: w^{j²/2}
  const cosT = new Float64Array(n)
  const sinT = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    // `i*i % (2n)` 先取模再算角度：i² 在 i 大时会掉精度，而相位只需要模 2n。
    const j = (i * i) % (2 * n)
    const ang = (sign * Math.PI * j) / n
    cosT[i] = Math.cos(ang)
    sinT[i] = Math.sin(ang)
  }

  const ar = new Float64Array(m)
  const ai = new Float64Array(m)
  for (let i = 0; i < n; i += 1) {
    ar[i] = (reIn[i] as number) * (cosT[i] as number) - (imIn[i] as number) * (sinT[i] as number)
    ai[i] = (reIn[i] as number) * (sinT[i] as number) + (imIn[i] as number) * (cosT[i] as number)
  }
  const br = new Float64Array(m)
  const bi = new Float64Array(m)
  br[0] = cosT[0] as number
  bi[0] = -(sinT[0] as number)
  for (let i = 1; i < n; i += 1) {
    br[i] = br[m - i] = cosT[i] as number
    bi[i] = bi[m - i] = -(sinT[i] as number)
  }

  const fa = radix2(ar, ai, false)
  const fb = radix2(br, bi, false)
  const cr = new Float64Array(m)
  const ci = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    cr[i] = (fa.re[i] as number) * (fb.re[i] as number) - (fa.im[i] as number) * (fb.im[i] as number)
    ci[i] = (fa.re[i] as number) * (fb.im[i] as number) + (fa.im[i] as number) * (fb.re[i] as number)
  }
  const conv = radix2(cr, ci, true)

  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const xr = (conv.re[i] as number) / m
    const xi = (conv.im[i] as number) / m
    re[i] = xr * (cosT[i] as number) - xi * (sinT[i] as number)
    im[i] = xr * (sinT[i] as number) + xi * (cosT[i] as number)
  }
  return { re, im }
}

/** numpy 的 `fft`（不归一化）。 */
export function fft(re: Float64Array | readonly number[], im?: Float64Array): Complex {
  const r = Float64Array.from(re as Iterable<number>)
  return dft(r, im ?? new Float64Array(r.length), false)
}

/** numpy 的 `ifft`（**除以 N**）。 */
export function ifft(spec: Complex): Complex {
  const n = spec.re.length
  const out = dft(spec.re, spec.im, true)
  for (let i = 0; i < n; i += 1) {
    out.re[i] = (out.re[i] as number) / n
    out.im[i] = (out.im[i] as number) / n
  }
  return out
}

/** 二维谱：实部与虚部各一张 `Mat`。 */
export interface Complex2d {
  readonly re: Mat
  readonly im: Mat
}

/** 沿一个轴做一遍。`axis 0` = 每一列，`axis 1` = 每一行。 */
function alongAxis(re: Mat, im: Mat, axis: 0 | 1, inverse: boolean): Complex2d {
  const { rows, cols } = re
  const outRe = new Float64Array(rows * cols)
  const outIm = new Float64Array(rows * cols)
  const n = axis === 0 ? rows : cols
  const outer = axis === 0 ? cols : rows
  const br = new Float64Array(n)
  const bi = new Float64Array(n)
  for (let o = 0; o < outer; o += 1) {
    for (let i = 0; i < n; i += 1) {
      const idx = axis === 0 ? i * cols + o : o * cols + i
      br[i] = re.data[idx] as number
      bi[i] = im.data[idx] as number
    }
    const f = dft(br, bi, inverse)
    for (let i = 0; i < n; i += 1) {
      const idx = axis === 0 ? i * cols + o : o * cols + i
      outRe[idx] = f.re[i] as number
      outIm[idx] = f.im[i] as number
    }
  }
  return { re: matOf(rows, cols, outRe), im: matOf(rows, cols, outIm) }
}

/** numpy 的 `fft2`（不归一化）。**先轴 1 再轴 0**，与 numpy 同。 */
export function fft2(m: Mat): Complex2d {
  const zero = matOf(m.rows, m.cols, new Float64Array(m.rows * m.cols))
  const a = alongAxis(m, zero, 1, false)
  return alongAxis(a.re, a.im, 0, false)
}

/** numpy 的 `ifft2`（**除以 rows·cols**）。 */
export function ifft2(s: Complex2d): Complex2d {
  const a = alongAxis(s.re, s.im, 0, true)
  const b = alongAxis(a.re, a.im, 1, true)
  const n = b.re.rows * b.re.cols
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    re[i] = (b.re.data[i] as number) / n
    im[i] = (b.im.data[i] as number) / n
  }
  return { re: matOf(b.re.rows, b.re.cols, re), im: matOf(b.re.rows, b.re.cols, im) }
}

/**
 * 互功率谱 `A · conj(B)`，**归一化可关**（`normalize = false` 时原样给出）。
 * 关掉它是另一个算法不是另一档精度 —— 见文件抬头 `normalization` 那一节。
 *
 * **分母是 `max(|·|, 100·eps)` 而不是 `|·|`**，和 skimage 一字不差。
 * 差别只在模小于 `2.2e−14` 的那些频点上 —— 也就是逼近时的**平坦帧**：
 * 除直流外整张谱都是数值噪声。
 *
 * ⚠️ **压住它们并不会让答案变对。** 本来的想法是「压住噪声峰就留在直流」，
 * 而探针当场证伪了：对一次精确的 `roll`，那些「噪声」频点带的是**同一个相位**，
 * 不压反而给出更干净的峰。压与不压只是**两个不同的答案**，
 * 而哪个算数由 skimage 定 —— 金样里 `near_flat` 那两格就是为此录的
 * （两帧几乎相同，skimage 报的是一个纯属虚构的 `(5, 5)`）。
 *
 * 所以这一行的理由是**对齐**，不是「更准」。想要「没漂就说没漂」，
 * 得由调用方去看峰有多尖 —— 这一层不替它做那个判断。
 */
function crossPowerSpectrum(
  reference: Mat,
  moving: Mat,
  normalize: boolean,
): { product: Complex2d; srcAmp: number; targetAmp: number } {
  const A = fft2(reference)
  const B = fft2(moving)
  const n = reference.rows * reference.cols
  const pr = new Float64Array(n)
  const pi = new Float64Array(n)
  // `src_amp` / `target_amp` 取的是**原始**谱的功率和 —— skimage 对 `image_product`
  // 做的是原地除法，两条谱本身没被动过。归一化开着的时候这一点特别容易写错：
  // 拿归一化之后的谱去算功率，每个频点的模都是 1，`error` 就成了一个与图无关的常数。
  const srcSq = new Float64Array(n)
  const tgtSq = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const ar = A.re.data[i] as number
    const ai = A.im.data[i] as number
    const br = B.re.data[i] as number
    const bi = B.im.data[i] as number
    srcSq[i] = ar * ar + ai * ai
    tgtSq[i] = br * br + bi * bi
    const cr = ar * br + ai * bi
    const ci = ai * br - ar * bi
    if (normalize) {
      const den = Math.max(Math.hypot(cr, ci), 100 * EPS)
      pr[i] = cr / den
      pi[i] = ci / den
    } else {
      pr[i] = cr
      pi[i] = ci
    }
  }
  return {
    product: {
      re: matOf(reference.rows, reference.cols, pr),
      im: matOf(reference.rows, reference.cols, pi),
    },
    srcAmp: sum(srcSq),
    targetAmp: sum(tgtSq),
  }
}

/**
 * skimage 的 `_upsampled_dft`：在**峰的邻域**上直接算一小块 DFT，
 * 而不是把整张谱补零再变换回去。
 *
 * 补零上采样要算一张 `uf·R × uf·C` 的图（`uf=10` 的 512² 帧就是 26 亿个数）；
 * 矩阵乘法只算 `ceil(1.5·uf)²` 那一小块 —— 这不是优化，是可行与不可行的差别。
 *
 * 核是 `exp(−2πi · (arange(ups) − offset) ⊗ fftfreq(n, uf))`，先列后行，
 * 每一次都缩掉最后一个轴，于是结果的形状是 `(ups, ups)`（行在前）。
 */
function upsampledDft(
  data: Complex2d,
  ups: number,
  uf: number,
  offsetRow: number,
  offsetCol: number,
): Complex2d {
  // fftfreq(n, uf)[k] = (k < (n+1)/2 ? k : k - n) / (n * uf)
  const freq = (k: number, n: number): number => (k < Math.ceil(n / 2) ? k : k - n) / (n * uf)

  // ① 沿列（最后一个轴）：kernel(ups × cols) · data(rows × cols)ᵀ → (ups × rows)
  const r1re = new Float64Array(ups * data.re.rows)
  const r1im = new Float64Array(ups * data.re.rows)
  const { rows, cols } = data.re
  for (let u = 0; u < ups; u += 1) {
    for (let r = 0; r < rows; r += 1) {
      let ar = 0
      let ai = 0
      for (let c = 0; c < cols; c += 1) {
        const ang = -2 * Math.PI * (u - offsetCol) * freq(c, cols)
        const kr = Math.cos(ang)
        const ki = Math.sin(ang)
        const dr = data.re.data[r * cols + c] as number
        const di = data.im.data[r * cols + c] as number
        ar += kr * dr - ki * di
        ai += kr * di + ki * dr
      }
      r1re[u * rows + r] = ar
      r1im[u * rows + r] = ai
    }
  }
  // ② 沿行：kernel(ups × rows) · (ups_c × rows)ᵀ → (ups_r × ups_c)
  const outRe = new Float64Array(ups * ups)
  const outIm = new Float64Array(ups * ups)
  for (let v = 0; v < ups; v += 1) {
    for (let u = 0; u < ups; u += 1) {
      let ar = 0
      let ai = 0
      for (let r = 0; r < rows; r += 1) {
        const ang = -2 * Math.PI * (v - offsetRow) * freq(r, rows)
        const kr = Math.cos(ang)
        const ki = Math.sin(ang)
        const dr = r1re[u * rows + r] as number
        const di = r1im[u * rows + r] as number
        ar += kr * dr - ki * di
        ai += kr * di + ki * dr
      }
      outRe[v * ups + u] = ar
      outIm[v * ups + u] = ai
    }
  }
  return { re: matOf(ups, ups, outRe), im: matOf(ups, ups, outIm) }
}

/** 一次相位互相关的全部结果 —— 三个数，三个用途。 */
export interface XCorrResult {
  /** 「把 `moving` 移动多少才能对上 `reference`」。符号约定见文件抬头。 */
  readonly shift: [number, number]
  /**
   * `√|1 − |CCmax|²/(src_amp·target_amp)|` —— 归一化的 RMS 配准残差。
   * **绝对精度只到 `√(32·fftRelTol)`（N=1024 时 ~8e−7）**，见文件抬头。
   */
  readonly error: number
  /**
   * 峰的辐角（弧度）。对得上的一对帧是 **0**；`±π` 说的是两张图差着一个全局符号。
   * 它**不是**「漂移的方向」—— 方向在 `shift` 的两个分量里。
   */
  readonly phase: number
}

/** `|·|` 最大的那一格的一维下标。 */
function argmaxAbs(s: Complex2d): number {
  let best = -Infinity
  let at = 0
  const n = s.re.data.length
  for (let i = 0; i < n; i += 1) {
    const v = Math.hypot(s.re.data[i] as number, s.im.data[i] as number)
    if (v > best) {
      best = v
      at = i
    }
  }
  return at
}

/**
 * 相位互相关 —— **`reference` 与 `moving` 的顺序决定符号，见文件抬头**。
 *
 * 返回的是「把 `moving` 移动多少才能对上 `reference`」，与 skimage 的
 * `phase_cross_correlation(reference, moving, upsample_factor)` 同一个约定：
 * `moving = roll(reference, +d)` 时它给 `−d`。
 *
 * `upsampleFactor = 1`（默认）只到整像素；`> 1` 时在整峰的邻域上再做一次
 * 上采样 DFT，分辨率变成 `1/uf` 像素。**输出恒为 `1/uf` 的整数倍**——
 * 见文件抬头那条「会把没漂变成漂了 0.1 个像素」。
 */
export function phaseCrossCorrelation(
  reference: Mat,
  moving: Mat,
  upsampleFactor = 1,
  normalization: 'phase' | null = 'phase',
): XCorrResult {
  if (reference.rows !== moving.rows || reference.cols !== moving.cols) {
    throw new RangeError(
      `相位互相关要两张同形状的图：${reference.rows}×${reference.cols} vs ${moving.rows}×${moving.cols}`,
    )
  }
  if (!(Number.isInteger(upsampleFactor) && upsampleFactor >= 1)) {
    throw new RangeError(`upsampleFactor 必须是 ≥ 1 的整数：得到 ${upsampleFactor}`)
  }
  if (normalization !== 'phase' && normalization !== null) {
    throw new RangeError(`normalization 只有 'phase' 与 null 两档：得到 ${String(normalization)}`)
  }
  const { product: prod, srcAmp, targetAmp } = crossPowerSpectrum(
    reference, moving, normalization === 'phase',
  )
  const { rows, cols } = reference
  const n = rows * cols

  const coarse = ifft2(prod)
  const peak = argmaxAbs(coarse)
  let dy = Math.floor(peak / cols)
  let dx = peak % cols
  // 折到负半轴：超过一半的位移读成「往回移」。这一步就是符号的来源。
  if (dy > rows / 2) dy -= rows
  if (dx > cols / 2) dx -= cols

  if (upsampleFactor === 1) {
    const ccRe = coarse.re.data[peak] as number
    const ccIm = coarse.im.data[peak] as number
    // uf = 1 那一档 skimage 把两条功率和**各除以 N**；uf > 1 那一档不除。
    // 不是笔误也不是等价：两档的 CCmax 本身就差着一个 N（`ifft2` 除了、
    // 上采样 DFT 没除），这个除法把它配平。
    return {
      shift: zeroDegenerate([dy, dx], rows, cols),
      error: xcorrError(ccRe, ccIm, srcAmp / n, targetAmp / n),
      phase: Math.atan2(ccIm, ccRe),
    }
  }

  // 整峰先量化到 1/uf 的格点上 —— 它已经是整数，这一步在 uf 上是恒等的，
  // 但它定下了「答案永远是 k/uf」这件事，也是 skimage 的写法。
  const sy = Math.round(dy * upsampleFactor) / upsampleFactor
  const sx = Math.round(dx * upsampleFactor) / upsampleFactor
  const ups = Math.ceil(upsampleFactor * 1.5)
  const dftshift = Math.trunc(ups / 2)
  // 对 conj(互功率谱) 做上采样 DFT，**再取一次共轭**。
  // 上一版把最后那次共轭略掉了，理由是「只用 `|·|` 找峰，共轭不改模长」——
  // 那在只回 `shift` 的时候成立。现在要回 `phase`，而共轭把辐角整个变号：
  // **一个略得掉的步骤，在接口多给一个数之后就略不掉了。**
  const conj: Complex2d = { re: prod.re, im: matOf(rows, cols, prod.im.data.map((v) => -v)) }
  const fine = upsampledDft(
    conj,
    ups,
    upsampleFactor,
    dftshift - sy * upsampleFactor,
    dftshift - sx * upsampleFactor,
  )
  const at = argmaxAbs(fine)
  const fy = Math.floor(at / ups) - dftshift
  const fx = (at % ups) - dftshift
  const ccRe = fine.re.data[at] as number
  const ccIm = -(fine.im.data[at] as number)
  return {
    shift: zeroDegenerate([sy + fy / upsampleFactor, sx + fx / upsampleFactor], rows, cols),
    error: xcorrError(ccRe, ccIm, srcAmp, targetAmp),
    phase: Math.atan2(ccIm, ccRe),
  }
}

/**
 * 只有一行（或一列）时，那条轴上的位移**没有意义**，置 0（同 skimage）。
 *
 * 不置的话 argmax 会在一条长度为 1 的轴上挑出第 0 格，读起来是「没漂」——
 * 碰巧对。但**一张 1×N 的「图」上那条轴根本没有可测的位移**，
 * 而一个碰巧对的答案与一个有理由的答案在下一次改动里不是同一件东西。
 */
function zeroDegenerate(shift: [number, number], rows: number, cols: number): [number, number] {
  return [rows === 1 ? 0 : shift[0], cols === 1 ? 0 : shift[1]]
}

/** `√|1 − |CCmax|²/(src_amp·target_amp)|`，同 skimage 的 `_compute_error`。 */
function xcorrError(ccRe: number, ccIm: number, srcAmp: number, targetAmp: number): number {
  const amp = srcAmp * targetAmp
  return Math.sqrt(Math.abs(1 - (ccRe * ccRe + ccIm * ccIm) / amp))
}
