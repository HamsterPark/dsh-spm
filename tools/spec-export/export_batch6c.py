r"""批 6c 的金样 —— **旧仓 `tip_metrics` / `spectroscopy` / `force_inversion` /
`lattice_multiframe` 与四个技能真跑一遍**。

与 `export_lattice.py` / `export_analysis.py` 同一套纪律，这里只补四条本批特有的：

1. **`.sxm` / `.dat` 一律录字节，读法归旧仓。** 判据里有 `argmax`、有 `median`、
   有阈值比较 —— 两边各按同一个闭式重建数组时，一次加法结合律的差异在这一层
   不是「最后一位」，是**换一个峰**（批 4a 那四次）。
2. **这一份自己开一台。** 三条支线同时跑，往别人的导出器里插一节会撞。
3. **`polyfit` 的条件数随每一格录。** 本仓的 `polyfit` 走正规方程 + 列缩放，
   numpy 走 SVD；两者的差要用 `lstsqObservedTol(κ)` 去界，而 κ 必须是**跑出来的**。
   这里用一层薄包装拦住 `np.polyfit` 的每一次调用，把缩放后设计阵的 κ 记下来。
4. **`MAST2_PROJECT_ROOT` 指向临时目录**，于是 `InvertForceSaderJarvis` 落的那份
   `artifacts/force_inversion/*.json` 不会写进任何一个仓；录进金样的路径前缀
   统一替换成 `<artifacts>`（本仓那一侧是 `process.cwd()`，见 deviation）。

    python \
        tools/spec-export/export_batch6c.py
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

_ROOT = tempfile.mkdtemp(prefix="mast-6c-root-")
os.environ.setdefault("MAST2_PROJECT_ROOT", _ROOT)

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "batch6c.json"
MAST = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402

# ── `np.polyfit` 的条件数记录器 ───────────────────────────────────────────
#
# 不是装饰：`assess_iz` 的 `fit_r2` / `barrier_ev` 与 `_decay_length` 的 λ 都从
# 这一次拟合出来，而本仓与 numpy 走的是两种解法。κ 是那条容差里唯一的未知数，
# 「一条容差要么推得出来，要么就别写」（`numerics-3.md` 第六节第二条）。
_POLYFIT_CONDS: "list[float]" = []
_POLYFIT_RATIOS: "list[float]" = []
_orig_polyfit = np.polyfit


def _tracking_polyfit(x, y, deg, *args, **kw):
    xs = np.asarray(x, dtype=float)
    V = np.vander(xs, int(deg) + 1)
    scale = np.sqrt((V * V).sum(axis=0))
    scale[scale == 0] = 1.0
    _POLYFIT_CONDS.append(float(np.linalg.cond(V / scale)))
    coef = _orig_polyfit(x, y, deg, *args, **kw)
    # **解向量里最大分量与最高次分量之比**（在**列缩放后**那个坐标系里）。
    #
    # 为什么非记不可：最小二乘的误差界写在**解向量的范数**上，而调用方要的常常是
    # 里面**最小**的那个分量（`assess_iz` 要斜率、`_decay_length` 要 −1/斜率，
    # 而截距比斜率大一两个数量级）。那个分量的**相对**误差因此被放大这一比值。
    # 不记它，`decay_length_m` 那条容差就只能是「刚好让我这版通过的那个数」。
    cs = np.asarray(coef, dtype=float) / scale
    _POLYFIT_RATIOS.append(float(np.max(np.abs(cs)) / max(abs(cs[0]), 1e-300)))
    return coef


np.polyfit = _tracking_polyfit  # type: ignore[assignment]


def _conds() -> "dict[str, list[float]]":
    out = {"cond": list(_POLYFIT_CONDS), "coef_ratio": list(_POLYFIT_RATIOS)}
    _POLYFIT_CONDS.clear()
    _POLYFIT_RATIOS.clear()
    return out


from mast.skills.builtins.atomic_multiframe import AssessAtomicConsistency  # noqa: E402
from mast.skills.builtins.force_inversion import InvertForceSaderJarvis  # noqa: E402
from mast.skills.builtins.tip_from_spectrum import AssessTipFromSpectrum  # noqa: E402
from mast.skills.builtins.tip_sharpness import AssessTipSharpness  # noqa: E402
from mast.vision.force_inversion import (  # noqa: E402
    _decay_length,
    invert_force_curve,
    sader_jarvis,
)
from mast.vision.frame_validity import judge_frame  # noqa: E402
from mast.vision.lattice_calibration import find_lattice_peaks  # noqa: E402
from mast.vision.lattice_multiframe import (  # noqa: E402
    _independent_pair,
    assess_atomic_consistency,
    collect_observation,
)
from mast.vision.spectroscopy import assess_iv, assess_iz  # noqa: E402
from mast.vision.tip_metrics import _edge_resolution, _fwd_bwd_instability  # noqa: E402


def _plain(v: Any) -> Any:
    """JSON 化。**NaN / inf 走字符串占位**（`allow_nan=False` 是这份金样的纪律）。"""
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
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "__dataclass_fields__"):
        return _plain({k: getattr(v, k) for k in v.__dataclass_fields__})
    return str(v)


# ──────────────────────────────────────────────────────────────────────────
# 合成器 —— **闭式，零随机数**
# ──────────────────────────────────────────────────────────────────────────


def _hash_noise(ny: int, nx: int, amp: float, salt: float) -> np.ndarray:
    """可复现的「噪声」（与 `export_analysis.py` / `export_lattice.py` 同一条 sin-hash）。"""
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    v = np.sin(i * 12.9898 + j * 78.233 + salt * 37.719) * 43758.5453123
    return amp * (2.0 * (v - np.floor(v)) - 1.0)


def _wave(ny: int, nx: int, nmpp: float, period_nm: float, angle_deg: float,
          amp: float, phase: float = 0.0) -> np.ndarray:
    i = np.arange(ny, dtype=np.float64)[:, None] * float(nmpp)
    j = np.arange(nx, dtype=np.float64)[None, :] * float(nmpp)
    th = math.radians(float(angle_deg))
    return amp * np.cos(2.0 * np.pi * (j * math.cos(th) + i * math.sin(th)) / float(period_nm) + phase)


#: 晶格帧的边长。**128 而不是 256**：`assess_atomic_phase` 在 256² 上要 1.4 秒，
#: 而这一批每个技能用例要跑 2–3 帧、一共十几格 —— 那会顶穿 vitest 的缺省超时，
#: 而「挂住」与「通过」在汇总行上长得一样（批 3d）。
#: 两条约束仍然要满足（批 4b 的原话）：**必须是 2 的幂**（否则 FFT 走 Bluestein），
#: 且一阶峰的半径 `width_nm / period_nm` 要离脊邻窗 `(9, 18)` 足够远 ——
#: 5 nm / 0.2498 nm ≈ **20.0**，刚好在窗外。
LAT_PX = 128
LAT_WIDTH_NM = 5.0
LAT_NMPP = LAT_WIDTH_NM / LAT_PX          # 0.0390625 ⇒ scale_gate = "reduced"

#: 晶格的取向。**不是 0，而且理由是硬的。**
#:
#: `angle0 = 0` 时六个峰关于 kx 轴**完全镜像**，于是 `_independent_pair` 的三对候选里
#: 有两对的夹角恰好是 `120.466°` 与 `59.534°` —— 两者到 120 / 60 的偏差**逐位相等**
#: （`acos(−x) = π − acos(x)` 只到舍入为止）。谁赢由 V8 与 CPython 的 `acos` 最后一位
#: 决定，实测两边真的选了不同的一对（b 差一个整体符号）。
#:
#: 这正是 D-NUM-18 那条：**一格答案本身没有定义的金样，比一格分辨不出两种候选的更糟**。
#: 取 11° 之后三对的偏差是 0.396 / 1.139 / 1.535 —— 相差六个数量级于浮点噪声。
LAT_ANGLE0 = 11.0


def frame_hex(d_nm: float = 0.2498, angle0: float = LAT_ANGLE0, amp: float = 60e-12,
              noise: float = 3e-12, salt: float = 11.0, ny: int = LAT_PX,
              nx: int = LAT_PX) -> np.ndarray:
    """六角晶格：三组波矢各差 60°，周期 = 原子**行间距**。

    幅值比噪声高一个量级 —— 这是**判据**不是审美：取峰是 `argmax`，一个只领先
    一两个计数的冠军由最后一位浮点决定（批 4a 那四次「掷骰子」）。
    """
    z = 1.0e-9 + 1.2e-12 * np.arange(ny, dtype=np.float64)[:, None] \
        + 0.7e-12 * np.arange(nx, dtype=np.float64)[None, :]
    for k in range(3):
        z = z + _wave(ny, nx, LAT_NMPP, d_nm, angle0 + 60.0 * k, amp, 0.3 * k)
    return z + _hash_noise(ny, nx, noise, salt)


def frame_flat_noise(salt: float = 5.0, ny: int = LAT_PX, nx: int = LAT_PX) -> np.ndarray:
    """没有任何周期结构，但**帧本身完全可用** —— `absent` 那一支要的正是它。"""
    return 1.0e-9 + _hash_noise(ny, nx, 8e-12, salt)


def frame_half_nan(salt: float = 17.0) -> np.ndarray:
    """**下半帧是 NaN** —— 一次中途停掉的扫描。

    这一格是 `n_unusable` 的**唯一**入口：`find_lattice_peaks` 的
    `_UNUSABLE_REASONS` 里能真的出现的只有 `incomplete_frame`（有效像素 < 50%），
    而 `.sxm` 的未扫区通常是**零**不是 NaN（批 4b 的原话：那一支一格金样都没有）。
    这里直接把 NaN 写进字节，于是那一支第一次有输入。

    ⚠️ 必须**严格少于**一半有效：判据是 `frac < 0.5`。这里 NaN 掉 72/128 行。
    """
    z = frame_hex(salt=salt)
    z[56:, :] = np.nan
    return z


# ── `.sxm` 字节 ────────────────────────────────────────────────────────────


def sxm_bytes(frames: "list[tuple[str, str, list[np.ndarray]]]", *, nx: int, ny: int,
              width_m: float, with_range: bool = True, scan_dir: str = "down",
              scan_angle: float = 0.0, bias: str = "\t20.0E-3",
              setpoint: str = "\t500.0E-12") -> bytes:
    rng = f"{width_m:>22.6E}{width_m:>22.6E}"
    lines: "list[str]" = [
        ":NANONIS_VERSION:", "2",
        ":SCANIT_TYPE:", "              FLOAT            MSBFIRST",
        ":REC_DATE:", " 15.09.2026",
        ":REC_TIME:", "12:34:56",
        ":ACQ_TIME:", "          12.8",
        ":BIAS:", bias,
        ":Z-CONTROLLER>Setpoint:", setpoint,
        ":SCAN_PIXELS:", f"        {nx}         {ny}",
        ":SCAN_RANGE:", rng,
        ":SCAN_OFFSET:", "         0.0E+0         0.0E+0",
        ":SCAN_DIR:", scan_dir,
        ":SCAN_ANGLE:", f"       {scan_angle:.3E}",
        ":SCAN_TIME:", "             6.400E+0             6.400E+0",
        ":DATA_INFO:", "\tChannel\tName\tUnit\tDirection\tCalibration\tOffset",
    ]
    if not with_range:
        i = lines.index(":SCAN_RANGE:")
        del lines[i:i + 2]
    for i, (name, direction, _blocks) in enumerate(frames):
        unit = "A" if name == "Current" else "m"
        lines.append(f"\t{i}\t{name}\t{unit}\t{direction}\t9.000E-9\t0.000E+0")
    lines += [":SCANIT_END:", ""]
    head = "\n".join(lines).encode("utf-8")
    blob = b""
    for _name, _direction, blocks in frames:
        for arr in blocks:
            blob += np.asarray(arr, dtype=">f4").tobytes()
    return head + b"\\1A\\04" + blob


TMP = tempfile.mkdtemp(prefix="mast-6c-files-")
FILES: "dict[str, bytes]" = {}
PATHS: "dict[str, str]" = {}


def write_file(key: str, raw: bytes, ext: str = "sxm") -> str:
    FILES[key] = raw
    p = Path(TMP) / f"{key}.{ext}"
    p.write_bytes(raw)
    PATHS[key] = str(p).replace("\\", "/")
    return PATHS[key]


def missing_path(name: str) -> str:
    return f"{TMP}/{name}".replace("\\", "/")


def _mirror(a: np.ndarray) -> np.ndarray:
    """反扫块在文件里是**镜像存的**（`sxm_oriented_frames` 会翻回来）。"""
    return a[:, ::-1]


# ── 台阶帧（`AssessTipSharpness` 用）──────────────────────────────────────

#: 台阶帧的边长与视野。20 nm / 128 px ⇒ **0.15625 nm/px**，于是采样极限是 0.3125 nm
#: —— `unresolved` 那一格给 0.20 nm 就走得到，而 `sharp` / `blunt` 两格给
#: 0.40 / 1.20 nm 都在极限之上。三个 verdict 靠**同一张图**分开，分得开的只有阈值。
STEP_PX = 128
STEP_WIDTH_NM = 20.0
STEP_NMPP = STEP_WIDTH_NM / STEP_PX


def frame_step(edge_w_px: float = 1.5, height_m: float = 0.30e-9, noise: float = 2e-12,
               salt: float = 23.0, ny: int = STEP_PX, nx: int = STEP_PX,
               n_steps: int = 1) -> np.ndarray:
    """**竖直**台阶（高度沿 x 变）+ 轻微倾斜 + 噪声。

    ⚠️ 必须是竖直的：`judge_frame` 的去趋势第一步是**逐行减中位数**，
    一个水平台阶（高度只沿 y 变）会被那一步整行抹平 —— 于是这张图上「有没有台阶」
    这件事在判据看到它之前就没了。旧仓的说明里写的也是「尤其是垂直快扫方向的台阶」。
    """
    j = np.arange(nx, dtype=np.float64)[None, :]
    z = 1.0e-9 + 0.6e-12 * np.arange(ny, dtype=np.float64)[:, None] + 0.3e-12 * j
    for s in range(n_steps):
        x0 = nx * (s + 1) / (n_steps + 1)
        z = z + height_m * 0.5 * (1.0 + np.tanh((j - x0) / float(edge_w_px)))
    return z + _hash_noise(ny, nx, noise, salt)


def frame_dead_flat(ny: int = 64, nx: int = 64) -> np.ndarray:
    """**恒定值**的帧 —— `judge_frame` 第一档（去趋势后起伏**精确**为 0）。

    ⚠️ 必须是恒定值，不能是「一个很平的斜面」：字节是 **float32 大端**写的，
    一个 `1e-9 + 2e-12·j` 的斜面在 float32 里带着 `eps32·1e-9 ≈ 1.2e-16` 的量化噪声，
    去趋势之后那点噪声与 `ptp = 1.89e-10` 的比是 **6e−7 > 1e−7** ⇒ 判**可用**。
    第一版正是这么错过这一支的：三个 verdict 全对，而「拒判」那条路一格都没走到。
    """
    return np.full((ny, nx), 1.0e-9, dtype=np.float64)


def frame_plane_big(ny: int = 64, nx: int = 64) -> np.ndarray:
    """一个**大**斜面 —— `judge_frame` 第二档（残差 / 原始起伏 < 1e−7）。

    与上一格差的正是那个尺度：`ptp = 1.89e−7`，而 float32 的量化噪声仍是相对的
    `1.2e−14` ⇒ 比值 `6.3e−8 < 1e−7` ⇒ 走另一句话。
    两档的**报文不同**（一句说「起伏为 0」，一句把比值印出来），一格分不开两档。
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    return 1.0e-9 + 1e-9 * i + 2e-9 * j


