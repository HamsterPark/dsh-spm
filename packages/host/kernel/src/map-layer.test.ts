/**
 * 实验地图层逐格对 `spec/golden/map_scope.json`（旧仓 Python 驱动器录的）。
 *
 * ## 容差：几乎全是 **0**
 *
 * 输出是「哪几个格点、什么顺序、几个圈、哪一代」—— 下标、计数、标签与搬运。
 * 唯一不是 0 的是 {@link CleanSpot.distanceM}：它走 `Math.hypot`，而
 * **D-HYPOT-1 说两种语言的 `hypot` 不是同一个函数**
 * （`hypot(4e-7, 4e-7)`：Python `…38e-7`，JS `…381e-7`，差 1 ULP）。
 *
 * 所以这里分两档比：
 *
 * | 比什么 | 容差 | 为什么 |
 * |---|---|---|
 * | 落点的 `x_m` / `y_m`、个数、**顺序** | **0** | 它们是 `gx * step`（整数乘一个 double，两边逐位相同）与下标 |
 * | `distance_m` | {@link DIST_REL_TOL} | 只有它经过 `hypot` |
 *
 * 顺序不受那 1 ULP 影响：同距的候选是由**对称的同一个表达式**算出来的
 * （`hypot(s, 0)` 对 `hypot(0, s)`、`hypot(s, s)` 对 `hypot(s, -s)`），
 * 两种语言各自内部相等。**而每一条边界判据都刻意造在轴上**（`hypot(a, 0)`
 * 两边都精确）—— 见金样里 `circle_touching_is_blocked` /
 * `exclude_exact_diameter_is_kept` / `max_distance_exact_is_kept` 三格。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ANALYSIS_CONFIG_FIELDS_NOT_PORTED,
  DAMAGE_KINDS,
  DEFAULT_ANALYSIS_CONFIG,
  buildAvoidCircles,
  currentEpochOf,
  effectiveHalfRangeM,
  epochSeries,
  filterEpoch,
  nearestCleanFrom,
  radiusFor,
  ringCells,
  type AnalysisConfig,
  type AvoidCircle,
  type CleanSpot,
} from './map-analysis.js'
import {
  analysisConfig,
  crashMemoryMarkers,
  loadMarkers,
  markerRows,
  processExpMap,
} from './map-scope.js'
import {
  epochOfRow,
  hasFootprint,
  hasXy,
  mapMarker,
  markerFromRow,
  markersFromRows,
  type MapMarker,
  type MapMarkerRow,
} from './exp-map.js'
import { processInstrumentProfile } from './instrument-profile.js'
import { processTipCrash, type TipCrashTracker } from './tip-crash-tracker.js'

const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/map_scope.json', import.meta.url)), 'utf8'),
) as Golden

interface Golden {
  ring_cells: Record<string, number[][]>
  config: Record<string, GConfigCase>
  markers: Record<string, { row: MapMarkerRow | null; marker?: GMarker; epoch_of_row?: number; n?: number }>
  epochs: Record<string, { rows: (MapMarkerRow | null)[] | null; series: number[]; current: number; filter: Record<string, unknown[]> }>
  load_markers: Record<string, GLoadCase>
  crash_memory: Record<string, { markers: GMarker[]; unlocated: number }>
  avoid_circles: Record<string, { config: Record<string, unknown>; markers: GMarker[]; circles: GCircle[] }>
  nearest: Record<string, GNearestCase>
  parse_spots: Record<string, { raw: string; spots: number[][] }>
  skill: Record<string, unknown>
}
interface GConfigCase {
  profile: Record<string, unknown>
  safety_xy_max_m: unknown
  state_scan_width_m: number | null
  state_raises: boolean
  frame_size_m_arg: number | null
  config: Record<string, unknown>
  effective_half_range_m: number
  radius_for: Record<string, number | null>
  profile_after_sanitize: Record<string, unknown>
}
interface GMarker {
  kind: string
  x_m: number | null
  y_m: number | null
  w_m: number | null
  h_m: number | null
  angle_deg: number
  label: string
  skill_name: string
  status: string
  source: string
  timestamp: string
  meta: Record<string, unknown>
  coord_epoch: number | null
  has_xy: boolean
  has_footprint: boolean
}
interface GCircle {
  x_m: number
  y_m: number
  radius_m: number
  kind: string
  label: string
}
interface GLoadCase {
  rows: unknown
  markers: GMarker[]
  epoch: number
  available: boolean
  all_epochs: { markers: GMarker[]; epoch: number; available: boolean }
}
interface GNearestCase {
  config: Record<string, unknown>
  markers: GMarker[]
  x_m: number
  y_m: number
  spot_r_m: number
  count: number
  exclude: number[][]
  max_distance_m: number | null
  frame_m: number | null
  derived: { step: number; frame_margin: number; reach: number; zone_released: boolean; max_ring: number }
  spots: { x_m: number; y_m: number; distance_m: number }[]
}

/**
 * `distance_m` 的相对容差 —— **只给它一个人**。
 *
 * 推导：这一路上除 `Math.hypot` 之外的运算（`gx * step`、`cx - x_m`）两边逐位相同，
 * 所以误差只来自一次 `hypot`。CPython 的 `math.hypot` 声称正确舍入，V8 的不是，
 * 实测两者相差 **≤ 1 ULP**（`hypot(4e-7, 4e-7)` 那一格）。1 ULP = `2^-52` 的相对量，
 * 取 **4 倍**留余量。实测占比印在 `distance ULP` 那条测试里 —— 它不到 1 就说明
 * 这条推导还成立；超过 1 就是有别的东西也在飘，那时该查的是那个，不是把这个数调大。
 */
