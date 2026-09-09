# `spec/nanonis/` —— Nanonis 协议表（拷贝，带来源）

`nanonis_commands.json`：**671 个方法**的机器可读协议表。
`scripts/gen-nanonis.ts` 从这里生成 `packages/instrument/nanonis-wire/src/generated/methods.ts`。

## 来源与为什么要拷进来

原件在 `<STMSIM_ROOT>\stmsim\spec\nanonis_commands.json`，由 STM-Bench 的
`spec/extract.py` 从两处抽取（见 JSON 里的 `generated_from`）：

- `MAST\working-memory\NanonisClass_upstream.py` —— `nanonis_spm` v1.0.9 的上游类
- `MAST\MASTv2\mast\core\nanonis_patch.py` —— MAST 打的补丁（12 个方法，`source: "patch"`）

**拷进来而不是引仓外路径**：生成器要在 CI 上跑（校验重生成无 diff），而 CI 上没有 STM-Bench。
拷贝也让「协议表变了」这件事变成本仓的一次 diff，而不是别人机器上的一次静默变化。

**同步方式**：STM-Bench 的表更新时手动重拷 + 重跑生成器，两个改动进同一个提交。
本文件只做格式规整（`JSON.stringify(…, 2)` + LF），内容与原件等价。

## 读这张表时必须知道的四件事

1. **`params` 不可信，用 `args`。** `Osci1T_TrigGet` 声明 6 个 `params` 但只有 4 个 `args`；
   `Osci2T_ChsSet` 的 `params` 是 `undefined`。STM-Bench 自己的 `wire/spec.py` 也完全不读 `params`。
2. **两个 alias**：`Osci2T_ChGet → Osci2T_ChsGet`、`Osci2T_ChSet → Osci2T_ChsSet`。
   它们的 `args`/`returns`/`command` 都是 `null`，必须先解引用再用。
3. **`c` 参数的二义不在这张表里**。同一个 `+*c` 格式串，字符串与数组产出完全不同的字节
   （见 `spec/golden/wire_types.json`）。消歧表硬编码在 STM-Bench 的 `wire/spec.py`：

   | wire 命令 | 是字符串数组的参数下标 |
   |---|---|
   | `Scan.PropsSet` | `5`（`Modules_names`；同方法的 3 `Series_name` 与 4 `Comment` 是普通字符串） |
   | `TCPLog.ChsSet` | 无 |

   其余 35 个带 `c` 参数的方法一律按普通字符串处理。这张表也拷进了生成器，**改了要两边一起改**。
4. **`mast_callsites`** 记录旧仓实际调用过哪些动词，`mast_callsites_missing_from_spec` 记录对不上的。
   分批与优先级会用到（PLAN §8.4），但生成器不读它。
