"""把工具 schema 的生成结果录成金样。

**DoD ② 的判据就是这份**：TS 侧 `parametersFromSpec` 与 Python 的
`_schema_from_metadata` 比——类型、required、**以及 description 逐字相等**。

description 不是文档，是**模型唯一读得到范围与写法的地方**：
有量纲参数被声明成字符串（因为这家 provider 的数字通道 12/12 全损坏），
于是 `ge/le` 到不了 schema，范围只能写进描述。抄错一个词，模型就会用错写法。

    python \\
        tools/spec-export/export_tool_schemas.py

用**合成的技能声明**而不是真的 515 个：这一段要钉的是**生成规则**，
每条规则一个最小用例比 515 个真技能更能说明问题，而且不受旧仓改动影响。
真技能的逐条 parity 留给 Phase 2 批次（那时 `skills.json` 是分母）。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

# ⚠️ **必须在 import mast 之前**把项目根指到临时目录（PLAN §8.6 的「隔离」就是这个意思）。
# 2026-09-10 踩到：直接 import skill_adapter 会拉起管理员覆写机制，它把
# config/overrides 从旧位置**迁移**到 MAST2_PROJECT_ROOT/config/overrides ——
# 于是一个「只读」的导出脚本在旧仓里新建了一个目录。原文件没被动，但红线是
# 「只读旧仓」，不是「不弄坏旧仓」。
os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "tool_schemas.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.agents._shared import skill_adapter as sa  # noqa: E402
from mast.core.types import ParameterSpec, SkillMetadata  # noqa: E402

#: 每条一个生成规则。(用例名, 参数列表)
CASES: list[tuple[str, list[dict]]] = [
    ("plain_string", [dict(name="label", type="string", description="标签", required=True)]),
    ("plain_int", [dict(name="steps", type="integer", description="步数", required=True)]),
    ("int_with_range", [dict(name="steps", type="integer", description="步数",
                             min_value=1, max_value=100, required=True)]),
    ("bool_flag", [dict(name="enabled", type="boolean", description="开关", required=False, default=True)]),
    # 枚举：allowed_values 全是 str/int/bool ⇒ 真枚举，不是一句散文
    ("enum_str", [dict(name="direction", type="string", description="方向",
                       allowed_values=["X+", "X-", "Z+"], required=True)]),
    ("enum_int", [dict(name="channel", type="integer", description="通道",
                       allowed_values=[1, 2, 3], required=True)]),
    # 有量纲 float ⇒ **字符串**通道
    ("dim_strict_current", [dict(name="setpoint_a", type="float", unit="A", description="隧道电流设定点",
                                 min_value=1e-12, max_value=100e-9, required=True)]),
    ("dim_strict_length", [dict(name="x_m", type="float", unit="m", description="X 坐标",
                                min_value=-1.5e-6, max_value=1.5e-6, required=True)]),
    ("dim_lenient_bias", [dict(name="bias_v", type="float", unit="V", description="偏压",
                               min_value=-10.0, max_value=10.0, required=True)]),
    # 只有上界 / 只有下界 / 都没有
    ("dim_only_max", [dict(name="tip_lift", type="float", unit="m", description="下压深度",
                           max_value=1e-7, required=False)]),
    ("dim_only_min", [dict(name="dwell_s", type="float", unit="s", description="停留",
                           min_value=0.001, required=False)]),
    ("dim_no_bounds", [dict(name="angle_deg", type="float", unit="deg", description="角度", required=False)]),
    # 无单位的 float：不走字符串通道，走 ge/le
    ("float_no_unit", [dict(name="ratio", type="float", description="比例",
                            min_value=0.0, max_value=1.0, required=True)]),
    # 没有描述
    ("no_description", [dict(name="x_m", type="float", unit="m", min_value=-1e-6, max_value=1e-6, required=True)]),
]


def build(name: str, params: list[dict]) -> dict:
    meta = SkillMetadata(
        name=name,
        description=f"{name} 的说明",
        parameters=[ParameterSpec(**p) for p in params],
    )
    model = sa._schema_from_metadata(meta)
    schema = model.model_json_schema()
    props = dict(schema.get("properties", {}))
    # tool_call_id 是注入字段，**不该出现在给模型的 schema 里**——单独记一下确认它被隐藏
    injected = props.pop("tool_call_id", None)
    required = [r for r in schema.get("required", []) if r != "tool_call_id"]
    return {
        "properties": props,
        "required": sorted(required),
        "tool_call_id_present": injected is not None,
        "si_params": sa._si_params(meta),
        "effective_bounds": {
            p.name: list(sa.effective_bounds(p)) for p in meta.parameters
        },
    }


def main() -> int:
    out = {name: build(name, params) for name, params in CASES}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(f"[ok]   tool_schemas.json: {len(out)} 条生成规则")
    for k, v in out.items():
        p = next(iter(v["properties"].values()), {})
        print(f"       {k:24s} type={p.get('type', p.get('enum') and 'enum' or '?')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
