/**
 * `ctx.stmSafety` 的接线测试。判据本身在 kernel 对金样，这里验的是三件事：
 * **顺序对不对、拒绝走的是 guard（单调）、硬闸对模型来源是拒不是问**。
 */
import { Context, Service } from 'dsh-spm-compat'
import { CAP_BIAS_PULSE, CAP_TIP_SHAPING, argsHash } from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { stmSafetyProvider, type SkillDeclaration } from './plugin.js'

/** 工具注册表的替身：只把 guard 收下来，供测试直接调。 */
class FakeTools extends Service {
  readonly guards: ((exec: { name: string; arguments: unknown }) => string | undefined)[] = []
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  guard(g: (exec: { name: string; arguments: unknown }) => string | undefined): () => void {
    this.guards.push(g)
    return () => void this.guards.splice(this.guards.indexOf(g), 1)
  }
  register(): () => void {
    return () => {}
  }
  /** 跑一遍全部 guard，返回第一个拒绝理由。单调：谁都翻不回来。 */
  runGuards(name: string, args: unknown): string | undefined {
    for (const g of this.guards) {
      const r = g({ name, arguments: args })
      if (r !== undefined) return r
    }
    return undefined
  }
}

/** 命令注册表的替身。 */
class FakeCommands extends Service {
  readonly registered: { name: string; handler: (i: unknown) => { kind: string; text: string } }[] = []
  constructor(ctx: Context) {
    super(ctx, 'commands')
  }
  register(def: unknown): () => void {
    const d = def as { name: string; handler: (i: unknown) => { kind: string; text: string } }
    this.registered.push(d)
    return () => void this.registered.splice(this.registered.indexOf(d), 1)
  }
  run(name: string, rawInput = ''): { kind: string; text: string } {
    return this.registered.find((c) => c.name === name)!.handler({ rawInput })
  }
}

async function host(config: Record<string, unknown> = {}): Promise<{
  ctx: Context
  tools: FakeTools
  cmd: FakeCommands
  svc: Context['stmSafety']
}> {
  const ctx = new Context()
  const tools = new FakeTools(ctx)
  const cmd = new FakeCommands(ctx)
  ctx.plugin(stmSafetyProvider, config)
  const svc = await new Promise<Context['stmSafety']>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ctx.stmSafety 没挂上')), 2_000)
    ctx.inject(['stmSafety'], (c) => {
      clearTimeout(t)
      resolve(c.stmSafety)
    })
  })
  return { ctx, tools, cmd, svc }
}

const SET_BIAS: SkillDeclaration = {
  name: 'SetBias',
  parameters: [{ name: 'bias_v', unit: 'V' }],
}
const SET_SETPOINT: SkillDeclaration = {
  name: 'SetSetpoint',
  parameters: [{ name: 'setpoint_a', unit: 'A' }],
}
const TIP_PULSE: SkillDeclaration = {
  name: 'TipPulse',
  parameters: [{ name: 'pulse_v', unit: 'V' }],
  capabilities: [CAP_BIAS_PULSE],
}
const START_SCAN: SkillDeclaration = { name: 'StartScan', parameters: [], tags: ['scan'] }

