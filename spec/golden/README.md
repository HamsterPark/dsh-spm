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

<!-- ── 批 7a-2（实验地图层 + FindCleanSpot）的驱动器写在这一行下面 ── -->

<!-- ── 批 7a-3（kde_layers + FindFlatRegion + BiasWiggle）的驱动器写在这一行下面 ── -->

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
