/**
 * 掩膜 / 团簇一族的四个技能 —— `ExtractClusters` · `AssessClusterRoundness` ·
 * `SelectPokedCluster` · `VerifyAdatomAt`。
 *
 * 四个共用同一批底层件（`parseXyMeta` + `pxToM` + `acquiredRowMask` + `assessMask`），
 * 而**分割口径刻意有两套**：
 *
 * | | 阈值 | 预处理 | 裁行 |
 * |---|---|---|---|
 * | `ExtractClusters` | `median ± 3 × σ_MAD` | 默认 **RAW** | **裁**（只吃整行有限的行） |
 * | `AssessClusterRoundness` | `mean ± 1.5 × std`（或**物理阈值**） | 恒 OLS 平面 | **不裁** |
 *
 * **同一帧会得到不同的 blob**，而这是写在 `ExtractClusters` 的模型可见描述里的一句话
 * （「注意它是另一套分割，不是这一套的封装」）。这是 D-CHANNELS-1 的形状：
 * 两个看起来该合并的东西，合并会默默改掉判决 —— 而 `AssessClusterRoundness`
 * 那一套自指阈值正是它自己 docstring 里点名批评的东西，
 * 所以**要合也得先有数据，不能顺手合**。
 *
 * ## ⚠️ 欠账：`AssessClusterRoundness` 拿的是**裸块**（D-CLUSTER-1）
 *
 * 它读 `scan.channels[ch].forward`，不经 `sxmOrientedFrames` —— 于是
 * 一张 `:SCAN_DIR: up` 的帧在它这里是**上下颠倒**的，而反扫块是**镜像**的。
 * 这是旧仓的现状，本批**照移没有修**。
 *
 * 不修的理由不是「照移优先」，是**没有证据**：`ExtractClusters` 那一侧
 * 2026-08-11 修同一条时，是拿真机 60 nm 帧量出 31.8 nm 的 y 偏差、
 * 与 33.9 nm 的 x 偏差才动手的。本批合成的每一张帧都是 `SCAN_DIR: down`、
 * 正反扫对称，**证明不了修完是对的**，而修它会让这个技能的每一格金样改数。
 *
 * 要还这笔账，先造一张 `up` 帧、量出这个技能报的坐标偏多少，再改。
 */
