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
| `PreScanCheck` | 1446 | `safe_mode_active`（内核接口）· `VERIFIED_STATE_KEY` · `scan_policy` · `trace_retrace_correlation`（**75 行，但新写的只有约 30** —— 见 §3.1） | **见 §3** | 2 条 |
| `AssessShockleyOnset` | 309（与下者同文件） | `sample_facts` · `special_tip_workflow` · `tip_intent` · `SUPPRESS_SKILL_PATTERNS` · `_SKILL_KIND_RULES` | 见 §4 | 1 条 |
| `AssessAtomicPhase` | 同上 | 同上 | 见 §4 | 1 条 |
| **`BiasWiggle`** | 405 | **一件内核侧的**：`SafeCall` 的**中止清理通道**（见 §4.1）—— 判据件确实零 | 见 §4.1 | 1 条 |

`BiasWiggle` 那一行值得单说：它的函数体里**一个 `mast.*` 的 import 都没有**
（只有收尾的 `wrap_skill`），**判据件确实零**，而它挡着 `MakeAtomicResolutionTip`。
这件在批 6a 的账上和另外七件并排列着，看不出它这么便宜 ——
**一张「谁在等谁」的账，答不出「等的那个有多贵」。**

⚠️ **订正（同日，`builtins` 盘点报的）**：初稿这里写「一件都不缺」，**不对**。
它缺一件**不是 import 的东西**，见 §4.1。
我的量法是「函数体里有没有 `mast.*` import」—— 那只照得到 Python 侧的依赖，
**照不到「本仓这边要有一个什么样的口」**。
> **一个只看上游的依赖量法，量不出下游要先长出什么。**

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
| `trace_retrace_correlation` | `vision/tip_metrics.py` **75 行**，本仓源码零命中 —— **但新写的只有约 30 行**。它是 `_fwd_bwd_instability` 的**一维姊妹**，二维支**整个转发**给那一份（本仓已落 `fwdBwdInstability`），共用同一条 `_detrend` 与同一个 `max_shift_frac`。见下 §3.1 |

### 3.1 `trace_retrace_correlation`：一件被自己的行数吓住的活

2026-09-20 追出来的（`paper` 那份盘点先报的，我复核过）：那 75 行里，
**二维支只有一句转发**，判据本体是已经在仓里的 `fwdBwdInstability`。
旧仓的注释自己说明了理由：

> 同一个概念不写第三份实现：一维用 `np.correlate`，二维转发给 `_fwd_bwd_instability`，
> 两条共用 `_detrend` 与 `max_shift_frac`。

⇒ **真正要写的是一维那一支，约 30 行。** 「75 行零命中」这个说法本身没错，
错在它读起来像「要从头造 75 行」—— **零命中说的是名字，不是工作量。**

⚠️ 顺带捞到一条值得单独讲的物理（旧仓 docstring 里写着，实测数据都在）：
在这个函数存在之前，`PreScanCheck` 与 `CheckLineQuality` 都在**绝对高度**上算余弦相似度。
带一个正常的 Z 工作点偏置（~1 nm）时，那个数被**直流项统治** ——
于是它回答的不是「这两条线走出同一条形貌吗」，而是「这两条线的均值差不多吗」。
阈值 0.80 下的实测：

```
两条完全独立的噪声线   → 0.9999  通过
完全反相（最坏的针尖） → 0.9609  通过
死平废帧               → 1.0000  通过（六帧真数据里的最高分）
```

**那道阈值是装饰性的：验证相在它最该失败的方向上不可能失败。**
减掉均值之后同一批是 0.013 / −1.0。移的时候这一条必须有金样钉住，
否则本仓会把同一道装饰性的闸原样搬过来。

⇒ **`PreScanCheck` 不进 7a。** 它只解锁 2 条流程，而那 2 条（`PrepareNobleTip` /
`ForgeAuTip`）同时还等着 `FindCleanSpot` + `AutoTilt` + `FindFlatRegion` + `AnalyzeFrameTilt`。
**先把那四件落了，它才是那两条流程的最后一件** —— 那时再动它，收益才兑现得了。

