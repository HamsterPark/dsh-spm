"""把 v2 记录库的建表语句整段录成金样。

驱动的是**旧仓真实的** `mast/logging/v2/schema.py::ALL_DDL`。

为什么整段录、而不是挑我们这一段要用的那几张表：**建表语句就是规格本身**。
把它抄进 TS 等于制造第二份，而第二份迟早和第一份漂开——记录库尤其不能这样，
一张查询用的表跟丢了一个列，症状是「审计查不到」，不是「程序崩了」。
所以我们**执行这份 SQL 原文**，不重写它。

Run after setting `MAST_ROOT` to the Python source directory containing the `mast` package.

    python tools/spec-export/export_records_schema.py

同时录一份 `sqlite_master` 的规范化快照：SQLite 自己解析完这段 SQL 之后**认为**
建出了什么。判据落在这一份上——「SQL 文本一样」和「建出来的库一样」不是一回事
（SQLite 会规范化、会忽略一些东西），而我们要的是后者。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

from _paths import require_mast_root

# ⚠️ **必须在 import mast 之前**：把项目根指到临时目录（PLAN §8.6 的「隔离」）。
os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(prefix="mast-spec-export-"))

MAST_ROOT = require_mast_root()
OUT_SQL = Path(__file__).resolve().parents[2] / "spec" / "golden" / "records_schema.sql"
OUT_JSON = Path(__file__).resolve().parents[2] / "spec" / "golden" / "records_schema.json"

sys.path.insert(0, str(MAST_ROOT))
from mast.logging.v2 import schema as v2  # noqa: E402


def main() -> int:
    ddl = "\n".join(s.strip() for s in v2.ALL_DDL) + "\n"

    # 真的建一次，让 SQLite 自己说它建出了什么。
    con = sqlite3.connect(":memory:")
    try:
        con.executescript(ddl)
        rows = con.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
        ).fetchall()
        objects = [
            {"type": t, "name": n, "tbl_name": tb, "sql": sql}
            for (t, n, tb, sql) in rows
        ]
        # 每张表的列：名字、类型、非空、缺省、主键位次。审计查询依赖的就是这些。
        columns = {}
        for o in objects:
            if o["type"] != "table":
                continue
            columns[o["name"]] = [
                {
                    "cid": c[0], "name": c[1], "type": c[2],
                    "notnull": c[3], "default": c[4], "pk": c[5],
                }
                for c in con.execute(f'PRAGMA table_info("{o["name"]}")').fetchall()
            ]
    finally:
        con.close()

    OUT_SQL.parent.mkdir(parents=True, exist_ok=True)
    OUT_SQL.write_text(ddl, encoding="utf-8", newline="\n")
    OUT_JSON.write_text(
        json.dumps(
            {"objects": objects, "columns": columns},
            ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False,
        ) + "\n",
        encoding="utf-8", newline="\n",
    )
    tables = [o["name"] for o in objects if o["type"] == "table"]
    print(f"[ok]   records_schema.sql: {len(v2.ALL_DDL)} 段 DDL")
    print(f"[ok]   records_schema.json: {len(tables)} 张表 / "
          f"{sum(1 for o in objects if o['type'] == 'index')} 个索引 / "
          f"{sum(len(c) for c in columns.values())} 个列")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
