# 批 6a 交接 —— 六个特异化流程**一个都没落**，而这份账就是这一批的产品

**结论先写**：`_tip_phases.py` 的六个流程（`PrepareNobleTip` · `PokeConditionTip` ·
`PulseConditionTip` · `MakeAtomicResolutionTip` · `MakeSpectroscopyTip` · `ForgeAuTip`）
**每一条都还卡着**，按分派单第 2 条要害「判据接不上就不落这个技能」，这一批**零技能落地**。

盘点说它们卡在 `AssessClusterRoundness`（批 4a 已落）。**逐条核下来不是这样** ——
那个技能确实在这几条流程里，但它从来不是**绑定约束**。真正卡住的是
`FindCleanSpot`（六条流程全部，第一个动作）与 `FindFlatRegion`（六条里五条），
它们各压着一个这一轮不在范围内的子系统。详见 §1。

> **这一批做了两趟。** 第一趟（§0–§9）：核出六条全部还卡着 ⇒ 零技能落地，账做实。
> 第二趟（**§10**，主线看完第一趟之后决定的）：把 §3.2 那半道**接不上的**深度包络
> **接上了** —— 这是唯一一处改了运行时行为的地方，也是本仓**比旧仓严**的一条。

| | |
|---|---|
| 技能 | 411 → **411 / 515**（模块 88 → **88 / 165**）—— **没变** |
| 测试 | `--project '!integration'` 101 文件 / 5761 条 → **102 文件 / 5780 条**全绿（新增 19 条） |
| 集成 | **15 文件 / 86 条**对真 stmsim 全绿（没新增，跑了一遍确认没碰坏） |
| 新金样 | `spec/golden/tip_phase_deps.json`（**第六台专用驱动器，唯一一台静态的**） |
| 变异 | **新增 6 条（2 + 4），全部实跑到 red；两趟基线都干净**（见 §4） |
| 偏差 | 新登记 **2 条**（编号留空，主线统一编），其中 D-TIPDEPTH **第二趟改写**为「本仓接上了，旧仓没有」 |

落地的四样，前三样服务于一件事：**让「这一批还卡着」这句话由判据算出来，而不是由人抄下来**。

1. `tools/spec-export/export_tip_phase_deps.py` —— 从六个 `plan_dynamic` 求
   `CompositeStep(skill_name=…)` 的传递闭包，出 `spec/golden/tip_phase_deps.json`；
2. `packages/host/stm-skills/src/l0/tip-phase-deps.test.ts`（19 条）—— 拿那份金样
   比两张依赖表、比封锁账、比「每一发脉冲 / 每一次扎入过没过那道闸」；
3. `l0/tip-selfcheck.ts` 的 `FORGE_REQUIRED_SKILLS` 修正（**少报四个、多报一个**，见 §2）；
4. **`l0/tip-policy.ts` 的 `tipDepthRefusals()`** —— 扎针深度终于过得了那半道包络（§10）。

---

## 0. 我核出来与盘点不一样的地方

### 0.1 ⚠️ 盘点点名的那道闸**不是**绑定约束，而它已经落了

盘点原话：

> `poke_phase` 每次扎针后要 `AssessClusterRoundness` 判成没成。判据缺席时它只会扎满
> `max_rounds` 然后报 not_refined ——**一个只会消耗针尖、永远不会成功的流程。**

两处要改：

**① 那个技能已经在了**（批 4a，`l0/analysis-clusters.ts`），而六条流程照样动不了。
金样里逐条钉着它在 `_cluster_look`（`_tip_phases.py:1907`）——盘点没说错它的位置，
说错的是「解开它这一批就能动」。

**② 「扎满 `max_rounds` 报 not_refined」这个失败形状也不对，而真的那个更坏。**
`poke_phase` 在扎第一针**之前**要先拿到一批已知平坦的落点
（`flat_poke_sites`，`_tip_phases.py:1993`），而那个函数的第一步是
`_relocate` → `FindCleanSpot`。`FindCleanSpot` 不在 ⇒ 那一步（`optional=True`）失败
⇒ `_relocate` 返回 `None` ⇒ `flat_poke_sites` 返回 `("spent", None)` ⇒
`poke_phase` 当场 break，报：

> 没有干净的地方可以继续扎了 —— 该换区或换样品位置。

**一针都没扎，而报出去的是一句关于样品的假话。** 不是「耗针尖」，是
「零动作 + 一个会让调用方去粗动换区的错误结论」。同形的还有 `pulse_phase`：

> 这片表面已经没有可用的落点了 —— 该粗动换区（RelocateCoarseXY），或者换一块样品区域。

—— 零发脉冲，`surface_spent: true`。

> **这一条值得单记**：缺席的步骤**几乎全是 `optional=True`**（金样的
> `required_somewhere` 列逐条钉着）。缺一个**必需**步骤，执行器当场中止，报的是
> 那一步自己的精确错误；缺一个**可选**步骤，流程**接着跑**，拿一个空结果往下判 ——
> 而判出来的那句话，措辞上与「真的测过了」一模一样。
> **所以「能不能落」不能只看必需步骤。**

### 0.2 `_tip_phases.py` 的「1664 代码行」成立，但换个定义是 1324

三种数法我都跑了（`tokenize` + `ast`，脚本在 §5）：

| 定义 | 行数 |
|---|---|
| 物理行 | **2801** ✅ 与盘点一致 |
| 非空行 | 2519 |
| 非空且**不是纯注释行**（= 盘点的 1664） | **1664** ✅ 成立 |
| 再去掉 docstring（**真正的可执行代码**） | **1324** |

差的那 340 行是 docstring。这个文件里 docstring 不是文档是**判据的出处**
（「2026-08-17 现场反馈」「93 针既有 Z 读数又有簇图」那些），移的时候一行都不能丢，
所以按 1664 估工作量是对的。写在这里只是为了下次看到两个数不用再查一遍。

### 0.3 `TipForgeSelfCheck` **少报了一条自己的缺口**

见 §2。批 5a 那两张依赖表是手抄的；这一批给它装了驱动器，核出来贵金属那张
**一个不差**，锻造那张少四个（其中 `AutoTilt` 是 todo）、多一个。

