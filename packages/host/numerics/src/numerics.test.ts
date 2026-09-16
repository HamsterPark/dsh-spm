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
  type BoundaryMode,
  type FindPeaksOptions,
  type InterpMode,
  type Mat,
  HANNING_REL_TOL,
  MAX_POLYORDER,
  PEAK_WIDTH_REL_TOL,
  Pcg64,
  generateState32,
  generateState64,
  npMean,
  npStd,
  npSum,
  seedEntropy,
  seedSequencePool,
  SSIM_ABS_TOL,
  Xoshiro128,
  boundaryIndex,
  convRelTol,
  correlate2d,
  correlate2dRelTol,
  crossSE,
  curveFit,
  decodeNpy,
  fft,
  fft2,
  fftRelTol,
  findPeaks,
  fitPlane,
  fitPoly2d,
  gaussianFilter1d,
  gaussianFilter2d,
  greyClosing,
  greyDilation,
  greyErosion,
  greyOpening,
  hanning,
  hanningWindow2d,
  histogram,
  ifft,
  interpRelTol,
  labelConnected,
  laplace2d,
  lstsqObservedTol,
  lstsqRelTol,
  mapCoordinates,
  matAt,
  matFromRows,
  matZeros,
  mean,
  median,
  pcovRelTol,
  percentile,
  phaseCrossCorrelation,
  polyfit,
  polyval,
  ptp,
  ransacPlane,
  rectSE,
  savgolCoeffs,
  savgolCoeffsRelTol,
  savgolFilter,
  savgolObservedTol,
  savgolRelTol,
  shiftImage,
  ssim,
  std,
  sum,
  sumRelTol,
  xcorrErrorSqAbsTol,
  xcorrPhaseAbsTol,
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

/**
 * 两个角之间的最短距离（弧度）。
 *
 * **`+π` 与 `−π` 是同一个角**，而一个朴素的减法会在那里报出 `2π` 的差 ——
 * 于是「相位对上了」这条判据会在它最该说话的那一格（`b = −a`）红得毫无道理。
 */
function angleDiff(got: number, want: number): number {
  const d = got - want
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)))
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

// ── 灰度形态学 ─────────────────────────────────────────────────────────────

describe('灰度形态学：**没有算术，所以没有容差**', () => {
  const g = golden['morphology']
  const img = matFromRows((g.input as unknown[][]).map((r) => r.map(num)))
  const seOf = (c: any) =>
    c.kind === 'rect' ? rectSE((c.size as number[])[0] as number, (c.size as number[])[1] as number) : crossSE((c.footprint as unknown[][]).length)

  for (const c of g.cases as any[]) {
    const tag = `${c.kind}${c.size ? ' ' + (c.size as number[]).join('×') : ''} ${c.mode}`
    it(`${tag}：腐蚀 / 膨胀 / 开 / 闭逐位相等`, () => {
      const se = seOf(c)
      const m = c.mode as BoundaryMode
      expect([...greyErosion(img, se, m).data], `${tag} 腐蚀`).toEqual((c.erosion as unknown[][]).flat().map(num))
      expect([...greyDilation(img, se, m).data], `${tag} 膨胀`).toEqual((c.dilation as unknown[][]).flat().map(num))
      expect([...greyOpening(img, se, m).data], `${tag} 开`).toEqual((c.opening as unknown[][]).flat().map(num))
      expect([...greyClosing(img, se, m).data], `${tag} 闭`).toEqual((c.closing as unknown[][]).flat().map(num))
    })
  }

  it('`crossSE` 造出来的掩膜与金样里 scipy 收到的 footprint 一模一样', () => {
    for (const c of g.cases as any[]) {
      if (c.kind !== 'cross3' && c.kind !== 'cross5') continue
      const fp = c.footprint as number[][]
      expect([...(crossSE(fp.length).mask as Uint8Array)], c.kind).toEqual(fp.flat())
    }
  })

  it('**腐蚀的窗口偏左上、膨胀的偏右下** —— 偶数结构元才看得出来', () => {
    // 一条 1×6、中间挖了一个坑。结构元 1×4，原点 ox = 4>>1 = 2。
    // 腐蚀窗口 [c−2, c+1]（前 2 后 1）⇒ 坑在 c=2 时波及 c ∈ [1, 4]。
    const dip = matFromRows([[1, 1, 0, 1, 1, 1]])
    expect([...greyErosion(dip, rectSE(1, 4), 'nearest').data]).toEqual([1, 0, 0, 0, 0, 1])
    // 膨胀先把结构元翻过来，原点变 4−1−2 = 1，窗口 [c−1, c+2]（前 1 后 2）
    // ⇒ 峰在 c=2 时波及 c ∈ [0, 3]。**不翻的话这里会是 [0, 1, 1, 1, 1, 0]。**
    const peak = matFromRows([[0, 0, 1, 0, 0, 0]])
    expect([...greyDilation(peak, rectSE(1, 4), 'nearest').data]).toEqual([1, 1, 1, 1, 0, 0])
  })

  it('开运算削掉比结构元窄的亮条，宽的留下 —— `Destripe_MorphOpen` 要的就是这个', () => {
    // 宽 1 的亮条（c=1）与宽 4 的亮台（c=5..8），结构元 1×3
    const bar = matFromRows([[0, 5, 0, 0, 0, 5, 5, 5, 5, 0]])
    const opened = [...greyOpening(bar, rectSE(1, 3), 'nearest').data]
    expect(opened[1], '宽 1 的条被削掉').toBe(0)
    expect(opened.slice(6, 8), '宽 4 的台留下').toEqual([5, 5])
  })

  it('结构元的形状自己先讲道理', () => {
    expect(() => rectSE(0, 3)).toThrow(/正整数/)
    expect(() => rectSE(3, 1.5)).toThrow(/正整数/)
    expect(() => crossSE(4)).toThrow(/正奇数/)
  })
})

// ── 重采样 ─────────────────────────────────────────────────────────────────

