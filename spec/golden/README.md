# 参考金样与导出器索引

本目录保存迁移测试使用的参考声明、执行结果、数值输出和静态依赖分析。**2026-09-21 按当前 JSON 结构复核：50 份 JSON，另有 `records_schema.sql`。** 下列数量统计的是夹具结构，不是测试数或完整运行验收结果；本次没有重新执行导出器。

## 来源与复现方式

| 来源类别 | 典型文件 | 证据范围 |
|---|---|---|
| 参考声明 | `skills.json`、`records_schema.json`、`manifest.json` | 作者声明、数据库结构及 collector 状态 |
| 参考代码执行 | `skill_traces.json`、SI／安全／前置条件、各专用驱动器 | 在指定输入、时钟和上下文下执行 MAST 实现；部分文件同时包含常量或声明 |
| 公共数值库执行 | `numerics.json` | NumPy、SciPy、scikit-image 对保存输入的计算结果；无需私有 MAST |
| 静态源码分析 | `tip_phase_deps.json` | 可能的子技能与函数依赖、非技能依赖和无法解析的边界；不执行仪器流程 |
| 协议编解码 | `wire_frames.json`、`wire_types.json` | 参考客户端与 STM-Bench codec 产生的请求／回复字节 |

不要手填数值或轨迹来消除测试差异。说明字段、匿名测试标签和已登记标识符的公开清理例外见 [开发指南](../../docs/DEVELOPMENT.md#金样生成物与参考仓) 与 [公开内容审查](../../docs/PUBLIC-CODE-REVIEW.md)。部分说明来自参考系统观测；去标识化不改变来源类别。

从仓库根目录使用具有相应依赖的 Python 环境运行。需要外部源码的脚本通过以下环境变量配置：

- `MAST_ROOT`：包含 `mast/` Python 包的只读参考源码目录，可能是参考项目的 `MASTv2/` 子目录。
- `STMSIM_ROOT`：包含 `stmsim/` 的只读 STM-Bench 源码目录，仅相关协议导出器需要。
- `MAST2_PROJECT_ROOT`：隔离运行目录，不得指向参考仓；它不是 `MAST_ROOT` 的别名。

缺少所需源码变量、变量为空或指向非目录时，入口会报错。下面脚本名是占位符；执行前读对应脚本的依赖、输出路径和开发指南中的只读检查要求。

```text
python tools/spec-export/<脚本>.py
```

导出会更新本目录的对应产物，并可能在隔离目录写入运行文件。导出前隔离配置与数据目录、禁用参考目录中的字节码写入；导出后检查参考目录未被修改。同条件导出两次并比较完整字节，记录参考版本与环境。历史逐字节复现结果不代替新一轮检查。

2026-09-20 的公开文本清理没有重导金样；当前说明与匿名标识不保证与私有原始导出逐字一致。重导后应再次检查公开内容。`manifest.json` 的源码位置记录为 `<MAST_ROOT>`，不得恢复开发者的实际目录。

## 一、文件与导出器

各导出器文件头说明参考入口、输入构造和比较条件。以下保留专用驱动器的注册落点；文件名中的批次号用于定位历史来源。

### ① 基础规格与契约

| 文件 | 导出器 | 内容 |
|---|---|---|
| `skills.json` | `export_mast_spec.py` | 515 条技能的作者声明：category、safety_level、description、ParameterSpec（含 unit、min/max、allowed_values）、preconditions、capabilities、composition_level、模块与 origin |
| `si_cases.json` | 同上 | 执行 `parse_si`、strict／loose `parse_quantity`、`needs_strict_prefix`、`format_si`，包含异常类型与完整消息 |
| `safety.json` | `export_safety_spec.py` | 包络 14 字段、全局检查 19 项、物理荒谬条件 11 项、中止安全写 24 条、全部 671 个动词的 `_is_read` 判定，以及硬闸、能力和模式拒绝文本 |
| `preconditions.json` | `export_preconditions.py` | 词表与 10 个前置条件 × 14 个夹具的 140 格网格，逐格记录违反消息，覆盖子串匹配及否定形式 |
| `tool_schemas.json` · `tool_schemas_real.json` | `export_tool_schemas.py` | 21 个合成参数 schema 用例与全部 515 个技能的模型 schema；保存模型可见范围及文字 |
| `records_schema.json` · `records_schema.sql` | `export_records_schema.py` | 记录层建表语句与声明，用于执行建表后逐表、逐对象比较 |
| `manifest.json` | `export_mast_spec.py` | 该导出器各 collector 的成功状态与条数；不是本目录全部专用导出器的运行记录 |

### ② 通用轨迹与状态机

这一组执行参考代码并保存返回值、调用序列或状态变化。固定回包的通用驱动器不能覆盖所有分支，专用驱动器在下一节补充输入。

| 文件 | 导出器 | 执行范围 |
|---|---|---|
| `skill_traces.json` | `export_skill_traces.py` | 442 个技能、1,798 条调用轨迹，其中 20 条记录 `raised` 异常；按每项 `traces` 计数 |
| `watchdog.json` | `export_watchdog_trace.py` | 用可控时钟驱动 `SafetyWatchdog.run()`，覆盖武装状态与动作触发条件 |
| `state.json` | `export_state_spec.py` | `InstrumentState` 的调用、读数转换与状态：21 个转换用例、14 条脚本共 29 步、7 个实时提示块 |
| `breaker_trace.json` | `export_breaker_trace.py` | 熔断状态机的 6 条脚本，共 50 步 |
| `graph_executor.json` | `export_graph_executor.py` | `GraphExecutor` 的执行与恢复守卫 |
| `approach.json` · `approach_gate.json` · `approach_tip.json` | `export_approach.py` · `export_approach_gate.py` · `export_approach_tip.py` | `AutoApproach`、`safety_escalation`、`ApproachTip._approach` |
| `scan_chain.json` · `scan_wait.json` | `export_scan_chain.py` · `export_scan_wait.py` | `scan_policy`、`imaging` 判据，以及 `WaitScanComplete` 和回复解析 |
| `bias_ramp.json` | `export_bias_ramp.py` | `SetBiasRamp` |
| `tip_park.json` | `export_tip_park.py` | `tip_park` 判定机 |
| `claim_audit.json` | `export_claim_audit.py` | 声明、技能运行与文件证据的交叉核对 |
| `advanced_ops.json` | `export_advanced_ops.py` | `QuitNanonis`、`WaitForScanEndBlocking` |
| `frames_presets.json` · `zctrl_presets.json` · `lockin_presets.json` | `export_frames_presets.py` · `export_zctrl_presets.py` · `export_lockin_presets.py` | NumPy 生成的 `.npy` 字节，以及三套参数组的解析与技能行为 |

### ③ 专用驱动器与静态依赖

并行支线只在分配给自己的锚点下添加条目，保留相邻落点之间的隔离行。锚点与现有表格的相对位置属于协作约定，详见 [开发指南](../../docs/DEVELOPMENT.md#并行协作与合并)。

<!-- ── 批 6a（特异化流程 _tip_phases 六个组合技能）的驱动器写在这一行下面 ── -->

| 金样 | 驱动器 | 专门覆盖的内容 |
|---|---|---|
| `tip_phase_deps.json` | `export_tip_phase_deps.py` | 对六条 `_tip_phases` 流程的 `plan_dynamic` 做 AST 分析，记录函数调用与可能发出的 `CompositeStep`，再结合技能调用表计算依赖闭包。此导出器不执行参考运行时；结果是依赖范围，不是流程运行轨迹 |

<!-- ── 批 6b（vision 的 scan_prep 链）的驱动器写在这一行下面 ── -->

| `export_scan_prep.py` → `scan_prep.json` | `scan_prep`、`scan_artifacts`、`tip_change` 判据与两个技能；37 张合成 `.sxm`，15 个数据节。闭式或固定种子生成的帧均从保存字节读回 |

该驱动器为分支提供专门输入。以下两个条件会影响造帧与断言：

- `detect_scan_artifacts` 的 `std < 1e-9` 早退使 pm 级起伏无法进入 `_oscillation`、`_drift_px`、`_spike_frac`。覆盖这些分支需要 nm 级起伏的帧。
- `measure_frame` 在调用 `detect_tip_change` 前执行 `line_subtract`，会移除逐行偏置。历史用例中 600 pm 的纯 DC 跳变得到 `dc = −6.285`，未触发该路判据；需要另有纹理变化的用例检验相应分支。

<!-- ── 批 6c（批 5b 欠下的数值原语 + 晶格一族剩余）的驱动器写在这一行下面 ── -->

<!-- ── 批 7a-1（vision/tilt 一族 + AnalyzeFrameTilt + AutoTilt）的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 专门覆盖的内容 |
|---|---|---|
| `tilt.json` | `export_tilt.py` | 合成 `.sxm` 字节、闭式 `ZSim` 斜面读数和脚本化子技能回复，覆盖 `AnalyzeFrameTilt`、`AutoTilt`、`TiltCalibrate`；固定墙钟与单调钟 |

该组比较还保留以下条件：

- `ransac_spread` 保存不同抽样序列的结果变化，作为 D-VISION-1 容差依据。历史 12 个种子间的 `b` 差为 `3.3e-3`；主路径的棋盘噪声样例内点相同，谱宽为 0。
- `*_seg` / `*_noseg` 同时记录有／无分割器的路径。无分割器场景通过使真实导入抛出 `ImportError` 进入参考 fail-open 分支。
- `estimate_tilt_unreachable`、`no_action_reason_unreachable`、`fit_circle_tilt.all_same_angle` 保留不可达或退化情形的证据。

<!-- ── 批 7a-2（实验地图层 + FindCleanSpot）的驱动器写在这一行下面 ── -->

| `map_scope.json` | `export_map_scope.py` | 用档案、实验记录、撞针记忆和仪器回复构造 `FindCleanSpot` 上下文。10 个数据节：环带顺序、25 个配置用例、22 个 marker、9 组代次、7 个三态读地图用例、5 个撞针记忆用例、8 组避让圆、26 个选点几何用例、10 个坐标串解析用例、39 个技能用例 |

26 个选点用例对应具体的几何判断。历史导出验证过 15 种候选改写，其中 13 种会改变至少一个输出；去掉提前退出、去掉 `max_ring` 的 `+2` 未改变该算法结果，未作为有效变异登记，原因见 [偏差登记](../deviations.md)。

相切、正好一个直径、正好等于 `max_distance_m` 的边界用例放在坐标轴上，使 `hypot(a, 0)` 精确；斜向 `hypot(a, a)` 的 1 ULP 差异单独按 D-HYPOT-1 处理。

<!-- ── 批 7a-3（kde_layers + FindFlatRegion + BiasWiggle）的驱动器写在这一行下面 ── -->

<!-- ── 批 7b-1（封锁账闭包化 + AssessAtomicPhase + 两条已解封锁的流程）的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 专门覆盖的内容 |
|---|---|---|
| `batch7b1.json` | `export_batch7b1.py` | 12 个闭式合成、仅含正扫的 `.sxm`；26 个 `AssessAtomicPhase` 用例与 10 个 `resolve_substrate` 用例。覆盖 `_MIN_COVERAGE=0.5`、`expected_a_nm` 的正值／0／未提供三态，以及请求 Z 通道不可用时回落到首个通道。覆盖率 0.25、0.4375（内部判据通过）与 0.5 分别区分拒绝、最终通过值受覆盖率限制及严格小于边界。<br>`expected_zero_with_substrate` 区分“0 禁用比较”和“未提供则查衬底”。`SURFACE_LATTICE_NM` 七个面全部进入用例；参考只认四个洁净金属面，`HOPG` / `NaCl(100)` / `Si(111)-1x1` 为 `available=false`。Pt(111) 的 `2.775/10` 与 `0.2775` 差 1 ULP，见 D-ROWSPACING-1 |
| `tip_phase_deps.json`（扩展） | `export_tip_phase_deps.py` | `skill_runs` 覆盖 515 个技能，追踪 `context.run(...)` 与 `CompositeStep(skill_name=...)` 两种边。当前 `closure_limits` 保存 7 处动态调用、31 个非技能的内部阶段目标，`unknown_skills` 与 `cycles` 均为空；具体追踪深度以 `follow_rule` 为准。函数级 `non_skill_deps` 另列地图写侧与 `noble_tip_workflow` 等组件；没有未迁移子技能不等于其他依赖已具备 |

<!-- ── 批 7b-2（势垒链与线缆（8 个技能 / 7 个模块））的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 专门覆盖的内容 |
|---|---|---|
| `batch7b2.json` | `export_batch7b2.py` | 脚本化动词与子技能回复，补充通用常数回复无法覆盖的势垒拟合、噪声底、针尖／表面判读、Δf 曲线与网格超时分支。104 个技能用例、63 个纯函数用例、11 个 `validate_params` 用例。势垒输入采用 `I(d) = I₀·exp(−2κd)`、κ = 5.123·√φ，输入 φ 可独立核对拟合结果 |

该驱动器让 `time.time` 随受控 `_CLOCK` 前进：sleep 与每次读钟的 1e-3 增量决定时间，不使用真实墙钟。这样可复现 `RunGridExperiment` 的超时分支；通用驱动器中的常量时钟无法覆盖它。测试需保留每拍 2 s 的主项及正的读钟增量。

`CalibrateCoarseStep` 的参考标定循环受 `ScanAt` 不返回 `scan_path` 的限制，见 D-SCANPATH-1。金样记录可达的拒绝路径；`phase_shift` 单独比较。TypeScript 对循环内部的脚本化验证标有 `hypothetical`，不能与参考可达路径混称。

`phase_shift` 使用带 2% 非周期宽带噪声的合成帧，避免 `R /= max(|R|, 1e-30)` 对近零谱分量放大未定义相位。历史构造记录中，`max|R|/min|R|` 从 `6.4e15` 降至 `2.2e7`，两侧 `snr` 差从 `2e−10` 降至 `4e−14`。周期噪声 `(31r+17c) mod 13` 曾改变相关峰位置，因此不能替代当前噪声形状。

<!-- ── 批 7b-3（composite 零新原语五个 + paper 四个纯函数）的驱动器写在这一行下面 ── -->

<!-- ── 批 8a-1（写侧 record_damage_marker + 贵金属链三条流程 + AssessShockleyOnset）的驱动器写在这一行下面 ── -->

<!-- ── 批 8a-2（builtins 剩余 A 档：自检 / 对账 / 漂移一族）的驱动器写在这一行下面 ── -->

<!-- ── 批 8a-3（paper 第二批：CheckLineQuality · Bragg 漂移 · 谱拟合 · montage 判据层）的驱动器写在这一行下面 ── -->

| 文件 | 导出器 | 专门覆盖的内容 |
|---|---|---|
| `batch7b3.json` | `export_batch7b3.py` | 按技能名脚本化子技能回复，记录组合流程的调用次序与参数；54 个用例：`GridSTS` 7、`DemoScanAndSTS` 10、`TrackDrift_ReferenceScan` 11、`AcquireBiasImagingSeries` 10、`MoveAtomTo` 16。<br>每个用例使用独立 `run_id`，防止 sidecar 按已完成步骤续跑；墙钟与单调钟均受控。`diagonal_drag_exercises_hypot` 是斜向距离用例，其余 15 个 `MoveAtomTo` 用例的 dy 为 0。斜向距离 `hypot(7e-10, 5e-10) = 8.602e-10` 对应 `ceil(8.602) = 9`，远离整数边界，隔离 D-HYPOT-1 对航点数的影响 |
| `paper_data.json` | `export_paper_data.py` | 16 个技能、130 个用例；覆盖合成文件上的处理、漂移、原子识别、分区与反卷积。保留 `frame_atoms` 的半整数质心、四／八邻接、`> std` 和 `min_distance_px` 判据；`frame_blurred_disks` 全正以限制 RL 除法对数值差异的放大；自定义 PSF 包含奇偶两种、且不对称。<br>`rl_facts` 记录 PSF 形状与每轮 `change`。`iterations_used` 由 `change < 1e-6` 决定，整数结果精确比较；输出容差 `rlOutputRelTol` 依据抽头数和轮数。历史最紧用例距阈值 4.2%，两条卷积路线差为 1e-7 相对量级。`custom_psf_even` 区分 same-卷积原点，奇数核不能暴露的一像素位移在偶数核上可见 |

| 文件 | 导出器 | 专门覆盖的内容 |
|---|---|---|
| `batch7a3.json` | `export_batch7a3.py` | 合成 `.sxm` 字节覆盖 `FindFlatRegion` 的真实文件、不同扫描步长、失败分支与多落点；受控时钟／随机序列覆盖 `BiasWiggle` 的电流、写入失败、反馈与起点读回分支。另含 `np_grid`（linspace、digitize、按边界数组的 histogram、二维 gradient、argsort 逆序）、`hist_modes`、`kde_layers`、`local_plane_rms`、`mt19937`。<br>`mt19937` 对应 CPython `random` 而非 NumPy；扰动目标与停留时长依赖该序列。`z_span` 和 `leveled_span_m` 随用例保存，供 `localRmsAbsTol` 计算 |

| 文件 | 导出器 | 专门覆盖的内容 |
|---|---|---|
| `batch6c.json` | `export_batch6c.py` | 四个离线技能分别读合成 `.sxm` / `.dat` 字节，补充通用驱动器仅有的文件缺失路径。包含 `_edge_resolution`、`_fwd_bwd_instability`、`assess_iz`、`assess_iv`、`sader_jarvis`、`invert_force_curve` 与多帧一致性等九组判据。每例保存 `polyfit` 条件数和解向量分量比，供容差计算 |

其余专用文件如下。选用驱动器时先检查其输入是否能进入待测分支；增加同一路径的样例数量不会自动增加分支证据。

| 文件 | 导出器 | 专门覆盖的内容 |
|---|---|---|
| `z_trace.json` | `export_z_trace.py` | 手工定义的曲线覆盖不同扎针判据，补充电流／Z 常数回复只有 Δz = 0、`no_press` 的情形 |
| `environment.json` | `export_environment.py` | 真空与温度的参数判定；这些分支不经过仪器调用，需独立于通用注错点覆盖 |
| `numerics.json` | `export_numerics.py` | 执行 NumPy、SciPy、scikit-image，并同时保存输入与结果。固定种子不代替相同输入；随机算法的比较方式以相应测试为准，本仓已有独立的 PCG64 实现 |
| `nanonis_files.json` | `export_nanonis_files.py` | 脚本合成字节，由参考读取器给出解析结果；不收入真实仪器文件 |
| `analysis.json` | `export_analysis.py` | 掩膜、团簇、平面、台阶、原子线与起伏判据。两侧从同一 `.sxm` 字节读帧，避免分别计算闭式输入时因加法结合顺序产生差异；历史 `noiseFloor` 差为 4.4e-14 |
| `wire_frames.json` · `wire_types.json` | `export_wire_fixtures.py` · `export_wire_types.py` | 请求侧使用 MAST 修改的 `nanonis_spm` 客户端，回复侧使用 STM-Bench codec |
| `scan_resolver.json` | `export_scan_resolver.py` | `resolve_scan` 的 77 个用例，比较 `trace[*].source`；优先次序为 explicit > 用户档位表 > 偏好 > 出厂档位表 > keep-current |
| `tip_crash.json` | `export_tip_crash.py` | `TipCrashTracker` 的状态脚本，依次执行 record / count / blocked / points / recover / tick / snapshot |
| `tip_policy.json` | `export_tip_policy.py` | `resolve_policy` 与 `resolve_conditioning`：12 支针尖 × 23 个请求，共 276 例，111 例拒绝。超上限时拒绝而非夹紧；`shaper_depth_at_limit` 覆盖恰好等于上限 |
| `instrument_profile.json` | `export_instrument_profile.py` | 22 个配置清理用例、16 个 `get_config` 用例、5 个 `z_extend_sign` 用例、4 个倾斜标定用例；`ablated_keys` 明列当前排除的 29 个参考键 |
| `coarse_drive.json` | `export_coarse_drive.py` | `authorize` / `readback_matches` 各覆盖 4 种声明状态 × 15 / 12 个用例；完整拒绝文本逐字比较 |
| `z_settle.json` | `export_z_settle.py` | `ZSettle`、`RetractForSampleChange._judge_recede` 与 `RelocateCoarseXY._judge_recede` 两套不同措辞的方向判定，以及位移与阶梯规则；10 个读数形状、两组各 15 个方向用例、8 个无位移用例 |
| `batch5b.json` | `export_batch5b.py` | 74 个脚本化上下文用例，覆盖区域批处理、偏压、电流分类／监测、PSD、恢复、热稳定与扫描观察 |
| `lattice.json` | `export_lattice.py` | 晶格、纹理与相关技能；使用合成 `.sxm` 的同一字节输入，保存条件数，按相应算法比较峰值、几何量和判定结果 |

## 二、维护约束

1. **作者声明与运行覆盖分开。** 技能规格读取 `_get_metadata_raw`，不使用叠加管理员覆盖的 `_get_metadata`；否则当前设置会被误记为原始安全声明。
2. **异常文本也是契约。** 例如 SI strict／loose 对非法输入有不同消息，应保留异常类型与原文；有意差异按 [偏差登记](../deviations.md) 处理。
3. **去除无关的不确定性。** 临时目录、落盘路径、时间戳等非判据字段应由导出器规范化；保留真正参与判断的信息。不要用不稳定金样解释实现差异。
4. **输入必须可重现。** 可使用闭式输入或固定种子，并保存必要的版本与实际输入。选择能区分候选实现的数值；例如 `base + iy*0.25 + ix*0.0625` 可暴露行列交换。随机种子、容差和输入形状的变化都应作为有意改动审查。

数值阈值、容差依据与不可达路径的细节以导出器、对应测试及偏差登记为准。说明字段的公共清理不授权修改数值或二进制载荷，也不把历史参考观测改称合成输入。

## 三、尚未导出的范围

`tool_packs.json`、`prompts/`、独立 `traces/` 目录仍是 [PLAN](../../docs/PLAN.md) §8.6 / §12 中按消费者需求添加的计划项。这里的 `traces/` 不等于已存在的 `skill_traces.json`。新增导出时需明确消费者、来源与判据，并同步本索引。
