# 盘点七 · `composite.*`

> ## ⚠️ 2026-09-20 加注：**两个核不出来源的数**（写第七轮讲义时逐个复量出来的）
>
> | 盘点写的 | 实测 | 怎么量的 |
> |---|---|---|
> | `TiltProbeCircle` **208** | 整份 `tilt_probe.py` = **353**；`class TiltProbeCircle` 到文件尾 = **278** | `wc -l` / `awk` 数类体。**208 两个都不是**，推不出来 |
> | `vision/tilt.py` 圆块 **150**（标的区间 `:549-739`） | 那个区间 = **191** 行；`fit_circle_tilt` 本身 = **99**（`:632` 到下一个 `def`） | 同上。**150 也推不出来** |
>
> 而这一族**已经真落过了**（批 7a-1）：它报的是 `fit_circle_tilt` 99 +
> `CircleTilt` dataclass + 四个 `CIRCLE_*` 常量 ≈ **130 行** —— 那是**造出来之后量的**，
> 比这两个估的可信。
>
> 留着不改原数，是因为这份盘点是**那一天的快照**；但读它的人要知道这两格是估的。
> ⇒ **一张表里「量出来的」和「估出来的」长得一模一样，除非有人写下是哪一种。**

 一族

盘点日期 2026-09-20。两仓只读，未改动任何文件。
分母以 `spec/progress.json`（本仓，2026-09-19 17:16 生成）为准。

---

## 复核那张表 —— 26 模块 / 30 技能，逐条对上了

```
node -e "…modules[k].complete===false && k.startsWith('composite.')…"
⇒ composite 模块共 33 个，未完成 26 个，缺口技能 30 个
```

| 模块 | 缺口 | 模块 | 缺口 |
|---|---|---|---|
| `composite.prepare_noble_tip` | 3 | `composite.execute_scan_plan` | 1 |
| `composite.auto_tilt` | 2 | `composite.forge_au_tip` | 1 |
| `composite.make_special_tip` | 2 | `composite.grid_sts` | 1 |
| `composite.achieve_atomic` | 1 | `composite.line_sts_across_wall` | 1 |
| `composite.angle_series_calibration` | 1 | `composite.move_atom_to` | 1 |
| `composite.assess_quality` | 1 | `composite.prescan_check` | 1 |
| `composite.atomic_bias_series` | 1 | `composite.publication_frame` | 1 |
| `composite.bias_imaging_series` | 1 | `composite.scan_until_atomic` | 1 |
| `composite.condition_tip` | 1 | `composite.search_domain_boundary` | 1 |
| `composite.cross_point_tip_check` | 1 | `composite.shape_tip_on_surface` | 1 |
| `composite.demo_scan_and_sts` | 1 | `composite.spectroscopy_at_positions` | 1 |
| `composite.drift_track` | 1 | `composite.sts_condition_series` | 1 |
| | | `composite.survey_surface` | 1 |
| | | `composite.verify_atomic_resolution` | 1 |

三十个技能 `spec=false · model=true · traces=0 · impl=false`，一个不差。
另外 7 个 `composite.*` 模块已整模块清零，各 1 个技能：
`batch_regions_scan` · `bias_settle` · `full_scan` · `relocate_coarse_xy` ·
`retract_for_sample_change` · `scan_at` · `tip_pulse`。

`packages/host/stm-skills/src/composite/` 下有 **17 个非测试 `.ts` ＋ 8 个 `.test.ts`** ——
比 7 多出来的那些（`approach-tip.ts` · `auto-approach.ts` · `wait-scan-complete.ts` ·
`set-bias-ramp.ts` · `step-coarse-xy.ts` · `z-settle.ts` · `tip-evidence.ts` ·
`modulation.ts` · `approach-preset.ts` · `run-sub.ts`）住在 `composite/` 目录里，
但它们的技能登记在 `builtins.*` 模块下。**目录位置不是模块归属**，盘的时候别按目录数。

**所以这一族也不是从零开始** —— 它有一个已经建好并验收过的编排底座：
`GraphExecutor`（`packages/host/kernel/src/graph-executor.ts`）、动态计划的现成样板
（`composite/set-bias-ramp.ts:90` · `tip-pulse.ts:100` · `wait-scan-complete.ts:171`）、
以及封锁账 `packages/host/stm-skills/src/l0/tip-phase-deps.test.ts`。

---

# 一、封锁账先核一遍 —— **六条一条都没过期**

`tip-phase-deps.test.ts:142-158` 那张 `BLOCKED` 表，拿今天的 `IMPLEMENTED`
（= `progress.json` 里 `impl===true` 的 417 个，两者同集，`scripts/build-progress.ts:88`）重算：

| 流程 | 账上写的 | 今天实际缺的 | |
|---|---|---|---|
| `PulseConditionTip` | `FindCleanSpot` | 同 | ✓ |
| `PokeConditionTip` | `AutoTilt` · `FindCleanSpot` · `FindFlatRegion` | 同 | ✓ |
| `MakeSpectroscopyTip` | `AssessShockleyOnset` · `AutoTilt` · `FindCleanSpot` · `FindFlatRegion` | 同 | ✓ |
| `MakeAtomicResolutionTip` | `AssessAtomicPhase` · `AutoTilt` · `BiasWiggle` · `FindCleanSpot` · `FindFlatRegion` | 同 | ✓ |
| `PrepareNobleTip` | `AnalyzeFrameTilt` · `AutoTilt` · `FindCleanSpot` · `FindFlatRegion` · `PreScanCheck` | 同 | ✓ |
| `ForgeAuTip` | 同上五个 | 同 | ✓ |

`tip-phase-deps.test.ts:10` 抄的那四个地图文件行数也逐个对上（`wc -l`）：
`core/map_scope.py` **322** · `io/map_analysis.py` **1206** · `io/exp_map.py` **1015** ·
`io/coarse_map.py` **604**，合计 **3147**。那条注释不用改。

**但这张账记浅了一层** —— 见 ⚠️ 第 1 条。

---

# 二、一页纸总表

