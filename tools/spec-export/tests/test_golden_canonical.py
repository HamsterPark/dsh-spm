"""金样是序列化的不动点：`spec/golden/*.json` 逐个按字节读，解析后按导出器的规则重新序列化，必须逐字节相同。

    python -m unittest discover -s tools/spec-export/tests -v

按字节读，因为 `read_text` 在 Windows 上会翻译换行，把 CRLF 悄悄掩盖掉。不动点成立，覆盖层「解析、改叶、
再序列化」才不会动到其余字节；有人手改了金样或换了序列化参数，这里会红。缩进格式的规则取自覆盖层工具
本身（`spec_overlay.canonical_dumps`），两边不会各写一份。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

EXPORTER_DIR = Path(__file__).resolve().parents[1]
if str(EXPORTER_DIR) not in sys.path:
    sys.path.insert(0, str(EXPORTER_DIR))

from spec_overlay import canonical_dumps  # noqa: E402

GOLDEN = EXPORTER_DIR.parents[1] / "spec" / "golden"

#: 视觉线束的四份金样用紧凑序列化，各自的导出器写的是 `separators=(",", ":")`：
#: 它们装着整帧数组，缩进格式要大好几倍。其余金样都是缩进格式。
COMPACT = {
    "visual_memory.json": "export_visual_memory.py",
    "measure_profile.json": "export_measure_profile.py",
    "measure_fft_blobs.json": "export_measure_fft_blobs.py",
    "measure_diff.json": "export_measure_diff.py",
}


def compact_dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":")) + "\n"


def is_fixed_point(name: str, text: str) -> bool:
    dumps = compact_dumps if name in COMPACT else canonical_dumps
    try:
        return dumps(json.loads(text)) == text
    except ValueError:  # NaN / Infinity，或根本不是 JSON
        return False


class GoldenCanonicalTest(unittest.TestCase):
    def test_every_golden_json_is_its_own_serialization(self) -> None:
        files = sorted(GOLDEN.glob("*.json"))
        # 防空转：路径写错时 glob 为空，循环一次不跑也是绿的
        self.assertGreaterEqual(len(files), 45, str(GOLDEN))
        names = {p.name for p in files}
        self.assertEqual(sorted(set(COMPACT) - names), [], "紧凑格式的例外里有已不存在的金样")
        for exporter in COMPACT.values():
            self.assertTrue((EXPORTER_DIR / exporter).is_file(), exporter)
        bad = [p.name for p in files if not is_fixed_point(p.name, p.read_bytes().decode("utf-8"))]
        self.assertEqual(bad, [])

    def test_the_check_sees_what_a_hand_edit_changes(self) -> None:
        doc = {"b": [1, 1e-07, -0.0], "a": "µ 示例"}
        pretty = canonical_dumps(doc)
        self.assertTrue(is_fixed_point("x.json", pretty))
        self.assertTrue(is_fixed_point("visual_memory.json", compact_dumps(doc)))
        variants = {
            "CRLF": pretty.replace("\n", "\r\n"),
            "键没排序": json.dumps(doc, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            "转义了非 ASCII": json.dumps(doc, indent=2, sort_keys=True, allow_nan=False) + "\n",
            "少了末尾换行": pretty.rstrip("\n"),
            "缩进不同": json.dumps(doc, ensure_ascii=False, indent=4, sort_keys=True, allow_nan=False) + "\n",
            "NaN": pretty.replace("1e-07", "NaN"),
        }
        for why, text in variants.items():
            self.assertFalse(is_fixed_point("x.json", text), why)
        self.assertFalse(is_fixed_point("visual_memory.json", pretty), "紧凑格式的文件写成了缩进格式")


if __name__ == "__main__":
    unittest.main()
