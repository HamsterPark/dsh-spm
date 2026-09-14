/**
 * 数值底座对 `spec/golden/numerics.json` —— **numpy/scipy 真跑出来的那一份**。
 *
 * 每一格的容差都来自被测函数自己的 docstring（`sumRelTol` / `convRelTol` /
 * `fftRelTol` / `lstsqRelTol` / `SSIM_ABS_TOL`），**不是在这里现挑的**。
 * 测试里出现一个字面量容差，就等于把那条理由从代码里搬到了测试里，
 * 而下一个人只会看见那个数。
 *
 * 三类各有各的比法：
 *
 * | | 比什么 |
 * |---|---|
 * | 字节 / 整数（`.npy`、连通域、histogram、percentile） | **逐位相等** |
 * | 求和类（mean/std/filter/fft/lstsq） | 相对差 ≤ 各自 docstring 写明的容差 |
 * | 随机算法（RANSAC、curve_fit） | 「离对的近、离错的远」/ 落进不确定域 |
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SSIM_ABS_TOL,
  Xoshiro128,
  convRelTol,
  curveFit,
  decodeNpy,
  fft,
  fft2,
  fftRelTol,
  fitPlane,
  fitPoly2d,
  gaussianFilter1d,
  gaussianFilter2d,
  histogram,
  ifft,
  labelConnected,
  laplace2d,
  lstsqObservedTol,
  lstsqRelTol,
  matFromRows,
  mean,
  median,
  percentile,
  phaseCrossCorrelation,
  ptp,
  ransacPlane,
  ssim,
  std,
  sum,
  sumRelTol,
} from './index.js'

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/numerics.json', import.meta.url)), 'utf8'),
) as Record<string, any>

/** 金样里的 `"NaN"` / `"Infinity"` 占位换回数（`allow_nan=False` 的代价）。 */
const num = (v: unknown): number =>
  v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : (v as number)

/** 相对差。两边都是 0 时给 0（而不是 NaN）。**只用在标量上**，见下面那段。 */
function relDiff(got: number, want: number): number {
  if (got === want) return 0
  const scale = Math.max(Math.abs(got), Math.abs(want))
  return scale === 0 ? 0 : Math.abs(got - want) / scale
}

/**
 * 一串数按容差比 —— **误差按整串的尺度归一，不按每个元素自己**。
 *
 * ## 这一条是写这份测试时被咬出来的
 *
 * 第一版对每个元素各算各的相对差，于是 15 格红了。查下去全是同一件事：
 * 高斯滤波第 62 个输出是 `0.0024`，而整条信号的尺度是 `1.48` —— 那个位置
 * 正好在过零点附近，绝对误差 `9e-17` 除以 `0.0024` 就成了 `3.9e-14`。
 * FFT 往返更极端：`n=61` 那一格逐元素相对差冲到 `2.5e-9`，而**绝对**误差只有
 * `1.4e-15`。
 *
 * 道理是线性算子的误差界本来就写在**输入的尺度**上：输出是输入的加权和，
 * 一个近零的输出是**相消**的结果，而相消毁掉相对精度、不毁绝对精度。
 * 对着一个由相消得来的小数字要求相对精度，是在要求一件不成立的事。
 *
 * **一个逐元素的相对比较不是容差，是抽签** —— 它红不红取决于那串数里
 * 有没有一个碰巧靠近零的。所以这里按 `max|want|` 归一。
 */
function expectCloseArray(got: ArrayLike<number>, want: readonly unknown[], tol: number, what: string): void {
  expect(got.length, `${what}: 长度`).toBe(want.length)
  const vals = want.map(num)
  const scale = Math.max(...vals.map(Math.abs), Number.MIN_VALUE)
  let worst = 0
  let at = -1
  for (let i = 0; i < vals.length; i += 1) {
    const d = Math.abs((got[i] as number) - (vals[i] as number)) / scale
    if (d > worst) {
      worst = d
      at = i
    }
  }
  expect(worst, `${what}: 最坏在第 ${at} 个（容差 ${tol.toExponential(2)}，按尺度 ${scale.toExponential(2)} 归一）`)
    .toBeLessThanOrEqual(tol)
}

// ── 统计 ───────────────────────────────────────────────────────────────────

