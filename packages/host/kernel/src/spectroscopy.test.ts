/**
 * 谱学判定件 + `SafeCall` 的 per-call recv 预算。
 *
 * **这个文件里最重要的一格是行列那一格**，而它之所以要专门写，是因为轨迹金样
 * 验不到它：合成回包给的 `2f` 是一块 2×2，而表头说 6×7，于是两条采集技能的
 * 每一条轨迹走的都是「装不下」那一支 —— 成功解开的那条路**一格金样都没有**。
 *
 * 而且它必须用**逐格互不相同**的数据：一张转置的谱在数值上仍然是一串合法的浮点，
 * 用一格全是 0.25 的数据，转置与不转置给出的答案一模一样。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_RECV_TIMEOUT_S,
  SWEEP_BUDGET_FALLBACK_S,
  effectiveRecvBudget,
  matchSpectrumChannel,
  pyRound,
  reshapeSpectrum,
  slowCallFrom,
  sweepDuration,
  type SkillCallRecord,
} from './index.js'

/** `["i","i","*+c","i","i","2f","i","*f"]` 的 body。 */
function variables(names: string[], rows: number, cols: number, block: unknown): unknown[] {
  return [0, names.length, names, rows, cols, block, 0, []]
}

describe('reshapeSpectrum · 行 = 通道，列 = 扫描点', () => {
  it('**逐格互不相同**的 2×3：每一行整行归它自己的通道', () => {
    // 通道 A 的三个点是 11,12,13；通道 B 的是 21,22,23。
    // 转置的读法会给 A=[11,21]、B=[12,22] —— 一样是合法的浮点，
    // 而且量纲也对。只有逐格不同的数据分得出这两种读法。
    const got = reshapeSpectrum(variables(['Bias (V)', 'Current (A)'], 2, 3, [
      [11, 12, 13],
      [21, 22, 23],
    ]))
    expect(got.reason).toBe('')
    expect(got.numPoints).toBe(3)
    expect(got.channels).toEqual({ 'Bias (V)': [11, 12, 13], 'Current (A)': [21, 22, 23] })
  })

  it('扁平的一串照样按行切 —— `reshape` 是按行优先摊开的', () => {
    const got = reshapeSpectrum(variables(['a', 'b'], 2, 3, [11, 12, 13, 21, 22, 23]))
    expect(got.channels).toEqual({ a: [11, 12, 13], b: [21, 22, 23] })
  })

  it('通道名比行数多时**只取前 rows 个**（多出来的名字没有对应的行）', () => {
    const got = reshapeSpectrum(variables(['a', 'b', 'c'], 2, 2, [[1, 2], [3, 4]]))
    expect(Object.keys(got.channels)).toEqual(['a', 'b'])
  })

  it('`numPoints` 是**列数**，不是通道数', () => {
    const got = reshapeSpectrum(variables(['a'], 1, 5, [[1, 2, 3, 4, 5]]))
    expect(got.numPoints).toBe(5)
  })
})

