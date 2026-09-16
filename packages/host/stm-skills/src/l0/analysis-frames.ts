/**
 * 帧级分析的四个技能 —— `MeasureStepHeight` · `AssessFrameTrust` ·
 * `LocateStepEdge` · `AssessFrameCorrugation`。
 *
 * 前两个共用 K2 平面族（`noiseFloor` + `fitPlaneRobust` + `planeSubtractRobust`），
 * 后两个各自自足。四个都**只读文件、不碰硬件**，判据一条都不在这一层。
 */
import { existsSync } from 'node:fs'
import {
  judgeCorrugation,
  resolveScanPrepThresholds,
  resolveThresholdPair,
  pyFixed,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { matOf, type Mat } from 'dsh-spm-numerics'
import {
  acquiredRowMask,
  applyPlane,
  badRowFrac,
  cropRows,
  finiteCount,
  fitPlaneRobust,
  judgeFrame,
  levelsOf,
  locateStepEdge,
  nanStd,
  planeSubtractRobust,
  ptpFinite,
  rowBigJumps,
  rowJumpMadPm,
  rowJumpSigmaPm,
} from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { loadSxm, numOr, numParam, orient, strParam } from './analysis-common.js'

// ── MeasureStepHeight ──────────────────────────────────────────────────────

/** `round(x, n)` 的 Python 语义（**四舍六入五成双**），返回**数**而不是串。 */
function pyRound(x: number, n: number): number {
  return Number(pyFixed(x, n))
}

/** Python 的 `"%+.2f"` —— 非负数也带符号。`pyFixed` 已经把舍入做对了，这里只加号。 */
function pyFixedSigned(x: number, n: number): string {
  const s = pyFixed(x, n)
  return s.startsWith('-') ? s : `+${s}`
}

export const MeasureStepHeight: Skill = {
  spec: S.MeasureStepHeightSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const scanPath = String(params['scan_path'] ?? '')
    const channelName = strParam(params, 'channel', 'Z')
    const sigmaPm = numParam(params, 'sigma_pm')
    const minGap = numOr(params, 'min_gap_pm', 120.0)
    const maxGap = numOr(params, 'max_gap_pm', 400.0)
    if (!existsSync(scanPath)) return { success: false, error: `文件不存在: ${scanPath}` }
    const load = loadSxm(scanPath)
    if (!load.ok) return { success: false, error: `读取失败: ${load.plain}` }
    const scan = load.scan
    const frames = orient(scan, channelName)
    if (frames.forward === null) {
      return { success: false, error: `通道 '${channelName}' 在这个文件里没有数据` }
    }
    const acqRaw = String(scan.header['acq_time'] ?? '0').trim().split(/\s+/)[0] ?? '0'
    const acqNum = Number(acqRaw)
    const acq = Number.isFinite(acqNum) ? acqNum : 0

    // `sigma_pm` 走 Python 的 `if sigma_pm:` —— **0 与 None 同义**（都是「自己去量」）。
    // 这一条与 D-ZERO-1 刻意相反：0 pm 的噪声尺度不是一个合法的内点阈，
    // 它会让 `|r| < 0` 永远不成立。参数下界 0.01 也在替它挡着。
    const sigmaM = sigmaPm !== null && sigmaPm !== 0 ? sigmaPm * 1e-12 : null
    const out: Record<string, unknown> = {
      scan_path: scanPath,
      channel: channelName,
      width_nm: frames.width_nm,
      nm_per_px: frames.nm_per_px,
    }
    const lines = frames.forward.rows
    out['line_time_s'] = acq > 0 && lines > 0 ? acq / (2 * lines) : null

    const perDir: Record<string, Record<string, unknown>> = {}
    for (const direction of ['forward', 'backward'] as const) {
      const block = frames[direction]
      if (block === null) continue
      const fit = fitPlaneRobust(block, { sigma: sigmaM })
      if (fit === null) {
        perDir[direction] = { ok: false, why: '平面拟合失败' }
        continue
      }
      const flat = applyPlane(block, fit.a, fit.b, fit.c)
      const flatPm = Float64Array.from(flat.data, (v) => v * 1e12)
      const peaks = levelsOf(flatPm)
      const gaps: number[] = []
      for (let i = 0; i + 1 < peaks.length; i += 1) {
        gaps.push((peaks[i + 1] as readonly [number, number])[0] - (peaks[i] as readonly [number, number])[0])
      }
      const kept = gaps.filter((g) => g >= minGap && g <= maxGap)
      const entry: Record<string, unknown> = {
        ok: kept.length > 0,
        inlier_ratio: pyRound(fit.inlierRatio, 4),
        n_levels: peaks.length,
        levels_pm: peaks.map((p) => pyRound(p[0], 2)),
        gaps_pm: gaps.map((g) => pyRound(g, 2)),
        kept_gaps_pm: kept.map((g) => pyRound(g, 2)),
        step_pm: kept.length > 0 ? pyRound(medianOf(kept), 2) : null,
      }
      if (kept.length === 0) {
        entry['why'] =
          peaks.length > 0
            ? `没有落在 [${pyFixed(minGap, 0)}, ${pyFixed(maxGap, 0)}] pm 里的台面对`
            : '找不到台面(高度分布是单峰)'
      }
      perDir[direction] = entry
    }
    out['per_direction'] = perDir

    const fwd = (perDir['forward']?.['step_pm'] ?? null) as number | null
    const bwd = (perDir['backward']?.['step_pm'] ?? null) as number | null
    if (fwd !== null && bwd !== null) {
      out['step_pm'] = pyRound((fwd + bwd) / 2, 2)
      out['fwd_bwd_diff_pm'] = pyRound(fwd - bwd, 2)
      out['hysteresis_note'] =
        '正反扫之差是 Z 反馈滞后的直接读数;扫得越快差越大。' + '拿来做 Z 标定之前应当把它压到接近 0(降低每线速度)。'
    } else if (fwd !== null || bwd !== null) {
      out['step_pm'] = fwd !== null ? fwd : bwd
      out['fwd_bwd_diff_pm'] = null
      out['hysteresis_note'] = '只有一个扫描方向可用,量不出反馈滞后。'
    } else {
      out['step_pm'] = null
      out['fwd_bwd_diff_pm'] = null
    }

    const lowInlier = Object.keys(perDir).filter((d) => {
      const r = perDir[d]?.['inlier_ratio']
      return typeof r === 'number' && r < 0.2
    })
    if (lowInlier.length > 0) {
      out['inlier_warning'] =
        `内点率偏低(${lowInlier.map((d) => `${d} ${pyFixed(perDir[d]?.['inlier_ratio'] as number, 3)}`).join(', ')}) —— ` +
        '表面自身的精细结构比噪声底大得多(Au(111) 的 herringbone 约 20 pm),' +
        '自适应阈值把台面上的点也判成了外点。' +
        '给一个 sigma_pm(噪声底与台阶高度之间)再跑一次。'
    }

    if (out['step_pm'] === null) {
      const summary =
        '量不出台阶高度:' +
        Object.entries(perDir)
          .map(([d, v]) => `${d} ${(v['why'] as string | undefined) ?? '-'}`)
          .join('; ')
      return { success: true, data: out, summary }
    }
    const bits = [`台阶 ${pyFixed(out['step_pm'] as number, 2)} pm`]
    if (out['fwd_bwd_diff_pm'] !== null && out['fwd_bwd_diff_pm'] !== undefined) {
      bits.push(`正反扫差 ${pyFixedSigned(out['fwd_bwd_diff_pm'] as number, 2)} pm`)
    }
    if (out['line_time_s'] !== null && out['line_time_s'] !== 0) {
      bits.push(`每线 ${pyFixed(out['line_time_s'] as number, 2)} s`)
    }
    bits.push(
      `内点率 ${Object.values(perDir)
        .filter((v) => typeof v['inlier_ratio'] === 'number')
        .map((v) => pyFixed(v['inlier_ratio'] as number, 3))
        .join('/')}`,
    )
    if (out['inlier_warning'] !== undefined) bits.push('⚠ 内点率低,结果存疑')
    return { success: true, data: out, summary: bits.join('; ') }
  },
}

