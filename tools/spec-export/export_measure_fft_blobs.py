r"""Reference results of VISTA-SPM's ``fft_peaks`` and ``detect_blobs`` for dsh-spm-visual-memory.

VISUAL-HARNESS §5 asks the TypeScript measurement tools to match the Python reference
implementation. This exporter runs ``vista_spm/measure.py`` (``spectrum_peaks``,
``find_blobs``, the tools ``fft_peaks`` / ``detect_blobs``) and the SciPy pieces the port
re-implements (``next_fast_len``, ``least_squares``) on synthetic, seeded inputs, and stores
inputs and results together in ``spec/golden/measure_fft_blobs.json``:

* ``next_fast_len``: SciPy's sizes for 1..2200 (they decide the FFT sizes, hence the
  frequency bins);
* ``least_squares``: the bounded trust-region fits ``_fit_blob`` runs, on Gaussian patches,
  with a bound that becomes active and with an ``max_nfev`` that stops the fit;
* ``spectrum_peaks``: gratings with known periods and angles, a hexagonal lattice on
  anisotropic pixels, stripes with rows not acquired, noise, the 8 x 8 minimum, a frame wider
  than 1024 pixels (no zero padding) and a peak next to the Nyquist edge;
* ``find_blobs``: round and rotated elongated blobs, dark blobs, close pairs, rows not
  acquired, odd shapes (plateau, ring, corner, spike, a wide blob), truncation, and two
  frames with more than 16 candidates, run twice: with SciPy's ``cKDTree`` and with a
  brute-force nearest-candidate search that gives ties to the earlier (stronger) candidate.
  ``cKDTree`` breaks such ties by its tree's traversal order once there are more than 16
  points (its leaf size); the TypeScript port uses the earlier candidate
  (spec/deviations.md D-VMEM-10), and the golden records how far the two results lie apart;
* for every blob case, how far the reference's own result moves when only the last bit of
  ``exp`` moves, as it does between C runtimes: the case rerun with ``exp``'s last bit
  flipped for a random 10 % of its inputs (``_fit_blob`` starts at a circle, so its first
  Jacobian's theta column is rounding noise and the fit's path depends on that bit); the
  distinct outcomes and the largest change per blob, which the parity test holds the port to;
* the tools end to end on a reference archive (temporary directory): parsed replies with the
  key order the model reads, the derived image's label and size, and the numbered marks
  (position, radius, text) drawn on it, captured by wrapping ``_draw_marks``; error replies;
  replies the TypeScript port refuses on purpose (``max_n`` above 50, D-VMEM-9); and the
  size of a 200-blob reply, the evidence for that cap. Frames carry their build order
  (``seq``) and their arrays in insertion order, because the golden is written with sorted keys.

The reference is the VISTA-SPM harness (its own repository, not public yet), imported
read-only from ``VISTA_SPM_ROOT`` (no bytecode is written there). It needs NumPy, SciPy and
Pillow (and matplotlib's font lookup when it is installed), not MAST or STM-Bench. Inputs are
synthetic (seeded); no instrument data. Frames are stored as little-endian float32 bytes in
base64, the precision the archive keeps. The JSON records the sha256 of the reference files
it ran and the reference head, because the reference is still under development.

    VISTA_SPM_ROOT=<VISTA-SPM source root> PYTHONUTF8=1 python tools/spec-export/export_measure_fft_blobs.py
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
import scipy.spatial  # noqa: E402
from scipy.fft import next_fast_len  # noqa: E402
from scipy.optimize import least_squares  # noqa: E402

from _paths import require_vista_spm_root  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "measure_fft_blobs.json"
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
    """Every key of a parsed reply, depth first in insertion order (``$.peaks[0].k_per_nm``)."""
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(f"{path}.{k}")
            out += _key_paths(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += _key_paths(v, f"{path}[{i}]")
    return out


def f32(a: np.ndarray) -> np.ndarray:
    return np.asarray(a, dtype=np.float32)


def b64(a: np.ndarray) -> dict:
    """A float32 frame as ``{shape, f32_b64}`` (little-endian bytes, NaN kept)."""
    a = np.ascontiguousarray(a, dtype="<f4")
    return {"shape": list(a.shape), "f32_b64": base64.b64encode(a.tobytes()).decode("ascii")}


def geom(nx: int, ny: int, w: float, h: float, cx: float = 0.0, cy: float = 0.0, angle: float = 0.0) -> dict:
    return {"cx_nm": cx, "cy_nm": cy, "w_nm": w, "h_nm": h, "angle_deg": angle, "nx": nx, "ny": ny}


def scan_xy(g: dict) -> tuple[np.ndarray, np.ndarray]:
    """Scan-frame nm of every pixel centre of an oriented frame."""
    rr, cc = np.mgrid[0:g["ny"], 0:g["nx"]]
    return F.native_to_scan_nm(g, cc + 0.5, rr + 0.5)


def rng(k: int) -> np.random.Generator:
    return np.random.default_rng(SEED + k)


# ── synthetic surfaces ──────────────────────────────────────────────────────
def grating(g: dict, k_angle: float, period: float, amp: float, noise: float, seed: int) -> np.ndarray:
    X, Y = scan_xy(g)
    a = math.radians(k_angle)
    z = amp * np.cos(2 * math.pi * (X * math.cos(a) + Y * math.sin(a)) / period)
    return z + rng(seed).normal(0.0, noise, z.shape) + 4e-10


def hexagonal(g: dict, period: float, rot: float, amp: float, noise: float, seed: int) -> np.ndarray:
    X, Y = scan_xy(g)
    z = np.zeros_like(X)
    for k in range(3):
        a = math.radians(rot + 60.0 * k)
        z += amp * np.cos(2 * math.pi * (X * math.cos(a) + Y * math.sin(a)) / period)
    return z + rng(seed).normal(0.0, noise, z.shape) + 2e-12 * X


def herringbone(g: dict, seed: int) -> np.ndarray:
    """The simulator's herringbone: a 6.3 nm cosine whose stripes zigzag (+-8.5 deg arms)."""
    X, Y = scan_xy(g)
    th = math.radians(105.0)
    u = X * math.cos(th) + Y * math.sin(th)
    v = -X * math.sin(th) + Y * math.cos(th)
    zig = np.sign(np.sin(2 * math.pi * v / 30.0))
    z = 1e-11 * np.cos(2 * math.pi * (u + 0.15 * zig * v) / 6.3)
    return z + rng(seed).normal(0.0, 2e-12, z.shape)


