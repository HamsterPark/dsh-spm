/**
 * 样品门控对金样。四张表逐项比、15 条判定逐条比、**两句拒绝文案逐字比**。
 *
 * 最要紧的是**顺序**：豁免在产数据判断之前。一个既叫 `StopScan` 又带 `scan` 标签的
 * 技能必须放行——顺序反了，操作员就会在针要撞上去的时候按不动停止。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DATA_NAMES,
  DATA_TAGS,
  GATE_EXEMPT_NAMES,
  GATE_EXEMPT_TAGS,
  checkSampleScope,
  requiresSample,
  sampleGateMessage,
} from './sample-gate.js'

interface Golden {
  sample_gate: { exempt_names: string[]; exempt_tags: string[]; data_tags: string[]; data_names: string[] }
  sample_gate_cases: {
    case: string
    name: string
    tags: string[]
    category: string | null
    capabilities: string[]
    requires_sample: boolean
  }[]
  sample_gate_messages: { no_experiment: string; no_sample: string }
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/safety.json', import.meta.url)), 'utf8'),
) as Golden

describe('金样：样品门控的四张表', () => {
  it('豁免名单', () => {
    expect([...GATE_EXEMPT_NAMES].sort()).toEqual(golden.sample_gate.exempt_names)
  })
  it('豁免标签', () => {
    expect([...GATE_EXEMPT_TAGS].sort()).toEqual(golden.sample_gate.exempt_tags)
  })
  it('产数据标签', () => {
    expect([...DATA_TAGS].sort()).toEqual(golden.sample_gate.data_tags)
  })
  it('产数据名单', () => {
    expect([...DATA_NAMES].sort()).toEqual(golden.sample_gate.data_names)
  })
})

describe('金样：判定顺序（豁免在产数据之前）', () => {
  for (const c of golden.sample_gate_cases) {
    it(`${c.case} ⇒ ${c.requires_sample ? '要样品' : '放行'}`, () => {
      expect(
        requiresSample(
          {
            name: c.name,
            tags: c.tags,
            category: c.category ?? undefined,
            capabilities: c.capabilities,
          },
          c.name,
        ),
      ).toBe(c.requires_sample)
    })
  }
})

describe('金样：拒绝文案逐字', () => {
  it('没有实验时', () => {
    expect(sampleGateMessage('StartScan', false)).toBe(golden.sample_gate_messages.no_experiment)
  })
  it('有实验但没选样品时', () => {
    expect(sampleGateMessage('StartScan', true)).toBe(golden.sample_gate_messages.no_sample)
  })
  it('两句都明确说了「不要原样重试」——否则模型会陷进重试循环', () => {
    for (const m of Object.values(golden.sample_gate_messages)) {
      expect(m).toContain('Do NOT retry this call unchanged')
    }
  })
})

describe('checkSampleScope 的 fail-open 方向', () => {
  const scanMeta = { name: 'StartScan', tags: ['scan'] }

  it('记录系统缺席（指针为 undefined）⇒ **一律放行**，不能把仪器锁死', () => {
    expect(checkSampleScope(scanMeta, 'StartScan', undefined)).toBeNull()
    expect(checkSampleScope(scanMeta, 'StartScan', null)).toBeNull()
  })

  it('选了样品 ⇒ 放行', () => {
    expect(checkSampleScope(scanMeta, 'StartScan', { experimentId: 'e1', sampleId: 's1' })).toBeNull()
  })

  it('有实验没样品 ⇒ no_active_sample', () => {
    const m = checkSampleScope(scanMeta, 'StartScan', { experimentId: 'e1', sampleId: null })
    expect(m).toContain('no_active_sample')
  })

  it('实验也没有 ⇒ no_active_experiment', () => {
    const m = checkSampleScope(scanMeta, 'StartScan', { experimentId: null, sampleId: null })
    expect(m).toContain('no_active_experiment')
  })

  it('**安全操作在任何情况下都畅通**——哪怕实验和样品都没有', () => {
    for (const name of ['SafeRetract', 'EmergencyRetract', 'StopScan', 'WithdrawTip']) {
      expect(checkSampleScope({ name }, name, { experimentId: null, sampleId: null }), name).toBeNull()
    }
  })
})
