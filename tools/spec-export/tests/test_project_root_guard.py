"""`_paths` 对 `MAST2_PROJECT_ROOT` 的护栏：只用标准库，不需要 MAST 与 NumPy。

    python -m unittest discover -s tools/spec-export/tests -v

参考实现的 `project_root()` 先读这个变量（去掉首尾空白）；没设、是空串或只有空白，就退回 `MAST_ROOT`
的上一级，也就是实仓或运行器的快照。`os.environ.setdefault` 不会替换已经存在的空串，而导出器 `main()`
清断点的循环删的正是那个根下面的文件。所以参考实现真正会用的那个值若是空的，或落在实仓、快照及其之下，
一律拒绝（状态 1）；正常的临时目录照常放行。
"""

from __future__ import annotations

import ast
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

EXPORTER_DIR = Path(__file__).resolve().parents[1]
if str(EXPORTER_DIR) not in sys.path:
    sys.path.insert(0, str(EXPORTER_DIR))

import _paths  # noqa: E402

#: 子进程里要删掉的变量前缀，同运行器的 `child_env`：残留的 `MAST_ROOT` / `PYTHONPATH` 会让结果取决于本机。
_STRIPPED = ("PYTHON", "MAST", "STMSIM", "VISTA")


def _tmpdir(case: unittest.TestCase, prefix: str) -> Path:
    path = Path(tempfile.mkdtemp(prefix=prefix)).resolve()
    case.addCleanup(shutil.rmtree, path, ignore_errors=True)
    return path


def _listing(root: Path) -> list[tuple[str, int]]:
    return sorted((p.relative_to(root).as_posix(), p.stat().st_size if p.is_file() else -1)
                  for p in root.rglob("*"))


class _Trees(unittest.TestCase):
    """一份实仓（`repo/MASTv2/mast`，带一个断点哨兵）、一份快照（`stage/mast/<提交>/MASTv2/mast`），
    以及与两者都无关的 `elsewhere/`。三个变量在每个用例开始时都清掉，结束时整个环境还原。"""

    def setUp(self) -> None:
        self.tmp = _tmpdir(self, "project-root-guard-")
        self.repo = self.tmp / "repo"
        self.snapshot = self.tmp / "stage" / "mast" / ("a" * 40)
        for tree in (self.repo, self.snapshot):
            (tree / "MASTv2" / "mast").mkdir(parents=True)
        self.sentinel = self.repo / "experiments" / "composite_progress" / "sentinel.json"
        self.sentinel.parent.mkdir(parents=True)
        self.sentinel.write_text("{}\n", encoding="utf-8")
        self.elsewhere = self.tmp / "elsewhere"
        self.elsewhere.mkdir()
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        for var in ("MAST2_PROJECT_ROOT", "MAST_ROOT", "MAST_REPO"):
            os.environ.pop(var, None)

    def refusal(self, project_root: str | Path, *, mast_root: Path, repo: Path | None = None) -> str | None:
        os.environ["MAST_ROOT"] = str(mast_root)
        if repo is not None:
            os.environ["MAST_REPO"] = str(repo)
        os.environ["MAST2_PROJECT_ROOT"] = str(project_root)
        return _paths.project_root_refusal()


class RefusalTests(_Trees):
    def test_unset_is_refused_in_its_own_words(self) -> None:
        # 判的是参考实现会用的值：没设与空串一样会退回它自己的树，但说法分开
        os.environ["MAST_ROOT"] = str(self.repo / "MASTv2")
        reason = _paths.project_root_refusal() or ""
        self.assertIn("not set", reason)
        self.assertNotIn("empty", reason)

    def test_empty_or_blank_is_refused(self) -> None:
        # 参考实现先 strip：只有空白也会退回它自己的树
        for value in ("", "  ", "\t"):
            with self.subTest(value=value):
                reason = self.refusal(value, mast_root=self.repo / "MASTv2") or ""
                self.assertIn("empty", reason)
                self.assertNotIn("not set", reason)

    def test_the_checkout_and_anything_below_it_are_refused(self) -> None:
        for root in (self.repo, self.repo / "experiments", self.repo / "MASTv2", self.repo / "MASTv2" / "mast"):
            with self.subTest(root=root.relative_to(self.tmp).as_posix()):
                reason = self.refusal(root, mast_root=self.repo / "MASTv2")
                self.assertIn(f"inside the reference tree {self.repo}", reason or "")

    def test_the_snapshot_and_anything_below_it_are_refused(self) -> None:
        for root in (self.snapshot, self.snapshot / "experiments", self.snapshot / "MASTv2"):
            with self.subTest(root=root.relative_to(self.tmp).as_posix()):
                reason = self.refusal(root, mast_root=self.snapshot / "MASTv2")
                self.assertIn(f"inside the reference tree {self.snapshot}", reason or "")

    def test_the_runner_checkout_is_refused_when_mast_root_is_a_snapshot(self) -> None:
        # 只有 `MAST_REPO` 说得出实仓在哪：`MAST_ROOT` 指着快照时，它的上一级是快照根
        inside = self.repo / "experiments"
        self.assertIsNone(self.refusal(inside, mast_root=self.snapshot / "MASTv2"))
        reason = self.refusal(inside, mast_root=self.snapshot / "MASTv2", repo=self.repo)
        self.assertIn(f"inside the reference tree {self.repo}", reason or "")

    def test_a_relative_value_resolves_against_the_working_directory_as_the_reference_does(self) -> None:
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        os.chdir(self.repo)
        self.assertIn("inside the reference tree", self.refusal("experiments", mast_root=self.repo / "MASTv2") or "")

    def test_temporary_directories_outside_both_trees_are_fine(self) -> None:
        runner_pr = self.tmp / "stage" / "runs" / "45e3e806-1" / "pr" / "safety_spec"  # 运行器的布局
        for root, mast_root in ((self.elsewhere, self.repo / "MASTv2"),
                                (self.tmp / "repo-copy", self.repo / "MASTv2"),  # 只是前缀相同，不在里面
                                (runner_pr, self.snapshot / "MASTv2")):
            with self.subTest(root=root.relative_to(self.tmp).as_posix()):
                self.assertIsNone(self.refusal(root, mast_root=mast_root, repo=self.repo))


