# Nanonis 协议元数据

第三方来源与 `nanonis_spm` 1.0.9 的 MIT 通知见 [`docs/SOURCES.md`](../../docs/SOURCES.md)。

[nanonis_commands.json](nanonis_commands.json) 记录 **671 个方法**的机器可读协议元数据。
[gen-nanonis.ts](../../scripts/gen-nanonis.ts) 据此生成 [TypeScript 方法接口](../../packages/instrument/nanonis-wire/src/generated/methods.ts)。该表描述协议编码，不证明每个命令都经过当前运行入口或真实仪器验证。

## 来源与更新方式

原件在 `<STMSIM_ROOT>\stmsim\spec\nanonis_commands.json`，由 STM-Bench 的
`spec/extract.py` 从两处抽取（见 JSON 里的 `generated_from`）：

- `nanonis_spm` v1.0.9 的 `NanonisClass.py` 上游类
- `<MAST_ROOT>/mast/core/nanonis_patch.py` —— MAST 打的补丁（12 个方法，`source: "patch"`）

保存本地副本使生成器无需安装外部 STM-Bench 即可运行，也让协议变更成为可审查的仓库差异。

**同步方式**：STM-Bench 的表更新时手动重拷 + 重跑生成器，两个改动进同一个提交。
协议字段与原件等价；公开副本另外将 `generated_from` 中的开发者绝对路径改为包名／源码占位符。
重拷时保留该脱敏处理并检查其他公开文本，再检查生成器同步状态。

从仓库根目录检查协议表与生成接口是否同步：

```text
node scripts/gen-nanonis.ts --check
```

`--check` 不重写文件。更新协议表后，使用 `pnpm gen:nanonis` 生成，并运行对应协议测试；同步检查不能代替传输和设备行为验证。

## 解释协议表时的注意事项

1. **编码参数以 `args` 为准。** `params` 字段存在缺失或与编码定义不一致的情况。例如 `Osci1T_TrigGet` 声明 6 个 `params` 但只有 4 个 `args`；
   `Osci2T_ChsSet` 的 `params` 是 `undefined`。STM-Bench 自己的 `wire/spec.py` 也完全不读 `params`。
2. **两个 alias**：`Osci2T_ChGet → Osci2T_ChsGet`、`Osci2T_ChSet → Osci2T_ChsSet`。
   它们的 `args`/`returns`/`command` 都是 `null`，必须先解引用再用。
3. **`c` 参数的二义不在这张表里**。同一个 `+*c` 格式串，字符串与数组产出完全不同的字节
   （见 [wire_types.json](../golden/wire_types.json)）。消歧表由 STM-Bench 的 `wire/spec.py` 单独定义：

   | wire 命令 | 是字符串数组的参数下标 |
   |---|---|
   | `Scan.PropsSet` | `5`（`Modules_names`；同方法的 3 `Series_name` 与 4 `Comment` 是普通字符串） |
   | `TCPLog.ChsSet` | 无 |

   其余 35 个带 `c` 参数的方法按普通字符串处理。本仓生成器包含对应规则；更新时同步核对来源规则、生成器与字节级测试。
4. **`mast_callsites`** 记录旧仓实际调用过哪些动词，`mast_callsites_missing_from_spec` 记录对不上的。
   分批与优先级会用到（PLAN §8.4），但生成器不读它。
