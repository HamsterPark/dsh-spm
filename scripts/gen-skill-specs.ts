/**
 * 从 `spec/golden/skills.json` 生成批 1/2 的 `SkillSpec` 常量。
 *
 *     node scripts/gen-skill-specs.ts            # 写文件
 *     node scripts/gen-skill-specs.ts --check    # 只比对，有 diff 就非零退出
 *
 * **为什么生成而不是手抄**：这 73 个技能一共 200 多个参数声明，每个带 unit /
 * min / max / allowed_values / default / 一整段中文描述。手抄一遍的唯一产物是
 * 一批转录错误，而 DoD ① 要的「spec 与金样 deep-equal」会因此从判据退化成
 * 「我抄对了吗」的自测。
 *
 * 代价要说清：**DoD ① 因此是结构性成立的，不是测出来的**。
 * 真正的判据落在别处——DoD ② 的模型面文案（`parametersFromSpec` 对
 * `tool_schemas.json`）与 DoD ③ 的行为轨迹（`skill_traces.json`），
 * 那两样都是**独立导出的**，抄错 spec 会在那里被抓住。
 *
 * 名字里的 `generated/` 与 nanonis 门面同一套办法：生成物入仓（读代码的人要看得见
 * 声明），一条测试保证它没漂。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const SKILLS = fileURLToPath(new URL('spec/golden/skills.json', root))
const TRACES = fileURLToPath(new URL('spec/golden/skill_traces.json', root))
const OUT = fileURLToPath(new URL('packages/host/stm-skills/src/generated/specs.ts', root))

/** 批 1/2 的成员表。与导出脚本 `export_skill_traces.py` 里那两张表一致。 */
const BATCH_1 = [
  'GetBias', 'GetCurrent', 'GetBiasCalibration', 'GetSetpoint', 'GetZPosition',
  'GetZControllerState', 'GetZCtrlGain', 'GetZCtrlList', 'GetTipLift',
  'GetZLimitsEnabled', 'GetHomeProps', 'GetWithdrawRate', 'GetScanFrame',
  'GetScanSpeed', 'GetScanBuffer', 'GetScanXYPosition', 'GetTipSpeed',
  'GetPointShootOnOff', 'GetPiezoTilt', 'GetDriftCompensation',
  'GetPiezoSensitivity', 'GetPiezoXYZLimits', 'GetMotorFreqAmp', 'MotorGetPos',
  'GetMotorStepCounter', 'GetAutoApproachStatus', 'GetSafeTipStatus',
  'GetSafeTipProps', 'GetSafeTipSignal', 'GetSignalValues', 'ListSignalChannels',
  'GetSignalRange', 'GetSessionPath', 'GetAcqPeriod', 'GetRTFreq',
  'GetLatestScanFile',
]

const BATCH_2 = [
  'SetBias', 'SetSetpoint', 'ZControllerOnOff', 'TryEngageController',
  'WithdrawTip', 'SafeRetract', 'EmergencyRetract', 'StopScan',
  'StopAutoApproach', 'StopMotor', 'StopFolMe', 'SetZCtrlGain', 'SetTipLift',
  'SetZPosition', 'SetBiasRange', 'SetSessionPath', 'SetScanBuffer',
  'SetTipSpeed', 'SetFolMeOversampling', 'MoveToXY', 'SetPiezoTilt',
  'SetDriftCompensation', 'SetPiezoRange', 'SetHomeProps', 'SetSwitchOffDelay',
  'SetCurrentGain',
  'MotorMove', 'MotorMoveClosedLoop', 'EnableSafeTip', 'SetZLimitsEnabled',
  'SetBiasCalibration', 'SetCurrentCalibration', 'SetMotorFreqAmp',
  'LockNanonisUI', 'CreateZCtrlPreset',
  'AutoApproach', 'ApproachTip',
]

/**
 * 批 2b：Z 参数组三件套里剩下的两个。
 *
 * `CreateZCtrlPreset` 在批 2 里就落了（模型唯一能写数字的那一处），但**建完没人用**
 * ——它自己的报文写着「用 ApplyZCtrlPreset('x') 应用它」，而那个技能当时还不存在。
 * 这两个补上之后，进针参数组的「切过去 → 跑 → finally 放回」（D-APPROACH-1 欠的那笔）
 * 才谈得上补。
 */
const BATCH_2B = ['ApplyZCtrlPreset', 'ListZCtrlPresets']

/**
 * 批 3c：**收口整模块**的 L0 长尾，加一个真判据。
 *
 * 选的标准不是「容易」，是**模块级完成**（DoD §8.5 ⑧：该 .py 全部名字 done）。
 * 一个半完成的模块在进度表上是 `complete: false`，而它离完成差几个纯机械件时，
 * 那几个件的价值就等于整个模块的价值。七个模块在这一批里收口。
 *
 * `CheckScanForCrash` 是例外，它是这一批唯一带判据的：撞针检测
 * （方差接近零 / NaN），而且 `status` 三态——**读不到就是 skipped，永远不是 ok**。
 */
