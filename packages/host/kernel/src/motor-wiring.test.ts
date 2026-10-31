/**
 * 粗动接线 —— 两张语义表的**每一行**，以及「只按键取值」。
 *
 * kernel 的覆盖率余量很薄，所以这里不是挑几个典型值：每个分支、每个非法形态各一条。
 * 判据来自参考实现（MAST 7.1.0 `instruments/motor_groups.py`）的语义，文案不进金样的那些
 * （配置损坏的各种形态、`source` 抛、列表畸形、宿主没接）由这份单测钉死。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { processInstrumentProfile } from './instrument-profile.js'
import { digitalPortRefusal, stmCoarseGroup, stmGroupRefusal, type StmGroup } from './motor-wiring.js'

afterEach(() => {
  processInstrumentProfile.source = null
})

function wire(profile: unknown): void {
  processInstrumentProfile.source = () => profile
}

function whyOf(r: StmGroup): string {
  if (r.ok) throw new Error('expected a refusal, got group ' + String(r.group))
  return r.why
}

/** 逐字（含全角括号、破折号），参考实现 `motor_groups.py:350-352`。 */
function reservedText(label: string, port: number, reason: string): string {
  return (
    `拒绝写 ${label}（port=${port}）：本机配置把它列为保留数字口 —— ${reason}。` +
    '误写它的方向位、电平或脉冲可能让接在上面的设备误动作；不会截断，也不会改用别的口。'
  )
}

const RESERVED_A = { port: 0, reason: '测试用的保留口' }

describe('stmCoarseGroup · 语义表', () => {
  it('宿主没接读口 ⇒ 组 0（与接线配置出现之前的行为一样）', () => {
    processInstrumentProfile.source = null
    expect(stmCoarseGroup()).toEqual({ ok: true, group: 0 })
  })

  it('对象里没有 stm_coarse_group 键 ⇒ 组 0，不论还有没有别的键', () => {
    wire({})
    expect(stmCoarseGroup()).toEqual({ ok: true, group: 0 })
    wire({ retract_motor_dir: 'z-', z_settle_timeout_s: 5 })
    expect(stmCoarseGroup()).toEqual({ ok: true, group: 0 })
  })

  it.each([0, 1, 2, 3, 4, 5])('键在、值是 %i ⇒ 该组', (g) => {
    wire({ stm_coarse_group: g })
    expect(stmCoarseGroup()).toEqual({ ok: true, group: g })
  })

  it.each([
    ['null', null, 'null'],
    ['字符串 "2"', '2', '"2"'],
    ['布尔', true, 'true'],
    ['小数', 1.5, '1.5'],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['6（超上界）', 6, '6'],
    ['-1（超下界）', -1, '-1'],
    ['undefined（键在、值缺）', undefined, 'undefined'],
    ['对象', {}, '[object Object]'],
  ])('键在、值是 %s ⇒ 拒绝，理由里带着原值，而且**不回落到 0**', (_name, value, shown) => {
    wire({ stm_coarse_group: value })
    const r = stmCoarseGroup()
    expect(r.ok).toBe(false)
    expect(whyOf(r)).toContain(`stm_coarse_group=${shown}`)
    expect(whyOf(r)).toContain('0..5')
  })

  it('字符串带引号，数字不带 —— "2" 与 2 在理由里分得开', () => {
    wire({ stm_coarse_group: '2' })
    expect(whyOf(stmCoarseGroup())).toContain('stm_coarse_group="2"')
    wire({ stm_coarse_group: 7 })
    expect(whyOf(stmCoarseGroup())).toContain('stm_coarse_group=7 ')
  })

  it('读口抛 ⇒ 拒绝，理由里带着抛出的内容', () => {
    processInstrumentProfile.source = () => {
      throw new Error('profile unreadable')
    }
    const r = stmCoarseGroup()
    expect(r.ok).toBe(false)
    expect(whyOf(r)).toContain('读口抛出')
    expect(whyOf(r)).toContain('profile unreadable')
  })

  it.each([
    ['null', null],
    ['数字', 42],
    ['字符串', 'x'],
    ['数组', []],
    ['Promise（异步读口）', Promise.resolve({})],
  ])('读口返回的是%s，不是普通对象 ⇒ 拒绝（不当成空档案）', (_name, value) => {
    wire(value)
    const r = stmCoarseGroup()
    expect(r.ok).toBe(false)
    expect(whyOf(r)).toContain('不是普通对象')
  })

  it('取 stm_coarse_group 这一个键时抛 ⇒ 也是读不到', () => {
    const o: Record<string, unknown> = {}
    Object.defineProperty(o, 'stm_coarse_group', {
      enumerable: true,
      get(): never {
        throw new Error('group unreadable')
      },
    })
    wire(o)
    expect(whyOf(stmCoarseGroup())).toContain('group unreadable')
  })

  it('保留口列表坏了不影响取组（参考实现里两者互不牵连）', () => {
    wire({ stm_coarse_group: 3, reserved_digital_ports: 'junk' })
    expect(stmCoarseGroup()).toEqual({ ok: true, group: 3 })
    // 取保留口列表时抛的 getter 同样不碰
    const o: Record<string, unknown> = { stm_coarse_group: 4 }
    Object.defineProperty(o, 'reserved_digital_ports', {
      enumerable: true,
      get(): never {
        throw new Error('ports unreadable')
      },
    })
    wire(o)
    expect(stmCoarseGroup()).toEqual({ ok: true, group: 4 })
  })

  it('每次调用只问读口一次', () => {
    let asked = 0
    processInstrumentProfile.source = () => {
      asked += 1
      return { stm_coarse_group: 1 }
    }
    stmCoarseGroup()
    expect(asked).toBe(1)
  })
})

