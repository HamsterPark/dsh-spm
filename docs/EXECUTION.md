# dsh-spm 分段执行计划

> **这份文件是开工入口**。`PLAN.md` 回答「为什么这样设计」，本文回答「下一步做什么、做到哪算完、在哪停下」。
> 版本相关的事实在 `dsh/facts.md`，升级流程与日志在 `dsh/upgrades.md`。
> 建于 2026-09-07，随每段推进更新「当前位置」与「决策台账」两节。

## 0. 怎么用这份文件

每一段（= 一个课时）固定五件事，缺一不算完：

| | 内容 |
|---|---|
| **① 查版** | `npm view @deepseek-ai/dsh dist-tags --json`，取三个 tag 里 **semver 最大**的那个。与 `dsh/facts.md` 首行不一致 ⇒ 先跑升级清单，再回来做本段（D11） |
| **② 写** | 一个文件或一个紧密相关的小模块，**≤200 行**。测试与代码同段写 |
| **③ 讲** | 做了什么 / 为什么这样写 / 涉及的 dsh·Cordis·TS 概念 / 与旧仓 Python 对应物的差别 / **你怎么亲手验证**（跑哪条命令、看什么输出）。末尾一行「本段术语表」 |
| **④ 验** | 你亲手跑一遍验收命令。绿了才继续 |
| **⑤ 停** | **停下等你**。不连写多段 |

**回滚单位 = 一段**。每段一个提交（中文首行 `feat(pkg): …` / `chore(dsh): …` / `docs: …`）；升级 dsh 永远是**独立提交**，不与领域代码混。
段内红了就在段内修；段的设计被推翻就整段 revert，不做「留一半」。

**红线**（任何一段都不许破）：真机 0 次直到 Phase 8；`profiles/mast-rig` 不入仓；除 `packages/host/compat/src/` 外任何文件不许出现 `from '@deepseek-ai/`；研究快照与旧仓内容不进本仓 git 历史。

---

## 1. 当前位置（2026-09-07）

- **课时 0.1 ✅ 完成**（2026-09-02）：pnpm 装好、dsh web profile 在 Windows 跑通、`--dump-config` 导出组合树。
- **2026-09-07 整理**：仓库确立为 git 路径（`git init` 已做，尚无提交）；研究快照八份移出到 `<PRIVATE_REVIEW_ARCHIVE>\01-dsh-spm\研究快照-2026-09-01\`；补 `.gitignore` / `.gitattributes`；本文件新建。
- **课时 0.1.5 ✅ 完成**（2026-09-08）：dsh 版本裁决 = **不升 0.1.3-alpha.2，锁留 `0.1.2-rc.1`**；`LICENSE` 落盘（`Copyright (c) 2026 HamsterPark`）。
- **代码行数：0**。所有包都还不存在。
- **下一段 = 课时 0.2（仓库骨架）**。

### 阻塞：dsh 0.1.3-alpha.2 装不上本机（2026-09-07 实测）

`0.1.3-alpha.2`（09-07 13:11 UTC 发布，占 `alpha` 标签）按 D11 的「semver 最大值」规则**就是当前的追踪目标**——它比 `latest`/`next` 上的 `0.1.2-rc.1` 新。但本机装不上：

```
@deepseek-ai/dsh-session-persistence-jsonl@0.1.3-alpha.2
  └─ dependencies: fs-ext@2.1.1          ← 硬依赖（不是 optional），精确钉
       └─ scripts.install: node-gyp configure build   ← 无预编译，每次安装现场编译 C++
