"""批 7b-2 的**判据**金样 —— 势垒链与线缆，每条判据各走一格。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_batch7b2.py

## 为什么还要一台导出器（`skill_traces.json` 已经有这八个了）

那一份录的是「它在注册表里、被真调度链调得动、发的是那一串动词」——通用驱动器给
每个动词一个**常数**回包、给每个子技能一个**空 data**。于是：

* `MeasureBarrierHeight` 的每一次 `AcquireSTS` 都回 `data={}` ⇒ `spectrum_parsed`
  为假 ⇒ **方向确认的第一读就 `None`**，κ 拟合、噪声底、三条判读**一条都没走到**；
* `MapBarrierHeight` 的每一次子调用 φ 都是 `None` ⇒ 两个散布都算不出来 ⇒
  只录到 `undetermined`，「针尖侧／表面侧／灰带」三条**一条都没走到**；
* `CleanTipUntilBarrier` 的基线 φ 是 `None` ⇒ **在第一句就返回**，
  阶梯、改善门槛、变差立刻停、连续无改善、交出最好那一个 —— 全没跑；
* `AcquireDeltaFCurve` 的 `ZSpectr_Start` 回包是一块 2×2 而表头说 6×7 ⇒
  **每一格都走「装不下」**，四路通道的挑法一格都没验；
* `RunGridExperiment` 的超时判据读**墙钟**，而那台导出器把墙钟钉死 ⇒ 永远走不到。

**一格分辨不出两种候选的金样不是判据。** 所以这台导出器与 `export_batch5b.py`
同一条设计：**脚本化上下文** —— 每个动词、每个子技能的回答由用例自己给。

## 四条纪律

1. **输入与答案一起录**，合成用闭式公式（这里是 `I(d) = I₀·exp(−2κd)`，
   κ = 5.123·√φ —— 与被测代码**反过来**的那条式子），零随机 ⇒ 重跑逐字节相同；
2. 墙钟与单调钟都走假钟。**这一台与别的不同：`time.time` 也接到会前进的那一个上**
   （见下面「墙钟」那一节）；
3. **脚本本身进金样**，TS 那侧拿同一份脚本喂同一个技能；
4. 每格带一个 `clock_keys`：那几个叶子按相对 1e-6 比，其余逐位。

## ⚠️ 墙钟：这一台**故意**让它走

`export_skill_traces.py` 把 `time.time` 钉成常数（`1_700_000_000.0`），理由是
「重跑逐字节相同」。那条理由在这里也成立 —— 但**代价是 `RunGridExperiment` 的
超时判据在那份金样里是死代码**（`elapsed ≡ 0`）。

这一台把 `time.time` 也接到 `_CLOCK` 上（只由 `sleep` 与每次读的 1e-3 往前拨），
于是：

* 仍然**逐字节可复现**（假钟是确定的，与真实时间无关）；
* 而 `elapsed = time.time() − start_time` **真的会涨** ⇒ 超时那一支被录到。

两侧这条判据的符号为什么一定一致：`elapsed` 的主项是**睡掉的那些秒**
（每拍 2 s，两侧逐位相同），读钟带来的零头两侧都是**正**的。
取 `wait_timeout_s = 10.0` ⇒ `max_ticks = 5`，第 5 拍睡满 10 s ⇒
`10 + 正零头 ≥ 10` 在两侧同时成立，而第 4 拍的 8 + 零头离 10 差着两秒。
**判据的符号由睡眠总量决定，不由读钟次数决定。**

## ⚠️ `CalibrateCoarseStep` 的标定循环**没有金样**，理由写在这里

`_scan` 取 `ScanAt` 回包里的 `scan_path` / `path`，而 `ScanAt` 两个都不写
（旧仓 `scan_at.py:368-389`、本仓 `scan-at.ts:183-198`，逐键比过）⇒
`execute` 恒在「基准帧扫描失败」返回，`_load` / `phase_shift` / 清障 / 马达 /
线性自证**一行都到不了**。旧仓自己的 docstring（`:98-99`）也写着
「尚未在真机上跑完一次完整标定」。

所以这里录的是**今天真的走得到**的那几格；`phase_shift` 那 15 行**单独成节**
（纯数值，零 I/O、零 RANSAC）；循环内部那几支由 TS 侧的
`batch7b2-skills.test.ts` 用一份**明写是假设**的脚本驱动
（名字带 `hypothetical`），期望值从本文件的 `phase_shift` 节算出来。
**不假装它活着。**
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-b7b2-"))

MAST_ROOT = require_mast_root()
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "batch7b2.json"

# ── 时间桩 ────────────────────────────────────────────────────────────────
import time as _time

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


_time.sleep = _fake_sleep          # type: ignore[assignment]
_time.monotonic = _fake_monotonic  # type: ignore[assignment]
_time.perf_counter = _fake_monotonic  # type: ignore[assignment]
# ⚠️ **与别的导出器不同**：墙钟也接到会前进的那一个上（见抬头「墙钟」那一节）。
_time.time = _fake_monotonic       # type: ignore[assignment]

sys.path.insert(0, str(MAST_ROOT))
import numpy as np  # noqa: E402
from mast.core.types import NanonisCallRecord, SkillResult  # noqa: E402
from mast.core.registry import SkillRegistry  # noqa: E402
from mast.skills.base import BaseSkill  # noqa: E402
from mast.skills.builtins.barrier_height import _fit_kappa, _verdict  # noqa: E402
from mast.skills.builtins.barrier_map import _rel_spread, verdict_from  # noqa: E402
from mast.skills.builtins.bias_series import setpoints_for  # noqa: E402
from mast.skills.builtins.coarse_step_calib import phase_shift  # noqa: E402
from mast.skills.builtins.optics_acquire import mean_std, parse_indices  # noqa: E402


# ──────────────────────────────────────────────────────────────────────────
# 脚本化上下文（形状照 `export_batch5b.py`，多两样：会走的钟、按钟中止）
# ──────────────────────────────────────────────────────────────────────────


def _materialise(v: Any) -> Any:
    """脚本里的记号 → 真值。

    `allow_nan=False` 让 JSON 装不下 NaN / inf，而
    `_read_at` 的 `arr[np.isfinite(arr)]` 是一道**真的闸**（一条含 NaN 的电流道）。
    所以用显式记号，两侧照同一张表还原 —— 记号本身进金样，不存在「两边各造一份」。
    """
    if isinstance(v, dict) and "__nan__" in v:
        return float("nan")
    if isinstance(v, dict) and "__inf__" in v:
        return float("inf") if v["__inf__"] > 0 else float("-inf")
    if isinstance(v, list):
        return [_materialise(x) for x in v]
    if isinstance(v, dict):
        return {k: _materialise(x) for k, x in v.items()}
    return v


class _ScriptedContext:
    """每个动词、每个子技能的回答都由用例自己给。

    队列取完之后**重复最后一个** —— 轮询循环要调几百次同一个动词，
    而「第 300 拍与第 1 拍走的是同一条分支」。
    """

    def __init__(self, verbs: dict, runs: dict, abort_at_s: float | None = None) -> None:
        self._verbs = {k: list(v) for k, v in verbs.items()}
        self._runs = {k: list(v) for k, v in runs.items()}
        self._vi: dict[str, int] = {}
        self._ri: dict[str, int] = {}
        # **按钟中止**，不按调用序号：两侧读钟的次数可以不同，而睡掉的秒数一样。
        # 阈值挑在两拍中间（3.0 s 落在第 1 拍的 2 s 与第 2 拍的 4 s 之间），
        # 于是「第几拍看见它」两侧一定一致。
        self._abort_at = abort_at_s
        self._t0 = _CLOCK[0]
        self.calls: list[dict] = []
        self.run_log: list[dict] = []

    @staticmethod
    def _next(queue: list, idx: dict[str, int], key: str) -> Any:
        i = idx.get(key, 0)
        idx[key] = i + 1
        if not queue:
            return None
        return queue[min(i, len(queue) - 1)]

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
        if self._abort_at is None:
            return False
        return (_CLOCK[0] - self._t0) >= self._abort_at

    def run(self, skill_name: str, params: dict, version: str | None = None) -> SkillResult:
        self.run_log.append({"skill": skill_name, "params": _jsonable(params)})
        spec = self._next(self._runs.get(skill_name, []), self._ri, skill_name)
        if spec is None:
            return SkillResult(skill_name=skill_name, success=True, data={})
        return SkillResult(
            skill_name=skill_name,
            success=bool(spec.get("success", True)),
            data=_materialise(dict(spec.get("data", {}))),
            error=str(spec.get("error", "") or ""),
        )


def _jsonable(v: Any) -> Any:
    if isinstance(v, (str, bool)) or v is None:
        return v
    if isinstance(v, float):
        if v != v:
            return {"__nan__": True}
        if v == float("inf"):
            return {"__inf__": 1}
        if v == float("-inf"):
            return {"__inf__": -1}
        return v
    if isinstance(v, int):
        return v
    if type(v).__name__ == "ndarray":
        return _jsonable(v.tolist())
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
# 合成输入：`I(d) = I₀·exp(−2κd)`，κ = 5.123·√φ
# ──────────────────────────────────────────────────────────────────────────

KAPPA_PER_SQRT_EV = 5.123
DEFAULT_OFFSETS = (0.0, 0.10, 0.20, 0.30, 0.40, 0.55)


def iz_current_pa(phi_ev: float, i0_pa: float, d_nm: float) -> float:
    """一条理想 I–Z：`|I| = I₀·exp(−2κd)`。

    **这是被测代码的逆运算**：它从 `ln|I|` 拟合出 κ 再换成 φ，这里从 φ 造 I。
    于是「拟合对不对」这件事在金样里是可以独立验算的 —— 期望的 φ 就是输入的 φ。
    """
    kappa = KAPPA_PER_SQRT_EV * (phi_ev ** 0.5)
    return float(i0_pa * np.exp(-2.0 * kappa * d_nm))


def sts_ok(values_pa: "list[float]") -> dict:
    """一条 `AcquireSTS` 的成功回包：`Current (A)` 那一道。

    `_read_at` 取的是 `mean(|I|)·1e12`，所以给**常值**那一段就等于直接指定 pA 值。
    """
    return {"success": True, "data": {
        "spectrum_parsed": True,
        "Current (A)": [v * 1e-12 for v in values_pa],
    }}


STS_DEAD = {"success": True, "data": {"spectrum_parsed": False}}


def barrier_runs(phi_ev: float, i0_pa: float, offsets=DEFAULT_OFFSETS,
                 *, probe_ratio: float | None = None) -> dict:
    """`MeasureBarrierHeight` 的一整条子技能脚本。

    顺序是固定的：方向确认两读（d=0 与 d=`_PROBE_NM`），然后逐档一读。
    `probe_ratio` 给出时**覆盖**试探那一读（用来造「方向反了」与「太弱」两格）。
    """
    probe = iz_current_pa(phi_ev, i0_pa, 0.10)
    if probe_ratio is not None:
        probe = i0_pa * probe_ratio
    seq = [sts_ok([i0_pa]), sts_ok([probe])]
    for d in offsets:
        seq.append(sts_ok([iz_current_pa(phi_ev, i0_pa, d)]))
    return {"AcquireSTS": seq}


def phi_runs(values: "list[float | None]") -> list:
    """`MeasureBarrierHeight` 当**子技能**时的一串回包（`MapBarrierHeight` /
    `CleanTipUntilBarrier` 用）。`None` = 那一次判不了。"""
    out = []
    for v in values:
        if v is None:
            out.append({"success": True, "data": {"verdict": "undetermined",
                                                  "phi_ev": None, "n_fit": None}})
        else:
            kind = "clean" if v >= 3.0 else ("contaminated" if v >= 1.0 else "not_vacuum")
            out.append({"success": True, "data": {
                "verdict": kind, "phi_ev": v,
                "kappa_per_nm": KAPPA_PER_SQRT_EV * (v ** 0.5), "n_fit": 5}})
    return out


# ── Δf(z) 的扫掠块 ────────────────────────────────────────────────────────


def zspectr_body(names: "list[str]", rows_data: "list[list[float]]") -> list:
    """`ZSpectr_Start` 的 Variables 块：`[?, ?, 名字表, 行数, 列数, 2D]`。

    布局是**行=通道、列=扫描点**（`_reshape_spectrum` 的抬头写着为什么：
    2026-07-03 真机上按转置读回来的是混在一起的谱，而每个数看起来都是真的）。
    """
    rows = len(rows_data)
    cols = len(rows_data[0]) if rows_data else 0
    flat = [float(x) for row in rows_data for x in row]
    return [0, 0, list(names), rows, cols, flat]


def df_curve(n: int) -> "tuple[list[float], list[float], list[float], list[float]]":
    """一条闭式的 Δf(z)：z 从 0 往里走，Δf 有一个极小值，电流按指数涨。

    极小值**刻意不落在端点上**（第 `n//3` 点）—— 落在端点时
    「取最小」与「取第一个」给同一个答案。
    """
    z = [round(-i * 10e-12, 15) for i in range(n)]
    imin = n // 3
    df = [round(-2.0 - 3.0 * np.exp(-((i - imin) / 4.0) ** 2), 9) for i in range(n)]
    cur = [round(1e-11 * float(np.exp(i / 8.0)), 18) for i in range(n)]
    amp = [round(5e-11 + 1e-13 * i, 18) for i in range(n)]
    return z, df, cur, amp


# ── `phase_shift` 的合成帧（闭式，零随机）────────────────────────────────


#: 合成帧里那一层**宽带**噪声的幅度（相对坑深）。见 `pit_frame` 的抬头。
NOISE_AMP = 0.02


def pit_frame(n: int, centres: "list[tuple[int, int]]", *, seed: int = 0,
              amp: float = 1.0, sigma: float = 2.0, offset: float = 0.0,
              noise: float = NOISE_AMP) -> "list[list[float]]":
    """几个高斯坑 + 一层**宽带**噪声。**闭式** ⇒ 重跑逐字节相同。

    ## ⚠️ 那层噪声不是装饰，是这一节能不能比的前提

    `phase_shift` 把互功率谱**归一化成单位相位**（`R /= max(|R|, 1e-30)`）。
    三个高斯坑求和是一个**解析光滑**的场，它的谱里有一批数值上为零的格
    （实测 `max|R| / min|R| = 6.4e15`）。归一化把那些格的相位整个放出来 ——
    而那些格的相位**不是数据决定的，是舍入决定的**：pocketfft 与本仓的 FFT
    在那里给出完全不同的角度。后果是 `snr` 两侧差 `2e−10` 相对，
    **而这个差推不出界**（它取决于输入谱的动态范围，不取决于 N）。
    一条推不出来的容差按本仓的规矩就不该写。

    加一层幅度 2% 的**非周期**哈希噪声之后 `max|R|/min|R|` 降到 `2.2e7`，
    那几格不再是数值零，相位由数据决定 ⇒ 两侧的差回到
    {@link phaseShiftSnrRelTol} 那条推得出来的界之内。

    **为什么必须非周期**：第一版用的是 `(r·31 + c·17) mod 13`，它在 c 上周期 13 ——
    归一化之后高频格由这层噪声主导，而一个周期噪声在格点偏移上自相关很强，
    于是**相关峰整个挪了位**（`dx` 从 −5 变成 −1）。这不是精度问题，是答案变了。

    真机上的帧本来就带噪声；一个由三个解析高斯求和而成的帧才是那个**退化**的输入。
    （同批 7a-3「台阶是一像素锐变」那一条：合成选择要交代，而理由是
    「让被测的那个量在这一格上是有定义的」。）

    round 到 6 位：这几个数要原样进金样，而两侧读的是同一串十进制字面量。
    """
    out = []
    for r in range(n):
        row = []
        for c in range(n):
            v = offset
            for (cy, cx) in centres:
                v -= amp * float(np.exp(-(((r - cy) ** 2 + (c - cx) ** 2) / (2.0 * sigma ** 2))))
            if noise:
                h = np.sin(r * 12.9898 + c * 78.233 + seed * 37.719) * 43758.5453
                v += noise * float(h - np.floor(h) - 0.5)
            row.append(round(v, 6))
        out.append(row)
    return out


def roll2(m: "list[list[float]]", dy: int, dx: int) -> "list[list[float]]":
    """`np.roll(m, (dy, dx), axis=(0,1))` —— 周期性平移，**位移是精确的整数**。"""
    n = len(m)
    return [[m[(r - dy) % n][(c - dx) % n] for c in range(n)] for r in range(n)]


# ──────────────────────────────────────────────────────────────────────────
# 用例
# ──────────────────────────────────────────────────────────────────────────


def _skill_cases() -> list[dict]:
    cases: list[dict] = []

    def add(name: str, skill: str, params: dict, *, verbs=None, runs=None,
            clock_keys=(), abort_at_s=None) -> None:
        cases.append({"name": name, "skill": skill, "params": dict(params),
                      "verbs": dict(verbs or {}), "runs": dict(runs or {}),
                      "clock_keys": list(clock_keys), "abort_at_s": abort_at_s})

    # ── MeasureBarrierHeight ──────────────────────────────────────────────
    #
    # 三个判读各一格，**都用同一条闭式**造电流：φ 是输入，也是期望。
    #
    # ⚠️ `contaminated` 那一格取 **1.6 而不是 1.5**：`φ/4·100` 在 1.5 上正好是
    # **37.5**，而报文里那一格是 `%.0f`（半分点走 round-half-even）。
    # 拟合出来的 φ 两侧差在第 16 位（D-LSQ-1：numpy 走 QR，本仓走列缩放正规方程），
    # 落在半分点两侧就会渲染成 **37% 与 38%** —— 一句话把 1e−16 放大成一个不同的词。
    # 半分点本身**没有丢**：它在 `barrier_verdict` 那一节里以 φ=1.5 **精确给定**
    # （不经拟合）单独钉着，那里两侧必须逐字相同。
    for tag, phi in (("clean", 4.0), ("contaminated", 1.6), ("not_vacuum", 0.5)):
        add(f"barrier/{tag}", "MeasureBarrierHeight", {"bias_v": 0.5},
            runs=barrier_runs(phi, 1000.0))
    # 方向：正 offset 反而电流上升 ⇒ 翻符号（`ratio > 1.2`）。
    add("barrier/direction_flipped", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs=barrier_runs(4.0, 1000.0, probe_ratio=1.5))
    # 方向：只变了 5% ⇒ 落在 [0.85, 1.2] 灰带 ⇒ **拒绝往下做**。
    add("barrier/direction_weak", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs=barrier_runs(4.0, 1000.0, probe_ratio=0.95))
    # 边界：`ratio < 0.85` 是**严格**小于 —— 正好 0.85 走的是灰带那一支。
    add("barrier/direction_exactly_085", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs=barrier_runs(4.0, 1000.0, probe_ratio=0.85))
    # 边界：`ratio > 1.2` 同理 —— 正好 1.2 也是灰带。
    add("barrier/direction_exactly_120", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs=barrier_runs(4.0, 1000.0, probe_ratio=1.2))
    # 基准点读不到 / 试探点读不到 —— 两句不同的话。
    add("barrier/no_base_current", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [STS_DEAD]})
    add("barrier/no_probe_current", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [sts_ok([1000.0]), STS_DEAD]})
    # 基准点电流**是 0** —— `base <= 0` 与 `base is None` 走同一句话，各要一格。
    add("barrier/zero_base_current", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [sts_ok([0.0]), sts_ok([1000.0])]})
    # 方向过了，但每一档都读不到 ⇒ 「所有档位都没读到电流」。
    add("barrier/all_offsets_dead", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [sts_ok([1000.0]), sts_ok([100.0]), STS_DEAD]})
    # 可用点 < 3 ⇒ 拟合不动。**只有显式噪声底够得着这一格**：自动底是
    # 「最远两档均值×2」，对一条纯指数它恒好剩下 4 个点 —— `barrier/steep_decay`
    # 那一格是 φ=9 的极陡衰减，可用点照样是 4。
    add("barrier/too_few_usable", "MeasureBarrierHeight",
        {"bias_v": 0.5, "noise_floor_pa": 100.0}, runs=barrier_runs(4.0, 1000.0))
    add("barrier/steep_decay", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs=barrier_runs(9.0, 1000.0))
    # 斜率非负：退开反而电流变大（方向确认过了才发生 —— 针尖跳了）。
    add("barrier/slope_not_negative", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [sts_ok([1000.0]), sts_ok([100.0])]
              + [sts_ok([100.0 * (1 + i)]) for i in range(6)]})
    # 噪声底显式给 ⇒ `noise_floor_source: explicit`，而且它**真的改了 n_usable**。
    add("barrier/explicit_floor", "MeasureBarrierHeight",
        {"bias_v": 0.5, "noise_floor_pa": 10.0}, runs=barrier_runs(4.0, 1000.0))
    # 电流道里混了 NaN / inf ⇒ `arr[np.isfinite(arr)]` 那一道。
    add("barrier/nonfinite_filtered", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [
            {"success": True, "data": {"spectrum_parsed": True,
                                       "Current (A)": [1e-9, {"__nan__": True},
                                                       {"__inf__": 1}, 3e-9]}},
            sts_ok([100.0])] + [sts_ok([iz_current_pa(4.0, 1000.0, d)])
                                for d in DEFAULT_OFFSETS]})
    # 整道全是 NaN ⇒ `arr.size == 0` ⇒ 读不到（**不是** 0 pA）。
    add("barrier/all_nonfinite", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [{"success": True, "data": {
            "spectrum_parsed": True,
            "Current (A)": [{"__nan__": True}, {"__nan__": True}]}}]})
    # 电流道是**空表** ⇒ Python 的 `if not cur` 那一支（与「没有这个键」同一句话）。
    add("barrier/empty_current_channel", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs={"AcquireSTS": [{"success": True, "data": {"spectrum_parsed": True,
                                                        "Current (A)": []}}]})
    # 参数面四格。
    add("barrier/bad_offsets", "MeasureBarrierHeight",
        {"bias_v": 0.5, "offsets_nm": "0,0.1,abc"})
    add("barrier/too_few_offsets", "MeasureBarrierHeight",
        {"bias_v": 0.5, "offsets_nm": "0,0.1,0.2"})
    # `sorted(set(...))` + `abs()`：乱序、重复、负号，三样一起。
    add("barrier/offsets_dedup_sorted_abs", "MeasureBarrierHeight",
        {"bias_v": 0.5, "offsets_nm": "0.3,-0.1,0.1,0.2,0,0.4"},
        runs=barrier_runs(4.0, 1000.0, offsets=(0.0, 0.1, 0.2, 0.3, 0.4)))
    # 不给 bias_v：读得到 / 读不到，两条路。**读得到那条不许发 SetBias。**
    add("barrier/bias_from_getbias", "MeasureBarrierHeight", {},
        runs=dict(barrier_runs(4.0, 1000.0),
                  GetBias=[{"success": True, "data": {"bias_v": 1.2}}]))
    add("barrier/bias_unreadable", "MeasureBarrierHeight", {},
        runs={"GetBias": [{"success": True, "data": {}}]})
    # STS 备台被拒 ⇒ `channels_ok/timing_ok` 为 false，而技能**照样往下走**。
    add("barrier/arm_refused", "MeasureBarrierHeight", {"bias_v": 0.5},
        runs=dict(barrier_runs(4.0, 1000.0),
                  ConfigureSTSChannels=[{"success": False, "error": "通道串解析不了"}],
                  ConfigureSTSTiming=[{"success": False, "error": "缺 max_slew_rate_v_s"}]))
    # `max(0.002, …)` 那道**下限**：只有 npts > 900 才够得着（声明上限是 101，
    # 而 `execute` 不校验 —— 这是它唯一的入口）。
    add("barrier/integration_floor", "MeasureBarrierHeight",
        {"bias_v": 0.5, "points_per_step": 2000}, runs=barrier_runs(4.0, 1000.0))

    # ── MapBarrierHeight ──────────────────────────────────────────────────
    SITES4 = "0,0; 100,0; 0,100; 100,100"
    # 三条判读：比值 ≤2 / ≥3 / 中间。重复那 4 次的散布是分母。
    add("map/tip_side", "MapBarrierHeight", {"sites_nm": SITES4, "repeats": 4},
        runs={"MeasureBarrierHeight": phi_runs(
            [1.00, 1.10, 0.90, 1.00] + [1.00, 1.05, 0.95, 1.00])})
    add("map/surface_side", "MapBarrierHeight", {"sites_nm": SITES4, "repeats": 4},
        runs={"MeasureBarrierHeight": phi_runs(
            [1.00, 1.02, 0.98, 1.00] + [0.60, 1.00, 1.40, 1.60])})
    add("map/inconclusive", "MapBarrierHeight", {"sites_nm": SITES4, "repeats": 4},
        runs={"MeasureBarrierHeight": phi_runs(
            [1.00, 1.06, 0.94, 1.00] + [0.90, 1.00, 1.10, 1.15])})
    # 重复散布**恰好是 0**（四次一模一样）⇒ `repeat_spread <= 0` ⇒ undetermined。
    # 与「算不出来」是两条不同的路，各要一格。
    add("map/repeat_spread_zero", "MapBarrierHeight",
        {"sites_nm": SITES4, "repeats": 4},
        runs={"MeasureBarrierHeight": phi_runs([1.0] * 4 + [0.6, 1.0, 1.4, 1.6])})
    add("map/no_repeat_phi", "MapBarrierHeight", {"sites_nm": SITES4, "repeats": 4},
        runs={"MeasureBarrierHeight": phi_runs(
            [None] * 4 + [0.6, 1.0, 1.4, 1.6])})
    add("map/no_site_phi", "MapBarrierHeight", {"sites_nm": SITES4, "repeats": 4},
        runs={"MeasureBarrierHeight": phi_runs(
            [1.00, 1.02, 0.98, 1.00] + [None] * 4)})
    # 位置数是偶数 ⇒ `statistics.median` 取中间两个的**平均**。
    add("map/median_even", "MapBarrierHeight",
        {"sites_nm": "0,0; 10,0; 20,0; 30,0", "repeats": 4},
        runs={"MeasureBarrierHeight": phi_runs(
            [1.00, 1.02, 0.98, 1.00] + [0.50, 1.00, 2.00, 4.00])})
    # 参数面三格（**`execute` 自己也要挡**，不假设 `validate_params` 跑过）。
    add("map/bad_sites", "MapBarrierHeight", {"sites_nm": "0; 1,2; x,y; 3,4,5"})
    add("map/too_few_sites", "MapBarrierHeight", {"sites_nm": "0,0; 1,1"})
    add("map/too_few_repeats", "MapBarrierHeight", {"sites_nm": SITES4, "repeats": 2})
    # 偏压显式给 ⇒ 每次子调用都带 `bias_v`（`run_log` 里看得见）。
    add("map/bias_forwarded", "MapBarrierHeight",
        {"sites_nm": SITES4, "repeats": 4, "bias_v": -0.8, "hop_size_m": 5e-9},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.1, 0.9, 1.0] * 2)})

    # ── CleanTipUntilBarrier ──────────────────────────────────────────────
    #
    # 基线一次 + 每步一次，所以 `MeasureBarrierHeight` 的队列是
    # [baseline, step1, step2, …]。
    add("clean/already_clean", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([3.02])})
    add("clean/baseline_undetermined", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([None])})
    # 一路涨到达标（每步都过 15% 的改善门槛）。
    add("clean/reached", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.3, 1.7, 2.2, 3.1])})
    # 改善**正好 15%** ⇒ `phi > best*(1+0.15)` 是严格大于 ⇒ **不算改善**。
    add("clean/improve_exactly_15pct", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.15, 1.15, 1.15, 1.15])})
    # 先涨后跌 ⇒ 「变差 —— 立刻停」，而且交出的是**最好的那个**。
    add("clean/worse_stops", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.5, 1.2])})
    # 从基线就往下掉 ⇒ `best_at == "baseline"` ⇒ **那一支不停**（照移）。
    add("clean/worse_from_baseline_does_not_stop", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([2.0, 0.5, 0.5, 0.5, 0.5])})
    # 连续 3 步没改善。
    add("clean/stale_stops", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.0, 1.0, 1.0, 1.0])})
    # 动作失败 ⇒ 当场停（而那一步的 φ 已经量过了，照样记下来）。
    add("clean/action_failed", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.1]),
              "TipShape": [{"success": False, "error": "TipShaper 被拒"}]})
    # 某一步 φ 判不了 ⇒ 记一条 note，**不计 stale、不算变差**。
    add("clean/phi_none_is_not_no_improvement", "CleanTipUntilBarrier", {},
        runs={"MeasureBarrierHeight": phi_runs([1.0, None, None, None, None, None, None, None])})
    # 走完整条阶梯（7 步）仍未达标 ⇒ not_reached。顺带钉住
    # **每一发脉冲之后补一次扎针**（`run_log` 里 BiasPulse 后面必是 TipShape）。
    add("clean/ladder_exhausted", "CleanTipUntilBarrier", {"target_phi_ev": 5.0},
        runs={"MeasureBarrierHeight": phi_runs(
            [1.0, 1.2, 1.45, 1.75, 2.1, 2.55, 3.1, 3.8])})
    add("clean/max_steps_one", "CleanTipUntilBarrier", {"max_steps": 1},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.0])})
    # 偏压回读进每一行（修针会改工作点且不改回来 —— 08-26 栽过两次）。
    add("clean/bias_readback", "CleanTipUntilBarrier", {"bias_v": 0.3},
        runs={"MeasureBarrierHeight": phi_runs([1.0, 1.0, 1.0, 1.0]),
              "GetBias": [{"success": True, "data": {"bias_v": 0.02}}]})

    # ── AcquireBiasSeries ─────────────────────────────────────────────────
    BASE = {"center_x_m": 1e-8, "center_y_m": -2e-8, "size_m": 2e-8}
    # ⚠️ 今天真的会发生的那一格：`ScanAt` 不返回路径 ⇒ `AssessFrameTrust` 一次都不调。
    add("series/dead_path", "AcquireBiasSeries",
        dict(BASE, biases_v="2,1,-1,-2", pixels=64, line_time_s=0.02))
    # 夹紧：低偏压端撞下界、高偏压端撞上界，各一格（`clamp_note` 里印的是
    # **Python 的 list repr**，一个逐字判据）。
    add("series/clamped_low", "AcquireBiasSeries",
        dict(BASE, biases_v="0.01,-0.01,2", junction_r_ohm=1e13))
    add("series/clamped_high", "AcquireBiasSeries",
        dict(BASE, biases_v="5,-5,0.5", junction_r_ohm=1e8))
    # 0 V 被丢掉；丢完剩 1 档 ⇒ 拒。
    add("series/zero_dropped", "AcquireBiasSeries", dict(BASE, biases_v="1,0,-1"))
    add("series/too_few_after_zero", "AcquireBiasSeries", dict(BASE, biases_v="1,0"))
    add("series/bad_biases", "AcquireBiasSeries", dict(BASE, biases_v="1,x"))
    # 一帧都没扫成 ⇒ success=False + 那句话。
    # ⚠️ 这句错误**故意超过 200 字**：`str(res.error)[:200]` 那道截断只有在
    # 原话更长的时候才做决定。120 字的版本上，截与不截给同一个答案。
    add("series/all_frames_failed", "AcquireBiasSeries",
        dict(BASE, biases_v="1,-1"),
        runs={"ScanAt": [{"success": False, "error": "扫描被安全闸拒：" + "长" * 240}]})
    # 并列时取**第一个**：`max(key=abs)` 的稳定性（2 与 −2 同模）。
    add("series/ref_picks_first_of_tie", "AcquireBiasSeries",
        dict(BASE, biases_v="2,-2,1"))
    # ⚠️ **假设格**：`ScanAt` 若返回路径会怎样 —— 名字里带 hypothetical，
    # 因为今天到不了（见抬头）。三条漂移判读各一格。
    for tag, pre, post in (("worse", 10.0, 100.0), ("better", 100.0, 10.0),
                           ("comparable", 30.0, 32.0)):
        add(f"series/hypothetical_drift_{tag}", "AcquireBiasSeries",
            dict(BASE, biases_v="1,-1"),
            runs={"ScanAt": [{"success": True, "data": {"scan_path": "<tmp>/f0.sxm"}}],
                  "AssessFrameTrust": [
                      {"success": True, "data": {"row_jump_mad_pm": pre,
                                                 "tip_verdict": "ok", "rms_pm": 120.0}},
                      {"success": True, "data": {"row_jump_mad_pm": 20.0,
                                                 "tip_verdict": "ok", "rms_pm": 120.0}},
                      {"success": True, "data": {"row_jump_mad_pm": 20.0,
                                                 "tip_verdict": "ok", "rms_pm": 120.0}},
                      {"success": True, "data": {"row_jump_mad_pm": post,
                                                 "tip_verdict": "noisy", "rms_pm": 300.0}}]})
    # 路径键的另外两个写法（`path` / `file`）也认 —— 三选一那一行。
    for key in ("path", "file"):
        add(f"series/hypothetical_path_key_{key}", "AcquireBiasSeries",
            dict(BASE, biases_v="1,-1"),
            runs={"ScanAt": [{"success": True, "data": {key: "<tmp>/f0.sxm"}}]})

    # ── CalibrateCoarseStep（**只有今天走得到的那几格**，见抬头）────────────
    add("coarse/dead_path", "CalibrateCoarseStep", {"axis": "x"})
    add("coarse/dead_path_no_pit", "CalibrateCoarseStep",
        {"axis": "y", "make_pit": False})
    # 锁检查是**两个子串**：中文的「占用」与英文的 `busy`，而后者走 `.lower()`。
    # 两格各占一半，**互不重叠**（英文那句里没有「占用」，中文那句里没有 busy）——
    # 重叠的话，拆掉任一半都还有另一半接着，两种候选给同一个答案。
    add("coarse/locked_busy_uppercase", "CalibrateCoarseStep", {"axis": "x"},
        runs={"MotorMove": [{"success": False,
                             "error": "Instrument BUSY: held by another chain"}]})
    add("coarse/locked_chinese", "CalibrateCoarseStep", {"axis": "x"},
        runs={"MotorMove": [{"success": False, "error": "端口被占用，稍后再试"}]})
    add("coarse/bad_axis", "CalibrateCoarseStep", {"axis": "z"})
    add("coarse/bad_steps", "CalibrateCoarseStep", {"axis": "x", "steps": "2,abc"})
    add("coarse/one_step", "CalibrateCoarseStep", {"axis": "x", "steps": "4"})
    add("coarse/nonpositive_steps_dropped", "CalibrateCoarseStep",
        {"axis": "x", "steps": "0,-3,5"})
    # 扫描中心从 `GetScanFrame` 来；读不到就是 0（`float(x or 0.0)`）。
    add("coarse/frame_centre_read", "CalibrateCoarseStep", {"axis": "y"},
        runs={"GetScanFrame": [{"success": True, "data": {"center_x_m": 3e-8,
                                                          "center_y_m": -4e-8}}]})

    # ── AcquireDeltaFCurve ────────────────────────────────────────────────
    z, df, cur, amp = df_curve(24)
    CH_OK = {"ZSpectr_Start": [{"body": zspectr_body(
        ["Z rel (m)", "OC M1 Freq. Shift (Hz)", "Current (A)", "OC M1 Amplitude (m)"],
        [z, df, cur, amp])}]}
    PLL_ON = {"PLL_OutOnOffGet": [{"body": [1]}],
              "PLL_CenterFreqGet": [{"body": [30012.5]}],
              "PLL_FreqShiftGet": [{"body": [-1.25]}],
              "PLL_AmpCtrlSetpntGet": [{"body": [5e-11]}]}
    add("deltaf/ok", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "num_points": 24, "channel_indexes": "3,0,7",
         "save_basename": "Fe_atom"},
        verbs=dict(PLL_ON, **CH_OK))
    # 回程那一路整列跳过 —— 不跳的话 `df_min_hz` 会取到两条里的最小值。
    add("deltaf/bwd_column_skipped", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "num_points": 24, "channel_indexes": "3,0"},
        verbs=dict(PLL_ON, ZSpectr_Start=[{"body": zspectr_body(
            ["Z rel (m)", "OC M1 Freq. Shift (Hz)",
             "OC M1 Freq. Shift [bwd] (Hz)"],
            [z, df, [v - 10.0 for v in df]])}]))
    # PLL 输出关着 ⇒ 直接失败（**不采一条噪声**）。
    add("deltaf/pll_off", "AcquireDeltaFCurve", {"z_sweep_distance_m": 5e-10},
        verbs={"PLL_OutOnOffGet": [{"body": [0]}]})
    # 同一份回包，`require_pll_on=False` ⇒ 照采。
    add("deltaf/pll_off_allowed", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "num_points": 24, "require_pll_on": False,
         "channel_indexes": "3"},
        verbs=dict({"PLL_OutOnOffGet": [{"body": [0]}],
                    "PLL_CenterFreqGet": [{"body": [30012.5]}],
                    "PLL_FreqShiftGet": [{"body": [-1.25]}],
                    "PLL_AmpCtrlSetpntGet": [{"body": [5e-11]}]},
                   ZSpectr_Start=[{"body": zspectr_body(
                       ["Z rel (m)", "OC M1 Freq. Shift (Hz)"], [z, df])}]))
    add("deltaf/pll_unreadable", "AcquireDeltaFCurve", {"z_sweep_distance_m": 5e-10},
        verbs={"PLL_OutOnOffGet": [{"error": "NanonisError: NeedModule PLL"}]})
    # 按名字自动找三路：频移 / 电流 / 振幅。**振幅要同时像振荡控制器那一路**。
    NAMES = ["Bias (V)", "Current (A)", "Z (m)", "OC M1 Freq. Shift (Hz)",
             "Amplitude (V)", "OC M1 Amplitude (m)"]
    add("deltaf/auto_channels", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "num_points": 24},
        verbs=dict(PLL_ON, Signals_NamesGet=[{"body": [0, len(NAMES), NAMES]}],
                   **CH_OK))
    # 只有一个裸 "Amplitude"（没有振荡提示词）⇒ **不选它**。
    NAMES2 = ["Current (A)", "OC M1 Freq. Shift (Hz)", "Amplitude (V)"]
    add("deltaf/amplitude_needs_osc_hint", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "num_points": 24},
        verbs=dict(PLL_ON, Signals_NamesGet=[{"body": [0, len(NAMES2), NAMES2]}],
                   **CH_OK))
    add("deltaf/no_df_channel", "AcquireDeltaFCurve", {"z_sweep_distance_m": 5e-10},
        verbs=dict(PLL_ON, Signals_NamesGet=[{"body": [0, 2, ["Bias (V)", "Current (A)"]]}]))
    add("deltaf/names_unreadable", "AcquireDeltaFCurve", {"z_sweep_distance_m": 5e-10},
        verbs=dict(PLL_ON, Signals_NamesGet=[{"error": "连接被对端关闭"}]))
    add("deltaf/bad_channel_indexes", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "channel_indexes": "3;x"},
        verbs=dict(PLL_ON))
    # `;` 与 `,` 同义 —— 与 `ConfigureSTSChannels` 那一份**刻意不同**（D-CHANNELS-1）。
    add("deltaf/semicolon_is_a_separator", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "num_points": 24, "channel_indexes": "3;0;7"},
        verbs=dict(PLL_ON, **CH_OK))
    add("deltaf/start_failed", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "channel_indexes": "3"},
        verbs=dict(PLL_ON, ZSpectr_Start=[{"error": "连接被对端关闭"}]))
    # 块解不开 + 没找到 .dat ⇒ 失败（**两条都不成立才算没留下东西**）。
    add("deltaf/unparsable_and_no_dat", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "channel_indexes": "3"},
        verbs=dict(PLL_ON, ZSpectr_Start=[{"body": [0, 0, ["a"], 2, 2]}]))
    # 回程扫掠开关 ⇒ `ZSpectr_PropsSet` 的第一个实参 1/2。
    add("deltaf/no_backward_sweep", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "num_points": 24, "channel_indexes": "3",
         "backward_sweep": False},
        verbs=dict(PLL_ON, ZSpectr_Start=[{"body": zspectr_body(
            ["Z rel (m)", "OC M1 Freq. Shift (Hz)"], [z, df])}]))
    # z 偏移与调制器号照原样下发。
    add("deltaf/z_offset_and_modulator", "AcquireDeltaFCurve",
        {"z_sweep_distance_m": 5e-10, "z_offset_m": 3e-10, "modulator_index": 2,
         "num_points": 24, "channel_indexes": "3"},
        verbs=dict(PLL_ON, ZSpectr_Start=[{"body": zspectr_body(
            ["Z rel (m)", "OC M1 Freq. Shift (Hz)"], [z, df])}]))

    # ── RunGridExperiment（**墙钟会走**，见抬头）──────────────────────────
    GRID = {"nx": 3, "ny": 2, "center_x_m": 1e-8, "center_y_m": -2e-8,
            "width_m": 4e-8, "height_m": 3e-8, "angle_deg": 30.0}
    # 状态在第 3 拍变 0 ⇒ 提前退出，不用跑满 max_ticks。
    add("grid/finishes_early", "RunGridExperiment", dict(GRID, wait_timeout_s=60.0),
        verbs={"Pattern_ExpStatusGet": [{"body": [1]}, {"body": [1]}, {"body": [0]}]},
        clock_keys=["start_time"])
    # ⭐ 超时那一支 —— 这一格**只有在墙钟会走的时候才存在**。
    add("grid/timeout", "RunGridExperiment", dict(GRID, wait_timeout_s=10.0),
        verbs={"Pattern_ExpStatusGet": [{"body": [1]}]},
        clock_keys=["start_time"])
    # 超时时 `Pattern_ExpStop` 也失败 ⇒ 退到 `Pattern_ExpPause(1)`。
    add("grid/stop_falls_back_to_pause", "RunGridExperiment",
        dict(GRID, wait_timeout_s=10.0),
        verbs={"Pattern_ExpStatusGet": [{"body": [1]}],
               "Pattern_ExpStop": [{"error": "Pattern_ExpStop 不可用"}]},
        clock_keys=["start_time"])
    # 中止：阈值落在第 1 拍（2 s）与第 2 拍（4 s）之间 ⇒ 两侧一定在同一拍看见。
    add("grid/aborted_mid", "RunGridExperiment", dict(GRID, wait_timeout_s=60.0),
        verbs={"Pattern_ExpStatusGet": [{"body": [1]}]},
        clock_keys=["start_time"], abort_at_s=3.0)
    add("grid/setup_failed", "RunGridExperiment", dict(GRID, wait_timeout_s=10.0),
        verbs={"Pattern_GridSet": [{"error": "NanonisError: NeedModule Pattern"}]},
        clock_keys=["start_time"])
    add("grid/start_failed", "RunGridExperiment", dict(GRID, wait_timeout_s=10.0),
        verbs={"Pattern_ExpStart": [{"error": "连接被对端关闭"}]},
        clock_keys=["start_time"])
    add("grid/status_failed", "RunGridExperiment", dict(GRID, wait_timeout_s=60.0),
        verbs={"Pattern_ExpStatusGet": [{"body": [1]}, {"error": "连接被对端关闭"}]},
        clock_keys=["start_time"])
    # 最小 timeout ⇒ `max_ticks = max(1, …)` 那道下限（10/2 = 5，不是它；
    # 这里给 10.0 的一半不到的 `int()` 截断由 `wait_timeout_s=11` 那格在
    # `skill_traces.json` 里钉）。这一格钉的是 **1×1 网格**的 `total_points`。
    add("grid/single_point", "RunGridExperiment",
        {"nx": 1, "ny": 1, "wait_timeout_s": 60.0},
        verbs={"Pattern_ExpStatusGet": [{"body": [0]}]},
        clock_keys=["start_time"])

    # ── AcquireSignalPoint ────────────────────────────────────────────────
    def cur_body(v: float) -> dict:
        return {"body": [v]}

    # ⚠️ 四个读数**刻意取满有效位**：均值 1.0833e-10 在 `%.4g` 与 `%.3g` 下分别是
    # `1.083e-10` 与 `1.08e-10`。第一版给的是 1.0/1.2/0.9/1.1 ⇒ 均值 1.05e-10，
    # 两种写法印出同一个串 —— 摘要那道闸当场没有输入。
    add("point/current_only", "AcquireSignalPoint", {"samples": 4},
        verbs={"Current_Get": [cur_body(1.0e-10), cur_body(1.2345e-10),
                               cur_body(0.9876e-10), cur_body(1.1111e-10)]})
    add("point/single_sample_std_is_zero", "AcquireSignalPoint", {"samples": 1},
        verbs={"Current_Get": [cur_body(1e-10)]})
    add("point/signals_only", "AcquireSignalPoint",
        {"read_current": False, "signal_indices": "0,14", "samples": 3},
        verbs={"Signals_ValGet": [cur_body(0.1), cur_body(0.2), cur_body(0.3),
                                  cur_body(0.4), cur_body(0.5), cur_body(0.6)]})
    add("point/nothing_to_acquire", "AcquireSignalPoint",
        {"read_current": False, "signal_indices": ""})
    # 槽位串：重复、越界、负数、小数、垃圾 —— 一格全占。
    add("point/indices_dedup_and_range", "AcquireSignalPoint",
        {"signal_indices": "14, 14, 200, -3, 0, 7.5, x, 127", "samples": 1},
        verbs={"Current_Get": [cur_body(1e-10)],
               "Signals_ValGet": [cur_body(0.5)]})
    add("point/current_error", "AcquireSignalPoint", {"samples": 3},
        verbs={"Current_Get": [cur_body(1e-10), {"error": "连接被对端关闭"}]})
    add("point/signal_error", "AcquireSignalPoint",
        {"signal_indices": "0,14", "samples": 2},
        verbs={"Current_Get": [cur_body(1e-10)],
               "Signals_ValGet": [cur_body(0.5), {"error": "连接被对端关闭"}]})
    # 回包里一个数都没有 ⇒ 抛 → 被 execute 接住变成一句拒绝（旧仓印的是**信封**）。
    add("point/no_numeric_in_reply", "AcquireSignalPoint", {"samples": 1},
        verbs={"Current_Get": [{"body": []}]})
    # 嵌套一层的回包照样找得到那个数。
    add("point/nested_reply", "AcquireSignalPoint", {"samples": 1},
        verbs={"Current_Get": [{"body": [[2.5e-10]]}]})
    # ⭐ **先序**遍历：子节点插到队**头**，于是 `[[9e-10], 1e-10]` 给的是 9e-10。
    # 换成插队尾（后序）会给 1e-10 —— 上面那一格（只有一层嵌套）**两种走法同解**，
    # 分不开它们。这一格是唯一分得开的输入。
    add("point/nested_first_wins", "AcquireSignalPoint", {"samples": 1},
        verbs={"Current_Get": [{"body": [[9e-10], 1e-10]}]})
    # 间隔 0 ⇒ 一次 `sleep` 都不发（`if k and interval > 0`）。
    add("point/zero_interval", "AcquireSignalPoint",
        {"samples": 3, "sample_interval_s": 0.0},
        verbs={"Current_Get": [cur_body(1e-10)]})

    return cases


# ──────────────────────────────────────────────────────────────────────────
# 纯函数节
# ──────────────────────────────────────────────────────────────────────────


def _pure_sections() -> dict:
    out: dict[str, Any] = {}

    # `_fit_kappa`：拟合本体。**输入是 (退开, pA) 对，答案是 φ/κ/十倍程/残差**。
    fit_cases = {
        "phi_4eV": ([(d, iz_current_pa(4.0, 1000.0, d)) for d in DEFAULT_OFFSETS], 0.0),
        "phi_1eV": ([(d, iz_current_pa(1.0, 1000.0, d)) for d in DEFAULT_OFFSETS], 0.0),
        # 噪声底把最后两档砍掉 ⇒ n_fit 变小，而 φ 不变（拟合的是同一条直线）。
        "floor_cuts_tail": ([(d, iz_current_pa(4.0, 1000.0, d)) for d in DEFAULT_OFFSETS], 1.0),
        # 只剩 2 个 ⇒ None。
        "too_few": ([(0.0, 100.0), (0.1, 10.0), (0.2, 0.5)], 1.0),
        # 含 None 的档位（读不到）被跳过。
        "none_skipped": ([(0.0, 1000.0), (0.1, None), (0.2, 16.7), (0.3, 2.16),
                          (0.4, 0.28)], 0.0),
        # 斜率非负 ⇒ None（退开反而电流变大）。
        "slope_positive": ([(0.0, 10.0), (0.1, 20.0), (0.2, 40.0), (0.3, 80.0)], 0.0),
        # 恰好等于噪声底 ⇒ **不收**（`i > floor` 是严格大于）。
        "equal_to_floor_excluded": ([(0.0, 100.0), (0.1, 50.0), (0.2, 10.0),
                                     (0.3, 10.0)], 10.0),
        # 带一点残差 —— `fit_resid_rms` 那一格要有个非零的数。
        "with_residual": ([(0.0, 1000.0), (0.1, 130.0), (0.2, 17.5), (0.3, 2.0),
                           (0.4, 0.30)], 0.0),
    }
    out["fit_kappa"] = {}
    for name, (pts, floor) in fit_cases.items():
        fit, usable = _fit_kappa(pts, floor)
        out["fit_kappa"][name] = {
            "points": _jsonable(pts), "noise_floor_pa": floor,
            "fit": _jsonable(fit), "n_usable": len(usable),
        }

    # `_verdict`：三条判读 + 两条边界（3.0 与 1.0 **闭区间**）。
    #
    # ⚠️ 键**不能**用 `f"{phi:g}"`：`g` 只给 6 位有效数字，于是
    # `2.999999 → "3"`、`0.999999 → "1"` —— 两条边界各与它们要区分的那一格
    # **撞成同一个键**，后写的把先写的覆盖掉。第一版就是这么丢的：
    # 两条闭区间边界在金样里根本不存在，而对应的两条变异当场报绿。
    # **一个会把两格合成一格的键函数，等于把那道闸从金样里删了。**
    out["barrier_verdict"] = {
        name: {"phi_ev": phi, "verdict": _verdict(phi)[0], "message": _verdict(phi)[1]}
        for name, phi in {
            "vacuum_4eV": 4.0,
            "exactly_3eV_is_clean": 3.0,
            "just_below_3eV": 2.999999,
            "mid_contaminated": 1.5,
            "exactly_1eV_is_contaminated": 1.0,
            "just_below_1eV": 0.999999,
            "half_eV": 0.5,
            "zero": 0.0,
        }.items()
    }

    # `_rel_spread`：总体标准差 / 均值。
    out["rel_spread"] = {
        name: {"values": _jsonable(vals), "spread": _jsonable(_rel_spread(vals))}
        for name, vals in {
            "four": [1.0, 1.1, 0.9, 1.0],
            "identical": [1.0, 1.0, 1.0],
            "one_value": [1.0],
            "empty": [],
            "with_none": [1.0, None, 1.2],
            "one_after_none": [None, None, 1.0],
            "mean_is_zero": [-1.0, 1.0],
            "mean_is_negative": [-1.0, -2.0],
        }.items()
    }

    # `verdict_from`：两条边界都是**闭**的（≤2 / ≥3）。
    out["verdict_from"] = {
        name: {"site": s, "repeat": r,
               "verdict": verdict_from(s, r)[0], "ratio": _jsonable(verdict_from(s, r)[1])}
        # ⚠️ 两条边界的**除法必须精确**：`0.3 / 0.1 = 2.9999999999999996`，
        # 于是「正好 3」那一格根本不在 3 上，`>= 3` 与 `> 3` 同解 —— 变异报绿。
        # `0.75 / 0.25` 与 `0.2 / 0.1` 都是精确的二进制分数比（同批 7a-2
        # 「边界判据造在轴上」那一条：**一条会被最后一位掀翻的边界判据，不是判据**）。
        for name, (s, r) in {
            "ratio_1": (0.10, 0.10), "ratio_exactly_2": (0.20, 0.10),
            "ratio_2p5": (0.25, 0.10), "ratio_exactly_3": (0.75, 0.25),
            "ratio_5": (0.50, 0.10), "site_none": (None, 0.10),
            "repeat_none": (0.30, None), "repeat_zero": (0.30, 0.0),
            "repeat_negative": (0.30, -0.1),
        }.items()
    }

    # `setpoints_for`：恒结阻 + 两侧夹紧。
    out["setpoints_for"] = {
        name: {"biases": _jsonable(b), "r_ohm": r,
               "plan": [{"bias_v": x, "setpoint_a": y, "clamped": c}
                        for x, y, c in setpoints_for(b, r)]}
        for name, (b, r) in {
            "in_range": ([2.0, 1.0, -1.0, -2.0], 1e11),
            "clamped_low": ([0.01, -0.01, 2.0], 1e13),
            "clamped_high": ([5.0, -5.0, 0.5], 1e8),
            # 正好落在界上 ⇒ `abs(sp − want) > 1e-15` 为假 ⇒ **不算夹过**。
            "exactly_at_lower": ([0.5], 1e11),
            "exactly_at_upper": ([50.0], 1e11),
        }.items()
    }

    # `parse_indices` / `mean_std`：`AcquireSignalPoint` 那两件。
    out["parse_indices"] = {
        name: {"text": t, "indices": parse_indices(t)}
        for name, t in {
            "plain": "0,14", "spaces": " 0   14 ", "dedup": "14,14,0",
            "out_of_range": "-1,128,200,0", "boundaries": "0,127",
            "float_literal": "7.5,3", "junk": "x,y", "empty": "",
            "mixed_separators": "0, 14 7",
        }.items()
    }
    out["mean_std"] = {
        name: {"values": _jsonable(v), "mean_std": _jsonable(list(mean_std(v)))}
        for name, v in {
            "four": [1.0, 2.0, 3.0, 4.0], "one": [5.0], "two": [1.0, 2.0],
            "identical": [2.0, 2.0, 2.0],
        }.items()
    }

    # `phase_shift`：15 行的本体。**零 I/O、零 RANSAC** —— 帧直接给。
    PITS = [(8, 9), (20, 22), (25, 6)]
    base32 = pit_frame(32, PITS)
    # **特征完全不同的一帧** —— 相关峰塌成一片，`snr` 掉到 `_MIN_CORR_SNR` 以下。
    # （「一块很平的地」造不出低 SNR：相位相关对**同一幅图的平移**永远给一个尖峰，
    # 哪怕幅度只有 1 pm。低 SNR 说的是「两帧之间没有可对齐的共同特征」，
    # 那就得真的把特征换掉 —— 正是「坑跑出视野」在数据上的样子。）
    # ⚠️ **另一个 seed**：这一格要的是「两帧没有共同特征」，而共用同一层噪声
    # 会让它们在 (0,0) 上强相关 —— 那就变成「同一幅图」了。
    other32 = pit_frame(32, [(3, 28), (14, 2), (29, 17)], seed=5)
    base16 = pit_frame(16, [(4, 5), (11, 12)])
    nan32 = [row[:] for row in base32]
    nan32[3][4] = {"__nan__": True}
    shift_cases = {
        "identity": (base32, base32),
        "shift_x_plus5": (base32, roll2(base32, 0, 5)),
        "shift_y_minus3": (base32, roll2(base32, -3, 0)),
        "shift_xy": (base32, roll2(base32, 4, 7)),
        # 位移落在 fftshift 区间的**正端点**（`+15 = n//2 − 1`）。
        "shift_to_positive_edge": (base32, roll2(base32, 0, 15)),
        "uncorrelated_low_snr": (base32, other32),
        "size_16_is_allowed": (base16, roll2(base16, 0, 3)),
        "with_nan": (nan32, roll2(base32, 0, 5)),
        # ⭐ **边长是奇数**的唯一一格。`fftshift` 的方向（`roll(+n//2)` 还是
        # `roll(−n//2)`）在偶数边长上**给同一个答案**（`+n/2 ≡ −n/2 mod n`），
        # 于是那道闸在全是 2 的幂的金样上没有输入 —— 第一版的变异因此报绿。
        # 17 不是 2 的幂，走 Bluestein（**不是**朴素 DFT），精度仍然是 `O(eps·log N)`。
        "odd_side_17": (pit_frame(17, [(4, 5), (12, 11)], seed=3),
                        roll2(pit_frame(17, [(4, 5), (12, 11)], seed=3), 2, 3)),
        # ⭐ **直流远大于起伏**（偏置 1e4，坑深 1）。这是 `np.nanmean` 里那句
        # 「成对求和」唯一分得开两种写法的输入：顺序累加在 1024 个 1e4 上
        # 攒出的绝对误差约 `1024·eps·1e7 ≈ 2e−6`，除以 N 之后落在均值上约 `2e−9`，
        # 而扣掉均值之后的起伏是 O(1) ⇒ 相对误差 `2e−9`，比 `phaseShiftSnrRelTol`
        # 大四个数量级。别的格上两种写法**同解**（偏置已经被去掉了）。
        #
        # 它也是一个**真实**的输入：`.sxm` 里的 Z 是绝对高度，直流比起伏大好几个
        # 数量级。（当前唯一的调用方 `CalibrateCoarseStep` 在喂进来之前扣过平面，
        # 所以它看不到这一格 —— 但 `phaseShift` 是一个**原语**，它没有承诺入参无直流。）
        "dc_offset_swamps_the_corrugation": (
            pit_frame(32, PITS, offset=1.0e4),
            roll2(pit_frame(32, PITS, offset=1.0e4), 0, 5),
        ),
    }
    out["phase_shift"] = {}
    for name, (a, b) in shift_cases.items():
        am = np.asarray(_materialise(a), dtype=float)
        bm = np.asarray(_materialise(b), dtype=float)
        dx, dy, snr = phase_shift(am, bm)
        out["phase_shift"][name] = {
            "a": _jsonable(a), "b": _jsonable(b),
            "dx": _jsonable(dx), "dy": _jsonable(dy), "snr": _jsonable(snr),
        }
    # 两格 `None`：边长 < 16、形状对不上。**输入只记形状**（帧本身没有判据）。
    small = pit_frame(8, [(2, 3)])
    out["phase_shift"]["side_15_refused"] = {
        "a": _jsonable(pit_frame(15, [(4, 5)])), "b": _jsonable(pit_frame(15, [(4, 5)])),
        "dx": None, "dy": None, "snr": None,
    }
    out["phase_shift"]["shape_mismatch"] = {
        "a": _jsonable(base16), "b": _jsonable(small), "dx": None, "dy": None, "snr": None,
    }

    return out


def _validate_section(by_name: dict) -> dict:
    """`validate_params` 的答案。**导出的通用驱动器直调 `execute`，从不调它** ——
    于是这一节是它唯一的金样。"""
    out: dict[str, Any] = {}
    for skill_name, cases in {
        "MapBarrierHeight": {
            "ok": {"sites_nm": "0,0; 1,1; 2,2; 3,3"},
            "bad_items": {"sites_nm": "0; 1,2; x,y"},
            "too_few": {"sites_nm": "0,0; 1,1"},
            "empty": {"sites_nm": ""},
            # 解析不了**优先**报（`elif`）—— 两条都不满足时只说第一句。
            "bad_and_too_few": {"sites_nm": "0"},
        },
        "AcquireBiasSeries": {
            "ok": {"center_x_m": 0.0, "center_y_m": 0.0, "size_m": 2e-8,
                   "biases_v": "1,-1"},
            "bad": {"center_x_m": 0.0, "center_y_m": 0.0, "size_m": 2e-8,
                    "biases_v": "1,x"},
            "too_few": {"center_x_m": 0.0, "center_y_m": 0.0, "size_m": 2e-8,
                        "biases_v": "1"},
            "has_zero": {"center_x_m": 0.0, "center_y_m": 0.0, "size_m": 2e-8,
                         "biases_v": "1,0,-1"},
            # 两条一起报（不是 elif）。
            "too_few_and_zero": {"center_x_m": 0.0, "center_y_m": 0.0, "size_m": 2e-8,
                                 "biases_v": "0"},
            "empty": {"center_x_m": 0.0, "center_y_m": 0.0, "size_m": 2e-8,
                      "biases_v": ""},
        },
    }.items():
        cls = by_name.get(skill_name)
        if cls is None:
            continue
        skill = cls()
        out[skill_name] = {}
        for tag, params in cases.items():
            errs = list(skill.validate_params(dict(params)) or [])
            # ⚠️ 只留**本技能自己加的那几条**：`BaseSkill.validate_params` 是框架的
            # 通用类型／范围检查，它的措辞不是这一批的判据（而且它会因为缺必填项
            # 报一串与这里无关的话）。
            #
            # **按集合差算，不按关键词猜**：第一版写的是「含 `sites_nm` 的留下」，
            # 于是「至少要 4 个位置才算得出可信的空间散布」整条被滤掉了 ——
            # 而那正是这个技能最重要的一条。
            base = set(BaseSkill.validate_params(skill, dict(params)) or [])
            own = [e for e in errs if e not in base]
            out[skill_name][tag] = {"params": _jsonable(params), "errors": own,
                                    "n_all": len(errs), "n_base": len(base)}
    return out


# ──────────────────────────────────────────────────────────────────────────


def main() -> int:
    reg = SkillRegistry()
    reg.discover()
    by_name = {n: list(v.values())[-1] for n, v in reg.snapshot_names().items()}

    skills: dict[str, Any] = {}
    for case in _skill_cases():
        name = case["name"]
        cls = by_name.get(case["skill"])
        if cls is None:
            print(f"[warn] 注册表里找不到 {case['skill']}", file=sys.stderr)
            continue
        _CLOCK[0] = 1_000_000.0
        # 组合技能会往 `experiments/composite_progress/` 落断点，而假 context
        # 没有 run_id ⇒ 所有用例共用同一个文件。不清的话上一格的进度会被下一格
        # 捡起来**续跑**。
        try:
            from mast.skills.composite.graph_executor import _sidecar_dir
            for f in _sidecar_dir().glob("*"):
                f.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        ctx = _ScriptedContext(case["verbs"], case["runs"], case.get("abort_at_s"))
        skill = cls()
        try:
            res = skill.execute(ctx, dict(case["params"]))
            rec = _result(res)
        except Exception as exc:  # noqa: BLE001 —— 抛出来本身就是一条判据
            rec = {"raised": f"{type(exc).__name__}: {exc}"}
        print(f"  … {name}", file=sys.stderr, flush=True)
        skills[name] = {
            "skill": case["skill"],
            "params": _jsonable(case["params"]),
            "verbs": _jsonable(case["verbs"]),
            "runs": _jsonable(case["runs"]),
            "abort_at_s": case.get("abort_at_s"),
            "clock_keys": list(case["clock_keys"]),
            "calls": ctx.calls,
            "run_log": ctx.run_log,
            "result": rec,
        }

    out: dict[str, Any] = {"skills": skills}
    out.update(_pure_sections())
    out["validate"] = _validate_section(by_name)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    n_pure = sum(len(v) for k, v in out.items() if k not in ("skills", "validate"))
    print(f"[ok]   batch7b2.json: {len(skills)} 格技能 + {n_pure} 格纯函数 "
          f"+ {sum(len(v) for v in out['validate'].values())} 格 validate")
    raised = [k for k, v in skills.items() if "raised" in v["result"]]
    if raised:
        print(f"[note] {len(raised)} 格抛了异常（也是判据）：{', '.join(raised[:8])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
