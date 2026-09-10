# dsh spike 十条 —— 结论

> 清单正文在 `facts.md` §7；本文只记**结论与它改变了什么**。
> 有结论的都钉成了 `packages/host/compat/src/spike.test.ts` 里的断言，每次升级 dsh 后随
> `pnpm test` 重跑（`upgrades.md` 清单第 4 步）。**红了说明某条设计前提没了，先改设计再改代码。**
> 对照 dsh `0.1.2-rc.1`。2026-09-08 课时 0.6 开写。

| # | 问题 | 状态 |
|---|---|---|
| 1 | `guard` 的 `exec` 是否含工具名与参数 | ✅ 含，两者都有 |
| 2 | `systemPrompt.section()` 动态内容是否逐请求进 session log | ✅ 1.8b 结清：**进**，但答案是「别用 section」 |
| 3 | `cordis.patch.yml` 有无 `remove`/`replace` | ✅ 都没有，只有 insert + 按 id 逐字段覆盖 |
| 4 | replay 模式下工具执行是否被短路 | ⏸ 未查 |
| 5 | `parameters` 是否透传 `minimum/maximum` | ✅ 0.3 结清：不透传**且构造期抛错** |
| 6 | `restrict` 能否放松；隐藏名被调用返回什么；重注册语义 | ◐ 前两问有答案，重注册未验 |
| 7 | `tools/result` 能否读到 `value` | ✅ 能读；但 value **不进持久事件** |
| 8 | `conversation.view` / `details` / `toolview` 的行为 | ⏸ 未查 |
| 9 | `webServer` 是否支持流式 `res.write` / WS upgrade | ✅ 1.10 结清：**都支持**，SSE 是上游明写的用法 |
| 10 | 子会话读父 session id；`agents.resume` API 名；压缩钩子 | ⏸ 未查 |

## ✅ 1 · guard 拿得到工具名与参数

```ts
type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
interface ToolExecutionInput {
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  readonly callId: ToolCallId; readonly rootCallId?: ToolCallId
  readonly agent?: Agent; readonly parent?: ToolExecutionToken; readonly signal: AbortSignal
}
```

**改变了什么**：D9 把「物理荒谬」这类判据挂在 `guard` 上是成立的——它看得见参数。
（注意这与 facts.md §6-2 那条**不矛盾**：拿不到参数的是 `ctx.approval.request()`，不是 guard。
`ApprovalDigest` + `args#hash6` 的变通只为审批面而存在。）

**顺带查到的两条**（写进 §7.3 实施时要照做）：
- `tools.restrict()` **要求 scoped context**，在全局 ctx 上调用直接抛：
  "a context-global restriction would mask every agent — deny the tool for the intended agent instead"。
  ⇒ IC/conduct preset 的 `deny bash/web` 必须在 agent 平面写，不能图省事挂全局。
- `register()` 拒绝名为 `run_code` 的工具（PTC 传输保留名）。

## ✅ 3 · patch 只有 insert 与按 id 逐字段覆盖

`PatchOptions` 的全部字段：`id` / `insert` / `name` / `config` / `group` / `disabled` / `inject` / `intercept` / `isolate`。
**没有 `remove`，没有 `replace`。** 应用逻辑就是 `target[key] = value`。

| 事实 | 后果 |
|---|---|
| **`config` 整值替换，不深合并** | 覆盖 dsh-base 行时必须把原有键**抄全**，抄漏一个就是静默改默认值（PLAN §3.1-9 坐实） |
| **想「删掉」一行只能 `disabled: true`** | PLAN §6.3「`tool-bash/pwsh` 不从 profile 删」的写法本来就对；没有别的选择 |
| **id 匹配不到 → 只警告并跳过** | **陷阱**：dsh 改了某行 id，我们的覆盖会静默失效。升级清单第 2 步的逐行 diff 就是防这个 |
| **非 insert 的 patch 里 `name` 是断言不是覆盖**，对不上整条跳过并警告 | **可以当护栏**：覆盖 dsh-base 行时把 `name` 一起写上，dsh 换了那个 id 背后的插件时我们会跳过 + 警告，而不是悄悄作用到别的插件上。§6.3 那张覆盖表实施时逐行都加 `name` |
| 带 `id` 的 insert 追加进那个 **group**；不带 id 的追加到顶层 | 我们的 bundle patch 不带 id，追加到顶层，正确 |

## ✅ 7 · `tools/result` 读得到 `value`，但 value 不持久

