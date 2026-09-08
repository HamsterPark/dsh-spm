# dsh-spm：把 MAST 用 TypeScript 重写为 DeepSeek Harness 插件 —— 主计划

> **版本无关正本**。2026-09-01 批准；2026-09-02 重构为三件文档（用户决定：**实时追踪 dsh 最新版、随 dsh 一起做破坏性重构**，见 D11）。当前锁定的 dsh 版本以 `docs/dsh/facts.md` 首行为准，本文正文不写版本号。
> 文档分工：**本文** = 决策、纪律、架构、接缝、流水线、阶段、验证、风险（正文不写任何随 dsh 版本漂移的事实）；
> **`docs/dsh/facts.md`** = 对照当前锁定版本核实的 dsh 事实、dsh 侧陷阱、spike 清单、本次升级影响（每次升级重核）；
> **`docs/dsh/upgrades.md`** = 升级策略与逐次升级日志；**`docs/EXECUTION.md`** = 分段执行计划（下一步做什么、每段停在哪）。
> **2026-09-07 起，2026-09-01 的研究快照不在本仓**，移到 `<PRIVATE_REVIEW_ARCHIVE>\01-dsh-spm\研究快照-2026-09-01\`（八份，只读；MAST 旧仓的行号级事实仍有效）——本仓将公开，那八份是私有旧仓的行号级内部细节，一旦进 git 历史就撤不回来。需要时按绝对路径读。
> 本文引用的「§4」「§15」「§3.1」指 `docs/dsh/facts.md` 里对应的章节，见各处指引。

## 0. 一句话

MAST（LLM 驱动的自主 STM/SPM 实验系统，Python/LangGraph，**498 个技能**（506 条 metadata 声明去重后）、7 个 agent、21 个中间件、自研 harness）
**用 TypeScript 在 DeepSeek Harness (dsh) 上按技能逐个重写**，成为开源插件集 **`dsh-spm`**；session / 记忆循环 /
中断 / 审批 / 后台任务 / UI 壳 / 多 provider 交给 dsh，我们只写 **SPM 领域**：仪器接缝、安全接缝、技能内核与技能、
知识、agent 预设、STM 前端插件。旧仓库 `<MAST_ROOT>\` 原样保留（继续给真机发版 + 当规格书）。

## 1. Context —— 为什么

- 自研 harness「离完美还有很大距离」：8-26 开工的「退出 LangGraph」已写 **5,439 行 / 20 文件** `agentruntime/` + 契约测试 **46 文件 / 13,665 行**（2026-09-01 实测），五个切换面仍全部默认关 ⇒ 生产跑的仍是 LangGraph；工作树 591 项未提交（+42,378/−10,362 行）；全仓 `mast/` 339,608 行 Python，其中纯 harness 目录（agentruntime/chat/memory/llm/billing/prompts + api 约 3/4 + core 约 12 文件）就是要交给 dsh 的那一半。这条路的终点仍是**自己维护一个 harness**。
- dsh（`deepseek-ai/deepseek-harness`，MIT，8 月开源，一周 165k stars、四千余社区插件）把 harness 的通用部分做成了可替换插件：agent loop、append-only session log（resume/fork/replay）、compaction、approval/permission、jobs、subagent、skills、goals、schedule、storage、settings、Web UI slot 系统、多 provider 适配——正是 MAST 里「与 SPM 无关却一直在花钱维护」的那一半。
- 用户 2026-09-01 拍板：全部 TS 重写（不桥接、不 MCP）；一个个 skill 来；前端重做成 STM 插件；旧产物暂不动、一点点重新开源；新仓库 `dsh-spm`、MIT、包名 `dsh-spm-<name>`。

## 2. 已定决策

| # | 决策 | 含义 |
|---|---|---|
| D1 | **全部 TypeScript** | Python 旧代码只是规格；不做子进程桥/HTTP 桥/MCP。**唯一例外**：深度视觉模型的训练与 ONNX 导出留 Python，TS 只做 `onnxruntime-node` 推理（§14）。 |
| D2 | **一个个 skill 来** | 单一内核 + 每技能 DoD（§8.5）；批次 0→8（§8.4）。 |
| D3 | **前端 = STM 前端插件** | dsh 客户端 slot 模块 + 宿主侧 `/mast/*` 路由与投影；旧 20 页逐页迁入（§9）。 |
| D4 | **旧仓库/旧产物暂不动** | 视觉权重、知识文本、文献语料、campaign 记录留旧仓；新仓从零、一点点重新开源。 |
| D5 | **仓库 `dsh-spm` · MIT · `dsh-spm-<name>`（无 scope）** | 路径 `<REPOSITORY_ROOT>\`（2026-09-07 起是 git 仓库）；npm 已核实 `dsh-spm` / `dsh-spm-core` 均 E404 未占；Phase 0 把全部包名发 `0.0.1` 占位。**署名与 GitHub 账号 = `HamsterPark`**（`LICENSE`、各 `package.json` 的 `author` 统一用它）；何时公开见 §16。 |
| D6 | **supervisor 是第 8 个 preset `mast-supervisor`**（队长裁决） | 不并入 research_director：RD 是纲领层（产出假设与纲领），supervisor 是无仪器工具、模型廉价不开思考的调度节点；护栏（visit_count/预算/fan-out/IC 互斥）都挂在 supervisor 会话上。 |
| D7 | **仪器实时状态：全局 SSE 给 UI，session 投影只记「模型当时看到的那一份」**（队长裁决） | 1 Hz × 10 h = 36k 事件/会话会拖慢回放，且无 session 时无处投；仪器是一台、会话是 N 个。 |
| D8 | **审批按 ⑰（2026-08-08）**：DANGEROUS/CONFIRM 照跑 + 通知，硬闸是 deny 不是 ask，`ask` 只给 conduct attended 档与提问类工具（队长裁决，见 §7.3） | 两天真机弹框零真阳性；真正拦下危险的是拒绝型闸（包络/模式/硬闸）。重新加弹框的准入条件照 `core/auto_approval.py:36-41`：举出一次拒绝型防护接不住的真实损害。 |
| D9 | **中止闩不挂单调 guard，挂 `tools/pre-execute`（每次重评）+ 内核 K2** | guard 是「任何后来者不能翻转」——能停不能解 = 死锁；guard 只放会话内永不释放的否决（rigGuard、非仪器 agent、PROHIBITED_IN_PROMPT、物理荒谬）。 |
| D10 | **技能一个包 `dsh-spm-skills`，目录/文件名镜像旧仓模块名**（`builtins/bias.ts` ↔ `bias.py`） | parity 进度按模块对表；tool packs 是注册期分组，不是包边界。以后过大再拆。 |
| D11 | **实时追踪 dsh 最新版；整套精确钉；随 dsh 一起做破坏性重构**（用户 2026-09-02 决定，替代「每 Phase 只升一次」；追踪对象 09-04 修订） | dsh 官方预告还有若干破坏性重构，小步跟比攒着一次爆便宜。每课时开始先查版本，有新版就按 `docs/dsh/upgrades.md` 的清单升一次、单独提交。**追踪对象 = 所有 dist-tag 里 semver 最大的那个，不是某个固定 tag**（09-04：`rc.1` 比 `alpha.5` 新，只盯 `alpha` 会停在旧通道）。**锁的对象是整套 `@deepseek-ai/*`**：启动器与各 bundle 对子包声明的都是 `^` 范围，而 prerelease 上的 caret **会跨 alpha→rc 通道**——实测钉 alpha.4 的全新安装装出 213 个 rc.1 子包，只钉 `@deepseek-ai/dsh` 一个包锁不住任何东西（facts.md §1）。**我们的插件不为旧 dsh 版本保留兼容**：每个插件版本只对应一个 dsh 版本（peer 精确钉）；dsh 破坏性重构时我们同步重构自己的接缝、配置键、投影格式，不留垫片、不做双轨；持久数据只保证 SQLite 真源可迁移，session log 与投影缓存可丢。 |

### 2.1 工作方式：交互式开发、每段讲解（用户 2026-09-01 要求）

**循环**：写一段（一个文件或一个紧密相关的小模块，一般 ≤200 行）→ **讲解**（① 这段做了什么、② 为什么这样写、③ 涉及的 dsh/Cordis/TypeScript 概念、④ 与旧仓 Python 对应物的差别、⑤ 你可以怎么亲手验证：跑哪条命令、看什么输出）→ 你确认/提问/要求改 → 下一段。**不连写多段**；每段结束都停下等你。测试与代码同段写，讲解里把测试也讲一遍。每段讲解末尾给一行「本段术语表」（新出现的名词）。

**Phase 0–1 的课时切分**（后续 Phase 到时再按同样粒度切）：

| 段 | 写什么 | 讲什么 | 你亲手验证 |
|---|---|---|---|
| 0.1 ✅ 09-02 | 环境：pnpm（`corepack enable --install-directory %APPDATA%\npm pnpm`；裸 `corepack enable` 在本机 EPERM）、`npx -y @deepseek-ai/dsh@<锁定版> --profile web --no-open` 跑起来、`--dump-config` 导出组合树 | dsh 是什么、Cordis「一切皆插件」、profile/bundle/patch 三层、web profile 组合树（145 行；web-app 在宿主层关工具、preset 在 agent 平面重挂）、密钥解析顺序、遥测、为什么 npx 必须带版本号 | 浏览器打开带 token 的 URL 发一句话；新终端 `pnpm -v`；看 `--dump-config` |
| 0.2 | 仓库骨架：`package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` / `vitest.workspace.ts` / `.gitattributes` / CI 空壳 | pnpm workspace、TS strict/ESM/NodeNext、project references、为什么镜像 dsh 的目录约定 | `pnpm install`、`pnpm -r build` 空跑通过 |
| 0.3 | `dsh-spm-compat`：防腐层（re-export `defineTool/Context/Service/…`）+ `check-dsh-surface.ts` + `check-dsh-pin.ts` + `check-dsh-latest.ts` + 第一条 contract 测试 | 为什么全仓只许一个包 import `@deepseek-ai/*`、为什么用 pnpm overrides 把**整套** `@deepseek-ai/*` 钉成同一精确版本、contract 测试是什么、升级清单怎么走 | 改一个 re-export 名字看 surface 检查变红；把 overrides 改成 `^` 看 pin 检查变红；`check-dsh-latest` 报出 npm 上的 `alpha` 标签 |
| 0.4 | 总 bundle `dsh-spm` + `cordis.patch.yml` + `stm_hello` 工具（第一次 `defineTool`） | 插件三件套 `name/inject/apply`、`ctx.effect` 回滚、`defineTool` 的 parameters/output/execute、工具流水线 `tool/call → pre-execute → execute → post-execute → result` | `dsh plugin --profile web add ./packages/bundle/dsh-spm`，在聊天里让模型调 `stm_hello` |
| 0.5 | 第一张设置卡 `mast.instrument`（host `installSection` + client `settings.plugin.item`） | host/client 双面、slot 系统、`settingsScope`、客户端 bundle 的隐式基线依赖 | 设置页看到卡片，改端口号后重启读回 |
| 0.6 | dsh spike（§15 十条）逐条写成 contract 测试 + `docs/dsh-spike.md` | 每条事实为什么影响设计、红了改什么 | 跑 `pnpm test --project contract` 看十条结论 |
| 0.7 | `tools/spec-export/export_mast_spec.py` 第一版（只导 `skills.json` + `si_cases.json`） | golden 的作用、为什么分母从真源取、`MAST2_PROJECT_ROOT` 隔离 | 用旧 venv 跑一次，看 `spec/golden/skills.json` 里 SetBias 那条 |
| 1.1 | `dsh-spm-kernel` 类型（`SkillSpec/ParameterSpec/HardwareState/SkillResult/OperatingMode`）+ `si.ts`（逐字移植 `si_quantity.py`）+ golden 测试 | 类型即契约、`exactOptionalPropertyTypes`、SI 前缀规则为什么 `m`/`A` 强制 | `parse_quantity('3p')`、裸 `1.5` 被拒 |
| 1.2 | `nanonis-wire` codec（帧头、类型码表、错误段、`NeedModule`） | 线协议逐字节（32 B 名字回声、body、错误段 8+desc）、大端 struct、为什么空回包=断链 | 对 stmsim 录的字节金样做往返测试 |
| 1.3 | `scripts/gen-nanonis.ts` 代码生成 → `generated/methods.ts` | 从 JSON 规格生成 typed façade、`Result` 不抛的约定、`c` 参数二义怎么解 | 重生成无 diff；`typed.Bias_Get()` 有类型提示 |
| 1.4 | `RoleLink` TCP 客户端（`net.Socket`、单往返、超时、优雅关闭） | Node 单线程 + async 并发下为什么还要 per-role promise 队列锁、有界等待、永不 destroy 在途请求（端口损坏） | 起 `python -m stmsim serve`，`Bias_Get` 读到值；kill 客户端后端口可复用 |
| 1.5 | `kernel/comms-breaker.ts`（熔断状态机，注入时钟）+ 单测表移植 | 3/20 s/30 s、HALF_OPEN 单探针、app-error 算成功、`countHealth` | 用 fake 时钟走一遍 CLOSED→OPEN→HALF_OPEN→CLOSED |
| 1.6 | `dsh-spm-instrument` Service（`call/urgentCall/connectAll/closeAll/breakRole/comms/useTransport/onRecord`） | Cordis Service 类 + declaration merging、`inject` 的装载语义、provider/consumer 三角 | 在 dsh 会话里 `stm_hello` 改成读 `Bias_Get` |
| 1.7 | `instrument-stmsim` provider（spawn/等端口/SIGTERM）+ `instrument-fake` | 生命周期与 `ctx.effect` 回滚、`simulated` 位 | `profiles/mast-sim` 装上后自动拉起模拟器 |
| 1.8 | `instrument-state`（1 Hz 11 verb、stale/carry-forward、`applyPatch`）+ 投影 `mast.instrumentState` + `stm_get_state` 工具 | session projection（fold/wire view/同引用）、Model-visible ⟺ logged、为什么 UI 走 SSE | 会话里问「现在偏压多少」 |
| 1.9 | 看门狗 + `estop()` + `/estop` 命令 | `ctx.commands`、emergency 角色、阈值活读不回退 | stmsim 撞针场景 4 s 内退针 |
| 1.10 | U0：SSE hub `/mast/events` + `ui-core` 右栏「仪器状态」卡 | `webServer` prefix 路由、`EventSource`/`Last-Event-ID`、`defineStore`、`details` slot | 右栏读数 1 Hz 跳动；杀宿主重启 5 s 内续传 |

每段的测试要求与 DoD 不因交互式而放松；只是把「批准 → 整段实现」改成「每段讲解 → 确认 → 下一段」。

## 3. 陷阱清单（动手前必读；行号/版本是快照，实施时先核对）

### 3.1 dsh 侧（逐条事实随版本重核，正本在 `docs/dsh/facts.md` §6；这里只留与版本无关的**设计后果**，编号与 facts.md 对齐）

1. **API 会漂**（0.1.2 系列平均一天一版，官方预告若干破坏性重构；prerelease 的 caret 还会跨 alpha→rc 通道）⇒ `dsh-spm-compat` 是全仓唯一 import `@deepseek-ai/*` 的包；整套 `@deepseek-ai/*` 用 pnpm overrides 钉同一精确版本，`check-dsh-pin` 让混装当场变红；contract 测试对真实 dsh 包断言；升级按 `docs/dsh/upgrades.md` 清单小步跟、我们的插件随之做破坏性重构（D11）；**持久真源放 SQLite 不放 session log**（dsh 自己的 alpha.5 就是修「升级后起不来、会话标题消失」）。
2. **审批请求不带工具参数、`tools/pre-execute` 不能改写参数、无应答者 fail-closed** ⇒ `reason` 放确定性 `ApprovalDigest`（含 `args#hash6`），执行时重算 hash 不等即拒。
3. **`ctx.tools.guard()` 单调不可翻转** ⇒ 中止闩挂 `tools/pre-execute` + 内核 K2（D9）。
4. **jobs 不跨重启、归属启动它的 session** ⇒ 过夜 conduct 自己持久 journal；扫描类 job 重启后标 `interrupted`；只有 conduct 从最后一个已确认步续跑。
5. **Model-visible ⟺ logged** ⇒ 活状态注入方式在 spike 里钉死（`systemPrompt.section` 内容逐请求进 log，否则改 `agent/pre-step` 注入 user-role 块）。
6. **`presentCall/presentResult/render` 是纯函数** ⇒ offload/剥审计键在内核，render 只排版。
7. **`llm-pi-ai` 无 prompt caching、各家思考参数不一** ⇒ Kimi/Qwen/GLM 自写 `LlmAdapter`（§7.7）。
8. **Windows 上 bash/PTY 有坑** ⇒ 我们的工具不依赖 shell；IC/conduct preset 用 `restrict({deny})` 裁掉 bash/pwsh（以及 `web_fetch`，facts.md §8）。
9. **patch 按 id 整行替换不深合并** ⇒ 覆盖 dsh-base 行时抄全原键。
10. **工具 schema DSL 无 `minimum/maximum`** ⇒ 范围写进 description，且与解析同源（§3.2-1）。
11. **客户端 bundle 有隐式基线依赖、组件禁 import ctx、store 只在 `apply` 内建** ⇒ §9 约定。
12. **slot 名与其待核实项** ⇒ 只用 facts.md 列出的已核实 slot；待核实项进 spike。
13. **Python SDK 不能做 HITL 自动化测试** ⇒ 测试用 TS 侧 `ctx.agents.create` + 应答者插件。
14. **MCP client 只桥工具** ⇒ 不用；记此防回头。
15. **`ctx.tools.restrict` 只能取交集** ⇒ 桩保持绑定 + 动态换注册（§7.8）。
16. **web profile 在宿主层禁用全部模型可见工具，由 agent preset 在 agent 平面重挂**（0.1 实测）⇒ 我们的工具从宿主 bundle 注册后是否进入 preset 目录，0.4 实测；8 个 preset 就写成 `agent.cordis.yml`；provide 服务的行必须放带 `isolate` 的 `cordis:group`。

### 3.2 MAST 侧（TS 端必须复刻的语义，都来自真机事故）
1. **有量纲 float 参数以字符串要模型写**（Kimi 受限解码把 3e-12 变 3；string 12/12 正确），`m`/`A` 量纲**强制 SI 前缀**，`V/s/Hz/deg` 不强制；范围提示与解析**同源**（`effectiveBounds` = spec ∩ 安全包络含 admin 覆盖）。
2. **abort 闸不许编造中止来源**（急停 / E_STOP / 环境告警 / 会话停止，大多数不是人）。
3. **审计键（`safe_mode_raw`）绝不进模型上下文**；SAFE = 判定出口覆写为 good + 脉冲/整形硬拦，**保护全开**。
4. **闸门在记录之后**：被 validate/precondition 拒绝的调用也要进记录。
5. **precondition 抛异常 = fail-closed**；未知前置名 = "Cannot verify" 拒绝。
6. **成功后写回状态缓存**（`patch_state_from_result`），否则下一技能读旧值死循环；前置不满足先 `refresh()` 再判一次。
7. **失败附全部 data（去审计键），成功只附 detail**；>2000 字符落盘留引用。
8. **图像走路径不走像素**；像素只在出站 materialize。
9. **Nanonis**：4 端口/角色、5 s recv 超时硬约束、响应必须逐字回声命令名（不匹配 = 断链，不是 `[]`）、**空回包 = 断链**、`NeedModule` 子串、force-kill 永久损坏端口 ⇒ 优雅关闭、永不 destroy 在途请求；全 positional；`BiasSpectr_*`；`PropsSet` 标志 0/1/2；`_Open` 先于使用；熔断只数 TCP 级失败（3 次/20 s，四角色共用）、app-error 算成功。
10. **仪器互斥**（读与停/退针豁免，5 s 等待后拒绝不排队）与「instrument-capable 分支同一时刻至多一个」是两层，都要。
11. **未加载的工具以桩保持绑定**（收窄工具面会把「读缓冲区」变「回 home」——`tool_choice="required"` 时 6/6 返回绑定名而文本说「未执行」）。**注意：这条在旧仓是未实施的待办**（`docs/api_providers/AUDIT.md`），TS 端复刻的是结论本身，没有可参照的实现——与其它「有代码可抄」的血泪条目性质不同。
12. **IC `max_tokens ≥ 8192`**（参数 JSON 截断成非法 JSON）；reasoning 模型 ≥ 16000；**带工具调用一律不流式**（流式 tool call 把 `3e-12` 截成 `3`）。
13. 「读不到」不是答案：`None/0/False` 不冒充；三态求值 UNDECIDABLE 不折进 FALSE；`_ABSENT` 哨兵不用 `null`。
14. 判据一律从真源派生（技能 golden、preconditions 词表、tool packs、导航分母都从旧仓导出/派生，不手抄）。
15. **每一个循环边界都要问「per-run 还是 per-system」**（$30.66 事故）：能产生新 run 的入口（唤醒/cron/webhook）都要 per-system 配额，`0` 的语义先定死。
16. StallGuard 等判据不许落在**文案**上（语言迁移让守卫半盲）：一律结构化 `code + signature`，文案只做渲染；模型读的钉住短语放 `messages.ts` 一处并测试不被换行劈开。


## 4. dsh 事实速查

已移至 **`docs/dsh/facts.md`**（对照当前锁定版本核实；每次升级重核并改首行版本号）。本文其它章节引用的「§4」一律指该文件 §5（能力对照表）。

## 5. MAST 事实速查（要复刻的契约；路径在 `<MAST_ROOT>\mast\`）

- **规模（rg 现场数）**：`SkillMetadata(` builtins **434**（110 模块）+ composite **38** + paper **34** ≈ **506**，registry 去重后 **498**（builtins 432 + composite 34 + paper 32；AUTO 269 / CONFIRM 219 / DANGEROUS 10；WRITE 243 / READ 164 / ANALYSIS 56 / COMPOSITE 43）。**⚠️ `composition_level` 不能当分批依据**：只有 124/498 显式声明（L0×116、L1×5、L2×1、L3×1、L5×1），其余 374 个吃默认值 0（docstring 自承 "unmigrated skills… show up as atomic"）——批次成员一律从 `category` + 目录（builtins/composite/paper）+ `safety_level` 三者派生（golden），不读该字段。声明 preconditions 的只有 45 个（词表实际只用 `z_controller_on` 38 / `scan_not_running` 6 / `z_controller_off` 3 / `bias_nonzero` 2 / `vacuum_ok_for_coarse` 1）；capabilities `tip_shaping` 8 / `bias_pulse` 6 / 兼有 3；参数 float 622 / int 411 / str 305 / bool 193，`allowed_values` 60 处；单位 `m` 153、`s` 127、`V` 73、`Hz` 27、`nm` 25、`A` 18…；技能树经 `safe_call` 调用 **529** 个 Nanonis 动词，stmsim 实现 **203**（PLL/Script/HSSwp/KelvinCtrl/OsciHR/SpectrumAnlzr 等在模拟器上没有）；数值依赖 numpy 85 模块、torch 14、matplotlib 7、sklearn、scipy（correlate2d/gaussian_filter/fftconvolve/curve_fit/zoom/label…）、skimage（phase_cross_correlation/ssim）。
- **技能契约** `core/types.py`：`SafetyLevel{AUTO,CONFIRM,DANGEROUS}`（**DANGEROUS 全名单 10 个**：CreateZCtrlPreset / LoadMultiPassConfig / LoadNanonisScript / LockNanonisUI / MoveProbeXY / QuitNanonis / RunRfFrequencySweep / SetLaserOnOff / SetPiControllerOnOff / StartRfGenerator——**全部与针尖损伤无关**，语义是「绕过保护/接管仪器/加载外部脚本」；`core/types.py:22` 的枚举注释「Only 2 skills」及其 08-25 更正块**都已过期**，TS 端别抄注释、枚举 metadata）、`SkillCategory`、`ParameterSpec`、`SkillMetadata{…composition_level, capabilities}`、`HardwareState`（含 `stale`、`z_controller_status` 六态、活动 Z 控制器身份、`lockin_mod_on`、扫描框几何）、`SkillResult{…summary?, images[路径]}`、`OperatingMode{SAFE,SEMI,AUTO}`。`skills/base.py` `BaseSkill`：`metadata/validate_params/check_preconditions/execute/rollback/abortable_sleep`。
- **wrap_skill** `agents/_shared/skill_adapter.py`（1315 行）= 技能→LLM 工具唯一入口；闸门顺序：SI 解析 → abort 闸 → sample 闸 → 快照+计时 → validate_params → preconditions → instrument_lock → 调制关闭 preflight → execute → 写回状态 → summary/offload → 图像路径 → 状态更新（executed_skills/scan_paths/last_scan/error_log/composite_progress）→ records → post_hook → 异常（abort/busy 不回滚；其它 rollback）。`ExecutionContext.run`（`core/execution_context.py:325`）对 composite 子步重跑同一链；**Python 有 4 条取令牌路径、3 份前置解析、2 份 SAFE 判定，都漂过** ⇒ TS 只许一个 choke point。
- **安全** `core/safety.py`：物理硬底（|I|≥1e-3 A、|V|≥1e4 V、p_gain≥1e-3 m、i_gain≥1 m/s，单位精确匹配）；`_GLOBAL_CHECKS` 按（名字子串×单位子串）→ `SafetyLimits` 对（bias ±10 V、z 0…1.5 µm、xy ±1.5 µm 只管中心、setpoint 1 pA…100 nA、scan_size 0.1 nm…10 µm、z_offset ±1.6 µm 有符号、tip_lift ±100 nm）+ admin 覆盖；五个人级参数硬闸 `is_coarse_sample_approach / is_calibration_change / is_coarse_drive_change / is_unguarded_lateral_coarse_move / is_protection_disable`；`mode_refusal`（SAFE 拒脉冲+整形、SEMI 只拒 >5 nm 深扎且电脉冲直接跑并公告、AUTO 放行、mode 未绑定放行）；`core/auto_approval.py::would_have_asked`（DANGEROUS / SEMI 电脉冲 → **照跑 + 通知**：诊断台账 `notice_only` + `approvals` 审计行 approver_kind=automated_policy）；`core/instrument_lock.py`（READ/ANALYSIS、`retract/emergency/withdraw` 标签、`Stop*/SafeRetract/EmergencyRetract/WithdrawTip` 豁免；5 s 等待后拒绝；元数据读不到 ⇒ 需要令牌）；`core/comms_health.py`（3 次/20 s/30 s 窗口，HALF_OPEN 单探针，四角色一个）；`core/tip_crash_tracker.py`（8 nm 网格、同格 ≥2 次阻塞、TTL 1800 s）；`core/sample_gate.py`（数据类技能需活动样品，模糊放行）。
- **状态缓存** `core/state.py`（monitor 角色 1 Hz，11 个 verb：`Bias_Get / ZCtrl_StatusGet(1 Off/2 On/3 Hold/4 SwitchingOff/5 SafeTip/6 Withdrawing) / ZCtrl_CtrlListGet / ZCtrl_SetpntGet / Current_Get / ZCtrl_ZPosGet / FolMe_XYPosGet(0) / ZCtrl_LimitsGet / Scan_StatusGet / LockIn_ModOnOffGet(1) / Scan_FrameGet`；五个核心读全空 ⇒ stale=True 且保留旧时间戳；None 不覆盖旧值；`apply_patch` 白名单+数值强转）；看门狗 `core/watchdog.py`（monitor 0.5 s × 8 窗口连续超阈值才退针；阈值每 tick 活读、读不到不武装）；急停 emergency 角色 `ZCtrl_Withdraw(1,-1)`。
- **Nanonis 线协议**：`core/nanonis_patch.py`、`core/connection.py`（角色 main/monitor/data/emergency → 6501–6504；`safe_call` 闸序 closed → 熔断 → 按角色有界锁 30 s/急停 2 s → 断连重连 → 调用 → app-error 算成功 → 空回包算断链；`urgent_call` 锁不到 `break_role`；`close_all` 先置 closed 再逐角色 5 s 锁关）。**机器可读协议表** `<STMSIM_ROOT>\stmsim\spec\nanonis_commands.json`（671 方法 command/params/args[{name,fmt}]/returns[fmt]，`patch_applied_names` 19 项）→ TS 客户端**代码生成**；类型码 H h I i f d / 2X / *X / -*X / +*X / **X / +*c / *-c / *+c / **c / *2c（`STM-Bench/stmsim/wire/codec.py`）；请求侧 `c` 参数 str/list 二义要用 `wire/spec.py` 的 `array_string_args`。
- **模拟器** `<STMSIM_ROOT>\`：`python -m stmsim serve --profile polar-spm --seed 0 --material "Au(111)" --ports 6501,6502,6503,6504 [--approached] [--time-scale] [--session-dir]`；`Dispatcher.call_log` 行**不带参数**，但 `fault_hook(command, args)` 在解码后执行前被调（差分测试取参数）；`World.truth()` / `World.events`（scan_start/scan_stop/scan_saved/withdraw/poke/pulse/sts/motor_move/approach_*/crash/tilt_set）；MAST Python 技能已零改动跑通（`tests/test_mast_skills_e2e.py`、`test_e2e_composites.py`）。
- **外壳**：真入口 `python -m mast.api`（FastAPI，7870）；55 路由模块/openapi 285 路径；`AppContext` standalone/live 两模式；路由遮蔽教训（字面量段先于 `/{id}`）；实时通道 WS `/ws/events?since=seq`（EventBus、100 条环形重放、`dropped` 帧）→ SSE → 轮询；`EventType` 开放集（hardware_state/anomaly/scan_complete/skill_step/experiment/connection/current_monitor/artifact_saved/chat_narration/conduct_*/skill_recommendation）；**客户端断开不打断生产者**（Wi-Fi 漫游曾等于中止）、停止按钮不许撒谎。前端 React 18.3/Vite 6/TS 5.6/Tailwind 3、20 页/10 大标签（`lib/nav.ts TABS` 真源）、组件 37,589 行、`lib/` 7,818 行纯函数、47 个 `node --test` 单测（全部不依赖 DOM）+ Playwright 4 spec；**像素归后端、矢量归前端**（`/api/scans/preview` 回 PNG；uPlot 曲线；Konva 地图）。打包 PyInstaller + Inno + OTA（`mast/update/`，签名技能包）——dsh 下分发即 `dsh plugin add`。tests/v2 922 文件（unit 741）；`tests/conftest.py` 全局 mock `nanonis_spm`；LLM 替身 `ScriptedModel`/`GenericFakeChatModel`（behavior_pins 不存在）。
- **运行时（勘察 `runtime_survey.md`）**：19 个 `*_mw.py` 里 **14 个是 `wrap_model_call` 纯请求装饰器**（live_state/memory/mode/tip_context/instrument_profile/upstream/request_readback/alert_delivery/stall_guard/tool_visibility/tool_pair_guard/prefill_guard/vision/message_clock）、3 个 `before_model` 写 state（compaction/tool_refine/buffer_hitl）、1 个 `after_model`（recorder）、3 个 `wrap_tool_call`（safety/auto_approval/buffer_hitl）；统一注入门 `_shared/inject.py`（稳定块挂 system、逐轮易变块挂最后一条 human 保 cache 前缀、归属登记）；定向注入真源 = 模块级 `AGENTS` 常量；注入顺序 Upstream → ExperimentPrefs → InstrumentProfile → LiveState → ModeBelief → AlertDelivery；memory/readback 按 user 轮缓存。记忆：`memory/store.py`（与实验库同 sqlite）+ `memory_vectors.db`（sqlite-vec/numpy 回退，manifest 变则重建），embedder DashScope v3(1024) → 本地 bge-small(512，绝不静默下载) → substring，写入四路（工具/compaction sink/PhaseManager 24 条/Dreaming 30 min 🌙）。goals：`done_when` 闭集 6 谓词（artifact_present/artifact_count_at_least/operator_confirmed/conduct_completed/best_frame_settled/claims_supported）+ `conduct.rules.evaluate` 三态（259 行）；基线 = 目标设定那一刻，抓不到留 None 不写 `{}`。唤醒四道防护（每实验每日 6 次、日预算 300 USD、同 park 冷却 30 min、目标闸在花钱之前）。conduct：Campaign→Plan→Conduct→Experiment/Action；Director 确定性 tick、三张表、`record()` 唯一改动门、`active_slot UNIQUE`、自主度三档 = min(全局, spec.max_autonomy)、supervised 点火延迟 600 s 撤销窗、L1 llm seat / L2 只读值守席。知识：拉取式 `query_knowledge(detail_level)`（`knowledge_mode` 三档已删，墓碑「谁读它」）；15 份域知识是 Python dict 常量；`skill_guidance` 60 KB；`nanonis_manual` JSON（CHM 抽取，gitignored）；`stm_glossary.yaml` 370 KB。告警投递 ALWAYS/FOLD/MUTE（critical 永不静音；未分类默认 FOLD）。语音：DashScope ASR/TTS realtime，`stream_events` 逐 token，句子聚合 min 8/hard 60，永不自动批准。
- **HITL 现状**（勘察 `explore-harness-layer.md`）：`safety_mw.py` 全文零 `interrupt`——纯拒绝型；⑰ 之后真正阻塞等人的只剩三处：`ask_tools.py` 的 `ask_user`（v2 走 `current_context().ask` 原地阻塞，退化到 `interrupt` 重放）、supervisor「问操作员消歧」节点、composite `interpreter.py` human 节点；等待机制 `api/hitl_bridge.py`（458 行，900 s 按 kind fail-closed，store 进程内存不持久化；裁决回灌 `resolve_interrupt` 先校验中断自己声明的 `allowed_decisions`）。四个落盘库：`mast_experiments.db`、`orchestrator_checkpoints.sqlite`（私聊群聊共用一个 SqliteSaver）、`mast_conversations.db`（`conversation_messages` 只服务群聊转录；私聊正文只活在 checkpoint）、`memory_vectors.db`；thread_id 前缀 `conv-{agent}-{cid}` / `agents-{task}` / `task:{task}` / `bg-{run}`。
- **两套并行 provider 栈**（TS 端必须收敛成一张 `providerTraits` 表）：A `agents/_shared/models.py`（langchain：Claude/MiniMax 走 `ChatAnthropic`，Kimi/DeepSeek/Qwen/GLM 走 `ChatOpenAI` 子类 `ReasoningPreservingChatOpenAI` 补 `reasoning_content` round-trip）与 B `llm/client.py`（732 行，Anthropic SDK + 手写 httpx，自制 Anthropic↔OpenAI 消息转换）；两处双真源：`models.py` 不调 `config.model_thinking_mode`（自带常量）、`max_tokens ≥ 16000` 下限在四处各写一遍。`llm_route.py`（139 行）只是 provider 中立的路由解析器（三级容错，0 或 >1 命中一律 None 不猜）。`prompts/registry.py`（735 行，约 30 条注入项）+ `capture.py`（实收请求环形缓冲）+ `ledger.py`（块归属账）+ `builds.py`（每次建图挂了哪些中间件，`parity_report` 靠它）。
- **LLM**（`config.py`）：OpenAI-compat —— moonshot `https://api.moonshot.cn/v1`、deepseek `https://api.deepseek.com`、qwen `https://dashscope.aliyuncs.com/compatible-mode/v1`、zhipu `https://open.bigmodel.cn/api/paas/v4`；Anthropic-compat —— anthropic、minimax **`https://api.minimaxi.com/anthropic`**；默认 `kimi-k3`；`model_thinking_mode()` none/fixed/tunable；`MODEL_INPUT_CONTEXT`（compaction 预算真源，默认 120k）/`MODEL_OUTPUT_LIMIT`；结构化输出六家五样 ⇒ 全走 tool calling。
- **设置键**（`webui/settings_store.py KNOWN_KEYS` ~55）：压缩/工具包、调用限额、预算/唤醒、能力/硬件、阈值 holder、仪器（instrument_profile/scan_policy/zctrl_presets/coarse_drive(PIN)/tip_conditioning_overrides/experiment_defaults/nanonis_*）、模型/UI/语音、实验文件夹、文献；当前实验/样品在 `active_scope` 单行表。

