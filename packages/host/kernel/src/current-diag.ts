/**
 * 「这股电流是什么」—— 用**偏压依赖**判来路，外加「读数贴在量程端点」那一条。
 *
 * 旧仓 `builtins/saturation_recovery.py:is_saturated` 与
 * `builtins/current_origin.py` 的 `noise_floor_from_zero` / `effective_exponent` /
 * `classify` 四个纯函数。**零 numpy、零 I/O**，所以留在 kernel（与
 * `corrugation-gate.ts` 同一条理由：这一族一行 numpy 都没有）。
 *
 * ## 判别表（2026-08-28 真机推出来的那一张）
 *
 * 横移途中拦截线报「检测到电流 1.17e-11 A」，用户的假设是「压电动的时候串进去的」。
 * 那个假设**是可判的**，判别点是 **0 V 那一个读数**：
 *
 * ```
 * 2.00 V → 111.65 pA      偏压变 2 倍，电流变 859 倍（n ≈ 9.7）⇒ 场发射
 * 1.00 V →   0.13 pA
 * 0.00 V →  −0.01 pA      ← 0 V 干净，把「串扰」判掉了
 * ```
 *
 * 压电运动感生的位移电流**不关心偏压**，0 V 下照样在；而隧穿与场发射在 0 V 下
 * 都必须是零。**看着最没用的那一点是唯一的判别点。**
 *
 * ## 三条「第一版写错了、改法写在常量上」的判据
 *
 * | 常量 | 第一版 | 为什么改 |
 * |---|---|---|
 * | {@link ABS_FLOOR_A} | 写死 `1e-12` | 08-28 那组里 1.00 V 读到 **0.13 pA**，会被当成「读不到」剔掉 ⇒ 只剩一个点 ⇒ 拟不出指数 ⇒ `undetermined` |
 * | {@link noiseFloorFromZero} | 没有（拍一个绝对值） | 0 V 那一点本身就是「确定没有结电流时这台机器读到什么」的**直接测量**，用它自标定比拍一个数可靠 |
 * | {@link FLAT_RATIO} | 只有对数拟合 | 拟合用的底是 `3×|I(0V)|`，而「与偏压无关」这一格**按定义**就与 `I(0V)` 同量级 ⇒ 判别表最该抓的那一格被自己的底线吃掉 |
 *
 * ⚠️ {@link classifyCurrentOrigin} **故意不收**自标定的噪声底：自标定的底只回答
 * 「这一点的偏压依赖有没有意义」（喂 {@link effectiveExponent}），回答不了
 * 「有没有电流」。旧仓把那个参数**删掉**而不是留着不用 —— 留着的话下一个人会以为
 * 它在起作用。这里照移。
 */
import { formatG, pySum } from './si.js'
import { pyFixed } from './z-trace.js'

/**
 * 放大器满量程（A）。读数贴到这里 = **饱和**，不是电流。
 *
 * 08-28 实测锁死值 `1.00036e-8` A —— 本机前置的 10 nA 档。
 */
export const SATURATION_A = 9.5e-9

/**
 * 读数是否贴在量程端点。
 *
 * `null` ⇒ **读不到**，不是「没饱和」。三态，而三态是这一条的全部要点：
 * 「读数不动」有两个原因，一个是没有电流，一个是量程满了，
 * 而两者要做的事完全相反。
 */
export function isSaturated(currentA: number | null | undefined): boolean | null {
  if (currentA === null || currentA === undefined) return null
  return Math.abs(currentA) >= SATURATION_A
}

/** 判「已脱离饱和」的电流上限（A）。比隧穿工作点留得宽 —— 退开途中经过场发射区时
 * 读数仍可能有几百 pA。 */
export const RECOVERED_A = 1e-10

/**
 * 粗动 Z 退针的阶梯（步）。**逐级而不是一次退到底**：退过头就要多花几分钟重新进针，
 * 而每级之后多读一次电流几乎不要钱。
 */
export const RETRACT_LADDER: readonly number[] = [20, 30, 50, 100, 200, 400]

/** 横移/退针期间的安全偏压（V）。带着成像偏压时几十 nm 距离就场发射，读数没法用来判断。 */
export const SAFE_BIAS_V = 0.2

/** 判「0 V 下没有电流」的上限（A）。比典型隧穿工作点（20–120 pA）低一个量级以上。 */
export const ZERO_FLOOR_A = 2e-12

/**
 * 噪声底的**绝对**下限（A）。
 *
 * ⚠️ 第一版写死 `1e-12`。08-28 真实那一组里 1.00 V 读到 **0.13 pA**（=1.3e-13 A），
 * 会被这条线当成「读不到」剔掉 —— 判据里写死的绝对阈值又一次与这台机器的实际噪声
 * 不匹配。
 */