「自写行」= 该技能的 `plan_dynamic` / `execute` / `validate_params` / `aggregate` / `run_composite`
＋ 本文件里**它实际调到的**私有函数，去掉 docstring 与 `metadata()` 的 `ParameterSpec` 块。
不含它压着的子技能与判据本体（那些在「卡在哪」一栏里单列）。

## A 档 · 9 个 —— 依赖全在本仓

| 技能 | 模块 | 自写行 | 出处 | 卡在哪 |
|---|---|---|---|---|
| `AssessImageQuality` | `assess_quality` | **384** ＋ `data/quality.py` 三函数 **57** | `assess_quality.py:54-521` | 不卡。六个 `_phase_*` 是**伪步骤**，执行器根本看不见（`assess_quality.py:70-73`） |
| `PreScanCheck` | `prescan_check` | **481** | `prescan_check.py:45-1446` | 不卡。判据底座一条不缺，只差一个 3 行包装（见 B 档缺件表） |
| `ScanUntilAtomicResolution` | `scan_until_atomic` | **308** | `scan_until_atomic.py:107-672` | 不卡。四个子技能全落、唯一外部常量 `SCALE_FULL_NMPP` 在 `vision/src/atomic-phase.ts:67` |
| `MoveAtomTo` | `move_atom_to` | **236** ＋ 常量 4 | `move_atom_to.py:36-358` | 不卡。判据是四个模块常量与一次 `hypot`，零外部依赖 |
| `DemoScanAndSTS` | `demo_scan_and_sts` | **219** | `demo_scan_and_sts.py:169-470` | 不卡。八个子技能全落 |
| `AcquireBiasImagingSeries` | `bias_imaging_series` | **215** | `bias_imaging_series.py:44-319` | 不卡，但要先给 `SaveScan` 注入 `findLatestSxm`（见 ⚠️ 第 17 条） |
| `ExecuteScanPlan` | `execute_scan_plan` | **194** | `execute_scan_plan.py:58-371` | 不卡。它不是动态派发，是 `context.run()` 硬编码三个技能（`:268` · `:278` · `:289`），三个全落 |
| `TrackDrift_ReferenceScan` | `drift_track` | **189** | `drift_track.py:108-311` | 不卡。`correlate2d` 就是为它写的（`numerics/src/correlate.ts:125-128` 点名） |
| `GridSTS` | `grid_sts` | **149** | `grid_sts.py:25-340` | 不卡。三个子技能全落，判据全是本文件内的算术 |

**A 档小计 2436 行**（含 `data/quality.py` 的 57）。

## B 档 · 5 个 —— 差一件具体的东西

| 技能 | 自写行 | 差什么 | 那件东西多少行 | 缺了它会怎样 |
|---|---|---|---|---|
| `VerifyAtomicResolution` | **469** | `AssessAtomicPhase` | 107（`tip_spectro_assess.py:318-452`） | `optional=True` 但**被显式接住** —— 回 `undecidable/rescan_frame`。诚实 |
| `ShapeTipOnSurface` | **458** | `FindFlatRegion` | 363（`flat_region.py:70-827`）＋ `qplus_gate` 32 ＋ tip-shaper 预检 80 | **`optional=False`**（`shape_tip_on_surface.py:436`）⇒ 当场中止。这是五个里唯一「缺件=硬停」的，也是唯一不会造假读数的 |
| `SurveySurface_TileScan` | **285** | `AssessImageQuality`（A 档） | 见上 | ⚠️ `optional=True` 在这里**语义是反的** —— `on_step_failed:420-431` 会把每一块 tile 标成失败（见 ⚠️ 第 12 条） |
| `ConditionTip` | **267** | `AssessImageQuality`（A 档）＋ `wait_scan_complete` 内联 helper 27 | 见上 | **五个里最危险的一处**：`_quality_of:236` 把「没给 `fft_quality`」折成 `0.0` ⇒ 白打满 5 发脉冲再说一句关于针尖的假话 |
| `ScanPublicationFrame` | **214** | `AutoTilt`（C 档） | 见 C 档 | `optional=True` 且有诚实的降级说明（`publication_frame.py:268-271`）⇒ **可以先落**。但落之前必须先修 ⚠️ 第 10、11 条，否则移过来的是一个永远拒跑、且会存半帧的技能 |

**B 档自写小计 1693 行。**

## C 档 · 16 个 —— 压着一整个子系统

### C-1 针尖六条（封锁账那一批）

自写行按 `spec/golden/tip_phase_deps.json` 的 `functions` 表算：**自有文件的函数**与
**`_tip_phases.py` 的共用机器**分开报 —— 后者六条共用一份，按流程相加会重复计。

| 技能 | 自有函数 | `_tip_phases` 共用 | 闭包 `code_lines` | 缺件 |
|---|---|---|---|---|
| `ForgeAuTip` | 11 个 / **751** | 35 个 / 2611 | 3362 | 5 件 |
| `MakeAtomicResolutionTip` | 5 个 / **375** | 31 个 / 1841 | 2216 | 5 件 |
| `MakeSpectroscopyTip` | 4 个 / **223** | 31 个 / 1841 | 2064 | 4 件 |
| `PrepareNobleTip` | 7 个 / **161** | 35 个 / 2611 | 2772 | 5 件 |
| `PokeConditionTip` | 5 个 / **55** | 31 个 / 1841 | 1896 | 3 件 |
| `PulseConditionTip` | 3 个 / **26** | 12 个 / 485 | 511 | 1 件 |
| **六条去重后的 `_tip_phases` 机器** | | **35 个 / 2611 行** | | |

其中最大的五块：`poke_phase` 489（`_tip_phases.py:2294-2782`）· `level_phase` 331（`:1187-1517`）·
`flat_poke_sites` 256（`:1993-2248`）· `pulse_phase` 218（`:738-955`）· `verify_phase` 213（`:970-1182`）。

**「壳还是本体」的答案**：`PokeConditionTip`（整类 57 行，`plan_dynamic` 只有 12 行，
`prepare_noble_tip.py:278-292`）与 `PulseConditionTip`（整类 30 行，`plan_dynamic` 8 行，`:221-230`）
**是壳 —— 但它们转发的是一整台机器**。`ForgeAuTip` / `MakeAtomicResolutionTip` / `MakeSpectroscopyTip`
是判据本体。落一个壳不等于判据在，这一批把这句话演到了极致。

