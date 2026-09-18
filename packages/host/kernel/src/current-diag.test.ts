/**
 * `current-diag.ts` 里**技能层走不到**的那几格。
 *
 * 判别表的六个结论、自标定噪声底、饱和三态，全部由
 * `stm-skills/l0/batch5b.test.ts` 的金样驱动（那才是判据的主场）。
 * 这个文件只补三种技能层排不出来的输入：
 *
 * 1. 拟合的**退化输入**（所有非零偏压模长相同 ⇒ 分母为 0）；
 * 2. `statistics.median` 的**偶数长度**（读三次里掉一次，剩两个）；
 * 3. `undefined`（`ctx.runSkill` 那一侧给的是 `null`，而这个函数收两种）；
 * 4. **判别表某一条线两侧的那一格**——金样录到的六个结论离每条线都很远，
 *    于是线挪一挪谁也不喊（末尾那个 describe，2026-09-19 补）。
 */
import { describe, expect, it } from 'vitest'
import {
  ABS_FLOOR_A,
  FLOOR_MULT,
  SATURATION_A,
  classifyCurrentOrigin,
  effectiveExponent,
  isSaturated,
  noiseFloorFromZero,
  statisticsMedian,
} from './current-diag.js'

describe('isSaturated：三态', () => {
  it('`null` 与 `undefined` 都是**读不到**，不是「没饱和」', () => {
    expect(isSaturated(null)).toBeNull()
    expect(isSaturated(undefined)).toBeNull()
  })

  it('端点是闭的（`>=`）：恰好等于满量程算饱和', () => {
    expect(isSaturated(SATURATION_A)).toBe(true)
    // 负的读数同样算 —— 判据是**幅度**贴在端点上
    expect(isSaturated(-SATURATION_A)).toBe(true)
    expect(isSaturated(SATURATION_A * 0.99)).toBe(false)
  })
})

describe('noiseFloorFromZero：0 V 那一点**自标定**，读不到才退回绝对下限', () => {
  it('读不到 0 V ⇒ 绝对下限', () => {
    expect(noiseFloorFromZero(null)).toBe(ABS_FLOOR_A)
  })

  it('读到了 ⇒ `FLOOR_MULT × |I(0V)|`，但不低于绝对下限', () => {
    expect(noiseFloorFromZero(1e-11)).toBeCloseTo(FLOOR_MULT * 1e-11, 20)
    // 一个干净得不像话的 0 V 读数不该把底线压到 0
    expect(noiseFloorFromZero(1e-18)).toBe(ABS_FLOOR_A)
  })
})

describe('effectiveExponent：拟不出来时给 **null**，不是 0', () => {
  it('高于噪声底的点不足两个 ⇒ null（而**被剔掉的点不进 `used`**）', () => {
    const fit = effectiveExponent(
      [
        { biasV: 2.0, currentA: 1e-10 },
        { biasV: 1.0, currentA: 1e-15 }, // 噪声底以下
        { biasV: 0.0, currentA: 1e-14 }, // |V| 太小
      ],
      1e-13,
    )
    expect(fit.exponent).toBeNull()
    expect(fit.used).toHaveLength(1)
  })

  it('所有非零偏压**模长相同** ⇒ 分母为 0 ⇒ null（一条竖线拟不出斜率）', () => {
    const fit = effectiveExponent(
      [
        { biasV: 2.0, currentA: 1e-10 },
        { biasV: -2.0, currentA: 3e-10 },
      ],
      1e-13,
    )
    expect(fit.used).toHaveLength(2)
    expect(fit.exponent).toBeNull()
  })

  it('读不到的点直接跳过（`null` 不当 0）', () => {
    const fit = effectiveExponent(
      [
        { biasV: 2.0, currentA: null },
        { biasV: null, currentA: 1e-10 },
        { biasV: 1.0, currentA: 1e-10 },
        { biasV: 2.0, currentA: 4e-10 },
      ],
      1e-13,
    )
    expect(fit.used).toHaveLength(2)
    expect(fit.exponent).toBeCloseTo(2.0, 12)
  })
})