def blobs(ny: int, nx: int, centres: list, sx: float, sy: float, h: float, noise: float, seed: int,
          theta: float = 0.0, base: bool = True) -> np.ndarray:
    """Elliptical Gaussians at native continuous centres (pixel centre i at i + 0.5)."""
    r = rng(seed)
    yy, xx = np.mgrid[0:ny, 0:nx]
    z = r.normal(0.0, noise, (ny, nx))
    ct, st = math.cos(theta), math.sin(theta)
    for (c, rw) in centres:
        dx, dy = xx + 0.5 - c, yy + 0.5 - rw
        u, v = dx * ct + dy * st, -dx * st + dy * ct
        z += h * np.exp(-0.5 * ((u / sx) ** 2 + (v / sy) ** 2))
    return z + (3e-9 + 1e-12 * xx if base else 0.0)


def spread_centres(n: int, lo: float, hi: float, min_d: float, seed: int, tries: int = 10000) -> list:
    r = rng(seed)
    out: list = []
    for _ in range(tries):
        if len(out) >= n:
            break
        c = (float(r.uniform(lo, hi)), float(r.uniform(lo, hi)))
        if all(math.dist(c, d) > min_d for d in out):
            out.append(c)
    return out


# ── 1. next_fast_len ────────────────────────────────────────────────────────
NEXT_FAST_LEN = {"n_from": 1, "sizes": [int(next_fast_len(n)) for n in range(1, 2201)]}

# ── 2. least_squares (the bounded trust-region fit of _fit_blob) ────────────
def _patch(n: int, A: float, x0: float, y0: float, sa: float, sb: float, th: float, c: float,
           noise: float, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0:n, 0:n]
    xs, ys = xx.ravel().astype(float), yy.ravel().astype(float)
    vs = M._gauss_model(np.array([A, x0, y0, sa, sb, th, c]), xs, ys) + rng(seed).normal(0.0, noise, xs.size)
    return xs, ys, vs


LSQ = []
for name, n, truth, p0, lo, hi, max_nfev in [
    ("round", 15, (1.0, 7.3, 6.8, 2.0, 2.1, 0.3, 0.02), (1.0, 7, 7, 1.8, 1.8, 0.0, 0.0),
     (0.0, 0, 0, 0.3, 0.3, -math.pi, -2.0), (4.0, 14, 14, 14.0, 14.0, math.pi, 2.0), 400),
    ("elongated_rotated", 21, (0.9, 10.4, 9.7, 3.4, 1.3, 0.6, -0.05), (1.0, 10, 10, 2.0, 2.0, 0.0, 0.0),
     (0.0, 0, 0, 0.3, 0.3, -math.pi, -2.0), (4.0, 20, 20, 20.0, 20.0, math.pi, 2.0), 400),
    ("bound_active", 15, (1.0, 7.2, 7.1, 3.0, 2.5, 0.0, 0.0), (1.0, 7, 7, 1.5, 1.5, 0.0, 0.0),
     (0.0, 0, 0, 0.3, 0.3, -math.pi, -2.0), (4.0, 14, 14, 2.0, 2.0, math.pi, 2.0), 400),
    ("max_nfev", 15, (1.0, 7.3, 6.8, 2.0, 2.1, 0.3, 0.02), (1.0, 7, 7, 1.0, 1.0, 0.0, 0.0),
     (0.0, 0, 0, 0.3, 0.3, -math.pi, -2.0), (4.0, 14, 14, 14.0, 14.0, math.pi, 2.0), 3),
    ("amplitude_bound", 13, (1.0, 6.1, 5.9, 1.5, 1.5, 0.0, 0.0), (1.0, 6, 6, 1.5, 1.5, 0.0, 0.0),
     (0.0, 0, 0, 0.3, 0.3, -math.pi, -2.0), (1.2, 12, 12, 12.0, 12.0, math.pi, 2.0), 400),
]:
    xs, ys, vs = _patch(n, *truth, noise=0.03, seed=len(LSQ) + 1)
    if name == "amplitude_bound":
        vs = vs * 1.6     # the data want an amplitude above the bound
    sol = least_squares(lambda p, xs=xs, ys=ys, vs=vs: M._gauss_model(p, xs, ys) - vs, np.array(p0, dtype=float),
                        bounds=(np.array(lo, dtype=float), np.array(hi, dtype=float)), max_nfev=max_nfev)
    LSQ.append({"name": name, "xs": xs, "ys": ys, "vs": vs, "p0": list(p0), "lo": list(lo), "hi": list(hi),
                "max_nfev": max_nfev, "x": sol.x, "cost": float(sol.cost), "nfev": int(sol.nfev),
                "njev": int(sol.njev), "status": int(sol.status), "success": bool(sol.success),
                "optimality": float(sol.optimality), "active_mask": sol.active_mask})

# ── 3. inputs (each frame stored once, referenced by name) ──────────────────
INPUTS: dict[str, dict] = {}


