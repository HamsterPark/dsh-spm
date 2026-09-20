/**
 * 批 7b-3 对**真 stmsim**（DoD ④）。
 *
 * 金样那一份（`spec/golden/batch7b3.json`）把**子技能的返回摆成了我要的样子**；
 * 这一份不摆 —— 五个组合技能的每一步都真的走到仪器上，再看它们说什么。
 *
 * ## 它验的是金样与单测都验不到的四件事
 *
 * 1. **`SaveScan` 的 `findLatestSxm` 注入真的找得到文件。**
 *    这是本批唯一改到的共享文件（`l0/scan.ts`），而它在桩上永远返回 `null`
 *    （会话目录不存在 ⇒ `existingDirs` 给空表）。只有真 stmsim 会
 *    **真的往会话目录里写一张 `.sxm`**。不接的话
 *    `AcquireBiasImagingSeries` 每一帧都落进「没拿到文件路径」。
 * 2. **`Scan_FrameDataGrab` 的真 body 解得开。**
 *    `TrackDrift_ReferenceScan` 的抓帧不是子技能，是一次裸动词 ——
 *    而合成回包的形状由我决定，真机的不由我决定（同 D-READBACK-1）。
 * 3. **子技能之间的接缝在真回包上对得上。** `GridSTS` 排的
 *    `ConfigureSTS` → `MoveToXY` → `AcquireSTS` 三件，在桩上都回 `{}`；
 *    真机上 `AcquireSTS` 要么给出一条谱，要么给出一句说得出口的拒绝。
 * 4. **还原顺序真的发下去了。** `MoveAtomTo` 的全部安全性在于
 *    「离开之前先把设定点升回成像值」，而那是一串真的写命令。
 *
 * 模拟器由 globalSetup 起在 16501–16504，所以这里 `spawn: false`。
 *
 * ## 这一组会改仪器全局状态，所以它**自己存档 + 还原**
 *
 * 与 `scan-composites.test.ts` 同一条（那边的注释记着被咬的那一次）：
 * `ConfigureScan` 写帧几何与采集通道、`SetBias` / `SetSetpoint` 写工作点。
 * 整组 `integration` 共用一台模拟器，不放回去会让**别的文件**莫名其妙地红。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
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
})

let saved: {
  channels: number[]
  pixels: number
  lines: number
  frame: number[]
  bias: number
  setpoint: number
  zctrlOn: number
  xy: number[]
} | null = null

beforeAll(async () => {
  const rig = await instrument()
  cleanup.splice(0).forEach((fn) => fn())
  const ctx = rig.ctx()
  const buf = await ctx.safeCall('Scan_BufferGet')
  const frm = await ctx.safeCall('Scan_FrameGet')
  const bias = await ctx.safeCall('Bias_Get')
  const sp = await ctx.safeCall('ZCtrl_SetpntGet')
  const zc = await ctx.safeCall('ZCtrl_OnOffGet')
  const xy = await ctx.safeCall('FolMe_XYPosGet', 1)
  const v = (buf.values ?? []) as unknown[]
  saved = {
    channels: (v[1] as number[]) ?? [],
    pixels: Number(v[2] ?? 256),
    lines: Number(v[3] ?? 256),
    frame: ((frm.values ?? []) as number[]).map(Number),
    bias: Number((bias.values ?? [1])[0] ?? 1),
    setpoint: Number((sp.values ?? [50e-12])[0] ?? 50e-12),
    // 反馈开关也存档。**不存就还原**是这一族整组共用一台仪器时最容易犯的错：
    // 我这一份要反馈开着才扫得了图，而下一个文件可能正指望它是关着的。
    zctrlOn: Number((zc.values ?? [1])[0] ?? 1),
    // 针尖**停在哪儿**也是全局状态：这一组会把它挪到扫描框中心、挪到
    // `MoveAtomTo` 的目标上、挪到栅格的四个点上。而模拟器的表面是有起伏的 ——
    // 下一个文件在**另一片地方**开工，它的电流对同一次偏压变化的响应就不一样。
    xy: ((xy.values ?? []) as unknown[]).map(Number).filter((n) => Number.isFinite(n)),
  }
}, 60_000)

afterAll(async () => {
  if (saved === null) return
  const rig = await instrument()
  const ctx = rig.ctx()
  await ctx.safeCall('Scan_BufferSet', saved.channels, saved.pixels, saved.lines)
  if (saved.frame.length === 5) await ctx.safeCall('Scan_FrameSet', ...saved.frame)
  await ctx.safeCall('Bias_Set', saved.bias)
  await ctx.safeCall('ZCtrl_SetpntSet', saved.setpoint)
  // ⚠️ **把设定点写回去不等于结已经凉下来了。** `MoveAtomTo` 那一格把设定点
  // 推到 20 nA，还原之后 Z 环要真的把针尖退回去 —— 而那需要模拟时间。
  // 等**条件**不等固定时长（同 7a 的 `instrument-watchdog`：
  // 机器越忙只会让条件等待更容易通过，而固定时长只会更容易不够）。
  //
  // 只在**反馈本来就开着**时等：关着的话 Z 环不动，这个条件永远等不到，
  // 而那时针尖已经缩回去了（电流本来就在 1e-14 量级）。
  if (saved.zctrlOn !== 0) {
    await settleCurrent(ctx, Math.max(Math.abs(saved.setpoint) * 2, 1e-12))
  }
  // 反馈开关**按存档还原** —— 不是一律打开。
  await ctx.safeCall('ZCtrl_OnOffSet', saved.zctrlOn)
  if (saved.xy.length >= 2) {
    await ctx.safeCall('FolMe_XYPosSet', saved.xy[0], saved.xy[1], 1)
  }
  cleanup.splice(0).forEach((fn) => fn())
}, 120_000)

/** 轮询到 `|I| <= bar`，或者用完预算。**超时不报错** —— 它是收尾，不是判据。 */
async function settleCurrent(ctx: SkillContext, bar: number, budgetMs = 30_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const rec = await ctx.safeCall('Current_Get')
    const v = Number(((rec.values ?? []) as unknown[])[0] ?? 0)
    if (Number.isFinite(v) && Math.abs(v) <= bar) return
    if (Date.now() - t0 > budgetMs) return
    await new Promise<void>((r) => setTimeout(r, 200))
  }
}

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