### C-2 其余十个

| 技能 | 自写行 | 压着什么（行数带出处） |
|---|---|---|
| `SearchDomainBoundary` | **1664**（A–J 十块，`search_domain_boundary.py:133-2438`） | 畴视觉 `vision/domain_phase.py` 915 ＋ `vision/domain_reference.py` 323 · 实验地图 3147 · `AssessDomainPhase` 264 · `coord_epoch` 154。**压着两个子系统，不是一个** |
| `SpectroscopyAtPositions` | **504**（`spectroscopy_at_positions.py:75-976`） | 坐标代次子系统（本仓 `stm-records` 20 张表里没有任何一张能回答 `current_epoch`）· 条件表 `core/sts_workflow.py` 231 · `AssessSpectrum` ≈550 |
| `AchieveAtomicResolution` | **462**（`achieve_atomic.py:114-1019`） | `_tip_phases` 2611 · `FindFlatRegion` 363 · `MakeAtomicResolutionTip` · `ForgeAuTip` · 粗动大地图 425（**已登记 D-RELOC-1 不移植**，`spec/deviations.md:2621`）· 三联分析图 187（本仓无绘图链路） |
| `AtomicBiasSeries` | **443**（`atomic_bias_series.py:58-704`） | `VerifyAtomicResolution` · `PreScanCheck` · `core/s2_bias_ledger.py` 554 · `coord_epoch` 154 · `plan_scale` 46 |
| `CrossPointTipCheck` | **424**（`cross_point_tip_check.py:82-675`） | `FindCleanSpot` → 地图 3147 · `PreScanCheck` · 判据本体 `conduct/cross_check.py` 241 · `coord_epoch` |
| `LineSTSAcrossWall` | **339**（`line_sts_across_wall.py:54-663`） | 地图标记层 · 畴参照系 `vision/domain_reference.py` 323 · 线谱几何 `core/sts_line_plan.py` 478 · 引擎 `SpectroscopyAtPositions` |
| `AutoTilt` | **268**（`auto_tilt.py:54-654` 的 AutoTilt 部分） | `TiltProbeCircle` 208（`builtins/tilt_probe.py`）· `vision/tilt.py` 圆拟合块 150 |
| `AcquireAngleSeriesForCalibration` | **215**（`angle_series_calibration.py:47-322`） | `CalibratePiezoMultiAngle` 468（`atomic_multiframe.py` 119 ＋ `lattice_multiframe.py` 260 ＋ `solve_affine` 89）＋ 一个 SVD（本仓 numerics 一个都没有） |
| `STSConditionSeries` | **215**（`sts_condition_series.py:75-446`） | 引擎 ＋ 条件表 231。**这是最便宜的一个 C** —— 引擎一落就降 B |
| `TiltCalibrate` | **194**（`auto_tilt.py` 的 TiltCalibrate 部分） | 同 `AutoTilt` ＋ `set_tilt_calibration` 40（`instrument_profile.py:840-899`）＋ 2×2 条件数 ~15 |

**C 档自写小计 6319 行**（C-1 自有 1591 ＋ C-2 4728；不含共用的 `_tip_phases` 2611
与各自压着的子系统）。

**三档自写合计 10448 行**（A 2436 ＋ B 1693 ＋ C 6319），
外加 `_tip_phases` 共用机器 2611 与十来个底座子系统 —— 那些不在这一族的账上。

## D 档 · 0 个整技能，但有 3 个块

没有哪个技能架构上整个不要。但 `SearchDomainBoundary` 那 1664 行里有三块可以整段不移：

| 块 | 行数 | 出处 | 为什么不要 |
|---|---|---|---|
| 块 C 聚类 `cluster_two` | 150 | `search_domain_boundary.py:318-482` | 唯一外部依赖是 `domain_phase.peak_distance`（本仓零对应）；产物是「给人看的两簇」而**簇不是畴**（`:369-371` 自陈），下游是一次人工确认。本轮没有任何消费方 |
| 块 G marker 重放 | 145 | `:955-1134` | 全部价值是「重启之后接着二分」，要 marker 存储 ＋ `coord_epoch`，本仓两样都没有 |
| `cross_site_downgrade` | 25 | `:688-725` | **本文件内零调用**（`_prepare:1331-1333` 走的是 `_cross_site_refusal:1605`），只出现在 `__all__:2513` |

另外三条「在旧仓里就是死的」——`achieve_atomic.py:114-117` `UNDECIDABLE_REASONS`（零引用）、
`verify_atomic_resolution.py:262-307` `atomic_scale_reject`（零调用方）、
`execute_scan_plan.py:145-165` `_frame_verdict` 的三条守卫 —— 见 ⚠️ 第 7、8、9 条。

**四档合计：A 9 · B 5 · C 16 · D 0 = 30。**

---

# 三、依赖图

## 3.1 整张图是 DAG —— **一个环都没有**

程序化检测（深度优先 + 在栈判定）跑过 30 个技能 ＋ 它们的未落子技能，**零环**。
这件事本身值钱：意味着**任何一条链都可以从末端往回一路解开**，不需要先拆环。

## 3.2 依赖图（文本）

