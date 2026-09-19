# 批 7b-1 —— 封锁账按闭包算 · `AssessAtomicPhase` · 两条流程的真实状况

> 三件事做完两件，第三件**做出了一个更有用的结果**：
> 那两条「已经解封锁」的流程，封锁件按闭包算确实是空的，**而两条都还移不了** ——
> 缺的东西不是技能。这一条现在在账上，不在这份交接的散文里。

---

## 0. 一句话

**闭包化修好了「技能 → 技能」那一维；同一天量出来，那一维不是唯一的一维。**

---

## 1. 落了什么

| | |
|---|---|
| **技能** | **1 个**（`AssessAtomicPhase`，`builtins.tip_spectro_assess`）。模块收口 **0 个**（同文件的 `AssessShockleyOnset` 不落，理由见 §6） |
| **判据层** | `packages/host/stm-skills/src/l0/tip-phase-closure.ts`（新）—— `skillClosure` + 38 行边表 |
| **技能层** | `packages/host/stm-skills/src/l0/tip-spectro-assess.ts`（新） |
| **改了的判据** | `tip-selfcheck.ts` 的两张依赖表**从一层改成闭包**（+7 / +4 个名字） |
| **导出器** | `export_tip_phase_deps.py`（扩两节 + 一节）· `export_batch7b1.py`（新）· `export_skill_traces.py`（`BATCH_7B_1`）|
| **金样** | `tip_phase_deps.json` +`skill_runs`/`closure_limits`/`non_skill_deps` · `batch7b1.json`（新，3284 KB）· `skill_traces.json` +1 格 |
| **测试** | `tip-phase-deps.test.ts` 21 → **33** 条 · `batch7b1-skills.test.ts`（新，**47** 条）· `integration/tip-spectro-assess.test.ts`（新，**3** 条，真 stmsim）|
| **全仓** | 115 文件 / **7004** 条全绿（批前 7004−47−12 = 6945）|
| **变异** | **20 条，20/20 实跑到 red**（日志 `docs/handoff/batch-7b-1-mutations.log`，已 `git add -f`）|
| **偏差** | **6 条**（编号留 `?`）|

---

## 2. ① 封锁账按闭包算（这一批的主产品）

### 2.1 边有**两条**，不是一条

任务书写的是「追 `context.run(...)` 到不动点」。实测旧仓 `mast/skills/**`：

```
CompositeStep(   299 处
context.run(      63 处
```

**只追后者只覆盖五分之一的边。** 漏掉的那五分之四正是 `ScanAt` / `PreScanCheck`
压着的 `SetScanBuffer` / `WaitScanComplete` / `SetZCtrlGain` / `SetScanSpeed` ——
而这四个今天全是 `done`，所以那张一层的表**今天的答案碰巧是对的**。
**救它的是盘点，不是判据。**

实测的第二层：

| 链 | 一层 | 闭包 | 多出来的 |
|---|---|---|---|
| 贵金属（`PrepareNobleTip` / `PokeConditionTip` / `PulseConditionTip`） | 21 | **28** | `ConfigureScan` · `SetScanBuffer` · `SetScanSpeed` · `SetZCtrlGain` · `StartScan` · **`TiltProbeCircle`** · `WaitScanComplete` |
| 特异化（`MakeSpectroscopyTip` / `MakeAtomicResolutionTip`） | 26 | **30** | `SetScanBuffer` · `SetZCtrlGain` · `TiltProbeCircle` · `WaitScanComplete` |

只有四个技能真的有下一层：`AutoTilt`（`context.run`）· `ScanAt` · `PreScanCheck`
（两条 `CompositeStep`）· `TiltProbeCircle`（叶子，但它是那一撞的现场）。

### 2.2 追到哪儿为止（`closure_limits`，这一节是判据的一部分）

| | 数 | 内容 |
|---|---|---|
| `scanned_root` / `modules_scanned` / `skills_indexed` | — / 211 / **515** | 扫整棵 `mast/skills/**` |
| `follow_rule` | — | 类体 + **同模块**基类 → 从那里可达的、本树内的模块级函数与同模块类。框架基类不追；`mast/skills/**` 之外不追 |
| `unknown_skills` | **0** | 被叫到而找不到定义的名字 |
| `dynamic_run_sites` | **7** | 追不动的现场，逐条带 `file:line` · `shape` · `in_engine` |
| `internal_phase_targets` | **31** | `_phase*` —— 解得开、**但不是技能** |
| `cycles` | **0** | 环（`seen` 挡得住，挡了什么要说出来）|

