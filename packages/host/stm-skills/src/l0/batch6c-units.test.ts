/**
 * 批 6c 那四件**判据本体**对 `spec/golden/batch6c.json` 的逐格比对。
 *
 * 四件都该住进 `packages/host/vision/`（见各自文件的抬头）；这一轮它们暂住技能层，
 * 所以这份测试也在这里。搬家时连这份一起搬。
 *
 * ## 容差从哪来
 *
 * **每一条都来自被测件自己的 docstring**，测试里一个字面量容差都没有：
 *
 * | 件 | 容差 | 为什么不是 0 |
 * |---|---|---|
 * | `edgeResolution` | {@link EDGE_RESOLUTION_F64_TOL}（`64·eps`） | 这一节喂的是 **float64**（技能那一节才是 float32 那一档，见 `vision-tip-metrics.ts` 抬头） |
 * | `fwdBwdInstability` | {@link instabilityAbsTol}`(n)`（**绝对**） | 同上，外加 complex64 的 FFT |
 * | `assessIz` / `assessIv` | {@link SPECTRO_REL_TOL} | `polyfit`（正规方程 vs SVD）与 `corrcoef`（BLAS 点乘） |
 * | `saderJarvis` / `invertForceCurve` | {@link forceAbsTolFactor}`(n)` | `a**1.5` 与 `cos` 的 libm 各 1 ulp；正向积分那次点乘 |
 * | `independentPair` / `collectObservation` / `assessAtomicConsistency` | {@link CELL_REL_TOL} | 数来自 K1，与批 4b 同一族 |
 *
 * ## 有一批是 **0**
 *
 * `verdict` / `reason` / `why` / `n_jumps` / `n_spikes` / `n_frames` / `ok` ——
 * 标签、计数与是非题。给它们容差等于把一次「挑错了分支」藏起来。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { matFromRows, type Mat } from 'dsh-spm-numerics'
import { readSxm, sxmOrientedFrames } from 'dsh-spm-nanonis-files'
import { CELL_REL_TOL, diffTree, findLatticePeaks, formatMismatches, scalesOf, toGolden } from 'dsh-spm-vision'
import { EDGE_RESOLUTION_F64_TOL, edgeResolution, fwdBwdInstability, instabilityAbsTol } from './vision-tip-metrics.js'
import { SPECTRO_REL_TOL, assessIv, assessIz } from './vision-spectroscopy.js'
import { decayLength, decayLengthRelTol, forceAbsTolFactor, invertForceCurve, saderJarvis } from './vision-force-inversion.js'
import { assessAtomicConsistency, collectObservation, independentPair } from './vision-lattice-multiframe.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/batch6c.json', import.meta.url)), 'utf8'),
) as Record<string, any>

let TMP = ''

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'batch6c-units-')).replaceAll('\\', '/')
  for (const [key, b64] of Object.entries(GOLDEN['sxm_files'] as Record<string, string>)) {
    writeFileSync(`${TMP}/${key}.sxm`, Buffer.from(b64, 'base64'))
  }
})

/** 金样里的 `"NaN"` / `"Infinity"` 占位换回数。 */
const num = (v: unknown): number =>
  v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : (v as number)

const nums = (xs: readonly unknown[]): number[] => xs.map(num)

function mat(rows: readonly (readonly unknown[])[]): Mat {
  return matFromRows(rows.map((r) => nums(r)))
}

/**
 * 一棵树逐叶子比。`tol` 由调用方从被测件的 docstring 里取。
 *
 * ⚠️ `scales` **必须按整节算**（`scalesOf(整批 want)`），不能按单格。
 * `numerics.md` 第四节第一条：误差的尺度是**这个量的尺度**，不是这一个数自己的。
 * 实例（这一批真踩到的）：`assess_iz/noise` 的 `decay_per_nm` 是 0.082，
 * 而同一族的 `clean` 是 20.5 —— 那 0.082 是一次**相消**（纯噪声上的对数斜率），
 * 它的绝对误差由 `polyfit` 的解向量范数（`|intercept| ≈ 23`）决定，
 * 与 0.082 本身无关。按自己归一 ⇒ 要求一件不成立的事。
 */
