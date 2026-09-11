/**
 * `ConfigureScan` 的三道拒绝 与 `StartScan` 的四支闸门。
 *
 * 通用轨迹金样只走得到合成回包那一路（那一路每次都落在同一支上）。这些判据要的是
 * **脚本化的回包**：仪器把框夹了、框伸出量程、continuous 开着、清单读不到……
 * 各自成立在哪一格，得自己摆出来。
 */
import { describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { ConfigureScan } from './configure-scan.js'
import { StartScan, continuousGate } from './start-scan.js'

/** 沿用旧仓观测示例：半程 ±1334.5 nm（calibration × 10 V）。 */
const CALIB = 1.3345e-7
const HALF = CALIB * 10

interface Script {
  /** `Scan_FrameGet` 依次回什么；`null` = 读失败。 */
  frames?: (number[] | null)[]
  /** `Piezo_CalibrGet`；`null` = 读失败。 */
  calib?: number[] | null
  /** `Piezo_XYZLimitsGet`；`null` = 读失败。 */
  limits?: number[] | null
  signals?: string[] | null
  /** `Scan_PropsGet` 依次回什么 body；`null` = 读失败。 */
  props?: (unknown[] | null)[]
  errors?: Record<string, string>
}

class Rig {
  readonly calls: { verb: string; args: unknown[] }[] = []
  #frames: (number[] | null)[]
  #props: (unknown[] | null)[]

  constructor(private readonly s: Script) {
    this.#frames = [...(s.frames ?? [])]
    this.#props = [...(s.props ?? [])]
  }

  ctx(): SkillContext {
    return {
      signal: new AbortController().signal,
      now: () => 1_000_000,
      sleep: () => Promise.resolve(),
      safeCall: (m: string, ...a: unknown[]) => Promise.resolve(this.#call(m, a)),
      emergencyCall: (m: string, ...a: unknown[]) => Promise.resolve(this.#call(m, a)),
      runSkill: (n: string) => Promise.resolve({ success: false, error: `桩不支持 '${n}'` }),
    } as unknown as SkillContext
  }

  /**
   * 序列里的下一个。**不能用 `??` 兜底** —— 脚本里的 `null` 表示「这一次读失败」，
   * 是内容的一部分；`seq[0] ?? dflt` 会把它悄悄换成成功的默认回包，于是四条
   * 「读不到就拒」的测试全都测了另一件事。
   */
  static #next<T>(seq: T[], dflt: T): T {
    if (seq.length > 1) return seq.shift() as T
    return seq.length === 1 ? (seq[0] as T) : dflt
  }

  #call(verb: string, args: unknown[]): SkillCallRecord {
    this.calls.push({ verb, args })
    const err = this.s.errors?.[verb]
    if (err !== undefined) return { method: verb, args, error: err }
    const ok = (values: unknown[]): SkillCallRecord => ({ method: verb, args, values })
    const fail = (): SkillCallRecord => ({ method: verb, args, error: '模拟故障：读不到' })
    if (verb === 'Scan_FrameGet') {
      const f = Rig.#next(this.#frames, [0, 0, 100e-9, 100e-9, 0])
      return f === null ? fail() : ok(f)
    }
    if (verb === 'Piezo_CalibrGet') {
      const c = this.s.calib === undefined ? [CALIB, CALIB, CALIB] : this.s.calib
      return c === null ? fail() : ok(c)
    }
    if (verb === 'Piezo_XYZLimitsGet') {
      const l = this.s.limits === undefined ? [0, -10, 10, -10, 10] : this.s.limits
      return l === null ? fail() : ok(l)
    }
    if (verb === 'Signals_NamesGet') {
      const n = this.s.signals === undefined ? ['Current (A)', 'Z (m)'] : this.s.signals
      return n === null ? fail() : ok([n])
    }
    if (verb === 'Scan_PropsGet') {
      const p = Rig.#next(this.#props, propsBody())
      return p === null ? fail() : ok(p)
    }
    return ok([])
  }
}

/** 16 字段的 `Scan_PropsGet` body。 */
function propsBody(over: { continuous?: unknown; series?: string; modules?: unknown; count?: unknown } = {}): unknown[] {
  const mods = over.modules === undefined ? ['Bias', 'Z-Controller'] : over.modules
  const body: unknown[] = new Array(16).fill(0)
  body[0] = over.continuous ?? 0
  body[4] = over.series ?? 'Au111'
  body[8] = over.count ?? (Array.isArray(mods) ? mods.length : 0)
  body[9] = mods
  return body
}

const run = async (
  skill: typeof ConfigureScan,
  params: Record<string, unknown>,
  s: Script = {},
): Promise<{ res: SkillResultLike; rig: Rig }> => {
  const rig = new Rig(s)
  return { res: await skill.execute(rig.ctx(), params), rig }
}

const FRAME = { center_x_m: 0, center_y_m: 0, width_m: 100e-9, height_m: 100e-9 }

describe('ConfigureScan ① 读不回角度就拒 —— 不臆断 0°', () => {
  it('省略 angle_deg ⇒ 回读；读到就用它', async () => {
    const { res, rig } = await run(ConfigureScan, FRAME, {
      frames: [[0, 0, 100e-9, 100e-9, 30], [0, 0, 100e-9, 100e-9, 30]],
    })
    expect(res.success).toBe(true)
    expect(rig.calls[1]?.args[4]).toBe(30) // Scan_FrameSet 用的是读回来的角度
  })

  it('**回读失败 ⇒ 整件事失败**，一次 `Scan_FrameSet` 都不发', async () => {
    // 用一个假定的 0° 会静默地把扫描框转正，而调用方要的是「保持当前角度」。
    const { res, rig } = await run(ConfigureScan, FRAME, { frames: [null] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('静默地把扫描框转正')
    expect(rig.calls.map((c) => c.verb)).toEqual(['Scan_FrameGet'])
  })

  it('回包读不懂（不足五个数）也一样拒', async () => {
    const { res } = await run(ConfigureScan, FRAME, { frames: [[0, 0, 1e-7]] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('拒绝配置扫描帧')
  })

  it('**显式传 0 就用 0** —— 出路在报文里说了', async () => {
    const { res, rig } = await run(ConfigureScan, { ...FRAME, angle_deg: 0 })
    expect(res.success).toBe(true)
    expect(rig.calls[0]?.verb).toBe('Scan_FrameSet') // 没有先回读
  })
})

describe('ConfigureScan ② 回读对不上就拒 —— 回声不是读数', () => {
  it('仪器把框夹了 ⇒ 拒，**不夹紧**，并说清哪一项差多少', async () => {
    const { res } = await run(
      ConfigureScan,
      { center_x_m: 639e-9, center_y_m: -597e-9, width_m: 2e-6, height_m: 2e-6, angle_deg: 0 },
      { frames: [[500e-9, -597e-9, 2e-6, 2e-6, 0]] },
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain('仪器没有接受这个扫描帧')
    expect(res.error).toContain('**拒绝，不夹紧**')
    expect(res.error).toContain('center_x_m')
    expect((res.data as { frame_mismatch: unknown }).frame_mismatch).toBeTruthy()
  })

  it('**读不回 ⇒ 也拒**：「读不到」不是「设上了」', async () => {
    const { res } = await run(ConfigureScan, { ...FRAME, angle_deg: 0 }, { frames: [null] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('读不回')
    expect((res.data as { frame_readback: unknown }).frame_readback).toBeNull()
  })

  it('成功那一趟的 `data` 里是**读回来的**值，而且带 `frame_verified`', async () => {
    const { res } = await run(ConfigureScan, { ...FRAME, angle_deg: 0 }, {
      frames: [[1e-12, 0, 100e-9, 100e-9, 0]],
    })
    const d = res.data as Record<string, unknown>
    expect(d['frame_verified']).toBe(true)
    expect(d['center_x_m']).toBe(1e-12) // 容差之内，但报的是读回来的那个
  })
})

describe('ConfigureScan ③ 伸出压电量程就拒 —— 那 15 % 不是数据', () => {
  it('2026-08-28 那一帧：2 µm 的框、半程 ±1334.5 nm ⇒ 拒', async () => {
    const { res } = await run(
      ConfigureScan,
      { center_x_m: 639e-9, center_y_m: -597e-9, width_m: 2e-6, height_m: 2e-6, angle_deg: 0 },
      { frames: [[639e-9, -597e-9, 2e-6, 2e-6, 0]] },
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain('伸出压电量程')
    expect(res.error).toContain('**拒绝，不夹紧**')
    expect(res.error).toContain('x_high_m 超 305 nm')
    const d = res.data as Record<string, unknown>
    expect(d['piezo_half_x_m']).toBeCloseTo(HALF, 12)
  })

  it('**标定读不到 ⇒ 这一格没验**，但不拦 —— 「读不到」不是「超了」', async () => {
    const { res } = await run(
      ConfigureScan,
      { center_x_m: 639e-9, center_y_m: -597e-9, width_m: 2e-6, height_m: 2e-6, angle_deg: 0 },
      { frames: [[639e-9, -597e-9, 2e-6, 2e-6, 0]], calib: null },
    )
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>)['piezo_half_x_m']).toBeNull()
  })

  it('压电限位启用时半程跟着变窄，于是同一个框可能就超了', async () => {
    const params = { center_x_m: 0, center_y_m: 0, width_m: 1.5e-6, height_m: 1e-7, angle_deg: 0 }
    const frames = [[0, 0, 1.5e-6, 1e-7, 0]]
    const wide = await run(ConfigureScan, params, { frames: [...frames] })
    const narrow = await run(ConfigureScan, params, {
      frames: [...frames],
      limits: [1, -3, 3, -3, 3], // 启用，±3 V ⇒ 半程 400 nm
    })
    expect(wide.res.success).toBe(true)
    expect(narrow.res.success).toBe(false)
    expect(narrow.res.error).toContain('伸出压电量程')
  })
})

describe('ConfigureScan ④ 通道与速度', () => {
  it('通道对不上就**跳过**，不猜，也不让整件事失败', async () => {
    const { res, rig } = await run(ConfigureScan, { ...FRAME, angle_deg: 0, channels: 'Z,Nope' })
    expect(res.success).toBe(true)
    const buf = rig.calls.find((c) => c.verb === 'Scan_BufferSet')
    expect(buf?.args[0]).toEqual([1]) // 只有 Z 对上了（索引 1）
  })

  it('一个都对不上 ⇒ **不发** `Scan_BufferSet`', async () => {
    const { rig } = await run(ConfigureScan, { ...FRAME, angle_deg: 0, channels: 'Nope' })
    expect(rig.calls.some((c) => c.verb === 'Scan_BufferSet')).toBe(false)
  })

  it('速度由档位表推导，`line_time_source` 说得出是谁定的', async () => {
    const { res, rig } = await run(ConfigureScan, { ...FRAME, angle_deg: 0 })
    const d = res.data as Record<string, unknown>
    expect(d['line_time_source']).toBe('tier:highres')
    expect(d['line_time_s']).toBe(1.0)
    expect(d['linear_speed_m_s']).toBeCloseTo(100e-9 / 1.0, 15)
    expect(rig.calls.some((c) => c.verb === 'Scan_SpeedSet')).toBe(true)
  })

  it('`set_scan_speed: false` ⇒ **一发都不动速度**', async () => {
    const { res, rig } = await run(ConfigureScan, { ...FRAME, angle_deg: 0, set_scan_speed: false })
    expect(rig.calls.some((c) => c.verb === 'Scan_SpeedSet')).toBe(false)
    expect((res.data as Record<string, unknown>)['line_time_s']).toBeNull()
  })

  it('档位按**长边**查 —— 8 nm × 200 nm 的条带该按 200 nm 定速', async () => {
    const { res } = await run(
      ConfigureScan,
      { center_x_m: 0, center_y_m: 0, width_m: 8e-9, height_m: 200e-9, angle_deg: 0 },
      { frames: [[0, 0, 8e-9, 200e-9, 0]] },
    )
    expect((res.data as Record<string, unknown>)['line_time_source']).toBe('tier:roi')
  })
})

describe('StartScan 的闸：不发起一次停不下来的扫描', () => {
  it('回读确认 continuous 关着 ⇒ 起扫', async () => {
    const { res, rig } = await run(StartScan, {}, { props: [propsBody({ continuous: 0 })] })
    expect(res.success).toBe(true)
    expect(rig.calls.at(-1)).toEqual({ verb: 'Scan_Action', args: [0, 0] })
    expect((res.data as Record<string, unknown>)['continuous_scan_still_on']).toBe(false)
  })

  it('**写了也没关掉** ⇒ 拒，而且说的是这一种', async () => {
    const { res, rig } = await run(StartScan, {}, { props: [propsBody({ continuous: 1 })] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('写了也没关掉')
    expect(rig.calls.some((c) => c.verb === 'Scan_Action')).toBe(false)
  })

  it('**根本没能写** ⇒ 拒，说的是另一种', async () => {
    // 「机器不认这次写入」和「我们根本没写」指向完全不同的下一步。
    const { res } = await run(StartScan, {}, {
      props: [propsBody({ modules: 'not-an-array', count: 0 }), propsBody({ continuous: 1 })],
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('根本没能写')
    expect(res.error).toContain('协议里没有「模块名保持原样」这一档')
  })

  it('**回读不到** ⇒ 也拒（三态，不是两态）', async () => {
    const { res } = await run(StartScan, {}, { props: [propsBody({ continuous: 0 }), null] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('回读不到')
  })

  it('`allow_continuous_scan` ⇒ 放行，并留下 `override_used`', async () => {
    const { res } = await run(StartScan, { allow_continuous_scan: true }, {
      props: [propsBody({ continuous: 1 })],
    })
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>)['continuous_scan_override_used']).toBe(true)
  })

  it('拒绝文案里**三条出口**都在，而且第 3 条说清它是用户的决定', async () => {
    const { res } = await run(StartScan, {}, { props: [propsBody({ continuous: 1 })] })
    expect(res.error).toContain('三条出口:')
    expect(res.error).toContain('**修那次读**')
    expect(res.error).toContain('手动关掉 Continuous scan')
    expect(res.error).toContain('**这是用户的决定,不是自动重试的开关**')
  })

  it('零个模块**是一个事实** ⇒ 照样下发（写回 `[]` 在两种语义下都是空操作）', async () => {
    const { res, rig } = await run(StartScan, {}, {
      props: [propsBody({ modules: [], count: 0, continuous: 0 })],
    })
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>)['module_names_source']).toBe('read_empty')
    expect(rig.calls.some((c) => c.verb === 'Scan_PropsSet')).toBe(true)
  })

  it('清单读不到 ⇒ **不下发**，用户配的清单保持原样', async () => {
    const { res, rig } = await run(StartScan, {}, { props: [null] })
    expect(rig.calls.some((c) => c.verb === 'Scan_PropsSet')).toBe(false)
    expect((res.data as Record<string, unknown>)['module_names_source']).toBe('unchanged')
  })

  it('`Scan_PropsGet` 重试两次就撤 —— 那次失败是**确定性**的', async () => {
    const { rig } = await run(StartScan, {}, { props: [null] })
    expect(rig.calls.filter((c) => c.verb === 'Scan_PropsGet')).toHaveLength(4) // 前后各两次
  })

  it('序列名取自**上面那一次读**，不单开第二发', async () => {
    // 两次读可以给出不同的答案，而一个空序列名会把用户配的文件名前缀打回 unnamed####。
    const { rig } = await run(StartScan, {}, { props: [propsBody({ series: 'Au111' })] })
    const set = rig.calls.find((c) => c.verb === 'Scan_PropsSet')
    expect(set?.args[3]).toBe('Au111')
  })

  it('方向只能是 down / up，**不猜**', async () => {
    const { res } = await run(StartScan, { direction: 'sideways' }, {
      props: [propsBody({ continuous: 0 })],
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('**不猜**')
  })

  it('`up` 发 `Scan_Action(0, 1)`', async () => {
    const { rig } = await run(StartScan, { direction: 'up' }, { props: [propsBody({ continuous: 0 })] })
    expect(rig.calls.at(-1)).toEqual({ verb: 'Scan_Action', args: [0, 1] })
  })
})

describe('continuousGate —— 四种话，不是两种', () => {
  const base = {
    override: false,
    continuousBefore: 1,
    moduleNamesSource: 'read',
    readError: '',
    readbackError: '',
  }

  it('关着 ⇒ 空串（放行）', () => {
    expect(continuousGate({ ...base, stillOn: false })).toBe('')
  })

  it('四种处境四句抬头', () => {
    const on_written = continuousGate({ ...base, stillOn: true })
    const on_unwritten = continuousGate({ ...base, stillOn: true, moduleNamesSource: 'unchanged' })
    const unknown_written = continuousGate({ ...base, stillOn: null })
    const unknown_unwritten = continuousGate({ ...base, stillOn: null, moduleNamesSource: 'unchanged' })
    expect(on_written).toContain('写了也没关掉')
    expect(on_unwritten).toContain('根本没能写')
    expect(unknown_written).toContain('回读不到')
    expect(unknown_unwritten).toContain('**读不到**')
    // 四句互不相同 —— 把它们说成同一句话就是把人送去查一件没发生的事
    expect(new Set([on_written, on_unwritten, unknown_written, unknown_unwritten]).size).toBe(4)
  })

  it('override ⇒ 放行（但调用方拿得到 `override_used`）', () => {
    expect(continuousGate({ ...base, stillOn: true, override: true })).toBe('')
    expect(continuousGate({ ...base, stillOn: null, override: true })).toBe('')
  })
})