追不动的 7 处按形状分两型（协调消息给的四型里，第二型实测**不成立**，见 §7）：

```
loop_var            builtins/characterise_noise.py:345  skill
loop_var            builtins/characterise_noise.py:762  skill
loop_var  [engine]  composite/_base.py:75               skill_name
loop_var            composite/achieve_atomic.py:805     skill
Attribute [engine]  composite/graph_executor.py:598     step.skill_name
Attribute [engine]  composite/graph_executor.py:601     step.skill_name
subscript [engine]  composite/interpreter.py:347        node['skill']
```

`in_engine` 那四处单独标出来：它们不是「我们照不到这个名字」，
是「这里本来就没有一个固定的名字」。**两件事混成一句「追不动」，那张清单就不能用了。**

### 2.3 三条测试比别的都值钱

1. **「挖一个洞」**（`缺行会被报成 stoppedAt，不会被当成叶子静静吞掉`）——
   删掉边表里 `TiltProbeCircle` 那一行，断言它出现在 `stoppedAt` 里。
   > **空表有两种：没有东西，和这段代码从不往里放东西 —— 而它们在 JSON 里长得一模一样。**
   没有这一条，`stoppedAt` 恒为空表也能全绿，那时它报的不是「追全了」，是「我不会报」。
2. **「闭包比一层多七个 / 四个」** —— 上面两条断言用的是同一个金样，
   `goldenClosure` 哪天退回成 `unionOf`，它们**照样全绿**（两边一起变，
   比出来的永远是「代码等于它自己」）。所以差额本身要单独钉住。
3. **「两台追法在六条流程上给出同一张子技能表」** —— 专用那台
   （`ENTRIES` → `plan_dynamic` → `CompositeStep`）与通用那台（技能类 → 方法 →
   可达函数 → 两条边）各走各的，六条上逐字相同。通用那台因此可以**接管**封锁账，
   而不是「另一个说法」。

### 2.4 顺手改了 `tip-selfcheck.ts` 的两张表（在范围内）

`CONDITIONING_REQUIRED_SKILLS` / `FORGE_REQUIRED_SKILLS` 也是一层。
原来那条测试的名字里写着「闭包」而算的是一层 ——
> **留着等于主动钉住这个 bug。**

改成闭包之后两张表各多 7 / 4 个名字。今天那几个都已落 ⇒
**`missing_skills` 一个字都没变**；变的是这两张表**下次**会不会漏报。
判据类改动该有的样子就是这个：**今天没改变任何答案，改变的是明天哪些答案会被质疑。**

### 2.5 一条差点写下去的假边界

第一版导出器的 `SkillMetadata(name=…)` 只认字面量，于是
`adatom_verify.py:31 _NAME = "VerifyAdatomAt"` 让这个技能「有人叫、没人定义」，
`unknown_skills` 里挂了一条。

> **一条假的边界比没有边界更坏：它把「我们追不到」和「旧仓真的没有」写成同一句话。**

解模块级字符串常量之后 `unknown_skills` 是空表。
同一个改动还捞回一条**真边**：`line_sts_across_wall.py:55
POINT_ENGINE_SKILL = "SpectroscopyAtPositions"`。

---

## 3. ② `AssessAtomicPhase`

判据本体**零行**（晶格底座那 ≈950 行上一轮落完，`AtomicPhaseResult` 的字段与
`tip_spectro_assess.py:419-435` 逐个对上）。落的是技能壳 + 覆盖率门 + 衬底注入口。

金样 `batch7b1.json`：**26 格技能 · 10 格 `resolve_substrate` · 12 个 `.sxm`**。

三处**不照抄**，各有测试盯着差异本身：`D-EXTRA-SPLIT`（§4.1）· `D-SUBSTRATE`
（注入口默认关 + 只认四个洁净金属面 + 无模糊匹配）· `D-EMPTYPATH`。
两处**照移**了看起来像笔误的行为：通道回落、不做几何归位（`D-ATOMICPHASE-CHANNEL`）。

**五条失败路径，一条一句话**（任务书估的是四条 —— 第五条是实跑撞出来的：
截断的文件走到「通道在、方向块不在」，而那一支本来以为不可达）。

