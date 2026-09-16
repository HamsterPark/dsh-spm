/**
 * 团簇提取的判据本体 —— 旧仓 `mast/skills/builtins/cluster_extract.py` 的 `execute`
 * 与两个 helper（`_axes` / `_describe_side` / `_plane_pp`），**只留判据，不碰文件**。
 *
 * ## 「提取」与「判定」是两层，这一层**不挑、不判、不过滤**
 *
 * 2026-08-10 现场原话：「团簇是不是应该先提取再判定？那样的话就不在乎半张图。
 * 而且如果你在一个图里面扎好几次呢？」焊在一起的后果两个，都在真机数据上复现了：
 *
 * * **半张图直接失败**：24 张新帧里 11 张没扫完，全部返回「flat or unreadable scan」，
 *   而它们已扫区的去趋势 RMS 是 11.5–502.5 pm，全是真信号。根因是
 *   `plane_subtract` 遇到 NaN 行返回全 NaN —— 报错文案说「flat」，
 *   而真相是我们自己把它变成了 NaN；
 * * **一帧多个团簇时挑错**：按面积最大挑，挑中的是一条长宽比 0.016 的扫描线扰动，
 *   而真正的团簇长宽比 0.834。一次修针会留下一串坑，「最大的那个」routinely 是
 *   上一次留下的。
 *
 * ## 默认吃 **RAW**，而且**永远不做逐行平场**
 *
 * 真机 `_0060`（四针扎在已知坐标），同帧同参数只换预处理：
 *
 * ```
 * RAW        4 个: 575px/1531pm, 74/450, 72/444, 67/439   连通域 62
 * 全局平面    4 个: 541px/1515pm, 74/465, 61/445, 60/437   连通域 113
 * 逐行 poly1  4 个: 717px/452pm,  508/1329, 71/445, 65/429
 * ```
 *
 * RAW 最干净（连通域 62 vs 113，多出来的全是噪声）⇒ 默认 RAW，理由是**信噪比**；
 * 全局平面不毁团簇 ⇒ 留作可选，用没用要报出来；
 * **逐行 poly1 会毁** —— 一行里有大团簇时那一行的拟合被团簇**自己**抬起来，
 * 减掉之后团簇减掉了自己，**越大越宽伤得越狠**，正好伤在我们要找的那一种上。
 * ⇒ **连选项都不提供，传进来直接拒绝。**
 *
 * ## `_axes` 报的是**全长**（4σ），不是标准差
 *
 * 2026-08-11 之前它返回 `sqrt(eig)`（沿主轴的 σ），而字段名叫 `major_nm`。
 * 均匀圆盘的 σ = R/2 = D/4 ⇒ **报出来的「长轴」只有真实直径的四分之一**。
 * 这条对用户直接有害：他判针尖靠「最后要得到一个**较小的**圆团簇」，
 * 而一个报成 0.65 nm 的团簇实际有 2.5 nm 宽 —— 报数把「还不够小」说成
 * 「已经很小了」，正好朝着**提前收工**的方向骗人。
 *
 * 取 4σ 不取 Feret 径：后者由**两个像素**决定，阈值边缘上多挂一个噪声像素就整体变长；
 * 4σ 用全部像素，单个离群像素的权重是 1/N。
 *
 * ## 容差
 *
 * 与 `plane.ts` / `roundness.ts` 同表；这一层自己只多两件：
 *
 * | 件 | 容差 | 为什么 |
 * |---|---|---|
 * | `labelled` / `areaPx` / `touchesEdge` / `nRaw` | **0** | 掩膜、标签、计数，全是整数与搬运 |
 * | `aspect` / `major` / `minor` | `sumRelTol(n)` | 一次协方差 + 一个 2×2 闭式特征值 |
 */
import { labelConnected, matAt, matOf, type Mat } from 'dsh-spm-numerics'
import { eigvalsh2, nanMax, nanMedian, nanMin } from './nd.js'
import { acquiredRowMask, cropRows } from './frame-validity.js'
import { MAD_TO_SIGMA, planePeakToPeak, planeSubtractOls } from './plane.js'
import { assessMask, roundnessDict } from './roundness.js'
import { parseXyMeta, pxToM } from './xy-meta.js'
import { formatG, pyFixed } from 'dsh-spm-kernel'

/** 分割阈值（中位数 ± k×σ_MAD）。**未标定。**
 *
 * ⚠️ MAD → σ 的那个 1.4826 走 `plane.ts` 的 {@link MAD_TO_SIGMA} —— **同一个常数
 * 在本包里只许有一份**。旧仓这个数在 `tilt.py`、`cluster_extract.py`、
 * `step_edge.py`、`frame_trust.py` 里各写了一遍（四份），而它们当然全都相等 ——
 * 直到哪天不等。 */
