# 剩余 186 个技能的依赖盘点

盘的是 `spec/progress.json` 里 `status != "done"` 的那 **186** 个，分布在 **115** 个模块。
判据是**函数级**的：看 `execute` / `validate_params` 实际调到哪些旧仓函数，那些函数各自
又要什么，一路追到底 —— 不是看 import 行，也不是看文件名。

这条纪律是上一轮两次相反的错换来的。批 3i 把 `optics_stage` 当技能层移（安全论证整个
住在驱动层）；批 3j 的分派单写着 `tip_shaper_readback` 被针尖登记表挡住（它只用
`_tip_policy` 里两个自成一体的函数）。**两次错的根都是拿文件当依赖单位。**

---

## 一页纸总表

> 这张表是给分派用的。**按模块级完成切支线** —— 一个半完成的模块在进度表上没有意义。

### A 档 —— 依赖全在本仓（81 个技能 / 40 个模块）

| # | 模块 | 技能数 | 落地成本（要自己写的那部分） |
|---|---|---|---|
| A1 | `builtins.spectroscopy` | **37** | 28 纯线缆 + 3 确定性拒绝桩 + 6 个借已有件；`_reshape_spectrum` 用 `matOf`+`matRow` |
| A2 | `composite.scan_at` | 1 | `core/scan_resolver.py:resolve_scan` **329 代码行**（纯函数，无外部子系统） |
| A3 | `builtins.cluster_extract` | 1 | `parse_xy_meta`48 + `px_to_m`46 + `acquired_row_mask`77 + `assess_mask` 一族 101 |
| A4 | `builtins.cluster_roundness` | 1 | 同上 + `find_objects` 等价（记 bbox，十行级）+ `histogram` 自算 range |
| A5 | `builtins.cluster_select` | 1 | 只要 `parseQuantity`（本仓已有）+ ExtractClusters |
| A6 | `builtins.adatom_verify` | 1 | 只要 ExtractClusters；`resolve_substrate` 是容差兜底，降级成 `no_tolerance` |
| A7 | `builtins.step_height` | 1 | K2 平面族 113 行 |
| A8 | `builtins.frame_trust` | 1 | K2 平面族 113 行（与 A7 共用） |
| A9 | `builtins.step_edge` | 1 | `vision/step_edge.py` 179 行全自足 + 2×2 TLS 约 15 行 |
| A10 | `builtins.scan_texture` | 1 | K1 晶格峰 236 行 + `frame_texture` 442 + `measure_cell` 链，**全纯 numpy** |
| A11 | `builtins.lattice_cell_skill` | 1 | 与 A10 共用 `measure_cell`，移一次解锁两个 |
| A12 | `builtins.atomic_lines` | 1 | `vision/atomic_lines.py` 202 行全自足 |
| A13 | `builtins.frame_corrugation` | 1 | `corrugation_gate` 259（零 numpy）+ `scan_prep_thresholds` 489 阈值表 |
| A14 | `builtins.frame_drift_skill` | 1 | `frame_drift.py` 319 纯 numpy + full-mode 2-D 相关约 30 行 |
| A15 | `builtins.tip_sharpness` | 1 | `tip_metrics` 三个判据函数（24+46+19）+ `_detrend` 8 |
| A16 | `builtins.tip_from_spectrum` | 1 | `assess_iv` 76 + `assess_iz` 41，**零 scipy** |
| A17 | `builtins.spectrum_assess` | 1 | 谱质量一族约 470 行纯 numpy |
| A18 | `builtins.force_inversion` | 1 | Sader–Jarvis 27 行手写求积；savgol 只在可选参数那条路上 |
| A19 | `builtins.tip_shaper` | 1 | 照孪生兄弟 `TipShapeWithReadback` 同一条线，走 D-TIP-1 |
| A20 | `builtins.saturation_recovery` | 1 | 四个子技能全已移，零数值依赖 |
| A21 | `builtins.acquire_psd` | 1 | 8 个动词齐；`DataGet` 的补丁 `methods.ts:588` 已带 |
| A22 | `builtins.current_monitor` | 1 | 一个 `Current_Get` 轮询循环，零 numpy |
| A23 | `builtins.current_origin` | 1 | 判别表全在文件里；五个 `context.run` 全已移且数据键逐字对上 |
| A24 | `builtins.monitor_current_fft` | 1 | `fft.ts` 收任意长度（Bluestein）；`rfft`/`rfftfreq`/窗都是十行 |
| A25 | `builtins.pattern`（RunGridExperiment） | 1 | 多要的唯一一件是动态计划，`runPlan(AsyncIterable)` 已有 |
| A26 | `builtins.scan_watch` | 1 | `_scan_readout.py` 143 行 + `usable_rows` 15 行 |
| A27 | `builtins.thermal_settle` | 1 | `GetTemperature` 已移且键就是 `value_k`；`polyfit(1)` 五行 |
| A28 | `builtins.scan_frame`（2/3） | 2 | LoadScanFrameFromFile（`encodeNpyFrame` 已有）· ParseRegions（零依赖） |
| A29 | `builtins.optics_scan`（1/2） | 1 | AcquireSignalPoint：`optics_acquire` 约 168 行纯逻辑，**从不碰 registry** |
| A30 | `composite.bias_settle` | 1 | 零旧仓函数，阈值常量全在文件里 |
| A31 | `composite.batch_regions_scan` | 1 | 5 个子技能全已移；唯一未移的那步默认不进计划且 optional |
| A32 | `composite.tip_pulse` | 1 | 2/2 子技能已移；D-TIP-1 走既有先例 |
| A33 | `paper.background` | 1 | 张量积设计阵自搭（**别用 `fitPoly2d`**，它是固定二阶 6 项） |
| A34 | `paper.image_filters` | 1 | 名字里的 MorphOpen 是手写一维行程开运算，**别用 `greyOpening`** |
| A35 | `paper.scan_crop` | 1 | 全部 `median`/`ptp`/`mean` |
| A36 | `paper.denoise` | 1 | 可达路径就是 `gaussianFilter2d` |
| A37 | `paper.atom_jump` | 1 | 两段均值差；缺口只是 `load_spectrum` 的 `.txt/.csv/.asc/.npz` 分支 |
| A38 | `paper.data_processing`（3/4） | 3 | RANSAC / LevelLines / FindEmptySpot |
| A39 | `paper.region_analysis`（2/4） | 2 | 两条经典回退路径（分位阈值 · `greyDilation`+`labelConnected`） |
| A40 | `paper.autonomous`（1/7） | 1 | AtomManip_SAC：三个子技能全已移，无模型时是直线行走 |

### B 档 —— 差一件具体的东西（48 个技能 / 43 个条目）

**按「一件解锁几个」排的缺件表** —— 这张表比按模块排的有用得多：

| 缺的那一件 | 在哪 | 规模 | 解锁 |
|---|---|---|---|
| **`scipy.signal.find_peaks`（带 prominence）** | 消费者是 `vision/seg_scale_adaptive.py:_band_peak` 141-164 | **24 行**（+ `_hist_modes` 32） | **7 个**：AnalyseAtomicLattice · AssessAtomicResolution · AssessAtomicConsistency · AssessHerringbone · AssessDomainPhase · FindFlatRegion · AssessAtomicPhase |
| **`core/tip_crash_tracker.py`** | 纯 stdlib，无 numpy 无 vision | **250 行** | **3 个直接 + 2 个链上**：FullScan · ConditionTip · PreScanCheck（→ 再带 TrackDrift / CrossPointTipCheck） |
| **`composite/_z_settle.py`** | 只要 `ctx.safe_call` + 6 个配置读口 | **402 行**（285 代码行） | **2 个**：RetractForSampleChange · RelocateCoarseXY（**必须同批**，分开等于搬两次） |
| **`curveFit` 回 `pcov`** | LM 收敛后 `(JᵀJ)⁻¹·sse/(n−p)`，J 已在循环里算过 | **20–30 行** | **3 个**：FitFano_Kondo · FitGap_BCS（另需 bounds）· FindSpectralPeaks（另需 find_peaks+savgol） |
| **非归一化互相关 + `error`/`phase` + hanning** | `fft.ts` 的 `crossPowerSpectrum` 除法做成可关 | **约 20 行** | **2 个**：CorrectDrift_XCorr · DiffScans_ChangeDetect |
| **`core/safety.ts` 侧 `safe_mode_active` 预言机** | `core/operating_mode.py:91-96` | 6 行 + 接线 | **3 个**：AssessTip_VGG · AssessTip_ResNet · CheckLineQuality |
| **`vision/frame_validity`(275) + `tip_metrics` 三函数(144)** | 纯 numpy，自成一体 | **≈420 行** | **2 个**：PreScanCheck · CheckLineQuality（后者再加 `correlate(full)`） |
| **`AcquireSTS` + `ConfigureSTS`** | `builtins/spectroscopy.py` 231-482 | **251 行** | **2 个**：GridSTS · DemoScanAndSTS（除此之外零缺口） |
| **`SafeCall` 的 per-call recv 超时** | `kernel/src/skill-kernel.ts:102`，参照 `core/connection.py:200-243` | 一行类型 + ~44 行 | **1 个但要紧**：AcquireSTS —— 它是 38 个里唯一不是 A 的那个 |
| **2-D `correlate2d(mode='same')`** | 本仓有 `correlate1d` 与 `phaseCrossCorrelation`，**都不能顶替** | 约 25 行 | **2 个**：ComputeDriftVector · TrackDrift_ReferenceScan |
| `vision/tilt.py:fit_circle_tilt` + `CircleTilt` | 一次 3~4 列最小二乘 | **156 行 / 765** | TiltProbeCircle（**不牵扯 vision 其余部分**） |
| `vision/feedback_lag.py:measure_feedback_lag` | 纯 numpy，零 scipy | **206 行 / 295** | AssessFeedbackTracking |
| `vision/slow_drift.py` | 纯 numpy，grep scipy = 0 | **357 行** | AnalyseSlowDrift |
| `core/coarse_drive.py` | 纯 python，一张 `_SPEC` 表 | **346 行** | RelocateCoarseXY（与 `_z_settle` 同批） |
| `lattice_calibration.py:solve_affine` | `scipy.optimize.fsolve` 多分支求根 | **98 行** | CalibratePiezoFromLattice · CalibratePiezoMultiAngle |
| `seg_scale_adaptive:segment_scale_adaptive` | skimage disk/otsu/tophat | **210 + 40 行** | AnalyzeFrameTilt |
| `fftconvolve2d(a,b,'same')` | 补零 + 逐点复乘 + `ifft2` | **40–60 行** | DeconvolveTip_RL |
| `mapCoordinates` 扩到 `order=3` + `spline_filter` | `interpolate.ts:87` 现在是 `0 \| 1` | 最大的一件 | CorrectDrift_BraggPeak（**放最后**） |
| `gated-call.ts` 的 `allowOnAbort` 逃生口 | 全文 48 行，`Bias_Set` 不在 `ABORT_SAFE_WRITES` | 一个参数 | BiasWiggle |
| `core/coord_epoch.py` | 纯 dataclass | **154 行** | ExecuteScanPlan |
| `data/quality.py` + `angular_concentration` 一族 | **43 + 102 行**（scipy 那两行是死 import） | 145 行 | AssessImageQuality → 再带 SurveySurface · ConditionTip · BatchRegionsScan |
| `scipy.special.digamma` | 只为 hurwitz_fano 那一支 | 约 40 行 | FitFano_Kondo 的第三支（可推迟，三选一） |
| `curveFit` box bounds（trf） | scipy 给 bounds 就从 lm 切 trf，**不是加 clamp** | — | FitGap_BCS · FitDispersion · AssessShockleyOnset |
| **晶格判据底座**（见 §3.3） | `atomic_phase` 判据环 508 + K1 236 + `seg_scale_adaptive` 切片 | **≈950 行纯 numpy** | AssessAtomicPhase 及全部「原子分辨判定」链 |

余下的 B 是**差一个未移技能**（依赖链，不是缺件）：MeasureBarrierHeight/MapBarrierHeight/CleanTipUntilBarrier ← STS 四件套；AcquireBiasSeries/CalibrateCoarseStep ← ScanAt；StepCoarseXY ← RelocateCoarseXY；AcquireBiasImagingSeries/AcquireAngleSeriesForCalibration ← FullScan；AcquireDeltaFCurve ← `_reshape_spectrum`(53)。

### C 档 —— 压着一整个子系统（49 个技能）

