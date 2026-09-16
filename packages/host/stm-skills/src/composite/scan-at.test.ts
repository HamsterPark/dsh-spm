/**
 * `ScanAt` 的技能层 —— 判据是**排了哪几步、按什么顺序**，加上三种结局各自那句话。
 *
 * 解析本身在 `kernel/src/scan-resolver.test.ts` 逐格对旧仓比过了（77 格）。
 * 这里验的是解析**之后**的事：不下发的那几个写真的没有变成步骤、
 * 超时之后真的补了一发停扫、而中途停止真的**没有**补。
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_LOOKUP, type SkillCallRecord, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { ScanAt, SCAN_WAIT_FLOOR_S, makeScanAt, stoppedEarlyText, timedOutText } from './scan-at.js'

interface SubResult {
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

interface Script {
  /** 按技能名脚本化的子技能应答。没写的一律 `success: true, data: {}`。 */
  sub?: Record<string, SubResult>
  /** 第几次问 `signal.aborted` 时中止。 */
  abortAt?: number
  /** `safeCall` 一律失败（用来验「超时那一发停扫失败也不改结局」）。 */
  callFails?: string
}

class Rig {
  readonly runs: { skill: string; params: Record<string, unknown> }[] = []
  readonly calls: { method: string; args: unknown[] }[] = []
  #clock = 1_000_000
  #abortQ = 0

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
      markers: { emit: () => {} },
      safeCall: (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
        this.calls.push({ method, args })
        return Promise.resolve({
          method,
          args,
          values: [],
          ...(this.s.callFails === undefined ? {} : { error: this.s.callFails }),
        } as unknown as SkillCallRecord)
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
}

async function run(
  params: Record<string, unknown>,
  s: Script = {},
): Promise<{ res: SkillResultLike; rig: Rig }> {
  const rig = new Rig(s)
  const res = await ScanAt.execute(rig.ctx(), params)
  return { res, rig }
}

const AT = { center_x_m: 0, center_y_m: 0, size_m: 1e-7 }

describe('ScanAt · 计划', () => {
  it('出厂表下只排四步：configure / set_buffer / start / wait', async () => {
    const { res, rig } = await run(AT)
    expect(res.success).toBe(true)
    expect(rig.runs.map((r) => r.skill)).toEqual([
      'ConfigureScan',
      'SetScanBuffer',
      'StartScan',
      'WaitScanComplete',
    ])
  })

  it('**不下发**的硬件写不会变成一步空调用', async () => {
    const { rig } = await run(AT)
    expect(rig.runs.map((r) => r.skill)).not.toContain('SetBias')
    expect(rig.runs.map((r) => r.skill)).not.toContain('SetSetpoint')
    expect(rig.runs.map((r) => r.skill)).not.toContain('SetZCtrlGain')
  })

  it('bias 排在最前 —— 偏压变了，后面的 setpoint 才在正确的工作点上', async () => {
    const { rig } = await run({ ...AT, bias_v: 0.5, setpoint_a: 1e-10 })
    expect(rig.runs.map((r) => r.skill)).toEqual([
      'SetBias',
      'SetSetpoint',
      'ConfigureScan',
      'SetScanBuffer',
      'StartScan',
      'WaitScanComplete',
    ])
  })

  it('`SetScanBuffer` **必须**排在 `ConfigureScan` 之后', async () => {
    const { rig } = await run(AT)
    const names = rig.runs.map((r) => r.skill)
    expect(names.indexOf('SetScanBuffer')).toBeGreaterThan(names.indexOf('ConfigureScan'))
  })

  it("purpose='atomic' 是一句物理意图 ⇒ 它自己定工作点（2026-08-26）", async () => {
    const { rig } = await run({ ...AT, size_m: 8e-9, purpose: 'atomic' })
    expect(rig.runs[0]).toEqual({ skill: 'SetBias', params: { bias_v: 0.02 } })
    expect(rig.runs[1]).toEqual({ skill: 'SetSetpoint', params: { setpoint_a: 500e-12 } })
  })

  it('按尺寸碰巧定到原子档**不**定工作点 —— 那只是尺度巧合', async () => {
    const { rig } = await run({ ...AT, size_m: 8e-9 })
    expect(rig.runs.map((r) => r.skill)).not.toContain('SetBias')
  })
})

describe('ScanAt · 等待预算', () => {
  const timeoutOf = (rig: Rig): number =>
    rig.runs.find((r) => r.skill === 'WaitScanComplete')?.params['timeout_ms'] as number

  it('不给就按解析出来的几何估，下限 300 s', async () => {
    const { rig } = await run({ ...AT, pixels: 16, line_time_s: 0.01 })
    expect(timeoutOf(rig)).toBe(SCAN_WAIT_FLOOR_S * 1000)
  })

  it('**显式值是下限不是上限**（2026-08-23：300 s 常数把 512 px 的帧判成 abort）', async () => {
    // 几何估出来 1024×1.3+30 = 1361.2 s，而调用方传的 300 s 更短 ⇒ 取大的那个
    const { rig } = await run({ ...AT, pixels: 512, line_time_s: 1.0, wait_timeout_s: 300 })
    expect(timeoutOf(rig)).toBe(Math.trunc((512 * 1 * 2 * 1.3 + 30) * 1000))
  })

  it('显式值更大时**用显式的**（`ForgeAuTip` 的 1300 s）', async () => {
    const { rig } = await run({ ...AT, pixels: 16, line_time_s: 0.01, wait_timeout_s: 1300 })
    expect(timeoutOf(rig)).toBe(1_300_000)
  })
})

describe('ScanAt · 三种结局', () => {
  it('扫完 ⇒ success，且**一次裸动词都不发**', async () => {
    const { res, rig } = await run(AT)
    expect(res.success).toBe(true)
    expect(rig.calls).toEqual([])
  })

  it('超时 ⇒ 失败，而且补一发 `Scan_Action(1, 0)` 停扫', async () => {
    const { res, rig } = await run(AT, {
      sub: {
        WaitScanComplete: {
          success: true,
          data: { timed_out: true, budget_s: 300, elapsed_s: 301, lines_done: 250, lines_total: 256 },
        },
      },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('扫描在等待预算内没有完成')
    expect(rig.calls).toEqual([{ method: 'Scan_Action', args: [1, 0] }])
  })

  it('**中途停止刻意不补停扫** —— 扫描已经停了，那是一次无意义的写操作', async () => {
    const { res, rig } = await run(AT, {
      sub: {
        WaitScanComplete: {
          success: true,
          data: { stopped_early: true, lines_done: 61, lines_total: 256 },
        },
      },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('扫描中途停止')
    expect(res.error).toContain('**不是**超时')
    expect(rig.calls).toEqual([])
  })

  it('超时那一发停扫自己失败了，也不改变结局（只多一个留痕字段）', async () => {
    const { res } = await run(AT, {
      callFails: '连接被对端关闭',
      sub: { WaitScanComplete: { success: true, data: { timed_out: true } } },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('扫描在等待预算内没有完成')
    expect(res.data?.['stop_after_timeout_error']).toBe('连接被对端关闭')
  })

  it('子步失败 ⇒ 中止整条计划，而**参数来源表照样交出来**', async () => {
    const { res } = await run(AT, { sub: { ConfigureScan: { success: false, error: '帧写不进去' } } })
    expect(res.success).toBe(false)
    expect(res.error).toContain('帧写不进去')
    // 失败时**尤其**要看得到「这次打算用什么参数、每个数字哪来的」
    expect(res.data?.['param_summary']).toBeInstanceOf(Array)
    expect(res.data?.['tier_name']).toBe('highres')
  })

  it('中止 ⇒ `abort_facts` 说得出是谁停的，不用去猜措辞', async () => {
    const { res } = await run(AT, { abortAt: 1 })
    expect(res.success).toBe(false)
    expect(res.data?.['aborted']).toBe(true)
    expect(res.data?.['aborted_by_operator']).toBe(true)
  })
})

describe('ScanAt · 拒绝在解析那一层发生', () => {
  for (const [name, params, said] of [
    ['size_m = 0', { ...AT, size_m: 0 }, '不替用户发明尺寸'],
    ['size_m 是负数', { ...AT, size_m: -1e-7 }, '不替用户发明尺寸'],
    ['size_m 读不出数', { ...AT, size_m: 'big' }, '不替用户发明尺寸'],
    ['中心坐标读不出数', { ...AT, center_x_m: null }, '扫描中心无效'],
  ] as [string, Record<string, unknown>, string][]) {
    it(`${name} ⇒ 拒绝，而且一步都不排、一次调用都不发`, async () => {
      const { res, rig } = await run(params)
      expect(res.success).toBe(false)
      expect(res.error).toContain(said)
      expect(rig.runs).toEqual([])
      expect(rig.calls).toEqual([])
    })
  }

  it('中心坐标那一句点名的是坐标，不是尺寸', async () => {
    const { res } = await run({ ...AT, center_y_m: 'left' })
    expect(res.error).toContain('扫描中心无效')
  })
})

describe('ScanAt · 报文里必须有哪几个数（2026-08-05）', () => {
  it('超时那句同时印出估计、预算、实际等了多久、以及行数', () => {
    const text = timedOutText(
      { budget_s: 1361, elapsed_s: 1362, extensions: 2, lines_done: 250, lines_total: 256 },
      1024,
    )
    // 它从前**只印估计值**，于是一次真超时被从这一句话里诊断了两遍，两遍都错
    expect(text).toContain('按解析参数估计需要 1024 s')
    expect(text).toContain('等待预算 1361 s')
    expect(text).toContain('实际等了 1362 s')
    expect(text).toContain('延长过 2 次')
    expect(text).toContain('已采 250/256 行')
  })

  it('一个数都拿不到时不印一对空括号', () => {
    expect(timedOutText({}, 0)).not.toContain('()')
  })

  it('中途停止那句里**不出现** timeout 这条建议', () => {
    const text = stoppedEarlyText({ scan_lines_done: 61, scan_lines_total: 256 })
    expect(text).toContain('(扫到 61/256 行)')
    expect(text).toContain('调大 timeout 不解决问题')
  })

  it('行数读不到时说「行数未知」，不编一个 0/0', () => {
    expect(stoppedEarlyText({})).toContain('(行数未知)')
  })
})

describe('ScanAt · 档位表由外面注入', () => {
  it('`makeScanAt()` 不接 ⇒ 出厂表', async () => {
    const rig = new Rig()
    const res = await makeScanAt().execute(rig.ctx(), AT)
    expect(res.data?.['tier_name']).toBe('highres')
  })

  it('接一张操作员表 ⇒ 档名与像素都跟着它走', async () => {
    const tier = {
      name: 'mine',
      upperSizeM: null,
      pixels: 96,
      lineTimeS: 0.3,
      source: 'operator' as const,
      factoryFilled: [],
    }
    const rig = new Rig()
    const res = await makeScanAt({
      tiers: { tierForSize: () => tier, tierByName: () => null, tierNames: () => ['mine'] },
    }).execute(rig.ctx(), AT)
    expect(res.data?.['tier_name']).toBe('mine')
    expect(rig.runs.find((r) => r.skill === 'SetScanBuffer')?.params).toEqual({
      pixels: 96,
      lines: 96,
    })
  })

  it('出厂查表口就是 `scan-policy.ts` 那张表', () => {
    expect(FACTORY_LOOKUP.tierForSize(1e-7).name).toBe('highres')
  })
})
