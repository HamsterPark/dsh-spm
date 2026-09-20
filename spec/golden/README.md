# `spec/golden/` —— 与 Python 侧对账的分母

**不要手改这里的任何文件。** 每一份都由 `tools/spec-export/` 下的一个脚本从旧仓 MAST 导出，
本机 PATH 里没有可用的 `python`（只有 Microsoft Store 的转发桩），一律用旧仓 venv 的绝对路径：

```powershell
python tools\spec-export\<脚本>.py
```

脚本**只读旧仓**：导出前把 `MAST2_PROJECT_ROOT` 指向临时目录，旧仓的 config / data_paths /
override_store / models（API key 目录解析）都认这个变量。2026-09-08 实测：跑完后
`find MAST -newermt '-10 minutes'` 返回空，旧仓一个字节没动。

**重跑产出逐字节相同**（2026-09-16 又验了四份：`numerics` / `environment` /
`nanonis_files` / `skill_traces`）。所以「旧仓变了没有」这个问题可以用 `git diff` 回答 ——
这也是 manifest 里不记随机沙箱路径的原因。

> **2026-09-16 重写。** 上一版这张表只列了 7 份，而目录里已经有 30 多份；
> 末尾的「还没导的」还把 `tool_schemas.json` / `preconditions.json` / `safety.json`
> 列成待办，而它们早就在了。**一份列了三分之一内容、并且把已有的说成没有的清单，
> 比没有清单更糟** —— 读的人会照着它去判断「这块有没有覆盖」。

---

## 一、导出器与它驱动的东西

每个脚本的抬头都写着它驱动的是旧仓的哪一段真代码。分三类：

### ① 规格类 —— 读旧仓的**声明**

| 文件 | 导出器 | 钉的是什么 |
|---|---|---|
| `skills.json` | `export_mast_spec.py` | 515 条技能的**作者声明**契约：category / safety_level / description / 逐参数 ParameterSpec（含 unit、min/max、allowed_values）/ preconditions / capabilities / composition_level / 所在模块与 origin |
| `si_cases.json` | 同上 | SI 行为：`parse_si` / `parse_quantity`（strict 与 loose 各一遍）/ `needs_strict_prefix` / `format_si`，**含报错类型与原文** |
| `safety.json` | `export_safety_spec.py` | 可调包络 14 字段 + 全局检查 19 行 + 物理荒谬 11 行 + 中止安全写 24 条 + `_is_read` 对**全部 671 个动词**的判定 + 硬闸 / 能力 / 模式拒绝（**原文逐字**） |
| `preconditions.json` | `export_preconditions.py` | 前置条件词表 + **10 个前置 × 14 个夹具 = 140 格网格**，逐格录违反消息。整片网格而不是挑点 —— 判定里有子串匹配，而子串在否定形式上尤其危险 |
| `tool_schemas.json` · `tool_schemas_real.json` | `export_tool_schemas.py` | 模型**唯一读得到范围的地方**：工具 schema 的逐字文本 |
| `records_schema.json` · `records_schema.sql` | `export_records_schema.py` | 记录层建表语句与声明；建表由金样原样执行，逐表逐对象比 |
| `manifest.json` | `export_mast_spec.py` | 每个 collector 的成败与条数 —— **一个 collector 坏了不能静默缺一块**，缺一块会让分母悄悄变小 |

### ② 轨迹类 —— 驱动旧仓**真实的那段代码**跑一遍

这一类的共同点：录的不是「我读旧仓读出来的结论」，是**旧仓自己跑出来的东西**。