| 子系统 | 行数 | 被它压住的技能 | 只移技能层的具体后果 |
|---|---|---|---|
| **`mast/instruments/` 运动/光学驱动层** | 2367（最省 1391）+ pyserial/ctypes/pythonnet | `optics_stage` **8** · OpticalStageScan · PumpProbeScan = **10** | 屏障是 `instruments/base.py:215-221` 的 `_check_limits`（7 行）。不搬它，`_fail()` 翻译的四个异常没人抛，模块文档那句「即使参数是幻觉也越不过限位」当场变假话；`OpticalStageWiggle` 的反向逻辑靠 `except TravelLimitError`，连语义都不成立 |
| **`mast/monitoring/` + `envhistory/`** | store 2107 + baseline 994 + features 706 + aux_channels 2257 + pump 1450 | CharacteriseCurrentNoise · QueryMonitorHistory · CharacteriseQuietDrift · ReadHardwareEvents = **4** | 数据**不经技能自己的 TCP** —— 来自监控泵写进库的段。泵不在，`len(runs) < 5` 永远返回「取到 0 段」。ReadHardwareEvents 一次硬件都不调，是个永久失明的窗口 |
| **`core/instrument_profile.py` 仪器档案** | **1237**（单文件，零硬件） | ReadCalibrations · AutoTilt · TiltCalibrate（+ 三个自检各一层）= **3** | ReadCalibrations 的全部价值是**区分两种否定**（「从未标定过」vs「读不到档案」），没有存储就永远只会说后者。AutoTilt 读不到标定直接拒跑，TiltCalibrate 算完 `G=−M⁻¹` 无处可写 |
| **实验地图 / 标记** | `map_scope` 322 + `io/map_analysis` 1206 + `io/exp_map` 1015 + `io/coarse_map` 604 | FindCleanSpot · SearchDomainBoundary（另压 vision）· CoarseMotionSelfCheck = **3** | `map_known` 恒 False。2026-08-16 真机上这条链断掉的症状是**第二轮把第一轮的坑原路重打了一遍**，没有任何一处报错。写侧 `record_damage_marker` 必须同批 |
| **针尖登记表 + 特异化工作流** | `tip_state` 441 + `tip_conditioning_resolver` 221 + `tip_conditioning_policy` 368 + `noble_tip_workflow` 1273 + `special_tip_workflow` 410 | 见下面 `_tip_phases` 一行 | 第二层安全屏障（按登记针尖查 `max_abs_pulse_v`/`max_poke_depth_m`，**超上限拒绝、不夹紧**）整个不在 |
| **`composite/_tip_phases.py`** | **2801 行 / 1664 代码行** | PrepareNobleTip · PokeConditionTip · PulseConditionTip · MakeAtomicResolutionTip · MakeSpectroscopyTip · ForgeAuTip = **6** | `poke_phase` 每次扎针后要 `AssessClusterRoundness` 判成没成。判据缺席时它只会扎满 `max_rounds` 然后报 not_refined ——**一个只会消耗针尖、永远不会成功的流程** |
| **`mast/vision/` 的 scan_prep 链** | 855 + 489 + 817 + tip_change/scan_artifacts ≈ 2800 | AnalyzeScanImage · AutoProcessScanBatch · VerifyAtomicResolution = **3** | `FrameMetrics` 每个字段都是判据本体，技能层只做读文件拼表。移了壳就是一张空表 |
| **`mast/vision/` 的谱判据** | `vision/spectroscopy.py` **954** | SpectroscopyAtPositions · STSConditionSeries = **2** | 整批 dI/dV 会在 `unrated` 上跑完，而「连续 N 条 discard 就停批」这条保护静默失效 |
| **`mast/vision/` 的畴/平区/团簇判据** | domain_phase 915 + flat_region 链 + roundness 359 | ShapeTipOnSurface · MoveAtomTo · ScanUntilAtomicResolution · ScanPublicationFrame = **4** | ScanPublicationFrame 的全部立论是「入口闸：花几分钟去验，而不是拿一小时去赌」，判据缺席时它就是一小时的赌 |
| **多个未移技能叠加**（阶梯本身） | — | AchieveAtomicResolution · AtomicBiasSeries · CrossPointTipCheck · LineSTSAcrossWall · autonomous 的 6 个 = **11** | AchieveAtomicResolution 的 9 个子技能只移了 1 个，移了它 = 一个每一档都调不到的 for 循环 |
| `core/envelope_reconcile.py` + `admin/override_store.py` | 495 + 555 | ReconcileSafetyEnvelope = **1** | 「拒绝放宽、只按幅度收紧」这条安全论证没有东西可作用，`apply` 变成报告 `applied: True` 的空动作 |
| 多子系统叠加（自检） | registry 548 + 上述数项 | ScanIntelSelfCheck · TipConditioningSelfCheck · TipForgeSelfCheck = **3**（见 §4） | 两个是 **fail-open**，会打出「✅ 可以开工」 |

### D 档 —— 压着的东西本仓架构原则上就不要（8 个技能）

**这一档与 C 性质不同：C 是「等子系统移过来」，D 是「等不来」。分派时不该进队列。**

| 技能 | 压着 | 为什么不是 C |
|---|---|---|
| PredictSpectrumFromTopo | `torch.jit`，`model_path` **required 且无回退** | 移过来是永远报错的壳 |
| PredictStructure_ASD | `torch` + registry，同上 | 同上 |
| IdentifyTopology_CARP | **`detectron2`** | 旧仓自带的 `pyruntime` 里都没装 |
| ClusterDefects_rVAE | sklearn PCA + KMeans + silhouette | **默认路径就是 sklearn**，无 numpy 路 |
| UnmixSpectra | sklearn NMF/PCA/FastICA/GMM | 四支全是 |
| OptimizeResolution_BO | sklearn GP(Matern) + `scipy.stats.norm` | GP 超参优化不是几十行；还叠着 2 个未移技能 |
| AdaptiveSTS_GP | sklearn GP(RBF) 或 torch+gpytorch | 同上；还叠着 3 个未移技能 |
| ComposePanelMontage | matplotlib(Agg) 渲染栈，产物是 PNG | 本仓没有、也不该有 matplotlib 等价物 |

### 总计

| 档 | 技能数 | 占比 |
|---|---|---|
| **A** 现在就能落 | **81** | 44% |
| **B** 差一件具体的东西 | **48** | 26% |
| **C** 压着一整个子系统 | **49** | 26% |
| **D** 架构原则上不要 | **8** | 4% |
| 合计 | **186** | |

---

## 二、A 档的分批边界与优先级

**按模块级完成切。** A 档的 81 个里，有 **35 个模块**的全部剩余技能都是 A —— 落完这些，
`modules_complete` 从 50 直接到 85（共 165）。另有 3 个模块**只差一件小东西就能整模块清零**，
值得把那件东西并进同一批。

### 优先级 1：`builtins.spectroscopy` —— 37（+1）个技能，一批清掉剩余量的 20%

**解锁的是：** GridSTS · DemoScanAndSTS（除它之外零缺口）· MeasureBarrierHeight ·
CleanTipUntilBarrier · MapBarrierHeight · SpectroscopyAtPositions 的 5 个 STS 格 ·
MakeSpectroscopyTip 的取谱格 —— **STS 是整条谱学链的地基，现在这条链的每一环都卡在它上面。**

依赖已逐项核实：28 个纯线缆 + 3 个确定性拒绝桩（`nanonis_calls=[]`）+ `channelIdsFromBuffer`
（`kernel/scan-reply.ts:54`，已有）+ `matOf`/`matRow` + `findLatestSaved`（`l0/frames.ts:138`，
已有，suffix 是参数）+ `DEFAULT_SAFETY_LIMITS`（`safety-tables.ts:29-31`，与旧仓
`except` 兜底值逐字相同）。56 个 `BiasSpectr_*`/`ZSpectr_*` 动词在 `spec/nanonis/nanonis_commands.json`
里一个不缺。

**强烈建议把 `SafeCall` 的 per-call recv 超时一并做掉**（`skill-kernel.ts:102` 一行类型
+ 参照 `core/connection.py:200-243` 约 44 行）。不做，这个 38 技能的大模块会永远停在 37/38；
而它挡着的 `AcquireSTS` 恰恰是整条链真正取谱的那一个。丢掉它的后果很具体：2026-09-08 真机
那次「422 s 的谱 / 8 s 的 recv → 回包落在没人读的 socket 上 → 整条连接后续全废，而
`degraded` 还报 false，顺带把 z-controller 留在 Hold」。

两条移植时会绊人的事实，建议同批登记：
- `ConfigureSTSChannels:851` 用手写 `split(",")`（不认 `;`、垃圾字符**抛**），`SetSTSChannels`
  用 `_coerce_int_list`（认 `;`、垃圾不抛）。**两处刻意不同**，形状同 D-CHANNELS-1，别统一。
- `AcquireZSpectr` 解不开一律报失败，`AcquireSTS` 只在「盘上也没有」时才报。判据分歧写在
  630-671 行，有依据（`ZSpectr_Start(1,"")` 不落盘）。两个都照移，别对齐。

### 优先级 2：`composite.scan_at` —— 1 个技能，解锁最多下游

**解锁的是：** AcquireBiasSeries · CalibrateCoarseStep · MapBarrierHeight · ExecuteScanPlan ·
MoveAtomTo 的扫描那一半 · ScanPublicationFrame · SearchDomainBoundary · `_tip_phases` 的
`scan_at_params` —— **八条链卡在同一个节点上。**

而它压着的**不是**一个子系统，是一个纯函数。子技能 7/7 全已移；`resolve_scan` 的五个查表
调用里四个已在 `scan-policy.ts`（`tierNames`/`tierForSize`/`tierByName`/`estimateScanSeconds`），
`wait_budget_s` 就一行公式 `max(floor, est*1.3 + 30)`，`atomic_working_point` 就一行常量。
真正要写的是 `resolve_scan` 本体 218 代码行 + 数据类 51 + 辅助 60 = **329 行**。

不用搬的三处（都有降级路径）：`preview()` 38 行（设置界面用，ScanAt 一次不调）、
`_read_prefs()`（try/except → `{}`）、`_read_v_tip_max()`（try/except → 常量 `2e-6`）。

**一处要点名的不匹配**：本仓 `resolveLineTime()` 顶不掉任何东西 —— `resolve_scan` 有自己的
line_time 优先级链（explicit > prefs > 档位表 > 针尖横向速度回压），不是那条
「explicit > tier > fallback」。别指望它抵账。

### 优先级 3：K2 平面族（113 行）—— 一次解锁 4 个，且是后面一切形貌分析的地基

`vision/tilt.py` 的 `noise_floor`(22) + `_lstsq_plane`(14) + `fit_plane_robust`(65) +
`plane_subtract`(12)。对应本仓 `ransacPlane` + `fitPlane` —— 真正缺的只有 `noise_floor`
那 19 行（行内差分的 MAD ÷ √2），用来喂 `ransacPlane` 那个**无缺省、必须调用方给**的
threshold。旧仓的 `fit_plane_robust` 正是「阈值 = 3 × 噪声底」自适应的那一版，它的自述
专门批评了写死 `1e-10` 的老实现。

**解锁：** AssessFrameTrust · MeasureStepHeight · FindFlatRegion（另需 `kde_layers`）·
CalibrateCoarseStep（另需 ScanAt）· AnalyzeFrameTilt（另需分割）。

> ⚠️ RNG 不同（numpy PCG64 vs 本仓 `Xoshiro128`），RANSAC 抽样序列不会与 Python 逐位一致。
> `rng.ts` 抬头已把判据定成「同种子同串数、金样钉本仓自己的参照」，按那条走，别去追 numpy。

### 优先级 4：K1 晶格峰 + `measure_cell`（约 380 行）—— 纯 numpy，零外部缺口

`lattice_calibration.py` 的 `find_lattice_peaks`(139) + `_is_ridge_point`(85) +
`_plane_subtract`(12)，加 `lattice_cell.py` 的 `measure_cell`(145) 链。

**解锁：** AssessScanTexture · MeasureLatticeCell（两个完全不经过 `assess_atomic_phase`，
**这正是本次盘点最有价值的一个反例** —— 它们 import 了 `mast.vision.lattice_*`，却一点也没
压在未移的判定机上）。同时 K1 是晶格判据底座的一半，先落它能摊薄后面那一大片。

### 优先级 5：`ExtractClusters`（约 270 行辅助）—— 一次解锁 4 个 + 一条 C 的关键格

`parse_xy_meta`(48) + `px_to_m`(46) + `acquired_row_mask`(77) + `assess_mask` 一族(101)，
全是无依赖纯函数。