const DIST_REL_TOL = 4 * Number.EPSILON

/** 金样里的 snake_case 字段名 → 本仓的 camelCase。**机械变换，不是一张手写表**。 */
function camel(k: string): string {
  return k.replace(/_([a-z])/g, (_s, c: string) => c.toUpperCase())
}
function snake(k: string): string {
  return k.replace(/([A-Z])/g, '_$1').toLowerCase()
}

function cfgFrom(d: Record<string, unknown>): AnalysisConfig {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (ANALYSIS_CONFIG_FIELDS_NOT_PORTED.includes(k)) continue
    out[camel(k)] = v
  }
  return out as unknown as AnalysisConfig
}

function markerFrom(m: GMarker): MapMarker {
  return mapMarker({
    kind: m.kind,
    x_m: m.x_m,
    y_m: m.y_m,
    w_m: m.w_m,
    h_m: m.h_m,
    angleDeg: m.angle_deg,
    label: m.label,
    skillName: m.skill_name,
    status: m.status,
    source: m.source,
    timestamp: m.timestamp,
    meta: m.meta,
    coordEpoch: m.coord_epoch,
  })
}

function plainMarker(m: MapMarker): GMarker {
  return {
    kind: m.kind,
    x_m: m.x_m,
    y_m: m.y_m,
    w_m: m.w_m,
    h_m: m.h_m,
    angle_deg: m.angleDeg,
    label: m.label,
    skill_name: m.skillName,
    status: m.status,
    source: m.source,
    timestamp: m.timestamp,
    meta: { ...m.meta },
    coord_epoch: m.coordEpoch,
    has_xy: hasXy(m),
    has_footprint: hasFootprint(m),
  }
}

function plainCircle(c: AvoidCircle): GCircle {
  return { x_m: c.x_m, y_m: c.y_m, radius_m: c.radiusM, kind: c.kind, label: c.label }
}

/** 装一份档案（`sanitizeProfile` 照常洗）。 */
function withProfile(raw: Record<string, unknown>): void {
  processInstrumentProfile.source = () => raw
}

/** 一台假追踪器 —— 金样里的坐标是**任意**的，真追踪器只交得出格心。 */
function withTracker(
  located: readonly { xM: number; yM: number; count: number }[],
  unlocated: number,
): void {
  processTipCrash.tracker = {
    crashPoints: () => ({ located, unlocated }),
  } as unknown as TipCrashTracker
}

afterEach(() => {
  processInstrumentProfile.source = null
  processExpMap.markerRows = null
  processTipCrash.tracker = null
})