```
【底座层 —— 本仓零对应的数值/存储子系统】
  实验地图 3147  ·  畴视觉 1238  ·  coord_epoch + 记录存储  ·  vision/tilt 圆块 150
  sts_workflow 231  ·  sts_line_plan 478  ·  s2_bias_ledger 554  ·  cross_check 241

【缺件层 —— 未落的 builtin / 判据本体】
  FindCleanSpot ────────┐（压 3147）
  FindFlatRegion ───────┤（363，底座齐，纯移植）
  AutoTilt ──→ TiltProbeCircle ──→ vision/tilt 圆块
  AnalyzeFrameTilt · AssessShockleyOnset · BiasWiggle · AssessAtomicPhase
  AssessSpectrum（550）· AssessDomainPhase（264）· CalibratePiezoMultiAngle（468）

【链 ①  最长的一条（4 层）】
  AchieveAtomicResolution ─→ MakeAtomicResolutionTip ─→ AutoTilt ─→ TiltProbeCircle
                                                          （再往下是 vision/tilt.py:632 fit_circle_tilt）
  同长的并行支：AchieveAtomicResolution ─→ ForgeAuTip ─→ AutoTilt ─→ TiltProbeCircle
  ★ 从 TiltProbeCircle 这一头开始做，能一路解开：
      TiltProbeCircle 208 ＋ vision/tilt 圆块 150
        ⇒ AutoTilt(268) + TiltCalibrate(194)          【2 个】
        ⇒ 再加 FindCleanSpot / FindFlatRegion / PreScanCheck 等
        ⇒ 五条针尖流程 + ScanPublicationFrame          【共 9 个传递解锁】

【链 ②  STS 那条（3 层）】
  LineSTSAcrossWall ─┐
                     ├─→ SpectroscopyAtPositions ─→ AssessSpectrum ─→ vision/spectroscopy 质量半边
  STSConditionSeries ┘                            （assessIv/assessIz 已在本仓）
  ★ 从 AssessSpectrum 这一头开始，但**先落条件表** `core/sts_workflow.py`（231，纯函数零 IO，三个 C 共用）

【链 ③  原子分辨那条（3 层）】
  AchieveAtomicResolution ─→ VerifyAtomicResolution ─→ AssessAtomicPhase ─→ vision/atomic-phase.ts ✓已在
  AtomicBiasSeries ────────┘
  ★ 从 AssessAtomicPhase 这一头开始：引擎已在本仓，这一件是薄壳 107 行

【链 ④  质量判据那条（2 层）】
  ConditionTip ────────┐
                       ├─→ AssessImageQuality ─→ numerics/vision ✓全在
  SurveySurface_TileScan┘
  ★ AssessImageQuality 本身是 A 档 —— 这条链**现在就能从头做到尾**

【链 ⑤  选点那条（2 层，但底下是墙）】
  ShapeTipOnSurface ─→ FindFlatRegion ─→ vision/plane.ts ✓ + step-levels.ts ✓
  CrossPointTipCheck ─→ FindCleanSpot ─→ 实验地图 3147  ← 墙
  ★ 两条看起来一样，**其实一条是纯移植、一条是子系统**：
    FindFlatRegion 的底座（RANSAC 去趋势、滑窗平面残差、数平台）本仓齐备；
    FindCleanSpot 压着 3147 行地图。别把它俩放进同一批。

【孤立点 —— 一件事换一个技能，不解锁别人】
  AcquireAngleSeriesForCalibration ─→ CalibratePiezoMultiAngle（468 + SVD）
  SearchDomainBoundary ────────────→ AssessDomainPhase（264）+ 两个子系统
```

## 3.3 每个缺件解锁几个（去重 · 传递闭包）

| 缺件 | 直接等它的 | 传递解锁 | 解锁哪些 |
|---|---|---|---|
| `TiltProbeCircle` | 2 | **9** | AutoTilt · TiltCalibrate · ScanPublicationFrame · 五条针尖流程 · AchieveAtomicResolution |
| `FindCleanSpot` | 7 | **8** | 六条针尖流程 · CrossPointTipCheck · AchieveAtomicResolution |
| `AutoTilt` | 6 | **7** | 五条针尖流程 · ScanPublicationFrame · AchieveAtomicResolution |
| `FindFlatRegion` | 7 | **7** | 五条针尖流程 · ShapeTipOnSurface · AchieveAtomicResolution |
| `PreScanCheck` | 4 | **5** | PrepareNobleTip · ForgeAuTip · CrossPointTipCheck · AtomicBiasSeries · AchieveAtomicResolution |
| `AssessAtomicPhase` | 2 | **4** | VerifyAtomicResolution · MakeAtomicResolutionTip · AtomicBiasSeries · AchieveAtomicResolution |
| `AssessSpectrum` | 1 | **3** | SpectroscopyAtPositions · LineSTSAcrossWall · STSConditionSeries |
| `AnalyzeFrameTilt` | 2 | **3** | PrepareNobleTip · ForgeAuTip · AchieveAtomicResolution |
| `AssessImageQuality` | 2 | **2** | ConditionTip · SurveySurface_TileScan |
| `SpectroscopyAtPositions` | 2 | **2** | LineSTSAcrossWall · STSConditionSeries |
| `VerifyAtomicResolution` | 2 | **2** | AchieveAtomicResolution · AtomicBiasSeries |
| `BiasWiggle` | 1 | **2** | MakeAtomicResolutionTip · AchieveAtomicResolution |
| `AssessShockleyOnset` · `AssessDomainPhase` · `CalibratePiezoMultiAngle` | 各 1 | **各 1** | — |

---

# 四、A 档分批建议

分批的判据与盘点七 · `paper.*` 同一条：**每一批只拉一条新的共用件进来**，一批红了知道是谁红的。

## 批 7c-1 · 零新原语的五个（5 个技能，自写 ≈ 1012 行）

`GridSTS`(149) · `DemoScanAndSTS`(219) · `TrackDrift_ReferenceScan`(189) ·
`AcquireBiasImagingSeries`(215) · `MoveAtomTo`(240)

**为什么能一起做**：

- 五个都是「计划 ＋ 纯算术判据」，**判据依赖为零** —— 没有一个要新的 vision / numerics 函数。
  `MoveAtomTo` 的全部判据是四个模块常量（`move_atom_to.py:36-40`）与一次 `hypot`；
  `TrackDrift_ReferenceScan` 要的 `parseFrameGrab` / `correlate2d` / `encodeNpyFloat64` /
  `decodeNpyFrame` 全在，而 `numerics/src/correlate.ts:125-128` 的注释**点名是为它写的**。
- 五个的子技能**全部已落**，一个 `✗` 都没有。
- 五个**互不依赖**，可以并行；也互不解锁别人，红了不会连累别的批。
- 唯一要先接的一件共用小东西：给 `SaveScan` 注入 `findLatestSxm`
  （`packages/host/stm-skills/src/l0/scan.ts:82-93`，现成的在 `l0/frames.ts:266 findLatestSaved`）。
  不接的话 `AcquireBiasImagingSeries` 每一帧都拿不到路径，整条流程报「成功的帧不足两张」。
  **这一件同时是批 7c-2 的前置**（`PreScanCheck` 的 `save_scan` 步也靠它）。

