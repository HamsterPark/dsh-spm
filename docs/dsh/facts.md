# dsh 事实速查 —— 对照 `@deepseek-ai/dsh` **0.2.1-rc.4**（2026-10-28 升级并核实）

> **阅读方式**：本文按调查与升级日期累积，早期章节中的“当前”“本次”指该节记录时点。实际依赖以 [compat manifest](../../packages/host/compat/package.json) 和锁文件为准；版本决定按 [升级策略](upgrades.md) 的最新修订理解。项目当前可运行范围见 [文档导航](../README.md)，不从某次上游探针结果推断全部插件能力。

> **2026-10-28 升级到 `0.2.1-rc.4`**（`next` 通道；同日 `latest` = `0.2.1-rc.2`，`alpha` = `0.2.2-alpha.2`）。
> 这是一步直达：从 `0.1.5-rc.2` 越过 0.1.6、0.1.7、0.2.0 与 0.2.1 的全部预发布版；理由与逐项结果见 [升级日志](upgrades.md) 的 2026-10-28 条。
> **compat 接触面**：12 个包（`dsh-agent` / `dsh-agent-loop` / `dsh-attachment` / `dsh-commands` / `dsh-host-webserver` / `dsh-llm`
> / `dsh-session` / `dsh-session-persistence` / `dsh-session-projection` / `dsh-settings` / `dsh-system-prompt` / `dsh-tools`）
> 在 0.2.1-rc.2、rc.3、rc.4 之间**逐文件相同**，但相对 0.1.5-rc.2 有实质变化：会话 V4、工具结果独立成 `role: 'tool'` 消息、快照来源改名等，见 §8.-9 至 §8.-5。
> 组合树：web 组合 **191** 个顶层行（0.1.5-rc.2 为 152），headless 组合 98 个。领域代码只动了 **1 处**（`stm-ui` 的投影来源判定，单独提交）。
> **`0.2.2-alpha.2`（10-27）按切换点规则只读不升，影响记在 §8.-13**——它不是版本串替换，而是一次迁移。
>
> 本文是 dsh-spm 里**唯一**记录 dsh 版本相关事实的地方；每次按 `docs/dsh/upgrades.md` 升级都要重核并改上面的版本号。
> 每条标注来源：**实测** = 本机跑出来的；**包** = 读 npm 包内文件；**文档** = GitHub 仓库 docs（2026-09-01 抓取，站点是 SPA）；**发布说明** = dsh 的 GitHub 发布说明；**讨论** = 上游 Discussions 帖子（以帖子编号引用，2026-10-28 抽查过标题）；**待核** = 课时 0.6 spike 才有结论。
> 决策与设计后果不写在这里，写在 `docs/PLAN.md`（其 §3.1 编号与本文 §6 对齐）。

## 1. 版本与发布节奏（实测 2026-09-04；0.1.5-alpha.1 之后的行按 2026-10-28 的 `npm view @deepseek-ai/dsh time` 补全，日期为 UTC）

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
| **0.1.5-alpha.1** | **09-08** | 09-09 起锁定。`fs-ext` → `node-addon-system`（阻塞解除）；session **V3**；去掉 `ctx.agent`；`Inbox` 变 type-only；变更与已知问题见 §8.0 |
| 0.1.5-alpha.2 | 09-09 | `alpha` 标签的落点，见 §8.-1 |
| 0.1.5-rc.1 | 09-10 | 同时占 `latest` 与 `next`；见 §8.-1 |
| 0.1.5-rc.2 | 09-10 | 09-13 起锁定，到 10-28 升级前的最后一个锁；见 §8.-2 |
| 0.1.5-rc.3 | 09-22 | 晚于 0.1.6 的两个 alpha 发布；npm 与 git 标签有，**没有 GitHub Release**；相对 rc.2 只钉了 vendor 依赖，见 §8.-5 |
| 0.1.6-alpha.1 / alpha.2 | 09-15 / 09-17 | **没有稳定版**，内容并入 0.1.7-rc.1；见 §8.-6 |
| 0.1.7-alpha.1 / alpha.2 | 09-22 / 09-22 | **会话 V4**（alpha.1）、dsh 系内部依赖精确互钉（alpha.2）；见 §8.-7 |
| 0.1.7-rc.1 / rc.2 | 09-23 / 09-24 | 发布说明在 rc.1 里汇总了自 0.1.5-rc.3 以来的全部变化 |
| 0.2.0-rc.1 / rc.2 | 09-28 / 09-29 | 对 compat 接触面很小，见 §8.-8 |
| 0.2.1-alpha.1 … alpha.5 | 10-03 / 10-09 / 10-14 / 10-15 / 10-16 | 见 §8.-9、§8.-10 |
| 0.2.1-rc.1 / rc.2 | 10-17 03:17 / 08:36 | rc.2 是今天 `latest` 所指 |
| 0.2.1-rc.3 | 10-23 | 见 §8.-11 |
| **0.2.1-rc.4** | **10-26** | **当前锁定**（10-28 升）。相对 rc.3 只有 ACP 诊断输出与界面提示的修复，见 §8.-12 |
| 0.2.2-alpha.2 | 10-27 | 目前 0.2.2 只有这一个版本；只读不升，见 §8.-13 |

- **dist-tags（2026-10-28 实测）**：`latest` = `0.2.1-rc.2`，`next` = **`0.2.1-rc.4`**，`alpha` = `0.2.2-alpha.2`。**追踪对象不是某个固定 tag，而是所有 dist-tag 里 semver 最大的那个**（PLAN D11、`upgrades.md`；2026-09-13 起改为只升 `latest` / `next` 两条稳定通道里较大的，alpha 只读）：09-04 时 rc.1 比 alpha.5 新、盯 `alpha` 会落后；09-07 反过来；今天 `latest` 又落后 `next` 两个 rc。按版本号比大小，别信标签名。裸 `npx @deepseek-ai/dsh` 会装到 `latest`，但仍然**所有命令必须带版本**，而且光带版本也不够（见下两条）。
- **prerelease 上的 caret 会跨通道，但只在同一 `x.y.z` 元组之内**：启动器 `dsh` 对自己的 `@deepseek-ai/*` 依赖声明 `^0.1.2-<pre>`（`dsh-base` 84 个、`dsh-web-app` 70 个、`dsh-tools` 的 peer 同样是 `^`），而 `^0.1.2-alpha.4` 的语义是 `>=0.1.2-alpha.4 <0.2.0`，**同一 `0.1.2` 元组下 `rc.1` > `alpha.5` > `alpha.4`，所以 alpha 范围会吃进 rc**。09-04 实测：全新 `npm i @deepseek-ai/dsh@0.1.2-alpha.4` 装出 **1 个 alpha.4 启动器 + 213 个 `0.1.2-rc.1` 子包**。
  **但它不会跨到 `0.1.3`**（09-07 实测确认）：semver 规定预发布版本只匹配范围里**元组相同**的比较符，`0.1.3-alpha.2` 的元组 `[0,1,3]` 既不等于 `>=0.1.2-rc.1` 的 `[0,1,2]` 也不等于 `<0.2.0` 的 `[0,2,0]` ⇒ 钉 `0.1.3-alpha.2` 装出的树里 **223 个 `@deepseek-ai/dsh*` 全部恰好是 `0.1.3-alpha.2`，零例外**（`spec/dsh/pkglist.0.1.3-alpha.2.txt`）。**结论不变**：仍然必须整套精确钉（PLAN D11、§6.3），[`pin.test.ts`](../../packages/host/compat/contract/pin.test.ts) 断言锁文件里每个 `@deepseek-ai/dsh*` 恰好是锁定版本——minor 之间干净不代表 patch 之内干净，而 dsh 大部分时间都在同一个 patch 元组里滚。
- **npx 缓存是冻结快照，会掩盖漂移**：09-02 建的 alpha.4 缓存树里 214 个子包都还是 alpha.4，同一天建的 alpha.3 树里 213 个子包是 alpha.4；rc.1 树 214 个全是 rc.1。本地跑着「没事」不代表 CI 或别人装我们的插件时没事——**漂移只在全新安装时发作**。
- **0.1.7-alpha.2 起，dsh 系的内部依赖是精确版本**【实测 2026-10-28】：在空目录里解析 `@deepseek-ai/dsh@0.2.1-rc.4`，296 个 dsh 系包恰为同一版本，零例外（`spec/dsh/pkglist.0.2.1-rc.4.txt`）。漂移转到了独立版本线：Cordis 系与 `node-addon-system` 声明的是 `~` 补丁范围，`libreoffice-kit` 是 `^0.1.5`，`zod` 自 0.2.1-alpha.3 起被精确钉在 4.4.3（此前是 `^4.4.3`，发布说明没提）。所以整套精确钉的理由变了：不再是「dsh 系子包会漂」，而是「独立版本线会漂，而两份 zod 会让 `tsc` 吃满堆内存后崩溃、却不报任何 TS 错误」。成员表由 `pnpm gen:dsh-pins` 从锁文件生成，`pin.test.ts` 核对表、各 manifest 与锁文件三者一致。「npx 缓存是冻结快照」那一条对 dsh 系已不再成立，对独立版本线仍成立。**停在旧锁也会腐化**：今天全新解析 `@deepseek-ai/dsh@0.1.5-rc.2` 得到 1 个 rc.2 启动器加 230 个 rc.3 子包，并同时出现两份 cordis（4.0.2 与 4.0.5）【实测 2026-10-28，见 §8.-5】。
- Cordis 系是独立版本线。0.2.1-rc.4 所用：`@deepseek-ai/cordis` 4.0.5、`cordis-plugin-include` 1.0.10、`cordis-plugin-loader` 1.0.6、`cordis-plugin-timer` 1.1.7、`cordis-plugin-group` 1.0.5（新增）、`cosmokit` 1.8.6、`schemastery` 3.18.5；`cordis-plugin-hmr` 已由 `dsh-hmr` 取代。0.1.5-rc.2 时是 `cordis` 4.0.2、loader 1.0.3、include 1.0.7、timer 1.1.4、`cosmokit` 1.8.3、`schemastery` 3.18.2。
- `SESSION_FORMAT_VERSION` 在 rc.1 里**仍是 0**（包内实测），源码注释 "Remove at the first tagged release"。**09-07 兑现了**：`0.1.3-alpha.1` 把会话格式升到 **v2**，带「相邻代不可变迁移」，v0/v1 自动转换（§8.0）。预测对了，但落点不是 0.1.2 正式版而是下一个 minor 的 alpha。⇒ 升级清单第 6 步（拿**既有** `~/.dsh` 冒烟、先备份）在升 0.1.3 那次必须一步不省。
  **现在是 4**【包 2026-10-28，`dsh-session` 的 `SESSION_FORMAT_VERSION`：0.1.5-rc.2 与 0.1.6-alpha.2 为 3，0.1.7-rc.2 起为 4】：V4 的工具结果是独立的 `role: 'tool'` 消息；0.2.1-alpha.3 起事件目录里多了 `job/registered`、`job/settled`，**0.2.0 读不了含它们的会话**，所以升级之后不能无损回退（§8.-9）。迁移链 v0→v1→v2→v3→v4 各是一个 `dsh-session-format-v<N>-to-v<N+1>` 包。升级清单第 6 步仍然一步不能省，而且迁移单向。

## 2. 运行环境（实测 2026-09-02，rc.1 于 09-04 复测，Windows 11；2026-10-28 补写的条目带「rc.4」或日期标记，其余仍是当时的记录）

