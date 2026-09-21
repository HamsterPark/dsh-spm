# 第一版最小可用实施交接

本轮始于 2026-09-20，验证跨至 2026-09-21（Asia/Shanghai）。范围为 [最小可用计划](../MINIMUM-USABLE-PLAN.md) 的独立安装、只读 GetBias、受管模拟器及持久证据；操作入口见 [使用指南](../MINIMUM-USABLE.md)。

## 基线与来源

- 起点提交：`22f655b6ca27e54d2fac3fb337044f9636725406`，工作树已有大量未提交修改，全部保留；没有创建提交或还原原有工作。
- M0 将既有 diff、状态及逐文件 SHA256 保存到本机临时目录 `dsh-spm-m0-20260920-235317`。整合后与该快照比较，已有文件的变化仅限本轮明确修改的安装／构建配置、最小入口依赖、模拟器进程管理、记录关闭接线、测试配置及说明文档。未重导金样或重填迁移进度。
- 最终产物：`artifacts/dsh-spm-0.0.1.tgz`，SHA256 `8c510e26598495385a20f8f0983310570a03328c5baa0c8c7a45e7db68b0735b`。相邻 provenance 文件保存实际打包输入哈希及外部依赖，不能仅用起点提交代替产物来源。
- 平台：Windows x64，Node `24.14.0`，pnpm `11.7.0`，dsh `0.1.5-rc.2`，Cordis `4.0.2`。
- 外部模拟器：STM-Bench `9e1acb3a9bb95188c53edfcd108050369fd44a3f`，Python `3.13.13`，`reference-stm`，本地四端口。源码运行前后 Git 状态均干净，额外检查未发现本轮写入源码目录的文件。

## 实施

- 最小 bundle 复用原 hello 和现有 GetBias，通过 `defineSkillTool → SkillKernel` 执行。只显式注册两个工具，不加载专用前端或全部技能表。
- 单个 tarball 收入内部 workspace 代码，dsh/Cordis 精确外置。安装脚本在仓库外复制产物、安装完整依赖树并创建新 home，验证实际版本和模块身份。
- 模拟器使用独立运行／数据目录，启动前拒绝未知监听端口，激活工具前检查操作系统报告的进程归属；退出后各仪器角色均拒绝重新连接替代进程。
- SQLite 保留既有动作 schema；本地 JSONL 保存完整数值、工具调用 ID 及该次技能的仪器调用轨迹。后台轮询不混入该轨迹。
- 持久写入失败会使工具返回错误。针对 Cordis 并行执行清理回调的实际行为，记录库显式等待在途调用结束后再关闭，并增加延迟调用遇卸载的回归判据。
- 最小入口原有成功文本遗漏读数，现从同次内核结果渲染数值及 V；偏差见 `D-MINIMAL-1`。

## 本轮执行结果

| 检查 | 结果 | 范围 |
|---|---|---|
| M0 `pnpm build` | 通过 | 开始实施前的已接受工作树 |
| M0 `pnpm test --project unit --project contract` | 118 文件／7445 项通过 | 本机基线 |
| 最终 `pnpm build` | 通过 | 本轮源码 |
| 最终 `pnpm test --project unit --project contract` | 122 文件／7454 项通过 | 本轮源码；包含在途卸载、归属和持久化新判据 |
| `pnpm test --project integration packages/instrument/instrument-stmsim/integration/provider.test.ts packages/host/stm-skills/integration/readback.test.ts` | 2 文件／11 项通过 | 实际模拟器启动停止、归属检查、浮点回读 |
| `pnpm check:dsh-latest` | 通过 | latest/next 为 rc.2；alpha.2 保持不升级 |
| 分发／M3 | 见结构化验收记录 | 同一最终产物在两个独立安装环境验证 |
| 拼接 Zstandard 会话日志回归 | 1 文件／1 项通过 | 补充定向 contract 测试，晚于上述完整测试运行 |
| M4 原生模型会话 | 两个干净 home 均通过 | 模型 `deepseek-official/deepseek-flash`；原生会话、实际请求及磁盘证据对应 |

首次 integration 在测试开始前失败：外部 STM-Bench 已无旧 `polar-spm` 配置。没有跳过测试或修改模拟器；测试入口改用当前公开配置 `reference-stm`，另允许 `STMSIM_PROFILE` 显式选择旧版／自定义名称，之后实际运行通过。

首次 M4 的装载守卫拒绝了额外的 `exit_plan_mode` 工具，尚未发起模型请求。随后在验收 overlay 中关闭该基础工具提供者，保持要求的精确工具目录。此类安装／验收脚本修复不改变上述已冻结 tarball。

两次真实会话均调用一次 hello、一次 GetBias，读数均为 `0.10000000149011612 V`，与独立 TCP 读回完全相同。每个 home 使用两个 agent 模型请求；第一轮另有一次 dsh 标题生成请求，第二轮已关闭。总计观测到五次模型请求，四次 agent 请求的上游总 token 记录合计 2784；标题请求 token 未持久化，保持未知。未据此推算费用。

首次付费会话结束后，读取器漏识别默认 `.jsonl.zstd` 及其中拼接的独立压缩帧。修复后只离线重放已有会话，没有为解析器重复发起请求；第二轮及两份最终离线复核均通过。原始压缩会话保留在各自安装 home 中，公开交接保存脱敏的关联结果。

## 限制

本次未运行全仓模拟器集成、覆盖率或变异演练，未验证 Linux/macOS、完整客户端或真实仪器。远端旧 CI 结果仍为历史记录。没有 npm 公开发布；保留当前未提交工作树供审阅。
