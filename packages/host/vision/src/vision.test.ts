/**
 * 分析判定件对 `spec/golden/analysis.json` 的逐条比对。
 *
 * **容差不在这个文件里**：每一条都引用被测函数自己导出的那个容差函数
 * （`planeRelTol` / `dispersionRelTol` / `corrugationRelTol` / `detrendRelTol` /
 * `lineSnrRelTol` / `AXIS_RATIO_ABS_TOL`），而理由写在那些函数的 docstring 里。
 * **这里没有一个字面量容差** —— 一个字面量容差等于把理由从代码搬进测试，
 * 而下一个人只会看见那个数。
 *
 * 零容差的那一档在这里是**大多数**：掩膜、连通域、计数、下标、词表、字符串。
 * 它们替有容差的那些档报警（`numerics-2.md` 第五节第一条）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matOf, median, sumRelTol, type Mat } from 'dsh-spm-numerics'
import { diffTree, formatMismatches, fromGolden, scalesOf, toGolden } from './golden.js'
import { acquiredRowMask, corrugationRelTol, judgeFrame } from './frame-validity.js'
import { fitPlaneRobust, noiseFloor, planeRelTol, planeSubtractRobust, RANSAC_REL_TOL } from './plane.js'
import {
  assessMask,
  axisRatioFromDispersion,
  AXIS_RATIO_ABS_TOL,
  backgroundLevel,
  dispersionFloor,
  dispersionOfMask,
  dispersionRelTol,
  roundnessDict,
  weightedAxisRatio,
} from './roundness.js'
import { levelsOf } from './step-levels.js'
import { locateStepEdge } from './step-edge.js'
import { ROW_JUMP_REL_TOL, rowBigJumps, rowJumpMadPm, rowJumpSigmaPm } from './row-jump.js'
import { badRowsFrac, planeDetrendKeepRows } from './scan-artifacts.js'
import { detrendRelTol, frameLineAdvisory, lineScore, lineSnrRelTol, usableRows } from './atomic-lines.js'
import { nanStd, npMedian, ptpFinite } from './nd.js'
import { parseXyMeta, pxToM } from './xy-meta.js'
import { readSxm, sxmOrientedFrames } from 'dsh-spm-nanonis-files'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/analysis.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const COND = GOLDEN['condition_numbers'] as Record<string, number>
/** 平面族的容差：由**金样里录下来的条件数**算出来，不写死。 */
const PLANE_TOL = planeRelTol(Math.max(COND['plane_128x128'] as number, COND['plane_96x96'] as number))

function mat(rows: readonly (readonly number[])[]): Mat {
  const ny = rows.length
  const nx = ny === 0 ? 0 : (rows[0] as readonly number[]).length
  const d = new Float64Array(ny * nx)
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) d[r * nx + c] = (rows[r] as readonly number[])[c] as number
  }
  return matOf(ny, nx, d)
}

function goldenMat(v: unknown): Mat {
  return mat(fromGolden(v) as number[][])
}

/** 逐条比一棵树；`tol` 必须来自被测件自己导出的容差函数。 */
function expectTree(actual: unknown, want: unknown, tol: number, scales = scalesOf(want)): void {
  const ms = diffTree(toGolden(actual), want, tol, scales)
  expect(ms.length === 0 || formatMismatches(ms)).toBe(true)
}

// ──────────────────────────────────────────────────────────────────────────

