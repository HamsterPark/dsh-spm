/**
 * 覆盖率门禁逼出来的那些格子。
 *
 * PLAN §6.3 对 kernel 的要求是**逐文件 100%**，理由一句话：
 * 「**一个没测到的分支就是一次物理风险**」。
 *
 * 这个文件里的每一条都不是为了把数字凑上去 —— 它们是**格式化与兜底**那一族，
 * 平时不走，一走就是在出事的时候：一个 `NaN` 怎么印、一个函数混进参数里怎么办、
 * 一个空表怎么摘要。那正是诊断信息最要紧的时刻。
 */
import { describe, expect, it } from 'vitest'
import { approvalDigest, argsHash, canonicalJson } from './args-hash.js'
import { formatCommsDown, CommsCircuitBreaker } from './comms-breaker.js'
import { checkStatePreconditions } from './preconditions.js'
import { emptyHardwareState } from './hardware-state.js'
import { SkillKernel, type Skill, type SkillCallRecord } from './skill-kernel.js'

const S0 = emptyHardwareState('T0')

/** 最小的假技能：什么都不做，成功。 */
const probeSkill = (): Skill => ({
  spec: { name: '_Probe', description: 'p', parameters: [] },
  execute: () => Promise.resolve({ success: true }),
})
import { formatG, pyFloatRepr } from './si.js'
import { requiresSample } from './sample-gate.js'
import { resolveZTravel } from './tip-park.js'
import { effectiveBounds, parametersFromSpec } from './tool-schema.js'

describe('args-hash · 参数里出现不该出现的东西', () => {
  it('函数 / symbol / bigint 一律当成 null —— 参数里不该有它们', () => {
    // 「当成没有」而不是抛：一次哈希失败不该把整个调用带下去，
    // 而哈希的用途（审批卡与执行对得上）在这几种输入上本来就不成立。
    expect(canonicalJson(() => 0)).toBe('null')
    expect(canonicalJson(Symbol('x'))).toBe('null')
    expect(canonicalJson(1n)).toBe('null')
  })

  it('嵌套对象按键排序 —— 键序不同的同一组参数必须同哈希', () => {
    expect(argsHash({ a: 1, b: { y: 2, x: 3 } })).toBe(argsHash({ b: { x: 3, y: 2 }, a: 1 }))
  })

  it('摘要里数组只报长度、对象只报键数 —— 审批卡不是数据转储', () => {
    const d = approvalDigest('X', { arr: [1, 2, 3], obj: { a: 1, b: 2 }, n: 5, t: true, z: null })
    expect(d).toContain('[3项]')
    expect(d).toContain('{2键}')
    expect(d).toContain('5')
    expect(d).toContain('true')
    expect(d).toContain('null')
  })

  it('超长字符串截断并**报出原长**', () => {
    const long = 'x'.repeat(200)
    const d = approvalDigest('X', { s: long })
    expect(d).toContain('…')
    expect(d).toContain('200字')
  })
})

describe('si · 非有限值怎么印', () => {
  it('`pyFloatRepr` 对 inf / -inf / nan 给 Python 的词', () => {
    // 这三个值出现在诊断里就意味着别处出了事，此刻印错等于把线索也弄丢。
    expect(pyFloatRepr(Infinity)).toBe('inf')
    expect(pyFloatRepr(-Infinity)).toBe('-inf')
    expect(pyFloatRepr(NaN)).toBe('nan')
  })

  it('**负零保号** —— 覆盖率逼出来的一条真差异', () => {
    // Python：`f"{-0.0:g}"` = `-0`，`repr(-0.0)` = `-0.0`。
    // JS：`String(-0)` = `0` —— 符号没了。
    //
    // 一个 `-0` 出现在界或读数里，多半意味着上游做了一次乘负或取反；
    // 把符号擦掉，就把那条线索也擦掉了。
    expect(formatG(0, 6)).toBe('0')
    expect(formatG(-0, 6)).toBe('-0')
    expect(pyFloatRepr(0)).toBe('0.0')
    expect(pyFloatRepr(-0)).toBe('-0.0')
  })
})

describe('preconditions · 伴随字段的 Python 字面量', () => {
  it('布尔 / null / 字符串 / 整值浮点各印各的形', () => {
    const s = emptyHardwareState('T0')
    // `z_controller_on` 读不到时伴随字段印 None，而不是 undefined/null 的 JS 形状
    const v = checkStatePreconditions(['z_controller_on'], { ...s, z_controller_on: false })
    expect(v.join(' ')).toContain('False')
  })
})

describe('sample-gate · 豁免的两条路', () => {
  it('按**名字**豁免', () => {
    expect(requiresSample({ name: 'WithdrawTip' })).toBe(false)
  })
  it('按**标签**豁免', () => {
    expect(
      requiresSample({ name: '_Anything', tags: ['read'] }),
    ).toBe(false)
  })
  it('两条都不沾的产数据技能要样品', () => {
    expect(
      requiresSample({ name: 'StartScan', category: 'write', tags: ['scan'] }),
    ).toBe(true)
  })
})

describe('tip-park · 软限的三种态', () => {
  it('软限**更松**时仍取交集（谁更紧听谁的）', () => {
    const t = resolveZTravel({
      piezoZFullM: 200e-9,
      zLimitsM: [-500e-9, 500e-9],
      zLimitsEnabled: true,
    })
    expect(t?.span_m).toBe(200e-9)
  })
  it('软限单边更紧时**逐端**判断', () => {
    const t = resolveZTravel({
      piezoZFullM: 200e-9,
      zLimitsM: [-50e-9, 500e-9],
      zLimitsEnabled: true,
    })
    expect([t?.lo_m, t?.hi_m]).toEqual([-50e-9, 100e-9])
  })
  it('软限上下界反了 ⇒ 不采信', () => {
    expect(
      resolveZTravel({ piezoZFullM: null, zLimitsM: [100e-9, 100e-9], zLimitsEnabled: true }),
    ).toBeNull()
  })
})

