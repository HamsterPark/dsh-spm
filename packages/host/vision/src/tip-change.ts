/**
 * 扫描中途的针尖突变 v2 —— 旧仓 `mast/vision/tip_change.py` 的
 * `detect_tip_change` 一族。
 *
 * ## 这件事值多少：**半帧 vs 整帧**
 *
 * STM 的针尖很常在扫描**途中**变（针尖捡起 / 掉下一个原子），此后每一行都是
 * 另一根针成的像。对自动系统来说这是可以当场止损的：发现了就中止，丢半帧；
 * 没发现就丢整帧，而且**下面那半帧的每一个数都会被当成真的**。
 *
 * ## 为什么是 v2：旧版的**零假设是错的**
 *
 * 旧版「单点切分 + max-t」把「有没有趋势」当成了「有没有突变」。逐行特征序列在
 * **没有突变**的帧上也不是平稳白噪声，而是慢趋势 + 自相关噪声（热漂移、蠕变、
 * 反馈整定）；一条长度 H 的线性趋势让合并 t 按 √H 长，于是 512 行上
 * **一个看不见的趋势就能赢过任何固定阈值**。实测 AUC **0.510**（= 掷骰子），
 * 而它那「90% 检出」是拿 **83% 的假阳**换来的。
 *
 * v2 把慢趋势**搬进零假设**：
 *
 * ```
 * 逐行通道 → 滞后 k 差分 → 跑动中值去趋势 → MAD 归一 → 逐通道 |z|
 *          → 空库标定（对数域 z vs 无突变帧）→ 最好的那个通道
 * ```
 *
 * ## `lod` 把一个否定变成一句可证伪的话
 *
 * 「没检出」单独说毫无内容。`lod`（≈ 滞后 k 的 dc 差分的 6×MAD，**输入 z 的单位**）
 * 说的是「**这一帧本来能看见多大的行 DC 跳变**」。单原子台阶 ~200 pm、
 * 典型污染物的 z 偏移几十 pm —— 于是「没检出」变成「没检出，而且这一帧对
 * ≥ lod 的跳变是敏感的」。
 *
 * ## 两张空库，按 nm/px 挑
 *
 * `vigil-c1`（原子尺度，3–15 nm）与 `vigil-c2`（介观，10–279 nm），
 * 分界 `nm/px = 0.03`（C1 顶到 0.0293，C2 从 0.0197 起）。被标定的是
 * **帧内 MAD 归一后的 |z| 极大** —— 无量纲的极值统计量，所以这张表跨数据源
 * 的迁移性远好于任何原始幅度。
 *
 * ## 容差
 *
 * | 件 | 容差 | 推导 |
 * |---|---|---|
 * | `changed` / `changeRow` / `calib` | **0** | 布尔与下标 |
 * | `threshold` | **0** | 查表 |
 * | `score` / `channelScores` | {@link TIP_CHANGE_REL_TOL} | 见下 |
 * | `lod` | {@link TIP_CHANGE_REL_TOL} | 同上（中值 + 一次乘法） |
 *
 * `score = (log(peak) − med) / mad`。`peak` 是一串 MAD 归一后的 |z| 的极大 ——
 * 每个 z 经过：一次跑动中值（**逐位**，输出是输入里的某个元素）、一次减法、
 * 一次除法。要命的是 `peak` 之前那一串 `rfft` / `fft2`：`hf` 与 `bragg_*` 三个
 * 通道的输入来自一次 FFT，其相对误差 `≈ fftRelTol(W)`。
 * 于是 `peak` 的相对误差 `≈ 4·fftRelTol(W)`，而 `log` 把相对误差变成**绝对**误差，
 * 再除以 `mad`（表里最小 0.145）⇒ 放大约 7 倍。
 * `1e−9` 是这个界（`n = 512` 时约 `3e−13`）之上四个量级的裕度，
 * 理由与 `CELL_REL_TOL` 同：**这一族真正会犯的错是挑错通道**（差好几个单位），
 * 不是最后一位。
 *
 * ⚠️ 而 `changed` 是 `score > tau` 这个**布尔**，容差帮不上忙 ——
 * 所以金样的帧要么远超阈值、要么远在阈值以下，**不许有一格贴着 tau**。
 */
