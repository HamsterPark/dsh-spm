"""公开文本覆盖层：把运行器产出的原始金样，按仓外的私有覆盖层换成已审读过的公开文本。

    <python> -B tools/spec-export/spec_overlay.py apply  --in <原始产物> --out <新目录> [--overlay FILE]
    <python> -B tools/spec-export/spec_overlay.py verify --dir <金样目录> [--overlay FILE]
    <python> -B tools/spec-export/spec_overlay.py build  --raw <原始产物> --public <公开金样> --out FILE
                                                         [--base FILE] [--tokens-out FILE] [--force]
    <python> -B tools/spec-export/spec_overlay.py show   --dir <目录> --file <文件名> --pointer <JSON 指针>

`--overlay` 缺省取环境变量 `SPEC_OVERLAY`。覆盖层数据只放仓外：短标识符的 SHA-256 能被字典直接猜中，
固定句式里只缺一个槽位的长句也能枚举，数据入仓就等于公开原文。

覆盖层文件（UTF-8、LF、与金样同一种规范 JSON）：

    {"format": 1,
     "entries": [{"sha256": "<原文 UTF-8 字节的 sha256>", "len": <原文的字符数>, "public": "<公开文本>",
                  "at": [{"file": "scan_prep.json", "pointer": "/plan_for/3/provenance"}]}]}

每个位置是（文件，RFC 6901 指针），加上条目的 sha256，就是（文件、JSON 路径、原文哈希）→ 公开文本；
同一对（原文，公开文本）出现在多处时共用一条。`at` 按（file, pointer）排序，条目按首个位置排序，
位置在全文件内不重复。

原文哈希对不上就失败、交人工复核，不猜；原文出现在没登记的位置也失败。除 `show` 外，输出只含
`文件#指针`、哈希前 8 位与字符数，不含原文或公开文本。退出码：0 通过；1 拒绝（不写任何输出）；2 用法。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections import defaultdict
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

FORMAT = 1
MANIFEST = "manifest.json"
#: build 比较 manifest 时只看这两块：来源记录与公开文本标记本来就不同
MANIFEST_COMPARED = ("collectors", "mast_root")
#: 拉丁词元与两字以上的汉字串
TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_₀-₉()\-]{2,}|[一-鿿]{2,}")


class OverlayError(Exception):
    def __init__(self, code: str, where: str) -> None:
        super().__init__(f"{code} {where}")
        self.code = code
        self.where = where


# ──────────────────────────────────────────────────────────────────────────
# 规范 JSON 与指针
# ──────────────────────────────────────────────────────────────────────────


def canonical_dumps(obj: object) -> str:
    """金样的序列化规则。MAST 通道的 JSON 金样都满足 `canonical_dumps(json.loads(t)) == t`。"""
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"


def load_canonical(path: Path) -> tuple[str, object]:
    """按字节读（`read_text` 在 Windows 上会翻译换行，把 CRLF 悄悄掩盖掉），并要求字节往返。

    往返不成立说明文件不是导出器的原样产物——有人手改过或换了序列化参数。只有往返成立，
    「解析、改叶、再序列化」才不会动到其余字节。永远不要放宽这一条。
    """
    try:
        text = path.read_bytes().decode("utf-8")
        obj = json.loads(text)
    except (UnicodeDecodeError, ValueError) as e:
        raise OverlayError("BAD_JSON", path.name) from e
    try:
        same = canonical_dumps(obj) == text
    except ValueError:  # NaN / Infinity
        same = False
    if not same:
        raise OverlayError("NOT_CANONICAL", path.name)
    return text, obj


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", "surrogatepass")).hexdigest()


def ptr_escape(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def _ptr_tokens(pointer: str) -> list[str]:
    if not pointer.startswith("/"):
        raise KeyError(pointer)
    return [t.replace("~1", "/").replace("~0", "~") for t in pointer[1:].split("/")]


def _step(node: object, token: str) -> tuple[object, str | int]:
    if isinstance(node, dict):
        if token not in node:
            raise KeyError(token)
        return node[token], token
    if isinstance(node, list):
        if not re.fullmatch(r"0|[1-9][0-9]*", token) or int(token) >= len(node):
            raise KeyError(token)
        return node[int(token)], int(token)
    raise KeyError(token)


def ptr_get(doc: object, pointer: str) -> object:
    node = doc
    for token in _ptr_tokens(pointer):
        node, _ = _step(node, token)
    return node


def ptr_set(doc: object, pointer: str, value: object) -> None:
    tokens = _ptr_tokens(pointer)
    node = doc
    for token in tokens[:-1]:
        node, _ = _step(node, token)
    _, key = _step(node, tokens[-1])
    node[key] = value  # type: ignore[index]


def string_leaves(obj: object, prefix: str = "") -> Iterator[tuple[str, str]]:
    """(指针, 字符串) —— 只看值，不看对象键。"""
    if isinstance(obj, str):
        yield prefix, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from string_leaves(v, f"{prefix}/{ptr_escape(k)}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from string_leaves(v, f"{prefix}/{i}")


# ──────────────────────────────────────────────────────────────────────────
# 覆盖层
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Entry:
    sha256: str
    len: int
    public: str
    at: tuple[tuple[str, str], ...]

    def to_json(self) -> dict:
        return {"sha256": self.sha256, "len": self.len, "public": self.public,
                "at": [{"file": f, "pointer": p} for f, p in self.at]}


@dataclass(frozen=True)
class Overlay:
    entries: tuple[Entry, ...]
    digest: str  # 覆盖层文件字节的 sha256

    @property
    def leaves(self) -> int:
        return sum(len(e.at) for e in self.entries)


def overlay_text(entries: Sequence[Entry]) -> str:
    return canonical_dumps({"format": FORMAT, "entries": [e.to_json() for e in entries]})


def _bad(where: str) -> OverlayError:
    return OverlayError("BAD_OVERLAY", where)


def parse_overlay(doc: object) -> list[Entry]:
    """校验结构与次序。报错只指出第几条、哪个字段，不带内容。"""
    if not isinstance(doc, dict) or set(doc) != {"format", "entries"} or doc["format"] != FORMAT:
        raise _bad("format")
    if not isinstance(doc["entries"], list):
        raise _bad("entries")
    entries: list[Entry] = []
    seen: set[tuple[str, str]] = set()
    pairs: set[tuple[str, str]] = set()
    for i, raw in enumerate(doc["entries"]):
        if not isinstance(raw, dict) or set(raw) != {"sha256", "len", "public", "at"}:
            raise _bad(f"entries[{i}]")
        digest, length, public, at = raw["sha256"], raw["len"], raw["public"], raw["at"]
        if not (isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)):
            raise _bad(f"entries[{i}].sha256")
        if type(length) is not int or length < 0:
            raise _bad(f"entries[{i}].len")
        if not isinstance(public, str) or sha256_text(public) == digest:
            raise _bad(f"entries[{i}].public")
        if not isinstance(at, list) or not at:
            raise _bad(f"entries[{i}].at")
        locs = []
        for j, loc in enumerate(at):
            ok = (isinstance(loc, dict) and set(loc) == {"file", "pointer"}
                  and isinstance(loc["file"], str) and re.fullmatch(r"[A-Za-z0-9_.-]+\.json", loc["file"])
                  and isinstance(loc["pointer"], str) and loc["pointer"].startswith("/"))
            if not ok:
                raise _bad(f"entries[{i}].at[{j}]")
            locs.append((loc["file"], loc["pointer"]))
        if locs != sorted(locs):
            raise _bad(f"entries[{i}].at 未排序")
        if seen & set(locs) or len(set(locs)) != len(locs):
            raise _bad(f"entries[{i}].at 位置重复")
        seen |= set(locs)
        if (digest, public) in pairs:
            raise _bad(f"entries[{i}] 与前面的条目同为一对（原文，公开文本）")
        pairs.add((digest, public))
        entries.append(Entry(digest, length, public, tuple(locs)))
    if [e.at[0] for e in entries] != sorted(e.at[0] for e in entries):
        raise _bad("entries 未按首个位置排序")
    return entries


def load_overlay(path: Path) -> Overlay:
    if not path.is_file():
        raise OverlayError("NO_OVERLAY", str(path))
    _, doc = load_canonical(path)
    return Overlay(tuple(parse_overlay(doc)), hashlib.sha256(path.read_bytes()).hexdigest())


# ──────────────────────────────────────────────────────────────────────────
# 核对：apply / verify / build 共用
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class Problem:
    code: str
    file: str
    pointer: str = ""
    detail: str = ""

    def __str__(self) -> str:
        where = f"{self.file}#{self.pointer}" if self.pointer else self.file
        return f"{self.code} {where}" + (f" {self.detail}" if self.detail else "")


@dataclass
class Check:
    docs: dict[str, object] = field(default_factory=dict)
    replaced: list[tuple[str, str, Entry]] = field(default_factory=list)
    already: list[tuple[str, str]] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)

    def count(self, code: str) -> int:
        return sum(1 for p in self.problems if p.code == code)

    def summary(self) -> str:
        line = (f"already={len(self.already)} replaced={len(self.replaced)} "
                f"mismatch={self.count('MISMATCH')} unlisted={self.count('UNLISTED')}")
        other = len(self.problems) - self.count("MISMATCH") - self.count("UNLISTED")
        return line + (f" other={other}" if other else "")


def _short(text: str) -> str:
    return f"{sha256_text(text)[:8]}/{len(text)}"


def check_docs(docs: Mapping[str, object], overlay: Sequence[Entry]) -> Check:
    """对已解析的文档逐个位置三选一：原文 → replaced；已是公开文本 → already；都不是 → MISMATCH。

    再扫一遍全部字符串叶：哈希属于某条原文、位置却没登记 → UNLISTED。
    """
    chk = Check(docs=dict(docs))
    listed: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for e in overlay:
        listed[e.sha256].update(e.at)
        for file, pointer in e.at:
            if file not in docs:
                chk.problems.append(Problem("MISSING_FILE", file, pointer))
                continue
            try:
                leaf = ptr_get(docs[file], pointer)
            except KeyError:
                chk.problems.append(Problem("MISSING_POINTER", file, pointer))
                continue
            if not isinstance(leaf, str):
                chk.problems.append(Problem("NOT_STRING", file, pointer))
            elif sha256_text(leaf) == e.sha256:
                chk.replaced.append((file, pointer, e))
            elif leaf == e.public:
                chk.already.append((file, pointer))
            else:
                chk.problems.append(Problem("MISMATCH", file, pointer,
                                            f"期望 {e.sha256[:8]}/{e.len} 实际 {_short(leaf)}"))
    for file in sorted(docs):
        for pointer, s in string_leaves(docs[file]):
            h = sha256_text(s)
            if h in listed and (file, pointer) not in listed[h]:
                chk.problems.append(Problem("UNLISTED", file, pointer, f"{h[:8]}/{len(s)}"))
    return chk


def check_dir(d: Path, overlay: Sequence[Entry]) -> Check:
    """读目录里的 JSON：被覆盖层引用的必须规范（字节往返），其余只需能解析（为了扫未登记出现）。"""
    referenced = {f for e in overlay for f, _ in e.at}
    docs: dict[str, object] = {}
    problems: list[Problem] = []
    for p in sorted(d.iterdir(), key=lambda p: p.name):
        if p.is_dir():
            problems.append(Problem("UNEXPECTED_DIR", p.name))
        elif p.suffix == ".json":
            try:
                if p.name in referenced or p.name == MANIFEST:
                    docs[p.name] = load_canonical(p)[1]
                else:
                    docs[p.name] = json.loads(p.read_bytes().decode("utf-8"))
            except OverlayError as e:
                problems.append(Problem(e.code, e.where))
            except (UnicodeDecodeError, ValueError):
                problems.append(Problem("BAD_JSON", p.name))
    chk = check_docs(docs, overlay)
    bad_files = {p.file for p in problems}
    chk.problems = problems + [p for p in chk.problems if not (p.code == "MISSING_FILE" and p.file in bad_files)]
    return chk


def public_text_mark(overlay: Overlay) -> dict:
    """写进 manifest 的标记：没经覆盖层就提交的原始导出，manifest 里有 `reference` 却没有这块。"""
    return {"overlay": overlay.digest[:12], "entries": len(overlay.entries), "leaves": overlay.leaves}


def _print_problems(problems: Sequence[Problem], limit: int = 50) -> None:
    for p in problems[:limit]:
        print(p)
    if len(problems) > limit:
        print(f"…… 另有 {len(problems) - limit} 处")


# ──────────────────────────────────────────────────────────────────────────
# 子命令
# ──────────────────────────────────────────────────────────────────────────


def _dir(arg: str) -> Path:
    path = Path(arg)
    if not path.is_dir():
        raise OverlayError("NO_DIR", arg)
    return path


def _overlay_path(arg: str | None) -> Path:
    raw = arg or os.environ.get("SPEC_OVERLAY", "").strip()
    if not raw:
        raise OverlayError("NO_OVERLAY", "用 --overlay 或环境变量 SPEC_OVERLAY 指定覆盖层文件")
    return Path(raw)


def apply_overlay(in_dir: Path, out_dir: Path, overlay: Overlay) -> Check:
    """核对无误才写：改过的文件按规范 JSON 写出，其余文件（含 `.sql`）逐字节复制。"""
    if out_dir.exists() and (not out_dir.is_dir() or any(out_dir.iterdir())):
        raise OverlayError("OUT_NOT_EMPTY", str(out_dir))
    chk = check_dir(in_dir, overlay.entries)
    if chk.problems:
        return chk
    changed: set[str] = set()
    for file, pointer, e in chk.replaced:
        ptr_set(chk.docs[file], pointer, e.public)
        changed.add(file)
    manifest = chk.docs.get(MANIFEST)
    if isinstance(manifest, dict) and "reference" in manifest:
        manifest["public_text"] = public_text_mark(overlay)
        changed.add(MANIFEST)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=out_dir.name + ".partial-", dir=out_dir.parent))
    try:
        for p in sorted(in_dir.iterdir(), key=lambda p: p.name):
            if p.name in changed:
                (tmp / p.name).write_bytes(canonical_dumps(chk.docs[p.name]).encode("utf-8"))
            else:
                (tmp / p.name).write_bytes(p.read_bytes())
        if out_dir.exists():
            out_dir.rmdir()
        os.replace(tmp, out_dir)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return chk


def cmd_apply(args: argparse.Namespace) -> int:
    overlay = load_overlay(_overlay_path(args.overlay))
    chk = apply_overlay(_dir(args.in_dir), Path(args.out), overlay)
    _print_problems(chk.problems)
    print(chk.summary())
    if chk.problems:
        print("未写任何输出：哈希不符的位置用 show 人工复核（输出含私有原文，不要外传）")
        return 1
    return 0


def verify_dir(d: Path, overlay: Overlay) -> Check:
    """已入仓的金样必须是覆盖层的不动点：每个位置都已是公开文本，manifest 的标记对得上。"""
    chk = check_dir(d, overlay.entries)
    chk.problems += [Problem("RAW_PRESENT", f, p) for f, p, _ in chk.replaced]
    manifest = chk.docs.get(MANIFEST)
    if isinstance(manifest, dict):
        mark = manifest.get("public_text")
        if "reference" in manifest and mark != public_text_mark(overlay):
            chk.problems.append(Problem("PUBLIC_TEXT_MARK", MANIFEST, "/public_text"))
        elif "reference" not in manifest and mark is not None:
            chk.problems.append(Problem("PUBLIC_TEXT_MARK", MANIFEST, "/public_text", "没有 reference 却有标记"))
    return chk


def cmd_verify(args: argparse.Namespace) -> int:
    overlay = load_overlay(_overlay_path(args.overlay))
    chk = verify_dir(_dir(args.dir), overlay)
    _print_problems(chk.problems)
    print(chk.summary())
    return 1 if chk.problems else 0


def _scalar_same(a: object, b: object) -> bool:
    # 比类型和规范写法：True 与 1、0.0 与 -0.0 都算不同
    return type(a) is type(b) and json.dumps(a) == json.dumps(b)


def diff_docs(raw: object, public: object, file: str, pointer: str,
              leaves: list[tuple[str, str, str, str]], problems: list[Problem]) -> None:
    """同步遍历：结构与非字符串标量必须完全相同，字符串叶不同就记一个位置。"""
    if type(raw) is not type(public):
        problems.append(Problem("TYPE", file, pointer))
    elif isinstance(raw, dict):
        if raw.keys() != public.keys():  # type: ignore[union-attr]
            problems.append(Problem("KEYS", file, pointer))
            return
        for k in raw:
            diff_docs(raw[k], public[k], file, f"{pointer}/{ptr_escape(k)}", leaves, problems)  # type: ignore[index]
    elif isinstance(raw, list):
        if len(raw) != len(public):  # type: ignore[arg-type]
            problems.append(Problem("LENGTH", file, pointer))
            return
        for i, (x, y) in enumerate(zip(raw, public)):  # type: ignore[call-overload]
            diff_docs(x, y, file, f"{pointer}/{i}", leaves, problems)
    elif isinstance(raw, str):
        if raw != public:
            leaves.append((file, pointer, raw, public))  # type: ignore[arg-type]
    elif not _scalar_same(raw, public):
        problems.append(Problem("VALUE", file, pointer))


def build_overlay(raw_dir: Path, public_dir: Path, base: Overlay | None = None) -> tuple[list[Entry], list[Problem], list[tuple[str, str, str, str]]]:
    """由（原始导出，已审读的公开金样）求覆盖层。返回 (条目, 问题, 新记录的差异叶)。"""
    problems: list[Problem] = []
    raw_docs: dict[str, object] = {}
    public_docs: dict[str, object] = {}
    for p in sorted(raw_dir.iterdir(), key=lambda p: p.name):
        if p.is_dir():
            problems.append(Problem("UNEXPECTED_DIR", p.name))
            continue
        q = public_dir / p.name
        if not q.is_file():
            problems.append(Problem("MISSING_IN_PUBLIC", p.name))
        elif p.suffix != ".json":
            if p.read_bytes() != q.read_bytes():
                problems.append(Problem("BYTES_DIFFER", p.name))
        else:
            try:
                raw_docs[p.name] = load_canonical(p)[1]
                public_docs[p.name] = load_canonical(q)[1]
            except OverlayError as e:
                problems.append(Problem(e.code, e.where))
    if problems:
        return [], problems, []
    base_entries = list(base.entries) if base else []
    if base_entries:
        # 严格：base 的每个位置都必须原样适用。未登记出现除外——给它们补位置正是 --base 的用途，
        # 最后的自检仍要求每处出现都已登记
        chk = check_docs(raw_docs, base_entries)
        strict = [p for p in chk.problems if p.code != "UNLISTED"]
        if strict:
            return [], strict, []
        for file, pointer, e in chk.replaced:
            ptr_set(raw_docs[file], pointer, e.public)
    leaves: list[tuple[str, str, str, str]] = []
    for file in sorted(raw_docs):
        raw, public = raw_docs[file], public_docs[file]
        if file == MANIFEST and isinstance(raw, dict) and isinstance(public, dict):
            for key in MANIFEST_COMPARED:
                if (key in raw) != (key in public) or (key in raw and not _same_tree(raw[key], public[key])):
                    problems.append(Problem("VALUE", file, f"/{key}"))
            continue
        diff_docs(raw, public, file, "", leaves, problems)
    if problems:
        return [], problems, leaves
    grouped: dict[tuple[str, str], set[tuple[str, str]]] = defaultdict(set)
    lengths: dict[str, int] = {}
    for e in base_entries:
        grouped[(e.sha256, e.public)].update(e.at)
        lengths[e.sha256] = e.len
    for file, pointer, raw_text, public_text in leaves:
        h = sha256_text(raw_text)
        grouped[(h, public_text)].add((file, pointer))
        lengths[h] = len(raw_text)
    entries = [Entry(h, lengths[h], public, tuple(sorted(at))) for (h, public), at in grouped.items()]
    entries.sort(key=lambda e: e.at[0])
    return entries, [], leaves


def _same_tree(a: object, b: object) -> bool:
    leaves: list[tuple[str, str, str, str]] = []
    problems: list[Problem] = []
    diff_docs(a, b, "", "", leaves, problems)
    return not leaves and not problems


def candidate_tokens(leaves: Sequence[tuple[str, str, str, str]], public_dir: Path) -> list[str]:
    """站点名单的候选词元：差异叶里原文有、公开文本没有、公开金样里也从没出现过的词元。须人工筛。"""
    seen_public: set[str] = set()
    for p in sorted(public_dir.glob("*.json")):
        try:
            doc = json.loads(p.read_bytes().decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            continue
        for _, s in string_leaves(doc):
            seen_public.update(TOKEN.findall(s))
    out: set[str] = set()
    for _, _, raw_text, public_text in leaves:
        out |= set(TOKEN.findall(raw_text)) - set(TOKEN.findall(public_text))
    return sorted(out - seen_public)


def cmd_build(args: argparse.Namespace) -> int:
    out = Path(args.out)
    if out.exists() and not args.force:
        raise OverlayError("OUT_EXISTS", f"{out}（覆盖请加 --force）")
    base = load_overlay(Path(args.base)) if args.base else None
    entries, problems, leaves = build_overlay(_dir(args.raw), _dir(args.public), base)
    if problems:
        print("结构或非文本差异（前 20 处）：" if any(p.code in ("TYPE", "KEYS", "LENGTH", "VALUE")
                                                   for p in problems) else "无法建立：")
        _print_problems(problems, limit=20)
        return 1
    text = overlay_text(entries)
    # 写出前自检：新覆盖层作用于原始导出，结果必须与公开金样逐叶相同，且不留未登记出现
    candidate = Overlay(tuple(parse_overlay(json.loads(text))), "")
    raw_docs = {p.name: json.loads(p.read_bytes().decode("utf-8"))
                for p in Path(args.raw).iterdir() if p.suffix == ".json"}
    chk = check_docs(raw_docs, candidate.entries)
    for file, pointer, e in chk.replaced:
        ptr_set(chk.docs[file], pointer, e.public)
    for file, doc in chk.docs.items():
        public = json.loads((Path(args.public) / file).read_bytes().decode("utf-8"))
        if file == MANIFEST:
            same = all(_same_tree(doc.get(k), public.get(k)) for k in MANIFEST_COMPARED)  # type: ignore[union-attr]
        else:
            same = _same_tree(doc, public)
        if not same:
            chk.problems.append(Problem("BUG_SELF_CHECK", file))
    if chk.problems:
        if all(p.code == "UNLISTED" for p in chk.problems):
            print("公开金样在这些位置仍保留着差异叶的原文（与别处的处理不一致），先在公开金样里改掉：")
        else:
            print("BUG：新覆盖层作用于原始导出后与公开金样不一致")
        _print_problems(chk.problems, limit=20)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(text.encode("utf-8"))
    per_file: dict[str, int] = defaultdict(int)
    for e in entries:
        for file, _ in e.at:
            per_file[file] += 1
    print(f"files={len(per_file)} leaves={sum(per_file.values())} groups={len(entries)}"
          + (f"（本次新增 {len(leaves)} 叶）" if base else ""))
    for file, n in sorted(per_file.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {file} {n}")
    if args.tokens_out:
        tokens = candidate_tokens(leaves, Path(args.public))
        Path(args.tokens_out).write_bytes("".join(t + "\n" for t in tokens).encode("utf-8"))
        print(f"候选词元 {len(tokens)} 个 → {args.tokens_out}（私有，须人工筛）")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    path = _dir(args.dir) / args.file
    if not path.is_file():
        raise OverlayError("MISSING_FILE", args.file)
    try:
        leaf = ptr_get(json.loads(path.read_bytes().decode("utf-8")), args.pointer)
    except KeyError:
        raise OverlayError("MISSING_POINTER", f"{args.file}#{args.pointer}") from None
    text = leaf if isinstance(leaf, str) else json.dumps(leaf, ensure_ascii=False)
    print(f"{args.file}#{args.pointer} sha256={sha256_text(text)} len={len(text)}")
    print(text)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", line_buffering=True)
    ap = argparse.ArgumentParser(description="公开文本覆盖层：原始金样 → 已审读的公开文本")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("apply", help="按覆盖层把原始产物换成公开文本，写进新目录")
    a.add_argument("--in", dest="in_dir", required=True)
    a.add_argument("--out", required=True, help="不存在或为空的目录")
    a.add_argument("--overlay", help="覆盖层文件；缺省取环境变量 SPEC_OVERLAY")
    v = sub.add_parser("verify", help="要求目录已是覆盖层的不动点，不写任何文件")
    v.add_argument("--dir", required=True)
    v.add_argument("--overlay")
    b = sub.add_parser("build", help="由原始导出与已审读的公开金样求覆盖层")
    b.add_argument("--raw", required=True)
    b.add_argument("--public", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--base", help="先严格套用这份覆盖层，只为剩余差异新建条目")
    b.add_argument("--tokens-out", help="站点名单候选词元（私有文件）")
    b.add_argument("--force", action="store_true", help="覆盖已存在的 --out")
    s = sub.add_parser("show", help="打印一个叶的文本、哈希与字符数（含私有原文，只供人工复核）")
    s.add_argument("--dir", required=True)
    s.add_argument("--file", required=True)
    s.add_argument("--pointer", required=True)
    args = ap.parse_args(argv)
    handlers = {"apply": cmd_apply, "verify": cmd_verify, "build": cmd_build, "show": cmd_show}
    try:
        return handlers[args.cmd](args)
    except OverlayError as e:
        print(f"拒绝：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
