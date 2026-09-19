# `builtins.*` 剩余 34 个模块 / 43 个缺口技能的依赖盘点

> **分母出处**：`spec/progress.json`。`modules[*].complete === false` 且以 `builtins.` 开头的模块 **34** 个，
> 其中 `skills[*].status !== 'done'` 的技能 **43** 个。这个数是算出来的，不是手数的：
> ```
> node -e "const p=require('./spec/progress.json');
>   const m=Object.entries(p.modules).filter(([k,v])=>!v.complete&&k.startsWith('builtins.')).map(([k])=>k);
>   console.log(m.length, Object.entries(p.skills).filter(([n,v])=>m.includes(v.module)&&v.status!=='done').length)"
> → 34 43
> ```
>
> **两项前置核对（都做过）**：
> - 43 个名字在 `spec/golden/skills.json`（515 条）里**一个不缺**，`module` 字段也逐个对得上 —— 没有「旧仓里没有这个技能」。
> - `packages/host/*/src/` 里 `export const <技能名>`（排除 `*.test.ts`）**43 个零命中** —— 没有「其实已经落了」。
>
> **判据纪律**：依赖按**函数级**追 —— 看 `execute` / `validate_params` 实际调到哪些函数，那些函数各自又要什么，
> 一路追到底。不看 import 行，不拿文件当依赖单位。本轮有 **4 处**正是靠这条纪律翻案的
> （`AcquireSignalPoint` · `CoarseMotionSelfCheck` · `AssessAtomicPhase` · `AcquireDeltaFCurve`），见 §四。

---

## 一、一页纸总表

四档合计：**A 18 · B 10 · C 5 · D 10 = 43**。

「落地成本」一律指**要自己写的那部分**，分「判据本体」与「技能壳」两栏，单位是旧仓 Python 行
（本仓已落地的同族技能实测 TS ≈ Python × 1.0–1.2，出处：`AssessAtomicResolution` py `atomic_lattice.py:145-229` = 85 行
→ ts `analysis-lattice.ts:506-606` = 101 行）。

### A 档 —— 依赖全在本仓，只要写技能壳 + 判据本体（18 个 / 18 个模块）

| # | 模块 | 缺口技能 | 判据本体 | 技能壳 | 卡在哪（都不是屏障，只是要写） |
|---|---|---|---|---|---|
| A1 | `builtins.barrier_height` | MeasureBarrierHeight | — | **230** | 6 个子技能全 done（GetBias·SetBias·ConfigureSTS{,Channels,Timing}·AcquireSTS）；`polyfit` 在 `savgol.ts:104` |
| A2 | `builtins.bias_series` | AcquireBiasSeries | — | **118** | ScanAt·AssessFrameTrust 全 done。⚠️ `:157` 那条调用是死代码，见 §四-6 |
| A3 | `builtins.coarse_step_calib` | CalibrateCoarseStep | — | **155** | 8 个子技能全 done；`phase_shift` 15 行要自己拼（`fft2`/`ifft2`/`hanning`/`median` 都在，但 `phaseCrossCorrelation` 不给锐度 SNR，`_MIN_CORR_SNR=12.0` 全靠它）。⚠️ 同样撞死代码 |
| A4 | `builtins.deltaf_curve` | AcquireDeltaFCurve | — | **221** | **零 `context.run`**；10 个 Nanonis 动词全在 `generated/methods.ts`；`reshapeSpectrum` 已在 `kernel/src/spectroscopy.ts:133` |
| A5 | `builtins.pattern` | RunGridExperiment | — | **264** | `graph-executor.ts` 一件不缺（`PlanSource` 含 `AsyncIterable`(:319)、异步分支 :504、`runPlan`(:373)、`setPartialDefault`(:364)、`abortErrorText`(:221)）。5 个 Pattern 动词全在 |
| A6 | `builtins.optics_scan` | **AcquireSignalPoint** | **106** | 27 | ⚠️ **与分派单不符** —— 它不是 D，全程不碰 registry，见 §四-1 |
| A7 | `builtins.tip_spectro_assess` | **AssessAtomicPhase** | **0** | **135** | 判据本体**一行都不用写** —— `assessAtomicPhase` 已在 `vision/src/atomic-phase.ts:402`。只欠 `resolve_substrate` 注入口，而它可降级，见 §四-3 |
| A8 | `builtins.spectral_peaks` | FindSpectralPeaks | **142** | 89 | 三个 scipy 件本仓**全有**：`savgolFilter`(savgol.ts:214) · `findPeaks`+prominence/width(peaks.ts:287) · `curveFit` 无 bounds 那一支(curve-fit.ts:198) |
| A9 | `builtins.tilt_probe` | TiltProbeCircle | **135** | **295** | `fit_circle_tilt` 是**一次 3/4 列最小二乘**（`tilt.py:673-683`），`lsq.ts:44 lstsqQr` 直接对得上。全仓壳/本体比例最悬殊的一个 |
| A10 | `builtins.feedback_tracking` | AssessFeedbackTracking | **198** | 137 | `measureCell` 已 done；`lstsqQr` + `nd.ts:185 gradient2d` 齐。要给 `loadFrame` 补 6 个字段（Current 通道 / speed / i_gain / p_gain / scan_angle） |
| A11 | `builtins.slow_drift_skill` | AnalyseSlowDrift | **288** | 151 | 零 scipy。`rfft`/`rfftfreq` 没有，但那是 `fft` 的一行切片（shim ~15 TS 行），不算缺件。给 `loadOne` 补 2 字段 |
| A12 | `builtins.flat_region` | FindFlatRegion | **34**（+45 可选） | **716** | 成本 95% 在壳里。`kde_layers` **两重降级**：`same_terrace` 默认 `False`(`:289`) + 整段 try/except(`:469-491`)。它那一路的三个 scipy 件（`gaussianFilter1d`/`findPeaks(prominence)`/`medianFilter2d`）本仓全有，建议顺手一起上 |
| A13 | `builtins.frame_tilt` | AnalyzeFrameTilt | **286** | 183 | 分割那一路（`_segmentation_step_signal` → `seg_scale_adaptive` 446 行 + 7 个本仓没有的 scipy/skimage 原语）**旧仓自带 try/except**（`tilt.py:405-406`）且判据是「或」（`:434`）—— 缺它只会更宽松。`plane.ts` 的 `noiseFloor`/`lstsqPlane`/`fitPlaneRobust` 全对得上，连 `RANSAC_SEED=42` 都同种子 |
| A14 | `builtins.spectrum_assess` | AssessSpectrum | **514** | 157 | **全链零 scipy**。`assessIv`/`assessIz` 已在 `vision/src/spectroscopy.ts:115/184`，字段逐个对上；取列/头判读件在 `analysis-tip.ts:211/230/251` 已有 |
| A15 | `builtins.domain_assess` | AssessDomainPhase | **645** | 147 | 零 scipy。⚠️ `domain_reference.py` 那 207 行**可以整块推迟**，行为一字不变，见 §四-7 |
| A16 | `builtins.herringbone_assess` | AssessHerringbone | **840** | 222 | 零 scipy（`gaussianFilter2d` 顶 `double_tip._morphology_ratio`）。`double_tip.py` 只欠 8 个私有件（248 行），另外 5 个不在 `detect_double_tip` 调用路径上、**不欠** |
| A17 | `builtins.coarse_selfcheck` | CoarseMotionSelfCheck | — | **418** | ⚠️ **与上一轮不符** —— 缺的那 693 行**贡献 0 条判据**，见 §四-8 |
| A18 | `builtins.envelope_reconcile_skill` | ReconcileSafetyEnvelope | **312** | 64 | 只读路径。三个硬件读动词本仓都在发；`SafetyLimits` 在 `safety-tables.ts:12`；XY 那一对已有 `piezo-reconcile.ts:72`。**`apply=true` 要先拍板口径**，见下 |

