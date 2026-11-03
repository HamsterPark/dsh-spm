# 受管 STM-Bench 入口重验收交接

本轮在 dsh 升到 `0.2.1-rc.5`、参考系统追赶完成之后，对受管 STM-Bench 入口做一次重验收：2026-11-01 构建并安装，2026-11-02 完成非模型验收、真实模型会话和源码集成测试对照（Asia/Shanghai）。范围与 [2026-09-21 的受管入口记录](minimum-usable-20260921.md)相同：独立安装、`stm_hello` 与只读 `GetBias`、受管模拟器及持久证据；操作入口见[使用指南](../MINIMUM-USABLE.md)。结构化结果见[安装与调度结果](minimal-acceptance-20261102.json)和[模型结果](minimal-model-20261102.json)。Nanonis 原生入口不在本记录内，其新包尚未重做验收。

## 基线与来源

- 构建提交：`6030b9a49cfa76f5cc3dd642775a760c60adb878`，工作树干净（provenance 记 `dirty: false`，`git.head` 与该提交一致）。同一提交的 CI 四格（Windows／Ubuntu × Node 22.19／24）全部通过，各为 190 文件／8812 项。
- 产物：`artifacts/dsh-spm-0.0.1.tgz`，SHA256 `b8f7b39a926ee1310a09786ee82c9a5f0314e1c985f30544b8d25cda8b7fb79e`。相邻 provenance 文件保存 304 个构建输入的 SHA256（297 个工作区编译产物、7 个 bundle 源文件）和四个精确外部依赖：`dsh-tools`、`dsh-system-prompt`、`dsh-host-webserver` 为 `0.2.1-rc.5`，`cordis` 为 `4.0.5`。
- 安装：这个包复制到仓库之外后装进三个新目录，`install-report` 里的 `copiedArtifactSha256` 三份都等于上面的哈希。两个目录（home A、home B）属于本记录，第三个属于 Nanonis 入口。整轮没有重建过包，本记录的每个结果都只对应这一个 SHA256；同名 tarball 重建后字节可能不同，不能互换。
- master 与受验收包：构建提交之后 master 前进到 `879a6cd4a70b11ce8e83ea3533a366ad13c23ac8`，共 8 个提交、10 个文件：一个 CI 工作流、`AGENTS.md`、三份文档、`spec/deviations.md` 和四个集成测试文件，没有一个是包的输入。逐一核对 provenance 的 304 个输入：在 master 提交上强制完整重编译后，每个输入文件的字节 SHA256 都与 provenance 记录一致（304/304）；7 个被跟踪的源文件在两个提交里是同一个 git blob，297 个编译产物对应的源文件也相同；补丁 yml、bundle 的 `package.json`、构建脚本及其本地 import、根 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 同样没变。所以 **master 构建出的包与受验收包输入相同**。这是对输入的核对，没有重新打包去比较 tarball 字节；之后重建的包仍须记录自己的 SHA256。
- 平台：Windows 11（build 26100）x64，Node `24.14.0`，pnpm `11.7.0`，vitest `4.1.11`，dsh `0.2.1-rc.5`，Cordis `4.0.5`。Cordis 系九个包的实际版本逐项等于钉版。
- 外部模拟器：Python `3.13.13`，numpy `2.4.4`，scipy `1.17.1`，pyyaml `6.0.3`。STM-Bench 用了三个提交：
  - `5a21f19537df97aef9b37c86fdbd7da54353e07f`（公开根提交，目录树 `bff925edf83f1d6714cceea107791ee4cb9dc5b9`，与 09-21 首验的本地提交相同）：非模型验收和两次模型会话；
  - `cfd042949df6e436bdff944ab981935f43729e35`（公开 main 在 2026-11-02 的头部，也是 CI integration job 钉的提交）：一次 `values` 和一次模型会话；
  - `4a0014b640b41cbf4dfdf68dbd34631ff71b1691`：只用于源码集成测试的对照，没有做过模型会话。

  三个克隆在每次运行前后的 `git status --porcelain --ignored` 均为空。
- 模型：`deepseek-official/deepseek-flash`。隐私默认：验收 overlay（`scripts/acceptance-overlay.ts`）关闭 19 个工具与辅助行（含自动标题请求）和会话日志上传，共 20 个组合行；子进程环境为 `DSH_TELEMETRY_DISABLED=1`、`DSH_TOOLS_MODE=native`，`DSH_AGENTS_HOME` 指向本轮的空目录。每轮的 overlay 都用 `--patch … --dump-config` 复核过：这 20 个 id 在组合树里各恰出现一次且已关闭，stderr 为空。
- 隔离：启动 dsh 或仓库脚本的命令，都在把用户目录、agents 目录和临时目录重定向到暂存位置的环境里执行。

