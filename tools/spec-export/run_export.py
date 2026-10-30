"""MAST 金样导出的统一入口：快照导出、逐导出器隔离、泄漏与指纹自检。

    MAST_REPO=<参考仓> SPEC_EXPORT_STAGE=<暂存目录> <python> -B tools/spec-export/run_export.py run --rev <标签或提交号> [--repeat 2]
    <python> -B tools/spec-export/run_export.py compare <A> <B> [--mask-manifest]

`<python>` 是带 NumPy / SciPy 的参考环境；运行器本身只用标准库，导出器用同一个解释器启动。

为什么要有它。导出器都把产物写到 `Path(__file__).parents[2] / "spec" / "golden"`，在本仓里直接跑就会
改写已跟踪的金样；`MAST_ROOT` 指向参考仓的工作树时，导出的是一个不对应任何提交的状态（旧
`manifest.json` 的 `near_commit` 正是这样失真的）。运行器把两件事都挪开：

- 参考源码取自 `git archive` 的快照，逐个 blob 与提交核对；导出器只看得见快照；
- 导出器的副本在公开仓之外的暂存区里运行，产物留在暂存区，不写 `spec/golden`；
- 每个导出器单独的 `MAST2_PROJECT_ROOT` 与 `TEMP`，一律原生路径写法（见 `to_native`）。

对参考仓只读对象库（`cat-file` / `log` / `archive`），不用 `status` / `ls-files`：它们要读索引，用户此刻
可能正在参考仓里工作。工作树只做 stat 遍历，用来发现运行期间 `MASTv2/` 下冒出来的新文件。

退出码：0 通过；2 用法、环境或预检；3 参考仓 `MASTv2/` 下出现新文件，或快照被导出器写过（加
`--strict-mast` 时已有文件的变化也算）；4 快照与提交不一致；5 导出器失败、超时或缺产物；6 产物里有
暂存路径、参考仓路径或用户目录；7 `--repeat` 的各次产物不逐字节一致；8 `compare` 有差异。
"""

from __future__ import annotations

import argparse
import ast
import datetime
import getpass
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

#: 参考仓里含 `mast/` 包的子目录。快照只取它，指纹也只看它。
SUBDIR = "MASTv2"

#: 先跑：`export_tip_phase_deps.py` 读它在**同一输出目录**写下的 `skills.json`。
FIRST = "export_mast_spec.py"

#: 不走 MAST 通道的导出器（STM-Bench、VISTA-SPM 或只用公共数值库），本运行器不跑。
NON_LANE_EXPORTERS = frozenset({
    "export_interp_edges.py",
    "export_measure_diff.py",
    "export_measure_fft_blobs.py",
    "export_measure_profile.py",
    "export_numerics.py",
    "export_visual_memory.py",
    "export_wire_fixtures.py",
    "export_wire_types.py",
})

#: 上面 8 个导出器的产物。`wire_frames.json` 由 `export_wire_fixtures.py` 写出，两边名字不同。
NON_LANE_GOLDEN = frozenset({
    "interp_edges.json",
    "measure_diff.json",
    "measure_fft_blobs.json",
    "measure_profile.json",
    "numerics.json",
    "visual_memory.json",
    "wire_frames.json",
    "wire_types.json",
})

#: `compare --mask-manifest` 比较 `manifest.json` 前删掉的块：来源记录与公开文本标记。
MANIFEST_MASKED = ("spec_source", "reference", "public_text")

OK, USAGE, MAST_WRITTEN, SNAPSHOT, EXPORTER, LEAK, REPEAT, DIFFER = 0, 2, 3, 4, 5, 6, 7, 8


class RunError(Exception):
    """带退出码的失败。"""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


# ──────────────────────────────────────────────────────────────────────────
# 路径与环境
# ──────────────────────────────────────────────────────────────────────────


def to_native(p: str | os.PathLike[str], *, pathmod=os.path) -> str:
    """规范成本机原生写法（Windows 上一律反斜杠），并解开符号链接。

    导出器对 `MAST2_PROJECT_ROOT` 的**原值**做 `str.replace` 抹掉路径，而 MAST 用 pathlib 生成的是
    反斜杠路径：环境变量写成正斜杠，替换就静默失效，带用户名的绝对路径会原样进金样。
    """
    return pathmod.normpath(pathmod.realpath(os.fspath(p)))


def assert_native(label: str, value: str, *, nt: bool = os.name == "nt") -> None:
    if nt and "/" in value:
        raise ValueError(f"{label} 不是原生路径写法（含正斜杠）：{value}")


