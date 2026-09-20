"""把**粗动驱动四道锁**那台判定机录成金样。

驱动的是**旧仓真实实现** `mast/core/coarse_drive.py`。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_coarse_drive.py

## 为什么单开一台驱动器

`skill_traces.json` 里那两条粗动组合停在**没声明 ⇒ 拒绝一切**那一格上 ——
那是最要紧的一格，但也只是一格。声明装上之后的判据（绝对上限、本机上限、
**拒绝而不夹紧**、读回核对、频率不符只警告不拒绝）一条都走不到，
因为通用驱动器不会替这台机器填那个数。

## 措辞就是契约

拒绝理由是**直接给人看的**（模型读到的也是同一段），所以整段文本逐字进金样。
`authorize` 那几句里印着请求值与上限值，于是「`%g` 怎么格式化」也一并钉住 ——
本仓那份格式化是自己写的，一位不同就当场红。
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
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "coarse_drive.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import coarse_drive as cd   # noqa: E402

#: 三种声明状态。`amp_only` 存在的理由：期望频率**留空 = 不核对频率**。
DECLARATIONS: dict[str, Any] = {
    "undeclared": {},
    "amp_only": {"max_amplitude_v": 220.0},
    "amp_and_freq": {"max_amplitude_v": 220.0, "expected_frequency_hz": 1000.0,
                     "declared_by": "spec-export", "notes": "金样夹具"},
    # 一个**越界**的声明：`sanitize` 丢掉它 ⇒ 等价于没声明。
    "over_absolute": {"max_amplitude_v": 401.0},
}

#: `sanitize` 用例。
SANITIZE_CASES: list[tuple[str, Any]] = [
    ("not_a_dict", 7),
    ("empty", {}),
    ("unknown_dropped", {"nope": 1}),
    ("over_absolute_dropped", {"max_amplitude_v": 401.0}),
    ("at_absolute_kept", {"max_amplitude_v": 400.0}),
    ("negative_dropped", {"max_amplitude_v": -1.0}),
    ("nan_dropped", {"max_amplitude_v": float("nan")}),
    ("inf_dropped", {"max_amplitude_v": float("inf")}),
    ("numeric_string", {"max_amplitude_v": "220"}),
    ("freq_over_dropped", {"expected_frequency_hz": 20001.0}),
    ("text_trimmed", {"declared_by": "  甲  ", "notes": "x" * 300}),
    ("stamp_kept", {"declared_at": 1_700_000_000.0}),
    ("full", dict(DECLARATIONS["amp_and_freq"])),
]

#: `authorize(amplitude, frequency)` 的格。
AUTHORIZE_CASES: list[tuple[str, Any, Any]] = [
    ("not_a_number", "abc", None),
    ("none", None, None),
    ("nan", float("nan"), None),
    ("inf", float("inf"), None),
    ("negative", -1.0, None),
    ("over_absolute", 401.0, None),
    ("at_absolute", 400.0, None),
    ("freq_not_a_number", 30.0, "abc"),
    ("freq_over_absolute", 30.0, 20001.0),
    ("freq_negative", 30.0, -1.0),
    ("under_ceiling", 30.0, 1000.0),
    ("at_ceiling", 220.0, None),
    ("over_ceiling", 260.0, None),
    ("zero", 0.0, None),
    # `%g` 的两种分支：整数与需要有效数字的那种
    ("fractional", 12.5, None),
]

#: `readback_matches(read_amp, read_freq)` 的格。
READBACK_CASES: list[tuple[str, Any, Any]] = [
    ("unreadable_amp", None, None),
    ("amp_not_a_number", "abc", None),
    ("amp_nan", float("nan"), None),
    ("amp_within", 30.0, 1000.0),
    ("amp_at_ceiling", 220.0, 1000.0),
    # 2 % 容差：220 × 1.02 = 224.4
    ("amp_inside_tolerance", 224.0, 1000.0),
    ("amp_outside_tolerance", 225.0, 1000.0),
    ("amp_way_over", 390.0, 1000.0),
    ("freq_unreadable_but_declared", 30.0, "abc"),
    ("freq_mismatch_warns_not_refuses", 30.0, 500.0),
    ("freq_within_10pct", 30.0, 1050.0),
    ("freq_absent", 30.0, None),
]


def _verdict(pair: tuple[bool, str]) -> dict[str, Any]:
    return {"ok": pair[0], "reason": pair[1]}


def main() -> int:
    out: dict[str, Any] = {
        "constants": {
            "settings_key": cd.SETTINGS_KEY,
            "absolute_max_amplitude_v": cd.ABSOLUTE_MAX_AMPLITUDE_V,
            "absolute_max_frequency_hz": cd.ABSOLUTE_MAX_FREQUENCY_HZ,
            "readback_rel_tol": cd.READBACK_REL_TOL,
            "all_keys": list(cd.ALL_KEYS),
            "undeclared_text": cd._UNDECLARED,
        },
        "sanitize": {},
        "authorize": {},
        "readback_matches": {},
        "format_block": {},
        "declaration": {},
    }

    for name, raw in SANITIZE_CASES:
        clean = cd.sanitize(raw)
        # `declared_at` 是 `set_declaration` 才盖的戳；`sanitize` 只透传。
        out["sanitize"][name] = clean

    for dname, decl in DECLARATIONS.items():
        cd.set_declaration(decl)
        out["declaration"][dname] = {
            "stored": cd.get_declaration(),
            "max_amplitude_v": cd.max_amplitude_v(),
            "expected_frequency_hz": cd.expected_frequency_hz(),
            "is_declared": cd.is_declared(),
        }
        # `declared_at` 是墙钟 —— 摘掉它，否则重跑不逐字节相同。
        out["declaration"][dname]["stored"].pop("declared_at", None)
        out["format_block"][dname] = cd.format_block()
        out["authorize"][dname] = {
            name: _verdict(cd.authorize(a, f)) for name, a, f in AUTHORIZE_CASES
        }
        out["readback_matches"][dname] = {
            name: _verdict(cd.readback_matches(a, f)) for name, a, f in READBACK_CASES
        }

    cd.set_declaration({})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    n = len(DECLARATIONS) * (len(AUTHORIZE_CASES) + len(READBACK_CASES))
    print(f"[ok]   coarse_drive.json: {len(out['sanitize'])} 洗 / {n} 格闸门 / "
          f"{len(out['format_block'])} 段提示块")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