describe('几何：parse_xy_meta / px_to_m', () => {
  it('parseXyMeta 与旧仓逐字相同（含 angle_known 那个旗标）', () => {
    for (const c of GOLDEN['xy_meta']['parse'] as any[]) {
      const got = parseXyMeta(c.header as Record<string, unknown>)
      const want = c.result === null ? null : c.result
      const asPy =
        got === null
          ? null
          : { angle: got.angle, angle_known: got.angleKnown, cx: got.cx, cy: got.cy, h: got.h, w: got.w }
      // 容差 **0**：头里那几个数是原样 `float()` 出来的，中间一次算术都没有。
      expect([c.key, asPy]).toEqual([c.key, want])
    }
  })

  it('pxToM 的旋转与 y 翻转', () => {
    for (const c of GOLDEN['xy_meta']['px_to_m'] as any[]) {
      const k = c.kwargs
      const got = pxToM(k.px_x as number, k.px_y as number, {
        nx: k.nx as number,
        ny: k.ny as number,
        cxM: k.cx_m as number,
        cyM: k.cy_m as number,
        wM: k.w_m as number,
        hM: k.h_m as number,
        angleDeg: k.angle_deg as number,
      })
      // `cos/sin` 在两边都是 libm 的同一条路，而余下是三次乘加 ⇒ 容差按
      // `sumRelTol(3)` 给（三项求和的界），归一化按该字段的全批尺度。
      expectTree(got, c.result, sumRelTol(3), scalesOf(GOLDEN['xy_meta']['px_to_m']))
    }
  })
})

describe('帧有效性', () => {
  it('acquiredRowMask —— 两种未扫形态 + 多帧取交集（容差 0）', () => {
    for (const c of GOLDEN['frame_validity']['acquired_row_mask'] as any[]) {
      const frames = (c.frames as unknown[]).map(goldenMat)
      const got = Array.from(acquiredRowMask(...frames))
      expect([c.key, got]).toEqual([c.key, c.mask])
    }
  })

  it('judgeFrame 的两档死平判据', () => {
    for (const c of GOLDEN['frame_validity']['judge_frame'] as any[]) {
      const shape = c.shape as [number, number]
      // 小帧的输入**录在金样里**，大帧从 `sxm_files` 的字节读回来。
      const m = c.frame !== null && c.frame !== undefined ? goldenMat(c.frame) : FRAMES[c.key as keyof typeof FRAMES]
      if (m === undefined) continue
      expect([c.key, m.rows, m.cols]).toEqual([c.key, shape[0], shape[1]])
      const v = judgeFrame(m)
      expect([c.key, v.usable, v.reason]).toEqual([c.key, c.usable, c.reason])
      const tol = corrugationRelTol(m.rows * m.cols)
      expectTree({ rms: v.corrugationRmsM }, { rms: c.corrugation_rms_m }, tol)
    }
  })
})

describe('`np.median` 不是 `np.percentile(50)`', () => {
  it('这一条由**构造**保证会分岔，不靠数据碰巧', () => {
    const cases = GOLDEN['np_median'] as any[]
    // 「容差不是摆设」这句话不能拿随机数据来证（`numerics.md` 第四节第二条）。
    // 这一批里至少要有一格**真的**分岔，否则下面那些断言绿着什么也没验。
    expect(cases.some((c) => c.differ === true)).toBe(true)
    // 本仓的 `npMedian` 对的是 `np.median` —— **容差 0**，逐格。
    for (const c of cases) {
      expect([c.input, npMedian(c.input as number[])]).toEqual([c.input, c.median])
    }
    // 而本仓的**另一个**中位数（`numerics.median` = `percentile(50)`）在这一批上
    // 至少有一格给出不同的答案。少了这一条，「两个中位数」这件事就只是一句注释。
    //
    // ⚠️ 这里不断言 `numerics.median` 等于 `np.percentile(50)` —— 那是 numerics
    // 自己那份金样的事（`numerics.json` 的 `stats`），在这里再断言一遍等于
    // 把同一件事钉两处，而两处迟早不一样。
    expect(cases.some((c) => npMedian(c.input as number[]) !== median(c.input as number[]))).toBe(true)
  })
})

