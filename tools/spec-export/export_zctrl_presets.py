r"""Z 参数组的**解析**与**应用** —— 四路真源，逐格驱动旧仓真实现。

`CreateZCtrlPreset`（批 2 已落）管「存」，这份管「取出来用」：

* `resolve(name)` 的四路 —— `approach`（仪器档案）、`scan`（按当前帧宽选档）、
  档名（扫描档位表）、自定义组。**每一路的拒绝报文都是「去哪儿改」的指路牌**，
  必须逐字。
* `trace_lines()` —— 每个数字说清自己从哪儿来。操作员要能在不读代码的情况下
  回答「这个环为什么是**这个**值」。
* `ApplyZCtrlPreset` —— 走 `SetZCtrlGain` / `SetSetpoint` 两个子技能的正门，
  **一个数字都不经过模型**。录的是子技能调用序列（名字 + 参数）与四种结局。
* `ListZCtrlPresets` —— 每一行的 `usable` 与 `why`。

一个值得先写下来的事实：**出厂档位表里 `p_gain` / `time_constant_s` 全是 `None`**，
所以 `resolve(档名)` 在出厂配置下**恒拒**。那不是「还没接线」，是「没配就该拒」——
一台仪器的 Z 增益不可能有出厂默认值。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_zctrl_presets.py
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
OUT = REPO / "spec" / "golden" / "zctrl_presets.json"

sys.path.insert(0, str(MAST_ROOT))

from mast.core.types import SkillResult  # noqa: E402
import mast.core.instrument_profile as iprof  # noqa: E402
import mast.core.scan_policy as sp  # noqa: E402
import mast.core.zctrl_presets as zp  # noqa: E402
import mast.skills.builtins.zctrl_presets_skills as zs  # noqa: E402


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, float):
        return "NaN" if v != v else v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "item"):
        return _plain(v.item())
    return str(v)


GOOD = {"name": "gentle", "p_gain": "3p", "i_gain": "180n"}
WITH_SP = {"name": "firm", "p_gain": "5p", "i_gain": "200n", "setpoint_a": "150p",
           "note": "带设定点的一组"}


def _set_presets(items: "list[dict]") -> None:
    zp._presets.clear()
    for it in items:
        zp.upsert_preset(dict(it), overwrite=True)


def _set_profile(p: "dict | None") -> None:
    """仪器档案的三个进针键。`None` = 没配（整份 profile 换掉，不留上一格的残留）。"""
    iprof.set_profile(dict(p or {}))


class _FrameCtx:
    """只回 `Scan_FrameGet` 的假 context —— `scan` 别名要的就是当前帧宽。"""

    def __init__(self, width_m: "float | None"):
        self.width = width_m

    def safe_call(self, method: str, *args: Any, **kw: Any):
        class _Rec:
            pass
        r = _Rec()
        r.error = "" if self.width is not None else "模拟故障：读不到帧"
        # (center_x, center_y, width, height, angle)
        r.return_value = (["", b"", [0.0, 0.0, float(self.width or 0.0), 0.0, 0.0]]
                          if self.width is not None else None)
        return r


# ─────────────────────────────────────────────────────────────────────────
# ① resolve 的四路
# ─────────────────────────────────────────────────────────────────────────

RESOLVE: dict[str, Any] = {}


def resolve_case(key: str, name: str, *, presets: "list[dict]", profile: "dict | None",
                 frame_m: "float | None" = None) -> None:
    _set_presets(presets)
    _set_profile(profile)
    ctx = _FrameCtx(frame_m) if frame_m is not None else None
    row: dict[str, Any] = {
        "name": name,
        "frame_size_m": frame_m,
        "has_profile": profile is not None,
        "preset_names": [p["name"] for p in presets],
    }
    try:
        r = zp.resolve(name, context=ctx)
        row.update({
            "ok": True,
            "resolved_name": r.name,
            "p_gain": r.p_gain,
            "i_gain": r.i_gain,
            "time_constant_s": r.time_constant_s,
            "setpoint_a": r.setpoint_a,
            "sources": _plain(r.sources),
            "notes": _plain(r.notes),
            "trace_lines": r.trace_lines(),
            "gain_params": _plain(r.gain_params()),
            "error": "",
        })
    except zp.PresetRejected as exc:
        row.update({"ok": False, "error": str(exc)})
    RESOLVE[key] = row


PROFILE = {"approach_p_gain_m": 3e-12, "approach_i_gain_m_per_s": 180e-9,
           "approach_setpoint_a": 50e-12}
PROFILE_NO_SP = {"approach_p_gain_m": 3e-12, "approach_i_gain_m_per_s": 180e-9}
PROFILE_HALF = {"approach_p_gain_m": 3e-12}

resolve_case("custom", "gentle", presets=[GOOD], profile=None)
resolve_case("custom_case_insensitive", "GENTLE", presets=[GOOD], profile=None)
resolve_case("custom_with_setpoint_and_note", "firm", presets=[GOOD, WITH_SP], profile=None)
resolve_case("approach_configured", "approach", presets=[], profile=PROFILE)
resolve_case("approach_no_setpoint", "approach", presets=[], profile=PROFILE_NO_SP)
resolve_case("approach_half_configured", "approach", presets=[], profile=PROFILE_HALF)
resolve_case("approach_missing", "approach", presets=[], profile=None)
# `scan`：出厂档位表没有增益 ⇒ 选得中档，也解析不出来
resolve_case("scan_frame_50nm", "scan", presets=[], profile=None, frame_m=50e-9)
resolve_case("scan_frame_2um", "scan", presets=[], profile=None, frame_m=2e-6)
resolve_case("scan_no_frame", "scan", presets=[], profile=None)
# 档名直取
resolve_case("tier_by_name", "highres", presets=[], profile=None)
resolve_case("tier_by_name_case", "SURVEY", presets=[], profile=None)
# 不认识
resolve_case("unknown", "nope", presets=[GOOD], profile=None)
resolve_case("empty_name", "", presets=[GOOD], profile=None)
resolve_case("blank_name", "   ", presets=[GOOD], profile=None)


# ─────────────────────────────────────────────────────────────────────────
# ② available_names
# ─────────────────────────────────────────────────────────────────────────

_set_presets([GOOD, WITH_SP])
AVAILABLE = {
    "with_two_customs": list(zp.available_names()),
}
_set_presets([])
AVAILABLE["empty"] = list(zp.available_names())


# ─────────────────────────────────────────────────────────────────────────
# ③ ApplyZCtrlPreset
# ─────────────────────────────────────────────────────────────────────────

APPLY: dict[str, Any] = {}


class _RunCtx:
    """脚本化子技能分派。`ApplyZCtrlPreset` 一次裸动词都不发（除了 `scan` 要读帧）。"""

    def __init__(self, fail: "dict[str, str] | None" = None, width_m: "float | None" = None):
        self.runs: list[dict] = []
        self.fail = fail or {}
        self.width = width_m

    def run(self, skill_name: str, params: dict, **kw: Any) -> SkillResult:
        self.runs.append({"skill": skill_name, "params": _plain(params)})
        err = self.fail.get(skill_name)
        if err:
            return SkillResult(skill_name=skill_name, success=False, error=err)
        return SkillResult(skill_name=skill_name, success=True, data={})

    def safe_call(self, method: str, *args: Any, **kw: Any):
        return _FrameCtx(self.width).safe_call(method, *args, **kw)


def apply_case(key: str, preset: str, *, presets: "list[dict]", profile: "dict | None" = None,
               fail: "dict[str, str] | None" = None, frame_m: "float | None" = None) -> None:
    _set_presets(presets)
    _set_profile(profile)
    ctx = _RunCtx(fail, frame_m)
    r = zs.ApplyZCtrlPreset().execute(ctx, {"preset": preset})
    APPLY[key] = {
        "preset": preset,
        "runs": ctx.runs,
        "success": bool(r.success),
        "error": r.error or "",
        "data": _plain(r.data or {}),
    }


apply_case("custom_no_setpoint", "gentle", presets=[GOOD])
apply_case("custom_with_setpoint", "firm", presets=[GOOD, WITH_SP])
apply_case("approach", "approach", presets=[], profile=PROFILE)
apply_case("gain_write_fails", "firm", presets=[WITH_SP],
           fail={"SetZCtrlGain": "模拟故障：写后回读不一致"})
apply_case("setpoint_write_fails", "firm", presets=[WITH_SP],
           fail={"SetSetpoint": "模拟故障：写后回读不一致"})
apply_case("unknown_name", "nope", presets=[GOOD])
apply_case("tier_without_gains", "highres", presets=[])
apply_case("scan_without_frame", "scan", presets=[])


# ─────────────────────────────────────────────────────────────────────────
# ④ ListZCtrlPresets
# ─────────────────────────────────────────────────────────────────────────

LIST: dict[str, Any] = {}


def list_case(key: str, *, presets: "list[dict]", profile: "dict | None") -> None:
    _set_presets(presets)
    _set_profile(profile)
    r = zs.ListZCtrlPresets().execute(None, {})
    LIST[key] = {"success": bool(r.success), "data": _plain(r.data or {})}


list_case("no_profile_two_customs", presets=[GOOD, WITH_SP], profile=None)
list_case("profile_configured", presets=[], profile=PROFILE)

_set_presets([])
_set_profile(None)


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_zctrl_presets.py 生成——"
                 "驱动旧仓真实的 zctrl_presets.resolve 与三件套技能。",
        "constants": {
            "source_tier_operator": zp.SOURCE_TIER_OPERATOR,
            "source_tier_factory": zp.SOURCE_TIER_FACTORY,
            "tier_names": sp.tier_names(),
            "factory_tier_gains": [
                {"name": t["name"], "p_gain": t.get("p_gain"),
                 "time_constant_s": t.get("time_constant_s"),
                 "setpoint_a": t.get("setpoint_a")}
                for t in sp.get_policy()
            ],
        },
        "resolve": RESOLVE,
        "available_names": AVAILABLE,
        "apply": APPLY,
        "list": LIST,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(RESOLVE)} 格解析 · "
          f"{len(APPLY)} 格应用 · {len(LIST)} 格清单")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
