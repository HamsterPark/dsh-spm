# 开发与验证

本文件承接根目录 [AGENTS.md](../AGENTS.md) 的工作约定，供修改代码、迁移技能和维护验证工具时使用。只读评审可从 [Review guide](REVIEW-GUIDE.md) 开始。

## 开工与改动范围

1. 查看 `git status --short` 及相关 diff，保留工作树中的已有改动。
2. 找到改动对应的实现、测试、金样与偏差记录，明确此次验收命令。阅读 [EXECUTION.md](EXECUTION.md) 和相关交接记录了解历史，但当前行为须回到代码核查。
3. 修改代码前确认根目录 `package.json` 的运行环境和 pnpm 固定版本。构建使用 `pnpm build`；根目录持有构建脚本，不用 `pnpm -r build` 代替。
4. 依赖维护或 dsh 升级任务运行 `pnpm check:dsh-latest`。当前策略取 `latest` / `next` 中较大的版本作为升级候选；`alpha` 只读发布说明、记影响，不自动升级。精确锁版与接触面事实见 [facts.md](dsh/facts.md) 和 [upgrades.md](dsh/upgrades.md)。只读审阅和文档修改不因此扩大为升级任务。

## 技能迁移的完成定义

以下是迁移验收要求，范围大于 `spec/progress.json` 的四项统计条件：

1. **规格对齐**：参数名、类型、必填性、单位与范围对照 `spec/golden/skills.json`；生成的声明本身不算独立测试。
2. **模型可见契约**：schema、返回字段、状态和拒绝文案对照参考结果；字段名与模型可见文案逐字对齐。有意差异（包括平台适配）须登记原因并提供判据。
3. **分支判据**：正常路径、每个错误分支和相关安全边界有可区分正确／错误实现的断言。
4. **模拟器集成**：对仪器交互验证相应的实际模拟器链路；通用仪器技能使用 STM-Bench，原生接入另按 Nanonis 指南验证。若某项不适用，说明理由；缺少外部依赖时记录未验证，不能用替身测试冒充集成验证。
5. **差分证据**：实现与参考导出结果比较，按具体算法声明精确比较或容差。旧仓缺陷不照抄时登记偏差。
6. **变异演练**：为关键判断准备能编译的变异，确认干净测试基线和被覆盖的范围；按下文完整入口执行。
7. **生成与交接**：按正确顺序同步生成物和进度，记录运行环境、命令、范围、结果及未验证项。

纯函数不必伪造仪器集成场景；同样，统计中标为 `done` 也不会自动补齐上述验收证据。

## 金样、生成物与参考仓

金样包括声明、行为轨迹、数值判据及源码静态分析结果，入口是 [spec/golden/README.md](../spec/golden/README.md) 和各导出器文件头。数值或轨迹的预期应来自执行参考实现，不要凭印象手写一份看起来合理的答案。

新增样例时先问：这个输入和断言能否区分正确实现与一种具体的错误实现？结果恰好相同的样例不能检验那一处差别。

### 常规生成

修改规格或技能注册后，从根目录依次执行：

```text
pnpm gen:skills
pnpm build
pnpm gen:progress
```

`build-progress.ts` 读取 `lib/generated/specs.js` 和已编译的技能注册表。未重建就生成进度，可能把旧编译产物当成当前实现。

已有最新构建产物时，可只检查同步状态：

```text
node scripts/gen-skill-specs.ts --check
node scripts/build-progress.ts --check
```

两个 `--check` 不重写对应生成文件；进度检查仍依赖最新构建。不要用手改 `spec/progress.json` 或 `src/generated/specs.ts` 消除差异。

### 从 MAST 重导

MAST 专用导出器需要私有参考实现和适配的 Python 环境，不属于公开仓库的基本构建／单测前置条件。并非所有导出器都有此依赖，例如 `export_numerics.py` 使用 NumPy、SciPy 和 scikit-image，无需 MAST。先检查实际脚本入口及依赖：`MAST_ROOT` 必须设置为包含 `mast/` 包的只读源码目录（可能是参考项目的 `MASTv2/` 子目录）；涉及 STM-Bench 的导出器另需将 `STMSIM_ROOT` 设置为包含 `stmsim/` 的目录。缺少变量或指向非目录时，入口明确报错。它们与隔离运行目录 `MAST2_PROJECT_ROOT` 用途不同；文档中的 `<MAST_ROOT>` 是占位符，不是可直接执行的路径。

