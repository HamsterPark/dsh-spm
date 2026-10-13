# dsh-spm

[English](README.md) · 中文

**面向扫描隧道显微镜与扫描探针显微镜（STM/SPM）的实验科学工具集，以 DeepSeek Harness 的 TypeScript 插件实现。**

`dsh-spm` 将仪器控制、定量分析与视觉实验记忆接入同一个智能体环境，支持显微实验完整的推理循环：建立测量条件、获取证据、比较观测、检验物理解释，再选择下一步实验。

本项目将 MAST 的科学计算与仪器控制能力迁移到 TypeScript，并实现 VISTA-SPM 提出的视觉记忆与计量设计。DeepSeek Harness（dsh）提供模型编排、会话、审批和应用外壳；本仓库提供 SPM 领域工具，以及这些工具与宿主的运行时集成。

这一组合让实验记录成为推理过程中可主动使用的资源：仪器回读确认操作效果，图像档案支持随时回看证据，数值工具把视觉结构连接到物理量。独立安装的插件已在原生 dsh 模型会话中完成有记录的模拟器流程；视觉 harness 也已提供可选接入的实现，支持后续评估。

[文档导航](docs/README.md) · [代码与证据](docs/REVIEW-GUIDE.md) · [STM-Bench 运行指南](docs/MINIMUM-USABLE.md) · [Nanonis 模拟器运行指南](docs/NANONIS-SIMULATOR.md) · [智能体工作指引](AGENTS.md)

## 为什么 STM 实验难以自动化

