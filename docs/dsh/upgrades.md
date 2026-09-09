# dsh 升级策略与日志

## 策略（PLAN D11，用户 2026-09-02 决定）

实时追踪 dsh 的**最新已发布版本**。dsh 官方预告还会有若干破坏性重构，小步跟比攒着一次爆便宜；**我们的插件随 dsh 一起做破坏性重构**：每个插件版本只对应一个 dsh 版本（peer 精确钉），不为旧 dsh 版本保留兼容层、不做双轨；持久数据只保证 SQLite 真源可迁移（迁移脚本随升级提交），session log 与投影缓存可丢。

**追踪对象 = 所有 dist-tag 里 semver 最大的那个，不是某个固定 tag**（2026-09-04 修订）。原规则写的是「追 `alpha` 标签」，两天后就失效了：`0.1.2-rc.1`（09-03）比 `0.1.2-alpha.5`（09-02）新，同时占 `latest` 与 `next`，只盯 `alpha` 会停在旧通道。DeepSeek 的通道用法不稳定（`alpha` 曾领先 `latest` 十天，现在反过来），所以按版本号比大小，别信标签名。

**触发**：每个课时开始先跑 `pnpm check:dsh-latest`（0.3 落地 `scripts/check-dsh-latest.ts`：读全部 dist-tags，按 semver 取最大值与锁定版本比）。落地前手工：

```sh
npm view @deepseek-ai/dsh dist-tags --json     # 三个 tag 全看，取最大
```

有新版 ⇒ 当前课时先做升级，再继续原课时。

**升级清单**（一次一版，单独提交 `chore(dsh): bump <a> → <b>`）：

1. 改根 `package.json` 的 pnpm `overrides` 与 `packages/host/compat/package.json` 的 `peerDependencies`，`pnpm install`；`pnpm check:dsh-pin` 确认安装树里 `@deepseek-ai/dsh*` 只有一个版本。
2. `npx -y @deepseek-ai/dsh@<b> --profile web --dump-config > spec/dsh/dump-config.<b>.yml`，与上一版 diff；我们覆盖过的 dsh-base 行（PLAN §6.3 表）逐行对。
3. 两版 npm 包树 diff（`.md`/`.d.ts`/`.yml`；`scripts/diff-dsh-trees.sh`），只读 compat 依赖的包；发布说明逐条对 `docs/dsh/facts.md` §5–§7。
4. `pnpm test --project contract`（含 spike 十条）；红了先在 compat 内适配，适配不了就重构我们的接缝（同一提交或紧随其后的 `refactor(dsh): …`）。
5. `pnpm -r build && pnpm test`；`dsh plugin --profile web add ./packages/bundle/dsh-spm` 冒烟，会话里 `stm_hello` / `stm_selfcheck`。
6. **拿既有 `~/.dsh` 冒烟**（不是干净 home）：旧会话能打开、标题还在、设置与凭据还在。alpha.5 就是专门修「从 rc.2 / alpha.3 升级后起不来、会话标题消失」的——升级会损坏既有数据是实证过的。备份 `~/.dsh` 再升。
7. 更新 `docs/dsh/facts.md` 首行版本号与受影响条目、README 命令里的版本号；本文件追加一条日志（发布说明要点 + 影响 + 适配点）。
8. 升级不改领域代码；若必须改，拆成第二个提交。

## 日志

### 2026-09-09 · 0.1.2-rc.1 → **0.1.5-alpha.1**（第一次真升级；已有代码与测试）

- **起因**：课时 1.3 开工①查版，`alpha` 已跳到 `0.1.5-alpha.1`（09-08 发布）。纪律要求版本不处理完不开工，于是先做升级。
- **为什么能升了**：0.1.5 把 `fs-ext` 换成自家的 `@deepseek-ai/node-addon-system`。发布说明只写了修 "on macOS and Linux"，
  而该包的 `optionalDependencies` **确实没有 win32**——但**平台包是 optional，npm 装不到就跳过，代码有回退**。
  Windows 实测全绿：238 包、**零 node-gyp 编译**、`--dump-config` 正常、`--profile web` 打印带 token 的 URL、stderr 空、端口正常释放。
  ⚠️ 上游 #6003 报的 `Cannot find module …node-addon-system-<platform>/bin/system.node` 是**源码检出**路径，与 npm 安装不同，别混为一谈。
