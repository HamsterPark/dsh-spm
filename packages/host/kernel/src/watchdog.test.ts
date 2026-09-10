/**
 * 看门狗对金样。金样由**真 Python `SafetyWatchdog.run()`** 跑出来
 * （`tools/spec-export/export_watchdog_trace.py` 把它的 `time` 换成假时钟）。
 *
 * 这里重放同一批脚本：喂同样的读数序列，比**开火的 tick 号**与**闩的状态**。
 * 比 tick 号而不是比「有没有开火」，是因为这条网的六个状态互相纠缠——
 * 窗口清空、冷却、人工判定过期，全都表现为「晚几个 tick 才开火」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ThresholdLadder, TipWatchdog } from './watchdog.js'

interface Golden {
  constants: {
    interval_s: number
    window_size: number
    window_seconds: number
    retrigger_cooldown_s: number
    human_rail_override_s: number
    shipped_saturation_threshold_a: number
  }
  trace: Record<
    string,
    { ticks: number; fired: { tick: number; t: number }[]; latched: boolean; effective_threshold_a: number | null }
  >
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/watchdog.json', import.meta.url)), 'utf8'),
) as Golden

const C = golden.constants
const INTERVAL_MS = C.interval_s * 1000
const RAIL = 1.0e-8 // 2026-08-10 真机上的贴轨值就是 1.0003678774239688e-8
const OK = 1.0e-10
const THRESH = 5.0e-9

/** 与导出脚本里的 SCRIPTS 一一对应。只重复**输入**，期望值全部来自金样。 */
type Reading = number | null | 'garbage'
interface Script {
  readings: Reading[]
  threshold?: number | 'raise' | (number | 'raise')[]
  suppress?: string[]
  idle?: number | 'absent'
  confirmed?: boolean
  maxTicks?: number
}
const rep = <T,>(v: T, n: number): T[] => Array.from({ length: n }, () => v)

const SCRIPTS: Record<string, Script> = {
  seven_high_one_low: { readings: [...rep<Reading>(RAIL, 7), OK, ...rep<Reading>(OK, 4)] },
  eight_high_fires: { readings: rep<Reading>(RAIL, 12) },
  read_failure_preserves_window: {
    readings: [...rep<Reading>(RAIL, 4), null, ...rep<Reading>(RAIL, 8)],
  },
  garbage_reply_preserves_window: {
    readings: [...rep<Reading>(RAIL, 4), 'garbage', ...rep<Reading>(RAIL, 8)],
  },
  suppression_clears_window: {
    readings: rep<Reading>(RAIL, 20),
    suppress: [...rep('', 6), ...rep('TipShapeWithReadback', 3), ...rep('', 11)],
  },
  threshold_getter_raises: { readings: rep<Reading>(RAIL, 12), threshold: 'raise' },
  threshold_degrades_to_last_good: {
    readings: rep<Reading>(RAIL, 12),
    threshold: [...rep<number | 'raise'>(THRESH, 3), ...rep<number | 'raise'>('raise', 9)],
  },
  unconfirmed_retract_retries: { readings: rep<Reading>(RAIL, 80), confirmed: false, maxTicks: 80 },
  confirmed_retract_latches: { readings: rep<Reading>(RAIL, 40), confirmed: true, maxTicks: 40 },
  human_operating_suppresses: { readings: rep<Reading>(RAIL, 12), idle: 99.0 },
  human_override_expires: { readings: rep<Reading>(RAIL, 60), idle: 99.0, maxTicks: 60 },
  absent_idle_getter_still_arms: { readings: rep<Reading>(RAIL, 12), idle: 'absent' },
}

interface RunResult {
  fired: number[]
  latched: boolean
}

function runScript(s: Script): RunResult {
  const maxTicks = s.maxTicks ?? s.readings.length
  let now = 0
  const w = new TipWatchdog({
    windowSize: C.window_size,
    intervalMs: INTERVAL_MS,
    retriggerCooldownMs: C.retrigger_cooldown_s * 1000,
    humanRailOverrideMs: C.human_rail_override_s * 1000,
    clock: () => now,
  })
  const ladder = new ThresholdLadder({ shipped: C.shipped_saturation_threshold_a })
  const fired: number[] = []

  for (let tick = 0; tick < maxTicks; tick++) {
    const at = (arr: readonly unknown[] | undefined): unknown =>
      arr === undefined ? undefined : arr[Math.min(tick, arr.length - 1)]

    // 阈值：常量 / 'raise' / 逐 tick 表
    const spec = Array.isArray(s.threshold) ? (at(s.threshold) as number | 'raise') : s.threshold
    const read =
      spec === undefined
        ? (): number => THRESH
        : spec === 'raise'
          ? (): number => {
              throw new Error('读不到 cm_sat_current_a')
            }
          : (): number => spec
    const threshold = ladder.resolve(read).value

    const r = s.readings[Math.min(tick, s.readings.length - 1)] ?? null
    const current = r === null || r === 'garbage' ? null : r

    // MAST 在驱动吗：idle 缺席 ⇒ undefined（视为 true）；否则 idle < 窗口时长才算在驱动
    const mastDriving =
      s.idle === undefined || s.idle === 'absent' ? undefined : s.idle * 1000 < w.windowMs

    const out = w.tick({
      current,
      threshold,
      suppressedBy: at(s.suppress) as string | undefined,
      mastDriving,
    })
    if (out.kind === 'fire') {
      fired.push(tick)
      w.confirmRetract(s.confirmed ?? true)
    }
    now += INTERVAL_MS
  }
  return { fired, latched: w.latched }
}