_STRIPPED = ("PYTHON", "MAST", "STMSIM", "VISTA")


def child_env(base: Mapping[str, str], **set_: str) -> dict[str, str]:
    """导出器子进程的环境：删掉名字以 PYTHON / MAST / STMSIM / VISTA 开头的变量，再写入 `set_`。

    `PYTHONPATH` 会把本机别的包塞进导入路径；shell 里残留的 `MAST_ROOT` / `MAST2_PROJECT_ROOT` 会让
    导出器的 `setdefault` 落到别处。Windows 的变量名不分大小写，所以按大写比较，`set_` 里同名的
    其他写法（如 `Temp`）也一并删掉，免得子进程里同时有两份。
    """
    shadowed = {k.upper() for k in set_}
    env = {k: v for k, v in base.items()
           if not k.upper().startswith(_STRIPPED) and k.upper() not in shadowed}
    env.update(set_)
    return env


def _inside(child: str, parent: str) -> bool:
    child, parent = os.path.normcase(child), os.path.normcase(parent)
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # Windows 上不同盘符
        return False


def _rmtree(path: Path) -> None:
    def onexc(func, p, _exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)

    if path.exists():
        shutil.rmtree(path, onexc=onexc)


# ──────────────────────────────────────────────────────────────────────────
# 导出器分类
# ──────────────────────────────────────────────────────────────────────────

_ROOT_FUNCS = frozenset({"require_mast_root", "require_stmsim_root", "require_vista_spm_root"})


def _called_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
            if name in _ROOT_FUNCS:
                found.add(name)
    return found


def classify_exporters(d: Path) -> tuple[list[str], list[str]]:
    """(MAST 通道, 其余)。MAST 通道 = 调用 `require_mast_root()`、且不调用另外两个 `require_*_root()`。"""
    mast: list[str] = []
    other: list[str] = []
    for p in sorted(d.glob("export_*.py"), key=lambda p: p.name):
        (mast if _called_roots(p) == {"require_mast_root"} else other).append(p.name)
    return mast, other


def unclassified(other: Sequence[str]) -> list[str]:
    """不在 MAST 通道、也没登记进 `NON_LANE_EXPORTERS` 的导出器：新来的，不许静默放过。"""
    return sorted(set(other) - NON_LANE_EXPORTERS)


def run_order(exporters: Sequence[str]) -> list[str]:
    return sorted(exporters, key=lambda n: (n != FIRST, n))


# ──────────────────────────────────────────────────────────────────────────
# 参考仓：只读对象库
# ──────────────────────────────────────────────────────────────────────────


def _git(repo: Path, *args: str, stdin: bytes | None = None) -> bytes:
    proc = subprocess.run(["git", "--no-optional-locks", "-C", str(repo), *args],
                          input=stdin, capture_output=True)
    if proc.returncode != 0:
        raise RunError(USAGE, f"git {' '.join(args)} 失败：{proc.stderr.decode('utf-8', 'replace').strip()}")
    return proc.stdout


def object_ids(repo: Path, specs: Sequence[str]) -> list[tuple[str, str] | None]:
    """`git cat-file --batch-check`：每个 spec → (对象号, 类型)；不存在或有歧义为 None。"""
    out = _git(repo, "cat-file", "--batch-check", stdin="".join(f"{s}\n" for s in specs).encode("utf-8"))
    rows: list[tuple[str, str] | None] = []
    for line in out.decode("utf-8").splitlines():
        parts = line.split(" ")
        found = len(parts) == 3 and parts[1] in ("commit", "tree", "blob", "tag")
        rows.append((parts[0], parts[1]) if found else None)
    return rows


_HEX = re.compile(r"[0-9a-f]{7,64}")
_TAG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*(?:/[A-Za-z0-9._+-]+)*")


def resolve_commit(repo: Path, rev: str) -> str:
    """`--rev` → 完整提交号。只接受 ≥7 位十六进制或已存在的标签：分支名与 HEAD 会移动，不可复现。"""
    if _HEX.fullmatch(rev):
        spec = rev
    elif _TAG.fullmatch(rev) and ".." not in rev:
        spec = f"refs/tags/{rev}"
    else:
        raise RunError(USAGE, f"--rev 只接受标签或至少 7 位的小写十六进制提交号：{rev!r}")
    hit = object_ids(repo, [spec + "^{commit}"])[0]
    # 十六进制也可能被同名的引用抢先解析：结果必须真的以它开头
    if hit is None or (spec == rev and not hit[0].startswith(rev)):
        raise RunError(USAGE, f"--rev {rev!r} 不是已存在的标签或提交号（分支名与 HEAD 一律拒绝）")
    return hit[0]