## 批 7c-2 · 两台判据本体 ＋ 它们身边的编排（4 个技能，自写 ≈ 1424 行）

`AssessImageQuality`(384＋57) · `PreScanCheck`(481) · `ScanUntilAtomicResolution`(308) ·
`ExecuteScanPlan`(194)

**为什么能一起做**：

- 这一批的价值不在自己，在**解锁**：`AssessImageQuality` 解 2 个、`PreScanCheck` 解 5 个
  （去重后共 6 个下游技能），是 A 档里回报最高的两件。
- 要拉的新共用件只有**三件小的**，而且三件都在同一层（`kernel` / `vision` 的薄包装）：
  1. `traceRetraceCorrelation` 的二维包装 —— **3 行**，底座 `vision/src/tip-metrics.ts:399 fwdBwdInstability` 已在；
  2. 技能侧读运行模式的口子 —— `SkillContext` 加一个只读字段，**~10 行**
     （消费端 `skill-kernel.ts:50 AUDIT_ONLY_KEYS` 已经把 `safe_mode_raw` 预留好了）；
  3. `wait_scan_complete` 的内联轮询 helper —— **27 行**（`_helpers.py:15`），
     `ConditionTip` 与 `PreScanCheck` 共用，旧仓刻意不做成步骤（怕 sidecar 秒回陈旧 outcome）。
- `AssessImageQuality` 的「伪步骤」在本仓比旧仓还便宜：Python 要一个 `__getattr__` 代理
  （`assess_quality.py:54-73`），TS 这边 `GraphExecutorDeps.run` 本来就是一个注入的函数
  （`graph-executor.ts:282` · `:435-436`），退化成一个 `if` 分支。**不需要给执行器加伪步骤支持。**
- `ScanUntilAtomicResolution` 与 `ExecuteScanPlan` 放进来是因为它俩**零缺件且零新原语**，
  但各自带着一条必须一起处理的判断（见 ⚠️ 第 9 条：`ExecuteScanPlan` 的三条守卫是死的）。

## 批 7c-3 · 被前两批解锁的 B 档（5 个技能，自写 ≈ 1693 行 ＋ 缺件 582）

`ConditionTip`(267) · `SurveySurface_TileScan`(285) · `VerifyAtomicResolution`(469) ·
`ScanPublicationFrame`(214) · `ShapeTipOnSurface`(458)

**为什么能一起做**：批 7c-2 落完之后，前两个的缺件就没了；后三个各差一件，
而三件互不相干、可以并行拉：`AssessAtomicPhase` 107 · `FindFlatRegion` 363（＋ `qplus_gate` 32
＋ tip-shaper 预检 80）· `AutoTilt`（可降级，先落带诚实说明的版本）。

**这一批有三个前置决定必须先做，不是可选的**：

1. `ConditionTip` **必须**等 `AssessImageQuality` 落了再落。先落它 = 交付一台打针机
   （`condition_tip.py:236` 的 `return 0.0`）。
2. `SurveySurface_TileScan` 落的时候要么等 `AssessImageQuality`，要么把 `assess_quality`
   默认改成 `False` —— 否则 `on_step_failed:420-431` 会把每一块 tile 标成失败。
3. `ScanPublicationFrame` 落之前先改两处旧仓 bug（⚠️ 第 10、11 条），并登记。

---

# 五、B 档缺件一行清单

| 缺件 | 是什么 | 多少行 | 出处 | 去重后解锁 |
|---|---|---|---|---|
| `AssessImageQuality` | 五相图像质量判据（FFT 质量 / RMS 粗糙度 / 噪声 / 正反扫 SSIM / 训练采样）。**它自己就是 A 档** | 384 ＋ 57 | `assess_quality.py:54-521` ＋ `data/quality.py:12-113` | **2**（ConditionTip · SurveySurface_TileScan） |
| `FindFlatRegion` | RANSAC 去趋势 → 滑窗局部平面残差 → 对 `USABLE_FLAT_RMS_M=25e-12` 判三态；找不到会换小一档窗口再试 | 363 | `flat_region.py:70-105`＋`281-827` | **7**（五条针尖流程 · ShapeTipOnSurface · AchieveAtomicResolution） |
| `AssessAtomicPhase` | **薄壳** —— 自己只加一道 `coverage` 闸，真引擎 `assessAtomicPhase` 本仓已在（`vision/src/atomic-phase.ts:402`） | 107 | `tip_spectro_assess.py:318-452` | **4** |
| `AutoTilt` | 闭环调平（读倾斜 → 圆法测斜率 → 按响应矩阵 G 下增量 → 复测 → 发散就回滚）。**自己是 C 档**，底下压 `TiltProbeCircle` | 268 ＋ 208 ＋ 150 | `auto_tilt.py` · `tilt_probe.py` · `vision/tilt.py:549-739` | **7**（含 ScanPublicationFrame） |
| `traceRetraceCorrelation` 二维包装 | `clip(1 - fwdBwdInstability(a,b), -1, 1)` | **3** | 底座 `vision/src/tip-metrics.ts:399` | 1（PreScanCheck） |
| SAFE 模式读取口 | `SkillContext` 加一个只读运行模式字段 | ~10 | 消费端 `skill-kernel.ts:50` 已预留 | 1（PreScanCheck） |
| `wait_scan_complete` 内联 helper | 同步轮询，**刻意不做成步骤** | 27 | `composite/_helpers.py:15-63` | 2（ConditionTip · PreScanCheck） |
| `SaveScan` 注入 `findLatestSxm` | 本仓默认实例不接文件系统 | ~5 | `l0/scan.ts:82-93`，现成 `l0/frames.ts:266` | 2（AcquireBiasImagingSeries · PreScanCheck） |
| `qplus_gate` | 主动把针压进表面对石英音叉不可逆，默认放行、`MAST_QPLUS_POKE_GUARD=1` 才生效 | 32 | `builtins/_tip_policy.py:32-100` | 1（ShapeTipOnSurface） |
| tip-shaper 模块预检 | 一次性上前探，fail-open | 80 | `composite/_preflight.py:36-37`＋`62-222` | 1（ShapeTipOnSurface） |
| `AssessSpectrum` | **外壳只做 IO 与列名解析，一个阈值都不判**（`spectrum_assess.py:5` 自述）；判据本体在 `vision/spectroscopy.py:436-935` | 230 ＋ 310 ＋ 12 | `spectrum_assess.py` · `vision/spectroscopy.py` | **3** |
| `core/sts_workflow.py` 条件表 | 组名 → 一整套数字，越界**拒绝不夹紧**；纯函数零 IO | 231 | `core/sts_workflow.py` | 3（三个 STS 技能共用） |
| `CalibratePiezoMultiAngle` | 多帧多角压电定标（`K_img(θ)=R(θ)ᵀG − c·ê_y`），要 `fsolve` 多起点多分支求根 ＋ SVD | 468 ＋ SVD | `atomic_multiframe.py` · `lattice_multiframe.py` · `lattice_calibration.py:428-524` | **1** |
| `AssessDomainPhase` | 畴指纹抽取 ＋ 对参照系分类 | 264 | `builtins/domain_assess.py:81-264` | **1** |
| `AnalyzeFrameTilt` · `AssessShockleyOnset` · `BiasWiggle` | 批 7a-1 / 7a-3 已在 `spec/deviations.md:2959`·`2967` 留了位置 | 查不到（未拆） | — | 3 · 1 · 2 |