**解锁：** AssessClusterRoundness · SelectPokedCluster · VerifyAdatomAt，再带 MoveAtomTo
的判定侧、`poke_phase` 每次扎针后的「成没成」判据。

> `sxmFrameMeta`（`sxm.ts:295`）**不是** `parse_xy_meta` —— 它只吐 `scan_offset`/`scan_range`/
> `scan_pixels` 原样，没有 `cx/cy/w/h/angle`，更没有 `angle_known` 旗标。而 `angle_known` 正是
> `SelectPokedCluster` 判 `coords_trustworthy` 的来源，不能省。

### 优先级 6：三个「整模块只差一件小东西」的收尾

| 模块 | 现状 | 补上这一件即整模块完成 |
|---|---|---|
| `builtins.scan_frame` | 2 A + 1 B | 2-D `correlate2d(mode='same')`，约 25 行 |
| `paper.data_processing` | 3 A + 1 B | 非归一化互相关 + `error`/`phase` + hanning，约 20 行（顺带解锁 `paper.scan_diff` 整模块） |
| `builtins.spectroscopy` | 37 A + 1 B | `SafeCall` 的 recv 超时（见优先级 1） |

### 不必优先、但零风险可随时插队的一批

`atom_jump` · `background` · `image_filters` · `scan_crop` · `denoise` ·
`region_analysis` 的两条经典路 · `current_monitor` · `monitor_current_fft` ·
`thermal_settle` · `acquire_psd` · `pattern` · `saturation_recovery`。
这批的共同点是**判据全在技能文件自己里**，不解锁什么，但也不欠什么 ——
适合拿来填批次的边角，或给需要快速见进度的时候用。

`paper.region_analysis` 要注意：它 4 个里 2 个是 D 档，**这个模块永远到不了 complete**。
移那 2 个 A 的收益是技能数，不是模块数。

---

## 三、B 档里几件需要单独交代的

### 3.1 `AssessImageQuality` 不欠 `find_peaks`（我核过）

`mast/data/quality.py` 顶上的 `from scipy.signal import convolve2d, find_peaks` 与
`from scipy.ndimage import median_filter` —— **`find_peaks` 只出现在第 30 行的文档串里**，
`median_filter` 函数体一次都没调。真正被调的只有 `convolve2d`（第 109 行，3×3 laplacian，
`mode="valid"`）。

所以 `AssessImageQuality` 差的是 **43 行 + 102 行**：`vision/atomic_phase` 的
`angular_concentration`(25) + `_ring_mask`(9) + `_angular_bins`(9)，加 `data/quality.py`
三个函数。**它一条 scipy 都不欠。** 这件补上，SurveySurface（子技能 4/5 已移）
与 BatchRegionsScan 的 optional 口子一起解决。

### 3.2 `_tip_policy` 的两半要分清（批 3j 那次错的根）

- **已移的那两个**（`shaperBiasDefault` · `resolvedLiftHeightM`）自成一体，不要登记表。
- **`apply_tip_policy` / `policy_fields_for_result`** 要 `tip_conditioning_resolver` →
  `tip_conditioning_policy` → `tip_state`（**1030 行的针尖登记表**）。
- **`qplus_gate`** 出厂就是**关的**：`_guard_on()` 读 `MAST_QPLUS_POKE_GUARD`，默认 `"0"`，
  第 82 行就 `return None`。2026-08-16 现场逐字：「一道每次都被同一个人用同一句话解开的门，
  不是保护，是仪式」。**移不移它对默认行为零差别。**

于是 `TipShape` 是 **A**：孪生兄弟 `TipShapeWithReadback`（已 done）下发的是**同一串**
`TipShaper_PropsSet(11 参)` + `TipShaper_Start`，已经按同一条线落过，账登记在 D-TIP-1。
`TipPulse` 同理。

但 **`ShapeTipOnSurface` 不同** ——它欠的是**扎针深度包络**。本仓 SEMI 模式有
`SEMI_TIP_LIFT_MAX_M = 5e-9` 硬顶，**AUTO 模式下没有任何按针尖的深度上限**。
`_tip_policy.qplus_gate` 的注释逐字点名：「真正护音叉的是 `max_poke_depth_m`，
超了拒绝不夹紧 ——『2 nm 以内』那句话是它在执行，不是这道门」。这条要在它的 deviation
里写死，**不能靠 `qplus_gate`（它是关着的）**。

### 3.3 晶格判据底座：两位盘点者在 B / C 上不一致，我按判据定为 B

事实两边一致：`assess_atomic_phase` 的判据环约 **950 行**，横跨 `atomic_phase`(508 判据行) ·
`lattice_calibration` 的 K1(236) · `seg_scale_adaptive` 切片 · `frame_validity:acquired_row_mask`(77) ·
`tip_metrics` 的 `_detrend`+`_fft_sharpness`(32)。**外部缺口只有一个 `find_peaks`。**

分歧在于这算 B 还是 C。我按任务给的判据定为 **B**：C 的定义是「压着一整个子系统，
只移技能层有害」，而这 950 行**全是可移植的纯 numpy**，没有驱动层、没有存储、没有原生依赖。
它是**工作量**，不是**屏障**。

但要把话说全 —— 这 950 行里有一处不能当普通重写对待。`atomic_phase.py:650-665` 记着：
脊判据放宽之后，对角条纹的 12 个极大被剔光只剩一对 ±k，于是半径散布这条判据**拿不到输入**，
一张 `conc=443283` 的条纹当场通过。原话是「**一条修复删掉了另一条修复赖以工作的证据。
单跑那条用例才发现；两条各自都对，叠起来是错的。**」移这一块时，两条判据的**咬合关系**
必须连同用例一起搬。

**这是全部 186 个里杠杆最大的一块**：它直接或间接挡着 AssessAtomicPhase ·
AssessAtomicResolution · AnalyseAtomicLattice · AssessAtomicConsistency · AssessHerringbone ·
AssessDomainPhase · ScanUntilAtomicResolution · VerifyAtomicResolution · ScanPublicationFrame ·
AchieveAtomicResolution —— **「原子分辨」这条主线的每一环。**

### 3.4 三处「看着能省，实际不能」的替换

| 想用 | 顶替 | 为什么不行 |
|---|---|---|
| `phaseCrossCorrelation` | `pair_displacement` 的归一化互相关 | 旧仓 2026-09-13 **明确把相位相关换掉了**：FFT 循环相关沿慢轴会绕回，实测「沿 y 挪 3 nm 量到 −0.06 nm」；而按重叠区的 NCC 在 +9.6 px 给出 0.997 的峰。换回去等于把那个 bug 请回来 |
| `phaseCrossCorrelation` | `correlate2d(mode='same')` | 它把每个频点归一化成单位模长，是**另一个估计量**。本仓 `fft.ts` 抬头自己就警告「这个算法在平坦帧上会报出一个纯属虚构的位移」（金样 `near_flat` 报 `(5,5)`）。换掉不会报错，只会**静默地改掉漂移数字**，而漂移补偿会照着那个数字驱动硬件 |
| `matFromRows` | `_reshape_spectrum` 的 `np.array(...).reshape(rows, cols)` | `matFromRows` 从 `rows[0].length` **推**列数，无视表头声明的 `rows`/`cols`。而 numpy 那句的语义是「拿声明的形状去装，装不下才报错」—— 那条「`{rows}×{cols}` 装不下这段数据」正是 2026-08-15 普查 A3 加进来的 `reason` 的核心一格。**对的是 `matOf` + `matRow`**（`matOf` 抛的错与 numpy reshape 逐字同构） |

---

## 四、三个自检技能：两个是 fail-open，移之前必须改

自检技能的本质是「把某个子系统的不变量跑一遍」。子系统不在，自检就变成空壳。
但三个坏法不同，**其中两个会说假话**：

| 技能 | 坏法 | 证据 |
|---|---|---|
| `ScanIntelSelfCheck` | **恒红**（无风险，但无信息） | 四项里三项的判据是「值还等于出厂默认 ⇒ 没人按本机填过」，没有 `instrument_profile` 就恒等于出厂默认；`is_customised()` 没有存储恒 False。`todo` 每次同样四条，与机器状态无关 |
| `TipConditioningSelfCheck` | **fail-open ⇒ 打出「✅ 可以开工」** | 核心断言是「流程默认的大修脉冲在不在这支针尖的包络内」。存储缺席 → `resolve_conditioning` 抛 → 走 `except` → `add("针尖包络", None, "查不了")`。而 `add()` 的规则是 **`ok is None` 只进 `warnings`，不进 `blockers`** → `ready = not blockers` 为 True |
| `TipForgeSelfCheck` | **同上，且两条 blocking 项都 fail-open** | 第 4 项（判据干跑）与第 5 项（扎针深度包络）—— 这个自检**存在的全部理由** —— 都落进 `except → ok=None`，同样不进 blockers |

**若坚持先移技能层，必须把 `except → ok=None` 改成 `except → ok=False, blocking=True`。**
否则移过来的是一句假的许可。

两条可以单独切出来的：

1. `ScanIntelSelfCheck` 的第 4 项（`Scan_BufferGet`/`Scan_FrameGet`/`Piezo_TiltGet` 三个硬件读
   + `_probe_buffer_semantics`）**现在就能落且真有价值** —— 它回答的是
   「`Scan_BufferSet(ch,0,0)` 到底是保持还是重置分辨率」，**整层设计建立在这个从未被回读验证过的假设上**。
   建议单独做成一个技能，不要连着另外三项一起移。
2. `registry` 那一项**不该照移**。旧仓查的是「冻结打包时 `walk_packages` 不跑、包 `__init__`
   没 import 到的模块里的技能会**静默消失**」（2026-08-04 真机一次丢 19 个、另一次 141 个）。
   本仓是静态 `import` + `export const`，掉一个技能是 `tsc` 编译错误 ——
   **这个不变量在 TypeScript 里不存在。** 该换成「REQUIRED_SKILLS 里还有几个没移植」。

另有两张「没有消费者的表」（`TipForgeSelfCheck` 的第 6、7 项）：`core/tip_intent.TIP_WORK_PATTERNS`
（约 30 行）与 `io/exp_map._SKILL_KIND_RULES`（约 50 行）。表本身照移很容易，但本仓既没有
电流监控也没有实验地图。**自检一张没人读的表，绿了也不代表任何事。**

---

## 五、逐族展开

按 `spec/progress.json` 的模块分组，115 个模块。格式：

> `模块` — 技能名 — **档** — 实际调到的旧仓函数 → 它又要什么 — 结论

### builtins（115 个技能 / 63 个模块）

#### 谱学与光学（4 模块 / 49 技能）

**`builtins.spectroscopy`（38）— A×37 / B×1**
- 模块级 import 只三行：`mast.core.types`（已移）·`io/nanonis_files:channel_ids_from_buffer`
  （→ `kernel/scan-reply.ts:54` ✓）·`skills/base:BaseSkill`（已移）
- 函数内 import 三处：`scan_extra`（145，在 `_attach_saved_dat` 里）·
  `core/scan_registry:record_scan_path`（156，本就裹在 `except: pass`）·
  `mast.config.SafetyLimits` + `core/safety:_get_effective_limits`（1856-1858，只在 `SetSTSMLSVals`）
- 技能子群：纯线缆 **28** · 确定性拒绝桩 **3**（SetSTSSafeCond1 / GetSTSSafeCond1 / SetSTSSafeCond2，
  `nanonis_calls=[]`）· 用 `channelIdsFromBuffer` **2** · 用 `_coerce_*_list` **3** ·
  用 `_reshape_spectrum`+`_match_channel` **2**（AcquireSTS / AcquireZSpectr）·
  用 `_get_effective_limits` **1**（SetSTSMLSVals）
- `_get_effective_limits` 追到底：`_merge_overrides`(823-844) → `clamp_to_instrument_facts`(702-771)。
  **关键一格：`_INSTRUMENT_CLAMPS`(693-699) 里只有 `("setpoint_max_a","preamp_full_scale_a")` 一条，
  偏压不在里面** → 对这个调用点收紧层是**可证明的 no-op**，退化成「默认 ±10 V 或管理员覆写」，
  与本仓 `DEFAULT_SAFETY_LIMITS.bias_min_v/max_v` 逐字相同。已有范式：`l0/piezo-check.ts:45`
  的 `deps.effectiveLimits?.() ?? DEFAULT_SAFETY_LIMITS`，登记在 D-LIMITS-1
- **AcquireSTS 是唯一的 B**：`recv_timeout_s` 不上线，是透传给传输层的 kwarg
  （`execution_context.py:276→317-325` → `connection.py:243` → `_raised_recv_timeout`(200-243)）。
  本仓 `SafeCall` 无 options 通道，全仓 `recvTimeout` 零命中（我核过）
