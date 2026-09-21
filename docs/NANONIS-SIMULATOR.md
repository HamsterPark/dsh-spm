# 连接已打开的 Nanonis 模拟器

本入口在 Windows 上连接已运行的 **Nanonis Mimea + Nanonis STM Simulator**，通过 dsh 原生模型会话读取偏压、电流、Z 位置和扫描状态，设置偏压，以及开始／停止扫描。它只管理自己的连接，不启动或关闭 Nanonis 应用。

如果需要插件自行启动 STM-Bench，并只向模型提供 hello 和 GetBias，请使用 [STM-Bench 指南](MINIMUM-USABLE.md)。本指南要求现成的 Nanonis 模拟环境，不要求 STM-Bench 或私有 MAST。

## 准备与安装

已记录的环境为 Windows、Node 24.14.0、pnpm 11.7.0、dsh `0.1.5-rc.2`、Cordis `4.0.2`，模拟器为 Generic 5e / RT Release 15016。Node/pnpm 要求以 [package.json](../package.json) 为准。Nanonis 软件不包含在本仓库中，需自行准备并打开其模拟器。

在 Nanonis 中启用 TCP，开放四个不同的控制端口，默认 `6501,6502,6503,6504`。入口会核验 Mimea 与 Sim-Engine 的程序路径、父子关系、启动身份、监听者及实际回环后端连接；只运行一个名字相似的进程不足以通过检查。使用期间不要另开占用同一控制端口的客户端。

从仓库根目录在 PowerShell 中运行，先将示例目录改为自己的新目录：

```powershell
$installRoot = 'D:\dsh-spm-nanonis-new' # 替换为仓库之外、尚不存在的目录
$dshHome = Join-Path $installRoot 'dsh-home'
$profileDir = Join-Path $dshHome 'profiles\minimal'
$nativePorts = '6501,6502,6503,6504'

pnpm install --frozen-lockfile
pnpm build:minimal
pnpm install:minimal --target $installRoot
```

已有符合锁文件的依赖时，无需重复第一条安装命令。构建生成 `artifacts/dsh-spm-0.0.1.tgz` 和记录输入、依赖及 SHA256 的 provenance；安装下载依赖，将包复制到仓库外，在新 `DSH_HOME` 中执行实际插件安装并核对模块身份。它拒绝覆盖已有目录，不改原有 dsh home，结果保存在 `$installRoot\install-report.json`。后续 `--install-dir` 指向安装输出的 **profile 目录**。

历史交接中的 `Start-Nanonis.cmd` 是验收机器另配的快捷方式，通用安装脚本不会生成它。其他机器使用下文的仓库脚本启动，不需要复制历史安装目录。

## 确认当前模拟器进程

查询正在运行的 Mimea，再选择本次要连接的进程 ID：

```powershell
Get-Process -Name 'Nanonis Mimea' | Select-Object Id, Path
$simulatorPid = [int](Read-Host '输入本次 Nanonis Mimea 的进程 ID')
```

不要使用交接记录中的历史 PID。每次重新打开模拟器后都重新查询；会话中的工具调用和重连会复核已绑定的进程身份。若更改了控制端口，同时更新 `$nativePorts`，并让以下两类命令使用同一组值。

## 不调用模型的功能验收

这一步通过安装产物和真实 dsh 调度器运行固定流程，可先验证连接、工具和记录，不需要密钥。它会**修改模拟器偏压并启停扫描**：

- 开始前须停止扫描并手动开启 Z controller feedback。若已有扫描或反馈未开启，验收拒绝继续，不中断原有扫描。
- 依次设置 `1 V`、`1.5 V`，与独立 TCP 读数比较，再启动向下扫描、查询并停止，用独立状态读回核对。这两个电压用于已验版本，避开其默认带隙。
- 结束时尝试停止本轮扫描、恢复原偏压，并把清理结果写入报告。原偏压超出工具可恢复的 ±10 V 范围时，拒绝开始写入。

```powershell
node scripts/verify-native.ts --install-dir $profileDir --pid $simulatorPid --ports $nativePorts --evidence "$installRoot/native-acceptance.json"
```

报告路径必须尚不存在，重复验收使用新名称。查看报告中的 `ok`、读回比较、`cleanup` 和持久记录检查，而不只看进程是否退出。电流与 Z 检查为有限值；独立 TCP 比较覆盖偏压和扫描状态。卸载后会重新打开 SQLite / JSONL 核对调用，失败与清理结果写入同一报告。

## 用自然语言操作

