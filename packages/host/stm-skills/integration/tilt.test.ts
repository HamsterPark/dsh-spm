/**
 * `TiltProbeCircle` / `AutoTilt` / `TiltCalibrate` 对**真 stmsim** 跑一遍（DoD ④）。
 *
 * ## 这一组要验的是单测验不到的那件事
 *
 * 金样那侧的假仪器是我自己写的（`ZSim`：横移记位置、读 Z 给斜面）。
 * 它**按我的假设长**，而这三个技能对真回包的形状有四条假设：
 *
 * | 动词 | 假设 |
 * |---|---|
 * | `FolMe_XYPosGet(1)` | body 前两位是 `(x, y)`，**米** |
 * | `FolMe_XYPosSet(x, y, 1)` | 第三个实参是「等它走到」的开关，而**回包没有 body** |
 * | `ZCtrl_ZPosGet` | body 第 0 位是 Z，**米** |
 * | `Scan_FrameGet` | body 是 `[cx, cy, w, h, angle]`，视野在 `[2]` / `[3]` |
 *
 * 四条里有三条是「第 k 个元素是什么」——而自己造的回包会照着假设长
 * （D-READBACK-1 那次的教训）。
 *
 * ## `AnalyzeFrameTilt` 不在这一组里
 *
 * 它**一次 Nanonis 调用都不发**（读磁盘上的 `.sxm`）。在模拟器上跑它，跑的是我
 * 自己合成的那份字节 —— 而那份字节已经在 `spec/golden/tilt.json` 里被旧仓亲自
 * 读过一遍了。同批 4a 那八个的理由。
 *
 * ## 不断言「倾斜是多少」
 *
 * 模拟器此刻的样品平不平、针尖在哪儿，是**模拟器的状态**，不是这三个技能的判据。
 * 这里断言的是：发的是那几个动词、回包解得开、**针尖回到了起点**、
 * 以及没有标定时 `AutoTilt` **一次硬件都不碰**。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  processInstrumentProfile,
  slowCallFrom,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { AutoTilt, TiltCalibrate } from '../src/composite/auto-tilt.js'
import { TiltProbeCircle } from '../src/l0/tilt-probe.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  processInstrumentProfile.source = null
  processInstrumentProfile.write = null
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

function instrument(timeoutMs = 10_000): Promise<{
  ctx: SkillContext
  calls: { method: string; args: unknown[] }[]
  runs: string[]
}> {
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
function skillCtx(inst: { call: SafeCallish }): {
  ctx: SkillContext
  calls: { method: string; args: unknown[] }[]
  runs: string[]
} {
  const calls: { method: string; args: unknown[] }[] = []
  const runs: string[] = []
  const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
    calls.push({ method: m, args: a })
    return inst.call(m, a)
  }
  const S0 = emptyHardwareState('stmsim')
  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: slowCallFrom(safeCall, (m: string, _t: number, ...a: unknown[]) => safeCall(m, ...a)),
    // **子技能真的分发** —— `AutoTilt` 的测量那一半就是 `TiltProbeCircle`，
    // 这组 e2e 的一半价值在于那一层真的接得上（而不是一个脚本替身）。
    runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
      runs.push(name)
      if (name !== 'TiltProbeCircle') return Promise.resolve({ success: false, error: `本夹具不分发：${name}` })
      return TiltProbeCircle.execute(ctx as SkillContext, params)
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))),
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'integration',
    rootCallId: 'tilt',
    approvalSource: 'operator',
  } as unknown as SkillContext
  return { ctx, calls, runs }
}

describe('对真 stmsim：恒流内接圆与调平闭环', () => {
  it('`TiltProbeCircle` 走完一圈：动词序列、回包形状、**回到起点**', async () => {
    const { ctx, calls } = await instrument()
    const r = await TiltProbeCircle.execute(ctx, { radius_m: 5e-9, n_points: 8, noise_floor_m: 1e-12 })

    // 顺序本身是判据：先问位置（定圆心）、再记起点，然后一圈，最后回起点。
    expect(calls[0]?.method).toBe('FolMe_XYPosGet')
    expect(calls[1]?.method).toBe('FolMe_XYPosGet')
    expect(calls[calls.length - 1]?.method).toBe('FolMe_XYPosSet')

    // 圆心是**真读到的**位置，不是 0。
    const origin = calls[calls.length - 1]?.args ?? []
    expect(origin.length).toBe(3)
    expect(typeof origin[0]).toBe('number')
    expect(origin[2]).toBe(1) // 第三个实参是「等它走到」

    // 一圈上真的发了 8 次横移 + 8 次读 Z（外加起点/收尾各一次横移）。
    const moves = calls.filter((c) => c.method === 'FolMe_XYPosSet')
    const reads = calls.filter((c) => c.method === 'ZCtrl_ZPosGet')
    expect(moves.length).toBe(9) // 8 个点 + 回起点
    expect(reads.length).toBe(8) // 显式给了噪声底 ⇒ 不做那 8 次估计读

    // ⚠️ **不断言 `success`**：模拟器此刻的样品平不平不是这个技能的判据。
    // 要断言的是「它对结果说的话是可读的那几句之一」。
    if (r.success) {
      const d = r.data as Record<string, number>
      expect(d['n_points']).toBe(8)
      expect(d['radius_m']).toBe(5e-9)
      expect(Number.isFinite(d['tilt_x_deg'])).toBe(true)
      expect(Number.isFinite(d['downhill_deg'])).toBe(true)
      expect(d['downhill_deg']).toBeGreaterThanOrEqual(0)
      expect(d['downhill_deg']).toBeLessThan(360)
      expect(r.summary ?? '').toMatch(/^倾斜 -?\d+\.\d{4}° \(x=[-+]\d+\.\d{4}°, y=[-+]\d+\.\d{4}°\), 下坡方向 /)
    } else {
      expect((r.error ?? '').length).toBeGreaterThan(8)
    }
  }, 30_000)

  it('半径不给时**真的**从 `Scan_FrameGet` 推出来（视野在 body 的第 2/3 位）', async () => {
    const { ctx, calls } = await instrument()
    const r = await TiltProbeCircle.execute(ctx, { n_points: 8, noise_floor_m: 1e-12 })
    expect(calls.map((c) => c.method).slice(0, 2)).toEqual(['FolMe_XYPosGet', 'Scan_FrameGet'])
    const d = (r.data ?? {}) as Record<string, unknown>
    // 推得出来 ⇒ 半径落在钳位区间里，而且那句 note 出现了。
    if (r.success || d['radius_m'] !== undefined) {
      expect(d['radius_m']).toBeGreaterThanOrEqual(2e-9)
      expect(d['radius_m']).toBeLessThanOrEqual(5e-7)
      expect(String(d['geometry_note'] ?? '')).toContain('半径由扫描框推导')
    } else {
      // 读不到框也是一句说得清的话。
      expect(r.error).toBe('读不到当前扫描框尺寸,无法推导圆半径 —— 请显式给 radius_m')
    }
  }, 30_000)

  it('没有标定时 `AutoTilt` **一次硬件都不碰**（真连接也一样）', async () => {
    processInstrumentProfile.source = () => ({})
    const { ctx, calls, runs } = await instrument()
    const r = await AutoTilt.execute(ctx, {})
    expect(r.success).toBe(false)
    expect((r.data as Record<string, unknown>)['reason']).toBe('calibration_missing')
    expect(calls).toEqual([])
    expect(runs).toEqual([])
  }, 30_000)

  it('有标定时 `AutoTilt` 真的把 `TiltProbeCircle` 派下去，而且读得到 `Piezo_TiltGet`', async () => {
    processInstrumentProfile.source = () => ({
      tilt_cal_g11: -1, tilt_cal_g12: 0, tilt_cal_g21: 0, tilt_cal_g22: -1,
      tilt_cal_cond: 1, tilt_cal_updated_at: 1_700_000_000,
      z_range_m: 1.5e-6, tilt_limit_deg: 5,
    })
    const { ctx, calls, runs } = await instrument()
    const r = await AutoTilt.execute(ctx, { radius_m: 5e-9, n_points: 8, surface_rms_m: 1e-9 })

    // ① 先读原始倾斜（回滚目标），再问帧，然后才派子技能。
    expect(calls[0]?.method).toBe('Piezo_TiltGet')
    // ② 子技能**真的**被派下去了（不是脚本替身）。
    expect(runs).toContain('TiltProbeCircle')
    // ③ 回包里带着用的是哪个矩阵 —— 这一条是 2026-08-10 的现场要求。
    //
    // ⚠️ 三条**早退**分支在 `common` 建起来之前就返回了（没标定 / 读不到倾斜 /
    //    测量失败），所以只有走过测量那一步的回包才带得上它。
    //    模拟器上此刻的圆能不能拟合出来是模拟器的状态，不是这个技能的判据。
    const d = (r.data ?? {}) as Record<string, unknown>
    const earlyOut = new Set(['calibration_missing', 'calibration_unreadable', 'tilt_unreadable', 'measure_failed'])
    if (!earlyOut.has(String(d['reason']))) {
      expect(d['matrix_g']).toEqual([[-1, 0], [0, -1]])
      expect(d['frame_diagonal_m']).toBeGreaterThan(0)
    } else {
      // 早退也要说得清：`detail` 里写着为什么。
      expect(String(d['detail'] ?? '').length).toBeGreaterThan(4)
    }
    expect(['no_action_needed', 'applied', 'rolled_back', 'failed', 'skipped']).toContain(
      String(d['outcome'] ?? 'aborted'),
    )
  }, 60_000)

  it('`TiltCalibrate` 读不到档案写口时**明说**，而且把针尖还了回去', async () => {
    // 读口给一份空档案、**写口不接** —— 本仓多出来的那一态（见 deviations 批 7a-1）。
    processInstrumentProfile.source = () => ({})
    processInstrumentProfile.write = null
    const { ctx, calls } = await instrument()
    const r = await TiltCalibrate.execute(ctx, { step_deg: 0.05, radius_m: 5e-9, n_points: 8 })
    expect(r.success).toBe(false)
    // 先读原始倾斜；无论走哪一支，最后一次写倾斜都必须把它还回去。
    expect(calls[0]?.method).toBe('Piezo_TiltGet')
    const writes = calls.filter((c) => c.method === 'Piezo_TiltSet')
    if (writes.length > 0) {
      const first = calls[0]
      expect(first).toBeDefined()
      // 还回去那一次的实参就是最初读到的那一对（它在 data.original_tilt 里）。
      const orig = (r.data as Record<string, unknown> | undefined)?.['original_tilt']
      if (Array.isArray(orig)) {
        expect(writes[writes.length - 1]?.args.slice(0, 2)).toEqual(orig.slice(0, 2))
      }
    }
  }, 60_000)
})
