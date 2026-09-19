/**
 * 扫描地图的**几何判据** —— 记下来的那些标记，对「针尖还能去哪」意味着什么。
 *
 * 旧仓 `mast/io/map_analysis.py` 里 `FindCleanSpot` 真正走到的那四件：
 * {@link AnalysisConfig} · {@link buildAvoidCircles} · {@link ringCells} ·
 * {@link nearestCleanFrom}，外加 `load_markers` 要的三件代次工具。
 * 栅格化、覆盖率、巡览路线（`candidate_positions` / `pick_next_position` /
 * `coarse_move_advice`）**一处都没碰** —— 那些要 numpy，而这一层零 numpy。
 *
 * ## 这一层为什么住在 `kernel`
 *
 * `vision` 的抬头写着它是「需要 `numerics`（`labelConnected` / `fft` /
 * `histogram`）的那一族」，而留在 `kernel` 的是**零 numpy** 的判据
 * （起伏门与它的阈值表）。这一层正是后者：全部运算是 `hypot` / 乘加 / 比较，
 * 一个数组原语都不用。
 *
 * 更硬的理由是**依赖的方向**：这一层的三个输入源已经全在 `kernel` 里 ——
 * 档案（`instrument-profile.ts`）、撞针追踪器（`tip-crash-tracker.ts`）、
 * 实时状态（`hardware-state.ts`）。放进 `vision` 会让一层纯几何判据反过来
 * 依赖 `numerics`，只为了搬个家。
 *
 * ## 容差是 **0**
 *
 * 输出是「哪几个点、什么顺序」—— 下标与搬运，没有可以稀释的东西。
 * 唯一带浮点的是 `distance_m`，而它的最后一位归 `Math.hypot`
 * （D-HYPOT-1：两种语言的 `hypot` 不是同一个函数）。
 * **所有判据边界都刻意造在轴上**（`hypot(a, 0)` 两边都精确），
 * 于是最后一位差不到任何一个决定 —— 见 `spec/golden/map_scope.json` 的
 * `circle_touching_is_blocked` / `exclude_exact_diameter_is_kept` /
 * `max_distance_exact_is_kept` 三格。
 *
 * ## 两句容易记反的话（旧仓抬头原话）
 *
 * * **扫过 ≠ 不能用。** 回到一块干净的、已经成过像的地方再测一条谱是正常工作；
 *   只有**损伤**才从可用面积里扣。
 * * **候选序列是无状态的。** 第 N 个落点在哪只取决于配置，历史只负责筛掉
 *   已经用过或者已经毁掉的 —— 这才是一次中断的巡览能原样接着跑的原因。
 */

import type { MapMarker, MapMarkerRow } from './exp-map.js'
import { epochOfRow, hasXy } from './exp-map.js'

// ── 配置 ────────────────────────────────────────────────────────────────

/**
 * 会弄脏表面的 marker 种类 → 它的避让半径住在 {@link AnalysisConfig} 的哪个字段。
 *
 * `manual` **故意不在表里**：操作员自己标的禁区把半径写在 `meta` 上。
 */
export const DAMAGE_KINDS: Readonly<Record<string, keyof AnalysisConfig>> = {
  tip_shape: 'tipShapeRM',
  pulse: 'pulseRM',
  crash: 'crashRM',
  approach: 'approachRM',
}

/** `mark_area_used` 工具写进 `meta` 的两个键。 */
export const META_AVOID_RADIUS = 'avoid_radius_m'
export const META_USED_RADIUS = 'used_radius_m'

/**
 * 这一层用到的每一个阈值，摆在一处。
 *
 * 由 `map-scope.ts` 从**仪器档案 + 安全上限 + 实时扫描框**拼出来，
 * 这里一个全局都不读 —— 那正是它可测的原因，也是一条测试不必伸手去改模块私有
 * 状态就能把前提说清楚的原因。
 *
 * ## ⚠️ 旧仓 dataclass 的 21 个字段里，这里只留 15 个
 *
 * 砍掉的六个（`reuse_overlap_frac` · `min_usable_unscanned_frac` ·
 * `center_zone_frac` · `center_zone_blocked_frac` · `max_sts_points` ·
 * `max_candidates`）在这一层**既没有生产方也没有消费方**：`analysis_config`
 * 一个都不设，`nearest_clean_from` / `build_avoid_circles` 一个都不读，
 * 它们服务的是栅格化与巡览路线（本批没移）。按消融精神不写。
 * 名单与理由在 {@link ANALYSIS_CONFIG_FIELDS_NOT_PORTED}，
 * 金样对账时**把它加回去**再比字段集 —— 一次静默的少写与一次写明的少写，
 * 在 diff 里长得一样，在这里不一样。
 */