---

# 六、⚠️ 与现状不符 —— **24 条**

## 甲组 · 盘点表与封锁账本身的错（4 条）

**1. 封锁账记浅了一层 —— `AutoTilt` 落了也解不开那五条。**
`packages/host/stm-skills/src/l0/tip-phase-deps.test.ts:142-158` 把 `AutoTilt` 列为五条针尖流程的缺口，
这是对的；但 `AutoTilt` 自己还要 `TiltProbeCircle`（`auto_tilt.py:134` 的 `context.run`），
而 `spec/progress.json` 里 `TiltProbeCircle` 是 `impl:false`，**它不在那份 `BLOCKED` 表的任何一行**。
那张表数的是 `GOLDEN.skills[flow].sub_skills` 的一层，不是闭包。
建议：`tip-phase-deps.test.ts` 的抬头注释加一句「这张表数的是一层，不是闭包」，
或者把 `AutoTilt → TiltProbeCircle` 这一跳补进去。

**2. 我这份盘点自己的机械扫漏了 `PulseConditionTip`。**
`achieve_atomic.py:806` 的 `skill_name=skill` 是循环变量，`:790-791` 解出来是
`("r3a","PokeConditionTip")` 与 `("r3b","PulseConditionTip")` 两个值。
所以 `AchieveAtomicResolution` 的缺件是 **9 个**不是 8 个。已在上面的图里改正。

**3. 机械扫 `skill_name=` 会把 `SkillResult(skill_name=…)` 当成依赖。**
`auto_tilt.py` 与 `execute_scan_plan.py` 第一遍各扫出 12 / 6 个「子技能」，
全部是**报自己的名字**。真相：前者是 `BaseSkill` 直打 `safe_call`（`:82`·`:99`·`:445`）＋
一个 `context.run("TiltProbeCircle")`（`:134`）；后者是 `context.run()` 硬编码三个技能名
（`:268`·`:278`·`:289`）。**「一个 `CompositeStep` 都没有」≠「没有依赖」。**

**4. `spec/progress.json` 的 `skills` 是对象不是数组。**
写成 `skills[*].impl === true` 会让人拿 `.map` 去取（TypeError）。计数本身对：
515 个键、417 个 `impl:true`，且 `impl` 与 `status==='done'` 完全同集。

## 乙组 · 旧仓里其实是死的 / 不可达的 —— 照移会搬进一个假承诺（9 条）

**5. 三个 STS 技能的采集路径，在旧仓出厂状态下就是不可达的。**
`core/sts_workflow.py:251` 的 `CONDITIONS` 只有一个组 `"default"`，四个样品事实字段
（`stab_bias_v`·`stab_setpoint_a`·`start_v`·`end_v`）默认全是 `None`（`:100-105`）；
`:135 missing_fields` 因此非空，`:155 problems()` 非空，`:320 usable` 恒为 `False`
⇒ `_resolve_condition` 在任何一步跑起来之前拒绝每一次调用。
**这决定了移植的验收标准**：可核对的是「拒绝得对不对、缺哪几个字段点没点名」，
不是「采到了几条谱」。谁拿一条「采集成功」的 trace 说它绿了，那条 trace 旧仓也跑不出来。

**6. `ScanPublicationFrame` 在默认参数下永远拒跑。**
`publication_frame.py:211` 读 `v.get("passed")`，而 `AssessAtomicResolution` 的 `data` 字典
（`builtins/atomic_lattice.py:203-206`）给的是 `passed_forward` / `passed_backward` ——
全文件 `grep '"passed"'` **零命中**（我核过）。⇒ `not None` 恒真 ⇒ 第 1 步入口闸必然命中，
以 `tip_not_good_enough` 返回，第 2–6 步一步都跑不到。而它给的拒绝理由是
「针尖角向集中度 %.1f，要求 ≥ %.0f」—— **一句关于针尖的假话**。
本仓 `l0/analysis-lattice.ts:558-575` 逐字照移了同一组键，所以照抄会把这个 bug 一起搬过来。

**7. `AtomicBiasSeries` 的 `VerifyAtomicResolution` 永远不 yield。**
`atomic_bias_series.py:431` 读 `sdata.get("saved_path")`，而 `sdata` 是 `ScanAt` 的 `data`（`:393`）。
`saved_path` 全仓唯一的生产点是 `builtins/scan_extra.py:175`（即 `SaveScan`）；
`ScanAt` 的 `aggregate`（`scan_at.py:391-396`）只回 `partial_data` ＋ `_resolved_snapshot`。
⇒ `:432 if not path:` 恒真 ⇒ 每次都落 `undecidable` ＋ `continue`。
**对照**：`angle_series_calibration.py:258-259` 与 `bias_imaging_series.py:248-249`
读的都是 `{tag}:save` 那一步的 `sub_result` —— 那两处是对的，这一处是错的。

