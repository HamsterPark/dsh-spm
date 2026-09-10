/**
 * `SkillKernel` 的测试。用一个假技能 `_Probe` 把 K0–K18 整条路走一遍。
 *
 * **每一道闸都要有「它挡住了」和「它放行了」两条**——只有拒绝那一侧的测试，
 * 证明不了闸门没有把一切都拦掉。
 */
import { describe, expect, it, vi } from 'vitest'
import { emptyHardwareState, type HardwareState } from './hardware-state.js'
import {
  AbortRequestedError,
  BusyError,
  SkillKernel,
  diffState,
  explainValidation,
  explanationSuffix,
  stripAuditOnly,
  type KernelDeps,
  type KernelRecord,
  type Skill,
  type SkillResultLike,
} from './skill-kernel.js'

const S0 = emptyHardwareState('T0')

/** 一个可脚本化的假技能。 */
function probe(over: Partial<Skill> = {}, result: SkillResultLike = { success: true, summary: '_Probe: ok' }): Skill {
  return {
    spec: {
      name: '_Probe',
      description: '内核探针',
      parameters: [
        // 有量纲参数在真技能里一律声明 `float`（509 个全是）——schema 侧才把它渲染成
        // JSON string。夹具原来写成 'string'，那会让它整个漏出 SI 机制之外。
        { name: 'setpoint_a', type: 'float', unit: 'A', required: true },
        // `required: false` 要**显式写**：省略等于必填（Python 的 dataclass 缺省是 True）
        { name: 'mode', type: 'string', allowedValues: ['fast', 'slow'], required: false },
        { name: 'count', type: 'number', minValue: 1, maxValue: 10, required: false },
      ],
      preconditions: ['z_controller_on'],
      ...over.spec,
    },
    execute: over.execute ?? ((): Promise<SkillResultLike> => Promise.resolve(result)),
    ...(over.rollback === undefined ? {} : { rollback: over.rollback }),
    ...(over.validateParams === undefined ? {} : { validateParams: over.validateParams }),
  }
}

function deps(over: Partial<KernelDeps> = {}): KernelDeps {
  return {
    snapshot: () => ({ ...S0, z_controller_on: true }),
    clock: () => 1000,
    ...over,
  }
}

const OK_ARGS = { setpoint_a: '100p' }

