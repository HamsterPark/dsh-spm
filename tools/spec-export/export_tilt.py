r"""批 7a-1 的金样 —— **旧仓 `mast/vision/tilt.py` 的帧法一族 + 三个调平技能真跑一遍**。

    python \
        tools/spec-export/export_tilt.py

## 为什么单开一台

`export_skill_traces.py` 的 `_params_for` 给不出一条真实的 `scan_path`，
于是 `AnalyzeFrameTilt` 在那台通用驱动器里只录得到「文件不存在」那一支；
而 `AutoTilt` / `TiltCalibrate` 更彻底 —— 它们要一个**会回话的 `TiltProbeCircle`**，
通用驱动器连那个子技能都没有。这一份自己搭：

* `.sxm` **字节**由本脚本合成（形状照 `export_batch6c.sxm_bytes`），读法归旧仓；
* 子技能 `TiltProbeCircle` 由一份**脚本**扮演（每一步交什么，写在用例里）；
* `time.sleep` 换掉 —— 三轮 × 若干小步的 `TILT_STEP_SETTLE_S` 加起来是十几秒，
  而这一份金样不能有墙钟。

## 分割器那一路**两侧都录**

`assess_steps` 的第二个判据走 `mast.vision.seg_scale_adaptive`，而本仓
**没有移** `segment_scale_adaptive`（`vision/seg-texture.ts` 的抬头明写）。
旧仓自己给这条路留了 fail-open：`except Exception: return (False, 0.0)`。

所以每一格都录**两遍**：

| 键 | 怎么跑的 |
|---|---|
| `*_seg` | 分割器在场（旧仓今天的真实行为） |
| `*_noseg` | 把 `sys.modules['mast.vision.seg_scale_adaptive']` 设成 `None`，
逼真的 `ImportError` 走**旧仓自己的 except 分支** |

后者才是本仓缺省跑的那一支。**不是把 `(False, 0.0)` 写死了再说「一样」** ——
两侧的数都在金样里，差在哪儿由 `git diff` 回答。
`terraces_*` 那两格上分割器**真的会响**（`step_present` / `triggered_by` 两个字段
在两侧不同），所以这不是一组分辨不出两种候选的金样。

## 三条纪律

1. **输入与答案一起录。** 帧里有 `default_rng(...).normal(...)` 的噪声，
   而本仓复现不了 numpy 的 ziggurat —— 「同一批输入」只能靠录下来
   （同 `export_numerics.py`）。
2. **条件数随每一格录。** `detrend_quadratic` 的设计阵 `[x², y², xy, x, y, 1]`
   **不中心化**，64 边长上 κ ≈ 1e5；本仓走列缩放 Householder QR，numpy 走 SVD。
   容差里唯一的未知数是 κ，而它必须是跑出来的。
3. **`MAST2_PROJECT_ROOT` 指临时目录**，旧仓一个字节都不写。
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

_ROOT = tempfile.mkdtemp(prefix="mast-tilt-root-")
os.environ.setdefault("MAST2_PROJECT_ROOT", _ROOT)

# ── 墙钟钉死 ───────────────────────────────────────────────────────────────
#
# `instrument_profile.set_tilt_calibration` 写 `tilt_cal_updated_at = time.time()`，
# 而它出现在 `TiltCalibrate` 成功那一格的回包里（`data.stored.updated_at`）。
# 不钉 ⇒ 每跑一次金样就换一个数，而**「重跑逐字节相同」是金样最重要的性质**
# —— 没有它，`git diff` 回答不了「旧仓变了没有」。
# 与 `export_skill_traces.py` 的 `_fake_time` 同一个常量。
#
# ⚠️ 第一版漏了这一条，两次导出 `cmp` 出 12 处差异，**全在这一个字段上**。
import time as _time  # noqa: E402

_time.time = lambda: 1_700_000_000.0  # type: ignore[assignment]

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "tilt.json"
MAST = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402

from mast.core import instrument_profile as ip  # noqa: E402
from mast.core.si_quantity import format_si_readable  # noqa: E402
from mast.skills.builtins.frame_tilt import AnalyzeFrameTilt  # noqa: E402
from mast.skills.composite import auto_tilt as at  # noqa: E402
from mast.vision import tilt as T  # noqa: E402


# ── JSON 化 ────────────────────────────────────────────────────────────────


def plain(v: Any) -> Any:
    """`allow_nan=False` 是这份金样的纪律，所以 NaN / ±inf 走字符串占位。"""
    if isinstance(v, np.ndarray):
        return plain(v.tolist())
    if isinstance(v, (np.floating, np.integer, np.bool_)):
        return plain(v.item())
    if isinstance(v, dict):
        return {str(k): plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
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
    return str(v)


# ── 分割器开关 ─────────────────────────────────────────────────────────────


class _NoSeg:
    """`with _NoSeg():` 里，`from mast.vision.seg_scale_adaptive import …` 抛。

    把模块设成 `None` 会让 `from X import Y` 抛 `ImportError`，于是走的是**旧仓
    自己那条 except 分支**，不是我替它编的返回值。这一条要紧：
    「照移一条 fail-open」与「把 fail-open 的结果写死」是两件事。
    """

    _KEY = "mast.vision.seg_scale_adaptive"

    def __enter__(self) -> "_NoSeg":
        self._saved = sys.modules.get(self._KEY, "<absent>")
        sys.modules[self._KEY] = None  # type: ignore[assignment]
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._saved == "<absent>":
            sys.modules.pop(self._KEY, None)
        else:
            sys.modules[self._KEY] = self._saved


# ── 帧 ─────────────────────────────────────────────────────────────────────
#
# 每一格都回答一个具体问题，列在 FRAME_WHY 里。

N = 64
NM_PER_PX = 100.0 / N          # 100 nm 视野 / 64 px
WIDTH_M = 1.0e-7
HEIGHT_M = 1.0e-7


def _grid(ny: int, nx: int):
    return np.mgrid[:ny, :nx]


def f_plane_noisy(ny=N, nx=N, ax=3e-12, ay=1e-12, noise=1.0e-11, seed=7):
    gy, gx = _grid(ny, nx)
    return ax * gx + ay * gy + np.random.default_rng(seed).normal(0.0, noise, (ny, nx))


def f_bowed(ny=N, nx=N, seed=11):
    """平面 + **二次弯曲** + 噪声 —— 压电扫描管弯曲的合成版。

    这一格的全部价值：只扣一阶时弯曲会把主导比抬过 1.4（旧仓实测 1.808），
    扣二阶之后压回噪声底。所以它既验 `detrend_quadratic` 真的在扣二次面，
    又验 `estimate_tilt` 在弯曲面上仍然给得出倾斜。
    """
    gy, gx = _grid(ny, nx)
    bow = 4.0e-13 * ((gx - nx / 2.0) ** 2 + (gy - ny / 2.0) ** 2) / (nx / 2.0) ** 2 * 100.0
    return 3e-12 * gx + 1e-12 * gy + bow + np.random.default_rng(seed).normal(0.0, 1.0e-11, (ny, nx))


def f_terraces(ny=N, nx=N, terrace_px=8, step=2.4e-10, noise=1.54e-11, seed=13):
    gy, gx = _grid(ny, nx)
    return step * (gx // terrace_px) + np.random.default_rng(seed).normal(0.0, noise, (ny, nx))


def f_bands(ny=N, nx=N):
    """三条水平台面，最大的那条占 `int(0.4·64) = 25` 行。

    **最大台面唯一**（25 / 19 / 20 行，面积不并列）是刻意的：并列时
    `count > best_count` 保留的是**先抽到的**那个，而「先抽到谁」正是本仓与 numpy
    不同的那件事（D-VISION-1）。唯一之后 `inlier_ratio` 逐位是 `25/64 = 0.390625`，
    与抽样序列无关 —— 实测 5 个种子给同一个数。
    """
    gy, gx = _grid(ny, nx)
    z = np.zeros((ny, nx), dtype=np.float64)
    z[int(ny * 0.4):int(ny * 0.7)] = 1e-9
    z[int(ny * 0.7):] = 5e-9
    return z + 1e-13 * gx


def f_half_nan(ny=N, nx=N, seed=17):
    z = f_plane_noisy(ny, nx, seed=seed)
    z[: int(ny * 0.25), :] = np.nan        # 25 % > MAX_NAN_FRAC = 0.20
    return z


def f_small(ny=32, nx=32, seed=19):
    return f_plane_noisy(ny, nx, seed=seed)


def f_tall(ny=64, nx=32, seed=23):
    """**非方**的小帧：短边 32 < 64、长边 64 —— 「太小」判的是**短边**。

    第一版只有 32×32，而那一格上 `min` 与 `max` 给同一个答案 ⇒
    把 `min(ny, nx)` 改成 `max(ny, nx)` 的变异**绿了**。
    一格分辨不出两种候选的金样不是判据。
    """
    return f_plane_noisy(ny, nx, seed=seed)


def f_tiny(ny=6, nx=6, amp=1.0e-11):
    """6×6：每个分块尺度都 `tile*2 > 6` ⇒ 多尺度那一层交 `(1.0, {})`。

    ⚠️ **必须带纹理**，不能是一个干净的斜面：干净斜面二阶去趋势之后残差是**纯舍入**
    （1e−28 量级），而 `structure_dominance` 在那上面算的是两边各自的浮点噪声之比 ——
    实测 2.12 对 3.32，差 **57 %**。那不是判据，是两台机器的 ulp 分布。
    棋盘把残差抬到真实量级，两边于是逐位可比。
    """
    gy, gx = _grid(ny, nx)
    return 1e-12 * gx + 2e-12 * gy + amp * ((-1.0) ** (gx + gy))


def f_all_nan(ny=8, nx=8):
    return np.full((ny, nx), np.nan)


def f_sparse(ny=8, nx=8):
    """恰好 **5** 个有限点 —— `detrend_quadratic` 的 `finite.sum() < 6` 那一支。"""
    z = np.full((ny, nx), np.nan)
    for k, (r, c) in enumerate([(0, 0), (0, 7), (7, 0), (7, 7), (3, 3)]):
        z[r, c] = 1e-12 * (k + 1)
    return z


def f_six(ny=8, nx=8):
    """恰好 **6** 个有限点 —— `finite < 6` 的**另一侧**（6 个点、6 个未知数，恰定）。

    ⚠️ 六个点要在**一般位置**上。第一版用的是四角 + (3,3) + (4,4)，
    而那六个点上 `[x², y², xy, x, y, 1]` **秩亏**：numpy 的 `lstsq(rcond=None)`
    截掉小奇异值给最小范数解，本仓的列缩放 QR 给另一个 —— 两者残差都近零，
    但**残差不同**，于是下游那个比值差了一倍多（实测 3.58 对 1.02）。
    一个秩亏的恰定解不是判据，是两个求解器各自的选择。
    """
    z = np.full((ny, nx), np.nan)
    # (row, col) = (y, x)：六个点取在一般位置上，`design_cond` 由导出器逐格录，
    # 这一格实测 **1.6e3**（上一版四角 + 两个对角点是 6e16 —— 那是秩亏）。
    for k, (r, c) in enumerate([(0, 0), (0, 1), (1, 0), (3, 2), (1, 5), (6, 3)]):
        z[r, c] = 1e-12 * (k + 1)
    return z


def f_blocky(ny=8, nx=8, tile=4):
    """每个 4×4 分块**内部恒定**、块间不同 ⇒ 局部 σ 为 0 ⇒ 主导比退回 1.0。"""
    gy, gx = _grid(ny, nx)
    return 1e-9 * ((gy // tile) * 2 + (gx // tile)).astype(np.float64)


def f_one_per_block(ny=8, nx=8, tile=4):
    """每个 4×4 分块只有**一个**有限点 ⇒ `stds` 为空 ⇒ 主导比退回 1.0。"""
    z = np.full((ny, nx), np.nan)
    for i in range(ny // tile):
        for j in range(nx // tile):
            z[i * tile, j * tile] = 1e-12 * (i * 2 + j + 1)
    return z


def f_plane_checker(ny=N, nx=N, ax=3e-12, ay=1e-12, amp=1.0e-11):
    """倾斜平面 + **棋盘**噪声 —— 一张 RANSAC **抽不动**的图。

    为什么需要它：`estimate_tilt` 内部调 `fit_plane_robust`，而两边的抽样序列不同
    （D-VISION-1：numpy PCG64 对 Xoshiro128）。高斯噪声那一格实测 12 个种子之间
    `b` 差 **3.3e-3**（相对），于是「倾斜是多少」这个数在金样里就是一次抽签。

    棋盘把它变成确定的：行内差分恒为 `±2·amp` ⇒ MAD 恒为 `2·amp` ⇒
    `σ = 2·amp·1.4826/√2`，内点阈 `3σ = 6.29·amp`，而任何一个够好的三点假设
    与真平面的偏差 ≤ ~3·amp ⇒ **全部 4096 个点都是内点**。
    `count > best_count` 在 `count == n` 之后再也不成立 ⇒ 内点集**与抽样无关**
    ⇒ 精拟合逐位相同。实测 12 个种子给同一个 `a`、同一个 `b`、`inlier_ratio == 1.0`。

    这正是 `plane.ts` 抬头那句「想要逐位，就别让它抽签」的另一种造法。
    """
    gy, gx = _grid(ny, nx)
    return ax * gx + ay * gy + amp * ((-1.0) ** (gx + gy))


def f_bow_checker(ny=N, nx=N, amp=1.0e-11, bow=2.0e-12):
    """浅弯曲 + 棋盘 —— 弯曲仍在内点带里，于是既是弯的又是**逐位**的。"""
    gy, gx = _grid(ny, nx)
    b = bow * (((gx - nx / 2.0) / (nx / 2.0)) ** 2 + ((gy - ny / 2.0) / (ny / 2.0)) ** 2)
    return 3e-12 * gx + 1e-12 * gy + b + amp * ((-1.0) ** (gx + gy))


FRAMES: "dict[str, np.ndarray]" = {
    "plane_checker": f_plane_checker(),
    "bow_checker": f_bow_checker(),
    "plane_noisy": f_plane_noisy(),
    "bowed": f_bowed(),
    "terraces_8": f_terraces(terrace_px=8),
    "terraces_16": f_terraces(terrace_px=16),
    "bands": f_bands(),
    "half_nan": f_half_nan(),
    "small_32": f_small(),
    "tall_64x32": f_tall(),
    "tiny_6": f_tiny(),
    "all_nan_8": f_all_nan(),
    "sparse_5": f_sparse(),
    "sparse_6": f_six(),
    "blocky_8": f_blocky(),
    "one_per_block_8": f_one_per_block(),
}

FRAME_WHY = {
    "plane_checker": "倾斜平面 + 棋盘噪声：内点恒为全部 ⇒ estimate_tilt **逐位**可比",
    "bow_checker": "浅弯曲 + 棋盘：既是弯的又是逐位的",
    "plane_noisy": "倾斜平面 + 10 pm 高斯噪声：真噪声那一格（RANSAC 抽样有差，按实测谱宽比）",
    "bowed": "平面 + 二次弯曲：只扣一阶会把主导比抬过 1.4，扣二阶压回噪声底",
    "terraces_8": "8 px 台面：主导比与分割器**都**响 ⇒ triggered_by = both",
    "terraces_16": "16 px 台面：同上，比值更高",
    "bands": "三条台面（25/19/20 行）：inlier_ratio = 0.390625 < 0.5",
    "half_nan": "25 % 的 NaN > MAX_NAN_FRAC",
    "small_32": "短边 32 < MIN_FRAME_PX",
    "tall_64x32": "非方：短边 32 < 64、长边 64 —— 「太小」判的是短边（min 不是 max）",
    "tiny_6": "短边 6 ⇒ 每个分块尺度都 `tile*2 > 6` ⇒ (1.0, {})",
    "all_nan_8": "全 NaN：structure_dominance 的 finite.size == 0 那一支",
    "sparse_5": "恰好 5 个有限点：detrend 的 `< 6` 那一支（原样返回）",
    "sparse_6": "恰好 6 个有限点：边界的另一侧（恰定解）",
    "blocky_8": "块内恒定 ⇒ 局部 σ == 0 ⇒ 退回 1.0",
    "one_per_block_8": "每块只有 1 个有限点 ⇒ stds 为空 ⇒ 退回 1.0",
}


def design_cond(arr: np.ndarray) -> "float | None":
    """`detrend_quadratic` 那个设计阵的条件数（容差里唯一的未知数）。"""
    a = np.asarray(arr, dtype=np.float64)
    ny, nx = a.shape
    gy, gx = np.mgrid[:ny, :nx]
    finite = np.isfinite(a)
    if finite.sum() < 6:
        return None
    x = gx[finite].astype(np.float64)
    y = gy[finite].astype(np.float64)
    d = np.column_stack([x * x, y * y, x * y, x, y, np.ones_like(x)])
    return float(np.linalg.cond(d))


# ── 组装 ───────────────────────────────────────────────────────────────────

out: "dict[str, Any]" = {
    "_note": (
        "批 7a-1：vision/tilt 的帧法一族 + AnalyzeFrameTilt / AutoTilt / TiltCalibrate。"
        "由 tools/spec-export/export_tilt.py 从旧仓导出，**不要手改**。"
        "`*_noseg` 是把 seg_scale_adaptive 弄成 ImportError 之后走旧仓 except 分支录的，"
        "那一支才是本仓缺省跑的那一支。"
    ),
    "constants": {
        "structure_ratio_threshold": T.STRUCTURE_RATIO_THRESHOLD,
        "dominance_min_terrace_px": T.DOMINANCE_MIN_TERRACE_PX,
        "dominance_tiles": list(T.DOMINANCE_TILES),
        "mad_to_sigma": T.MAD_TO_SIGMA,
        "ransac_sigma_mult": T.RANSAC_SIGMA_MULT,
        "ransac_trials": T.RANSAC_TRIALS,
        "min_inlier_ratio": T.MIN_INLIER_RATIO,
        "min_frame_px": T.MIN_FRAME_PX,
        "max_nan_frac": T.MAX_NAN_FRAC,
        "default_z_budget_frac": at.DEFAULT_Z_BUDGET_FRAC,
        "default_k_topo": at.DEFAULT_K_TOPO,
        "z_span_hard_limit_frac": at.Z_SPAN_HARD_LIMIT_FRAC,
        "accept_frac_of_trigger": at.ACCEPT_FRAC_OF_TRIGGER,
        "max_tilt_step_deg": at.MAX_TILT_STEP_DEG,
        "tilt_step_settle_s": at.TILT_STEP_SETTLE_S,
        "max_iterations": at.MAX_ITERATIONS,
        "convergence_ratio": at.CONVERGENCE_RATIO,
        "calib_step_deg": at.CALIB_STEP_DEG,
        "calib_response_min": at.CALIB_RESPONSE_MIN,
        "calib_response_max": at.CALIB_RESPONSE_MAX,
        "tilt_cal_max_cond": ip.TILT_CAL_MAX_COND,
    },
    "frames": {},
    "detrend_quadratic": {},
    "structure_dominance": {},
    "step_dominance_multiscale": {},
    "seg_signal": {},
    "assess_steps": {},
    "noise_floor": {},
    "estimate_tilt": {},
    "circle_tilt_resolution_deg": {},
    "z_span_for_frame": {},
    "thresholds": {},
    "format_si_readable": {},
    "files": {},
    "skills": {},
}

# ── ① 帧本身 ───────────────────────────────────────────────────────────────

for name, arr in FRAMES.items():
    out["frames"][name] = {
        "why": FRAME_WHY[name],
        "shape": list(arr.shape),
        "data": plain(arr),
        "design_cond": plain(design_cond(arr)),
        "pedestal": plain(float(np.nanmax(np.abs(arr))) if np.isfinite(arr).any() else 0.0),
    }

# ── ② detrend_quadratic ────────────────────────────────────────────────────

for name, arr in FRAMES.items():
    flat = T.detrend_quadratic(arr)
    fin = flat[np.isfinite(flat)]
    std = float(np.std(fin)) if fin.size else 0.0
    ped = float(np.nanmax(np.abs(arr))) if np.isfinite(arr).any() else 0.0
    # **残差是不是纯舍入**：恰定（6 点 6 未知数）或干净斜面上，去趋势之后残差
    # 只剩浮点噪声 —— 那时 `structure_dominance` 算的是两台机器各自的 ulp 分布之比，
    # 实测差 60 %。这个旗标让测试知道哪几格只能比**结论**，不能比数。
    out["detrend_quadratic"][name] = {
        "data": plain(flat),
        "std_finite": plain(std),
        "residual_is_rounding": bool(ped > 0 and std <= 1e-9 * ped),
    }

# ── ③ structure_dominance（逐尺度，含四条退路）─────────────────────────────

out["structure_dominance_raw"] = {}
for name, arr in FRAMES.items():
    flat = T.detrend_quadratic(arr)
    per: "dict[str, Any]" = {}
    raw: "dict[str, Any]" = {}
    for tile in (2, 4, 8, 16, 32, 64):
        per[str(tile)] = plain(T.structure_dominance(flat, tile))
        # **不去趋势**，直接喂原帧：四条退路里「局部 σ 恰为 0」那一条只在这里走得到
        # —— 去趋势会把块内的恒定打散（`blocky_8` 的 tile=4 从 1.0 变成 1.146），
        # 于是那条退路在上面那一节**一格都没有**，拆掉它也没人喊。
        raw[str(tile)] = plain(T.structure_dominance(arr, tile))
    out["structure_dominance"][name] = per
    out["structure_dominance_raw"][name] = raw

# ── ④ step_dominance_multiscale ────────────────────────────────────────────

for name, arr in FRAMES.items():
    flat = T.detrend_quadratic(arr)
    ratio, by_tile = T.step_dominance_multiscale(flat)
    out["step_dominance_multiscale"][name] = {
        "ratio": plain(ratio),
        "by_tile": {str(k): plain(v) for k, v in by_tile.items()},
    }

# ── ⑤ 分割器那一路 + assess_steps 两侧 ─────────────────────────────────────

for name, arr in FRAMES.items():
    present, frac = T._segmentation_step_signal(arr, NM_PER_PX)
    with _NoSeg():
        present_no, frac_no = T._segmentation_step_signal(arr, NM_PER_PX)
    out["seg_signal"][name] = {
        "with_segmenter": [bool(present), plain(float(frac))],
        "segmenter_unavailable": [bool(present_no), plain(float(frac_no))],
    }
    v_seg = T.assess_steps(arr, nm_per_px=NM_PER_PX, use_segmentation=True)
    v_off = T.assess_steps(arr, nm_per_px=NM_PER_PX, use_segmentation=False)
    with _NoSeg():
        v_noseg = T.assess_steps(arr, nm_per_px=NM_PER_PX, use_segmentation=True)
    out["assess_steps"][name] = {
        "verdict_seg": plain(v_seg.as_dict()),
        "verdict_noseg": plain(v_noseg.as_dict()),
        "verdict_use_segmentation_false": plain(v_off.as_dict()),
    }
    out["noise_floor"][name] = plain(T.noise_floor(arr))

# ── ⑥ estimate_tilt ────────────────────────────────────────────────────────

EST_CASES: "list[tuple[str, str, dict[str, Any], str]]" = [
    ("valid_plane", "plane_checker", {"check_steps": False},
     "主路（逐位）：棋盘噪声 ⇒ 内点恒为全部 ⇒ 与抽样序列无关"),
    ("valid_rotated", "plane_checker", {"scan_angle_deg": 30.0, "check_steps": False},
     "scan_angle ≠ 0 ⇒ rotation_applied 且 tilt_x/y 与 fast/slow 分开"),
    ("valid_bowed", "bow_checker", {"check_steps": False},
     "浅二次弯曲被内点带吃掉，倾斜照样给得出（逐位）"),
    ("angle_below_epsilon", "plane_checker", {"scan_angle_deg": 1e-10, "check_steps": False},
     "|angle| > 1e-9 才算转过 —— 这一格在线下面，rotation_applied 必须是 False"),
    ("valid_gaussian", "plane_noisy", {},
     "真高斯噪声那一格：结论逐字，数按**实测种子谱宽**比（ransac_spread）"),
    ("checker_step_gate", "plane_checker", {},
     "棋盘的高频纹理会让分割器判 STEP ⇒ 两侧不同（本仓走 segmenter_unavailable）"),
    ("too_small", "small_32", {}, "短边 32 < 64"),
    ("too_small_oblong", "tall_64x32", {},
     "64×32：短边 32 < 64 ⇒ 仍然太小。这一格把 `min` 与 `max` 分开"),
    ("too_many_nan", "half_nan", {}, "NaN 占比 0.25 > 0.20"),
    ("geometry_missing", "plane_noisy", {"width_m": 0.0}, "宽度为 0 ⇒ 换算不出角度"),
    ("nan_before_geometry", "half_nan", {"width_m": 0.0},
     "既没几何又满是 NaN ⇒ 报的是 too_many_nan（闸的**顺序**本身是判据）"),
    ("step_dense", "terraces_8", {}, "台阶主导 ⇒ 拒绝给出倾斜数字"),
    ("step_dense_off", "terraces_8", {"check_steps": False},
     "关掉台阶闸之后同一张图给得出数 —— 那个数正是「偏 13 倍」的那一类"),
    ("low_inliers", "bands", {"check_steps": False}, "inlier_ratio 0.390625 < 0.5"),
]

def ransac_spread(arr: np.ndarray, seeds: int = 12) -> float:
    """12 个抽样种子之间 `(a, b, inlier_ratio)` 的**最大相对谱宽**。

    这就是「这一格的数在多大程度上是一次抽签」的量。TS 那侧拿它当容差
    （`max(4 × spread, RANSAC_REL_TOL)`），于是**容差是量出来的，不是调出来的**；
    而 `spread == 0` 的那些格按 0 容差比。
    """
    a = np.asarray(arr, dtype=np.float64)
    if a.ndim != 2 or min(a.shape) < T.MIN_FRAME_PX:
        return 0.0
    sig = T.noise_floor(a)
    fits = [T.fit_plane_robust(a, sigma=sig, seed=s) for s in range(seeds)]
    fits = [f for f in fits if f is not None]
    if not fits:
        return 0.0
    worst = 0.0
    for k in (0, 1, 3):
        vals = [f[k] for f in fits]
        scale = max(abs(v) for v in vals)
        if scale == 0:
            continue
        worst = max(worst, (max(vals) - min(vals)) / scale)
    return float(worst)


for case, frame, kw, why in EST_CASES:
    params = {"width_m": WIDTH_M, "height_m": HEIGHT_M, "nm_per_px": NM_PER_PX}
    params.update(kw)
    arr = FRAMES[frame]
    est_seg = T.estimate_tilt(arr, **params)
    with _NoSeg():
        est_noseg = T.estimate_tilt(arr, **params)
    out["estimate_tilt"][case] = {
        "why": why,
        "frame": frame,
        "params": plain(params),
        "ransac_spread": plain(ransac_spread(arr)),
        "with_segmenter": plain(est_seg.as_dict()),
        "segmenter_unavailable": plain(est_noseg.as_dict()),
    }

#: 旧仓 `frame_not_2d` 那一支 —— **本仓不可达**（`Mat` 由 `matOf` 保证二维）。
#: 录下来是为了让「不可达」是一句量出来的话：对面的答案在这里，本仓那一侧
#: 最接近的形状（1×N 的 Mat）走的是 `frame_too_small`，两个都写在测试里。
out["estimate_tilt"]["not_2d"] = {
    "why": "一维输入：旧仓 frame_not_2d；本仓 Mat 构造不出一维，见 deviations",
    "frame": "<1d>",
    "ransac_spread": 0.0,
    "params": {"width_m": WIDTH_M, "height_m": HEIGHT_M},
    "with_segmenter": plain(
        T.estimate_tilt(np.arange(8, dtype=np.float64), width_m=WIDTH_M, height_m=HEIGHT_M).as_dict()),
    "segmenter_unavailable": plain(
        T.estimate_tilt(np.arange(8, dtype=np.float64), width_m=WIDTH_M, height_m=HEIGHT_M).as_dict()),
}

#: `fit_failed` 的**不可达证明**，量出来而不是说出来：
#: `fit_plane_robust` 只在有限像素 < 3 时交 None，而那时 NaN 占比早就过了 0.20。
_unreach = []
for k in (0, 1, 2, 3, 4):
    z = np.full((N, N), np.nan)
    z.flat[:k] = 1.0e-9
    _unreach.append({
        "finite": k,
        "nan_frac": plain(1.0 - k / float(N * N)),
        "fit_is_none": T.fit_plane_robust(z) is None,
        "invalid_reason": T.estimate_tilt(z, width_m=WIDTH_M, height_m=HEIGHT_M).invalid_reason,
    })
out["estimate_tilt_unreachable"] = {
    "why": "fit_failed 要 finite < 3，而那时 nan_frac ≈ 1 ⇒ too_many_nan 在它前面",
    "cases": _unreach,
}

# ── ⑦ 两个标量 ─────────────────────────────────────────────────────────────

RES_CASES = [
    ("typical", 1.54e-11, 2.0e-8, 24),
    ("one_point", 1.54e-11, 2.0e-8, 1),
    ("many_points", 1.54e-11, 2.0e-8, 180),
    ("big_radius", 1.54e-11, 5.0e-7, 24),
    ("zero_noise", 0.0, 2.0e-8, 24),
    ("zero_radius", 1.54e-11, 0.0, 24),
    ("zero_points", 1.54e-11, 2.0e-8, 0),
    ("negative_noise", -1.0e-11, 2.0e-8, 24),
]
for name, nf, r, n in RES_CASES:
    out["circle_tilt_resolution_deg"][name] = {
        "noise_floor_m": nf, "radius_m": r, "n_points": n,
        "value": plain(T.circle_tilt_resolution_deg(nf, r, n)),
    }

SPAN_CASES = [
    ("coarse_1um", 0.3, math.hypot(1e-6, 1e-6)),
    ("fine_10nm", 0.3, math.hypot(1e-8, 1e-8)),
    ("zero_angle", 0.0, math.hypot(1e-7, 1e-7)),
    ("negative_angle", -0.75, math.hypot(1e-7, 1e-7)),
    ("big_angle", 44.0, math.hypot(1e-7, 1e-7)),
    ("zero_diagonal", 2.0, 0.0),
]
for name, deg, diag in SPAN_CASES:
    out["z_span_for_frame"][name] = {
        "slope_mag_deg": deg, "frame_diagonal_m": diag,
        "value": plain(T.z_span_for_frame(deg, diag)),
    }

# ── ⑧ AutoTilt._thresholds ─────────────────────────────────────────────────

THR_CASES = [
    ("no_surface", None, 1.5e-6),
    ("zero_surface", 0.0, 1.5e-6),
    ("topo_wins", 1.0e-9, 1.5e-6),
    ("safety_wins", 1.0e-6, 1.5e-6),
    ("exactly_equal", 7.5e-9, 1.5e-6),
    ("small_range", 1.0e-9, 1.0e-8),
    ("negative_surface", -1.0e-9, 1.5e-6),
]
for name, rms, zr in THR_CASES:
    ip.set_profile({"z_range_m": zr})
    trig, acc, hard = at.AutoTilt._thresholds(rms)
    out["thresholds"][name] = {
        "surface_rms_m": rms, "z_range_m": zr,
        "trigger": plain(trig), "accept": plain(acc), "hard": plain(hard),
    }
ip.set_profile({})

#: `no_action_needed` 那一支里 `"within_budget" if span < hard else ""` 的 **else**
#: —— **不可达**，而这一节把它量出来而不是说出来。
#:
#: `trigger = min(0.05·zr, 10·rms) ≤ 0.05·zr`，`hard = 0.20·zr`，而走到这一支的前提是
#: `span ≤ trigger`。于是 `span ≤ 0.05·zr < 0.20·zr = hard` 恒成立（`zr > 0`，
#: 而 `CONFIG_SPEC` 把 `z_range_m` 夹在 `[1e-9, 1e-4]`）⇒ `span < hard` **永远**为真。
_unreach_reason = []
for zr in (1.0e-9, 1.5e-6, 1.0e-4):
    for rms in (None, 0.0, 1.0e-12, 1.0e-9, 1.0e-6):
        ip.set_profile({"z_range_m": zr})
        trig, acc, hard = at.AutoTilt._thresholds(rms)
        _unreach_reason.append({
            "z_range_m": zr, "surface_rms_m": rms,
            "trigger": plain(trig), "hard": plain(hard),
            "trigger_lt_hard": bool(trig < hard),
        })
ip.set_profile({})
out["no_action_reason_unreachable"] = {
    "why": "`span <= trigger` 且 `span >= hard` 同时成立才走得到空 reason，而 trigger < hard 恒成立",
    "cases": _unreach_reason,
}

# ── ⑨ format_si_readable（`diverged` / `not_converged` 那两句话里印的就是它）──

for name, v, unit in [
    ("nm", 6.4e-9, "m"), ("pm", 3e-12, "m"), ("zero", 0.0, "m"),
    ("ms", 0.5, "s"), ("plain_ten", 10.0, "V"), ("giga", 2.5e9, "Hz"),
    ("tiny", 1e-20, "m"), ("huge", 3e12, "m"), ("negative", -6.4e-9, "m"),
    ("four_sig", 1.23456e-9, "m"), ("no_unit", 7.0e-6, ""),
    ("exactly_1000", 1000.0, "m"), ("just_under_1000", 999.9999, "m"),
]:
    out["format_si_readable"][name] = {"value": v, "unit": unit,
                                       "text": format_si_readable(v, unit)}

# ── ⑩ `.sxm` 字节 ──────────────────────────────────────────────────────────


def sxm_bytes(frames, *, nx, ny, width_m, with_range=True, scan_dir="down",
              scan_angle=0.0, pixels_line=None) -> bytes:
    rng = f"{width_m:>22.6E}{width_m:>22.6E}"
    lines = [
        ":NANONIS_VERSION:", "2",
        ":SCANIT_TYPE:", "              FLOAT            MSBFIRST",
        ":REC_DATE:", " 15.09.2026",
        ":REC_TIME:", "12:34:56",
        ":ACQ_TIME:", "          12.8",
        ":BIAS:", "\t20.0E-3",
        ":Z-CONTROLLER>Setpoint:", "\t500.0E-12",
        ":SCAN_PIXELS:", pixels_line if pixels_line is not None else f"        {nx}         {ny}",
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


TMP = tempfile.mkdtemp(prefix="mast-tilt-files-")
PATHS: "dict[str, str]" = {}


def write_file(key: str, raw: bytes, ext: str = "sxm") -> str:
    out["files"][key] = base64.b64encode(raw).decode("ascii")
    p = Path(TMP) / f"{key}.{ext}"
    p.write_bytes(raw)
    PATHS[key] = str(p).replace("\\", "/")
    return PATHS[key]


# ⚠️ 技能那几格用的是**棋盘**帧，不是高斯帧：技能回包里的 `tilt.*` 全从
# `fit_plane_robust` 出来，而高斯帧上那些数是一次抽签（见 `plane_checker` 的 why）。
# 高斯帧另留一格（`plane_gauss`），它存在就是为了让「这一格必须按谱宽比」说得出口。
write_file("plane", sxm_bytes([("Z", "fwd", [FRAMES["plane_checker"]])],
                              nx=N, ny=N, width_m=WIDTH_M))
write_file("plane_rot", sxm_bytes([("Z", "fwd", [FRAMES["plane_checker"]])],
                                  nx=N, ny=N, width_m=WIDTH_M, scan_angle=30.0))
write_file("plane_gauss", sxm_bytes([("Z", "fwd", [FRAMES["plane_noisy"]])],
                                    nx=N, ny=N, width_m=WIDTH_M))
write_file("steps", sxm_bytes([("Z", "fwd", [FRAMES["terraces_8"]])],
                              nx=N, ny=N, width_m=WIDTH_M))
write_file("current_only", sxm_bytes([("Current", "fwd", [FRAMES["plane_checker"] * 1e-3])],
                                     nx=N, ny=N, width_m=WIDTH_M))
write_file("no_range", sxm_bytes([("Z", "fwd", [FRAMES["plane_checker"]])],
                                 nx=N, ny=N, width_m=WIDTH_M, with_range=False))
write_file("no_channels", sxm_bytes([("Z", "fwd", [FRAMES["plane_checker"]])],
                                    nx=N, ny=N, width_m=WIDTH_M, pixels_line="  nope  nope"))
write_file("both_dirs", sxm_bytes([("Z", "both", [FRAMES["plane_checker"],
                                                  FRAMES["plane_checker"][:, ::-1]])],
                                  nx=N, ny=N, width_m=WIDTH_M))
write_file("small", sxm_bytes([("Z", "fwd", [FRAMES["small_32"]])],
                              nx=32, ny=32, width_m=5.0e-8))
write_file("broken", b"not an sxm at all")
MISSING = f"{TMP}/does-not-exist.sxm".replace("\\", "/")

# ── ⑪ AnalyzeFrameTilt ─────────────────────────────────────────────────────


class NullCtx:
    """`AnalyzeFrameTilt` 一次 Nanonis 调用都不发，所以这个 context 是空的。"""


def scrub(v: Any) -> Any:
    """把临时目录换成 `<tmp>` —— 沙箱路径每跑一次都不同，而金样要逐字节相同。"""
    if isinstance(v, str):
        return v.replace(TMP, "<tmp>").replace(TMP.replace("\\", "/"), "<tmp>")
    if isinstance(v, dict):
        return {k: scrub(x) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v


def result_dict(r: Any) -> "dict[str, Any]":
    return {
        "success": bool(r.success),
        "error": r.error or "",
        "summary": getattr(r, "summary", "") or "",
        "data": plain(r.data or {}),
    }


FT_CASES: "list[tuple[str, dict[str, Any], str]]" = [
    ("missing", {"scan_path": MISSING}, "文件不存在那一支（在碰任何东西之前）"),
    ("broken", {"scan_path": PATHS["broken"]}, ".sxm 读取失败"),
    ("no_channels", {"scan_path": PATHS["no_channels"]}, "头里像素数读不出 ⇒ 一个通道都没有"),
    ("no_geometry", {"scan_path": PATHS["no_range"]}, "解析不出扫描几何 ⇒ 拒绝给无意义的数字"),
    ("ok_plane", {"scan_path": PATHS["plane"]}, "主路（棋盘帧 ⇒ 逐位）"),
    ("ok_rotated", {"scan_path": PATHS["plane_rot"]}, "非零 scan_angle 一路走到 rotation_applied"),
    ("ok_gaussian", {"scan_path": PATHS["plane_gauss"]},
     "真高斯噪声：同一条路，但 tilt.* 只能按实测谱宽比"),
    ("both_dirs", {"scan_path": PATHS["both_dirs"]},
     "正反扫都在 ⇒ 取 forward（**裸块**，不做几何归位，见技能抬头）"),
    ("ok_steps", {"scan_path": PATHS["steps"]}, "台阶主导 ⇒ summary 换成另一句"),
    ("no_steps_check", {"scan_path": PATHS["steps"], "check_steps": False},
     "关掉台阶闸 ⇒ 同一张图从 step_dense 换成 low_inliers（那个内点比是一次抽签，只比结论）"),
    ("plane_no_steps_check", {"scan_path": PATHS["plane"], "check_steps": False},
     "关掉台阶闸的**确定**那一格：`tilt.step` 这个键整个消失，其余逐位不变"),
    ("channel_fallback", {"scan_path": PATHS["current_only"], "channel": "Z"},
     "要 Z 而文件里只有 Current ⇒ `or next(iter(...))` 落到第一个通道"),
    ("small_frame", {"scan_path": PATHS["small"]}, "帧太小 ⇒ tilt 无效，但起伏照样报"),
]

def skill_frame_spread(path: str, channel: str = "Z") -> float:
    """技能**真正读到**的那张图（float32 解出来的）上的 RANSAC 谱宽。

    与直接那几节分开量：`.sxm` 里存的是 float32 大端，解出来的数与内存里的
    float64 帧不是同一批数 —— 「谱宽是多少」要问技能手上的那一份。
    """
    from mast.io.nanonis_files import read_sxm  # noqa: PLC0415

    try:
        scan = read_sxm(path)
    except Exception:  # noqa: BLE001
        return 0.0
    chans = scan.get("channels", {}) or {}
    ch = chans.get(channel) or next(iter(chans.values()), None)
    if ch is None:
        return 0.0
    img = ch.get("forward")
    if img is None:
        img = ch.get("backward")
    if img is None:
        return 0.0
    return ransac_spread(np.asarray(img, dtype=np.float64))


skill_ft = AnalyzeFrameTilt()
for case, params, why in FT_CASES:
    r_seg = skill_ft.execute(NullCtx(), dict(params))
    with _NoSeg():
        r_noseg = skill_ft.execute(NullCtx(), dict(params))
    out["skills"].setdefault("AnalyzeFrameTilt", {})[case] = {
        "why": why,
        "params": scrub(plain(params)),
        "ransac_spread": plain(skill_frame_spread(str(params["scan_path"]),
                                                  str(params.get("channel") or "Z"))),
        "with_segmenter": scrub(result_dict(r_seg)),
        "segmenter_unavailable": scrub(result_dict(r_noseg)),
    }

# ── ⑫ AutoTilt / TiltCalibrate ─────────────────────────────────────────────
#
# 子技能 `TiltProbeCircle` 由脚本扮演；`time.sleep` 换掉（金样不能有墙钟）。

at.time.sleep = lambda _s: None       # type: ignore[assignment]


class Rec:
    def __init__(self, method, args, error=None, return_value=None):
        self.method = method
        self.args = args
        self.error = error
        self.return_value = return_value


class Res:
    def __init__(self, success, data=None, error=""):
        self.success = success
        self.data = data or {}
        self.error = error


class Ctx:
    """假 `ExecutionContext`：`safe_call` 查表，`run` 按脚本逐次交出。"""

    def __init__(self, replies, script, *, abort_after=None):
        self.replies = dict(replies)
        self.script = list(script)
        self.calls: "list[Any]" = []
        self._abort_after = abort_after
        self._abort_seen = 0

    def safe_call(self, method, *args, **kw):
        spec = self.replies.get(method, "<未脚本化>")
        if isinstance(spec, str) and spec != "<ok>":
            rec = Rec(method, args, error=spec)
        else:
            rec = Rec(method, args, error=None,
                      return_value=("", b"", list(spec)) if not isinstance(spec, str) else ("", b"", []))
        self.calls.append(rec)
        return rec

    def run(self, name, params):
        self.calls.append(Rec(f"<run:{name}>", (json.dumps(params, sort_keys=True),), error=None))
        if not self.script:
            return Res(False, error="脚本用完了")
        nxt = self.script.pop(0)
        return nxt

    def check_abort(self):
        if self._abort_after is None:
            return False
        self._abort_seen += 1
        return self._abort_seen > self._abort_after


def probe(tilt_x, tilt_y, *, noise=1.54e-11, radius=2.0e-8, n=24):
    mag = math.degrees(math.atan(math.hypot(math.tan(math.radians(tilt_x)),
                                            math.tan(math.radians(tilt_y)))))
    return Res(True, {
        "tilt_x_deg": tilt_x, "tilt_y_deg": tilt_y, "slope_mag_deg": mag,
        "noise_floor_m": noise, "radius_m": radius, "n_points": n,
        "center_x_m": 1.0e-9, "center_y_m": -2.0e-9,
    })


TILT_OK = [0.10, -0.05]
#: ⚠️ 扫描框故意**不是正方形、也不是 100 nm**：兜底对角线恰好是 `hypot(1e-7, 1e-7)`，
#: 用 100 nm 的框会让「读到了框」与「读不到、走兜底」两格给出同一个 `frame_diagonal_m`
#: —— 那就是一格分辨不出两种候选的金样。300 × 200 nm ⇒ 对角线 3.606e-7，兜底 1.414e-7。
REPLIES_OK = {"Piezo_TiltGet": TILT_OK, "Piezo_TiltSet": "<ok>",
              "Scan_FrameGet": [0.0, 0.0, 3.0e-7, 2.0e-7, 0.0]}

#: 触发阈的分母。给 `surface_rms_m` 是为了把触发阈从「安全那一项」（0.05 × 1.5 µm
#: = 75 nm，真机上要非常大的倾斜才够）压到形貌那一项上 —— 而那正是这个技能最主要
#: 的使用场景（「图明显看着是斜的」）。
RMS_TOPO = 1.0e-10      # ⇒ trigger 1 nm、accept 500 pm（高于两倍分辨率 165 pm）
RMS_TIGHT = 1.0e-11     # ⇒ trigger 100 pm、accept 50 pm（**低于** 165 pm ⇒ 会被抬上去）

#: 一份**装好了**的标定（G 把测到的斜率原样反号补回去）。
CAL_G = [[-1.0, 0.0], [0.0, -1.0]]


def with_cal(g=CAL_G, cond=1.0, **extra):
    prof = {"z_range_m": 1.5e-6, "tilt_limit_deg": 5.0}
    prof.update(extra)
    ip.set_profile(prof)
    if g is not None:
        ip.set_tilt_calibration(g, cond=cond)


AT_CASES: "list[tuple[str, dict[str, Any], Any]]" = []


def at_case(name, why, params, replies, script, *, profile=None, cal=CAL_G,
            cond=1.0, abort_after=None):
    AT_CASES.append((name, {"why": why, "params": params, "replies": replies,
                            "script": script, "profile": profile or {},
                            "cal": cal, "cond": cond, "abort_after": abort_after}, None))


at_case("calibration_missing", "没标定过 ⇒ skipped，一次硬件都不碰",
        {}, REPLIES_OK, [], cal=None)
at_case("tilt_unreadable", "读不到当前倾斜 ⇒ 无法安全回滚",
        {}, {**REPLIES_OK, "Piezo_TiltGet": "Piezo_TiltGet 读失败"}, [])
at_case("measure_failed", "TiltProbeCircle 失败 ⇒ skipped(measure_failed)",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK, [Res(False, error="圆测量失败: 没进针")])
at_case("within_budget", "斜坡在预算之内 ⇒ no_action_needed(within_budget)",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK, [probe(0.01, 0.005)])
at_case("no_surface_rms", "不给 surface_rms_m ⇒ 只剩安全判据（75 nm），同样的倾斜就不触发了",
        {}, REPLIES_OK, [probe(1.0, 0.3)])
at_case("forced", "force=True ⇒ 即使在预算内也补偿",
        {"surface_rms_m": RMS_TOPO, "force": True}, REPLIES_OK,
        [probe(0.01, 0.005), probe(0.005, 0.002)])
at_case("applied_one_round", "一轮补偿到位",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK, [probe(1.0, 0.3), probe(0.05, 0.02)])
at_case("applied_frame_param", "next_frame_m 给了 ⇒ 不问 Scan_FrameGet（对角线换成 1.414 µm）",
        {"surface_rms_m": RMS_TOPO, "next_frame_m": 1.0e-6}, REPLIES_OK,
        [probe(0.30, 0.10), probe(0.01, 0.005)])
at_case("frame_fallback", "Scan_FrameGet 也读不到 ⇒ 100 nm 兜底对角线 1.414e-7",
        {"surface_rms_m": RMS_TOPO}, {**REPLIES_OK, "Scan_FrameGet": "读不到帧"},
        [probe(1.0, 0.3), probe(0.05, 0.02)])
at_case("hw_reject", "写倾斜被拒 ⇒ failed(hw_reject) 并回到原始倾斜",
        {"surface_rms_m": RMS_TOPO}, {**REPLIES_OK, "Piezo_TiltSet": "安全闸拒绝: 倾斜超限"},
        [probe(1.0, 0.3)])
at_case("verify_failed", "复测失败 ⇒ rolled_back(verify_failed)",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK,
        [probe(1.0, 0.3), Res(False, error="复测时针尖掉了")])
at_case("diverged", "残余没降到上一轮的 70 % ⇒ rolled_back(diverged)",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK, [probe(1.0, 0.3), probe(1.0, 0.0)])
at_case("not_converged", "轮数用尽仍未达标 ⇒ failed(not_converged)，但保留已改善的结果",
        {"surface_rms_m": RMS_TOPO, "max_iterations": 2}, REPLIES_OK,
        [probe(1.0, 0.3), probe(0.6, 0.0), probe(0.4, 0.0)])
at_case("truncated_at_limit", "单轴限幅：tilt_limit_deg 拉到 0.05° ⇒ truncated_at_limit",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK, [probe(3.0, 2.0), probe(0.05, 0.02)],
        profile={"tilt_limit_deg": 0.05})
at_case("multi_substep", "|Δ| = 3.6° ⇒ 拆成 4 小步（MAX_TILT_STEP_DEG = 1）",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK, [probe(3.0, 2.0), probe(0.05, 0.02)])
at_case("accept_raised_to_resolution", "验收阈 50 pm 低于两倍测量分辨率 165 pm ⇒ 抬上去并记一笔",
        {"surface_rms_m": RMS_TIGHT}, REPLIES_OK, [probe(0.30, 0.10), probe(0.01, 0.005)])
at_case("operator_stopped", "小步中途用户喊停 ⇒ 不回滚，说清停在哪儿",
        {"surface_rms_m": RMS_TOPO}, REPLIES_OK, [probe(3.0, 2.0)], abort_after=0)

for name, spec, _ in AT_CASES:
    with_cal(spec["cal"], spec["cond"], **spec["profile"])
    ctx = Ctx(spec["replies"], spec["script"], abort_after=spec["abort_after"])
    res = at.AutoTilt().execute(ctx, dict(spec["params"]))
    out["skills"].setdefault("AutoTilt", {})[name] = {
        "why": spec["why"],
        "params": plain(spec["params"]),
        "profile": plain({"z_range_m": 1.5e-6, "tilt_limit_deg": 5.0, **spec["profile"]}),
        "calibration": {"g": plain(spec["cal"]), "cond": plain(spec["cond"])},
        "probe_results": [plain({"success": r.success, "error": r.error, "data": r.data})
                          for r in spec["script"]],
        "abort_after": spec["abort_after"],
        "replies": plain(spec["replies"]),
        "result": plain(result_dict(res)),
        "calls": [[c.method, plain(list(c.args)), c.error or ""] for c in ctx.calls],
    }

# ── ⑬ TiltCalibrate ────────────────────────────────────────────────────────

TC_CASES: "list[tuple[str, str, dict[str, Any], Any, list[Any]]]" = [
    ("tilt_unreadable", "读不到当前倾斜 ⇒ 既不能标定也不能回滚",
     {}, {**REPLIES_OK, "Piezo_TiltGet": "读不到"}, []),
    ("baseline_failed", "基线测量失败",
     {}, REPLIES_OK, [Res(False, error="基线圆没跑成")]),
    ("probe_write_failed", "施加试探步失败（轴 0）⇒ 恢复原倾斜后失败",
     {}, {**REPLIES_OK, "Piezo_TiltSet": "写倾斜被拒"}, [probe(0.0, 0.0)]),
    ("probe_measure_failed", "试探测量失败（轴 0）",
     {}, REPLIES_OK, [probe(0.0, 0.0), Res(False, error="试探圆没跑成")]),
    ("response_out_of_range", "轴 0 响应幅度 0.05 < 0.3 ⇒ 未写入任何标定",
     {}, REPLIES_OK, [probe(0.0, 0.0), probe(0.01, 0.0), probe(0.0, 0.2)]),
    ("singular", "两轴响应共线 ⇒ 响应矩阵奇异",
     {}, REPLIES_OK, [probe(0.0, 0.0), probe(0.2, 0.2), probe(0.2, 0.2)]),
    ("cond_too_high", "条件数超上限 ⇒ 拒绝写入",
     {}, REPLIES_OK, [probe(0.0, 0.0), probe(0.2, 0.2), probe(0.2, 0.17)]),
    ("ok", "标定成功并写进档案",
     {}, REPLIES_OK, [probe(0.0, 0.0), probe(0.2, 0.0), probe(0.0, 0.2)]),
    ("ok_swapped", "轴交换：x 的一步主要出现在测到的 y 上",
     {}, REPLIES_OK, [probe(0.0, 0.0), probe(0.0, 0.2), probe(0.2, 0.0)]),
    ("custom_step", "step_deg = 0.5 ⇒ 响应按它归一",
     {"step_deg": 0.5}, REPLIES_OK, [probe(0.0, 0.0), probe(0.5, 0.0), probe(0.0, 0.5)]),
    ("operator_stopped", "第一个轴之前用户喊停 ⇒ 停在试探步上，不回滚",
     {}, REPLIES_OK, [probe(0.0, 0.0)]),
]

for name, why, params, replies, script in TC_CASES:
    ip.set_profile({"z_range_m": 1.5e-6, "tilt_limit_deg": 5.0})
    abort = 0 if name == "operator_stopped" else None
    ctx = Ctx(replies, script, abort_after=abort)
    res = at.TiltCalibrate().execute(ctx, dict(params))
    stored = ip.get_tilt_calibration()
    out["skills"].setdefault("TiltCalibrate", {})[name] = {
        "why": why,
        "params": plain(params),
        "probe_results": [plain({"success": r.success, "error": r.error, "data": r.data})
                          for r in script],
        "abort_after": abort,
        "replies": plain(replies),
        "result": plain(result_dict(res)),
        "calls": [[c.method, plain(list(c.args)), c.error or ""] for c in ctx.calls],
        "profile_after": plain(stored),
    }
ip.set_profile({})

# ── ⑭ set_tilt_calibration 的拒写闸（技能之外也要能单独验）─────────────────

SET_CASES = [
    ("ok", [[1.0, 0.0], [0.0, 1.0]], 1.0),
    ("cond_on_the_line", [[1.0, 0.0], [0.0, 1.0]], 10.0),
    ("cond_over_the_line", [[1.0, 0.0], [0.0, 1.0]], 10.000001),
    ("cond_nan", [[1.0, 0.0], [0.0, 1.0]], float("nan")),
    ("cond_inf", [[1.0, 0.0], [0.0, 1.0]], float("inf")),
    ("matrix_nan", [[float("nan"), 0.0], [0.0, 1.0]], 1.0),
    ("matrix_short", [[1.0, 0.0]], 1.0),
    ("matrix_not_a_matrix", "nope", 1.0),
]
out["set_tilt_calibration"] = {}
for name, g, cond in SET_CASES:
    ip.set_profile({})
    stored = ip.set_tilt_calibration(g, cond=cond)
    out["set_tilt_calibration"][name] = {
        "g": plain(g), "cond": plain(cond),
        "stored": plain(stored),
        "profile_after": plain(ip.get_tilt_calibration()),
    }
ip.set_profile({})


# ── ⑮ 「为什么非得扣二阶」—— 同一张图，一阶与二阶各走一遍 ─────────────────
#
# 旧仓的说法是「只扣一阶时压电弯曲把比值抬到 1.808，高于台面 8 px 的密集台阶
# (1.717)，于是**不存在**任何阈值能既抓住密集台阶又不把弯曲误判成台阶」。
# 那句话在本仓是一条**可以变红的断言**，不是注释。

out["detrend_order_matters"] = {}
for name in ("bowed", "plane_noisy", "terraces_8"):
    arr = FRAMES[name]
    r1, _ = T.step_dominance_multiscale(T.plane_subtract(arr))
    r2, _ = T.step_dominance_multiscale(T.detrend_quadratic(arr))
    out["detrend_order_matters"][name] = {
        "ratio_order1": plain(r1),
        "ratio_order2": plain(r2),
        "hit_order1": bool(r1 >= T.STRUCTURE_RATIO_THRESHOLD),
        "hit_order2": bool(r2 >= T.STRUCTURE_RATIO_THRESHOLD),
    }

# ── ⑯ fit_circle_tilt ──────────────────────────────────────────────────────


def circle_z(n, sx, sy, radius, *, c=0.0, drift=0.0, step_at=None, step_h=0.0,
             jitter=(), dt=0.1):
    """一圈上的 `(θ, z, t)`。**闭式，零随机数。**"""
    th = [2.0 * math.pi * k / n for k in range(n)]
    ts = [k * dt for k in range(n)]
    zs = []
    for k, t in enumerate(th):
        x = radius * math.cos(t)
        y = radius * math.sin(t)
        z = sx * x + sy * y + c + drift * ts[k]
        if step_at is not None and t >= step_at:
            z += step_h
        if jitter:
            z += jitter[k % len(jitter)]
        zs.append(z)
    return th, zs, ts


CIRCLE_CASES: "list[tuple[str, str, Any]]" = []


def circle_case(name, why, angles, zs, radius, *, times=None, noise=0.0):
    fit = T.fit_circle_tilt(angles, zs, radius, times_s=times, noise_floor_m=noise)
    CIRCLE_CASES.append((name, why, {
        "angles_rad": plain(list(angles)),
        "z_values": plain(list(zs)),
        "radius_m": plain(radius),
        "times_s": plain(list(times)) if times is not None else None,
        "noise_floor_m": plain(noise),
        "result": plain(fit.as_dict()),
    }))


_R = 2.0e-8
_J = (1.0e-12, -0.7e-12, 0.4e-12, -1.1e-12, 0.9e-12)

th, zs, ts = circle_z(24, 5.0e-3, -2.0e-3, _R, jitter=_J)
circle_case("plain", "24 点、无漂移、不给时间 ⇒ 三列设计阵", th, zs, _R, noise=1.0e-12)
circle_case("with_times_no_drift", "给了时间但样品没漂 ⇒ drift_rate ≈ 0", th, zs, _R,
            times=ts, noise=1.0e-12)

th2, zs2, ts2 = circle_z(24, 5.0e-3, -2.0e-3, _R, drift=2.0e-11, jitter=_J)
circle_case("with_drift", "2e-11 m/s 的线性漂移被单独拟合出来并扣掉", th2, zs2, _R,
            times=ts2, noise=1.0e-12)
circle_case("drift_ignored", "同一圈**不给**时间 ⇒ 漂移混进倾斜（两格之差就是漂移项的价值）",
            th2, zs2, _R, noise=1.0e-12)

th3, zs3, ts3 = circle_z(24, 5.0e-3, -2.0e-3, _R, jitter=_J)
tc = [1.0] * 24
circle_case("times_constant", "时间全相同 ⇒ max−min == 0 ⇒ 漂移列不加", th3, zs3, _R,
            times=tc, noise=1.0e-12)

th4, zs4, _ = circle_z(24, 5.0e-3, -2.0e-3, _R, step_at=math.pi, step_h=2.4e-10, jitter=_J)
circle_case("residual_too_large", "半圈抬高 240 pm 的台阶 ⇒ 跳变比越线，被否决",
            th4, zs4, _R, noise=1.0e-11)
circle_case("step_but_no_noise_floor", "同一圈但噪声底为 0 ⇒ 否决**整条失效**（`noise > 0` 是它的前提）",
            th4, zs4, _R, noise=0.0)

# 两条否决线各自**单独**越线的那两格 —— 否则「峰值 **或** 跳变」与
# 「峰值 **与** 跳变」给同一个答案，那一道闸就分不出两种候选。
#
#   peak_only：残差是 `A·cos 2θ`（二次谐波，正弦拟合吸收不掉）。光滑 ⇒ 相邻跳变小。
#              A = 6 pm、σ = 1 pm ⇒ 峰值比 6 > 4.5，跳变比 ≈ 3 ≤ 7。
#   jump_only：残差是逐点交替的 ±c（与 cos/sin/1 正交，全额留在残差里）。
#              c = 4 pm ⇒ 峰值比 4 ≤ 4.5，而跳变比 8 > 7。
th7 = [2.0 * math.pi * k / 24 for k in range(24)]
zs7 = [5.0e-3 * _R * math.cos(t) - 2.0e-3 * _R * math.sin(t) + 6.0e-12 * math.cos(2.0 * t)
       for t in th7]
circle_case("peak_only", "只有**峰值**越线（二次谐波，光滑）⇒ 仍然否决", th7, zs7, _R, noise=1.0e-12)

zs8 = [5.0e-3 * _R * math.cos(t) - 2.0e-3 * _R * math.sin(t) + (4.0e-12 if k % 2 == 0 else -4.0e-12)
       for k, t in enumerate(th7)]
circle_case("jump_only", "只有**跳变**越线（逐点交替）⇒ 仍然否决", th7, zs8, _R, noise=1.0e-12)

# 时间里有 NaN ⇒ 漂移列**不加**（加了整份解都是 NaN）。
th9, zs9, ts9 = circle_z(24, 5.0e-3, -2.0e-3, _R, jitter=_J)
ts_nan = list(ts9)
ts_nan[5] = float("nan")
circle_case("times_with_nan", "时间里有一个 NaN ⇒ 漂移列不加（加了整份解都是 NaN）",
            th9, zs9, _R, times=ts_nan, noise=1.0e-12)

th5, zs5, _ = circle_z(7, 5.0e-3, -2.0e-3, _R, jitter=_J)
circle_case("too_few_points", "7 < CIRCLE_MIN_POINTS", th5, zs5, _R, noise=1.0e-12)

circle_case("bad_radius", "半径 0", th, zs, 0.0, noise=1.0e-12)
circle_case("shape_mismatch", "角度与 Z 长度不一致", th, zs[:-1], _R, noise=1.0e-12)

th6 = list(th)
zs6 = list(zs)
th6[3] = float("nan")
zs6[7] = float("nan")
circle_case("nan_filtered", "两个点被 isfinite 掩膜掉 ⇒ n_points 变 22", th6, zs6, _R,
            noise=1.0e-12)

circle_case("all_same_angle", "全部角度相同 ⇒ 设计阵秩亏（numpy 给最小范数解，本仓 QR 给别的，见 deviations）",
            [0.0] * 12, [1e-9] * 12, _R, noise=1.0e-12)

out["fit_circle_tilt"] = {name: {"why": why, **rest} for name, why, rest in CIRCLE_CASES}
out["constants"]["circle_min_points"] = T.CIRCLE_MIN_POINTS
out["constants"]["circle_max_residual_sigma"] = T.CIRCLE_MAX_RESIDUAL_SIGMA
out["constants"]["circle_max_jump_sigma"] = T.CIRCLE_MAX_JUMP_SIGMA
out["constants"]["circle_residual_max_ratio"] = T.CIRCLE_RESIDUAL_MAX_RATIO

# ── ⑰ 控制律与 2×2 条件数（内核那一层的判据表）─────────────────────────────

CTRL_G = [[-1.2, 0.3], [0.1, -0.9]]
out["control_law"] = {}
for name, g, sx, sy in [
    ("identity_like", [[-1.0, 0.0], [0.0, -1.0]], 0.30, 0.10),
    ("cross_coupled", CTRL_G, 0.30, 0.10),
    ("zero_slope", CTRL_G, 0.0, 0.0),
    ("big", CTRL_G, 3.0, 2.0),
]:
    dx = g[0][0] * sx + g[0][1] * sy
    dy = g[1][0] * sx + g[1][1] * sy
    mag = math.hypot(dx, dy)
    out["control_law"][name] = {
        "g": plain(g), "slope": [sx, sy],
        "delta": plain([dx, dy]),
        "mag": plain(mag),
        "n_sub": max(1, math.ceil(mag / at.MAX_TILT_STEP_DEG)),
    }

out["clamp"] = {}
for name, target, limit in [
    ("inside", 0.4, 5.0), ("on_the_line", 5.0, 5.0), ("over", 7.5, 5.0),
    ("over_negative", -7.5, 5.0), ("zero_limit", 0.1, 0.0), ("negative_zero", -0.0, 5.0),
]:
    truncated = abs(target) > limit
    value = math.copysign(limit, target) if truncated else target
    out["clamp"][name] = {"target": target, "limit": limit,
                          "value": plain(value), "truncated": truncated}

out["cond2x2"] = {}
for name, m in [
    ("identity", [[1.0, 0.0], [0.0, 1.0]]),
    ("diag_10", [[1.0, 0.0], [0.0, 0.1]]),
    ("swapped", [[0.0, 1.0], [1.0, 0.0]]),
    ("near_singular", [[1.0, 1.0], [1.0, 1.0000001]]),
    ("singular", [[1.0, 1.0], [1.0, 1.0]]),
    ("calib_ok", [[0.98, 0.05], [-0.04, 1.02]]),
    ("calib_high", [[1.0, 0.0], [0.85, 0.15]]),
    ("negative", [[-1.0, 0.2], [0.3, -0.8]]),
]:
    a = np.asarray(m, dtype=float)
    try:
        cond = float(np.linalg.cond(a))
    except Exception:  # noqa: BLE001
        cond = float("inf")
    det = float(a[0][0] * a[1][1] - a[0][1] * a[1][0])
    out["cond2x2"][name] = {"m": plain(m), "cond": plain(cond), "det": plain(det),
                            "singular_values": plain(list(np.linalg.svd(a, compute_uv=False)))}

# ── ⑱ TiltProbeCircle ──────────────────────────────────────────────────────

import mast.skills.builtins.tilt_probe as tp  # noqa: E402

#: 时钟：每调一次 `monotonic` 前进 1 ms。**金样不能有墙钟**，而 `elapsed_s` /
#: `times_s` 都由它来。TS 那侧的夹具用同一条规则 —— 于是「`now()` 被调了几次、
#: 在哪儿调的」本身成了一条判据。
_TICK = {"n": 0}


def _mono() -> float:
    _TICK["n"] += 1
    return _TICK["n"] * 0.001


tp.time.monotonic = _mono          # type: ignore[assignment]
tp.time.sleep = lambda _s: None    # type: ignore[assignment]


class ZSim:
    """一台**闭式**的假仪器：横移记下位置，读 Z 时按斜面给数（外加循环抖动）。"""

    def __init__(self, sx, sy, *, c=0.0, jitter=(), step_x=None, step_h=0.0,
                 move_fail_at=(), z_fail_at=(), pos=(1.0e-9, -2.0e-9),
                 frame=(0.0, 0.0, 1.0e-7, 1.0e-7, 0.0), pos_error=None, frame_error=None):
        self.sx, self.sy, self.c = sx, sy, c
        self.jitter = tuple(jitter)
        self.step_x, self.step_h = step_x, step_h
        self.move_fail_at = set(move_fail_at)
        self.z_fail_at = set(z_fail_at)
        self.pos = pos
        self.frame = frame
        self.pos_error = pos_error
        self.frame_error = frame_error
        self.cur = pos
        self.moves = 0
        self.reads = 0
        self.calls: "list[Any]" = []

    def safe_call(self, method, *args, **kw):
        err = None
        vals: "list[Any]" = []
        if method == "FolMe_XYPosGet":
            if self.pos_error:
                err = self.pos_error
            else:
                vals = [self.cur[0], self.cur[1]]
        elif method == "Scan_FrameGet":
            if self.frame_error:
                err = self.frame_error
            else:
                vals = list(self.frame)
        elif method == "FolMe_XYPosSet":
            if self.moves in self.move_fail_at:
                err = f"横移被拒(第 {self.moves} 次)"
            else:
                self.cur = (float(args[0]), float(args[1]))
            self.moves += 1
        elif method == "ZCtrl_ZPosGet":
            if self.reads in self.z_fail_at:
                err = f"读 Z 失败(第 {self.reads} 次)"
            else:
                x, y = self.cur
                z = self.sx * x + self.sy * y + self.c
                if self.step_x is not None and x >= self.step_x:
                    z += self.step_h
                if self.jitter:
                    z += self.jitter[self.reads % len(self.jitter)]
                vals = [z]
            self.reads += 1
        else:
            err = f"<未脚本化: {method}>"
        rec = Rec(method, args, error=err, return_value=("", b"", vals) if err is None else None)
        self.calls.append(rec)
        return rec

    def check_abort(self):
        return False


class AbortingZSim(ZSim):
    def __init__(self, *a, abort_after=0, **kw):
        super().__init__(*a, **kw)
        self._abort_after = abort_after
        self._seen = 0

    def check_abort(self):
        self._seen += 1
        return self._seen > self._abort_after


TP_JITTER = (1.0e-12, -0.7e-12, 0.4e-12, -1.1e-12, 0.9e-12, -0.3e-12, 0.6e-12, -0.9e-12)

TP_CASES: "list[tuple[str, str, dict[str, Any], dict[str, Any], bool]]" = [
    ("ok", "主路：12 点、显式半径、噪声底由起点重复读估出来",
     {"radius_m": 2.0e-8, "n_points": 12}, dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER), False),
    ("ok_derived_radius", "不给半径 ⇒ 由扫描框推导（note 里印的是**夹紧之前**的数）",
     {"n_points": 12}, dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER), False),
    ("radius_clamped_high", "扫描框 5 µm ⇒ 推导出 2 µm，夹到 MAX_RADIUS_M",
     {"n_points": 12}, dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER,
                            frame=(0.0, 0.0, 5.0e-6, 5.0e-6, 0.0)), False),
    ("radius_clamped_low", "显式给 1e-12 ⇒ 夹到 MIN_RADIUS_M",
     {"radius_m": 1.0e-12, "n_points": 12}, dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER), False),
    ("explicit_noise", "给了 noise_floor_m ⇒ 一次噪声估计的读都不发",
     {"radius_m": 2.0e-8, "n_points": 12, "noise_floor_m": 1.0e-12},
     dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER), False),
    ("half_center", "只给 center_x_m ⇒ **两个都**被实测位置覆盖（旧仓那一行）",
     {"radius_m": 2.0e-8, "n_points": 12, "center_x_m": 9.9e-8},
     dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER), False),
    ("no_position", "读不到针尖位置 ⇒ 几何解析失败",
     {"radius_m": 2.0e-8, "n_points": 12},
     dict(sx=5.0e-3, sy=-2.0e-3, pos_error="FolMe 读失败"), False),
    ("no_frame", "不给半径而扫描框也读不到 ⇒ 另一句话",
     {"n_points": 12}, dict(sx=5.0e-3, sy=-2.0e-3, frame_error="帧读失败"), False),
    ("move_failures", "两次横移被拒 ⇒ failures 计数，点数仍够",
     {"radius_m": 2.0e-8, "n_points": 12},
     dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER, move_fail_at=(3, 5)), False),
    ("first_move_fails", "**第 0 次**横移被拒 ⇒ 噪声估计被跳过且再也不做 ⇒ 残差否决失效",
     {"radius_m": 2.0e-8, "n_points": 12},
     dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER, move_fail_at=(0,)), False),
    ("too_few_valid", "噪声估计那 8 次读成功、圆上只剩 3 个点成功 ⇒ 有效点不足 8",
     {"radius_m": 2.0e-8, "n_points": 12},
     dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER, z_fail_at=tuple(range(11, 40))), False),
    ("step_on_circle", "圆跨过一道 240 pm 的台阶 ⇒ residual_too_large",
     {"radius_m": 2.0e-8, "n_points": 16, "noise_floor_m": 1.0e-11},
     dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER, step_x=0.0, step_h=2.4e-10), False),
    ("aborted", "用户中止 ⇒ 仍然回起点",
     {"radius_m": 2.0e-8, "n_points": 12}, dict(sx=5.0e-3, sy=-2.0e-3, jitter=TP_JITTER), True),
]

skill_tp = tp.TiltProbeCircle()
for name, why, params, simkw, aborting in TP_CASES:
    _TICK["n"] = 0
    sim = AbortingZSim(abort_after=0, **simkw) if aborting else ZSim(**simkw)
    res = skill_tp.execute(sim, dict(params))
    out["skills"].setdefault("TiltProbeCircle", {})[name] = {
        "why": why,
        "params": plain(params),
        "sim": plain({k: (list(v) if isinstance(v, (tuple, set)) else v)
                      for k, v in simkw.items()}),
        "aborting": aborting,
        "result": plain(result_dict(res)),
        "calls": [[c.method, plain(list(c.args)), c.error or ""] for c in sim.calls],
    }


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    OUT.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT}  ({len(text)} bytes)")
    for section in sorted(out):
        v = out[section]
        if isinstance(v, dict):
            print(f"  {section}: {len(v)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
