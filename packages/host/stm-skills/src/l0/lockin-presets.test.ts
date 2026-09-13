/**
 * 锁相参数组三件套 —— 对 `spec/golden/lockin_presets.json` 逐格比。
 *
 * 那份金样由 `tools/spec-export/export_lockin_presets.py` 驱动旧仓真实现跑出来，
 * 补的正是通用轨迹驱动器**到不了**的地方：`ApplyLockInPreset` 的回读比对整块
 * （通用那侧 `run()` 回空 data ⇒ 每一趟都落在「读不回来」），
 * 以及 `AutoPhase` 的全部判据（通用那侧停在「不知道 X/Y 在哪一路」）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AUTOPHASE_MIN_SIGNAL,
  LOCKIN_READBACK_KEYS,
  PRESET_DIDV,
  RESERVED_LOCKIN_NAMES,
  emptyHardwareState,
  type LockInProfile,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { makeApplyLockInPreset, makeAutoPhase, makeListLockInPresets } from './lockin-presets.js'

interface ApplyCase {
  readonly params: Record<string, unknown>
  readonly runs: { skill: string; params: Record<string, unknown> }[]
  readonly success: boolean
  readonly error: string
  readonly data: Record<string, unknown>
}
interface PhaseCase {
  readonly params: Record<string, unknown>
  readonly calls: { verb: string; args: unknown[] }[]
  readonly success: boolean
  readonly error: string
  readonly data: Record<string, unknown>
}
interface Golden {
  readonly constants: {
    readonly preset_didv: string
    readonly reserved_names: string[]
    readonly profile_keys: Record<string, string>
    readonly readback_keys: Record<string, string>
    readonly min_signal: number
    readonly poll_interval_s: number
    readonly profile_fixture: Record<string, number>
    readonly amplitude_float32: number
  }
  readonly apply: Record<string, ApplyCase>
  readonly phase: Record<string, PhaseCase>
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/lockin_presets.json', import.meta.url)),
    'utf8',
  ),
) as Golden

const FIXTURE: LockInProfile = {
  modFreqHz: golden.constants.profile_fixture['lockin_mod_freq_hz'] ?? null,
  modAmpV: golden.constants.profile_fixture['lockin_mod_amp_v'] ?? null,
  xSignalIndex: null,
  ySignalIndex: null,
}
const EMPTY: LockInProfile = {
  modFreqHz: null,
  modAmpV: null,
  xSignalIndex: null,
  ySignalIndex: null,
}

const S0 = emptyHardwareState('T0')

describe('常量与旧仓一致', () => {
  it('组名、档案键、回读键名', () => {
    expect(PRESET_DIDV).toBe(golden.constants.preset_didv)
    expect([...RESERVED_LOCKIN_NAMES]).toEqual(golden.constants.reserved_names)
    expect(LOCKIN_READBACK_KEYS).toEqual(golden.constants.readback_keys)
    expect(AUTOPHASE_MIN_SIGNAL).toBe(golden.constants.min_signal)
  })

  it('**幅度那两个键不同名** —— 缺陷⑩ 就在这条缝上', () => {
    // 组里叫 `amplitude_v`，`GetLockInConfig` 回来叫 `amplitude`。照着自己的名字去查
    // 会把一次**写入成功**报成「读不回来」，而那句失败带着「我核对过」的口气。
    expect(LOCKIN_READBACK_KEYS['amplitude_v']).toBe('amplitude')
    expect(LOCKIN_READBACK_KEYS['amplitude_v']).not.toBe('amplitude_v')
  })
})

// ── ApplyLockInPreset ──────────────────────────────────────────────────────

/** 只有 `runSkill` 的假 context —— 这个技能一条裸动词都不发。 */
function runCtx(results: Record<string, SkillResultLike>): {
  ctx: SkillContext
  runs: { skill: string; params: Record<string, unknown> }[]
  calls: string[]
} {
  const runs: { skill: string; params: Record<string, unknown> }[] = []
  const calls: string[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push(m)
      return Promise.resolve({ method: m, args: a, values: [1] })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: (n: string, p: Readonly<Record<string, unknown>>) => {
      runs.push({ skill: n, params: { ...p } })
      return Promise.resolve(results[n] ?? { success: true, data: {} })
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 't',
    rootCallId: 't',
    approvalSource: 'llm',
  } as unknown as SkillContext
  return { ctx, runs, calls }
}

/** 每一格自己的子技能返回 —— 与导出脚本那台驱动器同形。 */
const RB = golden.constants.amplitude_float32
const READBACK_OK = {
  modulator: 1,
  mod_on: true,
  amplitude: RB,
  frequency_hz: 973.0,
  phase_deg: 0.0,
  modulated_signal: 24,
  harmonic: 1,
}
const RESULTS: Readonly<Record<string, Record<string, SkillResultLike>>> = {
  ok: { GetLockInConfig: { success: true, data: READBACK_OK } },
  mod_off: { GetLockInConfig: { success: true, data: READBACK_OK } },
  readback_mismatch: { GetLockInConfig: { success: true, data: { ...READBACK_OK, amplitude: 0.04 } } },
  readback_key_renamed: {
    GetLockInConfig: {
      success: true,
      data: (() => {
        const { amplitude: _drop, ...rest } = READBACK_OK
        void _drop
        return { ...rest, amplitude_v: RB }
      })(),
    },
  },
  configure_failed: {
    ConfigureLockIn: { success: false, error: 'LockIn_ModAmpSet failed: 链路已断' },
  },
  readback_command_failed: { GetLockInConfig: { success: false, error: '链路已断' } },
  unknown_preset: {},
  profile_cleared_still_has_factory_defaults: {},
}

describe('ApplyLockInPreset —— 逐格对旧仓', () => {
  for (const [key, want] of Object.entries(golden.apply)) {
    // 旧仓那一格是「清空档案之后**仍然**拿到出厂默认」，本仓不带出厂默认
    // ⇒ 结局本来就该不同，单独测（见下面 D-LOCKIN-2 那一节）。
    if (key === 'profile_cleared_still_has_factory_defaults') continue

    it(`${key}：子技能序列与返回都相等`, async () => {
      const { ctx, runs, calls } = runCtx(RESULTS[key] ?? {})
      const got = await makeApplyLockInPreset({ lockinProfile: () => FIXTURE }).execute(
        ctx,
        want.params,
      )
      expect(runs).toEqual(want.runs)
      // **一条裸动词都不发** —— 走的是子技能的正门，于是它们各自的边界检查、
      // 安全闸、写后回读比对全都照常生效。
      expect(calls).toEqual([])
      expect(got.success).toBe(want.success)
      expect(got.error ?? '').toBe(want.error)
      expect(got.data ?? {}).toEqual(want.data)
    })
  }

  it('**调制侧 phase 一次都不出现在下发参数里**（D-LOCKIN-1）', async () => {
    const { ctx, runs } = runCtx({ GetLockInConfig: { success: true, data: READBACK_OK } })
    await makeApplyLockInPreset({ lockinProfile: () => FIXTURE }).execute(ctx, {})
    const configure = runs.find((r) => r.skill === 'ConfigureLockIn')
    // 判据落在**调用序列**上：这条命令固件恒拒（写同值也拒），
    // 挑不出「更好的相位值」来绕过它。
    expect(configure?.params).toEqual({ mod_on: true, frequency_hz: 973, amplitude_v: 0.02 })
    expect(Object.keys(configure?.params ?? {})).not.toContain('phase_deg')
  })

  it('float32 量化的回读**算通过** —— 用相等比较会把每一次成功写入都判成失败', () => {
    // 请求 0.02，硬件回 0.019999999552965164（相对差 2e-8）。
    expect(RB).not.toBe(0.02)
    expect(golden.apply['ok']?.success).toBe(true)
  })
})

describe('D-LOCKIN-2 · 本仓不带出厂默认', () => {
  it('旧仓那一格：档案清空之后**仍然**拿到 973 / 0.02', () => {
    // 导出脚本本来想录「一个键都没配 ⇒ 拒绝」，而它录不到 ——
    // `sanitize()` 丢掉空值，`get_config` 于是永远给得出出厂默认。
    const stale = golden.apply['profile_cleared_still_has_factory_defaults']!
    expect(stale.data['values']).toEqual({ frequency_hz: 973, amplitude_v: 0.02 })
    expect(stale.data['usable']).toBe(true)
    // ⇒ `usable === false` 那一支在旧仓是**死代码**。
  })

  it('本仓：没配就拒，并且说去哪儿填', async () => {
    const { ctx, runs } = runCtx({})
    const got = await makeApplyLockInPreset({ lockinProfile: () => EMPTY }).execute(ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('仪器档案里这一组一个值都没有配置')
    expect(got.error).toContain('lockin_mod_freq_hz、lockin_mod_amp_v')
    // **一次下发都没有** —— 静默不下发是假成功，而这里是明说的拒绝。
    expect(runs).toEqual([])
    expect(got.data?.['usable']).toBe(false)
  })

  it('只填了一半：填了的那个下发，没填的那个**连键名都不出现**', async () => {
    const half: LockInProfile = { ...EMPTY, modAmpV: 0.02 }
    const { ctx, runs } = runCtx({
      GetLockInConfig: { success: true, data: { amplitude: 0.02 } },
    })
    const got = await makeApplyLockInPreset({ lockinProfile: () => half }).execute(ctx, {})
    expect(runs[0]?.params).toEqual({ mod_on: true, amplitude_v: 0.02 })
    expect(got.success).toBe(true)
    expect(got.data?.['unset']).toEqual(['lockin_mod_freq_hz'])
    expect(String(got.data?.['why'])).toBe('将下发 amplitude_v=0.02;档案未填、因而不下发:lockin_mod_freq_hz')
  })
})

describe('ListLockInPresets', () => {
  it('没配时那一行照样在，带着 `usable: false` 与「去哪儿填」', async () => {
    const { ctx } = runCtx({})
    const got = await makeListLockInPresets({ lockinProfile: () => EMPTY }).execute(ctx, {})
    const rows = got.data?.['presets'] as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['name']).toBe('didv')
    expect(rows[0]?.['usable']).toBe(false)
    // 每一行都明说相位不在组里 —— 免得有人以为是漏了
    expect(rows[0]?.['phase_deg']).toBeNull()
    expect(String(rows[0]?.['phase_note'])).toContain('调制侧 phase 永不下发')
  })
})

// ── AutoPhase ──────────────────────────────────────────────────────────────

/** 与导出脚本 `_PhaseCtx` 同形：按动词脚本化的回包。 */
function phaseCtx(opts: {
  samples: [number, number][]
  phase?: number | null
  fail?: Set<string>
  abortAfter?: number
  readback?: number
  modOnAfter?: number | null
}): { ctx: SkillContext; calls: { verb: string; args: unknown[] }[] } {
  const calls: { verb: string; args: unknown[] }[] = []
  let written: number | null = null
  let aborts = 0
  const controller = new AbortController()
  const signal = {
    get aborted(): boolean {
      aborts += 1
      const hit = opts.abortAfter !== undefined && aborts > opts.abortAfter
      if (hit) controller.abort()
      return hit
    },
  } as AbortSignal
  const modOnAfter = opts.modOnAfter === undefined ? 0 : opts.modOnAfter
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    calls.push({ verb: method, args })
    if (opts.fail?.has(method) === true) {
      return Promise.resolve({ method, args, error: '模拟故障：连接被对端关闭' })
    }
    if (method === 'Signals_ValsGet') {
      const seen = calls.filter((c) => c.verb === 'Signals_ValsGet').length - 1
      const [x, y] = opts.samples[Math.min(seen, opts.samples.length - 1)] ?? [0, 0]
      return Promise.resolve({ method, args, values: [2, [x, y]] })
    }
    if (method === 'LockIn_DemodPhasGet') {
      const v = written === null ? (opts.phase ?? 0) : (opts.readback ?? written)
      return Promise.resolve({ method, args, values: v === null ? [] : [v] })
    }
    if (method === 'LockIn_DemodPhasSet') {
      written = args[1] as number
      return Promise.resolve({ method, args, values: [] })
    }
    if (method === 'LockIn_ModOnOffGet') {
      return Promise.resolve({ method, args, values: modOnAfter === null ? [] : [modOnAfter] })
    }
    return Promise.resolve({ method, args, values: [] })
  }
  let clock = 1_000_000
  const ctx = {
    signal,
    safeCall,
    emergencyCall: safeCall,
    now: () => (clock += 1),
    sleep: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
    depth: 0,
    owner: 't',
    rootCallId: 't',
    approvalSource: 'llm',
  } as unknown as SkillContext
  return { ctx, calls }
}

