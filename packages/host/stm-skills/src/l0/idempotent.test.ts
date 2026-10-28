import {
  emptyHardwareState,
  slowCallFrom,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
  type TransportInfo,
} from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { makeAcquireDeltaFCurve } from './deltaf-curve.js'
import { IDEMPOTENT_RETRY_PAUSE_MS, callIdempotent } from './idempotent.js'
import {
  AcquireSTS,
  AcquireZSpectr,
  ConfigureSTS,
  ConfigureSTSChannels,
  ConfigureSTSTiming,
  ConfigureZSpectr,
  ConfigureZSpectrTiming,
  SetSTSChannels,
  SetZSpectrChannels,
} from './spectroscopy.js'

/**
 * 谱学技能对幂等调用的那一次重做（R1–R9）。R1–R7 的语义搬自旧仓
 * `tests/v2/unit/skills/builtins/test_spectroscopy_transport_retry.py`；R8、R9 是本仓加的。
 * 端到端（真 `InstrumentService` 带出标记 → 技能重做）在 `bundle/dsh-spm/src/instrument-calls.test.ts` 的 E1。
 */

const S0 = emptyHardwareState('T0')
const TIMEOUT: TransportInfo = { kind: 'Timeout', maybeDelivered: true }

/** 仪器层对传输层失败的记法：带前缀的错误加上标记。 */
const transportFail = (text: string): Partial<SkillCallRecord> => ({ error: text, transport: TIMEOUT })

/** 每个动词一串排好的回包，排完了就回成功。记下发了什么、睡了几次。 */
function scripted(script: Readonly<Record<string, readonly Partial<SkillCallRecord>[]>> = {}) {
  const sent: string[] = []
  const sleeps: number[] = []
  const queues = new Map(Object.entries(script).map(([verb, replies]) => [verb, [...replies]]))
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    sent.push(method)
    const next = queues.get(method)?.shift()
    return Promise.resolve({ method, args, values: [], ...next })
  }
  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: slowCallFrom(safeCall, null),
    runSkill: () => Promise.resolve({ success: false, error: '不分发' } as SkillResultLike),
    now: () => 1,
    sleep: (ms: number) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 't',
    rootCallId: 't',
    approvalSource: 'llm',
  } as unknown as SkillContext
  return { ctx, sent, sleeps }
}

const STS = { start_v: -1, end_v: 1, num_points: 128 }