describe('重采样：`order=0` 没有容差，`order=1` 只有 8 eps', () => {
  const g = golden['interp']
  const img = matFromRows((g.input as unknown[][]).map((r) => r.map(num)))
  const [rowC, colC] = (g.coords as unknown[][]).map((a) => a.map(num))

  for (const c of g.map_coordinates as any[]) {
    const order = c.order as number
    if (order !== 0 && order !== 1) continue
    it(`map_coordinates order=${order} mode=${c.mode}`, () => {
      const got = mapCoordinates(img, rowC as number[], colC as number[], order, c.mode as InterpMode)
      expectCloseArray(got, c.output as unknown[], interpRelTol(order), `mc order=${order} ${c.mode}`)
    })
  }

  for (const c of g.shift as any[]) {
    const order = c.order as number
    if (order !== 0 && order !== 1) continue
    const [sr, sc] = c.shift as [number, number]
    it(`shift order=${order} s=(${sr}, ${sc})`, () => {
      const got = shiftImage(img, sr, sc, order, c.mode as InterpMode)
      expectCloseArray(got.data, (c.output as unknown[][]).flat(), interpRelTol(order), `shift ${order} ${sr},${sc}`)
    })
  }

  it('**而且逐位相等** —— 这一条比上面那些容差严，它是用来报警的', () => {
    // 保证是 8 eps，实测是 0。留着这条零容差的孪生档，是因为写这一版时
    // `order=1 / reflect` 超差 1.09 倍，而真因是折叠算错了、不是界推紧了 ——
    // 当场揪出来的正是同族里零容差的 `order=0 / mirror`。
    for (const c of g.map_coordinates as any[]) {
      if (c.order !== 1) continue
      const got = mapCoordinates(img, rowC as number[], colC as number[], 1, c.mode as InterpMode)
      expect([...got], `mc order=1 ${c.mode}`).toEqual((c.output as unknown[]).map(num))
    }
    for (const c of g.shift as any[]) {
      if (c.order !== 1) continue
      const [sr, sc] = c.shift as [number, number]
      const got = shiftImage(img, sr, sc, 1, c.mode as InterpMode)
      expect([...got.data], `shift order=1 (${sr}, ${sc})`).toEqual((c.output as unknown[][]).flat().map(num))
    }
  })

  it('`order ≥ 2` **抛**，并且说清为什么不近似', () => {
    for (const bad of [2, 3, 5]) {
      expect(() => mapCoordinates(img, [0], [0], bad as 0 | 1)).toThrow(/样条预滤波/)
      expect(() => shiftImage(img, 1, 1, bad as 0 | 1)).toThrow(/样条预滤波/)
    }
  })

  it('行列坐标个数对不上就抛 —— 少一个不是「补一个」', () => {
    expect(() => mapCoordinates(img, [0, 1], [0], 1)).toThrow(/对不上/)
  })

  // ── 三条特意为了「能分辨」而加的探针 ──

  for (const c of g.edge_probe.cases as any[]) {
    const order = c.order as number
    if (order !== 0 && order !== 1) continue
    it(`界外判据 order=${order} mode=${c.mode}`, () => {
      const [pr, pc] = (g.edge_probe.coords as unknown[][]).map((a) => a.map(num))
      const got = mapCoordinates(img, pr as number[], pc as number[], order, c.mode as InterpMode, c.cval as number)
      expectCloseArray(got, c.output as unknown[], interpRelTol(order), `edge ${order} ${c.mode}`)
    })
  }

  it('**`constant` 的界外是严格的**：`x = 11` 给真值，`x = 11.001` 给 cval', () => {
    const [pr, pc] = (g.edge_probe.coords as unknown[][]).map((a) => a.map(num))
    const at = (x: number): number => (pr as number[]).indexOf(x)
    const got = mapCoordinates(img, pr as number[], pc as number[], 1, 'constant', -99)
    // rows = 12 ⇒ n−1 = 11。整点在界内，再多 0.001 就整个点作废 —— 中间没有过渡带。
    expect(got[at(11)], 'x = 11').not.toBe(-99)
    expect(got[at(11.001)], 'x = 11.001').toBe(-99)
    expect(got[at(-0.001)], 'x = −0.001').toBe(-99)
    expect(got[at(0)], 'x = 0').not.toBe(-99)
  })

  it('**`order=0` 是四舍五入，不是就近偶数** —— 这两条只有半整数分得开', () => {
    const [pr, pc] = (g.round_probe.coords as unknown[][]).map((a) => a.map(num))
    const got = mapCoordinates(img, pr as number[], pc as number[], 0, 'nearest')
    expect([...got]).toEqual((g.round_probe.output_order0 as unknown[]).map(num))
    // 0.5 → 1 而不是 0，2.5 → 3 而不是 2。就近偶数会给第 0 行与第 2 行。
    const col = (pc as number[])[0] as number
    expect(got[0], '0.5 → 第 1 行').toBe(matAt(img, 1, col))
    expect(got[2], '2.5 → 第 3 行').toBe(matAt(img, 3, col))
  })

  it('**`wrap` 在插值族里周期是 n−1，在滤波族里是 n** —— 同名不同义', () => {
    const row = matFromRows([[0, 1, 2, 3]])
    // 插值族：3.5 越过 n−1=3 ⇒ 折成 0.5 ⇒ 在 a[0]=0 与 a[1]=1 之间 ⇒ 0.5
    expect(mapCoordinates(row, [0], [3.5], 1, 'wrap')[0]).toBe(0.5)
    // 滤波族的 wrap 是周期 4：下标 4 折回 0。两者在这里就是 0.5 对 1.5。
    expect(boundaryIndex(4, 4, 'wrap')).toBe(0)
  })
})

// ── 亚像素相位互相关 ───────────────────────────────────────────────────────