- **跳过 0.1.3 与 0.1.4**：0.1.4 从未发布；0.1.3-alpha.2 客观装不上。清单的「一次一版」这次只能一步跨过去，原因不是图省事。
- **组合树 diff**：145 → **152** 行插件行，27 → 26 disabled，30 个 diff 行。删 `tool-str-replace-editor`；
  增 `open-in-app`/`ui-open-in-app`/`workspace-files`/`file-upload`/`resources`/`ui-sidebar-right`/`ui-sidebar-textpreview`/`ui-sidebar-files`。
  存档 `spec/dsh/dump-config.0.1.5-alpha.1.yml` + `pkglist.0.1.5-alpha.1.txt`（229 个包全是该版本，Cordis 系 5 个独立版本线）。
- **我们的接触面：零破坏**。`tsc -b` 与 232 条测试**一次通过**。compat 只导出 `defineTool`/`DefineToolOptions`/`Context`，
  0.1.5 的三条破坏性变更（session V3、去 `ctx.agent`、`Inbox` type-only）一条都不碰；`cordis` 仍 `^4.0.2`。
  端到端也验了：`dsh plugin add` 成功、`mast-hello` 进组合树、**探针确认 `apply()` 在真实运行时执行且 `ctx.tools` 是活服务**。
- **顺手修掉钉版测试的一个真缺陷**：它原本遍历 `node_modules/.pnpm` 数版本，而 **pnpm 升级后不修剪虚拟 store**——
  旧版本的 15 个包原样躺在那里**不可达**，于是红了一次假警报。改成**读锁文件**：锁文件才是「将来会装成什么」的权威，
  也正是 CI `--frozen-lockfile` 装的东西；而我们要防的「overrides 静默失效」，后果恰恰就是锁文件里出现多个版本。
  改完做了变红演练（把声明的锁改回 rc.1 ⇒ 当场红）。
- **新学到的 pnpm 行为**：pnpm 11 有 `minimumReleaseAge` 供应链策略，装「发布不足最小天数」的包时会**自动往
  `pnpm-workspace.yaml` 写一段 `minimumReleaseAgeExclude` 记录豁免**。0.1.5-alpha.1 昨天才发，所以 15 个包被记了进去。
  这条以后每次升 alpha 都会发生，**diff 里看到它不是有人乱改**。
- **未做的一步**：清单第 6 步「拿**既有** `~/.dsh` 冒烟」。全程用隔离 `DSH_HOME`，**没有碰用户真实的 home**——
  而 0.1.5 恰恰有两个只在升级既有 profile 时才发作的问题（#5999 client combo 缺 `ui-sidebar-*` ⇒ 全部 client 插件失效；
  #5978/#5979 历史会话冷读失败）。**用户若要把自己的 web profile 升到 0.1.5，先备份 `~/.dsh`。**
- **已知问题六条**与各自会在哪一课时打到我们，逐条列在 `facts.md` §8.0。最要紧的：#6004 是 `dsh-storage-json` 的
  **路径穿越/任意文件写入**（我们的真源在自家 SQLite，但只要跑 dsh 这个洞就在同一进程里；仅本机开发用）；
  #5999 打到 **1.10**；#5983（自定义 provider 加不了）打到 **Phase 3 §7.7**。
- **适配点**：零领域代码改动。改动全在钉版（`pnpm-workspace.yaml` overrides + compat 依赖 + bundle peer）、
  钉版测试实现、以及文档。

### 2026-09-07 · 查到 0.1.3-alpha.2，**核实后暂不升级**（第三次查版；仍无代码）