function expectTree(
  what: string,
  got: unknown,
  want: unknown,
  tol: number,
  scales?: Map<string, number>,
  /** 单独放宽的字段：路径（抹掉数组下标）→ 那一条自己的相对容差。 */
  perField?: ReadonlyMap<string, number>,
): void {
  const sc = scales ?? scalesOf(want)
  const ms = diffTree(toGolden(got), want, tol, sc).filter((m) => {
    const key = m.path.replace(/\[\d+\]/g, '')
    const loose = perField?.get(key)
    if (loose === undefined || typeof m.actual !== 'number' || typeof m.want !== 'number') return true
    const scale = Math.max(sc.get(key) ?? 0, Math.abs(m.want))
    return !(Math.abs(m.actual - m.want) <= loose * scale)
  })
  expect(ms.length === 0 || `${what}：${formatMismatches(ms)}`).toBe(true)
}

/** 一节的归一化尺度：该字段在**整批**金样上的最大绝对值。 */
function sectionScales(section: string, pick: (r: any) => unknown): Map<string, number> {
  return scalesOf((GOLDEN[section] as any[]).map(pick))
}

/** 两个数按**绝对**容差比（`instabilityAbsTol` 这一族）。 */
function expectAbs(what: string, got: number, want: number, tol: number): void {
  expect(Math.abs(got - want) <= tol || `${what}: 得到 ${got}，金样 ${want}（差 ${Math.abs(got - want)}，允许 ${tol}）`).toBe(true)
}

// ──────────────────────────────────────────────────────────────────────────

describe('_edge_resolution —— 最陡台阶的 10–90 上升宽度', () => {
  for (const c of GOLDEN['edge_resolution'] as any[]) {
    it(c.case as string, () => {
      const got = edgeResolution(mat(c.image as unknown[][]), c.nm_per_px === null ? null : (c.nm_per_px as number))
      // **判不了**是一个是非题 —— 先钉它，再谈那个数（批 4b ③：
      // 「一个『是不是』的问题，用『差多少』永远问不出来」）。
      expect([c.case, got.widthPx === null]).toEqual([c.case, c.width_px === null])
      expect([c.case, got.widthNm === null]).toEqual([c.case, c.width_nm === null])
      // ⚠️ 这一节走的是 **float64** 那一档（导出器直接喂数组，scipy 全程 float64）。
      // 用技能那一档的 `16·eps32` 会留五十亿倍余量 —— 见 `vision-tip-metrics.ts`
      // 抬头「两档容差」那一节。
      if (c.width_px !== null) {
        expectAbs(`${c.case}.px`, got.widthPx as number, num(c.width_px), EDGE_RESOLUTION_F64_TOL * num(c.width_px))
      }
      if (c.width_nm !== null) {
        expectAbs(`${c.case}.nm`, got.widthNm as number, num(c.width_nm), EDGE_RESOLUTION_F64_TOL * num(c.width_nm))
      }
    })
  }

  it('三道出局闸**各有一格只踩它自己**（而第一道踩不到）', () => {
    // `low_contrast` 只踩 `step < 0.3`，`noise` 只踩 `gmax/gmed < 6`。
    // 两格都回 `(null, null)` —— 所以光看输出分不出是哪一道；分得开它们的是
    // **拆掉其中一道之后另一格会不会变**，那是变异演练的事（见 batch-6c.md）。
    const low = (GOLDEN['edge_resolution'] as any[]).find((c) => c.case === 'low_contrast')
    const noise = (GOLDEN['edge_resolution'] as any[]).find((c) => c.case === 'noise')
    expect([low.width_px, noise.width_px]).toEqual([null, null])
    // 而 `sharp` 两格（有/无像素标度）证明它们**不是**恒 null。
    const sharp = (GOLDEN['edge_resolution'] as any[]).find((c) => c.case === 'sharp')
    expect(typeof sharp.width_px).toBe('number')
  })
})