def describe(repo: Path, sha: str) -> str | None:
    """等价于 `git describe --tags <sha>`（打了标签的提交就是标签名本身），经 `git log` 取。"""
    out = _git(repo, "log", "-1", "--no-show-signature", "--format=%(describe:tags=true)", sha)
    return out.decode("utf-8").strip() or None


def subtree_id(repo: Path, sha: str, subdir: str = SUBDIR) -> str:
    hit = object_ids(repo, [f"{sha}:{subdir}"])[0]
    if hit is None or hit[1] != "tree":
        raise RunError(USAGE, f"提交 {sha[:12]} 里没有目录 {subdir}/")
    return hit[0]


class _CatFile:
    """一个 `git cat-file --batch` 进程：树对象要逐层读。"""

    def __init__(self, repo: Path) -> None:
        self.proc = subprocess.Popen(
            ["git", "--no-optional-locks", "-C", str(repo), "cat-file", "--batch"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def read(self, oid: str) -> tuple[str, bytes]:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(oid.encode("ascii") + b"\n")
        self.proc.stdin.flush()
        header = self.proc.stdout.readline().decode("ascii", "replace").split()
        if len(header) != 3:
            raise RunError(SNAPSHOT, f"参考仓里读不到对象 {oid}")
        data = self.proc.stdout.read(int(header[2]))
        self.proc.stdout.read(1)  # 每个对象之后的换行
        return header[1], data

    def __enter__(self) -> _CatFile:
        return self

    def __exit__(self, *_exc: object) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        self.proc.wait()
        if self.proc.stdout is not None:
            self.proc.stdout.close()


def tree_entries(repo: Path, tree: str, prefix: str) -> dict[str, tuple[str, str]]:
    """递归列出树：相对路径（POSIX，带 prefix）→ (mode, 对象号)。子模块不进 `git archive`，跳过。"""
    raw_len = len(tree) // 2
    out: dict[str, tuple[str, str]] = {}
    with _CatFile(repo) as cat:
        stack = [(tree, prefix)]
        while stack:
            oid, base = stack.pop()
            kind, data = cat.read(oid)
            if kind != "tree":
                raise RunError(SNAPSHOT, f"{base} 不是树对象")
            i = 0
            while i < len(data):
                sp = data.index(b" ", i)
                nul = data.index(b"\0", sp)
                mode = data[i:sp].decode("ascii")
                name = data[sp + 1:nul].decode("utf-8", "surrogateescape")
                child = data[nul + 1:nul + 1 + raw_len].hex()
                i = nul + 1 + raw_len
                path = f"{base}/{name}"
                if mode == "40000":
                    stack.append((child, path))
                elif mode != "160000":
                    out[path] = (mode, child)
    return out


def blob_id(data: bytes, hexlen: int = 40) -> str:
    h = hashlib.sha1() if hexlen == 40 else hashlib.sha256()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def archive_snapshot(mast_repo: Path, sha: str, dest: Path, subdir: str = SUBDIR) -> None:
    """`git archive` 取 `<sha>` 里的 `subdir/`，流式解到 `dest`（先清空）。

    `-c core.autocrlf=false`：系统级 autocrlf=true 时，默认的 archive 会把 LF 文件转成 CRLF，快照就
    不再是那个提交了。快照与提交是否一致由 `verify_snapshot` 判，这里不做任何「修正」。
    """
    _rmtree(dest)
    dest.mkdir(parents=True)
    cmd = ["git", "--no-optional-locks", "-C", str(mast_repo), "-c", "core.autocrlf=false",
           "archive", "--format=tar", sha, subdir]
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err)
        assert proc.stdout is not None
        try:
            with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
                tar.extractall(dest, filter="data")
            # tarfile 读到结束标记就停，git 却还要写完记录块的填充。不读完就关管道，git 会撞上
            # 断开的管道，一句话不留地以非零退出——只在某些快照大小上出现
            while proc.stdout.read(1 << 16):
                pass
        except (tarfile.TarError, OSError) as e:
            raise RunError(SNAPSHOT, f"解开快照失败：{e}") from e
        finally:
            proc.stdout.close()
            rc = proc.wait()
        if rc != 0:
            err.seek(0)
            raise RunError(SNAPSHOT, f"git archive 失败：{err.read().decode('utf-8', 'replace').strip()}")


def _walk(root: Path):
    """(相对 POSIX 路径, 完整路径, 是否目录) —— 不跟随符号链接与目录联接。"""
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        keep = []
        for d in dirnames:
            full = here / d
            if os.path.islink(full) or os.path.isjunction(full):
                yield full.relative_to(root).as_posix(), full, False
            else:
                keep.append(d)
                yield full.relative_to(root).as_posix(), full, True
        dirnames[:] = keep
        for f in filenames:
            full = here / f
            yield full.relative_to(root).as_posix(), full, False


def verify_snapshot(mast_repo: Path, sha: str, root: Path, subdir: str = SUBDIR) -> list[str]:
    """快照 `root/<subdir>/` 与提交逐个 blob 核对，返回问题清单（空 = 一致）。

    按 git 的算法重算 blob 号：`sha1(b"blob <长度>\\0" + 字节)`。行尾被转换、文件被改、多出或少了
    文件，都会在这里现形。
    """
    expected = tree_entries(mast_repo, subtree_id(mast_repo, sha, subdir), subdir)
    problems: list[str] = []
    seen: set[str] = set()
    for rel, full, is_dir in _walk(root):
        if is_dir:
            continue
        seen.add(rel)
        if rel not in expected:
            problems.append(f"extra: {rel}")
            continue
        mode, oid = expected[rel]
        if mode == "120000":
            data = os.readlink(full).encode("utf-8") if os.path.islink(full) else None
        else:
            data = None if os.path.islink(full) else full.read_bytes()
        if data is None or blob_id(data, len(oid)) != oid:
            problems.append(f"blob-mismatch: {rel}")
    problems += [f"missing: {rel}" for rel in sorted(expected.keys() - seen)]
    return problems


def mast_fingerprint(mast_repo: Path, subdir: str = SUBDIR) -> dict[str, tuple[int, int] | None]:
    """参考仓 `subdir/` 下每个条目：文件 → (mtime_ns, 大小)，目录 → None（只看它在不在）。

    直接 stat 遍历，不经 git：被忽略的文件（`__pycache__`、数据目录）也在内，而导出器真要往参考仓
    里写，几乎一定是新建文件。
    """
    out: dict[str, tuple[int, int] | None] = {}
    for rel, full, is_dir in _walk(mast_repo / subdir):
        if is_dir:
            out[rel + "/"] = None
            continue
        try:
            st = os.lstat(full)
        except FileNotFoundError:  # 遍历途中被删
            continue
        out[rel] = (st.st_mtime_ns, st.st_size)
    return out


def fingerprint_delta(before: Mapping[str, object], after: Mapping[str, object]) -> dict[str, list[str]]:
    return {
        "new": sorted(after.keys() - before.keys()),
        "changed": sorted(k for k in before.keys() & after.keys() if before[k] != after[k]),
        "gone": sorted(before.keys() - after.keys()),
    }


def fingerprint_failed(delta: Mapping[str, Sequence[str]], *, strict: bool) -> bool:
    """新文件一律算失败；已有文件的变化（多半是用户在保存）默认只告警，`--strict-mast` 下也算失败。"""
    return bool(delta["new"]) or (strict and bool(delta["changed"] or delta["gone"]))


# ──────────────────────────────────────────────────────────────────────────
# 产物检查
# ──────────────────────────────────────────────────────────────────────────


def leak_needles(paths: Mapping[str, str]) -> dict[str, set[str]]:
    """每个标签一组针：原值、正斜杠、反斜杠三种写法，各自再加 JSON 转义（反斜杠翻倍、非 ASCII 转义）。"""
    out: dict[str, set[str]] = {}
    for label, raw in paths.items():
        if not raw:
            continue
        forms = {raw, raw.replace("\\", "/"), raw.replace("/", "\\")}
        for f in list(forms):
            forms.add(json.dumps(f, ensure_ascii=False)[1:-1])
            forms.add(json.dumps(f, ensure_ascii=True)[1:-1])
        out[label] = {f.casefold() for f in forms if f}
    return out


def find_leaks(text: str, needles: Mapping[str, set[str]]) -> list[str]:
    """命中的针的标签（大小写不敏感）。"""
    low = text.casefold()
    return sorted(label for label, forms in needles.items() if any(f in low for f in forms))


def _reject_constant(name: str) -> object:
    raise ValueError(f"含 {name}")


def json_problems(data: bytes) -> list[str]:
    """金样的格式纪律：UTF-8、LF、以换行结尾、没有 NaN / Infinity。"""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return ["不是 UTF-8"]
    problems = []
    if "\r" in text:
        problems.append("含 CR")
    if not text.endswith("\n"):
        problems.append("不以换行结尾")
    try:
        json.loads(text, parse_constant=_reject_constant)
    except ValueError as e:
        problems.append(f"不是合法 JSON（{e}）")
    return problems


def compare_dirs(a: Path, b: Path, *, mask_manifest: bool) -> dict[str, str]:
    """A 里每个 `.json` / `.sql` 与 B 的同名文件逐字节比较：文件名 → identical / differ / missing。"""
    out: dict[str, str] = {}
    for p in sorted(a.iterdir(), key=lambda p: p.name):
        if not p.is_file() or p.suffix not in (".json", ".sql"):
            continue
        q = b / p.name
        if not q.is_file():
            out[p.name] = "missing"
        elif mask_manifest and p.name == "manifest.json":
            out[p.name] = "identical" if _masked_manifest(p) == _masked_manifest(q) else "differ"
        else:
            out[p.name] = "identical" if p.read_bytes() == q.read_bytes() else "differ"
    return out


def _masked_manifest(p: Path) -> str:
    doc = json.loads(p.read_bytes().decode("utf-8"))
    for key in MANIFEST_MASKED:
        doc.pop(key, None)
    return json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False)


