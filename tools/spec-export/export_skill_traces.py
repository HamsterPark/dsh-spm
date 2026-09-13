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


class _FakeContext:
    """按真机形状应答的假 context。

    回包信封是 ``(error_string, raw_bytes, body)`` —— 三段。技能里所有
    `reply_scalar` / `parsed[2][0]` 都按这个形状读。
    """

    def __init__(self, table: dict, *, error_at: int | None = None,
                 empty_at: int | None = None, run_error_at: int | None = None,
                 no_echo: bool = False,
                 error_text: str = "模拟故障：连接被对端关闭"):
        self.table = table
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


def _scrub(s: str) -> str:
    s = s.replace(_PROJECT_ROOT, "<project-root>").replace(
        _PROJECT_ROOT.replace("\\", "/"), "<project-root>")
    return _STAMP.sub(lambda m: m.group(1) + "<stamp>", s)


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
    ctx = _FakeContext(table, **kw)
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
                 + BATCH_3D + BATCH_3E + BATCH_3F):
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