describe('K2 平面族', () => {
  it('noiseFloor —— 容差 0（差分 + 两次中位数，全是闭式）', () => {
    for (const c of GOLDEN['plane']['noise_floor'] as any[]) {
      const m = FRAMES[c.key as keyof typeof FRAMES]
      if (m === undefined) continue
      expect([c.key, noiseFloor(m)]).toEqual([c.key, c.value])
    }
  })

  it('fitPlaneRobust —— 内点集定死那一格逐位比，抽签那几格按「平面在帧上差多少」', () => {
    for (const c of GOLDEN['plane']['fit_plane_robust'] as any[]) {
      const m = FRAMES[(c.key as string).replace(/_(auto|sigma\d+pm)$/, '') as keyof typeof FRAMES]
      if (m === undefined) continue
      const fit = fitPlaneRobust(m, { sigma: (c.sigma ?? null) as number | null })
      expect([c.key, fit === null]).toEqual([c.key, c.result === null])
      if (fit === null || c.result === null) continue
      // `terraces_sigma10pm` 与那两格 `inlier_ratio === 1` 的：**每一个够好的三点假设
      // 都圈出同一个内点集** ⇒ 内点率逐位相同、系数按 lstsq 的容差。
      const deterministic = c.key === 'terraces_sigma10pm' || c.result.inlier_ratio === 1
      if (deterministic) expect([c.key, fit.inlierRatio]).toEqual([c.key, c.result.inlier_ratio])
      // ⚠️ **不逐系数按相对比。** 一张几乎水平的帧上 `a ≈ −3e-15`（整帧 0.3 pm），
      // 一张常数帧上 `a ≈ −9e-27`（纯舍入）—— 对这种数要求相对精度，
      // 是在要求一件不成立的事（同 `numerics.md` 第四节第一条）。判据是**物理的那一句**：
      //
      // > 两边拟合出来的平面，在帧上**任何一点**的差不超过这一帧尺度的那个容差。
      //
      // 于是比的是四个角上的平面值，归一化用这一帧自己的量程（常数帧退到高度本身）。
      const span = Math.max(ptpFinite(m), Math.abs(c.result.c as number))
      const corners = (a: number, b: number, cc: number): number[] =>
        [[0, 0], [0, m.cols - 1], [m.rows - 1, 0], [m.rows - 1, m.cols - 1]].map(
          ([r, col]) => a * (col as number) + b * (r as number) + cc,
        )
      const got = corners(fit.a, fit.b, fit.c)
      const want = corners(c.result.a as number, c.result.b as number, c.result.c as number)
      const worst = Math.max(...got.map((v, i) => Math.abs(v - (want[i] as number))))
      const tol = deterministic ? PLANE_TOL : RANSAC_REL_TOL
      expect([c.key, worst <= tol * span]).toEqual([c.key, true])
    }
  })

  it('抽签这件事是**真的** —— 有噪帧上的内点集两边不同，而无噪那一格不是', () => {
    // 这一条是上面那个判据的**演练**：要是哪天 `fitPlaneRobust` 变成逐位可比了
    // （比如有人把 RNG 换成 PCG64），这里会红，而那时该改的是上面那条，不是这里。
    const noisy = (GOLDEN['plane']['fit_plane_robust'] as any[]).find((c) => c.key === 'terraces_auto')
    const mine = fitPlaneRobust(FRAMES.terraces, { sigma: null })
    expect(mine).not.toBeNull()
    expect((mine as NonNullable<typeof mine>).inlierRatio).not.toBe(noisy.result.inlier_ratio)
    const fixed = (GOLDEN['plane']['fit_plane_robust'] as any[]).find((c) => c.key === 'terraces_sigma10pm')
    expect(fitPlaneRobust(FRAMES.terraces, { sigma: 10e-12 })?.inlierRatio).toBe(fixed.result.inlier_ratio)
  })

  it('planeSubtractRobust 的角落 / std / ptp（RANSAC 下游）', () => {
    for (const c of GOLDEN['plane']['plane_subtract'] as any[]) {
      const m = FRAMES[c.key as keyof typeof FRAMES]
      if (m === undefined) continue
      const sub = planeSubtractRobust(m)
      const corner: number[][] = []
      for (let r = 0; r < 3; r += 1) {
        const row: number[] = []
        for (let col = 0; col < 3; col += 1) row.push(sub.data[r * sub.cols + col] as number)
        corner.push(row)
      }
      // ⚠️ `corner` 是**残差**，它的尺度是**帧的量程**，不是残差自己 ——
      // 一个 1.8 pm 的残差旁边站着一个 480 pm 的量程，按残差归一就是拿相消的结果
      // 去要相对精度。显式给尺度，而不是让 `scalesOf` 去猜。
      const scales = new Map<string, number>([
        ['.corner', c.ptp as number],
        ['.std', c.std as number],
        ['.ptp', c.ptp as number],
      ])
      expectTree({ corner, std: nanStd(sub.data), ptp: ptpFinite(sub) },
        { corner: c.corner, std: c.std, ptp: c.ptp }, RANSAC_REL_TOL, scales)
    }
  })
})