describe('统计：容差来自成对求和与 Neumaier 的差', () => {
  for (const [name, g] of Object.entries(golden['stats'] as Record<string, any>)) {
    const input = (g.input as unknown[]).map(num)
    const tol = sumRelTol(input.length)

    it(`${name}：sum / mean / std / ptp`, () => {
      expect(relDiff(sum(input), num(g.sum)), 'sum').toBeLessThanOrEqual(tol)
      expect(relDiff(mean(input), num(g.mean)), 'mean').toBeLessThanOrEqual(tol)
      expect(relDiff(std(input, 0), num(g.std_ddof0)), 'std ddof=0').toBeLessThanOrEqual(tol)
      expect(relDiff(std(input, 1), num(g.std_ddof1)), 'std ddof=1').toBeLessThanOrEqual(tol)
      // ptp 是两个元素相减，没有累加 —— **逐位相等**
      expect(ptp(input)).toBe(num(g.ptp))
    })

    it(`${name}：percentile 的容差是 **0**`, () => {
      for (const [q, want] of Object.entries(g.percentile_linear as Record<string, unknown>)) {
        expect(percentile(input, Number(q)), `q=${q}`).toBe(num(want))
      }
      expect(median(input)).toBe(num(g.median))
    })
  }

  it('**三种求和算法给三个答案** —— 容差不是摆设，而它的理由在这里', () => {
    // 不拿随机那一串来证：那一串上三者碰巧一致（跑过，`d === 0`），
    // 而「碰巧一致」证不了任何事。用一个**必然分岔**的输入。
    const hard = [1e16, 1.0, -1e16]
    let naive = 0
    for (const v of hard) naive += v
    expect(naive, '朴素累加把那个 1 吃掉了').toBe(0)
    expect(sum(hard), 'pySum（Neumaier）留住了它').toBe(1)

    // 而在真实数据上，我们与 numpy 的差落在写明的容差里
    const g = golden['stats']['normal2048']
    const input = (g.input as unknown[]).map(num)
    expect(relDiff(sum(input), num(g.sum))).toBeLessThanOrEqual(sumRelTol(input.length))
  })

  it('histogram：左闭右开，**最后一个 bin 右边界也闭**', () => {
    const g = golden['histogram']
    const h = histogram((g.input as unknown[]).map(num), g.bins as number, g.range as [number, number])
    expect([...h.counts]).toEqual(g.counts)
    expect([...h.edges]).toEqual((g.edges as unknown[]).map(num))
    // 落在右端点上的那个样本进最后一个 bin —— 不是被丢掉
    expect(h.counts[2]).toBeGreaterThan(0)
  })

  it('空表给 NaN，不给 0', () => {
    expect(Number.isNaN(mean([]))).toBe(true)
    expect(Number.isNaN(std([]))).toBe(true)
    expect(Number.isNaN(ptp([]))).toBe(true)
  })

  it('percentile 的 q 是 0–100，不是 0–1 —— 传错了**抛**，不是给一个合理的数', () => {
    expect(() => percentile([1, 2, 3], 1.5)).not.toThrow()
    expect(() => percentile([1, 2, 3], 101)).toThrow(/0–100/)
    expect(() => percentile([1, 2, 3], -1)).toThrow(/0–100/)
  })
})

// ── 滤波 ───────────────────────────────────────────────────────────────────

describe('高斯滤波：五种边界模式各比一遍', () => {
  const g = golden['gauss1d']
  const input = (g.input as unknown[]).map(num)
  for (const c of g.cases as any[]) {
    it(`σ=${c.sigma} mode=${c.mode}`, () => {
      const got = gaussianFilter1d(input, c.sigma as number, c.mode, c.truncate as number)
      const k = 2 * Math.trunc((c.truncate as number) * (c.sigma as number) + 0.5) + 1
      expectCloseArray(got, c.output as unknown[], convRelTol(k), `gauss1d σ=${c.sigma} ${c.mode}`)
    })
  }

  it('**`reflect` 与 `mirror` 给的是不同的数** —— 两个库把这两个名字拧着用', () => {
    const cases = g.cases as any[]
    const a = cases.find((x) => x.sigma === 1.0 && x.mode === 'reflect')
    const b = cases.find((x) => x.sigma === 1.0 && x.mode === 'mirror')
    expect(num(a.output[0])).not.toBe(num(b.output[0]))
  })
})

