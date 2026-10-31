/**
 * 粗动组与保留数字口的**技能层接线**：配置的组真的传到了下发的实参里，
 * 损坏的配置真的拦住了整趟（一次 `Motor_*` 都不发）。
 *
 * 判据本身（两张语义表）在内核的 `motor-wiring.test.ts`。这里验的是接线 ——
 * 那些判据真的被问到了、拒绝发生在下发**之前**、而没有配置时行为与以前逐字相同。
 * 参考实现没有轨迹的部分（配置损坏的各种形态、`source` 抛、宿主没接）也在这里，
 * 因为它们的报错文本带 Python/JSON 解析器的原话，金样无法也不该逐字对。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyHardwareState,
  processInstrumentProfile,
  stmGroupRefusal,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { MotorGetPos } from './reads-hw.js'
import {
  ConfigureDigitalLine,
  GetDigitalLineTTL,
  PulseDigitalLine,
  SetDigitalLineStatus,
} from './user-output.js'
import { MotorMove, MotorMoveClosedLoop, Z_DIR_UNREADABLE } from './writes-gated.js'

const S0 = emptyHardwareState('T0')

interface Call {
  readonly verb: string
  readonly args: unknown[]
}

/** 按动词脚本化的回包；`null` = 报错。`state` 是技能看到的硬件状态快照。 */
function rig(
  replies: Record<string, unknown[] | null> = {},
  state = S0,
): { ctx: SkillContext; calls: Call[] } {
  const calls: Call[] = []
  const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
    calls.push({ verb: m, args: a })
    const r = replies[m]
    if (r === null) return Promise.resolve({ method: m, args: a, error: '模拟故障：连接被对端关闭' })
    return Promise.resolve({ method: m, args: a, values: r ?? [] })
  }
  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    now: () => 0,
    sleep: () => Promise.resolve(),
    state: () => state,
    refreshState: () => Promise.resolve(state),
    markers: { emit: () => {} },
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
    depth: 0,
    owner: 't',
    rootCallId: 't',
    approvalSource: 'llm',
  } as unknown as SkillContext
  return { ctx, calls }
}

/** 宿主接上档案读口；`null` = 宿主没接。 */
function wire(profile: unknown): void {
  processInstrumentProfile.source = profile === null ? null : () => profile
}

afterEach(() => {
  processInstrumentProfile.source = null
})

const TARGET = { target_x_m: 1e-9, target_y_m: 1e-9, target_z_m: 0.00005 }

/** 配置损坏的几种形态：每一种都该让粗动一个动词都发不出去。 */
const BROKEN: readonly (readonly [string, () => void])[] = [
  ['stm_coarse_group 超上界', () => wire({ stm_coarse_group: 9 })],
  ['stm_coarse_group 是字符串', () => wire({ stm_coarse_group: '2' })],
  ['stm_coarse_group 是 null', () => wire({ stm_coarse_group: null })],
  [
    '读口抛',
    () => {
      processInstrumentProfile.source = () => {
        throw new Error('profile unreadable')
      }
    },
  ],
  ['读口返回数组', () => wire([])],
]

