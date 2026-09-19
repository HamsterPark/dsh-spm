/**
 * 批 6a：`_tip_phases` 六个流程的依赖账 —— 对 `spec/golden/tip_phase_deps.json`。
 *
 * ## 这一批**一个技能都没落**，而这个文件就是那件事的判据
 *
 * 盘点写着这六个卡在 `AssessClusterRoundness`，而那个技能批 4a 已经落了。
 * 照旧仓源码数下来**不是这样**：六条流程里有五条的第一个动作是
 * `_relocate` → `FindCleanSpot`（`_tip_phases.py:623`），第六条（`PulseConditionTip`）
 * 的第一发脉冲之前也是它。`FindCleanSpot` 压着整套实验地图子系统
 * （`core/map_scope` 322 + `io/map_analysis` 1206 + `io/exp_map` 1015 + `io/coarse_map` 604），
 * 这一轮不在范围内。
 *
 * ⚠️ 而这些缺席的步骤**几乎全是 `optional=True`**（下面第三组逐条钉着）。
 * 缺一个必需步骤，执行器当场中止，报的是那一步自己的错；缺一个可选步骤，
 * 流程**接着跑**，拿一个空结果往下判 —— `_relocate` 拿不到落点时
 * `pulse_phase` 报的是「这片表面已经没有可用的落点了 —— 该粗动换区」，
 * **一句关于样品的假话**，而一发脉冲都没打过。所以「不落」不是保守，
 * 是因为落下去的那个东西会撒谎。
 *
 * ## 三组判据
 *
 * 1. **两张依赖表由源码算出来**（`tip-selfcheck.ts` 的那两个常量）。手抄的表会静静过期；
 * 2. **每个自检问的是它自己那条链** —— 两条链各有对方没有的成员；
 * 3. **批 6a 的封锁账**：六条流程各缺哪几个。
 *    ⚠️ 第三组**红了是好消息**：说明最后一个封锁件落了，批 6a 可以重开。
 *    改这张表的人请顺手核一遍 `_tip_phases.py` 那六条流程还差什么。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IMPLEMENTED } from './index.js'
import {
  CONDITIONING_REQUIRED_SKILLS,
  FORGE_REQUIRED_SKILLS,
  makeTipConditioningSelfCheck,
  makeTipForgeSelfCheck,
} from './tip-selfcheck.js'
import {
  processTipRegistry,
  resolveConditioning,
  setCurrentTip,
  type SkillContext,
} from 'dsh-spm-kernel'
import { BiasPulseWithReadback, TipShapeWithReadback } from './readback-skills.js'
import { TipShape } from './tip-shape.js'

interface SubSkillDep {
  readonly required_somewhere: boolean
  readonly sites: readonly { readonly file: string; readonly line: number; readonly optional: boolean }[]
}
interface FlowDep {
  readonly entry: string
  readonly functions: readonly string[]
  readonly code_lines: number
  readonly sub_skills: Readonly<Record<string, SubSkillDep>>
}

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/tip_phase_deps.json', import.meta.url)),
    'utf8',
  ),
) as { skills: Readonly<Record<string, FlowDep>> }

/** 这个自检替哪几个技能背书 —— 依赖表 = 它们 ∪ 它们的子技能闭包。 */
const NOBLE = ['PrepareNobleTip', 'PokeConditionTip', 'PulseConditionTip'] as const
const SPECIAL = ['MakeSpectroscopyTip', 'MakeAtomicResolutionTip'] as const

function unionOf(flows: readonly string[]): string[] {
  const out = new Set<string>()
  for (const f of flows) for (const s of Object.keys(GOLDEN.skills[f]!.sub_skills)) out.add(s)
  return [...out].sort()
}

