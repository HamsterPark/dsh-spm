/**
 * 扫描伪影三件 —— 反馈振荡 · 热漂移 · 坏行 / 尖峰（旧仓
 * `mast/vision/scan_artifacts.py` 整份）。
 *
 * ## 批 4a 只移了 `bad_row_frac` 那一条路，批 6b 把其余三条补上了
 *
 * 批 4a 的理由是「这一批**没有任何消费方在读 `spike_frac`**（技能只取
 * `bad_row_frac`）」，并点名 `_drift_px` 不要顺手补。那条理由这一刻不成立了：
 * `scan_prep.measure_frame` 把 `detect_scan_artifacts` 的**六个字段整份转发**进
 * `FrameMetrics.artifacts`，而 `_frame_notes` 里有两句话直接读
 * `oscillation` / `oscillation_severity`。**不补 = 那两句话永远不出现。**
 *
 * ⚠️ `_drift_px` 这次补了，而 D-SCANART-1 那条警告**仍然成立且没有被推翻**：
 * 它警告的是「拿 FFT 循环相关去量**漂移矢量**」（旧仓 2026-09-13 把
 * `pair_displacement` 的相位相关换掉了，沿慢轴绕回，「沿 y 挪 3 nm 量到 −0.06 nm」）。
 * 这里这一份**不是**那个用途：它只回答「正反扫之间有没有一个明显偏移」，
 * 而且自带一道闸 —— **偏移峰要比零位移峰高 8% 才报**（晶格上「挪一个周期 = 原图」
 * 会把零位移峰顶平，那不是漂移）。要量漂移矢量仍然用 `pair_displacement`，
 * 不是这个。
 *
 * ## 整条链在 **float32** 里，而那不是精度问题（同 D-VISION-3）
 *
 * `_to_2d` 一开始就 `np.ascontiguousarray(a, dtype=np.float32)`，此后
 * `np.median` / `np.std` / `np.fft.fft2`（numpy 2.x 对 float32 给 **complex64**）
 * 全在单精度里。本仓**照抄那次输入量化**（{@link toFloat32Frame}），
 * 而累加留在 float64 —— 于是两边看的是同一串数，只有累加顺序与位宽不同。
 *
 * 量化必须照抄的理由是判据级的：`has_artifact` 是四个布尔的或，
 * 每一个都是「某个统计量 > 某个常数」。输入差第七位与输入差第二位，
 * 对一个阈值比较是两件事。
 *
 * ## `_plane_detrend` **保留逐行偏置**，这是它与 `_detrend` 的全部区别
 *
 * 只减一个全局平面（倾斜没了、行偏置还在），于是一条被扎穿的扫描线仍然突出来；
 * 减逐行中值会把它**擦干净**。
 *
 * ## 容差：`badRowFrac` 是**整数比**，容差 0
 *
 * 它是「偏离超过 6×MAD 的行数 / 总行数」，取值只能是 `k/nRows`。
 *
 * ⚠️ 旧仓这一路**整条在 float32 里算**（`_to_2d` 一开始就 `astype(float32)`，
 * 连 `np.linalg.lstsq` 都走 float32 的 LAPACK）。本仓照抄输入那次量化、
 * 累加留在 float64。于是**两边的逐行统计量在第七位上不同** ——
 * 而判据是 `|v − med| > 6·mad` 这个**布尔**，只有当某一行恰好卡在阈值的
 * 1e−6 相对邻域里时才会翻。金样的输入因此刻意让坏行**远离**阈值
 * （坏行是 20×MAD 量级，不是 6.0×）。这是「判据要由构造保证，不能靠数据碰巧」
 * 的又一次（`numerics.md` 第四节第二条）。
 *
 * ## 容差表（每一条连推导写在被测函数上）
 *
 * | 件 | 容差 | 为什么 |
 * |---|---|---|
 * | `badRowFrac` / `spikeFrac` | **0** | 计数比 `k/n` |
 * | `oscillationSeverity` | {@link OSC_REL_TOL} | 两个 float32 FFT 极大之比 |
 * | `oscillationCyclesPerLine` / `driftPx` | **0** | 下标（`argmax` 与 `hypot(整数,整数)`） |
 */
import { fft2, ifft2, labelConnected, matAt, matOf, mean, std, type Mat } from 'dsh-spm-numerics'
import { npMedian, toFloat32 } from './nd.js'
import { medianFilter2d } from 'dsh-spm-numerics'
import { lstsqPlane } from './plane.js'

/** float32 的机器精度。 */
const EPS32 = 2 ** -23

