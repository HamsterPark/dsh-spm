/**
 * 坏行占比 —— `AssessFrameCorrugation` 的**旁证**（不参与判决）。
 *
 * 旧仓 `mast/vision/scan_artifacts.py` 里只有 `_bad_rows`(10) + `_plane_detrend`(9)
 * 这 19 行是本批要的，**其余不移**：
 *
 * ## 为什么不整份移 `detect_scan_artifacts`
 *
 * 那个函数无条件还算一个 `_spike_frac`(16)，而它用 `ndi.median_filter` ——
 * 本仓基线没有这一件，而这一批**没有任何消费方在读 `spike_frac`**
 * （技能只取 `bad_row_frac`）。移一个没有消费方的形状，就是给下一个人留一条
 * 永远不亮的分支（同 D-VAC-3 的理由）。
 *
 * ⚠️ 连带**不移**的还有 `_oscillation` 与 `_drift_px`。后者尤其要点名：
 * 它是 FFT 循环相关，而 `survey-remaining.md` §3.4 第一行记着旧仓 2026-09-13
 * **明确把相位相关换掉了**（沿慢轴绕回，「沿 y 挪 3 nm 量到 −0.06 nm」）。
 * 要用的时候该看的是那条记录，不是这里。
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
 * 连 `np.linalg.lstsq` 都走 float32 的 LAPACK）。本仓在 float64 里算，只在最后
 * 照抄那次 `astype(float32)`。于是**两边的逐行统计量在第七位上不同** ——
 * 而判据是 `|v − med| > 6·mad` 这个**布尔**，只有当某一行恰好卡在阈值的
 * 1e−6 相对邻域里时才会翻。金样的输入因此刻意让坏行**远离**阈值
 * （坏行是 20×MAD 量级，不是 6.0×）。这是「判据要由构造保证，不能靠数据碰巧」
 * 的又一次（`numerics.md` 第四节第二条）。
 */
import { matAt, matOf, mean, std, type Mat } from 'dsh-spm-numerics'
import { npMedian, toFloat32 } from './nd.js'
import { lstsqPlane } from './plane.js'

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
 */
export function badRowFrac(fwd: Mat): number {
  const h = detrendRows(fwd)
  if (std(h.data, 0) < 1e-9) return 0
  return badRowsFrac(planeDetrendKeepRows(fwd))
}