export const ABS_FLOOR_A = 2e-14

/** 自标定倍数：高于 0 V 读数这么多倍才算「读到了」。 */
export const FLOOR_MULT = 3.0

/** 等效指数的下界。`n < 0.5` ⇒ 与偏压无关。 */
export const N_FLAT = 0.5

/**
 * 判场发射的等效指数。
 *
 * **3 而不是 2**：真实隧穿结在 1–2 V 上本来就有能带效应带来的超线性，卡 2 会把
 * 好结判成场发射。08-28 实测那次 `n ≈ 9.7`，离 3 很远。
 */
export const N_FIELD_EMISSION = 3.0

/**
 * 「与偏压无关」的**直接**判据：最大偏压下的电流不到 0 V 读数的这么多倍。
 *
 * 用**原始读数的比值**，不靠对数拟合 —— 现场当晚的推理也是比值
 * （「2 倍偏压 859 倍电流」），不是拟合。
 */
export const FLAT_RATIO = 2.0

/** 静态复现判据：静态读数与被怀疑读数差到几倍以上算「没复现」。 */
export const REPRODUCE_RATIO = 3.0

/**
 * 噪声底由 0 V 那一点自标定。读不到 0 V 时退回 {@link ABS_FLOOR_A}。
 *
 * 0 V 读数就是「确定没有结电流时这台机器读到什么」的直接测量。
 */
export function noiseFloorFromZero(iZeroA: number | null): number {
  if (iZeroA === null) return ABS_FLOOR_A
  return Math.max(Math.abs(iZeroA) * FLOOR_MULT, ABS_FLOOR_A)
}

/** 一个 (V, I) 观测点。两边都可能读不到。 */
export interface BiasCurrentPoint {
  readonly biasV: number | null
  readonly currentA: number | null
}

/** {@link effectiveExponent} 的结果：斜率（拟不出是 `null`）+ 真正参与拟合的那几点。 */
export interface ExponentFit {
  readonly exponent: number | null
  readonly used: readonly (readonly [number, number])[]
}

/**
 * 由 `[(V, I)]` 拟 `n = dln|I| / dln|V|`。点不够或值非法时 `exponent` 是 `null`。
 *
 * 只用 `|V| > 1e-9` **且** `|I|` 高于噪声底的点 —— 噪声底上的读数是「读不到」，
 * 喂进去会把指数**拉平**（与 `barrier_height` 那次是同一个坑）。
 *
 * ## 容差：**0**
 *
 * 这不是一条数值近似。旧仓这段是**纯 Python**（`math.log` + 内置 `sum`），
 * 一次对数、两次均值、一次最小二乘斜率，全是闭式；`math.log` 与 `Math.log` 都按
 * IEEE-754 正确舍入到最近。所以两侧逐位相同，判据给 0。
 *
 * ⚠️ 三处求和用 {@link pySum}（CPython 3.12 起 `sum()` 走 Neumaier 补偿求和），
 * **不是**朴素逐项相加 —— 那会在最后两位分岔，而这一条的容差是 0。
 */
export function effectiveExponent(
  points: readonly BiasCurrentPoint[],
  floorA: number,
): ExponentFit {
  const usable: [number, number][] = []
  for (const p of points) {
    if (p.biasV === null || p.currentA === null) continue
    const v = Math.abs(p.biasV)
    const i = Math.abs(p.currentA)
    if (v > 1e-9 && i > floorA) usable.push([v, i])
  }
  if (usable.length < 2) return { exponent: null, used: usable }
  const xs = usable.map(([v]) => Math.log(v))
  const ys = usable.map(([, i]) => Math.log(i))
  const n = xs.length
  const mx = pySum(xs) / n
  const my = pySum(ys) / n
  const den = pySum(xs.map((x) => (x - mx) ** 2))
  if (den <= 0) return { exponent: null, used: usable }
  const slope = pySum(xs.map((x, k) => (x - mx) * ((ys[k] as number) - my))) / den
  if (!Number.isFinite(slope)) return { exponent: null, used: usable }
  return { exponent: slope, used: usable }
}

/** 判别表能给出的**全部**结论。调用方必须对每一个都表态。 */
export type CurrentVerdict =
  | 'undetermined'
  | 'no_measurable_current'
  | 'not_a_junction_current'
  | 'mixed'
  | 'field_emission'
  | 'junction_current'

/** 判别表的一行：结论 + 说给人听的那一句（**逐字**，它是模型读的东西）。 */
export interface CurrentOrigin {
  readonly verdict: CurrentVerdict
  readonly message: string
}

