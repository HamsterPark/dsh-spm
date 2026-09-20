/**
 * 势垒链三件 —— `MeasureBarrierHeight` · `MapBarrierHeight` · `CleanTipUntilBarrier`。
 *
 * 三个必须同批：后两个差的那**一件**就是第一个（`MapBarrierHeight` 每个位置调它一次，
 * `CleanTipUntilBarrier` 每一步调它一次）。分开做等于把同一条链搬两次。
 *
 * ## 这条链治的是什么
 *
 * 有效势垒明显低于真空参照时，电流对横向位置可能不敏感，原子分辨与 STS 也可能
 * 缺少结构。修针改变的是针尖形状，不能直接去除结中的污染层，因此在投入长流程前
 * 先测势垒可以区分形状问题与隧穿结问题。该解释来自参考系统观测，尚未在本仓独立验证。
 *
 * 三个技能各自回答链条上的一个问题：
 *
 * | 技能 | 问题 | 它**不**回答什么 |
 * |---|---|---|
 * | `MeasureBarrierHeight` | 这根针尖和这片表面之间是不是真空？ | 污染在针尖侧还是表面侧 —— **单点测不出来** |
 * | `MapBarrierHeight` | 那层东西在针尖上还是在表面上？ | 靠的是**同点重复作噪声标尺**，没有它位置间的散布读不出任何意义 |
 * | `CleanTipUntilBarrier` | 修针有没有让它变好？ | 不换针尖、不动粗动、不找平区 |
 *
 * ## 一处刻意的重复：符号只有一个真源
 *
 * `checkDirection` 把 `sign` **写进 `info` 再从 `info` 里取**，而不是「info 里记一份、
 * return 一个字面量」。旧仓那条注释记着为什么：变异验证发现改了记录行为却不变 ——
 * 那种双真源哪天漂开，报告里的 `sign` 就会说谎。
 */
import { pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
// ⚠️ 求和分两族，**别混**（`numerics/stats.ts` 与 `pairwise.ts` 两处抬头都写着）：
// 旧仓这几处写的是 `np.mean` / `np.std`（成对求和）⇒ 走 `npMean` / `npStd`；
// 写 `sum()` 的那几处（`optics_acquire.mean_std` / `coarse_step_calib`）走 `pySum`。
import { npMean, npStd, polyfit } from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { fail, ok } from '../l0/common.js'

// ── 常数（逐个照移，出处写在旁边）─────────────────────────────────────────

/** κ = √(2mφ)/ħ 的工程写法：κ[1/nm] = 5.123 · √(φ[eV])。 */
export const KAPPA_PER_SQRT_EV = 5.123

/** 真空隧穿的参照（金属功函数 4–5 eV）。判读时用它做分母。 */
export const VACUUM_PHI_EV = 4.0

/** 默认退开序列（nm）。**前密后疏** —— 电流按指数掉，等间距会把大半点浪费在噪声底上。 */
export const DEFAULT_OFFSETS_NM: readonly number[] = [0.0, 0.1, 0.2, 0.3, 0.4, 0.55]

/**
 * 单次 `AcquireSTS` 的时长上限（s）。**这不是性能建议，是硬约束**：
 * 单次阻塞 Nanonis 调用超过约 5 s 会被连接层重置（08-26 二分实测 3.2 s 通过 /
 * 5.1 s 报 ConnectionResetError，而连接立刻自恢复、读数正常，看起来像偶发故障）。
 * 留一半余量。
 */
export const MAX_SWEEP_S = 3.0

/** 方向试探用的小步长（nm）。够大到能看出电流变化，够小到即使符号搞反也不会撞针。 */
export const PROBE_NM = 0.1

/** 判读的两条边（位置间散布 ÷ 同点重复散布）。中间留一段「不硬判」。 */
export const TIP_SIDE_MAX = 2.0
export const SURFACE_SIDE_MIN = 3.0

/** 重复次数下限 —— 它是整个判读的**分母**，分母不可信则结论不可信。 */
export const MIN_REPEATS = 4

/** 位置数下限。三个点算不出可信的空间散布。 */
export const MIN_SITES = 4

/** 默认目标势垒（eV）。3.0 是 `MeasureBarrierHeight` 判 clean 的线。 */
export const DEFAULT_TARGET_EV = 3.0

/**
 * 修针动作阶梯。**先扎后脉冲** —— 2 nm 以内的扎针比脉冲温和得多。
 * 深度只在 0.5–0.8 nm：08-26 实测 1.2/1.6 nm 反而让 RMS 从 226 回到 515/419。
 */
export const LADDER: readonly (readonly ['poke' | 'pulse', number])[] = [
  ['poke', 0.5],
  ['poke', 0.5],
  ['poke', 0.8],
  ['pulse', 3.0],
  ['pulse', -3.0],
  ['pulse', 4.0],
  ['pulse', -4.0],
]

/** 连续多少步没改善就停。 */
export const MAX_STALE = 3

/**
 * 「变好」的门槛：φ 至少要涨这么多才算数，否则是测量噪声。
 * 08-27 实测同点重复散布 12.7%，所以 15% 是噪声之上的第一个刻度。
 */
export const IMPROVE_FRAC = 0.15

// ── 判据本体（纯函数，单测直接打在这些上）───────────────────────────────

export interface KappaFit {
  readonly kappa_per_nm: number
  readonly phi_ev: number
  readonly decade_nm: number
  readonly n_fit: number
  readonly fit_resid_rms: number
}

/** `(退开 nm, |I| pA)` 一条。`null` = 那一档读不到电流。 */
export type BarrierPoint = readonly [number, number | null]

/**
 * `_fit_kappa` —— 对 `ln|I| = −2κ·d + c` 拟合，**只用未触底的点**。
 *
 * 触底的读数是「读不到」，不是电流值。08-26 第一次算把 0.045 pA 的底噪点喂了进去，
 * 斜率被拉平，得出 φ=0.18 eV；剔掉之后是 0.92 eV。**五倍的差别，全来自这一步。**
 *
 * 斜率非负 = 退开反而电流变大，物理上讲不通（多半是方向弄反或针尖跳了）⇒ 不给数。
 */
export function fitKappa(
  points: readonly BarrierPoint[],
  noiseFloorPa: number,
): { fit: KappaFit | null; usable: BarrierPoint[] } {
  const usable = points.filter((p): p is readonly [number, number] => p[1] !== null && p[1] > noiseFloorPa)
  if (usable.length < 3) return { fit: null, usable: [...usable] }
  const d = usable.map((p) => p[0])
  const lnI = usable.map((p) => Math.log(p[1]))
  const coeffs = polyfit(d, lnI, 1)
  const slope = coeffs[0] as number
  const intercept = coeffs[1] as number
  if (!Number.isFinite(slope) || slope >= 0) return { fit: null, usable: [...usable] }
  const kappa = -slope / 2.0
  const resid2 = d.map((x, i) => ((lnI[i] as number) - (slope * x + intercept)) ** 2)
  return {
    fit: {
      kappa_per_nm: kappa,
      phi_ev: (kappa / KAPPA_PER_SQRT_EV) ** 2,
      decade_nm: Math.log(10.0) / Math.abs(slope),
      n_fit: usable.length,
      fit_resid_rms: Math.sqrt(npMean(resid2)),
    },
    usable: [...usable],
  }
}

/** `_verdict` —— 把 φ 翻成一句能据以决策的话。阈值取自 08-26 实测与教科书真空值之间。 */
export function barrierVerdict(phiEv: number): readonly [string, string] {
  if (phiEv >= 3.0) {
    return ['clean', `φ ${pyFixed(phiEv, 2)} eV 接近真空值 —— 针尖与表面都干净，原子分辨与 STS 值得投入。`]
  }
  if (phiEv >= 1.0) {
    return [
      'contaminated',
      `φ ${pyFixed(phiEv, 2)} eV 只有真空值的 ${pyFixed((100.0 * phiEv) / VACUUM_PHI_EV, 0)}% —— ` +
        '针尖与样品之间隔着一层东西。原子分辨与 STS 大概率做不成；**先处理污染，别先投入整夜**。',
    ]
  }
  return [
    'not_vacuum',
    `φ ${pyFixed(phiEv, 2)} eV —— 这已经不是真空隧穿结。在这根针尖／这片表面上排查 STS 是浪费时间；` +
      '修针改的是形状，改不了中间那层东西（08-26 实测十次修针全部无效）。',
  ]
}

/**
 * `_rel_spread` —— 相对散布（σ/μ，**总体标准差**，同 `np.std` 的 `ddof=0`）。
 *
 * 少于 2 个值返回 `null`（**不是 0**）—— 那是「没有」不是「很小」。
 */
export function relSpread(values: readonly (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => x !== null && x !== undefined)
  if (v.length < 2) return null
  const m = npMean(v)
  if (!(m > 0)) return null
  return npStd(v, 0) / m
}

/**
 * 位置间散布与重复散布之比 → 判读。
 *
 * 两个都要有值才判 —— 缺任何一个都是 `undetermined`，不是「没差别」。
 */
export function verdictFrom(
  siteSpread: number | null,
  repeatSpread: number | null,
): readonly [string, number | null] {
  if (siteSpread === null || repeatSpread === null) return ['undetermined', null]
  if (repeatSpread <= 0) return ['undetermined', null]
  const ratio = siteSpread / repeatSpread
  if (ratio <= TIP_SIDE_MAX) return ['tip_side', ratio]
  if (ratio >= SURFACE_SIDE_MIN) return ['surface_side', ratio]
  return ['inconclusive', ratio]
}

/** `_parse_sites` —— `'x1,y1; x2,y2; …'` → 坐标表 + 解析不了的原样留着。 */
export function parseSites(raw: unknown): { sites: (readonly [number, number])[]; bad: string[] } {
  const sites: (readonly [number, number])[] = []
  const bad: string[] = []
  for (const chunkRaw of String(raw ?? '').split(';')) {
    const chunk = chunkRaw.trim()
    if (chunk === '') continue
    const parts = chunk.split(',')
    if (parts.length !== 2) {
      bad.push(chunk)
      continue
    }
    const x = pyFloat(parts[0] as string)
    const y = pyFloat(parts[1] as string)
    if (x === null || y === null) {
      bad.push(chunk)
      continue
    }
    sites.push([x, y])
  }
  return { sites, bad }
}

/** Python 的 `float(s)`：吃前后空白，认 `inf`/`nan`，空串抛（这里给 `null`）。 */
function pyFloat(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/i.test(t)) return Number.NaN
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null
  return Number(t)
}