```ts
interface ToolExecutionSuccess {
  readonly isError: false
  /** Execution-local canonical value; deliberately omitted from durable events. */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: true
}
'tools/result'(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

**改变了什么**：内核 K16（records）挂在 `tools/result` 上能拿到完整规范值——但**它不进 dsh 的持久事件**，
所以我们自己的 SQLite 是唯一能留住它的地方。这不是「为了保险起见」，是 PLAN §3.1-1 的直接依据。
`additionalContexts` 也在这一层，正是 §7.3「`last_scan` 经 `additionalContexts` 推给下游」的落点。

## ◐ 6 · restrict 与重注册

- **隐藏/未知的名字被调用 ⇒ `UNKNOWN_TOOL`**（`HarnessError` 的 code），消息形如 `unknown tool "X"`，
  可带 `reachableFrom` 说明从哪能够到。dsh 源码里有一段注释正好描述我们担心的场景：
  模型「收到一个提示词里刚声明过的工具的 `UNKNOWN_TOOL`，于是认定这个部署是坏的」。
  ⇒ PLAN §7.8「桩保持绑定」的动机被上游自己的注释印证了。
- **`restrict` 只能收窄**（"Restrictions intersect"），但**它的 disposer 能撤销这次限制**。
  所以「能否放松」的答案是：不能靠再调一次 restrict 放松，只能撤销原来那次。
- **未验**：同名工具重注册（桩 → 完整定义）的语义、以及 `tools/change` 事件的行为。
  `register()` 走的是 `layer.tools.insert(name, definition)` 并返回 disposer，分层看起来是「遮蔽」而非「报错」，
  但没实测。**触发点**：Phase 6 做 tool packs 与 `load_tool_pack` 时，那是第一次真的要换注册。

## ✅ 2 · 动态内容进不进日志 —— 进；但真正的答案是「别用 `section()`」

**问题问偏了半格。** `ctx.systemPrompt` 上有**两条**路，落进会话的方式不同：

| | `section()` | `context()` |
|---|---|---|
| 是什么 | 系统提示的一段 | 文档原话：*"Dynamic model context materialized as a **durable user-role snapshot**"* |
| 落进会话的形状 | `system/message` 事件 | `form: 'snapshot'` 的**用户角色消息**，带 `sections`（按贡献者名字分开） |
| 内容变了以后 | `SystemPromptProjection.project()`：`inHistory` 时追加一条新的，否则**替换**头一条 | 只在与上次留存的那份不同时才产出一条新快照 |

所以「进不进日志」——**两条都进**。这不是照文档抄的，是读 `dsh-agent-loop/lib/index.js` 里的
`SystemPromptProjection` 与 `createUserMessage({ source: { kind: 'plugin', form: 'snapshot', sections } })`
两段实现得到的。

**但把每轮都变的读数放进系统提示是错的**，而这个理由旧仓已经用真金白银买过一次
（`live_state_mw.py` 的 `_apply` docstring，2026-07-28 审计）：

> 实时块原来追加在系统消息末尾，而 prompt cache 的断点正好打在那个末尾 ⇒ 断点落在
> **易变文本之后**，工具块命中缓存，系统消息与**整段历史每一轮全 miss**，还要为一个
> 永远不会复用的前缀付写入溢价。修法：系统消息保持逐字节不变，易变块改挂**最后一条
> human 消息**。

上游把这条路做成了一等公民（`context()`），两边的结论是同一个。

**这条改变了什么**：PLAN §3.1-5 备的退路（自己在 `agent/pre-step` 注入 user-role 块）**不用了**
——不是退路不成立，是上游已经提供了同一件事，而自己注入等于绕开 `sections` 的贡献者归属。
`packages/instrument/instrument-state/src/plugin.test.ts` 里对**真** `SystemPrompt` 装配了一遍，
把「我们那块确实进 assembly、且每次组装现取」钉住了。

## ✅ 9 · `webServer` 支持流式，SSE 是上游明写的用法

`WebRoute.handler` 的文档原话：

> Owns the full response lifecycle (**may hold the response open, e.g. SSE**).

另外还有 `registerUpgrade({path, handler(req, socket, head)})`——WS upgrade 也有。
所以 PLAN §13 备的「退化成轮询」退路**用不上**。

**不是照文档抄的**：`packages/client/stm-ui/src/plugin.test.ts` 里起一份**真的 `WebServer`**
（`port: 0` 让 OS 分配），用真 `http.get` 打它，验了四件事——响应头与首帧、
逐条推送、`Last-Event-ID` 续传只补没看过的、心跳注释行会来。

**这条顺带确认了一件更要紧的事**：`EventSource` 断线重连会**自动**把上次的 `id:`
放进 `Last-Event-ID` 请求头。所以「杀宿主重启 5 秒内续传无缺口」这条验收
**不需要客户端记任何东西**——续传是浏览器内置行为，我们只要把 `id:` 写对。

## ⏸ 未查的三条与各自的触发点

按消融原则，没到用的时候不查——查了也只是纸面结论，而且 dsh 一天一版，结论会先于用途过期。

| # | 触发点 |
|---|---|
| 4 · replay 是否短路工具执行 | Phase 2 做 dsh replay 测试时（PLAN §12「replay 时工具不得触碰仪器」） |
| 8 · `conversation.view` / `details` / `toolview` | 课时 1.10（U0 右栏卡）与 U1（审批卡）。需要客户端 bundle 机器，那时一并 |
| 10 · 子会话读父 session id / `agents.resume` / 压缩钩子 | Phase 6 的 subagent 编排。**注意**：0.1.3 已把 session 持久化改成 `SessionHandle`、`agentLoop.create()` 变异步（facts.md §8.0），现在查了升级后也要重查 |