> **A18 的那个口径**：`apply=true` 压着 `admin/override_store`（555 行，本仓零命中）。
> 建议照 `tip-selfcheck.ts:154 Sheet.missing()` 的范式**显式拒绝**，而不是静默退化成一个只报告的技能 ——
> 后者会让 `metadata.safety_level=CONFIRM` / `category=WRITE` 变成一句假话。
> 另外 `_get_effective_limits` 在本仓的对照物是 `deps.effectiveLimits?.() ?? DEFAULT_SAFETY_LIMITS`
> 这个注入口（`l0/piezo-check.ts:45`，登记在 D-LIMITS-1，生产侧尚未接线），报文里必须明说
> 「本仓没有管理员覆写层，生效限值 = 出厂默认」。

### B 档 —— 差一件具体的东西（10 个 / 10 个模块）

| # | 模块 | 缺口技能 | 判据本体 | 技能壳 | 差的那一件 |
|---|---|---|---|---|---|
| B1 | `builtins.barrier_map` | MapBarrierHeight | — | **157** | 未移的 **MeasureBarrierHeight**（A1） |
| B2 | `builtins.clean_tip` | CleanTipUntilBarrier | — | **118** | 同上（另三个子技能 BiasPulse·TipShape·GetBias 全 done） |
| B3 | `builtins.best_frame` | TrackBestFrame | — | **208** | 常数 `DEFAULT_MIN_CONCENTRATION = 300.0` 的**单一真源**（现住 `composite/publication_frame.py:60`）。本仓 `lattice-multiframe.ts:56 MIN_CONCENTRATION = 20.0` 是**另一个数**，顶不了 |
| B4 | `builtins.bias_wiggle` | BiasWiggle | — | **243** | `SafeCall` 的**中止清理通道**。`gated-call.ts`（**47 行**）只有 `{call, abortLatched}`；`Bias_Set` 不在 `ABORT_SAFE_WRITES`（`safety-tables.ts:140-190` 零命中），`isReadVerb` 判 false ⇒ `isAbortSafe` false ⇒ `gated-call.ts:39-45` 拒。需要的位置精确到行：`bias_wiggle.py:235-236` 与 `:243-244`（`_restore` 里，由 `execute:363` 无条件调用） |
| B5 | `builtins.frame_drift_skill` | MeasureFrameDrift | **211** | 190 | **FFT 线性（零填充）二维互相关，mode='full'**。`correlate2d`(correlate.ts:130) 只做 `'same'` 且是直算三重循环（抬头 `:126-128` 自陈 full/valid 未实现）；`phaseCrossCorrelation`(fft.ts:492) 是**被弃的那条路**，见 §四-13 |
| B6 | `builtins.tip_spectro_assess` | AssessShockleyOnset | **230** | 142 | `curveFit` 的 **box bounds（trf）**。`spectroscopy.py:307-314` 的 `w_lo` 是物理先验，`:305-306` 明写「没有它，一个 tip switch 的单点尖峰会被拟合成宽度→0 的『完美台阶』，r² 还很高」 |
| B7 | `builtins.dispersion_fit` | FitDispersion | **216** | 209 | **两件**：`curveFit` bounds（`standing_wave.py:148`，且 `:157`「解落在边界上就丢掉」这条判据本身依赖 bounds 存在）+ **`scipy.special.j0`**（`:116` 与 `:135`，全仓 `bessel|j0` 零命中） |
| B8 | `builtins.atomic_lattice` | CalibratePiezoFromLattice | **277** | 70 | **3×3 非线性方程组求根器**（顶 `scipy.optimize.fsolve`）。必经 —— `lattice_calibration.py:468-472` 的 except 直接 `return None, inf`，调用方随即 `reason="affine_no_solution"`。**没有闭式解那一支**：12 个起点扫描 + 按 ‖M−I‖ 最小定支（`:492-515`） |
| B9 | `builtins.atomic_multiframe` | CalibratePiezoMultiAngle | **255** | 70 | 同 B8（经 `lattice_multiframe.py:421` → `solve_affine`），另共用 `solve_affine` 96 行 |
| B10 | `builtins.scan_intel_selfcheck` | ScanIntelSelfCheck | **60**（probe 本体） | 330 | `scan_resolver.preview` 的 **27 行薄封装**（`resolveScan` 已在 `scan-resolver.ts:376`，但 `export function preview` 零命中）。另有两项要换判据而不是照移，见 §四-10/11 |

### C 档 —— 压着一整个子系统（5 个 / 5 个模块）

