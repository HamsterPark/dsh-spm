/**
 * 中值滤波换了实现（不再整窗排序，见 `ndfilters.ts` 抬头），**输出必须逐位不变**。
 *
 * 这里留着旧实现作参照：原样抄自 2026-10-13 之前的 `ndfilters.ts`，连同它用的
 * `windowSpan` / `rankOfWindow`（抄进来而不 import：改那两个时参照不跟着变）。
 * 拿随机输入两边各跑一遍，逐元素比**原始的 64 位** —— −0 与 +0 分得开，NaN 的位型也要一样。
 * 输入专挑会出事的：NaN（从没有到大半个窗口，也有别的位型的 NaN）、±0、±∞、大量相等值、
 * 全 NaN 与全 ±0、五种边界模式、奇偶窗、比信号还宽的窗、空矩阵；外加几个怪尺寸
 * （非整数、≤ 1、NaN、±∞），和一个逼得快速选择落到整段排序的窗口。
 * 二维两百多万个窗口，其中一百万以上真的含 NaN（它们走排序那条路）；一维另有二十多万个。
 *
 * 容差 **0**：旧实现取的就是某一个输入元素，新实现必须取同一个。
 */
import { describe, expect, it } from 'vitest'
import { boundaryIndex, type BoundaryMode } from './filters.js'
import { matOf, type Mat } from './mat.js'
import { medianFilter1d, medianFilter2d } from './ndfilters.js'

// ── 参照：旧实现，逐字 ─────────────────────────────────────────────────────

function oldWindowSpan(size: number): { left: number; right: number } {
  const s = Math.trunc(size)
  const left = Math.floor(s / 2)
  return { left, right: s - left - 1 }
}

function oldRankOfWindow(n: number): number {
  return Math.floor(n / 2)
}

function oldMedianFilter1d(x: Float64Array | readonly number[], size: number, mode: BoundaryMode = 'reflect'): Float64Array {
  const n = x.length
  const out = new Float64Array(n)
  const s = Math.trunc(size)
  if (n === 0) return out
  if (s <= 1) {
    for (let i = 0; i < n; i += 1) out[i] = x[i] as number
    return out
  }
  const { left, right } = oldWindowSpan(s)
  const buf = new Float64Array(s)
  for (let i = 0; i < n; i += 1) {
    let w = 0
    for (let d = -left; d <= right; d += 1) {
      const k = boundaryIndex(i + d, n, mode)
      buf[w] = k === null ? 0 : (x[k] as number)
      w += 1
    }
    const sorted = Array.from(buf.subarray(0, w)).sort((a, b) => a - b)
    out[i] = sorted[oldRankOfWindow(w)] as number
  }
  return out
}

function oldMedianFilter2d(m: Mat, size: number, mode: BoundaryMode = 'reflect'): Mat {
  const s = Math.trunc(size)
  const out = new Float64Array(m.rows * m.cols)
  if (s <= 1) {
    out.set(m.data)
    return matOf(m.rows, m.cols, out)
  }
  const { left, right } = oldWindowSpan(s)
  const buf: number[] = []
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      buf.length = 0
      for (let dy = -left; dy <= right; dy += 1) {
        const ry = boundaryIndex(r + dy, m.rows, mode)
        for (let dx = -left; dx <= right; dx += 1) {
          const rx = boundaryIndex(c + dx, m.cols, mode)
          buf.push(ry === null || rx === null ? 0 : (m.data[ry * m.cols + rx] as number))
        }
      }
      const sorted = buf.slice().sort((a, b) => a - b)
      out[r * m.cols + c] = sorted[oldRankOfWindow(sorted.length)] as number
    }
  }
  return matOf(m.rows, m.cols, out)
}

// ── 输入 ───────────────────────────────────────────────────────────────────

const MODES: readonly BoundaryMode[] = ['reflect', 'nearest', 'constant', 'mirror', 'wrap']