| 文件 | 导出器 | 驱动的是 |
|---|---|---|
| `skill_traces.json` | `export_skill_traces.py` | **329 个技能 / 1392 条调用轨迹**（含 13 条「抛异常也是判据」）。总驱动器 |
| `watchdog.json` | `export_watchdog_trace.py` | 真 `SafetyWatchdog.run()`（把它的 `time` 换成假时钟，让真循环自己跑）。含 2026-08-10 那次「武装着却打不着火」的复现 |
| `state.json` | `export_state_spec.py` | 真 `InstrumentState`：1 Hz 读哪 11 个动词（**观测得到，不是手抄**）、21 条「什么算一个读数」、14 条脚本 29 步、7 条实时提示块**整段文本** |
| `breaker_trace.json` | `export_breaker_trace.py` | 熔断状态机 50 步 |
| `graph_executor.json` | `export_graph_executor.py` | 真 `GraphExecutor`（四条恢复守卫的现场） |
| `approach.json` · `approach_gate.json` · `approach_tip.json` | `export_approach.py` · `export_approach_gate.py` · `export_approach_tip.py` | 真 `AutoApproach` / `safety_escalation` / `ApproachTip._approach` |
| `scan_chain.json` · `scan_wait.json` | `export_scan_chain.py` · `export_scan_wait.py` | 真 `scan_policy` / `imaging` 判定件；真 `WaitScanComplete` 与回包解析器 |
| `bias_ramp.json` | `export_bias_ramp.py` | 真 `SetBiasRamp` |
| `tip_park.json` | `export_tip_park.py` | 真 `tip_park` 判定机 |
| `claim_audit.json` | `export_claim_audit.py` | 声明交叉核对 |
| `advanced_ops.json` | `export_advanced_ops.py` | 真 `QuitNanonis` / `WaitForScanEndBlocking` |
| `frames_presets.json` · `zctrl_presets.json` · `lockin_presets.json` | `export_frames_presets.py` · `export_zctrl_presets.py` · `export_lockin_presets.py` | `.npy` 字节取自真实 numpy；三套参数组的 resolve 与三件套技能 |

### ③ 专用驱动器 —— **通用驱动器走不到的那些路**

> **并行支线的落点**（2026-09-19 加）：下面那张表这一轮**两条支线同时往末尾加行**，
> 成了冲突点。此后每条支线只往自己那一行下面加，中间那行谁都不要动。
> —— 同 `spec/deviations.md` 的锚点，理由一样：
> **冲突不是随机事件，它有确定的形状**（见 EXECUTION 课时 3.17）。

<!-- ── 批 6a（特异化流程 _tip_phases 六个组合技能）的驱动器写在这一行下面 ── -->

| 金样 | 驱动器 | 它能走到而通用驱动器走不到的 |
|---|---|---|
| `tip_phase_deps.json` | `export_tip_phase_deps.py` | `_tip_phases` 六条流程的**子技能闭包**（从六个 `plan_dynamic` 出发求 `CompositeStep(skill_name=…)` 的传递闭包）。这六条要一台真仪器跑几十分钟到几小时，**通用驱动器与任何一台重放驱动器都录不到一格**；而「要移它得先有哪些」恰恰只能从源码读。唯一一台**静态**驱动器（纯 `ast`，连 `sys.path` 都不动） |

<!-- ── 批 6b（vision 的 scan_prep 链）的驱动器写在这一行下面 ── -->

| `export_scan_prep.py` → `scan_prep.json` | `scan_prep` / `scan_artifacts` / `tip_change` 三份判据 + 两个技能。**33 张合成 `.sxm`**（闭式 + `default_rng`，一律从字节读回来），15 节 |

这一台的特点是**每一张帧后面都写着「它一个人撑着哪道闸」**，而那不是文风 ——
第一轮 43 条演练里有 **10 条绿**，全部是「那道闸没有输入」。补输入时发现了四条
只有造帧才看得见的事实，其中两条值得在这里留字：

* **伪影那三件（`_oscillation` / `_drift_px` / `_spike_frac`）在 pm 级的帧上一次也跑不到** ——
  `detect_scan_artifacts` 开头 `std < 1e-9` 的早退在真机上**几乎总是成立**（Z 以米计）。
  它们的输入必须是 **nm 级起伏**的帧；没有那几张，这三件移过来就是三段没有闸的代码。
