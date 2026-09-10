# dsh-spm 分段执行计划

> **这份文件是开工入口**。`PLAN.md` 回答「为什么这样设计」，本文回答「下一步做什么、做到哪算完、在哪停下」。
> 版本相关的事实在 `dsh/facts.md`，升级流程与日志在 `dsh/upgrades.md`。
> 建于 2026-09-07，随每段推进更新「当前位置」与「决策台账」两节。
> **2026-09-10：Phase 2–8 的分段计划一次写全**（§4–§10）。计划写在前面，执行仍然一段一停。

## 0. 怎么用这份文件

每一段（= 一个课时）固定五件事，缺一不算完：

| | 内容 |
|---|---|
| **① 查版** | `pnpm check:dsh-latest`。与 `dsh/facts.md` 首行不一致 ⇒ **先跑升级清单，再回来做本段**（D11）。升不升按判据不按版本号：`build` 过 + 全部测试绿 + 端到端探针，三样全过才升（D11.1）。**当前跟 alpha；出现第一个 client 包（1.10）或 compat 导出破 15 个符号后改跟 `latest`** |
| **② 写** | 一个文件或一个紧密相关的小模块，**≤200 行**。测试与代码同段写 |
| **③ 讲** | 做了什么 / 为什么这样写 / 涉及的 dsh·Cordis·TS 概念 / 与旧仓 Python 对应物的差别 / **你怎么亲手验证**（跑哪条命令、看什么输出）。末尾一行「本段术语表」 |
| **④ 验** | 你亲手跑一遍验收命令。绿了才继续 |
| **⑤ 停** | **停下等你**。不连写多段 |

**回滚单位 = 一段**。每段一个提交（中文首行 `feat(pkg): …` / `chore(dsh): …` / `docs: …`）；升级 dsh 永远是**独立提交**，不与领域代码混。
段内红了就在段内修；段的设计被推翻就整段 revert，不做「留一半」。

**红线**（任何一段都不许破）：真机 0 次直到 Phase 8；`profiles/mast-rig` 不入仓；除 `packages/host/compat/src/` 外任何文件不许出现 `from '@deepseek-ai/`；研究快照与旧仓内容不进本仓 git 历史。

---

## 1. 当前位置（2026-09-10）

进度：**0.1 ✅**（09-02 环境与 Windows 冒烟）· **0.1.5 ✅**（版本裁决：不升 0.1.3，锁留 `0.1.2-rc.1`；`LICENSE` 落盘）
· **0.2 ✅**（仓库骨架）· **0.3 ✅**（防腐层与版本锁）· **0.4 ✅**（总 bundle 与 `stm_hello`，真实 dsh 集成已验）
· **0.6 ✅**（spike：结清 1/2/3/5/7，半结清 6）· **0.7 ✅**（规格导出：515 技能 + SI 金样）。
**Phase 0 完成**（只差覆盖率门禁）。**0.5（设置卡）挪到 1.7、09-09 再挪到 1.10**——1.7 实测下来端口用一个
profile patch 就配完了，设置卡真正要拖进来的是 1.10 的 U0 无论如何都要建的那套客户端机器。
**Phase 1：1.1 ✅**（`si.ts` + 146 条金样）· **1.2 ✅**（帧层）· **1.2b ✅**（类型码表）。
**2026-09-09：dsh 升到 `0.1.5-alpha.1`；09-10 再升 `0.1.5-rc.1`**（1.3 开工查版触发；`fs-ext` 阻塞解除，零领域代码改动，232 条测试一次通过）。
**1.3 ✅**（协议代码生成）· **1.4 ✅**（`RoleLink`，对真 stmsim 验过）· **1.5 ✅**（熔断状态机）· **1.6 ✅**（`ctx.instrument` Cordis Service）
· **1.7 ✅**（`instrument-stmsim` provider + 集成测试自动起停模拟器；`instrument-fake` 按消融精神推迟到 Phase 2 有消费者时）
· **1.8 ✅**（`ctx.instrumentState` 1 Hz 缓存 + 金样 + D-STATE-1）· **1.8b ✅**（提示块 `stm-live-state` + `stm_get_state`；**结清 spike 第 2 条**；投影推迟到 1.10）。
· **1.9 ✅**（看门狗 + 急停 + `/estop`；金样把真 Python 循环的时间换掉让它自己跑）。
· **1.10 ◐**（SSE hub + 投影 + 结清 spike 9 完成；客户端半边受阻于 B12，见课时记录）。
**Phase 2：2.1 ✅**（安全金样：表 + 671 动词判定 + 原文逐字）· **2.2–2.5 ✅**（包络 / 物理荒谬 / `_is_read` 与中止安全写 / 五条硬闸 + 模式闸）。
**下一段 = 课时 2.6（sample gate 四表）。**

仓库现状：10 个工作区包（root / compat / kernel / nanonis-wire / instrument / instrument-stmsim / instrument-state / instrument-watchdog / **client/stm-ui** / bundle），
**508 条测试**（单测 + 契约 + 20 条对真 stmsim 的集成测试），`pnpm install --frozen-lockfile` / `pnpm build` / `pnpm test` 全绿。锁定 dsh **`0.1.5-rc.1`**。
golden 已入仓（515 技能 + 146 SI 用例 + 51 条线协议字节金样 + 50 步熔断轨迹 + 状态缓存 29 步 trace，重跑逐字节相同）；
Nanonis 协议表已拷入 `spec/nanonis/`，671 个方法的门面由 `pnpm gen:nanonis` 生成、CI 校验无 diff。

**覆盖率门禁**现在才算有对象（kernel 要求逐文件 100%，PLAN §6.3），但等 1.2–1.5 把 kernel 填到有分支
可覆盖时一起落——此刻 kernel 只有 `si.ts`，而它已被 146 条金样打满。spike 剩下五条各有触发点（见 `dsh/spike.md`）。

