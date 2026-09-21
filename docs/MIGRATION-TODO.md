# 技能迁移范围与剩余工作

本清单供继续迁移技能或评审迁移范围时使用。**2026-09-21 按当前 [progress.json](../spec/progress.json) 复核数量与技能名单**；依赖分析来自 2026-09-20 的三份分族盘点，未在本次重新执行私有参考实现。

迁移完成定义见 [开发指南](DEVELOPMENT.md#技能迁移的完成定义)。公开发布与技能迁移分别验收，发布事项见 [发布清单](RELEASE-TODO.md)；已安装运行入口实际开放的工具见 [README](../README.md)。

## 0. 原始范围与迁移目标

| 范围 | 当前统计 | 当前目标 | 目标内剩余 |
|---|---|---|---|
| 技能 | 442 / 515 | 502 | 60 |
| 全部技能均为 `done` 的模块 | 112 / 165 | 160 | 48 |

`progress.json` 的 `done` 表示实现已注册、规格与模型 schema 存在且至少有一条参考轨迹；它不读取完整验收结果。原始清单尚有 **73 个技能**未标为 `done`，其中 **60 个在当前迁移范围内，13 个明确排除**：

| 排除范围 | 技能数 | 原因 |
|---|---|---|
| `builtins.optics_stage` | 8 | 依赖不属于本项目范围的光学台驱动层 |
| `builtins.optics_scan` | 1 | 排除光学台扫描；同模块的 `AcquireSignalPoint` 已迁移 |
| `builtins.optics_pump_probe` | 1 | 依赖同一光学台驱动层 |
| `paper.imspec` / `paper.region_analysis` | 3 | `PredictSpectrumFromTopo`、`PredictStructure_ASD`、`IdentifyTopology_CARP` 的 `model_path` 必填，参考实现直接加载深模型且无回退路径；当前不迁移这些模型依赖 |

因此，在当前范围下，上述五个模块不能达到“原始模块全部技能完成”。报告进度时同时保留原始范围 **515 / 165** 与迁移目标 **502 / 160**，不要改写生成文件的分母。

`ComposePanelMontage` 仍在迁移范围内：迁移判据与数据处理层，排除 matplotlib 呈现层。分层方式可参考 [scan-prep-skills.ts](../packages/host/stm-skills/src/l0/scan-prep-skills.ts)。

## 1. 当前范围内的 60 个技能

下列名单与当前 `progress.json` 对齐；每项旁边的依赖说明来自历史盘点，开工前应复核对应代码与偏差登记。盘点中的 A / B / C / D 分别指依赖已具备、缺少具体组件、依赖较大子系统和明确排除，不是运行验收等级。

完整依据：[builtins 盘点](handoff/survey7-builtins.md)、[composite 盘点](handoff/survey7-composite.md)、[paper 盘点](handoff/survey7-paper.md)。这些报告保留原快照，后续完成情况以生成进度为准。

### builtins：19 个技能 / 19 个模块

```text
atomic_lattice            CalibratePiezoFromLattice      — 3×3 非线性求根器，替代 fsolve
atomic_multiframe         CalibratePiezoMultiAngle       — 与上一项共用 solve_affine
best_frame                TrackBestFrame                — DEFAULT_MIN_CONCENTRATION=300.0 的统一来源
characterise_noise        CharacteriseCurrentNoise      — 循环变量形式的动态 context.run，需声明闭包限制
coarse_selfcheck          CoarseMotionSelfCheck         — 盘点将其从子系统依赖项调整为可直接迁移
dispersion_fit            FitDispersion                 — curveFit 的 box bounds 与 scipy.special.j0
domain_assess             AssessDomainPhase             — 参考快照缺少参照系目录，相关分支需明确处理
envelope_reconcile_skill  ReconcileSafetyEnvelope       — 参考 fail-open 分支需修正并登记
feedback_tracking         AssessFeedbackTracking
frame_drift_skill         MeasureFrameDrift             — FFT 零填充二维线性互相关，mode='full'
hardware_events           ReadHardwareEvents            — 区分“读不到安全闸”与“无拦截”
herringbone_assess        AssessHerringbone
history_query             QueryMonitorHistory           — 参考实现调用了不存在的 store.sensors()
quiet_drift               CharacteriseQuietDrift
scan_intel_selfcheck      ScanIntelSelfCheck            — scan_resolver.preview；核对盘点记录的三处状态误报
slow_drift_skill          AnalyseSlowDrift
spectral_peaks            FindSpectralPeaks              — curveFit 的 pcov
spectrum_assess           AssessSpectrum
tip_spectro_assess        AssessShockleyOnset            — 成功路径的参考缺陷，见 §3
```

### composite：23 个技能 / 20 个模块

```text
achieve_atomic            AchieveAtomicResolution
angle_series_calibration  AcquireAngleSeriesForCalibration
assess_quality            AssessImageQuality             — 六个下游 autonomous 技能的共享依赖
atomic_bias_series        AtomicBiasSeries
condition_tip             ConditionTip                   — 与 AssessImageQuality 共同阻塞下游流程
cross_point_tip_check     CrossPointTipCheck
execute_scan_plan         ExecuteScanPlan
forge_au_tip              ForgeAuTip                     — PreScanCheck
line_sts_across_wall      LineSTSAcrossWall              — 参考默认配置的采集路径不可达，见 §4
make_special_tip          MakeAtomicResolutionTip  MakeSpectroscopyTip
                         MakeSpectroscopyTip 依赖 AssessShockleyOnset
prepare_noble_tip         PokeConditionTip  PrepareNobleTip  PulseConditionTip  — 见 §2
prescan_check             PreScanCheck                   — safe_mode_active 等依赖见盘点
publication_frame         ScanPublicationFrame           — 参考默认参数下的字段不匹配，见 §5
scan_until_atomic         ScanUntilAtomicResolution
search_domain_boundary    SearchDomainBoundary           — 聚类、marker 重放及未调用的 cross_site_downgrade 需按实际调用评估
shape_tip_on_surface      ShapeTipOnSurface
spectroscopy_at_positions SpectroscopyAtPositions        — 同 §4
sts_condition_series      STSConditionSeries             — 同 §4
survey_surface            SurveySurface_TileScan
verify_atomic_resolution  VerifyAtomicResolution
```

### paper：18 个技能 / 9 个模块

```text
autonomous        AtomManip_SAC  AutoOSS_Dehalogenation  AutonomousSurvey_Scanbot
                  ConditionTip_DQN  ContinuousImaging_Auto
                  FindGoodRegion_Heuristic  FindGoodRegion_UNet
                  其中六个依赖 composite 的 AssessImageQuality / ConditionTip
defect_cluster    ClusterDefects_rVAE            — 分解／聚类子系统
drift_bragg       CorrectDrift_BraggPeak
line_check        CheckLineQuality               — 一维相关判据，见 §6
montage           ComposePanelMontage            — 迁移判据层，排除呈现层
optimization      AdaptiveSTS_GP  OptimizeResolution_BO  — GP 子系统
spectral_analysis FitFano_Kondo  FitGap_BCS       — 前者排除 hurwitz 分支；后者需要 bounds
spectral_unmix    UnmixSpectra                   — 分解子系统
tip_assessment    AssessTip_ResNet  AssessTip_VGG — 参考 execute 在归一化名称后相同，可复用实现
```

`AssessTip_ResNet` 和 `AssessTip_VGG` 按两个接口计数。盘点记录的实现并无对应的 VGG / ResNet 网络，不应由技能名称推断已具备深模型能力。

## 2. 贵金属针尖流程：先补非技能依赖

按 [依赖闭包金样](../spec/golden/tip_phase_deps.json) 与 [7b-1 交接](handoff/batch-7b-1.md)，`composite.prepare_noble_tip` 的三个技能已没有未迁移的子技能依赖，但仍有非技能组件需要实现：

| 组件 | 用途与依据 |
|---|---|
| `core.map_scope.record_damage_marker`（写侧） | `pulse_phase` 在每次脉冲前记录落点，后续 `nearest_clean_from` 据此避让；[map-scope.ts](../packages/host/kernel/src/map-scope.ts) 与偏差 `D-MAP-2` 保留该缺项 |
| `core.noble_tip_workflow.resolve` / `reconcile_with_tip_envelope` | 流程配置与针尖安全包络协调；历史盘点记录了对应流程表 |

写侧的坐标、记录时序和失败处理会影响后续避让，需与参考行为逐项对照。读侧 `crashMemoryMarkers` 的 fail-open 行为记录在 [偏差登记](../spec/deviations.md) 的 `D-MAP-5`；不要据此推断写侧应采用相同策略。有意修正参考缺陷仍按完成定义登记。

六条 `_tip_phases` 流程尚无可用的完整参考执行轨迹。可先为 `plan_dynamic` 编写受控 executor，导出 `CompositeStep` 序列；这份计划层证据不能替代仪器执行验收。共同驱动方案应在迁移第一条流程前确定。

## 3. `AssessShockleyOnset`：成功路径需要单独定义证据

历史参考快照的 `tip_spectro_assess.py:236–237` 在成功返回时使用 `extra_reasons` / `extra_warnings`，但赋值只出现在另一类 `AssessAtomicPhase.execute` 中。因此，盘点中该成功路径抛出 `NameError`。依据见 [blockers-7a](handoff/blockers-7a.md) §4.2 和 [偏差登记](../spec/deviations.md) 的 `D-EXTRA-SPLIT-1`。

现有偏差已处理 `AssessAtomicPhase` 的不完整帧原因、警告与 summary，不能直接当作 `AssessShockleyOnset` 成功路径已完成验收。迁移前需核对该登记，明确预期成功行为的独立依据以及它对 `MakeSpectroscopyTip` 的影响。

保留参考可达的失败证据。若新增修复后的成功用例，应标明修复依据与偏差；不能用迁移端自行生成的期望值充当参考实现成功运行的结果。

## 4. 三个 STS 技能：参考默认配置的采集路径不可达

历史盘点记录 `sts_workflow.py:251` 的 `CONDITIONS` 只有一个组，四项样品事实均为 `None`，使 `usable` 为 `False`。涉及 `LineSTSAcrossWall`、`SpectroscopyAtPositions`、`STSConditionSeries`。

在这一参考配置下，应验证拒绝条件与输出，不能把构造的成功采集路径称为参考运行结果。若后续支持新的配置，需要另外提供来源与验收依据。

## 5. `ScanPublicationFrame`：生产与消费字段不匹配

参考快照中的生产方与消费方使用了不同字段：

```text
atomic_lattice.py:203–206  → { "passed_forward": …, "passed_backward": … }
publication_frame.py:211 → v.get("passed")
```

生产方没有 `passed` 字段，消费方默认得到 `None` 并拒绝。[analysis-lattice.ts](../packages/host/stm-skills/src/l0/analysis-lattice.ts) 已迁移生产方接口；迁移消费方时应明确修复语义，并在偏差登记中写出判断依据及重新考虑所需的证据。

## 6. `CheckLineQuality`：一维相关判据与直流偏置

盘点中的 `trace_retrace_correlation`（`mast/vision/tip_metrics.py:241`）二维分支转发给已迁移的 `fwdBwdInstability`；剩余工作主要是一维分支。函数名未出现在本仓不代表其全部数值基础都缺失。

盘点引用的参考记录说明了一个必须保留的判据：直接对绝对高度计算余弦相似度时，约 1 nm 的正常 Z 工作点偏置可能主导结果。在阈值 0.80 下，原记录为：

| 输入情形 | 未去均值的相关值 | 结果 |
|---|---|---|
| 两条独立噪声线 | 0.9999 | 通过 |
| 完全反相 | 0.9609 | 通过 |
| 无有效起伏的平坦帧 | 1.0000 | 通过 |

原记录中，前两种情形去均值后的结果分别为 0.013 与 −1.0。以上数字是历史参考记录，本次未重跑，也不将其中的真实观测改称合成数据。迁移时需用明确来源的样例覆盖独立噪声、反相和平坦输入，确认直流偏置不会掩盖失效情形。

## 7. 迁移工作流程

完整约定见 [AGENTS](../AGENTS.md) 和 [开发指南](DEVELOPMENT.md)。每项迁移应包括：

1. 分别记录子技能依赖和非技能组件；同时追踪 `context.run(...)` 与 `CompositeStep(skill_name=...)`，求传递闭包并声明无法静态解析的范围。
2. 并行开发前划分文件职责，在共享文件中约定锚点与落点，按开发指南保留隔离行。
3. 编写参考导出器，隔离运行目录、确认参考仓只读；同条件导出两次并比较完整字节。随后实现、测试并运行对应变异演练。
4. 依次执行 `pnpm gen:skills` → `pnpm build` → `pnpm gen:progress`。
5. 交接记录写明范围、与原计划的差异、证据来源、验收结果和未完成事项。
6. 整合后重跑受影响的本批变异。需保存的日志先检查公开内容，再确认被 Git 跟踪；忽略规则不能代替这一检查。
7. 并行支线偏差编号留 `?`，整合时统一编号并逐条按上下文更新引用。

## 8. 参考资料

- [builtins 盘点](handoff/survey7-builtins.md)、[composite 盘点](handoff/survey7-composite.md)、[paper 盘点](handoff/survey7-paper.md)：历史依赖分析与工作量估计。
- [针尖链阻塞分析](handoff/blockers-7a.md)：函数级依赖闭包及分析边界。
- [未检出变异分析](handoff/green-8.md)：幸存变异的输入、断言和测试范围问题。
- [偏差登记](../spec/deviations.md)：参考差异、理由与重新考虑条件。
- [实施日志](EXECUTION.md)：按时间记录的工作与验证结果。
