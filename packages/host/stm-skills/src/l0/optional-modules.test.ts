/**
 * 批 3g 里**通用金样驱动不到**的格子。
 *
 * 轨迹金样把每条由回包决定的分支都钉住了。这里补的是另一类：
 *
 * 1. **`0` 是不是一个合法值**（D-ZERO-1 第四次，而这一次那个 0 翻的是一个
 *    「无限」标志位）；
 * 2. **给了一半要把另一半读回来保住** —— 省掉的 I 增益被清零就是一个死环；
 * 3. **一个读不到不连累其余**，以及「读不到 ≠ 零」；
 * 4. 两处**顺序本身就是判据**的地方（护栏先架、失败也要切 RF）。
 */
import { describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import {
  ConfigurePiController, ConfigurePreamp, GetPiController, SetPiControllerOnOff,
} from './optional-controllers.js'
import {
  AutoZeroBeamDeflection, ConfigureBeamDeflection, ConfigureKelvinController,
  GetKelvinController, SetKelvinControllerOnOff, SetLaserPower,
} from './optional-afm.js'
import { GetProbeZController, PulseProbeBias, SetProbeZController } from './optional-multiprobe.js'
import {
  ConfigureHighSpeedSweep, RunRfFrequencySweep, StopRfGenerator,
} from './optional-sweepers.js'
import { ConfigureHighResScope, GetHighResScopeData } from './optional-scopes.js'
import { signalChannels } from './optional-common.js'

function rig(opts: {
  replies?: Record<string, unknown[]>
  /** 同一个动词按**次序**回不同的 body。 */
  seq?: Record<string, unknown[][]>
  fail?: Set<string>
} = {}): { ctx: SkillContext; calls: { verb: string; args: unknown[] }[] } {
  const calls: { verb: string; args: unknown[] }[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push({ verb: m, args: a })
      if (opts.fail?.has(m) === true) {
        return Promise.resolve({ method: m, args: a, error: '模拟故障：连接被对端关闭' })
      }
      const q = opts.seq?.[m]
      if (q !== undefined && q.length > 0) {
        return Promise.resolve({
          method: m, args: a,
          values: q.length > 1 ? (q.shift() as unknown[]) : (q[0] as unknown[]),
        })
      }
      return Promise.resolve({ method: m, args: a, values: opts.replies?.[m] ?? [1] })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
    markers: { emit: () => {} },
  } as unknown as SkillContext
  return { ctx, calls }
}

const verbs = (calls: { verb: string }[]): string[] => calls.map((c) => c.verb)
const argsOf = (calls: { verb: string; args: unknown[] }[], verb: string): unknown[] | undefined =>
  calls.find((c) => c.verb === verb)?.args

// ── D-ZERO-1 第四次 ─────────────────────────────────────────────────────────

describe('ConfigureHighSpeedSweep —— `num_sweeps = 0` 是「一直扫」，不是「扫一次」', () => {
  const base = {
    sweep_signal_index: 24, start: -1, stop: 1, acquire_channels: '0,14',
  }

  it('**`0` 把无限标志翻起来** —— 旧仓的 `or 1` 让这一支永远走不到', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighSpeedSweep.execute(ctx, { ...base, num_sweeps: 0 })
    // `NumSweepsSet(max(n,1), n===0 ? 1 : 0)` —— 次数仍然至少 1，而**标志位是 1**
    expect(argsOf(calls, 'HSSwp_NumSweepsSet')).toEqual([1, 1])
  })

  it('给了正数就是那个次数，标志位是 0', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighSpeedSweep.execute(ctx, { ...base, num_sweeps: 5 })
    expect(argsOf(calls, 'HSSwp_NumSweepsSet')).toEqual([5, 0])
  })

  it('没给就是 1 次 —— 缺省不等于无限', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighSpeedSweep.execute(ctx, base)
    expect(argsOf(calls, 'HSSwp_NumSweepsSet')).toEqual([1, 0])
  })

  it('`null` 算没给（模型那条路上每个可选字段都以 null 到达）', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighSpeedSweep.execute(ctx, { ...base, num_sweeps: null })
    expect(argsOf(calls, 'HSSwp_NumSweepsSet')).toEqual([1, 0])
  })

  it('**停得下来才敢让它无限** —— 那条停止动词确实存在', async () => {
    // 这条是上面那个决定的前提：`HSSwp_Stop` 在中止后的放行清单里。
    const { ctx, calls } = rig()
    const { StopHighSpeedSweep } = await import('./optional-sweepers.js')
    await StopHighSpeedSweep.execute(ctx, {})
    expect(verbs(calls)).toEqual(['HSSwp_Stop'])
  })

  it('`z_controller_off` 那句警告只在真关了的时候出现', async () => {
    const a = rig()
    const r1 = await ConfigureHighSpeedSweep.execute(a.ctx, { ...base, z_controller_off: true })
    expect(String(r1.summary)).toContain('Z 反馈将关闭')
    expect(argsOf(a.calls, 'HSSwp_ZCtrlOffSet')?.[0]).toBe(1)

    const b = rig()
    const r2 = await ConfigureHighSpeedSweep.execute(b.ctx, base)
    expect(String(r2.summary)).not.toContain('Z 反馈将关闭')
  })

  it('通道清单**严格**：一个记号不是整数就整串作废，一次调用都不发', async () => {
    for (const bad of ['0, x', '0,1.5', '   ', 'spec-export']) {
      const { ctx, calls } = rig()
      const r = await ConfigureHighSpeedSweep.execute(ctx, { ...base, acquire_channels: bad })
      expect(r.success, bad).toBe(false)
      expect(r.error).toContain('acquire_channels 解析失败')
      expect(calls).toEqual([])
    }
  })

  it('`signalChannels` 本身', () => {
    expect(signalChannels('0, 2, 14')).toEqual([0, 2, 14])
    expect(signalChannels('0 2 14')).toEqual([0, 2, 14])
    expect(signalChannels('-1')).toEqual([-1])
    expect(signalChannels('0, 1.5')).toBeNull()
    expect(signalChannels('')).toBeNull()
  })
})

