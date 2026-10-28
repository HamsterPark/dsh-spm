"""`run_export.py` 的单测：只用标准库和 git，不需要 MAST。

    python -m unittest discover -s tools/spec-export/tests -v

路径类用例在 Windows 与 Linux 上都要能跑：Windows 写法用 `ntpath` 显式验证，不依赖当前平台；
快照用例在临时 git 仓里造提交，并用 `GIT_CONFIG_COUNT` 模拟系统级 `core.autocrlf=true`。
"""

from __future__ import annotations

import io
import json
import ntpath
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

EXPORTER_DIR = Path(__file__).resolve().parents[1]
if str(EXPORTER_DIR) not in sys.path:
    sys.path.insert(0, str(EXPORTER_DIR))

import run_export as rx  # noqa: E402


def _tmpdir(case: unittest.TestCase, prefix: str) -> Path:
    path = Path(tempfile.mkdtemp(prefix=prefix))
    case.addCleanup(shutil.rmtree, path, ignore_errors=True)
    return path


class ClassifyTests(unittest.TestCase):
    def test_real_exporter_directory(self) -> None:
        mast, other = rx.classify_exporters(EXPORTER_DIR)
        self.assertEqual(len(mast), 44)
        self.assertEqual(set(other), rx.NON_LANE_EXPORTERS)
        self.assertEqual(rx.unclassified(other), [])
        self.assertEqual(rx.run_order(mast)[0], rx.FIRST)
        self.assertEqual(rx.run_order(mast)[1:], sorted(set(mast) - {rx.FIRST}))

    def test_new_exporter_outside_both_lists_is_unclassified(self) -> None:
        d = _tmpdir(self, "classify-")
        (d / "export_alpha.py").write_text(
            "from _paths import require_mast_root\nROOT = require_mast_root()\n", encoding="utf-8")
        (d / "export_beta.py").write_text("VALUE = 1\n", encoding="utf-8")
        (d / "export_gamma.py").write_text(
            "import _paths\nA = _paths.require_mast_root()\nB = _paths.require_stmsim_root()\n",
            encoding="utf-8")
        mast, other = rx.classify_exporters(d)
        self.assertEqual(mast, ["export_alpha.py"])
        self.assertEqual(other, ["export_beta.py", "export_gamma.py"])
        self.assertEqual(rx.unclassified(other), ["export_beta.py", "export_gamma.py"])


class NativePathTests(unittest.TestCase):
    def test_windows_spelling_is_normalised(self) -> None:
        self.assertEqual(rx.to_native("C:/a//b/", pathmod=ntpath), "C:\\a\\b")
        self.assertEqual(rx.to_native("C:\\a\\.\\b\\..\\c", pathmod=ntpath), "C:\\a\\c")

    def test_forward_slash_is_rejected_on_windows(self) -> None:
        with self.assertRaises(ValueError):
            rx.assert_native("MAST2_PROJECT_ROOT", "C:/stage/pr", nt=True)
        rx.assert_native("MAST2_PROJECT_ROOT", "C:\\stage\\pr", nt=True)
        rx.assert_native("MAST2_PROJECT_ROOT", "/stage/pr", nt=False)


class LeakTests(unittest.TestCase):
    NEEDLES = rx.leak_needles({"stage": "D:\\stage\\x", "home": "E:\\profiles\\alice"})

    def test_every_spelling_is_caught(self) -> None:
        planted = {
            "原值": ("D:\\stage\\x\\runs\\1", "stage"),
            "正斜杠": ("D:/stage/x/runs/1", "stage"),
            "反斜杠": ("E:\\profiles\\alice\\cache", "home"),
            "JSON 转义": (json.dumps({"p": "E:\\profiles\\alice\\cache"}), "home"),
            "大小写": ("e:/PROFILES/ALICE/cache", "home"),
        }
        for form, (text, label) in planted.items():
            with self.subTest(form=form):
                self.assertEqual(rx.find_leaks(f"before {text} after", self.NEEDLES), [label])

    def test_forward_slash_input_still_catches_backslash_paths(self) -> None:
        needles = rx.leak_needles({"stage": "D:/stage/x"})
        self.assertEqual(rx.find_leaks("D:\\stage\\x\\runs", needles), ["stage"])
        self.assertEqual(rx.find_leaks(json.dumps("D:\\stage\\x"), needles), ["stage"])

    def test_clean_text_passes(self) -> None:
        text = "<project-root>/data D:\\other E:/profiles/bob <tmp>"
        self.assertEqual(rx.find_leaks(text, self.NEEDLES), [])


