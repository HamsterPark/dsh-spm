r"""插值族（`map_coordinates` / `shift`，order 0 与 1）在帧边、界外坐标与缺测行列上的判别性探针。

`export_numerics.py` 第 9 节只有一张有限帧，按容差比较。2026-10-12/13 移植 visual-memory 的剖线时
发现，那组输入分辨不出下面四件事，而 TS 实现在每一件上都曾与 scipy 不同：

1. `nearest` 不折坐标：界外坐标保留小数部分（`start = floor(x)`），只有邻点下标夹回帧内。
2. 越界邻点按 `_get_spline_boundary_mode` 延拓：`constant` 与 `wrap` 用 mirror，其余照原模式。
3. 四个邻点都乘进来，权重为 0 的也算：缺测（NaN）的邻行让结果是 NaN。
4. NaN 坐标在 `nearest` 以外的模式整点取 cval。

另有两条只动末位的细节：权重是 `1 − t` 与 `1 − (1 − t)`；`reflect` 把 (−1e−15, 0) 上的坐标折成
`1e−15 − 1`。规则出自 scipy 1.17.1 的 `ni_interpolation.c` / `ni_splines.c`，答案由 scipy 实算。

帧带 NaN 行或列（含「最后两行没扫到」的部分采集帧），坐标覆盖界外、整点、半整点、贴边与 NaN，
TS 侧逐位比较。导出时的断言保证这组输入分辨得出 1–4：scipy 哪天改了这些行为，导出会当场失败，
而不是悄悄录下另一种答案。

只需 NumPy 与 SciPy。

    python tools/spec-export/export_interp_edges.py
"""

from __future__ import annotations

import json
import platform
from pathlib import Path
from typing import Any

import numpy as np
import scipy
import scipy.ndimage as ndi

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "interp_edges.json"

#: 这一份金样用的种子。换种子 = 换一份金样，要当成一次有意的改动。
SEED = 20261013
MODES = ["constant", "nearest", "mirror", "reflect", "wrap"]
ORDERS = [0, 1]
CVAL = -99.0


def _plain(v: Any) -> Any:
    """JSON 化；NaN / ±inf 写成字符串占位（`allow_nan=False`），同 `export_numerics.py` 的 `_plain`。"""
    if isinstance(v, np.ndarray):
        return _plain(v.tolist())
    if isinstance(v, (np.floating, np.integer)):
        return _plain(v.item())
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v == float("inf"):
            return "Infinity"
        if v == float("-inf"):
            return "-Infinity"
    return v


rng = np.random.default_rng(SEED)

# ── 帧 ──────────────────────────────────────────────────────────────────────
#
# 6 × 5（行 n = 6，列 n = 5）。缺测放在第 1 与第 n − 2 行（列）：
# - 第 1 行缺测：`nearest` 在 x = −0.3 上若先把坐标夹到 0，第二个邻点（权重 0）就是它（第 1 条）；
#   `wrap` 在 x = n − 1 上的越界邻点若按周期 n − 1 折，也落到它（第 2 条）。
# - 第 n − 2 行缺测：`constant` / `mirror` / `wrap` 在 x = n − 1 上权重为 0 的邻点按 mirror 落到它；
#   `reflect` 落到 n − 1、`nearest` 夹到 n − 1，都碰不到（第 2、3 条）。
# 另有只有一行 / 一列的帧：`n = 1` 时 `nearest` 也不折坐标。
_base = rng.standard_normal((6, 5))


def _holed(rows: int | slice | None = None, cols: int | None = None) -> np.ndarray:
    f = _base.copy()
    if rows is not None:
        f[rows, :] = np.nan
    if cols is not None:
        f[:, cols] = np.nan
    return f


FRAMES: dict[str, np.ndarray] = {
    "finite": _base,
    "nan_row1": _holed(rows=1),
    "nan_row4": _holed(rows=4),
    "nan_col1": _holed(cols=1),
    "nan_col3": _holed(cols=3),
    "partial": _holed(rows=slice(4, None)),  # 部分采集：最后两行没扫到
    "one_row": rng.standard_normal((1, 4)),
    "one_col": rng.standard_normal((4, 1)),
}


def _shape_key(a: np.ndarray) -> str:
    return f"{a.shape[0]}x{a.shape[1]}"


# ── 坐标 ────────────────────────────────────────────────────────────────────


def _sweep(n: int) -> list[float]:
    """一个轴上的整点与半整点（界外 3 格到界外 2 格），再加贴着两端的几个点。"""
    xs = [float(x) for x in np.arange(-3.0, n + 2.0 + 1e-9, 0.5)]
    return xs + [-1e-16, -5e-16, -1e-15, -2e-15, -0.0, n - 1 - 1e-15, n - 1 + 1e-15, n - 0.5 + 1e-12]