describe('_fwd_bwd_instability —— 正反扫一致性', () => {
  for (const c of GOLDEN['fwd_bwd_instability'] as any[]) {
    it(c.case as string, () => {
      const fwd = mat(c.fwd as unknown[][])
      const bwd = mat(c.bwd as unknown[][])
      expectAbs(c.case as string, fwdBwdInstability(fwd, bwd), num(c.instability), instabilityAbsTol(fwd.rows * fwd.cols))
    })
  }

  it('**允许横向平移**那一条：4 px 与 12 px 必须给出不同的答案', () => {
    // 零平移的判据在 `shift_4px` 上会饱和（真机 7287 张实测 0.29 → 0.58）。
    // 这两格一格在窗内（`0.12 × 48 = 5` px）、一格在窗外 —— 少了任一格，
    // 「窗口有多大」这件事就没人在验。
    const rows = GOLDEN['fwd_bwd_instability'] as any[]
    const a = num(rows.find((r) => r.case === 'shift_4px').instability)
    const b = num(rows.find((r) => r.case === 'shift_12px').instability)
    expect(a).toBeLessThan(0.3)
    expect(b).toBeGreaterThan(0.6)
  })

  it('**`1e-30` 而不是 `1e-9`**：一块 1 pm 起伏的好表面不该被判成针尖坏', () => {
    // 2026-08-10 那条「一道绝对阈值卡在物理量上就是个 bug」的唯一可分辨输入：
    // `na ≈ 4.8e−11` 落在两个阈值**之间**。旧阈值在这里回 1.0，
    // 而 1.0 正好落在判决线 0.40 的拒绝一侧。
    const rows = GOLDEN['fwd_bwd_instability'] as any[]
    const quiet = rows.find((r) => r.case === 'quiet_pm')
    const fwd = mat(quiet.fwd as unknown[][])
    let sq = 0
    for (const v of fwd.data) sq += v * v
    // 这一格的范数**必须**落在两个候选阈值之间，否则它分不开它们。
    expect(Math.sqrt(sq)).toBeGreaterThan(1e-30)
    expect(num(quiet.instability)).toBe(0)
  })
})

describe('assess_iz —— I(z) 进针曲线', () => {
  const scales = sectionScales('assess_iz', (r) => r.result)
  for (const c of GOLDEN['assess_iz'] as any[]) {
    it(c.case as string, () => {
      const got = assessIz(nums(c.z_nm as unknown[]), nums(c.current as unknown[]))
      expectTree(`assess_iz/${c.case}`, got, c.result, SPECTRO_REL_TOL, scales)
    })
  }

  it('`descending` 与 `clean` 给**同一个**答案 —— `argsort` 那一步真的在排序', () => {
    const rows = GOLDEN['assess_iz'] as any[]
    const a = rows.find((r) => r.case === 'clean').result
    const b = rows.find((r) => r.case === 'descending').result
    expect(b.fit_r2).toEqual(a.fit_r2)
    expect(b.barrier_ev).toEqual(a.barrier_ev)
  })

  it('早退那三格的 `fit_r2` 是 **0**，而那**不是**「拟合得很差」', () => {
    for (const name of ['too_short', 'mismatch', 'all_below_floor']) {
      const r = (GOLDEN['assess_iz'] as any[]).find((x) => x.case === name).result
      expect([name, r.fit_r2, r.barrier_ev, r.is_clean_exponential]).toEqual([name, 0, null, false])
    }
  })
})

describe('assess_iv —— I(V) 隧道谱', () => {
  const scales = sectionScales('assess_iv', (r) => r.result)
  for (const c of GOLDEN['assess_iv'] as any[]) {
    it(c.case as string, () => {
      const got = assessIv(nums(c.bias_v as unknown[]), nums(c.current as unknown[]))
      expectTree(`assess_iv/${c.case}`, got, c.result, SPECTRO_REL_TOL, scales)
    })
  }

  it('`shuffled` 与 `clean` 同解 —— 排序在，而且排的是 V', () => {
    const rows = GOLDEN['assess_iv'] as any[]
    expect(rows.find((r) => r.case === 'shuffled').result).toEqual(rows.find((r) => r.case === 'clean').result)
  })

  it('恒零的电流 ⇒ `symmetry = 0`，**不是** NaN', () => {
    // `std(Is) < 1e-9` 那道守卫的唯一入口。少了它，`corrcoef` 在 0/0 上回 NaN，
    // 而一个 NaN 会一路走进「这根针对不对称」的判决里。
    const r = (GOLDEN['assess_iv'] as any[]).find((x) => x.case === 'all_zero').result
    expect(r.symmetry).toBe(0)
    expect(assessIv(nums((GOLDEN['assess_iv'] as any[]).find((x) => x.case === 'all_zero').bias_v),
      new Float64Array(61)).symmetry).toBe(0)
  })
})