describe('MotorMove · 下发的组号是配置的 STM 粗动组', () => {
  const STEPS = { steps: 20 }

  it('接了读口、对象里没有 stm_coarse_group ⇒ 组 0，结果与以前逐字相同', async () => {
    wire({})
    const r = rig()
    const got = await MotorMove.execute(r.ctx, { direction: 'x+', ...STEPS })
    expect(r.calls).toEqual([{ verb: 'Motor_StartMove', args: [0, 20, 0, 1] }])
    expect(got).toEqual({ success: true, data: { direction: 'x+', steps: 20 } })
  })

  it('宿主没接读口 ⇒ 也是组 0（与以前一样）', async () => {
    wire(null)
    const r = rig()
    await MotorMove.execute(r.ctx, { direction: 'x+', ...STEPS })
    expect(r.calls).toEqual([{ verb: 'Motor_StartMove', args: [0, 20, 0, 1] }])
  })

  it.each([
    ['x+', 0],
    ['x-', 1],
    ['y+', 2],
    ['y-', 3],
  ])('配置组 2、横向 %s ⇒ 方向码 %i，组号 2', async (direction, code) => {
    wire({ stm_coarse_group: 2 })
    const r = rig()
    await MotorMove.execute(r.ctx, { direction, ...STEPS })
    expect(r.calls).toEqual([{ verb: 'Motor_StartMove', args: [code, 20, 2, 1] }])
  })

  it.each([
    ['z-retract', 4],
    ['z-approach', 5],
  ])('配置组 2、%s（退针方向没声明）⇒ 方向码 %i，组号也是 2', async (direction, code) => {
    wire({ stm_coarse_group: 2 })
    const r = rig()
    const got = await MotorMove.execute(r.ctx, { direction, ...STEPS })
    expect(got.success).toBe(true)
    expect(r.calls).toEqual([{ verb: 'Motor_StartMove', args: [code, 20, 2, 1] }])
  })

  it.each(BROKEN)('配置损坏（%s）⇒ 拒绝，文案同 stmGroupRefusal，一次 Motor_* 都不发', async (_name, breakIt) => {
    breakIt()
    const r = rig()
    const got = await MotorMove.execute(r.ctx, { direction: 'x+', ...STEPS })
    expect(got.success).toBe(false)
    expect(got.error).toContain('无法使用')
    expect(got.error).toContain('拒绝粗动')
    expect(r.calls).toEqual([])
  })

  it('组坏了、退针方向照常可读 ⇒ Z 方向也被组拒（Z 分支先过，组在下发之前）', async () => {
    wire({ stm_coarse_group: 9, retract_motor_dir: 'z-' })
    for (const direction of ['z-retract', 'z-approach']) {
      const r = rig()
      const got = await MotorMove.execute(r.ctx, { direction, ...STEPS })
      expect(got).toEqual({ success: false, error: stmGroupRefusal('stm_coarse_group=9 不是 0..5 的整数') })
      expect(r.calls).toEqual([])
    }
  })

  it('整个读口抛出 ⇒ 横向被组拒；Z 方向仍先被方向拒（Z 分支在取组之前）', async () => {
    processInstrumentProfile.source = () => {
      throw new Error('profile unreadable')
    }
    const lateral = rig()
    const refused = await MotorMove.execute(lateral.ctx, { direction: 'x+', ...STEPS })
    expect(refused.error).toContain('拒绝粗动')
    expect(lateral.calls).toEqual([])
    const vertical = rig()
    const z = await MotorMove.execute(vertical.ctx, { direction: 'z-retract', ...STEPS })
    expect(z).toEqual({ success: false, error: Z_DIR_UNREADABLE })
    expect(vertical.calls).toEqual([])
  })

  it('知道针没退的横向移动先被「针没退」拒，不问组', async () => {
    // 配置损坏也一样：拒绝的是更早的那一道。
    wire({ stm_coarse_group: 9 })
    const r = rig({}, { ...S0, withdrawn: false })
    const got = await MotorMove.execute(r.ctx, { direction: 'x+', ...STEPS })
    expect(got.error).toContain('tip is not withdrawn')
    expect(r.calls).toEqual([])
  })

  it('控制器报错 ⇒ 原样透传', async () => {
    wire({ stm_coarse_group: 2 })
    const r = rig({ Motor_StartMove: null })
    const got = await MotorMove.execute(r.ctx, { direction: 'x+', ...STEPS })
    expect(got).toEqual({ success: false, error: '模拟故障：连接被对端关闭' })
  })
})

