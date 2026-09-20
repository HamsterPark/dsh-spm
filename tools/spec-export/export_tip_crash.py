"""把同区域撞针追踪器录成**一串操作**的金样。

驱动的是**旧仓真实实现** `mast/core/tip_crash_tracker.py`。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_tip_crash.py

## 为什么是「一串操作」而不是一张输入网格

`resolve_scan` 是无状态的，一格输入对一格输出；这一台**全是状态** —— 判据是
「第三次调用为什么被拒」。所以每一条金样是一个**脚本**：`record` / `count` /
`blocked` / `points` / `recover` / `snapshot` / `tick` 依次执行，每一步都记下当时的答案。
一格一格地比，序列错一步就红。

## 时钟

`TipCrashTracker` 收一个 `clock`，所以这里给它一个**可以手动推**的假钟（从 0 起）。
`tick` 就是把它往前推若干秒。不钉死钟的话 TTL 那几条永远录不出稳定的数
（同 D-VAC-2：一份每跑一次都换个数的金样，`git diff` 回答不了「有没有变」）。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = require_mast_root()
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "tip_crash.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import tip_crash_tracker as tct   # noqa: E402

#: 8 nm 是默认格宽。这几个坐标刻意压在格子的边上与格子中间。
P0 = (0.0, 0.0)
P_SAME = (2e-9, -1e-9)        # 同格（|Δ| < 半格）
P_EDGE = (4e-9, 0.0)          # **正好半格** —— 银行家舍入把它送进 0 还是 1 格
P_NEXT = (8e-9, 0.0)          # 下一格
P_FAR = (500e-9, 500e-9)      # 远处

#: 每条脚本：`(名字, 构造参数, [(动作, 参数…), …])`
SCRIPTS: list[tuple[str, dict, list[tuple]]] = [
    ("fresh_tracker_blocks_nothing", {}, [
        ("count", P0), ("blocked", P0), ("points",), ("snapshot",),
    ]),
    # ⑫ 的主线：同点第二次就封
    ("two_crashes_at_one_spot_blocks", {}, [
        ("record", P0), ("blocked", P0), ("count", P0),
        ("record", P0), ("blocked", P0), ("count", P0),
        ("escape", P0), ("snapshot",),
    ]),
    # 「同一个区域」= 量化后同格，几纳米抖动仍算同一块坏地方
    ("jitter_within_tolerance_is_the_same_spot", {}, [
        ("record", P0), ("record", P_SAME),
        ("blocked", P0), ("blocked", P_SAME), ("count", P_SAME), ("snapshot",),
    ]),
    ("half_cell_edge_rounds_half_even", {}, [
        ("record", P0), ("record", P_EDGE),
        ("count", P0), ("count", P_EDGE), ("blocked", P0), ("points",),
    ]),
    ("next_cell_is_a_different_spot", {}, [
        ("record", P0), ("record", P_NEXT),
        ("blocked", P0), ("blocked", P_NEXT), ("count", P0), ("count", P_NEXT),
        ("points",), ("snapshot",),
    ]),
    # 换区：不给坐标 = 全清（那就是恢复动作本身）
    ("coarse_move_clears_everything", {}, [
        ("record", P0), ("record", P0), ("record", P_FAR),
        ("blocked", P0), ("recover_all",),
        ("blocked", P0), ("count", P0), ("count", P_FAR), ("snapshot",),
    ]),
    # 给坐标 = 只清那一格（一次干净的扫描证明针尖在这儿是好的）
    ("clean_scan_clears_only_that_region", {}, [
        ("record", P0), ("record", P0), ("record", P_FAR), ("record", P_FAR),
        ("recover", P0),
        ("blocked", P0), ("blocked", P_FAR), ("count", P0), ("count", P_FAR),
        ("points",),
    ]),
    # TTL：一次通宵跑必须自愈，哪怕 agent 一次逃逸都没发起
    ("stale_crash_expires", {}, [
        ("record", P0), ("record", P0), ("blocked", P0),
        ("tick", 1799.0), ("blocked", P0),
        ("tick", 2.0), ("blocked", P0), ("count", P0), ("snapshot",),
    ]),
    # 每记一次就刷新时间戳 ⇒ 一直在撞的点不会因为「第一次很久以前」而解封
    ("repeated_crashes_refresh_the_clock", {}, [
        ("record", P0), ("tick", 1500.0), ("record", P0),
        ("tick", 400.0), ("blocked", P0), ("count", P0),
    ]),
    # 「读不到 ≠ 零 ≠ 否」：读不到扫描中心的撞针照样计数、照样拦人
    ("unlocated_crashes_still_count_and_block", {}, [
        ("record", (None, None)), ("count", (None, None)),
        ("record", (None, None)), ("blocked", (None, None)),
        ("points",), ("snapshot",),
    ]),
    ("half_unknown_coord_is_unlocated", {}, [
        ("record", (1e-9, None)), ("record", (None, 1e-9)),
        ("count", (None, None)), ("blocked", (None, None)), ("points",),
    ]),
    ("garbage_coord_is_unlocated", {}, [
        ("record", ("x", "y")), ("count", (None, None)), ("points",),
    ]),
    # `float('1e-9')` 认得出 ⇒ 这是一个**有位置**的撞针，不是哨兵格
    ("numeric_string_coord_is_located", {}, [
        ("record", ("1e-9", "2e-9")), ("count", (0.0, 0.0)), ("points",),
    ]),
    # `float(True)` = 1.0 ⇒ 1 m / 8 nm 是一个非常远的格子。荒谬，但**确定**
    ("bool_coord_is_a_number", {}, [
        ("record", (True, False)), ("count", (1.0, 0.0)), ("points",),
    ]),
    # ⚠️ `inf` 没有这一格：旧仓 `round(inf)` 抛 **OverflowError**，而 `_cell` 的
    # `except` 只收 TypeError/ValueError ⇒ 导出器会当场死。差异登记在 deviations。
    # located 与 unlocated **分开**交出去：绝不给一个猜出来的坐标画避让圈
    ("points_separate_located_from_unlocated", {}, [
        ("record", P0), ("record", P_FAR), ("record", (None, None)),
        ("record", (None, None)), ("points",), ("snapshot",),
    ]),
    # 阈值可配：1 表示「撞一次就走」
    ("threshold_one_blocks_immediately", dict(block_threshold=1), [
        ("record", P0), ("blocked", P0), ("snapshot",),
    ]),
    ("threshold_three_needs_three", dict(block_threshold=3), [
        ("record", P0), ("blocked", P0),
        ("record", P0), ("blocked", P0),
        ("record", P0), ("blocked", P0), ("snapshot",),
    ]),
    # 阈值 0 / 负数被夹到 1 —— 「撞 0 次就封」不是一个可用的状态机
    ("threshold_zero_is_clamped_to_one", dict(block_threshold=0), [
        ("blocked", P0), ("record", P0), ("blocked", P0), ("snapshot",),
    ]),
    ("tolerance_can_be_widened", dict(tol_m=1e-6), [
        ("record", P0), ("record", P_FAR),
        ("count", P0), ("blocked", P0), ("points",),
    ]),
    ("ttl_can_be_shortened", dict(ttl_s=10.0), [
        ("record", P0), ("record", P0), ("blocked", P0),
        ("tick", 11.0), ("blocked", P0), ("snapshot",),
    ]),
    # 负坐标：格子键上的舍入在两个方向上都要对
    ("negative_coordinates", {}, [
        ("record", (-12e-9, -4e-9)), ("record", (-12e-9, -4e-9)),
        ("blocked", (-12e-9, -4e-9)), ("points",),
    ]),
]

#: 逃逸指令的措辞 —— 它是模型读的东西，所以逐字钉。
ESCAPE_CASES: list[tuple[str, int, Any, Any]] = [
    ("with_coords", 2, 0.0, 0.0),
    ("with_negative_coords", 3, -1.234e-7, 5.6e-8),
    ("no_coords", 2, None, None),
    ("half_coords", 2, 1e-9, None),
    ("garbage_coords", 2, "x", "y"),
]


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _run(kwargs: dict, script: list[tuple]) -> list[dict]:
    clock = _Clock()
    tracker = tct.TipCrashTracker(clock=clock, **kwargs)
    out: list[dict] = []
    for step in script:
        op = step[0]
        if op == "record":
            x, y = step[1]
            out.append({"op": op, "at": [x, y], "count": tracker.record_crash(x, y)})
        elif op == "count":
            x, y = step[1]
            out.append({"op": op, "at": [x, y], "count": tracker.crash_count(x, y)})
        elif op == "blocked":
            x, y = step[1]
            out.append({"op": op, "at": [x, y], "blocked": tracker.is_blocked(x, y)})
        elif op == "points":
            located, unlocated = tracker.crash_points()
            out.append({
                "op": op,
                "located": sorted([list(p) for p in located]),
                "unlocated": unlocated,
            })
        elif op == "recover":
            x, y = step[1]
            tracker.note_recovery(x, y)
            out.append({"op": op, "at": [x, y]})
        elif op == "recover_all":
            tracker.note_recovery()
            out.append({"op": op})
        elif op == "tick":
            clock.t += float(step[1])
            out.append({"op": op, "by_s": float(step[1]), "now_s": clock.t})
        elif op == "escape":
            x, y = step[1]
            out.append({"op": op, "at": [x, y],
                        "text": tct.crash_escape_message(tracker.crash_count(x, y), x, y)})
        elif op == "snapshot":
            out.append({"op": op, "snapshot": tracker.snapshot()})
        else:                                   # pragma: no cover - 脚本写错
            raise ValueError(f"未知动作 {op!r}")
    return out


def main() -> int:
    scripts = {name: {"config": kwargs, "steps": _run(kwargs, script)}
               for name, kwargs, script in SCRIPTS}
    escapes = {name: {"count": n, "x_m": x, "y_m": y,
                      "text": tct.crash_escape_message(n, x, y)}
               for name, n, x, y in ESCAPE_CASES}
    out = {
        "constants": {
            "block_threshold": tct._BLOCK_THRESHOLD,
            "tol_m": tct._TOL_M,
            "ttl_s": tct._TTL_S,
        },
        "scripts": scripts,
        "escape_messages": escapes,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    steps = sum(len(s["steps"]) for s in scripts.values())
    print(f"[ok]   tip_crash.json: {len(scripts)} 条脚本 / {steps} 步 "
          f"+ {len(escapes)} 条逃逸文案")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
