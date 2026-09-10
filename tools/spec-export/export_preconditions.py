"""把前置条件的词表与判定录成金样。

驱动的是**旧仓真实实现** `mast/core/preconditions.py`。这一段的措辞比判定还要紧：
违反消息是模型读的东西，而 2026-08-10 真机上那句
`Precondition 'z_controller_on' not met: state.z_controller_on is False`
**把六种情况说成了一种**，三个人先后推断出三个不同的凶手——而机器当时就知道
它到底是 Hold 还是 SafeTip 还是真的 Off。所以伴随字段的措辞逐字录。

    python \\
        tools/spec-export/export_preconditions.py

**夹具网格**：每个前置名 × 每种相关状态 = 一格，逐格录。判定表是子串匹配，
而子串在**否定形式**上尤其危险（`"on"` 是 `"z_controller_off"` 的子串），
所以必须整片网格都对，不能只挑几个点。
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
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "preconditions.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import preconditions as pc  # noqa: E402
from mast.core.types import HardwareState  # noqa: E402

#: 网格的一维：前置条件名。含精确表、子串兜底、以及不认识的。
NAMES = [
    "z_controller_on",
    "z_controller_off",
    "scan_running",
    "scan_stopped",
    "scan_not_running",
    "bias_nonzero",
    "tip_withdrawn",
    "tip_clear",
    "完全不认识的前置",
    # 大小写与前后空白：模型会写出各种形状
    "Z_Controller_On",
]

#: 另一维：硬件状态夹具。**含「读不到」（None）那一格**——它是 fail-open 的关键。
FIXTURES: dict[str, dict] = {
    "zctrl_on": {"z_controller_on": True, "z_controller_status": "On"},
    "zctrl_off": {"z_controller_on": False, "z_controller_status": "Off"},
    # 下面四格是同一个布尔 False，但**意思完全不同**——2026-08-10 的教训就在这里
    "zctrl_hold": {"z_controller_on": False, "z_controller_status": "Hold"},
    "zctrl_switching_off": {"z_controller_on": False, "z_controller_status": "SwitchingOff"},
    "zctrl_safetip": {"z_controller_on": False, "z_controller_status": "SafeTip"},
    "zctrl_withdrawing": {"z_controller_on": False, "z_controller_status": "Withdrawing"},
    "zctrl_unknown": {},  # 读不到 ⇒ fail-open
    "scan_running": {"scan_running": True},
    "scan_stopped": {"scan_running": False},
    "bias_zero": {"bias_v": 0.0},
    "bias_live": {"bias_v": 1.5},
    "withdrawn": {"withdrawn": True},
    "not_withdrawn": {"withdrawn": False},
    "empty": {},
}


def main() -> int:
    grid = []
    for name in NAMES:
        for fname, fields in FIXTURES.items():
            state = HardwareState(**fields)
            grid.append({
                "precondition": name,
                "fixture": fname,
                "violations": pc.check_state_preconditions([name], state),
            })

    out = {
        "exact_checks": {k: [v[0], v[1]] for k, v in pc.PRECONDITION_CHECKS.items()},
        "context_fields": dict(pc.PRECONDITION_CONTEXT_FIELDS),
        "zctrl_status_hints": dict(pc._ZCTRL_STATUS_HINT),
        "substring_rules": [
            [list(subs), attr, bad, tpl] for subs, attr, bad, tpl in pc._SUBSTRING_RULES
        ],
        "exact_messages": {f"{a}|{e}": m for (a, e), m in pc._EXACT_MESSAGES.items()},
        "computed_names": sorted(pc.COMPUTED_CHECKS.keys()),
        "recognized": {n: pc.precondition_recognized(n) for n in NAMES},
        "grid": grid,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    hit = sum(1 for g in grid if g["violations"])
    print(f"[ok]   preconditions.json: {len(NAMES)} 个前置 × {len(FIXTURES)} 个夹具 "
          f"= {len(grid)} 格，其中 {hit} 格违反")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
