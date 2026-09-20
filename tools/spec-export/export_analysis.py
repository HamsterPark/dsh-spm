r"""驱动只读 MAST 的分析函数与技能，生成差分测试参考结果。

本脚本记录 `mast.vision.*` 与 `mast.skills.builtins.*` 的输出。
TypeScript 使用相同输入比较；容差及依据见 `packages/host/vision/src/*.ts`
和 `kernel/src/corrugation-gate.ts`，应在实现前确定。

1. 输入与输出一并保存。测试帧由固定公式合成，不引入真实仪器文件或随机种子状态。
2. 技能输入保存为 base64 编码的 `.sxm` 字节，由参考实现解析，避免迁移实现与
   测试读取器共享同一个格式解析错误。
3. 输出不依赖墙钟或随机数。`MAST2_PROJECT_ROOT` 指向临时目录，隔离本机
   profile 配置对 `AssessFrameCorrugation` 阈值来源的影响。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_analysis.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-analysis-export-"))

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "analysis.json"
MAST = require_mast_root()
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402

from mast.io.mosaic import parse_xy_meta, px_to_m  # noqa: E402
from mast.skills.builtins.adatom_verify import VerifyAdatomAt  # noqa: E402
from mast.skills.builtins.atomic_lines import AssessAtomicLines  # noqa: E402
from mast.skills.builtins.cluster_extract import ExtractClusters  # noqa: E402
from mast.skills.builtins.cluster_roundness import AssessClusterRoundness  # noqa: E402
from mast.skills.builtins.cluster_select import SelectPokedCluster  # noqa: E402
from mast.skills.builtins.frame_corrugation import AssessFrameCorrugation  # noqa: E402
from mast.skills.builtins.frame_trust import (  # noqa: E402
    AssessFrameTrust,
    row_big_jumps,
    row_jump_mad_pm,
    row_jump_sigma_pm,
)
from mast.skills.builtins.step_edge import LocateStepEdge  # noqa: E402
from mast.skills.builtins.step_height import MeasureStepHeight, _levels  # noqa: E402
from mast.vision.atomic_lines import frame_line_advisory, line_score, usable_rows  # noqa: E402
from mast.vision.corrugation_gate import judge_corrugation  # noqa: E402
from mast.vision.frame_validity import acquired_row_mask, judge_frame  # noqa: E402
from mast.vision.roundness import (  # noqa: E402
    assess_mask,
    axis_ratio_from_dispersion,
    background_level,
    dispersion_floor,
    dispersion_of_mask,
    weighted_axis_ratio,
)
from mast.vision.scan_artifacts import _bad_rows, _plane_detrend  # noqa: E402
from mast.vision.step_edge import locate_step_edge  # noqa: E402
from mast.vision.tilt import fit_plane_robust, noise_floor, plane_subtract  # noqa: E402


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
# 合成帧 —— **闭式，零随机数**
# ──────────────────────────────────────────────────────────────────────────


def _hash_noise(ny: int, nx: int, amp: float, salt: float) -> np.ndarray:
    """可复现的「噪声」。经典的 sin-hash：确定、无状态、每次重跑逐位相同。

    ⚠️ 它不是高斯的，也不需要是 —— 这一层要的是「每个像素都不一样」，
    好让「行列搞反了」这类错在数值上立刻看得出来。
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    v = np.sin(i * 12.9898 + j * 78.233 + salt * 37.719) * 43758.5453123
    return amp * (2.0 * (v - np.floor(v)) - 1.0)


def _bump(ny: int, nx: int, cy: float, cx: float, r: float, h: float) -> np.ndarray:
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    d2 = ((i - cy) ** 2 + (j - cx) ** 2) / (r * r)
    return h * np.exp(-d2)


def frame_clusters(ny: int = 96, nx: int = 96) -> np.ndarray:
    """三个大小不同的圆包 + 一条扫描线扰动 + 噪声。单位米。

    线状伪影是刻意的：`ExtractClusters` 的纪律是**照样返回它**（带着它的长宽比），
    由判定层去筛 —— 提取层丢掉的东西，上层永远看不见。
    """
    z = np.full((ny, nx), 1.0e-9) + _hash_noise(ny, nx, 8e-12, 1.0)
    z = z + _bump(ny, nx, 30.0, 28.0, 6.0, 800e-12)
    z = z + _bump(ny, nx, 62.0, 66.0, 4.0, 520e-12)
    z = z + _bump(ny, nx, 20.0, 74.0, 2.6, 360e-12)
    z[70, 8:52] += 300e-12          # 一条扫描线扰动（长宽比会很低）
    return z


def frame_half_scanned(ny: int = 96, nx: int = 96) -> np.ndarray:
    """上面那张图，但**下面 40% 的行是 NaN** —— 真机上「半张图是常态不是例外」。"""
    z = frame_clusters(ny, nx).copy()
    z[int(ny * 0.6):, :] = np.nan
    return z


def frame_terraces(ny: int = 128, nx: int = 128) -> np.ndarray:
    """三个台面 × 235.455 pm（Au(111) d111）+ 倾斜 + 噪声。

    ⚠️ 台面宽度**刻意不并列**（50 / 40 / 38 行）：RANSAC 在 `count > best_count`
    上保留的是**先抽到的那个**，而「先抽到谁」正是 numpy PCG64 与本仓
    `Xoshiro128` 不同的那件事。面积唯一 ⇒ 两边挑中同一个台面 ⇒ 内点集相同 ⇒
    精拟合是同一个最小二乘。判据因此从「抽样序列相同」换成
    「**内点集相同**」，而后者两边都成立。
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    d111 = 235.455e-12
    step = np.where(i < 50, 0.0, np.where(i < 90, d111, 2.0 * d111))
    tilt = 0.8e-12 * j + 0.3e-12 * i
    return 1.0e-9 + step + tilt + _hash_noise(ny, nx, 4e-12, 7.0)


def frame_step_edge(ny: int = 128, nx: int = 128) -> np.ndarray:
    """**两道平行台阶**，其中一道只占上半幅 —— `locate_step_edge` 的 step_edge 那一支。

    ## 为什么不是「一道边」

    第一版是一道斜边。结果 `n_edge_px` 在两边是 228 与 226，而那是我写了
    「容差 0」的那一档。查下去不是浮点问题，是**这个用例没有鉴别力**：

    `locate_step_edge` 把候选像素投到法向之后，拿 `max(8, int(span/3))` 个 bin
    去找**最密的那一簇**。而一道边的候选像素是一条**等宽的带**，投影直方图在带宽上
    是**平的** —— 实测 top4 = `116 / 115 / 99 / 96`，冠军只领先 **1 个计数**。
    于是「最密的是哪个 bin」由**一个像素落在哪边**决定，而那一位在 numpy 与本仓
    之间可以不同。换 `tanh` 过渡、换轴对齐、换帧尺寸，全都还是平的（实测七种，
    最好的 ratio 是 1.009）—— 因为这不是合成得不好，**是这一步本来就是给
    「若干条平行台阶」分簇用的，一道边上它没有东西可分**。
    ⇒ 输入必须给它两条。

    两道边、间距 60 px、第二道只画上面 64 行 ⇒ top4 = `333 / 255 / 199 / 197`，
    冠军领先 **1.31 倍**。一个像素换个 bin 翻不动它。

    （`numerics-2.md` 第五节第二条：「一组分辨不出两种候选的金样，不是判据」。
    这一次分辨不出的不是两种实现，是**同一个实现的两个 bin**。）
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    d111 = 235.455e-12
    e1 = 0.5 * (1.0 + np.tanh((j - 0.35 * i - 30.0) / 1.0))
    e2 = 0.5 * (1.0 + np.tanh((j - 0.35 * i - 90.0) / 1.0))
    short = (i < 64).astype(np.float64)
    return 1.0e-9 + d111 * e1 + d111 * e2 * short + _hash_noise(ny, nx, 3e-12, 11.0)