def both(a: np.ndarray) -> "list[np.ndarray]":
    return [a, _mirror(a)]


write_file("step", sxm_bytes([("Z", "both", both(frame_step()))],
                             nx=STEP_PX, ny=STEP_PX, width_m=STEP_WIDTH_NM * 1e-9))
write_file("step_broad", sxm_bytes([("Z", "both", both(frame_step(edge_w_px=6.0)))],
                                   nx=STEP_PX, ny=STEP_PX, width_m=STEP_WIDTH_NM * 1e-9))
# 单方向：`fwd_bwd_instability` 那一列必须是 `None`，而不是一个编出来的数。
write_file("step_fwd_only", sxm_bytes([("Z", "fwd", [frame_step()])],
                                      nx=STEP_PX, ny=STEP_PX, width_m=STEP_WIDTH_NM * 1e-9))
write_file("step_no_scale", sxm_bytes([("Z", "both", both(frame_step()))],
                                      nx=STEP_PX, ny=STEP_PX, width_m=STEP_WIDTH_NM * 1e-9,
                                      with_range=False))
write_file("tip_noise", sxm_bytes([("Z", "both", both(frame_flat_noise(salt=31.0, ny=STEP_PX, nx=STEP_PX)))],
                                  nx=STEP_PX, ny=STEP_PX, width_m=STEP_WIDTH_NM * 1e-9))
