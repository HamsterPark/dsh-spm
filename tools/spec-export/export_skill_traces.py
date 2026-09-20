"""把批 1/2 的技能**逐个跑一遍**，把调用序列与返回录成金样。

驱动的是**旧仓真实的技能实现**，不是我对它的阅读。每个技能录：

* `ok`      —— 所有 `safe_call` 都成功（回包按 Nanonis 协议表的 `returns` 合成）
* `err@i`   —— 第 i 次调用返回错误。**i 从 `ok` 那一趟的调用序列派生**，
               于是每一条 `if record.error:` 分支都被走到，不靠我数
* `empty@0` —— 第一次调用成功但 body 是空表 ⇒ `reply_scalar` 取不出数。
               这是 2026-08-13 锁机那一族的形状（截断回包被当成读数）

录下来的是：**发出的动词与参数序列**、`success`、`error` 逐字、`data` 的键与值、
`summary` 逐字。TS 侧拿同一份脚本喂同一批技能，逐条比。

    python \\
        tools/spec-export/export_skill_traces.py

为什么不用 AST 抽 `error_branches`（§8.6 原话）：AST 抽得到**分支在哪**，
抽不到**那条分支说了什么**。而错误文案是模型读的东西，判据必须落在文案上。
真跑一遍两样都有，还顺带把调用序列钉住了。
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

#: 脚本白名单的文件名（与 `mast.skills.builtins.nanonis_script._CONFIG_NAME` 同名）。
_CONFIG_NAME = "nanonis_scripts.json"

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "skill_traces.json"
NANONIS = REPO / "spec" / "nanonis" / "nanonis_commands.json"

# ── 时间桩：轮询类技能（AutoApproach / TryEngageController）在真时间上要转很久 ──
#
# `sleep` 变成「把假钟往前拨」而不是真等。于是一个 `while monotonic()-t0 < timeout`
# 的轮询循环仍然按它自己的逻辑走完、按它自己的次数调用 —— 只是不占墙钟。
# **不能简单地把 sleep 变成 no-op**：那样超时永远到不了，循环变成死循环。
import time as _time

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    # 每次读也往前挪一点：有些循环不 sleep，只靠 monotonic 判超时
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


def _fake_time() -> float:
    """墙钟也要钉住 —— 否则 `read_at` 这类字段每跑一次金样就变一个数，
    而「重跑逐字节相同」是金样最重要的性质（没有它，`git diff` 回答不了
    「有没有变」这个问题）。"""
    return 1_700_000_000.0


_time.time = _fake_time            # type: ignore[assignment]
_time.sleep = _fake_sleep          # type: ignore[assignment]
_time.monotonic = _fake_monotonic  # type: ignore[assignment]
_time.perf_counter = _fake_monotonic  # type: ignore[assignment]

sys.path.insert(0, str(MAST_ROOT))
from mast.core.types import NanonisCallRecord, SkillResult  # noqa: E402
from mast.core.registry import SkillRegistry  # noqa: E402

#: 批 1（只读 L0）。计划稿里的 `GetScanStatus` / `GetXYPosition` 在当前旧仓
#: **不存在**——扫描状态是被 `WaitScanComplete` 内联轮询的，XY 位置那个叫
#: `GetScanXYPosition`（已在表内）。所以实为 36 个。
BATCH_1 = [
    "GetBias", "GetCurrent", "GetBiasCalibration", "GetSetpoint", "GetZPosition",
    "GetZControllerState", "GetZCtrlGain", "GetZCtrlList", "GetTipLift",
    "GetZLimitsEnabled", "GetHomeProps", "GetWithdrawRate", "GetScanFrame",
    "GetScanSpeed", "GetScanBuffer", "GetScanXYPosition", "GetTipSpeed",
    "GetPointShootOnOff", "GetPiezoTilt", "GetDriftCompensation",
    "GetPiezoSensitivity", "GetPiezoXYZLimits", "GetMotorFreqAmp", "MotorGetPos",
    "GetMotorStepCounter", "GetAutoApproachStatus", "GetSafeTipStatus",
    "GetSafeTipProps", "GetSafeTipSignal", "GetSignalValues", "ListSignalChannels",
    "GetSignalRange", "GetSessionPath", "GetAcqPeriod", "GetRTFreq",
    "GetLatestScanFile",
]

#: 批 2（写 L0 + 补救 + 硬闸七件套 + DANGEROUS 2 + L1 试点 2）
BATCH_2 = [
    "SetBias", "SetSetpoint", "ZControllerOnOff", "TryEngageController",
    "WithdrawTip", "SafeRetract", "EmergencyRetract", "StopScan",
    "StopAutoApproach", "StopMotor", "StopFolMe", "SetZCtrlGain", "SetTipLift",
    "SetZPosition", "SetBiasRange", "SetSessionPath", "SetScanBuffer",
    "SetTipSpeed", "SetFolMeOversampling", "MoveToXY", "SetPiezoTilt",
    "SetDriftCompensation", "SetPiezoRange", "SetHomeProps", "SetSwitchOffDelay",
    "SetCurrentGain",
    # 硬闸七件套
    "MotorMove", "MotorMoveClosedLoop", "EnableSafeTip", "SetZLimitsEnabled",
    "SetBiasCalibration", "SetCurrentCalibration", "SetMotorFreqAmp",
    # DANGEROUS
    "LockNanonisUI", "CreateZCtrlPreset",
    # L1 试点
    "AutoApproach", "ApproachTip",
]

#: 批 2b：Z 参数组三件套里剩下的两个。
#:
#: `CreateZCtrlPreset` 在批 2 里就落了，但**建完没人用** —— 它自己的报文写着
#: 「用 ApplyZCtrlPreset('x') 应用它」，而那个技能当时还不存在。
BATCH_2B = ["ApplyZCtrlPreset", "ListZCtrlPresets"]

#: 批 3c：**收口整模块**的 L0 长尾（七个模块在这一批里从半完成变成完成），
#: 加一个真判据 `CheckScanForCrash`（方差接近零 / NaN ⇒ 撞针；`status` 三态，
#: **读不到就是 skipped，永远不是 ok**）。
BATCH_3C = [
    "GetSignalsAddRT", "GetCurrentBEEM", "GetCurrentGains",
    "ScanBackgroundDelete", "ScanBackgroundPaste", "GetPointShootProps",
    "SetPointShootExperiment", "SetPointShootOnOff", "GetRTOversample",
    "SetRTFreq", "SetRTOversample", "LoadLayout",
    "SaveLayout", "SaveSettings", "UnlockNanonisUI",
    "GetPiezoHVAInfo", "GetPiezoHVAStatusLED", "LoadPiezoHysteresisFile",
    "SetPiezoHysteresisOnOff", "SetPiezoHysteresisValues", "SetPiezoSensitivity",
    "GetMiscInstrumentConfig", "GetPiezoConfig", "GetPllConfig",
    "GetScanPatternConfig", "GetSpectroscopyConfig", "GetTipShaperConfig",
    "CheckScanForCrash",
]

#: 批 3d：**锁相放大器整族**（14 + 参数组 3），加 datalog 6 / marks 3。
#: 锁相是本仓第一个完整移植的测量子系统 —— dI/dV 的全部前提都在它上面。
BATCH_3D = [
    "GetLockInConfig", "ConfigureLockIn", "ConfigureLockInDemod",
    "GetDemodSignal", "GetDemodPhase", "GetDemodPhasReg",
    "GetDemodHarmonic", "GetDemodLPFilter", "GetDemodHPFilter",
    "SetModSignal", "SetModPhasReg", "SetModHarmonic",
    "SetDemodSyncFilter", "SetDemodRTSignals", "ListLockInPresets",
    "ApplyLockInPreset", "AutoPhase", "GetDataLogStatus",
    "StartDataLog", "StopDataLog", "GetTcpLogStatus",
    "StartTcpLog", "StopTcpLog", "ListScanMarkers",
    "DrawScanMarker", "EraseScanMarkers",
]



#: 批 3e：**锁相参数组三件套**（3d 已录轨迹、这一批落实现）+ 五个收口模块。
#:
#: 这五个都是「一层薄壳包一族 Nanonis 动词」的形状，值钱的地方在**哪些分支存在**：
#: Osci1T 那三个各自判 `NeedModule`（模块没装 ≠ 线路坏了，见 `CUSTOM_ERRORS`），
#: `SetSpectrumAnalyzerBand` 判 `lo >= hi`，`RunBiasSweep` 把颠倒的限值**换过来**
#: 而不是拒绝，`AtomTrackStatusGet` 的状态位在 body 第 0 位（旧仓读信封第 0 位那版
#: 在真机上把每一项控制都报成 Off）。
BATCH_3E = [
    "ConfigureAtomTrack", "AtomTrackDriftComp", "AtomTrackQuickCompStart",
    "AtomTrackStatusGet", "AcquireOsciTrace", "GetOsciTimebases",
    "SetOsciTimebase", "ConfigureSpectrumAnalyzer", "SetSpectrumAnalyzerBand",
    "GetSpectrumAnalyzerData", "RunBiasSweep", "GetSignalCalibration",
    "SetAdditionalRealtimeSignals", "SetAcquisitionPeriod", "BiasPulse",
]

#: 批 3f：**Nanonis 脚本整族**（白名单是这一批的要害）+ PLL 整族 + 仪器限值。
#:
#: 脚本那 14 个的判据全在一张**操作员维护的白名单**上：脚本编译后跑在 RT 控制器上，
#: 一个 `safe_call` 都不发 ⇒ 安全门 / 模式门 / 中止门 / HITL **在它内部全部不生效**。
#: 于是白名单是**唯一**的屏障，而 `LoadNanonisScript` 的判据是**反的**——
#: 它拒绝往**已审**槽位里装别的脚本（换掉内容会让那份批准变成一句假话）。
#:
#: PLL 那 36 个是 qPlus/AFM 的调频子系统，机械但成族；仪器限值那 6 个是
#: 「能读不能写」那一族的补完，每一次放宽都记账。
BATCH_3F = [
    # nanonis_script（11）
    "ListNanonisScripts", "GetScriptData", "GetScriptChannels",
    "RunNanonisScript", "StopNanonisScript", "DeployNanonisScript",
    "UndeployNanonisScript", "LoadScriptLUT", "DeployScriptLUT",
    "SetScriptChannels", "SetScriptAutosave",
    # nanonis_script_files（3）
    "LoadNanonisScript", "SaveNanonisScript", "SaveNanonisScriptLut",
    # instrument_limits（6）
    "SetZLimits", "SetWithdrawRate", "HomeZController", "SetPiezoLimits",
    "SetSafeTipProps", "SetActiveZController",
    # pll（36）
    "ConfigurePLL", "GetPLLStatus", "PLLOnOff", "ConfigurePLLExcitation",
    "AcquirePLLFreqSweep", "PLLSignalAnalyzer", "GetPLLAddOnOff",
    "SetPLLAmpCtrlBandwidth", "GetPLLAmpCtrlOnOff", "SetPLLAmpCtrlSetpnt",
    "GetPLLDemodFilter", "SetPLLDemodFilter", "GetPLLDemodHarmonic",
    "GetPLLDemodInput", "SetPLLDemodInput", "SetPLLDemodPhasRef",
    "GetPLLExcRange", "SetPLLFreqExcOverwrite", "GetPLLFreqRange",
    "SetPLLFreqRange", "PLLFreqShiftAutoCenter", "GetPLLInpCalibr",
    "SetPLLInpCalibr", "GetPLLInpProps", "SetPLLInpProps", "SetPLLInpRange",
    "PLLPerfectPLLUpdtZTC", "SetPLLPhasCtrlBandwidth", "GetPLLPhasCtrlOnOff",
    "GetPLLSignalAnlzrCh", "GetPLLSignalAnlzrFFTProps",
    "GetPLLSignalAnlzrTimebase", "PLLSignalAnlzrTrigAuto",
    "SetPLLSignalAnlzrTrig", "GetPLLFreqSwpParams", "StopPLLFreqSwp",
]

#: 批 3g / 3h / 3i —— **三条并行支线各占一个常量**。
#:
#: 分开而不是合成一张表，是为了让三份改动落在**不同的行**上：
#: 同一个文件、互不重叠的区段，git 合并时不需要有人去猜谁的对。
BATCH_3G: list[str] = [
    # optional_controllers（17）—— 两代通用 PI、MCVA5 前放、PLL 分析、OC Sync、针尖记录器
    "ConfigurePiController", "SetPiControllerOnOff", "GetPiController",
    "SetGenericPiOutput", "GetGenericPiController",
    "ConfigurePreamp", "GetPreamp",
    "RunPllZoomFft", "GetPllZoomFftData", "RunPllPhaseSweep", "StopPllPhaseSweep",
    "ConfigurePllSignalAnalyzer", "GetPllSignalAnalyzerData",
    "ConfigureOcSync", "GetOcSync", "ConfigureTipRecorder", "GetTipRecorderData",
    # optional_afm（14）—— KPFM / CPD / 干涉仪 / 光杠杆 / 激光
    "ConfigureKelvinController", "SetKelvinControllerOnOff", "GetKelvinController",
    "RunCpdCompensation", "GetCpdCompensation",
    "ConfigureInterferometer", "SetInterferometerOnOff", "GetInterferometer",
    "ConfigureBeamDeflection", "GetBeamDeflection", "AutoZeroBeamDeflection",
    "SetLaserOnOff", "SetLaserPower", "GetLaser",
    # optional_multiprobe（11）—— N 个各自能扎针的扫描器
    "SetProbeZController", "GetProbeZController", "WithdrawProbe",
    "ConfigureProbeScanner", "MoveProbeXY", "StopProbeScanner",
    "SetProbeBias", "PulseProbeBias", "GetProbeBias",
    "GetProbeCurrent", "ConfigureProbeCurrentGain",
    # optional_sweepers（9）—— 高速扫描器与 RF 源
    "ConfigureHighSpeedSweep", "RunHighSpeedSweep", "StopHighSpeedSweep",
    "GetHighSpeedSweepStatus", "ConfigureRfGenerator", "StartRfGenerator",
    "StopRfGenerator", "RunRfFrequencySweep", "GetRfGeneratorStatus",
    # optional_scopes（7）—— OsciHR / Osci2T / Signal Chart
    "ConfigureHighResScope", "RunHighResScope", "GetHighResScopeData",
    "GetHighResScopeStatus", "ConfigureDualScope", "GetDualScopeData",
    "ConfigureSignalChart",
]
BATCH_3H: list[str] = [
    "GetUserOutputLimits",
    "GetUserOutputMode",
    "GetUserOutputMonitorChannel",
    "GetDigitalLineTTL",
    "GetCalculatedOutputConfig",
    "SetUserOutput",
    "SetUserOutputMode",
    "SetUserOutputMonitorChannel",
    "SetUserOutputLimits",
    "SetUserOutputCalibration",
    "ConfigureCalculatedOutput",
    "PulseDigitalLine",
    "SetDigitalLineStatus",
    "ConfigureDigitalLine",
    "ConfigureBiasSweep",
    "AcquireBiasSweep",
    "ConfigureLockInSweep",
    "AcquireLockInSweep",
    "GetLockInSweepLimits",
    "GetLockInSweepProps",
    "GetLockInSweepSignal",
    "GenSwpAcqChsGet",
    "GenSwpPropsGet",
    "GenSwpStop",
    "GenSwpSwpSignalGet",
    "OpenPatternExperiment",
    "PausePatternExperiment",
    "SetPatternLine",
    "SetPatternCloud",
    "GetPatternCloud",
    "GetPatternProps",
    "ConfigureWaveform",
    "StartWaveform",
    "StopWaveform",
    "GetWaveformStatus",
    "SetWaveformIdleValue",
    "SetWaveformChannelOnOff",
    "SetSpectroscopyTtlSync",
    "SetSpectroscopyPulseSync",
    "SetSpectroscopyZControl",
    "SetZSpectroscopySecondRetract",
    "SetMlsLockinPerSegment",
    "GetSpectroscopyStatus",
    "QuitNanonis",
    "SetMultiPass",
    "LoadMultiPassConfig",
    "SaveMultiPassConfig",
    "WaitForScanEndBlocking",
]   # 输出 / 扫频 / 图样 / 函数发生器
BATCH_3I: list[str] = [
    # misc_setters（8）—— 2026-07-13 清点里「读得到、设不了」的最后八个
    "SetWaveformSignal", "SetLockInDemodPhaseRegister",
    "SetLockInFrequencySweepSignal", "SetPllExcitationAdd",
    "SetPllDemodHarmonic", "ConfigureScopeTrigger",
    "SetPatternExperiment", "SetPointShootProps",
    # qplus_amplitude（2）—— 独立于电流的撞针判据，三态
    "ReadTipOscillationAmplitude", "CheckTipCrashByAmplitude",
    # piezo_range_check（1）—— 配置说的和仪器说的是不是同一个数
    "CheckPiezoRange",
]   # 光学台 / 杂项 setter / 单件

#: 批 3j / 3k —— 又一轮两条并行支线，各占一个常量（同 3g/3h/3i 那一轮）。
BATCH_3J: list[str] = [
    # 流式读回一族：动作在控制器上跑、宿主侧在同一条连接上轮询电流与 Z。
    # 判据（`mast.io.z_trace`）**两个技能共用一份** —— 复制第二份的下场是
    # 两边阈值各自漂移，那正是它被提出来的原因（2026-08-01）。
    "BiasPulseWithReadback",
    "TipShapeWithReadback",
    # 同一族的第三个：只采不动。它的价值在那条**异常检测**上
    # （n≥8 且逐位相同 ⇒ 那不是一次测量）。
    "CaptureSignalBuffer",
]

BATCH_3K: list[str] = ["GetChamberPressure", "GetTemperature"]   # 环境读（真空互锁 + 温度）

#: 批 3l / 4a —— 第三轮两条并行支线。**每个常量之间隔一个空行加一句注释**：
#: 上一轮 3j/3k 紧挨着放，两条支线各改一行，git 照样冲突。
BATCH_3L: list[str] = [
    "AcquireSTS", "ConfigureSTS", "ConfigureZSpectr", "AcquireZSpectr",
    "ConfigureSTSTiming", "StopSTS", "StopZSpectr", "ConfigureSTSChannels",
    "ConfigureZSpectrTiming", "GetSTSChannels", "SetSTSChannels", "GetSTSLimits",
    "SetSTSAdvancedProps", "GetSTSTiming", "GetSTSAltZCtrl",
    "GetZSpectrChannels", "SetZSpectrChannels", "GetZSpectrRange", "SetZSpectrRange",
    "GetZSpectrRetract", "SetZSpectrRetract",
    "GetSTSDigSync", "GetSTSTTLSync", "GetSTSPulseSeqSync", "GetSTSZOffRevert",
    "GetSTSMLSLockinPerSeg", "SetSTSMLSMode", "SetSTSMLSVals",
    "SetSTSSafeCond1", "GetSTSSafeCond1", "SetSTSSafeCond2",
    "SetZSpectrAdvProps", "GetZSpectrDigSync", "GetZSpectrPulseSeqSync",
    "GetZSpectrRetract2nd", "SetZSpectrRetractDelay", "GetZSpectrTTLSync",
    "GetZSpectrTiming",
]   # builtins.spectroscopy 整族

#: ↑ 3l ／ ↓ 4a —— 这一行谁都不要动
BATCH_4A: list[str] = [
    # 掩膜 / 团簇一族
    "ExtractClusters", "AssessClusterRoundness", "SelectPokedCluster", "VerifyAdatomAt",
    # 平面族（K2）
    "MeasureStepHeight", "AssessFrameTrust",
    # 各自自足
    "LocateStepEdge", "AssessAtomicLines", "AssessFrameCorrugation",
]   # builtins 分析技能第一批
#
# ⚠️ 这九个里**八个只读文件**，而这台导出器的 `_params_for` 给不出一条真实的
# `scan_path` —— 于是它们在这里录到的是「文件不存在」那一支，一次 TCP 都不发。
# **那仍然是一条判据**（外壳在碰任何东西之前先拒），只是它不是这一批的主判据。
# 主判据在 `spec/golden/analysis.json`：那台导出器合成 `.sxm` 的**字节**、
# 让旧仓真技能跑一遍、把整棵 `SkillResult` 录下来，TS 那侧拿同一批字节复跑。
# 两份都要：这一份钉的是「它在注册表里、被真调度链调得动」，那一份钉的是判据本身。
#
# `AssessAtomicLines` 是九个里唯一跟仪器说话的，所以它在这里录到的是**真的**
# 动词序列（`Scan_BufferGet` → `Signals_NamesGet` → `Scan_FrameGet` →
# `Scan_FrameDataGrab`），外加注错点派生出来的那几条。
#
# （2026-09-20 归位：这段讲的是**上面 BATCH_4A 那九个**，而它此前一直挂在常量区最末尾。
#  每一批新常量都插在它前面，于是它离主语越来越远 —— 合并 7a-3 那天它正好跟在一个
#  **只有一个技能**的列表后面，「这九个」当场成了胡话。
#  **一段注释的主语，是它上面那一块，不是它当初写下时上面那一块。**）

#: ↑ 上一条 ／ ↓ 4B —— 这一行谁都不要动
BATCH_4B: list[str] = [
    # 晶格 `measure_cell` 组（批 4a 欠下的两个）
    "AssessScanTexture", "MeasureLatticeCell",
    # 原子相判据环
    "AssessAtomicResolution", "AnalyseAtomicLattice",
]   # 晶格判据底座 + 原子分辨判定一族
#
# ⚠️ 与批 4a 同一种情形：这四个**一次 TCP 都不发**，读的是磁盘上的 `.sxm`。
# 这台导出器的 `_params_for` 给不出一条真实的 `scan_path`，于是它们在这里录到的
# 是「文件不存在」那一支。**那仍然是一条判据**（外壳在碰任何东西之前先拒），
# 但这一批的主判据在 `spec/golden/lattice.json` 的 `skills` 节 ——
# 那一节是拿**真的合成 `.sxm`** 喂进旧仓技能录的。

#: ↑ 上一条 ／ ↓ 4C —— 这一行谁都不要动
BATCH_4C: list[str] = [
    # builtins.scan_frame 收口
    "LoadScanFrameFromFile", "ParseRegions", "ComputeDriftVector",
    # paper.data_processing 整族
    "SubtractPlane_RANSAC", "LevelLines_Median", "FindEmptySpot", "CorrectDrift_XCorr",
    # paper 的五个单件模块
    "SubtractPoly2D", "Destripe_MorphOpen", "AutoCrop_UnscannedRegion",
    "Denoise_AE", "DetectAtomJump",
]   # paper 数据处理 + scan_frame 一族
#
# ⚠️ 这十二个里**十一个只读文件**，而这台导出器的 `_params_for` 给不出一条真实的
# 路径 —— 于是它们在这里录到的是「读不动」那一支，一次 TCP 都不发。
# **那仍然是一条判据**（外壳在碰任何东西之前先拒），只是它不是这一批的主判据。
# 主判据在 `spec/golden/paper_data.json`：那台导出器合成 `.npy` / `.sxm` / `.dat`
# 的**字节**、让旧仓真技能跑一遍、连它写出去的文件一起录。
# `ComputeDriftVector` 是唯一跟仪器说话的那个，而它在这里先卡在读参考图上 ——
# 也就是说「参考图读不动就不发 TCP」这条顺序是**这一份**钉住的。

#: ↑ 上一条 ／ ↓ 4D —— 这一行谁都不要动
BATCH_4D: list[str] = [
    # 两个组合技能。通用驱动器喂的是常数回包、子技能一律 `success=True, data={}` ——
    # 于是它走到的是**调用序列与报文**，碰不到 `resolve_scan` 与撞针追踪的判据。
    # 那两台判定机各有自己的驱动器（`export_scan_resolver.py` / `export_tip_crash.py`）。
    "ScanAt", "FullScan",
]   # composite.scan_at + 撞针追踪

#: ↑ 上一条 ／ ↓ 5A —— 这一行谁都不要动
BATCH_5A: list[str] = [
    # 两个修针技能。`validate_params` **这台驱动器一次都不调**（它直调 `execute`）——
    # D-TIP-1 的包络判据因此在这份金样里**一格都照不出来**，那一台在
    # `export_tip_policy.py`。这里录的是调用序列、方案表填进去的值、以及
    # `data.tip_policy` 那串来源痕迹。
    "TipShape", "TipPulse",
    # 两个自检。**本仓这一侧是有意不同的**（`except → ok=False, blocking=True`、
    # registry 那一项换成「还有几个没移植」），差异逐格登记在 `traces.test.ts`。
    "TipConditioningSelfCheck", "TipForgeSelfCheck",
]   # 针尖登记表底座 + TipPulse/TipShape + 两个 fail-open 自检

#: ↑ 上一条 ／ ↓ 5B —— 这一行谁都不要动
BATCH_5B: list[str] = [
    # 电流诊断三件（轮询循环 + 偏压依赖判别表 + 饱和退针）
    "MonitorCurrent",
    "MonitorCurrentFFT",
    "ClassifyUnexplainedCurrent",
    "RecoverTipFromSaturation",
    # 时序两件
    "WaitForThermalSettle",
    "WatchScanLines",
    # 组合三件（GraphExecutor 的相计划 / 子技能计划各一 + 一个不走执行器的）
    "BiasSettleChange",
    "AcquirePSD",
    "BatchRegionsScan",
    # ⚠️ `RunGridExperiment` **不在这一批**。它的 `_phase_tick` 超时判据读的是
    # **墙钟**（`time.time()`），而本导出器把墙钟钉死成常数 ⇒ 那条判据在金样里
    # 永远走不到，录下来的是「1800 拍全跑完、报 success」。本仓 `SkillContext`
    # 只有单调钟 `now()`（而它正是真机上那条判据成立的钟），同一份脚本下第 ~1796
    # 拍真的超时 —— 于是 `ok` 那一格的 `success` 与金样**相反**，
    # 而 `traces.test.ts` 的 `success` 一项没有 deviation 逃逸口。见 batch-5b.md §5。
]   # A 档零散一批（各自自足，不压子系统）

#: ↑ 上一条 ／ ↓ 5C —— 这一行谁都不要动
#: ↑ 上一条 ／ ↓ 6A —— 这一行谁都不要动
BATCH_6A: list[str] = []   # 特异化流程 _tip_phases 六个组合技能

#: ↑ 上一条 ／ ↓ 6B —— 这一行谁都不要动
BATCH_6B: list[str] = [
    # 两个都**不碰仪器**（读磁盘上的 .sxm），所以这两格录到的是「文件不存在」
    # 那一支 —— 导出器的 _params_for 给不出真实的 scan_path / folder。
    # **那仍然是一条判据**（外壳在碰任何东西之前先拒），而主判据在
    # spec/golden/scan_prep.json 的 skills 节（26 + 6 格，喂真的合成 .sxm）。
    "AnalyzeScanImage",
    "AutoProcessScanBatch",
]   # vision 的 scan_prep 链

#: ↑ 上一条 ／ ↓ 6C —— 这一行谁都不要动
BATCH_6C: list[str] = [
    # 判针尖的两件（.sxm / .dat 各一）
    "AssessTipSharpness", "AssessTipFromSpectrum",
    # Sader–Jarvis 反演
    "InvertForceSaderJarvis",
    # 多帧原子相一致性
    "AssessAtomicConsistency",
]   # 批 5b 欠下的数值原语 + 晶格一族剩余
#
# ⚠️ 与批 4a/4b 同一种情形：这四个**一次 TCP 都不发**，读的是磁盘上的 `.sxm` /
# `.dat`。这台导出器的 `_params_for` 给不出一条真实的路径，于是它们在这里录到的
# 是「文件不存在」那一支。**那仍然是一条判据**（外壳在碰任何东西之前先拒），
# 但这一批的主判据在 `spec/golden/batch6c.json` 的 `skills` 节 ——
# 那一节是拿**真的合成字节**喂进旧仓技能录的。

#: ↑ 上一条 ／ ↓ 7A-1 —— 这一行谁都不要动
BATCH_7A_1: list[str] = [
    # 只读磁盘上的 .sxm ⇒ 这里录到的是「文件不存在」那一支（同批 4a/6b/6c）。
    # 主判据在 `spec/golden/tilt.json` 的 `skills.AnalyzeFrameTilt`（12 格，喂真字节）。
    "AnalyzeFrameTilt",
    # 这三个**真的发动词**，所以这里录到的是真的调用序列：
    #   TiltProbeCircle  —— FolMe_XYPosGet → Scan_FrameGet → 一圈 XYPosSet/ZPosGet → 回起点
    #   TiltCalibrate    —— Piezo_TiltGet 之后就停在「基线测量失败」（通用驱动器没有子技能）
    #   AutoTilt         —— 停在「没标定过」那一支（通用驱动器的档案是空的）
    # 后两个的**主判据**同样在 tilt.json（17 + 11 格，子技能由脚本扮演）。
    "TiltProbeCircle",
    "TiltCalibrate",
    "AutoTilt",
]   # vision/tilt 一族 + 三个调平技能

#: ↑ 上一条 ／ ↓ 7A-2 —— 这一行谁都不要动
BATCH_7A_2: list[str] = [
    # 实验地图层。这台导出器的假 context **给不出实验记录、也给不出撞针记忆**，
    # 于是这里录到的一律是「地图读不到 + 本进程没撞过」那一条 ——
    # 而那**正是它最该被钉住的一条**：`map_known=false` 的那句话逐字、
    # `avoidance_sources` 是空表、落点照样给得出来。
    # 主判据在 `spec/golden/map_scope.json`（自己摆世界的那一台，37 格）。
    "FindCleanSpot",
]   # 实验地图层 + FindCleanSpot

#: ↑ 上一条 ／ ↓ 7A-3 —— 这一行谁都不要动

#: ↑ 上一条 ／ ↓ 7B-1 —— 这一行谁都不要动
BATCH_7B_1: list[str] = [
    # 读磁盘上的 .sxm，一次 TCP 都不发 ⇒ 这台通用驱动器只录得到「文件不存在」那一支
    # （`_params_for` 给不出真实路径）。**主判据在 `spec/golden/batch7b1.json`**：
    # 那一份自己合成 .sxm 字节，把覆盖率门、尺度闸、四条 IO 失败路径与
    # `expected_a_nm` 的三态逐格录下来。
    # 这一格留着的理由只有一个：`scan_path` 是必填，而必填参数缺席时那句拒绝
    # 是**模型面**的，通用驱动器是唯一录得到它的地方。
    "AssessAtomicPhase",
]   # 原子相自检的技能壳


#: ↑ 上一条 ／ ↓ 7B-2 —— 这一行谁都不要动
BATCH_7B_2: list[str] = [
    # 势垒链三件。通用驱动器给每个子技能 `success=True, data={}`，于是
    # `MeasureBarrierHeight` 走到的是「方向确认那一读没有电流」那一支
    # （`AcquireSTS` 的 `data` 是空的 ⇒ `spectrum_parsed` 假 ⇒ `_read_at` 回 None），
    # 另外两个各自走到它们**第一条**判据。主判据在 `spec/golden/batch7b2.json`：
    # 那台驱动器给每个子技能**脚本化**的回包，每一道闸各有一格自己的输入。
    "MeasureBarrierHeight",
    "MapBarrierHeight",
    "CleanTipUntilBarrier",
    # ⚠️ 这两个在这里录到的正是**死代码那一支**：`ScanAt` 从不返回 `scan_path`
    # （旧仓 `scan_at.py:368-389` 与本仓 `scan-at.ts:183-198` 逐键比过），
    # 于是 `AcquireBiasSeries` 的 `AssessFrameTrust` 一次都不调、`drift_check` 恒 None，
    # 而 `CalibrateCoarseStep` 恒在「基准帧扫描失败」返回。
    # **那不是导出器的缺陷，那就是今天的行为** —— 录下来，并在
    # `batch7b2-skills.test.ts` 里用一条量着 `ScanAt` 回包键的测试钉住它。
    "AcquireBiasSeries",
    "CalibrateCoarseStep",
    # 十个 Nanonis 动词全在 `methods.ts`，零 `context.run`。
    "AcquireDeltaFCurve",
    # ⚠️ 墙钟那条判据：`wait_timeout_s` 取 **11.0** 而不是缺省 3600 —— 见 PARAM_OVERRIDES。
    "RunGridExperiment",
    # `builtins.optics_scan` 的 A 档那一半（**不碰 registry**，见 optics-acquire.ts 抬头）。
    "AcquireSignalPoint",
]   # 势垒链与线缆（8 个技能 / 7 个模块收口）


#: ↑ 上一条 ／ ↓ 7B-3 —— 这一行谁都不要动

#: ↑ 上一条 ／ ↓ 8A-1 —— 这一行谁都不要动
BATCH_8A_1: list[str] = []


#: ↑ 上一条 ／ ↓ 8A-2 —— 这一行谁都不要动
BATCH_8A_2: list[str] = []


#: ↑ 上一条 ／ ↓ 8A-3 —— 这一行谁都不要动
BATCH_8A_3: list[str] = []

BATCH_7B_3: list[str] = [
    # 甲 · 五个组合技能。通用驱动器喂常数回包、子技能一律
    # `success=True, data={}` —— 于是这里录到的是**调用序列与报文**，
    # 碰不到各自的判据。五个的主判据在 `spec/golden/batch7b3.json`
    # （那一台自己摆子技能的返回，见它的抬头）。
    #
    # 这一路仍然值钱：它是**另一套夹具**对同一份移植的交叉核对，
    # 而且它录到的恰好是每个技能「子技能什么都不说」时的形状 ——
    #   GridSTS                  —— 全成功（`data={}` 不妨碍计数）
    #   DemoScanAndSTS           —— 同上，wait 那一步的 `data={}` ⇒ `scan_completed=True`
    #   TrackDrift_ReferenceScan —— 第一趟采参考：抓帧走的是**裸** `Scan_FrameDataGrab`
    #   AcquireBiasImagingSeries —— `GetBias` 回 `{}` ⇒ 每一帧都落「偏压没跟上：…读回 None」
    #   MoveAtomTo               —— 读回全空 ⇒ prior 走缺省，verify 无 verdict
    "GridSTS",
    "DemoScanAndSTS",
    "TrackDrift_ReferenceScan",
    "AcquireBiasImagingSeries",
    "MoveAtomTo",
    # 乙 · 四个 paper 纯函数。只读磁盘上的图，一次 TCP 都不发 ⇒ 这里录到的是
    # 「文件不存在」那一支（同批 4a/4c/6b/6c —— `_params_for` 给不出真实路径）。
    # **那仍然是一条判据**（外壳在碰任何东西之前先拒），
    # 主判据在 `spec/golden/paper_data.json` 的 `skills` 节（喂真的合成字节）。
    "DiffScans_ChangeDetect",
    "DeconvolveTip_RL",
    "SegmentRegion_UNet",
    "DetectAtoms_FCN",
]   # composite 零新原语五个 + paper 四个纯函数

BATCH_7A_3: list[str] = [
    # 读磁盘上的 .sxm，一次 TCP 都不发 ⇒ 这里录到的是「文件不存在」那一支
    # （`_params_for` 给不出真实路径）。主判据在 `spec/golden/batch7a3.json`。
    "FindFlatRegion",
    # 这一个**真发命令**：反馈门 → 起点确认 → 斜坡 + 电流看护 → 收尾放回偏压。
    # 通用驱动器给每个动词一个常数回包，于是它在这里录到的是**完整的一次 burst**
    # （假钟 + seed=0 走非确定分支 ⇒ 见 PARAM_OVERRIDES）。
    "BiasWiggle",
]   # kde_layers + FindFlatRegion + BiasWiggle

BATCH_5C: list[str] = [
    # 零 TCP —— 它读的全是进程内的仪器档案。所以这四格录的是**报文**，
    # 而报文正是这个技能的全部产物（「从未标定过」vs「读不到档案」）。
    "ReadCalibrations",
    # 分级退针。假回包是恒定的 ⇒ settle 每次都在第 5 个样本上收敛成 `tracking`，
    # 而恒定电流 0.25 A 远高于 1 nA 的绝对地板 ⇒ 第 0 级就跳闸判 `approaching`。
    # 录到的正是**电流危险跳闸**那一支与它的措辞。
    "RetractForSampleChange",
    # 这两条停在**驱动读回**那道闸上（`coarse_drive` 没有声明 ⇒ 拒绝一切）。
    # 那是本批最要紧的一道闸，而且它**没有**别的金样覆盖。
    # 声明装上之后的那几支在 `export_coarse_drive.py` 里 —— 通用驱动器喂常数回包，
    # 走不到档案与粗动的判据。
    "RelocateCoarseXY",
    "StepCoarseXY",
]   # 仪器档案 + Z 稳定 + 粗动驱动三个子系统


#: 「模块没装」那条分支要的是一条**带 `NeedModule` 字样**的错。
#:
#: 通用注错点给的文案是「连接被对端关闭」，而 Osci1T 那三个技能靠
#: `"NeedModule" in rec.error` 分流 —— 一条注错文案决定了走哪条分支，于是它必须是
#: 一个**单独的开关**，不能指望通用注错碰巧命中。两种错都要录：带 NeedModule 的
#: 走「去 Nanonis 里打开那个模块」，不带的**继续往下跑**（`Osci1T_Run` 是幂等的，
#: 它失败不代表取不到数）。
#:
#: 文案本身是夹具，判据落在**技能自己说了什么**上——那句话是模型读的东西。
CUSTOM_ERRORS: dict[str, dict[str, tuple[int, str]]] = {
    "AcquireOsciTrace": {"need_module@0": (0, "NanonisError: NeedModule Osci1T")},
    "GetOsciTimebases": {"need_module@0": (0, "NanonisError: NeedModule Osci1T")},
    "SetOsciTimebase": {"need_module@0": (0, "NanonisError: NeedModule Osci1T")},
}

#: 批 3a（扫描主链）。`WaitScanComplete` 在计划里单独占一格：它是第一个**长时**
#: 技能，抱着 abort、超时、五种 outcome，以及那条硬约束 ——
#: 「dsh 超时也触发 signal，**绝不把仪器留在运动中**」。
BATCH_3A = [
    "ConfigureScan", "SetScanSpeed", "StartScan", "WaitScanComplete",
    "SaveScan", "GrabScanFrameData",
]

#: 批 3b：GraphExecutor 的另一半验收（先算后排的动态计划）。
BATCH_3B = ["SetBiasRamp"]

#: **不进轨迹金样**的技能。
#:
#: 两个 L1 试点是 GraphExecutor 图技能：它们的「成功」需要一份**会收敛的**物理脚本
#: （Z 压电要真的往下走、电流要真的涨到设定点），而合成回包给的是恒定值，
#: 于是 `ok` 那一趟实际录到的是「模块报在跑、压电纹丝不动」的 1800 秒超时。
#:
#: 2026-09-11 把 `AutoApproach` 放回来了：会收敛的那一路现在有
#: `export_approach.py` 的 20 格专门覆盖，而这一路录到的**失败形状**恰好是真机
#: 2026-08-08 那 7 次的形状——它是一份**独立驱动器**（另一套假 context、另一套回包
#: 形状）对同一份移植的交叉核对，值钱的正是它跟那 20 格不一样。
#: 2026-09-11：`ApproachTip` 也放回来了。它是 L2 技能——只调别的技能，一次裸动词都
#: 不发——所以通用合成器的「恒定回包」对它根本不成立；它读到的是脚本化的子技能返回，
#: 而那一路录到的是「engage 既没建立隧穿也没说需要粗进针」那一支（连同它记下的那条
#: 拒绝）。会收敛的那一路由 `export_approach_tip.py` 的 15 格覆盖。
TRACE_SKIP: set[str] = set()

#: 入参**从技能自己的声明派生**，不手写。
#:
#: 手写过一版，七个技能的 `ok` 轨迹直接 KeyError —— 名字我全猜错了
#: （`enabled` 其实叫 `enable`、`path` 叫 `session_path`、`speed_m_per_s` 叫
#: `speed_m_s`）。而声明里就有真名，猜它没有任何理由。
def _param_value(spec: Any) -> Any:
    """给一个参数编一个**合法**的值：枚举取第一个，有界取中点，其余按类型。"""
    allowed = getattr(spec, "allowed_values", None)
    if allowed:
        return allowed[0]
    t = (getattr(spec, "type", "") or "").lower()
    if t in ("bool", "boolean"):
        return True
    lo, hi = getattr(spec, "min_value", None), getattr(spec, "max_value", None)
    if t in ("int", "integer"):
        if lo is not None and hi is not None:
            return int((lo + hi) / 2) or int(hi)
        return int(lo if lo is not None else (hi if hi is not None else 1))
    if t in ("float", "number"):
        if lo is not None and hi is not None:
            # 中点，但避开 0（有些技能对 0 有专门分支，那属于另一条用例）
            mid = (lo + hi) / 2
            return mid if mid != 0 else (hi / 2 if hi else lo / 2)
        if lo is not None:
            return lo
        if hi is not None:
            return hi
        return 1e-9 if (getattr(spec, "unit", "") or "") in ("m", "A") else 1.0
    # str：有单位的（CreateZCtrlPreset 那三个）要写成带 SI 前缀的字符串
    unit = (getattr(spec, "unit", "") or "").strip()
    if unit in ("m", "A", "m/s"):
        return "150p"
    return "spec-export"


#: 通用规则给不出合法值的几个。**只列真需要的**——每多一条就多一处手写的真源。
PARAM_OVERRIDES: dict[str, dict] = {
    # 缺省 -1 = **无限等**。给一个有限值，好让「超时」那条 outcome 被录到 ——
    # 不给的话录到的是「导出脚本挂住了」。
    "WaitScanComplete": {"timeout_ms": 5000},
    # 逗号分隔的整数串，不是自由文本
    "GetSignalValues": {"signal_indexes": "0"},
    # 幅度取一个**在任何叠堆上都不会烧**的低值（默认中点 200 V 会撞上「本机上限未声明」）
    "SetMotorFreqAmp": {"amplitude_v": 30.0, "frequency_hz": 1000.0},
    # 起点**显式给**：不给的话第 0 步去读偏压，而合成回包读回来的是
    # 一个随协议表位置而定的数——斜坡的步数会跟着那个数走，轨迹就成了
    # 「合成器当时给了什么」的记录，而不是这个技能的记录。
    # 起点没给那条路由 `bias_ramp.json` 的 13 格专门覆盖。
    "SetBiasRamp": {"bias_v_start": 0.0, "bias_v_end": 0.5},
    # 缺省 1800 s = 30 分钟。假钟不占墙钟，但每半秒一次轮询会录出 3600 条调用。
    # 给一个短的：录的是**形状**（模块报在跑、压电纹丝不动、到点停机），不是时长。
    "AutoApproach": {"wait_timeout_s": 5.0},
    # 四个参数都是**浮点数的 JSON 列表**，通用规则给的 "spec-export" 解析不了 ——
    # 于是 `ok` 那一趟录到的是解析拒绝，成功那一路一条金样都没有。
    "SetPiezoHysteresisValues": {
        "fast_x": "[0.0, 0.5, 1.0]", "fast_y": "[0.0, 0.25, 0.75]",
        "slow_x": "[0.1, 0.2]", "slow_y": "[0.3, 0.4]",
    },
    # 批 5c：`steps` 的中点是 **50000**，而 `plan()` 会按 `xy_move_chunk_steps`
    # 把它摊成 5000 个步骤 —— 一份没人读得完的金样，而这一趟在第 1 步就被驱动闸拒掉，
    # 那 5000 步一个都不会跑。给一个读得完的数。
    "RelocateCoarseXY": {"steps": 20},
    # 逗号分隔的通道索引。通用规则给的 "spec-export" 解析不了 ⇒ `ok` 那一趟录到的
    # 是解析拒绝，而下发那一路（三次/四次调用）一条金样都没有。
    "StartDataLog": {"channels": "0,14", "duration_s": 10.0},
    "StartTcpLog": {"channels": "0,14"},
    # 两个边界都取中点 ⇒ `f_low_hz == f_high_hz` ⇒ **`ok` 那一趟录到的是拒绝**，
    # 而下发那一路一条金样都没有。给一个真的频带；lo ≥ hi 那支在 EXTRA_PARAMS 里。
    "SetSpectrumAnalyzerBand": {"f_low_hz": 1.0, "f_high_hz": 1000.0},
    # 同理：±10 V 的中点是 0，通用规则避开 0 于是上下限都成了 5.0 ——
    # 一次「从 5 V sweep 到 5 V」的退化轨迹。
    "RunBiasSweep": {"lower_limit_v": -1.0, "upper_limit_v": 1.0},
    # 槽位号的中点是 32，而白名单夹具里只有 3 与 5 ⇒ `ok` 那一趟会落在拒绝上，
    # 下发那一路一条金样都没有。**已审**的槽位走 3。
    "RunNanonisScript": {"slot": 3},
    # 批 7a-3：`seed` 的缺省是 **0**，而 `0` 在这个技能里是「非确定性」那一档
    # （`random.Random(seed) if seed else random.Random()`）—— 不显式给的话
    # 这一格每跑一遍都不一样，**整份 `skill_traces.json` 就不再逐字节可复现**。
    # `base_bias_v` 的中点是 0，通用规则避开 0 之后给的是 5.0 V，而
    # `|base| > 0.1 + upper` 会当场拒 ⇒ 下发那一路一条金样都没有。
    # `burst_s` 的中点 5.05 s 在假钟下会录出上百条调用；0.3 s 录得完，
    # 而且形状一样（反馈门 → 起点 → 若干次斜坡 + 电流看护 → 收尾）。
    "BiasWiggle": {"base_bias_v": 0.02, "seed": 7, "burst_s": 0.3},
    "DeployNanonisScript": {"slot": 3},
    "LoadScriptLUT": {"slot": 3, "lut_index": 1, "values": "0, 2.5, 5, 7.5, 10"},
    # 反过来：`LoadNanonisScript` 拒的是**已审**槽位，所以它的成功路要一个**未审**的。
    "LoadNanonisScript": {"slot": 7, "file_path": "C:/nanonis/scripts/delay.ns"},
    "SaveNanonisScript": {"file_path": "C:/nanonis/out/slot3.ns"},
    "SaveNanonisScriptLut": {"file_path": "C:/nanonis/out/slot3_lut.dat"},
    "SetScriptChannels": {"channels": "0,24"},
    # ±100 µm 的中点是 0 ⇒ 通用规则给的上下限会撞成同一个数
    "SetZLimits": {"z_high_limit_m": 5e-7, "z_low_limit_m": -5e-7},
    # 六个界的中点都是 0 ⇒ 通用规则给的下界与上界撞成同一个数 ⇒  录到的是拒绝
    "SetPiezoLimits": {"x_low_v": -150.0, "x_high_v": 150.0,
                       "y_low_v": -150.0, "y_high_v": 150.0,
                       "z_low_v": -120.0, "z_high_v": 120.0},
    # ── 批 3g：五处「上下界撞成同一个数 ⇒ ok 那一趟录到的是拒绝」──
    #
    # 通用规则给 min/max 取中点，而这几对界的中点相同 ⇒ `lo >= hi` 恒成立。
    # 不给的话下发那一路一条金样都没有；反过来的那一支在 EXTRA_PARAMS 里单录。
    "ConfigurePiController": {"output_lower_limit": -1.0, "output_upper_limit": 1.0},
    "ConfigureKelvinController": {"bias_low_limit_v": -2.0, "bias_high_limit_v": 2.0},
    "RunRfFrequencySweep": {"lower_hz": 1.0e9, "upper_hz": 2.0e9},
    # `_channels` 严格到整数，通用规则给的 "spec-export" 解析不了
    "ConfigureHighSpeedSweep": {"acquire_channels": "0,14", "start": -1.0, "stop": 1.0},
    # 三项全是可选 ⇒ 一个都没给 ⇒ `ok` 录到的是「至少要给一个」
    "ConfigurePreamp": {"gain": 2},
    # ── 批 3h ──────────────────────────────────────────────────────────────
    # 合成回包给的物理限值是 [0.25, 0.5]（`UserOut_LimitsGet` 的 `["f","f"]`），
    # 而通用规则给的 value=1 落在界外 ⇒ **`ok` 那一趟录到的是拒绝**，
    # 下发那一路一条金样都没有。给一个界内的值；越界那支进 EXTRA_PARAMS。
    "SetUserOutput": {"value": 0.3},
    # 逗号分隔的 1..8 行号；通用规则给的 "spec-export" 解析不了
    "PulseDigitalLine": {"lines": "1,2"},
    # 坐标是**浮点数的 JSON 数组**
    "SetPatternCloud": {"x_coords": "[1e-9, 2e-9]", "y_coords": "[3e-9, 4e-9]"},
    # 两个同步开关一个都不给 ⇒ 拒绝。给一个，另一支进 EXTRA_PARAMS
    "SetSpectroscopyPulseSync": {"digital_sync": 1},
    # ±10 V / ±100 kHz 的中点都被通用规则避开成同一个数 ⇒ 扫一个零宽的区间
    "ConfigureBiasSweep": {"lower_v": -1.0, "upper_v": 1.0},
    "ConfigureLockInSweep": {"lower_hz": 100.0, "upper_hz": 2000.0},
    # 给个名字，「配置成了但命名失败」那一支才存在（由 err@1 走到）
    "ConfigureCalculatedOutput": {"name": "diff"},
    # ── 批 3j：把采集窗口收短 ────────────────────────────────────────────────
    #
    # 与 `WaitScanComplete` / `AutoApproach` 那两条同一条理由：假钟不占墙钟，
    # 但**每一帧都要录进金样**。缺省那一组（脉冲 1.15 s、整形 0.9 s、采集 1 s）
    # 在假钟下是 300–1000 帧 × 两条通道的完整样本表 —— 一个技能就能让
    # `skill_traces.json` 涨几百 KB，而录的是**形状**（预卷→开火→尾窗、
    # 判据走了哪一支、异常检测响没响），不是时长。
    #
    # ⚠️ 收短不能收到判据变形：`step_verdict` 要 `n_pre >= 2` 且 `n_post >= 2`，
    # 而假钟下一帧约 3 ms（一圈三次 `perf_counter`）。预卷 20 ms ⇒ 约 6 个基线点，
    # 尾窗 20 ms ⇒ 约 6 个。判不出来那一支由 `export_z_trace.py` 专门覆盖。
    #
    # ⚠️ `post_roll_s` **刻意不落在采样栅格上**（假钟下一帧 3 ms，取 21.5 ms）。
    # 后窗是 `t >= cap - win` 的闭区间：边界正好压在一个样本上时，两侧假钟那
    # 1e-10 的残渣会决定它进不进窗 —— `n_post` 因此差一个。**那是夹具的属性**，
    # 不该由它来决定金样红不红。（TipShaper 的 `err@78` 当场撞到过。）
    "BiasPulseWithReadback": {
        "width_s": 0.01, "pre_roll_s": 0.02, "post_roll_s": 0.0215,
        "max_capture_s": 0.2,
    },
    "TipShapeWithReadback": {
        "switch_off_delay_s": 0.01, "lift_time_1_s": 0.01, "bias_settling_s": 0.01,
        "lift_time_2_s": 0.01, "end_wait_s": 0.01,
        "pre_roll_s": 0.02, "post_roll_s": 0.0215, "max_capture_s": 0.2,
        # 缺省 0.0 ⇒ `resolved_lift_height_m` 回 `-0.0`。给一个真的深度：
        # 扎进去 2 nm、抬回来 2 nm，那条「没给就取 −tip_lift_m」的规则才看得见。
        "tip_lift_m": -2e-9,
    },
    "CaptureSignalBuffer": {"duration_s": 0.05},
    # ── 批 7b-2 ────────────────────────────────────────────────────────────
    #
    # `bias_v` 显式给：不给的话第一句就是 `run("GetBias")`，而通用驱动器给每个
    # 子技能 `data={}` ⇒ 读不到偏压 ⇒ **`ok` 那一趟录到的是「不猜一个值去量」**，
    # 后面配 STS、试方向那一整串一条金样都没有。
    "MeasureBarrierHeight": {"bias_v": 0.5},
    # 位置串是 `x,y` 分号分隔，通用规则给的 "spec-export" 解析不了 ⇒ 录到的是拒绝。
    # `repeats` 取下限 4（缺省 6）：重复那一段每次 2 个子技能调用，
    # 录的是**形状**（噪声标尺先跑、各位置后跑），不是次数。
    "MapBarrierHeight": {"sites_nm": "0,0; 100,0; 0,100; 100,100", "repeats": 4},
    # 偏压串同理。`pixels`/`line_time_s` 取下限 —— 这一趟一帧都扫不出来
    # （子技能是假的），两个数只进 `ScanAt` 的入参回显。
    "AcquireBiasSeries": {"biases_v": "1,-1", "pixels": 32, "line_time_s": 0.005},
    # 留空则按名字在信号表里找频移／电流／振幅，而合成的信号名是 `Sig2A/Sig2B`
    # ⇒ 找不到频移 ⇒ `ok` 那一趟录到的是「信号表里没有频移通道」，
    # 下发那一串（`ZSpectr_Open/ChsSet/RangeSet/PropsSet/Start`）一条金样都没有。
    "AcquireDeltaFCurve": {"channel_indexes": "0,14,2", "num_points": 16},
    # ⚠️ **这三个数是一条判据，不是图省事**（见 `pattern-grid.ts` 抬头那张表）：
    #
    #   `max_ticks = ⌊11.0 / 2.0⌋ = 5`，五拍睡满 `5 × 2 = 10 s`，而 `10 < 11`
    #   ⇒ **「计划的拍数上限先到」在两个钟上同时成立**：
    #     · 这台导出器把墙钟钉死（`_fake_time` 恒回常数）⇒ `elapsed ≡ 0`；
    #     · 本仓只有单调钟，假钟被 `sleep` 往前拨 ⇒ `elapsed` 真的涨到 10 s。
    #   两侧都在第 5 拍之后走 cleanup、报 `success=True`。
    #
    # 取缺省 3600 的话 `max_ticks = 1800`、睡满 3600 s ⇒ 本仓这一侧**真的超时**，
    # 而金样那一侧永远不会 ⇒ `success` 相反，而 `traces.test.ts` 的 `success`
    # 没有 deviation 逃逸口（批 5b 因此整个搁置了这个技能）。
    # 顺带：3600 那一档一个技能就让 `skill_traces.json` 涨 1.10 MB。
    # **超时那一支由 `export_batch7b2.py` 单独录**（那台的假钟会走）。
    "RunGridExperiment": {"nx": 2, "ny": 2, "wait_timeout_s": 11.0},
    # 缺省 10 次 × 1 路 = 10 条一模一样的 `Current_Get`。3 次 × 3 路录得完，
    # 而且**多路**那一支（`sig{i}_mean/std` 两列）只有给了 `signal_indices` 才存在。
    "AcquireSignalPoint": {"samples": 3, "signal_indices": "0,14"},
}

#: 额外的入参组合，各录成一条独立轨迹。
#:
#: 通用驱动只跑一组参数，而有些分支**由参数决定**而不是由回包决定 ——
#: 「JSON 解析不了」「通道清单是空的」这一类。注错与空 body 那两套开关碰不到它们。
EXTRA_PARAMS: dict[str, dict[str, dict]] = {
    "SetPiezoHysteresisValues": {
        "bad_json": {"fast_x": "不是 JSON", "fast_y": "[]",
                     "slow_x": "[]", "slow_y": "[]"},
    },
    # 撞针检测里由参数决定的两支：清单全是空白（回落到默认 0,14）、
    # 以及夹着非法记号（**跳过它继续**，不是整趟失败）。
    "CheckScanForCrash": {
        "blank_channels": {"channels": "  "},
        "junk_channels": {"channels": "0, x, 14;7"},
    },
    # 与撞针那边**刻意不同**：这里的通道解析是严格的，一个非整数就整串作废。
    "StartDataLog": {"bad_channels": {"channels": "spec-export"}},
    "StartTcpLog": {"bad_channels": {"channels": "spec-export"}},
    # 线标记要终点；不给就拒（而 `kind` 错了是另一支）
    "DrawScanMarker": {
        "line": {"kind": "line", "x2_m": 2e-9, "y2_m": 3e-9},
        "line_without_end": {"kind": "line"},
        "bad_kind": {"kind": "square"},
    },
    "EraseScanMarkers": {"hide_only": {"hide_only": True}, "bad_kind": {"kind": "square"}},
    # 调制侧四个字段各写各的：哪个没给就不写哪个
    "ConfigureLockIn": {
        "with_values": {"frequency_hz": 973.0, "amplitude_v": 0.02, "phase_deg": 90.0},
        "zero_amplitude": {"amplitude_v": 0.0},
        "off": {"mod_on": False},
    },
    "ConfigureLockInDemod": {
        "signal_and_harmonic": {"signal_index": 24, "harmonic": 1},
        "lp_only": {"lp_cutoff_hz": 100.0},
        "phase": {"phase_deg": 45.0},
    },
    # 两个使能各自可以不开 —— 而「没开」与「开了但失败」在旧仓曾经是同一个返回值
    "ConfigureAtomTrack": {
        "no_enables": {"enable_modulation": False, "enable_controller": False},
        "modulation_only": {"enable_controller": False},
    },
    # 0=Tilt / 1=Drift：标签由参数决定，通用驱动只走得到枚举的第一个
    "AtomTrackQuickCompStart": {"drift": {"compensation_type": 1}},
    "AtomTrackStatusGet": {"controller": {"control": 1}, "drift": {"control": 2}},
    # `signal_index` 缺省 -1 = 保持现有 ⇒ 不发 `Osci1T_ChSet`。给一个正的才走那一支。
    "AcquireOsciTrace": {"with_channel": {"signal_index": 4}, "wait_trigger": {"data_to_get": 2}},
    "ConfigureSpectrumAnalyzer": {"dc_coupled": {"ac_coupling": False}},
    # 下界 ≥ 上界 ⇒ 拒绝，**一次调用都不发**
    "SetSpectrumAnalyzerBand": {
        "inverted": {"f_low_hz": 1000.0, "f_high_hz": 1.0},
        "equal": {"f_low_hz": 50.0, "f_high_hz": 50.0},
    },
    # 颠倒的限值**换过来**而不是拒绝 —— 与频带那条刻意不同
    "RunBiasSweep": {"swapped": {"lower_limit_v": 1.0, "upper_limit_v": -1.0}},
    "BiasPulse": {"relative": {"absolute": False}},
    # ── 脚本白名单：四种拒绝，每一种说的是不同的话 ──
    "RunNanonisScript": {"unvetted_slot": {"slot": 7}},
    "DeployNanonisScript": {"unvetted_slot": {"slot": 7}},
    "LoadScriptLUT": {
        "unvetted_slot": {"slot": 7},
        # 槽位 5 在白名单上，但**没批准写 LUT** —— 与「槽位没过审」是两句话
        "lut_write_not_allowed": {"slot": 5},
        # 声明的范围是 [0, 10]（用户审脚本时写定的，因为只有他知道单位）
        "lut_out_of_range": {"values": "0, 5, 42"},
        "lut_unparsable": {"values": "0, 一点五"},
        "lut_empty": {"values": "   "},
    },
    # **反的那道闸**：往已审槽位里装别的脚本，会把那份批准变成一句假话
    "LoadNanonisScript": {"vetted_slot": {"slot": 3}},
    "SetScriptChannels": {"bad_channels": {"channels": "0, 二十四"}, "empty_channels": {"channels": " "}},
    # 限值**不启用**时写下去什么也不做 —— 那一支要单独录
    "SetZLimits": {"not_enabled": {"enable": False}},
    "SetPiezoLimits": {"inverted_y": {"y_low_v": 150.0, "y_high_v": -150.0}},
    # ── 批 3g ──
    # 反过来的一对界：**环会立刻把输出推到轨上**，所以这三处是拒，不是换过来
    "ConfigurePiController": {"inverted_limits": {"output_lower_limit": 1.0, "output_upper_limit": -1.0}},
    "ConfigureKelvinController": {
        "inverted_limits": {"bias_low_limit_v": 2.0, "bias_high_limit_v": -2.0},
        # 五个可选的整定项：给了才写 —— 一个都不给时那四条 Set 照样发（各有缺省）
        "tuned": {"p_gain": 3.0, "time_constant_s": 0.02, "setpoint": 0.15,
                  "modulation_frequency_hz": 973.0, "modulation_amplitude": 0.05},
    },
    "RunRfFrequencySweep": {
        "inverted_limits": {"lower_hz": 2.0e9, "upper_hz": 1.0e9},
        # auto_off=False ⇒ 扫完输出**保持开着**，那句话必须出现在 summary 里
        "stay_on": {"auto_off": False},
        "downward": {"direction": "down"},
    },
    "ConfigureHighSpeedSweep": {
        "bad_channels": {"acquire_channels": "spec-export"},
        "empty_channels": {"acquire_channels": "  "},
        # num_sweeps=0 ⇒ 无限标志位翻起来（`HSSwp_NumSweepsSet(max(n,1), n==0)`）
        "infinite": {"num_sweeps": 0},
        "z_off": {"z_controller_off": True},
    },
    # 三项各写各的，一个都不给就拒
    "ConfigurePreamp": {
        "coupling_only": {"gain": None, "coupling": 1},
        "all_three": {"gain": 2, "coupling": 1, "input_mode": 0},
        "none_given": {"gain": None},
    },
    # 三条轴各一条字面动词，第四种是拒
    "ConfigureBeamDeflection": {
        "horizontal": {"axis": "horizontal"},
        "sum": {"axis": "sum"},
        "bad_axis": {"axis": "diagonal"},
    },
    # 三种触发模式发的是三串不同的动词
    "ConfigureHighResScope": {
        "level_trigger": {"trigger_mode": "level", "trigger_level": 5e-11,
                          "trigger_slope": "falling"},
        "digital_trigger": {"trigger_mode": "digital", "trigger_slope": "falling"},
    },
    # PSD 那一读失败**不许把已经拿到的曲线扔掉**
    "GetHighResScopeData": {"with_psd": {"include_psd": True}},
    "GetPllSignalAnalyzerData": {"rearmed": {"rearm": True}},
    "SetKelvinControllerOnOff": {"no_modulation": {"modulation_on": False}},
    "SetInterferometerOnOff": {"with_reset": {"reset": True}},
    "ConfigureInterferometer": {"nulled": {"null_deflection": True}},
    "ConfigureTipRecorder": {"cleared": {"clear": True}},
    "GetDualScopeData": {"no_run": {"run_first": False}},
    "RunHighResScope": {"no_rearm": {"rearm": False}},
    "RunHighSpeedSweep": {"background": {"wait": False}},
    # 给了一半就要把另一半**读回来保住** —— 省掉的 I 增益被清零就是一个死环
    "SetProbeZController": {
        "p_only": {"p_gain": 5.0},
        "setpoint_only": {"setpoint": 2e-10},
    },
    "ConfigureProbeScanner": {
        "x_only": {"factor_x": 1.05},
        "speed_only": {"speed": 1e-7},
    },
    "PulseProbeBias": {"relative_no_hold": {"relative": True, "hold_z": False}},
    # ── 批 3h ──────────────────────────────────────────────────────────────
    # 用户输出的安全包络**由仪器给**，不是本仓编的：越界拒、贴着上界放行
    "SetUserOutput": {
        "out_of_range": {"value": 1.0},
        "at_upper_edge": {"value": 0.5},
    },
    "PulseDigitalLine": {
        "bad_lines": {"lines": "spec-export"},
        "line_out_of_range": {"lines": "1,9"},
    },
    "SetPatternCloud": {
        # **合法 JSON 还不够**：`"5"` 解出来是整数 5，旧仓那一版随后 len() 抛
        # TypeError ⇒ 到不了 SkillResult，是一次死掉的回合。而模型少写一对方括号
        # 正是最可能的那个错。
        "json_not_a_list": {"x_coords": "5", "y_coords": "5"},
        "length_mismatch": {"x_coords": "[1e-9, 2e-9]", "y_coords": "[3e-9]"},
        "bad_json": {"x_coords": "不是 JSON", "y_coords": "[]"},
    },
    "ConfigureWaveform": {
        # 2 通道那支收的是**周期**不是频率 —— 这一格钉的就是那次换算
        "two_channel": {"generator": "2ch", "channel": 1, "shape": "square"},
        "bad_generator": {"generator": "3ch"},
        "bad_shape": {"generator": "2ch", "shape": "noise"},
    },
    "StartWaveform": {"two_channel": {"generator": "2ch"}, "burst": {"periods": 5}},
    "StopWaveform": {"two_channel": {"generator": "2ch"}},
    "GetWaveformStatus": {"two_channel": {"generator": "2ch"}},
    "SetWaveformIdleValue": {"two_channel": {"generator": "2ch"}},
    "GetSpectroscopyStatus": {"bias_only": {"which": "bias"}, "z_only": {"which": "z"}},
    "SetSpectroscopyTtlSync": {
        "z_side": {"which": "z"},
        # line = 0 是「关掉同步」，报文因此换一句话
        "disable": {"line": 0},
    },
    "SetSpectroscopyPulseSync": {
        "nothing_given": {"digital_sync": None},
        "pulse_sequence": {"digital_sync": None, "pulse_sequence_nr": 2, "pulse_periods": 3},
        "both": {"digital_sync": 1, "pulse_sequence_nr": 2},
    },
    "SetMultiPass": {"off": {"on": False}},
    "PausePatternExperiment": {"resume": {"pause": False}},
    "SetSpectroscopyZControl": {"alternate_off": {"use_alternate_setpoint": False}},
    "SetZSpectroscopySecondRetract": {"disable": {"enable": False}},
    "SetMlsLockinPerSegment": {"disable": {"enable": False}},
    # 批 3k：温度的分支全由**参数**决定（这个技能一次 Nanonis 调用都不发），
    # 所以通用注错点一条都碰不到它们 —— 六种「没有值」里有三种只在这里露面。
    "GetTemperature": {
        # 子串档：配置里写 `Magnet`，监控里那个通道叫 `Magnet (COM3)`
        "by_channel": {"channel": "Magnet"},
        # 大小写档
        "casefold_channel": {"channel": "spm (com3)"},
        # 唯一子串对上两个 ⇒ 说清楚是哪个，而不是悄悄挑一个
        "ambiguous_channel": {"channel": "COM3"},
        "unknown_channel": {"channel": "LN2"},
        # 指名一个**占位**通道：这是 `no_sensor`，不是 `unavailable`
        "placeholder_channel": {"channel": "Cryostat"},
        # 陈旧判定是 explicit-only：不传就没有 freshness 字段
        "fresh": {"max_age_s": 600.0},
        "stale": {"max_age_s": 5.0},
        # `0` 是**合法阈值**（声明里 min_value=0.0），意思是「一切都算旧」。
        # 用真假判它会把最严的那一档读成「没给」⇒ 静静地退化成不判（D-ZERO-1）。
        "zero_max_age": {"max_age_s": 0.0},
        # 阈值是个字符串 ⇒ `float()` 抛 ⇒ `freshness="unknown"` 且**不写** max_age_s
        "bad_max_age": {"max_age_s": "很旧"},
    },
    # ── 批 3j ──────────────────────────────────────────────────────────────
    # 四条**字面动词**分支，各发一串不同的调用；第五种是拒绝。
    # 通用驱动只走得到 channel 的声明缺省（"current"）。
    "CaptureSignalBuffer": {
        "z": {"channel": "z"},
        "bias": {"channel": "bias"},
        # 数字索引走通用路径（`Signals_ValGet`），单位是空串
        "signal_index": {"channel": "7"},
        "bad_channel": {"channel": "nope"},
        # 摘要模式：不带样本表，只回统计量
        "summary_only": {"include_samples": False},
    },
    "BiasPulseWithReadback": {"relative": {"absolute": False}},
    # 偏压缺省那一路（`bias_src="read"`）由 ok 那一趟覆盖；这两格走另外三条分支
    "TipShapeWithReadback": {
        "explicit_bias": {"bias_v": 1.0},
        "change_bias_on": {"change_bias": True, "bias_lift_v": 3.0},
        # 显式给第二段高度 ⇒ 不再等于 −tip_lift_m；顺带关掉反馈恢复
        "explicit_lift": {"lift_height_m": 5e-9, "restore_feedback": False},
    },
    # ── 批 7a-2 ────────────────────────────────────────────────────────
    # 合成的 `FolMe_XYPosGet` 回的是 0.25 / 0.5 **米** ⇒ 量级判据一律拒
    # （`abs(x) < 1e-3`），于是 `ok` 那一趟录到的是「读不到针尖位置」。
    # 显式给起点就绕开那一步，后面整条选点几何才走得到 —— 而那正是这个技能。
    "FindCleanSpot": {
        "from_origin": {"from_x_m": 0.0, "from_y_m": 0.0, "count": 4},
        # 扎针那一档半径小（30 nm）、而且**要减帧边距**（落点上要扫一张簇图），
        # 与上一格的脉冲档走的是两条不同的 reach。
        "tip_shape_off_centre": {"from_x_m": 3.0e-7, "from_y_m": -1.0e-7,
                                 "purpose": "tip_shape", "count": 3},
        # 已用点：`exclude_spots` 的解析 + 「差一点点就撞上」那条 `< 2·r` 判据。
        "exclude_used": {"from_x_m": 0.0, "from_y_m": 0.0,
                         "exclude_spots": "0,0;4e-7,0", "count": 4},
    },
}


def _params_for(name: str, meta: Any) -> dict:
    out = {}
    for spec in getattr(meta, "parameters", None) or []:
        if getattr(spec, "required", True):
            out[spec.name] = _param_value(spec)
    out.update(PARAM_OVERRIDES.get(name, {}))
    return out


#: 一个技能最多注几次错。轮询技能的动词种类也可能很多，而超过这个数之后
#: 每多一条的边际信息接近零。
MAX_ERROR_POINTS = 12

#: 一趟最多让技能发多少次调用。
#:
#: 2026-09-11 踩到：`WaitScanComplete` 的 `timeout_ms` 缺省是 **-1 = 无限**，
#: 于是导出脚本在它身上转了二十分钟没出来。假钟能让「时间」过去，
#: 但过不完一个无限的预算。
#:
#: 超了就当场停并把它录成一条 `raised` —— **「这个技能在这套脚本下会一直转」
#: 本身就是一条判据**，比一个挂住的导出有用。
MAX_CALLS = 4000


class _CallBudgetExceeded(RuntimeError):
    pass

#: 类型码 → 一个形状对的值。**逐位不同**是关键：
#:
#: 第一版所有 float 都给 0.25，于是 `GetScanFrame` 那种「5 个 float 进 5 个字段」
#: 的技能，轨迹里根本看不出 body 的第几位对应哪个字段 —— 而移植时要照着写的
#: 正是这个映射。逐位递增之后，`{center_x_m: 0.25, center_y_m: 0.5, …}` 一眼可读，
#: 抄错顺序会当场变红。
def _synth_one(t: str, i: int) -> Any:
    if t in ("f", "d"):
        return round(0.25 * (i + 1), 6)
    if t in ("i", "I", "H", "h"):
        return 3 + i
    if t == "c":
        return 65 + i
    if t == "*c":
        return f"SYNTH{i}"
    if t == "*+c":
        return [f"Sig{i}A", f"Sig{i}B"]
    if t in ("*i",):
        return [1 + i, 2 + i]
    if t in ("*f", "*d"):
        return [round(0.5 + i, 6), round(0.75 + i, 6)]
    if t == "2f":
        # ⚠️ **ndarray，不是嵌套 list。** 真机上 `nanonis_spm` 把 `2f` 解成
        # `np.ndarray`，而旧仓的 `parse_frame_grab` 正是靠 `isinstance(el, np.ndarray)`
        # 从异构 body 里认出那一帧的。给一份嵌套 list 的话，旧仓自己的解析器**看不见
        # 这一帧**，于是每一条 `Scan_FrameDataGrab` 轨迹录下的都是「不可测」——
        # 一个真机上不成立的形状。
        #
        # 2026-09-11 移植时发现：TS 那侧的线协议解出来就是 `number[][]`，认得出帧，
        # 于是 `WaitScanComplete` 的调用序列对不上（15 次 vs 25 次）。第一反应是改
        # TS 的判据去迁就，那等于把一个夹具瑕疵固化成规格。
        import numpy as _np
        return _np.array([[0.1 + i, 0.2 + i], [0.3 + i, 0.4 + i]], dtype=float)
    return round(0.25 * (i + 1), 6)


def _synth_body(verb: str, table: dict) -> list:
    """按协议表的 `returns` 合成一个 body。表里没有这个动词就给一个单元素表。"""
    meta = table.get(verb)
    if meta is None:
        return [0.25]
    rets = meta.get("returns") or []
    out = [_synth_one(t, i) for i, t in enumerate(rets)]
    return out or [0.25]


#: **按技能**覆写某几个动词的 body。与 `CUSTOM_ERRORS` 同一条理由：
#: 通用合成器的恒定回包会让某条判据退化成掷骰子，而那时它需要的是一个**单独的开关**。
#:
#: ⚠️ 目前只有一条。`TiltProbeCircle` 在恒定回包上是**退化**的：一圈 Z 全相等 ⇒
#: 正弦拟合的 A、B 只剩 `1e−17` 量级的舍入噪声，而
#: `downhill_deg = atan2(−B, −A) % 360` 于是是一次掷骰子 ——
#: 同一份输入在两台机器上给 0° / 90° / 254° / 316°（实测）。
#: 那不是判据，是两边 ulp 分布的差。
#:
#: 覆写把 Z **跟着针尖的 XY 走**（`echo` 里存着上一次 `FolMe_XYPosSet` 的实参），
#: 也就是给它一个真实的斜面。这不是「为了让测试过」而放松，是把夹具修对：
#: 恒流下 Z 跟随表面，正是这个技能成立的前提。
CUSTOM_BODIES: "dict[str, dict[str, Any]]" = {
    "TiltProbeCircle": {
        # 5 mrad / −2 mrad 的斜面 + 一个 1 nm 的基座。闭式，零随机数。
        "ZCtrl_ZPosGet": lambda xy: [1.0e-9 + 5.0e-3 * xy[0] - 2.0e-3 * xy[1]],
    },
}


class _FakeContext:
    """按真机形状应答的假 context。

    回包信封是 ``(error_string, raw_bytes, body)`` —— 三段。技能里所有
    `reply_scalar` / `parsed[2][0]` 都按这个形状读。
    """

    def __init__(self, table: dict, *, error_at: int | None = None,
                 empty_at: int | None = None, run_error_at: int | None = None,
                 no_echo: bool = False, skill_name: str = "",
                 error_text: str = "模拟故障：连接被对端关闭"):
        self.table = table
        self.skill_name = skill_name
        self.bodies = CUSTOM_BODIES.get(skill_name, {})
        # **写进去什么、读回来就是什么** —— 真仪器就是这样，而常量回包会让每一个
        # 「写后回读」技能都走进「不一致」分支。键是去掉尾部 Set/Get 的动词名，
        # 于是 `ZCtrl_SetpntSet` 的实参成为 `ZCtrl_SetpntGet` 的 body。
        self.echo: dict[str, list] = {}
        self.error_at = error_at
        self.error_text = error_text
        self.empty_at = empty_at
        self.run_error_at = run_error_at
        self.no_echo = no_echo
        self.calls: list[dict] = []
        self.runs: list[dict] = []
        self.state = None

    def safe_call(self, method_name: str, *args, **kwargs) -> NanonisCallRecord:
        i = len(self.calls)
        if i >= MAX_CALLS:
            raise _CallBudgetExceeded(
                f"超过 {MAX_CALLS} 次调用仍未收敛（最后一个动词 {method_name}）"
            )
        rec = NanonisCallRecord(method=method_name, args=tuple(args), kwargs=dict(kwargs))
        if i == self.error_at:
            rec.error = self.error_text
            rec.return_value = None
        elif i == self.empty_at:
            rec.return_value = ("", b"", [])
        elif method_name in self.bodies:
            xy = self.echo.get("FolMe_XYPos") or [0.0, 0.0]
            rec.return_value = ("", b"", self.bodies[method_name](
                [float(xy[0]), float(xy[1] if len(xy) > 1 else 0.0)]))
        else:
            base = method_name[:-3] if method_name.endswith("Set") else (
                method_name[:-3] if method_name.endswith("Get") else None)
            if method_name.endswith("Set") and base is not None:
                self.echo[base] = [_jsonable(a) for a in args]
                rec.return_value = ("", b"", _synth_body(method_name, self.table))
            elif method_name.endswith("Get") and base in self.echo and not self.no_echo:
                rec.return_value = ("", b"", list(self.echo[base]))
            else:
                rec.return_value = ("", b"", _synth_body(method_name, self.table))
        self.calls.append({
            "verb": method_name,
            "args": [_jsonable(a) for a in args],
            "kwargs": {k: _jsonable(v) for k, v in kwargs.items()},
            "error": rec.error,
        })
        return rec

    def check_abort(self) -> bool:
        """没有中止。**真 context 有这个方法，假的也得有。**

        旧仓有的技能是 ``getattr(context, "check_abort", None)`` 探着调，有的
        （``WaitForScanEndBlocking``）直接调。缺了它，后者在导出时抛
        ``AttributeError`` —— 而那是夹具的毛病，不是技能的判据。
        """
        return False

    def run(self, skill_name: str, params: dict, version: str | None = None) -> SkillResult:
        i = len(self.runs)
        self.runs.append({"skill": skill_name, "params": {k: _jsonable(v) for k, v in params.items()}})
        if i == self.run_error_at:
            return SkillResult(skill_name=skill_name, success=False, error="模拟故障：子技能失败")
        return SkillResult(skill_name=skill_name, success=True, data={}, summary=f"{skill_name}: ok")


#: 隔离用的临时项目根。它每次跑都换名字，而技能会把落盘路径写进 `data` ——
#: 于是「重跑逐字节相同」会因为一个**与判据无关**的随机目录名而失效。
#: 抹成占位符，而不是把项目根钉死：钉死等于让两次导出共用状态，那才是真的会
#: 污染金样的东西。（2026-09-11：`2f` 合成改成 ndarray 之后 `GrabScanFrameData`
#: 第一次真的写出了 `.npy`，这条才暴露出来。）
_PROJECT_ROOT = os.environ["MAST2_PROJECT_ROOT"]


#: 抓帧的文件名里嵌了**毫秒钟**（`frame_ch0_dir1_<hex>.npy`）。它和临时项目根一样
#: 与判据无关，但比项目根更隐蔽：抹掉根之后金样看起来是可复现的，其实每跑一次那八位
#: 十六进制都在变。抹成 `<stamp>` 而不是整条路径丢掉 —— 留下来的**目录、命名模板、
#: 后缀**都是判据（尤其是 `_dir{D}_` 那一段：它是「取第一个空名」那道防覆盖的前提）。
_STAMP = re.compile(r"(frame_ch\d+_dir\d+_)[0-9a-f]+(?=(?:_\d\d)?\.npy)")


#: 读回曲线的文件名里嵌了 **UTC 时刻 + 8 位随机**
#: （`BiasPulseWithReadback_20260916T131900Z_a1b2c3d4.json`）。与抓帧那条同理：
#: 抹掉可变的两段，**留下命名模板** —— 技能名、`.json` 后缀，以及「取第一个空名」
#: 留下的 `_NN`，三样都是判据。
_TRACE_STAMP = re.compile(
    r"([A-Za-z0-9_]{1,40})_\d{8}T\d{6}Z_[0-9a-f]{8}(?=(?:_\d\d)?\.json)")


def _scrub(s: str) -> str:
    s = s.replace(_PROJECT_ROOT, "<project-root>").replace(
        _PROJECT_ROOT.replace("\\", "/"), "<project-root>")
    s = _STAMP.sub(lambda m: m.group(1) + "<stamp>", s)
    return _TRACE_STAMP.sub(lambda m: m.group(1) + "_<stamp>", s)


def _jsonable(v: Any) -> Any:
    if isinstance(v, str):
        return _scrub(v)
    if isinstance(v, (int, float, bool)) or v is None:
        return v
    if type(v).__name__ == "ndarray":
        return _jsonable(v.tolist())
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    return str(v)


def _result(r: Any) -> dict:
    """SkillResult 里**判据落得到的部分**。时间戳与耗时刻意不录（每跑一次都变）。"""
    return {
        "success": bool(getattr(r, "success", False)),
        "error": _scrub(str(getattr(r, "error", "") or "")),
        "summary": _scrub(str(getattr(r, "summary", "") or "")),
        "data": _jsonable(getattr(r, "data", None) or {}),
    }


#: 每条轨迹跑之前要摆好的**进程级状态**。
#:
#: 参数组存储是模块级的，于是 `CreateZCtrlPreset` 那一格建的 `spec-export`
#: 会一直活到 `ApplyZCtrlPreset` 那一格 —— 后者因此「成功」了，而它成功的原因
#: **不在它自己的轨迹里**。这是同一个「轨迹之间串状态」的坑在本仓工具里的第四次
#: （前三次都是组合技能的断点）。
#:
#: 与其靠批次顺序，不如把前置**写出来**：这一格要什么，这里就摆什么。
#: 金样于是自带它的前提，TS 那侧照着摆就能复现。
PRESET_FIXTURE = {"name": "spec-export", "p_gain": "150p", "i_gain": "150p"}
NEEDS_PRESET = {"ApplyZCtrlPreset", "ListZCtrlPresets"}

#: 已审脚本槽位的白名单夹具。**空清单是出厂状态**（fail-closed，智能体一个脚本都跑不了），
#: 于是不摆这一份的话，脚本那 14 个技能录到的全是同一句拒绝 —— 下发那一路一条金样都没有。
#:
#: 两条刻意不同：槽位 3 允许写 LUT 且声明了范围 `[0, 10]`，槽位 5 不允许。
#: 「白名单认的是**这个槽位里的那个脚本**」这条判据只有在两者并存时才看得出来。
SCRIPT_ALLOWLIST = {
    "allowed_slots": [
        {"slot": 3, "name": "延时扫描", "description": "泵浦-探测延时扫描",
         "allow_lut_write": True, "lut_min": 0.0, "lut_max": 10.0,
         "notes": "LUT 单位 mm"},
        {"slot": 5, "name": "针尖成形序列", "description": "固定脉冲串",
         "allow_lut_write": False},
    ]
}
NEEDS_SCRIPTS = {
    "ListNanonisScripts", "RunNanonisScript", "DeployNanonisScript",
    "LoadScriptLUT", "LoadNanonisScript",
}

# ── 批 3k：环境读的进程级夹具 ────────────────────────────────────────────────
#
# 真空互锁的压强源与签署、温度的读数源与通道清单，都是**进程级注入口**
# （`set_pressure_source` / `attest` / `set_source` / `set_channels_source`）。
# 不摆这一份的话，两个技能录到的全是「一个源都没接」那一格 ——
# 那一格当然也要有，但只有它的话，金样重放的是「空进程」而不是「这台机器」。
#
# 时间全钉在假墙钟 `1_700_000_000.0` 上（= 2023-11-14T22:13:20Z）。
# 温度那边**不能**靠 `time.time()`：`core.temperature.age_s` 走的是
# `datetime.now()`，而那个不在时间桩的射程里 —— 所以这里注入的源自己带 `now`。
_FAKE_NOW_S = 1_700_000_000.0
_FAKE_NOW_ISO = "2023-11-14T22:13:20+00:00"

#: 一只**真的** DL-7，读数 1e-3 Pa（远低于 1e-2 Pa 上限）、12 秒前。
#: 于是 `ok` 那一格录的是「靠规放行」，而不是「读不到所以拒」。
VACUUM_SAMPLE = {
    "value": 1.0e-3, "unit": "Pa", "status": "ok",
    "timestamp": "2023-11-14T22:13:08+00:00",   # = _FAKE_NOW_S - 12
    "sensor_name": "Chamber", "sensor_class": "DL7VacuumSensor",
}

#: 同时还挂着一份**活的**签署。规已经放行了，签署因此不参与裁决
#: （`attested=false`），但技能照样把它报出来 —— 这一对组合钉的正是
#: 「裁决没用上它」与「用户看不见它」是两件事。
VACUUM_ATTESTATION = {
    "reason": "vented_to_atmosphere", "signed_by": "操作员甲",
    "ttl_s": 6 * 3600.0, "note": "腔体已通大气",
}
#: 批 5c：粗动那两条也要一只放行的规 —— 否则它们停在**真空**那道闸上，
#: 而那道闸 `GetChamberPressure` 已经录过了。让它们走到下一道（驱动读回）。
NEEDS_VACUUM = {"GetChamberPressure", "RelocateCoarseXY", "StepCoarseXY"}

# ── 批 5c：仪器档案夹具 ──────────────────────────────────────────────────
#
#: 一台**填过**的机器。三件事靠它才录得到：
#:   * `z_extend_sign = '-1'` —— 声明过 ⇒ 方向自检有判据（没声明会落在 `no_sign`，
#:     那一支由 `export_instrument_profile.py` 单独录）；
#:   * `retract_total_steps = 111` ⇒ 梯子正好是 `1 → 10 → 100`，三级，金样读得完；
#:   * 三块标定各占一个**年龄分支**（天 / 小时 / 分钟），而 `_age_note` 的三种措辞
#:     正是 `ReadCalibrations` 要说的话。
#:
#: ⚠️ `tilt_cal_updated_at` 那一条会被 `time.strftime(localtime(ts))` 渲染成
#: **本地时区**的一串字符。两侧（导出器与 TS 测试）跑在同一台机器上，所以它对得上；
#: 换时区跑 CI 会红 —— 那是**如实的**红，见交接 §6。
PROFILE_FIXTURE = {
    "retract_motor_dir": "z-",
    "z_extend_sign": "-1",
    "z_recede_min_nm": 1.0,
    "z_settle_timeout_s": 5.0,
    "retract_total_steps": 111,
    "retract_step_max": 100,
    "xy_prewithdraw_steps": 11,
    "xy_move_chunk_steps": 10,
    "lockin_signal_index": 86,
    "preamp_full_scale_a": 1e-8,
    # 标定三块（`ReadCalibrations` 的三条路都走 `available=True`）
    "tilt_cal_g11": -1.02, "tilt_cal_g12": 0.07,
    "tilt_cal_g21": 0.03, "tilt_cal_g22": -0.98,
    "tilt_cal_cond": 1.1128,
    "tilt_cal_updated_at": 1_699_000_000.0,      # 11.6 天前 → 天分支 + 换样品那句
    "didv_at_contact_v": 2.5e-3,
    "didv_cal_bias_v": 0.05,
    "didv_cal_setpoint_a": 1e-10,
    "didv_cal_mod_amp_v": 0.02,
    "didv_cal_updated_at": 1_699_996_400.0,      # 3600 s → 小时分支
    "qplus_f0_measured_hz": 32768.0,
    "qplus_q_measured": 24000.0,
    "qplus_fq_updated_at": 1_699_999_400.0,      # 600 s → 分钟分支
}
NEEDS_PROFILE = {
    "ReadCalibrations", "RetractForSampleChange",
    "RelocateCoarseXY", "StepCoarseXY",
}

#: 三个温度通道，刻意各占一种形状：
#:   * `SPM (COM3)`    —— 真驱动、`ok`、12 秒前 ⇒ 不指名时**样品台优先**选中它；
#:   * `Magnet (COM3)` —— 真驱动、`warning`（**算读到了**，降温途中必然长期在警带里）；
#:   * `Cryostat`      —— 占位实现、`unavailable` ⇒ `real is False` ⇒ `no_sensor`。
#: 前两个名字都含 `COM3`，于是 `channel="COM3"` 那一格能录到 `ambiguous_channel`。
TEMP_CHANNELS = [
    {"name": "SPM (COM3)", "value": 77.35, "unit": "K", "status": "ok",
     "timestamp": "2023-11-14T22:13:08+00:00",   # 12 s
     "driver": "LakeshoreTemperatureSensor", "real": True},
    {"name": "Magnet (COM3)", "value": 4.21, "unit": "K", "status": "warning",
     "timestamp": "2023-11-14T22:12:20+00:00",   # 60 s
     "driver": "LakeshoreTemperatureSensor", "real": True},
    {"name": "Cryostat", "value": 0.0, "unit": "", "status": "unavailable",
     "timestamp": "", "driver": "PlaceholderSensor", "real": False},
]
NEEDS_TEMPERATURE = {"GetTemperature"}


def _reset_state(name: str) -> None:
    """把进程级状态摆成这一格要的样子。**每条轨迹都调**，不靠上一格的残留。"""
    try:
        import mast.core.zctrl_presets as _zp
        _zp._presets.clear()
        if name in NEEDS_PRESET:
            _zp.upsert_preset(dict(PRESET_FIXTURE))
    except Exception:  # noqa: BLE001
        pass
    # 脚本白名单住在磁盘上（`<project_root>/config/nanonis_scripts.json`），
    # 而**不是**进程里 —— 它由操作员维护，MAST 没有任何 skill 写它。
    # 这里写文件而不是打补丁，走的正是那条真路径（包括「文件不存在 = 空清单」）。
    try:
        cfg = Path(os.environ["MAST2_PROJECT_ROOT"]) / "config" / _CONFIG_NAME
        cfg.parent.mkdir(parents=True, exist_ok=True)
        if name in NEEDS_SCRIPTS:
            cfg.write_text(json.dumps(SCRIPT_ALLOWLIST, ensure_ascii=False),
                           encoding="utf-8")
        elif cfg.exists():
            cfg.unlink()
    except Exception:  # noqa: BLE001
        pass
    # 批 3k：真空互锁。**先全清再按需摆** —— 签署是进程级的，
    # 漏清一次就会让后面某一格「因为上一格签过字」而放行。
    try:
        import mast.core.vacuum_interlock as _vac
        _vac.set_pressure_source(None)
        _vac.revoke_attestation()
        if name in NEEDS_VACUUM:
            _vac.set_pressure_source(
                lambda: _vac.PressureSample(**VACUUM_SAMPLE))
            _vac.attest(VACUUM_ATTESTATION["reason"],
                        signed_by=VACUUM_ATTESTATION["signed_by"],
                        ttl_s=VACUUM_ATTESTATION["ttl_s"],
                        note=VACUUM_ATTESTATION["note"])
    except Exception:  # noqa: BLE001
        pass
    # 批 5c：仪器档案与粗动驱动声明。**先全清再按需摆** —— 两个都是进程级的，
    # 漏清一次就会让后面某一格「因为上一格填过档案」而走到另一支。
    try:
        import mast.core.instrument_profile as _ip
        _ip.set_profile({})
        if name in NEEDS_PROFILE:
            _ip.set_profile(dict(PROFILE_FIXTURE))
    except Exception:  # noqa: BLE001
        pass
    try:
        # 粗动驱动声明**一格都不摆**：没声明就拒绝一切，而那正是这一批要录的那道闸。
        # 声明装上之后的分支在 `export_coarse_drive.py`。
        import mast.core.coarse_drive as _cd
        _cd.set_declaration({})
    except Exception:  # noqa: BLE001
        pass
    # 批 7a-2：撞针记忆是**进程级**的，而 `FindCleanSpot` 把它当成第二个避让来源。
    # 漏清一次，它就会「因为上一格撞过针」而躲开一个本来干净的点 ——
    # 而那种绿看起来和「它真的躲开了一个坑」一模一样。
    # （地图那一路不用清：这个进程里没有活动实验，`get_active_log()` 恒为 None。）
    try:
        import mast.core.tip_crash_tracker as _tct
        _tct.reset_tip_crash_tracker()
    except Exception:  # noqa: BLE001
        pass
    # 批 3k：温度。源自己带 `now`（见 `_FAKE_NOW_ISO` 那段注释）。
    try:
        import datetime as _dt
        import mast.core.temperature as _temp
        _temp.set_source(None)
        _temp.set_channels_source(None)
        if name in NEEDS_TEMPERATURE:
            chans = [_temp.TempChannel(**c) for c in TEMP_CHANNELS]
            now = _dt.datetime.fromisoformat(_FAKE_NOW_ISO)
            _temp.set_channels_source(lambda: list(chans))
            _temp.set_source(
                lambda ch: _temp.read_temperature(chans, channel=ch, now=now))
    except Exception:  # noqa: BLE001
        pass


def _trace(skill: Any, params: dict, table: dict, *, _name: str = "", **kw) -> dict:
    _reset_state(_name)
    # ⚠️ 每条轨迹**从零开始**。组合技能（`WaitScanComplete` / `SetBiasRamp`）会往
    # `experiments/composite_progress/` 落断点，而假 context 没有 `run_id`，于是所有
    # 轨迹共用同一个文件——上一条留下的进度会被下一条捡起来**续跑**。
    #
    # 不清的代价是看得见的：`SetBiasRamp/empty@0` 本该发 5 次 `Bias_Set`，实际只发了
    # **1 次**——前 4 步是从上一条轨迹的断点里「已完成」的。一条录着「跳过了 4 步硬件
    # 动作」的金样，比没有这条金样更坏。
    #
    # 这是同一个坑在本仓工具里的**第三次**（另两次：`export_graph_executor.py`、
    # `export_scan_wait.py`）。它也正是断点键里该有 run_id 的那条理由。
    try:
        from mast.skills.composite.graph_executor import _sidecar_dir
        for f in _sidecar_dir().glob("*"):
            f.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass
    ctx = _FakeContext(table, skill_name=_name, **kw)
    try:
        r = skill.execute(ctx, dict(params))
        out = _result(r)
    except Exception as exc:  # noqa: BLE001 —— 抛出来本身就是一条判据
        out = {"raised": f"{type(exc).__name__}: {exc}"}
    out["calls"] = ctx.calls
    if ctx.runs:
        out["runs"] = ctx.runs
    return out


def main() -> int:
    table = json.loads(NANONIS.read_text(encoding="utf-8"))["methods"]
    reg = SkillRegistry()
    reg.discover()
    # `snapshot_names()` 是 `{name: {version: cls}}`——取每个名字的最新版本
    by_name = {n: list(v.values())[-1] for n, v in reg.snapshot_names().items()}

    out: dict[str, Any] = {}
    missing: list[str] = []
    for name in (BATCH_1 + BATCH_2 + BATCH_2B + BATCH_3A + BATCH_3B + BATCH_3C
                 + BATCH_3D + BATCH_3E + BATCH_3F
                 + BATCH_3G + BATCH_3H + BATCH_3I
                 + BATCH_3J + BATCH_3K
                 + BATCH_3L
                 # ↑ 3l ／ ↓ 4a
                 + BATCH_4A
                 # ↑ ／ ↓ 4B
                 + BATCH_4B
                 # ↑ ／ ↓ 4C
                 + BATCH_4C
                 # ↑ ／ ↓ 4D
                 + BATCH_4D
                 # ↑ ／ ↓ 5A
                 + BATCH_5A
                 # ↑ ／ ↓ 5B
                 + BATCH_5B
                 # ↑ ／ ↓ 5C
                 + BATCH_5C
                 # ↑ ／ ↓ 6A
                 + BATCH_6A
                 # ↑ ／ ↓ 6B
                 + BATCH_6B
                 # ↑ ／ ↓ 6C
                 + BATCH_6C
                 # ↑ ／ ↓ 7A-1
                 + BATCH_7A_1
                 # ↑ ／ ↓ 7A-2
                 + BATCH_7A_2
                 # ↑ ／ ↓ 7A-3
                 + BATCH_7A_3
                 # ↑ ／ ↓ 7B-1
                 + BATCH_7B_1
                 # ↑ ／ ↓ 7B-2
                 + BATCH_7B_2
                 # ↑ ／ ↓ 7B-3
                 + BATCH_7B_3):
        if name in TRACE_SKIP:
            continue
        cls = by_name.get(name)
        if cls is None:
            missing.append(name)
            continue
        skill = cls()
        params = _params_for(name, SkillRegistry._get_metadata_raw(cls))

        print(f"  … {name}", file=sys.stderr, flush=True)
        traces: dict[str, Any] = {"ok": _trace(skill, params, table, _name=name)}
        # **注错点从成功那一趟派生**，取每个动词的**首次与末次**出现：
        #
        # 只取首次是不够的 —— `SetSetpoint` 的序列是
        # `SetpntGet → SetpntSet → SetpntGet`，前置读和回读是同一个动词，
        # 于是「**回读失败**」那条分支一条轨迹都没有。而回读正是这类技能的要害。
        #
        # 也不能逐序号取：轮询技能一趟几千次调用，那是组合爆炸，
        # 而第 2000 次和第 1 次走的是同一条分支。首次 + 末次刚好夹住两端。
        first: dict[str, int] = {}
        last: dict[str, int] = {}
        for i, c in enumerate(traces["ok"]["calls"]):
            first.setdefault(c["verb"], i)
            last[c["verb"]] = i
        points = sorted(set(first.values()) | set(last.values()))
        for i in points[:MAX_ERROR_POINTS]:
            traces[f"err@{i}"] = _trace(skill, params, table, _name=name, error_at=i)
        n_calls = len(traces["ok"]["calls"])
        if n_calls > 0:
            traces["empty@0"] = _trace(skill, params, table, _name=name, empty_at=0)
        # **回读回来但对不上**——写后回读这一族最要命的一条分支。
        # 关掉回显即可：写进去什么，读回来是另一个数，正是硬件没接受这个值的形状。
        verbs = {c["verb"] for c in traces["ok"]["calls"]}
        if any(v.endswith("Set") for v in verbs) and any(v.endswith("Get") for v in verbs):
            traces["mismatch"] = _trace(skill, params, table, _name=name, no_echo=True)
        n_runs = len(traces["ok"].get("runs") or [])
        for i in range(n_runs):
            traces[f"runerr@{i}"] = _trace(skill, params, table, _name=name, run_error_at=i)
        # 由**参数**而不是回包决定的分支。
        # 这一格的入参**记在它自己那条轨迹里**：整个技能只有一份 `params` 的话，
        # 重放的那一侧会拿基准参数去跑它，于是比的是另一件事（而且会绿）。
        for case, (at, text) in (CUSTOM_ERRORS.get(name) or {}).items():
            traces[case] = _trace(skill, params, table, _name=name,
                                  error_at=at, error_text=text)
        for case, extra in (EXTRA_PARAMS.get(name) or {}).items():
            merged = {**params, **extra}
            tr = _trace(skill, merged, table, _name=name)
            tr["params"] = _jsonable(merged)
            traces[case] = tr

        out[name] = {"params": _jsonable(params), "traces": traces}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    n_tr = sum(len(v["traces"]) for v in out.values())
    print(f"[ok]   skill_traces.json: {len(out)} 个技能 / {n_tr} 条轨迹")
    if missing:
        print(f"[warn] 注册表里找不到：{', '.join(missing)}", file=sys.stderr)
    raised = [(k, t) for k, v in out.items() for t, d in v["traces"].items() if "raised" in d]
    if raised:
        print(f"[note] {len(raised)} 条轨迹抛了异常（也是判据）：" +
              ", ".join(f"{k}/{t}" for k, t in raised[:8]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
