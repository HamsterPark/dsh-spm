/**
 * 扫描地图的**访问入口** —— 让技能层也读得到「这片表面已经发生过什么」。
 *
 * 旧仓 `mast/core/map_scope.py` 的三件：{@link analysisConfig} ·
 * {@link loadMarkers} · {@link crashMemoryMarkers}。
 *
 * 在这一层存在之前，地图只有 agent 工具层读得到，于是任何**在组合技能内部**
 * 决定「下一个动作落在哪」的流程，都只能靠自己在内存里记这一轮用过的点 ——
 * 冷启动看不见上一轮的坑，第二次调用会把针尖扎回同一个地方。
 * 修针流程每打一发脉冲就要换一个地方，而「哪里还干净」全写在地图里。
 *
 * ## 三个函数都 fail-soft，而**空表的含义是「不知道」**
 *
 * 读不到实验记录返回空表而不是抛。**空表不等于「这片表面是干净的」** ——
 * 调用方据此决定要不要动手时必须把这个区别说出来。
 * {@link loadMarkers} 因此把 `available` 一路交出去；
 * 而 {@link crashMemoryMarkers} **没有**这样一个布尔（旧仓如此，照移），
 * 后果写在它自己的抬头上。
 *
 * ## 零 I/O：记录从哪来是**注入**的
 *
 * `kernel` 不碰存储（PLAN §6.1-2），所以「当前实验的地图行」走
 * {@link processExpMap}`.markerRows` 这个口子 —— 与 `processInstrumentProfile.source`
 * / `processTipCrash.config` 同一条缝。**宿主没接 = 读不到记录**，
 * 而那与「这片表面什么都没发生过」是两句话。
 *
 * ## ⚠️ 写侧 `record_damage_marker` **没搬**
 *
 * 它是 `loadMarkers` 的对偶（同一个 storage、同一个 scope），旧仓把两个函数
 * 放在同一个文件里正是为了「谁改都会看见另一个」。本批没搬的理由是**本仓还没有
 * 任何一个消费方**：没有技能会写损伤标记（`TipPulse` / `TipShape` 都不写），
 * 所以搬过来就是一段没有调用者的代码。登记见 `spec/deviations.md`（批 7a-2）——
 * 它是一笔**点名的欠账**，不是一次遗漏：第一个要写标记的技能落地时，
 * 它必须和那个技能同批，否则 `map_known=true` 而地图永远是空的。
 */

import { getConfig, readProfile } from './instrument-profile.js'
import type { AnalysisConfig } from './map-analysis.js'
import { DEFAULT_ANALYSIS_CONFIG } from './map-analysis.js'
import type { MapMarker, MapMarkerRow } from './exp-map.js'
import { mapMarker, markersFromRows } from './exp-map.js'
import { currentEpochOf, filterEpoch } from './map-analysis.js'
import { getTipCrashTracker } from './tip-crash-tracker.js'

/**
 * 进程内的地图**读口**。
 *
 * 它交出的是**当前实验 / 样品的原始行，跨所有代次** —— 按代次过滤是
 * {@link loadMarkers} 的事。两份取数迟早只有一份对，所以只留一份。
 *
 * ## 三态怎么表达（与旧仓的分工不同，登记见 deviations 批 7a-2）
 *
 * | | 含义 |
 * |---|---|
 * | `markerRows === null` | **宿主没接** ⇒ 读不到 |
 * | 读口返回 `null` / 抛 | **读不到**（旧仓的「没有活动实验」/「存储不可用」/「取数抛」三条合成一条） |
 * | 读口返回一个表（可以是空的） | **读到了** |
 *
 * 旧仓 `marker_rows` 里那句 `storage.get_markers(...) or []` ——「存储答了，
 * 里面是空的」—— 在本仓属于**宿主适配器**那一侧：内核拿不到 storage，
 * 也就无从区分「存储说没有」与「问不到存储」。适配器该写 `rows ?? []`。
 */
export const processExpMap: {
  markerRows: (() => readonly MapMarkerRow[] | null) | null
} = { markerRows: null }

/** `(rows, available)`。`available === false` = **读不到记录**，不是「什么都没发生过」。 */
export interface MarkerRowsRead {
  readonly rows: readonly MapMarkerRow[]
  readonly available: boolean
}

/**
 * 当前实验 / 样品的**原始**地图行，跨所有代次。
 *
 * `available` 为 false = 读不到记录（宿主没接读口 / 没有活动实验 / 存储不可用），
 * 不是「这里什么都没发生过」。**这两件事在几何上无法区分**，必须一路传给调用方。
 */