## 4. 两个自检技能（`AssessShockleyOnset` / `AssessAtomicPhase`）

⚠️ **订正（同日）**：初稿说它们住在 `tip_forge_selfcheck.py`。**不对，在
`builtins/tip_spectro_assess.py`**（`class AssessShockleyOnset` 在 `:100`）。
我用 `grep -rln '"AssessShockleyOnset"'` 取了**首个命中**，而那是一处引用不是定义。
**今天同一个错犯了两次**（另一次是 `TiltProbeCircle`，见 §7.1 第 1 行）——
`grep -rln` 给的是「哪些文件提到过这个名字」，不是「谁定义了它」。

`AssessAtomicPhase` 比初稿估的便宜**一个数量级**：上一轮把它列在
「晶格判据底座 ≈950 行」下面，而那 950 行**已经落了** ——
`atomic-phase.ts`(632) · `lattice-peaks.ts`(470) · `lattice-cell.ts`(851) ·
`frame-texture.ts`(538) · `seg-texture.ts`(354) · `tip-metrics.ts`(464)，
且 `AtomicPhaseResult` 的字段与 `tip_spectro_assess.py:419-435` 消费的**逐个对上**。
⇒ 它只欠**技能壳 135 行** + `resolve_substrate` 注入口。

而 `resolve_substrate`（`sample_facts.py` 175 行 → `knowledge/` 30570 行）
**不是缺口，是本仓已有的注入口范式**：`analysis-clusters.ts:612 substrateTolerance`
已经这么处理过一次（默认关，抬头逐字写明理由）。三个消费方的降级都是**诚实拒绝** ——
`AssessAtomicPhase` 只是不做那一项比对，旧仓注释明写「不算失败」。

`AssessShockleyOnset` 还欠一件真的：**`curveFit` 的 box bounds（trf）** ——
本仓 `curve-fit.ts` 全走无约束 LM。那是一次**算法替换**，不是给 LM 打补丁。

⚠️ 批 5a 记过「三个自检技能里两个是 fail-open」，移之前核这两个在不在那个名单上。

### 4.1 `BiasWiggle` 缺的那件：`SafeCall` 的**中止清理通道**

`bias_wiggle.py:25` / `:116` 的纪律：超过 `abort_current_a` **立即恢复初始偏压并中止**，
「**abort 也不例外**」。⇒ 中止之后它还要再发一次 `Bias_Set`。
而本仓中止之后不许再发命令 —— 那正是课时 3.16 那道「反着开的闸」管的地方。

处方（照 `builtins` 盘点，已核）：在 `skill-kernel.ts` 照 `emergencyCall`(`:206-212`) /
`slowCall`(`:213-222`) 加**第三个命名入口**。两处注释都明写反对可选参数：
「这条路谁在走、走了几次，要能一眼 grep 出来」。
**不要把 `Bias_Set` 塞进 `ABORT_SAFE_WRITES`** —— 那张表按**「停」的语义**建
（`gated-call.ts:14-16`），而 `Bias_Set` 没有哪个参数形能表达「停」。

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

## 7. 封锁账自己记浅了一层（2026-09-20，composite 盘点报的，已复核）

`packages/host/stm-skills/src/l0/tip-phase-deps.test.ts:142-158` 的 `BLOCKED` 表
**记的是一层，不是闭包**。实测：

```
AutoTilt（表里有，算「一件封锁件」）
  └─ auto_tilt.py:134  context.run("TiltProbeCircle", …)
       └─ TiltProbeCircle   builtins/tilt_probe.py  353 行   **progress.json 里是 todo**
            └─ vision/tilt.py  fit_circle_tilt 99 行 + CIRCLE_MIN_POINTS
```

**`TiltProbeCircle` 这个名字不在 `BLOCKED` 表的任何一行里。** 也就是说：
把 `AutoTilt` 落了，那五条流程**仍然解不开**，而封锁账会说解开了。