import { pyFixed } from 'dsh-spm-kernel'
import { fft, fft2, matOf, npMean, npStd, npSum, type Mat } from 'dsh-spm-numerics'
import { npMedian, toRows } from './nd.js'
import { medianFilter1d } from 'dsh-spm-numerics'

/** 旧仓 `EPS = 1e-12`。 */
export const TIP_CHANGE_EPS = 1e-12

/**
 * 预先登记的超参（**先验，不是在验证集上调出来的**）：
 * `K` ≥ 真值里最大的过渡宽度（10 行）。
 */
export const TIP_CHANGE_K = 12

/** 跑动中值窗 ≈ 过渡宽度的 8–10 倍；更慢的漂移就此并入零假设。 */
export const TIP_CHANGE_TREND_WIN = 101

/** `score` / `lod` 的相对容差。推导见文件抬头。 */
export const TIP_CHANGE_REL_TOL = 1e-9

/**
 * 空库标定表（逐通道、无突变峰的对数域 中值/MAD）。
 * 在 VIGIL 物理语料上量的（各 500 帧，按帧序号奇偶分标定/评测；2026-07-27）。
 *
 * 换到本机要重标：收一批无突变帧，重算每个通道的 log-med / log-MAD，换掉这张表。
 */
export const TIP_CHANGE_CALIB: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  'vigil-c1': {
    dc: [1.1318, 0.1451],
    rms: [1.2592, 0.2728],
    hf: [1.2843, 0.3029],
    ncc: [1.6631, 0.4862],
    tr: [1.5435, 0.5288],
    bragg_amp: [1.3505, 0.5143],
    bragg_ph: [1.8646, 0.9359],
  },
  'vigil-c2': {
    dc: [1.2755, 0.2872],
    rms: [1.4174, 0.4823],
    hf: [1.3901, 0.3569],
    ncc: [2.0462, 0.635],
    tr: [1.6728, 0.6919],
    bragg_amp: [1.2354, 0.4033],
    bragg_ph: [2.0259, 0.8307],
  },
}

/**
 * 逐表的缺省阈值（实测 FPR ≈ 1% 的工作点：C1 tau 6.70、C2 tau 9.77）。
 *
 * 一条 CRITICAL 的「中止这次扫描」告警**必须对假警吝啬**；
 * 实测 FPR 随尺度有 2–4 倍的梯度，这就是介观那一档阈值更高的原因。
 */
export const TIP_CHANGE_DEFAULT_TAU: Readonly<Record<string, number>> = {
  'vigil-c1': 7.0,
  'vigil-c2': 10.0,
}

/** 超过这个 nm/px 用介观那张表（C1 顶到 0.0293，C2 从 0.0197 起，0.03 是自然分界）。 */
export const TIP_CHANGE_MESO_NMPP = 0.03

/** 挑空库。`nm_per_px` 读不到时走原子尺度那张（更严的阈值在保守一侧）。 */
export function pickTipChangeCalib(nmPerPx: number | null | undefined): string {
  return nmPerPx !== null && nmPerPx !== undefined && nmPerPx > TIP_CHANGE_MESO_NMPP ? 'vigil-c2' : 'vigil-c1'
}

