/**
 * `FindCleanSpot` 逐格对 `spec/golden/map_scope.json` 的 `skill` 一节
 *（旧仓真技能 + 旧仓真地图层录的，`tools/spec-export/export_map_scope.py`）。
 *
 * 通用轨迹金样（`skill_traces.json`）走得到的只有「空地图 + 合成回包」那一条：
 * 它的假 context 给不出实验记录，也给不出撞针记忆。这一份自己摆世界，于是
 * **三态压电来源 · 四种「谁答上了」的组合 · 三种「没有落点」的话术 · 区外重搜**
 * 各自有一格。
 *
 * ## 容差
 *
 * 除 `distance_m` 之外**全部零容差** —— 报文、`avoidance_sources`、计数、
 * 落点坐标、下发序列。`distance_m` 走 `Math.hypot`（D-HYPOT-1），
 * 见 {@link DIST_REL_TOL}。
 * ⚠️ 报文里的距离是 `:.0f` / `:.1f`，那 1 ULP 在**字符串这一侧表示不出来**，
 * 所以 `summary` / `reason` / `error` 照旧逐字比。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  processExpMap,
  processInstrumentProfile,
  processTipCrash,
  type MapMarkerRow,
  type SkillCallRecord,
  type SkillContext,
  type TipCrashTracker,
} from 'dsh-spm-kernel'
import { FindCleanSpot, parseSpots } from './clean-spot.js'

const G = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/map_scope.json', import.meta.url)),
    'utf8',
  ),
) as {
  skill: Record<string, SkillCase>
  parse_spots: Record<string, { raw: string; spots: number[][] }>
}

interface SkillCase {
  params: Record<string, unknown>
  world: {
    profile: Record<string, unknown>
    rows: unknown
    replies: Record<string, unknown>
    state_scan_width_m: number | null
  }
  calls: { verb: string; args: unknown[]; error: string | null }[]
  result: {
    success: boolean
    error: string
    summary: string
    data: Record<string, unknown>
    nanonis_calls: { verb: string; args: unknown[]; error: string | null }[]
  }
}

/** 同 `map-layer.test.ts` —— 只有 `distance_m` 经过 `hypot`。 */
const DIST_REL_TOL = 4 * Number.EPSILON

/**
 * 每一格的世界都是从**金样自己的 `world` 字段**摆出来的。
 *
 * 一格里 `tracker` 的内容不在 `world` 里（导出器那侧是一个 Python 对象），
 * 所以这里按用例名给 —— 而它给的数**会被回包里的 `crash_memory_points` 反过来
 * 钉住**：给错了那一格当场红。
 */
const TRACKERS: Record<string, { located: { xM: number; yM: number; count: number }[]; unlocated: number }> = {
  map_unknown_with_crash_memory: { located: [{ xM: 400e-9, yM: 0.0, count: 2 }], unlocated: 0 },
  map_known_with_crash_memory: { located: [{ xM: 400e-9, yM: 0.0, count: 2 }], unlocated: 0 },
  crash_unlocated_only: { located: [], unlocated: 3 },
  crash_located_and_unlocated: { located: [{ xM: 400e-9, yM: 400e-9, count: 1 }], unlocated: 2 },
  recentred_and_still_nothing: { located: [{ xM: 0.0, yM: 0.0, count: 1 }], unlocated: 0 },
}

interface Rig {
  readonly ctx: SkillContext
  readonly calls: { verb: string; args: unknown[] }[]
}

function rig(replies: Record<string, unknown>, scanWidthM: number | null, stateThrows = false): Rig {
  const calls: { verb: string; args: unknown[] }[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    state: () => {
      if (stateThrows) throw new Error('状态缓存读不到')
      return { scan_width_m: scanWidthM }
    },
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push({ verb: m, args: a })
      const spec = replies[m]
      if (typeof spec === 'string') {
        return Promise.resolve({ method: m, args: a, error: spec })
      }
      // 金样里的回包是三段信封 `["", "<bytes N>", body]`；本仓的 wire 层已经把
      // 信封拆掉了，技能手上只有 body。
      const body = Array.isArray(spec) ? (spec[2] as unknown[]) : [0.25]
      return Promise.resolve({ method: m, args: a, values: body })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
  } as unknown as SkillContext
  return { ctx, calls }
}

/**
 * `data` 里所有 `distance_m` 的位置 —— 唯一带容差的那一族。
 *
 * ⚠️ 失败那条路上 `candidates` 是**数字 0**（不是空表）—— 旧仓如此，照移，
 * 所以这里要先问它是不是一个表。
 */
