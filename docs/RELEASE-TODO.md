# 离「发布」还差什么

> 写于 2026-09-20。目标：**尽快把这个仓库公开**，作为求职材料可被审阅。
> **发布不等技能移完，也不等它能跑起来。**
> 能不能跑是 `MINIMUM-RUN-TODO.md`；技能还差多少是 `MIGRATION-TODO.md`。
>
> 接手的人/智能体：这份文件按**优先级**排，每一条都给了「做什么 / 怎么算完 / 风险」。
> 打勾请改这份文件，不要只在别处记。

---

## 0. 「发布」在这里指什么

**最小集：把 `HamsterPark/dsh-spm` 从 private 改成 public，并且不外泄任何私密内容。**

不包括（**明确排除，别顺手做**）：

- ✗ 发到 npm —— 那要求它装得上，是下一步
- ✗ 技能移完 —— 442/515，可达上限 502，见 `MIGRATION-TODO.md`
- ✗ CI 能跑集成测试 —— B11，需要给 STM-Bench 建远端
- ✗ 真机 —— Phase 8，与发布无关

**理由**：审阅者看的是**工程判断**，不是完成度。一个诚实标注了「这里还没通」的仓库，
比一个把没通的地方藏起来的仓库更可信 —— 而且 AI 扫描会读出后者。

---

## 1. 🔴 发布前必须做（阻塞）

### 1.1 私密内容不外泄 —— **这一条做完之前不要点 public**

| 查什么 | 怎么查 | 期望 |
|---|---|---|
| 本地private review archive没进 git | `git log --all --diff-filter=A --name-only \| grep -i 'private review archive\|02-求职\|研究快照'` | 零命中 |
| 旧仓内容没进历史 | `git log --all -S'MASTv2' --oneline -- . \| head` 逐条看，只应出现在**路径字符串**里（导出器指向旧仓），不应有旧仓的**代码** | 只有路径 |
| 个人信息 | `git log --format='%ae' \| sort -u` | 只有 GitHub noreply 或你愿意公开的邮箱 |
| 绝对路径 | `grep -rn 'D:\\\\<user>' --include=*.ts --include=*.py --include=*.md . \| grep -v node_modules \| wc -l` | 有，且**可以留** —— 它们是导出器指向只读旧仓的路径，是事实。但要在 README 说明一句 |
| 大文件 / 权重 | `git ls-files \| xargs -I{} du -k {} 2>/dev/null \| sort -rn \| head -20` | 没有 ONNX/权重（B9：权重不入仓） |

**完成判据**：上面五行逐条跑过并把结果贴在本节下面。

> ⚠️ 历史里一旦有过私密内容，改 public **等于公开它**。
> 如果第 1/2 行有命中，**先别公开**，用 `git filter-repo` 或干脆新建一个干净仓库重推。

### 1.2 README 重写（对外第一眼）

现有 `README.md` 81 行，是开工期写的，**没有今天的状态**。要有：

1. 一句话：这是什么（把「6 台真机 / 数十小时无人值守 / 从自建 Harness 迁到 dsh 插件」说清）
2. **诚实的状态表**：技能 442/515（可达 502）、测试 7445、变异 879、偏差 228；
   **并明写「作为插件尚未在真 dsh 里装起来过」**
3. 为什么这些数可信 —— 三句话版的方法论，指向 `AGENTS.md`
4. 目录导览
5. 怎么跑测试（`pnpm install --frozen-lockfile && pnpm build && npx vitest run --project unit --project contract`）
6. 一句「`docs/` 里三份 TODO 写着还差什么」

**完成判据**：一个没见过这个项目的人读完 README，能答出「它是什么」「哪些数可信」「哪里还没通」。

### 1.3 LICENSE 与署名核一遍

- `LICENSE` 已在（21 行），署名应为 `Copyright (c) 2026 HamsterPark`
- 各 `package.json` 的 `author` 与它一致
- **完成判据**：`grep -rn 'author' packages/*/*/package.json | sort -u` 只出现一个署名

### 1.4 仓库门面

- 顶部简介一行、topics（`stm`、`scanning-tunneling-microscopy`、`llm-agent`、
  `scientific-instruments`、`typescript`）
- ⚠️ **不要开 Issues/Discussions 模板**之类的——那是维护中项目的信号，这里不需要

---

## 2. 🟡 发布后一周内（不阻塞公开，但很影响第一印象）

### 2.1 一张「它在做什么」的图或一段 30 秒的说明

审阅者对 STM 没有直觉。用两三句把这件事讲清：

> STM 是部分可观测、强非线性、非平稳、且**状态会被自己的操作改变**的系统。
> 操作经验以隐性知识存在。所以这套东西做的不是「给仪器加一个 API」，
> 是**把仪器操作知识变成可检索、可调用、可验证的技能**，
> 并给每一条技能配一道能自己变红的闸。

### 2.2 `docs/EXECUTION.md` §1 太长了（900+ 行）

它是实施日志，价值很高但对新读者是墙。
**加一个 20 行的「如果你只读一节」**放在最前面，指向那几条最硬的教训。
（不要删，那些教训是这个仓库最值钱的部分。）

### 2.3 CI 徽章 + 一句限定

CI 现在只跑 `unit` + `contract`。README 要写明：
**「CI 绿 ≠ 对着真模拟器绿」** —— 集成测试要 STM-Bench 的 stmsim，那个仓库没有远端（B11）。

---

## 3. 🟢 明确不做（写下来，免得有人顺手做）

| 不做 | 为什么 |
|---|---|
| 发 npm | 要求装得上（B10 从没验过）。见 `MINIMUM-RUN-TODO.md` |
| 补齐技能 | 发布与完成度无关；而且 13 个 D 档**永远不做** |
| 给 STM-Bench 建远端 | B11，属于「让 CI 有意义」，不属于发布 |
| 清理 `.claude/worktrees/` | 已 gitignore，不进公开历史。（但**本地**可以 `git worktree remove` 回收几百 MB） |
| 改 `docs/handoff/` 的历史交接 | 它们是**那一天的快照**。要订正就加注，不要改原数 |

---

## 4. 发布当天的顺序

```
1. 跑 §1.1 那五行检查，贴结果          ← 不过就停
2. 重写 README（§1.2）
3. 核 LICENSE 与 author（§1.3）
4. npx vitest run --project unit --project contract   ← 最后绿一次
5. git push
6. Settings → Change visibility → Public
7. 加简介与 topics（§1.4）
```

**第 1 步不过就不要往下走。** 公开是不可逆的。

---

## 5. 状态

- [ ] 1.1 私密内容检查（五行）
- [ ] 1.2 README 重写
- [ ] 1.3 LICENSE / author
- [ ] 1.4 简介与 topics
- [ ] **公开**
- [ ] 2.1 「它在做什么」
- [ ] 2.2 EXECUTION 导读
- [ ] 2.3 CI 限定说明
