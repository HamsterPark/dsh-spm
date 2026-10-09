r"""Reference results of the VISTA-STM display conventions for dsh-spm-visual-memory.

VISUAL-HARNESS §5 asks the TypeScript visual memory to match the Python
reference implementation of the same design: display scale, display <-> scan-nm
transforms, flattening, contrast, grey levels, views of exact regions, the
read_values sampling rule, units, rounding and labels. This exporter runs the
reference (``stmbench/vista/frames.py`` and ``sample_axis`` from
``stmbench/vista/archive.py``) on synthetic inputs and stores inputs and
results together in ``spec/golden/visual_memory.json``.

The reference lives in the STM-Bench source tree and is imported read-only from
``STMSIM_ROOT`` (no bytecode is written there). It needs NumPy and SciPy, not MAST.
Inputs are synthetic (seeded); no instrument data. The JSON records the sha256 of
the reference files it ran, because the reference is still under development.

    STMSIM_ROOT=<STM-Bench source root> python tools/spec-export/export_visual_memory.py
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # the reference tree is read-only

import hashlib  # noqa: E402
import json  # noqa: E402
import platform  # noqa: E402
import subprocess  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import numpy as np  # noqa: E402
import scipy  # noqa: E402

from _paths import require_stmsim_root  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "visual_memory.json"
SEED = 20261009

ROOT = require_stmsim_root()
sys.path.insert(0, str(ROOT))
from stmbench.vista import frames as F  # noqa: E402
from stmbench.vista.archive import sample_axis  # noqa: E402


def _plain(v: Any) -> Any:
    """JSON-safe values; NaN / ±inf as strings (the golden is written with allow_nan=False)."""
    if isinstance(v, np.ndarray):
        return _plain(v.tolist())
    if isinstance(v, (np.floating, np.integer, np.bool_)):
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
    return v


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _head(root: Path) -> str:
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


rng = np.random.default_rng(SEED)

# ── 1. display scale ─────────────────────────────────────────────────────
SCALE = []
for nx, ny, dm in [(256, 256, 768), (100, 50, 768), (512, 512, 768), (768, 768, 768), (1, 1, 768),
                   (769, 10, 768), (1536, 768, 768), (1537, 1, 768), (1000, 500, 768), (16, 12, 48), (17, 5, 48)]:
    num, den = F.scale_pair(nx, ny, dm)
    SCALE.append({"nx": nx, "ny": ny, "display_max": dm, "num": num, "den": den,
                  "display_size": list(F.display_size(nx, ny, dm)), "text": F.scale_text(num, den)})

# ── 2. display <-> scan-frame nm ─────────────────────────────────────────
GEOMS = [
    ({"cx_nm": 1.0, "cy_nm": 2.0, "w_nm": 8.0, "h_nm": 4.0, "angle_deg": 0.0, "nx": 16, "ny": 8}, 64),
    ({"cx_nm": 12.3, "cy_nm": -45.6, "w_nm": 20.0, "h_nm": 15.0, "angle_deg": 30.0, "nx": 256, "ny": 192}, 768),
    ({"cx_nm": -0.75, "cy_nm": 3.1, "w_nm": 7.5, "h_nm": 7.5, "angle_deg": -117.25, "nx": 100, "ny": 100}, 768),
    ({"cx_nm": 100.0, "cy_nm": 200.0, "w_nm": 300.0, "h_nm": 100.0, "angle_deg": 45.0, "nx": 1500, "ny": 500}, 768),
]
TRANSFORMS = []
for geom, dm in GEOMS:
    W, H = F.display_size(geom["nx"], geom["ny"], dm)
    pts = [(0.0, 0.0), (W / 2, H / 2), (float(W), float(H)), (0.5, 0.5), (1.5, 2.5)]
    pts += [(float(x), float(y)) for x, y in zip(rng.uniform(0, W, 6), rng.uniform(0, H, 6))]
    rows = []
    for x, y in pts:
        X, Y = F.display_to_scan_nm(geom, x, y, display_max=dm)
        bx, by = F.scan_nm_to_display(geom, X, Y, display_max=dm)
        rows.append({"x": x, "y": y, "X": float(X), "Y": float(Y), "back_x": float(bx), "back_y": float(by)})
    TRANSFORMS.append({"geometry": geom, "display_max": dm, "points": rows})

# ── 3. flattening, contrast, grey levels ─────────────────────────────────
NX, NY = 16, 12
yy, xx = np.mgrid[0:NY, 0:NX]
row_offsets = rng.normal(0.0, 4e-12, NY)
frame = (3e-10 + 2e-12 * xx - 1.5e-12 * yy + 0.08e-12 * (xx - 7.0) ** 2 + row_offsets[yy]
         + rng.normal(0.0, 0.5e-12, (NY, NX)))
frame[5, 9] += 40e-12  # a bump
frame = frame.astype(np.float32)
frame[NY - 2:, :] = np.nan  # two rows not acquired yet
one_row = np.full((NY, NX), np.nan, dtype=np.float32)
one_row[0, :] = frame[0, :]

FLATTEN = []
for name, z, mode, hp in [
    ("frame", frame, "none", 3.0), ("frame", frame, "plane", 3.0), ("frame", frame, "line", 3.0),
    ("frame", frame, "poly2", 3.0), ("frame", frame, "highpass", 0.6), ("frame", frame, "highpass", 2.5),
    ("one_row", one_row, "plane", 3.0),
]:
    zf = F.flatten(z, mode, nm_per_px=0.1, highpass_nm=hp)
    lo, hi = F.colour_limits(zf, 0.5)
    grey, nan = F.grey_levels(zf, lo, hi)
    FLATTEN.append({"input": name, "mode": mode, "highpass_nm": hp, "nm_per_px": 0.1, "values": zf,
                    "colour_limits": [lo, hi], "grey": grey, "nan": nan.astype(int)})

BLOCK_MEAN = {"input": "frame", "f": 3, "values": F.block_mean(frame.astype(float), 3)}

# ── 4. views of exact regions and their pixels ───────────────────────────
VIEWS = []
for nx, ny, num, den, region, dm in [
    (16, 12, 3, 1, None, 48), (16, 12, 3, 1, (6, 3, 18, 12), 48), (16, 12, 3, 1, (4, 2, 5, 7), 48),
    (1000, 600, 1, 2, None, 300), (9, 5, 1, 2, (1, 1, 4, 2), 768), (16, 12, 1, 1, None, 6),
]:
    v = F.plan_view(nx, ny, num, den, region, dm)
    VIEWS.append({"nx": nx, "ny": ny, "num": num, "den": den, "region": None if region is None else list(region),
                  "display_max": dm, "region_px": list(v.region_px), "native": list(v.native),
                  "image_size": list(v.image_size), "up": v.up, "down": v.down, "magnification": v.magnification})

plane = F.flatten(frame, "plane")
RENDER = []
for region, dm, clip in [(None, 48, 0.5), ((6, 3, 18, 12), 48, 0.5), ((0, 0, 48, 36), 24, 2.0)]:
    num, den = F.scale_pair(NX, NY, 48)
    v = F.plan_view(NX, NY, num, den, region, dm)
    i0, j0, i1, j1 = v.native
    crop = plane[j0:j1, i0:i1]
    lo, hi = F.colour_limits(crop, clip)
    if v.down > 1:
        crop = F.block_mean(crop, v.down)
    grey, nan = F.grey_levels(crop, lo, hi)
    img = F.compose_rgb(grey, nan)
    if img.ndim == 2:
        img = np.repeat(img[:, :, None], 3, axis=2)
    img = F.upscale(img, v.up)
    RENDER.append({"input": "frame/plane", "region": None if region is None else list(region), "display_max": dm,
                   "clip_pct": clip, "limits": [lo, hi], "width": int(img.shape[1]), "height": int(img.shape[0]),
                   "rgb": img.reshape(-1)})

g = GEOMS[1][0]
num, den = F.scale_pair(g["nx"], g["ny"], 768)
CORNERS = {"geometry": g, "display_max": 768, "region": [100, 60, 200, 150],
           "corners_nm": F.view_corners_nm(g, F.plan_view(g["nx"], g["ny"], num, den, (100, 60, 200, 150), 768))}

# ── 5. read_values sampling ──────────────────────────────────────────────
SAMPLE = []
for x0, w, n, num, den, n_native in [(0, 64, 4, 4, 1, 16), (10, 5, 2, 1, 1, 100), (0, 50, 3, 1, 2, 100),
                                     (0, 3, 1, 1, 4, 10), (0, 3, 1, 1, 4, 5), (7, 333, 17, 3, 1, 128), (3, 97, 13, 1, 3, 300)]:
    disp, nat = sample_axis(x0, w, n, num, den, n_native)
    SAMPLE.append({"x0": x0, "w": w, "n": n, "num": num, "den": den, "n_native": n_native,
                   "display": disp, "native": nat})

# ── 6. labels and fixed-decimal numbers ───────────────────────────────────
# Units and value rounding are left out on purpose: the reference changed them on
# 2026-10-09 (one model unit per quantity, span-based decimals, unit-suffixed keys)
# while the TypeScript side follows VISUAL-HARNESS (pm / pA / Hz, 0.1 rounding).
FMT_NUM = [{"value": v, "digits": nd, "text": F.fmt_num(v, nd)}
           for v, nd in [(-23.15, 1), (41.75, 1), (0.125, 2), (-0.04, 1), (12.625, 2), (1234.5, 0), (float("nan"), 1)]]
LABELS = [
    {"kind": "inspection", "attrs": [["index", 1], ["count", 2], ["label", 'a "q" <b> & c\nd'], ["frame", "t0007.s0"],
                                     ["scale", "2"], ["skip", None], ["z_range_pm", "-23.1..41.8"]]},
    {"kind": "current", "attrs": [["frame", "t0001.p0"], ["field_nm", f"{12.625:.4g}x{7.0:.4g}"]]},
]
for lab in LABELS:
    lab["label"] = F.visual_label(lab["kind"], **{k: v for k, v in lab["attrs"]})

frames_py = ROOT / "stmbench" / "vista" / "frames.py"
archive_py = ROOT / "stmbench" / "vista" / "archive.py"
golden = {
    "reference": {
        "frames_py_sha256": _sha(frames_py),
        "archive_py_sha256": _sha(archive_py),
        "stm_bench_head": _head(ROOT),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "seed": SEED,
    },
    "scale": SCALE,
    "transforms": TRANSFORMS,
    "frames": {"frame": frame, "one_row": one_row, "nx": NX, "ny": NY},
    "flatten": FLATTEN,
    "block_mean": BLOCK_MEAN,
    "views": VIEWS,
    "render": RENDER,
    "corners": CORNERS,
    "sample_axis": SAMPLE,
    "fmt_num": FMT_NUM,
    "labels": LABELS,
}
OUT.write_text(json.dumps(_plain(golden), ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n",
               encoding="utf-8", newline="\n")
print(f"wrote {OUT.relative_to(REPO)}")