- Node v24.14.0、npm 11.9.0、corepack 0.34.6、git 2.53（10-28 本机仍是 Node 24.14.0）。dsh 的 README 当时要求 Node ^22.19 || ≥24，pnpm 11.7（`packageManager`）；10-28 按标签 `dsh-v0.2.1-rc.4` 核对：上游根 `package.json` 是 `engines.node ^22.19.0 || >=24.0.0`、`packageManager pnpm@11.28.5`（我们仍是 pnpm 11.7.0，不受强制），而发布的 `@deepseek-ai/dsh` 包本身**没有** `engines.node`；**0.2.2-alpha.2 起声明 `>=24.9.0`**，见 §8.-13。
- `corepack enable pnpm` **EPERM**（要往 `C:\Program Files\nodejs` 写 shim）；用 `corepack enable --install-directory %APPDATA%\npm pnpm` 装到用户级目录（已在 PATH，新终端可用，默认 11.25.0；进仓库后由 `packageManager` 钉 11.7.0）。
- npx 缓存：alpha.3 树 `%LOCALAPPDATA%\npm-cache\_npx\8be755d04d6547a7\`、alpha.4 树 `…\_npx\2145f1867deb72cf\`、**rc.1 树 `…\_npx\2f3a729d991ac520\`**（各 223 个 `@deepseek-ai/*` 包）。每棵树的子包版本见 §1 第三条。
- **rc.1 在 Windows 上启动正常**（09-04 实测）：`--dump-config` 与 `--profile web --no-open` 都正常，端口 3080 照常打印带 token 的 URL。
- `~/.dsh/`：`.credentials.yaml`（`refs` 存密钥、`records` 存插件记录；settings UI 写入；文件变更自动重载）、`.anonymous-user-id`、`profiles/web/`（**profile 本身是 pnpm 项目**：`package.json` 只有 `dsh.profile.bundles: [dsh-base, dsh-web-app]` 与 `patchReload: live`，`dependencies: {}`；`cordis.yml` 是空根 `[]`；`cordis.patch.yml` 是用户 patch 层；`node_modules/` 放树外插件）。bundles 先从 dsh 安装目录解析，再从 profile 的 `node_modules`。
- **密钥解析顺序**（`dsh-credentials-local` README）：**0.2.1-alpha.3 起改了**。0.1.x 是「启动环境 > `~/.dsh/.credentials.yaml` > `<cwd>/.env` > `~/.dsh/.env`」；现在是「已保存的 `.credentials.yaml` > 启动环境 > `<cwd>/.env` > `$DSH_HOME/.env`」，新保存的值立刻压过旧的环境变量值（发布说明：「API Key 读取优先级变更」；rc.4 README 写明这是 2026-10-09 的决定）。启动后再导出的环境变量仍然看不到——环境层是启动时的快照。**headless 不读已保存的凭据，只读启动环境与 `.env`**（同一版起；`credentials`、`authorization`、`deepseek-account` 三行在 headless 补丁里 `disabled: true`【实测，`spec/dsh/dump-config.headless.0.2.1-rc.4.yml`】）。DeepSeek 的变量名默认 `DEEPSEEK_API_KEY`（`llm-deepseek-api-key` 的 `apiKeyEnv` 缺省值，`web-deepseek-api` 行同）。产品绝不把凭据文件路径交给 agent，但 agent 的工具进程以同一 OS 用户运行、文件权限挡不住。⇒ 用隔离 `DSH_HOME` 做验收时（本仓的 `minimal` profile 不带 headless 补丁，`credentials` 行是启用的），该 home 里的 `.credentials.yaml` 优先于启动环境里的 `DEEPSEEK_API_KEY`；真实 home 里的凭据文件读不到。
- `dsh --profile web --no-open` 打印 `http://127.0.0.1:3080/?token=…`；**无 token 一律 401**（`/api` 浏览器信任栅栏，`--trusted-host` 可加）。启动目录 = 默认 workspace 根（`sandbox-policy.workspaceRoot = process.cwd()`）。
- **遥测与会话日志上传是两套设置**【组合树 + 包 README，2026-10-28】：
  - `session-telemetry-otel` 缺省 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY`（用户明确提交反馈时才放出会话前缀），端点 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`（`DSH_TELEMETRY_OTLP_URL` 可改；0.1.5 时是 `harness-telemetry…` 域名）；合法模式 `FEEDBACK_ONLY` / `DISABLED`。`DSH_TELEMETRY_DISABLED`（任意非空值）由启动器在运行时把这一行补成 `disabled: true`，**`--dump-config` 不应用它**，所以快照里看不到。headless 没有反馈界面，按设计不会触发反馈外发【推断】。桌面产品遥测（`product-analytics`、`desktop-product-telemetry`）只在 profile 名为 `desktop` 时启用。
  - **`session-log-deepseek` 自 0.1.6-alpha.1 起缺省开启**（`enabled: true`，`maxBytes` 8 MiB；0.1.5-rc.2 与 rc.3 上是 false）：对**官方 DeepSeek API** 的每个请求附带 `dsh_session_log` 字段，内容是会话日志的增量，**含工具结果**，不进模型输入；`DSH_TELEMETRY_DISABLED` 管不到它，要在配置里写 `enabled: false`（Web 设置页「使用官方模型 API 时上传会话日志」是同一个开关）。headless 里它也在。
  - 真机 profile 要决定两者是否都关。
- 关闭启动它的终端/任务不一定杀掉 node 子进程，端口会继续占着（实测 EADDRINUSE）⇒ 重启前 `netstat -ano | findstr :3080` + `taskkill /F /PID`。强杀 dsh 本身无害（它不是 Nanonis）。

## 3. web profile 组合树（实测 `--dump-config`）

> **当前锁定的 0.2.1-rc.4：web 组合 191 个顶层行（23 个无条件 `disabled: true`）、1231 行；headless 组合（`dsh-base` 加 `dsh-headless`，不含 preset）98 个、382 行**
> （0.1.5-rc.2 是 152 个、539 行、26 个 disabled）。行数与名单以 `spec/dsh/dump-config.0.2.1-rc.4.yml` 与 `dump-config.headless.0.2.1-rc.4.yml` 为准。
> 下面按 0.1.2 写的分组与结构大体仍成立；**已失效的细节在条目里直接改写**，逐版变化见 §8。

- 0.1.2 三版（alpha.3 / alpha.4 / rc.1）**逐行相同**：**145 行插件行**，27 行 `disabled: true`；来源三段：`dsh-base`（约 90 行）→ `dsh-base, patched by dsh-web-app`（9 组被 web-app 改写）→ `dsh-web-app`（宿主 API 控制器、webserver、约 45 个 `dsh-client-ui-*` 客户端模块）。导出件已入仓 `spec/dsh/dump-config.<version>.yml`（alpha.3 / alpha.4 / rc.1 三份，逐字节相同；见该目录 README）。
- 分组（rc.4 web 组合）：LLM（`llm`、`llm-deepseek`〔现指向 `dsh-llm-deepseek-api-key`〕、`llm-deepseek-account`、`llm-pi-ai`、`llm-retry`、`agent-default-model` = `deepseek-official/deepseek-flash`）；会话（`session`、`session-log-deepseek`、`session-persistence-jsonl` → `~/.dsh/sessions`、`session-query-sqlite` `:memory:`、`session-projection` + cache、`session-title*`、`session-checkpoint-policy`）；agent（`agent`、`agent-loop`、`agent-preset-registry` default `standard`、`agent-instructions`、`system-prompt`——默认配置只剩 `personaPrefix`，`persona` 与工作目录都挪走了，见 §8.-9）；工具（`tools` 注册表、`tool-*` 行、`timeout-policy`、`repeat-tool-reminder`、`spill-local` + `spill-policy` 的 `maxInlineTokens: 12500`〔估算 token，文字约 50,000 字符，图像另计，见 §9.1〕、`image-offload`、`tool-working-directory`〔模型可见 `working_directory`〕）；沙箱与审批（`sandbox-policy` `workspace-write`、`bash-sandbox` win32 禁用 / `pwsh-sandbox` 非 win32 禁用、`approval` policy `ask`（`DSH_PERMISSION_MODE=danger-full-access` ⇒ `never`）、`permission` 三预设）；`jobs`（local）、`subagent` + spawn/fork provider、`storage`（json → `~/.dsh/storages`）+ `storage-domain`、`credentials`、`settings`〔现指向 `dsh-settings`，设置存进当前 profile 的插件配置〕、`skill` 注册表、`commands`、`goal` + round driver、`token-meter`、`web`（DeepSeek 搜索 + http fetch）与 `web-deepseek-api`、`subprocess`、`shell-env`、`working-directory`、`workspace`、`hmr`〔取代 `cordis-plugin-hmr`〕、`remote-access`、`message-feedback`、`session-log-export`、遥测（`otel`、`session-telemetry-otel`）。`code-runtime`、`agent-presets`、`skill-badge`、`tool-ralph` 四行在 rc.4 里已不存在【实测，对比 0.1.5-rc.2 快照】。
- **关键结构（实测，rc.4）**：`dsh-web-app` 在宿主层把全部模型可见工具行设为 `disabled`（`tool-bash/pwsh/fs/jobs/skill/goal/subagent*/workflow`、`skill-filesystem`、`compaction-basic`、`tool-result-pruner`、`tool-plugin-manager` 等），由 **agent preset 在 agent 平面重新挂载**。0.1.5 的做法是 `@deepseek-ai/dsh-agent-presets/presets/<name>/agent.cordis.yml` 目录；**0.1.7 起预设改由组合包声明**：`dsh-web-app` 的 patch 里有一行 `agent-preset-registry`（`default: standard`）和四行 `@deepseek-ai/dsh-agent-preset`（`preset-standard`、`preset-ptc`、`preset-minimal`、`preset-cordis`，配置是 `id`、`order` 与嵌套的 `plugins:` 清单：standard 22 项、ptc 23 项、minimal 4 项、cordis 23 项，不计组内子项）。注册表不扫目录，也不收预设路径；旧目录预设需要迁移（发布说明）；新增或覆盖预设是对 `@deepseek-ai/dsh-agent-preset` 行的 `insert` 或按 id 的 patch。0.1.5 的 preset 文件注释里的规则，rc.4 的 README 仍写着：**提供服务的行与它的使用者必须放进同一个带 `isolate` 的 `cordis:group`**（快照里 `planning`、`compaction`、`delegation`、`persistent-shell` 都是这种组）；工具行注册进宿主 `tools` 注册表、不提供服务时不需要 realm。其余几条（`tokenMeter`/`subagents` 注册表/`shell-env`/`fs` policy 留在宿主平面等）未重核。
- `standard` 内容（rc.4 快照）：persona、agent-instructions、time-context、tool-bash/pwsh（按平台）、tool-fs、tool-fs-search、tool-jobs、tool-schedule、skill-filesystem、tool-skill、command-goal、tool-goal、`planning` 组（isolate；`plan-mode`）、`compaction` 组（isolate；`compaction-basic`、`command-compact`、`tool-result-pruner`）、`delegation` 组（isolate；subagent-control、list-agents、`subagent`、`subagent_fork`、`workflow-ptc`、tool-workflow）、tool-ask-user、tool-todo、tool-web、present、tool-plugin-manager、tool-plugin-market。`ptc` 多一个 `tool-presentation`；`cordis` 多一个 `tool-cordis`。`minimal`：persona `complete: true`、`includeRuntimeContext: false`，`tool-fs` 只开 `readImage`（`read` / `write` / `edit` 关），一个 `compaction` 组，一个持久 shell 组（`dsh-terminal` + bash）；没有 `fs-local` 遮蔽，也没有 `str-replace-editor`。**headless 组合不用 preset**：工具仍是顶层行，`compaction-basic`、`image-offload` 在顶层挂着，`tool-working-directory` 默认启用。

## 4. 三层组合与 CLI（包内 `@deepseek-ai/dsh` README，2026-09-02）

- 入口：`dsh --profile <name>`；`web`/`headless`/`sdk`/`sdk-minimal`/`acp` 首次使用从模板自动初始化，其它 profile 必须 `dsh plugin` 创建，或用 `dsh --profile <名> --from-default-profile <模板>` 以出厂模板**替换**重建（该 profile 及其插件与设置会被换掉）；`desktop` 这个名字保留给桌面端，CLI 拒绝启动或导出它；`dsh web` = `--profile web`；`dsh plugin --profile <name> <pnpm args>` 转发给 pnpm；启动器只解析自己的 flag，第一个不认识的 token 之后全部交给应用（`--port/--host/--no-open/--trusted-host` 是 web app 的）。
- 配置树：空根 → `dsh.profile.bundles` 各 bundle 的 patch（按序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`；`patchReload: live | startup`；`--dump-default-config` / `--dump-config` 不启动就打印；`--dump-config-schema`（0.1.7 起）导入组合树里声明的插件 schema，打印条目与 patch 的 JSON Schema 而不是配置值，**对不可信插件先读 README 的 schema-dump 安全说明再用**。`dsh.bundle.patch` 可以是数组，按序叠加多个 patch 文件（0.1.7）。
- **版本兼容闸与豁免**（0.1.7 起有；0.2.1-alpha.4 起 `engines.dsh` 优先，没有时看 `@deepseek-ai/dsh*` 的 peer 范围）：`dsh plugin --profile <p> version-exemptions` 列出该 profile 的豁免，`allow-version <包@版本> --dsh-version <运行时版本> --accept-risk` 授予，`revoke-version <包@版本> --dsh-version <运行时版本>` 撤销。豁免存在该 profile 自己的 `compatibility.json`（与 `package.json`、`cordis.patch.yml` 同目录），只对确切的包版本与确切的 dsh 版本有效，插件或 dsh 升级后不继承。**不兼容的 bundle 在启动与 `--dump-config` 时被静默跳过**——退出码 0，最多一行 stderr；**豁免一旦授予，连这一行都没有**（stderr 空、行都在，只能靠 `version-exemptions` 抓）。探针见 `scripts/probe-compose.ts`。静默跳过的行为在 0.2.1-rc.2 与 rc.3 上实测过；承担它的 `dsh-app-boot` 与 `dsh` 在 rc.3 和 rc.4 之间逐文件相同，rc.4 上没有单独重测这一行为。
- 可选 overlay 在 `config/examples/`（webhook、schedule、记忆 MCP、运行时 Cordis 工具），不属于默认 profile。

