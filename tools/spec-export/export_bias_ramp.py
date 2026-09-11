r"""把 `SetBiasRamp` **真的 ramp 一遍**。

它是 GraphExecutor 的另一半验收：`WaitScanComplete` 验的是**流式**动态计划
（步数事先不知道），这一个验的是**先算后排**的动态计划——第 0 步先去读当前偏压，
读到了才排得出后面那串步骤。两种形状合起来，执行器的两条计划入口都被走过了。

录：

* `_compute_steps` 的**逐个目标电压**——`np.linspace` 的浮点要逐位对得上，
  差一个 ulp 就是下发给硬件的电压差一点；
* 两个「假起点」拒绝（2026 那条：读不到就拒，不要编一个 0.0 起点——
  真实偏压 1 V 而起点当成 0，第一步就把硬件从 1 V 拽到近 0，
  **那正是 slew 存在的意义所要防的突变**）；
* 失败与中止的文案逐字。

    python \
        tools/spec-export/export_bias_ramp.py
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
OUT = REPO / "spec" / "golden" / "bias_ramp.json"

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
from mast.skills.builtins.bias import SetBiasRamp  # noqa: E402


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if hasattr(v, "item"):
        return _plain(v.item())
    return str(v)


class _ScriptCtx:
    def __init__(self, *, bias: Any = None, errors: dict[int, str] | None = None,
                 aborts: list[bool] | None = None) -> None:
        #: `Bias_Get` 的回包 body；字符串表示读失败
        self._bias = bias if bias is not None else ("", b"", [1.0])
        self._errors = dict(errors or {})
        self._aborts = list(aborts or [])
        self.calls: list[dict[str, Any]] = []

    def safe_call(self, method: str, *args: Any) -> NanonisCallRecord:
        i = len(self.calls)
        rec = NanonisCallRecord(method=method, args=tuple(args), kwargs={})
        err = self._errors.get(i)
        if err is not None:
            rec.error = err
            rec.return_value = None
        elif method == "Bias_Get":
            if isinstance(self._bias, str):
                rec.error = self._bias
                rec.return_value = None
            else:
                rec.return_value = self._bias
        else:
            rec.return_value = ("", b"", [])
        self.calls.append({"verb": method, "args": _plain(list(args)), "error": rec.error})
        return rec

    def check_abort(self) -> bool:
        return bool(self._aborts.pop(0)) if self._aborts else False

    def run(self, skill_name: str, params: dict, version: Any = None) -> SkillResult:
        return SkillResult(skill_name=skill_name, success=True, data={})


STEPS: dict[str, Any] = {}
CASES: dict[str, Any] = {}


def steps_case(name: str, start: float, end: float, slew: float, interval: float) -> None:
    """`_compute_steps` 单独一格 —— 浮点要逐位对。"""
    got = SetBiasRamp()._compute_steps(start, end, slew, interval)
    STEPS[name] = {
        "start_v": start, "end_v": end, "slew": slew, "step_interval_s": interval,
        "targets": [float(v) for v in got],
        "n": len(got),
    }


def case(name: str, params: dict[str, Any], **ctx_kw: Any) -> None:
    for f in _sidecar_dir().glob("*"):
        f.unlink(missing_ok=True)
    _CLOCK[0] = 1_000_000.0
    ctx = _ScriptCtx(**ctx_kw)
    res = SetBiasRamp().run_composite(ctx, dict(params))
    data = dict(res.data or {})
    prog = data.pop("_progress", None)
    CASES[name] = {
        "params": _plain(params),
        "success": res.success,
        "error": res.error or "",
        "data": _plain(data),
        "progress": _plain(prog),
        "calls": ctx.calls,
        "verbs": [c["verb"] for c in ctx.calls],
        "set_targets": [c["args"][0] for c in ctx.calls if c["verb"] == "Bias_Set"],
    }


# ── ① 步长网格：浮点逐位 ────────────────────────────────────────────────
steps_case("up_1v_slew1", 0.0, 1.0, 1.0, 0.1)
steps_case("down_1v", 1.0, 0.0, 1.0, 0.1)
steps_case("cross_zero", -1.0, 1.0, 1.0, 0.1)
steps_case("tiny_below_1mv", 1.0, 1.0005, 1.0, 0.1)
steps_case("exactly_1mv", 1.0, 1.001, 1.0, 0.1)
steps_case("no_change", 0.5, 0.5, 1.0, 0.1)
steps_case("fast_slew_one_step", 0.0, 0.05, 100.0, 0.1)
steps_case("slow_slew_many", 0.0, 2.0, 0.05, 0.1)
steps_case("odd_divisor", 0.0, 0.3, 1.0, 0.1)
steps_case("long_interval", 0.0, 1.0, 1.0, 1.0)
steps_case("negative_target", 0.2, -0.8, 1.0, 0.1)
steps_case("float_repeating", 0.0, 1.0, 3.0, 0.1)

# ── ② 端到端 ────────────────────────────────────────────────────────────
case("start_given", {"bias_v_end": 1.0, "bias_v_start": 0.0})
case("start_read_from_instrument", {"bias_v_end": 2.0}, bias=("", b"", [1.0]))
case("single_shot_below_1mv", {"bias_v_end": 1.0005, "bias_v_start": 1.0})
case("slow_slew", {"bias_v_end": 1.0, "bias_v_start": 0.0, "slew_rate_v_per_s": 0.2})
case("custom_interval", {"bias_v_end": 1.0, "bias_v_start": 0.0, "step_interval_s": 0.5})
# 读不到就**拒绝**，不要编一个 0.0 起点
case("bias_get_fails", {"bias_v_end": 1.0}, bias="模拟故障：连接被对端关闭")
case("bias_get_unparseable", {"bias_v_end": 1.0}, bias=("", b"", []))
case("bias_get_nan", {"bias_v_end": 1.0}, bias=("", b"", [float("nan")]))
# 中途一步写失败 ⇒ 整条 ramp 中止（步骤都是 optional=False）
case("set_fails_midway", {"bias_v_end": 1.0, "bias_v_start": 0.0}, errors={3: "模拟故障：写偏压失败"})
case("set_fails_first", {"bias_v_end": 1.0, "bias_v_start": 0.0}, errors={0: "模拟故障：写偏压失败"})
# 中止
case("abort_before_first_step", {"bias_v_end": 1.0, "bias_v_start": 0.0}, aborts=[True])
case("abort_midway", {"bias_v_end": 1.0, "bias_v_start": 0.0},
     aborts=[False, False, False, True])
case("abort_before_get_current", {"bias_v_end": 1.0}, aborts=[True])


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_bias_ramp.py 生成——驱动旧仓真实"
                 " SetBiasRamp 录得，不要手改。",
        "constants": {
            "phase_get_current": "_phase_get_current",
            "phase_ramp_step_prefix": "_phase_set_step_",
            "single_shot_threshold_v": 0.001,
            "default_slew_v_per_s": 1.0,
            "default_step_interval_s": 0.1,
        },
        "compute_steps": STEPS,
        "cases": CASES,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(STEPS)} 格步长 · {len(CASES)} 个端到端")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