describe('K1 · SI 解析', () => {
  it('strict 参数拒绝**裸数字字符串**——前缀掉了是解析错误，不是一个小十亿倍的合法值', async () => {
    const k = new SkillKernel(deps())
    const o = await k.run(probe(), { setpoint_a: '1e-10' })
    expect(o.kind).toBe('refused')
    expect(o.code).toBe('si_parse')
    // 前缀逐字保留：既有会话与测试都按它读
    expect(o.text.startsWith('[_Probe] precondition_failed: ')).toBe(true)
  })

  it('**真 number 有意放行**——这不是漏洞，是给内部调用者留的门', async () => {
    // 模型那一侧由工具 schema 挡：有量纲参数声明成 string，模型发不出 number。
    // 而 composite 的子步、执行器、测试本来就持有数字，逼它们先格式化成 '100p'
    // 再解析回来，只是给每个内部调用点加一次犯错机会。
    const k = new SkillKernel(deps())
    expect((await k.run(probe(), { setpoint_a: 1e-10 })).kind).toBe('ok')
  })

  it('完全解析不出来的字符串照样拒', async () => {
    const k = new SkillKernel(deps())
    expect((await k.run(probe(), { setpoint_a: '大概一百皮安' })).code).toBe('si_parse')
  })

  it('带前缀的字符串放行，并且**解析成数**交给技能', async () => {
    let seen: unknown
    const k = new SkillKernel(deps())
    const o = await k.run(
      probe({ execute: (_c, p) => { seen = p['setpoint_a']; return Promise.resolve({ success: true }) } }),
      OK_ARGS,
    )
    expect(o.kind).toBe('ok')
    expect(seen).toBe(1e-10)
  })

  it('K6：省略 `required` 的参数没传 ⇒ 拒绝，和 schema 广告的一致', async () => {
    const o = await new SkillKernel(deps()).run(
      probe({
        spec: {
          name: '_Probe',
          description: '内核探针',
          parameters: [{ name: 'q', type: 'string', description: '问' }],
        },
      }),
      {},
    )
    expect(o.kind).toBe('refused')
    expect(o.text).toContain("缺少必填参数 'q'")
  })

  it('枚举参数**不走** SI 解析——否则一次合法调用会被解析器拒掉', async () => {
    // Python 的 `_si_params` 跳过带 allowed_values 的参数（枚举本来就精确）。
    // 内核这一侧曾经只看「有没有单位」，于是会拿 'low' 去 parseQuantity 然后拒掉。
    let seen: unknown
    const o = await new SkillKernel(deps()).run(
      probe({
        spec: {
          name: '_Probe',
          description: '内核探针',
          parameters: [
            { name: 'bias_v', type: 'float', unit: 'V', allowedValues: ['low', 'high'], required: true },
          ],
        },
        execute: (_c, p): Promise<SkillResultLike> => {
          seen = p['bias_v']
          return Promise.resolve({ success: true, summary: 'ok' })
        },
      }),
      { bias_v: 'low' },
    )
    expect(o.kind).toBe('ok')
    expect(seen).toBe('low')
  })

  it('非 float 的有量纲参数也不走 SI 解析——单位只是个标签，没有量级可掉', async () => {
    // 真技能里 17 个这样的参数（px/ms/s 的 int，以及 CreateZCtrlPreset 那三个
    // **技能自己解析**的 str）。内核越权去解析它们，等于替技能做了它没委托的事。
    let seen: unknown
    const o = await new SkillKernel(deps()).run(
      probe({
        spec: {
          name: '_Probe',
          description: '内核探针',
          parameters: [{ name: 'pixels', type: 'int', unit: 'px', required: true }],
        },
        execute: (_c, p): Promise<SkillResultLike> => {
          seen = p['pixels']
          return Promise.resolve({ success: true, summary: 'ok' })
        },
      }),
      { pixels: 512 },
    )
    expect(o.kind).toBe('ok')
    expect(seen).toBe(512)
  })
})

describe('K2 · 中止闩', () => {
  it('闩上时拒绝，并结束本轮', async () => {
    const k = new SkillKernel(deps({ abortLatched: () => true }))
    const o = await k.run(probe(), OK_ARGS)
    expect(o.kind).toBe('refused')
    expect(o.code).toBe('abort_latched')
    expect(o.concludeTurn).toBe(true)
  })
  it('没闩上就放行', async () => {
    const k = new SkillKernel(deps({ abortLatched: () => false }))
    expect((await k.run(probe(), OK_ARGS)).kind).toBe('ok')
  })
})

describe('K3 · 样品闸只在 depth 0 判', () => {
  it('depth 0 判', async () => {
    const k = new SkillKernel(deps({ sampleGate: () => '[sample_gate] 没选样品' }))
    expect((await k.run(probe(), OK_ARGS)).code).toBe('sample_gate')
  })
  it('**子步继承上层的准入，不重复判**', async () => {
    const k = new SkillKernel(deps({ sampleGate: () => '[sample_gate] 没选样品' }))
    expect((await k.run(probe(), OK_ARGS, { depth: 1 })).kind).toBe('ok')
  })
})

describe('K5 · 快照在闸门之前', () => {
  it('**被拒绝的调用也有耗时与参数哈希**——不然「为什么被拒」事后无从复原', async () => {
    const snap = vi.fn(() => ({ ...S0, z_controller_on: true }))
    const k = new SkillKernel(deps({ snapshot: snap, safetyGate: () => '[safety_gate] 拒' }))
    const o = await k.run(probe(), OK_ARGS)
    expect(o.kind).toBe('refused')
    expect(o.argsHash).toMatch(/^[0-9a-f]{6}$/)
    expect(snap).toHaveBeenCalled() // 闸门拒之前就取过快照
  })
})