- 参考仓保持只读。导出器须在导入 MAST 前设置 `os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(...))`；同时确认进程中已有的同名变量没有指回参考仓，因为 `setdefault` 不会覆盖它。
- 防止导入过程在参考仓写 `__pycache__`，例如设置 `PYTHONDONTWRITEBYTECODE=1`。记录运行前后文件状态，并扫描参考目录中开跑后写入的文件；PowerShell 可用 `Get-ChildItem` 配合 `LastWriteTimeUtc`。不要只检查 Git 跟踪文件而漏掉配置或数据目录。
- JSON 序列化使用 `allow_nan=False`、`sort_keys=True` 和 LF。相同输入重导两次，比较完整字节；记录所用参考版本与条件。
- 私有源码、实验数据与凭据不进入本仓。已获准保留的派生规格／夹具仍需检查公开内容和来源，见 [SOURCES.md](SOURCES.md) 与 [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md)。

**公开文本的例外**：说明字段、匿名测试标签及已登记的标识符可以按公开内容审查的明确范围同步调整；这不授权改动数值、二进制载荷或真实来源类别。涉及可观察标识符的变化须记录兼容影响并验证相关契约。此类公开版本不能再声称所有说明字段都与私有原始导出逐字节一致。后续重导可能恢复私密文本，必须再次审查。

### 偏差登记

[spec/deviations.md](../spec/deviations.md) 记录参考与迁移实现的行为差异：现象、理由、影响，以及改变决定所需的证据。保留可定位的测试或样例。

并行支线用 `D-<族>-?` 暂占编号，整合时统一编号。一个族分配多个编号时，逐条按上下文更新引用；不能机械地把所有 `?` 替换成同一个号。

## 测试分层与前置条件

实际项目定义在 [vitest.config.ts](../vitest.config.ts)，CI 选择在 [ci.yml](../.github/workflows/ci.yml)。

| 范围 | 命令 | 前置条件与含义 |
|---|---|---|
| 单元 + 契约 | `pnpm test --project unit --project contract` | 已安装依赖、完成构建；契约测试使用真实上游包，不要求模型密钥或外部模拟器 |
| 定向验证 | `pnpm test --project unit --project contract <test-path>` | 将占位符换成真实测试路径；确认输出确实执行了预期测试 |
| 模拟器集成 | `pnpm test --project integration` | 显式配置 `STMSIM_PYTHON` / `STMSIM_ROOT`；启动实际模拟器 |
| 默认全部项目 | `pnpm test` | 包含 integration，因此也要求上述外部依赖 |
| 覆盖率 | `pnpm test:coverage --project unit --project contract` | 检查配置中现有门槛；覆盖率不代替行为判据或硬件验证 |

集成测试由 [vitest.stmsim-setup.ts](../vitest.stmsim-setup.ts) 管理 STM-Bench，使用本地 16501–16504 端口。`STMSIM_PROFILE` 可选，默认 `reference-stm`；它选择外部模拟器的配置，不是 dsh profile。不要与使用相同端口的实例同时运行。缺少必需环境变量会明确失败，不会静默跳过。

历史 CI 失败与环境差异在 [RELEASE-TODO.md](RELEASE-TODO.md)。运行时报告本次结果；若基线已有失败，记录具体用例和原因，不能把后续失败都归因于当前修改。

## 安装态与两种模拟器

运行接线在 [minimal.ts](../packages/bundle/dsh-spm/src/minimal.ts)。修改最小运行层时，按所选模式验证身份、执行顺序、持久化和卸载；常规单元／契约测试对模拟器使用替身，不启动外部模拟器。dsh 契约仍使用真实上游包。

| 模式 | 前置与入口 | 生命周期和工具范围 |
|---|---|---|
| 受管 STM-Bench | Python、`STMSIM_ROOT`，见 [最小版本指南](MINIMUM-USABLE.md) | 启动并停止本轮进程；模型入口为 hello / GetBias；安装态验收使用自己配置的端口 |
| 已打开的 Nanonis Mimea 模拟器 | Windows、当前模拟器 PID、通过验证的 Sim-Engine，见 [本机模拟器指南](NANONIS-SIMULATOR.md) | 默认端口 6501–6504；只断开本轮连接，不关闭外部应用；支持有限读取、偏压设置、扫描启停 |

原生模式要求扫描前反馈已开启，不自动开启反馈或执行看门狗退针。命令结束不表示扫描停止；需要停扫时执行对应工具。模拟器身份须按进程与连接检查，不能仅看端口号判断。

以下是运行／验收命令的行为索引，完整参数和前置条件以两份指南为准。只在相应任务范围内执行：

| 入口 | 实际影响 |
|---|---|
| `pnpm build:minimal` | 构建并重建专用 staging 目录；覆盖同版本 tarball 及 provenance |
| `pnpm install:minimal --target <新目录>` | 联网安装精确依赖，在仓库外创建全新目录和隔离 `DSH_HOME`；拒绝覆盖已有目录 |
| `pnpm native` / `scripts/native-session.ts` | 配置指定专用 profile 的 headless 入口，发起真实模型请求，按工具范围连接和操作模拟器，保存会话与动作记录 |
| `pnpm verify:native` / `scripts/verify-native.ts` | 不调用模型；设置 1 V / 1.5 V，验证扫描启停，恢复原偏压并写报告；不是只读探针 |
| `scripts/verify-minimal.ts values` | 启动受管模拟器；通过未注册给模型的 TCP 夹具写入两个偏压，再验证工具读回 |
| `scripts/model-minimal.ts` | 在安装态发起真实模型请求，核对工具目录、原生日志、独立读数与持久记录 |