describe('classifyCurrentOrigin：判别表里技能层排不出来的那四格', () => {
  it('最大偏压下**一个数都没读到** ⇒ undetermined（「读不到」不是「没有」）', () => {
    const got = classifyCurrentOrigin(1e-14, 2.0, null)
    expect(got.verdict).toBe('undetermined')
    expect(got.message).toContain('**「读不到」不是「没有」。**')
  })

  it('0 V 脏、比值够大、但**指数拟不出来** ⇒ 先把本底的来源找掉', () => {
    const got = classifyCurrentOrigin(1e-11, null, 1e-9)
    expect(got.verdict).toBe('not_a_junction_current')
    expect(got.message).toContain('偏压依赖又拟不出来')
  })

  it('0 V 干净、但**非零偏压的点不够** ⇒ undetermined，不是「没有结电流」', () => {
    const got = classifyCurrentOrigin(1e-14, null, 1e-10)
    expect(got.verdict).toBe('undetermined')
    expect(got.message).toContain('拟不出指数')
  })

  it('0 V 干净、而电流**几乎不随偏压变** ⇒ 自相矛盾，去查量程与增益', () => {
    const got = classifyCurrentOrigin(1e-14, 0.1, 1e-10)
    expect(got.verdict).toBe('not_a_junction_current')
    expect(got.message).toContain('自相矛盾')
  })
})

/**
 * 场发射那条线**卡在 3，不是 2** —— 金样里没有一格落在 2 与 3 之间。
 *
 * `classify/junction_current` 录的是 n = 1.0，`classify/field_emission` 录的是 n = 9.7，
 * 而 `classify/mixed` 那个 n = 2.0 的点 0 V 是**脏**的，于是它在指数这一档之前就被
 * 「0 V 有本底」那一支接走了。三格都在，**这条线两侧的那一格一格都没有** ——
 * 于是把线从 3 挪到 2 不改变任何一格的判决（2026-09-19 变异演练查出来的）。
 *
 * ⚠️ 这里**故意写字面量 2.5 / 3.0，不引用 `N_FIELD_EMISSION`**：引用常量的断言会
 * 跟着常量一起动，那样这一格问的就不再是「线在哪」而是「代码等于它自己」。
 */
describe('classifyCurrentOrigin：场发射的线在 n = 3', () => {
  it('0 V 干净、n = 2.5 ⇒ **结电流**。真实隧穿结在 1–2 V 上本来就有能带效应带来的超线性', () => {
    const got = classifyCurrentOrigin(1e-14, 2.5, 3e-10)
    expect(got.verdict).toBe('junction_current')
    // 卡在 2 的那条线会把这一格判成场发射，而那条结论的下一步是「降偏压或进针」——
    // 对一个好结来说，那是**把针尖推向表面**。
    expect(got.message).toContain('这是真的结电流')
  })

  it('n = 3.0 恰好在线上 ⇒ **场发射**（端点是闭的）', () => {
    const got = classifyCurrentOrigin(1e-14, 3.0, 3e-10)
    expect(got.verdict).toBe('field_emission')
    expect(got.message).toContain('降偏压或进针')
  })
})

describe('statisticsMedian：**不是** `np.percentile(50)`，也不是 `numerics.median`', () => {
  it('空表给 null —— 「一次都没读到」不是「读到了 0」', () => {
    expect(statisticsMedian([])).toBeNull()
  })

  it('奇数取中间，偶数取中间两个的**算术平均**（三读掉一次就走这一支）', () => {
    expect(statisticsMedian([3, 1, 2])).toBe(2)
    expect(statisticsMedian([4, 1])).toBe(2.5)
  })

  it('不改调用方给的那个数组（中位要排序，而调用方后面还要按顺序用它）', () => {
    const xs = [3, 1, 2]
    statisticsMedian(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})