def frame_tilted_only(ny: int = 128, nx: int = 128) -> np.ndarray:
    """只有斜面、没有台阶 —— `no_step` 的 `terraces_not_separated` 那一支。"""
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    return 1.0e-9 + 2e-12 * j + 1e-12 * i + _hash_noise(ny, nx, 3e-12, 13.0)


def frame_dead_flat(ny: int = 64, nx: int = 64) -> np.ndarray:
    """带倾斜的死平帧，**斜得不够**。

    ⚠️ 这一张**过得了**两道死平判据：存成 float32 之后量化噪声与倾斜的比是
    `4e-7`，刚好在 `FLAT_RATIO_MIN = 1e-7` 之上。它留着是因为它正是
    「一条比值判据的边界在哪」那个用例 —— 而边界的**另一侧**由
    `frame_dead_flat_steep` 把守。
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    return 1.0e-9 + 3e-12 * j + 1e-12 * i


def frame_dead_flat_steep(ny: int = 64, nx: int = 64) -> np.ndarray:
    """**斜得够的**死平帧 —— `judge_frame` 第二档（比值 < 1e-7）走的正是它。

    第一档（去趋势后精确为 0）拦不住它：残差是量化噪声（~3e-16）而不是 0。
    而比值 = `残差 / 原始峰谷`：把倾斜从 0.25 nm 加到 8.9 nm，量化噪声只按
    float32 的相对精度长一点点，于是比值从 `4e-7` 掉到 `3e-8` —— 第二档成立。
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    return 1.0e-9 + 100e-12 * j + 40e-12 * i


def frame_row_jumps(ny: int = 96, nx: int = 96) -> np.ndarray:
    """针尖跳变：几行整体抬落 2 nm。`AssessFrameTrust` 的 `unstable` 那一档。"""
    z = np.full((ny, nx), 1.0e-9) + _hash_noise(ny, nx, 6e-12, 17.0)
    for r in (20, 21, 22, 55, 56, 80):
        z[r, :] += 2.0e-9
    return z


def frame_lattice(ny: int = 64, nx: int = 256, period_px: float = 8.0) -> np.ndarray:
    """沿快扫方向的规则起伏 —— `AssessAtomicLines` 的 `worth_a_frame=True` 那一支。

    5 nm / 256 px ⇒ 0.01953 nm/px，周期 8 px ⇒ **0.15625 nm**，落在
    `PERIOD_MIN_NM=0.15` 与 `PERIOD_MAX_NM=0.45` 的带内。
    """
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    lat = 60e-12 * np.cos(2.0 * np.pi * j / period_px + 0.1 * i)
    slow = 1.0e-9 + 4e-13 * i + 2e-13 * j
    return slow + lat + _hash_noise(ny, nx, 2e-12, 23.0)


# ──────────────────────────────────────────────────────────────────────────
# `.sxm` 合成器（与 `export_nanonis_files.py` 同一套字节口径）
# ──────────────────────────────────────────────────────────────────────────


def sxm_bytes(
    frames: "list[tuple[str, str, list[np.ndarray]]]",
    *,
    nx: int,
    ny: int,
    scan_range: str = "           1.000000E-8           1.000000E-8",
    scan_offset: str = "         0.0E+0         0.0E+0",
    scan_angle: "str | None" = "       0.000E+0",
    scan_dir: str = "down",
    acq_time: str = "          12.8",
) -> bytes:
    """拼一个 `.sxm`：文本头 + 记号 + **大端 float32** 数据块。"""
    lines: "list[str]" = [
        ":NANONIS_VERSION:", "2",
        ":SCANIT_TYPE:", "              FLOAT            MSBFIRST",
        ":REC_DATE:", " 15.09.2026",
        ":REC_TIME:", "12:34:56",
        ":ACQ_TIME:", acq_time,
        ":BIAS:", "\t-1.0000E+0",
        ":Z-CONTROLLER>Setpoint:", "\t100.0E-12",
        ":SCAN_PIXELS:", f"        {nx}         {ny}",
        ":SCAN_RANGE:", scan_range,
        ":SCAN_OFFSET:", scan_offset,
        ":SCAN_DIR:", scan_dir,
    ]
    if scan_angle is not None:
        lines += [":SCAN_ANGLE:", scan_angle]
    lines += [":DATA_INFO:", "\tChannel\tName\tUnit\tDirection\tCalibration\tOffset"]
    for i, (name, direction, _blocks) in enumerate(frames):
        lines.append(f"\t{i}\t{name}\tm\t{direction}\t9.000E-9\t0.000E+0")
    lines += [":SCANIT_END:", ""]
    head = "\n".join(lines).encode("utf-8")
    blob = b""
    for _name, _direction, blocks in frames:
        for arr in blocks:
            blob += np.asarray(arr, dtype=">f4").tobytes()
    return head + b"\\1A\\04" + blob


FILES: "dict[str, bytes]" = {}


def write_file(key: str, raw: bytes) -> str:
    """把一份合成的 `.sxm` 落到临时目录，并把字节收进金样。

    ⚠️ 路径用**正斜杠**交出去。Windows 的 `open()` 两种都吃，而反斜杠在 JSON 里
    要转义、在 `repr()` 里再转义一次，于是同一条临时路径在金样里有三种写法，
    「抹掉临时目录」这件事就得写三个 replace —— 那是给下一次重跑埋的雷。
    """
    FILES[key] = raw
    p = Path(TMP) / f"{key}.sxm"
    p.write_bytes(raw)
    return str(p).replace("\\", "/")


def missing_path(name: str) -> str:
    """一条**不存在**的路径（各技能的「文件不存在」那一支）。"""
    return f"{TMP}/{name}".replace("\\", "/")


TMP = tempfile.mkdtemp(prefix="mast-analysis-sxm-")


# ──────────────────────────────────────────────────────────────────────────
# 合成的 `.sxm` 一次写完，**后面每一节都从字节读回来**
# ──────────────────────────────────────────────────────────────────────────
#
# ⚠️ 这一步不是为了省事，是为了让两边看到**同一串 float64**。
#
# 第一版是两边各按同一个闭式公式重建帧，结果在 `noise_floor` 上分岔了
# `4.4e-14` 相对 —— 而那一条我写的是**容差 0**。查下去不是 `sin` 的实现差异，
# 是**加法的结合顺序**：numpy 先把 `tilt = 0.8e-12*j + 0.3e-12*i` 算成一个数组
# 再加，而 TS 那边写成 `((z + 0.8e-12*j) + 0.3e-12*i)`。数学上相同、浮点上不同。
#
# 「两边各自重建同一个输入」这件事本身就是一处**没有人在看的差异**。
# 改成从字节读回来之后它整类消失：float32 的字节两边读出来逐位相同，
# 而这也正是技能在真机上看到的那一份。
#
# （同 `export_nanonis_files.py` 抬头那条：**字节我们合成，读法归旧仓**。）