| # | 模块 · 技能 | 压着什么 | 行数 | 只移技能层的后果 |
|---|---|---|---|---|
| C1 | `characterise_noise` · CharacteriseCurrentNoise | `mast/monitoring/` **12142** + `envhistory/zburst` 545，**且必须有一个 2 kHz 采集进程在跑**（`service.py` 1315 + `pump.py` 1450 + `aux_channels.py` 2257） | 12687 | **诚实硬失败**：`:422-426 len(runs)<5` → `success=False`「监控可能没在采」。6 个子技能已全 done，图执行器有对照物。但 `get_store()` 永不返 None（见 §四-15），会凭空造一个空 sqlite |
| C2 | `history_query` · QueryMonitorHistory | 同上。**读侧只欠 45+93 行**（`aux_query` `store.py:832-876` · `EnvHistoryStore.series` `:277-369`），但那张表由 `aux_channels.py`(2257)+`service.py` 写入，没有采集器就永远是空的 | 读侧 138 | **诚实**，四条路都有明写的话；`:247-253` 还把「桶在但全空」单独识别出来。⚠️ `:226` 是一个真 bug，见 §四-4 |
| C3 | `quiet_drift` · CharacteriseQuietDrift | 同 C2（只欠 `get_store_if_exists` + `aux_query` **45 行**） | 读侧 45 | **诚实**三道闸。**`_spectrum`（`:204-254`，51 行）完全自成一体、一行子系统都不碰**，且带 2026-08-20 的阈值教训（固定「3 倍本底」在长序列上必然误报 → `floor*1.25*sqrt(2·lnN)`）—— 这 51 行值得单独先移 |
| C4 | `hardware_events` · ReadHardwareEvents | `mast/buffer/` **1227**（`service.py` 882 + `schemas.py` 293 + `active.py` 42 + `__init__` 10）。monitoring 那半是**可选增强**，三层护栏 `:107-124` | 1227 | **功能消失但不说谎** —— `:200-202` 逐字「**这不代表没有事件，是这条路读不到**」，`:224-230` 把 `available=False` 与 `n==0` 分成两句话。⚠️ 但有一处三态塌成两态，见 §四-16 |
| C5 | `clean_spot` · FindCleanSpot | 扫描地图 + 实验记录：`map_scope` 322 · `io/map_analysis` 1206 · `io/exp_map` 1015 · `logging/storage` 1617 · `logging/experiment_log` 502 | 4662 | **文字诚实、动作照做** —— `map_known=False` 时 `:322-325` 明写「读不到实验记录……无法确认此处是否干净」，但 `:331` 照样 `success=True` 返回一个在**零个避让圆**上算出来的落点。<br>**最小可用切片 1007 行**（不接数据库，只用已落地的 `tip-crash-tracker.ts:203 crashPoints` 当唯一避让源）；`nearest_clean_from`(249 行)全程 `math.hypot`，不碰 numpy、不碰数据库 |

### D 档 —— 压着的东西本仓架构原则上就不要（10 个 / 3 个模块）

**已按分派单要求确认，不展开。** 三个 `optics_*` 模块开着是故意的。

屏障核对（上一轮的说法，逐项复核）：
- `mast/instruments/base.py:215` 的 `_check_limits`，函数体到 `:221`，**7 行**，唯一调用点 `base.py:136`（`MotionAxis.move_to` 内）—— **行号与行数都对**。
- 整个 `mast/instruments/` = **2113 行**（`base` 329 · `registry` 245 · `config` 129 · `delay_line` 108 · `pi_gcs` 262 · `pztc_nm003` 481 · `thorlabs_kinesis` 245 · `thorlabs_pdxc2` 250 · `__init__` 64），压着 Thorlabs Kinesis / PI GCS / PDXC2 / PZTC-NM003 四家 DLL + 串口驱动。

| 模块 | 技能 | registry 落点（逐个核过） |
|---|---|---|
| `builtins.optics_stage`（8） | ListOpticalDevices · OpticalStageGetPos · OpticalStageMove · OpticalStageWiggle · StopOpticalStage · HomeOpticalStage · DelayLineGetDelay · DelayLineMoveTo | `optics_stage.py` **`:85 :147 :232 :336 :453 :515 :551 :614`** —— 8 个 `execute` 全部第二句就是 `get_instrument_registry()` |
| `builtins.optics_scan`（1/2） | OpticalStageScan | `optics_scan.py:314`（`execute` 在 `:303`） |
| `builtins.optics_pump_probe`（1） | PumpProbeScan | `optics_pump_probe.py:420`（`execute` 在 `:405`），第二次 `:477` |

**⚠️ 这一档是 10 个，不是 11 个** —— `AcquireSignalPoint` 不在里面，见 §四-1。

---

## 二、A 档的分批建议

切法：**按「一批能不能整模块收口」切**。18 个 A 加上 10 个 B 共 28 个技能，分 5 批，
**收口 26 个模块 —— `modules_complete` 从 92 到 118（共 165）**。
（34 个模块里剩 8 个收不了：5 个 C + 3 个 `optics_*`；其中 `optics_scan` 是「落了一半、
另一半永远不落」，见 §四-2。）

### 批 7a —— 势垒链与线缆（8 个技能 · **7 个模块整模块收口**）

`MeasureBarrierHeight` · `MapBarrierHeight`(B1) · `CleanTipUntilBarrier`(B2) ·
`AcquireBiasSeries` · `CalibrateCoarseStep` · `AcquireDeltaFCurve` · `RunGridExperiment` · `AcquireSignalPoint`

**为什么能一起做**：八个全是「线缆 + 少量本地判据」，**零 vision 依赖、零数值缺口**。
共用面三处：① STS 四件套（已全 done）被 A1/B1/B2 共用；② `ScanAt`（已 done）被 A2/A3/B1 共用；
③ `reshapeSpectrum`(`kernel/src/spectroscopy.ts:133`) + `findLatestSaved`/`sessionDir`/`existingDirs`
(`l0/frames.ts:138/188/212`) 被 A4 与 A1 共用。
B1/B2 差的那一件就是同批的 A1 —— **必须同批，分开等于把同一条链搬两次**。

收口：`barrier_height` · `barrier_map` · `clean_tip` · `bias_series` · `coarse_step_calib` ·
`deltaf_curve` · `pattern`（7/7）。
（`optics_scan` **永远到不了 complete** —— 2 个里 1 A 1 D，落 A 那个的收益是技能数不是模块数，
同 `paper.region_analysis` 的先例。）

必写行数：230+157+118+118+155+221+264+133 = **1396**。

**这一批登记两条形状**（都在 §四）：ScanAt 不返回 `scan_path` 导致的两段死代码（§四-6）；
`RunGridExperiment` 是本仓**第一个用生成器计划**的 composite（`src/composite/` 里 `function*` 零命中，
`runPlan` 的异步分支至今没有消费方）。

### 批 7b —— `vision/tilt` 一族与 `loadFrame` 扩字段（6 个 · **5 个模块收口**）

`TiltProbeCircle` · `AnalyzeFrameTilt` · `AssessFeedbackTracking` · `AnalyseSlowDrift` ·
`FindFlatRegion` · `AssessAtomicPhase`