describe('圆度一族', () => {
  it('axisRatioFromDispersion —— 不许挑到隔壁那一格', () => {
    for (const c of GOLDEN['roundness']['axis_ratio_from_dispersion'] as any[]) {
      const d = c.d === 'NaN' ? NaN : (c.d as number)
      const got = axisRatioFromDispersion(d)
      expect(Math.abs(got - (c.q as number)) <= AXIS_RATIO_ABS_TOL || [c.d, got, c.q]).toBe(true)
    }
  })

  it('dispersionFloor —— 同面积完美圆盘的那个零点', () => {
    for (const c of GOLDEN['roundness']['dispersion_floor'] as any[]) {
      // floor 自己是一串 `std/mean`，容差走 `dispersionRelTol`（边界像素数量级）。
      expectTree({ v: dispersionFloor(c.area_px as number) }, { v: c.value },
        dispersionRelTol(Math.max(8, 4 * Math.sqrt((c.area_px as number) || 1))))
    }
  })

  it('dispersionOfMask 的边界掩膜（腐蚀那一步容差 0）', () => {
    for (const c of GOLDEN['roundness']['dispersion_of_mask'] as any[]) {
      const m = goldenMat(c.mask)
      const got = dispersionOfMask(m)
      expect([c.key, got === null]).toEqual([c.key, c.value === null])
      if (got === null) continue
      expectTree({ v: got }, { v: c.value }, dispersionRelTol(m.rows * m.cols))
    }
  })

  it('assessMask 的五个字段（含判不了时那句话）', () => {
    const cases = GOLDEN['roundness']['assess_mask'] as any[]
    const scales = scalesOf(cases.map((c) => c.as_dict))
    for (const c of cases) {
      const r = assessMask(goldenMat(GOLDEN['roundness']['dispersion_of_mask'].find((x: any) => x.key === c.key).mask))
      expect([c.key, r.ok, r.areaPx]).toEqual([c.key, c.ok, c.area_px])
      expectTree(roundnessDict(r), c.as_dict, dispersionRelTol(512), scales)
    }
  })

  it('weightedAxisRatio / backgroundLevel', () => {
    const wcases = GOLDEN['roundness']['weighted_axis_ratio'] as any[]
    const clusters = FRAMES.clusters
    const base = backgroundLevel(clusters) as number
    const w0 = wcases.find((c) => c.key === 'clusters_bright')
    expectTree({ base }, { base: w0.base }, dispersionRelTol(clusters.rows * clusters.cols))
    const med = medianOf(Array.from(clusters.data))
    const mad = medianOf(Array.from(clusters.data, (v) => Math.abs(v - med)))
    const thr = med + 3.0 * 1.4826 * mad
    const mask = matOf(clusters.rows, clusters.cols, Float64Array.from(clusters.data, (v) => (v > thr ? 1 : 0)))
    expectTree({ v: weightedAxisRatio(clusters, mask, base) }, { v: w0.value },
      dispersionRelTol(clusters.rows * clusters.cols))
    const w1 = wcases.find((c) => c.key === 'too_few_px')
    expect(weightedAxisRatio(matOf(4, 4, new Float64Array(16).fill(1)), matOf(4, 4, new Float64Array(16).fill(1)), 0.5))
      .toBe(w1.value)
    for (const c of GOLDEN['roundness']['background_level'] as any[]) {
      const m = c.key === 'clusters' ? clusters : c.key === 'constant'
        ? matOf(8, 8, new Float64Array(64).fill(2.5e-9))
        : matOf(3, 3, new Float64Array(9).fill(1))
      const got = backgroundLevel(m)
      if (c.value === null) expect([c.key, got]).toEqual([c.key, null])
      else expectTree({ v: got }, { v: c.value }, dispersionRelTol(m.rows * m.cols))
    }
  })
})

