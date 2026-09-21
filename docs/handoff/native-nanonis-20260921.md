# 本机 Nanonis 模拟器最小可用交接

2026-09-21（Windows / Asia/Shanghai）。用户明确要求读取状态、设置偏压、启动和停止扫描。已在原本打开的 Nanonis Mimea + Nanonis STM Simulator 上完成安装态及真实模型验收。结构化结果见 [运行证据](native-nanonis-20260921.json)，一般操作见 [本机模拟器指南](../NANONIS-SIMULATOR.md)。

## 交付与代码

- 可用安装目录：`D:\dsh-spm-nanonis`，双击 `Start-Nanonis.cmd` 启动自然语言命令台。它自动查询当前唯一 Mimea PID，由插件继续核验实际模拟后端；每次模拟器重启无需手改 PID。
- 隔离的 `dsh-home` 和安装包均位于上述目录。启动器只保存用户指定凭据文件的路径，密钥只在启动时读取到环境，不复制密钥正文。每条命令是一个独立、持久保存的原生 dsh 会话。
- 最小运行层新增显式 `nativeSimulator` 分支；原有受管 STM-Bench 入口保留。固定工具名单为 GetBias / GetCurrent / GetZPosition / GetScanStatus / SetBias / StartScan / StopScan，加上 hello 自检。
- 核验 Mimea 与其 Sim-Engine 的程序路径、父子关系、启动时间、四个 TCP 监听者，以及三个实际回环后端连接。每个工具及重连前重新核验。仅关闭插件的连接，不终止外部应用。
- 写入后回读、串行执行整条工具、取消后拒绝后续仪器请求、SQLite 与 JSONL 同一调用 ID 关联。原生模式不自动后台轮询或退针；扫描参数与保存设置保持，必要时仅关闭 Continuous scan。局部契约变更见 D-NATIVE-1。
- 新增自然语言启动器、安装态验收脚本、保持单个连接的独立读数探针；修复构建检查将 `createLink:` 误报为 `link:` 依赖的边界。

## 实际执行证据

起点提交 `22f655b6ca27e54d2fac3fb337044f9636725406`，保留已有大量未提交修改；本轮未创建提交、未重导金样或改迁移进度。最终包 SHA256 为 `b5a7ab1a088ea91cc6b504a6f67763287898e46fb996790ef58f37f0bd2c081b`，构建输入另存于产物 provenance。

环境为 Node 24.14.0、pnpm 11.7.0、dsh 0.1.5-rc.2、Cordis 4.0.2。模拟器是当前用户已打开的 Generic 5e / RT Release 15016，Mimea PID 13676、Sim-Engine PID 49832，TCP 6501–6504。

| 检查 | 结果与范围 |
|---|---|
| `pnpm build:minimal`、独立安装 | 通过；最终安装在 `D:\dsh-spm-nanonis` |
| 全仓 unit + contract | 127 文件、7512 项通过；此轮早于最终取消保护补丁 |
| 最终 bundle 定向 unit + contract | 9 文件、66 项通过；覆盖最终取消保护、身份、回读、持久化和构建引用检查 |
| 新独立 TCP 探针 contract | 1 文件、3 项通过；覆盖单连接多次读取、分片、超时 FIN、错误回声 |
| 原生模拟器安装态 | 所有读数有效；1 V、1.5 V 与独立 TCP 相符；起扫 running、停扫 stopped；恢复原偏压 2 V；卸载后 SQLite 可重开 |
| 真实模型完整流程 | `deepseek-official/deepseek-flash`，7 次请求、9 次实际工具调用；1.25 V 回读、向下起扫、状态查询、停扫、恢复 2 V 全部成功 |
| 原生会话关联 | 9 次 tool/call、9 次 tool/result、9 条本地结果和 9 条 SQLite 动作逐次关联，无缺失；实际请求的模型与工具目录核对通过 |
| 退出后独立检查 | Bias=2 V、Scan.Status=0、ZCtrl.OnOff=1；扫描框、速度和 Scan.Props 与开始时一致；四个控制端口无遗留客户端，两个原始模拟器进程均存活 |

原始安装态证据：`D:\dsh-spm-nanonis\native-acceptance-final.json`。原始模型证据和本次数据库：`D:\dsh-spm-nanonis\dsh-home\nanonis-runs\native-efceb3d1-49fd-432c-bf10-2700e2bb8279`。

## 现场准备、失败与限制

初始反馈关闭。核验模拟引擎身份后，使用 ZCtrl.OnOffSet(1) 打开了模拟器反馈，实时回读确认，电流达到约 50 pA。交付时保留反馈开启，便于继续扫描；偏压保持原先 2 V、扫描已停止。

首次独立探针快速关闭／重开同一端口，第三次读取被 ECONNRESET 拒绝；当时未执行任何写入，失败报告保留在 `native-acceptance.json`。修复为整趟验收共用单连接后通过。辅助 TypeScript 类最初使用了 Node strip-only 不支持的参数属性，执行入口明确失败；改成显式字段赋值后实际执行通过。

首次模型尝试使用原 dsh 授权文件，因没有 DeepSeek 密钥而在请求前退出；用户随后提供独立密钥文件路径，完整模型流程通过。PowerShell 脚本入口遇本机执行策略拒绝后，改为 Node 启动器，不改变系统策略。完整失败和通过日志保留于本机 `.tmp/native-nanonis/`。

本轮不证明完整图像采集／导出、真实仪器、其他 Nanonis 版本、跨平台或 npm 发布。未运行全仓 STM-Bench 集成、覆盖率、变异演练。模型命令台支持本轮验收的有限工具，命令间不继承模型上下文，扫描不会因命令结束而自动停止。