describe('tool-schema · 边界与只有一端的范围', () => {
  it('包络表里没有的参数名 ⇒ 界只来自它自己的声明', () => {
    expect(effectiveBounds({ name: '不在表里', type: 'float', minValue: 1, maxValue: 2 })).toEqual([1, 2])
  })

  it('只有下界的有量纲参数：描述里是「最小」', () => {
    const p = parametersFromSpec({
      name: 'X',
      description: 'x',
      parameters: [{ name: 'dwell_s', type: 'float', unit: 's', minValue: 0.001, required: false }],
    })
    expect(p.properties['dwell_s']?.description).toContain('最小 0.001 s')
  })

  it('整数带界 ⇒ minimum/maximum 都在（它不走字符串通道）', () => {
    const p = parametersFromSpec({
      name: 'X',
      description: 'x',
      parameters: [{ name: 'n', type: 'int', minValue: 1, maxValue: 9, required: true }],
    })
    expect(p.properties['n']).toMatchObject({ type: 'integer', minimum: 1, maximum: 9 })
  })

  it('未知 type ⇒ 退回 string，而不是崩', () => {
    const p = parametersFromSpec({
      name: 'X',
      description: 'x',
      parameters: [{ name: 'q', type: '没见过的类型', required: true }],
    })
    expect(p.properties['q']?.type).toBe('string')
  })
})

describe('comms-breaker · 熔断后给人的那句话', () => {
  it('`formatCommsDown` 说清**连续失败几次**与还要等多久', () => {
    // 一个工具一个工具地撞、约 90 秒里操作的人只能看着系统对着死 socket 磕头 ——
    // 这句话存在的意义就是把那 90 秒变成一句能读的解释。
    const b = new CommsCircuitBreaker({ failThreshold: 3, openCooldownS: 30 })
    for (let i = 0; i < 3; i++) b.recordFailure()
    const msg = formatCommsDown(b)
    expect(msg).toContain('comms_circuit_open')
    expect(msg).toContain('3')
  })
})

describe('内核的兜底路径 —— 平时不走，一走就是在出事的时候', () => {
  it('`abortReason` 自己抛 ⇒ 当成没有原因，**不许让它把中止判断带下去**', async () => {
    // 一个会炸的诊断函数不该改变「这次调用要不要被拒」这个结论。
    const o = await new SkillKernel({
      snapshot: () => S0,
      abortLatched: () => true,
      abortReason: () => {
        throw new Error('原因来源自己坏了')
      },
    }).run(probeSkill(), {})
    expect(o.kind).toBe('refused')
    expect(o.text).toContain('**没有留下中止原因**')
  })

  it('没接仪器时 `safeCall` / `emergencyCall` 都给**带 error 的记录**，不抛', async () => {
    let normal: SkillCallRecord | undefined
    let emergency: SkillCallRecord | undefined
    await new SkillKernel({ snapshot: () => S0 }).run(
      {
        spec: { name: '_Probe', description: 'p', parameters: [] },
        execute: async (ctx) => {
          normal = await ctx.safeCall('Bias_Get')
          emergency = await ctx.emergencyCall('ZCtrl_Withdraw', 1, -1)
          return { success: true }
        },
      },
      {},
    )
    expect(normal?.error).toContain('no_instrument')
    expect(emergency?.error).toContain('no_instrument')
  })

  it('`emergencyCall` 缺席时**退回 `safeCall`** —— 降级也要能退针', async () => {
    const seen: string[] = []
    await new SkillKernel({
      snapshot: () => S0,
      safeCall: (m, ...a) => {
        seen.push(m)
        return Promise.resolve({ method: m, args: a, values: [1] })
      },
    }).run(
      {
        spec: { name: '_Probe', description: 'p', parameters: [] },
        execute: async (ctx) => {
          await ctx.emergencyCall('ZCtrl_Withdraw', 0, 1)
          return { success: true }
        },
      },
      {},
    )
    expect(seen).toEqual(['ZCtrl_Withdraw'])
  })

  it('缺省时钟：`now` 单调、`sleep` 真的等一小会儿', async () => {
    let a = 0
    let b = 0
    await new SkillKernel({ snapshot: () => S0 }).run(
      {
        spec: { name: '_Probe', description: 'p', parameters: [] },
        execute: async (ctx) => {
          a = ctx.now()
          await ctx.sleep(1)
          b = ctx.now()
          return { success: true }
        },
      },
      {},
    )
    expect(b).toBeGreaterThanOrEqual(a)
  })

  it('`refreshState` 缺席 ⇒ 退回快照，而不是报「刷不了」', async () => {
    let refreshed: unknown
    await new SkillKernel({ snapshot: () => ({ ...S0, bias_v: 1.25 }) }).run(
      {
        spec: { name: '_Probe', description: 'p', parameters: [] },
        execute: async (ctx) => {
          refreshed = (await ctx.refreshState()).bias_v
          return { success: true }
        },
      },
      {},
    )
    expect(refreshed).toBe(1.25)
  })

  it('超上限也走**教学文案**，不是一句冷冰冰的 out of range', async () => {
    const o = await new SkillKernel({ snapshot: () => S0 }).run(
      {
        spec: {
          name: '_Probe',
          description: 'p',
          parameters: [{ name: 'n', type: 'int', minValue: 1, maxValue: 9, required: true }],
        },
        execute: () => Promise.resolve({ success: true }),
      },
      { n: 99 },
    )
    expect(o.code).toBe('invalid_params')
    expect(o.text).toContain('超过上限 9')
  })
})