* **`measure_frame` 转发给 `detect_tip_change` 的是 `line_subtract` 之后那一段**，
  而逐行平场把行偏置整个擦掉 ⇒ `dc` 通道对**纯 DC 跳变**在这条路上是瞎的
  （实测 600 pm 的跳变在那里 `dc = −6.285`，判不出来）。
  要让「针尖变了」那句话出现，帧上得有一次**纹理**变化。

<!-- ── 批 6c（批 5b 欠下的数值原语 + 晶格一族剩余）的驱动器写在这一行下面 ── -->

<!-- ── 批 7a-1（vision/tilt 一族 + AnalyzeFrameTilt + AutoTilt）的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 为什么要单开一台 |
|---|---|---|
| `tilt.json` | `export_tilt.py` | 三个技能里两个要一个**会回话的子技能**（`AutoTilt` / `TiltCalibrate` 的 `context.run("TiltProbeCircle")`），通用驱动器连那个名字都没有；第三个（`AnalyzeFrameTilt`）只读磁盘上的 `.sxm`，于是在 `skill_traces.json` 里只录得到「文件不存在」那一支。这一份自己合成 `.sxm` **字节**（读法归旧仓）、自己搭一台**闭式**假仪器（`ZSim`：横移记位置、读 Z 按斜面给数）、把子技能写成脚本，并把 `time.monotonic` / `time.time` 一起钉死 |

这一份有三条**别处没有**的纪律，值得单写：

* **RANSAC 的谱宽随每一格录**（`ransac_spread`）。两边的抽样序列不同（D-VISION-1），
  于是「倾斜是多少」在一张高斯噪声的图上是一次抽签 —— 实测 12 个种子之间 `b` 差
  `3.3e-3`。金样把那个谱宽**量下来**，TS 那侧拿它当容差；
  而主路那几格的谱宽是 **0**（棋盘噪声让内点恒为全部）。
  **容差是量出来的，不是调出来的。**
* **分割器两侧都录**（`*_seg` / `*_noseg`）。本仓没有 `segment_scale_adaptive`，
  落在旧仓自己的 fail-open 上；把 `sys.modules[...]` 设成 `None` 逼出真的
  `ImportError`，走的是旧仓那条 `except`，不是我替它编的返回值。
* **三处不可达各留一节**（`estimate_tilt_unreachable` / `no_action_reason_unreachable`
  / `fit_circle_tilt.all_same_angle`）。不可达要**量出来**，不是写在注释里。

<!-- ── 批 7a-2（实验地图层 + FindCleanSpot）的驱动器写在这一行下面 ── -->

| `map_scope.json` | `export_map_scope.py` | `FindCleanSpot` 的判据住在**它没发出去的那些调用**里：除一次 `Piezo_RangeGet` 之外，它读的是**实验记录**与**进程内的撞针记忆**，然后在一张锚在可用区中心的格子上做纯几何选点。通用驱动器的假 context 两样都给不出来 ⇒ 那条路上 `map_known` 恒为 False、避让圆一个都没有，**250 行的 `nearest_clean_from` 只走得到「空地图」那一条**。这一份自己摆世界（档案 / 实验记录 / 撞针追踪器 / 仪器回包四样都由它给），10 节：环带生成序 · 25 格配置装配 · 22 行 marker 还原 · 9 组代次 · 7 格三态读地图 · 5 格撞针记忆 · 8 格避让圆 · **26 格选点几何** · 10 格坐标串解析 · **39 格技能端到端** |

那 26 格选点几何是这一批最大的一块判据，而**每一格都是照着一条会被拆掉的闸造的**：
造完之后拿 15 种「另一种合理写法」在旧仓侧逐一重跑，
要求**至少一格的结果变了**才算这道闸有输入。15 种里 13 种当场被分开，
剩下两种（去掉提前退出 / 去掉 `max_ring` 的 `+2`）**一格都分不出来** ——
那不是金样不够，是它们**本来就不是闸**（前者由三角不等式保证不改答案，
后者是取整余量）。这两条因此没有进变异清单，理由写在 `spec/deviations.md`。

