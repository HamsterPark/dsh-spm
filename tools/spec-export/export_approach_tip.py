r"""把 `ApproachTip` **真的分派一遍** —— 两相、三个记拒绝的点、一次最后复核。

它是本仓第一个 **L2** 技能：自己不发裸动词，只调别的技能。所以脚本化的是
`context.run(技能名, 参数)` 的返回，而不是回包。

录：走了哪一相、逃逸闸被记还是被清、最后那句话逐字、以及**复核用的读数序列**——
最后那一处曾经也是单次瞬时读数（2026-08-05），它就长在 `AutoApproach` 里那处的
下游，于是真机上一次成功的进针可能被同一个瞬态判死两遍。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_approach_tip.py
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
OUT = REPO / "spec" / "golden" / "approach_tip.json"

import time as _time

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

sys.path.insert(0, str(MAST_ROOT))

from mast.core.types import SkillResult  # noqa: E402
import mast.core.safety_escalation as esc  # noqa: E402
import mast.skills.builtins.approach as ap  # noqa: E402


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
        return v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "item"):
        return _plain(v.item())
    return str(v)


SP = 50e-12
ON = 46.6e-12
OFF = 0.04e-12


class _ScriptCtx:
    """脚本化的 ExecutionContext。**只有 `run`**——L2 技能不发裸动词。"""

    def __init__(self, *, engage: dict[str, Any] | None = None,
                 auto: dict[str, Any] | None = None,
                 current: list[Any] | None = None,
                 setpoint: Any = SP,
                 aborts: list[bool] | None = None,
                 owner: str = "group", run_id: str = "R1") -> None:
        self._engage = engage or {}
        self._auto = auto or {"success": True, "data": {}}
        self._current = list(current if current is not None else [ON])
        self._setpoint = setpoint
        self._aborts = list(aborts or [])
        self.owner = owner
        self.run_id = run_id
        self.runs: list[dict[str, Any]] = []

    @staticmethod
    def _next(seq: list[Any]) -> Any:
        return seq.pop(0) if len(seq) > 1 else (seq[0] if seq else None)

    def run(self, skill_name: str, params: dict, version: Any = None) -> SkillResult:
        self.runs.append({"skill": skill_name, "params": _plain(params)})
        if skill_name == "TryEngageController":
            spec = self._engage
        elif skill_name == "AutoApproach":
            spec = self._auto
        elif skill_name == "GetCurrent":
            v = self._next(self._current)
            spec = ({"success": False, "error": "读电流失败"} if v is None
                    else {"success": True, "data": {"current_a": v}})
        elif skill_name == "GetSetpoint":
            spec = ({"success": False, "error": "读设定点失败"} if self._setpoint is None
                    else {"success": True, "data": {"setpoint_a": self._setpoint}})
        else:
            spec = {"success": True, "data": {}}
        return SkillResult(skill_name=skill_name, success=bool(spec.get("success", True)),
                           data=dict(spec.get("data") or {}),
                           error=str(spec.get("error") or ""))

    def check_abort(self) -> bool:
        return bool(self._aborts.pop(0)) if self._aborts else False


CASES: dict[str, Any] = {}


def case(name: str, *, params: dict[str, Any] | None = None,
         prior_refusal: dict[str, Any] | None = None,
         engage_budget_s: float = 4.0, engage_interval_s: float = 1.0,
         **ctx_kw: Any) -> None:
    esc._refusal = None
    _CLOCK[0] = 1_000_000.0
    if prior_refusal is not None:
        esc.record_approach_refusal(**prior_refusal)
    ctx = _ScriptCtx(**ctx_kw)
    skill = ap.ApproachTip()
    skill._engage_budget_s = engage_budget_s
    skill._engage_interval_s = engage_interval_s
    # dI/dV 标定窗要 lock-in 链路；本仓不移植（D-APPROACH-3），关掉免得污染动词序列。
    skill._didv_settle_s = 0.0
    res = skill._approach(ctx, dict(params or {}))
    r = esc.active_approach_refusal()
    CASES[name] = {
        "params": _plain(params or {}),
        "success": res.success,
        "error": res.error or "",
        "data": _plain(dict(res.data or {})),
        "runs": ctx.runs,
        "refusal_after": (None if r is None else
                          {"reason": r.reason, "source": r.source, "owner": r.owner}),
    }


ENG_OK = {"success": True, "data": {"engaged": True, "peak_current_a": ON,
                                    "setpoint_a": SP}}
ENG_NEEDS = {"success": True, "data": {"engaged": False, "needs_auto_approach": True,
                                       "setpoint_a": SP}}
ENG_MAYBE = {"success": True, "data": {"engaged": False, "needs_auto_approach": False}}
ENG_FAIL = {"success": False, "error": "Z 反馈开关读不出"}
SCOPE = "group#R1"

# ── 第一相就进成 ────────────────────────────────────────────────────────
case("engaged_via_feedback", engage=ENG_OK)
# 第一相就进成，而且**清掉**了本链更早的拒绝
case("engage_clears_own_refusal", engage=ENG_OK,
     prior_refusal={"reason": "上一次的拒绝", "owner": SCOPE})
# ⚠️ 别的链记的拒绝**清不掉**（2026-07-28 致命一(c)）
case("engage_cannot_clear_other_chain", engage=ENG_OK,
     prior_refusal={"reason": "群跑记的", "owner": "chat#R9"})

# ── 第一相失败 / 自相矛盾 ⇒ 记拒绝 ─────────────────────────────────────
case("engage_phase_fails", engage=ENG_FAIL)
case("no_tunnel_no_flag", engage=ENG_MAYBE)

# ── 升级到粗进针 ───────────────────────────────────────────────────────
case("escalates_and_verifies", engage=ENG_NEEDS, current=[ON])
case("escalation_clears_prior_refusal", engage=ENG_NEEDS, current=[ON],
     prior_refusal={"reason": "上一次的拒绝", "owner": SCOPE})
case("auto_approach_fails", engage=ENG_NEEDS,
     auto={"success": False, "error": "AutoApproach 模块已停止,且电流稳定地没有达到进针判据"})
# 粗进针报成功，但**自己测**测出来没进针（#42 那一族）
case("verify_below_bar", engage=ENG_NEEDS, current=[OFF])
# 读数一直在跳 ⇒ 判不出
case("verify_never_settles", engage=ENG_NEEDS, current=[ON, OFF] * 12)
case("verify_current_unreadable", engage=ENG_NEEDS, current=[None])
case("verify_setpoint_unreadable", engage=ENG_NEEDS, current=[ON], setpoint=None)
case("verify_aborted", engage=ENG_NEEDS, current=[ON], aborts=[True])
# 噪声底：粗进针「成功」，电流 0.4 pA 对 0.5 pA 设定点 —— 仍然不算（#75）
case("verify_noise_floor", engage=ENG_NEEDS, current=[0.4e-12], setpoint=0.5e-12)
# settle_s 透传给第一相
case("settle_s_passes_through", params={"settle_s": 3.0}, engage=ENG_OK)


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_approach_tip.py 生成——驱动旧仓真实"
                 " ApproachTip._approach 录得，不要手改。",
        "constants": {"default_settle_s": 1.5},
        "cases": CASES,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(CASES)} 个分派用例")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
