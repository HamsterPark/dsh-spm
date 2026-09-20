# AGENTS.md —— 在这个仓库里怎么干活

> 这份文件是给**在本仓库里写代码的智能体**看的（Claude Code / Codex / Cursor 皆可），
> 也顺带回答「这是什么、哪些数可信、哪些还没做」。
> 读完它应当能独立开一批活，而不需要先问人。

---

## 0. 一句话

`dsh-spm` 把一套已经在 **6 台真实 STM（扫描隧道显微镜）上跑了数十小时无人值守**的
仪器控制软件，从 Python 迁移成 **DeepSeek Harness（dsh）的插件**：
舍弃自建 Harness，只留**仪器连接**与**科学技能库**两件事。

原仓（`MAST`，Python/LangGraph，515 个技能）**原样保留、继续给真机发版**，
在本仓里它只有一个身份：**只读的规格书**。

---

## 1. 今天的状态（2026-09-20，每个数都有一把能当场跑的尺子）

| 项 | 数 | 尺子 |
|---|---|---|
| 技能已移植 | **442 / 515** | `spec/progress.json`（`pnpm gen:progress` 生成） |
| 模块整模块收口 | **112 / 165** | 同上 |
| 单测 + 契约 | **7445 条 / 118 文件**，全绿 | `npx vitest run --project unit --project contract` |
| 对真模拟器的集成测试 | 约 100 条 | `--project integration`（要 `STMSIM_PYTHON` / `STMSIM_ROOT`） |
| 变异演练 | **879 条**，最近两次合并后重跑 **119/119 + 167/167 全红** | `MUTATE=1 node tools/mutate/run.ts`，日志在 `docs/handoff/drill-*.log` |
| 偏差登记 | **228 条** | `grep -c '^## D-' spec/deviations.md` |
| 金样 | 47 份 `.json`，44 台导出器，重跑逐字节相同 | `ls spec/golden/*.json`｜`ls tools/spec-export/export_*.py` |

**两个上限，比进度更重要：**

- 515 **到不了**。三份盘点点名的 **13 个技能是 D 档**（架构上就不要：`optics_*` 十个、
  三个 `model_path` 必填且零回退的深模型技能）⇒ 技能可达上限 **502**。
- 165 **也到不了**。5 个模块含 D 档技能 ⇒ 模块可达上限 **160**。

**它今天装不上。** 见 `docs/MINIMUM-RUN-TODO.md`。
测试全绿说的是「判据对着旧仓一致」，**不是**「作为插件能在真 dsh 里跑起来」——
这两件事在本仓是分开验的，而后者**一次都没验过**。

---

## 2. 为什么上面那些数可信 —— 方法论

这是本仓最值得看的部分。整套方法只服务一件事：**让失败长得像失败**。

### 2.1 金样驱动（golden-driven）

判据的期望值**不是人写的**，是**驱动旧仓真实实现跑出来的字节**。

- 每一族判据配一台导出器（`tools/spec-export/export_*.py`），它 import 旧仓的真函数、
  喂合成输入、把整棵结果录成 JSON。
- 纪律：`allow_nan=False` · `sort_keys=True` · LF · **重跑逐字节相同**（每次导完自己 `cmp` 两遍）。
- ⇒ 「我记错了」会变成红，而不是变成一个看起来合理的数。

> **一格分辨不出两种候选的金样不是判据。**
> 造金样时要先问：这一格能不能把「对的实现」和「我可能写出的那个错的实现」分开？

### 2.2 每个技能的完成定义（DoD）

① 规格对齐（参数名/类型/必填性 vs `spec/golden/skills.json`）·
② **面向模型的回包逐字对齐**（字段名、拒绝文案——模型读的就是这些）·
③ 每个错误分支一条单测 · ④ 对真模拟器的集成测试 · ⑤ 差分（金样）·
⑥ 变异演练 · ⑧ `pnpm gen:progress`

**DoD ⑤ 有一条例外**：旧仓自带的缺陷**不照抄**，但必须在 `spec/deviations.md` 里
写清「为什么不照抄」和「**改回去需要什么证据**」。