- **起因**：整理仓库时例行查版。`0.1.3-alpha.2`（09-07 13:11 UTC）占 `alpha` 标签，比 `latest`/`next` 上的 `0.1.2-rc.1` 高一个 minor ⇒ 按「semver 最大值」规则**就是追踪目标**。（npm 上没有 `0.1.3-alpha.1` 这个版本号，但发布说明有它，内容被 alpha.2 吞进去。）
- **阻塞（本次最重要的一条）**：`@deepseek-ai/dsh-session-persistence-jsonl@0.1.3-alpha.2` 新增**硬依赖** `fs-ext@2.1.1`——`scripts.install: node-gyp configure build`，**无预编译，现场编译 C++**。本机没有任何 Visual Studio ⇒ `npm i` 失败于 `gyp ERR! Could not find any Visual Studio installation to use`，整棵树回滚。`fs-ext` 提供 `flock`，对应发布说明的「session 加锁，一进程最多一个 session」。rc.1 时同一个包只依赖 `koffi` + `schemastery`，不需要编译。
- **`--ignore-scripts` 的边界（实测）**：跳过编译能装上（536 包 / 32 s），`--dump-config` **能导**，但 `--profile web` **在插件树加载阶段就崩**（`Cannot find module './build/Release/fs_ext.node'`）⇒ 只够导规格，不能当开发环境。
- **正面发现**：钉 `0.1.3-alpha.2` 装出的树里 **223 个 `@deepseek-ai/dsh*` 全部恰好是该版本，零例外**。semver 规定预发布只匹配元组相同的比较符 ⇒ `^0.1.2-rc.1` 吃不进 `0.1.3-alpha.2`，09-04 那种跨通道漂移**不会跨 minor**。整套精确钉的结论不变（漂移发生在 patch 元组之内，而 dsh 大部分时间就待在那里）。
- **组合树 diff**：145 → 147 行插件行、27 → 26 disabled，**只有四处变更**（删 `tool-str-replace-editor`、`persona` 拆 prefix/suffix、新增 `open-in-app`＋`ui-open-in-app`、新增 `file-upload`）。导出件已入仓 `spec/dsh/dump-config.0.1.3-alpha.2.yml` + `pkglist.0.1.3-alpha.2.txt`。
- **发布说明要点与影响**：逐条列在 `docs/dsh/facts.md` §8.0。破坏性四条——session 格式 v0/v1→**v2**、session 持久化归 `SessionHandle` 且 `agentLoop.create()` 变异步并加「一进程一 session」锁、persona 拆前后段、subprocess 句柄不再带 PID。新包 `dsh-http-proxy`（进程级出站代理，`mast-rig` 的硬闸候选）。
- **上游复查（09-08）**：没修——无新版本发布，`fs-ext@2.1.1` 仍是硬依赖，`fs-ext` 上游也没有带预编译的新版。**`deepseek-ai/deepseek-harness` 已关闭 Issues，反馈渠道是 GitHub Discussions**（npm 包 `bugs.url` 指向的 `/issues` 是死链）。**同一问题已有六份独立报告**（#5929 写得最全，含逐包核对的依赖链，0 评论无官方回应；另 #5882/#5784/#5751/#5638/#5689）⇒ 不另开重复贴。#5882 的评论补了两条我们没测到的：编译过了还会撞 `LNK1181: DelayImp.lib`；pnpm 10+ 默认不跑依赖 `install` 脚本，要 `pnpm approve-builds -g` 放行。
- **额外发现：0.1.3-alpha.2 还有另外三处独立的启动崩溃**（逐条见 facts.md §8.0）——#5881 `duplicate loader entry id: file-upload`（`file-upload` 并进 web-app bundle，加载器把重复 id 从 lint 警告改成致命错误；**直接印证我们的组合树 diff**，也是我们 `cordis.patch.yml` 必须用 `mast-*` 前缀避免撞名的理由）、#5753 session v0→v1 迁移硬拒 `subagent/descriptor` version 2 导致老会话打不开（**session v2 迁移本身是坏的**）、#5889 rpc 通道注册访问未声明的 `owner.webServer`；另 #5913 `dsh-llm@0.1.3-alpha.2` 发布的依赖缺两个包。
- **裁决（2026-09-08，用户确认）**：**锁继续留在 `0.1.2-rc.1`**，把 0.1.3 记成「已知阻塞的待升级」，每课时①照常查版。理由：① 本机装不上；② `latest`/`next` 也还在 rc.1，dsh 自己没把 0.1.3 推上稳定通道；③ 这一版至少有四处相互独立的启动/安装故障，不是我们一台机器的问题，是它还没熟；④ 本仓代码为 0，等待成本接近 0。**替代方案**（装 VS Build Tools + Python）解决的是一台机器而不是产品——我们的 CI 与将来任何装 `dsh-spm` 的人会撞同一堵墙。决策台账见 `docs/EXECUTION.md` §5-B1。
- **本次预测命中**：09-04 记的「`SESSION_FORMAT_VERSION` 的 'Remove at the first tagged release' 会兑现」应验了，只是落点是下一个 minor 的 alpha 而不是 0.1.2 正式版。真升级那次，清单第 6 步（备份 `~/.dsh` + 拿既有 home 冒烟）一步不能省。
- **适配点**：无代码；改文档（facts.md 加 §8.0 与 §1 三条、upgrades.md 本条、spec/dsh/README.md、EXECUTION.md 新建）。

