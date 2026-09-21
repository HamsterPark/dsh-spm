# STM-Bench：安装最小运行版本

选择本指南，可由插件启动本地 STM-Bench 模拟器，再通过 dsh 原生模型会话调用 `stm_hello` 和只读技能 `GetBias`。插件管理模拟器的启动与关闭，不加载专用 STM 前端，也不开放完整技能表。

如果你已打开 **Nanonis Mimea + Nanonis STM Simulator**，并希望读取状态、设置偏压或启停扫描，请使用 [Nanonis 模拟器指南](NANONIS-SIMULATOR.md)。两个入口使用同一最小分发机制，但连接配置、工具目录和进程生命周期不同。

## 准备环境

以下步骤从仓库根目录在 PowerShell 中执行，建议先完成无模型验收，再运行需要密钥的模型验收。

- Node 与 pnpm 版本要求见 [package.json](../package.json)。记录中的 Windows 环境为 Node 24.14.0、pnpm 11.7.0；安装脚本固定使用 dsh `0.1.5-rc.2` 和 Cordis `4.0.2`。
- 另行准备 STM-Bench 源码及已安装其依赖的 Python 解释器；两者不包含在本仓库中。需要解释器的绝对路径，以及包含 `stmsim` 包的 STM-Bench 根目录。本指南的模型验收使用 `reference-stm` 配置。
- 选择一个仓库之外、尚不存在的安装目录，以及四个未被占用的本地端口。下文目录是示例，先替换为自己的位置；不要在同一组端口上并行运行两轮验收。
- 无需安装私有 MAST。构建和安装需要下载依赖；模型验收会发送真实模型请求，需要自行提供 DeepSeek 密钥。

历史首验使用 Python 3.13.13、STM-Bench 提交 `9e1acb3a9bb95188c53edfcd108050369fd44a3f` 的 `reference-stm` 配置。其他版本的兼容性应以实际验收结果为准。

## 构建并安装到新目录

```powershell
$installRoot = 'D:\dsh-spm-minimal' # 替换为仓库之外、尚不存在的目录
$dshHome = Join-Path $installRoot 'dsh-home'
$profileDir = Join-Path $dshHome 'profiles\minimal'

pnpm install --frozen-lockfile
pnpm build:minimal
pnpm install:minimal --target $installRoot
```

已有符合锁文件的依赖时，无需重复第一条安装命令。`build:minimal` 先构建源码，再将内部 workspace 代码打入 `artifacts/dsh-spm-0.0.1.tgz`；相邻 `.provenance.json` 记录包 SHA256、构建输入哈希、提交、工作树状态和精确外部依赖。无需先公开发布内部包。

`install:minimal` 拒绝覆盖已有目录。它将 tarball 复制到新目录，安装精确锁版的 dsh 依赖闭包，在隔离的 `DSH_HOME` 中执行实际 `dsh plugin add`，并检查宿主与插件解析到相同的关键外部模块。成功后输出 profile 路径，并在安装根目录保存 `install-report.json`。以下 `--install-dir` 都指向这个 **profile 目录**，不是安装根目录。

构建不会自动重现历史验收。同名 tarball 可以包含不同代码，应使用本次 SHA256 与安装报告对应结果。

## 先验证模拟器与持久记录

沿用上面的目录变量，填写自己的 Python 和模拟器路径：

```powershell
$pythonPath = '<可用 python.exe 的绝对路径>'
$simulatorRoot = '<包含 stmsim 包的 STM-Bench 根目录>'
$recordsPath = Join-Path $profileDir 'acceptance.sqlite'
$resultsPath = Join-Path $profileDir 'acceptance-results.jsonl'

node scripts/verify-minimal.ts values --install-dir $profileDir --dsh-home $dshHome --python $pythonPath --simulator-root $simulatorRoot --ports 16611,16612,16613,16614 --records $recordsPath --results $resultsPath --evidence "$profileDir/values.json"
node scripts/verify-minimal.ts failure --install-dir $profileDir --dsh-home $dshHome --python $pythonPath --simulator-root $simulatorRoot --ports 16611,16612,16613,16614 --records $recordsPath --results $resultsPath --evidence "$profileDir/failure.json"
node scripts/verify-minimal.ts inspect --install-dir $profileDir --dsh-home $dshHome --records $recordsPath --results $resultsPath --evidence "$profileDir/restart.json"
```

按顺序执行，并检查每条命令的退出结果和报告。每个 `--evidence` 路径须尚不存在；重复验收请使用新文件名。三步使用同一组 SQLite 和 JSONL 文件：

