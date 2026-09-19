r"""批 4c 的金样 —— **旧仓真实的 12 个技能真跑一遍**。

`export_analysis.py` 录的是 `mast.vision.*` 的判据；这一份录的是
`mast.skills.paper.*` 与 `mast.skills.builtins.scan_frame` —— 也就是
「一张图进来、一张图出去」的那一族。TS 那侧拿**同一批字节**跑自己的实现。

## 四条纪律（前三条与 `export_analysis.py` 同，第四条是这一批新加的）

1. **输入与答案一起录**，而合成用的是**闭式公式，零随机数** ——
   「重跑逐字节相同」不依赖任何种子，也不依赖 numpy 的 PCG64。
2. **录的是文件的字节**（`.npy` / `.sxm` / `.dat`，base64），不是解析出来的数组。
   两边各按闭式重建同一个输入**不是同一个输入**（批 4a：`noiseFloor` 差
   4.4e-14，原因是加法结合律）。这里字节我写，**读法两边各自的**。
3. **墙钟与随机数一概不进**；`MAST2_PROJECT_ROOT` 指向临时目录。
4. **产物也要录**。这一族技能的 `data` 里只有形状与几个标量，真正的产物是它
   写出去的那个 `.npy`。只比 `data` 等于只比收据不比货 —— 一个把图整幅搬错
   一行的实现，`corrected_image_shape` 和 `stripes_removed` 一个字都不会变。
   所以每一格跑完之后把输出文件**读回来**一起录（`output`）。

## ⚠️ RANSAC 那一格为什么**不是**抽签

`ransac_plane_subtract` 用 `np.random.default_rng(42)` 抽三点，而本仓的
`Xoshiro128` 抽的是另一串数 —— 两边抽到的三元组必然不同。批 4a 的
`fit_plane_robust` 就是在这里分的岔（D-VISION-1）。

这一批**改的是输入，不是容差**（批 4a §9①）：

* 背景是一张**精确的平面**（float64 上残差 ~1e-25）；
* 特征是**平顶圆盘**，高 5e-9，**没有裙边** —— 于是每个像素要么在平面上、
  要么离它 5e-9，而内点阈是 1e-10。

后果：任何一组「三点全落在背景上」的抽样都给出同一个平面（差在 1e-25），
于是 `best_inliers` 恒等于背景像素数、`inlier_mask` 恒等于背景本身，
最后那次**全内点最小二乘**两边解的是同一个方程组。
抽样序列不同，**答案相同** —— 而这不是运气，是这张图的构造。

一张有裙边的图（高斯包）做不到：裙边上有一圈像素的高度**正好在阈值附近**，
于是「先抽到谁」会改掉内点集，那时答案就是掷骰子的。

    python \
        tools/spec-export/export_paper_data.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-paper-export-"))

# ── 墙钟桩 ────────────────────────────────────────────────────────────────
#
# `LoadScanFrameFromFile` 把 `int(time.time()*1000) & 0xFFFFFFFF` 写进它造的
# 文件名里。不钉住它，这份金样**每跑一次就换一批路径** —— 而「重跑逐字节相同」
# 是金样最重要的性质（没有它，`git diff` 回答不了「有没有变」）。
#
# 钉死之后两次同通道的调用会**撞名**，于是那条「取第一个空位」的路
# （`_01` 后缀）真的被走到了 —— 那正是旧仓 2026-07-28 那次「第二发盖掉第一发」
# 的修补，而一个每次都不同的时间戳会让它**永远验不到**。
import time as _time  # noqa: E402

_time.time = lambda: 1_700_000_000.0  # type: ignore[assignment]

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "paper_data.json"
MAST = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402
import scipy  # noqa: E402
import skimage  # noqa: E402

from mast.skills.builtins.scan_frame import (  # noqa: E402
    ComputeDriftVector,
    LoadScanFrameFromFile,
    ParseRegions,
)
from mast.skills.paper.atom_jump import DetectAtomJump  # noqa: E402
from mast.skills.paper.background import SubtractPoly2D  # noqa: E402
from mast.skills.paper.data_processing import (  # noqa: E402
    CorrectDrift_XCorr,
    FindEmptySpot,
    LevelLines_Median,
    SubtractPlane_RANSAC,
)
from mast.skills.paper.denoise import Denoise_AE  # noqa: E402
from mast.skills.paper.image_filters import Destripe_MorphOpen  # noqa: E402
from mast.skills.paper.scan_crop import AutoCrop_UnscannedRegion  # noqa: E402
# ── 批 7b-3（paper 四个纯函数）在这一行下面加 import ──
from mast.skills.paper.deconvolution import DeconvolveTip_RL  # noqa: E402
from mast.skills.paper.region_analysis import (  # noqa: E402
    DetectAtoms_FCN,
    SegmentRegion_UNet,
)
from mast.skills.paper.scan_diff import DiffScans_ChangeDetect  # noqa: E402

TMP = tempfile.mkdtemp(prefix="mast-paper-files-")


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
    return str(v)


# ──────────────────────────────────────────────────────────────────────────
# 合成的图 —— **闭式，零随机数**
# ──────────────────────────────────────────────────────────────────────────


def _ij(ny: int, nx: int) -> "tuple[np.ndarray, np.ndarray]":
    return (np.arange(ny, dtype=np.float64)[:, None],
            np.arange(nx, dtype=np.float64)[None, :])


def frame_plane_disks(ny: int = 32, nx: int = 32) -> np.ndarray:
    """精确平面 + **平顶圆盘**（不是高斯包）。见文件抬头那一节。

    圆盘之所以平顶：高斯包有裙边，裙边上那一圈像素的高度正好跨过内点阈
    1e-10，于是「先抽到哪三个点」会改掉内点集 —— 而那正是抽签。
    平顶盘上每个像素要么在平面上、要么高 5e-9，中间**什么都没有**。
    """
    i, j = _ij(ny, nx)
    z = 1.0e-9 + 0.8e-12 * j + 0.3e-12 * i
    for cy, cx, r in ((9.0, 10.0, 4.0), (22.0, 23.0, 3.0), (13.0, 26.0, 2.0)):
        z = np.where((i - cy) ** 2 + (j - cx) ** 2 <= r * r, z + 5.0e-9, z)
    return z


def frame_bowl_disks(ny: int = 32, nx: int = 32) -> np.ndarray:
    """平面 **+ 一口很浅的碗** + 平顶圆盘 —— 这一张是给「最后那次全内点最小二乘」
    准备的。

    ## 没有它，那道闸**验不到**

    `frame_plane_disks` 的背景是一张**精确的**平面：任何三个背景点解出来的平面
    就是那张平面（差在 1e-25），于是「拿全部内点再拟合一次」这一步**什么都没改**。
    把那一步整个拆掉，答案一位都不变 —— 也就是说那道闸在金样上不存在
    （批 4a §9②：一条变异跑出绿色，说的是「这条闸没有人在验」）。

    碗的幅度 1e-11 ≪ 内点阈 1e-10：三点平面仍然把全部 933 个背景像素收进内点
    （于是内点集照旧定死、答案照旧与抽样序列无关），但**三点解与全内点最小二乘
    不再是同一个平面** —— 斜率差 ~3e-13/px，而斜率本身才 8e-13/px。
    拆掉那一步，`plane_coefficients` 当场差四成。
    """
    i, j = _ij(ny, nx)
    xn = 2.0 * j / (nx - 1) - 1.0
    yn = 2.0 * i / (ny - 1) - 1.0
    z = 1.0e-9 + 0.8e-12 * j + 0.3e-12 * i + 1.0e-11 * (xn * xn + yn * yn)
    for cy, cx, r in ((9.0, 10.0, 4.0), (22.0, 23.0, 3.0), (13.0, 26.0, 2.0)):
        z = np.where((i - cy) ** 2 + (j - cx) ** 2 <= r * r, z + 5.0e-9, z)
    return z


def frame_curved(ny: int = 24, nx: int = 24) -> np.ndarray:
    """二次背景 + 两个平顶盘 —— `SubtractPoly2D` 的张量积设计阵吃的正是这个。

    背景用的坐标与 `poly2d_subtract` 内部一样归一化到 `[-1, 1]`，
    于是 `order_x=order_y=2` **应当把它减干净**（残差只剩圆盘），
    而 `order_x=order_y=1` 减不干净 —— 两格一起录，那个差就是判据。
    """
    i, j = _ij(ny, nx)
    xn = 2.0 * j / (nx - 1) - 1.0
    yn = 2.0 * i / (ny - 1) - 1.0
    z = 1.0e-9 + 3.0e-11 * xn * xn + 2.0e-11 * yn * yn + 1.0e-11 * xn * yn + 5.0e-12 * xn
    for cy, cx, r in ((7.0, 8.0, 3.0), (17.0, 16.0, 2.0)):
        z = np.where((i - cy) ** 2 + (j - cx) ** 2 <= r * r, z + 4.0e-9, z)
    return z


def frame_rough_gradient(ny: int = 32, nx: int = 32) -> np.ndarray:
    """逐格粗糙度**各不相同**的一张图 —— `FindEmptySpot` 的 `argmin` 要唯一。

    ⚠️ 用一张「几格同样平」的图会让 `np.argmin` 落在**并列第一**上，而并列时
    谁赢由最后一位浮点决定（本仓 `sum` 是 Neumaier、numpy 是成对求和）。
    那是掷骰子，不是判据。这里每一格的起伏幅度是
    `(1 + 3·row_cell + col_cell)`，**16 格两两不等**，最平的那一格领先 2 倍。
    """
    i, j = _ij(ny, nx)
    cell = 1.0 + 3.0 * np.floor(i / 8.0) + np.floor(j / 8.0)
    tex = np.where((i.astype(int) % 2) == 0, 1.0, -1.0) * ((j.astype(int) % 3) - 1.0)
    return 1.0e-9 + 0.1e-12 * j + 1.0e-11 * cell * tex


def frame_stripes(ny: int = 96, nx: int = 16) -> np.ndarray:
    """几条整行抬起来的扫描线 —— `Destripe_MorphOpen` 的每一道闸都在这张图上。

    ## 为什么行数是 96 而不是 32

    `normalized = |行中位 − 全局中位| / std(那组偏差)`，而那组偏差里**条纹自己
    也在**：条纹越多，分母越大。干净行的偏差**恰好是 0**（全局中位就是它们），
    于是只有「条纹占的比例」决定得了硬档能不能过 3.0。
    5 硬 + 8 软 / 96 行：硬 **3.843**（阈 3.0）、软 **2.114**（在 1.5 与 3.0 之间）、
    干净 **0.0**。三档离各自的阈值最近的一处有 28% 余量 —— 浮点差在 1e-15 量级。
    32 行上放不下这么多段（实测硬档掉到 2.78，一格都过不了）。

    ## 布局：四段，**每一段验一道不同的闸**

    | 行 | 档 | 验的是 |
    |---|---|---|
    | `20,21,22` | 硬（一段长 3） | 行程下限 |
    | `19,23` | 软，贴着上面那段 | 「软的挨着硬的才算数」 |
    | `40` | 孤立的一条硬 | 长度 1 的行程被开运算抹掉 |
    | `45` + `46,47,48` | 硬一条 + 贴着的三条软 | `min_length` 在 3 与 5 之间**换答案**（4 < 5） |
    | `70,71,72` | 软，**离任何硬的都有 25 行** | 「不挨着硬的就不算」—— 没有这一段，那道闸整条金样都碰不到 |

    于是 `min_length` 这道闸看得见：3 ⇒ 9 行；5 ⇒ 5 行；6 ⇒ 0 行。

    ## ⚠️ 那条 `1e-14 · i` 的缓坡不是装饰

    没有它，每一条干净行**完全相同** —— 于是「条纹行换成上下两条邻居的线性插值」
    里那个权重 `w` 与 `1 − w` 给出同一个数，那道闸在金样上不存在
    （实测：把权重反过来，113 条测试全绿）。加了缓坡之后上下两条邻居差
    6e-14，插值方向错了当场看得出来。
    坡度取 1e-14 是因为它得**小到不改判据**：干净行的 normalized 从 0 涨到
    0.022，三档的分界一格没动。
    """
    i, j = _ij(ny, nx)  # noqa: F841
    z = np.tile(1.0e-9 + 1.0e-13 * np.cos(j), (ny, 1)) + 1.0e-14 * i
    for r in (20, 21, 22, 40, 45):
        z[r, :] += 1.0e-10
    for r in (19, 23, 46, 47, 48, 70, 71, 72):
        z[r, :] += 0.55e-10
    return z


def frame_median_split(ny: int = 8, nx: int = 8) -> np.ndarray:
    """一行里**跨着 20 倍的高差** —— 只有这样的行分得开两种中位数写法。

    `np.median` 在偶数长度上是 `(a + b) / 2`，而 `np.percentile(50)`（也就是
    本仓 `numerics.median`）是 `a + (b − a) · 0.5`。两个式子数学上相等、
    浮点上不等 —— 但**只在 a 与 b 量级相差很远时**才真的分岔：
    `1e-9 ± 1e-13` 那种行上，三百万对里一次都没分开过（实测）。

    所以 D-VISION-2 那条登记要验到，就得有一行**跨量级**的数据 ——
    而那正是「行里有个分子/团簇」的样子。这里 `lo = 1.002e-10`、
    `hi = 2.004e-9`：`(lo+hi)/2 = 1.0521000000000001e-9`，
    `lo+(hi−lo)·0.5 = 1.0521e-9`，差**最后一位**。
    那一位会减到这一行的**每一个像素**上。
    """
    lo = hi = 0.0
    for k in range(1, 4000):
        lo = 1.0e-10 * (1.0 + 0.001 * k)
        hi = 2.0e-9 * (1.0 + 0.001 * k)
        if ((lo + hi) / 2.0) != (lo + (hi - lo) * 0.5):
            break
    else:  # pragma: no cover —— 找不到就别录一个验不到东西的金样
        raise RuntimeError("找不到一对分得开两种中位写法的值")
    z = np.empty((ny, nx), dtype=np.float64)
    z[:, : nx // 2] = lo
    z[:, nx // 2:] = hi
    return z


def frame_bordered(ny: int = 40, nx: int = 40) -> np.ndarray:
    """上边 14 行 + 左边 14 列是常数 —— `AutoCrop_UnscannedRegion` 的**两趟**。

    ## 两块常数**取不同的值**，这是这张图的全部设计

    左边那 14 列在第一趟里**不是**「实心」的：它上半截是上边框的值 `T`、
    下半截才是左边框的值 `L`，于是列中位是 `L`，而 14/40 个像素离它 1.1 nm ——
    过不了 `row_thresh = 0.85`。把上边框切掉之后它才变成一整列的 `L`。
    ⇒ `max_iter=1` 与 `max_iter=3` 给出**不同的形状**，而那正是那个循环存在的理由
    （「切掉一条边会露出另一条」）。两块同值的话这条判据一格都验不到。

    ## 14 行而不是 12

    块扫描一次看 20 行，`block_thresh = 0.6`，12/20 **正好**等于 0.6。
    一个落在判据边界上的用例说不出「`>=` 还是 `>`」，而那正是这道闸唯一会写错的
    地方。14/20 = 0.7 就分得开了。
    """
    i, j = _ij(ny, nx)
    z = 1.0e-9 + 2.0e-11 * np.cos(j * 0.7) + 3.0e-11 * np.sin(i * 0.4) + 1.0e-11 * np.cos(i * j * 0.05)
    z[:, :14] = 3.1e-9
    z[:14, :] = 4.2e-9
    return z


def frame_shifted(base: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """`np.roll` 出来的一对帧 —— 位移是**整数像素**，答案因此是一个整数。"""
    return np.roll(np.roll(base, dy, axis=0), dx, axis=1)


def frame_drift_ref(ny: int = 32, nx: int = 32) -> np.ndarray:
    """一个**唯一**的尖峰 + 缓变背景 —— 互相关峰不会并列。"""
    i, j = _ij(ny, nx)
    z = 1.0e-9 + 2.0e-11 * np.cos(2.0 * np.pi * j / 17.0) * np.cos(2.0 * np.pi * i / 13.0)
    z = z + 6.0e-10 * np.exp(-(((i - 11.0) ** 2 + (j - 9.0) ** 2) / 6.0))
    return z


def frame_constant(ny: int = 16, nx: int = 16) -> np.ndarray:
    """死平 —— `destripe` 的 `dev_std < 1e-30` 早退那一支。"""
    return np.full((ny, nx), 1.0e-9)


# ── 批 7b-3（paper 四个纯函数）的合成图在这一行下面 ────────────────────────


def frame_atoms(ny: int = 32, nx: int = 32) -> np.ndarray:
    """给 `DetectAtoms_FCN` 的一张**故意摆出四道闸**的图。

    背景**精确为 0**，尖峰是孤立的单像素（或小平台），于是
    `leveled == local_max` 这个**浮点等号**只在设计好的地方成立 ——
    背景像素两两逐位相等，它们与自己窗口的最大值也逐位相等，
    全靠 `leveled > std` 那一道把它们挡在外面。

    | 摆的东西 | 验的是哪道闸 |
    |---|---|
    | `(5,5)` `(5,20)` `(20,5)` 三个孤立尖峰 | 基本路径 |
    | `(12,12)` `(12,13)` 一对**横向相邻** | 质心落在 **半整数** 上（`12.5`） |
    | `(25,25)` `(26,26)` 一对**对角相邻** | **四邻接 vs 八邻接** —— 四邻接给两个原子，八邻接给一个落在两者中间的假原子 |
    | `(8,8)` 高 1.0 + `(8,11)` 高 0.8 | `min_distance_px` 换答案：窗口 3 时 0.8 那个是局部极大，窗口 11 时被压掉 |

    最后一格是这张图唯一有鉴别力的地方：不摆它，`min_distance_px` 这个参数
    在整份金样里**一次决定都没做过**。
    """
    z = np.zeros((ny, nx), dtype=np.float64)
    for (i, j) in ((5, 5), (5, 20), (20, 5), (12, 12), (12, 13), (25, 25), (26, 26), (8, 8)):
        z[i, j] = 1.0
    z[8, 11] = 0.8
    return z


def frame_blurred_disks(ny: int = 16, nx: int = 16) -> np.ndarray:
    """给 `DeconvolveTip_RL` 的一张**已经被高斯抹开**的图（闭式，零随机数）。

    两个正的高斯包，σ=1.6 —— 这正是「针尖把特征抹宽了」的样子，
    而 RL 的工作就是把它收回去。**全正**（基线 1.0，包高 3.0）是有意的：
    RL 的 `im = image − min + 1e-12` 之后要做除法，
    一张接近零的图会让 `ratio` 冲到 1e12 量级，那时两条卷积路线的
    浮点差被放大到没法给容差。

    16×16 也是有意的：缺省 PSF 是 13×13，直接算的 `correlate2d` 是
    `16·16·169 ≈ 4.3 万`次乘加一趟、30 轮两次卷积 ⇒ 260 万次。再大就只是更慢。
    """
    i, j = _ij(ny, nx)
    z = np.full((ny, nx), 1.0)
    for cy, cx, h in ((5.0, 5.0, 3.0), (10.0, 11.0, 2.0)):
        z = z + h * np.exp(-(((i - cy) ** 2 + (j - cx) ** 2) / (2.0 * 1.6 ** 2)))
    return z


# ──────────────────────────────────────────────────────────────────────────
# 文件合成：`.npy` / `.sxm` / `.dat`
# ──────────────────────────────────────────────────────────────────────────

FILES: "dict[str, bytes]" = {}
PATHS: "dict[str, str]" = {}


def _register(key: str, suffix: str, raw: bytes) -> str:
    """把一份合成的文件落到临时目录，并把**字节**收进金样。

    ⚠️ 路径用正斜杠交出去（同 `export_analysis.py`：反斜杠在 JSON 与 `repr()`
    里各转义一次，同一条路径就有了三种写法）。
    """
    FILES[key] = raw
    p = Path(TMP) / f"{key}{suffix}"
    p.write_bytes(raw)
    PATHS[key] = str(p).replace("\\", "/")
    return PATHS[key]


def npy_file(key: str, arr: np.ndarray) -> str:
    import io

    buf = io.BytesIO()
    np.save(buf, np.asarray(arr, dtype=np.float64))
    return _register(key, ".npy", buf.getvalue())


def sxm_file(key: str, channels: "list[tuple[str, list[np.ndarray]]]", *, nx: int, ny: int,
             scan_dir: str = "down") -> str:
    """文本头 + 记号 + **大端 float32** 数据块（与 `export_analysis.py` 同一口径）。"""
    lines: "list[str]" = [
        ":NANONIS_VERSION:", "2",
        ":SCANIT_TYPE:", "              FLOAT            MSBFIRST",
        ":REC_DATE:", " 15.09.2026",
        ":REC_TIME:", "12:34:56",
        ":ACQ_TIME:", "          12.8",
        ":BIAS:", "\t-1.0000E+0",
        ":Z-CONTROLLER>Setpoint:", "\t100.0E-12",
        ":SCAN_PIXELS:", f"        {nx}         {ny}",
        ":SCAN_RANGE:", "           1.000000E-8           1.000000E-8",
        ":SCAN_OFFSET:", "         0.0E+0         0.0E+0",
        ":SCAN_DIR:", scan_dir,
        ":SCAN_ANGLE:", "       0.000E+0",
        ":DATA_INFO:", "\tChannel\tName\tUnit\tDirection\tCalibration\tOffset",
    ]
    for i, (name, blocks) in enumerate(channels):
        direction = "both" if len(blocks) == 2 else "fwd"
        lines.append(f"\t{i}\t{name}\tm\t{direction}\t9.000E-9\t0.000E+0")
    lines += [":SCANIT_END:", ""]
    head = "\n".join(lines).encode("utf-8")
    blob = b""
    for _name, blocks in channels:
        for arr in blocks:
            blob += np.asarray(arr, dtype=">f4").tobytes()
    return _register(key, ".sxm", head + b"\\1A\\04" + blob)


def dat_file(key: str, columns: "dict[str, np.ndarray]") -> str:
    lines = ["Experiment\tbias spectroscopy", "", "[DATA]",
             "\t".join(columns.keys())]
    n = len(next(iter(columns.values())))
    for r in range(n):
        lines.append("\t".join(f"{float(v[r]):.9E}" for v in columns.values()))
    return _register(key, ".dat", ("\n".join(lines) + "\n").encode("utf-8"))


def missing_path(name: str) -> str:
    """一条**不存在**的路径（各技能的「文件不存在」那一支）。"""
    return f"{TMP}/{name}".replace("\\", "/")


PLANE_DISKS = frame_plane_disks()
BOWL_DISKS = frame_bowl_disks()
CURVED = frame_curved()
ROUGH = frame_rough_gradient()
STRIPES = frame_stripes()
MEDIAN_SPLIT = frame_median_split()
BORDERED = frame_bordered()
DRIFT_REF = frame_drift_ref()
DRIFT_CUR = frame_shifted(DRIFT_REF, 3, -2)
CONSTANT = frame_constant()
# ── 批 7b-3 ──
ATOMS = frame_atoms()
BLURRED = frame_blurred_disks()

npy_file("plane_disks", PLANE_DISKS)
npy_file("bowl_disks", BOWL_DISKS)
npy_file("curved", CURVED)
npy_file("rough", ROUGH)
npy_file("stripes", STRIPES)
npy_file("median_split", MEDIAN_SPLIT)
npy_file("bordered", BORDERED)
npy_file("drift_ref", DRIFT_REF)
npy_file("drift_cur", DRIFT_CUR)
npy_file("constant", CONSTANT)
npy_file("drift_small", DRIFT_REF[:16, :16])
# 比格子还小的一张图 —— `FindEmptySpot` 的 `cell_h == 0` ⇒ 每一格都是空 patch
# ⇒ `roughness` 整张留在 `np.inf` 上。一个 `inf` 的「最平的地方」是一句
# **它自己说得出口**的「我判不了」，而 `argmin` 照样给 (0, 0)。
npy_file("tiny", DRIFT_REF[:8, :8])

# `.sxm`：通道顺序刻意是 **Current 在前、Z 在后** —— `_pick_image_channel`
# 的纪律是「先找 Z/height/topo 且名字里没有 current 的那一路」，而**第一路**
# 是一个完全合理的错误答案（`load_image_2d` 的最后一支就是 `names[0]`）。
# 两路的数差着 6 个数量级，挑错了 `rms_before` 当场看得出来。
sxm_file("topo", [("Current", [PLANE_DISKS * 1e-3, PLANE_DISKS * 1e-3]),
                  ("Z", [PLANE_DISKS, frame_shifted(PLANE_DISKS, 0, 1)])],
         nx=32, ny=32)
# 只有正扫的一路 —— `LoadScanFrameFromFile` 的「缺 backward 方向」那一支。
sxm_file("fwd_only", [("Z", [PLANE_DISKS])], nx=32, ny=32)
sxm_file("current_only", [("Current", [PLANE_DISKS * 1e-3, PLANE_DISKS * 1e-3])],
         nx=32, ny=32)

_t = np.arange(64, dtype=np.float64)
dat_file("trace", {"Bias calc (V)": _t * 0.01,
                   "Current (A)": np.where(_t < 32, 1.0e-10, 4.0e-10)})

# 一个**不是** .npy 的字节串，扩展名却是 .npy —— 读不动那一支。
_register("broken", ".npy", b"not a numpy file at all\n")

# ── 批 7b-3 的文件 ────────────────────────────────────────────────────────
npy_file("atoms", ATOMS)
npy_file("blurred", BLURRED)
# 自定义 PSF 两张：**奇数**一张、**偶数**一张。
#
# ⚠️ 偶数那一张是这一族唯一有鉴别力的一格：`fftconvolve(·, psf, 'same')` 取的是
# full 的 `[(M−1)//2 …]`，而「翻核 + 相关」的原点是 `M//2` —— 奇数时两者相等，
# 偶数时差 1 格。差这一格不会报错，只会把整幅反卷积结果**平移一个像素**。
# 同 `morphology.ts` 抬头②：奇数尺寸看不出来的那一类错，只有偶数那一格分得开。
# ⚠️ **刻意不对称**。对称核翻不翻都一样 —— 而 RL 每一轮先按 `psf` 卷一次、
# 再按 `psf[::-1,::-1]` 卷一次，两次用的是**不同**的核。一个对称的自定义 PSF
# （以及缺省那个高斯）把「有没有翻」整个藏起来。
_psf3 = np.array([[0.02, 0.06, 0.12],
                  [0.08, 0.35, 0.14],
                  [0.04, 0.09, 0.10]], dtype=np.float64)
_psf4 = np.array([[0.02, 0.08, 0.08, 0.02],
                  [0.08, 0.22, 0.22, 0.08],
                  [0.03, 0.09, 0.05, 0.01],
                  [0.01, 0.01, 0.00, 0.00]], dtype=np.float64)
npy_file("psf3", _psf3)
npy_file("psf4", _psf4)
# 一维 `.npy` —— `diff_scans` 那道 `ndim != 2` 的闸。
# 旧仓 `load_image_2d` 在 `np.squeeze` 之后交出一维数组，技能当场拒。
npy_file("one_d", np.linspace(1.0, 2.0, 32))
# 空数组 —— `load_image_2d` 的 `parsed to an empty array`（**两侧逐字相同**）。
npy_file("empty2d", np.zeros((0, 3)))
# 与 `drift_cur` 同源、**尺寸更小且不是方的** —— `ny = min(行)`、`nx = min(列)`
# 是两条独立的取小，用一张方图分不开它们。
npy_file("drift_cur_small", DRIFT_CUR[:20, :24])


# ──────────────────────────────────────────────────────────────────────────
# 跑技能 —— 连**它写出去的那个文件**一起录
# ──────────────────────────────────────────────────────────────────────────

SKILLS: "dict[str, list]" = {}


def _read_one(p: Any) -> Any:
    if not isinstance(p, str) or not p:
        return None
    try:
        return _plain(np.load(p))
    except Exception as exc:  # noqa: BLE001
        return f"<unreadable: {type(exc).__name__}: {exc}>"


def _read_output(data: Any) -> "dict[str, Any] | None":
    """把技能写出去的 `.npy` 读回来。见文件抬头纪律 ④。

    三个键名：大多数技能写一个 `output_path`；`LoadScanFrameFromFile` 写**两个**
    （`fwd_path` / `bwd_path`），而那两份正是它唯一的产物 —— 不读回来的话，
    「反扫有没有镜像回样品坐标」这条判据（76 张真机帧上把结论整个反过来的那一条）
    **一格都验不到**。
    """
    if not isinstance(data, dict):
        return None
    out: "dict[str, Any]" = {}
    one = _read_one(data.get("output_path"))
    if one is not None:
        out["output"] = one
    for key, name in (("fwd_path", "output_fwd"), ("bwd_path", "output_bwd")):
        got = _read_one(data.get(key))
        if got is not None:
            out[name] = got
    return out or None


def run_skill(name: str, skill: Any, cases: "list[tuple[str, dict]]", *,
              ctxs: "dict[str, Any] | None" = None, outputs: "set[str] | None" = None) -> None:
    rows = []
    for key, params in cases:
        ctx = (ctxs or {}).get(key)
        try:
            r = skill.execute(ctx, dict(params))
            out = {"success": bool(r.success), "error": r.error, "summary": r.summary,
                   "data": r.data}
        except Exception as exc:  # noqa: BLE001 —— 抛出来本身就是一条判据
            out = {"raised": f"{type(exc).__name__}: {exc}"}
        row = {"key": key, "params": _plain(params), "result": _plain(out)}
        if outputs is None or key in outputs:
            got = _read_output(out.get("data"))
            if got is not None:
                row.update(got)
        if ctx is not None and getattr(ctx, "calls", None) is not None:
            row["calls"] = _plain(ctx.calls)
        rows.append(row)
    SKILLS[name] = rows


class _Rec:
    def __init__(self, method: str, args: tuple, ret: Any, error: str = "") -> None:
        self.method = method
        self.args = args
        self.return_value = ret
        self.error = error


class _FakeContext:
    """三段信封 `(error, raw, body)` —— 与真机同形。"""

    def __init__(self, table: "dict[str, Any]") -> None:
        self.table = table
        self.calls: "list[dict]" = []

    def safe_call(self, method: str, *args: Any) -> _Rec:
        entry = self.table.get(method)
        self.calls.append({"verb": method, "args": list(args)})
        if entry is None:
            return _Rec(method, args, None, error=f"no stub for {method}")
        if isinstance(entry, dict) and "error" in entry:
            return _Rec(method, args, None, error=str(entry["error"]))
        return _Rec(method, args, ("", b"", entry))


# ── 1. SubtractPlane_RANSAC ────────────────────────────────────────────────

run_skill("SubtractPlane_RANSAC", SubtractPlane_RANSAC(), [
    ("plane_disks", {"image_path": PATHS["plane_disks"]}),
    # 阈值从 1e-10 收到下界 1e-15，答案**一个字不变** —— 背景残差在 1e-25 量级，
    # 圆盘在 5e-9，中间空着十四个数量级。这一格是那张图「没有裙边」的证据。
    ("threshold_1e_15", {"image_path": PATHS["plane_disks"], "residual_threshold": 1e-15}),
    ("few_trials", {"image_path": PATHS["plane_disks"], "max_trials": 10}),
    # ⚠️ 这一格是「最后那次全内点最小二乘」唯一验得到的地方，见 `frame_bowl_disks`。
    ("bowl_needs_the_refit", {"image_path": PATHS["bowl_disks"]}),
    ("from_sxm_picks_z", {"image_path": PATHS["topo"]}),
    ("no_path", {}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
    ("err_broken_npy", {"image_path": PATHS["broken"]}),
], outputs={"plane_disks", "threshold_1e_15", "bowl_needs_the_refit"})

# ── 2. LevelLines_Median ───────────────────────────────────────────────────

run_skill("LevelLines_Median", LevelLines_Median(), [
    ("median", {"image_path": PATHS["stripes"]}),
    # ⚠️ 这一格是 D-VISION-2（`np.median` ≠ `percentile(50)`）在本批唯一
    # 验得到的地方 —— 见 `frame_median_split`。
    ("median_split", {"image_path": PATHS["median_split"]}),
    ("poly1", {"image_path": PATHS["stripes"], "method": "poly", "poly_order": 1}),
    ("poly3", {"image_path": PATHS["plane_disks"], "method": "poly", "poly_order": 3}),
    ("unknown_method", {"image_path": PATHS["plane_disks"], "method": "zzz"}),
    ("no_path", {}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
], outputs={"median", "median_split", "poly1", "poly3", "unknown_method"})

# ── 3. FindEmptySpot ───────────────────────────────────────────────────────

run_skill("FindEmptySpot", FindEmptySpot(), [
    ("grid4", {"image_path": PATHS["rough"]}),
    ("grid2", {"image_path": PATHS["rough"], "grid_n": 2}),
    ("physical_frame", {"image_path": PATHS["rough"], "grid_n": 4,
                        "scan_width_m": 4e-8, "scan_height_m": 2e-8}),
    ("grid_equals_pixels", {"image_path": PATHS["constant"], "grid_n": 16}),
    ("grid_finer_than_pixels", {"image_path": PATHS["tiny"], "grid_n": 16}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
])

# ── 4. CorrectDrift_XCorr ──────────────────────────────────────────────────

_nan_ref = DRIFT_REF.copy()
_nan_ref[0, 0] = np.nan
npy_file("drift_ref_nan", _nan_ref)

run_skill("CorrectDrift_XCorr", CorrectDrift_XCorr(), [
    ("default", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_cur"]}),
    ("no_window", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_cur"],
                   "window": False}),
    # ⚠️ `phase` 这一档只录 `upsample_factor=1`。uf > 1 时 skimage 的
    # `error` 跑到 4.5e13（相位白化之后两条功率和与 `CCmax` 不在一个量纲上），
    # 而 D-NUM-21 那条容差是**平方上的绝对值** —— 一个 2e27 的平方上没有任何
    # 绝对容差说得出话。开关本身在 uf=1 上一样看得见（`error` / `phase` 都变）。
    ("phase_norm", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_cur"],
                    "normalization": "phase", "upsample_factor": 1}),
    ("phase_norm_no_window", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_cur"],
                              "normalization": "phase", "upsample_factor": 1, "window": False}),
    ("uf1", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_cur"],
             "upsample_factor": 1}),
    ("uf1_no_window", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_cur"],
                       "window": False, "upsample_factor": 1}),
    ("same_frame", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_ref"]}),
    ("nan_pixels", {"ref_path": PATHS["drift_ref_nan"], "target_path": PATHS["drift_cur"]}),
    ("err_shape_mismatch", {"ref_path": PATHS["drift_ref"], "target_path": PATHS["drift_small"]}),
    ("err_missing_file", {"ref_path": missing_path("nope.npy"),
                          "target_path": PATHS["drift_cur"]}),
])

# ── 5. SubtractPoly2D ──────────────────────────────────────────────────────

_mask = np.zeros(CURVED.shape, dtype=bool)
_mask[4:11, 5:12] = True
_mask[15:20, 14:19] = True
npy_file("curved_mask", _mask.astype(np.float64))

run_skill("SubtractPoly2D", SubtractPoly2D(), [
    ("order22", {"image_path": PATHS["curved"]}),
    ("order11", {"image_path": PATHS["curved"], "order_x": 1, "order_y": 1}),
    ("order31", {"image_path": PATHS["curved"], "order_x": 3, "order_y": 1}),
    ("masked", {"image_path": PATHS["curved"], "mask_path": PATHS["curved_mask"]}),
    ("mask_unreadable", {"image_path": PATHS["curved"], "mask_path": missing_path("nope.npy")}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
], outputs={"order22", "order11", "order31", "masked"})

# ── 6. Destripe_MorphOpen ──────────────────────────────────────────────────

run_skill("Destripe_MorphOpen", Destripe_MorphOpen(), [
    ("min_len3", {"image_path": PATHS["stripes"], "min_length": 3}),
    ("default_min_len5", {"image_path": PATHS["stripes"]}),
    ("min_len6_opens_everything", {"image_path": PATHS["stripes"], "min_length": 6}),
    ("hard_10_nothing_is_hard", {"image_path": PATHS["stripes"], "hard_threshold": 10.0}),
    # 软阈抬到 2.5（软档实测 2.114）⇒ 软的那一层整个消失，只剩硬的三条一段
    # 加两条孤立的，开运算之后剩 3 行。这一格钉的是「软阈在筛什么」。
    ("soft_2_5", {"image_path": PATHS["stripes"], "soft_threshold": 2.5, "min_length": 3}),
    ("dead_flat", {"image_path": PATHS["constant"]}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
], outputs={"min_len3", "default_min_len5", "soft_2_5"})

# ── 7. AutoCrop_UnscannedRegion ────────────────────────────────────────────

run_skill("AutoCrop_UnscannedRegion", AutoCrop_UnscannedRegion(), [
    # 缺省容差 = 峰谷的 2%，在这张图上**整幅都像实心的** ⇒ `t + b >= 0.9·h`
    # 那道保险当场把 t/b 归零。一格「容差给松了会怎样」，而它的答案不是
    # 「多切一点」，是**一刀不切**。
    ("loose_default_tolerance", {"image_path": PATHS["bordered"]}),
    ("three_passes", {"image_path": PATHS["bordered"], "tolerance": 1e-13}),
    ("one_pass", {"image_path": PATHS["bordered"], "tolerance": 1e-13, "max_iter": 1}),
    ("nothing_to_crop", {"image_path": PATHS["plane_disks"]}),
    ("save_path_forced_npy", {"image_path": PATHS["bordered"], "tolerance": 1e-13,
                              "save_path": f"{TMP}/crop_out.txt".replace("\\", "/")}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
], outputs={"three_passes", "one_pass", "save_path_forced_npy"})

# ── 8. Denoise_AE ──────────────────────────────────────────────────────────

run_skill("Denoise_AE", Denoise_AE(), [
    ("gaussian_default", {"image_path": PATHS["plane_disks"]}),
    ("sigma_2_5", {"image_path": PATHS["plane_disks"], "gaussian_sigma": 2.5}),
    ("model_path_falls_back", {"image_path": PATHS["plane_disks"],
                               "model_path": missing_path("no-such-model.pth")}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
], outputs={"gaussian_default", "sigma_2_5", "model_path_falls_back"})

# ── 9. DetectAtomJump ──────────────────────────────────────────────────────

_jump = np.concatenate([np.full(40, 1.0e-10), np.full(40, 5.0e-10)])
_flat = 1.0e-10 + 1.0e-13 * np.cos(np.arange(80, dtype=np.float64))
npy_file("trace_jump", _jump)


def _json_arr(a: np.ndarray) -> str:
    return json.dumps([float(x) for x in a])


run_skill("DetectAtomJump", DetectAtomJump(), [
    ("json_jump", {"current_trace": _json_arr(_jump)}),
    ("json_flat", {"current_trace": _json_arr(_flat)}),
    ("json_short", {"current_trace": "[1, 2, 3]"}),
    ("json_constant", {"current_trace": _json_arr(np.full(40, 2.0e-10))}),
    ("threshold_1_flat", {"current_trace": _json_arr(_flat), "threshold": 1.0}),
    # ⚠️ **唯一一格 `jumped: true`**，而它只在 `threshold = 1.0` 上成立。
    # 中点分半时 `z = d / √(s² + d²/4) ≤ 2` —— 与跳变有多大无关。
    # 缺省阈值 3.0 于是**永远**报不出跳变。见交接与 deviation 那一条。
    ("threshold_1_jump", {"current_trace": _json_arr(_jump), "threshold": 1.0}),
    ("npy_path", {"current_trace": PATHS["trace_jump"]}),
    ("dat_path", {"current_trace": PATHS["trace"]}),
    ("model_path_says_cnn", {"current_trace": _json_arr(_jump),
                             "model_path": missing_path("no-such-model.pth")}),
    ("err_bad_json", {"current_trace": "not json at all"}),
    ("err_missing_file", {"current_trace": missing_path("nope.npy")}),
])

# `confidence` 的容差要一个**相消放大系数**，而它只有从数据里才算得出来。
#
# `z = |mean₂ − mean₁| / std`，而这一族的曲线是「1e-10 上下抖 1e-13」——
# 两个均值几乎相等，它们的**差**把各自的舍入放大了
# `(|m₁| + |m₂|) / |m₂ − m₁|` 倍（`_flat` 上是 2.4e4）。
# 不录这个数的话，`confidence` 那一条容差只能靠「试出一个能过的数」，
# 而那正是这一层不许做的事（numerics-3 §六②）。
def _cancellation(trace: np.ndarray) -> float:
    t = np.asarray(trace, dtype=np.float64).ravel()
    mid = len(t) // 2
    m1 = float(np.mean(t[:mid]))
    m2 = float(np.mean(t[mid:]))
    d = abs(m2 - m1)
    return float((abs(m1) + abs(m2)) / d) if d > 0 else 1.0


ATOM_JUMP_FACTS = {
    "json_jump": {"n": len(_jump), "cancellation": _cancellation(_jump)},
    "json_flat": {"n": len(_flat), "cancellation": _cancellation(_flat)},
    "threshold_1_flat": {"n": len(_flat), "cancellation": _cancellation(_flat)},
    "threshold_1_jump": {"n": len(_jump), "cancellation": _cancellation(_jump)},
    "npy_path": {"n": len(_jump), "cancellation": _cancellation(_jump)},
    "model_path_says_cnn": {"n": len(_jump), "cancellation": _cancellation(_jump)},
    "dat_path": {"n": 64, "cancellation": _cancellation(
        np.column_stack([_t * 0.01, np.where(_t < 32, 1.0e-10, 4.0e-10)]))},
}

# ── 10. LoadScanFrameFromFile ──────────────────────────────────────────────

_FRAMES_DIR = f"{TMP}/frames".replace("\\", "/")
run_skill("LoadScanFrameFromFile", LoadScanFrameFromFile(), [
    ("z_channel", {"scan_path": PATHS["topo"], "save_dir": _FRAMES_DIR}),
    # ⚠️ 与上一格**同文件同通道**，而墙钟被钉死了 ⇒ 名字撞上 ⇒ 走「取第一个空位」
    # 那条路（`_01` 后缀）。旧仓 2026-07-28 的修补就在那里，而一个每次都不同的
    # 时间戳会让它永远验不到。
    ("z_channel_again_collides", {"scan_path": PATHS["topo"], "save_dir": _FRAMES_DIR}),
    ("current_channel", {"scan_path": PATHS["topo"], "channel": "Current",
                         "save_dir": _FRAMES_DIR}),
    ("err_empty_path", {"scan_path": ""}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm")}),
    ("err_not_an_sxm", {"scan_path": PATHS["plane_disks"]}),
    ("err_no_such_channel", {"scan_path": PATHS["topo"], "channel": "Zzz"}),
    ("err_no_backward", {"scan_path": PATHS["fwd_only"]}),
], outputs={"z_channel"})

# ── 11. ParseRegions ───────────────────────────────────────────────────────

_R = {"center_x_m": 1e-8, "center_y_m": -2e-8, "width_m": 5e-8, "height_m": 5e-8}
run_skill("ParseRegions", ParseRegions(), [
    ("two_regions", {"regions": json.dumps([_R, {**_R, "angle_deg": 30.0, "label": "A"}])}),
    ("empty_list", {"regions": "[]"}),
    ("err_bad_json", {"regions": "{not json"}),
    ("err_not_a_list", {"regions": json.dumps(_R)}),
    ("err_too_many", {"regions": json.dumps([_R] * 65)}),
    ("err_not_an_object", {"regions": json.dumps([_R, 7])}),
    ("err_missing_field", {"regions": json.dumps([{k: v for k, v in _R.items()
                                                  if k != "width_m"}])}),
    # 三种「字段不对」在旧仓走**三个不同的异常**，而报文里带的正是异常那句话：
    # `KeyError` → `'width_m'`；`ValueError` → `could not convert…`；
    # `TypeError` → `float() argument must be…`。本仓逐字复刻这三句
    # （见 `paper-regions.ts` 的 `pyFloatError`）—— 它们是模型读的那一句，
    # 而「缺字段」与「字段类型不对」是两件不同的事。
    ("err_bad_field_type", {"regions": json.dumps([{**_R, "width_m": "wide"}])}),
    ("err_null_field", {"regions": json.dumps([{**_R, "width_m": None}])}),
    ("err_list_field", {"regions": json.dumps([{**_R, "height_m": [1, 2]}])}),
    ("err_bool_field_is_fine", {"regions": json.dumps([{**_R, "angle_deg": True}])}),
    # ⚠️ `angle_deg` / `label` 两个字段**在 try 块外面** —— 一个坏 `angle_deg`
    # 不是被拒，是**抛出去**。四个必填字段拒、第五个抛，而两者对调用方
    # 完全不是一回事。照移（连抛的那句话一起），在交接里记一笔。
    ("raises_bad_angle", {"regions": json.dumps([{**_R, "angle_deg": "spin"}])}),
    ("label_from_number", {"regions": json.dumps([{**_R, "label": 7}])}),
    ("err_center_out_of_range", {"regions": json.dumps([{**_R, "center_x_m": 2e-3}])}),
    ("err_size_out_of_range", {"regions": json.dumps([{**_R, "width_m": 1e-4}])}),
    ("err_size_too_small", {"regions": json.dumps([{**_R, "height_m": 1e-12}])}),
])

# ── 12. ComputeDriftVector ─────────────────────────────────────────────────

_GRAB_OK = [4, "Z (m)", 32, 32, np.asarray(DRIFT_CUR, dtype=np.float64), 1]
_GRAB_SMALL = [4, "Z (m)", 16, 16, np.asarray(DRIFT_REF[:16, :16], dtype=np.float64), 1]
DRIFT_STUBS = {
    "ok": {"Scan_FrameDataGrab": _GRAB_OK},
    "small": {"Scan_FrameDataGrab": _GRAB_SMALL},
    "grab_error": {"Scan_FrameDataGrab": {"error": "NanonisError: no frame in buffer"}},
    "grab_empty": {"Scan_FrameDataGrab": []},
}
_drift_ctx = {k: _FakeContext(DRIFT_STUBS[s]) for k, s in [
    ("ok", "ok"), ("backward", "ok"), ("size_mismatch", "small"),
    ("err_grab", "grab_error"), ("err_empty_body", "grab_empty"),
    ("err_missing_ref", "ok"),
]}

run_skill("ComputeDriftVector", ComputeDriftVector(), [
    ("ok", {"ref_path": PATHS["drift_ref"], "scan_width_m": 1e-8}),
    ("backward", {"ref_path": PATHS["drift_ref"], "scan_width_m": 1e-8,
                  "channel_index": 14, "direction": 0}),
    ("size_mismatch", {"ref_path": PATHS["drift_ref"], "scan_width_m": 1e-8}),
    ("err_grab", {"ref_path": PATHS["drift_ref"], "scan_width_m": 1e-8}),
    ("err_empty_body", {"ref_path": PATHS["drift_ref"], "scan_width_m": 1e-8}),
    ("err_missing_ref", {"ref_path": missing_path("nope.npy"), "scan_width_m": 1e-8}),
], ctxs=_drift_ctx)

DRIFT_STUB_TABLE = {k: _plain(v) for k, v in DRIFT_STUBS.items()}


# ══════════════════════════════════════════════════════════════════════════
# 批 7b-3 · paper 四个纯函数
# ══════════════════════════════════════════════════════════════════════════

# ── 13. DiffScans_ChangeDetect ─────────────────────────────────────────────

run_skill("DiffScans_ChangeDetect", DiffScans_ChangeDetect(), [
    # 已知的整数位移：`drift_cur` 就是 `drift_ref` 平移 (3, −2) 得来的。
    # 配准之后 `rms_after` 应当塌到接近 0（那一片重叠区里两张图逐点相同），
    # 而 `rms_before` 是没对齐时的残差 —— 两者之比就是 `rms_improvement`。
    ("registered", {"scan_a_path": PATHS["drift_ref"], "scan_b_path": PATHS["drift_cur"]}),
    # ⚠️ 关掉配准 ⇒ 位移 (0,0) ⇒ `rms_before == rms_after` ⇒ 改善**恰好 0**。
    # 这一格钉的是 `register` 这个开关真的在做决定。
    ("no_register", {"scan_a_path": PATHS["drift_ref"], "scan_b_path": PATHS["drift_cur"],
                     "register": False}),
    # 同一张图：`rms_before` 是 0 ⇒ 走 `if rms_before > 0 else 0.0` 的**另一支**。
    # 没有这一格，那条三目里的 `else` 分支一次都不执行。
    ("same_frame", {"scan_a_path": PATHS["drift_ref"], "scan_b_path": PATHS["drift_ref"]}),
    # 尺寸不同 ⇒ 落到左上角的公共区。**刻意不是方的**（32×32 与 20×24 ⇒ 20×24）：
    # `ny`/`nx` 是两条独立的取小，方图分不开它们。
    ("shape_mismatch", {"scan_a_path": PATHS["drift_ref"],
                        "scan_b_path": PATHS["drift_cur_small"]}),
    # `save_path` 的后缀不是 `.npy` ⇒ **换掉**最后一个扩展名（不是追加）。
    ("save_path_forced_npy", {"scan_a_path": PATHS["drift_ref"], "scan_b_path": PATHS["drift_cur"],
                              "save_path": f"{TMP}/diff_out.txt".replace("\\", "/")}),
    # ⚠️ 输出名**正好等于输入之一** ⇒ 再加一层 `_diff`，绝不覆盖输入。
    ("save_path_would_overwrite_input",
     {"scan_a_path": PATHS["drift_ref"], "scan_b_path": PATHS["drift_cur"],
      "save_path": PATHS["drift_ref"]}),
    # 从 `.sxm` 读（挑 Z 通道，不是第一路 Current）。
    ("from_sxm_picks_z", {"scan_a_path": PATHS["topo"], "scan_b_path": PATHS["plane_disks"]}),
    # 一维输入 ⇒ `both scans must be 2-D`。
    ("err_one_d", {"scan_a_path": PATHS["one_d"], "scan_b_path": PATHS["drift_cur"]}),
    # 两张图**各有一条**读不动的路：第一张（`scan_a_path`）与第二张。
    # 两句话逐字不同，而它们是模型读的那一句。
    ("err_missing_a", {"scan_a_path": missing_path("nope.npy"), "scan_b_path": PATHS["drift_cur"]}),
    ("err_empty_b", {"scan_a_path": PATHS["drift_ref"], "scan_b_path": PATHS["empty2d"]}),
], outputs={"registered", "no_register", "same_frame", "shape_mismatch",
            "save_path_forced_npy", "save_path_would_overwrite_input"})

# ── 14. DeconvolveTip_RL ───────────────────────────────────────────────────

run_skill("DeconvolveTip_RL", DeconvolveTip_RL(), [
    ("gaussian_default", {"image_path": PATHS["blurred"]}),
    # σ=1.0 ⇒ 核 7×7（`int(6·1)|1 = 7`）。σ=0.4 ⇒ `int(2.4)|1 = 3`，
    # 也就是 `max(size, 3)` 那条下限**旁边**的一格。
    ("sigma_1", {"image_path": PATHS["blurred"], "psf_sigma": 1.0}),
    ("sigma_small_hits_min_size", {"image_path": PATHS["blurred"], "psf_sigma": 0.4}),
    ("iterations_1", {"image_path": PATHS["blurred"], "iterations": 1}),
    # `damping = 1.0` ⇒ `correction ** damping` 那一步**整个不做**（`if damping < 1.0`）。
    ("damping_1_skips_the_power", {"image_path": PATHS["blurred"], "damping": 1.0}),
    ("damping_0_5", {"image_path": PATHS["blurred"], "damping": 0.5}),
    # ⚠️ 自定义 PSF 两格：奇数一格、**偶数一格**。偶数那一格是整份金样里唯一
    # 分得开「same-卷积的原点」的地方，见 `_psf4` 上面那段。
    ("custom_psf_odd", {"image_path": PATHS["blurred"], "psf_mode": "custom",
                        "psf_path": PATHS["psf3"], "iterations": 5}),
    ("custom_psf_even", {"image_path": PATHS["blurred"], "psf_mode": "custom",
                         "psf_path": PATHS["psf4"], "iterations": 5}),
    ("err_custom_without_path", {"image_path": PATHS["blurred"], "psf_mode": "custom"}),
    ("err_custom_psf_missing", {"image_path": PATHS["blurred"], "psf_mode": "custom",
                                "psf_path": missing_path("nope.npy")}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
], outputs={"gaussian_default", "sigma_1", "sigma_small_hits_min_size", "iterations_1",
            "damping_1_skips_the_power", "damping_0_5",
            "custom_psf_odd", "custom_psf_even"})

# 每一轮的 `change` —— **收敛判据的余量要看得见**。
#
# `richardson_lucy` 在 `change < 1e-6` 时提前返回，而 `iterations_used`
# 是一个**整数**：两侧的卷积一个走 FFT、一个直接算，`change` 只在最后几位不同，
# 但那是一次**比较**，落在 1e-6 边上就换答案。这张表让「离边界多远」可查；
# 测试拿它算 `iterations_used` 那一格到底有没有分辨力。
def _rl_changes(image: np.ndarray, psf: np.ndarray, iterations: int, damping: float) -> list:
    from scipy.signal import fftconvolve
    img_min = image.min()
    im = image - img_min + 1e-12
    psf_mirror = psf[::-1, ::-1]
    est = im.copy()
    out = []
    for _ in range(iterations):
        prev = est
        conv = np.maximum(fftconvolve(est, psf, mode="same"), 1e-30)
        corr = fftconvolve(im / conv, psf_mirror, mode="same")
        if damping < 1.0:
            corr = corr ** damping
        new = est * corr
        ch = float(np.mean(np.abs(new - prev)) / (np.mean(np.abs(new)) + 1e-30))
        out.append(ch)
        if ch < 1e-6:
            break
        est = new
    return out


from mast.skills.paper.deconvolution import make_gaussian_psf as _mk_psf  # noqa: E402

RL_FACTS = {
    "gaussian_default": {"psf_shape": list(_mk_psf(2.0).shape),
                         "changes": _rl_changes(BLURRED, _mk_psf(2.0), 30, 0.8)},
    "sigma_1": {"psf_shape": list(_mk_psf(1.0).shape),
                "changes": _rl_changes(BLURRED, _mk_psf(1.0), 30, 0.8)},
    "sigma_small_hits_min_size": {"psf_shape": list(_mk_psf(0.4).shape),
                                  "changes": _rl_changes(BLURRED, _mk_psf(0.4), 30, 0.8)},
    "iterations_1": {"psf_shape": list(_mk_psf(2.0).shape),
                     "changes": _rl_changes(BLURRED, _mk_psf(2.0), 1, 0.8)},
    "damping_1_skips_the_power": {"psf_shape": list(_mk_psf(2.0).shape),
                                  "changes": _rl_changes(BLURRED, _mk_psf(2.0), 30, 1.0)},
    "damping_0_5": {"psf_shape": list(_mk_psf(2.0).shape),
                    "changes": _rl_changes(BLURRED, _mk_psf(2.0), 30, 0.5)},
    "custom_psf_odd": {"psf_shape": [3, 3], "changes": _rl_changes(BLURRED, _psf3, 5, 0.8)},
    "custom_psf_even": {"psf_shape": [4, 4], "changes": _rl_changes(BLURRED, _psf4, 5, 0.8)},
}

# ── 15. SegmentRegion_UNet ─────────────────────────────────────────────────

run_skill("SegmentRegion_UNet", SegmentRegion_UNet(), [
    ("n3_default", {"image_path": PATHS["curved"]}),
    # ⚠️ `n_classes=2` ⇒ 阈值是中位数 ⇒ 576 个像素**正好一半一半**
    # ⇒ `np.argmax(counts)` 遇到并列 —— 它取**第一个**，也就是标签 0。
    # 写成「取最大的那个标签」会在这一格当场变红。
    ("n2_tie_goes_to_the_first", {"image_path": PATHS["curved"], "n_classes": 2}),
    ("n5", {"image_path": PATHS["curved"], "n_classes": 5}),
    # 这张图只有两个平顶盘 + 一个二次背景，`n_classes=10` 仍然给得出 10 档 ——
    # 分位数落在连续的背景上。
    ("n10", {"image_path": PATHS["curved"], "n_classes": 10}),
    # ML 那一支：给了 `model_path` 但模型不存在 ⇒ 旧仓 `except` ⇒ 回退，
    # **而 `method` 报的是真的跑了哪一条**（`heuristic`）。本仓永远走这一支。
    ("model_path_falls_back", {"image_path": PATHS["curved"],
                               "model_path": missing_path("no-such-model.pt")}),
    ("from_sxm_picks_z", {"image_path": PATHS["topo"]}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
])

# ── 16. DetectAtoms_FCN ────────────────────────────────────────────────────

run_skill("DetectAtoms_FCN", DetectAtoms_FCN(), [
    # ⚠️ 这一格同时验三道闸：半整数质心（横向相邻的一对）、
    # **四邻接**（对角相邻的一对必须给两个原子）、以及 `> std` 那道。
    ("atoms_default_min_dist", {"image_path": PATHS["atoms"]}),
    # 窗口从 11 收到 3 ⇒ `(8,11)` 那个 0.8 的次峰不再被 `(8,8)` 压住 ⇒ 多一个原子。
    ("atoms_min_dist_1", {"image_path": PATHS["atoms"], "min_distance_px": 1}),
    ("atoms_min_dist_10", {"image_path": PATHS["atoms"], "min_distance_px": 10}),
    # 平顶盘：窗口盖住整个盘 ⇒ 每个盘只有**背景斜坡最高**的那一个像素是局部极大。
    ("plane_disks", {"image_path": PATHS["plane_disks"]}),
    ("model_path_falls_back", {"image_path": PATHS["atoms"],
                               "model_path": missing_path("no-such-model.pt")}),
    ("err_missing_file", {"image_path": missing_path("nope.npy")}),
])


# ──────────────────────────────────────────────────────────────────────────
# 条件数 —— 容差写在它上面，所以它必须**随金样一起录**
# ──────────────────────────────────────────────────────────────────────────


def _plane_cond(ny: int, nx: int) -> float:
    gy, gx = np.mgrid[:ny, :nx]
    A = np.column_stack([gx.ravel().astype(float), gy.ravel().astype(float), np.ones(ny * nx)])
    return float(np.linalg.cond(A))


def _poly2d_cond(ny: int, nx: int, order_x: int, order_y: int) -> float:
    y_coords, x_coords = np.mgrid[:ny, :nx]
    x_norm = 2.0 * x_coords / (nx - 1) - 1.0
    y_norm = 2.0 * y_coords / (ny - 1) - 1.0
    terms = [(x_norm ** i * y_norm ** j).ravel()
             for i in range(order_x + 1) for j in range(order_y + 1)]
    return float(np.linalg.cond(np.column_stack(terms)))


def _vander_cond(n: int, deg: int) -> float:
    """`np.polyfit` **列缩放之后**的条件数 —— 本仓 `polyfit` 照抄了那一步。"""
    x = np.arange(n, dtype=float)
    A = np.column_stack([x ** (deg - j) for j in range(deg + 1)])
    A = A / np.linalg.norm(A, axis=0)
    return float(np.linalg.cond(A))


CONDITION = {
    "plane_32x32": _plane_cond(32, 32),
    "poly2d_24x24_2_2": _poly2d_cond(24, 24, 2, 2),
    "poly2d_24x24_1_1": _poly2d_cond(24, 24, 1, 1),
    "poly2d_24x24_3_1": _poly2d_cond(24, 24, 3, 1),
    "vander_16_1": _vander_cond(16, 1),
    "vander_32_3": _vander_cond(32, 3),
}

# RANSAC 那一格的判据换了一条：从「抽样序列相同」换成「**内点集相同**」
# （见文件抬头）。于是要录两样东西：
#
#   * `n_background` —— 那个内点集有多大（`inlier_ratio` 必须正好等于它/总数）；
#   * `lstsq_all_coefficients` —— **不**剔除圆盘、拿全部像素做一次最小二乘
#     得到的那个平面。它是这道闸的「错的那一侧」：判据因此是
#     **「离对的近、离错的远」**（同 numerics-3 §4 的 `pcov`、同 D-VISION-1），
#     而不是一条谁都过得去的容差。两者差 **7 倍**（`a`: 8.0e-13 对 5.7e-12）。
_gy, _gx = np.mgrid[:32, :32]
_dl = PLANE_DISKS.ravel()
_bg = np.abs(_dl - (1.0e-9 + 0.8e-12 * _gx.ravel() + 0.3e-12 * _gy.ravel())) < 1e-10
_A_all = np.column_stack([_gx.ravel().astype(float), _gy.ravel().astype(float),
                          np.ones(_dl.size)])
RANSAC_FACTS = {
    "n_points": int(_dl.size),
    "n_background": int(_bg.sum()),
    "inlier_ratio": float(_bg.sum() / _dl.size),
    "lstsq_all_coefficients": _plain(np.linalg.lstsq(_A_all, _dl, rcond=None)[0]),
}


def _norm_paths(v: Any) -> Any:
    """临时目录 → `<tmp>`，**并把那条路径里的反斜杠一律换成正斜杠**。

    抹临时目录本身是老规矩（没有它，「重跑逐字节相同」是假的）。多的这一步是
    因为技能自己会用 `Path.with_name()` 造输出路径，而那个函数在 Windows 上
    **按平台**吐分隔符 —— 于是同一次运行里，输入路径是正斜杠、输出路径是反斜杠。
    Node 那侧的 `path.join` 也按平台吐，两边的平台恰好相同，但**换一台机器就不是**。
    分隔符不是判据，路径本身才是。
    """
    if isinstance(v, str):
        s = v.replace(TMP, "<tmp>").replace(TMP.replace("\\", "/"), "<tmp>")
        return s.replace("\\", "/") if "<tmp>" in s else s
    if isinstance(v, dict):
        return {k: _norm_paths(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_norm_paths(x) for x in v]
    return v


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_paper_data.py 生成 —— 旧仓 "
                 "mast.skills.paper.* 与 builtins.scan_frame 真跑一遍。"
                 "输入是合成的文件**字节**（闭式公式，零随机数），"
                 "技能写出去的 .npy 也读回来一起录。",
        "versions": {"numpy": np.__version__, "scipy": scipy.__version__,
                     "skimage": skimage.__version__},
        "condition_numbers": _plain(CONDITION),
        "ransac_facts": _plain(RANSAC_FACTS),
        "atom_jump_facts": _plain(ATOM_JUMP_FACTS),
        # 批 7b-3：RL 每一轮的 `change`（收敛判据的余量）。
        "rl_facts": _plain(RL_FACTS),
        "files": {k: base64.b64encode(v).decode("ascii") for k, v in FILES.items()},
        "drift_stubs": DRIFT_STUB_TABLE,
        "skills": SKILLS,
    }
    text = json.dumps(_norm_paths(doc), ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False)
    # ⚠️ 顺带抹掉**操作系统给的那句错**（同 D-ANALYSIS-1）：
    # `[WinError 2] 系统找不到指定的文件。` 带着本机的语言环境，而它在 Node 那边
    # 叫 `ENOENT: no such file…` —— 两句都对，都不是判据。
    text = re.sub(r"\[WinError [^\"]*", "<oserror>", text)
    text = re.sub(r"\[Errno [^\"]*", "<oserror>", text)
    # JSON 解析器的异常文本两边不同（Python 的 `json` 与 V8 的 `JSON.parse`），
    # 而判据是它前面那半句「谁在拒、拒的是什么」。见 deviation。
    text = re.sub(r"(invalid regions JSON: )[^\"]*", r"\1<json-error>", text)
    text = re.sub(r"(Failed to load current trace: )(?!spectrum file not found)[^\"]*",
                  r"\1<json-error>", text)
    # `LoadScanFrameFromFile` 那句 `读不了 X: {类名}: {那句话}` —— 类名与文本
    # 两半都是 Python 的（`FileNotFoundError` / `ValueError` + reader 的措辞），
    # 而 Node 那边一个都对不上。判据是前半句「谁读不动、读不动哪条路径」。
    # 两侧分得开「文件不存在」与「格式不对」这件事由一条专门的测试钉。见 deviation。
    text = re.sub(r"(读不了 [^\"]*?: )[^\"]*", r"\1<read-error>", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((text + "\n").encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(doc) - 2} 节 · {kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