describe('金样：看门狗的判定行为', () => {
  it('常量与 Python 一致：8 × 0.5 s = 连续 4 秒', () => {
    expect(C.window_size).toBe(8)
    expect(C.interval_s).toBe(0.5)
    expect(C.window_seconds).toBe(4)
    const w = new TipWatchdog()
    expect(w.windowMs).toBe(4000)
  })

  for (const [name, s] of Object.entries(SCRIPTS)) {
    it(name, () => {
      const g = golden.trace[name]
      expect(g, `金样里没有脚本 ${name}`).toBeDefined()
      const r = runScript(s)
      expect(r.fired, '开火的 tick 号').toEqual(g!.fired.map((f) => f.tick))
      expect(r.latched, '闩的状态').toBe(g!.latched)
    })
  }
})

describe('2026-08-10 的复现：它武装着，但打不着火', () => {
  it('阈值退到出厂默认时，10 nA 的轨在 90 nA 的阈值下一次都不开火', () => {
    const g = golden.trace['threshold_getter_raises']!
    // 金样里 fired 是空的，而 effective_threshold 是出厂默认——这不是「没武装」，
    // 是「武装着的那个数不是这台机器的数」。事故的本体就是这一格。
    expect(g.fired).toHaveLength(0)
    expect(g.effective_threshold_a).toBe(C.shipped_saturation_threshold_a)
    expect(C.shipped_saturation_threshold_a).toBeGreaterThan(RAIL) // 90 nA > 10 nA
  })

  it('阈值阶梯的五级，每一次降级都报得出是哪一级', () => {
    const ladder = new ThresholdLadder({ shipped: 9e-8 })
    const boom = (): number => {
      throw new Error('读不到')
    }
    expect(ladder.resolve(() => 5e-9)).toEqual({ value: 5e-9, level: 'live', changed: false })
    // 第一次降级：有历史好值 ⇒ 用它，并且**这一次要说话**
    expect(ladder.resolve(boom)).toEqual({ value: 5e-9, level: 'last-good', changed: true })
    // 继续降级：不再刷屏
    expect(ladder.resolve(boom)).toEqual({ value: 5e-9, level: 'last-good', changed: false })
    // 恢复：也要说一句
    expect(ladder.resolve(() => 6e-9)).toEqual({ value: 6e-9, level: 'live', changed: true })

    // 从没读到过活值 ⇒ 出厂默认
    const cold = new ThresholdLadder({ shipped: 9e-8 })
    expect(cold.resolve(boom)).toEqual({ value: 9e-8, level: 'shipped', changed: true })

    // 连出厂默认都没有 ⇒ 本 tick 不判（不是静默失效，下 tick 还会试）
    const nothing = new ThresholdLadder()
    expect(nothing.resolve(boom)).toEqual({ value: null, level: 'none', changed: true })
  })

  it('固定值只给测试用，且不参与降级', () => {
    const fixed = new ThresholdLadder({ fixed: 1e-9, shipped: 9e-8 })
    expect(fixed.resolve(undefined)).toEqual({ value: 1e-9, level: 'fixed', changed: false })
  })
})

describe('几条不靠金样也必须成立的', () => {
  it('读不到时窗口保留，不塞 0 占位', () => {
    const w = new TipWatchdog({ windowSize: 3, clock: () => 0 })
    for (let i = 0; i < 2; i++) w.tick({ current: 1e-8, threshold: 5e-9 })
    expect(w.tick({ current: null, threshold: 5e-9 }).kind).toBe('skipped')
    expect(w.readings).toEqual([1e-8, 1e-8]) // 没被 0 冲淡
    expect(w.tick({ current: 1e-8, threshold: 5e-9 }).kind).toBe('fire')
  })

  it('取绝对值：负电流一样算贴轨', () => {
    const w = new TipWatchdog({ windowSize: 2, clock: () => 0 })
    w.tick({ current: -1e-8, threshold: 5e-9 })
    expect(w.tick({ current: -1e-8, threshold: 5e-9 }).kind).toBe('fire')
  })

  it('阈值读不到那一 tick 不判，但窗口不清空', () => {
    const w = new TipWatchdog({ windowSize: 2, clock: () => 0 })
    w.tick({ current: 1e-8, threshold: 5e-9 })
    expect(w.tick({ current: 1e-8, threshold: null }).kind).toBe('no-threshold')
    expect(w.readings).toHaveLength(1)
    expect(w.tick({ current: 1e-8, threshold: 5e-9 }).kind).toBe('fire')
  })

  it('reset 之后重新武装', () => {
    const w = new TipWatchdog({ windowSize: 2, clock: () => 0 })
    w.tick({ current: 1e-8, threshold: 5e-9 })
    expect(w.tick({ current: 1e-8, threshold: 5e-9 }).kind).toBe('fire')
    w.confirmRetract(true)
    expect(w.latched).toBe(true)
    w.reset()
    expect(w.latched).toBe(false)
    w.tick({ current: 1e-8, threshold: 5e-9 })
    expect(w.tick({ current: 1e-8, threshold: 5e-9 }).kind).toBe('fire')
  })
})