import { existsSync } from 'node:fs'
import {
  parseQuantity,
  SIParseError,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { labelConnected, matOf, type Mat } from 'dsh-spm-numerics'
import {
  assessMask,
  axesOfBlob,
  backgroundLevel,
  extractClusters,
  judgeFrame,
  nanMean,
  nanStd,
  planeSubtractOls,
  weightedAxisRatio,
} from 'dsh-spm-vision'
import { pyFixed } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { loadSxm, numOr, numParam, orient, strParam } from './analysis-common.js'

// ── ExtractClusters ────────────────────────────────────────────────────────

/** `ExtractClusters` 的纯函数芯（`SelectPokedCluster` / `VerifyAdatomAt` 也走它）。 */
export function runExtractClusters(params: Readonly<Record<string, unknown>>): SkillResultLike {
  const scanPath = strParam(params, 'scan_path', '')
  if (scanPath === '' || !existsSync(scanPath)) {
    return { success: false, error: `scan_path 不存在: '${scanPath}'` }
  }
  const load = loadSxm(scanPath)
  if (!load.ok) return { success: false, error: `读不了 .sxm: ${load.why}` }
  const scan = load.scan
  const channel = strParam(params, 'channel', 'Z')
  const chan = scan.channels[channel]
  if (chan === undefined) {
    const available = Object.keys(scan.channels).sort()
    return {
      success: false,
      error:
        `这个 .sxm 里没有通道 '${channel}'。它有:[${available.map((c) => `'${c}'`).join(', ')}]` +
        ' —— 请指名要哪一个(挑错通道量出来的数看起来完全正常,' +
        '只是量的是另一个物理量)。',
      data: { available_channels: available },
    }
  }
  const fr = orient(scan, channel)
  const img = fr.forward
  if (img === null) {
    return { success: false, error: `通道 '${channel}' 没有正扫也没有反扫数据` }
  }
  const out = extractClusters(img, scan.header, {
    polarity: strParam(params, 'polarity', 'auto').toLowerCase(),
    thresholdMad: numOr(params, 'threshold_mad', 3.0),
    level: strParam(params, 'level', 'none').toLowerCase(),
    tiltWarnRatio: numParam(params, 'tilt_warn_ratio') ?? 20.0,
    minAreaPx: Math.trunc(numOr(params, 'min_area_px', 4)),
    maxClusters: Math.trunc(numOr(params, 'max_clusters', 50)),
  })
  if (!out.ok) return { success: false, error: out.error, data: out.data }
  return { success: true, data: { scan_path: scanPath, ...out.data } }
}

export const ExtractClusters: Skill = {
  spec: S.ExtractClustersSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => runExtractClusters(params),
}

// ── AssessClusterRoundness ─────────────────────────────────────────────────

/** 「几坨体量相当的东西离得不远」—— 体量比下限。 */
export const MULTI_TIP_SIZE_FRAC = 0.25
/** 同上 —— 间距上限（nm）。**不是扫出来的最优值**，是一个权衡的拐点。 */
export const MULTI_TIP_SPAN_NM = 6.0

const ROUND_THRESHOLD_RETIRED =
  '`round_threshold` 已作废(2026-08-11):它比的是 ' +
  '`0.6*circularity + 0.4*aspect`,而那个 circularity = ' +
  '4πA/P² 在像素化边界上的**上确界只有 0.617**(轴对齐正方形却是 ' +
  '0.785)—— 阈值 0.65 卡在两者之间,**圆的一律不合格、' +
  '方的一律合格**。真机 `_0168` 的团簇因此被判否。' +
  '请改用 `min_axis_ratio`(等效轴比,完美圆 = 1.0;' +
  '0.75 = 「不比长短轴差 25% 的椭圆更不规则」)。' +
  '**两个数不可互换**:直接把 0.65 填进 min_axis_ratio ' +
  '等于把闸门放宽到「长短轴差 35%」。'

export const AssessClusterRoundness: Skill = {
  spec: S.AssessClusterRoundnessSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const scanPath = strParam(params, 'scan_path', '')
    const thresholdSigma = numOr(params, 'threshold_sigma', 1.5)
    const polarity = strParam(params, 'polarity', 'auto').toLowerCase()
    const channelName = strParam(params, 'channel', 'Z')
    const thresholdMode = strParam(params, 'threshold_mode', 'sigma').toLowerCase()
    const shapeMode = strParam(params, 'shape_mode', 'boundary').toLowerCase()
    const physicalThresholdM = numOr(params, 'physical_threshold_pm', 117.7) * 1e-12
    if (thresholdMode !== 'sigma' && thresholdMode !== 'physical') {
      return { success: false, error: `threshold_mode 只能是 sigma / physical,收到 '${thresholdMode}'` }
    }
    if (shapeMode !== 'boundary' && shapeMode !== 'weighted') {
      return { success: false, error: `shape_mode 只能是 boundary / weighted,收到 '${shapeMode}'` }
    }
    // ── `round_threshold` **作废**，而且不做静默别名 ──
    // 新旧两个数**方向相同、量纲不同** —— 正因为方向相同，一个漏改的 0.65
    // 会**照跑不误**并悄悄把闸门放宽到「长短轴差 35%」。所以当场报错，
    // 把处方一起给。
    if (params['round_threshold'] !== null && params['round_threshold'] !== undefined) {
      return {
        success: false,
        error: ROUND_THRESHOLD_RETIRED,
        data: {
          retired_parameter: 'round_threshold',
          use_instead: 'min_axis_ratio',
          suggested: { min_axis_ratio: 0.75, min_aspect: 0.6 },
          why_not_a_silent_alias: '两者方向相同(都是越大越圆),所以一个漏改的旧值会照跑不误',
        },
      }
    }
    const minAxisRatio = numOr(params, 'min_axis_ratio', 0.75)
    const minAspect = numOr(params, 'min_aspect', 0.6)
    if (scanPath === '' || !existsSync(scanPath)) {
      return { success: false, error: `scan_path not found: ${scanPath}` }
    }
    const load = loadSxm(scanPath)
    if (!load.ok) return { success: false, error: `failed to read .sxm: ${load.plain}` }
    const scan = load.scan
    // ⚠️ **裸块**，不经 `sxmOrientedFrames` —— 照移旧仓的现状，见文件抬头。
    const ch = scan.channels[channelName] ?? Object.values(scan.channels)[0]
    if (ch === undefined) return { success: false, error: 'no usable channel' }
    const img = ch.forward ?? ch.backward ?? null
    if (img === null) return { success: false, error: 'no forward/backward frame' }

    // ── 这一帧能不能判（三家共用的前置）──
    // 下面那道 `std === 0` 守卫**不够**：2026-08-10 真机的两张死平废帧上它没触发，
    // 而本技能给出了 `roundness_score=0.6476` —— 六帧里的最高分，
    // 且两张不同的帧**逐位相同**。纯舍入图样被 `mean ± 2σ` 切成了一个团。
    const verdict = judgeFrame(img)
    if (!verdict.usable) {
      return {
        success: false,
        error: verdict.reason,
        data: {
          frame_usable: false,
          corrugation_rms_m: verdict.corrugationRmsM,
          unusable_reason: verdict.reason,
          scan_path: scanPath,
          rows: img.rows,
          cols: img.cols,
        },
      }
    }
    const leveled = planeSubtractOls(img)
    const mean = nanMean(leveled.data)
    const std = nanStd(leveled.data)
    if (std === 0 || Number.isNaN(std)) {
      // 留着：上面的前置管「整帧没信息」，这一条管「plane_subtract 这条路自己退化了」。
      return {
        success: false,
        error: 'zero/NaN std — flat or unreadable scan',
        data: {
          frame_usable: true,
          corrugation_rms_m: verdict.corrugationRmsM,
          scan_path: scanPath,
        },
      }
    }

    // ── 阈值 ──
    // ⚠️ `threshold_mode="sigma"`（出厂）是**自指的**：mean 和 std 都是拿
    // **含着团簇的那张图**算的，于是「簇越大 → std 越大 → 阈值越高 → 切掉的簇越多」。
    // 2026-08-15 一百针实测：同一个「1.5σ」在不同帧上切在离背景 136–655 pm。
    let base: number | null = null
    let upMask: Mat
    let dnMask: Mat
    if (thresholdMode === 'physical') {
      base = backgroundLevel(leveled)
      if (base === null) {
        return {
          success: false,
          error: 'physical threshold needs a background mode — frame too small',
          data: { frame_usable: true, corrugation_rms_m: verdict.corrugationRmsM, scan_path: scanPath },
        }
      }
      upMask = cmpMask(leveled, base + physicalThresholdM, true)
      dnMask = cmpMask(leveled, base - physicalThresholdM, false)
    } else {
      upMask = cmpMask(leveled, mean + thresholdSigma * std, true)
      dnMask = cmpMask(leveled, mean - thresholdSigma * std, false)
    }
    const upN = countOn(upMask)
    const dnN = countOn(dnMask)
    let mask: Mat
    let chosen: 'bright' | 'dark'
    if (polarity === 'auto') {
      mask = upN >= dnN ? upMask : dnMask
      chosen = upN >= dnN ? 'bright' : 'dark'
    } else if (polarity === 'dark') {
      mask = dnMask
      chosen = 'dark'
    } else {
      mask = upMask
      chosen = 'bright'
    }
    if (countOn(mask) === 0) {
      return {
        success: false,
        error: 'no pixels exceeded threshold — lower threshold_sigma or check the scan window covers the crater',
        data: { polarity_used: chosen, mean, std },
      }
    }
    const lab = labelConnected(mask, 4)
    const nComponents = lab.count
    if (nComponents === 0) return { success: false, error: 'segmentation produced 0 components' }

    // 评的是刚完成操作的目标团簇。
    // 一轮修针会留下一串坑，到第三针时**画面里最大的那个**routinely 是更早留下的。
    const select = strParam(params, 'select', 'largest').toLowerCase()
    let chosenLabel = argmaxLabel(lab.sizes)
    if (select === 'center' && nComponents > 1) {
      const cy0 = (mask.rows - 1) / 2
      const cx0 = (mask.cols - 1) / 2
      let best = 0
      let bestD = Infinity
      for (let l = 1; l <= nComponents; l += 1) {
        if ((lab.sizes[l - 1] as number) <= 0) continue
        const pts = pixelsOf(lab.labels, mask.rows, mask.cols, l)
        const d = (avg(pts.ys) - cy0) ** 2 + (avg(pts.xs) - cx0) ** 2
        if (d < bestD) {
          best = l
          bestD = d
        }
      }
      chosenLabel = best !== 0 ? best : argmaxLabel(lab.sizes)
    }
    const blob = blobOf(lab.labels, mask.rows, mask.cols, chosenLabel)
    const areaPx = countOn(blob)
    const rnd = assessMask(blob)
    const pts = pixelsOf(lab.labels, mask.rows, mask.cols, chosenLabel)
    const [major, minor, aspectRatio] = axesOfBlob(pts.xs, pts.ys)

    // ── 高度加权轴比：**永远报，但由 `shape_mode` 决定它判不判** ──
    const wBase = base !== null ? base : backgroundLevel(leveled)
    let wAxis = wBase !== null ? weightedAxisRatio(leveled, blob, wBase) : null
    if (chosen === 'dark' && wBase !== null) {
      // 暗侧：把高度翻过来再加权，否则权重全被 clip 成 0。
      const flipped = matOf(
        leveled.rows,
        leveled.cols,
        Float64Array.from(leveled.data, (v) => 2 * wBase - v),
      )
      wAxis = weightedAxisRatio(flipped, blob, wBase)
    }
    let undecidable: string | null = rnd.ok ? null : rnd.reason
    let axisRatio: number | null = rnd.axisRatio
    if (shapeMode === 'weighted') {
      // 判决改由加权轴比驱动。它**判不了就是判不了** —— 不回退到边界离散，
      // 那会让「用了哪个算法」取决于数据，而报文只写一个 `shape_mode`。
      axisRatio = wAxis
      undecidable = wAxis !== null ? null : '高度加权二阶矩算不出来(有效像素不足)'
    }
    const isRound =
      undecidable !== null && undecidable !== ''
        ? null
        : (axisRatio as number) >= minAxisRatio && aspectRatio >= minAspect

    // 像素物理尺寸：旧仓从 `scan_range` 直接 split，不经 `parseXyMeta`。
    let pxSizeX = NaN
    let pxSizeY = NaN
    {
      const raw = scan.header['scan_range']
      const parts = String(raw ?? '1e-7 1e-7').trim().split(/\s+/)
      const w = Number(parts[0])
      const h = Number(parts[1])
      if (Number.isFinite(w) && Number.isFinite(h)) {
        pxSizeX = w / img.cols
        pxSizeY = h / img.rows
      }
    }

    // ── 多针尖：**几坨体量相当的东西，离得不远** ──
    // 判据不看形状，只问「有没有第二坨体量相当的东西，离得够近」：一个顶点扎出
    // 500 px、另一个 5 px，后者是碎屑不是顶点。
    let multiTip: boolean | null = null
    let multiTipReason: string | null = null
    let multiTipDetail: string | null = null
    const pxNm = Number.isFinite(pxSizeX) ? pxSizeX * 1e9 : null
    if (pxNm !== null && pxNm > 0 && nComponents >= 1) {
      const biggest = argmaxLabel(lab.sizes)
      const keep: number[] = []
      for (let l = 1; l <= nComponents; l += 1) {
        if ((lab.sizes[l - 1] as number) >= MULTI_TIP_SIZE_FRAC * (lab.sizes[biggest - 1] as number)) keep.push(l)
      }
      const cent = new Map<number, [number, number]>()
      for (const l of keep) {
        const p = pixelsOf(lab.labels, mask.rows, mask.cols, l)
        cent.set(l, [avg(p.ys), avg(p.xs)])
      }
      const [by, bx] = cent.get(biggest) as [number, number]
      const near = keep.filter((l) => {
        const c = cent.get(l) as [number, number]
        return Math.hypot(c[0] - by, c[1] - bx) * pxNm <= MULTI_TIP_SPAN_NM
      })
      multiTip = near.length >= 2
      if (multiTip) {
        let far = -Infinity
        for (const l of near) {
          const c = cent.get(l) as [number, number]
          far = Math.max(far, Math.hypot(c[0] - by, c[1] - bx) * pxNm)
        }
        multiTipDetail =
          `${near.length} 坨体量相当(≥${pyFixed(MULTI_TIP_SIZE_FRAC * 100, 0)}% 最大块)` +
          `的东西,最远 ${pyFixed(far, 1)} nm(≤${MULTI_TIP_SPAN_NM} nm)`
      } else {
        multiTipDetail =
          `只有 1 坨够格的东西(共 ${nComponents} 个连通域,` +
          `其余不足最大块的 ${pyFixed(MULTI_TIP_SIZE_FRAC * 100, 0)}% 或超出 ` +
          `${MULTI_TIP_SPAN_NM} nm)`
      }
    } else {
      // 像素尺寸读不到 ⇒ 间距算不出 ⇒ **判不了**，不是「没有多针尖」。
      multiTipReason = '判不了:读不到像素物理尺寸(scan_range),算不出连通域之间的间距。'
    }

    return {
      success: true,
      data: {
        scan_path: scanPath,
        // 判决：三态。`null` = **判不了**（团簇太小），不是「不圆」。
        is_round: isRound,
        roundness_undecidable: undecidable,
        equivalent_axis_ratio: axisRatio,
        // 两个算法**都报**，并说清这一次是谁在判。
        weighted_axis_ratio: wAxis,
        boundary_axis_ratio: rnd.axisRatio,
        shape_mode: shapeMode,
        threshold_mode: thresholdMode,
        background_level_m: wBase,
        threshold_above_background_m:
          thresholdMode === 'physical'
            ? physicalThresholdM
            : wBase !== null
              ? mean + thresholdSigma * std - wBase
              : null,
        multi_tip: multiTip,
        multi_tip_undecidable: multiTipReason,
        multi_tip_detail: multiTipDetail,
        multi_tip_size_frac: MULTI_TIP_SIZE_FRAC,
        multi_tip_span_nm: MULTI_TIP_SPAN_NM,
        radial_dispersion: rnd.dispersion,
        radial_dispersion_floor: rnd.floor,
        radial_dispersion_excess: rnd.excess,
        aspect_ratio: aspectRatio,
        min_axis_ratio: minAxisRatio,
        min_aspect: minAspect,
        area_px: areaPx,
        major_axis_px: major,
        minor_axis_px: minor,
        polarity_used: chosen,
        n_components: nComponents,
        pixel_size_x_m: pxSizeX,
        pixel_size_y_m: pxSizeY,
      },
    }
  },
}

