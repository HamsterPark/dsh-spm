r"""`QuitNanonis` 与 `WaitForScanEndBlocking` —— 通用驱动器到不了的那几格。

通用驱动器（`export_skill_traces.py`）在这两个技能上都只录得到**一种**结局：

* `QuitNanonis` 每一趟都停在「实时控制器回报 Z 反馈仍然闭合」——合成回包给
  `ZCtrl_OnOffGet` 的是 `[3]`（真值），于是**退出成功那一路一条金样都没有**，
  而那一路恰恰是这个技能全部判据的所在：停扫 → 退针 → **向实时控制器确认** → 退出。
* `WaitForScanEndBlocking` 只录得到「扫描已结束」。**中止**与**等到上限**
  是另外两种结局，而它们各自说的话不一样。

这一份把它们逐格摆出来。与 `export_lockin_presets.py` 同一套办法：
假 context 按动词脚本化，值全由这里写定。

    python \
        tools/spec-export/export_advanced_ops.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

# 等待循环按 1 s 一片切；假钟让它按自己的逻辑走完，不占墙钟。
import time as _time

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


_time.sleep = _fake_sleep          # type: ignore[assignment]
_time.monotonic = _fake_monotonic  # type: ignore[assignment]

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "advanced_ops.json"

sys.path.insert(0, str(MAST_ROOT))

from mast.core.types import NanonisCallRecord  # noqa: E402
import mast.skills.builtins.advanced_ops as ao  # noqa: E402


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, float):
        return "NaN" if v != v else v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "item"):
        return _plain(v.item())
    return str(v)


class _Ctx:
    """按动词脚本化的假 context。

    `z_feedback`：`ZCtrl_OnOffGet` 回的那个数。**0 = 环开着（退针确认）**，
    非 0 = 仍然闭合。这是 `QuitNanonis` 唯一真正的判据。
    """

    def __init__(self, *, z_feedback: "int | None" = 0,
                 fail: "set[str] | None" = None,
                 abort_after: "int | None" = None,
                 timeout_status: int = 0):
        self.z_feedback = z_feedback
        self.fail = fail or set()
        self.abort_after = abort_after
        self.timeout_status = timeout_status
        self.calls: "list[dict]" = []
        self._aborts = 0

    def check_abort(self) -> bool:
        self._aborts += 1
        return self.abort_after is not None and self._aborts > self.abort_after

    def safe_call(self, method_name: str, *args, **kwargs) -> NanonisCallRecord:
        rec = NanonisCallRecord(method=method_name, args=tuple(args), kwargs=dict(kwargs))
        self.calls.append({"verb": method_name, "args": _plain(list(args))})
        if method_name in self.fail:
            rec.error = "模拟故障：连接被对端关闭"
            return rec
        if method_name == "ZCtrl_OnOffGet":
            rec.return_value = (("", b"", []) if self.z_feedback is None
                                else ("", b"", [self.z_feedback]))
        elif method_name == "ZCtrl_SwitchOffDelayGet":
            rec.return_value = ("", b"", [0.1])
        elif method_name == "Scan_WaitEndOfScan":
            # **这一条会阻塞它被要求等的那段时间** —— 假钟也得跟着走。
            # 不拨钟的话，等待循环在假时间里原地打转：10 秒的上限要转一万圈，
            # 录出来是一份 9999 次调用的金样，而真机上那是 10 次。
            # 夹具不模仿这一点，录到的就不是这个技能的形状。
            _CLOCK[0] += max(int(args[0]), 0) / 1000.0
            # (timeout_status, path_size, path) —— 第 0 项 1 = 超时
            rec.return_value = ("", b"", [self.timeout_status, 0, ""])
        else:
            rec.return_value = ("", b"", [])
        return rec


QUIT: "dict[str, Any]" = {}
WAIT: "dict[str, Any]" = {}


def quit_case(key: str, *, params: "dict | None" = None, ctx: _Ctx) -> None:
    r = ao.QuitNanonis().execute(ctx, dict(params or {}))
    QUIT[key] = {
        "params": _plain(params or {}),
        "calls": ctx.calls,
        "success": bool(r.success),
        "error": str(r.error or ""),
        "summary": str(r.summary or ""),
        "data": _plain(r.data or {}),
    }


def wait_case(key: str, *, params: dict, ctx: _Ctx) -> None:
    r = ao.WaitForScanEndBlocking().execute(ctx, dict(params))
    WAIT[key] = {
        "params": _plain(params),
        "calls": ctx.calls,
        "success": bool(r.success),
        "error": str(r.error or ""),
        "summary": str(r.summary or ""),
        "data": _plain(r.data or {}),
    }


# ── QuitNanonis：退出前那三步，每一步各有一种失败 ──────────────────────────
# 退出成功那一路（Z 反馈确认已断开）
quit_case("ok", ctx=_Ctx(z_feedback=0))
quit_case("no_save", params={"save_settings": False}, ctx=_Ctx(z_feedback=0))
# **响应没回来不算失败**：Nanonis 退出时会直接把 socket 拆掉
quit_case("quit_no_response", ctx=_Ctx(z_feedback=0, fail={"Util_Quit"}))
# 停扫失败**不拦着退针** —— 它只是记一条警告
quit_case("scan_stop_failed", ctx=_Ctx(z_feedback=0, fail={"Scan_Action"}))
# 退针失败 ⇒ 拒绝退出。带着进针状态退出，Z 反馈会随进程一起死掉
quit_case("withdraw_failed", ctx=_Ctx(z_feedback=0, fail={"ZCtrl_Withdraw"}))
# 实时控制器说环还闭着 ⇒ 拒绝
quit_case("still_closed", ctx=_Ctx(z_feedback=1))
# **读不出来也拒**：确认不了就是没确认（fail-closed）
quit_case("verify_unreadable", ctx=_Ctx(z_feedback=None))
quit_case("verify_failed", ctx=_Ctx(z_feedback=0, fail={"ZCtrl_OnOffGet"}))

# ── WaitForScanEndBlocking：三种结局 ───────────────────────────────────────
wait_case("finished", params={"timeout_s": 10.0}, ctx=_Ctx(timeout_status=0))
# 等到上限仍未结束 —— **success，但 timed_out=True**
wait_case("timed_out", params={"timeout_s": 10.0}, ctx=_Ctx(timeout_status=1))
# 中止：这个技能只负责等，**不负责停**——报文必须把这句说出来
wait_case("aborted", params={"timeout_s": 10.0},
          ctx=_Ctx(timeout_status=1, abort_after=2))
wait_case("call_failed", params={"timeout_s": 10.0},
          ctx=_Ctx(fail={"Scan_WaitEndOfScan"}))


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_advanced_ops.py 生成——"
                 "驱动旧仓真实的 QuitNanonis / WaitForScanEndBlocking。",
        "constants": {
            "scan_stop_action": ao._SCAN_STOP,
            "slice_s": ao.WaitForScanEndBlocking._SLICE_S,
        },
        "quit": QUIT,
        "wait": WAIT,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(QUIT)} 格退出 · {len(WAIT)} 格等待")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