STM 利用尖锐针尖与邻近样品之间的隧穿电流探测表面。电流随针尖—样品距离近似呈指数变化：实现原子分辨率的高灵敏度，也使微小扰动足以显著影响测量。图像同时包含几何形貌与电子结构信息，解释它需要理解测量过程。理论背景见 [Tersoff–Hamann 理论](https://doi.org/10.1103/PhysRevB.31.805)。

- **针尖状态只能间接判断。** 图像和谱线是针尖与样品共同作用的结果，通常无法据此唯一确定针尖末端的原子构型或电子态。
- **测量条件持续变化。** 热漂移、压电蠕变与迟滞使指令位置和实际位置的对应关系变得复杂，长时间测量需要反复核对是否仍在同一位置。参见[扫描器畸变研究](https://arxiv.org/abs/1611.00243)。
- **操作会留下物理历史。** 修针、操纵等动作可能改变针尖或样品，把参数调回去未必能恢复原先的物理状态。[原子操纵实验](https://doi.org/10.1038/s41467-022-35149-w)也表明，针尖变化前有效的参数，变化后可能失效。
- **科学判断依赖诊断。** 图像清晰本身不能证明后续谱学测量可信。发现异常后，需要提出不同解释、安排对照测量，再决定继续、恢复条件还是请操作者介入。

这些难点也使 STM 成为研究自主实验科学的重要场景。智能体需要持续建立并修订对针尖、样品和测量条件的认识。一次衬度变化可能引出新的偏压选择、重复扫描、谱学测量或修针操作；科学价值在于选择有信息量的干预，并解释其后果。更完整的实验背景见 [MAST-public 的介绍](https://github.com/HamsterPark/MAST-public/blob/main/README.zh.md)。

### 为什么视觉记忆应当进入实验闭环

**表征本身就是推理的一部分（Representation is part of reasoning）。** 我们通过接口保留图像、扫描坐标、物理单位与采集历史之间的联系，将这一原则落实到系统中。模型能否回看某一区域、比较不同扫描或请求数值测量，会影响它检验物理解释的方式。TypeScript 视觉工具让这些操作进入智能体的推理过程。

原子晶格、重构、台阶和吸附物赋予 STM 图像丰富的空间关系。这些结构的意义往往在比较中显现：操纵前后的同一区域、相反扫描方向，或不同隧穿条件下的同一特征。保留这些观测，才能让智能体在后续问题出现时重新查阅相关证据。

[VISTA](https://arxiv.org/abs/2610.02200) 为这一思路提供了基础：直接的视觉观测、无损记忆和主动检索支持长程交互中的推理。我们将它与 STM 联系起来，既基于图像的空间结构，也基于实验的交互过程。与 ARC-AGI-3 所研究的交互任务相似，显微实验要求智能体从图像中推断关系、实施干预，再依据变化修订认识。STM 进一步引入物理单位、仪器动力学与不断演化的针尖—样品条件。VISTA-SPM 以及这里的 TypeScript 实现，正是为这些需求将视觉记忆与定量计量结合起来。

## 同一研究方向中的互补仓库

这些项目分别承担自主显微实验中的不同环节，并在实验执行、视觉推理与评估之间建立明确接口：

| 项目 | 主要职责 | 与 dsh-spm 的关系 |
|---|---|---|
| [MAST-public](https://github.com/HamsterPark/MAST-public) | MAST 的有限公开版：基于 Python/LangGraph 的仪器运行时、技能、状态反馈与实验工作流 | 为 TypeScript 迁移提供科学与操作基础；MAST 继续作为独立系统发展。 |
| [VISTA-SPM](https://github.com/HamsterPark/VISTA-SPM) | 可复用的显微视觉推理框架：证据档案、标定检查、测量、笔记与可控评估 | 提供 Python 参考设计，以及用于核对 TypeScript 视觉工具的导出参考结果。 |
| **dsh-spm——本仓库** | DeepSeek Harness 中的 SPM 工具、仪器连接、执行检查、记录与视觉 harness 集成 | 将源自 MAST 的领域能力和 VISTA-SPM 的设计接入 dsh 的 TypeScript 宿主与会话生命周期。 |
| [STM-Bench](https://github.com/HamsterPark/STM-Bench) | 模拟显微镜、科学场景、采集记录与基于证据的评估 | 为运行时验证提供可控仪器环境，也为研究实验行为提供共同基础。 |

核心分工是：**MAST 提供仪器控制系统，VISTA-SPM 发展视觉推理框架，dsh-spm 将这些能力接入另一种智能体宿主，STM-Bench 提供模拟与评估。** 可复用的核心是科学接口——带物理坐标的观测、带单位的测量，以及有结果记录的动作；这些接口可以在不同运行时中实现。

## TypeScript 中的视觉推理与计量

[视觉记忆包](packages/host/visual-memory/src/index.ts) 将 VISTA-SPM 的设计实现为可复用服务和模型工具，把图像解释连接到实验关心的量：特征位置、台阶高度、晶格或重构周期、扫描前后的变化，以及谱学信号。

| 能力 | 科学用途 | 实现 |
|---|---|---|
| 持久帧档案 | 按稳定帧 ID 回看扫描、各通道、正反扫、中途快照与谱 | [档案](packages/host/visual-memory/src/archive.ts)与[会话服务](packages/host/visual-memory/src/plugin.ts) |
| 标定检查与读值 | 裁剪或重新渲染局部区域，换算显示坐标与扫描坐标，读取物理量 | [视图与读值](packages/host/visual-memory/src/views.ts) |
| 定量测量 | 提取剖面、傅里叶峰、局域特征、配准差分与统计量 | [测量工具](packages/host/visual-memory/src/tools.ts) |
| 实验笔记 | 在 `GUIDE.md` 与 `WORKING.md` 中保留模型持续修订的认识和当前计划 | [笔记](packages/host/visual-memory/src/notes.ts) |
| 观测与执行衔接 | 随工具结果传递新归档的观测，通过观测门控让常规仪器动作按序执行 | [运行时集成](packages/bundle/dsh-spm/src/visual-harness.ts) |

这些工具返回测量结果，供模型结合不同物理假设进行判断。同一套档案与分析接口也可以围绕已有显微数据文件组合使用，使视觉层同时服务于离线数据分析和仪器交互。参考一致性测试将几何、单位、渲染与数值结果同 VISTA-SPM 导出的夹具对照；[视觉记忆导出程序](tools/spec-export/export_visual_memory.py)说明了来源，并记录参考文件的哈希。

最小运行栈通过 `visualHarness` 开关启用这一集成，默认关闭；Nanonis 模拟器入口在常规连接参数之外使用 `scripts/native-session.ts --visual --save-dir <Nanonis 会话目录>`。实现配有单元、契约和参考一致性测试。视觉 harness 的真实模型验收是下一项验证里程碑；下文已完成的模型驱动模拟器验收对应仪器操作流程。

## 从实验约束到执行检查

STM 操作会改变仪器状态。命令成功返回，不等于目标设定或扫描状态已经得到确认；后续操作也依赖先前留下的状态。因此，插件将模型可见的工具契约与执行检查、仪器回读及持久化调用记录结合起来。

在已验收的 Nanonis 流程中，模型读取状态、设置目标偏压、启动和停止扫描，最后恢复偏压。验收程序通过独立 TCP 连接核对偏压与扫描状态，并把模型工具事件关联到本地记录。仪器工具遵循以下执行路径：

```mermaid
flowchart LR
    A["dsh 模型会话"] --> B["STM 工具"]
    B --> C["技能内核与检查"]
    C --> D["仪器连接"]
    D --> E["已核实的模拟器"]
    C --> F["调用记录：SQLite + JSONL"]
```

## 当前可运行范围

**状态：持续开发中的实验项目。** 接口、配置和开放工具仍在演进。当前验收覆盖下列模拟器流程；真实仪器验证安排在 Phase 8。开发重点与证据见[剩余工作](docs/MIGRATION-TODO.md)和[代码评审指南](docs/REVIEW-GUIDE.md)。

以下 Windows 验收记录形成于 **2026-09-21**。每行对应各自的安装包；即使重建后文件名相同，也须按新产物重新核验。

| 运行入口 | 模型可见工具 | 已记录结果 |
|---|---|---|
| 受管 STM-Bench | `stm_hello`、`GetBias` | 包 `8c510e…` 安装于两个独立 home。真实模型调用返回的偏压与独立 TCP 回读一致，并留有持久化结果。另一次调度器检查记录了模拟器断开后的失败状态。[验收记录](docs/handoff/minimum-usable-20260921.md) |
| 已打开的 Nanonis Mimea + STM Simulator | Hello、偏压/电流/Z/扫描状态读取，以及 `SetBias`、`StartScan`、`StopScan` | 包 `b5a7ab…` 完成安装及真实模型流程：7 次请求、9 次工具调用，偏压变化和扫描启停均得到核对；会话、SQLite 与 JSONL 记录通过调用 ID 关联。[验收记录](docs/handoff/native-nanonis-20260921.md) |

Nanonis 记录覆盖 Generic 5e / RT Release 15016，核验内容是偏压与扫描状态。完整图像采集、完整客户端集成、其他平台和公开 npm 发布属于后续里程碑。以上按日期记录的结果对应各自的安装包和运行流程；MAST 的仪器经验为设计提供基础，dsh-spm 的真实仪器验收单独推进。

## 值得查看的工程取舍

- **让执行可追溯。** 工具调用经技能内核到达仪器连接，测量结果和仪器调用都关联其调用 ID。关闭运行时会等待进行中的调用结束，再关闭记录。可从[运行时接线](packages/bundle/dsh-spm/src/minimal.ts)和[关闭流程回归测试](packages/bundle/dsh-spm/src/minimal-lifecycle.test.ts)看起。
- **依据参考行为迁移。** 导出的 schema、轨迹与数值夹具使跨语言差异可测试。容差由具体操作决定；有意保留的差异在[偏差登记](spec/deviations.md)中记录原因和重新考虑的判据。
- **测试断言本身。** [变异演练程序](tools/mutate/run.ts)先建立通过的基线，再注入可编译缺陷，检查所声明的测试范围能否检出。未检出与结论不确定的变异仍会保留在结果中。
- **明确工作流的依赖。** 组合流程沿直接调用与显式声明的步骤计算传递依赖；无法解析的分发会明确记录。参见[依赖测试](packages/host/stm-skills/src/l0/tip-phase-deps.test.ts)。
- **隔离上游 API。** 生产代码经 [compat](packages/host/compat/src/index.ts) 适配 dsh，并以真实上游包的契约测试和精确锁定的依赖守住边界。最小发行包打包内部工作区代码，安装后检查依赖身份。

[代码评审指南](docs/REVIEW-GUIDE.md)将这些取舍对应到实现、测试和验收报告。

## 迁移范围

这里的技能是具备参数 schema、前置条件和结果契约的可执行操作。生成的迁移清单目前将 **442 / 515 项技能**、**112 / 165 个模块**标为完成。其中 13 项技能明确排除，尚有 60 项在范围内；可达目标为 502 项技能 / 160 个模块。详见 [progress.json](spec/progress.json) 和[剩余迁移工作](docs/MIGRATION-TODO.md)。

`done` 要求实现已注册、生成规格存在、参考模型 schema 存在，且至少有一条参考轨迹。这是迁移分类，不表示技能都已通过运行入口向模型开放；当前运行配置的工具集合以上表为准。完整迁移验收定义见[开发指南](docs/DEVELOPMENT.md)。

## 构建与测试

Node 和 pnpm 版本以 [package.json](package.json) 为准。在仓库根目录运行：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test --project unit --project contract
```

这些检查无需私有 MAST 安装、模型密钥或外部模拟器。`integration` 测试项目另需 `STMSIM_PYTHON` / `STMSIM_ROOT`，会启动 STM-Bench；不筛选项目直接运行 `pnpm test` 时也会包含它。

安装和模型操作请按上方对应运行指南执行。STM-Bench 由插件启动和关闭；Nanonis 路径会先核实已打开的 Windows 模拟器身份，结束时仅断开连接而不关闭该模拟器，其命令可能改变偏压和扫描状态。

[最终候选产物检查与公开发布边界](docs/handoff/publication-ready-20260921.md)记录了候选产物及其检查。[代码评审指南](docs/REVIEW-GUIDE.md)也保留了较早的模拟器验收和[历史 CI 失败](docs/RELEASE-TODO.md)；各项结果只对应其记录中的快照和包哈希。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `packages/host/kernel/` | 技能执行、单位、参数与安全检查 |
| `packages/host/numerics/`、`vision/` | 数值方法与图像分析判据 |
| `packages/host/visual-memory/` | 源自 VISTA-SPM 的档案、标定检查、测量与实验笔记 |
| `packages/host/stm-skills/` | 工具适配、单项技能与组合流程 |
| `packages/host/stm-records/`、`stm-safety/`、`nanonis-files/`、`compat/` | 持久化记录、安全服务、文件格式及 dsh 适配 |
| `packages/instrument/` | TCP 协议、连接、状态、看门狗及模拟器进程管理 |
| `packages/bundle/`、`scripts/` | 运行时组合、打包、安装与验收工具 |
| `packages/client/` | 开发中的专用客户端集成 |
| `spec/`、`tools/spec-export/`、`tools/mutate/` | 参考证据、偏差、进度、导出程序与变异演练 |

## 参与开发

- [文档导航](docs/README.md)：按评审、运行、开发或项目历史选择阅读路径。
- [AGENTS.md](AGENTS.md)：面向编码智能体的任务入口、边界和默认验证要求。
- [DEVELOPMENT.md](docs/DEVELOPMENT.md)：迁移验收、生成、测试和协作流程。
- [RELEASE-TODO.md](docs/RELEASE-TODO.md)：公开发布准备与已记录检查。
- [VISUAL-HARNESS.md](docs/VISUAL-HARNESS.md)：视觉感知的科学动机与设计决策（D12）；当前可选接入方式见[运行时集成](packages/bundle/dsh-spm/src/visual-harness.ts)。
- [SOURCES.md](docs/SOURCES.md)：来源和第三方声明，包括参考派生夹具与公开文本规范化。

本项目采用 [MIT 许可证](LICENSE)。第三方材料保留来源登记中说明的声明。