describe('亚像素相位互相关：**答案是 k/uf，所以容差是 0**', () => {
  const cases = golden['subpixel'].cases as any[]
  const matOfCase = (rows: unknown[][]): Mat => matFromRows(rows.map((r) => r.map(num)))

  for (const c of cases) {
    const uf = c.upsample_factor as number
    const what = c.kind === 'integer_roll'
      ? `整像素 roll(${(c.applied_roll as number[]).join(', ')})`
      : c.kind === 'near_flat'
        ? '几乎平坦的一对帧'
        : `真亚像素 shift(${(c.applied_shift as number[]).join(', ')})`
    it(`${what} @ uf=${uf} ⇒ (${(c.shift as number[]).join(', ')})`, () => {
      const { shift } = phaseCrossCorrelation(matOfCase(c.reference), matOfCase(c.moving), uf)
      // 逐位相等：两边做的是同样两次「整数 ÷ uf」再相加，IEEE 除法是正确舍入的。
      // 会分岔的只有 argmax 挑了哪一格，而那种分岔一跳就是整整 1/uf。
      expect(shift.map((v) => v + 0)).toEqual((c.shift as unknown[]).map((v) => num(v) + 0))
    })
  }

  it('**输出恒为 1/uf 的整数倍** —— 调用方判「漂没漂」必须自己设阈值', () => {
    for (const c of cases) {
      const uf = c.upsample_factor as number
      const { shift } = phaseCrossCorrelation(matOfCase(c.reference), matOfCase(c.moving), uf)
      for (const v of shift) {
        // v 本来就是 k/uf，于是「量化再算一遍」是个恒等式 —— 不用挑容差就能断言。
        expect(Math.round(v * uf) / uf, `uf=${uf} 的 ${v}`).toBe(v)
      }
    }
  })

  it('`uf = 1` 与不传等价 —— 默认档没有被亚像素那条路改掉', () => {
    const c = cases[0]
    const ref = matOfCase(c.reference)
    const mov = matOfCase(c.moving)
    expect(phaseCrossCorrelation(ref, mov, 1).shift).toEqual(phaseCrossCorrelation(ref, mov).shift)
  })

  it('`upsampleFactor` 必须是 ≥ 1 的整数 —— 2.5 倍上采样没有意义', () => {
    const c = cases[0]
    const ref = matOfCase(c.reference)
    const mov = matOfCase(c.moving)
    expect(() => phaseCrossCorrelation(ref, mov, 0)).toThrow(/upsampleFactor/)
    expect(() => phaseCrossCorrelation(ref, mov, 2.5)).toThrow(/upsampleFactor/)
  })

  it('**一张常数图会报出一个纯属虚构的位移** —— 这条测试是把那个坑钉在这里', () => {
    // 常数图的互功率谱除直流外**恒为 0**，于是相关面是平的：每一格一样大。
    // argmax 在一个全平的面上只会挑第 0 格，而第 0 格 = −dftshift/uf。
    // 这不是我们的 bug，是这个算法本身的形状（skimage 同样如此）——
    // 所以调用方**必须**先看峰有多尖，不能拿返回值直接当漂移。
    const flat = matFromRows(Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => 1)))
    // 整像素档没有这个问题：第 0 格就是 (0, 0)，「没漂」。
    expect(phaseCrossCorrelation(flat, flat).shift.map((v) => v + 0)).toEqual([0, 0])
    for (const uf of [2, 4, 10]) {
      const fiction = -Math.trunc(Math.ceil(uf * 1.5) / 2) / uf // = −dftshift/uf
      expect(phaseCrossCorrelation(flat, flat, uf).shift, `uf=${uf}`).toEqual([fiction, fiction])
    }
  })

  it('**几乎平坦的一对帧，skimage 给的也是一个虚构的位移** —— 归一化的分母由它定', () => {
    // `near_flat` 那两格金样就是为这件事录的：谱里除直流外全是 1e−22 量级的噪声，
    // 而 `100·eps ≈ 2.2e−14`。分母写 `|·|` 还是 `max(|·|, 100·eps)`，
    // **只有这种帧分得开**，其余每一格金样两种写法都过。
    //
    // 答案由 skimage 定，不由我们推理定 —— 我们推理过一版（「压住噪声会更准」），
    // 而探针当场证明对一次精确 roll 反而是不压的更准：dust 也带着同样的相位。
    const flat = (golden['subpixel'].cases as any[]).filter((c) => c.kind === 'near_flat')
    expect(flat.length, '金样里得有这一格').toBeGreaterThan(0)
    for (const c of flat) {
      // 两张本该「没漂」的帧，skimage 报的是 (5, 5)。这不是 bug，是这个算法的形状：
      // 相位互相关把每个频点都归一化成单位模长，于是**没有信号的地方噪声说了算**。
      expect(num((c.shift as unknown[])[0]), '虚构的位移不是 0').not.toBe(0)
    }
  })
})

// ── find_peaks ─────────────────────────────────────────────────────────────

