# 批 3j 交接 —— 流式读回一族（z_trace 判定机 + 三个技能）

**落地 3 个技能 / 3 个模块**（分派的就是这三个，**没有欠件**）。

- `builtins.bias_pulse_readback`（1）
- `builtins.tip_shaper_readback`（1）
- `builtins.capture_signal_buffer`（1）

技能 324 → **327**，模块 45 → **48**。新增 **132 条测试**
（`kernel/src/z-trace.test.ts` 66 + `l0/tail-l0j.test.ts` 43 + 轨迹金样 23 格），
新增 **15 条变异演练，全部变红**。全仓 `--project '!integration'`：**73 文件 / 3751 条全绿**。

## 0. 分派时的判断错了一处 —— **三个都能落**

第二轮分派单上写着 `tip_shaper_readback` 被针尖登记表挡住。**不成立。**
它只从 `_tip_policy` 里拿两样东西：

| 拿的 | 它到底要什么 |
|---|---|
| `shaper_bias_default(context)` | 只发一条 `Bias_Get` 再解析 —— **自成一体** |
| `resolved_lift_height_m(params)` | 纯参数逻辑，一次调用都不发 |

要登记表的是 `apply_tip_policy`，而那个只有 `bias_pulse_readback.validate_params` 用
（见下面第 3 节的欠账）。**「同一个文件里有一样东西被挡住」不等于「这个技能被挡住」**
—— 这条在分派下一轮时值得记住。

---

## 1. 该登记成 deviation 的（编号留空，请统一编）

### D-STREAM-1（暂用这个号，请确认）· `_readback_stream.scalar` 是旧仓那一族**没被收进去的第四份**

| | |
|---|---|
| **Python** | `_readback_stream.scalar`：多元素 body 直接取 `d[0]`，嵌套表再取 `v[0]` |
| **我们** | 一律走 `scalarFloat`：**多元素 body 一个样本都不记** |
| **测试** | `l0/tail-l0j.test.ts` → `取不出数就是 null` |

旧仓自己把三份手写的 `_scalar` 收进了 `io/nanonis_files.scalar_float`，而这一份没收进去。
`scalar_float` 的 docstring 点名说最难查的就是这一种：**「双通道回包上悄悄选一路」**。

**影响面：0 格。** `Current_Get` / `ZCtrl_ZPosGet` 的协议声明都是单个 `f`，
所以这条偏离只在协议被违反时才分岔 —— 而那时沉默比猜好。

⚠️ **号要重编**：`D-READBACK-1` 已经被「回读比对的容差是判据」占了，我暂用 `D-STREAM-1`，
在 `readback-stream.ts` 与 `tail-l0j.test.ts` 里各引了一次。

### D-SKILL-2 补充 · `shaper_bias_default` 的「读不懂」文案（1 格）

旧仓印 `str(return_value)[:80]`，也就是三段信封的 Python repr
（`Bias_Get 回包读不懂(repr 前 80 字:('', b'', []))`）。信封在 `nanonis-wire` 那层就拆掉了，
我们印 `values=[]`。**期望值从金样算出来**（一条 `.replace`），旧仓改了那句话这里会跟着变。

登记在 `l0/traces.test.ts` 的 `DEVIATIONS['TipShapeWithReadback/empty@0']`。

### D-????· **两侧的假钟摆在不同的量级上** ⇒ 时间字段按容差比

| | |
|---|---|
| **Python** | `export_skill_traces.py` 的 `_CLOCK = 1_000_000.0` **秒**，每读一次 `+= 1e-3` |
| **我们** | `SkillContext.now()` 按契约是**毫秒**，轨迹夹具给的是整数 |
| **后果** | 「3 毫秒」那边算出来是 `0.003000000142492354`，这边是 `0.0030000000000427463` |
| **测试** | `l0/traces.test.ts` 的 `clockApprox`（`|a−b| ≤ 1e-6·max(1,|a|)`；实测差 1e-10，留了四个数量级） |

**这个差消不掉。** 毫秒钟在 1e9 上的栅格比秒钟在 1e6 上的栅格粗 2.4 %，于是约 2 % 的秒值
根本没有毫秒原像 —— 无论怎么折算，除回去都回不到同一个 double（实测 200 000 个采样点里
4 688 个回不去）。真要消掉，只能改导出脚本那个**全局**假钟，而那会把每一条已有金样的
时间字段一起改掉。

**判据分毫不动**：容差只作用在 17 个时钟派生的叶子键上（`CLOCK_KEYS`），
采了几点、哪一帧丢了、顺序、判定、文案全部照旧逐位比。

