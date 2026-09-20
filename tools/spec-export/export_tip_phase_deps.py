"""`_tip_phases` 六个流程的**子技能依赖**——批 6a 的专用驱动器（静态）。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_tip_phase_deps.py

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

## 批 7b-1 加的第二层：`skill_runs` —— 每个技能**自己**还调谁

上面那六行算的是「流程 → 它 `yield` 出去的 `CompositeStep`」，**一层**。
而一个子技能自己还可以 `context.run("…")` 再叫一个技能：
`AutoTilt` → `TiltProbeCircle`（`composite/auto_tilt.py:134`），
而 `TiltProbeCircle` 这个名字**不在六行里的任何一行**。
⇒ 「六行全空」不等于「六条流程都能跑」，而封锁账会说能跑。

> 一个会自己失效的判据，只在它**记全了的那一维**上会自己失效。
> 在没记的那一维上它和一张手抄清单没有区别 —— 而它看起来比手抄清单可信。

所以这一版扫**整个 `mast/skills/**`**，对每个技能名建一条
「它会发出去的技能名」的边表（`skill_runs`），TS 侧据此自己求闭包。

### 追到哪儿为止（`closure_limits`，这一节是判据的一部分）

| 追 | 不追 |
|---|---|
| 技能类的方法体（含**同模块**的基类） | 框架基类（`BaseSkill` / `CompositeSkillGraph`）的方法体 |
| 从那里可达的、`mast/skills/**` 之内的模块级函数（跨文件跟 `from … import`） | `mast/skills/**` **之外**的函数（`mast.core` / `mast.io` / `mast.vision`）|
| `context.run("X", …)` / `ctx.run("X", …)` 的**字面量**第一参 | 第一参是变量的（逐条记进 `dynamic_run_sites`）|
| `CompositeStep(skill_name="X", …)` 的**字面量** | 同上，记 `<dynamic>` |

**一个说不清自己追到哪儿的闭包，比一层还坏。** 所以三样东西显式落进金样：
`unknown_skills`（被叫到、而本表里找不到定义的名字）·
`dynamic_run_sites`（追不动的现场，带 `file:line` 与原表达式）·
`cycles`（环 —— 递归靠 `seen` 挡，挡了什么要说出来）。
"""

from __future__ import annotations

import ast
import json
import os
import tempfile
from pathlib import Path

from _paths import require_mast_root
from typing import Any

