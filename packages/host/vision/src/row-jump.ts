/**
 * 逐行跳动 —— `AssessFrameTrust` 的判据本体（旧仓 `skills/builtins/frame_trust.py`
 * 里的 `_row_medians`(7) / `row_jump_mad_pm`(23) / `row_big_jumps`(18) /
 * `row_jump_sigma_pm`(11)）。
 *
 * ## 它回答的问题：这一帧的坏，是**针尖**的坏还是**地形**的坏
 *
 * 2026-08-26 夜同一个误判换了两种形状出现两次：针尖质量判据（RMS / 长宽比 /
 * 三方向散布 / snr）**全部预设「整帧是平坦原子面」**，帧不满足这个前提时它们
 * 描述的是**地形**，而且**不会报错** —— 只会给出一个像样的坏分数。
 *
 * * 长宽比 3.045 / 3.157、散布 6.8%、高度一致 ⇒ 判「针尖稳定地坏了」⇒ 扎针四次。
 *   渲染原图才发现扫描框骑在一个 p-v 2.5 nm 的三角凹陷上；
 * * 换到平区后「完全量不出晶格」、RMS 76 pm ⇒ 已经写下「我把针尖扎坏了」。
 *   再看图：两帧几乎逐像素相同，逐行跳动 σ 只有 2.5 pm ⇒ 针尖非常稳。
 *
 * ⇒ 本件只报一个**与地形无关**的量：逐行中位高度的一阶差分。
 * 地形再起伏，相邻两行的中位高度也只差一点点；而针尖跳一次，整行就整体抬起或落下。
 *
 * ## 为什么主指标是 **MAD** 而不是标准差
 *
 * 标准差被少数几个大跳变主导 —— 而沿慢轴的**真实台阶**正是少数几个大跳变。
 * 08-26 合成对照（同一批噪声）：
 *
 * ```
 * 地形                标准差      MAD
 * 沿慢轴台阶 2.5 nm    156.19     0.51   ← 标准差被真实台阶骗，MAD 不
 * 沿快轴斜坡 4 nm        4.30     4.11
 * 团簇                  1.03     0.71
 * ```
 *
 * ## 容差：这一族**坐在 RANSAC 下游**，所以它的容差是百分数，不是 ulp
 *
 * 技能先 `planeSubtractRobust`（RANSAC）再量这几个数。两边抽到的三点子集不同 ⇒
 * 拟合的平面**斜率**不同 ⇒ 每一行减掉的不是同一条直线 ⇒ **这一行的中位数可能跳到
 * 相邻的那个次序统计量上**。
 *
 * 量一遍这个跳有多大：96 个样本铺在 ~16 pm 的行内起伏上，相邻次序统计量的间距
 * 约 `16/96 ≈ 0.17 pm`；平面斜率的差在整帧上是 0.04 pm 量级，够让靠得近的两个
 * 次序统计量换位。于是行中位数抖 ~0.1 pm、差分抖 ~0.2 pm，而 MAD 本身是 1.4 pm
 * ⇒ **相对变化几个百分点**。实测 `1.369` 对 `1.390`，差 **1.5%**。
 *
 * ⇒ {@link ROW_JUMP_REL_TOL}` = 0.05`（实测最坏值的 3 倍余量）。
 *
 * ## ⚠️ 而**判据本身**离这条容差有 29 倍
 *
 * 分档在 40 / 250 pm 上，实测值 1.4 pm —— 也就是说这 5% 的不确定**碰不到任何一条
 * 分档线**，`tip_verdict` 与那句话（印 `%.1f`，两边都是 `1.4`）逐字相同。
 * 一条容差大到 5% 还敢用，靠的是这个 29 倍，不是靠它本身小。
 *
 * `bigJumps` / `nRows` 是**整数，容差 0**。
 */
import { type Mat } from 'dsh-spm-numerics'
import { finiteOf, nanMedian, nanStd } from './nd.js'

/** RANSAC 下游那几个逐行统计量对旧仓的相对容差。推导见文件抬头。 */
export const ROW_JUMP_REL_TOL = 0.05

/** 分档（pm），**用 2026-08-26 真机帧标定过**：好针尖 11.3–29.1，被脉冲毁掉之后 308–2335。 */
export const ROW_GOOD_PM = 40.0
/** 同上 —— 40 与 250 落在那两簇之间的空档里。 */
export const ROW_USABLE_PM = 250.0

/** 「大跳变」= 超过 5×MAD **且**至少 50 pm。两条并且 —— 只用倍数会让极干净的帧
 * 把普通噪声数成跳变，只用绝对值会让粗糙帧漏报。 */
export const BIG_JUMP_SIGMAS = 5.0
export const BIG_JUMP_MIN_PM = 50.0

/** 逐行中位高度（丢掉算不出中位数的行）。 */
export function rowMedians(zPm: Mat): number[] {
  const out: number[] = []
  for (let r = 0; r < zPm.rows; r += 1) {
    const row: number[] = []
    for (let c = 0; c < zPm.cols; c += 1) row.push(zPm.data[r * zPm.cols + c] as number)
    const m = nanMedian(row)
    if (Number.isFinite(m)) out.push(m)
  }
  return out
}

function diff(xs: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < xs.length; i += 1) out.push((xs[i] as number) - (xs[i - 1] as number))
  return out
}

/** 逐行中位高度差分的 **MAD**（×1.4826，折算成 σ 当量），pm。**主指标。** */
export function rowJumpMadPm(zPm: Mat): number | null {
  const med = rowMedians(zPm)
  if (med.length < 3) return null
  const d = diff(med)
  const dm = nanMedian(d)
  return nanMedian(d.map((v) => Math.abs(v - dm))) * 1.4826
}

/**
 * 大跳变的次数与总行数。
 *
 * ⚠️ **它分不开「针尖跳了一下」和「扫过一道真实台阶」** —— 两者在逐行中位高度上
 * 是同一个形状。这里只把次数报出来，**不据此下针尖的结论**。
 */
export function rowBigJumps(zPm: Mat): [number, number] | [null, null] {
  const med = rowMedians(zPm)
  if (med.length < 3) return [null, null]
  const d = diff(med)
  const dm = nanMedian(d)
  const mad = nanMedian(d.map((v) => Math.abs(v - dm))) * 1.4826
  const thr = Math.max(BIG_JUMP_SIGMAS * mad, BIG_JUMP_MIN_PM)
  let n = 0
  for (const v of d) if (Math.abs(v) > thr) n += 1
  return [n, d.length]
}

/** 差分的标准差（pm）。**辅助量** —— 它也会被真实台阶抬高。判针尖看 MAD。 */
export function rowJumpSigmaPm(zPm: Mat): number | null {
  const med = rowMedians(zPm)
  if (med.length < 3) return null
  return nanStd(diff(med))
}

/** 有限像素个数 —— 技能层那道「不足 100 个就判不了」的门要它。 */
export function finiteCount(m: Mat): number {
  return finiteOf(m.data).length
}
