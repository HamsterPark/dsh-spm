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
import { NOBLE_FLOWS, SPECIAL_FLOWS, SUB_SKILL_RUNS, skillClosure } from './tip-phase-closure.js'
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
  /** 批 7b-1：闭包里那些函数要的、**不是技能**的东西（旧仓模块 → 名字）。 */
  readonly non_skill_deps: Readonly<Record<string, readonly string[]>>
}
/** 批 7b-1：一个技能**自己**还会发出去的技能名（`context.run` / `CompositeStep`）。 */
interface SkillRuns {
  readonly defined_in: readonly string[]
  readonly runs: readonly string[]
  readonly internal_phases?: readonly string[]
  readonly unresolved?: readonly { readonly file: string; readonly line: number; readonly expr: string }[]
}
/** 批 7b-1：这套追法**追到哪儿为止**。缺这一节的闭包不算闭包。 */
interface ClosureLimits {
  readonly scanned_root: string
  readonly modules_scanned: number
  readonly skills_indexed: number
  readonly follow_rule: string
  readonly unknown_skills: readonly string[]
  readonly dynamic_run_sites: readonly {
    readonly file: string
    readonly line: number
    readonly expr: string
    readonly shape: string
    readonly in_engine: boolean
  }[]
  readonly internal_phase_targets: Readonly<Record<string, readonly string[]>>
  readonly cycles: readonly (readonly string[])[]
}

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/tip_phase_deps.json', import.meta.url)),
    'utf8',
  ),
) as {
  skills: Readonly<Record<string, FlowDep>>
  skill_runs: Readonly<Record<string, SkillRuns>>
  closure_limits: ClosureLimits
}

/** 这个自检替哪几个技能背书 —— 依赖表 = 它们出发的**闭包**（批 7b-1 之前是一层）。 */
const NOBLE = ['PrepareNobleTip', 'PokeConditionTip', 'PulseConditionTip'] as const
const SPECIAL = ['MakeSpectroscopyTip', 'MakeAtomicResolutionTip'] as const

function unionOf(flows: readonly string[]): string[] {
  const out = new Set<string>()
  for (const f of flows) for (const s of Object.keys(GOLDEN.skills[f]!.sub_skills)) out.add(s)
  return [...out].sort()
}

/**
 * 金样侧的闭包 —— **独立于生产代码那一份**（`tip-phase-closure.ts`）。
 *
 * 两份实现算出同一个集合才算数：生产那一份用手写的边表
 * {@link SUB_SKILL_RUNS}，这一份直接走旧仓导出的 `skill_runs`。
 * 用生产那一个函数来验生产那张表，问的就只是「代码等于它自己」。
 */
function goldenClosure(seeds: readonly string[]): string[] {
  const seen = new Set<string>()
  const stack = [...seeds]
  while (stack.length > 0) {
    const n = stack.pop() as string
    if (seen.has(n)) continue
    seen.add(n)
    const rec = GOLDEN.skill_runs[n]
    // 没有这一行 ⇒ 追不动。金样的 `closure_limits.unknown_skills` 负责把这种
    // 名字显式列出来，下面有一条测试盯着那张表是空的。
    if (rec !== undefined) for (const m of rec.runs) stack.push(m)
  }
  return [...seen].sort()
}