describe('MotorGetPos · 问的是配置的 STM 粗动组', () => {
  it('接了读口、对象里没有 stm_coarse_group ⇒ 组 0；成功路径只有 x_m/y_m/z_m，不带 group 与 position_feedback', async () => {
    wire({})
    const r = rig({ Motor_PosGet: [0.25, 0.5, 0.75] })
    const got = await MotorGetPos.execute(r.ctx, {})
    expect(r.calls).toEqual([{ verb: 'Motor_PosGet', args: [0, 500] }])
    expect(got).toEqual({ success: true, data: { x_m: 0.25, y_m: 0.5, z_m: 0.75 } })
  })

  it('宿主没接读口 ⇒ 也是组 0（与以前一样）', async () => {
    wire(null)
    const r = rig({ Motor_PosGet: [1, 2, 3] })
    await MotorGetPos.execute(r.ctx, {})
    expect(r.calls).toEqual([{ verb: 'Motor_PosGet', args: [0, 500] }])
  })

  it('配置组 2 ⇒ Motor_PosGet(2, 500)', async () => {
    wire({ stm_coarse_group: 2 })
    const r = rig({ Motor_PosGet: [0.25, 0.5, 0.75] })
    const got = await MotorGetPos.execute(r.ctx, {})
    expect(r.calls).toEqual([{ verb: 'Motor_PosGet', args: [2, 500] }])
    expect(got.data).toEqual({ x_m: 0.25, y_m: 0.5, z_m: 0.75 })
  })

  it('回包读不出三个数 ⇒ 原样给 raw（成功路径没有变）', async () => {
    const r = rig({ Motor_PosGet: ['a', 'b'] })
    const got = await MotorGetPos.execute(r.ctx, {})
    expect(got).toEqual({ success: true, data: { raw: ['a', 'b'] } })
  })

  it('报错 ⇒ 逐字的新文案，带 group，data 说明没有位置反馈（组 2）', async () => {
    wire({ stm_coarse_group: 2 })
    const r = rig({ Motor_PosGet: null })
    const got = await MotorGetPos.execute(r.ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toBe(
      '无位置反馈：Motor_PosGet(group 2) 报错 —— 这台粗动控制器不提供位置（回包里的 0 不是位置）。' +
        'Nanonis: 模拟故障：连接被对端关闭',
    )
    expect(got.data).toEqual({ position_feedback: false, group: 2 })
  })

  it('报错、对象里没有 stm_coarse_group ⇒ 组 0', async () => {
    wire({})
    const r = rig({ Motor_PosGet: null })
    const got = await MotorGetPos.execute(r.ctx, {})
    expect(got.error).toContain('Motor_PosGet(group 0)')
    expect(got.data).toEqual({ position_feedback: false, group: 0 })
  })

  it.each(BROKEN)('配置损坏（%s）⇒ 拒绝，一次 Motor_* 都不发', async (_name, breakIt) => {
    breakIt()
    const r = rig({ Motor_PosGet: [1, 2, 3] })
    const got = await MotorGetPos.execute(r.ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('无法使用')
    expect(got.error).toContain('拒绝粗动')
    expect(r.calls).toEqual([])
  })

  it('retract_motor_dir 一读就抛的档案，不影响取组', async () => {
    const profile: Record<string, unknown> = { stm_coarse_group: 2 }
    Object.defineProperty(profile, 'retract_motor_dir', {
      enumerable: true,
      get(): never {
        throw new Error('profile unreadable')
      },
    })
    wire(profile)
    const r = rig({ Motor_PosGet: [1, 2, 3] })
    await MotorGetPos.execute(r.ctx, {})
    expect(r.calls).toEqual([{ verb: 'Motor_PosGet', args: [2, 500] }])
  })
})

describe('MotorMoveClosedLoop · group 缺省是配置的组，给了别的组就拒', () => {
  it('接了读口、对象里没有 stm_coarse_group，不给 group ⇒ 组 0，data 与以前逐字相同（不含 group）', async () => {
    wire({})
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET })
    expect(r.calls).toEqual([{ verb: 'Motor_StartClosedLoop', args: [0, 1e-9, 1e-9, 0.00005, 1, 0] }])
    expect(got).toEqual({
      success: true,
      data: { absolute: false, target_x_m: 1e-9, target_y_m: 1e-9, target_z_m: 0.00005 },
    })
  })

  it('宿主没接读口 ⇒ 也是组 0（与以前一样）', async () => {
    wire(null)
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET })
    expect(got.success).toBe(true)
    expect(r.calls).toEqual([{ verb: 'Motor_StartClosedLoop', args: [0, 1e-9, 1e-9, 0.00005, 1, 0] }])
  })

  it('absolute / wait 照旧传（group 之外的实参没有变）', async () => {
    wire({ stm_coarse_group: 3 })
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, absolute: true, wait: false })
    expect(r.calls).toEqual([{ verb: 'Motor_StartClosedLoop', args: [1, 1e-9, 1e-9, 0.00005, 0, 3] }])
    expect(got.data).toMatchObject({ absolute: true })
  })

  it('配置组 2、不给 group ⇒ 末位实参是 2', async () => {
    wire({ stm_coarse_group: 2 })
    const r = rig()
    await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET })
    expect(r.calls[0]?.args.at(-1)).toBe(2)
  })

  it('group 是 null ⇒ 当没给', async () => {
    wire({ stm_coarse_group: 2 })
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group: null })
    expect(got.success).toBe(true)
    expect(r.calls[0]?.args.at(-1)).toBe(2)
  })

  it('显式 group 等于配置组 ⇒ 成功，末位实参是该组', async () => {
    wire({ stm_coarse_group: 2 })
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group: 2 })
    expect(got.success).toBe(true)
    expect(r.calls[0]?.args.at(-1)).toBe(2)
  })

  it('没配组时显式 group 0 ⇒ 成功（模型照旧缺省传 0 不该被拒）', async () => {
    wire({})
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group: 0 })
    expect(got.success).toBe(true)
    expect(r.calls[0]?.args.at(-1)).toBe(0)
  })

  it('显式给了别的组 ⇒ 拒绝，文案逐字，一次下发都没有', async () => {
    wire({ stm_coarse_group: 2 })
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group: 1 })
    expect(got.success).toBe(false)
    expect(got.error).toBe(
      'group 1 不是 STM 粗动组（stm_coarse_group=2）—— ' +
        'STM 粗动技能不驱动其他电机组；光学组请用 NanonisMotorGroupMove。',
    )
    expect(r.calls).toEqual([])
  })

  it('没配组时给了别的组 ⇒ 拒绝，配置组报 0', async () => {
    wire({})
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group: 1 })
    expect(got.success).toBe(false)
    expect(got.error).toContain('stm_coarse_group=0')
    expect(r.calls).toEqual([])
  })

  it('整数但超范围（直接 execute 绕过了 K6）⇒ 同样按「不是 STM 粗动组」拒', async () => {
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group: 7 })
    expect(got.error).toContain('group 7 不是 STM 粗动组')
    expect(r.calls).toEqual([])
  })

  it.each([
    ['字符串 "1"', '1', '"1"'],
    ['小数', 1.5, '1.5'],
    ['布尔', true, 'true'],
    ['对象', { g: 1 }, '{"g":1}'],
    // 它们的 JSON 都是 "null"，不能照 JSON 印
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['-Infinity', Number.NEGATIVE_INFINITY, '-Infinity'],
  ])('group 是%s，不是整数 ⇒ 拒绝，不按「没给」处理', async (_name, group, shown) => {
    // 内核不做类型转换：字符串 "1" 若被当成「没给」，会静默驱动组 0。
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group })
    expect(got.success).toBe(false)
    expect(got.error).toBe(`group 必须是 0..5 的整数，收到 ${shown}`)
    expect(r.calls).toEqual([])
  })

  it.each(BROKEN)('配置损坏（%s）⇒ 拒绝，一次 Motor_* 都不发', async (_name, breakIt) => {
    breakIt()
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET })
    expect(got.success).toBe(false)
    expect(got.error).toContain('拒绝粗动')
    expect(r.calls).toEqual([])
  })

  it('配置损坏时先报配置的问题，不先核对 group', async () => {
    wire({ stm_coarse_group: 9 })
    const r = rig()
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET, group: 1 })
    expect(got.error).toBe(stmGroupRefusal('stm_coarse_group=9 不是 0..5 的整数'))
  })

  it('控制器报错 ⇒ 原样透传（没有 data）', async () => {
    const r = rig({ Motor_StartClosedLoop: null })
    const got = await MotorMoveClosedLoop.execute(r.ctx, { ...TARGET })
    expect(got).toEqual({ success: false, error: '模拟故障：连接被对端关闭' })
  })
})