describe('二维高斯与拉普拉斯', () => {
  for (const c of golden['gauss2d'].cases as any[]) {
    it(`gauss2d σ=${c.sigma} mode=${c.mode}`, () => {
      const m = matFromRows((golden['gauss2d'].input as unknown[][]).map((r) => r.map(num)))
      const got = gaussianFilter2d(m, c.sigma as number, c.mode, c.truncate as number)
      const k = 2 * Math.trunc((c.truncate as number) * (c.sigma as number) + 0.5) + 1
      // 二维 = 沿两轴各一次，误差界翻倍
      expectCloseArray(got.data, (c.output as unknown[][]).flat(), 2 * convRelTol(k), `gauss2d ${c.mode}`)
    })
  }

  for (const c of golden['laplace'].cases as any[]) {
    it(`laplace mode=${c.mode} —— 是 [1,−2,1] 沿轴相加，不是九点核`, () => {
      const m = matFromRows((golden['laplace'].input as unknown[][]).map((r) => r.map(num)))
      const got = laplace2d(m, c.mode)
      expectCloseArray(got.data, (c.output as unknown[][]).flat(), convRelTol(3) * 4, `laplace ${c.mode}`)
    })
  }
})

// ── FFT ────────────────────────────────────────────────────────────────────

describe('FFT：2 的幂走 radix-2，其余走 Bluestein', () => {
  for (const c of golden['fft1d'].cases as any[]) {
    const n = c.n as number
    it(`n=${n}${(n & (n - 1)) === 0 ? '（radix-2）' : '（Bluestein）'}`, () => {
      const sp = fft((c.input as unknown[]).map(num))
      // Bluestein 多绕一次长度 M 的卷积，容差按 M 走
      let m = 1
      while (m < 2 * n - 1) m <<= 1
      const tol = fftRelTol((n & (n - 1)) === 0 ? n : m)
      // 谱的幅度差很多，逐点相对差在近零的 bin 上没有意义 —— 按**谱的最大模**归一
      const scale = Math.max(...(c.re as unknown[]).map((v, i) => Math.hypot(num(v), num((c.im as unknown[])[i]))))
      let worst = 0
      for (let i = 0; i < n; i += 1) {
        const dr = Math.abs((sp.re[i] as number) - num((c.re as unknown[])[i]))
        const di = Math.abs((sp.im[i] as number) - num((c.im as unknown[])[i]))
        worst = Math.max(worst, Math.hypot(dr, di) / scale)
      }
      expect(worst, `n=${n} 最坏（容差 ${tol.toExponential(2)}）`).toBeLessThanOrEqual(tol)
    })

    it(`n=${n}：ifft(fft(x)) 回到 x`, () => {
      const input = (c.input as unknown[]).map(num)
      const back = ifft(fft(input))
      expectCloseArray(back.re, c.roundtrip as unknown[], fftRelTol(n) * 4, `roundtrip n=${n}`)
    })
  }

  it('fft2', () => {
    const g = golden['fft2d']
    const m = matFromRows((g.input as unknown[][]).map((r) => r.map(num)))
    const sp = fft2(m)
    const [rows, cols] = g.shape as [number, number]
    const scale = Math.max(
      ...(g.re as unknown[][]).flat().map((v, i) => Math.hypot(num(v), num((g.im as unknown[][]).flat()[i]))),
    )
    const wantRe = (g.re as unknown[][]).flat()
    const wantIm = (g.im as unknown[][]).flat()
    let worst = 0
    for (let i = 0; i < rows * cols; i += 1) {
      const dr = Math.abs((sp.re.data[i] as number) - num(wantRe[i]))
      const di = Math.abs((sp.im.data[i] as number) - num(wantIm[i]))
      worst = Math.max(worst, Math.hypot(dr, di) / scale)
    }
    expect(worst).toBeLessThanOrEqual(fftRelTol(rows * cols))
  })
})

