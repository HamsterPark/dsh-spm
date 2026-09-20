r"""Nanonis 文件格式（`.sxm` / `.dat` / `.3ds`）的金样 —— **合成字节，旧仓读取器当权威**。

## 这份导出器与别的不一样在哪

别的导出器是「驱动旧仓真实实现，把它的行为录下来」。这一份多一层危险：
**文件是我自己拼的**。如果「拼字节」和「读字节」都出自我对格式的理解，
那两边会一起错，而测试全绿 —— 一个自己给自己出题又自己判卷的闭环。

所以闭环这样搭：

1. 这里**合成**一个文件（按我理解的格式拼字节）；
2. 用**旧仓真实的读取器**（`mast.io.nanonis_files`）去读它；
3. 读出来的东西录进金样，字节本身也录（base64）；
4. TS 侧读同一串字节，与金样逐项比。

⇒ **如果第 2 步读出来的与我拼的意图对不上，那是我拼错了**，去改合成器，
不要去改期望值。这一步把「格式理解错了」与「读取器写错了」分开 ——
而前者正是本仓无法靠自己发现的那一类。

**真机文件一个字节都不进本仓**（用户 2026-09-16 明确同意只用合成数据）：
研究快照不进 git 历史，而这个仓将来要公开。合成数据的代价是覆盖面由我决定，
所以「覆盖了哪些形状、没覆盖哪些」写在 `docs/handoff/nanonis-files.md` 里，
是一份可以被反驳的清单，不是一句「测过了」。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_nanonis_files.py
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-nf-"))

MAST_ROOT = require_mast_root()
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "nanonis_files.json"

sys.path.insert(0, str(MAST_ROOT))

import numpy as np  # noqa: E402
import mast.io.nanonis_files as nf  # noqa: E402


def _plain(v: Any) -> Any:
    """JSON 友好。**NaN 走字符串占位** —— 金样用 `allow_nan=False` 写，
    因为 `NaN` 不是合法 JSON，而两边对它的读法必须是同一种。"""
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, np.ndarray):
        return _plain(v.tolist())
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return "NaN" if f != f else ("Infinity" if f == float("inf")
                                     else "-Infinity" if f == float("-inf") else f)
    if isinstance(v, (np.integer, int)) and not isinstance(v, bool):
        return int(v)
    if v is None or isinstance(v, (bool, str)):
        return v
    return str(v)


# ──────────────────────────────────────────────────────────────────────────
# 合成器：按格式拼字节
# ──────────────────────────────────────────────────────────────────────────

#: 帧的像素值由一个**可复现**的公式生成 —— 固定不变、没有随机数，
#: 于是「重跑逐字节相同」不依赖任何种子状态。每个像素都不一样，
#: 好让「行列搞反了」「正反扫拿错了」这类错在数值上立刻看得出来。
def _frame(nx: int, ny: int, base: float) -> np.ndarray:
    return np.array(
        [[base + iy * 0.25 + ix * 0.0625 for ix in range(nx)] for iy in range(ny)],
        dtype=">f4",
    )


def sxm_bytes(
    *,
    nx: int,
    ny: int,
    channels: "list[tuple[str, str]]",      # (名字, 方向) —— 方向是 both/fwd/bwd
    scan_dir: str = "down",
    scan_range: str = "           1.000000E-8           7.500000E-9",
    extra_header: "list[tuple[str, str]]" = (),
    marker: bytes = b"\\1A\\04",
    truncate_bytes: int = 0,
    comment_raw: bytes | None = None,
) -> bytes:
    """拼一个 `.sxm`。头是文本，数据是**大端 float32**，中间隔一个结束记号。"""
    lines: "list[str]" = [
        ":NANONIS_VERSION:", "2",
        ":SCANIT_TYPE:", "              FLOAT            MSBFIRST",
        ":REC_DATE:", " 15.09.2026",
        ":REC_TIME:", "12:34:56",
        ":BIAS:", "\t-1.0000E+0",
        ":Z-CONTROLLER>Setpoint:", "\t100.0E-12",
        ":SCAN_PIXELS:", f"        {nx}         {ny}",
        ":SCAN_RANGE:", scan_range,
        ":SCAN_OFFSET:", "         0.0E+0         0.0E+0",
        ":SCAN_DIR:", scan_dir,
    ]
    for k, v in extra_header:
        lines += [f":{k}:", v]
    lines += [":DATA_INFO:", "\tChannel\tName\tUnit\tDirection\tCalibration\tOffset"]
    for i, (name, direction) in enumerate(channels):
        lines.append(f"\t{i}\t{name}\tm\t{direction}\t9.000E-9\t0.000E+0")
    lines += [":SCANIT_END:", ""]

    head = "\n".join(lines).encode("utf-8")
    if comment_raw is not None:
        # 注释段的字节**原样塞进去**（用来验非 UTF-8 的那一格）
        head = head.replace(b":SCANIT_END:", b":COMMENT:\n" + comment_raw + b"\n:SCANIT_END:")

    blob = b""
    for i, (_name, direction) in enumerate(channels):
        n_frames = 1 if direction in ("fwd", "bwd") else 2
        for d in range(n_frames):
            blob += _frame(nx, ny, base=1.0 + i * 10.0 + d * 100.0).tobytes()
    if truncate_bytes:
        blob = blob[:-truncate_bytes]
    return head + marker + blob


def dat_bytes(header_rows: "list[tuple[str, str]]", col_names: "list[str]",
              rows: "list[list[float]]", *, with_data_marker: bool = True) -> bytes:
    out: "list[str]" = [f"{k}\t{v}" if v else k for k, v in header_rows]
    if with_data_marker:
        out.append("[DATA]")
        out.append("\t".join(col_names))
        for r in rows:
            out.append("\t".join(repr(x) for x in r))
    return ("\r\n".join(out) + "\r\n").encode("utf-8")


def threeds_bytes(*, nx: int, ny: int, n_points: int, channels: "list[str]",
                  fixed: "list[str]", truncate_pixels: int = 0,
                  marker: bytes = b"\r\n:HEADER_END:\r\n",
                  grid_dim: str | None = None) -> bytes:
    n_params = len(fixed)
    head_lines = [
        f'Grid dim="{grid_dim if grid_dim is not None else f"{nx} x {ny}"}"',
        'Grid settings=0.0;0.0;1.0E-8;1.0E-8;0.0',
        f'Fixed parameters="{";".join(fixed)}"',
        'Experiment parameters="X (m);Y (m)"',
        f'# Parameters (4 byte)={n_params}',
        'Experiment size (bytes)=0',
        f'Points={n_points}',
        f'Channels="{";".join(channels)}"',
        'Experiment="Grid Spectroscopy"',
        'Start time="15.09.2026 12:34:56"',
    ]
    head = "\r\n".join(head_lines).encode("utf-8")

    blob = b""
    total = nx * ny - truncate_pixels
    for p in range(nx * ny):
        if p >= total:
            break
        vals = []
        for j, name in enumerate(fixed):
            # Sweep Start / End 让扫描轴可复现地重建出来
            vals.append(-0.5 if name == "Sweep Start" else 0.5 if name == "Sweep End"
                        else float(p) + j * 0.125)
        for c in range(len(channels)):
            for k in range(n_points):
                vals.append(1.0 + c * 10.0 + p * 0.5 + k * 0.03125)
        blob += struct.pack(f">{len(vals)}f", *vals)
    return head + marker + blob


# ──────────────────────────────────────────────────────────────────────────
# 跑：合成 → 旧仓读 → 录
# ──────────────────────────────────────────────────────────────────────────

TMP = Path(tempfile.mkdtemp(prefix="mast-nf-cases-"))
SXM: "dict[str, Any]" = {}
DAT: "dict[str, Any]" = {}
TDS: "dict[str, Any]" = {}


def _raised(exc: Exception, p: Path) -> str:
    """`"<异常类名>: <消息>"`，但消息里的**绝对路径换成裸文件名**。

    旧仓的异常消息里带着它读的那个路径，而这里的路径是一个每次都不一样的
    临时目录（`mast-nf-cases-<随机八位>`）。原样录进去，金样就**重跑一次一个
    md5** —— 于是「旧仓变了没有」这个问题再也没法用 `git diff` 回答，而那正是
    金样存在的理由。路径本身不是判据，**路径之前的那句话才是**。
    """
    return f"{type(exc).__name__}: {exc}".replace(str(p), p.name)


def _record(bucket: dict, key: str, raw: bytes, suffix: str, reader) -> None:
    """写文件 → 用旧仓读取器读 → 录。读取器**抛异常也是一条判据**。"""
    p = TMP / f"{key}{suffix}"
    p.write_bytes(raw)
    entry: "dict[str, Any]" = {"bytes_b64": base64.b64encode(raw).decode("ascii")}
    try:
        entry["read"] = _plain(reader(str(p)))
    except Exception as exc:  # noqa: BLE001 —— 抛出来本身就是判据
        entry["raised"] = _raised(exc, p)
    bucket[key] = entry


def sxm_case(key: str, raw: bytes, *, oriented_channel: str | None = "Z") -> None:
    p = TMP / f"{key}.sxm"
    p.write_bytes(raw)
    entry: "dict[str, Any]" = {"bytes_b64": base64.b64encode(raw).decode("ascii")}
    try:
        scan = nf.read_sxm(str(p))
        entry["read"] = _plain(scan)
        entry["header_only"] = _plain(nf.read_sxm_header(str(p)))
        entry["frame_meta"] = _plain(nf.sxm_frame_meta(scan["header"]))
        if oriented_channel is not None:
            entry["oriented"] = _plain(nf.sxm_oriented_frames(scan, oriented_channel))
    except Exception as exc:  # noqa: BLE001
        entry["raised"] = _raised(exc, p)
    SXM[key] = entry


# ── .sxm ───────────────────────────────────────────────────────────────────

sxm_case("basic", sxm_bytes(nx=4, ny=3, channels=[("Z", "both")]))

# **2026-07-03 复盘那一格**：单方向通道只存一帧。旧读取器一律读两帧，
# 于是字节偏移错位，**后面每一个通道的数据都被移位** —— 这一格是它的钉子。
sxm_case("mixed_directions", sxm_bytes(
    nx=3, ny=2, channels=[("Z", "both"), ("Current", "fwd"), ("Bias", "bwd")]))

# `:SCAN_DIR: up` —— 第一条采集线是帧的**底部**，行 0 要翻到顶
sxm_case("scan_dir_up", sxm_bytes(nx=4, ny=3, channels=[("Z", "both")], scan_dir="up"))

# 方向读不出来 ⇒ **原样不动**（恒等是唯一不声称我们没有的知识的操作）
sxm_case("scan_dir_missing", sxm_bytes(nx=3, ny=2, channels=[("Z", "both")], scan_dir=""))

sxm_case("non_square", sxm_bytes(nx=5, ny=2, channels=[("Z", "both")]))

# 两字节的真结束记号（有些文件写字面量 `\1A\04`，有些写 0x1A 0x04）
sxm_case("raw_marker", sxm_bytes(nx=3, ny=2, channels=[("Z", "both")], marker=b"\x1a\x04"))

# 非 UTF-8 的注释字节（GBK 的「探针」）—— 看旧仓到底怎么处理
sxm_case("gbk_comment", sxm_bytes(
    nx=3, ny=2, channels=[("Z", "both")], comment_raw="探针".encode("gbk")))

# 截断：最后一帧少了一半字节
sxm_case("truncated", sxm_bytes(
    nx=4, ny=3, channels=[("Z", "both")], truncate_bytes=4 * 4 * 3 // 2))

# 整个数据块都没有
sxm_case("no_data", sxm_bytes(nx=4, ny=3, channels=[("Z", "both")], truncate_bytes=4 * 4 * 3 * 2))

# scan_pixels 不是整数 ⇒ 字段不落进 header ⇒ 一个通道都不读
sxm_case("bad_pixels", sxm_bytes(nx=4, ny=3, channels=[("Z", "both")]).replace(
    b"        4         3", b"      128.0       NaN"))

# **负的 scan_pixels** —— 这一格是 `<= 0` 而不是 `== 0` 的理由：
# 负数会被 reshape 当成「这一维你替我算」的通配符，从任意字节里造出一帧
sxm_case("negative_pixels", sxm_bytes(nx=4, ny=3, channels=[("Z", "both")]).replace(
    b"        4         3", b"       -4         3"))

# 找不到结束记号 ⇒ 抛
sxm_case("no_marker", b"".join([b":SCAN_PIXELS:\n  4  3\n:SCANIT_END:\n"]))

sxm_case("two_channels_both", sxm_bytes(
    nx=3, ny=2, channels=[("Z", "both"), ("Current", "both")]), oriented_channel="Current")

# 通道名大小写不一致 —— `sxm_oriented_frames` 有一次不分大小写的补救
sxm_case("lowercase_channel", sxm_bytes(nx=3, ny=2, channels=[("z", "both")]))

# 只有 bwd 的通道：去镜像之后它**就是**这个通道仅有的一帧，当 forward 交出去
sxm_case("bwd_only", sxm_bytes(nx=3, ny=2, channels=[("Z", "bwd")]))


# ── .dat ───────────────────────────────────────────────────────────────────

_dat_header = [("Experiment", "bias spectroscopy"), ("Date", "15.09.2026 12:34:56"),
               ("User", ""), ("Bias>Bias (V)", "-1E+0")]
_dat_cols = ["Bias calc (V)", "Current (A)", "LIX 1 omega (A)"]

_record(DAT, "basic", dat_bytes(_dat_header, _dat_cols, [
    [-1.0, 1.5e-12, 0.25], [-0.5, 2.5e-12, 0.5], [0.0, 3.5e-12, 0.75],
]), ".dat", nf.read_dat)

# 参差的行：**按众数宽度**补 NaN / 截断 —— 一行坏行不该让整份数据没了
_record(DAT, "ragged", dat_bytes(_dat_header, _dat_cols, [
    [-1.0, 1.5e-12, 0.25], [-0.5, 2.5e-12], [0.0, 3.5e-12, 0.75, 9.0],
]), ".dat", nf.read_dat)

# 列名比数据列少 ⇒ 多出来的补 `column_{j}`，不丢数据
_record(DAT, "short_column_header", dat_bytes(
    _dat_header, ["Bias calc (V)"], [[-1.0, 1.5e-12], [0.0, 2.5e-12]]), ".dat", nf.read_dat)

# 没有 [DATA] 记号 ⇒ 只有头，没有列
_record(DAT, "no_data_marker", dat_bytes(
    _dat_header, _dat_cols, [], with_data_marker=False), ".dat", nf.read_dat)

# 中间夹一行解析不了的 ⇒ 跳过那一行，别的照读
_record(DAT, "junk_row", (
    dat_bytes(_dat_header, _dat_cols, [[-1.0, 1.5e-12, 0.25]]).decode()
    + "not\ta\tnumber\r\n" + "0.0\t3.5e-12\t0.75\r\n").encode("utf-8"),
    ".dat", nf.read_dat)


# ── .3ds ───────────────────────────────────────────────────────────────────

_record(TDS, "basic", threeds_bytes(
    nx=2, ny=2, n_points=3, channels=["Current (A)", "LIX (A)"],
    fixed=["Sweep Start", "Sweep End"]), ".3ds", nf.read_3ds)

# 头声明的像素比二进制块能兑现的多 ⇒ **尾部零填充**，形状契约不变
_record(TDS, "truncated_blob", threeds_bytes(
    nx=2, ny=2, n_points=3, channels=["Current (A)"],
    fixed=["Sweep Start", "Sweep End"], truncate_pixels=2), ".3ds", nf.read_3ds)

# 裸 `:HEADER_END:`（没有 CRLF 包着）
_record(TDS, "bare_marker", threeds_bytes(
    nx=2, ny=1, n_points=2, channels=["Current (A)"],
    fixed=["Sweep Start", "Sweep End"], marker=b":HEADER_END:"), ".3ds", nf.read_3ds)

# 负的 grid dim ⇒ 不是崩，是「没数据」
_record(TDS, "negative_dims", threeds_bytes(
    nx=2, ny=2, n_points=3, channels=["Current (A)"],
    fixed=["Sweep Start", "Sweep End"], grid_dim="-2 x 2"), ".3ds", nf.read_3ds)

# 没有 Sweep Start/End 这两个固定参数 ⇒ 扫描轴退回 0..1
_record(TDS, "no_sweep_params", threeds_bytes(
    nx=2, ny=1, n_points=4, channels=["Current (A)"],
    fixed=["X (m)", "Y (m)"]), ".3ds", nf.read_3ds)

_record(TDS, "no_marker", b"Grid dim=\"2 x 2\"\r\nPoints=3\r\n", ".3ds", nf.read_3ds)


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_nanonis_files.py 生成 —— "
                 "字节由本脚本合成，读出来的东西由**旧仓真实读取器** "
                 "mast.io.nanonis_files 给出。真机文件不进本仓。",
        "constants": {
            "max_file_bytes": nf.MAX_FILE_BYTES,
            "max_grid_elements": nf.MAX_GRID_ELEMENTS,
            "channel_unit_hint": dict(nf._CHANNEL_UNIT_HINT),
        },
        "sxm": SXM,
        "dat": DAT,
        "3ds": TDS,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：sxm {len(SXM)} 格 · dat {len(DAT)} 格 · "
          f"3ds {len(TDS)} 格")
    raised = [f"{b}/{k}" for b, d in (("sxm", SXM), ("dat", DAT), ("3ds", TDS))
              for k, v in d.items() if "raised" in v]
    if raised:
        print(f"[note] {len(raised)} 格抛了异常（也是判据）：{', '.join(raised)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