### 0.4 `FindFlatRegion` / `AutoTilt` 比盘点说的**近得多**（§1.2）

盘点把这两个都算成「压着 vision 一整块」。逐个 import 核下来，下层几乎都已经在了：
`AutoTilt` 今天只差 **23 行纯算术**（盘点说的那四个 `instrument_profile` 入口，
**批 5c 已经落了**）；`FindFlatRegion` 只差 `kde_layers`(15) + `_hist_modes`(32) + 一个
二维中值滤波。两件都归批 6b。

**这一条的普遍形状**：盘点是在**那一轮**的树上做的，而每一批都在往下垫底座。
「差什么」这句话的有效期只到下一次合并为止 —— 同 green-8 §3.4 那条
（「一次演练的有效期只到下一次重构为止」），只是这次过期的是**分派表**。

### 0.5 ⚠️ **深度包络接不上** —— 每一次扎入都过不了那半道闸

分派单第 3 条要害问的是「六个流程发出去的每一发脉冲 / 每一次扎入，都经过那道闸吗」。
**脉冲过，扎入不过。** 逐条见 §3。

---

## 1. 六条流程各卡在哪 —— 逐条，带函数与行数

金样 `spec/golden/tip_phase_deps.json` 的 `sub_skills` 就是这张表的来源；
`tip-phase-deps.test.ts` 的「批 6a 的封锁账」那一组把它钉住了，
**红了说明最后一个封锁件落了，这一批可以重开**。

| 流程 | 入口 | 闭包规模 | 还缺（`*` = 该步 `optional=True`，缺席时流程**接着跑**） |
|---|---|---|---|
| `PulseConditionTip` | `prepare_noble_tip.py:221`（10 行） | 15 函数 / 511 行 | **`FindCleanSpot`\*** —— 就这一个 |
| `PokeConditionTip` | `prepare_noble_tip.py:278`（15 行） | 36 函数 / 1896 行 | `FindCleanSpot`\* · `FindFlatRegion`\* · `AutoTilt`\* |
| `MakeSpectroscopyTip` | `make_special_tip.py:252`（190 行） | 35 函数 / 2064 行 | 上面三个 + `AssessShockleyOnset`\* |
| `MakeAtomicResolutionTip` | `make_special_tip.py:573`（336 行） | 36 函数 / 2216 行 | 上面三个 + `AssessAtomicPhase`\* · `BiasWiggle`\* |
| `PrepareNobleTip` | `prepare_noble_tip.py:342`（103 行） | 42 函数 / 2772 行 | 上面三个 + `AnalyzeFrameTilt`\* · `AssessTipSharpness`\* · **`PreScanCheck`**（必需） |
| `ForgeAuTip` | `forge_au_tip.py:529`（198 行） | 46 函数 / 3362 行 | 与 `PrepareNobleTip` 同六个 |

### 1.1 九个封锁件，各压着什么（旧仓行数，`code` = 去掉注释与 docstring）

| 缺的技能 | 文件 | 行（总 / code） | 它压着的 |
|---|---|---|---|
| **`FindCleanSpot`** | `builtins/clean_spot.py` | 352 / 233 | **整套实验地图**：`core/map_scope`(322) + `io/map_analysis`(1206) + `io/exp_map`(1015) + `io/coarse_map`(604)。`execute` 顶上就 `from mast.core.map_scope import …` / `from mast.io.map_analysis import nearest_clean_from`，**无 try/except** |
| **`FindFlatRegion`** | `builtins/flat_region.py` | 827 / 528 | ⚠️ **比盘点说的近得多，见 §1.2** —— 下层只差 `kde_layers`(15) + `_hist_modes`(32) + 一个二维中值滤波 |
| **`AutoTilt`** | `composite/auto_tilt.py` | 654 / 471 | ⚠️ **也比盘点说的近，见 §1.2** —— 只差 `vision/tilt` 的两个纯算术函数（14 + 9 = **23 行**） |
| **`PreScanCheck`** | `composite/prescan_check.py` | 1446 / 601 | `vision/frame_validity`(275) + `tip_metrics` 三函数(144) + `tip_crash_tracker`（**已落，批 4d**） |
| **`AnalyzeFrameTilt`** | `builtins/frame_tilt.py` | 225 / 166 | `vision/seg_scale_adaptive:segment_scale_adaptive`（skimage disk/otsu/tophat，210+40 行） |
| **`AssessTipSharpness`** | `builtins/tip_sharpness.py` | 260 / 155 | `vision` 的锐度切片（与 `FindFlatRegion` / `ExtractClusters` 共用下层） |
| **`AssessAtomicPhase`** | `builtins/tip_spectro_assess.py:263` | （同文件 461 / 354） | **晶格判据底座**（`atomic_phase` 判据环 508 + K1 236 + `seg_scale_adaptive` 切片 ≈ 950 行纯 numpy） |
| **`AssessShockleyOnset`** | `builtins/tip_spectro_assess.py:100` | 同上 | `vision/spectroscopy`(954) 的 `assess_shockley_onset`(274) + `broadening_floor_v` / `_logistic_step` / `_bic`；另需 `curveFit` 的 box bounds（trf） |
| **`BiasWiggle`** | `builtins/bias_wiggle.py` | 405 / 291 | **什么都不压** —— 只 import `random` + `time`（盘点这一条核过，成立）。它差的是 `gated-call.ts` 的 `allowOnAbort` 逃生口（`Bias_Set` 不在 `ABORT_SAFE_WRITES` 里） |

**杠杆最大的一件是 `FindCleanSpot`**：它一个人挡着全部六条，而且它压的那套实验地图
（≈3147 行）是九件里**唯一一件真正大的**。`PulseConditionTip` 只差它。

### 1.2 ⚠️ 顺手核出来的：`FindFlatRegion` 与 `AutoTilt` 比盘点说的**近得多**

盘点把这两个都算成「压着 vision 一整块」。逐个 import 核下来，下层**几乎都已经在了**：