/** 最小二乘扣平面（**全局倾斜，刻意不逐行**）。 */
export function deplane(h: Mat): Mat {
  const H = h.rows
  const W = h.cols
  const n = H * W
  // 正规方程：[Σx² Σxy Σx; Σxy Σy² Σy; Σx Σy n]·c = [Σxz, Σyz, Σz]
  let sxx = 0
  let sxy = 0
  let sx = 0
  let syy = 0
  let sy = 0
  let sxz = 0
  let syz = 0
  let sz = 0
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const z = h.data[r * W + c] as number
      sxx += c * c
      sxy += c * r
      sx += c
      syy += r * r
      sy += r
      sxz += c * z
      syz += r * z
      sz += z
    }
  }
  const sol = solve3(
    [sxx, sxy, sx, sxy, syy, sy, sx, sy, n],
    [sxz, syz, sz],
  )
  const out = new Float64Array(n)
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const i = r * W + c
      out[i] = (h.data[i] as number) - (sol[0] * c + sol[1] * r + sol[2])
    }
  }
  return matOf(H, W, out)
}

/** 3×3 高斯消元（列主元）。 */
function solve3(a: readonly number[], b: readonly number[]): [number, number, number] {
  const m = [
    [a[0] as number, a[1] as number, a[2] as number, b[0] as number],
    [a[3] as number, a[4] as number, a[5] as number, b[1] as number],
    [a[6] as number, a[7] as number, a[8] as number, b[2] as number],
  ]
  for (let i = 0; i < 3; i += 1) {
    let p = i
    for (let r = i + 1; r < 3; r += 1) {
      if (Math.abs((m[r] as number[])[i] as number) > Math.abs((m[p] as number[])[i] as number)) p = r
    }
    const tmp = m[i] as number[]
    m[i] = m[p] as number[]
    m[p] = tmp
    const piv = (m[i] as number[])[i] as number
    if (piv === 0) continue
    for (let r = 0; r < 3; r += 1) {
      if (r === i) continue
      const f = ((m[r] as number[])[i] as number) / piv
      for (let c = i; c < 4; c += 1) {
        ;(m[r] as number[])[c] = ((m[r] as number[])[c] as number) - f * ((m[i] as number[])[c] as number)
      }
    }
  }
  return [
    ((m[0] as number[])[3] as number) / ((m[0] as number[])[0] as number),
    ((m[1] as number[])[3] as number) / ((m[1] as number[])[1] as number),
    ((m[2] as number[])[3] as number) / ((m[2] as number[])[2] as number),
  ]
}

/**
 * 跑动中值去趋势 + MAD 归一。
 *
 * ⚠️ `madFloor` **只是一道数值守卫**（无噪声合成输入上的浮点量化），
 * 物理帧永远带着连续的噪声底，它**绝不该在物理帧上生效**。
 *
 * 一道更重的「双峰」分位守卫**试过并被删掉了**（2026-07-27）：真实帧的 dc 通道
 * 本来就是双成分的（平台面行在 pm 级噪声、形貌 / 事件行在几百 pm，实测
 * q90/MAD 到 136×），于是任何按那个形状设的守卫**同时压死真事件** ——
 * VIGIL 复核上它付出了 22 个点的可见事件召回。
 */
export function robustZ(d: Float64Array, trendWin: number, madFloor = 0): Float64Array {
  let x = d
  if (trendWin >= 3 && d.length > trendWin) {
    const trend = medianFilter1d(d, trendWin, 'reflect')
    x = new Float64Array(d.length)
    for (let i = 0; i < d.length; i += 1) x[i] = (d[i] as number) - (trend[i] as number)
  }
  const med = npMedian(x)
  const dev = new Float64Array(x.length)
  for (let i = 0; i < x.length; i += 1) dev[i] = Math.abs((x[i] as number) - med)
  const mad = Math.max(npMedian(dev) * 1.4826, madFloor) + TIP_CHANGE_EPS
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i += 1) out[i] = ((x[i] as number) - med) / mad
  return out
}

/**
 * 滞后 k 差分的 `|robustZ|`，**重新对齐到事件行**（长度 H）。
 *
 * `d[i] = f[i+k] − f[i]` 对第 r 行的事件在 `i ∈ (r−k, r)` 上响应：一个台阶变成
 * i 空间里以 `r − k/2` 为中心、宽 k 的平台，于是右移 `k//2` 之后中心回到 r。
 * **边缘余量只有 `k//2` 行。**
 */