| 步骤 | 实际操作与判据 |
|---|---|
| `values` | 启动本轮模拟器，通过安装包和真实 dsh 工具调度器调用 hello / GetBias。独立 TCP 夹具将偏压设为 `0.125 V`、`-0.375 V`，再读回并与工具结果比较；该写入夹具不注册为模型工具。 |
| `failure` | 启动后停止本轮模拟器，再调用 GetBias，检查断链返回失败且失败记录落盘。 |
| `inspect` | 在新进程中重新打开已有 SQLite / JSONL，检查持久结果；此步不启动模拟器。 |

这些步骤不调用模型。模拟器源码保持只读，运行和输出放在独立临时目录；插件核验本轮进程及端口归属，不接管未知监听者。脚本通过 `--python` / `--simulator-root` 显式传入配置；直接配置受管插件或运行源码集成测试时，对应环境变量为 `STMSIM_PYTHON` / `STMSIM_ROOT`。

## 再验证真实模型会话

准备一个仅含单个密钥、无额外行的本地文本文件。`model-minimal.ts` 的 `--credential-file` **不解析 dsh YAML 凭据文件**；它只把这个密钥传入本轮 dsh 子进程的环境，不复制到 profile 或报告。

先在这次新安装的 profile 中加入 dsh 自带的一次性会话入口。下面只更新 bundle 列表，保留已安装的插件依赖：

```powershell
$profileFile = Join-Path $profileDir 'package.json'
$profileConfig = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json
$profileConfig.dsh.profile.bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-spm')
[System.IO.File]::WriteAllText($profileFile, ($profileConfig | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))

node scripts/model-minimal.ts --install-dir $profileDir --dsh-home $dshHome --profile minimal --credential-file '<只含 DeepSeek 密钥的本地文件>' --model deepseek-official/deepseek-flash --python $pythonPath --simulator-root $simulatorRoot --ports 16711,16712,16713,16714 --evidence "$dshHome/model-evidence.json"
```

`--evidence` 必须位于指定 home 内，重复验收使用新文件名。该脚本启动安装版 dsh，要求模型各调用一次 hello 和 GetBias。验收配置将工具目录限定为这两个工具，关闭自动重试及自动标题请求；默认最多四次 agent 请求、120 秒，可用 `--max-requests` / `--timeout-ms` 调整。

退出后，脚本重新读取原生会话（包括 `.jsonl.zstd`）、SQLite 和 JSONL，核对实际工具调用与结果、请求模型、独立 TCP 偏压和本地记录。模型文字中声称“已调用”不作为验收依据。需要验证重复安装时，在第二个尚不存在的目录重做构建产物安装、非模型验收和模型验收，并分别保留报告。

## 记录、退出与清理

SQLite 的 `actions.tool_call_id` 对应 JSONL 的 `toolCallId`。JSONL 保存完整 `bias_v` 和该技能实际产生的 `instrumentCalls`；后台状态轮询和看门狗请求不混入工具调用轨迹。成功文本显示 `GetBias: <数值> V`，与通用适配器的差异见 [D-MINIMAL-1](../spec/deviations.md#d-minimal-1--最小运行入口把-getbias-ok-补成带数值与单位的工具结果)。

正常关闭会注销工具、等待在途调用完成记录、关闭 SQLite/TCP，并停止本轮受管模拟器。Windows 按所启动的进程树清理，记录写失败会返回可观察错误。模型验收超时会终止本轮 dsh 进程树；强制退出不应被当作正常关闭或完整落盘成功，检查失败报告及端口状态后再重试。

报告、数据库和安装目录不会自动删除。如需清理，先退出使用该 profile 的会话，确认本轮端口已释放，再删除核实过的安装目录；不要按端口批量终止未知进程。

## 已记录的验收范围

2026-09-21 的受管入口记录绑定包 SHA256 **`8c510e26598495385a20f8f0983310570a03328c5baa0c8c7a45e7db68b0735b`**：两个独立 Windows home 完成安装及真实模型读取；独立调度器另测偏压变化、断链失败和重开记录。详见 [实施交接](handoff/minimum-usable-20260921.md)、[安装与调度结果](handoff/minimal-acceptance-20260921.json) 和 [模型结果](handoff/minimal-model-20260921.json)。

后续 Nanonis 原生入口使用另一个哈希为 `b5a7ab…` 的同名包；它的结果见另一份指南，不能与本次双 home 记录互换。原始会话和数据库路径指向验收机器，仓库保存的是摘要及关联结果。Windows 的这些结果不扩展为 Linux/macOS、完整客户端、npm 公开发布或真实仪器验收。

源码集成测试另由 [开发指南](DEVELOPMENT.md) 说明；其 `STMSIM_PROFILE` 可选择外部模拟器配置，默认 `reference-stm`。本入口的设计范围见 [第一版计划](MINIMUM-USABLE-PLAN.md)。