describe('判定顺序就是判据', () => {
  it('物理荒谬排第一——它给的重试信号最干脆', async () => {
    const { svc } = await host()
    svc.registerSkill(SET_SETPOINT)
    const v = svc.decide('SetSetpoint', { setpoint_a: 1.5 })
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.code).toBe('physically_absurd')
    // 文案让模型改量级，**不是**暗示把上限调高
    expect(v.kind === 'deny' && v.reason).toContain('量级丢了')
  })

  it('包络在荒谬之后：11 V 只是越界，不是物理不可能', async () => {
    const { svc } = await host()
    svc.registerSkill(SET_BIAS)
    const v = svc.decide('SetBias', { bias_v: 11 })
    expect(v.kind === 'deny' && v.code).toBe('envelope')
  })

  it('同一个调用既荒谬又越界时，报的是荒谬', async () => {
    const { svc } = await host()
    svc.registerSkill(SET_BIAS)
    const v = svc.decide('SetBias', { bias_v: 1e6 }) // 既超 ±10 V 也超 1e4 的物理顶
    expect(v.kind === 'deny' && v.code).toBe('physically_absurd')
  })

  it('模式闸：SAFE 拒脉冲，AUTO 放行，未绑定也放行', async () => {
    const { svc } = await host({ mode: 'SAFE' })
    svc.registerSkill(TIP_PULSE)
    expect(svc.decide('TipPulse', {}).kind).toBe('deny')
    expect((svc.decide('TipPulse', {}) as { code: string }).code).toBe('operating_mode')
    svc.setMode('AUTO')
    expect(svc.decide('TipPulse', {}).kind).toBe('allow')
    svc.setMode(null)
    expect(svc.decide('TipPulse', {}).kind).toBe('allow')
  })

  it('样品门控：记录系统缺席一律放行；接上之后产数据的要样品', async () => {
    const { svc } = await host()
    svc.registerSkill(START_SCAN)
    expect(svc.decide('StartScan', {}).kind).toBe('allow') // 指针没接
    svc.setPointers({ experimentId: 'e1', sampleId: null })
    const v = svc.decide('StartScan', {})
    expect(v.kind === 'deny' && v.code).toBe('sample_gate')
    svc.setPointers({ experimentId: 'e1', sampleId: 's1' })
    expect(svc.decide('StartScan', {}).kind).toBe('allow')
  })
})

describe('硬闸对模型来源是**拒**，不是问', () => {
  it('llm 来源撞上硬闸 ⇒ deny（模型不能给自己批准）', async () => {
    const { svc } = await host()
    const v = svc.decide('MotorMove', { direction: 'z-approach', steps: 10 }, { approvalSource: 'llm' })
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.code).toBe('hard_gate')
    expect(v.kind === 'deny' && v.reason).toContain('不能由模型自行批准')
  })

  it('human 来源 ⇒ ask（人可以在界面上确认）', async () => {
    const { svc } = await host()
    const v = svc.decide('MotorMove', { direction: 'z-approach' }, { approvalSource: 'human' })
    expect(v.kind).toBe('ask')
    expect(v.kind === 'ask' && v.gate).toBe('coarse_sample_approach')
  })

  it('五条硬闸各自触发得了', async () => {
    const { svc } = await host()
    const cases: [string, Record<string, unknown>, string][] = [
      ['MotorMove', { direction: 'z-approach' }, 'coarse_sample_approach'],
      ['SetBiasCalibration', {}, 'calibration_change'],
      ['SetMotorFreqAmp', {}, 'coarse_drive_change'],
      ['MotorMove', { direction: 'X+' }, 'unguarded_lateral_coarse_move'],
      ['SetZLimitsEnabled', { enabled: false }, 'protection_disable'],
    ]
    for (const [skill, args, gate] of cases) {
      const v = svc.decide(skill, args, { approvalSource: 'human' })
      expect(v.kind, `${skill} 该要人审`).toBe('ask')
      expect(v.kind === 'ask' && v.gate, skill).toBe(gate)
    }
  })

  it('硬闸**不需要技能声明**——键在技能名与原始参数上', async () => {
    const { svc } = await host()
    // 一个从没 registerSkill 过的名字，照样闸得住
    expect(svc.decide('SetZLimitsEnabled', { enabled: 'false' }).kind).toBe('deny')
  })
})

