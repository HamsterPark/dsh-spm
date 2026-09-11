/**
 * 逃逸闸的网格 —— 12 格闩 + 7 格升级判定 + 3 格文案，逐条对旧仓。
 *
 * 判据重点在**那条不对称**：记是全局的，清是按链计的。对称地清除看起来更「一致」，
 * 而那份一致正是 2026-07-28 致命一(c) 的缺陷本身。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  APPROACH_REFUSAL_TTL_S,
  ApproachRefusalLatch,
  ESCALATION_SKILLS,
  NO_REASON_PLACEHOLDER,
  approachRefusedText,
  isApproachEscalation,
} from './approach-refusal.js'

interface Step {
  op: string
  args: string[]
  returned: unknown
  state: {
    reason: string
    source: string
    owner: string
    ttl_s: number
    age_s: number
    expired: boolean
  } | null
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/approach_gate.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: { ttl_s: number; escalation_skills: string[]; no_reason_placeholder: string }
  is_escalation: Record<string, boolean>
  refusal_text: Record<string, string>
  cases: Record<string, Step[]>
}

const A = 'group#run-1'
const B = 'chat#run-2'

type Op =
  | ['record', string, { owner?: string; ttlS?: number }?]
  | ['clear', string, { owner?: string | null }?]
  | ['tick', number]
  | ['active']

/** 名字 → 脚本。与 `export_approach_gate.py` 的 `case` 一一对应。 */
const SCRIPTS: Record<string, Op[]> = {
  record_then_active: [['record', 'Z 反馈开关读不出', { owner: A }], ['active']],
  expires_after_ttl: [
    ['record', '读不到设定点', { owner: A }],
    ['tick', 599], ['active'],
    ['tick', 2], ['active'],
  ],
  record_overwrites: [
    ['record', '第一次的理由', { owner: A }],
    ['record', '第二次的理由', { owner: B }],
    ['active'],
  ],
  same_owner_clears: [
    ['record', '理由', { owner: A }],
    ['clear', 'ApproachTip 升级了', { owner: A }],
    ['active'],
  ],
  other_owner_cannot_clear: [
    ['record', '理由', { owner: A }],
    ['clear', '私聊里 engage 成功了', { owner: B }],
    ['active'],
  ],
  unscoped_cleared_by_anyone: [
    ['record', '理由', {}],
    ['clear', '别的链', { owner: B }],
    ['active'],
  ],
  admin_override_clears: [
    ['record', '理由', { owner: A }],
    ['clear', '管理员', { owner: null }],
    ['active'],
  ],
  clear_when_empty_is_idempotent: [['clear', '没有可清的', { owner: A }], ['active']],
  expired_then_cleared_is_false: [
    ['record', '理由', { owner: A }],
    ['tick', 601],
    ['active'],
    ['clear', '已经没了', { owner: A }],
  ],
  record_resets_age: [
    ['record', '第一次', { owner: A }],
    ['tick', 500],
    ['record', '第二次', { owner: A }],
    ['tick', 200], ['active'],
  ],
  blank_reason_gets_placeholder: [['record', '   ', { owner: A }], ['active']],
  custom_ttl: [['record', '理由', { owner: A, ttlS: 10 }], ['tick', 11], ['active']],
}

function replay(ops: Op[]): Step[] {
  let clock = 1_000_000
  const latch = new ApproachRefusalLatch(() => clock)
  const snap = (): Step['state'] => {
    const r = latch.active()
    if (r === null) return null
    return {
      reason: r.reason,
      source: r.source,
      owner: r.owner,
      ttl_s: r.ttlS,
      age_s: Math.round(latch.ageS(r) * 1000) / 1000,
      expired: latch.ageS(r) >= r.ttlS,
    }
  }
  const out: Step[] = []
  for (const op of ops) {
    let returned: unknown = null
    if (op[0] === 'record') latch.record(op[1], op[2] ?? {})
    else if (op[0] === 'clear') returned = latch.clear(op[1], op[2] ?? {})
    else if (op[0] === 'tick') clock += op[1]
    else if (op[0] === 'active') returned = snap()
    out.push({ op: op[0], args: [], returned, state: snap() })
  }
  return out
}

describe('常量', () => {
  it('三个逐字相等', () => {
    expect(APPROACH_REFUSAL_TTL_S).toBe(golden.constants.ttl_s)
    expect([...ESCALATION_SKILLS].sort()).toEqual(golden.constants.escalation_skills)
    expect(NO_REASON_PLACEHOLDER).toBe(golden.constants.no_reason_placeholder)
  })
})

describe('isApproachEscalation —— 7 格', () => {
  for (const [name, want] of Object.entries(golden.is_escalation)) {
    it(name === '' ? '(空串)' : name, () => {
      expect(isApproachEscalation(name)).toBe(want)
    })
  }

  it('`MotorMove` 的 z-approach **有意不在内**', () => {
    // 它在安全闸 Layer 0 已经是 fail-closed 的，根本到不了这道检查。
    expect(isApproachEscalation('MotorMove')).toBe(false)
    // `ApproachTip` 也不在内：它是**正门**，拦它等于把出路也堵死
    expect(isApproachEscalation('ApproachTip')).toBe(false)
  })
})