class IsolatedProjectRootTests(_Trees):
    def test_unset_takes_the_fallback(self) -> None:
        fallback = str(self.elsewhere / "fallback")
        self.assertEqual(_paths.isolated_project_root(fallback), fallback)
        self.assertEqual(os.environ["MAST2_PROJECT_ROOT"], fallback)

    def test_a_value_already_set_is_kept(self) -> None:
        os.environ["MAST2_PROJECT_ROOT"] = str(self.elsewhere)
        self.assertEqual(_paths.isolated_project_root(str(self.tmp / "unused")), str(self.elsewhere))

    def test_an_unsafe_value_exits_with_status_1_and_is_not_replaced(self) -> None:
        os.environ["MAST_ROOT"] = str(self.repo / "MASTv2")
        for value in ("", str(self.repo / "experiments")):
            with self.subTest(value=value):
                os.environ["MAST2_PROJECT_ROOT"] = value
                with self.assertRaises(SystemExit) as stop:
                    _paths.isolated_project_root(str(self.elsewhere))
                # `SystemExit` 带字符串时退出状态是 1，字符串打到 stderr
                self.assertIsInstance(stop.exception.code, str)
                self.assertTrue(str(stop.exception.code).startswith("refused: "))
                self.assertEqual(os.environ["MAST2_PROJECT_ROOT"], value)

    def test_the_fallback_is_judged_like_any_other_value(self) -> None:
        # 判的是 setdefault 之后的值：兜底目录落进实仓同样拒绝
        os.environ["MAST_ROOT"] = str(self.repo / "MASTv2")
        with self.assertRaises(SystemExit) as stop:
            _paths.isolated_project_root(str(self.repo / "scratch"))
        self.assertIn("inside the reference tree", str(stop.exception.code))


def _child_env(**set_: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(_STRIPPED)}
    env.update(set_, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    return env


def _mast_exporters() -> list[Path]:
    """调 `require_mast_root()` 的导出器：会 import 参考实现的那些。"""
    found = []
    for script in sorted(EXPORTER_DIR.glob("export_*.py")):
        calls = {n.func.id for n in ast.walk(ast.parse(script.read_text(encoding="utf-8")))
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
        if "require_mast_root" in calls:
            found.append(script)
    return found


class ImportTimeTests(_Trees):
    """真起子进程：已经设了的值在 `import _paths` 那一刻就判，导出器作为 `fallback` 传进来的临时目录还没建。"""

    def setUp(self) -> None:
        super().setUp()
        self.temp = self.tmp / "temp"  # 子进程的 TEMP / TMP / TMPDIR
        self.temp.mkdir()

    def run_child(self, argv: list[str], cwd: Path, **set_: str) -> subprocess.CompletedProcess[str]:
        env = _child_env(**set_, TEMP=str(self.temp), TMP=str(self.temp), TMPDIR=str(self.temp))
        return subprocess.run([sys.executable, "-B", *argv], cwd=cwd, env=env,
                              capture_output=True, text=True, encoding="utf-8", timeout=120)

    def test_importing_paths_judges_a_value_already_set(self) -> None:
        mast_root = str(self.repo / "MASTv2")
        for value in ("", str(self.repo / "experiments")):
            with self.subTest(value=value):
                proc = self.run_child(["-c", "import _paths"], EXPORTER_DIR,
                                      MAST_ROOT=mast_root, MAST2_PROJECT_ROOT=value)
                self.assertEqual(proc.returncode, 1, proc.stderr)
                self.assertTrue(proc.stderr.startswith("refused: "), proc.stderr)
        # 没设的值留给 `isolated_project_root` 去填：导入时不判
        for label, value in (("safe", {"MAST2_PROJECT_ROOT": str(self.elsewhere)}), ("unset", {})):
            with self.subTest(value=label):
                proc = self.run_child(["-c", "import _paths"], EXPORTER_DIR, MAST_ROOT=mast_root, **value)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_every_exporter_stops_before_it_touches_anything(self) -> None:
        # 没有 NumPy 的环境里（CI 就是），在 `_paths` 之前 import 第三方包的导出器会因 ImportError 失败：
        # 这条用例因此也要求标准库之外第一个被 import 的是 `_paths`。
        scripts = _mast_exporters()
        self.assertGreaterEqual(len(scripts), 45)  # 防空转
        before = _listing(self.tmp)
        for script in scripts:
            with self.subTest(script.name):
                proc = self.run_child([str(script)], self.elsewhere,
                                      MAST_ROOT=str(self.repo / "MASTv2"), MAST2_PROJECT_ROOT="")
                # 先查什么都没碰：TEMP 还是空的，两棵树与工作目录一个字节没变，哨兵还在
                self.assertEqual(_listing(self.tmp), before)
                self.assertTrue(self.sentinel.is_file())
                self.assertEqual(proc.returncode, 1, proc.stderr)
                self.assertTrue(proc.stderr.startswith("refused: "), proc.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