# ──────────────────────────────────────────────────────────────────────────
# 运行
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class RunConfig:
    """一次 `run` 的全部输入。`run_exporters` 只读它，单测可以直接构造（不经参考仓、不经 git）。"""

    stage: str                                  # 暂存根；进来后仍会 to_native
    label: str                                  # 运行目录名 runs/<label>-<k>/
    exporter_dir: Path                          # 导出器副本的来源
    exporters: Sequence[str]                    # 按运行顺序
    mast_root: str                              # 传给导出器的 MAST_ROOT（快照里的 MASTv2/）
    expected: frozenset[str] | None = None      # 完整运行必须产出的文件名；None = 部分运行，不查
    nanonis_dir: Path | None = None             # 复制进 repo/spec/nanonis/
    extra_env: Mapping[str, str] = field(default_factory=dict)
    needles: Mapping[str, set[str]] = field(default_factory=dict)
    repeat: int = 1
    timeout: float = 600.0
    python: str = sys.executable
    base_env: Mapping[str, str] | None = None   # None = os.environ
    log: Callable[[str], None] = print


@dataclass
class RunOutcome:
    run_dirs: list[Path]
    results: list[list[dict]]          # 每次运行：每个导出器的 rc 与耗时
    outputs: list[dict[str, str]]      # 每次运行：产物文件名 → sha256
    problems: list[tuple[int, str]]
    identical: tuple[int, int] | None  # (逐字节相同数, 比较总数)；repeat == 1 时为 None