const BATCH_3C = [
  'GetSignalsAddRT', 'GetCurrentBEEM', 'GetCurrentGains',
  'ScanBackgroundDelete', 'ScanBackgroundPaste', 'GetPointShootProps',
  'SetPointShootExperiment', 'SetPointShootOnOff', 'GetRTOversample',
  'SetRTFreq', 'SetRTOversample', 'LoadLayout',
  'SaveLayout', 'SaveSettings', 'UnlockNanonisUI',
  'GetPiezoHVAInfo', 'GetPiezoHVAStatusLED', 'LoadPiezoHysteresisFile',
  'SetPiezoHysteresisOnOff', 'SetPiezoHysteresisValues', 'SetPiezoSensitivity',
  'GetMiscInstrumentConfig', 'GetPiezoConfig', 'GetPllConfig',
  'GetScanPatternConfig', 'GetSpectroscopyConfig', 'GetTipShaperConfig',
  'CheckScanForCrash',
]

/**
 * 批 3d：**锁相放大器整族**，加 datalog / marks 两个小模块。
 *
 * 锁相是本仓第一个完整移植的**测量子系统**（dI/dV 的全部前提都在它上面），
 * 而它的参数组与 Z 参数组是同一条纪律：模型说名字，代码写数字。
 */
const BATCH_3D = [
  'GetLockInConfig', 'ConfigureLockIn', 'ConfigureLockInDemod',
  'GetDemodSignal', 'GetDemodPhase', 'GetDemodPhasReg',
  'GetDemodHarmonic', 'GetDemodLPFilter', 'GetDemodHPFilter',
  'SetModSignal', 'SetModPhasReg', 'SetModHarmonic',
  'SetDemodSyncFilter', 'SetDemodRTSignals', 'ListLockInPresets',
  'ApplyLockInPreset', 'AutoPhase', 'GetDataLogStatus',
  'StartDataLog', 'StopDataLog', 'GetTcpLogStatus',
  'StartTcpLog', 'StopTcpLog', 'ListScanMarkers',
  'DrawScanMarker', 'EraseScanMarkers',
]

/**
 * 批 3e：锁相参数组三件套的实现（轨迹 3d 已录），加五个收口模块。
 *
 * 五个模块都是「一层薄壳包一族 Nanonis 动词」，选它们的标准仍然是**模块级完成**。
 * 值钱的是各自那一两条判据：Osci1T 三件分 `NeedModule`（模块没装 ≠ 线路坏了）、
 * 频带闸 `lo >= hi` 拒、偏压 sweep 的颠倒限值**换过来**而不是拒、
 * AtomTrack 状态位在 body 第 0 位。
 */
const BATCH_3E = [
  'ConfigureAtomTrack', 'AtomTrackDriftComp', 'AtomTrackQuickCompStart',
  'AtomTrackStatusGet', 'AcquireOsciTrace', 'GetOsciTimebases',
  'SetOsciTimebase', 'ConfigureSpectrumAnalyzer', 'SetSpectrumAnalyzerBand',
  'GetSpectrumAnalyzerData', 'RunBiasSweep', 'GetSignalCalibration',
  'SetAdditionalRealtimeSignals', 'SetAcquisitionPeriod', 'BiasPulse',
]

/**
 * 批 3f：**Nanonis 脚本整族**（白名单是要害）+ PLL 整族 + 仪器限值。
 *
 * 脚本那 14 个的判据全在一张操作员维护的白名单上：脚本跑在 RT 控制器上、一次
 * `safeCall` 都不发，于是本仓每一道闸在它内部都不生效 —— 白名单是**唯一**的屏障。
 * 而 `LoadNanonisScript` 的闸是**反的**：它拒绝往已审槽位里装别的脚本。
 *
 * PLL 那 36 个是 qPlus/nc-AFM 的调频子系统；仪器限值那 6 个补完了
 * 「能读不能写」的那一族，每一次放宽都留痕。
 */