## 本轮执行结果

「记录」列指向结构化结果：`A` 是 [minimal-acceptance-20261102.json](minimal-acceptance-20261102.json)，`M` 是 [minimal-model-20261102.json](minimal-model-20261102.json)。

| 检查 | 结果 | 范围 | 记录 |
|---|---|---|---|
| 构建与单元／契约测试 | `pnpm build` 通过；`pnpm test --project unit --project contract` 190 文件／8812 项通过 | 构建提交，Node 24.14.0，2026-11-01；同一提交的 CI 四格各 190 文件／8812 项 | `A.m0` |
| 同一构建在 Node 22.19.0 上运行测试 | 190 文件／8812 项通过 | 构建仍由 Node 24 完成，这一步只检验运行时 | `A.m0.unitContract` |
| 生成物、卫生门、上游版本 | 五个生成器的 `--check` 无漂移；`scripts/release-hygiene.ts` 扫描 813 个文件，0 发现（只跑通用规则，未设站点名单）；`check:dsh-latest`：锁定的 `0.2.1-rc.5` 即 latest／next | 构建提交 | `A.m0` |
| `pnpm build:minimal` | 通过；暂存分发包过卫生门；tgz 恰含预期的四个文件 | 单个 tarball，内部 workspace 代码打入，dsh／Cordis 精确外置 | `A.artifact` |
| 安装（三个新目录，同一副本） | 每份 `dshVersion` 为 `0.2.1-rc.5`，296 个 dsh 包同版本；每个 `@deepseek-ai/*` 包恰一个版本，与仓库钉版逐项对照 36 项一致；宿主与插件解析到同一份 `cordis`、`dsh-tools`、`dsh-system-prompt`、`dsh-host-webserver` | 2026-11-01；home B 的首次安装失败，见下 | `A.m1` |
| 激活断言 | `scripts/probe-compose.ts`：`mast-minimal-hello` 与 `mast-minimal-runtime` 进入组合树，stderr 为空，无版本豁免，三份安装均通过。2026-11-02 用修正后的复核脚本对三份重新 `--dump-config`，结果相同 | 只看组合树，不启动 profile | `A.m1.activationProbe` |
| 非模型验收：home A | `values`、`failure`、`inspect` 三步退出码 0。独立 TCP 夹具写入 `0.125 V`、`-0.375 V` 再读回，与工具读数一致（误差 0）；每次成功恰有一次成功的 main `Bias_Get`；断链后 `GetBias` 返回含 `managed_simulator_stopped` 的失败文本，SQLite 与 JSONL 保留同一调用 ID；新进程重开记录可读 | STM-Bench `5a21f19`，端口 16611–16614，三步共用一组 SQLite／JSONL | `A.homeA` |
| 非模型验收：home B | `values` 退出码 0，读数与判据同上 | `5a21f19`，端口 16631–16634 | `A.homeB` |
| 补充：home B 对较新的模拟器 | `values` 退出码 0，读数与判据同上 | `cfd0429`，端口 16651–16654；驱动脚本取自 `a085624`（与构建提交只差四个集成测试文件） | `A.homeB.valuesOnCfd0429` |
| 真实模型会话 ×3 | 每次 `stm_hello` 一次、`GetBias` 一次，读数 `0.10000000149011612 V`，与独立 `Bias.Get` 完全相同；SQLite 动作 `GetBias`／`succeeded`；仪器调用轨迹恰一次 `Bias_Get`；退出后重开会话日志；自动标题请求 0。请求数 2／2／3，共 7；上游记录的 token 合计 4779（输入 1851、输出 496、缓存读 2432）；会话耗时合计 47.3 s | home A 对 `5a21f19`；home B 对 `5a21f19` 和 `cfd0429` 各一次；工具目录恰为 `GetBias`、`stm_hello`；驱动脚本取自 master 提交 | `M.runs`、`A.m4` |
| 源码集成测试对照 | 修复前，三个 STM-Bench 提交结果相同：22 文件／118 项，116 通过、同一组 2 项失败，两项都出在测试侧，见下。修复后三个提交各 23 文件／122 项全部通过 | Windows，本机；修复前用构建提交的测试代码，修复后用 `a085624` | `A.stmBench.integration` |
| CI 的 integration job | 在 `879a6cd` 上通过：23 文件／122 项；同次运行的四个 build 格也通过 | Ubuntu，Python 3.13，numpy 2.4.4／scipy 1.17.1／pyyaml 6.0.3，STM-Bench `cfd0429`；不是必需检查，Windows 未加 | `A.stmBench.integration.ci` |
| 运行后检查 | 各端口段无监听，无 stmsim 残留进程；三个 STM-Bench 克隆干净；在各 home、证据目录、隔离目录和三份压缩会话日志里扫描，没有发现 API 密钥 | 每次运行之后 | |