⚠️ 三处边界判据（相切 / 正好一个直径 / 正好等于 `max_distance_m`）**刻意造在轴上**：
`hypot(a, 0)` 在两种语言里都精确，而 `hypot(a, a)` 差 1 ULP（D-HYPOT-1）。
**一条会被最后一位掀翻的边界判据，不是判据。**

<!-- ── 批 7a-3（kde_layers + FindFlatRegion + BiasWiggle）的驱动器写在这一行下面 ── -->

<!-- ── 批 7b-1（封锁账闭包化 + AssessAtomicPhase + 两条已解封锁的流程）的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 为什么要单开一台 |
|---|---|---|
| `batch7b1.json` | `export_batch7b1.py` | `AssessAtomicPhase` 读磁盘上的 `.sxm`，一次 TCP 都不发 ⇒ 通用驱动器（`_params_for` 给不出真实路径）只录得到「文件不存在」那一支，而**技能壳自己那三道门一格都验不到**：覆盖率门 `_MIN_COVERAGE=0.5`（`tip_spectro_assess.py:385-410`）· `expected_a_nm` 的三态（给正数 / 给 0 / 不给）· 通道回落（要 `Z` 拿不到时**取第一个通道**，与孪生技能 `AssessAtomicResolution` 刻意不同）。这一份自己合成 12 个 `.sxm`（闭式 sin-hash，零随机数，**只存正扫** —— 这个技能只读 `forward`，存反扫会让金样大一倍），26 格技能 + 10 格 `resolve_substrate`。<br>⚠️ **覆盖率门录三格，而线上那一格是判据**：0.25（门下）· **0.4375（门下、而判据本身 `passed=True`）** · 0.5（**正好在门上，不算残帧**）。`incomplete = coverage < 0.5` 是严格小于 —— 少了 0.5 那一格，`<` 与 `<=` 给出同一个答案；少了 0.4375 那一格，「门压住的是 `passed` 而不是判据本身」这件事一格输入都没有（那正是真机 0084/0085 的形状：2% 的像素、报 `passed=True`、角向集中度 94）。<br>⚠️ **`expected_a_nm: 0` 与「不给」的分界只有 `expected_zero_with_substrate` 那一格分得开**：参数说明是两句话（「留空则从衬底取；填 0 则关掉这项比较」），而**没有衬底时它们给出同一个答案**。第一版漏了这一格，`atomicphase-expected-zero-*` 那条变异当场跑成绿的（green-8 §2.1 那个形状：闸只有一侧有输入）。<br>⚠️ `resolve_substrate` 把 `SURFACE_LATTICE_NM` 的**全部七个面**都问了一遍，不是只问对得上的那三个 —— 正是这四格多出来的问答量出了两件事：旧仓只认**四个**洁净金属面（`HOPG` / `NaCl(100)` / `Si(111)-1x1` 一律 `available=false`），以及 Pt(111) 上 `2.775/10 ≠ 0.2775`（差 1 ulp，见 D-ROWSPACING-1）。 |
| `tip_phase_deps.json`（扩） | `export_tip_phase_deps.py` | 原来只有「六条流程 → 它 `yield` 的 `CompositeStep`」**一层**。批 7b-1 加两节：**`skill_runs`**（扫整棵 `mast/skills/**`，515 个技能各一行「它自己还会发出去谁」，TS 侧据此自己求闭包）与 **`closure_limits`**（这套追法**追到哪儿为止**）。<br>⚠️ 边有**两条**不是一条：旧仓 `CompositeStep(` **299 处** · `context.run(` **63 处** —— 只追后者只覆盖五分之一，而漏掉的正是 `ScanAt` / `PreScanCheck` 压着的 `SetScanBuffer` / `WaitScanComplete` / `SetZCtrlGain` / `SetScanSpeed`。<br>⚠️ `closure_limits` 是判据的一部分，不是说明：`unknown_skills`（被叫到而找不到定义的名字，今天**空表**）· `dynamic_run_sites`（追不动的 7 处，带 `shape` 与 `in_engine`）· `internal_phase_targets`（31 个 `_phase*` —— **解得开但不是技能**，进 `runs` 会让封锁账永远红）· `cycles`（今天空表）。<br>⚠️ 还加了 `non_skill_deps`：闭包里每个函数要的、**不是技能**的东西。`PulseConditionTip` 的封锁件按闭包算是空的，而它今天仍然移不了 —— 缺的是 `core.map_scope.record_damage_marker`（批 7a-2 点名的欠账）与 `core.noble_tip_workflow.{resolve, reconcile_with_tip_envelope}`。**一个只数技能的账，数不出非技能的债。** |

