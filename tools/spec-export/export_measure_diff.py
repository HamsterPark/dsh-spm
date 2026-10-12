r"""Reference results of VISTA-SPM's ``diff`` measurement tool for dsh-spm-visual-memory.

VISUAL-HARNESS §5 asks every TypeScript measurement tool to match the Python reference
implementation of the same design. ``stm_frame_diff`` ports ``vista_spm/measure.py``'s
``diff``: both frames flattened the same way (default highpass), frames of different
geometry resampled onto their overlap in scan-frame nm at the coarser pixel size,
sub-pixel registration by normalized cross-correlation (``register``: an FFT correlation
surface, a parabolic peak, the correlation-length exclusion behind the confidence, and a
Nelder-Mead refinement over a cubic-spline shift), the aligned difference archived as a
derived frame with its values, the changed regions and the diverging color map.

This exporter runs the reference on synthetic seeded frames in a temporary archive and
stores inputs and results together in ``spec/golden/measure_diff.json``:

* ``frames`` / ``calls``: the archived inputs (float32, as the archive keeps them) and,
  per ``diff`` call, the arguments, the parsed reply with the key order the model reads,
  the derived frame (summary, label, archived values) and what the reference computed on
  the way: the ``register`` inputs and result, every Nelder-Mead evaluation, the
  resampled grid, the unmarked diverging image and the numbered marks. Cases: sub-pixel
  shifts (plain and rotated frames), steps with piezo-creep bows and a large shift,
  plane flattening, a resampled pair of different size and rotation, a coarser second
  frame, a bare periodic lattice (ambiguous, confidence near 1), a moved feature (changed
  regions of both signs), rows not acquired, a region, the Current channel and the
  backward pass, identical frames, ``align=false``, more regions than are listed, a shift
  beyond the search limit, a downsampled difference image, and every error message.
* ``kernels``: the scipy pieces the port reimplements, on random inputs, for exact
  comparison: ``spline_filter`` (order 3, mirror), ``shift`` (order 1 and 3,
  ``prefilter=False``, constant), ``map_coordinates`` (order 1, constant), Nelder-Mead with
  the reference's options on analytic functions (every evaluation recorded), numpy's
  ``argsort`` on ties, and the reference's ``_clip_polygon``, ``_same_geometry`` and
  ``_diverging_rgb``.

The capture wrappers replace module attributes in this process only (``M.register``,
``M._common_grid``, ``M._diverging_rgb``, ``M._draw_marks``, ``scipy.optimize.minimize``);
nothing is written to the reference tree. The reference is imported read-only from
``VISTA_SPM_ROOT`` (no bytecode is written there) and needs NumPy, SciPy, Pillow and
matplotlib's font lookup, not MAST or STM-Bench. Inputs are synthetic (seeded); no
instrument data. Arrays are base64 of little-endian float32 / float64 / uint8. The JSON
records the sha256 of the reference files it ran, because the reference is still under
development.

    VISTA_SPM_ROOT=<VISTA-SPM source root> PYTHONUTF8=1 python tools/spec-export/export_measure_diff.py
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

import numpy as np  # noqa: E402
import scipy  # noqa: E402
import scipy.optimize  # noqa: E402
from scipy.ndimage import gaussian_filter, map_coordinates, shift as nd_shift, spline_filter  # noqa: E402

from _paths import require_vista_spm_root  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "measure_diff.json"
SEED = 20261012

ROOT = require_vista_spm_root()
sys.path.insert(0, str(ROOT))
from vista_spm import frames as F  # noqa: E402
from vista_spm import measure as M  # noqa: E402
from vista_spm.archive import Archive  # noqa: E402


# ── encoding ───────────────────────────────────────────────────────────────
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


def _b64(a: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode("ascii")


def f32(a: np.ndarray) -> dict:
    a = np.asarray(a)
    return {"shape": list(a.shape), "f32": _b64(a, "<f4")}


def f64(a: np.ndarray) -> dict:
    a = np.asarray(a)
    return {"shape": list(a.shape), "f64": _b64(a, "<f8")}


def u8(a: np.ndarray) -> dict:
    a = np.asarray(a)
    return {"shape": list(a.shape), "u8": _b64(a, "u1")}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _head(root: Path) -> str:
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                             check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _key_paths(obj: Any, path: str = "$") -> list[str]:
    """Every key of a parsed reply, depth first in insertion order (``$.registration.shift_nm``)."""
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(f"{path}.{k}")
            out += _key_paths(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += _key_paths(v, f"{path}[{i}]")
    return out


rng = np.random.default_rng(SEED)

# ── 1. kernels: the scipy pieces the port reimplements ───────────────────
KERNELS: dict[str, Any] = {"spline_filter": [], "shift": [], "map_coordinates": [], "nelder_mead": [], "argsort": []}
SHIFTS = [(0.3, -0.7), (-2.4, 3.7), (0.137, -0.262), (0.0, 0.0), (1.0, -1.0), (-0.5, 0.5), (1e-13, -3e-14), (-0.999, 2.5)]
for shape in [(19, 21), (16, 16), (40, 33), (2, 3), (1, 5), (7, 1)]:
    a = rng.normal(size=shape)
    c = spline_filter(a, order=3)
    KERNELS["spline_filter"].append({"input": f64(a), "output": f64(c)})
    if shape in ((19, 21), (16, 16)):
        shifts = SHIFTS + [(shape[0] - 0.8, 0.1)]
        KERNELS["shift"].append({"order": 3, "input": f64(c), "shifts": [list(d) for d in shifts], "outputs": [
            f64(nd_shift(c, d, order=3, mode="constant", cval=0.0, prefilter=False)) for d in shifts]})
        KERNELS["shift"].append({"order": 1, "input": f64(a), "shifts": [list(d) for d in shifts], "outputs": [
            f64(nd_shift(a, d, order=1, mode="constant", cval=0.0)) for d in shifts]})
a = rng.normal(size=(17, 23))
rows = np.concatenate([rng.uniform(-1.5, 18.5, 400), [0.0, 16.0, 15.9999999999, -0.0, 8.5, 2.5, -1e-300, 16.0000000001]])
cols = np.concatenate([rng.uniform(-1.5, 24.5, 400), [0.0, 22.0, 21.5, 22.0, 3.5, 7.5, 0.0, 1.0]])
KERNELS["map_coordinates"].append({"input": f64(a), "rows": rows.tolist(), "cols": cols.tolist(),
                                   "output": f64(map_coordinates(a, [rows, cols], order=1, mode="constant", cval=0.0))})


def _nm_case(name: str, fun, x0: tuple[float, float], options: dict) -> dict:
    evals: list[list[float]] = []

    def f(d: np.ndarray) -> float:
        v = float(fun(float(d[0]), float(d[1])))
        evals.append([float(d[0]), float(d[1]), v])
        return v

    sol = scipy.optimize.minimize(f, np.array(x0), method="Nelder-Mead", options=options)
    return {"function": name, "x0": list(x0), "options": _plain(options), "x": _plain(sol.x), "fun": float(sol.fun),
            "nit": int(sol.nit), "nfev": int(sol.nfev), "evals": evals}


def _ref_options(x0: tuple[float, float], maxiter: int = 120) -> dict:
    dy0, dx0 = x0
    return {"xatol": 2e-3, "fatol": 1e-9, "maxiter": maxiter,
            "initial_simplex": np.array([[dy0, dx0], [dy0 + 0.3, dx0], [dy0, dx0 + 0.3]])}


NM_FUNCTIONS = {
    "bowl": lambda x, y: (x - 0.3) * (x - 0.3) + 2.0 * (y + 0.7) * (y + 0.7) + 0.5 * x * y,
    "rosenbrock": lambda x, y: (1.0 - x) * (1.0 - x) + 100.0 * (y - x * x) * (y - x * x),
    "constant": lambda x, y: 1.0,
    "plateau": lambda x, y: 1.0 if x * x + y * y > 0.25 else -0.5 + x * x,
}
for name, x0, maxiter in [("bowl", (0.137, -0.262), 120), ("bowl", (-3.0, 4.0), 120), ("rosenbrock", (-1.2, 1.0), 120),
                          ("rosenbrock", (-1.2, 1.0), 30), ("constant", (0.25, -0.5), 120), ("plateau", (0.3, 0.2), 120)]:
    KERNELS["nelder_mead"].append(_nm_case(name, NM_FUNCTIONS[name], x0, _ref_options(x0, maxiter)))
for v in ([1.0, 1.0, 0.5], [0.5, 1.0, 1.0], [1.0, 0.5, 1.0], [2.0, 2.0, 2.0], [3.0, 1.0, 2.0]):
    KERNELS["argsort"].append({"values": v, "order": np.argsort(np.array(v)).tolist()})

CLIP = []
for quad, box in [
    ([(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)], (-0.5, -0.5, 0.5, 0.5)),
    ([(0.0, -2.0), (2.0, 0.0), (0.0, 2.0), (-2.0, 0.0)], (-1.0, -1.0, 1.0, 1.0)),
    ([(0.3, 0.1), (4.1, 0.9), (3.3, 4.7), (-0.5, 3.9)], (0.0, 0.0, 3.0, 2.0)),
    ([(5.0, 5.0), (6.0, 5.0), (6.0, 6.0), (5.0, 6.0)], (-1.0, -1.0, 1.0, 1.0)),
    ([(-4.8, -4.8), (4.8, -4.8), (4.8, 4.8), (-4.8, 4.8)], (-4.8, -4.8, 4.8, 4.8)),
    ([(0.1, 0.1), (0.2, 0.1), (0.2, 0.2), (0.1, 0.2)], (-1.0, -1.0, 1.0, 1.0)),
]:
    CLIP.append({"subject": [list(p) for p in quad], "box": list(box),
                 "clipped": [list(p) for p in M._clip_polygon(quad, box)]})
KERNELS["clip_polygon"] = CLIP


def _geom(nx=96, ny=96, w=9.6, h=9.6, cx=0.0, cy=0.0, angle=0.0) -> dict:
    return {"cx_nm": cx, "cy_nm": cy, "w_nm": w, "h_nm": h, "angle_deg": angle, "nx": nx, "ny": ny}


SAME = []
base = _geom()
for other in [dict(base), {**base, "cx_nm": 1e-12}, {**base, "cx_nm": 1e-8}, {**base, "w_nm": 9.6 * (1 + 5e-10)},
              {**base, "w_nm": 9.6 * (1 + 2e-9)}, {**base, "angle_deg": 1e-10}, {**base, "nx": 95}, {**base, "angle_deg": None},
              {**base, "cy_nm": 0.0, "angle_deg": 0.0, "ny": 96}]:
    SAME.append({"a": base, "b": other, "same": M._same_geometry(base, other)})
KERNELS["same_geometry"] = SAME

d = np.array([[0.0, 0.5, -0.5, 1.0, -1.0, 2.0, -2.0, np.nan],
              [0.25, -0.25, 0.123456, -0.987654, 1e-30, -1e-30, 0.99999, -0.5000001]])
for L in (1.0, 0.8, 3e-11):
    KERNELS.setdefault("diverging", []).append({"d": f64(d * (1.0 if L != 3e-11 else 3e-11)), "L": L,
                                                 "rgb": u8(M._diverging_rgb(d * (1.0 if L != 3e-11 else 3e-11), L))})

# ── 2. synthetic frames ──────────────────────────────────────────────────
def _scan_xy(geom: dict) -> tuple[np.ndarray, np.ndarray]:
    """Scan-frame nm of every pixel center of an oriented frame."""
    rr, cc = np.mgrid[0:geom["ny"], 0:geom["nx"]]
    return F.native_to_scan_nm(geom, cc + 0.5, rr + 0.5)


def _texture(n: int, sigma: float = 3.0) -> np.ndarray:
    return gaussian_filter(rng.normal(size=(n, n)), sigma)


def _sample(tex: np.ndarray, X: np.ndarray, Y: np.ndarray, s: float, amp: float = 6e-11) -> np.ndarray:
    """A surface defined in scan nm (texture pixel = s nm, centered), sampled at (X, Y)."""
    n = tex.shape[0]
    col = X / s + n / 2 - 0.5
    row = n / 2 - Y / s - 0.5
    return map_coordinates(tex, [row, col], order=3, mode="nearest") * amp


def _gauss(X: np.ndarray, Y: np.ndarray, x0: float, y0: float, sig_nm: float, amp: float) -> np.ndarray:
    return amp * np.exp(-((X - x0) ** 2 + (Y - y0) ** 2) / (2.0 * sig_nm ** 2))


FRAMES: list[dict] = []
ARCHIVES = {"main": 768, "small": 64}


def add(arch_name: str, turn: int, arrays: dict[str, np.ndarray], geom: dict, meta: dict | None = None) -> dict:
    rec = {"archive": arch_name, "turn": turn, "geometry": {k: v for k, v in geom.items() if k not in ("nx", "ny")},
           "meta": meta or {}, "arrays": {k: np.asarray(v, dtype=np.float32) for k, v in arrays.items()}}
    FRAMES.append(rec)
    return rec


g0 = _geom()
X0, Y0 = _scan_xy(g0)
tex1 = _texture(160)
a1 = _sample(tex1, X0, Y0, 0.1)
b1 = _sample(tex1, X0 - 0.137, Y0 + 0.262, 0.1) + _gauss(X0, Y0, *F.native_to_scan_nm(g0, 70.5, 25.5), 0.2, 30e-12)
add("main", 0, {"Z": a1}, g0, {"bias_v": 0.1, "setpoint_a": 1e-10, "scan_dir": "down"})          # t0000.p0
add("main", 1, {"Z": b1}, g0, {"bias_v": 0.1, "setpoint_a": 1e-10, "scan_dir": "down"})          # t0001.p0

g25 = _geom(cx=12.5, cy=-3.25, angle=25.0)
X25, Y25 = _scan_xy(g25)
tex2 = _texture(260)
a2 = _sample(tex2, X25, Y25, 0.1)
b2 = _sample(tex2, X25 - 0.21, Y25 - 0.055, 0.1)
add("main", 2, {"Z": a2}, g25)                                                                   # t0002.p0
add("main", 3, {"Z": b2}, g25)                                                                   # t0003.p0

atoms = rng.uniform(-8.0, 8.0, (18, 2))


def terrace(Xs: np.ndarray, Ys: np.ndarray) -> np.ndarray:
    z = 60e-12 * (0.5 + 0.5 * np.tanh((Xs + 0.3 * Ys - 1.5) / 0.3))                 # a tip-broadened step
    for ax, ay in atoms:
        z = z + 60e-12 * np.exp(-((Xs - ax) ** 2 + (Ys - ay) ** 2) / (2 * 0.3 ** 2))
    return z


u = (np.arange(96) + 0.5) / 96 - 0.5
bow_a = 400e-12 * np.add.outer(u ** 2, 0.5 * u ** 2)       # piezo creep lives in frame coordinates
bow_b = 250e-12 * np.add.outer(0.3 * u ** 2, u ** 2) + 40e-12 * np.add.outer(u, u)
za = terrace(X0, Y0) + bow_a + rng.normal(0, 2e-12, X0.shape)
zb = terrace(X0 - 2.9, Y0 + 0.3) + bow_b + rng.normal(0, 2e-12, X0.shape)
add("main", 4, {"Z": za}, g0)                                                                    # t0004.p0
add("main", 5, {"Z": zb}, g0)                                                                    # t0005.p0

gEa = _geom()
gEb = _geom(nx=80, ny=80, w=8.0, h=8.0, cx=0.8, cy=-0.5, angle=10.0)
tex3 = _texture(200)
add("main", 6, {"Z": _sample(tex3, *_scan_xy(gEa), 0.1)}, gEa)                                 # t0006.p0
add("main", 7, {"Z": _sample(tex3, *(lambda X, Y: (X - 0.05, Y + 0.12))(*_scan_xy(gEb)), 0.1)}, gEb)  # t0007.p0

gL = _geom(nx=64, ny=64, w=3.2, h=3.2, cx=-1.0, cy=2.0)
XL, YL = _scan_xy(gL)


def lattice(Xs: np.ndarray, Ys: np.ndarray, a_nm: float = 0.5) -> np.ndarray:
    k = 2 * math.pi / a_nm
    z = np.cos(k * Xs) + np.cos(k * (0.5 * Xs + math.sqrt(3) / 2 * Ys)) + np.cos(k * (-0.5 * Xs + math.sqrt(3) / 2 * Ys))
    return 7e-12 * z


add("main", 8, {"Z": lattice(XL, YL) + rng.normal(0, 1e-12, XL.shape)}, gL)                    # t0008.p0
add("main", 9, {"Z": lattice(XL - 0.11, YL - 0.06) + rng.normal(0, 1e-12, XL.shape)}, gL)      # t0009.p0

tex4 = _texture(160)
adatoms = [(-3.0, 2.5), (2.2, 3.1), (-1.5, -2.8), (3.4, -1.2), (0.4, 0.6), (-3.6, -0.4)]
base_i = _sample(tex4, X0, Y0, 0.1)
fa_i = base_i + sum(_gauss(X0, Y0, x, y, 0.25, 30e-12) for x, y in adatoms) + rng.normal(0, 0.3e-12, X0.shape)
moved = [(x + (1.0 if i == 4 else 0.0), y) for i, (x, y) in enumerate(adatoms)]
fb_i = base_i + sum(_gauss(X0, Y0, x, y, 0.25, 30e-12) for x, y in moved) + rng.normal(0, 0.3e-12, X0.shape)
add("main", 10, {"Z": fa_i}, g0)                                                                 # t0010.p0
add("main", 11, {"Z": fb_i}, g0)                                                                 # t0011.p0

partial = _sample(tex1, X0 - 0.31, Y0 - 0.17, 0.1)
partial[60:] = np.nan
add("main", 12, {"Z": a1}, g0)                                                                   # t0012.p0
add("main", 13, {"Z": partial}, g0, {"scan_dir": "down"})                                       # t0013.p0

cur_a = 1e-10 + 0.2 * _sample(tex1, X0, Y0, 0.1, amp=5e-11)
cur_b = 1e-10 + 0.2 * _sample(tex1, X0 - 0.4, Y0 - 0.1, 0.1, amp=5e-11)
add("main", 14, {"Z/forward": a1, "Z/backward": a1 + 1e-12, "Current/forward": cur_a, "Current/backward": cur_a * 1.01},
    g0)                                                                                          # t0014.p0
add("main", 15, {"Z/forward": b1, "Z/backward": b1 + 1e-12, "Current/forward": cur_b, "Current/backward": cur_b * 1.01},
    g0)                                                                                          # t0015.p0
add("main", 16, {"Z": a1}, g0)                                                                   # t0016.p0
add("main", 17, {"Z": a1}, _geom(cx=500.0))                                                      # t0017.p0
yy, xx = np.mgrid[0:96, 0:96]
bumps = np.zeros((96, 96))
spots = [(8 + 11 * i, 8 + 11 * j) for i in range(8) for j in range(5)]
for k_, (r_, c_) in enumerate(spots):
    bumps += (18e-12 + 0.5e-12 * k_) * np.exp(-((xx - c_ - 0.3) ** 2 + (yy - r_ - 0.2) ** 2) / 2.0)
add("main", 18, {"Z": a1 + bumps}, g0)                                                           # t0018.p0
gO = _geom(nx=48, ny=48)
add("main", 19, {"Z": _sample(tex1, *(lambda X, Y: (X - 0.25, Y - 0.1))(*_scan_xy(gO)), 0.1)}, gO)  # t0019.p0
tex5 = _texture(260, 8.0)
add("main", 20, {"Z": _sample(tex5, X0, Y0, 0.1)}, g0)                                           # t0020.p0
add("main", 21, {"Z": a1}, _geom(cx=8.6))                                                        # t0021.p0
g32 = _geom(nx=32, ny=32, w=3.2, h=3.2)
X32, Y32 = _scan_xy(g32)
row_only = _sample(tex1, X32, Y32, 0.1)
row_only[1:] = np.nan
add("main", 22, {"Z": _sample(tex1, X32, Y32, 0.1)}, g32)                                        # t0022.p0
add("main", 23, {"Z": row_only}, g32)                                                            # t0023.p0
add("main", 24, {"Z": _sample(tex5, X0 - 4.1, Y0 - 0.2, 0.1)}, g0)                               # t0024.p0
g_bump = _geom(nx=32, ny=32, w=16.0, h=16.0)                     # coarse pixels: little smoothing
X_bump, Y_bump = _scan_xy(g_bump)
add("main", 25, {"Z": _gauss(X_bump, Y_bump, 0.7, -0.3, 0.6, 40e-12)}, g_bump)                   # t0025.p0
add("main", 26, {"Z": _gauss(X_bump, Y_bump, 1.4, -0.1, 0.6, 40e-12)}, g_bump)                   # t0026.p0
add("small", 0, {"Z": a1}, g0)                                                                   # small t0000.p0
add("small", 1, {"Z": b1}, g0)                                                                   # small t0001.p0

PLAIN_TURN = 26                    # the main archive's last turn: diff files its maps there too
PLAIN_PNG = F.encode_png((np.arange(48, dtype=np.uint8).reshape(6, 8) * 5).astype(np.uint8))

# ── 3. the calls, through the reference archive ──────────────────────────
CALLS = [
    ("main", "subpixel_shift", {"frame_a": "t0000.p0", "frame_b": "t0001.p0"}, True),
    ("main", "subpixel_shift_rotated", {"frame_a": "t0002.p0", "frame_b": "t0003.p0"}, False),
    ("main", "steps_creep_large_shift", {"frame_a": "t0004.p0", "frame_b": "t0005.p0"}, True),
    ("main", "steps_creep_plane", {"frame_a": "t0004.p0", "frame_b": "t0005.p0", "flatten": "plane"}, False),
    ("main", "resampled_rotated", {"frame_a": "t0006.p0", "frame_b": "t0007.p0"}, True),
    ("main", "resampled_coarser", {"frame_a": "t0000.p0", "frame_b": "t0019.p0", "flatten": "line"}, False),
    ("main", "lattice_ambiguous", {"frame_a": "t0008.p0", "frame_b": "t0009.p0"}, False),
    ("main", "moved_feature", {"frame_a": "t0010.p0", "frame_b": "t0011.p0", "highpass_nm": 2.0}, False),
    ("main", "rows_not_acquired", {"frame_a": "t0012.p0", "frame_b": "t0013.p0"}, True),
    ("main", "region", {"frame_a": "t0000.p0", "frame_b": "t0001.p0",
                        "region": {"x": 80, "y": 80, "width": 480, "height": 400}}, False),
    ("main", "current_backward", {"frame_a": "t0014.p0", "frame_b": "t0015.p0", "channel": "Current",
                                  "direction": "backward", "flatten": "poly2"}, False),
    ("main", "identical", {"frame_a": "t0000.p0", "frame_b": "t0016.p0"}, False),
    ("main", "identical_unaligned", {"frame_a": "t0000.p0", "frame_b": "t0016.p0", "align": False, "flatten": "none"},
     False),
    ("main", "many_regions", {"frame_a": "t0000.p0", "frame_b": "t0018.p0", "align": False}, False),
    ("main", "beyond_search_limit", {"frame_a": "t0020.p0", "frame_b": "t0024.p0"}, False),
    ("main", "single_feature_no_second_peak", {"frame_a": "t0025.p0", "frame_b": "t0026.p0"}, False),
    ("small", "downsampled_image", {"frame_a": "t0000.p0", "frame_b": "t0001.p0"}, False),
    ("small", "downsampled_region", {"frame_a": "t0000.p0", "frame_b": "t0001.p0",
                                     "region": {"x": 5, "y": 5, "width": 30, "height": 25}}, False),
    # errors
    ("main", "err_missing_frame_b", {"frame_a": "t0000.p0"}, False),
    ("main", "err_unknown_field", {"frame_a": "t0000.p0", "frame_b": "t0001.p0", "bogus": 1}, False),
    ("main", "err_not_a_frame_id", {"frame_a": 7, "frame_b": "t0001.p0"}, False),
    ("main", "err_derived_without_values", {"frame_a": "t0026.m0", "frame_b": "t0001.p0"}, False),
    ("main", "err_derived_with_values", {"frame_a": "t0026.m1", "frame_b": "t0001.p0"}, False),
    ("main", "err_unknown_frame_b", {"frame_a": "t0000.p0", "frame_b": "t0042.s0"}, False),
    ("main", "err_frame_b_channel", {"frame_a": "t0014.p0", "frame_b": "t0001.p0", "channel": "Current"}, False),
    ("main", "err_frame_b_direction", {"frame_a": "t0014.p0", "frame_b": "t0001.p0", "direction": "backward"}, False),
    ("main", "err_channel", {"frame_a": "t0000.p0", "frame_b": "t0001.p0", "channel": "Phase"}, False),
    ("main", "err_align", {"frame_a": "t0000.p0", "frame_b": "t0001.p0", "align": "yes"}, False),
    ("main", "err_flatten", {"frame_a": "t0000.p0", "frame_b": "t0001.p0", "flatten": "tilt"}, False),
    ("main", "err_highpass_without_highpass", {"frame_a": "t0000.p0", "frame_b": "t0001.p0", "flatten": "plane",
                                               "highpass_nm": 2.0}, False),
    ("main", "err_highpass_range", {"frame_a": "t0000.p0", "frame_b": "t0001.p0", "highpass_nm": 0}, False),
    ("main", "err_region_small", {"frame_a": "t0000.p0", "frame_b": "t0001.p0",
                                  "region": {"x": 0, "y": 0, "width": 100, "height": 100}}, False),
    ("main", "err_region_outside", {"frame_a": "t0000.p0", "frame_b": "t0001.p0",
                                    "region": {"x": 700, "y": 0, "width": 100, "height": 100}}, False),
    ("main", "err_region_keys", {"frame_a": "t0000.p0", "frame_b": "t0001.p0", "region": {"x": 0, "y": 0}}, False),
    ("main", "err_no_overlap", {"frame_a": "t0000.p0", "frame_b": "t0017.p0"}, False),
    ("main", "err_no_overlap_in_region", {"frame_a": "t0000.p0", "frame_b": "t0021.p0",
                                          "region": {"x": 0, "y": 0, "width": 300, "height": 768}}, False),
    ("main", "err_small_overlap", {"frame_a": "t0000.p0", "frame_b": "t0021.p0"}, False),
    ("main", "err_too_few_after_alignment", {"frame_a": "t0022.p0", "frame_b": "t0023.p0"}, False),
    ("main", "err_arguments_not_object", ["t0000.p0"], False),
]

CAPTURE: dict[str, Any] = {}
KEEP_ARRAYS = [False]
_register = M.register
_common_grid = M._common_grid
_diverging_rgb = M._diverging_rgb
_draw_marks = M._draw_marks
_minimize = scipy.optimize.minimize


def _cap_register(a: np.ndarray, b: np.ndarray, **kw: Any) -> dict:
    out = _register(a, b, **kw)
    CAPTURE["register"] = {"result": _plain(out), "shape": list(a.shape)}
    if KEEP_ARRAYS[0]:
        CAPTURE["register"].update({"a": f64(a), "b": f64(b)})
    return out


def _cap_minimize(fun, x0, *args: Any, **kw: Any):
    evals: list[list[float]] = []

    def f(d: np.ndarray) -> float:
        v = fun(d)
        evals.append([float(d[0]), float(d[1]), float(v)])
        return v

    sol = _minimize(f, x0, *args, **kw)
    CAPTURE["minimize"] = {"x0": _plain(np.asarray(x0)), "method": kw.get("method"), "options": _plain(kw.get("options")),
                           "x": _plain(sol.x), "fun": float(sol.fun), "nit": int(sol.nit), "nfev": int(sol.nfev),
                           "evals": evals}
    return sol


def _cap_common_grid(ea, eb, za_, zb_, box):
    A, B, grid, s = _common_grid(ea, eb, za_, zb_, box)
    CAPTURE["common_grid"] = {"grid": _plain(grid), "s": s}
    if KEEP_ARRAYS[0]:
        CAPTURE["common_grid"].update({"A": f64(A), "B": f64(B)})
    return A, B, grid, s


def _cap_diverging(d_: np.ndarray, L: float) -> np.ndarray:
    out = _diverging_rgb(d_, L)
    CAPTURE["diverging"] = {"L": L, "shape": list(out.shape),
                            "rgb_sha256": hashlib.sha256(np.ascontiguousarray(out, dtype="u1").tobytes()).hexdigest()}
    if KEEP_ARRAYS[0]:
        CAPTURE["diverging"]["rgb"] = u8(out)
    return out


def _cap_draw_marks(rgb: np.ndarray, marks: list, **kw: Any) -> bytes:
    CAPTURE["marks"] = {"marks": [[float(x), float(y), float(r), t] for x, y, r, t in marks],
                        "colour": list(kw.get("colour") or M.MARK_RGB), "ring": kw.get("ring", True),
                        "image_size": [int(rgb.shape[1]), int(rgb.shape[0])]}
    return _draw_marks(rgb, marks, **kw)


M.register = _cap_register
M._common_grid = _cap_common_grid
M._diverging_rgb = _cap_diverging
M._draw_marks = _cap_draw_marks
scipy.optimize.minimize = _cap_minimize

work = Path(tempfile.mkdtemp(prefix="vm-diff-golden-"))
try:
    archives = {name: Archive(work / name, display_max=dm) for name, dm in ARCHIVES.items()}
    fids = []
    for rec in FRAMES:
        e = archives[rec["archive"]].add_partial(rec["turn"], rec["arrays"], geometry=rec["geometry"], meta=rec["meta"])
        fids.append(e.fid)
    # A derived image without values, and (from the first call) one with values, for the errors.
    archives["main"].add_derived(PLAIN_TURN, PLAIN_PNG, meta={"tool": "fft_peaks", "sources": ["t0000.p0"],
                                                      "description": "a plot", "label_attrs": {"plot": "spectrum"}})
    calls_out = []
    for arch_name, name, args, keep in CALLS:
        arch = archives[arch_name]
        CAPTURE.clear()
        KEEP_ARRAYS[0] = keep
        r = M.diff(arch, args)
        body = json.loads(r.text)
        rec: dict[str, Any] = {"archive": arch_name, "name": name, "args": _plain(args), "is_error": r.is_error,
                               "reply": _plain(body), "key_paths": _key_paths(body)}
        if not r.is_error:
            dfid = body["difference"]["frame"]
            de = arch.get(dfid)
            rec["image"] = {"label": r.images[0].label, "size": list(F.png_size(r.images[0].png))}
            rec["derived"] = {"frame": dfid, "summary": _plain(de.summary()), "values": f32(arch.array(dfid, "diff")),
                              "observation_label": arch.observation(dfid)[0].label}
            rec["capture"] = _plain(CAPTURE)
        calls_out.append(rec)
    index = {name: [_plain(s) for s in arch.index()] for name, arch in archives.items()}
finally:
    M.register = _register
    M._common_grid = _common_grid
    M._diverging_rgb = _diverging_rgb
    M._draw_marks = _draw_marks
    scipy.optimize.minimize = _minimize
    shutil.rmtree(work, ignore_errors=True)

frames_out = []
arrays_out: dict[str, dict] = {}
for rec, fid in zip(FRAMES, fids, strict=True):
    refs = []                    # [array key, array id] in the order the frame was archived with
    for k, v in rec["arrays"].items():
        key = hashlib.sha256(np.ascontiguousarray(v, dtype="<f4").tobytes()).hexdigest()[:16]
        arrays_out.setdefault(key, f32(v))
        refs.append([k, key])
    frames_out.append({"archive": rec["archive"], "turn": rec["turn"], "fid": fid, "geometry": rec["geometry"],
                       "meta": rec["meta"], "arrays": refs})

tool = M.make_diff_tool(768)
golden = {
    "reference": {
        "repository": "VISTA-SPM (vista_spm), read from VISTA_SPM_ROOT",
        "head": _head(ROOT),
        "measure_py_sha256": _sha(ROOT / "vista_spm" / "measure.py"),
        "frames_py_sha256": _sha(ROOT / "vista_spm" / "frames.py"),
        "archive_py_sha256": _sha(ROOT / "vista_spm" / "archive.py"),
        "viewtools_py_sha256": _sha(ROOT / "vista_spm" / "viewtools.py"),
        "protocol_py_sha256": _sha(ROOT / "vista_spm" / "protocol.py"),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
    },
    "seed": SEED,
    "constants": {"refine_px": M.REFINE_PX, "max_regions": M.MAX_REGIONS, "highpass_nm_default": F.HIGHPASS_NM_DEFAULT},
    "tool": {"name": tool.name, "title": tool.title, "description": tool.description,
             "input_schema": tool.input_schema, "read_only": tool.read_only, "idempotent": tool.idempotent},
    "kernels": _plain(KERNELS),
    "archives": ARCHIVES,
    "plain_png_b64": base64.b64encode(PLAIN_PNG).decode("ascii"),
    "plain_png_turn": PLAIN_TURN,
    "arrays": arrays_out,
    "frames": frames_out,
    "calls": calls_out,
    "index": index,
}
OUT.write_text(json.dumps(golden, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":")) + "\n",
               encoding="utf-8", newline="\n")
print(f"wrote {OUT.relative_to(REPO)}: {len(calls_out)} calls, {len(frames_out)} frames, "
      f"{OUT.stat().st_size} bytes")
