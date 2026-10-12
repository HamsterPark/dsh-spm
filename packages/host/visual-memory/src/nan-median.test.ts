/**
 * `nanMedian` no longer sorts (see flatten.ts); its result must not change by a single bit.
 *
 * The implementation before 2026-10-13 is kept here verbatim as the reference. Random
 * inputs go through both and the raw 64 bits of the results are compared, so −0 and +0
 * are told apart. The inputs are chosen where a shortcut would slip: many ±0 (the stable
 * sort keeps zeros in input order, a typed-array sort puts −0 first), ±Infinity and NaN
 * (both filtered), heavy ties, values near overflow (the even mean `(a + b) / 2` may
 * overflow) and subnormals; odd and even counts; `number[]`, Float64Array, Float32Array
 * and subarray inputs, as the callers pass them.
 */
import { describe, expect, it } from 'vitest'
import { nanMedian } from './flatten.js'

/** The implementation before 2026-10-13, verbatim. */
function oldNanMedian(values: ArrayLike<number>): number {
  const fin: number[] = []
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] as number
    if (Number.isFinite(v)) fin.push(v)
  }
  if (fin.length === 0) return NaN
  fin.sort((a, b) => a - b)
  const h = fin.length >> 1
  return fin.length % 2 === 1 ? (fin[h] as number) : ((fin[h - 1] as number) + (fin[h] as number)) / 2
}

/** xorshift32 with a fixed seed: every run sees the same inputs. */
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

const KINDS = 7

/** One value of a given kind; `special` is the chance of NaN / ±Infinity instead. */
function value(kind: number, special: number, rand: () => number): number {
  const u = rand()
  if (u < special) {
    const w = rand()
    return w < 0.5 ? Number.NaN : w < 0.75 ? Infinity : -Infinity
  }
  switch (kind) {
    case 0:
      return (rand() - 0.5) * 1e-9
    case 1:
      return Math.floor(rand() * 7) - 3
    case 2:
      return rand() < 0.6 ? (rand() < 0.5 ? -0 : 0) : Math.floor(rand() * 5) - 2
    case 3:
      return rand() < 0.5 ? (rand() < 0.5 ? -0 : 0) : rand() < 0.5 ? 1 : -1
    case 4:
      return [1.5, -2.25, -0, 0, 1.5][Math.floor(rand() * 5)] as number
    case 5:
      return (rand() < 0.5 ? -1 : 1) * (rand() < 0.5 ? 1.6e308 : 5e-324 * Math.floor(1 + rand() * 4))
    default:
      return rand() < 0.3 ? (rand() < 0.5 ? -0 : 0) : (rand() - 0.5) * 2e-300
  }
}

const bitsBuffer = new Float64Array(1)
const bitsView = new BigUint64Array(bitsBuffer.buffer)

function bitsOf(x: number): bigint {
  bitsBuffer[0] = x
  return bitsView[0] as bigint
}

function expectSameBits(input: ArrayLike<number>, what: string): number {
  const got = nanMedian(input)
  const want = oldNanMedian(input)
  if (bitsOf(got) !== bitsOf(want)) {
    throw new Error(`${what}: nanMedian gave ${Object.is(got, -0) ? '-0' : got}, the old one ${Object.is(want, -0) ? '-0' : want} for [${Array.from(input, (v) => (Object.is(v, -0) ? '-0' : String(v))).join(', ')}]`)
  }
  return got
}

describe('nanMedian gives exactly what the sorting version gave', () => {
  it('short inputs: every kind, odd and even counts, ±0, ±Infinity and NaN', () => {
    const rand = rng(20261013)
    let cases = 0
    let zeroResults = 0
    let negativeZeroResults = 0
    let evenBothZero = 0
    for (let rep = 0; rep < 15000; rep += 1) {
      for (let kind = 0; kind < KINDS; kind += 1) {
        const n = Math.floor(rand() * 41)
        const special = [0, 0.05, 0.3, 0.9][rep % 4] as number
        const xs = Array.from({ length: n }, () => value(kind, special, rand))
        const got = expectSameBits(xs, `number[${n}] kind ${kind}`)
        expectSameBits(Float64Array.from(xs), `Float64Array(${n}) kind ${kind}`)
        cases += 2
        if (got === 0) {
          zeroResults += 1
          if (Object.is(got, -0)) negativeZeroResults += 1
          const fin = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
          if (fin.length % 2 === 0 && fin[fin.length / 2 - 1] === 0) evenBothZero += 1
        }
      }
    }
    expect(cases).toBe(210_000)
    // the signed-zero rule is really exercised, in both parities
    expect(zeroResults).toBeGreaterThan(20_000)
    expect(negativeZeroResults).toBeGreaterThan(5_000)
    expect(evenBothZero).toBeGreaterThan(5_000)
  })

  it('longer inputs, Float32Array frames and row subarrays', () => {
    const rand = rng(7)
    for (let rep = 0; rep < 300; rep += 1) {
      const kind = rep % KINDS
      const n = 41 + Math.floor(rand() * 3000)
      const xs = Float64Array.from({ length: n }, () => value(kind, rep % 3 === 0 ? 0.2 : 0, rand))
      expectSameBits(xs, `Float64Array(${n}) kind ${kind}`)
      expectSameBits(Float32Array.from(xs), `Float32Array(${n}) kind ${kind}`)
      expectSameBits(xs.subarray(7, 7 + (n >> 1)), `subarray of ${n} kind ${kind}`)
    }
    for (const kind of [0, 2, 6]) {
      const frame = Float32Array.from({ length: 512 * 512 }, () => value(kind, 0.01, rand))
      expectSameBits(frame, `512 x 512 frame kind ${kind}`)
      expectSameBits(frame.subarray(0, 512 * 512 - 1), `512 x 512 - 1 values kind ${kind}`)
    }
  })

  it('takes the zero the stable sort took, where a typed-array sort would flip it', () => {
    // a typed-array sort gives [-0, 0, 0]: middle +0; the stable sort keeps [0, -0, 0]: middle -0
    expect(Object.is(nanMedian([0, -0, 0]), -0)).toBe(true)
    // stable [0, -0, -0, 0]: middles -0, -0 -> -0; typed [-0, -0, 0, 0]: -0, 0 -> +0
    expect(Object.is(nanMedian([0, -0, -0, 0]), -0)).toBe(true)
    // the same with filtered values in between
    expect(Object.is(nanMedian([Number.NaN, 0, Infinity, -0, -Infinity, 0]), -0)).toBe(true)
    expect(Object.is(nanMedian([-0, 0, 0]), 0)).toBe(true)
    // the even mean overflows exactly as before
    expect(nanMedian([1.6e308, 1.7e308])).toBe(Infinity)
    expect(nanMedian([])).toBeNaN()
    expect(nanMedian([Number.NaN, Infinity, -Infinity])).toBeNaN()
  })
})