// ── 三个数字口写技能：保留口 ────────────────────────────────────────────────

const RESERVED_REASON = '测试用的保留口'
const RESERVED_A = { reserved_digital_ports: [{ port: 0, reason: RESERVED_REASON }] }

/** 参考实现 `motor_groups.py:350-352` 逐字。 */
function reservedText(label: string, port: number): string {
  return (
    `拒绝写 ${label}（port=${port}）：本机配置把它列为保留数字口 —— ${RESERVED_REASON}。` +
    '误写它的方向位、电平或脉冲可能让接在上面的设备误动作；不会截断，也不会改用别的口。'
  )
}

/** 三个写技能：合法参数（口可换）、以及没被拒时该下发的那一条。 */
const DIGITAL_WRITES = [
  {
    name: 'PulseDigitalLine',
    skill: PulseDigitalLine,
    params: (port: unknown) => ({ port, lines: '1,2', pulse_width_s: 0.01 }),
    sent: (port: number) => ({ verb: 'DigLines_Pulse', args: [port, [1, 2], 0.01, 0.001, 1, 1] }),
  },
  {
    name: 'SetDigitalLineStatus',
    skill: SetDigitalLineStatus,
    params: (port: unknown) => ({ port, line: 1, status: true }),
    sent: (port: number) => ({ verb: 'DigLines_OutStatusSet', args: [port, 1, 1] }),
  },
  {
    name: 'ConfigureDigitalLine',
    skill: ConfigureDigitalLine,
    params: (port: unknown) => ({ line: 1, port, direction: 1, polarity: 1 }),
    sent: (port: number) => ({ verb: 'DigLines_PropsSet', args: [1, port, 1, 1] }),
  },
] as const

