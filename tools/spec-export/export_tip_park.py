"""把「针尖退到位了没有」的判定录成网格金样。

驱动的是**旧仓真实实现** `mast/core/tip_park.py` 与 `mast/core/envelope_reconcile.py`。

这一段的判据必须是网格，不能挑几个点：结论是**三态**（parked / not_parked /
unreadable），而 `unreadable` 里还要再分两种成因（读失败 vs 本机没声明过），
它们的处置完全相反——前者再等一下有意义，后者等多久都是白等。

    python \\
        tools/spec-export/export_tip_park.py

⚠️ 猜错方向的代价**不对称**：`z_extend_sign` 猜反了，会把「针顶在伸长端
（朝样品那一侧）」判成已退针。所以「没声明过」必须是一个**独立的结论**，
不是一个默认值——出厂默认 `+1` 在这一项上不是中性的，本机实测是 `-1`。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "tip_park.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import tip_park as tp  # noqa: E402
from mast.core.envelope_reconcile import resolve_z_travel  # noqa: E402

#: `resolve_z_travel` 的输入网格。三个来源两两组合，含「软限没启用」那一格。
TRAVEL_CASES: list[tuple[str, dict]] = [
    ("none", dict(piezo_z_full_m=None, z_limits_m=None, z_limits_enabled=None)),
    ("piezo_only", dict(piezo_z_full_m=720e-9, z_limits_m=None, z_limits_enabled=None)),
    # 软限**未启用** ⇒ 那对数字是上次写进去的值，不拦任何东西
    ("piezo_plus_disabled_limits",
     dict(piezo_z_full_m=720e-9, z_limits_m=[-100e-9, 100e-9], z_limits_enabled=False)),
    # 没问过 ⇒ 按未启用处理（不知道启没启用时拿它当边界就是猜）
    ("piezo_plus_unknown_limits",
     dict(piezo_z_full_m=720e-9, z_limits_m=[-100e-9, 100e-9], z_limits_enabled=None)),
    # 软限已启用且更紧 ⇒ 取交集
    ("piezo_plus_tighter_limits",
     dict(piezo_z_full_m=720e-9, z_limits_m=[-100e-9, 100e-9], z_limits_enabled=True)),
    # 软限已启用但更松 ⇒ 仍取交集（谁更紧听谁的）
    ("piezo_plus_looser_limits",
     dict(piezo_z_full_m=720e-9, z_limits_m=[-900e-9, 900e-9], z_limits_enabled=True)),
    ("limits_only",
     dict(piezo_z_full_m=None, z_limits_m=[-200e-9, 150e-9], z_limits_enabled=True)),
    # 退化：上下界相等 / 反了
    ("degenerate_equal",
     dict(piezo_z_full_m=None, z_limits_m=[50e-9, 50e-9], z_limits_enabled=True)),
    ("piezo_zero", dict(piezo_z_full_m=0.0, z_limits_m=None, z_limits_enabled=None)),
]

#: 本机 RT 行程 720 nm ⇒ 半程 ±360 nm，容差 = 1% × 720 nm = 7.2 nm。
_RT = resolve_z_travel(piezo_z_full_m=720e-9, z_limits_m=None, z_limits_enabled=None)

#: 判定网格：读数 × 方向符号。
VERDICT_CASES: list[tuple[str, dict]] = [
    # ── 两个「一条读数就能定死」的否定：不需要行程和符号 ──
    ("feedback_on_closed", dict(feedback_on=True, module_status="On", z_m=None,
                                travel=None, z_extend_sign=None)),
    ("module_withdrawing", dict(feedback_on=False, module_status="Withdrawing",
                                z_m=None, travel=None, z_extend_sign=None)),
    # ── 没声明过方向符号 ⇒ 独立的结论，不是默认值 ──
    ("undeclared_sign", dict(feedback_on=False, module_status="Off", z_m=-360e-9,
                             travel=_RT, z_extend_sign=None)),
    ("undeclared_sign_beats_unreadable",
     dict(feedback_on=None, module_status=None, z_m=None, travel=None,
          z_extend_sign=None, unreadable=("z_m",))),
    # ── 读不到 ──
    ("no_feedback_reading", dict(feedback_on=None, module_status="Off", z_m=-360e-9,
                                 travel=_RT, z_extend_sign=-1)),
    ("no_z", dict(feedback_on=False, module_status="Off", z_m=None,
                  travel=_RT, z_extend_sign=-1)),
    ("no_travel", dict(feedback_on=False, module_status="Off", z_m=-360e-9,
                       travel=None, z_extend_sign=-1)),
    # ── 本机实测的符号（-1 ⇒ 收回端在**高**端）──
    ("parked_high_rail", dict(feedback_on=False, module_status="Off", z_m=360e-9,
                              travel=_RT, z_extend_sign=-1)),
    ("parked_within_tolerance", dict(feedback_on=False, module_status="Off",
                                     z_m=353.5e-9, travel=_RT, z_extend_sign=-1)),
    ("just_outside_tolerance", dict(feedback_on=False, module_status="Off",
                                    z_m=352e-9, travel=_RT, z_extend_sign=-1)),
    # **顶在伸长端**要单独说一句：那是朝样品的那一侧
    ("at_extend_end", dict(feedback_on=False, module_status="Off", z_m=-360e-9,
                           travel=_RT, z_extend_sign=-1)),
    ("mid_travel", dict(feedback_on=False, module_status="Off", z_m=0.0,
                        travel=_RT, z_extend_sign=-1)),
    # ── 相反的符号（+1 ⇒ 收回端在低端）——同一个 z 得到相反的结论 ──
    ("sign_plus_parked_low", dict(feedback_on=False, module_status="Off", z_m=-360e-9,
                                  travel=_RT, z_extend_sign=1)),
    ("sign_plus_at_extend", dict(feedback_on=False, module_status="Off", z_m=360e-9,
                                 travel=_RT, z_extend_sign=1)),
    # ── 模块状态只作证据不作判据 ──
    ("parked_but_module_hold", dict(feedback_on=False, module_status="Hold",
                                    z_m=360e-9, travel=_RT, z_extend_sign=-1)),
    ("parked_module_none", dict(feedback_on=False, module_status=None,
                                z_m=360e-9, travel=_RT, z_extend_sign=-1)),
    ("parked_module_safetip", dict(feedback_on=False, module_status="SafeTip",
                                   z_m=360e-9, travel=_RT, z_extend_sign=-1)),
]


def _travel(t) -> dict | None:
    if t is None:
        return None
    return {"lo_m": t.lo_m, "hi_m": t.hi_m, "span_m": t.span_m, "source": t.source}


def main() -> int:
    travels = {}
    for name, kw in TRAVEL_CASES:
        travels[name] = {"input": {k: v for k, v in kw.items()},
                         "travel": _travel(resolve_z_travel(**kw))}

    verdicts = {}
    for name, kw in VERDICT_CASES:
        # `read_at` 钉死：它是 time.time()，不钉就每次跑出不同金样
        v = tp.park_verdict_from_readings(read_at=0.0, **kw)
        verdicts[name] = {
            "input": {**{k: (_travel(x) if k == "travel" else x) for k, x in kw.items()}},
            "state": v.state,
            "reason": v.reason,
            "is_parked": v.is_parked,
            "retry_useful": v.retry_useful,
            "evidence": v.evidence(),
            "feedback_on": v.feedback_on,
            "module_status": v.module_status,
            "z_m": v.z_m,
            "rail_m": v.rail_m,
            "rail_side": v.rail_side,
            "gap_m": v.gap_m,
            "tolerance_m": v.tolerance_m,
            "travel_source": v.travel_source,
            "unreadable": list(v.unreadable),
            "undeclared": list(v.undeclared),
        }

    out = {
        "constants": {
            "PARKED": tp.PARKED, "NOT_PARKED": tp.NOT_PARKED, "UNREADABLE": tp.UNREADABLE,
            "rail_tol_frac": tp._RAIL_TOL_FRAC,
            "module_status": {str(k): v for k, v in tp._MODULE_STATUS.items()},
        },
        "travel": travels,
        "verdicts": verdicts,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    by_state: dict[str, int] = {}
    for v in verdicts.values():
        by_state[v["state"]] = by_state.get(v["state"], 0) + 1
    print(f"[ok]   tip_park.json: {len(travels)} 条行程 / {len(verdicts)} 条判定 "
          f"（{', '.join(f'{k}={n}' for k, n in sorted(by_state.items()))}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