export function lagkZ(f: Float64Array, k: number, trendWin: number): Float64Array {
  const H = f.length
  const d = new Float64Array(Math.max(0, H - k))
  for (let i = 0; i < d.length; i += 1) d[i] = (f[i + k] as number) - (f[i] as number)
  // 相对本序列自身稳健幅度的下限 —— 同样**只是数值守卫**：物理帧的形貌/噪声比
  // 到 ~1e3，所以这道下限必须远在它之下，否则吃掉真实灵敏度（VIGIL 实测）。
  const fm = npMedian(f)
  const fdev = new Float64Array(H)
  for (let i = 0; i < H; i += 1) fdev[i] = Math.abs((f[i] as number) - fm)
  const floor = 1e-5 * (npMedian(fdev) * 1.4826)
  const z = robustZ(d, trendWin, floor)
  const zfull = new Float64Array(H)
  const off = Math.floor(k / 2)
  for (let i = 0; i < z.length && off + i < H; i += 1) zfull[off + i] = Math.abs(z[i] as number)
  return zfull
}

/** `row_channels` 的产出。 */
export interface RowChannels {
  readonly channels: Record<string, Float64Array>
  /** Bragg 逐行解调的复序列（拿不到可用晶格峰时 `null`）。 */
  readonly bragg: { re: Float64Array; im: Float64Array } | null
}

/**
 * ⚠️ **`tr` 通道没有移**（消融精神）。
 *
 * 旧仓 `row_channels` 有第五个通道 `tr`（正反扫逐行最大归一化互相关），
 * 只在传了 retrace 时出现。而本仓这一族**唯一的消费方**是
 * `scan_prep.measure_frame`，它调的是 `detect_tip_change(_fill(span), nm_per_px=…)`
 * —— 一个**二维**数组，于是 `_to_pair` 给 `(trace, None)`，`tr` 那一支
 * **在旧仓自己的这条路上也从来没跑过**。
 *
 * 移它要的不是十行，是一整套 `rfft` / `irfft` 的逐行往返（本仓 `numerics` 没有
 * `irfft`，得现写一份）。**一条没有输入的分支加一件没有消费方的原语** ——
 * 两条都踩在消融精神上。真要它的时候（`PreScanCheck` 那条路给的是正反两帧）
 * 连着 `irfft` 一起做，那时它会带着自己的消费方来。
 */
export const TIP_CHANGE_TR_NOT_PORTED = 'tr'

/** `np.hanning(m)` —— 与 `numerics.hanning` 同式，这里就地算免得多一个 import 环。 */
function hanning(m: number): Float64Array {
  const w = new Float64Array(m)
  if (m === 1) {
    w[0] = 1
    return w
  }
  for (let i = 0; i < m; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1))
  return w
}

/** `np.fft.fftfreq(n) * n` —— 也就是 `[0, 1, …, ⌈n/2⌉−1, −⌊n/2⌋, …, −1]`。 */
function fftIndex(n: number): Float64Array {
  const out = new Float64Array(n)
  const half = Math.floor((n - 1) / 2) + 1
  for (let i = 0; i < half; i += 1) out[i] = i
  for (let i = half; i < n; i += 1) out[i] = i - n
  return out
}

/**
 * 逐行通道 —— `dc` · `rms` · `hf` · `ncc`（+ `tr`、+ `bragg_amp`）。
 *
 * `dc` 是**去平面后的行中值**，也就是那个最主要的 z 偏移特征 ——
 * 而旧版检测器**把它整个丢掉了**。
 */