**为什么能一起做**：共用件两簇。
① **`vision/tilt.py` 那一族**：`noise_floor`(18) / `_lstsq_plane`(12) / `fit_plane_robust`(63) /
`plane_subtract`(10) 本仓 `plane.ts:111/144/221/314` 已有（连 `RANSAC_SEED=42` 都同种子）；
要新写的 `detrend_quadratic`(38) / `structure_dominance`(26) / `step_dominance_multiscale`(25) /
`estimate_tilt`(89) / `fit_circle_tilt`(97) / 两个 dataclass(65) **全住在同一个旧仓文件里**，
`TiltProbeCircle` 与 `AnalyzeFrameTilt` 共用，`FindFlatRegion` 用它的 `noise_floor`+`plane_subtract`。
② **`loadFrame` 扩字段**：`AssessFeedbackTracking` 要 6 个（Current 通道 / speed / i_gain / p_gain /
scan_angle），`AnalyseSlowDrift` 要 2 个（`line_time_s`（注意旧仓 `atomic_multiframe.py:83` 是
`2.0 * scan_time`，**往返**）与 `width_nm`）—— 一次改，两个受益。

`AssessAtomicPhase` 放这一批是因为它**判据本体零行**（`assessAtomicPhase` 已落），
只要壳 + `resolve_substrate` 注入口，而那个注入口 `FindFlatRegion` 的 `parse_quantity`
（`kernel/src/si.ts:128`）一样是现成的 —— 属于同一类「壳活」。

收口：`tilt_probe` · `frame_tilt` · `feedback_tracking` · `slow_drift_skill` · `flat_region`
（`tip_spectro_assess` 1/2，另一半在 7c）。

必写行数：判据本体 135+286+198+288+34+0 = **941**，技能壳 295+183+137+151+716+135 = **1617**。

### 批 7c —— numerics 三件缺口 + 吃它们的技能（6 个 · **6 个模块收口**）

`FindSpectralPeaks`(A8) · `AssessShockleyOnset`(B6) · `FitDispersion`(B7) ·
`MeasureFrameDrift`(B5) · `CalibratePiezoFromLattice`(B8) · `CalibratePiezoMultiAngle`(B9)

**为什么能一起做**：这一批的共用件是**三件数值原语**，一次把 numerics 的缺口补齐：
`curveFit` 的 box bounds（B6+B7 共用）· FFT 线性互相关（B5）· 3×3 非线性求根（B8+B9 共用）。
`FindSpectralPeaks` 是同族的对照组 —— 它用同一套 `findPeaks`/`savgol`/`curveFit`，但**不需要 bounds**，
先落它能把「无约束那一支」的金样钉住，再动 bounds 就有参照。
B8/B9 还共用 `solve_affine`(96) 与 `lattice-peaks.ts` 已有的 `findLatticePeaks`/`isRidgePoint`/
`planeSubtractLstsq`。

收口：`spectral_peaks` · `dispersion_fit` · `frame_drift_skill` · `atomic_lattice`(3/3) ·
`atomic_multiframe`(2/2) · `tip_spectro_assess`(2/2，接上 7b)。

必写行数：判据 142+230+216+211+277+255 = **1331**，技能壳 89+142+209+190+70+70 = **770**。
（三件原语本身的行数**查不到** —— 见 §三。）

### 批 7d —— 三块大判据本体（3 个 · **3 个模块收口**）

`AssessSpectrum` · `AssessHerringbone` · `AssessDomainPhase`

**为什么能一起做**：三个都是「**零 scipy、零子系统、纯判据量大**」，而且共用本仓**已落地**的同一组底座：
`seg-texture.ts` 的 `flattenRobust`/`levelIterative`/`detectTexture`(:207/155/332) ·
`atomic-phase.ts` 的 `angularConcentration`/`DEFAULT_CONCENTRATION_MIN`(:196/94) ·
`frame-validity.ts:125 judgeFrame` · `tip-metrics.ts` 的 `detrend32`/`fftSharpness`(:155/211)。
`AssessHerringbone` 与 `AssessDomainPhase` 还共用 `herringbone.PERIODS_IN_FRAME_OFF`
（`herringbone.py:257-258`，两行常量 —— 不需要为它搬整个 herringbone）。

**这一批只有 3 个技能，但行数是 7a 的 1.4 倍**（判据 514+840+645 = **1999**），
所以不按技能数凑，按行数它就是一整批。
`AssessDomainPhase` 可以**只做指纹那一半**（`extract_fingerprint` 233 + `classify` 84 + 辅助），
`domain_reference.py` 那 207 行整块推迟，行为一字不变 —— 见 §四-7。

收口：`spectrum_assess` · `herringbone_assess` · `domain_assess`。

### 批 7e —— 自检与对账（5 个 · **5 个模块收口**）

`CoarseMotionSelfCheck`(A17) · `ReconcileSafetyEnvelope`(A18) · `ScanIntelSelfCheck`(B10) ·
`TrackBestFrame`(B3) · `BiasWiggle`(B4)

**为什么能一起做**：前三个是**同一条纪律**的三份卷子 ——「子系统缺席时怎么说话」。
本仓已有范式 `l0/tip-selfcheck.ts:154 Sheet.missing()`（`ok=false` 且 `blocking=true`，
措辞点名缺什么、在哪一批），三个自检照抄同一个 `Sheet`。
它们共用的本仓件也是同一组：`instrument-profile.ts`(389) · `coarse-drive.ts`(363) ·
`vacuum-interlock.ts`(665) · `safety-tables.ts`(190) · `qplus-amplitude.ts`(132)。
后两个（B3/B4）是两个孤儿 B，各差一件很小的东西（一个常数 / 一个内核入口），
塞进来填批次 —— 它们与自检没有共用件，只是**不值得单独开一批**。

收口：`coarse_selfcheck` · `envelope_reconcile_skill` · `scan_intel_selfcheck` · `best_frame` · `bias_wiggle`。

必写行数：418+376+（60+330）+208+243 = **1635**。

**这一批要先拍板三个口径**（都在 §四）：`apply=true` 的显式拒绝（A18 那条注）；
`is_customised` 整项砍还是换判据（§四-11）；`registry` 那一项换成覆盖率（照 `tip-selfcheck.ts:34-40` 已判过的）。

### 建议的第一批

**批 7a。** 三条理由：
1. **模块收口最多**（7 个），而其余四批分别是 5 / 6 / 3 / 5；
2. **零数值缺口、零 vision 依赖** —— 唯一要拼的是 `phase_shift` 那 15 行，且四个原语全在；
3. 它是唯一一批**内部自解锁**的（A1 一落，B1/B2 当场变 A），其余批次的 B 都要先补 numerics 原语。