describe('K6 · 参数校验', () => {
  it('缺必填', async () => {
    const k = new SkillKernel(deps())
    const o = await k.run(probe(), {})
    expect(o.code).toBe('invalid_params')
    expect(o.text).toContain("缺少必填参数 'setpoint_a'")
  })
  it('枚举外的值', async () => {
    const k = new SkillKernel(deps())
    const o = await k.run(probe(), { ...OK_ARGS, mode: 'turbo' })
    expect(o.text).toContain('只能是')
  })
  it('越界要附**教学文案**，不是一句冷冰冰的 out of range', async () => {
    const k = new SkillKernel(deps())
    const o = await k.run(probe(), { ...OK_ARGS, count: 99 })
    expect(o.text).toContain('超过上限')
  })
  it('strict 参数越界时，教学文案要说清「写成带前缀的字符串」', () => {
    const msg = explainValidation({ name: 'x_m', type: 'string', unit: 'm', maxValue: 1e-6 }, 1, 'max')
    expect(msg).toContain('带 SI 前缀的字符串')
    expect(msg).toContain('不要用')
  })
})

describe('K8 · 前置条件：不满足时先刷新再判', () => {
  it('缓存说不满足、刷新之后满足 ⇒ **放行**（1.8 修缓存那一半，这里修判定那一半）', async () => {
    let refreshed = false
    const k = new SkillKernel(
      deps({
        snapshot: () => ({ ...S0, z_controller_on: false }), // 陈值
        refreshState: async () => {
          refreshed = true
          return { ...S0, z_controller_on: true } // 真实硬件其实已经开了
        },
      }),
    )
    const o = await k.run(probe(), OK_ARGS)
    expect(refreshed).toBe(true)
    expect(o.kind).toBe('ok')
  })

  it('刷新之后仍不满足 ⇒ 拒，消息里带伴随字段', async () => {
    const st = { ...S0, z_controller_on: false, z_controller_status: 'SafeTip' }
    const k = new SkillKernel(deps({ snapshot: () => st, refreshState: async () => st }))
    const o = await k.run(probe(), OK_ARGS)
    expect(o.code).toBe('precondition_failed')
    expect(o.text).toContain('SafeTip')
  })

  it('前置检查**自己抛了** ⇒ fail-closed（判据坏了不等于条件满足）', async () => {
    const k = new SkillKernel(
      deps({
        snapshot: () => ({ ...S0, z_controller_on: false }),
        refreshState: async () => {
          throw new Error('读不到')
        },
      }),
    )
    const o = await k.run(probe(), OK_ARGS)
    expect(o.code).toBe('precondition_crashed')
  })
})

