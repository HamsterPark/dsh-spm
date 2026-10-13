/**
 * radix-2 核换成「按长度缓存的旋转因子表 + 原地蝶形」之后，**一位都没变**。
 *
 * 两份旧实现原样留在这里当 oracle（`Object.is` 逐个比）：
 * - numerics 从前的 `radix2`（每只蝶形现算 `Math.cos/sin(ang·k)`），连同建在它上面的
 *   Bluestein —— 对 `fft` / `ifft` / `fft2` / `ifft2`；
 * - visual-memory `register.ts` 从前自带的那一份（`fft1` / `fft2`，就是现在的核）——
 *   对 `fftInPlace` / `fft2InPlace`。
 *
 * 为什么两份能逐位相同，写在 `fft.ts` 的 `Radix2Plan` 上。这里只负责把它钉住：
 * 长度覆盖 2 的幂与非 2 的幂（Bluestein 内部用同一个核），数据里放了 ±0、极大极小与 NaN。
 */
import { describe, expect, it } from 'vitest'
import { fft, fft2, fft2InPlace, fftInPlace, ifft, ifft2, type Complex } from './fft.js'
import { matOf, type Mat } from './mat.js'

// ── oracle 1：numerics 从前的 radix-2 与 Bluestein，原样 ──────────────────────

function oldRadix2(reIn: Float64Array, imIn: Float64Array, inverse: boolean): Complex {
  const n = reIn.length
  const re = Float64Array.from(reIn)
  const im = Float64Array.from(imIn)
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

function oldBluestein(reIn: Float64Array, imIn: Float64Array, inverse: boolean): Complex {
  const n = reIn.length
  let m = 1
  while (m < 2 * n - 1) m <<= 1
  const sign = inverse ? 1 : -1
  const cosT = new Float64Array(n)
  const sinT = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
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
  const fa = oldRadix2(ar, ai, false)
  const fb = oldRadix2(br, bi, false)
  const cr = new Float64Array(m)
  const ci = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    cr[i] = (fa.re[i] as number) * (fb.re[i] as number) - (fa.im[i] as number) * (fb.im[i] as number)
    ci[i] = (fa.re[i] as number) * (fb.im[i] as number) + (fa.im[i] as number) * (fb.re[i] as number)
  }
  const conv = oldRadix2(cr, ci, true)
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

function oldDft(re: Float64Array, im: Float64Array, inverse: boolean): Complex {
  const n = re.length
  if (n === 0) return { re: new Float64Array(0), im: new Float64Array(0) }
  if (n === 1) return { re: Float64Array.from(re), im: Float64Array.from(im) }
  return (n & (n - 1)) === 0 ? oldRadix2(re, im, inverse) : oldBluestein(re, im, inverse)
}

/** 从前的二维：沿一个轴逐条做 `oldDft`（与 `fft.ts` 的 `alongAxis` 同序）。 */
function oldAlongAxis(re: Mat, im: Mat, axis: 0 | 1, inverse: boolean): { re: Float64Array; im: Float64Array } {
  const { rows, cols } = re
  const outRe = new Float64Array(rows * cols)
  const outIm = new Float64Array(rows * cols)
  const n = axis === 0 ? rows : cols
  const outer = axis === 0 ? cols : rows
  for (let o = 0; o < outer; o += 1) {
    const br = new Float64Array(n)
    const bi = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      const idx = axis === 0 ? i * cols + o : o * cols + i
      br[i] = re.data[idx] as number
      bi[i] = im.data[idx] as number
    }
    const f = oldDft(br, bi, inverse)
    for (let i = 0; i < n; i += 1) {
      const idx = axis === 0 ? i * cols + o : o * cols + i
      outRe[idx] = f.re[i] as number
      outIm[idx] = f.im[i] as number
    }
  }
  return { re: outRe, im: outIm }
}

// ── oracle 2：visual-memory register.ts 从前自带的那一份，原样 ─────────────────

interface OldPlan {
  readonly n: number
  readonly cos: Float64Array
  readonly sin: Float64Array
  readonly rev: Uint32Array
}

function oldPlan(n: number): OldPlan {
  const half = n >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let k = 0; k < half; k += 1) {
    cos[k] = Math.cos((2 * Math.PI * k) / n)
    sin[k] = Math.sin((2 * Math.PI * k) / n)
  }
  const rev = new Uint32Array(n)
  const bits = Math.round(Math.log2(n))
  for (let i = 0; i < n; i += 1) {
    let r = 0
    for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  return { n, cos, sin, rev }
}

