"""Nanonis 字符串回复的解码金样：同一串字节，参考客户端怎么解。

回复字节是按线协议布局手工拼的（4 字节长度前缀 + 内容，不经任何编码器），期望值由**真实客户端**
`nanonis_spm`（经 `mast/core/nanonis_patch.py` 打补丁）的 `parseGeneralResponse` 解出来——就是跟真机
说话的那份代码，不是我手写的镜像。

为什么与 `export_wire_types.py` 分开：那份的回复用例全是 ASCII，两种解法给同一个答案，分不出
`*-c` / `*+c` / `**c`（参考客户端逐字节读）与 `+*c` / `*2c`（UTF-8）；这里的用例专门填非 ASCII 的
字节——UTF-8 的中文、GBK 的中文、256 个字节值的全表、一段两种编码都不合法的字节。另外，那份要
STM-Bench 的服务端 codec 才跑得起来，而参考客户端的解码用不着它，所以这份只需要 MAST。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_wire_decode.py

产物里的字符串可能含裸 C1 控制字符（U+0080–U+009F）：逐字节读出来的串就是这样，不是损坏。
"""

from __future__ import annotations

import base64
import json
import struct
import sys
from pathlib import Path

from _paths import isolated_project_root, require_mast_root

import tempfile

# ⚠️ **必须在 import mast 之前**：把项目根指到临时目录（PLAN §8.6 的「隔离」）。
# 2026-09-10 踩到过一次——一个「只读」的导出脚本因为 import 拉起了管理员覆写机制，
# 在旧仓里新建了一个目录。红线是「只读旧仓」，不是「不弄坏旧仓」。
isolated_project_root(tempfile.mkdtemp(prefix='mast-spec-export-'))

MAST_ROOT = require_mast_root()
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "wire_decode.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import nanonis_patch  # noqa: E402,F401  —— import 即打补丁
from nanonis_spm import Nanonis  # noqa: E402

client = Nanonis(None)  # 只存引用，传 None 就能离线驱动 decode*，不碰 socket

#: 回包末尾的「没有错误」错误段：status = 0（4 字节）+ 描述长度 = 0（4 字节）。
CLEAN_ERROR_SECTION = bytes(8)

#: 一个字符串字段的内容。标签进用例名；字节原样进回包。
PAYLOADS: dict[str, bytes] = {
    "ascii": b"hello",
    "empty": b"",
    "utf8_cjk": "数据".encode("utf-8"),
    "gbk_cjk": "数据".encode("gbk"),
    "all_bytes": bytes(range(256)),
    "invalid": bytes([0x41, 0xFF, 0xFE, 0x80]),
}

#: 每个用例带的第二个字符串，让「计数按字节推进」这件事进到用例里：前一个字符串读错了，后一个就错位。
TAIL = b"ab"


def i32(n: int) -> bytes:
    return struct.pack(">i", n)


def item(content: bytes) -> bytes:
    """一个带 4 字节长度前缀的字符串。"""
    return i32(len(content)) + content


def b64(b: bytes) -> str:
    return base64.b64encode(bytes(b)).decode("ascii")


def cases() -> list[tuple[str, list[str], bytes]]:
    """(标签, ResponseTypes, body)。body 是不含错误段的那一截。"""
    out: list[tuple[str, list[str], bytes]] = []
    for label, p in PAYLOADS.items():
        # `*-c`：前一个 int 是字节数
        out.append((f"star_minus_c_{label}", ["i", "*-c"], i32(len(p)) + p))
        # `*+c`：第一个 int 是总字节数（含每串 4 字节前缀），第二个是个数
        out.append((
            f"star_plus_c_{label}",
            ["i", "i", "*+c"],
            i32(len(item(p)) + len(item(TAIL))) + i32(2) + item(p) + item(TAIL),
        ))
        # `**c`：个数取自第一个字段
        out.append((f"starstar_c_{label}", ["i", "**c"], i32(2) + item(p) + item(TAIL)))
        # `+*c`：自带长度前缀
        out.append((f"plus_star_c_{label}", ["+*c"], item(p)))
        # `*2c`：行数、列数在前
        out.append((f"star_2c_{label}", ["i", "i", "*2c"], i32(1) + i32(2) + item(p) + item(TAIL)))
    return out


def main() -> int:
    replies: dict[str, object] = {}
    for label, fmts, body in cases():
        error, _response, values = client.parseGeneralResponse(body + CLEAN_ERROR_SECTION, fmts)
        if error:
            # 拼错了回包就该当场炸，不能把错误文案录成「期望值」
            raise SystemExit(f"{label}: 参考客户端报错：{error!r}")
        replies[label] = {"body": b64(body), "fmts": fmts, "reference": values}

    out = {
        "_note": "回复字节按线协议布局手工拼，期望值 = 真实 nanonis_spm 客户端（MAST 打过补丁）的 parseGeneralResponse。"
        "字符串可能含裸 C1 控制字符。base64。不要手改。",
        "decode_reference": replies,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"[ok]   wire_decode.json: {len(replies)} 回复")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
