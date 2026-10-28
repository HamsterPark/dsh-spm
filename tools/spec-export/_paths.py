"""Environment-backed paths for read-only specification exporters."""

from __future__ import annotations

import os
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