export const DEFAULT_THRESHOLD_MAD = 3.0

/** 倾斜告警的比值门。**没有任何标定数据支撑** —— 已知正常的帧比值到 13.1 都工作正常。 */
export const DEFAULT_TILT_WARN_RATIO = 20.0

/** 最小连通域像素数。**不承担分辨力**，只为把列表变得可读（真机一帧 326 个连通域）。 */
export const DEFAULT_MIN_AREA_PX = 4

/** 返回多少个（按面积降序截断）。 */
export const DEFAULT_MAX_CLUSTERS = 50

/** 「按扎针坐标找最近的那个」容差，**给判定层用**。3 nm ≈ 0.54 + 3×0.96（实测分解，n=4）。 */
export const DEFAULT_ANCHOR_TOLERANCE_M = 3e-9

/** 「500 pm 扎出的团簇一般不超过 3 nm」—— 用户口述。**经验范围，不是硬上界**，
 * 只用来打 `size_plausible=false` 这个提示，绝不用来拒绝。 */
export const PLAUSIBLE_MAX_DIAMETER_M = 3e-9

/** 逐行平场的那几个名字 —— 传进来**直接拒绝**（见文件抬头）。 */
export const LINE_LEVELS: readonly string[] = ['line', 'line_by_line', 'poly1', 'poly2', 'median']

export const LINE_LEVEL_REFUSAL =
  '逐行平场会把团簇吃掉,本技能不提供。实测同一帧:逐行 poly1 把一个 ' +
  '575px/1531pm 的团簇打成 508px/1329pm,并凭空造出一个 717px 的伪影。' +
  '机制:一行里有大团簇时,那一行的拟合被团簇自己抬起来,减掉之后' +
  '团簇减掉了自己 —— 越大越宽伤得越狠,正好伤在我们要找的那一种上。' +
  "请用 level='none'(RAW,默认)或 'plane'(单个全局平面)。"

/** `(major, minor, aspect)` —— major/minor 是**全长**（等效椭圆的 4σ）。 */
export function axesOfBlob(
  xs: readonly number[],
  ys: readonly number[],
  sx = 1.0,
  sy = 1.0,
): [number, number, number] {
  const n = ys.length
  if (n < 4) return [0, 0, 0]
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i += 1) {
    mx += xs[i] as number
    my += ys[i] as number
  }
  mx /= n
  my /= n
  // 协方差在**米**里算，不是在像素里算再乘：长轴根本不一定沿着 x。
  const X = xs.map((v) => (v - mx) * sx)
  const Y = ys.map((v) => (v - my) * sy)
  let ex = 0
  let ey = 0
  for (let i = 0; i < n; i += 1) {
    ex += X[i] as number
    ey += Y[i] as number
  }
  ex /= n
  ey /= n
  let cxx = 0
  let cyy = 0
  let cxy = 0
  for (let i = 0; i < n; i += 1) {
    const dx = (X[i] as number) - ex
    const dy = (Y[i] as number) - ey
    cxx += dx * dx
    cyy += dy * dy
    cxy += dx * dy
  }
  // `np.cov` 缺省 `ddof=1`
  cxx /= n - 1
  cyy /= n - 1
  cxy /= n - 1
  const [lo, hi] = eigvalsh2(cxx, cxy, cyy)
  const minor = 4 * Math.sqrt(Math.max(lo, 0))
  const major = 4 * Math.sqrt(Math.max(hi, 0))
  return [major, minor, major > 0 ? minor / major : 0]
}

/** 一侧极性的证据（`polarity_evidence` 的一项）。 */
export interface SideEvidence {
  readonly n_raw: number
  readonly n_above_min_area: number
  readonly largest_area_px: number
  readonly largest_aspect: number
  readonly largest_peak_pm: number
}

interface Side extends SideEvidence {
  readonly labels: Int32Array
}

