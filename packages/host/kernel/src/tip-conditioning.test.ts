/**
 * 针尖方案表 + 安全包络 —— 逐格对 `spec/golden/tip_policy.json`。
 *
 * 那份金样由**旧仓真实的解析层**跑出来（`tools/spec-export/export_tip_policy.py`），
 * 12 支针尖 × 22 个请求 = 264 格，其中 111 格被拒。通用轨迹金样一格都照不到这里：
 * 它直调 `execute`，而这一层全部住在 `validate_params` / 解析层。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { resolvePolicy } from './tip-conditioning-policy.js'
import { envelopeOf, humanTrace, resolveConditioning } from './tip-conditioning-resolver.js'
import {
  currentTipFacts,
  getCurrentTip,
  isQPlus,
  normalizeFabrication,
  normalizeForm,
  normalizeMaterial,
  processTipRegistry,
  setCurrentTip,
  type TipFacts,
} from './tip-registry.js'

interface TipEntry {
  readonly facts: TipFacts | null
  readonly values: Record<string, number>
  readonly sources: Record<string, string>
  readonly notes: string[]
  readonly envelope: Record<string, number>
}
interface CaseEntry {
  readonly fields: string[]
  readonly explicit: Record<string, unknown>
  readonly overrides: Record<string, unknown>
  readonly params: Record<string, unknown>
  readonly trace: Record<string, string>
  readonly refusals: string[]
  readonly ok: boolean
  readonly human_trace: string
  readonly notes: string[]
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/tip_policy.json', import.meta.url)),
    'utf8',
  ),
) as { tips: Record<string, TipEntry>; cases: Record<string, CaseEntry> }

beforeEach(() => {
  // 进程级 holder：**先全清**。漏清一次就会让后面某一格「因为上一格登记过一支
  // qPlus」而走另一条路，而那种绿最难看出来（批 3k 的原话）。
  setCurrentTip(null)
  processTipRegistry.overrides = {}
})

describe('方案表：每一档查出来的整组值 + 来源 + 说明', () => {
  for (const [name, want] of Object.entries(golden.tips)) {
    it(`${name}：值 / 来源 / 说明逐条`, () => {
      const got = resolvePolicy(want.facts)
      expect(got.values).toEqual(want.values)
      expect(got.sources).toEqual(want.sources)
      expect(got.notes).toEqual(want.notes)
      expect(envelopeOf(want.facts)).toEqual(want.envelope)
    })
  }

  it('**全表只剩一个包络字段还在分辨针尖** —— 2026-08-12 把另外两个拉满了', () => {
    const pulse = new Set<number>()
    const depth = new Set<number>()
    const count = new Set<number>()
    for (const t of Object.values(golden.tips)) {
      pulse.add(t.envelope['max_abs_pulse_v'] as number)
      depth.add(t.envelope['max_poke_depth_m'] as number)
      count.add(t.envelope['max_pulse_count'] as number)
    }
    // D-TIP-1 与盘点都写着「铂铱 8 V、qPlus 3 V」——**今天的旧仓不是这样**。
    expect([...pulse]).toEqual([10.0])
    expect([...depth]).toEqual([1e-8])
    expect([...count].sort()).toEqual([2, 5])
  })
})

describe('解析 + 包络：264 格逐条对旧仓', () => {
  for (const [key, want] of Object.entries(golden.cases)) {
    it(`${key}：参数 / 来源 / 拒绝文案`, () => {
      const facts = golden.tips[key.split('/')[0]!]!.facts
      const got = resolveConditioning(want.fields, want.explicit, {
        facts,
        overrides: want.overrides,
      })
      expect(got.params).toEqual(want.params)
      expect(got.trace).toEqual(want.trace)
      expect([...got.refusals]).toEqual(want.refusals)
      expect(got.ok).toBe(want.ok)
      expect(humanTrace(got)).toBe(want.human_trace)
      expect([...got.notes]).toEqual(want.notes)
    })
  }
})

describe('**超上限拒绝、不夹紧** —— 这一条是判据，不是措辞', () => {
  it('被拒的那一格里，参数原样留着（没有被悄悄改成上限）', () => {
    let checked = 0
    for (const [key, want] of Object.entries(golden.cases)) {
      if (want.refusals.length === 0) continue
      const facts = golden.tips[key.split('/')[0]!]!.facts
      const got = resolveConditioning(want.fields, want.explicit, {
        facts,
        overrides: want.overrides,
      })
      for (const [k, v] of Object.entries(want.explicit)) {
        if (v === '' || v === null) continue
        expect(got.params[k]).toEqual(v)
      }
      checked += 1
    }
    expect(checked).toBe(111)
  })
})

describe('针尖 holder：读不到就是未登记，绝不猜', () => {
  it('没登记 ⇒ `currentTipFacts()` 是 null，而通用档**照样有包络**', () => {
    expect(currentTipFacts()).toBeNull()
    expect(isQPlus()).toBe(false)
    // fail-open 的是 `qplus_gate`（本仓不移，出厂就是关的），不是这一层。
    const res = resolveConditioning(['pulse_count'], { pulse_count: 6 })
    expect(res.ok).toBe(false)
    expect(res.refusals[0]).toContain('未登记针尖的通用档')
  })

  it('登记一支 qPlus ⇒ 同一个请求换一档包络（2 发 vs 5 发）', () => {
    setCurrentTip({ name: 'W-qPlus', material: 'W', fabrication: 'etched', form: 'qplus' })
    expect(isQPlus()).toBe(true)
    const res = resolveConditioning(['pulse_count'], { pulse_count: 3 })
    expect(res.ok).toBe(false)
    expect(res.refusals[0]).toBe('pulse_count=3 超出当前针尖（W-qPlus）的上限 2 发。拒绝执行。')
  })

  it('**入口归一**：一行「钨 / 电化学腐蚀 / 音叉」查得到 qPlus 那一档', () => {
    setCurrentTip({ name: '手填的', material: '钨', fabrication: '电化学腐蚀', form: '音叉' })
    const facts = currentTipFacts()
    expect(facts?.material).toBe('W')
    expect(facts?.fabrication).toBe('etched')
    expect(facts?.form).toBe('qplus')
    // 不归一的话这一行会**静默落到通用档**，而通用档是 5 发。
    expect(resolveConditioning(['pulse_count'], { pulse_count: 3 }).ok).toBe(false)
  })

  it('认不出的写法**留空**，不是留原文 —— 空串在查表链里表示「这一维不区分」', () => {
    setCurrentTip({ name: 'x', material: '镅', fabrication: '激光切', form: '某种' })
    const facts = currentTipFacts()
    expect(facts?.material).toBe('')
    expect(facts?.fabrication).toBe('unknown')
    expect(facts?.form).toBe('stm_wire')
    expect(normalizeMaterial('镅')).toBeNull()
    expect(normalizeFabrication('激光切')).toBeNull()
    expect(normalizeForm('某种')).toBeNull()
  })

  it('词表值本身、大小写、别名三条路都认', () => {
    expect(normalizeMaterial('PtIr')).toBe('PtIr')
    expect(normalizeMaterial('ptir')).toBe('PtIr')
    expect(normalizeMaterial('Pt80Ir20')).toBe('PtIr')
    expect(normalizeMaterial('铂铱合金')).toBe('PtIr')
    expect(normalizeMaterial(' tungsten ')).toBe('W')
    expect(normalizeForm('q-plus')).toBe('qplus')
    expect(normalizeForm('tuning fork')).toBe('qplus')
    expect(normalizeMaterial('')).toBeNull()
    expect(normalizeMaterial(null)).toBeNull()
  })

  it('`getCurrentTip()` 交的是**副本** —— 改它不该改 holder', () => {
    setCurrentTip({ name: 'A', material: 'W', fabrication: 'cut', form: 'stm_wire' })
    const row = getCurrentTip() as Record<string, unknown>
    row['material'] = 'Nb'
    expect(currentTipFacts()?.material).toBe('W')
  })
})

describe('覆写：能收紧，坏值被忽略而不是变成 0', () => {
  it('进程级覆写与显式覆写走同一条路', () => {
    processTipRegistry.overrides = { max_abs_pulse_v: 3.0 }
    const res = resolveConditioning(['pulse_v'], { pulse_v: 5.0 })
    expect(res.ok).toBe(false)
    expect(res.refusals[0]).toContain('±3 V')
  })

  it('一个结构错的覆写**被忽略**——`Number([])` 是 0，而 0 会变成一道假闸', () => {
    processTipRegistry.overrides = { max_abs_pulse_v: [] as unknown as number }
    const res = resolveConditioning(['pulse_v'], { pulse_v: 5.0 })
    expect(res.ok).toBe(true)
    expect(resolvePolicy(null).values['max_abs_pulse_v']).toBe(10.0)
  })

  it('覆写不能凭空长出一个字段', () => {
    const pol = resolvePolicy(null, { overrides: { nope: 1, _note: 'x' } })
    expect(pol.values['nope']).toBeUndefined()
    expect(pol.values['_note']).toBeUndefined()
  })
})