// ── SelectPokedCluster ─────────────────────────────────────────────────────

/** 拒绝报文里给出的处方 —— 「该怎么填」而不是「你没填」。**逐字照移。** */
const BOX_HINT =
  '参考系统观测到的箱子(RAW 口径,n=4 真值 / 405 候选；尚未在本仓独立验证):' +
  '长宽比 ∈ [0.20, 0.60]、像素数 ∈ [5, 132]、峰高 ∈ [50, 365] pm —— ' +
  "箱内任意组合都判对 4/4 且零误判。**推荐工作点 (0.35, 40, '150p')**。" +
  '要自己量:用 ExtractClusters 跑一批**你自己的**帧,对**全部**连通域' +
  '(不要只挑典型反例)算分布,再取空档。'

/**
 * ⚠️ 这里的例子必须写成**带 SI 前缀的字符串**（`'3n'`），不能写 `3e-9` ——
 * 这几个米量纲参数是**强制前缀**的，指数写法会被解析器直接拒绝。
 * 在描述里举一个自己会拒绝的例子，等于教模型去撞墙（它不会怀疑文档，只会照抄）。
 */
const ANCHOR_HINT =
  '扎针坐标由**刚扎完的那个调用方**提供(它知道自己扎在哪);留空则退回帧中心 —— ' +
  "只有当扫描框确实对准了扎针点时那才等价。容差实测 '3n'(= 3 纳米)" +
  '(系统性 0.54 nm + 3×散布 0.96 nm,n=4);偏移方向张角 302°,' +
  '说明主导项是质心噪声而不是热漂移。'