write_file("dead_flat", sxm_bytes([("Z", "fwd", [frame_dead_flat()])],
                                  nx=64, ny=64, width_m=10e-9))
write_file("plane_big", sxm_bytes([("Z", "fwd", [frame_plane_big()])],
                                  nx=64, ny=64, width_m=10e-9))
write_file("current_only", sxm_bytes([("Current", "fwd", [frame_step() * 1e-3])],
                                     nx=STEP_PX, ny=STEP_PX, width_m=STEP_WIDTH_NM * 1e-9))

# ── 晶格帧（`AssessAtomicConsistency` 用）─────────────────────────────────

write_file("hex_a", sxm_bytes([("Z", "fwd", [frame_hex(salt=11.0)])],
                              nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9))
write_file("hex_b", sxm_bytes([("Z", "fwd", [frame_hex(salt=13.0)])],
                              nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9))
# 同一个晶格、台子转了 17°：帧里的晶格跟着转 −17°，于是实验室系取向不变。
# 这一格分得开的是「取向有没有先扣掉扫描角」—— 不扣的话它会判 `inconsistent`。
write_file("hex_rot", sxm_bytes([("Z", "fwd", [frame_hex(angle0=LAT_ANGLE0 - 17.0, salt=19.0)])],
                                nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9,
                                scan_angle=17.0))
# 周期差 16% ⇒ period_spread ≈ 0.075 > 0.06 ⇒ `inconsistent`（而角度一致）。
write_file("hex_period", sxm_bytes([("Z", "fwd", [frame_hex(d_nm=0.2900, salt=23.0)])],
                                   nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9))
write_file("lat_noise_a", sxm_bytes([("Z", "fwd", [frame_flat_noise(salt=5.0)])],
                                    nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9))
write_file("lat_noise_b", sxm_bytes([("Z", "fwd", [frame_flat_noise(salt=7.0)])],
                                    nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9))
write_file("half_nan_a", sxm_bytes([("Z", "fwd", [frame_half_nan(salt=17.0)])],
                                   nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9))
write_file("half_nan_b", sxm_bytes([("Z", "fwd", [frame_half_nan(salt=29.0)])],
                                   nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9))
# 标度差 25% ⇒ 「不是同一种取图」那一支（它报的是一个 `%.1f%%` 的数）。
write_file("hex_coarse", sxm_bytes([("Z", "fwd", [frame_hex(salt=37.0)])],
                                   nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1.25e-9))
# 头里没有 SCAN_ANGLE 的那一支：`_load_one` 明确拒绝，而不是当成 0°。
_no_angle = sxm_bytes([("Z", "fwd", [frame_hex(salt=41.0)])],
                      nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9)
_no_angle = _no_angle.replace(b":SCAN_ANGLE:\n       0.000E+00\n", b"")
write_file("hex_no_angle", _no_angle)
write_file("lat_no_scale", sxm_bytes([("Z", "fwd", [frame_hex(salt=43.0)])],
                                     nx=LAT_PX, ny=LAT_PX, width_m=LAT_WIDTH_NM * 1e-9,
                                     with_range=False))


# ──────────────────────────────────────────────────────────────────────────
# `.dat` 字节
# ──────────────────────────────────────────────────────────────────────────


def dat_bytes(header: "dict[str, str]", columns: "list[tuple[str, np.ndarray]]") -> bytes:
    lines = [f"{k}\t{v}" for k, v in header.items()]
    lines.append("")
    lines.append("[DATA]")
    lines.append("\t".join(n for n, _ in columns))
    n = len(columns[0][1]) if columns else 0
    for i in range(n):
        lines.append("\t".join(f"{float(col[i]):.12E}" for _, col in columns))
    return ("\n".join(lines) + "\n").encode("utf-8")


# ── I(z)：干净单指数 / 有跳变 / 非指数 ────────────────────────────────────

_IZ_Z = np.linspace(0.0, 0.6e-9, 41)          # 米（技能会 ×1e9 换成 nm）
#: 2κ = 20.5 nm⁻¹ ⇒ κ = 1.025 Å⁻¹ ⇒ φ = (1.025/0.5123)² = 4.00 eV（清洁金属）
_IZ_DECAY_PER_NM = 20.5


def iz_current(z_m: np.ndarray, decay_per_nm: float = _IZ_DECAY_PER_NM,
               i0: float = 1e-9, jump_at: "int | None" = None,
               jump_factor: float = 3.0) -> np.ndarray:
    i = i0 * np.exp(-decay_per_nm * (z_m * 1e9))
    if jump_at is not None:
        i = i.copy()
        i[jump_at:] = i[jump_at:] * jump_factor
    return i


write_file("iz_clean", dat_bytes(
    {"Experiment": "Z spectroscopy", "Date": "15.09.2026 12:34:56",
     "X (m)": "1.000E-9", "Y (m)": "2.000E-9"},
    [("Z rel (m)", _IZ_Z), ("Current (A)", iz_current(_IZ_Z))]), ext="dat")
write_file("iz_jump", dat_bytes(
    {"Experiment": "Z spectroscopy"},
    [("Z rel (m)", _IZ_Z), ("Current (A)", iz_current(_IZ_Z, jump_at=20))]), ext="dat")
#: 2κ = 4.0 nm⁻¹ ⇒ φ = 0.152 eV —— 一条**在窗外**的势垒（针尖脏 / 不在隧道区）
write_file("iz_lowbarrier", dat_bytes(
    {"Experiment": "Z spectroscopy"},
    [("Z rel (m)", _IZ_Z), ("Current (A)", iz_current(_IZ_Z, decay_per_nm=4.0))]), ext="dat")
#: 纯噪声 —— 拟合站不住，于是「势垒」是拟合的副产物，那一条必须**不参与判决**
_IZ_NOISE = 1e-10 * (1.5 + np.sin(np.arange(41) * 2.3) * 0.9)
write_file("iz_noise", dat_bytes(
    {"Experiment": "Z spectroscopy"},
    [("Z rel (m)", _IZ_Z), ("Current (A)", _IZ_NOISE)]), ext="dat")

# ── I(V)：稳定 / 有尖峰 / 有能隙 ──────────────────────────────────────────

_IV_V = np.linspace(-1.0, 1.0, 61)