## 5. 能力对照与生态（原 PLAN §4 正文；09-01 按文档核实，09-02 在 alpha.4 上复核了组合树，逐 API 复核归 0.6 spike）

- 运行：Node ^22.19 || ≥24、pnpm 11.7（corepack）、TS strict、ESM；`npx @deepseek-ai/dsh web` → `http://127.0.0.1:3080`。本机环境见 §2。
- dsh 根 `@deepseek-ai/dsh-root`（工具链版本 09-01 按 alpha.3 记；2026-10-28 按标签 `dsh-v0.2.1-rc.4` 的根 `package.json` 重核：`packageManager pnpm@11.28.5`、TypeScript ^6.0.3、tsdown ^0.22.2、vitest ^4.1.11、oxlint 1.81.0；当时记的 workspaces 与 @testing-library/react ^16.3、web 前端 React ^18.2 未重核）。
- 组成：Cordis 插件（`export const name/inject/Config/apply(ctx, config)`；Service 类 + declaration merging；`ctx.effect()` 可回滚；`isolate`）。Bundle = npm 包 + `dsh.bundle.patch → cordis.patch.yml`；`dsh plugin --profile web add ./path | pkg | github:owner/repo#sha`；层叠 bundles → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch`。`dsh-base` ≈90 行默认组成（模型 `deepseek-official/deepseek-v4-flash`、tool-bash/pwsh、tool-fs、approval、sandbox、subagent、compaction-basic、tool-skill、goal、todo、web…）；自带 preset cordis/minimal/ptc/standard。
- 能力包组以 `npm view` 与 `spec/dsh/pkglist.*` 为准：09-01 曾列出 50 组，此后 `code-runtime`、`e2b`、`hooks`、`webhook` 等已删除或改名（0.2.1-rc.4 的 296 个 dsh 系包里没有它们，见 `spec/dsh/pkglist.0.2.1-rc.4.txt`）。

| 我们要的 | dsh 提供 | 备注 |
|---|---|---|
| agent loop / turn / step | `core/agent-loop`；事件 `agent/created`、`agent/pre-step`(可重写消息)、`agent/request`(换 LlmCallConfig)、`agent/request-error`、`agent/turn-stopping`、`agent/inbox/*`、`agent/status`；`Agent.followup/steer/inject/cancel({keepInbox})/whenIdle` | 事件名按 0.2.1-rc.4 核对过。`agent/session-start` 自 0.1.6-alpha.1 起由**异步串行**的 `agent/created` 取代，首个模型请求等它的监听者跑完。`Agent` 上那一串方法名本次未重核 |
| 工具 | `ctx.tools.register(defineTool({name, description, parameters, output:{schema, render}, execute(args, exec{signal, callId, agent, deferContext, concludeTurn}), presentCall, presentResult, timeoutMs, isConcurrencySafe}))`、`restrict({allow|deny})`、`guard()`、瀑布 `tools/pre-execute → allow|deny|ask`、`tools/execute`、`tools/post-execute → accept(content|value, additionalContexts)|block`、`tools/result`、`tools/change` | 参数由 defineTool 校验；抛异常=isError；领域失败放 value |
| 审批 / 提问 | `ctx.approval.request()`（allowed-once/rejected/cancelled/unavailable，policy ask\|never）、`ctx.userQuestions.ask()`（单/多选/custom）、`ask_user_question` 工具、`ctx.permissionPresets` | 审计事件 approval/asked\|decided 模型不可见。`tools/pre-execute` 的决定现在还有 `cancel`；`deny` 可带结构化的 `info`；`ask` 可带本地化的 `displayReason`（只给界面展示，不进审计事件）。审批请求里仍然没有工具参数，只有 `callId` 指向已展示的调用（§6-2）【包 `.d.ts`，rc.4】 |
| 会话持久化 / resume / fork | JSONL append-only（可选 zstd）、`ctx.sessions.fork()`、`ctx.agents.create/resume`、`SessionEventMap` 可扩展、`ctx.sessionProjections`（fold → wire view → 客户端推送） | 会话格式现为 V4（§1）；同步历史读取接口 `snapshotEvents` / `eventAt` / `ownEvents` 在 0.1.7-rc.1 的发布说明里已列为弃用。其余方法名本次未重核（本仓的契约测试在 rc.4 上通过） |
| 上下文压缩 | `compaction-basic` + `tool-result-pruner`(8192) + `/compact`；token-meter 触发 | 替代 Layer1+Layer2。触发点公式已改（预留输出与余量），失败路径多了 `compaction/summary-error` 钩子，另有反应式的 `image-offload`，见 §9.4 |
| 后台任务 | `ctx.jobs.start({kind, label, owner, outputLimitBytes?, run(): {cancel, done, readOutput?}})`、`job_*` 工具、`run_in_background` | 进程内 |
| 子 agent / 编排 | `ctx.subagents`（spawn/fork in-process、ACP、Codex/Claude Code）、`subagent` 工具（one-shot\|continuable、maxDepth、toolFilter、agentOptions）、`ctx.agentTeams`(实验)、`ctx.workflowEngine` | 子 agent 权限启动时冻结 |
| agent 预设 | `ctx.agentPresets`（`dsh-agent-preset-registry`，`default:` 可覆盖，用户选的默认值存在该行的 `selectedDefault` 上）；预设本身是 `@deepseek-ai/dsh-agent-preset` 插件行（`id`、`order`、嵌套 `plugins:`），由组合包声明和安装 | 0.1.5 时是「目录 + `agent.cordis.yml`，bundled → roots → `<dshHome>/.agent-presets`」，0.1.7 起不再扫目录，旧目录预设需迁移。详见 §3。「session 产生内容前可切」一条本次未重核 |
| 目标 / 定时 | `ctx.goals`（每 session 一条，`get/create/update_goal`，round-driver）、`ctx.schedule`（`schedule_create/list/delete`，跨重启，session 内） | |
| 技能（说明书） | `ctx.skills` provider（SKILL.md，rank；`skill` loader 工具；`/name`） | 对应 MAST 知识文本，**不是** BaseSkill |
| LLM | `ctx.llm.registerAdapter([...], LlmAdapter)`（`stream()`；usage 在 finish 前；`resolveModel()` 声明 reasoning 档）；内置 `llm-deepseek`（现为 `dsh-llm-deepseek-api-key`，另有 `llm-deepseek-account`）、`llm-pi-ai` | `llm-pi-ai` 无 prompt caching（0.1.2 时的记录，未重核）。官方 DeepSeek 适配器自 0.1.7 起**只用 Messages API**，旧 `protocol` 配置与 Chat Completions 地址需迁移 |
| 系统提示 / 注入 | `ctx.systemPrompt.section()`、`agent-instructions`、`agent.inject()` | |
| 斜杠命令 | `ctx.commands.register({name, description, input?, handler({agent, rawInput, attachments})→{kind, text?}})`（不触发模型） | |
| 持久 KV | `ctx.storage` + `ctx.storageDomain`（schema 校验、变更事件、JSON/SQLite 后端，host-only） | |
| 图像附件 | `ctx.attachments`（本地、永不自动删；`{type:'image'}` 内容块） | |
| 设置页 | 0.1.5 时是 `ctx.settings.installSection(ctx, ns, ConfigSchema, config, {validate, setSource, onChange})` + 客户端 `settingsScope.bind({namespace})` + slot `settings.plugin.item`；`role('secret')`、`applies:'restart'` | **`installSection` 在 0.2.1-rc.4 的 `dsh-settings` 与全部 dsh 包里已搜不到**（本仓从未用过它）。0.1.7 起设置改存当前 profile 的插件配置（旧 `settings.yaml` 只尝试导入一次），`dsh-settings` 重写、`dsh-settings-file` 删除；插件可声明无需重载的配置字段。新的接入方式、`settingsScope`、slot 名与 `role` / `applies` 本次未重核 |
| Web UI | `dsh.client` bundle（`exports["./client"]`，`/plugins/??a,b&rev=` 合并加载）、`ctx.slots.register()`、`conversation.view`、`tool.call.toolview`、`fence-registry`、`webServer` 自定义路由 | React 由宿主提供 |
| 记忆（跨会话） | **无内置**；cookbook：section provider + tool；社区 dsh-memory-evolve / dsh-noema | 自建 |

- 社区先例：**dsh-omicos**（防腐层 `src/host/dsh-compat.ts` + 精确锁版本 + JobKindMap 声明合并 + 客户端 bundle）、**HOL Guard**（`tools/pre-execute` + `guard()` fail-closed）、**dsh-science-workbench**（tools + `webServer` `/biowb/*` + 整页 tab）、**dsh-genui**（fence-registry/slots，JSON payload 渲染图表/表单/3D）、`create-dsh-plugin` 脚手架（tool/events/webui，rc.6）、NanoCordis 教学实现。
- 深度视觉推理：`onnxruntime-node` 1.29.0 Windows x64 预编译含 **DirectML**（CUDA 预编译只有 Linux）⇒ RTX 4060 走 DirectML。
- LLM 路由：pi-ai 生态有 Moonshot/Qwen/MiniMax/GLM 的 openai-compatible 目录；dsh `llm-pi-ai` 支持手写 `openai-completions` 路由 + `baseURL` + `apiKeyEnv`。


## 6. dsh 侧陷阱（原 PLAN §3.1；编号与 PLAN §3.1 的设计后果对齐）

1. **API 会漂**：rc.8 存储格式不兼容 → alpha.1（8-27：APIProxy 删除、conversation UI 拆分、Code Mode 改名 PTC）→ alpha.3（8-31：删除 SQLite session 后端）→ alpha.4（9-01：`Session.events` 换成按需读 API、`SessionSeq`/`SessionLogOffset` 强类型）。`SESSION_FORMAT_VERSION: 0`，"Remove at the first tagged release"。**启动器与 bundle 对子包原本都是 `^` 范围**（0.1.2–0.1.5），只钉 `dsh` 锁不住；0.1.7-alpha.2 起 dsh 系互钉精确版本，但 Cordis 系、`zod` 等独立版本线仍会漂（§1）。⇒ 防腐层单点 + 整套精确钉 + contract 测试 + 实时小步升级、随 dsh 一起重构（PLAN D11、`upgrades.md`）；持久真源放 SQLite 不放 session log。
2. **审批请求不带工具参数**（0.1.2 记的是 `ctx.approval.request({agent, tool, callId, reason})`；rc.4 的字段是 `agent`、`toolName`、`callId?`、`reason?`、`displayReason?`、`signal?`，仍无参数）；`tools/pre-execute` **不能改写参数**；无应答者 fail-closed 为 `unavailable`。⇒ `reason` 放确定性 `ApprovalDigest`（含 `args#hash6`），执行时重算 hash 不等即拒。
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
14. MCP client 在 0.1.2 时只桥工具（无 resources/prompts，图像是唯一富结果，默认 60 s 超时）——本方案不用；记在此防止回头走它。**rc.4 已变**【包 README】：它让模型使用外部服务器的工具**和资源**（0.1.6-alpha.1 起另有 `dsh-mcp-resources`：`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`，配置了 MCP 服务器才出现）；官方 SDK 协商协议版本（0.1.7 起 SDK v2，工具列表分页）；服务器返回的 instructions 带归属地交给提示装配，上限 `maxInstructionBytes` 32,768 字节，超限则拒绝该连接；音频与内嵌资源仍只给诊断文字。prompt 模板的支持与默认超时本次未重核。
15. `ctx.tools.restrict` 只能取交集且未知能否放松；被隐藏名字被模型调用时 dsh 返回什么未知 ⇒ Kimi「工具名受限于绑定列表」对策见 §7.8（桩保持绑定 + 动态换注册），Phase 0 spike。

16. **web profile 在宿主层禁用全部模型可见工具，由 agent preset 在 agent 平面重挂**（实测，见 §3；rc.4 里预设是 `dsh-web-app` 声明的 `@deepseek-ai/dsh-agent-preset` 插件行，不再是目录）。**headless 组合不用 preset，工具在顶层行**。

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
    - **两条后续变化（rc.4）**【包 README；`install-minimal` 与 `probe:compose` 实测】：
      ① **0.1.6-alpha.2 起依赖解析改为运行时解析**。`dsh` 启动器在挂载 profile 行之前，从安装目录和有序的 bundle 依赖图算出一份不可变的运行时解析，经 Node 的 ESM 与 CommonJS 解析器安装，不建回退链接——profile 里的插件解析 `@deepseek-ai/*` 走这张表，不再各看各的 `node_modules`。`install-minimal` 的「宿主与插件解析到同一物理文件」断言继续有效，rc.4 上实测通过（`install-report.json` 的 `externalModuleIdentities` 4 项）。
      ② **兼容闸**（§4）：`engines.dsh`（没有时是 `@deepseek-ai/dsh*` 的 peer）与运行时版本不符的 bundle，安装被拒，已装的在启动与 `--dump-config` 时被静默跳过。所以本仓的 bundle 与最小分发 manifest 都写精确的 `engines.dsh`，升级时用 `pnpm probe:compose` 对每个组合核对 `dsh-spm` 真的进了组合树，而不是看退出码。

## 7. Phase 0 必须先核实的十条（原 PLAN §15）

> **结论正本在 `docs/dsh/spike.md`**（2026-09-08 课时 0.6 起）：已结清 1 / 3 / 5 / 7，半结清 6，其余五条各自记了触发点。
> 有结论的都钉成了 `packages/host/compat/src/spike.test.ts` 的断言，随每次升级重跑。

1. `ctx.tools.guard(exec => …)` 的 `exec` 是否含工具名与参数。
9. ~~`webServer` 是否支持流式 `res.write` / WS upgrade。~~ **✅ 2026-09-10 课时 1.10 结清**：`WebRoute.handler` 的文档写着 *Owns the full response lifecycle (**may hold the response open, e.g. SSE**)*，另有 `registerUpgrade` 提供 WS upgrade。⇒ PLAN §13 备的「退化成轮询」退路用不上。**不是照文档抄**：`packages/client/stm-ui/src/plugin.test.ts` 起一份真 `WebServer`（`port: 0`）+ 真 `http.get` 验过响应头、逐条推送、`Last-Event-ID` 续传、心跳。顺带确认：`EventSource` 断线重连**自动**带 `Last-Event-ID`，所以「重启 5 秒内续传无缺口」不需要客户端记任何东西。
2. ~~`ctx.systemPrompt.section()` 的动态内容是否逐请求记入 session log。~~ **✅ 2026-09-09 课时 1.8b 结清（问题问偏了半格）**：两条路都进日志，但易变内容该走的是 **`context()`** 而不是 `section()`——前者的文档原话是 "materialized as a **durable user-role snapshot**"，落成 `form: 'snapshot'` 的用户角色消息并带按贡献者分开的 `sections`。`section()` 走 `system/message` 事件，把每轮都变的读数塞进系统提示会让 prompt cache 的断点落在易变文本之后（旧仓 2026-07-28 审计买过这个教训）。⇒ PLAN §3.1-5 备的 `agent/pre-step` 退路不用了。详见 `spike.md` §2。
   **0.1.7-alpha.1 起，这条快照消息的来源由 `plugin` 改为 `runtime-context`**（`dsh-agent-loop` 的 `lib/types/runtime-context` 把 `form: 'snapshot'` 的消息标成 `source.kind: 'runtime-context'`；0.1.6-alpha.2 还是 `plugin`）【包，逐版比对】。`stm-ui` 的投影按新来源认，`packages/bundle/dsh-spm/contract/runtime-context-projection.test.ts` 用真 `AgentLoop` 钉住。
3. `cordis.patch.yml` 是否有 `remove`/`replace`，还是只能同 id 覆盖。
4. replay 模式下工具执行是否被短路；`exec` 上有什么标志可判。
5. ~~`parameters` 是否透传 `minimum/maximum`。~~ **✅ 2026-09-08 课时 0.3 结清（结论比原设想更强）**：不但不透传，而且**在 `defineTool` 构造期直接抛** `JsonSchemaError: unsupported JSON schema: parameters.n.minimum is not supported by the value schema DSL`。⇒「范围写进 description」不是可选变通而是唯一写法，且写错了当场炸，不会变成「模型永远看不见这个范围」的静默缺陷。契约测试 `packages/host/compat/contract/pin.test.ts` 钉住了它；哪天 dsh 支持了那条会红，届时同步改 PLAN §8.2 的 schema 生成。
   同段顺带钉住的另外两条 `defineTool` 事实：`parameters` 是**属性表**（dsh 自己补隐式 object 根），不是完整 JSON Schema；`output: {schema, render}` 是**必填**。
6. `ctx.tools.restrict` 能否放松；被隐藏名字被模型调用时返回什么；同名工具重注册（桩→完整）的语义与 `tools/change` 行为。
7. `tools/result` 能否读到 `value`；job 内能否 `userQuestions.ask`；`presentResult` 对 `INVALID_ARGS` 能否接管渲染。
8. `conversation.view` 无 session 时能否显示；`details` 是 single 还是 list；`tool.call.toolview` props 有无待批状态。
9. `webServer` handler 是否支持流式 `res.write`（SSE）/ WS upgrade。
10. 子会话能否读到父/根 session id；`agent/turn-stopping` 能否取消停止；`ctx.agents.resume` API 名；压缩事件有无钩子（`memory_sink`）。
    **压缩钩子一项 2026-10-09 有了结论（读包）：没有压缩前钩子，退路见 §9.4。**其余三项未动。2026-10-28 重核：0.2.1-rc.4 仍然没有压缩前钩子；新增的是失败路径上的 `compaction/summary-error`（§9.4）。


## 8. 逐版本变更与对本计划的影响

> 8.-13 至 8.-5 是 2026-10-28 从 0.1.5-rc.2 一步升到 0.2.1-rc.4 时补记的，沿用「新版在上」的排法。每条的出处标在事实后面：【实测】= 本次在本机比对或运行得到，【包】= 读 npm 包内文件，【发布说明】= GitHub 发布说明，【讨论】= 上游 Discussions 帖子。
>
> **compat 的 12 个接触面包在各检查点之间的变化量**【实测：每个检查点各取这 12 个包，逐文件比较，数的是 `.d.ts` 与 `lib/index.js` 里新增行数与删除行数之和】：
>
> | 检查点之间 | 变了的 `.d.ts` 文件 | `.d.ts` 行 | 实现行 |
> |---|---:|---:|---:|
> | 0.1.5-rc.2 → 0.1.6-alpha.2 | 24 | 445 | 686 |
> | 0.1.6-alpha.2 → 0.1.7-rc.2 | 28 | 1,078 | 1,674 |
> | 0.1.7-rc.2 → 0.2.0-rc.2 | 3 | 62 | 251 |
> | 0.2.0-rc.2 → 0.2.1-alpha.1 | 6 | 22 | 46 |
> | 0.2.1-alpha.1 → 0.2.1-rc.4 | 17 | 424 | 1,385 |
>
> 变化集中在 0.1.6–0.1.7，以及 0.2.1 的 alpha.2 之后（`dsh-tools` 实现 692 行、`dsh-host-webserver` 类型 110 行是大头）；0.2.0 对接触面近乎为零。

### 8.-13 **0.2.2-alpha.2 —— 只读不升；它是一次迁移，不是换版本串**（2026-10-28 记录）

0.2.2 目前只有 alpha.2 一个版本（npm 10-27），`alpha` 标签所指；稳定通道 `next` 仍是 `0.2.1-rc.4`，本仓锁的就是它。按 `upgrades.md` 的切换点规则：**alpha 只读发布说明、把影响记进这里，不升。** 下表来自把 alpha.2 的全部 dsh 系包与 rc.4 逐个比较【实测：tarball 比对加 `.d.ts` 比对】。

| 变化 | 打到我们的什么 |
|---|---|
| `@deepseek-ai/dsh` 首次声明 `engines.node >=24.9.0`（rc.4 没有 `engines.node`） | 与本仓的 `^22.19.0 \|\| >=24.0.0` 以及 CI 的 Node 22.19 单元格冲突；升之前先定 Node 下限 |
| 包集合 296 → 321（+26、−1）：删 `client-ui-deepseek-model-label-1017`；新增含 `dsh-official-bundles`、`tool-executor-native` / `tool-executor-ptc`、computer-use、`cua*`、`forge*`、`liveshare*` 系 | 组合树、快照和 `pnpm gen:dsh-pins` 的两张表都要重建 |
| Cordis 系换到 alpha 版本线：`cordis` 4.0.6-alpha.1、`cordis-plugin-include` 1.0.11-alpha.1、loader 1.0.7-alpha.1、timer 1.1.8-alpha.1、group 1.0.6-alpha.1、`cosmokit` 1.8.7-alpha.1、`schemastery` 3.18.6-alpha.1（`zod` 仍是 4.4.3） | `scripts/dsh-pins.ts` 的 `VENDOR_PINS` 与 `install-minimal` 的 Cordis 覆写要换成预发布版本 |
| `dsh-session-projection`：`SessionProjectionStateMap` 删除；`register()` 改为返回 `Promise<ProjectionHandle>` | 破坏 `packages/host/compat/src/index.ts` 的类型重导出、`packages/client/stm-ui/src/projection.ts` 的模块增补，以及 `packages/client/stm-ui/src/plugin.ts` 里 `ctx.effect(() => ctx.sessionProjections.register(…))` 的写法 |
| `dsh-tools`：`ToolRuntime` 成为 `ToolsService` 的别名；`execute` 改收 `ToolBatchInput`、返回 `ToolBatchResult`；删除 16 个导出 | 本仓生产代码不调 `execute`，也没引用被删的 16 个；22 处测试调用（17 个测试文件）要改；`register` 与 `guard` 保留 |
| `dsh-agent` / `dsh-agent-loop`：`ModelSelectionRef` 删除、`turnBoundaryProjectionDefinition` 移位；模型在 pre-step 之前就定下，`agent/request` 不能再改路由 | 一动一观闸门的契约（`act-gate-loop.test.ts`）要重新验证 |
| `dsh-base`：`tool-subagent-list-agents` 行删除，新增 `tool-executor-native`、`tool-executor-ptc` 两行 | `scripts/acceptance-overlay.ts` 的行清单与 `DSH_TOOLS_MODE`（`ACCEPTANCE_CHILD_ENV`）要迁移 |
| `dsh-system-prompt`：`PromptPresentation` 拆分；`dsh-app-boot`：7 个导出删除（bundle 清单搬进 `dsh-official-bundles`） | 本仓不导入这些名字，无影响 |
| `session-log-deepseek` 与 `session-telemetry-otel` 的行 id 和配置不变 | 隐私默认值的处置不变（§2） |

发布说明里值得记的几条【发布说明】：pi-ai 升到 1.3.0，工具参数畸形的响应会在任何工具执行前中止整轮；Web Fetch 接受非公网地址；实验性的 `subagent_oar` 插件把子任务交给本机 Codex / Claude CLI（默认组合里没有，但属于可能绕开工具闸的一类，真机组合前要评估）；关闭时的 Auto-permission 修复。

⇒ 要升，就是一次带迁移清单的单独升级，不是 `chore(dsh): bump`。

### 8.-12 **0.2.1-rc.4 —— 本次锁定**（10-26 发布；2026-10-28 升级并核实）

`next` 通道，10-26 15:28 UTC 发布；同日 `latest` 是 `0.2.1-rc.2`。按「所有 dist-tag 里 semver 最大」选 rc.4。

| 查什么 | 结果 |
|---|---|
| rc.3 → rc.4 的提交 | 9 个：两处 ACP 模式下诊断输出混入 stdout 的修复（MCP 资源枚举、账号模型目录）、三处界面提示修复、一处测试，加合并与发布【发布说明 + GitHub 比较】 |
| 全闭包 296 个 dsh 系包，rc.3 与 rc.4 逐文件对比（版本串归一） | 290 个相同；6 个有改动：`client-modules`、`client-ui-sidebar`、`client-ui-conversation`、`llm-deepseek-account`、`mcp-client`、`mcp-resources`【实测】 |
| 本仓接触面 | compat 的 12 个包、`dsh-base`、`dsh-headless`、`dsh-web-app`、`dsh-session-log-deepseek` 与 rc.3 逐文件相同；本仓钉的 30 个 dsh 包没有一个在那 6 个之内【实测】 |
| 相对 `latest`（rc.2） | 21 个包有改动、新增 1 个（`dsh-client-ui-entry-customization`）；compat 的 12 个包、`dsh-base`、`dsh-headless`、`dsh-session-log-deepseek` 与 rc.2 逐文件相同；web 组合只多一行 `entry-customization`，headless 组合没有差异【实测】 |
| 快照 | `spec/dsh/dump-config.0.2.1-rc.4.yml`、`dump-config.headless.0.2.1-rc.4.yml`、`pkglist.0.2.1-rc.4.txt`；两份配置快照与 rc.3 上导出的逐字节相同（配置里没有版本串） |

要点：
- rc.4 对本仓没有新增的行为影响；ACP 诊断修复与本仓无关（我们不走 ACP）。0.2.1 线累积的变化记在 §8.-9，rc.3 与 alpha.5 分别在 §8.-11、§8.-10。
- 升级当天对本仓做的检查和结果（构建、测试、`pnpm probe:compose`、隔离安装）记在 [升级日志](upgrades.md)。

### 8.-11 **0.2.1-rc.3**（10-23）

| 变化 | 说明 |
|---|---|
| 6 个提交 | 左侧栏、会话视图和右侧栏的「更多」菜单；导航入口自定义（新包 `dsh-client-ui-entry-customization`，web 组合多一行 `entry-customization`）；导航入口与预设选择的埋点（`product-analytics` 只在 profile 名为 `desktop` 时启用）；新会话草稿修复；**API Key 路线改跟官方 `/models` 列表**；发布与合并【发布说明 + GitHub 比较】 |
| **API Key 路线多了一个出站请求** | 三个条件同时成立才发：Messages 源是官方 `https://api.deepseek.com`、`models` 等于内置目录、有 API Key。请求 `GET https://api.deepseek.com/models`，带 `x-api-key` 与 harness 的 `User-Agent`，不跟随重定向；首次访问最多等 `modelsTimeoutMs`（5,000 ms），之后超过 `modelsMaxAgeMs`（600,000 ms）才在后台刷新；失败或为空则保留上一份，从未成功过时用内置目录（`deepseek-flash`、`deepseek-v4-pro`）；列表没点名的模型 id 原样放行；stderr 多出带 `[llm-deepseek-api-key]` 标签的信息行，stdout 不受影响；自定义 `baseURL` / `$DEEPSEEK_BASE_URL` 或改过的 `models` 都不发【包 README】 |
| 窗口 | 内置两个模型条目的上下文窗口按官方列表写 1,048,576；适配器对没有声明窗口的模型缺省仍是 1,000,000（`DEFAULT_CONTEXT_WINDOW`）。主动压缩的触发点随窗口变，公式见 §9.4【包】 |
| 接触面 | compat 的 12 个包、`dsh-base`、`dsh-headless`、`dsh-session-log-deepseek` 与 rc.2 逐文件相同；Cordis 系与 `zod` 版本不变【实测】 |

### 8.-10 **0.2.1-alpha.5**（10-16）—— 版本号低于 rc.2 的 alpha

内容已被 rc.2 吸收：把 18 个关键包（compat 的 12 个，加 `dsh-base`、`dsh-headless`、`dsh-session-log-deepseek`、`dsh-web-app`、`dsh-llm-deepseek`、`dsh-llm-deepseek-api-key`）的 alpha.5 与 rc.2 逐文件对比，除版本串外只差：`dsh-base` 少一行 `web-deepseek-api`，`dsh-web-app` 少一行 `ui-deepseek-model-label-1017`【实测 2026-10-28】。alpha 只读不升，没有单独影响。

### 8.-9 **0.2.1**（alpha.1 10-03 … rc.2 10-17；到 rc.4 为止）

0.2.1 线破坏性变更最多，但打到本仓接触面的很少。下表只列与本仓有关或改变组合树的项；括号里是发布说明记下它的版本。

| 方面 | 变化 |
|---|---|
| 发布说明里的破坏性项 | 移除运行时 invariant 插件与各包的 `./invariant` 导出（alpha.1）；子路径插件不再读自己的 `package.json`（alpha.1）；工具展示模式去掉 `both`，只剩 `native` 与 `ptc`（alpha.2；验收环境用的 `DSH_TOOLS_MODE=native` 仍合法）；Agent Team 消息直投 Inbox，去掉 outbox（alpha.2）；Azure 提供方名改为 `azure`（alpha.3）【发布说明】 |
| 提示变量与工作目录 | `{{cwd}}` 已不是内置变量：`dsh-system-prompt` 的 README 明写自定义 persona 不得依赖它，未解析的引用会在任何模型请求之前使提示装配失败。工作目录改由 `dsh-working-directory` 以**必需上下文**注入（`CONTEXT_ORDERS.WORKING_DIRECTORY` = 100），文本形如 `Current working directory: "<绝对路径>".`；默认的 `system-prompt` 行也不再带 `personaSuffix: … {{cwd}}`【包 + 对比两份快照】 |
| 兼容闸 | 第三方插件的版本兼容性优先按 `engines.dsh` 判断，未声明时沿用 `@deepseek-ai/dsh*` 的 peer 范围（alpha.4）；不符的 bundle 在启动时被跳过，退出码仍是 0（§4）【发布说明 + 实测】 |
| 凭据 | 优先级变更：Web / 桌面端已保存的凭据优先于环境变量，headless 只读环境变量与 `.env`（alpha.3，§2）；`DSH_AGENTS_HOME` 指定共享的 agents 目录，其中的 `AGENTS.md` 进入全局指令（alpha.2）【发布说明】 |
| 组合树 | 新增默认行 `remote-access`、`working-directory`、`tool-working-directory`（模型看得见 `working_directory` 工具，可读取与切换会话工作目录，alpha.2）、`web-deepseek-api`（rc.2）、`agent-preset-registry`、`llm-deepseek-account` 与一批界面行；`skill-badge`、`tool-ralph`、`code-runtime`、`agent-presets` 四行不再有【实测，对比 0.1.5-rc.2 快照】 |
| API 新增（本表只列新增，不代表已有名字都没动） | `PreToolDecision` 增 `cancel`、`deny.info`、`ask.displayReason`；`ToolDefinition` 增 `projectContent`、`deferLoading`；`SystemPrompt` 的上下文贡献增 `required` / `interpolate`，另有 `refreshContext`；`AttachmentStore.readImageRequest(ref, target)`；`WebServer` 配置增 `tls`（证书与私钥）【包 `.d.ts`，逐项核对】 |
| 压缩 | `/compact` 手动压缩（alpha.3）；失败路径钩子 `compaction/summary-error`；触发点公式见 §9.4【发布说明 + 包】 |
| 会话 | V4 里新增事件 `job/registered`、`job/settled`——`dsh-session` 自 **alpha.3** 起认识（alpha.2 与 0.2.0 没有），**0.2.0 读不了含它们的会话**【包 + 讨论 #10201】。`zod` 自 alpha.3 起精确钉在 4.4.3（发布说明无条目） |
| 已知问题【讨论】 | #10050：0.2.1-rc.2 的 v3→v4 会话迁移没能恢复 0.1.5-rc.3 的历史会话；#10364：第三方插件带入旧版 `dsh-tools`，旧版组件因不兼容被禁用，启动失败；#10201：升级后无法回退（回滚到 0.2.0 读不了 0.2.1 写出的会话）、hooks 包的 dist-tag 指向与 0.2.1 不兼容的旧线、重复装包的冲突信息不带路径；#10195：Windows 上 Messages 流式工具参数 JSON 损坏，整轮中止且不重试 |

### 8.-8 **0.2.0**（rc.1 09-28、rc.2 09-29）

对接触面近乎为零【实测：把 12 个 compat 包在 0.1.7-rc.2 与 0.2.0-rc.2 逐文件比较，10 个包的类型与实现都相同；有变化的只有 `dsh-agent-loop`（`.d.ts` 8 行、实现 29 行）和 `dsh-session`（2 个 `.d.ts` 文件共 54 行、实现 222 行）】。

- 发布说明里的项【发布说明】：自动化任务改由可选插件包提供；工具调度异常后对话可继续，已执行但结果未知的操作会提示先核实副作用；Windows 沙箱权限诊断技能；桌面端可在菜单栏管理 `dsh` 命令与插件；模型目录升到 pi-ai 0.87.1（部分旧模型 id 被移除）；实验性的异步问答模式。
- 已知问题【讨论】：#8617（0.2.0-rc.2 在会话格式 v3→v4 迁移时 SIGABRT，且旧版读不了已迁移的存储）；#9262（附件对象缺失导致含图会话不可用）。

### 8.-7 **0.1.7**（alpha.1 / alpha.2 09-22，rc.1 09-23，rc.2 09-24）

对接触面变化最大的一段：12 个 compat 包从 0.1.6-alpha.2 到 0.1.7-rc.2 有 28 个 `.d.ts` 文件、约 1,078 行类型变化【实测】。发布说明在 rc.1 里把自 0.1.5-rc.3 以来（含 0.1.6 的两个 alpha）的变化汇总成一份；下表括号里的版本取自各 alpha 自己的发布说明或包的逐版比对，没标的只知道落在这一段。

| 变化 | 对本仓 |
|---|---|
| **会话日志 V4**（alpha.1）：工具结果成为独立的 `role: 'tool'` 消息；快照消息的来源由 `plugin` 变为 `runtime-context`（alpha.1，§7-2）；同步历史读取接口 `snapshotEvents` / `eventAt` / `ownEvents` 列为弃用；新增批量迁移包 `dsh-session-format-v3-to-v4`【发布说明 + 包】 | 契约测试按 V4 读工具结果；`stm-ui` 的投影按新来源认 |
| 官方 DeepSeek 适配器**只用 Messages API**，旧 `protocol` 配置与 Chat Completions 地址需迁移；图像可经 Files API 复用（alpha.1）【发布说明】 | §9.3 |
| 工具结果的 spill 改为文字与图像共用的估算 token 预算（`maxInlineBytes` → `maxInlineTokens`，`dsh-base` 设 12,500；alpha.2）【发布说明 + 快照】 | §9.1 |
| dsh 系内部依赖改为精确版本，Cordis 系改 `~` 补丁范围（alpha.2）【包】 | §1 |
| 插件安装与启动检查与当前 dsh 版本的兼容性，不兼容时说明原因，并可对确切版本授予例外【发布说明】 | §4；`scripts/probe-compose.ts` |
| Agent 预设改由插件组合包声明和安装；设置改存当前 profile 的插件配置（旧 `settings.yaml` 只尝试导入一次）；`dsh.bundle.patch` 可为数组；新增 `--dump-config-schema`【发布说明】 | §3、§4、§5 |
| Headless：标准输入任务、`--session-id` 继续会话、`--json` 逐行输出运行事件【发布说明】 | headless 组合 |
| 可选插件启动失败不再阻断其余插件，必需插件失败才退出；配置热更新取消事务回滚（解析失败保留原配置，插件激活失败可能部分生效）【发布说明】 | §4 |
| 默认模型列表移除 V4 Flash 与 V4 Flash Vision Exp；Node PTC 改独立进程执行（`process.env` 为空）；可继续对话的子代理链默认最多 8 个、深度 1【发布说明】 | §3 |
| 已知问题【讨论】 | #7889：v0 会话含 `subagent/descriptor` v2 时打不开；#7833：树外 Typert Remote 插件因编解码变严而激活失败 |

### 8.-6 **0.1.6**（仅 alpha.1 09-15、alpha.2 09-17，没有稳定版；内容并入 0.1.7-rc.1）

12 个 compat 包从 0.1.5-rc.2 到 0.1.6-alpha.2 有 24 个 `.d.ts` 文件、约 445 行类型变化【实测】。已记的两个 alpha 见 §8.-3、§8.-4；这里补它们对本仓有后果的几条：
- **`session-log-deepseek` 的 `enabled` 缺省值由 false 改为 true**（alpha.1；发布说明写「随请求上报会话事件，当前实验性开启，可通过配置关闭」）。0.1.5-rc.2 与 rc.3 上是 false。⇒ 从这一版起，官方 API 的每个请求默认附带会话日志增量，含工具结果（§2）【发布说明 + 包 README】。
- `agent/session-start` 改为异步串行的 `agent/created`，首个模型请求等它跑完；PTC 包名统一为 `ptc-runtime` 系列（`code-runtime` 删除），workflow 执行器改 `workflow-ptc`；Ralph 默认关；删除内置 E2B；`SandboxProvider.confine` 与 `ShellExecutor.start` 改为可取消的异步接口；DeepSeek 默认走 Messages 协议【发布说明】。
- alpha.1 起另有 MCP resources（`dsh-mcp-resources`，§8.-3）；alpha.2 起依赖解析改为运行时解析（§6-17）。

### 8.-5 **0.1.5-rc.3**（09-22；npm 与 git 标签有，**没有 GitHub Release**）

相对 rc.2 只有 3 个提交：`fix(release): pin vendor dependencies for dsh 0.1.5`、发布与合并【GitHub 比较】。后果：今天全新解析 `@deepseek-ai/dsh@0.1.5-rc.2` 得到 **1 个 rc.2 启动器加 230 个 rc.3 子包**，并同时出现两份 `@deepseek-ai/cordis`（4.0.2 与 4.0.5）【实测 2026-10-28：空目录里 `npm install --package-lock-only` 的结果】——**停在旧锁本身也在腐化**。

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

## 9. 视觉线束：工具结果里的图像、各适配器的送达方式、压缩钩子与「一动一观」（2026-10-09，对照 0.1.5-rc.2；2026-10-13 补 §9.5 复核与 §9.7；2026-10-28 对照 0.2.1-rc.4 逐条重核）

> 回答 [VISUAL-HARNESS](../VISUAL-HARNESS.md) §7 前三条开放问题。**来源分三种**：
> **实测（契约）** = 本仓 `packages/host/compat/contract/image-results.test.ts`（§9.1–9.3）与
> `packages/host/stm-skills/contract/{act-gate,act-gate-loop,k14-wiring}.test.ts`（§9.5、§9.7）对真包跑出来的，随每次升级重跑；2026-10-28 在 0.2.1-rc.4 上随单元与契约测试重跑，全部通过；
> **实测（探针）** = 在仓外临时目录装同版本包、对本机 mock HTTP 服务抓请求体得到的，探针**未入仓**，升级时要重做——**0.2.1-rc.4 上没有重做**，标「探针·未重核」的条目仍是 0.1.5-rc.2 上的结论；
> **包** = 读 npm 包内的 `lib/*.js`、`.d.ts` 与 README。2026-10-28 起不再写行号（`dsh-agent-loop` 等包在 0.2 里整体挪了位），改写函数名、导出名与 README 小节。
>
> 每一条落在三种结论之一：「**0.2.1-rc.4 已核：未变**」、新事实（附依据）、「**未重核**」（说明为什么）。
> 适配器（`dsh-llm-pi-ai`、`dsh-llm-deepseek`）、`dsh-compaction*`、`dsh-attachment-local` **不在本仓依赖树里**；它们的结论都属后两种。要在 CI 里钉住适配器行为，得把它们加成 compat 的
> devDependencies —— 那是新依赖，留给维护者决定。`dsh-agent-loop`（连同 peer `dsh-session-persistence`、
> `dsh-settings`）2026-10-13 起是 stm-skills 的 devDependency，§9.5 的「先提交、后 pre-step」由契约测试钉住。

### 9.1 工具结果里的图像块

- **形状**【0.2.1-rc.4 已核：未变，多一个可选字段】：`ImageBlock = { type: 'image', attachment: ImageAttachmentRef, offloaded?: true }`，**只引用附件、不带像素**；
  `ImageAttachmentRef = { attachmentId: 'sha256:<64 hex>', mediaType, bytes, width, height, name?, originalDimensions? }`
  （`dsh-llm` 与 `dsh-attachment` 的 `lib/types/types.d.ts`）。新增的 `offloaded?: true` 由持久的 image-offload 决定产生，带它的图所有路由都发占位文字而不是字节（见 §9.3）。
  工具结果在 V4 里是 `role: 'tool'` 消息，它的 `content` 与用户消息的 `content` 同一个类型，所以能带图像块。[包]
- **怎么产出**【0.2.1-rc.4 已核：未变】：`output.render` 是纯函数（§6-6），不能存文件；工具在 `execute` 里调
  `ctx.attachments.saveImage({ data, mediaType: 'image/png', name })` 拿到引用、放进 value，
  `render` 再把引用变成块。`ToolRuntime` 把 render 的块**原样**交出，value 只在执行期存在。[实测（契约）]
- **dsh 不校验图像块**【0.2.1-rc.4 已核：未变】：render 返回 MCP 式 `{ type: 'image', data, mimeType }` 也原样通过调度器，
  错误要到适配器读 `block.attachment` 时才出现 ⇒ 形状是我们自己的责任。render 抛异常则变成 `isError` 结果。[实测（契约）]
- **附件服务**【0.2.1-rc.4 已核】：Cordis 服务名 `attachments`（抽象类 `AttachmentStore`）；dsh-base 组合里有 `attachment-local`
  且未禁用（`spec/dsh/dump-config.0.2.1-rc.4.yml`）。`saveImages` 校验整批（条数、总字节、类型，
  失败码 `TOO_MANY_IMAGES` / `IMAGES_TOO_LARGE` / `UNSUPPORTED_IMAGE_TYPE`，整批不写）；
  单次 `saveImage` 不受「每条消息张数」限制。[实测（契约）]
  默认限额：每条消息最多 20 张、源字节合计 200 MiB；单张 20 MiB、6400 万像素、单边 8192（`dsh-attachment-local` README）。[包]
- **其它策略对图像结果的作用**（**这一条在 0.2.1-rc.4 里重写**）：
  - **spill 的预算换了单位**。0.1.5 是「50 KB 内联上限，只处理纯文本，含非文本块的结果不剪」；0.1.7-alpha.2 起 `spill-policy` 用**文字与图像共用的估算 token 预算**，`dsh-base` 设 `maxInlineTokens: 12500`。
    估算：文字按 4 字符/token 外加每块 4（`dsh-token-meter` 的 `CHARS_PER_TOKEN`、`BLOCK_OVERHEAD`），图像按所在路由的计价；每个超限的工具结果各算一次，
    首尾各留扣除省略提示后预算的一半，文字可以切，**图像整张保留或整张省略**，省略区间里的图一并省略；完整结果写进文件，图像在文件里是一条附件路径，模型靠 `read` 再 `read_image` 恢复。
    缺路由计价、缺路径或存储失败时只告警、保留原内容。⇒ 纯文本的 `stm_read_values` 回复仍应控制在约 50,000 字符以内（12,500 × 4）。**本仓验收组合不挂文件工具，模型没法按路径恢复被省略的内容。**
    [包：`dsh-spill-policy` README、`dsh-token-meter`]
  - `tool-result-pruner` 【0.2.1-rc.4 已核：未变】：阈值 8192、头 4096、尾 1024（Unicode 码点），保留图像块及其顺序，只在压缩触发之后运行（该包 README 与快照里的 `tool-result-pruner` 行）。[包]
  - PTC（`run_code`）模式下含图的子结果**现在**成为延后的 user 消息上下文，`source.kind` 为 `ptc-mode`；其它附加上下文保留产生它的工具的归属（`dsh-tools` README）。验收环境用 native 模式，不走这条。[包]
  - `Session.append` 不检查附件是否存在——**未重核**（0.1.5-rc.2 的结论，这次没有重读 `dsh-session` 的这一处）。

### 9.2 `attachment-local` 怎样保存我们的 PNG

- **直通条件**【包 README 重核；探针·未重核】：README 现在写的是——干净的单帧 8 位 sRGB/sRGBA 的 PNG、JPEG 或 WebP，在上限之内**按原字节保存**；
  GIF、动画、带元数据、带方向、16 位 PNG、不兼容的色彩空间一律转换。归一化的预算：2048×2048 总像素、8192 长边、4 MiB 编码字节目标（极端长宽比因此保留短边分辨率）。
  直通时 `attachmentId` = `sha256:` + 我们字节的 sha256。
- **转换规则**【包 README】：应用方向、去掉元数据与色彩配置、保留透明；无 alpha 用 JPEG、有 alpha 用 WebP，质量依次 85 → 75 → 60，全部超标时取最小的一份。
- **新增：请求变体**【包】：模型请求不直接读原图，而是 `readImageRequest(ref, target)` 取一份按路由选定的目标尺寸与字节另做的版本，缓存在
  `<DSH_HOME>/cache/attachments/request-images/`。它只按长边缩小、不放大，再用同样的 alpha 路由与质量阶梯满足字节目标；缓存键含附件 id、变换版本、目标尺寸、字节目标与编码器设置，缓存内容读头校验，不符则重做。
  按目标生成的版本若与源字节完全相同，就直接用源字节、不写缓存（`readRequestImageFile`）。清空这个缓存不动持久的附件。
- 真 `LocalAttachmentStore` 探针结果（**0.1.5-rc.2 上的结论，探针·未重核**）：

  | 输入 PNG | 保存为 | 尺寸 | 字节相同 |
  |---|---|---|---|
  | 灰度（colour type 0）768×768 | `image/jpeg`（有损） | 768×768 | 否 |
  | RGB 768×768，含 NaN 色行 | `image/png` | 768×768 | 是 |
  | RGB 1536×768 | `image/png` | 1536×768 | 是 |
  | RGB 2560×2048 | `image/jpeg`，带 `originalDimensions` | 2289×1831 | 否 |

  ⇒ **观测图一律写 8 位 RGB（colour type 2）、不写任何辅助块**；灰度 PNG 会被悄悄存成 JPEG。
  这一条已落在 `dsh-spm-visual-memory` 的 `png.ts`。rc.4 的 README 仍把直通条件写成 8 位 sRGB/sRGBA，方向与上表一致，但**灰度 PNG 现在是否仍被存成 JPEG 没有重测**。
- **存储与上限**【包 README】：对象存在 `<DSH_HOME>/attachments/v1/objects/<sha 前缀>/<sha>`，相同字节只存一份，**永不自动删除**；之后收紧上限不会让已保存的图变得不可读（上限只在写入时约束）；
  磁盘上被删或损坏的图，读取时报带稳定错误码的明确错误。

### 9.3 各适配器怎样把工具结果里的图像送给模型

**所有路由的前置一步在 `LlmRuntime`**【0.2.1-rc.4 已核：未变】：路由解析出的模型若**声明了** `inputModalities` 且其中没有 `image`，
请求里的每张图（包括嵌在 tool-result 里的）都被换成固定文本
`[image omitted because this model accepts text only; attachment sha256:<前 8 位>]`；
声明含 `image` 或**根本没声明**时原样交给适配器。[实测（契约），`image-results.test.ts` 逐字验证]

| 路由 | 图像去向 | 每张图附带的文本 | 预算与缩放 | 来源 |
|---|---|---|---|---|
| **`llm-deepseek`**（`dsh-llm-deepseek-api-key` 与 `-account` 共用 `dsh-llm-deepseek` 的传输）**【重写】** | Messages 协议：工具结果是 `tool_result` 内容块（`role: 'tool'` 消息在线上包成 `user`），**图像内联在 `tool_result` 的 content 里**。默认先上传 `/v1/files`、用 file id 引用；上传失败或超时则整个请求回退内联 base64（一个请求里不混用） | 每张图前有一段文字：完整附件 id、实际请求尺寸；映射得到时还有只读路径与可写副本的扩展名 | 按提供方视觉网格（14 像素块、3:1 下采样）每张 ≤ 1024 token：方图最大 1302×1302，16:9 为 1708×961；单边 ≤ 4096；`imageMaxBytes` 缺省 2 MiB；不透明 → JPEG（质量 85/75/60），带 alpha → WebP；一个请求最多 600 张，files 模式 128 MiB、内联 20 MiB | 包 README「Streaming with thinking and images」与 `lib/index.js` 的消息组装、常量；**探针·未重核** |
| `llm-pi-ai` → `anthropic-messages` | **内联**在 `tool_result` 内容里，顺序不变 | 句柄文本 `Image "<name>" (<sha256 id>); request preview WxHpx. It may be resized or re-encoded; …` | `readImageRequest` 预算 4,194,304 像素 / 1 MiB；超 1 MiB 的 PNG 重编码为 JPEG | **探针·未重核**（0.1.5-rc.2） |
| `llm-pi-ai` → `openai-completions`（含手写 Kimi 路由） | **移出**：tool 消息只含全部文本（`\n` 连接），随后追加一条 user 消息 `Attached image(s) from tool result:` + 这一串连续工具结果里的全部图像（data URL） | 同上，句柄文本留在 tool 消息里 | 同上 | **探针·未重核**（0.1.5-rc.2） |
| `llm-pi-ai` → `openai-responses` | 内联但不交错：`function_call_output` 先一段 `input_text`（全部文本），后面才是全部 `input_image` | 同上 | 同上 | **探针·未重核**（0.1.5-rc.2） |

- **三个 pi-ai 行为什么没重核**：pi-ai 已从 0.8x 升到 1.x（`dsh-llm-pi-ai` 声明 `@earendil-works/pi-ai ^1.1.0`，今天解析到 1.4.0），要用仓外探针重做；本仓验收只走 DeepSeek 路线。
- **转换细节**【探针·未重核（0.1.5-rc.2）】：`llm-pi-ai` 把每个图像块变成「句柄文本 + base64 图」两块，字节来自
  `attachments.readImageRequest(ref, { maxPixels: 4194304, maxBytes: 1048576 })`；模型不支持图像或没有附件服务时抛 `UNSUPPORTED_CONTENT`。[包；探针]
- **历史图像预算**【机制换了】：旧的 pi-ai 路由在全部历史图像的 base64 超过 20 MiB 时从最早的图开始换成 `offloadedImageText`。现在由 **`dsh-compaction-image-offload`**（`dsh-base` 默认挂载，行 id `image-offload`，web 与 headless 组合都有）**反应式**处理：
  只在适配器报 `IMAGE_OFFLOAD_REQUIRED`（并带上需要卸掉的张数）时，把请求顺序里最早的若干张图**永久**换成占位文字（含附件名与只读路径），写一条 `image/offload` 事件，然后重试，不耗提供方的重试预算、也不写 `llm/retry`。
  DeepSeek 路线的触发量：每请求 600 张，或 files 128 MiB / 内联 20 MiB，按 20 张 / 64 MiB / 10 MiB 的量子成批卸。被换掉的图不会自动回来（跨路由切换、恢复和重放都保留这个选择），供应商缓存复用止于第一条被改的消息；每次卸载多一次失败的请求。
  摘要请求失败时也走它（`compaction/summary-error`，§9.4）。
  占位文字有两种【包：`dsh-llm` 的 `offloadedImageText`】：有只读路径时带上路径（模型挂了文件工具就能 `read_image` 找回）；**没有路径时仍是「No local normalized image path is available; ask the user to attach it again if needed」**——
  本仓验收组合没有文件系统映射，落的就是这一种。这对工具图是错的提示，应让模型用 `stm_inspect` 重看，这仍是我们提示段的责任（§9.6）。[包 README]
- **哪些路由接收图像**【探针·未重核；DeepSeek 部分已更新】：pi-ai 路由里，模型的 input 依次取路由条目自己的 `input`、pi-ai 目录里同 id 的条目、路由的 `defaultInput`，缺省 `["text"]`；
  只有路由 key 本身是 pi-ai 的 provider id 时才继承目录 ⇒ 手写的 `kimi: { api: 'openai-completions', baseURL, models: [...] }` **默认是纯文本路由**，图像全被换成占位文本（探针用 `kimi-default` 复现）。
  这些是 pi-ai 0.8x 的目录结论，pi-ai 1.x 的目录没有重读。
- **DeepSeek 默认模型**【包，已更新】：`dsh-llm-deepseek` 的内置目录现在只有 `deepseek-flash`（文本 + 图像，窗口 1,048,576）和 `deepseek-v4-pro`（纯文本）；
  走官方 API 时官方 `/models` 列表接管目录，列表没点名的模型 id 原样放行（§8.-11）。0.1.5 记的 `deepseek-v4-flash-vision-exp` 等已不在内置目录里。
  **这与 VISUAL-HARNESS §4.8「DeepSeek 默认模型行不在此列」不一致**；真 API 是否接受图像**未核**（本仓没有开过真实模型会话）。
- **丢图无日志**【未重核】：路由不收图而被 `LlmRuntime` 换成占位文字时，宿主侧没有日志也没有事件（0.1.5-rc.2 的结论），模型看到的占位文字是唯一信号。
  §4.8 要求的「本轮有 N 张图像未送达」只能由我们按模型声明的 `inputModalities` 自己算。反应式卸载则会写 `image/offload` 事件（见上）。
- **尺寸**【改变】：DeepSeek 路线现在按 token 计价而不是按像素预算缩放。用包里 `image-tokens` 那段函数原样算（该函数不导出，**不要手算近似式**：近似式给 768² 得 344，真函数得 382）：
  768×768 = **382** token，1536×768 = **724**，1302×1302 = 994，1708×961 = 968，都 ≤ 1024 ⇒ 这两个尺寸**都不缩放**（0.1.5 时 1536×768 在 DeepSeek 路线被缩成 1130×565）。
  坐标换算依赖图像不被缩放 ⇒ DeepSeek 路线上 `D = 768` 仍然安全；pi-ai 路线未重核。[包 + 本文把该函数抽出来算]

### 9.4 压缩：没有压缩前钩子

- **仍然没有压缩前钩子**【0.2.1-rc.4 已核】：`dsh-compaction-basic` 在 `auto: true` 时挂在**串行的 `agent/pre-step`** 上：在请求推导之前，用 `ctx.tokenMeter` 对最近一次持久化请求的估价算压力，
  越过阈值就先剪（pruner）、再摘要最旧的一段平衡区间，并保留带估价的近期尾部。它只往会话日志追加 `compaction/start`（`{compactionId, sourceCommandId?, turn}`）、`compaction/summary`、
  `compaction/end`、`compaction/prune`，都是事后记录、不能否决；`agent/request-error` 收到上下文溢出时另有溢出压缩。[包 README]
- **新增：失败路径上的钩子 `compaction/summary-error`**（同步 waterfall）：摘要请求失败时派发；监听者要先落一条持久的输入变化才能请求重试。`image-offload` 用它。[包 README]
- **触发点公式变了**：窗口 `W`、有效请求输出上限 `O`、余量 `B`（`headroomTokens`，缺省 **65,536**），触发点 = `floor(min(W × 0.8, W − O − B))`，保留最新 16% 的 `W − O`（`retainRatio`）。
  `deepseek-flash`：W = 1,048,576，O = 256,000（适配器缺省输出上限），⇒ min(838,860, 727,040) = **727,040** token（0.1.5 的规则是 0.8 × 窗口，窗口 1,000,000 时为 800,000）。
  `W − O − B` 必须为正且保留预算须低于触发点，否则主动压缩被跳过并只警告一次（溢出恢复仍然可用）。`/compact` 手动压缩由 `dsh-command-compact` 提供。[包 README；算术为本文所做]
- **退路是否可行**【未重核】：结构上没变（`compaction-basic` 仍在串行 `agent/pre-step` 上），所以「在 `agent/pre-step` 用 `ctx.on(…, { prepend: true })` 抢在 compaction 前面，
  按同一公式算压力、接近阈值时返回 `{ kind: 'enter', messages: [...payload.messages, 检查点请求] }` 且**不调用** `next()`」仍然讲得通；但公式已换（见上），这次没有重做探针。
  局限同前：依赖监听顺序；不调 `next()` 也跳过了其后的所有 pre-step 监听者；溢出压缩（`agent/request-error`）抢不到。
- 被摘要的区间里的图像离开模型上下文（摘要只保留文字），附件本身仍在；`image-offload` 记下的卸载在摘要失败或被取消后依然有效。[包 README]
- 它挂在 preset 的隔离 `compaction` 组里，web profile 的宿主层是禁用的（§3）；headless 组合里在顶层。

### 9.5 「结果已进入上下文」与一动一观闸门

- **第 S 步的全部 `tool/result` 都在第 S+1 步的 pre-step 之前提交**【0.2.1-rc.4 已核：未变；契约测试钉住】：`dsh-agent-loop` 的 `executeToolCalls` 把调用分组，`runGroup` 先 `appendToolCall`、再 `prepare`（pre-execute 与 guard）、再 dispatch，
  `commitReady` 按模型顺序 `appendToolResult`，之后这一组才返回；`step()` 在 `executeToolCalls` 返回后才返回，`turn()` 在 `step()` 返回后才为下一步调 `preStep`（`agent/pre-step` 瀑布）；请求由会话推导。
  README 的话是：「every accepted fact is appended to the session log before the next step derives from it」。
  ⇒ 第 S+1 步的请求必然含第 S 步的全部结果；dsh 没有单独的「已送达模型」事件。[包；`act-gate-loop.test.ts`]
- **pre-execute 时已知调用所在的步**：`tool/call`（`{turn, step, callId}`）在 `prepare` 之前由 `appendToolCall` 追加，而 `session/event` 观察者在 `append` 内同步触发。[包，0.1.5-rc.2 读码；函数名在 rc.4 仍在，逐行语义未重读]
- **一步之内的顺序**【0.1.5-rc.2 读码；rc.4 由契约测试钉住其中与闸门有关的部分】：`agent/pre-step`（压缩在这里）→
  `step/start` → `agent/request` → `system/message`（变了才有）与本步 `user/message` → `request/header` / `request/context`
  （变了才有）→ 推导消息 → 适配器 → `assistant/message` → 每个工具调用依次：`tool/call` 事件 →
  `tools/pre-execute` 与 guard → `tools/execute` 与工具体 → `tools/post-execute`、`finalizeContent` →
  `tools/result` → `tool/result` 事件 → `step/end`。[包]
- **`executeToolCalls` 给每个调用设 `agent: ctx.agents.requireInitiator()`**（2026-10-13 在 0.1.5-rc.2 上读到，rc.4 仍在）；独占调用一个一组。[包]
- **探针实测**（2026-10-13，0.1.5-rc.2，仓外 scratch 目录装同版本 `dsh-agent-loop` 及其 peer，**未入仓**）：真 `AgentLoop` +
  `AgentRegistry` + `SessionStore` + `SessionProjectionRegistry` + `LlmRuntime` + 脚本化 `LlmAdapter`（第 1 次请求
  回两个工具调用 c1、c2，第 2 次回一个 c3，第 3 次回文本），宿主层挂与本仓 `ActGateService` 同逻辑的 guard 与
  pre-step 回执。观察到的顺序：`pre-step 1.1` → `tool/call c1` → c1 放行、工具体跑 → `tool/result c1` →
  `tool/call c2` → **c2 被拒** → `tool/result c2` → `step/end 1.1` → `pre-step 1.2` → 第 2 次请求带着
  `[c1, c2(error)]` → c3 放行。工具体里 `exec.agent.id` 就是会话 id。[实测（探针），0.1.5-rc.2]
- **同一场景入仓**（`packages/host/stm-skills/contract/act-gate-loop.test.ts`，2026-10-13 起；**0.2.1-rc.4 上通过，时间线断言一字未改**）：真 `AgentLoop` 驱动一整个回合，
  闸门是本仓的 `ActGateService` 本身，只有模型是脚本化的 `LlmAdapter`。钉住的时间线：`pre-step 1.1` → c1 →
  c2 被拒 → 两个 `tool/result` → `pre-step 1.2` → c3 → `pre-step 1.3`；第 2 次请求带着 `[c1, c2(error)]`，
  第 3 次带着 `[c1, c2(error), c3]`。去掉闸门或去掉回执，这条都会红。升级到 V4 时只改了「怎么读结果」：`tool/result` 事件的 `data.message` 现在是
  `role: 'tool'` 的消息，`callId` 在 `message.toolCallId`，请求里的结果也是独立的 tool 消息而不是 user 消息里的块。[实测（契约）]
- **本仓的落点**（stm-skills `act-gate.ts`，2026-10-13）：回执 = 同一 agent 的下一个 `agent/pre-step`
  （宿主层监听，一进来就回执、照常 `next()`）。不看这一步最后放不放行：模型要再发调用，只能在回应一次更晚的
  请求，而那次请求同样由日志推导、同样带着结果。拒绝走宿主层 guard，**放行即记账**（同一个同步调用），
  所以并发与同一步里的第二个动作都被拒。早先推荐的 `(turn, step)` 比较与此等价，没有采用：它要另从
  `tool/call` 事件取步号。例外：pre-step 上的压缩若把上一个结果摘进了摘要，模型看到的是摘要（§9.4）。
  PTC 子调用继承父调用的 `agent`，所以一个 `run_code` 程序里的第二个动作同样被拒（**未重核**：0.1.5-rc.2 读码的结论）。[包]
- **契约测试钉住**（`packages/host/stm-skills/contract/act-gate.test.ts`，真 `ToolRuntime` + `dsh-agent` 的
  `agentEvents` / `emitAgentEvent`；**0.2.1-rc.4 上通过**）：宿主层（不带作用域）的 `agent/pre-step`、`agent/disposed` 监听者收得到经
  agent 作用域载体派发的事件（`scopeTarget` 的契约：untagged 监听者全收）；guard 拿得到 `exec.agent`，拒绝变成
  `isError`、`error.message` 是原文、content 是 `Error: <原文>`；全局 guard 按登记顺序问、第一个拒绝就停；
  并发 `execute` 下只放一个。「先提交、后 pre-step」一条由上面的 `act-gate-loop.test.ts` 钉住。[实测（契约）]
- `dsh-tool-present` 只声明「把哪些文件交给用户」，不往模型上下文放任何东西，与观测图无关（rc.4 的 preset 里这一行叫 `present`）。[包]

### 9.6 本仓的落点

- compat 新增**仅类型**导出：`ContentBlock`、`ImageBlock`、`TextBlock`（dsh-llm）与 `AttachmentStore`、
  `ImageAttachmentRef`、`ImageMediaType`、`SaveImageAttachment`（dsh-attachment）。compat 依赖表加了这两个包
  （锁文件里本来就是同一版本，由 overrides 钉住；只改 importer 一段）；最小分发的外部依赖集不变。
- 钉住上面「实测（契约）」各条的是 `packages/host/compat/contract/image-results.test.ts`，
  类型层由 `packages/host/compat/src/image-types.test.ts` 在 `tsc -b` 时检查（含「不是 any」）。
  2026-10-28 升级时，这份契约测试和 `act-gate-loop.test.ts` 一样改成按 V4 读工具结果（独立的 `role: 'tool'` 消息、`RequestMessage`），断言的行为没有变。
- 设计后果落在 `packages/host/visual-memory`：观测图写 RGB PNG；每个视图存一张附件并给可读的 `name`
  （如 `t0007.s0.inspect-1.png`）；标签带 `index` / `count`（图像被移到后续 user 消息时只剩顺序可依）；
  每个文本块以换行结尾（DeepSeek 无分隔符拼接）。K14 接线时补的两条（2026-10-13 已落）：技能结果的出站一侧
  （`observe.ts` 的 `observationPresenter`）按会话路由的 `inputModalities` 报 `images_not_delivered: N`；
  视觉线束的提示段（`prompt.ts`）写明「旧图不见了就用 `stm_inspect` 重看」。见 §9.7。
  其中「图像被移到后续 user 消息」「无分隔符拼接」是 0.1.5 DeepSeek 路线的行为；rc.4 的 DeepSeek 路线图像内联在 `tool_result` 里、每张图前有句柄文字（§9.3），这两条设计后果不再是必需，但保留无害。

### 9.7 K14 接线用到的 dsh 事实

- **会话 = agent**【包；rc.4 上只核了 `requestHeader` 这个名字还在，其余照 0.1.5-rc.2 的记录】：`Agent.id` 就是 `SessionId`（`dsh-agent` `lib/types/types.d.ts`），一个品牌字符串，格式由创建方定
  （agent-loop 的声明式 agent 是 `${id}-session-<uuid>`，README）；同一会话恢复时 id 不变。`agent.session.requestHeader()`
  给出会话最近一次请求头的 `config`（provider / model，`dsh-session` `lib/types/index.d.ts`），`agent.options` 是创建时的
  路由。
- **路由收不收图**【rc.4 上核了 `resolveModelInfo` 仍在，占位文字由契约测试逐字验证】：`ctx.llm.resolveModelInfo(provider, model)` 交回 `inputModalities`；`LlmRuntime` 只在它**声明了且不含**
  `image` 时把图换成占位文本（§9.3），本仓按同一判据报未送达。[包 + 契约]
- **每次工具调度都过 `tools/execute`**【未逐行重核；`packages/host/visual-memory/src/sessions.test.ts` 走真 `ToolRuntime`，在 rc.4 上通过】：visual-memory 在宿主层
  这个瀑布上用 AsyncLocalStorage 记下调用所属的会话，工具与 K14 在工具体里读到它（每会话一份视觉记忆）。宿主层（不带作用域）
  的监听者收到每个 agent 的调用。[包；单测]
- **提示段的位置**【0.2.1-rc.4 已核】：`dsh-system-prompt` 的 `SECTION_ORDERS` **没变**：harness 身份 -1000、部署 persona 前缀 0、plan / team 策略
  500 / 600、工具段 1000 起、persona 后缀 10200。视觉线束的五句约定是 order 150 的独立段，仍落在 persona 前缀 0 与 plan 策略 500 之间。
  **新增 `CONTEXT_ORDERS`**（动态上下文的排序）：`WORKING_DIRECTORY` 100、`SANDBOX_POLICY` 110、`APPROVAL_POLICY` 115、`SUBAGENT_DELEGATION` 120、`TEAM_IDENTITY` 125、`HARNESS_SOURCE` 200、`WEB_SURFACE` 210。
  「agent preset 用同名段 `deployment:persona-prefix` 遮住部署的 persona」这一条，字符串在 rc.4 的包里还在，遮盖语义未重核。[包]
- **压缩前钩子**：仍然没有（§9.4）。本次没有做压缩检查点。[包]
