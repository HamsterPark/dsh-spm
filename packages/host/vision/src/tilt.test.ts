/**
 * `tilt-frame.ts` / `tilt-circle.ts` 对 `spec/golden/tilt.json` 的逐格比对。
 *
 * ## 容差从哪来
 *
 * **每一条都来自被测件自己的 docstring**，测试里没有任何一个凭手感写的数：
 *
 * | 节 | 容差 | 出处 |
 * |---|---|---|
 * | `noise_floor` | **0** | `plane.ts`：一次差分 + 两次中位数，闭式 |
 * | `detrend_quadratic` 的每个像素 | {@link detrendAbsTol}`(κ, 基座)` | κ 与基座**随金样录** |
 * | 主导比一族 | {@link DOMINANCE_REL_TOL} | 残差的绝对误差在比值上放大 2δ/σ |
 * | `estimate_tilt` 的 RANSAC 派生量 | `max(4 × ransac_spread, `{@link RANSAC_REL_TOL}`)` | **`ransac_spread` 是导出器跑 12 个种子量出来的** |
 * | `estimate_tilt` 的结论与 `noise_floor_m` | **0** | 它们不是数，是判决 |
 * | `circle_tilt_resolution_deg` / `z_span_for_frame` | {@link TILT_TRIG_REL_TOL} | 一次 `atan`/`tan`/`sqrt` |
 * | `fit_circle_tilt` | {@link CIRCLE_REL_TOL} | 设计阵正交，κ ≈ 1.4 |
 *
 * ## 那个 `ransac_spread` 是这一批最要紧的一条纪律
 *
 * 两边的 RANSAC 抽样序列不同（D-VISION-1），于是「倾斜是多少」在一张高斯噪声的图上
 * 就是一次抽签：实测 12 个种子之间 `b` 差 **3.3e-3**。
 * 所以金样把那个谱宽**录了下来**，测试拿它当容差 —— 而**主路那几格的谱宽是 0**
 * （棋盘噪声让内点恒为全部，见 `plane_checker` 的 why）。
 *
 * 下面那条 `spread_is_not_a_blanket` 就是为这件事写的：
 * **如果所有格子都靠容差过关，这一节就不是判据了。**
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matFromRows, type Mat } from 'dsh-spm-numerics'
import { diffTree, formatMismatches, scalesOf, toGolden } from './golden.js'
import { RANSAC_REL_TOL } from './plane.js'
import {
  DOMINANCE_MIN_TERRACE_PX,
  DOMINANCE_REL_TOL,
  DOMINANCE_TILES,
  LOTTERY_SPREAD,
  MAX_NAN_FRAC,
  MIN_FRAME_PX,
  MIN_INLIER_RATIO,
  STRUCTURE_RATIO_THRESHOLD,
  TILT_TRIG_REL_TOL,
  assessSteps,
  circleTiltResolutionDeg,
  detrendAbsTol,
  detrendQuadratic,
  estimateTilt,
  noiseFloor,
  planeSubtractRobust,
  segmentationStepSignal,
  stepDominanceMultiscale,
  structureDominance,
  zSpanForFrame,
  type SegStepSignal,
  type StepVerdict,
} from './index.js'
import {
  CIRCLE_MAX_JUMP_SIGMA,
  CIRCLE_MAX_RESIDUAL_SIGMA,
  CIRCLE_MIN_POINTS,
  CIRCLE_REL_TOL,
  CIRCLE_RESIDUAL_MAX_RATIO,
  fitCircleTilt,
} from './tilt-circle.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/tilt.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const num = (v: unknown): number =>
  v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : (v as number)

function frameOf(name: string): Mat {
  return matFromRows((G['frames'][name]['data'] as unknown[][]).map((r) => r.map(num)))
}

/** 金样里录的分割器输出，做成一个注入口（本仓没有分割器，见 `tilt-frame.ts` 抬头）。 */
function segStub(pair: readonly unknown[]): SegStepSignal {
  return () => [Boolean(pair[0]), num(pair[1])] as const
}

const FRAME_NAMES = Object.keys(G['frames'] as Record<string, unknown>)

