/**
 * 旧仓 `mast/vision/spectroscopy.py` 的 `assess_iz`(41) 与 `assess_iv`(76) ——
 * **从一条谱反推针尖**的两个纯函数。
 *
 * 第二个消费方已经点名在等：`AssessSpectrum` 的 `assess_spectrum_quality`
 * 里这两件各调一次（批 5b §5.2 的 117 行就是它们）。
 *
 * > **来处**：批 6c 落在 `stm-skills/src/l0/vision-spectroscopy.ts`（那一轮
 * > `packages/host/vision/` 由批 6b 主用），由收尾支线按该批交接 §8 搬来。
 * > 判据、容差、抬头一个字未改，只改了 import 路径。
 *
 * ## 这两件回答的是「**这根针**行不行」，不是「这条数据留不留」
 *
 * 后者是 `AssessSpectrum`（谱质量闸）。一条 `discard` 的谱可能只是窗口开错了、
 * 相位反了、表面不是那个面 —— 针尖完全没问题；反过来，一条数据质量挑不出毛病的
 * 谱，也可能是一根双针尖测出来的。旧仓把两件事分开放，是为了不让下游把
 * 「这条谱不好」读成「这根针不行」，然后去反复修一根其实没问题的针。
 *
 * ## 容差
 *
 * 整条链在旧仓是 **float64**（两个函数开头都 `np.asarray(..., dtype=np.float64)`），
 * 所以这里没有 `tip_metrics` 那一族的 float32 问题。只有**两处**不逐位：
 *
 * | 件 | 为什么不逐位 | 容差 |
 * |---|---|---|
 * | `np.polyfit(zz, ll, 1)` | numpy 走 SVD 最小二乘，本仓走**正规方程 + 列缩放** | {@link lstsqObservedTol}`(κ)`，κ 随金样录 |
 * | `np.corrcoef(Is, flip)` | numpy 走 BLAS 的 `dot`，累加顺序不是成对 | {@link corrcoefAbsTol}`(n)` |
 *
 * 其余**全部逐位**：`np.sum` / `np.mean` / `np.std` 走 {@link npSum} 一族
 * （成对求和照抄）、`np.median` 走 {@link npMedian}（**不是** `percentile(50)`，
 * 偶数长度差最后一位，而这一族的 MAD 会乘 8 再当阈值用）、`np.diff` / `np.abs` /
 * `np.max` 都只是搬运。
 *
 * ## D-SPECTRO-* 之一：`np.argsort` 的**平局**
 *
 * 两个函数都先 `order = np.argsort(x)` 排一遍。numpy 缺省是 quicksort，**不稳定** ——
 * 两条 bias 完全相同的记录（真机上扫到端点会出现）谁排前面由实现决定。
 * 本仓用**稳定**排序（平局按原下标）。这是一条真实偏差：确定，但不保证等于 numpy。
 * 金样里因此**没有平局**（同 D-NUM-18：一格答案本身没有定义的金样比没有更糟）。
 */
import { corrcoef, corrcoefAbsTol, EPS, lstsqObservedTol, npStd, npSum, polyfit } from 'dsh-spm-numerics'
import { nanMax, npMedian } from './nd.js'

/** κ[Å⁻¹] ≈ `K_PHI · √(φ[eV])` —— 真空隧道势垒。 */
export const K_PHI = 0.5123

/** `assess_iz` 的产物（旧仓 `IzResult`）。 */
export interface IzResult {
  readonly is_clean_exponential: boolean
  readonly barrier_ev: number | null
  readonly fit_r2: number
  readonly decay_per_nm: number | null
  readonly n_jumps: number
}

/** `assess_iv` 的产物（旧仓 `IvResult`）。 */
export interface IvResult {
  readonly is_stable: boolean
  readonly smoothness: number
  readonly symmetry: number
  readonly n_spikes: number
  readonly gap_ev: number | null
}

/** MAD 的倍数 —— 超过它就算一次「突跳」。两个函数共用同一个数，照移。 */
export const JUMP_MAD_SIGMA = 8.0

/**
 * 与 numpy `polyfit` 比时的容差（相对）。**κ 随金样录**，所以这条是可验算的。
 *
 * 用 {@link lstsqObservedTol}（κ **不**平方）而不是 `lstsqRelTol`（平方）：
 * 这一族的设计阵是一条**一次**多项式的缩放 Vandermonde，κ 在 2–4 量级 ——
 * 平方那一条会给 `1e−13` 量级的余量，等于什么都没测（`fit.ts` 抬头那一节）。
 */
export function polyfitRelTol(cond: number): number {
  return lstsqObservedTol(cond)
}

/** `symmetry` 的容差（**绝对** —— 它落在 `[0, 1]`）。 */
export { corrcoefAbsTol }

