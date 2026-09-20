"""把状态缓存的规格与行为录成金样。

驱动的是**旧仓真实实现** `mast/core/state.py` 的 `InstrumentState`，喂它一个假 pool
（只按脚本回话，不碰网络）。TS 侧 `packages/instrument/instrument-state` 跑同一批脚本比对。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_state_spec.py

三节，各自回答一个不同的问题：

* `spec`   —— 「刷新读哪些动词、带什么参数」「哪些字段可 patch / 要强转 / 算核心读」。
             **动词序列是观测出来的**（假 pool 记下每一次 `safe_call`），不是手抄的。
* `coerce` —— 「什么算一个读数」。判据在 `mast/io/nanonis_files.py:scalar_float`，
             拒绝多元素序列 / 字符串 / bool / NaN / inf。逐条录真实返回值。
* `trace`  —— 「一串刷新与 patch 之后缓存长什么样」。carry-forward 与 stale 这两条
             规则是逐字移植的重点，而它们只在**序列**里才显形：单点断言看不出
             「上一次的真值被这一次的读不到覆盖了没有」。

非有限数与 bool 在 JSON 里没法原样表达，`coerce` 一节用带标签的对象编码
（`{"py": "nan"}` 等），读的一侧照标签还原。`allow_nan=False` 兜底：真漏了裸
`NaN` 进来会当场炸，而不是写出一份 Node 拒绝解析的 JSON（0.7 踩过）。
"""

from __future__ import annotations

import dataclasses
import json
import math
import sys
from pathlib import Path

from _paths import require_mast_root

import os
import tempfile

# ⚠️ **必须在 import mast 之前**：把项目根指到临时目录（PLAN §8.6 的「隔离」）。
# 2026-09-10 踩到过一次——一个「只读」的导出脚本因为 import 拉起了管理员覆写机制，
# 在旧仓里新建了一个目录。红线是「只读旧仓」，不是「不弄坏旧仓」。
os.environ.setdefault('MAST2_PROJECT_ROOT', tempfile.mkdtemp(prefix='mast-spec-export-'))

MAST_ROOT = require_mast_root()
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "state.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core.state import InstrumentState, coerce_number  # noqa: E402
from mast.core.types import HardwareState  # noqa: E402


class Rec:
    """够 `InstrumentState.refresh()` 用的最小回包记录。"""

    def __init__(self, error: str | None, return_value):
        self.error = error
        self.return_value = return_value


class FakePool:
    """按脚本回话，并**记下每一次调用**——刷新的动词序列由此观测得到。"""

    def __init__(self) -> None:
        self.calls: list[list] = []
        self.replies: dict[str, object] = {}

    def safe_call(self, method_name: str, *args, role: str = "main", **kw) -> Rec:
        self.calls.append([method_name, list(args), role])
        body = self.replies.get(method_name, "__miss__")
        if body == "__miss__" or body is None:
            return Rec("read failed", None)
        # 真实回包是三段信封 (error_string, raw_bytes, body)，`_extract_parsed` 取 [2]
        return Rec(None, ["", b"", body])


# ── coerce 用例 ───────────────────────────────────────────────────────────────
# 每条 (标签, 值)。标签进 JSON，值喂给真实 coerce_number。
COERCE_CASES: list[tuple[str, object]] = [
    ("int", 3), ("float", 1.5), ("negative", -2.5), ("zero", 0.0),
    ("bool_true", True), ("bool_false", False),          # bool 不是读数
    ("str_number", "1.5"), ("str_text", "abc"), ("bytes", b"1.5"),
    ("none", None),
    ("nan", float("nan")), ("inf", float("inf")), ("neg_inf", float("-inf")),
    ("list_empty", []), ("list_one", [1.5]), ("tuple_one", (1.5,)),
    ("nested_one", ((1.5,),)),                            # 递归解包
    ("list_two", [1.5, 2.5]),                             # 多元素 ⇒ 拒，不取第 0 个
    ("list_one_str", ["1.5"]), ("list_one_none", [None]),
    ("dict", {"v": 1.5}),
]


def encode(v):
    """把 Python 值编成能进 JSON 的形状；读的一侧照标签还原。"""
    if isinstance(v, bool):
        return {"py": "true" if v else "false"}
    if isinstance(v, float) and not math.isfinite(v):
        return {"py": "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf")}
    if isinstance(v, bytes):
        return {"py": "bytes", "value": v.decode("ascii")}
    if isinstance(v, tuple):
        return {"py": "tuple", "value": [encode(x) for x in v]}
    if isinstance(v, list):
        return [encode(x) for x in v]
    if isinstance(v, dict):
        return {"py": "dict", "value": {k: encode(x) for k, x in v.items()}}
    return v