function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  const h = n >> 1
  return n % 2 === 1 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2
}

// ── AssessFrameTrust ───────────────────────────────────────────────────────

/** 分档（pm），用 2026-08-26 真机帧标定过。 */
const ROW_GOOD_PM = 40.0
const ROW_USABLE_PM = 250.0

/** `sxm_oriented_frames` 那个字典的键，**按旧仓的插入顺序**。见下面那句报文。 */
const ORIENTED_KEYS: readonly string[] = [
  'channel', 'forward', 'backward', 'nm_per_px', 'width_nm', 'height_nm',
  'bias_v', 'setpoint_a', 'scan_dir', 'unit', 'rec_time',
]

export const AssessFrameTrust: Skill = {
  spec: S.AssessFrameTrustSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['scan_path'] ?? '')
    const channel = strParam(params, 'channel', 'Z')
    const direction = strParam(params, 'direction', 'forward')
    let z: Mat
    let frames: ReturnType<typeof orient>
    try {
      const load = loadSxm(path)
      if (!load.ok) throw new Error(load.plain)
      frames = orient(load.scan, channel)
      const raw = direction === 'forward' ? frames.forward : direction === 'backward' ? frames.backward : null
      if (raw === null) {
        // ⚠️ 旧仓这句印的是 `list(frames)` —— 那是**整个字典的键**，
        // 不是「有哪些方向」。它顺带把 `nm_per_px` / `bias_v` 这些一起列出来了。
        // 照移：那句话是模型读的东西，而「照移一句读起来有点怪的话」与
        // 「改掉一句模型正在照着做事的话」之间，前者便宜得多。
        const have = ORIENTED_KEYS.map((k) => `'${k}'`).join(', ')
        return { success: false, error: `通道 '${channel}' 里没有 '${direction}' 方向（有：[${have}]）` }
      }
      const sub = planeSubtractRobust(raw)
      z = matOf(sub.rows, sub.cols, Float64Array.from(sub.data, (v) => v * 1e12))
    } catch (e) {
      return { success: false, error: `读不了 ${path}：${(e as Error).message}` }
    }

    const nFinite = finiteCount(z)
    if (nFinite < 100) {
      return {
        success: true,
        data: {
          tip_verdict: 'undetermined',
          tip_message: '有限像素不足 100 个 —— 判不了，这不是「针尖坏」。',
        },
      }
    }
    const mad = rowJumpMadPm(z)
    const sigma = rowJumpSigmaPm(z)
    const [nBig, nRows] = rowBigJumps(z)
    const rms = nanStd(z.data)
    const data: Record<string, unknown> = {
      row_jump_mad_pm: mad, // ← 主指标
      row_jump_sigma_pm: sigma, // ← 辅助
      big_jumps: nBig,
      n_rows: nRows,
      rms_pm: rms,
      pv_pm: ptpFinite(z),
      nan_fraction: 1.0 - nFinite / (z.rows * z.cols),
      row_good_pm: ROW_GOOD_PM,
      row_usable_pm: ROW_USABLE_PM,
    }
    if (mad === null) {
      data['tip_verdict'] = 'undetermined'
      data['tip_message'] = '行数太少，量不出逐行跳动 —— 判不了。'
    } else if (mad <= ROW_GOOD_PM) {
      data['tip_verdict'] = 'stable'
      data['tip_message'] =
        `逐行 MAD ${pyFixed(mad, 1)} pm —— 针尖稳。这一帧的 RMS ${pyFixed(rms, 0)} pm 若很大，` + `那是**地形**，不是针尖。`
    } else if (mad <= ROW_USABLE_PM) {
      data['tip_verdict'] = 'usable_coarse'
      data['tip_message'] = `逐行 MAD ${pyFixed(mad, 1)} pm —— 大视野形貌还能用，原子级的活做不了。`
    } else {
      data['tip_verdict'] = 'unstable'
      data['tip_message'] =
        `逐行 MAD ${pyFixed(mad, 1)} pm —— 针尖在跳，这一帧的形貌不可信。` +
        `**先确认是不是刚动过针尖** —— 08-26 脉冲之后正是从 11 涨到 2335 pm。`
    }
    if (nBig !== null && nBig !== 0) {
      data['big_jump_note'] =
        `另有 ${nBig}/${nRows as number} 行出现大跳变。**这既可能是针尖跳，也可能是扫过真实台阶** —— ` +
        '两者在逐行中位高度上是同一个形状，分不开。要区分就在同一位置重扫一遍：' +
        '针尖跳变不重复，台阶重复。'
    }
    return { success: true, data }
  },
}

