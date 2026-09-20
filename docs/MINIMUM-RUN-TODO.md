# 离「最小限度跑起来」还差什么

> 写于 2026-09-20。这是**真正的技术阻塞**，与发布无关（发布见 `RELEASE-TODO.md`）。
>
> 今天的事实：开发态已经记录过插件装载、`apply` 执行、依赖注入与工具进入宿主注册表；
> tarball/npm 分发安装、真实模型调用和端到端运行仍未验证，客户端层还有 B12 阻塞。
> 单元／契约测试只覆盖各自声明的判据；当前远端 CI 状态见 `RELEASE-TODO.md`。

---

## 0. 「最小限度跑起来」的定义

按**从弱到强**四级。建议先拿下 L1，它就足以支撑一句真话。

| 级 | 定义 | 验收 |
|---|---|---|
| **L0** | 打得出包 | `pnpm pack` 出 tarball，不报错 |
| **L1** | **装得上、启动不崩** | 干净 `DSH_HOME` + 新 profile，`dsh plugin add <tarball>`，`dsh --dump-config` 里看得见我们这一层，`dsh --profile ...` 启动不退出 |
| **L2** | 模型看得见工具 | 一次真模型调用里 `stm_hello` 出现在工具目录并被调用 |
| **L3** | 对着模拟器做一件真事 | 接上 STM-Bench 的 stmsim，模型调一个只读技能（如 `GetBias`）拿到数 |

---

## 1. 已经查实的四件事（不要重新查）

### 1.1 B7 ✅ 已证：`dsh plugin add <本地目录>` 用 `link:`

pnpm **完全不解析我们的 `dependencies`** —— `workspace:*` 从没被求值，peer 精确钉也没执行。
实测后果：运行时 compat 解析到的是**本仓那份** `dsh-tools`，于是**一个进程里活着两份模块实例**。

今天两份同版所以没事；`defineTool` 是纯工厂也不在乎。
**会出事的是依赖模块身份的东西**：`instanceof`、模块级单例、Cordis `Service` 类身份。

### 1.2 B10 ⛔ 未验：安装态（npm / tarball）走的是**另一条**解析路径

发布路径上 profile 的 pnpm 会**真的**解析依赖、执行 peer 钉，只剩一份实例 ——
**和我们每天跑的不是同一件事**。这条路**一次都没走过**。

⚠️ 2026-09-20 新情况：上游 `0.1.6-alpha.2` 新增了 **`@deepseek-ai/dsh-plugin-manager`**。
我们整个交付物就是一个插件，而这个新包正落在这条没测过的路上。
（本仓仍锁 `0.1.5-rc.2`，alpha 按规矩只读不升 —— 见 `docs/dsh/facts.md` §8.-4。）

### 1.3 B12 ⛔ 未解：客户端包进不了 profile

实测警告逐字：`declares no dsh.bundle — installed as a plain dependency, not a profile layer`。
客户端模块必须**经由一个 bundle** 进来，而 dev 态 `link:` 下 profile 的 pnpm 不解析我们的
workspace 依赖（同 B7）。子路径导出那招不适用 —— 客户端模块要有自己的 `package.json`
与 `dsh.client` 元数据。

**与 B10 同根。先解 B10。**

### 1.4 B6 ◐ 半结清：工具进了宿主注册表，但「模型看不看得见」没验过

已证：插件被装载、`apply` 执行、`inject:['tools']` 得到满足、工具进了**宿主** `tools` 注册表
（探针实测 `ctx.tools === object`）。
未证：**模型是否真能看见它** —— 那需要一次真实模型调用（要 API key、要花钱）。
`facts.md §3` 抄的 preset 注释说「合并后的目录也包含部署全局注册的工具」，倾向于会看见。

---

## 2. 建议的执行顺序

### 第 1 步 · L0：`pnpm pack`（半小时级）

```
pnpm -r pack        # 或只打 packages/bundle/dsh-spm
```

**看什么**：`packages/bundle/dsh-spm` 的 tarball 里有没有 `dsh.bundle` 字段、
`files` 白名单有没有漏掉 `lib/`。

