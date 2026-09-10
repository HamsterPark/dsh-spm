"""Nanonis 类型码表的字节金样。

请求侧的字节由**真实客户端** `nanonis_spm`（经 `mast/core/nanonis_patch.py` 打补丁）
产出——就是跟真机说话的那份代码。回复侧的字节由 STM-Bench 的服务端 codec 产出，
期望值再用同一个真实客户端解回来。两侧都不是我手写的镜像。

    python \\
        tools/spec-export/export_wire_types.py

`Nanonis(connection)` 只存引用，传 None 就能离线驱动 handle*/decode*，不碰 socket。
"""

from __future__ import annotations

import base64
import json
import struct
import sys
from pathlib import Path

import os
import tempfile

# ⚠️ **必须在 import mast 之前**：把项目根指到临时目录（PLAN §8.6 的「隔离」）。
# 2026-09-10 踩到过一次——一个「只读」的导出脚本因为 import 拉起了管理员覆写机制，
# 在旧仓里新建了一个目录。红线是「只读旧仓」，不是「不弄坏旧仓」。
os.environ.setdefault('MAST2_PROJECT_ROOT', tempfile.mkdtemp(prefix='mast-spec-export-'))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
STMBENCH_ROOT = Path(r"<STMSIM_ROOT>")  # Historical revision: configure this local source path before use.
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "wire_types.json"

sys.path.insert(0, str(MAST_ROOT))
sys.path.insert(0, str(STMBENCH_ROOT))
from mast.core import nanonis_patch  # noqa: E402,F401  —— import 即打补丁
from nanonis_spm import Nanonis  # noqa: E402
from stmsim.wire import codec  # noqa: E402

client = Nanonis(None)


def b64(b: bytes) -> str:
    return base64.b64encode(bytes(b)).decode("ascii")


def encode_arg(value, fmt: str) -> bytes:
    """逐字复刻 `_patched_send` 的请求成帧分支（nanonis_patch.py:169-195）。

    分支顺序有意义，尤其 `c` 的那一支：**客户端按 Python 类型选编码**，
    str → handleString，list → handleArrayString。格式串本身不说是哪种。
    """
    part = bytearray()
    if "*" in fmt:
        if "c" in fmt:
            if isinstance(value, str):
                return bytes(client.handleString(value, fmt, part))
            return bytes(client.handleArrayString(value, fmt, part))
        if "-" in fmt or "+" in fmt:
            v = [client.correctType(fmt[2], x) for x in value]
            handler = client.handleArrayPrepend if "+" in fmt else client.handleArray
            return bytes(handler(v, fmt, part))
        return bytes(client.handleArray(value, fmt, part))
    if "2" in fmt:
        return bytes(client.handle2DArray(value, fmt, part))
    return struct.pack(">" + fmt, client.correctType(fmt, value))


# ── 用例网格：覆盖 671 个方法里真实出现过的每一种码 ──
REQUEST_CASES = [
    # (标签, 值, fmt)
    ("i", 42, "i"), ("i_neg", -7, "i"), ("I", 4294967295, "I"),
    ("H", 65535, "H"), ("h", -32768, "h"),
    ("f", 1.5, "f"), ("f_tiny", 3e-12, "f"), ("d", 1.5, "d"),
    ("b", 1, "b"),
    ("star_f", [1.0, 2.0, 3.0], "*f"),
    ("star_i", [1, 2], "*i"),
    ("star_I", [7], "*I"),
    ("plus_star_i", [1, 2, 3], "+*i"),
    ("plus_star_b", [1, 0], "+*b"),
    ("two_f", [[1.0, 2.0], [3.0, 4.0]], "2f"),
    # `c` 的二义：同一个 fmt，str 与 list 产出**完全不同**的字节
    ("plus_star_c_str", "hello", "+*c"),
    ("plus_star_c_list", ["a", "bb"], "+*c"),
    ("star_plus_c_str", "hi", "*+c"),
    ("star_plus_c_list", ["x", "yz"], "*+c"),
    ("empty_str", "", "+*c"),
    ("empty_list", [], "*f"),
]

# 计数/字节数字段一律传 None 交给 `fill_counts` 算——它就是为此存在的
# （"handlers may pass None for the int fields that only exist to size a following
# array/string; this fills them so module code never hand-computes byte totals"）。
# 手填的话会填错：`*+c` 的前置字段是**总字节数含 4 字节长度前缀**，不是元素个数，
# 而客户端解码时按那个字段前进——填错就是流失步。第一版我正是手填了个 7。
REPLY_CASES = [
    ("scalars", [1, 1.5, 65535, 2.5], ["i", "f", "H", "d"]),
    ("star_f", [None, [1.0, 2.0, 3.0]], ["i", "*f"]),
    ("star_i", [None, [10, 20]], ["i", "*i"]),
    ("star_d", [None, [1.5, 2.5]], ["i", "*d"]),
    ("starstar_f", [None, [1.0, 2.0]], ["i", "**f"]),
    ("starstar_I", [None, [1, 2]], ["i", "**I"]),
    ("two_f", [None, None, [[1.0, 2.0], [3.0, 4.0]]], ["i", "i", "2f"]),
    ("star_minus_c", [None, "hello"], ["i", "*-c"]),
    ("star_plus_c", [None, None, ["ab", "cd"]], ["i", "i", "*+c"]),
    ("starstar_c", [None, ["ab", "cd"]], ["i", "**c"]),
    ("plus_star_c", ["solo"], ["+*c"]),
    ("plus_star_i", [[1, 2, 3]], ["+*i"]),
    ("star_plus_d", [None, [1.5, 2.5]], ["i", "*+d"]),
    ("empty_star", [None, []], ["i", "*f"]),
    ("star_2c", [None, None, [["a", "b"], ["c", "d"]]], ["i", "i", "*2c"]),
]


def main() -> int:
    out: dict[str, object] = {
        "_note": "请求侧字节 = 真实 nanonis_spm 客户端（MAST 打过补丁）；回复侧 = STM-Bench 服务端 codec。base64。不要手改。",
        "elem_stride_reply_note": "*X/-*X 走 decodeArrayPrepended：步长 8(d) / 否则 4——即使 H/h 只有 2 字节。",
    }

    requests = {}
    for label, value, fmt in REQUEST_CASES:
        try:
            requests[label] = {"fmt": fmt, "value": value, "bytes": b64(encode_arg(value, fmt))}
        except Exception as e:  # noqa: BLE001
            requests[label] = {"fmt": fmt, "value": value, "error": f"{type(e).__name__}: {e}"}
    out["encode_arg"] = requests

    replies = {}
    for label, values, fmts in REPLY_CASES:
        try:
            body = codec.encode_returns(codec.fill_counts(values, fmts), fmts)
            replies[label] = {"fmts": fmts, "values": codec.fill_counts(values, fmts), "body": b64(body)}
        except Exception as e:  # noqa: BLE001
            replies[label] = {"fmts": fmts, "values": values, "error": f"{type(e).__name__}: {e}"}
    out["encode_returns"] = replies

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"[ok]   wire_types.json: {len(requests)} 请求 + {len(replies)} 回复")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