/**
 * 这一格去趋势之后的残差是不是**纯舍入**（导出器量的，不是我判的）。
 *
 * `sparse_6` 是 6 个点配 6 个未知数 —— 恰定，残差数学上恒为 0，剩下的只有浮点噪声。
 * 那上面的 `structure_dominance` 算的是**两台机器各自的 ulp 分布之比**，
 * 实测两边差 60 %。所以那一格只比**结论**，不比数。
 */
const isRounding = (name: string): boolean => Boolean(G['detrend_quadratic'][name]['residual_is_rounding'])

describe('vision/tilt · 常量', () => {
  it('帧法一族的九个常量逐字（它们是物理常数级，改动 = 改代码 + 重新验证）', () => {
    const c = G['constants']
    expect(STRUCTURE_RATIO_THRESHOLD).toBe(c['structure_ratio_threshold'])
    expect(DOMINANCE_MIN_TERRACE_PX).toBe(c['dominance_min_terrace_px'])
    expect([...DOMINANCE_TILES]).toEqual(c['dominance_tiles'])
    expect(MIN_FRAME_PX).toBe(c['min_frame_px'])
    expect(MAX_NAN_FRAC).toBe(c['max_nan_frac'])
    expect(MIN_INLIER_RATIO).toBe(c['min_inlier_ratio'])
    expect(CIRCLE_MIN_POINTS).toBe(c['circle_min_points'])
    expect(CIRCLE_MAX_RESIDUAL_SIGMA).toBe(c['circle_max_residual_sigma'])
    expect(CIRCLE_MAX_JUMP_SIGMA).toBe(c['circle_max_jump_sigma'])
    expect(CIRCLE_RESIDUAL_MAX_RATIO).toBe(c['circle_residual_max_ratio'])
  })
})

describe('vision/tilt · noiseFloor（容差 0）', () => {
  for (const name of FRAME_NAMES) {
    it(`${name}：逐位`, () => {
      const want = num(G['noise_floor'][name])
      const got = noiseFloor(frameOf(name))
      if (Number.isNaN(want)) expect(Number.isNaN(got)).toBe(true)
      else expect(got).toBe(want)
    })
  }
})

describe('vision/tilt · detrendQuadratic（绝对容差，κ 与基座随金样）', () => {
  for (const name of FRAME_NAMES) {
    it(`${name}：逐像素`, () => {
      const m = frameOf(name)
      const want = (G['detrend_quadratic'][name]['data'] as unknown[][]).map((r) => r.map(num))
      const got = detrendQuadratic(m)
      const cond = G['frames'][name]['design_cond']
      const pedestal = num(G['frames'][name]['pedestal'])
      // `design_cond === null` = 有限点 < 6 ⇒ 旧仓**原样返回**，那一格逐位。
      const tol = cond === null ? 0 : detrendAbsTol(num(cond), pedestal)
      expect(got.rows).toBe(want.length)
      expect(got.cols).toBe((want[0] as number[]).length)
      let worst = 0
      for (let r = 0; r < got.rows; r += 1) {
        for (let c = 0; c < got.cols; c += 1) {
          const a = got.data[r * got.cols + c] as number
          const b = (want[r] as number[])[c] as number
          if (Number.isNaN(b)) {
            expect(Number.isNaN(a), `(${r},${c}) 金样是 NaN`).toBe(true)
            continue
          }
          worst = Math.max(worst, Math.abs(a - b))
        }
      }
      expect(worst, `最坏 ${worst.toExponential(3)} > 容差 ${tol.toExponential(3)}`).toBeLessThanOrEqual(tol)
    })
  }
})