const SIGNAL: [number, number][] = [
  [2.0e-9, 1.0e-9],
  [2.2e-9, 1.1e-9],
  [1.8e-9, 0.9e-9],
]
const NOISE: [number, number][] = [[1.0e-15, 1.0e-15]]

const PHASE_RIGS: Readonly<Record<string, Parameters<typeof phaseCtx>[0]>> = {
  signal_to_x: { samples: SIGNAL },
  crosstalk_to_y: { samples: SIGNAL },
  fold_negative: { samples: [[1.0e-9, 0.0]], phase: -170.0 },
  noise_floor: { samples: NOISE },
  no_samples: { samples: SIGNAL, fail: new Set(['Signals_ValsGet']) },
  no_current_phase: { samples: SIGNAL, fail: new Set(['LockIn_DemodPhasGet']) },
  write_failed: { samples: SIGNAL, fail: new Set(['LockIn_DemodPhasSet']) },
  readback_mismatch: { samples: SIGNAL, readback: 12.5 },
  aborted: { samples: SIGNAL, abortAfter: 1 },
  close_failed: { samples: SIGNAL, fail: new Set(['LockIn_ModOnOffSet']) },
  close_unconfirmed: { samples: SIGNAL, modOnAfter: null },
  close_still_on: { samples: SIGNAL, modOnAfter: 1 },
  half_indices: { samples: SIGNAL },
}