# ── trace 脚本 ────────────────────────────────────────────────────────────────
# 每步是 ("refresh", {动词: body 或 None 表示读失败}) 或 ("patch", {字段: 值})。
GOOD = {
    "Bias_Get": [1.5],
    "ZCtrl_StatusGet": [2],
    "ZCtrl_CtrlListGet": [3, 3, ["Current", "log Current", "df"], 1],
    "ZCtrl_SetpntGet": [1.0e-10],
    "Current_Get": [1.2e-10],
    "ZCtrl_ZPosGet": [-1.0e-8],
    "FolMe_XYPosGet": [1.0e-7, 2.0e-7],
    "ZCtrl_LimitsGet": [5.0e-7],
    "Scan_StatusGet": [1],
    "LockIn_ModOnOffGet": [1],
    "Scan_FrameGet": [0.0, 0.0, 1.0e-7, 1.0e-7, 30.0],
}

SCRIPTS: dict[str, list] = {
    # 全好 → 每个字段都该有值
    "happy_path": [("refresh", GOOD)],
    # 一次好读之后 ZCtrl_StatusGet 读不到：**旧真值必须活下来**，不能降级成 unknown。
    # 这就是 2026-06-29 真机死循环那条：写回被 1 Hz 刷新抹掉，StartScan 的前置条件永远不满足。
    "carry_forward_partial_miss": [
        ("refresh", GOOD),
        ("refresh", {**GOOD, "ZCtrl_StatusGet": None, "ZCtrl_CtrlListGet": None}),
    ],
    # 五个核心读**一个都没落地** ⇒ stale=True 且**保留旧时间戳**（2026-07-03 复查）。
    "stale_when_all_core_miss": [
        ("refresh", GOOD),
        ("refresh", {}),
        ("refresh", GOOD),   # 链路回来 ⇒ stale 应当落回 False
    ],
    # 冷启动就全读不到：没有旧值可端，stale 不该亮（亮了等于说「有陈值在用」，没有）
    "cold_start_all_miss": [("refresh", {})],
    # patch：False 要写进去（StopScan 之后 scan_running=False），None 跳过，非白名单忽略
    "patch_semantics": [
        ("refresh", GOOD),
        ("patch", {"scan_running": False}),
        ("patch", {"bias_v": None}),
        ("patch", {"not_a_field": 42}),
        ("patch", {"z_controller_on": True, "z_controller_status": "On"}),
    ],
    # patch 的数值闸门：1-元组解包得开（Nanonis 数值数组常这样回），多元素要拒。
    # 拒了就**不写**——陈的真值好过一个假形状（2026-08-13 那次锁机的成因）。
    "patch_numeric_gate": [
        ("refresh", GOOD),
        ("patch", {"current_a": (9.9e-11,)}),
        ("patch", {"current_a": [1.0, 2.0]}),
        ("patch", {"bias_v": "nan"}),
        ("patch", {"z_pos_m": "-1e-9"}),
    ],
    # withdrawn 三态：反馈关且 z 顶到上限 ⇒ True；差一点 ⇒ False；反馈开 ⇒ False；读不到 ⇒ None
    "withdrawn_logic": [
        ("refresh", {**GOOD, "ZCtrl_StatusGet": [1], "ZCtrl_ZPosGet": [5.0e-7]}),
        ("refresh", {**GOOD, "ZCtrl_StatusGet": [1], "ZCtrl_ZPosGet": [4.9e-7]}),
        ("refresh", GOOD),
        ("refresh", {**GOOD, "ZCtrl_StatusGet": None, "ZCtrl_ZPosGet": None}),
    ],
    # 状态码表外的码要留痕，不能悄悄当成 Off
    "unknown_status_code": [("refresh", {**GOOD, "ZCtrl_StatusGet": [7]})],
    # 锁相：读不到就是 None，**不是 off**（否则电流监控的告警刷屏正好回来）
    "lockin_unread_is_not_off": [
        ("refresh", GOOD),
        ("refresh", {**GOOD, "LockIn_ModOnOffGet": None}),
    ],
    # 扫描框不足 5 个字段 ⇒ 整组不写（几何是一组，写一半比不写更危险）
    "scan_frame_short": [("refresh", {**GOOD, "Scan_FrameGet": [0.0, 0.0, 1e-7]})],
    # Z 控制器列表形状不认识 ⇒ ([], 0)，不写名字
    "ctrl_list_unrecognised": [("refresh", {**GOOD, "ZCtrl_CtrlListGet": [3, 3, 1]})],
    # ── 下面三条录的是 refresh() 与 apply_patch 的**判据不一致** ──────────────
    # refresh 里每个字段是裸 `float(parsed[0])`，而 apply_patch 走 `scalar_float`。
    # 于是同一个值从两条路写进同一个缓存，结果不同。TS 侧按 D-STATE-1 统一到严格那侧，
    # 这三条正是那条 deviation 的证据（不是我的推测，是跑出来的）。
    "bad_shape_raises": [("refresh", {**GOOD, "Bias_Get": [[1.5, 2.5]]})],
    "nan_through_refresh": [("refresh", {**GOOD, "Bias_Get": [float("nan")]})],
    "string_through_refresh": [("refresh", {**GOOD, "Bias_Get": ["1.5"]})],
}

