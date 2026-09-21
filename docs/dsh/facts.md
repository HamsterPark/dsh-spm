# dsh 事实速查 —— 对照 `@deepseek-ai/dsh` **0.1.5-rc.2**（2026-09-13 升级并核实）

> **阅读方式**：本文按调查与升级日期累积，早期章节中的“当前”“本次”指该节记录时点。实际依赖以 [compat manifest](../../packages/host/compat/package.json) 和锁文件为准；版本决定按 [升级策略](upgrades.md) 的最新修订理解。项目当前可运行范围见 [文档导航](../README.md)，不从某次上游探针结果推断全部插件能力。

> **2026-09-13 升级到 `0.1.5-rc.2`**（当时走 `next` 通道；`latest` 仍停在 rc.1）。
> **2026-09-20 实测：`latest` 也追到 `0.1.5-rc.2` 了** —— 稳定通道两条都与本仓锁的版本一致，无动作。
> **本仓接触面零变化**：compat 依赖的六个包（`dsh-tools` / `dsh-commands` / `dsh-host-webserver`
> / `dsh-session-projection` / `dsh-system-prompt` / `dsh-attachment`）两版**逐文件相同**，
> 差的只有各自 `package.json` 里的版本号；组合树 539→539 行**零 diff**。
> 领域代码改动 **0**，2193 条测试一次全绿。逐条见 **§8.-2**；上一次见 §8.-1。
> **0.1.6-alpha.1（09-16）按切换点规则只读不升，影响记在 §8.-3。**
>
> 本文是 dsh-spm 里**唯一**记录 dsh 版本相关事实的地方；每次按 `docs/dsh/upgrades.md` 升级都要重核并改上面的版本号。
> 每条标注来源：**实测** = 本机跑出来的；**包** = 读 npm 包内文件；**文档** = GitHub 仓库 docs（2026-09-01 抓取，站点是 SPA）；**待核** = 课时 0.6 spike 才有结论。
> 决策与设计后果不写在这里，写在 `docs/PLAN.md`（其 §3.1 编号与本文 §6 对齐）。

## 1. 版本与发布节奏（实测 2026-09-04）

| 版本 | 发布 | 备注 |
|---|---|---|
| 0.1.0-rc.7 / rc.8 | 08-17 / 08-19 | rc.8 存储格式不兼容 |
| 0.1.1-rc.1 / rc.2 | 08-21 | 曾长期占着 `latest` |
| 0.1.2-alpha.1 | 08-27 | APIProxy 删除、conversation UI 拆分、Code Mode 改名 PTC |
| 0.1.2-alpha.2 | 08-30 | |
| 0.1.2-alpha.3 | 08-31 | 删除可选 SQLite session 后端 |
| 0.1.2-alpha.4 | 09-01 | `Session.events` → 按需读 API；`send_message` 替代 `report` |
| 0.1.2-alpha.5 | 09-02 | **纯修复**：从 `0.1.1-rc.2` 或 `0.1.2-alpha.3` 升级可能启动不了 / 会话标题消失 |
| 0.1.2-rc.1 | 09-03 | 0.1.2 全线累积的 roll-up，**至今仍占 `latest` 与 `next`**；变更见 §8.1 |
| 0.1.3-alpha.1 | 09-04 | **npm 上没有这个版本号**（`versions` 从 rc.1 直接跳到 alpha.2），但发布说明有它，内容被 alpha.2 吞进去：session 格式 v2、`SessionHandle`、出站请求认代理环境变量 |
| 0.1.3-alpha.2 | 09-07 | **跳过**：本机装不上（`fs-ext` 要现场编译 C++）。persona 拆前后段；见 §8.0-历史 |
| 0.1.4 | —— | **从未发布**，npm 上不存在 |
| **0.1.5-alpha.1** | **09-08** | **当前锁定**（09-09 升）。`fs-ext` → `node-addon-system`（阻塞解除）；session **V3**；去掉 `ctx.agent`；`Inbox` 变 type-only；变更与已知问题见 §8.0 |

- **dist-tags（09-09 实测）**：`alpha` = **`0.1.5-alpha.1`**，`latest` = `next` = `0.1.2-rc.1`（**六天没动**）。**追踪对象不是某个固定 tag，而是所有 dist-tag 里 semver 最大的那个**（PLAN D11、`upgrades.md`）：09-04 时 rc.1 比 alpha.5 新、盯 `alpha` 会落后；09-07 反过来，`alpha` 又领先了 `latest` 一个 minor。按版本号比大小，别信标签名。裸 `npx @deepseek-ai/dsh` 现在会装到 rc.1，但仍然**所有命令必须带版本**。
- **prerelease 上的 caret 会跨通道，但只在同一 `x.y.z` 元组之内**：启动器 `dsh` 对自己的 `@deepseek-ai/*` 依赖声明 `^0.1.2-<pre>`（`dsh-base` 84 个、`dsh-web-app` 70 个、`dsh-tools` 的 peer 同样是 `^`），而 `^0.1.2-alpha.4` 的语义是 `>=0.1.2-alpha.4 <0.2.0`，**同一 `0.1.2` 元组下 `rc.1` > `alpha.5` > `alpha.4`，所以 alpha 范围会吃进 rc**。09-04 实测：全新 `npm i @deepseek-ai/dsh@0.1.2-alpha.4` 装出 **1 个 alpha.4 启动器 + 213 个 `0.1.2-rc.1` 子包**。
  **但它不会跨到 `0.1.3`**（09-07 实测确认）：semver 规定预发布版本只匹配范围里**元组相同**的比较符，`0.1.3-alpha.2` 的元组 `[0,1,3]` 既不等于 `>=0.1.2-rc.1` 的 `[0,1,2]` 也不等于 `<0.2.0` 的 `[0,2,0]` ⇒ 钉 `0.1.3-alpha.2` 装出的树里 **223 个 `@deepseek-ai/dsh*` 全部恰好是 `0.1.3-alpha.2`，零例外**（`spec/dsh/pkglist.0.1.3-alpha.2.txt`）。**结论不变**：仍然必须整套精确钉（PLAN D11、§6.3），`check-dsh-pin.ts` 断言安装树里 `@deepseek-ai/dsh*` 只有一个版本——minor 之间干净不代表 patch 之内干净，而 dsh 大部分时间都在同一个 patch 元组里滚。
- **npx 缓存是冻结快照，会掩盖漂移**：09-02 建的 alpha.4 缓存树里 214 个子包都还是 alpha.4，同一天建的 alpha.3 树里 213 个子包是 alpha.4；rc.1 树 214 个全是 rc.1。本地跑着「没事」不代表 CI 或别人装我们的插件时没事——**漂移只在全新安装时发作**。
- Cordis 系是独立版本线：`@deepseek-ai/cordis` 4.0.2、`cordis-plugin-loader` ^1.0.3、`cordis-plugin-include` ^1.0.7、`cordis-plugin-timer` ^1.1.4、`cosmokit` ^1.8.3。
- `SESSION_FORMAT_VERSION` 在 rc.1 里**仍是 0**（包内实测），源码注释 "Remove at the first tagged release"。**09-07 兑现了**：`0.1.3-alpha.1` 把会话格式升到 **v2**，带「相邻代不可变迁移」，v0/v1 自动转换（§8.0）。预测对了，但落点不是 0.1.2 正式版而是下一个 minor 的 alpha。⇒ 升级清单第 6 步（拿**既有** `~/.dsh` 冒烟、先备份）在升 0.1.3 那次必须一步不省。

## 2. 运行环境（实测 2026-09-02，rc.1 于 09-04 复测，Windows 11）