| `FindFlatRegion` 要的 | 本仓 |
|---|---|
| `io/nanonis_files.read_sxm` / `sxm_oriented_frames` | ✅ `nanonis-files/src/sxm.ts` |
| `vision/tilt.plane_subtract` / `noise_floor` | ✅ `vision/src/plane.ts` |
| `vision/frame_validity.judge_frame` | ✅ `vision/src/frame-validity.ts` |
| `io/mosaic.parse_xy_meta` / `px_to_m` | ✅ `vision/src/xy-meta.ts` |
| `scipy.signal.find_peaks`（带 prominence） | ✅ `numerics/src/peaks.ts` |
| `vision/seg_scale_adaptive.kde_layers` | ❌ **15 行** |
| └ `_hist_modes` | ❌ **32 行** |
| └ `scipy.ndimage.median_filter(size=5)` 二维 | ❌ **没有**（要对边界模式 `reflect`） |

| `AutoTilt` 要的 | 本仓 |
|---|---|
| `core.instrument_profile.get_tilt_calibration` 一族 | ✅ **批 5c 落了**（`kernel/src/instrument-profile.ts`，三态齐） |
| `vision/tilt.circle_tilt_resolution_deg` | ❌ **14 行**（纯算术：σ_z·√(2/n)/r） |
| `vision/tilt.z_span_for_frame` | ❌ **9 行**（纯算术） |

⚠️ 盘点那句「`AutoTilt` 差 `instrument_profile` 的 4 个入口」**今天不成立了** ——
批 5c 把读侧落了（写侧 `set_tilt_calibration` 是 `TiltCalibrate` 的事，不是 `AutoTilt` 的）。
`AutoTilt` 今天只差 **23 行纯算术**，加上它自己那 471 行 code。

**两件都在 `packages/host/vision/` 上，而那正是批 6b 的地盘 ——
按分派单这一轮一个字节都没碰。** 写在这里是给 6b 的：这三小件（15 + 32 + 中值滤波 + 23）
一落，`PokeConditionTip` 就只剩 `FindCleanSpot` 一件了。

### 1.3 那两个 workflow 档案（`noble_tip_workflow` / `special_tip_workflow`）

批 5a 只从它们里取了五个数（跟着唯一的消费方 = 两个自检走）。这一批**也没有取更多** ——
它们的消费方就是这六条流程，而六条都没落。行数核过：

| 文件 | 总 / 非空 / code |
|---|---|
| `core/noble_tip_workflow.py` | 1273 / 1194 / **324** |
| `core/special_tip_workflow.py` | 410 / 352 / **205** |

⚠️ **`noble_tip_workflow` 的 code 只有 324 行** —— 它是一个参数档案（dataclass + 默认值 +
大段出处注释），不是判据。批 5a 记的「1273 行」是物理行。真要移的时候按 324 行估。

`reconcile_with_tip_envelope`（`noble_tip_workflow.py:1144` 那张表）仍然没移，
批 5a 记的「`TipPulse.execute` 里那一道判是它的下位替代」仍然成立。

---

## 2. `FORGE_REQUIRED_SKILLS` 修正（这一批唯一动了行为的一处）

驱动器算出来的闭包 vs 批 5a 手抄的那张表：

| | 结果 |
|---|---|
| `CONDITIONING_REQUIRED_SKILLS` | **一个不差**（三条贵金属流程 ∪ 18 个子技能 = 21） |
| `FORGE_REQUIRED_SKILLS` | **少四个、多一个** |

**少的四个**：

* **`AutoTilt`** —— 台面上的调平（`flat_poke_sites` → `_level_on_terrace`，
  `_tip_phases.py:2284`）。两条特异化流程都走 `flat_poke_sites`。
  **它是 todo ⇒ `TipForgeSelfCheck` 此前少报了一条缺口**；
* `GetBias` · `CaptureSignalBuffer` —— 在 `poke_phase` / `_poke_step` 里，
  与贵金属那张表**同因**（批 5a 给 `CONDITIONING_*` 写的那两行理由逐字适用）；
* `AssessAtomicLines` —— `make_special_tip.py:697`，扰动循环里的线级判据。

**多的一个：`PokeConditionTip`（移除）。** 两条特异化流程要的是 `poke_phase` 那个
**生成器**（`make_special_tip.py:292` / `855` 写的是 `yield from poke_phase(...)`），
不是那个技能。`_tip_phases.py` 的模块抬头点名说了为什么：

> **为什么是生成器而不是嵌套 composite**：composite 调 composite 在本仓没有先例，
> 断点续跑（`CompositeProgress` + step_id）与 abort 的交互没人验证过。

一条**代码**依赖写进一张**技能覆盖**表，说的是假话 —— 而缺口数看起来仍然是对的
（这正是难查的那一型）。移除它不丢信息：那个技能仍由 `CONDITIONING_REQUIRED_SKILLS` 报着。

净效果：`TipForgeSelfCheck` 报的缺口**数**今天不变（8 个），**内容**变了
（`PokeConditionTip` 出、`AutoTilt` 进）。`skill_traces.json` 一格没动 ——
批 5a 那条「`missing_skills` **从 `IMPLEMENTED` 算**、不抄一份」的做法在这里还了本。

---

## 3. 要害 ③ 的答案：脉冲过，**扎入不过**

> **2026-09-19 第二趟：扎入这一半接上了。** §3.2 记的是**第一趟核出来的状态**，
> 原样留着（它是这条闸为什么存在的全部理由）。**接线、四条刻意、以及为什么它进不了
> `tip_policy.json`，全部写在新加的 §10。**

### 3.1 每一发脉冲都过闸 ✅

六条流程里**脉冲只有一个出口**：`_tip_phases.py:839` 的 `BiasPulseWithReadback`
（金样钉着：三条会打脉冲的流程 = `PulseConditionTip` / `PrepareNobleTip` / `ForgeAuTip`，
而**没有任何一条**绕开它去直调 `BiasPulse` 或 `TipPulse`）。本仓那个技能的
`validateParams` 把 `bias_v` 映到方案表的 `pulse_v`（批 5a，D-TIP-1 结清），
装在内核 **K6 —— 任何硬件调用之前**。测试里实判了一次：±12 V 各拒一条，10.0 V 放行。

