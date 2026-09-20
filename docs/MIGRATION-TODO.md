# 技能迁移还差什么

> 写于 2026-09-20。**发布不等这份文件**（见 `RELEASE-TODO.md`）。
> 这份写给之后接着移的人/智能体：还剩多少、分几档、从哪批开始、每批怎么验收。

---

## 0. 分母：515 到不了

| | 今天 | **可达上限** | 还差 |
|---|---|---|---|
| 技能 | 442 / 515 | **502** | **60** |
| 模块整模块收口 | 112 / 165 | **160** | **48** |

**13 个技能永远不移**（三份盘点点名的 D 档，架构上就不要）：

| 谁 | 几个 | 为什么 |
|---|---|---|
| `builtins.optics_stage` | 8 | 光学台一族，压着本仓不要的驱动层 |
| `builtins.optics_scan` | 1 | 同上（同模块另一个 `AcquireSignalPoint` **已落**，所以这个模块**永远到不了 complete**） |
| `builtins.optics_pump_probe` | 1 | 同上 |
| `paper.imspec / region_analysis` 三个深模型技能 | 3 | `PredictSpectrumFromTopo` · `PredictStructure_ASD` · `IdentifyTopology_CARP`：`model_path` **`required=True`**、`execute` 直接取、纯 torch、**零回退**。给不出模型就没有这个技能 |

⇒ **5 个模块永远 complete 不了**（上面三个 + `paper.imspec` + `paper.region_analysis`）。
报进度时用 **502 / 160** 做分母，不要用 515 / 165。

⚠️ `ComposePanelMontage` 是「半个」：**判据层是 A 档要移**，呈现层（matplotlib）是 D 档不移。
全族 matplotlib **只压在这一个技能身上**，切法本仓做过一次（`scan-prep-skills.ts:26-33`）。

---

## 1. 剩下的 60 个，按族

盘点报告在 `docs/handoff/survey7-{builtins,composite,paper}.md`（三份，共约 1600 行，
含逐条依赖、行数、与现状不符的 40 余条）。**⚠️ 那三份是 2026-09-20 的快照** ——
开工前先用 `spec/progress.json` 重算一遍分母，不要在那三份上打勾。

### builtins —— 19 个 / 19 个模块（**一个模块一个技能，落一个清一个**）

```
atomic_lattice            CalibratePiezoFromLattice      ← 要 3×3 非线性求根器（顶 fsolve）
atomic_multiframe         CalibratePiezoMultiAngle       ← 同上，两个共用 solve_affine 96 行
best_frame                TrackBestFrame                 ← 只差 DEFAULT_MIN_CONCENTRATION=300.0 的单一真源
characterise_noise        CharacteriseCurrentNoise       ← 含循环变量的动态 context.run，闭包追不动
coarse_selfcheck          CoarseMotionSelfCheck          ← C→A：缺的 693 行贡献 0 条判据
dispersion_fit            FitDispersion                  ← 要 curveFit 的 box bounds + scipy.special.j0
domain_assess             AssessDomainPhase              ← 参照系目录旧仓里根本不存在，207 行可整块推迟
envelope_reconcile_skill  ReconcileSafetyEnvelope        ← ⚠️ :194-198 fail-open，必须改
feedback_tracking         AssessFeedbackTracking
frame_drift_skill         MeasureFrameDrift              ← 要 FFT 线性（零填充）二维互相关 mode='full'
hardware_events           ReadHardwareEvents             ← ⚠️ :67-72 把「读不到闸门」显示成「无拦截」
herringbone_assess        AssessHerringbone
history_query             QueryMonitorHistory            ← ⚠️ :226 调不存在的 store.sensors()
quiet_drift               CharacteriseQuietDrift
scan_intel_selfcheck      ScanIntelSelfCheck             ← 差 scan_resolver.preview 27 行；⚠️ 三处会说假话
slow_drift_skill          AnalyseSlowDrift
spectral_peaks            FindSpectralPeaks              ← 要 curveFit 的 pcov
spectrum_assess           AssessSpectrum
tip_spectro_assess        AssessShockleyOnset            ← ⚠️ 见 §3
```

### composite —— 23 个 / 20 个模块（**C 档大头在这里**）