/** `statistics.median` —— 偶数个取中间两个的平均。 */
export function median(xs: readonly number[]): number {
  const a = [...xs].sort((p, q) => p - q)
  const n = a.length
  const mid = Math.floor(n / 2)
  return n % 2 === 1 ? (a[mid] as number) : ((a[mid - 1] as number) + (a[mid] as number)) / 2
}

// ── MeasureBarrierHeight ────────────────────────────────────────────────

/** 每一步之间的稳定时间（s）。旧仓是类属性，好让测试缩短它 —— 这里是注入口。 */
export interface BarrierDeps {
  readonly settleS?: number
}

const data0 = (r: SkillResultLike): Record<string, unknown> =>
  (r.data as Record<string, unknown> | undefined) ?? {}

/**
 * `_arm_sts` —— 自己配好 STS 的通道与时序，**不依赖上一个技能留下的状态**。
 *
 * 2026-08-26 现场定的原则：每个技能在一开始制定自己的工作点。归还依赖上游善后，
 * 而上游可能中途 abort、可能被跳过、本来也没这个义务。
 *
 * ⚠️ 漏传 `max_slew_rate_v_s` 会让整条 `ConfigureSTSTiming` 被参数校验拒掉，
 * 而后续采集照常跑（用旧时序）—— 现场看起来像「这一步没做」。
 * 与 `SetZCtrlGain` 必须同时传三个增益是同一个形状。
 */
