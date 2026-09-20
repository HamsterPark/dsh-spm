r"""批 7b-1 的金样 —— 旧仓 `AssessAtomicPhase` 对着**合成的 `.sxm` 字节**真跑一遍。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_batch7b1.py

## 为什么要单开一台

判据本体（`mast.vision.atomic_phase.assess_atomic_phase`）已经在
`spec/golden/lattice.json` 的 `atomic_phase` 那一节里录过了，本仓也落了
（`vision/src/atomic-phase.ts`）。**这一份录的是那一层之外的东西** ——
技能壳自己的三道门与四条失败路径：

| 这一份录什么 | 通用驱动器为什么录不到 |
|---|---|
| 覆盖率门 `_MIN_COVERAGE = 0.5`（`tip_spectro_assess.py:385-410`） | `_params_for` 给不出一条真实的 `.sxm` 路径 ⇒ 它只录得到「文件不存在」那一支 |
| `expected_a_nm` 的**三态**（给了正数 / 给 0 / 不给） | 同上 |
| 通道回落（要 `Z` 而文件里没有 ⇒ **取第一个通道**） | 同上 |
| 四条 IO 失败路径的**原话** | 同上 |

## 一条与孪生技能不同、而且**必须录下来**的行为

`AssessAtomicResolution`（批 4b 已落）拿不到指名通道时**报错退出**；
`AssessAtomicPhase` 拿不到时**取文件里的第一个通道接着算**：

```
tip_spectro_assess.py:361   ch = channels.get(channel_name) or next(iter(channels.values()), None)
```

于是「文件里没有可用通道」这句话**只在通道表为空时**说得出来。
两个技能读同一种文件、回答相近的问题，而在这一点上给出完全不同的行为 ——
统一成一种会让金样里有一格对不上，而改掉的正是模型读的那一句。

## 覆盖率门那一格是**边界**，所以录三格

`incomplete = coverage < _MIN_COVERAGE`，**严格小于**。
所以要一格在门下（0.25）、一格**正好在门上**（0.50，不算残帧）、一格满的（1.0）。
只录两侧的话，`<` 改成 `<=` 一格都不会变 —— 那就不是一道闸。

## 两次导出逐字节相同

帧是闭式合成的（sin-hash，零随机数），`.sxm` 字节随金样一起 base64 录下来，
读法归旧仓。无时钟、无网络。临时目录路径在落盘前替换成 `<tmp>`。
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

#: 红线：旧仓只读。真有哪一行要写盘，也只会写进这个空临时目录。
os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="dsh-spm-7b1-root-"))

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "batch7b1.json"
MAST = require_mast_root()
if str(MAST) not in sys.path:
    sys.path.insert(0, str(MAST))

import numpy as np  # noqa: E402

from mast.core.sample_facts import resolve_substrate  # noqa: E402
from mast.skills.builtins.tip_spectro_assess import AssessAtomicPhase  # noqa: E402


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
# 合成帧 —— 闭式，零随机数（与 `export_lattice.py` 同一条 sin-hash）
# ──────────────────────────────────────────────────────────────────────────

#: 帧边长。必须是 2 的幂 —— 本仓的 `fft` 只对 2 的幂走 radix-2，别的长度走
#: Bluestein（三次更长的变换），一格能从 1.4 秒涨到超过 vitest 的缺省超时。
#: 「一个因为超时而没跑完的测试，和一个绿的测试，在汇总行上长得不一样但同样没验到东西。」
PX = 256

#: 六角帧的像素尺度（nm/px）。`< 0.02` ⇒ `scale_gate` 判 `full`。
HEX_NMPP = 5.0 / PX           # = 0.01953125
#: 过渡带（0.02, 0.05] —— `scale_reduced` / `allow_reduced_scale` 那一对。
RED_NMPP = 8.0 / PX           # = 0.03125
#: 粗帧。`> 0.05` ⇒ `scale_gate` 判 `off` ⇒ `reasons=['scale_gate']`（**拒判**，不是「没有」）。
COARSE_NMPP = 20.0 / PX       # = 0.078125


def _hash_noise(ny: int, nx: int, amp: float, salt: float) -> np.ndarray:
    i = np.arange(ny, dtype=np.float64)[:, None]
    j = np.arange(nx, dtype=np.float64)[None, :]
    v = np.sin(i * 12.9898 + j * 78.233 + salt * 37.719) * 43758.5453123
    return amp * (2.0 * (v - np.floor(v)) - 1.0)


def _wave(ny: int, nx: int, nmpp: float, period_nm: float, angle_deg: float,
          amp: float, phase: float = 0.0) -> np.ndarray:
    i = np.arange(ny, dtype=np.float64)[:, None] * float(nmpp)
    j = np.arange(nx, dtype=np.float64)[None, :] * float(nmpp)
    th = math.radians(float(angle_deg))
    return amp * np.cos(
        2.0 * np.pi * (j * math.cos(th) + i * math.sin(th)) / float(period_nm) + phase)


def frame_hex(ny: int = PX, nx: int = PX, nmpp: float = HEX_NMPP,
              d_nm: float = 0.2498, amp: float = 60e-12,
              noise: float = 3e-12) -> np.ndarray:
    """六角晶格，周期 = 原子**行间距**（Au(111) 的 0.2498 nm）。

    幅值比噪声高一个量级 —— 这是判据不是审美：取峰是 `argmax`，
    一个只领先一两个计数的冠军，它的答案由最后一位浮点决定。
    """
    z = (1.0e-9 + 1.2e-12 * np.arange(ny, dtype=np.float64)[:, None]
         + 0.7e-12 * np.arange(nx, dtype=np.float64)[None, :])
    for k in range(3):
        z = z + _wave(ny, nx, nmpp, d_nm, 60.0 * k, amp, 0.3 * k)
    return z + _hash_noise(ny, nx, noise, 11.0)


def frame_noise(ny: int = PX, nx: int = PX) -> np.ndarray:
    """没有任何周期结构 —— 「没有原子相」那一支。"""
    return 1.0e-9 + _hash_noise(ny, nx, 8e-12, 5.0)


def frame_partial(fraction: float, ny: int = PX, nx: int = PX,
                  nmpp: float = HEX_NMPP) -> np.ndarray:
    """只扫了 `fraction` 的帧 —— **没扫到的行是 NaN**。

    ⚠️ 不是 0，是 NaN：覆盖率门数的就是 `np.isfinite(arr).mean()`。
    旧仓观测的残帧案例正是这个形状（2% 的像素有数据，
    而判据照样报 `passed=True`、角向集中度 94）。
    填 0 的话覆盖率恒为 1，这道门**一格输入都没有**。
    """
    z = frame_hex(ny, nx, nmpp)
    keep = int(round(ny * float(fraction)))
    z[keep:, :] = np.nan
    return z


# ──────────────────────────────────────────────────────────────────────────
# `.sxm` 合成器（与 `export_lattice.py` / `export_analysis.py` 同一套字节口径）
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
        # 少了 `:SCAN_RANGE:` 的文件不是坏文件，它只是**没有像素标度**。
        # 这一族把 `None` 原样传给判据环 ⇒ 出局词 `unknown_pixel_size`（机器可判），
        # 而不是一句中文错误串。
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


TMP = tempfile.mkdtemp(prefix="dsh-spm-7b1-sxm-")
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


#: **只存正扫。** `AssessAtomicPhase` 只读 `forward`（拿不到才退 `backward`），
#: 反扫那一块在这一份里一次都不会被读 —— 存进去只会让金样大一倍。
#: （`export_lattice.py` 存两块是因为那一份要验 `combine_up_down`。）
def fwd(a: np.ndarray) -> "list[np.ndarray]":
    return [a]


_HEX = frame_hex()
write_file("hex", sxm_bytes([("Z", "forward", fwd(_HEX))],
                            nx=PX, ny=PX, width_m=5e-9))
write_file("hex_no_scale", sxm_bytes([("Z", "forward", fwd(_HEX))],
                                     nx=PX, ny=PX, width_m=5e-9, with_range=False))
write_file("noise", sxm_bytes([("Z", "forward", fwd(frame_noise()))],
                              nx=PX, ny=PX, width_m=5e-9))
write_file("coarse", sxm_bytes([("Z", "forward", fwd(frame_hex(nmpp=COARSE_NMPP)))],
                               nx=PX, ny=PX, width_m=20e-9))
write_file("reduced", sxm_bytes([("Z", "forward", fwd(frame_hex(nmpp=RED_NMPP)))],
                                nx=PX, ny=PX, width_m=8e-9))
# 覆盖率四格：门下（判据本身也不过）· **门下而判据本身过**（旧仓观测的残帧形状，
# 见 `coverage_below_gate_but_judged` 那一格的 why）· **正好在门上** · 满。
# `incomplete = coverage < 0.5` 是严格小于，所以 0.50 那一格必须**不算**残帧 ——
# 没有它，`<` 与 `<=` 给出同一个答案。
write_file("partial_25", sxm_bytes([("Z", "forward", fwd(frame_partial(0.25)))],
                                   nx=PX, ny=PX, width_m=5e-9))
write_file("partial_44", sxm_bytes([("Z", "forward", fwd(frame_partial(0.4375)))],
                                   nx=PX, ny=PX, width_m=5e-9))
write_file("partial_50", sxm_bytes([("Z", "forward", fwd(frame_partial(0.50)))],
                                   nx=PX, ny=PX, width_m=5e-9))
# 只有 Current 通道 —— 要 `Z` 拿不到时**回落到第一个通道**（与孪生技能不同）。
write_file("current_only", sxm_bytes([("Current", "forward", fwd(_HEX * 1e-1))],
                                     nx=PX, ny=PX, width_m=5e-9))
# 通道表为空 —— 这是「文件里没有可用通道」那句话**唯一**走得到的路。
write_file("no_channels", sxm_bytes([], nx=PX, ny=PX, width_m=5e-9))
# 头读得下去、数据块短了一大截 ⇒ `.sxm 读取失败: …`
_trunc = bytearray(FILES["hex"])
del _trunc[len(_trunc) // 2:]
write_file("truncated", bytes(_trunc))
# 完全不是 .sxm
write_file("garbage", b"this is not a nanonis file\n" * 8)


# ──────────────────────────────────────────────────────────────────────────
# 技能 —— 旧仓那一个真跑
# ──────────────────────────────────────────────────────────────────────────

SKILL = AssessAtomicPhase()
ROWS: "list[dict[str, Any]]" = []


def run(case: str, params: "dict[str, Any]", *, why: str = "") -> None:
    res = SKILL.execute(None, dict(params))
    ROWS.append({
        "case": case, "why": why, "params": _plain(params),
        "success": bool(res.success), "error": res.error or "",
        "summary": res.summary or "", "data": _plain(res.data or {}),
    })


# ── 主路径 ────────────────────────────────────────────────────────────────
run("atomic", {"scan_path": PATHS["hex"], "channel": "Z"},
    why="有原子相：三条判据都过，`passed=True`，summary 报快扫方向周期与角向集中度")
run("no_atomic", {"scan_path": PATHS["noise"], "channel": "Z"},
    why="没有原子相：出局词进 summary")
run("scale_gate", {"scan_path": PATHS["coarse"], "channel": "Z"},
    why="0.078 nm/px 太粗 ⇒ **拒判**（`reasons=['scale_gate']`），"
        "而 summary 明写「这不等于没有原子相」")
run("unknown_pixel_size", {"scan_path": PATHS["hex_no_scale"], "channel": "Z"},
    why="头里没有 `:SCAN_RANGE:` ⇒ `nm_per_px=None` 原样传下去 ⇒ 机器可判的出局词")

# ── 覆盖率门（边界三格） ──────────────────────────────────────────────────
run("coverage_below_gate", {"scan_path": PATHS["partial_25"], "channel": "Z"},
    why="覆盖率 0.25 < 0.5 ⇒ `incomplete_frame=true`；判据本身也没过")
run("coverage_below_gate_but_judged", {"scan_path": PATHS["partial_44"], "channel": "Z"},
    why="**这一格才是那道门存在的理由**：覆盖率 0.4375 < 0.5，而判据本身 `passed=True`。"
        "于是 `passed` 被门压成 False，`passed_before_coverage_gate` 留着原判。"
        "参考系统观测到同类形状（2% 的像素，报 passed=True、角向集中度 94，"
        "完整帧为 4356）；该观测尚未在本仓独立验证。"
        "⚠️ 而 **`summary` 用的是 `res.passed`，不是门后的 `passed`** ——"
        "这一格的 summary 说「有原子相」，而 `data.passed` 是 false。见 deviations")
run("coverage_on_gate", {"scan_path": PATHS["partial_50"], "channel": "Z"},
    why="覆盖率**正好** 0.5 ⇒ **不算**残帧（`<` 是严格小于）。"
        "没有这一格，`<` 与 `<=` 给出同一个答案")
run("coverage_full", {"scan_path": PATHS["hex"], "channel": "Z"},
    why="覆盖率 1.0 —— 门的另一侧")

# ── `expected_a_nm` 的三态 ────────────────────────────────────────────────
run("expected_explicit", {"scan_path": PATHS["hex"], "channel": "Z", "expected_a_nm": 0.2498},
    why="给了正数 ⇒ 用它，并且**照样**去解衬底（`facts` 进 data 的三个 substrate_* 字段）")
run("expected_zero", {"scan_path": PATHS["hex"], "channel": "Z", "expected_a_nm": 0.0},
    why="填 0 ⇒ **关掉这项比对**（`expected_a_nm=None` 传下去），但衬底照样解。"
        "旧仓注释：「0 或推断不出来时只是不做这一项比对，**不算失败**」")
run("expected_zero_with_substrate",
    {"scan_path": PATHS["hex"], "channel": "Z", "expected_a_nm": 0.0, "substrate": "Au(111)"},
    why="**「填 0」与「留空」的分界只有这一格分得开。** 参数说明写的是"
        "「留空则从衬底取；填 0 则关掉这项比较」—— 两句话，而没有衬底时它们"
        "给出同一个答案（都是 None）。这一格同时给 0 **和**一个解得开的衬底："
        "`substrate_available=true`、`row_spacing_nm` 取得到，而 `expected_a_nm` "
        "必须仍然是 null。少了它，把「填 0」读成「从衬底取」的那个自然误读"
        "一格都验不到")
run("expected_omitted", {"scan_path": PATHS["hex"], "channel": "Z"},
    why="不给 ⇒ 走 `_resolve_expected(..., want='lattice')` 从衬底取")
run("expected_from_substrate", {"scan_path": PATHS["hex"], "channel": "Z",
                                "substrate": "Au(111)"},
    why="指名衬底 ⇒ 知识库取行间距。**这一格是本仓那个注入口的规格**")
run("expected_mismatch", {"scan_path": PATHS["hex"], "channel": "Z", "expected_a_nm": 0.4},
    why="期望值给错 ⇒ 周期比对那一条不过，而其余三条照过")

# ── 三个阈值旋钮各一格（在门上 / 在门下要分得开） ─────────────────────────
run("concentration_min_high", {"scan_path": PATHS["hex"], "channel": "Z",
                               "concentration_min": 1e9},
    why="角向集中度那道闸单独被顶到不可能 ⇒ 只有它出局")
run("snr_min_high", {"scan_path": PATHS["hex"], "channel": "Z", "snr_min": 1e6},
    why="信噪那道闸单独出局")
run("sharpness_min_high", {"scan_path": PATHS["hex"], "channel": "Z", "sharpness_min": 1e6},
    why="锐度那道闸单独出局")

# ── 过渡带（0.02, 0.05] —— 那个逃生门的两侧 ───────────────────────────────
run("reduced_scale_default", {"scan_path": PATHS["reduced"], "channel": "Z"},
    why="0.031 nm/px 在过渡带里，默认**不接受**肯定结论")
run("reduced_scale_allowed", {"scan_path": PATHS["reduced"], "channel": "Z",
                              "allow_reduced_scale": True},
    why="同一帧、开了逃生门 ⇒ 结论变了，而警告跟着结果一起给出")

# ── 通道 ──────────────────────────────────────────────────────────────────
run("channel_fallback", {"scan_path": PATHS["current_only"], "channel": "Z"},
    why="要 `Z` 而文件里只有 `Current` ⇒ **回落到第一个通道**接着算。"
        "孪生技能 `AssessAtomicResolution` 在这里是报错退出 —— 两者刻意不同")
run("channel_named", {"scan_path": PATHS["current_only"], "channel": "Current"},
    why="指名那个真有的通道 —— 上一格的对照：回落与指名给出同一个结果")

# ── 四条失败路径的**原话** ────────────────────────────────────────────────
run("missing_file", {"scan_path": missing_path("nope"), "channel": "Z"},
    why="`Path(path).exists()` 为假")
run("empty_path", {"scan_path": "", "channel": "Z"},
    why="⚠️ 空串**不走**「文件不存在」那一支：`Path('')` 等价于 `Path('.')`，"
        "而当前目录是存在的 ⇒ 掉进 `read_sxm` 的 OSError ⇒ 「.sxm 读取失败」。"
        "这是实测出来的，不是读代码读出来的 —— 而模型读的正是这一句")
run("no_channels", {"scan_path": PATHS["no_channels"], "channel": "Z"},
    why="通道表为空 —— 「文件里没有可用通道」**唯一**走得到的路"
        "（指名通道拿不到时是回落，不是报错，见 `channel_fallback`）")
run("truncated", {"scan_path": PATHS["truncated"], "channel": "Z"},
    why="头读得下去、数据块短了一截 ⇒ 通道在、方向块不在 ⇒ "
        "「通道里没有正扫/反扫数据」。**这一支本来以为不可达**，"
        "实跑出来它可达 —— 四条失败路径于是是五条")
run("garbage", {"scan_path": PATHS["garbage"], "channel": "Z"},
    why="完全不是 .sxm")


# ── 衬底解析：本仓那个注入口默认关着，规格就是这一格 ──────────────────────
# 本仓 `SURFACE_LATTICE_NM` 的**全部七个面**都录 —— 那张表是本仓这一侧唯一的
# 常数来源，而旧仓这一侧的 `nearest_neighbor_nm` 来自知识库的**埃**值除以 10。
# 两条路在 Pt(111) 上差一个 ulp（2.775/10 ≠ 0.2775），所以七个都录，
# 让「哪几个对得上、哪几个差最后一位」是一件量出来的事，不是猜出来的。
SUBSTRATE = [
    {"arg": a, "facts": _plain(resolve_substrate(a))}
    for a in [None, "", "Au(111)", "Ag(111)", "Cu(111)", "Pt(111)", "HOPG",
              "NaCl(100)", "Si(111)-1x1", "不认识这个衬底"]
]


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_batch7b1.py 生成 —— 旧仓 "
                 "`AssessAtomicPhase` 对着合成的 .sxm 字节真跑一遍。"
                 "帧是闭式合成的（sin-hash，零随机数），字节随金样一起录，读法归旧仓。",
        "versions": {"numpy": np.__version__},
        "sxm_files": {k: base64.b64encode(v).decode("ascii") for k, v in FILES.items()},
        "min_coverage": 0.5,
        "assess_atomic_phase": _plain(ROWS),
        "resolve_substrate": _plain(SUBSTRATE),
    }
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    text = text.replace(json.dumps(TMP)[1:-1], "<tmp>")
    text = text.replace(TMP.replace("\\", "/"), "<tmp>")
    text = re.sub(r"\[WinError [^\"]*", "<oserror>", text)
    text = re.sub(r"\[Errno [^\"]*", "<oserror>", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((text + "\n").encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(ROWS)} 格技能 · "
          f"{len(SUBSTRATE)} 格衬底 · {len(FILES)} 个 .sxm · {kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