/**
 * `oscillation_severity` 的相对容差。
 *
 * 它是 `max|F| 轴上 / (max|F| 轴外 + 1e−9)`。两个极大各自的绝对误差由**整幅谱**的
 * 最大系数定（批 4b §9①：一次 FFT 的绝对误差由 `‖F‖∞` 定，不由这个系数自己定），
 * 而这两个极大**本身就在 `‖F‖∞` 的量级上**（轴上峰是振荡帧的主峰，轴外峰是次强），
 * 于是这一次「相对」是站得住的。
 *
 * 单精度 FFT 的本底 `eps32·√(n·log₂n)` 量级；`16·eps32` 是 `n = 256²` 上约 3 倍余量，
 * 再经一次除法（两个相对误差相加）⇒ `32·eps32`。**实测占比见测试。**
 */
export const OSC_REL_TOL = 32 * EPS32

/** `_to_2d` 的那次 `astype(np.float32)` —— **输入量化，照抄**。 */
export function toFloat32Frame(m: Mat): Mat {
  return matOf(m.rows, m.cols, toFloat32(m.data))
}

/** 逐行减中值（`_detrend_rows`）。 */
export function detrendRows(m: Mat): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let r = 0; r < m.rows; r += 1) {
    const row: number[] = []
    for (let c = 0; c < m.cols; c += 1) row.push(matAt(m, r, c))
    const med = npMedian(row)
    for (let c = 0; c < m.cols; c += 1) out[r * m.cols + c] = (row[c] as number) - med
  }
  return matOf(m.rows, m.cols, out)
}

/** 只减全局平面，**保留逐行偏置**（`_plane_detrend`）。 */
export function planeDetrendKeepRows(m: Mat): Mat {
  const n = m.rows * m.cols
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      xs[r * m.cols + c] = c
      ys[r * m.cols + c] = r
    }
  }
  const fit = lstsqPlane(xs, ys, m.data)
  const out = new Float64Array(n)
  for (let r = 0; r < m.rows; r += 1) {
    for (let c = 0; c < m.cols; c += 1) {
      const i = r * m.cols + c
      out[i] = fit === null ? NaN : matAt(m, r, c) - (fit[0] * c + fit[1] * r + fit[2])
    }
  }
  return matOf(m.rows, m.cols, toFloat32(out))
}

/** 逐行统计量是稳健离群的行占比（`_bad_rows`）。输入应当是**平面去趋势后**的图。 */
export function badRowsFrac(h: Mat): number {
  const rm: number[] = []
  const rs: number[] = []
  for (let r = 0; r < h.rows; r += 1) {
    const row: number[] = []
    for (let c = 0; c < h.cols; c += 1) row.push(matAt(h, r, c))
    rm.push(mean(row))
    rs.push(std(row, 0))
  }
  let frac = 0
  for (const v of [rm, rs]) {
    const med = npMedian(v)
    const mad = npMedian(v.map((x) => Math.abs(x - med))) + 1e-9
    let n = 0
    for (const x of v) if (Math.abs(x - med) > 6.0 * mad) n += 1
    frac = Math.max(frac, n / v.length)
  }
  return frac
}

/**
 * `detect_scan_artifacts(...).bad_row_frac` 那一条路（**只有这一条**）。
 *
 * 早退那一支照移：`_detrend_rows(fwd).std() < 1e-9` 时旧仓直接返回一个
 * 全默认的结果对象，而 `bad_row_frac` 的默认是 **0.0** —— 也就是说
 * 「死平的帧」报出来的坏行占比是 0，而不是「判不了」。
 * 本仓照移**并在这里写下来**：那个 0 的含义是「没算」，读它的人要知道。
 *
 * ⚠️ 这一份是 {@link detectScanArtifacts} 里同一条路的**抄近道**（只为
 * `AssessFrameCorrugation` 省掉一次 FFT 与一次中值滤波）。
 * **两份必须逐位相同**，这一条由 `vision.test.ts` 在每一张金样帧上钉住 ——
 * 「两个看起来该一样的函数」正是 D-CHANNELS-1 的形状，而这里它们**真的**该一样，
 * 所以不靠人记得，靠一条断言。
 */
export function badRowFrac(fwdRaw: Mat): number {
  const fwd = toFloat32Frame(fwdRaw)
  const h = detrendRows(fwd)
  if (std(h.data, 0) < 1e-9) return 0
  return badRowsFrac(planeDetrendKeepRows(fwd))
}

// ── 批 6b：补上 `_oscillation` / `_drift_px` / `_spike_frac` 与整份入口 ──────

/** `np.fft.fftshift` 之后的下标：把 `k` 从 `[0,n)` 挪到中心在 `n//2`。 */
function shifted(k: number, n: number): number {
  return (k + Math.floor(n / 2)) % n
}

/** 反馈振荡的两个量。 */
export interface Oscillation {
  /** 轴上最强峰 ÷ 轴外最强峰。反馈振铃是相干条纹 ⇒ 轴上主峰 ⇒ ≫1。 */
  readonly severity: number
  /** 轴上那个峰的「每行几个周期」。没有可判的轴上峰时 `null`。 */
  readonly cyclesPerLine: number | null
}

