r"""录参考实现外部动作面里 `set_bias` 的分流：这一次改偏压走安全路径，还是直写。

模型面的「改偏压」不是直接调 `SetBias`。参考实现 7.1.0 的外部动作面（`mast/vista/actions.py`）先读当前偏压，
再按 `_bias_needs_safe_path` 分流：变号、变化量超过 0.5 V、目标落在 ±50 mV 死区（不论起点在哪），这三种走
`BiasSettleChange`（斜坡加稳定等待）；起点读不到时也走它，由它去拒绝；其余直写 `SetBias`。TS 侧的
`biasNeedsSafePath`（内核 `bias-settle.ts`）逐格比这份金样。

录：

* 20 个起点 × 19 个目标的整张网格。每格由 `_set_bias` 自己走一遍得到：执行器换成只记录「被请求了哪个技能」的
  替身，不接仪器，也不执行任何技能；第二个被请求的技能是 `BiasSettleChange` 记真，是 `SetBias` 记假。
  起点为 `null` 是读不到偏压，那一支在 `_set_bias` 里不经谓词，直接走安全路径；
* 起点读得到的格子，另外直接调 `_bias_needs_safe_path`，两者必须一致，不一致就是替身没有照实演出，导出失败；
* 两组常量：外部动作面里镜像的两个，和 `bias_settle` 里的两个原件。TS 侧要求自己的两个常量与它们都相等。

⚠️ 变化量恰在 0.5 V 附近的格（如 0.3 → 0.8）由浮点的最后一位决定真假，只有参考实现的 IEEE 结果可信，
所以用参考实现跑，不手写。

网格取值：起点与目标都含零、死区边界（±0.05 及其内侧 ±0.0499）、变号的一对、0.5 V 阈值两侧，以及超出阈值的
大幅改动；起点另有一行「读不到」。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_bias_routing.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from _paths import isolated_project_root, require_mast_root

isolated_project_root(tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = require_mast_root()
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "bias_routing.json"

sys.path.insert(0, str(MAST_ROOT))

# `_bias_needs_safe_path` 在函数体里才从 `bias_settle` 导入两个常量，那一步会装载全部组合技能；
# 这里直接导入，缺依赖就当场失败，不退回任何桩模块。
from mast.skills.composite import bias_settle  # noqa: E402
from mast.vista import actions  # noqa: E402

#: `None` = 读不到当前偏压
STARTS: list[float | None] = [
    None, -1.0, -0.3, -0.06, -0.05, -0.02, 0.0, 0.02, 0.05, 0.06,
    0.3, 1.0, 1.5, -1.2, -0.1, 0.03, 0.1, 0.2, 0.5, 2.0,
]
TARGETS: list[float] = [
    -1.0, -0.3, -0.06, -0.05, -0.0499, 0.0, 0.0499, 0.05, 0.06, 0.3,
    0.8, 1.0, 1.5, 2.0, -2.0, -0.5, -0.04, 0.02, 0.4,
]


class _Runner:
    """只记录「被请求了哪个技能」的执行器替身。

    `GetBias` 回 `{"bias_v": start}`；`start` 为 `None` 就回空，等于读不到。其余技能一律回空。
    """

    def __init__(self, start: float | None) -> None:
        self.start = start
        self.asked: list[str] = []

    def skill(self, name: str, params: dict, optional: bool = False) -> dict[str, Any]:
        self.asked.append(name)
        if name == "GetBias" and self.start is not None:
            return {"bias_v": self.start}
        return {}

    def data(self, res: dict[str, Any], key: str) -> Any:
        return res.get(key)


def route(start: float | None, target: float) -> bool:
    """`_set_bias` 走了安全路径吗？"""
    runner = _Runner(start)
    outcome = actions._set_bias(runner, {"bias_v": target})
    if len(runner.asked) != 2 or runner.asked[0] != "GetBias":
        raise SystemExit(f"替身没有照实演出（{start} → {target}）：被请求的技能 {runner.asked}")
    chosen = runner.asked[1]
    if chosen not in ("BiasSettleChange", "SetBias"):
        raise SystemExit(f"{start} → {target}：被请求了意料之外的技能 {chosen}")
    if outcome.facts.get("path") != chosen:
        raise SystemExit(f"{start} → {target}：结果里的 path {outcome.facts.get('path')!r} 与被请求的技能 {chosen} 不符")
    safe = chosen == "BiasSettleChange"
    if start is not None and bool(actions._bias_needs_safe_path(float(start), target)) != safe:
        raise SystemExit(f"{start} → {target}：谓词与 _set_bias 的分流不一致")
    return safe


def main() -> int:
    rows = [{"start_v": start, "safe_path": [route(start, target) for target in TARGETS]} for start in STARTS]
    doc = {
        "_note": "由 tools/spec-export/export_bias_routing.py 生成——对参考实现外部动作面的 `_set_bias` 逐格录得，"
                 "不要手改。rows[i].safe_path[j] 为真表示起点 rows[i].start_v、目标 targets[j] 走 BiasSettleChange；"
                 "start_v 为 null 是读不到当前偏压。",
        "constants": {
            "actions": {
                "BIAS_DEADBAND_V": actions.BIAS_DEADBAND_V,
                "BIAS_RAMP_THRESHOLD_V": actions.BIAS_RAMP_THRESHOLD_V,
            },
            "bias_settle": {
                "RAMP_THRESHOLD_V": bias_settle.RAMP_THRESHOLD_V,
                "ZERO_DEADBAND_V": bias_settle.ZERO_DEADBAND_V,
            },
        },
        "targets": TARGETS,
        "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    cells = len(STARTS) * len(TARGETS)
    safe = sum(sum(row["safe_path"]) for row in rows)
    print(f"✓ {OUT.relative_to(REPO)}：{len(STARTS)} 个起点 × {len(TARGETS)} 个目标 = {cells} 格，{safe} 格走安全路径")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