export function markerRows(): MarkerRowsRead {
  const src = processExpMap.markerRows
  if (src === null) return { rows: [], available: false }
  try {
    const rows = src()
    if (rows === null || rows === undefined) return { rows: [], available: false }
    return { rows: [...rows], available: true }
  } catch {
    // 读扫描地图失败 ⇒ 按「不知道」处理。**绝不按「干净」处理。**
    return { rows: [], available: false }
  }
}

export interface LoadedMarkers {
  readonly markers: readonly MapMarker[]
  readonly epoch: number
  readonly available: boolean
}

/**
 * 当前坐标代次的地图标记。
 *
 * 只给当前代次：横向粗动之后旧坐标指的是**另一片表面**，混代次会把新鲜表面
 * 标成已经用过的。
 *
 * `available` 为 false 时 `markers` 是空表。空表和「这片表面确实干净」在几何上
 * 无法区分，所以这个布尔值必须一路传到调用方：**在读不到历史的情况下往表面打
 * 10 V 脉冲，和在确认干净的地方打，是两件不同的事。**
 */
export function loadMarkers(opts: { readonly allEpochs?: boolean } = {}): LoadedMarkers {
  const { rows, available } = markerRows()
  if (!available) return { markers: [], epoch: 0, available: false }
  const epoch = currentEpochOf(rows)
  const live = opts.allEpochs === true ? rows : filterEpoch(rows, epoch)
  return { markers: markersFromRows(live), epoch, available: true }
}

export interface CrashMemory {
  readonly markers: readonly MapMarker[]
  /** 记到了、但**坐标不知道**的撞针次数 —— 它避不开，调用方必须说出来。 */
  readonly unlocated: number
}

/**
 * 本进程记着的撞针点，借用地图标记的形状。
 *
 * ## 为什么需要第二个来源
 *
 * 撞针有**两份**记忆，而它们的失效方式正好互补：
 *
 * * **地图标记**（`kind="crash"`，落库）—— 跨重启、带代次，是权威的那一份；
 * * **{@link getTipCrashTracker}**（进程内，30 min TTL）—— 撞针当场就有。
 *
 * 落库那一步是 fire-and-forget 且整段包在 `except` 里，没有活动实验时直接
 * return。也就是说存在一段时间、以及一整类情形，**撞针已经发生、追踪器已经记下、
 * 地图上却什么都没有**。这时选点器只问地图，就会把针尖送回自己刚炸出来的坑，
 * 而且零报错 —— 地图如实回答了「我这儿没有记录」，只是没人问另一个知道的人。
 *
 * 它**只读**：不落库、不补写标记。补写会让追踪器变成第二个生产者，
 * 和记录侧抢同一张表。
 *
 * ## 代次
 *
 * `coordEpoch = null`（从未持久化过，与实时框 / 针尖 / 计划覆盖层同款）。
 * 这不是漏填：横向粗动会把追踪器整个清空，所以里面剩下的东西**必然**属于
 * 当前代次。
 *
 * ## ⚠️ 读不到这一路来源时，它与「问过了、没有」**逐字节相同**
 *
 * 追踪器抛了 ⇒ `([], 0)`。旧仓的抬头写着「读不到这一路来源 ≠ 没撞过，
 * 调用方按『少了一个来源』处理」，**而这个返回值让调用方做不到**：
 * `FindCleanSpot` 的 `avoidance_sources` 靠 `crash_mem` 非空来判断这一路答没答上，
 * 于是「追踪器炸了」和「追踪器好好的、只是没撞过」给出同一份回包。
 *
 * **照移**（这是一条 fail-open，而且是旧仓的原话），登记在
 * `spec/deviations.md`（批 7a-2）。**没有偷偷加一个布尔**：那会改掉模型面的回包，
 * 而 DoD ② 要的是逐字对齐 —— 要补它得连 `FindCleanSpot` 的报文一起改，
 * 那是一个该由人拍板的决定，不该塞进一次移植里。
 */
export function crashMemoryMarkers(): CrashMemory {
  let located: readonly { readonly xM: number; readonly yM: number; readonly count: number }[]
  let unlocated: number
  try {
    const p = getTipCrashTracker().crashPoints()
    located = p.located
    unlocated = p.unlocated
  } catch {
    return { markers: [], unlocated: 0 }
  }
  const markers = located.map((p) =>
    mapMarker({
      // 与落库那条显式分支**同一个 kind** —— 避让半径因此走的是同一个
      // `DAMAGE_KINDS["crash"]`，这里不产生第二套约定。
      kind: 'crash',
      x_m: p.xM,
      y_m: p.yM,
      label: '撞针(本进程记忆)',
      status: 'failed',
      source: 'live', // 未持久化，和实时框 / 针尖一样
      meta: { crash_count: Math.trunc(p.count), from: 'tip_crash_tracker' },
    }),
  )
  return { markers, unlocated: Math.trunc(unlocated) }
}