**8. `ExecuteScanPlan` 的三条守卫在真实接线下永不触发。**
`execute_scan_plan.py:145-165` 的 `_frame_verdict` 读五个键：`crash_indicator`（生产者是
`scan_frame.py:519` 与 `qplus_amplitude.py:266`）· `crash_check`（生产者 `full_scan.py:602`）·
`tip_change_critical` / `tip_event`（**全库只有消费者，零生产者**）· `fft_quality`
（生产者 `assess_quality.py:323`）—— **`ScanAt` 一个都不产出**。
⇒ 模块 docstring（`:16-21`）自述的「针尖事件 → 中止整批」与「撞针 → 中止整批」都是死的，
`quality` 恒为 `None`，`ok` 退化成 `success`。移植时别把这三条抄进 description。
同一段死码也在 `atomic_bias_series.py:394-397`。

**9. `AcquireAngleSeriesForCalibration` 那道「动仪器之前拒绝」的闸永不生效。**
`angle_series_calibration.py:134-138` 的 `except Exception: spread, cond = 999.0, 1.0` ——
999° 张开度与条件数 1.0 都是**最优值**，紧接着 `:139 if spread < 15.0` 必然不成立。
本仓既然没搬 `angleConditioning`（`vision/src/lattice-multiframe.ts:37-40` 明文写着没搬），
照抄这段就等于那道护栏一次都不会生效。
**这与 `auto_tilt.py:290-296` 记的 `cond = 1.0` 兜底是同一个形状的坑，区别是那边已经修了。**

**10. `ScanPublicationFrame` 的超时预算一次都没生效。**
`publication_frame.py:299` 传 `params={"timeout": timeout_s}`，而规格是 `timeout_ms`
（`scan_utils.py:167`，本仓 `generated/specs.ts` 的 `WaitScanCompleteSpec` 同）。
同文件的 `prescan_check.py:543` 与 `survey_surface.py:318` 传的都是 `timeout_ms`，只有这里是 `timeout`。
⇒ `:154` 那个精心算出来的 `max(600, line_t*pixels*1.5)` 从未生效，
而这一步 `optional=True` ⇒ 超时了也继续走到 `SaveScan`，**存下来的可能是半帧发表级图**。

**11. `SurveySurface_TileScan` 的 docstring 描述了一件没发生的事。**
`survey_surface.py:79` 逐字写着返回 `tile_path`，而全文件 `tile_path` **只出现在这一行 docstring 里**，
实现从不记录它；`plan()`（`:256-332`）里既没有 `SaveScan` 也没有 `GetLatestScanFile`。
另外 `assess` 步的参数是 `params={}`（`:327`）⇒ `AssessImageQuality` 会走「找最新一张扫描图」的回落，
**没有任何东西保证那张最新图就是刚扫完的这块 tile**。

**12. `ShapeTipOnSurface` 的「Always restores feedback」是假的。**
`shape_tip_on_surface.py:664-674` 的注释自陈：`ZControllerOnOff` 的参数名曾写成 `on`，
`validate_params` 判失败而 `optional=True` 把它吞掉。本仓参数名是 `enable`，对得上 —— 移植时要逐字核。

**13. 三个零调用的死件，别照移。**
`achieve_atomic.py:114-117` `UNDECIDABLE_REASONS`（全仓只有定义、零引用，连测试都没有）·
`verify_atomic_resolution.py:262-307` `atomic_scale_reject`（零调用方，且依赖本仓没有的
`plan_scale`/`min_pixels_for_scale`，移了就得连带补两个本仓不需要的判据函数）·
`search_domain_boundary.py:688-725` `cross_site_downgrade`（本文件内零调用）。

## 丙组 · 本仓其实已经有了 / 已经与旧仓分叉（11 条）

**14. `MoveToXY` 的 `coord_epoch` 参数在本仓是死的。**
`packages/host/stm-skills/src/generated/specs.ts:558` 声明了它，而
`packages/host/stm-skills/src/l0/move.ts:38-141` **一次都没读**。
全仓 grep `coord_epoch`（排除 `lib/`）只命中这一行 —— 本仓现在有一个「声明了但是死的」代次参数。
而 `SpectroscopyAtPositions` · `ExecuteScanPlan` · `CrossPointTipCheck` · `AtomicBiasSeries` ·
`SearchDomainBoundary` **五个技能都要真的代次查询**，本仓 `stm-records` 的 20 张表里
没有任何一张能回答 `current_epoch`。

**15. `clear_sidecar()` 在本仓没有对应物要写。**
`packages/host/kernel/src/graph-executor.ts:496` 的 `runPlan` 在非中止收尾时已经自己删 sidecar。
所以 `spectroscopy_at_positions.py:904` 与 `grid_sts.py:331` 的那一行直接掉。
而 `grid_sts.py:322-329` 那段注释讲的正是「这件清理从来没做过」——
**理由要保留、动作不要重写**。

**16. `paper.line_check` 的常量已经搬了，技能没搬。**
`prescan_check.py:1178` 从 `mast.skills.paper.line_check` 导入 `_DEFAULT_MIN_CORRUGATION_M`，
而 `CheckLineQuality` 在 `progress.json` 里是 `impl:false`。
但那个常量已经单独搬进 `packages/host/kernel/src/corrugation-gate.ts:88`
（`lowGate = { m: 15e-12 }`，注释里逐字写着「与旧仓 `paper.line_check._DEFAULT_MIN_CORRUGATION_M`
逐字相同」）。**移植时从 `corrugation-gate` 取，不要等 `CheckLineQuality`。**

**17. `SAFE` 模式：消费端先落了，生产端还没有。**
`prescan_check.py:891` 的 `safe_mode_active()` 本仓无读取口（`skill-kernel.ts:198` 的
`SkillContext` 不含运行模式），而 `skill-kernel.ts:50` 已经把 `safe_mode_raw` 列进 `AUDIT_ONLY_KEYS`。

**18. `traceRetraceCorrelation` 的本仓等价物语义是反的。**
`prescan_check.py:1033` 用的那个函数本仓不存在；等价物是
`packages/host/vision/src/tip-metrics.ts:399 fwdBwdInstability`，但前者 1 = 一致、后者 0 = 一致。
**照抄名字会出一个符号反了的判据。**