export function rowChannels(trace: Mat, braggMinProm = 8.0, braggMinFx = 4): RowChannels {
  const h = deplane(trace)
  const H = h.rows
  const W = h.cols
  const rows = toRows(h)
  const rm = new Float64Array(H)
  for (let r = 0; r < H; r += 1) rm[r] = npMedian(rows[r] as number[])
  const hz = new Float64Array(H * W)
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) hz[r * W + c] = (h.data[r * W + c] as number) - (rm[r] as number)
  }
  const channels: Record<string, Float64Array> = {}
  channels['dc'] = rm
  const rmsCh = new Float64Array(H)
  for (let r = 0; r < H; r += 1) {
    const abs: number[] = []
    for (let c = 0; c < W; c += 1) abs.push(Math.abs(hz[r * W + c] as number))
    rmsCh[r] = npMedian(abs) * 1.4826
  }
  channels['rms'] = rmsCh

  // `hf`：上半频段占全谱的比例（`rfft` 沿行）。
  // ⚠️ 两处求和都走 `npSum`（numpy 的成对求和）—— `F.sum(axis=1)` 在 numpy 里
  // 就是成对的，朴素左折会在第 15 位上分岔，而这里两个和要相除。
  const nb = Math.floor(W / 2) + 1
  const hf = new Float64Array(H)
  const rowBuf = new Float64Array(W)
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) rowBuf[c] = hz[r * W + c] as number
    const spec = fft(rowBuf)
    const mags = new Float64Array(nb)
    for (let b = 0; b < nb; b += 1) mags[b] = Math.hypot(spec.re[b] as number, spec.im[b] as number)
    const total = npSum(mags)
    const high = npSum(mags.subarray(Math.floor(nb / 2)))
    hf[r] = high / (total + TIP_CHANGE_EPS)
  }
  channels['hf'] = hf

  // 相邻行 NCC（把长度补成 H：第一格重复第二格的值）。
  const ncc = new Float64Array(H)
  const prod = new Float64Array(W)
  const sqA = new Float64Array(W)
  const sqB = new Float64Array(W)
  for (let r = 0; r + 1 < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const a = hz[r * W + c] as number
      const b = hz[(r + 1) * W + c] as number
      prod[c] = a * b
      sqA[c] = a * a
      sqB[c] = b * b
    }
    ncc[r + 1] = npSum(prod) / (Math.sqrt(npSum(sqA) * npSum(sqB)) + TIP_CHANGE_EPS)
  }
  if (H >= 2) ncc[0] = ncc[1] as number
  channels['ncc'] = ncc

  // Bragg 逐行解调（要一个 |fx| 够大的晶格峰）。
  let bragg: { re: Float64Array; im: Float64Array } | null = null
  const wy = hanning(H)
  const wx = hanning(W)
  const win = new Float64Array(H * W)
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) win[r * W + c] = (hz[r * W + c] as number) * (wy[r] as number) * (wx[c] as number)
  }
  const spec = fft2(matOf(H, W, win))
  const fy = fftIndex(H)
  const fx = fftIndex(W)
  const ringVals: number[] = []
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      if (Math.hypot(fy[r] as number, fx[c] as number) >= 5.0) {
        ringVals.push(Math.hypot(spec.re.data[r * W + c] as number, spec.im.data[r * W + c] as number))
      }
    }
  }
  if (ringVals.length > 0) {
    const medv = npMedian(ringVals) + TIP_CHANGE_EPS
    let best = -1
    let py = 0
    let px = 0
    for (let r = 0; r < H; r += 1) {
      for (let c = 0; c < W; c += 1) {
        if (!(Math.hypot(fy[r] as number, fx[c] as number) >= 5.0)) continue
        if (!(Math.abs(fx[c] as number) >= braggMinFx)) continue
        const mag = Math.hypot(spec.re.data[r * W + c] as number, spec.im.data[r * W + c] as number)
        if (mag > best) {
          best = mag
          py = r
          px = c
        }
      }
    }
    if (best >= 0) {
      const prom = best / medv
      if (prom >= braggMinProm) {
        const fxx = fx[px] as number
        const fyy = fy[py] as number
        const re = new Float64Array(H)
        const im = new Float64Array(H)
        const dr = new Float64Array(W)
        const di = new Float64Array(W)
        for (let r = 0; r < H; r += 1) {
          for (let c = 0; c < W; c += 1) {
            const th = (-2 * Math.PI * fxx * c) / W
            const v = hz[r * W + c] as number
            dr[c] = v * Math.cos(th)
            di[c] = v * Math.sin(th)
          }
          // `dem.mean(axis=1)` —— numpy 的成对求和再除以 W。
          const sr = npMean(dr)
          const si = npMean(di)
          const ph = (-2 * Math.PI * fyy * r) / H
          re[r] = sr * Math.cos(ph) - si * Math.sin(ph)
          im[r] = sr * Math.sin(ph) + si * Math.cos(ph)
        }
        bragg = { re, im }
        const amp = new Float64Array(H)
        for (let r = 0; r < H; r += 1) amp[r] = Math.hypot(re[r] as number, im[r] as number)
        channels['bragg_amp'] = amp
      }
    }
  }
  return { channels, bragg }
}