function describeSide(mask: Mat, leveled: Mat, med: number, side: 'bright' | 'dark', minArea: number): Side {
  const lab = labelConnected(mask, 4)
  let largestArea = 0
  let largestAspect = 0
  let largestPeak = 0
  let nKept = 0
  if (lab.count > 0) {
    for (let i = 0; i < lab.count; i += 1) if ((lab.sizes[i] as number) >= minArea) nKept += 1
    // `sizes.argmax()`：第一个最大值
    let top = 0
    for (let i = 1; i < lab.count; i += 1) {
      if ((lab.sizes[i] as number) > (lab.sizes[top] as number)) top = i
    }
    const topLabel = top + 1
    const ys: number[] = []
    const xs: number[] = []
    const vals: number[] = []
    for (let r = 0; r < mask.rows; r += 1) {
      for (let c = 0; c < mask.cols; c += 1) {
        if ((lab.labels[r * mask.cols + c] as number) !== topLabel) continue
        ys.push(r)
        xs.push(c)
        vals.push(matAt(leveled, r, c))
      }
    }
    largestArea = ys.length
    largestAspect = axesOfBlob(xs, ys)[2]
    largestPeak = side === 'bright' ? nanMax(vals) - med : med - nanMin(vals)
  }
  return {
    labels: lab.labels,
    n_raw: lab.count,
    n_above_min_area: nKept,
    largest_area_px: largestArea,
    largest_aspect: largestAspect,
    largest_peak_pm: largestPeak * 1e12,
  }
}

/** 一个团簇。键名与旧仓 `SkillResult.data['clusters'][i]` 逐字相同。 */
export interface ClusterRow {
  id: number
  x_m: number | null
  y_m: number | null
  x_px: number
  y_px: number
  area_px: number
  area_nm2: number | null
  equiv_diameter_nm: number | null
  major_nm: number | null
  minor_nm: number | null
  aspect: number
  radial_dispersion: number | string | null
  radial_dispersion_floor: number | string | null
  radial_dispersion_excess: number | string | null
  equivalent_axis_ratio: number | string | null
  roundness_undecidable: number | string | null
  peak_height_pm: number
  touches_edge: boolean
  touches_unscanned: boolean
  size_plausible: boolean
  rank?: number
}

export interface ExtractParams {
  polarity?: string
  thresholdMad?: number
  level?: string
  tiltWarnRatio?: number | null
  minAreaPx?: number
  maxClusters?: number
}

/** 成功：`data` 就是技能要交出去的那个 dict（少了 `scan_path`，那是外壳的事）。 */
export type ExtractOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; data?: Record<string, unknown> }

/**
 * 分割一帧里的所有团簇。`img` 是**几何归位之后**的正扫帧（`sxmOrientedFrames`），
 * `header` 是 `.sxm` 头。
 */