// ── analysis_config ─────────────────────────────────────────────────────

/** 一份「够用的」实时状态：这一层只要扫描框宽度。 */
export interface AnalysisStateSource {
  readonly scanWidthM: number | null
}

export interface AnalysisConfigOptions {
  /** `SafetyLimits.xy_max_m`。**读不到就别传** —— 传 `0` 与不传是同一件事（旧仓真值判断）。 */
  readonly safetyXyMaxM?: unknown
  /** 显式帧尺寸，压过实时状态。 */
  readonly frameSizeM?: number | null
}

/**
 * 本机的 {@link AnalysisConfig} —— 由**仪器档案 + 安全上限 + 实时扫描框**拼出来。
 *
 * 避让半径、进针是否伤表面、选点策略全部来自档案：同一个物理量只有一个来源，
 * 否则 agent 看到的地图和用户看到的会各自漂移。
 *
 * **永不抛**：任何一步失败，调用方仍拿到一份可用的配置。
 *
 * ## 两种读档案的方式，差别咬过人
 *
 * | | 回退顺序 | 用在哪 |
 * |---|---|---|
 * | {@link nm}（= `get_config`） | 档案值 → **出厂默认** → 调用方默认 | 三个半径 |
 * | {@link nmUnlessSet}（= 只看 `get_profile`） | 档案值 → **调用方默认** | `pulse_r_m` / `center_zone_side_m` |
 *
 * 第一种里那个「出厂默认」会**把调用方的默认整个遮蔽掉** —— 它永远轮不到。
 * 2026-08-13 真机实测到这条：`avoid_radius_pulse_nm` 的出厂默认是 150，于是这里
 * 按「有没有 XY 粗动」算出来的那个数**一次都没生效过**。症状完全正常：地图上
 * 避让圆有了、半径是个合理数字、零报错 —— 是数了那个圆的半径（150 nm）才发现的。
 *
 * ⚠️ 两条路在**最后一位上也分得开**：出厂那条走 `150.0 * 1e-9`（
 * `1.5000000000000002e-7`），而调用方默认是字面量 `200e-9`（`2e-7`）。
 * 金样 `config.factory` 把这一位钉住了。
 */
export function analysisConfig(
  state: AnalysisStateSource | null = null,
  opts: AnalysisConfigOptions = {},
): AnalysisConfig {
  let half = 1.5e-6
  const xyMax = opts.safetyXyMaxM
  // `if xy_max:` 是**真值判断**，不是 `is not None` —— `0` 当成「没给」。
  if (pyTruthy(xyMax)) {
    const f = pyFloat(xyMax)
    // `float("很大")` 抛 ⇒ 整段 except ⇒ 沿用 1.5 µm（fail-soft，**不是 0**）。
    if (f !== null) half = Math.abs(f)
  }

  // 候选路线的间距要贴着用户实际在用的扫描框 —— 按 100 nm 帧排的路线，
  // 放到 1 µm 的巡览上是错的。
  let frame = 100e-9
  const explicit = opts.frameSizeM
  if (explicit !== null && explicit !== undefined && explicit > 0) {
    frame = explicit
  } else {
    const w = state === null ? null : state.scanWidthM
    if (w !== null && w !== undefined && 1e-10 < w && w < half * 2) frame = w
  }

  const coarse = hasXyCoarseMotion()
  return {
    piezoHalfRangeM: half,
    gridCellM: DEFAULT_ANALYSIS_CONFIG.gridCellM,
    tipShapeRM: nm('avoid_radius_tip_shape_nm', 30e-9),
    // 脉冲避让半径 —— **2026-08-17 起两档都是 200 nm**，现场选定。
    //
    // 500 nm 那一档被撤掉的理由是它在这台机器上**没有可用解**：
    // 压电半程 ±1219 nm、格距 2×500 = 1000 nm ⇒ 整片范围只放得下 9 个落点，
    // 「只用中间」的子区域只剩 **1 个**（区心）⇒ 任何一个盘挡上就归零 ⇒
    // 粗动换区必然重新进针、新区照样归零 ⇒ **无限换区**（2026-08-17 真机连着两版）。
    // 200 nm ⇒ 格距 400 nm ⇒ 中心区 ±600 里有 3×3 = 9 个落点：挡掉一个还剩八个。
    // **有余量，才不会死锁。** 代价是脉冲坑之间只隔 400 nm（原来 1000）——
    // 要改回去，先想清楚一个区里剩几个落点。
    pulseRM: nmUnlessSet('avoid_radius_pulse_nm', 200e-9),
    crashRM: nm('avoid_radius_crash_nm', 150e-9),
    approachRM: nm('avoid_radius_approach_nm', 200e-9),
    approachDamages: approachDamagesSurface(),
    strategy: scanPathStrategy(),
    frameSizeM: frame,
    // 间距因子过去从没被传过 —— 默认 1.2 就是「尽可能挨着排」，而用户要的是
    // 更分散（#23）。环宽跟着走：只拉开环上的点距而不拉开环间距，只会把
    // 「挨着排」从一个方向换到另一个方向。
    ringWidthFactor: spacing(),
    pointSpacingFactor: spacing(),
    edgeMarginFrac: DEFAULT_ANALYSIS_CONFIG.edgeMarginFrac,
    hasXyCoarseMotion: coarse,
    // 有 XY 粗动 ⇒ 只用压电范围最中间的 **1200 nm**（±600），2026-08-17 起。
    // 没有 ⇒ `null`（不设中心区，整片表面都要用上）。
    //
    // ⚠️ `center_zone_side_nm` **不在档案的键表里** ⇒ `sanitizeProfile` 丢掉它
    // ⇒ {@link nmUnlessSet} 永远看不见它 ⇒ **这个旋钮拧不动，恒为 1200 nm**。
    // 旧仓同（`_CONFIG_SPEC` 里同样没有这个键）。照移并登记，见 deviations 批 7a-2。
    centerZoneSideM: coarse ? nmUnlessSet('center_zone_side_nm', 1200e-9) : null,
    maxAvoidCircles: DEFAULT_ANALYSIS_CONFIG.maxAvoidCircles,
  }
}

