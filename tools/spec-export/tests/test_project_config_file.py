"""`_paths.ProjectConfigFile` 的单测：导出器只许往隔离的项目根里写配置文件，只许删自己写的那份。

    python -m unittest discover -s tools/spec-export/tests -p "test_project_config_file.py" -v

只用标准库：参考实现那两个函数（配置文件在哪、清缓存）用假的代替，不需要 MAST。
哨兵文件代表别人的东西 —— 不论哪条拒绝触发，它的内容都不许变，缓存也不许被清。
每条拒绝都分「目标处有哨兵」与「目标处什么都没有」两种：前者会被「不是本进程写的」这一条顺手拦下，
只有后者才能单独看出根的检查有没有在起作用（没拦住的话会新建一个文件）。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

EXPORTER_DIR = Path(__file__).resolve().parents[1]
if str(EXPORTER_DIR) not in sys.path:
    sys.path.insert(0, str(EXPORTER_DIR))

from _paths import ProjectConfigFile  # noqa: E402

NAME = "nanonis_motor_groups.json"
SENTINEL = '{"stm_coarse_group": 4}'
CONTENTS = (None, {"stm_coarse_group": 2})


class _Case(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="project-config-file-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # 参考仓：MASTv2/ 与它的上一级（真仓的根、快照的根）都算「参考树」。
        self.mast_root = self.tmp / "snapshot" / "MASTv2"
        self.mast_root.mkdir(parents=True)
        self.resets = 0
        self.target: Path | None = None

    def use_root(self, root: Path, target: Path | None = None) -> ProjectConfigFile:
        """参考实现的 `project_root()` 取环境变量；`target` 缺省 = `<root>/config/<NAME>`。"""
        self.target = target if target is not None else root / "config" / NAME
        patch = mock.patch.dict(os.environ, {"MAST2_PROJECT_ROOT": str(root)})
        patch.start()
        self.addCleanup(patch.stop)
        return ProjectConfigFile(lambda: self.target, self._reset, self.mast_root)

    def _reset(self) -> None:
        self.resets += 1

    def assert_refused(self, cfg: ProjectConfigFile, target: Path, *, planted: bool) -> None:
        """两种内容都退出（状态非零）、不清缓存；有哨兵则内容不变，没哨兵则不新建任何东西。"""
        if planted:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(SENTINEL, encoding="utf-8")
        for content in CONTENTS:
            with self.assertRaises(SystemExit) as raised:
                cfg.apply(content)
            self.assertNotIn(raised.exception.code, (None, 0))
        self.assertEqual(self.resets, 0)
        if planted:
            self.assertEqual(target.read_text(encoding="utf-8"), SENTINEL)
            shutil.rmtree(target.parent)  # 下一个子用例从空的目标重新开始
        else:
            self.assertFalse(target.exists())
            self.assertFalse(target.parent.exists())


class IsolatedRootTests(_Case):
    def test_writes_then_clears_in_both_root_layouts(self) -> None:
        # 运行器预设的根（暂存区里的 pr/<名>），以及导出器自己 mkdtemp 出来的根。
        layouts = {
            "runner": self.tmp / "runs" / "k-1" / "pr" / "batch5b",
            "mkdtemp": Path(tempfile.mkdtemp(prefix="mast-b5b-")).resolve(),
        }
        self.addCleanup(shutil.rmtree, layouts["mkdtemp"], ignore_errors=True)
        for label, root in layouts.items():
            with self.subTest(layout=label):
                self.resets = 0
                root.mkdir(parents=True, exist_ok=True)
                cfg = self.use_root(root)
                assert self.target is not None
                cfg.apply({"stm_coarse_group": 2})
                self.assertEqual(json.loads(self.target.read_text(encoding="utf-8")), {"stm_coarse_group": 2})
                self.assertEqual(self.resets, 2)  # 删之后一次，写之后一次：缓存按 mtime，同一秒内改写会读到旧的
                cfg.apply(None)
                self.assertFalse(self.target.exists())
                self.assertTrue(self.target.parent.is_dir())
                self.assertEqual(self.resets, 3)

    def test_a_file_this_run_wrote_is_replaced_not_refused(self) -> None:
        cfg = self.use_root(self.tmp / "pr")
        assert self.target is not None
        cfg.apply({"stm_coarse_group": 1})
        cfg.apply({"stm_coarse_group": 3})
        self.assertEqual(json.loads(self.target.read_text(encoding="utf-8")), {"stm_coarse_group": 3})

    def test_non_dict_content_leaves_no_file(self) -> None:
        cfg = self.use_root(self.tmp / "pr")
        assert self.target is not None
        for content in (None, "unreadable", [1, 2]):
            with self.subTest(content=content):
                cfg.apply({"stm_coarse_group": 1})
                cfg.apply(content)
                self.assertFalse(self.target.exists())


class RefusalTests(_Case):
    def test_root_inside_the_reference_tree_exits_and_touches_nothing(self) -> None:
        for label, root in {
            "snapshot root": self.mast_root.parent,
            "MASTv2 itself": self.mast_root,
            "below MASTv2": self.mast_root / "scratch",
        }.items():
            for planted in (False, True):
                with self.subTest(root=label, planted=planted):
                    self.resets = 0
                    cfg = self.use_root(root)
                    assert self.target is not None
                    self.assert_refused(cfg, self.target, planted=planted)

    def test_empty_root_exits_and_touches_nothing(self) -> None:
        # 变量为空时参考实现落到自己的树上，那里放的是真机配置。空串解析成当前目录，
        # 而当前目录可以恰好是参考树的上一级 —— 所以这里把它挪到那里，别的检查就都放行了。
        cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, cwd)
        fallback = self.mast_root.parent / "config" / NAME
        for raw in ("", "   "):
            for planted in (False, True):
                with self.subTest(raw=raw, planted=planted):
                    self.resets = 0
                    with mock.patch.dict(os.environ, {"MAST2_PROJECT_ROOT": raw}):
                        cfg = ProjectConfigFile(lambda: fallback, self._reset, self.mast_root)
                        self.assert_refused(cfg, fallback, planted=planted)

    def test_target_outside_the_root_exits_and_touches_nothing(self) -> None:
        elsewhere = self.tmp / "elsewhere" / "config" / NAME
        for planted in (False, True):
            with self.subTest(planted=planted):
                self.resets = 0
                cfg = self.use_root(self.tmp / "pr", target=elsewhere)
                self.assert_refused(cfg, elsewhere, planted=planted)

    def test_a_file_this_run_did_not_write_is_not_deleted(self) -> None:
        cfg = self.use_root(self.tmp / "pr")
        assert self.target is not None
        self.assert_refused(cfg, self.target, planted=True)


if __name__ == "__main__":
    unittest.main()
