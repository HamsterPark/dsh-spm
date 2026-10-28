"""`export_tip_phase_deps.py` 认全技能名的三种声明形式，并与 `skills.json` 对账。

    python -m unittest discover -s tools/spec-export/tests -p "test_tip_phase_names.py" -v

合成一棵最小的 `mast/skills/**` 放进临时目录当 `MAST_ROOT`，不读真的旧仓。导出器在 import 时就求值
`MAST_ROOT` / `SKILLS_ROOT`，所以每个用例都重新 import 一份（先 `sys.modules.pop`）。
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock

EXPORTER_DIR = Path(__file__).resolve().parents[1]
EXPORTER = "export_tip_phase_deps"


class _SyntheticTree(unittest.TestCase):
    """每个用例一棵临时的 `mast/skills/**`，以及一份重新 import 的导出器。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="tip-phase-names-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = self.tmp / "mast_root"
        self.skills = self.root / "mast" / "skills"
        (self.skills / "builtins").mkdir(parents=True)

        # 导出器 import 时读 MAST_ROOT，还会 `setdefault` 一个 MAST2_PROJECT_ROOT ——
        # patch.dict 在用例结束时把环境整个还原。
        env = mock.patch.dict(os.environ, {"MAST_ROOT": str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        # 同一句 `setdefault` 的实参是 `tempfile.mkdtemp(...)`，不管变量设没设都会建一个目录：
        # 让它建在本用例的临时目录里，一并清掉。
        tmpdir = mock.patch.object(tempfile, "tempdir", str(self.tmp))
        tmpdir.start()
        self.addCleanup(tmpdir.stop)
        path = mock.patch.object(sys, "path", [str(EXPORTER_DIR), *sys.path])
        path.start()
        self.addCleanup(path.stop)

    def load(self) -> ModuleType:
        sys.modules.pop(EXPORTER, None)
        self.addCleanup(sys.modules.pop, EXPORTER, None)
        return importlib.import_module(EXPORTER)

    def write(self, rel: str, source: str) -> None:
        path = self.skills / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(textwrap.dedent(source).lstrip("\n").encode("utf-8"))

    def indexed(self, files: dict[str, str]) -> dict[str, list[tuple[str, str]]]:
        """写下这些合成模块，跑名字索引，返回 `技能名 → [(文件, 类名)]`。"""
        for rel, source in files.items():
            self.write(rel, source)
        ex = self.load()
        mods, _by_dotted = ex._index_skill_modules()
        return ex._skill_classes(mods)


class SkillNameFormsTests(_SyntheticTree):
    """名字的三种声明形式，以及它们各自的边界。"""

    def test_literal_and_module_constant_names(self) -> None:
        # 回归：这两种本来就认。
        got = self.indexed({
            "builtins/alpha.py": '''
                _N = "Beta"

                class Alpha:
                    def metadata(self):
                        return SkillMetadata(name="Alpha", version="1.0.0")

                class Second:
                    def metadata(self):
                        return SkillMetadata(name=_N, version="1.0.0")
            ''',
        })
        self.assertEqual(got, {
            "Alpha": [("builtins/alpha.py", "Alpha")],
            "Beta": [("builtins/alpha.py", "Second")],
        })

    def test_self_name_resolves_the_class_attribute(self) -> None:
        # 基类的 `NAME = ""` 只是占位；子类用元组拆包、普通赋值、带注解的赋值各写一次。
        got = self.indexed({
            "builtins/spectro.py": '''
                class _SettingSkill:
                    NAME = ""
                    PARAM = ""

                class Gamma(_SettingSkill):
                    NAME, PARAM = "Gamma", "p"

                    def metadata(self):
                        return SkillMetadata(name=self.NAME, version="1.0.0")

                class Delta(_SettingSkill):
                    NAME = "Delta"

                    def metadata(self):
                        return SkillMetadata(name=self.NAME, version="1.0.0")

                class Eta(_SettingSkill):
                    NAME: str = "Eta"

                    def metadata(self):
                        return SkillMetadata(name=self.NAME, version="1.0.0")

                class Iota(_SettingSkill):
                    NAME = "Iota"

                    @classmethod
                    def metadata(cls):
                        return SkillMetadata(name=cls.NAME, version="1.0.0")
            ''',
        })
        self.assertEqual(sorted(got), ["Delta", "Eta", "Gamma", "Iota"])
        self.assertNotIn("", got)  # 空串占位不是名字

    def test_name_is_inherited_from_a_base_in_the_same_module(self) -> None:
        got = self.indexed({
            "builtins/base.py": '''
                class Base:
                    NAME = "Theta"

                class Child(Base):
                    def metadata(self):
                        return SkillMetadata(name=self.NAME, version="1.0.0")
            ''',
        })
        self.assertEqual(got, {"Theta": [("builtins/base.py", "Child")]})

    def test_empty_placeholder_is_not_a_name(self) -> None:
        # 基类的空串只是占位：没有谁给过真名字 ⇒ 没有名字。
        got = self.indexed({
            "builtins/placeholder.py": '''
                class Base:
                    NAME = ""

                class Child(Base):
                    def metadata(self):
                        return SkillMetadata(name=self.NAME, version="1.0.0")
            ''',
        })
        self.assertEqual(got, {})

    def test_a_subclass_placeholder_shadows_the_base_name(self) -> None:
        # 和 Python 的属性查找一致：子类自己赋过值（哪怕是空串占位）就以它为准，不再往基类找。
        got = self.indexed({
            "builtins/shadow.py": '''
                class Base:
                    NAME = "Shadowed"

                class Child(Base):
                    NAME = ""

                    def metadata(self):
                        return SkillMetadata(name=self.NAME, version="1.0.0")
            ''',
        })
        self.assertEqual(got, {})

    def test_an_empty_literal_name_is_not_a_skill(self) -> None:
        got = self.indexed({
            "builtins/blank.py": '''
                class Blank:
                    def metadata(self):
                        return SkillMetadata(name="", version="1.0.0")
            ''',
        })
        self.assertEqual(got, {})

    def test_factory_call_declares_the_name(self) -> None:
        got = self.indexed({
            "builtins/ters.py": '''
                class Epsilon:
                    def metadata(self):
                        return ters_metadata(
                            name="Epsilon", description="d", parameters=[], tags=[], duration_s=1.0)
            ''',
        })
        self.assertEqual(got, {"Epsilon": [("builtins/ters.py", "Epsilon")]})

    def test_a_factory_that_is_not_listed_is_not_guessed(self) -> None:
        # 工厂名是显式常量，不做自动探测；认不出的由对账报出来（见下面的接线用例）。
        got = self.indexed({
            "builtins/other.py": '''
                class Omega:
                    def metadata(self):
                        return other_metadata(name="Omega")
            ''',
        })
        self.assertEqual(got, {})

    def test_a_base_class_in_another_module_is_not_followed(self) -> None:
        # 文档化的边界：只沿同模块基类向上找。
        got = self.indexed({
            "builtins/a.py": '''
                class Base:
                    NAME = "Cross"
            ''',
            "builtins/b.py": '''
                from mast.skills.builtins.a import Base

                class Child(Base):
                    def metadata(self):
                        return SkillMetadata(name=self.NAME, version="1.0.0")
            ''',
        })
        self.assertEqual(got, {})


class CheckIndexCompleteTests(_SyntheticTree):
    """对账函数本身：四类问题分开报。"""

    def test_equal_sets_pass(self) -> None:
        ex = self.load()
        self.assertEqual(ex.check_index_complete({"A", "B"}, {"A", "B"}, {}), [])

    def test_registered_but_not_indexed_is_reported(self) -> None:
        ex = self.load()
        problems = ex.check_index_complete({"A"}, {"A", "B"}, {})
        self.assertEqual(len(problems), 1)
        self.assertIn("没有被索引", problems[0])
        self.assertIn("B", problems[0])

    def test_a_known_exception_silences_the_missing_name(self) -> None:
        ex = self.load()
        self.assertEqual(ex.check_index_complete({"A"}, {"A", "B"}, {"B": "静态追不到：理由"}), [])

    def test_a_known_exception_that_is_now_indexed_is_stale(self) -> None:
        ex = self.load()
        problems = ex.check_index_complete({"A", "B"}, {"A", "B"}, {"B": "理由"})
        self.assertEqual(len(problems), 1)
        self.assertIn("其实已经能索引了", problems[0])
        self.assertIn("B", problems[0])

    def test_indexed_but_not_registered_is_extra(self) -> None:
        ex = self.load()
        problems = ex.check_index_complete({"A", "Z"}, {"A"}, {})
        self.assertEqual(len(problems), 1)
        self.assertIn("索引到了", problems[0])
        self.assertIn("Z", problems[0])

    def test_a_known_exception_missing_from_the_registry_is_reported(self) -> None:
        ex = self.load()
        problems = ex.check_index_complete({"A"}, {"A"}, {"Ghost": "理由"})
        self.assertEqual(len(problems), 1)
        self.assertIn("KNOWN_UNINDEXED 里的名字", problems[0])
        self.assertIn("Ghost", problems[0])


class BuildSkillRunsWiringTests(_SyntheticTree):
    """对账接进了 `build_skill_runs`：对不上就整个导出失败，而不是静默少一行。"""

    SOURCE = '''
        class Alpha:
            def metadata(self):
                return SkillMetadata(name="Alpha", version="1.0.0")

        class Beta:
            def metadata(self):
                return ters_metadata(name="Beta", description="d", parameters=[], tags=[], duration_s=1.0)
    '''

    def prepare(self, registry: list[str] | None) -> ModuleType:
        """写下合成模块；把导出器的 `OUT` 指到临时目录，并按 `registry` 写一份 `skills.json`
        （`None` = 不写，模拟没跑 export_mast_spec）。"""
        self.write("builtins/alpha.py", self.SOURCE)
        ex = self.load()
        out_dir = self.tmp / "golden"
        out_dir.mkdir()
        ex.OUT = out_dir / "tip_phase_deps.json"
        if registry is not None:
            (out_dir / "skills.json").write_text(
                json.dumps({f"{name}@1.0.0": {} for name in registry}), encoding="utf-8")
        return ex

    def test_complete_registry_passes_and_the_counts_agree(self) -> None:
        ex = self.prepare(["Alpha", "Beta"])
        skill_runs, limits = ex.build_skill_runs()
        self.assertEqual(sorted(skill_runs), ["Alpha", "Beta"])
        self.assertEqual(limits["skills_indexed"], 2)
        # 为空时不加这个键 —— 这是已有金样逐字节不变的前提
        self.assertNotIn("unindexed_skills", limits)

    def test_a_registered_skill_the_index_missed_aborts_the_export(self) -> None:
        ex = self.prepare(["Alpha", "Beta", "Lost"])
        with self.assertRaises(SystemExit) as raised:
            ex.build_skill_runs()
        self.assertIn("Lost", str(raised.exception))

    def test_dropping_a_factory_from_the_list_fails_loudly(self) -> None:
        # 手工反例的自动版：去掉 `ters_metadata`，经它声明的技能必须被对账报出来。
        ex = self.prepare(["Alpha", "Beta"])
        with mock.patch.object(ex, "METADATA_FACTORIES", frozenset({"SkillMetadata"})):
            with self.assertRaises(SystemExit) as raised:
                ex.build_skill_runs()
        self.assertIn("Beta", str(raised.exception))
        self.assertNotIn("Alpha", str(raised.exception))

    def test_a_known_exception_is_recorded_in_the_limits(self) -> None:
        ex = self.prepare(["Alpha", "Beta", "Lost"])
        with mock.patch.object(ex, "KNOWN_UNINDEXED", {"Lost": "静态追不到：测试里的理由"}):
            skill_runs, limits = ex.build_skill_runs()
        self.assertEqual(sorted(skill_runs), ["Alpha", "Beta"])
        self.assertEqual(limits["skills_indexed"], 2)
        self.assertEqual(limits["unindexed_skills"], {"Lost": "静态追不到：测试里的理由"})

    def test_missing_skills_json_says_what_to_run_first(self) -> None:
        ex = self.prepare(None)
        with self.assertRaises(SystemExit) as raised:
            ex.build_skill_runs()
        self.assertIn("skills.json", str(raised.exception))
        self.assertIn("export_mast_spec.py", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