const BATCH_3F = [
  'ListNanonisScripts',
  'GetScriptData',
  'GetScriptChannels',
  'RunNanonisScript',
  'StopNanonisScript',
  'DeployNanonisScript',
  'UndeployNanonisScript',
  'LoadScriptLUT',
  'DeployScriptLUT',
  'SetScriptChannels',
  'SetScriptAutosave',
  'LoadNanonisScript',
  'SaveNanonisScript',
  'SaveNanonisScriptLut',
  'SetZLimits',
  'SetWithdrawRate',
  'HomeZController',
  'SetPiezoLimits',
  'SetSafeTipProps',
  'SetActiveZController',
  'ConfigurePLL',
  'GetPLLStatus',
  'PLLOnOff',
  'ConfigurePLLExcitation',
  'AcquirePLLFreqSweep',
  'PLLSignalAnalyzer',
  'GetPLLAddOnOff',
  'SetPLLAmpCtrlBandwidth',
  'GetPLLAmpCtrlOnOff',
  'SetPLLAmpCtrlSetpnt',
  'GetPLLDemodFilter',
  'SetPLLDemodFilter',
  'GetPLLDemodHarmonic',
  'GetPLLDemodInput',
  'SetPLLDemodInput',
  'SetPLLDemodPhasRef',
  'GetPLLExcRange',
  'SetPLLFreqExcOverwrite',
  'GetPLLFreqRange',
  'SetPLLFreqRange',
  'PLLFreqShiftAutoCenter',
  'GetPLLInpCalibr',
  'SetPLLInpCalibr',
  'GetPLLInpProps',
  'SetPLLInpProps',
  'SetPLLInpRange',
  'PLLPerfectPLLUpdtZTC',
  'SetPLLPhasCtrlBandwidth',
  'GetPLLPhasCtrlOnOff',
  'GetPLLSignalAnlzrCh',
  'GetPLLSignalAnlzrFFTProps',
  'GetPLLSignalAnlzrTimebase',
  'PLLSignalAnlzrTrigAuto',
  'SetPLLSignalAnlzrTrig',
  'GetPLLFreqSwpParams',
  'StopPLLFreqSwp',
]

/**
 * 批 3g / 3h / 3i —— 三条并行支线各占一个常量（同 `export_skill_traces.py`）。
 *
 * 分开而不是合成一张表：三份改动落在**不同的行**上，合并时不需要有人去猜谁的对。
 */
const BATCH_3G: string[] = [
  'ConfigurePiController',
  'SetPiControllerOnOff',
  'GetPiController',
  'SetGenericPiOutput',
  'GetGenericPiController',
  'ConfigurePreamp',
  'GetPreamp',
  'RunPllZoomFft',
  'GetPllZoomFftData',
  'RunPllPhaseSweep',
  'StopPllPhaseSweep',
  'ConfigurePllSignalAnalyzer',
  'GetPllSignalAnalyzerData',
  'ConfigureOcSync',
  'GetOcSync',
  'ConfigureTipRecorder',
  'GetTipRecorderData',
  'ConfigureKelvinController',
  'SetKelvinControllerOnOff',
  'GetKelvinController',
  'RunCpdCompensation',
  'GetCpdCompensation',
  'ConfigureInterferometer',
  'SetInterferometerOnOff',
  'GetInterferometer',
  'ConfigureBeamDeflection',
  'GetBeamDeflection',
  'AutoZeroBeamDeflection',
  'SetLaserOnOff',
  'SetLaserPower',
  'GetLaser',
  'SetProbeZController',
  'GetProbeZController',
  'WithdrawProbe',
  'ConfigureProbeScanner',
  'MoveProbeXY',
  'StopProbeScanner',
  'SetProbeBias',
  'PulseProbeBias',
  'GetProbeBias',
  'GetProbeCurrent',
  'ConfigureProbeCurrentGain',
  'ConfigureHighSpeedSweep',
  'RunHighSpeedSweep',
  'StopHighSpeedSweep',
  'GetHighSpeedSweepStatus',
  'ConfigureRfGenerator',
  'StartRfGenerator',
  'StopRfGenerator',
  'RunRfFrequencySweep',
  'GetRfGeneratorStatus',
  'ConfigureHighResScope',
  'RunHighResScope',
  'GetHighResScopeData',
  'GetHighResScopeStatus',
  'ConfigureDualScope',
  'GetDualScopeData',
  'ConfigureSignalChart',
]   // optional_* 五族
const BATCH_3H: string[] = [
  'GetUserOutputLimits',
  'GetUserOutputMode',
  'GetUserOutputMonitorChannel',
  'GetDigitalLineTTL',
  'GetCalculatedOutputConfig',
  'SetUserOutput',
  'SetUserOutputMode',
  'SetUserOutputMonitorChannel',
  'SetUserOutputLimits',
  'SetUserOutputCalibration',
  'ConfigureCalculatedOutput',
  'PulseDigitalLine',
  'SetDigitalLineStatus',
  'ConfigureDigitalLine',
  'ConfigureBiasSweep',
  'AcquireBiasSweep',
  'ConfigureLockInSweep',
  'AcquireLockInSweep',
  'GetLockInSweepLimits',
  'GetLockInSweepProps',
  'GetLockInSweepSignal',
  'GenSwpAcqChsGet',
  'GenSwpPropsGet',
  'GenSwpStop',
  'GenSwpSwpSignalGet',
  'OpenPatternExperiment',
  'PausePatternExperiment',
  'SetPatternLine',
  'SetPatternCloud',
  'GetPatternCloud',
  'GetPatternProps',
  'ConfigureWaveform',
  'StartWaveform',
  'StopWaveform',
  'GetWaveformStatus',
  'SetWaveformIdleValue',
  'SetWaveformChannelOnOff',
  'SetSpectroscopyTtlSync',
  'SetSpectroscopyPulseSync',
  'SetSpectroscopyZControl',
  'SetZSpectroscopySecondRetract',
  'SetMlsLockinPerSegment',
  'GetSpectroscopyStatus',
  'QuitNanonis',
  'SetMultiPass',
  'LoadMultiPassConfig',
  'SaveMultiPassConfig',
  'WaitForScanEndBlocking',
]   // 输出 / 扫频 / 图样 / 函数发生器
const BATCH_3I: string[] = [
  'SetWaveformSignal',
  'SetLockInDemodPhaseRegister',
  'SetLockInFrequencySweepSignal',
  'SetPllExcitationAdd',
  'SetPllDemodHarmonic',
  'ConfigureScopeTrigger',
  'SetPatternExperiment',
  'SetPointShootProps',
  'ReadTipOscillationAmplitude',
  'CheckTipCrashByAmplitude',
  'CheckPiezoRange',
]   // 杂项 setter / qPlus 振幅 / 压电范围对账