describe('find_peaks：**下标与 prominence 的容差都是 0**', () => {
  const cases = golden['peaks'].cases as any[]
  const caseOf = (label: string): any => {
    const c = cases.find((x) => x.label === label)
    expect(c, `金样里得有 ${label} 这一格`).toBeDefined()
    return c
  }

  for (const c of cases) {
    const args = c.args as FindPeaksOptions
    it(`${c.label} ${JSON.stringify(args)}`, () => {
      const x = (c.input as unknown[]).map(num)
      const got = findPeaks(x, args)
      // 峰是**下标**（整数）—— 一个「差不多的下标」不是精度问题，是另一个峰
      expect([...got.peaks], `${c.label} peaks`).toEqual(c.peaks)

      if (c.prominences === null) {
        expect(got.prominences, '没要 prominence ⇒ null，不是空表').toBeNull()
      } else {
        // `x[peak] − max(left_min, right_min)`：两个操作数都是输入里的元素原样，
        // 中间只有一次减法 ⇒ **逐位**
        expect([...(got.prominences as Float64Array)], `${c.label} prominences`)
          .toEqual((c.prominences as unknown[]).map(num))
        expect([...(got.leftBases as Int32Array)], `${c.label} left_bases`).toEqual(c.left_bases)
        expect([...(got.rightBases as Int32Array)], `${c.label} right_bases`).toEqual(c.right_bases)
      }

      if (c.widths === null) {
        expect(got.widths, '没要 width ⇒ null').toBeNull()
      } else {
        // **保证**那一条：至多 5 次舍入 ⇒ 8·eps
        expectCloseArray(got.widths as Float64Array, c.widths as unknown[], PEAK_WIDTH_REL_TOL, `${c.label} widths`)
        expectCloseArray(got.widthHeights as Float64Array, c.width_heights as unknown[], PEAK_WIDTH_REL_TOL, `${c.label} width_heights`)
        expectCloseArray(got.leftIps as Float64Array, c.left_ips as unknown[], PEAK_WIDTH_REL_TOL, `${c.label} left_ips`)
        expectCloseArray(got.rightIps as Float64Array, c.right_ips as unknown[], PEAK_WIDTH_REL_TOL, `${c.label} right_ips`)
      }
    })
  }

  it('**宽度那一族实测也是逐位相等** —— 零容差的孪生，它替有容差的那档报警', () => {
    // 保证是 8·eps，而运算顺序照抄 scipy ⇒ 实测 0。同 `interpolate.ts` 那一对：
    // 有容差的那一档报不出来的事，零容差的那一档会替它喊。
    for (const c of cases) {
      if (c.widths === null) continue
      const got = findPeaks((c.input as unknown[]).map(num), c.args as FindPeaksOptions)
      expect([...(got.widths as Float64Array)], `${c.label} widths 逐位`)
        .toEqual((c.widths as unknown[]).map(num))
      expect([...(got.leftIps as Float64Array)], `${c.label} left_ips 逐位`)
        .toEqual((c.left_ips as unknown[]).map(num))
      expect([...(got.rightIps as Float64Array)], `${c.label} right_ips 逐位`)
        .toEqual((c.right_ips as unknown[]).map(num))
    }
  })

  it('**`distance` 在 `prominence` 之前筛** —— 反过来是另一个答案，而两个都合法', () => {
    const both = caseOf('order_probe_both')
    const promOnly = caseOf('order_probe_prom_only')
    // 同一条信号：scipy 的顺序给 [8]，prominence 先筛给 [1, 8]。
    // **这一格是唯一分得开两种顺序的输入** —— 别处两种顺序同解。
    expect(both.peaks, 'scipy 的顺序').toEqual([8])
    expect(promOnly.peaks, '只筛 prominence').toEqual([1, 8])
    expect(both.peaks).not.toEqual(promOnly.peaks)
    const x = (both.input as unknown[]).map(num)
    expect([...findPeaks(x, both.args as FindPeaksOptions).peaks]).toEqual(both.peaks)
  })

  it('**`distance` 真的在筛** —— 同一张直方图，不筛它就多一个卫星峰', () => {
    const withD = caseOf('hist_modes')
    const noD = caseOf('hist_modes_no_distance')
    expect(noD.peaks.length, '不筛 distance 多一个').toBe(withD.peaks.length + 1)
    for (const c of [withD, noD]) {
      expect([...findPeaks((c.input as unknown[]).map(num), c.args as FindPeaksOptions).peaks])
        .toEqual(c.peaks)
    }
  })

  it('**prominence 取两侧最小值的 `max` 不是 `min`** —— 肩上的小凸起不该和主峰一样突出', () => {
    const c = caseOf('prominence_side')
    const x = (c.input as unknown[]).map(num)
    const got = findPeaks(x, { prominence: 0 })
    // 下标 3：左侧走到 0.5 停、右侧走到 0.2 停。max ⇒ 0.9−0.5 = 0.4；min ⇒ 0.7。
    const at = [...got.peaks].indexOf(3)
    expect(at, '下标 3 得是一个峰').toBeGreaterThanOrEqual(0)
    expect((got.prominences as Float64Array)[at]).toBeCloseTo(0.4, 12)
    expect((got.prominences as Float64Array)[at]).not.toBeCloseTo(0.7, 6)
  })

  it('**平台取中点向下取整，末尾的极大值不算峰** —— 旧仓两端补零就是为了后半句', () => {
    const p = caseOf('plateau')
    expect(p.peaks, '平台 [2,4]⇒3、[7,8]⇒7；末尾的 5 不是峰').toEqual([3, 7])
    expect([...findPeaks((p.input as unknown[]).map(num)).peaks]).toEqual([3, 7])
    const e = caseOf('plateau_even')
    // 四格宽的平台 [1,4] ⇒ (1+4)>>1 = 2。向上取整会给 3 —— **只有偶数宽的平台分得开**
    expect(e.peaks).toEqual([2])
    expect([...findPeaks((e.input as unknown[]).map(num)).peaks]).toEqual([2])
  })

  it('`distance < 1` 抛 —— 一个「最小间隔 0」的条件不是不筛，是没意义', () => {
    expect(() => findPeaks([0, 1, 0], { distance: 0 })).toThrow(/distance/)
    expect(() => findPeaks([0, 1, 0], { distance: -3 })).toThrow(/distance/)
  })

  it('没要的属性是 `null` 不是空表 —— 「没算」和「算出来是空的」不是一回事', () => {
    const r = findPeaks([0, 1, 0])
    expect(r.prominences).toBeNull()
    expect(r.widths).toBeNull()
    const s = findPeaks([0, 1, 0], { prominence: 0 })
    expect(s.prominences).not.toBeNull()
    expect(s.widths).toBeNull()
    // 一条没有峰的信号：peaks 是**空表**，而属性仍然是算过的（空的）
    const t = findPeaks([0, 0, 0], { prominence: 0 })
    expect([...t.peaks]).toEqual([])
    expect(t.prominences).not.toBeNull()
  })
})

// ── correlate2d / hanning ──────────────────────────────────────────────────

describe('correlate2d(mode=same)：**整数那几格没有容差**', () => {
  const rowsOf = (v: unknown[][]): Mat => matFromRows(v.map((r) => r.map(num)))
  for (const c of golden['correlate2d'].cases as any[]) {
    it(`${c.label}${c.exact ? '（逐位）' : '（容差 convRelTol(taps)）'}`, () => {
      const a = rowsOf(c.a as unknown[][])
      const b = rowsOf(c.b as unknown[][])
      const got = correlate2d(a, b)
      expect([got.rows, got.cols], '输出形状 = **a** 的形状').toEqual([a.rows, a.cols])
      const want = (c.out as unknown[][]).flat()
      if (c.exact === true) {
        // 小整数：乘积与部分和都在 2⁵³ 以内 ⇒ 浮点加法在整数上是精确的
        expect([...got.data], `${c.label} 逐位`).toEqual(want.map(num))
      } else {
        expectCloseArray(got.data, want, correlate2dRelTol(b), c.label as string)
      }
    })
  }

  it('**偶数核的原点是 `(Mb−1)>>1`，而本仓形态学的是 `Mb>>1`** —— 差一格', () => {
    // 一张只有一个 1 的图 × 一个只有 b[0][0] 不为零的 4×4 核。
    // out[i][j] = a[i − oy][j − ox] ⇒ 那个 1 落在 (3+oy, 3+ox)。
    const a = matZeros(7, 7)
    a.data[3 * 7 + 3] = 1
    const b = matZeros(4, 4)
    b.data[0] = 1
    const out = correlate2d(a, b)
    const at = [...out.data].indexOf(1)
    expect([Math.floor(at / 7), at % 7], 'oy = (4−1)>>1 = 1').toEqual([4, 4])
    // `Mb>>1 = 2`（`grey_erosion` 的约定，见上面那条形态学测试）会给 (5, 5)。
    // 两个都是 scipy、两个都叫「中心」—— 而奇数核上它们完全同解。
    expect(out.data[5 * 7 + 5], '不是 (5,5)').toBe(0)
  })

  it('**它是相关不是卷积** —— 非对称核上两者给不同的图', () => {
    const a = matFromRows([[0, 0, 0], [0, 1, 0], [0, 0, 0]])
    const b = matFromRows([[1, 2, 3]])            // 1×3，原点 ox = 1
    // 相关：out[i][j] = Σ_l a[i][j+l−1]·b[0][l] ⇒ 中间那一行是 [3, 2, 1]。
    // 卷积（翻核）会给 [1, 2, 3]。
    expect([...correlate2d(a, b).data.slice(3, 6)], '核不翻 ⇒ 反着落').toEqual([3, 2, 1])
  })

  it('空核抛 —— 一个没有抽头的核不是「不做相关」', () => {
    expect(() => correlate2d(matZeros(3, 3), matZeros(0, 3))).toThrow(/空的/)
  })
})

