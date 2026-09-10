# `spec/golden/` —— 与 Python 侧对账的分母

**不要手改这里的任何文件。** 全部由 `tools/spec-export/export_mast_spec.py` 从旧仓 MAST 导出：

```powershell
python tools\spec-export\export_mast_spec.py
```

本机 PATH 里没有可用的 `python`（只有 Microsoft Store 的转发桩），必须用旧仓 venv 的绝对路径。
脚本**只读旧仓**：导出前把 `MAST2_PROJECT_ROOT` 指向临时目录，旧仓的 config / data_paths /
override_store / models（API key 目录解析）都认这个变量。2026-09-08 实测：跑完后
`find MAST -newermt '-10 minutes'` 返回空，旧仓一个字节没动。

**重跑产出逐字节相同**（已验）。所以「旧仓变了没有」这个问题可以用 `git diff` 回答——
这也是 manifest 里不记随机沙箱路径的原因。

| 文件 | 内容 | 谁消费 |
|---|---|---|
| `skills.json` | 515 条技能的**作者声明**契约：category / safety_level / description / 逐参数 ParameterSpec（含 unit、min/max、allowed_values）/ preconditions / capabilities / composition_level / 所在模块与 origin | DoD ①（`skill.spec` 与之 deep-equal）、DoD ②（工具 schema description 逐字相等）、§8.4 分批成员派生 |
| `watchdog.json` | 看门狗的判定行为：12 条脚本，由**真 `SafetyWatchdog.run()`** 跑出来（把它的 `time` 换成假时钟，让真循环自己跑）。含 2026-08-10 那次「武装着却打不着火」的复现 | 课时 1.9 的看门狗移植 |
| `state.json` | 状态缓存三节：`spec`（1 Hz 读哪 11 个动词——**观测得到，不是手抄**——加可 patch / 需强转的字段白名单）、`coerce`（21 条「什么算一个读数」）、`trace`（14 条脚本 29 步，驱动真 `InstrumentState`，含 carry-forward 与 stale 的逐步快照）、`live_state`（7 条实时状态提示块的**整段文本**——措辞就是契约） | 课时 1.8 的状态缓存移植与 D-STATE-1；1.8b 的提示块 |
| `si_cases.json` | 127 条 SI 行为金样：`parse_si` / `parse_quantity`（strict 与 loose 各一遍）/ `needs_strict_prefix` / `format_si`，**含报错类型与原文** | 课时 1.1 的 `si.ts` 移植 |
| `manifest.json` | 每个 collector 的成败与条数 | 一个 collector 坏了不能静默缺一块——缺一块会让分母悄悄变小 |

## 两条别忘的

**用的是 `_get_metadata_raw` 不是 `_get_metadata`。** 前者是技能作者的声明，后者叠加了 admin 覆盖。
旧仓自己的注释讲得最清楚：拿叠加后的当基线，一个「调低某技能 safety_level」的管理员覆盖就会变成新标尺，
把审批闸门洗白。分母要的是声明，不是当前生效的包络。

**报错原文也是契约。** `si_cases.json` 里录了异常类型与完整消息，因为模型读到的正是这些句子
（PLAN §3.2-1、§3.2-16）。已经发现 strict 与 loose 对同一个非法输入给的是**两句不同的教学文案**——
这种东西照着行为写 TS 能过，照着措辞写才对得上。

## 还没导的

`tool_schemas.json` / `preconditions.json` / `safety.json` / `tool_packs.json` /
`prompts/` / `traces/` 等（PLAN §8.6 的完整清单）按消融原则等各自的消费者出现再加：
schema 与 preconditions 在 Phase 2 的内核闸门，`verbs`（AST 抽 `safe_call` 字面量）在 1.3 的协议代码生成，
`error_branches` 在 DoD ③ 的逐分支单测，`traces/` 在 §12 的差分测试。脚本已经搭好，加一个 collector 就是加一个函数。
