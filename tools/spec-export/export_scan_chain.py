r"""扫描主链 —— `ConfigureScan` 与 `StartScan` 的判定件与端到端网格。

这两个技能各卡着一批**纯判据**，它们都是从真机事故里长出来的：

| 件 | 事故 |
|---|---|
| `resolve_line_time` + 档位表 | 三份实现里两份把 0.1 s 当默认，而 0.1 s 在 50 nm 图上是 488 nm/s，2026-08-12 刮坏了针尖 |
| `frame_readback_mismatch` | **回声不是读数**：仪器把框夹到量程内，上层完全看不出来，此后每张图的坐标都是假的 |
| `frame_exceeds` + `piezo_half_range_m` | 2026-08-28：2 µm 的框有一小半在量程外，溢出的 39 列里相邻列差从 119 pm 掉到 43 pm——**那 15 % 不是数据**，而图看着完全正常 |
| `_scan_props_modules` | 找错了层 ⇒ 兜底一直在生效 ⇒ 写死的 5 个名字**每一次扫描**都覆盖掉用户在 GUI 里配的清单 |
| `_continuous_state` | 2026-08-19：解析崩掉 ⇒ `None == 1` 为假 ⇒ 报「continuous 已关」，而那一帧的 wait 恰恰是 `restarted` |

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_scan_chain.py
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
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "scan_chain.json"

import time as _time

_CLOCK = [1_000_000.0]
_time.sleep = (lambda s: _CLOCK.__setitem__(0, _CLOCK[0] + max(float(s), 0.0)))  # type: ignore[assignment]
_time.monotonic = (lambda: _CLOCK[0])   # type: ignore[assignment]
_time.time = (lambda: 1_700_000_000.0)  # type: ignore[assignment]

sys.path.insert(0, str(MAST_ROOT))

from mast.core.types import NanonisCallRecord, SkillResult  # noqa: E402
import mast.core.scan_policy as sp  # noqa: E402
import mast.skills.builtins.imaging as im  # noqa: E402


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v in (float("inf"), float("-inf")):
            return "Infinity" if v > 0 else "-Infinity"
        return v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "item"):
        return _plain(v.item())
    return str(v)


def _env(body: Any) -> tuple:
    return ("", b"", body)


# ─────────────────────────────────────────────────────────────────────────
# ① 档位表与 resolve_line_time
# ─────────────────────────────────────────────────────────────────────────

TIERS = [_plain(t) for t in sp.get_policy()]

TIER_FOR_SIZE = {}
for nm_size in [0.5, 1.0, 2.0, 2.001, 3.0, 5.0, 5.001, 8.0, 10.0, 10.001,
                50.0, 100.0, 100.001, 250.0, 500.0, 500.001, 1000.0, 2000.0,
                0.0, -1.0]:
    m = nm_size * 1e-9
    TIER_FOR_SIZE[f"{nm_size}nm"] = {
        "size_m": m, "tier": _plain(sp.get_tier_for_size(m).get("name")),
        "line_time_s": _plain(sp.get_tier_for_size(m).get("line_time_s")),
        "pixels": _plain(sp.get_tier_for_size(m).get("pixels")),
    }

RESOLVE_LINE_TIME = {}
for name, explicit, size in [
        ("explicit", 0.25, 50e-9),
        ("explicit_zero_falls_back", 0.0, 50e-9),
        ("explicit_negative_falls_back", -1.0, 50e-9),
        ("explicit_garbage_falls_back", "nope", 50e-9),
        ("tier_atomic", None, 8e-9),
        ("tier_highres", None, 50e-9),
        ("tier_roi", None, 300e-9),
        ("tier_survey", None, 2e-6),
        ("tier_slow", None, 1e-9),
        ("tier_atomic_verify", None, 4e-9),
        ("boundary_2nm_is_slow", None, 2e-9),
        ("boundary_100nm_is_highres", None, 100e-9),
        ("size_zero", None, 0.0),
        ("size_none", None, None),
]:
    v, src = sp.resolve_line_time(explicit, size)
    RESOLVE_LINE_TIME[name] = {"explicit": _plain(explicit), "size_m": _plain(size),
                               "line_time_s": v, "source": src}

ESTIMATE = {f"{px}px@{lt}s": sp.estimate_scan_seconds(px, lt)
            for px, lt in [(256, 1.0), (512, 1.75), (256, 0.5), (0, 1.0), (256, 0)]}


# ─────────────────────────────────────────────────────────────────────────
# ② 扫描框的四个判定件
# ─────────────────────────────────────────────────────────────────────────

EXTENT = {}
for name, args in [
        ("axis_aligned", (0.0, 0.0, 100e-9, 100e-9, 0.0)),
        ("offset", (50e-9, -30e-9, 100e-9, 40e-9, 0.0)),
        ("rot45", (0.0, 0.0, 100e-9, 100e-9, 45.0)),
        ("rot90", (0.0, 0.0, 100e-9, 40e-9, 90.0)),
        ("rot30_offset", (10e-9, 20e-9, 80e-9, 60e-9, 30.0)),
        ("negative_angle", (0.0, 0.0, 100e-9, 100e-9, -45.0)),
        ("angle_none", (0.0, 0.0, 100e-9, 100e-9, None)),
]:
    EXTENT[name] = {"input": _plain(list(args)),
                    "extent": _plain(list(im.frame_extent(*args)))}

HALF_RANGE = {}
for name, args in [
        ("calib_only", (1.3345e-7, None, None, False)),
        ("limits_off_ignored", (1.3345e-7, -3.0, 3.0, False)),
        ("limits_on_narrows", (1.3345e-7, -3.0, 3.0, True)),
        ("limits_on_asymmetric", (1.3345e-7, -2.0, 8.0, True)),
        ("limits_on_wider_than_dac", (1.3345e-7, -50.0, 50.0, True)),
        ("negative_calib", (-1.3345e-7, None, None, False)),
        ("calib_none", (None, None, None, False)),
        ("limits_on_but_missing", (1.3345e-7, None, 3.0, True)),
]:
    HALF_RANGE[name] = {"input": _plain(list(args)),
                        "half_m": _plain(im.piezo_half_range_m(*args))}

HALF = 1.3345e-6   # 半程 ±1334.5 nm（本机实测的 calibration × 10 V）
EXCEEDS = {}
for name, args in [
        ("inside", (0.0, 0.0, 100e-9, 100e-9, 0.0, HALF, HALF)),
        # 2026-08-28 真机那一帧：中心 (639, −597) nm、边长 2 µm
        ("rig_20260828", (639e-9, -597e-9, 2e-6, 2e-6, 0.0, HALF, HALF)),
        ("x_high_only", (1.3e-6, 0.0, 100e-9, 100e-9, 0.0, HALF, HALF)),
        ("x_low_only", (-1.3e-6, 0.0, 100e-9, 100e-9, 0.0, HALF, HALF)),
        ("y_both", (0.0, 0.0, 100e-9, 3e-6, 0.0, HALF, HALF)),
        ("rot45_pushes_out", (1.25e-6, 0.0, 200e-9, 200e-9, 45.0, HALF, HALF)),
        ("axis_aligned_just_fits", (1.28e-6, 0.0, 100e-9, 100e-9, 0.0, HALF, HALF)),
        ("half_unknown", (0.0, 0.0, 5e-6, 5e-6, 0.0, None, HALF)),
        ("exactly_at_edge", (HALF - 50e-9, 0.0, 100e-9, 100e-9, 0.0, HALF, HALF)),
]:
    EXCEEDS[name] = {"input": _plain(list(args)),
                     "over": _plain(im.frame_exceeds(*args))}

REQ = (0.0, 0.0, 100e-9, 100e-9, 0.0)
MISMATCH = {}
for name, req, got in [
        ("exact", REQ, [0.0, 0.0, 100e-9, 100e-9, 0.0]),
        ("within_tolerance", REQ, [1e-13, 0.0, 100e-9 * (1 + 1e-4), 100e-9, 0.02]),
        ("width_clamped", REQ, [0.0, 0.0, 80e-9, 100e-9, 0.0]),
        ("center_clamped", (639e-9, -597e-9, 2e-6, 2e-6, 0.0),
         [500e-9, -597e-9, 2e-6, 2e-6, 0.0]),
        ("angle_changed", REQ, [0.0, 0.0, 100e-9, 100e-9, 1.0]),
        ("angle_within_tol", REQ, [0.0, 0.0, 100e-9, 100e-9, 0.04]),
        ("unreadable_none", REQ, None),
        ("unreadable_short", REQ, [0.0, 0.0, 100e-9]),
        ("unreadable_nan", REQ, [float("nan"), 0.0, 100e-9, 100e-9, 0.0]),
        ("unreadable_garbage", REQ, ["x", 0.0, 100e-9, 100e-9, 0.0]),
        ("all_five_differ", REQ, [1e-9, 1e-9, 50e-9, 50e-9, 30.0]),
]:
    MISMATCH[name] = {"requested": _plain(list(req)), "readback": _plain(got),
                      "mismatch": _plain(im.frame_readback_mismatch(req, got))}

SIGNALS = ["Current (A)", "Z (m)", "Bias (V)", "LI Demod 1 X (A)", "LI Demod 1 Y (A)",
           "Z", "Amplitude (m)"]
MATCH_SIGNAL = {q: im._match_signal(q, SIGNALS) for q in
                ["Z", "Current", "Bias", "LI Demod 1 X", "z", "current",
                 "Cur", "Z (m)", "Nope", "", "  Z  ", "Amplitude"]}


# ─────────────────────────────────────────────────────────────────────────
# ③ Scan_PropsGet 的五个解析器
# ─────────────────────────────────────────────────────────────────────────

def _props_body_full(series="Au111", modules=("Bias", "Z-Controller"),
                     continuous=0, count=None):
    """16 字段的完整回包 body。索引 4=序列名、8=模块数、9=模块名数组。"""
    body: list[Any] = [0] * 16
    body[0] = continuous
    body[4] = series
    body[8] = len(modules) if count is None else count
    body[9] = list(modules)
    return body


PROPS = {}
for name, parsed in [
        ("full_off", _env(_props_body_full(continuous=0))),
        ("full_on", _env(_props_body_full(continuous=1))),
        ("set_encoding_2_is_unknown", _env(_props_body_full(continuous=2))),
        ("continuous_tuple", _env(_props_body_full(continuous=(1,)))),
        ("zero_modules", _env(_props_body_full(modules=()))),
        ("count_disagrees", _env(_props_body_full(modules=("A", "B"), count=3))),
        ("short_body_heuristic", _env([0, ["Bias", "Z-Controller"], "Au111"])),
        ("no_string_array", _env([0, 1, 2, 3])),
        ("body_not_a_list", _env(7)),
        ("not_an_envelope", [1, 2]),
        ("none", None),
        ("empty_body", _env([])),
]:
    # body 也录进去 —— 信封在 nanonis-wire 那层已拆（D-SKILL-1）。让 TS 侧照着
    # `input` 猜「像不像信封」，`not_an_envelope` 那一格两边喂的就不是同一个值。
    # 不是信封 ⇒ **没有 body**。本仓的线协议层要么给出 body，要么什么都没有；
    # 「把整个回包当 body」是旧仓 `_props_body` 在检查信封形状，那一层我们没有。
    _body = parsed[2] if isinstance(parsed, tuple) and len(parsed) == 3 else None
    PROPS[name] = {
        "input": _plain(parsed),
        "body": _plain(_body),
        "continuous_flag": _plain(im._scan_props_continuous(parsed)),
        "continuous_state": _plain(im._continuous_state(im._scan_props_continuous(parsed))),
        "modules": _plain(im._scan_props_modules(parsed)),
        "module_count": _plain(im._scan_props_module_count(parsed)),
        "series_name": _plain(im._scan_props_series_name(parsed)),
    }

# ⚠️ 键用 `repr` 不用 `str`：`str(0)` 与 `str("0")` 都是 `"0"`，后者会把前者
# 覆盖掉——于是金样里 `0` 那一格记的其实是字符串 `"0"` 的答案（None），
# 而整数 0 的答案（False）**消失了**。一次键碰撞把一格判据换成了另一格。
CONTINUOUS_STATE = {repr(f): _plain(im._continuous_state(f))
                    for f in [0, 1, 2, -1, None, True, False, "0", 1.0]}

UNWRAP = {}
for name, v in [("scalar", 7), ("one_tuple", (7,)), ("one_list", [7]),
                ("two_tuple", (7, 8)), ("empty", ()), ("float", 1.5),
                ("none", None), ("string", "x")]:
    UNWRAP[name] = {"input": _plain(v), "out": _plain(im._unwrap_scalar(v))}


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_scan_chain.py 生成——驱动旧仓真实"
                 " scan_policy / imaging 判定件录得，不要手改。",
        "constants": {
            "frame_tol_frac": im._FRAME_TOL_FRAC,
            "frame_tol_abs_m": im._FRAME_TOL_ABS_M,
            "frame_tol_deg": im._FRAME_TOL_DEG,
            "bound_rel_tol": sp._BOUND_REL_TOL,
            "props_get_attempts": im._PROPS_GET_ATTEMPTS,
            "props_n_fields": im._PROPS_N_FIELDS,
            "props_ix_series_name": im._PROPS_IX_SERIES_NAME,
            "props_ix_modules_count": im._PROPS_IX_MODULES_COUNT,
            "props_ix_modules": im._PROPS_IX_MODULES,
            "set_no_change": im._SET_NO_CHANGE,
            "set_off": im._SET_OFF,
            "set_autosave_all": im._SET_AUTOSAVE_ALL,
            "get_on": im._GET_ON,
            "get_off": im._GET_OFF,
        },
        "tiers": TIERS,
        "tier_for_size": TIER_FOR_SIZE,
        "resolve_line_time": RESOLVE_LINE_TIME,
        "estimate_scan_seconds": _plain(ESTIMATE),
        "frame_extent": EXTENT,
        "piezo_half_range": HALF_RANGE,
        "frame_exceeds": EXCEEDS,
        "frame_readback_mismatch": MISMATCH,
        "match_signal": {"signals": SIGNALS, "cases": _plain(MATCH_SIGNAL)},
        "scan_props": PROPS,
        "continuous_state": CONTINUOUS_STATE,
        "unwrap_scalar": UNWRAP,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(TIERS)} 档 · "
          f"{len(RESOLVE_LINE_TIME)} 格线时间 · {len(EXCEEDS)} 格越界 · "
          f"{len(MISMATCH)} 格回读 · {len(PROPS)} 格属性回包")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