### 2.3 变异演练：四判据 + 五种收场

覆盖率回答「这一行跑过没有」，**回答不了「这一行做过决定没有」**。所以每一道闸配一条变异
（`tools/mutate/mutations.ts`，879 条），把闸拆掉，看有没有测试喊。

一条变异判 `red` 要同时满足：

1. 替换串**唯一命中**并写回后能读到；
2. `tsc -b` 退出 0（**编译不过的变异问不出「这道闸在不在挡」**）；
3. 声明的 `scope` 覆盖被变异的文件，且那一趟真的打出了 `Tests` 汇总行；
4. **开跑前基线为 0** —— 有一个 scope 在干净树上就红，**整趟拒跑**。

判词四种（`red` / `green` / `inconclusive` / `narrow-scope`），加上「基线不干净整趟拒跑」
共**五种收场**。`green` 不许放过 —— 去 `docs/handoff/green-8.md` 对三种形状，
**改判据，不是改结论**。

### 2.4 偏差登记（228 条）

两仓行为不一致的每一处都有编号（`D-<族>-<序号>`），正文写：现象 · 为什么 ·
**改它需要什么证据**。支线里编号**留 `?`**，合并时由主线统一编 ——
一个族编出多个号时，引用处必须**逐条按上下文映射**，机械替换会全指到第一个。

### 2.5 封锁账按**闭包**算

`packages/host/stm-skills/src/l0/tip-phase-deps.test.ts` 记「谁在等谁」。
它曾经只记**一层**，于是「某个封锁件自己还有封锁件」这一维它不会喊。

> **一个会自己失效的判据，只在它记全了的那一维上会自己失效。**
> 在没记的那一维上，它和一张手抄清单没有区别 —— 而它看起来比手抄清单可信。

现在导出器扫整棵 `mast/skills/**`，追**两条边**（`context.run(...)` 与
`CompositeStep(skill_name=…)`；实测 299 处 vs 63 处，**只追后者覆盖约五分之一**），
求不动点。追不动的（动态名、循环变量、编排引擎本身）**必须显式列进 `closure_limits`**：

> **一条假的边界比没有边界更坏：它把「我们追不到」和「旧仓真的没有」写成同一句话。**

---

## 3. 红线（违反即作废）

1. **旧仓 `<MAST_ROOT>\` 只读。** 它还在给 6 台真机发版。
   任何导出器都必须 `os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(...))`，
   跑完用 `find <旧仓> -newermt <开跑时刻>` 自证没写过它。
2. **除 `packages/host/compat/src/` 外，任何文件不许出现 `from '@deepseek-ai/`。**
   上游接触面收在防腐层里，别处一律走 `dsh-spm-compat`。
3. **真机 0 次，直到 Phase 8。** `profiles/mast-rig` 在那之前**不存在于本仓库** ——
   真机 0 次是**仓库结构**，不是纪律；纪律会松，结构不会。
4. 研究快照与旧仓内容**不进本仓 git 历史**。

---

## 4. 开工前三条自检

1. `npx npm view @deepseek-ai/dsh dist-tags --json` —— 与 `docs/dsh/facts.md` 首行一致吗？
   （追踪对象是**所有 dist-tag 里 semver 最大的那个**，不是某个固定标签名。
   alpha 通道按规矩**只读发布说明、把影响记进 `facts.md`，不升**。）
2. `git status` —— 上一段收干净了吗？
3. 这一段的验收命令是什么？

---

## 5. 并行支线的规矩

多条支线同时开工时，**先在共享文件里落锚点再分叉**。

- 锚点长这样：`// ── 批 8a-1（<干什么>）在这一行下面加 import ──`
- **两处改动之间至少隔一行谁都没改的**（在 scratch 仓里量过：相邻→冲突，隔一行→干净合并）。
  ⚠️ 锚点**按行距起作用，不按名字** —— 三个锚点挤在五行里，对 git 来说是一个。
- 当前锚点覆盖**九个**共享文件：`tools/mutate/mutations.ts` · `spec/deviations.md` ·
  `spec/golden/README.md` · `packages/host/{vision,kernel,numerics}/src/index.ts` ·
  `packages/host/stm-skills/src/l0/index.ts` · `scripts/gen-skill-specs.ts` ·
  `tools/spec-export/export_skill_traces.py`
