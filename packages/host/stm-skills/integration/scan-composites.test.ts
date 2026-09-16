/**
 * `ScanAt` / `FullScan` 对**真 stmsim** 跑一遍（DoD ④）。
 *
 * 这是本仓第一条「**组合技能** ↔ 真仪器」的缝。前面四个组合把「相」当步骤跑
 * （`_phase_*` 是本地分发键），这两个是第一批真的把**子技能**排进计划的 ——
 * 于是整条链第一次被端到端走通：
 *
 * ```
 * ScanAt → GraphExecutor → ctx.runSkill → ConfigureScan/SetScanBuffer/StartScan/WaitScanComplete
 *        → ctx.safeCall → InstrumentService.call → 真 stmsim
 * ```
 *
 * ## 它验的是单测与金样都验不到的两件事
 *
 * 1. **子技能之间的接缝在真回包上对得上。** `resolveScan` 算出来的
 *    `configure_scan` 字典是直接喂给 `ConfigureScan` 的 —— 而 `ConfigureScan` 会把
 *    写下去的框**读回来比**（D-READBACK-1）。桩上的回声永远精确，仪器按 float32
 *    打包；两边只有在真机上才第一次真的比过一次。
 * 2. **`WaitScanComplete` 真的会回来。** 它的结局判据（扫完 / 超时 / 中途停）在金样里
 *    是合成回包驱动的；这里是一台真的在推进行数的扫描仪。
 *
 * ## 为什么参数是「小而快」的那一组
 *
 * 出厂档位表在 100 nm 上给的是 256 px × 1.0 s/线 × 双向 ≈ **8.5 分钟**（sim 时钟
 * 20× 之下也要 25 s 墙钟）。这里显式点名 `pixels` / `line_time_s` 把它压到秒级 ——
 * **而这恰好也验了一条判据**：显式值走的是 `explicit` 那一支，`trace` 要说它是
 * 「用户显式指定」，而不是档位表。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`），
 * 所以这里 `spawn: false`。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  getTipCrashTracker,
  processTipCrash,
  resetTipCrashTracker,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  processTipCrash.tracker = null
  processTipCrash.config = {}
})

/**
 * ⚠️ **整组 `integration` 共用一台模拟器**（globalSetup 起的那一台），
 * 而这是第一批**会改仪器全局状态**的集成测试：`ConfigureScan` 会写帧几何与
 * **采集通道清单**，`SetScanBuffer` 会写分辨率。
 *
 * 落地当天就被它咬了一次：默认通道 `"Z,Current"` 让缓冲从 `[0, 14]` 变成
 * `[14, 0]`、分辨率从 256 变成 16，于是 `analysis.test.ts`（批 4a，只读）在**单独跑
 * 时全绿、整组跑时红**。那种红最难查 —— 它说的是「通道 126 不在缓冲里」，
 * 指向一个跟它自己完全无关的地方。
 *
 * 所以这一组自己**存档 + 还原**。同 `applyApproachPreset` 的 `finally`：
 * 「这个状态是不是我改的」是判据，改了就要放回去。
 */
let saved: { channels: number[]; pixels: number; lines: number; frame: number[] } | null = null

beforeAll(async () => {
  const rig = await instrument()
  cleanup.splice(0).forEach((fn) => fn())
  const buf = await rig.ctx().safeCall('Scan_BufferGet')
  const frm = await rig.ctx().safeCall('Scan_FrameGet')
  const v = (buf.values ?? []) as unknown[]
  saved = {
    channels: (v[1] as number[]) ?? [],
    pixels: Number(v[2] ?? 256),
    lines: Number(v[3] ?? 256),
    frame: ((frm.values ?? []) as number[]).map(Number),
  }
}, 60_000)

afterAll(async () => {
  if (saved === null) return
  const rig = await instrument()
  const ctx = rig.ctx()
  await ctx.safeCall('Scan_BufferSet', saved.channels, saved.pixels, saved.lines)
  if (saved.frame.length === 5) {
    await ctx.safeCall('Scan_FrameSet', ...saved.frame)
  }
  cleanup.splice(0).forEach((fn) => fn())
}, 60_000)

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

function instrument(timeoutMs = 10_000): Promise<Rig> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      resolve(new Rig(c.instrument as { call: SafeCallish }))
    })
  })
}

/**
 * `InstrumentService.call` → `SkillContext`，**中间没有任何转译**。
 *
 * 与前几条集成测试唯一的不同：`runSkill` 这里**真的分发**（去 `IMPLEMENTED` 里取），
 * 因为组合技能的全部内容就是它。深度不加 —— 本夹具不过内核（内核的闸门在
 * `runsub.test.ts` 里单独验），这条缝要的是**仪器那一侧**。
 */
class Rig {
  readonly calls: string[] = []
  readonly subs: string[] = []
  readonly #inst: { call: SafeCallish }

  constructor(inst: { call: SafeCallish }) {
    this.#inst = inst
  }

  ctx(): SkillContext {
    const S0 = emptyHardwareState('stmsim')
    const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      this.calls.push(m)
      return this.#inst.call(m, a)
    }
    const ctx = {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.subs.push(name)
        const skill = IMPLEMENTED[name]
        if (skill === undefined) {
          return Promise.resolve({ success: false, error: `注册表里没有 ${name}` })
        }
        return skill.execute(ctx, params)
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'integration',
      rootCallId: 'scan-composites',
      approvalSource: 'operator',
    } as unknown as SkillContext
    return ctx
  }
}

/** 秒级的一帧：16 px × 0.05 s/线 × 双向 = 1.6 s sim 时间。 */
const FAST = { pixels: 16, line_time_s: 0.05 }

