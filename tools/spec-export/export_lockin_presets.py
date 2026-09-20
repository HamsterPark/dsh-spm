r"""Lock-in 参数组的**应用**与**相位自动对齐** —— 逐格驱动旧仓真实现。

通用驱动器（`export_skill_traces.py`）到不了这两个技能真正要紧的那些格子：

* `ApplyLockInPreset` 走的是 `context.run(...)`，而通用假 context 的 `run` 回的是
  空 `data` ⇒ 每一趟都落在「读不回来」。于是**回读比对**那一整块（缺陷⑩ 的键名、
  float32 量化、`values_match` 的相对容差）一格都没录到。
* `AutoPhase` 在通用驱动下停在「不知道 X/Y 在哪一路」——出厂档案里那两个键是空的。
  于是 `atan2`、噪声底判据、缺陷⑪ 的收尾关调制、以及中止时**什么都不写**，
  同样一格都没录到。

两份金样的价值在于它们**不一样**：通用那份录的是「没配置的机器上会怎样」，
这一份录的是「配好之后每一条判据分别说什么」。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_lockin_presets.py
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

# 相位对齐要在取样窗里转几圈。真时间上那是 3 秒 × 每格 —— 假钟让它按自己的逻辑
# 走完、按自己的次数调用，只是不占墙钟（同 `export_skill_traces.py`）。
import time as _time

_CLOCK = [1_000_000.0]


def _fake_sleep(sec: float) -> None:
    _CLOCK[0] += max(float(sec), 0.0)


def _fake_monotonic() -> float:
    _CLOCK[0] += 1e-3
    return _CLOCK[0]


_time.sleep = _fake_sleep          # type: ignore[assignment]
_time.monotonic = _fake_monotonic  # type: ignore[assignment]

MAST_ROOT = require_mast_root()
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "lockin_presets.json"

sys.path.insert(0, str(MAST_ROOT))

from mast.core.types import NanonisCallRecord, SkillResult  # noqa: E402
import mast.core.instrument_profile as iprof  # noqa: E402
import mast.core.lockin_presets as lp  # noqa: E402
import mast.skills.builtins.lockin_presets_skills as ls  # noqa: E402


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


#: 本机的 lock-in 档案。**两个键都是出厂默认**（973 Hz / 0.02 V）——
#: 这正是 D-LOCKIN-2 说的那件事：`sanitize()` 丢掉空值 ⇒ `get_config` 永远给得出数
#: ⇒ `unset` 那一支在旧仓里走不到。显式摆出来，好让金样自带它的前提。
PROFILE = {"lockin_mod_freq_hz": 973.0, "lockin_mod_amp_v": 0.02}

#: float32 量化后的回读值。硬件按 float32 打包，请求 0.02 回来就是这个数 ——
#: **相对差 2e-8，而相等比较会把它判成失败**（D-READBACK-1）。
AMP_F32 = 0.019999999552965164
FREQ_F32 = 973.0


def _set_profile(p: "dict | None") -> None:
    iprof.set_profile(dict(p or {}))


# ──────────────────────────────────────────────────────────────────────────
# ApplyLockInPreset：子技能返回什么，由每一格自己说
# ──────────────────────────────────────────────────────────────────────────


class _RunCtx:
    """只有 `run` 的假 context —— `ApplyLockInPreset` 一条裸动词都不发。"""

    def __init__(self, results: "dict[str, SkillResult]"):
        self.results = results
        self.runs: "list[dict]" = []

    def run(self, skill_name: str, params: dict, version: "str | None" = None) -> SkillResult:
        self.runs.append({"skill": skill_name, "params": _plain(params)})
        return self.results.get(
            skill_name,
            SkillResult(skill_name=skill_name, success=True, data={}))


def _ok(name: str, data: dict) -> SkillResult:
    return SkillResult(skill_name=name, success=True, data=data)


def _err(name: str, msg: str) -> SkillResult:
    return SkillResult(skill_name=name, success=False, error=msg)


APPLY: "dict[str, Any]" = {}


def apply_case(key: str, *, params: dict, profile: "dict | None",
               results: "dict[str, SkillResult]") -> None:
    _set_profile(profile)
    ctx = _RunCtx(results)
    r = ls.ApplyLockInPreset().execute(ctx, dict(params))
    APPLY[key] = {
        "params": _plain(params),
        "runs": ctx.runs,
        "success": bool(r.success),
        "error": str(r.error or ""),
        "data": _plain(r.data or {}),
    }


#: 一份**读得回来**的 `GetLockInConfig`。键名照旧仓真实现：幅度那一格叫
#: `amplitude`（无单位后缀），而组里那个参数叫 `amplitude_v` —— 缺陷⑩ 就在这条缝上。
READBACK_OK = {"modulator": 1, "mod_on": True, "amplitude": AMP_F32,
               "frequency_hz": FREQ_F32, "phase_deg": 0.0,
               "modulated_signal": 24, "harmonic": 1}

apply_case(
    "ok", params={}, profile=PROFILE,
    results={"GetLockInConfig": _ok("GetLockInConfig", READBACK_OK)})

apply_case(
    "mod_off", params={"mod_on": False}, profile=PROFILE,
    results={"GetLockInConfig": _ok("GetLockInConfig", READBACK_OK)})

# 幅度回来的是请求值的两倍 —— 硬件没收下这个值。
apply_case(
    "readback_mismatch", params={}, profile=PROFILE,
    results={"GetLockInConfig": _ok(
        "GetLockInConfig", {**READBACK_OK, "amplitude": 0.04})})

# **缺陷⑩ 本身**：回包里的键叫 `amplitude_v` 而不是 `amplitude` ⇒ 查不到
# ⇒ 一次成功的写入被报成「读不回来」。这一格钉的是那张映射表。
apply_case(
    "readback_key_renamed", params={}, profile=PROFILE,
    results={"GetLockInConfig": _ok(
        "GetLockInConfig",
        {k: v for k, v in READBACK_OK.items() if k != "amplitude"} | {"amplitude_v": AMP_F32})})

apply_case(
    "configure_failed", params={}, profile=PROFILE,
    results={"ConfigureLockIn": _err("ConfigureLockIn", "LockIn_ModAmpSet failed: 链路已断")})

apply_case(
    "readback_command_failed", params={}, profile=PROFILE,
    results={"GetLockInConfig": _err("GetLockInConfig", "链路已断")})

apply_case("unknown_preset", params={"preset": "iv"}, profile=PROFILE, results={})

# ⚠️ **这一格本来想录「档案一个键都没配 ⇒ 拒绝并指路」，而它录不到。**
#
# `set_profile({})` 之后 `get_config` 照旧给出 973 / 0.02 —— 那是 `_CONFIG_SPEC` 里的
# **出厂默认**，而 `sanitize()` 又把空值丢掉，于是这两个键**永远在**。
# ⇒ `ResolvedLockInPreset.usable` 恒为 True，`why()` 的否定支与
#   `ApplyLockInPreset` 的 `if not preset.usable` 都是**死代码**，
#   而模块 docstring 里「档案没填的键不下发」这句话从来没有机会执行。
#
# 这一格于是变成那件事的**证据**：它的返回里带着两个没人配过的数，
# 而 `sources` 说它们来自「仪器档案」。留着它，名字说清它录到的是什么（D-LOCKIN-2）。
apply_case("profile_cleared_still_has_factory_defaults", params={}, profile={}, results={})


# ──────────────────────────────────────────────────────────────────────────
# AutoPhase：X/Y 的样本、当前相位、写与回读，逐格脚本化
# ──────────────────────────────────────────────────────────────────────────


class _PhaseCtx:
    """按动词脚本化的假 context。

    `Signals_ValsGet` 回 `["i", "*f"]` 的形状（先长度再数组），
    `LockIn_DemodPhasGet` 回写进去的那个值（除非这一格说要回别的）。
    """

    def __init__(self, *, samples: "list[tuple[float, float]]",
                 phase: "float | None" = 0.0,
                 fail: "set[str] | None" = None,
                 abort_after: "int | None" = None,
                 readback: "float | None" = None,
                 mod_on_after: "int | None" = 0):
        self.samples = samples
        self.phase = phase
        self.fail = fail or set()
        self.abort_after = abort_after
        self.readback = readback
        self.mod_on_after = mod_on_after
        self.calls: "list[dict]" = []
        self.written: "float | None" = None
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
        if method_name == "Signals_ValsGet":
            i = min(len([c for c in self.calls if c["verb"] == "Signals_ValsGet"]) - 1,
                    len(self.samples) - 1)
            x, y = self.samples[i] if self.samples else (0.0, 0.0)
            rec.return_value = ("", b"", [2, [x, y]])
        elif method_name == "LockIn_DemodPhasGet":
            if self.written is None:
                v = self.phase
            else:
                v = self.readback if self.readback is not None else self.written
            rec.return_value = ("", b"", []) if v is None else ("", b"", [v])
        elif method_name == "LockIn_DemodPhasSet":
            self.written = float(args[1])
            rec.return_value = ("", b"", [])
        elif method_name == "LockIn_ModOnOffGet":
            rec.return_value = (("", b"", []) if self.mod_on_after is None
                                else ("", b"", [self.mod_on_after]))
        else:
            rec.return_value = ("", b"", [])
        return rec


PHASE: "dict[str, Any]" = {}

#: 采三个点，**三个都不一样** —— 好让 `_sd` 报出一个非零的抖动。
#: 全一样的样本会让标准差恒为 0，于是那一格测的是「0 等于 0」。
SIGNAL = [(2.0e-9, 1.0e-9), (2.2e-9, 1.1e-9), (1.8e-9, 0.9e-9)]
#: 噪声底：|R| ≈ 1.4e-15，远在 1e-12 的下界之下。
NOISE = [(1.0e-15, 1.0e-15)]


def phase_case(key: str, *, params: dict, ctx: _PhaseCtx) -> None:
    _set_profile(PROFILE)
    r = ls.AutoPhase().execute(ctx, dict(params))
    PHASE[key] = {
        "params": _plain(params),
        "calls": ctx.calls,
        "success": bool(r.success),
        "error": str(r.error or ""),
        "data": _plain(r.data or {}),
    }


BASE = {"window_s": 0.3, "demodulator": 1, "x_signal_index": 86, "y_signal_index": 87}

phase_case("signal_to_x", params=BASE, ctx=_PhaseCtx(samples=SIGNAL))
phase_case("crosstalk_to_y", params={**BASE, "mode": "crosstalk_to_y"},
           ctx=_PhaseCtx(samples=SIGNAL))

# **折叠跨零**：当前 −170°、增量 −90° ⇒ 和是 −80，而 Python 的 `%` 取模、
# JS 的 `%` 取余 —— 一个给 +100°，另一个给 −260°。这一格就是那道坎。
phase_case("fold_negative", params={**BASE, "mode": "crosstalk_to_y"},
           ctx=_PhaseCtx(samples=[(1.0e-9, 0.0)], phase=-170.0))

phase_case("noise_floor", params=BASE, ctx=_PhaseCtx(samples=NOISE))
phase_case("no_samples", params=BASE,
           ctx=_PhaseCtx(samples=SIGNAL, fail={"Signals_ValsGet"}))
phase_case("no_current_phase", params=BASE,
           ctx=_PhaseCtx(samples=SIGNAL, fail={"LockIn_DemodPhasGet"}))
phase_case("write_failed", params=BASE,
           ctx=_PhaseCtx(samples=SIGNAL, fail={"LockIn_DemodPhasSet"}))
# 写进去 X，回读是别的数 ⇒ **不要按已对齐继续**。
phase_case("readback_mismatch", params=BASE,
           ctx=_PhaseCtx(samples=SIGNAL, readback=12.5))
# 中止：相位没改、**调制也不碰**（此刻可能正有一套急停序列在跑）。
phase_case("aborted", params=BASE, ctx=_PhaseCtx(samples=SIGNAL, abort_after=1))
# 收尾关调制失败 / 关了但回读不到 —— 三态里的另外两态。
phase_case("close_failed", params=BASE,
           ctx=_PhaseCtx(samples=SIGNAL, fail={"LockIn_ModOnOffSet"}))
phase_case("close_unconfirmed", params=BASE,
           ctx=_PhaseCtx(samples=SIGNAL, mod_on_after=None))
# 关了，回读却仍是开着。
phase_case("close_still_on", params=BASE,
           ctx=_PhaseCtx(samples=SIGNAL, mod_on_after=1))
# 索引只给了一半 —— 拒绝，而且**一次硬件调用都不发**。
phase_case("half_indices", params={**BASE, "y_signal_index": None},
           ctx=_PhaseCtx(samples=SIGNAL))

_set_profile(None)


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_lockin_presets.py 生成——"
                 "驱动旧仓真实的 lockin_presets 三件套。",
        "constants": {
            "preset_didv": lp.PRESET_DIDV,
            "reserved_names": list(lp.RESERVED_NAMES),
            "profile_keys": {k: v[0] for k, v in lp._PROFILE_KEYS.items()},
            "readback_keys": dict(ls._READBACK_KEYS),
            "min_signal": ls.AutoPhase._MIN_SIGNAL,
            "poll_interval_s": ls.AutoPhase._poll_interval_s,
            "profile_fixture": PROFILE,
            "amplitude_float32": AMP_F32,
        },
        "apply": APPLY,
        "phase": PHASE,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    print(f"✓ {OUT.relative_to(REPO)}：{len(APPLY)} 格应用 · {len(PHASE)} 格相位")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