// ── 护栏先架好 ──────────────────────────────────────────────────────────────

describe('两个环：限值先写，而且反了的一对界要拒', () => {
  it('PI 环 —— **第一条发出去的就是限值**', async () => {
    const { ctx, calls } = rig()
    await ConfigurePiController.execute(ctx, {
      controller_index: 2, input_index: 0, control_signal_index: 1,
      output_lower_limit: -1, output_upper_limit: 1, setpoint: 0.5,
    })
    // 后面任何一步失败时，手上已经是一组**带界**的参数
    expect(verbs(calls)[0]).toBe('PICtrl_CtrlChPropsSet')
    expect(argsOf(calls, 'PICtrl_CtrlChPropsSet')).toEqual([2, -1, 1])
  })

  it('Kelvin 环 —— 同上，而且限值那一条排在整定之前', async () => {
    const { ctx, calls } = rig()
    await ConfigureKelvinController.execute(ctx, {
      bias_low_limit_v: -2, bias_high_limit_v: 2,
    })
    expect(verbs(calls)[0]).toBe('KelvinCtrl_BiasLimitsSet')
    // 注意实参顺序是 (hi, lo) —— 与技能参数的顺序相反
    expect(argsOf(calls, 'KelvinCtrl_BiasLimitsSet')).toEqual([2, -2])
  })

  it('反了的一对界：**拒，不换过来**，一次调用都不发', async () => {
    const a = rig()
    const r1 = await ConfigurePiController.execute(a.ctx, {
      controller_index: 0, input_index: 0, control_signal_index: 0,
      output_lower_limit: 1, output_upper_limit: -1, setpoint: 0,
    })
    expect(r1.success).toBe(false)
    expect(r1.error).toContain('环会立刻把输出推到轨上')
    expect(a.calls).toEqual([])

    const b = rig()
    const r2 = await ConfigureKelvinController.execute(b.ctx, {
      bias_low_limit_v: 2, bias_high_limit_v: -2,
    })
    expect(r2.error).toContain('Kelvin 环会立刻把偏压推到轨上')
    expect(b.calls).toEqual([])
  })

  it('相等也拒 —— 一对零宽的界不是一对界', async () => {
    const { ctx } = rig()
    const r = await ConfigurePiController.execute(ctx, {
      controller_index: 0, input_index: 0, control_signal_index: 0,
      output_lower_limit: 1, output_upper_limit: 1, setpoint: 0,
    })
    expect(r.success).toBe(false)
  })

  it('**配完环仍是开路的** —— `controller_on: false` 是约定，不是读回来的', async () => {
    const { ctx } = rig()
    const r = await ConfigurePiController.execute(ctx, {
      controller_index: 0, input_index: 0, control_signal_index: 0,
      output_lower_limit: -1, output_upper_limit: 1, setpoint: 0,
    })
    expect(r.data?.['controller_on']).toBe(false)
    expect(String(r.summary)).toContain('环仍开路')
  })

  it('闭合与断开说的是两件不同的事', async () => {
    const a = rig()
    const on = await SetPiControllerOnOff.execute(a.ctx, { controller_index: 3, on: true })
    expect(String(on.summary)).toContain('正在自主驱动输出')
    expect(argsOf(a.calls, 'PICtrl_OnOffSet')).toEqual([3, 1])

    const b = rig()
    const off = await SetPiControllerOnOff.execute(b.ctx, { controller_index: 3, on: false })
    // 「输出停在环最后给的值」—— 不是回零，不是回到你设它之前的样子
    expect(String(off.summary)).toContain('输出停在环最后给的值')
    expect(argsOf(b.calls, 'PICtrl_OnOffSet')).toEqual([3, 0])
  })
})