/**
 * 判别表。任何一项读不到都返回 `undetermined`。
 *
 * 顺序是判据的一部分：`i_max` 读不到 → 绝对底线 → 0 V 读不到 → 0 V 脏（三分支）
 * → 指数。把「0 V 脏」放在指数之前，是因为 0 V 有本底时**指数说明不了问题**
 * （一个真结叠在一个偏置上，两者都在）。
 */
export function classifyCurrentOrigin(
  iZeroA: number | null,
  exponent: number | null,
  iMaxA: number | null,
): CurrentOrigin {
  if (iMaxA === null) {
    return {
      verdict: 'undetermined',
      message: '最大偏压下读不到电流 —— 判不了。**「读不到」不是「没有」。**',
    }
  }
  // ⚠️ 这里用**绝对**下限，而且本函数**故意不收**自标定的噪声底（见文件抬头）。
  if (Math.abs(iMaxA) < ABS_FLOOR_A) {
    return {
      verdict: 'no_measurable_current',
      message:
        '所有偏压下都在噪声底以下 —— 没有可测的电流。' +
        '若针尖本该在隧穿，这说明它已经退开或反馈没 engage。',
    }
  }
  if (iZeroA === null) {
    return {
      verdict: 'undetermined',
      message: '0 V 下读不到 —— **0 V 那一点正是判别点**，缺了它判不了。',
    }
  }
  if (Math.abs(iZeroA) >= ZERO_FLOOR_A) {
    // 直接用原始读数的比值，不依赖拟合能不能算出来
    const ratio = Math.abs(iMaxA) / Math.max(Math.abs(iZeroA), 1e-18)
    if (ratio <= FLAT_RATIO) {
      return {
        verdict: 'not_a_junction_current',
        message:
          `0 V 下仍有 ${formatG(iZeroA, 3)} A，而最大偏压下也只有 ${formatG(iMaxA, 3)} A` +
          `（${pyFixed(ratio, 1)} 倍）—— ` +
          '**这不是结电流**：它几乎不随偏压变，而隧穿与场发射在 0 V 下' +
          '都必须是零。偏置漂移／某处串扰／前置放大器断了，三者都长这样；' +
          '分开它们要另一个观察：把可疑的动作停下来看它消不消失。',
      }
    }
    if (exponent === null || exponent < N_FLAT) {
      return {
        verdict: 'not_a_junction_current',
        message:
          `0 V 下仍有 ${formatG(iZeroA, 3)} A —— **这不是（纯粹的）结电流**，` +
          '而偏压依赖又拟不出来（本底把点都盖住了）。' +
          '先把 0 V 本底的来源找掉再判结。',
      }
    }
    return {
      verdict: 'mixed',
      message:
        `0 V 下有 ${formatG(iZeroA, 3)} A 的本底，但电流确实随偏压变` +
        `（${pyFixed(ratio, 0)} 倍，n=${pyFixed(exponent, 1)}）—— ` +
        '一个真的结电流叠在一个偏置上。先把本底的来源找掉再判结。',
    }
  }
  if (exponent === null) {
    return {
      verdict: 'undetermined',
      message: '0 V 干净，但非零偏压的点不够（或都在噪声底上），拟不出指数。',
    }
  }
  if (exponent >= N_FIELD_EMISSION) {
    return {
      verdict: 'field_emission',
      message:
        `0 V 干净而电流随偏压极度超线性（n=${pyFixed(exponent, 1)}）—— **场发射**，不是隧穿。` +
        '针尖离表面太远而偏压太高。降偏压或进针；' +
        '带着成像偏压做横移/粗动时最常撞见它。',
    }
  }
  if (exponent < N_FLAT) {
    return {
      verdict: 'not_a_junction_current',
      message:
        `电流几乎不随偏压变（n=${pyFixed(exponent, 1)}）而 0 V 下又是干净的 —— 自相矛盾，` +
        '多半是读数被别的东西钳住了。先查量程与增益。',
    }
  }
  return {
    verdict: 'junction_current',
    message:
      `0 V 干净、电流随偏压近似线性（n=${pyFixed(exponent, 1)}）—— 这是真的结电流（隧穿/接触）。`,
  }
}

/**
 * `statistics.median` —— **不是** `numerics.median`（那一个走 `np.percentile(50)`，
 * 偶数长度上差最后一位，见 D-VISION-2）。
 *
 * 这一族（`_settled_current` / `_median_current`）读的是三次电流取中位，旧仓用的
 * 就是 `statistics.median`：排序，奇数取中间、偶数取中间两个的**算术平均**。
 * 空表给 `null`（旧仓那一侧是 `StatisticsError`，调用点先判了空）。
 */
export function statisticsMedian(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = s.length >> 1
  if ((s.length & 1) === 1) return s[i] as number
  return ((s[i - 1] as number) + (s[i] as number)) / 2
}
