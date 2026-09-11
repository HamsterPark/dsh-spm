r"""把 `AutoApproach` **真的进一遍针**——带一份会收敛的物理脚本。

这个技能当初进 `TRACE_SKIP` 的理由就是这个：它的「成功」需要 Z 压电真的往下走、
电流真的涨到设定点，而通用合成器给的是恒定值，于是 `ok` 那一趟录到的是
「模块报在跑、压电纹丝不动」的 1800 秒超时。那条轨迹本身是对的（它正是真机上那个
故障的形状），但它不是成功。

这里给每格一份脚本：模块状态序列、电流序列、Z 序列、设定点。于是 20 个结局——
收敛、秒完成、启动被拒、停了但没电流、判不出、读不到、超时、Z 纹丝不动、状态抖动、
停机被拒——各自成立在哪一格，都是**跑出来的**。

外加四张单函数网格，它们各自钉住一次真机事故：

* `_engagement_bar`  —— 噪声底（#75「调低电流假装进到针了」）
* `settle_engagement`—— 两次一致才下结论（2026-08-05 采到交接瞬态）
* `WaitProgress`     —— 模块跑了多久 + 台子动没动（2026-08-08 整晚查「秒停」）
* `_parse_running`   —— 读不懂 ≠ 没在跑（2026-08-15 普查 A4）

    python \
        tools/spec-export/export_approach.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "approach.json"

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

from mast.core.types import NanonisCallRecord, SkillResult  # noqa: E402
from mast.skills.composite.graph_executor import _sidecar_dir  # noqa: E402
import mast.skills.builtins.approach as ap  # noqa: E402


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v in (float("inf"), float("-inf")):
            return "Infinity" if v > 0 else "-Infinity"
        return v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "item"):
        return _plain(v.item())
    return str(v)


def _env(body: Any) -> tuple:
    return ("", b"", body)


# ─────────────────────────────────────────────────────────────────────────
# ① 单函数网格
# ─────────────────────────────────────────────────────────────────────────

BAR = {}
for name, sp in [("none", None), ("zero", 0.0), ("500pA", 500e-12),
                 ("50pA", 50e-12), ("1pA", 1e-12), ("0.5pA", 0.5e-12),
                 ("negative", -500e-12), ("1nA", 1e-9), ("tiny", 1e-15)]:
    BAR[name] = {"setpoint_a": sp, "bar_a": ap._engagement_bar(sp)}

FMT_A = {}
for x in [None, 0.0, 1e-12, 0.17e-12, 25e-12, 500e-12, 0.999e-9, 1e-9, 1.5e-9,
          -46.6e-12, 1e-15]:
    FMT_A[repr(x)] = {"input": _plain(x), "text": ap._fmt_a(x)}

FMT_M = {}
for x in [None, 0.0, 1e-12, 169.5e-9, 1e-9, 0.999e-6, 3.42e-6, 1e-3, 2.5e-3,
          -220.9e-9]:
    FMT_M[repr(x)] = {"input": _plain(x), "text": ap._fmt_m(x)}

PARSE_RUNNING = {}
for name, rv in [
        ("envelope_1", _env([1])),
        ("envelope_0", _env([0])),
        ("envelope_empty_body", _env([])),
        ("envelope_tuple_0", _env([(0,)])),
        ("envelope_tuple_1", _env([(1,)])),
        ("envelope_str_1", _env(["1"])),
        ("envelope_str_junk", _env(["nope"])),
        ("envelope_true", _env([True])),
        ("envelope_float", _env([2.0])),
        ("flat_list_1", [1]),
        ("flat_list_0", [0]),
        ("empty_list", []),
        ("bare_int_1", 1),
        ("bare_int_0", 0),
        ("bare_none", None),
        ("nested_empty", _env([[]])),
]:
    # `body` = 本仓这一侧收到的东西（信封在 nanonis-wire 那层已拆，D-SKILL-1）。
    # 录下来而不是让 TS 侧照着 `input` 猜——`scan_wait.json` 那边就是这么翻的。
    body = rv[2] if isinstance(rv, tuple) and len(rv) == 3 else rv
    PARSE_RUNNING[name] = {"input": _plain(rv), "body": _plain(body),
                           "running": ap._parse_running(rv)}


# ── settle_engagement 单独的网格（不经过技能）──────────────────────────
SETTLE = {}


def settle_case(name: str, pairs: list[Any], *, interval_s: float = 1.0,
                budget_s: float = 20.0, agree_n: int = 2,
                aborts: list[bool] | None = None) -> None:
    _CLOCK[0] = 1_000_000.0
    seq = list(pairs)
    ab = list(aborts or [])

    def read():
        if not seq:
            return (None, None)
        v = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(v, str):
            raise RuntimeError(v)
        return v

    def check_abort():
        return bool(ab.pop(0)) if ab else False

    v = ap.settle_engagement(read, interval_s=interval_s, budget_s=budget_s,
                             agree_n=agree_n, check_abort=check_abort)
    SETTLE[name] = {"verdict": _plain(v.as_dict()), "evidence": v.evidence()}


SP = 50e-12          # 设定点 50 pA ⇒ bar = 25 pA
ON = (46.6e-12, SP)  # 稳稳在线上（旧仓观测的稳定读数）
OFF = (0.04e-12, SP)  # 噪声底（那晚报文里的 0.04 pA）

settle_case("settles_engaged", [ON])
settle_case("settles_not_engaged", [OFF])
# 一次瞬态 + 随后稳住 ⇒ 不该被那一次决定（2026-08-05 就栽在单次读数上）
settle_case("transient_then_engaged", [OFF, ON, ON])
# 一直在两边跳 ⇒ 判不出，engaged 保持 None
settle_case("never_agrees", [ON, OFF, ON, OFF, ON, OFF, ON, OFF, ON, OFF,
                             ON, OFF, ON, OFF, ON, OFF, ON, OFF, ON, OFF,
                             ON, OFF, ON, OFF])
settle_case("unreadable_all", [(None, None)])
settle_case("unreadable_then_engaged", [(None, None), ON, ON])
settle_case("setpoint_zero", [(46.6e-12, 0.0)])
settle_case("setpoint_none", [(46.6e-12, None)])
settle_case("reader_raises", ["读电流炸了"])
settle_case("aborted_immediately", [ON], aborts=[True])
settle_case("aborted_midway", [ON], aborts=[False, True])
# 噪声底：把设定点调到 0.5 pA，噪声 0.4 pA 仍然**不算**进针（#75）
settle_case("noise_floor_blocks_gaming", [(0.4e-12, 0.5e-12)])
settle_case("agree_n_three", [ON], agree_n=3)
settle_case("keep_reads_cap", [ON, OFF] * 10 + [OFF], budget_s=25.0)


# ── WaitProgress 单独的网格 ──────────────────────────────────────────────
WAIT_PROGRESS = {}


def wp_case(name: str, script: list[tuple]) -> None:
    """script: [(kind, value, elapsed)]，kind ∈ {running, z}"""
    p = ap.WaitProgress()
    for kind, value, elapsed in script:
        if kind == "running":
            p.note_running(bool(value), elapsed)
        else:
            p.note_z(value)
    WAIT_PROGRESS[name] = {"dict": _plain(p.as_dict()), "text": p.motion_text(),
                           "z_span_m": _plain(p.z_span_m),
                           "cycles_approx": _plain(p.cycles_approx)}


wp_case("never_polled", [])
wp_case("no_z_reads", [("running", True, 0.0), ("running", True, 1.0),
                       ("running", False, 2.0)])
wp_case("z_frozen", [("running", True, 0.0), ("z", 1e-9, 0),
                     ("running", True, 1.0), ("z", 1e-9, 0),
                     ("running", True, 2.0), ("z", 1e-9, 0)])
# 进针往返轨迹：Z 在 ±169.5 nm 之间满摆（旧仓观测的运动形状）
_saw = []
for _i in range(9):
    _saw.append(("z", (169.5e-9 if _i % 2 == 0 else -169.5e-9), 0))
wp_case("woodpecker_cycles",
        [("running", True, 0.0)] + _saw + [("running", True, 8.0)])
wp_case("one_z_read", [("running", True, 0.0), ("z", 5e-9, 0)])
wp_case("z_none_ignored", [("running", True, 0.0), ("z", None, 0),
                           ("z", 3e-9, 0), ("z", None, 0)])
wp_case("module_never_ran", [("running", False, 0.0), ("running", False, 1.0)])
wp_case("ran_then_stopped", [("running", False, 0.0), ("running", True, 1.0),
                             ("running", True, 5.0), ("running", False, 6.0)])


# ─────────────────────────────────────────────────────────────────────────
# ② AutoApproach 端到端
# ─────────────────────────────────────────────────────────────────────────


class _ScriptCtx:
    """脚本化的 ExecutionContext。每个动词的应答由用例给定。"""

    def __init__(self, *, running: list[Any] | None = None,
                 current: list[Any] | None = None,
                 setpoint: Any = SP,
                 z: list[Any] | None = None,
                 aborts: list[bool] | None = None,
                 errors: dict[str, str] | None = None,
                 error_at: dict[int, str] | None = None,
                 error_call: dict[str, str] | None = None) -> None:
        self._running = list(running or [1, 1, 0])
        self._current = list(current or [46.6e-12])
        self._setpoint = setpoint
        self._z = list(z if z is not None else [None])
        self._aborts = list(aborts or [])
        #: 动词 → 恒定错误
        self._errors = dict(errors or {})
        #: 调用序号 → 错误
        self._error_at = dict(error_at or {})
        #: `"动词(实参…)"` → 错误。**按动词加实参**索引：`AutoApproach_OnOffSet`
        #: 既是起跑（1）也是停机（0），只按动词注错会把「停机被拒」那一格变成
        #: 「起跑失败」——导出时真的这么翻过一次。
        self._error_call = dict(error_call or {})
        self.calls: list[dict[str, Any]] = []
        self.owner = "exporter"
        self.run_id = "R1"

    @staticmethod
    def _next(seq: list[Any]) -> Any:
        return seq.pop(0) if len(seq) > 1 else (seq[0] if seq else None)

    def safe_call(self, method: str, *args: Any, **kw: Any) -> NanonisCallRecord:
        i = len(self.calls)
        rec = NanonisCallRecord(method=method, args=tuple(args), kwargs={})
        key = f"{method}({','.join(str(a) for a in args)})"
        err = self._error_at.get(i) or self._error_call.get(key) or self._errors.get(method)
        if err is not None:
            rec.error = err
            rec.return_value = None
        elif method == "AutoApproach_OnOffGet":
            v = self._next(self._running)
            rec.return_value = _env([] if v is None else [v])
        elif method == "Current_Get":
            v = self._next(self._current)
            rec.return_value = _env([] if v is None else [v])
        elif method == "ZCtrl_SetpntGet":
            sp = self._setpoint
            rec.return_value = _env([] if sp is None else [sp])
        elif method == "ZCtrl_ZPosGet":
            v = self._next(self._z)
            rec.return_value = _env([] if v is None else [v])
        else:
            rec.return_value = _env([])
        self.calls.append({"verb": method, "args": _plain(list(args)),
                           "error": rec.error})
        return rec

    def check_abort(self) -> bool:
        return bool(self._aborts.pop(0)) if self._aborts else False

    def run(self, skill_name: str, params: dict, version: Any = None) -> SkillResult:
        return SkillResult(skill_name=skill_name, success=True, data={})


CASES: dict[str, Any] = {}


def case(name: str, *, params: dict[str, Any] | None = None,
         poll_interval_s: float = 0.5, grace_s: float = 3.0,
         z_every_s: float = 1.0, engage_budget_s: float = 4.0,
         engage_interval_s: float = 1.0, **ctx_kw: Any) -> None:
    for f in _sidecar_dir().glob("*"):
        f.unlink(missing_ok=True)
    _CLOCK[0] = 1_000_000.0
    ctx = _ScriptCtx(**ctx_kw)
    skill = ap.AutoApproach()
    skill._poll_interval_s = poll_interval_s
    skill._grace_s = grace_s
    skill._z_sample_every_s = z_every_s
    skill._engage_budget_s = engage_budget_s
    skill._engage_interval_s = engage_interval_s
    # 串扰报告不参与任何决策，而它要的是 lock-in 链路（本仓还没有）。关掉。
    skill._crosstalk_every_s = 0.0
    res = skill._run_approach_graph(ctx, dict(params or {}))
    data = dict(res.data or {})
    prog = data.pop("_progress", None)
    CASES[name] = {
        "params": _plain(params or {}),
        "success": res.success,
        "error": res.error or "",
        "data": _plain(data),
        "progress": _plain(prog),
        "calls": ctx.calls,
        "verbs": [c["verb"] for c in ctx.calls],
        "stop_failures": list(getattr(skill, "_stop_failures", [])),
    }


# ── 成功路 ──────────────────────────────────────────────────────────────
# 模块跑三拍然后停，电流稳稳在线上
case("converges", running=[1, 1, 1, 0], current=[46.6e-12],
     z=[0.0, 60e-9, 120e-9, 169.5e-9])
# 比第一次轮询还快就完成了（running 一次都没读到 1），电流确认
case("completed_before_first_poll", running=[0], current=[46.6e-12])
# 同样一次没读到 1，但电流也没有 ⇒ 启动被拒
case("start_rejected", running=[0], current=[0.04e-12])
# 跑过、停了，但电流稳稳在线下 ⇒ 不是进针（#42：0.17 pA 对 500 pA 也报了成功）
case("stopped_but_no_current", running=[1, 1, 0], current=[0.17e-12],
     setpoint=500e-12, z=[0.0, 50e-9, 100e-9])
# 读数一直在两边跳 ⇒ 判不出，**既不是进针也不是没进针**
case("never_settles", running=[1, 0],
     current=[46.6e-12, 0.04e-12] * 12, z=[0.0, 10e-9])
# 电流根本读不到
case("current_unreadable", running=[1, 0], current=[None],
     z=[0.0, 10e-9])
case("setpoint_unreadable", running=[1, 0], current=[46.6e-12], setpoint=None,
     z=[0.0, 10e-9])
# 噪声底：设定点调到 0.5 pA，0.4 pA 的噪声仍然不算进针（#75）
case("noise_floor_blocks_gaming", running=[1, 0], current=[0.4e-12],
     setpoint=0.5e-12, z=[0.0, 1e-9])

# ── 超时 ────────────────────────────────────────────────────────────────
# 一直在跑，Z 也在推进 ⇒ 「不是卡住，再调一次会从当前位置继续」
case("timeout_still_advancing", params={"wait_timeout_s": 5.0}, running=[1],
     current=[0.04e-12], z=[0.0, 60e-9, 120e-9, 169.5e-9, 120e-9, 60e-9, 0.0])
# 一直在跑，Z 纹丝不动 ⇒ 「模块报在跑，压电却没动」
case("timeout_z_frozen", params={"wait_timeout_s": 5.0}, running=[1],
     current=[0.04e-12], z=[1e-9])
# 一直在跑，Z 读不到 ⇒ 「粗动有没有推进无法判断」
case("timeout_z_unreadable", params={"wait_timeout_s": 5.0}, running=[1],
     current=[0.04e-12], z=[None])

# ── 状态位 ──────────────────────────────────────────────────────────────
# 读到 0、复读又说在跑 ⇒ 那个 0 是一次读数，不是一个事实
case("status_flap", running=[1, 1, 0, 1, 1, 0, 0], current=[46.6e-12],
     z=[0.0, 30e-9, 60e-9, 90e-9])
# 状态位读不懂 ⇒ 记进 status_unreadable_n，**不是**「没在跑」
case("status_unreadable", running=[1, 1, None, None, 0], current=[46.6e-12],
     z=[0.0, 30e-9, 60e-9])

# ── 失败与中止 ──────────────────────────────────────────────────────────
case("open_fails", errors={"AutoApproach_Open": "模拟故障：连接被对端关闭"})
case("start_fails", errors={"AutoApproach_OnOffSet": "模拟故障：写失败"})
# 最后那次回读失败。下标 12 = 该趟的最后一次调用（用 `error_at` 而不是按动词注错：
# `AutoApproach_OnOffGet` 在等待相里被读了很多次，按动词会把第一次轮询就打掉）。
case("verify_fails", running=[1, 1, 0], current=[46.6e-12],
     error_at={12: "模拟故障：最终回读失败"})
case("poll_errors_persistent", running=[1],
     errors={"AutoApproach_OnOffGet": "模拟故障：链路断了"})
case("abort_during_wait", running=[1], current=[46.6e-12],
     aborts=[False, False, False, True])
case("abort_before_first_step", running=[1], aborts=[True])
# 停机命令被拒 ⇒ 报文里要顶出那一行（2026-08-10：原来整段 except: pass）
case("stop_command_rejected", running=[1, 1, 0], current=[0.04e-12],
     z=[0.0, 30e-9], error_call={"AutoApproach_OnOffSet(0)": "模拟故障：停机被拒"})


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_approach.py 生成——驱动旧仓真实"
                 " AutoApproach 录得，不要手改。",
        "constants": {
            "min_engaged_current_a": ap._MIN_ENGAGED_CURRENT_A,
            "engage_agree_n": ap._ENGAGE_AGREE_N,
            "engage_interval_s": ap._ENGAGE_INTERVAL_S,
            "keep_reads": ap._KEEP_READS,
            "default_wait_timeout_s": ap.AutoApproach._DEFAULT_WAIT_TIMEOUT_S,
            "poll_interval_s": ap.AutoApproach._poll_interval_s,
            "grace_s": ap.AutoApproach._grace_s,
            "z_sample_every_s": ap.AutoApproach._z_sample_every_s,
            "phase_open": ap._PHASE_OPEN,
            "phase_start": ap._PHASE_START,
            "phase_wait": ap._PHASE_WAIT,
            "phase_verify": ap._PHASE_VERIFY,
        },
        "engagement_bar": BAR,
        "fmt_a": FMT_A,
        "fmt_m": FMT_M,
        "parse_running": PARSE_RUNNING,
        "settle": SETTLE,
        "wait_progress": WAIT_PROGRESS,
        "cases": CASES,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(BAR)} 格判据线 · {len(SETTLE)} 格沉降 · "
          f"{len(WAIT_PROGRESS)} 格进展 · {len(PARSE_RUNNING)} 格状态位 · "
          f"{len(CASES)} 个端到端")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