// ── LocateStepEdge ─────────────────────────────────────────────────────────

export const LocateStepEdge: Skill = {
  spec: S.LocateStepEdgeSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['scan_path'] ?? '')
    if (path === '' || !existsSync(path)) return { success: false, error: `文件不存在: ${path}` }
    const load = loadSxm(path)
    if (!load.ok) return { success: false, error: `.sxm 读取失败: ${load.plain}` }
    const scan = load.scan
    const channel = strParam(params, 'channel', 'Z')
    const fr = orient(scan, channel)
    const dir = strParam(params, 'direction', 'forward')
    const arr = dir === 'backward' ? fr.backward : dir === 'forward' ? fr.forward : null
    if (arr === null) return { success: false, error: `文件里没有可用的 '${channel}' 通道数据` }

    // **刻意没有 default**：缺席就用判据自己的值，写死在这里等于把它抄了两遍。
    const edgeSigma = numParam(params, 'edge_sigma')
    const maxCurvature = numParam(params, 'max_curvature')
    const res = locateStepEdge(arr, {
      ...(edgeSigma !== null ? { edgeSigma } : {}),
      ...(maxCurvature !== null ? { maxStraightness: maxCurvature } : {}),
    })

    const nmPerPx = fr.nm_per_px
    const offRaw = scan.header['scan_offset'] ?? scan.header['SCAN_OFFSET']
    let cxM = 0
    let cyM = 0
    {
      const parts = typeof offRaw === 'string' ? offRaw.trim().split(/\s+/) : Array.isArray(offRaw) ? offRaw : []
      const a = Number(parts[0])
      const b = Number(parts[1])
      if (Number.isFinite(a) && Number.isFinite(b)) {
        cxM = a
        cyM = b
      }
    }
    const data: Record<string, unknown> = {
      verdict: res.verdict,
      step_height_pm: res.stepHeightM === null ? null : res.stepHeightM * 1e12,
      edge_angle_deg: res.angleDeg,
      edge_angle_scan_deg: res.angleScanDeg,
      straightness: res.straightness,
      n_edge_px: res.nEdgePx,
      upper_fraction: res.upperFraction,
      nm_per_px: nmPerPx,
      reasons: [...res.reasons],
      warnings: [...res.warnings],
      scan_path: path,
      channel,
    }
    if (res.xPx !== null && nmPerPx !== null && nmPerPx !== 0) {
      const ny = arr.rows
      const nx = arr.cols
      // 图像像素 → 扫描坐标：列号随 +x 增大，而行 0 是窗口的高 y 边，
      // 所以行号沿 −y 走。
      data['edge_x_m'] = cxM + (res.xPx - (nx - 1) / 2) * nmPerPx * 1e-9
      data['edge_y_m'] = cyM - ((res.yPx as number) - (ny - 1) / 2) * nmPerPx * 1e-9
    }
    let summary: string
    if (res.verdict === 'step_edge') {
      summary =
        `台阶边过 (${pyFixed(((data['edge_x_m'] as number | undefined) ?? 0) * 1e9, 1)}, ` +
        `${pyFixed(((data['edge_y_m'] as number | undefined) ?? 0) * 1e9, 1)}) nm,扫描系方向 ` +
        `${pyFixed(res.angleScanDeg as number, 1)}°,高 ${pyFixed((res.stepHeightM as number) * 1e12, 0)} pm`
    } else if (res.verdict === 'no_step') {
      summary = '这一帧里没有两个够大的台面 —— 没有台阶边可报'
    } else {
      summary = `判不了:${res.reasons.length > 0 ? res.reasons.join('、') : '未知'}`
    }
    return { success: true, data, summary }
  },
}

