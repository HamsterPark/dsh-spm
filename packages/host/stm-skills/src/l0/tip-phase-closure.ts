/**
 * 批 7b-1：针尖流程依赖的**闭包**（原来是一层）。
 *
 * ## 为什么这一层要单独存在
 *
 * 批 6a 起，两张自检依赖表与封锁账都是「流程 ∪ 它 `yield` 出去的 `CompositeStep`」——
 * **一层**。而一个子技能自己还会再叫技能：
 *
 * ```
 * AutoTilt（在表里，算「一件」）
 *   └─ auto_tilt.py:134  context.run("TiltProbeCircle", …)
 *        └─ TiltProbeCircle   builtins/tilt_probe.py   353 行
 * ```
 *
 * `TiltProbeCircle` 这个名字**不在任何一行里**。于是：把 `AutoTilt` 落了，
 * 五条流程仍然解不开，而封锁账会说解开了；`TipConditioningSelfCheck` 会说
 * 「技能齐全」，而它数的那条链上还缺一个 353 行的技能。
 *
 * > 一个会自己失效的判据，只在它**记全了的那一维**上会自己失效。
 * > 在没记的那一维上它和一张手抄清单没有区别 —— 而它看起来比手抄清单可信。
 *
 * 2026-09-20 同一天在四个地方各撞了一次（`blockers-7a.md` §7.1），所以这不是
 * 「那张表漏了一条」，是**量法**漏了一维：纪律说的是「按函数级追」，
 * 没说「追多深」。
 *
 * ## 追到哪儿为止（这一节是判据的一部分，不是说明）
 *
 * {@link SUB_SKILL_RUNS} 对两条链的闭包里的**每一个**名字都有一行 ——
 * 叶子写空表，不是不写。空表 = 「查过了，它不叫别人」；
 * 缺行 = 「没查」，由 {@link skillClosure} 的 `stoppedAt` 报出来。
 * **一个说不清自己追到哪儿的闭包，比一层还坏。**
 *
 * 这张表由 `tools/spec-export/export_tip_phase_deps.py` 的 `skill_runs` 那一节
 * 逐行对账（`tip-phase-deps.test.ts`）—— 旧仓多一条 `context.run`，那条测试当场红。
 */

/** {@link skillClosure} 的结果：闭包本身，以及**它在哪儿停下来**。 */
export interface SkillClosure {
  /** 闭包（含种子），已排序去重。 */
  readonly names: readonly string[]
  /**
   * 走到了、而边表里**没有这一行**的名字。
   *
   * 不是「没有子技能」（那写成空表），是「这张表不知道它叫不叫别人」。
   * 非空 = 这个闭包是个下界，调用方必须知道这件事。
   *
   * ⚠️ **空表有两种，而它们在 JSON 里长得一模一样**：没有东西，和这段代码
   * 从不往里放东西。所以测试里有一条**挖一个洞**的（删掉 `TiltProbeCircle`
   * 那一行，断言它出现在 `stoppedAt` 里）—— 没有那一条，这个字段恒为空表
   * 也能全绿，而那时它报的就不是「追全了」，是「我不会报」。
   */
  readonly stoppedAt: readonly string[]
}

/**
 * 一层边表 → 闭包。**递归防环**：走过的名字不再展开。
 *
 * ## 为什么**没有**深度上限（与旧仓刻意不同）
 *
 * 旧仓同形状的那一份（`mast/skills/compliance.py:751`）写的是
 * `if name in _seen or len(_seen) > 8: return SkillFootprint(UNKNOWN, …)` ——
 * 超过八层就降 `UNKNOWN`。它那么写有它的道理（那台是**运行时**跑的，
 * 要对付声明式 spec 与动态注册）。
 *
 * 这一份不抄那个上限：**这一批修的就是「追一层就停」，抄一个「追八层就停」过来，
 * 只是把同一个 bug 的阈值调大。** 这里的图是静态的、有限的（515 个技能，
 * 金样 `skill_runs`），完整不动点一定收敛；环由 `seen` 挡，挡掉了什么由
 * 金样的 `closure_limits.cycles` 说出来（今天是空表，有测试盯着）。
 *
 * ⚠️ 这是一处**刻意**的不一致，所以理由写在这里 ——
 * 一处刻意的不一致，没写下理由就等于一处疏忽。
 *
 * @param seeds 起点（通常是几条流程本身）。
 * @param runs  `技能名 → 它自己还会发出去的技能名`。缺行的进 `stoppedAt`。
 */
export function skillClosure(
  seeds: readonly string[],
  runs: Readonly<Record<string, readonly string[]>>,
): SkillClosure {
  const seen = new Set<string>()
  const stopped = new Set<string>()
  const stack = [...seeds]
  while (stack.length > 0) {
    const name = stack.pop() as string
    // 防环就在这一句：走过就不再展开。旧仓今天零环（金样 `closure_limits.cycles`
    // 记着这件事），但「今天没有」不是「不会有」。
    if (seen.has(name)) continue
    seen.add(name)
    const next = runs[name]
    if (next === undefined) {
      stopped.add(name)
      continue
    }
    for (const m of next) stack.push(m)
  }
  return { names: [...seen].sort(), stoppedAt: [...stopped].sort() }
}

/** 三条贵金属流程 —— `TipConditioningSelfCheck` 背书的那一条链的种子。 */
export const NOBLE_FLOWS: readonly string[] = ['PrepareNobleTip', 'PokeConditionTip', 'PulseConditionTip']