2026-09-07 的一次性整理：确立 git 路径；研究快照八份移出到
`<PRIVATE_REVIEW_ARCHIVE>\01-dsh-spm\研究快照-2026-09-01\`；补 `.gitignore` / `.gitattributes`；本文件新建。

### ~~阻塞：dsh 0.1.3-alpha.2 装不上本机~~ ✅ 2026-09-09 解除（留档）

> **0.1.5-alpha.1 把 `fs-ext` 换成了自家的 `node-addon-system`，Windows 上装得上也跑得起来，已升级。**
> 经过与已知问题见 `dsh/upgrades.md` 的 09-09 日志与 `dsh/facts.md` §8.0。下面是当时的判断留档——
> 它记录的推理（为什么不肯为一台机器装 C++ 工具链）仍然有效。

原始记录（2026-09-07 实测）：

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

## 2. Phase 0 · 脚手架 ✅ 完成

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

### ~~课时 0.5 —— 第一张设置卡 `mast.instrument`~~ → 挪到 1.7 → **再挪到 1.10**（2026-09-09 决定）

> **2026-09-09（1.7 做完时）复议**：原来的推迟理由「配置的是不存在的东西」已经不成立——
> 仪器服务和端口配置现在都真的存在了。但**另一半理由更硬了**：1.7 实测下来，端口是由
> `profiles/mast-sim/cordis.patch.yml` 配的，一个 YAML 文件就够；设置卡要拖进的是**一整套
> 客户端机器**（tsdown、React、client bundle），而那套机器 1.10 的 U0 无论如何都要建。
> 现在建 = 建两次，或者建一次然后闲置三个课时。**跟 U0 合并到 1.10。**
> 顺带：`dsh/facts.md` 记的上游 Discussion #5999（升级既有 profile 后 client combo 缺新增
> 模块 ⇒ 全部 client 插件失效）本来就钉在 1.10，两件事撞在一起做正好。

原始理由（2026-09-08）：

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

### 课时 0.7 —— 规格导出第一版 ✅ 完成（2026-09-08）

`tools/spec-export/export_mast_spec.py`（Python，只读旧仓，用旧仓 venv 的绝对路径跑——本机 PATH 里的
`python` 是 Microsoft Store 转发桩）导出 `spec/golden/`：**skills.json 515 条**技能作者声明契约、
**si_cases.json 127 条** SI 行为金样、`manifest.json` 记每个 collector 的成败。

三件已验的事：

1. **只读旧仓**：跑完 `find MAST -newermt '-10 minutes'` 扫全仓返回空，一个字节没动。隔离靠导出前把
   `MAST2_PROJECT_ROOT` 指向临时目录——旧仓的 config / data_paths / override_store / **models（API key
   目录解析）** 都认它。运行中确实触发了一次「管理员覆写迁移」，但那是**从旧仓复制到沙箱**（两边 mtime 相同）。
2. **重跑逐字节相同**（已验两次）。所以「旧仓变了没有」可以用 `git diff` 回答；manifest 因此不记随机沙箱路径。
3. **分母已经漂了**：PLAN §5 记的 09-01 普查是 498，今天导出 **515**（七天多 17 个）。DANGEROUS 仍恰好 10、
   WRITE 仍恰好 243，其余都动了。旧仓还在给真机发版，**它会一直长**。⇒ PLAN §5 不再记数字，改指 golden。

**用 `_get_metadata_raw` 不是 `_get_metadata`**：前者是技能作者的声明，后者叠加了 admin 覆盖。旧仓自己的
注释讲得最清楚——拿叠加后的当基线，一个「调低某技能 safety_level」的管理员覆盖就会变成新标尺，**把审批闸门洗白**。

**报错原文也进金样**：`si_cases.json` 录了异常类型与完整消息，因为模型读到的正是这些句子（§3.2-1、§3.2-16）。
已经发现 strict 与 loose 对同一个非法输入给的是**两句不同的教学文案**——照行为写 TS 能过，照措辞写才对得上。

按消融原则只导两样，其余（tool_schemas / preconditions / safety / verbs / error_branches / traces …）
等各自消费者出现再加，理由与时机写在 `spec/golden/README.md`。

---

### 课时 1.1 —— `si.ts` 逐字移植 ✅ 完成（2026-09-08）

`packages/host/kernel/`（零 dsh、零 I/O）落 `si.ts`：`SI_PREFIXES` / `parseSi` / `needsStrictPrefix` /
`parseQuantity` / `formatSi`。测试**不手写期望值**，直接跑 `spec/golden/si_cases.json` 的 **146 条**
（本段把网格从 127 扩到 146，补了 `format_si` 的兜底分支与 `inf`/`nan`/`1_000`/`0x10`）。

**按消融原则只做了 `si.ts`。** 课时表原本还写了 `SkillSpec` / `HardwareState` / `SkillResult` /
`OperatingMode` 四组类型——它们此刻一个消费者都没有（技能在 Phase 2、`HardwareState` 在 1.8），
而旧仓还在长（0.7 已证七天多 17 个技能）。没有消费者的类型只会先于用途漂掉，golden 随时能重导。

**四次变红演练**（只会变绿的检查等于没有检查）：

| 演练 | 结果 |
|---|---|
| 正则加 `/i`（大小写不敏感） | 3 条红（`'3P'` 该拒绝、`m`/`M` 差九个数量级） |
| `formatSi` 位数 6 → 4 | 1 条红（`format_si(123456.0)`）——印证旧仓「五位都不够」的注释 |
| 去掉数字正则，裸 `Number(s)` | **只有 `'0x10'` 红** |
| （前两次我用 sed 写演练，替换根本没生效，"通过"什么也没证明——含反斜杠/引号的替换一律改用编辑工具） |

第三次演练改写了结论：`'inf'`/`'nan'`/`'1_000'` 的拒绝是 **JS 语义白送的**（`Number()` 对这三个
本来就返回 `NaN`），不是那条正则挡的；正则真正在承担的是 `Number('0x10') === 16` 这类 JS 认而
Python 不认的写法。`spec/deviations.md` 按这个真实机制写，没停在"我以为我实现了防线"。

**新建 `spec/deviations.md`**（PLAN §12：未登记的差异 = 缺陷）。四条，每条带测试名。最重要的一条
D-SI-1：TS 拒绝 `inf`/`nan`，因为 **NaN 会穿过包络检查**——所有与 NaN 的比较都是 false，
`nan > max` 为假、`nan < min` 也为假，一个"已检查过范围"的参数就这样带着 NaN 到了仪器。
偏差在测试里是**断言**不是跳过：`DEVIATIONS` 表逐条声明期望，TS 的行为同样被钉住。

**顺手修掉导出脚本一个真 bug**：`parse_quantity_loose('-inf')` 让 Python 的 `json.dumps` 写出了裸
`-Infinity`，**那不是合法 JSON**，Node 直接拒收——金样一度是坏数据。修法是非有限值显式记成
`{"ok": true, "nonfinite": "inf"}`，并加 `allow_nan=False` 让这类问题以后当场报错而不是静默产出。

### 课时 1.2 —— `nanonis-wire` 帧层 ✅ 完成（2026-09-08）；类型码表拆到 **1.2b**

`packages/instrument/nanonis-wire/`（零 dsh、零 I/O）落 `frame.ts`：成帧、拆帧、错误段、回声校验、
`NeedModule` 判定。字节金样 `spec/golden/wire_frames.json` 由 `tools/spec-export/export_wire_fixtures.py`
调 **STM-Bench 的真实 codec** 产出（不手造字节——手造的只能证明「我以为帧长这样」）。186 条测试。

**为什么把原计划的 1.2 拆成两段**：原本一段要做「帧头 + 类型码表 + 错误段 + NeedModule」。量了一下
671 个方法真正用到的类型码（`i` 266 / `f` 240 / `H` 205 / `I` 128 / `+*c` 51 / … 共 14 种请求侧、21 种回复侧，
只有 `-*X` 零使用），完整的编解码表约 150 行，加帧层与测试超过 400 行——**远超一段 ≤200 行的约定**。
帧层与类型码表之间是**真实接缝**：帧层完全不认识类型，1.4 的 TCP 客户端只需要帧层。所以：
**1.2 = 帧层（本段）· 1.2b = 类型码表**（1.3 的代码生成消费它）。

协议事实（`STM-Bench/stmsim/wire/codec.py` 的 docstring 是权威）：

```
请求：name 补零到 32 B │ uint32 body_size │ uint16 send_response_back │ 2 B 零 │ body
回复：name 32 B（逐字回声）        │ uint32 body_size │ 4 B 零              │ body
错误段（永远在 body 末尾）：[int32 status][int32 desc_len][desc]
```

三条判据来自旧仓血泪，都钉成了测试：

1. **长度恒等式 `len(body) === 8 + desc_len`** 区分「仪器拒绝」与「我们把返回字段声明错了」。
   不用它的话，一个声明多了字段的方法会把自己的解码失败误报成仪器错误，然后我们去查一台没问题的仪器。
2. **回声必须逐字节相同**。不匹配意味着**流已经失步**——我们正在把别的命令的回复当成这一个的。
   唯一安全的处置是断链重连，绝不是返回 `[]`（PLAN §3.2-9）。
3. **`NeedModule` 子串 = 模块没加载**，不是线路故障。两者处置完全相反：模块没加载重连一百次也没用，
   该告诉操作员去 Nanonis 里打开它；线路故障才该重连并计入熔断。

**金样立刻照出上游两个潜在 bug**（登记为 D-WIRE-1/2）：命令名 40 字符时 `ljust(32)` 不截断，帧变成
48 字节、多出的 8 个字符盖住 size 与 flag；名字含非 ASCII 时 `ljust` 按**字符**补齐再编码，
`Ünicode.Verb` 的名字段变成 33 字节、整帧错位 1。真实动词全是短 ASCII 所以从没发作。
TS 不复刻这两个 bug——**错位的帧会让整条 TCP 流失步**，比拒绝一次调用糟得多。

由此得到一条测试写法上的教训：逐字节对齐那组的过滤条件必须是「**金样本身是良构帧**」而不是
「名字放得下」。按后者过滤，那条 41 字节的错位帧会被当成期望值，我们就会主动实现一个错位的成帧器。
第一版我正是这么写的，测试当场红了才发现。

**变红演练**：`body_size` 改成小端 ⇒ 2 条红（空 body 的用例发现不了，因为 0 的大小端相同——
这本身说明金样里必须有非空 body 的用例）。

### 课时 1.2b —— Nanonis 类型码表 ✅ 完成（2026-09-08）

`nanonis-wire/src/types.ts`：请求参数编码 + 回复字段解码。232 条测试。

**金样来自两个独立真源**，不是我手写的镜像：请求侧字节由**真实客户端** `nanonis_spm`
（经 MAST 的 `nanonis_patch.py` 打补丁——就是跟真机说话的那份代码）产出；回复侧由 STM-Bench
的服务端 codec 产出。`Nanonis(connection)` 只存引用，传 `None` 就能离线驱动 `handle*`，不碰 socket。

**计数来源三分**（必须顺序解码，因为计数由已读字段决定）：

| 形状 | 计数来自 |
|---|---|
| `*X` `-*X` `*+X` `*-c` `*+c` | **前一个**（`*+c`/`2X`/`*2c` 是前两个）int 字段 |
| `**X` `**c` | **第一个**字段（`Variables[0]`），哪怕中间隔着别的 |
| `+*X` `+*c` | 自带计数，不看任何别的字段 |

**`c` 的二义**：同一个格式串，`str` 与数组产出**完全不同**的字节——客户端是按 Python 类型选的编码，
格式串本身不说是哪种。`str` → `int32 len + bytes`；数组 → `int32 4n, int32 n, n×(int32 len + bytes)`。
这正是 `STM-Bench/stmsim/wire/spec.py` 的 `array_string_args` 存在的理由，1.3 的代码生成要一并读它。

**请求侧的 `2X` 自带 rows/cols，回复侧它们是两个独立声明字段**——同一个码两侧不对称，实测得到的，
文档里没写。

**我自己踩的一个坑**：第一版给 `*+c` 的前置字段手填了个 7。查 `fill_counts` 才知道那两个字段是
**(总字节数含 4 字节长度前缀, 个数)**，正确值是 12——而**客户端解码时按那个字段前进**，填错就是流失步。
改成一律传 `None` 让 `fill_counts` 算（它的 docstring 明说就是为此存在："so module code never
hand-computes byte totals"）。教训：金样里凡是"由别的字段推导出来的值"，都不该手填。

**新增偏差 D-WIRE-3**：客户端读 `*X` 数组时**步长固定 4**（`d` 除外为 8），与元素实际大小无关。
用 `*H` 的方法会被按 4 字节跨过 2 字节的元素，**整个数组错位，而且每个值都是"合法的数"**。
671 个方法里没有一个用 `*H`/`*h`/`*b`/`*B`，所以永远不触发——正因为不触发，静默复刻它是零收益全风险。
我们直接抛，把"跟客户端还是跟仪器"这个问题留在原地，不替未来的人做错决定。

**变红演练**：`*+c` 的计数来源改成前两个字段 ⇒ 1 条红。

### 课时 1.3 —— 协议代码生成 ✅ 完成（2026-09-09）

`scripts/gen-nanonis.ts`（172 行手写）从 `spec/nanonis/nanonis_commands.json` 生成
`nanonis-wire/src/generated/methods.ts`（**1391 行，671 个方法**）：规格表 `NANONIS_METHODS`、
类型化门面 `NanonisFacade`、`createFacade(call)`。240 条测试。

**协议表拷进了 `spec/nanonis/`**（PLAN §6.2 本来就这么规定）。理由不只是自足：生成器要在 CI 上跑
「重生成无 diff」，而 CI 上没有 STM-Bench；拷进来还让「协议表变了」成为本仓的一次 diff，
而不是别人机器上的一次静默变化。来源与四条读表须知写在 `spec/nanonis/README.md`。

**读这张表踩到的三个坑**（都写进那份 README 了）：

1. **`params` 不可信，用 `args`**。`Osci1T_TrigGet` 声明 6 个 params 但只有 4 个 args；
   `Osci2T_ChsSet` 的 params 整个是 `undefined`。STM-Bench 自己的 `wire/spec.py` 也完全不读 params。
2. **两个 alias**（`Osci2T_ChGet`/`ChSet`）的 `args`/`returns`/`command` 全是 `null`，必须先解引用。
3. **`c` 的二义不在表里**。消歧表硬编码在 STM-Bench 的 `wire/spec.py::ARRAY_STRING_ARGS`，只有两条，
   键是 wire 命令名、值是**参数下标**。`Scan.PropsSet` 三个参数格式串都是 `+*c`，只有下标 5
   （`Modules_names`）是字符串数组，3/4（`Series_name`/`Comment`）是普通字符串。生成器里有一份副本，**改了要两边一起改**。

**本段最有价值的一条来自一次失败的变红演练。**

演练 1（手改生成物）⇒ 红，符合预期。
**演练 2（把消歧表下标 5 改成 4）⇒ 全绿。** 我的测试没能抓住它。

原因：消歧只改变生成的 **TS 类型**（`Comment: string[]` 而 `Modules_names: string`），
`args` 的名字、格式串、编码路径一个都没变——**运行期结构完全一样，vitest 看不见**。
而写错的后果很实在：调用方给 `Comment` 传数组，编出的字节完全不同，服务端解出垃圾。

修法是把断言放到**类型层**，让 `tsc -b` 来抓：

```ts
type PropsSetIsDisambiguated =
  NanonisFacade['Scan_PropsSet'] extends
    (…, series: string, comment: string, modules: string[], …) => Promise<[]> ? true : never