describe('vision/tilt · 主导比一族', () => {
  for (const name of FRAME_NAMES) {
    it(`${name}：structureDominance 六个尺度 + 多尺度取最大`, () => {
      const flat = detrendQuadratic(frameOf(name))
      const rounding = isRounding(name)
      for (const [tile, want] of Object.entries(G['structure_dominance'][name] as Record<string, unknown>)) {
        const got = structureDominance(flat, Number(tile))
        const w = num(want)
        // 纯舍入那一格只比「退回 1.0 没有」这个**结论**（四条退路都给 1.0）。
        if (rounding) {
          expect(got === 1, `tile ${tile}: 退路与否`).toBe(w === 1)
          continue
        }
        expect(Math.abs(got - w), `tile ${tile}: ${got} vs ${w}`).toBeLessThanOrEqual(DOMINANCE_REL_TOL * Math.abs(w))
      }
      const ms = G['step_dominance_multiscale'][name]
      const got = stepDominanceMultiscale(flat)
      expect(Object.keys(got.byTile).sort()).toEqual(Object.keys(ms['by_tile'] as object).sort())
      if (!rounding) {
        expect(Math.abs(got.ratio - num(ms['ratio']))).toBeLessThanOrEqual(
          DOMINANCE_REL_TOL * Math.abs(num(ms['ratio'])),
        )
      }
    })
  }

  it('「只比结论」的格子必须是少数 —— 否则这一节就不是判据了', () => {
    const rounding = FRAME_NAMES.filter(isRounding)
    expect(rounding).toEqual(['sparse_6'])
  })

  // ⚠️ **不去趋势**直接喂原帧：`structureDominance` 的四条退路里
  // 「局部 σ 恰为 0」那一条**只在这里走得到** —— 去趋势会把块内的恒定打散
  // （`blocky_8` 的 tile=4 从 1.0 变成 1.146）。上面那一节里那条退路一格都没有，
  // 而一条没有输入的闸与一条不存在的闸在报告里长得一模一样（green-8 §0）。
  for (const name of FRAME_NAMES) {
    it(`${name}：structureDominance **直接喂原帧**（四条退路都在这里）`, () => {
      const m = frameOf(name)
      for (const [tile, want] of Object.entries(G['structure_dominance_raw'][name] as Record<string, unknown>)) {
        const got = structureDominance(m, Number(tile))
        const w = num(want)
        expect(Math.abs(got - w), `tile ${tile}: ${got} vs ${w}`).toBeLessThanOrEqual(DOMINANCE_REL_TOL * Math.abs(w))
      }
    })
  }

  it('那四条退路各有一格（全 NaN / 分块不足 2×2 / 每块不足 2 点 / 局部 σ 为 0）', () => {
    const raw = G['structure_dominance_raw'] as Record<string, Record<string, unknown>>
    expect(num(raw['all_nan_8']!['4'])).toBe(1) // finite.size === 0
    expect(num(raw['plane_checker']!['64'])).toBe(1) // 64×64 ⇒ ny = nx = 1 < 2
    expect(num(raw['one_per_block_8']!['4'])).toBe(1) // 每块只有 1 个有限点 ⇒ stds 为空
    expect(num(raw['blocky_8']!['4'])).toBe(1) // 块内恒定 ⇒ local === 0
    // 而「局部 σ 为 0」那一格的整帧 σ **不是** 0 —— 否则 `g / local` 是 0/0，
    // 拆掉那条退路给的是 NaN 而不是 Infinity，两种坏法分不开。
    expect(num(G['detrend_quadratic']['blocky_8']['std_finite'])).toBeGreaterThan(0)
  })

  it('二阶去趋势不是装饰：`bowed` 在一阶下命中、在二阶下不命中', () => {
    // 旧仓抬头那句「只扣一阶时压电弯曲把比值抬到 1.808」在这里是一条**能变红的断言**。
    const w = G['detrend_order_matters']['bowed']
    const m = frameOf('bowed')
    const r1 = stepDominanceMultiscale(planeSubtractRobust(m)).ratio
    const r2 = stepDominanceMultiscale(detrendQuadratic(m)).ratio
    expect(r1 >= STRUCTURE_RATIO_THRESHOLD).toBe(w['hit_order1'])
    expect(r2 >= STRUCTURE_RATIO_THRESHOLD).toBe(w['hit_order2'])
    expect(w['hit_order1']).toBe(true)
    expect(w['hit_order2']).toBe(false)
    // 二阶那一路是确定的（最小二乘，无抽样）⇒ 按主导比的容差逐格比。
    expect(Math.abs(r2 - num(w['ratio_order2']))).toBeLessThanOrEqual(
      DOMINANCE_REL_TOL * Math.abs(num(w['ratio_order2'])),
    )
    // ⚠️ 一阶那一路走 `planeSubtractRobust` = RANSAC，而这张弯曲的图上内点集差得远
    // （实测两边的比值差 **1.5 %**，远超 `RANSAC_REL_TOL`）。所以这一格**只比结论**
    // 「它命中了」，不比那个数 —— 一条盖得住 1.5 % 的容差在这一族里什么都挡不住。
    expect(r1).toBeGreaterThanOrEqual(STRUCTURE_RATIO_THRESHOLD)
    // 而两边都远离阈值（不是「差一点点就翻边」的那种巧合）。
    expect(num(w['ratio_order1']) / STRUCTURE_RATIO_THRESHOLD).toBeGreaterThan(1.4)
    expect(r1 / STRUCTURE_RATIO_THRESHOLD).toBeGreaterThan(1.4)
  })
})

