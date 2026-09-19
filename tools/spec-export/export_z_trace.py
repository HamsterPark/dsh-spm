r"""z(t) 跳变判定 —— **逐格驱动旧仓 `mast/io/z_trace.py` 的真实现**。

通用驱动器（`export_skill_traces.py`）在这一族上只走得到**一条**路：合成回包给的
电流与 Z 都是常数 0.25，于是每一趟录到的都是「基线没噪声、Δz 恒为 0、电流从没
升上去」——判定输出 `none` / `no_press`，而这个模块里**真正要紧的每一条判据
一格都没到**：

* 四段结构本身（第三段按构造等于基线，只有第四段说得出结果）；
* `too_short` / `no_return` 这两条「**判不了**，而不是没扎上」的出口，
  以及它们各自那句**具体的**下一步；
* 后窗被一次超长往返饿死时的**按点数兜底**；
* MAD 估噪声退化到标准差的那一支；
* `detect_jumps` 的三级阈值回落（σ>0 → median → 1e-30）。

所以这一份是**第二台驱动器**：手搭曲线，一条判据一格。两份金样的价值在于它们
**不一样** —— 那一份录的是「常数信号上会怎样」，这一份录的是「每一条判据分别
说什么」。

合成数据说明：这里的曲线是**按物理形状手搭的**，不是真机记录。数量级取自旧仓
文档里写下来的真机观测（第二段电流饱和约 ×50–100、第四段 Δz ≈ +269 pm、
第四段中位时长 0.012 s），但每一个点都是这个脚本算出来的。

    python \
        tools/spec-export/export_z_trace.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

# 旧仓是**只读规格书**。`project_root()` 读不到 MAST2_PROJECT_ROOT 就退回仓根 ——
# 于是任何一处 `_save_*` / 缓存 / 日志都会落进旧仓。这台导出器 import 的是
# `mast.io.z_trace` 与 `tip_shaper_readback`，**41 台里唯独它裸着 import 而没钉**
# （2026-09-19 核出来的；另三台没钉是因为它们根本不 import mast）。
# 补上之后实测重跑逐字节相同 —— 也就是说这道钉子今天什么都没挡住，
# **而它存在的理由正是「今天没挡住」不等于「明天不会」。**
os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-z-trace-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "z_trace.json"

sys.path.insert(0, str(MAST_ROOT))

from mast.io import z_trace  # noqa: E402
from mast.skills.builtins.tip_shaper_readback import (  # noqa: E402
    _stage_boundaries,
    _three_step_verdict,
)


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            raise ValueError(f"金样里出现了非有限浮点：{v!r}")
        return v
    return str(v)


# ════════════════════════════════════════════════════════════════════════════
# 曲线工厂 —— 每一段的**形状**都写在名字里
# ════════════════════════════════════════════════════════════════════════════


def ramp(t0: float, t1: float, dt: float) -> list[float]:
    """`[t0, t1)` 上等间隔的时刻表。**用整数步累加**，不用浮点累加。"""
    n = int(round((t1 - t0) / dt))
    return [t0 + i * dt for i in range(n)]


def wobble(n: int, amp: float) -> list[float]:
    """确定性的「噪声」：一个不整除周期的锯齿。**不用随机数** —— 金样要可复现。"""
    return [amp * (((i * 7) % 11) / 5.0 - 1.0) for i in range(n)]


def four_segment(*, seg4_s: float, step_m: float, dt: float = 0.002,
                 baseline_s: float = 0.20, plunge_s: float = 0.05,
                 ramp_back_s: float = 0.20, noise_m: float = 2e-12,
                 setpoint_a: float = 100e-12, saturated_a: float = 10e-9
                 ) -> dict:
    """扎针一发的四段曲线。

    ========  ===========================  ==============================
    段        Z                            电流
    ========  ===========================  ==============================
    1 基线    0（+噪声）                   = setpoint
    2 压入    −2 nm                        饱和（×100）
    3 抬回    **0 —— 按构造等于基线**      **仍饱和**
    4 新平衡  step_m                       回到 setpoint
    ========  ===========================  ==============================

    第三段等于基线不是巧合，是**固件把 Z 放回命令位置**。判定若落在这一段上，
    Δz 恒为 0 ⇒ 输出「没扎上」，而针尖上可能刚长出一个 2 nm 的团簇。
    """
    t_all: list[float] = []
    z: list[float] = []
    cur: list[float] = []
    t = 0.0
    for dur, zval, ival in (
        (baseline_s, 0.0, setpoint_a),
        (plunge_s, -2e-9, saturated_a),
        (ramp_back_s, 0.0, saturated_a),
        (seg4_s, step_m, setpoint_a),
    ):
        ts = ramp(t, t + dur, dt)
        w = wobble(len(ts), noise_m)
        t_all.extend(ts)
        z.extend(zval + w[i] for i in range(len(ts)))
        cur.extend([ival] * len(ts))
        t = t + dur
    return {
        "samples": z, "times": t_all, "current_s": cur, "current_t": list(t_all),
        "event_start_t": baseline_s,
    }


# ════════════════════════════════════════════════════════════════════════════
# 格子
# ════════════════════════════════════════════════════════════════════════════

#: 一段有噪声的基线（MAD 那条路要它）。
NOISY = [1e-9 + x for x in wobble(16, 5e-12)]
#: 一段**量化到同一台阶**的基线 —— MAD 精确为 0，容差会塌成 0。退化保护就是为它。
QUANTISED = [1e-9] * 16
#: 一段在**缓慢爬升**的基线：直接取标准差会把漂移当噪声。
DRIFTING = [1e-9 + 3e-12 * i + w for i, w in enumerate(wobble(16, 4e-13))]


def scalar_cases() -> dict:
    out: dict[str, Any] = {}
    for name, xs in (
        ("empty", []),
        ("one", [1.5]),
        ("two", [1.0, 2.0]),
        ("three", [3.0, 1.0, 2.0]),
        ("four_even", [4.0, 1.0, 3.0, 2.0]),
        ("noisy", NOISY),
        ("quantised", QUANTISED),
        ("drifting", DRIFTING),
    ):
        out[name] = {
            "xs": list(xs),
            "median": z_trace._median(xs),
            "std": z_trace._std(xs),
            "mad_diff_sigma": z_trace._mad_diff_sigma(xs),
            "baseline_sigma": z_trace.baseline_sigma(xs),
        }
    return out


def max_gap_cases() -> list[dict]:
    return [
        {"name": "empty", "times": [], "out": z_trace._max_gap([])},
        {"name": "one", "times": [0.1], "out": z_trace._max_gap([0.1])},
        {
            "name": "one_long_roundtrip",
            "times": [0.0, 0.001, 0.002, 0.124, 0.125],
            "out": z_trace._max_gap([0.0, 0.001, 0.002, 0.124, 0.125]),
        },
    ]


def jump_cases() -> list[dict]:
    cases = [
        # 样本不足三个 ⇒ 空报告（没有差分可言）
        ("too_few", [1.0, 2.0], [0.0, 0.1], z_trace.DEFAULT_JUMP_K),
        # 常数 ⇒ med=0、σ=0 ⇒ 阈值回落到 1e-30；而 |Δ|=0 不大于它 ⇒ 无事件
        ("flat", [0.25] * 8, [0.001 * i for i in range(8)], z_trace.DEFAULT_JUMP_K),
        # 等间隔斜坡 ⇒ σ=0 但 med>0 ⇒ 阈值回落到 med，斜坡自己不算跳变
        ("clean_ramp", [float(i) for i in range(8)], [0.001 * i for i in range(8)],
         z_trace.DEFAULT_JUMP_K),
        # 一记真阶跃埋在平地里
        ("one_step", [0.0] * 5 + [10.0] * 5, [0.001 * i for i in range(10)],
         z_trace.DEFAULT_JUMP_K),
        # 同一条曲线，k 放到 50 ⇒ **仍然抓得到**（σ=0 时阈值是 k·1e-30）
        ("one_step_k50", [0.0] * 5 + [10.0] * 5, [0.001 * i for i in range(10)], 50.0),
        # 噪声地板上的一记小阶跃：σ>0 那条主路
        ("step_in_noise",
         [1e-9 + w for w in wobble(10, 5e-12)] + [1.5e-9 + w for w in wobble(10, 5e-12)],
         [0.001 * i for i in range(20)], z_trace.DEFAULT_JUMP_K),
    ]
    return [
        {"name": n, "samples": list(s), "times": list(t), "k": k,
         "out": _plain(z_trace.detect_jumps(s, t, k))}
        for n, s, t, k in cases
    ]


def feedback_cases() -> list[dict]:
    dt = 0.002
    base_t = ramp(0.0, 0.2, dt)
    out = []

    def rec(name: str, cs: list[float], ct: list[float], ev: float) -> None:
        t4, why = z_trace.feedback_restored_t(cs, ct, event_start_t=ev)
        out.append({"name": name, "current_s": list(cs), "current_t": list(ct),
                    "event_start_t": ev, "t": t4, "why": why})

    rec("too_few_samples", [1e-10] * 3, [0.0, 0.1, 0.2], 0.05)
    # 事件在最前面 ⇒ 基线段一个点都没有
    rec("no_baseline", [1e-10] * 8, [0.001 * i for i in range(8)], 0.0)
    # 基线电流恒为 0 ⇒ i0 不是正数，相对判据无从谈起
    rec("zero_baseline_current", [0.0] * 8, [0.001 * i for i in range(8)], 0.004)
    c = four_segment(seg4_s=0.3, step_m=269e-12)
    rec("current_located", c["current_s"], c["current_t"], c["event_start_t"])
    # 电流升上去了、再没回来 ⇒ 采集在反馈接管**之前**就结束了
    n_base = len(base_t)
    rec("no_return",
        [100e-12] * n_base + [10e-9] * 50,
        base_t + ramp(0.2, 0.3, dt),
        0.2)
    # 电流从没升上去 ⇒ 这一发可能根本没压到表面
    rec("no_press",
        [100e-12] * (n_base + 50),
        base_t + ramp(0.2, 0.3, dt),
        0.2)
    return out


def step_cases() -> list[dict]:
    out: list[dict] = []

    def rec(name: str, note: str, samples: list[float], times: list[float],
            event_start_t: float | None, **kw: Any) -> None:
        got = z_trace.step_verdict(samples, times, event_start_t, **kw)
        entry: dict[str, Any] = {
            "name": name,
            "note": note,
            "samples": list(samples),
            "times": list(times),
            "event_start_t": event_start_t,
            "post_roll_s": kw["post_roll_s"],
            "tol_k": kw.get("tol_k", 4.0),
            "tol_abs_m": kw.get("tol_abs_m", 0.0),
            "with_current": kw.get("current_s") is not None,
            "out": _plain(got),
        }
        if kw.get("current_s") is not None:
            entry["current_s"] = list(kw["current_s"])
            entry["current_t"] = list(kw["current_t"])
        out.append(entry)

    dt = 0.002

    # ── 早退 ────────────────────────────────────────────────────────────────
    rec("no_event", "没有事件时刻 ⇒ 判不了，但**最长往返照算**",
        [1e-9] * 8, [dt * i for i in range(8)], None, post_roll_s=0.1)
    rec("too_few_samples", "少于 4 个样本",
        [1e-9, 1e-9, 1e-9], [0.0, dt, 2 * dt], 0.001, post_roll_s=0.1)
    rec("no_pre", "**前窗刻意不兜底**：基线真的不够就是判不了",
        [1e-9] * 8, [dt * i for i in range(8)], 0.0, post_roll_s=0.1)

    # ── 后窗被一次超长往返饿死 ──────────────────────────────────────────────
    starved_t = [dt * i for i in range(20)] + [10.0]
    starved_z = [1e-9 + w for w in wobble(20, 2e-12)] + [1e-9]
    rec("post_window_starved",
        "一次 10 秒的往返把尾窗清空 ⇒ **往回够到下限**，并把这件事标出来",
        starved_z, starved_t, 0.02, post_roll_s=0.1)

    # ── 没有电流通道：退回尾窗 ──────────────────────────────────────────────
    for name, step, note in (
        ("tail_none", 0.0, "尾窗、没跳"),
        ("tail_up", 5e-10, "尾窗、向上"),
        ("tail_down", -5e-10, "尾窗、向下"),
    ):
        t = [dt * i for i in range(60)]
        z = [(1e-9 if x < 0.06 else 1e-9 + step) + w
             for x, w in zip(t, wobble(60, 2e-12))]
        rec(name, note, z, t, 0.06, post_roll_s=0.04, tol_abs_m=2e-11)

    # 容差的两侧：`tol = max(tol_abs_m, tol_k·σ)`
    t = [dt * i for i in range(60)]
    z = [(1e-9 if x < 0.06 else 1e-9 + 3e-11) + w
         for x, w in zip(t, wobble(60, 2e-12))]
    rec("tol_abs_swallows", "绝对死区吃掉一个 30 pm 的台阶 ⇒ `none`",
        z, t, 0.06, post_roll_s=0.04, tol_abs_m=5e-11)
    rec("tol_k_dominates", "σ 撑起来的容差比绝对死区大 ⇒ 由它说了算",
        z, t, 0.06, post_roll_s=0.04, tol_abs_m=0.0, tol_k=4.0)

    # ── 四段曲线：**这一族的要害** ──────────────────────────────────────────
    real = four_segment(seg4_s=0.35, step_m=269e-12)
    rec("seg4_located", "第四段够长 ⇒ 电流定位，读到真正的 +269 pm",
        real["samples"], real["times"], real["event_start_t"],
        post_roll_s=0.1, tol_abs_m=2e-11,
        current_s=real["current_s"], current_t=real["current_t"])

    # 2026-08-20 的真形状：第四段中位只有 0.012 s
    short = four_segment(seg4_s=0.012, step_m=269e-12)
    rec("seg4_too_short_with_current",
        "第四段只有 12 ms（168 条历史曲线的中位）⇒ **判不了**，并说清下一步",
        short["samples"], short["times"], short["event_start_t"],
        post_roll_s=0.1, tol_abs_m=2e-11,
        current_s=short["current_s"], current_t=short["current_t"])
    rec("seg4_too_short_without_current",
        "**同一条曲线**，不给电流 ⇒ 尾窗骑在第三段上，Δz≈0 ⇒ 「没扎上」。"
        "真簇被这样判掉了 62%",
        short["samples"], short["times"], short["event_start_t"],
        post_roll_s=0.1, tol_abs_m=2e-11)

    # `%.3f` 的半分点：seg4_s 正好是 1/16 —— Python 走 round-half-even ⇒ `0.062`
    sixteenth = four_segment(seg4_s=0.0625, step_m=269e-12, dt=0.0009765625,
                             baseline_s=0.25, plunge_s=0.0625, ramp_back_s=0.25)
    rec("seg4_exact_sixteenth",
        "`seg4_s` 正好 0.0625 ⇒ `\"%.3f\"` 落在**半分点**上（Python 取偶：0.062）",
        sixteenth["samples"], sixteenth["times"], sixteenth["event_start_t"],
        post_roll_s=0.1, tol_abs_m=2e-11,
        current_s=sixteenth["current_s"], current_t=sixteenth["current_t"])

    # 电流升上去了、再没回来 ⇒ 整条曲线只有第一到第三段
    no_ret = four_segment(seg4_s=0.0, step_m=0.0)
    rec("seg4_not_captured",
        "电流再没回到 setpoint ⇒ 采集在反馈接管之前就结束了 ⇒ **判不了**",
        no_ret["samples"], no_ret["times"], no_ret["event_start_t"],
        post_roll_s=0.1, tol_abs_m=2e-11,
        current_s=no_ret["current_s"], current_t=no_ret["current_t"])

    # 电流从没升上去 ⇒ 尾窗照判（可能就是「没扎上」，而那是实话）
    flat_cur = four_segment(seg4_s=0.35, step_m=0.0)
    flat_cur["current_s"] = [100e-12] * len(flat_cur["current_s"])
    rec("no_press_tail_ok",
        "电流从没升上去 ⇒ 可能根本没压到表面；尾窗照判",
        flat_cur["samples"], flat_cur["times"], flat_cur["event_start_t"],
        post_roll_s=0.1, tol_abs_m=2e-11,
        current_s=flat_cur["current_s"], current_t=flat_cur["current_t"])

    return out


def indent_cases() -> list[dict]:
    """扎针那一层的读法 —— 剥掉 `direction`/`z_max_m`，换成本层的词汇。"""
    out = []
    specs = [
        ("cluster", four_segment(seg4_s=0.35, step_m=269e-12)),
        ("tip_changed_or_pit", four_segment(seg4_s=0.35, step_m=-269e-12)),
        ("no_change", four_segment(seg4_s=0.35, step_m=0.0)),
        ("insufficient_too_short", four_segment(seg4_s=0.012, step_m=269e-12)),
    ]
    for name, c in specs:
        got = _three_step_verdict(
            c["samples"], c["times"], c["event_start_t"],
            post_roll_s=0.1, tol_abs_m=2e-11,
            current_s=c["current_s"], current_t=c["current_t"])
        out.append({"name": name, "samples": list(c["samples"]),
                    "times": list(c["times"]), "current_s": list(c["current_s"]),
                    "current_t": list(c["current_t"]),
                    "event_start_t": c["event_start_t"],
                    "post_roll_s": 0.1, "tol_abs_m": 2e-11, "tol_k": 4.0,
                    "out": _plain(got)})
    # 判不了、而且**连电流通道都没有** ⇒ advice 回落到「没扎上」那一句（setdefault）
    got = _three_step_verdict([1e-9] * 8, [0.002 * i for i in range(8)], None,
                              post_roll_s=0.1)
    out.append({"name": "insufficient_no_event", "samples": [1e-9] * 8,
                "times": [0.002 * i for i in range(8)], "current_s": None,
                "current_t": None, "event_start_t": None,
                "post_roll_s": 0.1, "tol_abs_m": 0.0, "tol_k": 4.0,
                "out": _plain(got)})
    return out


def stage_cases() -> list[dict]:
    p = {"switch_off_delay_s": 0.01, "lift_time_1_s": 0.02,
         "bias_settling_s": 0.03, "lift_time_2_s": 0.04, "end_wait_s": 0.05}
    return [
        {"name": "no_start", "shaper_start_t": None, "params": {},
         "out": _plain(_stage_boundaries(None, {}))},
        {"name": "defaults", "shaper_start_t": 0.05, "params": {},
         "out": _plain(_stage_boundaries(0.05, {}))},
        {"name": "explicit", "shaper_start_t": 0.05, "params": p,
         "out": _plain(_stage_boundaries(0.05, p))},
    ]


def main() -> int:
    payload = {
        "constants": {
            "DEFAULT_JUMP_K": z_trace.DEFAULT_JUMP_K,
            "MIN_SAMPLES_FOR_MAD": z_trace._MIN_SAMPLES_FOR_MAD,
            "MIN_WINDOW_SAMPLES": z_trace._MIN_WINDOW_SAMPLES,
            "MIN_FEEDBACK_SEGMENT_S": z_trace._MIN_FEEDBACK_SEGMENT_S,
            "CURRENT_BACK_K": z_trace._CURRENT_BACK_K,
            "CURRENT_PRESSED_K": z_trace._CURRENT_PRESSED_K,
        },
        "scalars": scalar_cases(),
        "max_gap": max_gap_cases(),
        "detect_jumps": jump_cases(),
        "feedback_restored_t": feedback_cases(),
        "step_verdict": step_cases(),
        "indent_verdict": indent_cases(),
        "stage_boundaries": stage_cases(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(_plain(payload), ensure_ascii=False, indent=2,
                   sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    n = (len(payload["scalars"]) + len(payload["max_gap"])
         + len(payload["detect_jumps"]) + len(payload["feedback_restored_t"])
         + len(payload["step_verdict"]) + len(payload["indent_verdict"])
         + len(payload["stage_boundaries"]))
    print(f"[ok]   z_trace.json: {n} 格")
    for c in payload["step_verdict"]:
        print(f"       step/{c['name']:<32} → {c['out'].get('direction')}"
              f" {c['out'].get('feedback_segment_source', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
