/**
 * `FullScan` 的技能层 —— 它是撞针状态机**问 / 记 / 清**三件事的落点。
 *
 * 状态机本身在 `kernel/src/tip-crash-tracker.test.ts` 逐步对旧仓比过了（21 条脚本）。
 * 这里验的是接线：拒绝真的拦住了整趟（一次调用都不发）、撞针真的记在了扫描中心、
 * 一趟干净的扫描真的把旧账清掉了。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  getTipCrashTracker,
  processTipCrash,
  resetTipCrashTracker,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { ASSUMED_LINES, FullScan } from './full-scan.js'

interface SubResult {
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

interface Script {
  sub?: Record<string, SubResult>
  /** 按调用序号脚本化的 `safeCall` 回包（`values`）；`null` = 这一次报错。 */
  reply?: (unknown[] | null)[]
  abortAt?: number
}

/** 一帧「有信号」的数据：`[name_len, name, rows, cols, data2d, dir]`。 */
function frame(values: number[][]): unknown[] {
  return [4, 'Zfwd', values.length, values[0]!.length, values, 1]
}

const LIVE = frame([
  [1e-10, 2e-10],
  [3e-10, 4e-10],
])
const FLAT = frame([
  [1e-10, 1e-10],
  [1e-10, 1e-10],
])
const NANS = frame([
  [Number.NaN, Number.NaN],
  [Number.NaN, Number.NaN],
])
/** `Scan_BufferGet` 的 body：`[n, [通道…], pixels, lines]`（真机上通道是 1-元组）。 */
const BUFFER = [2, [[0], [30]], 128, 128]

class Rig {
  readonly runs: { skill: string; params: Record<string, unknown> }[] = []
  readonly calls: { method: string; args: unknown[] }[] = []
  #clock = 1_000_000
  #abortQ = 0
  #n = 0

  constructor(private readonly s: Script = {}) {}

  ctx(): SkillContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const rig = this
    return {
      signal: {
        get aborted(): boolean {
          rig.#abortQ += 1
          return rig.s.abortAt !== undefined && rig.#abortQ >= rig.s.abortAt
        },
      } as AbortSignal,
      owner: 'test',
      rootCallId: 'R1',
      depth: 0,
      now: () => {
        this.#clock += 1
        return this.#clock
      },
      sleep: () => Promise.resolve(),
      markers: { emit: (kind: string, data?: Record<string, unknown>) => this.marks.push({ kind, data }) },
      safeCall: (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
        this.calls.push({ method, args })
        const scripted = this.s.reply?.[this.#n]
        this.#n += 1
        if (scripted === null) {
          return Promise.resolve({ method, args, error: '连接被对端关闭' } as unknown as SkillCallRecord)
        }
        const values = scripted ?? (method === 'Scan_BufferGet' ? BUFFER : LIVE)
        return Promise.resolve({ method, args, values } as unknown as SkillCallRecord)
      },
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.runs.push({ skill: name, params: { ...params } })
        const r = this.s.sub?.[name] ?? { success: true }
        return Promise.resolve(
          r.success
            ? { success: true, data: r.data ?? {} }
            : { success: false, error: r.error ?? '', data: r.data ?? {} },
        )
      },
    } as unknown as SkillContext
  }

  readonly marks: { kind: string; data: Record<string, unknown> | undefined }[] = []
}

const AT = { center_x_m: 0, center_y_m: 0, width_m: 1e-7, height_m: 1e-7 }

async function run(
  params: Record<string, unknown> = AT,
  s: Script = {},
): Promise<{ res: SkillResultLike; rig: Rig }> {
  const rig = new Rig(s)
  const res = await FullScan.execute(rig.ctx(), params)
  return { res, rig }
}

afterEach(() => {
  processTipCrash.config = {}
  processTipCrash.nowS = () => Date.now() / 1000
  processTipCrash.tracker = null
})