- 全模块**无一个 `validate_params` 覆写**；`context` 只用到 `safe_call` 一个属性
- 附一条旧仓文档错：`optics_stage.py` 开头写 "7 skills"，`__all__` 与实际类都是 **8** 个

**`builtins.optics_stage`（8）— C**
- 8 个 `execute` 无一例外第一句 `get_instrument_registry()`，全部落到 `MotionAxis`/
  `MotionController`/`DelayLine` 的方法
- 屏障的确切位置：**`mast/instruments/base.py:215-221` 的 `MotionAxis._check_limits`（7 行）**，
  抛 `TravelLimitError`；唯一入口是 `move_abs:134`，而 `move_rel:143-154` **先读真实位置再折成
  绝对目标**，好让这一格量到真正的落点。配套三处：`AxisConfig.__post_init__`(85-91)——
  没有有限行程的轴**造不出来**；`stop():163-167`——**刻意不限位不阻塞**，那是急停路；
  `wait_until_settled:187-213` 抛 `MotionTimeout`
- 技能层唯一的安全代码是 `_fail()`(49-61)，一个异常翻译器。驱动层不在，四个异常没人抛，
  `_fail` 是死代码
- 子系统规模：base 329 + registry 245 + config 129 + delay_line 108 + `__init__` 64 +
  四个驱动 1238 + serial_transport 254 = **2367 行**；最省一条 1391 行
- **行数不是最硬的墙**：四个驱动分别要 pyserial / ctypes+Kinesis DLL / pythonnet。
  本仓 `packages/host/*/package.json` 的 `dependencies` 除 dsh 宿主包外**全空**，
  Node 侧对应物（serialport / koffi）全是原生 addon。**这是策略级冲突，不是工作量问题**
- **上一轮批 3i 的判断站得住。**

**`builtins.optics_scan`（2）— A×1 / C×1** ← **这正是本次要防的那种错**
- 模块顶 `from mast.instruments.registry import get_instrument_registry`（第 37 行），
  **但 `AcquireSignalPoint.execute`(100-136) 一次都没调它**
- 它只用 `optics_acquire.py` 的 `parse_indices`(37-48) 与 `PointAcquirer`(129-254)。
  而 `optics_acquire.py` 模块文档第 10-11 行自己写着「Nothing here touches the instruments
  registry — motion is the caller's job; this module only reads Nanonis through
  `context.safe_call`.」逐行核过，属实：只发 `Current_Get`/`Signals_ValGet`/`Signals_NamesGet`/
  `DigLines_PropsSet`/`DigLines_Pulse` 五条，纯 Python 算 `mean_std`(92-101，**ddof=1**)，零 numpy。
  从 `instruments.base` 只 import 了 `InstrumentError` 这个**异常类**（2 行）
- 五条动词在本仓**全都已有调用点**：`Current_Get`(`l0/engage.ts:70`)·
  `Signals_ValGet`(`readback-skills.ts:572`，连 `(idx, 0)` 都一样)·`Signals_NamesGet`(`reads-hw.ts:227`)·
  `DigLines_Pulse`/`DigLines_PropsSet`(`user-output.ts:409/441`)
- 要搬的量：`parse_indices` 12 + `nanonis_scalar` 20 + `mean_std` 10 + `PointAcquirer` 126 ≈ **168 行**
- ⚠️ `nanonis_scalar`(51-70) 与本仓 `scalarFloat`(`hardware-state.ts:92`) **语义不同**
  （前者 BFS 取第一个数、取不到就抛；后者拒绝多元素序列回 `null`）—— 这是一条要登记的偏差
- `OpticalStageScan` 则是 `reg.axis(...)` / `ax1.move_abs`，同驱动层，另加 `project_root`
  （本仓无数据根概念，D-FRAME-1 已为此销过账）与 matplotlib → **C**

**`builtins.optics_pump_probe`（1）— C**
- `execute:419` 第一件事就是 `get_instrument_registry().delay_line()`。**不用 `PointAcquirer`**，
  把采集内联重写了（572-606），只借 `optics_acquire` 四个纯函数
- `delay_range_ps`(`delay_line.py:81-86`) 是从 `axis.config.min_pos/max_pos` 换算的 ——
  它那条「延时超出可达范围」的拒绝，**底座仍是驱动层那对软限位**

#### 帧与图像分析（16 模块 / 19 技能）

**这一族有三把钥匙：**

| 钥匙 | 组成 | 外部缺口 | 一次解锁 |
|---|---|---|---|
| **K1** | `lattice_calibration:find_lattice_peaks`(289-427，139) + `_is_ridge_point`(204-288，85) + `_plane_subtract`(192-203，12) | **无**（纯 numpy） | 7 个 |
| **K2** | `tilt.py` 平面族：`noise_floor`(22) + `_lstsq_plane`(14) + `fit_plane_robust`(65) + `plane_subtract`(12) | **无** | 4 个 |
| **K3** | `seg_scale_adaptive:_band_peak`(141-164，24) 里那行 `find_peaks(prof, prominence=…)` + `props["prominences"]` | **`find_peaks`** | 7 个 |

> **K1 与 K3 是两把不同的钥匙**：K1 只找二维局部极大（纯 numpy），K3 是一维径向剖面上的
> 凸显度取峰（scipy）。移了 K1 就解锁 `AssessScanTexture`/`MeasureLatticeCell` 两个
> **完全不需要 K3** 的技能 —— 这是本族分批边界最有价值的一刀。

- **`atomic_lattice`（3）— B**：三个 execute 都走 `_load_frame`(55-86)/`_frame_conditions`(40-52)
  （只用 `read_sxm`+`sxm_oriented_frames` ✓）→ `assess_atomic_phase`(504-817，314) +
  `first_order_period_nm`(14) + `check_atomic_window`(45，`imaging_window.py` 整份 132 行
  **零 numpy 零依赖**)。CalibratePiezoFromLattice 另经 `calibrate_forward_backward`(42) →
  `calibrate_from_lattice`(95) → K1 + **`solve_affine`(428-525，98)**。
  **缺 K3 的 `_band_peak`(24)**；CalibratePiezoFromLattice 另缺 `solve_affine` 的
  `scipy.optimize.fsolve`（不是随手一调：12 个初值求根、按 `‖M−I‖` 挑分支、记 `ambiguous`）
  > 这三个技能的 execute 各只有 30-60 行胶水，判据全在 vision 里。「只移技能层」在这里等于移空壳。
- **`atomic_lines`（1）— A**：`_scan_readout:resolve_readout`(64)+`grab_frame`(10)；
  `vision/atomic_lines.py` 整份 **202 行，只 import numpy，无任何跨模块调用**。
  `frame_line_advisory`(49) → `line_score`(52)：`polyfit/polyval`(3阶)·`rfft`·`hanning`·
  `median`·`percentile`·半高宽扫描，全能对上。**本族最干净的一个**
- **`atomic_multiframe`（2）— B**：`lattice_multiframe:assess_atomic_consistency`(110) /
  `calibrate_multi_angle`(300-489，190) + `collect_observation`(54) + `angle_conditioning`(24) +
  `_independent_pair`(47)。只用 `lstsq/norm/solve/inv`，基线都有。**缺同上两件**
- **`best_frame`（1）— A**：只要 `composite/publication_frame.py:60` 的常数
  `DEFAULT_MIN_CONCENTRATION = 300.0`。**不 import numpy / vision / io**。
  注意 `peek` 是 `mast.goals` 的 `best_frame_settled` 谓词共用的那一份（注释明写「那个比较只许有一处」）
- **`frame_corrugation`（1）— A**：`judge_frame`(60)→`_detrend`(8)·`judge_corrugation`(105)
  （`corrugation_gate.py` 整份 259 行**连 numpy 都没 import**）·`scan_prep_thresholds:resolve`(27)·
  `acquired_row_mask`(77)·`detect_scan_artifacts`(28)。
  **两个陷阱**：① `detect_scan_artifacts` 只被用来取 `bad_row_frac`，却无条件算 `_spike_frac`(16)，
  那里用 `ndi.median_filter`（基线没有）—— 真正要的只是 `_bad_rows`(10)+`_plane_detrend`(9)
  共 **19 行**，直接搬这两个；② 裁行必须用 `acquired_row_mask`，不能自己写第二份
  （Nanonis 未扫行有 NaN 与全零两种形态）
- **`frame_drift_skill`（1）— A**：`_sxm_frame:load_frame`(45)+`split_paths`(10)·
  `scan_prep:poly_subtract`(26)·`frame_drift:pair_displacement`(98)+`separate_hysteresis`(30)。
  `frame_drift.py` 整份 319 行**只 import numpy**，外部只两个 scipy：`gaussian_filter(2-D)`
  → `gaussianFilter2d` ✓；`correlate(mode="full", method="fft")` → 补零到 `(2ny−1,2nx−1)` 后
  `fft2×conj→ifft2`，**全在现有导出之上，约 30 行**。⚠️ 见 §3.4 第一行
- **`frame_tilt`（1）— B**：`io/mosaic:parse_xy_meta`(48，纯 Python)·`tilt` 五个函数。
  `estimate_tilt`(92) → `assess_steps`(36) 取**两路的或**：`step_dominance_multiscale`(27)（能落）
  与 `_segmentation_step_signal`(23) → **`segment_scale_adaptive`(210)+`summarize_segmentation`(40)**
  （要 skimage disk/white_tophat/black_tophat/otsu + K3）。
  **只移技能层的后果**：那一路失败时按设计返回 `(False, 0.0)`，判据是「或」，所以**缺它只让
  `step_dominated` 更宽松**。而 `estimate_tilt` 在 `step_dominated` 时是**拒绝给倾斜数字**的
  （注释：「2026-07-28 的审计实例里这个数字偏了 13 倍」，而下游拿它去调硬件）。
  **移的时候必须把 `step_present` 明确置 `null` 而不是 `false`。**
  `vision/tilt.py` 本身 765 行**纯 numpy、零 scipy、零 skimage**，除这一处外全可落
- **`frame_trust`（1）— A**：只要 K2 的 `plane_subtract`(12)。其余 `_row_medians`(7)·
  `row_jump_mad_pm`(23)·`row_big_jumps`(18)·`row_jump_sigma_pm`(11) 都在技能文件里
- **`scan_texture`（1）— A**：`load_frame`(45)·`frame_texture` 三个(57+58+72，整份 442 行纯 numpy)·
  `lattice_cell:measure_cell`(145)→`_spectrum`(17)/`_refine`(20)/`_gauss_reduce`(92)/
  `_best_indexing_pair`(86)/K1/`scale_gate`(11)。**全链纯 numpy，不经过 `assess_atomic_phase`**
- **`herringbone_assess`（1）— B**：`assess_herringbone`(596-909，314)（自家 8 个 helper 全纯 numpy，
  整份 909 行零 scipy/skimage）·`_fwd_bwd_instability`(46)·`resolve_substrate`。
  向外要 `angular_concentration` 一族·`judge_frame`(60)·`_detrend`+`_fft_sharpness`(32)·
  **K3**·`double_tip` 一族。**缺 K3**。
  **`double_tip` 可缓**（我核过调用点 849-866：整段包在 try/except，结果**只填报数字段，不参与 verdict**），
  但那三个字段不能静默变 `false` —— 模块头明写「`double_tip_detected=False` 的含义是
  **『没有证据』**而不是『针尖没问题』…本仓为『判不了被当成没问题』栽过不止一次」。
  **要么带，要么置 null 并在 summary 里说**
- **`domain_assess`（1）— B**：`parse_xy_meta`(48)·`extract_fingerprint`(237)（→`ring_peaks`(82)·
  `assess_atomic_phase` **直接转发**「不重算一套」）·`classify`(103)·`load_reference`(30)。
  `domain_phase.py` 915 行**纯 numpy**，`domain_reference.py` 323 行**纯 Python**。**缺 K3**。
  **现场事实**：`references_dir()` = `project_root()/config/domain_references`，本机
  `<MAST_PROJECT_ROOT>/config/` 存在但**没有 `domain_references/`，全仓也搜不到任何参照 JSON**
  → `load_reference` 恒 `None`，`classify` 恒走 `undetermined(no_reference)`。
  **今天这条技能活着的那一半就是指纹提取**；不带 `domain_reference.py` 不丢任何现有判定能力，
  但要如实给出 `verdict=undetermined / reason=no_reference`
