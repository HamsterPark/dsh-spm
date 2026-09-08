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

## 1. 当前位置（2026-09-08）

进度：**0.1 ✅**（09-02 环境与 Windows 冒烟）· **0.1.5 ✅**（版本裁决：不升 0.1.3，锁留 `0.1.2-rc.1`；`LICENSE` 落盘）
· **0.2 ✅**（仓库骨架）· **0.3 ✅**（防腐层与版本锁）· **0.4 ✅**（总 bundle 与 `stm_hello`，真实 dsh 集成已验）
· **0.6 ✅**（spike：结清 1/3/5/7，半结清 6）。**0.5（设置卡）挪到 1.7**——它要配的仪器端口那时才存在。
**下一段 = 课时 0.7（规格导出第一版）。**

仓库现状：3 个工作区包（`dsh-spm-root` / `dsh-spm-compat` / `dsh-spm`），15 条测试，`pnpm install --frozen-lockfile`
/ `pnpm build` / `pnpm test` 全绿。锁定 dsh `0.1.2-rc.1`。

Phase 0 完成判据（PLAN §11）还差：**规格导出**（0.7）、**覆盖率门禁**、spike 剩下五条（各有触发点，见 `dsh/spike.md`）。

2026-09-07 的一次性整理：确立 git 路径；研究快照八份移出到
`<PRIVATE_REVIEW_ARCHIVE>\01-dsh-spm\研究快照-2026-09-01\`；补 `.gitignore` / `.gitattributes`；本文件新建。

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

### 课时 0.2 —— 仓库骨架 ✅ 完成（2026-09-08）

落地 6 个文件 154 行：`package.json`（`packageManager: pnpm@11.7.0`）、`pnpm-workspace.yaml`、`tsconfig.base.json`、
`tsconfig.json`、`vitest.config.ts`（两 project）、`.github/workflows/ci.yml`（Windows + Ubuntu × Node 22.19/24）。

**工具链版本不照 PLAN §5 的 09-01 快照抄**，而是从 GitHub 拉了 dsh 在锁定 tag 上的根 `package.json` 对照：
继续用 **TypeScript 6 / Vitest 4**，不追已发布的 TS 7.0.2 / Vitest 5——dsh 自己在 `pnpm-workspace.yaml` 里把 peer
封在 `typescript '>=5 <7'`，而 compat 要吃它发布的 `.d.ts`。宿主侧用 `nodenext` 而非 dsh 全仓的 `bundler`：
我们的宿主包由 `tsc` 直接编给 Node 跑，`bundler` 会放过缺 `.js` 后缀的相对 import——编得过，运行时找不到模块。

按消融原则删去（218 行 → 154 行）：host/client 两个 tsconfig（第一个客户端包在 1.10，**那时的硬约束已记进 §3**）、
`typecheck` 脚本（与 `build` 一字不差）、三个 `test:*` 别名、`test:coverage` 与 `@vitest/coverage-v8`（尚无覆盖率门禁）、
`repository` 字段（仓库尚不存在）、`integration` project（1.4 才有东西可跑）。

### 课时 0.3 —— `dsh-spm-compat` 防腐层与版本锁 ✅ 完成（2026-09-08）

落地：`packages/host/compat/`（`src/index.ts` 只导出 `defineTool` / `DefineToolOptions` / `Context` 三个名字——**只导出此刻真有调用方的**）、
`contract/pin.test.ts`（4 条）、`scripts/check-dsh-latest.ts`、`pnpm-workspace.yaml` 的 18 行逐包 overrides 表（从真实安装树导出）。
安装树：18 个 `@deepseek-ai/*`，15 个 `dsh*` 全为 `0.1.2-rc.1`，Cordis 系独立版本线。
验收全绿，且**做过变红演练**：把 compat 声明的锁改成 `alpha.5`，钉版测试当场列出 15 个漂移包；还原后回绿。

按消融原则**没有写**的三样，附上它们各自该在什么时候出现：

| 没写 | 为什么现在不需要 | 什么时候写 |
|---|---|---|
| `check-dsh-surface.ts` + `dsh-surface.lock.json` | compat 只导出 3 个名字，其中任何一个在 dsh 侧消失，`tsc -b` 当场就编不过；再加一份 lock 文件此刻不承担任何 tsc 没做的事 | 导出面大到「签名变了但仍能编过」成为真实风险时（大约 §7 的接缝铺开、compat 破 30 个导出） |
| `check-dsh-pin.ts` 独立脚本 | 同一个断言已经是 contract 测试，进 `pnpm test` 也进 CI。两份实现就是两份真源 | 若某天需要在 `pnpm install` 之后、测试之前就拦住（如 CI 分阶段），再抽出来 |
| compat 按用途拆 8 个文件 | 3 个导出拆 8 个文件，读的人要跳 8 次才知道总共就这么点东西 | 导出面按 `tools/agent/session/jobs/ui/llm/client` 真的各自成块时 |

本段钉死的 dsh 事实（已写进 `dsh/facts.md` §7-5）：`defineTool` 的 `parameters` 是**属性表**不是完整 JSON Schema；
`output: {schema, render}` **必填**；schema DSL 遇到 `minimum` **直接抛错**而非静默丢弃。头两条都是我写契约测试时猜错、被测试当场纠正的——这正是它存在的理由。

### 课时 0.4 —— 总 bundle 与第一个工具 `stm_hello` ✅ 完成（2026-09-08）

落地：`packages/bundle/dsh-spm/`（`src/index.ts` 插件三件套 + `cordis.patch.yml` 一行 `insert` + 单测）、
`packages/host/compat/src/boundary.test.ts`（防腐层边界）。共 8 条测试。

**在隔离 `DSH_HOME` 里做的真实集成**（没碰你的 `~/.dsh`）：`dsh plugin --profile web add <本仓路径>` 成功，
dsh 认出 `dsh.bundle.patch` 字段并把 `dsh-spm` 追加进 `dsh.profile.bundles`；`--dump-config` 从 525 行变 528 行，
末尾出现 `# == dsh-spm` / `id: mast-hello`；`--profile web` 启动干净、stderr 空、端口正常释放。
**探针实测 `apply()` 在真实运行时里执行了且 `ctx.tools` 是活服务** ——不做这一步的话，`inject` 不满足时 Cordis
会静默不装载，而我只会看到「启动没报错」这个假绿。

本段结清 B7（问题问错了）、半结清 B6，并新开 **B10**（开发态 `link:` 与安装态是两条解析路径）。
最重的一条进了 `dsh/facts.md` §6-17：**一个进程里活着两份 `dsh-tools` 模块实例**，今天无害，
但 1.6 定义 Cordis `Service` 时会撞上模块身份问题，那时必须先验。

### ~~课时 0.5 —— 第一张设置卡 `mast.instrument`~~ → **挪到 1.7**（2026-09-08 决定）

按消融原则推迟。这张卡要配的是「四个端口 / hardware_modules / instrument_profile」，而仪器服务要到
**1.6/1.7** 才存在——现在做出来配置的是不存在的东西，纯演示，还要拖进一整套客户端机器
（tsdown、React、client bundle、0.2 刚消融掉的 `tsconfig.client.json`）。
对照 PLAN §11，**Phase 0 的完成判据里没有设置卡**，有的是「spike 十条各有结论」。
到 1.7 `instrument-stmsim` 真要配端口时再做，那时 host/client 双面、slot、`settingsScope`
与客户端 bundle 的隐式基线依赖一起讲，并与 1.10 的 U0 共用同一套客户端机器。

### 课时 0.6 —— dsh spike ✅ 完成（2026-09-08）

结论正本 `docs/dsh/spike.md`，可测的钉成 `packages/host/compat/src/spike.test.ts`（随 `pnpm test` 每次跑）。
**结清 1 / 3 / 5 / 7，半结清 6，其余五条各自记了触发点**——没到用的时候不查，查了也只是纸面结论，
而且 dsh 一天一版，结论会先于用途过期。

三条改变了设计的：

1. **guard 拿得到工具名与参数**（`ToolExecution.name` / `.arguments`）⇒ D9 把「物理荒谬」挂 guard 成立。
   与 facts.md §6-2 不矛盾：拿不到参数的是 `ctx.approval.request()`，`ApprovalDigest` 只为审批面存在。
2. **patch 没有 `remove`/`replace`**，只有 insert + 按 id 逐字段整值覆盖（实现就是 `target[key] = value`）。
   意外收获：非 insert 的 patch 里 `name` 是**断言**不是覆盖，对不上整条跳过并警告 ⇒ §6.3 那张覆盖表
   实施时**逐行都写上 `name`**，dsh 换了 id 背后的插件时我们会跳过+警告而不是悄悄作用到别的插件上。
   陷阱：id 匹配不到只警告不报错，覆盖会静默失效——升级清单第 2 步的逐行 diff 就是防这个。
3. **`tools/result` 读得到 `value`，但它 "deliberately omitted from durable events"** ⇒ 我们的 SQLite 是
   唯一能留住它的地方。PLAN §3.1-1 从「保险起见」变成有据可依。

顺带查到：`tools.restrict()` **要求 scoped context**，全局调用直接抛 ⇒ IC/conduct preset 的 deny 必须写在 agent 平面。

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

**1.10 落第一个客户端包时必须做的一件结构改动**（0.2 按消融原则没有预先搭）：把根 `tsconfig.json`
拆成 `tsconfig.host.json` + `tsconfig.client.json` 两个解决方案文件，根文件只 `files: []` + 引用这两个。
**理由不是整洁，是硬约束**：Cordis 靠 declaration merging 往 `Context` 上挂服务，宿主面与客户端面挂的是
**两组不同的服务**；两张图一旦落进同一个 `ts.Program`，两套 merge 会互相污染——**编译期一切正常，运行期才炸**。
dsh 自己的根 tsconfig 注释写着同一句（"keeps it program-less, so the host/client cordis Context merges never meet"）。
同时 client 的 `compilerOptions` 要覆盖成 `module: esnext` / `moduleResolution: bundler` / `lib` 加 dom / `jsx: react-jsx`。

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
| B4 | pnpm `overrides` 能否按 `@deepseek-ai/*` 通配 | **✅ 2026-09-08 实测：不能，而且是静默无效** | 拿 `overrides: {'@types/*': '22.20.0'}` 跑真安装：`@types/semver` 原样停在 7.7.1，**无报错、无警告，pnpm 就是什么都没做**。⇒ 若写 `'@deepseek-ai/*': '<版本>'`，我们会以为钉住了 223 个包，实际钉住 **0 个**。0.3 必须用脚本从安装树生成**逐包** overrides 表；**`check-dsh-pin.ts` 不是冗余保险，它是唯一能抓住这种静默失效的东西** |
| B5 | 插件版本号怎么表达「对应哪个 dsh」 | **✅ 2026-09-08 定：只用 `peerDependencies`，不加自定义字段** | 查了 dsh 自家包（`dsh-base` / `dsh-web-app` / `dsh-session-persistence-jsonl`）：`package.json` 的 `dsh` 段**只有** `bundle.patch`，没有任何版本声明字段；版本对应关系**全靠 `peerDependencies`**（它们用 `^` 范围，我们按 D11 用精确钉）。再加一个 `dshVersion` 字段就是第二份真源、还没人校验——正是 PLAN §5 记的 MAST「两处双真源」老毛病。peer 到底会不会被硬性执行，由 B7 在 0.4 实测 |
| B6 | 我们注册的工具是否自动进 agent preset 目录 | **半结清（2026-09-08）** | 已证：插件在真实 dsh 里被装载、`apply` 执行、`inject:['tools']` 得到满足、工具进了**宿主** `tools` 注册表（探针实测 `ctx.tools=object`）。**未证**：模型是否真能看见它——那需要一次真实的模型调用（要 API key 与花钱）。facts.md §3 抄的 preset 注释说「合并后的目录也包含部署全局注册的工具」，倾向于会看见。留到第一次有理由跑真模型时顺带确认 |
| **B7** | `dsh plugin add` 遇到子包漂移是硬失败还是静默混装 | **✅ 2026-09-08 实测：问题本身问错了** | `dsh plugin add <本地目录>` 用 **`link:`**，pnpm **完全不解析我们的 dependencies**——`workspace:*` 从没被求值，peer 精确钉也没执行，所以既不硬失败也不混装：**它压根没参与**。探针实测：运行时我们的 compat 解析到的是**本仓**那份 `dsh-tools`，于是一个进程里活着**两份模块实例**。今天两份同版所以没事；`defineTool` 是纯工厂也不在乎。**会出事的是依赖模块身份的东西（`instanceof`、模块级单例、Cordis `Service` 类身份）——课时 1.6 定义 `ctx.instrument` Service 时必须先验**。详见 `dsh/facts.md` §6-17 |
| **B10** | 开发态（`link:`）与安装态（npm/tarball）走两条不同解析路径 | **新开，Phase 0 结束前** | B7 引出的。发布路径上 profile 的 pnpm 会真的解析依赖、执行 peer 钉，只剩一份实例——和我们每天跑的**不是同一件事**。至少用 `pnpm pack` 出的 tarball 走一次安装态冒烟，否则重演 facts.md §1「npx 缓存是冻结快照」那个教训 |
| B8 | 差分测试要对 STM-Bench 做 ~60 行小改（`--trace`/truth 端点） | 未定（PLAN §16） | 退路 B：在线双跑 |
| B9 | ONNX 权重放哪（不入仓） | 未定（PLAN §16） | 建议 `E:\dsh-spm-models\` + manifest |

## 6. 每次开工前的三条自检

1. `npm view @deepseek-ai/dsh dist-tags --json` —— 与 `dsh/facts.md` 首行一致吗？
2. `git status` —— 上一段收干净了吗（不该有跨段的半成品）？
3. 这一段的验收命令是什么、我打算让你亲手跑哪一条？