function oldFft1(re: Float64Array, im: Float64Array, p: OldPlan, inverse: boolean): void {
  const n = p.n
  for (let i = 0; i < n; i += 1) {
    const j = p.rev[i] as number
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
    const half = len >> 1
    const step = n / len
    for (let k = 0; k < half; k += 1) {
      const wr = p.cos[k * step] as number
      const wi = sign * (p.sin[k * step] as number)
      for (let a = k; a < n; a += len) {
        const b = a + half
        const br = re[b] as number
        const bi = im[b] as number
        const xr = br * wr - bi * wi
        const xi = br * wi + bi * wr
        const ar = re[a] as number
        const ai = im[a] as number
        re[b] = ar - xr
        im[b] = ai - xi
        re[a] = ar + xr
        im[a] = ai + xi
      }
    }
  }
}

function oldFft2(re: Float64Array, im: Float64Array, rows: number, cols: number, inverse: boolean): void {
  const pr = oldPlan(cols)
  const lr = new Float64Array(cols)
  const li = new Float64Array(cols)
  for (let r = 0; r < rows; r += 1) {
    lr.set(re.subarray(r * cols, (r + 1) * cols))
    li.set(im.subarray(r * cols, (r + 1) * cols))
    oldFft1(lr, li, pr, inverse)
    re.set(lr, r * cols)
    im.set(li, r * cols)
  }
  const pc = oldPlan(rows)
  const B = Math.min(16, cols)
  const cr = Array.from({ length: B }, () => new Float64Array(rows))
  const ci = Array.from({ length: B }, () => new Float64Array(rows))
  for (let c0 = 0; c0 < cols; c0 += B) {
    const nb = Math.min(B, cols - c0)
    for (let r = 0; r < rows; r += 1) {
      const o = r * cols + c0
      for (let j = 0; j < nb; j += 1) {
        ;(cr[j] as Float64Array)[r] = re[o + j] as number
        ;(ci[j] as Float64Array)[r] = im[o + j] as number
      }
    }
    for (let j = 0; j < nb; j += 1) oldFft1(cr[j] as Float64Array, ci[j] as Float64Array, pc, inverse)
    for (let r = 0; r < rows; r += 1) {
      const o = r * cols + c0
      for (let j = 0; j < nb; j += 1) {
        re[o + j] = (cr[j] as Float64Array)[r] as number
        im[o + j] = (ci[j] as Float64Array)[r] as number
      }
    }
  }
}

// ── 数据与比对 ─────────────────────────────────────────────────────────────

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

/** 随机数，夹几个特殊值：±0、极大、极小（乘出次正规数）、偶尔一个 NaN。 */
function data(n: number, rnd: () => number, specials: boolean): Float64Array {
  const out = Float64Array.from({ length: n }, () => rnd() * 10 ** Math.round(rnd() * 8))
  if (specials && n > 6) {
    out[1] = -0
    out[2] = 0
    out[3] = 1e300
    out[4] = -1e-300
    if (n > 40) out[n - 2] = Number.NaN
  }
  return out
}

/** 第一处不是同一个 double 的位置；-1 表示逐位相同。 */
function firstDiff(got: ArrayLike<number>, want: ArrayLike<number>): number {
  expect(got.length).toBe(want.length)
  for (let i = 0; i < want.length; i += 1) if (!Object.is(got[i], want[i])) return i
  return -1
}

const LENGTHS = [
  ...Array.from({ length: 70 }, (_, i) => i + 1),
  96, 100, 128, 255, 256, 257, 500, 512, 1000, 1024, 2048, 4095, 4096,
]