export const SelectPokedCluster: Skill = {
  spec: S.SelectPokedClusterSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    // ── 必填阈值：拒绝时**把处方一起给** ──
    const needed = ['min_aspect', 'min_area_px', 'min_peak_height_m', 'anchor_tolerance_m']
    const missing = needed.filter((k) => params[k] === null || params[k] === undefined)
    if (missing.length > 0) {
      return {
        success: false,
        error:
          `这些阈值必须显式给出,本技能**不替你猜**:[${missing.map((m) => `'${m}'`).join(', ')}]。` +
          `${BOX_HINT} 锚点容差:${ANCHOR_HINT}`,
        // ⚠️ 米量纲那两个必须给**带 SI 前缀的字符串**，不能给 `1.5e-10` / `3e-9`：
        // 它们是强制前缀参数，指数写法会被这个技能**自己**拒绝。
        // **拒绝报文正是模型用来决定「下次该传什么」的东西** ——
        // 一份开不出来的处方比不开处方更坏。
        data: {
          missing_parameters: missing,
          suggested_operating_point: {
            min_aspect: 0.35,
            min_area_px: 40,
            min_peak_height_m: '150p',
            anchor_tolerance_m: '3n',
          },
          measured_box_raw: {
            min_aspect: [0.2, 0.6],
            min_area_px: [5, 132],
            min_peak_height: ['50p', '365p'],
          },
          box_provenance: '参考系统观测：n=4 真值 / 405 候选，RAW 口径；尚未在本仓独立验证',
        },
      }
    }
    // 米量纲的两个参数要**同时**收得下真 float 和 SI 前缀字符串：agent 路径上内核
    // 已经解过了，而**直接调用的那一侧绕过那一步** —— 而我们自己开的处方正是
    // `'150p'` / `'3n'` 这种字符串。
    const metre = (key: string): number => {
      const v = params[key]
      if (typeof v === 'number') return v
      return parseQuantity(v, { strict: true, what: key })
    }
    const minAspect = Number(params['min_aspect'])
    const minArea = Math.trunc(Number(params['min_area_px']))
    let minPeakM: number
    let tolM: number
    try {
      minPeakM = metre('min_peak_height_m')
      tolM = metre('anchor_tolerance_m')
    } catch (e) {
      if (e instanceof SIParseError) return { success: false, error: e.message }
      throw e
    }

    const ext = runExtractClusters({
      scan_path: params['scan_path'],
      channel: params['channel'] ?? 'Z',
      polarity: params['polarity'] ?? 'auto',
      level: params['level'] ?? 'none',
      // 提取层的 `min_area` 只为列表可读；判定用的是上面那个。
      min_area_px: 1,
      max_clusters: 10000,
    })
    if (!ext.success) {
      return { success: false, error: `提取失败:${ext.error ?? ''}`, data: ext.data }
    }
    const ex = ext.data as Record<string, unknown>
    const frame = ex['frame'] as Record<string, unknown>

    // ── 锚点 ──
    const ax = numParam(params, 'near_x_m')
    const ay = numParam(params, 'near_y_m')
    const anchor: [number, number] =
      ax !== null && ay !== null ? [ax, ay] : [Number(frame['cx_m']), Number(frame['cy_m'])]
    const anchorSrc = ax !== null && ay !== null ? 'explicit' : 'frame_centre'
    // 坐标不可信时**说出来**：角度未知 = 换算没有验证过，而调用方要拿这个结果去移动针尖。
    const coordsTrustworthy = frame['angle_known'] === true

    // ── 合取筛：筛掉谁、为什么，都报出来 ──
    // 提取层不丢信息；判定层丢信息，但**必须说清丢了什么**。
    const cands: Record<string, unknown>[] = []
    for (const c of ex['clusters'] as Record<string, unknown>[]) {
      const failed: string[] = []
      const aspect = Number(c['aspect'])
      const areaPx = Number(c['area_px'])
      const peakPm = Number(c['peak_height_pm'] ?? 0)
      if (aspect < minAspect) failed.push(`aspect ${pyFixed(aspect, 3)} < ${minAspect}`)
      if (areaPx < minArea) failed.push(`area ${areaPx}px < ${minArea}`)
      const peakM = (Number.isFinite(peakPm) ? peakPm : 0) * 1e-12
      if (peakM < minPeakM) {
        failed.push(`peak ${pyFixed(peakPm, 1)}pm < ${pyFixed(minPeakM * 1e12, 1)}pm`)
      }
      const x = c['x_m']
      const y = c['y_m']
      const d =
        typeof x === 'number' && typeof y === 'number' ? Math.hypot(x - anchor[0], y - anchor[1]) : null
      cands.push({ ...c, passed_conjunction: failed.length === 0, failed_on: failed, distance_to_anchor_m: d })
    }
    const passing = cands.filter((c) => c['passed_conjunction'] === true && c['distance_to_anchor_m'] !== null)

    const out: Record<string, unknown> = {
      scan_path: params['scan_path'] ?? null,
      anchor: { x_m: anchor[0], y_m: anchor[1], source: anchorSrc },
      coords_trustworthy: coordsTrustworthy,
      thresholds_used: {
        min_aspect: minAspect,
        min_area_px: minArea,
        min_peak_height_pm: minPeakM * 1e12,
        anchor_tolerance_m: tolM,
      },
      frame,
      leveling_used: ex['leveling_used'],
      polarity_used: ex['polarity_used'],
      tilt_warning: ex['tilt_warning'] ?? null,
      n_extracted: cands.length,
      n_passed_conjunction: passing.length,
      candidates: cands.slice(0, 50),
    }
    if (!coordsTrustworthy) {
      out['coords_warning'] =
        '这一帧的 scan_angle 不可知,像素→米的换算**没有验证过** —— ' + '选出来的坐标不要直接拿去移动针尖。'
    }

    if (passing.length === 0) {
      // 弃权，并且**把最近的那个的距离也报出来** —— 它是下一版容差的数据。
      const withD = cands.filter((c) => c['distance_to_anchor_m'] !== null)
      const nearest =
        withD.length > 0
          ? withD.reduce((a, b) =>
              (a['distance_to_anchor_m'] as number) <= (b['distance_to_anchor_m'] as number) ? a : b,
            )
          : null
      out['selected'] = null
      out['selected_reason'] =
        `提取到 ${cands.length} 个连通域,没有一个同时满足` +
        `(长宽比≥${minAspect}、≥${minArea}px、峰高≥${pyFixed(minPeakM * 1e12, 0)}pm)。` +
        '**这是弃权,不是「没有团簇」** —— 可能是阈值不适合这一帧,' +
        '也可能这一针真的没扎出东西。看 candidates 里每个是卡在哪一条。'
      if (nearest !== null) {
        out['nearest_rejected'] = {
          rank: nearest['rank'],
          distance_to_anchor_m: nearest['distance_to_anchor_m'],
          failed_on: nearest['failed_on'],
        }
      }
      return { success: true, data: out }
    }
    const best = passing.reduce((a, b) =>
      (a['distance_to_anchor_m'] as number) <= (b['distance_to_anchor_m'] as number) ? a : b,
    )
    const bestD = best['distance_to_anchor_m'] as number
    out['distance_to_anchor_m'] = bestD
    if (bestD > tolM) {
      // **够不着就弃权。** 把「我找到的最近的东西」当成新扎的那个交出去，
      // 是三态里最常被跳过的那一步。
      out['selected'] = null
      out['selected_reason'] =
        `最近的合格团簇距锚点 ${pyFixed(bestD * 1e9, 2)} nm,` +
        `超过容差 ${pyFixed(tolM * 1e9, 2)} nm —— **判不了这是不是我们扎的那个**。` +
        '不把它当成新扎的交出去:那正是「拿最近的东西冒充答案」。' +
        '(如果这个距离反复出现在同一个量级上,那就是容差该改的信号 —— ' +
        '这一版的 3 nm 就是这么来的。)'
      out['nearest_passing'] = {
        rank: best['rank'],
        distance_to_anchor_m: bestD,
        peak_height_pm: best['peak_height_pm'],
        aspect: best['aspect'],
        area_px: best['area_px'],
      }
      return { success: true, data: out }
    }
    out['selected'] = best
    out['selected_reason'] =
      `合格团簇 ${passing.length} 个,取距锚点最近的一个:` +
      `${pyFixed(bestD * 1e9, 2)} nm(容差 ${pyFixed(tolM * 1e9, 2)} nm)。`
    return { success: true, data: out }
  },
}