### 3.2 ⚠️ 每一次扎入**过不了深度那半道闸** ❌ —— 第一趟的状态，**第二趟接上了（§10）**

六条流程的扎入也只有一个出口：`_poke_step` → `TipShapeWithReadback`
（`_tip_phases.py:1815`），深度走 **`tip_lift_m`**（`tip_lift_m = -abs(depth_m)`）。

而 `TipShapeWithReadback` / `TipShape` 的 `validateParams` 报给方案表的字段是
`shaper_bias_v` / `shaper_lift_v` —— **两个都是电压**。深度包络 `max_poke_depth_m`
认的键是 `shaper_depth_m` / `poke_shallow_depth_m` / `poke_deep_depth_m`，
而 `resolveConditioning(fields, …)` **只把 `fields` 里点名的字段放进 `params`**，
`checkEnvelope` 也就只看得到那几个。

于是一发 **50 nm** 的下压：

| 哪道闸 | 结果 |
|---|---|
| K6 声明范围（`tip_lift_m` ∈ ±100 nm） | **放行** |
| 全局硬闸（按参数名子串，管电压） | 不管深度 |
| 针尖包络 `max_poke_depth_m`（通用档与 qPlus 档都是 10 nm） | **看不见它** |

测试「⚠️ 每一次扎入到不了深度那半道闸 —— 同一个数，一条路拒、一条路放行」把它钉住了：
同一个 `-5e-8` 喂给 `TipShapeWithReadback.validateParams` 得到 `[]`，
喂给 `resolveConditioning(['shaper_depth_m'], …)` 当场被拒。
**判据是好的（`tip_policy.json` 264 格逐格验过），缺的是接线。**

**旧仓同样如此**，而且旧仓自己的 `FIELD_OWNERS` 写着 `shaper_depth_m → ("TipShape",)`
—— 这个字段本来就是给它准备的，只是全仓**没有一处把值送进去**
（grep：`shaper_depth_m` 只出现在方案表与 `FIELD_OWNERS` 里）。
**生产方接好了、消费方缺席** —— 同 `_tip_phases.py:2106` 那条 `exclude_used_spots`
（「参数一直就在，只是从来没有调用方传过」）。

第一趟**没有改它**，理由三条：① 改的是一道**安全包络的辖区**，而那一趟一个技能都没落；
② 最自然的接法（把 `shaper_depth_m` 加进 `applyTipPolicy` 的 `policyFields`）会让方案表
在调用方**没给** `tip_lift_m` 时**填一个默认深度进去**，那是行为改变不是补闸；
③ 分派单要的是「经不过的，说清为什么」。

> 批 5a 结清 D-TIP-1 时那句「真正护音叉的那两样都在」（D-TIPREG-5 末段），
> **前一样当时接不上**。又一次「修好之后旧理由会静静变成假话」——
> 只不过这一次那句话是**我们自己**写的。

**⇒ 第二趟（主线决定）把它接上了。理由只有一条，而且是 D-TIP-1 原话的反面**：
当年不写空壳 `validateParams` 是因为「写了会让人以为这道闸在」；
现在的状态一模一样地坏，只是方向相反 —— **闸是实的、264 格验过、而没有任何输入到得了它**，
结果一样：有人会以为深度被护着。见 **§10**。

---

## 4. 变异清单（**6** 条，全部实跑到 red；**基线干净**）

**第一趟 2 条**（依赖账自己）——

```
node tools/mutate/run.ts forge-required-covers-the-terrace-leveling \
                         selfcheck-each-check-asks-its-own-chain
… 基线（1 个 scope）        ← 没有拒跑 ⇒ 基线 0 条红
2/2 变红
```

| id | 挡的是什么 | 变红 |
|---|---|---|
| `forge-required-covers-the-terrace-leveling` | `AutoTilt`（台面上的调平）两条特异化流程都走。漏掉它 ⇒ `TipForgeSelfCheck` 少报一条缺口，**而缺口数看起来仍然是对的** | 2 |
| `selfcheck-each-check-asks-its-own-chain` | 两个自检各背书一条链。数错链 ⇒ 修针自检不问 `PreScanCheck`（贵金属验证帧唯一的入口）也照样说缺口数对得上 | 5 |

**第二趟 4 条**（深度包络的接线，§10）——

```
node tools/mutate/run.ts tipshape-readback-depth-goes-through-the-envelope \
     tipshape-depth-goes-through-the-envelope tip-depth-is-judged-only-when-given \
     tip-depth-boundary-is-exclusive
… 基线（1 个 scope）        ← 没有拒跑 ⇒ 基线 0 条红
4/4 变红
```

| id | 挡的是什么 | 变红 |
|---|---|---|
| `tipshape-readback-depth-goes-through-the-envelope` | 扎入的深度走 `tip_lift_m`，而这个技能报给方案表的两个字段都是**电压**。拆掉 ⇒ 50 nm 下压全程放行 | 1 |
| `tipshape-depth-goes-through-the-envelope` | 孪生兄弟那一侧同一道闸。少一侧 ⇒ 同一串 `TipShaper_PropsSet` 一个挡一个不挡（D-TIPREG-3 那次不对称的回归） | 2 |
| `tip-depth-is-judged-only-when-given` | **没给就不判**。去掉守卫 ⇒ 方案表填一个默认深度进去，操作员把包络收到 0.5 nm 时，一次根本没要求下压的调用被出厂的 −1 nm 拒掉 | 2 |
| `tip-depth-boundary-is-exclusive` | 深度上限也是「不许超」不是「不许到」。这条 `>` 此前**一格输入都没有** | 1 |

**第一趟只有两条，因为它一个技能都没落** —— 两条挡的是**这本账自己**：
一张手抄的依赖表会静静过期，而一个少报自己缺口的自检，正是这两个自检存在的理由的反面。

### 4.1 血缘范围内的老变异重跑（我改了 `tip-selfcheck.ts` / `tip-policy.ts` / 两个 shaper）

第一趟 6 条 + 第二趟把整个针尖包络族一起重跑，**18/18 全红，基线干净**：