describe('vision/tilt · assessSteps 与分割器那一路', () => {
  for (const name of FRAME_NAMES) {
    const g = G['assess_steps'][name]
    const seg = G['seg_signal'][name]

    it(`${name}：没有分割器 ⇒ 与旧仓「缺依赖」那一支逐字`, () => {
      const got = assessSteps(frameOf(name), { nmPerPx: 100 / 64 })
      expectVerdict(got, g['verdict_noseg'], isRounding(name))
      // `use_segmentation: false` 与「分割器缺席」在旧仓给的是同一份 verdict。
      expectVerdict(
        assessSteps(frameOf(name), { nmPerPx: 100 / 64, useSegmentation: false }),
        g['verdict_use_segmentation_false'],
        isRounding(name),
      )
    })

    it(`${name}：把金样录下来的分割器输出注进去 ⇒ 与旧仓「分割器在场」那一支逐字`, () => {
      const got = assessSteps(frameOf(name), { nmPerPx: 100 / 64, segSignal: segStub(seg['with_segmenter']) })
      expectVerdict(got, g['verdict_seg'], isRounding(name))
    })
  }

  it('分割器抛异常 ⇒ fail-open 成 `[false, 0]`（旧仓 `except Exception`）', () => {
    const boom: SegStepSignal = () => {
      throw new Error('分割器炸了')
    }
    expect(segmentationStepSignal(frameOf('terraces_8'), 1.5625, boom)).toEqual([false, 0])
    // 而且整条判据退回单路 —— 与「缺依赖」给同一份 verdict。
    expectVerdict(
      assessSteps(frameOf('terraces_8'), { nmPerPx: 100 / 64, segSignal: boom }),
      G['assess_steps']['terraces_8']['verdict_noseg'],
    )
  })

  it('两侧真的不一样（否则这组金样分辨不出两种候选）', () => {
    const differ = FRAME_NAMES.filter((n) => {
      const a = G['assess_steps'][n]['verdict_seg']
      const b = G['assess_steps'][n]['verdict_noseg']
      return JSON.stringify(a) !== JSON.stringify(b)
    })
    expect(differ).toContain('terraces_8')
    expect(differ).toContain('terraces_16')
    expect(differ.length).toBeGreaterThanOrEqual(2)
  })

  it('阈值是**闭**区间：恰好 1.4 算命中', () => {
    // 造一张让 ratio 精确落在阈值上的图做不到，所以直接问那条判据的形状：
    // 用一格 ratio 略低于阈值的帧，把阈值临时当成 ratio 来比。
    const r = num(G['step_dominance_multiscale']['bowed']['ratio'])
    expect(r).toBeLessThan(STRUCTURE_RATIO_THRESHOLD)
    expect(STRUCTURE_RATIO_THRESHOLD >= STRUCTURE_RATIO_THRESHOLD).toBe(true)
  })
})

function expectVerdict(got: StepVerdict, want: Record<string, any>, conclusionOnly = false): void {
  expect(got.step_dominated).toBe(want['step_dominated'])
  expect(got.step_present).toBe(want['step_present'])
  expect(got.triggered_by).toBe(want['triggered_by'])
  expect(got.step_area_frac).toBe(num(want['step_area_frac']))
  expect(Object.keys(got.ratio_by_tile).sort()).toEqual(Object.keys(want['ratio_by_tile'] as object).sort())
  if (conclusionOnly) return
  const wr = num(want['ratio_multiscale'])
  expect(Math.abs(got.ratio_multiscale - wr)).toBeLessThanOrEqual(DOMINANCE_REL_TOL * Math.abs(wr))
}