// ── AssessFrameCorrugation ─────────────────────────────────────────────────

export const AssessFrameCorrugation: Skill = {
  spec: S.AssessFrameCorrugationSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['scan_path'] ?? '')
    const channelName = strParam(params, 'channel', 'Z')
    if (path === '' || !existsSync(path)) return { success: false, error: `文件不存在: ${path}` }
    const load = loadSxm(path)
    if (!load.ok) return { success: false, error: `.sxm 读取失败: ${load.plain}` }
    const scan = load.scan
    // 几何归位的单一真源：`backward` 的左右翻与 `:SCAN_DIR: up` 的上下翻都在这里处理。
    // 自己扒 channels 就是在拿一张图跟它自己的镜像比。
    const fr = orient(scan, channelName)
    const arr = fr.forward
    if (arr === null) {
      return { success: false, error: `文件里没有可用通道/正反扫数据(要的是 '${channelName}')` }
    }
    const th = resolveScanPrepThresholds(strParam(params, 'profile', ''))
    const pair = resolveThresholdPair(numParam(params, 'threshold_pm'), numParam(params, 'ref_scan_nm'), th)

    const widthNm = fr.width_nm
    const heightNm = fr.height_nm
    const warnings: string[] = []
    if (widthNm !== null && widthNm !== 0 && heightNm !== null && heightNm !== 0) {
      // 非方帧：尺度对账用的是宽度，而起伏是整帧的。说出来，不闷头算。
      if (Math.abs(heightNm / widthNm - 1.0) > 0.05) warnings.push('non_square_frame')
    }
    // `?? 0.05` 而不是 `|| 0.05`：一个合法的 `0.0`（要求精确同视野）不能被悄悄换掉。
    const relTol = numParam(params, 'rel_tol') ?? 0.05

    const verdict = judgeFrame(arr)
    const res = judgeCorrugation(
      { usable: verdict.usable, reason: verdict.reason, corrugationRmsM: verdict.corrugationRmsM },
      {
        thresholdPm: pair.thresholdPm,
        refScanNm: pair.refScanNm,
        thisScanNm: widthNm,
        relTol,
        profileName: th.name,
        provenance: th.provenance,
      },
    )

    // ── 旁证：不参与判决，但读者要能看见这一帧长什么样 ──
    let nanFrac: number | null = null
    const total = arr.rows * arr.cols
    if (total > 0) nanFrac = 1.0 - finiteCount(arr) / total
    let badRow: number | null = null
    let rowsUsed: number | null = null
    try {
      const bwd = fr.backward !== null && fr.backward.rows === arr.rows && fr.backward.cols === arr.cols ? fr.backward : null
      // 只拿**扫完的行**：任何平面/直线拟合碰上一个 NaN 就整幅返回 NaN。
      // 半张图是输入，不是错误 —— 裁行用全仓那一份判据，不自己写第二份。
      const mask = bwd === null ? acquiredRowMask(arr) : acquiredRowMask(arr, bwd)
      rowsUsed = Array.from(mask).reduce<number>((a, b) => a + b, 0)
      if (rowsUsed >= 2) badRow = badRowFrac(cropRows(arr, mask))
    } catch {
      /* 旁证坏了不该让判据失败 */
    }

    const data: Record<string, unknown> = {
      ...res,
      scan_path: path,
      channel: fr.channel,
      threshold_source: pair.source,
      frame_usable: verdict.usable,
      unusable_reason: verdict.usable ? '' : verdict.reason,
      nan_frac: nanFrac,
      bad_row_frac: badRow,
      // 坏行占比是在**哪些行**上算的 —— 裁行是一种预处理，它会改这个数。
      bad_row_rows_used: rowsUsed,
      rows: arr.rows,
      cols: arr.cols,
      nm_per_px: fr.nm_per_px,
      width_nm: widthNm,
      height_nm: heightNm,
      // 起伏要跟成像条件一起读：偏压/设定点变了，比的就不是针尖。
      bias_v: fr.bias_v,
      setpoint_a: fr.setpoint_a,
      rec_time: fr.rec_time,
      warnings,
    }
    return { success: true, data, summary: summarizeCorrugation(res, data) }
  },
}