describe('闩 —— 12 格逐条对旧仓', () => {
  const names = Object.keys(golden.cases)

  it('脚本表覆盖金样里的每一格', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual(names.slice().sort())
  })

  for (const name of names) {
    it(name, () => {
      const want = golden.cases[name]!
      const got = replay(SCRIPTS[name]!)
      expect(got.length).toBe(want.length)
      for (let i = 0; i < want.length; i += 1) {
        expect(got[i]!.op, `${name}[${i}].op`).toBe(want[i]!.op)
        expect(got[i]!.state, `${name}[${i}].state`).toEqual(want[i]!.state)
        if (want[i]!.op === 'clear') {
          expect(got[i]!.returned, `${name}[${i}] 清掉了吗`).toBe(want[i]!.returned)
        }
      }
    })
  }
})

describe('那条不对称：记是全局的，清是按链计的', () => {
  const make = (): { latch: ApproachRefusalLatch; tick: (s: number) => void } => {
    let clock = 0
    return { latch: new ApproachRefusalLatch(() => clock), tick: (s) => (clock += s) }
  }

  it('**另一条链清不掉** —— 2026-07-28 致命一(c)', () => {
    // 私聊里的一次成功 engage 曾经把群聊十秒前记下的拒绝抹掉，
    // 于是「拒绝 ApproachTip → 133 秒后直接 AutoApproach」那道侧门重新打开。
    const { latch } = make()
    latch.record('Z 反馈关不掉', { owner: A })
    expect(latch.clear('私聊 engage 成功', { owner: B })).toBe(false)
    expect(latch.active()?.reason).toBe('Z 反馈关不掉')
    // 同一条链可以
    expect(latch.clear('ApproachTip 重新判过了', { owner: A })).toBe(true)
    expect(latch.active()).toBeNull()
  })

  it('没有 owner 的拒绝谁都能清 —— 老行为，也是「没有 owner」的正确默认', () => {
    const { latch } = make()
    latch.record('理由')
    expect(latch.clear('任意一条链', { owner: B })).toBe(true)
  })

  it('`owner: null` 是管理员覆盖，无条件', () => {
    const { latch } = make()
    latch.record('理由', { owner: A })
    expect(latch.clear('管理员', { owner: null })).toBe(true)
  })

  it('不传 owner 也是无条件 —— 与传 `null` 同义', () => {
    const { latch } = make()
    latch.record('理由', { owner: A })
    expect(latch.clear('没说是谁')).toBe(true)
  })
})

describe('TTL：一次拒绝不该活得比它描述的硬件状态更久', () => {
  it('到点就失效，而且**在读的时候顺手丢掉**', () => {
    let clock = 0
    const latch = new ApproachRefusalLatch(() => clock)
    latch.record('理由', { owner: A })
    clock += APPROACH_REFUSAL_TTL_S - 1
    expect(latch.active()).not.toBeNull()
    clock += 2
    expect(latch.active()).toBeNull()
    // 丢掉之后再清，返回的是 false（没有可清的）
    expect(latch.clear('已经没了', { owner: A })).toBe(false)
  })

  it('600 秒覆盖那次事故的 133 秒，还有余量', () => {
    expect(APPROACH_REFUSAL_TTL_S).toBeGreaterThan(133 * 4)
  })

  it('重新记会**重置计时**，并且覆盖理由', () => {
    let clock = 0
    const latch = new ApproachRefusalLatch(() => clock)
    latch.record('第一次', { owner: A })
    clock += 500
    latch.record('第二次', { owner: A })
    clock += 200
    const r = latch.active()!
    expect(r.reason).toBe('第二次')
    expect(latch.ageS(r)).toBe(200)
  })
})

describe('拒绝文案 —— 出路必须在话里', () => {
  for (const [name, want] of Object.entries(golden.refusal_text)) {
    it(name, () => {
      const args: Record<string, [string, number, string]> = {
        typical: ['ApproachTip', 133.0, 'Z 反馈开关读不出'],
        zero_age: ['ApproachTip', 0.0, '理由'],
        no_reason: ['ApproachTip', 12.4, NO_REASON_PLACEHOLDER],
      }
      const [s, a, r] = args[name]!
      expect(approachRefusedText(s, a, r)).toBe(want)
    })
  }

  it('三条出路都在 —— 一条只说「被拒了」的拦截会让 agent 要么重试要么卡死', () => {
    const t = approachRefusedText('ApproachTip', 133, '理由')
    expect(t).toContain('Do NOT retry')
    expect(t).toContain('(1) 重新调用 ApproachTip')
    expect(t).toContain('(2) 先修好拒绝理由里说的那个状态')
    expect(t).toContain('(3) 交给用户在 GUI 手动进针')
  })

  it('话里点名 AutoApproach **就是**它拒绝的那个粗进针', () => {
    // 不说这一句的话，「被拒的是 ApproachTip、我调的是 AutoApproach」听起来
    // 像是两件事 —— 那正是那道侧门的心理形状。
    expect(approachRefusedText('ApproachTip', 133, '理由')).toContain(
      'AutoApproach 就是它拒绝的那个粗进针',
    )
  })
})