_c = frame_clusters()
_hs = frame_half_scanned()
_t = frame_terraces()
_se = frame_step_edge()
_to = frame_tilted_only()
_df = frame_dead_flat()
_dfs = frame_dead_flat_steep()
_rj = frame_row_jumps()

PATHS = {
    "clusters": write_file("clusters", sxm_bytes(
        [("Z", "both", [_c, _c[:, ::-1]])], nx=96, ny=96)),
    "half": write_file("half", sxm_bytes(
        [("Z", "both", [_hs, _hs[:, ::-1]])], nx=96, ny=96)),
    "clusters_no_angle": write_file("clusters_no_angle", sxm_bytes(
        [("Z", "both", [_c, _c[:, ::-1]])], nx=96, ny=96, scan_angle=None)),
    "terraces": write_file("terraces", sxm_bytes(
        [("Z", "both", [_t, _t[:, ::-1]])], nx=128, ny=128,
        scan_range="           2.000000E-8           2.000000E-8")),
    "step_edge": write_file("step_edge", sxm_bytes(
        [("Z", "both", [_se, _se[:, ::-1]])], nx=128, ny=128,
        scan_range="           2.000000E-8           2.000000E-8")),
    "tilted": write_file("tilted", sxm_bytes(
        [("Z", "both", [_to, _to[:, ::-1]])], nx=128, ny=128,
        scan_range="           2.000000E-8           2.000000E-8")),
    "dead_flat": write_file("dead_flat", sxm_bytes(
        [("Z", "both", [_df, _df[:, ::-1]])], nx=64, ny=64)),
    "dead_flat_steep": write_file("dead_flat_steep", sxm_bytes(
        [("Z", "both", [_dfs, _dfs[:, ::-1]])], nx=64, ny=64)),
    "row_jumps": write_file("row_jumps", sxm_bytes(
        [("Z", "both", [_rj, _rj[:, ::-1]])], nx=96, ny=96)),
    "current_only": write_file("current_only", sxm_bytes(
        [("Current", "both", [_c, _c[:, ::-1]])], nx=96, ny=96)),
    # **完全常数** —— float32 存进去也还是常数，于是 `judge_frame` 走第一档
    # （去趋势后精确为 0），而 `ExtractClusters` 走「已扫区域的 MAD 是 0」。
    # `frame_dead_flat` 那张**带倾斜**的过不了这两道：float32 量化让残差变成
    # 一串阶梯，比值 4e-7 > 1e-7。两张都留着 —— 它们分的正是那两档。
    "constant": write_file("constant", sxm_bytes(
        [("Z", "both", [np.full((64, 64), 1.0e-9), np.full((64, 64), 1.0e-9)])],
        nx=64, ny=64)),
    # 8×8 = 64 个像素 < 100 —— `AssessFrameTrust` 的「判不了，这不是针尖坏」那一档。
    # 那一档要有自己的一格，否则它的变异是绿的（**而绿的意思是那道闸不存在**）。
    "tiny": write_file("tiny", sxm_bytes(
        [("Z", "both", [_c[:8, :8], _c[:8, :8][:, ::-1]])], nx=8, ny=8)),
}

# ── 一份**标定过的**外部 profile ────────────────────────────────────────────
#
# 内建 profile 的起伏门出厂就是「判不了」（两个键都是 `None`），于是
# `AssessFrameCorrugation` 开箱只走得到 `undecidable` 那几支。而
# 「阈值与它的标定视野是**一组**」这条纪律要**两边都有值**才验得到：
# 只有 profile 那一对是满的，「给了一半会不会拿 profile 去补另一半」才分得开。
#
# 旧仓从 `project_root()/config/scan_prep_profiles.json` 读；本仓是注入
# （`scanPrepProfiles.external`，同 D-VAC-1 那一族）。两边喂同一份。
_CFG = Path(os.environ["MAST2_PROJECT_ROOT"]) / "config"
_CFG.mkdir(parents=True, exist_ok=True)
(_CFG / "scan_prep_profiles.json").write_text(
    json.dumps({
        "calibrated-10nm": {
            "thresholds": {"corrugation_high_pm": 40.0, "corrugation_ref_scan_nm": 10.0},
            "provenance": "合成的一份：10 nm 上标的 40 pm 上限（导出器写的）",
        },
    }, ensure_ascii=False),
    encoding="utf-8",
)

_LOADED: "dict[str, np.ndarray]" = {}


def loaded(key: str) -> np.ndarray:
    """把一份合成的 `.sxm` 用**旧仓的读法**读回来（几何归位之后的正扫帧）。"""
    from mast.io.nanonis_files import read_sxm, sxm_oriented_frames

    if key not in _LOADED:
        fr = sxm_oriented_frames(read_sxm(PATHS[key]), "Current" if key == "current_only" else "Z")
        _LOADED[key] = np.asarray(fr["forward"], dtype=np.float64)
    return _LOADED[key]


# ──────────────────────────────────────────────────────────────────────────
# 假 context（`AssessAtomicLines` 唯一要仪器的那一个）
# ──────────────────────────────────────────────────────────────────────────


class _Rec:
    def __init__(self, method: str, args: tuple, ret: Any, error: str = "") -> None:
        self.method = method
        self.args = args
        self.return_value = ret
        self.error = error


class _FakeContext:
    """只答这四个动词。**回包是三段信封** `(error, raw, body)` —— 与真机同形。"""

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


# ──────────────────────────────────────────────────────────────────────────
# 1. 几何：parse_xy_meta / px_to_m
# ──────────────────────────────────────────────────────────────────────────

XY_META: "dict[str, Any]" = {"parse": [], "px_to_m": []}
for key, header in [
    ("plain", {"scan_offset": "1.0E-8 -2.0E-8", "scan_range": "5.0E-8 4.0E-8",
               "scan_angle": "30.0"}),
    ("no_angle_key", {"scan_offset": "0 0", "scan_range": "1e-8 1e-8"}),
    ("angle_garbage", {"scan_offset": "0 0", "scan_range": "1e-8 1e-8",
                       "scan_angle": "not-a-number"}),
    ("negative_range", {"scan_offset": "0 0", "scan_range": "-1e-8 -2e-8"}),
    ("zero_range", {"scan_offset": "0 0", "scan_range": "0 1e-8"}),
    ("missing_offset", {"scan_range": "1e-8 1e-8"}),
    ("short_offset", {"scan_offset": "1e-8", "scan_range": "1e-8 1e-8"}),
]:
    XY_META["parse"].append({"key": key, "header": header,
                             "result": _plain(parse_xy_meta(header))})

for key, kw in [
    ("axis_aligned", dict(px_x=0.0, px_y=0.0, nx=64, ny=64, cx_m=0.0, cy_m=0.0,
                          w_m=1e-8, h_m=1e-8, angle_deg=0.0)),
    ("centre", dict(px_x=31.5, px_y=31.5, nx=64, ny=64, cx_m=1e-8, cy_m=-2e-8,
                    w_m=1e-8, h_m=1e-8, angle_deg=0.0)),
    ("rotated30", dict(px_x=10.0, px_y=50.0, nx=64, ny=64, cx_m=1e-8, cy_m=-2e-8,
                       w_m=1e-8, h_m=2e-8, angle_deg=30.0)),
    ("rotated_neg", dict(px_x=63.0, px_y=0.0, nx=64, ny=32, cx_m=-3e-9, cy_m=7e-9,
                         w_m=2e-8, h_m=1e-8, angle_deg=-17.5)),
]:
    XY_META["px_to_m"].append({"key": key, "kwargs": _plain(kw),
                               "result": _plain(list(px_to_m(**kw)))})


