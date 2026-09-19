/**
 * `FindCleanSpot` —— 就近找一块还没被弄脏的表面：「打一次换一个地方」的那个「地方」。
 *
 * 修针时每打一发脉冲、每扎一次针都要换位置：原地再来一次，读到的是上一次留下的坑
 * 的行为，判据就废了。但换到哪里不是随便挑 —— 脉冲会把材料溅到周围、扎针留下的簇
 * 小一些，这些半径连同历史上每一次脉冲 / 撞针 / 进针的坐标都记在扫描地图里。
 *
 * 与「第 N 张巡览图该放哪」是两个问题：那个走从原点出发的固定路线；
 * 这个回答「我刚在这儿动过手，最近的还能动手的地方在哪」。一次大跨度移动会重新
 * 激起压电蠕变，而修针一轮要打十几次 —— 省下的不是时间，是后面几帧图的质量。
 *
 * ## 三句话，一句都不能省
 *
 * 1. **读不到实验记录时照样给点，但如实说明。** `map_known=false` 的意思是
 *    「不知道这片表面发生过什么」，**不等于**「这片表面是干净的」。
 * 2. **撞针的历史有两个来源，这里两个都问。** 落库的地图标记是权威的那一份，
 *    而它落库那一步会断（没有活动实验、异常被吞）；断的时候进程内的撞针追踪器
 *    往往是唯一还记得刚才撞过的人。两个来源合成**同一种** `kind="crash"`，
 *    因此共用同一个避让半径，不产生第二套约定。
 * 3. **`crash_memory_unlocated > 0` 表示确实知道发生过一次撞针、而那个位置谁也
 *    读不出来** —— 于是它躲不开，返回的落点带着这份风险，报文里必须说。
 *
 * ## 判据本体在 `dsh-spm-kernel` 的三件里
 *
 * `map-scope.ts`（配置装配 + 两个来源）· `map-analysis.ts`（选点几何）·
 * `exp-map.ts`（一行记录变成一个标记）。这一层只做四件事：
 * 读针尖位置、向仪器问一次压电量程、把两个来源合起来、把结论说成人话。
 */