describe('批 6a：两张依赖表由旧仓源码算出来', () => {
  it('`CONDITIONING_REQUIRED_SKILLS` = 三条贵金属流程 ∪ 它们的子技能闭包', () => {
    expect([...CONDITIONING_REQUIRED_SKILLS].sort()).toEqual(
      [...new Set([...NOBLE, ...unionOf(NOBLE)])].sort(),
    )
  })

  it('`FORGE_REQUIRED_SKILLS` = 两条特异化流程 ∪ 它们的子技能闭包', () => {
    expect([...FORGE_REQUIRED_SKILLS].sort()).toEqual(
      [...new Set([...SPECIAL, ...unionOf(SPECIAL)])].sort(),
    )
  })

  it('`PokeConditionTip` **不是**特异化流程的子技能 —— 它们共用的是生成器，不是技能', () => {
    // `make_special_tip.py` 写的是 `yield from poke_phase(...)`（292 / 855 两处）。
    // 这一条是上一条的**反面输入**：没有它，把一个技能名随手加进表里不会有人发现。
    for (const flow of SPECIAL) {
      expect(Object.keys(GOLDEN.skills[flow]!.sub_skills)).not.toContain('PokeConditionTip')
    }
    expect(FORGE_REQUIRED_SKILLS).not.toContain('PokeConditionTip')
    // 而它本身没有漏掉：贵金属那张表报着它。
    expect(CONDITIONING_REQUIRED_SKILLS).toContain('PokeConditionTip')
  })
})

describe('两个自检各问各的链', () => {
  // 自检只有一次硬件读（`TipShaper_PropsGet`），给它一个回得动的桩就够了 ——
  // 这一组问的是「这个自检数的是哪一条链」，与仪器无关。
  const ctx = {
    signal: new AbortController().signal,
    safeCall: (method: string, ...args: unknown[]) => Promise.resolve({ method, args, values: [0] }),
    markers: { emit: () => {} },
  } as unknown as SkillContext

  async function missingOf(skill: {
    execute: (c: SkillContext, p: Record<string, unknown>) => unknown
  }): Promise<string[]> {
    setCurrentTip(null)
    const r = (await skill.execute(ctx, {})) as { data: { missing_skills: string[] } }
    return r.data.missing_skills
  }

  it('修针自检报 `PreScanCheck` / `AnalyzeFrameTilt`，**不**报 `BiasWiggle` / `AssessShockleyOnset`', async () => {
    const missing = await missingOf(makeTipConditioningSelfCheck({}))
    expect(missing).toContain('PreScanCheck')
    expect(missing).toContain('AnalyzeFrameTilt')
    expect(missing).not.toContain('BiasWiggle')
    expect(missing).not.toContain('AssessShockleyOnset')
  })

  it('锻造自检报 `BiasWiggle` / `AssessShockleyOnset`，**不**报 `PreScanCheck` / `AnalyzeFrameTilt`', async () => {
    const missing = await missingOf(makeTipForgeSelfCheck({}))
    expect(missing).toContain('BiasWiggle')
    expect(missing).toContain('AssessShockleyOnset')
    expect(missing).not.toContain('PreScanCheck')
    expect(missing).not.toContain('AnalyzeFrameTilt')
  })

  it('`AutoTilt` 两条链都要 —— 台面上的调平在 `flat_poke_sites` 里，两条都走它', async () => {
    // 批 6a 之前锻造那张表漏了它：`TipForgeSelfCheck` 少报了一条缺口。
    expect(await missingOf(makeTipConditioningSelfCheck({}))).toContain('AutoTilt')
    expect(await missingOf(makeTipForgeSelfCheck({}))).toContain('AutoTilt')
  })
})