# ──────────────────────────────────────────────────────────────────────────
# 2. 帧有效性：acquired_row_mask / judge_frame
# ──────────────────────────────────────────────────────────────────────────

VALIDITY: "dict[str, Any]" = {"acquired_row_mask": [], "judge_frame": []}

_arm_cases = {
    "all_finite": [np.array([[1.0, 2.0], [3.0, 4.0]])],
    "nan_tail": [np.array([[1.0, 2.0], [3.0, np.nan], [np.nan, np.nan]])],
    "zero_rows": [np.array([[1.0, 2.0], [0.0, 0.0], [3.0, 4.0]])],
    "all_zero": [np.zeros((3, 2))],
    "partial_row": [np.array([[1.0, 2.0, 3.0], [4.0, np.nan, 6.0]])],
    "two_frames": [np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]),
                   np.array([[1.0, 2.0], [np.nan, 4.0], [5.0, 6.0]])],
    "half_scanned": [loaded("half")],
}
for key, frames_in in _arm_cases.items():
    VALIDITY["acquired_row_mask"].append({
        "key": key,
        "frames": [_plain(f) for f in frames_in],
        "mask": _plain(acquired_row_mask(*frames_in).astype(int).tolist()),
    })

# ⚠️ `dead_flat_float64` **不走 `.sxm`**，它是一份 float64 的倾斜平面。
#
# 那一格专门验 `judge_frame` 的 `std` 是在 **float32** 里算的：去趋势残差在
# `1e-25` 量级，而 `1e-25` 的平方在 float32 里**下溢成 0** ⇒ 方差 0 ⇒ 第一档
# （精确为 0）成立。在 float64 里算的话 `std ≈ 1e-25 ≠ 0`，同一张帧改走第二档、
# **报的是另一句话**。
#
# 存成 `.sxm` 的那几张都过不了这一关：float32 的量化噪声（~1e-16）远大于
# 下溢的门槛。换句话说，**只有活体帧（直接从线上拿到的 float64）撞得到这一条** ——
# 而 `judge_frame` 在旧仓正是这么被 `PreScanCheck` 一族用的。
_flat64 = np.arange(16, dtype=np.float64)[None, :] * 3e-12 \
    + np.arange(16, dtype=np.float64)[:, None] * 1e-12 + 1.0e-9
for key, frame in [
    ("clusters", loaded("clusters")),
    ("dead_flat_tilted", loaded("dead_flat")),
    ("dead_flat_steep", loaded("dead_flat_steep")),
    ("dead_flat_float64", _flat64),
    ("constant", loaded("constant")),
    ("all_nan", np.full((8, 8), np.nan)),
    ("too_narrow", np.zeros((4, 1))),
    ("terraces", loaded("terraces")),
]:
    v = judge_frame(frame)
    VALIDITY["judge_frame"].append({
        "key": key,
        "shape": list(frame.shape),
        # 小到能进金样的那一格把**输入也录下来**（大帧走 `sxm_files`）。
        "frame": _plain(frame) if frame.size <= 256 else None,
        "usable": bool(v.usable),
        "reason": v.reason,
        "corrugation_rms_m": _plain(float(v.corrugation_rms_m)),
        "detrended_sample": _plain(
            None if v.detrended is None
            else np.asarray(v.detrended, dtype=np.float64)[:2, :4].tolist()),
    })


# ──────────────────────────────────────────────────────────────────────────
# 3. K2 平面族
# ──────────────────────────────────────────────────────────────────────────

# ── `np.median` ≠ `np.percentile(50)`：**必然分岔**的那几串 ──
#
# 偶数长度时 `np.median` 算 `(a+b)/2`，`np.percentile(·, 50)` 算 `a+(b−a)·0.5`。
# 数学上相等、浮点上不等。下面这几串是**挑出来让它们分岔的**，不是随手取的 ——
# 「容差不是摆设」这句话不能拿随机数据来证（`numerics.md` 第四节第二条）：
# 第一版拿合成帧去验，结果两者恰好处处相等，那条演练于是绿着什么也没验。
NP_MEDIAN: "list[dict]" = []
for _xs in ([0.1, 0.3], [0.1, 0.2, 0.3, 0.7], [1e16, 1.0, -1e16, 3.0],
            [0.7, 0.30000000000000004], [-0.1, 0.30000000000000004]):
    NP_MEDIAN.append({
        "input": _plain(_xs),
        "median": _plain(float(np.median(_xs))),
        "percentile50": _plain(float(np.percentile(_xs, 50))),
        "differ": bool(float(np.median(_xs)) != float(np.percentile(_xs, 50))),
    })

PLANE: "dict[str, Any]" = {"noise_floor": [], "fit_plane_robust": [], "plane_subtract": []}
for key, frame in [
    ("clusters", loaded("clusters")),
    ("terraces", loaded("terraces")),
    ("tilted_only", loaded("tilted")),
    ("constant", loaded("constant")),
    ("single_column", np.zeros((8, 1))),
]:
    PLANE["noise_floor"].append({"key": key, "value": _plain(float(noise_floor(frame)))})

for key, frame, sigma in [
    ("terraces_auto", loaded("terraces"), None),
    # **每一个够好的三点假设都圈出同一个内点集**（整条台面在带内、隔壁台面在带外）
    # ⇒ 重拟合逐位相同。这一格按 `planeRelTol` 比，不吃 RANSAC 那条容差。
    #
    # ⚠️ 曾经还有一格 `sigma=20pm`（阈值 60 pm），**已经删掉**：在那个阈值上
    # 「一条沿楼梯斜穿的平面」与「一整条台面」的内点数相当，于是挑中谁**由抽样
    # 序列决定**，两边的答案差一个量级。一个答案是掷骰子的用例不是判据，
    # 留着它只会让下一个人去调容差 —— 而那正是「容差变成刚好让我这版通过的那个数」。
    ("terraces_sigma10pm", loaded("terraces"), 10e-12),
    ("clusters_auto", loaded("clusters"), None),
    ("tilted_only_auto", loaded("tilted"), None),
    ("constant_auto", loaded("constant"), None),
]:
    fit = fit_plane_robust(frame, sigma=sigma)
    PLANE["fit_plane_robust"].append({
        "key": key, "sigma": _plain(sigma), "shape": list(frame.shape),
        "result": None if fit is None else {
            "a": _plain(float(fit[0])), "b": _plain(float(fit[1])),
            "c": _plain(float(fit[2])), "inlier_ratio": _plain(float(fit[3])),
        },
    })

for key, frame in [("terraces", loaded("terraces")), ("row_jumps", loaded("row_jumps"))]:
    sub = plane_subtract(frame)
    PLANE["plane_subtract"].append({
        "key": key,
        "corner": _plain(np.asarray(sub)[:3, :3].tolist()),
        "std": _plain(float(np.nanstd(sub))),
        "ptp": _plain(float(np.ptp(sub[np.isfinite(sub)]))),
    })