**19. 本仓 `SaveScan` 默认不接文件系统。**
`packages/host/stm-skills/src/l0/scan.ts:82-93`：`findLatestSxm` 未注入时 `saved_path` 恒 `null`，
而 `export const SaveScan = makeSaveScan()` 就是这个默认实例，全仓没有任何一处注入。
`AcquireBiasImagingSeries`（`bias_imaging_series.py:249-254`）**没有兜底**，
`AcquireAngleSeriesForCalibration`（`:261-267`）有 `GetLatestScanFile` 兜底。

**20. 本仓 `AcquireSTS` 的候选目录只有 session 一路。**
`packages/host/stm-skills/src/l0/spectroscopy.ts:226` 的 `SAVED_DAT_MAX_AGE_S = 120`
＋ `:246-249` 只看 session 目录（按 D-FRAME-1 登记），旧仓是四路
（`builtins/scan_extra.py:227-290`）。`_check_attribution` 那一层可以照移，覆盖面更窄。

**21. 组合深度只剩零余量。**
`packages/host/kernel/src/skill-kernel.ts:268 MAX_COMPOSITION_DEPTH = 4`，`:750` 在
`depth+1 >= 4` 时拒。链路 `LineSTSAcrossWall(0) → SpectroscopyAtPositions(1) →
BiasSettleChange(2) → SetBiasRamp(3)` **刚好塞满**（消耗第 3 层的是
`composite/bias-settle.ts:80-81`；`set-bias-ramp.ts` 内部跑相、不再 `runSkill`）。

**22. 本仓没有 composite 基类。**
全仓 grep `CompositeSkillGraph` / `validateProducts` / `decideOutcome` / `graphExecute`
**零命中**，每个组合技能自己写 `run()`（样板 `composite/batch-regions-scan.ts:308`）。
旧仓那批 `self._graph_execute(...)` / `_validate_products` / `_decide_outcome` 要就地展开。

**23. `vision/src/plane.ts` 与 `AutoTilt` 不相干。**
它的十一个函数全是**拟合一帧图像**的平面；而 `auto_tilt.py` 与 `tilt_probe.py:11-14` 的
整个设计前提正是**不用帧法**（慢扫轴跨几十分钟，热漂移与真倾斜不可分）。
`planePeakToPeak` 与 `noiseFloor` 只能给 `AutoTilt` 的 `surface_rms_m` 参数供数，仅此而已。
另：`instrument-profile.ts:89-102` 的 `CONFIG_SPEC` 缺 `z_range_m` 与 `tilt_limit_deg`
（旧仓 `core/instrument_profile.py:265`·`:269`），而 `z_range_m` 是 `AutoTilt` 全部三个阈值的分母。

**24. 旧仓有两个 `PreScanCheck`，落错一个这技能就永远弃权。**
声明式孪生体在 `skills/composite/builtin_composites.py:616`，它自己的描述（`:617-622`）逐字写着
「**它给不出针尖判决** —— `tip_ready`/`similarity` 恒为 None」；手写真身在
`skills/composite/prescan_check.py`（1446 行），先读存盘的 `.sxm`。
`CrossPointTipCheck:420-432` 读的是 `tip_ready` 三态 —— 落错哪一个，它就每点都记「预检判不了」，
**而仍然返回 `success=True`**，那正好是它整篇抬头在防的形状。

---

# 七、几条给下一批排期的判断

1. **本仓的批号已经留好位置了**：`spec/deviations.md:2959`·`2963`·`2967` 三行注释分别是
   批 7a-1（`vision/tilt` 一族 ＋ `AnalyzeFrameTilt` ＋ `AutoTilt`）、批 7a-2（实验地图层 ＋
   `FindCleanSpot`）、批 7a-3（`kde_layers` ＋ `FindFlatRegion` ＋ `BiasWiggle`）。
   本盘点算出来的解锁账**与这个切法一致**：7a-1 解 7 个、7a-2 解 8 个、7a-3 解 7 个。
   但 7a-1 那一批要把 `TiltProbeCircle`（208）＋ `vision/tilt.py` 圆块（150）算进去，
   只按 `auto_tilt.py` 的 654 行算会漏掉一大半。

2. **`FindFlatRegion` 与 `FindCleanSpot` 不要放进同一批。** 两者在图里位置对称，
   但前者的数值底座本仓齐备（`vision/plane.ts:314 planeSubtractRobust` RANSAC ·
   `vision/step-levels.ts:53 levelsOf`），是一次**纯移植**；后者压着 3147 行地图，是一个**子系统**。

3. **`optional=True` 在这一族里有三种完全不同的含义**，盘的时候必须逐处读，不能按标志分类：
   - **诚实的降级**：`ScanUntilAtomicResolution:406-425` / `VerifyAtomicResolution:586-590` /
     `SearchDomainBoundary:1829-1863` / `CrossPointTipCheck:407-457` —— 每一处缺席都被显式接住，
     落成一个具名的「判不了」。**这四个是仓里做得对的样板。**
   - **会说假话**：`ConditionTip:236`（折成质量 0，白打五发脉冲）/
     `AchieveAtomicResolution`（11 处全 optional，缺件时会把「一个子技能都没跑成」讲成
     「走完了允许的档位仍没拿到原子分辨」）/ 六条针尖流程的 `FindCleanSpot`
     （`tip-phase-deps.test.ts:13-18` 已经把这件事写下来了）。
   - **语义是反的**：`SurveySurface_TileScan:420-431` —— `on_step_failed` 先写
     `rec["success"] = False` 再 `return step.optional`，所以缺件时是**把 64 张真图整批判死**，
     而技能仍返回 `success=True`。这不是假阳性，是等价严重的另一个方向。

4. **`AchieveAtomicResolution` 的换区分支在本仓永远走不到** —— `_coarse_suggestion:161-191`
   走的是 `io/coarse_map`，而那条已登记 D-RELOC-1 不移植（`spec/deviations.md:2621`）。
   落它的时候要像 D-RELOC-1 那样**把降级写进报文**，而不是留一条永远不亮的分支。