describe('hanning：容差 `2·eps`，而**故意不断言逐位**', () => {
  const g = golden['hanning']
  for (const [m, want] of Object.entries(g.windows as Record<string, unknown[]>)) {
    it(`M=${m}`, () => {
      expectCloseArray(hanning(Number(m)), want, HANNING_REL_TOL, `hanning(${m})`)
    })
  }

  it('**`hanning(1)` 是 `[1]` 不是 `[0]`** —— `M−1 = 0`，那个式子除零', () => {
    expect([...hanning(1)]).toEqual([1])
    // 写成除零会给 NaN，而 NaN 会穿过每一条 `>` `<` 检查（同 D-SI-1）
    expect(Number.isNaN(hanning(1)[0] as number)).toBe(false)
    // 而 M=2 确实是一个把信号乘没的窗 —— 那也是对的
    expect([...hanning(2)]).toEqual([0, 0])
    expect([...hanning(0)]).toEqual([])
  })

  it('2-D 窗就是两条一维的外积', () => {
    const w = g.window2d as any
    const got = hanningWindow2d(w.rows as number, w.cols as number)
    expectCloseArray(got.data, (w.out as unknown[][]).flat(), 2 * HANNING_REL_TOL, 'window2d')
  })

  it('窗长必须是整数 —— 「2.5 点的窗」没有定义', () => {
    expect(() => hanning(5.5)).toThrow(/整数/)
  })
})

// ── 非归一化互相关 + error / phase ─────────────────────────────────────────

describe('互相关的 `error` 与 `phase`：**两个判据，两条不同的容差**', () => {
  const rowsOf = (v: unknown[][]): Mat => matFromRows(v.map((r) => r.map(num)))
  const rawOf = (label: string): any => {
    const c = (golden['xcorr_raw'].cases as any[]).find((x) => x.label === label)
    expect(c, `金样里得有 ${label} 这一格`).toBeDefined()
    return c
  }

  for (const c of golden['xcorr_raw'].cases as any[]) {
    const uf = c.upsample_factor as number
    it(`${c.label}（uf=${uf}, normalization=${String(c.normalization)}）`, () => {
      const ref = rowsOf(c.reference as unknown[][])
      const mov = rowsOf(c.moving as unknown[][])
      const n = ref.rows * ref.cols
      const r = phaseCrossCorrelation(ref, mov, uf, c.normalization as 'phase' | null)
      // 位移仍然是 k/uf ⇒ 逐位
      expect(r.shift.map((v) => v + 0)).toEqual((c.shift as unknown[]).map((v) => num(v) + 0))
      // phase：绝对容差，**按角度比**（+π 与 −π 是同一个角）
      expect(angleDiff(r.phase, num(c.phase)), `${c.label} phase`)
        .toBeLessThanOrEqual(xcorrPhaseAbsTol(n))
      // error：判据写在**平方**上 —— `1 − |CC|²/amp` 是一次相消，`√` 再把它放大
      expect(Math.abs(r.error ** 2 - num(c.error_sq)), `${c.label} error²`)
        .toBeLessThanOrEqual(xcorrErrorSqAbsTol(n))
    })
  }

  it('**两档归一化给不同的位移** —— 这个开关不是装饰', () => {
    // 同一对几乎平坦的帧：'phase' 报一个纯属虚构的 (5, 5)，null 报 (0, 0)。
    // **只有这种帧分得开** —— 别的输入上两档同解，于是一组只有普通帧的金样
    // 会让「归一化可关」这件事没有任何测试在看（同 D-NUM-13 那一次）。
    const raw = rawOf('near_flat_none_uf1')
    const phase = (golden['subpixel'].cases as any[]).find(
      (x) => x.kind === 'near_flat' && x.upsample_factor === 1,
    )
    expect(phase, '金样里得有归一化那一格').toBeDefined()
    expect((raw.shift as unknown[]).map(num), 'null ⇒ (0, 0)').toEqual([0, 0])
    expect((phase.shift as unknown[]).map(num), "'phase' ⇒ 虚构的位移").not.toEqual([0, 0])

    const ref = rowsOf(raw.reference as unknown[][])
    const mov = rowsOf(raw.moving as unknown[][])
    expect(phaseCrossCorrelation(ref, mov, 1, null).shift.map((v) => v + 0)).toEqual([0, 0])
    expect(phaseCrossCorrelation(ref, mov, 1).shift.map((v) => v + 0)).not.toEqual([0, 0])
  })

  it('**`b = −a` ⇒ phase = ±π** —— 这是 phase 唯一的判别性输入', () => {
    // 对得上的帧 phase 恒为 0，于是「最后那次共轭取没取」在别处完全看不出来。
    const c = rawOf('neg_none_uf10')
    expect(Math.abs(num(c.phase)), '金样自己得是 ±π').toBeCloseTo(Math.PI, 12)
    const r = phaseCrossCorrelation(
      rowsOf(c.reference as unknown[][]), rowsOf(c.moving as unknown[][]), 10, null,
    )
    expect(angleDiff(r.phase, num(c.phase))).toBeLessThanOrEqual(xcorrPhaseAbsTol(32 * 32))
    // 而同一对图不取反时 phase 是 0 —— 两格一起才说明问题
    expect(Math.abs(num(rawOf('roll_none_uf10').phase))).toBeLessThan(1e-10)
  })

  it('**只有一行时那条轴上的位移置 0** —— 而只有 uf > 1 分得开', () => {
    const c = rawOf('single_row_uf10')
    const ref = rowsOf(c.reference as unknown[][])
    const mov = rowsOf(c.moving as unknown[][])
    expect(phaseCrossCorrelation(ref, mov, 10, null).shift.map((v) => v + 0))
      .toEqual((c.shift as unknown[]).map((v) => num(v) + 0))
    // 不置 0 的话上采样那一步会在退化轴上给 −dftshift/uf = −0.7 —— 一个完全合法的数
    expect(num((c.shift as unknown[])[0])).toBe(0)
  })

  it('`error` 的绝对精度只到 `√(32·fftRelTol)` —— 阈值不能设在 1e−6 以下', () => {
    // 对得上的一对帧：`1 − |CC|²/amp` 是两个几乎相等的数相减，√ 再把剩下的放大。
    // 金样里那个数是 2.1e−8，而我们能保证的只有 ~8e−7 —— **也就是说它和 0 没区别**。
    const floor = Math.sqrt(xcorrErrorSqAbsTol(32 * 32))
    expect(num(rawOf('roll_none_uf1').error), '一次精确的 roll，error 在噪声底以下')
      .toBeLessThan(floor)
    // 而一对**真的对不上**的帧，error 是 O(1)，那时它才是一个可读的数
    expect(num(rawOf('windowed_none_uf10').error), '加窗之后两张图不再是彼此的重排')
      .toBeGreaterThan(0.1)
  })

  it('`normalization` 只有两档，传别的**抛** —— 不是悄悄退回缺省', () => {
    const a = matZeros(8, 8)
    expect(() => phaseCrossCorrelation(a, a, 1, 'magnitude' as unknown as null))
      .toThrow(/normalization/)
  })
})