```
tip-envelope-compares-absolute-value         red 26   ← 批 5a 记 25
tip-envelope-boundary-is-exclusive           red 18   ← 批 5a 记 17
tip-depth-envelope-compares-absolute-value   red 28   ← 批 5a 记 25
tip-count-limit-is-the-tips-not-the-specs    red 44
tip-unregistered-is-not-fail-open            red  9   ← 批 5a 记 8
tip-explicit-zero-is-a-real-value            red 12
tip-policy-chain-is-coarse-to-fine           red 208
tip-override-can-tighten-the-envelope        red 42   ← 批 5a 记 41
tip-registry-normalizes-at-the-door          red  2
tip-human-trace-prints-python-repr           red 257
tippulse-envelope-is-checked-before-hardware red  2
tippulse-refuses-before-planning             red  1
tipshape-refuses-before-any-call             red  1
tipshape-bias-is-the-imaging-bias-not-3v     red 10
tipshape-policy-wins-over-reading            red  1
readback-tip-envelope-is-wired               red  2   ← 批 5a 记 1
forge-required-covers-the-terrace-leveling   red  2
selfcheck-each-check-asks-its-own-chain      red  5
```

⚠️ **涨上去的那五条不是底噪**（两趟的基线都是 0）：它们涨，是因为
**这一批给那几道闸补上了生产路径的输入**。`tip-depth-envelope-compares-absolute-value`
从 25 涨到 28 尤其说明问题 —— 它此前那 25 条**全部**走的是「驱动器直调解析器」，
现在才有三条是从一个真技能的 `validateParams` 走进去的。

### 4.2 按 green-8 的规矩，每一条都先问过「这道闸要在什么输入下才轮得到它做决定」

* `forge-required-…`：两侧输入 = **金样算出来的闭包**（一侧）与**表**（另一侧）。
  拿掉 `AutoTilt`，两边不等 ⇒ 红。不是「断言把自己抵消」那一型 ——
  期望值由**旧仓源码**给，不由被测的那张表给。
* `selfcheck-each-check-…`：两条链**各有对方没有的成员**
  （`PreScanCheck` / `AnalyzeFrameTilt` 只在贵金属那条；
  `BiasWiggle` / `AssessShockleyOnset` 只在锻造那条）。
  少了这个「两种候选各占一边」的输入，换一张表跑出来的结果会一模一样。
* `tip-depth-is-judged-only-when-given`：**这一条差点就是绿的。** 拆掉守卫之后
  `resolveConditioning` 会去方案表填值，而通用档出厂的 `shaper_depth_m = −1 nm`
  **落在自己的包络（10 nm）之内** ⇒ 不产生拒绝 ⇒ 输出一个字都不变。
  所以那一格必须先把 `max_poke_depth_m` 覆写收到 **0.5 nm**：
  只有这样「查表」与「不查表」才给出不同的答案，这道守卫才轮得到它做决定。
  （green-8 第一型「闸只有一侧有输入」，这次是在**写变异之前**就问出来的。）
* `tip-depth-boundary-is-exclusive`：金样里深度用例全在线两侧
  （−0.3 nm 过 / −1.2、−2、−5 nm 拒），**线上一格都没有**。
  这一批补的那一格（正好 −10 nm 放行）走的是生产路径，见 §10.4。

---

## 5. 金样怎么来的

```
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe \
    tools\spec-export\export_tip_phase_deps.py
```

**第六台专用驱动器，也是唯一一台静态的。** 为什么必须静态：这六条流程要一台真仪器
跑几十分钟到几小时，通用轨迹金样（直调 `execute`）与任何一台重放驱动器
**都录不到一格**；而「要移它得先有哪些」这个问题只能从源码读。

做法三步，纯 `ast`（不 import 旧仓运行时，连 `sys.path` 都不动）：

1. 四个文件里每个函数/方法收 `CompositeStep(skill_name=…, optional=…)` 字面量；
2. 收函数之间的调用（`yield from f(...)` / `f(...)` / `self._x(...)`），跨文件按
   `ImportFrom` 解名；
3. 从六个 `plan_dynamic` 求传递闭包。

**认不出字面量的写 `<dynamic>`，不猜**（今天全是字面量；哪天有人改成变量，
这张表会说出来，而不是少一行）。

**它是上界**：分支、预算、参数都可能让某一步这一趟不发。而上界正是
「要移这个技能得先有哪些」要的那个东西。

**两次导出逐字节相同**（`cmp` 实测，58 753 字节）。
`skill_traces.json` / `specs.ts` / `progress.json` 重跑**零改变**（没落技能）。

### 5.1 行数是怎么数的

`tokenize` + `ast`，脚本临时写的没入仓（十几行）：物理行 / 非空行 /
非空且非纯注释行 / 再去掉 docstring。§0.2 那张表就是它的输出。
函数级行数直接读金样的 `functions` 段（`first_line` / `last_line` / `lines`）。

---

## 6. 没做完的，逐条

### 6.1 六个技能本体 —— 全部，见 §1

按 §1.1 / §1.2 的杠杆排，下一轮该点的是：

1. **`FindCleanSpot` + 实验地图子系统**（≈3147 行）—— 一个人挡着全部六条，
   而且是九件封锁件里**唯一一件真正大的**。
   **`PulseConditionTip` 只差它**（闭包 15 函数 / 511 行，六条里最小）——
   地图一落，它当天就能移；
2. **`kde_layers`(15) + `_hist_modes`(32) + 二维中值滤波** ⇒ 解开 `FindFlatRegion`（挡五条）；
3. **`circle_tilt_resolution_deg`(14) + `z_span_for_frame`(9)** ⇒ 解开 `AutoTilt`（挡五条）。
   第 2、3 两件都在 `vision/` 上 —— **批 6b 的地盘**。

第 2、3 落完之后，`PokeConditionTip` 与 `FindCleanSpot` 之间就只剩那一件了。

### 6.2 `_tip_phases.py` 里**一行都没移**的判据（按值钱程度排）

这些都是纯判据，将来跟着流程一起移；列在这里是因为它们各自独立，
而分派单第 1 条要害说的「循环的退出条件就是这个技能的产品」指的就是它们：