def _prepare(run_dir: Path, cfg: RunConfig) -> Path:
    """全新的运行目录：导出器副本 + spec/nanonis + 空的 spec/golden。返回 repo 根。"""
    _rmtree(run_dir)
    repo = run_dir / "repo"
    tools = repo / "tools" / "spec-export"
    tools.mkdir(parents=True)
    for src in sorted(cfg.exporter_dir.glob("export_*.py")) + [cfg.exporter_dir / "_paths.py"]:
        if src.is_file():
            shutil.copyfile(src, tools / src.name)
    if cfg.nanonis_dir is not None:
        shutil.copytree(cfg.nanonis_dir, repo / "spec" / "nanonis")
    (repo / "spec" / "golden").mkdir(parents=True)
    (run_dir / "logs").mkdir()
    return repo


def _run_one(cfg: RunConfig, stage: Path, k: int) -> tuple[Path, list[dict]]:
    run_dir = stage / "runs" / f"{cfg.label}-{k}"
    repo = _prepare(run_dir, cfg)
    base_env = os.environ if cfg.base_env is None else cfg.base_env
    results = []
    for i, name in enumerate(cfg.exporters, 1):
        stem = Path(name).stem
        short = stem.removeprefix("export_")
        pr, tmp = run_dir / "pr" / short, run_dir / "tmp" / short
        pr.mkdir(parents=True)
        tmp.mkdir(parents=True)
        paths = {"MAST_ROOT": to_native(cfg.mast_root), "MAST2_PROJECT_ROOT": to_native(pr),
                 "TEMP": to_native(tmp), "TMP": to_native(tmp), "TMPDIR": to_native(tmp)}
        try:
            for var, value in paths.items():
                assert_native(var, value)
        except ValueError as e:
            raise RunError(USAGE, str(e)) from e
        env = child_env(base_env, **paths, **cfg.extra_env,
                        PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
        argv = [cfg.python, "-B", to_native(repo / "tools" / "spec-export" / name)]
        t0 = time.monotonic()
        with open(run_dir / "logs" / f"{stem}.out", "wb") as out, \
                open(run_dir / "logs" / f"{stem}.err", "wb") as err:
            try:
                rc: int | None = subprocess.run(argv, cwd=repo, env=env, stdout=out, stderr=err,
                                                timeout=cfg.timeout).returncode
            except subprocess.TimeoutExpired:
                rc = None
        seconds = round(time.monotonic() - t0, 1)
        results.append({"exporter": name, "rc": rc, "seconds": seconds})
        status = "超时" if rc is None else f"rc={rc}"
        cfg.log(f"[{k}] {i:>2}/{len(cfg.exporters)} {name} {status} {seconds}s")
    return run_dir, results


def _check_run(golden: Path, results: list[dict], cfg: RunConfig) -> tuple[dict[str, str], list[tuple[int, str]]]:
    problems: list[tuple[int, str]] = []
    for r in results:
        if r["rc"] is None:
            problems.append((EXPORTER, f"{r['exporter']} 超时（{cfg.timeout:g} s）"))
        elif r["rc"] != 0:
            problems.append((EXPORTER, f"{r['exporter']} 退出码 {r['rc']}"))
    produced = {p.name: p for p in sorted(golden.iterdir(), key=lambda p: p.name) if p.is_file()}
    if cfg.expected is not None:
        problems += [(EXPORTER, f"没有产出 {name}") for name in sorted(cfg.expected - set(produced))]
    hashes = {}
    for name, p in produced.items():
        data = p.read_bytes()
        hashes[name] = hashlib.sha256(data).hexdigest()
        if name.endswith(".json"):
            problems += [(EXPORTER, f"{name}: {msg}") for msg in json_problems(data)]
        problems += [(LEAK, f"{name}: {label}")
                     for label in find_leaks(data.decode("utf-8", "replace"), cfg.needles)]
    return hashes, problems


def run_exporters(cfg: RunConfig) -> RunOutcome:
    """把 `cfg.exporters` 逐个隔离地跑 `cfg.repeat` 遍，检查产物；问题记进 `problems`，不抛。"""
    stage = Path(to_native(cfg.stage))
    outcome = RunOutcome([], [], [], [], None)
    for k in range(1, cfg.repeat + 1):
        run_dir, results = _run_one(cfg, stage, k)
        hashes, problems = _check_run(run_dir / "repo" / "spec" / "golden", results, cfg)
        outcome.run_dirs.append(run_dir)
        outcome.results.append(results)
        outcome.outputs.append(hashes)
        outcome.problems += [(code, f"[{k}] {msg}") for code, msg in problems]
        if problems:  # 这一遍已经不对，再跑一遍只是多花时间
            return outcome
    if cfg.repeat > 1:
        first = outcome.outputs[0]
        same = 0
        for k, hashes in enumerate(outcome.outputs[1:], 2):
            for name in sorted(first.keys() | hashes.keys()):
                if first.get(name) == hashes.get(name):
                    same += 1
                else:
                    outcome.problems.append((REPEAT, f"[1↔{k}] {name} 不一致"))
        total = sum(len(first.keys() | h.keys()) for h in outcome.outputs[1:])
        outcome.identical = (same, total)
    return outcome


def _expected_outputs() -> frozenset[str]:
    golden = REPO / "spec" / "golden"
    names = {p.name for p in golden.iterdir() if p.is_file() and p.suffix in (".json", ".sql")}
    return frozenset(names - NON_LANE_GOLDEN)


def _preflight_stage(stage: str, mast_repo: str) -> None:
    for repo in (str(REPO), mast_repo):
        if _inside(stage, repo) or _inside(repo, stage):
            raise RunError(USAGE, f"暂存目录不得与仓库互相包含：{stage} / {repo}")
    try:
        user = getpass.getuser()
    except Exception:  # noqa: BLE001 —— 取不到用户名只是少一条告警
        user = ""
    if user and user.casefold() in stage.casefold():
        print("[warn] 暂存路径含当前用户名：万一泄漏的路径也会带上它，建议换成短路径", file=sys.stderr)


def _numeric_stack(python: str) -> tuple[str, str]:
    proc = subprocess.run(
        [python, "-B", "-c", "import numpy, scipy; print(numpy.__version__, scipy.__version__)"],
        env=child_env(os.environ, PYTHONDONTWRITEBYTECODE="1"), capture_output=True, text=True)
    versions = proc.stdout.strip().splitlines()[-1].split() if proc.stdout.strip() else []
    if proc.returncode != 0 or len(versions) != 2:
        raise RunError(USAGE, f"{python} 里 import numpy / scipy 失败：导出器需要它们")
    return versions[0], versions[1]


def _required_env(name: str) -> str:
    raw = os.environ.get(name, "").strip()
    if not raw:
        raise RunError(USAGE, f"需要环境变量 {name}")
    return raw


def _print_delta(delta: Mapping[str, Sequence[str]], *, strict: bool) -> None:
    for kind, title in (("new", "新增"), ("changed", "已有条目变化"), ("gone", "消失")):
        paths = delta[kind]
        if not paths:
            continue
        tag = "FAIL" if kind == "new" or strict else "warn"
        print(f"[{tag}] {SUBDIR}/ 下{title} {len(paths)} 处（前 20 个）：")
        for p in paths[:20]:
            print(f"         {SUBDIR}/{p}")


def cmd_run(args: argparse.Namespace) -> int:
    started = datetime.datetime.now(datetime.timezone.utc)
    t0 = time.monotonic()
    if sys.version_info < (3, 12):
        raise RunError(USAGE, "需要 Python 3.12 或更新（tarfile 的 filter 参数）")
    if args.repeat < 1:
        raise RunError(USAGE, "--repeat 至少为 1")
    numpy, scipy = _numeric_stack(sys.executable)
    mast_repo_s = to_native(_required_env("MAST_REPO"))
    stage_s = to_native(_required_env("SPEC_EXPORT_STAGE"))
    mast_repo = Path(mast_repo_s)
    if not (mast_repo / ".git").exists():
        raise RunError(USAGE, f"MAST_REPO 不是 git 仓：{mast_repo_s}")
    _preflight_stage(stage_s, mast_repo_s)

    mast_lane, other = classify_exporters(HERE)
    stray = unclassified(other)
    if stray:
        raise RunError(USAGE, f"未归类的导出器（既不在 MAST 通道，也不在 NON_LANE_EXPORTERS）：{', '.join(stray)}")
    if FIRST not in mast_lane:
        raise RunError(USAGE, f"{FIRST} 不在 MAST 通道里")
    exporters = run_order(mast_lane)
    if args.only:
        only = [n.strip() for n in args.only.split(",") if n.strip()]
        bad = sorted(set(only) - set(mast_lane))
        if bad:
            raise RunError(USAGE, f"--only 里有不属于 MAST 通道的导出器：{', '.join(bad)}")
        exporters = [n for n in exporters if n in only]
        print("[warn] --only 只用于调试：部分运行的产物混入多个参考状态，不得提升进仓", file=sys.stderr)

    sha = resolve_commit(mast_repo, args.rev)
    tree = subtree_id(mast_repo, sha)
    desc = describe(mast_repo, sha)
    print(f"[ref]  {sha}（{desc or '无标签'}），{SUBDIR}/ 树 {tree}")
    print(f"[env]  Python {'.'.join(map(str, sys.version_info[:3]))}，NumPy {numpy}，SciPy {scipy}")

    fp0 = mast_fingerprint(mast_repo)
    snapshot = Path(stage_s) / "mast" / sha
    archive_snapshot(mast_repo, sha, snapshot)
    issues = verify_snapshot(mast_repo, sha, snapshot)
    if issues:
        for line in issues[:20]:
            print(f"[FAIL] {line}")
        raise RunError(SNAPSHOT, f"快照与提交不一致：{len(issues)} 处（先查 core.autocrlf 与 .gitattributes）")
    n_blobs = sum(1 for *_x, is_dir in _walk(snapshot) if not is_dir)
    print(f"[snap] {n_blobs} 个文件与提交逐个 blob 一致")

    home = to_native(Path.home())
    cfg = RunConfig(
        stage=stage_s, label=sha[:8], exporter_dir=HERE, exporters=exporters,
        mast_root=to_native(snapshot / SUBDIR),
        expected=None if args.only else _expected_outputs(),
        nanonis_dir=REPO / "spec" / "nanonis",
        extra_env={"MAST_COMMIT": sha, "MAST_TREE": tree, "MAST_DESCRIBE": desc or ""},
        needles=leak_needles({"暂存根": stage_s, "MAST_REPO": mast_repo_s,
                              "快照根": to_native(snapshot), "用户主目录": home}),
        repeat=args.repeat, timeout=args.timeout)
    outcome = run_exporters(cfg)
    problems = list(outcome.problems)

    after = verify_snapshot(mast_repo, sha, snapshot)
    problems += [(MAST_WRITTEN, f"快照被写：{line}") for line in after]
    fp1 = mast_fingerprint(mast_repo)
    delta = fingerprint_delta(fp0, fp1)
    if fingerprint_failed(delta, strict=args.strict_mast):
        problems.append((MAST_WRITTEN, f"参考仓 {SUBDIR}/ 在运行期间有变化"))
    _print_delta(delta, strict=args.strict_mast)
    if not delta["new"]:
        print(f"[ok]   {SUBDIR}/ 下无新增文件（运行前后各 {len(fp0)} / {len(fp1)} 个条目）")
    if not any(delta.values()):
        print("[ok]   MAST 指纹前后一致")

    code = min((c for c, _ in problems), default=OK)
    report = {
        "rev": args.rev, "commit": sha, "describe": desc, "tree": tree,
        "complete": not args.only, "exporters_run": exporters, "repeat": args.repeat,
        "python": ".".join(map(str, sys.version_info[:3])), "numpy": numpy, "scipy": scipy,
        "started_utc": started.isoformat(timespec="seconds"), "seconds": round(time.monotonic() - t0, 1),
        "snapshot_files": n_blobs, "snapshot_rewritten": after,
        "mast_fingerprint": {"before": len(fp0), "after": len(fp1),
                             **{k: v[:200] for k, v in delta.items()}, "strict": args.strict_mast},
        "identical": list(outcome.identical) if outcome.identical else None,
        "problems": [[c, m] for c, m in problems], "exit": code,
    }
    for k, run_dir in enumerate(outcome.run_dirs, 1):
        doc = {**report, "run": k, "results": outcome.results[k - 1], "outputs": outcome.outputs[k - 1]}
        (run_dir / "report.json").write_bytes(
            (json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"))

    for c, msg in problems:
        print(f"[FAIL] ({c}) {msg}")
    files = len(outcome.outputs[0]) if outcome.outputs else 0
    if outcome.identical:
        same, total = outcome.identical
        ident = f"{same}/{total}" if args.repeat == 2 else f"{same}/{total}（{args.repeat - 1} 组比较）"
    else:
        ident = "n/a"
    verdict = "OK" if code == OK else f"FAIL exit={code}"
    print(f"{verdict} exporters={len(exporters)} files={files} repeat={args.repeat} identical={ident}")
    return code


def cmd_compare(args: argparse.Namespace) -> int:
    a, b = Path(args.a), Path(args.b)
    for p in (a, b):
        if not p.is_dir():
            raise RunError(USAGE, f"不是目录：{p}")
    result = compare_dirs(a, b, mask_manifest=args.mask_manifest)
    for name, status in result.items():
        print(f"{status:<9} {name}")
    counts = {s: sum(1 for v in result.values() if v == s) for s in ("identical", "differ", "missing")}
    print(f"identical={counts['identical']} differ={counts['differ']} missing={counts['missing']}")
    return DIFFER if counts["differ"] or counts["missing"] else OK


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:  # 进度逐行可见，输出重定向到文件时也一样
            reconfigure(encoding="utf-8", line_buffering=True)
    ap = argparse.ArgumentParser(description="MAST 金样导出运行器（快照导出、隔离、自检）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="在 git archive 快照上跑全部 MAST 通道导出器")
    run.add_argument("--rev", required=True, help="参考仓的标签或提交号（至少 7 位十六进制）")
    run.add_argument("--repeat", type=int, default=1, help="同条件跑几遍并逐字节比较（默认 1）")
    run.add_argument("--only", help="逗号分隔的导出器文件名，只跑这些（调试用，产物不得提升进仓）")
    run.add_argument("--timeout", type=float, default=600.0, help="单个导出器的时限，秒（默认 600）")
    run.add_argument("--strict-mast", action="store_true", help="参考仓已有文件的变化也算失败")
    cmp_ = sub.add_parser("compare", help="A 里每个 .json/.sql 与 B 的同名文件逐字节比较")
    cmp_.add_argument("a")
    cmp_.add_argument("b")
    cmp_.add_argument("--mask-manifest", action="store_true",
                      help="manifest.json 先删掉 " + " / ".join(MANIFEST_MASKED) + " 再比较")
    args = ap.parse_args(argv)
    try:
        return cmd_run(args) if args.cmd == "run" else cmd_compare(args)
    except RunError as e:
        print(f"FAIL exit={e.code} {e}", file=sys.stderr)
        return e.code


if __name__ == "__main__":
    raise SystemExit(main())