describe('ScanAt 对真 stmsim', () => {
  it('一次调用走完「配置 → 分辨率 → 起扫 → 等完成」，四个子技能全过', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['ScanAt']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      size_m: 50e-9,
      ...FAST,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    // 计划的**顺序**本身是判据：分辨率必须排在 ConfigureScan 之后
    expect(rig.subs).toEqual(['ConfigureScan', 'SetScanBuffer', 'StartScan', 'WaitScanComplete'])
    // 一次真扫描，而且是真的扫完的 —— 不是超时也不是被停下
    expect(res.data?.['wait_timed_out']).toBe(false)
    expect(res.data?.['wait_stopped_early']).toBe(false)
    // 调用记录里不该有任何一条错
    expect(rig.calls.length).toBeGreaterThan(4)
  }, 120_000)

  it('显式点名的值在 `trace` 里标「用户显式」，档位表来的标档名', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['ScanAt']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      size_m: 50e-9,
      ...FAST,
    })
    const trace = res.data?.['param_trace'] as Record<string, { source: string; tier: string | null }>
    expect(trace['pixels']?.source).toBe('explicit')
    expect(trace['line_time_s']?.source).toBe('explicit')
    // 没点名的那些仍然由策略层管：通道是内建默认，工作点保持硬件现值
    expect(trace['channels']?.source).toBe('default')
    expect(trace['bias_v']?.source).toBe('keep-current')
    // 50 nm 落 `highres`（上界 100 nm，**闭上界**从小到大取第一个够得着的档）
    expect(res.data?.['tier_name']).toBe('highres')
    expect(trace['pixels']?.tier).toBeNull() // 显式值不挂档名
  }, 120_000)

  it('分辨率真的写进去了 —— `SetScanBuffer` 自己回读确认', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['ScanAt']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      size_m: 50e-9,
      ...FAST,
    })
    // `resolution_verified` 是子技能读回来比出来的，不是我们写下去那个数的回声
    expect(res.data?.['resolution_verified']).toBe(true)
    expect(res.data?.['pixels']).toBe(16)
  }, 120_000)

  it('尺寸非法 ⇒ **一次 TCP 都不发**就拒（单测里「没发」和「发不出去」长得一样）', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['ScanAt']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      size_m: 0,
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('不替用户发明尺寸')
    expect(rig.calls).toEqual([])
    expect(rig.subs).toEqual([])
  }, 60_000)
})

describe('FullScan 对真 stmsim', () => {
  /**
   * ⚠️ **本机实测把旧仓那句注释推翻了一半。**
   *
   * 旧仓写着「Z-controller 的信号号随装机而变（标准模拟器上是 **30**，不是 14）」，
   * 而本机 stmsim 上 `Signals_NamesGet` 的第 **14** 项正是 `Z (m)`，
   * `Scan_BufferGet` 也确实回 `[2, [0, 14], 256, 256]`（**裸整数**，不是那串 1-元组）。
   *
   * 也就是说：在这台机器上，那张写死的兜底探针表**碰巧是对的** —— 于是
   * 「探的是真正采到的那几路」这件事，用默认通道跑一趟**证不出来**：两条路给的
   * 答案一样。要证它，得让采集清单与 `[0, 14]` **不一样**。
   */
  it('扫完之后探的是真机上**真正采到的**那几路（换一份通道清单来证）', async () => {
    resetTipCrashTracker()
    const rig = await instrument()
    const res = await IMPLEMENTED['FullScan']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      width_m: 50e-9,
      height_m: 50e-9,
      line_time_s: 0.05,
      wait_timeout_s: 60,
      channels: 'Z',
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    // 只采一路 ⇒ 只探一路。静态兜底表会给两路（`ch0` + `ch14`），所以这一条
    // 分得开「问了仪器」与「用了那张写死的表」—— 2026-06-29 那个缺陷的判据。
    expect(res.data?.['crash_check_channels']).toEqual({ ch14: 'ok' })
    expect(res.data?.['crash_check']).toBe('ok')
  }, 180_000)

  it('默认通道下两路都探到，而且都有信号', async () => {
    resetTipCrashTracker()
    const rig = await instrument()
    const res = await IMPLEMENTED['FullScan']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      width_m: 50e-9,
      height_m: 50e-9,
      line_time_s: 0.05,
      wait_timeout_s: 60,
    })
    expect(res.success).toBe(true)
    // 本机上 `Signals_NamesGet[0] = 'Current (A)'`、`[14] = 'Z (m)'`
    expect(res.data?.['crash_check_channels']).toEqual({ ch0: 'ok', ch14: 'ok' })
    expect(res.data?.['crash_check']).toBe('ok')
  }, 180_000)

  it('一趟干净的扫描把这个点的撞针旧账清掉', async () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    const rig = await instrument()
    const res = await IMPLEMENTED['FullScan']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      width_m: 50e-9,
      height_m: 50e-9,
      line_time_s: 0.05,
      wait_timeout_s: 60,
    })
    expect(res.success).toBe(true)
    expect(getTipCrashTracker().crashCount(0, 0)).toBe(0)
  }, 180_000)

  it('区域封了 ⇒ **一次 TCP 都不发**就拒', async () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    getTipCrashTracker().recordCrash(0, 0)
    const rig = await instrument()
    const res = await IMPLEMENTED['FullScan']!.execute(rig.ctx(), {
      center_x_m: 0,
      center_y_m: 0,
      width_m: 50e-9,
      height_m: 50e-9,
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('repeated_crash_escape_required')
    expect(rig.calls).toEqual([])
    expect(rig.subs).toEqual([])
  }, 60_000)
})