describe('归一化那一档也回 error / phase（金样补录）', () => {
  const rowsOf = (v: unknown[][]): Mat => matFromRows(v.map((r) => r.map(num)))
  for (const c of golden['xcorr'].cases as any[]) {
    it(`roll(${(c.applied_roll as number[]).join(', ')}) 的 error / phase`, () => {
      const ref = rowsOf(c.reference as unknown[][])
      const mov = rowsOf(c.moving as unknown[][])
      const n = ref.rows * ref.cols
      const r = phaseCrossCorrelation(ref, mov)
      expect(angleDiff(r.phase, num(c.phase)), 'phase').toBeLessThanOrEqual(xcorrPhaseAbsTol(n))
      expect(Math.abs(r.error ** 2 - num(c.error_sq)), 'error²')
        .toBeLessThanOrEqual(xcorrErrorSqAbsTol(n))
    })
  }

  for (const c of golden['subpixel'].cases as any[]) {
    const uf = c.upsample_factor as number
    it(`亚像素 ${c.kind} @ uf=${uf} 的 error / phase`, () => {
      const ref = rowsOf(c.reference as unknown[][])
      const mov = rowsOf(c.moving as unknown[][])
      const n = ref.rows * ref.cols
      const r = phaseCrossCorrelation(ref, mov, uf)
      expect(angleDiff(r.phase, num(c.phase)), 'phase').toBeLessThanOrEqual(xcorrPhaseAbsTol(n))
      expect(Math.abs(r.error ** 2 - num(c.error_sq)), 'error²')
        .toBeLessThanOrEqual(xcorrErrorSqAbsTol(n))
    })
  }
})

// ── curve_fit 的 pcov ──────────────────────────────────────────────────────

describe('curve_fit 的 `pcov`：容差由**参数离 scipy 多远**推出来', () => {
  const g = golden['curve_fit']
  const gauss = (x: number, p: Float64Array): number =>
    (p[0] as number) * Math.exp(-0.5 * ((x - (p[1] as number)) / (p[2] as number)) ** 2) + (p[3] as number)
  const fit = (): ReturnType<typeof curveFit> =>
    curveFit(gauss, (g.x as unknown[]).map(num), (g.y as unknown[]).map(num), g.p0 as number[])
  const tol = pcovRelTol(num(g.rel_step))

  it(`perr 落在 pcovRelTol(rel_step) = ${pcovRelTol(0.01).toExponential(2)} 那个量级里`, () => {
    expectCloseArray(fit().perr, g.perr as unknown[], tol, 'perr')
  })

  it('整张 `pcov` 也落在同一条容差里', () => {
    expectCloseArray(fit().pcov, (g.pcov as unknown[][]).flat(), tol, 'pcov')
  })

  it('**分母是 `n−p` 不是 `n`** —— 判据是「离对的近、离错的远」，不依赖任何容差', () => {
    // 这是这一件最容易犯的错，而它给出的是一组完全合理的误差棒：只差 2.6%。
    // 所以除了那条推出来的容差，再钉一条**结构性**的（同 RANSAC 那条）。
    const got = fit().perr
    const right = (g.perr as unknown[]).map(num)
    const wrong = (g.perr_if_dof_were_n as unknown[]).map(num)
    const dRight = Math.hypot(...[...got].map((v, i) => v - (right[i] as number)))
    const dWrong = Math.hypot(...[...got].map((v, i) => v - (wrong[i] as number)))
    expect(dRight, '离「用 n−p」的答案近').toBeLessThan(dWrong)
    // 而那条容差确实比两者的差距紧 —— 否则上面那条断言只是运气
    const scale = Math.max(...right.map((v) => Math.abs(v)))
    const gap = Math.hypot(...right.map((v, i) => v - (wrong[i] as number))) / scale
    expect(tol, `容差 ${tol.toExponential(2)} 得比 n/(n−p) 那个错 ${gap.toExponential(2)} 紧`)
      .toBeLessThan(gap)
  })

  it('`perr[i]` 就是 `sqrt(pcov[i][i])`，而 `pcov` **逐位对称**', () => {
    const r = fit()
    const np = r.params.length
    for (let i = 0; i < np; i += 1) {
      expect(r.perr[i]).toBe(Math.sqrt(r.pcov[i * np + i] as number))
      for (let j = 0; j < np; j += 1) {
        // 对称性是**构造**出来的（`Σₖ Linv[k][i]·Linv[k][j]`），所以这里容差是 0。
        // 逐列解方程那种写法给不出这一条，而一个不对称的协方差会让
        // 「参数 i 与 j 的相关系数」随取的是哪一半而变。
        expect(r.pcov[i * np + j], `pcov[${i}][${j}]`).toBe(r.pcov[j * np + i])
      }
    }
  })

  it('**自由度不够 ⇒ 全 `Infinity`**，不是 0 —— 一个 0 会被读成「钉死了」', () => {
    const line = (x: number, p: Float64Array): number => (p[0] as number) + (p[1] as number) * x
    const r = curveFit(line, [0, 1], [0, 1], [0.1, 0.9])   // n = p = 2 ⇒ dof = 0
    expect([...r.pcov].every((v) => v === Infinity)).toBe(true)
    expect([...r.perr].every((v) => v === Infinity)).toBe(true)
    // 而多一个点就有了自由度，误差棒变成有限的数
    const ok = curveFit(line, [0, 1, 2], [0, 1, 2.1], [0.1, 0.9])
    expect([...ok.perr].every(Number.isFinite)).toBe(true)
  })
})

