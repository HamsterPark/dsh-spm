r"""晶格判据底座的金样 —— **旧仓 `mast/vision/lattice_*` 与 `frame_texture` 真跑一遍**。

与 `export_analysis.py` 同一套纪律（那份的抬头是原文），这里只补三条本批特有的：

1. **帧一律从 `.sxm` 的字节读回来。** 批 4a 的交接里记着为什么：第一版两边各按
   同一个闭式重建帧，`noise_floor` 分岔了 `4.4e-14`，而原因是**加法结合律**
   （numpy 先把中间量算成整个数组）。这一批的判据里有 `argmax`、有 `median`、
   有阈值比较 —— 那种分岔在这一层不是「最后一位」，是**换一个峰**。
2. **这一份自己开一台，不往 `export_analysis.py` 里插。** 那份文件是批 4a 的，
   而三条支线同时跑（`batch-4a.md` 第 10 节那条提醒）。新开一台的代价是重复
   四十行合成器，收益是**零冲突**，而且这一节的帧与那一节没有一格共用。
3. **`superstructure_test` 用 `np.random.default_rng(0)`，而本仓复现得了它。**
   `rng.ts` 的抬头写着「numpy 走 PCG64，复现它要实现一个 128 位状态的 LCG」——
   这一批把它实现了（`numerics/src/pcg64.ts`），**逐位相同**。所以这一节照录，
   不绕开。绕开的代价是那 8 个空白对照落在别处，而判决就是「候选 ÷ 对照最大值」。

    python \
        tools/spec-export/export_lattice.py
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

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-lattice-export-"))

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "lattice.json"
MAST = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402

from mast.skills.builtins.atomic_lattice import (  # noqa: E402
    AnalyseAtomicLattice,
    AssessAtomicResolution,
)
from mast.skills.builtins.lattice_cell_skill import MeasureLatticeCell  # noqa: E402
from mast.skills.builtins.scan_texture import AssessScanTexture  # noqa: E402
from mast.vision.atomic_phase import (  # noqa: E402
    angular_concentration,
    assess_atomic_phase,
    fast_axis_period_nm,
    order_ratio,
    scale_gate,
)
from mast.vision.frame_texture import (  # noqa: E402
    lattice_amplitude_pm,
    streak_amplitude_pm,
    tile_lattice_map,
)
from mast.vision.imaging_window import check_atomic_window  # noqa: E402
from mast.vision.lattice_calibration import (  # noqa: E402
    find_lattice_peaks,
    first_order_period_nm,
)
from mast.vision.lattice_cell import (  # noqa: E402
    combine_up_down,
    measure_cell,
    superstructure_test,
)
from mast.vision.seg_scale_adaptive import DEFAULTS, detect_texture, flatten_robust  # noqa: E402
from mast.vision.tip_metrics import _detrend, _fft_sharpness  # noqa: E402


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
    if hasattr(v, "__dict__") or hasattr(v, "__dataclass_fields__"):
        return _plain({k: getattr(v, k) for k in v.__dataclass_fields__})
    return str(v)


# ──────────────────────────────────────────────────────────────────────────
# 合成帧 —— **闭式，零随机数**
# ──────────────────────────────────────────────────────────────────────────


def _hash_noise(ny: int, nx: int, amp: float, salt: float) -> np.ndarray:
    """可复现的「噪声」（与 `export_analysis.py` 同一条 sin-hash）。"""
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    v = np.sin(i * 12.9898 + j * 78.233 + salt * 37.719) * 43758.5453123
    return amp * (2.0 * (v - np.floor(v)) - 1.0)


def _wave(ny: int, nx: int, nmpp: float, period_nm: float, angle_deg: float,
          amp: float, phase: float = 0.0) -> np.ndarray:
    """一列平面波 `amp·cos(2π(x·cosθ + y·sinθ)/period + phase)`，x/y 以 nm 计。"""
    i = np.arange(ny, dtype=np.float64)[:, None] * float(nmpp)
    j = np.arange(nx, dtype=np.float64)[None, :] * float(nmpp)
    th = math.radians(float(angle_deg))
    return amp * np.cos(2.0 * np.pi * (j * math.cos(th) + i * math.sin(th)) / float(period_nm) + phase)


#: 帧的边长（像素）。三条约束定死了它，而**第三条是这一批自己撞出来的**：
#:
#: 1. `measure_cell` 的长周期端跟着**帧宽**收（`width_nm / _MIN_PERIODS_IN_FRAME`），
#:    所以帧至少要装得下 12 个晶格周期；
#: 2. `find_lattice_peaks` 的一阶峰落在半径 `width_nm / period_nm` 上，
#:    而 `_RIDGE_SPAN_PX = (9, 18)` 要求那个半径**离 9–18 这个窗足够远**，
#:    否则一个真峰会把隔壁那个真峰采成自己的「脊邻居」；
#: 3. **必须是 2 的幂。** 本仓的 `fft` 只对 2 的幂走 radix-2，别的长度走
#:    **Bluestein**（补零到 ≥ 2n−1 的下一个 2 的幂，再做三次变换）。
#:    第一版取 192（= 2⁶·3），于是每一次长度 192 的变换实际上是三次长度 512 的变换 ——
#:    `assessAtomicPhase` 那一格从 1.4 秒涨到 **超过 5 秒的 vitest 缺省超时**。
#:    换成 256 之后**帧更大而测试更快**（实测整份从 45 秒回到 9 秒）。
#:    ⚠️ 这不是「优化」：一个因为超时而没跑完的测试，与一个「绿的」测试，
#:    在汇总行上长得不一样但同样没有验到东西（批 3d 那条「挂住 ≠ 通过」）。
PX = 256

#: 矩形族的边长。它比 `PX` 小一档，因为那一族的用例多（四张）而每张的判据一样。
PX_RECT = 128

#: 六角帧的像素尺度（nm/px）。`< 0.02` ⇒ `scale_gate` 判 `full`。
HEX_NMPP = 5.0 / PX           # = 0.01953125
#: 矩形帧的像素尺度。`> 0.05` ⇒ `scale_gate` 判 `off`；该档位来自参考系统观测，
#: 而 `measure_cell` 按**每周期像素数**判，两者不冲突（那条警告就在这一格上）。
RECT_NMPP = 8.0 / PX_RECT     # = 0.0625
#: 过渡带（0.02–0.05）—— `scale_reduced` 那一对用例专用。
RED_NMPP = 8.0 / PX           # = 0.03125


def _wave_k(ny: int, nx: int, nmpp: float, kx: float, ky: float,
            amp: float, phase: float = 0.0) -> np.ndarray:
    """按**倒格矢**（nm⁻¹）造一列平面波。"""
    i = np.arange(ny, dtype=np.float64)[:, None] * float(nmpp)
    j = np.arange(nx, dtype=np.float64)[None, :] * float(nmpp)
    return amp * np.cos(2.0 * np.pi * (j * float(kx) + i * float(ky)) + float(phase))


def frame_hex(ny: int = PX, nx: int = PX, nmpp: float = HEX_NMPP,
              d_nm: float = 0.2498, amp: float = 60e-12, angle0: float = 0.0,
              noise: float = 3e-12) -> np.ndarray:
    """六角晶格：三组波矢各差 60°，周期 = 原子**行间距**。

    幅值给得比噪声高一个量级 —— 这是**判据**不是审美：`find_lattice_peaks` 的
    取峰是 `argmax`，一个冠军只领先一两个计数的金样，它的答案由最后一位浮点决定
    （批 4a 那四次「掷骰子」）。这里冠军领先两个量级。
    """
    z = 1.0e-9 + 1.2e-12 * np.arange(ny, dtype=np.float64)[:, None] \
        + 0.7e-12 * np.arange(nx, dtype=np.float64)[None, :]
    for k in range(3):
        z = z + _wave(ny, nx, nmpp, d_nm, angle0 + 60.0 * k, amp, 0.3 * k)
    return z + _hash_noise(ny, nx, noise, 11.0)


def _rect_basis(a1: float, a2: float, gamma: float, a1_angle: float):
    """实空间 (a₁, a₂, γ) → 两个**倒格矢**（nm⁻¹）。

    `b₁ ⊥ a₂`、`|b₁| = 1/(a₁ sinγ)`；`b₂ ⊥ a₁`、`|b₂| = 1/(a₂ sinγ)`。
    写成这个形状是为了让金样里的 `a1_nm` / `a2_nm` / `gamma_deg`
    **可以和源里的那三个数直接对**（第一版按「周期 + 角度」拼，两者差一个 sinγ，
    量出来的数对不上源，于是分不清是判据错了还是合成错了）。
    """
    g = math.radians(gamma)
    ang1 = math.radians(a1_angle + gamma - 90.0)
    ang2 = math.radians(a1_angle + 90.0)
    n1 = 1.0 / (a1 * math.sin(g))
    n2 = 1.0 / (a2 * math.sin(g))
    return ((n1 * math.cos(ang1), n1 * math.sin(ang1)),
            (n2 * math.cos(ang2), n2 * math.sin(ang2)))


def frame_rect(ny: int = PX_RECT, nx: int = PX_RECT, nmpp: float = RECT_NMPP,
               a1: float = 0.401, a2: float = 0.364, gamma: float = 91.0,
               a1_angle: float = 12.0, amp: float = 25e-12,
               noise: float = 2e-12, drift: float = 0.0,
               harmonic: float = 0.30, spurious: float = 0.0) -> np.ndarray:
    """近矩形原胞（参考表面的形状）—— `measure_cell` 的主用例。

    `drift` 把 a₂ 沿慢轴拉伸 `1+drift`，用来造上下扫那一对（`combine_up_down`
    消掉的就是它）。

    `harmonic` 加一个 **2b₁ 的二阶谐波**。它不是装饰：没有它，选出的那一对基矢
    只指标上了它自己（`indexed == 2`），而 `combine_up_down` 的 `min_indexed=3`
    会把这样的帧**全部剔掉** —— 也就是说金样里那条主路径一格都走不到。
    真机上二阶谐波本来就在，`_best_indexing_pair` 的「基矢自己必须是强峰」
    那一道正是为它写的。
    """
    (b1x, b1y), (b2x, b2y) = _rect_basis(a1, a2 * (1.0 + drift), gamma, a1_angle)
    z = 1.0e-9 + 0.9e-12 * np.arange(ny, dtype=np.float64)[:, None]
    z = z + _wave_k(ny, nx, nmpp, b1x, b1y, amp, 0.0)
    z = z + _wave_k(ny, nx, nmpp, b2x, b2y, amp * 0.85, 0.7)
    if harmonic:
        z = z + _wave_k(ny, nx, nmpp, 2 * b1x, 2 * b1y, amp * harmonic, 1.3)
    if spurious:
        # 一个**非公度**的杂峰（条纹脊的残留 / 双针尖回声都长这样）。
        # 它进候选池但指标不上，于是 `indexed = 2 / indexed_total = 3` ——
        # 「这一对基矢只指标上了它自己」那条告警**只有这种帧走得到**：
        # 没有它，池里只有两个候选，`indexed_total > 2` 不成立，告警是死的。
        z = z + _wave(ny, nx, nmpp, 0.311, 55.0, amp * spurious, 2.1)
    return z + _hash_noise(ny, nx, noise, 29.0)


def frame_rect_super(ny: int = PX_RECT, nx: int = PX_RECT, strong: float = 8e-12,
                     weak: float = 7.4e-14) -> np.ndarray:
    """矩形原胞 **+ 两个半序调制** —— `superstructure_test` 的三个判决各走一格。

    | 位置 | 幅值 | 落在哪 | 判决 |
    |---|---|---|---|
    | `(0, ½)` | 8 pm | 周期 0.728 nm，**在搜索带内** | `present` |
    | `(½, 0)` | 0.074 pm | 周期 0.802 nm，**带外** | `undetermined` |
    | `(½, ½)` | —— | 什么都没加 | `absent` |

    两条设计上的约束，缺一条这一格就废了：

    1. **强的那个必须占不到候选总功率的 10%**（`_INDEX_POWER_MIN = 0.90`）。
       超了 `_best_indexing_pair` 会把 `b₂/2` 当成基矢，报出一个**双倍**的原胞
       —— 第一版给 14 pm 正是这样，`a₁` 报成 0.8011 nm。那是真实行为，但它把
       「超结构检验」那一格变成了「原胞加倍」那一格，两件事混在一起。
    2. **弱的那个要落在搜索带外**（0.802 nm > 带上界 0.80）。带内的话它是一个
       候选峰，而一个 0.04 pm 的候选峰会被脊判据与指标化怎么处理，取决于噪声
       的最后一位 —— 那是掷骰子。带外就只有 `superstructure_test` 的细网格
       看得见它，而那一步是**连续**的。
    """
    (b1x, b1y), (b2x, b2y) = _rect_basis(0.401, 0.364, 91.0, 12.0)
    z = frame_rect(ny, nx)
    z = z + _wave_k(ny, nx, RECT_NMPP, 0.5 * b2x, 0.5 * b2y, strong, 0.0)
    z = z + _wave_k(ny, nx, RECT_NMPP, 0.5 * b1x, 0.5 * b1y, weak, 0.4)
    return z


def frame_stripe_clean(ny: int = PX_RECT, nx: int = PX_RECT, nmpp: float = RECT_NMPP,
                       period_nm: float = 0.40, angle_deg: float = 23.0) -> np.ndarray:
    """**干净的一维条纹 + 它的二次谐波** —— `no_independent_pair` 那一支专用。

    这一格不是「再来一张条纹」：`frame_stripe`（相位游走的横带）的极大被脊判据
    剔光，走的是 `too_few_refined_peaks`；要走到「找到的峰全都近乎共线」那一支，
    需要**两个紧致的、方向相同的**峰 —— 也就是一条相干的正弦条纹加上它的谐波。

    两个周期都必须落在搜索带里：`p ≥ 2 × 0.18` 且 `p ≤ 视野 / 12` ⇒ 视野 ≥ 4.32 nm。
    5 nm / 160 px 正好装得下（0.40 与 0.20 nm，各占 12.8 与 6.4 个像素）。
    """
    z = 1.0e-9 + 0.6e-12 * np.arange(ny, dtype=np.float64)[:, None]
    z = z + _wave(ny, nx, nmpp, period_nm, angle_deg, 45e-12, 0.0)
    z = z + _wave(ny, nx, nmpp, period_nm / 2.0, angle_deg, 16e-12, 0.9)
    return z + _hash_noise(ny, nx, 1e-12, 53.0)


def frame_tri_skew(ny: int = PX_RECT, nx: int = PX_RECT, nmpp: float = 5.0 / PX_RECT,
                   long_wave_nm: float = 1.43, long_amp: float = 300e-12) -> np.ndarray:
    """**三个方向但不是六重** + 一列长波 —— 两道闸各缺一格，这一张两道都补上。

    | 这一格喂给谁 | 为什么别的帧喂不了 |
    |---|---|
    | 「六重对称要**三个**夹角都在 60°±8°」 | 三个方向取 0° / 62° / 140° ⇒ 夹角 63.4 / 78.4 / 38.2：**恰好一个在容差里**。别的帧要么三个都在（hex），要么一个都不在（rect）—— 于是 `every → some` 这个变异在它们身上**同解** |
    | 「谱心 7×7 抹零」 | 长波周期 1.43 nm ⇒ 半径 `5/1.43 ≈ 3.5`，**落在那个 7×7 里**。默认带（上界 0.80 nm）够不到它，所以这一张要配一个把带放宽到 2.0 nm 的用例 |

    `long_amp` 给 300 pm（比晶格的 50 pm 大一档）：抹零那道闸挡的正是「一个比真峰
    还高的低频结构」，给小了它压根不会赢，那条闸照样没人验。
    """
    z = 1.0e-9 + 0.8e-12 * np.arange(ny, dtype=np.float64)[:, None]
    for k, (ang, per) in enumerate([(0.0, 0.30), (62.0, 0.32), (140.0, 0.28)]):
        z = z + _wave(ny, nx, nmpp, per, ang, 50e-12, 0.4 * k)
    z = z + _wave(ny, nx, nmpp, long_wave_nm, 30.0, long_amp, 0.0)
    return z + _hash_noise(ny, nx, 2e-12, 71.0)


def frame_stripe(ny: int = 128, nx: int = 128, nmpp: float = 2.43 / 128,
                 amp: float = 1.0e-12, noise: float = 3e-14) -> np.ndarray:
    """**平滑横带 + 相位游走** —— 0569 那一帧的形状（脊判据与快轴判据的用例）。

    它拿得到很高的角向集中度，而剖面只有几 pm；判据要靠脊分与半径散布把它拦下。

    ⚠️ `amp` 有**两档，而且两档都要录**：`peaks_not_one_lattice` 的条件是
    「半径散布 > 0.20 **并且** 起伏 ≥ 40 pm」—— 安静的那一张（1 pm，0569 的真形状）
    走不到它，响亮的那一张（150 pm）才走得到。
    一格分辨不出「并且」的两半，那条闸就有一半没人在验。
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    z = 1.0e-9 + amp * np.cos(2.0 * np.pi * i / 10.0 + 0.9 * np.sin(2.0 * np.pi * j / 90.0))
    return z + _hash_noise(ny, nx, noise, 41.0)