/** 接线配置读不懂的几种形态：不知道哪个口是保留口，就不知道任何一个口是自由的。 */
const BROKEN_DIGITAL: readonly (readonly [string, () => void])[] = [
  ['保留口列表不是数组', () => wire({ reserved_digital_ports: 'A' })],
  [
    '某一项的 port 不合法',
    () => wire({ reserved_digital_ports: [{ port: 0, reason: '好的一项' }, { port: 'one' }] }),
  ],
  ['stm_coarse_group 不合法', () => wire({ stm_coarse_group: 9, reserved_digital_ports: [{ port: 0 }] })],
  [
    '读口抛',
    () => {
      processInstrumentProfile.source = () => {
        throw new Error('profile unreadable')
      }
    },
  ],
]

describe.each(DIGITAL_WRITES)('$name · 保留口', ({ skill, params, sent }) => {
  it('保留的口 ⇒ 拒绝，文案逐字，一条下发都没有', async () => {
    wire(RESERVED_A)
    const r = rig()
    const got = await skill.execute(r.ctx, params(0))
    expect(got).toEqual({ success: false, error: reservedText('Port A', 0) })
    expect(r.calls).toEqual([])
  })

  it('没被保留的口 ⇒ 照发，实参与以前逐字相同', async () => {
    wire(RESERVED_A)
    const r = rig()
    const got = await skill.execute(r.ctx, params(1))
    expect(got.success).toBe(true)
    expect(r.calls).toEqual([sent(1)])
  })

  it('没有配置 ⇒ 不保留任何口，Port A 也照发', async () => {
    wire({})
    const r = rig()
    expect((await skill.execute(r.ctx, params(0))).success).toBe(true)
    expect(r.calls).toEqual([sent(0)])
  })

  it('宿主没接读口 ⇒ 也照发（与以前一样）', async () => {
    wire(null)
    const r = rig()
    expect((await skill.execute(r.ctx, params(0))).success).toBe(true)
    expect(r.calls).toEqual([sent(0)])
  })

  it.each(BROKEN_DIGITAL)('配置读不懂（%s）⇒ **所有**口都拒，哪怕这个口没被列出', async (_name, breakIt) => {
    breakIt()
    const r = rig()
    const got = await skill.execute(r.ctx, params(1))
    expect(got.success).toBe(false)
    expect(got.error).toContain('拒绝写数字口')
    expect(got.error).not.toContain('本机配置把它列为保留数字口')
    expect(r.calls).toEqual([])
  })

  it('检查的是实际下发的那个 port：折成整数之后落在保留口上也拒', async () => {
    // 技能把 port 折成整数再下发（非数字 ⇒ 0，0.9 ⇒ 0），所以检查必须看折过的那个，
    // 而不是原始参数 —— 否则「检查 'A'、发 0」就绕过了保留。
    wire(RESERVED_A)
    for (const weird of ['A', 0.9]) {
      const r = rig()
      const got = await skill.execute(r.ctx, params(weird))
      expect(got.error).toBe(reservedText('Port A', 0))
      expect(r.calls).toEqual([])
    }
  })

  it('retract_motor_dir 一读就抛的档案，不影响保留口检查', async () => {
    const profile: Record<string, unknown> = { ...RESERVED_A }
    Object.defineProperty(profile, 'retract_motor_dir', {
      enumerable: true,
      get(): never {
        throw new Error('profile unreadable')
      },
    })
    wire(profile)
    const refused = rig()
    expect((await skill.execute(refused.ctx, params(0))).error).toBe(reservedText('Port A', 0))
    expect(refused.calls).toEqual([])
    const allowed = rig()
    expect((await skill.execute(allowed.ctx, params(1))).success).toBe(true)
    expect(allowed.calls).toEqual([sent(1)])
  })
})