/**
 * 这一族**整棵结果树**的容差 —— `512 · eps`（相对，按字段的全批最大绝对值归一）。
 *
 * 推导：只有两处不逐位，取大的那个再留余量。
 *
 * | 处 | 界 | 数 |
 * |---|---|---|
 * | `corrcoef`（`symmetry`） | `corrcoefAbsTol(n) = 8·sumRelTol(n)`，本族 `n ≤ 64` | `384·eps` |
 * | `polyfit`（`fit_r2` / `barrier_ev` / `decay_per_nm`） | `lstsqObservedTol(κ)`，κ 随金样录（一次多项式的**列缩放后** Vandermonde，实测 3.63–3.65） | `15·eps` |
 *
 * `384 · 1.33 ≈ 512`。实测最坏占 **0.045**（`assess_iz/noise` 的 `decay_per_nm`）——
 * 那一格的 `coef_ratio` 是 **96**（纯噪声上的对数斜率只有 0.082，而截距是 −23），
 * 金样随格录了它，所以「为什么这一格最松」是可核对的。
 *
 * ⚠️ 它对**其余字段是白给的** —— `np.sum` / `mean` / `std` / `median` / `diff` /
 * `argsort` 那一串在本仓是逐位相同的（走 {@link npSum} 一族与 {@link npMedian}）。
 * 真正替它们把关的是**别的形状**的断言：`verdict` / `reasons` / `gated_criteria` /
 * `notes` 逐字，`n_jumps` / `n_spikes` 逐位（它们是整数）。
 * 「一条相对容差在一个整数上什么也没说」—— 所以那几项不靠它。
 */
export const SPECTRO_REL_TOL = 512 * EPS

/**
 * `assess_iz` —— 一条 I(z) 进针曲线。`zNm` 以**纳米**计，`current` 任意线性单位。
 *
 * 干净的针尖以单指数隧穿 `I ∝ exp(−2κz)`，衰减给出表观势垒（≈ 功函数，
 * 清洁金属针尖 4–5 eV）。对数-线性拟合差、或者斜坡中途有电流突跳 ⇒ 针尖钝 / 不稳 / 脏。
 *
 * ⚠️ `floor = max(1e-30, 1e-4·max|I|)` 那一道**不是**在滤噪声，是在保证
 * `log(I)` 有定义：零与负的电流（放大器本底、反向偏压）取不了对数。
 * 门限按**这条曲线自己的最大值**定，所以它跟着量程走 —— 一个绝对阈值在这里
 * 就是 `_fwd_bwd_instability` 那条 `1e-9` 的老毛病。
 */
export function assessIz(zNm: readonly number[] | Float64Array, current: readonly number[] | Float64Array): IzResult {
  const bad: IzResult = { is_clean_exponential: false, barrier_ev: null, fit_r2: 0.0, decay_per_nm: null, n_jumps: 0 }
  const z = Float64Array.from(zNm as Iterable<number>)
  const iAbs = Float64Array.from(current as Iterable<number>, (v) => Math.abs(v))
  if (z.length !== iAbs.length || z.length < 5) return bad
  const floor = Math.max(1e-30, 1e-4 * nanMax(iAbs))
  const zz: number[] = []
  const ll: number[] = []
  for (let i = 0; i < z.length; i += 1) {
    const zi = z[i] as number
    const ii = iAbs[i] as number
    if (Number.isFinite(zi) && Number.isFinite(ii) && ii > floor) {
      zz.push(zi)
      ll.push(Math.log(ii))
    }
  }
  if (zz.length < 5) return bad
  // `np.argsort` —— 见文件抬头（本仓**稳定**，numpy 的 quicksort 不是）。
  const order = zz.map((_, i) => i).sort((a, b) => (zz[a] as number) - (zz[b] as number) || a - b)
  const zs = Float64Array.from(order, (i) => zz[i] as number)
  const ls = Float64Array.from(order, (i) => ll[i] as number)

  const p = polyfit(zs, ls, 1)
  const slope = p[0] as number
  const intercept = p[1] as number
  const res = new Float64Array(zs.length)
  for (let i = 0; i < zs.length; i += 1) res[i] = ((ls[i] as number) - (slope * (zs[i] as number) + intercept)) ** 2
  const ssRes = npSum(res)
  const lMean = npSum(ls) / ls.length
  const dev = new Float64Array(ls.length)
  for (let i = 0; i < ls.length; i += 1) dev[i] = ((ls[i] as number) - lMean) ** 2
  const ssTot = npSum(dev) + 1e-12
  const r2 = Math.min(Math.max(1.0 - ssRes / ssTot, 0.0), 1.0)

  const decayPerNm = Math.abs(slope)
  const kappaPerA = decayPerNm / 2.0 / 10.0 // nm⁻¹ → Å⁻¹
  const barrier = kappaPerA > 0 ? (kappaPerA / K_PHI) ** 2 : null

  // 对数电流里的突跳 = 斜坡途中针尖跳了一下
  const d = new Float64Array(ls.length - 1)
  for (let i = 0; i < d.length; i += 1) d[i] = (ls[i + 1] as number) - (ls[i] as number)
  const dMed = npMedian(d)
  const absDev = Float64Array.from(d, (v) => Math.abs(v - dMed))
  const mad = npMedian(absDev) + 1e-9
  let nJumps = 0
  for (const v of absDev) if (v > JUMP_MAD_SIGMA * mad) nJumps += 1

  const clean = r2 > 0.9 && barrier !== null && barrier >= 0.5 && barrier <= 8.0 && nJumps === 0
  return {
    is_clean_exponential: clean,
    barrier_ev: barrier,
    fit_r2: r2,
    decay_per_nm: decayPerNm,
    n_jumps: nJumps,
  }
}