/** 给用户/模型读的一句话。**「判不了」与「判出来不好」是两句不同的话。** */
function summarizeCorrugation(res: ReturnType<typeof judgeCorrugation>, data: Record<string, unknown>): string {
  const head =
    (
      {
        undecidable: '这一帧的起伏判不了',
        low: '这一帧起伏太小,判据弃权',
        high: '这一帧起伏偏大',
        normal: '这一帧起伏正常',
      } as Record<string, string>
    )[res.verdict] ?? res.verdict
  let s = `${head} —— ${res.reason}`
  if (res.verdict === 'high') {
    s += '这不是「针坏了」的结论:要判针还是表面,得换位置复测再聚合' + '(判据③)。'
  }
  const src = String(data['threshold_source'] ?? '')
  if (src.startsWith('profile')) s += ` 阈值来源:${src}。`
  else if (res.threshold_pm !== null) s += ' 阈值来源:调用方显式给的。'
  s += ` 口径 ${res.detrend}+${res.statistic};${res.blind_to}`
  return s
}

/** 这一族四个技能的登记表。 */
export const ANALYSIS_FRAMES: Readonly<Record<string, Skill>> = {
  MeasureStepHeight,
  AssessFrameTrust,
  LocateStepEdge,
  AssessFrameCorrugation,
}