describe('SetKelvinControllerOnOff —— 调制那一条可以单独跳过', () => {
  it('缺省两条都发', async () => {
    const { ctx, calls } = rig()
    await SetKelvinControllerOnOff.execute(ctx, { on: true })
    expect(verbs(calls)).toEqual(['KelvinCtrl_ModOnOffSet', 'KelvinCtrl_CtrlOnOffSet'])
  })

  it('`modulation_on: false` ⇒ **只发控制器那一条**（调制可能来自外部源）', async () => {
    const { ctx, calls } = rig()
    await SetKelvinControllerOnOff.execute(ctx, { on: true, modulation_on: false })
    expect(verbs(calls)).toEqual(['KelvinCtrl_CtrlOnOffSet'])
  })
})

// ── 给了一半，另一半要读回来保住 ────────────────────────────────────────────

describe('SetProbeZController —— 省掉的那个增益不许被清零', () => {
  it('**只给 P 时先读回 I** —— I 增益归零就是一个死环', async () => {
    const { ctx, calls } = rig({ replies: { MProbeZCtrl_GainGet: [7.5, 0.25] } })
    await SetProbeZController.execute(ctx, { probe: 2, on: true, p_gain: 9 })
    expect(verbs(calls)).toContain('MProbeZCtrl_GainGet')
    // 新的 P，**原来的 I**
    expect(argsOf(calls, 'MProbeZCtrl_GainSet')).toEqual([2, 9, 0.25])
  })

  it('只给 I 时同理', async () => {
    const { ctx, calls } = rig({ replies: { MProbeZCtrl_GainGet: [7.5, 0.25] } })
    await SetProbeZController.execute(ctx, { probe: 2, on: true, i_gain: 0.5 })
    expect(argsOf(calls, 'MProbeZCtrl_GainSet')).toEqual([2, 7.5, 0.5])
  })

  it('一个都不给就**根本不碰增益**', async () => {
    const { ctx, calls } = rig()
    await SetProbeZController.execute(ctx, { probe: 2, on: true })
    expect(verbs(calls)).toEqual(['MProbeZCtrl_OnOffSet'])
  })

  it('读不回那一对时退回 `(0, 0)` —— 与旧仓同一个兜底', async () => {
    const { ctx, calls } = rig({ replies: { MProbeZCtrl_GainGet: [] } })
    await SetProbeZController.execute(ctx, { probe: 1, on: true, p_gain: 3 })
    expect(argsOf(calls, 'MProbeZCtrl_GainSet')).toEqual([1, 3, 0])
  })

  it('读增益失败 ⇒ **整趟失败**，不拿一对猜的数写下去', async () => {
    const { ctx } = rig({ fail: new Set(['MProbeZCtrl_GainGet']) })
    const r = await SetProbeZController.execute(ctx, { probe: 1, on: true, p_gain: 3 })
    expect(r.success).toBe(false)
    expect(r.error).toContain('MProbeZCtrl_GainGet failed')
  })

  it('探针号**没有缺省** —— 省掉它不会悄悄变成探针 0 之外的东西', async () => {
    // 声明里它是必填；这里钉的是「传进来什么就用什么」，
    // 而不是某处偷偷把它换掉。
    const { ctx, calls } = rig()
    await SetProbeZController.execute(ctx, { probe: 3, on: false })
    expect(argsOf(calls, 'MProbeZCtrl_OnOffSet')).toEqual([3, 0])
  })
})