```
achieve_atomic            AchieveAtomicResolution
angle_series_calibration  AcquireAngleSeriesForCalibration
assess_quality            AssessImageQuality             ← 去重后解 6 个下游，回报最高
atomic_bias_series        AtomicBiasSeries
condition_tip             ConditionTip                   ← 与 AssessImageQuality 一起卡着 6 个 autonomous
cross_point_tip_check     CrossPointTipCheck
execute_scan_plan         ExecuteScanPlan
forge_au_tip              ForgeAuTip                     ← 差 PreScanCheck
line_sts_across_wall      LineSTSAcrossWall              ← ⚠️ 采集路径旧仓出厂就不可达，见 §4
make_special_tip          MakeAtomicResolutionTip  MakeSpectroscopyTip   ← 后者差 AssessShockleyOnset
prepare_noble_tip         PokeConditionTip  PrepareNobleTip  PulseConditionTip   ← 见 §2
prescan_check             PreScanCheck                   ← 解 2 条流程；差 safe_mode_active 等四件
publication_frame         ScanPublicationFrame           ← ⚠️ 默认参数下**永远拒跑**，见 §5
scan_until_atomic         ScanUntilAtomicResolution
search_domain_boundary    SearchDomainBoundary           ← 有三块可整段不移（聚类 150 · marker 重放 145 · cross_site_downgrade 25 本文件内零调用）
shape_tip_on_surface      ShapeTipOnSurface
spectroscopy_at_positions SpectroscopyAtPositions        ← ⚠️ 同 §4
sts_condition_series      STSConditionSeries             ← ⚠️ 同 §4
survey_surface            SurveySurface_TileScan
verify_atomic_resolution  VerifyAtomicResolution
```

### paper —— 18 个 / 9 个模块

```
autonomous        AtomManip_SAC  AutoOSS_Dehalogenation  AutonomousSurvey_Scanbot
                  ConditionTip_DQN  ContinuousImaging_Auto
                  FindGoodRegion_Heuristic  FindGoodRegion_UNet
                  ↑ 其中 6 个卡在 composite 的 AssessImageQuality / ConditionTip 上
defect_cluster    ClusterDefects_rVAE            ← C 档
drift_bragg       CorrectDrift_BraggPeak
line_check        CheckLineQuality               ← 只差一维支 ~30 行，见 §6
montage           ComposePanelMontage            ← 判据层 A，呈现层 D
optimization      AdaptiveSTS_GP  OptimizeResolution_BO   ← C 档
spectral_analysis FitFano_Kondo（砍 hurwitz，A） FitGap_BCS（要 bounds）
spectral_unmix    UnmixSpectra                   ← C 档
tip_assessment    AssessTip_ResNet  AssessTip_VGG
                  ↑ ⚠️ 两者 execute **归一化名字后逐字节相同**（旧仓自己写着
                    「名字里的 VGG / ResNet 在代码里没有对应物」）。算两个，成本是一个
```

---

## 2. 下一批就做这个：贵金属链（已经准备好了）

`composite.prepare_noble_tip` 三个技能的**技能**封锁件按闭包算**已经空了**（7b-1 查实）。
两条流程仍移不了，**缺的不是技能，是两笔非技能的债**：

| 欠的 | 出处 |
|---|---|
| `core.map_scope.record_damage_marker`（**写侧**） | 批 7a-2 自己点名的欠账，`map-scope.ts:27` 原话「第一个要写标记的技能落地时，它必须和那个技能同批」—— 而 `pulse_phase` **正是那第一个**（每一发脉冲**打之前**就标记落点） |
| `core.noble_tip_workflow.{resolve, reconcile_with_tip_envelope}` | 1273 行流程表 |

⚠️ **写侧是安全侧的东西**：`record_damage_marker` 记「这里被打过 / 撞过」，
下游 `nearest_clean_from` 靠它避让。**写错一个坐标 = 让下一次脉冲打在旧坑上。**
fail-open 还是 fail-closed 必须与旧仓一字不差；读侧的对照物是 `crashMemoryMarkers`（D-MAP-5，fail-open）。

⚠️ **六条流程一格轨迹金样都录不到**（`batch-7b-1.md` §6.4）。但 `plan_dynamic` 是生成器，
**可以**用假 executor 把 `CompositeStep` 序列录成金样 —— 那是一台新驱动器、六条共用，
**该在落第一条之前定下来**。

---

## 3. 一个还没答的问题：`AssessShockleyOnset`

它在旧仓**每条成功路径都炸 `NameError`**：`tip_spectro_assess.py:236-237` 用的
`extra_reasons` / `extra_warnings`，**全文件只在 `:405` 赋值，而那在 `AssessAtomicPhase.execute` 里**
（另一个类）。见 `blockers-7a.md` §4.2。

7b-1 已为此登记 **`D-EXTRA-SPLIT-1`**（「一个用而未赋值，一个赋值而未用」，本仓接回来）。
**开工前先读那条登记** —— 如果它已经把语义定下来了，就落；没定就先答这个：