def iv_current(v: np.ndarray, spike_at: "int | None" = None,
               gap_v: float = 0.0, asym: float = 0.0) -> np.ndarray:
    i = 1e-9 * (np.sinh(2.5 * v) + asym * v * v)
    if gap_v > 0:
        i = i * (np.abs(v) > gap_v)
    if spike_at is not None:
        i = i.copy()
        i[spike_at] = i[spike_at] + 4e-9
    return i


write_file("iv_clean", dat_bytes(
    {"Experiment": "bias spectroscopy"},
    [("Bias calc (V)", _IV_V), ("Current (A)", iv_current(_IV_V))]), ext="dat")
write_file("iv_spike", dat_bytes(
    {"Experiment": "bias spectroscopy"},
    [("Bias calc (V)", _IV_V), ("Current (A)", iv_current(_IV_V, spike_at=22))]), ext="dat")
write_file("iv_gap", dat_bytes(
    {"Experiment": "bias spectroscopy"},
    [("Bias calc (V)", _IV_V), ("Current (A)", iv_current(_IV_V, gap_v=0.25))]), ext="dat")
write_file("iv_asym", dat_bytes(
    {"Experiment": "bias spectroscopy"},
    [("Bias calc (V)", _IV_V), ("Current (A)", iv_current(_IV_V, asym=6.0))]), ext="dat")
#: 头**说**是 I(V)，而 DATA 里在扫的是 z —— 交叉检验那一条 note 只有这一格走得到
write_file("iv_header_lies", dat_bytes(
    {"Experiment": "bias spectroscopy"},
    [("Z rel (m)", _IZ_Z), ("Current (A)", iz_current(_IZ_Z))]), ext="dat")
#: 没有电流列 ⇒ `unrated`，**不是**技能失败
write_file("dat_no_current", dat_bytes(
    {"Experiment": "bias spectroscopy"},
    [("Bias calc (V)", _IV_V), ("LI Demod 1 X (A)", _IV_V * 1e-12)]), ext="dat")
#: 有电流、没有任何扫描轴 ⇒ `no_sweep_column`
write_file("dat_no_sweep", dat_bytes(
    {"Experiment": ""},
    [("Index", np.arange(61.0)), ("Current (A)", iv_current(_IV_V))]), ext="dat")
#: 只有 [DATA] 头、没有数据行 ⇒ 空 columns ⇒ 「没有 [DATA] 段」
write_file("dat_empty", b"Experiment\tbias spectroscopy\n\n[DATA]\n", ext="dat")

# ── Δf(z)：Sader–Jarvis ───────────────────────────────────────────────────

#: qPlus 的典型值。f0 从头里取得到，**k 取不到**（任何 Nanonis 头里都没有它）。
F0_HZ = 30000.0
K_N_PER_M = 1800.0


def df_morse(z_m: np.ndarray, depth_hz: float = 30.0, r0_nm: float = 0.55,
             lam_nm: float = 0.12) -> np.ndarray:
    """`−D(2e^{−u} − e^{−2u})`，`u = (z − r0)/λ` —— 极小恰好落在 `z = r0`，深 `−D`。

    长程吸引、短程排斥，是一条真实的 Δf(z) 的形状；而**极小在哪**是可以写下来的，
    于是「反演出的力极小相对 Δf 极小偏了多少」这一格有一个可核对的参照。
    """
    u = (z_m * 1e9 - r0_nm) / lam_nm
    return -depth_hz * (2.0 * np.exp(-u) - np.exp(-2.0 * u))


_FZ_Z = np.linspace(0.30e-9, 1.50e-9, 121)
_FZ_DF = df_morse(_FZ_Z)


def force_dat(z: np.ndarray, df: np.ndarray, *, with_amp_col: bool = True,
              amp_m: float = 50e-12, with_f0_header: bool = True,
              with_amp_header: bool = False) -> bytes:
    header: "dict[str, str]" = {"Experiment": "Z spectroscopy"}
    if with_f0_header:
        header["Oscillation Control>Center Frequency (Hz)"] = f"{F0_HZ:.6E}"
    if with_amp_header:
        header["Oscillation Control>Amplitude Setpoint (m)"] = f"{amp_m:.6E}"
    cols: "list[tuple[str, np.ndarray]]" = [
        ("Z rel (m)", z), ("Frequency Shift (Hz)", df)]
    if with_amp_col:
        cols.append(("Amplitude (m)", np.full(z.size, amp_m)))
    return dat_bytes(header, cols)


write_file("fz_well", force_dat(_FZ_Z, _FZ_DF), ext="dat")
write_file("fz_well_hdr_amp", force_dat(_FZ_Z, _FZ_DF, with_amp_col=False,
                                        with_amp_header=True), ext="dat")
write_file("fz_no_f0", force_dat(_FZ_Z, _FZ_DF, with_f0_header=False), ext="dat")
#: 背景：同样扫程上的一条**长程**曲线（没有短程阱）。扣掉它阱会更干净。
write_file("fz_background", force_dat(_FZ_Z, -3.0 * np.exp(-(_FZ_Z * 1e9 - 0.3) / 0.45)),
           ext="dat")
#: 扫程没跨过拐点 ⇒ Δf 的极小落在端点 ⇒ `minimum_not_bracketed`
_FZ_EDGE_Z = np.linspace(0.62e-9, 1.60e-9, 121)
write_file("fz_edge", force_dat(_FZ_EDGE_Z, df_morse(_FZ_EDGE_Z)), ext="dat")
#: 只有 12 个点 ⇒ `too_few_points`
_FZ_SHORT_Z = np.linspace(0.30e-9, 1.50e-9, 12)
write_file("fz_short", force_dat(_FZ_SHORT_Z, df_morse(_FZ_SHORT_Z)), ext="dat")
#: 一条几乎平的曲线（只有 0.05 Hz 的起伏）⇒ 阱在噪声里
_FZ_FLAT_DF = 0.05 * np.sin(2.0 * np.pi * (_FZ_Z * 1e9 - 0.3) / 0.7)
write_file("fz_flat", force_dat(_FZ_Z, _FZ_FLAT_DF), ext="dat")
#: 没有频移列
write_file("fz_no_df", dat_bytes({"Experiment": "Z spectroscopy"},
                                 [("Z rel (m)", _FZ_Z), ("Current (A)", _FZ_Z * 0 + 1e-12)]),
           ext="dat")
#: **在扫程里没有衰减完**的力律（λ = 0.6 nm，扫程只有 1.2 nm）。
#:
#: 正向残差那道闸（`> 0.10`）的**唯一**入口。为什么别的格进不来：`sader_jarvis`
#: 与 `forward_df` 互为逆，所以在一条**自洽**的数据上把力再推回去几乎精确 ——
#: 往 Δf 上加噪声也没用（噪声照样被两边同样地搬运，实测残差只从 0.006 涨到 0.010）。
#: 真正让它失效的是**半无穷积分被截断**：`np.interp` 在 `z > z_max` 上把力钳成末值，
#: 而一条还没衰减完的力律在那里远不是 0。
#:
#: ⚠️ 同一条曲线配**三个振幅**，为的是把 0.10 这条线的两侧都占上：
#: `3e-10` ⇒ 残差 **0.094**（刚好在线下，判 `well`）；
#: `1e-9` ⇒ **0.212**（判 `undecidable`）；`3e-9` ⇒ **0.292** 且 `large_amplitude`
#: （多一条 `amplitude_exceeds_the_force_decay_length` 告警）。
#: 一格在线的一侧的金样照不出这道闸在哪。
_FZ_SLOW_DF = df_morse(_FZ_Z, depth_hz=30.0, r0_nm=0.35, lam_nm=0.6)
write_file("fz_slow", force_dat(_FZ_Z, _FZ_SLOW_DF, with_amp_col=False), ext="dat")