// ── VerifyAdatomAt ─────────────────────────────────────────────────────────

/**
 * `VerifyAdatomAt` —— 「刚才那颗原子还在目标上吗」。
 *
 * ## 容差从哪来：**参数 > 衬底 > 判不了**
 *
 * 旧仓第二路走 `core.sample_facts.resolve_substrate(...).nearest_neighbor_nm / 2`，
 * 包在 try/except 里，拿不到就 `verdict="undecidable"` / `reasons=["no_tolerance"]`。
 * 本仓没有 `knowledge/`（30570 行），于是第二路成了一个**注入点**
 * （{@link substrateTolerance}），**而默认是关的** —— 也就是默认走那条
 * 「判不了」的路，和旧仓在没有衬底声明时完全一致。
 */
export const substrateTolerance: { nearestNeighborNm: (() => number | null) | null } = {
  nearestNeighborNm: null,
}

function resolveTolerance(params: Readonly<Record<string, unknown>>): [number | null, string] {
  const given = numParam(params, 'tolerance_m')
  if (given !== null) return [given, 'param']
  const src = substrateTolerance.nearestNeighborNm
  if (src !== null) {
    try {
      const nn = src()
      if (nn !== null && nn !== 0) return [(nn * 1e-9) / 2, 'sample_facts']
    } catch {
      /* 拿不到就当没有 —— 同旧仓那个 `except` */
    }
  }
  return [null, 'none']
}