describe('FullScan · 计划', () => {
  it('四步：configure / set_speed / start / wait', async () => {
    resetTipCrashTracker()
    const { res, rig } = await run()
    expect(res.success).toBe(true)
    expect(rig.runs.map((r) => r.skill)).toEqual([
      'ConfigureScan',
      'SetScanSpeed',
      'StartScan',
      'WaitScanComplete',
    ])
  })

  it('速度由 line_time 与帧宽导出，两个方向同速', async () => {
    resetTipCrashTracker()
    const { rig } = await run({ ...AT, line_time_s: 0.5 })
    expect(rig.runs[1]?.params).toEqual({
      fwd_speed: 2e-7,
      bwd_speed: 2e-7,
      fwd_line_time: 0.5,
      bwd_line_time: 0.5,
      keep_const: 0,
    })
  })

  it('等待预算按**问回来的真实行数**估，不是假设 512', async () => {
    resetTipCrashTracker()
    // BUFFER 说 128 行、档位表给 highres 的 1.0 s/线 ⇒ 128×1×2×1.3+30 = 362.8 s
    const { rig } = await run()
    expect(rig.runs[3]?.params['timeout_ms']).toBe(Math.trunc((128 * 1 * 2 * 1.3 + 30) * 1000))
  })

  it('行数问不到 ⇒ 回落 512（**只影响预算**）', async () => {
    resetTipCrashTracker()
    const { rig } = await run(AT, { reply: [null] })
    expect(rig.runs[3]?.params['timeout_ms']).toBe(
      Math.trunc((ASSUMED_LINES * 1 * 2 * 1.3 + 30) * 1000),
    )
  })

  it('给了 `wait_timeout_s` 就**不问行数**（少一次 `Scan_BufferGet`）', async () => {
    resetTipCrashTracker()
    const { rig } = await run({ ...AT, wait_timeout_s: 42 })
    expect(rig.runs[3]?.params['timeout_ms']).toBe(42_000)
    // 开跑前那一次不发；扫完之后问通道那一次照发
    expect(rig.calls.filter((c) => c.method === 'Scan_BufferGet')).toHaveLength(1)
  })
})

