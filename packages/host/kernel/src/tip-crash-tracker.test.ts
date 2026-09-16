/**
 * 撞针追踪器对 `spec/golden/tip_crash.json` 逐步比。
 *
 * 金样由旧仓真实的 `TipCrashTracker` 录制（`tools/spec-export/export_tip_crash.py`），
 * 每条是一个**脚本**而不是一格输入：这台判定机全是状态，判据是「第三次调用为什么被拒」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_BLOCK_THRESHOLD,
  DEFAULT_TIP_CRASH_CONFIG,
  DEFAULT_TOL_M,
  DEFAULT_TTL_S,
  TipCrashTracker,
  crashEscapeMessage,
  crashGuard,
  getTipCrashTracker,
  processTipCrash,
  resetTipCrashTracker,
  tipCrashConfig,
  type TipCrashConfig,
} from './tip-crash-tracker.js'

type Step =
  | { op: 'record'; at: [unknown, unknown]; count: number }
  | { op: 'count'; at: [unknown, unknown]; count: number }
  | { op: 'blocked'; at: [unknown, unknown]; blocked: boolean }
  | { op: 'points'; located: [number, number, number][]; unlocated: number }
  | { op: 'recover'; at: [unknown, unknown] }
  | { op: 'recover_all' }
  | { op: 'tick'; by_s: number; now_s: number }
  | { op: 'escape'; at: [unknown, unknown]; text: string }
  | { op: 'snapshot'; snapshot: Record<string, number> }

const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/tip_crash.json', import.meta.url)), 'utf8'),
) as {
  constants: { block_threshold: number; tol_m: number; ttl_s: number }
  scripts: Record<
    string,
    { config: { block_threshold?: number; tol_m?: number; ttl_s?: number }; steps: Step[] }
  >
  escape_messages: Record<string, { count: number; x_m: unknown; y_m: unknown; text: string }>
}

/** 每条脚本一台**自己的**追踪器 + 一口自己的假钟。 */
function drive(cfgIn: { block_threshold?: number; tol_m?: number; ttl_s?: number }, steps: Step[]): void {
  let now = 0.0
  const cfg: TipCrashConfig = {
    // `max(1, int(threshold))` —— 「撞 0 次就封」不是一个可用的状态机
    blockThreshold: Math.max(1, Math.trunc(cfgIn.block_threshold ?? DEFAULT_BLOCK_THRESHOLD)),
    tolM: cfgIn.tol_m ?? DEFAULT_TOL_M,
    ttlS: cfgIn.ttl_s ?? DEFAULT_TTL_S,
  }
  const t = new TipCrashTracker(
    () => cfg,
    () => now,
  )
  for (const step of steps) {
    switch (step.op) {
      case 'record':
        expect(t.recordCrash(step.at[0], step.at[1])).toBe(step.count)
        break
      case 'count':
        expect(t.crashCount(step.at[0], step.at[1])).toBe(step.count)
        break
      case 'blocked':
        expect(t.isBlocked(step.at[0], step.at[1])).toBe(step.blocked)
        break
      case 'points': {
        const p = t.crashPoints()
        expect(p.located.map((q) => [q.xM, q.yM, q.count]).sort(cmp)).toEqual(
          step.located.map((q) => [...q]).sort(cmp),
        )
        expect(p.unlocated).toBe(step.unlocated)
        break
      }
      case 'recover':
        t.noteRecovery(step.at[0], step.at[1])
        break
      case 'recover_all':
        t.noteRecovery()
        break
      case 'tick':
        now += step.by_s
        expect(now).toBe(step.now_s)
        break
      case 'escape':
        expect(crashEscapeMessage(t.crashCount(step.at[0], step.at[1]), step.at[0], step.at[1])).toBe(
          step.text,
        )
        break
      case 'snapshot': {
        const s = t.snapshot()
        // `since_s` 是**本仓新增**的（见模块抬头 ①），金样里没有 —— 逐键比时排除它。
        const { since_s, ...rest } = s
        expect(rest).toEqual(step.snapshot)
        expect(since_s).toBe(now)
        break
      }
    }
  }
}

function cmp(a: number[], b: number[]): number {
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
}

describe('TipCrashTracker · 金样逐步', () => {
  for (const [name, script] of Object.entries(G.scripts)) {
    it(name, () => drive(script.config, script.steps))
  }
})

describe('逃逸文案逐字', () => {
  for (const [name, c] of Object.entries(G.escape_messages)) {
    it(name, () => {
      expect(crashEscapeMessage(c.count, c.x_m, c.y_m)).toBe(c.text)
    })
  }
})

describe('常数与旧仓一致', () => {
  it('阈值 / 容差 / TTL', () => {
    expect(DEFAULT_TIP_CRASH_CONFIG).toEqual({
      blockThreshold: G.constants.block_threshold,
      tolM: G.constants.tol_m,
      ttlS: G.constants.ttl_s,
    })
  })
})

// ── 进程级那一份：住哪、谁注入、不接时什么行为（见模块抬头三问） ──────────────