// ── ① 环带 ──────────────────────────────────────────────────────────────

describe('环带 · `ringCells`（顺序本身是判据）', () => {
  for (const [ring, want] of Object.entries(G.ring_cells)) {
    it(`第 ${ring} 环逐格、**逐序**`, () => {
      expect([...ringCells(Number(ring))].map((t) => [...t])).toEqual(want)
    })
  }

  it('环上的格数是 `8·ring`（0 环是 1 个）—— 四条边不重不漏', () => {
    for (let r = 1; r <= 12; r += 1) {
      expect([...ringCells(r)].length, `ring ${r}`).toBe(8 * r)
      // 每一格的切比雪夫距离**正好**是 ring（不是 ≤）。
      for (const [gx, gy] of ringCells(r)) {
        expect(Math.max(Math.abs(gx), Math.abs(gy)), `ring ${r} @ ${gx},${gy}`).toBe(r)
      }
      // 不许重复 —— 四条边在角上是最容易多数一次的地方。
      const seen = new Set([...ringCells(r)].map(([gx, gy]) => `${gx}:${gy}`))
      expect(seen.size, `ring ${r} 有重复`).toBe(8 * r)
    }
  })
})

// ── ② analysis_config ───────────────────────────────────────────────────

describe('`analysisConfig` 逐格对旧仓', () => {
  it('字段集：本仓的 15 个 + **写明没搬的 6 个** = 旧仓的 21 个', () => {
    const mine = Object.keys(DEFAULT_ANALYSIS_CONFIG).map(snake)
    const golden = Object.keys((G.config['factory'] as GConfigCase).config)
    expect([...mine, ...ANALYSIS_CONFIG_FIELDS_NOT_PORTED].sort()).toEqual([...golden].sort())
    // 反向：没搬的那六个**一个都不许**偷偷出现在本仓的表里。
    for (const k of ANALYSIS_CONFIG_FIELDS_NOT_PORTED) expect(mine).not.toContain(k)
  })

  for (const [name, c] of Object.entries(G.config)) {
    it(name, () => {
      withProfile(c.profile)
      // 「快照读一半抛了」在本仓不在这一层：`analysisConfig` 收的是**已经读出来
      // 的宽度**，抛不抛是调用方（`FindCleanSpot`）那一侧的事，它在那里包了
      // try/catch 并传 `null`（登记见 deviations 批 7a-2，测试在 clean-spot.test.ts）。
      const state = c.state_raises || c.state_scan_width_m === null
        ? null
        : { scanWidthM: c.state_scan_width_m }
      const got = analysisConfig(state, {
        ...(c.safety_xy_max_m === null ? {} : { safetyXyMaxM: c.safety_xy_max_m }),
        frameSizeM: c.frame_size_m_arg,
      })
      for (const [k, want] of Object.entries(c.config)) {
        if (ANALYSIS_CONFIG_FIELDS_NOT_PORTED.includes(k)) continue
        expect((got as unknown as Record<string, unknown>)[camel(k)], k).toEqual(want)
      }
      expect(effectiveHalfRangeM(got)).toEqual(c.effective_half_range_m)
      for (const [kind, want] of Object.entries(c.radius_for)) {
        expect(radiusFor(got, kind), `radius_for(${kind})`).toEqual(want)
      }
    })
  }

  it('出厂档案下 `pulseRM` 是 **2e-7 的字面量**，不是 `150.0 * 1e-9`', () => {
    withProfile({})
    const cfg = analysisConfig()
    // 这一位就是 `_nm_unless_set` 与 `_nm` 的分界：走 `getConfig` 会拿到出厂
    // 默认 150 ⇒ `1.5000000000000002e-7`，而这里必须是 `200e-9`。
    expect(cfg.pulseRM).toBe(2e-7)
    expect(cfg.crashRM).toBe(1.5000000000000002e-7)
    expect(cfg.crashRM).not.toBe(150e-9)
  })

  it('`center_zone_side_nm` 这个旋钮**拧不动** —— 档案里设了也不生效', () => {
    withProfile({ center_zone_side_nm: 500.0 })
    expect(analysisConfig().centerZoneSideM).toBe(1.2e-6)
  })

  it('读不到档案（宿主没接）⇒ 出厂配置，**不是抛**', () => {
    processInstrumentProfile.source = null
    const cfg = analysisConfig()
    expect(cfg.pulseRM).toBe(2e-7)
    expect(cfg.strategy).toBe('center_first')
  })

  it('档案读口**抛了** ⇒ 同样是出厂配置（fail-soft 一路到底）', () => {
    processInstrumentProfile.source = () => {
      throw new Error('档案存储炸了')
    }
    expect(analysisConfig().pulseRM).toBe(2e-7)
  })
})

