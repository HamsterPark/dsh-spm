/**
 * 一动一观的判据（`act-gate.ts`）。接到 dsh 上的那一半在 `dsh-spm-stm-skills` 的
 * `act-gate.ts` 与它的 contract 测试里。
 */
import { describe, expect, it } from 'vitest'
import { ActGate, isRemedySkill, isStateChangingSkill } from './act-gate.js'
import { ACT_GATE_CODE, ACT_GATE_REFUSAL } from './messages.js'

describe('哪些技能改变仪器状态', () => {
  it.each([
    ['write', true],
    ['composite', true],
    ['read', false],
    ['analysis', false],
    ['READ', false],
    ['SkillCategory.Analysis', false],
    ['skillcategory.read', false],
  ])('category %j ⇒ %s', (category, changes) => {
    expect(isStateChangingSkill({ category })).toBe(changes)
  })

  it('**分类不出来就算会**（fail-closed）：缺类别、空串、没见过的类别', () => {
    expect(isStateChangingSkill({})).toBe(true)
    expect(isStateChangingSkill({ category: '' })).toBe(true)
    expect(isStateChangingSkill({ category: 'diagnostic' })).toBe(true)
  })
})

describe('补救动作', () => {
  it('样品门控豁免表里的名字是补救动作（名字从参数或声明里取）', () => {
    expect(isRemedySkill({ category: 'write' }, 'WithdrawTip')).toBe(true)
    expect(isRemedySkill({ name: 'EmergencyRetract' })).toBe(true)
    expect(isRemedySkill({ name: 'StopScan', tags: ['scan', 'imaging', 'write'] })).toBe(true)
  })

  it('带 stop / emergency 标签的也是（大小写不论）', () => {
    expect(isRemedySkill({ name: 'StopDataLog', tags: ['datalog', 'record', 'stop'] })).toBe(true)
    expect(isRemedySkill({ name: 'X', tags: ['EMERGENCY'] })).toBe(true)
  })

  it('**withdraw / retract 标签不算**：`SetWithdrawRate` 是一次配置写，不是退针', () => {
    expect(isRemedySkill({ name: 'SetWithdrawRate', tags: ['z', 'withdraw', 'safety', 'write'] })).toBe(false)
    expect(isRemedySkill({ name: 'SetZSpectrRetract', tags: ['spectroscopy', 'z', 'retract', 'write'] })).toBe(false)
    expect(isRemedySkill({ name: 'SetBias', tags: ['bias', 'write'] })).toBe(false)
    expect(isRemedySkill({})).toBe(false)
  })
})

describe('ActGate', () => {
  it('第一个放行并记账；结果被模型看到之前，同一会话的第二个不放行', () => {
    const g = new ActGate()
    expect(g.isPending('s1')).toBe(false)
    expect(g.admit('s1')).toBe(true)
    expect(g.isPending('s1')).toBe(true)
    expect(g.admit('s1')).toBe(false)
    expect(g.admit('s1')).toBe(false) // 被拒的那一次**不改变**待观察的状态
    g.acknowledge('s1')
    expect(g.isPending('s1')).toBe(false)
    expect(g.admit('s1')).toBe(true)
  })

  it('会话之间互不相干', () => {
    const g = new ActGate()
    expect(g.admit('a')).toBe(true)
    expect(g.admit('b')).toBe(true)
    expect(g.admit('a')).toBe(false)
    g.acknowledge('b')
    expect(g.admit('a')).toBe(false)
    expect(g.admit('b')).toBe(true)
  })

  it('补救动作在待观察时照样放行，而且**也记账**', () => {
    const g = new ActGate()
    expect(g.admit('s', true)).toBe(true) // 没有待观察的：放行、记账
    expect(g.admit('s')).toBe(false) // 退针之后再动别的，也得先看过退针的结果
    expect(g.admit('s', true)).toBe(true) // 待观察时：补救照样放行
    expect(g.isPending('s')).toBe(true)
  })

  it('回执一个没有待观察的会话不出错；忘掉一个会话之后它从零开始', () => {
    const g = new ActGate()
    g.acknowledge('nobody')
    expect(g.admit('s')).toBe(true)
    g.forget('s')
    expect(g.isPending('s')).toBe(false)
    expect(g.admit('s')).toBe(true)
  })
})

describe('拒绝文案（messages.ts）', () => {
  it('逐字钉住：码在前、参考实现的两句话，而且是一整行', () => {
    expect(ACT_GATE_REFUSAL).toBe(
      '[act_gate] Observe the result of the previous action that changes the instrument before another such action. ' +
        'No action was executed.',
    )
    expect(ACT_GATE_REFUSAL.startsWith(`[${ACT_GATE_CODE}] `)).toBe(true)
    expect(ACT_GATE_REFUSAL).not.toMatch(/[\r\n]/)
    // 「这一次什么都没发生」这句必须在：模型据此知道要先看结果，而不是以为它已经跑了
    expect(ACT_GATE_REFUSAL).toContain('No action was executed.')
  })
})
