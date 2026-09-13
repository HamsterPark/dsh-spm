/**
 * 缺陷⑫：**这个状态是不是我改的**。
 *
 * 进针前切到进针参数组是一次**临时**改动，而临时改动的定义是「有人负责放回去」。
 * 这一组逐条钉住「什么时候不切」「什么时候放回」，以及那个刻意的例外：
 * **软停时不还设定点**。
 */
import { describe, expect, it } from 'vitest'
import { PresetStore, type ApproachProfile, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { applyApproachPreset, restoreZctrl, type ZctrlSnapshot } from './approach-preset.js'

const PROFILE: ApproachProfile = { pGainM: 3e-12, iGainMPerS: 180e-9, setpointA: 50e-12 }
const PROFILE_NO_SP: ApproachProfile = { pGainM: 3e-12, iGainMPerS: 180e-9, setpointA: null }
/** `approach` 组解析出来的三个数。 */
const WANT = { p_gain: 3e-12, time_constant_s: 3e-12 / 180e-9, i_gain: 180e-9 }
const OTHER = { p_gain: 1e-12, time_constant_s: 1e-5, i_gain: 1e-7 }

interface Script {
  /** 子技能名 → 返回。没列的一律成功 + 空 data。 */
  readonly runs?: Record<string, SkillResultLike>
  readonly aborted?: boolean
  /** 让某个子技能**抛**，而不是返回失败。 */
  readonly throws?: string
}

function rig(s: Script = {}): {
  ctx: SkillContext
  calls: { skill: string; params: Record<string, unknown> }[]
} {
  const calls: { skill: string; params: Record<string, unknown> }[] = []
  const ctrl = new AbortController()
  if (s.aborted === true) ctrl.abort()
  const ctx = {
    signal: ctrl.signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: () => Promise.resolve({ method: '', args: [] }),
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: (n: string, p: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
      calls.push({ skill: n, params: { ...p } })
      if (s.throws === n) throw new Error('分派本身炸了')
      return Promise.resolve(s.runs?.[n] ?? { success: true, data: {} })
    },
  } as unknown as SkillContext
  return { ctx, calls }
}

const gainsOk = (g: Record<string, number>): SkillResultLike => ({ success: true, data: { ...g } })
const setpointOk = (v: number): SkillResultLike => ({ success: true, data: { setpoint_a: v } })

describe('applyApproachPreset —— 什么时候**不切**', () => {
  it('档案没配：如实跳过，说清去哪儿填', async () => {
    const { ctx, calls } = rig()
    const [snap, note] = await applyApproachPreset(ctx, {}, 'AutoApproach')
    expect(snap).toBeNull()
    expect(note['zctrl_preset']).toBe('approach')
    expect(note['zctrl_preset_applied']).toBe(false)
    expect(note['zctrl_preset_note']).toBe(
      '仪器档案里没有可用的进针参数组,本次进针**沿用当前 Z 控制器增益**(即改动前的行为):' +
        '进针参数组尚未配置(P 增益, I 增益 为空)。请在「设置 → 仪器档案 → 进针参数」里填写' +
        ' —— 这组数只由用户输入,不经模型。',
    )
    // **一次子技能都不调** —— 没得切就没有要读的东西
    expect(calls).toEqual([])
  })

  it('读不到当前增益：不切 —— 放不回去就不该改', async () => {
    const { ctx, calls } = rig({ runs: { GetZCtrlGain: { success: false, error: '读不到' } } })
    const [snap, note] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE })
    expect(snap).toBeNull()
    expect(note['zctrl_preset_note']).toBe(
      '读不到当前 Z 控制器增益 —— **不切换**,进针沿用当前增益。' +
        '(能不能把它放回去,取决于切换前读到了什么;读不到就切,等于拿一个' +
        '没人会知道来历的永久改动换一点速度。)',
    )
    expect(calls.map((c) => c.skill)).toEqual(['GetZCtrlGain'])
  })

  it('**缺一个数就是读不到**，不拿两个数凑一组', async () => {
    const { ctx } = rig({
      runs: { GetZCtrlGain: { success: true, data: { p_gain: 3e-12, i_gain: 180e-9 } } },
    })
    const [snap] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE })
    expect(snap).toBeNull()
  })

  it('要改设定点但读不到当前设定点：不切', async () => {
    const { ctx, calls } = rig({
      runs: {
        GetZCtrlGain: gainsOk(OTHER),
        GetSetpoint: { success: false, error: '读不到' },
      },
    })
    const [snap, note] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE })
    expect(snap).toBeNull()
    expect(note['zctrl_preset_note']).toBe(
      '进针参数组要改设定点,但读不到当前设定点 —— **不切换**(放不回去就不该改)。',
    )
    expect(calls.map((c) => c.skill)).toEqual(['GetZCtrlGain', 'GetSetpoint'])
  })

  it('**本来就是那组值：不写 ⇒ 不用放回。嵌套因此是免费的**', async () => {
    const { ctx, calls } = rig({
      runs: { GetZCtrlGain: gainsOk(WANT), GetSetpoint: setpointOk(50e-12) },
    })
    const [snap, note] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE })
    expect(snap).toBeNull()
    // `null` 而不是 false：「没切」与「切失败」是两件事
    expect(note['zctrl_preset_applied']).toBeNull()
    expect(note['zctrl_preset_note']).toBe('当前已经是进针参数组的值,未改动。')
    expect(calls.map((c) => c.skill)).toEqual(['GetZCtrlGain', 'GetSetpoint'])
  })

  it('「一样」走 `valuesMatch` —— float32 往返不该被判成「不一样」', async () => {
    // 真机读回来的是 float32：3e-12 → 2.9999999880125916e-12
    const f32 = {
      p_gain: 2.9999999880125916e-12,
      time_constant_s: 1.6666666666666667e-5 * (1 + 1e-8),
      i_gain: 1.8000000536441803e-7,
    }
    const { ctx } = rig({
      runs: { GetZCtrlGain: gainsOk(f32), GetSetpoint: setpointOk(4.999999969612645e-11) },
    })
    const [snap, note] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE })
    expect(note['zctrl_preset_applied']).toBeNull()
    expect(snap).toBeNull()
  })
})

