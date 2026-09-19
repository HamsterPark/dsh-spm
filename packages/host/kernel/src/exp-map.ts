/**
 * 实验地图上的**一个空间事件** —— 旧仓 `mast/io/exp_map.py` 里选点这条路要的那三件。
 *
 * 1015 行里搬过来的是 `MapMarker` / `epochOfRow` / `markersFromRows`：
 * 它们是 `map_analysis` **顶层** import 进来的，躲不掉；而绘图、`marker_from_skill`
 * 的动词分类、`.dat` 位置提取、范围计算那些，`FindCleanSpot` 一处都没碰。
 *
 * 坐标系：Nanonis 台架系，**米**。
 *
 * ## 为什么 `coord_epoch` 的坏值要一格一格钉
 *
 * 代次是「这些坐标指的还是同一片表面吗」的唯一答案。横向粗动之后旧坐标指向
 * 另一片表面，混代次会把**新鲜表面标成已经用过的** —— 而那件事在几何上、在报文里、
 * 在日志里都看不出来。所以一行读不懂的 `coord_epoch` 不许静默变成「某个代次」：
 * 它一律读作 **0**，理由写在 {@link epochOfRow} 上。
 */

/** 数据库里一行地图标记。列名逐字照 `map_markers`。 */
export interface MapMarkerRow {
  readonly kind?: unknown
  readonly x_m?: unknown
  readonly y_m?: unknown
  readonly w_m?: unknown
  readonly h_m?: unknown
  readonly angle_deg?: unknown
  readonly label?: unknown
  readonly skill_name?: unknown
  readonly status?: unknown
  readonly source?: unknown
  readonly timestamp?: unknown
  readonly meta?: unknown
  readonly coord_epoch?: unknown
}

/** 地图上的一个空间事件（米，台架系）。 */
export interface MapMarker {
  readonly kind: string
  readonly x_m: number | null
  readonly y_m: number | null
  /** 足迹宽高（`scan` / 实时框才有）。 */
  readonly w_m: number | null
  readonly h_m: number | null
  readonly angleDeg: number
  readonly label: string
  readonly skillName: string
  /** `done` | `failed` | `active` | `planned` */
  readonly status: string
  /** `skill` | `manual` | `plan` | `live` | `import` */
  readonly source: string
  readonly timestamp: string
  readonly meta: Readonly<Record<string, unknown>>
  /**
   * 这个坐标属于哪一代坐标系。**从未持久化过的标记给 `null`**
   * （实时框 / 针尖 / 计划覆盖层 / 撞针记忆），老行读作 0。
   */
  readonly coordEpoch: number | null
}

/** 一个 `MapMarker`，没给的字段走旧仓 dataclass 的默认值。 */
export function mapMarker(m: Partial<MapMarker> & { readonly kind: string }): MapMarker {
  return {
    kind: m.kind,
    x_m: m.x_m ?? null,
    y_m: m.y_m ?? null,
    w_m: m.w_m ?? null,
    h_m: m.h_m ?? null,
    angleDeg: m.angleDeg ?? 0.0,
    label: m.label ?? '',
    skillName: m.skillName ?? '',
    status: m.status ?? 'done',
    source: m.source ?? 'skill',
    timestamp: m.timestamp ?? '',
    meta: m.meta ?? {},
    coordEpoch: m.coordEpoch ?? null,
  }
}

/** 有坐标吗。**`0` 是一个真实的坐标**，判的是「在不在」，不是真值。 */
export function hasXy(m: MapMarker): boolean {
  return m.x_m !== null && m.y_m !== null
}

/** 是一块足迹吗（有坐标 + 宽高都是正数）。 */
export function hasFootprint(m: MapMarker): boolean {
  return hasXy(m) && m.w_m !== null && m.h_m !== null && m.w_m > 0 && m.h_m > 0
}

/**
 * Python 的 `_coerce_float`：**`bool` 被显式拒绝**，非有限值也是 `null`。
 *
 * 拒 `bool` 不是洁癖 —— Python 里 `isinstance(True, int)` 为真，
 * 一个写进 `coord_epoch` 的 `True` 会变成「第 1 代」，而它的本意是「有这一列」。
 * 拒非有限值是源头拦截：一个 NaN 坐标会毒掉整条范围计算。
 */
function coerceFloat(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null
  let f: number
  if (typeof v === 'number') f = v
  else if (typeof v === 'string') {
    const t = v.trim()
    // Python 的 `float('')` 抛 ⇒ None。`Number('')` 是 0，**那是另一个答案**。
    if (t === '') return null
    f = Number(t)
  } else return null
  return Number.isFinite(f) ? f : null
}

/**
 * 一列数值。**旧仓这里一次转换都不做**（`row.get("x_m")` 原样带走），
 * 而 `map_markers` 的这几列在 schema 上是 `REAL` / `NULL`。
 *
 * 本仓比旧仓**窄一档**：一个非数值落到这里读作「没有这一列」，
 * 而旧仓要一路走到 `float(m.x_m)` 才炸。登记见 `spec/deviations.md`（批 7a-2）。
 * 窄的方向是安全的那一侧：**一个读不懂的坐标画不出避让圈，那正是它该有的下场**。
 */
function numCol(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

/**
 * 一行的坐标代次。**NULL（老行，那一列还不存在的年代）读作第 0 代** ——
 * 一个没有任何 `coarse_move` 行的库，从头到尾只有过一套坐标系。
 */
export function epochOfRow(row: MapMarkerRow | null | undefined): number {
  const v = coerceFloat(row?.coord_epoch)
  return v === null ? 0 : Math.trunc(v)
}

/** 把一行还原成 `MapMarker`。 */
export function markerFromRow(row: MapMarkerRow): MapMarker {
  const meta = row.meta
  return {
    kind: strOr(row.kind, 'move'),
    x_m: numCol(row.x_m),
    y_m: numCol(row.y_m),
    w_m: numCol(row.w_m),
    h_m: numCol(row.h_m),
    angleDeg: numCol(row.angle_deg) ?? 0.0,
    label: strOr(row.label, ''),
    skillName: strOr(row.skill_name, ''),
    status: strOr(row.status, 'done'),
    source: strOr(row.source, 'skill'),
    timestamp: strOr(row.timestamp, ''),
    meta:
      meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {},
    coordEpoch: epochOfRow(row),
  }
}

/**
 * Python 的 `row.get(k) or fallback` —— **真值判断**，所以空串也落回默认值。
 * 这不是疏忽：一个空的 `status` 和没有 `status` 在这张表里是同一件事。
 *
 * 与 {@link numCol} 同一条窄化：非字符串读作「没有这一列」，而旧仓会原样带走。
 * 这几列在 `map_markers` 上都是 `TEXT`。
 */
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback
}

export function markersFromRows(rows: readonly MapMarkerRow[] | null | undefined): MapMarker[] {
  return (rows ?? []).map(markerFromRow)
}