// ── 一个读不到不连累其余 ────────────────────────────────────────────────────

describe('聚合读：一格读不到给 `null`，别的照常交出去', () => {
  it('`GetPiController` 永远 success，失败那一格是 `null`', async () => {
    const { ctx } = rig({ fail: new Set(['PICtrl_PropsGet', 'PICtrl_CtrlChPropsGet']) })
    const r = await GetPiController.execute(ctx, { controller_index: 1 })
    expect(r.success).toBe(true)
    expect(r.data?.['props']).toBeNull()
    expect(r.data?.['output_limits']).toBeNull()
    // 没失败的那几格照常有值
    expect(r.data?.['controller_on']).not.toBeNull()
    expect(r.data?.['controller_index']).toBe(1)
  })

  it('**全都读不到也 success** —— 它报的是「问到了什么」', async () => {
    const { ctx } = rig({
      fail: new Set([
        'KelvinCtrl_CtrlOnOffGet', 'KelvinCtrl_SetpntGet', 'KelvinCtrl_GainGet',
        'KelvinCtrl_BiasLimitsGet', 'KelvinCtrl_ModParamsGet', 'KelvinCtrl_ModOnOffGet',
        'KelvinCtrl_AmpGet', 'KelvinCtrl_CtrlSignalGet',
      ]),
    })
    const r = await GetKelvinController.execute(ctx, {})
    expect(r.success).toBe(true)
    for (const v of Object.values(r.data ?? {})) expect(v).toBeNull()
  })

  it('单元素 body 解一层，多元素保持成表', async () => {
    const { ctx } = rig({
      replies: { MProbeZCtrl_SetpntGet: [2e-10], MProbeZCtrl_GainGet: [1, 2] },
    })
    const r = await GetProbeZController.execute(ctx, { probe: 0 })
    expect(r.data?.['setpoint']).toBe(2e-10)
    expect(r.data?.['gains']).toEqual([1, 2])
  })
})

describe('GetHighResScopeData —— PSD 读不到不许把曲线扔掉', () => {
  it('曲线在手上，PSD 失败只记一条 `psd_error`', async () => {
    const { ctx } = rig({
      replies: { OsciHR_OsciDataGet: [1, 2, 3] },
      fail: new Set(['OsciHR_PSDDataGet']),
    })
    const r = await GetHighResScopeData.execute(ctx, { include_psd: true })
    expect(r.success).toBe(true)
    expect(r.data?.['trace']).toEqual([1, 2, 3])
    // 「我没取到 PSD」与「我什么都没取到」在返回值上分得开
    expect(String(r.data?.['psd_error'])).toContain('模拟故障')
    expect('psd' in (r.data ?? {})).toBe(false)
  })

  it('曲线本身读不到才是失败', async () => {
    const { ctx } = rig({ fail: new Set(['OsciHR_OsciDataGet']) })
    const r = await GetHighResScopeData.execute(ctx, {})
    expect(r.success).toBe(false)
  })

  it('不要 PSD 就**一条都不发**', async () => {
    const { ctx, calls } = rig()
    await GetHighResScopeData.execute(ctx, {})
    expect(verbs(calls)).toEqual(['OsciHR_OsciDataGet'])
  })
})

// ── 失败也要切 RF ───────────────────────────────────────────────────────────