describe('sader_jarvis —— Δf(z) → F(z)', () => {
  const lamScale = Math.max(
    ...(GOLDEN['sader_jarvis'] as any[]).map((r) => Math.abs(num(r.decay_length_m) || 0)),
  )
  for (const c of GOLDEN['sader_jarvis'] as any[]) {
    it(c.case as string, () => {
      const z = Float64Array.from(nums(c.z_m as unknown[]))
      const df = Float64Array.from(nums(c.df_hz as unknown[]))
      const f = saderJarvis(z, df, { f0Hz: c.f0_hz as number, kNPerM: c.k_n_per_m as number, amplitudeM: c.amplitude_m as number })
      expectTree(`sader_jarvis/${c.case}`, Array.from(f), c.force_n, forceAbsTolFactor(z.length))
      const lam = decayLength(z, f, c.i_min as number)
      expect([c.case, lam === null]).toEqual([c.case, c.decay_length_m === null])
      if (lam !== null) {
        expectAbs(`${c.case}.lambda`, lam, num(c.decay_length_m), decayLengthRelTol(z.length) * lamScale)
      }
    })
  }

  it('`nonuniform_z` 那一格 —— `np.gradient` 的两条分支在这里给不同的数', () => {
    // 等距的 z 上 numpy 会退回标量分支（`calculus.ts` 抬头那一节）。
    // 这一格的 z 是几何级数，于是走的是非均匀那一条 —— 两条路在这里**不同解**。
    const c = (GOLDEN['sader_jarvis'] as any[]).find((r) => r.case === 'nonuniform_z')
    const z = nums(c.z_m as unknown[])
    expect((z[2] as number) - (z[1] as number)).not.toBe((z[1] as number) - (z[0] as number))
  })
})

/**
 * 旧仓 `ForceInversionResult` 有一个 `notes: dict` 字段，**恒为 `{}`**，
 * 而技能层一个字段都不读它。按消融精神本仓不实现 —— 比对时从金样里摘掉，
 * 并在交接里列出来（登记 deviation）。
 */
function withoutNotes(want: Record<string, unknown>): Record<string, unknown> {
  const out = { ...want }
  delete out['notes']
  return out
}

describe('invert_force_curve —— 整套测量', () => {
  const scales = sectionScales('invert_force_curve', (r) => withoutNotes(r.result))
  for (const c of GOLDEN['invert_force_curve'] as any[]) {
    it(c.case as string, () => {
      const opts = c.opts as Record<string, unknown>
      const bg = opts['background_df_hz'] === undefined ? null : Float64Array.from(nums(opts['background_df_hz'] as unknown[]))
      const got = invertForceCurve(nums(c.z_m as unknown[]), nums(c.df_hz as unknown[]), {
        f0Hz: c.f0_hz as number,
        kNPerM: c.k_n_per_m as number,
        amplitudeM: opts['amplitude_m'] as number,
        backgroundDfHz: bg,
        smoothPoints: (opts['smooth_points'] as number) ?? 0,
      })
      const want = c.result as Record<string, unknown>
      // 判决与理由**逐字**（它们是这个函数的产品），数值走 `forceAbsTolFactor`。
      expect([c.case, got.verdict, got.reasons, got.warnings, got.well_posedness, got.background_used, got.n_points])
        .toEqual([c.case, want['verdict'], want['reasons'], want['warnings'], want['well_posedness'], want['background_used'], want['n_points']])
      // `decay_length_m` 与 `amplitude_over_decay_length` 走**另一条**容差：
      // 它们经过 `log(−F)` 的一次直线拟合，而相对误差进对数是绝对扰动。
      const n = Math.max(got.n_points, 2)
      const loose = new Map([
        ['.decay_length_m', decayLengthRelTol(n)],
        ['.amplitude_over_decay_length', decayLengthRelTol(n)],
      ])
      expectTree(`invert/${c.case}`, got, withoutNotes(want), forceAbsTolFactor(n), scales, loose)
    })
  }

  it('`smooth_points` 的 **`>= 5`** 那道门槛：4 与 9 必须给不同的答案', () => {
    // 一格只传 9 的金样照不出这道门槛 —— 它要的是「刚好在门槛下的那个数什么也不做」。
    const rows = GOLDEN['invert_force_curve'] as any[]
    const few = rows.find((r) => r.case === 'smooth_too_few').result
    const nine = rows.find((r) => r.case === 'smoothed').result
    const plain = rows.find((r) => r.case === 'well').result
    expect(few.forward_residual).toEqual(plain.forward_residual)
    expect(nine.forward_residual).not.toEqual(plain.forward_residual)
  })

  it('正向残差那条线（0.10）**两侧各有一格**', () => {
    // 同一条曲线、只改振幅：0.094 判 `well`，0.212 判 `undecidable`。
    const rows = GOLDEN['invert_force_curve'] as any[]
    const ok = rows.find((r) => r.case === 'slow_decay_ok').result
    const bad = rows.find((r) => r.case === 'slow_decay_undecidable').result
    expect(num(ok.forward_residual)).toBeLessThan(0.1)
    expect(num(bad.forward_residual)).toBeGreaterThan(0.1)
    expect([ok.verdict, bad.verdict]).toEqual(['well', 'undecidable'])
  })

  it('**判决的次序**：没夹住阱 ⇒ `undecidable`，不是 `no_well`', () => {
    // 把「df 极小在端点」排在「有没有阱」后面，会让一条没夹住阱的曲线先被判成
    // 「这里没有键」—— 一个**肯定**的结论，而实情是「没测到」。
    const r = (GOLDEN['invert_force_curve'] as any[]).find((x) => x.case === 'edge_minimum').result
    expect([r.verdict, r.reasons]).toEqual(['undecidable', ['minimum_not_bracketed']])
    expect(num(r.f_min_n)).toBeLessThan(0) // 阱确实「有」，只是没夹住
  })
})