export const VerifyAdatomAt: Skill = {
  spec: S.VerifyAdatomAtSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = strParam(params, 'scan_path', '')
    if (path === '' || !existsSync(path)) return { success: false, error: `文件不存在: ${path}` }
    const [tol, tolSrc] = resolveTolerance(params)
    if (tol === null) {
      return {
        success: true,
        data: { verdict: 'undecidable', reasons: ['no_tolerance'], scan_path: path },
        summary: '没有容差可用:传 tolerance_m,或者先声明衬底',
      }
    }
    const res = runExtractClusters({
      scan_path: path,
      channel: params['channel'] ?? 'Z',
      polarity: params['polarity'] ?? 'bright',
      level: 'plane',
    })
    if (!res.success) return { success: false, error: `团簇提取失败: ${res.error ?? ''}` }
    const dataIn = (res.data ?? {}) as Record<string, unknown>
    const clusters = (dataIn['clusters'] ?? []) as Record<string, unknown>[]
    const tx = Number(params['target_x_m'])
    const ty = Number(params['target_y_m'])
    const inside = frameContains(dataIn, tx, ty)
    if (inside === false) {
      return {
        success: true,
        data: {
          verdict: 'undecidable',
          reasons: ['target_outside_frame'],
          frame_contains_target: false,
          n_clusters: clusters.length,
          tolerance_m: tol,
          tolerance_source: tolSrc,
          scan_path: path,
        },
        summary: '目标不在这一帧里,这一帧答不了',
      }
    }
    // ⚠️ **D-ADATOM-1**：旧仓这里读 `c["peak_height_m"]`，而 `ExtractClusters`
    // 交出来的键叫 `peak_height_pm` —— 于是 `min_peak_height_m` 一给，
    // 每一个候选都被 `0.0 < min_h` 滤掉，技能报 `not_found`（「原子不在那儿」），
    // 而诚实的答案是「我把它们全筛掉了」。本仓按 pm 读并换算。
    const minH = numParam(params, 'min_peak_height_m')
    const cands: [number, Record<string, unknown>][] = []
    for (const c of clusters) {
      const x = c['x_m']
      const y = c['y_m']
      if (typeof x !== 'number' || typeof y !== 'number') continue
      const peakM = peakHeightM(c)
      if (minH !== null && peakM < minH) continue
      cands.push([Math.hypot(x - tx, y - ty), c])
    }
    cands.sort((a, b) => a[0] - b[0])

    const warns: string[] = []
    const exp = numParam(params, 'expected_count')
    if (exp !== null && clusters.length !== Math.trunc(exp)) warns.push('count_mismatch')
    const base: Record<string, unknown> = {
      tolerance_m: tol,
      tolerance_source: tolSrc,
      n_clusters: clusters.length,
      n_candidates: cands.length,
      frame_contains_target: true,
      scan_path: path,
      warnings: warns,
      others: cands.slice(1, 6).map(([d, c]) => ({
        x_m: c['x_m'],
        y_m: c['y_m'],
        dist_m: d,
        peak_height_m: peakHeightM(c),
      })),
    }
    if (cands.length === 0) {
      return { success: true, data: { verdict: 'not_found', ...base }, summary: '这一帧的目标附近没有团簇' }
    }
    const [d0, best] = cands[0] as [number, Record<string, unknown>]
    const nClose = cands.filter(([d]) => d <= 2 * tol).length
    Object.assign(base, {
      residual_m: d0,
      residual_nm: d0 * 1e9,
      found_x_m: best['x_m'],
      found_y_m: best['y_m'],
      nearest_cluster: best,
      n_candidates_within_2tol: nClose,
    })
    let verdict: string
    let summary: string
    if (d0 <= tol && nClose <= 1) {
      verdict = 'at_target'
      summary = `原子在目标上,残差 ${pyFixed(d0 * 1e12, 0)} pm`
    } else if (d0 <= 2 * tol || nClose > 1) {
      verdict = 'ambiguous'
      summary = `目标附近有 ${nClose} 个候选,说不清是哪一个`
    } else if (d0 <= 10 * tol) {
      verdict = 'displaced'
      summary = `找到了,但偏了 ${pyFixed(d0 * 1e9, 2)} nm`
    } else {
      verdict = 'not_found'
      summary = `最近的团簇在 ${pyFixed(d0 * 1e9, 1)} nm 外`
    }
    return { success: true, data: { verdict, ...base }, summary }
  },
}

