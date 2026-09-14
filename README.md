# dsh-spm

把 MAST（LLM 驱动的自主 STM/SPM 实验系统，Python/LangGraph，**515** 技能 / 7 agent / 21 中间件 / 自研 harness；
技能数以 `spec/golden/skills.json` 为准——旧仓还在给真机发版，这个数会一直长）
**用 TypeScript 在 DeepSeek Harness (dsh) 上按技能逐个重写**，成为开源插件集。
session / 记忆 / 循环 / 中断 / 审批 / 后台任务 / UI 壳 / 多 provider 交给 dsh，我们只写 SPM 领域。

- 许可证 **MIT**（`Copyright (c) 2026 HamsterPark`）· npm 包名 **`dsh-spm-<name>`**（无 scope）
- dsh 版本：**实时追踪最新版**（所有 dist-tag 里 semver 最大的那个，不是某个固定 tag），整套 `@deepseek-ai/*` 精确钉同一版本，随 dsh 的破坏性重构一起重构（PLAN D11）；**当前锁定 `0.1.5-rc.2`**（以 `docs/dsh/facts.md` 首行为准）
- 旧仓库 `<MAST_ROOT>\` 原样保留：继续给真机发版 + 当规格书（只读）
- **真机 0 次直到 Phase 8**：`profiles/mast-rig` 在那之前不存在于本仓库

## 现在在哪一步

已完成：0.1 ✅ 环境 · 课时 0.1.5 ✅ 版本裁决（当时不升 0.1.3-alpha.2）· 0.2 ✅ 仓库骨架
· 0.3 ✅ 防腐层与版本锁 · 0.4 ✅ 总 bundle 与 `stm_hello`（真实 dsh 集成已验）· 0.6 ✅ spike（结清 1/2/3/5/7/9，半结清 6）· 0.7 ✅ 规格导出 · 1.1 ✅ si.ts 移植 · 1.2 ✅ 线协议帧层 · 1.2b ✅ 类型码表 · 1.3 ✅ 协议代码生成 · 1.4 ✅ RoleLink TCP 客户端 · 1.5 ✅ 熔断状态机 · 1.6 ✅ ctx.instrument Service · 1.7 ✅ instrument-stmsim provider + `profiles/mast-sim` · 1.8 ✅ ctx.instrumentState 1 Hz 状态缓存 · 1.8b ✅ 实时状态提示块 + stm_get_state · 1.9 ✅ 看门狗 + 急停 · 1.10 ◐ SSE hub + 投影（客户端半边受阻于台账 B12）· **Phase 2 开工**：2.1–2.5 ✅ 安全闸门。
**Phase 0 完成**（只差覆盖率门禁）。**Phase 2 进行中，下一步 = 课时 2.6（sample gate）**。2026-09-13 已升 dsh 到 `0.1.5-rc.2`（接触面零变化；**追踪已切到稳定通道**，见 `docs/dsh/upgrades.md` 的切换点补记）。0.5（设置卡）挪到 1.7 后再挪到 1.10，与 U0 共用客户端机器。

14 个工作区包（含 root）、3610 条测试（含 40 条对真 stmsim 的集成测试，模拟器由 vitest globalSetup 自动起停）+ **173 条变异演练全红**，已移植 **324/515** 技能、**45/165** 模块，golden 与 Nanonis 协议表已入仓。逐段清单、每段的停点与验收在 **`docs/EXECUTION.md`**——**Phase 2–8 的分段计划已于 2026-09-10 一次写全**（约 45 个课时）。

## 文档地图

| 文档 | 内容 |
|---|---|
| **`docs/PLAN.md`** | 主计划（版本无关正本）：决策 D1–D11、MAST 侧陷阱 §3.2、目标架构 §6、能力接缝 §7、逐 skill 流水线 §8、前端 §9、Phase 0–8 §11、验证 §12、风险 §13、非目标 §14 |
| **`docs/EXECUTION.md`** | **分段执行计划**：从这里开工。每段写什么、讲什么、你怎么验、停在哪、红了回滚到哪 |
| **`docs/dsh/facts.md`** | 对照当前锁定 dsh 版本核实的事实：版本节奏、本机环境、组合树、三层机制、能力表、dsh 侧陷阱、spike 十条、逐版本影响 |
| **`docs/dsh/upgrades.md`** | 升级策略（每课时查新版、一次一版、单独提交、随 dsh 重构）与逐次升级日志 |
| **`docs/dsh/spike.md`** | spike 十条的结论与「红了改什么」；已结清的钉在 `compat/src/spike.test.ts` 里 |
| **`spec/nanonis/`** | Nanonis 协议表（671 方法，拷自 STM-Bench 带来源）。`pnpm gen:nanonis` 从它生成类型化门面 |
| `spec/dsh/` | 每个 dsh 版本的 web profile 组合树导出与包清单，升级时逐行 diff 用 |
| **`spec/golden/`** | 与 Python 侧对账的**分母**：515 条技能契约 + 146 条 SI 金样 + 51 条线协议字节金样 + 50 步熔断轨迹 + 状态缓存三节（29 步 trace），由 `tools/spec-export/` 从旧仓导出，**重跑逐字节相同**。不要手改 |
| `LICENSE` | MIT，`Copyright (c) 2026 HamsterPark` |

**给 dsh 报 bug 走 GitHub Discussions，不是 Issues**——该仓 Issues 已关闭，npm 包 `bugs.url` 指向的 `/issues` 是死链。报之前先搜，那里 bug 密度很高。

**仓外只读参考**（不进本仓 git 历史）：

| 位置 | 内容 |
|---|---|
| `<PRIVATE_REVIEW_ARCHIVE>\01-dsh-spm\研究快照-2026-09-01\` | 八份 2026-09-01 研究快照：MAST 运行时 / harness 层 / 外壳 / 领域层四份勘察、三份设计正本、重构前的 PLAN 原稿。**行号级事实仍有效**，写代码时按绝对路径读 |
| `<MAST_ROOT>\` | 旧仓（规格书，只读）。代码在 `MASTv2/mast/`，venv `.venv-v2-py313` |
| `<STMSIM_ROOT>\` | 模拟器 stmsim；Nanonis 协议表 `stmsim/spec/nanonis_commands.json` |

研究快照为什么在仓外：本仓将公开（MIT），那八份是私有旧仓的行号级内部细节（含真机事故、成本事故、标定与机器信息的位置）。
**一旦进 git 历史就撤不回来**，所以从第一个提交起就不放。其它四条线（求职三件套、部分开源、STM-Bench、MAST 功能计划）的private review archive同在
`<PRIVATE_REVIEW_ARCHIVE>\`，其中 `02-求职与开源【私密】` 一档含开源排除清单，**不可进任何公开仓库**。

## 工作方式：交互式开发（用户要求，PLAN.md §2.1）

写一段（≤200 行）→ 讲解（做了什么 / 为什么 / dsh·TS 概念 / 与旧仓 Python 的差别 / 怎么亲手验证）→
确认后再写下一段。**不连写多段**。测试与代码同段。**每课时开始先查 dsh 有没有新版**：

```powershell
npm view @deepseek-ai/dsh dist-tags --json    # 三个 tag 全看，取 semver 最大值
```

有新版就先按 `docs/dsh/upgrades.md` 的八步清单升一次、单独提交，再继续原课时。

## 环境

```powershell
corepack enable --install-directory $env:APPDATA\npm pnpm   # 直接 corepack enable 在本机 EPERM
pnpm -v
```

**跑测试**：`pnpm test` 里的 `integration` project 会对着**真** stmsim 跑，模拟器由 vitest 的 globalSetup
自动起停（16501–16504），只要给它两个路径：

```powershell
$env:STMSIM_PYTHON = "python"
$env:STMSIM_ROOT   = "<STMSIM_ROOT>"
pnpm test                    # 全部；只跑单测：pnpm test --project unit
```

没设这两个变量时 globalSetup **抛错并说清怎么配**，不静默跳过——跳过的测试等于没有的测试。
（本机 PATH 上的 `python` 是 Microsoft Store 转发桩，不能用，所以路径必须显式给。）

**所有 dsh 命令永远带版本号**（版本取 `docs/dsh/facts.md` 首行）：`latest` 的指向随时会变，而且 prerelease 上的 `^`
范围在**同一 `x.y.z` 元组内**会跨 alpha→rc 通道（09-04 实测：钉 alpha.4 的全新安装装出 213 个 rc.1 子包）。
只钉 `@deepseek-ai/dsh` 一个包锁不住任何东西——必须整套精确钉 + `check-dsh-pin` 断言单版本。详见 `docs/dsh/facts.md` §1。
