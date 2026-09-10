"""把通信熔断器的状态机行为录成金样。

驱动的是**旧仓真实实现** `mast/core/comms_health.py`（注入假时钟，纯确定性）。
TS 侧 `packages/host/kernel/src/comms-breaker.ts` 跑同一条脚本比对。

    python \\
        tools/spec-export/export_breaker_trace.py

为什么已经有 7 条移植过来的 pytest 断言还要这个：那 7 条是**手抄**的，抄错了没人知道；
而且它们覆盖不到冷却/窗口的精确边界（`>=` 还是 `>`）和长序列里的交错。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import os
import tempfile

# ⚠️ **必须在 import mast 之前**：把项目根指到临时目录（PLAN §8.6 的「隔离」）。
# 2026-09-10 踩到过一次——一个「只读」的导出脚本因为 import 拉起了管理员覆写机制，
# 在旧仓里新建了一个目录。红线是「只读旧仓」，不是「不弄坏旧仓」。
os.environ.setdefault('MAST2_PROJECT_ROOT', tempfile.mkdtemp(prefix='mast-spec-export-'))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "breaker_trace.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core.comms_health import CommsCircuitBreaker  # noqa: E402


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


# 每条脚本是一串操作；每步之后录 allow()/state()/cooldown/snapshot。
# 边界值是有意选的：t 恰好等于 openUntil、恰好等于 streak 窗口。
SCRIPTS: dict[str, list] = {
    "trip_and_recover": [
        ("fail", "t1"), ("fail", "t2"), ("fail", "t3"),
        ("at", 19.999), ("allow",), ("at", 20.0), ("allow",), ("allow",),
        ("success",), ("allow",),
    ],
    "probe_fails_rearms_full_cooldown": [
        ("fail", "a"), ("fail", "b"), ("fail", "c"),
        ("at", 25.0), ("allow",), ("fail", "still down"),
        ("at", 30.0), ("allow",), ("at", 45.0), ("allow",),
    ],
    "streak_window_boundary": [
        ("fail", "x"), ("fail", "y"),
        ("at", 30.0), ("fail", "exactly at window"),      # 30 不 > 30 ⇒ 仍算连续
        ("success",),
        ("fail", "x"), ("fail", "y"),
        ("at", 60.000001), ("fail", "just past window"),  # > 30 ⇒ 重起
    ],
    "app_error_is_success": [
        ("fail", "t1"), ("fail", "t2"), ("success",), ("fail", "t3"), ("fail", "t4"),
        ("success",), ("allow",),
    ],
    "many_failures_inside_one_cooldown": [
        ("fail", "1"), ("fail", "2"), ("fail", "3"),
        ("at", 5.0), ("fail", "4"), ("at", 10.0), ("fail", "5"),
        ("at", 31.0), ("allow",),   # openUntil 被每次失败往后推
    ],
    "threshold_one": [("fail", "boom"), ("allow",), ("at", 20.0), ("allow",), ("success",)],
}


def run(name: str, ops: list) -> list[dict]:
    clk = Clock()
    kw = {"fail_threshold": 1} if name == "threshold_one" else {}
    b = CommsCircuitBreaker(clock=clk, open_cooldown_s=20.0, streak_window_s=30.0, **kw)
    trace: list[dict] = []
    for op in ops:
        kind = op[0]
        result = None
        if kind == "fail":
            b.record_failure(op[1])
        elif kind == "success":
            b.record_success()
        elif kind == "at":
            clk.t = op[1]
        elif kind == "allow":
            result = b.allow()
        else:
            raise ValueError(f"未知操作 {kind}")
        snap = b.snapshot()
        trace.append({
            "op": list(op),
            "result": result,
            "t": clk.t,
            "state": snap["state"],
            "streak": snap["streak"],
            "cooldown_remaining_s": snap["cooldown_remaining_s"],
            "tripped_total": snap["tripped_total"],
            "last_reason": snap["last_reason"],
        })
    return trace


def main() -> int:
    out = {name: run(name, ops) for name, ops in SCRIPTS.items()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"[ok]   breaker_trace.json: {len(out)} 条脚本 / {sum(len(v) for v in out.values())} 步")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