function distances(data: Record<string, unknown>): number[] {
  const out: number[] = []
  if (typeof data['distance_m'] === 'number') out.push(data['distance_m'])
  const cands = data['candidates']
  if (Array.isArray(cands)) {
    for (const c of cands as { distance_m: number }[]) out.push(c.distance_m)
  }
  return out
}

/** 金样里 NaN / ±inf 是字符串占位符（导出器的 `_plain`）。 */
function fromGolden(v: unknown): unknown {
  if (v === 'NaN') return NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  if (Array.isArray(v)) return v.map(fromGolden)
  return v
}

/** 把 `distance_m` 换成占位符，其余照旧逐字深比。 */
function blankDistances(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data }
  if (typeof out['distance_m'] === 'number') out['distance_m'] = '<d>'
  if (Array.isArray(out['candidates'])) {
    out['candidates'] = (out['candidates'] as Record<string, unknown>[]).map((c) => ({
      ...c,
      distance_m: '<d>',
    }))
  }
  return out
}

afterEach(() => {
  processInstrumentProfile.source = null
  processExpMap.markerRows = null
  processTipCrash.tracker = null
})

function setWorld(name: string, c: SkillCase): void {
  processInstrumentProfile.source = () => c.world.profile
  const rows = c.world.rows
  if (rows === 'no-log' || rows === 'no-storage') processExpMap.markerRows = null
  else if (rows === 'raises') {
    processExpMap.markerRows = () => {
      throw new Error('存储不可用')
    }
  } else processExpMap.markerRows = () => rows as MapMarkerRow[]

  if (name === 'tracker_raises') {
    processTipCrash.tracker = {
      crashPoints: () => {
        throw new Error('追踪器读不到')
      },
    } as unknown as TipCrashTracker
  } else {
    const t = TRACKERS[name] ?? { located: [], unlocated: 0 }
    processTipCrash.tracker = { crashPoints: () => t } as unknown as TipCrashTracker
  }
}

describe('FindCleanSpot 逐格对旧仓', () => {
  let worst = 0

  for (const [name, c] of Object.entries(G.skill)) {
    it(name, async () => {
      setWorld(name, c)
      const { ctx, calls } = rig(c.world.replies, c.world.state_scan_width_m)
      const r = await FindCleanSpot.execute(ctx, c.params)

      expect(r.success).toBe(c.result.success)
      expect(r.error ?? '').toBe(c.result.error)
      expect(r.summary ?? '').toBe(c.result.summary)
      // 下发序列逐条（动词 + 实参）。旧仓的 `nanonis_calls` 少了读针尖那一次，
      // 而本仓没有那一栏 —— 这里钉的是**真正下发了什么**。
      expect(calls).toEqual(c.calls.map((x) => ({ verb: x.verb, args: x.args })))

      const want = c.result.data
      expect(blankDistances(r.data ?? {})).toEqual(blankDistances(want))
      const gotD = distances(r.data ?? {})
      const wantD = distances(want)
      expect(gotD.length).toBe(wantD.length)
      const scale = Math.max(...wantD.map(Math.abs), Number.MIN_VALUE)
      for (let i = 0; i < gotD.length; i += 1) {
        const diff = Math.abs((gotD[i] as number) - (wantD[i] as number))
        worst = Math.max(worst, diff / scale)
        expect(diff, `${name} distance[${i}]`).toBeLessThanOrEqual(DIST_REL_TOL * scale)
      }
    })
  }

  it('distance ULP：实测占容差的比例 < 1', () => {
    expect(worst / DIST_REL_TOL).toBeLessThan(1)
  })
})

describe('`parseSpots`（坏块跳过，不是整串作废）', () => {
  for (const [name, c] of Object.entries(G.parse_spots)) {
    it(name, () => {
      const got = parseSpots(c.raw).map(([x, y]) => [x, y])
      expect(got).toEqual(fromGolden(c.spots))
    })
  }
})

// ── 错误分支：每一条一格 ────────────────────────────────────────────────