describe('进程级追踪器', () => {
  afterEach(() => {
    processTipCrash.config = {}
    processTipCrash.nowS = () => Date.now() / 1000
    processTipCrash.tracker = null
  })

  it('宿主什么都不接 ⇒ 出厂阈值生效，而且闸是**关着的**，不是放行', () => {
    processTipCrash.tracker = null
    expect(tipCrashConfig()).toEqual(DEFAULT_TIP_CRASH_CONFIG)
    const t = getTipCrashTracker()
    t.recordCrash(0, 0)
    expect(crashGuard(0, 0)).toBeNull() // 一次还不封
    t.recordCrash(0, 0)
    expect(crashGuard(0, 0)).toContain('repeated_crash_escape_required')
  })

  it('同一把 —— 记的一侧与读的一侧必须是同一个实例', () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(1e-7, 1e-7)
    getTipCrashTracker().recordCrash(1e-7, 1e-7)
    expect(getTipCrashTracker().isBlocked(1e-7, 1e-7)).toBe(true)
    expect(crashGuard(1e-7, 1e-7)).not.toBeNull()
  })

  it('限值由外面注入（D-VAC-1 / D-LIMITS-1 同一条）', () => {
    processTipCrash.config = { blockThreshold: 1 }
    processTipCrash.tracker = null
    getTipCrashTracker().recordCrash(0, 0)
    expect(crashGuard(0, 0)).toContain('crash 1 次')
  })

  it('墙钟由外面注入 —— TTL 在注入的钟上过期', () => {
    let now = 0
    processTipCrash.nowS = () => now
    processTipCrash.tracker = null
    const t = getTipCrashTracker()
    t.recordCrash(0, 0)
    t.recordCrash(0, 0)
    expect(t.isBlocked(0, 0)).toBe(true)
    now += DEFAULT_TTL_S + 1
    expect(t.isBlocked(0, 0)).toBe(false)
  })

  it('留痕的沉没不许把一次拒绝变成一次放行', () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    getTipCrashTracker().recordCrash(0, 0)
    const boom = (): never => {
      throw new Error('markers 没接')
    }
    expect(crashGuard(0, 0, boom)).toContain('repeated_crash_escape_required')
  })

  it('留痕接上了就发一条，字段齐全', () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(3e-7, -3e-7)
    getTipCrashTracker().recordCrash(3e-7, -3e-7)
    const seen: { kind: string; data: Record<string, unknown> }[] = []
    crashGuard(3e-7, -3e-7, (kind, data) => seen.push({ kind, data }))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.kind).toBe('tip_crash')
    expect(seen[0]!.data['subject']).toBe('repeated_same_region')
    expect(seen[0]!.data['count']).toBe(2)
    expect(seen[0]!.data['x_m']).toBe(3e-7)
  })

  it('没封的区域一条面包屑都不发', () => {
    resetTipCrashTracker()
    const seen: string[] = []
    expect(crashGuard(0, 0, (k) => seen.push(k))).toBeNull()
    expect(seen).toEqual([])
  })
})

describe('读不到 ≠ 零 ≠ 否', () => {
  it('读不到扫描中心的撞针照样计数、照样拦人', () => {
    resetTipCrashTracker()
    const t = getTipCrashTracker()
    t.recordCrash(null, null)
    t.recordCrash(undefined, undefined)
    expect(t.isBlocked(null, null)).toBe(true)
    expect(crashGuard(null, null)).toContain('repeated_crash_escape_required')
  })

  it('它们**单独**交出来，绝不当成一个点', () => {
    resetTipCrashTracker()
    const t = getTipCrashTracker()
    t.recordCrash(null, null)
    t.recordCrash(1e-7, 1e-7)
    const p = t.crashPoints()
    expect(p.unlocated).toBe(1)
    // 交回来的是**格子中心**：1e-7 / 8e-9 = 12.5，银行家舍入到 12 ⇒ 9.6e-8。
    // 误差 4 nm（半格），比消费它的避让半径小两个数量级，改不了任何一个决定。
    expect(p.located).toEqual([{ xM: 12 * 8e-9, yM: 12 * 8e-9, count: 1 }])
  })

  it('坐标是 `inf` ⇒ 哨兵格（旧仓 `round(inf)` 抛的是 OverflowError，没人接）', () => {
    resetTipCrashTracker()
    const t = getTipCrashTracker()
    t.recordCrash(Number.POSITIVE_INFINITY, 0)
    expect(t.crashPoints()).toEqual({ located: [], unlocated: 1 })
    expect(t.crashCount(null, null)).toBe(1)
  })

  it('`snapshot().since_s` 分得开「没撞过」与「我刚出生」', () => {
    let now = 100
    const t = new TipCrashTracker(() => DEFAULT_TIP_CRASH_CONFIG, () => now)
    expect(t.snapshot().since_s).toBe(0)
    now += 4200
    expect(t.snapshot()).toMatchObject({ tracked_regions: 0, since_s: 4200 })
  })
})

describe('换区清空 vs 单点清空', () => {
  it('`noteRecovery(null, null)` 与 `noteRecovery()` 同义 —— 全清', () => {
    const t = new TipCrashTracker(() => DEFAULT_TIP_CRASH_CONFIG, () => 0)
    t.recordCrash(0, 0)
    t.recordCrash(1e-6, 1e-6)
    t.noteRecovery(null, null)
    expect(t.snapshot().tracked_regions).toBe(0)
  })

  it('给了坐标只清那一格', () => {
    const t = new TipCrashTracker(() => DEFAULT_TIP_CRASH_CONFIG, () => 0)
    t.recordCrash(0, 0)
    t.recordCrash(1e-6, 1e-6)
    t.noteRecovery(0, 0)
    expect(t.snapshot().tracked_regions).toBe(1)
    expect(t.crashCount(1e-6, 1e-6)).toBe(1)
  })
})