/** `InstrumentService.call` → `SkillContext`，**中间没有任何转译**（同批 4d）。 */
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
      // ⚠️ `SlowCall` 的形参是 **`(method, recvTimeoutS, ...args)`** —— 动词在前 ——
      // 而它回的是 `{ record, recvTimeoutS }`，不是裸的 `SkillCallRecord`。
      // 两处各写错一次，症状是同一句假话：`AcquireSTS` 先拿 `45.1`（预算秒数）
      // 当动词发出去，收到 `UnknownMethod: 协议表里没有 45.109…`，
      // 于是 `GridSTS` 报「All 4 spectra failed」—— 一句**关于模拟器**的假话。
      // 仓里另一处夹具（`scan-composites.test.ts`）也写着参数反了的那一版，
      // 只是它压的两个技能都不走 `slowCall`，所以一直没咬到人。见交接。
      slowCall: async (m: string, s: number, ...a: unknown[]) => ({
        record: await safeCall(m, ...a),
        recvTimeoutS: s,
      }),
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.subs.push(name)
        const skill = IMPLEMENTED[name]
        if (skill === undefined) return Promise.resolve({ success: false, error: `注册表里没有 ${name}` })
        return skill.execute(ctx, params)
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'integration',
      rootCallId: 'batch7b3',
      approvalSource: 'operator',
    } as unknown as SkillContext
    return ctx
  }
}

/** 秒级的一帧：16 px × 0.05 s/线 × 双向 = 1.6 s sim 时间。 */
const FAST_LINE_S = 0.05

// ──────────────────────────────────────────────────────────────────────────