/** 峰附近那段连续 ≥0.6·max 的游程的质心。 */
export function runCentroid(v: Float64Array): number {
  let imax = 0
  for (let i = 1; i < v.length; i += 1) if ((v[i] as number) > (v[imax] as number)) imax = i
  const thr = 0.6 * (v[imax] as number)
  let lo = imax
  while (lo > 0 && (v[lo - 1] as number) >= thr) lo -= 1
  let hi = imax
  while (hi < v.length - 1 && (v[hi + 1] as number) >= thr) hi += 1
  let num = 0
  let den = 0
  for (let i = lo; i <= hi; i += 1) {
    num += i * (v[i] as number)
    den += v[i] as number
  }
  return pyRoundHalfEven(num / (den + TIP_CHANGE_EPS))
}

/** Python 的 `round(x)` —— **四舍六入五成双**，而 `Math.round(0.5)` 给 1。 */
function pyRoundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/**
 * 逐帧检测限：这一帧本来能看见的最小行 DC 跳变
 * （≈ 滞后 k 的 dc 差分的 6×MAD，**输入 z 的单位**）。
 *
 * 它是**免真值**的 —— 任何一帧都算得出，合成的也好真的也好。
 * 帧太短时 `null`。
 */
export function lodDc(dc: Float64Array, k = TIP_CHANGE_K): number | null {
  if (dc.length < k + 8) return null
  const d = new Float64Array(dc.length - k)
  for (let i = 0; i < d.length; i += 1) d[i] = (dc[i + k] as number) - (dc[i] as number)
  const med = npMedian(d)
  const dev = new Float64Array(d.length)
  for (let i = 0; i < d.length; i += 1) dev[i] = Math.abs((d[i] as number) - med)
  return 6.0 * npMedian(dev) * 1.4826
}

/** `detect_tip_change` 的产出。 */
export interface TipChange {
  readonly changed: boolean
  readonly changeRow: number | null
  readonly score: number
  readonly threshold: number
  readonly method: string
  readonly lod: number | null
  readonly channelScores: Record<string, number>
  readonly calib: string
}

/**
 * 检测扫描中途行统计量的突变（= 针尖变了）。
 *
 * `threshold` 打在**空库标定后的 z** 上；`null` 时按尺度取 ≈FPR 1% 的缺省
 * （原子 7.0 / 介观 10.0，由 `nmPerPx` 挑）。
 *
 * ⚠️ 两条早退**都返回 `score = 0`**（不是 `null`）——
 * 「帧太短 / 死平」在旧仓这里与「算出来是 0」长得一样。照移，
 * 而把它说出来的是 `lod`：早退那一支 `lod` 是 `null`。
 */