- **`lattice_cell_skill`（1）— A**：`load_frame`+`split_paths`·`measure_cell`(145)+
  `combine_up_down`(76)+`superstructure_test`(89)+`_max_over_neighbourhood`(20)。
  用到的线性代数只有 2×2 的 `det/inv/norm`。**与 `scan_texture` 共用 `measure_cell`，移一次解锁两个**
- **`step_edge`（1）— A**：`vision/step_edge:locate_step_edge`(76)。整份 **179 行，只 import numpy，
  零跨模块调用**。`np.linalg.svd` 在这里是 **N×2 的总体最小二乘**，等价于 2×2 对称特征问题，约 15 行
- **`step_height`（1）— A**：只要 K2 的 `fit_plane_robust`（带显式 `sigma`）。
  `_levels`(31) 在技能文件里。内点率低时那段警告（Au(111) herringbone ~20 pm 会让自适应阈把
  台面点判成外点）是纯文本，照抄
- **`flat_region`（1）— B**：K2·`judge_frame`(60)·`parse_xy_meta`(48)+`px_to_m`(46)·
  `seg_scale_adaptive:kde_layers`(17)。**缺 `kde_layers`→`_hist_modes`(32)**（K3 + `median_filter`）。
  **降级路径旧仓自带**：`layer_labels=None` + 写一句 `terrace_note`，**照抄那个分支，别自己发明一个**。
  `px_to_m`(46) 必须搬：注释说这套换算一度有三份实现，第三份是唯一没被测过的那份
- **`clean_spot`（1）— C**：**完全不碰 `mast.vision`**。`map_scope:analysis_config`(143)/
  `load_markers`(23)/`crash_memory_markers`(57)·`io/map_analysis:nearest_clean_from`(250)/
  `build_avoid_circles`(29)。`marker_rows` 走
  `logging.experiment_log.get_active_log()._storage.get_markers(experiment_id, sample_id)`。
  我核过本仓 `packages/host/stm-records/` —— 它是**技能调用审计账本**（actions/approvals/ledger/
  claim-audit），**没有 markers 表，也没有 experiment/sample scope**；全仓 grep
  `MapMarker|load_markers|experiment_log` 无命中。
  **后果**：`available` 恒 `False` → `map_known=False`。旧仓说得很死：「空表和『这片表面确实干净』
  在几何上无法区分…在读不到历史的情况下往表面打 10 V 脉冲，和在确认干净的地方打，是两件不同的事」。
  2026-08-16 真机上这条链断掉的症状是**第二轮把第一轮的坑原路重打了一遍**，没有任何一处报错。
  **`record_damage_marker` 是写侧对偶，两侧要一起移，单移一侧比不移更坏**

#### 簇 / 针尖 / 谱判读（17 模块 / 18 技能）

- **`cluster_extract`（1）— A**：`scipy.ndimage.label`→`labelConnected(mask,4)`（scipy 默认结构
  就是十字 = 4 连通）·`data/processors:plane_subtract`(11)→`fitPlane`+`subtractPlane`·
  `acquired_row_mask`(77)·`roundness:assess_mask`(26)→`dispersion_of_mask`(23，`binary_erosion`
  默认十字 → `greyErosion`+`crossSE`，**边界取值要核对**)/`dispersion_floor`(30)/
  `axis_ratio_from_dispersion`+`_ellipse_dispersion`(22)·`parse_xy_meta`(48)·`px_to_m`(46)
- **`cluster_roundness`（1）— A**：+`background_level`(18)+`weighted_axis_ratio`(53)+`_axes`。
  两处小缺口：`scipy.ndimage.find_objects`（本仓 `LabelResult` 只有 `labels`/`count`/`sizes`，
  **没有每域 bbox**，扫一遍记 min/max）；`background_level` 走 `np.histogram(fl, bins=96)`
  **不给 range**（numpy 取 min/max），而本仓 `histogram` 要显式 range；
  `eigvalsh` 只作用在 **2×2** 上 → 闭式解
- **`cluster_select`（1）— A**：`si_quantity:parse_quantity(strict=True)` → `kernel/si.ts:parseQuantity` ✓
- **`adatom_verify`（1）— A**：`ExtractClusters` + `resolve_substrate`(36)，**但后者只是容差兜底**
  （`adatom_verify.py:165-175`，包在 try/except，拿不到走 `verdict="undecidable"` /
  `reasons=["no_tolerance"]`）→ `knowledge/`（30570 行）**不是硬依赖**。
  **这一条与 AssessShockleyOnset 的区别，正是这次任务要分清的那种**
- **`tip_sharpness`（1）— A**：`tip_metrics` 的 `_fft_sharpness`(24)/`_fwd_bwd_instability`(46)/
  `_edge_resolution`(19)/`_detrend`(8) + `judge_frame`(60)。
  **它刻意不调 `assess_tip_classical`**(189-240)，源码注释逐字写了理由：那个函数开头
  `if h.std() < 1e-9: return 全零` 的守卫单位是米，而 Au(111) 单原子台阶只有 236 pm，
  「修针最该用它的那种图，它恰好全部早退」→ `barker_quality`(244) 等都**不在依赖里**。
  `parse_xy_meta` **不需要**：只用来算 `nm_per_px`，而本仓 `sxmOrientedFrames` 已经有
  （`sxm.ts:274`，同一个表达式）
- **`tip_from_spectrum`（1）— A**：`vision/spectroscopy:assess_iz`(41)+`assess_iv`(76)。
  **这两个函数里没有一行 scipy** —— 该文件两处 scipy import 在 287/299 行，全在
  `assess_shockley_onset` 体内。数值面只有 `polyfit(1)`/`corrcoef`/`median`/`argsort`/`diff`
- **`spectrum_assess`（1）— A**：`resolve_spectrum_kind`(47)+`assess_spectrum_quality`(240)
  →`saturation_frac`(39)/`spectrum_snr`(30)/`assess_hysteresis`(44)/`assess_iv`/`assess_iz`。
  **全族零 scipy**，约 470 行纯 numpy。另加 `io/exp_map:extract_dat_position`(27，自成一体，best-effort)
- **`tip_shaper`（1）— A**：见 §3.2
- **`spectral_peaks`（1）— B**：`find_peaks_1d`(104)。缺 **`find_peaks(prominence=, width=0)`**
  —— 用到 `props["prominences"]` **和** `props["widths"]`，后者决定每个峰的拟合窗；
  **`savgol_filter`**(`_savgol` 13 行)；`curve_fit` 要 `sqrt(pcov[1,1])`
- **`dispersion_fit`（1）— B**：`standing_wave:fit_dispersion`(95)+`_dominant_k`(37)+`_fit_k`(44)+
  `_nyquist_k`(12)+`distance_to_line`(9)+`distance_to_point`(4)。卡在三处：
  **`scipy.special.j0`**（台阶散射体模型本体就是 `J₀(2kx)·exp(−2x/λ)`）；
  **`curve_fit` 的 box bounds** —— 而 `_fit_k` **紧接着拿 bounds 当判据**：
  `if not (k_lo*(1+MARGIN) < k < k_hi*(1-MARGIN)): return None`，源码逐字
  「a wavevector sitting on a bound is not a measurement, it is the optimiser giving up」，
  它挡的是「能带底以下每个能量都塞一个贴边的 k，把正在测的截距拽走」；**`pcov[1,1]`** → 权重
- **`force_inversion`（1）— A**：`invert_force_curve`(88)→`sader_jarvis`(27)+`_decay_length`(12)。
  Sader–Jarvis 的积分是 27 行手写求积。**唯一的 scipy 是 `savgol_filter`，只在
  `smooth_points >= 5` 时才走**（第 162 行）—— 它是一个 ParameterSpec，
  **落地时要么不声明这个参数、要么声明了就明说本仓不提供，不能悄悄忽略**
- **`deltaf_curve`（1）— B**：纯 `safe_call`（PLL 族 `l0/pll.ts` 已有）。
  **缺 `spectroscopy:_reshape_spectrum`(33-85，53 行)** —— 与 `builtins.spectroscopy` 同批即消失。
  （另一位盘点者报的 `_candidate_save_dirs`/`find_latest_saved` 缺口**不成立**，
  本仓 `l0/frames.ts:138` 已有 `findLatestSaved`，suffix 是参数）
- **`barrier_height`（1）— B**：自己的数值面只有 `_fit_kappa`(67-92) 一句 `polyfit(d, log(i), 1)`，
  判据本体全在本模块 366 行里。**卡在 STS 四件套**（ConfigureSTSChannels / ConfigureSTSTiming /
  ConfigureSTS / AcquireSTS）
- **`barrier_map`（1）— B**：两跳 —— `ScanAt` + `MeasureBarrierHeight`。自己只用 `statistics.median`
- **`clean_tip`（1）— B**：四个 `context.run`：`TipShape`（同批可落）·`BiasPulse` ✓·`GetBias` ✓·
  **`MeasureBarrierHeight`**。零 numpy、零 vision → **它的档位 = MeasureBarrierHeight 的档位**
- **`tip_spectro_assess`（2）— B×1 / B×1**
  - `AssessShockleyOnset`：`assess_shockley_onset`(274)+`broadening_floor_v`/`_logistic_step`/`_bic`。
    `gaussian_filter1d` → 基线 ✓（且外面包 try/except）。缺 **bounds**（`w_lo = max(w_floor*0.5, 1e-5)`
    是**物理先验**：「台阶不可能比 kT + 调制展宽更陡。没有它，一个 tip switch 的单点尖峰会被
    拟合成宽度→0 的『完美台阶』，r² 还很高」）+ **`resolve_substrate`(36) 是硬依赖**
    （`_resolve_expected`(71-89) 拿不到 `surface_state_onset_v` 就 `success=False`，**无降级**）
    → `knowledge/lookups.py`(579，Au(111) −0.49 V / Cu(111) −0.44 V / Ag(111) −0.065 V 那张表)
    + `logging/experiment_log.py`(502)
  - `AssessAtomicPhase`：见 §3.3
- **`saturation_recovery`（1）— A**：纯 `context.run` 组合，四个子技能**全已移**
  （`GetCurrent`/`MotorMove`/`SetBias`/`WithdrawTip`）。自己只用 `statistics.median` + `time.sleep`

#### 仪器 / 时序 / 自检（26 模块 / 29 技能）

**三个跨模块共因**（否则下面要重复 11 遍）：

| 共因 | 行数 | 本批里几个模块要它 |
|---|---|---|
| `core/instrument_profile.py` | 1237 | 5（calibration_readout · coarse_selfcheck · characterise_noise · scan_intel_selfcheck · tip_conditioning_selfcheck） |
| `monitoring/store.py` + 喂它的泵 | store 2107 + pump 1450 + aux_channels 2257 | 4（characterise_noise · history_query · quiet_drift · hardware_events） |
| `core/registry.py:registered_skill_names` | 548 | 3 个自检（**且这个不变量在 TS 里不存在**，见 §4） |

- **`acquire_psd`（1）— A**：8 个动词（`SpectrumAnlzr_*`）齐。`from mast.core import nanonis_patch`
  看着吓人，实际只用其中 `_patched_SpectrumAnlzr_DataGet`(892-911) —— 把上游库错写的
  `["f","f","i","*f"]` 改成 `["d","d","i","*d"]`（否则每个 float64 差 4 字节，最后在错位偏移上
  炸 UnicodeDecodeError）。**这个补丁本仓已经有了**：
  `packages/instrument/nanonis-wire/src/generated/methods.ts:588`，`source: 'patch'`
- **`bias_series`（1）— B**：`setpoints_for()` 是模块局部纯算术。两次 `context.run`：
  **`ScanAt`（硬）**+ `AssessFrameTrust`（软，缺席只让 `drift_check` 退成 `None`）
- **`bias_wiggle`（1）— B**：只 `safe_call`，三个硬帽常量都在文件里。
  **唯一缺口在收尾那一行**：`context.safe_call("Bias_Set", float(to), allow_on_abort=True)`。
  `_restore` 的自述写明为什么要它：「abort 之后 `safe_call` 拒绝一切非白名单写，而 `Bias_Set`
  不在白名单里 —— 这次写**是因为** abort 才要做的」。本仓 `gated-call.ts`（全文 48 行）
  只查 `abortLatched()`/`isReadVerb()`/`isAbortSafe()`，**没有 per-call 参数**（全仓
  `allowOnAbort` 零命中），而 `ABORT_SAFE_WRITES` 里**没有 `Bias_Set`**。
  不补的后果：中止落在扰动中段时偏压被留在某个随机的 ±20 mV 值上
