/**
 * 批 7a-3 的两件数值底座对 `spec/golden/batch7a3.json` 的逐格比对。
 *
 * | 节 | 对的是 | 容差 |
 * |---|---|---|
 * | `np_grid` | `np.linspace` / `np.digitize` / `np.histogram(bins=<边界数组>)` / `np.gradient`（二维） | **0** |
 * | `mt19937` | **CPython 的 `random`**（不是 numpy） | **0，字节级** |
 *
 * 两节全部逐位相等 —— 它们输出的要么是整数（下标、计数、位串），
 * 要么是一串照抄了运算顺序的浮点。**给它们容差等于把一次「挑错了格子」藏起来。**
 *
 * ⚠️ `mt19937` 那一节里有三条**只能由金样确认**的 CPython 实现细节
 * （整数种子怎么变成 key、`getrandbits` 取高位还是低位、`_randbelow` 的
 * `k = n.bit_length()`）—— 见 `mt19937.ts` 的抬头。这里不手写期望值，
 * 全部从那台解释器里录出来。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { argsortDesc, digitize, gradient2dUniform, histogramFromEdges, linspace } from './np-grid.js'
import { matFromRows } from './mat.js'
import { PyRandom } from './mt19937.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/batch7a3.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const NPG = GOLDEN['np_grid'] as Record<string, any[]>

describe('np.linspace —— 末项**直接置 stop**，不是 `n·step + start`', () => {
  for (const c of NPG['linspace'] as any[]) {
    it(`${c.start} → ${c.stop} / ${c.num}`, () => {
      expect([...linspace(c.start as number, c.stop as number, c.num as number)]).toEqual(c.out)
    })
  }
})

describe('np.digitize —— 左闭右开（`x === bins[k]` 落进 k+1）', () => {
  for (const c of NPG['digitize'] as any[]) {
    it(`x=${c.x}`, () => {
      expect(digitize(c.x as number, c.bins as number[])).toBe(c.out)
    })
  }
})

describe('np.histogram(bins=<边界数组>) —— searchsorted 那条路', () => {
  for (const c of NPG['histogram_edges'] as any[]) {
    it('counts 逐格相等（NaN 与区间外都不计，末格右闭）', () => {
      const samples = (c.samples as unknown[]).map((v) => (v === 'NaN' ? NaN : (v as number)))
      expect([...histogramFromEdges(samples, c.edges as number[])]).toEqual(c.counts)
    })
  }
})

describe('np.argsort(v)[::-1] —— 从大到小的下标', () => {
  for (const c of NPG['argsort_desc'] as any[]) {
    it(JSON.stringify(c.v), () => {
      expect([...argsortDesc(c.v as number[])]).toEqual(c.out)
    })
  }
})

describe('np.gradient（二维、间距 1、edge_order=1）', () => {
  for (const [i, c] of (NPG['gradient2d'] as any[]).entries()) {
    it(`第 ${i} 格（${c.rows}×${c.cols}）`, () => {
      const m = matFromRows(c.m as number[][])
      const [gy, gx] = gradient2dUniform(m)
      expect(rows(gy.data, c.cols as number)).toEqual(c.gy)
      expect(rows(gx.data, c.cols as number)).toEqual(c.gx)
    })
  }
  it('轴长不足 2 时抛（同 numpy 的 ValueError）', () => {
    expect(() => gradient2dUniform(matFromRows([[1, 2, 3]]))).toThrow(RangeError)
    expect(() => gradient2dUniform(matFromRows([[1], [2], [3]]))).toThrow(RangeError)
  })
})

function rows(data: Float64Array, cols: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < data.length; i += cols) out.push([...data.subarray(i, i + cols)])
  return out
}

describe('CPython 的 random.Random —— MT19937 四层', () => {
  for (const c of GOLDEN['mt19937'] as any[]) {
    const seed = c.seed as number
    it(`seed=${seed}：原始 32 位流`, () => {
      const r = new PyRandom(seed)
      expect(Array.from({ length: (c.raw32 as number[]).length }, () => r.nextUint32())).toEqual(c.raw32)
    })
    it(`seed=${seed}：random() 的 53 位双精度`, () => {
      const r = new PyRandom(seed)
      expect(Array.from({ length: (c.random as number[]).length }, () => r.random())).toEqual(c.random)
    })
    it(`seed=${seed}：getrandbits(2) 取的是**高**两位`, () => {
      const r = new PyRandom(seed)
      expect(Array.from({ length: (c.getrandbits2 as number[]).length }, () => r.getrandbits(2))).toEqual(
        c.getrandbits2,
      )
    })
    it(`seed=${seed}：_randbelow(2) 的 k = n.bit_length()（**不是** (n−1)）`, () => {
      const r = new PyRandom(seed)
      expect(Array.from({ length: (c.randbelow2 as number[]).length }, () => r.randbelow(2))).toEqual(
        c.randbelow2,
      )
    })
    it(`seed=${seed}：_randbelow(7) 的拒绝重采样`, () => {
      const r = new PyRandom(seed)
      expect(Array.from({ length: (c.randbelow7 as number[]).length }, () => r.randbelow(7))).toEqual(
        c.randbelow7,
      )
    })
    it(`seed=${seed}：uniform(a, b) = a + (b−a)·random()`, () => {
      const r = new PyRandom(seed)
      expect(Array.from({ length: (c.uniform as number[]).length }, () => r.uniform(0.004, 0.02))).toEqual(
        c.uniform,
      )
    })
    it(`seed=${seed}：choice((-1, 1))`, () => {
      const r = new PyRandom(seed)
      expect(Array.from({ length: (c.choice as number[]).length }, () => r.choice([-1.0, 1.0]))).toEqual(
        c.choice,
      )
    })
    it(`seed=${seed}：uniform × choice 交替消耗（BiasWiggle 里那一串）`, () => {
      const r = new PyRandom(seed)
      expect(
        Array.from({ length: (c.mixed as number[]).length }, () => r.uniform(0.004, 0.02) * r.choice([-1.0, 1.0])),
      ).toEqual(c.mixed)
    })
  }
})
