"""实验地图层的**专用驱动器** —— 通用轨迹金样一格都照不到这里。

    python \\
        tools/spec-export/export_map_scope.py

## 为什么要单开一台

`FindCleanSpot` 的全部判据住在**它没发出去的那些调用**里：一次 `Piezo_RangeGet`
之外，它读的是**实验记录**（`load_markers`）与**进程内的撞针记忆**
（`crash_memory_markers`），然后在一张**锚在可用区中心**的格子上做纯几何选点。
`export_skill_traces.py` 的假 context 两样都给不出来 —— 它只合成 Nanonis 回包，
于是那条路上 `map_known` 恒为 False、`markers` 恒为空、避让圆一个都没有，
**250 行的 `nearest_clean_from` 只走得到「空地图」那一条**。

所以这一份自己摆世界：档案（`instrument_profile`）、实验记录、撞针追踪器、
仪器回包，四样都由这台驱动器给，再让**旧仓自己的函数**回答。

无状态、无时钟、无随机数 ⇒ 两次导出逐字节相同。

## 九节，各自回答一个问题

| 节 | 问的是 |
|---|---|
| `ring_cells` | 环带的**生成顺序**（它决定同距候选谁先谁后 —— 稳定排序把它变成判据） |
| `config` | `analysis_config` 那 143 行：哪个键从档案来、哪个键**故意不看档案** |
| `markers` | 一行数据库记录怎么变成 `MapMarker`（`coord_epoch` 的五种坏值各是什么） |
| `epochs` | 代次：存的那一列与**数出来的**那一列，以及它们不一致时听谁的 |
| `load_markers` | 读不到 / 读到了 / 读到了但是空的 —— 三态 |
| `crash_memory` | 第二个撞针来源，以及 `unlocated`（记到了、坐标不知道） |
| `avoid_circles` | 每一种 marker 变成什么圈，以及**上限那一条为什么常常不生效** |
| `nearest` | 250 行的选点几何，逐条判据一格（见 `CASES` 里每一格的注释） |
| `skill` | 技能本体：三态压电来源、重搜、三种「没有落点」的话术 |

## ⚠️ 只读旧仓

`MAST2_PROJECT_ROOT` 指到临时目录（同 `export_tip_policy.py`）。这台驱动器
不 import 任何会落盘的东西，但那条钉子的价值正在于「今天什么都没挡住」。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-map-scope-"))

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "map_scope.json"

sys.path.insert(0, str(MAST_ROOT))

import mast.core.tip_crash_tracker as tct  # noqa: E402
import mast.logging.experiment_log as explog  # noqa: E402
from mast.core import instrument_profile as ip  # noqa: E402
from mast.core.map_scope import (  # noqa: E402
    analysis_config,
    crash_memory_markers,
    load_markers,
)
from mast.io.exp_map import (  # noqa: E402
    MapMarker,
    epoch_of_row,
    markers_from_rows,
)
from mast.io.map_analysis import (  # noqa: E402
    DAMAGE_KINDS,
    AnalysisConfig,
    _ring_cells,
    build_avoid_circles,
    current_epoch_of,
    epoch_series,
    filter_epoch,
    nearest_clean_from,
)
from mast.skills.builtins.clean_spot import FindCleanSpot, parse_spots  # noqa: E402

# ── 摆世界用的替身 ──────────────────────────────────────────────────────


class _Rec:
    """`NanonisCallRecord` 的形状里技能真的读到的那几个字段。"""

    def __init__(self, method: str, args: tuple, error: Any, rv: Any):
        self.method = method
        self.args = args
        self.error = error
        self.return_value = rv


class _Snap:
    def __init__(self, w: Any):
        self.scan_width_m = w


class _State:
    """`context.state`。`raises=True` 那一格验的是 `analysis_config` 的 fail-soft。"""

    def __init__(self, w: Any, *, raises: bool = False):
        self._w = w
        self._raises = raises

    def snapshot(self):
        if self._raises:
            raise RuntimeError("状态缓存读不到")
        return _Snap(self._w)


class _Safety:
    def __init__(self, xy_max_m: Any):
        self.xy_max_m = xy_max_m


class _Ctx:
    """只应答脚本里写明的动词；没写的一律给一个通用 body。"""

    def __init__(self, replies: dict, state: Any = None):
        self._replies = replies
        self.state = state
        self.calls: list[dict] = []

    def safe_call(self, method: str, *args, **kw) -> _Rec:
        spec = self._replies.get(method, ("", b"", [0.25]))
        if isinstance(spec, str):          # 字符串 = 这一次调用失败，内容是 error
            rec = _Rec(method, args, spec, None)
        else:
            rec = _Rec(method, args, None, spec)
        self.calls.append({"verb": method, "args": [_plain(a) for a in args],
                           "error": rec.error})
        return rec

    def check_abort(self) -> bool:
        return False


class _Storage:
    def __init__(self, rows: Any, *, raises: bool = False):
        self._rows = rows
        self._raises = raises

    def get_markers(self, exp_id, sample_id):
        if self._raises:
            raise RuntimeError("存储不可用")
        return self._rows


class _Log:
    def __init__(self, storage: Any):
        self._storage = storage
        self.current_experiment_id = "exp-7a2"
        self.current_sample_id = "sample-7a2"


class _Tracker:
    def __init__(self, located: Any, unlocated: int, *, raises: bool = False):
        self._located = located
        self._unlocated = unlocated
        self._raises = raises

    def crash_points(self):
        if self._raises:
            raise RuntimeError("追踪器读不到")
        return self._located, self._unlocated


def _set_world(*, profile: dict | None = None, rows: Any = "no-log",
               tracker: Any = None) -> None:
    """一格的世界：档案 + 实验记录 + 撞针追踪器。

    ``rows="no-log"`` = 没有活动实验（``get_active_log()`` 给 None）；
    ``rows="no-storage"`` = 有实验、没存储；``rows="raises"`` = 取数抛。
    """
    ip.set_profile(profile or {})
    if rows == "no-log":
        explog.get_active_log = lambda: None
    elif rows == "no-storage":
        explog.get_active_log = lambda: _Log(None)
    elif rows == "raises":
        explog.get_active_log = lambda: _Log(_Storage(None, raises=True))
    else:
        explog.get_active_log = lambda: _Log(_Storage(rows))
    tct.get_tip_crash_tracker = lambda: (tracker if tracker is not None
                                         else _Tracker([], 0))


# ── 序列化 ──────────────────────────────────────────────────────────────


def _plain(v: Any) -> Any:
    if isinstance(v, (str, bool)) or v is None:
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        # `allow_nan=False`，所以非有限值必须自己变成串（同 vision 那一族的 `_plain`）。
        if v != v:
            return "NaN"
        if v == float("inf"):
            return "Infinity"
        if v == float("-inf"):
            return "-Infinity"
        return v
    if isinstance(v, bytes):
        return f"<bytes {len(v)}>"
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    return str(v)


#: `AnalysisConfig` 的字段顺序（声明序）。两侧的字段集必须一致 —— 少一个字段的
#: 移植在任何一格上都看不出来，除非把整张表都比一遍。
CFG_FIELDS: tuple[str, ...] = tuple(AnalysisConfig.__dataclass_fields__)


def _cfg_dict(cfg: AnalysisConfig) -> dict:
    return {f: _plain(getattr(cfg, f)) for f in CFG_FIELDS}


def _cfg_from(d: dict) -> AnalysisConfig:
    return AnalysisConfig(**{k: v for k, v in d.items()})


def _marker_dict(m: MapMarker) -> dict:
    return {
        "kind": m.kind, "x_m": _plain(m.x_m), "y_m": _plain(m.y_m),
        "w_m": _plain(m.w_m), "h_m": _plain(m.h_m),
        "angle_deg": _plain(m.angle_deg), "label": m.label,
        "skill_name": m.skill_name, "status": m.status, "source": m.source,
        "timestamp": m.timestamp, "meta": _plain(m.meta),
        "coord_epoch": _plain(m.coord_epoch),
        "has_xy": bool(m.has_xy), "has_footprint": bool(m.has_footprint),
    }


def _circle_dict(c: Any) -> dict:
    return {"x_m": _plain(c.x_m), "y_m": _plain(c.y_m),
            "radius_m": _plain(c.radius_m), "kind": c.kind, "label": c.label}


def _result_dict(r: Any) -> dict:
    return {
        "success": bool(r.success),
        "error": str(r.error or ""),
        "summary": str(getattr(r, "summary", "") or ""),
        "data": _plain(getattr(r, "data", None) or {}),
        "nanonis_calls": [{"verb": c.method, "args": _plain(list(c.args)),
                           "error": c.error} for c in (r.nanonis_calls or [])],
    }


def _mk(kind: str, x: Any, y: Any, **kw) -> MapMarker:
    return MapMarker(kind=kind, x_m=x, y_m=y, **kw)


# ══════════════════════════════════════════════════════════════════════════
# ① 环带
# ══════════════════════════════════════════════════════════════════════════

def sec_ring_cells() -> dict:
    """`_ring_cells` 的**顺序**，不只是集合。

    同一环上的点到区心等距，而 `found.sort` 是**稳定**的 ⇒ 这个顺序直接决定
    「同样近的两个落点，先给哪一个」。把它当成集合比，等于放走整条判据。
    """
    return {str(r): [list(t) for t in _ring_cells(r)] for r in range(0, 5)}


# ══════════════════════════════════════════════════════════════════════════
# ② analysis_config
# ══════════════════════════════════════════════════════════════════════════

#: `(档案, safety, state, frame_size_m)`；`state` 写成 `(width, raises)`。
CONFIG_CASES: dict[str, tuple[dict, Any, Any, Any]] = {
    # 出厂：四个半径里**只有 pulse 不读档案默认**（`_nm_unless_set`）。
    # 于是 pulse = 2e-7（字面量 `200e-9`），而 crash = 150.0*1e-9 =
    # 1.5000000000000002e-07 —— **最后一位就分得开这两条路**。
    "factory": ({}, None, None, None),
    # safety 的 `xy_max_m` 覆盖压电半程。
    "safety_real_rig": ({}, 1.21945e-6, None, None),
    # `if xy_max:` 是**真值判断**，不是 `is not None` ⇒ 0 被当成「没给」。
    "safety_zero": ({}, 0.0, None, None),
    # 负数取绝对值。
    "safety_negative": ({}, -1.3e-6, None, None),
    # `float("很大")` 抛 ⇒ 整段 except ⇒ 沿用 1.5 µm（fail-soft，不是 0）。
    "safety_junk": ({}, "很大", None, None),
    "safety_str_number": ({}, "1.3e-6", None, None),
    # 实时扫描框决定候选间距。
    "state_frame_50nm": ({}, None, (50e-9, False), None),
    # `w < half*2` 才采纳：4 µm 在 ±1.5 µm 的机器上是解析残渣。
    "state_frame_too_big": ({}, None, (4e-6, False), None),
    "state_frame_too_small": ({}, None, (1e-11, False), None),
    "state_frame_none": ({}, None, (None, False), None),
    "state_raises": ({}, None, (50e-9, True), None),
    # 显式帧尺寸压过 state。
    "frame_explicit": ({}, None, (50e-9, False), 250e-9),
    # `if frame_size_m and frame_size_m > 0` ⇒ 0 落回 state。
    "frame_explicit_zero": ({}, None, (50e-9, False), 0.0),
    # 没有 XY 粗动 ⇒ 不设中心区 + 策略变成外圈向内。
    "no_coarse": ({"xy_coarse_motion": "no"}, None, None, None),
    # 策略显式写死时不再由能力推导。
    "no_coarse_strategy_center": ({"xy_coarse_motion": "no",
                                   "scan_path_strategy": "center_first"},
                                  None, None, None),
    "strategy_perimeter_with_coarse": ({"scan_path_strategy": "perimeter_inward"},
                                       None, None, None),
    # 进针不伤表面 ⇒ `radius_for("approach")` 变成 None（圈根本不画）。
    "approach_no": ({"approach_damages_surface": "no"}, None, None, None),
    "approach_unknown": ({"approach_damages_surface": "unknown"}, None, None, None),
    # 四个半径全部由档案给。
    "radii_all_set": ({"avoid_radius_tip_shape_nm": 45.0,
                       "avoid_radius_pulse_nm": 500.0,
                       "avoid_radius_crash_nm": 220.0,
                       "avoid_radius_approach_nm": 260.0}, None, None, None),
    # 只设 pulse：`_nm_unless_set` 这条路唯一能被观察到的地方。
    "pulse_set_only": ({"avoid_radius_pulse_nm": 500.0}, None, None, None),
    # ⚠️ `center_zone_side_nm` **不在 `_CONFIG_SPEC` 里** ⇒ `sanitize` 丢掉它
    # ⇒ `get_profile()` 永远没有这个键 ⇒ 这个旋钮**拧不动**。照录。
    "center_zone_knob_is_dead": ({"center_zone_side_nm": 500.0}, None, None, None),
    # 间距因子：档案里被夹在 [1,20]，所以 `_spacing` 里 `v < 1` 那一支不可达。
    "spacing_3": ({"scan_spacing_factor": 3.0}, None, None, None),
    "spacing_below_one_is_clamped": ({"scan_spacing_factor": 0.5}, None, None, None),
    # 半径为 0 ⇒ `radius_for` 给 None（**0 不是一个避让半径**）。
    "zero_radius_is_no_circle": ({"avoid_radius_crash_nm": 0.0}, None, None, None),
    # 中心区比压电范围还大时不许把可用区撑开（`min`，不是替换）。
    "tiny_piezo_keeps_the_min": ({}, 300e-9, None, None),
}


def sec_config() -> dict:
    out: dict[str, Any] = {}
    for name, (profile, xy_max, state_spec, frame) in CONFIG_CASES.items():
        _set_world(profile=profile)
        state = None
        if state_spec is not None:
            state = _State(state_spec[0], raises=state_spec[1])
        safety = None if xy_max is None else _Safety(xy_max)
        cfg = analysis_config(state, safety=safety, frame_size_m=frame)
        out[name] = {
            "profile": _plain(profile),
            "safety_xy_max_m": _plain(xy_max),
            "state_scan_width_m": _plain(None if state_spec is None else state_spec[0]),
            "state_raises": bool(state_spec is not None and state_spec[1]),
            "frame_size_m_arg": _plain(frame),
            "config": _cfg_dict(cfg),
            "effective_half_range_m": _plain(cfg.effective_half_range_m),
            "radius_for": {k: _plain(cfg.radius_for(k))
                           for k in list(DAMAGE_KINDS) + ["manual", "scan", ""]},
            # 档案洗过之后**真的留下了什么** —— 「拧不动的旋钮」那一格靠它说话。
            "profile_after_sanitize": _plain(ip.get_profile()),
        }
    return out


# ══════════════════════════════════════════════════════════════════════════
# ③ marker 行
# ══════════════════════════════════════════════════════════════════════════

MARKER_ROWS: dict[str, dict] = {
    "full": {"kind": "pulse", "x_m": 1e-7, "y_m": -2e-7, "w_m": 5e-8,
             "h_m": 6e-8, "angle_deg": 30.0, "label": "一发 8 V",
             "skill_name": "TipPulse", "status": "done", "source": "skill",
             "timestamp": "2026-09-01T00:00:00", "meta": {"pos_src": "chosen_spot"},
             "coord_epoch": 2},
    # 空行：`kind` 缺省成 `move`，其余全部走 `or` 的右边。
    "empty": {},
    "kind_none": {"kind": None, "x_m": 0.0, "y_m": 0.0},
    # `0.0` 是一个**真实的坐标**，不是「没给」——`has_xy` 判的是 `is not None`。
    "origin_has_xy": {"kind": "crash", "x_m": 0.0, "y_m": 0.0},
    "x_only": {"kind": "crash", "x_m": 1e-7},
    # 有 xy 没 wh ⇒ 不是一个足迹。
    "no_footprint": {"kind": "scan", "x_m": 1e-7, "y_m": 1e-7},
    "zero_footprint": {"kind": "scan", "x_m": 0.0, "y_m": 0.0, "w_m": 0.0, "h_m": 1e-7},
    "negative_footprint": {"kind": "scan", "x_m": 0.0, "y_m": 0.0,
                           "w_m": -1e-7, "h_m": 1e-7},
    "angle_none": {"kind": "scan", "x_m": 0.0, "y_m": 0.0, "w_m": 1e-7,
                   "h_m": 1e-7, "angle_deg": None},
    # `meta` 不是 dict ⇒ `{}`（不是原样带过去）。
    "meta_not_a_dict": {"kind": "manual", "x_m": 0.0, "y_m": 0.0, "meta": "[]"},
    "meta_list": {"kind": "manual", "x_m": 0.0, "y_m": 0.0, "meta": [1, 2]},
    # ── `coord_epoch` 的五种坏值 ──────────────────────────────────────
    "epoch_null": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": None},
    "epoch_missing": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0},
    "epoch_string": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": "3"},
    "epoch_float": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": 2.7},
    # `_coerce_float` **显式拒绝 bool** ⇒ `True` 不是代次 1，是「没有」⇒ 0。
    "epoch_bool": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": True},
    "epoch_junk": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": "abc"},
    "epoch_nan": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": float("nan")},
    "epoch_inf": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": float("inf")},
    "epoch_negative": {"kind": "pulse", "x_m": 0.0, "y_m": 0.0, "coord_epoch": -1},
}


def sec_markers() -> dict:
    out: dict[str, Any] = {}
    for name, row in MARKER_ROWS.items():
        [m] = markers_from_rows([row])
        out[name] = {"row": _plain(row), "marker": _marker_dict(m),
                     "epoch_of_row": epoch_of_row(row)}
    # `markers_from_rows(None)` / `[]` —— 调用方真的会这么传。
    out["_rows_none"] = {"row": None, "n": len(markers_from_rows(None))}
    out["_rows_empty"] = {"row": [], "n": len(markers_from_rows([]))}
    return out


# ══════════════════════════════════════════════════════════════════════════
# ④ 代次
# ══════════════════════════════════════════════════════════════════════════

EPOCH_ROWS: dict[str, list] = {
    # 没有换过区：所有行都是第 0 代。
    "single_epoch": [{"kind": "pulse"}, {"kind": "scan"}, {"kind": "crash"}],
    # 两次横向粗动 ⇒ 第 2 代是活的那一代。`coarse_move` 行**自己**属于换区**前**
    # 那一代（`out.append(seen)` 在自增之前）。
    "two_moves": [{"kind": "pulse"}, {"kind": "coarse_move"}, {"kind": "scan"},
                  {"kind": "coarse_move"}, {"kind": "crash"}],
    # 存的那一列存在时**它说了算**（`log_marker` 在同一个写事务里盖的）。
    "stored_wins": [{"kind": "pulse", "coord_epoch": 5},
                    {"kind": "coarse_move", "coord_epoch": 5},
                    {"kind": "scan", "coord_epoch": 6}],
    # 老库：那一列是 NULL ⇒ 回落到数出来的那一列。
    "legacy_null": [{"kind": "pulse", "coord_epoch": None},
                    {"kind": "coarse_move", "coord_epoch": None},
                    {"kind": "scan", "coord_epoch": None}],
    # 混着：一半有列一半没有。
    "mixed": [{"kind": "pulse", "coord_epoch": 0}, {"kind": "coarse_move"},
              {"kind": "scan", "coord_epoch": 1}, {"kind": "crash"}],
    # 存的那一列**和数出来的不一致** —— 两种读法在这里分岔。
    "stored_disagrees": [{"kind": "pulse", "coord_epoch": 9},
                         {"kind": "scan", "coord_epoch": 0}],
    "empty": [],
    # `None` 行（存储偶尔会给）。
    "none_row": [None, {"kind": "coarse_move"}, {"kind": "scan"}],
}


def sec_epochs() -> dict:
    out: dict[str, Any] = {}
    for name, rows in EPOCH_ROWS.items():
        cur = current_epoch_of(rows)
        out[name] = {
            "rows": _plain(rows),
            "series": epoch_series(rows),
            "current": cur,
            "filter": {str(e): _plain(filter_epoch(rows, e))
                       for e in range(0, max(cur, 1) + 1)},
        }
    out["_none"] = {"rows": None, "series": epoch_series(None),
                    "current": current_epoch_of(None),
                    "filter": {"0": _plain(filter_epoch(None, 0))}}
    return out


# ══════════════════════════════════════════════════════════════════════════
# ⑤ load_markers
# ══════════════════════════════════════════════════════════════════════════

LOAD_CASES: dict[str, Any] = {
    # 没有活动实验 ⇒ `available=False`。**空表不等于干净**，这是整条链的要害。
    "no_active_log": "no-log",
    "no_storage": "no-storage",
    "storage_raises": "raises",
    # 读到了，是空的 —— 与上面三格在几何上完全一样，只有这个布尔分得开。
    "empty_but_available": [],
    "one_epoch": [{"kind": "pulse", "x_m": 1e-7, "y_m": 0.0},
                  {"kind": "crash", "x_m": -2e-7, "y_m": 1e-7}],
    # 换过一次区：旧代次的两行**不许**出现在结果里。
    "after_coarse_move": [
        {"kind": "pulse", "x_m": 1e-7, "y_m": 0.0},
        {"kind": "crash", "x_m": -2e-7, "y_m": 1e-7},
        {"kind": "coarse_move", "x_m": 0.0, "y_m": 0.0},
        {"kind": "pulse", "x_m": 3e-7, "y_m": 3e-7},
    ],
    "storage_returns_none": None,
}


def sec_load_markers() -> dict:
    out: dict[str, Any] = {}
    for name, rows in LOAD_CASES.items():
        _set_world(rows=rows)
        markers, epoch, ok = load_markers()
        markers_all, epoch_all, ok_all = load_markers(all_epochs=True)
        out[name] = {
            "rows": _plain(rows if isinstance(rows, list) else str(rows)),
            "markers": [_marker_dict(m) for m in markers],
            "epoch": epoch, "available": bool(ok),
            "all_epochs": {"markers": [_marker_dict(m) for m in markers_all],
                           "epoch": epoch_all, "available": bool(ok_all)},
        }
    return out


# ══════════════════════════════════════════════════════════════════════════
# ⑥ 撞针记忆
# ══════════════════════════════════════════════════════════════════════════

CRASH_CASES: dict[str, tuple] = {
    "empty": ([], 0),
    "one_point": ([(1e-7, -2e-7, 3)], 0),
    # 记到了、坐标不知道 ⇒ **绝不**当成一个点交出去。
    "only_unlocated": ([], 4),
    "both": ([(1e-7, 0.0, 1), (-3e-7, 2e-7, 2)], 2),
    # ⚠️ 读不到这一路来源 ⇒ `([], 0)`。它与 `empty` **逐字节相同** ——
    # 「问过了，没有」和「问不到」在这个返回值上分不开（照移，见 deviations）。
    "tracker_raises": "raises",
}


def sec_crash_memory() -> dict:
    out: dict[str, Any] = {}
    for name, spec in CRASH_CASES.items():
        if spec == "raises":
            _set_world(tracker=_Tracker([], 0, raises=True))
        else:
            _set_world(tracker=_Tracker(list(spec[0]), spec[1]))
        markers, unlocated = crash_memory_markers()
        out[name] = {"tracker": _plain(spec),
                     "markers": [_marker_dict(m) for m in markers],
                     "unlocated": unlocated}
    return out


# ══════════════════════════════════════════════════════════════════════════
# ⑦ 避让圆
# ══════════════════════════════════════════════════════════════════════════

def sec_avoid_circles() -> dict:
    _set_world()
    cfg = analysis_config(None)
    cfg_no_approach = analysis_config(None, safety=None)
    _set_world(profile={"approach_damages_surface": "no"})
    cfg_no_approach = analysis_config(None)
    _set_world()

    cases: dict[str, tuple[AnalysisConfig, list]] = {
        # 四种损伤各一个圈，半径由 `DAMAGE_KINDS` 映射的字段给。
        "four_kinds": (cfg, [
            _mk("tip_shape", 0.0, 0.0, label="扎针"),
            _mk("pulse", 1e-7, 0.0),
            _mk("crash", 0.0, 1e-7, label=""),
            _mk("approach", -1e-7, 0.0),
        ]),
        # 进针不伤表面 ⇒ 那一个圈**整个消失**（不是半径变 0）。
        "approach_harmless": (cfg_no_approach, [
            _mk("approach", -1e-7, 0.0), _mk("pulse", 1e-7, 0.0)]),
        # 没有坐标的 marker 一律跳过。
        "no_xy": (cfg, [_mk("pulse", None, None), _mk("crash", 1e-7, None),
                        _mk("pulse", 2e-7, 0.0)]),
        # `scan` / `move` 不是损伤。
        "not_damage": (cfg, [_mk("scan", 0.0, 0.0, w_m=1e-7, h_m=1e-7),
                             _mk("move", 1e-7, 1e-7)]),
        # 人工标的避让区：半径写在 `meta` 里，kind 变成 `manual_avoid`。
        "manual_avoid": (cfg, [
            _mk("manual", 0.0, 0.0, meta={"avoid_radius_m": 3e-7}),
            _mk("manual", 1e-7, 0.0, meta={"avoid_radius_m": 0.0}),
            _mk("manual", 2e-7, 0.0, meta={"avoid_radius_m": -1.0}),
            _mk("manual", 3e-7, 0.0, meta={"avoid_radius_m": "很大"}),
            _mk("manual", 4e-7, 0.0, meta={"used_radius_m": 3e-7}),
            _mk("manual", 5e-7, 0.0, meta={}),
            _mk("manual", 6e-7, 0.0, meta={"avoid_radius_m": True}),
            _mk("manual", 7e-7, 0.0, label="别碰这儿",
                meta={"avoid_radius_m": 1e-7}),
        ]),
        # ⚠️ 上限：损伤那一支 `continue` **跳过了上限检查** ⇒ 五个损伤 marker
        # 在 `max_avoid_circles=3` 下照样全部返回。照移（见 deviations）。
        "cap_not_enforced_on_damage": (
            _cfg_from({**_cfg_dict(cfg), "max_avoid_circles": 3}),
            [_mk("pulse", float(i) * 1e-7, 0.0) for i in range(5)]),
        # 而一个**非损伤**的 marker 走到底，上限当场生效 —— 后面的全丢。
        "cap_enforced_after_a_non_damage": (
            _cfg_from({**_cfg_dict(cfg), "max_avoid_circles": 3}),
            [_mk("pulse", 0.0, 0.0), _mk("pulse", 1e-7, 0.0),
             _mk("pulse", 2e-7, 0.0), _mk("move", 3e-7, 0.0),
             _mk("pulse", 4e-7, 0.0), _mk("pulse", 5e-7, 0.0)]),
        # 重叠的圈**不合并**：五次扎针就是五次。
        "no_merge": (cfg, [_mk("tip_shape", 0.0, 0.0) for _ in range(5)]),
    }
    out: dict[str, Any] = {}
    for name, (c, markers) in cases.items():
        out[name] = {
            "config": _cfg_dict(c),
            "markers": [_marker_dict(m) for m in markers],
            "circles": [_circle_dict(x) for x in build_avoid_circles(markers, c)],
        }
    return out


# ══════════════════════════════════════════════════════════════════════════
# ⑧ nearest_clean_from —— 这一批最大的一块判据
# ══════════════════════════════════════════════════════════════════════════

#: 真机那台的底子：压电半程 1219.45 nm（实测）、中心区 1200 nm、脉冲避让 200 nm。
def _rig_cfg(**over) -> AnalysisConfig:
    _set_world()
    base = analysis_config(None, safety=_Safety(1.21945e-6))
    return _cfg_from({**_cfg_dict(base), **over})


def _wide_cfg(**over) -> AnalysisConfig:
    """没有 XY 粗动的机器：不设中心区，整片压电范围都要用上。"""
    _set_world(profile={"xy_coarse_motion": "no"})
    base = analysis_config(None)
    return _cfg_from({**_cfg_dict(base), **over})


def nearest_cases() -> dict:
    rig = _rig_cfg()                       # eff = 600 nm，pulse_r = 200 nm
    wide = _wide_cfg()                     # eff = 1410 nm
    tiny = _rig_cfg(pulse_r_m=700e-9)      # 落点比可用区还大 ⇒ 退回压电范围
    fine = _rig_cfg(tip_shape_r_m=30e-9)   # step = 60 nm 的细格

    # 落在格点上的圆心：`hypot(a, 0)` 在两种语言里都**精确**，所以
    # 「正好相切」那一格不会被最后一位掀翻（见 deviations 里 hypot 那条）。
    step_r = 2.0 * rig.pulse_r_m           # 400 nm
    touch_x = step_r + (rig.crash_r_m + rig.pulse_r_m)   # 相切：正好 = r + r_spot
    inside_x = step_r + (rig.crash_r_m + rig.pulse_r_m) * 0.999

    cases: dict[str, dict] = {
        # ── 基本形状 ──────────────────────────────────────────────────
        # 针尖站在区心、地图全空：9 个落点，而**顺序**由环带生成序 + 稳定排序定。
        "origin_pulse_count8": dict(cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m,
                                    count=8, frame_m=0.0),
        "origin_pulse_count16": dict(cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m,
                                     count=16, frame_m=0.0),
        # `count=0` ⇒ 空表，**一次枚举都不做**。
        "count_zero": dict(cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=0,
                           frame_m=0.0),
        "count_one": dict(cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=1,
                          frame_m=0.0),
        # ── 帧边距：`frame_m=0`（打脉冲，落点上不扫图）与缺省的差别 ──────
        # 针尖贴着可用区边缘时，这 50 nm 决定「手边就有」还是「要走 60 nm」。
        "edge_tip_frame_zero": dict(cfg=fine, x=600e-9, y=0.0,
                                    r=fine.tip_shape_r_m, count=3, frame_m=0.0),
        "edge_tip_frame_default": dict(cfg=fine, x=600e-9, y=0.0,
                                       r=fine.tip_shape_r_m, count=3, frame_m=None),
        # ── 格子锚在**区心**，不是锚在针尖上（2026-08-17 第一发就失败那一条）──
        # 针尖 (539, -166) 在中心区外，格距 1000 nm：锚在针尖 ⇒ 零候选。
        "tip_off_lattice": dict(cfg=_rig_cfg(pulse_r_m=500e-9), x=539e-9,
                                y=-166e-9, r=500e-9, count=4, frame_m=0.0),
        # ── 提前退出必须减掉针尖到区心的距离（否则「快了但答错」）──────────
        # 针尖远在区外，而它脚下正好有一个干净格点。
        "prune_far_tip": dict(cfg=wide, x=1.2e-6, y=0.0, r=30e-9, count=8,
                              frame_m=0.0),
        "prune_far_tip_offgrid": dict(cfg=wide, x=1.21e-6, y=-0.37e-6, r=30e-9,
                                      count=8, frame_m=0.0),
        # ── 可用区装不下一个落点 ⇒ **退回压电范围**，不是「表面用完」──────
        # ⚠️ 这一格**分不出退不退**：不退时 reach = 600 nm、step = 1400 nm，
        # 区心照样是唯一候选。留着它是为了钉住 `derived`（reach 与 max_ring）。
        "zone_released": dict(cfg=tiny, x=0.0, y=0.0, r=tiny.pulse_r_m, count=6,
                              frame_m=0.0),
        # 这一格才分得出来：退回之后**多出一整环**（step 600 ≤ reach 646），
        # 不退就只剩区心一个点。
        "zone_released_admits_a_ring": dict(
            cfg=_rig_cfg(pulse_r_m=300e-9, frame_size_m=1.0e-6), x=0.0, y=0.0,
            r=300e-9, count=9, frame_m=None),
        # ── 避让圆：相切那一格是**闭区间**（`<=`）──────────────────────
        "circle_touching_is_blocked": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            markers=[_mk("crash", touch_x, 0.0)]),
        "circle_just_inside_is_blocked": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            markers=[_mk("crash", inside_x, 0.0)]),
        "circle_just_outside_is_clear": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            markers=[_mk("crash", touch_x * 1.001, 0.0)]),
        # 圆盘对圆盘，**不是**帧对圆盘：把落点方框化会白扔掉可用表面。
        "circle_diagonal_gap": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            markers=[_mk("crash", 300e-9, 300e-9)]),
        # 进针盘把区心废掉 —— 2026-08-17 死循环的算术。
        "approach_dimple_kills_the_centre": dict(
            cfg=_rig_cfg(pulse_r_m=500e-9), x=0.0, y=0.0, r=500e-9, count=4,
            frame_m=0.0, markers=[_mk("approach", 0.0, 592e-9)]),
        # ── exclude：**严格小于** 2·r_spot 才算撞上 ────────────────────
        # 已用点落在离格点**正好** 2·r_spot 处 ⇒ 那个格点**留着**（`<`，不是 `<=`）。
        "exclude_exact_diameter_is_kept": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            exclude=[(2.0 * step_r, 0.0)]),
        "exclude_just_inside_is_dropped": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            exclude=[(2.0 * step_r - 1e-12, 0.0)]),
        "exclude_on_the_point": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            exclude=[(0.0, 0.0), (400e-9, 0.0)]),
        # ── max_distance：**严格大于**才丢 ────────────────────────────
        "max_distance_exact_is_kept": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            max_distance_m=2.0 * rig.pulse_r_m),
        "max_distance_just_below": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            max_distance_m=2.0 * rig.pulse_r_m * 0.999),
        "max_distance_zero_keeps_only_the_origin": dict(
            cfg=rig, x=0.0, y=0.0, r=rig.pulse_r_m, count=9, frame_m=0.0,
            max_distance_m=0.0),
        # ── 落点半径为 0 ⇒ step 退回栅格 `grid_cell_m` ─────────────────
        "zero_spot_radius_uses_grid_cell": dict(
            cfg=rig, x=0.0, y=0.0, r=0.0, count=5, frame_m=0.0),
        # ── 一整套真机形状 ───────────────────────────────────────────
        "rig_with_history": dict(
            cfg=rig, x=120e-9, y=-80e-9, r=rig.pulse_r_m, count=6, frame_m=0.0,
            markers=[_mk("pulse", 0.0, 0.0), _mk("crash", 400e-9, 400e-9),
                     _mk("approach", -400e-9, 0.0),
                     _mk("manual", 0.0, 400e-9, meta={"avoid_radius_m": 250e-9})]),
        # 全被挡住 ⇒ 空表（这正是技能里那句「表面用完了」的来源）。
        "everything_blocked": dict(
            cfg=_rig_cfg(pulse_r_m=500e-9), x=0.0, y=0.0, r=500e-9, count=4,
            frame_m=0.0, markers=[_mk("crash", 0.0, 0.0)]),
        # 细格 + 真实的一堆历史：250 行里每一条过滤都在这一格上同时生效。
        "fine_grid_crowded": dict(
            cfg=fine, x=137e-9, y=-241e-9, r=fine.tip_shape_r_m, count=12,
            frame_m=None,
            markers=[_mk("tip_shape", 120e-9, -240e-9), _mk("pulse", 0.0, 0.0),
                     _mk("crash", 300e-9, -300e-9),
                     _mk("tip_shape", 180e-9, -180e-9)],
            exclude=[(60e-9, -240e-9), (180e-9, -300e-9)]),
    }

    out: dict[str, Any] = {}
    for name, c in cases.items():
        cfg: AnalysisConfig = c["cfg"]
        markers = c.get("markers") or []
        spots = nearest_clean_from(
            markers, cfg, c["x"], c["y"], spot_r_m=c["r"],
            count=c["count"], exclude=c.get("exclude"),
            max_distance_m=c.get("max_distance_m"), frame_m=c.get("frame_m"))
        # 几何的中间量一起录 —— 一个只比结果的金样说不出「它为什么是这个结果」。
        r_spot = max(float(c["r"]), 0.0)
        step = max(2.0 * r_spot, float(cfg.grid_cell_m), 1e-12)
        frame_margin = max(float(cfg.frame_size_m if c.get("frame_m") is None
                                 else c["frame_m"]), 0.0) / 2.0
        reach0 = max(cfg.effective_half_range_m - frame_margin, 0.0)
        released = reach0 < r_spot
        reach = reach0
        if released:
            base = cfg.piezo_half_range_m * (
                1.0 - max(0.0, min(0.9, cfg.edge_margin_frac)))
            reach = max(base - frame_margin, 0.0)
        out[name] = {
            "config": _cfg_dict(cfg),
            "markers": [_marker_dict(m) for m in markers],
            "x_m": _plain(c["x"]), "y_m": _plain(c["y"]),
            "spot_r_m": _plain(c["r"]), "count": c["count"],
            "exclude": _plain([list(t) for t in (c.get("exclude") or [])]),
            "max_distance_m": _plain(c.get("max_distance_m")),
            "frame_m": _plain(c.get("frame_m")),
            "derived": {"step": _plain(step), "frame_margin": _plain(frame_margin),
                        "reach": _plain(reach), "zone_released": bool(released),
                        "max_ring": int(reach / step) + 2},
            "spots": [{"x_m": _plain(s.x_m), "y_m": _plain(s.y_m),
                       "distance_m": _plain(s.distance_m)} for s in spots],
        }
    return out


# ══════════════════════════════════════════════════════════════════════════
# ⑨ 技能本体
# ══════════════════════════════════════════════════════════════════════════

_TIP_OK = ("", b"", [0.0, 0.0])
_RANGE_TIGHT = ("", b"", [2.4389e-6, 2.4389e-6, 1.0e-7])     # 半程 1219.45 nm
_RANGE_LOOSE = ("", b"", [4.0e-6, 4.2e-6, 1.0e-7])           # 半程 2.0 µm
_RANGE_ONE = ("", b"", [2.4389e-6])                          # 解一层 ⇒ 不是表
_RANGE_ZERO = ("", b"", [0.0, 0.0, 0.0])
_RANGE_STR = ("", b"", ["2.4e-6", "2.4e-6"])

#: 一格 = `(参数, 回包脚本, 档案, 实验记录, 撞针追踪器, state)`。
SKILL_CASES: dict[str, dict] = {
    # ── 原点从哪来 ────────────────────────────────────────────────────
    "live_tip": dict(params={"count": 4}),
    "explicit_origin": dict(params={"from_x_m": 300e-9, "from_y_m": -100e-9,
                                    "count": 3},
                            replies={"Piezo_RangeGet": _RANGE_TIGHT}),
    # 只给一半 ⇒ 仍然去读针尖（`x0 is None or y0 is None`）。
    "half_origin": dict(params={"from_x_m": 300e-9, "count": 3}),
    # 读不到针尖、又没给起点 ⇒ **失败**，而且 `nanonis_calls` 是空的。
    "tip_unreadable": dict(params={}, replies={"FolMe_XYPosGet": "连接被对端关闭"}),
    "tip_shape_of_junk": dict(params={},
                              replies={"FolMe_XYPosGet": ("", b"", ["x", "y"])}),
    "tip_absurd_coordinate": dict(params={},
                                  replies={"FolMe_XYPosGet": ("", b"", [1.0, 2.0])}),
    # ── 压电半程的三态 ────────────────────────────────────────────────
    "piezo_tighter": dict(params={"count": 2},
                          replies={"Piezo_RangeGet": _RANGE_TIGHT}),
    "piezo_looser": dict(params={"count": 2},
                         replies={"Piezo_RangeGet": _RANGE_LOOSE}),
    "piezo_unreadable": dict(params={"count": 2},
                             replies={"Piezo_RangeGet": "Piezo_RangeGet 超时"}),
    # 单元素回包被 `decode_reply` 解一层 ⇒ 不是表 ⇒ 沿用配置。
    "piezo_single_value": dict(params={"count": 2},
                               replies={"Piezo_RangeGet": _RANGE_ONE}),
    "piezo_zero": dict(params={"count": 2},
                       replies={"Piezo_RangeGet": _RANGE_ZERO}),
    "piezo_strings": dict(params={"count": 2},
                          replies={"Piezo_RangeGet": _RANGE_STR}),
    # ── 地图 / 撞针记忆的四种组合 ──────────────────────────────────────
    "map_known_no_crash": dict(
        params={"count": 3},
        rows=[{"kind": "pulse", "x_m": 0.0, "y_m": 0.0}]),
    "map_unknown_with_crash_memory": dict(
        params={"count": 3},
        tracker=_Tracker([(400e-9, 0.0, 2)], 0)),
    "map_unknown_no_crash": dict(params={"count": 3}),
    "map_known_with_crash_memory": dict(
        params={"count": 3},
        rows=[{"kind": "pulse", "x_m": 0.0, "y_m": 0.0}],
        tracker=_Tracker([(400e-9, 0.0, 2)], 0)),
    # 记到了、坐标不知道 ⇒ 落点带着这份风险，而且必须说出来。
    "crash_unlocated_only": dict(params={"count": 3}, tracker=_Tracker([], 3)),
    "crash_located_and_unlocated": dict(
        params={"count": 3}, tracker=_Tracker([(400e-9, 400e-9, 1)], 2)),
    # 换过一次区：旧代次的标记不参与避让。
    "after_coarse_move": dict(
        params={"count": 4},
        rows=[{"kind": "pulse", "x_m": 0.0, "y_m": 0.0},
              {"kind": "coarse_move", "x_m": 0.0, "y_m": 0.0},
              {"kind": "crash", "x_m": 400e-9, "y_m": 0.0}]),
    # ── purpose ──────────────────────────────────────────────────────
    "purpose_tip_shape": dict(params={"purpose": "tip_shape", "count": 3}),
    # 打脉冲的落点上**不扫图** ⇒ 不减帧边距。这一格才分得出来：
    # 避让 299 nm ⇒ 格距 598 nm，而可用区半程 600 nm ——
    # 减掉 50 nm 的帧边距，外面那一整圈（8 个落点）全没了，只剩区心。
    "pulse_frame_margin_matters": dict(
        params={"count": 9}, profile={"avoid_radius_pulse_nm": 299.0}),
    # 对照：同一份配置走扎针那一档（**要**减帧边距）。
    "tip_shape_frame_margin_matters": dict(
        params={"purpose": "tip_shape", "count": 9},
        profile={"avoid_radius_tip_shape_nm": 299.0}),
    # 认不出的 purpose ⇒ 回落到 `pulse_r_m`（**不是**报错）。
    "purpose_unknown": dict(params={"purpose": "什么", "count": 3}),
    "purpose_empty": dict(params={"purpose": "", "count": 3}),
    # ── exclude_spots ────────────────────────────────────────────────
    "exclude_spots": dict(params={"exclude_spots": "0,0;4e-7,0", "count": 4}),
    "exclude_spots_junk": dict(
        params={"exclude_spots": "0,0; 乱写 ;1,2,3;x,y;;4e-7,0", "count": 4}),
    # ── max_distance ─────────────────────────────────────────────────
    "max_distance": dict(params={"max_distance_m": 4e-7, "count": 8}),
    # `if params.get("max_distance_m")` ⇒ **0 被当成没给**（真值判断）。
    "max_distance_zero_is_ignored": dict(params={"max_distance_m": 0.0, "count": 2}),
    # ── 针尖在可用区外 ⇒ 从区心重搜，而且**必须说出来** ─────────────────
    "recentred": dict(
        params={"count": 3},
        replies={"FolMe_XYPosGet": ("", b"", [1.1e-6, 1.1e-6])},
        profile={"avoid_radius_pulse_nm": 500.0}),
    # 重搜也没有 ⇒ 失败，而话术里要带上「针尖当时在哪」。
    "recentred_and_still_nothing": dict(
        params={"count": 3},
        replies={"FolMe_XYPosGet": ("", b"", [1.1e-6, 1.1e-6])},
        profile={"avoid_radius_pulse_nm": 500.0},
        tracker=_Tracker([(0.0, 0.0, 1)], 0)),
    # ── 三种「没有落点」的话术 ────────────────────────────────────────
    # ① 有挡路的圈 ⇒ 逐个点名（最多三个，按离区心的距离排）。
    "no_spot_blockers_named": dict(
        params={"count": 3},
        rows=[{"kind": "approach", "x_m": 0.0, "y_m": 0.0},
              {"kind": "crash", "x_m": 100e-9, "y_m": 0.0},
              {"kind": "pulse", "x_m": -200e-9, "y_m": 100e-9},
              {"kind": "crash", "x_m": 900e-9, "y_m": 900e-9}],
        profile={"avoid_radius_pulse_nm": 500.0}),
    # ② 一个圈都没有，而可用区比落点净空还小 ⇒ 说「这个区放不下一个点」。
    #    ⚠️ 走到这一支不容易：`nearest_clean_from` 在 `reach < r_spot` 时会
    #    **退回压电范围**，于是区心 (0,0) 几乎总是活着。要同时满足「空表」
    #    与「一个圈都没有」，只能靠 `max_distance_m` 把区心也够不着 ——
    #    而那正是这句话该出现的场合：**表面没用完，是这个区根本放不下一个点**。
    "no_spot_zone_too_small": dict(
        params={"count": 3, "max_distance_m": 1e-9},
        replies={"FolMe_XYPosGet": ("", b"", [123e-9, 45e-9])},
        profile={"avoid_radius_pulse_nm": 700.0}),
    # ③ 地图与撞针记忆里都没有挡路的东西 ⇒ 「看几何/配置」。
    "no_spot_nothing_blocking": dict(
        params={"count": 3, "max_distance_m": 1e-9},
        profile={"avoid_radius_pulse_nm": 500.0},
        replies={"FolMe_XYPosGet": ("", b"", [123e-9, 45e-9])}),
    # ── 实时扫描框改变候选间距（`analysis_config` 的 state 那一路）───────
    "state_frame_50nm": dict(params={"purpose": "tip_shape", "count": 3},
                             state=(50e-9, False)),
    # ── 读不到实验记录的三条来路，在回包里长得一模一样 ──────────────────
    "storage_raises": dict(params={"count": 2}, rows="raises"),
    "no_storage": dict(params={"count": 2}, rows="no-storage"),
    # 追踪器抛了 ⇒ 少了一个来源，而 `avoidance_sources` 里看不出来（照移）。
    "tracker_raises": dict(params={"count": 2},
                           tracker=_Tracker([], 0, raises=True)),
    # ── count 的边界 ─────────────────────────────────────────────────
    "count_none_defaults_to_eight": dict(params={"count": None}),
    "count_one": dict(params={"count": 1}),
}


def sec_skill() -> dict:
    skill = FindCleanSpot()
    out: dict[str, Any] = {}
    for name, c in SKILL_CASES.items():
        replies = {"FolMe_XYPosGet": _TIP_OK, "Piezo_RangeGet": _RANGE_TIGHT}
        replies.update(c.get("replies") or {})
        _set_world(profile=c.get("profile"), rows=c.get("rows", "no-log"),
                   tracker=c.get("tracker"))
        st = c.get("state")
        ctx = _Ctx(replies, state=None if st is None else _State(st[0], raises=st[1]))
        res = skill.execute(ctx, dict(c["params"]))
        out[name] = {
            "params": _plain(c["params"]),
            "world": {
                "profile": _plain(c.get("profile") or {}),
                "rows": _plain(c.get("rows", "no-log")
                               if isinstance(c.get("rows", "no-log"), (str, list))
                               else str(c.get("rows"))),
                "replies": {k: _plain(v) for k, v in replies.items()},
                "state_scan_width_m": _plain(None if st is None else st[0]),
            },
            "calls": ctx.calls,
            "result": _result_dict(res),
        }
    return out


def sec_parse_spots() -> dict:
    """`parse_spots`：**坏块跳过，不是整串作废**。"""
    cases = {
        "empty": "",
        "one": "1e-9,2e-9",
        "two": "1e-9,2e-9;3e-9,4e-9",
        "spaces": "  1e-9 , 2e-9  ;  3e-9,4e-9  ",
        "trailing_semicolons": "1e-9,2e-9;;;",
        "wrong_arity": "1,2,3;4",
        "not_numbers": "x,y;1e-9,2e-9",
        "nan_is_a_float": "nan,1e-9",
        "inf_is_a_float": "inf,1e-9",
        "all_junk": "乱写",
    }
    return {k: {"raw": v, "spots": _plain([list(t) for t in parse_spots(v)])}
            for k, v in cases.items()}


def main() -> int:
    out = {
        "ring_cells": sec_ring_cells(),
        "config": sec_config(),
        "markers": sec_markers(),
        "epochs": sec_epochs(),
        "load_markers": sec_load_markers(),
        "crash_memory": sec_crash_memory(),
        "avoid_circles": sec_avoid_circles(),
        "nearest": nearest_cases(),
        "parse_spots": sec_parse_spots(),
        "skill": sec_skill(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True,
                   allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    n = {k: len(v) for k, v in out.items()}
    print(f"[ok]   map_scope.json: " + " · ".join(f"{k} {v}" for k, v in n.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