describe('批 6a 的封锁账 —— 红了说明可以重开这一批', () => {
  /** 每条流程**今天**还缺的子技能。空表 = 这条流程可以移了。 */
  const BLOCKED: Readonly<Record<string, readonly string[]>> = {
    PulseConditionTip: ['FindCleanSpot'],
    PokeConditionTip: ['AutoTilt', 'FindCleanSpot', 'FindFlatRegion'],
    MakeSpectroscopyTip: ['AssessShockleyOnset', 'AutoTilt', 'FindCleanSpot', 'FindFlatRegion'],
    MakeAtomicResolutionTip: [
      'AssessAtomicPhase', 'AutoTilt', 'BiasWiggle', 'FindCleanSpot', 'FindFlatRegion',
    ],
    PrepareNobleTip: [
      'AnalyzeFrameTilt', 'AssessTipSharpness', 'AutoTilt', 'FindCleanSpot',
      'FindFlatRegion', 'PreScanCheck',
    ],
    ForgeAuTip: [
      'AnalyzeFrameTilt', 'AssessTipSharpness', 'AutoTilt', 'FindCleanSpot',
      'FindFlatRegion', 'PreScanCheck',
    ],
  }

  const installed = new Set(Object.keys(IMPLEMENTED))

  it.each(Object.keys(BLOCKED))('%s', (flow) => {
    const blocked = Object.keys(GOLDEN.skills[flow]!.sub_skills)
      .filter((n) => !installed.has(n))
      .sort()
    expect(blocked).toEqual([...BLOCKED[flow]!])
  })

  it('六条**全部**卡在 `FindCleanSpot` 上，而且它每一处都是 `optional=True`', () => {
    for (const flow of Object.keys(BLOCKED)) {
      const dep = GOLDEN.skills[flow]!.sub_skills['FindCleanSpot']
      expect(dep, flow).toBeDefined()
      // 「可选」在这里不是「可以不要」：它失败时流程接着跑，然后报
      // 「这片表面已经没有可用的落点了」—— 一句关于样品的假话。
      expect(dep!.required_somewhere, flow).toBe(false)
      expect(dep!.sites.every((s) => s.optional), flow).toBe(true)
    }
    expect(installed.has('FindCleanSpot')).toBe(false)
  })

  it('每一发脉冲都经过针尖包络 —— `pulse_phase` 只从 `BiasPulseWithReadback` 出去', () => {
    // 要害 ③ 的前一半。`_tip_phases.py:839` 是六条流程里**唯一**的脉冲出口，
    // 而本仓那个技能的 `validateParams` 把 `bias_v` 映到方案表的 `pulse_v`（批 5a）。
    setCurrentTip(null)
    expect(BiasPulseWithReadback.validateParams?.({ bias_v: 12 })).toHaveLength(1)
    expect(BiasPulseWithReadback.validateParams?.({ bias_v: -12 })).toHaveLength(1)
    expect(BiasPulseWithReadback.validateParams?.({ bias_v: 10 })).toEqual([])
    // 会打脉冲的是这三条（另三条只扎针 / 只磨）；而打脉冲的**只有这一个出口** ——
    // 没有哪条流程绕开它去直调 `BiasPulse` 或 `TipPulse`。
    const pulsing = Object.keys(GOLDEN.skills).filter((f) =>
      Object.keys(GOLDEN.skills[f]!.sub_skills).includes('BiasPulseWithReadback'),
    )
    expect(pulsing.sort()).toEqual(['ForgeAuTip', 'PrepareNobleTip', 'PulseConditionTip'])
    for (const flow of Object.keys(GOLDEN.skills)) {
      const subs = Object.keys(GOLDEN.skills[flow]!.sub_skills)
      expect(subs, flow).not.toContain('BiasPulse')
      expect(subs, flow).not.toContain('TipPulse')
    }
  })

  it('**每一次扎入也经过深度那半道闸** —— 两个孪生技能同一个函数、同一层（K6）', () => {
    // 要害 ③ 的后一半。批 6a 第一趟核出来它**经不过**（登记成 D-TIPDEPTH）；
    // 这一趟把它接上了 —— 接线与「为什么不能塞进 `applyTipPolicy`」见 `tipDepthRefusals`。
    //
    // 六条流程的扎入只有一个出口：`_poke_step` → `TipShapeWithReadback`，
    // 深度走 `tip_lift_m`（`_tip_phases.py:1815`，`tip_lift_m: -abs(depth_m)`）。
    setCurrentTip(null)
    const DEEP = -5e-8 // 50 nm 下压：在声明范围 ±100 nm 之内，在通用档包络 10 nm 之外
    for (const [name, skill] of [
      ['TipShapeWithReadback', TipShapeWithReadback],
      ['TipShape', TipShape],
    ] as const) {
      const got = skill.validateParams?.({ tip_lift_m: DEEP })
      expect(got, name).toHaveLength(1)
      // 文案逐字与解析器同源 —— 这一层不自己写第二句话。
      expect(got, name).toEqual(
        resolveConditioning(['shaper_depth_m'], { shaper_depth_m: DEEP }).refusals,
      )
    }
  })

  it('上限是「不许超」不是「不许到」—— 正好 10 nm 放行，多一点点就拒', () => {
    // 深度那条 `>` 此前**一格输入都没有**：金样里的深度用例是 −0.3 nm（过）与
    // −1.2 / −2 / −5 nm（拒），线上一格没有。变异 `tip-depth-boundary-is-exclusive` 钉着它。
    setCurrentTip(null)
    expect(TipShape.validateParams?.({ tip_lift_m: -1e-8 })).toEqual([])
    expect(TipShape.validateParams?.({ tip_lift_m: -1.0000001e-8 })).toHaveLength(1)
  })

  it('**没给 `tip_lift_m` 就什么都不判** —— 不查表、不凭空造一个深度', () => {
    // 这一条挡的是那个「最自然但错的」接法：把 `shaper_depth_m` 加进
    // `applyTipPolicy` 的 `policyFields`。那样没给深度时方案表会**填一个进去**，
    // 于是一次根本没要求下压的调用会被拒 —— 「出厂默认落在自己包络之外」那条路复活。
    //
    // 两侧输入齐了才验得到：把包络收到 **0.5 nm**（通用档出厂 `shaper_depth_m` 是 −1 nm）。
    // 没有这个覆写，查不查表都得到同一个答案（空表），这道闸就永远轮不到它做决定。
    setCurrentTip(null)
    processTipRegistry.overrides = { max_poke_depth_m: 5e-10 }
    try {
      // 出厂默认此刻确实**超了**它自己的包络 —— 这是这一格的反面输入。
      expect(
        resolveConditioning(['shaper_depth_m'], {}).refusals.join(''),
      ).toContain('下压深度超出')
      // 而没给 `tip_lift_m` 的调用**一个字都不该说**。
      expect(TipShape.validateParams?.({})).toEqual([])
      expect(TipShapeWithReadback.validateParams?.({})).toEqual([])
      expect(TipShape.validateParams?.({ bias_v: 0.02 })).toEqual([])
    } finally {
      processTipRegistry.overrides = {}
    }
  })

  it('抬起不是下压 —— `tip_lift_m` 为正时这道闸没有话说', () => {
    // `shaper_depth_m` 的定义域是下压（方案表全表负数）。`checkEnvelope` 按绝对值比，
    // 是因为那个字段按构造就是负的；把一次**抬离表面 50 nm** 送进去，等于凭空多一条
    // 方案表从来没声明过的限制。一次抬离不会戳坏音叉。
    setCurrentTip(null)
    expect(TipShape.validateParams?.({ tip_lift_m: 5e-8 })).toEqual([])
    expect(TipShapeWithReadback.validateParams?.({ tip_lift_m: 5e-8 })).toEqual([])
  })

  it('`AssessClusterRoundness` 已经落了 —— 盘点说的那道闸**不是**还卡着的那一道', () => {
    expect(installed.has('AssessClusterRoundness')).toBe(true)
    // 而它确实在这几条流程里（`_cluster_look`，`_tip_phases.py:1907`）：
    // 盘点没说错它的位置，说错的是「解开它这一批就能动」。
    for (const flow of ['PokeConditionTip', 'PrepareNobleTip', 'ForgeAuTip']) {
      expect(Object.keys(GOLDEN.skills[flow]!.sub_skills)).toContain('AssessClusterRoundness')
    }
    expect(Object.keys(GOLDEN.skills['PulseConditionTip']!.sub_skills)).not.toContain(
      'AssessClusterRoundness',
    )
  })
})