<!-- ── 批 7b-2（势垒链与线缆（8 个技能 / 7 个模块））的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 为什么要单开一台 |
|---|---|---|
| `batch7b2.json` | `export_batch7b2.py` | 通用驱动器给每个动词一个**常数**回包、给每个子技能一个**空 `data`**，于是这八个技能各自卡在**第一道闸**上：`MeasureBarrierHeight` 的每次 `AcquireSTS` 都没有 `spectrum_parsed` ⇒ 方向确认的第一读就 `None`，κ 拟合／噪声底／三条判读**一条都没走到**；`MapBarrierHeight` 的 φ 全是 `None` ⇒「针尖侧／表面侧／灰带」三条一条都没走到；`CleanTipUntilBarrier` 在**第一句**就返回（基线判不了）；`AcquireDeltaFCurve` 每一格都走「装不下」；`RunGridExperiment` 的超时判据读**墙钟**，而那台把墙钟钉死。<br>这一份走**脚本化上下文**（每个动词、每个子技能的回答由用例自己给，同 `export_batch5b.py`），104 格技能 + 60 格纯函数 + 11 格 `validate_params`。合成用闭式：`I(d) = I₀·exp(−2κd)`，κ = 5.123·√φ —— **那是被测代码的逆运算**，于是「拟合对不对」在金样里可以独立验算（期望的 φ 就是输入的 φ）。 |

⚠️ **这一台的墙钟会走**，而别的都不会。`export_skill_traces.py` 把 `time.time`
钉死成常数（理由是「重跑逐字节相同」），代价是 `RunGridExperiment` 的超时判据在
那份金样里是死代码。这一台把 `time.time` 也接到 `_CLOCK` 上（只由 `sleep` 与
每次读的 1e-3 往前拨）—— 仍然逐字节可复现，而 `elapsed` 真的会涨。
两侧这条判据的符号一定一致：主项是**睡掉的那些秒**（每拍 2 s，逐位相同），
读钟带来的零头两侧都是正的。

⚠️ **`CalibrateCoarseStep` 的标定循环没有金样，而那不是遗漏**：`ScanAt` 从不返回
`scan_path`（D-SCANPATH-1），于是 `execute` 恒在「基准帧扫描失败」返回。
这里录的是**今天真的走得到**的那几格；`phase_shift` 那 15 行**单独成节**
（纯数值、零 I/O、零 RANSAC）；循环内部由 TS 侧一份**明写是假设**的脚本驱动
（名字带 `hypothetical`）。

⚠️ **`phase_shift` 的合成帧带一层 2% 的非周期宽带噪声**，理由写在导出器
`pit_frame` 的抬头：三个解析高斯求和的谱里有数值为零的格，而
`R /= max(|R|, 1e-30)` 会把那几格的**相位**整个放出来 —— 那不是舍入误差，
是一个**没有定义的量**。加噪声之后 `max|R|/min|R|` 从 `6.4e15` 降到 `2.2e7`，
`snr` 两侧的差从 `2e−10` 回到 `4e−14`（推得出来的界之内）。
第一版用的是周期噪声（`(31r+17c) mod 13`），**相关峰整个挪了位** ——
那不是精度问题，是答案变了。