describe('台阶 / 边 / 逐行跳动 / 坏行', () => {
  it('levelsOf —— 峰位与峰高', () => {
    for (const c of GOLDEN['topography']['levels'] as any[]) {
      const m = FRAMES[c.key as keyof typeof FRAMES]
      const fit = fitPlaneRobust(m, { sigma: null })
      expect(fit).not.toBeNull()
      const f = fit as NonNullable<typeof fit>
      const flatPm = new Float64Array(m.rows * m.cols)
      for (let r = 0; r < m.rows; r += 1) {
        for (let col = 0; col < m.cols; col += 1) {
          flatPm[r * m.cols + col] = ((m.data[r * m.cols + col] as number) - (f.a * col + f.b * r + f.c)) * 1e12
        }
      }
      const got = levelsOf(flatPm).map((p) => [p[0], p[1]])
      // 台面**位置**的尺度是台面之间的跨度（几百 pm），不是某一个台面自己的
      // 高度（可能接近 0）。峰高那一列用它自己的最大值。
      const lv = c.levels as number[][]
      const span = Math.max(...lv.map((p) => Math.abs(p[0] as number)), 1)
      const peak = Math.max(...lv.map((p) => Math.abs(p[1] as number)), 1)
      expect([c.key, got.length]).toEqual([c.key, lv.length])
      const ms = got.flatMap((p, i) =>
        diffTree(
          { pos: p[0], height: p[1] },
          { pos: (lv[i] as number[])[0], height: (lv[i] as number[])[1] },
          RANSAC_REL_TOL,
          new Map([['.pos', span], ['.height', peak]]),
        ),
      )
      expect(ms.length === 0 || formatMismatches(ms)).toBe(true)
    }
  })

  it('locateStepEdge 的三种 verdict', () => {
    const cases = GOLDEN['topography']['locate_step_edge'] as any[]
    const scales = scalesOf(cases.map((c) => c.result))
    // 这一族的两个退化用例有自己的尺寸（导出器那边写的是 64×64 全 NaN 与
    // 16×16 的零帧），与 `judge_frame` 那边的 8×8 不是同一张 —— 分开取。
    const stepFrames: Record<string, Mat> = {
      ...FRAMES,
      all_nan: matOf(64, 64, new Float64Array(64 * 64).fill(NaN)),
      too_small: matOf(16, 16, new Float64Array(16 * 16)),
    }
    for (const c of cases) {
      const m = stepFrames[c.key.replace(/_tight$/, '')]
      if (m === undefined) continue
      const kw = c.kwargs as Record<string, number>
      const res = locateStepEdge(m, kw.max_straightness !== undefined ? { maxStraightness: kw.max_straightness } : {})
      const asPy = {
        verdict: res.verdict, x_px: res.xPx, y_px: res.yPx, angle_deg: res.angleDeg,
        angle_scan_deg: res.angleScanDeg, step_height_m: res.stepHeightM,
        straightness: res.straightness, n_edge_px: res.nEdgePx,
        upper_fraction: res.upperFraction, reasons: [...res.reasons],
        warnings: [...res.warnings], notes: res.notes,
      }
      // `verdict` / `n_edge_px` / `reasons` 是**容差 0** 的那一档（词表与计数）。
      expect([c.key, asPy.verdict, asPy.n_edge_px, asPy.reasons]).toEqual(
        [c.key, c.result.verdict, c.result.n_edge_px, c.result.reasons])
      expectTree(asPy, c.result, sumRelTol(m.rows * m.cols), scales)
    }
  })

  it('逐行跳动：MAD 主指标 / σ 辅助 / 大跳变计数（计数容差 0）', () => {
    const cases = GOLDEN['topography']['row_jump'] as any[]
    const scales = scalesOf(cases)
    for (const c of cases) {
      const m = FRAMES[c.key as keyof typeof FRAMES]
      const sub = planeSubtractRobust(m)
      const zPm = matOf(sub.rows, sub.cols, Float64Array.from(sub.data, (v) => v * 1e12))
      const [nBig, nRows] = rowBigJumps(zPm)
      expect([c.key, nBig, nRows]).toEqual([c.key, c.big_jumps, c.n_rows])
      // RANSAC 下游的逐行统计量 —— 容差与推导见 `row-jump.ts` 的 `ROW_JUMP_REL_TOL`。
      expectTree({ mad_pm: rowJumpMadPm(zPm), sigma_pm: rowJumpSigmaPm(zPm) },
        { mad_pm: c.mad_pm, sigma_pm: c.sigma_pm }, ROW_JUMP_REL_TOL, scales)
    }
  })

  it('badRowsFrac —— 它是**整数比**，容差 0', () => {
    for (const c of GOLDEN['topography']['bad_rows'] as any[]) {
      const m = FRAMES[c.key as keyof typeof FRAMES]
      expect([c.key, badRowsFrac(planeDetrendKeepRows(m))]).toEqual([c.key, c.value])
    }
  })
})