| 件 | 位置 | 行 | 它是什么 |
|---|---|---|---|
| `poke_phase` | `_tip_phases.py:2294` | **489** | 深扎 ⇄ 临界浅扎两段状态机。三条出口各有各的输出：`refined`（成）· `needs_pulse` / `surface_spent`（废，而且**分得清是针尖还是表面**）· `cl.ok === false`（**判不了** —— 不动深度、换个地方再扎）。⚠️ 判「扎没扎上」**由扫图说了算，Z 只留档** —— 93 针标定：图上确有簇的 89 针里 55 针（62 %）被 40 pm 的 Z 阈值判成 `no_change`，真簇 \|dz\| 中位 5.4 pm **比基线噪声 σ≈10 pm 还小** |
| `flat_poke_sites` | `:1993` | **256** | **只有两态半**：`spent` / `split_tip` / `ok(空表)` / `ok(sites)`。旧版第三态 `undecidable` 的处置是「退回按几何选点继续扎」= 现场原话「闭着眼睛乱扎」，2026-08-17 删掉 |
| `level_phase` | `:1187` | **331** | 找台阶 → 调平。`_tilt_readout` 把 `AutoTilt` 的**四态**读对（`applied` / `no_action_needed` / `skipped` / `failed`）—— 2026-08-18 查出来旧仓两处读的键名**在回包里全都不存在**，于是每个读数恒为 `None` |
| `verify_phase` | `:970` | **213** | 正反扫描线重合度。`_unmeasured()` 那一支：**「没测到」不是「不合格」** |
| `pulse_phase` | `:738` | **218** | 极性状态机 + 同点预算。`direction` **四态**（up / down / none / **insufficient_data**），2026-08-14 之前 `== "up"` 把后三个压成一个布尔 |
| `_poke_step` | `:1732` | 144 | 20 mV 缓变 → 扎 → **等音叉响完再恢复偏压**（顺序是全部要点）。另有 `poke_bias_via_shaper` 那条**拒绝执行而不是静默降级**的路 |
| `_cluster_look` | `:1878` | 113 | 簇图 + 圆度。`is_round === null`（小到判不了）与 `double_tip === null` 都是**第三态**，`is True` 不是 truthy 判断 |
| `_relocate` | `:599` | 135 | 换地方。`avoid` 圆表、`searched_area_exhausted` 留痕、`pre_move_feedback` 失败要**说出来** |
| `_step_split_look` | `:484` | 66 | 台阶被针尖劈开了吗（高度直方图 → 台面能级 → 是不是单原子台阶的整数倍）。压 `vision/double_tip` + `instrument_profile.au_step_pm`，**这一轮 vision 不能碰** |
| `ringdown_report` / `poke_bias_v` / `scan_at_params` / `_mark_dirty` | `:1568` / `:1608` / `:173` / `:328` | 38 / 51 / 92 / 45 | 小件，各自独立 |

### 6.3 三件这一批**刻意没做**的

| | 为什么 |
|---|---|
| 把 `_tip_phases` 的判据核心先搬进 `kernel/`（不落技能） | **消融精神**：它们今天**没有消费方**（消费方就是那六条流程）。落一个没人读的判据模块，与落一个跑满轮数报失败的壳是同一件事，只是低一层 |
| ~~修 §3.2 的深度包络接线~~ | **第二趟做了**，见 §10。第一趟不做的三条理由里，②（会凭空填一个默认深度）是**真的**，所以第二趟绕开了那条接法 |
| ~~给 `tip_policy.json` 加一格「深度边界」~~ | 见 §10.4。**2026-09-19 由收尾支线结清**（`docs/handoff/fix-pyfixed.md`）：`shaper_depth_at_limit` 已加，264 → **276 格**，被拒数不变 |
| 动 `l0/index.ts` · `kernel/src/index.ts` · `gen-skill-specs.ts` 的 `BATCH_6A` · `export_skill_traces.py` 的 `BATCH_6A` 四个锚点 | **没有技能要注册**。四个锚点原样留着 |

---

## 7. 值得进课时的几件

1. **一个盘点结论可能「位置对、绑定约束错」。** 盘点说这批卡在
   `AssessClusterRoundness`，而那个技能确实在这几条流程里 —— 它只是不是**最紧的**
   那一件。判读规则：**「卡在 X」这句话要附一句「解开 X 之后还剩什么」，
   否则它只是「X 也缺」。**（这一批就是那句话的机器版：金样 + 封锁账测试。）

2. **`optional=True` 的步骤缺席，比必需步骤缺席更危险。** 必需步骤缺席 ⇒ 执行器中止，
   报的是那一步自己的精确错误；可选步骤缺席 ⇒ 流程接着跑，把「这一步失败了」
   当成「这一步测过了，结果是空」，然后给出一句**措辞上与真结论一模一样**的假话
   （「这片表面已经没有可用的落点了」）。
   **判一个组合技能能不能移，要按 `optional` 分两列看，不能只数必需步骤。**

3. **「不落」也是一种交付，但要交得出账。** 这一批的产品不是代码，是
   「六条各差哪几个、各多少行、红了说明可以重开」这件事**由判据算出来**。
   一句手抄的「还差 X」会静静过期 —— 同批 5a 第 2 条（「让那句话由判据算出来」），
   这一次是把它用在了**排期**上而不是文案上。

4. **一道闸可以「判据是对的、金样 264 格全绿、而没有任何输入到得了它」。**
   §3.2 的深度包络：`tip_policy.json` 逐格验过、变异
   `tip-depth-envelope-compares-absolute-value` 红了 25 条 —— 全部走的是
   **驱动器直调解析器**那条路。**没有一个技能把 `tip_lift_m` 送进去。**
   这是 green-8 三种形状之外的第四种：**闸有输入，但输入只来自测试**。
   判读规则：**问「生产路径上谁给它喂过值」，不是「它被测过没有」。**
   第二趟接上之后那条变异从 25 涨到 28 —— **涨的那三条就是生产路径**（§4.1）。
   ⇒ 可以更进一步：**一道闸的变异条数里，有几条是从真技能走进去的？**
   全部来自驱动器时，它就还是这一型。