describe('批 6a：两张依赖表由旧仓源码算出来', () => {
  it('`CONDITIONING_REQUIRED_SKILLS` = 三条贵金属流程出发的**闭包**', () => {
    expect([...CONDITIONING_REQUIRED_SKILLS].sort()).toEqual(goldenClosure(NOBLE))
  })

  it('`FORGE_REQUIRED_SKILLS` = 两条特异化流程出发的**闭包**', () => {
    expect([...FORGE_REQUIRED_SKILLS].sort()).toEqual(goldenClosure(SPECIAL))
  })

  it('闭包**比一层多**七个 / 四个 —— 不多出来就说明这一批白做了', () => {
    // 这一条是整批 7b-1 的反面输入。上面两条用的是同一个金样：如果哪天
    // `goldenClosure` 退回成 `unionOf`（= 一层），它们**照样全绿** ——
    // 两边一起变，比出来的永远是「代码等于它自己」。
    //
    // 所以在这里把差额本身钉住：那七个名字全是**第二层**的，而第二层里
    // `TiltProbeCircle` 是 353 行的真技能，不是一条无关紧要的边。
    expect(goldenClosure(NOBLE).filter((n) => !unionOf(NOBLE).includes(n) && !NOBLE.includes(n as never))).toEqual([
      'ConfigureScan', 'SetScanBuffer', 'SetScanSpeed', 'SetZCtrlGain', 'StartScan',
      'TiltProbeCircle', 'WaitScanComplete',
    ])
    expect(
      goldenClosure(SPECIAL).filter((n) => !unionOf(SPECIAL).includes(n) && !SPECIAL.includes(n as never)),
    ).toEqual(['SetScanBuffer', 'SetZCtrlGain', 'TiltProbeCircle', 'WaitScanComplete'])
  })

  it('两条链上**每一个**名字都有一行边表 —— 空表是「查过了」，缺行是「没查」', () => {
    // `tip-phase-closure.ts` 的那张手写边表与金样逐行对账。
    // 旧仓多一条 `context.run`，这一条当场红 —— 这就是那张表不会静静过期的理由。
    const reach = [...new Set([...goldenClosure(NOBLE), ...goldenClosure(SPECIAL)])].sort()
    expect(Object.keys(SUB_SKILL_RUNS).sort()).toEqual(reach)
    for (const n of reach) {
      expect([...(SUB_SKILL_RUNS[n] as readonly string[])].sort(), n).toEqual([...GOLDEN.skill_runs[n]!.runs].sort())
    }
    // 而且这张表自己**没有停在半路**：两条链的闭包里一行都不缺。
    expect(skillClosure(NOBLE_FLOWS, SUB_SKILL_RUNS).stoppedAt).toEqual([])
    expect(skillClosure(SPECIAL_FLOWS, SUB_SKILL_RUNS).stoppedAt).toEqual([])
  })

  it('缺行会被报成 `stoppedAt`，**不会**被当成叶子静静吞掉', () => {
    // 上一条断言的是「今天不缺」。这一条断言的是「缺了会说出来」——
    // 没有它，`stoppedAt` 恒为空表也能过，而那正是「一个说不清自己追到哪儿的闭包」。
    const holed = { ...SUB_SKILL_RUNS } as Record<string, readonly string[]>
    delete holed['TiltProbeCircle']
    const r = skillClosure(NOBLE_FLOWS, holed)
    expect(r.stoppedAt).toEqual(['TiltProbeCircle'])
    // 名字照样在闭包里（它确实被叫到了），只是「它自己还叫谁」不知道。
    expect(r.names).toContain('TiltProbeCircle')
  })

  it('防环：自己叫自己也停得下来，闭包还是对的', () => {
    // 旧仓今天零环（金样 `closure_limits.cycles` 是空表，下面那一组盯着）。
    // 「今天没有」不是「不会有」—— 而一个会挂死的闭包，第一次出现环时
    // 拿到的不是红色，是一个跑不完的测试。
    const loop = { A: ['B'], B: ['C'], C: ['A'] } as Record<string, readonly string[]>
    expect(skillClosure(['A'], loop)).toEqual({ names: ['A', 'B', 'C'], stoppedAt: [] })
    expect(GOLDEN.closure_limits.cycles).toEqual([])
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

  // ⚠️ **这三条问的是「这个自检数的是哪一条链」，不是「谁还没落」。**
  //
  // 第一版写的是 `missing_skills` 里有没有那几个名字 —— 而那等于把「链上有它」
  // 与「它还没移植」绑在一起：批 7a-1 落了 `AnalyzeFrameTilt` / `AutoTilt` 之后，
  // 这三条全红了，而**链一个字都没变**。
  // 断言改问声明表（`*_REQUIRED_SKILLS`），链变了才红；`missing_skills` 那一侧
  // 只钉住一条**不随移植进度变**的性质：它是声明表的子集，而且**只含还没落的那些**。

  it('修针自检数 `PreScanCheck` / `AnalyzeFrameTilt`，**不**数 `BiasWiggle` / `AssessShockleyOnset`', async () => {
    expect(CONDITIONING_REQUIRED_SKILLS).toContain('PreScanCheck')
    expect(CONDITIONING_REQUIRED_SKILLS).toContain('AnalyzeFrameTilt')
    expect(CONDITIONING_REQUIRED_SKILLS).not.toContain('BiasWiggle')
    expect(CONDITIONING_REQUIRED_SKILLS).not.toContain('AssessShockleyOnset')
    const missing = await missingOf(makeTipConditioningSelfCheck({}))
    expect(missing.every((n) => CONDITIONING_REQUIRED_SKILLS.includes(n))).toBe(true)
    expect(missing).not.toContain('AnalyzeFrameTilt') // 批 7a-1 落了
  })

  it('锻造自检数 `BiasWiggle` / `AssessShockleyOnset`，**不**数 `PreScanCheck` / `AnalyzeFrameTilt`', async () => {
    expect(FORGE_REQUIRED_SKILLS).toContain('BiasWiggle')
    expect(FORGE_REQUIRED_SKILLS).toContain('AssessShockleyOnset')
    expect(FORGE_REQUIRED_SKILLS).not.toContain('PreScanCheck')
    expect(FORGE_REQUIRED_SKILLS).not.toContain('AnalyzeFrameTilt')
    const missing = await missingOf(makeTipForgeSelfCheck({}))
    // 2026-09-20：`BiasWiggle` 从这一行里划掉了 —— **批 7a-3 当天落的**。
    // 这条测试问的是「这个自检数的是**哪一条链**」，而链的成员没变；
    // 变的是那条链上还差几件。所以判据换成**两条链的分界**本身：
    // 锻造那条要 `BiasWiggle`（现在它在 `IMPLEMENTED` 里，于是不再是缺口），
    // 而修针那条从来不问它。
    expect(FORGE_REQUIRED_SKILLS).toContain('BiasWiggle')
    expect(CONDITIONING_REQUIRED_SKILLS).not.toContain('BiasWiggle')
    expect(missing).not.toContain('BiasWiggle')
    expect(missing).toContain('AssessShockleyOnset')
  })

  it('`AutoTilt` 两条链都要 —— 台面上的调平在 `flat_poke_sites` 里，两条都走它', async () => {
    // 批 6a 之前锻造那张表漏了它：`TipForgeSelfCheck` 少报了一条缺口。
    expect(CONDITIONING_REQUIRED_SKILLS).toContain('AutoTilt')
    expect(FORGE_REQUIRED_SKILLS).toContain('AutoTilt')
    // 批 7a-1 落了它 ⇒ 两条链都不该再报它缺。
    expect(await missingOf(makeTipConditioningSelfCheck({}))).not.toContain('AutoTilt')
    expect(await missingOf(makeTipForgeSelfCheck({}))).not.toContain('AutoTilt')
  })
})

describe('批 7b-1：这套追法**追到哪儿为止** —— 缺这一组的闭包不算闭包', () => {
  const L = GOLDEN.closure_limits

  it('规模与追法本身录在金样里', () => {
    expect(L.scanned_root).toBe('mast/skills')
    expect(L.modules_scanned).toBe(211)
    expect(L.skills_indexed).toBe(515)
    expect(L.follow_rule).toContain('框架基类')
    expect(L.follow_rule).toContain('mast/skills/**` 之外的函数')
  })

  it('**没有**「被谁叫到、却找不到定义」的名字', () => {
    // 这一条是闭包的下边界。非空 = 某条链走到一个名字就停了，而停的理由是
    // 「我们找不到它」，不是「它没有下一层」。
    //
    // ⚠️ 它曾经非空过一次：`adatom_verify.py:31` 写的是 `_NAME = "VerifyAdatomAt"`，
    // 而第一版导出器的 `SkillMetadata(name=…)` 只认字面量 ⇒ 这个技能「有人叫、
    // 没人定义」。**一条假的边界比没有边界更坏** —— 它把「我们追不到」和
    // 「旧仓真的没有」写成了同一句话。
    expect(L.unknown_skills).toEqual([])
  })

  it('两条边都在追 —— 只追 `context.run` 只覆盖五分之一', () => {
    // 2026-09-20 实测旧仓 `mast/skills/**`：`CompositeStep(` **299 处** ·
    // `context.run(` **63 处**。少追 `CompositeStep` 那条边，漏掉的正是
    // `ScanAt` / `PreScanCheck` 压着的四个（`SetScanBuffer` / `WaitScanComplete` /
    // `SetZCtrlGain` / `SetScanSpeed`）—— 它们今天全是 done，所以那张一层的表
    // **今天的答案碰巧是对的**，而救它的是盘点，不是判据。
    expect(L.follow_rule).toContain('CompositeStep(skill_name=X')
    expect(L.follow_rule).toContain('context.run(X')
    // 这四个只能从 `CompositeStep` 那条边来 —— 它们在两个 composite 的行里。
    expect([...GOLDEN.skill_runs['ScanAt']!.runs]).toContain('SetZCtrlGain')
    expect([...GOLDEN.skill_runs['ScanAt']!.runs]).toContain('WaitScanComplete')
    expect([...GOLDEN.skill_runs['PreScanCheck']!.runs]).toContain('SetScanSpeed')
    expect([...GOLDEN.skill_runs['PreScanCheck']!.runs]).toContain('SetScanBuffer')
    // 而 `AutoTilt → TiltProbeCircle` 是另一条边（`context.run`）。两条都要。
    expect([...GOLDEN.skill_runs['AutoTilt']!.runs]).toEqual(['TiltProbeCircle'])
  })

  it('追不动的七处**逐条列出来**，连形状一起', () => {
    // 全量（不限于闭包之内）：这个数必须与起点无关，否则读的人分不清
    // 「闭包里没有」与「这套追法看不见」。
    expect(L.dynamic_run_sites.map((s) => `${s.shape}${s.in_engine ? '/engine' : ''} ${s.file}:${s.line} ${s.expr}`)).toEqual([
      // ① 循环变量：噪声普查按一张**技能名表**循环着跑。
      'loop_var builtins/characterise_noise.py:345 skill',
      'loop_var builtins/characterise_noise.py:762 skill',
      // ④ 编排引擎自己：`CompositeSkillGraph.step` 的动词是它的形参。
      // 追进去会给每个继承者各记一条同样的 `<dynamic>` —— 那不是七处，是五百处。
      'loop_var/engine composite/_base.py:75 skill_name',
      'loop_var composite/achieve_atomic.py:805 skill',
      // ④ 真正下发 `CompositeStep` 的那两行 —— 所有 299 条边最后都从这里出去。
      'Attribute/engine composite/graph_executor.py:598 step.skill_name',
      'Attribute/engine composite/graph_executor.py:601 step.skill_name',
      // ④ 声明式 composite：步骤表来自 YAML，静态读不到。
      "subscript/engine composite/interpreter.py:347 node['skill']",
    ])
    // 四型里的 ④ 单独标出来：它不是「我们照不到这个名字」，是「这里本来就没有
    // 一个固定的名字」。两件事混成一句「追不动」，那张清单就不能用了。
    expect(L.dynamic_run_sites.filter((s) => s.in_engine).length).toBe(4)
  })

  it('② f-string 拼出来的名字**解得开** —— 所以它不在追不动那张表里', () => {
    // 协调消息把 `bias.py:571/:593/:629` 列成「追不动·f-string」。实测：
    // 它们的前缀是模块级常量（`_PHASE_RAMP_STEP_PREFIX`），解得开，
    // 解出来是 `_phase_*` ⇒ 落进第三型（解得开、但不是注册技能）。
    // **报这个是为了那条纪律**：追不动的清单长一条短一条不要紧，
    // 要紧的是每一条都说得清自己为什么在上面。
    expect(L.dynamic_run_sites.filter((s) => s.shape === 'fstring')).toEqual([])
    expect([...(GOLDEN.skill_runs['SetBiasRamp']!.internal_phases ?? [])]).toEqual([
      '_phase_get_current', '_phase_set_step_{…}',
    ])
    // 而同一个文件里的 `SetBias` 一条都不该有 —— 按**模块**扫会把它算进来
    // （`bias.py` 里那三处 f-string 属于 `SetBiasRamp`:457，不属于 `SetBias`:97）。
    // 这台追法按**类体的可达范围**扫，同旧仓 `compliance.py:744 skill_footprint`。
    expect([...GOLDEN.skill_runs['SetBias']!.runs]).toEqual([])
    expect(GOLDEN.skill_runs['SetBias']!.internal_phases).toBeUndefined()
  })

  it('③ `_phase*` 解得开、**但不是技能** —— 所以不进闭包', () => {
    // 它们解得出名字（`_P_CLEAR = "_phase_clear"`），但 `ctx.run("_phase_*")` 被
    // 包装层短路，不过注册表（旧仓 `composite/assess_quality.py:15`）。
    //
    // ⚠️ **解得开 ≠ 是技能。** 把 `_phase_preflight` 当成子技能，闭包会多出三十来个
    // 永远落不了的名字 —— 那比少一个更坏：封锁账会**永远红**，
    // 而一张永远红的账和一张永远绿的账一样，不做任何决定。
    const phases = Object.keys(L.internal_phase_targets)
    expect(phases.length).toBe(31)
    expect(phases.every((p) => p.startsWith('_phase'))).toBe(true)
    expect(L.internal_phase_targets['_phase_preflight']).toEqual(['RelocateCoarseXY'])
    // 而这一族里没有任何一个名字混进了某个技能的 `runs`。
    const everyRun = new Set(Object.values(GOLDEN.skill_runs).flatMap((r) => [...r.runs]))
    expect([...everyRun].filter((n) => n.startsWith('_phase'))).toEqual([])
    // 反面：`RelocateCoarseXY` 的五个相位一个都没进它的 `runs`。
    expect([...GOLDEN.skill_runs['RelocateCoarseXY']!.runs]).toEqual([])
    expect([...(GOLDEN.skill_runs['RelocateCoarseXY']!.internal_phases ?? [])].length).toBe(5)
  })

  it('两台追法在六条流程上给出**同一张**子技能表', () => {
    // 专用那台（`ENTRIES` → `plan_dynamic` → `CompositeStep`）与通用那台
    // （技能类 → 方法 → 可达函数 → `CompositeStep`/`context.run`）各走各的。
    // 六条流程上逐字相同 —— 通用那台因此可以接管封锁账，而不是「另一个说法」。
    for (const flow of Object.keys(GOLDEN.skills)) {
      expect([...GOLDEN.skill_runs[flow]!.runs].sort(), flow).toEqual(
        Object.keys(GOLDEN.skills[flow]!.sub_skills).sort(),
      )
    }
  })
})

describe('批 6a 的封锁账 —— 红了说明可以重开这一批', () => {
  /** 每条流程**今天**还缺的子技能（**按闭包算**，批 7b-1 之前是一层）。空表 = 这条流程可以移了。 */
  const BLOCKED: Readonly<Record<string, readonly string[]>> = {
    // 2026-09-20 一天之内被划了三次，三次是**并行的三条支线**各自划的：
    //   批 7a-2 落 `FindCleanSpot`   —— 从六行里全部划掉
    //   批 7a-3 落 `FindFlatRegion`  —— 从五行划掉；`BiasWiggle` —— 从一行划掉
    //   批 7a-1 落 `AnalyzeFrameTilt` / `AutoTilt` —— 从各自那几行划掉
    // 合并这张表 = **三边删除的并集**，不是「都留」。
    // （2026-09-19 批 6c 第一次让它自己红，那次只有一条支线。）
    //
    // **两条流程因此空了 —— `PulseConditionTip` 与 `PokeConditionTip` 现在可以移。**
    // 另外四条各只差一件，而那一件恰好各不相同。
    PulseConditionTip: [],
    PokeConditionTip: [],
    MakeSpectroscopyTip: ['AssessShockleyOnset'],
    MakeAtomicResolutionTip: [],
    PrepareNobleTip: ['PreScanCheck'],
    ForgeAuTip: ['PreScanCheck'],
    //
    // ✅ 批 7b-1：这张表**改成按闭包算了**（上面 `closureBlocked`）。
    // 在它之前它只记一层：比的是 `GOLDEN.skills[flow].sub_skills` 减去已落的，
    // 而 `sub_skills` 里的每一个自己还可能有子技能。批 7a-1 实打实撞到过：
    // `AutoTilt` → `TiltProbeCircle`（`auto_tilt.py:134`），而那个名字**不在任何一行里**。
    // 于是「这六行全空」不等于「六条流程都能跑」，而这张表会说能跑。
    //
    // 现在那个「红」覆盖得到第二层（今天实测多覆盖 7 个名字，见上一组）。
    // **判据不变**：红了说明某条流程的最后一个封锁件落了，那一批可以重开。
    // ⚠️ 还是那句：划掉一行之前先自己追一遍 —— 只是「追」这件事现在是机器做的，
    // 而它追到哪儿为止写在 `closure_limits` 里，不写在谁的脑子里。
  }

  const installed = new Set(Object.keys(IMPLEMENTED))

  /** 一条流程的**闭包**里还没落的那些。与 `goldenClosure` 同一台机器。 */
  function closureBlocked(flow: string): string[] {
    return goldenClosure(Object.keys(GOLDEN.skills[flow]!.sub_skills))
      .filter((n) => !installed.has(n))
      .sort()
  }

  it.each(Object.keys(BLOCKED))('%s', (flow) => {
    expect(closureBlocked(flow)).toEqual([...BLOCKED[flow]!])
  })

  it('⚠️ 封锁件为空 ≠ 可以移 —— 缺的那些**不是技能**', () => {
    // ═════════════════════════════════════════════════════════════════════
    // 这一条是批 7b-1 的第二个发现，而它推翻了这一批任务书的一半。
    // ═════════════════════════════════════════════════════════════════════
    // `PulseConditionTip` / `PokeConditionTip` 的封锁件按**闭包**算是空的
    // （上面那六行），而两条今天都移不了 —— 它们缺的东西不是技能：
    //
    //   `core.map_scope.record_damage_marker`  地图的**写侧**。批 7a-2 把它
    //     写成了「一笔点名的欠账」：「第一个要写标记的技能落地时，它必须和那个
    //     技能同批，否则 `map_known=true` 而地图永远是空的」——
    //     而 `pulse_phase` 正是那第一个（每一发脉冲**打之前**就标记落点）。
    //   `core.noble_tip_workflow.{resolve, reconcile_with_tip_envelope}`
    //     那张 1273 行的流程表 + 与针尖包络的对账。
    //
    // 形状与 `blockers-7a.md` §7.1 第 4 行一模一样（`BiasWiggle` 缺的是
    // 「本仓要先长出一条中止清理通道」，不是一个 import）：
    // **一个只数技能的账，数不出非技能的债。**
    // 所以那一维现在也在账上 —— 不判「本仓有没有」（那要一张模块对照表），
    // 只保证它**有一行**，而不是只活在某份交接的散文里。
    const pulse = GOLDEN.skills['PulseConditionTip']!.non_skill_deps
    expect(Object.keys(pulse).sort()).toEqual([
      'mast.chat.narration',
      'mast.core.map_scope',
      'mast.core.noble_tip_workflow',
    ])
    expect(pulse['mast.core.map_scope']).toEqual(['record_damage_marker'])
    expect([...(pulse['mast.core.noble_tip_workflow'] as readonly string[])].sort()).toEqual([
      'reconcile_with_tip_envelope',
      'resolve',
    ])
    // 六条流程**每一条**都压着这两件 —— 也就是说这两件是整个 `_tip_phases`
    // 的公共前提，而封锁账此前一个字都没说过它们。
    for (const flow of Object.keys(GOLDEN.skills)) {
      const n = GOLDEN.skills[flow]!.non_skill_deps
      expect(n['mast.core.map_scope'], flow).toEqual(['record_damage_marker'])
      expect(Object.keys(n), flow).toContain('mast.core.noble_tip_workflow')
    }
    // 而 `PulseConditionTip` 是六条里非技能面**最小**的那一条（3 个模块，
    // 其余五条 12–14 个）—— 那正是「下一批从它开始」的理由，不是「它现在能移」。
    const sizes = Object.fromEntries(
      Object.keys(GOLDEN.skills).map((f) => [f, Object.keys(GOLDEN.skills[f]!.non_skill_deps).length]),
    )
    expect(sizes['PulseConditionTip']).toBe(3)
    expect(Math.min(...Object.values(sizes))).toBe(3)
  })

  it('两个 matplotlib 面板只压着五条 —— `PulseConditionTip` 躲开了它们', () => {
    // D 档（matplotlib 本仓架构上就不要）的那两个渲染器。它们出现在哪几条流程上，
    // 决定了那几条的**验收**长什么样：一条要画图的流程，移过来之后画不出图。
    const panels = ['mast.vision.poke_trace_panel', 'mast.vision.terrace_panel']
    const withPanels = Object.keys(GOLDEN.skills)
      .filter((f) => panels.every((p) => p in GOLDEN.skills[f]!.non_skill_deps))
      .sort()
    expect(withPanels).toEqual([
      'ForgeAuTip', 'MakeAtomicResolutionTip', 'MakeSpectroscopyTip', 'PokeConditionTip', 'PrepareNobleTip',
    ])
    expect(withPanels).not.toContain('PulseConditionTip')
  })

  it('封锁账**确实**在按闭包算 —— 把第二层挖空，它必须变', () => {
    // 这一条问的是「上面那六行是闭包算的，还是一层算的」。
    // 今天两种算法给出同一个答案（第二层的名字全都已落），于是上面六行
    // **两种写法都能过** —— 那正是这种判据最容易悄悄退回去的时刻。
    //
    // 做法：假装 `TiltProbeCircle` 没落（它是 `AutoTilt` 的第二层，353 行）。
    // 按闭包算 ⇒ 五条流程各多一件；按一层算 ⇒ 一条都不变。
    const asIf = new Set(installed)
    asIf.delete('TiltProbeCircle')
    for (const flow of ['PokeConditionTip', 'PrepareNobleTip', 'ForgeAuTip', 'MakeSpectroscopyTip']) {
      const oneLayer = Object.keys(GOLDEN.skills[flow]!.sub_skills).filter((n) => !asIf.has(n))
      const closed = goldenClosure(Object.keys(GOLDEN.skills[flow]!.sub_skills)).filter((n) => !asIf.has(n))
      expect(oneLayer, flow).not.toContain('TiltProbeCircle')
      expect(closed, flow).toContain('TiltProbeCircle')
    }
    // 而 `PulseConditionTip` 那条链上本来就没有 `AutoTilt` —— 它的闭包等于它的一层。
    expect(goldenClosure(Object.keys(GOLDEN.skills['PulseConditionTip']!.sub_skills))).toEqual(
      Object.keys(GOLDEN.skills['PulseConditionTip']!.sub_skills).sort(),
    )
  })

  it('六条**全部**经过 `FindCleanSpot`，而且它每一处都是 `optional=True`', () => {
    for (const flow of Object.keys(BLOCKED)) {
      const dep = GOLDEN.skills[flow]!.sub_skills['FindCleanSpot']
      expect(dep, flow).toBeDefined()
      // 「可选」在这里不是「可以不要」：它失败时流程接着跑，然后报
      // 「这片表面已经没有可用的落点了」—— 一句关于样品的假话。
      //
      // ⚠️ 批 7a-2 把它落了，所以这条**不再是**一句「卡着」的账。
      // 留着的是那半条判据：`optional=True` 这件事没有变，而现在它更要紧了 ——
      // 一个**会返回结果**的技能，它的失败路径才真的会被走到。
      expect(dep!.required_somewhere, flow).toBe(false)
      expect(dep!.sites.every((s) => s.optional), flow).toBe(true)
    }
    expect(installed.has('FindCleanSpot')).toBe(true)
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