async function armSts(ctx: SkillContext, pointsPerStep: number): Promise<Record<string, unknown>> {
  const integ = Math.max(0.002, Math.min(0.01, (MAX_SWEEP_S / Math.max(pointsPerStep, 1)) * 0.6))
  const settl = integ * 0.5
  const est = pointsPerStep * (integ + settl)
  const chan = await ctx.runSkill('ConfigureSTSChannels', { channel_indexes: '0,24,30' })
  const tim = await ctx.runSkill('ConfigureSTSTiming', {
    integration_s: integ,
    settling_s: settl,
    init_settling_s: 0.03,
    z_avg_time_s: 0.02,
    end_settling_s: 0.004,
    max_slew_rate_v_s: 1000.0,
    z_offset_m: 0.0,
  })
  return {
    channels_ok: chan.success === true,
    timing_ok: tim.success === true,
    integration_s: integ,
    settling_s: settl,
    est_sweep_s: est,
    sweep_budget_s: MAX_SWEEP_S,
  }
}

/** `_read_at` —— 在给定退开量处采一小段偏压扫，返回 `|I|` 的均值（pA）。 */
async function readAt(
  ctx: SkillContext,
  offsetNm: number,
  biasV: number,
  npts: number,
): Promise<number | null> {
  const span = Math.max(0.05, Math.abs(biasV) * 0.2)
  await ctx.runSkill('ConfigureSTS', {
    start_v: biasV - span / 2.0,
    end_v: biasV + span / 2.0,
    num_points: Math.trunc(npts),
    z_offset_m: offsetNm * 1e-9,
  })
  const res = await ctx.runSkill('AcquireSTS', { save_basename: '' })
  const d = data0(res)
  if (d['spectrum_parsed'] !== true) return null
  const cur = d['Current (A)']
  // Python 的 `if not cur`：`None` / 空表都算「没有」。
  if (!Array.isArray(cur) || cur.length === 0) return null
  const arr = cur.map((x) => Math.abs(Number(x))).filter((x) => Number.isFinite(x))
  if (arr.length === 0) return null
  return npMean(arr) * 1e12
}

/**
 * `_check_direction` —— **退开方向必须实测，不能猜。**
 *
 * `z_offset` 的符号约定弄反 = 每一步都在往样品里扎。08-26 第一次就猜反了
 * （靠近 2 nm 直接把电流打到 10 nA 满量程）。所以先走一小步 `PROBE_NM`：
 * 电流变小才是远离，才继续；变大就翻符号；都不明显就拒绝往下做。
 */
async function checkDirection(
  ctx: SkillContext,
  biasV: number,
  npts: number,
): Promise<{ sign: number | null; info: Record<string, unknown> }> {
  const base = await readAt(ctx, 0.0, biasV, npts)
  if (base === null || base <= 0) {
    return { sign: null, info: { reason: '基准点读不到电流', base_pa: base } }
  }
  const probe = await readAt(ctx, PROBE_NM, biasV, npts)
  if (probe === null) {
    return { sign: null, info: { reason: '试探点读不到电流', base_pa: base } }
  }
  const ratio = probe / base
  const info: Record<string, unknown> = { base_pa: base, probe_pa: probe, ratio, probe_nm: PROBE_NM }
  // ⚠️ 符号只有一个真源：写进 `info` 的那个就是返回的那个（见文件抬头）。
  if (ratio < 0.85) {
    info['sign'] = 1.0
    return { sign: info['sign'] as number, info }
  }
  if (ratio > 1.2) {
    info['sign'] = -1.0
    info['note'] = '正 z_offset 使电流上升 ⇒ 本机正号是靠近，已翻转'
    return { sign: info['sign'] as number, info }
  }
  info['reason'] =
    `退开 ${pyFixed(PROBE_NM, 2)} nm 电流只变了 ${pyFixed(100 * (ratio - 1), 0)}% —— ` +
    '距离依赖太弱，多半没在隧穿区，不继续。'
  return { sign: null, info }
}

/** Python 的 `repr(str)`。 */
function reprStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Python 的 `x or d`（`0` / `''` / `None` 都算假）。 */
function orDefault(v: unknown, d: number): number {
  if (v === undefined || v === null) return d
  const n = Number(v)
  if (!Number.isFinite(n) && Number.isNaN(n)) return d
  return n === 0 ? d : n
}

