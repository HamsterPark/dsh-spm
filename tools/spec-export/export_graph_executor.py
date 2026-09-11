"""把 `GraphExecutor` **真的跑一遍**，把它做的每一件事录成金样。

驱动的是旧仓真实的执行器，不是我对那 1133 行的阅读。每个用例录下：

* `returned`      —— `run_plan` 的返回值（或它放出去的异常类型）
* `calls`         —— 依次向 `context.run` 发的 `(skill, params, version)`
* `diags`         —— 拒绝台账逐条（`step_skip` / `step_fail` / `step_abort` /
                     `progress_discard`），**含字段**
* `narrations`    —— 旁白逐条（发点、时机、`continued` 由谁决定）
* `emits`         —— 每一拍 `emit_progress` 看到的进度快照
* `sidecar`       —— 每次落盘的内容、跑完之后文件还在不在
* `progress`      —— 终态 `to_dict()` + `failed_reasons`（**它不在 to_dict 里**）
* `abort_text` / `abort_facts`

为什么这个东西值得一份自己的金样：它是**四次真机事故的现场**——2026-07-10 假进针、
2026-07-27 五个 region 0.37 秒「扫完」、2026-08-12 finalize 被跳过、2026-08-23
「重试」变「重放」。四条守卫全都长在恢复路径上，而恢复路径**只在出事那天才被走到**。
一份把它们逐条钉住的网格，是这些守卫唯一不会被静默移植掉的办法。

    python \
        tools/spec-export/export_graph_executor.py
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
OUT = REPO / "spec" / "golden" / "graph_executor.json"

# ── 钉住墙钟。`started_at` / `last_update_at` 都是 `time.time()`，不钉的话
#    每跑一次金样就换一批数字，而「重跑逐字节相同」是金样最重要的性质。──
import time as _time

_NOW = 1_700_000_000.0
_time.time = (lambda: _NOW)  # type: ignore[assignment]

sys.path.insert(0, str(MAST_ROOT))

import mast.skills.composite.graph_executor as ge  # noqa: E402
from mast.skills.composite._base import AbortRequested  # noqa: E402

# ── 台账与旁白的落点换成记录器。两者在真仓里都是 try/except 包住的懒 import，
#    换掉之后执行器一行不改。──
_DIAGS: list[dict[str, Any]] = []
_NARR: list[dict[str, Any]] = []


class _FakeDiagnostics:
    @staticmethod
    def record(kind: str, subject: str, reason: str, **fields: Any) -> None:
        _DIAGS.append({"kind": kind, "subject": subject, "reason": reason,
                       "fields": _plain(fields)})


class _FakeNarration:
    @staticmethod
    def narrate(kind: str, /, **data: Any) -> None:
        _NARR.append({"kind": kind, "data": _plain(data)})


sys.modules["mast.core.diagnostics"] = _FakeDiagnostics  # type: ignore[assignment]
sys.modules["mast.chat.narration"] = _FakeNarration      # type: ignore[assignment]


def _plain(v: Any) -> Any:
    """把记录下来的东西压成 JSON 能表达的形状。"""
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, ge.CompositeProgress):
        return v.to_dict()
    return f"<{type(v).__name__}>"


class _Result:
    """子技能返回值。执行器只看 `success` / `error` / `data` 三个属性。"""

    def __init__(self, success: bool = True, error: str = "",
                 data: dict[str, Any] | None = None) -> None:
        self.success = success
        self.error = error
        self.data = data or {}


class _Ctx:
    """脚本化的 ExecutionContext。**只实现执行器鸭子类型要的那几个成员**，
    而且每个成员的有无都是用例的一部分（`_check_halt` 的存在与否改变行为）。"""

    def __init__(self, *, run_id: str = "R1",
                 results: dict[str, Any] | None = None,
                 aborts: list[bool] | None = None,
                 halts: list[Any] | None = None,
                 prior: dict[str, Any] | None = None,
                 has_halt: bool = True,
                 has_abort: bool = True,
                 log: list[dict[str, Any]] | None = None) -> None:
        self.run_id = run_id
        self._results = results or {}
        self._aborts = list(aborts or [])
        self._halts = list(halts or [])
        self._prior = prior
        self.log = log if log is not None else []
        self.calls: list[dict[str, Any]] = []
        self.emits: list[dict[str, Any]] = []
        self.flushes = 0
        if not has_halt:
            self.check_halt = None  # type: ignore[assignment]
        if not has_abort:
            self.check_abort = None  # type: ignore[assignment]

    # -- 执行器要的接口 --
    def run(self, skill_name: str, params: dict, version: Any = None) -> Any:
        rec: dict[str, Any] = {"skill": skill_name, "params": _plain(params)}
        if version is not None:
            rec["version"] = version
        self.calls.append(rec)
        r = self._results.get(skill_name, _Result())
        if isinstance(r, BaseException):
            raise r
        return r

    def get_progress(self, name: str) -> Any:
        return self._prior

    def check_abort(self) -> bool:
        return bool(self._aborts.pop(0)) if self._aborts else False

    def check_halt(self) -> Any:
        return self._halts.pop(0) if self._halts else ""

    def emit_progress(self, progress: Any) -> None:
        self.emits.append(progress.to_dict())

    def checkpoint_flush(self) -> None:
        self.flushes += 1


def _step(sid: str, skill: str = "Noop", **kw: Any) -> ge.CompositeStep:
    return ge.CompositeStep(step_id=sid, skill_name=skill,
                            params=kw.pop("params", {}), **kw)


def _sidecar_text(name: str, run_id: str) -> str | None:
    p = ge._sidecar_path(name, run_id)
    return p.read_text(encoding="utf-8") if p.exists() else None


def _write_sidecar(name: str, run_id: str, d: dict[str, Any]) -> None:
    ge._sidecar_path(name, run_id).write_text(
        json.dumps(d, ensure_ascii=False), encoding="utf-8")


def _clear_all_sidecars() -> None:
    for p in ge._sidecar_dir().glob("*"):
        p.unlink(missing_ok=True)


def _prog(**kw: Any) -> dict[str, Any]:
    """一份既往进度的 dict 形态（`from_dict` 的输入）。"""
    base = ge.CompositeProgress(composite_name=kw.pop("composite_name", "C")).to_dict()
    base.update(kw)
    return base


# ─────────────────────────────────────────────────────────────────────────
# 用例跑法
# ─────────────────────────────────────────────────────────────────────────

_FLUSHES = [0]
_real_flush = ge.GraphExecutor.flush_sidecar


def _counting_flush(self: Any) -> None:
    _FLUSHES[0] += 1
    _real_flush(self)


ge.GraphExecutor.flush_sidecar = _counting_flush  # type: ignore[assignment]

CASES: dict[str, Any] = {}


def case(name: str, *, plan: Any, composite: str = "C",
         pre_sidecar: dict[str, Any] | None = None,
         set_total: int | None = None,
         on_step_failed: Any = None, on_step_result: Any = None,
         **ctx_kw: Any) -> None:
    _clear_all_sidecars()
    _DIAGS.clear()
    _NARR.clear()
    _FLUSHES[0] = 0
    run_id = ctx_kw.pop("run_id", "R1")
    if pre_sidecar is not None:
        _write_sidecar(composite, run_id, pre_sidecar)

    ctx = _Ctx(run_id=run_id, **ctx_kw)
    ex = ge.GraphExecutor(composite, ctx, on_step_failed=on_step_failed,
                          on_step_result=on_step_result)
    init_diags = list(_DIAGS)
    _DIAGS.clear()
    if set_total is not None:
        ex.set_total_steps(set_total)

    out: dict[str, Any] = {
        "progress_after_init": ex.progress.to_dict(),
        "init_diags": init_diags,
    }
    try:
        out["returned"] = ex.run_plan(plan() if callable(plan) else plan)
    except BaseException as exc:  # noqa: BLE001
        out["returned"] = None
        out["raised"] = type(exc).__name__
        out["raised_text"] = str(exc)

    prog = ex.progress
    out.update({
        "calls": ctx.calls,
        "diags": list(_DIAGS),
        "narrations": list(_NARR),
        "emits": ctx.emits,
        "checkpoint_flushes": ctx.flushes,
        "sidecar_flushes": _FLUSHES[0],
        "sidecar_after": _sidecar_text(composite, run_id),
        "progress": prog.to_dict(),
        "failed_reasons": dict(prog.failed_reasons),
        "sub_results": sorted(ex.sub_results.keys()),
        "abort_text": ge.abort_error_text(prog),
        "abort_facts": ge.abort_facts(prog),
    })
    CASES[name] = out


P3 = [_step("s1", "MoveToXY", params={"x_m": 1e-9}),
      _step("s2", "GetBias"),
      _step("s3", "StartScan")]


def _gen(steps: list[Any], raise_at: int = -1, exc: Any = None) -> Any:
    def g() -> Any:
        for i, s in enumerate(steps):
            if i == raise_at:
                raise exc
            yield s
    return g


# ── ① 直路 ──────────────────────────────────────────────────────────────
case("static_ok", plan=P3)
case("empty_plan", plan=[])
case("no_checkpoint", plan=[_step("s1", checkpoint_after=False),
                            _step("s2", checkpoint_after=False)])
case("skill_version", plan=[_step("s1", "GetBias", skill_version="2.1")])
case("set_total_steps_is_a_max", plan=P3, set_total=10)
case("set_total_steps_below_seen", plan=P3, set_total=1)
case("tags_dont_change_anything", plan=[_step("s1", tags=("a", "b"))])

# ── ② 失败的三条出路 ────────────────────────────────────────────────────
FAIL = {"GetBias": _Result(False, "rolled_back: diverged",
                           {"detail": "第 1 轮后残余 Z 占用 6.4 nm"})}
case("mandatory_fail_aborts", plan=P3, results=FAIL)
case("optional_fail_continues",
     plan=[_step("s1", "MoveToXY"), _step("s2", "GetBias", optional=True),
           _step("s3", "StartScan")], results=FAIL)
case("fail_without_detail", plan=P3,
     results={"GetBias": _Result(False, "no_such_channel")})
case("fail_with_empty_error", plan=P3, results={"GetBias": _Result(False, "")})
case("on_step_failed_continues", plan=P3, results=FAIL,
     on_step_failed=lambda step, msg: True)
case("on_step_failed_aborts", plan=P3, results=FAIL,
     on_step_failed=lambda step, msg: False)
case("on_step_failed_raises", plan=P3, results=FAIL,
     on_step_failed=lambda step, msg: (_ for _ in ()).throw(RuntimeError("x")))
case("on_step_failed_declines_but_optional", plan=[
        _step("s1", "GetBias", optional=True), _step("s2", "StartScan")],
     results=FAIL, on_step_failed=lambda step, msg: False)
case("on_step_result_raises", plan=[_step("s1", "GetBias")],
     on_step_result=lambda step, r: (_ for _ in ()).throw(RuntimeError("y")))

# ── ③ 异常：普通异常 vs 控制流 ──────────────────────────────────────────
case("sub_skill_raises", plan=P3,
     results={"GetBias": ValueError("boom")})
case("sub_skill_raises_optional", plan=[
        _step("s1", "MoveToXY"), _step("s2", "GetBias", optional=True),
        _step("s3", "StartScan")], results={"GetBias": ValueError("boom")})
case("sub_skill_abort_requested", plan=P3,
     results={"GetBias": AbortRequested("操作员中止")})
case("generator_abort_requested", plan=_gen(P3, 1, AbortRequested("轮询中中止")))
case("generator_raises", plan=_gen(P3, 1, ValueError("plan blew up")))
case("dynamic_plan_ok", plan=_gen(P3))

# ── ④ 中止闩与停机（两套机制，故意不通用）──────────────────────────────
case("abort_before_step_2", plan=P3, aborts=[False, True])
case("abort_before_step_1", plan=P3, aborts=[True])
case("no_check_abort_never_aborts", plan=P3, has_abort=False)
case("halt_before_step_2", plan=P3, halts=["", "针尖状态 CRITICAL：前置放大器顶轨"])
case("halt_is_one_shot", plan=P3, halts=["", "", "第三次才停"])
case("halt_non_string_ignored", plan=P3, halts=[object(), object(), object()])
case("halt_none_ignored", plan=P3, halts=[None, None, None])
case("halt_false_ignored", plan=P3, halts=[False, False, False])
case("no_check_halt_never_halts", plan=P3, has_halt=False)
case("abort_wins_over_halt", plan=P3, aborts=[True], halts=["停机理由"])

# ── ⑤ 恢复：两个入口（sidecar / 上下文），四条守卫 ──────────────────────
FRESH = _NOW - 60.0
STALE = _NOW - (30 * 60.0 + 1.0)

case("sidecar_resume_skips",
     plan=P3, pre_sidecar=_prog(completed_steps=["s1", "s2"], total_steps=3,
                                last_update_at=FRESH))
case("sidecar_terminal_discarded",
     plan=P3, pre_sidecar=_prog(completed_steps=["s1", "s2", "s3"],
                                total_steps=3, last_update_at=FRESH))
case("sidecar_stale_discarded",
     plan=P3, pre_sidecar=_prog(completed_steps=["s1", "s2"], total_steps=3,
                                last_update_at=STALE))
case("sidecar_streaming_total_zero_still_resumes",
     plan=P3, pre_sidecar=_prog(completed_steps=["s1", "s2"], total_steps=0,
                                last_update_at=FRESH))
case("sidecar_stale_abort_dropped",
     plan=P3, pre_sidecar=_prog(completed_steps=["s1"], total_steps=3,
                                last_update_at=FRESH, aborted=True,
                                aborted_reason="上一轮：GetBias failed: 通道不存在"))
case("sidecar_empty_not_used",
     plan=P3, pre_sidecar=_prog(completed_steps=[], total_steps=3,
                                last_update_at=FRESH))
case("sidecar_run_id_scopes_the_file",
     plan=P3, run_id="R2", pre_sidecar=None)

case("context_prior_resume_skips",
     plan=P3, prior=_prog(completed_steps=["s1"], total_steps=3))
case("context_prior_terminal_discarded",
     plan=P3, prior=_prog(completed_steps=["s1", "s2", "s3"], total_steps=3))
case("context_prior_stale_abort_dropped",
     plan=P3, prior=_prog(completed_steps=["s1"], total_steps=3, aborted=True,
                          aborted_reason="上一轮：aborted by user"))
case("context_prior_empty_dict_ignored", plan=P3, prior={})
case("context_prior_object_accepted",
     plan=P3, prior=ge.CompositeProgress(composite_name="C", total_steps=3,
                                         completed_steps=["s1"]))
case("sidecar_beats_context_when_further",
     plan=P3, prior=_prog(completed_steps=["s1"], total_steps=3),
     pre_sidecar=_prog(completed_steps=["s1", "s2"], total_steps=3,
                       last_update_at=FRESH))
case("context_kept_when_sidecar_not_further",
     plan=P3, prior=_prog(completed_steps=["s1", "s2"], total_steps=3),
     pre_sidecar=_prog(completed_steps=["s1"], total_steps=3,
                       last_update_at=FRESH))

# ─────────────────────────────────────────────────────────────────────────
# 单函数网格
# ─────────────────────────────────────────────────────────────────────────

IS_TERMINAL = {}
for _t, _d in [(0, 0), (0, 3), (3, 0), (3, 2), (3, 3), (3, 5), (-1, 0), (1, 1)]:
    IS_TERMINAL[f"total={_t},done={_d}"] = {
        "total_steps": _t, "completed": _d,
        "terminal": ge._is_terminal(ge.CompositeProgress(
            composite_name="C", total_steps=_t,
            completed_steps=[f"s{i}" for i in range(_d)])),
    }

DROP_STALE = {}
for _name, _ab, _rs in [("clean", False, ""), ("aborted_with_reason", True, "上一轮失败"),
                        ("aborted_no_reason", True, "")]:
    _p = ge.CompositeProgress(composite_name="C", aborted=_ab, aborted_reason=_rs)
    ge._drop_stale_abort(_p, "C", "state")
    DROP_STALE[_name] = {"before": {"aborted": _ab, "aborted_reason": _rs},
                         "after": {"aborted": _p.aborted,
                                   "aborted_reason": _p.aborted_reason}}

ABORT_TEXT = {}
for _name, _ab, _rs in [
        ("not_aborted", False, ""),
        ("not_aborted_with_reason", False, "残留的上一轮理由"),
        ("aborted_no_reason", True, ""),
        ("aborted_blank_reason", True, "   "),
        ("latch_sentinel", True, ge._ABORT_LATCH_REASON),
        ("user_abort_text", True, ge._USER_ABORT_TEXT),
        ("operator", True, "aborted by operator"),
        ("halt", True, "针尖状态 CRITICAL：前置放大器顶轨"),
        ("step_failure", True, "GetBias failed: 通道不存在"),
        ("padded", True, "  周围有空格  ")]:
    _p = ge.CompositeProgress(composite_name="C", aborted=_ab, aborted_reason=_rs)
    ABORT_TEXT[_name] = {"aborted": _ab, "aborted_reason": _rs,
                         "text": ge.abort_error_text(_p),
                         "facts": ge.abort_facts(_p)}

PROGRESS_SHAPE = {
    "defaults": ge.CompositeProgress(composite_name="C").to_dict(),
    "from_dict_empty": ge.CompositeProgress.from_dict({}).to_dict(),
    "from_dict_partial": ge.CompositeProgress.from_dict(
        {"composite_name": "X", "total_steps": "4", "completed_steps": ["a"],
         "aborted": 1, "aborted_reason": 7}).to_dict(),
    "roundtrip": ge.CompositeProgress.from_dict(
        _prog(composite_name="X", total_steps=2, completed_steps=["a"],
              failed_steps=["b"], current_step="c",
              partial_data={"k": [1, 2]}, aborted=True,
              aborted_reason="r")).to_dict(),
    "failed_reasons_not_in_to_dict":
        "failed_reasons" in ge.CompositeProgress(composite_name="C").to_dict(),
}

STEP_SHAPE = {
    "defaults": {k: _plain(v) for k, v in vars(_step("s1", "GetBias")).items()},
    "explicit": {k: _plain(v) for k, v in vars(ge.CompositeStep(
        step_id="s2", skill_name="SetBias", params={"v": 1.0}, optional=True,
        checkpoint_after=False, tags=("t",), skill_version="3")).items()},
}


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_graph_executor.py 生成——"
                 "驱动旧仓真实 GraphExecutor 录得，不要手改。",
        "constants": {
            "sidecar_resume_window_s": ge._SIDECAR_RESUME_WINDOW_S,
            "user_abort_text": ge._USER_ABORT_TEXT,
            "abort_latch_reason": ge._ABORT_LATCH_REASON,
            "now": _NOW,
            "begin_kind_for_skill": _begin_table(),
        },
        "step_shape": STEP_SHAPE,
        "progress_shape": PROGRESS_SHAPE,
        "is_terminal": IS_TERMINAL,
        "drop_stale_abort": DROP_STALE,
        "abort_text": ABORT_TEXT,
        "cases": CASES,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(CASES)} 个执行用例 · "
          f"{len(IS_TERMINAL)} 格 _is_terminal · {len(ABORT_TEXT)} 格 abort_text")
    return 0


def _begin_table() -> dict[str, str]:
    from mast.chat.narration_templates import BEGIN_KIND_FOR_SKILL
    return dict(BEGIN_KIND_FOR_SKILL)


if __name__ == "__main__":
    raise SystemExit(main())
