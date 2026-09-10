"""把安全闸门的表与判定行为录成金样。

Phase 2 是整个项目的承重墙——后面 400 多个技能全部穿过同一个 choke point，
闸门写错一次错的就是 400 多次。所以这一段的纪律是：**闸门先有 golden，再有实现，再有变异。**

驱动的是**旧仓真实实现** `mast/core/safety.py` 与 `mast/core/execution_context.py`：
表直接读出来，判定逐条真跑。TS 侧 `packages/host/kernel/src/safety*.ts` 对着比。

    python \\
        tools/spec-export/export_safety_spec.py

**报错原文也是契约**：物理荒谬那句教学文案是模型读的东西，逐字录。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

MAST_ROOT = Path(r"<MAST_ROOT>")  # Historical revision: configure this local source path before use.
SPEC = Path(__file__).resolve().parents[2] / "spec"
OUT = SPEC / "golden" / "safety.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.config import SafetyLimits  # noqa: E402
from mast.core import safety as sf  # noqa: E402
from mast.core import execution_context as ec  # noqa: E402
from mast.core import sample_gate as sg  # noqa: E402
from mast.core.types import OperatingMode, ParameterSpec, SkillMetadata  # noqa: E402


def meta(params: list[tuple[str, str]], **kw) -> SkillMetadata:
    """够闸门用的最小技能元数据：只要 (参数名, 单位)。"""
    return SkillMetadata(
        name=kw.pop("name", "_Probe"),
        description="金样探针",
        parameters=[ParameterSpec(name=n, type="number", description="", unit=u) for n, u in params],
        **kw,
    )


# ── 物理荒谬：**报错原文逐字录** ────────────────────────────────────────────
ABSURD_CASES: list[dict] = [
    {"case": "setpoint_1p5A", "params": [("setpoint_a", "A")], "args": {"setpoint_a": 1.5}},
    {"case": "setpoint_100p_ok", "params": [("setpoint_a", "A")], "args": {"setpoint_a": 1e-10}},
    # 字符串通道：'3p' 与 '3e-12' 都要认得出来，否则「改成字符串」就成了这张表的洞
    {"case": "setpoint_si_string", "params": [("setpoint_a", "A")], "args": {"setpoint_a": "1.5"}},
    {"case": "setpoint_si_prefix_ok", "params": [("setpoint_a", "A")], "args": {"setpoint_a": "100p"}},
    {"case": "bias_1e6V", "params": [("bias_v", "V")], "args": {"bias_v": 1e6}},
    {"case": "bias_minus3_ok", "params": [("bias_v", "V")], "args": {"bias_v": -3.0}},
    # 2026-08-03 真机：3e-12 → 3，一个 1e12 倍的错，当时系统里没有任何东西能拦
    {"case": "p_gain_3m", "params": [("p_gain", "m")], "args": {"p_gain": 3.0}},
    {"case": "p_gain_ok", "params": [("p_gain", "m")], "args": {"p_gain": 3e-12}},
    # 单位精确匹配 ⇒ 无量纲的 p_gain（开尔文环 / PLL）不受这条管
    {"case": "p_gain_dimensionless", "params": [("p_gain", "")], "args": {"p_gain": 3.0}},
    {"case": "i_gain_fast", "params": [("i_gain", "m/s")], "args": {"i_gain": 5.0}},
    {"case": "unknown_param", "params": [("bias_v", "V")], "args": {"没这个参数": 1e9}},
    {"case": "non_numeric", "params": [("label", "")], "args": {"label": "abc"}},
    {"case": "bool_not_number", "params": [("flag", "")], "args": {"flag": True}},
]


# ── 五条硬闸：每条一组正反例 ────────────────────────────────────────────────
HARD_GATE_CASES: list[dict] = [
    # 1 粗逼近样品 —— **这是 MAST 里唯一一类物理上危险的动作**（粗 Z 步进没有
    #   电流反馈停止，步数/步长过大就把针撞进样品）。判据键在**语义方向**上，
    #   不在原始 Nanonis Z 码上；闭环移动只要**碰到 Z 就一律算**（保守）。
    {"fn": "is_coarse_sample_approach", "case": "motor_z_approach", "skill": "MotorMove",
     "params": {"direction": "z-approach", "steps": 10}},
    {"fn": "is_coarse_sample_approach", "case": "motor_z_approach_underscore", "skill": "MotorMove",
     "params": {"direction": "z_approach"}},
    {"fn": "is_coarse_sample_approach", "case": "motor_z_retract", "skill": "MotorMove",
     "params": {"direction": "z-retract"}},
    {"fn": "is_coarse_sample_approach", "case": "motor_lateral", "skill": "MotorMove",
     "params": {"direction": "X+"}},
    # 闭环 + 绝对定位：**Z 目标存在就一律闸**，哪怕是 0.0——绝对目标的「安全一侧」
    # 静态证不出来。而且这个判据跑在**模型原始 JSON** 上：弱模型常发 absolute="true"/1，
    # 一个裸的 `is True` 会把它们看成 False 掉进相对分支，那里 0.0 又读成「没动 Z」，
    # 于是整道人审闸门被跳过。所以 truthy 要认全，认不出来也**fail-closed**。
    {"fn": "is_coarse_sample_approach", "case": "closed_loop_abs_zero", "skill": "MotorMoveClosedLoop",
     "params": {"target_z_m": 0.0, "absolute": True}},
    {"fn": "is_coarse_sample_approach", "case": "closed_loop_abs_string", "skill": "MotorMoveClosedLoop",
     "params": {"target_z_m": 0.0, "absolute": "true"}},
    {"fn": "is_coarse_sample_approach", "case": "closed_loop_abs_one", "skill": "MotorMoveClosedLoop",
     "params": {"target_z_m": 0.0, "absolute": 1}},
    {"fn": "is_coarse_sample_approach", "case": "closed_loop_rel_zero", "skill": "MotorMoveClosedLoop",
     "params": {"target_z_m": 0.0}},
    {"fn": "is_coarse_sample_approach", "case": "closed_loop_rel_nonzero", "skill": "MotorMoveClosedLoop",
     "params": {"target_z_m": "-100n"}},
    {"fn": "is_coarse_sample_approach", "case": "closed_loop_unparseable_z", "skill": "MotorMoveClosedLoop",
     "params": {"target_z_m": "往下一点"}},
    {"fn": "is_coarse_sample_approach", "case": "closed_loop_xy_only", "skill": "MotorMoveClosedLoop",
     "params": {"target_x_m": 1e-6}},
    {"fn": "is_coarse_sample_approach", "case": "set_bias", "skill": "SetBias", "params": {"bias_v": 1.0}},
    # 2 标定改动
    {"fn": "is_calibration_change", "case": "set_bias_calibration", "skill": "SetBiasCalibration", "params": {}},
    {"fn": "is_calibration_change", "case": "set_current_calibration", "skill": "SetCurrentCalibration", "params": {}},
    {"fn": "is_calibration_change", "case": "get_bias", "skill": "GetBias", "params": {}},
    # 3 粗动改动
    {"fn": "is_coarse_drive_change", "case": "set_motor_freq_amp", "skill": "SetMotorFreqAmp", "params": {}},
    {"fn": "is_coarse_drive_change", "case": "set_bias", "skill": "SetBias", "params": {}},
    # 4 无保护的横向粗动
    {"fn": "is_unguarded_lateral_coarse_move", "case": "motor_move_x", "skill": "MotorMove",
     "params": {"direction": "X+", "steps": 10}},
    {"fn": "is_unguarded_lateral_coarse_move", "case": "motor_move_z", "skill": "MotorMove",
     "params": {"direction": "Z-", "steps": 10}},
    # 5 关掉保护
    {"fn": "is_protection_disable", "case": "z_limits_off", "skill": "SetZLimitsEnabled", "params": {"enabled": False}},
    {"fn": "is_protection_disable", "case": "z_limits_on", "skill": "SetZLimitsEnabled", "params": {"enabled": True}},
    {"fn": "is_protection_disable", "case": "safe_tip_off", "skill": "EnableSafeTip", "params": {"enable": False}},
    {"fn": "is_protection_disable", "case": "safe_tip_on", "skill": "EnableSafeTip", "params": {"enable": True}},
    # 弱模型常发 "false" / 0 这类字符串与数字，判据必须认得出来
    {"fn": "is_protection_disable", "case": "z_limits_off_string", "skill": "SetZLimitsEnabled", "params": {"enabled": "false"}},
    {"fn": "is_protection_disable", "case": "z_limits_off_zero", "skill": "SetZLimitsEnabled", "params": {"enabled": 0}},
]

CAPABILITY_CASES: list[dict] = [
    # 签名是 (skill_name, params, capabilities) —— 第三个是**能力集合**，不是 meta。
    # 我第一版把 meta 当成 params 传，于是每条都判成 False：金样当场把我按住了。
    {"fn": "is_tip_shaping", "case": "tip_shaping_cap", "caps": [sf.CAP_TIP_SHAPING], "params": {}},
    {"fn": "is_tip_shaping", "case": "no_cap", "caps": [], "params": {}},
    {"fn": "is_electrical_pulse", "case": "pulse_cap", "caps": [sf.CAP_BIAS_PULSE], "params": {}},
    {"fn": "is_electrical_pulse", "case": "no_cap", "caps": [], "params": {}},
    # ── 下面这组是 2026-08-11 那条真机教训 ──────────────────────────────────
    # TipShaper 有**两个**偏压字段，只有一个是有条件的（厂商用了同一句话，一个带
    # 条件、一个不带）：Bias(V) 要 change_bias 为真才施加，而 **Bias Lift(V) 无条件
    # 施加**。这个函数原来一看到 change_bias=False 就短路成 False、从不看
    # bias_lift_v——而 bias_lift_v 自己的默认值是 **3.0 V**。
    # 于是闸门放行了一批「纯机械」的扎针，它们其实无条件、静默地往针上加了 3 V。
    # （qPlus 传感器上操作员的规矩是 20 mV，3 V 是它的 150 倍，会把音叉敲响。）
    {"fn": "is_electrical_pulse", "case": "shaping_change_bias_false_lift_omitted",
     "caps": [sf.CAP_TIP_SHAPING], "params": {"change_bias": False}},
    {"fn": "is_electrical_pulse", "case": "shaping_lift_zero",
     "caps": [sf.CAP_TIP_SHAPING], "params": {"change_bias": False, "bias_lift_v": 0.0}},
    {"fn": "is_electrical_pulse", "case": "shaping_lift_nonzero",
     "caps": [sf.CAP_TIP_SHAPING], "params": {"change_bias": False, "bias_lift_v": 3.0}},
    {"fn": "is_electrical_pulse", "case": "shaping_lift_unparseable",
     "caps": [sf.CAP_TIP_SHAPING], "params": {"change_bias": False, "bias_lift_v": "一点点"}},
    {"fn": "is_electrical_pulse", "case": "shaping_change_bias_true_bias_live",
     "caps": [sf.CAP_TIP_SHAPING], "params": {"change_bias": True, "bias_v": 2.0, "bias_lift_v": 0.0}},
    {"fn": "is_electrical_pulse", "case": "shaping_change_bias_true_bias_zero",
     "caps": [sf.CAP_TIP_SHAPING], "params": {"change_bias": True, "bias_v": 0.0, "bias_lift_v": 0.0}},
    # 「没说」不等于「零」：省略的偏压由技能后面解析，闸门看不到结果 ⇒ fail-closed
    {"fn": "is_electrical_pulse", "case": "shaping_bias_omitted",
     "caps": [sf.CAP_TIP_SHAPING], "params": {"change_bias": True, "bias_lift_v": 0.0}},
]


# ── 模式拒绝：SAFE / SEMI / AUTO / 未知 ────────────────────────────────────
MODE_CASES: list[dict] = [
    {"case": f"{m}_{k}", "mode": m, "kind": k}
    for m in ("SAFE", "SEMI", "AUTO", "UNKNOWN")
    for k in ("pulse", "shaping_shallow", "shaping_deep", "plain")
]

KIND_TO_META = {
    "pulse": ([], [sf.CAP_BIAS_PULSE], {}),
    "shaping_shallow": ([("tip_lift", "m")], [sf.CAP_TIP_SHAPING], {"tip_lift": 1e-9}),
    "shaping_deep": ([("tip_lift", "m")], [sf.CAP_TIP_SHAPING], {"tip_lift": 5e-8}),
    "plain": ([("bias_v", "V")], [], {"bias_v": 1.0}),
}


# ── 中止后还能不能发：逐条 ────────────────────────────────────────────────
ABORT_CASES: list[tuple[str, list]] = [
    ("Bias_Get", []),                      # 读，永远放行
    ("ZCtrl_Withdraw", [1, -1]),           # 无条件安全
    ("Motor_StopMove", []),
    ("Bias_Set", [1.0]),                   # 普通写，拒
    ("Scan_Action", [1, 0]),               # 1 = STOP ⇒ 放行
    ("Scan_Action", [0, 0]),               # 0 = START ⇒ **拒**（拿错参数下标就是这条会错）
    ("Scan_Action", [2, 0]),               # 2 = PAUSE ⇒ 放行
    ("AutoApproach_OnOffSet", [0]),        # 关 ⇒ 放行
    ("AutoApproach_OnOffSet", [1]),        # 开 ⇒ 拒
    ("AtomTrack_CtrlSet", [1, 0]),         # Status 索引是 1
    ("AtomTrack_CtrlSet", [1, 1]),
    ("Script_Stop", []),                   # 这张表里最重要的一条
    ("ZCtrl_OnOffSet", [0]),               # **刻意不在表里**：关反馈环不是「停」
    ("Scan_Action", []),                   # 参数缺失 ⇒ 证不出是停 ⇒ 拒
    ("Scan_Action", ["x", 0]),             # 参数不是整数 ⇒ 拒
]



# ── 样品门控（四张表 + 判定顺序 + 两句拒绝文案） ─────────────────────────────
# **fail-open**，与 instrument_lock 的 fail-closed 刻意相反：
# 分类不出来时放行，因为它的失败模式是「一条记录没归属到样品」= 记账损失；
# 而误拦一个安全操作，可能让操作员在针要撞上去的时候按不动按钮。


class FakeMeta:
    """够门控用的最小 meta。"""

    def __init__(self, name="", tags=(), category=None, capabilities=()):
        self.name = name
        self.tags = tags
        self.category = category
        self.capabilities = capabilities


SAMPLE_GATE_CASES: list[dict] = [
    # 1 名字在豁免表 —— 补救动作，存在的意义就是出事时立刻能跑
    {"case": "exempt_name_safe_retract", "name": "SafeRetract"},
    {"case": "exempt_name_stop_scan", "name": "StopScan"},
    # 2 标签命中豁免 —— 即使名字看起来像产数据
    {"case": "exempt_tag_read", "name": "StartScan", "tags": ["read"]},
    {"case": "exempt_tag_emergency", "name": "SomethingScanny", "tags": ["emergency", "scan"]},
    # 3 category 是 READ / ANALYSIS
    {"case": "category_read", "name": "StartScan", "category": "read"},
    {"case": "category_analysis", "name": "StartScan", "category": "SkillCategory.ANALYSIS"},
    # 4 标签或名字命中产数据集合
    {"case": "data_tag_scan", "name": "随便什么", "tags": ["scan"]},
    {"case": "data_tag_spectroscopy", "name": "随便什么", "tags": ["spectroscopy"]},
    {"case": "data_name_start_scan", "name": "StartScan"},
    {"case": "data_name_tip_pulse", "name": "TipPulse"},
    # 4b 能力标签也算产数据
    {"case": "cap_produces_file", "name": "随便什么", "capabilities": ["produces_file"]},
    {"case": "cap_tip_shaping", "name": "随便什么", "capabilities": ["tip_shaping"]},
    # 5 兜底：分类不出来 ⇒ **放行**
    {"case": "unknown_fail_open", "name": "GetSomething"},
    {"case": "empty_meta_fail_open", "name": ""},
    # 顺序要紧：豁免在产数据判断**之前**
    {"case": "order_exempt_beats_data", "name": "StopScan", "tags": ["scan"]},
]


def sample_gate_rows() -> list[dict]:
    from mast.core import sample_gate as sg

    rows = []
    for c in SAMPLE_GATE_CASES:
        m = FakeMeta(
            name=c.get("name", ""),
            tags=tuple(c.get("tags", ())),
            category=c.get("category"),
            capabilities=tuple(c.get("capabilities", ())),
        )
        rows.append({
            "case": c["case"],
            "name": c.get("name", ""),
            "tags": list(c.get("tags", ())),
            "category": c.get("category"),
            "capabilities": list(c.get("capabilities", ())),
            "requires_sample": sg.requires_sample(m, c.get("name", "")),
        })
    return rows
def jsonable(v):
    if isinstance(v, frozenset):
        return sorted(v)
    if isinstance(v, tuple):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {k: jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [jsonable(x) for x in v]
    return v


def main() -> int:
    verbs = json.loads((SPEC / "nanonis" / "nanonis_commands.json").read_text(encoding="utf-8"))
    method_names = sorted(verbs["methods"].keys())

    out: dict = {
        "limits": jsonable(SafetyLimits().model_dump()),
        "global_checks": [list(t) for t in sf._GLOBAL_CHECKS],
        "physical_absurd": [list(t) for t in sf._PHYSICAL_ABSURD],
        "caps": {
            "CAP_BIAS_PULSE": sf.CAP_BIAS_PULSE,
            "CAP_TIP_SHAPING": sf.CAP_TIP_SHAPING,
            "SEMI_TIP_LIFT_MAX_M": sf.SEMI_TIP_LIFT_MAX_M,
            "SEMI_DEPTH_NAME_PATTERNS": list(sf._SEMI_DEPTH_NAME_PATTERNS),
        },
        "abort_safe_writes": {k: jsonable(v) for k, v in ec._ABORT_SAFE_WRITES.items()},
    }

    # `_is_read` 对全部 671 个动词的判定表。**这条判据决定「中止后还能不能读」**，
    # 而它的实现只有三个子串条件——正因为简单，抄错了很难看出来。
    out["is_read"] = {m: ec._is_read(m) for m in method_names}
    out["is_read_summary"] = {
        "total": len(method_names),
        "read": sum(1 for m in method_names if ec._is_read(m)),
    }

    out["absurd_cases"] = [
        {
            "case": c["case"],
            "args": c["args"],
            "violations": sf.physically_absurd_violations(meta(c["params"]), c["args"]),
        }
        for c in ABSURD_CASES
    ]

    out["hard_gate_cases"] = [
        {"fn": c["fn"], "case": c["case"], "skill": c["skill"], "params": c["params"],
         "result": getattr(sf, c["fn"])(c["skill"], c["params"])}
        for c in HARD_GATE_CASES
    ]

    out["capability_cases"] = [
        {"fn": c["fn"], "case": c["case"], "caps": c["caps"], "params": c["params"],
         "result": getattr(sf, c["fn"])("_Probe", c["params"], frozenset(c["caps"]))}
        for c in CAPABILITY_CASES
    ]

    mode_rows = []
    for c in MODE_CASES:
        params, caps, args = KIND_TO_META[c["kind"]]
        m = meta(params, capabilities=caps)
        mode = None if c["mode"] == "UNKNOWN" else OperatingMode[c["mode"]]
        mode_rows.append({
            "case": c["case"], "mode": c["mode"], "kind": c["kind"], "args": args,
            "refusal": sf.mode_refusal("_Probe", m, args, mode),
        })
    out["mode_refusal_cases"] = mode_rows

    out["sample_gate"] = {
        "exempt_names": sorted(sg.GATE_EXEMPT_NAMES),
        "exempt_tags": sorted(sg.GATE_EXEMPT_TAGS),
        "data_tags": sorted(sg.DATA_TAGS),
        "data_names": sorted(sg.DATA_NAMES),
    }
    out["sample_gate_cases"] = sample_gate_rows()
    out["sample_gate_messages"] = {
        "no_experiment": sg.sample_gate_message("StartScan", has_experiment=False),
        "no_sample": sg.sample_gate_message("StartScan", has_experiment=True),
    }

    out["abort_cases"] = [
        {"method": m, "args": list(a), "allowed": ec._is_abort_safe(m, tuple(a))}
        for m, a in ABORT_CASES
    ]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(f"[ok]   safety.json:")
    print(f"       limits {len(out['limits'])} 字段 · global_checks {len(out['global_checks'])} 行 · "
          f"physical_absurd {len(out['physical_absurd'])} 行")
    print(f"       is_read {out['is_read_summary']['read']}/{out['is_read_summary']['total']} 判为读")
    print(f"       absurd {len(out['absurd_cases'])} · hard_gate {len(out['hard_gate_cases'])} · "
          f"capability {len(out['capability_cases'])} · mode {len(out['mode_refusal_cases'])} · "
          f"abort {len(out['abort_cases'])} · abort_safe_writes {len(out['abort_safe_writes'])} 条")
    print(f"       sample_gate 四表 {sum(len(v) for v in out['sample_gate'].values())} 项 / "
          f"{len(out['sample_gate_cases'])} 条用例")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
