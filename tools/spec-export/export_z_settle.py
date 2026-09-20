"""把 **Z 稳定 + 两台方向判定机**录成金样。

驱动的是**旧仓真实实现**：`mast/skills/composite/_z_settle.py` 的 `ZSettle`、
`RetractForSampleChange._judge_recede` / `._ladder`、
`RelocateCoarseXY._judge_recede` / `._clearance_ladder` / `._no_displacement` /
`._approach_prescription`。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_z_settle.py

## 为什么单开一台驱动器

`skill_traces.json` 里那两条组合走的是**恒定回包**：settle 每次都在第 5 个样本上
收敛成 `tracking`，方向判据每次都在同一条电流跳闸上结束。也就是说通用驱动器
**只碰得到五分之一的判据**：`out_of_range` / `moving` / `unreadable` / `aborted`
四种结局、到轨的四种组合、没声明符号那一支、「测出来是零」那道守卫 —— 一条都走不到。
而那几条正是 2026-08-04 与 08-11 两次现场买回来的东西。

## 两台判定机**刻意不合并**

`RetractForSampleChange._judge_recede` 与 `RelocateCoarseXY._judge_recede` 是
旧仓的两个函数，措辞与电流那一支的判法都不同（后者会说出阈值由哪一项决定、
有一条与工作点无关的满量程退路、会把「电流这条没判」写进结论）。
这份金样**两台都录**，于是「谁把它们合并了」当场变红（同 D-CHANNELS-1 / D-PIEZO-1）。

## 时钟

`ZSettle` 是一个纯 dataclass —— 这里直接构造它，不跑轮询循环，所以没有钟。
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
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "z_settle.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import instrument_profile as ip                    # noqa: E402
from mast.skills.composite import _z_settle as zs                 # noqa: E402
from mast.skills.composite.relocate_coarse_xy import RelocateCoarseXY   # noqa: E402
from mast.skills.composite.retract_for_sample_change import (      # noqa: E402
    RetractForSampleChange,
)

#: 声明过符号的一台机器（`-1` 是本机实测值）。
DECLARED = {"z_extend_sign": "-1", "z_recede_min_nm": 1.0}
#: **没声明**符号 —— 两台判定机都必须答「不知道」，而不是吃出厂 `+1`。
NO_SIGN = {"z_recede_min_nm": 1.0}

#: 构造一个 ZSettle。名字说的是「它是什么形状的读数」。
def _settle(**kw: Any) -> zs.ZSettle:
    base: dict[str, Any] = {"tol_m": 5e-10, "timeout_s": 20.0}
    base.update(kw)
    return zs.ZSettle(**base)


STATES: dict[str, zs.ZSettle] = {
    # 五种结局各一条（`why()` 的五条分支）
    "tracking": _settle(z_m=1.0e-7, current_a=1.2e-10, setpoint_a=1.0e-10,
                        settled=True, state="tracking", elapsed_s=4.3,
                        samples=43, drift_m=1e-13, excursion_m=4.7e-8,
                        loop_confirmed_on=True),
    "at_rail": _settle(z_m=-1.5e-6, current_a=1e-14, setpoint_a=1.0e-10,
                       settled=True, state="out_of_range", elapsed_s=5.4,
                       samples=54, drift_m=0.0, excursion_m=3.24e-7,
                       loop_confirmed_on=True),
    "moving": _settle(z_m=4.658e-7, current_a=1e-13, setpoint_a=1.0e-10,
                      settled=False, state="moving", elapsed_s=20.0,
                      samples=200, drift_m=5.5e-8, excursion_m=4.65e-7,
                      loop_confirmed_on=True),
    "moving_loop_off": _settle(z_m=1.0e-7, settled=False, state="moving",
                               elapsed_s=20.0, samples=200, drift_m=3e-9,
                               loop_confirmed_on=False),
    "moving_loop_unknown": _settle(z_m=1.0e-7, settled=False, state="moving",
                                   elapsed_s=20.0, samples=200, drift_m=3e-9,
                                   loop_confirmed_on=None),
    "moving_one_sample": _settle(z_m=1.0e-7, settled=False, state="moving",
                                 elapsed_s=20.0, samples=1, drift_m=None),
    "unreadable": _settle(settled=False, state="unreadable", elapsed_s=0.6,
                          samples=5, loop_confirmed_on=True),
    "aborted": _settle(settled=False, state="aborted", elapsed_s=1.2, samples=12),
    # setpoint 读不到的两种成因（**两条不同的下一步**）
    "tracking_no_setpoint_err": _settle(
        z_m=1.0e-7, current_a=1.2e-10, setpoint_a=None,
        setpoint_why="ZCtrl_SetpntGet 报错:模拟故障：连接被对端关闭",
        settled=True, state="tracking", elapsed_s=4.3, samples=43,
        drift_m=0.0, excursion_m=4.7e-8, loop_confirmed_on=True),
    "tracking_no_setpoint_unparsable": _settle(
        z_m=1.0e-7, current_a=1.2e-10, setpoint_a=None,
        setpoint_why="ZCtrl_SetpntGet 回包读不懂(shape=list,repr 前 120 字:[])",
        settled=True, state="tracking", elapsed_s=4.3, samples=43,
        drift_m=0.0, excursion_m=4.7e-8, loop_confirmed_on=True),
}

#: `(名字, 基线, 退针后, profile, setpoint 覆盖)`。
#:
#: `z_extend_sign = -1` ⇒ **Z 变小 = 伸长 = 在远离**。所以「远离」那几格里
#: `after.z_m < baseline.z_m`，这一点值得单独看一眼：符号反过来抄，整张表会对称地错。
JUDGE_CASES: list[tuple[str, str, str, dict, Any]] = []


def _pair(name: str, base: zs.ZSettle, after: zs.ZSettle) -> None:
    STATES[name] = after
    _ = base


# 直接用现成的几条 + 几条专门配的
B_TRACK = _settle(z_m=1.0e-7, current_a=1.2e-10, setpoint_a=1.0e-10, settled=True,
                  state="tracking", elapsed_s=4.0, samples=40, drift_m=0.0,
                  excursion_m=1e-8, loop_confirmed_on=True)
A_RECEDE = _settle(z_m=1.0e-7 - 47.67e-9, current_a=5.4e-14, setpoint_a=1.0e-10,
                   settled=True, state="tracking", elapsed_s=4.1, samples=41,
                   drift_m=0.0, excursion_m=4.8e-8, loop_confirmed_on=True)
A_APPROACH = _settle(z_m=1.0e-7 + 20e-9, current_a=5.4e-14, setpoint_a=1.0e-10,
                     settled=True, state="tracking", elapsed_s=4.1, samples=41,
                     drift_m=0.0, excursion_m=2.1e-8, loop_confirmed_on=True)
A_FLAT = _settle(z_m=1.0e-7 + 0.2e-9, current_a=5.4e-14, setpoint_a=1.0e-10,
                 settled=True, state="tracking", elapsed_s=4.1, samples=41,
                 drift_m=0.0, excursion_m=3e-10, loop_confirmed_on=True)
B_RAIL = _settle(z_m=-1.5e-6, current_a=1e-14, setpoint_a=1.0e-10, settled=True,
                 state="out_of_range", elapsed_s=5.0, samples=50, drift_m=0.0,
                 excursion_m=3e-7, loop_confirmed_on=True)
A_RAIL = _settle(z_m=-1.5e-6, current_a=1e-14, setpoint_a=1.0e-10, settled=True,
                 state="out_of_range", elapsed_s=5.0, samples=50, drift_m=0.0,
                 excursion_m=3e-7, loop_confirmed_on=True)
A_RAIL_FAR = _settle(z_m=-1.6e-6, current_a=1e-14, setpoint_a=1.0e-10, settled=True,
                     state="out_of_range", elapsed_s=5.0, samples=50, drift_m=0.0,
                     excursion_m=3e-7, loop_confirmed_on=True)
A_MOVING = STATES["moving"]
A_HOT = _settle(z_m=1.0e-7, current_a=5e-9, setpoint_a=1.0e-10, settled=True,
                state="tracking", elapsed_s=4.1, samples=41, drift_m=0.0,
                excursion_m=1e-8, loop_confirmed_on=True)
A_HOT_NO_SP = _settle(z_m=1.0e-7, current_a=5e-9, setpoint_a=None,
                      setpoint_why="ZCtrl_SetpntGet 报错:模拟故障：连接被对端关闭",
                      settled=True, state="tracking", elapsed_s=4.1, samples=41,
                      drift_m=0.0, excursion_m=1e-8, loop_confirmed_on=True)
A_WARM = _settle(z_m=1.0e-7 - 47.67e-9, current_a=2e-10, setpoint_a=1.0e-10,
                 settled=True, state="tracking", elapsed_s=4.1, samples=41,
                 drift_m=0.0, excursion_m=4.8e-8, loop_confirmed_on=True)
B_TRACK_NO_SP = _settle(
    z_m=1.0e-7, current_a=1.2e-10, setpoint_a=None,
    setpoint_why="ZCtrl_SetpntGet 报错:模拟故障：连接被对端关闭",
    settled=True, state="tracking", elapsed_s=4.0, samples=40, drift_m=0.0,
    excursion_m=1e-8, loop_confirmed_on=True)

PAIRS: list[tuple[str, zs.ZSettle | None, zs.ZSettle, dict]] = [
    ("receding", B_TRACK, A_RECEDE, DECLARED),
    ("approaching_by_z", B_TRACK, A_APPROACH, DECLARED),
    ("ambiguous_flat", B_TRACK, A_FLAT, DECLARED),
    ("both_rail_ambiguous", B_RAIL, A_RAIL, DECLARED),
    ("rail_after_receding", B_TRACK, A_RAIL_FAR, DECLARED),
    ("rail_baseline_then_found", B_RAIL, A_APPROACH, DECLARED),
    ("unsettled_after", B_TRACK, A_MOVING, DECLARED),
    ("unsettled_baseline", A_MOVING, A_RECEDE, DECLARED),
    ("no_baseline", None, A_RECEDE, DECLARED),
    ("no_sign", B_TRACK, A_RECEDE, NO_SIGN),
    # 电流跳闸：绝对地板 vs 相对项 vs 读不到 setpoint
    ("current_trip_absolute_floor", B_TRACK, A_HOT, DECLARED),
    ("current_trip_relative", B_TRACK, A_WARM, DECLARED),
    # 基线**也**读不到 setpoint ⇒ 相对判据无从算起。三种下场：
    #   ① 没有满量程界 ⇒ 电流这条**没判**，落到 Z 主证据（而那句「没判」要写进结论）；
    #   ② 有满量程界但没超 ⇒ 同上，只是那句话里多一句「满量程界也没超」；
    #   ③ 有满量程界且超了 ⇒ 放大器饱和，与工作点无关 ⇒ 判 approaching。
    ("current_no_setpoint_anywhere", B_TRACK_NO_SP, A_HOT_NO_SP, DECLARED),
    ("current_no_setpoint_full_scale_ok", B_TRACK_NO_SP, A_HOT_NO_SP,
     dict(DECLARED, preamp_full_scale_a=1e-8)),
    ("current_no_setpoint_full_scale_hit", B_TRACK_NO_SP, A_HOT_NO_SP,
     dict(DECLARED, preamp_full_scale_a=1e-9)),
]

#: `_no_displacement(rungs, commanded)` 的格。
NO_DISP_CASES: list[tuple[str, list[dict], int]] = [
    ("empty", [], 11),
    ("no_ruler_abstains", [{"has_ruler": False, "dz_m": 0.0}], 11),
    ("mixed_ruler_abstains",
     [{"has_ruler": True, "dz_m": 0.0}, {"has_ruler": False, "dz_m": 0.0}], 11),
    ("dz_none_abstains", [{"has_ruler": True, "dz_m": None}], 11),
    ("moved_ok", [{"has_ruler": True, "dz_m": 1e-9},
                  {"has_ruler": True, "dz_m": 4.7e-8}], 11),
    ("stuck", [{"has_ruler": True, "dz_m": 1e-10},
               {"has_ruler": True, "dz_m": 2e-10}], 11),
    ("stuck_exactly_at_threshold", [{"has_ruler": True, "dz_m": 1e-9}], 11),
    ("negative_dz_uses_abs", [{"has_ruler": True, "dz_m": -2e-10}], 111),
]

#: `_approach_prescription(why)` 的三支（按证据分岔）。
PRESCRIPTION_CASES = [
    ("from_z", "Z 压电缩回 20.0 nm"),
    ("from_current_floor",
     "电流 5e-09 A 高于阈值 1e-09 A(由**绝对地板**决定:setpoint 读到 1e-10 A,"
     "相对项 3e-10 A,地板 1e-09 A);读数已收敛"),
    ("from_current_relative",
     "电流 2e-10 A 高于阈值 3e-10 A(由**相对项 3×setpoint**决定:...);读数已收敛"),
    ("from_current_unsettled",
     "电流 5e-09 A 高于阈值 1e-09 A(由**绝对地板**决定:...);⚠️ **这次读数未收敛**(超时)"),
]


def main() -> int:
    retract = RetractForSampleChange()
    relocate = RelocateCoarseXY()

    out: dict[str, Any] = {
        "constants": {
            "noise_floor_a": zs._NOISE_FLOOR_A,
            "tol_fraction_of_threshold": zs._TOL_FRACTION_OF_THRESHOLD,
            "default_poll_s": zs._DEFAULT_POLL_S,
            "default_window_n": zs._DEFAULT_WINDOW_N,
            "state_labels": dict(zs._STATE_LABELS),
            "danger_current_mult": 3.0,
            "danger_current_abs_a": 1e-9,
            "move_bias_v": 0.5,
            "move_danger_current_a": 1e-11,
        },
        "budget": {},
        "states": {},
        "judge_ladder": {},
        "judge_clearance": {},
        "no_displacement": {},
        "approach_prescription": {},
        "retract_ladder": {},
        "clearance_ladder": {},
    }

    for pname, profile in [("empty", {}), ("declared", DECLARED),
                           ("custom", {"z_recede_min_nm": 2.5, "z_settle_timeout_s": 9.0})]:
        ip.set_profile(profile)
        out["budget"][pname] = {"timeout_s": zs.settle_timeout_s(),
                                "tolerance_m": zs.settle_tolerance_m()}

    for name, st in STATES.items():
        out["states"][name] = st.as_dict()

    for name, base, after, profile in PAIRS:
        ip.set_profile(profile)
        # 梯子版：`self._baseline` / `self._setpoint_a` 是它读的两处状态。
        retract._baseline = base
        retract._setpoint_a = base.setpoint_a if base is not None else None
        v, why = retract._judge_recede(after)
        out["judge_ladder"][name] = {"verdict": v, "why": why}
        # 清障版：基线是入参；`_current_trip_note` 每次从零。
        relocate._current_trip_note = ""
        if base is None:
            out["judge_clearance"][name] = {"verdict": "n/a",
                                            "why": "清障版的基线是必填入参,没有这一格"}
            continue
        v2, why2 = relocate._judge_recede(base, after)
        out["judge_clearance"][name] = {"verdict": v2, "why": why2}

    ip.set_profile(DECLARED)
    for name, rungs, commanded in NO_DISP_CASES:
        stuck, why = relocate._no_displacement(rungs, commanded)
        out["no_displacement"][name] = {"stuck": stuck, "why": why}

    for name, why in PRESCRIPTION_CASES:
        out["approach_prescription"][name] = relocate._approach_prescription(why)

    for total, step_max in [(1, 1000), (10, 1000), (11, 1000), (111, 100),
                            (3000, 1000), (3000, 100), (5, 1), (0, 1000),
                            (2500, 1000), (120, 1000)]:
        out["retract_ladder"][f"{total}@{step_max}"] = retract._ladder(total, step_max)
    for total in [0, 1, 5, 10, 11, 100, 111, 250, 1000]:
        out["clearance_ladder"][str(total)] = relocate._clearance_ladder(total)

    ip.set_profile({})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(f"[ok]   z_settle.json: {len(out['states'])} 个读数形状 / "
          f"{len(PAIRS)} 对 × 2 台判定机 / {len(NO_DISP_CASES)} 格没位移 / "
          f"{len(out['retract_ladder'])}+{len(out['clearance_ladder'])} 条梯子")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