describe('GridSTS 对真 stmsim', () => {
  it('2×2 栅格：一次 ConfigureSTS + 每点 MoveToXY/AcquireSTS，四条谱都是真采的', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['GridSTS']!.execute(rig.ctx(), {
      center_x_m: 0, center_y_m: 0, nx: 2, ny: 2, spacing_m: 5e-10,
      start_v: -0.3, end_v: 0.3, num_points: 20,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    // 计划的**形状**是判据：一次配置 + 每点两步，行优先。
    expect(rig.subs).toEqual([
      'ConfigureSTS',
      'MoveToXY', 'AcquireSTS', 'MoveToXY', 'AcquireSTS',
      'MoveToXY', 'AcquireSTS', 'MoveToXY', 'AcquireSTS',
    ])
    const d = res.data as Record<string, unknown>
    expect([d['total_points'], d['succeeded'], d['failed'], d['suspect']]).toEqual([4, 4, 0, 0])
    // `points` 的坐标由**与计划同一条公式**重建 —— 它不能与针尖去过的地方分岔。
    const pts = d['points'] as { x_m: number; y_m: number; success: boolean }[]
    expect(pts.map((p) => [p.x_m, p.y_m])).toEqual([
      [-2.5e-10, -2.5e-10], [2.5e-10, -2.5e-10], [-2.5e-10, 2.5e-10], [2.5e-10, 2.5e-10],
    ])
    expect(pts.every((p) => p.success)).toBe(true)
  }, 180_000)
})

describe('DemoScanAndSTS 对真 stmsim', () => {
  it('扫一张小图再采两条谱 —— 而「这一帧扫完了没有」是单独一个字段', async () => {
    const rig = await instrument()
    // 16 px 的缓冲要先设下去，否则出厂档位表会给 256 px（分钟级）。
    await rig.ctx().safeCall('Scan_BufferSet', [0, 14], 16, 16)
    const res = await IMPLEMENTED['DemoScanAndSTS']!.execute(rig.ctx(), {
      center_x_m: 0, center_y_m: 0, scan_size_m: 20e-9,
      line_time_s: FAST_LINE_S, sts_count: 2,
      sts_start_v: -0.3, sts_end_v: 0.3, sts_num_points: 20,
      scan_timeout_s: 120,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    // 真的扫完了 ⇒ `scan_completed` 为真、`scan_outcome` 是 `completed`。
    // 这两个字段与 `scan_saved` 是**三件不同的事**（一张截断的帧也存得下去）。
    expect(d['scan_completed']).toBe(true)
    expect(d['scan_outcome']).toBe('completed')
    expect([d['sts_total'], d['sts_succeeded'], d['sts_failed']]).toEqual([2, 2, 0])
    expect(rig.subs.slice(0, 6)).toEqual([
      'ConfigureScan', 'SetScanSpeed', 'StartScan', 'WaitScanComplete', 'SaveScan', 'ConfigureSTS',
    ])
  }, 300_000)
})

describe('SaveScan 的 findLatestSxm 注入 —— 只有真 stmsim 验得到', () => {
  it('扫一张存下来，`saved_path` 是会话目录里那张真的 `.sxm`', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('Scan_BufferSet', [0, 14], 16, 16)
    const scan = await IMPLEMENTED['ScanAt']!.execute(ctx, {
      center_x_m: 0, center_y_m: 0, size_m: 20e-9, pixels: 16, line_time_s: FAST_LINE_S,
    })
    expect(scan.success).toBe(true)
    const save = await IMPLEMENTED['SaveScan']!.execute(ctx, {})
    expect(save.success).toBe(true)
    const p = (save.data as Record<string, unknown>)['saved_path']
    // **这一条断言就是那一行注入的全部理由。** 注入之前它恒为 `null`，
    // 而 `AcquireBiasImagingSeries` 没有 `GetLatestScanFile` 兜底。
    expect(typeof p === 'string' && p.endsWith('.sxm')).toBe(true)
  }, 180_000)
})

describe('AcquireBiasImagingSeries 对真 stmsim', () => {
  it('两个偏压各扫一帧：偏压真的跟上了，两帧都拿到了落盘路径', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('Scan_BufferSet', [0, 14], 16, 16)
    const res = await IMPLEMENTED['AcquireBiasImagingSeries']!.execute(ctx, {
      biases_v: '0.2,-0.2',
      center_x_m: 0, center_y_m: 0, scan_size_m: 20e-9,
      line_time_s: FAST_LINE_S, settle_s: 0,
      repeat_first_at_end: false,
    })
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    expect(d['refused']).toBeNull()
    expect(d['bias_order']).toEqual([0.2, -0.2])
    const frames = d['frames'] as { ok: boolean; error?: string; path?: string }[]
    // 回读那道闸真的过了 —— 两帧都 `ok`，一句「偏压没跟上」都没有。
    expect(frames.map((f) => f.ok)).toEqual([true, true])
    expect(frames.every((f) => typeof f.path === 'string' && f.path.endsWith('.sxm'))).toBe(true)
    expect(d['n_ok']).toBe(2)
  }, 600_000)
})

describe('TrackDrift_ReferenceScan 对真 stmsim', () => {
  it('第一趟采参考：`Scan_FrameDataGrab` 的**真 body** 解得开，并落一个 .npy', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('Scan_BufferSet', [0, 14], 16, 16)
    const res = await IMPLEMENTED['TrackDrift_ReferenceScan']!.execute(ctx, {
      ref_x_m: 0, ref_y_m: 0, ref_width_m: 20e-9, bias_v: -0.5,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    const p = d['ref_image_path']
    // 抓帧走的是裸 `Scan_FrameDataGrab`（不是子技能），所以它出现在 `calls` 里、
    // 不在 `subs` 里。解不开真 body 的话这里是 `null` + 一次 abort。
    expect(rig.calls).toContain('Scan_FrameDataGrab')
    expect(typeof p === 'string' && p.endsWith('.npy')).toBe(true)
    expect(String(d['message'])).toContain('Call again with ref_image_path=')
    // 第一趟不算漂移。
    expect([d['drift_x_m'], d['drift_y_m'], d['compensated']]).toEqual([0, 0, false])
  }, 300_000)

  it('第二趟带上那张参考图：漂移算得出来，而且**不发第二次 ConfigureScan**（0 漂移）', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('Scan_BufferSet', [0, 14], 16, 16)
    const first = await IMPLEMENTED['TrackDrift_ReferenceScan']!.execute(ctx, {
      ref_x_m: 0, ref_y_m: 0, ref_width_m: 20e-9,
    })
    const refPath = (first.data as Record<string, unknown>)['ref_image_path'] as string
    const rig2 = await instrument()
    const res = await IMPLEMENTED['TrackDrift_ReferenceScan']!.execute(rig2.ctx(), {
      ref_x_m: 0, ref_y_m: 0, ref_width_m: 20e-9, ref_image_path: refPath,
    })
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    const dx = d['drift_x_m'] as number
    const dy = d['drift_y_m'] as number
    // ⚠️ **不断言漂移是 0。** 20 nm / 16 px 的 Au(111) 在这台模拟器上几乎是平的，
    // 减掉均值之后互相关由噪声主导 —— `argmax` 落在哪一格是这一次的噪声说了算。
    // 「同一片地方 ⇒ 峰在中心」在一张有结构的图上成立，在一张平图上不成立，
    // 而**要求它成立等于把一次掷骰子写成判据**。
    //
    // 这里验的是**形状**（真回包上才验得到的那几件）：
    //   ① 漂移是像素尺寸的整数倍 —— 它由 `(峰下标 − 中心) × (宽 / 列数)` 得来；
    //   ② 显著性闸与补偿那一步**互为充要**；
    //   ③ 计划本身。
    const px = 20e-9 / 16
    expect(Math.abs(dx / px - Math.round(dx / px))).toBeLessThan(1e-9)
    expect(Math.abs(dy / px - Math.round(dy / px))).toBeLessThan(1e-9)
    const significant = Math.abs(dx) > 1e-12 || Math.abs(dy) > 1e-12
    // ⚠️ `subs` 里**嵌着 `FullScan` 自己派的那四步**（同一个 `runSkill` 分发口），
    // 所以不比整张表 —— 比**头两步**，以及执行器自己数的**顶层步数**：
    // 补偿排了就是 3 步，没排就是 2 步。它在不在，就是显著性闸的答案。
    expect(rig2.subs.slice(0, 2)).toEqual(['SetBias', 'FullScan'])
    const prog = d['_progress'] as { total_steps: number; completed_steps: string[] }
    expect(prog.total_steps).toBe(significant ? 3 : 2)
    expect(prog.completed_steps.includes('apply_compensation')).toBe(significant)
    expect(d['compensated']).toBe(significant)
  }, 600_000)
})

describe('MoveAtomTo 对真 stmsim', () => {
  it('不复扫的一趟：还原**排在拖拽之后、且设定点在偏压之前**，命令真的发下去了', async () => {
    const rig = await instrument()
    const res = await IMPLEMENTED['MoveAtomTo']!.execute(rig.ctx(), {
      atom_x_m: 0, atom_y_m: 0, target_x_m: 3e-10, target_y_m: 0,
      manip_setpoint_a: 20e-9, manip_bias_v: 0.02, verify: false,
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    // `verify: false` ⇒ `moved` 是 **null**（不是 false）：「已搬运，未复扫确认」。
    expect(d['moved']).toBeNull()
    expect(d['instrument_restored']).toBe(true)
    expect(res.summary).toBe('已搬运,未复扫确认')
    // **顺序就是安全本身。** 这台模拟器的满量程是 10 nA（实测），而操纵设定点
    // 是 20 nA ⇒ 量程被放宽了一档 ⇒ 还原里多一个 `SetCurrentGain`。
    // 所以不数「最后三个」，而是钉**那条不许颠倒的顺序**：
    // 拖拽结束 → 设定点升回去 → 偏压 → 其余。
    const lastDrag = rig.subs.lastIndexOf('MoveToXY')
    const restoreSp = rig.subs.lastIndexOf('SetSetpoint')
    const restoreBias = rig.subs.lastIndexOf('SetBias')
    expect(lastDrag).toBeGreaterThan(0)
    expect(restoreSp).toBeGreaterThan(lastDrag)
    expect(restoreBias).toBeGreaterThan(restoreSp)
    // 量程真的被放宽又放回去了（两次 `SetCurrentGain`，后一次在还原段里）。
    expect(rig.subs.filter((s) => s === 'SetCurrentGain').length).toBe(2)
    expect(rig.subs.lastIndexOf('SetCurrentGain')).toBeGreaterThan(restoreBias)
    // 结电阻只有在**两个操纵条件都显式给**的时候才算得出来（|V| / I）。
    expect(d['junction_resistance_ohm']).toBeCloseTo(0.02 / 20e-9, 6)
  }, 300_000)
})

describe('两个 paper 纯函数吃**真 stmsim 存出来的 .sxm**', () => {
  it('同一片地方扫两张 → DiffScans 报出一个小残差，并落一张 diff .npy', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('Scan_BufferSet', [0, 14], 16, 16)
    const paths: string[] = []
    for (let k = 0; k < 2; k += 1) {
      const scan = await IMPLEMENTED['ScanAt']!.execute(ctx, {
        center_x_m: 0, center_y_m: 0, size_m: 20e-9, pixels: 16, line_time_s: FAST_LINE_S,
      })
      expect(scan.success).toBe(true)
      const save = await IMPLEMENTED['SaveScan']!.execute(ctx, {})
      const p = (save.data as Record<string, unknown>)['saved_path']
      expect(typeof p).toBe('string')
      paths.push(p as string)
    }
    // 两张 `.sxm` 可能是同一个文件名（模拟器按序号命名）——那也没关系：
    // 这一条验的是**真 `.sxm` 字节走得通 `loadImage2d` → `driftXcorr` → `.npy`**。
    const res = await IMPLEMENTED['DiffScans_ChangeDetect']!.execute({} as SkillContext, {
      scan_a_path: paths[0], scan_b_path: paths[1],
    })
    expect(res.error ?? '').toBe('')
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    expect(d['overlap_shape']).toEqual([16, 16])
    expect(typeof d['output_path']).toBe('string')
    expect(Number(d['rms_before'])).toBeGreaterThanOrEqual(0)
  }, 300_000)

  it('同一张真图：DetectAtoms 与 SegmentRegion 都给得出结果，而且 `method` 说实话', async () => {
    const rig = await instrument()
    const ctx = rig.ctx()
    await ctx.safeCall('Scan_BufferSet', [0, 14], 16, 16)
    await IMPLEMENTED['ScanAt']!.execute(ctx, {
      center_x_m: 0, center_y_m: 0, size_m: 20e-9, pixels: 16, line_time_s: FAST_LINE_S,
    })
    const save = await IMPLEMENTED['SaveScan']!.execute(ctx, {})
    const p = (save.data as Record<string, unknown>)['saved_path'] as string
    const seg = await IMPLEMENTED['SegmentRegion_UNet']!.execute({} as SkillContext, { image_path: p })
    const atoms = await IMPLEMENTED['DetectAtoms_FCN']!.execute({} as SkillContext, { image_path: p })
    expect([seg.success, atoms.success]).toEqual([true, true])
    // **给了 `model_path` 也一样报 `heuristic`** —— 报的是真的跑了哪一条
    // （`paper-image.ts` 的 `Denoise_AE` 先例），不是请求的那一条。
    const withModel = await IMPLEMENTED['SegmentRegion_UNet']!.execute({} as SkillContext, {
      image_path: p, model_path: `${p}.no-such-model.pt`,
    })
    expect((withModel.data as Record<string, unknown>)['method']).toBe('heuristic')
    const areas = (seg.data as Record<string, unknown>)['class_areas'] as Record<string, number>
    // 面积占比之和恒为 1（它们是一次划分）。
    expect(Object.values(areas).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  }, 300_000)
})