/**
 * 两条特异化流程 —— `TipForgeSelfCheck` 背书的那一条链的种子。
 *
 * ⚠️ **`PokeConditionTip` 不在这里，而且闭包也不会把它拉进来。**
 * 两条特异化流程要的是 `poke_phase` 那个**生成器**（`make_special_tip.py:292/855`
 * 写的是 `yield from poke_phase(...)`），不是那个技能 —— 一条**代码**依赖。
 * 这件事现在由边表自己保证：`MakeSpectroscopyTip` / `MakeAtomicResolutionTip`
 * 的行里没有它，而它们的行是从旧仓的 `CompositeStep` 算出来的。
 */
export const SPECIAL_FLOWS: readonly string[] = ['MakeSpectroscopyTip', 'MakeAtomicResolutionTip']

/**
 * 「这个技能自己还会发出去谁」—— 两条链闭包内的**每一个**名字各一行。
 *
 * 对着 `spec/golden/tip_phase_deps.json` 的 `skill_runs`（旧仓静态算的）。
 * 边只有两种形状：`context.run("X", …)` 与 `CompositeStep(skill_name="X", …)`。
 *
 * 真正有下一层的只有四个 —— 其余 34 个都是叶子。**那 34 行空表是判据，不是噪声**：
 * 它们说的是「查过了」。
 */
export const SUB_SKILL_RUNS: Readonly<Record<string, readonly string[]>> = {
  // ── 五条流程本身 ──
  MakeAtomicResolutionTip: [
    'AssessAtomicLines', 'AssessAtomicPhase', 'AssessClusterRoundness', 'AutoTilt', 'BiasWiggle',
    'CaptureSignalBuffer', 'ConfigureScan', 'FindCleanSpot', 'FindFlatRegion', 'GetBias',
    'GetLatestScanFile', 'MoveToXY', 'SaveScan', 'ScanAt', 'SetBias', 'SetSetpoint', 'StartScan',
    'StopScan', 'TipShapeWithReadback', 'ZControllerOnOff',
  ],
  MakeSpectroscopyTip: [
    'AcquireSTS', 'AssessClusterRoundness', 'AssessShockleyOnset', 'AutoTilt', 'CaptureSignalBuffer',
    'ConfigureLockIn', 'ConfigureSTS', 'FindCleanSpot', 'FindFlatRegion', 'GetBias',
    'GetLatestScanFile', 'MoveToXY', 'SaveScan', 'ScanAt', 'SetBias', 'SetSetpoint',
    'TipShapeWithReadback', 'ZControllerOnOff',
  ],
  PokeConditionTip: [
    'AssessClusterRoundness', 'AutoTilt', 'CaptureSignalBuffer', 'FindCleanSpot', 'FindFlatRegion',
    'GetBias', 'GetLatestScanFile', 'MoveToXY', 'SaveScan', 'ScanAt', 'SetBias',
    'TipShapeWithReadback', 'ZControllerOnOff',
  ],
  PrepareNobleTip: [
    'AnalyzeFrameTilt', 'AssessClusterRoundness', 'AssessTipSharpness', 'AutoTilt',
    'BiasPulseWithReadback', 'CaptureSignalBuffer', 'FindCleanSpot', 'FindFlatRegion', 'GetBias',
    'GetLatestScanFile', 'MoveToXY', 'PreScanCheck', 'SaveScan', 'ScanAt', 'SetBias', 'SetSetpoint',
    'TipShapeWithReadback', 'ZControllerOnOff',
  ],
  PulseConditionTip: [
    'BiasPulseWithReadback', 'FindCleanSpot', 'MoveToXY', 'SetBias', 'SetSetpoint', 'ZControllerOnOff',
  ],

  // ── 第二层：这四个自己还叫别人。整批 7b-1 就是为这四行而做的 ──
  //
  // `AutoTilt` 是那一撞的现场（批 7a-1 落它的时候才发现 `TiltProbeCircle` 不在账上）。
  // 另三个是 composite：一层的表把它们当成叶子，而它们各自还压着五到七个。
  AutoTilt: ['TiltProbeCircle'],
  PreScanCheck: [
    'ConfigureScan', 'GetLatestScanFile', 'SaveScan', 'SetScanBuffer', 'SetScanSpeed', 'StartScan',
    'WaitScanComplete',
  ],
  ScanAt: [
    'ConfigureScan', 'SetBias', 'SetScanBuffer', 'SetSetpoint', 'SetZCtrlGain', 'StartScan',
    'WaitScanComplete',
  ],
  TiltProbeCircle: [],

  // ── 叶子（查过了，它们不叫别人） ──
  AcquireSTS: [],
  AnalyzeFrameTilt: [],
  AssessAtomicLines: [],
  AssessAtomicPhase: [],
  AssessClusterRoundness: [],
  AssessShockleyOnset: [],
  AssessTipSharpness: [],
  BiasPulseWithReadback: [],
  BiasWiggle: [],
  CaptureSignalBuffer: [],
  ConfigureLockIn: [],
  ConfigureSTS: [],
  ConfigureScan: [],
  FindCleanSpot: [],
  FindFlatRegion: [],
  GetBias: [],
  GetLatestScanFile: [],
  MoveToXY: [],
  SaveScan: [],
  SetBias: [],
  SetScanBuffer: [],
  SetScanSpeed: [],
  SetSetpoint: [],
  SetZCtrlGain: [],
  StartScan: [],
  StopScan: [],
  TipShapeWithReadback: [],
  WaitScanComplete: [],
  ZControllerOnOff: [],
}
