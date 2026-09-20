r"""扫描图自动预处理的金样 —— **旧仓 `mast/vision/scan_prep*` 与两个技能真跑一遍**。

与 `export_lattice.py`（批 4b）同一套纪律，这里只补两条本批特有的：

1. **帧一律从 `.sxm` 的字节读回来。** 批 4a 那条教训（两边各按闭式重建，`noise_floor`
   差 `4.4e-14`，原因是**加法结合律**）在这一层更凶：这一批的判据里有
   `argmax`（受限带 FFT 峰）、有 `find_peaks`（高度能级）、有一串阈值比较
   （`line_gain > 1.30` / `sep_over_rough > 3.0` / `row_purity > 0.70`）——
   那种分岔在这里不是「最后一位」，是**换一条分支、换一句话**。
2. **每一格为某一道闸而造。** 批 4b §9② 那一课：一道闸可以被另一道闸挡住，
   于是它永远不做决定，而覆盖率对此一言不发。下面每一张合成帧后面都写着
   「它一个人撑着哪道闸」。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_scan_prep.py
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

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-scanprep-root-"))

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "scan_prep.json"
MAST = require_mast_root()
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402

from mast.skills.builtins.scan_prep import (  # noqa: E402
    AnalyzeScanImage,
    AutoProcessScanBatch,
)
from mast.vision.scan_artifacts import detect_scan_artifacts  # noqa: E402
from mast.vision.scan_prep import (  # noqa: E402
    acquired_row_span,
    apply_flatten,
    dominant_terrace_mask,
    fine_periodic_peak,
    harmonise_batch,
    height_levels,
    line_subtract,
    measure_frame,
    plan_for,
    poly_subtract,
    row_correlation,
)
from mast.vision.scan_prep_thresholds import ScanPrepThresholds, resolve  # noqa: E402
from mast.vision.tip_change import detect_tip_change, lod_dc, row_channels  # noqa: E402
from mast.vision.tip_metrics import _fwd_bwd_instability  # noqa: E402


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
# 合成帧 —— **闭式，零随机数**
# ──────────────────────────────────────────────────────────────────────────

PX = 128          # 2 的幂（批 4b：非 2 的幂走 Bluestein，测试从 1.4 s 涨到 5 s 以上）
NMPP = 0.02       # 2.56 nm 的视野 ⇒ 原子分辨那一档


def _n(sigma: float, seed: int) -> np.ndarray:
    """噪声走 `np.random.default_rng` —— **帧是从 `.sxm` 字节读回来的，两边都不重算它**，
    所以这里用什么发生器都不影响可复现性（用闭式 sin-hash 反而会引入一个强单频分量，
    把 `fine_periodic_peak` 的带内峰变成伪影）。"""
    return np.random.default_rng(seed).standard_normal((PX, PX)) * sigma


def _tilt(gx: float, gy: float) -> np.ndarray:
    i = np.arange(PX, dtype=np.float64)[:, None]
    j = np.arange(PX, dtype=np.float64)[None, :]
    return gx * j + gy * i


def _bow_x(amp: float) -> np.ndarray:
    """**只沿快轴**的碗。

    ⚠️ 为什么不是径向 `i²+j²`：径向碗的**逐行**一阶拟合只能吃掉 `i²` 那一半，
    于是 `line_gain = √2 ≈ 1.414 > 1.30` —— 那张帧会走 `line` 分支，
    **`curved` 那一支永远拿不到输入**。只沿 x 的碗每一行长得一模一样，
    逐行一阶拟合与全局平面拟合减掉的是同一条线 ⇒ `line_gain ≈ 1.000`。
    这是「造一格为某一道闸而造」的字面意思（批 4b §9②）。
    """
    j = (np.arange(PX, dtype=np.float64)[None, :] - (PX - 1) / 2) / PX
    return amp * (j * j) * np.ones((PX, 1))


def _stripes(step_m: float, period_px: float = 96.0, slope: float = 0.8) -> np.ndarray:
    """**斜跨画面**的两层台阶（周期 `period_px`，沿 `x + 0.8y`）。

    ⚠️ 为什么不用 `floor(...)` 的楼梯：楼梯就是一条对角斜坡，**扣平面把它整个吃掉**，
    直方图于是只剩一个峰（实测 `n_peaks = 1`），`step_like` 那一整族拿不到输入。
    周期取 96 px = 1.92 nm，**刻意落在精细周期带（0.15–1.60 nm）之外** ——
    否则色阶那一段会走 `fine` 分支，而 `elif step_like: clip_step` 就没有输入了。
    """
    i = np.arange(PX, dtype=np.float64)[:, None]
    j = np.arange(PX, dtype=np.float64)[None, :]
    return step_m * (np.floor((j + slope * i) / (period_px / 2)) % 2)


def _row_offsets(sigma: float, seed: int) -> np.ndarray:
    """逐行偏置（行间漂移）。"""
    return (np.random.default_rng(seed).standard_normal(PX) * sigma)[:, None] * np.ones((1, PX))


def f_plane() -> np.ndarray:
    """**只扣平面**那一支：倾斜 + 细噪声，行间没有漂移、面不弯。"""
    return _tilt(3e-12, 2e-12) + _n(4e-12, 1)


def f_bow() -> np.ndarray:
    """**bare `curved`** 那一支：`bow_gain 1.51 > 1.15`，而 `line_gain 1.003 < 1.30`、`n_peaks = 1`。"""
    return _tilt(1e-12, 1e-12) + _bow_x(6e-11) + _n(4e-12, 2)


def f_linedrift() -> np.ndarray:
    """`line_gain 2.90 > 1.30` 那一支，且直方图**只有一个峰**（所以不是「行向分层」）。"""
    return _tilt(1e-12, 1e-12) + _row_offsets(1e-11, 3) + _n(4e-12, 3)


def f_rowsplit() -> np.ndarray:
    """
    `row_purity > 0.70` 那一支 —— **行向分层，不是台阶**。

    每 8 行在两个高度之间交替：直方图上照样两个峰（`n_peaks = 2`），
    而**每一行整行**落在其中一侧（`row_purity = 1.0`）。
    旧仓观测的一张残帧就是这个形状，只数峰会把它当台阶去保护，
    然后用宽色阶把真正的精细结构压没。**这一格是那道闸唯一的输入。**

    ⚠️ 第一版是「上半帧高、下半帧低」，那样**扣平面会把台阶拟合成一条 y 斜坡**，
    两簇各自被拉成斜带、直方图并成一个峰（实测 `n_peaks = 1`）。
    交替的块没有净斜率，平面拟合动不了它。
    """
    r = np.arange(PX)[:, None]
    return 2.6e-10 * ((r // 8) % 2).astype(np.float64) * np.ones((1, PX)) + _n(5e-12, 7)


def f_steps_flat() -> np.ndarray:
    """`step_like && !needsLine && !curved` ⇒ **只扣平面**，色阶走 `clip_step`。"""
    return _stripes(2.4e-10) + _n(5e-12, 6)


def f_steps_bow() -> np.ndarray:
    """`step_like && !needsLine && curved` ⇒ **扣二阶曲面**（与 `f_bow` 是两条不同的路）。"""
    return _stripes(2.4e-10) + _bow_x(1.1e-9) + _n(5e-12, 16)


def f_steps_drift() -> np.ndarray:
    """`masked_line`：**有台阶 AND 行漂移显著**。两个条件缺一就换一条分支。"""
    return _stripes(2.4e-10) + _row_offsets(1.4e-10, 5) + _n(5e-12, 5)


def f_lattice() -> np.ndarray:
    """
    `fine_periodic_snr > 15` 那一支：一列 **0.42 nm、37°** 的平面波（避开轴向死区）。

    ⚠️ 它同时是 `step_like`（正弦的值分布是反正弦分布，两端各一个峰）——
    **这一格因此也是「色阶：精细结构优先于台阶」那条纪律唯一的输入**：
    `fine` 与 `step_like` 同时为真时走 `clip_lattice`。
    """
    i = np.arange(PX, dtype=np.float64)[:, None] * NMPP
    j = np.arange(PX, dtype=np.float64)[None, :] * NMPP
    th = math.radians(37.0)
    wave = 1.1e-10 * np.cos(2.0 * np.pi * (j * math.cos(th) + i * math.sin(th)) / 0.42)
    return wave + _tilt(1e-12, 1e-12) + _n(6e-12, 8)


def f_axis_wave() -> np.ndarray:
    """
    **轴向死区**那道闸唯一的输入：同样强的周期结构，但方向是 **0°**（正沿 x 轴）。

    `axis_guard_deg = 20` 把它整个挡在带外 ⇒ `snr` 掉到个位数，色阶不收紧。
    没有这一格，死区那几行**跑得到但从不做决定**（批 4b §9②）。
    """
    j = np.arange(PX, dtype=np.float64)[None, :] * NMPP
    wave = 1.1e-10 * np.cos(2.0 * np.pi * j / 0.42) * np.ones((PX, 1))
    return wave + _n(6e-12, 9)


# ── 伪影那三件要**≥ 1 nm** 的起伏才跑得到（D-SCANART-1 的早退） ──────────────
#
# `detect_scan_artifacts` 开头就是 `if _detrend_rows(fwd).std() < 1e-9: 早退`。
# Z 以**米**计，真机上典型去趋势残差 ~1e−11 ⇒ **这条早退几乎总是成立**，
# 于是 `_oscillation` / `_drift_px` / `_spike_frac` 三件在上面那些 pm 级的帧上
# **一次也没跑过**。下面四张是 nm 级起伏（粗糙表面 / 大台阶，物理上成立），
# 它们是那三件唯一的输入 —— 没有它们，这一批移过来的就是三段没有闸的代码。

def f_ringing() -> np.ndarray:
    """反馈振荡：沿快轴**相干**的条纹 ⇒ 二维谱上一个**落在频率轴上**的强峰。"""
    j = np.arange(PX, dtype=np.float64)[None, :]
    return 3e-9 * np.cos(2.0 * np.pi * j * 11.0 / PX) * np.ones((PX, 1)) + _n(4e-11, 10)


def f_badrows(n_bad: int, seed: int) -> np.ndarray:
    """
    坏扫描线：几行的**行内噪声**放大 30 倍。

    ⚠️ 放大噪声而不是抬高偏置，因为 `measure_frame` 转发的是
    `line_subtract` **之后**的那一段 —— 逐行平场会把偏置整个擦掉，
    于是「抬高一行」的坏行在那条路上**看不见**。行内 std 是擦不掉的。
    """
    a = _n(2e-9, seed)
    rows = [7, 31, 64, 90, 121, 12, 45, 100][:n_bad]
    extra = np.random.default_rng(seed + 100).standard_normal((len(rows), PX)) * 6e-8
    for k, r in enumerate(rows):
        a[r, :] = a[r, :] + extra[k]
    return a


def f_spikes(n: int) -> np.ndarray:
    """孤立单像素尖峰（`spike_frac`）—— 多像素的团不算，所以每一个都是孤点。"""
    a = _n(2e-9, 12)
    rng = np.random.default_rng(1234)
    flat = rng.choice(PX * PX, size=n, replace=False)
    for idx in flat:
        a[int(idx) // PX, int(idx) % PX] += 6.0e-8
    return a


def f_rough() -> np.ndarray:
    """nm 级的粗糙面 —— 漂移那一对的底。"""
    return _n(2e-9, 13)


def f_rough_tilt() -> np.ndarray:
    """
    nm 级粗糙面 + **一个 30 nm 的快轴碗** —— `_oscillation` 里 `rr > 3` 那道闸的唯一输入。

    ⚠️ 第一版放的是**慢轴**斜坡，而 `_detrend_rows` 减的正是逐行中值 ——
    一条沿 y 的斜坡在每一行里是个常数，**被它整个擦掉**（实测：那一格直接走了
    `std < 1e-9` 早退）。沿 x 的碗擦不掉，于是谱心那一坨低频极强。
    不挖掉谱心 ⇒ 轴上最强峰变成那一坨，`severity` 爆表、
    **每一张面弯的帧都报反馈振荡**。
    """
    return _n(1e-9, 25) + _bow_x(3e-7)


def f_badrows_offset() -> np.ndarray:
    """
    nm 级粗糙面 + **八行整体抬高 40 nm** —— `planeDetrendKeepRows` 那道闸的唯一输入。

    上面那张 `f_badrows` 抬的是**行内噪声**（减逐行中值也擦不掉），
    所以它证明不了「保留逐行偏置」这件事。**纯偏置的坏行才证明得了。**
    """
    a = _n(2e-9, 26)
    for r in (5, 19, 33, 52, 70, 88, 104, 119):
        a[r, :] = a[r, :] + 4.0e-8
    return a


def f_rough_weakshift() -> np.ndarray:
    """
    同一片地形的**两个副本叠在一起**：挪 5 px 那份权重 1.0、没挪那份 0.97。

    于是偏移峰 / 零位移峰 = `1 / 0.97 = 1.031` —— **超过 1 而够不到 1.08**，
    正好落在那道闸的两侧之间。这是 `1.08` 这个数唯一做得了决定的一格：
    别的帧上要么远超（真漂移）要么恰好打平（`peak == zeroLag`，连 `> 1.0` 都不成立）。
    """
    a = _n(2e-9, 13)
    return np.roll(a, 5, axis=1) + 0.97 * a + _n(5e-11, 30)


def f_near_flat_badrows() -> np.ndarray:
    """
    几乎死平 + **五行整体抬高 40 nm**（扫穿了的线）—— `badRowFrac` 那条抄近道的早退唯一的输入。

    ⚠️ 它同时是 D-SCANART-1 那句话的活证据：`_detrend_rows` 把行偏置整个擦掉 ⇒
    `std < 1e-9` 早退成立 ⇒ `bad_row_frac` 报 **0**，而这一帧**真的有五条坏行**。
    那个 0 的含义是「**没算**」，不是「没有坏行」。

    ⚠️ 抬高量要**大于 6×(MAD + 1e−9)**：`_bad_rows` 那道 `+ 1e-9` 的防零除
    本身也是一道卡在物理量上的绝对阈（Z 以米计）—— 抬 10 pm 的版本连它都过不去，
    于是那一格连拆掉早退都还是 0（第一版实测：green）。
    """
    a = np.full((PX, PX), 1.234e-9, dtype=np.float64) + _n(4e-13, 31)
    for r in (7, 31, 64, 90, 121):
        a[r, :] = a[r, :] + 4.0e-8
    return a


def f_lattice_big() -> np.ndarray:
    """nm 级、周期 12 px 的条纹 —— `drift_px` 那道「偏移峰要赢零位移峰 8%」的第三格的底。"""
    j = np.arange(PX, dtype=np.float64)[None, :]
    i = np.arange(PX, dtype=np.float64)[:, None]
    return 2e-9 * np.cos(2.0 * np.pi * (j + 0.0 * i) / 12.0) * np.ones((PX, 1)) + _n(2e-10, 27)


def f_lattice_big_alias() -> np.ndarray:
    """
    同一条纹 + **3% 的一格周期副本** ⇒ 偏移峰只比零位移峰高约 3%，**够不到 8%**。

    这正是那道闸防的事：晶格上「平移一个晶格矢量 = 原图」，偏移峰与零位移峰打平，
    而那不是漂移。没有这一格，`1.08` 这个数**从来没有做过一次决定**。
    """
    base = f_lattice_big()
    return base + 0.03 * np.roll(base, 12, axis=1) + _n(2e-10, 28)


def f_rough_farshift() -> np.ndarray:
    """
    同一片地形挪 **40 px**（31% 的边长）—— 中心圆窗那道闸的唯一输入。

    一帧之内的漂移很小，所以搜索限制在中心 15%。放开搜索会把这个远处的峰捡回来，
    报出一个几十像素的「漂移」—— 而下游会照着那个数去补偿硬件。
    """
    return np.roll(_n(2e-9, 13), 40, axis=1) + _n(1e-10, 29)


def f_rough_shift() -> np.ndarray:
    """同一片地形沿快轴挪 **6 px** ⇒ `drift_px = 6`。"""
    return np.roll(_n(2e-9, 13), 6, axis=1) + _n(1e-10, 14)


def f_rough_same() -> np.ndarray:
    """同一片地形没挪 ⇒ `drift_px = 0`（偏移峰赢不过零位移峰那 8%）。"""
    return _n(2e-9, 13) + _n(1e-10, 15)


def f_tipchange() -> np.ndarray:
    """扫到第 78 行针尖变了：此后每一行的 **DC 抬高 600 pm**（单原子台阶量级）。"""
    a = _n(8e-12, 17) + _tilt(1e-12, 1e-12)
    a[78:, :] += 6.0e-10
    return a


def f_noisy() -> np.ndarray:
    """`rowcorr_median < 0.30` 那一支：相邻行之间毫无相关的纯噪声。"""
    return _n(2e-10, 18)


def f_unfinished() -> np.ndarray:
    """
    扫到一半：第 84 行往下全是 NaN。

    它一个人撑着**三**道闸：`nan_annotate` 的标注、`acquired_row_span` 的裁行、
    以及 `uniform_filter` 的**跑动和被 NaN 污染**那一条（见 `ndfilters.ts` 抬头）。
    """
    a = f_lattice()
    a[84:, :] = np.nan
    # ⚠️ 第 84 行**扫了一半**（前 6 个像素有数）—— 这是「正在扫的那一行」的真样子，
    # 而它是 `line_subtract` 那条「可用像素太少的行不拿垃圾拟合、从邻行插值补上」
    # 唯一的输入：整行 NaN 的行连 `polyfit` 的门槛都够不到，走不到那一支。
    a[84, :6] = f_lattice()[84, :6]
    return a


def f_unfinished_top() -> np.ndarray:
    """
    **顶上**没扫到的那 20 行（`SCAN_DIR: up` 归位之后就是这个样子），针尖在第 90 行变。

    它一个人撑着 `measure_frame` 那句「行号换算回**整帧**坐标」：其余每一张帧的
    `r0` 都是 0，于是 `+ r0` 加不加**给出同一个答案**（批 4b §9② 的形状 ——
    一道闸可以被输入挡住，而覆盖率对此一言不发）。
    """
    a = _n(8e-12, 23) + _tilt(1e-12, 1e-12)
    # ⚠️ 第 90 行往下的**行内噪声放大 20 倍**，不是（只是）抬高 DC。
    # `measure_frame` 转发给 `detect_tip_change` 的是 `line_subtract` **之后**那一段，
    # 而逐行平场把每一行的偏置整个擦掉 —— 于是 `dc` 通道对纯 DC 跳变**在这条路上
    # 是瞎的**（实测：`f_tipchange` 那张 600 pm 的跳变在 `measure_frame` 里
    # `dc = −6.285`，判不出来）。纹理变化擦不掉，`rms` / `ncc` 两个通道看得见。
    a[90:, :] = a[90:, :] * 20.0 + 6.0e-10
    a[:20, :] = np.nan
    return a


def f_tiny_band() -> np.ndarray:
    """
    16×16、粗像素 —— 受限带里**只剩三十几个格**，`bandIdx.length < 50` 那道闸的唯一输入。

    其余每一张帧的带里都有上千个格，于是那道闸跑得到但从不做决定。
    带内格子太少时 `max/median` 只是「这几个数里最大的除以中间那个」——
    一个恒在 1 附近的数，**不是信噪比**。
    """
    j = np.arange(16, dtype=np.float64)[None, :]
    i = np.arange(16, dtype=np.float64)[:, None]
    wave = 1.0e-10 * np.cos(2.0 * np.pi * (j * 0.9 + i * 0.6) / 4.0)
    return wave + np.random.default_rng(24).standard_normal((16, 16)) * 5e-12


def f_dead_flat() -> np.ndarray:
    """
    **精确常数** —— `detect_scan_artifacts` 与 `detect_tip_change` 两条早退唯一的输入。

    ⚠️ 它**不进** `measure_frame` / `plan_for` / `apply_flatten` / 技能那几节：
    扣平面之后只剩浮点舍入（~1e−25），而两边的最小二乘是两个算法
    （本仓 `lstsqPlane` 的中心化正规方程 vs numpy 的 SVD）⇒
    `fine_periodic_peak` 的 `argmax` 在两边**完全不同**。
    批 4a §9①：**一个答案是掷骰子的用例不是判据**，而修法是**改输入** ——
    这里的「改输入」就是把它从那几节拿掉（同批 4b 把 `dead_flat` 从
    `lattice_peaks` 一节拿掉）。`f_near_flat` 顶上那一档。
    """
    return np.full((PX, PX), 1.234e-9, dtype=np.float64)


def f_near_flat() -> np.ndarray:
    """几乎死平（0.4 pm 噪声）—— 判据由**真的信号**定，不由舍入定。

    伪影那条早退照样成立（去趋势残差 ~4e−13 < 1e−9），而针尖突变那条不成立
    （`std` 4e−13 > 1e−15）—— 两条早退的**阈值差了三个量级**，这一格把它们分开。
    """
    return np.full((PX, PX), 1.234e-9, dtype=np.float64) + _n(4e-13, 19)


def f_bwd_same() -> np.ndarray:
    """正反扫一致（不稳定度远在 0.50 以下）。"""
    return f_plane() + _n(2e-12, 21)


def f_bwd_diff() -> np.ndarray:
    """正反扫不一致（不稳定度远在 0.50 以上）：换一套完全无关的噪声。"""
    return _n(2e-10, 22) + _tilt(1e-12, 1e-12)


# ──────────────────────────────────────────────────────────────────────────
# `.sxm` 字节
# ──────────────────────────────────────────────────────────────────────────


def sxm_bytes(
    frames: "list[tuple[str, str, list[np.ndarray]]]",
    *,
    nx: int,
    ny: int,
    width_m: float,
    with_range: bool = True,
    scan_dir: str = "down",
    bias: str = "\t20.0E-3",
    setpoint: str = "\t500.0E-12",
) -> bytes:
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
        ":SCAN_OFFSET:", "         0.0E+0         0.0E+0",
        ":SCAN_DIR:", scan_dir,
        ":SCAN_ANGLE:", "       0.000E+0",
        ":SCAN_TIME:", "             6.400E+0             6.400E+0",
        ":DATA_INFO:", "\tChannel\tName\tUnit\tDirection\tCalibration\tOffset",
    ]
    if with_range:
        lines.insert(lines.index(":SCAN_OFFSET:"), rng)
        lines.insert(lines.index(rng), ":SCAN_RANGE:")
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


TMP = tempfile.mkdtemp(prefix="mast-scanprep-sxm-")
BATCH_DIR = Path(TMP) / "batch"
BATCH_DIR.mkdir(parents=True, exist_ok=True)
OUTDIR = Path(TMP) / "out"
OUTDIR.mkdir(parents=True, exist_ok=True)
FILES: "dict[str, bytes]" = {}
PATHS: "dict[str, str]" = {}


def write_file(key: str, raw: bytes, *, folder: Path | None = None) -> str:
    FILES[key] = raw
    p = (folder or Path(TMP)) / f"{key}.sxm"
    p.write_bytes(raw)
    PATHS[key] = str(p).replace("\\", "/")
    return PATHS[key]


def missing_path(name: str) -> str:
    return f"{TMP}/{name}".replace("\\", "/")


def _mirror(a: np.ndarray) -> np.ndarray:
    """反扫块在文件里是**镜像存的**（`sxm_oriented_frames` 会翻回来）。"""
    return a[:, ::-1]


W_M = PX * NMPP * 1e-9

_SINGLE = {
    "plane": f_plane(),
    "bow": f_bow(),
    "linedrift": f_linedrift(),
    "rowsplit": f_rowsplit(),
    "steps_flat": f_steps_flat(),
    "steps_bow": f_steps_bow(),
    "steps_drift": f_steps_drift(),
    "lattice": f_lattice(),
    "axis_wave": f_axis_wave(),
    "ringing": f_ringing(),
    "badrows": f_badrows(5, 11),
    "badrows_offset": f_badrows_offset(),
    "rough_tilt": f_rough_tilt(),
    "badrows_many": f_badrows(8, 11),
    "spikes": f_spikes(40),
    "spikes_many": f_spikes(400),
    "tipchange": f_tipchange(),
    "noisy": f_noisy(),
    "unfinished": f_unfinished(),
    "unfinished_top": f_unfinished_top(),
    "near_flat": f_near_flat(),
    "near_flat_badrows": f_near_flat_badrows(),
    "dead_flat": f_dead_flat(),
}
for _k, _a in _SINGLE.items():
    write_file(_k, sxm_bytes([("Z", "fwd", [_a])], nx=PX, ny=PX, width_m=W_M))

# 16×16、粗像素（0.3 nm/px）—— 见 `f_tiny_band`。
write_file("tiny_band", sxm_bytes([("Z", "fwd", [f_tiny_band()])], nx=16, ny=16, width_m=16 * 0.3e-9))

# 正反扫两块 —— `fb_instability` 与 `drift_px` **只有**在两块都在时才算得出来。
write_file("pair_ok", sxm_bytes(
    [("Z", "both", [f_plane(), _mirror(f_bwd_same())])],
    nx=PX, ny=PX, width_m=W_M))
write_file("pair_bad", sxm_bytes(
    [("Z", "both", [f_plane(), _mirror(f_bwd_diff())])],
    nx=PX, ny=PX, width_m=W_M))
# nm 级粗糙面的一对 —— `drift_px` 那道「偏移峰要赢零位移峰 8%」的闸的**两侧**。
write_file("rough_shift", sxm_bytes(
    [("Z", "both", [f_rough(), _mirror(f_rough_shift())])], nx=PX, ny=PX, width_m=W_M))
write_file("rough_same", sxm_bytes(
    [("Z", "both", [f_rough(), _mirror(f_rough_same())])], nx=PX, ny=PX, width_m=W_M))
write_file("rough_farshift", sxm_bytes(
    [("Z", "both", [f_rough(), _mirror(f_rough_farshift())])], nx=PX, ny=PX, width_m=W_M))
write_file("lattice_alias", sxm_bytes(
    [("Z", "both", [f_lattice_big(), _mirror(f_lattice_big_alias())])], nx=PX, ny=PX, width_m=W_M))
write_file("rough_weakshift", sxm_bytes(
    [("Z", "both", [f_rough(), _mirror(f_rough_weakshift())])], nx=PX, ny=PX, width_m=W_M))

# 没有 `:SCAN_RANGE:` ⇒ 没有像素标度 ⇒ `atomic` 那条**转发判据整个不跑**，
# 而 `delegate_errors['atomic']` 会说清「任何『有没有原子相』的结论都没有根据」。
write_file("no_scale", sxm_bytes([("Z", "fwd", [f_lattice()])],
                                 nx=PX, ny=PX, width_m=W_M, with_range=False))
# 只有电流通道 ⇒ 技能层「没有 'Z' 通道」。
write_file("current_only", sxm_bytes([("Current", "fwd", [f_plane()])],
                                     nx=PX, ny=PX, width_m=W_M))

# 批次一致性用的一组（同视野同偏压，**三张可投票 + 一张台阶帧**）。
# 三张里两张 `line`、一张 `plane` ⇒ 多数票把那张 `plane` 改成 `line`；
# 而台阶那张**既不投票也不被改**。没有这一组，`harmonise_batch` 的豁免那一支
# 跑得到但从不做决定。
for _k, _a in [
    ("g_line_a", f_linedrift()),
    ("g_line_b", f_linedrift() + _n(3e-12, 31)),
    ("g_plane", f_plane()),
    ("g_steps", f_steps_drift()),
]:
    write_file(_k, sxm_bytes([("Z", "fwd", [_a])], nx=PX, ny=PX, width_m=W_M),
               folder=BATCH_DIR)

_LOADED: "dict[str, dict]" = {}


def loaded(key: str, channel: str = "Z") -> dict:
    """用**旧仓的读法**把一份合成的 `.sxm` 读回来（几何归位之后）。"""
    from mast.io.nanonis_files import read_sxm, sxm_oriented_frames

    ck = f"{key}/{channel}"
    if ck not in _LOADED:
        _LOADED[ck] = sxm_oriented_frames(read_sxm(PATHS[key]), channel)
    return _LOADED[ck]


def fwd(key: str) -> np.ndarray:
    return np.asarray(loaded(key)["forward"], dtype=np.float64)


def bwd(key: str) -> "np.ndarray | None":
    b = loaded(key).get("backward")
    return None if b is None else np.asarray(b, dtype=np.float64)


def nmpp(key: str) -> "float | None":
    v = loaded(key)["nm_per_px"]
    return None if v is None else float(v)


TH = resolve(None)

# ──────────────────────────────────────────────────────────────────────────
# 1. 基本量
# ──────────────────────────────────────────────────────────────────────────

PRIMS: "list[dict]" = []
for key in ("plane", "bow", "linedrift", "steps_drift", "rowsplit", "unfinished", "unfinished_top", "near_flat"):
    a = fwd(key)
    p1 = poly_subtract(a, 1)
    p2 = poly_subtract(a, 2)
    ln = line_subtract(a, 1)
    PRIMS.append({
        "frame": key,
        "poly1_std": float(np.nanstd(p1)),
        "poly1_head": _plain(p1[:2, :6]),
        "poly2_std": float(np.nanstd(p2)),
        "poly2_head": _plain(p2[:2, :6]),
        "line_std": float(np.nanstd(ln)),
        "line_head": _plain(ln[:2, :6]),
        "row_corr_head": _plain(row_correlation(ln)[:8]),
        "row_corr_median": _plain(float(np.nanmedian(row_correlation(ln)))
                                  if row_correlation(ln).size else float("nan")),
        "acquired_row_span": list(acquired_row_span(a)),
        "height_levels": _plain(height_levels(p1)),
        "fine_peak": _plain(fine_periodic_peak(ln, nmpp(key) or 0.0, TH)),
    })

# `dominant_terrace_mask` 单列一节：它的输入是**去掉逐行偏置之后**的图，
# 而那一步正是 `apply_flatten('masked_line')` 里那段 148 pm 的实测所在。
MASKS: "list[dict]" = []
for key in ("steps_drift", "steps_flat", "plane", "near_flat"):
    a = fwd(key)
    m = measure_frame(a, nm_per_px=nmpp(key), thresholds=TH)
    base = poly_subtract(a, 1)
    base = base - np.array([[np.median(r[np.isfinite(r)]) if np.isfinite(r).any() else 0.0]
                            for r in base])
    mask = dominant_terrace_mask(base, m._roughness, m._separation)
    MASKS.append({
        "frame": key,
        "roughness": float(m._roughness),
        "separation": float(m._separation),
        "n_true": int(mask.sum()),
        "row_counts": _plain([int(x) for x in mask.sum(axis=1)[:12]]),
    })

# 轴向死区那道闸的**两侧**：37° 的波进带、0° 的波被挡在带外。
FINE: "list[dict]" = []
for key in ("lattice", "axis_wave", "noisy", "plane", "tiny_band"):
    ln = line_subtract(fwd(key), 1)
    FINE.append({"frame": key, "peak": _plain(fine_periodic_peak(ln, nmpp(key) or 0.0, TH))})
# 同一张图换一个死区角度 ⇒ 0° 的波重新进带（这一格证明那个阈值真的在做决定）。
FINE.append({
    "frame": "axis_wave", "guard_deg": 5.0,
    "peak": _plain(fine_periodic_peak(line_subtract(fwd("axis_wave"), 1),
                                      nmpp("axis_wave") or 0.0,
                                      ScanPrepThresholds(axis_guard_deg=5.0))),
})

# ──────────────────────────────────────────────────────────────────────────
# 2. 转发判据本体
# ──────────────────────────────────────────────────────────────────────────

ARTIFACTS: "list[dict]" = []
for key in ("ringing", "badrows", "badrows_many", "badrows_offset", "rough_tilt", "spikes", "spikes_many", "plane", "near_flat", "near_flat_badrows", "dead_flat", "lattice"):
    ARTIFACTS.append({"frame": key, "result": _plain(detect_scan_artifacts(fwd(key)))})
# 带反扫那两格 —— `drift_px` **只有**这时才算得出来。
for key in ("pair_ok", "pair_bad", "rough_shift", "rough_same", "rough_farshift", "rough_weakshift", "lattice_alias"):
    ARTIFACTS.append({"frame": key, "with_bwd": True,
                      "result": _plain(detect_scan_artifacts(fwd(key), bwd=bwd(key)))})

TIPCHANGE: "list[dict]" = []
for key in ("tipchange", "plane", "noisy", "lattice", "near_flat", "dead_flat", "tiny_band"):
    a = fwd(key)
    row: "dict[str, Any]" = {
        "frame": key,
        "result": _plain(detect_tip_change(a, nm_per_px=nmpp(key))),
    }
    # ⚠️ `dead_flat` **不录逐行通道**：`detect_tip_change` 在它上面走早退
    # （`std < 1e-15`），于是这些通道**一次也不会被消费**；而它们的值全是
    # 扣平面之后的浮点舍入（~1e−25），两边的最小二乘是两个算法 ⇒ 掷骰子。
    # 批 4a §9①：一个答案是掷骰子的用例不是判据。
    if key != "dead_flat":
        ch, zrow, _dbg = row_channels(a)
        row["lod_dc"] = _plain(lod_dc(ch["dc"]))
        row["channels"] = {k: _plain(v[:6]) for k, v in sorted(ch.items())}
        row["has_bragg"] = zrow is not None
    TIPCHANGE.append(row)
# 介观那张表 —— `nm_per_px > 0.03` 换表换阈值。**两张表都要有输入。**
TIPCHANGE.append({
    "frame": "tipchange", "nm_per_px": 0.5,
    "result": _plain(detect_tip_change(fwd("tipchange"), nm_per_px=0.5)),
})
# 显式阈值那一支。
TIPCHANGE.append({
    "frame": "plane", "threshold": 0.0,
    "result": _plain(detect_tip_change(fwd("plane"), threshold=0.0, nm_per_px=nmpp("plane"))),
})

FB: "list[dict]" = []
for key in ("pair_ok", "pair_bad", "rough_shift", "rough_same"):
    FB.append({"frame": key, "value": float(_fwd_bwd_instability(fwd(key), bwd(key)))})
FB.append({"frame": "self", "value": float(_fwd_bwd_instability(fwd("plane"), fwd("plane")))})
FB.append({"frame": "dead_flat_self",
           "value": float(_fwd_bwd_instability(fwd("dead_flat"), fwd("dead_flat")))})

# ──────────────────────────────────────────────────────────────────────────
# 3. `measure_frame` / `plan_for` / `apply_flatten`
# ──────────────────────────────────────────────────────────────────────────

MEASURE: "list[dict]" = []
PLANS: "list[dict]" = []
APPLY: "list[dict]" = []

_MEASURE_KEYS = [
    "plane", "bow", "linedrift", "rowsplit", "steps_flat", "steps_bow", "steps_drift",
    "lattice", "axis_wave", "ringing", "badrows", "badrows_many", "spikes",
    "spikes_many", "tipchange", "noisy", "unfinished", "unfinished_top", "near_flat",
    "pair_ok", "pair_bad", "rough_shift", "rough_same", "rough_farshift", "rough_weakshift", "lattice_alias",
    "badrows_offset", "rough_tilt", "no_scale",
]
for key in _MEASURE_KEYS:
    a = fwd(key)
    b = bwd(key)
    m = measure_frame(a, bwd=b, nm_per_px=nmpp(key), thresholds=TH)
    plan = plan_for(m, TH)
    MEASURE.append({"frame": key, "metrics": _plain(m.to_dict())})
    PLANS.append({"frame": key, "override": None, "plan": _plain(plan.to_dict())})
    flat = apply_flatten(a, plan.method, m)
    APPLY.append({
        "frame": key, "method": plan.method,
        "std": float(np.nanstd(flat)),
        "head": _plain(flat[:2, :6]),
        "percentiles": _plain([float(np.nanpercentile(flat, q)) for q in (0.1, 1.0, 50.0, 99.0, 99.9)]),
    })

# 正反扫**形状不一致** —— `delegate_errors["fb_instability"]` 那一支唯一的输入。
# ⚠️ 这一格走不了 `.sxm`（同一份头描述两块，形状必然一致），所以**直接调纯函数**。
# 没有它，`measure_frame` 里那句形状检查跑得到但从不做决定（批 4b §9②）。
_mm = measure_frame(fwd("plane"), bwd=fwd("plane")[:64], nm_per_px=nmpp("plane"), thresholds=TH)
MEASURE.append({"frame": "shape_mismatch", "metrics": _plain(_mm.to_dict())})
PLANS.append({"frame": "shape_mismatch", "override": None, "plan": _plain(plan_for(_mm, TH).to_dict())})

# 四个 override 各走一次 —— 「处理方式由调用方指定」那一支，以及四种 apply。
for method in ("plane", "poly2", "line", "masked_line"):
    a = fwd("steps_drift")
    m = measure_frame(a, nm_per_px=nmpp("steps_drift"), thresholds=TH)
    plan = plan_for(m, TH, override=method)
    PLANS.append({"frame": "steps_drift", "override": method, "plan": _plain(plan.to_dict())})
    flat = apply_flatten(a, method, m)
    APPLY.append({"frame": "steps_drift", "method": method,
                  "std": float(np.nanstd(flat)), "head": _plain(flat[:2, :6])})

# `override` 不认识 ⇒ 抛。
try:
    plan_for(measure_frame(fwd("plane"), nm_per_px=nmpp("plane"), thresholds=TH),
             TH, override="nope")
    _OVERRIDE_ERR = ""
except Exception as exc:  # noqa: BLE001
    _OVERRIDE_ERR = f"{type(exc).__name__}: {exc}"

# ──────────────────────────────────────────────────────────────────────────
# 4. 批次一致性
# ──────────────────────────────────────────────────────────────────────────

HARMONISE: "list[dict]" = []


def _plans_for(keys: "list[str]") -> "list[tuple[object, Any]]":
    out = []
    for k in keys:
        a = fwd(k)
        m = measure_frame(a, nm_per_px=nmpp(k), thresholds=TH)
        out.append((("g", 2.56, 0.02), plan_for(m, TH)))
    return out


_GROUP = ["g_line_a", "g_line_b", "g_plane", "g_steps"]
_before = _plans_for(_GROUP)
_after = harmonise_batch(list(_before), TH)
HARMONISE.append({
    "case": "majority_wins",
    "before": [p.method for _k, p in _before],
    "after": [p.method for p in _after],
    "why_tail": [(p.why[-1] if p.why else "") for p in _after],
})
# 少于 `group_min` 张 ⇒ 不投票。
_two = _plans_for(["g_line_a", "g_plane"])
HARMONISE.append({
    "case": "below_group_min",
    "before": [p.method for _k, p in _two],
    "after": [p.method for p in harmonise_batch(list(_two), TH)],
})
# 全票一致 ⇒ 一个字都不改（`n_win == len(methods)` 那一支）。
_same = _plans_for(["g_line_a", "g_line_b", "g_line_a"])
HARMONISE.append({
    "case": "unanimous",
    "before": [p.method for _k, p in _same],
    "after": [p.method for p in harmonise_batch(list(_same), TH)],
    "why_len": [len(p.why) for p in harmonise_batch(list(_same), TH)],
})
# ⚠️ **可投票的那一半不足** —— `free.length < group_min` 那道闸唯一的输入。
# 四张同组：两张台阶帧豁免 ⇒ 可投票的只剩两张（`line` 与 `plane`）。
# 第一道（`len(idx) < group_min`）在这里**过得去**（4 ≥ 3），所以只有第二道能拦住它。
# 别的用例都被第一道先挡掉了，那道闸于是**从不做决定**（演练第一轮报绿）。
_free_short = _plans_for(["g_line_a", "g_plane", "g_steps", "g_steps"])
HARMONISE.append({
    "case": "free_below_quorum",
    "before": [p.method for _k, p in _free_short],
    "after": [p.method for p in harmonise_batch(list(_free_short), TH)],
})

# 分成两个键 ⇒ 每组各自不足 `group_min`。
_split = [(("a",), _plans_for(["g_line_a"])[0][1]),
          (("a",), _plans_for(["g_line_b"])[0][1]),
          (("b",), _plans_for(["g_plane"])[0][1])]
HARMONISE.append({
    "case": "two_keys",
    "before": [p.method for _k, p in _split],
    "after": [p.method for p in harmonise_batch(list(_split), TH)],
})

# ──────────────────────────────────────────────────────────────────────────
# 5. 阈值 profile
# ──────────────────────────────────────────────────────────────────────────

THRESHOLDS: "dict[str, Any]" = {
    "default": _plain(TH.to_mapping()),
    "numeric_mapping": _plain(dict(sorted(TH.numeric_mapping().items()))),
    "unknown_name": _plain(resolve("no-such-profile").to_mapping()),
    "from_mapping": [],
}
for case, mapping in [
    ("clamps_existing", {"line_gain": 0.5, "bow_gain": 99.0, "step_purity": 2.0}),
    ("drops_nullable_out_of_range", {"corrugation_high_pm": 0.0,
                                     "corrugation_ref_scan_nm": 1e9}),
    ("keeps_nullable_in_range", {"corrugation_high_pm": 40.0,
                                 "corrugation_ref_scan_nm": 100.0}),
    ("explicit_null_stays_null", {"corrugation_high_pm": None}),
    ("unknown_key_ignored", {"nope": 1.0, "line_gain": 2.0}),
    ("meta_fields", {"provenance": "  测过了  ", "name": "x"}),
    ("non_numeric_dropped", {"corrugation_high_pm": "40", "step_sep": "9"}),
]:
    THRESHOLDS["from_mapping"].append({
        "case": case, "mapping": _plain(mapping),
        "result": _plain(ScanPrepThresholds.from_mapping(mapping).to_mapping()),
    })

# ──────────────────────────────────────────────────────────────────────────
# 6. 两个技能
# ──────────────────────────────────────────────────────────────────────────

SKILLS: "dict[str, list]" = {}


def run_skill(name: str, skill: Any, cases: "list[tuple[str, dict]]") -> None:
    rows = []
    for case, params in cases:
        res = skill.execute(None, dict(params))
        row = {
            "case": case, "params": _plain(params),
            "success": bool(res.success), "error": res.error or "",
            "summary": res.summary or "", "data": _plain(res.data or {}),
            "images": _plain(list(res.images or [])),
        }
        rows.append(row)
    SKILLS[name] = rows


# ⚠️ **`save_png` / `render` 一律关掉。** 本仓没有 matplotlib 等价物
# （盘点 D 档：「本仓没有、也不该有 matplotlib 等价物」），于是 `png_path` 恒为空串。
# 旧仓 `_render` 自己也有「画不出来返回空串」那一支，所以形状是对得上的 —— 但
# **录一份带路径的金样就等于录一件本仓做不到的事**，而那不是判据，是噪声。
# 这条登记成 deviation，另由一条 TS 断言钉住「`save_png=true` 时除了 `png_path`
# 与 `images` 之外每一格逐字相同」。
run_skill("AnalyzeScanImage", AnalyzeScanImage(), [
    ("plane", {"scan_path": PATHS["plane"], "channel": "Z"}),
    ("bow", {"scan_path": PATHS["bow"], "channel": "Z"}),
    ("linedrift", {"scan_path": PATHS["linedrift"], "channel": "Z"}),
    ("rowsplit", {"scan_path": PATHS["rowsplit"], "channel": "Z"}),
    ("steps_flat", {"scan_path": PATHS["steps_flat"], "channel": "Z"}),
    ("steps_bow", {"scan_path": PATHS["steps_bow"], "channel": "Z"}),
    ("steps_drift", {"scan_path": PATHS["steps_drift"], "channel": "Z"}),
    ("lattice", {"scan_path": PATHS["lattice"], "channel": "Z"}),
    ("axis_wave", {"scan_path": PATHS["axis_wave"], "channel": "Z"}),
    ("ringing", {"scan_path": PATHS["ringing"], "channel": "Z"}),
    ("badrows_many", {"scan_path": PATHS["badrows_many"], "channel": "Z"}),
    ("spikes_many", {"scan_path": PATHS["spikes_many"], "channel": "Z"}),
    ("tipchange", {"scan_path": PATHS["tipchange"], "channel": "Z"}),
    ("noisy", {"scan_path": PATHS["noisy"], "channel": "Z"}),
    ("unfinished", {"scan_path": PATHS["unfinished"], "channel": "Z"}),
    ("unfinished_top", {"scan_path": PATHS["unfinished_top"], "channel": "Z"}),
    ("near_flat", {"scan_path": PATHS["near_flat"], "channel": "Z"}),
    ("pair_ok", {"scan_path": PATHS["pair_ok"], "channel": "Z"}),
    ("pair_bad", {"scan_path": PATHS["pair_bad"], "channel": "Z"}),
    ("rough_shift", {"scan_path": PATHS["rough_shift"], "channel": "Z"}),
    ("no_scale", {"scan_path": PATHS["no_scale"], "channel": "Z"}),
    ("override_line", {"scan_path": PATHS["plane"], "channel": "Z", "flatten": "line"}),
    ("override_masked", {"scan_path": PATHS["plane"], "channel": "Z", "flatten": "masked_line"}),
    ("unknown_profile", {"scan_path": PATHS["plane"], "channel": "Z",
                         "threshold_profile": "no-such-profile"}),
    ("save_png_true", {"scan_path": PATHS["plane"], "channel": "Z", "save_png": False}),
    ("missing_file", {"scan_path": missing_path("nope"), "channel": "Z"}),
    ("no_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
])

run_skill("AutoProcessScanBatch", AutoProcessScanBatch(), [
    ("group", {"folder": str(BATCH_DIR), "channel": "Z", "render": False,
               "write_report": True, "output_dir": str(OUTDIR)}),
    ("group_override", {"folder": str(BATCH_DIR), "channel": "Z", "flatten": "plane",
                        "render": False, "write_report": False, "output_dir": str(OUTDIR)}),
    ("max_files_1", {"folder": str(BATCH_DIR), "channel": "Z", "render": False,
                     "write_report": False, "output_dir": str(OUTDIR), "max_files": 1}),
    ("no_channel", {"folder": str(BATCH_DIR), "channel": "Nope", "render": False,
                    "write_report": False, "output_dir": str(OUTDIR)}),
    ("not_a_dir", {"folder": missing_path("nope"), "channel": "Z", "render": False,
                   "write_report": False, "output_dir": str(OUTDIR)}),
    ("empty_dir", {"folder": str(OUTDIR), "channel": "Z", "render": False,
                   "write_report": False, "output_dir": str(OUTDIR)}),
])

# 报告正文单独录一份 —— 它是这个技能的产品之一（每一个实测数字 + 每一个决定的理由）。
_REPORT = ""
_rp = OUTDIR / "_report.md"
if _rp.exists():
    _REPORT = _rp.read_text(encoding="utf-8")


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_scan_prep.py 生成 —— 旧仓 mast.vision.scan_prep / "
                 "scan_artifacts / tip_change 与两个技能真跑一遍。帧是合成的（闭式公式，"
                 "零随机数），一律从 .sxm 的字节读回来，读法归旧仓。",
        "versions": {"numpy": np.__version__},
        "sxm_files": {k: base64.b64encode(v).decode("ascii") for k, v in FILES.items()},
        "primitives": _plain(PRIMS),
        "terrace_mask": _plain(MASKS),
        "fine_peak": _plain(FINE),
        "scan_artifacts": _plain(ARTIFACTS),
        "tip_change": _plain(TIPCHANGE),
        "fb_instability": _plain(FB),
        "measure_frame": _plain(MEASURE),
        "plan_for": _plain(PLANS),
        "plan_override_error": _OVERRIDE_ERR,
        "apply_flatten": _plain(APPLY),
        "harmonise_batch": _plain(HARMONISE),
        "thresholds": _plain(THRESHOLDS),
        "report_md": _REPORT,
        "skills": _plain(SKILLS),
    }
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    text = text.replace(str(BATCH_DIR).replace("\\", "/"), "<batch>")
    text = text.replace(json.dumps(str(BATCH_DIR))[1:-1], "<batch>")
    text = text.replace(str(OUTDIR).replace("\\", "/"), "<out>")
    text = text.replace(json.dumps(str(OUTDIR))[1:-1], "<out>")
    text = text.replace(json.dumps(TMP)[1:-1], "<tmp>")
    text = text.replace(TMP.replace("\\", "/"), "<tmp>")
    text = re.sub(r"\[WinError [^\"]*", "<oserror>", text)
    text = re.sub(r"\[Errno [^\"]*", "<oserror>", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((text + "\n").encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(doc) - 2} 节 · {kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