## 6. 目标架构

### 6.1 三条贯穿原则
1. **一个 choke point**：TS 只允许一个 `SkillKernel.run()`（§8.1）；agent 工具边界、composite 子步、GUI/命令、conduct 步、CLI 差分跑手全部经它；dsh 的 `tools/*` 瀑布只把内核裁决**翻译**成 allow/deny/ask 并做冗余，不另做判断。
2. **纯核心与宿主分离**：全部判据（荒谬值、包络、mode_refusal、熔断状态机、锁、崩针网格、SI、前置条件、三态求值）在零 dsh 依赖、零 I/O 的 `dsh-spm-kernel`；旧仓 pytest 断言表原样移植成 `it.each`。dsh 只在 `dsh-spm-compat` 被 import。
3. **安全件是装载依赖，不是运行时检查**：`skill-runtime` `inject: ['stmSafety','instrument','instrumentState']`——缺一不装载（Cordis 原生语义 = 「少一件就抛」）；再加 `stm_selfcheck` 工具/命令在会话内证明 guard 已注册、看门狗武装、熔断在场、rig profile 下 approval ≠ never。

### 6.2 文件树（pnpm workspace `packages/*/*`，镜像 dsh 约定）

```
dsh-spm/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  tsconfig.client.json  vitest.workspace.ts  .github/workflows/ci.yml
├── scripts/       gen-nanonis.ts（协议表→typed façade）  stmsim.ts（起停模拟器）  check-dsh-surface.ts  check-boundaries.ts  gen-skill-cards.ts
├── spec/          nanonis_commands.json（拷自 STM-Bench，附 provenance）  nanonis_wire_fixtures/（Python 客户端录的字节金样）
│                  golden/（§8.6 导出）  deviations.md（有意与 Python 不同的行为，每条带测试名）  progress.json
├── tools/spec-export/export_mast_spec.py  record-traces.py（Python，只读旧仓，用旧 venv 跑）
├── presets/       8 个 agent preset（agent.cordis.yml；bundled 发现）
├── profiles/      mast-sim / mast-offline 两份 cordis.patch.yml（**mast-rig 在 Phase 8 之前不存在于仓库**）
├── knowledge/     SKILL.md 形态的域知识（构建时从旧仓 dict 常量转出）
├── docs/          PLAN.md、EXECUTION.md、dsh/{facts,upgrades,spike}.md、skills/（自动生成技能卡片）、ui-parity.md
└── packages/
    ├── host/compat/            dsh-spm-compat        ★防腐层：唯一 import @deepseek-ai/*；按用途分文件 plugin/tools/agent/session/jobs/ui/llm/client；精确锁版本
    ├── host/kernel/            dsh-spm-kernel        纯域核心：类型、SI、包络、mode_refusal、硬闸谓词、熔断、锁、崩针、preconditions、rules 三态、messages.ts（钉住短语）
    ├── instrument/nanonis-wire/ dsh-spm-nanonis-wire  codec + net.Socket 客户端 + generated/methods.ts；零 dsh
    ├── instrument/instrument/  dsh-spm-instrument    Service ctx.instrument（连接池/角色锁/熔断/回声/空包/优雅关闭/urgentCall/看门狗/急停）；缺省 transport = nanonis-tcp
    ├── instrument/instrument-stmsim/ dsh-spm-instrument-stmsim  provider：spawn `python -m stmsim serve`、等端口、simulated=true
    ├── instrument/instrument-fake/   dsh-spm-instrument-fake    provider：进程内应答表（单测，不开 socket）
    ├── instrument/instrument-state/  dsh-spm-instrument-state   Service ctx.instrumentState（1 Hz 缓存、历史、applyPatch）+ 提示段/工具 stm_get_state
    ├── safety/stm-safety/      dsh-spm-stm-safety    Service ctx.stmSafety + tools/* 四钩子 + guard + ApprovalDigest + /mode /estop /withdraw + 设置卡 mast.safety
    ├── skills/skill-runtime/   dsh-spm-skill-runtime SkillKernel（唯一 choke point）+ defineSkillTool + SkillRegistry→tool packs（桩/换注册）+ RunLedger + StallGuard + jobs/human 桥
    ├── skills/skills/          dsh-spm-skills        builtins/ composite/ paper/ ——文件名镜像旧仓模块名（bias.ts ↔ bias.py）
    ├── skills/spec-composite/  dsh-spm-spec-composite 声明式 composite（12 种节点、jsep 白名单求值、version_store CAS、templates、loader）+ 技能工坊/市场装载面
    ├── data/numerics/          dsh-spm-numerics      Mat/FFT/线代/拟合/滤波/连通域/统计/RNG/colormap/npy；**同构**（客户端也用）；numpy 金样
    ├── data/nanonis-files/     dsh-spm-nanonis-files .sxm/.dat/.3ds 读写 + 方向归位（GBK COMMENT）
    ├── data/sim-harness/       dsh-spm-sim-harness   spawn stmsim；SpecEchoServer（TS，按 spec 应答 671 动词）；truth 客户端；trace 记录/比对
    ├── vision/vision-classic/  dsh-spm-vision-classic 42 个 numpy 检测器里的经典部分
    ├── vision/vision-onnx/     dsh-spm-vision-onnx   onnxruntime-node(DirectML/CPU) + manifest；权重不入仓
    ├── records/stm-records/    dsh-spm-stm-records   Service ctx.stmRecords：实验/样品/动作/针尖登记/仪器档案/环境历史/审批审计/journal/RunLedger（node:sqlite → better-sqlite3 退路）+ storageDomain 小域
    ├── knowledge/knowledge/    dsh-spm-knowledge     ctx.skills provider（SKILL.md ×15+）+ query_knowledge/get_skill_guidance/get_fault_diagnosis/nanonis_manual/stm_glossary 工具 + 三档提示段
    ├── knowledge/memory/       dsh-spm-memory        段 provider + memory_* 工具 + 向量表（DashScope embedding → FTS 回退）；MemoryBackend 可替换
    ├── knowledge/literature/   dsh-spm-literature    文献索引/全文检索/取文板（Phase 6，语料不入仓）
    ├── llm/llm-providers/      dsh-spm-llm-providers OpenAiCompatAdapter（Kimi/Qwen/GLM）+ providerTraits 表 + usage 记账
    ├── agents/agent-presets/   dsh-spm-agent-presets persona/context/toolface/guards 四个子插件 + 8 preset + subagent 配置 + 产物账本读写
    ├── agents/conduct/         dsh-spm-conduct       Campaign/Plan/Conduct/goals(done_when)/自主度/撤销窗/journal/唤醒 stm-watch/park 板
    ├── client/stm-ui/          dsh-spm-stm-ui        宿主面：/mast/* 路由、SSE hub、6 个投影、命令、9 个设置节
    ├── client/ui-core/         dsh-spm-ui-core       client，immediately；mastEvents/mastApi 客户端服务；右栏卡；shell.overlay；sidebar「STM」组
    ├── client/ui-chat/         dsh-spm-ui-chat       client；tool.call.toolview(stm_*)、审批卡、节点 stm-frame/mast-narration/mast-goal、composer chain、fence
    ├── client/ui-data/         dsh-spm-ui-data       client（懒）；数据/扫描地图/视觉缓冲/仪器工具视图；Konva+uPlot+numerics
    ├── client/ui-ops/          dsh-spm-ui-ops        client（懒）；实验记录/智能体/Conduct/心愿单/监控/环境历史/初始化/记忆/用量/仪器/高级管理
    ├── client/ui-skills/       dsh-spm-ui-skills     client（懒）；技能/构建器/文献库；xyflow
    ├── cli/                    dsh-spm-cli           `dsh-spm skill run <Name> --params '{}' --ports … --json`（差分跑手/手动执行）
    └── bundle/dsh-spm/         dsh-spm               总 bundle：依赖全部 + cordis.patch.yml（只 insert）
```

