r"""进针升级的逃逸闸。

失败形状：`ApproachTip` 拒绝升级到粗进针后，agent 又直接调用
`AutoApproach`。而 `AutoApproach` 正是它刚拒绝的那个粗进针，直接调用等于绕过一个
刚刚做出的安全判断。

闸本身很小（一个带 TTL 的进程级闩），但它有两条**不对称**的规矩：

* 拒绝是**进程全局**的——一根针、一块样品，一次拒绝必须挡住每一条链；
* 清除**按链计**：一条链上的成功 engage 不能清除另一条链刚记录的拒绝，否则会
  **把那道侧门重新打开**。

    python \
        tools/spec-export/export_approach_gate.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "approach_gate.json"

import time as _time

_CLOCK = [1_000_000.0]
_time.monotonic = (lambda: _CLOCK[0])  # type: ignore[assignment]

sys.path.insert(0, str(MAST_ROOT))

import mast.core.safety_escalation as esc  # noqa: E402


def _snap() -> Any:
    r = esc.active_approach_refusal()
    if r is None:
        return None
    return {"reason": r.reason, "source": r.source, "owner": r.owner,
            "ttl_s": r.ttl_s, "age_s": round(r.age_s(), 3), "expired": r.expired()}


CASES: dict[str, Any] = {}


def case(name: str, script: list[tuple]) -> None:
    """script 里每一项是 `(动作, 参数…)`，逐步录下闩的状态。"""
    esc._refusal = None
    _CLOCK[0] = 1_000_000.0
    steps: list[dict[str, Any]] = []
    for item in script:
        op, args = item[0], item[1:]
        out: Any = None
        if op == "record":
            reason, kw = args[0], (args[1] if len(args) > 1 else {})
            esc.record_approach_refusal(reason, **kw)
        elif op == "clear":
            why, kw = args[0], (args[1] if len(args) > 1 else {})
            out = esc.clear_approach_refusal(why, **kw)
        elif op == "tick":
            _CLOCK[0] += float(args[0])
        elif op == "active":
            out = _snap()
        steps.append({"op": op, "args": [str(a) for a in args],
                      "returned": out, "state": _snap()})
    CASES[name] = steps


OWNER_A = "group#run-1"
OWNER_B = "chat#run-2"

case("record_then_active", [
    ("record", "Z 反馈开关读不出", {"owner": OWNER_A}),
    ("active",),
])
# TTL：拒绝不该活得比它描述的硬件状态更久
case("expires_after_ttl", [
    ("record", "读不到设定点", {"owner": OWNER_A}),
    ("tick", 599.0), ("active",),
    ("tick", 2.0), ("active",),
])
# 覆盖：最新的判决才是活的那个
case("record_overwrites", [
    ("record", "第一次的理由", {"owner": OWNER_A}),
    ("record", "第二次的理由", {"owner": OWNER_B}),
    ("active",),
])
# **同一条链**可以清掉自己记的
case("same_owner_clears", [
    ("record", "理由", {"owner": OWNER_A}),
    ("clear", "ApproachTip 升级了", {"owner": OWNER_A}),
    ("active",),
])
# ⚠️ **另一条链清不掉** —— 2026-07-28 致命一(c)
case("other_owner_cannot_clear", [
    ("record", "理由", {"owner": OWNER_A}),
    ("clear", "私聊里 engage 成功了", {"owner": OWNER_B}),
    ("active",),
])
# 没有 owner 的拒绝（老行为）谁都能清
case("unscoped_cleared_by_anyone", [
    ("record", "理由", {}),
    ("clear", "别的链", {"owner": OWNER_B}),
    ("active",),
])
# owner=None 是管理员覆盖：无条件
case("admin_override_clears", [
    ("record", "理由", {"owner": OWNER_A}),
    ("clear", "管理员", {"owner": None}),
    ("active",),
])
case("clear_when_empty_is_idempotent", [
    ("clear", "没有可清的", {"owner": OWNER_A}),
    ("active",),
])
case("expired_then_cleared_is_false", [
    ("record", "理由", {"owner": OWNER_A}),
    ("tick", 601.0),
    ("active",),           # 读的时候顺手丢掉
    ("clear", "已经没了", {"owner": OWNER_A}),
])
# 重新记会重置计时
case("record_resets_age", [
    ("record", "第一次", {"owner": OWNER_A}),
    ("tick", 500.0),
    ("record", "第二次", {"owner": OWNER_A}),
    ("tick", 200.0), ("active",),
])
case("blank_reason_gets_placeholder", [
    ("record", "   ", {"owner": OWNER_A}),
    ("active",),
])
case("custom_ttl", [
    ("record", "理由", {"owner": OWNER_A, "ttl_s": 10.0}),
    ("tick", 11.0), ("active",),
])

ESCALATION = {n: esc.is_approach_escalation(n) for n in
              ["AutoApproach", "ApproachTip", "MotorMove", "TryEngageController",
               "WithdrawTip", "", "autoapproach"]}


def _refusal_text(source: str, age_s: float, reason: str) -> str:
    """中间件拦下直接调用时那句话 —— 逐字从 `safety_mw.py` 抄的形状。"""
    return (
        "[safety_gate] approach_escalation_refused: "
        f"{source} 在 {age_s:.0f} 秒前拒绝了粗进针"
        f"升级，理由：{reason}。AutoApproach 就是它拒绝的那个"
        "粗进针，直接调用等于绕过刚做出的安全判断。Do NOT retry "
        "AutoApproach. 出路有三条：(1) 重新调用 ApproachTip —— 它会"
        "重新核验 Z 反馈状态，若确实需要粗进针会自己升级，本拦截随即"
        "解除；(2) 先修好拒绝理由里说的那个状态（如 Z 反馈开关读不出"
        "/ 关不掉）再走 ApproachTip；(3) 交给用户在 GUI 手动进针。"
    )


REFUSAL_TEXT = {
    "typical": _refusal_text("ApproachTip", 133.0, "Z 反馈开关读不出"),
    "zero_age": _refusal_text("ApproachTip", 0.0, "理由"),
    "no_reason": _refusal_text("ApproachTip", 12.4, "(no reason recorded)"),
}


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_approach_gate.py 生成——"
                 "驱动旧仓真实 safety_escalation 录得，不要手改。",
        "constants": {
            "ttl_s": esc.APPROACH_REFUSAL_TTL_S,
            "escalation_skills": sorted(esc._ESCALATION_SKILLS),
            "no_reason_placeholder": "(no reason recorded)",
        },
        "is_escalation": ESCALATION,
        "refusal_text": REFUSAL_TEXT,
        "cases": CASES,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(CASES)} 格闩 · "
          f"{len(ESCALATION)} 格升级判定 · {len(REFUSAL_TEXT)} 格文案")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