- Node v24.14.0、npm 11.9.0、corepack 0.34.6、git 2.53。dsh 要求 Node ^22.19 || ≥24，pnpm 11.7（`packageManager`）。
- `corepack enable pnpm` **EPERM**（要往 `C:\Program Files\nodejs` 写 shim）；用 `corepack enable --install-directory %APPDATA%\npm pnpm` 装到用户级目录（已在 PATH，新终端可用，默认 11.25.0；进仓库后由 `packageManager` 钉 11.7.0）。
- npx 缓存：alpha.3 树 `%LOCALAPPDATA%\npm-cache\_npx\8be755d04d6547a7\`、alpha.4 树 `…\_npx\2145f1867deb72cf\`、**rc.1 树 `…\_npx\2f3a729d991ac520\`**（各 223 个 `@deepseek-ai/*` 包）。每棵树的子包版本见 §1 第三条。
- **rc.1 在 Windows 上启动正常**（09-04 实测）：`--dump-config` 与 `--profile web --no-open` 都正常，端口 3080 照常打印带 token 的 URL。
- `~/.dsh/`：`.credentials.yaml`（`refs` 存密钥、`records` 存插件记录；settings UI 写入；文件变更自动重载）、`.anonymous-user-id`、`profiles/web/`（**profile 本身是 pnpm 项目**：`package.json` 只有 `dsh.profile.bundles: [dsh-base, dsh-web-app]` 与 `patchReload: live`，`dependencies: {}`；`cordis.yml` 是空根 `[]`；`cordis.patch.yml` 是用户 patch 层；`node_modules/` 放树外插件）。bundles 先从 dsh 安装目录解析，再从 profile 的 `node_modules`。
- **密钥解析顺序**（`dsh-credentials-local` README）：启动环境 > `~/.dsh/.credentials.yaml` > `<cwd>/.env` > `~/.dsh/.env`；启动后再导出的环境变量看不到。DeepSeek 默认 `DEEPSEEK_API_KEY`（`llm-deepseek` 源码 `DEFAULT_API_KEY_ENV`）。产品绝不把凭据文件路径交给 agent，但 agent 的工具进程以同一 OS 用户运行、文件权限挡不住。
- `dsh --profile web --no-open` 打印 `http://127.0.0.1:3080/?token=…`；**无 token 一律 401**（`/api` 浏览器信任栅栏，`--trusted-host` 可加）。启动目录 = 默认 workspace 根（`sandbox-policy.workspaceRoot = process.cwd()`）。
- **遥测**：`session-telemetry-otel` 默认 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY`，上报 `https://harness-telemetry.deepseeksvc.com/v1/logs`；真机 profile 要决定是否 `off`。
- 关闭启动它的终端/任务不一定杀掉 node 子进程，端口会继续占着（实测 EADDRINUSE）⇒ 重启前 `netstat -ano | findstr :3080` + `taskkill /F /PID`。强杀 dsh 本身无害（它不是 Nanonis）。

## 3. web profile 组合树（实测 `--dump-config`）

> **当前锁定的 0.1.5-alpha.1 是 152 行插件行 / 26 disabled**（相对 rc.1 的 30 个 diff 行、八处增删，见 §8.0）。
> 下面这段描述的分组与结构在 0.1.5 上仍成立，**行数与名单以 `spec/dsh/dump-config.0.1.5-alpha.1.yml` 为准**。

- 0.1.2 三版（alpha.3 / alpha.4 / rc.1）**逐行相同**：**145 行插件行**，27 行 `disabled: true`；来源三段：`dsh-base`（约 90 行）→ `dsh-base, patched by dsh-web-app`（9 组被 web-app 改写）→ `dsh-web-app`（宿主 API 控制器、webserver、约 45 个 `dsh-client-ui-*` 客户端模块）。导出件已入仓 `spec/dsh/dump-config.<version>.yml`（alpha.3 / alpha.4 / rc.1 三份，逐字节相同；见该目录 README）。
- 分组：LLM（`llm`、`llm-deepseek`、`llm-pi-ai`、`llm-retry`、`agent-default-model` = `deepseek-official/deepseek-v4-flash`）；会话（`session`、`session-log-deepseek`、`session-persistence-jsonl` → `~/.dsh/sessions`、`session-query-sqlite` `:memory:`、`session-projection` + cache、`session-title*`、`session-checkpoint-policy`）；agent（`agent`、`agent-loop`、`agent-presets` default `standard`、`agent-instructions`、`system-prompt` persona）；工具（`tools` 注册表、`tool-*` 行、`timeout-policy`、`repeat-tool-reminder`、`spill-*` 50 KB 内联上限）；沙箱与审批（`sandbox-policy` `workspace-write`、`bash-sandbox` win32 禁用 / `pwsh-sandbox` 非 win32 禁用、`approval` policy `ask`（`DSH_PERMISSION_MODE=danger-full-access` ⇒ `never`）、`permission` 三预设）；`jobs`（local）、`subagent` + spawn/fork provider、`storage`（json → `~/.dsh/storages`）+ `storage-domain`、`credentials`、`settings`（file）、`skill` 注册表、`commands`、`goal` + round driver、`token-meter`、`web`（DeepSeek 搜索 + http fetch）、`subprocess`、`shell-env`、`code-runtime`、`workspace`、`message-feedback`、`session-log-export`、遥测。
- **关键结构（实测）**：`dsh-web-app` 在宿主层把全部模型可见工具行设为 `disabled`（`tool-bash/pwsh/fs/fs-search/jobs/skill/goal/subagent*/workflow/todo/web/str-replace-editor/ralph`、`compaction-basic`、`tool-result-pruner`、`plan-mode`、`agent-instructions`），由 **agent preset 在 agent 平面重新挂载**：`@deepseek-ai/dsh-agent-presets/presets/<name>/agent.cordis.yml`（自带 `cordis / minimal / ptc / standard`，`preset.yml` 只有 name/description/order）。preset 文件注释里的规则：工具行注册进宿主 `tools` 注册表、不 provide 服务 ⇒ 不需要 realm；**任何 provide 服务的行必须放在带 `isolate` 的 `cordis:group` 里**（否则进根 realm、跨 preset 撞名，`dsh-agent-presets` 挂载时拒绝）；`tokenMeter`/`subagents` 注册表/`shell-env`/`fs` policy 留在宿主平面；「合并后的目录也包含部署全局注册的工具」。
- `standard` 内容：persona、agent-instructions、tool-bash/pwsh（按平台）、tool-fs、tool-fs-search、tool-jobs、skill-filesystem、tool-skill、command-goal、tool-goal、`planning` 组（isolate planMode）、`compaction` 组（isolate compaction+toolResultPruner）、`delegation` 组（isolate workflowEngine：subagent-control、list-agents、`subagent`（spawn，continuable，modelSelectionSettings）、`subagent_fork`（fork，continuable）、codex/claude-code 行默认 disabled、workflow-worker-thread、tool-workflow、tool-ralph）、tool-ask-user、tool-todo、tool-web。`minimal`：persona `complete: true`、`includeRuntimeContext: false`，持久 shell 组（`dsh-terminal` + bash/pwsh 持久工具）、`filesystem` 组（`fs-local` 遮蔽宿主沙箱 fs + `str-replace-editor`），无 compaction。

## 4. 三层组合与 CLI（包内 `@deepseek-ai/dsh` README，2026-09-02）

- 入口：`dsh --profile <name>`；`web`/`headless`/`sdk`/`sdk-minimal`/`acp` 首次使用从模板自动初始化，其它 profile 必须 `dsh plugin` 创建；`dsh web` = `--profile web`；`dsh plugin --profile <name> <pnpm args>` 转发给 pnpm；启动器只解析自己的 flag，第一个不认识的 token 之后全部交给应用（`--port/--host/--no-open/--trusted-host` 是 web app 的）。
- 配置树：空根 → `dsh.profile.bundles` 各 bundle 的 patch（按序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`；`patchReload: live | startup`；`--dump-default-config` / `--dump-config` 不启动就打印。
- 可选 overlay 在 `config/examples/`（webhook、schedule、记忆 MCP、运行时 Cordis 工具），不属于默认 profile。

## 5. 能力对照与生态（原 PLAN §4 正文；09-01 按文档核实，09-02 在 alpha.4 上复核了组合树，逐 API 复核归 0.6 spike）

