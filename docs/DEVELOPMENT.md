# 开发与验证

本文件承接根目录 [AGENTS.md](../AGENTS.md) 的工作约定，供修改代码、迁移技能和维护验证工具时使用。只读评审可从 [Review guide](REVIEW-GUIDE.md) 开始。

## 开工与改动范围

1. 查看 `git status --short` 及相关 diff，保留工作树中的已有改动。
2. 找到改动对应的实现、测试、金样与偏差记录，明确此次验收命令。阅读 [EXECUTION.md](EXECUTION.md) 和相关交接记录了解历史，但当前行为须回到代码核查。
3. 修改代码前确认根目录 `package.json` 的运行环境和 pnpm 固定版本。构建使用 `pnpm build`；根目录持有构建脚本，不用 `pnpm -r build` 代替。换过依赖（尤其是 dsh 升级）之后，先 `pnpm clean` 再 `pnpm build`：增量 `tsc -b` 可能不会对着新的类型重检。
4. 依赖维护或 dsh 升级任务运行 `pnpm check:dsh-latest`。当前策略取 `latest` / `next` 中较大的版本作为升级候选；`alpha` 只读发布说明、记影响，不自动升级。钉版表由 `pnpm gen:dsh-pins` 从锁文件生成（`--check` 只比对不改写）；装好的 profile 是否真的带上了 `dsh-spm`，用 `pnpm probe:compose` 判定，不看退出码。精确锁版与接触面事实见 [facts.md](dsh/facts.md) 和 [upgrades.md](dsh/upgrades.md)。只读审阅和文档修改不因此扩大为升级任务。

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

MAST 专用导出器需要私有参考实现和适配的 Python 环境，不属于公开仓库的基本构建／单测前置条件。并非所有导出器都有此依赖，例如 `export_numerics.py` 使用 NumPy、SciPy 和 scikit-image，无需 MAST。先检查实际脚本入口及依赖：`MAST_ROOT` 必须设置为包含 `mast/` 包的只读源码目录（可能是参考项目的 `MASTv2/` 子目录）；涉及 STM-Bench 的导出器另需将 `STMSIM_ROOT` 设置为包含 `stmsim/` 的目录；视觉记忆导出器 `export_visual_memory.py` 需将 `VISTA_SPM_ROOT` 设置为包含 `vista_spm/` 的 VISTA-SPM 源码目录，并自 2026-10-12 起（谱）将 `MAST_ROOT` 设置为包含 `mast/` 的目录：参考实现经 MAST 的 `read_dat` 读 `.dat`，导出器只导入 `mast/io/nanonis_files.py` 及其上两级 `__init__`，仅需 NumPy，另需 matplotlib（参考实现用它画谱图，图像尺寸进入标签）；测量工具导出器 `export_measure_profile.py` 同样读 `VISTA_SPM_ROOT`、也需 matplotlib（参考实现用它画剖面图，金样只记图的尺寸），不需 `MAST_ROOT`。缺少变量或指向非目录时，入口明确报错。它们与隔离运行目录 `MAST2_PROJECT_ROOT` 用途不同；文档中的 `<MAST_ROOT>` 是占位符，不是可直接执行的路径。

- **统一入口**：`tools/spec-export/run_export.py run --rev <标签或提交号>`，用带 NumPy 与 SciPy 的 Python 环境启动（`<python> -B tools/spec-export/run_export.py …`）。它用 `git archive` 取参考仓该修订的快照，逐个 blob 与提交核对，不读工作树；在公开仓之外的暂存区运行全部 MAST 通道导出器（调用 `require_mast_root()`、不需要 STM-Bench 或 VISTA-SPM 的那些），产物留在暂存区，不写 `spec/golden`。需要环境变量 `MAST_REPO`（参考仓的 git 目录）与 `SPEC_EXPORT_STAGE`（暂存目录：短路径、不含用户名，不在任一仓内）。`--rev` 只接受标签或提交号；`--only` 只用于调试，部分运行的产物不得提升进仓。`compare <A> <B>` 逐字节比较两个金样目录。
- **隔离由入口负责**：参考仓保持只读，入口对它只读对象库，导出器只看得见快照。每个导出器单独的 `MAST2_PROJECT_ROOT` 与 `TEMP`，一律原生路径写法（Windows 上写成正斜杠会让导出器的 `<project-root>` 替换静默失效）；清除 `PYTHON*` 与参考源码变量，`-B` 与 `PYTHONDONTWRITEBYTECODE=1`，单个导出器限时。导出器在导入 MAST 前调用 `_paths.isolated_project_root(tempfile.mkdtemp(...))`，入口预设的目录因此优先。`MAST2_PROJECT_ROOT` 为空串（参考实现会退回它自己的树，导出器清断点时删的正是那里的文件），或落在参考检出／快照之内（`MAST_ROOT` 的上一级、`MAST_REPO`）时，`import _paths` 那一刻即以状态 1 退出，什么都不碰；单独运行导出器时也一样。运行前后比对参考仓 `MASTv2/` 下的文件（出现新文件算失败；已有文件的变化只告警，`--strict-mast` 下也算失败），运行后再核一遍快照；产物里扫描暂存路径、参考仓路径与用户目录。单独运行其余导出器时（`export_visual_memory.py` 也读 `MAST_ROOT`），同样设置 `PYTHONDONTWRITEBYTECODE=1`，并检查参考目录没有新写入的文件，包括被忽略的配置与数据目录。导出器需要给参考实现的配置目录写文件时（`export_batch5b.py` 的 `motor_group/*` 格写接线配置文件），一律经 `_paths.ProjectConfigFile`：每次写或删之前先证明目标在隔离的 `MAST2_PROJECT_ROOT` 里、该根不在参考树里，且只删自己写的那份，否则非零退出、什么都不碰（`tools/spec-export/tests/test_project_config_file.py`）。
- **来源记录**：`manifest.json` 的 `reference` 记录被导出的提交（完整 SHA）、标签、`MASTv2/` 的树对象号、与行尾无关的源码摘要，以及 Python、NumPy 与 SciPy 版本。
- JSON 序列化使用 `allow_nan=False`、`sort_keys=True` 和 LF。`--repeat 2` 把同条件的两次导出逐字节比较。
- **公开文本覆盖层**：重导的原始产物不得直接进入本仓。`tools/spec-export/spec_overlay.py apply` 按一份仓外的覆盖层数据（`SPEC_OVERLAY` 指向）把已审读过的公开文本替换回去：每条记录以（文件、JSON 指针、原文 SHA-256）定位，原文哈希对不上、原文出现在没登记的位置都会失败，交人工复核，失败时不写任何输出；覆盖层数据本身不入仓。`apply` 会在 `manifest.json` 写入 `public_text` 记录，供检查发现「未经覆盖层就提交了原始导出」。已入仓的金样是覆盖层的不动点，由 `verify` 检查；`build` 由原始产物与审读过的公开版本求覆盖层。工具输出只含位置、哈希前缀与长度，`show` 除外（它打印原文，只供人工复核）。
- 私有源码、实验数据与凭据不进入本仓。已获准保留的派生规格／夹具仍需检查公开内容和来源，见 [SOURCES.md](SOURCES.md) 与 [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md)。