describe('相位互相关：**峰位约定就是漂移方向的符号**', () => {
  for (const c of golden['xcorr'].cases as any[]) {
    const [dy, dx] = c.applied_roll as [number, number]
    it(`roll(+${dy}, +${dx}) ⇒ shift(${-dy}, ${-dx})`, () => {
      const ref = matFromRows((c.reference as unknown[][]).map((r) => r.map(num)))
      const mov = matFromRows((c.moving as unknown[][]).map((r) => r.map(num)))
      const { shift } = phaseCrossCorrelation(ref, mov)
      // 整像素位移**逐位相等**：它是一个下标，不是一个测量值。
      // `+ 0` 是为了把 `-0` 归一 —— `-dx` 在 dx=0 时是 `-0`，而 `Object.is(-0, 0)`
      // 为假。位移的符号是判据，位移**零**的符号不是。
      expect(shift.map((v) => v + 0)).toEqual((c.shift as unknown[]).map((v) => num(v) + 0))
      // 与 skimage 同一个约定：返回的是 −applied_roll
      expect(shift.map((v) => v + 0)).toEqual([-dy + 0, -dx + 0])
    })
  }

  it('**参数顺序反过来，符号就反过来** —— 一次写反不会报错，只会往反方向补偿', () => {
    const c = (golden['xcorr'].cases as any[])[0]
    const ref = matFromRows((c.reference as unknown[][]).map((r) => r.map(num)))
    const mov = matFromRows((c.moving as unknown[][]).map((r) => r.map(num)))
    const a = phaseCrossCorrelation(ref, mov).shift
    const b = phaseCrossCorrelation(mov, ref).shift
    expect(b).toEqual([-(a[0] as number), -(a[1] as number)])
  })
})

// ── 拟合 ───────────────────────────────────────────────────────────────────

describe('最小二乘：**两条容差各管一件事**', () => {
  for (const [name, key, fit] of [
    ['平面', 'plane', fitPlane],
    ['二维二次多项式', 'poly2d', fitPoly2d],
  ] as const) {
    const g = golden[key]
    const m = matFromRows((g.z as unknown[][]).map((r) => r.map(num)))
    const cond = num(g.cond)

    it(`${name}：落在**保证**里（64·κ²·eps，对任何设计矩阵成立）`, () => {
      expectCloseArray(fit(m), g.coef as unknown[], lstsqRelTol(cond), `${name}系数`)
    })

    it(`${name}：也落在**实测水平**里（4·κ·eps，没有平方）`, () => {
      // 只留上面那条的话这一格有六千倍余量，等于什么都没测。
      expectCloseArray(fit(m), g.coef as unknown[], lstsqObservedTol(cond), `${name}系数（紧）`)
    })
  }

  it('两条相差正好 **16·κ** 倍 —— 条件数越差，那条保证越松', () => {
    // 64κ²·eps / (4κ·eps) = 16κ。平面（κ=33.6）差 537 倍，
    // 多项式（κ=932）差 14900 倍 —— **病态的系统上那条保证几乎什么都不挡**，
    // 而那正是第二条必须存在的理由。
    for (const key of ['plane', 'poly2d'] as const) {
      const cond = num(golden[key].cond)
      expect(lstsqRelTol(cond) / lstsqObservedTol(cond), key).toBeCloseTo(16 * cond, 6)
    }
  })
})

describe('RANSAC：判据是「离对的近、离错的远」', () => {
  const g = golden['ransac']
  const m = matFromRows((g.z as unknown[][]).map((r) => r.map(num)))
  const clean = (g.coef_inliers_only as unknown[]).map(num)
  const dirty = (g.coef_all_points as unknown[]).map(num)

  it('把那 12 个 +50 甩掉了', () => {
    const r = ransacPlane(m, 0.5, { seed: 42, iterations: 300 })
    const dClean = Math.hypot(...r.coef.map((v, i) => v - (clean[i] as number)))
    const dDirty = Math.hypot(...r.coef.map((v, i) => v - (dirty[i] as number)))
    // 离「只用内点」的答案近，离「全都用上」的答案远 —— 后者被离群点拽走了
    expect(dClean).toBeLessThan(dDirty)
    expect(dClean).toBeLessThan(0.05)
  })

  it('内点掩膜认出了那 12 个离群点', () => {
    const r = ransacPlane(m, 0.5, { seed: 42, iterations: 300 })
    for (const i of g.outlier_index as number[]) expect(r.inliers[i], `第 ${i} 个应是离群点`).toBe(0)
  })

  it('**同一个种子给同一个答案** —— 不可复现的扣背景等于没扣', () => {
    const a = ransacPlane(m, 0.5, { seed: 7, iterations: 120 })
    const b = ransacPlane(m, 0.5, { seed: 7, iterations: 120 })
    expect([...a.coef]).toEqual([...b.coef])
    // 换个种子会动一点，但仍然落在内点那个答案附近
    const c = ransacPlane(m, 0.5, { seed: 8, iterations: 120 })
    expect(Math.hypot(...c.coef.map((v, i) => v - (clean[i] as number)))).toBeLessThan(0.05)
  })

  it('阈值**没有缺省值** —— 「多远算离群」只有调用方知道', () => {
    expect(() => ransacPlane(m, 0, { seed: 1 })).toThrow(/必须为正/)
    expect(() => ransacPlane(m, -1, { seed: 1 })).toThrow(/必须为正/)
  })
})