- 运行：Node ^22.19 || ≥24、pnpm 11.7（corepack）、TS strict、ESM；`npx @deepseek-ai/dsh web` → `http://127.0.0.1:3080`。本机环境见 §2。
- dsh 根 `@deepseek-ai/dsh-root`（工具链版本 09-01 按 alpha.3 核实，alpha.4 未复核）：`packageManager pnpm@11.7.0`、workspaces `vendor/* packages/*/* native/* apps/* website`、TypeScript ^6.0.3、tsdown ^0.22.2、vitest ^4.1.8、oxlint 1.76.0、@testing-library/react ^16.3；web 前端 React ^18.2。
- 组成：Cordis 插件（`export const name/inject/Config/apply(ctx, config)`；Service 类 + declaration merging；`ctx.effect()` 可回滚；`isolate`）。Bundle = npm 包 + `dsh.bundle.patch → cordis.patch.yml`；`dsh plugin --profile web add ./path | pkg | github:owner/repo#sha`；层叠 bundles → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch`。`dsh-base` ≈90 行默认组成（模型 `deepseek-official/deepseek-v4-flash`、tool-bash/pwsh、tool-fs、approval、sandbox、subagent、compaction-basic、tool-skill、goal、todo、web…）；自带 preset cordis/minimal/ptc/standard。
- 50 个能力包组：acp api attachment boot bundle client code-runtime compaction context core credentials e2b experimental extensions feedback fs goal guard hooks host identity interaction jobs llm lsp mcp plan preset runtime-diagnostics sandbox schedule sdk session session-query settings shell skill spill storage subagent subprocess terminal test-support todo typert util web webhook workflow workspace。

| 我们要的 | dsh 提供 | 备注 |
|---|---|---|
| agent loop / turn / step | `core/agent-loop`；事件 `agent/session-start`、`agent/pre-step`(可重写消息)、`agent/request`(换 LlmCallConfig)、`agent/request-error`、`agent/turn-stopping`、`agent/inbox/*`、`agent/status`；`Agent.followup/steer/inject/cancel({keepInbox})/whenIdle` | |
| 工具 | `ctx.tools.register(defineTool({name, description, parameters, output:{schema, render}, execute(args, exec{signal, callId, agent, deferContext, concludeTurn}), presentCall, presentResult, timeoutMs, isConcurrencySafe}))`、`restrict({allow|deny})`、`guard()`、瀑布 `tools/pre-execute → allow|deny|ask`、`tools/execute`、`tools/post-execute → accept(content|value, additionalContexts)|block`、`tools/result`、`tools/change` | 参数由 defineTool 校验；抛异常=isError；领域失败放 value |
| 审批 / 提问 | `ctx.approval.request()`（allowed-once/rejected/cancelled/unavailable，policy ask|never）、`ctx.userQuestions.ask()`（单/多选/custom）、`ask_user_question` 工具、`ctx.permissionPresets` | 审计事件 approval/asked|decided 模型不可见 |
| 会话持久化 / resume / fork | JSONL append-only（可选 zstd）、`ctx.sessions.fork()`、`ctx.agents.create/resume`、`SessionEventMap` 可扩展、`ctx.sessionProjections`（fold → wire view → 客户端推送） | |
| 上下文压缩 | `compaction-basic` + `tool-result-pruner`(8192) + `/compact`；token-meter 触发 | 替代 Layer1+Layer2 |
| 后台任务 | `ctx.jobs.start({kind, label, owner, outputLimitBytes?, run(): {cancel, done, readOutput?}})`、`job_*` 工具、`run_in_background` | 进程内 |
| 子 agent / 编排 | `ctx.subagents`（spawn/fork in-process、ACP、Codex/Claude Code）、`subagent` 工具（one-shot|continuable、maxDepth、toolFilter、agentOptions）、`ctx.agentTeams`(实验)、`ctx.workflowEngine` | 子 agent 权限启动时冻结 |
| agent 预设 | `ctx.agentPresets`：目录 + `agent.cordis.yml`；bundled `presets/` → roots → `<dshHome>/.agent-presets`；`default:` 可覆盖；session 产生内容前可切 | |
| 目标 / 定时 | `ctx.goals`（每 session 一条，`get/create/update_goal`，round-driver）、`ctx.schedule`（`schedule_create/list/delete`，跨重启，session 内） | |
| 技能（说明书） | `ctx.skills` provider（SKILL.md，rank；`skill` loader 工具；`/name`） | 对应 MAST 知识文本，**不是** BaseSkill |
| LLM | `ctx.llm.registerAdapter([...], LlmAdapter)`（`stream()`；usage 在 finish 前；`resolveModel()` 声明 reasoning 档）；内置 `llm-deepseek`、`llm-pi-ai` | 无 prompt caching |
| 系统提示 / 注入 | `ctx.systemPrompt.section()`、`agent-instructions`、`agent.inject()` | |
| 斜杠命令 | `ctx.commands.register({name, description, input?, handler({agent, rawInput, attachments})→{kind, text?}})`（不触发模型） | |
| 持久 KV | `ctx.storage` + `ctx.storageDomain`（schema 校验、变更事件、JSON/SQLite 后端，host-only） | |
| 图像附件 | `ctx.attachments`（本地、永不自动删；`{type:'image'}` 内容块） | |
| 设置页 | `ctx.settings.installSection(ctx, ns, ConfigSchema, config, {validate, setSource, onChange})` + 客户端 `settingsScope.bind({namespace})` + slot `settings.plugin.item`；`role('secret')`、`applies:'restart'` | |
| Web UI | `dsh.client` bundle（`exports["./client"]`，`/plugins/??a,b&rev=` 合并加载）、`ctx.slots.register()`、`conversation.view`、`tool.call.toolview`、`fence-registry`、`webServer` 自定义路由 | React 由宿主提供 |
| 记忆（跨会话） | **无内置**；cookbook：section provider + tool；社区 dsh-memory-evolve / dsh-noema | 自建 |

- 社区先例：**dsh-omicos**（防腐层 `src/host/dsh-compat.ts` + 精确锁版本 + JobKindMap 声明合并 + 客户端 bundle）、**HOL Guard**（`tools/pre-execute` + `guard()` fail-closed）、**dsh-science-workbench**（tools + `webServer` `/biowb/*` + 整页 tab）、**dsh-genui**（fence-registry/slots，JSON payload 渲染图表/表单/3D）、`create-dsh-plugin` 脚手架（tool/events/webui，rc.6）、NanoCordis 教学实现。
- 深度视觉推理：`onnxruntime-node` 1.29.0 Windows x64 预编译含 **DirectML**（CUDA 预编译只有 Linux）⇒ RTX 4060 走 DirectML。
- LLM 路由：pi-ai 生态有 Moonshot/Qwen/MiniMax/GLM 的 openai-compatible 目录；dsh `llm-pi-ai` 支持手写 `openai-completions` 路由 + `baseURL` + `apiKeyEnv`。


## 6. dsh 侧陷阱（原 PLAN §3.1；编号与 PLAN §3.1 的设计后果对齐）

1. **API 会漂**：rc.8 存储格式不兼容 → alpha.1（8-27：APIProxy 删除、conversation UI 拆分、Code Mode 改名 PTC）→ alpha.3（8-31：删除 SQLite session 后端）→ alpha.4（9-01：`Session.events` 换成按需读 API、`SessionSeq`/`SessionLogOffset` 强类型）。`SESSION_FORMAT_VERSION: 0`，"Remove at the first tagged release"。**启动器与 bundle 对子包都是 `^` 范围**，只钉 `dsh` 锁不住。⇒ 防腐层单点 + 整套精确钉 + contract 测试 + 实时小步升级、随 dsh 一起重构（PLAN D11、`upgrades.md`）；持久真源放 SQLite 不放 session log。
2. **审批请求不带工具参数**（`ctx.approval.request({agent, tool, callId, reason})`）；`tools/pre-execute` **不能改写参数**；无应答者 fail-closed 为 `unavailable`。⇒ `reason` 放确定性 `ApprovalDigest`（含 `args#hash6`），执行时重算 hash 不等即拒。
3. **`ctx.tools.guard()` 单调**：拒绝不可翻转 ⇒ 见 D9。
4. **jobs 不跨重启**、job 归属启动它的 session ⇒ 过夜 conduct 要自己的持久 journal；扫描类 job 不续跑、重启后标 `interrupted`；只有 conduct 从最后一个**已确认**步续跑。
5. **Model-visible ⟺ logged**：进模型的内容必须可从 session log 重建；`agent/request` 不能改消息。活状态若经 `systemPrompt.section` 注入，Phase 0 必须钉「section 内容逐请求进 log」，否则改 `agent/pre-step` 注入 user-role 块。
6. **`presentCall/presentResult/output.render` 是纯函数**（live 与 replay 都调，禁 I/O）⇒ offload/剥审计键在内核，render 只排版。
7. **`llm-pi-ai` 无 prompt caching**、`stop` 不支持；Qwen `enable_thinking`、GLM `thinking.type`、Kimi 温度锁 1.0、`reasoning_content` 多轮回传 ⇒ Kimi/Qwen/GLM 自写 `LlmAdapter`（§7.7）。
8. **Windows**：web profile 可跑；bash/PTY 在 win32 有坑（minimal preset 死、node-pty 回归、社区 `dsh-win32`）；dsh-base 在 Windows 自动换 `tool-pwsh`。我们的工具不依赖 shell；IC/conduct preset 用 `restrict({deny})` 裁掉 bash。
9. patch 层叠**按 id 整体替换 config，不深合并**；被替换的行要把原有键抄全；`remove`/`replace` 是否存在 Phase 0 核实（§15）。
10. 命令名 `^[a-z][a-z0-9_-]*$`；工具 schema 用 dsh-tools 的 JSON-schema DSL（**没有 `minimum/maximum`**，范围只能写进 description——Phase 0 核实是否透传）；Schemastery 只给插件 Config。
11. 客户端 bundle：React/react-dom、Cordis、`dsh-client-store`、`ui-primitives`、`ui-slots` 是隐式基线**不得重复声明**；组件不得 import ctx 服务（props 四份享）；跨 feature 包禁 import；文案进类型化 locale；jsdom 测试 per-file pragma；store 只在 `apply` 内 `defineStore`。dsh web 前端 React **^18.2**，旧 `frontend/` React 18.3——组件可搬。
12. slot 名（已核实）：`ui-layout` 根下 `sidebar` / `conversation` / `details` / `shell.overlay`（`ctx.layout` 开关 details）；`ui-sidebar`：`sidebar.brand.mark|name` / `sidebar.workspaces` / `sidebar.settings`；`ui-conversation`：**`conversation.view`（整页视图，`{name:'conversation.view', id, order, label}`，持久选中 > `chat` > 无）**、`conversation.composer`（chain）、`tool.call.toolview`（按工具名 keyed 的自定义工具卡）、`ctx.uiConversation.events.register()/views.register()`；设置卡 `settings.plugin.item`。范本：dsh-science-workbench `lib/client.js`（`inject=['slots','workspaces']`，`slots.inject('conversation.view', () => slots.register({name:'conversation.view', id, order:20, label:'分析工作台'}, Comp))`）；宿主 `inject=['tools','webServer']`，`ctx.effect(() => ctx.tools.register(defineTool({...})))`，`webServer.register({kind:'prefix', path:'/biowb', handler(req,res)})`。**待核实**：`conversation.view` 无 session 时能否显示、`details` 是 single 还是 list、`toolview` props 有无待批状态、`webServer` handler 是否支持流式 `res.write`/WS upgrade。
13. Python SDK 只是驱动器（JSON-RPC 仅 initialize/session.prompt/shutdown；server→client 请求是 dead capability）——不能拿它做 HITL 自动化测试；测试用 TS 侧 `ctx.agents.create` + 应答者插件。
14. MCP client 只桥工具（无 resources/prompts，图像是唯一富结果，默认 60 s 超时）——本方案不用；记在此防止回头走它。
15. `ctx.tools.restrict` 只能取交集且未知能否放松；被隐藏名字被模型调用时 dsh 返回什么未知 ⇒ Kimi「工具名受限于绑定列表」对策见 §7.8（桩保持绑定 + 动态换注册），Phase 0 spike。

16. **web profile 在宿主层禁用全部模型可见工具，由 agent preset 在 agent 平面重挂**（实测，见 §3）。

17. **`dsh plugin add <本地目录>` 用 `link:` 协议，于是开发态与安装态跑的不是同一棵依赖树**（2026-09-08 课时 0.4 实测）。
    `dsh plugin --profile web add D:\...\packages\bundle\dsh-spm` 之后，profile 的 `package.json` 里是
    `"dsh-spm": "link:D:/.../packages/bundle/dsh-spm"`（同时它把 `dsh-spm` 追加进了 `dsh.profile.bundles`——
    它认得我们 package.json 的 `dsh.bundle.patch` 字段）。**`link:` 意味着 pnpm 完全不解析我们的 `dependencies`**：
    我们写的 `workspace:*` 从没被求值，peerDependencies 也没被执行。
    探针实测：运行时我们的 compat 把 `@deepseek-ai/dsh-tools` 解析到了**本仓** `node_modules` 里那份，
    而不是 profile 的那份 ⇒ **一个进程里同时活着两份 dsh-tools 模块实例**（今天两份都是 `0.1.2-rc.1`，所以没出事）。
    - **为什么现在没炸**：`defineTool` 是纯工厂，返回普通对象，跨实例无所谓；`ctx.tools.register` 收的也是普通对象。
    - **~~什么时候会炸~~ ✅ 2026-09-09 课时 1.6 开工前实测：Cordis `Service` 不受影响。**
      探针（临时给 compat 导出 `Service`、在 bundle 里定义一个 `ProbeService`，装进真 0.1.5 profile 启动）：
      `ctx.plugin(ProbeService)` 不抛 · `ctx.inject(['stmProbe'], cb)` 拿得到实例并能调方法 ·
      `instanceof` 我们那份 `Service` **为真** · 进程正常存活。
      **原因（读 `cordis/lib/types/service.d.ts` 查实，不是我最初猜的「原型链自然对得上」）**：
      ① 服务注册表按**字符串名**索引，不靠类身份；
      ② **Cordis 自己重写了 `static [Symbol.hasInstance]`** ——`instanceof` 走的是它的自定义判定，
      本来就不比较类对象。⇒ 用两份 cordis 实例定义 Service 是安全的。
    - **仍要小心的方向**（未验，与上面相反）：拿**dsh 构造出来的**对象去 `instanceof` **我们这份**类
      （或反过来），那才是跨实例真会假的场景。我们目前没有这种用法；将来若要判定 dsh 传进来的对象类型，
      改用 duck typing 或它自带的 kind 字段，别用 `instanceof`。
    - **发布到 npm 后不是这样**：那条路径上 profile 的 pnpm 会真的解析我们的依赖、执行 peer 精确钉，只剩一份实例。
      也就是说**我们的开发回路与用户的安装回路走的是两条不同的解析路径**——同 §1 那条「npx 缓存是冻结快照」一个教训：
      本地跑着没事不代表别人装了没事。⇒ Phase 0 结束前至少用 `pnpm pack` 出的 tarball 走一次安装态冒烟。

## 7. Phase 0 必须先核实的十条（原 PLAN §15）

> **结论正本在 `docs/dsh/spike.md`**（2026-09-08 课时 0.6 起）：已结清 1 / 3 / 5 / 7，半结清 6，其余五条各自记了触发点。
> 有结论的都钉成了 `packages/host/compat/src/spike.test.ts` 的断言，随每次升级重跑。

1. `ctx.tools.guard(exec => …)` 的 `exec` 是否含工具名与参数。
9. ~~`webServer` 是否支持流式 `res.write` / WS upgrade。~~ **✅ 2026-09-10 课时 1.10 结清**：`WebRoute.handler` 的文档写着 *Owns the full response lifecycle (**may hold the response open, e.g. SSE**)*，另有 `registerUpgrade` 提供 WS upgrade。⇒ PLAN §13 备的「退化成轮询」退路用不上。**不是照文档抄**：`packages/client/stm-ui/src/plugin.test.ts` 起一份真 `WebServer`（`port: 0`）+ 真 `http.get` 验过响应头、逐条推送、`Last-Event-ID` 续传、心跳。顺带确认：`EventSource` 断线重连**自动**带 `Last-Event-ID`，所以「重启 5 秒内续传无缺口」不需要客户端记任何东西。
2. ~~`ctx.systemPrompt.section()` 的动态内容是否逐请求记入 session log。~~ **✅ 2026-09-09 课时 1.8b 结清（问题问偏了半格）**：两条路都进日志，但易变内容该走的是 **`context()`** 而不是 `section()`——前者的文档原话是 "materialized as a **durable user-role snapshot**"，落成 `form: 'snapshot'` 的用户角色消息并带按贡献者分开的 `sections`。`section()` 走 `system/message` 事件，把每轮都变的读数塞进系统提示会让 prompt cache 的断点落在易变文本之后（旧仓 2026-07-28 审计买过这个教训）。⇒ PLAN §3.1-5 备的 `agent/pre-step` 退路不用了。详见 `spike.md` §2。
3. `cordis.patch.yml` 是否有 `remove`/`replace`，还是只能同 id 覆盖。
4. replay 模式下工具执行是否被短路；`exec` 上有什么标志可判。
5. ~~`parameters` 是否透传 `minimum/maximum`。~~ **✅ 2026-09-08 课时 0.3 结清（结论比原设想更强）**：不但不透传，而且**在 `defineTool` 构造期直接抛** `JsonSchemaError: unsupported JSON schema: parameters.n.minimum is not supported by the value schema DSL`。⇒「范围写进 description」不是可选变通而是唯一写法，且写错了当场炸，不会变成「模型永远看不见这个范围」的静默缺陷。契约测试 `packages/host/compat/contract/pin.test.ts` 钉住了它；哪天 dsh 支持了那条会红，届时同步改 PLAN §8.2 的 schema 生成。
   同段顺带钉住的另外两条 `defineTool` 事实：`parameters` 是**属性表**（dsh 自己补隐式 object 根），不是完整 JSON Schema；`output: {schema, render}` 是**必填**。
6. `ctx.tools.restrict` 能否放松；被隐藏名字被模型调用时返回什么；同名工具重注册（桩→完整）的语义与 `tools/change` 行为。
7. `tools/result` 能否读到 `value`；job 内能否 `userQuestions.ask`；`presentResult` 对 `INVALID_ARGS` 能否接管渲染。
8. `conversation.view` 无 session 时能否显示；`details` 是 single 还是 list；`tool.call.toolview` props 有无待批状态。
9. `webServer` handler 是否支持流式 `res.write`（SSE）/ WS upgrade。
10. 子会话能否读到父/根 session id；`agent/turn-stopping` 能否取消停止；`ctx.agents.resume` API 名；压缩事件有无钩子（`memory_sink`）。


## 8. 逐版本变更与对本计划的影响

### 8.-4 **0.1.6-alpha.2 —— 仍然只读不升**（2026-09-20 开工自检）

按 `upgrades.md` 09-13 的补记：**alpha 只读发布说明、把影响记进这里，不升。**
稳定通道今天两条都是 `0.1.5-rc.2`（`latest` 从 rc.1 追上来了），**本仓锁的就是它，已是最新**。

**顶层依赖 73 → 77**，五增一删：

| | 包 | 读法 |
|---|---|---|
| **新增** | **`@deepseek-ai/dsh-plugin-manager`** | **落在本仓接触面上的唯一一件** —— 我们自己就是个插件。真要升之前必须先看它接管了什么：装载路径变了的话，B10 / B12 那两条（dev 态 `link:` 与安装态走两条不同解析路径）要重新测一遍 |
| 新增 | `@deepseek-ai/dsh-hmr` | 与下面那条是**一对**：HMR 从 cordis 插件搬成自家包。同 alpha.1 的 `workflow-worker-thread → workflow-ptc`，**连着两个 alpha 都在把 cordis 侧的件收回自家** |
| 删除 | `@deepseek-ai/cordis-plugin-hmr` | ↑ |
| 新增 | `@deepseek-ai/dsh-atomic-write` | 原子写。会话持久化那条路上的，本仓不直接用 |
| 新增 | `dsh-experimental-agent-team-profile` / `…-web-profile` | 两个 experimental profile，与本仓无关 |

**本仓接触面（compat 的六个）**：`dsh-commands` / `dsh-host-webserver` /
`dsh-session-projection` / `dsh-system-prompt` / `dsh-tools` **五个都发了 0.1.6-alpha.2**；
`@deepseek-ai/cordis` 仍在自己那条版本线上（**没有 0.1.6-alpha.2 这个版本号**，同 §1）。
⇒ 接触面**在**，不是「包没了」的那种升级。

**升的时候要先看的两条**（第一条继承自 §8.-3，第二条新增）：

1. workflow 从 worker-thread 换成 `ptc` —— `dsh-jobs-local`（课时 5.2 要用）在它上面，
   升级前先确认 `ctx.jobs` 的取消语义没变（「后台 job cancel 1 s 内停扫」是 Phase 5 的完成判据）。
2. `dsh-plugin-manager` 接管了什么。**这一条比第一条更要紧**：我们整个交付物就是一个插件，
   而 B7 已经证过「`dsh plugin add <本地目录>` 用 `link:`，pnpm 完全不解析我们的 dependencies」。
   一个叫 plugin-manager 的新包出现，正好落在那条已知没测过的路径上。

### 8.-3 **0.1.6-alpha.1 —— 只读不升**（2026-09-16 记录）

切换点之后的第一次 alpha。按 `upgrades.md` 09-13 的补记：**alpha 只读发布说明、
把影响记进这里，不升**。稳定通道仍是 `latest = 0.1.5-rc.1` / `next = 0.1.5-rc.2`，
本仓锁在 `rc.2` —— **稳定通道上已是最新**。

**顶层依赖 72 → 73**，三处变化：

| | 包 | 读法 |
|---|---|---|
| 新增 | `@deepseek-ai/dsh-workflow-ptc` | 与下面那条是**一对**：workflow 的执行载体换了 |
| 删除 | `@deepseek-ai/dsh-workflow-worker-thread` | ↑ |
| 新增 | `@deepseek-ai/dsh-mcp-resources` | MCP 的 *resources* 那一半（我们只用 tools，暂时无关） |

**本仓接触面（compat 的六个）**：`dsh-commands` / `dsh-host-webserver` /
`dsh-session-projection` / `dsh-system-prompt` / `dsh-tools` **五个都发了 0.1.6-alpha.1**；
`@deepseek-ai/cordis` 仍在自己那条版本线上（`4.0.2`，未动，同 §1 记的「Cordis 系
独立版本线」）。⇒ 真要升的时候，接触面**在**，不是那种「包没了」的升级。

**升的时候要先看的那一条**：workflow 从 worker-thread 换成 `ptc`。我们没直接用
workflow，但 `dsh-jobs-local`（长时 job，课时 5.2 要用）在它上面 —— 升级前先确认
`ctx.jobs` 的取消语义没变（「后台 job cancel 1 s 内停扫」是 Phase 5 的完成判据）。

#### ⚠️ 记一次我自己差点写错的核对

第一遍我拿「`@deepseek-ai/dsh` 的**顶层依赖表**里有没有这六个」去判接触面，
结果四个显示「没了」—— 而真相是**它们本来就不是启动器的顶层依赖**
（它们是子包的依赖，我们在 `pnpm-workspace.yaml` 的 overrides 里单独钉）。
正确的问法是「这六个包**自己**有没有发这个版本」。

**判据问错了对象，答案照样看起来像个答案** —— 同 D-READBACK-1 那条。
下次核对接触面就用这一条：`npm view @deepseek-ai/<包>@<版本> version`，逐个问。

### 8.-2 rc.1 → **0.1.5-rc.2**（2026-09-13 实测）

**本仓接触面零变化。** 这是四次升级里第一次连配置树都一模一样：

| 查什么 | 结果 |
|---|---|
| `--dump-config` 539 行 | **零 diff**（`diff` 退出码 0） |
| compat 依赖的六个包逐文件 diff | **只差各自 `package.json` 的版本号**，`lib/` 与 `.d.ts` 一字不差 |
| `pnpm build` / 2193 条测试 | 全绿，领域代码改动 0 |
| 端到端探针 | `dsh --profile mast-sim` 启动 **10 秒**后 16501–16504 四个端口 LISTENING，同属一个 python 进程 ⇒ `stmsimProvider.apply()` 真的在真实运行时里跑了 |

#### ⚠️ 新事实：**npx 钉版本只钉住启动器，子包照样被 caret 拉到最新**

做包树 diff 时发现的，值得写进 §1：

```
npm i @deepseek-ai/dsh@0.1.5-rc.1   ⇒ 树里 1 个 rc.1（启动器自己）+ 231 个 rc.2
npm i @deepseek-ai/dsh@0.1.5-rc.2   ⇒ 树里 231 个 rc.2
```

启动器对 63 个 `dsh-*` 子包声明的是 `^0.1.5-rc.<n>`，而 semver 的 caret 在**同一个
`[0,1,5]` 元组内**会跨 prerelease 往上取。所以：

> **用 `npx @deepseek-ai/dsh@<旧版>` 去做「新旧对比」，比的不是两个版本** ——
> 两次跑的子包是同一批（最新的那批），只有启动器不同。

这正是「整套精确钉」存在的理由（§1 已有的那条结论的又一个直接证据），也是一条
**升级手册里的操作纪律**：要拿旧版做基线，必须整套钉，不能靠 npx 的版本后缀。

#### 踩到的坑：一个包只进了两张表里的一张

`@deepseek-ai/dsh-attachment` 一直在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里，
**却不在 `overrides` 里**。于是这次 sed 把两张表都从 rc.1 换成 rc.2 之后，它的 caret
就地停在 rc.1——锁文件里同时出现两个版本。

`pin.test.ts` **当场抓住了**（"锁文件里每个 `@deepseek-ai/dsh*` 都恰好是锁定版本"），
这是整套精确钉的唯一执法者第一次真的执法。修法是把它补进 `overrides`。

**教训升级一格**：上一版记的是「钉版散落在三处，一起换」；这一版要加一句
——**三处的成员表必须一致**。一个包只出现在其中一张表里，就是一处没人执法的钉。

### 8.-1 alpha.1 → **0.1.5-rc.1**（2026-09-10 实测）

**这一版把 0.1.5 推上了稳定通道**：`latest` 与 `next` 都是 `0.1.5-rc.1`，而 `alpha` 停在
`0.1.5-alpha.2`（比 rc.1 小）。⇒ 「semver 最大值」与「跟稳定通道」这两条规则**此刻指向同一个版本**，
D11.1 的切换点问题暂时不用回答。

**升级代价：领域代码改动 0，356 条测试一次全绿。** 防腐层的第三次真实考核（前两次是 09-04、09-09）。

| 项 | 结果 |
|---|---|
| `pnpm build` | ✅ |
| `pnpm test`（含 contract 打真包） | ✅ 356/356 |
| 端到端：`dsh --profile mast-sim` 启动后 monitor 端口有 ESTABLISHED | ✅ 23 秒 |
| `--dump-config` 与 alpha.1 逐行 diff | **539 行 → 539 行，只有 10 个 diff 行、2 处变更** |
| 包树 diff | 238 → 240 个包 |

#### 两处配置树变更，**两处都打在我们身上**

1. **默认模型改名：`deepseek-v4-flash` → `deepseek-flash`。**
   ⇒ Phase 3 的 `instrument-control` preset 若要覆盖默认模型行，写的是这个新名字。
   更要紧的是：这条提醒我们**别把模型名写进代码**——它在两周内改过一次。
2. **client 模块改名：`ui-sidebar-textpreview` → `ui-sidebar-documentpreview`。**
   ⇒ 这正是上游 Discussion #5999 的形状（升级既有 profile 时 client combo 缺模块 ⇒
   全部 client 插件失效）。**课时 1.10 建第一个 client 包时，这条是活的风险**，不是历史。

#### 三个包的增减

| 变化 | 包 | 对我们 |
|---|---|---|
| 新增 | `dsh-tool-present` —— *"Scoped tool that declares **filesystem deliveries** in their owning Session"*，带 `maxFiles` 上限 | **直接打在 PLAN §8.3 的图像交付设计上**：我们原本打算自己走 `attachments.save` → `imageRefs`。Phase 3 做 `stm-frame` 节点前先评估能不能直接用它 |
| 新增 | `dsh-chunked-list` —— 追加式持久列表 + JSON checkpoint 校验（用 `zod`） | session 内部件，暂无接触面 |
| 改名 | `dsh-client-ui-sidebar-textpreview` → `…-documentpreview` | 见上 |

#### 升级清单第 6 步（拿既有 `~/.dsh` 冒烟）**没做**，原因如实记录

本机**复制不出一份忠实的 `~/.dsh`**：`profiles/node_modules/@deepseek-ai/*` 全是符号链接
（指向 npx 缓存 `_npx/2f3a729d991ac520`，即 facts §1 说的「npx 缓存是冻结快照」），
而 Windows 上创建符号链接需要提权/开发者模式——`cp -r`、`cp -a`、`robocopy /SL` 三种方式
**都把链接解引用成了真目录**，副本一启动就被 dsh 挡下：

```
Error: dsh: …/profiles/node_modules/@deepseek-ai/dsh exists and is not a symlink
or dsh-managed module proxy; remove it so dsh can manage the installation fallback
```

（顺带：**上游这个检查是好的**——发现该位置不是链接时明确报错并给出处置方法，
而不是默默接管。）

不拿真 `~/.dsh` 直接试，是因为那会改动你正在用的环境且不易回退。
**这一步留作待办**：想做时在开了开发者模式的 shell 里 `robocopy /E /SL` 复制一份再启动；
或者接受风险直接升（该 home 里 `sessions` 是空的，只有 profiles 与 storages）。

### 8.0 rc.1 → 0.1.5-alpha.1（2026-09-09 实测）

**跳过了 0.1.3 与 0.1.4**：0.1.4 从未发布（npm 上不存在），0.1.3-alpha.2 在本机装不上（见下「为什么当时没升」）。
升级清单要求「一次一版」，这次只能一步跨过去——因为中间那一版客观上装不上，不是我们图省事。

#### 阻塞解除了：`fs-ext` 换成 `node-addon-system`

0.1.5 的发布说明写着 "Fix the local compilation requirement introduced by fs-ext **on macOS and Linux**"。
只提了 macOS 与 Linux——而替代品 `@deepseek-ai/node-addon-system@0.1.2` 的 `optionalDependencies` 里
**只有 darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 四个平台包，没有 win32**。

**但 Windows 上装得上也跑得起来**（2026-09-09 实测）：平台包是 `optionalDependencies`，npm 装不到就跳过，
代码有回退路径。全流程绿：238 包、零 node-gyp 编译、`--dump-config` 正常、`--profile web` 启动打印带 token 的 URL、
stderr 空、端口正常释放。
上游 Discussion #6003 报的 `Cannot find module …/node-addon-system-<platform>/bin/system.node` 是**源码检出**
（从 git 跑）的路径，与 npm 安装路径不同——这个区分要记住，别把它当成 npm 路径也坏了。

#### 组合树 diff（rc.1 → 0.1.5-alpha.1）

**145 → 152 行插件行，27 → 26 disabled，30 个 diff 行。** 删 `tool-str-replace-editor`；
新增 `open-in-app` / `ui-open-in-app` / `workspace-files` / `file-upload` / `resources` /
**`ui-sidebar-right` / `ui-sidebar-textpreview` / `ui-sidebar-files`**。
最后三行正是 Discussion #5999 的病灶（升级**既有** profile 时 client combo 缺这些新模块 ⇒ 全部 client 插件失效）。
我们用全新隔离 home 所以没撞上——**这条对课时 1.10 写客户端包时有直接影响**。

#### 破坏性变更与对本计划的影响

| 变更 | 影响 |
|---|---|
| **session 格式 v2 → V3**（历史会话恢复进新日志文件、保留原件；系统提示进消息历史） | 持久真源在我们自己的 SQLite，**零影响**（PLAN §3.1-1 第二次兑现）。新包 `dsh-session-format-v2-to-v3` |
| **agent 插件 API 去掉 `ctx.agent`**，调用方必须显式传 Agent | 打到 §7.8 的编排（supervisor 派发）。当前代码面未用到，Phase 6 兑现 |
| **`Inbox` 变成 type-only interface，`hasPending` / `claim` 移出公开 API** | 打到 §5 能力表里的 `agent/inbox/*`。当前未用到 |
| 新增：**动态系统提示更新不废 KV Cache**（模型需声明支持） | **利好** §7.2「活状态进模型的三条路」之一——我们的 `stm-live-state` 段每轮都在变；spike 第 2 条届时要连这条一起核 |
| 实验性右侧 Sidebar（tabs / 分栏 / 全屏） | 按 PLAN §14「实验性不进主干」处理，仅记录 |

#### 我们的接触面：零破坏

`tsc -b` 与全部 232 条测试**一次通过**。compat 只导出 `defineTool` / `DefineToolOptions` / `Context`，
0.1.5 的三条破坏性变更一条都不碰它们；`@deepseek-ai/cordis` 仍是 `^4.0.2`。
端到端也验了：`dsh plugin --profile web add` 成功、`mast-hello` 进组合树、探针确认 `apply()` 在真实运行时里执行且 `ctx.tools` 是活服务。

#### 已知问题（升级时一并记下，各自标明会在哪一课时打到我们）

| # | 问题 | 何时打到我们 |
|---|---|---|
| **6004** | **安全**：`dsh-storage-json` 0.1.5-alpha.1 legacy bootstrap 未校验 record key ⇒ 路径穿越 / 任意文件写入 | 我们的持久真源是自家 SQLite，不用 storage-json 存要紧数据；但**只要跑 dsh，这个洞就在同一进程里**。仅本机开发用，不对外服务 |
| **5999** | 升级既有 profile 后 client combo 缺新增 bundle 模块（`ui-sidebar-*` 404）⇒ 全部 client 插件失效 | **课时 1.10**（第一个客户端包）。全新 profile 不受影响 |
| **5983** | 自定义 provider 在 web UI 里被藏起来、加不了（`llm-pi-ai` namespace 未在 `settings/describe` 暴露） | **Phase 3** §7.7 注册 Kimi/Qwen/GLM 时 |
| 5979 / 5978 | 会话历史冷读失败、v0 迁移校验过度严格 | 我们无历史会话；升级**既有** `~/.dsh` 的人会撞上 |
| 6012 | preset roster 健康扫描无缓存，一个装不上的 preset 就把一个核吃满 | **Phase 6** 挂 8 个 preset 时 |
| 5998 | minimal preset 的持久 pwsh 在控制台换行处输入被截断（`Write-Output` → `rite-Output`） | 我们的工具不依赖 shell（§3.1-8），不受影响 |

⇒ `latest` / `next` 至今仍是 `0.1.2-rc.1`（六天没动）。**0.1.5-alpha.1 是 alpha，按它开发要有心理准备**；
我们能升是因为接触面小，不代表它稳。

### 8.0-历史 · 为什么当时没升 0.1.3-alpha.2（2026-09-07 记录，已被 0.1.5 取代）

#### 阻塞：本机装不上

```
@deepseek-ai/dsh-session-persistence-jsonl@0.1.3-alpha.2
  └─ dependencies: fs-ext@2.1.1        ← 硬依赖（不是 optionalDependencies），精确钉
       └─ scripts.install: node-gyp configure build     ← 无预编译，每次安装现场编译 C++（依赖 nan）
```

对照 `0.1.2-rc.1`：同一个包当时只依赖 `koffi` 与 `@deepseek-ai/schemastery`，**没有任何需要编译的东西**。
`fs-ext` 提供 `flock`，正对应发布说明里「session 加锁，一个进程最多持有一个 session」。

**三次实测（09-07）**：

| 做法 | 结果 |
|---|---|
| `npx -y @deepseek-ai/dsh@0.1.3-alpha.2 --dump-config` | 失败。npm 回滚时撞文件锁刷 `EPERM cleanup` 警告，掩盖了真正原因 |
| `npm i @deepseek-ai/dsh@0.1.3-alpha.2` | 失败：`gyp ERR! Could not find any Visual Studio installation to use`，整棵树回滚，`node_modules/@deepseek-ai` 为空 |
| `npm i --ignore-scripts` 后启动 | 装得上（536 包 / 32 s），`--dump-config` **能正常导出**；但 `--profile web` **在插件树加载阶段就崩**：<br>`plugin tree failed to load: failed to import loader entry session-persistence-jsonl: Cannot find module './build/Release/fs_ext.node'` |

⇒ `--ignore-scripts` 只够拿来导规格做 diff，**不能当开发环境**。
本机确认：无任何 Visual Studio / MSVC（只有 Windows Kits 8.1，不含编译器）；PATH 里的 `python` 是 Microsoft Store 转发桩。

#### 不是我们一台机器的问题：社区已多方复现，且 0.1.3-alpha.2 还有别的启动崩溃

**`deepseek-ai/deepseek-harness` 关闭了 Issues，反馈渠道是 GitHub Discussions**（`Announcements / General / Ideas / Polls / Q&A / Show Your Plugins!` 六个分类）。npm 包 `bugs.url` 指向的 `/issues` 是个死链。截至 2026-09-08 查得：

| # | 日期 | 分类 | 标题 | 与我们的关系 |
|---|---|---|---|---|
| **5929** | 09-08 | General | `fs-ext@2.1.1` 无预编译二进制，强制本地 MSVC 编译 | **与我们的实测完全一致**且写得更全（逐包核对了依赖链、贴了 registry 元数据）。0 条评论、无官方回应 |
| 5882 | 09-07 | General | Windows 上 0.1.3-alpha.2 安装失败了 | 评论里给了 VS 2022 生成工具的装法，并指出**第二道坎**：编译过了还会撞 `LNK1181: 无法打开输入文件 DelayImp.lib`。也指出 `dsh-session-persistence-jsonl` 顶层 `import { flock } from "fs-ext"`，而 **Windows 的会话锁其实走 win32 信号量**——即模块加载期的 `require` 是白付的代价。pnpm 10+ 默认不跑依赖 `install` 脚本，要 `pnpm approve-builds -g` 放行 |
| 5784 / 5751 / 5638 / 5689 | 09-04 – 09-06 | Q&A | 同一问题的四份独立报告（含「我还需要系统级 Python 吗」） | 说明这是 alpha 线的普遍回归，不是个例 |
| **5881** | 09-07 | General | 0.1.3-alpha.2 装有第三方 `dsh-file-upload` 时启动即崩：`duplicate loader entry id: file-upload` | **直接印证我们的组合树 diff**——`file-upload` 在 0.1.3 并进了 web-app bundle，而加载器把重复 id 从「lint 警告」改成了**致命错误**。⇒ 我们自己的 `cordis.patch.yml` 只 `insert` 自家 id 时，**必须确保 id 不与将来并进 base 的行撞名**（PLAN §6.3 的 `mast-*` 前缀正是为此，继续保持） |
| 5753 | 09-05 | General | 0.1.3-alpha.1 老会话打不开：v0 迁移拒绝 `subagent/descriptor` version 2 | **session v2 迁移本身是坏的**。⇒ 升级清单第 6 步（备份 `~/.dsh` + 拿既有 home 冒烟）不是形式主义 |
| 5889 | 09-07 | General | 0.1.3-alpha.2 启动崩溃：connection 的 rpc 通道注册访问未声明的 `owner.webServer` | 又一处独立的启动崩溃 |
| 5913 | 09-08 | Q&A | `dsh-llm@0.1.3-alpha.2` 发布的依赖里缺 `dsh-attachment` 与 `dsh-invariants` | 发布物本身不完整 |

⇒ **0.1.3-alpha.2 至少有四处相互独立的启动/安装故障**，`latest`/`next` 也仍停在 rc.1。这不是「我们的机器缺工具链」，是这一版还没熟。

#### 组合树 diff（rc.1 → alpha.2，共 20 个 diff 行）

**145 → 147 行插件行，27 → 26 disabled**。逐条与四处变更见 `spec/dsh/README.md`：删 `tool-str-replace-editor`、`persona` 拆成
`personaPrefix`/`personaSuffix`、新增 `open-in-app`＋`ui-open-in-app`、新增客户端 `file-upload`。
新包 `dsh-http-proxy` **不在组合树里**——它是启动器在进程级装的 undici 全局 dispatcher。

#### 对本计划的影响（升级时兑现，现在不改代码）

| 变更 | 类型 | 对 dsh-spm 的影响 |
|---|---|---|
| **session 格式 v0/v1 → v2**，带「相邻代不可变迁移」，旧日志自动转换 | **破坏性** | `SESSION_FORMAT_VERSION` 的 "Remove at the first tagged release" 兑现了（§1 一直在等这件事）。**对我们的持久数据零影响**——PLAN §3.1-1 早就把真源放进自己的 SQLite，session log 与投影缓存可丢。这是那条决策的第一次兑现 |
| **session 持久化 API 归 `SessionHandle`（生命周期作用域）；`agentLoop.create()` 变异步；session 加锁，一进程最多一个** | **破坏性** | `compat/session` 的暴露面要重画；spike 第 10 条（`ctx.agents.resume` API 名、子会话读父 session id）要照新 API 重写。**「一进程一 session」要验一件事**：§7.8 的 supervisor 用 `subagent` spawn-in-process 派发子 agent，若锁是「一进程一 session」，同进程内的子会话怎么算——0.6 spike 必须钉死 |
| persona 配置拆成 **prefix / suffix 两段** | **破坏性** | 8 个 preset 的 `persona` 子插件跟着拆；`minimal` preset 的 `complete: true` 语义重核 |
| subprocess 句柄不再带 PID（终端句柄不受影响） | **破坏性** | PLAN §7.1 是我们自己 `child_process` spawn stmsim，不受影响；若 1.7 改走 dsh 的 `subprocess` 服务则要按新语义写 |
| SDK/Headless/ACP 默认工具改用 read/write/edit | 默认值 | 我们不用这三条路；组合树里表现为删掉 `tool-str-replace-editor` 行 |
| **新包 `dsh-http-proxy`：进程级出站代理策略，认 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`，装成 undici 全局 dispatcher** | 功能 | **`mast-rig` 多了一个比 `restrict({deny: web_fetch})` 更硬的出站闸**：进程级、覆盖插件自己发的请求，不依赖模型工具面。Phase 8 评估 |
| continuable 子 agent 支持消息排队/编辑/删除/steer；Agent Team `send_message` 统一 steer 语义并保留发送者归属 | 功能 | §7.8 supervisor→IC 的追问路径更稳；「插话 = composer `steer()`」得到上游支持 |
| **DeepSeek 流式 tool call 跨续块丢 id/name 的修复** | 修复 | 与 §3.2-12「带工具调用一律不流式」同源的坑。上游修了 DeepSeek 侧，**我们的纪律不改**——Kimi 受限解码把 `3e-12` 截成 `3` 是另一个独立问题 |
| 手动暂停目标立即终止当前模型轮次 | 修复 | §7.8 目标双门（Gate 1 inject + cancel）可参考其语义 |
| Windows 本地非终端子进程不再弹控制台窗口；Windows/Linux 进程清理改进 | 修复 | 1.7 起停 stmsim 直接受益 |
| pi-ai 升到 0.85.1，多支持一批模型 | 功能 | §7.7 的 Kimi/Qwen/GLM 自写适配器决策先不动，0.1.3 升级后复核目录里多了什么 |
| 已知回归：部分历史会话加载变慢（官方称下个版本修） | 风险 | 我们无历史会话，无影响 |

### 8.1 alpha.4 → alpha.5 → rc.1（发布说明 09-02 / 09-03 + 实测 09-04）

**alpha.5（09-02，纯修复）**：修「从 `0.1.1-rc.2` 或 `0.1.2-alpha.3` 升级后应用起不来 / 会话标题消失」。
⇒ 这是**升级会损坏既有 `~/.dsh` 数据**的实证，直接支持 PLAN §3.1-1「持久真源放 SQLite 不放 session log」，并给升级清单加了第 5 步（拿既有 home 冒烟）。

**rc.1（09-03）**是 0.1.2 全线的 roll-up，同时占 `latest` 与 `next`。与我们有关的条目：

| 变更（发布说明要点） | 类型 | 对 dsh-spm 的影响 |
|---|---|---|
| Windows 路径被截断的修复 | **修复** | 我们全程 Windows 开发，直接受益；`spec/` 与 `artifacts` 路径不再需要额外提防 |
| Agent Preset 丢失的修复 | **修复** | 8 个 preset 是 §7.8 的载体，这条必须是好的 |
| Python SDK 支持 Windows x64 | 功能 | 与 PLAN §3.1-13 一致（SDK 只是驱动器、不用它做 HITL 测试），但差分跑手若走 SDK 路径可用 |
| 默认公开 WebFetch + SSRF 防护 | 默认值 | 强化 alpha.4 那条：IC/conduct preset 的 `restrict({deny})` **必须**显式列 `web_fetch` |
| 实验性 Inspector 与 Web Preview 工具 | 功能 | 未评估；按 PLAN §14「实验性不进主干」处理，仅记录 |
| subagent 模型选择能力 | 功能 | §7.8 supervisor 派发时可给不同 agent 配不同模型（IC 便宜、RD 贵），Phase 6 复评 |
| 请求里带插件元数据；可选 session-log 上传 | 功能 | **隐私面**：真机 profile 要与遥测一起决定是否关（§2 遥测条目） |
| 统一 `dsh` profile 启动；URL token 认证 | 改进 | 与 §2、§4 已记录的行为一致 |
| 连接状态显示与自动重连；长对话渲染效率 | 改进 | U0 的 SSE 卡片可参考其重连语义 |
| 启动/初始化优化、磁盘占用下降、文件系统检查减少 | 改进 | 无 |

- **核实记录（09-04）**：web profile `--dump-config` 在 alpha.4 与 rc.1 上**逐行相同**（145 行 / 27 disabled）⇒ §3 的组合树事实、§5 能力表、§6 陷阱在 rc.1 上未发现失效项。`SESSION_FORMAT_VERSION` 仍为 0。逐条 API 级复核仍由 0.6 spike 的 contract 测试承担。

### 8.2 alpha.3 → alpha.4（发布说明 2026-09-01 + 实测 09-02）

| 变更（发布说明要点） | 类型 | 对 dsh-spm 的影响 |
|---|---|---|
| 父 agent 与 continuable 子 agent 通过 `send_message` 双向通信，替代单向 `report` 工具 | 功能 | PLAN §7.8 编排本就按 `send_message` 追问设计；supervisor→IC/DP/XD 的 continuable 路径不变 |
| `Session.events` 改为按需读 API `seq`、`eventAt()`、`snapshotEvents()`；`SessionSeq` 与 `SessionLogOffset` 强类型分离，"developers should pay attention to compatibility" | **破坏性** | 计划里没有直接读 `Session.events` 的设计（投影走 `sessionProjections`，UI 实时走自建 SSE）；compat 的 `compat/session` 只暴露投影与这三个读 API |
| `web_fetch` 对 Python SDK / Headless / ACP / **自定义 profile** 默认开启 | 默认值 | `mast-sim` / `mast-offline` / 将来的 `mast-rig` 都是自定义 profile ⇒ IC/conduct preset 的 `restrict({deny})` 要显式列 `web_fetch`（真机 profile 默认不给模型上网） |
| Web PTC 模式默认不再暴露通用 `workflow` 工具 | 默认值 | 与 PLAN §14 非目标一致（不用 workflowEngine 做主干） |
| 模型目录搜索/过滤；复用 profile 请求头做自定义模型发现 | 改进 | `llm-providers` 注册 Kimi/Qwen/GLM 后应出现在目录里，Phase 3 顺手核 |
| UI 细节与长对话渲染性能 | 改进 | 无 |

- **核实记录**：web profile `--dump-config` alpha.3 vs alpha.4 逐行相同（145 行 / 27 disabled）；npx 缓存两棵树的 `.md/.d.ts/.yml` 逐文件相同（原因见 §1：alpha.3 启动器已浮动到 alpha.4 子包）。因此 09-01 按 alpha.3 时代文档核实的 §5 能力表与 §6 陷阱在 alpha.4 上未发现失效项；逐条 API 级复核由 0.6 spike 的 contract 测试承担。