4b. **「不写空壳」与「写了但没人送值」是同一个失败的两个方向。**
   D-TIP-1 当年不写空壳 `validateParams` 的原话是「**写了会让人以为这道闸在**」；
   而深度这一半是闸写实了、验过了、**却没有任何输入到得了它** —— 读的人一样会以为
   它在（写第一趟交接的我就差点这么写）。两者都靠「谁在生产路径上喂它」来分辨，
   而那件事**不在覆盖率里，也不在金样格数里**。

5. **一份盘点的「差什么」有效期只到下一次合并为止。** `AutoTilt` 的四个
   `instrument_profile` 入口批 5c 落了、`FindFlatRegion` 的六个下层件分散在
   四批里落了 —— 盘点写的时候每一句都是真的。
   同 green-8 §3.4 那条「一次演练的有效期只到下一次重构为止」，
   只是这次过期的是**分派表**。**修法一样：不能靠人记得，要让工具自己算**
   （这一批的 `tip_phase_deps.json` + 封锁账测试就是这件事）。

6. **`FIELD_OWNERS` 这种「谁该用这个字段」的表，是一份可执行的待办清单。**
   旧仓那张表写着 `shaper_depth_m → ("TipShape",)`，而 `TipShape` 从来没要过它。
   批 5a 说这张表「全仓零消费方」；这一批发现它其实是**一份没人对过的账**。
   同形：`exclude_used_spots`（`_tip_phases.py:2106`，「生产方接好了、消费方缺席」）。

---

## 8. 共享文件我动了哪些

**走锚点的**：

* `spec/deviations.md` 批 6a 锚点 —— 2 条，**编号一律留空（`?`）**
* `spec/golden/README.md` 批 6a 锚点 —— 专用驱动器加一行
* `tools/mutate/mutations.ts` 批 6a 锚点 —— **6 条**（第一趟 2 + 第二趟 4）

**四个锚点原样没动**（没有技能要注册）：`l0/index.ts`（三处）· `kernel/src/index.ts` ·
`gen-skill-specs.ts` 的 `BATCH_6A` · `export_skill_traces.py` 的 `BATCH_6A`。

**锚点之外动过的**（四个文件，请过一眼）：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `l0/tip-selfcheck.ts` | `FORGE_REQUIRED_SKILLS` 加四个、去一个；两处抬头注释 | §2，已登记 deviation |
| `l0/tip-policy.ts` | **新增 `tipDepthRefusals()`**（+ 一大段抬头写清为什么不能塞进 `applyTipPolicy`） | §10，已登记 deviation |
| `l0/readback-skills.ts` | `TipShapeWithReadback.validateParams` 多一行 `...tipDepthRefusals(params)` | §10 |
| `l0/tip-shape.ts` | **新增 `validateParams`**（只做深度）；抬头加第 ④ 条 | §10.3：`tip_lift_m` 是调用方直接给的量，按本仓的规矩属于 K6 |

**新文件**（无冲突面）：`tools/spec-export/export_tip_phase_deps.py` ·
`spec/golden/tip_phase_deps.json` · `packages/host/stm-skills/src/l0/tip-phase-deps.test.ts`。

`packages/host/vision/` 与 `packages/host/numerics/` **一个字节都没碰**
（连 import 都没新增）。

---

## 9. 怎么自己验一遍

```
pnpm install --frozen-lockfile
pnpm build && node scripts/gen-skill-specs.ts && node scripts/build-progress.ts
npx vitest run --project '!integration'                       # 102 文件 / 5780 条
STMSIM_PYTHON=D:\...\.venv-v2-py313\Scripts\python.exe \
STMSIM_ROOT=<STMSIM_ROOT> \
  npx vitest run --project integration                        # 15 文件 / 86 条
node tools/mutate/run.ts forge-required-covers-the-terrace-leveling \
     selfcheck-each-check-asks-its-own-chain \
     tipshape-readback-depth-goes-through-the-envelope \
     tipshape-depth-goes-through-the-envelope \
     tip-depth-is-judged-only-when-given tip-depth-boundary-is-exclusive  # 6/6 red
D:\...\python.exe tools\spec-export\export_tip_phase_deps.py  # 两次逐字节相同
```

⚠️ **演练之前一定先跑 `pnpm build → gen:skills → gen:progress`**（第四判据，green-8 §3.4）。
两趟跑之前都跑过，`git status` 里生成物**零改变**。

**本段术语表**：*闭包* = 从一个 `plan_dynamic` 出发、顺着函数调用能到达的全部
`CompositeStep`；*上界* = 这条流程**可能**发出去的子技能集合（分支可能让某一步这一趟
不发，但不会多出来）；*封锁件* = 闭包里还没移植的子技能；*绑定约束* = 若干缺件里
**最后一个**落地的那个（解开别的都不会让这条流程能跑）；*`optional=True`* = 这一步失败
执行器不中止，流程拿着空结果继续判 —— 缺席时它比必需步骤更危险。

---

## 10. 深度包络接线（第二趟）—— **本仓比旧仓严的一条**

§3.2 核出来的状态：深度那半道包络是实的、264 格验过、**而生产路径上没有任何输入
到得了它**。主线看完之后决定接上，理由只有一条，也是 D-TIP-1 原话的反面 ——
当年不写空壳 `validateParams` 是因为「**写了会让人以为这道闸在**」；
现在的状态一模一样地坏，只是方向相反。

### 10.1 接线长什么样

```ts
// l0/tip-policy.ts
export function tipDepthRefusals(params: Readonly<Record<string, unknown>>): string[] {
  const given = params['tip_lift_m']
  if (typeof given !== 'number' || !Number.isFinite(given) || given >= 0) return []
  return [...resolveConditioning(['shaper_depth_m'], { shaper_depth_m: given }).refusals]
}
```

消费方两处，**同一个函数、同一层**：

* `TipShapeWithReadback.validateParams` —— 在原有两个电压字段之后多一行；
* `TipShape.validateParams` —— **本仓新增**（它原本没有 `validateParams`）。

两个技能下发的是**同一串** `TipShaper_PropsSet` + `TipShaper_Start`。
一个挡一个不挡，正是 D-TIPREG-3 那次不对称要防的事。

### 10.2 三处刻意 —— 每一处都是「别把一道闸变成一次行为改变」

