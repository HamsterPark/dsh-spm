r"""批 7b-3 · 五个 `composite.*` 技能**真的分派一遍** —— 子技能的返回由脚本摆。

通用驱动器（`export_skill_traces.py`）给每个子技能一个
`success=True, data={}`，于是这五个技能在那里只走得到「什么都没读到」那一支
（见那边 `BATCH_7B_3` 的注释）。**判据在这一份**：

* `GridSTS` —— 三本账（`succeeded` / `suspect` / `failed`）与 `points` 的坐标；
* `DemoScanAndSTS` —— 「帧没扫完但不判死」，以及「移动失败就跳掉那一点的谱」；
* `TrackDrift_ReferenceScan` —— 采参考 / 算漂移 / 显著性闸 / 补偿；
* `AcquireBiasImagingSeries` —— 两道拒绝、逐帧回读、首尾同条件那把刻度；
* `MoveAtomTo` —— 还原顺序、量程放宽、重试只在 `displaced` 上做。

## 四条纪律

1. **旧仓只读。** `MAST2_PROJECT_ROOT` 指向临时目录（sidecar 与参考图都落那儿）。
2. **墙钟与单调钟都钉死。** `drift_ref_<毫秒>.npy` 的名字里有墙钟；
   `abortable_sleep` 要走单调钟。两个不钉，「重跑逐字节相同」就是假的。
3. **每一格一个新 `run_id`。** sidecar 按 `(技能名, run_id)` 落盘，
   同名同 run 的下一格会**续跑**（跳过已完成的步骤）——
   那正是旧仓 #95「第 5 个点扫描不到」的形状，在导出器里复现出来只会毁掉金样。
4. **录的是计划**（`runs`：子技能名 + 参数）**与报文**，不是我对它的阅读。

    python \
        tools/spec-export/export_batch7b3.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-7b3-export-"))

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "batch7b3.json"
MAST = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.

# ── 两个钟都钉死 ──────────────────────────────────────────────────────────
#
# 墙钟：`TrackDrift_ReferenceScan` 把 `int(time.time()*1000)` 写进参考图的文件名。
# 单调钟：`abortable_sleep` 每 0.1 s 轮询一次，真睡会让这一份跑上几分钟。
import time as _time  # noqa: E402

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


_time.sleep = _fake_sleep              # type: ignore[assignment]
_time.monotonic = _fake_monotonic      # type: ignore[assignment]
_time.perf_counter = _fake_monotonic   # type: ignore[assignment]
_time.time = (lambda: 1_700_000_000.0)  # type: ignore[assignment]

if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402

from mast.core.types import SkillResult  # noqa: E402
from mast.skills.composite.bias_imaging_series import AcquireBiasImagingSeries  # noqa: E402
from mast.skills.composite.demo_scan_and_sts import DemoScanAndSTS  # noqa: E402
from mast.skills.composite.drift_track import TrackDrift_ReferenceScan  # noqa: E402
from mast.skills.composite.grid_sts import GridSTS  # noqa: E402
from mast.skills.composite.move_atom_to import MoveAtomTo  # noqa: E402

TMP = tempfile.mkdtemp(prefix="mast-7b3-files-")
_PROJECT_ROOT = os.environ["MAST2_PROJECT_ROOT"]


def _plain(v: Any) -> Any:
    """JSON 化。**NaN / inf 走字符串占位**（`allow_nan=False` 是这份金样的纪律）。"""
    if isinstance(v, np.ndarray):
        return _plain(v.tolist())
    if isinstance(v, (np.floating, np.integer, np.bool_)):
        return _plain(v.item())
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v == float("inf"):
            return "Infinity"
        if v == float("-inf"):
            return "-Infinity"
        return v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    return str(v)


# ──────────────────────────────────────────────────────────────────────────
# 合成的帧（闭式，零随机数）与文件
# ──────────────────────────────────────────────────────────────────────────

FILES: "dict[str, bytes]" = {}
PATHS: "dict[str, str]" = {}


def npy_file(key: str, arr: np.ndarray) -> str:
    buf = io.BytesIO()
    np.save(buf, np.asarray(arr, dtype=np.float64))
    raw = buf.getvalue()
    FILES[key] = raw
    p = Path(TMP) / f"{key}.npy"
    p.write_bytes(raw)
    PATHS[key] = str(p).replace("\\", "/")
    return PATHS[key]


def frame_peak(ny: int = 16, nx: int = 16, cy: float = 7.0, cx: float = 6.0) -> np.ndarray:
    """一个**唯一**的尖峰 —— 互相关的峰不会并列，`argmax` 有唯一答案。"""
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    return 1.0e-9 + 6.0e-10 * np.exp(-(((i - cy) ** 2 + (j - cx) ** 2) / 4.0))


REF_FRAME = frame_peak()
#: 峰往下 2 行、往右 3 列 —— 于是 `correlate2d` 的峰偏移是可以手算的。
CUR_FRAME = frame_peak(cy=9.0, cx=9.0)
SMALL_FRAME = frame_peak(ny=8, nx=8)
#: 同一张当前图 **+ 一个很大的直流偏置**（20 倍背景）。
#:
#: ⚠️ 这一张是为「两张图**各自**减自己的均值」那道闸造的。不造它的话，
#: `ref` 与 `cur` 的均值几乎相等（同一族合成图，只是峰挪了两格），
#: 于是「减自己的」与「都减 ref 的」给出同一个峰 —— 那道闸一格输入都没有
#: （变异 `drift-each-image-subtracts-its-own-mean` 第一版当场跑出绿色）。
#: 偏置取 2e-8 而不是 1e-9：虚假项的量级是 `Δmean × Σ窗口(ref−mRef)`，
#: 要压过真峰 `Σ(bump)²`（~5e-18）才看得出来。
CUR_FRAME_DC = CUR_FRAME + 2.0e-8
#: **不是方的**一对（16 行 × 24 列）。像素尺寸是 `scan_width_m / 列数` ——
#: 方图上「除以行数」与「除以列数」给出同一个数，于是那道闸在方图上**没有输入**
#: （变异 `drift-pixel-size-is-width-over-columns` 第一版当场跑出绿色）。
#: 而方图正是这个技能平时吃的东西 —— 所以这一格得专门造。
REF_RECT = frame_peak(ny=16, nx=24, cy=6.0, cx=8.0)
CUR_RECT = frame_peak(ny=16, nx=24, cy=9.0, cx=13.0)

npy_file("ref_frame", REF_FRAME)
npy_file("cur_frame", CUR_FRAME)
npy_file("small_frame", SMALL_FRAME)
npy_file("cur_frame_dc", CUR_FRAME_DC)
npy_file("ref_rect", REF_RECT)
npy_file("cur_rect", CUR_RECT)


def missing_path(name: str) -> str:
    return f"{TMP}/{name}".replace("\\", "/")


# ──────────────────────────────────────────────────────────────────────────
# 脚本化的 ExecutionContext
# ──────────────────────────────────────────────────────────────────────────


class _Rec:
    def __init__(self, method: str, args: tuple, ret: Any, error: str = "") -> None:
        self.method = method
        self.args = args
        self.return_value = ret
        self.error = error


class _ScriptCtx:
    """`run` 按**技能名**答；同一个名字可以给一串答案（按调用次序取）。

    另外两件：

    * `safe_call` —— 只有 `TrackDrift_ReferenceScan` 用（裸抓帧），按动词摆；
    * **`SetBias` 的回显** —— `AcquireBiasImagingSeries` 每改一次偏压都要
      `GetBias` 读回来确认。脚本记住最后一次 `SetBias` 的 `bias_v`，
      `GetBias` 默认就答它。不这么做的话「偏压跟上了」这条主路一格都走不到，
      而金样里**只剩下**它的反面。
    """

    def __init__(self, *, runs: "dict[str, Any] | None" = None,
                 calls: "dict[str, Any] | None" = None,
                 setpoint_a: Any = 100e-12,
                 run_id: str = "R1", owner: str = "export") -> None:
        self._script = dict(runs or {})
        self._calls = dict(calls or {})
        self._setpoint = setpoint_a
        self._seen: "dict[str, int]" = {}
        self.run_id = run_id
        self.owner = owner
        self.runs: "list[dict]" = []
        self.calls: "list[dict]" = []
        self._last_bias: Any = None

    # -- 子技能 --
    def run(self, skill_name: str, params: dict, version: Any = None) -> SkillResult:
        self.runs.append({"skill": skill_name, "params": _plain(params)})
        if skill_name == "SetBias":
            self._last_bias = params.get("bias_v")
        spec = self._script.get(skill_name)
        if isinstance(spec, list):
            n = self._seen.get(skill_name, 0)
            self._seen[skill_name] = n + 1
            spec = spec[n] if n < len(spec) else spec[-1]
        if spec is None:
            spec = self._default(skill_name)
        return SkillResult(skill_name=skill_name,
                           success=bool(spec.get("success", True)),
                           data=dict(spec.get("data") or {}),
                           error=str(spec.get("error") or ""))

    def _default(self, skill_name: str) -> dict:
        if skill_name == "GetBias":
            return {"success": True, "data": {"bias_v": self._last_bias}}
        if skill_name == "GetSetpoint":
            return {"success": True, "data": {"setpoint_a": self._setpoint}}
        return {"success": True, "data": {}}

    # -- 裸动词 --
    def safe_call(self, method: str, *args: Any, **kwargs: Any) -> _Rec:
        self.calls.append({"verb": method, "args": _plain(list(args))})
        entry = self._calls.get(method)
        if isinstance(entry, dict) and "error" in entry:
            return _Rec(method, args, None, error=str(entry["error"]))
        if entry is None:
            return _Rec(method, args, None, error=f"no stub for {method}")
        return _Rec(method, args, ("", b"", entry))

    def check_abort(self) -> bool:
        return False


# ──────────────────────────────────────────────────────────────────────────
# 跑一格
# ──────────────────────────────────────────────────────────────────────────

CASES: "dict[str, dict[str, Any]]" = {}
_SEQ = [0]


def case(skill_cls: Any, name: str, params: dict, **ctx_kw: Any) -> None:
    _CLOCK[0] = 1_000_000.0
    _SEQ[0] += 1
    # ⚠️ 每一格一个新 `run_id`：sidecar 按 `(技能名, run_id)` 落盘，
    # 同 run 的下一格会**续跑**，把已完成的步骤整段跳掉。
    ctx_kw.setdefault("run_id", f"R{_SEQ[0]:03d}")
    ctx = _ScriptCtx(**ctx_kw)
    skill = skill_cls()
    res = skill.execute(ctx, dict(params))
    CASES[f"{skill_cls.__name__}/{name}"] = {
        "skill": skill_cls.__name__,
        "key": name,
        "params": _plain(params),
        "success": bool(res.success),
        "error": res.error or "",
        "summary": res.summary,
        "data": _plain(dict(res.data or {})),
        "runs": ctx.runs,
        "calls": ctx.calls,
    }


FAIL = {"success": False, "error": "模拟故障：子技能失败"}


# ══════════════════════════════════════════════════════════════════════════
# 1. GridSTS
# ══════════════════════════════════════════════════════════════════════════

G = {"center_x_m": 1e-8, "center_y_m": -2e-8, "spacing_m": 5e-10, "nx": 2, "ny": 2}

case(GridSTS, "ok_2x2", G)
# ⚠️ **第二次** MoveToXY 失败 ⇒ 那一点的谱采在（上一个）错的地方
# ⇒ 它进 `suspect`，不进 `succeeded`；而 `failed` 记的是移动那一步。
# 三本账在这一格上**互不相等**，这正是它们不是一次划分的证据。
case(GridSTS, "second_move_fails_spectrum_is_suspect", G,
     runs={"MoveToXY": [{"success": True}, FAIL, {"success": True}, {"success": True}]})
case(GridSTS, "all_sts_fail", G, runs={"AcquireSTS": FAIL})
# `configure` 是 `optional=False` ⇒ 整张栅格当场中止，一个点都不跑。
case(GridSTS, "configure_fails_aborts", G, runs={"ConfigureSTS": FAIL})
case(GridSTS, "single_point", {**G, "nx": 1, "ny": 1})
# `nx`/`ny`/`num_points` 全省略 —— 兜底必须与声明里的缺省一致（3 / 3 / 40）。
# 旧仓这里一度写 200，省掉参数就悄悄采了声明值五倍的点。
case(GridSTS, "defaults_are_3x3_and_40_points",
     {"center_x_m": 0.0, "center_y_m": 0.0, "spacing_m": 1e-9})
# 20×20 = 400 正好顶到 `_MAX_TRACKED_POINTS`：逐点记账仍然留着（`> 400` 才丢）。
case(GridSTS, "points_cap_is_inclusive_at_400",
     {"center_x_m": 0.0, "center_y_m": 0.0, "spacing_m": 1e-10, "nx": 20, "ny": 20})


# ══════════════════════════════════════════════════════════════════════════
# 2. DemoScanAndSTS
# ══════════════════════════════════════════════════════════════════════════

D = {"center_x_m": 0.0, "center_y_m": 0.0, "scan_size_m": 30e-9, "sts_count": 3}
WAIT_OK = {"success": True, "data": {"timed_out": False, "stopped_early": False,
                                     "outcome": "completed", "lines_done": 16,
                                     "lines_total": 16}}
WAIT_TIMEOUT = {"success": True, "data": {"timed_out": True, "stopped_early": False,
                                          "lines_done": 7, "lines_total": 16}}
WAIT_STOPPED = {"success": True, "data": {"timed_out": False, "stopped_early": True,
                                          "lines_done": 11, "lines_total": 16}}

case(DemoScanAndSTS, "ok_three_points", D, runs={"WaitScanComplete": WAIT_OK})
# ⚠️ 帧没扫完 —— **报告，不判死**。`scan_completed=False` 而 `success=True`：
# 谱点是几何算出来的，一张截断的帧作废不了任何一条谱。
# 而「不许发生的」是把它当成完整的图交出去。
case(DemoScanAndSTS, "timed_out_is_reported_not_fatal", D,
     runs={"WaitScanComplete": WAIT_TIMEOUT})
case(DemoScanAndSTS, "stopped_early_is_reported_not_fatal", D,
     runs={"WaitScanComplete": WAIT_STOPPED})
# `outcome` 缺席时由两个布尔推 —— 这一格验的是那条推导。
case(DemoScanAndSTS, "outcome_derived_when_absent", D,
     runs={"WaitScanComplete": {"success": True, "data": {"timed_out": True}}})
case(DemoScanAndSTS, "save_scan_fails_but_run_stands", D,
     runs={"WaitScanComplete": WAIT_OK, "SaveScan": FAIL})
# ⚠️ 第二个点的移动失败 ⇒ `sts_2` **整个不排**（动态计划那一支）。
# `runs` 里看得见：`move_2` 之后直接 `move_3`。
case(DemoScanAndSTS, "failed_move_skips_that_spectrum", D,
     runs={"WaitScanComplete": WAIT_OK,
           "MoveToXY": [{"success": True}, FAIL, {"success": True}]})
# `sts_count > 5` ⇒ 铺一张**真的**网格（从前是拿中心坐标补齐，
# 于是每一条「多出来的」谱都在同一个点上重测一遍）。
case(DemoScanAndSTS, "nine_points_is_a_real_grid", {**D, "sts_count": 9},
     runs={"WaitScanComplete": WAIT_OK})
case(DemoScanAndSTS, "one_point", {**D, "sts_count": 1}, runs={"WaitScanComplete": WAIT_OK})
# `configure_scan` 是 `optional=False` ⇒ 中止。
case(DemoScanAndSTS, "configure_fails_aborts", D, runs={"ConfigureScan": FAIL})
# `wait_scan` 也是 `optional=False` —— 它**失败**（不是超时）时整条中止。
# 与上面「超时但不判死」是两件事：一个是这一步没跑成，一个是它跑成了而帧不全。
case(DemoScanAndSTS, "wait_step_failing_aborts", D, runs={"WaitScanComplete": FAIL})


# ══════════════════════════════════════════════════════════════════════════
# 3. TrackDrift_ReferenceScan
# ══════════════════════════════════════════════════════════════════════════

def _grab_body(arr: np.ndarray) -> list:
    """`Scan_FrameDataGrab` 的 body —— `[name_len, name, rows, cols, data, dir]`。"""
    return [4, "Z (m)", int(arr.shape[0]), int(arr.shape[1]),
            np.asarray(arr, dtype=np.float64), 1]


T = {"ref_x_m": 1e-8, "ref_y_m": -5e-9, "ref_width_m": 16e-9}
GRAB_CUR = {"Scan_FrameDataGrab": _grab_body(CUR_FRAME)}
GRAB_REF = {"Scan_FrameDataGrab": _grab_body(REF_FRAME)}
GRAB_SMALL = {"Scan_FrameDataGrab": _grab_body(SMALL_FRAME)}
GRAB_CUR_DC = {"Scan_FrameDataGrab": _grab_body(CUR_FRAME_DC)}
GRAB_CUR_RECT = {"Scan_FrameDataGrab": _grab_body(CUR_RECT)}
GRAB_ERR = {"Scan_FrameDataGrab": {"error": "NanonisError: no frame in buffer"}}

# 第一趟：没有参考图 ⇒ 抓一张存下来，**并把路径交出去**。
# 旧仓原来只说一句「再调一次，带上 ref_image_path」而从没产出过那个路径 ——
# 整条流程是个死胡同（2026-07-03 复核）。
case(TrackDrift_ReferenceScan, "first_call_captures_reference", T, calls=GRAB_REF)
# 抓不到帧 ⇒ 中止，而那句话说的是**仪器没给出可用的二维数据**。
case(TrackDrift_ReferenceScan, "grab_fails_aborts", T, calls=GRAB_ERR)
# 有参考图：峰从 (7,6) 挪到 (9,9) ⇒ 漂移 (dx, dy) = (+3, +2) 像素 × 像素尺寸。
case(TrackDrift_ReferenceScan, "tracks_and_compensates",
     {**T, "ref_image_path": PATHS["ref_frame"]}, calls=GRAB_CUR)
# ⚠️ 当前图带一个很大的直流偏置 —— 答案**必须与上一格一样**，
# 因为两张图各自减自己的均值。都减 `ref` 的均值 ⇒ 虚假项压过真峰、峰跑到边上。
# 这是整份金样里唯一分得开「各自减」与「都减一个」的一格。
case(TrackDrift_ReferenceScan, "dc_offset_does_not_move_the_peak",
     {**T, "ref_image_path": PATHS["ref_frame"]}, calls=GRAB_CUR_DC)
# ⚠️ **不是方的**一对（16×24）：像素尺寸是 `宽 / 列数`。除以行数在方图上
# 一模一样 —— 这是整份金样里唯一分得开的一格。
case(TrackDrift_ReferenceScan, "non_square_frame_scales_by_columns",
     {**T, "ref_image_path": PATHS["ref_rect"]}, calls=GRAB_CUR_RECT)
# 同一张图 ⇒ 峰在中心 ⇒ 漂移 0 ⇒ **不排**补偿那一步（显著性闸 1 pm）。
case(TrackDrift_ReferenceScan, "no_drift_no_compensation_step",
     {**T, "ref_image_path": PATHS["ref_frame"]}, calls=GRAB_REF)
# 补偿那一步 `optional=True`：它失败时漂移照报，`compensated` 留 False。
case(TrackDrift_ReferenceScan, "compensation_step_fails_drift_still_reported",
     {**T, "ref_image_path": PATHS["ref_frame"]},
     calls=GRAB_CUR, runs={"ConfigureScan": FAIL})
# 尺寸对不上 ⇒ **0 漂移**（不是报错、也不是缩放）。
case(TrackDrift_ReferenceScan, "size_mismatch_reports_zero_drift",
     {**T, "ref_image_path": PATHS["ref_frame"]}, calls=GRAB_SMALL)
case(TrackDrift_ReferenceScan, "ref_image_unreadable_aborts",
     {**T, "ref_image_path": missing_path("nope.npy")}, calls=GRAB_CUR)
# `ref_scan` 是 `optional=False` ⇒ 中止，**连抓帧都不做**。
case(TrackDrift_ReferenceScan, "ref_scan_fails_aborts", T,
     calls=GRAB_REF, runs={"FullScan": FAIL})
# `set_bias` 是 `optional=True` —— 它失败不挡后面。
case(TrackDrift_ReferenceScan, "set_bias_fails_but_run_stands", T,
     calls=GRAB_REF, runs={"SetBias": FAIL})


# ══════════════════════════════════════════════════════════════════════════
# 4. AcquireBiasImagingSeries
# ══════════════════════════════════════════════════════════════════════════

FRAME = {"success": True, "data": {"center_x_m": 2e-8, "center_y_m": 1e-8, "width_m": 4e-8}}
SAVED = {"success": True, "data": {"saved_path": f"{TMP}/bias_frame.sxm".replace("\\", "/")}}


def _assess(conc: float, verdict: str = "atomic") -> dict:
    return {"success": True, "data": {"verdict": verdict, "angular_concentration": conc,
                                      "snr": 12.5, "period_fast_axis_nm": 0.25,
                                      "coverage": 0.91}}


B = {"biases_v": "0.1,-0.1,0.02"}

# 两道拒绝。
case(AcquireBiasImagingSeries, "refused_need_two_biases", {"biases_v": "0.05"})
# 读不到框、调用方也没给 ⇒ **不猜一个框去扫**。
case(AcquireBiasImagingSeries, "refused_no_scan_frame", B,
     runs={"GetScanFrame": {"success": True, "data": {}}})
# 主路：三个偏压 + 末尾重复第一个 ⇒ 四帧。首尾同条件的集中度给出时间刻度。
case(AcquireBiasImagingSeries, "ok_four_frames_with_time_scale", B,
     runs={"GetScanFrame": FRAME, "SaveScan": SAVED,
           "AssessAtomicResolution": [_assess(120.0), _assess(180.0),
                                      _assess(90.0), _assess(100.0)]})
# ⚠️ 偏压没跟上：`GetBias` 在第二帧上答一个陈值 ⇒ 那一帧记失败、**跳过后四步**。
case(AcquireBiasImagingSeries, "bias_did_not_follow", B,
     runs={"GetScanFrame": FRAME, "SaveScan": SAVED,
           "AssessAtomicResolution": _assess(120.0),
           "GetBias": [{"success": True, "data": {"bias_v": 0.02}},
                       {"success": True, "data": {"bias_v": 0.02}},
                       {"success": True, "data": {"bias_v": -0.1}},
                       {"success": True, "data": {"bias_v": 0.02}}]})
# ⚠️ setpoint 被带偏 ⇒ 「只变偏压」这句话不成立了。
case(AcquireBiasImagingSeries, "setpoint_drifted", B,
     runs={"GetScanFrame": FRAME, "SaveScan": SAVED,
           "AssessAtomicResolution": _assess(120.0),
           "GetSetpoint": [{"success": True, "data": {"setpoint_a": 100e-12}},
                           {"success": True, "data": {"setpoint_a": 100e-12}},
                           {"success": True, "data": {"setpoint_a": 400e-12}},
                           {"success": True, "data": {"setpoint_a": 100e-12}}]})
# 拿不到落盘路径 ⇒ 这一帧记失败。**本技能没有 `GetLatestScanFile` 兜底**，
# 所以本仓给 `SaveScan` 注入 `findLatestSxm` 是它的前置。
case(AcquireBiasImagingSeries, "no_saved_path", B,
     runs={"GetScanFrame": FRAME, "SaveScan": {"success": True, "data": {}}})
# 关掉末尾重复 ⇒ 没有时间对照帧 ⇒ 建议里多一句「下次把它打开」。
case(AcquireBiasImagingSeries, "repeat_off_loses_the_time_scale",
     {**B, "repeat_first_at_end": False},
     runs={"GetScanFrame": FRAME, "SaveScan": SAVED,
           "AssessAtomicResolution": [_assess(120.0), _assess(180.0), _assess(90.0)]})
# 只有一帧成功 ⇒ 「成功的帧不足两张，比不了。」
case(AcquireBiasImagingSeries, "one_good_frame_cannot_compare", B,
     runs={"GetScanFrame": FRAME,
           "SaveScan": [SAVED, {"success": True, "data": {}},
                        {"success": True, "data": {}}, {"success": True, "data": {}}],
           "AssessAtomicResolution": _assess(120.0)})
# 框与设定点都显式给 ⇒ **一次 `GetScanFrame` 都不发**。
case(AcquireBiasImagingSeries, "explicit_frame_skips_the_readback",
     {**B, "center_x_m": -1e-8, "center_y_m": 3e-8, "scan_size_m": 2e-8,
      "setpoint_a": 50e-12, "line_time_s": 0.4, "settle_s": 0.0},
     setpoint_a=50e-12,
     runs={"SaveScan": SAVED, "AssessAtomicResolution": _assess(150.0)})
# 解析：全角分号、半角分号、转不动的那一段**跳过**（不是拒绝整串）、去重。
case(AcquireBiasImagingSeries, "bias_string_parsing",
     {"biases_v": "0.1；-0.1; abc, 0.05, 0.1", "repeat_first_at_end": False},
     runs={"GetScanFrame": FRAME, "SaveScan": SAVED,
           "AssessAtomicResolution": _assess(120.0)})


# ══════════════════════════════════════════════════════════════════════════
# 5. MoveAtomTo
# ══════════════════════════════════════════════════════════════════════════

M = {"atom_x_m": 1e-9, "atom_y_m": 0.0, "target_x_m": 1.5e-9, "target_y_m": 0.0}
READ_OK = {
    "GetBias": {"success": True, "data": {"bias_v": 0.8}},
    "GetSetpoint": {"success": True, "data": {"setpoint_a": 60e-12}},
    "GetTipSpeed": {"success": True, "data": {"speed_m_s": 250e-9, "custom_speed": False}},
    "GetCurrentGains": {"success": True, "data": {"gain_index": 3, "full_scale_a": 1e-6}},
}


def _verify(verdict: str, **extra: Any) -> dict:
    d = {"verdict": verdict}
    d.update(extra)
    return {"success": True, "data": d}


AT_TARGET = _verify("at_target", found_x_m=1.5e-9, found_y_m=1e-11,
                    residual_m=1e-11, others=[])
DISPLACED = _verify("displaced", found_x_m=1.2e-9, found_y_m=0.0, residual_m=3e-10, others=[])
NOT_FOUND = _verify("not_found", residual_m=None, others=[])
SCAN_OK = {"success": True, "data": {"saved_path": f"{TMP}/verify.sxm".replace("\\", "/")}}

case(MoveAtomTo, "ok_at_target", M,
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET})
# ⚠️ 只有 `displaced` 才重试 —— 重试时设定点 ×1.5（封顶 100 nA）。
case(MoveAtomTo, "displaced_then_at_target", M,
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": [DISPLACED, AT_TARGET]})
case(MoveAtomTo, "displaced_exhausts_attempts", {**M, "max_attempts": 1},
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": DISPLACED})
# ⚠️ 重试时 `setpoint × 1.5` **封顶在 100 nA**。起手 80 nA ⇒ 120 nA ⇒ 封到 100 nA，
# 而 `a2:manip_setpoint` 的参数里看得见。起手取缺省 57 nA 的话 ×1.5 = 85.5 nA
# 还够不着顶，那道封顶**一格输入都没有**
# （变异 `move-atom-retry-lowers-the-resistance-and-caps-it` 第一版跑出绿色）。
case(MoveAtomTo, "retry_setpoint_is_capped",
     {**M, "manip_setpoint_a": 80e-9, "manip_bias_v": 0.02},
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": [DISPLACED, AT_TARGET]})
# `not_found` / `ambiguous`：不知道原子在哪 ⇒ **不重试**（降电阻再拖一次
# 等于拖一个没认出来的东西）。`runs` 里只有一轮。
case(MoveAtomTo, "not_found_does_not_retry", M,
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": NOT_FOUND})
# 关掉复扫 ⇒ `moved` 是 **None**（不是 False）：「已搬运，未复扫确认」。
case(MoveAtomTo, "verify_off", {**M, "verify": False}, runs=READ_OK)
# 复扫回来没有路径 ⇒ `verify_verdict = "no_frame"`，`moved` 仍是 None。
case(MoveAtomTo, "scan_gives_no_path", M,
     runs={**READ_OK, "ScanAt": {"success": True, "data": {}}})
# ⚠️ **这个技能存在要防的那一件事**：还原没做成 ⇒ 硬失败，
# 错误正文里点名「立刻 SetSetpoint / SetBias 还原成像值」。
case(MoveAtomTo, "restore_setpoint_fails_is_a_hard_failure", M,
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET,
           "SetSetpoint": [{"success": True}, FAIL]})
# ⚠️ 前放量程不够（满量程 60 nA < 57 nA × 2）⇒ 先退一档再操纵，完事退回去。
# `runs` 里多出 `SetCurrentGain` 两次。
case(MoveAtomTo, "gain_widened_and_restored", M,
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET,
           "GetCurrentGains": {"success": True,
                               "data": {"gain_index": 3, "full_scale_a": 60e-9}}})
# 读不到量程 ⇒ **不动它**（`gain_index` 缺席 ⇒ `None`）。
case(MoveAtomTo, "gain_unreadable_leaves_it_alone", M,
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET,
           "GetCurrentGains": {"success": True, "data": {"full_scale_a": 1e-9}}})
# 成像偏压是负的 ⇒ 操纵偏压跟着负 —— **不穿零**。
case(MoveAtomTo, "negative_imaging_bias_keeps_the_sign", M,
     runs={**READ_OK, "GetBias": {"success": True, "data": {"bias_v": -1.2}},
           "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET})
# ⚠️ 读回的键**在、但值是 `None`** ⇒ 那是「没给」，不是「设成空」。
# 读成值的话还原步骤收到 None、`SetSetpoint` 拒绝它，于是结停在操纵电阻上。
case(MoveAtomTo, "none_valued_readback_falls_back_to_defaults", M,
     runs={"GetBias": {"success": True, "data": {"bias_v": None}},
           "GetSetpoint": {"success": True, "data": {"setpoint_a": None}},
           "GetTipSpeed": {"success": True, "data": {"speed_m_s": None}},
           "GetCurrentGains": {"success": True, "data": {}},
           "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET})
# `coord_epoch` 透传进每一次 `MoveToXY`（含每一个拖拽航点）。
case(MoveAtomTo, "coord_epoch_passes_through", {**M, "coord_epoch": 7},
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET})
# 航点封顶：1 米的拖拽不是一次操纵 ⇒ `_waypoints` 封在 400 个。
case(MoveAtomTo, "waypoints_are_capped_at_400",
     {**M, "target_x_m": 1.4e-6, "verify": False}, runs=READ_OK)
# ⚠️ **斜着搬** —— 上面每一格的 `dy` 都是 0，于是 `hypot` 退化成 `abs`，
# 而 D-HYPOT-1（两种语言的 `hypot` 差 1 ULP）在整份金样里一次都照不到。
# 距离取 `hypot(7e-10, 5e-10) = 8.602e-10` ⇒ `ceil(8.602) = 9` 个航点，
# **离整数远**：1 ULP 的差改不了航点个数（改得了的话两侧连步数都对不上）。
case(MoveAtomTo, "diagonal_drag_exercises_hypot",
     {"atom_x_m": 0.0, "atom_y_m": 0.0, "target_x_m": 7e-10, "target_y_m": 5e-10,
      "verify": False},
     runs=READ_OK)
# 操纵条件**显式给** ⇒ `junction_resistance_ohm` 才算得出来
# （`|V| / I`）。省略时旧仓读的是 `params.get(...)` ⇒ `None` ⇒ 这一格恒为 null，
# 而**错误正文里也印 `None`**（见 deviation：照移，理由写在那里）。
case(MoveAtomTo, "explicit_manip_conditions_give_a_resistance",
     {**M, "manip_bias_v": 0.02, "manip_setpoint_a": 40e-9},
     runs={**READ_OK, "ScanAt": SCAN_OK, "VerifyAdatomAt": AT_TARGET})


# ──────────────────────────────────────────────────────────────────────────
# 落盘
# ──────────────────────────────────────────────────────────────────────────


def _norm(v: Any) -> Any:
    """临时目录与项目根 → 占位符，分隔符一律正斜杠。

    没有它，「重跑逐字节相同」是假的 —— 两处临时目录每跑一次都换名字。
    """
    if isinstance(v, str):
        s = (v.replace(_PROJECT_ROOT, "<project-root>")
              .replace(_PROJECT_ROOT.replace("\\", "/"), "<project-root>")
              .replace(TMP, "<tmp>")
              .replace(TMP.replace("\\", "/"), "<tmp>"))
        return s.replace("\\", "/") if ("<tmp>" in s or "<project-root>" in s) else s
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_norm(x) for x in v]
    return v


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_batch7b3.py 生成 —— 旧仓五个 composite "
                 "技能真的分派一遍，子技能的返回由脚本摆。不要手改。",
        "versions": {"numpy": np.__version__},
        "files": {k: base64.b64encode(v).decode("ascii") for k, v in FILES.items()},
        "cases": CASES,
    }
    text = json.dumps(_norm(doc), ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False)
    # 操作系统那句错（同 D-ANALYSIS-1）：`[WinError 2] 系统找不到指定的文件。`
    # 带着本机的语言环境，Node 那边叫 `ENOENT`。两句都对，都不是判据。
    text = re.sub(r"\[WinError [^\"]*", "<oserror>", text)
    text = re.sub(r"\[Errno [^\"]*", "<oserror>", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((text + "\n").encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(CASES)} 格 · {kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
