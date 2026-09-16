/**
 * 谱学整族里**轨迹金样走不到**的那些格。
 *
 * 金样的合成回包是从协议表的 `returns` 派生的：`2f` 那一格给的是一块 2×2，而表头
 * （两个 `i`）说 6×7。于是两条采集技能在金样里**每一条轨迹**都落在「装不下」那一支
 * 上 —— 成功解开的那条路、别名那张表、`.dat` 兜底那条判据，一格都没有。
 *
 * 另外四个技能（三条通道串 + MLS）的基准参数是 `'spec-export'`，旧仓在参数强转上
 * 当场抛，于是它们在金样里只有一条 `raised`。本仓不抛 —— 那条拒绝长什么样，
 * 只有这里验得到。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAFETY_LIMITS,
  emptyHardwareState,
  slowCallFrom,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  AcquireZSpectr,
  ConfigureSTS,
  ConfigureSTSChannels,
  ConfigureZSpectr,
  GetSTSSafeCond1,
  SetSTSChannels,
  SetSTSSafeCond1,
  SetSTSSafeCond2,
  SetZSpectrChannels,
  coerceIntList,
  makeAcquireSTS,
  makeSetSTSMLSVals,
  strictIntList,
} from './spectroscopy.js'

const S0 = emptyHardwareState('T0')

interface Fixture {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
  budgets: number[]
}

/**
 * 按动词给回包的假仪器。
 *
 * `wireBudget: false` = 宿主**没接** recv 预算那条口（本仓今天的默认状态）。
 */
function fx(
  replies: Readonly<Record<string, SkillCallRecord | 'error'>> = {},
  opts: { wireBudget?: boolean } = {},
): Fixture {
  const calls: { verb: string; args: unknown[] }[] = []
  const budgets: number[] = []
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    calls.push({ verb: method, args })
    const r = replies[method]
    if (r === 'error') return Promise.resolve({ method, args, error: `模拟故障：${method}` })
    if (r !== undefined) return Promise.resolve({ ...r, method, args })
    return Promise.resolve({ method, args, values: [] })
  }
  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: slowCallFrom(
      safeCall,
      opts.wireBudget === true
        ? (m, s, ...a) => {
            budgets.push(s)
            return safeCall(m, ...a)
          }
        : null,
    ),
    runSkill: () => Promise.resolve({ success: false, error: '不分发' } as SkillResultLike),
    now: () => 1,
    sleep: () => Promise.resolve(),
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 't',
    rootCallId: 't',
    approvalSource: 'llm',
  } as unknown as SkillContext
  return { ctx, calls, budgets }
}

/** 一块能真的解开的谱：两个通道 × 三个点，**逐格互不相同**。 */
const SPECTRUM: SkillCallRecord = {
  method: '',
  args: [],
  values: [0, 2, ['Bias (V)', 'Current (A)'], 2, 3, [[-1, 0, 1], [11, 12, 13]], 0, []],
}

/** 一条读得出 npts=4 / nsweeps=1 / 不反扫的 `PropsGet`。 */
const PROPS: SkillCallRecord = { method: '', args: [], values: [1, 1, 0, 4] }
/** 八项时序，积分 0.5 s、建立 0.5 s，其余 0。 */
const TIMING: SkillCallRecord = { method: '', args: [], values: [0, 0, 0, 0, 0.5, 0.5, 0, 0] }

