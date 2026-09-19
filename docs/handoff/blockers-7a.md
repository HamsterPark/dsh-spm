# 第七轮 7a —— 八件封锁件的**函数级**依赖，逐件追出来的

> 这份不是盘点的替代品，是**关键路径的独立测量**。
> 三份分族盘点（`builtins` / `composite` / `paper`）另行给出；这一份只回答一个问题：
> **那六条针尖流程到底被什么挡着，解开要多少行。**

## 0. 为什么要重追一遍

封锁账 `packages/host/stm-skills/src/l0/tip-phase-deps.test.ts` 今天的 `BLOCKED` 并集是
**八件**，而且**一件都还没落**。它们卡着六条特异化流程（`PulseConditionTip` ·
`PokeConditionTip` · `MakeSpectroscopyTip` · `MakeAtomicResolutionTip` ·
`PrepareNobleTip` · `ForgeAuTip`）。

批 6a 的交接给 `FindCleanSpot` 标的成本是「压着实验地图 ≈ **3147 行**，八件里唯一一件真正大的」。
**那是四个文件整份加起来的数，不是依赖。** 按函数级追一遍，闭包 **1069 行**，
而其中 `io/coarse_map.py` 那 604 行**一处都没碰** —— 它进那个数只因为文件名里有 `map`。

> 3147 行是「先别想」，1069 行是「这一轮就能做」。
> **两个判断之间只隔着一次 grep，而这一轮的排期完全取决于它。**

所以八件全部重追，方法统一：看 `execute` / `validate_params` **函数体里**的 `import`
（旧仓这一族普遍把真依赖写在函数体内、顶层只留 `BaseSkill` 与 `types`），
再逐个函数量行数，最后与本仓已落的对账。

## 1. 八件的账

| 封锁件 | 技能行数 | **还缺的判据件** | 缺多少行 | 解锁流程 |
|---|---|---|---|---|
| **`FindCleanSpot`** | 352 | 地图层 5 件（见 §2） | **717** | **6 条** |
| `AutoTilt` | 654 | `circle_tilt_resolution_deg` 16 · `z_span_for_frame` 36 | **52** | 5 条 |
| `FindFlatRegion` | 827 | `kde_layers`（`seg_scale_adaptive`） | **≈45** | 5 条 |
| `AnalyzeFrameTilt` | 225 | `detrend_quadratic` 42 · `estimate_tilt` 158 · `step_dominance_multiscale` 27 · `structure_dominance` 28 | **255** | 2 条 |
| `PreScanCheck` | 1446 | `safe_mode_active`（内核接口）· `VERIFIED_STATE_KEY` · `scan_policy` · `trace_retrace_correlation` 74 | **见 §3** | 2 条 |
| `AssessShockleyOnset` | 309（与下者同文件） | `sample_facts` · `special_tip_workflow` · `tip_intent` · `SUPPRESS_SKILL_PATTERNS` · `_SKILL_KIND_RULES` | 见 §4 | 1 条 |
| `AssessAtomicPhase` | 同上 | 同上 | 见 §4 | 1 条 |
| **`BiasWiggle`** | 405 | **一件都不缺** | **0** | 1 条 |

`BiasWiggle` 那一行值得单说：它的函数体里**一个 `mast.*` 的 import 都没有**
（只有收尾的 `wrap_skill`）。**405 行纯 A 档**，而它挡着 `MakeAtomicResolutionTip`。
这件在批 6a 的账上和另外七件并排列着，看不出它零依赖 ——
**一张「谁在等谁」的账，答不出「等的那个有多贵」。**

## 2. `FindCleanSpot` 的闭包（1069 行）

`execute` 函数体里只 import 五个东西：

```
clean_spot.py  技能本体                                     352
map_scope      analysis_config 143 · crash_memory_markers 58 · load_markers 23   224
map_analysis   AnalysisConfig 103 · nearest_clean_from 250 ·
               build_avoid_circles 29 · _ring_cells 18                           400
exp_map        MapMarker 79 · epoch_of_row 8 · markers_from_rows 6                93
                                                                          ────────
                                                                     函数级闭包 1069
```