// ── polyfit / savgol ───────────────────────────────────────────────────────

describe('polyfit：**高次在前**，而列缩放是 numpy 的一部分', () => {
  for (const c of golden['polyfit'].cases as any[]) {
    const cond = num(c.cond)
    it(`deg=${c.deg}（κ=${cond.toFixed(1)}）`, () => {
      const got = polyfit((c.x as unknown[]).map(num), (c.y as unknown[]).map(num), c.deg as number)
      // 正规方程把 κ 平方 —— 同 fitPlane 一族的那条保证
      expectCloseArray(got, c.coef as unknown[], lstsqRelTol(cond), `polyfit deg=${c.deg}`)
      // 以及那条更紧的「实测水平」（κ 不平方）
      expectCloseArray(got, c.coef as unknown[], lstsqObservedTol(cond), `polyfit deg=${c.deg}（紧）`)
    })
  }

  it('`polyval` 是 Horner，回的是同一条曲线', () => {
    const c = (golden['polyfit'].cases as any[]).find((x) => x.deg === 3)
    const coef = (c.coef as unknown[]).map(num)
    const got = (c.x as unknown[]).map((v) => polyval(coef, num(v)))
    expectCloseArray(got, c.evaluated as unknown[], lstsqObservedTol(num(c.cond)), 'polyval')
  })

  it('**系数高次在前** —— 反过来也是一条完全合法的曲线', () => {
    // y = x²：deg=2 的系数是 [1, 0, 0]，不是 [0, 0, 1]。
    const p = polyfit([0, 1, 2, 3, 4], [0, 1, 4, 9, 16], 2)
    expect(p[0], 'p[0] 是 x² 的系数').toBeCloseTo(1, 10)
    expect(p[2], 'p[2] 是常数项').toBeCloseTo(0, 10)
    expect(polyval(p, 5)).toBeCloseTo(25, 9)
  })

  it('点数不够就抛 —— 不给一个「拟合出来的」欠定解', () => {
    expect(() => polyfit([0, 1], [0, 1], 3)).toThrow(/拟合不了/)
    expect(() => polyfit([0, 1, 2], [0, 1], 1)).toThrow(/长度不等/)
  })
})