/** 档案里的一个 nm 值 → 米。**回退顺序含出厂默认**（见 {@link analysisConfig} 抬头）。 */
function nm(key: string, fallback: number): number {
  const v = getConfig(key, null)
  if (v === null || v === undefined) return fallback
  const f = pyFloat(v)
  return f === null ? fallback : f * 1e-9
}

/**
 * 用户**显式设过**就用他的；否则用 `fallback`，**不要出厂值**。
 *
 * 只问「档案里到底设没设过」—— `readProfile()` 只含用户真的写过的键。
 */
function nmUnlessSet(key: string, fallback: number): number {
  const r = readProfile()
  if (!r.ok || !(key in r.profile)) return fallback
  const raw = r.profile[key]
  if (raw === null || raw === undefined) return fallback
  const f = pyFloat(raw)
  return f === null ? fallback : f * 1e-9
}

/** 间距因子。低于 1 会让相邻帧重叠，那不是「更分散」的反面，是把同一块地方扫两遍。 */
function spacing(): number {
  const f = pyFloat(getConfig('scan_spacing_factor', 1.2))
  if (f === null) return 1.2
  // ⚠️ `v < 1` 这一支**从档案这条路不可达**：`sanitizeProfile` 已经把它夹进
  // `[1, 20]`，而缺省值是 1.2。留着它是因为它防的是「有人把区间改宽」，
  // 但在今天的键表下它没有任何输入能验 —— 所以变异演练里不打它。
  return f >= 1.0 ? f : 1.2
}

/** 这台机器横向粗动换得了区吗。 */
function hasXyCoarseMotion(): boolean {
  return String(getConfig('xy_coarse_motion', 'yes')).trim().toLowerCase() !== 'no'
}

/**
 * 进针要不要当成会留下一个扎痕。
 *
 * **「未知」故意解成「会」**：往这个方向错，代价是几百纳米的表面；
 * 往另一个方向错，代价是一张扎在坑上的图，外加可能一根针。
 */
function approachDamagesSurface(): boolean {
  return String(getConfig('approach_damages_surface', 'unknown')).trim().toLowerCase() !== 'no'
}

/**
 * 解析过的选点策略：`center_first` | `perimeter_inward`。
 *
 * `auto` 由**这台机器换不换得了区**推导 —— 那正是 `auto` 该是默认值的理由：
 * 换得了区的机器应该永远在压电范围中心成像（扫描管在那儿蠕变最小），用完了搬家；
 * 换不了区的机器永远拿不到新表面，所以从外向内吃，把最大的一块连续干净区域
 * 留得越久越好。
 */
function scanPathStrategy(): string {
  const s = String(getConfig('scan_path_strategy', 'auto')).trim().toLowerCase()
  if (s === 'center_first' || s === 'perimeter_inward') return s
  return hasXyCoarseMotion() ? 'center_first' : 'perimeter_inward'
}

/** Python 的真值判断（这一层会遇到的那几种）。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  if (typeof v === 'boolean') return v
  return true
}

/** Python 的 `float(v)`：**抛的那些给 `null`**（`Number('很大')` 的 NaN 也算）。 */
function pyFloat(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    const f = Number(t)
    return Number.isFinite(f) ? f : null
  }
  return null
}