模型会话需要 DeepSeek 密钥，会发送真实模型请求。启动器优先读取 `DEEPSEEK_API_KEY` 环境变量；也可用 `--credential-file` 指定仅含单个密钥的文本文件，或已有的 dsh `.credentials.yaml`。对于 YAML，仅接受 `version: 1` 并读取 `refs.DEEPSEEK_API_KEY`。密钥只进入本轮 dsh 子进程的环境，不复制到新 home 或报告。

沿用之前的目录、PID 和端口变量，把凭据路径改为自己的文件：

```powershell
$credentialFile = '<单个密钥文本文件或 dsh .credentials.yaml 的路径>'

node scripts/native-session.ts --install-dir $profileDir --dsh-home $dshHome --pid $simulatorPid --ports $nativePorts --credential-file $credentialFile --prompt '读取当前偏压、电流、Z 位置和扫描状态，并报告数值及单位。'
```

若已设置环境变量，可省略 `--credential-file`。启动器要求专用的 base/headless/dsh-spm profile；缺少 headless 时会补入该 profile 的 bundle 列表，不覆盖已安装依赖。含其他 bundle 的 profile 会被拒绝。

省略 `--prompt` 进入交互命令台，输入 `exit` 退出。可输入完整指令，例如：

- `把模拟器偏压设置为 1.25 V，并读回确认。`
- `用当前扫描参数向下开始一次扫描，并查询状态。`
- `停止扫描，并确认已经停止。`

每条命令建立一个独立的原生 dsh 会话，不继承上一条的模型上下文；模拟器设置保持连续。因此需要明确写出目标值和动作。默认模型是 `deepseek-official/deepseek-flash`，默认每轮最多八次 agent 请求、120 秒。可用 `--model PROVIDER/MODEL`、`--max-requests`（1–20）、`--timeout-ms`（10000–600000）调整。

工具目录固定为 `stm_hello`、`GetBias`、`GetCurrent`、`GetZPosition`、`GetScanStatus`、`SetBias`、`StartScan`、`StopScan`。启动守卫核对目录，请求后再从原生日志核对模型路由与目录。每轮在 `$dshHome\nanonis-runs\` 下新建记录目录，保存报告、SQLite 动作、完整工具结果；原生会话保存在该 home 的 `sessions` 下，终端打印本轮位置。

## 工具行为与操作边界

偏压写入及扫描启停均回读核对；确认失败时，结果区分“命令已发送”和“状态已确认”，拒绝或断链保留失败记录。原生模式逐条执行工具及其回读，不启用自动后台轮询或看门狗退针。

`SetBias` 是立即设置，不支持 `slew_rate_v_per_s` 斜坡参数。`StartScan` 要求 Z feedback 已开启且当前未扫描，不会自动开启反馈。它保留扫描框、速度、文件名、保存模块与 autosave 设置；若 Continuous scan 开启，会关闭并核对该设置，再启动一次扫描。连续扫描关闭后不会自动恢复。工具结果会报告这些限制；确认 running/stopped 不表示已经取得或导出完整图像。

## 退出与重启

命令台输入 `exit` 只退出命令台。每条命令结束会断开本轮 TCP、关闭记录句柄，不关闭 Nanonis 模拟器，也不自动停止扫描。需要停扫时先发出明确的停止命令。模拟器重启后重新查询 PID，再使用原安装目录；已有记录继续保留。

运行中按 `Ctrl+C` 或达到会话超时，会请求 dsh 禁止新的仪器请求、断开 TCP 后退出。协作退出若在 30 秒内未完成，启动器保留 dsh 进程并报告 PID，供检查连接和记录状态；不会强制终止可能仍在传输的连接。此时不能把退出报告解释成扫描停止或记录已完整关闭。

## 已记录的验收范围

2026-09-21 的记录绑定 SHA256 **`b5a7ab1a088ea91cc6b504a6f67763287898e46fb996790ef58f37f0bd2c081b`**：安装态验证通过，真实模型发起 7 次请求、9 次工具调用，覆盖七个 STM 工具；hello 在目录中，未在该模型流程中调用。模型会话、工具结果、SQLite 和 JSONL 按调用 ID 关联。详见 [实施交接](handoff/native-nanonis-20260921.md) 和 [结构化结果](handoff/native-nanonis-20260921.json)。

这些记录对应当时的 Windows 与 Generic 5e / RT Release 15016。它们不证明其他 Nanonis 版本、跨平台、完整图像采集／导出、专用 STM 前端、npm 发布或真实仪器行为。原始会话和数据库路径属于验收机器；仓库保存摘要及关联结果。

受管 STM-Bench 的双 home 验收属于此前 `8c510e…` 包，不扩展到这里的 `b5a7ab…` 包。重新构建即使沿用同一 tarball 文件名，也应按新哈希记录自己的验收结果。
