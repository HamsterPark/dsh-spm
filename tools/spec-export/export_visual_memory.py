r"""Reference results of the VISTA-STM display conventions for dsh-spm-visual-memory.

VISUAL-HARNESS §5 asks the TypeScript visual memory to match the Python
reference implementation of the same design: display scale, display <-> scan-nm
transforms, flattening, contrast, grey levels, views of exact regions, the
read_values sampling rule, model units, decimals, rounding and labels. This
exporter runs the reference (``stmbench/vista/frames.py``, ``archive.py`` and
``viewtools.py``) on synthetic inputs and stores inputs and results together in
``spec/golden/visual_memory.json``, including the parsed ``inspect`` /
``read_values`` replies and the frame summaries of a small synthetic archive, so a
change of the model-facing vocabulary on either side fails a test.

The reference lives in the STM-Bench source tree and is imported read-only from
``STMSIM_ROOT`` (no bytecode is written there). It needs NumPy, SciPy and Pillow,
not MAST or matplotlib; the synthetic archive lives in a temporary directory that
is removed afterwards.
Inputs are synthetic (seeded); no instrument data. The JSON records the sha256 of
the reference files it ran, because the reference is still under development.

    STMSIM_ROOT=<STM-Bench source root> python tools/spec-export/export_visual_memory.py
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # the reference tree is read-only

import base64  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import platform  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
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
from stmbench.vista import viewtools as V  # noqa: E402
from stmbench.vista.archive import Archive, sample_axis  # noqa: E402


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

# ── 8. the reference archive and its view tools, end to end ──────────────
# Synthetic partial scans and derived images go through the reference Archive in a
# temporary directory; the summaries, labels and parsed inspect / read_values replies are
# the model-facing contract the TypeScript port must reproduce.
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
    ]
    INSPECT = []
    for args in INSPECT_ARGS:
        reply = V.inspect(arc, args)
        INSPECT.append({"args": args, "is_error": reply.is_error, "reply": json.loads(reply.text),
                        "labels": [im.label for im in reply.images]})
    READ = []
    for args in READ_ARGS:
        reply = V.read_values(arc, args)
        READ.append({"args": args, "is_error": reply.is_error, "reply": json.loads(reply.text)})
    fids = [e.fid for e in (eA, eB, eM, eD)]
    ARCHIVE = {
        "display_max": 64,
        "inputs": {"z_forward": z_fwd, "z_backward": z_bwd, "current": current, "flat_z": flat_z, "df": df,
                   "diff": diff, "geometry_a": GEOM_A, "geometry_b": GEOM_B, "meta_a": META_A, "meta_b": META_B,
                   "png_plain_b64": base64.b64encode(png_plain).decode("ascii"),
                   "png_map_b64": base64.b64encode(png_map).decode("ascii")},
        "frames": fids,
        "index": arc.index(),
        "observations": {fid: arc.observation(fid)[0].label for fid in fids},
        "inspect": INSPECT,
        "read_values": READ,
    }
finally:
    shutil.rmtree(work, ignore_errors=True)

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
    "units": UNITS,
    "archive": ARCHIVE,
}
OUT.write_text(json.dumps(_plain(golden), ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n",
               encoding="utf-8", newline="\n")
print(f"wrote {OUT.relative_to(REPO)}")