describe('stmGroupRefusal · 文案', () => {
  it('六个调用点共用这一句，理由原样放进括号', () => {
    expect(stmGroupRefusal('stm_coarse_group=7 不是 0..5 的整数')).toBe(
      '仪器档案里的 stm_coarse_group 无法使用（stm_coarse_group=7 不是 0..5 的整数）—— ' +
        '不知道 STM 粗动是哪一组，拒绝粗动。修好或删掉该设置（删掉 = 回到 group 0）后重试。',
    )
  })
})

describe('digitalPortRefusal · 语义表', () => {
  it('宿主没接读口 ⇒ 可写（没配置 ⇒ 不保留任何口）', () => {
    processInstrumentProfile.source = null
    expect(digitalPortRefusal(0)).toBe('')
  })

  it('读口抛 ⇒ 拒写所有口', () => {
    processInstrumentProfile.source = () => {
      throw new Error('profile unreadable')
    }
    const text = digitalPortRefusal(7)
    expect(text).toBe(
      '仪器档案里的粗动接线配置读不出来（读口抛出: Error: profile unreadable）—— ' +
        '不知道哪些数字口是保留口，拒绝写数字口。修好或删掉该配置后重试。',
    )
  })

  it('读口返回的不是普通对象 ⇒ 拒写所有口', () => {
    wire([])
    expect(digitalPortRefusal(1)).toContain('读口返回的不是普通对象')
    expect(digitalPortRefusal(1)).toContain('拒绝写数字口')
  })

  it('stm_coarse_group 不合法 ⇒ 整份配置不可用 ⇒ 拒写所有口，哪怕这个口没被保留', () => {
    wire({ stm_coarse_group: 9, reserved_digital_ports: [RESERVED_A] })
    const text = digitalPortRefusal(3)
    expect(text).toContain('stm_coarse_group=9')
    expect(text).toContain('拒绝写数字口')
    expect(text).not.toContain('本机配置把它列为保留数字口')
  })

  it('取 reserved_digital_ports 时抛 ⇒ 拒写所有口', () => {
    const o: Record<string, unknown> = {}
    Object.defineProperty(o, 'reserved_digital_ports', {
      enumerable: true,
      get(): never {
        throw new Error('ports unreadable')
      },
    })
    wire(o)
    expect(digitalPortRefusal(2)).toContain('ports unreadable')
  })

  it.each([
    ['缺席', {}],
    ['null', { reserved_digital_ports: null }],
    ['空列表', { reserved_digital_ports: [] }],
  ])('保留口列表%s ⇒ 可写', (_name, profile) => {
    wire(profile)
    expect(digitalPortRefusal(0)).toBe('')
    expect(digitalPortRefusal(4)).toBe('')
  })

  it.each([
    ['字符串', 'A'],
    ['对象', { port: 0 }],
    ['数字', 0],
    // 键在、值缺：拼装配置时漏掉的列表。当成「缺席」会让每个保留口静默变成可写，所以同 stm_coarse_group，关闭。
    ['undefined（键在、值缺）', undefined],
  ])('列表本身是%s，不是数组 ⇒ 拒写所有口', (_name, list) => {
    wire({ reserved_digital_ports: list })
    expect(digitalPortRefusal(5)).toBe(
      '仪器档案的 reserved_digital_ports 读不懂（reserved_digital_ports 不是列表）—— ' +
        '不知道哪些数字口是保留口，拒绝写数字口。',
    )
  })

  it.each([
    ['null', null],
    ['数字', 3],
    ['字符串', 'a'],
    ['数组', []],
  ])('某一项是%s，不是对象 ⇒ 拒写所有口', (_name, item) => {
    wire({ reserved_digital_ports: [RESERVED_A, item] })
    expect(digitalPortRefusal(9)).toContain('reserved_digital_ports[1] 不是对象')
  })

  it.each([
    ['-1', -1, '-1'],
    ['16（超上界）', 16, '16'],
    ['小数', 1.5, '1.5'],
    ['字符串 "1"', '1', '"1"'],
    ['布尔', true, 'true'],
    ['缺 port', undefined, 'undefined'],
  ])('某一项的 port 是%s ⇒ **整个列表作废**，不逐项丢', (_name, port, shown) => {
    // 好的那一项 (port 0) 也不再被当成保留 —— 因为整张表读不懂，所以**所有口**都拒，
    // 而不是「丢掉坏的、保留好的」（丢掉一个保留 = 一个没有保护的口）。
    wire({ reserved_digital_ports: [RESERVED_A, { port, reason: '坏的' }] })
    for (const p of [0, 1, 7]) {
      const text = digitalPortRefusal(p)
      expect(text).toContain(`reserved_digital_ports[1].port=${shown}`)
      expect(text).toContain('拒绝写数字口')
      expect(text).not.toContain('本机配置把它列为保留数字口')
    }
  })

  it.each([
    ['小数', 1.5, '1.5'],
    ['字符串 "0"', '0', '"0"'],
    ['NaN', Number.NaN, 'NaN'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('port 实参是%s，不是整数 ⇒ 拒绝（有配置时，列表缺不缺席都一样）', (_name, port, shown) => {
    wire({ reserved_digital_ports: [RESERVED_A] })
    expect(digitalPortRefusal(port)).toBe(`数字口 ${shown} 不是整数`)
    wire({})
    expect(digitalPortRefusal(port)).toBe(`数字口 ${shown} 不是整数`)
  })

  it('没接读口时，port 实参的形状不是这里管的事（没配置 ⇒ 不保留任何口）', () => {
    processInstrumentProfile.source = null
    expect(digitalPortRefusal(1.5)).toBe('')
  })

  it.each([
    [0, 'Port A'],
    [1, 'Port B'],
    [2, 'Port C'],
    [3, 'Port D'],
    [4, 'DIO port 4'],
    [15, 'DIO port 15'],
  ])('port %i 在保留列表里 ⇒ 拒绝，文案逐字（%s）', (port, label) => {
    wire({ reserved_digital_ports: [{ port, reason: '测试用的保留口' }] })
    expect(digitalPortRefusal(port)).toBe(reservedText(label, port, '测试用的保留口'))
  })

  it('不在列表里的口照写；超出 0..15 的整数也不是保留口', () => {
    wire({ reserved_digital_ports: [RESERVED_A] })
    expect(digitalPortRefusal(1)).toBe('')
    expect(digitalPortRefusal(3)).toBe('')
    expect(digitalPortRefusal(-1)).toBe('')
    expect(digitalPortRefusal(99)).toBe('')
  })

  it('理由缺省或为空白或假值 ⇒ 缺省文案；有理由则 trim 后原样', () => {
    const cases: [unknown, string][] = [
      [undefined, '本机配置的保留口'],
      ['', '本机配置的保留口'],
      ['   ', '本机配置的保留口'],
      [0, '本机配置的保留口'],
      [false, '本机配置的保留口'],
      [5, '5'],
      ['  相机触发  ', '相机触发'],
    ]
    for (const [reason, shown] of cases) {
      wire({ reserved_digital_ports: [{ port: 2, reason }] })
      expect(digitalPortRefusal(2)).toBe(reservedText('Port C', 2, shown))
    }
  })

  it('同一个口列了两次 ⇒ 用第一项的理由（与参考实现的顺序扫描一致）', () => {
    wire({
      reserved_digital_ports: [
        { port: 1, reason: '第一项' },
        { port: 1, reason: '第二项' },
      ],
    })
    expect(digitalPortRefusal(1)).toContain('第一项')
    expect(digitalPortRefusal(1)).not.toContain('第二项')
  })

  it('每次调用只问读口一次', () => {
    let asked = 0
    processInstrumentProfile.source = () => {
      asked += 1
      return { reserved_digital_ports: [RESERVED_A] }
    }
    digitalPortRefusal(0)
    expect(asked).toBe(1)
  })
})

/**
 * 档案对象可以带**只在取某一个键时才抛**的 getter（`retractDirUnreadable()`：
 * 用它表达「只有退针方向读不出，接线配置照常可读」）。
 * 这里的实现只能按名取两个接线键；一旦展开、枚举或序列化整个对象，getter 就被触发 ——
 * 于是一个无关键的故障会让粗动被拒（`motor_z/x_plus/unreadable` 这一格会红）。
 * 计数器钉的是「**没有碰过**」，比「没抛」更强。
 */
function withThrowingRetractDir(base: Record<string, unknown>): {
  profile: Record<string, unknown>
  reads: () => number
} {
  let reads = 0
  const profile: Record<string, unknown> = { ...base }
  Object.defineProperty(profile, 'retract_motor_dir', {
    enumerable: true,
    get(): never {
      reads += 1
      throw new Error('profile unreadable')
    },
  })
  return { profile, reads: () => reads }
}

describe('只按键取值：retract_motor_dir 一读就抛的档案', () => {
  it('夹具本身确实会在展开时抛（否则下面的断言什么也没证明）', () => {
    const { profile, reads } = withThrowingRetractDir({})
    expect(() => ({ ...profile })).toThrow('profile unreadable')
    expect(() => JSON.stringify(profile)).toThrow('profile unreadable')
    expect(reads()).toBe(2)
  })

  it('没有接线键 ⇒ 组 0、可写，而 getter 一次都没被碰', () => {
    const { profile, reads } = withThrowingRetractDir({ z_settle_timeout_s: 5 })
    wire(profile)
    expect(stmCoarseGroup()).toEqual({ ok: true, group: 0 })
    expect(digitalPortRefusal(0)).toBe('')
    expect(reads()).toBe(0)
  })

  it('有接线键 ⇒ 照常取到配置值与保留口，getter 一次都没被碰', () => {
    const { profile, reads } = withThrowingRetractDir({
      stm_coarse_group: 2,
      reserved_digital_ports: [RESERVED_A],
    })
    wire(profile)
    expect(stmCoarseGroup()).toEqual({ ok: true, group: 2 })
    expect(digitalPortRefusal(0)).toBe(reservedText('Port A', 0, '测试用的保留口'))
    expect(digitalPortRefusal(1)).toBe('')
    expect(reads()).toBe(0)
  })
})
