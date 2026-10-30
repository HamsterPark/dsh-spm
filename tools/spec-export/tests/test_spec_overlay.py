"""`spec_overlay.py` 的单测：全用合成数据，只用标准库。

    python -m unittest discover -s tools/spec-export/tests -v

合成金样里的「私有」文本只是占位（`example-host`、`alpha-sample-7` 一类），不对应任何真实站点。
"""

from __future__ import annotations

import contextlib
import hashlib
import io
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

import run_export  # noqa: E402
import spec_overlay as so  # noqa: E402

RAW_ALPHA = {
    "notes": ["measured on example-host rig", "kept as is"],
    "labels": {"sample": "alpha-sample-7", "unit": "nm"},
    "values": [1e-07, 1.0, -0.0, 12345678901234567890, True, None],
    "nested": [{"zh": "示例主机上测得", "esc": "tab\there \"quoted\" back\\slash\nline µ"}],
}
PUBLIC_ALPHA = {
    "notes": ["measured on a reference system", "kept as is"],
    "labels": {"sample": "sample-A", "unit": "nm"},
    "values": [1e-07, 1.0, -0.0, 12345678901234567890, True, None],
    "nested": [{"zh": "参考系统上测得", "esc": "tab\there \"quoted\" back\\slash\nline µ"}],
}
RAW_BETA = {"rows": [{"a/b": "example-host", "n": 1}, {"c~d": "example-host", "n": 2}]}
PUBLIC_BETA = {"rows": [{"a/b": "host-1", "n": 1}, {"c~d": "host-1", "n": 2}]}
MANIFEST = {"collectors": {"skills.json": {"entries": 3, "ok": True}}, "mast_root": "<MAST_ROOT>"}
SQL = b"CREATE TABLE t (x INTEGER);\n"


def write(d: Path, name: str, doc: object) -> None:
    (d / name).write_bytes(so.canonical_dumps(doc).encode("utf-8"))