describe('FullScan · 撞针检查', () => {
  it('探的是**真正采到的那几路**（通道 0 与 30，不是写死的 14）', async () => {
    resetTipCrashTracker()
    const { res, rig } = await run()
    expect(rig.calls.filter((c) => c.method === 'Scan_FrameDataGrab').map((c) => c.args)).toEqual([
      [0, 1],
      [30, 1],
    ])
    expect(res.data?.['crash_check']).toBe('ok')
    expect(res.data?.['crash_check_channels']).toEqual({ ch0: 'ok', ch30: 'ok' })
  })

  it('通道问不到 ⇒ 回落静态两路，而且标的是编号不是名字', async () => {
    resetTipCrashTracker()
    const { res } = await run(AT, { reply: [BUFFER, null] })
    expect(res.data?.['crash_check_channels']).toEqual({ ch0: 'ok', ch14: 'ok' })
  })

  it('一路都读不到 ⇒ `skipped`，**永远不是 `ok`**', async () => {
    resetTipCrashTracker()
    const { res } = await run(AT, { reply: [BUFFER, BUFFER, null, null] })
    expect(res.success).toBe(true)
    expect(res.data?.['crash_check']).toBe('skipped')
    expect(res.data?.['crash_check_channels']).toEqual({ ch0: 'no_data', ch30: 'no_data' })
  })

  it('方差接近零 ⇒ 撞针', async () => {
    resetTipCrashTracker()
    const { res } = await run(AT, { reply: [BUFFER, BUFFER, FLAT] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('CRASH_DETECTED')
    expect(res.data?.['crash_indicator']).toBe(true)
  })

  it('一整帧 NaN 也是撞针 —— 那正是它最典型的样子', async () => {
    resetTipCrashTracker()
    const { res } = await run(AT, { reply: [BUFFER, BUFFER, NANS] })
    expect(res.success).toBe(false)
    expect(res.data?.['crash_channel']).toBe('ch0')
  })
})

describe('FullScan · 撞针状态机的三条接线', () => {
  it('**记**：判出撞针就记在扫描中心', async () => {
    resetTipCrashTracker()
    await run(AT, { reply: [BUFFER, BUFFER, FLAT] })
    expect(getTipCrashTracker().crashCount(0, 0)).toBe(1)
  })

  it('第二次在同一点撞 ⇒ 结论里**当场**带上逃逸指令，不等它撞第三次', async () => {
    resetTipCrashTracker()
    await run(AT, { reply: [BUFFER, BUFFER, FLAT] })
    const { res } = await run(AT, { reply: [BUFFER, BUFFER, FLAT] })
    expect(res.data?.['repeated_crash']).toBe(true)
    expect(res.error).toContain('repeated_crash_escape_required')
    expect(res.error).toContain('RelocateCoarseXY')
  })

  it('**问**：区域封了就拒绝，而且一次调用一步计划都没有', async () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    getTipCrashTracker().recordCrash(0, 0)
    const { res, rig } = await run()
    expect(res.success).toBe(false)
    expect(res.error).toContain('repeated_crash_escape_required')
    expect(res.data?.['repeated_crash']).toBe(true)
    expect(rig.runs).toEqual([])
    expect(rig.calls).toEqual([])
  })

  it('拒绝留一条面包屑（D-DIAG-1：`ctx.markers.emit`）', async () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    getTipCrashTracker().recordCrash(0, 0)
    const { rig } = await run()
    expect(rig.marks.map((m) => m.kind)).toEqual(['tip_crash'])
    expect(rig.marks[0]?.data?.['count']).toBe(2)
  })

  it('封的是**那一格**，隔壁照扫', async () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    getTipCrashTracker().recordCrash(0, 0)
    const { res } = await run({ ...AT, center_x_m: 1e-6, center_y_m: 1e-6 })
    expect(res.success).toBe(true)
  })

  it('**清**：一趟干净的扫描把这个点的旧账清掉', async () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    const { res } = await run()
    expect(res.success).toBe(true)
    expect(getTipCrashTracker().crashCount(0, 0)).toBe(0)
  })

  it('扫描没扫完就**不清账** —— 那不是一次「针尖在这儿是好的」的证据', async () => {
    resetTipCrashTracker()
    getTipCrashTracker().recordCrash(0, 0)
    const { res } = await run(AT, {
      sub: { WaitScanComplete: { success: true, data: { stopped_early: true } } },
    })
    expect(res.success).toBe(false)
    expect(getTipCrashTracker().crashCount(0, 0)).toBe(1)
  })

  it('读不到扫描中心的撞针照样计数（「读不到 ≠ 零 ≠ 否」）', async () => {
    resetTipCrashTracker()
    await run({ ...AT, center_x_m: null, center_y_m: null }, { reply: [BUFFER, BUFFER, FLAT] })
    expect(getTipCrashTracker().crashPoints()).toEqual({ located: [], unlocated: 1 })
  })
})

describe('FullScan · 「每一步成功」不等于「扫完了」', () => {
  it('超时 ⇒ 失败，而且报文里印的是**真正用上的**预算', async () => {
    resetTipCrashTracker()
    const { res } = await run(AT, {
      sub: { WaitScanComplete: { success: true, data: { timed_out: true } } },
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe(`Scan timed out after ${128 * 1 * 2 * 1.3 + 30}s`)
  })

  it('中途停止 ⇒ 失败，且**根本不做撞针检查**', async () => {
    resetTipCrashTracker()
    const { res, rig } = await run(AT, {
      sub: {
        WaitScanComplete: {
          success: true,
          data: { stopped_early: true, lines_done: 31, lines_total: 128 },
        },
      },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('扫描中途停止(31/128 行)')
    // 下一步本来会拿一堆 NaN 行去判撞针、然后报一张干净的图
    expect(rig.calls.filter((c) => c.method === 'Scan_FrameDataGrab')).toEqual([])
  })

  it('子步失败 ⇒ 中止，`_progress` 记着走到哪一步', async () => {
    resetTipCrashTracker()
    const { res } = await run(AT, { sub: { StartScan: { success: false, error: '起扫被拒' } } })
    expect(res.success).toBe(false)
    expect(res.error).toContain('起扫被拒')
    const prog = res.data?.['_progress'] as { completed_steps: string[] }
    expect(prog.completed_steps).toEqual(['configure', 'set_speed'])
  })
})
