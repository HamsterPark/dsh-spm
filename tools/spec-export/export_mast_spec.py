"""把旧仓 MAST 的技能契约导成 golden，作为 TS 侧 parity 的**分母**。

只读旧仓，不写旧仓一个字节。用旧仓自己的 venv 跑（本机 PATH 里没有可用的 python）：

    python \\
        tools/spec-export/export_mast_spec.py

为什么分母必须从真源导出而不是手抄：PLAN §8.5 的 DoD ① 要求 `skill.spec` 与本文件
产出的条目 deep-equal，②要求工具 schema 的 description **逐字相等**。手抄的分母会
把「我们抄错了」伪装成「实现对了」。

隔离：导出前把 `MAST2_PROJECT_ROOT` 指向临时目录。旧仓的 config / data_paths /
override_store / models（API key 目录解析）都认这个变量，指走了就不会碰到真实的
实验库、覆盖表和密钥目录。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
OUT_DIR = Path(__file__).resolve().parents[2] / "spec" / "golden"


def _isolate() -> str:
    """必须在 import mast 之前调用。"""
    sandbox = tempfile.mkdtemp(prefix="mast-spec-export-")
    os.environ["MAST2_PROJECT_ROOT"] = sandbox
    sys.path.insert(0, str(MAST_ROOT))
    return sandbox


def collect_skills() -> dict:
    from mast.core.registry import SkillRegistry

    registry = SkillRegistry()
    registry.discover()  # 默认包：mast.skills.{builtins,composite,paper}

    out: dict[str, dict] = {}
    for name, by_version in registry.snapshot_names().items():
        for version, cls in by_version.items():
            # 用 _get_metadata_raw 而不是 _get_metadata：前者是**作者声明**，后者叠了
            # admin 覆盖。旧仓自己的注释说得最清楚——拿叠加后的当基线，一个「调低某
            # 技能 safety_level」的管理员覆盖就会变成新标尺，把审批闸门洗白。
            # 分母要的是声明，不是当前生效的包络。
            meta = SkillRegistry._get_metadata_raw(cls)
            module = cls.__module__
            out[f"{name}@{version}"] = {
                "name": meta.name,
                "version": meta.version,
                "module": module,
                # builtins / composite / paper —— §8.4 分批的三个依据之一
                "origin": module.split(".")[2] if module.startswith("mast.skills.") else "?",
                "class": cls.__name__,
                "category": meta.category.value if hasattr(meta.category, "value") else str(meta.category),
                "safety_level": meta.safety_level.value if hasattr(meta.safety_level, "value") else str(meta.safety_level),
                "description": meta.description,
                "parameters": [
                    {
                        "name": p.name,
                        "type": p.type,
                        "description": p.description,
                        "unit": p.unit,
                        "required": p.required,
                        "default": p.default,
                        "min_value": p.min_value,
                        "max_value": p.max_value,
                        "allowed_values": p.allowed_values,
                    }
                    for p in meta.parameters
                ],
                "preconditions": list(meta.preconditions),
                "postconditions": list(meta.postconditions),
                "estimated_duration_s": meta.estimated_duration_s,
                "rollback_skill": meta.rollback_skill,
                "tags": list(meta.tags),
                "composition_level": meta.composition_level,
                "capabilities": sorted(meta.capabilities),
            }
    return out


def collect_si_cases() -> dict:
    """对真实实现打一遍网格，把行为（含报错原文）录成金样。

    钉住报错原文是有意的：PLAN §3.2-1 说范围提示与解析必须同源，而模型读到的正是
    这些句子。TS 侧照抄行为容易，照抄措辞难——所以措辞也进金样。
    """
    from mast.core import si_quantity as si

    def rec(fn, *args, **kwargs):
        try:
            v = fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 —— 报错类型与原文都是契约的一部分
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
        # inf/nan 不是合法 JSON：Python 的 json.dumps 默认会写出裸 Infinity/NaN，
        # 任何标准解析器都拒收。显式换成带标签的字符串，别让金样自己成为坏数据。
        if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
            return {"ok": True, "nonfinite": "nan" if v != v else ("inf" if v > 0 else "-inf")}
        return {"ok": True, "value": v}

    prefixes = ["a", "f", "p", "n", "u", "µ", "μ", "m", "k", "M", "G"]
    parse_inputs = (
        [f"3{p}" for p in prefixes]
        + [f"-1.5{p}" for p in prefixes]
        # inf/nan/1_000 是 Python float() 认、而物理参数绝不该认的写法——录下来是为了让
        # TS 侧「更严」这件事成为**有证据的有意偏差**，而不是没人发现的分歧。
        + ["1.5", "0", "-0", "3 p", " 3p ", "3P", "3", "abc", "", "1e-12", "3p4", None, 1.5, 0,
           "inf", "nan", "-inf", "1_000", "0x10"]
    )

    return {
        "parse_si": {repr(t): rec(si.parse_si, t) for t in parse_inputs},
        "parse_quantity_strict": {repr(t): rec(si.parse_quantity, t, strict=True) for t in parse_inputs},
        "parse_quantity_loose": {repr(t): rec(si.parse_quantity, t, strict=False) for t in parse_inputs},
        "needs_strict_prefix": {
            repr((lo, hi)): rec(si.needs_strict_prefix, lo, hi)
            for lo, hi in [
                (None, None), (0, 1), (-10, 10), (1e-12, 1e-9), (0.1e-9, 10e-6),
                (1e-3, None), (None, 1e-3), (-1.5e-6, 1.5e-6), (0, 100e-9),
            ]
        },
        "format_si": {
            repr(v): rec(si.format_si, v)
            # 后四个是 format_si 的兜底分支（超出 a..G 覆盖范围）与非有限值：
            # 物理上不该出现，但「不该出现」正是静默 bug 的温床。
            for v in [0, 1, -1, 3e-12, -1.5e-9, 1.5, 1e4, 1e-15, 123456.0, 0.1,
                      1e12, 5e-19, float("nan"), float("inf")]
        },
    }


def _spec_source() -> dict:
    """记下**这份金样是从旧仓的哪个状态导出的**。

    2026-09-10 踩到：重跑导出，skills.json 和 safety.json 无缘无故变了 123+5 行。
    查了半天才发现旧仓**工作区**当天被改了词（「操作员」→「用户」）。

    关键教训是 **git HEAD 号在这件事上完全没用**：那天旧仓工作区比它最后一次提交
    超前 1183 个文件 / 25886 行，而 HEAD 一步没挪。金样导的是**工作区**，不是提交。
    所以真正能回答「规格源动没动」的，只有对导入的那些源文件做内容摘要。

    摘要变了不代表金样一定变（多数改动碰不到我们抽的字段）；但金样变而摘要没变，
    那就是导出脚本自己不确定——两种情况的处理完全不同，所以两个数都记。
    """
    import hashlib
    import subprocess

    h = hashlib.sha256()
    n = 0
    for f in sorted((MAST_ROOT / "mast").rglob("*.py")):
        h.update(str(f.relative_to(MAST_ROOT)).replace("\\", "/").encode())
        h.update(f.read_bytes())
        n += 1
    head = "?"
    try:
        # --no-optional-locks：旧仓是只读的，连它的 index 都不许刷
        head = subprocess.run(
            ["git", "--no-optional-locks", "-C", str(MAST_ROOT), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip() or "?"
    except Exception:
        pass
    return {"py_files": n, "digest": h.hexdigest()[:16], "near_commit": head}


def main() -> int:
    sandbox = _isolate()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 每个 collector 独立 try/except，成败逐个记进 manifest。
    # 一个坏了不能静默缺一块——缺一块的 golden 会让分母悄悄变小，
    # 于是「已完成比例」凭空变好看（PLAN §8.6）。
    # 不记沙箱路径：它每次跑都不同，会让 golden 的 diff 全是噪声。金样最重要的性质是
    # **重跑产出逐字节相同**，否则「有没有变」这个问题就没法用 diff 回答。
    manifest: dict = {"mast_root": str(MAST_ROOT), "spec_source": _spec_source(), "collectors": {}}
    # 每个 collector 自报怎么数——skills.json 数技能，si_cases.json 数用例（它是分组
    # 结构，数顶层键会报「5」）。用一个启发式去猜两种形状，只会两边都数错。
    for filename, collector, count in [
        ("skills.json", collect_skills, len),
        ("si_cases.json", collect_si_cases, lambda d: sum(len(g) for g in d.values())),
    ]:
        try:
            data = collector()
            (OUT_DIR / filename).write_text(
                # allow_nan=False 是护栏：Python 默认会把 inf/nan 写成裸 Infinity/NaN，
                # 那**不是合法 JSON**，任何标准解析器都拒收。默认值让金样能悄悄变成坏
                # 数据（2026-09-08 真踩过一次）；关掉它就变成当场报错。
                json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True, default=str, allow_nan=False) + "\n",
                encoding="utf-8",
                newline="\n",  # 显式 LF：仓库 .gitattributes 强制 LF，写 CRLF 会让
                               # 「重跑后 git diff 为空」这个说法失真（磁盘与库里不一致）
            )
            n = count(data)
            manifest["collectors"][filename] = {"ok": True, "entries": n}
            print(f"[ok]   {filename}: {n} 条")
        except Exception:
            manifest["collectors"][filename] = {"ok": False, "traceback": traceback.format_exc()}
            print(f"[FAIL] {filename}\n{traceback.format_exc()}", file=sys.stderr)

    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    src = manifest["spec_source"]
    print(f'[src]  规格源 {src["py_files"]} 个 .py，摘要 {src["digest"]}，近 {src["near_commit"]}（旧仓工作区，非提交）')
    return 0 if all(c["ok"] for c in manifest["collectors"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