/** xorshift32，固定种子：每次跑的都是同一批窗口。 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 2 ** 32
  }
}

/** NaN 的几种位型：规范的、带载荷的、负号的、信号 NaN、V8 拿来标数组空洞的那个。 */
const NAN_BITS: readonly bigint[] = [0x7ff8000000000000n, 0x7ff8000000000001n, 0xfff8000000000000n, 0x7ff0000000000001n, 0xfff7fffffff7ffffn]

/**
 * 一批值：`kind` 决定它们像什么 —— 连续值、小整数（大量相等）、带 ±0 的、带 ±∞ 的、
 * 两三个值反复出现的；再按 `nanRate` 撒 NaN（位型从 {@link NAN_BITS} 里挑）。
 */
function values(n: number, kind: number, nanRate: number, rand: () => number): Float64Array {
  const out = new Float64Array(n)
  const bits = new BigUint64Array(out.buffer)
  for (let i = 0; i < n; i += 1) {
    const u = rand()
    let v: number
    switch (kind) {
      case 0:
        v = (rand() - 0.5) * 1e-9
        break
      case 1:
        v = Math.floor(rand() * 7) - 3
        break
      case 2:
        v = u < 0.4 ? (rand() < 0.5 ? -0 : 0) : Math.floor(rand() * 5) - 2
        break
      case 3:
        v = u < 0.1 ? Infinity : u < 0.2 ? -Infinity : u < 0.3 ? (rand() < 0.5 ? -0 : 0) : (rand() - 0.5) * 4
        break
      default:
        v = [1.5, -2.25, -0, 0, 1.5][Math.floor(rand() * 5)] as number
    }
    if (rand() < nanRate) bits[i] = NAN_BITS[Math.floor(rand() * NAN_BITS.length)] as bigint
    else out[i] = v
  }
  return out
}

/** 二维里有几个窗口真的含 NaN（新实现里它们走排序那条路）。 */
function windowsWithNaN(m: Mat, size: number, mode: BoundaryMode): number {
  const { left, right } = oldWindowSpan(size)
  let count = 0
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      let found = false
      for (let dy = -left; dy <= right && !found; dy += 1) {
        const ry = boundaryIndex(r + dy, m.rows, mode)
        for (let dx = -left; dx <= right && !found; dx += 1) {
          const rx = boundaryIndex(c + dx, m.cols, mode)
          if (ry !== null && rx !== null && Number.isNaN(m.data[ry * m.cols + rx] as number)) found = true
        }
      }
      if (found) count += 1
    }
  }
  return count
}

function hex(a: Float64Array, i: number): string {
  return `0x${(new BigUint64Array(a.buffer, a.byteOffset + 8 * i, 1)[0] as bigint).toString(16).padStart(16, '0')}`
}

/** 逐元素比原始的 64 位。 */
function expectSameBits(got: Float64Array, want: Float64Array, what: string): void {
  expect(got.length, what).toBe(want.length)
  const g = new Uint32Array(got.buffer, got.byteOffset, 2 * got.length)
  const w = new Uint32Array(want.buffer, want.byteOffset, 2 * want.length)
  for (let i = 0; i < w.length; i += 1) {
    if (g[i] !== w[i]) {
      const e = i >> 1
      throw new Error(`${what}: element ${e} is ${got[e]} (${hex(got, e)}), the old implementation gave ${want[e]} (${hex(want, e)})`)
    }
  }
}

/** 数一数输出里的 −0 与 +0：±0 打平时取哪一个的那条规则真的被走到了。 */
function countZeros(a: Float64Array, tally: { neg: number; pos: number }): void {
  for (const v of a) {
    if (v === 0) {
      if (Object.is(v, -0)) tally.neg += 1
      else tally.pos += 1
    }
  }
}