> **顺带一条值得进报告的**：`post_roll_s` 的默认值（20 ms）**正好压在采样栅格上**
> （假钟下一帧 3 ms）。后窗是 `t >= cap - win` 的闭区间，边界压在样本上时，
> 那 1e-10 的残渣会**决定一个样本进不进窗** —— `n_post` 因此差一个，
> `TipShapeWithReadback/err@78` 当场撞到。导出参数改成 21.5 ms（刻意不落在栅格上）。
> **浮点残渣本身不可怕，可怕的是它落在一个离散判据的边界上。**

### D-???? · `timing.budget_exhausted`：**本仓新增**的圈数预算

旧仓的采集循环用真墙钟，不可能停；本仓的时钟是注入的，**一个不往前走的钟会把它变成
一个不发任何调用的死循环，而死循环与通过在退出码上长得一模一样**。

预算**从请求本身算出来**（`totalS·(pollHz+1000)+64`），不是一个拍脑袋的常数。
超了就收工并补一个 `budget_exhausted: true` —— **只在发生时才写，缺键就是没发生**
（与 `tipXyFields` 的空对象、旧仓 `warning` 那个键同一条纪律），所以金样一格没变。

连带一处文案也改了：`BiasPulseWithReadback` 在「始终没到开火时刻」时，旧仓只有一句
`Aborted before the pulse was fired`。照抄会把一次夹具故障说成一次用户中止 ——
而这两件事要做的下一步完全不同。预算耗尽时换成「注入的时钟没有前进」。

### D-???? · 针尖安全包络（`apply_tip_policy`）**没有移植** —— 欠 Phase 5.3

旧仓 `BiasPulseWithReadback.validate_params` 按**当前登记的针尖**检查方案表包络，
**超上限拒绝、不夹紧**（同一条哲学贯穿粗动电压四重锁）。修针默认的 ±10 V 是用户对
**金属丝针尖**的做法；铂铱（8 V）、磁性/超导针、qPlus（3 V）会在那里被拒绝，
**那不是 bug 是保护**。

它要 `mast.core.tip_conditioning_resolver`（针尖登记表，Phase 5.3）。在那之前这一侧
只有全局 ±10 V 的 SafetyGate 在挡。**没有写一个空的 `validateParams`** —— 写了会让人
以为这道闸在。欠账写在 `readback-skills.ts` 里 `BiasPulseWithReadback` 的 docstring 中。

金样照不出这一条：导出脚本直接调 `execute`，`validate_params` 一次都没被调用。

### D-???? · `pyFixed` 暂住 `z-trace.ts`，收族时该搬去 `si.ts`

语言分歧一族的**第六个成员**（前五个：`pyFloatRepr` / `formatG` / `pyStr` / `pyMod` / `pySum`）。

Python 的 `%.3f` 在半分点上 **round-half-even**，ECMA-262 的 `toFixed` 明写「取大的那个」。
半分点恰好是 **1/16 的奇数倍**（0.0625、0.1875、0.3125…），全是二进制精确表示的数
—— 所以这不是理论问题：`"%.3f" % 0.0625` = `0.062`，`(0.0625).toFixed(3)` = `"0.063"`。
金样里 `seg4_exact_sixteenth` 那一格印的就是 `0.062`。

**它现在不在 `si.ts` 里**，是因为这一轮有四条并行支线在改文件，塞进去会让四份改动撞在
同一行上。收族的时候搬过去。

### D-???? · `MAST_TRACES_DIR` 环境变量没有移植

旧仓那个变量的职责是**测试隔离的抓手**（17 个测试文件都够得着这条落盘路径）。
本仓的抓手就是 `TraceDeps.tracesDir` 这个注入点本身 —— 同一件事两个开关，
只会多一个漂移的地方。默认落在 `<cwd>/experiments/traces`（同 `frames.ts`，已在 `.gitignore`）。

### D-???? · `TRACE_SCHEMA` **保留 `mast.` 前缀**

`mast.readback_trace/1` 这个串写进的是**磁盘上的文件**，而那些文件要被旧仓的读取侧、
以及用户手上已经存着的分析脚本认出来。为「本仓改名了」而换掉它，等于让同一种文件在
两个仓里长得不一样 —— 那正是版本号要防的事。

### D-???? · 采集循环在旧仓有**两份**，本仓收成一个骨架

`capture_signal_buffer.py`（早）与 `_readback_stream.py`（晚）各写了一遍「绝对时刻调度
+ abort 早退」。本仓收成 `pollLoop`，两个调用点各自传自己的 `poll`。

**字面动词留在调用点**：旧仓 `capture_signal_buffer` 的注释把理由写死了 —— 本仓每一样
安全工具（中止策略检查、安全审计、API 覆盖普查）都靠 grep `safe_call("…")` 找 Nanonis 调用，
一个经变量到达的动词对这三样**全部不可见**。