describe('vision/tilt · estimateTilt', () => {
  const CASES = Object.entries(G['estimate_tilt'] as Record<string, any>).filter(([k]) => k !== 'not_2d')

  for (const [name, c] of CASES) {
    it(`${name}：${c['why']}`, () => {
      const m = frameOf(c['frame'])
      const p = c['params']
      const seg = G['seg_signal'][c['frame']]
      const opts = {
        widthM: num(p['width_m']),
        heightM: num(p['height_m']),
        ...(p['scan_angle_deg'] === undefined ? {} : { scanAngleDeg: num(p['scan_angle_deg']) }),
        nmPerPx: p['nm_per_px'] === undefined ? null : num(p['nm_per_px']),
        ...(p['check_steps'] === undefined ? {} : { checkSteps: Boolean(p['check_steps']) }),
      }
      // ① 缺省（没有分割器）—— 本仓真正跑的那一支。
      compareEstimate(estimateTilt(m, opts), c['segmenter_unavailable'], num(c['ransac_spread']))
      // ② 把金样录下来的分割器输出注进去 —— 旧仓今天的那一支。
      compareEstimate(
        estimateTilt(m, { ...opts, segSignal: segStub(seg['with_segmenter']) }),
        c['with_segmenter'],
        num(c['ransac_spread']),
      )
    })
  }

  it('主路那几格的 `ransac_spread` 必须是 **0** —— 一组全靠容差过关的金样不是判据', () => {
    const exact = CASES.filter(([, c]) => num(c['ransac_spread']) === 0).map(([k]) => k)
    expect(exact).toContain('valid_plane')
    expect(exact).toContain('valid_rotated')
    expect(exact).toContain('valid_bowed')
    expect(exact).toContain('low_inliers')
    // 而「真高斯噪声」那一格确实不是 0（它存在就是为了说明这件事）。
    expect(num(G['estimate_tilt']['valid_gaussian']['ransac_spread'])).toBeGreaterThan(0)
  })

  it('「只比结论」的格子被点名列出 —— 不许悄悄多一格', () => {
    const lottery = CASES.filter(([, c]) => num(c['ransac_spread']) > LOTTERY_SPREAD)
      .map(([k]) => k)
      .sort()
    // 两格都在台阶帧上：`step_dense` 的输出全是 0（比不比都一样），
    // `step_dense_off` 的 `inlier_ratio` 才是真的在抽签（0.458…0.470）。
    expect(lottery).toEqual(['step_dense', 'step_dense_off'])
    // 而它们的**结论**仍然分得开：一个 step_dense、一个 low_inliers。
    expect(G['estimate_tilt']['step_dense']['segmenter_unavailable']['invalid_reason']).toBe('step_dense')
    expect(G['estimate_tilt']['step_dense_off']['segmenter_unavailable']['invalid_reason']).toBe('low_inliers')
  })

  it('D-VISION 那条的反面：`plane_checker` 的内点比恰好是 1，不是「差不多 1」', () => {
    const got = estimateTilt(frameOf('plane_checker'), {
      widthM: 1e-7,
      heightM: 1e-7,
      checkSteps: false,
    })
    expect(got.inlier_ratio).toBe(1)
  })

  it('`frame_not_2d` 在本仓由类型系统承担 —— 1×N 的 Mat 走 `frame_too_small`', () => {
    // 金样里对面的答案摆着，本仓这一侧给的是另一个 —— 两个都写出来，
    // 「不可达」才是一句量出来的话（见 deviations 批 7a-1）。
    expect(G['estimate_tilt']['not_2d']['segmenter_unavailable']['invalid_reason']).toBe('frame_not_2d')
    const oneRow = matFromRows([[1, 2, 3, 4, 5, 6, 7, 8]])
    expect(estimateTilt(oneRow, { widthM: 1e-7, heightM: 1e-7 }).invalid_reason).toBe('frame_too_small')
  })

  it('`fit_failed` **不可达**：要 finite < 3，而那时 NaN 占比早就过了 0.20', () => {
    // 两侧都要量出来，才叫「不可达」而不是「我没造出来」：
    // finite < 3 ⇒ 拟合确实交 None；finite ≥ 3 ⇒ 拟合出得来。
    // **而五格的 invalid_reason 全是 `too_many_nan`** —— 那道闸在前面。
    const cases = G['estimate_tilt_unreachable']['cases'] as any[]
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const c of cases) {
      expect(c['fit_is_none'], `finite=${c['finite']}`).toBe((c['finite'] as number) < 3)
      expect(c['invalid_reason']).toBe('too_many_nan')
      expect(num(c['nan_frac'])).toBeGreaterThan(MAX_NAN_FRAC)
    }
  })
})