/** 批 3j / 3k —— 又一轮两条并行支线，各占一个常量。 */
const BATCH_3J: string[] = ['BiasPulseWithReadback', 'TipShapeWithReadback', 'CaptureSignalBuffer']

const BATCH_3K: string[] = ['GetChamberPressure', 'GetTemperature']   // 环境读（真空 + 温度）

/**
 * 批 3l / 4a —— 第三轮两条并行支线。
 *
 * **每个常量之间隔一个空行加一句注释**，不是紧挨着的两行 —— 上一轮 3j/3k
 * 紧挨着放，两条支线各改一行，git 照样冲突（2026-09-16 量过：中间至少要有
 * 一行谁都没改的）。
 */
const BATCH_3L: string[] = [
  'AcquireSTS', 'ConfigureSTS', 'ConfigureZSpectr', 'AcquireZSpectr',
  'ConfigureSTSTiming', 'StopSTS', 'StopZSpectr', 'ConfigureSTSChannels',
  'ConfigureZSpectrTiming', 'GetSTSChannels', 'SetSTSChannels', 'GetSTSLimits',
  'SetSTSAdvancedProps', 'GetSTSTiming', 'GetSTSAltZCtrl',
  'GetZSpectrChannels', 'SetZSpectrChannels', 'GetZSpectrRange', 'SetZSpectrRange',
  'GetZSpectrRetract', 'SetZSpectrRetract',
  'GetSTSDigSync', 'GetSTSTTLSync', 'GetSTSPulseSeqSync', 'GetSTSZOffRevert',
  'GetSTSMLSLockinPerSeg', 'SetSTSMLSMode', 'SetSTSMLSVals',
  'SetSTSSafeCond1', 'GetSTSSafeCond1', 'SetSTSSafeCond2',
  'SetZSpectrAdvProps', 'GetZSpectrDigSync', 'GetZSpectrPulseSeqSync',
  'GetZSpectrRetract2nd', 'SetZSpectrRetractDelay', 'GetZSpectrTTLSync',
  'GetZSpectrTiming',
]   // builtins.spectroscopy 整族

// ↑ 3l ／ ↓ 4a —— 这一行谁都不要动，它就是那「一行谁都没改的」
const BATCH_4A: string[] = [
  // 掩膜 / 团簇一族 —— 共用 parse_xy_meta + px_to_m + acquired_row_mask + assess_mask
  'ExtractClusters',
  'AssessClusterRoundness',
  'SelectPokedCluster',
  'VerifyAdatomAt',
  // 平面族 —— 共用 K2（noise_floor + fit_plane_robust + plane_subtract）
  'MeasureStepHeight',
  'AssessFrameTrust',
  // 各自自足
  'LocateStepEdge',
  'AssessAtomicLines',
  'AssessFrameCorrugation',
]   // builtins 分析技能第一批（要数值底座）

// ↑ 上一条 ／ ↓ 4B —— 这一行谁都不要动
const BATCH_4B: string[] = [
  // 晶格 `measure_cell` 组 —— 批 4a 欠下的那两个
  'AssessScanTexture',
  'MeasureLatticeCell',
  // 原子相判据环（`atomic_phase` + K1 + `imaging_window`）
  'AssessAtomicResolution',
  'AnalyseAtomicLattice',
]   // 晶格判据底座 + 原子分辨判定一族