describe('StopRfGenerator —— 停扫失败时**更要**切输出', () => {
  it('停扫报错照样发关输出那一条，而且那句错不丢', async () => {
    const { ctx, calls } = rig({ fail: new Set(['APRFGen_SwpStop']) })
    const r = await StopRfGenerator.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(verbs(calls)).toEqual(['APRFGen_SwpStop', 'APRFGen_RFOutOnOffSet'])
    expect(argsOf(calls, 'APRFGen_RFOutOnOffSet')).toEqual([0])
    expect(String(r.summary)).toContain('扫描停止报错')
  })

  it('关输出那一条失败才算整趟失败', async () => {
    const { ctx } = rig({ fail: new Set(['APRFGen_RFOutOnOffSet']) })
    const r = await StopRfGenerator.execute(ctx, {})
    expect(r.success).toBe(false)
  })
})

describe('RunRfFrequencySweep —— `Infinite` 永远写 0', () => {
  it('**与 HSSwp 刻意相反**：这里没有「扫到你喊停」', async () => {
    const { ctx, calls } = rig()
    await RunRfFrequencySweep.execute(ctx, { lower_hz: 1e9, upper_hz: 2e9 })
    // APRFGen_FreqSwpPropsSet(Mode, Dwell, Repetitions, Infinite, Points, Off_s, AutoOff)
    expect(argsOf(calls, 'APRFGen_FreqSwpPropsSet')?.[3]).toBe(0)
  })

  it('反了的一对频率就拒', async () => {
    const { ctx, calls } = rig()
    const r = await RunRfFrequencySweep.execute(ctx, { lower_hz: 2e9, upper_hz: 1e9 })
    expect(r.success).toBe(false)
    expect(calls).toEqual([])
  })

  it('方向认不出时按 `up` —— 不静默扫反方向', async () => {
    const { ctx, calls } = rig()
    await RunRfFrequencySweep.execute(ctx, { lower_hz: 1e9, upper_hz: 2e9, direction: '斜着' })
    expect(argsOf(calls, 'APRFGen_FreqSwpStart')).toEqual([1])
  })
})

// ── 字面量动词 ──────────────────────────────────────────────────────────────

describe('ConfigureBeamDeflection —— 三条轴三条字面量动词', () => {
  it('每条轴发它自己的那一条', async () => {
    for (const [axis, verb] of [
      ['vertical', 'BeamDefl_VerConfigSet'],
      ['horizontal', 'BeamDefl_HorConfigSet'],
      ['sum', 'BeamDefl_IntConfigSet'],
    ] as const) {
      const { ctx, calls } = rig()
      const r = await ConfigureBeamDeflection.execute(ctx, {
        axis, name: 'defl', units: 'm', calibration: 1e-9,
      })
      expect(r.success, axis).toBe(true)
      expect(verbs(calls)).toEqual([verb])
      expect(calls[0]?.args).toEqual(['defl', 'm', 1e-9, 0])
    }
  })

  it('第四种轴是拒，**一次调用都不发**', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigureBeamDeflection.execute(ctx, {
      axis: 'diagonal', name: 'x', units: 'm', calibration: 1,
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe("未知 axis：'diagonal'（应为 vertical/horizontal/sum）")
    expect(calls).toEqual([])
  })

  it('`AutoZeroBeamDeflection` **不给 data** —— 归零后是多少得去问', async () => {
    const { ctx } = rig()
    const r = await AutoZeroBeamDeflection.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toBeUndefined()
  })
})

describe('ConfigureHighResScope —— 三种触发模式发三串不同的动词', () => {
  const base = { signal_index: 24 }

  it('immediate：四条，没有触发细节', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighResScope.execute(ctx, base)
    expect(verbs(calls)).toEqual([
      'OsciHR_ChSet', 'OsciHR_SamplesSet', 'OsciHR_OversamplSet', 'OsciHR_TrigModeSet',
    ])
    expect(argsOf(calls, 'OsciHR_TrigModeSet')).toEqual([0])
  })

  it('level：多四条电平触发的', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighResScope.execute(ctx, {
      ...base, trigger_mode: 'level', trigger_level: 5e-11, trigger_slope: 'falling',
    })
    expect(verbs(calls).slice(4)).toEqual([
      'OsciHR_TrigLevChSet', 'OsciHR_TrigLevValSet',
      'OsciHR_TrigLevSlopeSet', 'OsciHR_TrigLevHystSet',
    ])
    expect(argsOf(calls, 'OsciHR_TrigLevValSet')).toEqual([5e-11])
    expect(argsOf(calls, 'OsciHR_TrigLevSlopeSet')).toEqual([0]) // falling
  })

  it('digital：多两条', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighResScope.execute(ctx, { ...base, trigger_mode: 'digital' })
    expect(verbs(calls).slice(4)).toEqual(['OsciHR_TrigDigChSet', 'OsciHR_TrigDigSlopeSet'])
  })

  it('认不出的模式按 immediate，认不出的沿按 rising', async () => {
    const { ctx, calls } = rig()
    await ConfigureHighResScope.execute(ctx, { ...base, trigger_mode: '玄学', trigger_slope: '横的' })
    expect(argsOf(calls, 'OsciHR_TrigModeSet')).toEqual([0])
    expect(verbs(calls)).toHaveLength(4)
  })
})

