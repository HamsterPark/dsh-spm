r"""两件支撑件：`.npy` 的**字节**，与 Z 参数组存储的判据网格。

## 为什么 `.npy` 要录字节

`GrabScanFrameData` 交出去的是一个**文件路径**，而不是数组本身。也就是说这个技能的
产物是**一份文件**，它的判据只能落在字节上——一个「大概能用 numpy 读回来」的实现，
在 `np.load` 抛异常之前一切看起来都正常，而那时那一帧已经扫完了。

所以这里录的是 `np.save` 对几种形状写出来的**完整字节**（十六进制），TS 那侧逐字节比。

## 参数组存储

`CreateZCtrlPreset` 的全部判据都在 `sanitize_preset` 里，而它**从不夹紧**：
超范围就拒，「被悄悄改小的值会让你以为自己设的是原来那个数」。

    python \
        tools/spec-export/export_frames_presets.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "frames_presets.json"

sys.path.insert(0, str(MAST_ROOT))

import numpy as np  # noqa: E402
import mast.core.zctrl_presets as zp  # noqa: E402


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, float):
        return "NaN" if v != v else v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "item"):
        return _plain(v.item())
    return str(v)


# ─────────────────────────────────────────────────────────────────────────
# ① `.npy` 的字节
# ─────────────────────────────────────────────────────────────────────────

NPY: dict[str, Any] = {}


def npy_case(name: str, arr: Any) -> None:
    a = np.asarray(arr, dtype=np.float64)
    with tempfile.NamedTemporaryFile(suffix=".npy", delete=False) as f:
        path = f.name
    np.save(path, a)
    raw = Path(path).read_bytes()
    os.unlink(path)
    NPY[name] = {
        "shape": list(a.shape),
        "size": int(a.size),
        "values": _plain(a.tolist()),
        "bytes_hex": raw.hex(),
        "n_bytes": len(raw),
    }


npy_case("2x3", [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
npy_case("1x1", [[42.0]])
npy_case("flat_4", [1.0, 2.0, 3.0, 4.0])
npy_case("8x8_ramp", [[float(r * 8 + c) for c in range(8)] for r in range(8)])
# 真机形状：整行 NaN 的是没采到的
npy_case("4x2_with_nan", [[1.0, 2.0], [3.0, 4.0], [float("nan")] * 2, [float("nan")] * 2])
npy_case("negatives", [[-1.5, 0.0], [1e-12, -3.25e9]])
# 头部长度要凑成 64 的倍数 —— 不同 shape 的头长不同，这一格盯的就是补空格那段
npy_case("128x1", [[float(i)] for i in range(128)])
npy_case("1x128", [[float(i) for i in range(128)]])


# ─────────────────────────────────────────────────────────────────────────
# ② 参数组存储
# ─────────────────────────────────────────────────────────────────────────

SANITIZE: dict[str, Any] = {}


def sanitize_case(name: str, raw: dict[str, Any]) -> None:
    try:
        SANITIZE[name] = {"input": _plain(raw), "ok": True,
                          "out": _plain(zp.sanitize_preset(raw)), "error": ""}
    except zp.PresetRejected as exc:
        SANITIZE[name] = {"input": _plain(raw), "ok": False, "out": None,
                          "error": str(exc)}


GOOD = {"name": "gentle", "p_gain": "3p", "i_gain": "180n"}

sanitize_case("minimal", dict(GOOD))
sanitize_case("with_setpoint", {**GOOD, "setpoint_a": "150p"})
sanitize_case("with_note", {**GOOD, "note": "轻手轻脚"})
sanitize_case("note_truncated", {**GOOD, "note": "x" * 250})
sanitize_case("name_trimmed", {**GOOD, "name": "  gentle  "})
# 保留名与档名
sanitize_case("reserved_approach", {**GOOD, "name": "approach"})
sanitize_case("reserved_scan", {**GOOD, "name": "SCAN"})
sanitize_case("tier_name_highres", {**GOOD, "name": "highres"})
sanitize_case("tier_name_case_insensitive", {**GOOD, "name": "Survey"})
# 名字
sanitize_case("no_name", {"p_gain": "3p", "i_gain": "180n"})
sanitize_case("blank_name", {**GOOD, "name": "   "})
sanitize_case("name_too_long", {**GOOD, "name": "x" * 33})
sanitize_case("name_exactly_32", {**GOOD, "name": "x" * 32})
# 必填
sanitize_case("missing_p_gain", {"name": "g", "i_gain": "180n"})
sanitize_case("missing_i_gain", {"name": "g", "p_gain": "3p"})
sanitize_case("empty_p_gain", {**GOOD, "p_gain": ""})
sanitize_case("none_i_gain", {**GOOD, "i_gain": None})
# **前缀不可省略**
sanitize_case("bare_number_p", {**GOOD, "p_gain": "3"})
sanitize_case("bare_number_i", {**GOOD, "i_gain": "180"})
sanitize_case("exponent_form", {**GOOD, "p_gain": "3e-12"})
sanitize_case("garbage", {**GOOD, "p_gain": "很小"})
# 量程 —— **拒绝，不夹紧**
sanitize_case("p_gain_too_big", {**GOOD, "p_gain": "1m"})
sanitize_case("p_gain_too_small", {**GOOD, "p_gain": "1a"})
sanitize_case("i_gain_too_big", {**GOOD, "i_gain": "1"})
sanitize_case("setpoint_too_big", {**GOOD, "setpoint_a": "1u"})
# 时间常数 T = P / I
sanitize_case("i_gain_zero", {**GOOD, "i_gain": "0p"})
sanitize_case("time_constant_too_large", {"name": "g", "p_gain": "1u", "i_gain": "1p"})
sanitize_case("time_constant_ok_edge", {"name": "g", "p_gain": "1p", "i_gain": "1n"})

UPSERT: dict[str, Any] = {}


def upsert_case(name: str, steps: list[tuple[dict[str, Any], bool]]) -> None:
    zp._presets.clear()
    log: list[dict[str, Any]] = []
    for raw, overwrite in steps:
        try:
            zp.upsert_preset(raw, overwrite=overwrite)
            log.append({"name": raw.get("name"), "overwrite": overwrite,
                        "ok": True, "error": ""})
        except zp.PresetRejected as exc:
            log.append({"name": raw.get("name"), "overwrite": overwrite,
                        "ok": False, "error": str(exc)})
    UPSERT[name] = {"steps": log, "stored": _plain(list(zp._presets)),
                    "available": _plain(zp.available_names())}


upsert_case("insert_one", [(dict(GOOD), False)])
upsert_case("duplicate_rejected", [(dict(GOOD), False), (dict(GOOD), False)])
upsert_case("duplicate_overwritten",
            [(dict(GOOD), False), ({**GOOD, "i_gain": "200n"}, True)])
upsert_case("case_insensitive_duplicate",
            [(dict(GOOD), False), ({**GOOD, "name": "GENTLE"}, False)])
upsert_case("two_distinct",
            [(dict(GOOD), False), ({**GOOD, "name": "firm", "p_gain": "5p"}, False)])
upsert_case("max_presets",
            [({**GOOD, "name": f"g{i}"}, False) for i in range(zp.MAX_PRESETS + 1)])
zp._presets.clear()


# ── ③ `repr(float)` 换指数记法的那两条带 ───────────────────────────────────
#
# CPython 在 `decpt <= -4 || decpt > 16` 时用指数，而 JS 的 `String()` 要到
# `< 1e-6` / `>= 1e21`。中间两条带分岔，而 `setpoint_a` 的上界正是 1e-7 ——
# 超界报文里印的就是这个数。146 条 SI 金样没覆盖到这一带。
PY_REPR = {repr(v): repr(v) for v in
           [1e-6, 1e-7, 1e-5, 1e-4, 1e-3, 5.0, 1e15, 1e16, 1e17, 1e21,
            -1e-6, 1.5e-6, 1e-18, 123.456, 2 / 3, 0.0, -0.0]}


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_frames_presets.py 生成——"
                 "`.npy` 字节取自真实 numpy，参数组判据取自旧仓 zctrl_presets。",
        "constants": {
            "numpy_version": np.__version__,
            "max_presets": zp.MAX_PRESETS,
            "max_name_chars": zp.MAX_NAME_CHARS,
            "reserved_names": list(zp.RESERVED_NAMES),
            "bounds": {k: list(v) for k, v in zp._BOUNDS.items()},
            "time_constant_bounds": list(zp._TIME_CONSTANT_BOUNDS),
        },
        "py_repr": PY_REPR,
        "npy": NPY,
        "sanitize_preset": SANITIZE,
        "upsert_preset": UPSERT,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(NPY)} 份 .npy 字节 · "
          f"{len(SANITIZE)} 格校验 · {len(UPSERT)} 格存储")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