- **`calibration_readout`（1）— C（最便宜的一个 C）**：`execute` 只调
  `instrument_profile` 的 `get_tilt_calibration`(823-838)/`get_calibration`(747-753)/`get_config`(614-628)。
  **零硬件调用**。这个技能的价值**全在区分两种否定** ——「**从未标定过倾斜响应**(不是读取失败)」
  vs「读不到仪器档案: {exc}」，两者「该去做的事完全不同」。没有存储，三块全走 `except`
  恒返回后者，**这个技能永远说不出它唯一要说的那句话**。连同丢掉的还有 `convention_note`
  （存的是 **G = −M⁻¹** 不是 M —— 2026-08-11 才跟上的更正，信了旧措辞的人会二次求逆，
  把 08-10 那次发散原样请回来）
- **`characterise_noise`（1）— C**：`monitoring/baseline.py` 九个函数(994)·`features:psd_of_runs`(706)·
  `store` 八个入口(2107)·`envhistory/zburst:run_dual_burst`(545)·`instrument_profile.get_config`。
  **整个测量不经过这个技能自己的 TCP** —— 数据来自 `store.segments_query(since,until)` 读
  监控泵在那段时间里全速率写进库的段。泵不在，`len(runs) < 5` 永远返回「取到 0 段」。
  同时丢三条论证：① `d.get("decimated")` 就跳过（抽稀会把 Nyquist 之上的东西混叠进正要描述的频带）；
  ② 拿不到 `baseline_id` 就**判失败**（2026-08-19 前两个工况点无声消失的教训）；
  ③ `add_baseline_point` 返回 None 也判失败（存储层按设计吞异常，只有这里能把它变成一句话）
- **`coarse_nudge`（1）— B**：`execute` **一个旧仓函数都不调**，整体就是 `_NUDGE_MAX_STEPS = 60`
  的拒绝 + 一次 `context.run("RelocateCoarseXY")`。137 行里 90 行是 docstring。
  **差 `RelocateCoarseXY`（1328 行）；它落了，这个技能是半天的事**
- **`coarse_selfcheck`（1）— C**：八个探针里只有 `_step_counter`/`_closed_loop` 能真跑，
  而技能自己写明这两项「当前设计**没有**使用它」。反过来 `_drive` 会**无条件**吐出那条 blocking
  ——「本机粗动耐压未声明 ⇒ 一切驱动写入与粗动移动都会被拒」，因为本仓
  `l0/reads-hw.ts:102` 把 `declared_max_amplitude_v: null` / `within_declared_limit: false`
  **写死了**。于是这个自检**永远不可能变绿**，而它的 todo 列表会每次原样重放，与机器状态无关
- **`coarse_step_calib`（1）— B×4**：① `ScanAt` ② `TipShape`（同批可落）
  ③ K2 的 `plane_subtract`（真正缺的只有 `noise_floor` 19 行喂 `ransacPlane` 的 threshold）
  ④ Hann 窗 + 峰锐度 SNR 约 15 行 —— 本仓 `phaseCrossCorrelation` 是同一个算法，
  但（a）不加窗（b）不回报峰锐度，而**峰锐度正是这个技能的拒答判据**（`snr < _MIN_CORR_SNR` 就不报位移）
- **`current_monitor`（1）— A**：一个定速轮询循环，统计全部内联纯 Python，**一行 numpy 都没有**
- **`current_origin`（1）— A**：`saturation_recovery:is_saturated`(5 行 + 常量 `_SATURATION_A = 9.5e-9`)；
  判别表全在文件里。五个 `context.run` 全已移**且数据键逐字对上**：`zctrl-state.ts:62` 发
  `controller_on`（旧仓读的正是这个键）、`writes-verified.ts:64,66` 发 `z_controller_on`+`verified`
- **`envelope_reconcile_skill`（1）— C**：`core/safety:_get_effective_limits`（**顺序是判据的一部分**）·
  `envelope_reconcile:reconcile_envelope`(258-393) 一族(495)·`admin/override_store`(555)。
  本仓 `piezo-reconcile.ts`(105) **只覆盖 XY 半程一个结论**，没有逐字段 findings、没有 Z 行程、
  没有 `ZCtrl_LimitsEnabled` 失效（手册原话 "has no effect"）那条、没有 WIDER/NARROWER 方向、
  写入侧一点没有。**全部安全论证在 `apply=True` 那条路上：按幅度收紧、拒绝放宽**
  （「放宽有正当理由，但那是人的决定；这里悄悄夹一下，就等于『我要求 A，系统给了我 B』」），
  外加写完**回读比对**才敢说写进去了。没有覆写存储，`apply` 变成报告 `applied: True` 的空动作
- **`feedback_tracking`（1）— B**：`_sxm_frame:load_frame`(45)·`feedback_lag:measure_feedback_lag`
  (**206/295，纯 numpy，一条 scipy 都不沾**)·`lattice_cell:measure_cell`(392，**软依赖**：
  只在调用方没给 `lattice_period_nm` 时用，拿不到就 `period_src="unavailable"`/`fidelity=None`)。
  **这一条完全不牵扯 vision 的其余 20206 行**
- **`hardware_events`（1）— C**：`buffer_hitl:gate_states`(607)·`buffer/active`→`get_event_history`(882)·
  `store:segment_meta`/`feature_row`(2107)。**这个技能一次硬件都不调**。只移技能层 = 两块都返回
  `available: False`，一个**永久失明的窗口**。更糟的是存在理由本身塌了：description 写的是
  「被 buffer_hitl 拦住写入类工具时，先调本工具看证据」—— 没有 HITL 闸门，就没有「被拦住」这件事。
  （另注：`Severity` 字面量是 `"warn"` 不是 `"warning"`，写错不报错，只是静默地一条都过滤不掉）
- **`history_query`（1）— C**：`store:get_store_if_exists`→`aux_query`（SQLite `aux_samples` 表，
  由 aux_channels 2257 + pump 1450 以实测 3.73 Hz 写入）·`envhistory/store:series`/`sensors`(493)。
  numpy 只在 `_stats`，全是 A 级。**最有价值的那段判断**——「桶在、但每个桶都是空的
  （`n=0, n_excluded=25, worst_status=unavailable`）≠ 没有数据」（2026-08-20 `helium_level` 那次）
  ——**需要真桶才能出现**
- **`monitor_current_fft`（1）— A**：`fft.ts` 收任意长度（2 的幂走 radix-2，否则 Bluestein），
  `rfft` = 取前 ⌊N/2⌋+1 格；`rfftfreq` 与两个窗都是闭式三行
- **`pattern`（1，RunGridExperiment）— A**：五个动词全在 `methods.ts`（`Pattern_GridSet` 的 9 个实参齐全）。
  **比已移 6 个多要的唯一一件是「GraphExecutor 的动态（生成器）计划」** —— 已移的 6 个全是
  `BaseSkill` 单次 `safe_call`，它是本模块唯一的 `CompositeSkillGraph` 且 `plan_dynamic()`
  （tick 数由 `wait_timeout_s / 2 s` 现算并 `set_total_steps`）。**本仓 `graph-executor.ts:373`
  的 `runPlan(Iterable|AsyncIterable)` 已有**，`composite/wait-scan-complete.ts` 就是先例。
  中止路径的两个动词也已在 `ABORT_SAFE_WRITES`（`safety-tables.ts:149/172`），
  而那张表的抬头注释写的正是这个 bug：「操作员按了中止之后网格实验还在控制器上跑」
- **`quiet_drift`（1）— C（薄的那种）**：外部只有 `store:get_store_if_exists`→`aux_query`。
  **分析那一半完全自足**，包括那条用一次误报换来的阈值 `floor·1.25·√(2 ln N)`
  （固定「3 倍本底」在 59 分钟静置数据上报出六条纯噪声「成分」）。但 `_fetch` 拿不到 aux 就
  `return None`，整条路断在第一步。**这是 C 档里最容易变 B 的一个**
- **`scan_frame`（3）— A×2 / B×1**：
  - `LoadScanFrameFromFile` — **A**，一件都不多要（`readSxm`/`sxmOrientedFrames` ✓ +
    `encodeNpyFrame`（`kernel/npy.ts:65`）**本仓已有**，保 `(rows, cols)` 二维），只差一个 `_frames_dir()`
  - `ParseRegions` — **A**，全文零依赖（`json.loads` + 四条边界）
  - `ComputeDriftVector` — **B**，差 `scipy.signal.correlate2d(ref0, cur, mode="same")`。
    见 §3.4 第二行
- **`scan_intel_selfcheck`（1）— C**：见 §4
- **`scan_prep`（2）— C**：`vision/scan_prep` 五个入口(855)·`scan_prep_thresholds:resolve`(489)·
  `measure_frame` 内部再调 `dominant_terrace_mask`/`height_levels`（→`gaussian_filter1d` +
  **`find_peaks(prominence=, distance=)`**）+ `uniform_filter`·再往外 `assess_atomic_phase`(817)·
  `detect_tip_change`·`detect_scan_artifacts`·`_fwd_bwd_instability`。
  这两个技能是 `vision/scan_prep` 的**壳** —— `FrameMetrics` 的每一个字段
  （`line_gain`/`bow_gain`/`row_purity`/`sep_over_rough`/`rowcorr_median`/`fb_instability`/
  `nan_frac`/`atomic`/`tip_change`）都是判据本体，技能自己只做读文件、拼表、写 Markdown。
  description 里那句「它绝不自己宣称看到了晶格 —— 那个断言来自 atomic_phase，而后者还能回答
  『在这个像素尺寸下判不了』」正好说明**判据不在技能这一层**
- **`scan_watch`（1）— A**：`_scan_readout.py` 整个 **143 行**（只要 `parseBufferGet` ✓ +
  三个动词 ✓ + `parseFrameGrab` ✓）+ `atomic_lines:usable_rows` **15 行**
  （判据是「不全零 且 全有限」，不牵扯 `line_score`/`frame_line_advisory`）
- **`slow_drift_skill`（1）— B**：`atomic_multiframe:_load_one`(~50)+`_split_paths`(~8)
  （读表头 `scan_angle`，**读不到就拒绝**，不让调用方手填）·**`vision/slow_drift.py` 整个 357 行**
  （`analyse_slow_drift`/`combine_frames`/`row_time_series`/两个数据类，**grep scipy/skimage/sklearn = 0**）。
  `combine_frames` 里 `span_invariant`/`time_locked`/`leakage_suspect` 三级判据是这个技能的全部价值
  （第一版只用 `time_locked` 时把一条教科书式谱泄漏排进了 confirmed 首位）。
  另有 `hashlib.md5` 去重（防同一帧多份存盘被当独立证据）
- **`thermal_settle`（1）— A**：`context.run("GetTemperature")` 读 `data["value_k"]` ——
  本仓 `kernel/temperature.ts:125` 正是 `value_k: channelKelvin(c)`
- **`tilt_probe`（1）— B**：动词全在协议里，`_estimate_noise()` 只用 `diff`+`median`。
  唯一外部件是 `from mast.vision.tilt import CIRCLE_MIN_POINTS, fit_circle_tilt` —— **就这两个符号**：
  `fit_circle_tilt`(632-728，**97**) + `CircleTilt`(549-597，**49**) + 四个常量(~10) = **156 行 / 765**。
  算法本体是一次 3~4 列最小二乘（cos θ / sin θ / 1 / t−t̄），`solveNormalEquations` 正好吃这个形状。
  **它不压 vision**：`estimate_tilt`/`assess_steps`/`structure_dominance`/`plane_subtract` 一条都不碰。
  **本族最划算的一个 B**
- **`tip_conditioning_selfcheck`（1）— C**、**`tip_forge_selfcheck`（1）— C**：见 §4

### composite（37 个技能 / 33 个模块）

- **`scan_at`（1）— A**：见 §2 优先级 2
- **`tip_pulse`（1）— A**：子技能 2/2 已移（`GetBias`·`BiasPulse`）。`apply_tip_policy` 三处调用
  按 D-TIP-1 不移，pulse_v 退到 `plan()` 已有的保守默认 3.0 V，安全由全局 ±10 V SafetyGate 承担。
  **不要写空的 `validateParams`** —— D-TIP-1 明写「写了会让人以为这道闸在」
- **`bias_settle`（1）— A**：子技能 `SetBias`·`SetBiasRamp` 已移；旧仓函数**零**；
  六个阈值常量全在本文件 55-68 行
- **`batch_regions_scan`（1）— A**：5 个子技能全 done；`AssessImageQuality` 那步**只在
  `assess_quality=True`（默认 False）时进计划，且 `optional=True`**（第 255-258 行）
