# AGENTS.md — 仓库工作指引

本文件规定智能体在本仓库中的阅读路径、修改约束与验证方式。项目介绍见 [README](README.md)，代码评审路线见 [REVIEW-GUIDE](docs/REVIEW-GUIDE.md)，完整维护流程见 [DEVELOPMENT](docs/DEVELOPMENT.md)。

## 项目与当前运行范围

`dsh-spm` 将 Python/LangGraph 系统 MAST 的 STM/SPM 领域能力迁移为 TypeScript 的 DeepSeek Harness（dsh）插件。本仓负责仪器连接、状态、安全检查、科学计算和技能；dsh 提供模型编排、会话、审批与应用外壳。MAST 保持独立、只读。

本插件处于持续开发迭代的实验阶段，接口、配置和开放工具仍可能变化。公开源码与稳定版本、真实仪器验收分别判断；概述项目时应保留这一成熟度说明。

目前有两种经过 Windows 安装态与真实模型验收的模拟器入口：受管 STM-Bench 提供 `stm_hello` / `GetBias`；已打开的 Nanonis Mimea 模拟器另支持电流、Z、扫描状态读取，以及偏压设置和扫描启停。两组验收对应不同包哈希，详见运行指南。迁移清单中的实现数量与运行入口实际注册的工具数量分别统计；完整客户端、完整图像采集和真实仪器验证仍在上述验收范围之外。

## 按任务选择入口

| 任务 | 阅读路径 |
|---|---|
| 了解、评审或总结项目 | [README](README.md) → [代码与证据](docs/REVIEW-GUIDE.md) → 对应实现／测试 |
| 运行受管 STM-Bench | [最小版本指南](docs/MINIMUM-USABLE.md)：独立安装、只读模型工具、运行记录 |
| 连接已打开的 Nanonis 模拟器 | [本机模拟器指南](docs/NANONIS-SIMULATOR.md)：身份检查、有限读写、连接生命周期 |
| 修改代码或迁移技能 | [开发指南](docs/DEVELOPMENT.md) → 改动附近的测试；迁移另看 [剩余范围](docs/MIGRATION-TODO.md) |
| 升级 dsh | [版本事实](docs/dsh/facts.md) + [升级策略](docs/dsh/upgrades.md) |
| 准备公开发布 | [发布清单](docs/RELEASE-TODO.md) + [来源说明](docs/SOURCES.md) |

[MINIMUM-RUN-TODO](docs/MINIMUM-RUN-TODO.md) 是 2026-09-20 的历史调查；其中未勾选项和当时的“未验证”判断不能代替后续验收。交接记录与实施日志按需读取，不必把全部历史作为每次任务的前置条件。

## 开始工作与默认检查

先看 `git status --short` 和相关 diff，确认本次范围、已有修改与验收命令。保留用户及其他任务的工作，不擅自还原或一并提交。

只读审阅可直接阅读代码、夹具和已保存的报告，无需 MAST、模型密钥或模拟器。用户要求执行验证时，优先使用不连接外部模拟器的构建与单元／契约测试。从仓库根目录运行：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test --project unit --project contract
```

Node 与 pnpm 版本以 [package.json](package.json) 为准；已有依赖时无需重复安装。`pnpm build` 写入本地构建产物。当前 CI 配置覆盖 Windows / Ubuntu × Node 22.19 / 24，具体执行结果须对应提交和日期。

- **文档修改**：核对链接、路径、命令和事实来源；不因此重导金样或运行全套演练。
- **代码修改**：构建及相关单元／契约测试；涉及仪器交互时补相应模拟器验证。
- **技能迁移**：按开发指南逐项执行完整完成定义，并记录缺项。

不带筛选的 `pnpm test` 包含 STM-Bench 集成测试，需要 `STMSIM_PYTHON` / `STMSIM_ROOT`，会启动模拟器。安装、模型会话与原生模拟器验收有不同前置条件和写入行为，见开发指南；不要将其当成普通只读检查。

## 修改约束

1. **参考仓只读。** `MAST_ROOT` 定位参考源码，`MAST2_PROJECT_ROOT` 定位隔离运行目录。执行导出前检查对应脚本，运行后检查参考目录未被写入。私有参考源码、研究资料、凭据和原始仪器数据不得进入本仓历史。
2. **Phase 8 前不连接真实仪器，不创建 `profiles/mast-rig`。** 模拟器连接必须经过对应身份检查；仅凭回环地址、端口号或目录名不能确认设备性质。受管进程和用户已打开的模拟器使用各自的关闭流程。
3. **上游 API 经 compat。** 除 `packages/host/compat/src/` 自身外，生产代码通过 `dsh-spm-compat` 使用 `@deepseek-ai/*`；`contract/` 测试可直接验证真实上游包。类型增补及元数据字符串不是运行时导入，检查见 [boundary.test.ts](packages/host/compat/src/boundary.test.ts)。
4. **保持可观察契约。** 参数、单位、返回字段、状态和拒绝文案都是接口。有意改变参考行为时，在 [偏差登记](spec/deviations.md) 中记录原因、判据与重新考虑所需的证据；不要照抄已确认的参考缺陷。
5. **从来源更新生成物。** 规格／注册表变更后执行 `pnpm gen:skills` → `pnpm build` → `pnpm gen:progress`。不手填进度，不为消除失败改写预期。重导后复查公开文本，保留真实来源类别；脱敏例外按开发指南处理。
6. **保留有效判据。** 不靠跳过失败用例、削弱断言或降低覆盖率门槛使结果变绿。区分实现缺陷、环境差异、过期生成物和测试问题，再修对应来源。
7. **变异演练独占工作树。** 它会临时改源码并重建，不与同树编辑或其他演练并行；使用开发指南中的完整 CLI 入口。中断后检查残留改动并复验。
8. **按范围维护依赖与发布状态。** dsh 升级任务跟踪 `latest` / `next`，alpha 只读发布说明、记录影响。文档审阅不自动扩展为依赖升级、设备操作或发布。

## 证据与交付

- **进度**：以 [spec/progress.json](spec/progress.json) 和 [计数逻辑](scripts/build-progress.ts) 为准。`done` 要求实现已注册、生成规格存在、参考模型 schema 存在且至少有一条参考轨迹；完整验收另看对应记录。
- **运行**：把提交／工作树、包 SHA256、环境、命令和工具范围对应起来。同名 tarball 重建后可能不同；两个 home 的通过记录只属于报告所列产物。
- **来源**：区分本次执行、历史记录与静态判断。测试与金样按其断言和输入范围解释；生成声明一致不算独立行为验证。文件是否已跟踪用 `git ls-files` 核实。
- **交付**：说明改动、理由、实际检查及结果；缺少前置条件时写明未执行。问题报告给出位置和触发条件，文档与代码不一致时指出具体差异。