// ── ③ marker 行 ─────────────────────────────────────────────────────────

describe('一行记录 → `MapMarker`', () => {
  for (const [name, c] of Object.entries(G.markers)) {
    if (name.startsWith('_')) continue
    it(name, () => {
      const row = c.row as MapMarkerRow
      expect(plainMarker(markerFromRow(row))).toEqual(c.marker)
      expect(epochOfRow(row)).toBe(c.epoch_of_row)
    })
  }

  it('`markersFromRows(null)` / `[]` ⇒ 空表', () => {
    expect(markersFromRows(null)).toEqual([])
    expect(markersFromRows(undefined)).toEqual([])
    expect(markersFromRows([])).toEqual([])
  })

  it('本仓比旧仓**窄一档**：非数值的坐标读作「没有这一列」', () => {
    // 旧仓原样带走，一路走到 `float(m.x_m)` 才炸。`map_markers` 的这几列是 REAL。
    const m = markerFromRow({ kind: 'pulse', x_m: '1e-7', y_m: 0.0 })
    expect(m.x_m).toBeNull()
    expect(hasXy(m)).toBe(false)
  })
})

// ── ④ 代次 ──────────────────────────────────────────────────────────────

describe('坐标代次', () => {
  for (const [name, c] of Object.entries(G.epochs)) {
    it(name, () => {
      const rows = c.rows
      expect(epochSeries(rows)).toEqual(c.series)
      expect(currentEpochOf(rows)).toBe(c.current)
      for (const [e, want] of Object.entries(c.filter)) {
        expect(filterEpoch(rows, Number(e)), `epoch ${e}`).toEqual(want)
      }
    })
  }
})

// ── ⑤ load_markers ──────────────────────────────────────────────────────

describe('`loadMarkers` —— 空表的含义是「不知道」', () => {
  for (const [name, c] of Object.entries(G.load_markers)) {
    it(name, () => {
      if (name === 'no_active_log' || name === 'no_storage') processExpMap.markerRows = null
      else if (name === 'storage_raises') {
        processExpMap.markerRows = () => {
          throw new Error('存储不可用')
        }
      } else if (name === 'storage_returns_none') {
        // 旧仓 `storage.get_markers(...) or []` ——「存储答了，里面是空的」。
        // 那个 `or` 在本仓属于**宿主适配器**（内核拿不到 storage，见
        // `processExpMap` 抬头），所以这一格在这里是**适配器已经补过 `?? []`** 的样子。
        const fromStore: MapMarkerRow[] | null = null
        processExpMap.markerRows = () => fromStore ?? []
      } else processExpMap.markerRows = () => c.rows as MapMarkerRow[]

      const got = loadMarkers()
      expect(got.available).toBe(c.available)
      expect(got.epoch).toBe(c.epoch)
      expect(got.markers.map(plainMarker)).toEqual(c.markers)

      const all = loadMarkers({ allEpochs: true })
      expect(all.available).toBe(c.all_epochs.available)
      expect(all.epoch).toBe(c.all_epochs.epoch)
      expect(all.markers.map(plainMarker)).toEqual(c.all_epochs.markers)
    })
  }

  it('宿主没接读口 ≠ 空地图', () => {
    processExpMap.markerRows = null
    expect(markerRows()).toEqual({ rows: [], available: false })
    processExpMap.markerRows = () => []
    expect(markerRows()).toEqual({ rows: [], available: true })
  })

  it('读口**返回 `null`** ⇒ 读不到（三条来路在本仓合成这一条）', () => {
    processExpMap.markerRows = () => null
    expect(markerRows()).toEqual({ rows: [], available: false })
    expect(loadMarkers()).toEqual({ markers: [], epoch: 0, available: false })
  })

  it('读口**抛了** ⇒ 读不到，而且**不往外抛**', () => {
    processExpMap.markerRows = () => {
      throw new Error('存储不可用')
    }
    expect(() => markerRows()).not.toThrow()
    expect(markerRows().available).toBe(false)
  })

  it('换过一次区之后，**旧代次的标记不出现**', () => {
    processExpMap.markerRows = () => [
      { kind: 'pulse', x_m: 1e-7, y_m: 0.0 },
      { kind: 'coarse_move', x_m: 0.0, y_m: 0.0 },
      { kind: 'crash', x_m: 4e-7, y_m: 0.0 },
    ]
    expect(loadMarkers().markers.map((m) => m.kind)).toEqual(['crash'])
    expect(loadMarkers({ allEpochs: true }).markers.map((m) => m.kind)).toEqual([
      'pulse',
      'coarse_move',
      'crash',
    ])
  })
})