/**
 * D-HYPOT-1：`r` 单独比。
 *
 * `Math.hypot` 与 CPython 的 `math.hypot` 在最后一位上会分岔
 * （`hypot(1e-15, 1e-15)` 差 1 ULP）。`r` 进的是**证据**，判据是它与 `1e-12` 的比较、
 * 而模型读到的是 `formatG(r, 3)` —— 这一位在那两处都表示不出来。
 *
 * 所以这里**照旧钉住它**，只是钉在「相对差 ≤ 1e-15」上，其余字段逐字深比。
 */
function splitR(d: Record<string, unknown>): { rest: Record<string, unknown>; r?: number } {
  const { r, ...rest } = d
  return typeof r === 'number' ? { rest, r } : { rest }
}

describe('AutoPhase —— 逐格对旧仓', () => {
  for (const [key, want] of Object.entries(golden.phase)) {
    it(`${key}：调用序列与返回都相等`, async () => {
      const { ctx, calls } = phaseCtx(PHASE_RIGS[key]!)
      const got = await makeAutoPhase({ lockinProfile: () => FIXTURE }).execute(ctx, want.params)
      expect(calls.map((c) => [c.verb, c.args])).toEqual(want.calls.map((c) => [c.verb, c.args]))
      expect(got.success).toBe(want.success)
      expect(got.error ?? '').toBe(want.error)

      const mine = splitR({ ...(got.data ?? {}) })
      const theirs = splitR({ ...want.data })
      expect(mine.rest).toEqual(theirs.rest)
      if (theirs.r !== undefined) {
        expect(mine.r).toBeDefined()
        expect(Math.abs((mine.r as number) - theirs.r) / theirs.r).toBeLessThanOrEqual(1e-15)
      } else {
        expect(mine.r).toBeUndefined()
      }
    })
  }

  it('D-HYPOT-1 的差异**只在证据里** —— 模型读到的那个数逐字相同', async () => {
    const { ctx } = phaseCtx(PHASE_RIGS['noise_floor']!)
    const got = await makeAutoPhase({ lockinProfile: () => FIXTURE }).execute(
      ctx,
      golden.phase['noise_floor']!.params,
    )
    // 旧仓那句话里印的是三位有效数字，两侧一字不差；差的那一位在 `data.r` 里。
    expect(got.error).toBe(golden.phase['noise_floor']!.error)
    expect(got.data?.['r']).not.toBe(golden.phase['noise_floor']!.data['r'])
  })
})