// ── 连通域 / SSIM ──────────────────────────────────────────────────────────

describe('连通域：**邻接数是语义，不是精度**', () => {
  const g = golden['label']
  const mask = matFromRows((g.mask as unknown[][]).map((r) => r.map(num)))

  it(`4-邻接 ⇒ ${g.count4} 个域`, () => {
    const r = labelConnected(mask, 4)
    expect(r.count).toBe(g.count4)
    expect([...r.labels]).toEqual((g.labels4 as unknown[][]).flat())
    expect([...r.sizes]).toEqual(g.sizes4)
  })

  it(`8-邻接 ⇒ ${g.count8} 个域（对角线连起来了）`, () => {
    const r = labelConnected(mask, 8)
    expect(r.count).toBe(g.count8)
    expect([...r.labels]).toEqual((g.labels8 as unknown[][]).flat())
    expect([...r.sizes]).toEqual(g.sizes8)
  })

  it('两者**给的是不同的答案** —— 默认用哪个不能含糊', () => {
    expect(g.count4).not.toBe(g.count8)
  })
})

describe('SSIM', () => {
  const g = golden['ssim']
  const a = matFromRows((g.a as unknown[][]).map((r) => r.map(num)))
  const b = matFromRows((g.b as unknown[][]).map((r) => r.map(num)))

  it('自己对自己 = 1', () => {
    expect(Math.abs(ssim(a, a, g.data_range as number, g.win_size as number) - num(g.ssim_self)))
      .toBeLessThanOrEqual(SSIM_ABS_TOL)
  })

  it('对加噪的那张', () => {
    expect(Math.abs(ssim(a, b, g.data_range as number, g.win_size as number) - num(g.ssim_ab)))
      .toBeLessThanOrEqual(SSIM_ABS_TOL)
  })

  it('`data_range` **必须显式给** —— 猜错它 SSIM 就只反映噪声', () => {
    expect(() => ssim(a, b, 0)).toThrow(/data_range/)
    expect(() => ssim(a, b, -1)).toThrow(/data_range/)
  })

  it('窗宽必须是奇数、且不大于短边', () => {
    expect(() => ssim(a, b, 1.0, 8)).toThrow(/奇数/)
    expect(() => ssim(a, b, 1.0, 101)).toThrow(/短边/)
  })
})

// ── .npy ───────────────────────────────────────────────────────────────────

describe('.npy 读：**对的是字节，没有容差**', () => {
  for (const c of golden['npy'].cases as any[]) {
    it(`${c.label}（v${c.version[0]}.${c.version[1]} ${c.dtype}${c.fortran_order ? ' F-order' : ''}）`, () => {
      const bytes = Uint8Array.from(Buffer.from(c.bytes_b64 as string, 'base64'))
      const arr = decodeNpy(bytes)
      expect([...arr.shape]).toEqual(c.shape)
      expect(arr.dtype).toBe(dtypeOf(c.dtype as string))
      // 逐位 —— float32 的值在 float64 里是精确的，没有舍入
      expect([...arr.values]).toEqual((c.values as unknown[]).map(num))
    })
  }

  it('**v2.0 的头长是 4 字节** —— 只认 v1.0 的读者会从错的偏移开始读', () => {
    const v1 = (golden['npy'].cases as any[]).find((c) => c.label === 'f8_2d_v1')
    const v2 = (golden['npy'].cases as any[]).find((c) => c.label === 'f8_2d_v2')
    const b1 = Uint8Array.from(Buffer.from(v1.bytes_b64, 'base64'))
    const b2 = Uint8Array.from(Buffer.from(v2.bytes_b64, 'base64'))
    expect(b1[6]).toBe(1)
    expect(b2[6]).toBe(2)
    // 同一份数据，两种封装，解出来必须一样
    expect([...decodeNpy(b1).values]).toEqual([...decodeNpy(b2).values])
  })

  it('**F-order 在读的那一刻就转回行优先** —— 不把歧义传给调用方', () => {
    const c = (golden['npy'].cases as any[]).find((x) => x.label === 'f8_fortran')
    const arr = decodeNpy(Uint8Array.from(Buffer.from(c.bytes_b64, 'base64')))
    expect([...arr.values]).toEqual((c.values as unknown[]).map(num))
  })

  it('坏输入**抛**，不给半份数据', () => {
    expect(() => decodeNpy(new Uint8Array(4))).toThrow(/太短/)
    expect(() => decodeNpy(new Uint8Array(40))).toThrow(/魔数/)
    const c = (golden['npy'].cases as any[])[0]
    const full = Uint8Array.from(Buffer.from(c.bytes_b64, 'base64'))
    // **截断的帧不补零**：补零之后图的下半截是一片「干净表面」
    expect(() => decodeNpy(full.slice(0, full.length - 8))).toThrow(/数据段短了/)
  })
})