export function detectTipChange(
  trace: Mat,
  opts: { threshold?: number | null; nmPerPx?: number | null; phaseGateFrac?: number } = {},
): TipChange {
  const H = trace.rows
  const calib = pickTipChangeCalib(opts.nmPerPx ?? null)
  const tau = opts.threshold !== null && opts.threshold !== undefined ? opts.threshold : (TIP_CHANGE_DEFAULT_TAU[calib] as number)
  const phaseGateFrac = opts.phaseGateFrac ?? 0.3
  const early: TipChange = {
    changed: false,
    changeRow: null,
    score: 0,
    threshold: tau,
    method: 'v2cal-lagk',
    lod: null,
    channelScores: {},
    calib,
  }
  if (H < 2 * TIP_CHANGE_K || npStd(trace.data) < 1e-15) return early

  const { channels, bragg } = rowChannels(trace)
  const Zs: Record<string, Float64Array> = {}
  for (const [n, f] of Object.entries(channels)) Zs[n] = lagkZ(f, TIP_CHANGE_K, TIP_CHANGE_TREND_WIN)

  if (bragg !== null) {
    const K = TIP_CHANGE_K
    const amp = new Float64Array(H)
    for (let i = 0; i < H; i += 1) amp[i] = Math.hypot(bragg.re[i] as number, bragg.im[i] as number)
    const medAmp = npMedian(amp)
    const m = H - K
    const d = new Float64Array(m)
    const gate = new Uint8Array(m)
    for (let i = 0; i < m; i += 1) {
      const ar = bragg.re[i + K] as number
      const ai = bragg.im[i + K] as number
      const br = bragg.re[i] as number
      const bi = -(bragg.im[i] as number)
      d[i] = Math.atan2(ar * bi + ai * br, ar * br - ai * bi)
      gate[i] = Math.min(amp[i + K] as number, amp[i] as number) < phaseGateFrac * (medAmp + TIP_CHANGE_EPS) ? 1 : 0
    }
    const keep: number[] = []
    for (let i = 0; i < m; i += 1) if (gate[i] === 0) keep.push(d[i] as number)
    const fill = keep.length > 0 ? npMedian(keep) : 0
    for (let i = 0; i < m; i += 1) if (gate[i] === 1) d[i] = fill
    // 相位差以弧度计 —— 1e−4 rad 远在任何真实晶格相位抖动之下，这道下限
    // 只在无噪声的合成输入上生效。
    const z = robustZ(d, TIP_CHANGE_TREND_WIN, 1e-4)
    const zfull = new Float64Array(H)
    const off = Math.floor(K / 2)
    for (let i = 0; i < z.length && off + i < H; i += 1) zfull[off + i] = Math.abs(z[i] as number)
    Zs['bragg_ph'] = zfull
  }

  // 空库标定：逐通道拿这一帧的峰对无突变分布做对数域 z，帧分数取**最好的通道**。
  // 峰是**原始**极大 —— 标定表就是在原始极大上建的；med3 只用于下面的行定位。
  const table = TIP_CHANGE_CALIB[calib] as Readonly<Record<string, readonly [number, number]>>
  const channelScores: Record<string, number> = {}
  let bestName = ''
  let best = -Infinity
  for (const [n, z] of Object.entries(Zs)) {
    const entry = table[n]
    if (entry === undefined) continue
    let peak = -Infinity
    for (let i = 0; i < z.length; i += 1) peak = Math.max(peak, z[i] as number)
    const s = (Math.log(Math.max(peak, TIP_CHANGE_EPS)) - entry[0]) / entry[1]
    channelScores[n] = pyRound3(s)
    if (s > best) {
      best = s
      bestName = n
    }
  }
  if (!Number.isFinite(best)) return early

  const changed = best > tau
  let changeRow: number | null = null
  if (changed) {
    changeRow = runCentroid(medianFilter1d(Zs[bestName] as Float64Array, 3, 'nearest'))
  }
  return {
    changed,
    changeRow,
    score: best,
    threshold: tau,
    method: 'v2cal-lagk',
    lod: lodDc(channels['dc'] as Float64Array),
    channelScores,
    calib,
  }
}

/**
 * Python 的 `round(x, 3)` —— 走仓里那一份 `pyFixed`（四舍六入五成双 + CPython 的
 * 十进制口径），**不另写第二份**。`round()` 返回数，所以再 `Number` 回来。
 */
function pyRound3(x: number): number {
  if (!Number.isFinite(x)) return x
  return Number(pyFixed(x, 3))
}