describe('reshapeSpectrum · 五条 bail-out 各自说得出为什么', () => {
  it('Variables 不足 6 项', () => {
    const got = reshapeSpectrum([0, 1, ['a'], 1, 1])
    expect(got.reason).toBe('Variables 不足 6 项(实际 5),不是一个谱数据块')
    expect(got.numPoints).toBe(0)
  })

  it('根本不是序列', () => {
    expect(reshapeSpectrum('nope').reason).toBe('Variables 不足 6 项(实际 非序列),不是一个谱数据块')
  })

  it('行列数不是整数', () => {
    const got = reshapeSpectrum(variables(['a'], 0, 0, []).map((v, i) => (i === 3 ? 'x' : v)))
    expect(got.reason).toBe("行列数不是整数(rows='x', cols=0)")
  })

  it('数据块不是列表 / 行列数非正 —— 那句诊断把**它到底是什么**印出来', () => {
    expect(reshapeSpectrum(variables(['a'], 0, 3, [[1]])).reason).toBe(
      '数据块不是列表或行列数非正(rows=0, cols=3, data=list)',
    )
    expect(reshapeSpectrum(variables(['a'], 1, 1, 0.25)).reason).toBe(
      '数据块不是列表或行列数非正(rows=1, cols=1, data=float)',
    )
    expect(reshapeSpectrum(variables(['a'], 1, 1, 3)).reason).toContain('data=int')
    expect(reshapeSpectrum(variables(['a'], 1, 1, true)).reason).toContain('data=bool')
    expect(reshapeSpectrum(variables(['a'], 1, 1, 'x')).reason).toContain('data=str')
    expect(reshapeSpectrum(variables(['a'], 1, 1, null)).reason).toContain('data=NoneType')
    expect(reshapeSpectrum(variables(['a'], 1, 1, { n: 1 })).reason).toContain('data=object')
  })

  it('线协议层给的是 `Float64Array` 时照样解得开', () => {
    // 2D 块在不同的解码路径上可能是嵌套表、也可能是一条 typed array。
    // 认不出它 ⇒ 落到「有不是数的元素」，而那是一句**说错了的**诊断。
    const got = reshapeSpectrum(variables(['a', 'b'], 2, 2, Float64Array.from([1, 2, 3, 4])))
    expect(got.reason).toBe('')
    expect(got.channels).toEqual({ a: [1, 2], b: [3, 4] })
  })

  it('装不下', () => {
    expect(reshapeSpectrum(variables(['a'], 6, 7, [[1, 2], [3, 4]])).reason).toBe(
      '6×7 装不下这段数据: 一共 4 个数,要 42 个',
    )
  })

  it('数据里有不是数的元素（旧仓那边是 `np.array` 抛）', () => {
    expect(reshapeSpectrum(variables(['a'], 1, 2, [['x', 2]])).reason).toBe(
      '1×2 装不下这段数据: 这段数据里有不是数的元素',
    )
  })

  it('解开了但一个通道名都没有 —— **这不是「零个点」**', () => {
    const got = reshapeSpectrum(variables([], 2, 2, [[1, 2], [3, 4]]))
    expect(got.reason).toBe('数据解开了(2×2),但一个通道名都没有')
    // 要害：`numPoints` 是 0，而这个 0 **不表示这条谱只有 0 个点**。
    // 分得开它们的唯一东西就是 `reason`。
    expect(got.numPoints).toBe(0)
    expect(got.reason).not.toBe('')
  })

  it('真的解开了的那一格 `reason` 是空串 —— 两者不会混', () => {
    expect(reshapeSpectrum(variables(['a'], 1, 1, [[7]])).reason).toBe('')
  })

  it('`inf` / `NaN` **收下** —— 一整条 NaN 正是最该被看见的那种数据', () => {
    const got = reshapeSpectrum(variables(['a'], 1, 2, [[Number.NaN, Number.POSITIVE_INFINITY]]))
    expect(got.reason).toBe('')
    expect(got.channels['a']?.[0]).toBeNaN()
  })
})

describe('matchSpectrumChannel · 按名字认，不按列号', () => {
  const channels = { 'Bias (V)': [1], 'Current (A)': [2], 'LIX 1 omega (A)': [3] }

  it('大小写不敏感的子串命中第一个', () => {
    expect(matchSpectrumChannel(channels, ['current'])).toEqual([2])
    expect(matchSpectrumChannel(channels, ['lix'])).toEqual([3])
  })

  it('没命中给 `null`，不给第 0 条', () => {
    expect(matchSpectrumChannel(channels, ['frequency'])).toBeNull()
  })
})

describe('sweepDuration · 时长从仪器自己的设定算', () => {
  const timing = {
    z_averaging_time_s: 0.25,
    initial_settling_time_s: 0.75,
    settling_time_s: 1.25,
    integration_time_s: 1.5,
    end_settling_time_s: 1.75,
    z_control_time_s: 2.0,
  }

  it('往返翻倍', () => {
    const fwd = sweepDuration({ numPoints: 6, numSweeps: 4, backward: false }, timing)
    const both = sweepDuration({ numPoints: 6, numSweeps: 4, backward: true }, timing)
    expect(fwd.coreS).toBeCloseTo(6 * 2.75 * 4 + 4.75 * 4, 9)
    expect(both.coreS).toBeCloseTo(6 * 2.75 * 2 * 4 + 4.75 * 4, 9)
    expect(both.detail['backward']).toBe(true)
  })

  it('读不到点数 ⇒ 退到**上限**那一侧，并说清为什么', () => {
    const got = sweepDuration({ numPoints: null, numSweeps: 4, backward: true }, timing)
    expect(got.coreS).toBe(SWEEP_BUDGET_FALLBACK_S)
    expect(got.detail['why']).toBe('读不到扫掠设定，退回保守上限')
    // 「读不到」不是「很快」：退回的数**比任何一次真实估算都大**，
    // 退回一个小数字正是 2026-09-08 那个 bug 的形状。
    expect(got.coreS).toBeGreaterThan(sweepDuration({ numPoints: 6, numSweeps: 4, backward: true }, timing).coreS)
  })

  it('少了积分时间 ⇒ 同样退回（那一项没有合理的缺省）', () => {
    const got = sweepDuration({ numPoints: 6, numSweeps: 4, backward: true }, {})
    expect(got.coreS).toBe(SWEEP_BUDGET_FALLBACK_S)
    expect(got.detail['timing_keys']).toEqual([])
  })

  it('其余时序项**缺了当 0**，而不是让整趟退回', () => {
    const got = sweepDuration({ numPoints: 2, numSweeps: 1, backward: false }, { integration_time_s: 1 })
    expect(got.coreS).toBe(2)
  })
})