def _coords(ny: int, nx: int, n_random: int) -> np.ndarray:
    """先扫行（列固定在内部）、再扫列（行固定在内部），各一个 NaN 坐标，最后是两轴都可能越界的随机点。"""
    mid_r = (ny - 1) / 2
    mid_c = (nx - 1) * 0.4375
    sr, sc = _sweep(ny), _sweep(nx)
    rows = sr + [mid_r] * len(sc) + [np.nan, mid_r]
    cols = [mid_c] * len(sr) + sc + [mid_c, np.nan]
    rows += [float(v) for v in rng.uniform(-3.5, ny + 2.5, n_random)]
    cols += [float(v) for v in rng.uniform(-3.5, nx + 2.5, n_random)]
    return np.array([rows, cols], dtype=np.float64)


COORDS: dict[str, np.ndarray] = {"6x5": _coords(6, 5, 24), "1x4": _coords(1, 4, 12), "4x1": _coords(4, 1, 12)}

# ── 答案 ────────────────────────────────────────────────────────────────────

MAP_CASES: list[dict[str, Any]] = []
for _name, _frame in FRAMES.items():
    _xy = COORDS[_shape_key(_frame)]
    for _order in ORDERS:
        for _mode in MODES:
            MAP_CASES.append({
                "frame": _name, "order": _order, "mode": _mode, "cval": CVAL,
                "output": _plain(ndi.map_coordinates(_frame, _xy, order=_order, mode=_mode, cval=CVAL)),
            })

# `ndi.shift` 走另一段 C 代码（`NI_ZoomShift`），规则相同；out[i] = a[i − s]
SHIFTS = [(0.3, 0.0), (-0.3, 0.7), (1.0, -1.0), (-2.5, 1.5)]
SHIFT_CASES: list[dict[str, Any]] = []
for _name in ["finite", "nan_row1", "nan_row4", "one_row"]:
    for _s in SHIFTS:
        for _order in ORDERS:
            for _mode in MODES:
                SHIFT_CASES.append({
                    "frame": _name, "shift": list(_s), "order": _order, "mode": _mode, "cval": CVAL,
                    "output": _plain(ndi.shift(FRAMES[_name], _s, order=_order, mode=_mode, cval=CVAL)),
                })


# ── 分辨力：上面 1–4 条各有一个由构造保证的反例 ────────────────────────────────


def _at(frame: str, r: float, c: float, mode: str) -> float:
    xy = np.array([[r], [c]], dtype=np.float64)
    return float(ndi.map_coordinates(FRAMES[frame], xy, order=1, mode=mode, cval=CVAL)[0])


def _check_discrimination() -> None:
    # 1. nearest 不折坐标：先夹到 0 的话会读进权重为 0 的第 1 行，得 NaN
    assert np.isfinite(_at("nan_row1", -0.3, 1.75, "nearest"))
    assert np.isfinite(ndi.shift(FRAMES["nan_row1"], (0.3, 0.0), order=1, mode="nearest")[0]).all()
    # 2. x = n − 1 上权重为 0 的邻点（下标 n）：constant / mirror / wrap 按 mirror 落到 n − 2，
    #    不是周期 n − 1 的第 1 行；reflect 与 nearest 落到 n − 1
    for mode in ("constant", "mirror", "wrap"):
        assert np.isnan(_at("nan_row4", 5.0, 1.75, mode)), mode
        assert np.isfinite(_at("nan_row1", 5.0, 1.75, mode)), mode
    for mode in ("reflect", "nearest"):
        assert np.isfinite(_at("nan_row4", 5.0, 1.75, mode)), mode
    # 3. 权重为 0 的邻点也乘进来
    assert np.isnan(_at("nan_row1", 0.0, 1.75, "nearest"))
    # 4. NaN 坐标：nearest 以外整点取 cval
    for mode in ("constant", "mirror", "reflect", "wrap"):
        assert _at("finite", float("nan"), 1.75, mode) == CVAL, mode


def main() -> int:
    _check_discrimination()
    doc = {
        "_note": "由 tools/spec-export/export_interp_edges.py 生成——scipy 实算。帧、坐标与答案一起录，"
                 "TS 侧逐位比较；导出时断言这组输入分辨得出脚本抬头的 1–4 条。",
        "_seed": SEED,
        "versions": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__},
        "cval": CVAL,
        "frames": {k: _plain(v) for k, v in FRAMES.items()},
        "coords": {k: _plain(v) for k, v in COORDS.items()},
        "map_coordinates": MAP_CASES,
        "shift": SHIFT_CASES,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(MAP_CASES)} 组 map_coordinates · {len(SHIFT_CASES)} 组 shift · {kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