⚠️ 这条比它看起来严重，因为**这张表的全部价值就是「它会自己失效」**：
课时 6.1 讲的正是「一本会自己失效的账」，课时 6.3 讲的是它在合并批 6c 当天
**当场红了**一次。它确实会为「某个封锁件落了」而失效 ——
**而它不会为「某个封锁件自己还有封锁件」而失效，因为那一层它根本没记。**

> 一个会自己失效的判据，只在它**记全了的那一维**上会自己失效。
> 它在没记的那一维上和一张手抄清单没有区别 —— 而它看起来比手抄清单可信。

### 7.1 同一天撞了三次 —— 所以这不是「那张表漏了一条」

| # | 谁 | 少记的那一层 | 谁发现的 |
|---|---|---|---|
| 1 | `AutoTilt`（`BLOCKED` 表里的一件） | → `TiltProbeCircle` 353 行（todo，不在表里）→ `fit_circle_tilt` 99 + `CircleTilt` 一族 ≈130 | composite 盘点，我复核 |
| 2 | `estimate_tilt`（我给 7a-1 的清单里的一件） | → `assess_steps` 36 + `_rotate_slope` 13 → `_segmentation_step_signal` → `seg_scale_adaptive` 251 | 7a-1 自己追出来的 |
| 3 | `kde_layers`（我给 7a-3 的清单里的一件） | → `_hist_modes` 32 | 我，写协调消息时 |
| 4 | `BiasWiggle`（我判的「零依赖」） | → 它要的不是 import，是**本仓要先长出**一条中止清理通道 | `builtins` 盘点 |

三处的共同点：**列清单的人（包括我）都只追了一层就停了**，
而三份清单都是在「要按函数级追、不按文件名」这条纪律下写的。

> **纪律说的是「按什么单位追」，没说「追多深」。** 两件事都要写下来才算数 ——
> 按函数级追一层，得到的仍然是一份会漏的清单，只是漏法换了一种。

⇒ 从这一轮起，凡是「缺件清单」都要附一句**追到哪儿为止**：
「追到全部已落、或已在本清单里」才算闭包，写不出这句话的清单按未完成算。

**怎么改**（合并 7a 之后做，现在动会和三条支线撞）：
`BLOCKED` 的值从「名字数组」改成由**闭包**算出来 —— 对每个封锁件再查一次它自己的
`context.run(...)` 目标，递归到全部已落为止。判据不变（红了说明可以重开），
但那个「红」现在覆盖得到第二层。

## 8. 另外两条要带进 7b 的（composite 盘点报的，已复核）

### 8.1 `ScanPublicationFrame` 默认参数下**永远拒跑** —— 而本仓已经把正确的键移对了

```
生产方 atomic_lattice.py:203-206   → data = { "passed_forward": …, "passed_backward": … }
消费方 publication_frame.py:211    → v.get("passed")          ← 这个键从来不存在
```

`atomic_lattice.py` 全文件裸 `"passed"` **零命中**（核过）。于是
`bool(v.get("passed"))` 恒为 `False`，`if not v.get("passed") or …` 恒真 ⇒ **恒拒**。

本仓 `packages/host/stm-skills/src/l0/analysis-lattice.ts:558-575` 逐字照移了生产方那一侧，
键名是对的。⇒ **移 `ScanPublicationFrame` 时照抄 `v.get("passed")` 会把这个 bug 搬过来**，
按 DoD ⑤ 不照抄，并在登记里写清「为什么不照抄」与「改它需要什么证据」。

### 8.2 三个 STS 技能的采集路径**旧仓出厂就不可达**

`sts_workflow.py:251` 的 `CONDITIONS` 只有一个组、四个样品事实全 `None` ⇒ `usable` 恒 `False`。
⇒ **验收标准是「拒绝得对不对」，不是「采到了几条谱」。**
造金样时别去造一格「采成功」的 —— 那一格在旧仓里造不出来，造出来的只会是本仓自己发明的行为。