describe('K9 · 锁', () => {
  it('拿不到锁 ⇒ busy，**不回滚**（没跑过的东西没有可回滚的）', async () => {
    const rollback = vi.fn(async () => {})
    const k = new SkillKernel(
      deps({
        acquireLock: () => Promise.reject(new BusyError('另一个 owner 正在用')),
      }),
    )
    const o = await k.run(probe({ rollback }), OK_ARGS)
    expect(o.kind).toBe('busy')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('跑完一定释放锁——**包括抛异常的路径**', async () => {
    const release = vi.fn()
    const k = new SkillKernel(deps({ acquireLock: async () => release }))
    await k.run(probe({ execute: () => Promise.reject(new Error('炸了')) }), OK_ARGS)
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('K12 · 写回缓存', () => {
  it('成功才写 data', async () => {
    const applyPatch = vi.fn()
    const k = new SkillKernel(deps({ applyPatch }))
    await k.run(probe({}, { success: true, data: { bias_v: 1.5 } }), OK_ARGS)
    expect(applyPatch).toHaveBeenCalledWith({ bias_v: 1.5 })
  })

  it('失败**不**写 data——失败技能的 data 里可能是「意图值」而不是回读值', async () => {
    const applyPatch = vi.fn()
    const k = new SkillKernel(deps({ applyPatch }))
    await k.run(probe({}, { success: false, error: 'x', data: { bias_v: 99 } }), OK_ARGS)
    expect(applyPatch).not.toHaveBeenCalled()
  })

  it('但 `_verified_state` **总是**写——技能自己说「这一条我回读过」', async () => {
    const applyPatch = vi.fn()
    const k = new SkillKernel(deps({ applyPatch }))
    await k.run(
      probe({}, { success: false, error: 'x', data: { bias_v: 99, _verified_state: { scan_running: false } } }),
      OK_ARGS,
    )
    expect(applyPatch).toHaveBeenCalledWith({ scan_running: false })
  })
})

describe('K13 · 组文本', () => {
  it('失败带全部 data（去掉审计专用键）', () => {
    expect(explanationSuffix({ a: 1, safe_mode_raw: { tip_ready: false } }, false)).toBe('\n{"a":1}')
  })

  it('成功只带 detail —— 无差别附加整个 data 会让每次返回都变长', () => {
    expect(explanationSuffix({ a: 1, detail: '第 2 轮收敛' }, true)).toBe('\ndetail: 第 2 轮收敛')
    expect(explanationSuffix({ a: 1 }, true)).toBe('')
  })

  it('审计专用键**留在 data 里给记录**，只从模型看到的文本里去掉', () => {
    expect(stripAuditOnly({ a: 1, safe_mode_raw: 2 })).toEqual({ a: 1 })
  })

  it('超长落盘并留引用', async () => {
    const offload = vi.fn(() => 'artifacts/tool_returns/abc.txt')
    const k = new SkillKernel(deps({ offload }))
    const o = await k.run(probe({}, { success: true, summary: 'x'.repeat(3000) }), OK_ARGS)
    expect(o.textRef).toBe('artifacts/tool_returns/abc.txt')
    expect(o.text.length).toBeLessThan(3000)
    expect(o.text).toContain('全文已落盘')
  })
})

describe('K15 · 状态增量', () => {
  it('只比非时变字段——时间戳与 stale 不算变化', () => {
    const a: HardwareState = { ...S0, timestamp: 'T0', bias_v: 1 }
    const b: HardwareState = { ...S0, timestamp: 'T9', stale: true, bias_v: 2 }
    expect(diffState(a, b)).toEqual({ bias_v: 2 })
  })
  it('数组按元素比', () => {
    const a: HardwareState = { ...S0, z_controller_names: ['a', 'b'] }
    expect(diffState(a, { ...a })).toEqual({})
    expect(diffState(a, { ...a, z_controller_names: ['a', 'c'] })).toEqual({ z_controller_names: ['a', 'c'] })
  })
})

describe('K18 · 异常', () => {
  it('中止**不回滚**——人喊停之后回滚会把仪器又动一遍', async () => {
    const rollback = vi.fn(async () => {})
    const k = new SkillKernel(deps())
    const o = await k.run(
      probe({ rollback, execute: () => Promise.reject(new AbortRequestedError('操作员中止')) }),
      OK_ARGS,
    )
    expect(o.kind).toBe('aborted')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('其它异常回滚，回滚成功记 rolled_back', async () => {
    const k = new SkillKernel(deps())
    const o = await k.run(probe({ rollback: async () => {}, execute: () => Promise.reject(new Error('炸')) }), OK_ARGS)
    expect(o.kind).toBe('rolled_back')
  })

  it('回滚自己也炸 ⇒ 记 failed 而不是把回滚的错盖住原错', async () => {
    const emitted: string[] = []
    const k = new SkillKernel(deps())
    const o = await k.run(
      probe({ rollback: () => Promise.reject(new Error('回滚也炸')), execute: () => Promise.reject(new Error('原错')) }),
      OK_ARGS,
      { markers: { emit: (kind) => void emitted.push(kind) } },
    )
    expect(o.kind).toBe('failed')
    expect(o.text).toContain('原错')
    expect(emitted).toContain('rollback_failed')
  })

  it('**内核永不抛**——所有失败都表达成 outcome', async () => {
    const k = new SkillKernel(deps())
    await expect(k.run(probe({ execute: () => Promise.reject(new Error('x')) }), OK_ARGS)).resolves.toBeDefined()
  })
})

describe('成败都记 markers', () => {
  it('成功记 skill_ok，失败记 skill_failed，崩了记 skill_crashed', async () => {
    const seen: string[] = []
    const m = { emit: (k: string): void => void seen.push(k) }
    const k = new SkillKernel(deps())
    await k.run(probe(), OK_ARGS, { markers: m })
    await k.run(probe({}, { success: false, error: 'x' }), OK_ARGS, { markers: m })
    await k.run(probe({ execute: () => Promise.reject(new Error('x')) }), OK_ARGS, { markers: m })
    expect(seen).toEqual(['skill_ok', 'skill_failed', 'skill_crashed'])
  })
})

describe('K0 · 管理员覆盖建工具与执行共用同一个函数', () => {
  it('覆盖生效：把参数上限调窄之后，原来合法的值被拒', async () => {
    const k = new SkillKernel(
      deps({
        effectiveSpec: (s) => ({
          ...s,
          parameters: s.parameters.map((p) => (p.name === 'count' ? { ...p, maxValue: 2 } : p)),
        }),
      }),
    )
    expect((await k.run(probe(), { ...OK_ARGS, count: 5 })).code).toBe('invalid_params')
  })
})

describe('K16 · 记录挂在唯一的漏斗上', () => {
  /** 把一个技能推向指定结局的最小配置。**每一种都要有**——漏一种就是漏一类记录。 */
  const paths: [string, Partial<KernelDeps>, Partial<Skill>, Record<string, unknown>][] = [
    ['ok', {}, {}, { setpoint_a: '1p' }],
    ['si_parse 拒绝', {}, {}, { setpoint_a: 'abc' }],
    ['中止闩', { abortLatched: () => true }, {}, { setpoint_a: '1p' }],
    ['样品闸', { sampleGate: () => '没有样品' }, {}, { setpoint_a: '1p' }],
    ['参数校验', {}, {}, {}],
    ['安全闸', { safetyGate: () => '不行' }, {}, { setpoint_a: '1p' }],
    ['前置条件', { snapshot: () => ({ ...S0, z_controller_on: false }) }, {}, { setpoint_a: '1p' }],
    [
      '执行失败',
      {},
      { execute: (): Promise<SkillResultLike> => Promise.resolve({ success: false, error: '炸了' }) },
      { setpoint_a: '1p' },
    ],
    [
      '异常',
      {},
      { execute: (): Promise<SkillResultLike> => Promise.reject(new Error('boom')) },
      { setpoint_a: '1p' },
    ],
    [
      '占用',
      { acquireLock: () => Promise.reject(new BusyError('忙')) },
      {},
      { setpoint_a: '1p' },
    ],
  ]

  for (const [name, over, skillOver, params] of paths) {
    it(`${name} 也进 record —— 一次被拒的调用正是「为什么什么都没发生」本身`, async () => {
      const seen: KernelRecord[] = []
      await new SkillKernel({ ...deps(), ...over, record: (r) => seen.push(r) }).run(
        probe(skillOver),
        params,
      )
      expect(seen).toHaveLength(1)
      expect(seen[0]?.spec.name).toBe('_Probe')
    })
  }

  it('记的是**解析过**的参数 —— 记 100p 而不是 1e-10，事后就没法按数值查', async () => {
    const seen: KernelRecord[] = []
    await new SkillKernel({ ...deps(), record: (r) => seen.push(r) }).run(probe(), {
      setpoint_a: '100p',
    })
    expect(seen[0]?.params['setpoint_a']).toBe(1e-10)
  })

  it('K1 解析失败时记原样入参 —— 那时还没有解析过的版本', async () => {
    const seen: KernelRecord[] = []
    await new SkillKernel({ ...deps(), record: (r) => seen.push(r) }).run(probe(), {
      setpoint_a: 'abc',
    })
    expect(seen[0]?.params['setpoint_a']).toBe('abc')
    expect(seen[0]?.outcome.code).toBe('si_parse')
  })

  it('**记录抛出不打断技能**', async () => {
    const o = await new SkillKernel({
      ...deps(),
      record: () => {
        throw new Error('记录库炸了')
      },
    }).run(probe(), { setpoint_a: '1p' })
    expect(o.kind).toBe('ok')
  })

  it('approvalSource 原样传下去 —— 硬闸对模型和人的答案不同', async () => {
    const seen: KernelRecord[] = []
    const k = new SkillKernel({ ...deps(), record: (r) => seen.push(r) })
    await k.run(probe(), { setpoint_a: '1p' }, { approvalSource: 'human' })
    await k.run(probe(), { setpoint_a: '1p' })
    expect(seen.map((r) => r.approvalSource)).toEqual(['human', 'llm'])
  })
})