---

## 三、B 档缺件单（按「一件解锁几个」排，已去重）

> **去重口径**：一个技能只在它**最上游**的那件东西下面数一次。
> `AssessShockleyOnset` 同时欠 bounds 和（可降级的）`resolve_substrate`，只计在 bounds 下。
> `FitDispersion` 同时欠 bounds 与 `j0`，**在 bounds 下计 1，在 j0 下不再重复计数**。

| 缺的那一件 | 在哪 · 出处 | 规模 | 解锁（去重） |
|---|---|---|---|
| **`MeasureBarrierHeight` 本体** | 它自己是 A 档 | **230 行** | **2** —— MapBarrierHeight · CleanTipUntilBarrier |
| **`curveFit` 的 box bounds（trf）** | `curve-fit.ts`（288 行）现在全走无约束 LM，`:198` 的 opts 只有 `{maxIterations, ftol}`。消费方 `spectroscopy.py:309-314`（5 参、两侧界）与 `standing_wave.py:148`（4 参） | **查不到** —— 这是一次**算法替换**（LM → trf 反射变换），不是给 LM 打补丁，没有可引的行数，不估 | **2** —— AssessShockleyOnset · FitDispersion |
| **3×3 非线性方程组求根器**（顶 `scipy.optimize.fsolve`） | 被求解的 `eqs` 定义在 `lattice_calibration.py:463-466`，**是二次的**；调用点 `:495`，12 个起点（`:492-493`） | **查不到**（解析 Jacobian 的阻尼 Newton 可行，但行数没有出处）。**另需共用的 `solve_affine` 96 行**（`:428-523`，上一轮说 98 行，差 2） | **2** —— CalibratePiezoFromLattice · CalibratePiezoMultiAngle |
| **FFT 线性（零填充）二维互相关，`mode='full'`** | 地基 `fft2`(fft.ts:306)/`ifft2`(:313) 已有。`correlate2d`(correlate.ts:130) 抬头 `:126-128` 自陈只做 `'same'`、full/valid 未实现，且是直算三重循环（256² 三次 ≈ 1.3e10 次乘加） | **查不到**（本仓无对照物） | **1** —— MeasureFrameDrift |
| **`SafeCall` 的中止清理通道** | 照 `emergencyCall`(`skill-kernel.ts:206-212`) / `slowCall`(`:213-222`) 加**第三个命名入口**。两处注释都明写反对可选参数：「这条路谁在走、走了几次，要能一眼 grep 出来」 | **查不到**（参照两个现有入口）。**不要**把 `Bias_Set` 塞进 `ABORT_SAFE_WRITES` —— 那张表按「停」的语义建（`gated-call.ts:14-16`），`Bias_Set` 没有哪个参数形能表达「停」 | **1** —— BiasWiggle |
| **`scan_resolver.preview` 薄封装** | `resolveScan` 已在 `scan-resolver.ts:376`；`export function preview` 全仓零命中 | **27 行** | **1** —— ScanIntelSelfCheck |
| **`DEFAULT_MIN_CONCENTRATION = 300.0` 的单一真源** | 现住 `composite/publication_frame.py:60`（`ScanPublicationFrame` 未移）。`lattice-multiframe.ts:56` 的 `20.0` 是另一个数 | **1 行**（但要先定它住哪） | **1** —— TrackBestFrame |
| **`scipy.special.j0`**（第一类零阶贝塞尔） | `standing_wave.py:116` 与 `:135`；全仓 `bessel\|j0` 零命中 | **查不到** | **0 新增** —— 只与 bounds 叠在同一个 FitDispersion 上 |

**两件「看着缺、其实不缺」**（按纪律必须点出来，免得被当成缺口再排一次）：

| 看着缺 | 实际 | 依据 |
|---|---|---|
| `resolve_substrate`（`core/sample_facts.py` 175 行 → `knowledge/` **30570 行**） | **不是缺口，是已有的注入口范式** | 本仓 `analysis-clusters.ts:612 substrateTolerance`（`{nearestNeighborNm: (() => number\|null) \| null}`，**默认关**）已经这么处理过一次，`:604-610` 的抬头逐字写明理由。三个消费方各自的降级都是**诚实拒绝**：`AssessAtomicPhase` 只是不做那一项比对（`tip_spectro_assess.py:337` 注释「0 或推断不出来时只是不做这一项比对，**不算失败**」，`expected_a=None` 原样传给 `assess_atomic_phase`）；`AssessShockleyOnset`/`AssessHerringbone` 变成「`expected_onset_v`/`period_prior_nm` 事实上必填」 |
| `np.fft.rfft` / `rfftfreq` | **不是一件东西** | `rfft(y)` = `fft(y)` 取前 `n/2+1` 格，`rfftfreq` 是纯算术。`fft.ts` 有 `fft`(:258)/`ifft`(:264)。shim 十几行 |

---

## 四、⚠️ 与现状不符的地方（18 条）

> 分五类：**旧仓自带的 bug** 4 条（4-4 · 4-5 · 4-16 · 4-17）· **旧仓的文档与代码矛盾** 2 条（4-12 · 4-13）·
> **上一轮盘点已过期或判错** 5 条（4-1 · 4-3 · 4-8 · 4-9 · 4-14）· **本仓架构使某判据不成立** 3 条（4-2 · 4-11 · 4-15 的死分支）·
> **新旧两仓都成立的死代码 / 空存储 / 分派单自身的错** 4 条（4-6 · 4-7 · 4-10 · 4-18）。

### 4-1. `AcquireSignalPoint` 不是 D 档 —— D 档实际是 10 个，不是 11 个

分派单写着「`optics_scan` 2 个技能是 D」。核对结果：

- `AcquireSignalPoint.execute` 在 `optics_scan.py:100-132`，**整个函数体里没有一次 `get_instrument_registry`**
  （对照：同文件 `OpticalStageScan.execute:303` 在 `:314` 就取 registry）。
- 它的调用面只有三个函数，全在 `optics_acquire.py`：`parse_indices`(`:37-48`，`optics_scan.py:102` 调) ·
  `PointAcquirer.__init__`(`:148-165`，`:108` 调) · `PointAcquirer.acquire`(`:208-254`，`:116` 调)。
  `acquire` 内部只往下调两个同文件纯函数 `nanonis_scalar`(`:51-70`) 与 `mean_std`(`:92-100`)，
  I/O 全走 `self._ctx.safe_call("Current_Get")`(`:227`) 与 `safe_call("Signals_ValGet", xi, 0)`(`:241`)。