**风险**：workspace 依赖在 tarball 里会变成 `workspace:*` 这种装不上的版本号 ——
这正是 B10 要暴露的东西。**如果这里就炸了，那是好事**：它把问题提前到了最便宜的地方。

### 第 2 步 · L1：装进一个干净 profile（这是**唯一的硬阻塞**）

```
$env:DSH_HOME = "<一个临时目录>/home"        # 绝不要碰你自己的 ~/.dsh
dsh plugin --profile mast-sim add <tarball 的路径>
dsh --profile mast-sim --dump-config          # 不启动，只打印组合树
dsh --profile mast-sim                        # 真启动
```

**逐级看**：

| 现象 | 说明什么 | 怎么办 |
|---|---|---|
| `add` 直接失败，抱怨 `workspace:*` | B10 现形 | 把 workspace 依赖在打包时换成精确版本（`pnpm pack` 的 publishConfig / 或先把各包发到一个本地 verdaccio） |
| `add` 过了但 `--dump-config` 里没有我们这一层 | `dsh.bundle` 元数据没对 | 对照 dsh 自家包（`dsh-base` / `dsh-web-app`）的 `package.json` 的 `dsh` 段 |
| 启动崩在 Cordis Service | B7 那两份模块实例 | 安装态本应只剩一份；若仍两份，说明 peer 钉没生效 |
| 启动崩在客户端层 | B12 | **先把客户端整个摘掉**（见下）—— L1 不需要前端 |

> 💡 **最小可行的取舍**：L1 只需要**宿主侧**。
> 如果客户端（B12）挡路，先做一个**只含宿主的 bundle** 发出去 ——
> 「能装上、能启动、工具在注册表里」已经是一句站得住的真话，而前端不是。

### 第 3 步 · L2：一次真模型调用（要 API key）

跑起来之后让模型调 `stm_hello`。**只要它出现在工具目录里并被调用一次，B6 就结清了。**

### 第 4 步 · L3：接模拟器（可选，最贵）

需要 STM-Bench 的 stmsim（`STMSIM_PYTHON` / `STMSIM_ROOT`）。
本仓 `--project integration` 已经这么跑了约 100 条，所以**接口是通的**；
L3 多出来的只是「经由真 dsh 与真模型」这一层。

---

## 3. 已知会咬人的地方

- **`npx @deepseek-ai/dsh` 裸跑会装到 `latest`**，而本仓锁 `0.1.5-rc.2`。
  **所有 dsh 命令必须带版本号。**（`latest` 的指向随时会变；prerelease 的 `^` 范围
  在同一 x.y.z 元组内会跨 alpha→rc 通道。）
- **`overrides` 不能按 `@deepseek-ai/*` 通配**（B4 实测：静默无效，什么都不做）。
  必须逐包精确钉；`scripts/check-dsh-pin.ts` 是**唯一能抓住这种静默失效的东西**，别删它。
- **不要碰你自己的 `~/.dsh`。** 全程用临时 `DSH_HOME`。
- **`workflow` 从 worker-thread 换成了 `ptc`**（alpha.1），而 `dsh-jobs-local`（长时 job）
  在它上面。真要升 0.1.6 之前先确认 `ctx.jobs` 的取消语义没变。

---

## 4. 如果时间只够做一件事

**做第 2 步的前半段：`pnpm pack` + `dsh plugin add` + `--dump-config`。**

它不需要 API key、不需要模拟器、不需要前端，**半天之内能给出一个明确的是或否**，
而那个是/否决定了 B10 / B12 两条决策怎么写。

今天这两条的状态是「未测」。**把「未测」变成「测了，结果是 X」，比再移十个技能有价值。**

---

## 5. 状态

- [ ] L0 `pnpm pack` 出包
- [ ] L1 装进干净 profile 并启动（**唯一硬阻塞**）
- [ ] B10 记档：安装态到底走通没有
- [ ] B12 记档：客户端摘掉之后是否还挡路
- [ ] L2 真模型看见 `stm_hello`（B6 结清）
- [ ] L3 对着 stmsim 做一件真事