describe('pyRound · Python 的 round 是银行家舍入，而且按精确值', () => {
  it('正好一半 ⇒ 取偶', () => {
    expect(pyRound(0.125, 2)).toBe(0.12)
    expect(pyRound(0.135, 2)).toBe(0.14)
    expect(pyRound(-0.125, 2)).toBe(-0.12)
    expect(pyRound(2.5, 0)).toBe(2)
    expect(pyRound(3.5, 0)).toBe(4)
  })

  it('**看起来**像一半、其实高于一半 ⇒ 进位（金样教的那一格）', () => {
    // `151*1.35+45` 的精确值是 248.850000000000022737…，而它乘 10 之后
    // **恰好**是 2488.5 —— 拿乘法判「一半」会把它按成 248.8，Python 给 248.9。
    expect(pyRound(151 * 1.35 + 45, 1)).toBe(248.9)
  })

  it('普通情形与 `toFixed` 一致（两边都按精确值算）', () => {
    expect(pyRound(2.675, 2)).toBe(2.67)
    expect(pyRound(151, 1)).toBe(151)
  })
})

// ── per-call recv 预算 ──────────────────────────────────────────────────────

const rec = (method: string, ...args: unknown[]): Promise<SkillCallRecord> =>
  Promise.resolve({ method, args, values: [1] })

describe('effectiveRecvBudget · 抬多少，以及什么时候一个数都不抬', () => {
  it('按上限夹住 —— 上限是**台架的属性**', () => {
    expect(effectiveRecvBudget(3000, DEFAULT_MAX_RECV_TIMEOUT_S)).toBe(900)
    expect(effectiveRecvBudget(120, DEFAULT_MAX_RECV_TIMEOUT_S)).toBe(120)
    // 宿主注入一个更小的上限时，夹的就是那个
    expect(effectiveRecvBudget(120, 60)).toBe(60)
  })

  it('`0` / 负数 / 非有限**不是预算** —— 给 `null`，不是「立刻超时」', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveRecvBudget(bad, DEFAULT_MAX_RECV_TIMEOUT_S), String(bad)).toBeNull()
    }
  })

  it('上限本身坏掉时也给 `null`，不是「不限」', () => {
    expect(effectiveRecvBudget(120, 0)).toBeNull()
    expect(effectiveRecvBudget(120, Number.NaN)).toBeNull()
  })
})

describe('slowCallFrom · 报的是**真的用上的那个数**', () => {
  it('接上了出口 ⇒ 走出口，并回夹过的那个数', async () => {
    const seen: [string, number, unknown[]][] = []
    const slow = slowCallFrom(rec, (m, s, ...a) => {
      seen.push([m, s, a])
      return rec(m, ...a)
    })
    const got = await slow('BiasSpectr_Start', 3000, 1, 'grid_00')
    expect(seen).toEqual([['BiasSpectr_Start', 900, [1, 'grid_00']]])
    expect(got.recvTimeoutS).toBe(900)
    expect(got.record.method).toBe('BiasSpectr_Start')
  })

  it('**没接出口 ⇒ 照旧发，但如实报 `null`**（不谎称抬过）', async () => {
    const slow = slowCallFrom(rec, null)
    const got = await slow('BiasSpectr_Start', 300, 1, '')
    expect(got.recvTimeoutS).toBeNull()
    expect(got.record.values).toEqual([1])
  })

  it('预算不成立时也走原路、也报 `null`', async () => {
    const seen: string[] = []
    const slow = slowCallFrom(rec, (m, _s, ...a) => {
      seen.push(m)
      return rec(m, ...a)
    })
    const got = await slow('BiasSpectr_Start', 0, 1, '')
    expect(got.recvTimeoutS).toBeNull()
    expect(seen, '一个不成立的预算不该被下发').toEqual([])
  })

  it('只发**一次** —— 超时之后那次调用算发生了，重试等于再起一条扫掠', async () => {
    let n = 0
    const slow = slowCallFrom(
      (m, ...a) => {
        n += 1
        return Promise.resolve({ method: m, args: a, error: 'Timeout: 没回' })
      },
      null,
    )
    const got = await slow('BiasSpectr_Start', 300, 1, '')
    expect(n).toBe(1)
    // 而且 error **原样透传**（机器可判前缀不能被埋掉）
    expect(got.record.error).toBe('Timeout: 没回')
  })
})