HISTORY_CHANNELS = ("bias", "current", "z")


def snap_dict(st: HardwareState) -> dict:
    d = dataclasses.asdict(st)
    d.pop("timestamp", None)  # 时间相关，单独用 timestamp_carried 表达
    # 值也走 encode：refresh 的裸 float() 真的能把 NaN 写进缓存（`nan_through_refresh`），
    # 不编码的话 allow_nan=False 会当场炸——而那恰恰是这条金样要记下来的东西。
    return {k: encode(v) for k, v in d.items()}


def run(ops: list) -> list[dict]:
    pool = FakePool()
    state = InstrumentState(pool)
    trace: list[dict] = []
    for op in ops:
        kind, payload = op
        raised = None
        before_ts = state.snapshot().timestamp
        if kind == "refresh":
            pool.replies = dict(payload)
            pool.calls = []
            try:
                state.refresh()
            except Exception as exc:  # noqa: BLE001 —— 录下来，这正是要比对的行为
                raised = f"{type(exc).__name__}"
        elif kind == "patch":
            state.apply_patch(**payload)
        else:
            raise ValueError(f"未知操作 {kind}")
        cache = state.snapshot()
        step = {
            "op": kind,
            "state": snap_dict(cache),
            "history": {ch: [encode(x) for x in state.history(ch)] for ch in HISTORY_CHANNELS},
        }
        if kind == "refresh":
            step["verbs"] = pool.calls
            step["timestamp_carried"] = cache.timestamp == before_ts
        if raised is not None:
            step["raised"] = raised
        trace.append(step)
    return trace


# ── live-state 提示块 ────────────────────────────────────────────────────────
# `format_live_state_block` 是纯函数，而**它印出来的字就是契约**：这块存在的唯一
# 理由是「给模型一个正确的数照抄」，措辞抄错等于把 2026-07-27 那次坐标事故的成因
# 放回去。所以录整段文本，不是录字段。
LIVE_CASES: dict[str, dict] = {
    "empty": {},
    "full": {
        "bias_v": -2.0, "current_a": 1.2e-10, "setpoint_a": 1.0e-10,
        "z_pos_m": -1.0e-8, "x_pos_m": 5.0e-8, "y_pos_m": -3.0e-8,
        "z_controller_on": True, "z_controller_status": "On",
        "z_controller_name": "log Current", "z_controller_index": 1,
        "z_controller_names": ["Current", "log Current", "df"],
        "scan_running": False,
        "scan_center_x_m": 1.0e-8, "scan_center_y_m": -2.0e-8,
        "scan_width_m": 1.0e-7, "scan_height_m": 5.0e-8, "scan_angle_deg": 30.0,
    },
    # 只有 z_controller_on 没有 status ⇒ 走 ON/OFF 那条 elif
    "status_fallback": {"z_controller_on": False},
    # 有名字但没下标/没列表 ⇒ 不印 “(index … of …)”
    "ctrl_name_only": {"z_controller_name": "Current"},
    # 只有宽没有高 ⇒ 不印 frame size，但**照样印**量级警告（它只看 width）
    "width_without_height": {"scan_width_m": 2.0e-8},
    # 偏压是唯一不走 format_si 的：它天然在 1 附近，印成 `-2000m` 正确但没法看
    "bias_only": {"bias_v": 1.5},
    "tiny_frame": {"scan_width_m": 1.0e-9, "scan_height_m": 1.0e-9},
}


def live_blocks() -> dict:
    from mast.agents._shared.live_state_mw import format_live_state_block
    return {
        name: format_live_state_block(HardwareState(**fields))
        for name, fields in LIVE_CASES.items()
    }


def main() -> int:
    out = {
        "spec": {
            "patchable_fields": sorted(InstrumentState._PATCHABLE_FIELDS),
            "numeric_fields": sorted(InstrumentState._NUMERIC_FIELDS),
            # `_CORE` 是 refresh() 里的局部量，抄不到；它决定 stale 何时亮，
            # 而 trace 里的 stale 步已经把这条规则钉死了。这里只记字段清单来源。
            "core_fields": ["bias_v", "z_controller_on", "current_a", "z_pos_m", "scan_running"],
            "zctrl_status": {"1": "Off", "2": "On", "3": "Hold", "4": "SwitchingOff",
                             "5": "SafeTip", "6": "Withdrawing"},
            "history_channels": list(HISTORY_CHANNELS),
            "history_len": 20,
            "default_state": snap_dict(HardwareState()),
        },
        "coerce": [
            {"case": name, "in": encode(v), "out": coerce_number(v, field=name)}
            for name, v in COERCE_CASES
        ],
        "trace": {name: run(ops) for name, ops in SCRIPTS.items()},
        "live_state": live_blocks(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    steps = sum(len(v) for v in out["trace"].values())
    print(f"[ok]   state.json: {len(out['trace'])} 条脚本 / {steps} 步 / "
          f"{len(out['coerce'])} 条 coerce 用例 / {len(out['live_state'])} 条提示块")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