/**
 * 一个逼得快速选择用完划分预算、落到整段排序的窗口（`ndfilters.ts` 的 `selectKth`）。
 *
 * 照 `selectKth` 的走法（枢轴取段首 / 段中 / 段尾三数之中，三路划分）模拟一遍，值不先定、
 * 用到才定（McIlroy 的「惰性对手」）：先让枢轴每轮是段里第二小，只削掉底下两个，直到
 * 中位数的位置挨着段底；再让它每轮是第二大，只削掉顶上两个。n = 49 时预算 16 轮，
 * 16 轮后段里还剩 17 个，于是整段排序。剩下那 17 个从没互相比过，值可以随便定：
 * 按窗口顺序第 j 个给 `middle(j)`（须在 (−26, 42) 里）。
 * 这是对 `selectKth` 走法的模拟：那边改了走法，这里要跟着改，否则这个窗口不再逼到那一步
 * （比对照样成立，只是不再覆盖那一行）。
 */
function adversarialWindow(n: number, middle: (j: number) => number): { values: Float64Array; rounds: number; left: number } {
  const k = Math.floor(n / 2)
  const budget = 2 * Math.ceil(Math.log2(n)) + 4
  const at = Array.from({ length: n }, (_, i) => i) // at[p]：位置 p 上是哪一项
  const rank: (number | undefined)[] = new Array<number | undefined>(n).fill(undefined)
  const swap = (p: number, q: number): void => {
    const t = at[p] as number
    at[p] = at[q] as number
    at[q] = t
  }
  let nextLow = 0
  let nextHigh = n - 1
  let lo = 0
  let hi = n - 1
  let rounds = 0
  while (hi - lo >= 16 && rounds < budget) {
    const mid = lo + ((hi - lo) >> 1)
    const bottom = k >= lo + 2
    if (bottom) {
      rank[at[lo] as number] = nextLow // 段里最小
      rank[at[mid] as number] = nextLow + 1 // 枢轴：第二小
      nextLow += 2
    } else {
      rank[at[mid] as number] = nextHigh - 1 // 枢轴：第二大
      rank[at[hi] as number] = nextHigh // 最大
      nextHigh -= 2
    }
    const pr = rank[at[mid] as number] as number
    // 还没定的项：削底时都比枢轴大，削顶时都比枢轴小
    const cmp = (item: number): number => {
      const r = rank[item]
      if (r === undefined) return bottom ? 1 : -1
      return r < pr ? -1 : r > pr ? 1 : 0
    }
    let lt = lo
    let gt = hi
    let i = lo
    while (i <= gt) {
      const c = cmp(at[i] as number)
      if (c < 0) {
        swap(i, lt)
        lt += 1
        i += 1
      } else if (c > 0) {
        swap(i, gt)
        gt -= 1
      } else {
        i += 1
      }
    }
    if (k < lt) hi = lt - 1
    else if (k > gt) lo = gt + 1
    else throw new Error('the adversary let the pivot land on the median')
    rounds += 1
  }
  // 定值：削掉的底下那些是负的、顶上那些是正的，中间的照 middle
  const out = new Float64Array(n)
  let j = 0
  for (let item = 0; item < n; item += 1) {
    const r = rank[item]
    if (r === undefined) {
      out[item] = middle(j)
      j += 1
    } else {
      out[item] = r < nextLow ? r - n : r + 1
    }
  }
  return { values: out, rounds, left: hi - lo + 1 }
}

const NAN_RATES = [0, 0.004, 0.05, 0.3, 0.8] as const