// ↑ 上一条 ／ ↓ 4C —— 这一行谁都不要动
const BATCH_4C: string[] = [
  // builtins.scan_frame 收口（`GrabScanFrameData` / `CheckScanForCrash` 早已落地）
  'LoadScanFrameFromFile',
  'ParseRegions',
  'ComputeDriftVector',
  // paper.data_processing 整族
  'SubtractPlane_RANSAC',
  'LevelLines_Median',
  'FindEmptySpot',
  'CorrectDrift_XCorr',
  // paper 的五个单件模块，各自一个技能
  'SubtractPoly2D',
  'Destripe_MorphOpen',
  'AutoCrop_UnscannedRegion',
  'Denoise_AE',
  'DetectAtomJump',
]   // paper 数据处理 + scan_frame 一族

// ↑ 上一条 ／ ↓ 4D —— 这一行谁都不要动
const BATCH_4D: string[] = [
  // 两个组合技能。**不是技能层薄壳** —— 判定机先进的内核（`scan-resolver.ts` 的
  // `resolveScan` 是 329 行纯函数、`tip-crash-tracker.ts` 是那台跨调用的状态机），
  // 这两个只负责发调用与拼报文。
  'ScanAt',
  'FullScan',
]   // composite.scan_at + 撞针追踪

// ↑ 上一条 ／ ↓ 5A —— 这一行谁都不要动
const BATCH_5A: string[] = [
  // 两个修针技能。`TipShape` 与批 3j 的 `TipShapeWithReadback` 下发同一串
  // `TipShaper_PropsSet` + `TipShaper_Start`；`TipPulse` 是第一个**参数由针尖方案表填、
  // 包络由方案表判**的组合技能（D-TIP-1 在这一批结清）。
  'TipShape',
  'TipPulse',
  // 两个自检。**本仓这一侧有意与旧仓不同**：依赖缺席一律 `ok=false, blocking=true`
  // （旧仓落进 `except → ok=None` ⇒ 只进 warnings ⇒ 打出一句假的「✅ 可以开工」）。
  'TipConditioningSelfCheck',
  'TipForgeSelfCheck',
]   // 针尖登记表底座 + TipPulse/TipShape + 两个 fail-open 自检

// ↑ 上一条 ／ ↓ 5B —— 这一行谁都不要动
const BATCH_5B: string[] = [
  // 电流诊断（builtins.current_monitor / monitor_current_fft / current_origin / saturation_recovery）
  'MonitorCurrent',
  'MonitorCurrentFFT',
  'ClassifyUnexplainedCurrent',
  'RecoverTipFromSaturation',
  // 时序（builtins.thermal_settle / scan_watch）
  'WaitForThermalSettle',
  'WatchScanLines',
  // 组合（composite.bias_settle / builtins.acquire_psd / composite.batch_regions_scan）
  'BiasSettleChange',
  'AcquirePSD',
  'BatchRegionsScan',
  // ⚠️ `RunGridExperiment`（builtins.pattern 的第 7 个）**不在这一批** —— 见 batch-5b.md §5。
]   // A 档零散一批（各自自足，不压子系统）

// ↑ 上一条 ／ ↓ 5C —— 这一行谁都不要动
// ↑ 上一条 ／ ↓ 6A —— 这一行谁都不要动
const BATCH_6A: string[] = []   // 特异化流程 _tip_phases 六个组合技能

// ↑ 上一条 ／ ↓ 6B —— 这一行谁都不要动
const BATCH_6B: string[] = [
  // `builtins.scan_prep` 整模块（2/2）—— 判据本体在 `vision/scan-prep.ts`，
  // 这一层只做 IO。PNG 那一半没移（matplotlib = D 档），见 deviations 批 6b。
  'AnalyzeScanImage',
  'AutoProcessScanBatch',
]   // vision 的 scan_prep 链

// ↑ 上一条 ／ ↓ 6C —— 这一行谁都不要动
const BATCH_6C: string[] = [
  // 批 5b §5.2 欠下的四个里的三个（`AssessSpectrum` 的 544 行没落，见 batch-6c.md）
  'AssessTipSharpness',
  'AssessTipFromSpectrum',
  'InvertForceSaderJarvis',
  // 晶格一族剩余里最便宜的那个（批 4b §6 的原话）。同模块的
  // `CalibratePiezoMultiAngle` 要 `solve_affine` 的 fsolve 多分支求根 ⇒ 不在本批。
  'AssessAtomicConsistency',
]   // 批 5b 欠下的数值原语 + 晶格一族剩余