---

## 2. 新金样：`spec/golden/z_trace.json`（46 格 / 305 KB）

    <MAST_ROOT>\.venv-v2-py313\Scripts\python.exe tools\spec-export\export_z_trace.py

**第二台驱动器。** 通用轨迹金样那边喂的是常数回包（电流与 Z 恒为 0.25），于是这一族
只走得到一条路：没噪声、Δz 恒为 0、`no_press`。**这个模块里真正要紧的每一条判据
在那份金样里一格都没到。**

这一份手搭曲线，一条判据一格：四段结构、`too_short` / `no_return` 两条「判不了」的出口、
后窗按点数兜底、MAD 退化到标准差、`detect_jumps` 的三级阈值回落、`%.3f` 的半分点。

**合成数据**（用户已批准）：曲线按物理形状手搭，数量级取自旧仓文档里写下来的真机观测
（第二段电流饱和 ×50–100、第四段 Δz ≈ +269 pm、第四段中位时长 0.012 s），
但每一个点都是脚本算出来的。噪声用一个**不整除周期的锯齿**，不用随机数 —— 金样要可复现。

**两次导出逐字节相同**（已验，`z_trace.json` 与 `skill_traces.json` 都验了）。

最值钱的是并排的这一对：

| 格 | 给不给电流 | 结论 |
|---|---|---|
| `seg4_too_short_with_current` | 给 | `insufficient_data` + `feedback_segment_too_short` + **一句具体的下一步** |
| `seg4_too_short_without_current` | **同一条曲线**，不给 | `none` —— 「没扎上」 |

2026-08-20 的 168 条历史曲线里 **160 条**是这个形状，而它们当时全都给出了确定的判定。
**真簇被这样判掉了 62 %**，而用户被送去一次次加深扎入深度 —— 缺的其实是一秒钟的采集时间。

`spec/golden/README.md` 的表里**没有**这一行：那张表从 Phase 2 之后就没再维护
（`skill_traces.json` / `numerics.json` / `lockin_presets.json` 都不在里面）。
只补我这一行会更奇怪，所以留给统一整理。

---

## 3. 变异演练：15 条，**全红**

    node tools/mutate/run.ts z-trace-seg4-too-short-is-not-no-change …

| id | 拆掉之后系统会重新犯哪一次错 |
|---|---|
| `z-trace-seg4-too-short-is-not-no-change` | 那 62 % |
| `z-trace-no-return-is-not-no-press` | 两句指向相反下一步的话被合成一个词 |
| `z-trace-must-confirm-it-pressed-in` | t4 落在扎针**之前**，拿扎针前的一段当结果 |
| `z-trace-post-window-starved-fallback` | 一次 122 ms 卡顿把 315 个好样本判成「我说不出发生了什么」 |
| `z-trace-pre-window-has-no-fallback` | 空基线上 z1 取成 0，任何 z3 都变成一次巨大的跳变 |
| `z-trace-insufficient-keeps-diagnostics` | 诊断恰好在需要它们时消失 |
| `z-trace-windows-take-second-half` | 下降沿与回撤斜坡渗进稳定值 |
| `z-trace-tol-has-an-absolute-floor` | 容差塌到 0 |
| `pyfixed-rounds-half-to-even` | 语言分歧第六个 |
| `pulse-start-blocked-floor-is-20ms` | 守卫在，却只在不需要它的地方管用 |
| `shaper-bias-has-no-3v-fallback` | 2026-08-10 那次 20 mV 被 3 V 顶掉 |
| `shaper-bias-lift-follows-bias` | 关掉 change_bias，结上照样过一记 3 V |
| `capture-signal-repeated-bits-anomaly` | 2026-07-27 那 600 个 std=0 的 z |
| `capture-signal-channel-is-a-python-int` | `'0x10'` 被 `Number()` 收成 16（同批 3f 的 LUT） |
| `lift-height-zero-is-a-real-height` | D-ZERO-1 **第五次** |

### 又一次「一条编不过的变异，那道闸就永远验不到」（**第 12 次**）

`z-trace-tol-has-an-absolute-floor` 第一版写的是 `const tol = tolK * sigma1` ——
`tolAbsM` 就没人读了 ⇒ **TS6133** ⇒ 构建失败 ⇒ `inconclusive`。

这次的修法不是抽 helper，是**换一条同样拆掉判据、而两个绑定都还有人读的变异**：
把地板 `Math.max` 改成天花板 `Math.min`。判据同样不成立（容差可以掉到 `tolAbsM` 以下），
而且它比原来那版更像一次**真会有人写出来的**笔误。