describe('applyApproachPreset —— 切了之后', () => {
  it('切成功：快照带着调用前的值，留痕说清结束时会放回', async () => {
    const { ctx, calls } = rig({
      runs: {
        GetZCtrlGain: gainsOk(OTHER),
        GetSetpoint: setpointOk(100e-12),
        ApplyZCtrlPreset: { success: true, data: { trace: ['一行来历'] } },
      },
    })
    const [snap, note] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE }, 'ApproachTip')
    expect(snap).toEqual({ gains: OTHER, setpointA: 100e-12 })
    expect(note['zctrl_preset_applied']).toBe(true)
    expect(note['zctrl_preset_trace']).toEqual(['一行来历'])
    expect(note['zctrl_before']).toEqual(OTHER)
    expect(note['zctrl_preset_note']).toBe(
      'ApproachTip 开跑前已切到进针参数组(值来自仪器档案,不经模型);结束时会放回调用前的增益。',
    )
    expect(calls.map((c) => c.skill)).toEqual(['GetZCtrlGain', 'GetSetpoint', 'ApplyZCtrlPreset'])
    expect(calls[2]?.params).toEqual({ preset: 'approach' })
  })

  it('**切失败也返回快照** —— 「调用失败」不等于「什么都没改」', async () => {
    const { ctx } = rig({
      runs: {
        GetZCtrlGain: gainsOk(OTHER),
        GetSetpoint: setpointOk(100e-12),
        ApplyZCtrlPreset: { success: false, error: '设定点写入失败' },
      },
    })
    const [snap, note] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE })
    // ApplyZCtrlPreset 可能已经写进了增益、随后在设定点上失败
    expect(snap).toEqual({ gains: OTHER, setpointA: 100e-12 })
    expect(note['zctrl_preset_applied']).toBe(false)
    expect(note['zctrl_preset_note']).toBe(
      '切进针参数组失败:设定点写入失败;进针继续,但用的是切换失败后的增益 —— 结束时仍会尝试放回原值。',
    )
  })

  it('进针组不带设定点：不读也不比设定点', async () => {
    const { ctx, calls } = rig({ runs: { GetZCtrlGain: gainsOk(OTHER) } })
    const [snap] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE_NO_SP })
    expect(snap?.setpointA).toBeNull()
    expect(calls.map((c) => c.skill)).toEqual(['GetZCtrlGain', 'ApplyZCtrlPreset'])
  })

  it('**永不抛** —— 分派本身炸了也只留一句话', async () => {
    const { ctx } = rig({ throws: 'ApplyZCtrlPreset', runs: { GetZCtrlGain: gainsOk(OTHER) } })
    const [snap, note] = await applyApproachPreset(ctx, { approachProfile: () => PROFILE_NO_SP })
    expect(snap).toBeNull()
    expect(String(note['zctrl_preset_note'])).toMatch(/^切进针参数组时出错:分派本身炸了;进针沿用当前增益。$/)
  })

  it('自定义组不遮蔽 `approach` —— 档案才是它的真源', async () => {
    const store = new PresetStore()
    // 建不出叫 approach 的自定义组（保留名），所以这里试的是：存储里有别的组时
    // `approach` 仍然只看档案
    store.upsert({ name: 'gentle', p_gain: '9p', i_gain: '900n' })
    const { ctx } = rig({ runs: { GetZCtrlGain: gainsOk(OTHER) } })
    const [snap] = await applyApproachPreset(ctx, {
      store,
      approachProfile: () => PROFILE_NO_SP,
    })
    expect(snap).toEqual({ gains: OTHER, setpointA: null })
  })
})