/** 团簇的峰高（米）。见 D-ADATOM-1：`ExtractClusters` 只交 `peak_height_pm`。 */
function peakHeightM(c: Record<string, unknown>): number {
  const pm = c['peak_height_pm']
  return typeof pm === 'number' && Number.isFinite(pm) ? pm * 1e-12 : 0
}

/**
 * 目标在不在帧的足迹里？`null` = 几何读不出来。
 *
 * `ExtractClusters` 把几何放在 `frame` 块里；到顶层去找找不到，这道检查就会
 * **静默地永远不跑** —— 于是一个帧根本覆盖不到的目标会以 `not_found`
 * （「原子不在那儿」）回来，而诚实的答案是「这一帧答不了」。
 */
function frameContains(data: Record<string, unknown>, x: number, y: number): boolean | null {
  const geom = (typeof data['frame'] === 'object' && data['frame'] !== null ? data['frame'] : data) as Record<
    string,
    unknown
  >
  const cx = geom['cx_m']
  const cy = geom['cy_m']
  const w = geom['w_m']
  const h = geom['h_m']
  if ([cx, cy, w, h].some((v) => v === null || v === undefined)) return null
  return Math.abs(x - Number(cx)) <= Number(w) / 2 && Math.abs(y - Number(cy)) <= Number(h) / 2
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function cmpMask(m: Mat, level: number, above: boolean): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let i = 0; i < out.length; i += 1) {
    const v = m.data[i] as number
    out[i] = (above ? v > level : v < level) ? 1 : 0
  }
  return matOf(m.rows, m.cols, out)
}

