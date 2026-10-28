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
