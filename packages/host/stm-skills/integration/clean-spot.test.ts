/**
 * `FindCleanSpot` 对**真 stmsim** 跑一遍。
 *
 * 单测与金样验的是判据（几何、话术、三态）。这里验的是单测验不到的那一件：
 * **`Piezo_RangeGet` 在真仪器上回来的形状，正是那段「问仪器，别信配置」假设的那个。**
 *
 * 这条缝值钱的理由写在旧仓的注释里，一字不改地适用于本仓：
 *
 * > 第一版写了个只扫**顶层**的 isinstance 过滤，在真机上一个数都取不到，
 * > 于是永远沉默退回 config 值 —— 一个「看着在防护其实没有」的修复。
 *
 * 「沉默退回」正是它可怕的地方：单测里我自己造的回包一定是对的形状，
 * 而一个形状假设错了的解析器，在**每一格自造回包上都对、在真机上一次都不对**，
 * 并且**不报错**。所以这一格问的不是「数对不对」，是
 * **`piezo_range_source` 到底是不是 `config`** —— 那一个枚举就是「读到了吗」。
 *
 * 模拟器由 globalSetup 起在 16501–16504，所以这里 `spawn: false`。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  processExpMap,
  processInstrumentProfile,
  processTipCrash,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { FindCleanSpot, PIEZO_SRC_CONFIG } from '../src/l0/clean-spot.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  processInstrumentProfile.source = null
  processExpMap.markerRows = null
  processTipCrash.tracker = null
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

function instrument(timeoutMs = 10_000): Promise<{ ctx: SkillContext; calls: string[] }> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      resolve(skillCtx(c.instrument as { call: SafeCallish }))
    })
  })
}

/** `InstrumentService.call` → `SkillContext.safeCall`，**中间没有任何转译**。 */
function skillCtx(inst: { call: SafeCallish }): { ctx: SkillContext; calls: string[] } {
  const calls: string[] = []
  const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
    calls.push(m)
    return inst.call(m, a)
  }
  const S0 = emptyHardwareState('stmsim')
  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    runSkill: (n: string) => Promise.resolve({ success: false, error: `本夹具不分发子技能：${n}` }),
    now: () => Date.now() / 1000,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'integration',
    rootCallId: 'clean-spot',
    approvalSource: 'operator',
  } as unknown as SkillContext
  return { ctx, calls }
}

describe('FindCleanSpot ↔ 真 stmsim', () => {
  it('压电量程**真的读到了** —— `piezo_range_source` 不是 `config`', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx, calls } = await instrument()
    const r = await FindCleanSpot.execute(ctx, { count: 4 })
    expect(r.success).toBe(true)
    const d = r.data as Record<string, unknown>
    // 这一条就是整格的judgement：形状假设错了，它会**沉默地**变成 `config`。
    expect(d['piezo_range_source']).not.toBe(PIEZO_SRC_CONFIG)
    // 而半程必须是一个像样的正数（模拟器的压电行程是亚微米到微米量级）。
    const half = d['piezo_half_range_m'] as number
    expect(Number.isFinite(half)).toBe(true)
    expect(half).toBeGreaterThan(1e-8)
    expect(half).toBeLessThan(1e-3)
    // 两次调用，顺序固定：先读针尖，再问量程。
    expect(calls).toEqual(['FolMe_XYPosGet', 'Piezo_RangeGet'])
  })

  it('针尖位置**真的读到了** —— 原点来自 `live_tip`，而且落点排得出来', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx } = await instrument()
    const r = await FindCleanSpot.execute(ctx, { count: 5 })
    const d = r.data as Record<string, unknown>
    expect(d['origin_source']).toBe('live_tip')
    expect(Number.isFinite(d['origin_x_m'] as number)).toBe(true)
    expect(Number.isFinite(d['origin_y_m'] as number)).toBe(true)
    const cands = d['candidates'] as { x_m: number; y_m: number; distance_m: number }[]
    expect(cands.length).toBeGreaterThan(0)
    // 由近到远，且**每一个都在可用区内**。
    const reach = d['effective_half_range_m'] as number
    for (let i = 1; i < cands.length; i += 1) {
      expect((cands[i] as { distance_m: number }).distance_m).toBeGreaterThanOrEqual(
        (cands[i - 1] as { distance_m: number }).distance_m,
      )
    }
    for (const c of cands) {
      expect(Math.abs(c.x_m)).toBeLessThanOrEqual(reach)
      expect(Math.abs(c.y_m)).toBeLessThanOrEqual(reach)
    }
  })

  it('宿主没接实验记录 ⇒ `map_known=false`，而报文**说出来**（不是装作干净）', async () => {
    processInstrumentProfile.source = () => ({})
    processExpMap.markerRows = null
    const { ctx } = await instrument()
    const r = await FindCleanSpot.execute(ctx, { count: 2 })
    const d = r.data as Record<string, unknown>
    expect(d['map_known']).toBe(false)
    expect(d['avoidance_sources']).toEqual([])
    expect(String(d['reason'])).toContain('读不到实验记录')
    expect(String(d['reason'])).toContain('无法确认此处是否干净')
  })

  it('真仪器 + 一份真地图 ⇒ 被记过的那一块**真的被躲开了**', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx } = await instrument()
    // 先问一次，拿到它本来会给的第一个落点。
    const first = (await FindCleanSpot.execute(ctx, { count: 1 })).data as Record<string, unknown>
    const x = first['x_m'] as number
    const y = first['y_m'] as number
    // 把那一点标成打过脉冲，再问一次 —— 它必须换一个地方。
    processExpMap.markerRows = () => [{ kind: 'pulse', x_m: x, y_m: y }]
    const { ctx: ctx2 } = await instrument()
    const second = (await FindCleanSpot.execute(ctx2, { count: 1 })).data as Record<string, unknown>
    expect(second['map_known']).toBe(true)
    expect(second['markers_seen']).toBe(1)
    expect([second['x_m'], second['y_m']]).not.toEqual([x, y])
  })
})