**集成测试不是「跑一遍合成字节」**：让模拟器**真的扫一帧、真的存盘**
（`ScanAt` → `SaveScan` → `GetLatestScanFile`），再把那条路径喂进来。
50 nm / 32 px ⇒ `nm_per_px` **恰好 1.5625**、`scale === 'off'`、`reasons` 含
`scale_gate`、summary 含「这不等于「没有原子相」」。
第一版写的是 `expect(nmpp === null || …)` —— 那种写法在 `null` 那一侧什么都不问，
「头解不开」与「解开了而且对」长得一样（green-8 §2.4 那个形状）。改成算死的数。

---

## 4. 偏差（6 条，编号留 `?`）

| 登记 | 一句话 |
|---|---|
| `D-EXTRA-SPLIT-?` | 旧仓把 `extra_reasons`/`extra_warnings` 拆散在两个类里：`AssessShockleyOnset` **用而未赋值**（每条成功路径 `NameError`），`AssessAtomicPhase` **赋值而未用**（算好的两句话扔了）。本仓接回来 |
| `D-SUBSTRATE-?` | 注入口默认关 · 只认**四个**洁净金属面 · 无模糊匹配。第 3 条是**量出来的**：金样把七个面都问了一遍 |
| `D-ROWSPACING-?` | 行间距**不与** `firstOrderPeriodNm` 统一 —— 旧仓两处结合顺序不同，Pt(111) 差 1 ulp |
| `D-EMPTYPATH-?` | 空 `scan_path` 走「读取失败」而不是「文件不存在」（`Path("") == Path(".")`）|
| `D-ATOMICPHASE-CHANNEL-?` | 指名通道拿不到时**回落到第一个通道**，与孪生技能刻意不同；也不做几何归位 |
| `D-CLOSURE-DEPTH-?` | 闭包**不抄** `compliance.py:751` 那个「超过八层就 UNKNOWN」的上限 |

### 4.1 `D-EXTRA-SPLIT` 那一格长什么样（金样里钉着）

```
case  coverage_below_gate_but_judged        覆盖率 0.4375
  data.passed                       false      ← 门压住了
  data.passed_before_coverage_gate  true       ← 判据本身说「有原子相」
  data.incomplete_frame             true
  data.reasons                      []         ← `incomplete_frame` 算了，没进去
  data.warnings                     []         ← 那句长话一个字都没出来
  summary       "有原子相：快扫方向周期 0.250 nm，角向集中度 3321（阈值 20）。"
```

**同一个回包里，模型读的那一句和机器读的那一格互相矛盾。**
本仓三处都接回来，summary 用的是旧仓 `:406-410` 自己写好的那句话
（「只有 44% 的像素有数据 —— 这一帧**判不了**原子分辨。……**不要把这个结果读成
「针尖不好」**，它说的是这一帧没扫完。」）—— **一个字都没有新造。**

### 4.2 `D-CLOSURE-DEPTH` 为什么不抄

`compliance.py:751` 是 `if name in _seen or len(_seen) > 8: return UNKNOWN(…)`。
它那么写有它的道理（运行时跑、要对付声明式 spec 与动态注册）。
**这一批修的就是「追一层就停」，抄一个「追八层就停」过来只是把同一个 bug 的阈值调大。**
这里的图是静态有限的，完整不动点一定收敛；环由 `seen` 挡，挡掉了什么由
`closure_limits.cycles` 说出来。

> 一处刻意的不一致，没写下理由就等于一处疏忽。

---

## 5. 变异：20 条，20/20 红

日志：`docs/handoff/batch-7b-1-mutations.log`（`.gitignore` 有 `*.log`，
已有 `!docs/handoff/*.log` 的反例外；`git add -f` 之后 `git ls-files` 验过）。

基线 0（`run.ts` 的第四判据先量了一趟）。跑之前的顺序：
`gen:skills` → `tsc -b` → `gen:progress`。

| 组 | 条 | 全红 |
|---|---|---|
| ① 闭包（`tip-phase-closure.ts`） | 5 | ✅ |
| ② `AssessAtomicPhase`（`tip-spectro-assess.ts`） | 15 | ✅ |

### 5.1 三条**第一次跑不成**，三种不同的原因