def frame_noise(ny: int = 128, nx: int = 128, salt: float = 5.0) -> np.ndarray:
    """没有任何周期结构 —— `not_a_lattice` / `too_few_peaks` 那一支。

    ⚠️ `salt` 有**两个值，两个都要录**：`detect_texture` 的信噪门（`lat_snr = 4`）
    要一格在门上、一格在门下才分得开 ——

    * `salt = 5` ⇒ 带内峰的信噪 **5.54**（在门上）⇒ 有 `atomic`，出局词里**没有**
      `no_lattice_peak`；
    * `salt = 13` ⇒ 信噪 **2.58**（在门下）⇒ `atomic` 是 `None`，多一条 `no_lattice_peak`。

    只录前者的话，「信噪门」这道闸拆掉之后**每一格的答案都不变** ——
    第一轮的变异演练正是这么绿的。
    """
    return 1.0e-9 + _hash_noise(ny, nx, 8e-12, salt)


def frame_dead_flat(ny: int = 64, nx: int = 64) -> np.ndarray:
    """带倾斜的死平帧 —— `dead_flat` 那一支。"""
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    return 1.0e-9 + 1e-12 * i + 4e-13 * j


def frame_half(ny: int = PX, nx: int = PX) -> np.ndarray:
    """只扫了四成的帧 —— 后面那些行是**全零**（活体缓冲的真实形态）。"""
    z = frame_hex(ny, nx)
    z[int(ny * 0.4):, :] = 0.0
    return z