describe('AcquireSTS · 金样走不到的三条路', () => {
  it('解开了 ⇒ 通道整行进 data，别名按**名字**认', async () => {
    const f = fx({ BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING, BiasSpectr_Start: SPECTRUM })
    const got = await makeAcquireSTS({ latestSavedDat: () => Promise.resolve(null) }).execute(f.ctx, {})
    expect(got.success).toBe(true)
    const d = got.data as Record<string, unknown>
    expect(d['spectrum_parsed']).toBe(true)
    expect(d['num_points']).toBe(3)
    expect(d['channel_names']).toEqual(['Bias (V)', 'Current (A)'])
    // 行 = 通道：整行归它自己。转置的读法会给 [-1, 11] / [0, 12]。
    expect(d['Bias (V)']).toEqual([-1, 0, 1])
    expect(d['voltage']).toEqual([-1, 0, 1])
    expect(d['current']).toEqual([11, 12, 13])
    // 没有 `spectrum_unparsed_reason`，但 `spectrum_parsed` **这条路上也在**
    expect('spectrum_unparsed_reason' in d).toBe(false)
  })

  it('解不开、**但盘上有** ⇒ 成功（别把 agent 推去重扫同一个点）', async () => {
    const f = fx({ BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING })
    const got = await makeAcquireSTS({
      latestSavedDat: () => Promise.resolve('C:/data/sts_042.dat'),
    }).execute(f.ctx, {})
    expect(got.success).toBe(true)
    const d = got.data as Record<string, unknown>
    expect(d['spectrum_parsed']).toBe(false)
    expect(d['path']).toBe('C:/data/sts_042.dat')
    // 解不开这件事**照样说出来**——成功不等于「都好」
    expect(String(d['spectrum_unparsed_reason'])).toContain('不是一个谱数据块')
  })

  it('解不开且盘上也没有 ⇒ 失败，而且报文指路去盘上自己看', async () => {
    const f = fx({ BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING })
    const got = await makeAcquireSTS({ latestSavedDat: () => Promise.resolve(null) }).execute(f.ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('这次采集没有在任何地方留下可用的谱')
    expect(got.error).toContain('最近 120 s')
    // 失败也带 data —— 「扫掠跑完了」与「谱没拿到」是两件事
    expect((got.data as Record<string, unknown>)['acquisition_complete']).toBe(true)
  })

  it('起扫失败 ⇒ **原样透传**，不找 .dat（那一发根本没跑）', async () => {
    const f = fx({ BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING, BiasSpectr_Start: 'error' })
    let looked = false
    const got = await makeAcquireSTS({
      latestSavedDat: () => {
        looked = true
        return Promise.resolve(null)
      },
    }).execute(f.ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toBe('模拟故障：BiasSpectr_Start')
    expect(looked).toBe(false)
  })

  it('**刻意不发 `BiasSpectr_PropsSet`** —— 它会把操作员配的保护性 Z 回撤清零', async () => {
    const f = fx({ BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING, BiasSpectr_Start: SPECTRUM })
    await makeAcquireSTS({ latestSavedDat: () => Promise.resolve(null) }).execute(f.ctx, {})
    expect(f.calls.map((c) => c.verb)).toEqual([
      'BiasSpectr_Open',
      'BiasSpectr_PropsGet',
      'BiasSpectr_TimingGet',
      'BiasSpectr_Start',
    ])
  })

  it('recv 预算：接上了就报**真的用上的那个数**', async () => {
    const f = fx(
      { BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING, BiasSpectr_Start: SPECTRUM },
      { wireBudget: true },
    )
    const got = await makeAcquireSTS({ latestSavedDat: () => Promise.resolve(null) }).execute(f.ctx, {})
    // 4 点 × (0.5+0.5) × 1（不反扫）× 1 sweep = 4 s；×1.35 + 45 = 50.4
    expect((got.data as Record<string, unknown>)['sweep_estimate_s']).toBe(4)
    expect((got.data as Record<string, unknown>)['recv_timeout_s']).toBe(50.4)
    expect(f.budgets).toEqual([50.4])
  })

  it('recv 预算：**没接那条口 ⇒ `null`**，不是悄悄退回连接缺省然后声称抬过', async () => {
    const f = fx({ BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING, BiasSpectr_Start: SPECTRUM })
    const got = await makeAcquireSTS({ latestSavedDat: () => Promise.resolve(null) }).execute(f.ctx, {})
    const d = got.data as Record<string, unknown>
    expect(d['recv_timeout_s']).toBeNull()
    // 估算照报 —— 「这条谱要跑多久」与「我们等了多久」是两件事
    expect(d['sweep_estimate_s']).toBe(4)
    expect(f.budgets).toEqual([])
  })

  it('读不到扫掠设定 ⇒ 预算退到**上限**那一侧，并把为什么带上', async () => {
    const f = fx({ BiasSpectr_PropsGet: 'error', BiasSpectr_TimingGet: 'error', BiasSpectr_Start: SPECTRUM }, {
      wireBudget: true,
    })
    const got = await makeAcquireSTS({ latestSavedDat: () => Promise.resolve(null) }).execute(f.ctx, {})
    const d = got.data as Record<string, unknown>
    expect(d['sweep_estimate_s']).toBe(600)
    expect(d['recv_timeout_s']).toBe(855)
    expect((d['sweep_settings'] as Record<string, unknown>)['why']).toBe('读不到扫掠设定，退回保守上限')
  })

  it('`save_basename` 给了才落键，也才进实参', async () => {
    const f = fx({ BiasSpectr_PropsGet: PROPS, BiasSpectr_TimingGet: TIMING, BiasSpectr_Start: SPECTRUM })
    const got = await makeAcquireSTS({ latestSavedDat: () => Promise.resolve(null) }).execute(f.ctx, {
      save_basename: 'grid_03_07',
    })
    expect((got.data as Record<string, unknown>)['save_basename']).toBe('grid_03_07')
    expect(f.calls.at(-1)?.args).toEqual([1, 'grid_03_07'])
  })
})

describe('AcquireZSpectr · 与 STS **相反**的那条结论', () => {
  it('解不开 ⇒ 一律失败：内联返回是唯一的一份', async () => {
    const f = fx({})
    const got = await AcquireZSpectr.execute(f.ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('这个技能不落盘,内联返回是唯一的一份')
    // 而且它**不去找 .dat**（`ZSpectr_Start(1, "")` 不给 basename）
    expect(f.calls.map((c) => c.verb)).toEqual(['ZSpectr_Open', 'ZSpectr_PropsSet', 'ZSpectr_Start'])
  })

  it('解开了 ⇒ z / current / dIdV 三个别名按名字认', async () => {
    const f = fx({
      ZSpectr_Start: {
        method: '',
        args: [],
        values: [0, 3, ['Z (m)', 'Current (A)', 'LIX 1 omega (A)'], 3, 2, [[1, 2], [3, 4], [5, 6]], 0, []],
      },
    })
    const got = await AcquireZSpectr.execute(f.ctx, {})
    expect(got.success).toBe(true)
    const d = got.data as Record<string, unknown>
    expect(d['z']).toEqual([1, 2])
    expect(d['current']).toEqual([3, 4])
    expect(d['dIdV']).toEqual([5, 6])
  })

  it('没有 `Z (` 这种写法时退到「名字以 z 开头」', async () => {
    const f = fx({
      ZSpectr_Start: {
        method: '',
        args: [],
        values: [0, 1, ['Zrel'], 1, 2, [[7, 8]], 0, []],
      },
    })
    const got = await AcquireZSpectr.execute(f.ctx, {})
    expect((got.data as Record<string, unknown>)['z']).toEqual([7, 8])
  })
})

describe('ConfigureSTS · 四步各自的早退，外加那一步**不致命**的', () => {
  for (const [step, verb] of [
    ['开模块', 'BiasSpectr_Open'],
    ['设限值', 'BiasSpectr_LimitsSet'],
    ['设属性', 'BiasSpectr_PropsSet'],
  ] as const) {
    it(`${step}失败 ⇒ 原样透传并停在那一步`, async () => {
      const f = fx({ [verb]: 'error' })
      const got = await ConfigureSTS.execute(f.ctx, { start_v: -1, end_v: 1, num_points: 128 })
      expect(got.success).toBe(false)
      expect(got.error).toBe(`模拟故障：${verb}`)
      expect(f.calls.at(-1)?.verb).toBe(verb)
    })
  }

  it('`AdvPropsSet` 被拒 ⇒ **整趟照样成功**，但那两个键是 `null`', async () => {
    const f = fx({ BiasSpectr_AdvPropsSet: 'error' })
    const got = await ConfigureSTS.execute(f.ctx, { start_v: -1, end_v: 1, num_points: 128 })
    expect(got.success).toBe(true)
    const d = got.data as Record<string, unknown>
    // 「没设上」不是「设成了 false」——一个宣称了某个行为、而那个寄存器根本没碰过
    // 的返回值，正是这一族最想避免的东西。
    expect(d['z_controller_hold']).toBeNull()
    expect(d['reset_bias']).toBeNull()
  })

  it('成功那一趟把 Z-Ctrl Hold 与 Reset Bias 都钉成 On', async () => {
    const f = fx({})
    const got = await ConfigureSTS.execute(f.ctx, { start_v: -1, end_v: 1, num_points: 128 })
    expect((got.data as Record<string, unknown>)['z_controller_hold']).toBe(true)
    expect(f.calls.map((c) => c.args).at(-1)).toEqual([1, 1, 0, 0])
  })
})

describe('ConfigureZSpectr · 三步的早退', () => {
  for (const verb of ['ZSpectr_Open', 'ZSpectr_RangeSet', 'ZSpectr_PropsSet'] as const) {
    it(`${verb} 失败 ⇒ 原样透传`, async () => {
      const f = fx({ [verb]: 'error' })
      const got = await ConfigureZSpectr.execute(f.ctx, {
        z_offset_m: 0,
        z_sweep_distance_m: 1e-9,
        num_points: 64,
      })
      expect(got.success).toBe(false)
      expect(got.error).toBe(`模拟故障：${verb}`)
    })
  }

  it('`backward_sweep=false` 走的是 0，不是被 `or` 吃掉的那个 1（D-ZERO-1 同族）', async () => {
    const f = fx({})
    await ConfigureZSpectr.execute(f.ctx, {
      z_offset_m: 0,
      z_sweep_distance_m: 1e-9,
      num_points: 64,
      backward_sweep: false,
    })
    expect(f.calls.at(-1)?.args).toEqual([0, 64, 1, 1, 2, 1])
  })
})

describe('通道串：两个解析器刻意不同', () => {
  it('宽的那个认 `;`，也认小数写法（截断）', () => {
    expect(coerceIntList('0; 1, 2')).toEqual([0, 1, 2])
    expect(coerceIntList('2.5, 3.9')).toEqual([2, 3])
    expect(coerceIntList([0, 14])).toEqual([0, 14])
    expect(coerceIntList(null)).toEqual([])
  })

  it('严的那个只认逗号、只认整数字面量', () => {
    expect(strictIntList('0, 1, 2')).toEqual([0, 1, 2])
    expect(strictIntList('0; 1')).toBeNull()
    expect(strictIntList('2.5')).toBeNull()
  })

  it('两个都不认十六进制 —— `Number("0x10")` 是 16，而 Python 抛', () => {
    expect(coerceIntList('0x10')).toBeNull()
    expect(strictIntList('0x10')).toBeNull()
  })

  it('解析不了 ⇒ **一次调用都不发**，并说清要什么', async () => {
    for (const skill of [ConfigureSTSChannels, SetSTSChannels, SetZSpectrChannels]) {
      const f = fx({})
      const got = await skill.execute(f.ctx, { channel_indexes: 'spec-export' })
      expect(got.success).toBe(false)
      expect(got.error).toContain('通道索引解析不了')
      expect(f.calls).toEqual([])
    }
  })

  it('同一串 `0; 1`：`ConfigureSTSChannels` 拒，`SetSTSChannels` 收 —— **刻意不同**', async () => {
    // D-CHANNELS-1 的形状：两个看起来一样的函数行为不一样，而这正是将来重构时
    // 最想合并的东西。合并了就会**默默改掉**一串已经在用的通道号写法。
    const a = fx({})
    const strict = await ConfigureSTSChannels.execute(a.ctx, { channel_indexes: '0; 1' })
    expect(strict.success).toBe(false)
    expect(a.calls).toEqual([])

    const b = fx({})
    const lenient = await SetSTSChannels.execute(b.ctx, { channel_indexes: '0; 1' })
    expect(lenient.success).toBe(true)
    expect(b.calls).toEqual([{ verb: 'BiasSpectr_ChsSet', args: [[0, 1]] }])
  })

  it('`*_ChsSet` 收**一个**实参（线格式自己带长度）', async () => {
    const f = fx({})
    await SetSTSChannels.execute(f.ctx, { channel_indexes: '0,14' })
    expect(f.calls).toEqual([{ verb: 'BiasSpectr_ChsSet', args: [[0, 14]] }])
  })
})

describe('SetSTSMLSVals · 那七串是 `str`，于是内核的数值包络绕过去了', () => {
  const good = {
    bias_start_v: '-1.0, 0.5',
    bias_end_v: '0.5, 1.0',
    initial_settling_s: '0.01, 0.01',
    settling_s: '0.01, 0.01',
    integration_s: '0.02, 0.02',
    steps: '64, 64',
    lockin_run: '0, 1',
  }

  it('两段齐了 ⇒ 下发，并报段数', async () => {
    const f = fx({})
    const got = await makeSetSTSMLSVals().execute(f.ctx, good)
    expect(got.success).toBe(true)
    expect(got.data).toEqual({ num_segments: 2 })
    expect(f.calls[0]?.args[0]).toBe(2)
  })

  it('一串解析不了 ⇒ 拒绝，一次调用都不发', async () => {
    const f = fx({})
    const got = await makeSetSTSMLSVals().execute(f.ctx, { ...good, steps: 'spec-export' })
    expect(got.success).toBe(false)
    expect(got.error).toContain('MLS steps 解析不了')
    expect(f.calls).toEqual([])
  })

  it('一段都没有 ⇒ 拒绝', async () => {
    const f = fx({})
    const got = await makeSetSTSMLSVals().execute(f.ctx, { ...good, bias_start_v: '' })
    expect(got.success).toBe(false)
    expect(got.error).toBe('no MLS segments provided (bias_start_v is empty)')
  })

  it('七串不等长 ⇒ 拒绝并印出每一串的长度', async () => {
    const f = fx({})
    const got = await makeSetSTSMLSVals().execute(f.ctx, { ...good, steps: '64' })
    expect(got.success).toBe(false)
    expect(got.error).toContain('MLS per-segment arrays must all have 2 elements')
    expect(got.error).toContain("'steps': 1")
    expect(f.calls).toEqual([])
  })

  for (const key of ['bias_start_v', 'bias_end_v']) {
    it(`${key} 越过全局偏压包络 ⇒ 拒绝（这是这条路上**唯一**的一道）`, async () => {
      const f = fx({})
      const got = await makeSetSTSMLSVals().execute(f.ctx, { ...good, [key]: '-1.0, 50' })
      expect(got.success).toBe(false)
      expect(got.error).toBe(`MLS ${key}[1] = 50 V is outside the global bias safety bound [-10, 10] V`)
      expect(f.calls).toEqual([])
    })
  }

  it('包络**由外面注入** ⇒ 收紧之后原来合法的值被拒，两个界各一次（D-LIMITS-1）', async () => {
    const tight = { ...DEFAULT_SAFETY_LIMITS, bias_min_v: -2, bias_max_v: 2 }
    // 下界：−5 在出厂默认 ±10 里是合法的，在注入的 ±2 里不是。
    const lowered = await makeSetSTSMLSVals({ effectiveLimits: () => tight }).execute(fx({}).ctx, {
      ...good,
      bias_start_v: '-5, 0',
    })
    expect(lowered.success).toBe(false)
    expect(lowered.error).toBe('MLS bias_start_v[0] = -5 V is outside the global bias safety bound [-2, 2] V')
    // 上界：同理，另一头。
    const raised = await makeSetSTSMLSVals({ effectiveLimits: () => tight }).execute(fx({}).ctx, {
      ...good,
      bias_end_v: '0, 5',
    })
    expect(raised.success).toBe(false)
    expect(raised.error).toContain('bias_end_v[1] = 5 V')
    // **判的和印的必须是同一个数**：报文里那对界就是注入的那一对。
    expect(raised.error).toContain('[-2, 2] V')
  })

  it('下发失败 ⇒ 原样透传', async () => {
    const f = fx({ BiasSpectr_MLSValsSet: 'error' })
    const got = await makeSetSTSMLSVals().execute(f.ctx, good)
    expect(got.error).toBe('模拟故障：BiasSpectr_MLSValsSet')
  })
})

describe('三个 safe-condition：Nanonis 根本没有这个 API', () => {
  for (const [name, skill] of [
    ['SetSTSSafeCond1', SetSTSSafeCond1],
    ['GetSTSSafeCond1', GetSTSSafeCond1],
    ['SetSTSSafeCond2', SetSTSSafeCond2],
  ] as const) {
    it(`${name}：**一次 TCP 都不发**就拒，并指向 Z 谱学那边`, async () => {
      const f = fx({})
      const got = await skill.execute(f.ctx, {
        condition: 0,
        threshold: 0,
        signal_index: 0,
        comparison: 0,
      })
      expect(got.success).toBe(false)
      expect(got.error).toContain('only exists for Z Spectroscopy')
      expect(f.calls).toEqual([])
    })
  }
})