| id | 第一次 | 为什么 | 怎么改的 |
|---|---|---|---|
| `atomicphase-incomplete-reason-is-dropped` | `inconclusive` | 整段删掉 `extraReasons` ⇒ 它成了未使用的局部量，`tsc -b` 不过。**一条编译不过的变异问不出「这道闸在不在挡」** | 改成 `extraReasons.slice(1)`（恒为空、而变量仍被读到）|
| `atomicphase-row-spacing-*`（两条） | `inconclusive` | 同上，`ROW_SPACING_FACTOR` 悬空 | `Math.max(1, ROW_SPACING_FACTOR)`（恒为 1）/ `ROW_SPACING_FACTOR * 2`（**精确**等于 √3）|
| `atomicphase-expected-zero-is-a-value` | **green** | `> 0` 改 `>= 0` ⇒ 0 传下去之后 `atomic-phase.ts` 的 `expectedANm && expectedANm > 0` **又挡了一次** ⇒ 两种写法同解。**那一行不是一道闸，是下游那道闸的复读** | 按 green-8 §2.8：先证明它不做决定，再把变异改打在真正做决定的那一行（`else if (rawExpected === null)`），**并补一格金样**（`expected_zero_with_substrate`）—— 没有衬底时「填 0」与「留空」给出同一个答案，那道分界一格输入都没有 |

最后那条是 green-8 §2.1 的原样重演：**闸只有一侧有输入**。
补的那一格同时给 `expected_a_nm: 0` **和**一个解得开的衬底，两种候选才各占一边。

---

## 6. ③ 两条流程：**闭包是空的，而两条都还移不了**

### 6.1 先按 ① 的闭包追了一遍（任务书要求的那一步）

```
PulseConditionTip   闭包 6 个子技能    还没落的：[]      ← 一层与闭包同解
PokeConditionTip    闭包 20 个子技能   还没落的：[]      ← 一层 13，闭包多 7
```

两条**在技能那一维上确实是空的**。

### 6.2 而它们缺的东西**不是技能**

导出器新加的 `non_skill_deps`（闭包里每个函数体内的 `mast.*` import
**加上**顶层 import 里这个闭包真的调到的那些）：

```
PulseConditionTip   3 个模块
  mast.chat.narration            narrate
  mast.core.map_scope            record_damage_marker
  mast.core.noble_tip_workflow   reconcile_with_tip_envelope, resolve

PokeConditionTip   12 个模块（另加 9 个，其中两个是 matplotlib 面板）
  … mast.vision.poke_trace_panel / mast.vision.terrace_panel   （D 档）
  … mast.core.scan_policy / mast.core.tip_state / mast.io.nanonis_files / …
```

`mast.core.map_scope.record_damage_marker` 正是**批 7a-2 点名的那笔欠账**
（`kernel/src/map-scope.ts:27`）：

> 本批没搬的理由是**本仓还没有任何一个消费方**……它是一笔**点名的欠账**，
> 不是一次遗漏：第一个要写标记的技能落地时，它必须和那个技能同批，
> 否则 `map_known=true` 而地图永远是空的。

**`pulse_phase` 正是那第一个** —— 它在每一发脉冲**打之前**就标记落点
（旧仓注释：「记在打之前而不是打之后：脉冲若失败，表面照样被弄脏了」）。
2026-08-16 真机的复现账就在那个函数的 docstring 里：第二轮把第一轮的坑
**原路倒着打了一遍**，因为标记了但没人读。

`mast.core.noble_tip_workflow.{resolve, reconcile_with_tip_envelope}` 是那张
**1273 行**的流程表 + 与针尖包络的对账 —— `tip-selfcheck.ts:59` 早就写着
「`core/noble_tip_workflow.py`(1273) 与 `core/special_tip_workflow.py`(410) 整体
**不在这一批**」。

### 6.3 所以这一维现在也在账上

形状与 `blockers-7a.md` §7.1 第 4 行一模一样（`BiasWiggle` 缺的是「本仓要先长出
一条中止清理通道」，不是一个 import）：

> **一个只数技能的账，数不出非技能的债。**

`non_skill_deps` **不判「本仓有没有」**（那要一张模块对照表，是另一件事），
它只保证那一维**有一行** —— 而不是只活在某份交接的散文里。
两条测试盯着它：六条流程**每一条**都压着 `record_damage_marker` 与
`noble_tip_workflow`；两个 matplotlib 面板只压着五条，`PulseConditionTip` 躲开了。

### 6.4 下一批该怎么排

`PulseConditionTip` 的非技能面是六条里**最小**的（3 个模块，其余 12–14）。
建议下一批就是它，而**必须同批**带上：