### 一条**没有**演练的闸，以及为什么

`pollLoop` 的圈数预算本身没有变异。拆掉它，测试不会变红 —— 它会**挂住**，
而「挂住与通过在退出码上分不开」正是这道闸存在的理由（演练自己也有 120 秒上限，
一条本该变红的变异会被报成「超时失败」，2026-09-13 真踩过）。
它由 `tail-l0j.test.ts` 的三条正向断言看着：预算耗尽时进回包、时钟正常时**没有**那个键、
以及开火前耗尽时那句话说的是时钟而不是中止。

---

## 4. 移植时发现的旧仓文档瑕疵（**不改行为，只记账**）

`mast/io/z_trace.py` 的 `feedback_restored_t`：

* 返回标注写着 `-> "float | None"`，而它**返回的是一个二元组** `(t4, why)`。
  照标注写的人会去判 `if t4 is None` —— 而那个名字绑的其实是元组，永远不是 `None`。
* 同一个函数的 docstring 把 `"no_current"` 列进了它的返回值，但那个值**只由
  `step_verdict` 产生**（「压根没给电流通道」）。这个函数自己给不出它。

两处都只是说明，行为逐位照搬，已写进 `kernel/src/z-trace.ts` 的抬头。

---

## 5. 一处**容易照抄错**的不对称，写下来

`BiasPulseWithReadback` 调 `step_verdict` 时**刻意不传电流通道**，`TipShapeWithReadback` 传。

四段结构是**扎入**才有的形状：反馈关掉、压进去、抬回来、反馈恢复。一发电脉冲没有那个过程
—— 反馈按 `z_hold` 要么一直开着、要么全程保持，电流不会先饱和再回落。传进去只会得到一句
`no_press`，白读一遍。脉冲那边 `feedback_segment_source` 因此**恒为 `no_current`**，
而对脉冲来说尾窗本来就是对的那一段。

移植时我第一遍照着「两个技能共用一份判据」把电流也传了进去 —— 金样当场把它照了出来
（`no_press` vs `no_current`）。**共用判据不等于共用入参。**

---

## 6. 文件清单

**新增**

| 路径 | 是什么 |
|---|---|
| `packages/host/kernel/src/z-trace.ts` | 判定机（纯判据、零 I/O）+ 回包形状序列化 + `pyFixed` |
| `packages/host/kernel/src/z-trace.test.ts` | 66 条，对 `spec/golden/z_trace.json` 逐格 |
| `packages/host/stm-skills/src/l0/readback-stream.ts` | `pollLoop` 骨架、`streamWithAction`、`channelBlock`、落盘 |
| `packages/host/stm-skills/src/l0/tip-policy.ts` | `shaperBiasDefault` / `resolvedLiftHeightM`（两条不要登记表的） |
| `packages/host/stm-skills/src/l0/readback-skills.ts` | 三个技能 + `stageBoundaries` |
| `packages/host/stm-skills/src/l0/tail-l0j.test.ts` | 43 条，一台**会动的机器** |
| `tools/spec-export/export_z_trace.py` | 第二台驱动器 |
| `spec/golden/z_trace.json` | 46 格 |
| `docs/handoff/batch-3j.md` | 本文件 |

**改动**（都落在预留的锚点上，除两处在共享文件里另说）

| 路径 | 改了什么 |
|---|---|
| `packages/host/kernel/src/index.ts` | 批 3j 锚点 → `export * from './z-trace.js'` |
| `packages/host/stm-skills/src/l0/index.ts` | 三处批 3j 锚点 |
| `scripts/gen-skill-specs.ts` | `BATCH_3J` 三个名字 |
| `tools/spec-export/export_skill_traces.py` | `BATCH_3J` + `PARAM_OVERRIDES` + `EXTRA_PARAMS` + `_TRACE_STAMP` 抹除 |
| `tools/mutate/mutations.ts` | 批 3j 锚点 → 15 条演练 |
| `packages/host/stm-skills/src/l0/traces.test.ts` | **共享文件**：`TRACE_STAMP_RE`、摘要也走一遍路径抹除、`clockApprox` 机制、4 处 DEVIATIONS |
| `packages/host/stm-skills/src/generated/specs.ts` · `spec/golden/skill_traces.json` · `spec/progress.json` | 生成物，**重新生成即可，不要手工解冲突** |

`traces.test.ts` 里那句 `expect(got.summary ?? '').toBe(...)` 改成了两侧都走 `scrubPaths`
—— 这一族的两个技能**把落盘指针写进摘要**（摘要是唯一穿过工具边界的东西），而那条路径
里有项目根与时间戳。这一处对别的技能是无操作。