- **`full_scan`（1）— B**：**子技能 4/4 全已移**。旧仓函数全部有着落，**只缺
  `core/tip_crash_tracker.py`（250 行纯 stdlib）**——它是 `run_composite:350` 的第一道闸，
  拒绝在已连撞的点重扫，**无降级**。`buffer.active` 那段包在 `try/except → return {}`，
  掉了只少两个 `vision_tip_*` 上报字段，**可丢**
- **`assess_quality`（1）— B**：**零子技能**（`_PHASE_*` 是 `"_phase_load"` 一类的本地分发键，
  不经 registry）。见 §3.1
- **`grid_sts`（1）— B**、**`demo_scan_and_sts`（1）— B**：旧仓函数**零**，
  只差 `AcquireSTS`(132)+`ConfigureSTS`(119) = 251 行。**应当与 `builtins.spectroscopy` 同批**
- **`drift_track`（1）— B**：差 `FullScan`（必需，`optional=False`）+ `correlate2d(mode="same")`
- **`execute_scan_plan`（1）— B**：差 `ScanAt` + `core/coord_epoch.py`（154，顶层 import 无降级）。
  `BiasSettleChange` 这批自己给
- **`bias_imaging_series`（1）— B**：差 `FullScan` + `AssessAtomicResolution`
- **`angle_series_calibration`（1）— B**：差 `FullScan` + `CalibratePiezoMultiAngle` +
  `angle_conditioning`(24)。后者包在 try/except 里降级成 `(999.0, 1.0)`，
  **但那个降级会让「角度张不开就别扫」的开跑前闸门静默失效**，不建议当可丢
- **`condition_tip`（1）— B**：差 `AssessImageQuality` + `TipPulse`(226) + `tip_crash_tracker`(250)。
  ⚠️ **`apply_tip_policy` 在这里不构成 C**：import 与调用各包一层 try/except，
  失败即 `return params, None`，技能自己的 ParameterSpec 默认值仍在（`_tip_policy.py:117-123, 128-133`）
- **`retract_for_sample_change`（1）— B**：**零个外部子技能**，全是内部相。
  差 `_z_settle.py`(402/285 代码行，**自成一体**：只要 `ctx.safe_call` + 3 个配置键 +
  `skills/verify:verify_z_controller`（本仓 `l0/verify.ts` 已有）) + `instrument_profile` 的
  4 个 key & 2 个派生读数。`crosstalk_report`(210-244) **是留痕不是闸门**，整体包在 try/except、
  **永不抛**（注释逐字：「这是报告，不是任何流程的目的」），可整块降级成一句 `crosstalk_skipped`
- **`relocate_coarse_xy`（1）— B**：子技能 1/1 已移（`ApproachTip`）。
  差 `_z_settle.py`(402) + `core/coarse_drive.py`(346，**硬闸，不在 try/except 里**)。
  `vacuum_interlock.check()` → 本仓已有 ✓；`_tip_evidence` 四个函数 → `qplus_amplitude` → 已有 ✓。
  `io/coarse_map`(604) 那段落点复核包在 try/except、失败即放行（第 432-434 行「落点复核不可用，放行」）
  —— 技术上可降级，**但降级掉的正是「别回到去过的站点」那条保护，要在 deviation 里点名**。
  **必须与 `RetractForSampleChange` 同批** —— 共用 `_z_settle` 与同一批配置口，分开等于搬两次
- **`survey_surface`（1）— B**：子技能 4/5 已移，差 `AssessImageQuality`
  （参数默认 **True**，且技能自述里「推荐哪块区域」全靠它）
- **`prescan_check`（1）— B（大）**：**子技能 7/7 全已移，一个都不欠**。
  卡它的全是判据侧：`frame_validity:judge_frame`(139-196，58)+`acquired_row_mask`(199-275，77)
  （该文件 275 行**只 import numpy，自成一体**）·`tip_metrics:trace_retrace_correlation`(74)+
  `_detrend`(8)+`_fwd_bwd_instability`(46)（合计 ~144，**模块头那个 `vision.module` import
  是 `assess_tip_classical` 用的，不在本条路上**）·`tip_crash_tracker:crash_guard`(250)·
  `line_check:_DEFAULT_MIN_CORRUGATION_M`(一行常量 `15e-12`)·`operating_mode:safe_mode_active`(6)。
  **不是压着 20206 行的 vision，是压着它里面两个自成一体的文件。**
  与 `ScanAt` 共用 `wait_budget_s`，可同批；它的 vision 切片也是 `AssessTipSharpness`/
  `FindFlatRegion`/`ExtractClusters` 共用的**下层**，先落它能摊薄后面三条 C
- **`atomic_bias_series`（1）— C**：差 `BiasSettleChange`(本批 A)/`ScanAt`(495)/
  `VerifyAtomicResolution`(880)/`PreScanCheck`(1446) 四个 + `core/s2_bias_ledger.py`(554，纯 stdlib，
  顶层 import 无降级，且技能会在 `ledger_dir` 为空时直接拒绝执行) + `scan_planner:expand_series`(41)+
  `order_series_monotonic`(14) + `atomic_phase:plan_scale` 一族(114 纯算术) + `coord_epoch`(154)。
  **只移技能层 = 一条连扫几小时的序列没有证据落盘，而「有账」正是它存在的理由**
- **`cross_point_tip_check`（1）— C**：差 `FindCleanSpot`/`PreScanCheck`/`AssessFrameCorrugation`
  + `conduct/cross_check.py`(390，纯 stdlib，**是裁决规则的唯一真源**，技能自己刻意不写裁决)。
  **只移技能层 = 一个只会 `undecidable` 的壳**
- **`auto_tilt`（2）— C**：差 `TiltProbeCircle`（**唯一**测量来源）+ `instrument_profile`
  的 4 个入口（**都是顶层 import，无 try/except**）。
  `AutoTilt.execute` 第一件事就是 `get_tilt_calibration()`，读不到直接拒绝跑
  （「猜错方向不是把倾斜去掉，而是把它加倍」）；`TiltCalibrate` 算完 `G=−M⁻¹` 后唯一出口是
  `set_tilt_calibration(g, cond=cond)`，那个函数自带 `cond > 10.0 拒写` 的闸。
  **没有 profile ⇒ 一个永远拒绝跑、一个算完无处可写**
- **`line_sts_across_wall`（1）— C**：`plan()` 里就一个步骤 `SpectroscopyAtPositions`（`optional=False`）
  + `sts_line_plan`(779) 的 8 个入口 + `sts_workflow`(468) + `map_scope`(322) + `domain_reference`(323)
  ≈ **1892 行**。本文件 671 行里绝大部分是**拒绝闸**（`markers_unavailable`/`coord_epoch_mismatch`/
  `reference_version_conflict`/`reference_not_confirmed`…）。**移了闸而没有被闸的东西，
  等于把一个「一晚上的取谱」放给一条没人确认过的畴界**
- **`achieve_atomic`（1）— C**：9 个子技能**只有 1 个已移**（`GetZControllerState`）。
  **它就是那条阶梯本身（R1→R2→R3a/R3b→R4）；移了它 = 一个每一档都调不到的 for 循环**
- **`forge_au_tip`（1）— C（最深）**：helper 链 `_tip_phases`(2801) + `noble_tip_workflow`(1273) +
  `prepare_noble_tip`(526) + `_preflight`(591) ≈ **5191 行**，外加 8 个未移子技能。
  可降级的（try/except）：`io/coarse_map`·`coarse_map_provider`·`skills/verify:read_junction_state`·
  `core/tip_intent`·`monitoring/alerts`+`store`
- **`move_atom_to`（1）— C**：子技能 9/11 已移；技能自身**零外部旧仓函数**（只有 `math`，几何是纯的）。
  差 `ScanAt`（**A**）+ `VerifyAdatomAt`（188，自身只要 `math`）→ **`ExtractClusters`（678）**
  （`adatom_verify.py:96` 硬依赖，失败即 `return … error="缺依赖"`）。
  `verify` 参数默认 **True**，关掉之后第 181 行直接 `return` —— 搬也能搬，但搬出来的是一个
  「拖完就走、不复查」的原子操纵，与文件头「然后复扫确认」逐字矛盾。**扫描侧那一半解得开，判定侧解不开**
- **`sts_condition_series`（1）— C（链上）**：技能层**只差一个子技能** `SpectroscopyAtPositions`，
  但那个子技能自己是 C。`sts_workflow.py`(468，纯 python，可移)。**不能单独排期**
- **`spectroscopy_at_positions`（1）— C**：子技能 4/10 已移。
  **值得单说**：六个 todo 里**前五个都不压任何子系统**（`BiasSettleChange`·`ConfigureSTS`·
  `SetSTSMLSMode`·`SetSTSMLSVals`·`AcquireSTS` —— 纯硬件技能，「只是还没移」）。
  卡死的是第六个 `AssessSpectrum` → `vision/spectroscopy.py`（954）。`assess` 默认 True，
  而 D14 那条「连续 N 条 discard 就停批」的判据（722-733）**只认它的 verdict**。
  只移技能层 = 整批 dI/dV 在 `unrated` 上跑完，保护静默失效 —— 与文件里 706-713 那句
  「判据自己没跑成 ⇒ 判不了，不是不合格」正好撞上
- **`scan_until_atomic`（1）— C**：子技能 5/7 已移；旧仓函数只有一个常量 `SCALE_FULL_NMPP = 0.02`。
  差 `FullScan` + `AssessAtomicResolution`。**判据就是这个技能的循环条件
  （第 483 行的 `assess` 步决定继不继续），只移技能层 = 一个永远判不出「到了」的 while 循环**
- **`publication_frame`（1）— C**：子技能 10/13 已移。旧仓函数只有 `_tip_phases` 的三个小件
  `_data`(8)+`_ok`(5)+`_scan_path`(22) = **35 行，与那 2801 行的其余部分无关**
  —— 别因为 import 了 `_tip_phases` 就把整块算进来。差 `ScanAt`(A) + `AutoTilt`(C) +
  `AssessAtomicResolution`（第 317 行的 `P:assess` 是**无条件**的，`skip_tip_check=True` 也绕不过）。
  **全部立论是「入口闸：花几分钟去验，而不是拿一小时去赌」，判据缺席时它就是一小时的赌**
- **`verify_atomic_resolution`（1）— C**：子技能 0/2 已移（`AnalyzeScanImage`·`AssessAtomicPhase`，
  两个都是判据、都在 vision 上）。它是「唯一裁决口」（第 578 行注释）
- **`shape_tip_on_surface`（1）— C**：子技能 8/10 已移，差 `FindFlatRegion` + `AssessClusterRoundness`。
  `_ROUND_THRESHOLD_RETIRED` **双入口**拒绝（validate + plan_dynamic）——
  注释里记着「第一版只写在 plan_dynamic 里，而生成器的 `return` 被丢掉，于是它照跑不误」。
  深度包络那条见 §3.2
- **`prepare_noble_tip`（3）— C**、**`make_special_tip`（2）— C**：同一块
  （`_tip_phases` 1664 代码行 + 针尖登记表 + 六个 vision 判据子技能），**必须同批**。
  `make_special_tip` 的 8 个 todo 子技能里，**`BiasWiggle`（405 行）只 import `random`+`time`
  —— 纯硬件，不压任何东西**
- **`search_domain_boundary`（1）— C**：**本组唯一一个同时压着两个子系统的** ——
  vision（domain_phase 915 + atomic_phase 817 + domain_reference 323）**与**
  地图层（`io/map_analysis` 1206 + `map_scope` 322）

### paper（34 个技能 / 19 个模块）

**先纠正一条常见误解：权重是在的**，只是不在 `mast/training/` 下，在
`MASTv2/artifacts/legacy_models/`（resnet18_1ch 44.7 MB ×2 · vgg4_1ch 56.5 MB ·
attention_unet_1ch 206 MB），另有 `artifacts/mast_vision_v25.pt` 与 DINOv3 safetensors。
registry 注册的 5 个架构里**只有 `dueling_dqn` 没有任何权重文件**。

但**这不改变结论**：`registry.py:68` 的 `build_model` **根本不碰权重文件**，
只做 `KeyError` 检查然后 `return info.cls(**merged)` → **一个随机初始化的未训练模块**；
权重加载是调用方的事，而 `model_path` 的默认值是 `""`，**没有任何代码把 `artifacts/legacy_models/`
自动填进去**。`tip_assessment.py` 抬头第 17 行甚至写明「a non-empty string selects the
VisionModule branch and nothing else」—— 参数值连路径都不当。

**所以这批今天实际跑的就是经典回退路径。** 该做的是**移经典分支、砍掉 `model_path` 分支**。
唯三例外是 `PredictSpectrumFromTopo`/`PredictStructure_ASD`/`IdentifyTopology_CARP`，
它们 `required=True` 且**无回退**，移过来只会是永远报错的壳 → D 档。