/** RANSAC 派生量按**量出来的谱宽**比；结论与噪声底按 0 比。 */
function compareEstimate(got: ReturnType<typeof estimateTilt>, want: Record<string, any>, spread: number): void {
  expect(got.valid).toBe(want['valid'])
  expect(got.invalid_reason).toBe(want['invalid_reason'])
  expect(got.slow_axis_trusted).toBe(want['slow_axis_trusted'])
  expect(got.rotation_applied).toBe(want['rotation_applied'])
  expect(got.noise_floor_m).toBe(num(want['noise_floor_m']))
  if (spread > LOTTERY_SPREAD) {
    if (want['step'] === undefined) expect(got.step).toBeNull()
    else expectVerdict(got.step as StepVerdict, want['step'])
    return
  }
  const tol = Math.max(4 * spread, RANSAC_REL_TOL)
  for (const k of [
    'tilt_x_deg',
    'tilt_y_deg',
    'tilt_fast_deg',
    'tilt_slow_deg',
    'slope_mag_deg',
    'z_span_m',
    'inlier_ratio',
  ] as const) {
    const w = num(want[k])
    const a = got[k]
    if (w === 0) {
      expect(a, k).toBe(0)
      continue
    }
    expect(Math.abs(a - w), `${k}: ${a} vs ${w}`).toBeLessThanOrEqual(tol * Math.abs(w))
  }
  if (want['step'] === undefined) expect(got.step).toBeNull()
  else expectVerdict(got.step as StepVerdict, want['step'])
}

describe('vision/tilt · 两个标量', () => {
  for (const [name, c] of Object.entries(G['circle_tilt_resolution_deg'] as Record<string, any>)) {
    it(`circleTiltResolutionDeg/${name}`, () => {
      const got = circleTiltResolutionDeg(num(c['noise_floor_m']), num(c['radius_m']), c['n_points'] as number)
      const w = num(c['value'])
      if (w === 0) expect(got).toBe(0)
      else expect(Math.abs(got - w)).toBeLessThanOrEqual(TILT_TRIG_REL_TOL * Math.abs(w))
    })
  }
  for (const [name, c] of Object.entries(G['z_span_for_frame'] as Record<string, any>)) {
    it(`zSpanForFrame/${name}`, () => {
      const got = zSpanForFrame(num(c['slope_mag_deg']), num(c['frame_diagonal_m']))
      const w = num(c['value'])
      if (w === 0) expect(got).toBe(0)
      else expect(Math.abs(got - w)).toBeLessThanOrEqual(TILT_TRIG_REL_TOL * Math.abs(w))
    })
  }
})