export function makeMeasureBarrierHeight(deps: BarrierDeps = {}): Skill {
  const settleS = deps.settleS ?? 0.4
  return {
    spec: S.MeasureBarrierHeightSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const npts = Math.trunc(orDefault(params['points_per_step'], 9))
      const rawOffsets = String(params['offsets_nm'] ?? '').trim()
      let offsets: number[]
      if (rawOffsets !== '') {
        const parsed: number[] = []
        for (const t of rawOffsets.split(',')) {
          if (t.trim() === '') continue
          const v = pyFloat(t)
          if (v === null) {
            return fail(`offsets_nm 解析不了：${reprStr(rawOffsets)}（要的是逗号分隔的数字，单位 nm）`)
          }
          parsed.push(Math.abs(v))
        }
        offsets = parsed
      } else {
        offsets = [...DEFAULT_OFFSETS_NM]
      }
      // `sorted(set(...))` —— 去重再升序。
      offsets = [...new Set(offsets)].sort((a, b) => a - b)
      if (offsets.length < 4) {
        return fail(`至少要 4 档退开量才拟合得动（给了 ${offsets.length} 档）。`)
      }

      let biasV: number
      const given = params['bias_v']
      if (given === undefined || given === null) {
        const rec = await ctx.runSkill('GetBias', {})
        const got = data0(rec)['bias_v']
        if (got === undefined || got === null) {
          return fail('没给 bias_v，也读不到当前偏压 —— 不猜一个值去量。')
        }
        biasV = Number(got)
      } else {
        await ctx.runSkill('SetBias', { bias_v: Number(given) })
        await ctx.sleep(settleS * 1000)
        biasV = Number(given)
      }

      const arm = await armSts(ctx, npts)
      const { sign, info: dirinfo } = await checkDirection(ctx, biasV, npts)
      if (sign === null) {
        return ok({
          verdict: 'undetermined',
          direction_check: dirinfo,
          sts_setup: arm,
          bias_v: biasV,
          message:
            `量不了势垒：${String(dirinfo['reason'] ?? '方向确认失败')}` +
            ' —— 这不是「势垒很低」，是「没测到」，两者驱动的下一步不同。',
        })
      }

      const points: BarrierPoint[] = []
      for (const off of offsets) {
        const val = await readAt(ctx, sign * off, biasV, npts)
        points.push([off, val])
        await ctx.sleep(settleS * 0.5 * 1000)
      }
      await ctx.runSkill('ConfigureSTS', {
        start_v: biasV,
        end_v: biasV,
        num_points: Math.trunc(npts),
        z_offset_m: 0.0,
      })

      const vals = points.map((p) => p[1]).filter((v): v is number => v !== null)
      if (vals.length === 0) {
        return ok({
          verdict: 'undetermined',
          points,
          sts_setup: arm,
          direction_check: dirinfo,
          bias_v: biasV,
          message: '所有档位都没读到电流 —— 没测到，不是势垒低。',
        })
      }

      let floor: number
      let floorSrc = 'explicit'
      const explicit = params['noise_floor_pa']
      if (explicit === undefined || explicit === null) {
        const tail = points.slice(-2).map((p) => p[1]).filter((v): v is number => v !== null)
        floor = tail.length > 0 ? npMean(tail) * 2.0 : 0.0
        floorSrc = 'auto(最远两档均值×2)'
      } else {
        floor = Number(explicit)
      }

      const { fit, usable } = fitKappa(points, floor)
      const common: Record<string, unknown> = {
        bias_v: biasV,
        points,
        noise_floor_pa: floor,
        noise_floor_source: floorSrc,
        n_usable: usable.length,
        sts_setup: arm,
        direction_check: dirinfo,
        vacuum_reference_ev: VACUUM_PHI_EV,
      }
      if (fit === null) {
        return ok({
          ...common,
          verdict: 'undetermined',
          message:
            `可用点只有 ${usable.length} 个（噪声底 ${pyFixed(floor, 3)} pA 之上），拟合不动 —— **判不了**。` +
            '电流可能掉得太快（把 offsets 收密些再来），也可能根本没在隧穿。' +
            '这和「势垒很低」是两回事。',
        })
      }
      const [verdict, msg] = barrierVerdict(fit.phi_ev)
      return ok({
        ...common,
        verdict,
        message: msg,
        ...fit,
        phi_fraction_of_vacuum: fit.phi_ev / VACUUM_PHI_EV,
        vacuum_decade_nm: Math.log(10.0) / (2 * KAPPA_PER_SQRT_EV * Math.sqrt(VACUUM_PHI_EV)),
      })
    },
  }
}