另：`mast/skills/paper/` 下**没有任何模块定义 `validate_params`**（grep 为空）。
`_fit_utils.py` 只有一个函数被调到：`guarded_parabolic_min`（31-117，实际代码约 30 行），
全仓唯一 import 点是 `spectral_analysis.py:27`，被调两次。

- **`atom_jump`（1）— A**：`_statistical_detect`(162-184) 只要 `mean`/`std`。
  `_cnn_detect` 内联定义 `AtomJumpCNN`（**不走 registry**），全仓无此权重。
  唯一缺口：`load_spectrum` 的 `.txt/.csv/.asc/.npz` 分支（`.npy`/`.dat`/`.3ds` 本仓都有）
- **`background`（1）— A**：`poly2d_subtract`(332-375)。**别用 `fitPoly2d`** ——
  它是固定二阶 6 项；这里是 `order_x`/`order_y` 各 1..6 的张量积，外加一条
  `i+j > order_x+order_y` 裁剪（第 352 行）。设计矩阵要自己搭
- **`data_processing`（4）— A×3 / B×1**：
  - SubtractPlane_RANSAC — A（`ransacPlane`+`subtractPlane`；但 RNG 不同，
    `inlier_ratio`/`plane_coefficients` 不可能与金样逐位对上，按 `rng.ts` 抬头那条判据走）
  - LevelLines_Median — A · FindEmptySpot — A
  - CorrectDrift_XCorr — **B**：基线 `phaseCrossCorrelation` **永远做相位归一化**
    （`crossPowerSpectrum` 里逐点 `pr[i] = cr / den`），而 `drift_xcorr` 的默认是
    `normalization=None`（**普通互相关**，第 503-506 行明写「more robust to SPM line-noise
    than skimage's own "phase" default」）。且基线**只回 `shift`**，而技能 `data` 里三个键全要。
    缺：① 除法做成可关（~5 行）② 回传 `error`/`phase`（~10 行）③ `hanning`（3 行）
- **`deconvolution`（1）— B**：`richardson_lucy`(185-233) 每轮调两次
  **`scipy.signal.fftconvolve(mode='same')`**。缺 `fftconvolve2d`，约 40-60 行，零新 npm 依赖
- **`defect_cluster`（1）— D**：默认路径（`model_path=""`）就是 `sklearn.decomposition.PCA`；
  `cluster_latent` **无条件**用 `KMeans(random_state=42, n_init=10)` + `silhouette_score`。
  **没有任何纯 numpy 路**（若自写三件约 200-300 行则降为 B）
- **`denoise`（1）— A**：可达路径是 `scipy.ndimage.gaussian_filter` → `gaussianFilter2d` ✓
  （scipy 默认 `mode='reflect'`/`truncate=4.0`，与 `gaussianKernel(sigma, truncate=4.0)` 对得上）
- **`drift_bragg`（1）— B**：`maximum_filter(size=5)` ≡ `greyDilation(rectSE(5,5))` ✓；
  `gaussian_filter` ✓；`percentile` ✓；`np.gradient`/`fftshift` 各约 10 行。
  **缺的那一件（真活儿）**：`map_coordinates(order=3, mode="reflect")` ——
  `interpolate.ts:87` 现在是 `InterpOrder = 0 | 1`，抬头自述「order ≥ 2 要样条预滤波」。
  要把 `InterpOrder` 扩到 3 并实现 `spline_filter` 预滤波 + 三次基函数。**放最后**
- **`image_filters`（1）— A**：全部 `median`/`std`/`abs`/`sum`。
  **名字里的 "MorphOpen" 是第 734-750 行手写的一维行程长度开运算，不是 scipy —— 别误用 `greyOpening`**
- **`imspec`（1）— D**：`torch.jit.load`（第 944 行），`model_path` **required=True，无回退**
- **`line_check`（1）— B**（原判 C，我按判据改判）：`acquired_row_mask`(77)·`judge_frame`(58)→
  `_detrend`(7)·`trace_retrace_correlation`(71)→一维 `np.correlate(mode='full')`／
  二维转发 `_fwd_bwd_instability`(45)·`safe_mode_active`(6)。
  **这一整条链只要 numpy，不碰 torch/sklearn/scipy** —— `tip_metrics.py` 那三处
  `from scipy import ndimage` 属于 `_terrace_noise`/`_edge_resolution`/`_terrace_levels`，**本链不经过**。
  所以「压着 20206 行的 vision」在这里是**过度悲观**：实际需要 **5 个函数 ≈ 258 行 numpy**，
  不需要 `module.py`(897) / DINOv3 / joblib。**与 `prescan_check` 共用同一块**
- **`montage`（1）— D**：matplotlib(Agg) + font_manager + patheffects + AnchoredSizeBar，产物是 PNG。
  `_rescale_to_ppnm` 的 `zoom(order=1)` 基线能做，但那是这技能的 5%
- **`optimization`（2）— D**：`bo_suggest_next`(458-505) → sklearn GP(Matern nu=2.5,
  n_restarts=5) + `scipy.stats.norm`；`_fit_gp`(841-856) → sklearn GP(RBF)，
  `backend="dklgp"` 走 torch+gpytorch。失败时 `rng.uniform` 随机回退 ——
  **那是「随机撒点」，不是这个技能**。还叠着 4 个未移技能
- **`region_analysis`（4）— A×2 / D×2**：
  - SegmentRegion_UNet — A（`heuristic_segment`(36-42)：`np.quantile` → `percentile` ✓）
  - DetectAtoms_FCN — A（`heuristic_detect_atoms`(45-65)：`maximum_filter(size=2k+1)` ≡
    `greyDilation(rectSE)` ✓；`scipy.ndimage.label` 二维默认结构就是 4 连通 ≡ `labelConnected(mask,4)` ✓）
  - PredictStructure_ASD — D（required=True，空则 `success=False`，无回退）
  - IdentifyTopology_CARP — D（**`detectron2`**，连旧仓自带的 `pyruntime/Lib/site-packages/` 里都没有）
  - ⚠️ **这个模块永远到不了 complete**
- **`scan_crop`（1）— A**：`detect_solid_edges`(57-128)+`crop_unscanned`(131-158)，
  全部 `median(keepdims)`/`abs`/`mean`/`ptp`
- **`scan_diff`（1）— B**：`diff_scans`(220-277) 调 `data_processing:drift_xcorr`，
  **只取 `shift` 并 `int(round())`** —— 不要 `error`/`phase`。所以它比 `CorrectDrift_XCorr` 宽容，
  缺的只有「非归一化互相关 + hanning」+ `nanmean`（5 行）
- **`spectral_analysis`（2）— B×2**：
  - FitFano_Kondo — 三支 `curve_fit` **全部无 bounds**（基线 `curveFit` 的 `Model` 是任意回调，
    **这里不缺 bounds**）。三个模型：`fano_lineshape`(纯实数 ✓)·`frota_fano_lineshape`
    (复数 `sqrt(z)`，约 5 行内联)·`hurwitz_fano_lineshape`(**`scipy.special.digamma`**)。
    **缺 `pcov`**（20-30 行）；`digamma` 那一支三选一，可先落前两支
  - FitGap_BCS — **缺两件**：① box bounds —— scipy 一旦给 `bounds` 就**从 `lm` 切到 `trf`**，
    「加个 clamp」不等价 ② `pcov`
- **`spectral_unmix`（1）— D**：四选一**全是 sklearn**（NMF/PCA/FastICA/GaussianMixture），无 numpy 路
- **`tip_assessment`（2）— B×2**：两个 `execute`（269-300 / 382-414）**逐字同构**，
  文件抬头第 25 行自己写明「两条分支都是同一个函数」。**移过来是一份实现两个壳。**
  `heuristic_tip_score` 要 `_fft_quality_score`(`fft2`+`fftshift`+`partition` 取 top-10) ✓ ·
  `_noise_estimate`(`scipy.ndimage.laplace` → `laplace2d` ✓) · `histogram` ✓；
  缺 `fftshift`/`np.gradient`（零头）。**真正缺的那一件是 `safe_mode_active`** ——
  两条分支都要它，它决定 `is_good` 是否被压制，**是判决的一部分**
- **`autonomous`（7）— A×1 / C×6**：共同底座 `CompositeSkillGraph`+`GraphExecutor` → 本仓已有 ✓。
  - **AtomManip_SAC — A**：**七条里唯一子技能全齐的**（`SetBias`·`SetSetpoint`·`MoveToXY` 全已移）。
    无模型时是**直线行走**（`np.linalg.norm` + 归一化方向，1661-1663）
  - 其余 6 个 — C：卡在 `FullScan`/`AssessImageQuality`/`TipPulse`/`ConditionTip`/
    `ConfigureSTS`/`AcquireSTS` 六个未移技能上；`FindGoodRegion_UNet` 另压
    `vision.module`+`seg_utils:decode_rle`
  - **`AutonomousSurvey_Scanbot` 与 `ContinuousImaging_Auto` 全文无 torch、无 vision、无 model_path**
    （grep 为空），纯编排 —— 它们是 C 纯粹因为上层技能没移，不是因为 ML
  - 三条 RL 路（DQN/SAC/AutoOSS）**根本不经过 registry**，直接
    `torch.load(weights_only=False)` 整个 pickle；且全仓无 DQN/SAC 权重

---

## 六、我核过的、与子 agent 报告相左的三条事实

盘点分七组并行做，有三处结论互相矛盾。我逐条去仓库核了，结果如下 ——
**分派时以这一节为准。**

1. **`findLatestSaved` 确在本仓**：`packages/host/stm-skills/src/l0/frames.ts:138`，
   `suffix` 是参数（调用点在第 266 行用 `.sxm`，`.dat` 直接能用），另有 `sessionDir`(188)/
   `existingDirs`(212)。
   → 「本仓 grep 不到 `candidateSaveDirs`/`findLatestSaved`」的说法**不成立**。
   `AcquireDeltaFCurve` 因此只差 `_reshape_spectrum`(53)，与 spectroscopy 同批即消失。
   缺的两路（`known_scan_dirs` / `working-sessions`）已在 `spec/deviations.md:459` 的 D-FRAME-1 登记过。

2. **`mast/data/quality.py` 的 `find_peaks` 与 `median_filter` 确是死 import**：
   `find_peaks` 只出现在第 30 行的文档串里，`median_filter` 函数体一次都没调；
   真正被调的只有 `convolve2d`（第 109 行）。
   → `AssessImageQuality`（及其下游 SurveySurface / ConditionTip / BatchRegionsScan）
   **不欠 `find_peaks`**。

   但要分清：`find_peaks` 在 `mast/vision/` 里是**真实且反复出现的缺口** ——
   `seg_scale_adaptive.py:155`/`:222`、`scan_prep.py:320`、`classical_seg.py:195`、
   `spectral_peaks.py:117` 五处真调用，全都要 `prominence` 且要读回 `props["prominences"]`。
   两件事同名，但不是同一件。

3. **`SafeCall` 确无 per-call 选项通道**：`kernel/src/skill-kernel.ts:102` 是
   `(method: string, ...args: unknown[]) => Promise<SkillCallRecord>`，全仓 `recvTimeout`
   与 `waitBudget` 各自零命中。
   → `AcquireSTS` 的 B 档成立；`ScanAt`/`PreScanCheck` 共用的 `wait_budget_s` 也确实要补。

另有一处是**判据分歧而非事实分歧**，我按任务给的定义裁到 B，理由写在 §3.3：
`AssessAtomicPhase` 与整个晶格判据底座。

---

## 七、一句话的建议

**先把 `builtins.spectroscopy`（37+1）与 `composite.scan_at`（1）这两条做掉。**
前者一批清掉剩余量的 20% 并解锁整条谱学链，后者是一个 329 行的纯函数却卡着八条链。
两者都不压任何子系统 —— **这在剩下的 186 个里是少数情况，应该先用掉。**

随后按 K2（113 行）→ K1（236 行）→ ExtractClusters（270 行）的顺序铺数值底座，
每一件都是几百行纯 numpy、零外部缺口，而它们合起来解锁本族十余个技能，
并把 `mast/vision/` 那 20206 行里真正要移的部分从「一整个子系统」压到「几块可点名的判据」。

**`find_peaks`（带 prominence）是全盘杠杆最大的单件缺口**（一件解锁 7 个），
`curveFit` 回 `pcov` 次之（一件解锁 3 个，且以后每个拟合技能都要报参数误差）。