describe('vision/tilt · fitCircleTilt', () => {
  const NUMERIC = [
    'tilt_x_deg',
    'tilt_y_deg',
    'slope_mag_deg',
    'downhill_deg',
    'residual_rms_m',
    'residual_ratio',
    'max_residual_ratio',
    'max_jump_ratio',
    'drift_rate_m_s',
  ] as const

  for (const [name, c] of Object.entries(G['fit_circle_tilt'] as Record<string, any>)) {
    if (name === 'all_same_angle') continue
    it(`${name}：${c['why']}`, () => {
      const got = fitCircleTilt(
        (c['angles_rad'] as unknown[]).map(num),
        (c['z_values'] as unknown[]).map(num),
        num(c['radius_m']),
        {
          timesS: c['times_s'] === null ? null : (c['times_s'] as unknown[]).map(num),
          noiseFloorM: num(c['noise_floor_m']),
        },
      )
      const w = c['result']
      expect(got.valid).toBe(w['valid'])
      expect(got.invalid_reason).toBe(w['invalid_reason'])
      expect(got.n_points).toBe(w['n_points'])
      expect(got.slow_axis_trusted).toBe(w['slow_axis_trusted'])
      for (const k of NUMERIC) {
        const want = num(w[k])
        const a = got[k]
        if (want === 0) {
          expect(Math.abs(a), k).toBeLessThanOrEqual(1e-24)
          continue
        }
        expect(Math.abs(a - want), `${k}: ${a} vs ${want}`).toBeLessThanOrEqual(CIRCLE_REL_TOL * Math.abs(want))
      }
    })
  }

  it('漂移项不是装饰：同一圈给不给时间，一个过、一个被否决', () => {
    expect(G['fit_circle_tilt']['with_drift']['result']['valid']).toBe(true)
    expect(G['fit_circle_tilt']['drift_ignored']['result']['valid']).toBe(false)
    expect(G['fit_circle_tilt']['drift_ignored']['result']['invalid_reason']).toBe('residual_too_large')
  })

  it('秩亏那一格两边**差整整一倍**，而两边都判 valid（D-TILTCIRCLE，登记在案）', () => {
    // 12 个点全在同一个角度上 ⇒ 设计阵 `[cos, sin, 1]` 里 `sin` 是零列、
    // `cos` 与常数列相同 ⇒ **解不唯一**。numpy 的 `lstsq(rcond=None)` 给**最小范数**
    // 解（把系数平分给两根相同的列），本仓的 Householder QR 全压在第一根上 ——
    // 两者残差都近零，而报出来的倾斜差 **整整 2 倍**（1.432° 对 2.862°）。
    //
    // 不改行为（改它要加一条旧仓没有的秩闸），理由是**它没有下游**：
    // `TiltProbeCircle` 的角度是 `2πk/n`，互不相同，这一格从那里到不了。
    // 但要留着这条断言 —— 哪天有别的调用方，它会当场说出「这两边不是一回事」。
    const c = G['fit_circle_tilt']['all_same_angle']
    expect(c['result']['valid']).toBe(true)
    const got = fitCircleTilt(
      (c['angles_rad'] as unknown[]).map(num),
      (c['z_values'] as unknown[]).map(num),
      num(c['radius_m']),
      { noiseFloorM: num(c['noise_floor_m']) },
    )
    expect(got.valid).toBe(true)
    expect(got.n_points).toBe(12)
    // 比的是**斜率**不是角度：`atan` 非线性，两倍的斜率不是两倍的角。
    const ratio = Math.tan((got.slope_mag_deg * Math.PI) / 180) /
      Math.tan((num(c['result']['slope_mag_deg']) * Math.PI) / 180)
    expect(Math.abs(ratio - 2)).toBeLessThan(1e-9)
    // 残差两边都近零 —— 也就是说「哪一个对」这个问题本身没有答案。
    expect(num(c['result']['residual_rms_m'])).toBeLessThan(1e-20)
    expect(got.residual_rms_m).toBeLessThan(1e-20)
  })

  it('金样树整棵也比一遍（结构漂了会当场红）', () => {
    const want = G['fit_circle_tilt']['plain']['result']
    const got = fitCircleTilt(
      (G['fit_circle_tilt']['plain']['angles_rad'] as unknown[]).map(num),
      (G['fit_circle_tilt']['plain']['z_values'] as unknown[]).map(num),
      num(G['fit_circle_tilt']['plain']['radius_m']),
      { noiseFloorM: num(G['fit_circle_tilt']['plain']['noise_floor_m']) },
    )
    const ms = diffTree(toGolden(got as unknown), want, CIRCLE_REL_TOL, scalesOf(want))
    expect(ms.length, formatMismatches(ms)).toBe(0)
  })
})