// ↑ 上一条 ／ ↓ 7A-1 —— 这一行谁都不要动
const BATCH_7A_1: string[] = [
  // `builtins.frame_tilt`（1/1）—— 只读 .sxm。
  'AnalyzeFrameTilt',
  // `builtins.tilt_probe`（1/1）—— `AutoTilt` 的**测量那一半**。任务书原来没点它，
  // 而 `auto_tilt._measure` 里就写着 `context.run("TiltProbeCircle", …)`：
  // 封锁账那张表记的是**一层**，不是闭包。见 batch-7a-1.md「与任务书不一样」。
  'TiltProbeCircle',
  // `composite.auto_tilt`（2/2）。
  'TiltCalibrate',
  'AutoTilt',
]   // vision/tilt 一族 + 三个调平技能

// ↑ 上一条 ／ ↓ 7A-2 —— 这一行谁都不要动
const BATCH_7A_2: string[] = [
  // 实验地图层（`core/map_scope` + `io/map_analysis` + `io/exp_map` 的函数级闭包）。
  // 它一个人挡着全部六条针尖特异化流程 —— 每一条的第一个动作都是它。
  'FindCleanSpot',
]   // 实验地图层 + FindCleanSpot

// ↑ 上一条 ／ ↓ 7A-3 —— 这一行谁都不要动

// ↑ 上一条 ／ ↓ 7B-1 —— 这一行谁都不要动
const BATCH_7B_1: string[] = [
  // `builtins.tip_spectro_assess`（1/2）—— 判据本体**零行**：晶格底座那 ≈950 行
  // 上一轮就落完了（`atomic-phase.ts` 632 · `lattice-peaks.ts` 470 · …），
  // 而 `AtomicPhaseResult` 的字段与 `tip_spectro_assess.py:419-435` 逐个对上。
  // 只欠技能壳 + 覆盖率门 `_MIN_COVERAGE=0.5`。
  // ⚠️ 同文件的 `AssessShockleyOnset` **不在这一批**：它在旧仓每条成功路径都炸
  // `NameError`（`:236-237` 用的 `extra_reasons` 只在另一个类的另一个方法里赋值），
  // 「怎么验收」是一个还没答的问题。见 `docs/handoff/batch-7b-1.md`。
  'AssessAtomicPhase',
]   // 原子相自检的技能壳


// ↑ 上一条 ／ ↓ 7B-2 —— 这一行谁都不要动
const BATCH_7B_2: string[] = [
  // 势垒链三件 —— B1/B2 差的那一件就是 A1，**必须同批**。
  'MeasureBarrierHeight',
  'MapBarrierHeight',
  'CleanTipUntilBarrier',
  // 线缆四件（`ScanAt` / STS 四件套 / Nanonis 动词，判据都很薄）。
  'AcquireBiasSeries',
  'CalibrateCoarseStep',
  'AcquireDeltaFCurve',
  'RunGridExperiment',
  // `builtins.optics_scan` 的 **A 档那一半**（另一半 `OpticalStageScan` 是 D 档，
  // 所以这个模块永远到不了 complete —— 这里收的是技能数，不是模块数）。
  'AcquireSignalPoint',
]   // 势垒链与线缆（8 个技能 / 7 个模块收口）


// ↑ 上一条 ／ ↓ 7B-3 —— 这一行谁都不要动

// ↑ 上一条 ／ ↓ 8A-1 —— 这一行谁都不要动
const BATCH_8A_1: string[] = []


// ↑ 上一条 ／ ↓ 8A-2 —— 这一行谁都不要动
const BATCH_8A_2: string[] = []


// ↑ 上一条 ／ ↓ 8A-3 —— 这一行谁都不要动
const BATCH_8A_3: string[] = []

const BATCH_7B_3: string[] = [
  // 甲 · `composite` 零新原语的五个。判据依赖为零、子技能全落、互不依赖。
  // 唯一的共用前置是给 `SaveScan` 注入 `findLatestSxm`（`l0/scan.ts`）。
  'GridSTS',
  'DemoScanAndSTS',
  'TrackDrift_ReferenceScan',
  'AcquireBiasImagingSeries',
  'MoveAtomTo',
  // 乙 · `paper` 四个纯函数。形状与批 4c 同，一件新原语都不拉。
  // 一次清零两个整模块（`paper.scan_diff` / `paper.deconvolution`）。
  'DiffScans_ChangeDetect',
  'DeconvolveTip_RL',
  'SegmentRegion_UNet',
  'DetectAtoms_FCN',
]   // composite 零新原语五个 + paper 四个纯函数

const BATCH_7A_3: string[] = [
  // `kde_layers`(15) + `_hist_modes`(30) 落了之后，这个 827 行的技能就没有缺件了。
  'FindFlatRegion',
  // 零判据缺件（函数体里一个 `mast.*` import 都没有）。挡着 MakeAtomicResolutionTip。
  'BiasWiggle',
]   // kde_layers + FindFlatRegion + BiasWiggle

