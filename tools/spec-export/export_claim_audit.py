"""把「声明交叉核对」录成金样。

驱动的是**旧仓真实的** `mast/logging/v2/claim_audit.py`。

它存在的理由是 2026-07-27 取证 确证-2：instrument_control 报告

    [HANDOFF → data_processing] 5-point STS grid acquired (40 nm spacing, …).
    Per-point summary JSON: D:\\data\\claim-audit\\GridSTS_report.txt

运行以「完成」结束。而那条消息覆盖的 25 秒里，服务日志只有三次对模型 provider 的
HTTP 调用——**没有技能跑过、没有 action 行、没有标记、它点名的那个文件从未被创建**。
操作的人读了消息、相信测量发生过，然后就「IC 和 DP 的分工」提了反馈（#36）。
**界面上「IC 做了」和「IC 说它做了」长得一模一样。**

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_claim_audit.py

⚠️ `_same_path` 用的是 `os.path.normcase` / `normpath`，**它随平台变**：
Windows 上小写化并把 `/` 换成 `\\`，POSIX 上是恒等。这份金样在 Windows 上导出，
所以录的是 Windows 语义。TS 侧必须**显式**实现 Windows 语义而不是跟着运行平台走
——路径本身是仪器机的 Windows 路径，代码在哪跑不改变这一点。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root

os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = require_mast_root()
OUT = Path(__file__).resolve().parents[2] / "spec" / "golden" / "claim_audit.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.logging.v2 import claim_audit as ca  # noqa: E402

#: 真实那条消息，逐字。
FORENSIC = (
    "[HANDOFF → data_processing] 5-point STS grid acquired (40 nm spacing, "
    "bias -0.8 V, setpoint 100 pA). Per-point summary JSON: "
    r"D:\data\claim-audit\GridSTS_report.txt"
)

#: (用例名, 文本, executed_skills, artifacts)
#: `executed_skills=None` 与 `[]` **不是一回事**：None ＝ 没有记录可比，
#: 那条「零技能」规则整个不适用；[] ＝ 记录说什么都没跑。
CASES: list[tuple[str, str, object, list[str]]] = [
    ("forensic_2026_07_27", FORENSIC, [], []),
    ("forensic_but_skill_ran", FORENSIC, ["GridSTS"], []),
    ("forensic_and_file_real", FORENSIC, ["GridSTS"],
     [r"D:\data\claim-audit\GridSTS_report.txt"]),
    ("no_record_at_all", FORENSIC, None, []),
    # 路径抽取的形状
    ("windows_path", r"结果见 D:\data\scan_001.sxm", [], []),
    ("unc_path", r"结果见 \\rig-pc\share\scan_001.sxm", [], []),
    ("posix_path", "结果见 /home/rig/data/scan_001.sxm", [], []),
    ("bare_filename_not_matched", "结果见 scan_001.sxm", [], []),
    ("no_extension_not_matched", r"结果见 D:\data\scan_001", [], []),
    # 尾随标点：中英文都要剥
    ("trailing_punct_cn", r"结果见 D:\data\scan_001.sxm。", [], []),
    ("trailing_punct_paren", r"结果见（D:\data\scan_001.sxm）", [], []),
    # 去重：大小写 + 斜杠方向都算同一个
    ("dedup_case_and_slash",
     r"见 D:\Data\A.sxm 和 d:/data/a.sxm 和 D:\Data\B.sxm", [], []),
    # artifacts 匹配也要过 normpath：写法不同、同一个文件
    ("artifact_matches_via_normpath", r"见 D:\data\.\sub\..\sub\a.sxm", ["X"],
     [r"D:\data\sub\a.sxm"]),
    # 「完成」判定：要**同时**有完成词和仪器工作词
    ("done_word_only", "已完成，总结写好了", [], []),
    ("work_word_only", "接下来打算做 STS 谱", [], []),
    ("both_words_en", "STS spectra acquired", [], []),
    ("both_words_cn", "扫描完成", [], []),
    ("both_words_but_skills_ran", "扫描完成", ["StartScan"], []),
    ("empty_text", "", [], []),
]


def main() -> int:
    out = {}
    for name, text, skills, arts in CASES:
        v = ca.audit_claim(
            text,
            executed_skills=skills,  # type: ignore[arg-type]
            artifacts=arts,
            # 磁盘一律当成「不存在」：金样必须与这台机器上有什么文件无关
            path_exists=lambda _p: False,
        )
        out[name] = {
            "verdict": v.as_dict(),
            "notice": v.notice(),
            "claims_completed_work": ca.claims_completed_work(text),
            "extract_claimed_paths": ca.extract_claimed_paths(text),
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    bad = sum(1 for v in out.values() if not v["verdict"]["ok"])
    print(f"[ok]   claim_audit.json: {len(out)} 条用例，其中 {bad} 条判为不符")
    print(f"       平台语义：os.name={os.name}（normcase "
          f"{'小写化+反斜杠' if os.name == 'nt' else '恒等'}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