> 它挡着 `MakeSpectroscopyTip`。**它在旧仓从来没有成功过**，所以那条流程的「成功端」
> 在规格书里是空的。那条流程的验收，验的是它**拒绝得对**，还是它**采到了什么**？

**不要自己发明一个成功路径。** 造不出「成功」那一格金样时，
拿自己写的驱动器声称成功，**等于拿自己写的脚本给自己发证**。

---

## 4. 三个 STS 技能：采集路径旧仓出厂就不可达

`sts_workflow.py:251` 的 `CONDITIONS` 只有一个组、四个样品事实全 `None` ⇒ `usable` 恒 `False`。
涉及 `LineSTSAcrossWall` / `SpectroscopyAtPositions` / `STSConditionSeries`（**只有这三个**）。

⇒ **验收标准是「拒绝得对不对」，不是「采到了几条谱」。**
造金样时别去造一格「采成功」的 —— 那一格在旧仓里造不出来。

---

## 5. `ScanPublicationFrame` 默认参数下**永远拒跑**

```
生产方 atomic_lattice.py:203-206  →  { "passed_forward": …, "passed_backward": … }
消费方 publication_frame.py:211   →  v.get("passed")        ← 这个键从来不存在
```

裸 `"passed"` 在生产方全文件**零命中** ⇒ `bool(None)` 恒 `False` ⇒ **恒拒**。
本仓 `analysis-lattice.ts:558-575` 已经把生产方那侧移**对**了 ——
所以**照抄消费方会把 bug 搬过来**。按 DoD ⑤ 不照抄，并写清「改它需要什么证据」。

---

## 6. `CheckLineQuality`：别被 75 行吓住

`trace_retrace_correlation`（`mast/vision/tip_metrics.py:241`，75 行）**本仓源码零命中**，
但它的**二维支只有一句转发**，转给已经落了的 `fwdBwdInstability`。
**真要写的是一维支，约 30 行。** 零命中说的是名字，不是工作量。

⚠️ 而它的 docstring 里有一段**必须钉进金样**的物理：在这个函数存在之前，
`PreScanCheck` 与 `CheckLineQuality` 都在**绝对高度**上算余弦相似度，
带一个正常的 Z 工作点偏置（~1 nm）时那个数被**直流项统治**。阈值 0.80 下实测：

```
两条完全独立的噪声线   → 0.9999  通过
完全反相（最坏的针尖） → 0.9609  通过
死平废帧               → 1.0000  通过（六帧真数据里的最高分）
```

**那道阈值是装饰性的：验证相在它最该失败的方向上不可能失败。**
减掉均值后同一批是 0.013 / −1.0。**这三格不进金样，本仓就会把同一道装饰性的闸原样搬过来。**

---

## 7. 每一批怎么做

完整规矩在 `AGENTS.md`。一批的骨架：

1. **盘依赖，分两栏**：上游有什么（追 `context.run` **与** `CompositeStep(skill_name=…)`
   两条边到不动点）/ **本仓要先长出什么**（读旧仓注释里那些「必须」「也不例外」）。
   清单要附一句**追到哪儿为止**，写不出这句话的清单按未完成算。
2. **先落锚点再分叉**（九个共享文件，见 `AGENTS.md` §5）。
3. 写导出器 → 导金样 → **跑两遍 `cmp`** → 写实现 → 写测试 → 写变异 → 跑演练。
4. `gen:skills` → `tsc -b` → `gen:progress`（**顺序不能反**）。
5. 交接写 `docs/handoff/batch-<批号>.md`，**「与任务书不一样的地方」单列一节**
   —— 前面每一批都有，如实写；那一节往往比主体值钱。
6. 合并后**重跑本批变异**（合并正是闸会静默坏掉的那一刻），日志 `git add -f` 并用
   `git ls-files` 验过入仓。
7. 偏差编号支线留 `?`，主线统一编；一族多号时引用**逐条按上下文映射**。

---

## 8. 参考

- `docs/handoff/survey7-builtins.md` · `survey7-composite.md` · `survey7-paper.md` —— 三份分族盘点
- `docs/handoff/blockers-7a.md` —— 针尖链的函数级闭包与「一层不是闭包」四例
- `docs/handoff/green-8.md` —— 变异跑成绿的三种形状与各自的修法
- `spec/deviations.md` —— 228 条偏差登记
- `docs/EXECUTION.md` §1 —— 实施日志（最近几轮的教训都在这儿）