const BATCH_5C: string[] = [
  // 仪器档案的**只读窗口**。它的全部价值是区分「从未标定过」与「读不到档案」。
  'ReadCalibrations',
  // `_z_settle` 那一对 —— **必须同批**，共用 `z-settle.ts` 与同一批配置口。
  'RetractForSampleChange',
  'RelocateCoarseXY',
  // 上一条落了，这个是一层薄壳。
  'StepCoarseXY',
]   // 仪器档案 + Z 稳定 + 粗动驱动三个子系统

/**
 * 批 3b：装在 GraphExecutor 上的另一半验收。
 *
 * `WaitScanComplete` 验的是**流式**动态计划（步数事先不知道），`SetBiasRamp` 验的是
 * **先算后排**那一种——第 0 步先读当前偏压，读到了才排得出后面那串步骤。
 */
const BATCH_3B = ['SetBiasRamp']

/** 批 3a：扫描主链（PLAN §8.4 批 3 的头六个）。 */
const BATCH_3A = [
  'ConfigureScan', 'SetScanSpeed', 'StartScan', 'WaitScanComplete',
  'SaveScan', 'GrabScanFrameData',
]

interface GoldenParam {
  name: string
  type: string
  description?: string | null
  unit?: string | null
  required?: boolean | null
  min_value?: number | null
  max_value?: number | null
  allowed_values?: (string | number | boolean)[] | null
  default?: unknown
}
interface GoldenSkill {
  name: string
  description: string
  parameters?: GoldenParam[] | null
  preconditions?: string[] | null
  capabilities?: string[] | null
  tags?: string[] | null
  category?: string
  safety_level?: string
  module?: string
}

const q = (v: unknown): string => JSON.stringify(v)

/** 一个参数声明 → TS 字面量。**只写非空字段**，好让 diff 读得动。 */
function paramLiteral(p: GoldenParam): string {
  const parts = [`name: ${q(p.name)}`, `type: ${q(p.type)}`]
  if (p.description != null && p.description !== '') parts.push(`description: ${q(p.description)}`)
  if (p.unit != null && p.unit !== '') parts.push(`unit: ${q(p.unit)}`)
  parts.push(`required: ${p.required === true}`)
  if (p.min_value != null) parts.push(`minValue: ${p.min_value}`)
  if (p.max_value != null) parts.push(`maxValue: ${p.max_value}`)
  if (p.allowed_values != null && p.allowed_values.length > 0) {
    parts.push(`allowedValues: ${q(p.allowed_values)}`)
  }
  if (p.default !== undefined && p.default !== null) parts.push(`default: ${q(p.default)}`)
  return `{ ${parts.join(', ')} }`
}

function specLiteral(s: GoldenSkill): string {
  const parts = [`  name: ${q(s.name)}`, `  description: ${q(s.description)}`]
  const ps = s.parameters ?? []
  parts.push(
    ps.length === 0
      ? '  parameters: []'
      : `  parameters: [\n${ps.map((p) => `    ${paramLiteral(p)},`).join('\n')}\n  ]`,
  )
  if ((s.preconditions ?? []).length > 0) parts.push(`  preconditions: ${q(s.preconditions)}`)
  if ((s.capabilities ?? []).length > 0) parts.push(`  capabilities: ${q(s.capabilities)}`)
  if ((s.tags ?? []).length > 0) parts.push(`  tags: ${q(s.tags)}`)
  if (s.category != null) parts.push(`  category: ${q(s.category)}`)
  if (s.safety_level != null) parts.push(`  safetyLevel: ${q(s.safety_level.toUpperCase())}`)
  return `{\n${parts.join(',\n')},\n}`
}

