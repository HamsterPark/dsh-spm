"""`_tip_phases` 六个流程的**子技能依赖**——批 6a 的专用驱动器（静态）。

    python \\
        tools/spec-export/export_tip_phase_deps.py

## 为什么要单开一台，而且是**静态**的

这六个流程（`PrepareNobleTip` · `PokeConditionTip` · `PulseConditionTip` ·
`MakeSpectroscopyTip` · `MakeAtomicResolutionTip` · `ForgeAuTip`）一格轨迹金样都录不到：
它们要一台真仪器跑几十分钟到几小时，而 `export_skill_traces.py` 那台通用驱动器
是「直调 `skill.execute`」。所以「这条流程会调到哪些子技能」这件事，**只能从代码本身读**。

而这正是批 6a 唯一要回答的问题。盘点说这六个卡在 `AssessClusterRoundness`（批 4a 已落），
**照着代码数下来不是这样**：每一条的第一个动作都要先问地图要一个干净落点
（`_relocate` → `FindCleanSpot`），而那个技能压着整套实验地图子系统。
一句手抄的「还差 X」会静静过期；一张**从旧仓源码算出来的**表不会。

## 它算的是什么

`CompositeSkillGraph.plan_dynamic` 是一个生成器，`yield` 出 `CompositeStep(...)`。
所以：

1. 每个函数/方法里出现的 `CompositeStep(skill_name="X", optional=…)` 字面量 ⇒ 一条边；
2. 函数之间的 `yield from f(...)` / `f(...)` ⇒ 一条调用边（跨这四个文件解名）；
3. 从六个 `plan_dynamic` 出发求传递闭包 ⇒ 这个技能**可能**发出去的全部子技能。

**「可能」不是「一定」**：分支、预算、参数都可能让某一步这一趟不发。所以这张表是
**上界**，而上界正是「要移这个技能，得先有哪些」要的那个东西。

`optional` 逐点记下来，因为它决定缺席时的后果完全不同：
`optional=False` 缺席 ⇒ 执行器当场中止整个计划；`optional=True` 缺席 ⇒ 流程**继续跑**，
拿着一个「这一步失败了」的空结果往下判——而那往往比中止更坏
（`_relocate` 的 `FindCleanSpot` 正是 `optional=True`：它失败时流程报的是
「这片表面已经没有可用的落点了」，一句**关于样品的假话**）。

## 两次导出逐字节相同

纯 `ast`，无时钟、无随机数、无 import 旧仓运行时（连 `sys.path` 都不动）。
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "tip_phase_deps.json"

COMPOSITE = MAST_ROOT / "mast" / "skills" / "composite"

#: 参与解析的四个文件。`_tip_phases` 是判据与循环，另三个是入口薄壳。
SOURCES = {
    "_tip_phases": COMPOSITE / "_tip_phases.py",
    "prepare_noble_tip": COMPOSITE / "prepare_noble_tip.py",
    "make_special_tip": COMPOSITE / "make_special_tip.py",
    "forge_au_tip": COMPOSITE / "forge_au_tip.py",
}

#: 六个入口 —— `(技能名, 模块, 起点函数)`。起点一律是 `plan_dynamic`：
#: `CompositeSkillGraph` 只从这一个口子排步骤（`metadata` / `validate_params`
#: / `aggregate` 都不发步骤）。
ENTRIES = [
    ("PrepareNobleTip", "prepare_noble_tip", "PrepareNobleTip.plan_dynamic"),
    ("PokeConditionTip", "prepare_noble_tip", "PokeConditionTip.plan_dynamic"),
    ("PulseConditionTip", "prepare_noble_tip", "PulseConditionTip.plan_dynamic"),
    ("MakeSpectroscopyTip", "make_special_tip", "MakeSpectroscopyTip.plan_dynamic"),
    ("MakeAtomicResolutionTip", "make_special_tip", "MakeAtomicResolutionTip.plan_dynamic"),
    ("ForgeAuTip", "forge_au_tip", "ForgeAuTip.plan_dynamic"),
]


class _Fn:
    """一个函数（或方法）里能看见的三样东西：占了哪几行、发的步骤、调的函数。"""

    __slots__ = ("first_line", "last_line", "steps", "calls")

    def __init__(self, node: ast.AST) -> None:
        self.first_line = int(getattr(node, "lineno", 0))
        self.last_line = int(getattr(node, "end_lineno", 0) or self.first_line)
        self.steps: list[dict[str, Any]] = []
        self.calls: list[str] = []


def _literal(node: ast.AST | None) -> Any:
    """只认字面量。认不出来就是 `None`（调用方自己分辨「没写」与「写了个表达式」）。"""
    if node is None:
        return None
    try:
        return ast.literal_eval(node)
    except Exception:  # noqa: BLE001 — 不是字面量就是不是，不该让导出崩掉
        return None


def _callee_name(node: ast.expr) -> str | None:
    """`f(...)` → `"f"`；`self._x(...)` → `"self._x"`；别的（属性链、下标）不认。"""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        return f"{node.value.id}.{node.attr}"
    return None


class _Walker(ast.NodeVisitor):
    """走一个函数体，收 `CompositeStep(...)` 与函数调用。**不下钻嵌套函数定义**。"""

    def __init__(self, fn: _Fn) -> None:
        self.fn = fn

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        # 嵌套的 def 有自己的一份记录（由 _collect 单独登记），这里不重复走。
        return

    visit_AsyncFunctionDef = visit_FunctionDef  # type: ignore[assignment]

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        name = _callee_name(node.func)
        if name == "CompositeStep":
            kw = {k.arg: k.value for k in node.keywords if k.arg is not None}
            skill = _literal(kw.get("skill_name"))
            step_id = kw.get("step_id")
            self.fn.steps.append({
                # 认不出字面量的写 `<dynamic>` —— **不许猜**。今天全是字面量，
                # 哪天有人改成变量，这张表会说出来而不是少一行。
                "skill": skill if isinstance(skill, str) else "<dynamic>",
                "optional": bool(_literal(kw.get("optional")) or False),
                "line": int(node.lineno),
                "step_id_literal": isinstance(step_id, ast.Constant),
            })
        elif name is not None:
            self.fn.calls.append(name)
        self.generic_visit(node)


def _collect(path: Path) -> dict[str, _Fn]:
    """一个文件里全部的函数与方法，键是 `"func"` 或 `"Class.method"`。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out: dict[str, _Fn] = {}

    def add(key: str, node: ast.AST) -> None:
        fn = _Fn(node)
        _Walker(fn).generic_visit(node)
        out[key] = fn

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            add(node.name, node)
        elif isinstance(node, ast.ClassDef):
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    add(f"{node.name}.{sub.name}", sub)
    return out