```

三次实测（09-07）：

| 做法 | 结果 |
|---|---|
| `npx -y @deepseek-ai/dsh@0.1.3-alpha.2 --dump-config` | 失败。npm 回滚时撞文件锁刷一屏 `EPERM cleanup` 警告，把真正原因盖住了 |
| `npm i @deepseek-ai/dsh@0.1.3-alpha.2` | 失败：`gyp ERR! Could not find any Visual Studio installation to use`，整棵树回滚 |
| `npm i --ignore-scripts` 后启动 | 装得上（536 包 / 32 s），`--dump-config` **能导**；但 `--profile web` **在插件树加载阶段就崩**：`plugin tree failed to load: … Cannot find module './build/Release/fs_ext.node'` |

本机确认：**没有任何 Visual Studio / MSVC**（只有一套 Windows Kits 8.1，不含编译器）；PATH 里的 `python` 是
Microsoft Store 的转发桩，不是可用的 Python 3。

**已经拿到手的东西**（不管升不升都归档了）：借 `--ignore-scripts` 导出了 `spec/dsh/dump-config.0.1.3-alpha.2.yml` 与
`pkglist.0.1.3-alpha.2.txt`，与 rc.1 逐行 diff 只有 **20 个 diff 行、四处变更**（145→147 行插件行）。
另有一个正面发现：钉 `0.1.3-alpha.2` 装出的树里 **223 个 `@deepseek-ai/dsh*` 全部恰好是该版本，零例外**——
semver 规定预发布只匹配元组相同的比较符，所以 09-04 那种 alpha→rc 漂移**不会跨 minor**。整套精确钉的结论不变（漂移发生在 patch 元组之内）。

**为什么会突然冒出个原生依赖**：`0.1.3-alpha.1` 的破坏性变更里有「**session 加锁，一个进程最多持有一个 session**」——
`fs-ext` 提供的就是 `flock`。同一次变更还把 session 格式升到 **v2**（v0/v1 自动迁移），新增
`dsh-session-format` 与 `dsh-session-format-catalog` 两个包。对照 `0.1.2-rc.1`，同一个包当时只依赖 `koffi` 与 `schemastery`。
这正是 `facts.md` §1 一直在等的那件事：`SESSION_FORMAT_VERSION` 的 "Remove at the first tagged release" 兑现了。

**✅ 2026-09-08 已定：走 A，不升级。** 除了下表的理由，复查上游 Discussions 后又多了一条硬证据——**0.1.3-alpha.2 至少有四处相互独立的启动/安装故障**（`fs-ext` 编译、`duplicate loader entry id: file-upload`、session v2 迁移拒绝老日志、rpc owner 未声明），逐条见 `dsh/facts.md` §8.0。这一版还没熟。

**三条路**（原始权衡，留档）：

| | 做法 | 代价 | 风险 |
|---|---|---|---|
| **A（建议）** | **暂不升级，锁继续留在 `0.1.2-rc.1`**；把 0.1.3 记成「已知阻塞的待升级」，每课时①照常查版，等 dsh 把 `fs-ext` 换成预编译/可选依赖，或等 0.1.3 进 `latest` | 0 | 落后一个 minor。但本仓无代码，追上的成本仍然接近 0；且 `latest`/`next` 目前**也**还在 rc.1，dsh 自己没把 0.1.3 推上稳定通道 |
| B | 装 Visual Studio Build Tools（「使用 C++ 的桌面开发」工作负载）+ 真 Python 3，然后升 0.1.3 | 一次性下载约 3–7 GB，装完还要验 | 我们的 CI 与将来任何用户装 `dsh-spm` 时都会撞上同一堵墙 ⇒ 即使本机装了，`ubuntu/windows` 双平台 CI 与插件使用者的门槛还在。这条路解决的是我一个人的机器，不是产品的问题 |
| C | `npm i --ignore-scripts` 跳过编译 | 0 | **已实测：启动即崩**（插件树加载 `session-persistence-jsonl` 时 `require` 不到 `fs_ext.node`）。只够拿来导 `--dump-config` 做规格 diff——这件事已经做完了，**不能当开发环境** |

> **理由**：硬钉一个现场编译的原生依赖，在一个跨平台 CLI 里几乎一定是上游疏漏（它让所有没有 VS 的 Windows 用户装不上，
> 而 dsh 09-03 才刚修过一批 Windows 问题）。dsh 大约一天一版，等一等的期望成本远低于现在给本机和 CI 都背上 C++ 工具链。
> **但这是你的决定**：选 B 我就照升级清单走完并把工具链前置写进 CI。

---

## 2. Phase 0 · 脚手架（当前 Phase）

完成判据（PLAN §11）：`dsh plugin --profile web add ./packages/bundle/dsh-spm` 成功；会话里 `stm_hello` 返回版本；contract 测试绿；覆盖率门禁生效；spike 十条各有结论；`check-dsh-pin` / `check-dsh-latest` 生效。

### 课时 0.1.5 —— 版本决策 ✅ 完成（2026-09-08）

裁决：**不升级，锁留 `0.1.2-rc.1`**（B1）。做完的事：
`facts.md` 新增 §8.0（`fs-ext` 阻塞的三次实测、组合树 diff、逐条影响、上游 Discussions 证据表）与 §1 三条修订；
`upgrades.md` 追加 09-07 日志；`spec/dsh/` 存入 `dump-config.0.1.3-alpha.2.yml` + `pkglist.0.1.3-alpha.2.txt`；
`LICENSE` 落盘（B2）。**下一段 = 课时 0.2。**

这一段真正学到的两件事，写代码时会反复用上：

1. **prerelease 的 caret 不会跨 minor**。`^0.1.2-rc.1` = `>=0.1.2-rc.1 <0.2.0`，但 semver 规定预发布版本只匹配范围里**元组相同**的比较符；`0.1.3-alpha.2` 的元组 `[0,1,3]` 谁也不等于 ⇒ 钉 rc.1 不会被拖到 0.1.3。09-04 那次 alpha→rc 漂移之所以发生，正因为两者同在 `0.1.2` 元组内。**结论不变：仍要整套精确钉**——漂移就发生在 patch 元组之内，而 dsh 大部分时间待在那里。
2. **`--ignore-scripts` 的边界**：能装上、`--dump-config` 能导（够做规格 diff），但一启动就在插件树加载 `session-persistence-jsonl` 时崩。以后遇到「上游装不上但我要它的规格」，这就是标准动作（写进 `spec/dsh/README.md` 了）。

**无论选 A 还是 B，这一段都要顺手记下 0.1.3 对本计划的四处影响**（现在不改代码，等真升级时兑现）：

1. **session 格式 v2 + `SessionHandle` + `agentLoop.create()` 变异步 + 一进程一 session 锁** ⇒ `compat/session` 的暴露面要重画；`ctx.agents.create/resume` 的 contract 测试（spike 第 10 条）要重写。**对持久数据没有影响**——PLAN §3.1-1 早就把真源放进我们自己的 SQLite，session log 可丢，这次正好是那条决策的第一次兑现。
2. **persona 配置拆成 prefix / suffix 两段** ⇒ §7.8 的 8 个 preset 里 `persona` 子插件要跟着拆；`minimal` preset 的 `complete: true` 语义要重核。
3. **新包 `dsh-http-proxy`：进程级出站代理策略，读 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 并装成 undici 全局 dispatcher** ⇒ 真机 profile「不让模型上网」多了一个比 `restrict({deny: web_fetch})` 更硬的闸（进程级，覆盖插件自己发的请求）。Phase 8 的 `mast-rig` profile 评估用 `NO_PROXY`/空代理把出站封死。
4. **continuable 子 agent 支持消息排队/编辑/删除/steer；Agent Team `send_message` 统一 steer 语义** ⇒ §7.8 supervisor→IC 的追问路径更稳；「插话 = composer `steer()`」的设计得到上游支持。另有 **DeepSeek 流式 tool call 丢 id/name 的修复**——与 §3.2-12「带工具调用一律不流式」同源的坑，上游修了，但我们的纪律不改（Kimi 的截断问题独立存在）。

### 课时 0.2 —— 仓库骨架

| | |
|---|---|
| **写** | `package.json`（root，`packageManager: pnpm@11.7.0`）、`pnpm-workspace.yaml`（`packages/*/*`）、`tsconfig.base.json`（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + ESM/NodeNext）、`tsconfig.client.json`、`vitest.workspace.ts`（三 project `unit`/`contract`/`integration`）、`.github/workflows/ci.yml`（`windows-latest` + `ubuntu-latest` × Node 22.19/24，先只跑 install + build） |
| **讲** | pnpm workspace 与 npm/yarn 的差别；TS `strict` 三个附加开关各拦什么；project references 与 `tsc -b`；为什么目录约定镜像 dsh（`packages/<组>/<包>`） |
| **验** | `pnpm install` 通过；`pnpm -r build` 空跑通过；CI 在 push 后两个平台都绿 |
| **顺手结清的开放问题** | PLAN §16：① pnpm `overrides` 能否按 `@deepseek-ai/*` 通配钉版（不能就写脚本从安装树生成逐包表）；② 插件版本号怎么表达「对应哪个 dsh」（候选：`package.json` 加 `dshVersion` 字段 + peer 精确钉） |
| **停点** | 空仓库能 install、能 build、CI 绿。**此时还没有一行 dsh 代码** |

### 课时 0.3 —— `dsh-spm-compat` 防腐层与版本锁

| | |
|---|---|
| **写** | `packages/host/compat/`：按用途分文件 re-export（`plugin/tools/agent/session/jobs/ui/llm/client`）+ `scripts/check-dsh-surface.ts`（写 `dsh-surface.lock.json`）+ `check-dsh-pin.ts`（断言安装树里 `@deepseek-ai/dsh*` 只有一个版本）+ `check-dsh-latest.ts`（读全部 dist-tag 取 semver 最大值比对）+ 第一条 contract 测试 |
| **讲** | 为什么全仓只许一个包 import `@deepseek-ai/*`；pnpm `overrides` 把**整套**钉成同一精确版本（只钉 `dsh` 一个包锁不住任何东西）；contract 测试与 unit 测试的分工；升级八步清单怎么走 |
| **验** | 改一个 re-export 名字 ⇒ surface 检查变红；把 `overrides` 的一项改成 `^` ⇒ `check-dsh-pin` 变红；`pnpm check:dsh-latest` 报出 npm 上的最大版本（当前应报 `0.1.3-alpha.2` 比锁定的新） |
| **停点** | 三个脚本都能**主动变红**。只会变绿的检查等于没有检查 |

### 课时 0.4 —— 总 bundle 与第一个工具 `stm_hello`

| | |
|---|---|
| **写** | `packages/bundle/dsh-spm/` + `cordis.patch.yml`（只 `insert`）+ `stm_hello` 工具（第一次 `defineTool`） |
| **讲** | 插件三件套 `name/inject/apply`；`ctx.effect()` 的回滚语义；`defineTool` 的 `parameters/output/execute`；工具流水线 `tool/call → pre-execute → execute → post-execute → result` |
| **验** | `dsh plugin --profile web add ./packages/bundle/dsh-spm`；在聊天里让模型调 `stm_hello` 拿到版本号 |
| **必须实测的两件事** | ① **我们从宿主 bundle 注册的工具，会不会出现在 agent preset 的目录里**（facts.md §3：web-app 在宿主层把模型可见工具全 `disabled`，由 preset 在 agent 平面重挂——如果我们的工具不自动进去，8 个 preset 的写法要改）；② PLAN §16：`dsh plugin add` 时宿主子包漂到新版而我们的 bundle peer 精确钉旧版，dsh 是**硬失败**还是静默混装（期望硬失败） |
| **停点** | 会话里真的调到了我们写的工具 |

### 课时 0.5 —— 第一张设置卡 `mast.instrument`

写 host 侧 `ctx.settings.installSection` + client 侧 `settings.plugin.item` slot。
讲 host/client 双面、slot 系统、`settingsScope.bind`、客户端 bundle 的隐式基线依赖（React/Cordis/`dsh-client-store`/`ui-primitives`/`ui-slots` **不得重复声明**）。
验：设置页看到卡片，改端口号后重启读回。**注意 0.1.3 统一了设置面板的标签/开关样式**，升级后这段要重看一眼。

### 课时 0.6 —— dsh spike 十条

把 `facts.md` §7 的十条逐条写成 contract 测试，结论写 `docs/dsh/spike.md`，每条附「红了改什么」（PLAN §13 已给出六条的备选路）。
**每次升级后重跑**——这十条就是升级清单第 4 步的内容。
其中第 10 条（子会话能否读到父/根 session id、`ctx.agents.resume` 的 API 名）会被 0.1.3 的 `SessionHandle` 改写，如果那时已升级就直接照新 API 写。

### 课时 0.7 —— 规格导出第一版

`tools/spec-export/export_mast_spec.py`（Python 3.13，**用旧仓 venv** `python`，只读旧仓，`MAST2_PROJECT_ROOT` 指向临时目录隔离），先只导 `skills.json` + `si_cases.json`。
讲 golden 的作用、为什么分母必须从真源取而不是手抄、每个 collector 独立 try/except 并在 `manifest.json` 记成败。
验：跑一次，看 `spec/golden/skills.json` 里 SetBias 那条。
**本机没有可用的 `python`**——脚本一律用 venv 里的绝对路径调，别写 `python - <<PY`（会静默什么都不做）。

---

## 3. Phase 1 · 仪器接缝（课时 1.1–1.10）

完成判据（PLAN §11）：535 方法字节金样相等；三类故障行为与 Python 基线一致；`closeAll` 后 stmsim 端口可复用；看门狗在「Z 顶限撞针」场景 4 s 内退针；覆盖率 100%。

| 段 | 写什么 | 验收 |
|---|---|---|
| 1.1 | `dsh-spm-kernel` 类型（`SkillSpec/ParameterSpec/HardwareState/SkillResult/OperatingMode`）+ `si.ts`（逐字移植 `si_quantity.py`）+ golden 测试 | `parse_quantity('3p')` 对；裸 `1.5` 被拒 |
| 1.2 | `nanonis-wire` codec（帧头、类型码表、错误段、`NeedModule`） | 对 stmsim 录的字节金样往返相等 |
| 1.3 | `scripts/gen-nanonis.ts` → `generated/methods.ts` | 重生成无 diff；`typed.Bias_Get()` 有类型提示 |
| 1.4 | `RoleLink` TCP 客户端（`net.Socket`、单往返、超时、优雅关闭） | 起 `python -m stmsim serve`，`Bias_Get` 读到值；kill 后端口可复用 |
| 1.5 | `kernel/comms-breaker.ts` 熔断状态机（注入时钟）+ 单测表移植 | fake 时钟走一遍 CLOSED→OPEN→HALF_OPEN→CLOSED |
| 1.6 | `dsh-spm-instrument` Service | 会话里 `stm_hello` 改成读 `Bias_Get` |
| 1.7 | `instrument-stmsim` provider（spawn/等端口/SIGTERM）+ `instrument-fake` | `profiles/mast-sim` 装上后自动拉起模拟器 |
| 1.8 | `instrument-state`（1 Hz 11 verb、stale/carry-forward、`applyPatch`）+ 投影 + `stm_get_state` | 会话里问「现在偏压多少」 |
| 1.9 | 看门狗 + `estop()` + `/estop` 命令 | stmsim 撞针场景 4 s 内退针 |
| 1.10 | U0：SSE hub `/mast/events` + `ui-core` 右栏「仪器状态」卡 | 右栏读数 1 Hz 跳动；杀宿主重启 5 s 内续传 |

**Phase 1 的两处前置**（在 1.4 之前确认，别到时候卡住）：
- stmsim 要能跑起来 ⇒ `<STMSIM_ROOT>\` 的 Python 环境可用（走旧仓 venv 还是 STM-Bench 自己的，1.4 前定）。
- **0.1.3 的「subprocess 句柄不再带 PID」与「Windows 本地非终端子进程不再弹控制台窗口」** ⇒ 若 `instrument-stmsim` 决定走 dsh 的 `subprocess` 服务而不是 Node 自己的 `child_process`，1.7 要按新语义写；PLAN §7.1 目前的设计是我们自己 spawn，不受影响。

---

## 4. Phase 2–8

粒度到时按同样格式切（PLAN §2.1：「后续 Phase 到时再按同样粒度切」）。各 Phase 的内容与完成判据见 **PLAN §11**，批次成员与每技能 DoD 见 **PLAN §8.4 / §8.5**。要记住的三条：

- **批次成员一律从 golden 的 `category` + 目录 + `safety_level` 派生，不读 `composition_level`**（374/498 个吃默认值 0，照它分会把四分之三全归 L0）。
- **Phase 3 是第一个「可用里程碑」**：私聊 IC 在 stmsim 上十轮对话，session log 可 replay 重建每次请求。在那之前没有任何东西是"能用"的，别在 Phase 2 就想着演示。
- **Phase 8 之前不出现 `mast-rig`**。

---

## 5. 决策台账

| # | 议题 | 状态 | 结论 / 待办 |
|---|---|---|---|
| **B1** | dsh 升不升 0.1.3-alpha.2（本机装不上，见 §1） | **✅ 2026-09-08 定：不升** | 锁留 `0.1.2-rc.1`，每课时照常查版。社区已多方复现同一问题（Discussions #5929/#5882/#5784/#5751/#5638/#5689），且该版还有另外三处独立的启动崩溃（#5881 重复 loader id、#5753 session v2 迁移拒绝老日志、#5889 rpc owner 未声明）与一处发布物缺依赖（#5913），`latest`/`next` 也仍停在 rc.1。**上游反馈渠道是 GitHub Discussions，不是 Issues（该仓 Issues 已关闭）** |
| B2 | LICENSE 的版权署名 | **✅ 2026-09-08 定** | `Copyright (c) 2026 HamsterPark`（用户昵称，真名在其 GitHub 主页备注）。`LICENSE` 已落盘；0.2 建包时各 `package.json` 的 `author` 用同一署名 |
| B3 | 仓库挂哪、何时公开 | 半定 | 署名与账号都是 **HamsterPark**（本机 `gh` 已登录该账号）。**何时公开仍未定**：建议先私有，Phase 1 联调通过后再公开（用户「一点点重新开源」） |
| B4 | pnpm `overrides` 能否按 `@deepseek-ai/*` 通配 | 0.2 核实 | 不能就脚本生成逐包表 |
| B5 | 插件版本号怎么表达「对应哪个 dsh」 | 0.2 定 | 候选：`package.json` 加 `dshVersion` + peer 精确钉 |
| B6 | 我们注册的工具是否自动进 agent preset 目录 | 0.4 实测 | 不进 ⇒ 8 个 preset 的写法要改 |
| B7 | `dsh plugin add` 遇到子包漂移是硬失败还是静默混装 | 0.4 实测 | 期望硬失败 |
| B8 | 差分测试要对 STM-Bench 做 ~60 行小改（`--trace`/truth 端点） | 未定（PLAN §16） | 退路 B：在线双跑 |
| B9 | ONNX 权重放哪（不入仓） | 未定（PLAN §16） | 建议 `E:\dsh-spm-models\` + manifest |

## 6. 每次开工前的三条自检

1. `npm view @deepseek-ai/dsh dist-tags --json` —— 与 `dsh/facts.md` 首行一致吗？
2. `git status` —— 上一段收干净了吗（不该有跨段的半成品）？
3. 这一段的验收命令是什么、我打算让你亲手跑哪一条？