describe('谱学技能的幂等重做', () => {
  it('R1 ConfigureSTS 的 LimitsSet 传输层失败一次 ⇒ 停 1 s 重做，配置成功', async () => {
    const f = scripted({ BiasSpectr_LimitsSet: [transportFail("Timeout: 'BiasSpectr.LimitsSet' 超过 5000ms 未收到回复")] })
    const got = await ConfigureSTS.execute(f.ctx, STS)
    expect(got.success, got.error).toBe(true)
    expect(f.sent).toEqual([
      'BiasSpectr_Open',
      'BiasSpectr_LimitsSet',
      'BiasSpectr_LimitsSet',
      'BiasSpectr_PropsGet', // 读当前扫掠数（D-STS-?）
      'BiasSpectr_PropsSet',
      'BiasSpectr_AdvPropsSet',
    ])
    expect(f.sleeps).toEqual([IDEMPOTENT_RETRY_PAUSE_MS])
  })

  it('R2 控制器答的错误（没有传输标记）不重做：错误原样，LimitsSet 只发一次', async () => {
    const f = scripted({ BiasSpectr_LimitsSet: [{ error: 'NanonisError: Access Denied: Parameter is Locked' }] })
    const got = await ConfigureSTS.execute(f.ctx, STS)
    expect(got.success).toBe(false)
    expect(got.error).toBe('NanonisError: Access Denied: Parameter is Locked')
    expect(f.sent).toEqual(['BiasSpectr_Open', 'BiasSpectr_LimitsSet'])
    expect(f.sleeps).toEqual([])
  })

  it('R3 两次都是传输层失败 ⇒ 失败，错误里第二次的原因在前、第一次的原因不丢；恰好两次', async () => {
    const f = scripted({
      BiasSpectr_LimitsSet: [
        transportFail('Timeout: BiasSpectr.LimitsSet 超过 5000ms 未收到回复'),
        transportFail('SocketError: BiasSpectr.LimitsSet：read ECONNRESET'),
      ],
    })
    const got = await ConfigureSTS.execute(f.ctx, STS)
    expect(got.success).toBe(false)
    expect(got.error).toBe(
      'SocketError: BiasSpectr.LimitsSet：read ECONNRESET (retried once after a transport failure; ' +
        'first attempt: Timeout: BiasSpectr.LimitsSet 超过 5000ms 未收到回复)',
    )
    expect(f.sent.filter((v) => v === 'BiasSpectr_LimitsSet')).toHaveLength(2)
  })

  it('R4 起扫永不重做：AcquireSTS 与 AcquireZSpectr 的 Start 传输层失败 ⇒ 失败、Start 只发一次', async () => {
    for (const [skill, start] of [
      [AcquireSTS, 'BiasSpectr_Start'],
      [AcquireZSpectr, 'ZSpectr_Start'],
    ] as const) {
      const f = scripted({ [start]: [transportFail(`Timeout: ${start} 超过 5000ms 未收到回复`)] })
      const got = await skill.execute(f.ctx, {})
      expect(got.success, start).toBe(false)
      expect(f.sent.filter((v) => v === start), start).toHaveLength(1)
      expect(f.sleeps, start).toEqual([])
    }
  })

  it('R5 采集技能里的幂等步骤会重做：STS 的读、Z 谱的 Open 之后那条 PropsSet', async () => {
    const sts = scripted({
      BiasSpectr_PropsGet: [transportFail('Timeout: 读属性没回')],
      BiasSpectr_Start: [{ error: 'NanonisError: 到此为止' }],
    })
    await AcquireSTS.execute(sts.ctx, {})
    expect(sts.sent.slice(0, 4)).toEqual(['BiasSpectr_Open', 'BiasSpectr_PropsGet', 'BiasSpectr_PropsGet', 'BiasSpectr_TimingGet'])

    const z = scripted({
      ZSpectr_PropsSet: [transportFail('Timeout: 设属性没回')],
      ZSpectr_Start: [{ error: 'NanonisError: 到此为止' }],
    })
    await AcquireZSpectr.execute(z.ctx, {})
    // Z 谱和偏压谱一样，在 Start 之前读两个设定口算 recv 预算
    expect(z.sent).toEqual(['ZSpectr_Open', 'ZSpectr_PropsSet', 'ZSpectr_PropsSet', 'ZSpectr_PropsGet', 'ZSpectr_TimingGet', 'ZSpectr_Start'])
  })

  it('R6 配置一族各自的 setter 传输层失败一次 ⇒ 恰好发两次、配置成功', async () => {
    const cases = [
      [ConfigureZSpectr, { z_offset_m: 0, z_sweep_distance_m: 1e-9, num_points: 64 }, 'ZSpectr_RangeSet'],
      [ConfigureSTSTiming, {}, 'BiasSpectr_TimingSet'],
      [ConfigureSTSChannels, { channel_indexes: '0, 1' }, 'BiasSpectr_ChsSet'],
      [ConfigureZSpectrTiming, {}, 'ZSpectr_TimingSet'],
    ] as const
    for (const [skill, params, setter] of cases) {
      const f = scripted({ [setter]: [transportFail(`Timeout: ${setter} 没回`)] })
      const got = await skill.execute(f.ctx, params)
      expect(got.success, `${skill.spec.name}: ${got.error ?? ''}`).toBe(true)
      expect(f.sent.filter((v) => v === setter), skill.spec.name).toHaveLength(2)
    }
  })

  it('R6 SetSTSChannels / SetZSpectrChannels 不在名单里：只发一次', async () => {
    for (const [skill, verb] of [
      [SetSTSChannels, 'BiasSpectr_ChsSet'],
      [SetZSpectrChannels, 'ZSpectr_ChsSet'],
    ] as const) {
      const f = scripted({ [verb]: [transportFail(`Timeout: ${verb} 没回`)] })
      const got = await skill.execute(f.ctx, { channel_indexes: '0, 1' })
      expect(got.success, verb).toBe(false)
      expect(f.sent, verb).toEqual([verb])
    }
  })

  it('R7 不带标记的记录（中止门的拒绝、测试替身）原样放行，不重做', async () => {
    const f = scripted({ BiasSpectr_LimitsSet: [{ error: "abort_latched: 中止已闩上——'BiasSpectr_LimitsSet' 不在中止安全名单里" }] })
    const got = await ConfigureSTS.execute(f.ctx, STS)
    expect(got.success).toBe(false)
    expect(got.error).toMatch(/^abort_latched:/)
    expect(got.error).not.toContain('retried once')
    expect(f.sent).toEqual(['BiasSpectr_Open', 'BiasSpectr_LimitsSet'])
  })

  it('R10 ConfigureSTS 读当前扫掠数的 PropsGet 传输层失败一次 ⇒ 停 1 s 重读，读到的值照样写回', async () => {
    const f = scripted({
      BiasSpectr_PropsGet: [transportFail('Timeout: BiasSpectr.PropsGet 没回'), { values: [0, 8, 1, 200] }],
    })
    const got = await ConfigureSTS.execute(f.ctx, STS)
    expect(got.success, got.error).toBe(true)
    expect(f.sent.filter((v) => v === 'BiasSpectr_PropsGet')).toHaveLength(2)
    expect(f.sleeps).toEqual([IDEMPOTENT_RETRY_PAUSE_MS])
    expect(got.data).toMatchObject({ num_sweeps: 8, num_sweeps_source: 'preserved' })
  })

  it('R8 纵深防御：有人把不可重发的命令包进来，带标记的失败也不重做', async () => {
    const f = scripted({ ZSpectr_Start: [transportFail('Timeout: ZSpectr.Start 没回')] })
    const rec = await callIdempotent(f.ctx, 'ZSpectr_Start', 1, '')
    expect(rec.error).toBe('Timeout: ZSpectr.Start 没回')
    expect(f.sent).toEqual(['ZSpectr_Start'])
    expect(f.sleeps).toEqual([])
  })

  it('R9 AcquireDeltaFCurve 只有两条预算读会重做；Open、RangeSet、PropsSet 带标记的失败不重做', async () => {
    const f = scripted({
      PLL_OutOnOffGet: [{ values: [1] }],
      PLL_CenterFreqGet: [{ values: [30000] }],
      PLL_FreqShiftGet: [{ values: [-1] }],
      PLL_AmpCtrlSetpntGet: [{ values: [5e-11] }],
      ZSpectr_Open: [transportFail('Timeout: Open 没回')],
      ZSpectr_RangeSet: [transportFail('Timeout: RangeSet 没回')],
      ZSpectr_PropsSet: [transportFail('Timeout: PropsSet 没回')],
      ZSpectr_PropsGet: [transportFail('Timeout: PropsGet 没回')],
      ZSpectr_TimingGet: [transportFail('Timeout: TimingGet 没回')],
      ZSpectr_Start: [{ error: 'NanonisError: 到此为止' }],
    })
    await makeAcquireDeltaFCurve().execute(f.ctx, { z_sweep_distance_m: 5e-10, channel_indexes: '3,0' })
    expect(f.sent).toEqual([
      'PLL_OutOnOffGet',
      'PLL_CenterFreqGet',
      'PLL_FreqShiftGet',
      'PLL_AmpCtrlSetpntGet',
      'ZSpectr_Open',
      'ZSpectr_ChsSet',
      'ZSpectr_RangeSet',
      'ZSpectr_PropsSet',
      'Util_SessionPathGet',
      'ZSpectr_PropsGet',
      'ZSpectr_PropsGet',
      'ZSpectr_TimingGet',
      'ZSpectr_TimingGet',
      'ZSpectr_Start',
    ])
  })
})