- **支线自己补的锚点，下一轮要收进正式锚点集**（后两个就是这么来的）。

### 合并的三条

- **权威的冲突清单是 `git diff --name-only --diff-filter=U`**，不是合并输出的尾巴。
  不要 `tail` 一次合并的输出 —— 冲突清单没有「摘要」这回事。
- **生成物的冲突可以机械处理，手写文件的不行。** 生成物（`spec/progress.json` ·
  `packages/host/stm-skills/src/generated/specs.ts` · 金样）一律**重生成 / 重导出**。
- **「两边都留」不是默认解。** 两条支线各删掉了不同的东西时，正解是**删除的并集**；
  两条支线给同一件东西起了两个名字时，正解是留一个。
  **合并是唯一一次两份平行造出来的东西并排出现的时刻** —— 别浪费它。

---

## 6. 几个会咬人的顺序与工具

- **`gen:skills` → `tsc -b` → `gen:progress`。** `scripts/build-progress.ts` 读的是
  **编译产物** `lib/generated/specs.js`；顺序反了它会报出一堆假的 `partial`。
- **数清单的条数要问那个真读它的程序**，不要 `grep -c`（会被引号、点、连字符骗）。
- **说「某文件已入仓」，证据只能是 `git ls-files` 或 `git show --stat` 里那一行。**
  `ls` / `wc` 读的是工作树 —— `.gitignore` 里的 `*.log` 曾让一句「日志入仓」假了近四小时。
- **`String.replace` 的替换串里 `$'` 不是字面量**（= 匹配之后的全部内容）。
  拼接脚本里替换一律写成函数式 `() => x`。
- **去掉一个文件要用「移出去」，不要用「列其余」** —— 后者把「我没列到的」和
  「我排除掉的」变成了同一件事。

---

## 7. 目录导览

```
packages/host/        宿主侧（纯逻辑，不碰网络）
  kernel/             安全闸、SI 解析、仪器档案、地图层、技能内核
  numerics/           numpy/scipy 的逐位等价件（FFT、插值、拟合、RNG）
  vision/             图像判据（平场、晶格、台阶、针尖度量、scan_prep 链）
  stm-skills/         技能本体（l0/ 单技能，composite/ 组合流程）
  stm-safety/  stm-records/  nanonis-files/  compat/
packages/instrument/  仪器侧（TCP、协议、状态缓存、看门狗、模拟器 provider）
packages/client/      前端
packages/bundle/      dsh 插件打包入口

spec/golden/          金样（由 tools/spec-export/*.py 从旧仓导出）
spec/deviations.md    偏差登记，228 条
spec/progress.json    进度（生成物）
tools/mutate/         变异演练
docs/EXECUTION.md     分段执行计划 + 实施日志（§1 是最近发生了什么）
docs/handoff/         每一批的交接、三份分族盘点、演练日志
docs/dsh/facts.md     上游 dsh 的事实速查与版本决策
```

---

## 8. 还差什么

三份 TODO，写给接手的人（也写给接手的智能体）：

- **`docs/RELEASE-TODO.md`** —— 离**发布**还差什么（最小集：公开仓库，**不等技能移完**）
- **`docs/MINIMUM-RUN-TODO.md`** —— 离**最小限度跑起来**还差什么（这是真正的技术阻塞）
- **`docs/MIGRATION-TODO.md`** —— 技能迁移还差什么（60 个可移 + 13 个永不移）

---

## 9. 这个仓库反复在讲的几句话

> **让失败长得像失败。**
>
> 覆盖率回答「这一行跑过没有」，回答不了「这一行做过决定没有」。
>
> 一格分辨不出两种候选的金样不是判据。
>
> 「按函数级追」说了按什么单位追，**没说追多深** —— 追一层得到的仍是一份会漏的清单。
>
> 一个数抄进散文的那一刻，它就从「测量」变成了「记忆」。
>
> 坏掉的尺子不报错，它给你一个数。