// ── ⑥ 撞针记忆 ──────────────────────────────────────────────────────────

describe('`crashMemoryMarkers` —— 第二个来源', () => {
  for (const [name, c] of Object.entries(G.crash_memory)) {
    it(name, () => {
      if (name === 'tracker_raises') {
        processTipCrash.tracker = {
          crashPoints: () => {
            throw new Error('追踪器读不到')
          },
        } as unknown as TipCrashTracker
      } else {
        withTracker(
          c.markers.map((m, i) => ({
            xM: m.x_m as number,
            yM: m.y_m as number,
            count: (c.markers[i] as GMarker).meta['crash_count'] as number,
          })),
          c.unlocated,
        )
      }
      const got = crashMemoryMarkers()
      expect(got.markers.map(plainMarker)).toEqual(c.markers)
      expect(got.unlocated).toBe(c.unlocated)
    })
  }

  it('⚠️ **读不到**与**问过了没有**给出逐字节相同的返回值（照移的 fail-open）', () => {
    withTracker([], 0)
    const asked = crashMemoryMarkers()
    processTipCrash.tracker = {
      crashPoints: () => {
        throw new Error('炸了')
      },
    } as unknown as TipCrashTracker
    const failed = crashMemoryMarkers()
    expect(failed).toEqual(asked)
  })

  it('坐标不知道的撞针**绝不当成一个点交出去**', () => {
    withTracker([], 5)
    const got = crashMemoryMarkers()
    expect(got.markers).toEqual([])
    expect(got.unlocated).toBe(5)
  })
})

// ── ⑦ 避让圆 ────────────────────────────────────────────────────────────

describe('`buildAvoidCircles`', () => {
  for (const [name, c] of Object.entries(G.avoid_circles)) {
    it(name, () => {
      const cfg = cfgFrom(c.config)
      expect(buildAvoidCircles(c.markers.map(markerFrom), cfg).map(plainCircle)).toEqual(c.circles)
    })
  }

  it('`DAMAGE_KINDS` 的四个键与它们指向的字段', () => {
    expect(Object.keys(DAMAGE_KINDS).sort()).toEqual(['approach', 'crash', 'pulse', 'tip_shape'])
    // `manual` **故意不在表里** —— 它的半径写在 `meta` 上。
    expect(DAMAGE_KINDS['manual']).toBeUndefined()
  })

  it('半径为 0 的一档不是「挡得很紧」，是**根本没有这个圈**', () => {
    const cfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, crashRM: 0 }
    expect(radiusFor(cfg, 'crash')).toBeNull()
    expect(buildAvoidCircles([mapMarker({ kind: 'crash', x_m: 0, y_m: 0 })], cfg)).toEqual([])
  })
})

// ── ⑧ nearest_clean_from ────────────────────────────────────────────────