/**
 * `assess_iv` —— 一条 I(V) 隧道谱。稳定的针尖给一条光滑、无尖峰、大致反对称的曲线。
 *
 * 三个读数各挡一种针尖行为：
 *
 * * `smoothness = 1 − std(d²I)/std(dI)` —— 反馈在振 / 针尖在抖；
 * * `n_spikes`（`|dI − median| > 8·MAD`）—— 扫描途中针尖**跳**了；
 * * `symmetry = corr(I, −flip(I))` —— 一根对称的金属针尖给反对称的 I(V)。
 *
 * ⚠️ `symmetry` **不该单独用来否决一根针**：有能隙或不对称的衬底会让一根好针
 * 看起来不对称。这条警告在技能层（`AssessTipFromSpectrum`）上写着。
 */
export function assessIv(biasV: readonly number[] | Float64Array, current: readonly number[] | Float64Array): IvResult {
  const bad: IvResult = { is_stable: false, smoothness: 0.0, symmetry: 0.0, n_spikes: 0, gap_ev: null }
  const v0 = Float64Array.from(biasV as Iterable<number>)
  const i0 = Float64Array.from(current as Iterable<number>)
  if (v0.length !== i0.length || v0.length < 7) return bad
  const order = Array.from(v0, (_, i) => i).sort((a, b) => (v0[a] as number) - (v0[b] as number) || a - b)
  const V = Float64Array.from(order, (i) => v0[i] as number)
  const I = Float64Array.from(order, (i) => i0[i] as number)

  let maxAbsI = -Infinity
  for (const v of I) if (Math.abs(v) > maxAbsI) maxAbsI = Math.abs(v)
  const Is = Float64Array.from(I, (v) => v / (maxAbsI + 1e-30))

  const d1 = new Float64Array(Is.length - 1)
  for (let i = 0; i < d1.length; i += 1) d1[i] = (Is[i + 1] as number) - (Is[i] as number)
  const d2 = new Float64Array(d1.length - 1)
  for (let i = 0; i < d2.length; i += 1) d2[i] = (d1[i + 1] as number) - (d1[i] as number)
  const smoothness = Math.min(Math.max(1.0 - npStd(d2) / (npStd(d1) + 1e-9), 0.0), 1.0)

  const dMed = npMedian(d1)
  const absDev = Float64Array.from(d1, (v) => Math.abs(v - dMed))
  const mad = npMedian(absDev) + 1e-9
  let nSpikes = 0
  for (const v of absDev) if (v > JUMP_MAD_SIGMA * mad) nSpikes += 1

  // 反对称性：`I(V) ≈ −I(−V)` ⇒ 把 I 与 `−flip(I)` 相关
  const flip = Float64Array.from(Is, (_, i) => -(Is[Is.length - 1 - i] as number))
  const symmetry =
    npStd(Is) > 1e-9 && npStd(flip) > 1e-9 ? Math.min(Math.max(corrcoef(Is, flip), 0.0), 1.0) : 0.0

  // V=0 附近的近零电导能隙
  const thr = 0.03 * (maxAbsI + 1e-30)
  let lo = Infinity
  let hi = -Infinity
  let n0 = 0
  for (let i = 0; i < I.length; i += 1) {
    if (Math.abs(I[i] as number) < thr) {
      n0 += 1
      const vv = V[i] as number
      if (vv < lo) lo = vv
      if (vv > hi) hi = vv
    }
  }
  const gapEv = n0 >= 3 ? hi - lo : null

  return {
    is_stable: nSpikes === 0 && smoothness > 0.5,
    smoothness,
    symmetry,
    n_spikes: nSpikes,
    gap_ev: gapEv,
  }
}