代码或安装脚本变更后，报告验证的是源码、哪个安装产物，以及哪一种模式。保存 tarball SHA256 与构建 provenance；同名包覆盖后不能继续沿用旧包的验收结论。独立 TCP 对照、dsh 调度验证、模型会话与卸载后重读分别列结果。记录必须保留失败状态，不能用模型总结文本代替实际工具调用证据。

正常关闭与取消有各自的清理路径，按运行指南处理已知的本轮进程／连接；不按端口批量终止未知进程，不把既有用户配置作为临时验收目录。

## 变异演练

目录：[mutations.ts](../tools/mutate/mutations.ts)、[run.ts](../tools/mutate/run.ts)。条目数只表示已登记的变异数量；是否有效必须看对应运行结果。

完整入口是 CLI，会先执行所选条目的测试基线：

```text
node tools/mutate/run.ts <mutation-id> [<another-id>]
```

占位符需替换为清单中的实际 ID。省略 ID 会运行全清单，不作为普通审阅或文档修改的默认检查。此入口不需要 `MUTATE=1`。

一条变异判为 `red` 需要：

1. 开跑前，所选条目的每个 `scope` 都实际跑出测试汇总，失败数为零；否则整趟拒跑。
2. 替换串唯一命中，写回后能读到变异内容。
3. 变异后的代码构建成功；编译错误不算判据抓住了缺陷。
4. 声明范围覆盖目标文件，测试实际执行，并出现失败。

输出有 `red`、`green`、`inconclusive`、`narrow-scope` 四种；另有基线失败整趟拒跑。`green` 要调查断言是否有效，`narrow-scope` 要检查测试范围，`inconclusive` 不能算通过。历史案例见 [green-8.md](handoff/green-8.md)。

`MUTATE=1` 仅用于在 Vitest 配置中启用 `mutation` 项目。当前 [元测试](../tools/mutate/meta/mutation.test.ts) 直接调用 `runOne`，没有经过 CLI 的整趟基线检查，不能将它当作满足上述四项的等价入口。

运行器临时修改源码并重建，必须独占该工作树。正常路径和可捕获信号有还原处理，强制结束进程仍可能遗留变异；中断后核对相关 diff，恢复本轮变异，重建并重跑相关测试。不要用整树还原清掉其他改动，也不要把残留变异作为正常修复提交。

## 依赖闭包

[tip-phase-deps.test.ts](../packages/host/stm-skills/src/l0/tip-phase-deps.test.ts) 与 [对应导出器](../tools/spec-export/export_tip_phase_deps.py) 检查组合技能的传递依赖。

同时追踪 `context.run(...)` 与 `CompositeStep(skill_name=...)`，对技能依赖求闭包。动态名称、循环变量、编排引擎分发等无法静态解析的部分必须显式记录在 `closure_limits`，不能把“未解析到”写成“不存在依赖”。修改提取规则时，对两种边和无法解析的分支都保留判据。

## 并行协作与合并

先划分文件职责；共享工作树中的两个任务不要同时编辑同一文件。多个独立支线需要改共享注册表时，在分叉前约定落点：锚点之间留至少一行不被任何支线修改的内容。行距有助于降低冲突，但仍须检查实际合并结果。

共享文件常包括 `tools/mutate/mutations.ts`、`spec/deviations.md`、`spec/golden/README.md`、各包 `src/index.ts`、`scripts/gen-skill-specs.ts` 和 `tools/spec-export/export_skill_traces.py`。新增落点应交接给下一轮维护者。

- 冲突清单以 `git diff --name-only --diff-filter=U` 为准，不用合并输出尾部代替。
- 手写文件逐项理解后合并；进度与技能规格重新生成。金样冲突应从来源重导；缺少参考环境时保留为待解决事项，不手编预期值，并在重导后复查公开文本。
- 一条支线删除的过期内容，不因另一条支线仍保留而恢复。双方各自删除的内容按删除并集检查，核对语义后合并；同一概念的重复命名须统一。“两边都留”不是默认策略。
- 声称文件已入仓前用 `git ls-files` 或提交内容核实；文件存在于工作树不代表已跟踪，日志尤其如此。
- 计数结构化清单时使用其解析器，避免文本行数代替条目数。拼接脚本使用 `String.replace` 时，如替换文本应按字面插入，使用函数式替换 `() => text`，避免 `$'` 等替换串语义。

交接记录写明生成顺序、验证命令与结果、偏差编号、运行范围及剩余工作。只有实际通过的验收项才能写为完成。