**① 不塞进 `applyTipPolicy` 的 `policyFields`。** 那是最自然的接法，而
`resolveConditioning` 对**没给**的字段会去方案表取值填进 `params`。
后果不是多一道闸，是多一次**假拒绝**。旧仓实跑确认过那个填值：

```
resolve_conditioning(("shaper_depth_m",), {})
  → params={'shaper_depth_m': -1e-09}   trace={'shaper_depth_m': 'factory_default'}
```

于是操作员把 `max_poke_depth_m` 覆写收到 0.5 nm 时，通用档出厂的 −1 nm 会让一次
**根本没要求下压**的调用被拒 ——「出厂默认落在自己包络之外」那条路
（`tippulse-refuses-before-planning` 钉着的，旧仓真出过）复活。

⇒ 守卫是「**显式给出**才判」，而这道守卫**本身**由变异
`tip-depth-is-judged-only-when-given` 钉着（那一格的输入就是那个 0.5 nm 覆写，
没有它这道守卫永远轮不到做决定 —— 见 §4.2）。

**② 只判下压那一半（`tip_lift_m < 0`）。** `tip_lift_m` 是有符号的方向量
（负 = 压向表面，正 = 抬离），`shaper_depth_m` 的定义域是下压（方案表全表负数）。
`checkEnvelope` 按绝对值比，是因为那个字段按构造就是负的 —— 不是在声明「抬起也危险」。

⚠️ **与旧仓解析器的取值范围不同，说清楚**：旧仓 `resolve_conditioning` 拿
`shaper_depth_m = +5e-8` 是**拒**的（实跑确认，见 §10.4）。但旧仓**从不把 `tip_lift_m`
送进这个字段**，所以那边没有「一次抬离该不该被拒」这个问题 —— 这个问题是本仓这条
接线新造出来的，答案由本仓给：一次抬离表面 50 nm 不会戳坏音叉，把它送进下压字段
等于凭空多一条方案表从来没声明过的限制。
**哪天有人用正向 `tip_lift_m` 做拉伸修针，这一条要重新想。**（测试里钉着。）

**③ 装在 K6 而不是 `TipShape.execute`。** D-TIPREG-4 说 `TipShape` 的包络在 `execute`，
理由是它那两个策略字段要先经过「方案表填不填」才知道最终值；**这一条不需要那一步**，
所以按本仓自己的规矩（批 5a 原话：「它们的量是调用方直接给的，所以装在 K6」）
它属于 K6 —— 而且那里比 `execute` 更早。`TipShape` 于是同时有 `validateParams`（深度）
与 `execute` 里那一判（两个电压），抬头第 ④ 条写清了为什么分在两处。

### 10.3 四条测试（`tip-phase-deps.test.ts`）

| 测试 | 它问的 |
|---|---|
| 每一次扎入也经过深度那半道闸 | 两个孪生技能对 `tip_lift_m = −50 nm` 都给**同一条**拒绝，且文案与解析器**同源**（不自己写第二句话） |
| 上限是「不许超」不是「不许到」 | −10 nm 放行、−10.000001 nm 拒 —— 这条 `>` 此前一格输入都没有 |
| 没给 `tip_lift_m` 就什么都不判 | 覆写把包络收到 0.5 nm（⇒ 出厂默认此刻确实超了它自己的包络，这是**反面输入**），而没给深度的三种调用一个字都不说 |
| 抬起不是下压 | `+50 nm` 不拒，附理由 |

### 10.4 金样：这一格**进不了** `tip_policy.json`，而缺的那一格是什么

分派单问「能不能在 `tip_policy.json` 里加一格『深度经由 `tip_lift_m` 进来』」。
**不能** —— 那台驱动器驱动的是**解析层**，网格的键是方案表字段名；
`tip_lift_m` 是**技能参数名**，`tip_lift_m → shaper_depth_m` 这条映射是本仓新增的，
**旧仓没有对应行为可录**。判据本身（`shaper_depth_m` 超限的拒绝文案，逐字）
已经由 `*/all_deep` 那 12 格录着。

**真正还缺的一格是深度的边界**（正好等于上限）：金样里深度用例全在线两侧
（−0.3 nm 过 / −1.2、−2、−5 nm 拒），线上一格没有。**这一批没有加它**，
理由是加一行请求 = 全表 +12 格，而「264 格」这句话要在四处改，其中两处在
`spec/deviations.md` 的 D-TIP-1 段落里 —— **本轮锚点之外**（分派单：共享文件只走批 6a 锚点）。

> **2026-09-19 结清**（收尾支线，`docs/handoff/fix-pyfixed.md`）：限制没有了，那一格加了。
> `export_tip_policy.py` 第 23 个请求 `shaper_depth_at_limit`
> （`shaper_depth_m = -1.0e-8`），全表 264 → **276 格**，12 支针尖**全过**，
> 被拒数不变仍是 **111**。「264 格」实际出现在 **9 处**（不是四处）：
> `spec/deviations.md` ×4、`spec/golden/README.md` ×1、测试注释 ×4；
> 另有两份交接按 `订正` 体例加注而不改原数。边界现在两侧都钉住了。

代替做法：边界由**生产路径**钉住（§10.3 第二行），并对旧仓**实跑核过一次**：

```
-1e-08          ok=True   (no refusal)          ← 正好等于上限，放行
-1.0000001e-08  ok=False  shaper_depth_m=-1.000e-08 m 的下压深度超出未登记针尖的
                          通用档的上限 1.000e-08 m。拒绝执行。
-5e-08          ok=False  （同上，-5.000e-08）
+5e-08          ok=False  ← 旧仓按绝对值拒；本仓这条接线不把抬起送进去（§10.2 ②）
```

两边一致（除了 `+5e-8` 那一格，那是本仓新造的问题，见 §10.2 ②）。
⚠️ 注意第二行：`-1.0000001e-08` 的拒绝文案里那个数被 `%g` 抹平成 `-1.000e-08`，
看起来和上限一模一样 —— 那是 **D-TIPREG-11** 记的同一件事，照移。

**下一个动 `tip_policy.json` 的人请顺手补上 `shaper_depth_at_limit`。**