/**
 * `_oscillation` —— 轴上 / 轴外谱峰之比。
 *
 * **为什么这两类分得开**：反馈振铃沿扫描轴相干 ⇒ 二维谱上一个**落在频率轴上**
 * （ky≈0 或 kx≈0）的强峰；真的二维晶格把峰放在**轴外**。所以
 * 「各向同性的特征场」与「二维晶格」都不会误触发（severity ≲ 1）。
 *
 * `rr > 3` 把谱心那一坨低频（倾斜、行漂移）挖掉 —— 否则任何一张带倾斜的帧
 * 都会在轴上拿到一个巨大的「峰」。
 *
 * 容差：{@link OSC_REL_TOL}（`severity`）与 **0**（`cyclesPerLine`，它是下标）。
 */
export function oscillation(h: Mat): Oscillation {
  const ny = h.rows
  const nx = h.cols
  const mu = mean(h.data)
  const f = matOf(ny, nx, h.data.map((v) => v - mu))
  const spec = fft2(f)
  const cy = Math.floor(ny / 2)
  const cx = Math.floor(nx / 2)
  let onPeak = -Infinity
  let offPeak = -Infinity
  let anyOn = false
  let anyOff = false
  let py = 0
  let px = 0
  for (let r = 0; r < ny; r += 1) {
    const sy = shifted(r, ny)
    for (let c = 0; c < nx; c += 1) {
      const sx = shifted(c, nx)
      // fftshift 之后 (sy, sx) 这一格的值来自 (r, c)。
      const i = r * nx + c
      const mag = Math.hypot(spec.re.data[i] as number, spec.im.data[i] as number)
      const rr = Math.hypot(sy - cy, sx - cx)
      if (!(rr > 3)) continue
      const onAxis = Math.abs(sy - cy) <= 1 || Math.abs(sx - cx) <= 1
      if (onAxis) {
        anyOn = true
        // `np.argmax` 取 C 序里第一个最大值 —— C 序是 fftshift **之后**的 (sy, sx)。
        if (mag > onPeak) {
          onPeak = mag
          py = sy
          px = sx
        }
      } else {
        anyOff = true
        if (mag > offPeak) offPeak = mag
      }
    }
  }
  if (!anyOn || !anyOff) return { severity: 0, cyclesPerLine: null }
  const sev = Math.min(onPeak / (offPeak + 1e-9), 1e4)
  const cyc = Math.max(Math.abs(px - cx), Math.abs(py - cy))
  return { severity: sev, cyclesPerLine: cyc > 0 ? cyc : null }
}

/**
 * `_drift_px` —— 正反扫的配准偏移（热漂移）。
 *
 * **那道闸是这个函数的全部内容**：偏移峰必须比零位移峰**高 8%** 才报。
 * 晶格上「平移一个晶格矢量 = 原图」会让某个非零位移的峰与零位移打平 ——
 * 那不是漂移，而不设这道闸就会把它报成漂移。
 *
 * 搜索限制在中心 `max(4, 0.15·max(shape))` 的圆窗内：一帧之内的漂移很小，
 * 放开搜索只会捡到远处的噪声峰。
 *
 * 容差 **0**：输出是 `hypot(整数, 整数)`。
 */
export function driftPx(fwd: Mat, bwd: Mat): number {
  const ny = fwd.rows
  const nx = fwd.cols
  const norm = (m: Mat): Mat => {
    const d = detrendRows(m)
    const s = std(d.data, 0) + 1e-9
    return matOf(ny, nx, d.data.map((v) => v / s))
  }
  const a = norm(fwd)
  const b = norm(bwd)
  const fa = fft2(a)
  const fb = fft2(b)
  const n = ny * nx
  const pr = new Float64Array(n)
  const pi = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const ar = fa.re.data[i] as number
    const ai = fa.im.data[i] as number
    const br = fb.re.data[i] as number
    const bi = -(fb.im.data[i] as number)
    pr[i] = ar * br - ai * bi
    pi[i] = ar * bi + ai * br
  }
  const inv = ifft2({ re: matOf(ny, nx, pr), im: matOf(ny, nx, pi) }).re.data
  const cy = Math.floor(ny / 2)
  const cx = Math.floor(nx / 2)
  const at = (sy: number, sx: number): number => {
    const r = ((sy - cy) % ny + ny) % ny
    const c = ((sx - cx) % nx + nx) % nx
    return inv[r * nx + c] as number
  }
  const zeroLag = at(cy, cx)
  const rmax = Math.max(4, Math.trunc(0.15 * Math.max(ny, nx)))
  let peak = -Infinity
  let py = cy
  let px = cx
  for (let sy = 0; sy < ny; sy += 1) {
    for (let sx = 0; sx < nx; sx += 1) {
      if (Math.hypot(sy - cy, sx - cx) > rmax) continue
      const v = at(sy, sx)
      if (v > peak) {
        peak = v
        py = sy
        px = sx
      }
    }
  }
  if (peak <= zeroLag * 1.08) return 0
  return Math.hypot(py - cy, px - cx)
}