describe('restoreZctrl', () => {
  const SNAP: ZctrlSnapshot = { gains: OTHER, setpointA: 100e-12 }

  it('没有快照就什么都不做', async () => {
    const { ctx, calls } = rig()
    expect(await restoreZctrl(ctx, null, 'X')).toEqual({})
    expect(calls).toEqual([])
  })

  it('增益与设定点都放回去', async () => {
    const { ctx, calls } = rig()
    const note = await restoreZctrl(ctx, SNAP, 'AutoApproach')
    expect(calls).toEqual([
      { skill: 'SetZCtrlGain', params: OTHER },
      { skill: 'SetSetpoint', params: { setpoint_a: 100e-12 } },
    ])
    expect(note['zctrl_restored']).toBe(true)
    expect(note['zctrl_restored_gains']).toEqual(OTHER)
    expect(note['zctrl_restored_setpoint_a']).toBe(100e-12)
    expect(note['zctrl_restore_note']).toBe('AutoApproach 结束,Z 控制器已放回调用前的值。')
  })

  it('**软停：不还设定点** —— 还原会让针尖移动，而软停只停不动', async () => {
    const { ctx, calls } = rig({ aborted: true })
    const note = await restoreZctrl(ctx, SNAP, 'AutoApproach')
    // 增益照放（改增益不命令任何位移），设定点不放
    expect(calls.map((c) => c.skill)).toEqual(['SetZCtrlGain'])
    expect(note['zctrl_setpoint_left_at_approach']).toBe(true)
    expect(note['zctrl_setpoint_note']).toBe(
      '用户叫停 —— **没有还原设定点**(还原会让针尖移动,而软停只停不动)。' +
        `当前设定点仍是进针组的值;调用前是 1e-10。要还原请显式 SetSetpoint。`,
    )
    // 这个**组合**要说出来，别让人以为一切都回去了
    expect(note['zctrl_restored']).toBe(true)
    expect(note['zctrl_restored_setpoint_a']).toBeUndefined()
  })

  it('软停但本来就没有设定点要还：不多说一句', async () => {
    const { ctx } = rig({ aborted: true })
    const note = await restoreZctrl(ctx, { gains: OTHER, setpointA: null }, 'X')
    expect(note['zctrl_setpoint_left_at_approach']).toBeUndefined()
  })

  it('放回失败：说清增益可能仍停在进针组', async () => {
    const { ctx } = rig({ runs: { SetZCtrlGain: { success: false, error: '写后回读不一致' } } })
    const note = await restoreZctrl(ctx, SNAP, 'X')
    expect(note['zctrl_restored']).toBe(false)
    expect(note['zctrl_restore_error']).toBe('写后回读不一致')
    expect(note['zctrl_restore_note']).toBe(
      '放回调用前的 Z 控制器参数**失败** —— 增益可能仍停在进针组,' +
        '请核对后再扫图(进针组的快增益会一路带进成像)。',
    )
  })

  it('设定点放回失败也算整体失败', async () => {
    const { ctx } = rig({ runs: { SetSetpoint: { success: false, error: '炸了' } } })
    const note = await restoreZctrl(ctx, SNAP, 'X')
    expect(note['zctrl_restored']).toBe(false)
    expect(note['zctrl_restore_error']).toBe('炸了')
  })

  it('**永不抛** —— 放回时炸了，`zctrl_restored` 给 null 不是 false', async () => {
    const { ctx } = rig({ throws: 'SetZCtrlGain' })
    const note = await restoreZctrl(ctx, SNAP, 'X')
    // `null` = 不知道放回去没有；`false` = 知道没放回去。两件事
    expect(note['zctrl_restored']).toBeNull()
    expect(String(note['zctrl_restore_note'])).toContain('**增益可能仍停在进针组**')
  })
})