describe('radix-2 核：缓存的旋转因子表与从前现算的逐位相同', () => {
  it('fft 与 ifft，长度 1…70 与若干大长度（2 的幂走核，其余走建在核上的 Bluestein）', () => {
    const rnd = seeded(20261013)
    for (const n of LENGTHS) {
      for (const specials of [false, true]) {
        const re = data(n, rnd, specials)
        const im = data(n, rnd, false)
        const want = oldDft(re, im, false)
        const got = fft(re, im)
        expect(firstDiff(got.re, want.re), `fft re n=${n}`).toBe(-1)
        expect(firstDiff(got.im, want.im), `fft im n=${n}`).toBe(-1)
        const back = oldDft(want.re, want.im, true)
        for (let i = 0; i < n; i += 1) {
          back.re[i] = (back.re[i] as number) / n
          back.im[i] = (back.im[i] as number) / n
        }
        const gotBack = ifft(want)
        expect(firstDiff(gotBack.re, back.re), `ifft re n=${n}`).toBe(-1)
        expect(firstDiff(gotBack.im, back.im), `ifft im n=${n}`).toBe(-1)
      }
    }
  })

  it('fft2 先行后列、ifft2 先列后行再除 —— 与从前同序同值', () => {
    const rnd = seeded(7)
    for (const [rows, cols] of [[1, 1], [1, 8], [8, 1], [4, 8], [16, 32], [5, 7], [12, 10], [64, 64], [3, 128]] as const) {
      const m = matOf(rows, cols, data(rows * cols, rnd, true))
      const zero = matOf(rows, cols, new Float64Array(rows * cols))
      const a = oldAlongAxis(m, zero, 1, false)
      const want = oldAlongAxis(matOf(rows, cols, a.re), matOf(rows, cols, a.im), 0, false)
      const got = fft2(m)
      expect(firstDiff(got.re.data, want.re), `fft2 re ${rows}x${cols}`).toBe(-1)
      expect(firstDiff(got.im.data, want.im), `fft2 im ${rows}x${cols}`).toBe(-1)
      const b0 = oldAlongAxis(got.re, got.im, 0, true)
      const b1 = oldAlongAxis(matOf(rows, cols, b0.re), matOf(rows, cols, b0.im), 1, true)
      const n = rows * cols
      const back = ifft2(got)
      expect(firstDiff(back.re.data, b1.re.map((v) => v / n)), `ifft2 re ${rows}x${cols}`).toBe(-1)
      expect(firstDiff(back.im.data, b1.im.map((v) => v / n)), `ifft2 im ${rows}x${cols}`).toBe(-1)
    }
  })
})

describe('原地入口：与 register.ts 从前自带的那一份逐位相同', () => {
  it('fftInPlace：长度 1…4096 的 2 的幂，正反两向', () => {
    const rnd = seeded(11)
    for (let n = 1; n <= 4096; n *= 2) {
      for (const inverse of [false, true]) {
        const re = data(n, rnd, true)
        const im = data(n, rnd, false)
        const wantRe = Float64Array.from(re)
        const wantIm = Float64Array.from(im)
        oldFft1(wantRe, wantIm, oldPlan(n), inverse)
        fftInPlace(re, im, inverse)
        expect(firstDiff(re, wantRe), `re n=${n} inverse=${inverse}`).toBe(-1)
        expect(firstDiff(im, wantIm), `im n=${n} inverse=${inverse}`).toBe(-1)
      }
    }
  })

  it('fft2InPlace：行列都是 2 的幂（列数跨过 16 列一块的分块），正反两向', () => {
    const rnd = seeded(12)
    for (const [rows, cols] of [[1, 1], [1, 4], [4, 1], [2, 8], [8, 16], [16, 32], [32, 64], [128, 8], [64, 256]] as const) {
      for (const inverse of [false, true]) {
        const re = data(rows * cols, rnd, true)
        const im = data(rows * cols, rnd, false)
        const wantRe = Float64Array.from(re)
        const wantIm = Float64Array.from(im)
        oldFft2(wantRe, wantIm, rows, cols, inverse)
        fft2InPlace(re, im, rows, cols, inverse)
        expect(firstDiff(re, wantRe), `re ${rows}x${cols} inverse=${inverse}`).toBe(-1)
        expect(firstDiff(im, wantIm), `im ${rows}x${cols} inverse=${inverse}`).toBe(-1)
      }
    }
  })

  it('正变换与 fft2 逐位相同；长度不是 2 的幂、形状不对时拒绝', () => {
    const rnd = seeded(13)
    const re = data(16 * 32, rnd, false)
    const im = new Float64Array(16 * 32)
    const want = fft2(matOf(16, 32, re))
    fft2InPlace(re, im, 16, 32)
    expect(firstDiff(re, want.re.data)).toBe(-1)
    expect(firstDiff(im, want.im.data)).toBe(-1)
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6))).toThrow(RangeError)
    expect(() => fftInPlace(new Float64Array(4), new Float64Array(2))).toThrow(RangeError)
    expect(() => fft2InPlace(new Float64Array(12), new Float64Array(12), 3, 4)).toThrow(RangeError)
    expect(() => fft2InPlace(new Float64Array(8), new Float64Array(8), 4, 4)).toThrow(RangeError)
  })
})