# ──────────────────────────────────────────────────────────────────────────
# 4. 圆度一族
# ──────────────────────────────────────────────────────────────────────────


def _disk(n: int, r: float, ox: float = 0.0, oy: float = 0.0) -> np.ndarray:
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    c = (n - 1) / 2.0
    return np.hypot(xx - c - ox, yy - c - oy) <= r


def _ellipse(n: int, a: float, b: float) -> np.ndarray:
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    c = (n - 1) / 2.0
    return ((xx - c) / a) ** 2 + ((yy - c) / b) ** 2 <= 1.0


ROUNDNESS: "dict[str, Any]" = {
    "axis_ratio_from_dispersion": [],
    "dispersion_floor": [],
    "dispersion_of_mask": [],
    "assess_mask": [],
    "weighted_axis_ratio": [],
    "background_level": [],
}
for d in [0.0, 0.005, 0.018, 0.037, 0.057, 0.079, 0.102, 0.126, 0.247, 0.5, 1.0, 5.0]:
    ROUNDNESS["axis_ratio_from_dispersion"].append(
        {"d": d, "q": _plain(float(axis_ratio_from_dispersion(d)))})
ROUNDNESS["axis_ratio_from_dispersion"].append(
    {"d": "NaN", "q": _plain(float(axis_ratio_from_dispersion(float("nan"))))})

for a in [0, 1, 12, 20, 40, 60, 100, 200, 400, 900, 2000]:
    ROUNDNESS["dispersion_floor"].append({"area_px": a, "value": _plain(float(dispersion_floor(a)))})

_mask_cases = {
    "disk_r5": _disk(21, 5.0),
    "disk_r8_offset": _disk(27, 8.0, 0.5, 0.25),
    "ellipse_8x5": _ellipse(25, 8.0, 5.0),
    "square_9": np.pad(np.ones((9, 9), bool), 4),
    "tiny_12px": _disk(9, 2.0),
    "line_1x12": np.pad(np.ones((1, 12), bool), 3),
    "empty": np.zeros((9, 9), bool),
}
for key, m in _mask_cases.items():
    d = dispersion_of_mask(m)
    r = assess_mask(m)
    ROUNDNESS["dispersion_of_mask"].append({
        "key": key, "mask": _plain(m.astype(int).tolist()),
        "value": _plain(None if d is None else float(d)),
    })
    ROUNDNESS["assess_mask"].append({"key": key, "as_dict": _plain(r.as_dict()),
                                     "ok": bool(r.ok), "area_px": int(r.area_px)})

_h = loaded("clusters")
_mask_big = _h > (np.median(_h) + 3.0 * 1.4826 * np.median(np.abs(_h - np.median(_h))))
ROUNDNESS["weighted_axis_ratio"].append({
    "key": "clusters_bright",
    "base": _plain(float(background_level(_h))),
    "value": _plain(weighted_axis_ratio(_h, _mask_big, float(background_level(_h)))),
})
ROUNDNESS["weighted_axis_ratio"].append({
    "key": "too_few_px",
    "base": 0.0,
    "value": _plain(weighted_axis_ratio(np.ones((4, 4)), np.ones((4, 4), bool), 0.5)),
})
for key, frame in [("clusters", loaded("clusters")), ("constant", np.full((8, 8), 2.5e-9)),
                   ("tiny", np.ones((3, 3)))]:
    ROUNDNESS["background_level"].append(
        {"key": key, "value": _plain(background_level(frame))})


# ──────────────────────────────────────────────────────────────────────────
# 5. 台阶 / 边 / 逐行跳动 / 坏行
# ──────────────────────────────────────────────────────────────────────────

TOPO: "dict[str, Any]" = {"levels": [], "locate_step_edge": [], "row_jump": [], "bad_rows": []}

for key, frame in [("terraces", loaded("terraces")), ("tilted_only", loaded("tilted"))]:
    fit = fit_plane_robust(frame, sigma=None)
    a, b, c, _inl = fit
    ny, nx = frame.shape
    gy, gx = np.mgrid[:ny, :nx]
    flat_pm = (frame - (a * gx + b * gy + c)) * 1e12
    TOPO["levels"].append({"key": key, "levels": _plain([[float(p), float(q)] for p, q in _levels(flat_pm)])})

for key, frame, kw in [
    ("step_edge", loaded("step_edge"), {}),
    ("tilted_only", loaded("tilted"), {}),
    ("terraces", loaded("terraces"), {}),
    ("too_small", np.zeros((16, 16)), {}),
    ("all_nan", np.full((64, 64), np.nan), {}),
    ("step_edge_tight", loaded("step_edge"), {"max_straightness": 0.0001}),
]:
    res = locate_step_edge(frame, **kw)
    TOPO["locate_step_edge"].append({
        "key": key, "kwargs": _plain(kw),
        "result": _plain({
            "verdict": res.verdict, "x_px": res.x_px, "y_px": res.y_px,
            "angle_deg": res.angle_deg, "angle_scan_deg": res.angle_scan_deg,
            "step_height_m": res.step_height_m, "straightness": res.straightness,
            "n_edge_px": res.n_edge_px, "upper_fraction": res.upper_fraction,
            "reasons": list(res.reasons), "warnings": list(res.warnings),
            "notes": dict(res.notes),
        }),
    })

for key, frame in [("row_jumps", loaded("row_jumps")), ("clusters", loaded("clusters")),
                   ("terraces", loaded("terraces"))]:
    z_pm = np.asarray(plane_subtract(np.asarray(frame, float)), float) * 1e12
    n_big, n_rows = row_big_jumps(z_pm)
    TOPO["row_jump"].append({
        "key": key,
        "mad_pm": _plain(row_jump_mad_pm(z_pm)),
        "sigma_pm": _plain(row_jump_sigma_pm(z_pm)),
        "big_jumps": _plain(n_big), "n_rows": _plain(n_rows),
    })

for key, frame in [("row_jumps", loaded("row_jumps")), ("clusters", loaded("clusters"))]:
    f32 = np.ascontiguousarray(frame, dtype=np.float32)
    TOPO["bad_rows"].append({"key": key, "value": _plain(float(_bad_rows(_plane_detrend(f32))))})


# ──────────────────────────────────────────────────────────────────────────
# 6. 线级判读
# ──────────────────────────────────────────────────────────────────────────

LINES: "dict[str, Any]" = {"line_score": [], "usable_rows": [], "advisory": []}
_lat = frame_lattice()
_NM_PER_PX = 5.0 / 256.0
_noise_row = 1.0e-9 + _hash_noise(1, 256, 2e-12, 31.0)[0]
for key, line, nm in [
    ("lattice_row0", _lat[0], _NM_PER_PX),
    ("lattice_row17", _lat[17], _NM_PER_PX),
    # 宽带、无主频 —— 峰位由**真实结构**定，两边挑同一格。
    ("noise_row", _noise_row, _NM_PER_PX),
    # ⚠️ **一条完全常数的线**：去趋势残差是纯舍入（1e-25 量级），于是谱的峰位与
    # SNR 是**抽签**。这一格留着，但 TS 那侧只比结构字段（点数 / 带内格数 /
    # 半高宽），**不比 `period_nm` 与 `line_snr`** —— 比它们等于给一个抽签结果盖章。
    ("flat_row", np.full(256, 1e-9), _NM_PER_PX),
    ("too_short", np.arange(16, dtype=float), _NM_PER_PX),
    ("scale_too_coarse", _lat[0], 5.0),
    ("with_nans", np.where(np.arange(256) % 7 == 0, np.nan, _lat[3]), _NM_PER_PX),
]:
    LINES["line_score"].append({
        "key": key, "nm_per_px": nm, "line": _plain(np.asarray(line, float)),
        "result": _plain(line_score(line, nm)),
    })

