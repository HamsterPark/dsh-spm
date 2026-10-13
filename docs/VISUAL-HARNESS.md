# 视觉线束：以图像为主的感知通道

**状态：设计文档，§6 第 2–4 步已实现（2026-10-13），尚未挂进 bundle 与 profile。** 2026-10-09 起草，对应 [PLAN](PLAN.md) 决策 D12。本文改变的是计划，不改变任何已验收的运行范围；当前可运行能力仍以 [README](../README.md) 与运行指南为准。

## 0. 一句话

模型的主感知通道从「视觉模型的输出 → 文本摘要」改为 **「渲染后的帧图像 + 会话内无损的帧记忆 + 精确读值 + 只测量不下结论的测量工具 + 模型自己写的笔记」**；改变仪器状态的动作遵守「一动一观」。深度视觉模型（DINOv3 的 ONNX 推理，原 Phase 8）不再是感知主干，降为可选的顾问工具，是否保留由消融实验决定。

## 1. 为什么改

### 1.1 VISTA 的结果

Han、Hu、Qiu、Wu、He 的 VISTA（[arXiv 2610.02200](https://arxiv.org/abs/2610.02200)，代码 [github.com/joshhhhhan/VISTA](https://github.com/joshhhhhan/VISTA)，MIT）给前沿多模态模型加了一层「视觉线束」，不训练任何视觉模型，在 ARC-AGI-3 的 25 个公开交互游戏上把 Claude Opus 5.0 的 RHAE 从 40.68 提到 100.00。论文对 GPT-5.6 Sol 的逐项消融：

| 配置 | RHAE |
|---|---|
| 官方接口（文本数字网格） | 13.33 |
| 改为 PNG 图像观测 | 47.32 |
| 放宽动作与时间预算 | 51.66 |
| 连续对话 + 原生压缩 | 65.82 |
| + 笔记（GUIDE.md / WORKING.md） | 70.05 |
| + 无损视觉记忆与 `inspect` | 94.10 |
| + `read_pixels` 精确读像素 | 99.00 |

两个最大的增益来自「图像替代文本」和「可以回看任意历史帧」。同一线束在其他游戏与视觉问答基准上也有提升；作者明确指出线束只能激发基座模型已有的能力。

### 1.2 对 STM 意味着什么

- **文本中间表示会丢信息。** 视觉模型在编码时不知道后面哪处细节会变重要；压成一两句话后，模型无法再回头看。VISTA 的消融说明，让模型自己反复回看原始帧比一次性的摘要强得多。
- **前沿模型在计数、测距、细微变化上不可靠。** 公开评测给出一致结论：低层几何与计数（[arXiv 2407.06581](https://arxiv.org/abs/2407.06581)）、把比例尺换算成尺寸（[arXiv 2510.26865](https://arxiv.org/abs/2510.26865)）、噪声与纹理的细微变化（[arXiv 2609.06245](https://arxiv.org/abs/2609.06245)、[arXiv 2605.29615](https://arxiv.org/abs/2605.29615)）都是弱项；把两张图拼成一张比分开给更差（[arXiv 2603.07888](https://arxiv.org/abs/2603.07888)）。因此数值必须由工具计算，图像负责判断与发现异常。
- **现有 SPM 智能体几乎都只给模型文本。** 公开的 AFM/PFM/STM 智能体把图像变成描述子、数值或代码分析结果再交给模型（例如 [arXiv 2609.04015](https://arxiv.org/abs/2609.04015)、[Nat. Commun. 16, 9104 (2025)](https://doi.org/10.1038/s41467-025-64105-7)、[arXiv 2602.20669](https://arxiv.org/abs/2602.20669)）。目前唯一公开的前沿模型真机 STM 智能体（[arXiv 2609.27302](https://arxiv.org/abs/2609.27302)）的几次失败，是由人比较操作前后的帧才诊断出来的——这正是「回看历史帧」要给模型的能力。尚无公开工作在闭环 STM 任务上对比「编码器 → 文本 → 语言模型」与「原图 → 多模态模型」。
- **对本仓的计划：** PLAN 原本在 Phase 3 让帧以附件形式内联可见，在 Phase 8 用 `onnxruntime-node` 跑 DINOv3 视觉模型。该模型在真实帧上的表现尚未在本仓验证；把它放在感知主干上，等于让一个未验证的中间表示决定模型能看到什么。本设计把图像本身放到主干上，深度模型改为可被消融的选项。

## 2. 决策 D12 的内容

1. **图像是观测。** 产生帧或谱的技能，结果里带当前观测图（PNG，整数倍最近邻放大，不平滑）；图内不画文字，帧号、尺度、坐标与数值放在相邻文本块。
2. **无损视觉记忆。** 会话内每一帧（全部通道、正反扫、扫描中途的快照）与每条谱都按编号无损入档，永远可取回；只有当前观测自动进入上下文。
3. **回看与读值是工具。** 模型用 `stm_inspect` 取回任意历史帧、裁剪放大、换通道或换去衬底方式重渲染，用 `stm_read_values` 读取物理量（pm、pA、Hz）。
4. **测量只测不判。** 剖面、FFT 峰、斑点、帧间差分与配准、统计等由工具计算；「双针尖」「已原子分辨」之类的结论只能来自模型自己。
5. **一动一观。** 改变仪器状态的工具，在上一次结果进入模型上下文之前拒绝执行；提示模型每次动作前写预期、动作后报告全部可见变化。
6. **笔记由模型自己写。** `GUIDE.md`（本会话持久的仪器、针尖、样品认识）与 `WORKING.md`（当前计划与状态）；上下文压缩前先保存 `WORKING.md`。
7. **深度视觉模型降为可选。** `vision-onnx` 与经典检测器的输出只经 `stm_advisor` 按需提供或作为看门狗事件，不再以摘要形式常驻提示。

## 3. 对现有计划的影响

| PLAN 章节 | 原内容 | 修订 |
|---|---|---|
| D1 | 唯一例外：深度视觉模型的 ONNX 推理 | 仍允许，但不再是计划必需项（D12） |
| §6.2 文件树 | 无帧档案；`vision-onnx` 为 Phase 8 交付 | 新增 `dsh-spm-visual-memory`；`vision-onnx` 标为可选 |
| §7 能力接缝 | 无 | 新增 `ctx.frameArchive`（§4.1） |
| §8.1 K14 | 图像 `attachments.save` → `imageRefs` | 同时入档并返回当前观测图（§4.6） |
| §11 Phase 3 | 帧内联可见 | 帧档案 + `stm_inspect` / `stm_read_values`；IC 使用支持图像的模型 |
| §11 Phase 4 | 分析与视觉 | 测量工具以 `vision` / `numerics` 的已迁移实现为基础 |
| §11 Phase 5 | 记忆 | 笔记工具与压缩前检查点 |
| §11 Phase 8 | `vision-onnx`（DINOv3 导出） | 可选；仅当消融显示增益时实施 |
| §12 验证 | 数值金样、差分 | 增加与 Python 参考实现的视觉线束金样，以及 STM-Bench 消融结果 |

## 4. 设计

### 4.1 新包与接缝

`packages/host/visual-memory`（`dsh-spm-visual-memory`）提供 Service `ctx.frameArchive` 和一组模型可见工具。依赖 `dsh-spm-nanonis-files`（读 .sxm/.dat）与 `dsh-spm-numerics`（插值、高斯、中值滤波、连通域等）。测量工具需要而 `numerics` 没有、或数值行为与参考实现不同的部件（FFT、SciPy 的 `least_squares` 与 Nelder–Mead、三阶样条平移）按参考实现移植在本包内，以后收进 `numerics`；不依赖 `dsh-spm-vision`。dsh 的附件与图像内容块只经 `dsh-spm-compat` 使用（AGENTS 约束 3）。

`ctx.frameArchive` 的接口：

| 方法 | 作用 |
|---|---|
| `addScan(turn, path, meta)` / `addSpectrum(turn, path, meta)` / `addPartial(turn, arrays, meta)` / `addDerived(turn, png, meta)` | 入档，返回帧条目 |
| `get(id)` / `frames(filter)` / `latest(kind)` / `index()` | 查询 |
| `array(id, channel, direction)` | 原始物理量数组（`Float32Array` + 形状） |
| `render(id, options)` | 重渲染为 PNG 与渲染元数据 |
| `observation(id)` | 当前观测图（标签 + 图像） |

存储：会话目录下 `index.jsonl`（只追加）与每帧一份无损数组文件和默认渲染 PNG；进程重启后从索引恢复。帧数据是持久真源，不依赖 session log。

**每个 dsh 会话一份**（2026-10-13 实现）：插件的 `config.root` 下，`sessions/<会话>/frames` 与 `sessions/<会话>/notes` 是一个会话的帧档案与笔记；`<会话>` 是发起调用的 agent 的会话 id（`exec.agent.id`），普通名字原样用，其余换成可读前缀加 SHA-256 的 16 位（`sessionDirName`）。同一会话恢复时（同一进程或之后的进程）找回自己的帧与笔记，两个会话互不可见；没有 agent 的调用（测试、宿主直接调用）仍用 `<root>/frames` 与 `<root>/notes`。插件在宿主层的 `tools/execute` 上用 AsyncLocalStorage 记下调用所属的会话；服务的 `archive` / `notes` 是调用时才解析的 getter，服务上的每个方法（`addScan`、`addSpectrum`、`get`……）都经过它们，所以 `ctx.frameArchive` 作用于发起调用的会话。工具的 deps 也是 getter——工具必须在 `execute` 里读 `deps.archive` / `deps.notes`，不要在定义时存进闭包；指定某个会话用 `ctx.frameArchive.session(id)`。agent 销毁时只关掉打开的档案，文件留着。依据见 [dsh 事实](dsh/facts.md) §9.7。

### 4.2 帧与编号

帧编号 `t<turn:04d>.<kind><i>`：`s` 保存的扫描帧，`p` 扫描进行中的快照，`d` 谱，`m` 测量工具产生的派生图。`turn` 是产生它的动作序号，0 表示会话开始时的观测。一次扫描只对应一个档案帧（控制器自动保存后不再重复保存）。

### 4.3 渲染与显示坐标

- 默认观测：Z 通道正扫，平面去衬底，0.5%/99.5% 分位对比度，灰度，未采集行用固定暗色。去衬底可选 `none / plane / line / poly2 / highpass(nm)`；恒高帧（Z 几乎不变）默认改用电流通道。
- 显示尺度：`k = max(1, D // max(nx, ny))` 整数最近邻放大；帧比 `D` 大时按整数块均值缩小。`D` 默认 768，可配置。尺度随图片在标签里给出。
- 显示坐标 `(x, y)` 连续，原点在图像左上角，x 向右、y 向下；第 0 行是帧的上沿（扫描方向已归位、反扫已去镜像）。换算到扫描坐标系 nm：
  `u = -w/2 + (x/k)·w/nx`，`v = +h/2 - (y/k)·h/ny`，再按扫描角绕帧中心旋转并加上中心坐标。
  这一换算必须与判分器的视野规则精确一致（亚像素在内），用金样钉住。
- 方格纸：扫描图上唯一画的东西，对应 VISTA 在 ARC 帧上压暗的格子边界。格距取 1、2 或 5 × 10ⁿ nm，按视野选最小的一档，使长边不超过 16 格、每格至少 2 个扫描像素，所以放大后格子更细。格线从整帧左上角起算，宽 1 个图像像素，落在其精确位置所在的像素上；线上像素向琥珀色 (255, 176, 0) 混 1/4：`floor((3·像素 + 琥珀色) / 4)`。VISTA 是压暗到 3/4，但压暗在黑色区域看不见，还可能被看成沟槽。格距写进标签和每个 `stm_inspect` 视图（`grid_nm`），工具描述在开启时说明格线。谱、曲线图和派生图不画。插件默认开启（`grid: false` 关闭）；2026-10-12 决定按 VISTA 全套工具默认启用，不单独做消融。
- 标签示例：`<visual kind="current" frame="t0007.s0" channel="Z" direction="forward" flatten="plane" scale="2" size="768x768" grid_nm="5" z_range_pm="-23.1..41.7"/>`。

### 4.4 工具面

| 工具 | 作用 | 上限 |
|---|---|---|
| `stm_inspect` | 取回任意档案帧的视图：区域裁剪、最近邻放大到 `D`、换通道/方向/去衬底；每个视图一张图，按请求顺序返回，不拼图；文本给出每个视图的显示像素区域与扫描坐标角点 | 16 个视图 |
| `stm_read_values` | 在区域内按等分格中心采样物理量（VISTA 的 `read_pixels` 规则），返回单位、数值矩阵（缺测为 null）与首末样点坐标；谱帧按列采样 | 64 个视图、4096 个样点 |
| `stm_line_profile` | 两点间剖面（显示像素或 nm），台阶候选（位置、高度） | — |
| `stm_fft_peaks` | 加窗 FFT 的峰：周期、角度、相对强度；附带峰编号的派生图 | — |
| `stm_detect_blobs` | 局部背景扣除后的亮/暗斑：编号、质心（像素与 nm）、高度、半高宽、拉长度；附带编号标记的派生图 | 50 个 |
| `stm_frame_diff` | 两帧亚像素配准（位移 nm、置信度）、对齐后的差分图、变化区域 | — |
| `stm_frame_stats` | 均值、标准差、去平面 RMS、分位数、正反扫相关、行噪声指数、已采集行比例 | — |
| `stm_notes_read` / `stm_notes_write` | 读写 `GUIDE.md`（≤ 64 KiB）与 `WORKING.md`（≤ 16 KiB），整文件替换 | — |
| `stm_advisor`（可选） | 对一帧运行经典检测器与（若启用）深度模型，原样返回读数并注明「不是真值」 | — |

所有只读工具声明 `isConcurrencySafe: true`，不取仪器令牌；参数范围按 dsh 的限制写进 description（PLAN §8.2）。

### 4.5 一动一观

改变仪器状态的技能工具在上一次此类工具的结果进入模型上下文之前拒绝执行，拒绝文案为固定短语并进入 `messages.ts`。只读与笔记工具不受限制。

**已实现（2026-10-13）**：判据在 kernel `act-gate.ts`（`isStateChangingSkill`：类别不是 `read` / `analysis` 就算改变，缺类别也算；`ActGate`：每会话一位「有结果没被看到」，`admit` 在同一个同步调用里查与记，并发只放一个），文案在 kernel `messages.ts`（`ACT_GATE_REFUSAL`，`[act_gate]` 开头，参考实现原句只把 `act` 换成「改变仪器状态的动作」）。接线在 stm-skills `act-gate.ts`（`ActGateService`，`ctx.stmActGate`）：

- **拒绝走宿主层 guard**（与 `stm-safety` 同理：单调，翻不回来），不是 `tools/pre-execute`；guard 拒在 dispatch 之前，所以拒绝由闸门自己记进记录库。
- **「已进入上下文」= 同一 agent 的下一个 `agent/pre-step`**：agent-loop 把一步里的全部工具结果提交进会话日志之后才提议下一步，而每次请求都由日志推导；同一步里的第二个动作因此被拒，下一步放行。证据（读包、仓外探针、契约测试）见 [dsh 事实](dsh/facts.md) §9.5；契约测试是 `packages/host/stm-skills/contract/act-gate.test.ts`（含同一步两个动作与并发）与 `act-gate-loop.test.ts`（真 agent-loop 驱动一整个回合）。
- 只有登记过的（`registerSkill`）改变仪器状态的技能受闸；视觉记忆的回看、读值与笔记工具、`stm_get_state` 不受闸；没有 agent 的调用不是模型发的，也不受闸。
- 补救动作（`WithdrawTip`、`SafeRetract`、`EmergencyRetract`、`StopScan` 等样品门控豁免名，以及带 `stop` / `emergency` 标签的技能）**永不被拒**，但同样记账。
- 与参考实现的差异（没有 `act` 工具、补救动作例外、没有 10 s 超时兜底、放行即记账）登记为 [D-VMEM-15](../spec/deviations.md)。

### 4.6 与内核 K14 的接线

K14 在 depth 0 时：技能产生的 .sxm/.dat 先经 `frameArchive.add*` 入档，再把当前观测图作为附件交给 `renderOutcome`；文本里列出新帧编号与帧摘要。图像仍「走路径不走像素」（PLAN §3.2 第 8 条），像素只在出站时 materialize。前端的帧接口（PLAN §9.4）与档案共用同一份渲染实现。

**已实现（2026-10-13）**，分三处：

- **内核**（`skill-kernel.ts`）：注入的 `SkillObserver`，depth 0 时在 K11 之前问一次 `begin`、K13 之后问一次 `end`（成功、失败、执行中抛出都问；被闸门拒掉的调用不问，子步不问）。观察者交回帧编号与摘要（`SkillObservation`），内核把 `new_frames`（新帧摘要）或 `latest_frame`（没有新帧时最近的扫描帧，只给改变仪器状态的调用）、`not_archived`、`observation_error` 几行接在 K13 文本之后（不受 2000 字截断），观测挂在 `outcome.observation` 上。没接观察者时结局一字不变。
- **找文件与入档**（visual-memory `observe.ts` 的 `frameObserver`）：比较控制器保存目录调用前后的 `.sxm` / `.dat`（不递归；首次见到的目录里已有的都算旧的；按大小与修改时间认「变了」），新文件按修改时间先后入当前调用会话的档案。改变仪器状态的调用开下一个动作序号，读类调用记在当前序号下。入档走 `ctx.frameArchive.addScan` / `addSpectrum`（作用于发起调用的会话）；读不了的文件列进 `not_archived`，文件再变时重试。随结果出图的是最新的新扫描帧，再加最后两条新谱（参考实现 `_observation_for`）。保存目录由宿主给（`saveDir`）；stm-skills 的 `controllerSaveDir` 问仪器（`Util_SessionPathGet`，与 `GetLatestScanFile` 同一个解析与归一）。**不读技能结果里的路径键**：`ScanAt` / `FullScan` / `WaitScanComplete` 不报路径，`SaveScan` 的 `saved_path`、`AcquireSTS` 的 `path` 是「最近 120 s 里最新的那个」，分析类技能的 `scan_path` / `dat_path` 是输入。
- **出站**（visual-memory 的 `observationPresenter`，交给 `defineSkillTool(skill, { kernel, present })`）：按帧编号取观测图（`<fid>.png`）存成附件，内容是文本、再每张图一行标签加图像块（同 `stm_inspect`）；没有图时内容就是那段文本，与不接 presenter 的技能工具一字不差。存不了、或会话的模型路由只收文本时，文本末尾加 `images_not_delivered: N`（后者带原因）。

宿主组合的写法（尚未挂进 bundle）见 `packages/host/stm-skills/contract/k14-wiring.test.ts` 的抬头；与参考实现的差异登记为 [D-VMEM-16](../spec/deviations.md)。

### 4.7 提示与笔记

IC persona 增加 VISTA 的五句约定：尽量少用仪器时间与动作；维护可修订的仪器—针尖—样品模型；动作前写预期、动作后报告全部可见变化；把持久认识写进 `GUIDE.md`，用 `WORKING.md` 做草稿。上下文接近压缩阈值时，先要求模型保存 `WORKING.md`，压缩后以「环境记录 + 笔记 + 当前帧」重新开局；dsh 是否提供压缩前钩子见 §7。

**已实现（2026-10-13）**：本仓还没有 IC agent preset，五句约定由 visual-memory 插件注册成系统提示段（`prompt.ts`，段名 `mast-visual-harness`，order 150，紧跟部署 persona 前缀），文字照参考实现 `prompts.py::SYSTEM_TEMPLATE`（图像档、带笔记），`act` 改成「each action that changes the instrument」，另加一句「旧图不见了就用 `stm_inspect` 重看」（[D-VMEM-16](../spec/deviations.md)）。有了 IC preset 之后可以并进它的 `deployment:persona-prefix`。压缩前钩子：dsh 没有（[dsh 事实](dsh/facts.md) §9.4，退路是在 `agent/pre-step` 上抢在压缩之前插检查点）；压缩检查点本次没有做。

### 4.8 模型要求

视觉线束要求 IC agent 使用能读图像内容块的模型。按 PLAN §7.7 的接法，候选为经 `llm-pi-ai` 的 Anthropic、OpenAI 等提供方，以及自写适配器中支持视觉的 Kimi 模型。dsh 默认的 DeepSeek 模型行不在此列。使用不支持图像的模型时，工具结果必须明确说明「本轮有 N 张图像未送达」，并可退回数值网格观测；不得静默丢图。

技能结果的「N 张未送达」已实现（§4.6 出站一侧）：路由取会话最近一次请求头的 provider / model，经 `ctx.llm.resolveModelInfo` 读 `inputModalities`，与 dsh 换占位文本用同一判据（[dsh 事实](dsh/facts.md) §9.3、§9.7）；判断不了时不下结论。数值网格的退路没有做。

### 4.9 模拟器时钟

Python 参考实现（VISTA-SPM，运行在 STM-Bench 上）让仿真时间只在仪器动作执行时流逝，模型思考不消耗仪器时间。受管 STM-Bench 运行时以独立进程启动模拟器，目前没有暂停时钟的控制面；在 dsh-spm 中复现该协议需要模拟器侧增加控制命令，或接受思考时间计入仪器时间（对真机这是物理事实，不需要处理）。

## 5. 验证与验收

- **参考实现与消融。** Python 版视觉线束在独立仓库 VISTA-SPM（暂未公开）中实现，在 STM-Bench 上以论文场景（P1 鱼骨重构、P4 单原子定位、P5 力谱）× 多个 seed 做消融：图像 + 笔记 + 视觉记忆 + 读值与测量（完整）、去掉读值与测量、去掉视觉记忆、只有图像、数值网格代替图像、以视觉模型摘要代替图像、完整 + 顾问。指标为判分器核验的复现结果、诊断准确率、仪器时间、动作数与 token 成本。本设计的取舍以该结果为准。
- **TS 对 Python 的一致性。** 渲染、坐标换算、读值和各测量工具以参考实现导出的金样逐项比对，容差写明；有意差异登记在 [偏差登记](../spec/deviations.md)。
- **dsh contract。** 钉住：工具结果中的图像内容块能经各模型适配器送达；图像与文本一样可从 session log 重建（PLAN §3.1 第 5 条）；一动一观闸门的拒绝在并发调用下成立。
- **Phase 3 验收补充。** 在受管 STM-Bench 上，用支持图像的模型完成「扫一帧 → 回看并放大历史帧 → 读值 → 移针 → 再扫一帧 → 比较两帧」，session log 可重建每一张图。

## 6. 实施顺序

1. 本文与 PLAN 修订。
2. `compat` 增加附件与图像内容块的导出；contract 测试核实各适配器对工具结果图像的处理，结论写入 [dsh 事实](dsh/facts.md)。
3. `dsh-spm-visual-memory`：档案、渲染、坐标、`stm_inspect`、`stm_read_values`、笔记工具；单元测试与参考金样。谱（`.dat`）于 2026-10-12 并入。
4. K14 接线、IC persona 提示、一动一观闸门。**已实现（2026-10-13，§4.1 末段、§4.5–4.8）**：内核 K14 观察者接缝与一动一观判据、stm-skills 的闸门服务与技能工具出站接缝、visual-memory 的入档观察者 / 出图 presenter / 每会话视觉记忆 / 提示段；契约测试 `act-gate.test.ts`、`act-gate-loop.test.ts`、`k14-wiring.test.ts`。挂进 bundle 与 profile 留给集成。
5. 测量工具。**已实现（2026-10-13，§4.4）**：`stm_line_profile`、`stm_fft_peaks`、`stm_detect_blobs`、`stm_frame_diff`、`stm_frame_stats`，照 VISTA-SPM 的 `vista_spm/measure.py` 移植；参考金样 `measure_profile.json`、`measure_fft_blobs.json`、`measure_diff.json`，偏差 D-VMEM-9–11。数值部件见 §4.1；`numerics` 的插值族为此改为在帧边与缺测处也与 scipy 逐位一致（`interp_edges.json`）。
6. `stm_advisor`；`vision-onnx` 视消融结果决定是否实施。
7. 在 dsh-spm 运行时上复现 STM-Bench 场景，与参考实现做结果级对比。

## 7. 开放问题

- ~~dsh 工具 `output.render` 中图像块的确切形状，以及 `llm-pi-ai` 各路由和自写 `OpenAiCompatAdapter` 如何把工具结果中的图像发给模型~~ → 已答：[dsh 事实](dsh/facts.md) §9.1–9.3（2026-10-09）。
- ~~dsh 是否提供压缩前钩子~~ → 已答：没有，退路在 `agent/pre-step` 上（§9.4，2026-10-09）；检查点本身还没做。
- ~~「结果已进入上下文」在 dsh 中对应哪个可观察事件~~ → 已答并实现：同一 agent 的下一个 `agent/pre-step`（§9.5，2026-10-13，§4.5）。
- 附件的保留期与磁盘占用（长会话可能产生数百张图）；单次请求的图像数量与尺寸上限随提供方不同。
- 受管模拟器的时钟暂停控制面（§4.9）。
- ~~`dsh-agent-loop` 不在本仓依赖树里：「先提交结果、后 pre-step」靠读包与仓外探针~~ → 已钉住：2026-10-13 起它与 peer `dsh-session-persistence`、`dsh-settings` 是 stm-skills 的 devDependency，`act-gate-loop.test.ts` 用真 agent-loop 跑同一场景（[dsh 事实](dsh/facts.md) §9.5）。

## 8. 非目标

- 不训练新的视觉模型；不把视觉模型的输出作为模型可见的常驻摘要。
- 不在图像里绘制文字或坐标。唯一的叠加层是方格纸（§4.3），默认开启；比例尺、编号标记等其他叠加层不做。
- 不改变安全接缝：视觉线束只改变模型看到什么，仪器动作仍经内核全部闸门。