export interface AnalysisConfig {
  /** 够得着的压电方块的半边长（这一层的整个宇宙）。 */
  readonly piezoHalfRangeM: number
  /** 栅格格边。这一层只拿它当**落点格距的下界**（损伤半径为 0 时）。 */
  readonly gridCellM: number

  // 避让半径 —— 一次事件吃掉多少表面。
  readonly tipShapeRM: number
  readonly pulseRM: number
  readonly crashRM: number
  readonly approachRM: number
  /** 只有操作员确认过「本机进针不碰表面」时才是 false；「未知」在上游解成 true。 */
  readonly approachDamages: boolean

  /** `center_first` | `perimeter_inward` —— 已经解析过，永远不是 `auto`。 */
  readonly strategy: string
  /** 正在摆的扫描框边长。决定候选间距，也决定落点要留多少帧边距。 */
  readonly frameSizeM: number
  readonly ringWidthFactor: number
  readonly pointSpacingFactor: number
  /** 别让候选贴到压电范围的最外沿。 */
  readonly edgeMarginFrac: number
  /** 这台机器**真的**换得了区吗。 */
  readonly hasXyCoarseMotion: boolean
  /**
   * 有 XY 粗动时，**只用压电范围最中间的这一块**（边长，不是半径）。
   * `null` = 不设限，用满整个可用范围（没有 XY 粗动的仪器就是这样）。
   */
  readonly centerZoneSideM: number | null
  /** 交给模型 / 浏览器的圈数上限。 */
  readonly maxAvoidCircles: number
}

/**
 * 旧仓 `AnalysisConfig` 里**故意没搬**的六个字段。
 *
 * 写成一张表而不是一句注释：金样比字段集的时候要拿它去补，
 * 于是「少写了一个」与「说好不写这一个」分得开 —— 而这两件事在 diff 里一模一样。
 */
export const ANALYSIS_CONFIG_FIELDS_NOT_PORTED: readonly string[] = [
  'reuse_overlap_frac',
  'min_usable_unscanned_frac',
  'center_zone_frac',
  'center_zone_blocked_frac',
  'max_sts_points',
  'max_candidates',
]

/** 旧仓 dataclass 的出厂值，逐字。 */
export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  piezoHalfRangeM: 1.5e-6,
  gridCellM: 25e-9,
  tipShapeRM: 30e-9,
  pulseRM: 150e-9,
  crashRM: 150e-9,
  approachRM: 200e-9,
  approachDamages: true,
  strategy: 'center_first',
  frameSizeM: 100e-9,
  ringWidthFactor: 1.2,
  pointSpacingFactor: 1.2,
  edgeMarginFrac: 0.06,
  hasXyCoarseMotion: true,
  centerZoneSideM: null,
  maxAvoidCircles: 400,
}

/**
 * 这一种损伤的避让半径，**不损伤表面就给 `null`**。
 *
 * `0` 也给 `null`：一个半径为 0 的避让圈不是「挡得很紧」，是**根本不存在**，
 * 而把它当成一个圈交出去，读的人会以为地图上有东西在挡。
 */
export function radiusFor(cfg: AnalysisConfig, kind: string): number | null {
  const field = DAMAGE_KINDS[kind]
  if (field === undefined) return null
  if (kind === 'approach' && !cfg.approachDamages) return null
  const raw = cfg[field]
  const r = typeof raw === 'number' ? raw : 0.0
  return r > 0 ? r : null
}

/**
 * 去掉边距之后的半程 —— **候选只许出现在这里面**。
 *
 * `centerZoneSideM` 再往里收一层（有 XY 粗动时）。取**两者的较小值**，
 * 不是替换：中心区比压电范围还大的仪器上，那个数不该反过来把可用区域撑开。
 */
export function effectiveHalfRangeM(cfg: AnalysisConfig): number {
  const base = cfg.piezoHalfRangeM * (1.0 - Math.max(0.0, Math.min(0.9, cfg.edgeMarginFrac)))
  const side = cfg.centerZoneSideM
  if (side === null) return base
  const half = side / 2.0
  return half > 0 ? Math.min(base, half) : base
}

// ── 结果 ────────────────────────────────────────────────────────────────

/** 一块禁区圆盘：这儿的表面已经坏了或者脏了。 */
export interface AvoidCircle {
  readonly x_m: number
  readonly y_m: number
  readonly radiusM: number
  readonly kind: string
  readonly label: string
}