describe('FindCleanSpot · 错误分支', () => {
  it('读不到针尖位置、又没给起点 ⇒ 失败，而且**一次 `Piezo_RangeGet` 都没发**', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx, calls } = rig({ FolMe_XYPosGet: '连接被对端关闭' }, null)
    const r = await FindCleanSpot.execute(ctx, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('there is no origin to search from')
    expect(calls.map((c) => c.verb)).toEqual(['FolMe_XYPosGet'])
  })

  it('给了起点 ⇒ **不读针尖**（省一次往返，而且读失败也影响不到它）', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx, calls } = rig({ FolMe_XYPosGet: '炸了' }, null)
    const r = await FindCleanSpot.execute(ctx, { from_x_m: 0, from_y_m: 0, count: 1 })
    expect(r.success).toBe(true)
    expect(calls.map((c) => c.verb)).toEqual(['Piezo_RangeGet'])
    expect((r.data as Record<string, unknown>)['origin_source']).toBe('explicit')
  })

  it('`Piezo_RangeGet` 失败 ⇒ 压电来源是 `config`，**技能照样成功**', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx } = rig({ FolMe_XYPosGet: ['', '', [0, 0]], Piezo_RangeGet: '超时' }, null)
    const r = await FindCleanSpot.execute(ctx, { count: 1 })
    expect(r.success).toBe(true)
    const d = r.data as Record<string, unknown>
    expect(d['piezo_range_source']).toBe('config')
    expect(d['piezo_half_range_m']).toBe(1.5e-6)
  })

  it('实时状态**抛了** ⇒ 帧尺寸回落到 100 nm，选点照常', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx } = rig({ FolMe_XYPosGet: ['', '', [0, 0]] }, 50e-9, true)
    const r = await FindCleanSpot.execute(ctx, { purpose: 'tip_shape', count: 1 })
    expect(r.success).toBe(true)
    // 帧 100 nm ⇒ 边距 50 nm ⇒ 可用半程 550 nm（50 nm 的帧会给 575）。
    expect((r.data as Record<string, unknown>)['effective_half_range_m']).toBe(6e-7)
  })

  it('撞针追踪器**抛了** ⇒ 少了一个来源，而回包里看不出来（照移的 fail-open）', async () => {
    processInstrumentProfile.source = () => ({})
    processTipCrash.tracker = {
      crashPoints: () => {
        throw new Error('炸了')
      },
    } as unknown as TipCrashTracker
    const { ctx } = rig({ FolMe_XYPosGet: ['', '', [0, 0]] }, null)
    const broken = await FindCleanSpot.execute(ctx, { count: 1 })

    processTipCrash.tracker = {
      crashPoints: () => ({ located: [], unlocated: 0 }),
    } as unknown as TipCrashTracker
    const { ctx: ctx2 } = rig({ FolMe_XYPosGet: ['', '', [0, 0]] }, null)
    const fine = await FindCleanSpot.execute(ctx2, { count: 1 })

    expect(broken.data).toEqual(fine.data)
    expect(broken.summary).toBe(fine.summary)
  })

  it('拒绝那句话外面那道 try —— **没有任何输入能验它**（证明在这里）', async () => {
    processInstrumentProfile.source = () => ({ avoid_radius_pulse_nm: 500.0 })
    // 先确认这一格本来就说得出「挡路的是谁」（撞针盘盖住唯一的格点）。
    processExpMap.markerRows = () => [{ kind: 'crash', x_m: 0, y_m: 0 } as MapMarkerRow]
    const { ctx } = rig({ FolMe_XYPosGet: ['', '', [0, 0]] }, null)
    const base = await FindCleanSpot.execute(ctx, { count: 1 })
    expect(base.success).toBe(false)
    expect(base.error).toContain('挡路的')

    // 唯一能让 `buildAvoidCircles` 炸的东西是一个**读一下就抛**的 `meta`。
    // 而 `nearestCleanFrom` 在**同一份 marker 表**上先调了一次同一个函数
    // （`circles` 没传 ⇒ 它自己建）—— 于是走到拒绝那一句之前就已经炸了，
    // 那道 try 永远轮不到。**先证明不可达，再决定要不要留**（同 green-8 §2.8）。
    const nastyMeta = new Proxy(
      {},
      {
        get(): never {
          throw new Error('meta 坏了')
        },
      },
    )
    processExpMap.markerRows = () =>
      [{ kind: 'manual', x_m: 0, y_m: 0, meta: nastyMeta } as MapMarkerRow]
    const { ctx: ctx2 } = rig({}, null)
    await expect(
      FindCleanSpot.execute(ctx2, {
        from_x_m: 123e-9,
        from_y_m: 45e-9,
        count: 1,
        max_distance_m: 1e-12,
      }),
    ).rejects.toThrow('meta 坏了')
  })
})