describe('AutoPhase 的三条判据，各自单说一次', () => {
  it('**中止时什么都不写** —— 连收尾的关调制都不发', async () => {
    const { calls } = phaseCtx(PHASE_RIGS['aborted']!)
    const rig = phaseCtx(PHASE_RIGS['aborted']!)
    await makeAutoPhase({ lockinProfile: () => FIXTURE }).execute(rig.ctx, golden.phase['aborted']!.params)
    void calls
    // 中止的语义是「停手，别再动仪器」：此刻可能正有一套急停序列在跑，
    // 往里插一条写操作不是收尾，是打岔。
    expect(rig.calls.map((c) => c.verb).filter((v) => v.endsWith('Set'))).toEqual([])
  })

  it('**成功和失败都关调制** —— 一次失败的对齐留下的调制一样污染后面每条判据', async () => {
    for (const key of ['signal_to_x', 'noise_floor', 'write_failed']) {
      const rig = phaseCtx(PHASE_RIGS[key]!)
      await makeAutoPhase({ lockinProfile: () => FIXTURE }).execute(rig.ctx, golden.phase[key]!.params)
      expect(rig.calls.map((c) => c.verb), key).toContain('LockIn_ModOnOffSet')
    }
  })

  it('**折叠跨零**：Python 的 `%` 取模、JS 的 `%` 取余，这一格差 360°', async () => {
    const rig = phaseCtx(PHASE_RIGS['fold_negative']!)
    const got = await makeAutoPhase({ lockinProfile: () => FIXTURE }).execute(
      rig.ctx,
      golden.phase['fold_negative']!.params,
    )
    // 当前 −170°、增量 −90° ⇒ 和是 −80。取模给 +100°，取余给 −260°。
    expect(got.data?.['target_phase_deg']).toBe(100)
    expect(got.data?.['target_phase_deg']).not.toBe(-260)
  })

  it('档案里填了 X/Y 时不必再传参数', async () => {
    const wired: LockInProfile = { ...FIXTURE, xSignalIndex: 86, ySignalIndex: 87 }
    const rig = phaseCtx({ samples: SIGNAL })
    const got = await makeAutoPhase({ lockinProfile: () => wired }).execute(rig.ctx, {
      window_s: 0.3,
    })
    expect(got.success).toBe(true)
    expect(rig.calls[0]?.args).toEqual([[86, 87], 0])
  })
})