# ──────────────────────────────────────────────────────────────────────────
# 1. `_edge_resolution` —— 直接喂**归一化后**的数组
# ──────────────────────────────────────────────────────────────────────────
#
# 为什么不全走 `.sxm`：这个函数的三道出局闸（`gmax < 1e-6` / `step < 0.3` /
# `gmax/gmed < 6`）**回的是同一个 `(None, None)`**，所以要分开它们，必须有
# 「只踩其中一条」的输入 —— 而那种输入在一张真帧上造不出来（见 `batch-6c.md`）。
EDGE: "list[dict]" = []
_EDGE_PX = 64


def _edge_input(kind: str) -> np.ndarray:
    j = np.arange(_EDGE_PX, dtype=np.float64)[None, :]
    base = np.zeros((_EDGE_PX, _EDGE_PX), dtype=np.float64) + 0.004 * j
    noise = _hash_noise(_EDGE_PX, _EDGE_PX, 0.02, 3.0)
    if kind == "sharp":
        return base + 1.0 * np.tanh((j - 32.0) / 1.2) + noise
    if kind == "broad":
        return base + 1.0 * np.tanh((j - 32.0) / 6.0) + noise
    if kind == "two_steps":
        return base + 0.5 * np.tanh((j - 21.0) / 1.2) + 0.5 * np.tanh((j - 43.0) / 1.2) + noise
    if kind == "low_contrast":
        # **只踩 `step < 0.3`**：形状与 `sharp` 一样，幅度缩到 0.1 ⇒
        # p97 − p3 ≈ 0.21 < 0.3，而 gmax/gmed 照样远超 6。
        return 0.1 * (base + 1.0 * np.tanh((j - 32.0) / 1.2)) + 0.1 * noise
    if kind == "noise":
        # **只踩 `gmax/gmed < 6`**：梯度处处一样，没有「边缘」可以量分辨率。
        return _hash_noise(_EDGE_PX, _EDGE_PX, 1.0, 9.0)
    raise ValueError(kind)


for _k in ["sharp", "broad", "two_steps", "low_contrast", "noise"]:
    _img = _edge_input(_k)
    for _nmpp in ([0.15625] if _k != "sharp" else [0.15625, None]):
        _w_px, _w_nm = _edge_resolution(_img, _nmpp)
        EDGE.append({
            "case": _k if _nmpp is not None else f"{_k}_no_scale",
            "nm_per_px": _nmpp,
            "image": _plain(_img),
            "width_px": _plain(_w_px),
            "width_nm": _plain(_w_nm),
        })


# ──────────────────────────────────────────────────────────────────────────
# 2. `_fwd_bwd_instability`
# ──────────────────────────────────────────────────────────────────────────
INSTAB: "list[dict]" = []
_INS_PX = 48


def _ins_frame(salt: float, amp: float = 30e-12, period_px: float = 31.0,
               angle_deg: float = 0.0) -> np.ndarray:
    """**长波为主**的形貌（周期 31 px）+ 一点短波纹 + 噪声。

    ⚠️ 长波必须占主导：第一版只放了一条 9 px 的纹，于是「反相」那一格被一次
    4.5 px 的平移**救了回来**（半个周期的平移把反相变成同相）⇒ 它量到 0.18 而不是
    接近 1，而那一格存在的全部理由就是「最坏的针尖行为长什么样」。
    周期 31 px 远大于平移窗（`0.12 × 48 = 5` px），于是窗内没有任何平移能翻转符号。
    """
    i = np.arange(_INS_PX, dtype=np.float64)[:, None]
    j = np.arange(_INS_PX, dtype=np.float64)[None, :]
    th = math.radians(angle_deg)
    u = j * math.cos(th) + i * math.sin(th)
    return (1.0e-9 + 1.5e-12 * i + 0.8e-12 * j
            + amp * np.cos(2.0 * np.pi * u / period_px)
            + 0.25 * amp * np.cos(2.0 * np.pi * u / 9.0 + 0.7)
            + _hash_noise(_INS_PX, _INS_PX, amp * 0.05, salt))


_INS_A = _ins_frame(3.0)
_INS_CASES = {
    # 逐位相同 ⇒ 完全相关
    "identical": (_INS_A, _INS_A.copy()),
    # **横移 4 px** —— 「允许平移」那一条的唯一入口。零平移的判据在这一格上饱和
    "shift_4px": (_INS_A, np.roll(_INS_A, 4, axis=1)),
    # 横移 12 px > `0.12 × 48 = 5` ⇒ 落在窗外 ⇒ 判成不稳
    "shift_12px": (_INS_A, np.roll(_INS_A, 12, axis=1)),
    # 反相 —— 最坏的针尖行为
    "anti": (_INS_A, 2.0e-9 - _INS_A),
    # **真的不相关**：一张纵纹一张横纹。第一版这里两张只差噪声盐，于是它量到
    # 0.0056 —— 一个「完全一致」的数字挂在一个叫 `independent` 的名字上。
    "independent": (_ins_frame(5.0, angle_deg=0.0), _ins_frame(7.0, angle_deg=90.0)),
    # 一侧完全是平面 ⇒ 去趋势后**精确**为 0 ⇒ 防除零那一支
    "dead_flat_bwd": (_INS_A, np.zeros((_INS_PX, _INS_PX)) + 1e-9
                      + 1e-12 * np.arange(_INS_PX, dtype=np.float64)[:, None]),
    # **1 pm 起伏的安静好帧** —— `na ≈ 4.8e−11`，落在旧阈值 `1e-9` 与现阈值
    # `1e-30` **之间**。2026-08-10 那条「绝对阈值卡在物理量上就是个 bug」的
    # 唯一可分辨输入：旧阈值在这里回 1.0（判决线 0.40 的拒绝一侧），
    # 而这是一块越平越好的好表面。
    "quiet_pm": (_ins_frame(3.0, amp=1e-12), _ins_frame(3.0, amp=1e-12)),
}
for _name, (_a, _b) in _INS_CASES.items():
    INSTAB.append({
        "case": _name,
        "fwd": _plain(_a), "bwd": _plain(_b),
        "instability": _plain(float(_fwd_bwd_instability(_a, _b))),
    })


# ──────────────────────────────────────────────────────────────────────────
# 3. `assess_iz` / `assess_iv`
# ──────────────────────────────────────────────────────────────────────────
IZ: "list[dict]" = []
for _name, (_z, _i) in {
    "clean": (_IZ_Z, iz_current(_IZ_Z)),
    "jump": (_IZ_Z, iz_current(_IZ_Z, jump_at=20)),
    "low_barrier": (_IZ_Z, iz_current(_IZ_Z, decay_per_nm=4.0)),
    "noise": (_IZ_Z, _IZ_NOISE),
    # 少于 5 个点 ⇒ 早退（`fit_r2 = 0`，**不是**「拟合得很差」）
    "too_short": (_IZ_Z[:4], iz_current(_IZ_Z[:4])),
    # 长度不等 ⇒ 同一支
    "mismatch": (_IZ_Z[:10], iz_current(_IZ_Z[:12])),
    # 电流全部在本底之下 ⇒ `ok.sum() < 5`
    "all_below_floor": (_IZ_Z, np.concatenate([[1e-9], np.full(40, 1e-18)])),
    # **递减的 z** —— 与 `clean` 同解（见下），录它是为了钉住「同解」这件事本身
    "descending": (_IZ_Z[::-1].copy(), iz_current(_IZ_Z[::-1].copy())),
    # **乱序的 z** —— `argsort` 那一步唯一分得开的输入。
    #
    # ⚠️ 这一格是变异演练**当场逼出来**的：第一版只有 `descending`，而去掉排序之后
    # 它的答案**一点没变** —— 整条序列反过来时 `diff(ll)` 全部变号，
    # 而判据是 `|d − median(d)|`，`median` 也跟着变号 ⇒ 逐位相同。
    # 一格「恰好同解」的金样看起来在验那道闸，其实一个字都没说。
    "shuffled": (np.concatenate([_IZ_Z[::2], _IZ_Z[1::2]]),
                 iz_current(np.concatenate([_IZ_Z[::2], _IZ_Z[1::2]]))),
}.items():
    _conds()
    _r = assess_iz(_z * 1e9, _i)
    IZ.append({
        "case": _name, "z_nm": _plain(_z * 1e9), "current": _plain(_i),
        "result": _plain(_r.model_dump()), "polyfit_cond": _plain(_conds()),
    })