describe('线级判读', () => {
  it('lineScore —— period / 宽度 / bins 是下标（容差 0），SNR 按 lineSnrRelTol', () => {
    for (const c of GOLDEN['lines']['line_score'] as any[]) {
      const line = fromGolden(c.line) as number[]
      const got = lineScore(line, c.nm_per_px as number)
      const want = fromGolden(c.result) as Record<string, unknown>
      expect([c.key, got.ok]).toEqual([c.key, want['ok']])
      if (!got.ok || want['ok'] !== true) {
        expect([c.key, (got as { why: string }).why]).toEqual([c.key, want['why']])
        continue
      }
      expect([c.key, got.peak_width_bins, got.n_px, got.bins_in_band]).toEqual(
        [c.key, want['peak_width_bins'], want['n_px'], want['bins_in_band']])
      // ⚠️ **一条完全常数的线不比那两个数。** 去趋势之后只剩舍入（1e-25 量级），
      // 谱的峰位与 SNR 由两边各自的舍入决定 —— 那是抽签，不是判据。
      // 结构字段（上面那三个）照比，因为它们由**点数与尺度**决定，与内容无关。
      if (c.key === 'flat_row') continue
      const n = got.n_px
      expectTree({ period_nm: got.period_nm }, { period_nm: want['period_nm'] }, detrendRelTol(COND['cubic_256'] as number))
      expectTree({ line_snr: got.line_snr }, { line_snr: want['line_snr'] },
        lineSnrRelTol(COND['cubic_256'] as number, n))
    }
  })

  it('usableRows —— 「不全零 且 全有限」（容差 0）', () => {
    const lat = FRAMES.lattice
    for (const c of GOLDEN['lines']['usable_rows'] as any[]) {
      const m = c.key === 'lattice' ? lat : halfZero(lat)
      expect([c.key, Array.from(usableRows(m))]).toEqual([c.key, c.rows])
    }
  })

  it('frameLineAdvisory —— 中位数统计与那两句建议', () => {
    const cases = GOLDEN['lines']['advisory'] as any[]
    const scales = scalesOf(cases.map((c) => c.result))
    for (const c of cases) {
      const m = goldenMat(c.frame)
      const kw = c.kwargs as Record<string, number>
      const got = frameLineAdvisory(m, c.nm_per_px as number,
        kw.advisory_snr !== undefined ? { advisorySnr: kw.advisory_snr } : {})
      const want = fromGolden(c.result) as Record<string, unknown>
      expect([c.key, got.ok]).toEqual([c.key, want['ok']])
      if (c.key === 'flat_frame') {
        // 见 `lineScore` 那一条：常数帧上的峰位与 SNR 是抽签，只比结构字段。
        expect([c.key, got.n_lines_scored, got.n_lines_skipped, got.peak_width_median_bins]).toEqual(
          [c.key, want['n_lines_scored'], want['n_lines_skipped'], want['peak_width_median_bins']])
        continue
      }
      expectTree(got, toGolden(want), lineSnrRelTol(COND['cubic_256'] as number, m.cols), scales)
    }
  })
})