def frame_tiny(ny: int = 24, nx: int = 24) -> np.ndarray:
    """短边 < 32 —— `image_too_small` 那一支。"""
    return frame_hex(ny, nx)


# ──────────────────────────────────────────────────────────────────────────
# `.sxm` 合成器（与 `export_analysis.py` 同一套字节口径）
# ──────────────────────────────────────────────────────────────────────────


def sxm_bytes(
    frames: "list[tuple[str, str, list[np.ndarray]]]",
    *,
    nx: int,
    ny: int,
    width_m: float,
    with_range: bool = True,
    scan_dir: str = "down",
    # 缺省工作点取**原子分辨那一档**（0.02 V / 500 pA，`ATOMIC_WORKING_POINT`）。
    # 第一版照抄 `export_analysis.py` 的 −1.0 V / 100 pA，于是
    # `check_atomic_window` 对**每一格**都判 `bias_out_of_atomic_window`，
    # `AssessAtomicResolution` 十一格全部 `undetermined` —— 一整个技能的
    # 主路径被一个头字段挡在门外，而每一格看起来都「有结果」。
    bias: str = "\t20.0E-3",
    setpoint: str = "\t500.0E-12",
    acq_time: str = "          12.8",
) -> bytes:
    rng = f"{width_m:>22.6E}{width_m:>22.6E}"
    lines: "list[str]" = [
        ":NANONIS_VERSION:", "2",
        ":SCANIT_TYPE:", "              FLOAT            MSBFIRST",
        ":REC_DATE:", " 15.09.2026",
        ":REC_TIME:", "12:34:56",
        ":ACQ_TIME:", acq_time,
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
        # ⚠️ **少了 `:SCAN_RANGE:` 的文件不是坏文件**，它只是没有像素标度。
        # 两个技能族对这件事的处置**不一样**，而那不是笔误：
        # `_sxm_frame.load_frame` 报「文件头里没有像素标度」当场退出；
        # `atomic_lattice._load_frame` 把 `None` 原样传下去，于是判据环报
        # `unknown_pixel_size` —— 一条**机器可判**的出局词，比一句中文错误串有用。
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


TMP = tempfile.mkdtemp(prefix="mast-lattice-sxm-")
FILES: "dict[str, bytes]" = {}
PATHS: "dict[str, str]" = {}


def write_file(key: str, raw: bytes) -> str:
    FILES[key] = raw
    p = Path(TMP) / f"{key}.sxm"
    p.write_bytes(raw)
    PATHS[key] = str(p).replace("\\", "/")
    return PATHS[key]


def missing_path(name: str) -> str:
    return f"{TMP}/{name}".replace("\\", "/")


def _mirror(a: np.ndarray) -> np.ndarray:
    """反扫块在文件里是**镜像存的**（`sxm_oriented_frames` 会翻回来）。"""
    return a[:, ::-1]


def both(a: np.ndarray) -> "list[np.ndarray]":
    return [a, _mirror(a)]


# 一次写完，后面每一节都从字节读回来。
#
# ⚠️ **只有 `hex` 存两个方向**（Direction 列写 `both`），其余写 `fwd` 只存一帧。
# 两个理由，都是判据不是省事：
#   ① `.sxm` 的字节占这份金样九成体积，而只有 `AssessAtomicResolution` 读反扫；
#   ② `fwd` 这个 Direction 值**本身是一条判据** —— 旧读取器一律按「先 forward
#      再 backward」消费两帧，一个单方向通道之后**后面每个通道都移位**
#      （`sxm.ts` 抬头那条 2026-07-03）。两边的读法在这批字节上各走一次。
write_file("hex", sxm_bytes([("Z", "both", both(frame_hex()))],
                            nx=PX, ny=PX, width_m=5e-9))
write_file("hex_rot", sxm_bytes([("Z", "fwd", [frame_hex(angle0=17.0)])],
                                nx=PX, ny=PX, width_m=5e-9))
write_file("hex_reduced", sxm_bytes([("Z", "fwd", [frame_hex(nmpp=RED_NMPP)])],
                                    nx=PX, ny=PX, width_m=8e-9))
write_file("rect_down", sxm_bytes([("Z", "fwd", [frame_rect(drift=+0.0021)])],
                                  nx=PX_RECT, ny=PX_RECT, width_m=8e-9, scan_dir="down"))
write_file("rect_up", sxm_bytes([("Z", "fwd", [frame_rect(drift=-0.0021)])],
                                nx=PX_RECT, ny=PX_RECT, width_m=8e-9, scan_dir="up"))
write_file("rect_super", sxm_bytes([("Z", "fwd", [frame_rect_super()])],
                                   nx=PX_RECT, ny=PX_RECT, width_m=8e-9))
# **没有二阶谐波、外加一个非公度杂峰**的那一张 ⇒ 选出的基矢只指标上了它自己
# （`indexed = 2 / indexed_total = 3`）。它是「这一对只解释了它自己」那条告警
# **唯一**走得到的路 —— 别的帧上 `indexed` 都是 3，于是那条告警没有人在验。
write_file("rect_weak", sxm_bytes([("Z", "fwd", [frame_rect(harmonic=0.0, spurious=0.32)])],
                                  nx=PX_RECT, ny=PX_RECT, width_m=8e-9, scan_dir="down"))
write_file("stripe_clean", sxm_bytes([("Z", "fwd", [frame_stripe_clean()])],
                                     nx=PX_RECT, ny=PX_RECT, width_m=8e-9))
write_file("stripe", sxm_bytes([("Z", "fwd", [frame_stripe()])],
                               nx=128, ny=128, width_m=2.43e-9))
# 同一个形状、响一百五十倍 —— 「半径散布 > 0.20 **并且** 起伏 ≥ 40 pm」的另一半。
write_file("stripe_loud", sxm_bytes([("Z", "fwd", [frame_stripe(amp=150e-12, noise=3.75e-12)])],
                                    nx=128, ny=128, width_m=2.43e-9))
write_file("tri_skew", sxm_bytes([("Z", "fwd", [frame_tri_skew()])],
                                 nx=PX_RECT, ny=PX_RECT, width_m=5e-9))
write_file("noise", sxm_bytes([("Z", "fwd", [frame_noise()])],
                              nx=128, ny=128, width_m=2.5e-9))
# 同一种噪声、换一个 salt ⇒ 带内峰的信噪掉到门下（5.54 → 2.58）。见 `frame_noise`。
write_file("noise_weak", sxm_bytes([("Z", "fwd", [frame_noise(salt=13.0)])],
                                   nx=128, ny=128, width_m=2.5e-9))
write_file("dead_flat", sxm_bytes([("Z", "fwd", [frame_dead_flat()])],
                                  nx=64, ny=64, width_m=1.2e-9))
# ⚠️ `half` 必须用**大**的那一档（256）。128 px 的版本裁掉未扫的行之后只剩 76 行，
# 于是 `detect_texture` 的可搜周期上限 `min(H,W)/4 = 19 px` 把晶格那根谱线挤出了
# 搜索区间 ⇒ `angular_concentration = 0`、只报 `not_a_lattice`。
# 那样这一格就再也走不到 `peaks_not_one_lattice`（「半径散布要在全部局部极大上算」
# 那条判据**唯一**的用例），而它正是 2026-08-24 那句「一条修复删掉了另一条修复
# 赖以工作的证据」的钉子。**一格走不到那条闸的金样，等于那条闸没有人在验。**
write_file("half", sxm_bytes([("Z", "fwd", [frame_half()])],
                             nx=PX, ny=PX, width_m=5e-9))
write_file("tiny", sxm_bytes([("Z", "fwd", [frame_tiny()])],
                             nx=24, ny=24, width_m=0.47e-9))
# 像素太粗：10 nm / 128 px = 0.078 nm/px ⇒ `scale_gate` 判 `off`。
write_file("coarse", sxm_bytes([("Z", "fwd", [frame_hex(128, 128, 10.0 / 128)])],
                               nx=128, ny=128, width_m=10e-9))
# 工作点在原子分辨窗口之外（偏压 1.0 V）—— 2026-08-26 那一次。
write_file("hex_badbias", sxm_bytes([("Z", "fwd", [frame_hex()])],
                                    nx=PX, ny=PX, width_m=5e-9, bias="\t1.0000E+0"))
# 头里没有 `:SCAN_RANGE:` ⇒ 没有像素标度。两个技能族的处置不同，见 `sxm_bytes`。
write_file("no_scale", sxm_bytes([("Z", "fwd", [frame_hex(64, 64)])],
                                 nx=64, ny=64, width_m=1.25e-9, with_range=False))
# 只有电流通道 ⇒ 「没有通道 'Z' 的正扫数据」。
write_file("current_only", sxm_bytes([("Current", "fwd", [frame_hex(64, 64)])],
                                     nx=64, ny=64, width_m=1.25e-9))

_LOADED: "dict[str, np.ndarray]" = {}


def loaded(key: str, channel: str = "Z", direction: str = "forward") -> np.ndarray:
    """用**旧仓的读法**把一份合成的 `.sxm` 读回来（几何归位之后）。"""
    from mast.io.nanonis_files import read_sxm, sxm_oriented_frames

    ck = f"{key}/{channel}/{direction}"
    if ck not in _LOADED:
        fr = sxm_oriented_frames(read_sxm(PATHS[key]), channel)
        _LOADED[ck] = np.asarray(fr[direction], dtype=np.float64)
    return _LOADED[ck]


def nmpp_of(key: str, channel: str = "Z") -> float:
    from mast.io.nanonis_files import read_sxm, sxm_oriented_frames

    return float(sxm_oriented_frames(read_sxm(PATHS[key]), channel)["nm_per_px"])


# ──────────────────────────────────────────────────────────────────────────
# 1. 条件数 —— 容差写在它上面，所以它必须**随金样一起录**
# ──────────────────────────────────────────────────────────────────────────


def _plane_cond(ny: int, nx: int) -> float:
    gy, gx = np.mgrid[:ny, :nx]
    A = np.column_stack([gx.ravel().astype(float), gy.ravel().astype(float), np.ones(ny * nx)])
    return float(np.linalg.cond(A))


def _vander_cond(ny: int, nx: int, order: int = 2) -> float:
    yy, xx = np.mgrid[0:ny, 0:nx]
    x = (xx / nx - 0.5).ravel()
    y = (yy / ny - 0.5).ravel()
    cols = [np.ones_like(x)]
    for o in range(1, order + 1):
        for i in range(o + 1):
            cols.append(x ** (o - i) * y ** i)
    return float(np.linalg.cond(np.column_stack(cols)))


CONDITION = {
    "plane_256x256": _plane_cond(PX, PX),
    "plane_128x128": _plane_cond(128, 128),
    "plane_64x64": _plane_cond(64, 64),
    "plane_24x24": _plane_cond(24, 24),
    "vander2_256x256": _vander_cond(PX, PX),
    "vander2_128x128": _vander_cond(128, 128),
    "vander2_64x64": _vander_cond(64, 64),
}


# ──────────────────────────────────────────────────────────────────────────
# 2. K1：`find_lattice_peaks` / `first_order_period_nm`
# ──────────────────────────────────────────────────────────────────────────


def _peak(p: Any) -> dict:
    return {"kx": p.kx, "ky": p.ky, "power": p.power,
            "period_nm": p.period_nm, "angle_deg": p.angle_deg}


def _lattice_result(r: Any) -> dict:
    return {
        "ok": bool(r.ok), "reason": r.reason, "n_peaks": int(r.n_peaks),
        "peaks": [_peak(p) for p in r.peaks],
        "hexagonal": bool(r.hexagonal),
        "periods_nm": list(r.periods_nm),
        "period_mean_nm": r.period_mean_nm,
        "period_spread": r.period_spread,
        "angles_deg": list(r.angles_deg),
        "lattice_angle_deg": r.lattice_angle_deg,
        "direction_balance": r.direction_balance,
        "ridge_peaks": [_peak(p) for p in r.ridge_peaks],
        "n_ridge": int(r.n_ridge),
        "warnings": list(r.warnings),
    }


def spectrum_max(img: np.ndarray, nmpp: float) -> float:
    """这一帧的 `‖F‖∞`（去平面 + 加窗 + `fft2`，抹掉 DC 块之后）。

    **它是 `power` 那一列容差的尺度，不是一个被比的答案。** 一次 FFT 的绝对误差由
    整幅谱的最大系数定，不由某一个系数自己定 —— 一个比峰小三个量级的脊点，
    它的绝对误差和峰的一样大。拿它自己当分母，就是对一个近乎相消的小数字要求
    相对精度（`numerics.md` 第四节第一条）。

    这一格是金样自己教的：`hex@band_nm=(0.6,0.8)` 把搜索带挪到晶格峰之外，
    于是返回的三个脊点都在 `2e−10` 量级，而同一帧的真峰是 `2.7e−7`。
    按脊点自己归一超差 **42 倍**，按 `‖F‖∞` 归一是 **3%**。
    """
    from mast.vision.lattice_calibration import _plane_subtract

    h = np.asarray(img, dtype=np.float64)
    finite = np.isfinite(h)
    h = np.where(finite, h, np.nanmean(h[finite]))
    flat = _plane_subtract(h)
    ny, nx = flat.shape
    win = np.outer(np.hanning(ny), np.hanning(nx))
    F = np.abs(np.fft.fftshift(np.fft.fft2(flat * win)))
    cy, cx = ny // 2, nx // 2
    F[cy - 3:cy + 4, cx - 3:cx + 4] = 0.0
    return float(F.max())


PEAK_CASES: "list[dict]" = []
for _key, _kw in [
    ("hex", {}),
    ("hex_rot", {}),
    ("hex_reduced", {}),
    ("rect_down", {}),
    ("rect_up", {}),
    ("rect_super", {}),
    ("rect_weak", {}),
    ("stripe", {}),
    ("stripe_clean", {}),
    ("stripe_loud", {}),
    # 三方向但不六重（`every` vs `some` 的唯一分辨格）。
    ("tri_skew", {}),
    # 同一张图、把带放宽到 2.0 nm ⇒ 半径 3.5 的长波进了搜索区间，
    # 而它正落在**谱心 7×7 抹零**的那个方块里。默认带够不到，所以这一格必须单开。
    ("tri_skew", {"band_nm": (0.18, 2.0)}),
    ("noise", {}),
    ("noise_weak", {}),
    # ⚠️ **`dead_flat` 不进这一节。** 它的 `find_lattice_peaks` 结果是掷骰子：
    # 去平面之后残差只剩 float32 的量化噪声（`std ≈ 3.2e−17`），于是谱上哪两个
    # bin 最高，完全由**那次最小二乘的最后一位**决定 —— 而两边一个走 SVD、
    # 一个走正规方程。实测峰位两边一致、`power` 相对差 **3.6e−10**
    # （FFT 自己的精度是 `3e−14`），也就是说那个数根本不是 FFT 的误差，
    # 是「减掉的平面不一样」。
    #
    # 批 4a §9① 的原话：**一个答案是掷骰子的用例不是判据**，而修法是**改输入**、
    # 不是放宽容差。这里的改法就是把这一格从这一节拿掉 ——
    # 它在 `measure_cell` / `atomic_phase` / `flatten_robust` 三节里照旧在，
    # 因为那三处的判决由**稳健量**（带宽闸、`detect_texture`、中位数）定，
    # 不由那两个 bin 定。
    ("half", {}),
    ("tiny", {}),
    ("coarse", {}),
    # 预算：`max_peaks=12` 是 `measure_cell` 用的那个（脊点也消耗迭代次数）。
    ("stripe", {"max_peaks": 12}),
    ("rect_down", {"max_peaks": 12}),
    # 带整个落在周期之外 ⇒ 找不到峰（不是 `band_empty`：那要带**全空**）。
    ("hex", {"band_nm": (0.60, 0.80)}),
]:
    _img = loaded(_key)
    _nmpp = nmpp_of(_key)
    PEAK_CASES.append({
        "name": f"{_key}" + ("" if not _kw else "@" + ",".join(f"{k}={v}" for k, v in _kw.items())),
        "file": _key,
        "nm_per_px": _nmpp,
        "max_peaks": int(_kw.get("max_peaks", 6)),
        "band_nm": list(_kw.get("band_nm", (0.18, 0.80))),
        "spectrum_max": spectrum_max(_img, _nmpp),
        "result": _lattice_result(find_lattice_peaks(_img, _nmpp, **_kw)),
    })

# 一格 `unknown_pixel_size`（`nm_per_px` 给 0）。
PEAK_CASES.append({
    "name": "hex@nmpp=0", "file": "hex", "nm_per_px": 0.0, "max_peaks": 6,
    "band_nm": [0.18, 0.80], "spectrum_max": spectrum_max(loaded("hex"), nmpp_of("hex")),
    "result": _lattice_result(find_lattice_peaks(loaded("hex"), 0.0)),
})

FIRST_ORDER = {s: first_order_period_nm(s) for s in
               ["Au(111)", "Ag(111)", "Cu(111)", "Pt(111)", "HOPG", "NaCl(100)",
                "Si(111)-1x1", "unregistered-surface", ""]}


# ──────────────────────────────────────────────────────────────────────────
# 3. `measure_cell` / `combine_up_down` / `superstructure_test`
# ──────────────────────────────────────────────────────────────────────────


def _cell(c: Any) -> dict:
    return {
        "ok": bool(c.ok), "reason": c.reason,
        "a1_nm": c.a1_nm, "a2_nm": c.a2_nm, "gamma_deg": c.gamma_deg,
        "a1_angle_deg": c.a1_angle_deg, "area_nm2": c.area_nm2,
        "snr": list(c.snr), "indexed": int(c.indexed),
        "indexed_total": int(c.indexed_total),
        "n_peaks": int(c.n_peaks), "n_ridge": int(c.n_ridge),
        "scan_dir": c.scan_dir, "warnings": list(c.warnings),
    }


CELL_CASES: "list[dict]" = []
for _key, _dir in [("rect_down", "down"), ("rect_up", "up"), ("rect_super", "down"),
                   ("rect_weak", "down"),
                   ("hex", "down"), ("hex_rot", "down"), ("hex_reduced", "down"),
                   ("stripe", ""), ("stripe_clean", ""), ("noise", ""),
                   ("dead_flat", ""), ("tiny", ""), ("coarse", "")]:
    _img = loaded(_key)
    _nmpp = nmpp_of(_key)
    CELL_CASES.append({
        "name": _key, "file": _key, "nm_per_px": _nmpp, "scan_dir": _dir,
        "result": _cell(measure_cell(_img, _nmpp, scan_dir=_dir)),
    })
# `unknown_pixel_size` 与 `frame_too_small_for_band` 各一格。
CELL_CASES.append({"name": "rect_down@nmpp=0", "file": "rect_down", "nm_per_px": 0.0,
                   "scan_dir": "", "result": _cell(measure_cell(loaded("rect_down"), 0.0))})
CELL_CASES.append({
    "name": "hex@band_too_small", "file": "hex", "nm_per_px": 0.0001, "scan_dir": "",
    "result": _cell(measure_cell(loaded("hex"), 0.0001)),
})

_cell_down = measure_cell(loaded("rect_down"), nmpp_of("rect_down"), scan_dir="down")
_cell_up = measure_cell(loaded("rect_up"), nmpp_of("rect_up"), scan_dir="up")
COMBINE_CASES = [
    {"name": "up+down", "up": ["rect_up"], "down": ["rect_down"],
     "min_indexed": 3, "frame_height_nm": 15.0, "frame_time_s": 3276.8,
     "result": combine_up_down([_cell_up], [_cell_down], frame_height_nm=15.0,
                               frame_time_s=3276.8, min_indexed=3)},
    {"name": "down_only", "up": [], "down": ["rect_down"],
     "min_indexed": 3, "frame_height_nm": None, "frame_time_s": None,
     "result": combine_up_down([], [_cell_down], min_indexed=3)},
    {"name": "min_indexed=8_drops_all", "up": ["rect_up"], "down": ["rect_down"],
     "min_indexed": 8, "frame_height_nm": None, "frame_time_s": None,
     "result": combine_up_down([_cell_up], [_cell_down], min_indexed=8)},
    {"name": "no_time_no_rate", "up": ["rect_up"], "down": ["rect_down"],
     "min_indexed": 3, "frame_height_nm": 15.0, "frame_time_s": None,
     "result": combine_up_down([_cell_up], [_cell_down], frame_height_nm=15.0,
                               min_indexed=3)},
]


def _super(rs: Any) -> list:
    return [{"label": r.label, "period_nm": r.period_nm, "amplitude": r.amplitude,
             "control_median": r.control_median, "control_max": r.control_max,
             "ratio_to_control": r.ratio_to_control, "verdict": r.verdict,
             "note": r.note} for r in rs]


_cell_super = measure_cell(loaded("rect_super"), nmpp_of("rect_super"))
SUPER_CASES = [
    {"name": "rect_super", "file": "rect_super", "nm_per_px": nmpp_of("rect_super"),
     "cell": _cell(_cell_super),
     "result": _super(superstructure_test(loaded("rect_super"), nmpp_of("rect_super"),
                                          _cell_super))},
    {"name": "rect_plain", "file": "rect_down", "nm_per_px": nmpp_of("rect_down"),
     "cell": _cell(_cell_down),
     "result": _super(superstructure_test(loaded("rect_down"), nmpp_of("rect_down"),
                                          _cell_down))},
    {"name": "cell_not_ok", "file": "noise", "nm_per_px": nmpp_of("noise"),
     "cell": _cell(measure_cell(loaded("noise"), nmpp_of("noise"))),
     "result": _super(superstructure_test(loaded("noise"), nmpp_of("noise"),
                                          measure_cell(loaded("noise"), nmpp_of("noise"))))},
]


# ──────────────────────────────────────────────────────────────────────────
# 4. `frame_texture`
# ──────────────────────────────────────────────────────────────────────────


def _amps(rs: Any) -> list:
    return [{"angle_deg": a.angle_deg, "period_nm": a.period_nm,
             "amplitude_pm": a.amplitude_pm, "coherent_pm": a.coherent_pm,
             "coherence": a.coherence} for a in rs]


def _tiles(t: Any) -> dict:
    return {
        "ok": bool(t.ok), "reason": t.reason,
        "grid": [list(row) for row in t.grid],
        "tile_nm": t.tile_nm, "periods_per_tile": t.periods_per_tile,
        "good_fraction": t.good_fraction, "median_ratio": t.median_ratio,
        "good_ratio": t.good_ratio, "coherent_median_pm": t.coherent_median_pm,
        "top_band_median": t.top_band_median, "bottom_band_median": t.bottom_band_median,
        "warnings": list(t.warnings),
    }


def _dirs_of(c: Any) -> list:
    return [(c.a1_angle_deg, c.a1_nm), (c.a1_angle_deg + c.gamma_deg, c.a2_nm)]


TEXTURE_CASES: "list[dict]" = []
# `hex` 的块要装得下 8 个 0.25 nm 的周期 ⇒ `tile_nm ≥ 2.0`；3.75 nm 的帧上
# 那正好切出 **1×1** 的网格 —— 于是 `top_band_median` 与 `bottom_band_median`
# 取的是同一行。这一格是刻意留的：它把「几何上下」这个概念退化到极限，
# 而技能层那句「先扫的那一排 / 后扫的那一排」在这种帧上必须仍然说得通。
for _key, _tile in [("rect_down", 4.0), ("rect_super", 4.0), ("hex", 2.5)]:
    _img = loaded(_key)
    _nmpp = nmpp_of(_key)
    _c = measure_cell(_img, _nmpp)
    _d = _dirs_of(_c)
    _a = lattice_amplitude_pm(_img, _nmpp, _d)
    TEXTURE_CASES.append({
        "name": _key, "file": _key, "nm_per_px": _nmpp,
        "directions": [[x, y] for x, y in _d],
        "tile_nm": _tile,
        "amplitudes": _amps(_a),
        "streak_pm": streak_amplitude_pm(_img, _nmpp),
        "tiles": _tiles(tile_lattice_map(_img, _nmpp,
                                         [(a.angle_deg, a.period_nm) for a in _a],
                                         tile_nm=_tile, good_ratio=0.6)),
    })
# 三条拒绝路径：没有方向 / 块太小 / 块像素太少。
_img = loaded("rect_down")
_nmpp = nmpp_of("rect_down")
_a = lattice_amplitude_pm(_img, _nmpp, _dirs_of(measure_cell(_img, _nmpp)))
TEXTURE_REJECT = [
    {"name": "no_directions", "file": "rect_down", "nm_per_px": _nmpp,
     "directions": [], "tile_nm": 4.0,
     "tiles": _tiles(tile_lattice_map(_img, _nmpp, [], tile_nm=4.0, good_ratio=0.6))},
    {"name": "tile_too_small", "file": "rect_down", "nm_per_px": _nmpp,
     "directions": [[a.angle_deg, a.period_nm] for a in _a], "tile_nm": 1.0,
     "tiles": _tiles(tile_lattice_map(_img, _nmpp,
                                      [(a.angle_deg, a.period_nm) for a in _a],
                                      tile_nm=1.0, good_ratio=0.6))},
    # ⚠️ `tile_too_few_pixels` 与 `frame_smaller_than_tile` 这两支，用**真实的**
    # 晶格方向永远走不到：周期闸要 `tile ≥ 8·period`，像素闸要 `tile < 16·nmpp`，
    # 两条同时成立需要 `period < 2·nmpp` —— 比 Nyquist 还小，物理上没有这种晶格。
    # 所以这两格直接把 `directions` 当参数喂一个 0.1 nm 的假周期进去
    # （它是公开参数，调用方本来就能这么传）。**这不是把用例硬凑出来**：
    # 那两条闸写在那儿，而「没有任何输入走得到它」正是批 4a 那三条绿变异的形状。
    {"name": "tile_too_few_pixels", "file": "rect_down", "nm_per_px": _nmpp,
     "directions": [[12.0, 0.1]], "tile_nm": 0.9,
     "tiles": _tiles(tile_lattice_map(_img, _nmpp, [(12.0, 0.1)],
                                      tile_nm=0.9, good_ratio=0.6))},
    {"name": "frame_smaller_than_tile", "file": "rect_down", "nm_per_px": _nmpp,
     "directions": [[12.0, 0.1]], "tile_nm": 20.0,
     "tiles": _tiles(tile_lattice_map(_img, _nmpp, [(12.0, 0.1)],
                                      tile_nm=20.0, good_ratio=0.6))},
    {"name": "bad_input", "file": "rect_down", "nm_per_px": 0.0,
     "directions": [[a.angle_deg, a.period_nm] for a in _a], "tile_nm": 4.0,
     "tiles": _tiles(tile_lattice_map(_img, 0.0,
                                      [(a.angle_deg, a.period_nm) for a in _a],
                                      tile_nm=4.0, good_ratio=0.6))},
    {"name": "incomplete", "file": "half", "nm_per_px": nmpp_of("half"),
     "directions": [[a.angle_deg, a.period_nm] for a in _a], "tile_nm": 4.0,
     "tiles": _tiles(tile_lattice_map(
         np.where(np.arange(loaded("half").shape[0])[:, None] < loaded("half").shape[0] // 3,
                  loaded("half"), np.nan),
         nmpp_of("half"), [(a.angle_deg, a.period_nm) for a in _a],
         tile_nm=4.0, good_ratio=0.6))},
]
# `streak_amplitude_pm` 的两条早退（图太小 / 尺度未知）。
STREAK_EDGE = [
    {"name": "tiny", "file": "tiny", "nm_per_px": nmpp_of("tiny"),
     "value": streak_amplitude_pm(loaded("tiny"), nmpp_of("tiny"))},
    {"name": "nmpp_zero", "file": "rect_down", "nm_per_px": 0.0,
     "value": streak_amplitude_pm(loaded("rect_down"), 0.0)},
    {"name": "stripe", "file": "stripe", "nm_per_px": nmpp_of("stripe"),
     "value": streak_amplitude_pm(loaded("stripe"), nmpp_of("stripe"))},
]


# ──────────────────────────────────────────────────────────────────────────
# 5. `atomic_phase` 判据环 + `seg_scale_adaptive` 切片 + `tip_metrics`
# ──────────────────────────────────────────────────────────────────────────

SCALE_GATE = {repr(v): scale_gate(v) for v in
              [None, 0.0, -1.0, 0.0195, 0.02, 0.03125, 0.05, 0.0501, 0.078, float("nan")]}


def _phase(r: Any) -> dict:
    return {
        "passed": bool(r.passed), "scale": r.scale, "nm_per_px": r.nm_per_px,
        "period_nm": r.period_nm, "period_fast_axis_nm": r.period_fast_axis_nm,
        "snr": r.snr, "angular_concentration": r.angular_concentration,
        "order_ratio": r.order_ratio, "fft_sharpness": r.fft_sharpness,
        "expected_a_nm": r.expected_a_nm, "slow_axis_trusted": bool(r.slow_axis_trusted),
        "half_concentrations": (list(r.half_concentrations)
                                if r.half_concentrations else None),
        "half_passed": (list(r.half_passed) if r.half_passed else None),
        "reasons": list(r.reasons), "warnings": list(r.warnings),
    }


FLATTEN_CASES: "list[dict]" = []
TEXTURE_DETECT: "list[dict]" = []
TIP_METRICS: "list[dict]" = []
PHASE_CASES: "list[dict]" = []
CONC_CASES: "list[dict]" = []

for _key in ["hex", "hex_rot", "hex_reduced", "stripe", "stripe_loud", "noise",
             "noise_weak", "dead_flat", "half", "coarse", "rect_down"]:
    _img = loaded(_key)
    _nmpp = nmpp_of(_key)
    _flat = flatten_robust(_img)
    FLATTEN_CASES.append({
        "name": _key, "file": _key,
        # 去背景是一次**相减**：残差 ~1e−10，而被减掉的那个面 ~1e−9。
        # 于是这一族的误差由**基座**定、不由残差定 —— 容差必须是绝对的，
        # 而这个数就是它的尺度（同 `numerics.md` 第四节第一条）。
        "pedestal": float(np.abs(_img).max()),
        "std": float(_flat.std()),
        # 整幅图太大，录**一条对角线**：它经过每一行每一列，行列搞反立刻看得出来。
        "diag": [float(_flat[i, i]) for i in range(min(_flat.shape))],
        "corner": [[float(_flat[i, j]) for j in range(4)] for i in range(4)],
    })
    _P = dict(DEFAULTS)
    _tex = detect_texture(_flat, _nmpp, _P)
    TEXTURE_DETECT.append({
        "name": _key, "file": _key, "nm_per_px": _nmpp,
        "atomic": list(_tex["atomic"]) if _tex["atomic"] else None,
        "array": list(_tex["array"]) if _tex["array"] else None,
    })
    _std = float(_flat.std())
    _sharp, _res, _has = _fft_sharpness(_detrend(_img) / (_std or 1.0), _nmpp)
    TIP_METRICS.append({
        "name": _key, "file": _key, "nm_per_px": _nmpp, "std": _std,
        "pedestal": float(np.abs(_img).max()),
        "detrend_diag": [float(_detrend(_img)[i, i]) for i in range(min(_img.shape))],
        "sharpness": float(_sharp), "resolved_nm": _res, "has_lattice": bool(_has),
    })
    _tpx = float(_tex["atomic"][0]) if _tex["atomic"] else 0.0
    CONC_CASES.append({
        "name": _key, "file": _key, "period_px": _tpx,
        "angular_concentration": angular_concentration(_flat, _tpx) if _tpx >= 3.0 else 0.0,
        "order_ratio": order_ratio(_flat, _tpx) if _tpx >= 3.0 else 0.0,
        "fast_axis": list(fast_axis_period_nm(_flat, _nmpp)),
    })

for _key, _kw in [
    ("hex", {}),
    ("hex", {"expected_a_nm": 0.2498}),
    ("hex", {"expected_a_nm": 0.9}),
    ("hex", {"expected_a_nm": 0.05}),
    ("hex_rot", {}),
    ("stripe", {}),
    # 响亮的那一张：`peaks_not_one_lattice` 的「并且」两条同时成立，
    # 而幸存的峰只有两个 —— 所以「半径散布要在**全部**局部极大上算」这条
    # 只有它照得出来（`peaks` 单独只有 2 个，连 `>= 3` 都够不到）。
    ("stripe_loud", {}),
    ("noise", {}),
    # 信噪门的门下那一格（`detect_texture` 的 `lat_snr = 4`）。见 `frame_noise`。
    ("noise_weak", {}),
    ("dead_flat", {}),
    ("half", {}),
    ("coarse", {}),
    ("coarse", {"allow_reduced_scale": True}),
    # **过渡带那一对** —— `scale_reduced` 只在 `allow_reduced_scale=False` 时
    # 落进 `reasons`，而在两边都落进 `warnings`。一格分辨不出这两种候选，
    # 所以必须成对录。
    ("hex_reduced", {}),
    ("hex_reduced", {"allow_reduced_scale": True}),
    ("rect_down", {}),
    ("rect_down", {"allow_reduced_scale": True}),
    ("tiny", {}),
]:
    _img = loaded(_key)
    _nmpp = nmpp_of(_key)
    PHASE_CASES.append({
        "name": f"{_key}" + ("" if not _kw else "@" + ",".join(f"{k}={v}" for k, v in _kw.items())),
        "file": _key, "nm_per_px": _nmpp, "kwargs": _plain(_kw),
        "result": _phase(assess_atomic_phase(_img, nm_per_px=_nmpp, **_kw)),
    })
PHASE_CASES.append({
    "name": "hex@nmpp=None", "file": "hex", "nm_per_px": None, "kwargs": {},
    "result": _phase(assess_atomic_phase(loaded("hex"), nm_per_px=None)),
})

WINDOW_CASES = [
    {"bias_v": b, "setpoint_a": s, "surface": f,
     "result": {k: getattr(check_atomic_window(b, s, f), k) for k in
                ["ok", "reason", "detail_zh", "bias_v", "setpoint_a",
                 "bias_max_v", "setpoint_min_a"]}}
    for b, s, f in [
        (None, None, None), (0.02, 500e-12, "Au(111)"), (1.0, 500e-12, "Au(111)"),
        (-0.2, 500e-12, None), (0.05, 10e-12, "Au(111)"), (0.02, None, "Cu(111)"),
        (None, 20e-12, "unknown"), (0.15, 50e-12, "Ag(111)"),
    ]
]


# ──────────────────────────────────────────────────────────────────────────
# 6. 技能层 —— 旧仓的技能对着同一批 `.sxm` 真跑
# ──────────────────────────────────────────────────────────────────────────

SKILLS: "dict[str, list]" = {}


def run_skill(name: str, skill: Any, cases: "list[tuple[str, dict]]") -> None:
    rows = []
    for case, params in cases:
        res = skill.execute(None, dict(params))
        rows.append({
            "case": case, "params": _plain(params),
            "success": bool(res.success), "error": res.error or "",
            "summary": res.summary or "", "data": _plain(res.data or {}),
        })
    SKILLS[name] = rows


run_skill("AssessScanTexture", AssessScanTexture(), [
    ("rect", {"scan_path": PATHS["rect_down"], "channel": "Z", "tile_nm": 4.0}),
    ("rect_with_ratio", {"scan_path": PATHS["rect_down"], "channel": "Z",
                         "tile_nm": 4.0, "good_ratio": 0.6}),
    ("rect_up_scan_dir", {"scan_path": PATHS["rect_up"], "channel": "Z", "tile_nm": 4.0}),
    ("hex_small_tile", {"scan_path": PATHS["hex"], "channel": "Z", "tile_nm": 1.2}),
    ("no_lattice", {"scan_path": PATHS["noise"], "channel": "Z", "tile_nm": 4.0}),
    ("tile_too_small", {"scan_path": PATHS["rect_down"], "channel": "Z", "tile_nm": 1.0}),
    ("missing_file", {"scan_path": missing_path("nope"), "channel": "Z"}),
    ("no_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
    ("no_scale", {"scan_path": PATHS["no_scale"], "channel": "Z"}),
    ("empty_path", {"scan_path": "", "channel": "Z"}),
])

run_skill("MeasureLatticeCell", MeasureLatticeCell(), [
    ("up_and_down", {"scan_paths": f"{PATHS['rect_up']},{PATHS['rect_down']}",
                     "channel": "Z", "min_indexed": 3, "superstructure": False}),
    ("with_super", {"scan_paths": PATHS["rect_super"], "channel": "Z",
                    "min_indexed": 3, "superstructure": True}),
    ("one_direction", {"scan_paths": PATHS["rect_down"], "channel": "Z",
                       "min_indexed": 3, "superstructure": False}),
    ("min_indexed_8", {"scan_paths": f"{PATHS['rect_up']}\n{PATHS['rect_down']}",
                       "channel": "Z", "min_indexed": 8, "superstructure": False}),
    ("all_rejected", {"scan_paths": PATHS["noise"], "channel": "Z",
                      "min_indexed": 3, "superstructure": False}),
    ("mixed_io_failure", {"scan_paths": f"{missing_path('nope')},{PATHS['rect_down']}",
                          "channel": "Z", "min_indexed": 3, "superstructure": False}),
    ("all_io_failed", {"scan_paths": missing_path("nope"), "channel": "Z",
                       "min_indexed": 3, "superstructure": False}),
    ("no_scale", {"scan_paths": PATHS["no_scale"], "channel": "Z",
                  "min_indexed": 3, "superstructure": False}),
    ("no_paths", {"scan_paths": "", "channel": "Z"}),
])

run_skill("AssessAtomicResolution", AssessAtomicResolution(), [
    ("hex", {"scan_path": PATHS["hex"], "channel": "Z", "surface": "Au(111)"}),
    ("hex_no_surface", {"scan_path": PATHS["hex"], "channel": "Z", "surface": ""}),
    ("hex_conc_min", {"scan_path": PATHS["hex"], "channel": "Z", "surface": "Au(111)",
                      "concentration_min": 1e6}),
    ("bad_bias", {"scan_path": PATHS["hex_badbias"], "channel": "Z", "surface": "Au(111)"}),
    ("coarse", {"scan_path": PATHS["coarse"], "channel": "Z", "surface": "Au(111)"}),
    ("reduced", {"scan_path": PATHS["hex_reduced"], "channel": "Z", "surface": "Au(111)"}),
    ("reduced_allow", {"scan_path": PATHS["hex_reduced"], "channel": "Z",
                       "surface": "Au(111)", "allow_reduced_scale": True}),
    ("noise", {"scan_path": PATHS["noise"], "channel": "Z", "surface": "Au(111)"}),
    ("stripe", {"scan_path": PATHS["stripe"], "channel": "Z", "surface": "Au(111)"}),
    ("half", {"scan_path": PATHS["half"], "channel": "Z", "surface": "Au(111)"}),
    ("missing_file", {"scan_path": missing_path("nope"), "channel": "Z"}),
    ("no_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
    # ⚠️ 没有像素标度时**不报 IO 错**：`atomic_lattice._load_frame` 把 `None`
    # 原样传给判据环，于是出局词是机器可判的 `unknown_pixel_size`，
    # 而不是一句「文件头里没有像素标度」的中文串（`_sxm_frame` 那一族才那么做）。
    ("no_scale", {"scan_path": PATHS["no_scale"], "channel": "Z", "surface": "Au(111)"}),
])

run_skill("AnalyseAtomicLattice", AnalyseAtomicLattice(), [
    ("hex", {"scan_path": PATHS["hex"], "channel": "Z", "surface": "Au(111)"}),
    ("hex_none", {"scan_path": PATHS["hex"], "channel": "Z", "surface": "none"}),
    ("reduced_allow", {"scan_path": PATHS["hex_reduced"], "channel": "Z",
                       "surface": "Au(111)", "allow_reduced_scale": True}),
    ("reduced_refused", {"scan_path": PATHS["hex_reduced"], "channel": "Z",
                         "surface": "Au(111)"}),
    ("hex_no_require", {"scan_path": PATHS["noise"], "channel": "Z",
                        "surface": "Au(111)", "require_atomic": False}),
    ("noise", {"scan_path": PATHS["noise"], "channel": "Z", "surface": "Au(111)"}),
    ("coarse", {"scan_path": PATHS["coarse"], "channel": "Z", "surface": "Au(111)"}),
    ("missing_file", {"scan_path": missing_path("nope"), "channel": "Z"}),
    ("no_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
    ("no_scale", {"scan_path": PATHS["no_scale"], "channel": "Z", "surface": "Au(111)"}),
])


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_lattice.py 生成 —— 旧仓 mast.vision.lattice_* / "
                 "frame_texture / atomic_phase 与四个技能真跑一遍。帧是合成的（闭式公式，"
                 "零随机数），技能那一层录的是 .sxm 的**字节**，读法归旧仓。",
        "versions": {"numpy": np.__version__},
        "condition_numbers": _plain(CONDITION),
        "sxm_files": {k: base64.b64encode(v).decode("ascii") for k, v in FILES.items()},
        "first_order_period": _plain(FIRST_ORDER),
        "lattice_peaks": _plain(PEAK_CASES),
        "measure_cell": _plain(CELL_CASES),
        "combine_up_down": _plain(COMBINE_CASES),
        "superstructure": _plain(SUPER_CASES),
        "frame_texture": _plain(TEXTURE_CASES),
        "frame_texture_reject": _plain(TEXTURE_REJECT),
        "streak_edge": _plain(STREAK_EDGE),
        "scale_gate": _plain(SCALE_GATE),
        "flatten_robust": _plain(FLATTEN_CASES),
        "detect_texture": _plain(TEXTURE_DETECT),
        "tip_metrics": _plain(TIP_METRICS),
        "concentration": _plain(CONC_CASES),
        "atomic_phase": _plain(PHASE_CASES),
        "imaging_window": _plain(WINDOW_CASES),
        "skills": _plain(SKILLS),
    }
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
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