const _propsSetShape: PropsSetIsDisambiguated = true
```

重做演练 2 ⇒ `error TS2322: Type 'true' is not assignable to type 'never'`。

**一般化的教训**：凡是「只体现在类型上、运行期看不出差别」的事实（消歧、单位、可空性、字面量联合），
运行期测试天然抓不住，必须写成类型层断言。这类断言只在 `pnpm build` 里红，**所以验收命令必须包含 build，
光跑 test 是不够的**——这也是为什么每段的验收一直是 install/build/test 三条而不是一条。

**Result 包装留给上层**：生成的 `NanonisCall` 只声明「命令 + 参数 + 返回格式 → `Promise<unknown[]>`」，
**不规定失败怎么表达**。抛还是包成 `Result`（PLAN §7.1 的「不抛」约定）是传输层（1.4）与仪器服务（1.6）的策略，
生成层只负责把类型对上。TS 没有高阶类型，硬要在生成层泛化返回包装只会把 671 个签名弄得没法读。

### 课时 1.4 —— `RoleLink` TCP 客户端 ✅ 完成（2026-09-09）

`nanonis-wire/src/role-link.ts`（193 行）：一个角色一条连接，单往返、有界等待、优雅关闭。
251 条单测 + **4 条对真 stmsim 的集成测试**。`integration` project 本段加回（0.2 时按消融删掉，说好 1.4 才加）。

**动手前先拿已有的编解码打了一次真往返**：起 stmsim（215 个已实现动词），用 1.2 的成帧器发 `Bias.Get`、
1.2b 的类型码表解回复 ⇒ 回声名逐字相符、读出 `0.1 V`、错误段 status 0。
**先证明底下两层对，再往上盖**——不然 1.4 出问题时分不清是谁的错。

**三条硬约束，全部来自旧仓真机事故（PLAN §3.2-9），逐条钉成测试**：

| 约束 | 为什么不能「宽容处理」 |
|---|---|
| **回声不符 ⇒ 断链** | 不符意味着**流已失步**——我们正在把别人的回复当成这一条的。返回 `[]` 只会让错误往下游跑 |
| **对端先关 ⇒ `EmptyReply` 断链** | 这不是「这次没数据」，是链路没了 |
| **永不 `destroy()` 在途请求** | 强杀会**永久损坏 Nanonis 端口**，要手工重启仪器才能恢复。只 `end()` 发 FIN；`close()` 先有界等在途那次做完 |

**「有界等待、不排队」是这段最需要解释的设计。** 第二个调用等不到连接就返回 `RoleBusy:`，
而不是排在后面——因为在仪器控制里**「现在做不了」是个正常答案，「十分钟后才做」不是**。
排队会让一次卡住的调用把后面所有调用一起拖死，而且拖死的方式是静默的（大家都在 await）。
默认等 30 s；急停走 2 s、关闭走 5 s（PLAN §7.1）。

实现上是 `while (inFlight !== null)` 配 deadline，**不是 `if`**：醒来后可能被别的等待者抢先。
变红演练把它改成无限排队 ⇒ 那条测试红（2012ms 才失败，正是「一直等下去」的形状）。

**错误一律带机器可判前缀**（`RoleBusy:` / `Timeout:` / `EmptyReply:` / `WrongEcho:` / `NotConnected:` /
`SocketError:`）并在 `kind` 字段上再给一份。上层按 `kind` 分流，**不解析文案**（§3.2-16：判据不落在文案上）——
1.5 的熔断要按这个分：`Timeout`/`EmptyReply`/`WrongEcho`/`SocketError` 计入 TCP 级失败，
而仪器自己回的错误段（模块没加载、动词没实现）**不计入**。

**集成测试默认跳过，需要 `STMSIM_PORT`**，且跳过时打印原因——不是静默跳过。
课时 1.7 的 `instrument-stmsim` provider 会把「起停模拟器」做成 globalSetup，那时改成无条件跑；
在那之前不重复造 spawn 逻辑。本段手工跑过，4 条全绿：

- `Bias.Get` 读到物理上说得通的值（|V| ≤ 10，安全包络上限）
- **类型化门面走通全链**：`typed.Bias_Set(0.25)` → `typed.Bias_Get()` 读回 0.25（float32 往返，`toBeCloseTo`）
- 优雅关闭后**端口立刻可复用**
- 模拟器没实现的动词回的是**错误段而非断链**，连接还活着——这条直接决定 1.5 的熔断怎么记账

### 课时 1.5 —— 通信熔断状态机 ✅ 完成（2026-09-09）

`kernel/src/comms-breaker.ts`（162 行）：注入时钟的纯状态机，零 I/O、零 dsh，**四个角色共用一个实例**。
270 条单测。放 kernel 不放 nanonis-wire——它是判据不是传输（PLAN §6.1-2）。

**为什么存在**（旧仓 docstring 里的现场记录，trace 5305868e s82–130）：链路断掉时每次硬件读写**各自**
超时 5 秒才放弃。那次追踪里 GetBias → GetCurrent → GetZPosition → SetBias → ZControllerOnOff 逐个抛
`TimeoutError`——**十九次各约 5 秒的停顿**，约 90 秒里操作员只能看着系统对着一个死 socket 磕头。
更糟的是反复强连重连会**把脆弱的 Nanonis 端口撞到要重启 Nanonis 才能恢复**。

熔断器**自己从不发命令**，只决定「一次调用能不能被尝试」。链路死了的时候快速失败严格优于每条挂 5 秒
——停机/退针命令本来也到不了一台不答 TCP 的 Nanonis。

**参数**：3 次连续失败开闸 · 20 秒冷却 · 30 秒连击窗口（超窗的旧失败不算「连续」，慢速滴漏永远不触发）。
**状态是推导的不是存的**——存一份就多一处可能与 `streak`/`openUntil` 不一致。

**只观察 TCP 级失败**。`recordSuccess` 的含义是「一次往返完成了」，**哪怕 Nanonis 回的是应用错误串**：
那说明链路是好的，只是仪器说「这个模块没加载」。1.4 的集成测试已经把这条证实过——
调 stmsim 没实现的动词，回的是错误段而**连接还活着**。所以 1.6 接线时按 `RoleLinkError.kind` 分流：
`Timeout`/`EmptyReply`/`WrongEcho`/`SocketError` 记失败，仪器自己的错误段记**成功**。

**测试分两层，第二层是本段的关键**：

1. **旧仓 7 条 pytest 断言原样移植**（PLAN §12），同名同顺序，好逐条对。那份文件后半 4 条是
   `ConnectionPool.safe_call` 接线，属于 1.6。
2. **金样逐步比对**（`tools/spec-export/export_breaker_trace.py`）：驱动**旧仓真实实现**跑 6 条脚本
   共 50 步，每步录 `allow()` 结果与完整快照，TS 跑同一条脚本逐步对。

第二层为什么必要：**那 7 条是我手抄的，抄错了没人知道**；而且它们覆盖不到两个差一个等号的边界。
金样把边界钉死了：

- 连击窗口 **恰好 30 秒仍算连续**（`30 > 30` 为假）；60.000001 才重起
- 冷却 **恰好 20 秒已是 HALF_OPEN**（`>=` 不是 `>`）

顺带照出一个不显然的细节：t=19.999 时状态还是 OPEN，但快照里的 `cooldownRemainingS` 四舍五入成 **0**
——读快照的人不能拿它判断是否熔断，要看 `state`。

**变红演练**：把连击窗口的 `>` 改成 `>=` ⇒ 1 条红；把冷却的 `>=` 改成 `>` ⇒ **4 条红**。
两个都是单字符改动，两个都被抓住。

### 课时 1.6 —— `ctx.instrument` Cordis Service ✅ 完成（2026-09-09）

新包 `packages/instrument/instrument`（243 行）：四角色连接池 + **一个共用**熔断器 + 类型化门面。
本文件只做**接线**——1.4 的 `RoleLink`、1.5 的熔断、1.3 的门面各司其职。283 条测试。
看门狗与急停在 1.9，stmsim/fake provider 在 1.7（所以本段**没有**把服务接进 bundle）。

#### 前置：`facts.md` §6-17 那条警告到期了，实测**不成立**

开发态 `link:` 下我们与 dsh 各持一份 cordis 模块实例，本来担心 Cordis `Service` 的类身份会被咬到。
探针（临时给 compat 导出 `Service`、在 bundle 里定义一个 `ProbeService`、装进真 0.1.5 profile 启动）：
`ctx.plugin` 不抛 · `ctx.inject` 拿得到并能调方法 · `instanceof` 为真 · 进程正常存活。

**真实原因是读源码查出来的，不是我最初猜的那个**：① 服务注册表按**字符串名**索引；
② **Cordis 自己重写了 `static [Symbol.hasInstance]`**，`instanceof` 走它的自定义判定，本来就不比较类对象。
仍要小心的是相反方向：拿 **dsh 构造的**对象去 `instanceof` **我们这份**类。目前没有这种用法，将来要判类型用 duck typing。

#### 接线时踩到的三件事，每件都是测试先红

1. **仪器拒绝的回复里没有返回字段**。我原来无条件 `decodeReturns(body, returns)`，而被拒绝的 body
   **只有错误段**——那样会把错误段的头 4 个字节当成一个 float 读走。
   1.2 建的长度恒等式正是为这个而存在，却没接对。修法：新增 `errorOnlyBody(body): ErrorSection | null`
   （不抛，「是不是」是个问题不是异常），**先问它再解返回字段**。
2. **`ctx.someService` 拿到的是按上下文包的代理，不是原实例**。第一版断言写的 `toBe(svc)`，
   测试**超时 5 秒才失败**，看着像「服务根本没挂上」。正确的判法是断行为（`name`/方法可调），不是引用相等。
3. **`declare module '@deepseek-ai/cordis'` 触发了防腐层边界测试**。它是类型层增补、不产生任何运行时
   import，而那条规则防的是**运行时耦合散落各处** ⇒ 在边界测试里写明这个区分，并给 instrument 包
   加 cordis 的 peer/dev 依赖（只为让 TS 解析得到被增补的模块）。

#### 熔断记账的三条规则（本段真正的判据）

| 情形 | 记什么 | 为什么 |
|---|---|---|
| 仪器回错误段（`NeedModule` 等） | **成功** | 一次完整往返 = 链路是好的（1.5 的 app-error 规则，1.4 已在真 stmsim 上证实过这个形状） |
| `RoleBusy` | **不记** | 「现在有人在用」不是链路坏了。记了的话**一次并发争抢就能熔断整条链路** |
| `Timeout` / `EmptyReply` / `WrongEcho` / `SocketError` | 失败 | 真正的 TCP 级故障 |

另外 `countHealth: false`（1 Hz 状态缓存、20 Hz 示波器这类高频只读）整个不进记账。

**急停 `urgentCall` 绕过熔断**：走 `emergency` 角色、只等 2 秒锁。熔断的意义是别对着死链路磕头，
但退针值得**试一次**——试一次的代价是 5 秒，不试的代价是针还扎在样品上。

**变红演练**：让 `RoleBusy` 也记熔断 ⇒ 1 条红。另外第 1 条（error-only）本身就是测试先红逼出来的。

---

### 课时 1.7 —— `instrument-stmsim` provider ✅ 完成（2026-09-09）

新包 `packages/instrument/instrument-stmsim`：`StmsimProcess`（spawn `python -m stmsim serve`、
等四个端口真能连上、SIGTERM 收尾）+ `stmsimProvider` 插件对象（起模拟器并提供 `simulated: true`
的 `ctx.instrument`）。296 条测试。

**stmsim 是靶不是产品**（PLAN §14），所以本包只管生命周期，不移植任何模拟逻辑。
本机实测：spawn 到四端口就绪约 **3.4 秒** ⇒ 默认等 30 秒；`kill` 后端口立刻释放。
解释器路径**必须显式给**（构造参数 > `STMSIM_PYTHON` > 抛错），不做「猜一个」的兜底——
本机 PATH 上的 `python` 是 Microsoft Store 转发桩，猜错的表现是一个语焉不详的 spawn 失败。

#### 顺手还掉 1.4 欠的账：集成测试不再「默认跳过」

`vitest.stmsim-setup.ts` 作 `integration` project 的 globalSetup，整组测试前起一份（16501–16504，
`--approached` 起手就在隧道状态），跑完停掉。1.4–1.6 那种「没设 `STMSIM_PORT` 就整组 skip」删掉了：
**跳过的测试等于没有的测试**。仍可不跑，但要**显式**——两个环境变量没给时 globalSetup **抛错并说清怎么配**。

#### 三个坑，都是「静默地成功」

1. **`spawn` 失败走 `'error'` 事件，不是 `'exit'`**。只接了 `exit` 的话，一个配错的解释器路径
   就是**未捕获异常，直接打挂整轮 vitest**。写测试时真踩到。
2. **根 `Context` 上没有公开的 `stop`/`dispose`**——第一版卸载测试写 `ctx.stop()`，`TypeError`。
   **生命周期的粒度是插件，不是上下文**：`ctx.plugin(stmsimProvider, cfg)` 装、
   `ctx.registry.delete(stmsimProvider)` 卸，`apply` 里 `ctx.effect` 登记的回滚随之自动跑。
   为此把 `apply` 之外再导出一个插件对象 `stmsimProvider = { name, apply }`。
   disposer 直接把 `sim.stop()` 的 Promise 交回去，cordis 会等它——「卸载完成」才真的意味着进程已退。
3. **就绪探测分不清连上的是不是自己的孩子**。上一条测试的 `apply` 内部起了一份模拟器却没人停
   （cleanup 停的是个从没 `start` 过的空壳），泄漏下来占着端口；下一条 `start()` 于是**秒返回**，
   `stop()` 停的是刚因端口占用而死掉的子进程，症状是「卸载后端口还在」，查了半天。
   两处修：① `start()` 前**先查端口有没有人监听**，有就报一句清楚的话；
   ② 测试的收尾一律走**卸载**，并把「等端口释放」收进 `afterEach`——共用一组端口而释放是异步的，
   逐条去记就等于埋顺序依赖。

#### ④验：`profiles/mast-sim` 真的把模拟器拉起来了

新增 `profiles/mast-sim/cordis.patch.yml`（本段第一份 profile patch）。分工照 PLAN §6.1：
**bundle 的 patch 放与 profile 无关的行**，**profile 的 patch 放「接哪台仪器」**——这正是
sim / offline / rig 三者唯一的区别。解释器与 STM-Bench 路径**不写进仓库**（每台机器不同，
写了就是一份注定过期的配置），走 `STMSIM_PYTHON` / `STMSIM_ROOT`。

为此 bundle 多了一个子路径导出 `dsh-spm/instrument-stmsim`：profile 的 `node_modules` 里
**只有 `dsh-spm` 一个包**，而加载器是拿 `name` 直接做动态 import 的 ⇒ 内部包必须经由 bundle
的子路径才寻址得到。「bundle 是安装单位、profile 是组合单位」第一次落到文件层面。

隔离 `DSH_HOME` 里实测（没碰你的 `~/.dsh`）：`dsh plugin --profile mast-sim add <本仓 bundle>`
建出 profile（自动带 `dsh-base` + `dsh-spm`）；`--dump-config` 347 行，末尾是我们那两行
（`mast-hello` 来自 bundle patch、`mast-instrument-stmsim` 来自 profile patch，层叠次序对）；
`dsh --profile mast-sim` 启动后 **17 秒**四个端口全部 LISTENING 且同属一个 python 进程，
dsh 一停端口全部释放。**端口起来了就是 `apply()` 真跑过了**——0.4 那条教训（`inject` 不满足时
Cordis 静默不装载，只看「启动没报错」是假绿）在这里有了不会说谎的证据。

**变红演练 ×2**：摘掉 `ctx.effect` 的回滚 ⇒「插件卸载后模拟器跟着停」红（端口 5 秒后仍在）；
把端口占用检查的阈值改掉 ⇒「端口已经有人监听」红，报的正是 `promise resolved "undefined" instead of
rejecting`——**静默地成功**，本段这三个坑共同的形状。

`instrument-fake` **没做**：它此刻一个消费者都没有（要等 Phase 2 的技能测试），有 stmsim 就够了。
按消融精神留到真需要时再写。

**新开 B11**：集成测试现在**必须**有真 stmsim，而 stmsim 在 STM-Bench 里、那个仓库没有远端 ⇒
CI 拉不到，`ci.yml` 暂时只跑 `--project unit --project contract`。写清楚比让 CI 挂着一条注定失败的
步骤好：**「CI 绿」从这一段起不再等于「对着真模拟器绿」**，这个差别得有人记着。

---

### 课时 1.8 —— `ctx.instrumentState` 1 Hz 状态缓存 ✅ 完成（2026-09-09）

新包 `packages/instrument/instrument-state`：`cache.ts`（纯逻辑，零 I/O）+ `plugin.ts`（Cordis Service
与 1 Hz 循环）；kernel 补上 `HardwareState` 与 `scalarFloat`（1.1 按消融精神推迟的那组类型，现在有消费者了）。
**342 条测试**。`stm_get_state` / 提示段 / 投影拆到 **1.8b**——那三条是「怎么把状态送进模型」，
与「缓存本身对不对」是两件事，混在一段里两边都讲不清。

#### 金样第一次驱动**真 Python 对象**跑序列

`tools/spec-export/export_state_spec.py` 拿一个假 pool 喂真 `InstrumentState`，录三节：
`spec`（**动词序列是观测出来的**，不是手抄——11 个读、`FolMe_XYPosGet(0)`、`LockIn_ModOnOffGet(1)`、
全在 monitor 角色）、`coerce`（21 条「什么算一个读数」）、`trace`（14 条脚本 29 步）。

为什么非要 trace 不可：**carry-forward 与 stale 只在序列里显形**。单点断言看不出「上一次的真值
被这一次的读不到覆盖了没有」，而那正是 2026-06-29 真机死循环的形状——写回刚设的
`z_controller_on=true` 被下一个 tick 抹回 unknown，`StartScan` 的前置条件永远不满足。

#### 一条 deviation：**D-STATE-1，读与写用同一把尺子**

金样把一件事跑了出来：Python 的 `refresh()` 每个字段是**裸 `float(parsed[0])`**，而同一个缓存的另一个
入口 `apply_patch()` 走 `scalar_float`。于是同一个值从两条路进同一个缓存，结果不同：

| 输入 | Python refresh | Python apply_patch | 我们（两条路都走 `scalarFloat`） |
|---|---|---|---|
| `"1.5"` | 收下 → 1.5 | 拒 | 拒 |
| `NaN` | **收下，还进历史环** | 拒 | 拒 |
| `[1.5, 2.5]` | **抛 TypeError** | 拒 | 那一个字段 null，其余十个照常 |

第三行是最重的：`self._cache = state` 在 `refresh()` 最后一行，抛在它之前 ⇒ **十一个读全部作废，
而且 `stale` 不亮**。`stale` 这一位存在的全部理由就是「别把陈值当活值」，这条路径正好绕开了它。
Python 自己的 `coerce_number` docstring 写着「逐处打补丁只会制造第八份实现」——它把判据收拢到了
`scalar_float`，只是没把读的那侧接上去。详见 `spec/deviations.md`。

#### 字段名保持 Python 的蛇形

`bias_v` 而不是 `biasV`。不是懒：`applyPatch` 吃的是**技能结果的 `data` 字典**，键名由 515 个待移植
技能给出，是契约的一部分；改成驼峰等于给每个技能加一次翻译，**515 次犯错机会**换一个大小写习惯。

#### 变红演练四次，两次「没红」比红的更有用

| 演练 | 结果 |
|---|---|
| 拆掉 carry-forward | ✅ 3 条红 |
| 拆掉「stale 时保留旧时间戳」 | ❌ **全绿**——注入的时钟恒返回 `T0`，两种行为在测试里长得一样。stale 有两半，我只测了一半。改成单调时钟并断言金样的 `timestamp_carried` 之后，重做 ⇒ 1 条红 |
| 让 1 Hz 轮询进熔断记账 | ✅ 1 条红 |
| 拆掉卸载停机闩 | ❌ **全绿**——`clearTimeout` 单独就挡住了「两次 tick 之间卸载」。而闩防的是**卸载落在一轮刷新中间**（真机 11 个串行往返，这几乎是常态）。探针实测：上下文失活后 `ctx.instrument` **会抛** `cannot get required service "instrument" in inactive context` ⇒ 那是个**没人接的 Promise rejection**，默认会打挂进程。改成测试直接盯 `unhandledRejection` 之后，重做 ⇒ 1 条红，报的正是那句 |

第四条顺带推翻了我自己写在代码注释里的理由（「refresh 永不抛，所以这里不用 try/catch」）——
前提是错的：`refresh` 不抛，但**读的那一侧会**。修法不是在循环外面包 try/catch（那会把「读不到」
和「代码写错了」一起吞掉），而是读之前先看停机闩：「正在卸载」本来就该表达成「这一读没落地」，
而缓存对没落地早有说法。

#### ④验：真 stmsim + 真 dsh

- 3 条集成测试对着 globalSetup 起的真模拟器：11 个读都有回音、值物理上说得通、`z_controller_status`
  落在六态之内、后台循环自己在跑（历史环在长）。
- bundle 加子路径导出 `dsh-spm/instrument-state` 与 patch 行 `mast-instrument-state`（**归 bundle 不归
  profile**：sim/offline/rig 都要它，「接哪台仪器」才是 profile 的事），`inject: ['instrument']` 逐行写全。
- 隔离 `DSH_HOME` 实测：`--dump-config` 347→351 行，多出来的正好是我们那 4 行，且落在 bundle 层
  （在 profile patch 之前）；`dsh --profile mast-sim` 启动 **5 秒**后，dsh 进程对 **127.0.0.1:16502**
  （monitor 角色）有一条 ESTABLISHED 连接——**那个端口只有我们的 1 Hz 缓存会去连**，这是它真在跑的证据。

---

### 课时 1.8b —— 把状态送进模型 ✅ 完成（2026-09-09）

`live-state.ts`（提示块，逐字移植 `live_state_mw.py:format_live_state_block`）+ `stm_get_state` 工具，
两条都挂在 `mast-instrument-state` 这一行上。**356 条测试**。顺带结清 **spike 第 2 条**——它的触发点
写的就是这一段。

#### spike 2：问题问偏了半格

原问题是「`systemPrompt.section()` 的动态内容是否逐请求进 session log」。答案是**两条路都进**，
但 `ctx.systemPrompt` 上有**两个**机制，而我们要的是另一个：

| | `section()` | `context()` |
|---|---|---|
| 是什么 | 系统提示的一段 | 文档原话 *"materialized as a **durable user-role snapshot**"* |
| 落进会话的形状 | `system/message` 事件 | `form: 'snapshot'` 的用户角色消息，带按贡献者分开的 `sections` |

结论不是照文档抄的，是读 `dsh-agent-loop` 里 `SystemPromptProjection` 与
`createUserMessage({ source: { kind: 'plugin', form: 'snapshot', sections } })` 两段实现得到的。

**最有意思的是两边独立撞到同一个结论**：旧仓 2026-07-28 那次审计发现，把每轮都变的读数追加在
系统消息末尾，prompt cache 的断点正好打在那个末尾 ⇒ 断点落在**易变文本之后**，整段历史每轮全 miss，
还要为一个永远不复用的前缀付写入溢价；修法是「系统消息逐字节不变，易变块改挂最后一条 human 消息」。
上游把这条路做成了一等公民。⇒ **PLAN §3.1-5 备的 `agent/pre-step` 退路不用了**（不是退路不成立，
是自己注入反而绕开了 `sections` 的贡献者归属）。

#### 提示块：整段文本进金样，因为**措辞就是契约**

`state.json` 多一节 `live_state`，7 条用例录的是真 Python 印出来的**整段文字**。这块存在的唯一
理由是防量纲错（扫描框 100 nm 而模型要 1 米宽的扫描 = 10⁷ 倍），措辞抄错等于把 2026-07-27 坐标
事故的成因放回去。满字段时正好 **12 行**，与 PLAN §7.2 的「≤12 行紧凑块」对上。

一个必须逐字保留的例外：**偏压不走 `formatSi`**，走 `%g`。它天然在 1 附近，`formatSi` 会印成
`-2000m`——正确但没法看。为此把 kernel 的 `formatG` 放出来（第二个消费者到了才导出）。

#### 变红演练 ×3

| 演练 | 结果 |
|---|---|
| 偏压改走 `formatSi` | ✅ 4 条红，diff 直接显示 `-2 V` vs `-2000m V` |
| `context()` 换成 `section()` | ✅ 2 条红（我们那块再也不在 context assembly 里） |
| 提示块在装载时定死一次，不每轮现取 | ✅ 2 条红 |

另有一条第一次就红的：`ctx.registry.delete` 之后**同一 tick 断言工具已撤销**会失败——
卸载是异步的（disposer 本身可以是异步的）。测试改成等一下再断言，并把这件事写进注释。

#### `inject` 从一件变三件

`['instrument', 'systemPrompt', 'tools']`。后两件也列进来是有意的：少了它们缓存照样转，
但**模型再也看不到仪器读数**——那是个安静的安全回退，比「插件没装上」难发现得多。宁可整个不装。
测试逐个摘掉三件依赖，确认每次都是「整个不装载」。

#### ④验

56 条单测（含对**真** `SystemPrompt` 装配一遍，验我们那块确实进 assembly 且每轮现取）、
4 条集成测试对真 stmsim（`stm_get_state` 返回的块里有真读数与量级警告）、
隔离 `DSH_HOME` 里 `dsh --profile mast-sim` 启动 5 秒后 monitor 端口仍有 ESTABLISHED 连接
——多两个 `inject` 之后插件仍然装得上，这是真风险，所以重验了一次。

#### 三件按消融精神推迟的，各有理由

1. **投影 `mast.instrumentState` → 1.10（U0）**。dsh 的投影是「对已提交 session 事件的纯 fold」，
   而 fold 折成什么形状（留最新一份？留全部？还是只留几个字段？）**完全取决于读它的那一方**，
   那一方是 U0 的右栏卡。更关键的是：状态**已经**以带名字的 section 躺在 session 日志里了
   （上面 spike 2 的结论），投影是读侧的便利，不是「让状态可回放」的机制。现在建等于猜。
2. **`agent/session-start` 播种一次「仪器档案 + 针尖登记 + 当前模式」→ Phase 2**。那三样东西
   现在一个都不存在。
3. **「AUTO 档不注 mode」→ Phase 2**。没有 `OperatingMode` 服务，无档可判。

#### 一个记下来的缺口：`stale` 不进提示块

Python 的块里**没有** `stale`。链路断了的时候，模型看到的是 carry-forward 过来的旧值，
而块里一个字都不提。这与 `stale` 存在的理由（别把陈值当活值）是矛盾的——但它是**模型可见的
提示文本**，改动的影响只有评测能量出来，不该在移植段里顺手改。**照原样移植并记在这里**；
真正该补的位置是 1.9 的看门狗/告警路径（Python 那侧断链也是走告警而不是改提示块）。

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
| 1.7 ✅ | `instrument-stmsim` provider（spawn/等端口/SIGTERM）+ ~~`instrument-fake`~~（无消费者，推迟到 Phase 2） | `profiles/mast-sim` 装上后自动拉起模拟器 |
| 1.8 ✅ | `instrument-state`（1 Hz 11 verb、stale/carry-forward、`applyPatch`） | monitor 端口上有 1 Hz 轮询 |
| 1.8b ✅ | 提示块 `stm-live-state` + `stm_get_state`（投影 `mast.instrumentState` 推迟到 1.10，理由见课时记录） | 提示装配里有实时状态块 |
| 1.9 ✅ | 看门狗（monitor 0.5 s × 8 窗口）+ `estop()` + `/estop` 命令 + 断链告警 | 真 stmsim 上退针确认、`viaRole=emergency` |
| 1.10 ◐ | SSE hub `/mast/events` + 投影 `mast.instrumentState` ✅；客户端机器 + 右栏卡 + 设置卡 **受阻于 B12** | 真 dsh 上 `GET /mast/events` 回 text/event-stream 并推真事件 |

### 课时 1.9 —— 看门狗 + 急停 ✅ 完成（2026-09-10）

`kernel/watchdog.ts`（`TipWatchdog` 纯 tick 机 + `ThresholdLadder` 五级阈值阶梯）+
新包 `packages/instrument/instrument-watchdog`（`ctx.stmWatchdog` 0.5 s 轮询、`estop()`、
`/estop` 命令、断链告警）。**392 条测试**（含 3 条对真 stmsim 的看门狗集成测试）。

#### 金样这次的做法：把真 Python 循环的时间换掉，让它自己跑

前几段的金样是「驱动真对象的方法」，这一段更进一步——`SafetyWatchdog` 是个
`threading.Thread`，循环里全是 `time.sleep`。导出脚本把 `mast.core.watchdog.time`
**整个换成假时钟**（`monotonic` 读计数器，`sleep` 推进计数器并数 tick），
然后直接调 `run()`。窗口、贴轨计时、冷却、闩、抑制清窗、人工判定过期——
六个互相纠缠的状态**全部由真代码算出来**，我们只喂读数、只记结果。

12 条脚本比的是**开火的 tick 号**，不是「有没有开火」。因为这些状态的差别全都
表现为「晚几个 tick 才开火」：抑制清窗 ⇒ 从第 7 tick 推到第 16；读失败保留窗口
⇒ 推一个 tick；冷却 30 秒 ⇒ 第二次开火在第 67 tick。只比布尔值，这些全看不见。

#### 金样里有一条就是 2026-08-10 事故本身

`threshold_getter_raises`：阈值读不到 ⇒ 退到**出厂默认 90 nA**，而轨在 **10 nA**
⇒ **fired = 0**。那次真实撞针里看门狗「武装着但打不着火」，成因是同一个物理量在树里
有两个数——**被标定的那个没握着执行器，没标定的那个握着**。

所以 TS 侧**没有自己的数**：五级阶梯（固定值 → 活值 → 上次的好值 → 出厂默认 → 放弃），
每一次降级都发一个 `threshold-degraded` 事件。`lookup(name) || DEFAULT` 那个形状
——名字写错就得到一个**能跑的错版本**——不能再种一次。

#### 急停：每个细节都是事故买来的

| 形状 | 出处 |
|---|---|
| **先停粗逼近与马达，再退压电** | 退针只退精调 Z；马达还在朝样品走的话，几步就把这次退针吃掉 |
| **`ZCtrl_Withdraw` 两个参数都要给** | 旧代码只传一个，真机上抛 `TypeError` 被吞进 `record.error` ⇒ **急停从来没跑过**，最后一道防线是死的（2026-06-10 复查 C1） |
| **emergency 失败退回 main** | 一个卡住的 main socket 曾经把回退退针整个吞掉（2026-07-28 派发审计） |
| **只有确认过的退针才上闩** | 否则一次失败的退针把网**整个 session 解除武装**（2026-07-03 复查） |
| 停粗逼近**失败不许挡住退针** | 尽力而为，留痕就够 |

#### 三条移植时刻意保留的形状

1. **抑制是活谓词，不是配对的 disable/enable。** 配对调用有一个致命形状：某条路径
   抛异常、提前 return、或者忘了写 finally ⇒ **安全网静默地永久关闭**，而从外面看
   和武装着一模一样。活谓词不可能卡住：令牌一还，下一 tick 就恢复。
2. **读不到时绝不往窗口塞 0 占位。** 一个假的 0 永远低于阈值，会冲淡「全部超阈」
   这个判据，从而延迟甚至掩盖一次真的撞针过流。
3. **`mastDriving` 缺席 ⇒ 视为在驱动。** 读不清就武装，不是「读不清就闭嘴」。

#### `/estop` 注册成**命令**，不是工具

急停不该经过模型——它是操作员的手，不是模型的一个选项。命令走 `ctx.commands`
（compat 新增一个导出、`@deepseek-ai/dsh-commands` 新增一个依赖），模型看不见。

#### 顺手补上 1.8b 记下的缺口

链路断（`stale`）现在走 `stale-link` **告警事件**，而不是改提示块——
与 Python 同构，且提示块的措辞是模型读的契约，不在移植段里顺手改。
同一个陈时间戳只喊一次，不刷屏。

#### 变红演练 ×7（4 条 kernel + 3 条急停），其中一条「没红」的原因很典型

| 演练 | 结果 |
|---|---|
| 窗口判据 `every` → `some`（单点触发） | ✅ 1 条红 |
| 没确认的退针也上闩 | ✅ 1 条红 |
| `mastDriving` 缺席视为「不在驱动」 | ✅ 6 条红 |
| 读不到时塞 0 占位 | ✅ 3 条红 |
| `ZCtrl_Withdraw` 只传一个参数 | ✅ 1 条红 |
| emergency 失败后不退回 main | ✅ 2 条红 |
| 拿掉「先停粗逼近与马达」 | ❌ **第一次全绿** |

最后一条第一次全绿，**但原因不是测试没覆盖，是改动根本没落上**——我 sed 的搜索串
缩进写成了四个空格，文件里是两个。改用编辑工具、并**先 `grep` 确认改动生效**之后重做
⇒ 2 条红。

**教训**：变红演练要先证明「我确实把它改坏了」。一个没落上的改动和一个没覆盖的测试，
在输出里长得一模一样。此后每次演练都先 grep 一遍。

#### ④验

- 392 条单测/契约；3 条对真 stmsim 的集成测试：正常电流下一次不开火；阈值压到
  电流以下 ⇒ 窗口一满就退针且 **`viaRole = emergency`、`confirmed = true`**
  （证明退针那三个动词在 stmsim 的 215/671 里都实现了，真机上这条路不是死的）；
  `/estop` 命令在真模拟器上把针退回去。
- 隔离 `DSH_HOME`：`--dump-config` 里 `mast-watchdog` 行落在 bundle 层，
  `inject` 三件写全；`commands` 服务确实在 `dsh-base` 的树里（第 170 行），
  所以这个 `inject` 是满足得了的。

**写集成测试时被自己的设计绊了一下**（值得记）：第一版三条集成测试全部超时，
因为 `instrumentState` 自己要 `systemPrompt` / `tools`，我在测试里没给 ⇒ 它不装 ⇒
看门狗的 `inject` 也就不满足 ⇒ `ctx.stmWatchdog` 永远挂不上。
**这正是「缺一件就整个不装」在起作用**，只是这次挡的是我自己。

### 课时 1.10 —— U0 ◐ 宿主面完成、客户端半边受阻（2026-09-10）

**做完的（1.10b + 投影）**：`packages/client/stm-ui`（**宿主面**，别被目录名骗了）——
`/mast/events` SSE hub、`/mast/events/snapshot`、投影 `mast.instrumentState`。
**416 条测试**。结清 **spike 第 9 条**。

**没做完的（1.10a + 1.10c）**：tsconfig 宿主/客户端拆分、`ui-core` 右栏卡、设置卡。
原因见下，**不是没时间，是撞到一个需要先定的结构问题**。

#### spike 9：`webServer` 支持流式，SSE 是上游明写的用法

`WebRoute.handler` 的文档原话：*Owns the full response lifecycle (**may hold the response
open, e.g. SSE**)*，另有 `registerUpgrade`。⇒ PLAN §13 备的「退化成轮询」退路用不上。

**不是照文档抄**：测试里起一份**真的 `WebServer`**（`port: 0`）用真 `http.get` 打它，
验响应头、逐条推送、`Last-Event-ID` 续传只补没看过的、心跳。

顺带确认一件更要紧的事：**`EventSource` 断线重连会自动带 `Last-Event-ID`**
⇒「杀宿主重启 5 秒内续传无缺口」不需要客户端记任何东西，我们只要把 `id:` 写对。

#### 三条硬约束，各有它防的东西

| 约束 | 防的是 |
|---|---|
| **帧里只有指针与标量**（超限 `push` 直接抛） | 一张图内联就能把单向长连接堵死，而堵住了客户端**只会「看起来卡住」**，不报错 |
| **重放有缺口就明说**（第一条给 `dropped`） | 安静地少给几条，客户端会以为自己看到了全部 |
| **seq 单调递增不复用** | 客户端拿它当 `Last-Event-ID`，复用过的 seq 让「我看到哪儿了」失去意义 |

#### 投影与 SSE 的分工（D7 的兑现）

SSE 回答「**现在**仪器什么样」——全局、高频、易失、不进会话。
投影回答「**那一步**模型看到的是什么」——按会话、低频、可回放。
一个人问「现在偏压多少」，另一个人问「模型做那个决定时以为偏压是多少」。

投影只留最新一份，不留历史——**这不是省事**：投影本来就是「重放到第 N 个事件时的状态」，
回放到哪儿 fold 就给到哪儿。fold 的两条硬约束都钉成了测试：不关心的事件**返回同一个引用**
（框架靠引用相等判断有没有变化），`view` 直接把 `state` 交出去不造新对象。

#### 真 dsh 端到端打通

```
dsh --profile mast-sim --no-open  →  http://127.0.0.1:3080
GET /mast/events/snapshot  →  200，真的 hardwareState JSON
GET /mast/events           →  200 text/event-stream，收到 safety 与 hardware_state
```

整条链活着：stmsim → instrument → 1 Hz 缓存 → 看门狗 → SSE hub → HTTP。

#### 两条 profile 组合的坑，都是「静默不装」

1. **`webServer` 不在 `mast-sim` 的树里。** `dsh plugin add` 建出来的新 profile
   **只有 `dsh-base`**，而 `webServer` 是 `dsh-web-app` 提供的 ⇒ `mast-ui-host` 那行的
   `inject` 不满足，**SSE hub 整个不装载而且不报错**。`--dump-config` 里我们的行明明在，
   但树里根本没有 `webserver`。已写进 `profiles/mast-sim/cordis.patch.yml` 的头注释。
2. **客户端模块必须经由 bundle 进来**（见下，B12）。

#### 为什么客户端半边停在这里（新开台账 B12）

按 slot 目录（dsh 自己用 `cordis_inspect what:"client"` 喂给模型的那份，从
`dsh-cordis-client-runner` 的 bundle 里读得到）已经拿到了要用的座位与注册形状：

```js
// 目录里带的示例，逐字
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
      { name: 'settings.plugins.tab', id: 'my-entry', order: 100, label: 'My entry' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

座位也点清楚了：`settings.section`（设置卡）、`shell.overlay`（急停横幅）、
`sidebar.right.pane.tab`（右栏）、`sidebar.panellist`。**而且用 `React.createElement`
就够，不需要 JSX** ——这本来会省掉一整套构建复杂度。

**卡住的是「本地开发时客户端包怎么进 profile」**。实测（建了一个最小探针包，
只有 `dsh.client` 元数据与一个纯 ESM 的 `./client` 入口）：

```
dsh: warning: dsh-spm-probe-client declares no dsh.bundle
     — installed as a plain dependency, not a profile layer
```

⇒ 客户端模块**必须经由一个 bundle 进来**，而 dev 态 `link:` 下 profile 的 pnpm
**不解析我们的 workspace 依赖**（台账 B7 那条）——所以 `dsh-spm` bundle 依赖
`dsh-spm-ui-core` 这条路在开发态是断的。子路径导出（`dsh-spm/instrument-state` 那招）
也不适用：客户端模块要有**自己的 `package.json` 与 `dsh.client` 元数据**。

**这与 B10 是同一个根**：开发态与安装态是两条解析路径。**先解决 B10，1.10c 才有意义**
——否则做出来的东西只在「我这台机器的某种摆法」下能跑。

**下一步的三条路**（B12）：
① 用 `pnpm pack` 出 tarball 走一次安装态，看客户端模块能不能被正常拉进 client combo；
② 把 `ui-core` 本身也做成一个 bundle（它有 `dsh.bundle` 就成为 profile layer）；
③ 读 dsh 仓库的 `packages/client/AGENTS.md` —— 上游对这件事应当有明说，
而我手上只有 npm 包内文件，没有那份文档。

#### 1.10a（tsconfig 宿主/客户端拆分）也一并推迟

它的**唯一理由**是「两组不同的 `Context` declaration merging 不能落进同一个
`ts.Program`」——而此刻**一个客户端包都还没有**，现在拆等于建一个空的解决方案文件。
按消融精神：**第一个客户端包落地的同一段里拆**，那时它承担的是真东西。

⚠️ 注意 `packages/client/stm-ui` **是宿主面**（目录名沿用 PLAN §6.2 的分组），
它进的是宿主解决方案，不是客户端那个。拆的时候别把它归错。

## 4. Phase 2 · 安全 + 内核 + 批 1/2（课时 2.1–2.15）

**完成判据**（PLAN §11）：§8.4 批 1/2 判据；蜜罐/SAFE 拒/互斥/hash 不等被拒；差分序列一致。

**这个 Phase 是整个项目的承重墙。** 后面 400 多个技能全部穿过 `SkillKernel.run()` 这一个 choke point，
闸门写错一次，错的就是 400 多次。所以本 Phase 的每一段都遵守一条额外纪律：
**闸门先有 golden，再有实现，再有变异**——变异证明「这道闸真的在挡东西」，没有变异的闸等于没有闸。

| 段 | 写什么 | 验收 |
|---|---|---|
| 2.1 ✅ | 安全金样导出：`safety.json`（包络 14 字段 / `_GLOBAL_CHECKS` 19 行 / `_PHYSICAL_ABSURD` 11 行 / `_ABORT_SAFE_WRITES` 24 条 / `_is_read` 对 **671 动词**的判定表 / 25 条硬闸用例 / 11 条能力用例 / 16 条模式拒绝**原文** / 15 条中止用例）。**sample gate 四表与 `preconditions.json` / `prompts/` 留给 2.6 与 2.9**——那时才有消费者 | 重跑逐字节相同 |
| 2.2 ✅ | `kernel/safety.ts` ①：`SafetyLimits` 包络 + `_ENVELOPE_FIELDS` 逐字段检查 | 金样逐条；蜜罐 `setpoint_a=1.5` 被拒 |
| 2.3 | `kernel/safety.ts` ②：物理荒谬 `_PHYSICAL_ABSURD` + 教学文案逐字 | 金样逐条 + **文案逐字相等** |
| 2.4 | `kernel/safety.ts` ③：`_is_read` 671 动词判定表 + `_ABORT_SAFE_WRITES` | 671 条逐动词对表；中止后 `ZCtrl_Withdraw`/`Scan_Action(1,…)` 仍放行 |
| 2.5 | `kernel/safety.ts` ④：五条硬闸 + `operating_mode` 拒绝 | 五硬闸在 `approvalSource !== 'human'` 一律拒；SAFE 下 `bias_pulse`/`tip_shaping` 被拒 |
| 2.6 | `kernel/sample-gate.ts`：sample gate 四表（depth 0 判、子步继承 admission） | 四表逐条；子步不重复判 |
| 2.7 | `ctx.stmSafety` Service + dsh 四钩子接线（`tools/pre-execute` guard、approval、digest、`tools/post-execute`） | contract 测试：guard 拿得到工具名与参数（spike 1 已证）；approval reason 透传 |
| 2.8 | `/mode` `/estop` 命令 + `ApprovalDigest` | `/mode SAFE` 后写技能被拒；digest 里没有参数（spike 1 的边界） |
| 2.9 | preconditions 移植 + `HardwareState` 夹具网格 | 金样网格逐条；措辞 `[Name] precondition_failed:` 逐字 |
| 2.10 | `SkillKernel` 骨架：K0 覆盖 / K1 SI / K5 快照+计时 / K6 validateParams / K11 execute / K12 applyPatch / K13 composeText | `_Probe` 走通这七步；`>2000` 落盘 `textRef` |
| 2.11 | `SkillKernel` 其余闸：K2 abort 闩 / K3 sample / K7 荒谬+包络+mode+hard_gate / K8 前置（不满足先 `refreshState()` 再判，**两入口都做**）/ K9 `holdForSkill` / K10 调制 preflight / K14–K18 | 每闸至少一条金样；K18 的 `AbortRequested`/`InstrumentBusy` **不回滚** |
| 2.12 | schema 生成（复刻 `_schema_from_metadata` + `si_params` + `effective_bounds`）+ `defineSkillTool()` | `tool_schemas.json` 比对：类型/required/**description 逐字相等** |
| 2.13 | RunLedger + `ctx.stmRecords`（SQLite，`node:sqlite`） | `records_schema.sql` 建表一致；被拒的调用**也记**；`approval_source` 落库 |
| 2.14 | 假技能 `_Probe` 的 dsh recorded-session 测试 + **变异框架**（`MAST_MUTATE=<gate>` 逐闸换 no-op） | meta 断言：**每闸至少一条变红**（三判据：已应用、落在被测对象、变红）；拔掉 pre-execute 的 abort deny ⇒ 内核 K2 仍拒 |
| 2.15 | 批 1（只读 L0 ≈38）+ 批 2（写 L0 ≈36 + 硬闸七件套 + DANGEROUS 2 + L1 试点 AutoApproach/ApproachTip） | §8.4 批 1/2 全部判据；`ZControllerOnOff(true)` 后立刻 `MoveToXY` 过前置（钉 2026-08-10 反例） |

**最容易翻车的三处**

1. **K8 的「两入口都做」**。前置条件不满足时要**先 `refreshState()` 再判**，而这件事在 Python 里有两个入口
   （agent 工具边界与 composite 子步）。2026-08-10 真机复现过：写回成功、缓存却还是旧值、下一步前置永远不满足。
   1.8 的 carry-forward 修了缓存那一半，K8 修的是判定那一半，**两半都要**。
2. **文案逐字**。`_explain_validation` / abort / sample gate 的固定措辞是模型读的东西，不是给人看的日志。
   照行为写 TS 能过测试，照措辞写才对得上（0.7 已经发现 strict 与 loose 对同一个非法输入给的是两句不同的教学文案）。
3. **变异框架不是加分项，是这个 Phase 的完成判据**。没有它，「闸门写了」和「闸门在挡」分不清——
   而这正是安全件唯一重要的性质。

---

## 5. Phase 3 · 可用里程碑：私聊 IC on stmsim（课时 3.1–3.8）

**完成判据**：kimi-k3 在 stmsim 上「设偏压 → 开反馈 → 扫一帧 → 读状态」十轮对话；
session log 可 replay 重建每次请求；帧内联可见；`stm_selfcheck` 全绿。

**这是第一个「能用」的东西。** 在这之前没有任何东西可演示——别在 Phase 2 就想着给人看。

| 段 | 写什么 | 验收 |
|---|---|---|
| 3.1 | `dsh-spm-llm-providers`：Kimi / Qwen / GLM 三家自写 `LlmAdapter`（`enable_thinking`、`thinking.type`、Kimi 温度锁 1.0、`reasoning_content` 多轮回传） | 三家各跑通一次真实调用；**带工具调用一律不流式**（§3.2-12 的纪律不因上游修复而放宽） |
| 3.2 | `instrument-control` agent preset（`restrict({deny})` 写在 agent 平面——`tools.restrict()` 要求 scoped context，全局调用直接抛） | preset 里 `web_fetch` 显式 deny；工具目录只有 STM 族 |
| 3.3 | `ctx.stmRecords` 完整化 + 投影接线 | 投影 `apply` 重放与 live 一致（同引用） |
| 3.4 | `dsh-spm-stm-ui` 宿主接缝**冻结 v1**（PLAN §7.9） | 接缝清单落文档；此后加字段不改语义 |
| 3.5 | U1：设置卡 instrument/safety/models + `stm_*` toolview + 审批卡 + `ask_user` 包装 + `stm-frame` 节点 + `/mast/frames/:id.png` + `/mast/approvals/:callId` | 审批卡的 `argsHash` = 内核执行时的 hash（**不等就拒**）；投影回放重建的卡片与 live 一致 |
| 3.6 | 批 3a 扫描主链：ConfigureScan / SetScanSpeed / StartScan / **WaitScanComplete**（流式 poll，起扫宽限 5 s、按行数延长、五种 outcome）/ SaveScan（session path 下 120 s 内最新 `.sxm`）/ GrabScanFrameData | 复现 STM-Bench `test_scan_pipeline_start_wait_save_grab_crashcheck`；五种 outcome 各有故障注入用例 |
| 3.7 | 批 3b 扫描族其余（LoadScanFrameFromFile / CheckScanForCrash / ComputeDriftVector / ParseRegions / SetBiasRamp / WatchScanLines / ScanBackgroundPaste / Delete / marks 3 / datalog 6 / lockin 14 / signals 其余 / misc_setters 8 / util 其余，≈45 合计） | 每个技能 DoD 八条全绿 |
| 3.8 | 十轮对话端到端 + `stm_selfcheck` | session log replay 逐请求重建；帧内联可见 |

**为什么 WaitScanComplete 单独占一格**：它是第一个**长时**技能，抱着 abort、超时、五种 outcome 与
「dsh 超时也触发 signal，绝不把仪器留在运动中」这条硬约束。`exec.signal` 触发时要发
`Scan_Action(1,0)` 停扫再返回 aborted——**不是直接返回**。

---

## 6. Phase 4 · 分析与视觉 + 数据页（课时 4.1–4.7）

**完成判据**：numpy 金样逐检测器一致（容差写明）；新旧 UI 缩略图像素相等。

| 段 | 写什么 | 验收 |
|---|---|---|
| 4.1 | `dsh-spm-numerics` 基础件：`Mat{rows,cols,Float64Array}`、FFT 1-D（`fft.js`）+ 自写 2-D/互相关/`phase_cross_correlation`、线代（`ml-matrix`）、`curve_fit`（`ml-levenberg-marquardt`）、平面/多项式/RANSAC 自写、可分离高斯/拉普拉斯/灰度形态学/插值（边界模式对齐 scipy）、连通域 union-find、SSIM、统计（percentile 用 numpy `linear`）、xoshiro128\*\* 可种子 RNG、`.npy` v1/v2 | 每件对 numpy/scipy 金样，**容差逐件写明**；峰位约定用 golden 钉 |
| 4.2 | `dsh-spm-nanonis-files`：`.sxm` / `.dat` / `.3ds` 自写读写（GBK 走 Node full-ICU `TextDecoder('gbk')`，退路 `iconv-lite`） | 真机文件帧 SHA-256 与 nm/px 相等 |
| 4.3 | `vision-classic`：非深度检测器 | 逐检测器 numpy 金样 |
| 4.4 | 批 4a：builtins 23（FindFlatRegion / MeasureStepHeight / AnalyzeFrameTilt / AnalyzeScanImage 非视觉分支 / ClusterExtract / DomainAssess / FrameCorrugation / FrameTrust / BestFrame / AssessSpectrum / MapBarrierHeight / MonitorCurrentFFT / DetectAtomicLattice ×3 / AtomicLines / AtomicPhase / Multiframe / TiltProbeCircle / CalibrateCoarseStep / ReconcileSafetyEnvelope / ScanIntelSelfCheck …） | 每技能 `golden/analysis/<Name>/cases.json`；分箱/阈值**按分辨率派生**不写死 |
| 4.5 | 批 4b：paper 分析 25（CheckLineQuality / LevelLines_Median / SubtractPlane_RANSAC / SubtractPoly2D / Destripe_MorphOpen / CorrectDrift_XCorr\|BraggPeak / DiffScans / FindEmptySpot / FitFano_Kondo / FitGap_BCS / DetectAtomJump / UnmixSpectra / DeconvolveTip_RL …） | 同上；**KNOWN_ISSUES 里的缺陷判据不照抄**，登记 deviations |
| 4.6 | U2：数据页 / 扫描地图 / 视觉缓冲 / 活帧 | 同组真机 `.sxm` 新旧 UI 缩略图**像素相等**；纯函数测试原样全绿；活帧刷新 ≤1 s |
| 4.7 | `gen-skill-skeleton.ts`（从 golden 的 spec + `verbs_used` 生成 spec 与 execute 桩）+ 批 2b/3b 长尾 ≈250（spectroscopy 38、pll 36、optional_\* 58、user_output 14、nanonis_script 14、sweep 11、pattern 7、function_generator 6、instrument_limits 6、readback 7、spectroscopy_sync 6、atom_track 4、bias_sweep 4、spectrum_analyzer 3、osci 3、optics 11、chamber/temperature/hardware_events） | 生成器重跑无 diff；stmsim 没有的模块只对 SpecEchoServer 做 e2e，**技能卡片标「未在物理模拟器验证」** |

**这个 Phase 的陷阱是「差不多对」**。数值代码没有红绿之分，只有容差。所以每一件都必须
**先写下容差再写实现**——反过来做，容差就会变成「刚好让我这版通过的那个数」。

---

## 7. Phase 5 · 硬件闭环（课时 5.1–5.7）

**完成判据**：`test_e2e_composites` 复现；断点续跑；换针后 SAFE 包络按登记 capability 生效；
知识三档 contract；后台 job cancel 1 s 内停扫。

| 段 | 写什么 | 验收 |
|---|---|---|
| 5.1 | `GraphExecutor` 移植：async generator plan、sidecar（进度真源）、`step_skip` 台账、abort/halt 双检、旁白模板、`_validate_products`、`abort_facts` | **先用批 3 的 WaitScanComplete/SetBiasRamp 验过再往下**（PLAN §8.4 批 5 的前置） |
| 5.2 | 长时技能 → `ctx.jobs`；human 节点 `ctx.ask` → `userQuestions.ask`；决策缓存写 sidecar `_human[decisionKey]` | 后台 job `cancel` **1 s 内停扫**；续跑不再打扰；无 `ask` 通道 ⇒ **明确失败**不静默继续 |
| 5.3 | tip registry / instrument profile（`hardware_modules`）/ env history | 换针后 SAFE 包络按登记的 capability 生效 |
| 5.4 | 批 5a 扫描类 composite：FullScan / ScanAt / PreScanCheck / BatchRegionsScan / SurveySurface / ScanPublicationFrame / AssessImageQuality … | `FullScan` 的 `wait_stopped_early` ⇒ **失败且不做撞针检查**；断点续跑 e2e（杀进程再调同名 composite ⇒ 跳过已完成步并记 `step_skip`，跑完 sidecar 清除） |
| 5.5 | 批 5b 针尖/谱类 composite：TipPulse / ConditionTip(+Poke/Pulse) / ShapeTipOnSurface / GridSTS / SpectroscopyAtPositions / AutoTilt / TiltCalibrate / TrackDrift / RelocateCoarseXY / VerifyAtomicResolution / MakeAtomicResolutionTip / MakeSpectroscopyTip / AcquireSTS / BiasPulseWithReadback … | `TipPulse` 在 SAFE 下被拒**且子步路径也拒**（这条是 D9 的核心：闸门不能只挡工具入口） |
| 5.6 | 知识 SKILL.md ×15 + 检索工具；跨会话记忆（dsh 无内置，走 section provider + tool） | 知识三档 contract |
| 5.7 | U3：实验记录 / 心愿单 / 智能体拓扑 / 电流监控 / 环境历史 / 初始化 / 记忆 / 用量 / 作用域 chip | 记录页与 records 导出对得上；`visitCount` 回放一致 |

**为什么 5.1 要先拿批 3 的两个技能验**：`GraphExecutor` 是 composite 的骨架，
先写骨架再写第一个 composite，等于同时调试两个未知数。拿两个**已经绿的**技能当负载先把骨架跑通。

---

## 8. Phase 6 · L4/L5 闭环 + 七 agent（课时 6.1–6.6）

**完成判据**：ForgeAuTip 在 sharp/blunt 两种 stmsim 世界分别成功/干净失败；
supervisor 委托 IC 扫图交 DP 分析的端到端 replay 可重建；两个 IC 分支并发被**结构**拒绝；
STM-Bench B0/B1 场景在 dsh 栈跑完。

| 段 | 写什么 | 验收 |
|---|---|---|
| 6.1 | 批 6a：ForgeAuTip / PrepareNobleTip(3) / AchieveAtomicResolution / AcquireBiasImagingSeries / AtomicBiasSeries / AcquireAngleSeriesForCalibration / ExecuteScanPlan / LineSTSAcrossWall / STSConditionSeries / StepCoarseXY | ForgeAuTip sharp/blunt 两个世界；`time_budget_h` 用**墙钟**；`ctx.markers` 必填（缺席构造期就拒绝） |
| 6.2 | 批 6b：paper 闭环 AdaptiveSTS_GP / OptimizeResolution_BO / FindGoodRegion / ContinuousImaging_Auto / AutonomousSurvey_Scanbot / ConditionTip_DQN / AtomManip_SAC / AutoOSS_Dehalogenation（GP/BO 自写） | 每技能 DoD；GP/BO 对 golden |
| 6.3 | `dsh-spm-agent-presets`：8 个 preset + subagent 编排（supervisor→IC）+ persona prefix/suffix 拆分 | **两个 IC 分支并发被结构拒绝**（不是运行时报错，是编排层不允许） |
| 6.4 | 账本 + 护栏（用量、预算、越界拦截） | 账本与 records 对得上 |
| 6.5 | 批 8：其余 agent 工具族（DP / XD / LIT / PW / PR / RD） | 每族 DoD |
| 6.6 | literature 包 + U5 部分（技能目录 / 构建器 / 市场 / 文献库） | 端到端 replay 可重建 |

---

## 9. Phase 7 · conduct + 声明式（课时 7.1–7.5）

**完成判据**：中途 kill 重启后 campaign 从最后确认步续跑；`autonomous` 编译期无 ask；
attended 无人应答时 deny 不挂起；SpecComposite 全模板跑通。

| 段 | 写什么 | 验收 |
|---|---|---|
| 7.1 | conduct / goals：campaign 状态机 + 最后确认步 | 中途 kill 重启后从最后确认步续跑 |
| 7.2 | 唤醒 / 自主度 / 撤销窗 / journal | `autonomous` **编译期**无 ask；attended 无人应答时 **deny 不挂起** |
| 7.3 | 批 7a：SpecComposite（12 节点、`jsep` 白名单求值、继承安全级 = max）+ version_store CAS + templates + loader | 全部 templates 跑通 stmsim；`safe_eval` golden；「声明 auto 含 CONFIRM 子步 ⇒ 提级」有测试 |
| 7.4 | 批 7b：技能工坊 `skill_catalog` / `draft_composite` / `save_composite` / `run_composite`；overlay/市场订阅；`hardware_modules` 与高级能力门；tool packs 桩换注册 + `search_tools` / `load_tool_pack`（中文同义词表照搬） | spike 第 6 条的「重注册语义」在这里结清 |
| 7.5 | U4：Conduct 视图 | 中途 kill 重启后面板从 `GET /mast/conducts/:id` **完整重建** |

---

## 10. Phase 8 · 视觉深模型 + 基准 + 真机准备（课时 8.1–8.5）

**完成判据**：ONNX 与 torch 逐样本 ≤1e-4；Track B 九族全跑；真机首次接触条件全部满足。

| 段 | 写什么 | 验收 |
|---|---|---|
| 8.1 | `vision-onnx`：旧 venv 一次性 `torch.onnx.export` 出 `.onnx` + manifest；`onnxruntime-node` 推理；骨干**无条件离线** | parity max-abs ≤1e-4 逐样本 |
| 8.2 | TS 版 stmbench harness | Track B 九族全跑 |
| 8.3 | 差分测试全套（PLAN §12）：`tools/record-traces.py` 录 `spec/golden/traces/`，TS 同 seed 跑内核比对；`traceNormalize()`（连续只读轮询折叠 `×k`、差分时关 1 Hz 刷新、浮点 1e-9 相对容差、路径只比 basename、**不比 `return_value` 形状**，比状态缓存 patch 后的非时变字段） | L0/L1/L3 确定性技能全过 |
| 8.4 | `profiles/mast-rig` **首次入仓**（`allowRealRig: true`、`mode: SAFE`、approval `ask`、遥测决策）+ `rigGuard` 端到端 | rigGuard 拒绝「模拟 profile 碰真机」与反向；selfcheck 全绿 |
| 8.5 | 真机接触清单与阶梯 | 只读全扫 → 值守窗口清单（带工具多轮 / `ask_user` / Stop / 重启续聊 / 语音各一次）→ bake ≥1 周。**旧系统并行运行，切换由操作员决定** |

**真机首次接触的四个条件**（缺一不可，PLAN §11）：差分套件对将用技能全绿 + rig selfcheck 全绿 +
操作员在场 + SAFE 档且先只跑 READ 技能一整个 session。

---

## 11. 贯穿全程的五条

- **批次成员一律从 golden 的 `category` + 目录 + `safety_level` 派生，不读 `composition_level`**
  （374/498 个吃默认值 0，照它分会把四分之三全归 L0）。
- **Phase 3 是第一个「可用里程碑」**。在那之前没有任何东西是「能用」的，别提前演示。
- **Phase 8 之前不出现 `mast-rig`**。真机 0 次是**仓库结构**，不是纪律——纪律会松，结构不会。
- **每个 Phase 开头先补该 Phase 要用的 golden**，不要边写边补。分母先定，进度才有意义。
- **每一段都要有变红演练**。Phase 0–1 的经验是：**「没红」的演练比红的更有价值**——
  1.8 有两次演练没红，一次暴露出 stale 只测了一半，一次暴露出卸载竞态会留下没人接的 rejection。

---

## 12. 决策台账

| # | 议题 | 状态 | 结论 / 待办 |
|---|---|---|---|
| **B1** | dsh 版本追踪 | **✅ 2026-09-09 已升到 `0.1.5-alpha.1`**（阻塞解除）。此前 09-08 定的「不升 0.1.3」留档：| 锁留 `0.1.2-rc.1`，每课时照常查版。社区已多方复现同一问题（Discussions #5929/#5882/#5784/#5751/#5638/#5689），且该版还有另外三处独立的启动崩溃（#5881 重复 loader id、#5753 session v2 迁移拒绝老日志、#5889 rpc owner 未声明）与一处发布物缺依赖（#5913），`latest`/`next` 也仍停在 rc.1。**上游反馈渠道是 GitHub Discussions，不是 Issues（该仓 Issues 已关闭）** |
| B2 | LICENSE 的版权署名 | **✅ 2026-09-08 定** | `Copyright (c) 2026 HamsterPark`（用户昵称，真名在其 GitHub 主页备注）。`LICENSE` 已落盘；0.2 建包时各 `package.json` 的 `author` 用同一署名 |
| B3 | 仓库挂哪、何时公开 | 半定 | 署名与账号都是 **HamsterPark**（本机 `gh` 已登录该账号）。**何时公开仍未定**：建议先私有，Phase 1 联调通过后再公开（用户「一点点重新开源」） |
| B4 | pnpm `overrides` 能否按 `@deepseek-ai/*` 通配 | **✅ 2026-09-08 实测：不能，而且是静默无效** | 拿 `overrides: {'@types/*': '22.20.0'}` 跑真安装：`@types/semver` 原样停在 7.7.1，**无报错、无警告，pnpm 就是什么都没做**。⇒ 若写 `'@deepseek-ai/*': '<版本>'`，我们会以为钉住了 223 个包，实际钉住 **0 个**。0.3 必须用脚本从安装树生成**逐包** overrides 表；**`check-dsh-pin.ts` 不是冗余保险，它是唯一能抓住这种静默失效的东西** |
| B5 | 插件版本号怎么表达「对应哪个 dsh」 | **✅ 2026-09-08 定：只用 `peerDependencies`，不加自定义字段** | 查了 dsh 自家包（`dsh-base` / `dsh-web-app` / `dsh-session-persistence-jsonl`）：`package.json` 的 `dsh` 段**只有** `bundle.patch`，没有任何版本声明字段；版本对应关系**全靠 `peerDependencies`**（它们用 `^` 范围，我们按 D11 用精确钉）。再加一个 `dshVersion` 字段就是第二份真源、还没人校验——正是 PLAN §5 记的 MAST「两处双真源」老毛病。peer 到底会不会被硬性执行，由 B7 在 0.4 实测 |
| B6 | 我们注册的工具是否自动进 agent preset 目录 | **半结清（2026-09-08）** | 已证：插件在真实 dsh 里被装载、`apply` 执行、`inject:['tools']` 得到满足、工具进了**宿主** `tools` 注册表（探针实测 `ctx.tools=object`）。**未证**：模型是否真能看见它——那需要一次真实的模型调用（要 API key 与花钱）。facts.md §3 抄的 preset 注释说「合并后的目录也包含部署全局注册的工具」，倾向于会看见。留到第一次有理由跑真模型时顺带确认 |
| **B7** | `dsh plugin add` 遇到子包漂移是硬失败还是静默混装 | **✅ 2026-09-08 实测：问题本身问错了** | `dsh plugin add <本地目录>` 用 **`link:`**，pnpm **完全不解析我们的 dependencies**——`workspace:*` 从没被求值，peer 精确钉也没执行，所以既不硬失败也不混装：**它压根没参与**。探针实测：运行时我们的 compat 解析到的是**本仓**那份 `dsh-tools`，于是一个进程里活着**两份模块实例**。今天两份同版所以没事；`defineTool` 是纯工厂也不在乎。**会出事的是依赖模块身份的东西（`instanceof`、模块级单例、Cordis `Service` 类身份）——课时 1.6 定义 `ctx.instrument` Service 时必须先验**。详见 `dsh/facts.md` §6-17 |
| **B10** | 开发态（`link:`）与安装态（npm/tarball）走两条不同解析路径 | **新开，Phase 0 结束前** | B7 引出的。发布路径上 profile 的 pnpm 会真的解析依赖、执行 peer 钉，只剩一份实例——和我们每天跑的**不是同一件事**。至少用 `pnpm pack` 出的 tarball 走一次安装态冒烟，否则重演 facts.md §1「npx 缓存是冻结快照」那个教训 |
| **B11** | **CI 跑不了 integration**：它要真 stmsim，而 stmsim 在 STM-Bench 仓库里，那个仓库**没有远端**（09-09 核实 `git remote -v` 为空） | **新开，1.7**。CI 暂时只跑 `--project unit --project contract` | 三条路：① 给 STM-Bench 建个远端（私有也行），CI 加 `setup-python` + 钉住 commit 的 checkout；② 把 stmsim 打成 wheel 发到某处，CI `pip install`；③ 一直只在本地跑 integration。**①最省事也最诚实**——差分测试（B8）迟早也要 CI 上有 STM-Bench。在解决之前，「CI 绿」不等于「对着真模拟器绿」，这个差别必须记着 |
| **B12** | **本地开发时客户端包进不了 profile**：客户端模块必须经由一个 bundle 进来（实测警告 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`），而 dev 态 `link:` 下 profile 的 pnpm 不解析我们的 workspace 依赖（B7）。子路径导出那招也不适用——客户端模块要有自己的 `package.json` 与 `dsh.client` 元数据 | **新开，1.10**。**与 B10 同根**，先解决 B10 | 三条路：① `pnpm pack` 走一次安装态；② 把 `ui-core` 本身做成 bundle；③ 读上游 `packages/client/AGENTS.md`（我手上只有 npm 包内文件）。**在这之前 1.10c 做出来的东西只在「我这台机器的某种摆法」下能跑** |
| B8 | 差分测试要对 STM-Bench 做 ~60 行小改（`--trace`/truth 端点） | 未定（PLAN §16） | 退路 B：在线双跑 |
| B9 | ONNX 权重放哪（不入仓） | 未定（PLAN §16） | 建议 `E:\dsh-spm-models\` + manifest |

## 13. 每次开工前的三条自检

1. `npm view @deepseek-ai/dsh dist-tags --json` —— 与 `dsh/facts.md` 首行一致吗？
2. `git status` —— 上一段收干净了吗（不该有跨段的半成品）？
3. 这一段的验收命令是什么、我打算让你亲手跑哪一条？