**公开文本的例外**：说明字段、匿名测试标签及已登记的标识符可以按公开内容审查的明确范围同步调整；这不授权改动数值、二进制载荷或真实来源类别。涉及可观察标识符的变化须记录兼容影响并验证相关契约。此类公开版本不能再声称所有说明字段都与私有原始导出逐字节一致。后续重导可能恢复私密文本，必须再次审查。

### 发布卫生门

契约测试 [release-hygiene.test.ts](../packages/bundle/dsh-spm/contract/release-hygiene.test.ts) 在 `pnpm test --project contract` 中扫描 `git ls-files` 的文本文件（含未跟踪、未忽略的新文件）与全部 `spec/golden`；`pnpm build:minimal` 在打包前扫描暂存的四个分发文件，并核对 tgz 里恰好是这四个。规则与命令行在 [scripts/release-hygiene.ts](../scripts/release-hygiene.ts)。

- **通用规则入仓**：私有网段地址（网段记法放行）、用户目录路径（正反斜杠与转义写法都算）、疑似密钥、开发过程痕迹；金样里另拦任何盘符绝对路径，带 `reference` 的 `manifest.json` 必须有覆盖层写入的 `public_text` 标记。命中报文件与行号或 JSON 指针；密钥只报前 4 位与长度。
- **站点身份名单不入仓**：由环境变量 `HYGIENE_SITE_LIST`（或 `--site-list`）指向的 UTF-8 文本文件提供，缺省时只跑通用规则，CI 就是这样。每行一条：`#` 开头为注释，`re:` 开头为不分大小写的正则，其余为不分大小写的子串（至少 4 个字符）；文件读不了、没有条目或条目太宽都报错。命中只报 `文件:位置 [site#序号]`，不回显名单内容。整段是 base64 的 JSON 字符串值（金样里的二进制载荷）不按名单扫，通用规则照扫。
- **放行只有三种**：规则自带的占位名与网段记法；合成路径登记簿 `SYNTHETIC_ROOTS`，只收导出器自己合成的夹具路径，写明生成它的文件与行，过期项会让测试变红；分发包的 `DISTRIBUTION_EXEMPTIONS`，确认是第三方内联文本时按文件与匹配文本登记。重导带来的新路径不是夹具，走公开文本覆盖层改写。不要为了转绿放宽规则或添加登记。
- **手动运行**：`node scripts/release-hygiene.ts --tree .`；重导时，复制进 `spec/golden` 之前先扫暂存的公开目录：`node scripts/release-hygiene.ts --golden-dir <暂存公开目录>`。有命中退出码为 1，参数或配置错误为 2。

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
| `pnpm native` / `scripts/native-session.ts` | 配置指定专用 profile 的 headless 入口，发起真实模型请求，按工具范围连接和操作模拟器，保存会话与动作记录；`--visual --save-dir` 另挂视觉线束，帧与笔记写入视觉记忆目录 |
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

每一趟（基线与变异）都排除规则体检 [mutation-registry.test.ts](../packages/bundle/dsh-spm/contract/mutation-registry.test.ts)：它数的是每条规则的替换串在文件里命中几次，任何一条变异落地它都必然变红，与被变异的判据有没有人看无关；它在默认契约套件里照常运行。不排除的话，scope 落在 `packages/bundle/dsh-spm` 的规则按构造永远判 `red`。

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