### 2026-09-04 · 0.1.2-alpha.4 → 0.1.2-rc.1（第二次；仍无代码）

- **起因**：例行查版发现两天里出了两版——`alpha.5`（09-02 08:38 UTC）与 **`rc.1`（09-03 06:21 UTC，同时占 `latest` 与 `next`）**。
- **实测发现（本次最重要的一条）**：全新 `npm i @deepseek-ai/dsh@0.1.2-alpha.4` 今天装出的是 **1 个 alpha.4 启动器 + 213 个 `0.1.2-rc.1` 子包**。`^0.1.2-alpha.4` 的语义是 `>=0.1.2-alpha.4 <0.2.0`，同一 `0.1.2` 元组下 `rc.1 > alpha.5 > alpha.4`，**caret 会跨 alpha→rc 通道**。也就是说我们「锁 alpha.4」在全新安装里早已名存实亡，本地之所以看不出来，只因 npx 缓存是 09-02 建的冻结快照。⇒ 升级到 rc.1 不是「要不要跟」，而是**把既成事实写进锁文件**。
- **发布说明要点**：rc.1 是 0.1.2 全线 roll-up。修复面与我们相关的有 Windows 路径截断、Agent Preset 丢失、PowerShell 启动、会话日志修复告警；功能面有 subagent 模型选择、Python SDK Windows x64、实验性 Inspector / Web Preview、请求携带插件元数据、可选 session-log 上传、默认公开 WebFetch + SSRF 防护、连接状态与自动重连。alpha.5 是纯修复（从 rc.2 / alpha.3 升级可能起不来、会话标题消失）。
- **核实**：`--dump-config` 在 alpha.4 与 rc.1 上**逐行相同**（145 行 / 27 disabled）；rc.1 在 Windows 上 `--dump-config` 与 `--profile web` 均正常；`SESSION_FORMAT_VERSION` 仍是 0。
- **影响**：决策 D1–D10 不变，架构、接缝、课时表全部不动。改三处规则——① 追踪对象从「dist-tag `alpha`」改为「所有 tag 里 semver 最大值」；② 升级清单加第 6 步「拿既有 `~/.dsh` 冒烟」（alpha.5 的教训）；③ `web_fetch` 的 deny 从「建议」升为「必须」（rc.1 默认公开 WebFetch）。新增待办：真机 profile 要一并决定关掉遥测与 session-log 上传。
- **风险提示**：已出到 rc ⇒ **0.1.2 正式版临近**，`SESSION_FORMAT_VERSION` 的 "Remove at the first tagged release" 很可能在那一刻兑现。0.2 落 `spec/dsh/` 时把 dump-config 存档纳入版本控制，便于那次跳版逐行对。
- **适配点**：无代码；改文档（facts.md 升到 rc.1 + 新增 §8.1、upgrades.md 改规则加日志、PLAN D11 与风险行、README 版本号）。

### 2026-09-02 · 0.1.2-alpha.3 → 0.1.2-alpha.4（计划批准后第一次；尚无代码）

- **起因**：计划 09-01 锁 alpha.3；alpha.4 于 09-01 16:01 UTC 发布。用户决定升级并改为实时追踪、随 dsh 重构。
- **发布说明要点**：`send_message` 替代子 agent 单向 `report`；`Session.events` → `seq` / `eventAt()` / `snapshotEvents()`，`SessionSeq` 与 `SessionLogOffset` 强类型；`web_fetch` 对 SDK/Headless/ACP/自定义 profile 默认开；Web PTC 默认不暴露 `workflow`；模型目录搜索/过滤；UI 与长对话渲染改进。
- **核实**：web profile `--dump-config` 两版逐行相同（145 行 / 27 disabled）；npx 两棵树 `.md/.d.ts/.yml` 逐文件相同——原因是 `dsh@alpha.3` 对子包声明 `^0.1.2-alpha.3`，npm 已把 213 个子包解析成 alpha.4。
- **影响**：决策 D1–D10 不变；新增 D11；「只钉 `@deepseek-ai/dsh`」改为「整套精确钉」；IC/conduct preset 要显式 deny `web_fetch`；compat 的 session 面只暴露三个新读 API。
- **适配点**：无代码；改文档（本次重构：PLAN.md 去版本化、facts.md/upgrades.md 新建、research/ 归档）。
