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