function countOn(m: Mat): number {
  let n = 0
  for (let i = 0; i < m.data.length; i += 1) if ((m.data[i] as number) !== 0) n += 1
  return n
}

function argmaxLabel(sizes: Int32Array): number {
  let top = 0
  for (let i = 1; i < sizes.length; i += 1) if ((sizes[i] as number) > (sizes[top] as number)) top = i
  return sizes.length === 0 ? 0 : top + 1
}

function pixelsOf(labels: Int32Array, rows: number, cols: number, lab: number): { ys: number[]; xs: number[] } {
  const ys: number[] = []
  const xs: number[] = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if ((labels[r * cols + c] as number) === lab) {
        ys.push(r)
        xs.push(c)
      }
    }
  }
  return { ys, xs }
}

function blobOf(labels: Int32Array, rows: number, cols: number, lab: number): Mat {
  const out = new Float64Array(rows * cols)
  for (let i = 0; i < out.length; i += 1) out[i] = (labels[i] as number) === lab ? 1 : 0
  return matOf(rows, cols, out)
}

function avg(xs: readonly number[]): number {
  let s = 0
  for (const v of xs) s += v
  return xs.length === 0 ? NaN : s / xs.length
}

/** 这一族四个技能的登记表。 */
export const ANALYSIS_CLUSTERS: Readonly<Record<string, Skill>> = {
  ExtractClusters,
  AssessClusterRoundness,
  SelectPokedCluster,
  VerifyAdatomAt,
}