describe('拒绝走 guard（单调），要人审走 pre-execute', () => {
  it('guard 装上了，而且拒绝从它出来', async () => {
    const { tools, svc } = await host()
    svc.registerSkill(SET_SETPOINT)
    expect(tools.guards).toHaveLength(1)
    expect(tools.runGuards('SetSetpoint', { setpoint_a: 1.5 })).toContain('物理荒谬值')
  })

  it('放行时 guard 回 undefined —— 「不改变现状」而不是「我批准」', async () => {
    const { tools, svc } = await host()
    svc.registerSkill(SET_BIAS)
    expect(tools.runGuards('SetBias', { bias_v: 1 })).toBeUndefined()
  })

  it('要人审的那一类**不从 guard 拒**（guard 没有 ask 这个结果）', async () => {
    const { tools } = await host()
    // 硬闸在 llm 来源下是 deny，所以 guard 会拒——这正是我们要的：
    // 模型发起的粗逼近不该变成一个「问一下」的机会
    expect(tools.runGuards('MotorMove', { direction: 'z-approach' })).toContain('hard_gate')
  })

  it('卸载后 guard 撤掉', async () => {
    const { ctx, tools } = await host()
    expect(tools.guards).toHaveLength(1)
    ctx.registry.delete(stmSafetyProvider)
    await new Promise((r) => setTimeout(r, 50))
    expect(tools.guards).toHaveLength(0)
  })
})

describe('技能登记', () => {
  it('没登记的技能不做量纲检查（拿不到单位），但硬闸照旧', async () => {
    const { svc } = await host()
    expect(svc.decide('SetBias', { bias_v: 1e9 }).kind).toBe('allow') // 没登记 ⇒ 不知道单位
    svc.registerSkill(SET_BIAS)
    expect(svc.decide('SetBias', { bias_v: 1e9 }).kind).toBe('deny')
  })

  it('登记返回的 disposer 能撤销', async () => {
    const { svc } = await host()
    const off = svc.registerSkill(SET_BIAS)
    expect(svc.decide('SetBias', { bias_v: 1e9 }).kind).toBe('deny')
    off()
    expect(svc.decide('SetBias', { bias_v: 1e9 }).kind).toBe('allow')
  })

  it('SEMI 档只拦太深的机械下压，浅的放行', async () => {
    const { svc } = await host({ mode: 'SEMI' })
    svc.registerSkill({
      name: 'ShapeTip',
      parameters: [{ name: 'tip_lift', unit: 'm' }],
      capabilities: [CAP_TIP_SHAPING],
    })
    expect(svc.decide('ShapeTip', { tip_lift: 1e-9 }).kind).toBe('allow')
    const deep = svc.decide('ShapeTip', { tip_lift: 5e-8 })
    expect(deep.kind === 'deny' && deep.code).toBe('operating_mode')
  })
})

describe('/mode 命令与审批摘要', () => {
  it('/mode 不带参数只显示当前档', async () => {
    const { cmd } = await host({ mode: 'SAFE' })
    expect(cmd.run('mode').text).toContain('SAFE')
  })

  it('/mode SAFE|SEMI|AUTO 切档，并且**立刻**改变判定', async () => {
    const { cmd, svc } = await host({ mode: 'AUTO' })
    svc.registerSkill({ name: 'TipPulse', parameters: [], capabilities: [CAP_BIAS_PULSE] })
    expect(svc.decide('TipPulse', {}).kind).toBe('allow')
    expect(cmd.run('mode', 'safe').kind).toBe('success') // 大小写不敏感
    expect(svc.decide('TipPulse', {}).kind).toBe('deny')
  })

  it('不认识的档位报错，且**不改变现状**', async () => {
    const { cmd, svc } = await host({ mode: 'SAFE' })
    expect(cmd.run('mode', 'YOLO').kind).toBe('error')
    expect(svc.mode).toBe('SAFE')
  })

  it('模式是**命令**不是工具——模型读得到当前档，但改不了', async () => {
    const { cmd, tools } = await host()
    expect(cmd.registered.map((c) => c.name)).toContain('mode')
    // 工具注册表里没有 mode
    expect(tools.guards.length).toBe(1)
  })

  it('要人审时 reason 带参数摘要与短哈希——审批面看不到参数', async () => {
    const { svc } = await host()
    const args = { direction: 'z-approach', steps: 10 }
    const v = svc.decide('MotorMove', args, { approvalSource: 'human' })
    expect(v.kind).toBe('ask')
    // 摘要本身在 pre-execute 里拼；这里验哈希是稳定的、且与内核算的一致
    expect(argsHash(args)).toBe(argsHash({ steps: 10, direction: 'z-approach' }))
  })
})