def store(name: str, z: np.ndarray) -> np.ndarray:
    """Keep a frame once, as float32 (the precision the archive keeps); returns it."""
    if name in INPUTS:
        raise KeyError(f"input {name!r} stored twice")
    z32 = f32(z)
    INPUTS[name] = b64(z32)
    return z32


def frame(name: str) -> np.ndarray:
    d = INPUTS[name]
    return np.frombuffer(base64.b64decode(d["f32_b64"]), dtype="<f4").reshape(d["shape"]).copy()


def _stripes_nan() -> np.ndarray:
    g = geom(96, 64, 16.0, 12.0)
    X, Y = scan_xy(g)
    z = 1.2e-11 * np.cos(2 * math.pi * X / 1.6) + 4e-12 * np.cos(2 * math.pi * (0.6 * X + 0.8 * Y) / 0.9)
    z = z + rng(31).normal(0.0, 2e-12, z.shape)
    z[10, :] = np.nan              # an isolated row never acquired
    z[40, 48:] = np.nan            # a row acquired halfway
    z[41:, :] = np.nan             # the rest not yet acquired
    return z


def _few_rows() -> np.ndarray:
    z = rng(32).normal(0.0, 1e-12, (20, 16))
    z[7, :] = np.nan
    z[14:, :] = np.nan
    return z


def _odd_shapes() -> np.ndarray:
    ny = nx = 128
    yy, xx = np.mgrid[0:ny, 0:nx]
    z = rng(41).normal(0.0, 2e-12, (ny, nx))
    rr = np.hypot(xx + 0.5 - 30.3, yy + 0.5 - 32.6)
    z += 40e-12 * (rr < 6.0)                                   # a flat-topped disk
    rr = np.hypot(xx + 0.5 - 90.2, yy + 0.5 - 30.1)
    z += 35e-12 * np.exp(-0.5 * ((rr - 5.0) / 1.5) ** 2)      # a ring
    for (c, r, s) in [(2.2, 3.4, 1.8), (64.7, 126.9, 2.0), (100.4, 95.3, 1.7)]:
        z += 45e-12 * np.exp(-0.5 * ((xx + 0.5 - c) ** 2 + (yy + 0.5 - r) ** 2) / s ** 2)   # corner, edge, plain
    z[80, 20] += 60e-12                                        # a single-pixel spike
    z += 30e-12 * np.exp(-0.5 * ((xx + 0.5 - 40.0) ** 2 + (yy + 0.5 - 95.0) ** 2) / 9.0 ** 2)   # a wide blob
    return z + 1e-9


