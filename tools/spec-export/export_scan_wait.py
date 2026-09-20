r"""把 `WaitScanComplete` **真的等一遍**，连同它依赖的两个回包解析器。

这一份是 GraphExecutor 的验收：它是本仓第一个**流式动态计划**——每一次轮询都是
一个自己的步骤（`poll_<i>`），步数事先不知道，最后加一个 `finalize`。四条恢复守卫
里有两条（`total_steps == 0` 的分母、跑完清断点）就是被这种形状咬出来的。

录三块：

* `parse_buffer_get` / `frame_acquired_lines` / `parse_frame_grab` 的网格
  ——真机的 1-元组通道号 `[(0,), (30,)]`、异构 body、NaN 前沿；
* `WaitScanComplete` 的**结局网格**：`completed` / `stopped_early` /
  `never_started` / `timed_out` / `restarted` / `aborted`，外加延期、
  不可测 fail-open、轮询报错走 optional；
* 每个结局的**动词序列**——尤其那条硬约束：中止与超时都必须先发
  `Scan_Action(1, 0)` 停扫，**再**返回。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_scan_wait.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = require_mast_root()
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "scan_wait.json"

# ── 假钟。`sleep` 把钟往前拨而不是真等，于是超时循环按自己的逻辑走完却不占墙钟。
#    **不能把 sleep 变成 no-op**：那样超时永远到不了，循环变成死循环。──
import time as _time

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


_time.sleep = _fake_sleep              # type: ignore[assignment]
_time.monotonic = _fake_monotonic      # type: ignore[assignment]
_time.perf_counter = _fake_monotonic   # type: ignore[assignment]
_time.time = (lambda: 1_700_000_000.0)  # type: ignore[assignment]

sys.path.insert(0, str(MAST_ROOT))

import numpy as np  # noqa: E402
from mast.core.types import NanonisCallRecord, SkillResult  # noqa: E402
from mast.io.nanonis_files import (  # noqa: E402
    channel_ids_from_buffer,
    frame_acquired_lines,
    parse_buffer_get,
    parse_frame_grab,
)
from mast.skills.composite.graph_executor import _sidecar_dir  # noqa: E402
from mast.skills.builtins.scan_utils import WaitScanComplete  # noqa: E402


def _env(body: Any) -> tuple:
    """三段信封 `(error_string, raw_bytes, body)`。"""
    return ("", b"", body)


def _plain(v: Any) -> Any:
    if isinstance(v, np.ndarray):
        return _plain(v.tolist())
    if isinstance(v, (np.floating, np.integer)):
        return _plain(v.item())
    if isinstance(v, float):
        # NaN / inf 进不了 allow_nan=False 的 JSON，用记号表达
        if v != v:
            return "NaN"
        if v in (float("inf"), float("-inf")):
            return "Infinity" if v > 0 else "-Infinity"
        return v
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    if v is None or isinstance(v, (bool, int, str)):
        return v
    return str(v)


# ─────────────────────────────────────────────────────────────────────────
# ① 回包解析器网格
# ─────────────────────────────────────────────────────────────────────────

NAN = float("nan")


def _frame_body(rows: int, cols: int, acquired: int, *, real_shape: bool = True) -> Any:
    """一帧：前 `acquired` 行有数，其余整行 NaN（Nanonis 就是这么填的）。"""
    arr = np.full((rows, cols), NAN, dtype=np.float64)
    for r in range(min(acquired, rows)):
        arr[r, :] = float(r)
    if real_shape:
        # 真机 body 是**异构**表：[name_len, name, rows, cols, data_2D, dir]
        return [2, "Z", rows, cols, arr, 1]
    return arr


BUFFER_CASES: dict[str, Any] = {
    # 旧仓观测的形状：通道号是 1-元组
    "real_rig_tuples": _env([2, [(0,), (30,)], 256, 256]),
    "bare_ints": _env([2, [0, 14], 512, 512]),
    "single_unwrapped": _env([1, 7, 128, 128]),
    "ndarray_ids": _env([2, np.array([0, 30]), 256, 256]),
    "no_channels": _env([0, [], 256, 256]),
    "garbled_element_skipped": _env([3, [0, "x", 30], 256, 256]),
    "string_ids_refused": _env([1, "abc", 256, 256]),
    "body_too_short": _env([2, [(0,)], 256]),
    "not_an_envelope": [1, 2],
    "body_not_a_sequence": _env(7),
    "lines_wrapped_degrades": _env([2, [(0,)], (256,), (256,)]),
    "none": None,
}

#: ⚠️ 这一格的帧故意**小**（8×6，不是真机的 256²）。
#:
#: 判据是「整行 NaN 的那些行没采到」，而行数只是个**参数**——录一张 256×256 的
#: NaN 帧进金样，是往仓库里塞 65536 个数字来证明一件 48 个数字就能证明的事。
#: 第一版真的这么干了：`scan_wait.json` 出来 **8.4 MB / 39 万行**。
#: 端到端那 17 格照用 256 行的缓冲区（那边不录 body），所以「行数对不上就拒绝判断」
#: 那条仍然是在真机尺寸上验的。
FRAME_CASES: dict[str, Any] = {
    "real_shape_partial": _env(_frame_body(8, 6, 3)),
    "real_shape_full": _env(_frame_body(8, 6, 8)),
    "real_shape_empty": _env(_frame_body(8, 6, 0)),
    "bare_ndarray": _env(_frame_body(4, 4, 3, real_shape=False)),
    "flat_list_square": _env([1.0, 2.0, 3.0, 4.0]),
    "flat_list_not_square": _env([1.0, 2.0, 3.0]),
    "header_dims_reshape": _env([2, "Z", 2, 3, None, 1]),
    "empty_body": _env([]),
    "not_an_envelope": [1, 2],
    "none": None,
}
# `header_dims_reshape` 要一份**扁平**的 6 个数加上 rows/cols 头
FRAME_CASES["header_dims_reshape"] = _env([2, 2, 3, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0])


def _body(parsed: Any) -> Any:
    """本仓这一侧收到的东西 —— 信封在 `nanonis-wire` 那层已经拆掉（D-SKILL-1）。

    **录进金样**而不是让 TS 侧照着 `input` 猜：第一版让 TS 自己判「像不像信封」，
    于是 `not_an_envelope` 这一格两边喂进去的根本不是同一个值，而测试红了之后
    我差点去改那条判据。判据不该建立在一次猜测上。
    """
    if isinstance(parsed, tuple) and len(parsed) == 3:
        return parsed[2]
    return parsed


def _grid() -> dict[str, Any]:
    buf: dict[str, Any] = {}
    for name, parsed in BUFFER_CASES.items():
        body = _body(parsed)
        buf[name] = {
            "input": _plain(parsed),
            "body": _plain(body),
            "parse_buffer_get": _plain(parse_buffer_get(parsed)),
            "channel_ids": _plain(channel_ids_from_buffer(body)),
        }
    frm: dict[str, Any] = {}
    for name, parsed in FRAME_CASES.items():
        got = frame_acquired_lines(parsed)
        arr = parse_frame_grab(parsed, shape_2d=True)
        frm[name] = {
            "input": _plain(parsed),
            "body": _plain(_body(parsed)),
            "frame_acquired_lines": None if got is None else list(got),
            "shape_2d": None if arr is None else list(arr.shape),
        }
    return {"buffer": buf, "frame": frm}


# ─────────────────────────────────────────────────────────────────────────
# ② WaitScanComplete 的结局网格
# ─────────────────────────────────────────────────────────────────────────


class _ScriptCtx:
    """脚本化的 ExecutionContext。每个动词的应答由用例给定。"""

    def __init__(self, *, status: list[int], frames: list[Any] | None = None,
                 buffer: Any = None, aborts: list[bool] | None = None,
                 errors: dict[int, str] | None = None) -> None:
        self._status = list(status)
        self._frames = list(frames or [])
        self._buffer = buffer if buffer is not None else _env([1, [(0,)], 256, 256])
        self._aborts = list(aborts or [])
        self._errors = dict(errors or {})
        self.calls: list[dict[str, Any]] = []
        self.abort_checks = 0

    def safe_call(self, method: str, *args: Any) -> NanonisCallRecord:
        i = len(self.calls)
        rec = NanonisCallRecord(method=method, args=tuple(args), kwargs={})
        err = self._errors.get(i)
        if err is not None:
            rec.error = err
            rec.return_value = None
        elif method == "Scan_StatusGet":
            s = self._status.pop(0) if len(self._status) > 1 else (
                self._status[0] if self._status else 0)
            rec.return_value = _env([s])
        elif method == "Scan_BufferGet":
            if isinstance(self._buffer, str):
                rec.error = self._buffer
                rec.return_value = None
            else:
                rec.return_value = self._buffer
        elif method == "Scan_FrameDataGrab":
            f = self._frames.pop(0) if len(self._frames) > 1 else (
                self._frames[0] if self._frames else None)
            if isinstance(f, str):
                rec.error = f
                rec.return_value = None
            else:
                rec.return_value = f
        else:
            rec.return_value = _env([0])
        self.calls.append({"verb": method, "args": _plain(list(args)), "error": rec.error})
        return rec

    def check_abort(self) -> bool:
        self.abort_checks += 1
        return bool(self._aborts.pop(0)) if self._aborts else False

    def run(self, skill_name: str, params: dict, version: Any = None) -> SkillResult:
        return SkillResult(skill_name=skill_name, success=True, data={})


WAIT_CASES: dict[str, Any] = {}


def wait_case(name: str, *, params: dict[str, Any] | None = None, **ctx_kw: Any) -> None:
    _CLOCK[0] = 1_000_000.0
    # ⚠️ 用例之间**必须**清断点。`_ScriptCtx` 没有 `run_id`，于是全部用例共用
    # `WaitScanComplete.json` 这一个文件——不清的话上一个用例的中止会被下一个捡到
    # （导出时真的看见了：「sidecar 带着上一次的中止状态」）。这正是键里该有
    # run_id 的那条理由，在导出脚本上又演了一遍。
    for f in _sidecar_dir().glob("*"):
        f.unlink(missing_ok=True)
    ctx = _ScriptCtx(**ctx_kw)
    skill = WaitScanComplete()
    res = skill.run_composite(ctx, dict(params or {"timeout_ms": 20000}))
    data = dict(res.data or {})
    prog = data.pop("_progress", None)
    WAIT_CASES[name] = {
        "params": _plain(dict(params or {"timeout_ms": 20000})),
        "success": res.success,
        "error": res.error or "",
        "data": _plain(data),
        "progress": _plain(prog),
        "calls": ctx.calls,
        "verbs": [c["verb"] for c in ctx.calls],
        "abort_checks": ctx.abort_checks,
    }


F256_FULL = _env(_frame_body(256, 256, 256))
F256_PART = _env(_frame_body(256, 256, 100))
F256_ZERO = _env(_frame_body(256, 256, 0))
BUF256 = _env([1, [(0,)], 256, 256])

# 正常收尾：跑了一会儿 → status 0 → 缓冲区满行
wait_case("completed", status=[1, 1, 0], frames=[F256_FULL], buffer=BUF256)
# 中途停了：满配 256 行，只有 100 行有数
wait_case("stopped_early", status=[1, 1, 0], frames=[F256_PART], buffer=BUF256)
# 2026-08-13 竞态：一次都没见它跑、缓冲区确证 0 行 ⇒ **它从没开始**
wait_case("never_started", status=[0], frames=[F256_ZERO], buffer=BUF256)
# 同一条竞态的**正常**那一半：开头还没架起来，随后跑起来并扫完
wait_case("start_grace_then_completed",
          status=[0, 0, 1, 1, 0], frames=[F256_ZERO, F256_ZERO, F256_FULL], buffer=BUF256)
# 「等待开始前就已经扫完了」——宽限期内测到有行数，走正常判定
wait_case("already_finished_before_wait", status=[0], frames=[F256_FULL], buffer=BUF256)
# 读不到 ⇒ fail open：outcome 还是 completed，但 lines_verified=False
wait_case("unmeasurable_buffer", status=[1, 0], frames=[F256_FULL], buffer="模拟故障：读缓冲区失败")
wait_case("unmeasurable_frame", status=[1, 0], frames=["模拟故障：抓帧失败"], buffer=BUF256)
# 行数与缓冲区配置**对不上** ⇒ 拒绝判断，不制造一个截断
wait_case("frame_rows_mismatch", status=[1, 0],
          frames=[_env(_frame_body(128, 128, 128))], buffer=BUF256)
# 超时：默认停扫
wait_case("timed_out", params={"timeout_ms": 2000}, status=[1], frames=[F256_PART], buffer=BUF256)
wait_case("timed_out_no_stop", params={"timeout_ms": 2000, "stop_on_timeout": False},
          status=[1], frames=[F256_PART], buffer=BUF256)
# 延期：预算到点但行数还在**严格增长**
wait_case("extension_granted", params={"timeout_ms": 2000}, status=[1],
          frames=[_env(_frame_body(256, 256, 100)),
                  _env(_frame_body(256, 256, 150)),
                  _env(_frame_body(256, 256, 200)),
                  _env(_frame_body(256, 256, 240))],
          buffer=BUF256)
# 冻住：行数不动 ⇒ 延期赚不到，按时死
wait_case("frozen_no_extension", params={"timeout_ms": 2000}, status=[1],
          frames=[_env(_frame_body(256, 256, 100))], buffer=BUF256)
# 换帧：行数**掉下去**了 —— 不是卡住，是 Continuous scan 开着
wait_case("restarted", params={"timeout_ms": 2000}, status=[1],
          frames=[_env(_frame_body(256, 256, 234)),
                  _env(_frame_body(256, 256, 208))],
          buffer=BUF256)
# 中止：执行器在开步之前就拦下（外部中止）
wait_case("abort_external", status=[1], frames=[F256_PART], buffer=BUF256, aborts=[True])
# 中止：执行器放行、轮询自己查到 ⇒ 走 _phase_poll 那一支
wait_case("abort_inside_poll", status=[1], frames=[F256_PART], buffer=BUF256,
          aborts=[False, True])
# 中止发生在跑了几步之后
wait_case("abort_midway", status=[1], frames=[F256_PART], buffer=BUF256,
          aborts=[False, False, False, False, True])
# 一次轮询报错 ⇒ optional，等待不该因此中止
wait_case("poll_error_is_optional", status=[1, 1, 0], frames=[F256_FULL], buffer=BUF256,
          errors={0: "模拟故障：连接被对端关闭"})


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_scan_wait.py 生成——驱动旧仓真实"
                 " WaitScanComplete 与回包解析器录得，不要手改。",
        "constants": {
            "start_grace_s": WaitScanComplete._START_GRACE_S,
            "max_extensions": WaitScanComplete._MAX_EXTENSIONS,
            "extension_fraction": WaitScanComplete._EXTENSION_FRACTION,
            "phase_poll_prefix": "_phase_poll_",
            "phase_finalize": "_phase_finalize",
        },
        "parsers": _grid(),
        "wait": WAIT_CASES,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(BUFFER_CASES)} 格 buffer · "
          f"{len(FRAME_CASES)} 格 frame · {len(WAIT_CASES)} 个等待结局")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