export const MeasureBarrierHeight: Skill = makeMeasureBarrierHeight()

// ── MapBarrierHeight ────────────────────────────────────────────────────

interface SiteRow {
  readonly xy_nm: readonly [number, number]
  readonly verdict: unknown
  readonly phi_ev: unknown
  readonly kappa_per_nm: unknown
  readonly n_fit: unknown
}

async function measureAt(
  ctx: SkillContext,
  xNm: number,
  yNm: number,
  biasV: unknown,
  hopM: number,
): Promise<SiteRow> {
  await ctx.runSkill('ScanAt', {
    center_x_m: xNm * 1e-9,
    center_y_m: yNm * 1e-9,
    size_m: hopM,
    pixels: 64,
    line_time_s: 0.04,
    purpose: 'survey',
  })
  const p: Record<string, unknown> = {}
  if (biasV !== undefined && biasV !== null) p['bias_v'] = Number(biasV)
  const res = await ctx.runSkill('MeasureBarrierHeight', p)
  const d = data0(res)
  return {
    xy_nm: [xNm, yNm],
    verdict: d['verdict'] ?? null,
    phi_ev: d['phi_ev'] ?? null,
    kappa_per_nm: d['kappa_per_nm'] ?? null,
    n_fit: d['n_fit'] ?? null,
  }
}

const phiOf = (r: SiteRow): number | null => (typeof r.phi_ev === 'number' ? r.phi_ev : null)

export const MapBarrierHeight: Skill = {
  spec: S.MapBarrierHeightSpec,
  validateParams: (params): string[] => {
    const errors: string[] = []
    const { sites, bad } = parseSites(params['sites_nm'])
    if (bad.length > 0) {
      errors.push(`sites_nm 里有解析不了的项：${bad.slice(0, 4).join('; ')}（每项写成 \`x,y\`，分号分隔）`)
    } else if (sites.length < MIN_SITES) {
      errors.push(`至少要 ${MIN_SITES} 个位置才算得出可信的空间散布（给了 ${sites.length}）`)
    }
    return errors
  },
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // ⚠️ **不要假设 `validateParams` 一定跑过。** `execute` 可能被直接调用
    // （诊断路径、守卫测试、别的 composite 内部）。抛异常的技能到不了
    // agent 的错误处理路径 —— 没有 SkillResult、没有诊断记录、没有 HITL、
    // 没有恢复，只剩一个死掉的回合。
    // （2026-08-27 由 `test_all_skills_execute` 抓到：`sites_nm='0'` ⇒ IndexError。）
    const { sites, bad } = parseSites(params['sites_nm'])
    if (bad.length > 0 || sites.length < MIN_SITES) {
      return fail(
        `sites_nm 至少要 ${MIN_SITES} 个位置，每项写成 \`x,y\`（nm），分号分隔。` +
          `收到 ${sites.length} 个可用位置${bad.length > 0 ? `，解析不了的：${bad.slice(0, 4).join('; ')}` : ''}`,
      )
    }
    const repeats = Math.trunc(orDefault(params['repeats'], 6))
    if (repeats < MIN_REPEATS) {
      return fail(
        `repeats 至少 ${MIN_REPEATS} —— 它是判读的**分母**（位置间散布 ÷ 重复散布），` +
          '次数太少这个分母本身就不可信，整个结论跟着不可信。',
      )
    }
    const biasV = params['bias_v']
    const hopM = orDefault(params['hop_size_m'], 3e-9)

    // ① 噪声标尺：第一个位置重复测
    const [rx, ry] = sites[0] as readonly [number, number]
    const rep: SiteRow[] = []
    for (let i = 0; i < repeats; i += 1) rep.push(await measureAt(ctx, rx, ry, biasV, hopM))
    const repPhi = rep.map(phiOf).filter((x): x is number => x !== null)
    const repeatSpread = relSpread(repPhi)

    // ② 各位置各一条
    const perSite: SiteRow[] = []
    for (const [x, y] of sites) perSite.push(await measureAt(ctx, x, y, biasV, hopM))
    const sitePhi = perSite.map(phiOf).filter((x): x is number => x !== null)
    const siteSpread = relSpread(sitePhi)

    const [verdict, ratio] = verdictFrom(siteSpread, repeatSpread)
    const nUndet = [...perSite, ...rep].filter((r) => r.verdict === 'undetermined').length

    let message: string
    if (verdict === 'surface_side') {
      message =
        `位置间散布是同点重复的 ${pyFixed(ratio as number, 1)} 倍 ⇒ **势垒有真实的空间结构，那层东西在表面上**。` +
        '换样品能解决；修针改的是针尖形状，不能直接去除表面侧结构。'
    } else if (verdict === 'tip_side') {
      message =
        `位置间散布只有同点重复的 ${pyFixed(ratio as number, 1)} 倍 ⇒ **各处一样，跟着针尖走**。` +
        '该处理的是针尖，换地方没用。'
    } else if (verdict === 'inconclusive') {
      message =
        `位置间散布是同点重复的 ${pyFixed(ratio as number, 1)} 倍，落在 ` +
        `${pyFixed(TIP_SIDE_MAX, 0)}–${pyFixed(SURFACE_SIDE_MIN, 0)} 之间的灰带里 —— **不硬判**。` +
        '「针尖侧」和「表面侧」驱动的下一步相反（换针尖 vs 换样品），猜错要赔一整轮。加位置、加重复次数再来。'
    } else {
      const why =
        repeatSpread === null ? '重复测没得出可用的 φ' : siteSpread === null ? '各位置没得出足够的 φ' : '散布算不出来'
      message = `判不了：${why}。**这不是「没有差别」** —— 没有噪声标尺，位置间的散布读不出任何意义。`
    }

    return ok({
      verdict,
      message,
      spread_ratio: ratio,
      site_spread: siteSpread,
      repeat_spread: repeatSpread,
      repeat_site_nm: [rx, ry],
      n_repeats: repPhi.length,
      n_sites_measured: sitePhi.length,
      n_sites_requested: sites.length,
      n_undetermined: nUndet,
      phi_median_ev: sitePhi.length > 0 ? median(sitePhi) : null,
      phi_min_ev: sitePhi.length > 0 ? Math.min(...sitePhi) : null,
      phi_max_ev: sitePhi.length > 0 ? Math.max(...sitePhi) : null,
      per_site: perSite,
      repeats: rep,
      tip_side_max_ratio: TIP_SIDE_MAX,
      surface_side_min_ratio: SURFACE_SIDE_MIN,
    })
  },
}

