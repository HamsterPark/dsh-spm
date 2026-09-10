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
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

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

#: **不进轨迹金样**的技能。
#:
#: 两个 L1 试点是 GraphExecutor 图技能：它们的「成功」需要一份**会收敛的**物理脚本
#: （Z 压电要真的往下走、电流要真的涨到设定点），而合成回包给的是恒定值，
#: 于是 `ok` 那一趟实际录到的是「模块报在跑、压电纹丝不动」的 1800 秒超时。
#: 那条轨迹本身是对的（它正是真机上那个故障的形状），但它不是「成功」。
#: 会收敛的脚本正是 stmsim 的职责 —— DoD ④ 那一条，留给集成测试。
TRACE_SKIP = {"AutoApproach", "ApproachTip"}

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
    # 逗号分隔的整数串，不是自由文本
    "GetSignalValues": {"signal_indexes": "0"},
    # 幅度取一个**在任何叠堆上都不会烧**的低值（默认中点 200 V 会撞上「本机上限未声明」）
    "SetMotorFreqAmp": {"amplitude_v": 30.0, "frequency_hz": 1000.0},
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
        return [[0.1 + i, 0.2 + i], [0.3 + i, 0.4 + i]]
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
                 no_echo: bool = False):
        self.table = table
        # **写进去什么、读回来就是什么** —— 真仪器就是这样，而常量回包会让每一个
        # 「写后回读」技能都走进「不一致」分支。键是去掉尾部 Set/Get 的动词名，
        # 于是 `ZCtrl_SetpntSet` 的实参成为 `ZCtrl_SetpntGet` 的 body。
        self.echo: dict[str, list] = {}
        self.error_at = error_at
        self.empty_at = empty_at
        self.run_error_at = run_error_at
        self.no_echo = no_echo
        self.calls: list[dict] = []
        self.runs: list[dict] = []
        self.state = None

    def safe_call(self, method_name: str, *args, **kwargs) -> NanonisCallRecord:
        i = len(self.calls)
        rec = NanonisCallRecord(method=method_name, args=tuple(args), kwargs=dict(kwargs))
        if i == self.error_at:
            rec.error = "模拟故障：连接被对端关闭"
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


def _jsonable(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
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
        "error": str(getattr(r, "error", "") or ""),
        "summary": str(getattr(r, "summary", "") or ""),
        "data": _jsonable(getattr(r, "data", None) or {}),
    }


def _trace(skill: Any, params: dict, table: dict, **kw) -> dict:
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
    for name in BATCH_1 + BATCH_2:
        if name in TRACE_SKIP:
            continue
        cls = by_name.get(name)
        if cls is None:
            missing.append(name)
            continue
        skill = cls()
        params = _params_for(name, SkillRegistry._get_metadata_raw(cls))

        print(f"  … {name}", file=sys.stderr, flush=True)
        traces: dict[str, Any] = {"ok": _trace(skill, params, table)}
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
            traces[f"err@{i}"] = _trace(skill, params, table, error_at=i)
        n_calls = len(traces["ok"]["calls"])
        if n_calls > 0:
            traces["empty@0"] = _trace(skill, params, table, empty_at=0)
        # **回读回来但对不上**——写后回读这一族最要命的一条分支。
        # 关掉回显即可：写进去什么，读回来是另一个数，正是硬件没接受这个值的形状。
        verbs = {c["verb"] for c in traces["ok"]["calls"]}
        if any(v.endswith("Set") for v in verbs) and any(v.endswith("Get") for v in verbs):
            traces["mismatch"] = _trace(skill, params, table, no_echo=True)
        n_runs = len(traces["ok"].get("runs") or [])
        for i in range(n_runs):
            traces[f"runerr@{i}"] = _trace(skill, params, table, run_error_at=i)

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