describe('the median filters give exactly what the old implementation gave', () => {
  it('2-D: every mode, odd and even sizes, every kind of value, NaN from none to most', () => {
    const rand = rng(20261013)
    let windows = 0
    const zeros = { neg: 0, pos: 0 }
    const shapes: readonly (readonly [number, number])[] = [[1, 1], [1, 9], [7, 1], [5, 6], [11, 13], [24, 19], [40, 33]]
    for (let rep = 0; rep < 3; rep += 1) {
      for (const [rows, cols] of shapes) {
        for (let kind = 0; kind < 5; kind += 1) {
          const rate = NAN_RATES[(rep + kind) % NAN_RATES.length] as number
          const m = matOf(rows, cols, values(rows * cols, kind, rate, rand))
          for (const mode of MODES) {
            // 旧实现每个窗口都整个排序，宽窗贵：只在第一遍跑
            for (const size of rep === 0 ? [2, 3, 4, 5, 6, 7, 9] : [2, 3, 4, 5]) {
              const got = medianFilter2d(m, size, mode).data
              expectSameBits(got, oldMedianFilter2d(m, size, mode).data, `${rows}x${cols} kind ${kind} NaN ${rate} ${mode} size ${size}`)
              windows += got.length
              countZeros(got, zeros)
            }
          }
        }
      }
    }
    // 宽窗：visual-memory 的中值背景用到 15 × 15
    for (const size of [15, 16]) {
      for (let kind = 0; kind < 5; kind += 1) {
        for (const mode of MODES) {
          const m = matOf(30, 27, values(30 * 27, kind, kind === 3 ? 0.002 : 0, rand))
          const got = medianFilter2d(m, size, mode).data
          expectSameBits(got, oldMedianFilter2d(m, size, mode).data, `30x27 kind ${kind} ${mode} size ${size}`)
          windows += got.length
          countZeros(got, zeros)
        }
      }
    }
    expect(windows).toBeGreaterThan(700_000)
    expect(zeros.neg).toBeGreaterThan(5000)
    expect(zeros.pos).toBeGreaterThan(5000)
  }, 120_000)

  it('2-D: over a million windows that hold NaN (the sorted path), NaN of several bit patterns', () => {
    const rand = rng(1013)
    let windows = 0
    let withNaN = 0
    for (let rep = 0; rep < 6; rep += 1) {
      for (const rate of [0.05, 0.15, 0.3, 0.5, 0.8]) {
        for (let kind = 0; kind < 5; kind += 1) {
          const m = matOf(40, 33, values(40 * 33, kind, rate, rand))
          for (const mode of MODES) {
            for (const size of [2, 3]) {
              expectSameBits(medianFilter2d(m, size, mode).data, oldMedianFilter2d(m, size, mode).data, `NaN ${rate} kind ${kind} ${mode} size ${size}`)
              windows += 40 * 33
              withNaN += windowsWithNaN(m, size, mode)
            }
          }
        }
      }
    }
    expect(windows).toBeGreaterThan(1_900_000)
    expect(withNaN).toBeGreaterThan(1_000_000)
  }, 120_000)

  it('1-D: every mode, sizes up to wider than the signal, NaN, ±0, ±∞ and ties', () => {
    const rand = rng(7)
    let windows = 0
    for (let rep = 0; rep < 12; rep += 1) {
      for (const n of [1, 2, 3, 8, 17, 64]) {
        for (let kind = 0; kind < 5; kind += 1) {
          const x = values(n, kind, NAN_RATES[(rep + kind + n) % NAN_RATES.length] as number, rand)
          for (const mode of MODES) {
            for (const size of [2, 3, 4, 5, 8, 11, 20, 70]) {
              expectSameBits(medianFilter1d(x, size, mode), oldMedianFilter1d(x, size, mode), `n ${n} kind ${kind} ${mode} size ${size}`)
              windows += n
            }
          }
        }
      }
    }
    // 普通数组也收（tip-change 传的是 Float64Array，类型上两样都行）
    const plain = Array.from(values(40, 2, 0.1, rand))
    for (const mode of MODES) expectSameBits(medianFilter1d(plain, 5, mode), oldMedianFilter1d(plain, 5, mode), `number[] ${mode}`)
    expect(windows).toBeGreaterThan(200_000)
  }, 120_000)

  it('all-NaN, all ±0, a single element, empty matrices and signals', () => {
    for (const mode of MODES) {
      for (const size of [2, 3, 4]) {
        const nan = matOf(4, 5, values(20, 0, 1, rng(size)))
        expectSameBits(medianFilter2d(nan, size, mode).data, oldMedianFilter2d(nan, size, mode).data, `all NaN ${mode} ${size}`)
        const zeros = matOf(3, 3, [-0, 0, -0, 0, -0, -0, 0, 0, -0])
        expectSameBits(medianFilter2d(zeros, size, mode).data, oldMedianFilter2d(zeros, size, mode).data, `±0 ${mode} ${size}`)
        expectSameBits(medianFilter1d([-0], size, mode), oldMedianFilter1d([-0], size, mode), `[-0] ${mode} ${size}`)
        for (const [rows, cols] of [[0, 5], [5, 0], [0, 0]] as const) {
          const empty = matOf(rows, cols, [])
          expectSameBits(medianFilter2d(empty, size, mode).data, oldMedianFilter2d(empty, size, mode).data, `${rows}x${cols} ${mode} ${size}`)
        }
        expectSameBits(medianFilter1d([], size, mode), oldMedianFilter1d([], size, mode), `[] ${mode} ${size}`)
      }
    }
  })

  it('odd sizes: non-integer, at most 1, NaN and infinite, like before', () => {
    const x = values(9, 1, 0.2, rng(3))
    const m = matOf(3, 3, x)
    for (const size of [1.9, 2.5, 3.99, 1, 0, -4, Number.NaN, -Infinity]) {
      expectSameBits(medianFilter1d(x, size), oldMedianFilter1d(x, size), `1-D size ${size}`)
      expectSameBits(medianFilter2d(m, size).data, oldMedianFilter2d(m, size).data, `2-D size ${size}`)
    }
    // an infinite size: the 1-D buffer cannot be allocated (RangeError), the 2-D windows are empty (NaN)
    expect(() => oldMedianFilter1d(x, Infinity)).toThrow(RangeError)
    expect(() => medianFilter1d(x, Infinity)).toThrow(RangeError)
    expectSameBits(medianFilter2d(m, Infinity).data, oldMedianFilter2d(m, Infinity).data, '2-D size Infinity')
    const empty = matOf(0, 4, [])
    expectSameBits(medianFilter2d(empty, Infinity).data, oldMedianFilter2d(empty, Infinity).data, '0x4 size Infinity')
  })

  it('a window that runs the selection out of partition rounds (the whole-segment sort), ±0 included', () => {
    const middles: readonly ((j: number) => number)[] = [
      (j) => (j % 4 === 1 ? 0 : j % 4 === 3 ? 0.25 * j : -0),
      (j) => 0.5 + j,
      (j) => [3, 1, 3, 2][j % 4] as number,
    ]
    for (const middle of middles) {
      const { values: win, rounds, left } = adversarialWindow(49, middle)
      expect([rounds, left]).toEqual([16, 17])
      const m = matOf(7, 7, win)
      for (const mode of MODES) {
        expectSameBits(medianFilter2d(m, 7, mode).data, oldMedianFilter2d(m, 7, mode).data, `adversarial ${mode}`)
      }
    }
    // the centre window is the whole matrix; its median is the first zero in window order (a −0)
    const { values: win } = adversarialWindow(49, middles[0] as (j: number) => number)
    const centre = medianFilter2d(matOf(7, 7, win), 7, 'constant').data[24]
    expect(Object.is(centre, -0)).toBe(true)
    expect(Object.is(win.find((v) => v === 0), -0)).toBe(true)
  })

  it('still takes the upper median of an even window (rank = ⌊n/2⌋)', () => {
    // scipy: median_filter([0,9,1,2,8,3,4,5], size=4, mode='reflect')
    expect(Array.from(medianFilter1d([0, 9, 1, 2, 8, 3, 4, 5], 4, 'reflect'))).toEqual([9, 1, 2, 8, 3, 4, 5, 5])
    // a 2 x 2 window over [[1, 2], [3, 4]] at (1, 1) holds 1, 2, 3, 4: the upper median is 3
    expect(Array.from(medianFilter2d(matOf(2, 2, [1, 2, 3, 4]), 2, 'nearest').data)).toEqual([1, 2, 3, 3])
  })
})