// ── 帧从**金样里的 `.sxm` 字节**读回来 ─────────────────────────────────────
//
// ⚠️ 不是按同一个闭式公式两边各建一份。第一版是那么做的，而它在 `noiseFloor`
// 上分岔了 `4.4e-14` 相对 —— 查下去不是 `sin` 的实现，是**加法的结合顺序**
// （numpy 先把 `tilt` 算成一个数组再加，TS 那边写成三次连加）。
//
// 「两边各自重建同一个输入」本身就是一处**没有人在看的差异**。从字节读回来之后
// 它整类消失，而且这也正是技能在真机上看到的那一份。

function frameFromSxm(key: string, channel = 'Z'): Mat {
  const b64 = (GOLDEN['sxm_files'] as Record<string, string>)[key] as string
  const fr = sxmOrientedFrames(readSxm(Buffer.from(b64, 'base64')), channel)
  return fr.forward as Mat
}

function halfZero(lat: Mat): Mat {
  const nx = lat.cols
  const d = new Float64Array(40 * nx)
  for (let r = 0; r < 20; r += 1) for (let c = 0; c < nx; c += 1) d[r * nx + c] = lat.data[r * nx + c] as number
  return matOf(40, nx, d)
}

function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  const h = n >> 1
  return n % 2 === 1 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2
}

/** 线级那一族的帧**在金样里是原样录着的**（它不走 `.sxm`，是活体缓冲）。 */
function latticeFrame(): Mat {
  const c = (GOLDEN['lines']['advisory'] as any[]).find((x) => x.key === 'lattice_default')
  return goldenMat(c.frame)
}

const FRAMES = {
  clusters: frameFromSxm('clusters'),
  terraces: frameFromSxm('terraces'),
  tilted_only: frameFromSxm('tilted'),
  step_edge: frameFromSxm('step_edge'),
  dead_flat_tilted: frameFromSxm('dead_flat'),
  dead_flat_steep: frameFromSxm('dead_flat_steep'),
  row_jumps: frameFromSxm('row_jumps'),
  lattice: latticeFrame(),
  constant: frameFromSxm('constant'),
  all_nan: matOf(8, 8, new Float64Array(64).fill(NaN)),
  too_narrow: matOf(4, 1, new Float64Array(4)),
  single_column: matOf(8, 1, new Float64Array(8)),
} as const

describe('合成帧本身要与导出器逐位相同', () => {
  it('否则下面每一条比的都是另一张图', () => {
    // 金样里录了 `judge_frame` 的 `detrended` 前两行四列 —— 那是一份**指纹**：
    // 它由整张帧算出来，一个像素不对这四个数就不对。
    for (const c of GOLDEN['frame_validity']['judge_frame'] as any[]) {
      const m = FRAMES[c.key as keyof typeof FRAMES]
      if (m === undefined || c.detrended_sample === null) continue
      const v = judgeFrame(m)
      if (v.detrended === null) continue
      const got: number[][] = []
      for (let r = 0; r < 2; r += 1) {
        const row: number[] = []
        for (let col = 0; col < 4; col += 1) row.push(v.detrended.data[r * v.detrended.cols + col] as number)
        got.push(row)
      }
      // ⚠️ 归一化用**这一帧的量程**，不是残差自己：死平帧的残差是纯舍入
      // （1e-17 量级），对它要求相对精度是在要求一件不成立的事。
      // 这个指纹要回答的问题是「两边看的是不是同一张图」，而一张图差一个像素，
      // 这四个数会差在**量程**的量级上，不是在 1e-9 上。
      const span = ptpFinite(m)
      expectTree({ s: got }, { s: c.detrended_sample }, RANSAC_REL_TOL, new Map([['.s', span]]))
    }
  })
})