// ── 一个都不给就拒 ──────────────────────────────────────────────────────────

describe('ConfigurePreamp —— 三项各写各的', () => {
  it('`changed` 说清到底动了什么', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigurePreamp.execute(ctx, {
      preamp: 1, channel: 2, gain: 3, input_mode: 0,
    })
    expect(r.data?.['changed']).toEqual(['gain', 'input_mode'])
    expect(verbs(calls)).toEqual(['MCVA5_GainSet', 'MCVA5_InputModeSet'])
    expect(String(r.summary)).toBe('MCVA5 前放 1/2 已设置：gain, input_mode')
  })

  it('**`0` 也算给了** —— input_mode=0 是一个合法档位', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigurePreamp.execute(ctx, { preamp: 0, channel: 0, input_mode: 0 })
    expect(argsOf(calls, 'MCVA5_InputModeSet')).toEqual([0, 0, 0])
    expect(r.data?.['changed']).toEqual(['input_mode'])
  })

  it('一个都不给就拒 —— 一次「什么都没改」的成功看起来和改好了一样', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigurePreamp.execute(ctx, { preamp: 0, channel: 0 })
    expect(r.success).toBe(false)
    expect(r.error).toBe('gain / coupling / input_mode 至少要给一个')
    expect(calls).toEqual([])
  })

  it('`null` 算没给', async () => {
    const { ctx } = rig()
    const r = await ConfigurePreamp.execute(ctx, {
      preamp: 0, channel: 0, gain: null, coupling: null, input_mode: null,
    })
    expect(r.success).toBe(false)
  })
})

describe('两处文案：单位与开关分得开', () => {
  it('`SetLaserPower` 明说**激光开关未变**', async () => {
    const { ctx, calls } = rig()
    const r = await SetLaserPower.execute(ctx, { setpoint: 0.35 })
    // 设一个功率与开一束激光是两件事
    expect(String(r.summary)).toBe('激光功率设定值 = 0.35（激光开关未变）')
    expect(verbs(calls)).toEqual(['Laser_PropsSet'])
  })

  it('`PulseProbeBias` 的 `hold_z` 缺省为真 —— 反馈开着时一发脉冲会扎进表面', async () => {
    const { ctx, calls } = rig()
    await PulseProbeBias.execute(ctx, { probe: 1, width_s: 0.01, value_v: 3 })
    // (probe, wait, width, value, hold_z, abs_rel)
    expect(argsOf(calls, 'MProbeBias_Pulse')).toEqual([1, 1, 0.01, 3, 1, 0])
  })

  it('`hold_z: false` 要显式说', async () => {
    const { ctx, calls } = rig()
    await PulseProbeBias.execute(ctx, {
      probe: 1, width_s: 0.01, value_v: 3, hold_z: false, relative: true,
    })
    expect(argsOf(calls, 'MProbeBias_Pulse')).toEqual([1, 1, 0.01, 3, 0, 1])
  })
})