describe('数字口技能 · 其余几条', () => {
  it('ConfigureDigitalLine 把保留口改成输入也拒（两个方向都会断开链路）', async () => {
    wire(RESERVED_A)
    const r = rig()
    const got = await ConfigureDigitalLine.execute(r.ctx, { line: 1, port: 0, direction: 0, polarity: 1 })
    expect(got.error).toBe(reservedText('Port A', 0))
    expect(r.calls).toEqual([])
  })

  it('PulseDigitalLine：更早的拒绝先于保留口检查（lines 解析失败、行号越界）', async () => {
    wire(RESERVED_A)
    const bad = rig()
    const parse = await PulseDigitalLine.execute(bad.ctx, { port: 0, lines: 'x', pulse_width_s: 0.01 })
    expect(parse.error).toContain('lines 解析失败')
    const range = await PulseDigitalLine.execute(bad.ctx, { port: 0, lines: '9', pulse_width_s: 0.01 })
    expect(range.error).toBe('digital line 必须在 1..8 之间，收到 [9]')
    expect(bad.calls).toEqual([])
  })

  it('读不设闸：GetDigitalLineTTL 在保留口上、以及配置损坏时都照读', async () => {
    for (const setup of [() => wire(RESERVED_A), () => wire({ stm_coarse_group: 9 })]) {
      setup()
      const r = rig({ DigLines_TTLValGet: [1, 0, 1] })
      const got = await GetDigitalLineTTL.execute(r.ctx, { port: 0 })
      expect(got.success).toBe(true)
      expect(r.calls).toEqual([{ verb: 'DigLines_TTLValGet', args: [0] }])
    }
  })
})