function main(): number {
  const raw = JSON.parse(readFileSync(SKILLS, 'utf8')) as Record<string, GoldenSkill> | GoldenSkill[]
  const all = Array.isArray(raw) ? raw : Object.values(raw)
  const byName = new Map(all.map((s) => [s.name, s]))
  const traced = new Set(Object.keys(JSON.parse(readFileSync(TRACES, 'utf8')) as object))

  const names = [
    ...BATCH_1, ...BATCH_2, ...BATCH_2B, ...BATCH_3A, ...BATCH_3B, ...BATCH_3C,
    ...BATCH_3D, ...BATCH_3E, ...BATCH_3F,
    ...BATCH_3G, ...BATCH_3H, ...BATCH_3I,
    ...BATCH_3J, ...BATCH_3K,
    ...BATCH_3L,
    // ↑ 3l ／ ↓ 4a
    ...BATCH_4A,
    // ↑ ／ ↓ 4B
    ...BATCH_4B,
    // ↑ ／ ↓ 4C
    ...BATCH_4C,
    // ↑ ／ ↓ 4D
    ...BATCH_4D,
    // ↑ ／ ↓ 5A
    ...BATCH_5A,
    // ↑ ／ ↓ 5B
    ...BATCH_5B,
    // ↑ ／ ↓ 5C
    ...BATCH_5C,
    // ↑ ／ ↓ 6A
    ...BATCH_6A,
    // ↑ ／ ↓ 6B
    ...BATCH_6B,
    // ↑ ／ ↓ 6C
    ...BATCH_6C,
    // ↑ ／ ↓ 7A-1
    ...BATCH_7A_1,
    // ↑ ／ ↓ 7A-2
    ...BATCH_7A_2,
    // ↑ ／ ↓ 7A-3
    ...BATCH_7A_3,
    // ↑ ／ ↓ 7B-1
    ...BATCH_7B_1,
    // ↑ ／ ↓ 7B-2
    ...BATCH_7B_2,
    // ↑ ／ ↓ 7B-3
    ...BATCH_7B_3,
  ]
  const missing = names.filter((n) => !byName.has(n))
  const found = names.filter((n) => byName.has(n))

  const body = found
    .map((n) => `export const ${n}Spec: SkillSpec = ${specLiteral(byName.get(n)!)}\n`)
    .join('\n')

  const text =
    `// 由 \`node scripts/gen-skill-specs.ts\` 生成，**不要手改**。\n` +
    `// 源：spec/golden/skills.json（旧仓 SkillRegistry.discover() + _get_metadata_raw）\n` +
    `//\n` +
    `// 批 1 只读 L0 ${BATCH_1.filter((n) => byName.has(n)).length} 个 · ` +
    `批 2 写/硬闸/DANGEROUS/L1 ${BATCH_2.filter((n) => byName.has(n)).length} 个 · ` +
    `批 2b 参数组 ${BATCH_2B.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3a 扫描主链 ${BATCH_3A.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3b 组合 ${BATCH_3B.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3c 长尾 ${BATCH_3C.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3d 锁相族 ${BATCH_3D.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3e 收口 ${BATCH_3E.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3f 脚本/PLL/限值 ${BATCH_3F.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3g ${BATCH_3G.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3h ${BATCH_3H.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3i ${BATCH_3I.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3j ${BATCH_3J.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3k ${BATCH_3K.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3l ${BATCH_3L.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ 3l ／ ↓ 4a
    `批 4a ${BATCH_4A.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 4B
    `批 4b ${BATCH_4B.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 4C
    `批 4c ${BATCH_4C.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 4D
    `批 4d ${BATCH_4D.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 5A
    `批 5a ${BATCH_5A.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 5B
    `批 5b ${BATCH_5B.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 5C
    `批 5c ${BATCH_5C.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 6A
    `批 6a ${BATCH_6A.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 6B
    `批 6b ${BATCH_6B.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 6C
    `批 6c ${BATCH_6C.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 7A-1
    `批 7a-1 ${BATCH_7A_1.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 7A-2
    `批 7a-2 ${BATCH_7A_2.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 7A-3
    `批 7a-3 ${BATCH_7A_3.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 7B-1
    `批 7b-1 ${BATCH_7B_1.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 7B-2
    `批 7b-2 ${BATCH_7B_2.filter((n) => byName.has(n)).length} 个 · ` +
    // ↑ ／ ↓ 7B-3
    `批 7b-3 ${BATCH_7B_3.filter((n) => byName.has(n)).length} 个\n` +
    (missing.length > 0
      ? `// 计划稿点名但当前旧仓**没有**的：${missing.join('、')}\n`
      : '') +
    `import type { SkillSpec } from 'dsh-spm-kernel'\n\n` +
    body +
    `\n/** 批 1/2 的全部声明，按名字索引。 */\n` +
    `export const BATCH_SPECS: Readonly<Record<string, SkillSpec>> = {\n` +
    found.map((n) => `  ${n}: ${n}Spec,`).join('\n') +
    `\n}\n\n` +
    `/** 有行为轨迹金样的那些（两个进针技能不在内，见导出脚本的 TRACE_SKIP）。 */\n` +
    `export const TRACED = ${q(found.filter((n) => traced.has(n)))} as const\n`

  const check = process.argv.includes('--check')
  const current = ((): string | null => {
    try {
      return readFileSync(OUT, 'utf8')
    } catch {
      return null
    }
  })()

  if (check) {
    if (current === text) {
      console.log(`✓ generated/specs.ts 与金样同步（${found.length} 个技能）`)
      return 0
    }
    console.error('✗ generated/specs.ts 与金样不同步。跑 `node scripts/gen-skill-specs.ts`。')
    return 1
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text, { encoding: 'utf8' })
  console.log(`✓ 生成 ${found.length} 个 SkillSpec（缺 ${missing.length}：${missing.join('、') || '无'}）`)
  return 0
}

process.exit(main())