class OverlayCase(unittest.TestCase):
    """raw / public 两个合成金样目录，以及一份由它们 build 出的覆盖层。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="spec-overlay-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.raw = self.make("raw", RAW_ALPHA, RAW_BETA, MANIFEST)
        self.public = self.make("public", PUBLIC_ALPHA, PUBLIC_BETA, MANIFEST)
        self.overlay = self.tmp / "private" / "overlay.json"

    def make(self, name: str, alpha: object, beta: object, manifest: object) -> Path:
        d = self.tmp / name
        d.mkdir()
        write(d, "alpha.json", alpha)
        write(d, "beta.json", beta)
        write(d, "manifest.json", manifest)
        (d / "schema.sql").write_bytes(SQL)
        return d

    def cli(self, *args: str) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = so.main([str(a) for a in args])
        return code, out.getvalue() + err.getvalue()

    def build(self, *extra: str, raw: Path | None = None, public: Path | None = None,
              out: Path | None = None) -> tuple[int, str]:
        return self.cli("build", "--raw", raw or self.raw, "--public", public or self.public,
                        "--out", out or self.overlay, *extra)

    def apply(self, src: Path, dst: Path, overlay: Path | None = None) -> tuple[int, str]:
        return self.cli("apply", "--in", src, "--out", dst, "--overlay", overlay or self.overlay)

    def assert_same_bytes(self, a: Path, b: Path) -> None:
        names = sorted(p.name for p in a.iterdir())
        self.assertEqual(names, sorted(p.name for p in b.iterdir()))
        for name in names:
            self.assertEqual((a / name).read_bytes(), (b / name).read_bytes(), name)


class RoundTripTests(OverlayCase):
    def test_build_then_apply_reproduces_public_bytes(self) -> None:
        code, out = self.build()
        self.assertEqual(code, 0, out)
        self.assertIn("files=2 leaves=5 groups=4", out)
        code, out = self.apply(self.raw, self.tmp / "out")
        self.assertEqual(code, 0, out)
        self.assertIn("already=0 replaced=5 mismatch=0 unlisted=0", out)
        self.assert_same_bytes(self.tmp / "out", self.public)

    def test_overlay_file_shape(self) -> None:
        self.build()
        text = self.overlay.read_bytes().decode("utf-8")
        doc = json.loads(text)
        self.assertEqual(so.canonical_dumps(doc), text)
        self.assertEqual(doc["format"], 1)
        shared = [e for e in doc["entries"] if len(e["at"]) == 2]
        self.assertEqual(len(shared), 1)
        self.assertEqual(shared[0]["at"], [{"file": "beta.json", "pointer": "/rows/0/a~1b"},
                                           {"file": "beta.json", "pointer": "/rows/1/c~0d"}])
        self.assertEqual(shared[0]["sha256"], so.sha256_text("example-host"))
        self.assertEqual(shared[0]["len"], len("example-host"))
        self.assertNotIn("example-host", text)  # 只有哈希与长度，没有原文

    def test_show_prints_one_leaf_for_review(self) -> None:
        code, out = self.cli("show", "--dir", self.raw, "--file", "beta.json", "--pointer", "/rows/0/a~1b")
        self.assertEqual(code, 0)
        self.assertIn(f"beta.json#/rows/0/a~1b sha256={so.sha256_text('example-host')} len=12", out)
        self.assertIn("example-host", out)
        self.assertEqual(self.cli("show", "--dir", self.raw, "--file", "beta.json", "--pointer", "/rows/9")[0], 1)
        self.assertEqual(self.cli("show", "--dir", self.tmp / "nowhere", "--file", "beta.json",
                                  "--pointer", "/rows/0")[0], 1)

    def test_overlay_from_environment(self) -> None:
        self.build()
        with mock.patch.dict(os.environ, {"SPEC_OVERLAY": str(self.overlay)}):
            code, out = self.cli("apply", "--in", self.raw, "--out", self.tmp / "out")
        self.assertEqual(code, 0, out)


class RefusalTests(OverlayCase):
    def setUp(self) -> None:
        super().setUp()
        self.assertEqual(self.build()[0], 0)

    def copy_raw(self) -> Path:
        dst = self.tmp / "raw-copy"
        shutil.copytree(self.raw, dst)
        return dst

    def test_hash_mismatch_refuses_and_never_echoes_text(self) -> None:
        raw = self.copy_raw()
        alpha = json.loads((raw / "alpha.json").read_bytes())
        alpha["notes"][0] = "measured on example-host rig!"
        write(raw, "alpha.json", alpha)
        code, out = self.apply(raw, self.tmp / "out")
        self.assertEqual(code, 1)
        self.assertFalse((self.tmp / "out").exists())
        self.assertIn("MISMATCH alpha.json#/notes/0", out)
        for text in ("example-host", "measured on", "reference system"):
            self.assertNotIn(text, out)

    def test_unlisted_occurrence_of_a_private_text(self) -> None:
        raw = self.copy_raw()
        beta = json.loads((raw / "beta.json").read_bytes())
        beta["rows"].append({"other": "example-host"})
        write(raw, "beta.json", beta)
        code, out = self.apply(raw, self.tmp / "out")
        self.assertEqual(code, 1)
        self.assertIn("UNLISTED beta.json#/rows/2/other", out)
        self.assertNotIn("example-host", out)
        self.assertFalse((self.tmp / "out").exists())

    def test_referenced_file_must_round_trip(self) -> None:
        raw = self.copy_raw()
        (raw / "alpha.json").write_bytes(
            (json.dumps(RAW_ALPHA, ensure_ascii=False, indent=4, sort_keys=True) + "\n").encode("utf-8"))
        code, out = self.apply(raw, self.tmp / "out")
        self.assertEqual(code, 1)
        self.assertIn("NOT_CANONICAL alpha.json", out)

    def test_crlf_is_not_canonical(self) -> None:
        raw = self.copy_raw()
        (raw / "beta.json").write_bytes((raw / "beta.json").read_bytes().replace(b"\n", b"\r\n"))
        code, out = self.apply(raw, self.tmp / "out")
        self.assertEqual(code, 1)
        self.assertIn("NOT_CANONICAL beta.json", out)

    def test_unreferenced_files_are_copied_byte_for_byte(self) -> None:
        raw = self.copy_raw()
        (raw / "gamma.json").write_bytes(b'{"compact":true}')
        code, out = self.apply(raw, self.tmp / "out")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.tmp / "out" / "gamma.json").read_bytes(), b'{"compact":true}')
        self.assertEqual((self.tmp / "out" / "schema.sql").read_bytes(), SQL)

    def test_partial_run_is_missing_a_file(self) -> None:
        raw = self.copy_raw()
        (raw / "beta.json").unlink()
        code, out = self.apply(raw, self.tmp / "out")
        self.assertEqual(code, 1)
        self.assertIn("MISSING_FILE beta.json", out)

    def test_moved_leaf_is_a_missing_pointer(self) -> None:
        raw = self.copy_raw()
        alpha = json.loads((raw / "alpha.json").read_bytes())
        alpha["notes"] = {"first": alpha["notes"][0]}
        write(raw, "alpha.json", alpha)
        code, out = self.apply(raw, self.tmp / "out")
        self.assertEqual(code, 1)
        self.assertIn("MISSING_POINTER alpha.json#/notes/0", out)

    def test_out_must_be_new_or_empty(self) -> None:
        busy = self.tmp / "busy"
        busy.mkdir()
        (busy / "keep.txt").write_bytes(b"keep\n")
        code, out = self.apply(self.raw, busy)
        self.assertEqual(code, 1)
        self.assertIn("OUT_NOT_EMPTY", out)
        self.assertEqual(sorted(p.name for p in busy.iterdir()), ["keep.txt"])
        empty = self.tmp / "empty"
        empty.mkdir()
        self.assertEqual(self.apply(self.raw, empty)[0], 0)


class FixedPointTests(OverlayCase):
    def setUp(self) -> None:
        super().setUp()
        self.assertEqual(self.build()[0], 0)

    def test_apply_is_idempotent(self) -> None:
        self.assertEqual(self.apply(self.raw, self.tmp / "once")[0], 0)
        code, out = self.apply(self.tmp / "once", self.tmp / "twice")
        self.assertEqual(code, 0, out)
        self.assertIn("already=5 replaced=0 mismatch=0 unlisted=0", out)
        self.assert_same_bytes(self.tmp / "once", self.tmp / "twice")

    def test_verify_public_passes_and_raw_fails(self) -> None:
        code, out = self.cli("verify", "--dir", self.public, "--overlay", self.overlay)
        self.assertEqual(code, 0, out)
        self.assertIn("already=5 replaced=0 mismatch=0 unlisted=0", out)
        code, out = self.cli("verify", "--dir", self.raw, "--overlay", self.overlay)
        self.assertEqual(code, 1)
        self.assertIn("RAW_PRESENT alpha.json#/notes/0", out)
        self.assertNotIn("example-host", out)


class ManifestMarkTests(OverlayCase):
    def setUp(self) -> None:
        super().setUp()
        self.reference = {**MANIFEST, "reference": {"commit": "a" * 40, "py_files": 2}}
        write(self.raw, "manifest.json", self.reference)
        write(self.public, "manifest.json", {**MANIFEST, "spec_source": {"near_commit": "deadbeef"}})
        self.assertEqual(self.build()[0], 0)

    def test_reference_gets_a_public_text_mark(self) -> None:
        self.assertEqual(self.apply(self.raw, self.tmp / "out")[0], 0)
        manifest = json.loads((self.tmp / "out" / "manifest.json").read_bytes())
        digest = hashlib.sha256(self.overlay.read_bytes()).hexdigest()
        self.assertEqual(manifest["public_text"], {"overlay": digest[:12], "entries": 4, "leaves": 5})
        self.assertEqual(manifest["reference"], self.reference["reference"])
        cmp = run_export.compare_dirs(self.tmp / "out", self.public, mask_manifest=True)
        self.assertEqual(set(cmp.values()), {"identical"})
        self.assertEqual(run_export.compare_dirs(self.tmp / "out", self.public, mask_manifest=False)[
            "manifest.json"], "differ")
        code, out = self.cli("verify", "--dir", self.tmp / "out", "--overlay", self.overlay)
        self.assertEqual(code, 0, out)

    def test_mark_must_match_the_overlay(self) -> None:
        self.assertEqual(self.apply(self.raw, self.tmp / "out")[0], 0)
        manifest = json.loads((self.tmp / "out" / "manifest.json").read_bytes())
        manifest["public_text"]["overlay"] = "0" * 12
        write(self.tmp / "out", "manifest.json", manifest)
        code, out = self.cli("verify", "--dir", self.tmp / "out", "--overlay", self.overlay)
        self.assertEqual(code, 1)
        self.assertIn("PUBLIC_TEXT_MARK manifest.json#/public_text", out)

    def test_no_reference_no_mark(self) -> None:
        write(self.raw, "manifest.json", MANIFEST)
        self.assertEqual(self.apply(self.raw, self.tmp / "out")[0], 0)
        self.assertEqual((self.tmp / "out" / "manifest.json").read_bytes(),
                         so.canonical_dumps(MANIFEST).encode("utf-8"))


class BuildTests(OverlayCase):
    def test_non_text_differences_abort(self) -> None:
        def alpha_with(change) -> dict:
            doc = json.loads(json.dumps(PUBLIC_ALPHA))
            change(doc)
            return doc

        variants = {
            "KEYS": lambda d: d["labels"].update(extra="x"),
            "LENGTH": lambda d: d["notes"].append("x"),
            "VALUE": lambda d: d["values"].__setitem__(1, 1.5),
            "TYPE": lambda d: d["values"].__setitem__(4, 1),
            "-0.0": lambda d: d["values"].__setitem__(2, 0.0),
        }
        for name, change in variants.items():
            with self.subTest(variant=name):
                public = self.tmp / f"public-{name}"
                shutil.copytree(self.public, public)
                write(public, "alpha.json", alpha_with(change))
                out = self.tmp / f"overlay-{name}.json"
                code, text = self.build(public=public, out=out)
                self.assertEqual(code, 1)
                self.assertFalse(out.exists())
                self.assertIn("alpha.json#/", text)

    def test_sql_must_be_identical_and_files_present(self) -> None:
        (self.public / "schema.sql").write_bytes(b"CREATE TABLE t (y INTEGER);\n")
        code, out = self.build()
        self.assertEqual(code, 1)
        self.assertIn("BYTES_DIFFER schema.sql", out)
        (self.public / "schema.sql").write_bytes(SQL)
        (self.public / "beta.json").unlink()
        code, out = self.build()
        self.assertEqual(code, 1)
        self.assertIn("MISSING_IN_PUBLIC beta.json", out)

    def test_existing_out_needs_force(self) -> None:
        self.assertEqual(self.build()[0], 0)
        code, out = self.build()
        self.assertEqual(code, 1)
        self.assertIn("OUT_EXISTS", out)
        self.assertEqual(self.build("--force")[0], 0)

    def test_private_text_left_in_public_elsewhere(self) -> None:
        # 同一原文在公开金样的另一处没改：建出来的覆盖层 apply 时必然 UNLISTED，build 当场拒绝
        alpha_raw = json.loads(json.dumps(RAW_ALPHA))
        alpha_raw["labels"]["copy"] = "alpha-sample-7"
        write(self.raw, "alpha.json", alpha_raw)
        alpha_public = json.loads(json.dumps(PUBLIC_ALPHA))
        alpha_public["labels"]["copy"] = "alpha-sample-7"
        write(self.public, "alpha.json", alpha_public)
        code, out = self.build()
        self.assertEqual(code, 1)
        self.assertIn("UNLISTED alpha.json#/labels/copy", out)
        self.assertFalse(self.overlay.exists())

    def test_base_merges_new_locations_and_pairs(self) -> None:
        self.assertEqual(self.build()[0], 0)
        raw2, public2 = self.tmp / "raw2", self.tmp / "public2"
        shutil.copytree(self.raw, raw2)
        shutil.copytree(self.public, public2)
        for d, host, note in ((raw2, "example-host", "probe on example-host"),
                              (public2, "host-1", "probe on the reference system")):
            beta = json.loads((d / "beta.json").read_bytes())
            beta["rows"].append({"a/b": host, "n": 3})
            write(d, "beta.json", beta)
            alpha = json.loads((d / "alpha.json").read_bytes())
            alpha["notes"].append(note)
            write(d, "alpha.json", alpha)
        v2 = self.tmp / "private" / "overlay-v2.json"
        code, out = self.build("--base", self.overlay, raw=raw2, public=public2, out=v2)
        self.assertEqual(code, 0, out)
        self.assertIn("files=2 leaves=7 groups=5", out)
        entries = json.loads(v2.read_bytes())["entries"]
        shared = next(e for e in entries if e["sha256"] == so.sha256_text("example-host"))
        self.assertEqual([a["pointer"] for a in shared["at"]], ["/rows/0/a~1b", "/rows/1/c~0d", "/rows/2/a~1b"])
        self.assertEqual(self.apply(raw2, self.tmp / "out2", overlay=v2)[0], 0)
        self.assert_same_bytes(self.tmp / "out2", public2)

    def test_base_must_still_apply(self) -> None:
        self.assertEqual(self.build()[0], 0)
        raw2 = self.tmp / "raw2"
        shutil.copytree(self.raw, raw2)
        alpha = json.loads((raw2 / "alpha.json").read_bytes())
        alpha["labels"]["sample"] = "alpha-sample-8"
        write(raw2, "alpha.json", alpha)
        code, out = self.build("--base", self.overlay, raw=raw2, out=self.tmp / "v2.json")
        self.assertEqual(code, 1)
        self.assertIn("MISMATCH alpha.json#/labels/sample", out)

    def test_token_candidates(self) -> None:
        tokens = self.tmp / "private" / "tokens.txt"
        code, out = self.build("--tokens-out", tokens)
        self.assertEqual(code, 0, out)
        self.assertEqual(tokens.read_bytes().decode("utf-8").splitlines(),
                         sorted({"example-host", "rig", "alpha-sample-7", "示例主机上测得"}))


class PointerAndFormatTests(unittest.TestCase):
    def test_pointer_escapes_and_indices(self) -> None:
        doc = {"a/b": {"c~d": ["x", "y"]}, "": "empty-key"}
        self.assertEqual(so.ptr_get(doc, "/a~1b/c~0d/1"), "y")
        self.assertEqual(so.ptr_get(doc, "/"), "empty-key")
        so.ptr_set(doc, "/a~1b/c~0d/0", "z")
        self.assertEqual(doc["a/b"]["c~d"], ["z", "y"])
        for bad in ("/a~1b/c~0d/01", "/a~1b/c~0d/-1", "/a~1b/c~0d/2", "/missing", "a~1b", "/a~1b/c~0d/0/x"):
            with self.subTest(pointer=bad), self.assertRaises(KeyError):
                so.ptr_get(doc, bad)
        self.assertEqual(dict(so.string_leaves({"k/~": ["s"]})), {"/k~1~0/0": "s"})

    def test_overlay_validation(self) -> None:
        good = so.Entry(so.sha256_text("raw"), 3, "pub", (("a.json", "/x"), ("a.json", "/y")))
        so.parse_overlay(json.loads(so.overlay_text([good])))
        bad_docs = {
            "format": {"format": 2, "entries": []},
            "unsorted at": json.loads(so.overlay_text([so.Entry(good.sha256, 3, "pub",
                                                                (("a.json", "/y"), ("a.json", "/x")))])),
            "degenerate": json.loads(so.overlay_text([so.Entry(so.sha256_text("same"), 4, "same",
                                                               (("a.json", "/x"),))])),
            "duplicate location": json.loads(so.overlay_text([
                so.Entry(good.sha256, 3, "pub", (("a.json", "/x"),)),
                so.Entry(so.sha256_text("other"), 5, "pub2", (("a.json", "/x"),))])),
            "entries unsorted": json.loads(so.overlay_text([
                so.Entry(good.sha256, 3, "pub", (("b.json", "/x"),)),
                so.Entry(so.sha256_text("other"), 5, "pub2", (("a.json", "/x"),))])),
            "bool len": {"format": 1, "entries": [{**good.to_json(), "len": True}]},
            "path in file": {"format": 1, "entries": [{**good.to_json(), "at": [{"file": "../a.json", "pointer": "/x"}]}]},
        }
        for name, doc in bad_docs.items():
            with self.subTest(case=name), self.assertRaises(so.OverlayError) as caught:
                so.parse_overlay(doc)
            self.assertEqual(caught.exception.code, "BAD_OVERLAY")


if __name__ == "__main__":
    unittest.main()
