r"""批 7a-3 的金样 —— `kde_layers` / `_hist_modes` / `_local_plane_rms` /
CPython 的 `random`，外加 `FindFlatRegion` 与 `BiasWiggle` **旧仓真跑一遍**。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_batch7a3.py

## 为什么要单开一台

`skill_traces.json` 的通用驱动器对这两个技能各自照不到一整半：

* `FindFlatRegion` 的 `_params_for` 给不出一条真实的 `.sxm` 路径 ⇒ 它在那一份里
  只录得到「文件不存在」那一支。十一个参数、两次不同步长的扫描、三条失败路径、
  `count > 1` 的多落点 —— **一条都没被验到**；
* `BiasWiggle` 每个动词只拿得到一个**常数**回包，于是电流跳闸、`Bias_Set` 失败、
  反馈关着、读不到起点这四条全走不到，而随机数与墙钟这两样在那份驱动器里
  也不是用例能控的。

## 四条纪律

1. **输入与答案一起录**，合成用闭式公式（sin-hash），零随机数 ⇒ 重跑逐字节相同；
2. 墙钟与随机数一概不进：时间桩与 `export_batch5b.py` / `export_skill_traces.py`
   **同一套**（1e6 秒起、每读一次 +1e-3、`sleep` 往前拨）；
3. **脚本本身进金样**：TS 那侧拿同一份脚本喂同一个技能，不是「各自造一份差不多的输入」；
4. `.sxm` **一律录字节**，读法归旧仓。

## 两处需要说明的合成选择

### ① 台阶是**一像素锐变**，不是抹开的

`plane_subtract` 是 RANSAC（`np.random.default_rng(42)` vs 本仓 `Xoshiro128`，
D-VISION-1），两边抽到的三点子集不同 ⇒ 扣掉的平面差 pm 量级。这件事对
`_local_plane_rms` **没有影响**（窗内再拟合一次平面，数学上把任何平面消掉），
但它会动 `kde_layers` 的层分界。所以台面之间用 **240 pm 的锐台阶**：
没有任何像素落在分界（120 pm）附近，几个 pm 的平面差动不了一个标签。

⇒ 受 RANSAC 影响的只剩 `frame_rms_m` / `rms_ratio_to_frame` 两格
（整帧 std 确实由那个平面决定），它们按 `RANSAC_REL_TOL` 比。

### ② `kde_layers` / `_hist_modes` / `_local_plane_rms` 三节**直接喂数组**

不经 `.sxm`、不经 RANSAC —— 那三节要的是这三个函数自己，逐位可比。
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

from _paths import require_mast_root
from typing import Any

_ROOT = tempfile.mkdtemp(prefix="mast-7a3-root-")
os.environ.setdefault("MAST2_PROJECT_ROOT", _ROOT)

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "batch7a3.json"
MAST = require_mast_root()
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

# ── 时间桩：与 `export_batch5b.py` **同一套** ──────────────────────────────
import time as _time  # noqa: E402

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


def _fake_time() -> float:
    return 1_700_000_000.0


_time.time = _fake_time            # type: ignore[assignment]
_time.sleep = _fake_sleep          # type: ignore[assignment]
_time.monotonic = _fake_monotonic  # type: ignore[assignment]
_time.perf_counter = _fake_monotonic  # type: ignore[assignment]

import random as _random  # noqa: E402
import numpy as np  # noqa: E402
from mast.core.types import NanonisCallRecord  # noqa: E402


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
# 1. 合成器 —— 闭式，零随机数
# ──────────────────────────────────────────────────────────────────────────


def _hash_noise(ny: int, nx: int, amp: float, salt: float) -> np.ndarray:
    """与 `export_batch6c.py` / `export_analysis.py` 同一条 sin-hash。"""
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    v = np.sin(i * 12.9898 + j * 78.233 + salt * 37.719) * 43758.5453123
    return amp * (2.0 * (v - np.floor(v)) - 1.0)


#: 平区帧的边长与视野。48 nm / 96 px ⇒ **0.5 nm/px**。
#: `window_fraction=0.2` ⇒ 19 px（**< 24，踩得到 `scale_caveat`**）；
#: `0.25` ⇒ 24 px（刚好踩不到）—— 那道闸的两侧各有一格。
FR_PX = 96
FR_WIDTH_M = 4.8e-8

#: 单原子台阶的高度（Au(111) 是 236 pm，这里取整到 240 pm）。
#: 它比 `usable_rms_m`（25 pm）大一个量级 —— `same_terrace` 分得开的前提。
STEP_M = 240e-12


def _tilt(ny: int, nx: int, dz_row: float, dz_col: float, z0: float = 1.0e-9) -> np.ndarray:
    return (z0
            + dz_row * np.arange(ny, dtype=np.float64)[:, None]
            + dz_col * np.arange(nx, dtype=np.float64)[None, :])


def frame_flat(noise: float = 4e-12, salt: float = 3.0) -> np.ndarray:
    """一整块平地：缓倾斜 + 均匀噪声。窗内局部残差 ≈ `noise/√3` ≈ 2.3 pm。"""
    return _tilt(FR_PX, FR_PX, 1.5e-12, 0.9e-12) + _hash_noise(FR_PX, FR_PX, noise, salt)


def frame_terraces(noise: float = 4e-12, salt: float = 5.0) -> np.ndarray:
    """**两个台面，一像素锐台阶**。上 40 行低、下 56 行高 —— 最大台面唯一。

    「最大台面唯一」是 RANSAC 那一侧的要求（`vision/plane.ts` 的原话：并列时
    `count > best_count` 保留的是**先抽到的那个**，而「先抽到谁」正是两边不同的
    那件事）。40 / 56 不并列。
    """
    z = frame_flat(noise, salt)
    z[40:, :] += STEP_M
    return z


def frame_terraces_thin() -> np.ndarray:
    """**条纹台面**：每 10 行换一层。24 px 的窗装不进任何一个台面，
    但 0.25 档的 6 px…… 6 < 8 不试，**8 px 的那一档（0.35 ⇒ 8 px）装得下**。

    ⇒ 这一格是「全跨台阶 ⇒ **换小一档就装得下**」那句话的入口。
    """
    z = frame_flat(4e-12, 7.0)
    band = (np.arange(FR_PX) // 10) % 2
    z += (band[:, None] * STEP_M)
    return z


def frame_terraces_micro() -> np.ndarray:
    """每 3 行换一层 —— **连 8 px 的窗都装不下**（0.25 档的 6 px 更不用试）。

    ⇒ 这一格是同一条路上的另一句话：「这块区域的台面比要求的窗口还窄」。
    两句话各有一格，这道闸的两侧才都有输入。
    """
    z = frame_flat(4e-12, 59.0)
    band = (np.arange(FR_PX) // 3) % 2
    z += (band[:, None] * STEP_M)
    return z


def frame_terraces_mid() -> np.ndarray:
    """每 28 行换一层：24 px 的窗跨台阶，**18 px（0.75×）的窗装得下**。

    于是 `smaller_windows_same_terrace` 的第一格就 `>= 0.98` 并 `break` ——
    「换小一档就装得下」那句话有输入。
    """
    z = frame_flat(4e-12, 11.0)
    band = (np.arange(FR_PX) // 28) % 2
    z += (band[:, None] * STEP_M)
    return z


def frame_rough(amp: float = 90e-12, salt: float = 13.0) -> np.ndarray:
    """整帧都糙：任何尺度的窗都过不了 25 pm 线 ⇒ 「缩小窗口也没用」。"""
    return _tilt(FR_PX, FR_PX, 1.5e-12, 0.9e-12) + _hash_noise(FR_PX, FR_PX, amp, salt)


#: 「糙」的幅值。**200 pm 不是随便取的**：24 px 的窗只要切进糙区一圈（3 px），
#: 糙像素占比就有 23%，残差 `√(0.23) × 200/√3 ≈ 55 pm` —— 稳稳在 25 pm 线的
#: 另一侧。第一版用 70 pm，那时**一个只有 77% 干净的窗也能给出 19 pm**，
#: 于是「细扫才找得到」那道闸分辨不出两种候选（粗扫就过线了）。
ROUGH_AMP = 200e-12


def frame_rough_with_patch() -> np.ndarray:
    """整帧糙，**但左上角 14×14 是干净的** —— 「换小一档就有」那句话的入口。

    24 px 的窗（`window_fraction=0.25`）无论落在哪都套不住那块干净区
    （14 < 24）⇒ 粗扫细扫都过不了线；而「换小一档」那个探测的 0.5 档
    （12 px）**整窗落得进去**（步长 `12//4 = 3`，(0,0) 就是一个落点）。
    """
    z = frame_rough(ROUGH_AMP, 17.0)
    z[0:14, 0:14] = _tilt(14, 14, 1.5e-12, 0.9e-12) + _hash_noise(14, 14, 4e-12, 19.0)
    return z


def frame_fine_only() -> np.ndarray:
    """**粗扫说「没有」，细扫说「有」** —— ⭐ 那条「说没有必须贵」的唯一入口。

    干净区恰好 24 px，放在 `[15:39, 15:39]`：
    `window_fraction=0.25` ⇒ 窗 24 px；粗步长 `stride_fraction=0.5` ⇒ 12 px，
    落点 {0,12,24,36,48,60,72} 里**没有 15** ⇒ 粗扫的每一个窗都切进糙区；
    细步长 `24//8 = 3`，落点 {0,3,…,72} 里**有 15** ⇒ 细扫整窗落得进去。
    """
    z = frame_rough(ROUGH_AMP, 23.0)
    z[15:39, 15:39] = _tilt(24, 24, 1.5e-12, 0.9e-12) + _hash_noise(24, 24, 4e-12, 29.0)
    return z


def frame_dead_flat() -> np.ndarray:
    """**恒定值** —— `judge_frame` 第一档拒判。"""
    return np.full((FR_PX, FR_PX), 1.0e-9, dtype=np.float64)


def frame_half_nan() -> np.ndarray:
    """下半帧 NaN —— 窗内 NaN 上限那道闸的入口（有效点 < 50% 的窗被跳过）。"""
    z = frame_flat(4e-12, 31.0)
    z[56:, :] = np.nan
    return z


# ── `.sxm` 字节（形状照 `export_batch6c.py`）──────────────────────────────


def sxm_bytes(frames: "list[tuple[str, str, list[np.ndarray]]]", *, nx: int, ny: int,
              width_m: float, height_m: float | None = None, with_range: bool = True,
              scan_dir: str = "down", scan_angle: float = 0.0,
              offset: "tuple[float, float]" = (0.0, 0.0)) -> bytes:
    h_m = width_m if height_m is None else height_m
    rng = f"{width_m:>22.6E}{h_m:>22.6E}"
    off = f"{offset[0]:>22.6E}{offset[1]:>22.6E}"
    lines: "list[str]" = [
        ":NANONIS_VERSION:", "2",
        ":SCANIT_TYPE:", "              FLOAT            MSBFIRST",
        ":REC_DATE:", " 20.09.2026",
        ":REC_TIME:", "12:34:56",
        ":ACQ_TIME:", "          12.8",
        ":BIAS:", "\t20.0E-3",
        ":Z-CONTROLLER>Setpoint:", "\t500.0E-12",
        ":SCAN_PIXELS:", f"        {nx}         {ny}",
        ":SCAN_RANGE:", rng,
        ":SCAN_OFFSET:", off,
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


TMP = tempfile.mkdtemp(prefix="mast-7a3-files-")
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


def _fwd(z: np.ndarray) -> "list[tuple[str, str, list[np.ndarray]]]":
    return [("Z", "fwd", [z])]


write_file("flat", sxm_bytes(_fwd(frame_flat()), nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
write_file("terraces", sxm_bytes(_fwd(frame_terraces()), nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
write_file("terraces_thin", sxm_bytes(_fwd(frame_terraces_thin()), nx=FR_PX, ny=FR_PX,
                                      width_m=FR_WIDTH_M))
write_file("terraces_micro", sxm_bytes(_fwd(frame_terraces_micro()), nx=FR_PX, ny=FR_PX,
                                       width_m=FR_WIDTH_M))
write_file("terraces_mid", sxm_bytes(_fwd(frame_terraces_mid()), nx=FR_PX, ny=FR_PX,
                                     width_m=FR_WIDTH_M))
write_file("rough", sxm_bytes(_fwd(frame_rough()), nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
write_file("rough_patch", sxm_bytes(_fwd(frame_rough_with_patch()), nx=FR_PX, ny=FR_PX,
                                    width_m=FR_WIDTH_M))
write_file("fine_only", sxm_bytes(_fwd(frame_fine_only()), nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
write_file("dead_flat", sxm_bytes(_fwd(frame_dead_flat()), nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
write_file("half_nan", sxm_bytes(_fwd(frame_half_nan()), nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
# 转过 30° 的帧：`px_to_m` 的旋转那一步的唯一入口。
write_file("rot30", sxm_bytes(_fwd(frame_flat(4e-12, 37.0)), nx=FR_PX, ny=FR_PX,
                              width_m=FR_WIDTH_M, scan_angle=30.0, offset=(1.0e-7, -5.0e-8)))
# 头里**没有** `:SCAN_RANGE:` ⇒ `parse_xy_meta` 给 None，走那条 header 兜底。
write_file("no_range", sxm_bytes(_fwd(frame_flat(4e-12, 41.0)), nx=FR_PX, ny=FR_PX,
                                 width_m=FR_WIDTH_M, with_range=False))
# 只有 Current 通道 ⇒ 指名 `Z` 落空，退回第一个通道。
write_file("current_only", sxm_bytes([("Current", "fwd", [frame_flat(4e-12, 43.0) * 1e-3])],
                                     nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
# 一张很小的帧（视野 8 nm）⇒ `min_window_m` 那条显式失败。
write_file("tiny", sxm_bytes(_fwd(frame_flat(4e-12, 47.0)[:32, :32]), nx=32, ny=32,
                             width_m=8.0e-9))
# `up` 帧：`sxm_oriented_frames` 会上下翻正，于是 y 不差半帧。
write_file("flat_up", sxm_bytes(_fwd(frame_flat(4e-12, 53.0)), nx=FR_PX, ny=FR_PX,
                                width_m=FR_WIDTH_M, scan_dir="up"))
write_file("not_sxm", b"this is not a nanonis file\n", ext="sxm")
# 只有**反扫**块 ⇒ `sxm_oriented_frames` 的 `forward` 是 None，而退回第一个通道
# 之后仍然是 None ⇒ 「no forward/backward frame in selected channel」那一支。
write_file("bwd_only", sxm_bytes([("Z", "bwd", [frame_flat(4e-12, 61.0)[:, ::-1]])],
                                 nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))
# 一个通道都没有 ⇒ 「no usable channel in …」那一支（`read_sxm` 认不认这张，
# 由它自己说了算 —— 两种结局都是一条判据，录下来的是它真的那一条）。
write_file("no_channel", sxm_bytes([], nx=FR_PX, ny=FR_PX, width_m=FR_WIDTH_M))


# ──────────────────────────────────────────────────────────────────────────
# 1b. numpy 原语 —— `linspace` / `digitize` / 按边界数组的 `histogram` / 二维 `gradient`
#
# 这四件在 `kde_layers` 那条链上是**中间量**，只靠它验等于把「挑错了格子」
# 藏在一个被平滑过的直方图后面。所以各自直接录一格。
# ──────────────────────────────────────────────────────────────────────────
NPG: "dict[str, Any]" = {}

_LS = [(0.0, 1.0, 5), (-3e-12, 7e-12, 257), (1.0, 1.0, 4), (0.0, 1.0, 1), (2.5, -2.5, 9)]
NPG["linspace"] = [
    {"start": a, "stop": b, "num": n, "out": _plain(np.linspace(a, b, n))}
    for a, b, n in _LS
]

_BINS = [0.0, 1.0, 2.0, 4.0, 8.0]
NPG["digitize"] = [
    {"x": x, "bins": _BINS, "out": int(np.digitize(x, _BINS))}
    # **边界上的那几个**（左闭）与两端外侧
    for x in (-1.0, 0.0, 0.5, 1.0, 1.999, 2.0, 4.0, 7.999, 8.0, 9.0)
]

_EDGES = list(np.linspace(-1.0, 1.0, 9))
_SAMPLES = [-2.0, -1.0, -0.999, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.999, 1.0, 1.5,
            float("nan")]
NPG["histogram_edges"] = [{
    "edges": _plain(_EDGES), "samples": _plain(_SAMPLES),
    "counts": _plain(np.histogram(np.asarray(_SAMPLES, np.float64),
                                  bins=np.asarray(_EDGES, np.float64))[0]),
}]

#: `np.argsort(v)[::-1]` —— `_hist_modes` 取「prominence 最大的前 max_levels 个」
#: 走的就是它。**每一格的值两两不同**：并列时 numpy 的 quicksort 与本仓的稳定排序
#: 给出不同的排列，而那是一种掷骰子，不是可以容差掉的东西（批 6c §9②）。
NPG["argsort_desc"] = [
    {"v": _plain(list(v)), "out": _plain(np.argsort(np.asarray(v))[::-1])}
    for v in ([3.0, 1.0, 2.0], [0.5], [1.0, 2.0, 3.0, 4.0, 5.0],
              [-2.5, 7.25, 0.125, -9.0, 4.0], [10.0, 9.0, 8.0, 7.0, 6.0, 5.0,
                                               4.0, 3.0, 2.0, 1.0])
]

_G1 = np.asarray([[1.0, 2.0, 4.0], [8.0, 16.0, 32.0], [64.0, 128.0, 256.0]])
_G2 = np.asarray([[0.0, 1.0], [3.0, 7.0]])
_G3 = _hash_noise(5, 7, 1.0, 3.0) + _tilt(5, 7, 0.25, -0.5, 0.0)
NPG["gradient2d"] = [
    {"rows": int(m.shape[0]), "cols": int(m.shape[1]), "m": _plain(m),
     "gy": _plain(np.gradient(m)[0]), "gx": _plain(np.gradient(m)[1])}
    for m in (_G1, _G2, _G3)
]


# ──────────────────────────────────────────────────────────────────────────
# 2. `_hist_modes` —— 一维样本 → 层峰
# ──────────────────────────────────────────────────────────────────────────
from mast.vision.seg_scale_adaptive import _hist_modes, kde_layers  # noqa: E402
from mast.skills.builtins.flat_region import _local_plane_rms  # noqa: E402

HIST: "list[dict]" = []


def _bump(centre: float, n: int, width: float, salt: float) -> "list[float]":
    """一堆围绕 `centre` 的样本（三角分布的闭式版本，零随机数）。"""
    k = np.arange(n, dtype=np.float64)
    u = (np.sin(k * 12.9898 + salt * 37.719) * 43758.5453123)
    u = 2.0 * (u - np.floor(u)) - 1.0
    return list(centre + width * u)


def run_hist(case: str, sel: "list[float]", sig_n: float, **kw: Any) -> None:
    peaks = _hist_modes(np.asarray(sel, np.float64), sig_n, **kw)
    HIST.append({"case": case, "sel": _plain([float(x) for x in sel]),
                 "sig_n": sig_n, "opts": _plain(kw), "peaks": _plain(peaks)})


_SIG = 3e-12
run_hist("one_layer", _bump(0.0, 900, 8e-12, 1.0), _SIG)
run_hist("two_layers", _bump(0.0, 700, 8e-12, 2.0) + _bump(240e-12, 500, 8e-12, 3.0), _SIG)
run_hist("three_layers",
         _bump(0.0, 600, 8e-12, 4.0) + _bump(240e-12, 500, 8e-12, 5.0)
         + _bump(480e-12, 400, 8e-12, 6.0), _SIG)
# `hi <= lo`：第 0.5 与第 99.5 百分位相等 ⇒ 返回 `[median(sel)]`
run_hist("constant", [7e-12] * 400, _SIG)
# **谷太浅 ⇒ 合并**：两个峰只隔 40 pm，中间的谷压不下去
run_hist("valley_merged", _bump(0.0, 700, 26e-12, 7.0) + _bump(40e-12, 690, 26e-12, 8.0), _SIG)
# 同一份样本，`valley_rel` 调到 0.2 ⇒ **不合并**。这道闸的两侧各一格。
run_hist("valley_kept", _bump(0.0, 700, 26e-12, 7.0) + _bump(40e-12, 690, 26e-12, 8.0), _SIG,
         valley_rel=0.2)
# `min_sep` 显式给（不走 `4 × sig_n`）：把间隔拉大到能把两个峰并掉
run_hist("min_sep_explicit",
         _bump(0.0, 600, 8e-12, 9.0) + _bump(240e-12, 500, 8e-12, 10.0), _SIG, min_sep=200e-12)
# `prom` 调高 ⇒ 矮峰出局
run_hist("prom_high",
         _bump(0.0, 900, 8e-12, 11.0) + _bump(240e-12, 60, 8e-12, 12.0), _SIG, prom=0.30)
run_hist("prom_low",
         _bump(0.0, 900, 8e-12, 11.0) + _bump(240e-12, 60, 8e-12, 12.0), _SIG, prom=0.02)
# **十层**，`max_levels=3` ⇒ 截断闸有输入。各层样本数两两不同 ⇒ prominence 不并列
_many: "list[float]" = []
for _k in range(10):
    _many += _bump(_k * 240e-12, 400 + 37 * _k, 8e-12, 13.0 + _k)
run_hist("many_layers", _many, _SIG)
run_hist("many_layers_cut3", _many, _SIG, max_levels=3)


# ──────────────────────────────────────────────────────────────────────────
# 3. `kde_layers` —— 二维 coarse → (峰, 标签)
# ──────────────────────────────────────────────────────────────────────────
KDE: "list[dict]" = []

KDE_PX = 32


def coarse_terraces(bands: "list[int]", step: float = STEP_M, noise: float = 4e-12,
                    salt: float = 3.0, ny: int = KDE_PX, nx: int = KDE_PX) -> np.ndarray:
    """`bands[r]` 给第 r 行所在的层号。已经是**扣过平面**的形貌（均值附近）。"""
    z = _hash_noise(ny, nx, noise, salt)
    z += np.asarray(bands, dtype=np.float64)[:, None] * step
    return z - float(np.mean(z))


def run_kde(case: str, coarse: np.ndarray, sig_n: float, **kw: Any) -> None:
    peaks, lab = kde_layers(coarse, sig_n, **kw)
    KDE.append({
        "case": case,
        "rows": int(coarse.shape[0]), "cols": int(coarse.shape[1]),
        "coarse": _plain(coarse), "sig_n": sig_n, "opts": _plain(kw),
        "peaks": _plain(peaks),
        "labels": _plain(np.asarray(lab, dtype=np.int64).ravel()),
        "n_unique": int(len(np.unique(lab))),
    })


def coarse_pepper(bands: "list[int]", every: int = 37, salt: float = 17.0) -> np.ndarray:
    """两层台面 + **椒盐**：每隔 `every` 个像素把一个点丢到另一层去。

    这一格是 `ndi.median_filter(lab, size=5)` 的**唯一**入口。没有它，合成的
    层标签干净到中值滤波一个像素都不改 —— 那道闸就分辨不出两种候选
    （批 7a-3 的变异演练第一轮当场逼出来的：那条变异是绿的）。

    真机上这些孤立像素来自台阶边缘的抖动与单个吸附物，而它们正是
    「每一个跨界的窗都被判跨台阶」的来源。
    """
    z = coarse_terraces(bands, salt=salt)
    flat = z.ravel()
    for k in range(0, flat.size, every):
        # 丢到**对面**那一层：低的抬高一个台阶、高的压低一个台阶。
        flat[k] += STEP_M if bands[k // z.shape[1]] == 0 else -STEP_M
    return flat.reshape(z.shape)


run_kde("single", coarse_terraces([0] * KDE_PX, salt=3.0), _SIG)
run_kde("pepper", coarse_pepper([0] * 12 + [1] * 20), _SIG)
run_kde("two", coarse_terraces([0] * 12 + [1] * 20, salt=5.0), _SIG)
run_kde("three", coarse_terraces([0] * 10 + [1] * 8 + [2] * 14, salt=7.0), _SIG)
# 每 4 行换一层 ⇒ 梯度低的像素很少，但仍然 >= 100
run_kde("striped", coarse_terraces([(r // 4) % 2 for r in range(KDE_PX)], salt=11.0), _SIG)
# `low_grad_pct` 的两侧：100 = 不筛
run_kde("no_grad_filter", coarse_terraces([0] * 12 + [1] * 20, salt=5.0), _SIG, low_grad_pct=100)
# **低梯度样本 < 100 ⇒ 退回整帧**：8×8 的帧，60% 只有 38 个像素
run_kde("tiny_fallback", coarse_terraces([0] * 4 + [1] * 4, salt=13.0, ny=8, nx=8), _SIG)
# 一张**恒定**的图：`hi <= lo` ⇒ 一个峰 ⇒ 全零标签
run_kde("flat_zero", np.zeros((KDE_PX, KDE_PX), dtype=np.float64), _SIG)


# ──────────────────────────────────────────────────────────────────────────
# 4. `_local_plane_rms` —— 窗内再拟合一次平面
# ──────────────────────────────────────────────────────────────────────────
RMS: "list[dict]" = []


def run_rms(case: str, patch: np.ndarray) -> None:
    r = _local_plane_rms(patch, np)
    RMS.append({
        "case": case, "rows": int(patch.shape[0]), "cols": int(patch.shape[1]),
        "patch": _plain(patch), "rms": None if r is None else float(r),
        "z_span": float(np.nanmax(patch) - np.nanmin(patch)) if np.isfinite(patch).any() else 0.0,
    })


_P = 16
run_rms("plane_noise", _tilt(_P, _P, 3e-12, 2e-12) + _hash_noise(_P, _P, 6e-12, 3.0))
# **纯平面**：残差只剩浮点噪声
run_rms("pure_plane", _tilt(_P, _P, 3e-12, 2e-12))
# 一道台阶横穿：残差被台阶撑起来
_step_patch = _tilt(_P, _P, 3e-12, 2e-12) + _hash_noise(_P, _P, 6e-12, 5.0)
_step_patch[8:, :] += STEP_M
run_rms("crossing_step", _step_patch)
# **有效点不足 12** ⇒ None。
# ⚠️ 这 11 个点必须**不共线**：第一版把它们全放在第 0 行，于是就算把 12 那道门槛
# 拆掉，`lstsq` 也因为设计阵奇异而给 None —— 两种候选同解，那道门槛的变异当场是绿的
# （批 7a-3 的演练第一轮逼出来的）。摆成 4×3 减一个。
_few = np.full((_P, _P), np.nan)
for _k in range(11):
    _few[_k // 4, _k % 4] = 1e-12 * (_k * _k % 7)
run_rms("too_few", _few)
# 恰好 12 点（**边界闭**：12 通过、11 不通过）
_twelve = np.full((_P, _P), np.nan)
for _k in range(12):
    _twelve[_k // 4, _k % 4] = 1e-12 * _k
run_rms("exactly_twelve", _twelve)
# 全 NaN
run_rms("all_nan", np.full((_P, _P), np.nan))
# **共线**的 16 点（都在第 0 行）⇒ 设计阵奇异
_coll = np.full((_P, _P), np.nan)
_coll[0, :] = np.arange(_P, dtype=np.float64) * 1e-12
run_rms("collinear", _coll)


# ──────────────────────────────────────────────────────────────────────────
# 5. CPython 的 `random` —— MT19937 四层
# ──────────────────────────────────────────────────────────────────────────
MT: "list[dict]" = []

for _seed in (1, 7, 42, 12345, 4294967296):
    _r = _random.Random(_seed)
    _raw = [int(_r.getrandbits(32)) for _ in range(8)]
    _r2 = _random.Random(_seed)
    _rand = [float(_r2.random()) for _ in range(6)]
    _r3 = _random.Random(_seed)
    _bits2 = [int(_r3.getrandbits(2)) for _ in range(8)]
    _r4 = _random.Random(_seed)
    _below2 = [int(_r4._randbelow(2)) for _ in range(8)]        # type: ignore[attr-defined]
    _r5 = _random.Random(_seed)
    _below7 = [int(_r5._randbelow(7)) for _ in range(8)]        # type: ignore[attr-defined]
    _r6 = _random.Random(_seed)
    _unif = [float(_r6.uniform(0.004, 0.020)) for _ in range(6)]
    _r7 = _random.Random(_seed)
    _choice = [float(_r7.choice((-1.0, 1.0))) for _ in range(8)]
    # **技能里那一串**：`uniform(lo, hi) * choice((-1, 1))` 交替消耗
    _r8 = _random.Random(_seed)
    _mixed = [float(_r8.uniform(0.004, 0.020) * _r8.choice((-1.0, 1.0))) for _ in range(6)]
    MT.append({
        "seed": _seed, "raw32": _raw, "random": _plain(_rand), "getrandbits2": _bits2,
        "randbelow2": _below2, "randbelow7": _below7, "uniform": _plain(_unif),
        "choice": _plain(_choice), "mixed": _plain(_mixed),
    })


# ──────────────────────────────────────────────────────────────────────────
# 6. `FindFlatRegion` —— 旧仓真跑一遍
# ──────────────────────────────────────────────────────────────────────────
from mast.skills.builtins.flat_region import FindFlatRegion  # noqa: E402
from mast.skills.builtins.bias_wiggle import BiasWiggle  # noqa: E402
from mast.io.nanonis_files import read_sxm, sxm_oriented_frames  # noqa: E402
from mast.vision.tilt import plane_subtract as _tilt_plane_subtract  # noqa: E402

SKILLS: "dict[str, list]" = {}

#: `_parse_excluded` 的逐格（**它排在读文件之前**，所以值得单独一节）。
EXCL: "list[dict]" = []
for _s in ("", "1n,2n;3n,-1n", " ; 100n , -50n ; ", "1n,2n;oops;3n;4n,5n,6n",
           "0,0", "1.2u,-0.5u", ";;;", "  ", "1e-9,2e-9", "nan,0", "inf,0",
           "1 n,2n", "x,y"):
    _pts, _bad = FindFlatRegion._parse_excluded(_s)      # type: ignore[attr-defined]
    EXCL.append({"raw": _s, "points": _plain([list(p) for p in _pts]), "bad": list(_bad)})


def _leveled_span(path: str, channel: str) -> "float | None":
    """这一格里 `leveled` 的 z 量程 —— **`localRmsAbsTol` 的入口**。

    容差的形状是 `k · eps · zSpan`，而 `zSpan` 是一个只有跑过一遍才知道的数
    （同批 6c 的 `polyfit_cond`：容差里唯一的未知数，随金样一起录，
    于是它不再是未知数）。读不动就给 `None`（那一格没有 rms 可比）。
    """
    try:
        scan = read_sxm(path)
        oriented = sxm_oriented_frames(scan, channel)
        img = oriented.get("forward")
        if img is None:
            channels = scan.get("channels", {}) or {}
            first = next(iter(channels), None)
            if first is None:
                return None
            img = sxm_oriented_frames(scan, first).get("forward")
        if img is None:
            return None
        lev = _tilt_plane_subtract(np.asarray(img, dtype=np.float64))
        fin = lev[np.isfinite(lev)]
        return float(np.max(fin) - np.min(fin)) if fin.size else None
    except Exception:  # noqa: BLE001
        return None


def run_skill(name: str, skill: Any, cases: "list[tuple[str, dict]]") -> None:
    rows = []
    for case, params in cases:
        res = skill.execute(None, dict(params))
        row = {
            "case": case, "params": _plain(params),
            "success": bool(res.success), "error": res.error or "",
            "summary": res.summary or "", "data": _plain(res.data or {}),
        }
        if name == "FindFlatRegion":
            row["leveled_span_m"] = _leveled_span(str(params.get("scan_path", "")),
                                                  str(params.get("channel", "Z")))
        rows.append(row)
    SKILLS[name] = rows


run_skill("FindFlatRegion", FindFlatRegion(), [
    # ── 最常见的一条路 ──
    ("flat_default", {"scan_path": PATHS["flat"]}),
    # 窗 24 px（0.25 × 96）⇒ **踩不到** `scale_caveat`；上一格 19 px ⇒ 踩得到
    ("flat_win25", {"scan_path": PATHS["flat"], "window_fraction": 0.25}),
    # `window_fraction=0.05` ⇒ `int(96 × 0.05) = 4`，被 **8 px 的下限**顶上去。
    # 这是那道下限的唯一入口（`min_value` 就是 0.05，再小进不来）。
    ("window_floor_8px", {"scan_path": PATHS["flat"], "window_fraction": 0.05}),
    # 步长细一档：`windows_checked` 变多，最优只会更好
    ("flat_dense", {"scan_path": PATHS["flat"], "window_fraction": 0.25,
                    "stride_fraction": 0.2}),
    # ── 参数校验（排在读文件**之前**）──
    ("bad_exclude", {"scan_path": PATHS["flat"], "exclude_used_spots": "1n,2n;oops;3n"}),
    ("bad_exclude_missing_file", {"scan_path": missing_path("nope.sxm"),
                                  "exclude_used_spots": "zzz"}),
    # ── 文件层 ──
    ("missing_file", {"scan_path": missing_path("nope.sxm")}),
    ("not_sxm", {"scan_path": PATHS["not_sxm"]}),
    ("fallback_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
    ("bwd_only", {"scan_path": PATHS["bwd_only"]}),
    ("no_channel", {"scan_path": PATHS["no_channel"]}),
    # ── 帧可用性 ──
    ("dead_flat", {"scan_path": PATHS["dead_flat"]}),
    # ── 几何 ──
    ("rotated", {"scan_path": PATHS["rot30"], "window_fraction": 0.25}),
    ("no_scan_range", {"scan_path": PATHS["no_range"], "window_fraction": 0.25}),
    ("scan_dir_up", {"scan_path": PATHS["flat_up"], "window_fraction": 0.25}),
    # ── NaN 洞 ──
    ("half_nan", {"scan_path": PATHS["half_nan"], "window_fraction": 0.25}),
    # ── `min_window_m` ──
    ("min_window_too_big", {"scan_path": PATHS["tiny"], "min_window_m": 2.0e-8}),
    ("min_window_bumps_win", {"scan_path": PATHS["flat"], "window_fraction": 0.1,
                              "min_window_m": 2.0e-8}),
    # ── 排除点 ──
    ("exclude_some", {"scan_path": PATHS["flat"], "window_fraction": 0.25,
                      "exclude_used_spots": "0,0", "min_separation_m": 1.0e-8}),
    # `min_separation_m` 缺省 ⇒ 走 `(w+h)/2 × window_fraction`（这一档的唯一入口）；
    # 顺带把 **SI 前缀**那条路也踩上（`100n,-50n` 不是裸数字）
    ("exclude_default_sep", {"scan_path": PATHS["flat"], "window_fraction": 0.25,
                             "exclude_used_spots": "100n,-50n;0,0"}),
    ("exclude_everything", {"scan_path": PATHS["flat"], "window_fraction": 0.25,
                            "exclude_used_spots": "0,0", "min_separation_m": 1.0e-6}),
    # ── 绝对线 ──
    ("too_rough", {"scan_path": PATHS["rough"], "window_fraction": 0.25}),
    ("too_rough_smaller_ok", {"scan_path": PATHS["rough_patch"], "window_fraction": 0.25}),
    # ⭐ 粗扫说「没有」、细扫说「有」
    ("fine_sweep_saves_it", {"scan_path": PATHS["fine_only"], "window_fraction": 0.25}),
    ("usable_rms_override", {"scan_path": PATHS["rough"], "window_fraction": 0.25,
                             "usable_rms_m": 1.0e-9}),
    # ── `same_terrace` ──
    ("same_terrace_ok", {"scan_path": PATHS["terraces"], "window_fraction": 0.25,
                         "same_terrace": True}),
    ("same_terrace_single_layer", {"scan_path": PATHS["flat"], "window_fraction": 0.25,
                                   "same_terrace": True}),
    ("same_terrace_all_cross", {"scan_path": PATHS["terraces_thin"], "window_fraction": 0.25,
                                "same_terrace": True}),
    ("same_terrace_none_fits", {"scan_path": PATHS["terraces_micro"], "window_fraction": 0.25,
                                "same_terrace": True}),
    ("same_terrace_smaller_fits", {"scan_path": PATHS["terraces_mid"], "window_fraction": 0.25,
                                   "same_terrace": True}),
    # ── `count > 1` ──
    ("count_4", {"scan_path": PATHS["flat"], "window_fraction": 0.25, "count": 4}),
    ("count_4_spaced", {"scan_path": PATHS["flat"], "window_fraction": 0.25, "count": 4,
                        "min_site_spacing_m": 2.0e-8}),
    ("count_64_short", {"scan_path": PATHS["flat"], "window_fraction": 0.25, "count": 64,
                        "min_site_spacing_m": 2.0e-8}),
    # **候选里既有过线的也有不过线的**：`fine_only` 上只有 (15,15) 那一个窗干净，
    # 其余 600 多个都在 50 pm 量级。这是「第一个超线就 break」那道闸的唯一入口 ——
    # 在一张整帧都干净的图上，break 与 continue 给的是同一个答案。
    ("count_4_mixed", {"scan_path": PATHS["fine_only"], "window_fraction": 0.25, "count": 4}),
])


# ──────────────────────────────────────────────────────────────────────────
# 7. `BiasWiggle` —— 脚本化上下文
# ──────────────────────────────────────────────────────────────────────────


def _jsonable(v: Any) -> Any:
    if isinstance(v, (str, bool)) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    return str(v)


class _ScriptedContext:
    """每个动词的回答由用例自己给；取完之后**重复最后一个**。

    `abort_after`：`check_abort()` 在**已经记下**这么多次调用之后开始返回 True。
    TS 那侧的夹具用同一个谓词（`calls.length >= abort_after`），于是两边
    在同一拍上中止。
    """

    def __init__(self, verbs: "dict[str, list]", abort_after: "int | None" = None) -> None:
        self._verbs = {k: list(v) for k, v in verbs.items()}
        self._vi: "dict[str, int]" = {}
        self._abort_after = abort_after
        self.calls: "list[dict]" = []

    def _next(self, key: str) -> Any:
        q = self._verbs.get(key, [])
        i = self._vi.get(key, 0)
        self._vi[key] = i + 1
        if not q:
            return None
        return q[min(i, len(q) - 1)]

    def safe_call(self, method_name: str, *args, **kwargs) -> NanonisCallRecord:
        if len(self.calls) > 5000:
            raise RuntimeError(f"调用预算用尽（{method_name}）")
        rec = NanonisCallRecord(method=method_name, args=tuple(args), kwargs=dict(kwargs))
        spec = self._next(method_name)
        if spec is None:
            rec.return_value = ("", b"", [0.0])
        elif "error" in spec:
            rec.error = spec["error"]
            rec.return_value = None
        else:
            rec.return_value = ("", b"", list(spec["body"]))
        self.calls.append({"verb": method_name, "args": [_jsonable(a) for a in args],
                           "kwargs": {k: _jsonable(v) for k, v in kwargs.items()},
                           "error": rec.error})
        return rec

    def check_abort(self) -> bool:
        return self._abort_after is not None and len(self.calls) >= self._abort_after


WIGGLE: "list[dict]" = []

#: 反馈开着、偏压 20 mV、电流安静 —— 常规脚本。
_FB_ON = {"ZCtrl_OnOffGet": [{"body": [1.0]}],
          "Bias_Get": [{"body": [0.020]}],
          "Current_Get": [{"body": [3e-10]}]}


def run_wiggle(case: str, params: dict, verbs: "dict[str, list]",
               abort_after: "int | None" = None) -> None:
    _CLOCK[0] = 1_000_000.0
    ctx = _ScriptedContext(verbs, abort_after)
    res = BiasWiggle().execute(ctx, dict(params))
    WIGGLE.append({
        "case": case, "params": _plain(params),
        "verbs": _plain(verbs), "abort_after": abort_after,
        "success": bool(res.success), "error": res.error or "",
        "summary": res.summary or "", "data": _plain(res.data or {}),
        "calls": _plain(ctx.calls),
    })


_BASE = {"base_bias_v": 0.020, "burst_s": 0.5, "seed": 7}

# ── 硬帽二次校验（四条，各拒一次；一次仪器调用都不发）──
run_wiggle("refuse_upper", {**_BASE, "wiggle_upper_v": 0.2}, _FB_ON)
run_wiggle("refuse_empty_range", {**_BASE, "wiggle_lower_v": 0.02, "wiggle_upper_v": 0.01}, _FB_ON)
run_wiggle("refuse_burst", {**_BASE, "burst_s": 12.0}, _FB_ON)
run_wiggle("refuse_slew", {**_BASE, "slew_rate_v_per_s": 3.0}, _FB_ON)
run_wiggle("refuse_base_far", {**_BASE, "base_bias_v": 1.0}, _FB_ON)
# 边界**闭**：正好等于硬上限**放行**（`>` 不是 `>=`）
run_wiggle("upper_exactly_cap", {**_BASE, "wiggle_upper_v": 0.1, "burst_s": 0.3}, _FB_ON)
run_wiggle("burst_exactly_cap", {**_BASE, "burst_s": 10.0, "dwell_min_s": 4.0,
                                 "dwell_max_s": 5.0}, _FB_ON)

# ── 前置：反馈 ──
run_wiggle("feedback_off", _BASE, {**_FB_ON, "ZCtrl_OnOffGet": [{"body": [0.0]}]})
run_wiggle("feedback_unreadable", _BASE,
           {**_FB_ON, "ZCtrl_OnOffGet": [{"error": "NanonisError: 没有这个模块"}]})
run_wiggle("allow_feedback_off", {**_BASE, "allow_feedback_off": True},
           {**_FB_ON, "ZCtrl_OnOffGet": [{"body": [0.0]}]})

# ── 起点确认 ──
run_wiggle("bias_get_fails", _BASE, {**_FB_ON, "Bias_Get": [{"error": "timeout"}]})
run_wiggle("bias_get_empty", _BASE, {**_FB_ON, "Bias_Get": [{"body": []}]})

# ── 正常跑（三个种子；`dwell` 决定跳几次）──
run_wiggle("ok_seed7", _BASE, _FB_ON)
run_wiggle("ok_seed42", {**_BASE, "seed": 42}, _FB_ON)
run_wiggle("ok_from_negative", {**_BASE, "seed": 42},
           {**_FB_ON, "Bias_Get": [{"body": [-0.020]}]})
# `dwell_hi < dwell_lo` ⇒ 交换（不是拒绝）
run_wiggle("dwell_swapped", {**_BASE, "dwell_min_s": 0.2, "dwell_max_s": 0.05}, _FB_ON)
# 慢斜率 ⇒ 每次跳变分很多步（`_ramp_to` 的分步路径）
run_wiggle("slow_slew", {**_BASE, "slew_rate_v_per_s": 0.01, "burst_s": 0.4}, _FB_ON)
run_wiggle("restore_far", {**_BASE, "base_bias_v": -0.05}, _FB_ON)
# 收尾**分很多步**：`n = round(Δ / (2.0 × 0.05))`，要 Δ ≥ 0.15 V 才有 n ≥ 2。
# base 的包络是 `|base| <= 0.1 + upper`，所以只有把 `upper` 开到硬上限
# （0.1）才够得着 —— 这一格是 `_restore` 分步路径的**唯一**入口。
run_wiggle("restore_multistep",
           {**_BASE, "base_bias_v": 0.2, "wiggle_upper_v": 0.1, "wiggle_lower_v": 0.08,
            "burst_s": 0.3}, _FB_ON)
# 窄带：相邻目标常常差不到 1 mV ⇒ `_ramp_to` 的**快捷路径**（直接下发、只查一次电流）
run_wiggle("narrow_band",
           {**_BASE, "wiggle_lower_v": 0.0195, "wiggle_upper_v": 0.0205, "burst_s": 0.4},
           _FB_ON)

# ── 电流跳闸（第 6 次 `Current_Get` 超阈）──
run_wiggle("current_trip", _BASE,
           {**_FB_ON, "Current_Get": [{"body": [3e-10]}] * 5 + [{"body": [8e-9]}]})
# 第一次读电流就超阈 ⇒ 第 1 次跳变就停
run_wiggle("current_trip_first", _BASE, {**_FB_ON, "Current_Get": [{"body": [8e-9]}]})
# **负的**过流：判 `|I|` 才拦得住。这一格是那个绝对值的唯一入口 ——
# 另外两格给的都是正电流，判带号的与判绝对值的**同解**。
# 而这个技能一半时间在负偏压上，负的过流正是它该拦的那一半。
run_wiggle("current_trip_negative", _BASE,
           {**_FB_ON, "Current_Get": [{"body": [-3e-10]}] * 3 + [{"body": [-8e-9]}]})
# 电流读不出来（空 body）⇒ **不跳闸**（`amps is None` 那一支）
run_wiggle("current_unreadable", _BASE, {**_FB_ON, "Current_Get": [{"body": []}]})

# ── `Bias_Set` 失败 ──
run_wiggle("bias_set_fails", _BASE,
           {**_FB_ON, "Bias_Set": [{"body": [0.0]}] * 3 + [{"error": "NanonisError: 越界"}]})

# ── 中止 ──
run_wiggle("aborted_mid", _BASE, _FB_ON, abort_after=9)
run_wiggle("aborted_at_dwell", _BASE, _FB_ON, abort_after=2)


# ──────────────────────────────────────────────────────────────────────────


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_batch7a3.py 生成 —— 旧仓 seg_scale_adaptive 的 "
                 "kde_layers/_hist_modes、flat_region 的 _local_plane_rms、CPython 的 random，"
                 "以及 FindFlatRegion / BiasWiggle 两个技能真跑一遍。帧是闭式合成的（sin-hash，"
                 "零随机数），技能那一层录的是 .sxm 的**字节**，读法归旧仓。BiasWiggle 的墙钟是"
                 "假钟（1e6 s 起、每读一次 +1e-3 s、sleep 往前拨），`burst_s` 与 `log[].t_s` "
                 "是时钟派生字段。",
        "versions": {"numpy": np.__version__, "scipy": __import__("scipy").__version__,
                     "python": sys.version.split()[0]},
        "sxm_files": {k: base64.b64encode(v).decode("ascii") for k, v in FILES.items()},
        "np_grid": _plain(NPG),
        "hist_modes": _plain(HIST),
        "kde_layers": _plain(KDE),
        "local_plane_rms": _plain(RMS),
        "parse_excluded": _plain(EXCL),
        "mt19937": _plain(MT),
        "wiggle": _plain(WIGGLE),
        "skills": _plain(SKILLS),
    }
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    for tmp in (TMP, _ROOT):
        text = text.replace(json.dumps(tmp)[1:-1], "<tmp>")
        text = text.replace(tmp.replace("\\", "/"), "<tmp>")
    text = re.sub(r"\[WinError [^\"]*", "<oserror>", text)
    text = re.sub(r"\[Errno [^\"]*", "<oserror>", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((text + "\n").encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(doc) - 2} 节 · {kb:.0f} KB")
    for row in SKILLS["FindFlatRegion"]:
        d = row["data"] if isinstance(row["data"], dict) else {}
        print(f"   FindFlatRegion/{row['case']}: success={row['success']} "
              f"verdict={d.get('verdict', '—')} rms={d.get('rms_m', '—')}", file=sys.stderr)
    for row in WIGGLE:
        d = row["data"] if isinstance(row["data"], dict) else {}
        print(f"   BiasWiggle/{row['case']}: success={row['success']} "
              f"flips={d.get('flips_executed', '—')} stop={d.get('aborted_reason', '—')!r}",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
