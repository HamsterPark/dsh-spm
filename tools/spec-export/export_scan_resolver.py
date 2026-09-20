"""把 `resolve_scan` 的意图→参数解析录成网格金样。

驱动的是**旧仓真实实现** `mast/core/scan_resolver.py:resolve_scan`。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_scan_resolver.py

## 为什么这台判定机要**单开一台驱动器**

通用轨迹金样（`export_skill_traces.py`）喂的是常数回包、只调 `execute`，走到的是
`ScanAt` 的**调用序列**。而 `resolve_scan` 的判据一次仪器调用都不发：优先级链逐字段
独立走（explicit > 档位表(用户) > 偏好 > 档位表(出厂) > keep-current），
`trace[*].source` 才是它的产物。**通用驱动器碰不到这些格子，一格都碰不到。**

## 网格覆盖的是「哪一支赢了」，不是「算得对不对」

每一格都盯着一条**分岔**：谁盖过谁、哪一个 clamp 响了、`purpose` 是被点名的还是
碰巧定到的（这两件事只有前者有资格决定工作点）、针尖横向速度那道组合约束有没有
改写已经定好的每线时间。所以断言的是**整个 `trace` 逐键逐字**，不只是最终那几个数。

⚠️ 三处「顺手读一下」在旧仓是延迟 import（偏好 / 针尖速度上限 / 活动档位表），
它们都有降级路径。导出时**全部显式传入**，于是这份金样与本机装没装
`experiment_prefs`、`instrument_profile` 无关 —— 否则两台机器会导出两份不同的金样。
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
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "scan_resolver.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import scan_policy as sp        # noqa: E402
from mast.core import scan_resolver as sr      # noqa: E402


class _Lookup:
    """一张**固定**的档位表当查表口。

    旧仓的 `scan_policy` 是模块级可变状态（`set_policy` / `get_policy`），
    导出时用它 = 让相邻两格互相污染（本仓已经因为同类问题错过三次）。
    """

    def __init__(self, tiers: list[dict]) -> None:
        self._tiers = tiers

    def get_tier_for_size(self, size_m: float) -> dict:
        try:
            size = float(size_m)
        except (TypeError, ValueError):
            size = 0.0
        if size != size:
            size = 0.0
        for tier in self._tiers:
            upper = tier.get("upper_size_m")
            if upper is None:
                return tier
            if size <= float(upper) * (1.0 + 1e-9):
                return tier
        return self._tiers[-1]

    def get_tier_by_name(self, name: str) -> "dict | None":
        if not isinstance(name, str) or not name.strip():
            return None
        want = name.strip().lower()
        for tier in self._tiers:
            if str(tier.get("name", "")).strip().lower() == want:
                return tier
        return None

    def tier_names(self) -> list[str]:
        return [str(t.get("name", "")) for t in self._tiers]


def _factory() -> list[dict]:
    """出厂表，每档标 `source='factory'`（同 `get_policy()` 对未定制表做的事）。"""
    out = sp.factory_tiers()
    for tier in out:
        tier["source"] = "factory"
    return out


#: 一张**操作员编辑过的**表：两档，其中 `wide` 档的 `line_time_s` 是出厂回填的。
#: 它存在的唯一理由是让 `_tier_source` 的三条支路都被走到 —— 出厂 / 用户填的 /
#: 用户的表但这个字段是回填的。
OPERATOR_TIERS: list[dict] = [
    {"name": "fine", "upper_size_m": 2e-8, "pixels": 128, "line_time_s": 0.4,
     "setpoint_a": 2e-10, "p_gain": 3e-11, "time_constant_s": 0.002,
     "source": "operator", "_factory_filled": []},
    {"name": "wide", "upper_size_m": None, "pixels": 192, "line_time_s": 0.5,
     "setpoint_a": None, "p_gain": None, "time_constant_s": None,
     "source": "operator", "_factory_filled": ["line_time_s"]},
]

#: 一张 PI 只填了一半 / 时间常数为 0 的表 —— 两条 `warnings` 支路。
BROKEN_PI_TIERS: list[dict] = [
    {"name": "half_pi", "upper_size_m": 1e-8, "pixels": 256, "line_time_s": 1.0,
     "setpoint_a": None, "p_gain": 5e-11, "time_constant_s": None,
     "source": "operator", "_factory_filled": []},
    {"name": "zero_tc", "upper_size_m": None, "pixels": 256, "line_time_s": 1.0,
     "setpoint_a": None, "p_gain": 5e-11, "time_constant_s": 0.0,
     "source": "operator", "_factory_filled": []},
]

_FACTORY = _Lookup(_factory())
_OPERATOR = _Lookup(OPERATOR_TIERS)
_BROKEN_PI = _Lookup(BROKEN_PI_TIERS)

#: 网格。每格 `(名字, intent kwargs, resolve kwargs)`。
CASES: list[tuple[str, dict, dict]] = [
    # ── 按尺寸自动定档：出厂表六档各一格（边界值落在小的那一档） ──────────
    ("auto_slow", dict(size_m=2e-9), {}),
    ("auto_atomic_verify", dict(size_m=5e-9), {}),
    ("auto_atomic", dict(size_m=1e-8), {}),
    ("auto_highres", dict(size_m=1e-7), {}),
    ("auto_roi", dict(size_m=5e-7), {}),
    ("auto_survey", dict(size_m=2e-6), {}),
    # 上界的**浮点边界**：1e-7 该落在 highres，不该被一个 ulp 推进 roi
    ("auto_bound_rel_tol", dict(size_m=1.00000000001e-7), {}),

    # ── purpose ────────────────────────────────────────────────────────────
    ("purpose_matches_auto", dict(size_m=1e-7, purpose="highres"), {}),
    ("purpose_forces_other_tier", dict(size_m=5e-8, purpose="survey"), {}),
    ("purpose_unknown", dict(size_m=5e-8, purpose="beautiful"), {}),
    ("purpose_case_insensitive", dict(size_m=5e-8, purpose="  SURVEY "), {}),
    ("purpose_empty_is_auto", dict(size_m=5e-8, purpose=""), {}),
    ("purpose_none_is_auto", dict(size_m=5e-8, purpose=None), {}),

    # ── 意图工作点：**点名**原子档才给，按尺寸碰巧定到不给 ────────────────
    ("intent_atomic_named", dict(size_m=8e-9, purpose="atomic"), {}),
    ("intent_atomic_verify_named", dict(size_m=4e-9, purpose="atomic_verify"), {}),
    ("intent_atomic_by_size_only", dict(size_m=8e-9), {}),
    # 点了名但档名打错 ⇒ 回落到按尺寸，**工作点不给**（purpose_named 为假）
    ("intent_atomic_typo_no_wp", dict(size_m=8e-9, purpose="atomicc"), {}),
    # 显式 bias 盖过意图
    ("intent_beaten_by_explicit_bias",
     dict(size_m=8e-9, purpose="atomic", explicit={"bias_v": 1.0}), {}),
    # 偏好盖过意图（偏好排在意图前面）
    ("intent_beaten_by_prefs_bias",
     dict(size_m=8e-9, purpose="atomic"), dict(prefs={"bias_v": -0.3})),

    # ── explicit 覆盖，逐字段 ──────────────────────────────────────────────
    ("explicit_pixels", dict(size_m=1e-7, explicit={"pixels": 512}), {}),
    ("explicit_pixels_float_truncates", dict(size_m=1e-7, explicit={"pixels": 300.9}), {}),
    ("explicit_line_time", dict(size_m=1e-7, explicit={"line_time_s": 2.5}), {}),
    ("explicit_angle", dict(size_m=1e-7, explicit={"angle_deg": 30.0}), {}),
    ("explicit_angle_zero_is_a_value", dict(size_m=1e-7, explicit={"angle_deg": 0.0}), {}),
    ("explicit_channels", dict(size_m=1e-7, explicit={"channels": "  Z,Current,LIX  "}), {}),
    ("explicit_channels_blank_falls_back",
     dict(size_m=1e-7, explicit={"channels": "   "}), {}),
    ("explicit_setpoint", dict(size_m=1e-7, explicit={"setpoint_a": 3e-11}), {}),
    ("explicit_bias", dict(size_m=1e-7, explicit={"bias_v": -0.5}), {}),
    ("explicit_bias_zero_is_a_value", dict(size_m=1e-7, explicit={"bias_v": 0.0}), {}),
    ("explicit_all", dict(size_m=1e-7, explicit={
        "pixels": 64, "line_time_s": 0.2, "angle_deg": -12.5,
        "channels": "Z", "setpoint_a": 1e-10, "bias_v": 0.05}), {}),

    # ── clamp（参数卫生：修剪 + 声明，不拒绝） ────────────────────────────
    ("clamp_size_too_big", dict(size_m=1e-3), {}),
    ("clamp_size_too_small", dict(size_m=1e-12), {}),
    ("clamp_pixels_low", dict(size_m=1e-7, explicit={"pixels": 4}), {}),
    ("clamp_pixels_high", dict(size_m=1e-7, explicit={"pixels": 999999}), {}),
    ("clamp_line_time_high", dict(size_m=1e-7, explicit={"line_time_s": 1e4}), {}),
    ("clamp_setpoint_low", dict(size_m=1e-7, explicit={"setpoint_a": 1e-15}), {}),
    ("clamp_setpoint_high", dict(size_m=1e-7, explicit={"setpoint_a": 1e-3}), {}),
    ("clamp_bias_high", dict(size_m=1e-7, explicit={"bias_v": 42.0}), {}),
    ("clamp_angle_low", dict(size_m=1e-7, explicit={"angle_deg": -400.0}), {}),
    # 认不出的值 ⇒ `_num` 给 None ⇒ 那个键整个不下发（不是「当 0」）
    ("unparsable_pixels_falls_to_default",
     dict(size_m=1e-7, explicit={"pixels": "many"}), {}),
    ("unparsable_line_time_falls_to_default",
     dict(size_m=1e-7, explicit={"line_time_s": "slow"}), {}),
    ("unparsable_setpoint_is_not_sent",
     dict(size_m=1e-7, explicit={"setpoint_a": "lots"}), {}),
    # ⚠️ 这三格在旧仓是 **TypeError**（`f"{None:.4g}"`），不是「落回默认」——
    # 而每一句注释都说它会落回默认。见 spec/deviations.md 批 4d。
    ("unparsable_angle_falls_to_keep",
     dict(size_m=1e-7, explicit={"angle_deg": "tilted"}), {}),
    ("unparsable_bias_is_not_sent",
     dict(size_m=1e-7, explicit={"bias_v": "high"}), {}),
    ("unparsable_prefs_speed_falls_to_tier",
     dict(size_m=1e-7), dict(prefs={"scan_speed_nm_s": "fast"})),
    ("numeric_string_is_accepted",
     dict(size_m=1e-7, explicit={"line_time_s": "0.25", "pixels": "128"}), {}),

    # ── 偏好（只在「档位表这个字段其实是出厂值」时插得进来） ──────────────
    ("prefs_scan_lines", dict(size_m=1e-7), dict(prefs={"scan_lines": 512})),
    ("prefs_line_time", dict(size_m=1e-7), dict(prefs={"line_time_s": 0.25})),
    ("prefs_speed_derived", dict(size_m=1e-7), dict(prefs={"scan_speed_nm_s": 50.0})),
    ("prefs_line_time_beats_speed", dict(size_m=1e-7),
     dict(prefs={"line_time_s": 0.3, "scan_speed_nm_s": 50.0})),
    ("prefs_angle", dict(size_m=1e-7), dict(prefs={"scan_angle_deg": 15.0})),
    ("prefs_setpoint_pa", dict(size_m=1e-7), dict(prefs={"setpoint_pa": 150.0})),
    ("prefs_bias", dict(size_m=1e-7), dict(prefs={"bias_v": 1.2})),
    ("prefs_all", dict(size_m=1e-7), dict(prefs={
        "scan_lines": 384, "line_time_s": 0.6, "scan_angle_deg": -3.0,
        "setpoint_pa": 80.0, "bias_v": -1.0})),
    ("explicit_beats_prefs",
     dict(size_m=1e-7, explicit={"pixels": 64, "line_time_s": 0.1}),
     dict(prefs={"scan_lines": 512, "line_time_s": 2.0})),
    # 速度为 0 ⇒ 那一支不进（`if pref_speed` 是真值判断）
    ("prefs_speed_zero_skipped", dict(size_m=1e-7), dict(prefs={"scan_speed_nm_s": 0})),

    # ── 操作员档位表：三条 `_tier_source` 支路 ────────────────────────────
    ("operator_tier_fine", dict(size_m=1e-8), dict(tiers_lookup=_OPERATOR)),
    ("operator_tier_wide_line_time_is_factory_filled",
     dict(size_m=1e-6), dict(tiers_lookup=_OPERATOR)),
    # 用户填过的字段**不被偏好盖掉**；回填的那个字段会被盖掉
    ("operator_tier_pixels_beat_prefs", dict(size_m=1e-8),
     dict(tiers_lookup=_OPERATOR, prefs={"scan_lines": 512, "line_time_s": 0.9})),
    ("operator_factory_filled_yields_to_prefs", dict(size_m=1e-6),
     dict(tiers_lookup=_OPERATOR, prefs={"line_time_s": 0.9})),
    ("operator_tier_setpoint_beats_prefs", dict(size_m=1e-8),
     dict(tiers_lookup=_OPERATOR, prefs={"setpoint_pa": 999.0})),

    # ── PI 增益：成对才下发 ────────────────────────────────────────────────
    ("pi_pair_from_operator_tier", dict(size_m=1e-8), dict(tiers_lookup=_OPERATOR)),
    ("pi_half_configured", dict(size_m=1e-9), dict(tiers_lookup=_BROKEN_PI)),
    ("pi_zero_time_constant", dict(size_m=1e-6), dict(tiers_lookup=_BROKEN_PI)),
    ("pi_absent_is_keep_current", dict(size_m=1e-7), {}),

    # ── 针尖横向速度：**组合**约束（三个数单独看都合法） ──────────────────
    ("vtip_exceeded_slows_line_time",
     dict(size_m=1e-6, explicit={"line_time_s": 0.05}), {}),
    ("vtip_exceeded_rewrites_explicit_source",
     dict(size_m=1e-5, explicit={"line_time_s": 0.1}), {}),
    ("vtip_custom_limit", dict(size_m=1e-6), dict(v_tip_max_m_s=1e-7)),
    ("vtip_generous_limit_no_warning",
     dict(size_m=1e-6, explicit={"line_time_s": 0.05}), dict(v_tip_max_m_s=1e-4)),

    # ── 中心坐标 ───────────────────────────────────────────────────────────
    ("center_offset", dict(center_x_m=1.5e-7, center_y_m=-2.5e-7, size_m=1e-7), {}),

    # ── 抛（**不是**修剪）：上游出错的信号 ────────────────────────────────
    ("raise_size_zero", dict(size_m=0.0), {}),
    ("raise_size_negative", dict(size_m=-1e-7), {}),
    ("raise_size_none", dict(size_m=None), {}),
    ("raise_size_nan", dict(size_m=float("nan")), {}),
    ("raise_size_text", dict(size_m="big"), {}),
    ("raise_center_none", dict(center_x_m=None, size_m=1e-7), {}),
    ("raise_center_text", dict(center_y_m="left", size_m=1e-7), {}),
]


def _resolved(res: Any) -> dict:
    return {
        "tier_name": res.tier_name,
        "configure_scan": res.configure_scan,
        "set_scan_buffer": res.set_scan_buffer,
        "set_setpoint": res.set_setpoint,
        "set_bias": res.set_bias,
        "set_zctrl_gain": res.set_zctrl_gain,
        "trace": res.trace,
        "warnings": res.warnings,
        "estimated_scan_s": res.estimated_scan_s,
        "summary": res.summary_lines(),
    }


def main() -> int:
    cases: dict[str, dict] = {}
    for name, ikw, rkw in CASES:
        intent_kwargs = {
            "center_x_m": ikw.get("center_x_m", 0.0),
            "center_y_m": ikw.get("center_y_m", 0.0),
            "size_m": ikw.get("size_m"),
            "purpose": ikw.get("purpose", sr.PURPOSE_AUTO),
            "explicit": dict(ikw.get("explicit") or {}),
        }
        intent = sr.ScanIntent(**intent_kwargs)
        # 查表口默认给**出厂表的一份固定副本**，不走模块级活动表
        kwargs = dict(rkw)
        kwargs.setdefault("tiers_lookup", _FACTORY)
        kwargs.setdefault("prefs", {})
        kwargs.setdefault("v_tip_max_m_s", sr._DEFAULT_V_TIP_MAX)
        record: dict = {
            "intent": {k: v for k, v in intent_kwargs.items()},
            "prefs": kwargs["prefs"],
            "v_tip_max_m_s": kwargs["v_tip_max_m_s"],
            "tiers": ("operator" if kwargs["tiers_lookup"] is _OPERATOR else
                      "broken_pi" if kwargs["tiers_lookup"] is _BROKEN_PI else "factory"),
        }
        # NaN 进不了 `allow_nan=False` 的 JSON，而它是一格真判据（`_num` 判它成 None）
        if record["intent"]["size_m"] != record["intent"]["size_m"]:
            record["intent"]["size_m"] = "<nan>"
        try:
            record["resolved"] = _resolved(sr.resolve_scan(intent, **kwargs))
        except Exception as exc:  # noqa: BLE001 — 抛什么**本身**就是判据
            # `ValueError` 是**规格**（「不替用户发明尺寸」）；`TypeError` 是旧仓
            # 的缺陷（`f"{None:.4g}"`）。分开记，比对那一侧才分得开该照移哪一种。
            record["raised"] = {"type": type(exc).__name__, "text": str(exc)}
        cases[name] = record

    out = {
        "constants": {
            "clamp": {k: list(v) for k, v in sr._CLAMP.items()},
            "default_v_tip_max": sr._DEFAULT_V_TIP_MAX,
            "purpose_auto": sr.PURPOSE_AUTO,
            "atomic_tiers": sorted(sr._ATOMIC_TIERS),
            "atomic_working_point": _atomic_wp(),
            "sources": {
                "explicit": sr.SOURCE_EXPLICIT,
                "tier_operator": sr.SOURCE_TIER_OPERATOR,
                "tier_factory": sr.SOURCE_TIER_FACTORY,
                "prefs": sr.SOURCE_PREFS,
                "prefs_derived": sr.SOURCE_PREFS_DERIVED,
                "default": sr.SOURCE_DEFAULT,
                "keep": sr.SOURCE_KEEP,
                "intent": sr.SOURCE_INTENT,
            },
            "wait_headroom_frac": sp._WAIT_HEADROOM_FRAC,
            "wait_headroom_s": sp._WAIT_HEADROOM_S,
        },
        "operator_tiers": OPERATOR_TIERS,
        "broken_pi_tiers": BROKEN_PI_TIERS,
        "wait_budget": [
            {"estimated_scan_s": est, "floor_s": floor,
             "budget_s": sp.wait_budget_s(est, floor_s=floor)}
            for est, floor in [(0.0, 300.0), (1.0, 300.0), (207.7, 300.0),
                               (1024.0, 300.0), (1024.0, 15.0), (None, 300.0),
                               ("bad", 300.0), (307.2, 60.0)]
        ],
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    kinds: dict[str, int] = {}
    for c in cases.values():
        if "raised" in c:
            k = c["raised"]["type"]
            kinds[k] = kinds.get(k, 0) + 1
    warned = sum(1 for c in cases.values()
                 if c.get("resolved", {}).get("warnings"))
    print(f"[ok]   scan_resolver.json: {len(cases)} 格"
          f"（{', '.join(f'{k}×{n}' for k, n in sorted(kinds.items())) or '无抛'}"
          f"、{warned} 格带 warnings）")
    return 0


def _atomic_wp() -> dict:
    from mast.vision.imaging_window import ATOMIC_WORKING_POINT
    return dict(ATOMIC_WORKING_POINT)


if __name__ == "__main__":
    raise SystemExit(main())