IV: "list[dict]" = []
for _name, (_v, _i) in {
    "clean": (_IV_V, iv_current(_IV_V)),
    "spike": (_IV_V, iv_current(_IV_V, spike_at=22)),
    "gap": (_IV_V, iv_current(_IV_V, gap_v=0.25)),
    "asym": (_IV_V, iv_current(_IV_V, asym=6.0)),
    "too_short": (_IV_V[:6], iv_current(_IV_V[:6])),
    "mismatch": (_IV_V[:10], iv_current(_IV_V[:12])),
    # 恒为零的电流 ⇒ `std(Is) < 1e-9` ⇒ `symmetry = 0`，**不是** NaN
    "all_zero": (_IV_V, np.zeros_like(_IV_V)),
    # 乱序的 V —— 只有它分得开「排没排序」
    "shuffled": (np.concatenate([_IV_V[::2], _IV_V[1::2]]),
                 iv_current(np.concatenate([_IV_V[::2], _IV_V[1::2]]))),
}.items():
    IV.append({
        "case": _name, "bias_v": _plain(_v), "current": _plain(_i),
        "result": _plain(assess_iv(_v, _i).model_dump()),
    })


# ──────────────────────────────────────────────────────────────────────────
# 4. `sader_jarvis` / `_decay_length` / `invert_force_curve`
# ──────────────────────────────────────────────────────────────────────────
SJ: "list[dict]" = []
for _name, (_z, _df, _amp) in {
    "morse_50pm": (_FZ_Z, _FZ_DF, 50e-12),
    "morse_30pm": (_FZ_Z, _FZ_DF, 30e-12),
    "morse_500pm": (_FZ_Z, _FZ_DF, 500e-12),
    # **非等距的 z** —— `np.gradient` 的两条分支在这一格上给不同的数
    "nonuniform_z": (0.30e-9 + np.cumsum(np.concatenate(
        [[0.0], 4e-12 * 1.035 ** np.arange(120)])), None, 50e-12),
}.items():
    _zz = np.asarray(_z, dtype=float)
    _dd = df_morse(_zz) if _df is None else np.asarray(_df, dtype=float)
    _f = sader_jarvis(_zz, _dd, f0_hz=F0_HZ, k_n_per_m=K_N_PER_M, amplitude_m=_amp)
    _imin = int(np.argmin(_f[1:_f.size - max(4, _f.size // 10)])) + 1
    _conds()
    _lam = _decay_length(_zz, _f, _imin)
    SJ.append({
        "case": _name, "z_m": _plain(_zz), "df_hz": _plain(_dd),
        "f0_hz": F0_HZ, "k_n_per_m": K_N_PER_M, "amplitude_m": _amp,
        "force_n": _plain(_f),
        "i_min": _imin, "decay_length_m": _plain(_lam),
        "polyfit_cond": _plain(_conds()),
    })

INVERT: "list[dict]" = []
for _name, _kw in {
    "well": {"z_m": _FZ_Z, "df_hz": _FZ_DF, "amplitude_m": 30e-12},
    "well_large_amp": {"z_m": _FZ_Z, "df_hz": _FZ_DF, "amplitude_m": 500e-12},
    "with_background": {"z_m": _FZ_Z, "df_hz": _FZ_DF, "amplitude_m": 30e-12,
                        "background_df_hz": -3.0 * np.exp(-(_FZ_Z * 1e9 - 0.3) / 0.45)},
    "background_mismatch": {"z_m": _FZ_Z, "df_hz": _FZ_DF, "amplitude_m": 30e-12,
                            "background_df_hz": np.zeros(7)},
    "smoothed": {"z_m": _FZ_Z, "df_hz": _FZ_DF, "amplitude_m": 30e-12,
                 "smooth_points": 9},
    # `smooth_points = 4` ⇒ **不平滑**（判据是 `>= 5`）。这一格与上一格差一个数字，
    # 而两者的答案必须不同 —— 否则那道门槛没人在验。
    "smooth_too_few": {"z_m": _FZ_Z, "df_hz": _FZ_DF, "amplitude_m": 30e-12,
                       "smooth_points": 4},
    "edge_minimum": {"z_m": _FZ_EDGE_Z, "df_hz": df_morse(_FZ_EDGE_Z),
                     "amplitude_m": 30e-12},
    "too_few_points": {"z_m": _FZ_SHORT_Z, "df_hz": df_morse(_FZ_SHORT_Z),
                       "amplitude_m": 30e-12},
    "shape_mismatch": {"z_m": _FZ_Z, "df_hz": _FZ_DF[:50], "amplitude_m": 30e-12},
    "flat": {"z_m": _FZ_Z, "df_hz": _FZ_FLAT_DF, "amplitude_m": 30e-12},
    # 有 NaN 的点先被滤掉 —— 「滤了几个」直接决定 `n_points`
    "with_nan": {"z_m": _FZ_Z, "df_hz": np.where(np.arange(121) % 37 == 0, np.nan, _FZ_DF),
                 "amplitude_m": 30e-12},
    # 截断误差那一族 —— 0.10 这条线的两侧各一格 + 一格 `large_amplitude`
    "slow_decay_ok": {"z_m": _FZ_Z, "df_hz": _FZ_SLOW_DF, "amplitude_m": 3e-10},
    "slow_decay_undecidable": {"z_m": _FZ_Z, "df_hz": _FZ_SLOW_DF, "amplitude_m": 1e-9},
    "slow_decay_large_amp": {"z_m": _FZ_Z, "df_hz": _FZ_SLOW_DF, "amplitude_m": 3e-9},
}.items():
    _kw2 = dict(_kw)
    _z = _kw2.pop("z_m")
    _d = _kw2.pop("df_hz")
    _conds()
    _res = invert_force_curve(_z, _d, f0_hz=F0_HZ, k_n_per_m=K_N_PER_M, **_kw2)
    INVERT.append({
        "case": _name,
        "z_m": _plain(_z), "df_hz": _plain(_d),
        "f0_hz": F0_HZ, "k_n_per_m": K_N_PER_M,
        "opts": _plain(_kw2),
        "result": _plain(_res),
        "polyfit_cond": _plain(_conds()),
    })


# ──────────────────────────────────────────────────────────────────────────
# 5. `_independent_pair` / `collect_observation` / `assess_atomic_consistency`
# ──────────────────────────────────────────────────────────────────────────
PAIR: "list[dict]" = []
OBS: "list[dict]" = []
CONSISTENCY: "list[dict]" = []

# ⚠️ **帧一律从 `.sxm` 的字节读回来**，不用手里那份 float64 原件。
# 字节是 float32 大端写的，读回来每个数都量化过 —— 而这一族里有 `argmax`、
# 有 `median`、有阈值比较，量化前后**换的是峰不是最后一位**（批 4a 那四次）。
# 第一版这里喂的是原件，于是这一节的答案与技能那一节**对不上**，
# 而两节看起来都「对」。
from mast.io.nanonis_files import read_sxm, sxm_oriented_frames  # noqa: E402


def _frame_from_sxm(key: str) -> np.ndarray:
    fr = sxm_oriented_frames(read_sxm(PATHS[key]), "Z")
    return np.asarray(fr["forward"], dtype=np.float64)


_LAT_FRAMES = {k: _frame_from_sxm(k) for k in
               ["hex_a", "hex_b", "hex_rot", "hex_period", "lat_noise_a", "half_nan_a"]}
for _name, _img in _LAT_FRAMES.items():
    _pk = find_lattice_peaks(_img, LAT_NMPP)
    _span = float(min(_img.shape)) * LAT_NMPP
    _K = _independent_pair(_pk, _span) if _pk.ok else None
    PAIR.append({
        "case": _name, "sxm": _name, "nm_per_px": LAT_NMPP, "span_nm": _span,
        "peaks_ok": bool(_pk.ok), "reason": _pk.reason or "",
        "n_peaks": int(_pk.n_peaks),
        "pair": None if _K is None else _plain([list(_K[0]), list(_K[1])]),
    })
    _o = collect_observation(_img, LAT_NMPP, 0.0, label=_name)
    OBS.append({
        "case": _name, "sxm": _name,
        "observation": None if _o is None else _plain({
            "angle_deg": _o.angle_deg, "k1": list(_o.K1), "k2": list(_o.K2),
            "period_mean_nm": _o.period_mean_nm, "period_spread": _o.period_spread,
            "lattice_angle_deg": _o.lattice_angle_deg, "label": _o.label,
            "nm_per_px": _o.nm_per_px, "line_time_s": _o.line_time_s,
        }),
    })

for _name, (_keys, _angles) in {
    "consistent": (["hex_a", "hex_b"], [0.0, 0.0]),
    "consistent_rotated": (["hex_a", "hex_rot"], [0.0, 17.0]),
    # **角度没扣掉扫描角**的那个错版本在这一格上会判 `inconsistent`
    "rotated_but_angles_zero": (["hex_a", "hex_rot"], [0.0, 0.0]),
    "inconsistent_period": (["hex_a", "hex_period"], [0.0, 0.0]),
    "absent": (["lat_noise_a", "lat_noise_a"], [0.0, 0.0]),
    "one_frame": (["hex_a"], [0.0]),
    "no_usable_frame": (["half_nan_a", "half_nan_a"], [0.0, 0.0]),
    "one_lattice_two_noise": (["hex_a", "lat_noise_a", "lat_noise_a"], [0.0, 0.0, 0.0]),
    "one_lattice_one_unusable": (["hex_a", "half_nan_a"], [0.0, 0.0]),
    "two_lattice_one_noise": (["hex_a", "hex_b", "lat_noise_a"], [0.0, 0.0, 0.0]),
    # `angles_deg` 给空 ⇒ 全部当 0°（而不是「没有角度就拒绝」）
    "angles_omitted": (["hex_a", "hex_b"], []),
}.items():
    _frames = [_LAT_FRAMES[k] for k in _keys]
    _r = assess_atomic_consistency(_frames, LAT_NMPP, angles_deg=_angles)
    CONSISTENCY.append({
        "case": _name, "frames": list(_keys), "angles_deg": list(_angles),
        "nm_per_px": LAT_NMPP, "result": _plain(_r),
    })


# ──────────────────────────────────────────────────────────────────────────
# 6. 四个技能 —— **旧仓真跑一遍**
# ──────────────────────────────────────────────────────────────────────────
SKILLS: "dict[str, list]" = {}


def run_skill(name: str, skill: Any, cases: "list[tuple[str, dict]]") -> None:
    rows = []
    for case, params in cases:
        _conds()
        res = skill.execute(None, dict(params))
        rows.append({
            "case": case, "params": _plain(params),
            "success": bool(res.success), "error": res.error or "",
            "summary": res.summary or "", "data": _plain(res.data or {}),
            "polyfit_cond": _plain(_conds()),
        })
    SKILLS[name] = rows


run_skill("AssessTipSharpness", AssessTipSharpness(), [
    ("measured", {"scan_path": PATHS["step"], "channel": "Z"}),
    ("sharp", {"scan_path": PATHS["step"], "channel": "Z", "sharp_edge_nm": 1.2}),
    ("blunt", {"scan_path": PATHS["step"], "channel": "Z", "sharp_edge_nm": 0.4}),
    # 阈值比 2×nm_per_px（0.3125 nm）还小 ⇒ `unresolved`，**不是**「不合格」
    ("unresolved", {"scan_path": PATHS["step"], "channel": "Z", "sharp_edge_nm": 0.2}),
    ("broad_edge", {"scan_path": PATHS["step_broad"], "channel": "Z", "sharp_edge_nm": 1.2}),
    ("fwd_only", {"scan_path": PATHS["step_fwd_only"], "channel": "Z"}),
    # 没有像素标度 ⇒ 阈值判不了采样极限，但**照样出数**（edge_resolution_nm 为 null）
    ("no_scale", {"scan_path": PATHS["step_no_scale"], "channel": "Z", "sharp_edge_nm": 1.2}),
    ("no_step", {"scan_path": PATHS["tip_noise"], "channel": "Z", "sharp_edge_nm": 1.2}),
    ("dead_flat", {"scan_path": PATHS["dead_flat"], "channel": "Z"}),
    ("plane_big", {"scan_path": PATHS["plane_big"], "channel": "Z"}),
    # 指名的通道没有 ⇒ 退回文件里的第一个通道（旧行为）
    ("fallback_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
    ("missing_file", {"scan_path": missing_path("nope.sxm"), "channel": "Z"}),
])

run_skill("AssessTipFromSpectrum", AssessTipFromSpectrum(), [
    ("iz_clean_default", {"dat_path": PATHS["iz_clean"]}),
    ("iz_clean_all_gates", {"dat_path": PATHS["iz_clean"], "min_fit_r2": 0.95,
                            "max_jumps": 0, "barrier_ev_min": 3.0, "barrier_ev_max": 8.0}),
    ("iz_jump", {"dat_path": PATHS["iz_jump"], "max_jumps": 0}),
    ("iz_low_barrier", {"dat_path": PATHS["iz_lowbarrier"], "barrier_ev_min": 3.0,
                        "barrier_ev_max": 8.0}),
    # 拟合站不住 ⇒ 势垒**不参与判决**（那个数是拟合的副产物）
    ("iz_noise", {"dat_path": PATHS["iz_noise"], "barrier_ev_min": 3.0,
                  "barrier_ev_max": 8.0}),
    # 势垒窗关掉（0）⇒ 那一条不 gate
    ("iz_window_off", {"dat_path": PATHS["iz_clean"], "barrier_ev_min": 0.0,
                       "barrier_ev_max": 0.0}),
    ("iv_clean_unrated", {"dat_path": PATHS["iv_clean"], "kind": "iv"}),
    ("iv_clean_gated", {"dat_path": PATHS["iv_clean"], "kind": "iv", "max_jumps": 0,
                        "min_smoothness": 0.5, "min_symmetry": 0.9}),
    ("iv_spike", {"dat_path": PATHS["iv_spike"], "kind": "iv", "max_jumps": 0}),
    ("iv_gap", {"dat_path": PATHS["iv_gap"], "kind": "iv", "min_symmetry": 0.9}),
    ("iv_asym", {"dat_path": PATHS["iv_asym"], "kind": "iv", "min_symmetry": 0.99}),
    ("header_lies", {"dat_path": PATHS["iv_header_lies"]}),
    # `kind` 指定成 iv，而这份文件里根本没有偏压列
    ("forced_iv_no_bias", {"dat_path": PATHS["iv_header_lies"], "kind": "iv"}),
    ("no_current_column", {"dat_path": PATHS["dat_no_current"]}),
    ("no_sweep_column", {"dat_path": PATHS["dat_no_sweep"]}),
    ("empty_data", {"dat_path": PATHS["dat_empty"]}),
    ("missing_file", {"dat_path": missing_path("nope.dat")}),
])

run_skill("InvertForceSaderJarvis", InvertForceSaderJarvis(), [
    ("well", {"dat_path": PATHS["fz_well"], "f0_hz": F0_HZ, "k_n_per_m": K_N_PER_M,
              "amplitude_m": 30e-12}),
    # f0 从头取、振幅从**列**取、k 从参数来 —— 三个来源各走一档
    ("sources_mixed", {"dat_path": PATHS["fz_well"], "k_n_per_m": K_N_PER_M}),
    ("amp_from_header", {"dat_path": PATHS["fz_well_hdr_amp"], "k_n_per_m": K_N_PER_M}),
    ("missing_k", {"dat_path": PATHS["fz_well"], "f0_hz": F0_HZ, "amplitude_m": 30e-12}),
    ("missing_f0_and_k", {"dat_path": PATHS["fz_no_f0"], "amplitude_m": 30e-12}),
    ("large_amplitude", {"dat_path": PATHS["fz_well"], "f0_hz": F0_HZ,
                         "k_n_per_m": K_N_PER_M, "amplitude_m": 500e-12}),
    ("with_background", {"dat_path": PATHS["fz_well"], "f0_hz": F0_HZ,
                         "k_n_per_m": K_N_PER_M, "amplitude_m": 30e-12,
                         "background_dat_path": PATHS["fz_background"]}),
    ("background_missing_file", {"dat_path": PATHS["fz_well"], "f0_hz": F0_HZ,
                                 "k_n_per_m": K_N_PER_M, "amplitude_m": 30e-12,
                                 "background_dat_path": missing_path("nope.dat")}),
    ("smoothed", {"dat_path": PATHS["fz_well"], "f0_hz": F0_HZ, "k_n_per_m": K_N_PER_M,
                  "amplitude_m": 30e-12, "smooth_points": 9}),
    ("edge_minimum", {"dat_path": PATHS["fz_edge"], "f0_hz": F0_HZ,
                      "k_n_per_m": K_N_PER_M, "amplitude_m": 30e-12}),
    ("too_few_points", {"dat_path": PATHS["fz_short"], "f0_hz": F0_HZ,
                        "k_n_per_m": K_N_PER_M, "amplitude_m": 30e-12}),
    ("flat", {"dat_path": PATHS["fz_flat"], "f0_hz": F0_HZ, "k_n_per_m": K_N_PER_M,
              "amplitude_m": 30e-12}),
    ("no_df_column", {"dat_path": PATHS["fz_no_df"], "f0_hz": F0_HZ,
                      "k_n_per_m": K_N_PER_M, "amplitude_m": 30e-12}),
    ("slow_decay_ok", {"dat_path": PATHS["fz_slow"], "f0_hz": F0_HZ,
                       "k_n_per_m": K_N_PER_M, "amplitude_m": 3e-10}),
    ("slow_decay_undecidable", {"dat_path": PATHS["fz_slow"], "f0_hz": F0_HZ,
                                "k_n_per_m": K_N_PER_M, "amplitude_m": 1e-9}),
    ("slow_decay_large_amp", {"dat_path": PATHS["fz_slow"], "f0_hz": F0_HZ,
                              "k_n_per_m": K_N_PER_M, "amplitude_m": 3e-9}),
    ("explicit_columns", {"dat_path": PATHS["fz_well"], "f0_hz": F0_HZ,
                          "k_n_per_m": K_N_PER_M, "amplitude_m": 30e-12,
                          "z_column": "Z rel (m)", "df_column": "Frequency Shift (Hz)"}),
    ("missing_file", {"dat_path": missing_path("nope.dat")}),
])

run_skill("AssessAtomicConsistency", AssessAtomicConsistency(), [
    ("consistent", {"scan_paths": f"{PATHS['hex_a']},{PATHS['hex_b']}", "channel": "Z"}),
    ("consistent_rotated", {"scan_paths": f"{PATHS['hex_a']},{PATHS['hex_rot']}",
                            "channel": "Z"}),
    ("inconsistent_period", {"scan_paths": f"{PATHS['hex_a']},{PATHS['hex_period']}",
                             "channel": "Z"}),
    ("absent", {"scan_paths": f"{PATHS['lat_noise_a']},{PATHS['lat_noise_b']}",
                "channel": "Z"}),
    ("no_usable_frame", {"scan_paths": f"{PATHS['half_nan_a']},{PATHS['half_nan_b']}",
                         "channel": "Z"}),
    ("one_lattice_two_noise", {"scan_paths":
                               f"{PATHS['hex_a']},{PATHS['lat_noise_a']},{PATHS['lat_noise_b']}",
                               "channel": "Z"}),
    ("one_lattice_one_unusable", {"scan_paths": f"{PATHS['hex_a']},{PATHS['half_nan_a']}",
                                  "channel": "Z"}),
    ("two_lattice_one_noise", {"scan_paths":
                               f"{PATHS['hex_a']},{PATHS['hex_b']},{PATHS['lat_noise_a']}",
                               "channel": "Z"}),
    ("scale_mismatch", {"scan_paths": f"{PATHS['hex_a']},{PATHS['hex_coarse']}",
                        "channel": "Z"}),
    ("no_angle_header", {"scan_paths": f"{PATHS['hex_a']},{PATHS['hex_no_angle']}",
                         "channel": "Z"}),
    ("no_scale", {"scan_paths": f"{PATHS['hex_a']},{PATHS['lat_no_scale']}", "channel": "Z"}),
    ("missing_file", {"scan_paths": f"{PATHS['hex_a']},{missing_path('nope.sxm')}",
                      "channel": "Z"}),
    ("one_path", {"scan_paths": PATHS["hex_a"], "channel": "Z"}),
    ("quoted_paths", {"scan_paths": f'"{PATHS["hex_a"]}" , "{PATHS["hex_b"]}"',
                      "channel": "Z"}),
    ("no_channel", {"scan_paths": f"{PATHS['hex_a']},{PATHS['current_only']}",
                    "channel": "Z"}),
])


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_batch6c.py 生成 —— 旧仓 tip_metrics / "
                 "spectroscopy / force_inversion / lattice_multiframe 与四个技能真跑一遍。"
                 "帧与谱都是合成的（闭式公式，零随机数），技能那一层录的是文件的**字节**，"
                 "读法归旧仓。`polyfit_cond` 是每一格里 np.polyfit 的**列缩放后**设计阵的"
                 "条件数，容差用得上它。",
        "versions": {"numpy": np.__version__, "scipy": __import__("scipy").__version__},
        "sxm_files": {k: base64.b64encode(v).decode("ascii")
                      for k, v in FILES.items() if not k.startswith(("iz_", "iv_", "fz_", "dat_"))},
        "dat_files": {k: base64.b64encode(v).decode("ascii")
                      for k, v in FILES.items() if k.startswith(("iz_", "iv_", "fz_", "dat_"))},
        "edge_resolution": _plain(EDGE),
        "fwd_bwd_instability": _plain(INSTAB),
        "assess_iz": _plain(IZ),
        "assess_iv": _plain(IV),
        "sader_jarvis": _plain(SJ),
        "invert_force_curve": _plain(INVERT),
        "independent_pair": _plain(PAIR),
        "collect_observation": _plain(OBS),
        "assess_atomic_consistency": _plain(CONSISTENCY),
        "skills": _plain(SKILLS),
    }
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    for tmp in (TMP, _ROOT):
        text = text.replace(json.dumps(tmp)[1:-1], "<tmp>")
        text = text.replace(tmp.replace("\\", "/"), "<tmp>")
    text = text.replace("<tmp>/artifacts/force_inversion", "<artifacts>")
    text = re.sub(r"\[WinError [^\"]*", "<oserror>", text)
    text = re.sub(r"\[Errno [^\"]*", "<oserror>", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((text + "\n").encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(doc) - 2} 节 · {kb:.0f} KB")
    for name, rows in SKILLS.items():
        verdicts = [r["data"].get("verdict", "—") if isinstance(r["data"], dict) else "—"
                    for r in rows]
        print(f"   {name}: {verdicts}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
