"""批 5b 的**判据**金样 —— 让旧仓那九个技能真的跑一遍，每条判据各走一格。

    python \\
        tools/spec-export/export_batch5b.py

## 为什么还要一台导出器（`skill_traces.json` 已经有这九个了）

那一份录的是「它在注册表里、被真调度链调得动」——通用驱动器给每个动词一个**常数**
回包、给每个子技能一个**空 data**。于是：

* `MonitorCurrentFFT` 的 999 个样本全是 `0.25` ⇒ 去趋势之后整条是 0 ⇒
  **录到的谱是 500 个零**。窗、`rfft`、单边归一化，一条都没被验到；
* `ClassifyUnexplainedCurrent` 卡在「读不到反馈状态」那一支 ⇒ 判别表**六个结论**
  一个都没走到；
* `RecoverTipFromSaturation` 卡在「读不到电流」⇒ 退针阶梯一级都没走；
* `WaitForThermalSettle` 连续五次读不到 ⇒ `polyfit` 一次都没跑；
* `BatchRegionsScan` 的 `regions` 是 `'spec-export'` ⇒ 连计划都没排出来。

**一格分辨不出两种候选的金样不是判据。** 所以这台导出器的整个设计就一句话：
**脚本化上下文** —— 每个动词、每个子技能的回答都由用例自己给，于是每一道闸
都有一格**专门为它造的**输入。

## 三条纪律（前两条同 `export_analysis.py` / `export_paper_data.py`）

1. **输入与答案一起录**，而合成用的是闭式公式或**真机记下来的那几个数**
   （08-27 的降温序列、08-28 的 I(V) 三点），不是随机数 ⇒ 重跑逐字节相同；
2. 墙钟与随机数一概不进：时间桩与 `export_skill_traces.py` **同一套**
   （1e6 秒起、每读一次 +1e-3、`sleep` 往前拨），于是轮询循环的**拍数**
   与那一份对得上，TS 那侧同一个夹具能复现；
3. **脚本本身进金样**。TS 那侧拿同一份脚本喂同一个技能 —— 两边不是「各自造一份
   差不多的输入」（那本身就是一处没人在看的差异，批 4a §4 那一课）。

## 时钟派生的字段单独标出来

两侧的假钟摆在不同量级上（那边 1e6 **秒**、这边 1e6 **毫秒**），差在第 10 位。
每个用例带一个 `clock_keys`：这几个叶子按相对 1e-6 比，**其余逐位**。
判据字段一个都不在里面。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-b5b-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "batch5b.json"

# ── 时间桩：与 `export_skill_traces.py` **同一套**（见抬头纪律 2）──
import time as _time

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


def _fake_time() -> float:
    return 1_700_000_000.0


_time.time = _fake_time            # type: ignore[assignment]
_time.sleep = _fake_sleep          # type: ignore[assignment]
_time.monotonic = _fake_monotonic  # type: ignore[assignment]
_time.perf_counter = _fake_monotonic  # type: ignore[assignment]

sys.path.insert(0, str(MAST_ROOT))
import numpy as np  # noqa: E402
from mast.core.types import NanonisCallRecord, SkillResult  # noqa: E402
from mast.core.registry import SkillRegistry  # noqa: E402


# ──────────────────────────────────────────────────────────────────────────
# 脚本化上下文
# ──────────────────────────────────────────────────────────────────────────


def _materialise(v: Any) -> Any:
    """脚本里的 `{"__nd__": [[…]]}` → `np.ndarray`。

    只有 `Scan_FrameDataGrab` 的 body 用得上：真机那一段是**异构** list
    （`[name_len, name, rows, cols, ndarray, dir]`），而 `parse_frame_grab`
    正是靠 `isinstance(el, np.ndarray)` 从里面认出那一帧的。给一份嵌套 list
    的话旧仓自己的解析器看不见它 —— 那是一个真机上不成立的形状
    （同 `export_skill_traces.py` 抬头那一段）。
    """
    if isinstance(v, dict) and "__nd__" in v:
        return np.asarray(v["__nd__"], dtype=float)
    if isinstance(v, list):
        return [_materialise(x) for x in v]
    return v


class _ScriptedContext:
    """每个动词、每个子技能的回答都由用例自己给。

    队列取完之后**重复最后一个** —— 轮询循环要调几百次同一个动词，
    而「第 300 拍与第 1 拍走的是同一条分支」（`export_skill_traces.py` 同一条）。
    """

    def __init__(self, verbs: dict[str, list], runs: dict[str, list]) -> None:
        self._verbs = {k: list(v) for k, v in verbs.items()}
        self._runs = {k: list(v) for k, v in runs.items()}
        self._vi: dict[str, int] = {}
        self._ri: dict[str, int] = {}
        self.calls: list[dict] = []
        self.run_log: list[dict] = []

    @staticmethod
    def _next(queue: list, idx: dict[str, int], key: str) -> Any:
        q = queue
        i = idx.get(key, 0)
        idx[key] = i + 1
        if not q:
            return None
        return q[min(i, len(q) - 1)]

    def safe_call(self, method_name: str, *args, **kwargs) -> NanonisCallRecord:
        if len(self.calls) > 5000:
            raise RuntimeError(f"调用预算用尽（{method_name}）—— 轮询没有出口")
        rec = NanonisCallRecord(method=method_name, args=tuple(args), kwargs=dict(kwargs))
        spec = self._next(self._verbs.get(method_name, []), self._vi, method_name)
        if spec is None:
            rec.return_value = ("", b"", [0.0])
        elif "error" in spec:
            rec.error = spec["error"]
            rec.return_value = None
        else:
            rec.return_value = ("", b"", _materialise(spec["body"]))
        self.calls.append({
            "verb": method_name,
            "args": [_jsonable(a) for a in args],
            "error": rec.error,
        })
        return rec

    def check_abort(self) -> bool:
        return False

    def run(self, skill_name: str, params: dict, version: str | None = None) -> SkillResult:
        self.run_log.append({"skill": skill_name, "params": _jsonable(params)})
        spec = self._next(self._runs.get(skill_name, []), self._ri, skill_name)
        if spec is None:
            return SkillResult(skill_name=skill_name, success=True, data={})
        return SkillResult(
            skill_name=skill_name,
            success=bool(spec.get("success", True)),
            data=dict(spec.get("data", {})),
            error=str(spec.get("error", "") or ""),
        )


def _jsonable(v: Any) -> Any:
    if isinstance(v, (str, bool)) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v
    if type(v).__name__ == "ndarray":
        return v.tolist()
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    return str(v)


def _result(r: Any) -> dict:
    return {
        "success": bool(getattr(r, "success", False)),
        "error": str(getattr(r, "error", "") or ""),
        "summary": str(getattr(r, "summary", "") or ""),
        "data": _jsonable(getattr(r, "data", None) or {}),
    }


# ──────────────────────────────────────────────────────────────────────────
# 合成输入（**闭式公式或真机数字，零随机**）
# ──────────────────────────────────────────────────────────────────────────

def two_tone(n: int, fs: float) -> list[float]:
    """两个音 + 一个直流台阶。**闭式**，于是重跑逐字节相同。

    * 50 Hz 幅度 3e-11 A —— 市电那一条，`MonitorCurrentFFT` 的头号用户；
    * 137 Hz 幅度 1e-11 A —— 一个非整周期的频率，用来**逼出泄漏**：
      只放整周期音的话，加不加窗谱都一样干净，于是「窗」那一档分辨不出两种候选；
    * 直流 2e-10 A —— `detrend` 那一档的判据（不去趋势时它会把零频撑满）。
    """
    out = []
    for k in range(n):
        t = k / fs
        out.append(
            2e-10
            + 3e-11 * np.sin(2.0 * np.pi * 50.0 * t)
            + 1e-11 * np.sin(2.0 * np.pi * 137.0 * t + 0.7)
        )
    return [float(x) for x in out]


def ramp_with_contact(n: int) -> list[float]:
    """第 20–21 点跳到接触量级，**第 22 点掉回去**，第 23 点起一直高。

    那一次掉回去**落在第一段连读中间**，这是为 `min_contact_samples` 的
    「**连续** 3 次」造的：

    | 判据 | 第几点置位 |
    |---|---|
    | 连续 3 次（对的那个） | 25（23/24/25） |
    | 累计 3 次（拆掉之后） | 23（20/21/23） |

    第一版把掉回去放在第 24–25 点 —— 那时 20/21/22 已经连满三次，
    两种判据给的是**同一个答案**，于是那一格分辨不出两种候选，
    一条本该变红的变异会是绿的（批 4a §9② 那一课）。

    第 5 点是**负的**（−3e−11 A）：`min/max/mean/std` 报的是 `|I|`，而
    `signed_min_a` / `signed_max_a` 报的是原值。全是正数的话这两组恒等，
    「统计量算在绝对值上」这道闸就分辨不出两种候选。
    """
    out = []
    for k in range(n):
        if k == 5:
            v = -3e-11
        elif k < 20:
            v = 1e-11 + 1e-13 * k
        elif k == 22:
            v = 2e-11
        else:
            v = 8e-8 + 1e-10 * k
        out.append(float(v))
    return out


#: 2026-08-27 换样品之后**真机记下来的**降温序列（s, K）。
#: 抬头那张表逐字：到 +577 s 才降到 −0.02 K/min。
COOLDOWN = [
    (0.0, 36.646), (12.0, 35.669), (24.0, 34.447), (85.0, 28.582),
    (301.0, 5.331), (401.0, 4.493), (502.0, 4.363), (577.0, 4.349),
    (602.0, 4.347), (627.0, 4.3465), (652.0, 4.346), (677.0, 4.3458),
]

#: 2026-08-28 那次横移拦截的三点 I(V)（V, A）。
FIELD_EMISSION = [(2.0, 111.65e-12), (1.0, 0.13e-12), (0.0, -0.01e-12)]


def _frame_body(rows: list[list[float]], name: str = "Z") -> list:
    """真机 `Scan_FrameDataGrab` 的 body 形状：异构 list，第 5 位是那张图。"""
    return [len(name), name, len(rows), len(rows[0]), {"__nd__": rows}, 1]


def _buffer_body(channels: list[int], pixels: int, lines: int) -> list:
    return [len(channels), channels, pixels, lines]


def watch_frame(n_rows: int, n_cols: int, done: int, *,
                flat_last: bool = True, alternate_phase: bool = False,
                period: int = 8, amp: float = 2e-11) -> list[list[float]]:
    """一张**扫到一半**的帧：前 `done` 行有数据，其余全零（真机就是这样）。

    有数据的那几行是 `行基线 + 一条闭式正弦`，于是行间相关很高（~1）。

    两个开关各为一道闸而造：

    * `flat_last` —— 最后一行**故意平掉**（每个点都等于该行极值）⇒ 触顶那一条；
    * `alternate_phase` —— 奇数行把正弦**取反** ⇒ 行间相关掉到 −1，
      于是 `CORR_HINT` 那一条（`corr < 0.5`）才有一格走得到。
      没有它，全仓没有任何一格分得开「有这道提醒」与「没有这道提醒」。

    ⚠️ 触顶那一条的阈值是 `sat > 0.02`，而**每一行至少有一个 max 和一个 min**
    贴着自己 —— 12 列的帧上那就是 `2/12 = 0.167`，**恒大于 0.02**。
    也就是说窄帧上这条提醒永远会出现，另外两条观察永远走不到。
    要走到它们得有 ≥ 100 列、极值只被碰到一次、**而且起伏远大于那条容差** ——
    所以 `period` 与 `amp` 都是参数：

    | 试过的 | 触顶比例 | 为什么还是高 |
    |---|---|---|
    | 128 列，`sin(2πc/8)` | 0.25 | 最大值被碰 **16** 次（周期只有 8 列） |
    | 128 列，整行一个周期，幅度 2e−11 | 0.203 | `_SATURATION_TOL` 是 **1e−12 绝对**，而峰附近 13 个点都落在 1e−12 以内 |
    | 128 列，整行一个周期，幅度 **2e−9** | 0.0156 | 相邻点差 2.4e−12 > 容差 ⇒ 只有真正的那两个极值 |

    第三行才是这条观察的**设计工作点**：`_SATURATION_TOL` 是绝对的，
    所以它只在「起伏 ≫ 1 pm」的帧上说得出话 —— 这本身就是一条要写下来的事实。
    见 `watch/wide_*` 两格。
    """
    rows: list[list[float]] = []
    for r in range(n_rows):
        if r >= done:
            rows.append([0.0] * n_cols)
            continue
        if flat_last and r == done - 1:
            rows.append([1e-9] * n_cols)   # 触顶：全等于自己的 max 与 min
            continue
        base = 1e-10 * r
        sign = -1.0 if (alternate_phase and r % 2 == 1) else 1.0
        rows.append([
            float(base + sign * amp * np.sin(2.0 * np.pi * c / period))
            for c in range(n_cols)
        ])
    return rows


# ──────────────────────────────────────────────────────────────────────────
# 用例表
# ──────────────────────────────────────────────────────────────────────────

def _cur(v: float | None) -> dict:
    """一次 `GetCurrent` 的回答。`None` = 读不到（`data` 里没有 `current_a`）。"""
    return {"success": True, "data": {} if v is None else {"current_a": v}}


def _iv_runs(points: list[tuple[float, float]], repeats: int, first: float) -> list[dict]:
    """`ClassifyUnexplainedCurrent` 的 `GetCurrent` 队列。

    顺序：先 `repeats` 次「饱和预检」，然后**每个偏压** `repeats` 次。
    偏压的顺序是技能自己排的（按 |V| 从大到小），所以这里按同一条排。
    """
    out = [_cur(first)] * repeats
    for _v, i in sorted(points, key=lambda p: -abs(p[0])):
        out += [_cur(i)] * repeats
    return out


def _classify_case(name: str, points: list[tuple[float, float]], *,
                   first: float = 1e-12, params: dict | None = None,
                   fb_on: bool = True) -> dict:
    repeats = 3
    p = {"test_biases_v": ",".join(f"{v:g}" for v, _ in points), "repeats": repeats}
    if params:
        p.update(params)
    return {
        "name": name,
        "skill": "ClassifyUnexplainedCurrent",
        "params": p,
        "verbs": {},
        "runs": {
            "GetCurrent": _iv_runs(points, repeats, first),
            "GetBias": [{"success": True, "data": {"bias_v": 1.0}}],
            "GetZControllerState": [{"success": True, "data": {"controller_on": fb_on}}],
            "ZControllerOnOff": [
                {"success": True, "data": {"verified": True, "z_controller_on": False}},
                {"success": True, "data": {"verified": True, "z_controller_on": fb_on}},
            ],
            "SetBias": [{"success": True, "data": {}}],
        },
        "clock_keys": [],
    }


def _cases() -> list[dict]:
    cases: list[dict] = []

    # ── MonitorCurrent ────────────────────────────────────────────────────
    n_poll = 120
    cases.append({
        "name": "monitor_current/contact_streak",
        "skill": "MonitorCurrent",
        "params": {"duration_s": 1.0, "poll_hz": 100.0,
                   "contact_threshold_a": 5e-8, "min_contact_samples": 3},
        "verbs": {"Current_Get": [{"body": [v]} for v in ramp_with_contact(n_poll)]},
        "runs": {},
        "clock_keys": ["timestamps_s", "actual_duration_s", "contact_at_s"],
    })
    cases.append({
        "name": "monitor_current/never_touches",
        "skill": "MonitorCurrent",
        "params": {"duration_s": 1.0, "poll_hz": 100.0,
                   "contact_threshold_a": 1e-3, "min_contact_samples": 3},
        "verbs": {"Current_Get": [{"body": [v]} for v in ramp_with_contact(n_poll)]},
        "runs": {},
        "clock_keys": ["timestamps_s", "actual_duration_s", "contact_at_s"],
    })
    cases.append({
        # 每拍 50 ms ≫ 10 ms 的睡眠上限 ⇒ 一拍要睡好几觉，而**中止检查**就发生在
        # 那几觉之间。上限那道闸只有在这一格上才分辨得出两种候选
        # （`poll_hz = 100` 时 `nextPoll − now` 从来不超过 10 ms，上限永远不生效）。
        "name": "monitor_current/slow_poll_sleeps_in_slices",
        "skill": "MonitorCurrent",
        "params": {"duration_s": 1.0, "poll_hz": 20.0,
                   "contact_threshold_a": 5e-8, "min_contact_samples": 3},
        "verbs": {"Current_Get": [{"body": [v]} for v in ramp_with_contact(n_poll)]},
        "runs": {},
        "clock_keys": ["timestamps_s", "actual_duration_s", "contact_at_s"],
    })
    cases.append({
        "name": "monitor_current/all_calls_fail",
        "skill": "MonitorCurrent",
        "params": {"duration_s": 1.0, "poll_hz": 100.0},
        "verbs": {"Current_Get": [{"error": "模拟故障：连接被对端关闭"}]},
        "runs": {},
        "clock_keys": [],
    })

    # ── MonitorCurrentFFT ─────────────────────────────────────────────────
    tones = [{"body": [v]} for v in two_tone(1100, 1000.0)]
    for win in ("hann", "hamming", "rect"):
        cases.append({
            "name": f"monitor_fft/{win}",
            "skill": "MonitorCurrentFFT",
            "params": {"duration_s": 1.0, "poll_hz": 1000.0, "window": win,
                       "detrend": True, "output": "magnitude"},
            "verbs": {"Current_Get": tones},
            "runs": {},
            "clock_keys": ["actual_duration_s", "actual_fs_hz", "nyquist_hz",
                           "df_hz", "freqs_hz"],
        })
    cases.append({
        "name": "monitor_fft/no_detrend",
        "skill": "MonitorCurrentFFT",
        "params": {"duration_s": 1.0, "poll_hz": 1000.0, "window": "hann",
                   "detrend": False, "output": "magnitude"},
        "verbs": {"Current_Get": tones},
        "runs": {},
        "clock_keys": ["actual_duration_s", "actual_fs_hz", "nyquist_hz",
                       "df_hz", "freqs_hz"],
    })
    cases.append({
        "name": "monitor_fft/power",
        "skill": "MonitorCurrentFFT",
        "params": {"duration_s": 1.0, "poll_hz": 1000.0, "window": "hann",
                   "detrend": True, "output": "power"},
        "verbs": {"Current_Get": tones},
        "runs": {},
        # ⚠️ `spectrum` **不进 `clock_keys`**：那条按 `max(1, |a|)` 归一的相对容差
        # 在 1e-22 量级的 PSD 上退化成「绝对 1e-6」—— 也就是什么都不判。
        # 谱由 TS 那侧单独一条容差比（见 `batch5b.test.ts` 的 `spectrumTol`）。
        "clock_keys": ["actual_duration_s", "actual_fs_hz", "nyquist_hz",
                       "df_hz", "freqs_hz"],
    })
    cases.append({
        "name": "monitor_fft/too_few_samples",
        "skill": "MonitorCurrentFFT",
        "params": {"duration_s": 0.05, "poll_hz": 10.0},
        "verbs": {"Current_Get": tones},
        "runs": {},
        "clock_keys": [],
    })

    # ── ClassifyUnexplainedCurrent：判别表逐格 ────────────────────────────
    cases.append(_classify_case("classify/field_emission", FIELD_EMISSION))
    cases.append(_classify_case(
        "classify/junction_current",
        [(2.0, 2.4e-10), (1.0, 1.2e-10), (0.5, 6e-11), (0.0, 1e-14)]))
    cases.append(_classify_case(
        # 0 V 脏、而最大偏压也只有它的 1.5 倍 ⇒ 比值那一条（**不靠拟合**）
        "classify/flat_ratio_crosstalk",
        [(2.0, 1.5e-11), (1.0, 1.2e-11), (0.0, 1.0e-11)]))
    cases.append(_classify_case(
        # 0 V 脏、比值够大、指数也够大 ⇒ 一个真结叠在一个偏置上
        "classify/mixed",
        [(2.0, 4.0e-10), (1.0, 1.0e-10), (0.5, 3.0e-11), (0.0, 1.0e-11)]))
    cases.append(_classify_case(
        # 所有点都在绝对底线以下
        "classify/no_measurable_current",
        [(2.0, 1e-15), (1.0, 1e-15), (0.0, 1e-16)]))
    cases.append(_classify_case(
        # 0 V 那一点读不到 ⇒ **判别点缺席**
        "classify/zero_unreadable",
        [(2.0, 1.1e-10), (1.0, 5e-11), (0.0, None)]))  # type: ignore[list-item]
    cases.append(_classify_case(
        "classify/transient", FIELD_EMISSION,
        params={"observed_current_a": 1.17e-11}))
    cases.append(_classify_case(
        "classify/saturated_short_circuit", FIELD_EMISSION, first=1.00036e-8))
    # 还原的对象是「进来时的样子」：这一格进来时反馈**是关着的**，
    # 于是收尾那一句必须是 `enable: False`。全用 `fb_on=True` 的话，
    # 「还原成初态」与「写死 True」给出同一串子技能调用。
    cases.append(_classify_case(
        "classify/feedback_was_off", FIELD_EMISSION, fb_on=False))
    # `test_biases_v` 里**没有** 0 ⇒ 技能自己补一个，`zero_bias_added` 为真。
    cases.append({
        "name": "classify/zero_is_added",
        "skill": "ClassifyUnexplainedCurrent",
        "params": {"test_biases_v": "2.0,1.0", "repeats": 3},
        "verbs": {},
        "runs": {
            "GetCurrent": _iv_runs(
                [(2.0, 111.65e-12), (1.0, 0.13e-12), (0.0, -0.01e-12)], 3, 1e-12),
            "GetBias": [{"success": True, "data": {"bias_v": 1.0}}],
            "GetZControllerState": [{"success": True, "data": {"controller_on": True}}],
            "ZControllerOnOff": [
                {"success": True, "data": {"verified": True, "z_controller_on": False}},
                {"success": True, "data": {"verified": True, "z_controller_on": True}},
            ],
            "SetBias": [{"success": True, "data": {}}],
        },
        "clock_keys": [],
    })
    cases.append({
        "name": "classify/bad_bias_list",
        "skill": "ClassifyUnexplainedCurrent",
        "params": {"test_biases_v": "2.0,一伏,0"},
        "verbs": {}, "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "classify/empty_bias_list",
        "skill": "ClassifyUnexplainedCurrent",
        "params": {"test_biases_v": " , , "},
        "verbs": {}, "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "classify/feedback_wont_turn_off",
        "skill": "ClassifyUnexplainedCurrent",
        "params": {"test_biases_v": "2.0,0.0", "repeats": 1},
        "verbs": {},
        "runs": {
            "GetCurrent": [_cur(1e-12)],
            "GetBias": [{"success": True, "data": {"bias_v": 1.0}}],
            "GetZControllerState": [{"success": True, "data": {"controller_on": True}}],
            "ZControllerOnOff": [
                {"success": True, "data": {"verified": True, "z_controller_on": True}},
            ],
        },
        "clock_keys": [],
    })

    # ── RecoverTipFromSaturation ─────────────────────────────────────────
    sat = 1.00036e-8
    cases.append({
        "name": "recover/blocked_by_lock",
        "skill": "RecoverTipFromSaturation",
        "params": {},
        "verbs": {},
        "runs": {"MotorMove": [{"success": False, "error":
                                "仪器正被占用：技能直调 API 正在执行 ScanAt，已持有 363s"}]},
        "clock_keys": [],
    })
    cases.append({
        "name": "recover/current_unreadable",
        "skill": "RecoverTipFromSaturation",
        "params": {},
        "verbs": {},
        "runs": {"MotorMove": [{"success": True, "data": {}}],
                 "GetCurrent": [_cur(None)]},
        "clock_keys": [],
    })
    cases.append({
        "name": "recover/not_saturated",
        "skill": "RecoverTipFromSaturation",
        "params": {},
        "verbs": {},
        "runs": {"MotorMove": [{"success": True, "data": {}}],
                 "GetCurrent": [_cur(1.2e-10)]},
        "clock_keys": [],
    })
    cases.append({
        "name": "recover/piezo_withdraw_enough",
        "skill": "RecoverTipFromSaturation",
        "params": {},
        "verbs": {},
        "runs": {
            "MotorMove": [{"success": True, "data": {}}],
            # 三次预检饱和，压电退针之后三次读到 5e-11（脱离）
            "GetCurrent": [_cur(sat)] * 3 + [_cur(5e-11)],
            "SetBias": [{"success": True, "data": {}}],
            "WithdrawTip": [{"success": True, "data": {}}],
        },
        "clock_keys": [],
    })
    cases.append({
        "name": "recover/coarse_ladder",
        "skill": "RecoverTipFromSaturation",
        "params": {},
        "verbs": {},
        "runs": {
            "MotorMove": [{"success": True, "data": {}}],
            # 预检 3 次饱和 → 压电后 3 次仍饱和 → 20 步后 3 次仍饱和 →
            # 30 步后 3 次仍饱和 → 50 步后脱离
            "GetCurrent": [_cur(sat)] * 3 + [_cur(sat)] * 3 + [_cur(sat)] * 3
                          + [_cur(sat)] * 3 + [_cur(4e-11)],
            "SetBias": [{"success": True, "data": {}}],
            "WithdrawTip": [{"success": True, "data": {}}],
        },
        "clock_keys": [],
    })
    cases.append({
        "name": "recover/budget_runs_out",
        "skill": "RecoverTipFromSaturation",
        "params": {"max_coarse_steps": 60},
        "verbs": {},
        "runs": {
            "MotorMove": [{"success": True, "data": {}}],
            "GetCurrent": [_cur(sat)],
            "SetBias": [{"success": True, "data": {}}],
            "WithdrawTip": [{"success": True, "data": {}}],
        },
        "clock_keys": [],
    })
    cases.append({
        "name": "recover/motor_step_fails",
        "skill": "RecoverTipFromSaturation",
        "params": {"max_coarse_steps": 100},
        "verbs": {},
        "runs": {
            # 第一次（查锁，steps=0）成功，之后每一级都失败 ⇒ `used` 一步都不涨
            "MotorMove": [{"success": True, "data": {}},
                          {"success": False, "error": "粗动被拒：本机粗动耐压未声明"}],
            "GetCurrent": [_cur(sat)],
            "SetBias": [{"success": True, "data": {}}],
            "WithdrawTip": [{"success": True, "data": {}}],
        },
        "clock_keys": [],
    })

    # ── WaitForThermalSettle ─────────────────────────────────────────────
    cases.append({
        "name": "thermal/settles_on_rate",
        "skill": "WaitForThermalSettle",
        "params": {"max_rate_k_per_min": 0.03, "timeout_s": 3600.0, "window": 6},
        "verbs": {},
        "runs": {"GetTemperature": [
            {"success": True, "data": {"value_k": t}} for _s, t in COOLDOWN]},
        "clock_keys": ["elapsed_s", "rate_k_per_min", "message"],
    })
    cases.append({
        "name": "thermal/rate_ok_but_too_warm",
        "skill": "WaitForThermalSettle",
        "params": {"max_rate_k_per_min": 0.03, "max_temp_k": 4.0,
                   "timeout_s": 400.0, "window": 6},
        "verbs": {},
        "runs": {"GetTemperature": [
            {"success": True, "data": {"value_k": t}} for _s, t in COOLDOWN]},
        "clock_keys": ["elapsed_s", "rate_k_per_min", "error"],
    })
    cases.append({
        "name": "thermal/timeout_while_falling",
        "skill": "WaitForThermalSettle",
        "params": {"max_rate_k_per_min": 0.03, "timeout_s": 200.0, "window": 6},
        "verbs": {},
        "runs": {"GetTemperature": [
            {"success": True, "data": {"value_k": t}} for _s, t in COOLDOWN[:4]]},
        "clock_keys": ["elapsed_s", "rate_k_per_min", "error"],
    })
    cases.append({
        "name": "thermal/five_misses",
        "skill": "WaitForThermalSettle",
        "params": {"timeout_s": 3600.0},
        "verbs": {},
        "runs": {"GetTemperature": [{"success": True, "data": {}}]},
        "clock_keys": [],
    })
    cases.append({
        "name": "thermal/one_miss_then_settles",
        "skill": "WaitForThermalSettle",
        "params": {"max_rate_k_per_min": 0.03, "timeout_s": 3600.0, "window": 6},
        "verbs": {},
        "runs": {"GetTemperature": [{"success": True, "data": {}}] + [
            {"success": True, "data": {"value_k": t}} for _s, t in COOLDOWN]},
        "clock_keys": ["elapsed_s", "rate_k_per_min", "message"],
    })

    # ── WatchScanLines ───────────────────────────────────────────────────
    frame = watch_frame(16, 12, 9)
    base_verbs = {
        "Scan_BufferGet": [{"body": _buffer_body([0, 30], 12, 16)}],
        "Signals_NamesGet": [{"body": [40, 2, ["Current (A)", "Bias (V)"]]}],
        "Scan_FrameGet": [{"body": [0.0, 0.0, 12e-9, 12e-9, 0.0]}],
        "Scan_FrameDataGrab": [{"body": _frame_body(frame)}],
    }
    cases.append({
        "name": "watch/half_scanned",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": -1, "max_lines": 64},
        "verbs": base_verbs, "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "watch/cursor_advanced",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": 4, "max_lines": 64},
        "verbs": base_verbs, "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "watch/cursor_stalled",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": 8, "max_lines": 64},
        "verbs": base_verbs, "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "watch/max_lines_caps",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": -1, "max_lines": 3},
        "verbs": base_verbs, "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "watch/nothing_scanned_yet",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": -1},
        "verbs": {**base_verbs,
                  "Scan_FrameDataGrab": [{"body": _frame_body(watch_frame(16, 12, 0))}]},
        "runs": {}, "clock_keys": [],
    })
    # 未扫区在**低号**侧（`direction="up"` 那种填法）
    flipped = watch_frame(16, 12, 9)[::-1]
    cases.append({
        "name": "watch/low_side_unscanned",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": 10, "max_lines": 64},
        "verbs": {**base_verbs, "Scan_FrameDataGrab": [{"body": _frame_body(flipped)}]},
        "runs": {}, "clock_keys": [],
    })
    # 宽帧（128 列）：触顶比例 2/128 = 0.0156 **低于** 0.02，于是另外两条观察
    # 才第一次有格子走得到。
    wide = watch_frame(6, 128, 4, flat_last=False, period=128, amp=2e-9)
    wide_verbs = {
        "Scan_BufferGet": [{"body": _buffer_body([0, 30], 128, 6)}],
        "Signals_NamesGet": [{"body": [40, 2, ["Current (A)", "Bias (V)"]]}],
        "Scan_FrameGet": [{"body": [0.0, 0.0, 12.8e-9, 12.8e-9, 0.0]}],
        "Scan_FrameDataGrab": [{"body": _frame_body(wide)}],
    }
    cases.append({
        "name": "watch/wide_quiet_frame",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": -1, "max_lines": 64},
        "verbs": wide_verbs, "runs": {}, "clock_keys": [],
    })
    wide_flip = watch_frame(6, 128, 4, flat_last=False, alternate_phase=True, period=128, amp=2e-9)
    cases.append({
        "name": "watch/wide_low_correlation",
        "skill": "WatchScanLines",
        "params": {"direction": 1, "since_line": -1, "max_lines": 64},
        "verbs": {**wide_verbs,
                  "Scan_FrameDataGrab": [{"body": _frame_body(wide_flip)}]},
        "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "watch/forced_channel",
        "skill": "WatchScanLines",
        "params": {"direction": 0, "since_line": -1, "channel_index": 30},
        "verbs": base_verbs, "runs": {}, "clock_keys": [],
    })

    # ── BiasSettleChange ─────────────────────────────────────────────────
    def _bias_case(name: str, target: float, start: float, fb: int, **extra) -> dict:
        p = {"bias_v": target}
        p.update(extra)
        return {
            "name": name,
            "skill": "BiasSettleChange",
            "params": p,
            "verbs": {"Bias_Get": [{"body": [start]}],
                      "ZCtrl_OnOffGet": [{"body": [fb]}]},
            "runs": {"SetBias": [{"success": True, "data": {}}],
                     "SetBiasRamp": [{"success": True, "data": {}}]},
            "clock_keys": [],
        }

    cases.append(_bias_case("bias/direct_small_step", 1.1, 1.0, 1))
    cases.append(_bias_case("bias/ramp_big_step", 3.0, 1.0, 1))
    cases.append(_bias_case("bias/cross_zero", -1.0, 1.0, 1))
    cases.append(_bias_case("bias/exactly_at_threshold", 1.5, 1.0, 1))
    cases.append(_bias_case("bias/deadband_refused_fb_on", 0.02, 1.0, 1))
    cases.append(_bias_case("bias/deadband_allowed_fb_off", 0.02, 1.0, 0))
    cases.append(_bias_case("bias/deadband_opt_in", 0.02, 1.0, 1,
                            allow_stop_in_deadband=True))
    cases.append(_bias_case("bias/explicit_settle", 3.0, 1.0, 1, settle_s=0.0))
    cases.append({
        "name": "bias/feedback_unreadable_deadband",
        "skill": "BiasSettleChange",
        "params": {"bias_v": 0.02},
        "verbs": {"Bias_Get": [{"body": [1.0]}],
                  "ZCtrl_OnOffGet": [{"error": "模拟故障：连接被对端关闭"}]},
        "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "bias/sub_skill_fails",
        "skill": "BiasSettleChange",
        "params": {"bias_v": 3.0},
        "verbs": {"Bias_Get": [{"body": [1.0]}], "ZCtrl_OnOffGet": [{"body": [1]}]},
        "runs": {"SetBiasRamp": [{"success": False, "error": "斜坡被安全闸拒绝"}]},
        "clock_keys": [],
    })

    # ── AcquirePSD ───────────────────────────────────────────────────────
    def _psd_body(f0: float, df: float, n: int, base: float) -> list:
        return [f0, df, n, [base + 1e-13 * k for k in range(n)]]

    ranges_body = [0, 0, [20.0, 50.0, 100.0, 200.0, 500.0, 1000.0]]
    cases.append({
        "name": "psd/single_range",
        "skill": "AcquirePSD",
        "params": {"instance": 1, "signal_index": 0, "freq_range_index": 2,
                   "freq_resolution_index": 1},
        "verbs": {
            "SpectrumAnlzr_Run": [{"body": [0]}],
            "SpectrumAnlzr_ChSet": [{"body": [0]}],
            "SpectrumAnlzr_FreqResSet": [{"body": [0]}],
            "SpectrumAnlzr_FreqResGet": [{"body": [1, [0.49, 0.98, 1.95, 3.91, 7.81]]}],
            "SpectrumAnlzr_ChGet": [{"body": [7]}],
            "SpectrumAnlzr_FreqRangeSet": [{"body": [0]}],
            "SpectrumAnlzr_FreqRangeGet": [{"body": ranges_body}],
            "SpectrumAnlzr_DataGet": [{"body": _psd_body(0.0, 0.49, 8, 1e-12)}],
        },
        "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "psd/multi_range_sweep",
        "skill": "AcquirePSD",
        "params": {"instance": 1, "freq_range_indices": "[0, 2, 5]"},
        "verbs": {
            "SpectrumAnlzr_Run": [{"body": [0]}],
            "SpectrumAnlzr_FreqResGet": [{"body": [1, [0.49]]}],
            "SpectrumAnlzr_ChGet": [{"body": [7]}],
            "SpectrumAnlzr_FreqRangeSet": [{"body": [0]}],
            "SpectrumAnlzr_FreqRangeGet": [{"body": ranges_body}],
            "SpectrumAnlzr_DataGet": [
                {"body": _psd_body(0.0, 0.16, 4, 1e-12)},
                {"body": _psd_body(0.0, 0.78, 4, 2e-12)},
                {"body": _psd_body(0.0, 7.81, 4, 3e-12)},
            ],
        },
        "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "psd/bad_indices_json",
        "skill": "AcquirePSD",
        "params": {"instance": 1, "freq_range_indices": "0,2,5",
                   "freq_range_index": 3},
        "verbs": {
            "SpectrumAnlzr_Run": [{"body": [0]}],
            "SpectrumAnlzr_FreqResGet": [{"body": [1, [0.49]]}],
            "SpectrumAnlzr_ChGet": [{"body": [7]}],
            "SpectrumAnlzr_FreqRangeSet": [{"body": [0]}],
            "SpectrumAnlzr_FreqRangeGet": [{"body": ranges_body}],
            "SpectrumAnlzr_DataGet": [{"body": _psd_body(0.0, 1.95, 4, 5e-13)}],
        },
        "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "psd/short_reply",
        "skill": "AcquirePSD",
        "params": {"instance": 1},
        "verbs": {
            "SpectrumAnlzr_Run": [{"body": [0]}],
            "SpectrumAnlzr_FreqResGet": [{"body": [1]}],
            "SpectrumAnlzr_ChGet": [{"body": [7]}],
            "SpectrumAnlzr_FreqRangeGet": [{"body": ranges_body}],
            "SpectrumAnlzr_DataGet": [{"body": [0.0, 0.49, 8]}],
        },
        "runs": {}, "clock_keys": [],
    })
    cases.append({
        "name": "psd/chset_rejected",
        "skill": "AcquirePSD",
        "params": {"instance": 2, "signal_index": 99},
        "verbs": {
            "SpectrumAnlzr_Run": [{"body": [0]}],
            "SpectrumAnlzr_ChSet": [{"error": "NanonisError: invalid signal index"}],
        },
        "runs": {}, "clock_keys": [],
    })

    # ── BatchRegionsScan ─────────────────────────────────────────────────
    two_regions = json.dumps([
        {"center_x_m": 1e-7, "center_y_m": 0.0, "width_m": 5e-8, "height_m": 5e-8,
         "label": "A"},
        {"center_x_m": -2e-7, "center_y_m": 1e-7, "width_m": 2e-7, "height_m": 2e-7},
    ])
    ok_runs = {
        "ConfigureScan": [{"success": True, "data": {}}],
        "SetScanSpeed": [{"success": True, "data": {}}],
        "StartScan": [{"success": True, "data": {}}],
        "WaitScanComplete": [{"success": True, "data": {
            "timed_out": False, "stopped_early": False,
            "lines_done": 128, "lines_total": 128}}],
        "SaveScan": [{"success": True, "data": {"saved_path": "/tmp/r.sxm"}}],
    }
    cases.append({
        "name": "batch/two_regions_ok",
        "skill": "BatchRegionsScan",
        "params": {"regions": two_regions},
        "verbs": {}, "runs": ok_runs, "clock_keys": [],
    })
    cases.append({
        "name": "batch/one_times_out",
        "skill": "BatchRegionsScan",
        "params": {"regions": two_regions},
        "verbs": {},
        "runs": {**ok_runs, "WaitScanComplete": [
            {"success": True, "data": {"timed_out": False, "stopped_early": False,
                                       "lines_done": 128, "lines_total": 128}},
            {"success": True, "data": {"timed_out": True, "stopped_early": False}},
        ]},
        "clock_keys": [],
    })
    cases.append({
        "name": "batch/one_stops_early",
        "skill": "BatchRegionsScan",
        "params": {"regions": two_regions},
        "verbs": {},
        "runs": {**ok_runs, "WaitScanComplete": [
            {"success": True, "data": {"timed_out": False, "stopped_early": True,
                                       "lines_done": 31, "lines_total": 128}},
            {"success": True, "data": {"timed_out": False, "stopped_early": False,
                                       "lines_done": 128, "lines_total": 128}},
        ]},
        "clock_keys": [],
    })
    cases.append({
        "name": "batch/every_region_refused",
        "skill": "BatchRegionsScan",
        "params": {"regions": two_regions},
        "verbs": {},
        "runs": {**ok_runs, "ConfigureScan": [
            {"success": False, "error":
             "center_y_m = 1.7031e-06 violates global safety maximum 1.5e-06"}]},
        "clock_keys": [],
    })
    cases.append({
        "name": "batch/assess_picks_best",
        "skill": "BatchRegionsScan",
        "params": {"regions": two_regions, "assess_quality": True},
        "verbs": {},
        "runs": {**ok_runs, "AssessImageQuality": [
            {"success": True, "data": {"fft_quality": 0.41, "label": "ok",
                                       "confidence": 0.7, "snr_db": 12.0}},
            {"success": True, "data": {"fft_quality": 0.83, "label": "good",
                                       "confidence": 0.9, "snr_db": 19.0}},
        ]},
        "clock_keys": [],
    })
    cases.append({
        "name": "batch/explicit_line_time",
        "skill": "BatchRegionsScan",
        "params": {"regions": two_regions, "line_time_s": 0.4, "save_each": False},
        "verbs": {}, "runs": ok_runs, "clock_keys": [],
    })
    for bad, label in (
        ("", "missing"),
        ("not json", "not_json"),
        ('{"center_x_m": 0}', "not_a_list"),
        ("[]", "empty_list"),
        ("[3]", "not_an_object"),
        ('[{"center_x_m": 0, "center_y_m": 0, "width_m": 5e-8}]', "missing_field"),
        ('[{"center_x_m": 100, "center_y_m": 0, "width_m": 5e-8, "height_m": 5e-8}]',
         "center_out_of_range"),
        ('[{"center_x_m": 0, "center_y_m": 0, "width_m": 50, "height_m": 5e-8}]',
         "size_out_of_range"),
        ('[{"center_x_m": 0, "center_y_m": 0, "width_m": 5e-8, "height_m": 5e-8,'
         ' "label": ""}]', "empty_label_falls_back"),
    ):
        cases.append({
            "name": f"batch/regions_{label}",
            "skill": "BatchRegionsScan",
            "params": {"regions": bad},
            "verbs": {}, "runs": ok_runs, "clock_keys": [],
        })

    return cases


def main() -> int:
    reg = SkillRegistry()
    reg.discover()
    by_name = {n: list(v.values())[-1] for n, v in reg.snapshot_names().items()}

    out: dict[str, Any] = {}
    for case in _cases():
        name = case["name"]
        cls = by_name.get(case["skill"])
        if cls is None:
            print(f"[warn] 注册表里找不到 {case['skill']}", file=sys.stderr)
            continue
        _CLOCK[0] = 1_000_000.0
        # 组合技能会往 `experiments/composite_progress/` 落断点，而假 context
        # 没有 run_id ⇒ 所有用例共用同一个文件。不清的话上一格的进度会被下一格
        # 捡起来**续跑**（`export_skill_traces.py` 抬头那一条，第四次）。
        try:
            from mast.skills.composite.graph_executor import _sidecar_dir
            for f in _sidecar_dir().glob("*"):
                f.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        ctx = _ScriptedContext(case.get("verbs", {}), case.get("runs", {}))
        skill = cls()
        try:
            res = skill.execute(ctx, dict(case["params"]))
            rec = _result(res)
        except Exception as exc:  # noqa: BLE001 —— 抛出来本身就是一条判据
            rec = {"raised": f"{type(exc).__name__}: {exc}"}
        print(f"  … {name}", file=sys.stderr, flush=True)
        out[name] = {
            "skill": case["skill"],
            "params": _jsonable(case["params"]),
            "verbs": _jsonable(case.get("verbs", {})),
            "runs": _jsonable(case.get("runs", {})),
            "clock_keys": list(case.get("clock_keys", [])),
            "calls": ctx.calls,
            "run_log": ctx.run_log,
            "result": rec,
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(f"[ok]   batch5b.json: {len(out)} 格")
    raised = [k for k, v in out.items() if "raised" in v["result"]]
    if raised:
        print(f"[note] {len(raised)} 格抛了异常（也是判据）：{', '.join(raised[:8])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