- `optics_acquire.py:10-11` 的模块 docstring 逐字：
  「**Nothing here touches the instruments registry** — motion is the caller's job;
  this module only reads Nanonis through `context.safe_call`.」
- 可达函数体合计 **106 行**（12+20+9+18+47）。同文件另外 63 行（`signal_names` · `resolve_lockin_index` ·
  `value_columns` · `plot_series` · `is_empty` · `configure_trigger`）只有 `OpticalStageScan`/`PumpProbeScan` 走得到。
- 唯一指向 `mast/instruments/` 的是异常类 `InstrumentError`（`instruments/base.py:44-45`，
  `class InstrumentError(RuntimeError)` + 一句 docstring，**两行、无行为**），在 `optics_scan.py:117` catch。

⇒ **A 档，判据本体 106 行 + 技能壳 27 行。**（上一轮说「约 168 行」也偏大 62 行。）

### 4-2. `builtins.optics_scan` 这个模块永远到不了 complete

2 个技能：1 个 A（AcquireSignalPoint）+ 1 个 D（OpticalStageScan）。
落 A 那个的收益是**技能数，不是模块数**。分派时按技能记，不要指望它让 `modules_complete` +1。
先例：`paper.region_analysis`（4 个里 2 个 D）。

### 4-3. `AssessAtomicPhase` 的判据本体**一行都不用写**

上一轮把它列在「晶格判据底座（≈950 行）」下面，说是「本次盘点杠杆最大的一块」。
那 950 行**已经落了**：`vision/src/atomic-phase.ts`(632) + `lattice-peaks.ts`(470) + `lattice-cell.ts`(851) +
`frame-texture.ts`(538) + `seg-texture.ts`(354) + `tip-metrics.ts`(464)。
`AtomicPhaseResult`(`atomic-phase.ts:365-381`) 的 `halfConcentrations` / `slowAxisTrusted` / `orderRatio` /
`periodFastAxisNm` 与 `tip_spectro_assess.py:419-435` 消费的字段**逐个对上**。
现在它只欠**技能壳 135 行**（含覆盖率门 `_MIN_COVERAGE=0.5` 那一段，`:385-410`）+ `resolve_substrate` 注入口。

### 4-4. 旧仓 `history_query.py:226` 调的 `store.sensors()` **不存在**

`mast/envhistory/` 全目录 `grep -rn "def sensors"` **零命中**；`EnvHistoryStore` 上只有
`list_sensors`（`envhistory/store.py:263`）。
⇒ 这行必然 `AttributeError` → 被 `:227-228` 的 `except Exception` 吃掉 → `names = []` →
`:229-230` 那句「可用的：」后面**从未有过内容**。
不是说假话（主答案「这个传感器没数据」仍正确），但那句本该最有用的提示一次都没生效过。

### 4-5. `envelope_reconcile_skill.py:194-198` 是 fail-open，移植时必须改

`apply=true` 回读时 `_get_effective_limits` 抛异常 → `readback["_error"] = "…"`（**字符串**）；
而 `:197-198` 的 `bad` 用 `isinstance(v, dict)` 过滤 ⇒ `_error` 被跳过 ⇒ `bad == []` ⇒
`:203 success=True`、`:206-209` 的 summary 打**「收紧了 N 项（回读全部一致）」** —— 而回读一次都没发生过。
移植时改成「回读没跑成 ⇒ `success=False`」。

### 4-6. `ScanAt` 从不返回 `scan_path` —— 两段死代码，新旧两仓都是

- `bias_series.py:154` 取 `data.get("scan_path") or data.get("path") or data.get("file")`；
  `coarse_step_calib.py:150` 取 `d.get("scan_path") or d.get("path")`。
- 旧仓 `composite/scan_at.py:392` 是 `data = dict(progress.partial_data)`，而 `set_partial` 只写
  `wait_timed_out / wait_stopped_early / scan_lines_done / scan_lines_total / pixels / lines /
  resolution_verified / angle_deg / linear_speed_m_s`（`:368-389`）。**本仓 `scan-at.ts:180-200` 一模一样。**
- 后果：`bias_series.py:157` 的 `AssessFrameTrust` **从来不会被调**（`:199-212` 的 `drift_check` 恒 `None`）；
  `coarse_step_calib.py:202-204` 恒返回「基准帧扫描失败」，`_load`/`phase_shift`/整个标定循环在真机上到不了。
- 旁证：`coarse_step_calib.py:98-99` 的 docstring 自己写着「三次尝试都被别的问题打断，
  **尚未在真机上跑完一次完整标定**」。
- 照移会得到两段死代码。**要不要给 `ScanAt` 补一个 `scan_path`**（它本来就有
  `GetLatestScanFile` / `findLatestSaved` 可用）**是一个独立决定**，不在这 43 个技能的范围里。

### 4-7. `AssessDomainPhase` 的参照系目录在旧仓里**根本不存在**

`domain_reference.py:69 DIRNAME = "domain_references"`，`:217-221 references_dir() = project_root()/"config"/DIRNAME`。
旧仓全树 `find . -maxdepth 5 -type d -name "domain*"` **零命中**，连 `config/` 目录都没有。
⇒ `list_references()` 永远空 ⇒ `load_reference()` 恒返 `None`（`:287-288`）⇒
`classify(fp, None)` 恒走 `undetermined(no_reference)`（`domain_phase.py:836-838`）。
`domain_phase.py:819-821` 的 docstring 自己写着「整个普查阶段每一帧都没有参照系」。

⇒ **`domain_reference.py` 那 207 行可以整块推迟，行为一字不变。**
这个技能真正的产物是**指纹**（`extract_fingerprint`，`:477-709`，233 行）。
判据本体因此从 852 降到 **645**。

### 4-8. `CoarseMotionSelfCheck` 缺的那 693 行**贡献 0 条判据**

上一轮把它列在 C 档的「实验地图 / 标记」那一格里。核对 `execute`（`coarse_selfcheck.py:334-415`）：

- 产生 `blocking` 的只有三个探针：`_registry`(`:341`) · `_vacuum`(`:349/352/354/358`) · `_drive`(`:365/375`)。
- 产生 `todo` 的是 `_vacuum`(`:360`) · `_drive`(`:370`) · `_qplus`(`:382`) · `_profile`(`:392/395`) + 两条固定条目(`:398/404`)。
- **`_coarse_map`(`:388`) 与 `_temperature`(`:389`) 只往 `data` 塞字段** —— `ready`(`:410`) / `blocking` /
  `todo` / `summary` 一个字都不受影响。`_step_counter` / `_closed_loop` / `_signals` 同样。