1. `core.map_scope.record_damage_marker`（写侧，含 `DAMAGE_KINDS` 的避让半径）；
2. `core.noble_tip_workflow` 的 `resolve` + `reconcile_with_tip_envelope`
   （不是整份 1273 行 —— 按函数级追一遍再定）；
3. `chat.narration.narrate`（可能是 D 档，要先判）。

⚠️ 还有一个**没答的问题**：这六条流程一格轨迹金样都录不到
（`export_tip_phase_deps.py` 抬头：要一台真仪器跑几十分钟到几小时）。
`plan_dynamic` 是生成器，**可以**用一台假 executor 驱动、把
`CompositeStep` 序列录成金样 —— 那是一台**新的**驱动器，六条流程共用。
这件事该在落第一条流程之前定下来，而不是落的时候现想。

---

## 7. **与任务书不一样的地方**（单列）

| # | 任务书 | 实际 | 为什么 |
|---|---|---|---|
| 1 | 「追 `context.run(...)` 到不动点」 | **追两条边**（`context.run` + `CompositeStep`）| `CompositeStep` 299 处 vs `context.run` 63 处 —— 只追后者覆盖五分之一。协调中途也发了同样的订正，两边独立撞到同一件事 |
| 2 | 协调消息把 f-string 列成「追不动·第二型」（`bias.py:571/:593/:629`）| **解得开**，落进第三型（`_phase*`，不是技能）| 前缀是模块级常量。不解常量的话 `POINT_ENGINE_SKILL = "SpectroscopyAtPositions"` 会被记成「追不动」—— **而那是一条真边**。`dynamic_run_sites` 里 `shape === 'fstring'` 的是 **0** 条 |
| 3 | 协调消息的第四型只列了 `graph_executor.py:598/:601` | 还有 `_base.py:75` 与 `interpreter.py:347`，**共 4 处** `in_engine` | 只匹配裸 `context`/`ctx` 会漏掉 `self._context.run(...)` —— 而那两行正是全部 299 条 `CompositeStep` 最后落地的地方 |
| 4 | 「环与深度按 `skill_footprint` 的办法降 UNKNOWN」 | 环照做（`cycles` + `seen`），**深度上限不抄** | 见 `D-CLOSURE-DEPTH-?`。抄一个「追八层就停」只是把同一个 bug 的阈值调大 |
| 5 | ①只说改 `tip-phase-deps.test.ts` 的 `BLOCKED` | **还改了 `tip-selfcheck.ts` 的两张表** | 同一个一层 bug 的第二处，而且是**生产**的（`missing_skills` 进模型）。原测试名字里写着「闭包」而算的是一层，留着等于主动钉住 bug |
| 6 | ③「落两条已解封锁的流程」 | **一条都没落**，改成把「为什么落不了」做成账（`non_skill_deps`）| 两条的技能闭包确实是空的，而缺的不是技能。硬落进去的那个东西会在第一发脉冲之前写一条**没人收**的损伤标记，然后第二轮把第一轮的坑原路打一遍 —— 那正是 2026-08-16 真机的原样 |
| 7 | 「`resolve_substrate` 照 `substrateTolerance` 的范式」 | 照了，**但认得的面只有四个不是七个** | 拿本仓 `SURFACE_LATTICE_NM`（vision 的七个面）当衬底知识库，会让三个面凭空「知道」。这是把七个面都问一遍**量出来**的，不是读代码读出来的 |
| 8 | DoD ③「每个错误分支一条单测」按四条估 | **五条** | 截断的文件走到「通道里没有正扫/反扫数据」—— 那一支本来判成不可达 |

---

## 8. 这份账自己的失效条件

- `closure_limits` 的四个数（211 / 515 / 7 / 31）是 2026-09-20 对着旧仓当天量的。
  旧仓变了它们就变，而**那正是它们存在的理由** —— 别在上面打勾，重跑导出器。
- `non_skill_deps` 只回答「旧仓那些函数要什么」，**不回答「本仓有没有」**。
  要后者得有一张「旧仓模块 → 本仓文件」的对照表，那是一件单独的事。
  在那之前，看这张表的人要自己去 `grep` 一次 —— 而这句话必须写下来，
  否则下一个人会把「在账上」读成「已经核过了」。
- 三处「照移旧仓缺陷不照抄」的差异，测试断言的是**差异本身**：
  旧仓哪天修了，那几条会红，登记必须跟着删。
