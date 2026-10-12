r"""Reference results of the VISTA-SPM measurement tools ``line_profile`` and ``stats``.

VISUAL-HARNESS §5 asks the TypeScript port (``stm_line_profile`` and
``stm_frame_stats`` in dsh-spm-visual-memory) to match the Python reference of the
same tools. This exporter runs the reference (``vista_spm/measure.py`` with the
archive, frames and argument helpers it uses) on synthetic frames and stores, in
``spec/golden/measure_profile.json``:

* the input frames (float32, base64 little-endian), their geometry and the order and
  turns in which they enter two synthetic archives (``display_max`` 768 and 64);
* every tool call in order, with its arguments, whether it failed, the parsed reply,
  the reply's keys in the order the model reads them and the labels of the images;
* for each ``line_profile`` call, the exact distances and values the reference passed
  to ``change_points`` and what it returned (the wrapper below records them; it does
  not change the call);
* ``change_points`` on its own (the reference's unit-test inputs and edge cases), and
  ``math.hypot`` on Pythagorean triples and random pairs (the profile's sample count is
  ``ceil(hypot) + 1``);
* the two tool descriptions and the sha256 of the reference files.

The reference is the VISTA-SPM harness (its own repository, not public yet) and is
imported read-only from ``VISTA_SPM_ROOT`` (no bytecode is written there). It needs
NumPy, SciPy, Pillow and, for the profile plot ``line_profile`` draws, matplotlib; the
plot's pixels are not recorded, only its size through the derived frame's label. The
archives live in a temporary directory that is removed afterwards. Inputs are
synthetic (seeded); no instrument data.

    VISTA_SPM_ROOT=<VISTA-SPM source root> PYTHONUTF8=1 python tools/spec-export/export_measure_profile.py
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # the reference tree is read-only

import base64  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import platform  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import matplotlib  # noqa: E402  (the reference draws the profile plot with it)
import numpy as np  # noqa: E402
import scipy  # noqa: E402

from _paths import require_vista_spm_root  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "measure_profile.json"
SEED = 20261012

ROOT = require_vista_spm_root()
sys.path.insert(0, str(ROOT))
from vista_spm import frames as F  # noqa: E402
from vista_spm import measure as M  # noqa: E402
from vista_spm.archive import Archive  # noqa: E402


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


def _key_paths(obj: Any, path: str = "$") -> list[str]:
    """Every key of a parsed reply, depth first in insertion order (``$.steps[0].id``)."""
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(f"{path}.{k}")
            out += _key_paths(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += _key_paths(v, f"{path}[{i}]")
    return out


def _f32_b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")


# ── recording change_points inside line_profile ──────────────────────────
# line_profile looks change_points up as a module global at call time, so wrapping the
# attribute records the exact float64 inputs (distances along the line, values in the
# model unit) and outputs of every call without changing what the tool computes.
_REAL_CHANGE_POINTS = M.change_points
_CAPTURED: list[dict] = []


def _recording_change_points(x, y, **kw):
    steps, sigma, segs = _REAL_CHANGE_POINTS(x, y, **kw)
    _CAPTURED.append({"x": np.array(x, dtype=float), "y": np.array(y, dtype=float), "kwargs": dict(kw),
                      "steps": steps, "sigma": sigma, "segments": segs})
    return steps, sigma, segs


M.change_points = _recording_change_points

rng = np.random.default_rng(SEED)

# ── 1. change_points on its own ───────────────────────────────────────────
# The reference's unit-test inputs (tests/test_measure.py::test_change_points_unit) and
# edge cases: too few points, a constant profile (sigma falls back to 1e-12), a clean step
# (zero MAD, sigma from the standard deviation of the differences), non-finite samples,
# and explicit options.
CHANGE_POINTS = []


def _cp(name: str, x: np.ndarray, y: np.ndarray, **kw: Any) -> None:
    steps, sigma, segs = _REAL_CHANGE_POINTS(x, y, **kw)
    CHANGE_POINTS.append({"name": name, "x": np.asarray(x, dtype=float), "y": np.asarray(y, dtype=float),
                          "kwargs": kw, "steps": steps, "sigma": sigma, "segments": segs})


x_u = np.linspace(0, 10, 201)
_cp("step_on_slope", x_u, np.where(x_u > 4.0, 2.0, 0.0) + 0.3 * x_u + np.random.default_rng(1).normal(0, 0.05, x_u.size))
_cp("flat_noise", x_u, np.random.default_rng(2).normal(0, 0.05, x_u.size))
r3 = np.random.default_rng(3)
ramp = np.clip((x_u - 6.0) / 0.5, 0.0, 1.0) * 2.35 + r3.normal(0, 0.03, x_u.size)
_cp("broadened_step", x_u, ramp)
bump = 1.5 * np.exp(-((x_u - 5.0) / 0.15) ** 2) + r3.normal(0, 0.03, x_u.size)
_cp("narrow_bump", x_u, bump)
stair = 0.25 * x_u - np.where(x_u > 3.3, 1.0, 0) - np.where(x_u > 6.7, 1.0, 0) + r3.normal(0, 0.03, x_u.size)
_cp("staircase", x_u, stair)
_cp("staircase_one_split", x_u, stair, max_splits=1)
_cp("broadened_step_no_merge", x_u, ramp, merge=0.01)
_cp("staircase_min_seg_10_high_bar", x_u, stair, min_seg=10, min_height_sigma=40.0)
_cp("too_short", np.arange(6.0), np.array([0.0, 0.0, 0.0, 1.0, 1.0, 1.0]))
_cp("constant", np.arange(20.0) * 0.1, np.zeros(20))
_cp("clean_step", np.arange(20.0) * 0.1, np.where(np.arange(20) >= 10, 1.0, 0.0))
y_nan = np.where(x_u > 5.0, 1.0, 0.0) + np.random.default_rng(4).normal(0, 0.02, x_u.size)
y_nan[[0, 17, 18, 100, 150]] = np.nan
x_nan = x_u.copy()
x_nan[[60, 61]] = np.nan
_cp("non_finite_samples", x_nan, y_nan)
x_far = 15.9 + np.arange(120) * 0.002                    # short segments far from x = 0
_cp("far_from_origin", x_far, 40.0 * x_far + np.where(np.arange(120) >= 70, 12.0, 0.0)
    + np.random.default_rng(5).normal(0, 0.2, 120))

# ── 2. math.hypot ─────────────────────────────────────────────────────────
HYPOT = []
for a in range(1, 400):
    for b in range(a, 400):
        c = math.isqrt(a * a + b * b)
        if c * c == a * a + b * b:
            HYPOT.append({"a": float(a), "b": float(b), "hypot": math.hypot(a, b)})
for a, b in rng.uniform(-300, 300, (200, 2)):
    HYPOT.append({"a": float(a), "b": float(b), "hypot": math.hypot(a, b)})
for a, b in rng.uniform(0, 1, (100, 2)) * np.array([[1e-3, 3.0]]):
    HYPOT.append({"a": float(a), "b": float(b), "hypot": math.hypot(a, b)})
for a, b in [(0.0, 0.0), (0.0, 3.5), (-2.0, 0.0), (1e-15, 1e-15), (0.7, 0.2), (1e-7, 1e-7), (3e-7, 2e-7),
             (1e300, 1e300), (5e-324, 5e-324), (2.2250738585072014e-308, 1e-310), (1e-200, 3e-200),
             (153.0 * 0.1, 104.0 * 0.1), (153 * 0.1, -104 * 0.1), (1.0, 1e-17), (1e308, 1.0), (1.5e308, -3e307),
             (1.0, 1e-170), (3e-310, 4e-310)]:
    HYPOT.append({"a": a, "b": b, "hypot": math.hypot(a, b)})

# ── 3. synthetic frames ──────────────────────────────────────────────────
FRAMES: dict[str, dict] = {}


def _frame(name: str, archive: str, turn: int, arrays: dict[str, np.ndarray], geometry: dict, meta: dict) -> None:
    FRAMES[name] = {"archive": archive, "turn": turn, "geometry": geometry, "meta": meta,
                    "shape": list(next(iter(arrays.values())).shape),
                    "arrays": {k: _f32_b64(v) for k, v in arrays.items()}}


# A: the reference test's step (tests/test_measure.py::test_line_profile_finds_a_step).
yyA, xxA = np.mgrid[0:100, 0:200]
zA = np.where(xxA >= 120, 100e-12, 0.0) + np.random.default_rng(0).normal(0, 2e-12, (100, 200))
gA = {"cx_nm": 0.0, "cy_nm": 0.0, "w_nm": 20.0, "h_nm": 10.0, "angle_deg": 0.0}

# B: rotated, tilted terraces with both passes and a current channel; rows 70.. not acquired.
yyB, xxB = np.mgrid[0:80, 0:96]
zB = (3e-9 + 1.5e-12 * xxB - 0.8e-12 * yyB + 98e-12 * (xxB >= 30 + 0.2 * yyB) + 98e-12 * (xxB >= 62 - 0.1 * yyB)
      + rng.normal(0, 3e-12, (80, 96)))
zBb = zB + 2e-12 + rng.normal(0, 1.5e-12, (80, 96))
iB = 1e-10 + 5e-12 * np.sin(xxB / 4.0) * np.cos(yyB / 5.0) + rng.normal(0, 0.3e-12, (80, 96))
for arr in (zB, zBb, iB):
    arr[70:] = np.nan
gB = {"cx_nm": 12.5, "cy_nm": -3.25, "w_nm": 19.2, "h_nm": 16.0, "angle_deg": 30.0}
metaB = {"bias_v": 0.2, "setpoint_a": 5e-11, "scan_dir": "down"}

# E: a diagonal step on a rotated frame, rows 110.. not acquired. Native (5, 4) -> (158, 108)
# is a 153 x 104 line: hypot = 185 exactly in CPython, 185.00000000000003 with V8's Math.hypot.
yyE, xxE = np.mgrid[0:120, 0:180]
zE = (-1e-9 + 0.6e-12 * xxE + 80e-12 * (xxE + 0.5 * yyE >= 110) + rng.normal(0, 2e-12, (120, 180)))
zE[110:] = np.nan
gE = {"cx_nm": -40.0, "cy_nm": 15.5, "w_nm": 18.0, "h_nm": 12.0, "angle_deg": -12.5}

# G: a long thin frame; a line across it has more than MAX_PROFILE_SAMPLES pixels.
yyG, xxG = np.mgrid[0:8, 0:420]
zG = 30e-12 * np.sin(xxG / 25.0) + 60e-12 * (xxG >= 300) + rng.normal(0, 1e-12, (8, 420))
gG = {"cx_nm": 5.0, "cy_nm": 0.0, "w_nm": 42.0, "h_nm": 0.8, "angle_deg": 0.0}

# D / D2: the reference stats test (tests/test_measure.py::test_stats_values).
gD = {"cx_nm": 0.0, "cy_nm": 0.0, "w_nm": 6.4, "h_nm": 6.4, "angle_deg": 0.0}
rD = np.random.default_rng(0)
zD = rD.normal(0, 5e-12, (64, 64)) + 1e-9
zD[48:] = np.nan
zD2 = zD.copy()
zD2[:48] += rD.normal(0, 20e-12, (48, 1))

# M: a derived map with values (as the frame-difference tool archives one).
yyM, xxM = np.mgrid[0:32, 0:32]
dM = 25e-12 * np.exp(-((xxM - 20.5) ** 2 + (yyM - 9.5) ** 2) / 6.0) + rng.normal(0, 1e-12, (32, 32))
gM = {"cx_nm": 12.5, "cy_nm": -3.25, "w_nm": 8.0, "h_nm": 8.0, "angle_deg": 30.0}
pngM = F.encode_png(np.zeros((768, 768), dtype=np.uint8))

# F: wider than the small archive's display (block mean by 3); rows 20.. not acquired.
yyF, xxF = np.mgrid[0:24, 0:130]
zF = 2e-10 + 50e-12 * (xxF >= 70) - 30e-12 * (xxF >= 100) + 0.5e-12 * yyF + rng.normal(0, 1.5e-12, (24, 130))
zF[20:] = np.nan
gF = {"cx_nm": -40.0, "cy_nm": 15.5, "w_nm": 65.0, "h_nm": 12.0, "angle_deg": -12.5}

_frame("A", "main", 0, {"Z": zA}, gA, {})
_frame("B", "main", 1, {"Z/forward": zB, "Z/backward": zBb, "Current/forward": iB}, gB, metaB)
_frame("E", "main", 2, {"Z": zE}, gE, {})
_frame("G", "main", 3, {"Z": zG}, gG, {})
_frame("D", "main", 3, {"Z": zD, "Z/backward": zD.copy()}, gD, {})
_frame("D2", "main", 4, {"Z": zD2}, gD, {})
_frame("F", "small", 0, {"Z": zF}, gF, {})
DERIVED_MAP = {"name": "M", "archive": "main", "turn": 4, "tool": "stm_frame_diff", "sources": ["t0001.p0"],
               "geometry": gM, "units": {"diff": "m"}, "shape": [32, 32], "array": _f32_b64(dM),
               "png_b64": base64.b64encode(pngM).decode("ascii")}

# ── 4. the tools, end to end ─────────────────────────────────────────────
work = Path(tempfile.mkdtemp(prefix="measure-profile-golden-"))
try:
    archives = {"main": Archive(work / "main", display_max=768), "small": Archive(work / "small", display_max=64)}
    fid: dict[str, str] = {}
    for name, fr in FRAMES.items():
        arrays = {k: np.frombuffer(base64.b64decode(v), dtype="<f4").reshape(fr["shape"]) for k, v in fr["arrays"].items()}
        fid[name] = archives[fr["archive"]].add_partial(fr["turn"], arrays, geometry=fr["geometry"], meta=fr["meta"]).fid
        if name == "D2":
            dm = DERIVED_MAP
            e = archives["main"].add_derived(dm["turn"], pngM, meta={"tool": dm["tool"], "sources": dm["sources"],
                                                                    "geometry": dm["geometry"], "units": dm["units"]},
                                             arrays={"diff/forward": dM})
            fid["M"] = e.fid
    assert fid["B"] == DERIVED_MAP["sources"][0], fid

    def nm(frame: str, col: float, row: float) -> dict:
        e = archives[FRAMES[frame]["archive"] if frame in FRAMES else "main"].get(fid[frame])
        X, Y = F.native_to_scan_nm(e.geometry, col, row)
        return {"x_nm": float(X), "y_nm": float(Y)}

    CALLS = []

    def call(archive: str, tool: str, name: str, args: Any) -> None:
        fn = {"line_profile": M.line_profile, "stats": M.stats}[tool]
        before = len(_CAPTURED)
        reply = fn(archives[archive], args)
        parsed = json.loads(reply.text)
        entry = {"name": name, "archive": archive, "tool": tool, "args": args, "is_error": reply.is_error,
                 "reply": parsed, "key_paths": _key_paths(parsed), "labels": [im.label for im in reply.images],
                 "image_sizes": [list(F.png_size(im.png)) for im in reply.images]}
        if len(_CAPTURED) > before:
            cp = _CAPTURED[-1]
            entry["change_points"] = {"x": cp["x"], "y": cp["y"], "kwargs": cp["kwargs"], "steps": cp["steps"],
                                      "sigma": cp["sigma"], "segments": cp["segments"]}
        CALLS.append(entry)

    A, B, E, G, D, D2, MM, FF = (fid[k] for k in ("A", "B", "E", "G", "D", "D2", "M", "F"))
    # line_profile: the reference test's step, in display px and in scan nm (same samples)
    call("main", "line_profile", "step_display_px", {"frame": A, "p1": {"x": 60, "y": 150}, "p2": {"x": 540, "y": 150},
                                                     "width_px": 9, "flatten": "none"})
    call("main", "line_profile", "step_scan_nm", {"frame": A, "p1": nm("A", 20.0, 50.0), "p2": nm("A", 180.0, 50.0),
                                                  "width_px": 9, "flatten": "none"})
    call("main", "line_profile", "step_diagonal_plane", {"frame": A, "p1": {"x": 10, "y": 10}, "p2": {"x": 590, "y": 290}})
    call("main", "line_profile", "rotated_terraces_line_5_lines", {"frame": B, "p1": nm("B", 4.5, 20.25),
                                                                   "p2": nm("B", 90.0, 40.5), "flatten": "line",
                                                                   "width_px": 40})
    call("main", "line_profile", "current_highpass_into_missing_rows", {"frame": B, "channel": "Current",
                                                                        "p1": {"x": 400, "y": 40}, "p2": {"x": 400, "y": 630},
                                                                        "flatten": "highpass", "highpass_nm": 1.5})
    call("main", "line_profile", "backward_poly2_two_lines", {"frame": B, "direction": "backward", "flatten": "poly2",
                                                              "p1": {"x": 20, "y": 500}, "p2": {"x": 700, "y": 60},
                                                              "width_px": 20})
    call("main", "line_profile", "pythagorean_line", {"frame": E, "p1": {"x": 20, "y": 16}, "p2": {"x": 632, "y": 432}})
    call("main", "line_profile", "last_acquired_row_one_line", {"frame": E, "p1": {"x": 0, "y": 438},
                                                                "p2": {"x": 720, "y": 438}})
    call("main", "line_profile", "last_acquired_row_three_lines", {"frame": E, "p1": {"x": 0, "y": 438},
                                                                   "p2": {"x": 720, "y": 438}, "width_px": 12})
    call("main", "line_profile", "capped_at_400_samples", {"frame": G, "p1": {"x": 0, "y": 4}, "p2": {"x": 420, "y": 4},
                                                           "flatten": "none"})
    call("main", "line_profile", "corner_to_corner_edges", {"frame": A, "p1": {"x": -2e-6, "y": 0}, "p2": {"x": 600, "y": 300}})
    call("main", "line_profile", "derived_map_with_values", {"frame": MM, "p1": {"x": 0, "y": 0}, "p2": {"x": 768, "y": 700},
                                                             "width_px": 30})
    call("main", "line_profile", "row_offsets_vertical", {"frame": D2, "p1": {"x": 300, "y": 0}, "p2": {"x": 300, "y": 768}})
    call("small", "line_profile", "downsampled_display", {"frame": FF, "p1": {"x": 1, "y": 4}, "p2": {"x": 43, "y": 4}})
    call("small", "line_profile", "downsampled_six_lines", {"frame": FF, "p1": {"x": 0.5, "y": 1.5},
                                                            "p2": {"x": 43.3, "y": 6.5}, "width_px": 2, "flatten": "none"})
    # the display image is ceil(130/3) = 44 px wide, but x = 44 is native column 132 > 130
    call("small", "line_profile", "downsampled_past_last_column", {"frame": FF, "p1": {"x": 1, "y": 4}, "p2": {"x": 44, "y": 4}})
    # line_profile: refusals (none of them archives a plot)
    plot = CALLS[0]["reply"]["plot"]["frame"]
    for name, args in [
        ("outside", {"frame": A, "p1": {"x": 0, "y": 0}, "p2": {"x": 999, "y": 0}}),
        ("outside_nm", {"frame": A, "p1": {"x_nm": 0, "y_nm": 0}, "p2": {"x_nm": 0, "y_nm": 5.2}}),
        ("both_kinds", {"frame": A, "p1": {"x": 0, "x_nm": 0}, "p2": {"x": 5, "y": 5}}),
        ("neither_kind", {"frame": A, "p1": {}, "p2": {"x": 5, "y": 5}}),
        ("only_x", {"frame": A, "p1": {"x": 3}, "p2": {"x": 5, "y": 5}}),
        ("only_y_nm", {"frame": A, "p1": {"x": 3, "y": 3}, "p2": {"y_nm": 1.0}}),
        ("point_not_object", {"frame": A, "p1": [3, 3], "p2": {"x": 5, "y": 5}}),
        ("point_unknown_key", {"frame": A, "p1": {"x": 3, "y": 3, "z": 1}, "p2": {"x": 5, "y": 5}}),
        ("point_string", {"frame": A, "p1": {"x": "3", "y": 3}, "p2": {"x": 5, "y": 5}}),
        ("point_bool", {"frame": A, "p1": {"x": True, "y": 3}, "p2": {"x": 5, "y": 5}}),
        ("too_short", {"frame": A, "p1": {"x": 3, "y": 3}, "p2": {"x": 4, "y": 3}}),
        ("width_below_1", {"frame": A, "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}, "width_px": 0.5}),
        ("width_above_display", {"frame": A, "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}, "width_px": 769}),
        ("highpass_nm_without_highpass", {"frame": A, "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}, "highpass_nm": 2}),
        ("bad_flatten", {"frame": A, "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}, "flatten": "tilt"}),
        ("missing_p2", {"frame": A, "p1": {"x": 3, "y": 3}}),
        ("unknown_argument", {"frame": A, "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}, "bogus": 1}),
        ("derived_without_values", {"frame": plot, "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}}),
        ("unknown_frame", {"frame": "t0042.s0", "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}}),
        ("frame_not_string", {"frame": 7, "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}}),
        ("unknown_channel", {"frame": A, "channel": "Phase", "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}}),
        ("missing_direction", {"frame": A, "direction": "backward", "p1": {"x": 3, "y": 3}, "p2": {"x": 300, "y": 3}}),
        ("arguments_none", None),
        ("arguments_list", [1, 2]),
    ]:
        call("main", "line_profile", name, args)
    # stats
    call("main", "stats", "reference_values", {"frame": D})
    call("main", "stats", "reference_region", {"frame": D, "region": {"x": 0, "y": 0, "width": 120, "height": 120}})
    call("main", "stats", "row_offsets", {"frame": D2})
    call("main", "stats", "current_forward_only", {"frame": B, "channel": "Current"})
    call("main", "stats", "backward_against_forward", {"frame": B, "direction": "backward"})
    call("main", "stats", "region_into_missing_rows", {"frame": B, "region": {"x": 300, "y": 500, "width": 200, "height": 140}})
    call("main", "stats", "derived_map_with_values", {"frame": MM})
    call("main", "stats", "region_forward_only", {"frame": A, "region": {"x": 333, "y": 31, "width": 101, "height": 77}})
    call("small", "stats", "downsampled_region", {"frame": FF, "region": {"x": 5, "y": 2, "width": 20, "height": 5}})
    for name, args in [
        ("region_not_acquired", {"frame": D, "region": {"x": 0, "y": 600, "width": 100, "height": 100}}),
        ("three_acquired_pixels", {"frame": D, "region": {"x": 0, "y": 564, "width": 36, "height": 12}}),
        ("derived_without_values", {"frame": plot}),
        ("unknown_argument", {"frame": D, "bogus": 1}),
        ("unknown_frame", {"frame": "t0042.s0"}),
        ("region_leaves_frame", {"frame": D, "region": {"x": 700, "y": 0, "width": 100, "height": 10}}),
        ("region_not_integer", {"frame": D, "region": {"x": 0.5, "y": 0, "width": 100, "height": 10}}),
        ("missing_direction", {"frame": B, "channel": "Current", "direction": "backward"}),
        ("flatten_not_an_argument", {"frame": D, "flatten": "plane"}),
        ("arguments_none", None),
    ]:
        call("main", "stats", name, args)
    INDEX = {name: arc.index() for name, arc in archives.items()}
finally:
    shutil.rmtree(work, ignore_errors=True)

M.change_points = _REAL_CHANGE_POINTS

files = {name: ROOT / "vista_spm" / f"{name}.py" for name in ("measure", "frames", "archive", "viewtools", "protocol")}
golden = {
    "reference": {
        **{f"{name}_py_sha256": _sha(path) for name, path in files.items()},
        "vista_spm_head": _head(ROOT),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "matplotlib": matplotlib.__version__,
        "seed": SEED,
    },
    "constants": {"max_profile_samples": M.MAX_PROFILE_SAMPLES, "display_max": {"main": 768, "small": 64}},
    "descriptions": {"line_profile": M.make_line_profile_tool(768).description,
                     "stats": M.make_stats_tool(768).description},
    "change_points": CHANGE_POINTS,
    "hypot": HYPOT,
    "frames": FRAMES,
    "derived_map": DERIVED_MAP,
    "frame_ids": fid,
    "frame_order": list(fid),
    "calls": CALLS,
    "index": INDEX,
}
OUT.write_text(json.dumps(_plain(golden), ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n",
               encoding="utf-8", newline="\n")
print(f"wrote {OUT.relative_to(REPO)}")