import {
  analysisConfig,
  buildAvoidCircles,
  crashMemoryMarkers,
  effectiveHalfRangeM,
  halfRange,
  loadMarkers,
  nearestCleanFrom,
  pyFixed,
  type AnalysisConfig,
  type MapMarker,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { cell } from './common.js'
import { parseTipXy } from './tip-xy.js'

/**
 * 用途 → 该用哪个避让半径。与扫描地图的 `DAMAGE_KINDS` 一一对应，所以
 * 「打脉冲要避开多远」在地图上画的圈和这里选点用的圈**永远是同一个数**。
 */
const PURPOSE_RADIUS: Readonly<Record<string, 'pulseRM' | 'tipShapeRM'>> = {
  pulse: 'pulseRM',
  tip_shape: 'tipShapeRM',
}

/**
 * 这一次的压电半程是谁说的。**三态，不是布尔** —— 「读不到」必须和
 * 「问过了，仪器更宽松」分得开：前者是判不了，后者是核对过。
 *
 * （2026-08-16：配置写死 1.5 µm 而仪器实测 1219.5 nm，差 23 %，
 * 选点因此提议了针尖到不了的目标，外环中止，**54 分钟工作全丢**。）
 */
export const PIEZO_SRC_CONFIG = 'config'
export const PIEZO_SRC_INSTRUMENT_TIGHTER = 'instrument(比配置小,已收紧)'
export const PIEZO_SRC_INSTRUMENT_LOOSER = 'instrument(配置更保守,沿用配置)'

/**
 * `"x1,y1;x2,y2"` → 坐标表。与 `FindFlatRegion` 的 `exclude_used_spots` 同款格式
 * —— 两个技能对「已经用过的点」用不同的写法只会让调用方写错。
 *
 * **坏块跳过，不是整串作废**：调用方手里这份清单是「刚打过、还没落库」的那几点，
 * 因为一个手抖的分号把整串丢掉，等于让下一发落回同一个坑。
 */
export function parseSpots(raw: string): [number, number][] {
  const out: [number, number][] = []
  for (const rawChunk of (raw || '').split(';')) {
    const chunk = rawChunk.trim()
    if (chunk === '') continue
    const parts = chunk.split(',')
    if (parts.length !== 2) continue
    const x = pyFloatOrNull(parts[0] as string)
    const y = pyFloatOrNull(parts[1] as string)
    if (x === null || y === null) continue
    out.push([x, y])
  }
  return out
}

/**
 * Python 的 `float(s)` —— **抛的那些跳过**。
 *
 * ⚠️ `nan` / `inf` 在 Python 里是**合法的** `float()` 入参，所以它们进得来
 * （旧仓如此，照移：金样 `parse_spots.nan_is_a_float` 钉住）。
 * 一个 NaN 已用点在 `hypot` 里对谁都不成立 ⇒ 它谁都挡不住，而那正是旧仓的行为。
 */
function pyFloatOrNull(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const low = t.toLowerCase()
  if (low === 'nan' || low === '+nan' || low === '-nan') return NaN
  if (low === 'inf' || low === 'infinity' || low === '+inf' || low === '+infinity') {
    return Infinity
  }
  if (low === '-inf' || low === '-infinity') return -Infinity
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** `f"{v * 1e9:.0f}"`。 */
function nm0(v: number): string {
  return pyFixed(v * 1e9, 0)
}

/** `f"{v * 1e9:.1f}"`。 */
function nm1(v: number): string {
  return pyFixed(v * 1e9, 1)
}

/**
 * 仪器报的压电半程，读不到给 `null`。
 *
 * ⚠️ 用**共用的**解码器（`cell`），别手写第 N 份。Nanonis 的线格式是
 * `('', b'…', [x, y, z])` —— 数值在第三个元素**里面**，顶层只有 str/bytes/list。
 * 旧仓第一版写了个只扫顶层的过滤，在真机上一个数都取不到，于是永远沉默退回
 * config 值 —— 一个「看着在防护其实没有」的修复。
 *
 * 单元素回包被 `cell` **解一层** ⇒ 拿到的不是表 ⇒ 判不了（照移）。
 */
function instrumentHalfRange(rec: SkillCallRecord): number | null {
  const decoded = cell(rec)
  if (!Array.isArray(decoded)) return null
  const vals = decoded.filter((v): v is number => typeof v === 'number')
  if (vals.length < 2) return null
  // `Piezo_RangeGet` 回**全程**，不是半程。两轴取小 —— 包络要保守。
  return halfRange(Math.min(Math.abs(vals[0] as number), Math.abs(vals[1] as number)))
}

export const FindCleanSpot: Skill = {
  spec: S.FindCleanSpotSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const purpose = String(params['purpose'] || 'pulse')
    const count = Math.trunc(Number(params['count'] || 8))
    const exclude = parseSpots(String(params['exclude_spots'] || ''))

    let x0 = params['from_x_m'] as number | null | undefined
    let y0 = params['from_y_m'] as number | null | undefined
    let originSrc = 'explicit'
    if (x0 === null || x0 === undefined || y0 === null || y0 === undefined) {
      // 旧仓把这一次读**排除在 `nanonis_calls` 之外**（它是 `read_tip_xy`
      // 自己的一次往返）。本仓没有那一栏 —— 调用台账由内核记（同
      // `RetractForSampleChange` 抬头）—— 所以那条区分在这里没有落点，
      // 测试改为直接钉住**下发序列**。
      const pos = parseTipXy(await ctx.safeCall('FolMe_XYPosGet', 0))
      if (pos === null) {
        return {
          success: false,
          error:
            'Cannot read the tip position (FolMe_XYPosGet), and no ' +
            'from_x_m/from_y_m was given — there is no origin to search from.',
        }
      }
      x0 = pos[0]
      y0 = pos[1]
      originSrc = 'live_tip'
    }
    const ox = Number(x0)
    const oy = Number(y0)

    // 实时扫描框只决定候选间距，**读不到不该让选点失败**（旧仓在
    // `analysis_config` 里包了 `try/except`；本仓把那一层挪到这里 ——
    // 内核收的是已经读出来的宽度，登记见 deviations 批 7a-2）。
    let scanWidthM: number | null = null
    try {
      scanWidthM = ctx.state().scan_width_m
    } catch {
      scanWidthM = null
    }
    let cfg: AnalysisConfig = analysisConfig({ scanWidthM })

    // ── 压电半程：**问仪器，别信配置** ──────────────────────────────────
    //
    // `SafetyLimits.xy_max_m` 出厂 1.5 µm，是写死的常数，**从不与仪器核对**。
    // 换温度（下液氦）、换扫描器、改压电标定都会动真实范围，而没有任何东西会去
    // 看一眼 —— 2026-08-16 现场给出的判据：「下液氦之后确实没有重置扫描框范围」。
    //
    // 后果是**沉默的**：配置比实际大，选点就会提议针尖到不了的目标，`MoveToXY`
    // 夹在限位上报「超时」（而且那句话说「可能仍在移动中」，是假的），
    // 外环 `optional=false` 直接中止。实测那次丢了 54 分钟。
    //
    // 取**两者的较小值**：仪器说的是硬边界；配置若更保守则尊重它。
    let piezoSrc = PIEZO_SRC_CONFIG
    const recRange = await ctx.safeCall('Piezo_RangeGet')
    if (recRange.error === undefined || recRange.error === '') {
      const instHalf = instrumentHalfRange(recRange)
      if (instHalf !== null && instHalf > 0) {
        if (instHalf < cfg.piezoHalfRangeM) {
          cfg = { ...cfg, piezoHalfRangeM: instHalf }
          piezoSrc = PIEZO_SRC_INSTRUMENT_TIGHTER
        } else {
          piezoSrc = PIEZO_SRC_INSTRUMENT_LOOSER
        }
      }
    }
    const spotR = cfg[PURPOSE_RADIUS[purpose] ?? 'pulseRM']

    const loaded = loadMarkers()
    const markers = loaded.markers
    // 撞针的第二个来源。地图那条链会断（没有活动实验 / 落库整段被吞），断的时候
    // 追踪器往往是唯一还记得的人。合进来的是**同一个 `kind="crash"`**。
    const crash = crashMemoryMarkers()
    const all: MapMarker[] = [...markers, ...crash.markers]
    // 「谁答上了」的名单。空表 = **没有任何一个来源知道这片表面的历史**，
    // 那与「两个来源都说干净」在几何上完全一样，只能靠这里说出来。
    const sources = [
      ...(loaded.available ? ['map'] : []),
      ...(crash.markers.length > 0 ? ['crash_memory'] : []),
    ]

    // `if params.get("max_distance_m")` 是**真值判断** ⇒ `0` 当成没给（照移）。
    const maxD = params['max_distance_m'] ? Number(params['max_distance_m']) : null
    // 打脉冲的落点上**不扫图**，所以不减帧边距。在 ±600 nm 的中心区里，
    // 那 50 nm 白白吃掉一圈可用区。
    const frameM = purpose === 'pulse' ? 0.0 : null
    let spots = nearestCleanFrom(all, cfg, ox, oy, {
      spotRM: spotR,
      count,
      exclude,
      maxDistanceM: maxD,
      frameM,
    })

    // ── 针尖站在可用区**外**：从区中心重搜，而不是报「表面用完」────────
    //
    // 候选必须落在 `effectiveHalfRangeM` 之内。针尖本身可以在区外 —— 手动挪过、
    // 上一轮跑到边上、或者像 2026-08-16 那样被一百次「避开已用点」一路挤到压电
    // 限位上（实测 Y = 1219.4999 nm，正好是硬限位）。此时从它自己的位置向外搜，
    // 搜到的全在区外，一个不留，而调用方读到的是**一句假话**：「这片表面没有
    // 干净落点了」。
    //
    // 表面没有用完，是针尖站错了地方。粗动换区既贵又不解决问题 —— 粗动动的是
    // 样品，针尖的压电坐标还在区外，下一轮照旧空手。纯压电移动几乎零成本，
    // 所以这里从**区中心**重搜一次。
    let recentredFrom: [number, number] | null = null
    if (spots.length === 0) {
      const reach = effectiveHalfRangeM(cfg)
      if (Math.abs(ox) > reach || Math.abs(oy) > reach) {
        recentredFrom = [ox, oy]
        spots = nearestCleanFrom(all, cfg, 0.0, 0.0, {
          spotRM: spotR,
          count,
          exclude,
          maxDistanceM: null,
          frameM,
        })
      }
    }

    // 「谁答上了」的账，成功和失败两条路都要带 —— 一次「没有干净点」同样要说得出
    // 是地图说的还是撞针记忆说的。
    const provenance: Record<string, unknown> = {
      map_known: loaded.available,
      coord_epoch: loaded.epoch,
      spot_radius_m: spotR,
      markers_seen: markers.length,
      // 本进程记着、且**已经参与避让**的撞针点数。
      crash_memory_points: crash.markers.length,
      // 记到了却没有坐标的撞针 —— 几何上避不开，必须明说。
      crash_memory_unlocated: crash.unlocated,
      avoidance_sources: sources,
      // 换过原点就必须说 —— 悄悄把「从针尖处找」换成「从区中心找」，调用方会以为
      // 返回的落点就在手边，而它可能在一微米之外。
      recentred: recentredFrom !== null,
      recentred_from_x_m: recentredFrom === null ? null : recentredFrom[0],
      recentred_from_y_m: recentredFrom === null ? null : recentredFrom[1],
      effective_half_range_m: effectiveHalfRangeM(cfg),
      // 这次用的压电半程是谁说的 —— 「读不到」不许伪装成「已核对」。
      piezo_half_range_m: cfg.piezoHalfRangeM,
      piezo_range_source: piezoSrc,
    }

    if (spots.length === 0) {
      return {
        success: false,
        error: refusal(all, cfg, purpose, spotR, recentredFrom),
        data: { ...provenance, candidates: 0 },
      }
    }

    const first = spots[0] as (typeof spots)[number]
    let note =
      originSrc === 'live_tip'
        ? `距当前位置 ${nm0(first.distanceM)} nm`
        : `距给定原点 ${nm0(first.distanceM)} nm`
    if (!loaded.available) {
      // 读不到地图**不是**「干净」。区别在于：此刻还有没有别人知道。
      note +=
        '；**读不到实验记录**' +
        (crash.markers.length > 0
          ? `,但本进程记着的 ${crash.markers.length} 个撞针点已经避开`
          : ',本进程也没有撞针记忆 —— **无法确认此处是否干净**')
    }
    if (crash.unlocated !== 0) {
      // 记到了、坐标不知道 ⇒ 画不出圈 ⇒ 返回的这个点有可能就在上面。
      note +=
        `；⚠️ 另有 ${crash.unlocated} 次撞针**读不到坐标**,` +
        '避让圈画不出来,这个落点无法保证不在其上'
    }
    return {
      success: true,
      data: {
        x_m: first.x_m,
        y_m: first.y_m,
        distance_m: first.distanceM,
        candidates: spots.map((s) => ({ x_m: s.x_m, y_m: s.y_m, distance_m: s.distanceM })),
        purpose,
        origin_x_m: ox,
        origin_y_m: oy,
        origin_source: originSrc,
        // 「不知道」和「干净」不是一回事 —— 调用方必须能分辨。
        ...provenance,
        reason: note,
      },
      summary: `下一个落点 (${nm1(first.x_m)}, ${nm1(first.y_m)}) nm — ${note}`,
    }
  },
}

/**
 * 「没有干净落点」那句话 —— **说出是谁挡的**。
 *
 * 2026-08-17：同一个「找不到可用区域」查了五轮才定位，因为报文只说「没有」，
 * 不说「为什么没有」。而 `data` 里其实有 provenance，但用户和日志看到的只有
 * `error` 这一行。
 *
 * 差别是实打实的：「表面用完了」⇒ 该粗动换区；「区心被一个 200 nm 的进针盘挡着，
 * 而这个区只放得下区心那一个点」⇒ 换多少次区都一样。
 * **两句话指向完全不同的下一步，而第一句会把流程送进死循环。**
 *
 * ## ⚠️ 下面那道 `try` **没有任何输入能验它**（照移，注明，不打变异）
 *
 * 它防的是「报错的修饰把报错本身弄坏」。而 `nearestCleanFrom` 在**同一份
 * marker 表**上已经先调过一次 `buildAvoidCircles`（这条路不传 `circles`，
 * 它自己建）—— 唯一能让那个函数抛的东西（一个读一下就抛的 `meta`）
 * 会在那里先炸，于是走不到这里。证明与 green-8 §2.8 同形，测试在
 * `clean-spot.test.ts`「没有任何输入能验它」那一格。
 *
 * **没有删掉它**：哪天有人把 `circles` 传进 `nearestCleanFrom`（省掉重复建圈），
 * 两次调用就不再是同一次了。但在那之前，它是一段没有闸的注释。
 */
function refusal(
  markers: readonly MapMarker[],
  cfg: AnalysisConfig,
  purpose: string,
  spotR: number,
  recentredFrom: readonly [number, number] | null,
): string {
  let blockers = ''
  try {
    const circles = buildAvoidCircles(markers, cfg)
    const rEff = effectiveHalfRangeM(cfg)
    // 只报**够得着区心的**那些 —— 远处的圈不是这次的原因。
    const near = circles
      .map((c) => ({ c, d: Math.sqrt(c.x_m ** 2 + c.y_m ** 2) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
    if (near.length > 0) {
      blockers =
        ';挡路的:' +
        near
          .map(
            ({ c, d }) =>
              `${c.kind} 在 (${nm0(c.x_m)}, ${nm0(c.y_m)}) nm` +
              `(盘半径 ${nm0(c.radiusM)} nm,距区心 ${nm0(d)} nm,` +
              `要 ${nm0(c.radiusM + spotR)} nm 才让得开)`,
          )
          .join('、')
    } else if (rEff < spotR) {
      blockers =
        `;⚠️ 可用区半程 ${nm0(rEff)} nm **比落点净空 ` +
        `${nm0(spotR)} nm 还小** —— 这个区放不下一个点,` +
        '粗动换区解决不了'
    } else {
      blockers = ';地图和撞针记忆里都没有挡路的东西 —— 看几何/配置'
    }
  } catch {
    // 报错的修饰不许把报错本身弄坏。
  }
  return (
    `No undamaged spot within reach for '${purpose}' ` +
    `(avoidance radius ${nm0(spotR)} nm)` +
    (recentredFrom !== null
      ? `,连从可用区中心重搜也没有` +
        `(针尖当时在 (${nm0(recentredFrom[0])}, ` +
        `${nm0(recentredFrom[1])}) nm,已在可用区 ` +
        `±${nm0(effectiveHalfRangeM(cfg))} nm 之外)`
      : '') +
    blockers +
    '. This patch of surface is spent — relocate with ' +
    'RelocateCoarseXY, or work on a fresh sample area.'
  )
}

export const CLEAN_SPOT: Readonly<Record<string, Skill>> = { FindCleanSpot }