<!-- ── 批 7b-3（composite 零新原语五个 + paper 四个纯函数）的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 为什么要单开一台 |
|---|---|---|
| `batch7a3.json` | `export_batch7a3.py` | 通用驱动器对这两个技能各自照不到一整半。`FindFlatRegion` 的 `_params_for` 给不出一条真实的 `.sxm` 路径 ⇒ 那一份里只有「文件不存在」那一支，而十一个参数、两次不同步长的扫描、三条失败路径、`count > 1` 的多落点**一条都没被验到**；`BiasWiggle` 每个动词只拿得到一个**常数**回包，于是电流跳闸 / `Bias_Set` 失败 / 反馈关着 / 读不到起点四条全走不到，而随机数与墙钟这两样在那份驱动器里也不是用例能控的。这一份自己合成 `.sxm` 字节（闭式 sin-hash，零随机数）再喂进旧仓两个技能，外加五节判据本体：`np_grid`（`linspace` / `digitize` / **按边界数组**的 `histogram` / 二维 `gradient` / `argsort[::-1]`）· `hist_modes` · `kde_layers` · `local_plane_rms` · **`mt19937`**。<br>⚠️ `mt19937` 那一节对的是 **CPython 的 `random`**（不是 numpy）：`BiasWiggle` 的每一个扰动目标与每一段停留都是它的直接产物，而停留时长决定一次 burst 打得出几次跳变 —— 换一个 RNG，这个技能整条轨迹就没有判据了。<br>⚠️ `local_plane_rms` 每一格随金样录一个 **`z_span`**，`FindFlatRegion` 每一格随金样录一个 **`leveled_span_m`** —— 那是 `localRmsAbsTol` 的**入口**（同批 6c 的 `polyfit_cond`：容差里唯一的未知数，录下来就不再是未知数）。 |

| 文件 | 导出器 | 为什么要单开一台 |
|---|---|---|
| `batch6c.json` | `export_batch6c.py` | 四个技能**一次 Nanonis 调用都不发**：两个读 `.sxm`、两个读 `.dat`。通用驱动器的 `_params_for` 给不出真实路径 ⇒ 它们在 `skill_traces.json` 里只录得到「文件不存在」那一支。这一份自己合成字节（闭式、零随机数）再喂进旧仓四个技能，外加九节判据本体（`_edge_resolution` / `_fwd_bwd_instability` / `assess_iz` / `assess_iv` / `sader_jarvis` / `invert_force_curve` / 多帧一致性）。**`polyfit` 的条件数与解向量分量比随每一格录** —— 容差要用它们 |


通用轨迹金样喂的是**常数回包**，于是一整族判据可能一格都没被走到。
**格数只决定走了几遍同一条路，驱动器才决定能走到哪条路。**