// ── CleanTipUntilBarrier ────────────────────────────────────────────────

function poke(ctx: SkillContext, depthNm: number): Promise<SkillResultLike> {
  return ctx.runSkill('TipShape', {
    tip_lift_m: -Math.abs(depthNm) * 1e-9,
    lift_height_m: Math.abs(depthNm) * 1e-9,
    lift_time_1_s: 0.1,
    lift_time_2_s: 0.1,
    bias_lift_v: 0.02,
    change_bias: false,
    bias_settling_s: 0.5,
    end_wait_s: 0.2,
    restore_feedback: true,
  })
}

/**
 * ⭐ **脉冲之后必须扎针稳定** —— 08-26 用户当场定的规则。
 * 对照实测（三方向幅值平衡度）：只脉冲不扎针 均值 0.24；脉冲后扎针 0.55。
 */
async function pulse(ctx: SkillContext, volts: number): Promise<SkillResultLike> {
  const res = await ctx.runSkill('BiasPulse', {
    bias_v: volts,
    width_s: 0.05,
    z_hold: true,
    absolute: true,
  })
  await poke(ctx, 0.5)
  return res
}

async function measurePhi(
  ctx: SkillContext,
  biasV: unknown,
): Promise<readonly [number | null, unknown]> {
  const p: Record<string, unknown> = {}
  if (biasV !== undefined && biasV !== null) p['bias_v'] = Number(biasV)
  const res = await ctx.runSkill('MeasureBarrierHeight', p)
  const d = data0(res)
  const phi = d['phi_ev']
  return [typeof phi === 'number' ? phi : null, d['verdict'] ?? null]
}

