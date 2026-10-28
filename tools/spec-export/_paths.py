"""Environment-backed paths for read-only specification exporters.

The one thing an exporter may write is a config file the reference reads from its isolated project
root (`ProjectConfigFile`).
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path


def require_directory(variable: str, purpose: str) -> Path:
    """Return a configured directory or fail before an exporter imports it."""
    raw = os.environ.get(variable, "").strip()
    if not raw:
        raise RuntimeError(
            f"{variable} is required: set it to the {purpose} directory before running this exporter"
        )
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise RuntimeError(f"{variable} does not point to an existing directory: {path}")
    return path.resolve()


def require_mast_root() -> Path:
    return require_directory("MAST_ROOT", "read-only MAST source root")


def require_stmsim_root() -> Path:
    return require_directory("STMSIM_ROOT", "read-only STM-Bench source root")


def require_vista_spm_root() -> Path:
    return require_directory("VISTA_SPM_ROOT", "read-only VISTA-SPM source root")


def _reference_trees() -> list[Path]:
    """Directories that must not hold the reference's project root, at any depth.

    `MAST_ROOT` holds the `mast` package; its parent is the checkout or the runner's snapshot, and that
    parent is where the reference keeps its data when `MAST2_PROJECT_ROOT` is empty (`project_root()`
    in `mast/_runtime_paths.py`). `MAST_REPO` names the checkout the runner archives.
    """
    trees = []
    mast_root = os.environ.get("MAST_ROOT", "").strip()
    if mast_root:
        trees.append(Path(mast_root).expanduser().resolve().parent)
    repo = os.environ.get("MAST_REPO", "").strip()
    if repo:
        trees.append(Path(repo).expanduser().resolve())
    return trees


def project_root_refusal() -> str | None:
    """Why the reference must not run with the current `MAST2_PROJECT_ROOT`, or `None` when it may.

    Unset, empty or blank, the reference finds nothing (it strips the value) and falls back to its own
    tree, where exporters clear the reference's progress files; `os.environ.setdefault` keeps an empty
    value. A value is resolved the way the reference resolves it.
    """
    raw = os.environ.get("MAST2_PROJECT_ROOT")
    if raw is None:
        return "MAST2_PROJECT_ROOT is not set, so the reference would fall back to its own tree"
    if not raw.strip():
        return "MAST2_PROJECT_ROOT is empty or blank, so the reference would fall back to its own tree"
    root = Path(raw.strip()).resolve()
    for tree in _reference_trees():
        if root.is_relative_to(tree):
            return f"MAST2_PROJECT_ROOT {root} is inside the reference tree {tree}"
    return None


def _refuse_unsafe_project_root() -> None:
    reason = project_root_refusal()
    if reason is not None:
        raise SystemExit(f"refused: {reason}")  # exit status 1, the message on stderr


def isolated_project_root(fallback: str) -> str:
    """`os.environ.setdefault("MAST2_PROJECT_ROOT", fallback)`, then a refusal when the value the
    reference will use is one it must not use.

    Exporters call it before they import the reference. The runner sets one directory per exporter; an
    exporter run on its own falls back to a temporary directory of its own.
    """
    root = os.environ.setdefault("MAST2_PROJECT_ROOT", fallback)
    _refuse_unsafe_project_root()
    return root


# Also at import, for a value already set: exporters import this module before they touch anything, so
# such a value stops them before even the temporary directory they pass as `fallback` is made.
if "MAST2_PROJECT_ROOT" in os.environ:
    _refuse_unsafe_project_root()


def project_root_forms(raw: str) -> list[str]:
    """Spellings of an isolated project root that an exporter replaces with a placeholder.

    The reference builds paths with pathlib, which writes native separators. Replacing only the
    environment value fails silently when that value uses the other separator, and the absolute path
    then lands in a fixture. Returns the value without trailing separators, its normalised form and
    that form with forward and with back slashes, longest first.
    """
    trimmed = raw.strip().rstrip("/\\")
    if not trimmed:
        return []
    norm = os.path.normpath(trimmed)
    forms = {trimmed, norm, norm.replace("\\", "/"), norm.replace("/", "\\")}
    return sorted(forms, key=lambda form: (-len(form), form))


class ProjectConfigFile:
    """A file under the reference's `<project root>/config/` that an exporter rewrites before each case.

    The reference takes its project root from `MAST2_PROJECT_ROOT`, and without it from its own source
    tree, which is where a real machine's config lives. An exporter's `setdefault` only fills a variable
    that is absent: an empty value, or one that points into the reference tree, still gets through. So
    every write and delete first proves that the target is inside the isolated root and that the root is
    outside the reference tree, and only a file this object wrote itself is ever deleted. Anything else
    found at the target stops the run (exit status 1, message on stderr) with nothing touched.
    """

    def __init__(self, path: Callable[[], Path], reset: Callable[[], None], mast_root: Path) -> None:
        self._path = path  # where the reference looks for the file
        self._reset = reset  # drops the reference's cached read of it
        self._trees = (mast_root.resolve(), mast_root.resolve().parent)
        self._written: Path | None = None

    def _target(self) -> Path:
        raw = os.environ.get("MAST2_PROJECT_ROOT", "").strip()
        if not raw:
            raise SystemExit("MAST2_PROJECT_ROOT is empty: the reference would use its own tree, "
                             "not writing its config")
        root = Path(raw).resolve()
        for tree in self._trees:
            if root == tree or tree in root.parents:
                raise SystemExit(f"MAST2_PROJECT_ROOT {root} is inside the reference tree {tree}: "
                                 "not writing its config")
        target = self._path().resolve()
        if root not in target.parents:
            raise SystemExit(f"{target} is outside MAST2_PROJECT_ROOT {root}: not touching it")
        return target

    def apply(self, content: object) -> None:
        """A dict becomes the file's JSON; anything else, `None` included, leaves no file."""
        target = self._target()
        if target.exists() and target != self._written:
            raise SystemExit(f"{target} exists and this run did not write it: not deleting it")
        target.unlink(missing_ok=True)
        self._written = None
        self._reset()
        if isinstance(content, dict):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
            self._written = target
            self._reset()