| 文件 | 导出器 | 为什么要单开一台 |
|---|---|---|
| `z_trace.json` | `export_z_trace.py` | 通用回包里电流与 Z 恒为 0.25 ⇒ 扎针判定只走得到「Δz 恒为 0、`no_press`」一条路。这一份手搭曲线，**一条判据一格** |
| `environment.json` | `export_environment.py` | 真空与温度的分支**全由参数决定**（技能一次 Nanonis 调用都不发），通用注错点一条都碰不到 |
| `numerics.json` | `export_numerics.py` | numpy / scipy **真跑一遍**。**输入与答案一起录** —— TS 复现不了 PCG64，「同一批输入」只能靠录下来 |
| `nanonis_files.json` | `export_nanonis_files.py` | 字节由脚本**合成**，读出来的东西由**旧仓真实读取器**给出。真机文件不进本仓（用户裁决：只用合成数据） |
| `analysis.json` | `export_analysis.py` | 分析判定件（掩膜 / 团簇 / 平面 / 台阶 / 原子线 / 起伏闸）。**帧从 `.sxm` 字节读回来，不在两侧各自按闭式重建** —— 第一版那么做时 `noiseFloor` 差 4.4e-14，原因不是 `sin` 而是**加法结合律**（numpy 先把 tilt 算成整个数组）。**两边各自重建同一个输入，不是同一个输入。** |
| `wire_frames.json` · `wire_types.json` | `export_wire_fixtures.py` · `export_wire_types.py` | 字节层：请求侧 = 真实 `nanonis_spm` 客户端（MAST 打过补丁），回复侧 = STM-Bench 服务端 codec |
| `scan_resolver.json` | `export_scan_resolver.py` | 真 `resolve_scan`（意图 → 参数）。它一次仪器调用都不发，产物是 `trace[*].source` —— **通用驱动器一格都碰不到**。77 格盯的是「哪一支赢了」：explicit > 档位表(用户) > 偏好 > 档位表(出厂) > keep-current |
| `tip_crash.json` | `export_tip_crash.py` | 真 `TipCrashTracker`。它**全是状态**，判据是「第三次调用为什么被拒」⇒ 每条金样是一个**脚本**（record/count/blocked/points/recover/tick/snapshot 依次执行），不是一格输入 |
| `tip_policy.json` | `export_tip_policy.py` | 真 `resolve_policy` + `resolve_conditioning`（针尖方案表与安全包络）。**通用驱动器直调 `execute`，`validate_params` 一次都没被调用** —— 而这一族的判据全在那里。12 支针尖 × 23 个请求 = **276 格**，其中 111 格**被拒**（超上限拒绝、不夹紧）。第 23 个请求 `shaper_depth_at_limit`（深度**正好等于上限**）2026-09-19 补，钉的是「上限是闭的」 |
| `instrument_profile.json` | `export_instrument_profile.py` | 真 `instrument_profile`：键表的夹取与丢弃 18 格、`get_config` 的三级回落 9 格、`z_extend_sign` 三态 5 格、倾斜标定「四个元素缺一个就是没标定过」4 格。另记 `ablated_keys`（旧仓有、本仓按消融精神没登记的 39 个），**让「少了」与「漏了」分得开** |
| `coarse_drive.json` | `export_coarse_drive.py` | 真 `coarse_drive` 的四道锁：`authorize` / `readback_matches` 各 3 种声明状态 × 15/12 格，**整段拒绝文本逐字**（那几句是直接给人和模型看的）。通用驱动器只走得到「没声明 ⇒ 拒绝一切」那一格 |
| `z_settle.json` | `export_z_settle.py` | 真 `ZSettle` + **两台**方向判定机（`RetractForSampleChange._judge_recede` 与 `RelocateCoarseXY._judge_recede`，旧仓就是两个、措辞不同、刻意不合并）+ 「测出来是零」那道守卫 + 两条梯子。10 种读数形状 × `as_dict`、15 对 × 2 台、8 格没位移 |

---

## 二、四条别忘的

**用的是 `_get_metadata_raw` 不是 `_get_metadata`。** 前者是技能作者的声明，后者叠加了 admin 覆盖。
旧仓自己的注释讲得最清楚：拿叠加后的当基线，一个「调低某技能 safety_level」的管理员覆盖就会变成新标尺，
把审批闸门洗白。**分母要的是声明，不是当前生效的包络。**

**报错原文也是契约。** `si_cases.json` 里录了异常类型与完整消息，因为模型读到的正是这些句子
（PLAN §3.2-1、§3.2-16）。已经发现 strict 与 loose 对同一个非法输入给的是**两句不同的教学文案** ——
这种东西照着行为写 TS 能过，照着措辞写才对得上。

**金样里不许有每次都变的东西。** 2026-09-16 踩到两次：`.3ds` 那批的异常消息里带着一个随机临时目录
（改成裸文件名 —— **路径本身不是判据，路径之前的那句话才是**）；轨迹里带着落盘路径与时间戳
（`_TRACE_STAMP` 抹除）。一个每次都变的金样回答不了任何问题。

**合成数据要可复现，所以不用随机数。** `z_trace.json` 的噪声用的是一个**不整除周期的锯齿**，
`nanonis_files.json` 的像素值是 `base + iy*0.25 + ix*0.0625` 这样一个闭式 ——
重跑不依赖任何种子状态，而且「行列搞反了」在数值上当场看得出来。

---

## 三、还没导的

按消融原则等各自的消费者出现再加：`tool_packs.json` / `prompts/` / `traces/`（PLAN §8.6 的完整清单）。
`traces/` 在 §12 的差分测试。**脚本已经搭好，加一个 collector 就是加一个函数。**