for key, img in [("lattice", _lat),
                 ("half_zero", np.vstack([_lat[:20], np.zeros((20, _lat.shape[1]))]))]:
    LINES["usable_rows"].append({"key": key, "rows": _plain(usable_rows(img).astype(int).tolist())})

_noise_frame = 1.0e-9 + np.vstack([_hash_noise(1, 256, 2e-12, 31.0 + k)[0] for k in range(8)])
for key, img, nm, kw in [
    ("lattice_default", _lat, _NM_PER_PX, {}),
    ("lattice_snr250", _lat, _NM_PER_PX, {"advisory_snr": 250.0}),
    ("noise_frame", _noise_frame, _NM_PER_PX, {}),
    # 见上面 `flat_row` 那条注释：这一格的两个数是抽签，TS 只比结构字段。
    ("flat_frame", np.full((8, 256), 1e-9), _NM_PER_PX, {}),
    ("no_rows", np.zeros((4, 256)), _NM_PER_PX, {}),
]:
    LINES["advisory"].append({
        "key": key, "nm_per_px": nm, "kwargs": _plain(kw),
        "frame": _plain(np.asarray(img, float)),
        "result": _plain(frame_line_advisory(img, nm, **kw)),
    })


# ──────────────────────────────────────────────────────────────────────────
# 7. 起伏门（零 numpy 的那一件）
# ──────────────────────────────────────────────────────────────────────────


class _V:
    def __init__(self, usable: bool, reason: str, rms: "float | None") -> None:
        self.usable = usable
        self.reason = reason
        self.corrugation_rms_m = rms


CORRUGATION: "list[dict]" = []
for key, verdict, kw in [
    ("frame_unusable", _V(False, "这一帧是死平的（去趋势后起伏为 0）", 0.0),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=100.0)),
    ("no_threshold_no_ref", _V(True, "", 30e-12),
     dict(threshold_pm=None, ref_scan_nm=None, this_scan_nm=100.0)),
    ("threshold_without_ref", _V(True, "", 30e-12),
     dict(threshold_pm=40.0, ref_scan_nm=None, this_scan_nm=100.0)),
    ("this_scan_unknown", _V(True, "", 30e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=None)),
    ("scale_mismatch", _V(True, "", 30e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=50.0)),
    ("ref_without_threshold", _V(True, "", 30e-12),
     dict(threshold_pm=None, ref_scan_nm=100.0, this_scan_nm=100.0)),
    ("low", _V(True, "", 9e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=100.0)),
    ("normal", _V(True, "", 30e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=100.0)),
    ("high", _V(True, "", 55e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=100.0)),
    ("negative_tol", _V(True, "", 30e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=100.0, rel_tol=-0.05)),
    ("tol_zero_exact", _V(True, "", 30e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=100.0, rel_tol=0.0)),
    ("profile_named", _V(True, "", 30e-12),
     dict(threshold_pm=40.0, ref_scan_nm=100.0, this_scan_nm=100.0,
           profile_name="reference-surface-v1", provenance="来历一行")),
]:
    CORRUGATION.append({"key": key,
                        "verdict_in": {"usable": verdict.usable, "reason": verdict.reason,
                                       "corrugation_rms_m": _plain(verdict.corrugation_rms_m)},
                        "kwargs": _plain(kw),
                        "result": _plain(judge_corrugation(verdict, **kw).as_dict())})


# ──────────────────────────────────────────────────────────────────────────
# 8. 技能级：**旧仓真技能** 跑在合成的 `.sxm` 上
# ──────────────────────────────────────────────────────────────────────────

SKILLS: "dict[str, list]" = {}


def run_skill(name: str, skill: Any, cases: "list[tuple[str, dict]]", ctx: Any = None) -> None:
    rows = []
    for key, params in cases:
        try:
            r = skill.execute(ctx, dict(params))
            out = {"success": bool(r.success), "error": r.error, "summary": r.summary,
                   "data": r.data}
        except Exception as exc:  # noqa: BLE001 —— 抛出来本身就是一条判据
            out = {"raised": f"{type(exc).__name__}: {exc}"}
        rows.append({"key": key, "params": _plain(params), "result": _plain(out)})
    SKILLS[name] = rows