/**
 * `_spike_frac` —— **孤立**单像素离群点的占比。
 *
 * 真实特征（吸附物、缺陷）是多像素的团，所以 >2 px 的连通分量被排除，
 * **只有真正的点尖峰算数**。分量用 `ndi.label` 的缺省结构元 = **四连通**。
 *
 * 容差 **0**：输出是 `计数 / 像素数`。
 */
export function spikeFrac(h: Mat): number {
  const med3 = medianFilter2d(h, 3, 'reflect')
  const resid = new Float64Array(h.data.length)
  for (let i = 0; i < resid.length; i += 1) resid[i] = Math.abs((h.data[i] as number) - (med3.data[i] as number))
  const mad = npMedian(resid) + 1e-9
  const hot = new Float64Array(resid.length)
  let anyHot = false
  for (let i = 0; i < resid.length; i += 1) {
    if ((resid[i] as number) > 8.0 * mad) {
      hot[i] = 1
      anyHot = true
    }
  }
  if (!anyHot) return 0
  const lab = labelConnected(matOf(h.rows, h.cols, hot), 4)
  let n = 0
  for (let i = 0; i < hot.length; i += 1) {
    if (hot[i] !== 1) continue
    const l = lab.labels[i] as number
    if ((lab.sizes[l - 1] as number) <= 2) n += 1
  }
  return n / resid.length
}

/** `detect_scan_artifacts` 的六个字段。 */
export interface ScanArtifacts {
  readonly hasArtifact: boolean
  readonly oscillation: boolean
  readonly oscillationSeverity: number
  readonly oscillationCyclesPerLine: number | null
  /** 只有给了反扫且形状一致时才有数；否则 `null` = **没量**。 */
  readonly driftPx: number | null
  readonly badRowFrac: number
  readonly spikeFrac: number
}

/** 振荡判定的缺省阈值（旧仓 `oscillation_threshold=3.0`）。 */
export const OSCILLATION_THRESHOLD = 3.0

/**
 * `detect_scan_artifacts` 整份。
 *
 * ⚠️ **早退那一支照移，并且它的 0 不是「没有坏行」而是「没算」**：
 * `_detrend_rows(fwd).std() < 1e-9` 时旧仓直接返回一个全默认的结果对象
 * （`has_artifact=False`、其余全缺省），于是 `bad_row_frac` 报的那个 0 的含义是
 * **「没算」**。Z 数据以米计（~1e−9）、去趋势残差 ~1e−11 ⇒ **真机上这条早退
 * 几乎总是成立**。读它的人要知道这件事。
 *
 * ⚠️ 早退那一支连 `drift_px` 也是 `None`（默认值），**而不是 0** ——
 * 「没量」与「量到 0」在这里是两句话，而这个字段的默认恰好把它说对了。
 */
export function detectScanArtifacts(
  fwdRaw: Mat,
  bwdRaw: Mat | null = null,
  oscillationThreshold: number = OSCILLATION_THRESHOLD,
): ScanArtifacts {
  const fwd = toFloat32Frame(fwdRaw)
  const bwd = bwdRaw === null ? null : toFloat32Frame(bwdRaw)
  const h = detrendRows(fwd)
  if (std(h.data, 0) < 1e-9) {
    return {
      hasArtifact: false,
      oscillation: false,
      oscillationSeverity: 0,
      oscillationCyclesPerLine: null,
      driftPx: null,
      badRowFrac: 0,
      spikeFrac: 0,
    }
  }
  const osc = oscillation(h)
  const oscFlag = osc.severity > oscillationThreshold
  const drift = bwd !== null && bwd.rows === fwd.rows && bwd.cols === fwd.cols ? driftPx(fwd, bwd) : null
  const badRow = badRowsFrac(planeDetrendKeepRows(fwd))
  const hs = std(h.data, 0) + 1e-9
  const spike = spikeFrac(matOf(h.rows, h.cols, h.data.map((v) => v / hs)))
  const has = oscFlag || badRow > 0.05 || spike > 0.02 || (drift !== null && drift > 3.0)
  return {
    hasArtifact: has,
    oscillation: oscFlag,
    oscillationSeverity: osc.severity,
    oscillationCyclesPerLine: osc.cyclesPerLine,
    driftPx: drift,
    badRowFrac: badRow,
    spikeFrac: spike,
  }
}
