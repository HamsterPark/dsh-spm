r"""真空互锁与温度源的**判定机**金样 —— 逐格驱动旧仓真实现。

通用驱动器（`export_skill_traces.py`）到不了这两个子系统真正要紧的那些格子：
`GetChamberPressure` 一次 Nanonis 调用都不发，于是注错点、空 body、回读失配
那三套开关一个都碰不到它；整个技能只剩 `ok` 一格，而它录的是**某一种**压强下的
某一个答案。可这两个模块的全部内容恰恰是「答案会因为什么而不同」：

* 六条拒绝按「哪一句最有用」排序，顺序本身是判据（状态先于单位、单位先于年龄）；
* 超量程与**欠**量程是两件事，而欠量程还要再分「这只规的下限够不够低」；
* 三种模式（`gauge_or_attest` / `gauge_only` / `off`）对同一份读数给三个答案，
  而 `off` 那一支**照样算出判据**，只是不阻断；
* 签署有活的、过期的、以及「在 `gauge_only` 下压根不认」三态；
* 温度那边六个 reason 里有四个只在特定通道组合下才产生。

所以这一份单独录：**输入摆在旁边，答案逐字**。TS 那侧照着重放，
比的是判定机本身，而不是某一次调用碰巧走到的那条分支。

    python \
        tools/spec-export/export_environment.py
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "environment.json"

sys.path.insert(0, str(MAST_ROOT))

import mast.core.temperature as temp  # noqa: E402
import mast.core.vacuum_interlock as vac  # noqa: E402

#: 与 `export_skill_traces.py` 的假墙钟同一个数。所有年龄都相对它算。
NOW_S = 1_700_000_000.0
NOW_ISO = "2023-11-14T22:13:20+00:00"
NOW_DT = dt.datetime.fromisoformat(NOW_ISO)


def _at(age_s: float) -> str:
    """`age_s` 秒之前的那个时刻，ISO。"""
    return (NOW_DT - dt.timedelta(seconds=age_s)).isoformat()


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, float):
        # JSON 没有这三个值。用记号串录出去，TS 那侧照着解回来 ——
        # 丢掉它们等于把 `to_pascal` 那道 `inf` 过滤器的金样一起丢掉。
        if v != v:
            return "NaN"
        if v == float("inf"):
            return "Infinity"
        if v == float("-inf"):
            return "-Infinity"
        return v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    return str(v)


# ── 1. 单位换算 ──────────────────────────────────────────────────────────────
#
# 表里没有的一律 `None`。一个缺省倍数 1.0 会把 `1e-3 mbar`（安全）
# 与 `1 mbar`（带正中）放进同一个桶里。
TO_PASCAL_CASES: list[dict] = [
    {"value": v, "unit": u}
    for v, u in [
        (1.0, "Pa"), (1.0, "pa"), (1.0, " PASCAL "), (1.0, "mbar"), (1.0, "millibar"),
        (1.0, "hPa"), (1.0, "bar"), (1.0, "Torr"), (1.0, "mmHg"), (1.0, "mTorr"),
        (1.0, "micron"), (1e-3, "mbar"), (1.0, "psi"), (1.0, ""), (1.0, "K"),
        ("1e-3", "Pa"), ("", "Pa"), (None, "Pa"), ("abc", "Pa"),
        (float("inf"), "Pa"), (float("nan"), "Pa"), (0.0, "Pa"), (-1.0, "Pa"),
    ]
]

# ── 2. 量程配置体检 ──────────────────────────────────────────────────────────
GAUGE_CONFIG_CASES: list[dict] = [
    # DL-7 出厂：下限远低于上限、满量程足够高 ⇒ 没问题
    {"min_pa": 5e-8, "full_scale_pa": 1e-1, "max_pa": 1e-2},
    # 两个 0：不做体检（还没配）
    {"min_pa": 0.0, "full_scale_pa": 1e-1, "max_pa": 1e-2},
    {"min_pa": 5e-8, "full_scale_pa": 0.0, "max_pa": 1e-2},
    # 上下限填反
    {"min_pa": 1e-1, "full_scale_pa": 5e-8, "max_pa": 1e-2},
    # Pirani：下限高于放行上限 ⇒ **永远**证明不了
    {"min_pa": 0.5, "full_scale_pa": 1e5, "max_pa": 1e-2},
    # 满量程太低：还没到放行上限就算超量程
    {"min_pa": 1e-4, "full_scale_pa": 1e-2, "max_pa": 1e-2},
    # 恰好卡在 0.8 × 满量程 = 上限 的那一点（`<=` 的边界）
    {"min_pa": 1e-6, "full_scale_pa": 1.25e-2, "max_pa": 1e-2},
]

# ── 3. 规裁决：六条拒绝 + 放行，逐条 ─────────────────────────────────────────
_DL7 = {"sensor_name": "Chamber", "sensor_class": "DL7VacuumSensor"}
GAUGE_VERDICT_CASES: list[dict] = [
    {"name": "no_sample", "sample": None, "cfg": {}},
    {"name": "placeholder", "cfg": {},
     "sample": {"value": 0.0, "unit": "mbar", "status": "ok", "timestamp": _at(1),
                "sensor_name": "Vacuum", "sensor_class": "PlaceholderSensor"}},
    {"name": "unknown_class", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "ok", "timestamp": _at(1),
                "sensor_name": "Chamber", "sensor_class": "MysteryGauge"}},
    # 类名是空串 ⇒ **不拦**（只有说得出名字的陌生类才拦）
    {"name": "blank_class", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "ok", "timestamp": _at(1),
                "sensor_name": "Chamber", "sensor_class": ""}},
    {"name": "status_unavailable", "cfg": {},
     "sample": {"value": 0.0, "unit": "Pa", "status": "unavailable",
                "timestamp": _at(1), **_DL7}},
    {"name": "status_error", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "error",
                "timestamp": _at(1), **_DL7}},
    # warning / alarm 在**真空**这边是拒绝（与温度那边刻意相反 —— 见交接件）
    {"name": "status_warning", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "warning",
                "timestamp": _at(1), **_DL7}},
    {"name": "status_blank", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "", "timestamp": _at(1), **_DL7}},
    {"name": "bad_unit", "cfg": {},
     "sample": {"value": 1e-3, "unit": "psi", "status": "ok", "timestamp": _at(1), **_DL7}},
    {"name": "bad_value", "cfg": {},
     "sample": {"value": "低", "unit": "Pa", "status": "ok", "timestamp": _at(1), **_DL7}},
    {"name": "no_timestamp", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "ok", "timestamp": "", **_DL7}},
    {"name": "bad_timestamp", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "ok",
                "timestamp": "昨天下午", **_DL7}},
    {"name": "stale", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "ok", "timestamp": _at(3600), **_DL7}},
    # 年龄恰好等于上限 ⇒ 放行（`>` 而不是 `>=`）
    {"name": "age_exactly_limit", "cfg": {},
     "sample": {"value": 1e-3, "unit": "Pa", "status": "ok", "timestamp": _at(60), **_DL7}},
    {"name": "over_range", "cfg": {},
     "sample": {"value": 9e-2, "unit": "Pa", "status": "ok", "timestamp": _at(5), **_DL7}},
    # 恰好 0.8 × 满量程 ⇒ 算超量程（`>=`）
    {"name": "over_range_exact", "cfg": {},
     "sample": {"value": 8e-2, "unit": "Pa", "status": "ok", "timestamp": _at(5), **_DL7}},
    # 欠量程 · DL-7：下限 5e-8 远低于上限 1e-2 ⇒ **放行**
    {"name": "under_range_safe", "cfg": {},
     "sample": {"value": 4e-8, "unit": "Pa", "status": "ok", "timestamp": _at(5), **_DL7}},
    # 欠量程 · Pirani：下限 0.5 高于上限 ⇒ **拒绝**（这是换规才暴露的那一半）
    {"name": "under_range_rough",
     "cfg": {"min_pa": 0.5, "full_scale_pa": 1e5},
     "sample": {"value": 0.5, "unit": "Pa", "status": "ok", "timestamp": _at(5), **_DL7}},
    {"name": "too_high", "cfg": {},
     "sample": {"value": 5e-2, "unit": "Pa", "status": "ok", "timestamp": _at(5),
                **_DL7, "sensor_class": "DL7VacuumSensor"},
     },
    # 高于上限但**还没进**放电带（尾注那一句的开关）
    {"name": "above_limit_below_band",
     "cfg": {"full_scale_pa": 1e5, "max_pa": 1e-2},
     "sample": {"value": 5e-2, "unit": "Pa", "status": "ok", "timestamp": _at(5), **_DL7}},
    # 在放电带正中
    {"name": "inside_band",
     "cfg": {"full_scale_pa": 1e5, "max_pa": 1e-2},
     "sample": {"value": 1.0, "unit": "Pa", "status": "ok", "timestamp": _at(5), **_DL7}},
    # 大气：带的**上**面，物理上其实安全，而互锁照样拒 —— 它只认证据
    {"name": "atmosphere",
     "cfg": {"full_scale_pa": 1e6, "max_pa": 1e-2},
     "sample": {"value": 1013.0, "unit": "mbar", "status": "ok",
                "timestamp": _at(5), **_DL7}},
    # mbar 报的一个好真空（1e-5 mbar = 1e-3 Pa）
    {"name": "good_in_mbar", "cfg": {},
     "sample": {"value": 1e-5, "unit": "mbar", "status": "ok",
                "timestamp": _at(12), **_DL7}},
    # 压强恰好等于上限 ⇒ 放行（`>` 而不是 `>=`）
    {"name": "exactly_limit", "cfg": {},
     "sample": {"value": 1e-2, "unit": "Pa", "status": "ok", "timestamp": _at(5), **_DL7}},
]

# ── 4. 整个互锁：模式 × 签署 ─────────────────────────────────────────────────
_GOOD = {"value": 1e-3, "unit": "Pa", "status": "ok", "timestamp": _at(12), **_DL7}
_DEAD = {"value": 0.0, "unit": "Pa", "status": "unavailable", "timestamp": _at(3), **_DL7}
_LIVE_ATT = {"reason": "vented_to_atmosphere", "signed_by": "操作员甲",
             "signed_at": NOW_S - 2 * 3600.0, "ttl_s": 8 * 3600.0, "note": ""}
_EXPIRED_ATT = {"reason": "high_vacuum_gauge_unavailable", "signed_by": "",
                "signed_at": NOW_S - 9 * 3600.0, "ttl_s": 8 * 3600.0, "note": ""}
ASSESS_CASES: list[dict] = [
    {"name": "gauge_ok", "sample": _GOOD, "mode": "gauge_or_attest", "att": None},
    {"name": "gauge_ok_with_att", "sample": _GOOD, "mode": "gauge_or_attest",
     "att": _LIVE_ATT},
    {"name": "dead_no_att", "sample": _DEAD, "mode": "gauge_or_attest", "att": None},
    {"name": "dead_live_att", "sample": _DEAD, "mode": "gauge_or_attest",
     "att": _LIVE_ATT},
    {"name": "dead_expired_att", "sample": _DEAD, "mode": "gauge_or_attest",
     "att": _EXPIRED_ATT},
    {"name": "none_live_att", "sample": None, "mode": "gauge_or_attest",
     "att": _LIVE_ATT},
    # `gauge_only`：签署在这个模式下**不认**，而且要说出来
    {"name": "gauge_only_dead", "sample": _DEAD, "mode": "gauge_only", "att": None},
    {"name": "gauge_only_with_att", "sample": _DEAD, "mode": "gauge_only",
     "att": _LIVE_ATT},
    {"name": "gauge_only_ok", "sample": _GOOD, "mode": "gauge_only", "att": None},
    # `off`：不阻断，但**照样算出判据**并加那句尾注
    {"name": "off_dead", "sample": _DEAD, "mode": "off", "att": None},
    {"name": "off_ok", "sample": _GOOD, "mode": "off", "att": None},
    # 认不出的模式回落到默认，而不是「没有模式所以放行」
    {"name": "bogus_mode", "sample": _DEAD, "mode": "不存在的模式", "att": None},
    # 只有一只 Pirani：配置体检那句话会**贴在拒绝后面**
    {"name": "rough_gauge_only_fitted", "sample": _DEAD, "mode": "gauge_or_attest",
     "att": None, "cfg": {"min_pa": 0.5, "full_scale_pa": 1e5}},
    # 签署恰好在 TTL 上（`>` 而不是 `>=` ⇒ 还没过期）
    {"name": "att_exactly_at_ttl", "sample": _DEAD, "mode": "gauge_or_attest",
     "att": {**_LIVE_ATT, "signed_at": NOW_S - 8 * 3600.0}},
]

# ── 5. 温度：单位换算 ────────────────────────────────────────────────────────
TO_KELVIN_CASES: list[dict] = [
    {"value": v, "unit": u, "status": s}
    for v, u, s in [
        (77.35, "K", "ok"), (77.35, "kelvin", "ok"), (77.35, " K ", "ok"),
        (-196.0, "C", "ok"), (-196.0, "°C", "ok"), (-196.0, "degC", "ok"),
        (-196.0, "celsius", "ok"),
        # warning / alarm **算读到了**（降温途中必然长期在警带里）
        (4.2, "K", "warning"), (4.2, "K", "alarm"),
        # error / unavailable 在外，且必须在外
        (0.0, "K", "error"), (0.0, "K", "unavailable"), (0.0, "", "error"),
        (77.0, "K", ""), (77.0, "K", "OK"),
        # 单位不是温度 ⇒ None（2e-13 A 被当成 2e-13 K 比没有温度更糟）
        (2e-13, "A", "ok"), (77.0, "", "ok"), (77.0, "kOhm", "ok"),
        ("77.35", "K", "ok"), ("abc", "K", "ok"), (None, "K", "ok"),
    ]
]

# ── 6. 温度：年龄 ────────────────────────────────────────────────────────────
AGE_CASES: list[dict] = [
    {"timestamp": _at(0)}, {"timestamp": _at(12)}, {"timestamp": _at(3600)},
    # 未来的时间戳 ⇒ **负**年龄（不夹到 0：钟不对这件事值得看见）
    {"timestamp": _at(-30)},
    {"timestamp": ""}, {"timestamp": "   "}, {"timestamp": "昨天"},
    {"timestamp": None},
    # 带时区 vs 不带（`now` 是带时区的）
    {"timestamp": "2023-11-14T22:13:08+00:00"},
    {"timestamp": "2023-11-14T22:13:08Z"},
    {"timestamp": "2023-11-15T06:13:08+08:00"},
]

# ── 7. 温度：通道选择 ────────────────────────────────────────────────────────
_SPM = {"name": "SPM (COM3)", "value": 77.35, "unit": "K", "status": "ok",
        "timestamp": _at(12), "driver": "LakeshoreTemperatureSensor", "real": True}
_MAGNET = {"name": "Magnet (COM3)", "value": 4.21, "unit": "K", "status": "warning",
           "timestamp": _at(60), "driver": "LakeshoreTemperatureSensor", "real": True}
_PLACEHOLDER = {"name": "Cryostat", "value": 0.0, "unit": "", "status": "unavailable",
                "timestamp": "", "driver": "PlaceholderSensor", "real": False}
_DEAD_REAL = {"name": "Shield", "value": 0.0, "unit": "", "status": "error",
              "timestamp": _at(5), "driver": "LakeshoreTemperatureSensor", "real": True}
#: `real=None` —— **不知道**是不是真驱动。不知道 ≠ 占位。
_UNKNOWN_REAL = {"name": "Chamber", "value": 0.0, "unit": "", "status": "unavailable",
                 "timestamp": _at(5), "driver": "", "real": None}
_UNKNOWN_REAL_LIVE = {"name": "Chamber", "value": 293.0, "unit": "K", "status": "ok",
                      "timestamp": _at(7), "driver": "SnapshotSensor", "real": None}

READ_CASES: list[dict] = [
    {"name": "empty", "channels": [], "channel": None},
    {"name": "empty_named", "channels": [], "channel": "SPM"},
    {"name": "auto_prefers_stage", "channels": [_MAGNET, _SPM], "channel": None},
    {"name": "auto_single", "channels": [_MAGNET], "channel": None},
    # 全是占位 ⇒ no_sensor（不是 unavailable）
    {"name": "all_placeholder", "channels": [_PLACEHOLDER], "channel": None},
    # 占位不参选，真的那个被选中
    {"name": "placeholder_skipped", "channels": [_PLACEHOLDER, _SPM], "channel": None},
    # 真驱动但读不到 ⇒ unavailable，且**照样回报通道名与年龄**
    {"name": "real_but_dead", "channels": [_DEAD_REAL], "channel": None},
    # 可读的优先于读不到的（即使读不到的那个名字更像样品台）
    {"name": "readable_wins", "channels": [_DEAD_REAL, _MAGNET], "channel": None},
    # `real=None` 不当占位：它参选，读不到时是 unavailable 而不是 no_sensor
    {"name": "unknown_real_dead", "channels": [_UNKNOWN_REAL], "channel": None},
    {"name": "unknown_real_live", "channels": [_UNKNOWN_REAL_LIVE], "channel": None},
    # 指名：精确 / 大小写 / 唯一子串 / 多命中 / 落空 / 指名占位
    {"name": "exact", "channels": [_SPM, _MAGNET], "channel": "SPM (COM3)"},
    {"name": "casefold", "channels": [_SPM, _MAGNET], "channel": "spm (com3)"},
    {"name": "substring", "channels": [_SPM, _MAGNET], "channel": "Magnet"},
    {"name": "ambiguous", "channels": [_SPM, _MAGNET], "channel": "COM3"},
    {"name": "unknown", "channels": [_SPM, _MAGNET], "channel": "LN2"},
    {"name": "named_placeholder", "channels": [_SPM, _PLACEHOLDER],
     "channel": "Cryostat"},
    {"name": "named_blank", "channels": [_SPM, _MAGNET], "channel": "   "},
    # 精确命中优先于子串：`A` 与 `AB` 并存时指名 `A` 不该说「你得说清」
    {"name": "exact_beats_substring", "channel": "A", "channels": [
        {**_SPM, "name": "A"}, {**_MAGNET, "name": "AB"}]},
    # 两个同名 ⇒ 精确那一档就已经 ambiguous
    {"name": "duplicate_names", "channel": "A", "channels": [
        {**_SPM, "name": "A"}, {**_MAGNET, "name": "A"}]},
]

# ── 8. 三态新鲜度 ────────────────────────────────────────────────────────────
FRESHNESS_CASES: list[dict] = [
    {"value_k": 77.0, "age_s": 12.0, "max_age_s": 60.0},
    {"value_k": 77.0, "age_s": 120.0, "max_age_s": 60.0},
    # 恰好等于阈值 ⇒ fresh（`>` 而不是 `>=`）
    {"value_k": 77.0, "age_s": 60.0, "max_age_s": 60.0},
    # 年龄不明 ⇒ unknown，**不是** fresh
    {"value_k": 77.0, "age_s": None, "max_age_s": 60.0},
    # 没有值 ⇒ unknown
    {"value_k": None, "age_s": 12.0, "max_age_s": 60.0},
    {"value_k": 77.0, "age_s": 12.0, "max_age_s": 0.0},
]


def main() -> int:
    to_pascal = [
        _plain({**c, "out": vac.to_pascal(c["value"], c["unit"])})
        for c in TO_PASCAL_CASES
    ]
    gauge_config = [
        _plain({**c, "out": vac.gauge_config_problem(**c)}) for c in GAUGE_CONFIG_CASES
    ]

    gauge_verdict = []
    for c in GAUGE_VERDICT_CASES:
        sample = None if c["sample"] is None else vac.PressureSample(**c["sample"])
        ok, reason, detail = vac.gauge_verdict(sample, now=NOW_S, **c["cfg"])
        gauge_verdict.append({
            "name": c["name"], "sample": _plain(c["sample"]), "cfg": _plain(c["cfg"]),
            "ok": ok, "reason": reason, "detail": _plain(detail),
        })

    assess = []
    for c in ASSESS_CASES:
        sample = None if c["sample"] is None else vac.PressureSample(**c["sample"])
        att = None if c.get("att") is None else vac.Attestation(**c["att"])
        v = vac.assess(sample, mode=c["mode"], attestation=att, now=NOW_S,
                       **c.get("cfg", {}))
        assess.append({
            "name": c["name"], "sample": _plain(c["sample"]), "mode": c["mode"],
            "att": _plain(c.get("att")), "cfg": _plain(c.get("cfg", {})),
            "verdict": _plain(v.as_dict()),
            # 系统提示块那一行 —— 它永不为空，而「永不为空」本身是判据
            "block": _format_block(v),
        })

    to_kelvin = [
        _plain({**c, "out": temp.to_kelvin(c["value"], c["unit"], c["status"])})
        for c in TO_KELVIN_CASES
    ]
    ages = [
        _plain({**c, "out": temp.age_s(c["timestamp"], NOW_DT)}) for c in AGE_CASES
    ]

    reads = []
    for c in READ_CASES:
        chans = [temp.TempChannel(**x) for x in c["channels"]]
        r = temp.read_temperature(chans, channel=c["channel"], now=NOW_DT)
        reads.append({
            "name": c["name"], "channels": _plain(c["channels"]),
            "channel": c["channel"], "out": _plain(r.as_dict()),
            # 技能报 `available_channels` 用的是**自己拼的**那份字典，
            # 而不是 `TempChannel.as_dict()`（后者多一个 `value` 键，
            # 且在 `mast/skills/**` 里一个调用方都没有）。录会上线的那一份。
            "available_channels": [
                _plain({"name": x.name, "unit": x.unit, "status": x.status,
                        "driver": x.driver, "real": x.real, "value_k": x.kelvin()})
                for x in chans
            ],
        })

    fresh = [
        {**c, "out": temp.TempReading(
            value_k=c["value_k"], age_s=c["age_s"]).freshness(c["max_age_s"])}
        for c in FRESHNESS_CASES
    ]

    doc = {
        "_note": "由 tools/spec-export/export_environment.py 生成 —— "
                 "旧仓 mast/core/vacuum_interlock.py 与 mast/core/temperature.py "
                 "真跑一遍。输入与答案一起录。",
        "_now_s": NOW_S,
        "_now_iso": NOW_ISO,
        "constants": {
            "corona_zone_pa": list(vac.CORONA_ZONE_PA),
            "default_max_pressure_pa": vac.DEFAULT_MAX_PRESSURE_PA,
            "default_gauge_full_scale_pa": vac.DEFAULT_GAUGE_FULL_SCALE_PA,
            "default_gauge_min_pa": vac.DEFAULT_GAUGE_MIN_PA,
            "default_max_age_s": vac.DEFAULT_MAX_AGE_S,
            "default_attestation_ttl_s": vac.DEFAULT_ATTESTATION_TTL_S,
            "modes": list(vac.MODES),
            "attestation_reasons": dict(vac.ATTESTATION_REASONS),
            "real_gauge_classes": sorted(vac.REAL_GAUGE_CLASSES),
            "placeholder_classes": sorted(vac.PLACEHOLDER_CLASSES),
            "temperature_reasons": list(temp.REASONS),
        },
        "to_pascal": to_pascal,
        "gauge_config": gauge_config,
        "gauge_verdict": gauge_verdict,
        "assess": assess,
        "to_kelvin": to_kelvin,
        "age_s": ages,
        "read_temperature": reads,
        "freshness": fresh,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    n = (len(to_pascal) + len(gauge_config) + len(gauge_verdict) + len(assess)
         + len(to_kelvin) + len(ages) + len(reads) + len(fresh))
    print(f"✓ {OUT.relative_to(REPO)}：8 节 / {n} 格")
    return 0


def _format_block(v: Any) -> str:
    """`format_block()` 自己去调 `check()`（读进程级状态），这里只要它的**格式**。

    照旧仓那几行原样拼 —— 复制五行比为了录一格而把进程级源摆起来更诚实，
    而且这一段本身就在被比对。
    """
    head = "可以粗动" if v.allow else "**禁止粗动**"
    tail = ""
    if not v.allow:
        tail = ("（这不是建议，是硬闸门：粗动/换区技能会直接拒绝执行。"
                "在中间真空区给粗动压电加几百伏会打火击穿。）")
    return f"【真空互锁】{head} —— {v.reason}{tail}"


if __name__ == "__main__":
    raise SystemExit(main())