def _lattice(n: int, period: float, sigma: float, h: float, noise: float, seed: int, offset: float = 4.3) -> np.ndarray:
    m = int((n - offset) // period) + 1
    centres = [(offset + period * i + 0.15 * ((j * 7 + i * 3) % 5), offset + period * j + 0.1 * ((i * 5 + j) % 7))
               for j in range(m) for i in range(m) if offset + period * i < n - 1 and offset + period * j < n - 1]
    return blobs(n, n, centres, sigma, sigma, h, noise, seed)


GA = geom(128, 128, 22.5, 22.5, cx=3.0, cy=-2.0, angle=20.0)
GB = geom(160, 120, 19.2, 18.0, cx=-1.0, cy=0.5, angle=-35.0)
GC = geom(96, 64, 16.0, 12.0)
GD = geom(64, 64, 9.6, 9.6, angle=5.0)
GG = geom(160, 160, 30.0, 30.0, cx=10.0, cy=-4.0, angle=15.0)
GH = geom(128, 128, 25.6, 25.6)
GK = geom(128, 96, 23.04, 17.28, cx=2.0, angle=-10.0)
GI = geom(32, 32, 3.2, 3.2)
GL = geom(128, 128, 12.8, 12.8)

ROUND12 = spread_centres(12, 18.0, 142.0, 15.0, 51)
ELONG12 = spread_centres(12, 15.0, 145.0, 20.0, 52)
PAIRS = [(30.4, 30.6), (33.6, 30.2), (80.3, 40.7), (86.6, 40.1), (40.2, 90.6), (50.7, 91.3), (100.2, 100.5)]
NANROWS = [(20.3, 20.7), (60.6, 25.2), (100.1, 30.4), (35.5, 55.8), (90.2, 60.3), (64.4, 64.9)]
MANY25 = spread_centres(25, 10.0, 150.0, 12.0, 53)
DARK2 = [(40.5, 40.5), (100.25, 60.75)]

XA, YA = scan_xy(GA)
z_a = store("grating_a", grating(GA, 30.0, 2.5, 1e-11, 2e-12, 71))
store("grating_a_bwd", z_a.astype(float) + rng(73).normal(0.0, 1e-12, z_a.shape))
store("current_a", 1.2e-10 + 4e-12 * np.cos(2 * math.pi * XA / 1.9) + rng(72).normal(0.0, 3e-13, XA.shape))
store("hex_b", hexagonal(GB, 1.3, 12.0, 6e-12, 2e-12, 74))
store("stripes_c", _stripes_nan())
store("diff_d", grating(GD, 75.0, 0.9, 3e-12, 1e-12, 75) - 4e-10
      + blobs(64, 64, [(20.3, 22.6), (44.8, 40.2)], 1.6, 1.6, 40e-12, 0.0, 76, base=False))
store("noise64", rng(13).normal(0.0, 1e-12, (64, 64)))
store("grating8", grating(geom(8, 8, 1.6, 1.6), 0.0, 0.8, 1e-11, 1e-12, 14))
store("herringbone", herringbone(geom(128, 128, 45.0, 45.0), 15))
store("wide", grating(geom(1040, 12, 52.0, 0.6), 0.0, 0.37, 1e-11, 2e-12, 16))
store("near_nyquist", grating(geom(64, 64, 6.4, 6.4), 10.0, 0.23, 1e-11, 1e-12, 17))
store("too_small", rng(18).normal(0.0, 1e-12, (7, 9)))
store("few_rows", _few_rows())
store("round12", blobs(160, 160, ROUND12, 2.0, 2.0, 50e-12, 2e-12, 61))
store("elongated12", blobs(160, 160, ELONG12, 3.3, 1.2, 35e-12, 2e-12, 62, theta=0.35))
store("dark2", -blobs(128, 128, DARK2, 2.0, 2.0, 40e-12, 1e-12, 63))
store("current_h", 1e-10 + blobs(128, 128, [(64.3, 30.6), (30.7, 90.2), (95.5, 95.1)], 2.2, 2.2, 6e-12, 1e-13, 78,
                                 base=False))
store("pairs", blobs(128, 128, PAIRS, 1.6, 1.6, 45e-12, 2e-12, 64))
nan_rows = blobs(96, 128, NANROWS, 1.8, 1.8, 40e-12, 2e-12, 54)
nan_rows[66:, :] = np.nan
nan_rows[65, 70:] = np.nan
store("nan_rows", nan_rows)
store("odd_shapes", _odd_shapes())
store("noise96", rng(65).normal(0.0, 2e-12, (96, 96)))
store("anisotropic", blobs(96, 160, [(30.2, 30.3), (80.6, 50.2), (130.1, 70.7)], 2.2, 1.6, 40e-12, 2e-12, 66))
store("many25", blobs(160, 160, MANY25, 1.8, 1.8, 40e-12, 2e-12, 67))
store("lattice121", _lattice(128, 12.0, 1.3, 30e-12, 1.5e-12, 68))
few_px = rng(55).normal(0.0, 1e-12, (32, 32))
few_px[2:, :] = np.nan
few_px[1, 31] = np.nan                                     # 63 acquired pixels
store("few_px", few_px)


# ── 4. spectrum_peaks ───────────────────────────────────────────────────────
def _spectrum_out(res: dict) -> dict:
    return {"peaks": res["peaks"], "k_min": res["k_min"], "k_nyq": res["k_nyq"],
            "dc_lobe_per_nm": res["dc_lobe_per_nm"], "shape": list(res["shape"]), "padded": list(res["padded"]),
            "pad": res["pad"], "fx_ends": [res["fx"][0], res["fx"][1], res["fx"][-1]],
            "fy_ends": [res["fy"][0], res["fy"][1], res["fy"][-1]], "logmag_max": float(res["logmag"].max())}


SPECTRUM_CASES: list[tuple[str, str, float, float, dict]] = [
    ("grating_rot", "grating_a", 22.5 / 128, 22.5 / 128, {"n_peaks": 3, "angle_deg": 20.0}),
    ("hex_aniso", "hex_b", 0.12, 0.15, {"n_peaks": 6, "angle_deg": -35.0}),
    ("stripes_nan", "stripes_c", 16.0 / 96, 12.0 / 64, {"n_peaks": 6, "angle_deg": 0.0}),
    ("noise", "noise64", 0.1, 0.1, {}),
    ("min8", "grating8", 0.2, 0.2, {}),
    ("herringbone", "herringbone", 45.0 / 128, 45.0 / 128, {}),
    ("wide", "wide", 0.05, 0.05, {"n_peaks": 4}),
    ("near_nyquist", "near_nyquist", 0.1, 0.1, {"n_peaks": 2}),
    ("too_small", "too_small", 0.1, 0.1, {}),
    ("few_rows", "few_rows", 0.1, 0.1, {}),
]
SPECTRUM = []
for name, inp, dx, dy, kw in SPECTRUM_CASES:
    case: dict[str, Any] = {"name": name, "input": inp, "dx_nm": dx, "dy_nm": dy, "kwargs": kw}
    try:
        case["result"] = _spectrum_out(M.spectrum_peaks(frame(inp).astype(float), dx, dy, **kw))
    except ValueError as exc:
        case["error"] = str(exc)
    SPECTRUM.append(case)


# ── 5. find_blobs, with cKDTree and with the earlier-candidate tie rule ─────
class _EarlierTree:
    """Nearest candidate by brute force; ties go to the earlier (stronger) candidate."""

    def __init__(self, pts: Any) -> None:
        self.pts = np.asarray(pts, dtype=float)

    def query(self, q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        idx = np.empty(len(q), dtype=int)
        best = np.empty(len(q))
        for s in range(0, len(q), 4096):
            d2 = ((q[s:s + 4096, None, :] - self.pts[None, :, :]) ** 2).sum(-1)
            k = np.argmin(d2, axis=1)              # the first minimum: the earlier candidate
            idx[s:s + 4096] = k
            best[s:s + 4096] = d2[np.arange(len(k)), k]
        return np.sqrt(best), idx


def run_earlier(fn: Any, *args: Any, **kwargs: Any) -> Any:
    orig = scipy.spatial.cKDTree
    scipy.spatial.cKDTree = _EarlierTree
    try:
        return fn(*args, **kwargs)
    finally:
        scipy.spatial.cKDTree = orig


# ── how far the reference's own blob fits move with the last bit of exp ────
# _fit_blob starts every fit at a circle (sa == sb, theta == 0), where the model does not depend
# on theta: the theta column of the first finite-difference Jacobian is rounding noise of exp().
# Which way a nearly round fit then goes depends on the last bit of exp, which differs between C
# runtimes (V8's Math.exp differs from this NumPy's in about one input in eleven). So the blob
# cases are rerun LIBM_SEEDS times with exp's last bit moved up or down for a random LIBM_FLIP of
# its inputs. The golden keeps the distinct outcomes (which blobs, which fit kind; the
# reference's own first) and, per blob, the largest change within its outcome; the parity test
# holds the port to them.
LIBM_SEEDS = 40
LIBM_FLIP = 0.1


class _JitteredNumpy:
    """NumPy, except that exp's last bit moves for a random fraction of its inputs."""

    def __init__(self, seed: int) -> None:
        self._rng = np.random.default_rng(seed)

    def __getattr__(self, name: str) -> Any:
        return getattr(np, name)

    def exp(self, x: Any) -> Any:
        y = np.exp(x)
        flip = self._rng.random(np.shape(y)) < LIBM_FLIP
        up = self._rng.random(np.shape(y)) < 0.5
        return np.where(flip, np.nextafter(y, np.where(up, np.inf, -np.inf)), y)


def run_jittered(seed: int, fn: Any, *args: Any, **kwargs: Any) -> Any:
    orig = M.np
    M.np = _JitteredNumpy(seed)
    try:
        return fn(*args, **kwargs)
    finally:
        M.np = orig


def _major_angle(b: dict) -> float:
    th = b["theta"] if b["sa"] >= b["sb"] else b["theta"] + math.pi / 2
    return math.degrees(th) % 180.0


def _angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


def _same_fit_blobs(a: list, b: list) -> bool:
    return len(a) == len(b) and all(x["fit"] == y["fit"] and abs(x["col"] - y["col"]) < 0.5
                                    and abs(x["row"] - y["row"]) < 0.5 for x, y in zip(a, b))


def libm_outcomes(ref_blobs: list, rerun: Any, seeds: int = LIBM_SEEDS) -> dict:
    """Outcomes of ``seeds`` reruns of find_blobs, the reference's own first, with per-blob spreads."""
    def zero(blobs: list) -> list:
        return [{"position_px": 0.0, "height_rel": 0.0, "sigma_px": 0.0, "major_angle_deg": 0.0} for _ in blobs]

    outcomes = [{"blobs": ref_blobs, "count": 0, "spread": zero(ref_blobs)}]
    for seed in range(seeds):
        blobs = rerun(seed)
        o = next((o for o in outcomes if _same_fit_blobs(blobs, o["blobs"])), None)
        if o is None:
            o = {"blobs": blobs, "count": 0, "spread": zero(blobs)}
            outcomes.append(o)
        o["count"] += 1
        for s, x, y in zip(o["spread"], blobs, o["blobs"]):
            s["position_px"] = max(s["position_px"], abs(x["col"] - y["col"]), abs(x["row"] - y["row"]))
            if y["height"]:
                s["height_rel"] = max(s["height_rel"], abs(x["height"] - y["height"]) / abs(y["height"]))
            s["sigma_px"] = max(s["sigma_px"], abs(max(x["sa"], x["sb"]) - max(y["sa"], y["sb"])),
                                abs(min(x["sa"], x["sb"]) - min(y["sa"], y["sb"])))
            s["major_angle_deg"] = max(s["major_angle_deg"], _angle_diff(_major_angle(x), _major_angle(y)))
    return {"seeds": seeds, "flip_fraction": LIBM_FLIP, "outcomes": outcomes}


def _same_reply_blobs(a: list, b: list) -> bool:
    return len(a) == len(b) and all(x["fit"] == y["fit"] and abs(x["x_px"] - y["x_px"]) < 0.5
                                    and abs(x["y_px"] - y["y_px"]) < 0.5 for x, y in zip(a, b))


def reply_outcomes(ref_blobs: list, rerun: Any, seeds: int) -> dict:
    """Like :func:`libm_outcomes` for a detect_blobs reply: per blob, the largest change of each
    number it reports (axis_angle_deg modulo 180)."""
    def zero(blobs: list) -> list:
        return [{k: 0.0 for k, v in b.items() if isinstance(v, float) or (isinstance(v, int) and k != "id")}
                for b in blobs]

    outcomes = [{"blobs": ref_blobs, "count": 0, "spread": zero(ref_blobs)}]
    for seed in range(seeds):
        blobs = rerun(seed)
        o = next((o for o in outcomes if _same_reply_blobs(blobs, o["blobs"])), None)
        if o is None:
            o = {"blobs": blobs, "count": 0, "spread": zero(blobs)}
            outcomes.append(o)
        o["count"] += 1
        for s, x, y in zip(o["spread"], blobs, o["blobs"]):
            for k in s:
                if x[k] is None or y[k] is None:
                    continue
                d = _angle_diff(x[k], y[k]) if k == "axis_angle_deg" else abs(x[k] - y[k])
                s[k] = max(s[k], d)
    return {"seeds": seeds, "flip_fraction": LIBM_FLIP, "outcomes": outcomes}


def _blobs_out(res: dict) -> dict:
    return {k: res[k] for k in ("blobs", "noise", "noise_smoothed", "threshold", "smoothing_px", "n_candidates",
                                "truncated", "sign")}


BLOB_CASES: list[tuple[str, str, float, float, dict, bool]] = [
    ("round12", "round12", 30.0 / 160, 30.0 / 160, {}, False),
    ("elongated12", "elongated12", 30.0 / 160, 30.0 / 160, {}, False),
    ("dark_as_bright", "dark2", 0.2, 0.2, {}, False),
    ("dark", "dark2", 0.2, 0.2, {"polarity": "dark"}, False),
    ("dark_min_height", "dark2", 0.2, 0.2, {"polarity": "dark", "min_height": 60e-12}, False),
    ("dark_box", "dark2", 0.2, 0.2, {"polarity": "dark", "box": [0, 0, 64, 64]}, False),
    ("pairs", "pairs", 0.15, 0.15, {}, False),
    ("nan_rows", "nan_rows", 0.18, 0.18, {}, False),
    ("odd_shapes", "odd_shapes", 0.2, 0.2, {"background_nm": 8.0}, False),
    ("noise_only", "noise96", 0.18, 0.18, {}, False),
    ("truncate_kept", "round12", 30.0 / 160, 30.0 / 160, {"max_n": 2}, False),
    ("truncate_blobs", "round12", 30.0 / 160, 30.0 / 160, {"max_n": 5}, False),
    ("min_sep", "pairs", 0.15, 0.15, {"min_sep_nm": 1.5}, False),
    ("min_height", "round12", 30.0 / 160, 30.0 / 160, {"min_height": 49.5e-12}, False),
    ("anisotropic", "anisotropic", 0.12, 0.2, {}, False),
    ("current", "current_h", 0.2, 0.2, {}, False),
    ("many25", "many25", 30.0 / 160, 30.0 / 160, {}, True),
    ("lattice", "lattice121", 0.1, 0.1, {"max_n": 50}, True),
    ("few_pixels", "few_px", 0.1, 0.1, {}, False),
]
FIND_BLOBS = []
for name, inp, dx, dy, kw, ties in BLOB_CASES:
    kwargs = dict(kw)
    if "box" in kwargs:
        kwargs["box"] = tuple(kwargs["box"])
    case = {"name": name, "input": inp, "dx_nm": dx, "dy_nm": dy, "kwargs": kw}
    try:
        res = M.find_blobs(frame(inp).astype(float), dx_nm=dx, dy_nm=dy, **kwargs)
        case["result"] = _blobs_out(res)
        if ties:
            alt = run_earlier(M.find_blobs, frame(inp).astype(float), dx_nm=dx, dy_nm=dy, **kwargs)
            case["result_earlier_ties"] = _blobs_out(alt)
    except ValueError as exc:
        case["error"] = str(exc)
    else:
        # the port follows the earlier-candidate tie rule, so that variant's spread is the one it is held to
        base = case["result_earlier_ties"] if ties else case["result"]
        fb = run_earlier if ties else (lambda fn, *a, **k: fn(*a, **k))
        case["libm"] = libm_outcomes(
            base["blobs"],
            lambda seed, inp=inp, dx=dx, dy=dy, kwargs=kwargs, fb=fb: run_jittered(
                seed, fb, M.find_blobs, frame(inp).astype(float), dx_nm=dx, dy_nm=dy, **kwargs)["blobs"])
    FIND_BLOBS.append(case)


# ── 6. the tools on a reference archive ─────────────────────────────────────
CAPTURE: dict[str, Any] = {}
_orig_draw_marks = M._draw_marks
_orig_spectrum_image = M._spectrum_image


def _draw_marks_capture(rgb: np.ndarray, marks: list, **kw: Any) -> bytes:
    CAPTURE["marks"] = [[float(x), float(y), float(r), str(t)] for (x, y, r, t) in marks]
    CAPTURE["image_shape"] = list(rgb.shape)
    return _orig_draw_marks(rgb, marks, **kw)


def _spectrum_image_capture(res: dict, display_max: int) -> tuple:
    rgb, K, size = _orig_spectrum_image(res, display_max)
    CAPTURE["spectrum_image"] = {"k_half_width_per_nm": float(K), "size_px": int(size)}
    return rgb, K, size


M._draw_marks = _draw_marks_capture
M._spectrum_image = _spectrum_image_capture

DISPLAY_MAX = 256


def call(arc: Archive, tool: str, args: Any) -> dict:
    CAPTURE.clear()
    fn = M.fft_peaks if tool == "fft_peaks" else M.detect_blobs
    reply = fn(arc, args)
    parsed = json.loads(reply.text)
    out: dict[str, Any] = {"tool": tool, "args": args, "is_error": reply.is_error, "reply": parsed,
                           "key_paths": _key_paths(parsed), "reply_bytes": len(reply.text.encode("utf-8"))}
    if not reply.is_error:
        de = arc.get(parsed["image"]["frame"])
        out["derived"] = {"frame": de.fid, "label": reply.images[0].label,
                          "size_px": list(F.png_size(reply.images[0].png)), "summary": de.summary(),
                          "marks": CAPTURE.get("marks"), "image_shape": CAPTURE.get("image_shape")}
        if "spectrum_image" in CAPTURE:
            out["derived"]["spectrum_image"] = CAPTURE["spectrum_image"]
    return out


def g5(g: dict) -> dict:
    return {k: g[k] for k in ("cx_nm", "cy_nm", "w_nm", "h_nm", "angle_deg")}


TOOL_LIBM_SEEDS = 24


def build_archive(root: Path) -> tuple[Archive, dict[str, str], dict[str, dict]]:
    """The tools' reference archive: partial scans and derived images of named inputs, in an order
    the port repeats; returns the archive, the frame ids by key and what the port needs to rebuild it."""
    arc = Archive(root, display_max=DISPLAY_MAX)
    FR: dict[str, dict] = {}

    def add(key: str, turn: int, arrays: dict[str, str], g: dict, meta: dict | None = None) -> str:
        e = arc.add_partial(turn, {k: frame(v) for k, v in arrays.items()}, geometry=g5(g), meta=meta or {})
        FR[key] = {"kind": "partial", "seq": len(FR), "fid": e.fid, "turn": turn, "geometry": g5(g),
                   "meta": meta or {}, "arrays": [[k, v] for k, v in arrays.items()]}
        return e.fid

    fA = add("A", 1, {"Z/forward": "grating_a", "Z/backward": "grating_a_bwd", "Current/forward": "current_a"}, GA,
             {"bias_v": 0.5, "setpoint_a": 1e-10})
    add("B", 1, {"Z": "hex_b"}, GB)
    add("C", 2, {"Z": "stripes_c"}, GC)
    png_map = F.encode_png(np.zeros((256, 256), dtype=np.uint8))
    D = arc.add_derived(2, png_map, meta={"tool": "diff", "sources": [fA, fA], "geometry": g5(GD),
                                          "units": {"diff": "m"}}, arrays={"diff/forward": frame("diff_d")})
    FR["D"] = {"kind": "derived", "seq": len(FR), "fid": D.fid, "turn": 2, "tool": "diff", "sources": [fA, fA],
               "geometry": g5(GD), "units": {"diff": "m"}, "arrays": [["diff/forward", "diff_d"]],
               "png_b64": base64.b64encode(png_map).decode("ascii")}
    png_plain = F.encode_png((np.arange(48, dtype=np.uint8).reshape(6, 8) * 5).astype(np.uint8))
    E = arc.add_derived(2, png_plain, meta={"tool": "line_profile", "sources": [fA]})
    FR["E"] = {"kind": "derived", "seq": len(FR), "fid": E.fid, "turn": 2, "tool": "line_profile", "sources": [fA],
               "png_b64": base64.b64encode(png_plain).decode("ascii")}
    add("G", 3, {"Z": "round12"}, GG, {"bias_v": -1.0, "setpoint_a": 5e-11})
    add("H", 3, {"Z": "dark2", "Current": "current_h"}, GH)
    add("K", 4, {"Z": "nan_rows"}, GK)
    add("I", 4, {"Z": "few_px"}, GI)
    add("L", 5, {"Z": "lattice121"}, GL)
    return arc, {k: v["fid"] for k, v in FR.items()}, FR


def with_libm(case: dict, scratch: Archive, earlier_ties: bool = False) -> dict:
    """A detect_blobs case with the spread of its reply under jittered exp (see ``libm_outcomes``),
    rerun on a copy of the archive so the derived frame ids of the main archive stay put."""
    if case["tool"] == "detect_blobs" and not case["is_error"]:
        def rerun(seed: int) -> list:
            fn = (lambda *a: run_earlier(M.detect_blobs, *a)) if earlier_ties else M.detect_blobs
            return json.loads(run_jittered(seed, fn, scratch, case["args"]).text)["blobs"]
        case["libm"] = reply_outcomes(case["reply"]["blobs"], rerun, TOOL_LIBM_SEEDS)
    return case


work = Path(tempfile.mkdtemp(prefix="fft-blobs-golden-"))
try:
    arc, ID, FR = build_archive(work / "frames")
    scratch, _, _ = build_archive(work / "scratch")
    fA, fB, fC, fG, fH, fK, fI, fL = (ID[k] for k in ("A", "B", "C", "G", "H", "K", "I", "L"))
    D, E = arc.get(ID["D"]), arc.get(ID["E"])

    TOOL_CASES = [
        ("fft_peaks", {"frame": fA}),
        ("fft_peaks", {"frame": fA, "n_peaks": 3}),
        ("fft_peaks", {"frame": fA, "region": {"x": 128, "y": 0, "width": 128, "height": 256}}),
        ("fft_peaks", {"frame": fA, "channel": "Current"}),
        ("fft_peaks", {"frame": fA, "direction": "backward", "flatten": "highpass", "highpass_nm": 1.5}),
        ("fft_peaks", {"frame": fA, "flatten": "line"}),
        ("fft_peaks", {"frame": fA, "flatten": "poly2", "n_peaks": 1}),
        ("fft_peaks", {"frame": fA, "flatten": "none", "n_peaks": 2}),
        ("fft_peaks", {"frame": fB}),
        ("fft_peaks", {"frame": fB, "n_peaks": 20}),
        ("fft_peaks", {"frame": fC}),
        ("fft_peaks", {"frame": D.fid}),
        ("fft_peaks", {"frame": fG}),
        ("detect_blobs", {"frame": fG}),
        ("detect_blobs", {"frame": fG, "region": {"x": 0, "y": 0, "width": 96, "height": 96}}),
        ("detect_blobs", {"frame": fG, "max_n": 5}),
        ("detect_blobs", {"frame": fG, "min_sep_nm": 1.0, "background_nm": 5}),
        ("detect_blobs", {"frame": fG, "min_height": 49.5}),
        ("detect_blobs", {"frame": fG, "max_n": 1, "direction": "forward", "polarity": "bright"}),
        ("detect_blobs", {"frame": fH}),
        ("detect_blobs", {"frame": fH, "polarity": "dark"}),
        ("detect_blobs", {"frame": fH, "polarity": "dark", "min_height": 60}),
        ("detect_blobs", {"frame": fH, "polarity": "dark", "region": {"x": 0, "y": 0, "width": 128, "height": 128}}),
        ("detect_blobs", {"frame": fH, "channel": "Current"}),
        ("detect_blobs", {"frame": fK}),
        ("detect_blobs", {"frame": D.fid}),
    ]
    ERROR_CASES = [
        ("fft_peaks", {"frame": fA, "region": {"x": 0, "y": 0, "width": 14, "height": 14}}),
        ("fft_peaks", {}),
        ("fft_peaks", {"frame": fA, "bogus": 1}),
        ("fft_peaks", {"frame": "nope"}),
        ("fft_peaks", {"frame": "t0099.s0"}),
        ("fft_peaks", {"frame": E.fid}),
        ("fft_peaks", {"frame": fA, "n_peaks": 0}),
        ("fft_peaks", {"frame": fA, "n_peaks": 21}),
        ("fft_peaks", {"frame": fA, "n_peaks": 2.5}),
        ("fft_peaks", {"frame": fA, "n_peaks": "3"}),
        ("fft_peaks", {"frame": fA, "n_peaks": True}),
        ("fft_peaks", {"frame": fA, "channel": "Nope"}),
        ("fft_peaks", {"frame": fA, "channel": "Current", "direction": "backward"}),
        ("fft_peaks", {"frame": fA, "direction": "sideways"}),
        ("fft_peaks", {"frame": fA, "flatten": "bogus"}),
        ("fft_peaks", {"frame": fA, "highpass_nm": 2}),
        ("fft_peaks", {"frame": fA, "flatten": "highpass", "highpass_nm": 0}),
        ("fft_peaks", {"frame": fA, "region": {"x": 200, "y": 0, "width": 100, "height": 10}}),
        ("fft_peaks", {"frame": fA, "region": {"x": 0, "y": 0, "width": 10}}),
        ("fft_peaks", {"frame": fA, "region": {"x": 1.5, "y": 0, "width": 10, "height": 10}}),
        ("fft_peaks", None),
        ("fft_peaks", [fA]),
        ("fft_peaks", {"frame": fC, "region": {"x": 0, "y": 100, "width": 192, "height": 28}}),
        ("detect_blobs", {"frame": fG, "background_nm": 0.3}),
        ("detect_blobs", {"frame": fG, "polarity": "both"}),
        ("detect_blobs", {"frame": fG, "max_n": 0}),
        ("detect_blobs", {"frame": fG, "max_n": 201}),
        ("detect_blobs", {"frame": fG, "max_n": 7.5}),
        ("detect_blobs", {"frame": fG, "min_sep_nm": 0}),
        ("detect_blobs", {"frame": fG, "min_sep_nm": 101}),
        ("detect_blobs", {"frame": fG, "min_height": -1}),
        ("detect_blobs", {"frame": fG, "background_nm": 1001}),
        ("detect_blobs", {"frame": fG, "background_nm": "3"}),
        ("detect_blobs", {"frame": fI}),
        ("detect_blobs", {"frame": E.fid}),
        ("detect_blobs", {"frame": fG, "flatten": "plane"}),
        ("detect_blobs", {}),
        ("detect_blobs", "frame"),
    ]
    # Accepted by the reference, refused by the TypeScript port on purpose (D-VMEM-9).
    DEVIATION_CASES = [
        ("detect_blobs", {"frame": fG, "max_n": 51}),
        ("detect_blobs", {"frame": fG, "max_n": 200}),
    ]
    TOOLS = [with_libm(call(arc, t, a), scratch) for t, a in TOOL_CASES]
    ERRORS = [call(arc, t, a) for t, a in ERROR_CASES]
    # The lattice frame has more than 16 candidates: the reply with SciPy's cKDTree, and with
    # ties to the earlier candidate (the TypeScript rule, D-VMEM-10). Each call archives its
    # own derived image, so the second one gets the next derived frame id.
    LATTICE_TOOL = {"ckdtree": call(arc, "detect_blobs", {"frame": fL}),
                    "earlier_ties": with_libm(run_earlier(call, arc, "detect_blobs", {"frame": fL}), scratch,
                                              earlier_ties=True)}
    # Last, because the TypeScript port archives no derived image for them.
    DEVIATIONS = [call(arc, t, a) for t, a in DEVIATION_CASES]
    INDEX = arc.index()

    # Evidence for the cap of 50 blobs (D-VMEM-9): a dense lattice with max_n 200 in the reference,
    # centred far from the origin so the scan-frame coordinates take their longest form.
    dense = _lattice(256, 14.0, 1.6, 30e-12, 1.5e-12, 81, offset=6.2)
    gdense = {"cx_nm": 1234.5678, "cy_nm": -987.6543, "w_nm": 64.0, "h_nm": 64.0, "angle_deg": 33.0}
    fdense = arc.add_partial(6, {"Z": f32(dense)}, geometry=gdense, meta={}).fid
    CAPTURE.clear()
    dense_reply = M.detect_blobs(arc, {"frame": fdense, "max_n": 200})
    dense_body = json.loads(dense_reply.text)
    per_blob = [len(json.dumps(b, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) for b in dense_body["blobs"]]
    CAP_EVIDENCE = {
        "frame": {"nx": 256, "ny": 256, **gdense, "lattice_period_px": 14.0},
        "max_n": 200, "n_blobs": dense_body["n_blobs"], "truncated_to_max_n": dense_body["truncated_to_max_n"],
        "reply_bytes": len(dense_reply.text.encode("utf-8")),
        "blob_bytes_max": max(per_blob), "blob_bytes_mean": sum(per_blob) / len(per_blob),
        "reply_bytes_without_blobs": len(json.dumps({**dense_body, "blobs": []}, ensure_ascii=False,
                                                    separators=(",", ":")).encode("utf-8")),
    }
finally:
    M._draw_marks = _orig_draw_marks
    M._spectrum_image = _orig_spectrum_image
    shutil.rmtree(work, ignore_errors=True)

golden = {
    "reference": {
        "measure_py_sha256": _sha(ROOT / "vista_spm" / "measure.py"),
        "frames_py_sha256": _sha(ROOT / "vista_spm" / "frames.py"),
        "archive_py_sha256": _sha(ROOT / "vista_spm" / "archive.py"),
        "viewtools_py_sha256": _sha(ROOT / "vista_spm" / "viewtools.py"),
        "vista_spm_head": _head(ROOT),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "platform": platform.platform(),
        "seed": SEED,
        "max_blobs": M.MAX_BLOBS,
    },
    "inputs": INPUTS,
    "next_fast_len": NEXT_FAST_LEN,
    "least_squares": LSQ,
    "spectrum_peaks": SPECTRUM,
    "find_blobs": FIND_BLOBS,
    "tools": {"display_max": DISPLAY_MAX, "frames": FR, "index": INDEX, "cases": TOOLS, "errors": ERRORS,
              "lattice": LATTICE_TOOL, "deviations": DEVIATIONS},
    "evidence": {"max_n_200": CAP_EVIDENCE},
}
OUT.write_text(json.dumps(_plain(golden), ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n",
               encoding="utf-8", newline="\n")
print(f"wrote {OUT.relative_to(REPO)} ({OUT.stat().st_size} bytes)")