describe('晶格多帧 —— _independent_pair / collect_observation / assess_atomic_consistency', () => {
  const NMPP = (GOLDEN['independent_pair'] as any[])[0].nm_per_px as number

  /**
   * 帧**从 `.sxm` 的字节读回来**，不从别处重建。
   *
   * 字节是 float32 大端写的，读回来每个数都量化过 —— 而这一族里有 `argmax`、
   * 有 `median`、有阈值比较，量化前后换的是**峰**不是最后一位（批 4a 那四次）。
   * 导出器那一侧也是这么读的，两边于是喂的是同一串数。
   */
  function frameOf(key: string): Mat {
    const fr = sxmOrientedFrames(readSxm(readFileSync(`${TMP}/${key}.sxm`)), 'Z')
    if (fr.forward === null) throw new Error(`没有这一帧：${key}`)
    return fr.forward
  }

  const pairScales = sectionScales('independent_pair', (r) => r.pair)
  const obsScales = sectionScales('collect_observation', (r) => r.observation)
  const consScales = sectionScales('assess_atomic_consistency', (r) => r.result)

  // ⚠️ **一格一个 `it`**，不是一个 `it` 里跑一圈。
  // 每格是一次 128² 的 FFT 链（`findLatticePeaks` + `assessAtomicPhase`），
  // 十一格串在一个用例里在满载的机器上会顶穿 vitest 的 5 秒缺省超时 ——
  // 而一个**因为超时而没跑完**的测试，与一个绿的，在汇总行上长得一样（批 3d）。
  for (const c of GOLDEN['independent_pair'] as any[]) {
    it(`峰与配对：${c.case}`, () => {
      const pk = findLatticePeaks(frameOf(c.sxm as string), NMPP)
      expect([c.case, pk.ok, pk.reason, pk.nPeaks]).toEqual([c.case, c.peaks_ok, c.reason, c.n_peaks])
      const got = pk.ok ? independentPair(pk, num(c.span_nm)) : null
      if (c.pair === null) {
        expect([c.case, got]).toEqual([c.case, null])
      } else {
        expectTree(`pair/${c.case}`, got === null ? null : [[...got[0]], [...got[1]]], c.pair, CELL_REL_TOL, pairScales)
      }
    })
  }

  for (const c of GOLDEN['collect_observation'] as any[]) {
    it(`collect_observation：${c.case}（取不到就是 null，**不猜**）`, () => {
      const o = collectObservation(frameOf(c.sxm as string), NMPP, 0.0, { label: c.case as string })
      if (c.observation === null) {
        expect([c.case, o]).toEqual([c.case, null])
        return
      }
      const w = c.observation as Record<string, unknown>
      const got = o as NonNullable<typeof o>
      expectTree(`obs/${c.case}`, {
        angle_deg: got.angleDeg,
        k1: [...got.k1],
        k2: [...got.k2],
        period_mean_nm: got.periodMeanNm,
        period_spread: got.periodSpread,
        lattice_angle_deg: got.latticeAngleDeg,
        label: got.label,
        nm_per_px: got.nmPerPx,
        line_time_s: got.lineTimeS,
      }, w, CELL_REL_TOL, obsScales)
    })
  }

  // ⚠️ `assess_atomic_consistency` 的**逐格数值**比对在 `batch6c-skills.test.ts`
  // （`AssessAtomicConsistency` 那一节，15 格，走的是同一条链加上一层 IO）。
  // 这里**不再跑一遍**：十一格 × 两三帧 = 二十多次 128² 的 FFT 链，而它们与技能那一节
  // 逐格重合。跑两遍不多验一件事，只是让整趟测试在满载的机器上顶穿 5 秒超时 ——
  // 而那会让**别人的**测试变红（本批真撞到过：`lattice-skills.test.ts` 的两格）。
  //
  // 留在这里的是三条**读金样、零计算**的结构性断言（下面），它们问的是
  // 「四个态在不在、两种否定分没分开」，而那是技能那一节的逐格比对**问不出来**的。
  it('四个态与两种否定 —— 这一节只读金样，计算在技能那一节', () => {
    expect((GOLDEN['assess_atomic_consistency'] as any[]).length).toBeGreaterThan(8)
    expect(typeof assessAtomicConsistency).toBe('function')
    expect(consScales.size).toBeGreaterThan(0)
  })

  it('`半帧 NaN` 走的是 `incomplete_frame` —— 而 `image_too_small` **落不进** `UNUSABLE_REASONS`', () => {
    // 旧仓 `_UNUSABLE_REASONS` 写的是 `"too_small"`，而 `find_lattice_peaks` 报的是
    // `"image_too_small"` —— 两个串对不上，于是「帧太小」被算成「可用帧上没有晶格」。
    // 照移（登记 deviation），并在这里把它钉住：哪天有人「顺手」改好了那个串，
    // 这条会红，而那时该先问的是「下游的四态表跟着变了吗」。
    const rows = GOLDEN['independent_pair'] as any[]
    expect(rows.find((r) => r.case === 'half_nan_a').reason).toBe('incomplete_frame')
    const tiny = findLatticePeaks(matFromRows([[1, 2], [3, 4]]), 0.02)
    expect(tiny.reason).toBe('image_too_small')
  })

  it('四个态各有一格，而且它们指向四种**不同的下一步**', () => {
    const got = new Map((GOLDEN['assess_atomic_consistency'] as any[]).map((c) => [c.case, c.result.verdict]))
    expect(got.get('consistent')).toBe('consistent')
    expect(got.get('inconsistent_period')).toBe('inconsistent')
    expect(got.get('absent')).toBe('absent')
    expect(got.get('no_usable_frame')).toBe('undetermined')
    // 而**残帧**与**可用帧上没有晶格**必须分开记 —— 合成一个数就塌成两态了。
    const nf = (GOLDEN['assess_atomic_consistency'] as any[]).find((c) => c.case === 'no_usable_frame').result
    expect([nf.n_unusable, nf.n_no_lattice]).toEqual([2, 0])
    const ab = (GOLDEN['assess_atomic_consistency'] as any[]).find((c) => c.case === 'absent').result
    expect([ab.n_unusable, ab.n_no_lattice]).toEqual([0, 2])
  })

  it('取向**先扣掉扫描角**再比 —— 不扣的话同一个晶格会被判成两个', () => {
    const rows = GOLDEN['assess_atomic_consistency'] as any[]
    expect(rows.find((c) => c.case === 'consistent_rotated').result.verdict).toBe('consistent')
    // 同样两帧、把角度谎报成 0 ⇒ 判 `inconsistent`。**这一格是那道减法的唯一入口**。
    expect(rows.find((c) => c.case === 'rotated_but_angles_zero').result.verdict).toBe('inconsistent')
  })

})