/**
 * 一个针尖可以去做**点动作**（打一发偏压脉冲、扎一次针）的落点，
 * 附带它离针尖当下站的地方有多远。
 */
export interface CleanSpot {
  readonly x_m: number
  readonly y_m: number
  readonly distanceM: number
}

// ── 代次 ────────────────────────────────────────────────────────────────

/**
 * 每一行属于第几代坐标系，**由行序推出来**。
 *
 * 存的那一列是权威（`log_marker` 在同一个写事务里盖的）。这个函数存在是为了
 * **核对**它 —— 以及在那一列还不存在的老库上照样能用：那时「计数」就是定义，
 * 一行的代次 = 它前面有几行 `coarse_move`。
 */
export function epochSeries(rows: readonly (MapMarkerRow | null)[] | null | undefined): number[] {
  const out: number[] = []
  let seen = 0
  for (const r of rows ?? []) {
    out.push(seen)
    if ((r ?? {}).kind === 'coarse_move') seen += 1
  }
  return out
}

/** **最后一行**属于的那一代 —— 也就是活着的那一代。 */
export function currentEpochOf(rows: readonly (MapMarkerRow | null)[] | null | undefined): number {
  let n = 0
  for (const r of rows ?? []) if ((r ?? {}).kind === 'coarse_move') n += 1
  return n
}

/**
 * 属于某一代的行。存的那一列**在就听它的**，NULL / 缺列才回落到数出来的那一列。
 */
export function filterEpoch<T extends MapMarkerRow | null>(
  rows: readonly T[] | null | undefined,
  epoch: number,
): T[] {
  const derived = epochSeries(rows)
  const out: T[] = []
  const list = rows ?? []
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i] as T
    // `(r or {}).get("coord_epoch")` —— **存的那一列在就听它的**，NULL / 缺列
    // 才回落到数出来的那一列。`null` 与「没有这个键」在这里是同一件事。
    const stored = r === null ? undefined : r.coord_epoch
    const e = stored !== null && stored !== undefined ? epochOfRow(r) : (derived[i] as number)
    if (e === epoch) out.push(r)
  }
  return out
}

// ── 避让 ────────────────────────────────────────────────────────────────

/**
 * 这些标记**蕴含**的禁区圆盘。
 *
 * 刻意**不合并、不去重**：同一个地方扎了五次，那就真的是五次事件，
 * 这个数对着地图看的人是有意义的，而下面那些几何判定便宜到不必在乎。
 *
 * ## ⚠️ 上限那一条**常常不生效**，照移
 *
 * 损伤那一支 `append` 完直接 `continue`，**跳过了** `len(out) >= max` 的检查 ——
 * 于是一串纯损伤 marker 无论多少个都会全部返回，上限只在**走到底的那种
 * marker**（`manual` 或者认不出的 kind）之后才当场生效。
 * 这是旧仓行为，本仓照移并登记（`spec/deviations.md` 批 7a-2），
 * 金样 `avoid_circles.cap_not_enforced_on_damage` 把它钉死。
 */
export function buildAvoidCircles(
  markers: Iterable<MapMarker>,
  cfg: AnalysisConfig,
): AvoidCircle[] {
  const out: AvoidCircle[] = []
  for (const m of markers) {
    if (!hasXy(m)) continue
    const r = radiusFor(cfg, m.kind)
    if (r !== null) {
      out.push({
        x_m: m.x_m as number,
        y_m: m.y_m as number,
        radiusM: r,
        kind: m.kind,
        label: m.label !== '' ? m.label : m.kind,
      })
      continue
    }
    // 操作员标的禁区（`mark_area_used` 带 `forbidden=True`）。
    if (m.kind === 'manual') {
      const mr = finite(m.meta[META_AVOID_RADIUS])
      if (mr !== null && mr > 0) {
        out.push({
          x_m: m.x_m as number,
          y_m: m.y_m as number,
          radiusM: mr,
          kind: 'manual_avoid',
          label: m.label !== '' ? m.label : '人工标避让区',
        })
      }
    }
    if (out.length >= cfg.maxAvoidCircles) break
  }
  return out
}

/** Python 的 `_finite`：`bool` 拒掉，非有限值拒掉。 */
function finite(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null
  let f: number
  if (typeof v === 'number') f = v
  else if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    f = Number(t)
  } else return null
  return Number.isFinite(f) ? f : null
}

// ── 环带 ────────────────────────────────────────────────────────────────

