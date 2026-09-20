"""针尖方案表与安全包络的**专用驱动器** —— 通用轨迹金样一格都照不到这里。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_tip_policy.py

## 为什么要单开一台

`export_skill_traces.py` 直接调 `skill.execute(...)` —— **`validate_params` 一次都
没被调用**（D-TIP-1 当初就是这么写的：「金样照不出这一条」）。而这一批的判据恰恰
**全部**住在 `validate_params` / 解析层里：

* 方案表按「材料 × 制备 × 形态」逐级回退查出来的那一档（**参数**）；
* 每个值的**来源**（explicit / operator_override / policy_table / factory_default）；
* **安全包络**：超上限**拒绝、不夹紧**，以及拒绝那句话逐字。

所以这一份是**输入网格**（无状态、无时钟、无随机数，两次导出逐字节相同），
形状照 `export_scan_resolver.py`：针尖 × 请求，每格记下解析层交出来的一整份东西。

## 网格里每一格都在回答一个具体问题

| 格 | 问的是 |
|---|---|
| `unregistered` × `defaults` | 未登记时到底落到哪一档（**不是 fail-open**，通用档有自己的包络） |
| `w_etched` / `w_cut` / `ptir_cut` | 逐级回退真的在回退吗（`(W,*,wire)` → `(W,etched,wire)`） |
| `qplus_*` × `count_6` | 全表**唯一**还在分辨针尖的包络字段（`max_pulse_count` 2 vs 5） |
| `* × pulse_10v001` | 边界是 `>` 不是 `>=` —— 10.0 放行，10.000001 拒 |
| `* × zero_pulse` | `0` 是一个**真实的值**（D-ZERO-1）：显式 0 被采纳，不当「没给」 |
| `* × str_pulse` | 一个**非数值**的显式值会绕过包络（旧仓行为，照录） |
| `override_*` | 覆写能**收紧**包络；坏覆写被忽略而不是变成 0 |
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-tip-policy-"))

MAST_ROOT = require_mast_root()
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "tip_policy.json"

sys.path.insert(0, str(MAST_ROOT))

from mast.core.tip_conditioning_policy import (  # noqa: E402
    FIELD_OWNERS,
    LIMIT_FIELDS,
    resolve_policy,
)
from mast.core.tip_conditioning_resolver import resolve_conditioning  # noqa: E402

#: 方案表里可能出现的全部参数字段（顺序固定，`FIELD_OWNERS` 的键）。
#:
#: ⚠️ `FIELD_OWNERS` 在旧仓**全仓零消费方**（`LIMIT_FIELDS` / `envelope_of` /
#: `policy_summary` 同样）。这台驱动器是它的第一个读者：一张「这一档可能有哪些字段」
#: 的表，正好是网格的行标题。
ALL_FIELDS: tuple[str, ...] = tuple(FIELD_OWNERS)


def facts(material: str, fabrication: str, form: str, name: str = "针 A",
          **extra: Any) -> dict[str, Any]:
    """`current_tip_facts()` 的形状。字段名逐字照它。"""
    out = {
        "tip_id": 7, "name": name, "material": material,
        "fabrication": fabrication, "form": form,
        "wire_diameter_mm": 0.25, "installed_at": "2026-09-01T00:00:00",
        "qplus_sensor_model": "", "qplus_f0_hz": None, "qplus_q": None,
        "qplus_k_n_per_m": None,
    }
    out.update(extra)
    return out


TIPS: dict[str, "dict[str, Any] | None"] = {
    # **未登记**：通用保守档。这一格是「fail-open 那句话是假的」的证据。
    "unregistered": None,
    "w_generic": facts("W", "unknown", "stm_wire", "钨针"),
    "w_etched": facts("W", "etched", "stm_wire", "钨腐蚀针"),
    "w_cut": facts("W", "cut", "stm_wire", "钨剪切针"),
    "ptir_generic": facts("PtIr", "unknown", "stm_wire", "铂铱针"),
    "ptir_cut": facts("PtIr", "cut", "stm_wire", "铂铱剪切针"),
    "fe": facts("Fe", "etched", "stm_wire", "磁性针"),
    "nb": facts("Nb", "etched", "stm_wire", "超导针"),
    # 认不出的材料 ⇒ 落到形态那一档（**不猜**）
    "unknown_material": facts("", "unknown", "stm_wire", "未命名"),
    "qplus_generic": facts("", "unknown", "qplus", ""),
    "qplus_w": facts("W", "etched", "qplus", "W-qPlus",
                     qplus_sensor_model="qPlus LT", qplus_f0_hz=32768.0,
                     qplus_q=25000.0, qplus_k_n_per_m=1800.0),
    "qplus_ptir": facts("PtIr", "cut", "qplus", "PtIr-qPlus"),
}

#: (请求的字段, 显式给的值, 覆写)
REQUESTS: dict[str, tuple[tuple[str, ...], dict[str, Any], dict[str, Any]]] = {
    "defaults": (ALL_FIELDS, {}, {}),
    "pulse_only": (("pulse_v",), {}, {}),
    # 10.0 正好等于上限 ⇒ **放行**（判据是 `>`，不是 `>=`）
    "pulse_10v": (("pulse_v",), {"pulse_v": 10.0}, {}),
    # 差一点点 ⇒ 拒
    "pulse_10v001": (("pulse_v",), {"pulse_v": 10.000001}, {}),
    # 负的同样按**绝对值**判：一发 −12 V 与 +12 V 一样会改造针尖
    "pulse_neg12v": (("pulse_v",), {"pulse_v": -12.0}, {}),
    # `0` 是一个真实的值（D-ZERO-1），不是「没给」
    "zero_pulse": (("pulse_v",), {"pulse_v": 0.0}, {}),
    # 空串 ⇒ 当没给，落方案表
    "empty_pulse": (("pulse_v",), {"pulse_v": ""}, {}),
    # **非数值的显式值绕过包络**（旧仓行为，照录）
    "str_pulse": (("pulse_v",), {"pulse_v": "abc"}, {}),
    "count_2": (("pulse_count",), {"pulse_count": 2}, {}),
    # 通用档 5 / qPlus 2 —— 全表唯一还在分辨针尖的包络字段
    "count_3": (("pulse_count",), {"pulse_count": 3}, {}),
    "count_6": (("pulse_count",), {"pulse_count": 6}, {}),
    # `TipPulse.count` 的声明上限是 50：K6 放行的值，这道闸会拒
    "count_50": (("pulse_count",), {"pulse_count": 50}, {}),
    "shallow_poke": (("poke_deep_depth_m",), {"poke_deep_depth_m": -3.0e-10}, {}),
    "deep_poke": (("poke_deep_depth_m",), {"poke_deep_depth_m": -1.2e-8}, {}),
    # **深度正好等于上限** ⇒ 放行（判据是 `abs(v) > max`，**闭区间**）。
    # 2026-09-19 补：此前这条线**两侧都有、线上一格没有** —— 深度用例是
    # −0.3 nm（过）与 −1.2 / −2 / −5 nm（拒）。而「正好 10 nm 放行」与
    # 「正好 10 nm 拒」在那四格里给出的答案一模一样，于是金样分不出 `>` 和 `>=`。
    # 生产路径那一侧 6a 已经钉了（`tip-phase-deps.test.ts`：−1e-8 过 /
    # −1.0000001e-8 拒），这一格把金样这一侧补齐。
    # 12 支针尖的 `max_poke_depth_m` **现在一律是 1.0e-8**（见方案表抬头：
    # 只有 `max_pulse_count` 还在分辨针尖），所以 12 格全过、被拒数不变。
    "shaper_depth_at_limit": (("shaper_depth_m",), {"shaper_depth_m": -1.0e-8}, {}),
    # 三个深度字段一起超 ⇒ 三条拒绝各说各的
    "all_deep": (("shaper_depth_m", "poke_shallow_depth_m", "poke_deep_depth_m"),
                 {"shaper_depth_m": -2.0e-8, "poke_shallow_depth_m": -1.1e-8,
                  "poke_deep_depth_m": -5.0e-8}, {}),
    "shaper_bias_12v": (("shaper_bias_v", "shaper_lift_v"),
                        {"shaper_bias_v": 12.0, "shaper_lift_v": -11.0}, {}),
    # 覆写**收紧**包络 ⇒ 一发 5 V 被拒
    "override_tighten": (("pulse_v",), {"pulse_v": 5.0}, {"max_abs_pulse_v": 3.0}),
    # 覆写也改缺省值（来源变成 operator_override）
    "override_default": (("pulse_v",), {}, {"pulse_v": 7.5}),
    # 坏覆写**被忽略**，不是变成 0
    "override_bad": (("pulse_v",), {"pulse_v": 5.0}, {"max_abs_pulse_v": "很大"}),
    # 表里没有的键 ⇒ 忽略（覆写不能凭空长出一个字段）
    "override_unknown": (("pulse_v",), {}, {"nope": 1, "_note": "x"}),
    # 整数字段按 `int()` 截断
    "override_int_trunc": (("pulse_count",), {"pulse_count": 3},
                           {"max_pulse_count": 2.9}),
    # `None` 覆写 ⇒ 跳过（= 没设）
    "override_none": (("pulse_v",), {}, {"pulse_v": None}),
}


def jsonable(v: Any) -> Any:
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return str(v)


def main() -> int:
    out: dict[str, Any] = {"tips": {}, "cases": {}}

    # ① 每支针尖的**整档方案**（参数 + 包络 + 来源 + 说明）。表本身就是判据。
    for tip_name, f in TIPS.items():
        pol = resolve_policy(f)
        sources = pol.pop("_sources")
        notes = pol.pop("_notes")
        pol.pop("_note", None)
        out["tips"][tip_name] = {
            "facts": jsonable(f),
            "values": jsonable(pol),
            "sources": jsonable(sources),
            "notes": jsonable(notes),
            "envelope": {k: jsonable(pol[k]) for k in LIMIT_FIELDS if k in pol},
        }

    # ② 针尖 × 请求：解析 + 包络判定 + 拒绝文案逐字。
    for tip_name, f in TIPS.items():
        for req_name, (fields, explicit, overrides) in REQUESTS.items():
            res = resolve_conditioning(fields, explicit, facts=f,
                                       overrides=overrides,
                                       skip_facts_lookup=True)
            out["cases"][f"{tip_name}/{req_name}"] = {
                "fields": list(fields),
                "explicit": jsonable(explicit),
                "overrides": jsonable(overrides),
                "params": jsonable(res.params),
                "trace": jsonable(res.trace),
                "refusals": jsonable(res.refusals),
                "ok": bool(res.ok),
                "human_trace": res.human_trace(),
                "notes": jsonable(res.notes),
            }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True,
                   allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    n_ref = sum(1 for c in out["cases"].values() if c["refusals"])
    print(f"[ok]   tip_policy.json: {len(out['tips'])} 支针尖 / "
          f"{len(out['cases'])} 格（其中 {n_ref} 格被拒）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