### 6.3 bundle / profile / 防腐层 / 开发约定
- **一个总 bundle + profile 组合**：bundle 是安装单位（`dsh plugin add dsh-spm`），profile 是组合单位；安全件必须随技能一起装。`cordis.patch.yml` 只 `insert` 我们的行（id `mast-instrument / mast-instrument-state / mast-safety / mast-records / mast-skill-runtime / mast-skills / mast-knowledge / mast-presets / mast-ui …`，每行 `inject` 写全）。`profiles/mast-sim`（插 `mast-instrument-stmsim`，端口 16501–16504，`mode: AUTO`，`rigGuard.allowRealRig: false`）、`profiles/mast-offline`（无仪器）；**`profiles/mast-rig`（`allowRealRig: true`、`mode: SAFE`、approval `ask`）Phase 8 才入仓**——真机 0 次是仓库结构不是纪律。
- 需按 id 覆盖/裁剪的 dsh-base 行（实施时以 `dsh --profile web --dump-config` 逐行核对）：默认模型行 → `kimi-k3` 经 llm-providers；`tool-bash/pwsh` **不从 profile 删**（连锁不装载），在 IC/conduct preset 用 `restrict({deny})`；`approval` policy `ask`（rig 下 `never` 被 selfcheck 拒绝）；`permission` 加 `mast-rig` 预设防「全部允许」绕过；`subagent/tool-subagent` config `maxDepth: 2`、`enableRunInBackground: true`；`compaction-basic`/`tool-result-pruner` 保持。
- **防腐层与版本锁**：全仓只有 `packages/host/compat/src/` 出现 `from '@deepseek-ai/`（oxlint `no-restricted-imports` + 结构测试）；根 `package.json` 的 pnpm `overrides` 把**整套** `@deepseek-ai/dsh*` 钉成同一精确版本（Cordis 系 `@deepseek-ai/cordis*`、`cosmokit` 各钉各的精确版本），compat 的 `peerDependencies` 同样精确；`scripts/check-dsh-pin.ts` 断言安装树里 `@deepseek-ai/dsh*` 只有一个版本；`scripts/check-dsh-surface.ts` 把依赖的 dsh 符号清单 + slot 名写成 `dsh-surface.lock.json`；`scripts/check-dsh-latest.ts` 比对 npm `alpha` dist-tag 与锁定版本（有新版就报，CI 只警告不红）；vitest `contract` project 对真实 dsh 包断言签名与行为；升级按 `docs/dsh/upgrades.md` 清单走，单独提交 `chore(dsh): bump a → b`，先在 compat 内适配，适配不了就随 dsh 一起重构（D11）。
- **开发约定**：TS strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`、ESM/NodeNext；只有 client 包用 tsdown `clientBundle`（host/client 双面），其余 `tsc -b`；vitest 三 project `unit`/`contract`/`integration(stmsim)`；覆盖率：kernel/safety/nanonis-wire/instrument/skill-runtime/conduct **逐文件 100%**（一个没测到的分支就是一次物理风险），skills 100% 行，numerics/vision 90%，UI 组件 80%；`/* v8 ignore */` 必须带 reason；lint oxlint；边界规则（skills 互不 import、agents 不 import skills、kernel 禁 I/O）落 `check-boundaries.ts`；CI `windows-latest` + `ubuntu-latest` × Node 22.19/24，两端都跑 stmsim 集成（`setup-python@3.13` + `pip install numpy scipy pyyaml` + STM-Bench 钉 commit）；`.gitattributes` 钉 LF；commit 中文首行 `feat(pkg): …`。

## 7. 能力接缝（Service Definition / Provider / Consumer）

### 7.1 `ctx.instrument`（`dsh-spm-instrument`）
```ts
type Role = 'main'|'monitor'|'data'|'emergency';
interface CallRecord { method; args; role; returnValue?; error?; /* 前缀机器可判: RoleBusy: | comms_circuit_open: | EmptyReply: | WrongEcho: | Timeout: | NeedModule: */ elapsedMs; at }
interface CallOptions { role?; timeoutMs?(≤5000); lockTimeoutMs?(30000/急停 2000); countHealth?(高频只读传 false); signal? }
interface InstrumentTransport { id: 'nanonis-tcp'|'stmsim'|'fake'; simulated: boolean; open(role): Promise<RoleLink>; describe() }
interface InstrumentService {
  call(method, args, opts?): Promise<CallRecord>; urgentCall(...);   // = safe_call / urgent_call
  readonly typed: NanonisFacade;                                      // 代码生成：typed.Bias_Get() → Result<[number]>
  connectAll(); closeAll(); breakRole(role, why); comms(): BreakerSnapshot;
  useTransport(t): () => void; onRecord(fn): () => void;               // provider 注册 / records·差分测试挂点
  watchdog: SafetyWatchdog; estop(reason): Promise<EstopResult>;       // 停 approach/motor → ZCtrl_Withdraw(emergency) → 置 abort 闩 → 发事件
}
```
- 逐条复刻 `connection.py`/`comms_health.py`：熔断 3/20 s/30 s 四角色一个实例、app-error 算成功、**空回包 = 失败并重连**、`countHealth=false` 不记账；每角色一个 **promise 队列锁**（有界等待 30 s/急停 2 s/关闭 5 s，超时返回 `RoleBusy:` 不排队）；回声校验失败 = `WrongEcho:` + 重连 + 熔断记账（比旧客户端的 `[]` 更严）；优雅关闭走进程退出钩子 + `ctx.effect` 回滚，**永不 destroy 在途请求**；看门狗 monitor 0.5 s × 8 窗口、阈值每 tick 从 `ctx.settings` 活读、读不到不武装并在投影亮红。
- **Typed façade 代码生成**（`scripts/gen-nanonis.ts`）：fmt → TS（`H h I i` 整数校验、`f d` number、`*X/-*X/+*X/**X` number[]、`2X` number[][]、`+*c/*-c` string、`*+c/**c` string[]、`*2c` string[][]）；`c` 参数 str/list 二义从 stmsim `wire/spec.py` 的 `array_string_args` 一起生成；每方法 `Bias_Set(v): Promise<Result<[]>>`，`Result = {ok:true, values} | {ok:false, error, record}` 不抛；生成物入仓，CI 校验重生成无 diff；`patch_applied_names` 19 项标 `source:'mast-patch'`。
- Providers：nanonis-tcp（缺省）、stmsim（同一 TCP 客户端 + 生命周期 spawn/等端口/SIGTERM，`simulated=true`）、fake（应答表）。**真机与模拟器只差 `simulated` 位**，rigGuard 据此拒绝。

### 7.2 `ctx.instrumentState`（`dsh-spm-instrument-state`）
`snapshot()`（≤1 s 旧）/ `refresh()` / `applyPatch(partial)`（白名单+强转）/ `history(ch)` / `onChanged`。1 Hz 在 monitor 角色跑与 `state.py` 相同的 11 个读，stale/carry-forward 逐字移植。**进模型的三条路**：① 提示段 `stm-live-state`（≤12 行紧凑块，AUTO 档不注 mode；Phase 0 钉「section 内容逐请求进 log」，否则改 `agent/pre-step` 注入 user-role 块）；② 工具 `stm_get_state`（READ，不取令牌）；③ `agent/session-start` 用 `agent.inject()` 播种一次「仪器档案 + 针尖登记 + 当前模式」。**UI 走全局 SSE**（D7），投影 `mast.instrumentState` 只在模型看到状态那一步折一份快照（回答「模型当时看到什么」）。高频读回流（20 Hz 示波器/2 kHz 采样）不经此服务，技能在 `data` 角色自拉、`countHealth=false`、数值计算进 `worker_threads`。

### 7.3 `ctx.stmSafety`（`dsh-spm-stm-safety`）与 dsh 四钩子
```ts
interface SkillCallIntent { skill: SkillSpec; rawArgs; parsed; state: HardwareState; mode?: OperatingMode; autonomy: Autonomy; caller: {sessionId, agentId, preset, owner}; simulated; abortReason?; activeSample? }
type SafetyVerdict = {kind:'allow', notes} | {kind:'deny', key: DenyKey, reason} | {kind:'ask', reason, digest: ApprovalDigest}
// DenyKey: physically_absurd | envelope | precondition | safe_mode_tip_processing_blocked | semi_mode_shallow_only | instrument_busy | comms_circuit_open | aborted | tip_crash_blocked | no_active_sample | rig_not_allowed | not_instrument_agent | hard_gate
interface StmSafetyService { evaluate(intent): SafetyVerdict; effectiveBounds(spec): {lo?, hi?, strictPrefix}; mode()/setMode(m, by); autonomy(); lock: InstrumentLock; crashes: TipCrashTracker; abortLatch: {set(reason), clear(by), reason()} }
```
`evaluate` 固定顺序（`skill_adapter._run` ∪ `execution_context.run` ∪ `SafetyGateMiddleware`）：abort 闩 → rigGuard（`!simulated && !allowRealRig`）→ 熔断 OPEN 且写 → 非仪器 agent 调写工具 → sample 闸 → 物理荒谬 → 包络（spec ∩ 全局表 ∩ admin；allowed_values；必填）→ 前置条件（未知名 fail-closed；`z_controller_on` 违反附六态措辞）→ `modeRefusal` → 崩针网格 → 审批矩阵。

**决策矩阵（D8，按 ⑰）**：

| 触发 | attended | supervised | autonomous |
|---|---|---|---|
| AUTO / CONFIRM 技能 | allow（journal） | allow | allow |
| DANGEROUS（CreateZCtrlPreset、LockNanonisUI 等）与 SEMI 下电脉冲 | **allow + 通知**（诊断 `notice_only` + `approvals` 审计行 automated_policy） | 同左 | 同左 |
| 五个人级参数硬闸（开环粗进针/标定改动/粗动驱动改动/无护栏侧向粗动/保护禁用）在 `approvalSource='llm'` | **deny**（说清理由；人经 GUI/命令 `approvalSource='human'` 可执行） | deny | deny |
| conduct 步骤需要人点头（attended 档的 approve/ack、`WaitSpec.agent_ackable=false`、越权升级建议） | **ask**（dsh approval，reason=ApprovalDigest） | agent seat 批准 + 600 s 撤销窗（不经 dsh approval） | 包络内即批（编译期保证无 ask） |
| SAFE × `bias_pulse`/`tip_shaping`；SEMI × 深扎 >5 nm；包络/荒谬/前置/互斥/熔断/崩针 | deny | deny | deny |

**四钩子**：`ctx.tools.guard()` = 会话内永不释放的否决（rigGuard、非仪器 agent、PROHIBITED_IN_PROMPT 七工具、物理荒谬）；`tools/pre-execute` = abort 闩 deny（每次重评，可释放）、包络/前置/sample 的 deny（教学措辞）、矩阵里的 ask；`tools/execute` = 仪器令牌 hold（技能粒度、`rootCallId` 重入）、调制关闭 preflight、超时 = `estimatedDurationS×3` 封顶；`tools/post-execute` = 剥审计键、summary 规整、>2000 字符落盘 `$DSH_HOME/mast/tool-output/<callId>.json`、`last_scan` 经 `additionalContexts` 推给下游；`tools/result` = records（被拒也记）、回滚（abort/busy 不回滚）、写回状态缓存。**这些都与内核冗余**：子步永远不经 dsh 钩子。
**审批不带参数的补法**：`reason` = 确定性 `ApprovalDigest`（一行 ≤200 字：技能 · 关键参数带单位与包络 · 现态 Z/I/针尖服役天数/最近撞针 · 风险句按谓词从表取 · `args#sha256前6`）；执行时重算 hash 不等 ⇒ `approval_args_mismatch` 拒绝；客户端审批卡（§9.3）只做显示，**不自建第二条应答通道**。
**InstrumentLock**（`kernel/instrument-lock.ts`）：`hold(who{owner, skill, tags}, fn, {waitMs})`（等 5 s 抛 `InstrumentBusy` 含 holder）、可重入用 `AsyncLocalStorage<RunToken>`、`needsToken(meta)` 照抄豁免规则；owner = `${sessionId}:${agentId}:${preset}` ⇒ 第二个 session 的 IC 拿到 `instrument_busy` 而不是排队。

### 7.4 `ctx.stmRecords`（`dsh-spm-stm-records`）
两种后端按形状分：`ctx.storageDomain`（小而热、设置页会改、模型不可见）放针尖登记、仪器档案（前放增益索引→V/A、`bias_applied_to` 缺省 unknown、z 方向符号）、SafetyLimits admin 覆盖、OperatingMode、自主度、当前实验/样品指针、park 板、goals；自带 SQLite（`$DSH_HOME/mast/records.sqlite`，WAL，写串行；首选 `node:sqlite`，退路 `better-sqlite3`）放 ActionRecord（含 nanonis_calls）、扫描登记、环境历史桶、campaign journal、审批审计、tool-output 引用、崩针点、memory、artifact 账本、**RunLedger**（替代 MASTState 的 executed_skills/scan_paths/last_scan/error_log/composite_progress 引用）。**不用 session JSONL 当持久真源**。`export(range)` 出 JSONL 给旧仓工具读。

### 7.5 长时技能 → `ctx.jobs`
`JobKindMap` 声明合并 `'stm-scan'|'stm-composite'|'stm-conduct'|'stm-watch'|'stm-dream'`；`estimatedDurationS > 300` 或 `compositionLevel ≥ 4` 强制走 job，L3 可 `run_in_background`；`cancel()` = 置该 run 的 abort 信号 + `abort_stops_scan` 时补发 `Scan_Action(stop)`；完成以 user-role 消息回会话（text 与 render 同一段，图像用附件）。不跨重启的对策：进度落 journal（`readOutput()` 从它渲染）；`apply()` 时把 `running` 全改 `interrupted`；只有 `stm-conduct` 续跑；进程退出**不**替仪器做决定，重启后先 `refresh()` 对账。

### 7.6 知识 / 记忆
- 知识：`knowledge/<domain>/SKILL.md`（15 份 py dict 常量构建时转出；frontmatter name/description/when_to_use/tags/sample_types）作 `ctx.skills` bundled provider（rank 600）；工具 `query_knowledge(query, detail_level=conceptual|parameters|full)`（`(top_k, cap)` 表原样）、`get_skill_guidance`、`get_measurement_template`、`get_fault_diagnosis`、`nanonis_manual`（JSON 索引打包；模块速查只在 IC persona 尾巴给一次）、`stm_glossary`；三档（答「谁读它」）：档 0 只在 skills 列表可见；档 1 段 `stm-knowledge-hint` 按当前样品类型点名 1–2 份；档 2 `agent/session-start` inject 正文；读者就是 `context` 插件。
- 记忆：`records.sqlite` 的 `memory` 表 + 向量表（无 sqlite-vec 时 numpy 式暴力余弦；embedder DashScope v3 → FTS 回退，本地 transformers 层不搬）；段 `mast-memory`（索引头 12 行永远给 + knn 5 条 2400 字符，🌙 前缀，按 user 轮缓存）；工具 `memory_write/read/list/search`；写入四路（工具 / compaction sink ❓需压缩事件钩子，否则 `agent/pre-step` 侦测压缩标记 / PhaseManager 24 条阈值计数 / dream job 30 min idle 门控）。`MemoryBackend` 接口留给 dsh-memory-evolve 替换。

### 7.7 LLM 六家（`dsh-spm-llm-providers`）
DeepSeek 内置 `llm-deepseek`；Claude 与 MiniMax 走 `llm-pi-ai` anthropic 路由（MiniMax `baseURL: https://api.minimaxi.com/anthropic`；无 prompt caching 先接受）；**Kimi/Qwen/GLM 自写** `OpenAiCompatAdapter implements LlmAdapter`，由 `providerTraits` 表参数化（移植 `llm/provider_traits.py` + `model_thinking_mode()`：Kimi 温度锁 1.0、`reasoning_content` 多轮回传、Qwen `enable_thinking/thinking_budget`、GLM `thinking.type`、reasoning 模型 `max_tokens ≥ 16000`、上下文上限表）；`stream()` 里 usage 在 finish 前发出并写 `usage` 表；`resolveModel()` 声明 reasoning 档位；**全部走 tool calling，不用 structured output**；带工具调用不流式（tee 文本增量给语音 hub 是将来事）。

### 7.8 多 agent 与工具面（`dsh-spm-agent-presets`）
- 8 个 preset（`presets/<name>/agent.cordis.yml`；共用骨架 = 我们的 `persona / context / toolface / guards` 四个子插件行 + dsh `tool-ask-user`、`compaction-basic`、`tool-result-pruner`、`dsh-spm-memory/section`、`dsh-spm-knowledge/skills`；`isolate: [planMode, workflowEngine, compaction]`；模型行由 `mast.models` 设置覆盖）：

| preset | 角色/提示来源 | 工具面 | 模型/委托 | 特殊 |
|---|---|---|---|---|
| `instrument-control`（**default**） | `instrument_control/prompts.py` + Nanonis 模块索引一次性尾巴 | 全部 `stm_*`（核心包起始可见，其余桩）、`nanonis_manual`、buffer/forge/共享面 23、`handoff_to_supervisor|data_processing` | kimi-k3 / 0.2 / continuable | 唯一 instrument-capable；`inject:[stmSafety, instrument, instrumentState]` 缺一不装；deny bash/web |
| `data-processing` | `data_processing/prompts.py` | 37 域工具 + buffer + 共享面 + handoff；**代码执行三件首版不给**（D1；将来评估 dsh PTC） | / 0.1 / continuable | REQUIRES last_scan；vision-classic 经工具 |
| `experiment-design` | `experiment_design/prompts.py` | 3 + 27（生命周期/针尖只读/方案/知识）+ buffer + 共享面 + handoff | / 0.3 / one-shot | 也收 ExperimentPrefs/InstrumentProfile 段 |
| `literature` | `literature/prompts.py` + 死工具说明尾巴 | 6 + 15 + 取文回读 + handoff；**允许 dsh `tool-web`** | / 0.2 / one-shot、可后台 | 语料后置，工具是桩 |
| `paper-writing` / `paper-review` | 各自 prompts.py | 9 / 7 + buffer + 共享面 + handoff | / 0.3 / 0.1 / one-shot | PR 默认判决 ACCEPT；REQUIRES draft |
| `research-director` | `research_director/prompts.py` | campaign 7 + 共享面（无 buffer）+ handoff | / 0.3 / one-shot | 唯一无 SkillImage 段 |
| `mast-supervisor`（第 8 个，D6） | `orchestrator/graph.py:1112 _ROUTER_PROMPT`（去 JSON 输出段，改「用 `subagent` 派发」）+ `render_goal_block` + parked 行 + 上游产物全量 | `subagent`(+`send_message`)、`ask_user`、`conduct_status/list`、`memory_*`、`campaign_get`；**无 stm_*** | 2048 / 0.1 / reasoning 最低 | `maxDepth: 2`；护栏全挂它 |
| 附：`mast-qa`、`conduct-l2-seat` | 只读问答 / 只读诊断席 | 知识+记忆 / 只 READ+ANALYSIS（restrict + 内核 `not_instrument_agent` 双保险） | 廉价 | P3 / 由 conduct spawn |

- **主聊天 = 私聊 IC**：`agentPresets.default: instrument-control`；「私聊某 agent」= 用该 preset 新建 session，「群聊」= 用 `mast-supervisor` 新建 session；侧栏 `sidebar.workspaces` 加「STM」组；跨会话失忆：`agent/session-start` 只在「继续/接着/resume」意图命中时 inject 实验/样品/针尖/最近 6 个动作/活动计划块（`resume_context.py` 清单原样搬）。
- **编排 = `subagent` 工具（spawn-in-process）**；`fork-in-process` 只给 brainstorm 与 L1 llm seat；`agentTeams`/`workflowEngine` 不用（实验性/不需要模型写脚本）。**路由 = 工具调用**（supervisor 一步里最多 4 个并行 `subagent` 调用即 fan-out；`llm_route.py` 138 行只在 qa/降级复用）。产物流水线：账本 `artifact_channel(root_session_id, field, pointer, version, produced_by)`（8 个指针字段同 `artifact_types.py`）；写半边 = 产出工具直写账本（子会话需 `rootSessionId`：spawn 前言/agentOptions 传入，`agent/session-start` 读走）；读半边 = `context` 插件按 `CONSUMES[agent]` 渲染「上游产物」段；回父 = `tools/post-execute` 给 `subagent` 结果加宿主生成的 footer（产物 id 由代码抄不靠模型）；`handoff_to_<target>(reason)` = 终止工具（写 `routing_hint` + `concludeTurn`），supervisor `agent/pre-step` 读到 hint ⇒ 确定性派发；准入 `REQUIRES/PREFERS`（`readiness()` 三态，`missing_hard` deny）。
- **护栏 → dsh**：fan-out ≤4（同 step 第 5 个 `subagent` deny）；**IC 同时至多一个**三层（只有 IC preset 有写工具；宿主登记活着的 IC 子会话，第二个 `subagent(preset=instrument-control)` deny `instrument_agent_busy`；InstrumentLock owner 含 sessionId）；visit_count 60/10/30 + 软阈 48/7（`guards` 在 `agent/pre-step` 计数进投影 `mast.agents`，超硬阈 deny 一切 subagent + inject + cancel）；预算门（usage 表本 run 累计，≤0 ⇒ inject + cancel；日预算给唤醒）；插话 = composer `steer()`，`@agent` 硬路由；hold/release = `/hold` `/release` 命令（`cancel({keepInbox:true})`/`followup`，超时自动 release）；auto-background（默认关；开时前台 `subagent(preset=literature)` 且当前批含 IC ⇒ deny 并要求 `run_in_background:true` 重发）；activation park = 准入 deny 时记 `waiting{field}`，`artifact_saved` 唤醒；目标双门（Gate 1 `agent/pre-step` 求值 done ⇒ inject + cancel；Gate 2 `agent/turn-stopping` not_done 未问过 ⇒ `userQuestions.ask` 一次 ⇒ 答案变 hint ⇒ `followup`）。
- **工具面与 Kimi 名字绑定**：IC ≈280 工具 schema 354k 字符必须隐藏长尾，但 Kimi 只在绑定列表里选名字。方案：起始注册核心包（`CORE_NAMES` 由 golden 派生）**完整定义** + 其余工具**桩定义**（空 schema、短描述「在包 X，先 `load_tool_pack`」，execute 返回「已加载包，请重调」）；`load_tool_pack` 时把桩换成完整定义（注册是 `ctx.effect`，可换）；可见集**只增不减**。`restrict` 只用于 bash/web 这类与仪器无关的工具。Phase 0 spike 钉 dsh 对被 restrict 隐藏名字的行为与「重注册同名工具」的语义。

### 7.9 留给前端插件的宿主接缝（`dsh-spm-stm-ui` 宿主面）
- SSE hub `webServer.register({kind:'prefix', path:'/mast/events'})`（`text/event-stream`，`Last-Event-ID` = 旧 `?since=seq`，100 条环形重放、15 s `: ping`、队列满发 `dropped`）+ `/mast/events/snapshot`；事件闭集 `hardware_state`(1 Hz) / `comms` / `current_monitor` / `scan_progress` / `frame_saved`(指针) / `vision_event` / `alert` / `estop_latch` / `safety` / `experiment` / `conduct_status|gate|alert`(只触发) / `artifact_saved` / `skill_recommendation` / `wishlist_changed` / `narration`(指针)；**帧里永远只有指针与标量**；客户端未知 type 必须忽略。
- 投影 6 个：`mast.approvals`、`mast.runs`（每 10%/30 s 折一次）、`mast.narration`（自定义事件 `mast/narration`，logged 非 model-visible）、`mast.agents`、`mast.goal`、`mast.instrumentState`（模型看到的那一份）。
- 路由 `/mast/*`（JSON；`.png/.f32/.json/.md`）：`frames(:id.png|.f32|.json)`、`spectra`、`scan-map`、`coarse-map`、`vision`、`records`、`documents`、`experiments`（`current/activate/preflight/switch-advisory`）、`tips`、`approvals/:callId`、`tool-output/:callId`、`conducts`、`wishlist`、`memory`、`monitoring`、`env-history`、`skills|composites|builder|skill-overlay|skill-market|encyclopedia`、`literature`、`instrument-init`、`selfcheck`、`usage`、`quick-prompts`、`feedback`、`diagnostics`；**子系统未接线时返回 `degraded:true` 合法体永不 500**；**字面量段先于路径参数**。
- 命令：`/mode safe|semi|auto`、`/estop`、`/withdraw`、`/selfcheck`、`/experiment new|use|end`、`/sample new|use|clear`、`/tip register|remove`、`/hold <agent>`、`/release <agent>`、`/goal done-when <json>`、`/park list|cancel`、`/stall release`。
- 设置节 9 个：`mast.instrument`（host/四端口/hardware_modules/instrument_profile，`applies:'restart'`）、`mast.safety`（九对包络、SAFE/SEMI/AUTO、自主度上限、advanced_capabilities 解锁确认；覆盖走 `mast.overrides.*` 含溯源）、`mast.models`（每 preset 模型+thinking 档，key `role('secret')`）、`mast.scan`（scan_policy 档位/zctrl_presets/experiment_defaults/tip_conditioning_overrides）、`mast.monitoring`（live-read）、`mast.budget`（80/300/6，`0=零次` UI 不可达无限）、`mast.memory`、`mast.voice`(P3)、`mast.folders`。墓碑键不搬。

## 8. 逐 skill 迁移流水线

### 8.1 内核 `SkillKernel.run()`（唯一 choke point；与 `_run` 逐条对照）
K0 管理员覆盖 `effectiveSpec`（建工具与执行各调一次同函数）→ K1 SI 解析（失败 `refused/si_parse`，文案 `[Name] precondition_failed:` 逐字保留，聚合靠 `signature`）→ K2 abort 闩（`abort_latched`，`concludeTurn`）→ K3 sample 闸（depth 0 判，子步继承 admission）→ K4 progress 桥（sidecar 文件真源）→ K5 快照+计时（**在闸门之前**）→ K6 `validateParams`（越界附 `explainValidation` 教学文案）→ K7 荒谬 → 包络 → `operating_mode` → `hard_gate`（五条，`approvalSource!=='human'` 拒）→ DANGEROUS = 执行 + `autoApproval.notify` → K8 前置条件（不满足先 `refreshState()` 再判——**两入口都做**，登记 deviations；抛 ⇒ `precondition_crashed` fail-closed）→ K9 `holdForSkill`（重入键 `rootCallId`；超时 `busy` 不回滚）→ K10 调制关闭 preflight（depth 0）→ K11 `skill.execute(ctx, params)`（`ctx.signal` = dsh `exec.signal` ∪ 急停 ∪ 环境告警 ∪ 会话停止）→ K12 `applyPatch(data)`（成功）/ `_verified_state`（总是）/ `ctx.markers.emit`（成败都记）→ K13 `composeText`（summary/None ⇒ str(data)、失败附全 data 去审计键、成功只附 detail、>2000 落盘 `textRef`）→ K14 图像 `attachments.save` → `imageRefs`（depth 0）→ K15 `stateDelta` 写 RunLedger → K16 records（被拒也记；`approval_source`；`auto_approved`）→ K17 post_hook（成功才跑，永不抛）→ K18 异常（`AbortRequested`/`InstrumentBusy` 不回滚；其它 `rollback()` → `rolled_back`）。
类型：`SkillSpec`（复刻 SkillMetadata，`capabilities` 含 `produces_file`）、`Skill{spec, execute, rollback?, validateParams?}`、`SkillContext{signal, abortReason(), checkAbort(), call/callUrgent(typed), run(sub), state()/refreshState(), sleep(ms)→'elapsed'|'aborted', narrate, markers(必填), progress, ask?, depth, owner, rootCallId, approvalSource, scopeAdmitted}`、`SkillOutcome extends SkillResult {kind: ok|failed|refused|aborted|busy|rolled_back; code?: RefusalCode; signature; text; textRef?; imageRefs?; stateDelta; concludeTurn?}`。`ctx.markers` 缺席构造期就拒绝（换区不翻代那次事故）。

### 8.2 schema 生成 → dsh `parameters`（复刻 `_schema_from_metadata`）
`allowed_values` 全为 str/int/bool ⇒ enum；`float && unit` ⇒ **`{type:'string'}`** + description = 原描述 + `(unit)` + `范围 lo … hi`（strict 用 `formatSi`，宽松 `%g`）+ strict/宽松固定文案（逐字从 golden 取）；`strict = needsStrictPrefix(effectiveBounds(spec)) || unit ∈ {m, A}`，`siParams(spec)` 是唯一算 strict 的函数（parameters 与 K1 共用）；其它数值范围写进 description（dsh 是否透传 `minimum/maximum` Phase 0 核实）；`required` 直映射；可选参数不填默认进 schema；没有 `tool_call_id`（用 `exec.callId`）。

### 8.3 `defineSkillTool()` 与长时/人节点
`defineTool({name: spec.name, description（不追加手册提示）, parameters, timeoutMs: timeoutFor(spec)（L0 30 s；带等待预算 = 预算+60 s；-1 ⇒ 走 job）, isConcurrencySafe: () => !needsToken(spec), execute: kernel.run(…depth 0, approvalSource:'llm') → stallGuard.observe → concludeTurn?, output:{schema: SkillOutcomeSchema, render: renderOutcome(纯)}, presentCall/presentResult(纯)})`。`renderOutcome` = `{type:'text', text}` + `imageRefs` 的 `{type:'image'}`。`INVALID_ARGS` 由 dsh 回模型 ⇒ `presentResult` 分支渲染成与 `explainValidation` 同口径中文。**human 节点**：`ctx.ask = q => userQuestions.ask({questions:[{id: decisionKey, question, detail: JSON(inputs), options: routes}]})`，决策缓存写 sidecar `_human[decisionKey]`（续跑不再打扰）；无 `ask` 通道 ⇒ 明确失败；`ask_user` 工具 = `userQuestions.ask` 薄包装（schema 逐字照搬 `ask_tools.py:84`：`question/header≤24/options≤8/multi_select/allow_custom/timeout_action`；`timeout_action` 自带计时：continue ⇒「操作员未答，按你的判断继续」，halt ⇒ `concludeTurn`）。abort → 停扫：`exec.signal` 触发时 `WaitScanComplete` 发 `Scan_Action(1,0)` 再返回 aborted；dsh 超时也触发 signal，绝不把仪器留在运动中。

### 8.4 批次（依赖与完成判据；**成员从 golden 的 category+目录+safety_level 派生，不读 `composition_level`**——374/498 吃默认值 0，照它分会把四分之三全归 L0）
0. **基础设施**：全部包骨架；`nanonis-wire` 生成器 + 对 SpecEchoServer 跑全部 671 动词的往返测试；kernel 全部闸门 + 状态缓存 + SI/preconditions 移植 + golden；RunLedger；`sim-harness`（spawn stmsim；`--trace`/truth 端点是对 STM-Bench 的 ~60 行小改，退路是 Python 侧驱动）；`defineSkillTool` + 一个假技能 `_Probe`（一个 `m` 参数、一个 enum、一个前置）走完 K0–K18 的 dsh recorded-session 测试；导出脚本第一版 golden 入仓；变异框架对 K1/K2/K6/K8/K9 各红一次；**前两天 dsh API spike**（§15）。
1. **只读 L0（≈38，全落 stmsim 已实现动词）**：GetBias/GetCurrent/GetBiasCalibration/GetSetpoint/GetZPosition/GetZControllerState/GetZCtrlGain/GetZCtrlList/GetTipLift/GetZLimitsEnabled/GetHomeProps/GetWithdrawRate/GetScanFrame/GetScanStatus/GetScanSpeed/GetScanBuffer/GetScanXYPosition/GetXYPosition/GetTipSpeed/GetPointShootOnOff/GetPiezoTilt/GetDriftCompensation/GetPiezoSensitivity/GetPiezoXYZLimits/GetMotorFreqAmp/MotorGetPos/GetMotorStepCounter/GetAutoApproachStatus/GetSafeTipStatus/GetSafeTipProps/GetSafeTipSignal/GetSignalValues/ListSignalChannels/GetSignalRange/GetSessionPath/GetAcqPeriod/GetRTFreq/GetLatestScanFile。判据：DoD 全过；状态缓存 `refresh()` 与 Python `HardwareState` 非时变字段 golden 相等；读免锁免样品闸有测试。
2. **写 L0 + 补救 + 硬闸（≈36）**：SetBias/SetSetpoint/ZControllerOnOff/TryEngageController/WithdrawTip/SafeRetract/EmergencyRetract/StopScan/StopAutoApproach/StopMotor/StopFolMe/SetZCtrlGain/SetTipLift/SetZPosition/SetBiasRange/SetSessionPath/SetScanBuffer/SetTipSpeed/SetFolMeOversampling/MoveToXY/SetPiezoTilt/SetDriftCompensation/SetPiezoRange/SetHomeProps/SetSwitchOffDelay/SetCurrentGain；硬闸七件套 MotorMove/MotorMoveClosedLoop/EnableSafeTip/SetZLimitsEnabled/SetBiasCalibration/SetCurrentCalibration/SetMotorFreqAmp；DANGEROUS LockNanonisUI/CreateZCtrlPreset；L1 试点 AutoApproach/ApproachTip。判据：中止 e2e（SetBias 斜坡中途置 abort ⇒ 停中间值、不回滚、`abort_reason` 透传、其后写动词被拒而 `ZCtrl_Withdraw`/`Scan_Action(1,…)` 放行）；锁争用 e2e（两 owner 同时 SetBias ⇒ 一个 `busy` 5 s 内不排队）；七硬闸在 `llm` 来源一律拒且变异变红；DANGEROUS 走执行+通知；`ZControllerOnOff(true)` 后立刻 `MoveToXY` 过前置（钉 2026-08-10 反例）；蜜罐 `setpoint_a=1.5` 被荒谬拒并给「写 '100p'」措辞。
3. **扫描族 L1 + 帧数据（≈45）**：ConfigureScan/SetScanSpeed/StartScan/WaitScanComplete（流式 poll，起扫宽限 5 s、按行数延长、五种 outcome）/SaveScan（session path 下 120 s 内最新 .sxm）/GrabScanFrameData（`.npy` 2-D）/LoadScanFrameFromFile/CheckScanForCrash/ComputeDriftVector/ParseRegions/SetBiasRamp/WatchScanLines/ScanBackgroundPaste/Delete/marks 3/datalog 6/lockin 14/signals 其余/misc_setters 8/util 其余。依赖 `nanonis-files`、`numerics/npy+fft`。判据：复现 STM-Bench `test_scan_pipeline_start_wait_save_grab_crashcheck`；.sxm 读取 parity（真机文件帧 SHA-256 与 nm/px 相等）；五种 outcome 各有 stmsim 故障注入用例。
2b/3b. **L0 长尾（≈250，可并行、骨架可生成）**：spectroscopy 38、pll 36、optional_* 58、user_output 14、nanonis_script 14、sweep 11、pattern 7、function_generator 6、instrument_limits 6、readback 7、spectroscopy_sync 6、atom_track 4、bias_sweep 4、spectrum_analyzer 3、osci 3、optics 11、chamber/temperature/hardware_events。`gen-skill-skeleton.ts` 从 golden（spec + `verbs_used`）生成 spec 与 execute 桩；stmsim 没有的模块只对 SpecEchoServer 做 e2e，卡片标「未在物理模拟器验证」。
4. **L2 分析（builtins 23 + paper 25）**：FindFlatRegion/MeasureStepHeight/AnalyzeFrameTilt/AnalyzeScanImage(先非视觉分支)/AssessClusterRoundness/ClusterExtract/Select/DomainAssess/HerringboneAssess/FrameCorrugation/FrameTrust/BestFrame/AssessSpectrum/MapBarrierHeight/MonitorCurrentFFT/DetectAtomicLattice(3)/AtomicLines/AtomicPhase/Multiframe/TiltProbeCircle/CalibrateCoarseStep/ReconcileSafetyEnvelope/ScanIntelSelfCheck；paper 分析类 CheckLineQuality/LevelLines_Median/SubtractPlane_RANSAC/SubtractPoly2D/Destripe_MorphOpen/CorrectDrift_XCorr|BraggPeak/DiffScans/FindEmptySpot/FitFano_Kondo/FitGap_BCS/DetectAtomJump/UnmixSpectra/DeconvolveTip_RL；深度模型类等 `vision-onnx` 就绪。判据：数值 golden（每技能 `golden/analysis/<Name>/cases.json`，容差写明）；分箱/阈值按分辨率派生；KNOWN_ISSUES 里的缺陷判据不照抄（登记 deviations）。
5. **L3 composite（≈25）**：FullScan/ScanAt/PreScanCheck/TipPulse/ConditionTip(+Poke/Pulse)/ShapeTipOnSurface/GridSTS/SpectroscopyAtPositions/AutoTilt/TiltCalibrate/TrackDrift/BatchRegionsScan/RelocateCoarseXY/SurveySurface/VerifyAtomicResolution/ScanUntilAtomicResolution/DemoScanAndSTS/SearchDomainBoundary/MakeAtomicResolutionTip/MakeSpectroscopyTip/RetractForSampleChange/AssessImageQuality/BiasSettleChange/ScanPublicationFrame/AcquireSTS/BiasPulseWithReadback/TipShapeWithReadback。依赖 `GraphExecutor` 移植（async generator plan、sidecar、`step_skip` 台账、abort/halt 双检、旁白模板、`_validate_products`、`abort_facts`）、TipCrashTracker、scan_policy、tip registry/instrument profile、human 通道、jobs；**批 5 前先用批 3 的 WaitScanComplete/SetBiasRamp 验过 GraphExecutor**。判据：复现 `test_e2e_composites`；断点续跑 e2e（杀进程再调同名 composite ⇒ 跳过已完成步并记 `step_skip`，跑完 sidecar 清除）；`FullScan` `wait_stopped_early` ⇒ 失败且不做撞针检查；`TipPulse` 在 SAFE 下被拒且**子步路径也拒**。
6. **L4/L5 闭环 + paper composite（≈18）**：ForgeAuTip/PrepareNobleTip(3)/AchieveAtomicResolution/AcquireBiasImagingSeries/AtomicBiasSeries/AcquireAngleSeriesForCalibration/ExecuteScanPlan/LineSTSAcrossWall/STSConditionSeries/StepCoarseXY；paper AdaptiveSTS_GP/OptimizeResolution_BO/FindGoodRegion/ContinuousImaging_Auto/AutonomousSurvey_Scanbot/ConditionTip_DQN/AtomManip_SAC/AutoOSS_Dehalogenation。判据：ForgeAuTip 在 sharp/blunt 两种 stmsim 世界分别成功/干净失败；`time_budget_h` 用墙钟；`ctx.markers` 必填。
7. **声明式 composite / 技能工坊 / 装载面**：SpecComposite（12 节点、`jsep` 白名单求值、继承安全级 = max）、version_store CAS、templates、loader、`skill_catalog/draft_composite/save_composite/run_composite`、overlay/市场订阅、hardware_modules 与高级能力门、tool packs 桩换注册 + `search_tools`/`load_tool_pack`（中文同义词表照搬）。判据：全部 templates 跑通 stmsim；`safe_eval` golden；「声明 auto 含 CONFIRM 子步 ⇒ 提级」有测试。
8. **其余 agent 工具族**（DP/XD/LIT/PW/PR/RD）与 §7.8 预设一起做（Phase 6）。

### 8.5 一个技能「完成」（DoD）
① spec parity：`spec/golden/skills.json` 条目与 `skill.spec` 规范化 deep-equal（分母来自 golden，输出 `spec/progress.json`）；② 模型面 parity：`golden/tool_schemas.json`（Python `_schema_from_metadata` + `si_params` + `effective_bounds`）与 `parametersFromSpec` 比：类型/required/**description 逐字相等**；③ 单测（FakeCtx 脚本化应答按真机形状）：成功 1 条 + Python 每个 `success=False` 分支各 1 条（导出脚本 AST 抽 `error_branches`）+ 凡 `is None` 区分处必有 `undefined` 与 `0` 两条；④ stmsim 端到端（`--approached --seed N --time-scale 10`，断言 outcome.ok + truth 端点物理量 + call_log 无 `err:/crash:`；动词不在 sim 的改 SpecEchoServer）；⑤ 差分（§12）；⑥ 闸门变异（该技能声明的前置/量纲参数/硬闸名必须出现在对应闸的变异集合，从 golden 派生）；⑦ 技能卡片自动生成；⑧ `progress.json status: done` 仅当①–⑦全绿；模块级完成 = 该 .py 全部名字 done。

### 8.6 规格导出（`tools/spec-export/export_mast_spec.py`，Python 3.13，旧 venv，只读旧仓，`MAST2_PROJECT_ROOT` 指向临时目录隔离）
输出 `spec/golden/`（JSON，键排序）：`skills.json`（`SkillRegistry.discover()` + `_get_metadata_raw`；含 module/base/`verbs`(AST 抽 safe_call 字面量)/`error_branches`）、`tool_schemas.json`、`preconditions.json`（词表 + 措辞 + HardwareState 夹具网格用例表）、`safety.json`（`SafetyLimits().model_dump()`、`_GLOBAL_CHECKS`、`_PHYSICAL_ABSURD`、`_ENVELOPE_FIELDS`、`_STRICT_BY_DIMENSION`、`_ABORT_SAFE_WRITES`、`_is_read` 对 671 动词判定表、五硬闸用例表、`mode_refusal` 用例表、`BYPASS_*`、sample gate 四表、`_AUDIT_ONLY_KEYS`、`_TOOL_RETURN_CAP`）、`si_cases.json`、`tool_packs.json`（PACKS/CORE_NAMES/DEFERRED_NAMES/PROHIBITED_IN_PROMPT/CORE_PREFIXES/SYNONYMS + `classify()` 结果）、`hardware_modules.json`、`state.json`（refresh 动词、apply_patch 字段）、`scan_policy.json`、`abort_policy.json`、`prompts/<id>.md`+`index.json`（含 narration 模板与 `_explain_validation`/abort/sample gate 固定文案）、`records_schema.sql`、`traces/`（差分录制）。每个 collector 独立 try/except 并在 `manifest.json` 记成败（一个坏了不能静默缺一块）。

### 8.7 数值基础件（`dsh-spm-numerics`，自写为主、纯 JS/TS、无 wasm/原生）
`Mat{rows, cols, data: Float64Array}`；FFT `fft.js` 1-D + 自写 2-D/互相关/`phase_cross_correlation`（峰位约定用 golden 钉）；线代 `ml-matrix`；`curve_fit` → `ml-levenberg-marquardt`；平面/多项式/RANSAC 拟合自写；滤波（可分离高斯、拉普拉斯、灰度形态学、双线性/双三次插值，边界模式对齐 scipy）；连通域 union-find；SSIM `ssim.js`；统计自写（percentile 用 numpy linear）；KMeans/PCA `ml-*`，GMM/NMF/ICA 后置；GP/BO 自写（批 6）；xoshiro128** 可种子 RNG；`.npy` v1/v2 读写；`.sxm/.dat/.3ds` 自写（GBK 用 Node full-ICU `TextDecoder('gbk')`，退路 iconv-lite）；SI `si.ts` 逐字移植；出图自写光栅 + `pngjs`（带坐标轴文字后置 `@napi-rs/canvas`）；深度视觉 `onnxruntime-node`（一次性用旧 venv `torch.onnx.export` 出 `.onnx` + manifest；parity max-abs ≤1e-4；骨干无条件离线）。

## 9. STM 前端插件（`dsh-spm-stm-ui` + 五个 client 包）

### 9.1 落点
五种「地方」：整页 tab = `conversation.view`；右列 = `details`（`ctx.layout`）；会话内 = `tool.call.toolview` / `ConversationNodeDefinition` / `fence-registry` / `conversation.composer` / `presentCall|presentResult`；设置 = `settings.plugin.item`；壳层 = `shell.overlay` / `sidebar.workspaces` / `sidebar.settings`。
逐页（P1 = Phase 2–3 私聊 IC on stmsim 可用里程碑要用）：Chat → dsh 原生 conversation（default preset IC；**删** ChatBubbles/sse.ts/transcriptRefresh）；旁白 NarrationLane → 自定义节点 `mast/narration` + 右栏「进行中」卡；Vision/Data/Model strip → 右栏三卡；QuickPrompts/作用域 chip/反馈 → composer chain；PendingInterrupts → §9.3（P1）；Agents 页 → 群聊 = `mast-supervisor` session、拓扑+产物流 = `conversation.view`「智能体」（**搬** TopologyGraph/ArtifactFlowGraph SVG、registry.tsx；**删** runTaskStore 828 行）；QaPage → `mast-qa` preset（P3）；SkillsPage → view「技能」7 子 tab（**改**；CompositeDag xyflow **搬**）；BuilderPage → view「技能构建器」（P3，**搬** builder/*）；LiteraturePage → view（P3）；RecordsPage → 拆「**数据**」（P1：.sxm 浏览/去衬底/STS/网格/翻页/副本折叠；**搬** scanKinds/scanPager/scanCopies/scanAttribution、SpectrumChart+spectrumSeries、ScanGridCard、ScanDataPane）与「实验记录」（P2）；ConductPage → view「Conduct」（P3；**搬** lib/conduct.ts 685 行、conductForm.ts 646 行「超包络拒绝不夹紧」）；CognitionPage → view「记忆」；WishlistPage → view + 侧栏角标（**搬**）；SettingsPage 2088 行 → 9 张设置卡（外观/远程访问 → 删，dsh 自带；**搬** ModelCapabilityTable/NanonisPortsReadOnly/settingsWrite.ts/knobs.ts）；SetupPage → view「仪器初始化」+ `shell.overlay` 横幅（P2）；AdminPage → 设置卡 `mast.overrides.*` + view「高级管理」（PIN → 卡上解锁确认 + `applies:'restart'`；**删** PromptInspector/PinGate）；UsagePage → view（若 dsh 自带用量面板则不做）；MonitoringPage → view「电流监控」（SSE `current_monitor` 标量 + 节流拉 trace；**搬** LiveCurrentChart/AuxChannels/SegmentCurveThumb/curvePath/seriesGaps/monitoring.ts/pollRates.ts）；EnvHistoryPage → view（刻意只轮询；**搬**）；ExperimentalPage → view「仪器工具」（**搬** SignalCapturePanel 967 行/FftChart/TimeTraceChart/MosaicPanel）；OpticsPage → 非目标；DashboardPage+TopBar → 右栏顶卡「仪器状态」（读数 + sparkline + 熔断/看门狗灯）+ `shell.overlay` 急停按钮与闩横幅（**P1**）；VisionPage → view「扫描地图」（Konva；**搬** ScanMapCanvas 923 行、scanMapView.ts 610 行纯函数、CoarseMapPanel、VisionBufferPanel、PulseRibbon）；顶栏导航/router/TabGroup/useStickyTab → 删（`order` 即顺序）。奇偶表 `docs/ui-parity.md` 由脚本从旧 `nav.ts TABS` 派生。

### 9.2 实时（D7）
全局高频易失 → SSE `/mast/events`（§7.9；`EventSource` 自带重连 + `Last-Event-ID`，不依赖 WS upgrade）；客户端 `dsh-spm-ui-core` 注册服务 `mastEvents`（`defineStore`：最近状态 + 环形历史 + 连接态 `live|reconnecting|polling`；断线 >45 s 降级轮询 `/mast/events/snapshot`；`lib/ws.ts` 的 backoff/full-jitter/shouldPoll 纯函数与 413 行单测**原样搬**）。按会话低频要回放 → 投影六个。告警三条路同时走：SSE → `shell.overlay` 横幅+声音；宿主置 abort 闩；`agent/pre-step` 注入未投递告警块并标 `delivered_agent`（探测与送达分开记账）。

### 9.3 审批 / 提问 UI
一条应答通道两层显示：① `reason` = `ApprovalDigest`（无客户端包时这一行就是全部信息，必须自足）；② `tool.call.toolview` 按工具名 keyed 的审批卡（待批状态由 props 或投影 `mast.approvals` 匹配判定），`fetch('/mast/approvals/:callId')` 取 `{parsed, envelope, state, tip, risk, digest, argsHash, expiresAt}` 渲染参数表（越界标红）/包络/针尖卡/风险/倒计时；「允许一次/拒绝」仍是 dsh 的。**edit 语义**：卡上「拒绝并建议新参数」= dsh 拒绝 + `steer()` 一句「操作员拒绝了 X，改为 Y 重试」⇒ 新 hash 新审批。超时由 dsh 管，我们只把 `expiresAt` 写投影。`ask_user` 用 dsh 内置提问卡（确认是否显示 option description，否则折进 label）。操作员不在会话页时：右栏「待处理 N」卡 + toast，数据 = 活动会话投影 ∪ `/mast/approvals?all=1`；`lib/interruptPanel.ts` 的两布尔（render/showCards 分开、degraded 零条也出面板）**搬**。

### 9.4 STM 图像
宿主 PNG（`GET /mast/frames/:id.png?channel&dir&flatten=raw|plane|line|auto&cmap&size&clip`，缓存 `$DSH_HOME/mast/cache/frames/`；`auto` 去衬底异步 202；网格只允许 raw/plane/line）给缩略图网格/地图贴图/拼图/证据图/会话帧卡/附件；客户端 Float32（`GET /mast/frames/:id.f32` 头 JSON + 小端 Float32；活帧加 SSE `scan_progress` 增量重取）给单帧检查器（剖面/对比度/色标零往返）与扫描中活帧。**一份数值代码两面用**：`dsh-spm-numerics` 同构，去衬底/裁剪/LUT 同一实现打进客户端 bundle，numpy 金样两面同跑；色标 256×3 LUT 共用；会话内技能结果 `imageRefs` → 附件 + 自定义节点 `stm-frame`（元数据 + 「在数据页打开」）；分箱/采样点数按 nx 派生。

### 9.5 包结构与约定
`stm-ui`（宿主面）+ `ui-core`（immediately；inject `slots/locale/connection/settingsScope/clientModules`）+ `ui-chat`（inject `slots/locale/sessions/uiRenderer/mastEvents/mastApi`）+ `ui-data`/`ui-ops`/`ui-skills`（懒加载）。基线外部依赖不重复声明；react-query/uPlot/Konva/xyflow 打进各自 bundle；样式：搬来的旧组件用 Tailwind `prefix:'mast-'` + `important:'.mast-root'` 作用域 CSS（codemod 机械加前缀），token 映射宿主 CSS 变量，新组件用 `ui-primitives`；locale 每包 `zh-CN.ts`（主）+ `en.ts`；不变式 lint：client 包禁 import 宿主包与 `@deepseek-ai/*`（只经 `dsh-spm-compat/client`），组件不 import ctx，`ui-data/ops/skills` 互不 import。

### 9.6 迁移步（与 Phase 对齐；旧前端照常随旧仓发版）
U0（Phase 0–1）SSE hub + `/mast/selfcheck` + 右栏「仪器状态」卡 + 急停按钮/闩横幅 + `mastEvents/mastApi`（验收：stmsim 读数 1 Hz 更新；`/estop` 1 s 内横幅亮；杀宿主重启 5 s 内重连且 `Last-Event-ID` 续传无缺口）→ U1（2–3）设置卡 instrument/safety/models + `stm_*` toolview + 审批卡 + `ask_user` 包装 + `stm-frame` 节点 + `/mast/frames/:id.png` + `/mast/approvals/:callId`（验收：kimi-k3 on stmsim 十轮对话帧内联可见；审批卡 `argsHash` = 内核执行 hash；投影回放重建的卡片与 live 一致）→ U2（4）数据页/扫描地图/视觉缓冲/活帧（验收：同组真机 .sxm 新旧 UI 缩略图像素相等；纯函数测试原样全绿；活帧刷新 ≤1 s）→ U3（5–6）实验记录/心愿单/智能体拓扑/电流监控/环境历史/初始化/记忆/用量/作用域 chip（验收：记录页与 records 导出对得上；`visitCount` 回放一致）→ U4（7）Conduct 视图（验收：中途 kill 重启后面板从 `GET /mast/conducts/:id` 完整重建）→ U5（6+）技能目录/构建器/市场/文献库；语音 dock 可选（§14）。

## 10. 中间件与子系统归宿

| 旧中间件 | dsh 落点 | 处置 |
|---|---|---|
| safety_mw | stm-safety guard + pre-execute + 内核 K7 | 保留 |
| auto_approval_mw | 内核 `autoApproval.notify` → `notice_only` + `approvals` 审计行 | 保留 |
| buffer_hitl（已只记录） | §9.2 告警三条路 | 改形 |
| stall_guard_mw | 宿主 StallGuard 按 `outcome.signature` 聚合 + `concludeTurn`；`/stall release` | 保留 |
| memory_mw / request_readback_mw / upstream_mw / live_state_mw / alert_delivery_mw / mode_mw / tip_context_mw / instrument_profile_mw / experiment_prefs | `context` 插件一个 `renderSections(agent, req)`（复刻 `inject.py` 单一注入门：稳定块 section、易变块挂最后一条 human；每段 `promptId`，归属进投影 `mast.session`）；定向真源 = 每块 `AGENTS` 常量；顺序 Upstream → ExperimentPrefs → InstrumentProfile → LiveState → ModeBelief → AlertDelivery；memory/readback 按 user 轮缓存；告警在模型调用成功后才标 delivered | 保留（合并成 1 个插件） |
| tool_refine_mw（Layer 3） | dsh `tool-result-pruner` + `compaction-basic`；数值精炼需求由 `textRef` 落盘覆盖 | 内置替代 |
| vision_mw | 内核 K14 → dsh 附件 | 内置替代 |
| tool_visibility_mw | 桩换注册（§7.8）+ `search_tools`/`load_tool_pack`；目录不是门禁 | 保留 |
| message_clock_mw | session log 每事件自带时间戳 | 删除 |
| prefill_guard_mw | `llm-providers` 适配器职责 | 删除（内置） |
| compaction_mw | `compaction-basic`（阈值来自 `model_input_context` 表）+ 摘要写记忆（❓钩子） | 内置替代 + 小扩展 |
| tool_pair_guard_mw | LangGraph 特有短路不存在 | 删除 |
| call_limits | `guards` 插件 `agent/pre-step` 计数（run 每 followup 重置；thread 累计可关） | 保留（计数器） |
| AnthropicPromptCaching | dsh 无 prompt caching；纪律（稳定块 system/易变块 human）仍保留 | 删除（接受） |
| recorder_mw | `agent/request` + llm 流监听写 usage/turn_trace | 保留（监听器） |
| HITL（hitl_bridge/hitl_map） | dsh approval + userQuestions；`derive_hitl_map` 改为 `stm_selfcheck` 输出 DANGEROUS 名单 | 内置替代 |

目标：`ctx.goals` 持文本目标；`done_when` 谓词树 + 基线快照放 `storageDomain('mast.goals')`（campaign 的放 `campaigns.goal_json`）；求值核 `kernel/rules.ts` = `conduct/rules.py` 逐行移植，goals 与 conduct 闸门共用（结构测试：patch 掉核 ⇒ 全部 unknown）；触发 = supervisor `agent/pre-step` 每跳 / 唤醒 tick 2.5 步 / `campaign_get`；`goal-round-driver` 续跑必须过我们的判决；投影 `mast.goal` → 右栏「目标」卡 + 节点 `mast-goal`。
唤醒（默认关）：宿主 job `stm-watch` 1 s tick；park 板 `storageDomain('mast.parks')`（闭集 `waiting|woken|done|done_by_goal|expired|cancelled`，`woken` 非终态，`experiment_id` 冻结，TTL 24 h，MAX 500）；四道防护一条不少（6/日/实验，`0`=零次、负数无限且 UI 不可达；日预算 300 USD 跨 session；同 park 冷却 30 min；目标闸在花钱之前）；唤醒 = `ctx.agents.resume(rootSessionId)` + `followup(到货块)`；`ctx.schedule` 只用于单次到点提醒。
conduct：`ctx.conduct`；Director = 宿主 job `stm-conduct` 确定性 tick；三表 + `record()` 唯一改动门 + `active_slot UNIQUE` + 异常态必带 reason；步骤经内核（owner `conduct:<id>`）；闸门三态，判不了 ⇒ attended 等人 / unattended `unattended_escape`，都不许映射 pass；自主度 = min(全局, spec.max_autonomy)，认不出按最严；supervised 点火延迟 600 s、`ignite_at` 绝对时刻；`autonomous` **编译期拒绝任何会落到 ask 的步骤**；L1 seat = `fork-in-process` one-shot，L2 = `subagent(preset=conduct-l2-seat)` 每阶段每证据代次一次，处置只在 `allowed_escalations` 闭集；6 个 `conduct_*` 工具；等人 = 心愿单 ack AND 物理条件；只有 conduct 跨重启续跑（从最后已通过闸门）。

## 11. 分阶段与里程碑（**真机 0 次**直到 Phase 8；`mast-rig` profile 之前不入仓）

| Phase | 内容 | 完成判据（可机器验证） |
|---|---|---|
| **0 脚手架（~1 周）** | ✅0.1 环境与 Windows 冒烟（09-02）；仓库/workspace/compat（整套 `@deepseek-ai/*` 精确钉当前最新 alpha）/kernel 类型骨架/`stm_hello` 工具/总 bundle/`mast-offline` profile/CI 双平台/占位包名；**dsh spike**（facts.md §7）写 `docs/dsh/spike.md` | `dsh plugin --profile web add ./packages/bundle/dsh-spm` 成功；会话里 `stm_hello` 返回版本；contract 测试绿；覆盖率门禁生效；spike 十条各有结论；`check-dsh-pin` / `check-dsh-latest` 生效 |
| **1 仪器接缝** | nanonis-wire codec + 生成 + TCP 客户端；instrument 服务；stmsim/fake provider；instrument-state 1 Hz + 投影 + 段；看门狗 + estop；U0 | 535 方法字节金样相等；三类故障行为与 Python 基线一致；`closeAll` 后 stmsim 端口可复用；看门狗在「Z 顶限撞针」场景 4 s 内退针；覆盖率 100% |
| **2 安全 + 内核 + 批 1/2** | kernel/safety 断言表移植；四钩子 + guard + digest + `/mode /estop`；skill-runtime；golden 导出；L0 只读 38 + 写 36 | §8.4 批 1/2 判据；蜜罐/SAFE 拒/互斥/hash 不等被拒；差分序列一致 |
| **3 可用里程碑：私聊 IC on stmsim** | llm-providers；`instrument-control` preset；live-state 段（已验证进日志）；records 基础；stm-ui 宿主接缝冻结 v1；U1；批 3 扫描族 | kimi-k3 在 stmsim 上「设偏压→开反馈→扫一帧→读状态」十轮对话，session log 可 replay 重建每次请求；帧内联可见；`stm_selfcheck` 全绿 |
| **4 分析与视觉 + 数据页** | 批 4 L2；numerics + vision-classic；U2；批 2b/3b 并行 | numpy 金样逐检测器一致（容差写明）；新旧 UI 缩略图像素相等 |
| **5 硬件闭环** | 批 5 L3 + jobs + human 节点 + GraphExecutor；tip registry/hardware profile/env history；知识 SKILL.md ×15 + 工具；记忆；U3 | `test_e2e_composites` 复现；断点续跑；换针后 SAFE 包络按登记 capability 生效；知识三档 contract；后台 job cancel 1 s 内停扫 |
| **6 L4 闭环 + 七 agent** | 批 6；批 8（其余 agent 工具族）；8 个 preset + subagent 编排 + 账本 + 护栏；literature 包；U5 部分 | ForgeAuTip sharp/blunt；supervisor 委托 IC 扫图交 DP 分析的端到端 replay 可重建；两个 IC 分支并发被结构拒绝；STM-Bench B0/B1 场景在 dsh 栈跑完 |
| **7 conduct + 声明式** | 批 7；conduct/goals/唤醒/自主度/撤销窗/journal；U4 | 中途 kill 重启后 campaign 从最后确认步续跑；`autonomous` 编译期无 ask；attended 无人应答时 deny 不挂起；SpecComposite 全模板跑通 |
| **8 视觉深模型 + 基准 + 真机准备** | vision-onnx（v2.5 DINOv3 导出）；TS 版 stmbench harness；`mast-rig` profile 首次入仓；真机接触清单 | ONNX 与 torch 逐样本 ≤1e-4；Track B 九族全跑；真机首次接触条件：差分套件对将用技能全绿 + rig selfcheck 全绿 + 操作员在场 + SAFE + 先只跑 READ 技能一整个 session；旧系统并行运行，切换由操作员决定 |

## 12. 验证

- **单测**（vitest `unit`）：kernel 用旧 pytest 断言表原样移植（`test_safety*`、`test_comms_health`、`test_instrument_lock*`、`test_state*`、`test_si_quantity`），熔断/锁/看门狗注入时钟；技能用 fake transport 断言**发出的命令序列**。
- **线协议金样**：旧 venv 里 patched `nanonis_spm` 对 stmsim 录 535 方法的 `(request_bytes, reply_bytes, decoded)`，TS codec 字节相等编码、值相等解码。
- **集成**（vitest `integration`）：globalSetup 起 stmsim（随机端口、`--approached`、tmp session-dir）；故障场景（>5 s 延迟 ⇒ 超时+重连+三次 OPEN；`NeedModule` 不记熔断；掉包 = 断链）期望值来自 Python 客户端基线。
- **contract**（真实 dsh 包）：§15 十条 + guard/pre-execute/approval reason 透传/投影同引用/jobs.kill 触发 cancel。
- **dsh replay**：`presentResult/presentCall/render` 对录下的 session JSONL 重放与 live 一致；投影 `apply` 重放；**replay 时工具不得触碰仪器**（runner 检查 replay 标志，否则 fake 顶替）。
- **变异**：内核 `gates: GateSet` 可注入；`MAST_MUTATE=<gate>` 逐个换 no-op 重跑该闸测试集，meta 断言每闸至少一条变红（三判据：已应用、落在被测对象、变红）；拔掉 pre-execute 的 abort deny ⇒ 内核 K2 仍拒（证明冗余非唯一）；注册表完整性（每技能有 safety_level、DANGEROUS 在允许清单、`bias_pulse/tip_shaping` 在 SAFE 下被拒——去标签必红）。
- **差分（Python vs TS，同技能同参数）**：可行且值得做，限 L0/L1/L3 确定性技能。A（推荐）录制回放：`tools/record-traces.py` 用 `ExecutionContext.run` + `fault_hook(command, args)` 录 `spec/golden/traces/<Skill>/<case>.json`（`{seed, time_scale, approached, params, calls:[[verb,args]], events:[kind], truth_after, result 标量子集}`），TS 同 seed 跑内核比对；B 退路在线双跑（STM-Bench 加 `test_ts_differential.py` 用 `dsh-spm skill run` 子进程）。规范化 `traceNormalize()`：连续只读轮询折叠 `×k`；差分跑时关 1 Hz 刷新；浮点 1e-9 相对容差；路径只比 basename；**不比 return_value 形状**，比状态缓存 patch 后的非时变字段。含视觉/LLM 决策的 composite 改用 stmbench Track B 真值做结果级对比（Phase 8）。
- **前端**：纯函数测试原样搬 vitest；组件 jsdom；奇偶表；playwright 后置。
- **真机阶梯**（Phase 8）：只读全扫 → 值守窗口清单（带工具多轮/ask_user/Stop/重启续聊/语音各一次）→ bake ≥1 周。

## 13. 风险

| 风险 | 对策 |
|---|---|
| dsh API 漂移（0.1.2 日更；官方预告若干破坏性重构；caret 跨通道；`SESSION_FORMAT_VERSION: 0`） | compat 单点 + 整套精确锁 + `check-dsh-pin` + contract 测试 + **实时小步升级、随 dsh 一起重构**（D11，`docs/dsh/upgrades.md` 清单）；持久真源 SQLite |
| **0.1.2 正式版临近**（09-03 已出 rc.1）：`SESSION_FORMAT_VERSION` 的 "Remove at the first tagged release" 可能在那一刻兑现，既有 `~/.dsh` 数据可能不可读 | 持久真源在我们自己的 SQLite；升级前备份 `~/.dsh`；升级清单第 6 步拿既有 home 冒烟；`spec/dsh/dump-config.<version>.yml` 入仓便于逐行对 |
| §15 十条 dsh 事实任一红 | Phase 0 先钉；每条都有「红了改什么」（section→pre-step 注入；guard 拿不到 args→内核；restrict 不可放松→桩换注册；patch 无 remove→同 id 覆盖；webServer 不流式→轮询；`conversation.view` 无 session 不显示→自动建空 session/侧栏面板） |
| Windows：`node:sqlite` 可用性、`py` 启动器、长路径、CRLF、路径含空格 | CI win 矩阵从 Phase 0 起；`.gitattributes` LF；sqlite 退路 better-sqlite3 |
| Node 缺科学计算生态 | `numerics` 只实现检测器用到的原语 + numpy 金样；不引入 ndarray 大生态 |
| 深度视觉（torch） | 明文例外：训练/导出留 Python；`.onnx` + manifest 是接口；权重不入仓（DINOv3 许可） |
| 性能：1 Hz 缓存 + 0.5 s 看门狗 + 20 Hz 示波器 + 技能同在一个事件循环 | 主循环禁 >50 ms 同步计算；PSD/FFT/检测器进 `worker_threads`；`monitorEventLoopDelay` p99 >100 ms 亮红进投影；看门狗有自己的 socket 不与技能抢锁 |
| 审批 fail-closed 撞上过夜 | `autonomous` 编译期无 ask；attended 无人 ⇒ deny + journal 不挂起 |
| supervisor 用工具调用路由后乱调 `subagent` | 全部护栏在 `tools/pre-execute` 是 deny 不是提示；投影里可见每次 deny 的 reason |
| 子 agent 拿不到根会话 id | spawn 前言/agentOptions 传 `rootSessionId`；contract 钉「子会话第一步能读到」 |
| session log 膨胀（旁白/进度/投影） | 旁白与进度限频、指针不带正文、1 Hz 状态不进 session |
| 37k 行 Tailwind 组件与宿主观感不一致 | 前缀作用域 CSS 只用于搬来的旧页；新组件用 ui-primitives |
| 与 Python 行为漂移 | 三层检测（spec/schema parity、trace 差分、数值 golden）+ `spec/deviations.md` 登记有意差异（未登记 = 缺陷） |
| 语言迁移让守卫半盲 | 结构化 code/signature；钉住短语集中在 `messages.ts` 并测试；子串前置规则否定形在前（`z_controller_off` 不被 `on` 命中钉成测试） |
| 唤醒 per-run 护栏归零 | ② ④ per-system；`0` 语义先定死；默认关 |
| 许可证 | MIT；核对 dsh 与 `nanonis_spm`（协议表派生自它）与 MIT 兼容，`spec/` 带 NOTICE；DINOv3 权重不分发；文献语料不入仓 |
| dsh-base 行 id/config 随版本变 | 只覆盖 §6.3 表里的行；每次升级跑 `--dump-config` 比对 |

## 14. 非目标

- 不做 Python 子进程桥/HTTP 桥/MCP 桥；不把 stmsim 移植成 TS（它是靶不是产品）；不迁移 `rl/`/`training/`/视觉训练脚本。
- 不复刻旧 `api/routes/` 55 个模块的路径与 schema（`/mast/*` 重新设计；`schema.d.ts` 不搬，用 zod 派生客户端类型）；不做第二条审批应答通道；不做 PIN 认证。
- 不迁移旧会话/群聊转录/checkpoint；不迁移 Optics/TERS 光学仪器、OTA 推送、PyInstaller 打包（分发即 `dsh plugin add`）。
- 不承诺扫描类 job 跨重启续跑（只有 conduct）；不替换 dsh 的 session 存储/agent loop/compaction。
- 不用 `agentTeams`/`workflowEngine` 做编排主干（复评条件：去掉「实验性」且两个小版本无破坏性变更）。
- 语音：**默认不做**，排在 U5 之后；可行路径已写（ASR 文本 → `agent.followup`；逐 token 来自我们自写的 `OpenAiCompatAdapter.stream()` tee；下行 PCM 走 `fetch` 流式；duplex 需 WS upgrade）；`lib/audio/*`、`lib/voice/vad.ts`、`VoiceDock.tsx` 可全搬。
- 不搬 22 个「读源码对账」型前端测试；不搬 `knowledge_mode` 等墓碑设置键；DP 的三个代码执行工具首版不给。
- 不支持 Node < 22.19；不支持非 Windows 的 Nanonis 真机。
- Phase 8 之前不出现 `mast-rig` profile；真机 0 次是仓库结构而不是纪律。

## 15. Phase 0 必须先核实的 dsh 事实（spike）

十条清单与每条「红了改什么」在 **`docs/dsh/facts.md`** §7；课时 0.6 把结论写成 contract 测试 + `docs/dsh/spike.md`，每次升级后重跑。

## 16. 开放问题

- 何时公开：署名与 GitHub 账号已定为 **HamsterPark**（`LICENSE` 已落 `Copyright (c) 2026 HamsterPark`）；**何时公开仍未定**，建议先私有，Phase 1 联调通过后公开（用户「一点点重新开源」）。
- pnpm `overrides` 能否按 `@deepseek-ai/*` 通配钉版（0.2 核实；不能就用脚本从安装树生成逐包 overrides 表）。
- `dsh plugin add` 装进 profile 时子包由 profile 自己的 pnpm 解析：宿主子包漂到新版而我们的 bundle peer 精确钉旧版时，dsh 是报错、警告还是静默混装（0.4 实测；期望是硬失败）。
- 插件版本号怎么表达「对应哪个 dsh」（候选：`package.json` 里 `dshVersion` 字段 + peer 精确钉；或版本号后缀）。0.2 定。
- 差分测试要对 STM-Bench 做 ~60 行小改（`--trace`/truth 端点）——要不要动 STM-Bench，还是走退路 B。
- 深度视觉模型的 ONNX 导出在旧仓 venv 做，产物放哪（不入仓；建议 `E:\dsh-spm-models\` + manifest）。

## 17. 参考

- **本仓文档**：`docs/EXECUTION.md`（分段执行计划）· `docs/dsh/facts.md`（版本事实）· `docs/dsh/upgrades.md`（升级策略与日志）。
- **仓外只读研究快照**（2026-09-01，八份，`<PRIVATE_REVIEW_ARCHIVE>\01-dsh-spm\研究快照-2026-09-01\`）：`plan-architecture.md` 仓库形态/接缝/测试 · `plan-skill-pipeline.md` 内核 K0–K18/批次/DoD/数值库/导出脚本/差分 · `plan-frontend-agents.md` 逐页落点/实时/审批 UI/8 preset/编排 · `runtime_survey.md` 21 中间件逐条/记忆/goals/唤醒/conduct · `explore-harness-layer.md` harness 层地图/四库/双引擎/HITL/provider 栈 · `explore-shell-and-docs.md` 入口/API/事件/前端/打包/测试 · `explore-domain-layer.md` 技能树/安全件/仪器层/数值依赖 · `PLAN-2026-09-01-alpha3.md` 本文重构前的原稿。**它们是私有旧仓的行号级内部细节，不进本仓 git 历史**；写代码时按绝对路径读。
- dsh：https://github.com/deepseek-ai/deepseek-harness（`docs/architecture.md`、`docs/cordis-tutorial/01–07`、`docs/subsystems/{tools,core,jobs,skills,session-projection,client-modules}.md`、`docs/cookbook/{extension-cookbook,adding-a-tool,adding-an-llm-adapter,adding-a-settings-card}.md`、`docs/user/develop/basic/publish.md`、`AGENTS.md`、`packages/client/AGENTS.md`、`docs/development.md`）；发布页 https://github.com/deepseek-ai/deepseek-harness/releases ；npm `@deepseek-ai/dsh`（追踪对象 = 所有 dist-tag 里 semver 最大值，见 D11）。
  **反馈渠道是 GitHub Discussions，不是 Issues**——该仓 Issues 已关闭，npm 包 `bugs.url` 指向的 `/issues` 是死链；分类为 `Announcements / General / Ideas / Polls / Q&A / Show Your Plugins!`。报 bug 前先搜（`gh api graphql` + `type:DISCUSSION`），那里 bug 报告密度很高、且常有社区成员贴出 master 上的源码锚点。
- 先例：https://github.com/omicverse/dsh-omicos · https://github.com/hashgraph-online/hol-guard-plugin · https://github.com/poplarity/dsh-science-workbench · https://github.com/omdsh-dev/dsh-genui · https://github.com/libukai/awesome-deepseek-harness
- 旧仓：`docs/v2/architecture/v2.md:302-319`（退出判据与 6 项清单）、`~/.claude/plans/langgraph-functional-sutherland.md`（退出 LangGraph 计划）、`STM-Bench/docs/DESIGN.md` §2.1（线协议与接线事实）。