function plainSpot(s: CleanSpot): { x_m: number; y_m: number } {
  return { x_m: s.x_m, y_m: s.y_m }
}

describe('`nearestCleanFrom` 逐格对旧仓', () => {
  /** 实测到的最大 `distance_m` 相对差 —— 打出来，别让它悄悄长大。 */
  let worst = 0

  for (const [name, c] of Object.entries(G.nearest)) {
    it(name, () => {
      const cfg = cfgFrom(c.config)
      const got = nearestCleanFrom(c.markers.map(markerFrom), cfg, c.x_m, c.y_m, {
        spotRM: c.spot_r_m,
        count: c.count,
        exclude: c.exclude.map((t) => [t[0] as number, t[1] as number] as const),
        maxDistanceM: c.max_distance_m,
        frameM: c.frame_m,
      })
      // ① 落点本身与**顺序**：零容差。
      expect(got.map(plainSpot)).toEqual(c.spots.map((s) => ({ x_m: s.x_m, y_m: s.y_m })))
      // ② 中间量（步长 / 边距 / 可用半程 / 退不退区）—— 一个只比结果的金样
      //    说不出「它为什么是这个结果」。
      const rSpot = Math.max(c.spot_r_m, 0)
      const step = Math.max(2 * rSpot, cfg.gridCellM, 1e-12)
      const margin = Math.max(c.frame_m ?? cfg.frameSizeM, 0) / 2
      const reach0 = Math.max(effectiveHalfRangeM(cfg) - margin, 0)
      expect(step).toEqual(c.derived.step)
      expect(margin).toEqual(c.derived.frame_margin)
      expect(reach0 < rSpot).toBe(c.derived.zone_released)
      // ③ 距离：只有它经过 `hypot`。
      const scale = Math.max(...c.spots.map((s) => Math.abs(s.distance_m)), Number.MIN_VALUE)
      for (let i = 0; i < got.length; i += 1) {
        const d = Math.abs((got[i] as CleanSpot).distanceM - (c.spots[i] as { distance_m: number }).distance_m)
        worst = Math.max(worst, d / scale)
        expect(d, `${name}[${i}] distance`).toBeLessThanOrEqual(DIST_REL_TOL * scale)
      }
    })
  }

  it('distance ULP：实测占容差的比例 < 1（超过 1 说明有别的东西也在飘）', () => {
    // 前面每一格都跑过了，`worst` 是它们的最大值。
    expect(worst / DIST_REL_TOL).toBeLessThan(1)
  })

  it('`count = 0` ⇒ 空表，而且**一次枚举都不做**', () => {
    const cfg = DEFAULT_ANALYSIS_CONFIG
    expect(nearestCleanFrom([], cfg, 0, 0, { spotRM: 1e-7, count: 0 })).toEqual([])
    expect(nearestCleanFrom([], cfg, 0, 0, { spotRM: 1e-7, count: -3 })).toEqual([])
  })

  it('针尖脚下还干净时，它**自己就是第一个候选**，距离 0', () => {
    const cfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, centerZoneSideM: null }
    const got = nearestCleanFrom([], cfg, 0, 0, { spotRM: 2e-7, count: 3, frameM: 0 })
    expect(got[0]).toEqual({ x_m: 0, y_m: 0, distanceM: 0 })
  })

  it('外部传进来的 `circles` 压过 markers —— 两个来源不许各算一次', () => {
    const cfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, centerZoneSideM: null }
    const circles: AvoidCircle[] = [{ x_m: 0, y_m: 0, radiusM: 1e-7, kind: 'crash', label: 'x' }]
    const got = nearestCleanFrom([mapMarker({ kind: 'pulse', x_m: 4e-7, y_m: 0 })], cfg, 0, 0, {
      spotRM: 2e-7,
      count: 3,
      circles,
      frameM: 0,
    })
    // 区心被传进来的那个圈挡住了，而 marker 那一个**没有**生效。
    expect(got.map(plainSpot)).toEqual([
      { x_m: 0, y_m: -4e-7 },
      { x_m: 0, y_m: 4e-7 },
      { x_m: -4e-7, y_m: 0 },
    ])
  })
})