export const CleanTipUntilBarrier: Skill = {
  spec: S.CleanTipUntilBarrierSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const target = orDefault(params['target_phi_ev'], DEFAULT_TARGET_EV)
    const maxSteps = Math.trunc(orDefault(params['max_steps'], 7))
    const biasV = params['bias_v']

    const [phi0, verdict0] = await measurePhi(ctx, biasV)
    const base = { phi_ev: phi0, verdict: verdict0 }
    if (phi0 === null) {
      return {
        success: false,
        error:
          '基线势垒**判不了** —— 在没有判据的情况下动针尖，正是这个技能存在的理由所要避免的。先把 I–Z 量出来再说。',
        data: { baseline: base, steps: [] },
      }
    }

    // ★ 已达标就一步都不做。这是本技能最重要的一条。
    if (phi0 >= target) {
      return ok({
        outcome: 'already_clean',
        baseline: base,
        phi_ev: phi0,
        target_phi_ev: target,
        steps: [],
        message:
          `基线 φ=${pyFixed(phi0, 2)} eV 已达标（≥${pyFixed(target, 2)}）—— **一步都没做**。` +
          '针尖不需要修；在没有判据支持时动针尖，只会把好针尖弄坏。',
      })
    }

    let bestPhi = phi0
    let bestAt = 'baseline'
    const steps: Record<string, unknown>[] = []
    let stale = 0
    for (let i = 0; i < Math.min(maxSteps, LADDER.length); i += 1) {
      const [kind, arg] = LADDER[i] as readonly ['poke' | 'pulse', number]
      const act = kind === 'pulse' ? await pulse(ctx, arg) : await poke(ctx, arg)
      const actOk = act.success === true
      // 修针流程会改工作点且不改回来（08-26 栽过两次）—— 回读并如实记录
      const br = await ctx.runSkill('GetBias', {})
      const biasAfter = data0(br)['bias_v'] ?? null
      const [phi, verdict] = await measurePhi(ctx, biasV)
      const row: Record<string, unknown> = {
        step: i + 1,
        action: kind,
        arg,
        action_ok: actOk,
        bias_after_v: biasAfter,
        phi_ev: phi,
        verdict,
      }
      steps.push(row)
      if (!actOk) {
        row['stopped'] = '动作失败'
        break
      }
      if (phi === null) {
        // 「没测到」≠「没变好」：不计入 stale，也不当成变差
        row['note'] = '势垒判不了 —— 不计入改善判断'
        continue
      }
      if (phi > bestPhi * (1.0 + IMPROVE_FRAC)) {
        bestPhi = phi
        bestAt = `step${i + 1}`
        stale = 0
        row['improved'] = true
      } else {
        stale += 1
      }
      if (phi >= target) {
        row['stopped'] = '达标'
        break
      }
      if (phi < bestPhi * (1.0 - IMPROVE_FRAC) && bestAt !== 'baseline') {
        row['stopped'] = '变差 —— 立刻停'
        break
      }
      if (stale >= MAX_STALE) {
        row['stopped'] = `连续 ${MAX_STALE} 步没改善`
        break
      }
    }

    const reached = bestPhi >= target
    return ok({
      outcome: reached ? 'reached' : 'not_reached',
      baseline: base,
      target_phi_ev: target,
      best_phi_ev: bestPhi,
      best_at: bestAt,
      final_phi_ev: steps.length > 0 ? ((steps[steps.length - 1] as Record<string, unknown>)['phi_ev'] ?? null) : phi0,
      n_steps: steps.length,
      steps,
      message:
        `φ ${pyFixed(phi0, 2)} → ${pyFixed(bestPhi, 2)} eV（最好出现在 ${bestAt}），` +
        `${reached ? '已达到' : '未达到'}目标 ${pyFixed(target, 2)}。` +
        '**交出的是过程中最好的那个状态，不是最后那个。**',
    })
  },
}

/** 势垒链三件（`builtins.barrier_height` / `barrier_map` / `clean_tip`，各 1/1）。 */
export const BARRIER_CHAIN: Readonly<Record<string, Skill>> = {
  MeasureBarrierHeight,
  MapBarrierHeight,
  CleanTipUntilBarrier,
}