def _imports(path: Path) -> dict[str, str]:
    """`from mast.skills.composite._tip_phases import pulse_phase` → `{pulse_phase: _tip_phases}`。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            tail = node.module.rsplit(".", 1)[-1]
            if tail in SOURCES:
                for alias in node.names:
                    out[alias.asname or alias.name] = tail
    return out


def main() -> int:
    fns: dict[str, dict[str, _Fn]] = {m: _collect(p) for m, p in SOURCES.items()}
    imports: dict[str, dict[str, str]] = {m: _imports(p) for m, p in SOURCES.items()}

    def resolve(module: str, call: str) -> tuple[str, str] | None:
        """一个调用名 → `(模块, 键)`；解不出来（外部函数、标准库）返回 None。"""
        if call.startswith("self."):
            # 方法调用：类名从当前这个键里取不到，所以四个文件里挨个类找同名方法。
            meth = call.split(".", 1)[1]
            for key in fns[module]:
                if key.endswith(f".{meth}"):
                    return module, key
            return None
        if call in fns[module]:
            return module, call
        home = imports[module].get(call)
        if home is not None and call in fns[home]:
            return home, call
        return None

    out: dict[str, Any] = {
        "_note": (
            "批 6a：`_tip_phases` 六个流程的子技能依赖，从旧仓源码静态算出来的**上界**。"
            "由 tools/spec-export/export_tip_phase_deps.py 生成，不要手工改。"
        ),
        "functions": {},
        "skills": {},
    }

    for module, table in sorted(fns.items()):
        for key, fn in sorted(table.items()):
            out["functions"][f"{module}:{key}"] = {
                "first_line": fn.first_line,
                "last_line": fn.last_line,
                "lines": fn.last_line - fn.first_line + 1,
            }

    for skill, module, entry in ENTRIES:
        seen: set[tuple[str, str]] = set()
        stack = [(module, entry)]
        subs: dict[str, dict[str, Any]] = {}
        while stack:
            mod, key = stack.pop()
            if (mod, key) in seen or key not in fns[mod]:
                continue
            seen.add((mod, key))
            fn = fns[mod][key]
            for step in fn.steps:
                rec = subs.setdefault(
                    step["skill"], {"required_somewhere": False, "sites": []})
                if not step["optional"]:
                    rec["required_somewhere"] = True
                rec["sites"].append({
                    "file": f"{mod}.py",
                    "line": step["line"],
                    "in": key,
                    "optional": step["optional"],
                })
            for call in fn.calls:
                hit = resolve(mod, call)
                if hit is not None:
                    stack.append(hit)

        for rec in subs.values():
            rec["sites"].sort(key=lambda s: (s["file"], s["line"]))

        out["skills"][skill] = {
            "entry": f"{module}:{entry}",
            # 这个技能的**全部**代码面：闭包里每个函数的行数。交接里那句
            # 「差哪个函数、多少行」就是从这儿来的。
            "functions": sorted(f"{m}:{k}" for m, k in seen),
            "code_lines": sum(
                fns[m][k].last_line - fns[m][k].first_line + 1 for m, k in seen),
            "sub_skills": {k: subs[k] for k in sorted(subs)},
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True,
                   allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    for skill, _m, _e in ENTRIES:
        d = out["skills"][skill]
        print(f"[ok]   {skill:<24} {len(d['sub_skills']):>2} 个子技能 · "
              f"{len(d['functions']):>2} 个函数 / {d['code_lines']} 行")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