/**
 * 离原点**正好** `ring` 步的那些格（切比雪夫环）。
 *
 * 按四条边生成，而不是把外接正方形筛一遍：整条螺旋于是是
 * O(点数) 而不是 O(环数³) —— 大压电范围里放一个小扫描框时，那是几百万次迭代之差。
 *
 * ⚠️ **顺序本身是判据。** 同一环上的点到区心等距，而
 * {@link nearestCleanFrom} 的排序是**稳定**的 ⇒ 这个生成序直接决定
 * 「同样近的两个落点先给哪一个」。金样 `ring_cells` 比的是表，不是集合。
 */
export function* ringCells(ring: number): Generator<readonly [number, number]> {
  if (ring === 0) {
    yield [0, 0]
    return
  }
  for (let gx = -ring; gx <= ring; gx += 1) {
    yield [gx, -ring]
    yield [gx, ring]
  }
  for (let gy = -ring + 1; gy < ring; gy += 1) {
    yield [-ring, gy]
    yield [ring, gy]
  }
}

// ── 就近选点 ────────────────────────────────────────────────────────────

export interface NearestCleanOptions {
  readonly spotRM: number
  readonly count?: number
  readonly circles?: readonly AvoidCircle[] | null
  readonly exclude?: readonly (readonly [number, number])[] | null
  readonly maxDistanceM?: number | null
  /**
   * 落点上**要扫的那张帧**的边长；`null` = 用 `cfg.frameSizeM`。
   * 打脉冲的落点上不扫图，所以那条路传 **0**。
   */
  readonly frameM?: number | null
}

/**
 * `(x, y)` 附近**没被破坏过**的落点，由近到远。
 *
 * 与「第 N 张巡览图该放哪」是两个问题，而那个区别就是这个函数存在的全部理由：
 * 那一个走的是从原点出发的固定路线，一发脉冲之后它会高高兴兴地把针尖送回
 * 螺旋的中心；**这一个回答「我刚在这儿打过，不能再打同一处 —— 最近的能打的地方
 * 在哪」**。每一次大跨度移动都会重新激起压电蠕变，而修针一轮要打十几次。
 *
 * **扫过不是跳过一个落点的理由**（见抬头），只有损伤是。`exclude` 装的是
 * 这一轮更早用掉的点 —— 它由调用方拿着，因为刚写下的 marker 可能还没落到库里，
 * 而一次陈读绝不能让两发脉冲落在同一个点上。
 *
 * 针尖当下站的位置**本身就是一个候选**（还干净的话），而且距离 0 排在最前。
 * 「每打完一发换个地方」由调用方把打过的点加进 `exclude` 来表达，
 * 不是由这个函数假定针尖总是站在已经用掉的表面上 —— 那个假定会在每一轮开头
 * 白白花掉一次移动，外加一份新鲜的蠕变。
 *
 * 无状态：同样的针尖位置 + 同样的历史 ⇒ 同样的表。
 *
 * ## 三处现场教训，每一处都是一行
 *
 * | 行 | 事故 |
 * |---|---|
 * | `reach` 用 {@link effectiveHalfRangeM} 而不是硬压电边界 | 2026-08-16：`xy_max_m` 写死 1.5 µm 而实测半程 1219.4999 nm ⇒ 选点提议 Y = 1224 nm ⇒ 针尖夹在限位上、`MoveToXY` 报「超时（可能仍在移动中）」**那句话是假的** ⇒ 外环 `optional=False` 中止，**54 分钟的修针全丢** |
 * | 边距减的是**帧**、不是损伤半径 | 同日：原来减 `r_spot`，在 500 nm 这个尺度上差了一个量级。它一直被另一个错（`xy_max_m` 偏大）盖着，修掉一个，另一个立刻现形：整片范围只剩 `(0,0)` 一个合法落点，日志里每一发都打在 `(0.0, 0.0)` |
 * | 格点锚在**可用区中心**，不是锚在针尖上 | 2026-08-17：针尖在 (539, −166)，格距 1000 nm ⇒ 候选是 `539 + 1000·i`，**永远落不进 ±200** ⇒ 零候选 ⇒ 报「这片表面没有干净落点了」。而区心 (0,0) 干干净净地摆在那儿，粗动换区也救不了（粗动动的是样品台，压电坐标一点没变） |
 */