⇒ 十项里这一项占 **1/10 的数据字段、0/8 的判据**。其余依赖本仓**全有**：
`coarse-drive.ts`(363，四件齐) · `instrument-profile.ts`(389) · `vacuum-interlock.ts`(665) ·
`qplus-amplitude.ts`(132) · `_parse_freq_amp` 已内联在 `relocate-coarse-xy.ts:264-265` 与 `reads-hw.ts:105-106`。
10 个 `REQUIRED_SKILLS` 里 9 个已 done（只差它自己）。
**判 A**，那 693 行照 `relocate-coarse-xy.ts:321-324` 已有的措辞降级成一条明说的字段即可。

### 4-9. 上一轮 C 档表里，**五个子系统已经落到本仓了** —— 那张表的数字全过期

| 上一轮说压着 | 现在 |
|---|---|
| `core/instrument_profile.py`(1237) —— 压 3 个 | `kernel/src/instrument-profile.ts`(389)。且它**比旧仓强**：`specDefault`(:261) 把「档案里写了出厂值」与「没档案」分开；`getTiltCalibration`(:373) 是三态 `ok\|never\|unreadable`（旧仓 `:823-838` 只有两态） |
| `core/coarse_drive.py`(346) | `coarse-drive.ts`(363)，`maxAmplitudeV`/`expectedFrequencyHz`/`ABSOLUTE_MAX_AMPLITUDE_V`/`readbackMatches` 四件齐 |
| `core/tip_crash_tracker.py`(250) | `tip-crash-tracker.ts`(372)，`crashPoints()`(:203) |
| 晶格判据底座（≈950 行，「杠杆最大的一块」） | `atomic-phase.ts`(632)+`lattice-peaks.ts`(470)+`lattice-cell.ts`(851)+`frame-texture.ts`(538)+`seg-texture.ts`(354)+`tip-metrics.ts`(464) |
| `composite/_z_settle.py`(402) | `kernel/src/z-settle.ts`(629) |

B 档缺件表里的 `find_peaks`(→`peaks.ts:287`) · `curveFit` 的 `pcov`(→`curve-fit.ts:258`) ·
`correlate2d`(→`correlate.ts:130`) · `savgol`(→`savgol.ts:214`) · `lstsq`(→`lsq.ts:44`) ·
`SafeCall` 的 recv 超时（`AcquireSTS` 已 done）也都补上了。

⇒ **上一轮那份盘点只剩两样还值钱**：开头那条判据纪律，与 §四「三个自检 fail-open」那一节的**形状**
（数字也过期了 —— 见下两条）。数字一律以本轮为准。

### 4-10. `ScanIntelSelfCheck` 有**三处会说假话**，两处本仓已有更好的件能修掉

| 位置 | 假话 | 本仓的修法 |
|---|---|---|
| `:312-313` | 档案读不到 ⇒ `prof.get("still_factory")` 为 `None` ⇒ 假 ⇒ **「仪器常数还是出厂猜测」这一条 todo 整个蒸发**，没人会知道它没跑过 | `instrument-profile.ts:250 readProfile()` 返 `{ok, why}`，能把「读不到」与「没写过」分开 |
| `:326` | summary 把「档案读不到」打印成「倾斜标定**无**」 —— 两者该做的事完全不同 | `instrument-profile.ts:373 getTiltCalibration()` 是三态 `ok\|never\|unreadable`，直接修掉 |
| `:323-324` | registry 抛异常时 `reg.get('missing')` 缺席 → `or []` → `len=0` → 打「技能 ? 个（**缺 0**）」 | 照 `tip-selfcheck.ts:188-204 addSkillCoverage` |

另：`data["hardware"]`(`:293`) **不参与任何 `todo`**（`:304-318` 只读 registry/instrument_profile/
scan_policy/buffer_semantics）—— 三个硬件读全失败，`ready` 照样可能为 `True`。落的时候要把它接进判据，
否则又是一个「算出来没人读的数」。

**第 4 项（`_probe_buffer_semantics`，`:222-281`，60 行）「现在就能落且真有价值」—— 核对为真。**
四个动词本仓都在发：`Scan_BufferGet`(`full-scan.ts:111` / `analysis-lines.ts:111` / `wait-scan-complete.ts:353`，
解析有 `scan-reply.ts:87 parseBufferGet`) · `Scan_FrameGet`(`reads-core.ts:105`) ·
`Piezo_TiltGet`(`reads-config.ts:59`) · **`Scan_BufferSet(ch, 0, 0)`**(`configure-scan.ts:198`，
**每次 ConfigureScan 都在发这一句**)。所以旧仓 `:20-23/89-91` 那句「不引入新风险，只是把一直在
发生的动作读一次」在本仓**逐字成立**。硬件那四件零新写。

### 4-11. `is_customised` 与 `registry` 两项在本仓架构里**不成立**，该换判据而不是照移

- **`is_customised`**：本仓 `scan-policy.ts`（**138 行**）的 `FACTORY_TIERS`(`:60`) 是一个 `const`，
  全文件**没有 `setPolicy` / `getStoredPolicy` / `isCustomised`，连「可定制档位表存储」这个概念都没有**
  （旧仓 `scan_policy.py` 628 行里有 490 行是存储/校验/持久化）。
  照移 ⇒ 一个**永远红、永远无法变绿**的格子。照 `tip-selfcheck.ts:382-384` 已判过的那条：
  「自检一张没人读的表，绿了也不代表任何事。」**整项砍掉，或换成 `Sheet.missing()`。**
- **`registry`**：旧仓查的是「冻结打包时 `walk_packages` 枚举不到、包 `__init__` 没 import 的模块里的
  技能会**静默消失**」（`coarse_selfcheck.py:309-312` 记着一次丢 141 个；`scan_intel_selfcheck.py:113-116`
  记着 2026-08-04 两份自检各说「417 个（齐）」与「缺 19 个」）。
  本仓 `l0/index.ts:121 IMPLEMENTED` 是静态 `export const`，掉一个技能是 `tsc` 编译错误 ——
  **这个不变量在 TypeScript 里不存在**（`tip-selfcheck.ts:34-40` 已经逐字判过一次）。
  位置保留、判据换成「`REQUIRED_SKILLS` 里还有几个没移植」。
  顺带：`ScanIntelSelfCheck` 的 `REQUIRED_SKILLS`（`:44-51`，18 个）现在缺 4 个 ——
  TiltProbeCircle · TiltCalibrate · AutoTilt · ExecuteScanPlan（前者在批 7b）。这一条红是**真话**。

