r"""Reference results of the VISTA-SPM display conventions for dsh-spm-visual-memory.

VISUAL-HARNESS §5 asks the TypeScript visual memory to match the Python
reference implementation of the same design: display scale, display <-> scan-nm
transforms, flattening, contrast, grey levels, views of exact regions, the
read_values sampling rule, model units, decimals, rounding, labels, and the
metric grid (graph paper) drawn on scan images since 2026-10-12. This
exporter runs the reference (``vista_spm/frames.py``, ``archive.py`` and
``viewtools.py``) on synthetic inputs and stores inputs and results together in
``spec/golden/visual_memory.json``, including the parsed ``inspect`` /
``read_values`` replies and the frame summaries of a small synthetic archive with
the key order the model reads, and the summaries of index records read back, so a
change of the model-facing vocabulary on either side fails a test. Since
2026-10-12 it also covers spectra: synthetic ``.dat`` files go through the
reference ``Archive.add_spectrum``, and the summaries, observation labels, the
spectrum views of ``inspect`` / ``read_values``, their refusals and the plot sizes
are recorded.

The reference is the VISTA-SPM harness (https://github.com/HamsterPark/VISTA-SPM) and is
imported read-only from ``VISTA_SPM_ROOT`` (no bytecode is written there). It needs
NumPy, SciPy, Pillow and matplotlib (the reference draws spectrum plots with it,
and the plot size is in every spectrum label). The reference reads ``.dat`` files
through MAST's ``mast.io.nanonis_files.read_dat``, so ``MAST_ROOT`` must name the
read-only directory that contains the ``mast`` package (MAST's ``MASTv2/``). Only
``mast/__init__.py``, ``mast/io/__init__.py`` and ``mast/io/nanonis_files.py`` are
imported, which need nothing beyond NumPy; ``MAST2_PROJECT_ROOT`` defaults to a
temporary directory as for every MAST exporter. STM-Bench is not needed: the
``.dat`` files are written here in the controller's text layout (the layout of
``stmsim.io.dat_writer``). The synthetic archives live in a temporary directory
that is removed afterwards. Inputs are synthetic (seeded); no instrument data. The
JSON records the sha256 of the reference files it ran, because the reference is
still under development.

The current golden was exported with Python 3.14.3, NumPy 2.4.3, SciPy 1.17.1
and matplotlib 3.10.8 (recorded under ``reference``). Another interpreter or NumPy
may change values of the older sections; re-export with one that keeps them.

    VISTA_SPM_ROOT=<VISTA-SPM source root> MAST_ROOT=<directory with mast/> \
        python tools/spec-export/export_visual_memory.py
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # the reference tree is read-only

import base64  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import platform  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import numpy as np  # noqa: E402
import scipy  # noqa: E402

from _paths import require_mast_root, require_vista_spm_root  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "visual_memory.json"
SEED = 20261009

ROOT = require_vista_spm_root()
sys.path.insert(0, str(ROOT))
MAST_ROOT = require_mast_root()
if not (MAST_ROOT / "mast" / "io" / "nanonis_files.py").is_file():
    raise RuntimeError(f"MAST_ROOT must contain mast/io/nanonis_files.py (MAST's MASTv2/ directory): {MAST_ROOT}")
MAST_RUNTIME = None  # an isolated MAST run directory made here, removed at the end
if not os.environ.get("MAST2_PROJECT_ROOT"):
    MAST_RUNTIME = tempfile.mkdtemp(prefix="vm-golden-mast-")
    os.environ["MAST2_PROJECT_ROOT"] = MAST_RUNTIME
if Path(os.environ["MAST2_PROJECT_ROOT"]).resolve().is_relative_to(MAST_ROOT.parent):
    raise RuntimeError(f"MAST2_PROJECT_ROOT points into the read-only reference: {os.environ['MAST2_PROJECT_ROOT']}")
sys.path.insert(1, str(MAST_ROOT))
import matplotlib  # noqa: E402
import mast.io.nanonis_files  # noqa: E402,F401  (what frames.load_dat imports; fail here, not mid-export)
from vista_spm import frames as F  # noqa: E402
from vista_spm import viewtools as V  # noqa: E402
from vista_spm.archive import Archive, FrameEntry, sample_axis  # noqa: E402


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
FMT_NUM = [{"value": v, "digits": nd, "text": F.fmt_num(v, nd)}
           for v, nd in [(-23.15, 1), (41.75, 1), (0.125, 2), (-0.04, 1), (12.625, 2), (1234.5, 0), (float("nan"), 1)]]
LABELS = [
    {"kind": "inspection", "attrs": [["index", 1], ["count", 2], ["label", 'a "q" <b> & c\nd'], ["frame", "t0007.s0"],
                                     ["scale", "2"], ["skip", None], ["z_range_pm", "-23.1..41.8"]]},
    {"kind": "current", "attrs": [["frame", "t0001.p0"], ["field_nm", f"{12.625:.4g}x{7.0:.4g}"]]},
]
for lab in LABELS:
    lab["label"] = F.visual_label(lab["kind"], **{k: v for k, v in lab["attrs"]})

# ── 7. model units, decimals and rounding ─────────────────────────────────
UNITS = {
    "display_unit": [{"si": si, "factor": F.display_unit(si)[0], "unit": F.display_unit(si)[1]}
                     for si in ["m", "A", "V", "Hz", "N", "deg", "s", "furlong", ""]],
    "unit_key": [{"name": n, "unit": u, "key": F.unit_key(n, u)}
                 for n, u in [("values", "pm"), ("black", "pA"), ("values", ""), ("range", "µV"), ("setpoint", "Hz")]],
    "range_attr": [{"channel": c, "unit": u, "attr": F.range_attr(c, u)}
                   for c, u in [("Z", "pm"), ("Current", "pA"), ("Frequency Shift", "Hz"), ("Bias", "V"), ("Mystery", ""),
                                ("Z", "V")]],
    "decimals_for": [{"span": s, "decimals": F.decimals_for(s)}
                     for s in [None, 0.0, -1.0, float("nan"), float("inf"), 0.0004, 0.004, 0.04, 0.4, 4.0, 40.0, 400.0,
                               10.0, 1.0, 0.1, 100.0, 99.99, 1e-9, 55.85, 125.73]],
    "rounding": [{"value": v, "decimals": d, "round_to": F.round_to(v, d),
                  "np_round": float(np.round(np.array([v]), d)[0] + 0.0)}
                 for v, d in [(248.85000000000002, 1), (2.675, 2), (12.345, 2), (0.125, 2), (1.005, 2), (-0.04, 1),
                              (0.25, 1), (2.5, 0), (123.456, 1), (-12345.678, 3)]],
    "robust_span": [{"arrays": arrs, "span": F.robust_span(*[np.array(a, dtype=float) for a in arrs])}
                    for arrs in [[[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, float("nan")]], [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]],
                                 [[float("nan")]]]],
}

# ── 7b. graph paper: spacing, line positions and pixels ──────────────────
# The metric grid the reference draws on scan images (frames.view_grid / grid_lines /
# draw_grid): the spacing a view gets, the image rows and columns its lines fall on, and the
# pixels of the 16x12 frame rendered with it, including anisotropic and downsampled views.
def _rgb(png: bytes) -> np.ndarray:
    from PIL import Image
    import io

    with Image.open(io.BytesIO(png)) as im:
        return np.asarray(im.convert("RGB"))


GRID = {
    "constants": {"rgb": list(F.GRID_RGB), "colour_name": F.GRID_COLOUR_NAME, "max_cells": F.GRID_MAX_CELLS,
                  "min_cell_px": F.GRID_MIN_CELL_PX},
    "nice_step": [{"x": x, "step": F.nice_step(x)}
                  for x in (0.3, 0.5, 0.51, 1.0, 1.2, 2.0, 2.01, 4.375, 7.0, 0.0137, 1e-3, 1000.0, 6.25, 0.546875,
                            3.2, 0.2, 1e-5, 123456.0, 0.05000000001, 0.04999999999)],
    "views": [],
    "render": [],
}
for nx, ny, num, den, region, dm, px, py in [
    (256, 256, 3, 1, None, 768, 70 / 256, 70 / 256), (256, 256, 3, 1, (300, 300, 96, 96), 768, 70 / 256, 70 / 256),
    (256, 256, 3, 1, (300, 300, 9, 9), 768, 70 / 256, 70 / 256), (1024, 1024, 1, 2, None, 768, 100 / 1024, 100 / 1024),
    (1024, 1024, 1, 2, (100, 40, 64, 200), 768, 100 / 1024, 100 / 1024), (64, 512, 1, 1, None, 768, 0.1, 0.1),
    (16, 12, 3, 1, (6, 3, 18, 12), 48, 0.5, 0.5), (384, 128, 2, 1, (10, 7, 333, 101), 768, 0.03125, 0.0625),
]:
    v = F.plan_view(nx, ny, num, den, region, dm)
    gr = F.view_grid(v, px, py)
    i0, j0, i1, j1 = v.native
    W, H = v.image_size
    GRID["views"].append({"nx": nx, "ny": ny, "num": num, "den": den, "region": None if region is None else list(region),
                          "display_max": dm, "nm_per_px_x": px, "nm_per_px_y": py, "spacing_nm": gr.spacing_nm,
                          "xs": F.grid_lines(i0, i1, gr.spacing_nm / px, v.up, v.down, W),
                          "ys": F.grid_lines(j0, j1, gr.spacing_nm / py, v.up, v.down, H)})
for region, dm, clip, px, py in [(None, 48, 0.5, 0.5, 0.5), ((6, 3, 18, 12), 48, 0.5, 0.5, 0.5),
                                 ((0, 0, 48, 36), 24, 2.0, 0.5, 0.5), (None, 48, 0.5, 0.3, 0.45)]:
    num, den = F.scale_pair(NX, NY, 48)
    v = F.plan_view(NX, NY, num, den, region, dm)
    gr = F.view_grid(v, px, py)
    png, lo, hi = F.render_values(plane, v, clip_pct=clip, grid=gr)
    img = _rgb(png)
    GRID["render"].append({"input": "frame/plane", "region": None if region is None else list(region),
                           "display_max": dm, "clip_pct": clip, "nm_per_px_x": px, "nm_per_px_y": py,
                           "spacing_nm": gr.spacing_nm, "limits": [lo, hi], "width": int(img.shape[1]),
                           "height": int(img.shape[0]), "rgb": img.reshape(-1)})

# ── 8. the reference archive and its view tools, end to end ──────────────
# Synthetic partial scans and derived images go through the reference Archive in a
# temporary directory; the summaries, labels and parsed inspect / read_values replies are
# the model-facing contract the TypeScript port must reproduce. Reply text is compact JSON
# in insertion order (protocol.compact_json) while this golden is written with sorted keys,
# so the key order the model reads is recorded separately, as key paths.


def _key_paths(obj: Any, path: str = "$") -> list[str]:
    """Every key of a parsed reply, depth first in insertion order (``$.views[0].frame``)."""
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(f"{path}.{k}")
            out += _key_paths(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += _key_paths(v, f"{path}[{i}]")
    return out


z_fwd = frame
z_bwd = (frame + np.float32(1.5e-12)).astype(np.float32)
current = (1.2e-10 + 3e-12 * np.sin(xx / 2.5) + 1e-12 * yy).astype(np.float32)
current[NY - 2:, :] = np.nan
flat_z = np.full((NY, NX), 2e-9, dtype=np.float32)
df = (-3.0 + 0.4 * np.cos(xx / 3.0) * np.sin(yy / 2.0) + rng.normal(0.0, 0.02, (NY, NX))).astype(np.float32)
diff = rng.normal(0.0, 2e-12, (NY, NX)).astype(np.float32)
GEOM_A = {"cx_nm": 12.5, "cy_nm": -3.25, "w_nm": 8.0, "h_nm": 6.0, "angle_deg": 30.0}
GEOM_B = {"cx_nm": 0.0, "cy_nm": 0.0, "w_nm": 2.0, "h_nm": 1.5, "angle_deg": 0.0}
META_A = {"bias_v": -0.5, "setpoint_a": 1.23456e-10, "scan_dir": "down", "rec_time": "09.10.2026 12:00:00",
          "feedback": "ON", "source_name": "synthetic_a"}
META_B = {"units": {"Frequency Shift": "Hz"}, "setpoint_a": -2.5, "setpoint_unit": "Hz", "feedback": "OFF"}
# A frame wider than display_max (block mean by 3: display_scale_frac "1/3") with rows still
# missing and a simulation time. Its heights are small integers times 1 pm, stored as those
# integers (None for rows not acquired yet) to keep the golden small.
NX_C, NY_C, ROWS_C = 130, 24, 20
K_C = [[(7 * x + 3 * y) % 17 if y < ROWS_C else None for x in range(NX_C)] for y in range(NY_C)]
z_c = (np.array(K_C, dtype=float) * 1e-12).astype(np.float32)
GEOM_C = {"cx_nm": -40.0, "cy_nm": 15.5, "w_nm": 65.0, "h_nm": 12.0, "angle_deg": -12.5}
META_C = {"bias_v": 1.25, "setpoint_a": 3.3e-11, "scan_dir": "up", "rec_time": "09.10.2026 12:10:00",
          "source_name": "synthetic_c"}
SIM_S_C = 12.34567
png_plain = F.encode_png((np.arange(32, dtype=np.uint8).reshape(4, 8) * 8).astype(np.uint8))
png_map = F.encode_png(np.zeros((48, 64), dtype=np.uint8))

work = Path(tempfile.mkdtemp(prefix="vm-golden-"))
try:
    arc = Archive(work, display_max=64)
    eA = arc.add_partial(2, {"Z/forward": z_fwd, "Z/backward": z_bwd, "Current/forward": current},
                         geometry=GEOM_A, meta=META_A)
    eB = arc.add_partial(3, {"Z": flat_z, "Frequency Shift": df}, geometry=GEOM_B, meta=META_B)
    eM = arc.add_derived(3, png_plain, meta={"tool": "stm_fft_peaks", "sources": [eA.fid],
                                             "description": "log magnitude", "label_attrs": {"peaks": 3}})
    eD = arc.add_derived(3, png_map, meta={"tool": "stm_frame_diff", "sources": [eA.fid, eA.fid],
                                           "geometry": GEOM_A, "units": {"diff": "m"}},
                         arrays={"diff/forward": diff})
    eC = arc.add_partial(4, {"Z": z_c}, geometry=GEOM_C, meta=META_C, sim_s=SIM_S_C)
    INSPECT_ARGS = [
        {"question": "overview", "views": [
            {"label": "A", "frame": eA.fid},
            {"label": "A backward, line", "frame": eA.fid, "direction": "backward",
             "region": {"x": 8, "y": 4, "width": 24, "height": 20}, "flatten": "line", "clip_pct": 2},
            {"label": "current, highpass", "frame": eA.fid, "channel": "Current", "flatten": "highpass",
             "highpass_nm": 1.5},
            {"label": "A poly2", "frame": eA.fid, "flatten": "poly2", "clip_pct": 0}]},
        {"question": "constant height", "views": [
            {"label": "B", "frame": eB.fid},
            {"label": "B z", "frame": eB.fid, "channel": "Z", "flatten": "none"}]},
        {"question": "derived", "views": [
            {"label": "fft crop", "frame": eM.fid, "region": {"x": 2, "y": 1, "width": 4, "height": 2}},
            {"label": "map", "frame": eD.fid}]},
        {"question": "wide frame", "views": [
            {"label": "C", "frame": eC.fid},
            {"label": "C crop", "frame": eC.fid, "region": {"x": 5, "y": 2, "width": 20, "height": 5}}]},
    ]
    READ_ARGS = [
        {"question": "grid", "views": [
            {"label": "A z", "frame": eA.fid, "rows": 3, "columns": 4},
            {"label": "A current", "frame": eA.fid, "channel": "Current",
             "region": {"x": 10, "y": 6, "width": 30, "height": 30}, "rows": 2, "columns": 2},
            {"label": "A backward, bottom", "frame": eA.fid, "direction": "backward",
             "region": {"x": 0, "y": 30, "width": 64, "height": 18}, "rows": 3, "columns": 2}]},
        {"question": "df", "views": [{"label": "B df", "frame": eB.fid, "channel": "df", "rows": 2, "columns": 3}]},
        {"question": "map", "views": [{"label": "D", "frame": eD.fid, "rows": 1, "columns": 2}]},
        {"question": "wide frame", "views": [
            {"label": "C grid", "frame": eC.fid, "rows": 2, "columns": 3},
            {"label": "C crop", "frame": eC.fid, "region": {"x": 5, "y": 2, "width": 20, "height": 5},
             "rows": 2, "columns": 2}]},
    ]
    INSPECT = []
    for args in INSPECT_ARGS:
        reply = V.inspect(arc, args)
        parsed = json.loads(reply.text)
        INSPECT.append({"args": args, "is_error": reply.is_error, "reply": parsed, "key_paths": _key_paths(parsed),
                        "labels": [im.label for im in reply.images]})
    READ = []
    for args in READ_ARGS:
        reply = V.read_values(arc, args)
        parsed = json.loads(reply.text)
        READ.append({"args": args, "is_error": reply.is_error, "reply": parsed, "key_paths": _key_paths(parsed)})
    fids = [e.fid for e in (eA, eB, eM, eD, eC)]
    index = arc.index()
    ARCHIVE = {
        "display_max": 64,
        "inputs": {"z_forward": z_fwd, "z_backward": z_bwd, "current": current, "flat_z": flat_z, "df": df,
                   "diff": diff, "geometry_a": GEOM_A, "geometry_b": GEOM_B, "meta_a": META_A, "meta_b": META_B,
                   "k_c": K_C, "geometry_c": GEOM_C, "meta_c": META_C, "sim_s_c": SIM_S_C,
                   "png_plain_b64": base64.b64encode(png_plain).decode("ascii"),
                   "png_map_b64": base64.b64encode(png_map).decode("ascii")},
        "frames": fids,
        "index": index,
        "index_key_paths": _key_paths(index),
        "observations": {fid: arc.observation(fid)[0].label for fid in fids},
        "inspect": INSPECT,
        "read_values": READ,
    }

    # ── 9. summaries of index records read back ──────────────────────────
    # Saved scans and spectra come from .sxm / .dat files that the reference reads with MAST,
    # so their summaries are pinned through FrameEntry.from_record, the way a re-opened
    # archive reads index.jsonl: the record of frame A as a complete saved scan, a spectrum
    # with its position and experiment, and a bare spectrum that relies on the field defaults.
    rec_a = arc.get(eA.fid).to_record()
    rec_scan = dict(rec_a, fid="t0002.s0", kind="s", index=0, acquired_rows=rec_a["ny"], sim_s=3.21,
                    extra=dict(rec_a["extra"], feedback="OFF"))
    rec_sts = {"fid": "t0005.d0", "turn": 5, "kind": "d", "index": 0, "source_name": "synthetic_sts",
               "channels": ["Bias (V)", "Current (A)"], "nx": 128, "ny": 1, "setpoint_a": 5e-11,
               "rec_time": "09.10.2026 12:30:00", "units": {"Bias (V)": "V", "Current (A)": "A"},
               "default_channel": "Current (A)",
               "extra": {"position_nm": [1.234567, -2.5], "experiment": "bias spectroscopy"}}
    rec_bare = {"fid": "t0005.d1", "turn": 5, "kind": "d", "index": 1, "rec_time": None,
                "extra": {"position_nm": [], "experiment": ""}}
    SUMMARIES = []
    for rec in (rec_scan, rec_sts, rec_bare):
        summ = FrameEntry.from_record(rec).summary()
        SUMMARIES.append({"record": rec, "summary": summ, "key_paths": _key_paths(summ)})

    # ── 10. an archive that draws the graph paper ────────────────────────
    # Archive(grid=True): the observation labels carry grid_nm, every scan view of inspect
    # reports its own grid_nm, and the stored observation pixels carry the lines.
    garc = Archive(work / "grid", display_max=64, grid=True)
    gA = garc.add_partial(2, {"Z/forward": z_fwd, "Z/backward": z_bwd, "Current/forward": current},
                          geometry=GEOM_A, meta=META_A)
    gC = garc.add_partial(4, {"Z": z_c}, geometry=GEOM_C, meta=META_C, sim_s=SIM_S_C)
    G_ARGS = {"question": "graph paper", "views": [
        {"label": "A", "frame": gA.fid},
        {"label": "A zoom", "frame": gA.fid, "region": {"x": 8, "y": 4, "width": 24, "height": 20}},
        {"label": "C", "frame": gC.fid},
        {"label": "C crop", "frame": gC.fid, "region": {"x": 5, "y": 2, "width": 20, "height": 5}}]}
    g_reply = V.inspect(garc, G_ARGS)
    g_parsed = json.loads(g_reply.text)
    GRID["archive"] = {
        "display_max": 64,
        "frames": [gA.fid, gC.fid],
        "observations": {e.fid: garc.observation(e.fid)[0].label for e in (gA, gC)},
        "observation_rgb": {e.fid: _rgb(garc.observation(e.fid)[0].png).reshape(-1) for e in (gA, gC)},
        "inspect": {"args": G_ARGS, "is_error": g_reply.is_error, "reply": g_parsed,
                    "key_paths": _key_paths(g_parsed), "labels": [im.label for im in g_reply.images],
                    "rgb": [_rgb(im.png).reshape(-1) for im in g_reply.images]},
        "description": V.make_inspect_tool(64, grid=True).description,
    }
    # ── 11. spectra ──────────────────────────────────────────────────────
    # Synthetic .dat files in the controller's text layout (stmsim.io.dat_writer: "key\tvalue\t"
    # lines, a blank line, [DATA], the column names, rows of "%.6E") go through the reference
    # Archive.add_spectrum, which reads them with MAST's read_dat. The TypeScript port writes the
    # same bytes and must give the same summaries, observation labels, spectrum views of inspect
    # and read_values (key order included) and refusals. The plot pixels come from matplotlib and
    # are not compared; their size is in every label, so plot sizes for a range of widths are
    # recorded too (matplotlib truncates each side to int(px / 100 * 100)).
    srng = np.random.default_rng(SEED + 11)  # its own stream: the sections above stay as they were

    def _dat_value(v: Any) -> str:
        if isinstance(v, bool):
            return "TRUE" if v else "FALSE"
        if isinstance(v, int):
            return str(v)
        if isinstance(v, float):
            return f"{v:.6E}"
        return str(v)

    def _dat_text(header: dict, names: list[str], columns: list[np.ndarray]) -> str:
        lines = [f"{k}\t{_dat_value(v)}\t" for k, v in header.items()]
        lines += ["", "[DATA]", "\t".join(names)]
        for row in np.column_stack([np.asarray(c, dtype=float) for c in columns]):
            lines.append("\t".join("%.6E" % v for v in row))
        return "\n".join(lines) + "\n"

    bias = np.linspace(-0.5, 0.5, 41)
    i_fwd = 2e-10 * bias + 3e-11 * bias ** 3 + srng.normal(0.0, 2e-13, bias.size)
    sts_text = _dat_text(
        {"Experiment": "bias spectroscopy", "Date": "12.10.2026 09:00:00", "Saved Date": "12.10.2026 09:00:05",
         "User": "stmsim", "X (m)": 1.234567e-9, "Y (m)": -2.5e-9, "Z (m)": 3.1e-9, "Bias>Bias (V)": 0.5,
         "Z-Controller>Setpoint": 1e-10, "Z-Controller>Controller status": "ON", "Bias Spectroscopy>Num Pixel": 41,
         "Bias Spectroscopy>Z-controller hold": True, "Comment01": ""},
        ["Bias calc (V)", "Current (A)", "Current [bwd] (A)", "LI Demod 1 X (A)"],
        [bias, i_fwd, i_fwd + 5e-13, 1e-12 + 1e-13 * bias + srng.normal(0.0, 1e-15, bias.size)])
    z_rel = np.linspace(-2e-10, 3e-10, 30)
    amplitude = np.full(z_rel.size, 5e-11)
    amplitude[-4:] = np.nan  # the oscillation was lost: the controller writes NaN
    z_text = _dat_text(
        {"Experiment": "Z spectroscopy", "Saved Date": "12.10.2026 09:10:00", "X (m)": -4.0e-9, "Y (m)": 7.5e-10,
         "Bias>Bias (V)": 0.05, "Z-Controller>Setpoint": -2.5, "Z-Controller>Setpoint unit": "Hz",
         "Z-Controller>Controller status": "OFF", "Oscillation Control>Center Frequency (Hz)": 30300.0},
        ["Z rel (m)", "Current (A)", "OC M1 Freq. Shift (Hz)", "OC D1 Amplitude (m)", "Z (m)", "Index"],
        [z_rel, 1e-10 * np.exp(-z_rel / 5e-11), -3.0 - 2.0 * np.exp(-(z_rel + 2e-10) / 1e-10) + srng.normal(0.0, 0.01, z_rel.size),
         amplitude, 3.1e-9 + z_rel, np.arange(z_rel.size, dtype=float)])
    bare_text = _dat_text({"X (m)": 2.0e-9}, ["Current (A)"], [np.array([1e-10, 1.5e-10, 1.25e-10, 2e-10, 1.75e-10])])
    K_P = [[(3 * x + 5 * y) % 11 for x in range(8)] for y in range(8)]  # heights in pm, stored as integers
    GEOM_P = {"cx_nm": 1.0, "cy_nm": -1.0, "w_nm": 2.0, "h_nm": 2.0, "angle_deg": 0.0}
    META_P = {"source_name": "synthetic_p", "bias_v": 0.1, "setpoint_a": 5e-11}
    SPECTRA_DISPLAY_MAX = 768

    sdir = work / "spectra-in"
    sdir.mkdir()
    (sdir / "sts_a.dat").write_text(sts_text, encoding="ascii", newline="\n")
    (sdir / "z_b.dat").write_text(z_text, encoding="ascii", newline="\n")
    (sdir / "bare.dat").write_text(bare_text, encoding="ascii", newline="\n")
    sarc = Archive(work / "spectra", display_max=SPECTRA_DISPLAY_MAX)
    sP = sarc.add_partial(4, {"Z": (np.array(K_P, dtype=float) * 1e-12).astype(np.float32)}, geometry=GEOM_P, meta=META_P)
    sA = sarc.add_spectrum(5, sdir / "sts_a.dat", sim_s=12.5)
    sB = sarc.add_spectrum(5, sdir / "z_b.dat")
    sC = sarc.add_spectrum(6, sdir / "bare.dat")
    S_INSPECT_ARGS = [
        {"question": "bias spectrum", "views": [
            {"label": "default", "frame": sA.fid},
            {"label": "current near zero", "frame": sA.fid, "y_col": "Current", "x_range": [-0.2, 0.25]},
            {"label": "swapped", "frame": sA.fid, "x_col": "current", "y_col": "bias calc", "x_range": [50, -30]}]},
        {"question": "z spectrum", "views": [
            {"label": "z default", "frame": sB.fid},
            {"label": "df", "frame": sB.fid, "y_col": "df", "x_range": [-200, -100]},
            {"label": "by index", "frame": sB.fid, "x_col": "Index", "y_col": "OC D1 Amplitude", "x_range": [20, 29]}]},
        {"question": "bare", "views": [{"label": "bare", "frame": sC.fid}]},
        {"question": "mixed", "views": [{"label": "scan", "frame": sP.fid}, {"label": "plot", "frame": sA.fid, "y_col": "LI Demod 1 X"}]},
    ]
    S_READ_ARGS = [
        {"question": "bias spectrum", "views": [
            {"label": "around zero", "frame": sA.fid, "x_range": [-0.1, 0.1], "n": 3, "y_cols": ["Current"]},
            {"label": "all", "frame": sA.fid},
            {"label": "by current", "frame": sA.fid, "x_col": "Current", "x_range": [-6, 6], "n": 50,
             "y_cols": ["bias calc", "Current"]}]},
        {"question": "z spectrum", "views": [
            {"label": "z df", "frame": sB.fid, "y_cols": ["df", "OC D1 Amplitude"], "n": 7},
            {"label": "index range", "frame": sB.fid, "x_col": "Index", "x_range": [5.5, 12], "y_cols": ["Z"]},
            {"label": "z ends", "frame": sB.fid, "x_range": [-200, -100], "y_cols": ["Current"]}]},
        {"question": "bare", "views": [{"label": "bare", "frame": sC.fid, "n": 2}]},
        {"question": "mixed", "views": [{"label": "scan", "frame": sP.fid, "rows": 2, "columns": 2},
                                        {"label": "sts", "frame": sA.fid, "n": 4, "y_cols": ["LI Demod 1 X"]}]},
    ]
    S_ERROR_ARGS = [
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "region": {"x": 0, "y": 0, "width": 5, "height": 5}}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_range": [900, 1000]}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sB.fid, "x_range": [1e-7, 2e-7]}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_range": [1]}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_range": [0.5, 0.5]}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "y_col": 3}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sP.fid, "x_col": "Z"}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "rows": 2}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_col": "phase"}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sB.fid, "y_col": "phase"}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_col": ""}]}),
        ("inspect", {"question": "q", "views": [{"label": "r", "frame": "t0005.d7"}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "rows": 2, "columns": 2}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_range": [900, 1000]}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sB.fid, "x_range": [1e-7, 2e-7]}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_range": [True, 1]}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "y_cols": "Current"}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "y_cols": []}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "n": 0}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "n": 4097}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "n": 2.5}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_col": "x" * 65}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sP.fid, "n": 3, "rows": 1, "columns": 1}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sA.fid, "x_col": "phase"}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sB.fid, "y_cols": ["Current", "phase"]}]}),
        ("read_values", {"question": "q", "views": [{"label": "r", "frame": sC.fid, "y_cols": ["Current", 3]}]}),
        ("read_values", {"question": "q", "views": [{"label": "a", "frame": sA.fid},
                                                    {"label": "b", "frame": sP.fid, "rows": 64, "columns": 64}]}),
    ]
    S_INSPECT = []
    for args in S_INSPECT_ARGS:
        reply = V.inspect(sarc, args)
        parsed = json.loads(reply.text)
        S_INSPECT.append({"args": args, "is_error": reply.is_error, "reply": parsed, "key_paths": _key_paths(parsed),
                          "labels": [im.label for im in reply.images],
                          "image_sizes": [list(F.png_size(im.png)) for im in reply.images]})
    S_READ = []
    for args in S_READ_ARGS:
        reply = V.read_values(sarc, args)
        parsed = json.loads(reply.text)
        S_READ.append({"args": args, "is_error": reply.is_error, "reply": parsed, "key_paths": _key_paths(parsed)})
    S_ERRORS = []
    for tool, args in S_ERROR_ARGS:
        reply = (V.inspect if tool == "inspect" else V.read_values)(sarc, args)
        S_ERRORS.append({"tool": tool, "args": args, "is_error": reply.is_error, "error": json.loads(reply.text)["error"]})
    s_fids = [e.fid for e in (sP, sA, sB, sC)]
    s_index = sarc.index()
    tiny = {"x (V)": np.array([-1.0, 0.0, 1.0]), "y (A)": np.array([0.0, 1e-12, 2e-12])}
    tiny_units = {c: F.column_unit(c) for c in tiny}
    PLOT_SIZE = []
    for width in (64, 600, 601, 768, 802, 803, 829, 1000, 1024, 1536, 2048):
        for panels in (1, 2, 3, 4):
            png, _ = F.render_spectrum(tiny, tiny_units, x_col="x (V)", y_cols=["y (A)"] * panels, width_px=width)
            PLOT_SIZE.append({"width_px": width, "panels": panels, "size": list(F.png_size(png))})
    SPECTRA = {
        "display_max": SPECTRA_DISPLAY_MAX,
        "inputs": {"dat": {"sts_a.dat": sts_text, "z_b.dat": z_text, "bare.dat": bare_text}, "k_p": K_P,
                   "geometry_p": GEOM_P, "meta_p": META_P, "sim_s_a": 12.5},
        "frames": s_fids,
        "index": s_index,
        "index_key_paths": _key_paths(s_index),
        "observations": {fid: sarc.observation(fid)[0].label for fid in s_fids},
        "inspect": S_INSPECT,
        "read_values": S_READ,
        "errors": S_ERRORS,
        "plot_size": PLOT_SIZE,
        "descriptions": {"inspect": V.make_inspect_tool(SPECTRA_DISPLAY_MAX).description,
                         "read_values": V.make_read_values_tool(SPECTRA_DISPLAY_MAX).description},
    }
finally:
    shutil.rmtree(work, ignore_errors=True)
    if MAST_RUNTIME is not None:
        shutil.rmtree(MAST_RUNTIME, ignore_errors=True)

frames_py = ROOT / "vista_spm" / "frames.py"
archive_py = ROOT / "vista_spm" / "archive.py"
viewtools_py = ROOT / "vista_spm" / "viewtools.py"
nanonis_files_py = MAST_ROOT / "mast" / "io" / "nanonis_files.py"
golden = {
    "reference": {
        "frames_py_sha256": _sha(frames_py),
        "archive_py_sha256": _sha(archive_py),
        "viewtools_py_sha256": _sha(viewtools_py),
        "mast_nanonis_files_py_sha256": _sha(nanonis_files_py),
        "vista_spm_head": _head(ROOT),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "matplotlib": matplotlib.__version__,
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
    "units": UNITS,
    "archive": ARCHIVE,
    "summaries": SUMMARIES,
    "grid": GRID,
    "spectra": SPECTRA,
}
OUT.write_text(json.dumps(_plain(golden), ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n",
               encoding="utf-8", newline="\n")
print(f"wrote {OUT.relative_to(REPO)}")