describe('savgol_filter：**三段不同的算法拼起来**，容差是三项之和', () => {
  const g = golden['savgol']
  const supported = (g.cases as any[]).filter((c) => c.supported === true)

  for (const c of supported) {
    const w = c.window_length as number
    const po = c.polyorder as number
    const cn = num(c.cond_normal)
    const ce = num(c.cond_edge)
    it(`w=${w} polyorder=${po}：系数（κ=${cn.toFixed(1)}）`, () => {
      expectCloseArray(savgolCoeffs(w, po), c.coeffs as unknown[], savgolCoeffsRelTol(cn), `coeffs w=${w}`)
    })
    it(`w=${w} polyorder=${po}：整条曲线`, () => {
      const got = savgolFilter((c.input as unknown[]).map(num), w, po)
      // **保证**：系数 + 中间那一段的卷积 + 两端 polyfit（κ 平方）
      expectCloseArray(got, c.output as unknown[], savgolRelTol(cn, ce, w), `savgol w=${w}`)
      // **实测水平**：两端那一项的 κ 不平方。两条各管一件事，同 fit.ts
      expectCloseArray(got, c.output as unknown[], savgolObservedTol(cn, ce, w), `savgol w=${w}（紧）`)
    })
  }

  it('**行缩放把 κ 从 1e6 压到 20 量级** —— 不然那条容差等于什么都没测', () => {
    for (const c of supported) {
      const scaled = num(c.cond_normal)
      const raw = num(c.cond_normal_unscaled)
      expect(scaled, `w=${c.window_length}：缩放后的 κ 不比原来大`).toBeLessThanOrEqual(raw)
      // w=25 那一格：1.2e6 → 23，容差从 1.1e−9 收到 2.1e−14
      expect(savgolCoeffsRelTol(scaled)).toBeLessThanOrEqual(savgolCoeffsRelTol(raw))
    }
    const w25 = supported.find((c) => c.window_length === 25)
    expect(num(w25.cond_normal_unscaled) / num(w25.cond_normal), 'w=25 收了四个数量级')
      .toBeGreaterThan(1e4)
  })

  it('**两端那 `w//2` 个点不经过系数** —— 换成边界卷积差得看得见', () => {
    // 'interp' 对最外 w 个样本做一次 polyfit 再求值；'constant' 是补零卷积。
    // 两者**只在两端不同**，而那个不同是 0.5 量级的 —— 不是「边界模式的小差别」。
    const e = g.edge_matters as any
    const w = e.window_length as number
    const interp = (e.interp as unknown[]).map(num)
    const constant = (e.constant as unknown[]).map(num)
    const half = w >> 1
    for (let i = half; i < interp.length - half; i += 1) {
      expect(interp[i], `中间第 ${i} 个两档相同`).toBe(constant[i])
    }
    let worstEdge = 0
    for (let i = 0; i < half; i += 1) {
      worstEdge = Math.max(worstEdge, Math.abs((interp[i] as number) - (constant[i] as number)))
    }
    expect(worstEdge, '两端差得看得见').toBeGreaterThan(0.1)
    // 而我们复现的是 'interp' 那一档
    const got = savgolFilter((supported[0].input as unknown[]).map(num), w, e.polyorder as number)
    const c15 = supported.find((c) => c.window_length === w && c.polyorder === e.polyorder)
    expectCloseArray(
      got, c15.output as unknown[],
      savgolRelTol(num(c15.cond_normal), num(c15.cond_edge), w), 'interp 那一档',
    )
  })

  it('**`polyorder > 3` 抛，不近似** —— 金样照录，证明我们知道它长什么样', () => {
    const high = (g.cases as any[]).filter((c) => c.supported === false)
    expect(high.length, '金样里得有那一格').toBeGreaterThan(0)
    for (const c of high) {
      expect(() => savgolCoeffs(c.window_length as number, c.polyorder as number))
        .toThrow(/polyorder > 3/)
      expect(() => savgolFilter((c.input as unknown[]).map(num), c.window_length as number, c.polyorder as number))
        .toThrow(/polyorder > 3/)
    }
    expect(MAX_POLYORDER).toBe(3)
  })

  it('偶数窗长抛；窗比信号长也抛 —— 后者的欠定拟合看起来完全正常', () => {
    expect(() => savgolCoeffs(8, 3)).toThrow(/奇数/)
    expect(() => savgolFilter([1, 2, 3, 4, 5], 7, 3)).toThrow(/window_length/)
    expect(() => savgolCoeffs(5, 5)).toThrow(/polyorder/)
  })

  it('**系数和为 1** —— 一个 deriv=0 的 Savitzky–Golay 必须保常数', () => {
    // 这一条不需要金样：常数信号的多项式拟合就是它自己，于是 Σc = 1。
    // 它照得出的是「最小范数解挑错了一个特解」那种错 —— 那种错给出的系数
    // 仍然满足 A c = y 的高阶行，但和不为 1，而滤出来的曲线仍然光滑。
    for (const w of [5, 9, 15, 25]) {
      for (const po of [1, 2, 3]) {
        expect(sum(savgolCoeffs(w, po)), `w=${w} po=${po}`).toBeCloseTo(1, 12)
      }
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 批 4b 追加：成对求和 + PCG64
// ──────────────────────────────────────────────────────────────────────────

describe('成对求和（np.add.reduce）', () => {
  it('npSum / npMean / npStd —— **逐位**等于 numpy（容差 0）', () => {
    for (const c of golden['pairwise'].cases as any[]) {
      const x = (c.x as unknown[]).map(num)
      const n = c.n as number
      if (n === 0) {
        expect(npSum(x)).toBe(0)
        expect(Number.isNaN(npMean(x))).toBe(true)
        continue
      }
      // **不是 `toBeCloseTo`**：这一族的判据是「照抄了累加顺序」，
      // 而那是一个是非题。给它容差等于把「没照抄」藏起来。
      expect([n, 'sum', npSum(x)]).toEqual([n, 'sum', num(c.sum)])
      expect([n, 'mean', npMean(x)]).toEqual([n, 'mean', num(c.mean)])
      expect([n, 'std', npStd(x)]).toEqual([n, 'std', num(c.std)])
      if (n > 1) expect([n, 'std1', npStd(x, 1)]).toEqual([n, 'std1', num(c.std_ddof1)])
    }
  })

  it('**「照抄顺序」不能拿随机数据来证** —— 一格必然分岔的', () => {
    // `numerics.md` 第四节第四条：判据要由构造保证，不能靠数据碰巧。
    // 这一串上朴素顺序累加与成对求和给**不同的答案**，于是「我照抄了」这句话
    // 有东西可验；换一串普通数据两者恰好相等，这条断言就什么也没说。
    const g = golden['pairwise'].naive_vs_pairwise as any
    const x = (g.x as unknown[]).map(num)
    expect(num(g.naive)).not.toBe(num(g.pairwise))
    expect(npSum(x)).toBe(num(g.pairwise))
    // 而本仓的 `sum`（Neumaier 补偿）对的是 **Python 的 `sum()`**，不是 numpy 的。
    // 两份并存不是重复，是 D-CHANNELS-1 那条：它们**对的不是同一个函数**。
    expect(sum(x)).not.toBe(num(g.pairwise))
  })
})

describe('numpy 的 PCG64', () => {
  it('SeedSequence 的池 / state / raw / uniform —— 四层各比一遍（容差 0）', () => {
    for (const c of golden['pcg64'].cases as any[]) {
      const seed = c.seed as number
      const pool = seedSequencePool(seedEntropy(seed))
      expect([seed, 'pool', [...pool]]).toEqual([seed, 'pool', c.pool])
      expect([seed, 'state32', [...generateState32(pool, 8)]]).toEqual([seed, 'state32', c.state32])
      expect([seed, 'state64', generateState64(pool, 4).map((x) => x.toString())]).toEqual([seed, 'state64', c.state64])
      const g = Pcg64.fromSeed(seed)
      expect([seed, 'raw', [0, 1, 2, 3, 4, 5].map(() => g.next().toString())]).toEqual([seed, 'raw', c.raw])
      const g2 = Pcg64.fromSeed(seed)
      expect([seed, 'u01', [0, 1, 2, 3, 4, 5].map(() => g2.uniform())]).toEqual([
        seed,
        'u01',
        (c.uniform_0_1 as unknown[]).map(num),
      ])
      const g3 = Pcg64.fromSeed(seed)
      expect([seed, 'u2', [g3.uniform(0.15, 0.85)]]).toEqual([seed, 'u2', (c.uniform_015_085 as unknown[]).map(num)])
    }
  })

  it('`superstructure_test` 真正用的那 24 个数', () => {
    // 这一格不是「再验一遍 uniform」：它是那条**判决链**的入口 ——
    // `superstructure_test` 的三态判决就是「候选 ÷ 这 8 个对照的最大值」。
    // 对照抽在哪儿决定了结论，所以这一串必须逐位对。
    const g = Pcg64.fromSeed(0)
    const got = Array.from({ length: 24 }, () => g.uniform(0.15, 0.85))
    expect(got).toEqual((golden['pcg64'].superstructure_stream as unknown[]).map(num))
  })

  it('种子必须是非负整数 —— 负数 / 小数**抛**，不悄悄取整', () => {
    expect(() => Pcg64.fromSeed(-1)).toThrow(/非负整数/)
    expect(() => Pcg64.fromSeed(1.5)).toThrow(/非负整数/)
  })
})