run_skill("ExtractClusters", ExtractClusters(), [
    ("default_raw", {"scan_path": PATHS["clusters"]}),
    ("plane_level", {"scan_path": PATHS["clusters"], "level": "plane"}),
    ("polarity_dark", {"scan_path": PATHS["clusters"], "polarity": "dark"}),
    ("min_area_1", {"scan_path": PATHS["clusters"], "min_area_px": 1, "max_clusters": 10000}),
    ("truncated", {"scan_path": PATHS["clusters"], "min_area_px": 1, "max_clusters": 3}),
    ("half_scanned", {"scan_path": PATHS["half"]}),
    ("no_angle_header", {"scan_path": PATHS["clusters_no_angle"]}),
    ("tilt_warn", {"scan_path": PATHS["terraces"], "tilt_warn_ratio": 0.5}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm")}),
    ("err_no_channel", {"scan_path": PATHS["clusters"], "channel": "Current"}),
    ("err_line_level", {"scan_path": PATHS["clusters"], "level": "poly1"}),
    ("err_bad_level", {"scan_path": PATHS["clusters"], "level": "quadratic"}),
    ("err_dead_flat_mad", {"scan_path": PATHS["constant"]}),
    ("dead_flat_tilted", {"scan_path": PATHS["dead_flat"]}),
])

run_skill("AssessClusterRoundness", AssessClusterRoundness(), [
    ("default_sigma", {"scan_path": PATHS["clusters"]}),
    ("physical", {"scan_path": PATHS["clusters"], "threshold_mode": "physical"}),
    ("weighted", {"scan_path": PATHS["clusters"], "shape_mode": "weighted"}),
    ("select_center", {"scan_path": PATHS["clusters"], "select": "center"}),
    ("polarity_dark", {"scan_path": PATHS["clusters"], "polarity": "dark"}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm")}),
    ("err_bad_threshold_mode", {"scan_path": PATHS["clusters"], "threshold_mode": "zzz"}),
    ("err_bad_shape_mode", {"scan_path": PATHS["clusters"], "shape_mode": "zzz"}),
    ("err_retired_param", {"scan_path": PATHS["clusters"], "round_threshold": 0.65}),
    ("err_dead_flat", {"scan_path": PATHS["constant"]}),
    ("dead_flat_tilted", {"scan_path": PATHS["dead_flat"]}),
    ("err_no_pixels", {"scan_path": PATHS["clusters"], "threshold_sigma": 50.0}),
])

run_skill("SelectPokedCluster", SelectPokedCluster(), [
    ("selected", {"scan_path": PATHS["clusters"], "min_aspect": 0.35, "min_area_px": 40,
                  "min_peak_height_m": "150p", "anchor_tolerance_m": "3n",
                  "near_x_m": -1.9e-9, "near_y_m": 1.9e-9}),
    ("too_far", {"scan_path": PATHS["clusters"], "min_aspect": 0.35, "min_area_px": 40,
                 "min_peak_height_m": "150p", "anchor_tolerance_m": "300p"}),
    ("none_pass", {"scan_path": PATHS["clusters"], "min_aspect": 0.99, "min_area_px": 4000,
                   "min_peak_height_m": "5n", "anchor_tolerance_m": "3n"}),
    ("err_missing_thresholds", {"scan_path": PATHS["clusters"]}),
    ("err_si_bare_number", {"scan_path": PATHS["clusters"], "min_aspect": 0.35,
                            "min_area_px": 40, "min_peak_height_m": "150",
                            "anchor_tolerance_m": "3n"}),
    ("err_extract_failed", {"scan_path": missing_path("nope.sxm"), "min_aspect": 0.35,
                            "min_area_px": 40, "min_peak_height_m": "150p",
                            "anchor_tolerance_m": "3n"}),
])

run_skill("VerifyAdatomAt", VerifyAdatomAt(), [
    ("at_target", {"scan_path": PATHS["clusters"], "target_x_m": -1.93e-9,
                   "target_y_m": 1.93e-9, "tolerance_m": 1e-9}),
    ("displaced", {"scan_path": PATHS["clusters"], "target_x_m": -1.0e-9,
                   "target_y_m": 1.0e-9, "tolerance_m": 1e-10}),
    ("outside_frame", {"scan_path": PATHS["clusters"], "target_x_m": 5e-7,
                       "target_y_m": 0.0, "tolerance_m": 1e-9}),
    ("no_tolerance", {"scan_path": PATHS["clusters"], "target_x_m": 0.0, "target_y_m": 0.0}),
    ("min_peak_filter", {"scan_path": PATHS["clusters"], "target_x_m": -1.93e-9,
                         "target_y_m": 1.93e-9, "tolerance_m": 1e-9,
                         "min_peak_height_m": 300e-12}),
    ("expected_count", {"scan_path": PATHS["clusters"], "target_x_m": -1.93e-9,
                        "target_y_m": 1.93e-9, "tolerance_m": 1e-9, "expected_count": 99}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm"), "target_x_m": 0.0,
                          "target_y_m": 0.0, "tolerance_m": 1e-9}),
])

run_skill("MeasureStepHeight", MeasureStepHeight(), [
    ("terraces", {"scan_path": PATHS["terraces"]}),
    # `sigma_pm=60` ⇒ 整条台面在带内、隔壁台面在带外 ⇒ 内点集与抽样序列无关，
    # 这一格是这个技能唯一**逐位**可比的那一格（见 `plane.ts` 的 `RANSAC_REL_TOL`）。
    ("terraces_sigma", {"scan_path": PATHS["terraces"], "sigma_pm": 10.0}),
    ("narrow_gap_window", {"scan_path": PATHS["terraces"], "min_gap_pm": 300.0,
                           "max_gap_pm": 400.0}),
    ("no_levels", {"scan_path": PATHS["dead_flat"]}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm")}),
    ("err_no_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
])

run_skill("AssessFrameTrust", AssessFrameTrust(), [
    ("stable", {"scan_path": PATHS["clusters"]}),
    ("unstable", {"scan_path": PATHS["row_jumps"]}),
    ("terraces", {"scan_path": PATHS["terraces"]}),
    ("backward", {"scan_path": PATHS["clusters"], "direction": "backward"}),
    ("too_few_finite_px", {"scan_path": PATHS["tiny"]}),
    ("err_bad_direction", {"scan_path": PATHS["clusters"], "direction": "sideways"}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm")}),
])

run_skill("LocateStepEdge", LocateStepEdge(), [
    ("step_edge", {"scan_path": PATHS["step_edge"]}),
    ("tilted_no_step", {"scan_path": PATHS["tilted"]}),
    ("clusters_no_step", {"scan_path": PATHS["clusters"]}),
    ("tight_curvature", {"scan_path": PATHS["step_edge"], "max_curvature": 0.0001}),
    ("loose_sigma", {"scan_path": PATHS["step_edge"], "edge_sigma": 2.0}),
    ("backward", {"scan_path": PATHS["step_edge"], "direction": "backward"}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm")}),
    ("err_no_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
])

run_skill("AssessFrameCorrugation", AssessFrameCorrugation(), [
    ("profile_uncalibrated", {"scan_path": PATHS["clusters"]}),
    ("explicit_pair_normal", {"scan_path": PATHS["clusters"], "threshold_pm": 400.0,
                              "ref_scan_nm": 10.0}),
    ("explicit_pair_high", {"scan_path": PATHS["clusters"], "threshold_pm": 5.0,
                            "ref_scan_nm": 10.0}),
    ("half_pair_only", {"scan_path": PATHS["clusters"], "threshold_pm": 40.0}),
    ("scale_mismatch", {"scan_path": PATHS["clusters"], "threshold_pm": 40.0,
                        "ref_scan_nm": 100.0}),
    ("dead_flat_constant", {"scan_path": PATHS["constant"], "threshold_pm": 40.0,
                            "ref_scan_nm": 10.0}),
    ("dead_flat", {"scan_path": PATHS["dead_flat"], "threshold_pm": 40.0,
                   "ref_scan_nm": 10.0}),
    ("unknown_profile", {"scan_path": PATHS["clusters"], "profile": "no-such-profile"}),
    # 下面三格共用那份**标定过的**外部 profile —— 「阈值与视野是一组」这条纪律
    # 只有在 profile 那一对是满的时候才分得开（见 `_CFG` 那一段）。
    ("calibrated_profile", {"scan_path": PATHS["clusters"], "profile": "calibrated-10nm"}),
    ("calibrated_but_explicit_pm_only",
     {"scan_path": PATHS["clusters"], "profile": "calibrated-10nm", "threshold_pm": 400.0}),
    ("calibrated_but_explicit_ref_only",
     {"scan_path": PATHS["clusters"], "profile": "calibrated-10nm", "ref_scan_nm": 10.0}),
    ("rel_tol_zero", {"scan_path": PATHS["clusters"], "threshold_pm": 40.0,
                      "ref_scan_nm": 10.0, "rel_tol": 0.0}),
    ("err_missing_file", {"scan_path": missing_path("nope.sxm")}),
    ("err_no_channel", {"scan_path": PATHS["current_only"], "channel": "Z"}),
])

# `AssessAtomicLines` 不读文件 —— 它是本批唯一一个跟仪器说话的。
_lat_rows = np.asarray(frame_lattice(), dtype=np.float64)
_lat_partial = np.vstack([_lat_rows[:24], np.zeros((8, _lat_rows.shape[1]))])
# ⚠️ 数据那一格必须是 **ndarray**：旧仓 `parse_frame_grab` 靠 `isinstance(el, np.ndarray)`
# 从异构 body 里挑出那张图，一个嵌套 list 它**认不出来**（会退到扁平兜底，而扁平兜底
# 又被 body 里的那个字符串挡住）⇒ 回 `None` ⇒ 技能报「回包读不懂」。
# 本仓 TS 那侧认的是嵌套数组（JS 没有 ndarray），两边各按各的形状收同一份数 ——
# 金样里录的是 `_plain` 之后的嵌套列表，正是 TS 要的那个。
_FRAME_BODY = [4, "Z (m)", int(_lat_partial.shape[0]), int(_lat_partial.shape[1]),
               np.asarray(_lat_partial, dtype=np.float64), 1]
_BUF_OK = [2, [(0,), (30,)], 256, 32]
_NAMES_OK = [31, 31, [["Current (A)"]] + [[f"sig{i}"] for i in range(1, 30)] + [["Z (m)"]]]
_FRAMEGET_OK = [0.0, 0.0, 5e-9, 5e-9, 0.0]

_ATOMIC_STUBS = {
    "ok": {"Scan_BufferGet": _BUF_OK, "Signals_NamesGet": _NAMES_OK,
           "Scan_FrameGet": _FRAMEGET_OK, "Scan_FrameDataGrab": _FRAME_BODY},
    "buffer_error": {"Scan_BufferGet": {"error": "NanonisError: boom"}},
    "buffer_garbage": {"Scan_BufferGet": [2, [], 256, 32]},
    "frameget_error": {"Scan_BufferGet": _BUF_OK, "Signals_NamesGet": _NAMES_OK,
                       "Scan_FrameGet": {"error": "NanonisError: no frame"}},
    "grab_error": {"Scan_BufferGet": _BUF_OK, "Signals_NamesGet": _NAMES_OK,
                   "Scan_FrameGet": _FRAMEGET_OK,
                   "Scan_FrameDataGrab": {"error": "NanonisError: layout mismatch"}},
    "no_z_in_buffer": {"Scan_BufferGet": [1, [(0,)], 256, 32],
                       "Signals_NamesGet": _NAMES_OK, "Scan_FrameGet": _FRAMEGET_OK},
    "flat_frame": {"Scan_BufferGet": _BUF_OK, "Signals_NamesGet": _NAMES_OK,
                   "Scan_FrameGet": _FRAMEGET_OK,
                   "Scan_FrameDataGrab": [4, "Z (m)", 8, 256,
                                          np.full((8, 256), 1e-9), 1]},
}

ATOMIC_LINES: "list[dict]" = []
for key, params, stub in [
    ("ok_default", {}, "ok"),
    ("ok_recent4", {"n_recent_lines": 4}, "ok"),
    ("ok_forced_channel", {"channel_index": 30}, "ok"),
    ("ok_snr_250", {"advisory_snr": 250.0}, "ok"),
    ("err_buffer", {}, "buffer_error"),
    ("err_buffer_garbage", {}, "buffer_garbage"),
    ("err_frameget", {}, "frameget_error"),
    ("err_grab", {}, "grab_error"),
    ("err_no_z", {}, "no_z_in_buffer"),
    ("err_flat_frame", {}, "flat_frame"),
]:
    ctx = _FakeContext(_ATOMIC_STUBS[stub])
    try:
        r = AssessAtomicLines().execute(ctx, dict(params))
        out = {"success": bool(r.success), "error": r.error, "summary": r.summary, "data": r.data}
    except Exception as exc:  # noqa: BLE001
        out = {"raised": f"{type(exc).__name__}: {exc}"}
    ATOMIC_LINES.append({"key": key, "params": _plain(params), "stub": stub,
                         "calls": ctx.calls, "result": _plain(out)})

SKILLS["AssessAtomicLines"] = ATOMIC_LINES
ATOMIC_STUB_TABLE = {k: _plain(v) for k, v in _ATOMIC_STUBS.items()}


# ──────────────────────────────────────────────────────────────────────────
# 9. 设计矩阵的条件数 —— 容差写在它上面，所以它必须**随金样一起录**
# ──────────────────────────────────────────────────────────────────────────


def _plane_cond(ny: int, nx: int) -> float:
    gy, gx = np.mgrid[:ny, :nx]
    A = np.column_stack([gx.ravel().astype(float), gy.ravel().astype(float),
                         np.ones(ny * nx)])
    return float(np.linalg.cond(A))


def _cubic_cond(n: int) -> float:
    x = np.arange(n, dtype=float)
    u = (x - (n - 1) / 2.0) / ((n - 1) / 2.0)
    A = np.column_stack([u ** p for p in range(4)])
    return float(np.linalg.cond(A))


CONDITION = {
    "plane_96x96": _plane_cond(96, 96),
    "plane_128x128": _plane_cond(128, 128),
    "plane_64x64": _plane_cond(64, 64),
    "cubic_256": _cubic_cond(256),
    "cubic_64": _cubic_cond(64),
}


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_analysis.py 生成 —— 旧仓 mast.vision.* 与 "
                 "mast.skills.builtins.* 真跑一遍。帧是合成的（闭式公式，零随机数）；"
                 "技能那一层录的是 .sxm 的**字节**，读法归旧仓。",
        "versions": {"numpy": np.__version__},
        "condition_numbers": _plain(CONDITION),
        "xy_meta": XY_META,
        "frame_validity": VALIDITY,
        "np_median": NP_MEDIAN,
        "plane": PLANE,
        "roundness": ROUNDNESS,
        "topography": TOPO,
        "lines": LINES,
        "corrugation_gate": CORRUGATION,
        "sxm_files": {k: base64.b64encode(v).decode("ascii") for k, v in FILES.items()},
        "atomic_lines_stubs": ATOMIC_STUB_TABLE,
        "skills": SKILLS,
    }
    # 技能金样里那些**临时目录的绝对路径**每跑一次都不一样 —— 抹成一个占位符，
    # 否则「重跑逐字节相同」是假的（同 `skill_traces.json` 的 `<stamp>` 那一条）。
    #
    # ⚠️ 顺带抹掉**操作系统给的那句错**。`[WinError 2] 系统找不到指定的文件。`
    # 带着本机的**语言环境**，而且它在 Node 那边叫 `ENOENT: no such file…` ——
    # 两句都对，都不是判据。判据是它前面那半句（谁在报、报的是哪条路径）。
    # TS 那侧的比对做同一次归一化。
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    # 公开金样的有意隐私例外：旧仓只读，导出后只替换现场身份叙事；数值与结构不动。
    text = text.replace(
        "目前实测的箱子(RAW 口径,n=4 真值 / 405 候选,单次会话,2026-08-10 真机):",
        "参考系统观测到的箱子(RAW 口径,n=4 真值 / 405 候选；尚未在本仓独立验证):",
    )
    text = text.replace(
        "2026-08-10 真机 n=4 真值 / 405 候选,单次会话、同一根针、同一片区域,RAW 口径",
        "参考系统观测：n=4 真值 / 405 候选，RAW 口径；尚未在本仓独立验证",
    )
    text = text.replace(json.dumps(TMP)[1:-1], "<tmp>")
    text = text.replace(TMP.replace("\\", "/"), "<tmp>")
    text = re.sub(r"\[WinError [^\"]*", "<oserror>", text)
    text = re.sub(r"\[Errno [^\"]*", "<oserror>", text)
    # **信封在本仓的 wire 层已经拆掉**（D-SKILL-1）：旧仓这句把整个
    # `(error, raw_bytes, body)` 三元组 `str()` 出来，本仓手上只有 body。
    # 两句都在说「我看到的原始回包长这样」，而「原始回包」在两边不是同一个对象 ——
    # 所以抹掉尾巴，比的是前面那半句（谁在拒、为什么拒）。
    text = re.sub(r"原始回包：[^\"]*", "原始回包：<envelope>", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((text + "\n").encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(doc) - 2} 节 · {kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
