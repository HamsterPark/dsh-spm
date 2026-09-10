"""把看门狗的判定行为录成金样。

驱动的是**旧仓真实实现** `mast/core/watchdog.py` 的 `SafetyWatchdog.run()` ——
不是抄它的规则再自己模拟，而是**把它的时间换成假时钟，让真循环自己跑**：

    watchdog.time = FakeTime()      # monotonic 读计数器，sleep 推进计数器并数 tick

这样窗口、贴轨计时、冷却、闩、抑制清窗、人工判定过期，全部由真代码算出来，
我们只负责喂读数和记结果。TS 侧 `packages/host/kernel/src/watchdog.ts` 跑同一批脚本比对。

    python \\
        tools/spec-export/export_watchdog_trace.py

为什么非要真跑不可：这条网的规则有六个互相纠缠的状态（窗口、贴轨起点、抑制、
人工判定、冷却、闩），而 2026-08-10 那次事故的本体正是「它武装着但打不着火」——
**照文字复述规则的移植，复述错了没人知道**。
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "watchdog.json"

sys.path.insert(0, str(MAST_ROOT))
import mast.core.watchdog as wd_mod  # noqa: E402
from mast.core.watchdog import SafetyWatchdog  # noqa: E402

logging.getLogger("mast.core.watchdog").setLevel(logging.CRITICAL + 1)

INTERVAL = 0.5
WINDOW = 8


class FakeTime:
    """够 `run()` 用的最小 time 模块替身。sleep 推进时钟并数 tick。"""

    def __init__(self, max_ticks: int, stop_event) -> None:
        self.now = 1000.0
        self.ticks = 0
        self.max_ticks = max_ticks
        self.stop_event = stop_event

    def monotonic(self) -> float:
        return self.now

    def sleep(self, s: float) -> None:
        self.now += s
        self.ticks += 1
        if self.ticks >= self.max_ticks:
            self.stop_event.set()


class Rec:
    def __init__(self, error, return_value) -> None:
        self.error = error
        self.return_value = return_value


class ScriptedPool:
    """按脚本逐 tick 回一个 Current_Get。`None` 表示这一 tick 读失败。"""

    def __init__(self, readings) -> None:
        self.readings = list(readings)
        self.i = 0
        self.calls: list[str] = []

    def safe_call(self, method_name: str, *a, role: str = "main", **kw) -> Rec:
        self.calls.append(f"{method_name}@{role}")
        v = self.readings[self.i] if self.i < len(self.readings) else self.readings[-1]
        self.i += 1
        if v is None:
            return Rec("read failed", None)
        if v == "garbage":                      # 形状不对的回包
            return Rec(None, ("hdr", b"", []))
        return Rec(None, ("hdr", b"", [v]))


# ── 脚本 ─────────────────────────────────────────────────────────────────────
# 每条：readings（逐 tick 的电流读数，None=读失败，"garbage"=形状不对）
#       threshold / suppress / idle：可为常量或逐 tick 的表
RAIL = 1.0e-8      # 贴轨值（2026-08-10 真机上就是 1.0003678774239688e-8）
OK = 1.0e-10       # 正常隧道电流
THRESH = 5.0e-9    # 阈值

SCRIPTS: dict[str, dict] = {
    # 窗口未满就不该开火：7 个超阈值 + 第 8 个不超 ⇒ 一次都不开
    "seven_high_one_low": {
        "readings": [RAIL] * 7 + [OK] + [OK] * 4,
    },
    # 连续 8 个超阈值 ⇒ 第 8 个 tick 开火
    "eight_high_fires": {
        "readings": [RAIL] * 12,
    },
    # 读失败**不许**往窗口里塞占位值：中间插一次失败，窗口保留、只是晚一 tick
    "read_failure_preserves_window": {
        "readings": [RAIL] * 4 + [None] + [RAIL] * 8,
    },
    # 形状不对的回包同理——不是 0.0，是「跳过这一 tick」
    "garbage_reply_preserves_window": {
        "readings": [RAIL] * 4 + ["garbage"] + [RAIL] * 8,
    },
    # 蓄意扎针期间抑制并**清空窗口** ⇒ 恢复后要重新攒满才可能开火（天然余波期）
    "suppression_clears_window": {
        "readings": [RAIL] * 20,
        "suppress": [""] * 6 + ["TipShapeWithReadback"] * 3 + [""] * 11,
    },
    # 阈值读不到（getter 抛）且从没读到过 ⇒ 走出厂默认继续武装，不是不判
    "threshold_getter_raises": {
        "readings": [RAIL] * 12,
        "threshold": "raise",
    },
    # 阈值先好后坏 ⇒ 用上次的好值继续武装
    "threshold_degrades_to_last_good": {
        "readings": [RAIL] * 12,
        "threshold": [THRESH] * 3 + ["raise"] * 9,
    },
    # 退针**没确认**（回调回 False）⇒ 闩不上，冷却后重试
    "unconfirmed_retract_retries": {
        "readings": [RAIL] * 80,
        "confirmed": False,
        "max_ticks": 80,
    },
    # 退针确认了 ⇒ 上闩，此后一直不再开火
    "confirmed_retract_latches": {
        "readings": [RAIL] * 40,
        "confirmed": True,
        "max_ticks": 40,
    },
    # MAST 没在驱动仪器（令牌闲置） ⇒ 判定为人工，**记录但不退针**……
    "human_operating_suppresses": {
        "readings": [RAIL] * 12,
        "idle": 99.0,          # 令牌闲置很久 ⇒ 不是 MAST 在驱动
    },
    # ……但这个判定**自己会过期**：贴轨显著超过人工扎针的上界就照退不误
    "human_override_expires": {
        "readings": [RAIL] * 60,
        "idle": 99.0,
        "max_ticks": 60,
    },
    # idle_getter 缺席 ⇒ **一律认为 MAST 在驱动**（缺席不该悄悄关掉这张网）
    "absent_idle_getter_still_arms": {
        "readings": [RAIL] * 12,
        "idle": "absent",
    },
}


def run(name: str, spec: dict) -> dict:
    readings = spec["readings"]
    max_ticks = spec.get("max_ticks", len(readings))
    pool = ScriptedPool(readings)

    fired: list[dict] = []
    confirmed = spec.get("confirmed", True)

    def on_anomaly():
        fired.append({"tick": ft.ticks, "t": round(ft.now - 1000.0, 3)})
        return confirmed

    thr = spec.get("threshold", THRESH)
    thr_state = {"i": 0}

    def threshold_getter():
        if thr == "raise":
            raise RuntimeError("读不到 cm_sat_current_a")
        if isinstance(thr, list):
            v = thr[min(thr_state["i"], len(thr) - 1)]
            thr_state["i"] += 1
            if v == "raise":
                raise RuntimeError("读不到 cm_sat_current_a")
            return v
        return thr

    sup = spec.get("suppress")
    sup_state = {"i": 0}

    def suppress_getter():
        if sup is None:
            return ""
        v = sup[min(sup_state["i"], len(sup) - 1)]
        sup_state["i"] += 1
        return v

    idle = spec.get("idle", None)
    idle_getter = None
    if idle == "absent":
        idle_getter = None
    elif idle is not None:
        idle_getter = lambda: idle  # noqa: E731

    kwargs = {"threshold_getter": threshold_getter, "suppress_getter": suppress_getter}
    if idle_getter is not None:
        kwargs["idle_getter"] = idle_getter

    w = SafetyWatchdog(
        pool, on_anomaly, interval_s=INTERVAL, window_size=WINDOW,
        retrigger_cooldown_s=30.0, **kwargs,
    )
    ft = FakeTime(max_ticks, w._stop_event)
    real_time = wd_mod.time
    wd_mod.time = ft
    try:
        w.run()
    finally:
        wd_mod.time = real_time

    return {
        "ticks": ft.ticks,
        "fired": fired,
        "latched": w.is_anomaly_triggered,
        "current_get_calls": len(pool.calls),
        "effective_threshold_a": w.effective_threshold_a,
    }


def main() -> int:
    out = {
        "constants": {
            "interval_s": INTERVAL,
            "window_size": WINDOW,
            "window_seconds": INTERVAL * WINDOW,
            "retrigger_cooldown_s": 30.0,
            "human_rail_override_s": float(wd_mod.HUMAN_RAIL_OVERRIDE_S),
            "shipped_saturation_threshold_a": wd_mod._shipped_saturation_threshold_a(),
        },
        "trace": {name: run(name, spec) for name, spec in SCRIPTS.items()},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(f"[ok]   watchdog.json: {len(out['trace'])} 条脚本")
    for k, v in out["trace"].items():
        print(f"       {k:38s} fired={len(v['fired'])} latched={v['latched']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