class ChildEnvTests(unittest.TestCase):
    def test_strips_python_and_reference_roots_then_sets(self) -> None:
        base = {
            "PYTHONPATH": "x", "PYTHONHOME": "y", "pythonstartup": "z",
            "STMSIM_ROOT": "s", "VISTA_SPM_ROOT": "v", "MAST_ROOT": "old", "MAST2_PROJECT_ROOT": "old",
            "PATH": "p", "Temp": "old-temp", "LANG": "C.UTF-8",
        }
        env = rx.child_env(base, MAST_ROOT="new", TEMP="t", PYTHONDONTWRITEBYTECODE="1")
        self.assertEqual(env, {
            "PATH": "p", "LANG": "C.UTF-8",
            "MAST_ROOT": "new", "TEMP": "t", "PYTHONDONTWRITEBYTECODE": "1",
        })
        self.assertEqual(base["PYTHONPATH"], "x")  # 不改调用方的映射


GIT_ISOLATED = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
#: 模拟系统级 core.autocrlf=true（Windows 上 Git 的默认安装就是这样）。命令行 `-c` 优先于它。
AUTOCRLF_TRUE = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.autocrlf", "GIT_CONFIG_VALUE_0": "true"}

LF = b"x = 1\ny = 2\n"
CRLF = b"x = 1\r\ny = 2\r\n"

LATE_PADDING_SRC = """
import io, sys, tarfile, time
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w") as tar:
    data = b"x = 1\\n"
    info = tarfile.TarInfo("MASTv2/a.py")
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))
out = sys.stdout.buffer
out.write(buf.getvalue())
out.flush()
time.sleep(0.5)
try:
    out.write(bytes(10240))
    out.flush()
except OSError:
    sys.exit(141)
"""


class SnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = _tmpdir(self, "snapshot-")
        self.repo = self.tmp / "repo"
        files = {
            "MASTv2/mast/a.py": LF,
            "MASTv2/mast/crlf.py": CRLF,
            "MASTv2/mast/中文.py": "注释 = '参考'\n".encode("utf-8"),
            "MASTv2/sub/deep/b.txt": b"deep\n",
            "outside.txt": b"not in the snapshot\n",
        }
        for rel, data in files.items():
            (self.repo / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / rel).write_bytes(data)
        self.git("-c", "init.defaultBranch=main", "init", "-q")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
                 "commit", "-q", "-m", "fixture")
        self.git("tag", "v1")
        self.sha = self.git("log", "-1", "--format=%H").strip()
        self.dest = self.tmp / "stage" / "mast" / self.sha

    def git(self, *args: str) -> str:
        env = {**os.environ, **GIT_ISOLATED}
        return subprocess.run(["git", *args], cwd=self.repo, env=env, check=True,
                              capture_output=True).stdout.decode("utf-8")

    def test_snapshot_matches_commit_despite_autocrlf(self) -> None:
        with mock.patch.dict(os.environ, AUTOCRLF_TRUE):
            rx.archive_snapshot(self.repo, self.sha, self.dest)
            self.assertEqual(rx.verify_snapshot(self.repo, self.sha, self.dest), [])
        self.assertEqual((self.dest / "MASTv2" / "mast" / "a.py").read_bytes(), LF)
        self.assertEqual((self.dest / "MASTv2" / "mast" / "crlf.py").read_bytes(), CRLF)
        self.assertFalse((self.dest / "outside.txt").exists())

    def test_control_plain_archive_rewrites_line_endings(self) -> None:
        # 对照：不加 -c core.autocrlf=false 的 archive 确实改了行尾，verify_snapshot 能看出来
        env = {**os.environ, **AUTOCRLF_TRUE}
        tar_bytes = subprocess.run(["git", "-C", str(self.repo), "archive", "--format=tar", self.sha, "MASTv2"],
                                   env=env, check=True, capture_output=True).stdout
        self.dest.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
            tar.extractall(self.dest, filter="data")
        self.assertEqual((self.dest / "MASTv2" / "mast" / "a.py").read_bytes(), CRLF)
        self.assertIn("blob-mismatch: MASTv2/mast/a.py", rx.verify_snapshot(self.repo, self.sha, self.dest))

    def test_modified_extra_and_missing_files_are_reported(self) -> None:
        rx.archive_snapshot(self.repo, self.sha, self.dest)
        (self.dest / "MASTv2" / "mast" / "a.py").write_bytes(b"x = 1\ny = 3\n")
        (self.dest / "MASTv2" / "extra.txt").write_bytes(b"new\n")
        (self.dest / "MASTv2" / "sub" / "deep" / "b.txt").unlink()
        self.assertEqual(sorted(rx.verify_snapshot(self.repo, self.sha, self.dest)), [
            "blob-mismatch: MASTv2/mast/a.py",
            "extra: MASTv2/extra.txt",
            "missing: MASTv2/sub/deep/b.txt",
        ])

    def test_archive_drains_the_padding_after_the_end_marker(self) -> None:
        # 假的 git archive：先写完整的 tar，停一会儿再写记录块的填充；管道已断就以 141 退出，
        # 和 git 一样不留一句话。运行器不读完管道，就会把这当成 git archive 失败。
        real_popen = subprocess.Popen

        def fake_popen(_cmd: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
            return real_popen([sys.executable, "-I", "-c", textwrap.dedent(LATE_PADDING_SRC)], **kwargs)

        with mock.patch.object(subprocess, "Popen", side_effect=fake_popen):
            rx.archive_snapshot(self.repo, self.sha, self.dest)
        self.assertEqual((self.dest / "MASTv2" / "a.py").read_bytes(), b"x = 1\n")

    def test_archive_replaces_a_stale_snapshot(self) -> None:
        rx.archive_snapshot(self.repo, self.sha, self.dest)
        (self.dest / "MASTv2" / "stale.txt").write_bytes(b"left over\n")
        rx.archive_snapshot(self.repo, self.sha, self.dest)
        self.assertEqual(rx.verify_snapshot(self.repo, self.sha, self.dest), [])

    def test_rev_must_be_a_tag_or_commit(self) -> None:
        self.assertEqual(rx.resolve_commit(self.repo, self.sha), self.sha)
        self.assertEqual(rx.resolve_commit(self.repo, self.sha[:7]), self.sha)
        self.assertEqual(rx.resolve_commit(self.repo, "v1"), self.sha)
        for bad in ("main", "HEAD", "v1..main", self.sha[:6], "v2", self.sha.upper()):
            with self.subTest(rev=bad), self.assertRaises(rx.RunError) as caught:
                rx.resolve_commit(self.repo, bad)
            self.assertEqual(caught.exception.code, rx.USAGE)
        self.assertEqual(rx.describe(self.repo, self.sha), "v1")
        self.assertEqual(rx.subtree_id(self.repo, self.sha), self.git("rev-parse", f"{self.sha}:MASTv2").strip())


class FingerprintTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = _tmpdir(self, "fingerprint-")
        (self.root / "MASTv2" / "mast").mkdir(parents=True)
        (self.root / "MASTv2" / "mast" / "a.py").write_bytes(b"x = 1\n")
        (self.root / "other.txt").write_bytes(b"outside\n")
        self.before = rx.mast_fingerprint(self.root)

    def delta(self) -> dict[str, list[str]]:
        return rx.fingerprint_delta(self.before, rx.mast_fingerprint(self.root))

    def test_new_file_fails_in_both_modes(self) -> None:
        (self.root / "MASTv2" / "mast" / "__pycache__").mkdir()
        (self.root / "MASTv2" / "mast" / "__pycache__" / "a.cpython-313.pyc").write_bytes(b"")
        d = self.delta()
        self.assertEqual(d["new"], ["mast/__pycache__/", "mast/__pycache__/a.cpython-313.pyc"])
        self.assertTrue(rx.fingerprint_failed(d, strict=False))
        self.assertTrue(rx.fingerprint_failed(d, strict=True))

    def test_changed_file_only_warns_unless_strict(self) -> None:
        a = self.root / "MASTv2" / "mast" / "a.py"
        a.write_bytes(b"x = 2  # saved by the user\n")
        st = a.stat()
        os.utime(a, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        d = self.delta()
        self.assertEqual(d, {"new": [], "changed": ["mast/a.py"], "gone": []})
        self.assertFalse(rx.fingerprint_failed(d, strict=False))
        self.assertTrue(rx.fingerprint_failed(d, strict=True))

    def test_changes_outside_the_subdir_are_ignored(self) -> None:
        (self.root / "other.txt").write_bytes(b"changed outside\n")
        (self.root / "new-outside.txt").write_bytes(b"new\n")
        self.assertEqual(self.delta(), {"new": [], "changed": [], "gone": []})


OK_SRC = """
import json, pathlib
out = pathlib.Path(__file__).resolve().parents[2] / "spec" / "golden" / "ok.json"
out.write_bytes((json.dumps({"a": 1}, indent=2, sort_keys=True) + "\\n").encode("utf-8"))
"""

LEAK_SRC = """
import json, os, pathlib
out = pathlib.Path(__file__).resolve().parents[2] / "spec" / "golden" / "leak.json"
out.write_bytes((json.dumps({"root": os.environ["MAST2_PROJECT_ROOT"]}) + "\\n").encode("utf-8"))
"""

FAIL_SRC = """
raise SystemExit(3)
"""

RANDOM_SRC = """
import json, os, pathlib
out = pathlib.Path(__file__).resolve().parents[2] / "spec" / "golden" / "random.json"
out.write_bytes((json.dumps({"r": os.urandom(8).hex()}) + "\\n").encode("utf-8"))
"""

SEEN_SRC = """
import json, os, sys, tempfile
keys = ("MAST_ROOT", "MAST2_PROJECT_ROOT", "TEMP", "TMP", "PYTHONPATH", "MAST_COMMIT")
seen = {k: os.environ.get(k) for k in keys}
seen["tempdir"] = tempfile.gettempdir()
seen["dont_write_bytecode"] = sys.dont_write_bytecode
print(json.dumps(seen))
"""


class EndToEndTests(unittest.TestCase):
    """假导出器走一遍 `run_exporters`：隔离、产物检查、重复运行。"""

    def setUp(self) -> None:
        self.tmp = _tmpdir(self, "e2e-")
        self.exdir = self.tmp / "exporters"
        self.exdir.mkdir()
        for name, src in {"export_ok.py": OK_SRC, "export_leak.py": LEAK_SRC, "export_fail.py": FAIL_SRC,
                          "export_random.py": RANDOM_SRC, "export_seen.py": SEEN_SRC}.items():
            (self.exdir / name).write_text(textwrap.dedent(src).lstrip(), encoding="utf-8")
        self.stage = self.tmp / "stage"
        self.mast_root = self.tmp / "snapshot" / "MASTv2"
        self.mast_root.mkdir(parents=True)

    def run_cfg(self, exporters: list[str], *, expected: set[str] | None = None, repeat: int = 1,
                stage: str | None = None, extra_env: dict[str, str] | None = None) -> rx.RunOutcome:
        stage = stage or str(self.stage)
        cfg = rx.RunConfig(
            stage=stage, label="t", exporter_dir=self.exdir, exporters=exporters,
            mast_root=str(self.mast_root), expected=None if expected is None else frozenset(expected),
            extra_env=extra_env or {}, needles=rx.leak_needles({"暂存根": rx.to_native(stage)}),
            repeat=repeat, timeout=120, log=lambda _line: None)
        return rx.run_exporters(cfg)

    def test_clean_run_passes(self) -> None:
        out = self.run_cfg(["export_ok.py"], expected={"ok.json"})
        self.assertEqual(out.problems, [])
        self.assertEqual(sorted(out.outputs[0]), ["ok.json"])
        self.assertEqual([r["rc"] for r in out.results[0]], [0])
        golden = out.run_dirs[0] / "repo" / "spec" / "golden"
        self.assertEqual((golden / "ok.json").read_bytes(), b'{\n  "a": 1\n}\n')

    def test_leaked_project_root_exits_6(self) -> None:
        out = self.run_cfg(["export_ok.py", "export_leak.py"], expected={"ok.json", "leak.json"})
        self.assertEqual(out.problems, [(rx.LEAK, "[1] leak.json: 暂存根")])

    def test_failing_exporter_exits_5(self) -> None:
        out = self.run_cfg(["export_fail.py", "export_ok.py"], expected={"ok.json"})
        self.assertEqual(out.problems, [(rx.EXPORTER, "[1] export_fail.py 退出码 3")])

    def test_missing_output_exits_5(self) -> None:
        out = self.run_cfg(["export_ok.py"], expected={"ok.json", "other.json"})
        self.assertEqual(out.problems, [(rx.EXPORTER, "[1] 没有产出 other.json")])

    def test_repeat_two_compares_bytes(self) -> None:
        out = self.run_cfg(["export_ok.py"], expected={"ok.json"}, repeat=2)
        self.assertEqual(out.problems, [])
        self.assertEqual(out.identical, (1, 1))
        self.assertEqual(len(out.run_dirs), 2)
        noisy = self.run_cfg(["export_random.py"], repeat=2)
        self.assertEqual(noisy.problems, [(rx.REPEAT, "[1↔2] random.json 不一致")])
        self.assertEqual(noisy.identical, (0, 1))

    def test_forward_slash_stage_reaches_children_in_native_form(self) -> None:
        stage = str(self.stage).replace("\\", "/") + "//"
        with mock.patch.dict(os.environ, {"PYTHONPATH": str(self.tmp), "MAST2_PROJECT_ROOT": "stale"}):
            out = self.run_cfg(["export_seen.py"], stage=stage, extra_env={"MAST_COMMIT": "c" * 40})
        self.assertEqual(out.problems, [])
        run_dir = Path(rx.to_native(self.stage)) / "runs" / "t-1"
        seen = json.loads((run_dir / "logs" / "export_seen.out").read_text(encoding="utf-8"))
        self.assertEqual(seen["MAST2_PROJECT_ROOT"], rx.to_native(run_dir / "pr" / "seen"))
        self.assertEqual(seen["TEMP"], rx.to_native(run_dir / "tmp" / "seen"))
        self.assertEqual(seen["tempdir"], seen["TEMP"])
        self.assertEqual(seen["MAST_ROOT"], rx.to_native(self.mast_root))
        self.assertIsNone(seen["PYTHONPATH"])
        self.assertEqual(seen["MAST_COMMIT"], "c" * 40)
        self.assertTrue(seen["dont_write_bytecode"])
        if os.name == "nt":
            for key in ("MAST_ROOT", "MAST2_PROJECT_ROOT", "TEMP", "TMP"):
                self.assertNotIn("/", seen[key], key)


class JsonFormatTests(unittest.TestCase):
    def test_golden_discipline(self) -> None:
        self.assertEqual(rx.json_problems(b'{\n  "a": 1\n}\n'), [])
        self.assertEqual(rx.json_problems(b'{"a": 1}\r\n'), ["含 CR"])
        self.assertEqual(rx.json_problems(b'{"a": 1}'), ["不以换行结尾"])
        self.assertEqual(rx.json_problems(b"\xff\n"), ["不是 UTF-8"])
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant):
                problems = rx.json_problems(f'{{"a": {constant}}}\n'.encode("ascii"))
                self.assertEqual(len(problems), 1)
                self.assertIn(constant, problems[0])


class CompareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.a = _tmpdir(self, "cmp-a-")
        self.b = _tmpdir(self, "cmp-b-")
        collectors = {"skills.json": {"entries": 3, "ok": True}}
        self.write(self.a, "manifest.json", {"collectors": collectors, "mast_root": "<MAST_ROOT>",
                                             "reference": {"commit": "a" * 40}, "public_text": {"entries": 1}})
        self.write(self.b, "manifest.json", {"collectors": collectors, "mast_root": "<MAST_ROOT>",
                                             "spec_source": {"near_commit": "deadbeef"}})
        self.write(self.a, "same.json", {"x": 1})
        self.write(self.b, "same.json", {"x": 1})
        self.write(self.a, "diff.json", {"x": 1})
        self.write(self.b, "diff.json", {"x": 2})
        self.write(self.a, "only-a.json", {})
        (self.a / "schema.sql").write_bytes(b"CREATE TABLE t (x);\n")
        (self.b / "schema.sql").write_bytes(b"CREATE TABLE t (x);\n")
        (self.a / "README.md").write_bytes(b"ignored\n")

    @staticmethod
    def write(d: Path, name: str, doc: object) -> None:
        (d / name).write_bytes((json.dumps(doc, indent=2, sort_keys=True) + "\n").encode("utf-8"))

    def test_bytes_and_masked_manifest(self) -> None:
        plain = rx.compare_dirs(self.a, self.b, mask_manifest=False)
        self.assertEqual(plain, {"diff.json": "differ", "manifest.json": "differ", "only-a.json": "missing",
                                 "same.json": "identical", "schema.sql": "identical"})
        masked = rx.compare_dirs(self.a, self.b, mask_manifest=True)
        self.assertEqual(masked["manifest.json"], "identical")

    def test_masking_keeps_collectors(self) -> None:
        self.write(self.b, "manifest.json", {"collectors": {"skills.json": {"entries": 4, "ok": True}},
                                             "mast_root": "<MAST_ROOT>"})
        self.assertEqual(rx.compare_dirs(self.a, self.b, mask_manifest=True)["manifest.json"], "differ")

    def test_cli_exit_codes(self) -> None:
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = rx.main(["compare", str(self.a), str(self.b), "--mask-manifest"])
        self.assertEqual(code, rx.DIFFER)
        self.assertTrue(out.getvalue().rstrip().endswith("identical=3 differ=1 missing=1"))
        with mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(rx.main(["compare", str(self.a), str(self.a)]), rx.OK)


if __name__ == "__main__":
    unittest.main()
