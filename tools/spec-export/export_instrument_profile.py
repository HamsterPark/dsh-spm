"""把**仪器档案**那台判定机录成金样。

驱动的是**旧仓真实实现** `mast/core/instrument_profile.py`。

    python \\
        tools/spec-export/export_instrument_profile.py

## 为什么单开一台驱动器

`export_skill_traces.py` 那台通用驱动器喂的是**常数回包**，子技能一律
`success=True, data={}` —— 它走到的是调用序列与报文，**碰不到档案自己的判据**：
键表的夹取与丢弃、`get_config` 的三级回落、`z_extend_sign` 的三态、
倾斜标定「四个元素缺一个就是没标定过」。那几条正是这一批的要害。

## 键表是**裁过**的

本仓只登记有消费方的键（`kernel/src/instrument-profile.ts` 的 `CONFIG_SPEC`）。
这里 `spec` 那一段**逐条录旧仓对这些键的声明**（标签 / 单位 / 类型 / 区间 / 出厂默认），
于是「我们抄对了没有」和「旧仓哪天改了区间」都由 `git diff` 回答。
`ablated_keys` 记下没登记的那些 —— 让「少了」与「漏了」分得开。

## 时钟

档案自己不读钟（读钟的是 `ReadCalibrations` 的年龄那一段，它在
`skill_traces.json` 里，那台驱动器把墙钟钉死在 `1_700_000_000`）。所以这份金样
没有随机成分，重跑逐字节相同。
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
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "instrument_profile.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.core import instrument_profile as ip   # noqa: E402

#: 本仓登记的数值键（有消费方的那些）。顺序 = `CONFIG_SPEC` 里的顺序。
CONFIG_KEYS = [
    "z_recede_min_nm", "z_settle_timeout_s",
    "retract_total_steps", "retract_step_max", "lockin_signal_index",
    "xy_prewithdraw_steps", "xy_move_chunk_steps", "preamp_full_scale_a",
    # ── 批 7a-2：实验地图层（`map_scope.analysis_config` 是它们的消费方）──
    "avoid_radius_tip_shape_nm", "avoid_radius_pulse_nm",
    "avoid_radius_crash_nm", "avoid_radius_approach_nm",
    "scan_spacing_factor",
]
CHOICE_KEYS = [
    "retract_motor_dir", "z_extend_sign",
    # ── 批 7a-2 ──
    "xy_coarse_motion", "approach_damages_surface", "scan_path_strategy",
]

#: 一台**填过**的机器，与 `export_skill_traces.PROFILE_FIXTURE` 同形（少几个标定键）。
FILLED = {
    "retract_motor_dir": "z-", "z_extend_sign": "-1",
    "z_recede_min_nm": 2.5, "z_settle_timeout_s": 9.0,
    "retract_total_steps": 111, "retract_step_max": 100,
    "xy_prewithdraw_steps": 11, "xy_move_chunk_steps": 10,
    "lockin_signal_index": 86, "preamp_full_scale_a": 1e-8,
}

#: `sanitize` 的用例。每一条压着一种「洗法」。
SANITIZE_CASES: list[tuple[str, Any]] = [
    ("not_a_dict", "nope"),
    ("none", None),
    ("empty", {}),
    ("unknown_keys_dropped", {"nope": 1, "qplus_f0_hz": 32768.0, "qplus_q": 24000.0}),
    ("clamped_high", {"z_recede_min_nm": 1e9, "retract_step_max": 99999}),
    ("clamped_low", {"z_recede_min_nm": -5.0, "xy_prewithdraw_steps": -1}),
    ("int_truncates", {"retract_total_steps": 7.9, "lockin_signal_index": 12.5}),
    ("nan_and_inf_dropped", {"z_recede_min_nm": float("nan"),
                             "z_settle_timeout_s": float("inf")}),
    ("empty_string_dropped", {"z_recede_min_nm": "", "retract_motor_dir": ""}),
    # ⚠️ 空**白**串不是空串：`Number('  ')` 在 JS 里是 `0`，而 `0 nm` 的远离阈值
    #    等于「任何 Z 变化都算远离」。旧仓 `float('  ')` 抛 ⇒ 丢掉。
    ("blank_string_dropped", {"z_recede_min_nm": "   ", "tilt_cal_g11": " "}),
    ("bool_dropped", {"z_recede_min_nm": True, "retract_total_steps": False}),
    ("none_dropped", {"z_recede_min_nm": None}),
    ("numeric_string_coerced", {"z_recede_min_nm": "3.5"}),
    ("bad_choice_dropped", {"retract_motor_dir": "x+", "z_extend_sign": "0"}),
    ("good_choice_trimmed", {"retract_motor_dir": " z- ", "z_extend_sign": "+1"}),
    ("calib_passthrough", {"tilt_cal_g11": 1.0, "tilt_cal_g12": 0.0,
                           "tilt_cal_g21": 0.0, "tilt_cal_g22": 1.0,
                           "tilt_cal_cond": 1.0, "tilt_cal_updated_at": 1.0}),
    ("calib_junk_dropped", {"tilt_cal_g11": "abc", "tilt_cal_cond": float("nan")}),
    ("filled", dict(FILLED)),
    # ── 批 7a-2：地图层那几个键的洗法 ───────────────────────────────────
    # `scan_spacing_factor` 的区间是 [1, 20] ⇒ 0.5 被**夹到 1.0**。
    # 这就是为什么 `analysis_config._spacing` 里 `v < 1` 那一支从档案这条路不可达。
    ("map_keys_clamped", {"scan_spacing_factor": 0.5,
                          "avoid_radius_pulse_nm": -10.0,
                          "avoid_radius_crash_nm": 1e9}),
    ("map_choices", {"xy_coarse_motion": "no",
                     "approach_damages_surface": " no ",
                     "scan_path_strategy": "perimeter_inward"}),
    ("map_choices_bad", {"xy_coarse_motion": "maybe",
                         "approach_damages_surface": "NO",
                         "scan_path_strategy": "spiral"}),
    # 未注册 ⇒ 静默丢掉（这条规则本身咬过人：D-QPLUS-1）。
    ("center_zone_side_nm_dropped", {"center_zone_side_nm": 500.0}),
]

#: `get_config` 的用例：`(profile, key, default)`。
GET_CONFIG_CASES: list[tuple[str, dict, str, Any]] = [
    ("empty_profile_spec_default", {}, "z_recede_min_nm", None),
    ("empty_profile_no_spec_default", {}, "lockin_signal_index", None),
    ("empty_profile_caller_default", {}, "lockin_signal_index", 7),
    ("empty_profile_unknown_key", {}, "nope", "fallback"),
    # ⚠️ 旧仓这一格是**真缺陷**：`qplus_f0_hz` 从来没在键表里注册过，
    #    于是 `ReadCalibrations` 的「标称 f₀」永远是 `None`（见交接 §0）。
    ("unregistered_nominal_key", {}, "qplus_f0_hz", None),
    ("filled_wins", dict(FILLED), "z_recede_min_nm", None),
    ("choice_spec_default", {}, "retract_motor_dir", None),
    ("choice_filled", dict(FILLED), "retract_motor_dir", None),
    ("z_extend_sign_spec_default_is_not_neutral", {}, "z_extend_sign", None),
    # ── 批 7a-2：地图层那几个键 ─────────────────────────────────────────
    # ⚠️ `avoid_radius_pulse_nm` 的**出厂默认 150** 正是 2026-08-13 那个坑：
    #    `get_config` 会拿它把调用方给的默认整个遮蔽掉，所以 `analysis_config`
    #    对这一个键走的是 `get_profile()`（`_nm_unless_set`）而不是这里。
    ("pulse_radius_spec_default_shadows_the_caller", {},
     "avoid_radius_pulse_nm", 200.0),
    ("pulse_radius_from_profile", {"avoid_radius_pulse_nm": 500.0},
     "avoid_radius_pulse_nm", 200.0),
    # `center_zone_side_nm` **从来没在键表里注册过** ⇒ 这个旋钮拧不动
    # （与上面 `qplus_f0_hz` 同一个形状的旧仓缺陷，批 7a-2 又撞见一次）。
    ("center_zone_side_nm_is_unregistered", {"center_zone_side_nm": 500.0},
     "center_zone_side_nm", None),
    ("xy_coarse_motion_default", {}, "xy_coarse_motion", None),
    ("approach_damages_default_is_unknown", {}, "approach_damages_surface", None),
    ("scan_path_strategy_default_is_auto", {}, "scan_path_strategy", None),
    ("scan_spacing_factor_default", {}, "scan_spacing_factor", 1.2),
]

#: `z_extend_sign_or_none` 的三态。
SIGN_CASES: list[tuple[str, dict]] = [
    ("never_declared", {}),
    ("declared_plus", {"z_extend_sign": "+1"}),
    ("declared_minus", {"z_extend_sign": "-1"}),
    # sanitize 会把它丢掉 ⇒ 与「没声明」同一格。**这正是判据**：
    # 判的是「值在不在 profile 里」，不是「值等不等于出厂默认」。
    ("junk_is_not_declared", {"z_extend_sign": "0"}),
    ("other_keys_only", dict(FILLED, z_extend_sign="")),
]

#: 倾斜标定：四个元素**缺一个就是没标定过**。
TILT_CASES: list[tuple[str, dict]] = [
    ("never", {}),
    ("three_of_four_is_never", {"tilt_cal_g11": 1.0, "tilt_cal_g12": 0.0,
                                "tilt_cal_g21": 0.0, "tilt_cal_cond": 1.0}),
    ("full", {"tilt_cal_g11": -1.02, "tilt_cal_g12": 0.07,
              "tilt_cal_g21": 0.03, "tilt_cal_g22": -0.98,
              "tilt_cal_cond": 1.1128, "tilt_cal_updated_at": 1_699_000_000.0}),
    ("full_without_cond_or_stamp", {"tilt_cal_g11": 1.0, "tilt_cal_g12": 0.0,
                                    "tilt_cal_g21": 0.0, "tilt_cal_g22": 1.0}),
]

#: 接触点 dI/dV：档案读得到，而这一项从未写过。
CALIB_CASES: list[tuple[str, dict]] = [
    ("never", {}),
    ("filled", {"didv_at_contact_v": 2.5e-3, "didv_cal_bias_v": 0.05,
                "didv_cal_setpoint_a": 1e-10, "didv_cal_mod_amp_v": 0.02,
                "didv_cal_updated_at": 1_699_996_400.0}),
    ("partial", {"didv_cal_bias_v": 0.05}),
]


def main() -> int:
    spec: dict[str, Any] = {}
    for key in CONFIG_KEYS:
        label, unit, kind, (lo, hi), default = ip._CONFIG_SPEC[key]
        spec[key] = {"label": label, "unit": unit, "type": kind.__name__,
                     "min": lo, "max": hi, "default": default}
    choices: dict[str, Any] = {}
    for key in CHOICE_KEYS:
        label, allowed, disp, default = ip._CHOICE_SPEC[key]
        choices[key] = {"label": label, "choices": list(allowed),
                        "display": dict(disp), "default": default}

    out: dict[str, Any] = {
        "constants": {
            "tilt_cal_max_cond": ip.TILT_CAL_MAX_COND,
            "tilt_cal_keys": list(ip.TILT_CAL_KEYS),
            "motor_dir_code": dict(ip._MOTOR_DIR_CODE),
            "calib_keys": list(ip._CALIB_KEYS),
        },
        "spec": spec,
        "choice_spec": choices,
        # 旧仓有、本仓**没登记**的键。记下来，让「少了」与「漏了」分得开。
        "ablated_keys": sorted(
            set(ip._CONFIG_SPEC) - set(CONFIG_KEYS)
            | set(ip._CHOICE_SPEC) - set(CHOICE_KEYS)
            | set(ip._TEXT_SPEC)),
        "spec_default": {k: ip.spec_default(k)
                         for k in CONFIG_KEYS + CHOICE_KEYS + ["nope"]},
        "sanitize": {},
        "get_config": {},
        "z_extend_sign_or_none": {},
        "retract_dir_code": {},
        "tilt_calibration": {},
        "calibration": {},
    }

    for name, raw in SANITIZE_CASES:
        # **只留本仓登记的键**——旧仓洗出来的其余键是消融掉的那一半，
        # 拿它们去比会把「没登记」错报成「洗错了」。
        clean = ip.sanitize(raw)
        keep = set(CONFIG_KEYS) | set(CHOICE_KEYS) | set(ip._CALIB_KEYS)
        out["sanitize"][name] = {k: v for k, v in clean.items() if k in keep}

    for name, profile, key, default in GET_CONFIG_CASES:
        ip.set_profile(profile)
        out["get_config"][name] = {
            "key": key, "default": default, "value": ip.get_config(key, default)}

    for name, profile in SIGN_CASES:
        ip.set_profile(profile)
        out["z_extend_sign_or_none"][name] = ip.z_extend_sign_or_none()

    for name, profile in [("never", {}), ("z_plus", {"retract_motor_dir": "z+"}),
                          ("z_minus", {"retract_motor_dir": "z-"}),
                          ("junk", {"retract_motor_dir": "x+"})]:
        ip.set_profile(profile)
        out["retract_dir_code"][name] = ip.get_retract_dir_code()

    for name, profile in TILT_CASES:
        ip.set_profile(profile)
        out["tilt_calibration"][name] = ip.get_tilt_calibration()

    for name, profile in CALIB_CASES:
        ip.set_profile(profile)
        out["calibration"][name] = ip.get_calibration()

    ip.set_profile({})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(f"[ok]   instrument_profile.json: {len(out['sanitize'])} 洗 / "
          f"{len(out['get_config'])} 读 / {len(out['z_extend_sign_or_none'])} 符号 / "
          f"{len(out['tilt_calibration'])} 倾斜")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