#: 红线：旧仓只读。真要有哪一行 import 到旧仓运行时，它写文件也只会写进这个空临时目录。
#: （本导出器纯 `ast`，一行旧仓代码都不执行 —— 这一句是**结构性**的保险，不是必需品。）
os.environ.setdefault(
    "MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="dsh-spm-tip-phase-deps-"))

MAST_ROOT = require_mast_root()
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "tip_phase_deps.json"

COMPOSITE = MAST_ROOT / "mast" / "skills" / "composite"

#: 闭包那一半扫的根。`mast/skills/**` 之外的函数不追（见抬头那张表）。
SKILLS_ROOT = MAST_ROOT / "mast" / "skills"

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
    """一个函数（或方法）里能看见的四样东西：行数、发的步骤、调的函数、**函数体里的 `mast.*` import**。

    第四样是批 7b-1 加的，理由见 `main()` 里 `non_skill_deps` 那一段：
    **闭包是「技能 → 技能」那一维的闭包，它对「技能 → 不是技能的东西」一言不发。**
    """

    __slots__ = ("first_line", "last_line", "steps", "calls", "imports")

    def __init__(self, node: ast.AST) -> None:
        self.first_line = int(getattr(node, "lineno", 0))
        self.last_line = int(getattr(node, "end_lineno", 0) or self.first_line)
        self.steps: list[dict[str, Any]] = []
        self.calls: list[str] = []
        #: `(模块, 名字)` —— 只收 `mast.*`，只收**函数体里**的（旧仓这一族普遍把真依赖
        #: 写在函数体内、顶层只留 `BaseSkill` 与 `types`）。
        self.imports: list[tuple[str, str]] = []


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

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        if node.module and node.module.split(".", 1)[0] == "mast":
            for alias in node.names:
                self.fn.imports.append((node.module, alias.name))
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for alias in node.names:
            if alias.name.split(".", 1)[0] == "mast":
                self.fn.imports.append((alias.name, "*"))
        self.generic_visit(node)

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


def _toplevel_mast(path: Path) -> dict[str, tuple[str, str]]:
    """**模块顶层**的 `mast.*` import：本地名 → `(模块, 原名)`。

    ⚠️ 只看函数体里的 import 会漏掉一整类依赖。实证：`prepare_noble_tip.py` 的
    `_wf_from` 用的 `resolve` 来自 `mast.core.noble_tip_workflow`，而那是一句
    **顶层** import —— 于是「`PulseConditionTip` 压着一张 1273 行的流程表」这件事
    在只看函数体的量法下**一个字都不会出现**。
    这正是 `blockers-7a.md` §7.1 那条「纪律说的是按什么单位追，没说追多深」的横向版本：
    **说了按函数体追，没说函数体之外那一半怎么办。**
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out: dict[str, tuple[str, str]] = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module \
                and node.module.split(".", 1)[0] == "mast":
            for alias in node.names:
                out[alias.asname or alias.name] = (node.module, alias.name)
    return out


# ══════════════════════════════════════════════════════════════════════════
# 批 7b-1：技能级的边表 —— 「这个技能自己还调谁」
# ══════════════════════════════════════════════════════════════════════════

#: 框架基类。它们的方法体**不追** —— `CompositeSkillGraph.step` 里那句
#: `context.run(skill_name, params)` 的动词是参数，每个继承者都会「命中」它，
#: 追进去只会给 500 个技能各记一条同样的 `<dynamic>`。它作为**一条**现场记在
#: `dynamic_run_sites` 里（`composite/_base.py:75`），那才是它该出现的地方。
FRAMEWORK_BASES = frozenset({"BaseSkill", "CompositeSkillGraph", "SpecComposite"})


#: 组合技能框架**自己**的内部相位名。`CompositeSkillGraph` 的包装层把
#: `ctx.run("_phase_*", …)` 短路掉，直接派到本类的计算方法上（旧仓
#: `composite/assess_quality.py:15` 写着这件事），**不过注册表**。
#: ⇒ 它们不是技能名，不该进 `runs`，更不该被闭包当成「一个还没落的封锁件」。
PHASE_PREFIX = "_phase"


class _Module:
    """一个 `mast/skills/**` 下的模块：类、模块级函数、以及能解到本树内的 import。"""

    __slots__ = ("rel", "dotted", "classes", "funcs", "names", "mods", "strs")

    def __init__(self, rel: str, dotted: str) -> None:
        self.rel = rel
        self.dotted = dotted
        self.classes: dict[str, ast.ClassDef] = {}
        self.funcs: dict[str, ast.AST] = {}
        #: `from …auto_tilt import _measure` → `{"_measure": ("composite/auto_tilt.py", "_measure")}`
        self.names: dict[str, tuple[str, str]] = {}
        #: `from mast.skills.composite import auto_tilt` → `{"auto_tilt": "composite/auto_tilt.py"}`
        self.mods: dict[str, str] = {}
        #: 模块级的字符串常量 —— 技能名大半写成 `_P_CLEAR = "_phase_clear"` 这种。
        #: 不解它，`POINT_ENGINE_SKILL = "SpectroscopyAtPositions"` 这条真边会被
        #: 当成「追不动」而漏掉；而那正是「追不动的清单越长，闭包越像手抄的」。
        self.strs: dict[str, str] = {}


def _index_skill_modules() -> tuple[dict[str, _Module], dict[str, str]]:
    """扫 `mast/skills/**`。返回 `(rel → 模块, 点分模块名 → rel)`。"""
    mods: dict[str, _Module] = {}
    by_dotted: dict[str, str] = {}
    for path in sorted(SKILLS_ROOT.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(SKILLS_ROOT).as_posix()
        dotted = "mast.skills." + rel[:-3].replace("/", ".")
        if dotted.endswith(".__init__"):
            dotted = dotted[: -len(".__init__")]
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:
            # 语法解析不动的文件整份跳过，并在 `closure_limits` 里报出来。
            mods[rel] = _Module(rel, dotted)
            by_dotted[dotted] = rel
            continue
        mod = _Module(rel, dotted)
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                mod.funcs[node.name] = node
            elif isinstance(node, ast.ClassDef):
                mod.classes[node.name] = node
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                val = node.value
                if isinstance(val, ast.Constant) and isinstance(val.value, str):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for t in targets:
                        if isinstance(t, ast.Name):
                            mod.strs[t.id] = val.value
        mod.funcs["__module__"] = tree  # 模块顶层语句也可能有 CompositeStep 字面量
        mods[rel] = mod
        by_dotted[dotted] = rel
    for rel, mod in mods.items():
        path = SKILLS_ROOT / rel
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:
            continue
        pkg = mod.dotted.rsplit(".", 1)[0] if "." in mod.dotted else mod.dotted
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parts = mod.dotted.split(".")
                    # `from . import x` 在包 `a.b.c` 里 ⇒ 基准是 `a.b`（level=1）
                    up = parts[: len(parts) - node.level]
                    base = ".".join(up + ([base] if base else []))
                elif not base.startswith("mast.skills"):
                    continue
                for alias in node.names:
                    local = alias.asname or alias.name
                    target = by_dotted.get(f"{base}.{alias.name}")
                    if target is not None:          # 导入的是一个**模块**
                        mod.mods[local] = target
                        continue
                    home = by_dotted.get(base)
                    if home is not None:            # 导入的是模块里的一个名字
                        mod.names[local] = (home, alias.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    target = by_dotted.get(alias.name)
                    if target is not None and alias.asname:
                        mod.mods[alias.asname] = target
        del pkg
    return mods, by_dotted


def _skill_classes(mods: dict[str, _Module]) -> dict[str, list[tuple[str, str]]]:
    """技能名 → `[(rel, 类名), …]`。名字从 `SkillMetadata(name=…)` 取。

    ⚠️ `name=` 也可能是模块级常量（`adatom_verify.py:31 _NAME = "VerifyAdatomAt"`）——
    只认字面量的话这个技能会「有人叫、没人定义」，在 `unknown_skills` 里挂一条**假**的。
    一条假的边界比没有边界更坏：它把「我们追不到」和「旧仓真的没有」混成一句话。
    """
    out: dict[str, list[tuple[str, str]]] = {}
    for rel, mod in sorted(mods.items()):
        for cname, cnode in sorted(mod.classes.items()):
            for node in ast.walk(cnode):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                if not (isinstance(fn, ast.Name) and fn.id == "SkillMetadata"):
                    continue
                for kw in node.keywords:
                    if kw.arg != "name":
                        continue
                    got = _as_str(kw.value, mod.strs)
                    if got is None:
                        continue
                    pair = (rel, cname)
                    if pair not in out.setdefault(got, []):
                        out[got].append(pair)
    return out


def _as_str(node: ast.expr, strs: dict[str, str]) -> str | None:
    """一个表达式的字符串值 —— 字面量 · 模块级常量 · 两者拼出来的 f-string。

    f-string 里填空的那一格（`f"{PREFIX}{i}"` 的 `i`）写成 `{…}`：
    前缀是确定的，尾巴不是，而**前缀就够判它是不是内部相位名**。
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return strs.get(node.id)
    if isinstance(node, ast.JoinedStr):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                out.append(part.value)
            elif isinstance(part, ast.FormattedValue):
                inner = _as_str(part.value, strs)
                out.append(inner if inner is not None else "{…}")
            else:
                return None
        return "".join(out)
    return None


def _is_ctx_run(fn: ast.expr) -> bool:
    """`context.run` / `ctx.run` / `self._context.run` —— 三种写法同一条边。

    第三种是**编排引擎自己**（`graph_executor.py:598/:601`）。漏掉它，
    「追不动的四型」里少掉一整型，而那一型恰好是所有 `CompositeStep` 真正落地的地方。
    """
    if not (isinstance(fn, ast.Attribute) and fn.attr == "run"):
        return False
    recv = fn.value
    if isinstance(recv, ast.Name):
        return recv.id in ("context", "ctx")
    if isinstance(recv, ast.Attribute):
        return recv.attr in ("_context", "context", "ctx")
    return False


def _run_target(node: ast.Call, strs: dict[str, str]) -> tuple[str | None, str] | None:
    """这个调用是不是一条「发子技能」的边？返回 `(名字或 None, 原表达式)`。

    ## 两条边，不是一条

    旧仓 `mast/skills/**` 里 `CompositeStep(` **299 处**、`context.run(` **63 处**
    （2026-09-20 实测）。只追后者等于只覆盖**五分之一**的边 ——
    而漏掉的那五分之四正是 `ScanAt` / `PreScanCheck` 压着的
    `SetScanBuffer` / `WaitScanComplete` / `SetZCtrlGain` / `SetScanSpeed`。

    名字解不出来时第一项给 `None`（同这台导出器横的那一维上的 `"<dynamic>"` ——
    **不许猜**）。
    """
    fn = node.func
    if _is_ctx_run(fn):
        if not node.args:
            return None, "<no args>"
        first = node.args[0]
        got = _as_str(first, strs)
        return (got, got) if got is not None else (None, ast.unparse(first))
    if isinstance(fn, ast.Name) and fn.id == "CompositeStep":
        for kw in node.keywords:
            if kw.arg == "skill_name":
                got = _as_str(kw.value, strs)
                return (got, got) if got is not None else (None, ast.unparse(kw.value))
    return None


def _methods(cnode: ast.ClassDef) -> list[ast.AST]:
    return [n for n in cnode.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


def _edges_of(
    rel: str, cname: str, mods: dict[str, _Module]
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """一个技能类能发出去的子技能。返回 `(名字 → 现场, 追不动的现场, 内部相位名 → 现场)`。

    起点是这个类的方法 + **同模块**基类的方法；从那里跟模块级函数，跨文件只跟
    `mast/skills/**` 之内的（见抬头那张表）。框架基类不追。
    """
    mod = mods[rel]
    units: list[ast.ClassDef] = []
    stack_c = [cname]
    while stack_c:
        cur = stack_c.pop()
        cnode = mod.classes.get(cur)
        if cnode is None or cnode in units:
            continue
        units.append(cnode)
        for base in cnode.bases:
            bn = base.id if isinstance(base, ast.Name) else (
                base.attr if isinstance(base, ast.Attribute) else "")
            if bn and bn not in FRAMEWORK_BASES and bn in mod.classes:
                stack_c.append(bn)

    hits: dict[str, list[dict[str, Any]]] = {}
    dyn: list[dict[str, Any]] = []
    phases: dict[str, list[dict[str, Any]]] = {}
    seen: set[tuple[str, int]] = set()
    work: list[tuple[str, ast.AST, list[ast.ClassDef]]] = [
        (rel, m, units) for c in units for m in _methods(c)]

    def push(target: tuple[str, str] | None) -> None:
        if target is None:
            return
        trel, tname = target
        tmod = mods.get(trel)
        if tmod is None:
            return
        node = tmod.funcs.get(tname)
        if node is not None and not isinstance(node, ast.Module):
            work.append((trel, node, []))
            return
        cnode2 = tmod.classes.get(tname)
        if cnode2 is not None:
            for m in _methods(cnode2):
                work.append((trel, m, [cnode2]))

    def resolve(cur_rel: str, call: ast.expr, cls_units: list[ast.ClassDef]) -> None:
        cur = mods[cur_rel]
        if isinstance(call, ast.Name):
            if call.id in cur.funcs and not isinstance(cur.funcs[call.id], ast.Module):
                push((cur_rel, call.id))
            elif call.id in cur.classes:
                push((cur_rel, call.id))
            elif call.id in cur.names:
                push(cur.names[call.id])
            return
        if isinstance(call, ast.Attribute) and isinstance(call.value, ast.Name):
            head = call.value.id
            if head == "self":
                for c in cls_units:
                    for m in _methods(c):
                        if getattr(m, "name", "") == call.attr:
                            work.append((cur_rel, m, cls_units))
                return
            if head in cur.mods:
                push((cur.mods[head], call.attr))
            elif head in cur.names:
                # `from … import mod_like_thing` 之后 `thing.attr(...)`：解不动，不猜。
                return

    while work:
        cur_rel, node, cls_units = work.pop()
        key = (cur_rel, id(node))
        if key in seen:
            continue
        seen.add(key)
        for sub in ast.walk(node):
            if not isinstance(sub, ast.Call):
                continue
            edge = _run_target(sub, mods[cur_rel].strs)
            if edge is not None:
                name, expr = edge
                site = {"file": cur_rel, "line": int(sub.lineno)}
                if name is None:
                    dyn.append({**site, "expr": expr})
                elif name.startswith(PHASE_PREFIX):
                    phases.setdefault(name, []).append(site)
                else:
                    hits.setdefault(name, []).append(site)
                continue
            resolve(cur_rel, sub.func, cls_units)
    for table in (hits, phases):
        for sites in table.values():
            sites.sort(key=lambda s: (s["file"], s["line"]))
    dyn.sort(key=lambda s: (s["file"], s["line"], s["expr"]))
    return hits, dyn, phases


#: 编排引擎自己的三个模块。它们的 `run(...)` 动词按定义是形参 —— 那不是
#: 「某个技能的名字追不出来」，是「这里本来就没有一个固定的名字」。
#: 分开记，否则四型里最好懂的那一型会混在「我们照不到」里。
ENGINE_MODULES = frozenset({
    "composite/_base.py",            # CompositeSkillGraph.step
    "composite/graph_executor.py",   # GraphExecutor 真正下发 CompositeStep 的那两行
    "composite/interpreter.py",      # 声明式 composite：步骤表来自 YAML
})


def _shape_of(expr_src: str, node: ast.expr | None) -> str:
    """追不动的**形状** —— 四型逐型在金样里留一格，别混成一句「追不动」。"""
    del expr_src
    if node is None:
        return "missing"
    if isinstance(node, ast.Name):
        return "loop_var"       # 循环变量 / 形参
    if isinstance(node, ast.JoinedStr):
        return "fstring"        # 拼出来的名字，且前缀也解不开
    if isinstance(node, ast.Subscript):
        return "subscript"      # 从一张表里取（声明式 spec）
    return type(node).__name__


def _all_dynamic_sites(mods: dict[str, _Module]) -> list[dict[str, Any]]:
    """整棵 `mast/skills/**` 里**每一处**动词解不出字符串的 `run(...)` / `CompositeStep(...)`。

    不限于闭包之内 —— 这一节回答的是「这套追法在旧仓里一共有几处照不到」，
    而那个数必须是**全量**的，否则它会随起点变，读的人就分不清
    「闭包里没有」与「这套追法看不见」。
    """
    out: list[dict[str, Any]] = []
    for rel, mod in sorted(mods.items()):
        path = SKILLS_ROOT / rel
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            edge = _run_target(node, mod.strs)
            if edge is None or edge[0] is not None:
                continue
            first: ast.expr | None = None
            if _is_ctx_run(node.func):
                first = node.args[0] if node.args else None
            else:
                first = next((k.value for k in node.keywords if k.arg == "skill_name"), None)
            out.append({
                "file": rel, "line": int(node.lineno), "expr": edge[1],
                "shape": _shape_of(edge[1], first),
                "in_engine": rel in ENGINE_MODULES,
            })
    out.sort(key=lambda s: (s["file"], s["line"], s["expr"]))
    return out


def _cycles(runs: dict[str, list[str]]) -> list[list[str]]:
    """技能图里的环。递归靠 `seen` 挡得住，**挡了什么要说出来**。"""
    found: set[tuple[str, ...]] = set()
    color: dict[str, int] = {}
    path: list[str] = []

    def walk(n: str) -> None:
        color[n] = 1
        path.append(n)
        for m in runs.get(n, []):
            c = color.get(m, 0)
            if c == 0:
                walk(m)
            elif c == 1:
                cyc = path[path.index(m):]
                lo = cyc.index(min(cyc))
                found.add(tuple(cyc[lo:] + cyc[:lo]))
        path.pop()
        color[n] = 2

    for n in sorted(runs):
        if color.get(n, 0) == 0:
            walk(n)
    return [list(c) for c in sorted(found)]


def build_skill_runs() -> tuple[dict[str, Any], dict[str, Any]]:
    """`(skill_runs, closure_limits)`。"""
    mods, _by_dotted = _index_skill_modules()
    defs = _skill_classes(mods)

    skill_runs: dict[str, Any] = {}
    phase_users: dict[str, list[str]] = {}
    for name in sorted(defs):
        places = sorted(defs[name])
        merged: dict[str, list[dict[str, Any]]] = {}
        dyn: list[dict[str, Any]] = []
        phases: dict[str, list[dict[str, Any]]] = {}
        for rel, cname in places:
            hits, d, ph = _edges_of(rel, cname, mods)
            for k, v in hits.items():
                merged.setdefault(k, []).extend(v)
            for k, v in ph.items():
                phases.setdefault(k, []).extend(v)
            dyn.extend(d)
        for sites in merged.values():
            sites.sort(key=lambda s: (s["file"], s["line"]))
        rec: dict[str, Any] = {
            "defined_in": [f"{rel}:{cname}" for rel, cname in places],
            "runs": sorted(merged),
        }
        if merged:
            rec["sites"] = {k: merged[k] for k in sorted(merged)}
        if dyn:
            rec["unresolved"] = sorted(
                ({"file": s["file"], "line": s["line"], "expr": s["expr"]} for s in dyn),
                key=lambda s: (s["file"], s["line"], s["expr"]))
        if phases:
            rec["internal_phases"] = sorted(phases)
        skill_runs[name] = rec
        for p in phases:
            phase_users.setdefault(p, []).append(name)

    runs_only = {k: list(v["runs"]) for k, v in skill_runs.items()}
    called = {m for v in runs_only.values() for m in v}
    limits: dict[str, Any] = {
        "scanned_root": "mast/skills",
        "modules_scanned": len(mods),
        "skills_indexed": len(skill_runs),
        "follow_rule": (
            "技能类的方法 + **同模块**基类的方法 → 从那里可达的、`mast/skills/**` 之内的"
            "模块级函数与同模块类（跨文件跟 `from … import`）。"
            "框架基类（BaseSkill / CompositeSkillGraph / SpecComposite）的方法体不追；"
            "`mast/skills/**` 之外的函数（mast.core / mast.io / mast.vision）不追。"
            "边认两种形状：`context.run(X, …)`/`ctx.run(X, …)` 与 "
            "`CompositeStep(skill_name=X, …)`，其中 X 是字面量、模块级字符串常量，"
            "或由这两者拼出来的 f-string（填空那一格写成 {…}）。"),
        # 被谁叫到、而这张表里**找不到定义**的名字。闭包走到这儿就停 —— 显式记着，
        # 不当成叶子。
        "unknown_skills": sorted(called - set(skill_runs)),
        "dynamic_run_sites": _all_dynamic_sites(mods),
        # 框架内部相位名（`_phase*`）—— 解得出名字，但它们不过注册表，不是技能。
        # 记在这儿而不是 `runs` 里：进了 `runs` 就会被闭包当成一个「还没落的封锁件」。
        "internal_phase_targets": {
            p: sorted(set(phase_users[p])) for p in sorted(phase_users)},
        "cycles": _cycles(runs_only),
    }
    return skill_runs, limits


def main() -> int:
    fns: dict[str, dict[str, _Fn]] = {m: _collect(p) for m, p in SOURCES.items()}
    imports: dict[str, dict[str, str]] = {m: _imports(p) for m, p in SOURCES.items()}
    toplevel: dict[str, dict[str, tuple[str, str]]] = {
        m: _toplevel_mast(p) for m, p in SOURCES.items()}

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

    skill_runs, limits = build_skill_runs()

    out: dict[str, Any] = {
        "_note": (
            "批 6a：`_tip_phases` 六个流程的子技能依赖，从旧仓源码静态算出来的**上界**。"
            "由 tools/spec-export/export_tip_phase_deps.py 生成，不要手工改。"
            " 批 7b-1 加了 `skill_runs`（每个技能自己还调谁）与 `closure_limits`"
            "（这套追法追到哪儿为止）—— 封锁账的 BLOCKED 按**闭包**算，不是一层。"
        ),
        "skill_runs": skill_runs,
        "closure_limits": limits,
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

        # ── 非技能依赖（批 7b-1 加）─────────────────────────────────────
        #
        # ⚠️ **闭包是「技能 → 技能」那一维的闭包。** 两条流程（`PulseConditionTip` /
        # `PokeConditionTip`）的封锁件按闭包算是**空的** —— 而它们今天仍然移不了，
        # 因为它们缺的东西**不是技能**：一张流程表（`core.noble_tip_workflow`）、
        # 一条地图写侧（`core.map_scope.record_damage_marker`）。
        #
        # 这与 `blockers-7a.md` §7.1 第 4 行（`BiasWiggle` 缺的是「本仓要先长出一条
        # 中止清理通道」）是同一个形状：**一个只数技能的账，数不出非技能的债。**
        # 所以这一节把闭包里每个函数**体内**的 `mast.*` import 原样列出来 ——
        # 它不判「本仓有没有」（那要一张模块对照表，那是另一件事），
        # 它只保证那一维**在账上有一行**，而不是只活在某份交接的散文里。
        nonskill: dict[str, list[str]] = {}

        def _note(mod_name: str, sym: str) -> None:
            nonskill.setdefault(mod_name, [])
            if sym not in nonskill[mod_name]:
                nonskill[mod_name].append(sym)

        for m, k in seen:
            for mod_name, sym in fns[m][k].imports:
                _note(mod_name, sym)
            # 顶层 import 进来、而**这个闭包真的调到了**的那些。
            # 只记「调到了」的，不记整份顶层 import —— 后者会把 `_tip_phases.py`
            # 顶上那一长串塞进每一条流程，而其中大半这条流程根本走不到。
            for call in fns[m][k].calls:
                bare = call.split(".", 1)[0] if call.startswith("self.") else call
                if bare == "self":
                    continue
                hit = toplevel[m].get(bare)
                if hit is not None and resolve(m, bare) is None:
                    _note(hit[0], hit[1])

        out["skills"][skill] = {
            "entry": f"{module}:{entry}",
            # 这个技能的**全部**代码面：闭包里每个函数的行数。交接里那句
            # 「差哪个函数、多少行」就是从这儿来的。
            "functions": sorted(f"{m}:{k}" for m, k in seen),
            "code_lines": sum(
                fns[m][k].last_line - fns[m][k].first_line + 1 for m, k in seen),
            "sub_skills": {k: subs[k] for k in sorted(subs)},
            "non_skill_deps": {k2: sorted(nonskill[k2]) for k2 in sorted(nonskill)},
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True,
                   allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    def closure(flow: str) -> set[str]:
        seen_s: set[str] = set()
        stack_s = list(out["skills"][flow]["sub_skills"])
        while stack_s:
            n = stack_s.pop()
            if n in seen_s:
                continue
            seen_s.add(n)
            rec = skill_runs.get(n)
            if rec is not None:
                stack_s.extend(rec["runs"])
        return seen_s

    for skill, _m, _e in ENTRIES:
        d = out["skills"][skill]
        print(f"[ok]   {skill:<24} {len(d['sub_skills']):>2} 个子技能（闭包 "
              f"{len(closure(skill)):>2}）· {len(d['functions']):>2} 个函数 / "
              f"{d['code_lines']} 行")
    print(f"[ok]   skill_runs {limits['skills_indexed']} 个技能 / "
          f"{limits['modules_scanned']} 个模块 · "
          f"追不动 {len(limits['dynamic_run_sites'])} 处 · "
          f"找不到定义 {len(limits['unknown_skills'])} 个 · "
          f"内部相位 {len(limits['internal_phase_targets'])} 个 · "
          f"环 {len(limits['cycles'])} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