`exp_map` 那三件是 `map_analysis.py` **顶层** import 进来的，所以躲不掉；
但要的只是这三个名字，不是那 1015 行。

另两件本仓已有：`readback._decode_nanonis`、`_tip_xy.read_tip_xy`。

**`io/coarse_map.py`（604 行）：闭包里零命中。** `clean_spot.py` / `map_analysis.py` /
`map_scope.py` 三份文件里 `grep coarse_map` 一处都没有。

## 3. `PreScanCheck` 是这八件里唯一真正压着子系统的

它的函数体依赖里有四件本仓零命中：

| 缺件 | 性质 |
|---|---|
| `safe_mode_active` | **一个内核接口决定** —— 技能唯一拿得到的口是 `SkillContext`。去重后解锁 4 个技能（批 6b 写的「5 个」把 `CheckLineQuality` 数了两遍） |
| `VERIFIED_STATE_KEY` | `core/state.py` 的一个状态键 |
| `scan_policy`（顶层 import 了一组） | 一个配置族 |
| `trace_retrace_correlation` | `vision/tip_metrics.py` **74 行**，本仓源码零命中（只在从旧仓导出的金样 JSON 里出现过） |

⇒ **`PreScanCheck` 不进 7a。** 它只解锁 2 条流程，而那 2 条（`PrepareNobleTip` /
`ForgeAuTip`）同时还等着 `FindCleanSpot` + `AutoTilt` + `FindFlatRegion` + `AnalyzeFrameTilt`。
**先把那四件落了，它才是那两条流程的最后一件** —— 那时再动它，收益才兑现得了。

## 4. 两个 `tip_forge_selfcheck` 自检技能

`AssessShockleyOnset` 与 `AssessAtomicPhase` 住在同一个 309 行的文件里，
依赖也几乎相同。它们各只解锁 1 条流程，而依赖面（`sample_facts` /
`special_tip_workflow` / `tip_intent` / `monitoring` / `exp_map._SKILL_KIND_RULES`）
横跨五个子系统 —— **每件都不大，但没有一件是已经在的**。

⚠️ 这个文件叫 `tip_forge_selfcheck.py`，而批 5a 已经记过一条：
**三个自检技能里两个是 fail-open**。移之前先核这两个在不在那个名单上。

## 5. 分批建议

按「一批能不能自己收口」和「解锁多少」切：

| 批 | 内容 | 缺件行数 | 落技能 | 解锁 |
|---|---|---|---|---|
| **7a-1** | `vision/tilt` 一族 6 件 + `AnalyzeFrameTilt` + `AutoTilt` | 307 | 2 | — |
| **7a-2** | 地图层 5 件 + `FindCleanSpot` | 717 | 1 | **六条流程的公共前提** |
| **7a-3** | `kde_layers` + `FindFlatRegion` + `BiasWiggle` | ≈45 | 2 | — |

三批**互不碰同一个文件**：7a-1 在 `vision/`，7a-2 新建地图层，7a-3 在
`vision/seg-*` 与 `stm-skills/`。可以并行。

三批合完之后，六条流程里 **`PulseConditionTip`（只差 `FindCleanSpot`）·
`PokeConditionTip` · `MakeSpectroscopyTip`（另差 `AssessShockleyOnset`）·
`MakeAtomicResolutionTip`（另差 `AssessAtomicPhase`）** 的封锁件各自剩几件，
由封锁账**自己算**出来 —— 那张表红了就说明可以重开，不用手数。

## 6. 这份账自己的失效条件

它是 2026-09-20 对着 `spec/progress.json` 与旧仓当天的状态量的。**不要在它上面打勾。**
重算的办法：`BLOCKED` 并集减去 `progress.json` 里 `status === 'done'` 的，
再对每件重跑一次函数体 `import` 的追踪。
**一份要靠人记得划掉的清单，比没有清单更坏** —— 上一轮为这句话付过三次学费。
