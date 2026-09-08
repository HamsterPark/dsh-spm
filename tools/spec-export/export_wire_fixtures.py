"""把 Nanonis 线协议的**帧层**行为录成字节金样。

字节由 STM-Bench 的真实实现产出（`stmsim/wire/codec.py`），不是手造的——手造的
金样只能证明「我以为帧长这样」。TS 侧 `nanonis-wire` 逐例比对。

    python \\
        tools/spec-export/export_wire_fixtures.py

STM-Bench 是纯 Python（这一层不用 numpy），借旧仓 venv 跑即可；只读它，不写。
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

STMBENCH_ROOT = Path(r"<STMSIM_ROOT>")  # Historical revision: configure this local source path before use.
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "wire_frames.json"

sys.path.insert(0, str(STMBENCH_ROOT))
from stmsim.wire import codec, errors  # noqa: E402


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def main() -> int:
    out: dict[str, object] = {
        "_note": "字节由 STM-Bench stmsim/wire/codec.py 产出；base64 编码。不要手改。",
        "constants": {
            "HEADER_LEN": codec.HEADER_LEN,
            "NAME_LEN": codec.NAME_LEN,
            "ERROR_HEADER_LEN": codec.ERROR_HEADER_LEN,
        },
    }

    # ── 请求成帧：我们是客户端，这是我们要产出的字节 ──
    requests = {}
    for name, body, send_back in [
        ("Bias.Get", b"", True),
        ("Bias.Set", b"\x3f\x80\x00\x00", True),          # float32 1.0
        ("Scan.Action", b"\x00\x01\x00\x00\x00\x00", False),
        # 32 字节边界：名字正好 32、超过 32、含非 ASCII
        ("A" * 32, b"", True),
        ("A" * 40, b"", True),
        ("Ünicode.Verb", b"", True),
    ]:
        frame = codec.build_request_frame(name, body, send_back)
        requests[f"{name}|{len(body)}|{send_back}"] = {
            "name": name, "body": b64(body), "send_response_back": send_back, "frame": b64(frame),
        }
    out["build_request_frame"] = requests

    # ── 回复解析：我们是客户端，这是我们要读的字节 ──
    replies = {}
    for label, raw_name, body in [
        ("ok_empty", b"Bias.Get".ljust(32, b"\x00"), codec.encode_reply_body([], [])),
        ("ok_float", b"Bias.Get".ljust(32, b"\x00"), codec.encode_reply_body([1.5], ["f"])),
        # 错误型回复：body 只有错误段，长度恒等式 len == 8 + desc_len 成立
        ("err_need_module", b"PLL.Get".ljust(32, b"\x00"),
         codec.encode_error_body(1, errors.ModuleNotRunning("PLL").description)),
        ("err_unknown", b"Nope.Verb".ljust(32, b"\x00"),
         codec.encode_error_body(1, errors.UnknownCommand("Nope.Verb").description)),
        ("err_bad_args", b"Bias.Set".ljust(32, b"\x00"),
         codec.encode_error_body(2, errors.BadArguments("Bias.Set", "expected 1 arg").description)),
        # 状态非零但描述为空：encode_error_body 会补一句默认描述
        ("err_no_desc", b"X".ljust(32, b"\x00"), codec.encode_error_body(7, "")),
    ]:
        frame = codec.build_reply_frame(raw_name, body)
        replies[label] = {
            "raw_name": b64(raw_name), "body": b64(body), "frame": b64(frame),
            "body_len": len(body),
        }
    out["reply_frames"] = replies

    # ── 请求头解析（服务端视角，但客户端要理解同一份布局）──
    headers = {}
    for label, name, body_size, send_back in [
        ("get", "Bias.Get", 0, True), ("set", "Bias.Set", 4, True), ("noreply", "Scan.Action", 6, False),
    ]:
        hdr = codec.build_request_frame(name, b"\x00" * body_size, send_back)[: codec.HEADER_LEN]
        raw, parsed_name, size, back = codec.parse_request_header(hdr)
        headers[label] = {
            "header": b64(hdr), "raw_name": b64(raw),
            "name": parsed_name, "body_size": size, "send_response_back": back,
        }
    out["parse_request_header"] = headers

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    n = len(requests) + len(replies) + len(headers)
    print(f"[ok]   wire_frames.json: {n} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