两项集成测试失败的原因，以及修复：

- `lockin.test.ts` 用来探测 `NeedModule` 的两个命令不在公开模拟器的命令表里，模拟器答 `Command not recognized`；命令表文件在三个提交上完全相同。单独重跑两次，信息一致；更早的公开提交 `44516c8` 对 `5a21f19` 同样红。修复为改探命令表里有、对应模块未加载的命令，断言保持不变。
- `budgeted-call.test.ts` 依赖运行顺序：看门狗用例撤回针尖后不恢复，按文件大小排序它最后运行，遇到无隧道结的响应而不是睡眠约 4 s。单独运行是绿的，看门狗加它两个文件一起复现红。修复为看门狗用例恢复 Z 反馈并等电流回到设定值，预算用例自己建立隧道结；`Timeout` 断言不变。
- 另新增 `stmsim-files.test.ts`（4 项）：解析并归档模拟器写出的 `.sxm`／`.dat`，三个提交上都绿；注入 3 处缺陷各被检出。每个提交各取一份模拟器写出的 `.sxm` 和 `.dat`，分别用模拟器自带的 Python 读取器和本仓的读取器读出，比较结果没有差异。
- 以上修复只动测试，三个提交都在 master 的历史里（`86fdadb`、`47a90b2`、`a085624`）。

## 失败与重试

- **home B 的首次安装**：下载依赖时连接被重置，脚本退出码非 0；换一个新目录重装一次，通过。包没有变。
- **后检脚本的一处断言错误**：对 home A 的 `failure` 证据，首轮外部检查红 1 项，断言要求断链后的工具结果带错误标志。dsh 工具适配器把领域失败作为成功的工具结果返回（`isError` 为 false，文本以 `[GetBias] failed:` 开头），这是 [D-VMEM-5](../../spec/deviations.md#d-vmem-5--领域失败是成功的工具结果)的既定行为。错的是检查脚本，不是产品。修正断言后在没有改动的证据上重检，四份证据全部通过；验收脚本 `scripts/verify-minimal.ts` 的退出码始终为 0。
- **激活复核脚本**：外部的复核脚本最初在 pnpm 布局下找不到 YAML 解析库，无法运行，属脚本缺陷。修正查找路径后，对三份安装重做复核，通过。安装态激活本身由 `scripts/probe-compose.ts` 先行断言过，不受影响。
- **源码集成测试**：首轮全量红 2 项（见上）。按分类（测试与公开模拟器不匹配、测试间状态泄漏）修复，没有改断言强度；修复后在三个提交上各整轮重跑，全部通过。`cfd0429` 上另按保留缓存的文件顺序（与清缓存时不同）再跑一轮，同样全绿。
- **模型会话**：三次都一次通过，没有重试，没有红。

## 限制

- 仅 Windows 与所列版本；模拟器不是真机，本轮没有连接任何真实仪器。
- 工具范围仅为 `stm_hello` 与只读 `GetBias`；写入夹具只存在于独立的 TCP 验证里，不注册为模型工具。
- integration 通过只表示源码集成测试在该模拟器提交上通过，不等于在 `4a0014b` 上做过模型会话。模型会话只在 `5a21f19`（两次）和 `cfd0429`（一次）上做过，不外推到其他提交，包括之后的 STM-Bench main。
- CI 的 integration job 只在 Ubuntu 上运行源码集成测试，不是安装态或模型验收。
- 未验证 Linux／macOS 上的安装态、完整客户端、完整图像采集与导出、npm 公开发布和真实仪器。
- 视觉线束仍没有真实模型验收；本轮的受管模型会话不挂视觉线束。
- Nanonis 原生入口不在本记录内，它的新包验收另记。