function dtypeOf(npDtype: string): string {
  return { float64: '<f8', float32: '<f4', int32: '<i4' }[npDtype] ?? npDtype
}

// ── RNG ────────────────────────────────────────────────────────────────────

describe('xoshiro128**：判据是**可复现**', () => {
  it('同一个种子给同一串数', () => {
    const a = new Xoshiro128(2026)
    const b = new Xoshiro128(2026)
    const xs = Array.from({ length: 16 }, () => a.nextUint32())
    const ys = Array.from({ length: 16 }, () => b.nextUint32())
    expect(xs).toEqual(ys)
  })

  it('不同种子给不同串', () => {
    const a = new Xoshiro128(1)
    const b = new Xoshiro128(2)
    expect(a.nextUint32()).not.toBe(b.nextUint32())
  })

  it('`nextFloat` 落在 [0, 1)', () => {
    const r = new Xoshiro128(9)
    for (let i = 0; i < 2000; i += 1) {
      const v = r.nextFloat()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('`sample` 不重复、且都在范围内', () => {
    const r = new Xoshiro128(5)
    for (let t = 0; t < 50; t += 1) {
      const s = r.sample(20, 3)
      expect(new Set(s).size).toBe(3)
      for (const v of s) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(20)
      }
    }
  })

  it('抽的比池子大就抛', () => {
    expect(() => new Xoshiro128(1).sample(2, 3)).toThrow(/池子里只有/)
  })
})

// ── curve_fit ──────────────────────────────────────────────────────────────

describe('curve_fit：落进 scipy 的不确定域，而不是逐位相同', () => {
  const g = golden['curve_fit']
  const gauss = (x: number, p: Float64Array): number =>
    (p[0] as number) * Math.exp(-0.5 * ((x - (p[1] as number)) / (p[2] as number)) ** 2) + (p[3] as number)

  it('每个参数与 scipy 的差 < 5% 的 perr', () => {
    const r = curveFit(gauss, (g.x as unknown[]).map(num), (g.y as unknown[]).map(num), g.p0 as number[])
    const want = (g.popt as unknown[]).map(num)
    const perr = (g.perr as unknown[]).map(num)
    for (let i = 0; i < want.length; i += 1) {
      const d = Math.abs((r.params[i] as number) - (want[i] as number))
      expect(d, `参数 ${i}：差 ${d.toExponential(2)}，不确定度 ${(perr[i] as number).toExponential(2)}`)
        .toBeLessThan(0.05 * (perr[i] as number))
    }
  })

  it('**残差平方和不比 scipy 的差** —— 那才是被优化的那个量', () => {
    const r = curveFit(gauss, (g.x as unknown[]).map(num), (g.y as unknown[]).map(num), g.p0 as number[])
    expect(r.sse).toBeLessThanOrEqual(num(g.sse) * (1 + 1e-9))
  })

  it('收敛了就说收敛了', () => {
    const r = curveFit(gauss, (g.x as unknown[]).map(num), (g.y as unknown[]).map(num), g.p0 as number[])
    expect(r.converged).toBe(true)
    expect(r.iterations).toBeLessThan(200)
  })

  it('点数少于参数就抛 —— 不给一个「拟合出来的」欠定解', () => {
    expect(() => curveFit(gauss, [1, 2], [1, 2], [1, 1, 1, 1])).toThrow(/拟合不了/)
  })
})