export function extractClusters(
  img: Mat,
  header: Readonly<Record<string, unknown>>,
  params: ExtractParams = {},
): ExtractOutcome {
  const kMad = params.thresholdMad ?? DEFAULT_THRESHOLD_MAD
  const minArea = params.minAreaPx ?? DEFAULT_MIN_AREA_PX
  const maxClusters = params.maxClusters ?? DEFAULT_MAX_CLUSTERS
  const polarity = (params.polarity ?? 'auto').trim().toLowerCase()

  const nyFull = img.rows
  const nxFull = img.cols
  if (nyFull === 0 || nxFull === 0) {
    return { ok: false, error: `不是二维图像: shape=(${nyFull}, ${nxFull})` }
  }

  // ── 只吃已扫区域 ──（判据是「**整行**都是有限值」，不是「这一行有任何有限值」）
  const fullRows = acquiredRowMask(img)
  let nScanned = 0
  for (let i = 0; i < fullRows.length; i += 1) if (fullRows[i] === 1) nScanned += 1
  if (nScanned < 2) {
    return {
      ok: false,
      error:
        `只有 ${nScanned} 行是扫完整的(共 ${nyFull} 行)——` +
        '这一帧还没有可分析的区域。这是**输入还没准备好**,' +
        '不是这一帧坏了。',
      data: { rows_total: nyFull, rows_scanned: nScanned },
    }
  }
  const crop = cropRows(img, fullRows)

  const level = (params.level ?? 'none').trim().toLowerCase()
  if (LINE_LEVELS.includes(level)) return { ok: false, error: LINE_LEVEL_REFUSAL }
  if (level !== 'none' && level !== 'plane') {
    return { ok: false, error: `level 只能是 none | plane,收到 '${level}'` }
  }

  // 残余斜率：「在调平的情况下」这个前提要能判，所以量出来报出去。
  const tiltPpM = planePeakToPeak(crop)
  const leveled = level === 'plane' ? planeSubtractOls(crop) : crop
  let anyFinite = false
  for (let i = 0; i < leveled.data.length; i += 1) {
    if (Number.isFinite(leveled.data[i] as number)) {
      anyFinite = true
      break
    }
  }
  if (!anyFinite) {
    return {
      ok: false,
      error: '平场之后没有有限值 —— 这一帧无法分析',
      data: { rows_total: nyFull, rows_scanned: nScanned },
    }
  }

  const med = nanMedian(leveled.data)
  const absDev: number[] = []
  for (let i = 0; i < leveled.data.length; i += 1) absDev.push(Math.abs((leveled.data[i] as number) - med))
  const sigma = nanMedian(absDev) * MAD_TO_SIGMA
  if (!(sigma > 0)) {
    return {
      ok: false,
      error:
        '已扫区域的 MAD 是 0 —— 这一段真的是死平的' +
        '(注意:这条只对**已扫区域**成立,不是被 NaN 行拖累的)',
      data: { rows_total: nyFull, rows_scanned: nScanned },
    }
  }

  const tiltRatio = params.tiltWarnRatio === undefined ? DEFAULT_TILT_WARN_RATIO : params.tiltWarnRatio
  let tiltWarning: string | null = null
  if (tiltRatio !== null && sigma > 0 && tiltPpM / sigma > tiltRatio) {
    tiltWarning =
      `整帧残余斜面峰谷 ${pyFixed(tiltPpM * 1e12, 0)} pm = ${pyFixed(tiltPpM / sigma, 1)}×噪声,` +
      `超过 ${formatG(tiltRatio, 6)}× —— **这一帧可能没调平**,RAW 阈值分割` +
      '可能被斜坡主导。可以试 level=\'plane\',但请注意那会同时抬高噪声连通域数。' +
      '(这个门**没有标定数据**:已知正常的帧比值到 13.1 都工作正常。)'
  }

  // ── 极性 ──
  const sides: Record<'bright' | 'dark', Side> = {
    bright: describeSide(thresholdMask(leveled, med + kMad * sigma, true), leveled, med, 'bright', minArea),
    dark: describeSide(thresholdMask(leveled, med - kMad * sigma, false), leveled, med, 'dark', minArea),
  }
  let chosen: 'bright' | 'dark'
  let rule: string
  if (polarity === 'bright' || polarity === 'dark') {
    chosen = polarity
    rule = 'caller'
  } else {
    // 「更紧凑」= 最大连通域的长宽比更高，并列时比峰高。**规则未标定**，
    // 所以两边的证据都报出来，调用方看着不对可以直接指定 polarity。
    const b = sides.bright
    const d = sides.dark
    const ge =
      b.largest_aspect > d.largest_aspect ||
      (b.largest_aspect === d.largest_aspect && b.largest_peak_pm >= d.largest_peak_pm)
    chosen = ge ? 'bright' : 'dark'
    rule = 'auto:更紧凑(最大连通域长宽比,并列时比峰高)'
  }
  const labelled = sides[chosen].labels
  const nRaw = sides[chosen].n_raw

  // ── 坐标 ──
  const meta = parseXyMeta(header)
  let cxM = 0
  let cyM = 0
  let wM = NaN
  let hM = NaN
  let angleDeg = 0
  let angleKnown = false
  if (meta !== null) {
    cxM = meta.cx
    cyM = meta.cy
    wM = meta.w
    hM = meta.h
    angleDeg = meta.angle
    angleKnown = meta.angleKnown
  }
  const haveGeomFrame = Number.isFinite(wM) && Number.isFinite(hM)
  // 传的是 **nyFull / nxFull**，不是裁剪后的行数 —— 裁剪只砍掉了末尾未扫的行，
  // 保留行的行号与原帧一致，所以 y 换算必须按原帧算。
  const toM = (pxX: number, pxY: number): [number | null, number | null] =>
    haveGeomFrame
      ? pxToM(pxX, pxY, { nx: nxFull, ny: nyFull, cxM, cyM, wM, hM, angleDeg })
      : [null, null]
  const pxAreaM2 = Number.isFinite(wM) ? (wM / nxFull) * (hM / nyFull) : NaN
  const pxMX = Number.isFinite(wM) ? wM / nxFull : NaN
  const pxMY = Number.isFinite(hM) ? hM / nyFull : NaN
  const haveGeom = Number.isFinite(pxMX) && Number.isFinite(pxMY)

  const clusters: ClusterRow[] = []
  for (let labId = 1; labId <= nRaw; labId += 1) {
    const ys: number[] = []
    const xs: number[] = []
    const vals: number[] = []
    for (let r = 0; r < crop.rows; r += 1) {
      for (let c = 0; c < crop.cols; c += 1) {
        if ((labelled[r * crop.cols + c] as number) !== labId) continue
        ys.push(r)
        xs.push(c)
        vals.push(matAt(leveled, r, c))
      }
    }
    const areaPx = ys.length
    if (areaPx < minArea) continue
    const [majorLen, minorLen, aspect] = axesOfBlob(xs, ys, haveGeom ? pxMX : 1.0, haveGeom ? pxMY : 1.0)
    const peakM = chosen === 'dark' ? med - nanMin(vals) : nanMax(vals) - med
    let cyPx = 0
    let cxPx = 0
    for (let i = 0; i < areaPx; i += 1) {
      cyPx += ys[i] as number
      cxPx += xs[i] as number
    }
    cyPx /= areaPx
    cxPx /= areaPx
    const [xM, yM] = toM(cxPx, cyPx)
    const areaM2 = Number.isFinite(pxAreaM2) ? areaPx * pxAreaM2 : NaN
    const equivDM = Number.isFinite(areaM2) && areaM2 > 0 ? 2 * Math.sqrt(areaM2 / Math.PI) : NaN
    const blob = blobMask(labelled, crop.rows, crop.cols, labId)
    const rnd = roundnessDict(assessMask(blob))
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < areaPx; i += 1) {
      const x = xs[i] as number
      const y = ys[i] as number
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    clusters.push({
      id: labId,
      x_m: xM,
      y_m: yM,
      x_px: cxPx,
      y_px: cyPx,
      area_px: areaPx,
      area_nm2: Number.isFinite(areaM2) ? areaM2 * 1e18 : null,
      equiv_diameter_nm: Number.isFinite(equivDM) ? equivDM * 1e9 : null,
      major_nm: haveGeom ? majorLen * 1e9 : null,
      minor_nm: haveGeom ? minorLen * 1e9 : null,
      aspect,
      ...(rnd as Record<string, number | string | null>),
      peak_height_pm: peakM * 1e12,
      touches_edge: minX === 0 || minY === 0 || maxX === crop.cols - 1 || maxY === crop.rows - 1,
      // 贴着扫描前沿 = 它很可能只被扫了一半。**标记不过滤**。
      touches_unscanned: nScanned < nyFull && maxY === crop.rows - 1,
      size_plausible: !Number.isFinite(equivDM) || equivDM <= PLAUSIBLE_MAX_DIAMETER_M,
    } as ClusterRow)
  }

  // `list.sort(key=-area)` 是**稳定**排序 —— 面积并列时保持标签顺序。
  clusters.sort((a, b) => b.area_px - a.area_px)
  const truncated = clusters.length > maxClusters
  const kept = truncated ? clusters.slice(0, maxClusters) : clusters
  kept.forEach((c, i) => {
    c.rank = i + 1
  })

  return {
    ok: true,
    data: {
      frame: {
        cx_m: cxM,
        cy_m: cyM,
        w_m: wM,
        h_m: hM,
        angle_deg: angleDeg,
        // 角度不可知时坐标未经验证 —— 说出来，不要按 0° 悄悄算。
        angle_known: angleKnown,
        rows_total: nyFull,
        rows_scanned: nScanned,
        cols: nxFull,
      },
      polarity_used: chosen,
      polarity_rule: rule,
      polarity_evidence: {
        bright: evidenceOf(sides.bright),
        dark: evidenceOf(sides.dark),
      },
      threshold_mad: kMad,
      leveling_used: level,
      tilt_pp_pm: tiltPpM * 1e12,
      tilt_over_sigma: sigma > 0 ? tiltPpM / sigma : null,
      tilt_warning: tiltWarning,
      min_area_px: minArea,
      n_raw_components: nRaw,
      n_clusters: kept.length,
      truncated,
      clusters: kept,
    },
  }
}

function evidenceOf(s: Side): SideEvidence {
  return {
    n_raw: s.n_raw,
    n_above_min_area: s.n_above_min_area,
    largest_area_px: s.largest_area_px,
    largest_aspect: s.largest_aspect,
    largest_peak_pm: s.largest_peak_pm,
  }
}

function thresholdMask(m: Mat, level: number, above: boolean): Mat {
  const out = new Float64Array(m.rows * m.cols)
  for (let i = 0; i < out.length; i += 1) {
    const v = m.data[i] as number
    // NaN 两侧都是 False（同 numpy 的比较语义）
    out[i] = (above ? v > level : v < level) ? 1 : 0
  }
  return matOf(m.rows, m.cols, out)
}

function blobMask(labels: Int32Array, rows: number, cols: number, labId: number): Mat {
  const out = new Float64Array(rows * cols)
  for (let i = 0; i < out.length; i += 1) out[i] = (labels[i] as number) === labId ? 1 : 0
  return matOf(rows, cols, out)
}