### 4-12. `optics_stage.py` 开头写 "7 skills"，实际是 **8** 个

`__all__` 与实际类都是 8 个。上一轮已记过，本轮复核仍然如此。

### 4-13. `frame_drift.py:13` 的模块抬头**与代码矛盾**，别照抄

抬头还写着「位移本身**直接复用** `data.processors.drift_estimate`（skimage 的 `phase_cross_correlation`，
已是亚像素）」，而 `:236-243` 记着 **2026-09-13 已经换掉了**，逐字：

> 有界、零填充的归一化互相关，**不是**循环的相位相关（2026-09-13 改）。…… STM 帧沿慢轴不是周期的
> （行与行之间有蠕变、行偏置、起扫瞬态），绕回的那一条带把行方向的真峰压掉……模拟器上实测：
> 扫描框沿 x 挪 3 nm 量到 2.9 nm；**沿 y 挪 3 nm 量到 −0.06 nm**，而按重叠区做的归一化互相关在
> +9.6 px 处给出 0.997 的峰。加 Hann 窗、二阶去趋势都救不回来，只有不绕回才行。

文件里也早已没有 skimage import。⇒ **`phaseCrossCorrelation`(`fft.ts:492`) 正是被弃的那条路，
不能拿来顶。** 对的做法是在 `fft2`/`ifft2` 上写零填充线性互相关（B 档那一件）。

### 4-14. `pattern.py:34` 的 `decode_reply` 对 `RunGridExperiment` 是**不可达 import**

那是同文件另外 6 个**已落地**技能用的。典型的「不要看 import 行下结论」。
同类：`best_frame.py:151` 的 `publication_frame` 是**必经**的（`gate_floor_base` 是无 default 的可选参数
`:205-210` ⇒ 不传就是 `None` ⇒ `_gate_floor_for:151-154` 必走那条 import），
但它要的只是**一个常数** `DEFAULT_MIN_CONCENTRATION = 300.0`，**不是** `ScanPublicationFrame` 那个技能。

### 4-15. `monitoring/store.py:2066 get_store()` **永不返回 None** —— 两处 `if store is None` 是死分支

它在 `_STORE is None` 时直接 `CurrentMonitorStore(base/"monitor.sqlite", base)` 建库建目录。
⇒ `characterise_noise.py:394-397` 与 `hardware_events.py:115-116` 那两句是**死分支**，
真实退化路径是「凭空造一个空 sqlite → 查出空 → 撞下游的硬失败闸」。
结论（诚实失败）不变，但**副作用是会在 `project_root()/experiments/current_monitor/` 下留一个空库**。
对照：`get_store_if_exists`（`store.py:2076`，QueryMonitorHistory / CharacteriseQuietDrift 用的那个）
**不建库**，它的 docstring 自己写了理由 ——「a reader that creates an empty DB has, by construction,
nothing to read」。移植时两个要分开。

### 4-16. `hardware_events.py:67-72` 有一处三态塌成两态

`_gate_block` 返回的字典在 `available=False` 那一支**不含 `any_blocking` 键**，
而 `:228` 用 `data['blocking'].get('any_blocking')` 读它 → `None` → 摘要打印「无」。
这是那个技能里**唯一**一处会把「读不到闸门状态」显示成「没人拦」的地方 —— 与它自己
`:224-230`「『一条都没有』与『读不到』是两句话」的纪律自相矛盾。移植时改成三态。
（同文件 `:207-209` 那条注释是给移植者的：严重度字面量是 `"warn"` 不是 `"warning"`，
写错「不会报错，只会**静默地一条都过滤不掉**」。）

### 4-17. 旧仓 `tip_spectro_assess.py:236-237` 是一个**必然 NameError**

```
236:            "reasons": list(res.reasons) + extra_reasons,
237:            "warnings": list(res.warnings) + extra_warnings,
```
`extra_reasons` / `extra_warnings` 在 `AssessShockleyOnset.execute`（`:152-254`）里**从未定义** ——
它们只在 `AssessAtomicPhase.execute` 的 `:405-406` 有（`grep -n "extra_reasons\|extra_warnings"` 全文件
只有这四行）。⇒ **`AssessShockleyOnset` 的每一条成功路径都会抛 NameError。**
移植时补 `= []`，并在 deviation 里记一笔（这是「旧仓是规格书，但规格书本身有 bug」的又一例，
同 §4-4 / §4-5 / §4-6）。

### 4-18（分派单自身的一处错）

交给我的清单写着 `atomic_lattice` 的 `CalibratePiezoFromLattice` 要 `vision/imaging_window:check_atomic_window`。
核对：`check_atomic_window` 在 `atomic_lattice.py` 里**只出现在 `:182-184`**，属于**已 done** 的
`AssessAtomicResolution`（`execute` 在 `:145-229`）；`CalibratePiezoFromLattice.execute`（`:434-499`）
全文无此调用，也不碰 `_frame_conditions`(`:40-52`，同样只被 `:183` 用)。
`kernel/src/imaging-window.ts:95 checkAtomicWindow` 对它**不是欠件**。

---

## 五、总计与口径

| 档 | 技能数 | 模块数 | 占比 |
|---|---:|---:|---:|
| **A** 现在就能落 | **18** | 18 | 42% |
| **B** 差一件具体的东西 | **10** | 10 | 23% |
| **C** 压着一整个子系统 | **5** | 5 | 12% |
| **D** 架构原则上不要 | **10** | 3 | 23% |
| 合计 | **43** | **34**\* | |

\* 模块数 18+10+5+3 = 36 > 34，因为 `builtins.tip_spectro_assess`（A7 + B6）与
`builtins.optics_scan`（A6 + D）各跨两档。

**必写行数汇总（A+B 共 28 个技能，逐行相加，非估）**：
判据本体 **4 749** 行（A 3 500 + B 1 249）· 技能壳 **5 466** 行（A 3 729 + B 1 737），
外加三件查不到行数的 numerics 原语。
C 档 5 个另压 **18 576** 行子系统（monitoring 12 142 + zburst 545 + buffer 1 227 + 地图/记录 4 662，已去重），
D 档 10 个另压 **2 113** 行驱动层。

**没有估出来的数**，共 5 处，全部写作「查不到」：
`curveFit` 的 bounds · 3×3 非线性求根器 · FFT 线性互相关 · `SafeCall` 中止清理通道 · `special.j0`。
其余每一个数字都有 `文件:行` 出处。