export function nearestCleanFrom(
  markers: Iterable<MapMarker>,
  cfg: AnalysisConfig,
  x_m: number,
  y_m: number,
  opts: NearestCleanOptions,
): CleanSpot[] {
  const markerList = [...markers]
  const circles = opts.circles ?? buildAvoidCircles(markerList, cfg)
  const rSpot = Math.max(opts.spotRM, 0.0)
  const want = Math.max(0, Math.trunc(opts.count ?? 16))
  if (want === 0) return []

  // 相邻落点不许重叠 ⇒ 格距是一个**直径**。
  const step = Math.max(2.0 * rSpot, cfg.gridCellM, 1e-12)
  const frameMargin = Math.max(opts.frameM ?? cfg.frameSizeM, 0.0) / 2.0
  let reach = Math.max(effectiveHalfRangeM(cfg) - frameMargin, 0.0)

  // ── 可用区必须放得下**一个**这么大的落点，否则它不是「限制」，是「无解」──
  //
  // 2026-08-17 真机死循环：自动粗动换区了，换完还是「找不到可用区域」，再粗动、
  // 再找不到 —— 一直转。算术是：可用区 ±250 nm、脉冲净空 500 nm ⇒ 区里唯一的
  // 格点是区心，而**粗动换区必然要重新进针，进针必然在工作点留一个盘** ⇒
  // 新区在打第一发之前就被自己废掉。换多少次都一样，因为换的是样品台，不是这条算术。
  //
  // ⇒ 判据：可用区半程装不下一个落点半径，这个区就是**无解**，不是「用完」。
  //   此时退回压电范围。**一个永远无解的约束不是安全边界，是一个死锁。**
  const zoneReleased = reach < rSpot
  if (zoneReleased) {
    const base = cfg.piezoHalfRangeM * (1.0 - Math.max(0.0, Math.min(0.9, cfg.edgeMarginFrac)))
    reach = Math.max(base - frameMargin, 0.0)
  }
  const excl = opts.exclude ?? []
  const maxDistanceM = opts.maxDistanceM ?? null

  const found: CleanSpot[] = []
  // 环数盖住整个可用区（针尖可能站在区外，所以不能按「离针尖多远」算）。
  // `+ 2` 是**取整的余量，不是一道闸**：第 r 环上每个格至少有一个坐标是
  // ±r·step，所以 r·step > reach 时整环都出局 —— 超出 `int(reach/step)`
  // 的环一个点都贡献不了。变异演练里不打它（打了也永远绿，那是第三种形状）。
  const maxRing = Math.trunc(reach / step) + 2
  // 针尖离**区心**多远 —— 提前退出要用它。
  const dTip = Math.hypot(x_m, y_m)
  for (let ring = 0; ring <= maxRing; ring += 1) {
    // 提前退出：第 r 环上的点离**区心** r·step，所以它离**针尖**至少
    // `r·step − d_tip`（三角不等式）。这个下界一旦超过已收到的第 want 个结果，
    // 后面的环不可能更好。
    //
    // ⚠️ 2026-08-17：格子改成锚在区心之后，原来那条 `ring*step > 最差的`
    // **就不成立了** —— 那是针尖锚定时代的写法。照搬会**过早停**：
    // 真机形状是 tip_shape 在 (400, −250) 求点，明明有 22 nm 外的候选，
    // 却返回了 160 nm 外的那个。**一个「快了但答错」的剪枝比没有剪枝坏得多。**
    if (found.length >= want) {
      found.sort(byDistance)
      if (ring * step - dTip > (found[want - 1] as CleanSpot).distanceM) break
    }
    for (const [gx, gy] of ringCells(ring)) {
      const cx = gx * step
      const cy = gy * step
      if (Math.abs(cx) > reach || Math.abs(cy) > reach) continue
      const d = Math.hypot(cx - x_m, cy - y_m)
      if (maxDistanceM !== null && d > maxDistanceM) continue
      // **圆盘对圆盘**，不是扫描用的那个方框判定：一发脉冲、一次扎针作用在一块
      // 圆形的地方，把它方框化等于在十几发里每一发都白扔掉可用表面。
      if (circles.some((c) => Math.hypot(c.x_m - cx, c.y_m - cy) <= c.radiusM + rSpot)) continue
      if (excl.some(([px, py]) => Math.hypot(px - cx, py - cy) < 2.0 * rSpot)) continue
      found.push({ x_m: cx, y_m: cy, distanceM: d })
    }
  }

  found.sort(byDistance)
  return found.slice(0, want)
}

/**
 * 只按距离排。**必须是稳定排序**（ES2019 起是规范保证的，Python 的 `list.sort`
 * 同样保证）—— 等距的两个落点谁先给，由 {@link ringCells} 的生成序决定，
 * 而那是一条实打实的判据，不是实现细节。
 */
function byDistance(a: CleanSpot, b: CleanSpot): number {
  return a.distanceM - b.distanceM
}
