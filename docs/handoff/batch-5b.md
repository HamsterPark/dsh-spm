# 批 5b 交接 —— A 档零散一批（**9 / 14**），九个模块各自收口

盘点分派的 14 个里落了 **9 个**，**九个模块全部收口**（每个模块只有这一个技能）。
没落的 5 个逐条写在 §5，每一条卡在**哪个函数、多少行**。

技能 **394 → 403**（分母 515），模块 **71 → 80**（分母 165），
测试 **4898 → 5058**（另 63 → **69** 条集成），变异 **401 → 459 条全红**，
偏差登记 **+6 条**（编号留空）。

| 组 | 技能 | 模块 |
|---|---|---|
| 电流诊断 | `MonitorCurrent` · `MonitorCurrentFFT` · `ClassifyUnexplainedCurrent` · `RecoverTipFromSaturation` | `current_monitor` · `monitor_current_fft` · `current_origin` · `saturation_recovery` |
| 时序 | `WaitForThermalSettle` · `WatchScanLines` | `thermal_settle` · `scan_watch` |
| 组合 | `BiasSettleChange` · `AcquirePSD` · `BatchRegionsScan` | `composite.bias_settle` · `acquire_psd` · `composite.batch_regions_scan` |

**没做的 5 个**：`RunGridExperiment`（§5.1，卡在一条**墙钟**判据上）·
`AssessTipSharpness` · `AssessTipFromSpectrum` · `AssessSpectrum` ·
`InvertForceSaderJarvis`（§5.2，四个都欠数值原语 + 一台新导出器）。

---

## 0. 一句话

> 这一批的技能**判决都很便宜、证据都很贵**：一句「这不是结电流」背后是四个偏压点、
> 一次对数拟合、一条比值判据和一个 0 V 读数，而**通用轨迹金样一个都走不到**
> （它给每个动词一个常数回包、给每个子技能一个空 `data`）。
> 于是这一批一半的力气花在**一台脚本化的导出器**上 —— 让每一道闸都有一格
> **专门为它造的**输入；另一半花在确认那几格**真的分得开两种候选**。

---

## 1. 落地的件

```
新增（kernel —— 零 numpy、零 I/O 的判据）
  packages/host/kernel/src/current-diag.ts        饱和三态 + 偏压依赖判别表（6 个结论）
  packages/host/kernel/src/bias-settle.ts         穿零死区 + 三分支策略 + 缺省稳定时间
  packages/host/kernel/src/batch-regions.ts       区域清单校验（与 `ParseRegions` **并存不合并**）+ 逐区查档

新增（技能层）
  packages/host/stm-skills/src/l0/current-monitor.ts   MonitorCurrent + MonitorCurrentFFT（含 rfft / 两个窗）
  packages/host/stm-skills/src/l0/current-origin.ts    ClassifyUnexplainedCurrent + RecoverTipFromSaturation
  packages/host/stm-skills/src/l0/thermal-settle.ts    WaitForThermalSettle
  packages/host/stm-skills/src/l0/scan-watch.ts        WatchScanLines
  packages/host/stm-skills/src/l0/acquire-psd.ts       AcquirePSD（GraphExecutor 相计划）
  packages/host/stm-skills/src/composite/bias-settle.ts        BiasSettleChange
  packages/host/stm-skills/src/composite/batch-regions-scan.ts BatchRegionsScan（GraphExecutor 子技能计划）

新增（测试与金样）
  packages/host/stm-skills/src/l0/batch5b.test.ts        75 条（74 格金样重放 + 一条「金样不是空的」）
  packages/host/stm-skills/src/l0/batch5b-edges.test.ts  10 条手写边角
  packages/host/kernel/src/current-diag.test.ts          14 条（判别表里技能层排不出来的四格 + 退化输入）
  packages/host/kernel/src/batch-regions.test.ts         10 条（**「与 `ParseRegions` 答案不同」的三格**）
  packages/host/kernel/src/bias-settle.test.ts            7 条（两条阈值线必须在同一点上分）
  packages/host/stm-skills/integration/current-diag.test.ts  6 条 stmsim e2e
  tools/spec-export/export_batch5b.py                    判据金样导出器（新开的一台）
  spec/golden/batch5b.json                               74 格 · 1.4 MB

改（全部在预留的锚点下）
  packages/host/kernel/src/index.ts               批 5b 锚点 + 三行 export
  packages/host/stm-skills/src/l0/index.ts        批 5b 锚点三处
  scripts/gen-skill-specs.ts                      BATCH_5B 9 个名字
  tools/spec-export/export_skill_traces.py        BATCH_5B 9 个名字
  tools/mutate/mutations.ts                       批 5b 锚点 + 58 条
  spec/deviations.md                              批 5b 锚点 + 6 条（**编号留空**）
  packages/host/stm-skills/src/l0/traces.test.ts  `DEVIATIONS` 表末尾加 2 条 + `CLOCK_KEYS` 加 4 个叶子
生成物（已按本支线重跑）
  packages/host/stm-skills/src/generated/specs.ts · spec/golden/skill_traces.json · spec/progress.json
```

**`packages/host/vision/` 与 `packages/host/numerics/` 一个字节都没动。**
本批要而基线没有的数值原语全落在自己的技能层文件里，清单见 §7.3。

---

## 2. 该登记成 deviation 的（**编号留空** —— 我按 `D-PSD-*` 等临时编了，主线改）

已按本仓体例写进 `spec/deviations.md` 的 `批 5b` 锚点下（新增 6 条）：

| 临时编号 | 一句话 |
|---|---|
| **D-PSD-1** | 一个解析不了的 `freq_range_indices` 要**说出来**（旧仓只写日志，而日志不跟着回包走） |
| **D-PSD-2** | 配置相的**四次**调用失败即忽略，真相要等 `DataGet` —— 照移，代价在真模拟器上当场量到了 |
| **D-WATCH-1** | `WatchScanLines` 与 `AssessAtomicLines` 共用**那份修好的** `resolveReadout`（D-ATOMLINE-1 的射程补一句） |
| **D-B5B-ZERO-1** | 四处**照移的 `or`**：显式的 `0` 退回缺省（与 D-ZERO-1 方向相反，所以必须写下来） |
| **D-B5B-BATCH-1** | `BatchRegionsScan` 的 `angle_deg` 在 `try` 外面会**抛**；顺带记「两份区域校验刻意不合并」 |
| **D-CLOCK-1 补充** | 两个轮询技能进 `clockApprox`，`CLOCK_KEYS` 加四个叶子；**`spectrum` 不能进那张表** |

⚠️ **D-PSD-1 是本批唯一一处「本仓说的话比旧仓多」**，两侧都钉住了 ——
旧仓哪天把那句话加进回包，那条断言会当场变红。

---

## 3. 变异演练（**58 条，全部实跑到 red**）

```
node tools/mutate/run.ts <id…>      # 一条一条
pnpm vitest run --project mutation  # 全部
```

| id | 拆掉它，系统重新犯哪一次错 | 变红 |
|---|---|---|
| `current-saturation-is-three-valued` | `is_saturated(None)` 是**读不到**，不是「没饱和」。改成 false ⇒ 读不到电流的针尖被判成「已恢复」，而它可能还压在样品上 | 9 |
| `current-zero-point-is-the-discriminator` | 0 V 那一读是**唯一**的判别点（压电串扰不关心偏压，隧穿与场发射在 0 V 必须是零）。读不到它还敢往下判 ⇒ 2026-08-28 那个「可能是噪音吧」的假设永远判不掉 | 3 |
| `current-flat-ratio-is-raw-not-fit` | 「与偏压无关」用**原始读数的比值**判。改成只靠对数拟合 ⇒ 这一格按定义与 I(0V) 同量级，被自标定的噪声底恒判成「没有可测的电流」—— 判别表最该抓的那一格被自己的底线吃掉 | 3 |
| `current-abs-floor-matches-this-machine` | 噪声底的绝对下限。改回第一版那个 `1e-12` ⇒ 08-28 实测的 1.00 V→**0.13 pA** 被当成「读不到」剔掉，只剩一个点，拟不出指数 ⇒ 判 undetermined | 9 |
| `current-exponent-drops-noise-floor-points` | 噪声底上的读数是「读不到」，喂进拟合会把指数**拉平**（同 barrier_height 那次）。放它们进来 ⇒ 一次真场发射被拟成近似线性 | 5 |
| `current-field-emission-threshold-is-three` | **3 而不是 2**：真实隧穿结在 1–2 V 上本来就有能带效应带来的超线性。卡 2 ⇒ 好结被判成场发射，而下一步是「降偏压或进针」 | 2 |
| `current-median-of-nothing-is-null` | 一次都没读到时中位是 **null**。回 0 ⇒ 「读不到电流」变成「电流是 0 A」⇒ `is_saturated(0)` 为假 ⇒ 撞过针的针尖被报成「没有饱和，一步都没做」 | 9 |
| `bias-deadband-refuses-on-unknown-feedback` | `feedback_on is not False` —— 「不知道反馈开没开」与「反馈开着」在这一格做同一件事。改成只拦明确开着的 ⇒ 读不到反馈状态时把针尖停进低偏压死区 | 3 |
| `bias-cross-zero-uses-the-fast-slew` | 穿零要用**快**的那条斜坡：停在死区里的每一毫秒反馈都在把针尖往下推。换成常规速率 ⇒ 在死区里多待一倍时间 | 3 |
| `bias-ramp-threshold-and-settle-agree` | 走 `direct` 的那一档必须与「等 0.5 s」那一档用**同一条线**（`>` 对 `<=`）。挪一边 ⇒ 恰好 0.5 V 的改动走 direct 却等 2 s，一个谁都解释不了的组合 | 3 |
| `batch-empty-region-list-is-refused` | 空数组是**拒绝**（与 `ParseRegions` 刻意不同）。放行 ⇒ 排出一个零步的计划、报 `success: true`，而操作员以为整晚的巡游排上了 | 3 |
| `batch-falsy-label-falls-back` | `str(it.get("label") or f"R{i+1}")` —— 空串 / 0 / False 都退回 `R{i+1}`。改成只认 `None` ⇒ 一个 `label: ""` 的区域在汇总里没有名字，而汇总是操作员早上唯一会读的东西 | 3 |
| `batch-line-time-is-per-region` | 每个区域按**它自己的**尺寸查档。改成一个固定值 ⇒ 一个批次里 50 nm 与 200 nm 的区域用同一个速度，对其中大多数都是错的 | 8 |
| `batch-center-limit-is-a-limit` | 中心坐标的 ±1 mm 是**台面行程**。放宽 ⇒ 一个把米当纳米写的坐标（100 m）排进计划，而下游会照着它去驱动压电 | 3 |
| `poll-schedule-is-absolute` | `nextPoll += period` 排的是**绝对**时刻表。改成 `now + period` ⇒ 每一次往返抖动都被加进下一拍，采样率系统性偏低 —— 而那个数正是频谱横轴的刻度 | 18 |
| `poll-sleep-has-a-cap` | 睡眠有上限 = **每拍多次中止检查**。一口气睡到下一拍 ⇒ 一个 60 秒窗口的监控，喊停要等到下一拍才生效（金样上看不见，`batch5b-edges` 直接数睡眠次数） | 3 |
| `fft-window-is-symmetric` | `np.hanning` 的分母是 **M−1**（对称窗）。换成 M ⇒ 变成周期窗，旁瓣整个不一样 —— 而两条谱都「看起来像一条谱」 | 5 |
| `fft-window-name-picks-the-window` | `window` 参数真的换窗。分派拆掉 ⇒ 每一条谱都是不加窗的那一条，而返回值里的 `window` 仍然写着 `hann` | 6 |
| `fft-detrend-removes-the-mean` | 加窗之前先减均值。减 0 ⇒ 零频被直流撑满（实测 9.98e−8 对 7.47e−9，差 13 倍），50 Hz 那条真峰被挤到第三位 | 10 |
| `fft-onesided-skips-dc-and-nyquist` | 单边 PSD 只把**中间**那些格乘 2 —— DC 与 Nyquist 没有镜像的那一半可以折过来。连它们一起乘 ⇒ 两端各高一倍 | 2 |
| `fft-psd-scale-is-the-window-power` | PSD 的归一化分母是 `fs · Σw²`（窗的功率）。换成 `fs · n` ⇒ 加窗之后的谱高度全错，而它仍然是一条形状正确的谱 | 3 |
| `rfft-keeps-half-plus-one` | `rfft` 的长度是 `⌊n/2⌋+1` —— **加一**是 Nyquist 那一格。少一格 ⇒ 频率刻度与谱对不齐，而下标越界的那一端悄悄丢掉最高频 | 11 |
| `monitor-contact-streak-is-consecutive` | `min_contact_samples` 是**连续**超阈的次数。清零那一行拆掉 ⇒ 变成累计，于是一串抖动被读成一次接触（金样里从 0.251 s 提前到 0.231 s） | 3 |
| `monitor-stats-are-on-absolute-current` | 统计量算在 **\|I\|** 上（接触判定看的是量级），`signed_*` 才报原值。混起来 ⇒ 一个负读数把均值拉低，而 `min_abs_a` 会出现负数 | 5 |
| `monitor-zero-samples-is-a-failure` | 一个样本都没采到是**失败**。放行 ⇒ `min/max` 是 ±Infinity、均值是 NaN，而 `success: true`（NaN 穿得过每一条 `>` 检查，同 D-SI-1） | 3 |
| `classify-restores-the-entry-state` | 还原的对象是「**进来时**的样子」，不是「一般情况下该是的样子」。写死 True ⇒ 用户本来关着反馈（手动操作中／已退针），诊断替他开回来，而开反馈会把 Z 驱向 setpoint | 3 |
| `classify-zero-bias-is-added` | 调用方没给 0 V 就**自动补上** —— 缺了它整个判别立不住。拆掉 ⇒ 一份 `"2.0,1.0"` 的请求永远只能回 undetermined | 3 |
| `classify-biases-descend-by-magnitude` | 从大到小量：**结束时停在最小偏压上**比停在最大偏压上安全。拆掉排序 ⇒ 诊断跑完把针尖留在 2 V 的工作点上 | 2 |
| `classify-saturation-is-checked-first` | 饱和要**排在判别表前面**：满量程时每个偏压读数都一样，落进判别表就是「随偏压不变 ⇒ 串扰」—— 正好判反 | 9 |
| `recover-checks-the-lock-first` | 第一步是**查锁**不是撤针。2026-08-28：撤针命令根本没到仪器（ScanAt 持锁 363 s），而「被挡在门外」与「发出去了但没效果」长得一模一样 | 3 |
| `recover-ladder-budget-is-cumulative` | `max_coarse_steps` 是**累计**上限。改成逐级比 ⇒ 一个 60 步的预算会把整条阶梯（800 步）走完，针尖退到再也进不回来 | 3 |
| `recover-failed-step-does-not-count` | 一级粗动**失败了就不计数**。照计 ⇒ 报文说「退了 800 步仍未脱离」，而实际一步都没走 —— 下一个人会去查压电而不是去查粗动被谁拒了 | 3 |
| `recover-unreadable-current-is-not-recovered` | 读不到电流时**判不了**是否饱和。当成「没饱和」⇒ 报「一步都没做」并让调用方继续，而针尖可能还压在样品上 | 8 |
| `thermal-rate-needs-five-points` | **两点连线算出来的「速率」全是噪声**。放到 2 点 ⇒ 换样品后第二次读数就判「稳了」，而那时还在以 1 K/min 下降 | 3 |
| `thermal-both-gates-are-and` | 温度上限与速率上限是**并且**。改成或者 ⇒ 一块 4.35 K 的样品在 `max_temp_k = 4.0` 下照样被判「可以开工」 | 7 |
| `thermal-misses-are-consecutive` | `_MAX_MISSES` 数的是**连续**读不到。不清零 ⇒ 一次通宵等待里零星的几次读不到攒到 5 次就放弃，而温度一直读得到 | 3 |
| `thermal-rate-is-per-minute` | `polyfit` 给的是 K/s，判据的单位是 **K/min**。少乘 60 ⇒ 阈值实际松了 60 倍，一条 1.8 K/min 的下降被判成「0.03 以内，稳了」 | 6 |
| `thermal-window-slides` | 速率用**最近 window 点**拟合。拿整段降温史去拟 ⇒ 算出来的是「平均降了多快」，而这里要问的是「**现在**还在不在降」 | 6 |
| `watch-new-lines-side-follows-the-fill-direction` | 新行在哪一头由**未扫区在哪一侧**决定。反过来 ⇒ 一张正在推进的图被报成「一行新的都没有」，而那条信号本来是要有人接的 | 6 |
| `watch-rows-are-centred-per-row` | 每行先去掉**自己的**均值再统计。不去 ⇒ 整帧的倾斜盖住行内起伏，粗糙度中位数变成慢轴的斜率 | 12 |
| `watch-saturation-is-per-row-extremes` | 触顶比的是**该行自己的**极值（压电到没到头是一行一行发生的）。换成整帧极值 ⇒ 一张有台阶的图上只有最高那几行会报触顶 | 12 |
| `watch-empty-buffer-says-so` | 一行都还没扫出来时**不去算统计**。放行 ⇒ 空集上的中位数是 NaN，而回包看起来是一张「粗糙度 NaN」的正常报告 | 3 |
| `watch-stall-is-the-first-observation` | 「自上次以来一行新的都没有」必须说出来。拆掉 ⇒ 2026-08-21 那八轮重演：对着一张不再更新的图接着打分 | 3 |
| `watch-corr-hint-has-a-threshold` | 行间相关低于 0.5 要提醒（针尖不稳 / 条纹）。阈值拆掉 ⇒ 一张相关 −1.00 的条纹图上一句提醒都没有 | 3 |
| `watch-max-lines-takes-the-newest` | `max_lines` 省的是算力，取的必须是**最新**那几行（未扫区在高号侧时是末尾）。取头几行 ⇒ 报的是几分钟前的那一段，而字段名说它是「新行」 | 3 |
| `psd-capture-failure-aborts` | 一格捕获失败就中止 —— **我们没法拿零去顶一条谱**。改成可选 ⇒ 回一条「成功」而 `per_range` 是空的，调用方读 `data["psd"]` 得到 undefined | 4 |
| `psd-chset-failure-is-fatal` | 指名了信号却设不上去，后面那条谱量的是**另一路信号**。不早退 ⇒ 一条完全正常的谱，只是它不是你要的那一路 | 3 |
| `psd-reads-the-range-before-the-data` | 先问「有哪些频段」再取数：反过来 ⇒ 取到的谱与随后读回的频段表之间隔着一次设置，两者可能描述不同的配置 | 13 |
| `psd-top-level-is-the-first-range` | 顶层那几个向后兼容字段是**第一个**频段的（v1 的调用方读 `data["psd"]`）。换成最后一个 ⇒ 多频段扫里那几个数悄悄换了一条谱 | 3 |
| `psd-ignored-list-is-reported` | 一个解析不了的 `freq_range_indices` 退回单量程是旧仓行为，但它只写进**日志**，而日志不跟着回包走。不报 ⇒ 调用方以为自己扫了三个频段 | 2 |
| `bias-settle-needs-the-starting-point` | 读不到当前偏压就**拒绝**：不知道起点就判不出这次改变会不会穿零 —— 而这个技能的全部价值就是那个判断 | 3 |
| `batch-only-successful-regions-contribute-paths` | 2026-07-27：4 个区域里 3 个被安全闸拒掉，却照样带着 `sxm_path` 进了 `scanned_paths`，下游把它们当成这一批的数据 | 5 |
| `batch-zero-success-is-a-failure` | **一个区域都没扫成是失败**，不是「部分成功」。放行 ⇒ 一次全军覆没在 actions 表里记成 `success = true`（2026-07-27 原样） | 3 |
| `batch-shortfall-reaches-the-summary` | 差额要进 `summary` —— `fail_count` 躺在 `data` 里，而**没有人读 data**（这正是 07-27 那次没人发现的原因） | 4 |
| `batch-timeout-and-stop-are-two-messages` | 超时要去调 timeout，中途停止要去查**是谁停的**。合成一句 ⇒ 把人送去调错东西 | 3 |
| `batch-first-error-wins` | 一个区域只记**第一条**出错原因：后面几步失败是它的后果不是新证据。改成后写覆盖 ⇒ 报文指向 `save` 而根因在 `configure` | 2 |
| `batch-region-steps-are-optional` | 每区的步骤是**可选**的：一个坏区域不该毁掉整晚。改成必需 ⇒ 第一个区域被安全闸拒掉，后面全部不跑 | 3 |
| `batch-assess-step-is-opt-in` | `assess_quality` 缺省 **false** —— 打开它才排 `AssessImageQuality`（那个技能本仓还没移）。恒排 ⇒ 每个区域多一次注定失败的调用，而它是这个技能唯一的未移依赖 | 8 |

---

## 4. 金样怎么来的

### 4.1 `spec/golden/skill_traces.json`（+9 个技能，**+0.75 MB**）

通用驱动器那一份，钉的是「它在注册表里、被真调度链调得动」。九个里有五个真的跟仪器
说话（`MonitorCurrent` / `MonitorCurrentFFT` / `WatchScanLines` / `BiasSettleChange` /
`AcquirePSD`），四个只调子技能。

**它的局限这一批第一次这么刺眼**，逐条：

| 技能 | 通用驱动器录到的是什么 |
|---|---|
| `MonitorCurrentFFT` | 999 个样本**全是 0.25** ⇒ 去趋势之后整条是 0 ⇒ **谱是 500 个零**。窗、`rfft`、单边归一化，一条都没被验到 |
| `ClassifyUnexplainedCurrent` | 卡在「读不到反馈状态」⇒ 判别表**六个结论一个都没走到** |
| `RecoverTipFromSaturation` | 卡在「读不到电流」⇒ 退针阶梯一级都没走 |
| `WaitForThermalSettle` | 连续五次读不到 ⇒ `polyfit` 一次都没跑 |
| `BatchRegionsScan` | `regions` 是 `'spec-export'` ⇒ 连计划都没排出来 |

**那仍然是判据**（外壳在碰任何东西之前先拒），只是主判据在下面那一份。

### 4.2 `spec/golden/batch5b.json`（新，1.4 MB，74 格，**重跑逐字节相同**）

```
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe \
    tools/spec-export/export_batch5b.py
```

**旧仓真实的九个技能真跑一遍**，驱动它们的是一个**脚本化上下文**：每个动词、每个
子技能的回答都由用例自己给（队列取完之后重复最后一个）。四条纪律：

1. **输入与答案一起录**，合成用的是闭式公式或**真机记下来的那几个数**
   （08-27 的降温序列、08-28 的 I(V) 三点）⇒ 重跑逐字节相同（md5 两次一致，已验）；
2. **脚本本身进金样**，TS 那侧拿同一份喂同一个技能 —— 两边不是「各自造一份差不多的
   输入」（批 4a §4 那一课：**两边各自重建同一个输入，本身就是一处没人在看的差异**）；
3. 墙钟与随机数一概不进；时间桩与 `export_skill_traces.py` **同一套**
   （1e6 秒起 / 每读 +1e-3 / `sleep` 往前拨），于是轮询循环的**拍数**与那一份对得上；
4. **时钟派生的字段单独标出来**（每格一个 `clock_keys`），其余一律逐位。

### 4.3 五张「为某一道闸而造」的输入

这一节是这一批真正花时间的地方 —— 第一版里**有四格分辨不出两种候选**，
而它们全都会让一条本该变红的变异变绿。

| 输入 | 为谁造的 | 第一版为什么不行 |
|---|---|---|
| `ramp_with_contact` 的**第 22 点掉回去** | `min_contact_samples` 的「**连续** 3 次」 | 第一版掉在第 24–25 点 —— 那时 20/21/22 已经连满三次，「连续」与「累计」给出**同一个答案** |
| 同一串的**第 5 点是负的** | 统计量算在 `\|I\|` 上（`signed_*` 才报原值） | 全是正数时两组恒等 |
| `two_tone` 的 **137 Hz**（非整周期） | 窗函数那一档 | 只放整周期音的话，加不加窗谱都一样干净 |
| `watch/wide_*` 的 **128 列 / 整行一个周期 / 幅度 2e−9** | 「触顶比例 > 2 %」以外的两条观察 | 见下，这一格挖了三层 |
| `classify/feedback_was_off` + `classify/zero_is_added` | 「还原成**进来时**的样子」与「0 V 自动补上」 | 全用 `fb_on=True` / 全都显式带 0 时，拆掉这两道闸**答案不变** |

#### 「触顶」那一格挖了三层，值得单记

`WatchScanLines` 的三条观察是互斥的（第一条命中就不看后面），而**触顶那一条几乎总是命中**：

| 试过的 | 触顶比例 | 为什么还是高 |
|---|---|---|
| 12 列，`sin(2πc/8)` | 0.25 | 每一行**至少有一个 max 和一个 min 贴着自己**，窄帧上那就是 `2/12 = 0.167 > 0.02` |
| 128 列，`sin(2πc/8)` | 0.25 | 最大值被碰 **16** 次（周期只有 8 列） |
| 128 列，整行一个周期，幅度 2e−11 | 0.203 | `_SATURATION_TOL` 是 **1e−12 绝对**，而峰附近 13 个点都落在 1e−12 以内 |
| 128 列，整行一个周期，幅度 **2e−9** | 0.0156 | 相邻点差 2.4e−12 > 容差 ⇒ 只有真正的那两个极值 |

第四行才是这条观察的**设计工作点**。而挖出来的那件事本身值得写进登记：
**`_SATURATION_TOL` 是绝对的，所以它只在「起伏 ≫ 1 pm」的帧上说得出话** ——
在一张 20 pm 起伏的原子分辨图上，这条「压电到头了」的提醒会**每一帧都出现**。

### 4.4 容差表（**每一条都写在被测件自己的 docstring 里，连同推导**）

测试里**没有一个字面量容差** —— 全部引用被测件导出的那个函数/常量。

| 件 | 容差 | 为什么是这个数 |
|---|---|---|
| 判决 / 文案 / 计数 / 下标 / 区域账 / 掩膜 | **0** | 整数与搬运。给容差等于把一次「挑错了元素」藏起来 |
| `effectiveExponent`（`n = dln\|I\|/dln\|V\|`） | **0** | 旧仓这一段是**纯 Python**（`math.log` + 内置 `sum`），一次对数、两次均值、一次最小二乘斜率，全是闭式；三处求和走 `pySum`（Neumaier，CPython 3.12 的 `sum()`） |
| `npHanning` / `npHamming` | **0** | 一次整数减、一次乘、一次 `cos`、一次乘加。**这个函数的判据本来就不该是容差**：抄错公式（顺序 / 分母 / 端点）会在第 3 位以内露出来，不是第 16 位 |
| `rfftfreq` | **0** | `k / (n·d)`，一次乘一次除。**不是** `k·fs/n`（那是两次乘），而频率刻度错一位等于把峰安在别的频率上 |
| `rateKPerMin`（`polyfit(1)·60`） | `lstsqObservedTol(κ)` | numpy `polyfit` 走 SVD（`κ·eps`），本仓走**列缩放后的正规方程**；两条不同的路，所以不给 0。κ 在 1.x–3 量级，取紧的那一条界 |
| `MonitorCurrentFFT` 的 `spectrum` | `max\|golden\| · 4·fftRelTol(n)`（power 档另加 `CLOCK_REL`） | FFT 的误差本底与**整幅谱的最大值**挂钩，不与某一个 bin 自己挂钩。`4·` 里一个 2 是两条蝶形顺序的余量，另一个 2 是 power 档的平方 |
| 每格 `clock_keys` 列的那几个叶子 | `CLOCK_REL = 1e-6`（相对） | 两侧假钟的量级不同（秒 vs 毫秒），实测最坏 **4.7e−8**（`actual_fs_hz`），占 4.7 % |

实测占比（n = 999，四格）：`hann` **1.6e−3**、`hamming` 2.9e−3、`rect` 1.6e−3、
`no_detrend` 1.1e−3。**这条界比实测松两到三个数量级** —— 按推导写，不按试出来的那个数写
（`numerics-3.md` 第六节）：`fftRelTol` 是这一层已经推过的界，而一条「刚好让我这版通过」
的容差在下一次换 FFT 实现时会当场骗人。

#### ⚠️ 「做得到逐位就不要给容差」在这一批逼出一次**改实现**

`actual_duration_s` 是「最后一次读钟减 `t0`」，而我最初在 `MonitorCurrent` 里**多读了
一次 `now()`**（外层一次、`pollCurrent` 里一次）。后果不是最后一位差 —— 是**整整 1 ms**，
远超那条 1e-6 的容差，金样当场红。

修法不是放松容差，是让 `pollCurrent` 把 `t0` **交出去**。这条值得记下来：
**在一个自己排拍的轮询循环里，「读了几次钟」是可观测的**，
而那正是旧仓 `N+2` 次（起手一次、循环 N 次、收尾一次）那个形状。

---

## 5. 没做完的（逐条）

### 5.1 `RunGridExperiment`（`builtins.pattern` 的第 7 个）—— 卡在 **`_phase_tick` 的墙钟超时**

**不是缺件**：五个动词全在 `methods.ts`（`Pattern_GridSet` 的 9 个实参齐全），
`runPlan(AsyncIterable)` 早就有了，中止路径的两个动词也在 `ABORT_SAFE_WRITES` 里。
盘点（A25）说「多要的唯一一件是动态计划，已有」——**属实**。

卡的是一条**判据**，在 `pattern.py:330-333`（**4 行**）：

```python
start_time = float(self._executor.progress.partial_data.get("start_time", time.time()))
elapsed = time.time() - start_time
if elapsed >= self._timeout_s:
    ...停实验、置 timed_out
```

`time.time()` 是**墙钟**。而 `export_skill_traces.py` 的时间桩把墙钟**钉死成常数**
（`_fake_time` 恒回 `1_700_000_000.0`），于是：

* 金样那一侧 `elapsed` 恒为 0 ⇒ 那条超时判据**永远走不到** ⇒ 录下来的 `ok` 轨迹是
  「1800 拍全跑完、`exp_done` 仍是 false、**报 `success: true`**」；
* 本仓 `SkillContext` 只有**单调钟** `now()`（而它正是真机上这条判据成立的钟：
  `time.sleep(2)` 在真机上真的过去 2 秒）。夹具的 `sleep` 把钟往前拨，于是
  `elapsed` 真的会涨：计划的上限是 `wait_timeout_s / 2 = 1800` 拍，
  每拍 `sleep(2 s)` ⇒ **1800 × 2 s 正好就是那个 3600 s 的超时**，
  再加上每拍几次读钟，那条判据在计划跑完之前就触发 ⇒
  `ok` 那一格的 `success` 与金样**相反**。

而 `traces.test.ts` 的 `success` 一项**没有 deviation 逃逸口**
（`expect(got.success).toBe(want.success === true)` 是写死的）。

三条路，我一条都没走，理由写清：

| 路 | 为什么不走 |
|---|---|
| 用 `Date.now()`（真墙钟） | **那道闸就永远验不到**：要在测试里走到它得真的等 3600 秒，而把 `wait_timeout_s` 调小又会让计划的 tick 上限先触发。「一条编不过/验不到的变异，那道闸就永远验不到」已撞过 18 次 |
| 给 `Deviation` 加一个 `success?: boolean` 逃逸口 | 那是改**共享测试基础设施**，而本轮有另外两条支线在同一个文件上加行 |
| 只落实现、不进 `BATCH_5B` | `progress.json` 会把它记成 `partial`（有实现没轨迹），而「一个半完成的模块在进度表上没有意义」 |

**建议**：主线收 `traces.test.ts` 时把 `success` 那一行也做成可登记的（一行改动 +
一条「两侧都钉住」的反向断言），这个技能就是半天的事 —— 所有别的东西都齐了。
顺带那 4 行墙钟判据也该在登记里写明「真机上它与计划上限几乎同时触发，
而在钉死墙钟的夹具里它是死代码」。

⚠️ 顺带一个数字：把它放进 `BATCH_5B` 试跑过一次 —— `skill_traces.json` 从
1.91 MB 涨到 **3.90 MB**，其中 **1.10 MB** 是它一个（7 条轨迹 × ~1800 个
一模一样的 `Pattern_ExpStatusGet` 记录 + `completed_steps` 里 1803 个 `tick_*`）。
主线接它的时候值得顺手想一下这 1.1 MB 里有多少是判据。

### 5.2 四个分析技能 —— 差的**不是技能本体，是数值原语 + 一台导出器**

四个都**只读文件、一次 Nanonis 调用都不发**，技能层各 100–260 行，
真正的工作量在下面这张表。逐条核过，**与盘点有出入的地方标了 ⚠️**：

| 技能 | 缺的**函数** | 行数 | 已经在仓里的（盘点没说） |
|---|---|---|---|
| `AssessTipSharpness` | `tip_metrics._edge_resolution`(19) + `_fwd_bwd_instability`(46) | **65** | ⚠️ `_detrend` 与 `_fft_sharpness` **批 4b 已落**（`vision/tip-metrics.ts` 的 `detrend32` / `fftSharpness`）；`judge_frame` / `parse_xy_meta` / `read_sxm` / `sxm_oriented_frames` 全已落。盘点（A15）把这四件也算进了成本 |
| `AssessTipFromSpectrum` | `vision/spectroscopy.assess_iv`(76) + `assess_iz`(41) | **117** | `polyfit` / `corrcoef` / `median` / `argsort` / `diff` —— 数值面**零缺口**（盘点说得对：这两个函数里没有一行 scipy） |
| `AssessSpectrum` | `resolve_spectrum_kind`(47) + `assess_spectrum_quality`(240) + `saturation_frac`(39) + `spectrum_snr`(30) + `assess_hysteresis`(44) + 上面那两个(117) + `io/exp_map.extract_dat_position`(27) | **≈544** | 同上，全族零 scipy |
| `InvertForceSaderJarvis` | `invert_force_curve`(88) → `sader_jarvis`(27) + `_decay_length`(12) | **127** | ⚠️ `savgol` **本仓已有**（`numerics/savgol.ts`），所以盘点（A18）那句「savgol 只在可选参数那条路上，落地时要么不声明这个参数、要么明说本仓不提供」**不再成立** —— 现在两条路都走得通 |

**为什么不塞进这一批**：`_edge_resolution` 要 `gaussian_filter(σ=1)` + `np.gradient` +
两个 `percentile`，`_fwd_bwd_instability` 要 `fft2`/`ifft2` 的非归一化互相关 ——
每一件都要**先写下容差再写实现**，而容差要金样里带条件数/最大值；
`assess_spectrum_quality` 那 240 行是一族**判据环**（谱型识别 → 饱和比 → 信噪 → 回滞），
它跟批 4b 的 `atomic_phase` 是同一种「两条判据咬在一起」的东西。

四个合起来 ≈ **850 行密集 numpy + 一台新的 `export_*.py`**，与本批落的九个**没有共用件**。
按「模块级完成」的标准它们是一个独立的批次（而且四个各自是一个单技能模块，
所以可以一个一个来）。

⚠️ **`_edge_resolution` 与 `_fwd_bwd_instability` 该落在 `packages/host/vision/`**
（`tip-metrics.ts` 已经有那个文件的另外两件），而**这一轮有别的支线在动那个包，我没碰**。
`PreScanCheck`（批 4d §5.2）等的也正是 `_fwd_bwd_instability` —— 一次写两个消费方。

### 5.3 其余欠账

| 欠的 | 写在哪 |
|---|---|
| **DoD ⑦ 技能卡片** | 本仓**还没有** `scripts/gen-skill-cards.ts`（PLAN §6.2 列了，从没建过）。批 3g–4d 同样没做，这一批照旧 |
| `spec/golden/README.md` 的「专用驱动器」表没加 `batch5b.json` 那一行 | 那张表同样缺 `paper_data.json` / `lattice.json`（批 4b/4c 也没加）。**三条支线同时在表尾加行会撞**，留给主线一起补 |
| `AcquirePSD` 的 `nanonis_patch` 只用到了一个补丁 | 已核：`methods.ts:588` 的 `SpectrumAnlzr_DataGet` 带 `source: 'patch'`，`["d","d","i","*d"]` 与旧仓一致。**不欠** |
| `RecoverTipFromSaturation` 的 `_LADDER` 走完仍未脱离时**不再加码** | 照移。旧仓的报文已经把下一步说出来了（「先确认 z-retract 方向配置是对的」），没有消费方要求自动加码 |
| `MonitorCurrentFFT` 的 `numpy required` 那一支 | 本仓没有「导不进 numpy」这种状态，那条 `except ImportError` 不移（同 D-PAPER 家族） |

---

## 6. stmsim e2e（6 条，都过）

```
STMSIM_PYTHON=… STMSIM_ROOT=… npx vitest run --project integration
```

九个里**五个有 e2e，四个不该有**：

| 不做的 | 为什么 |
|---|---|
| `ClassifyUnexplainedCurrent` / `RecoverTipFromSaturation` | 两个都会**动针尖与反馈**（关反馈量 I(V)、粗动退 800 步）。整组 `integration` 共用一台模拟器，跑它们会把后面每一条的初始状态改掉；而它们一次裸动词都不发，缝在 `ctx.runSkill` 上（`runsub.test.ts` 单独验） |
| `BatchRegionsScan` | 它排的五个子技能**全部**已由 `scan-composites.test.ts` 对真模拟器验过；再跑一遍只是把同一条链跑两次，代价是改掉共用模拟器的帧几何 |
| `RunGridExperiment` | 没落（§5.1） |

### 6.1 三件单测与金样都照不出来的事

**① `AcquirePSD`：stmsim 上 `SpectrumAnlzr` 模块根本没装，而技能要到第六次调用才说得出来。**

```
SpectrumAnlzr_Run      → NeedModule（**被忽略**）
SpectrumAnlzr_FreqResGet → NeedModule（被忽略）
SpectrumAnlzr_ChGet    → NeedModule（被忽略）⇒ channel_index = -1
SpectrumAnlzr_FreqRangeGet → NeedModule（被忽略）
SpectrumAnlzr_DataGet  → NeedModule ⇒ **这一条才报出来**
```

「模块没装」这条信息在**第一次**调用就有了。照移（D-PSD-2），代价写进登记。
测试因此写成「要么回一条形状完整的谱，**要么失败并点名是哪个动词**」——
而它真正挡的是第三种：`success: true` 配一个空的 `per_range`
（调用方读 `data["psd"]` 得到 `undefined`，而 `success` 说一切正常）。

**② `WatchScanLines`：D-ATOMLINE-1 那个修复在真模拟器上**真的走到了**。**

本机实测 `Scan_BufferGet` → `[2, [0, 14], 256, 256]`，`Signals_NamesGet` 的第 **14** 项
正是 `Z (m)` ⇒ `channel_source` 是「**按信号名 Z 解出**」而不是兜底。
旧仓在这台机器上会落到兜底那一支，而兜底**恰好也给 14** ——
**答案相同、理由不同**，缓冲里出现第三路时两者才分岔。

同时照出批 4c 那条事实的第二次：**模拟器刚起来时帧缓冲是一片零** ⇒
`n_lines_done = 0` ⇒ 走「帧缓冲里一行都还没有」那一支。
这个技能对那种情况**有一句专门的话**（「这不等于『表面是平的』」）,
而那句话正是它与一个只会算统计的实现的全部差别。

**③ `MonitorCurrentFFT`：`actual_fs_hz` 在真链路上量到 49.22 Hz（请求 50 Hz）。**

假 context 的 `sleep` 是零成本，于是金样里 `actual_fs` 与 `poll_hz` 几乎相等；
真链路上每一拍都是一次 TCP 往返，抖动是真的。**那正是这个字段存在的理由** ——
频谱的横轴刻度是 `k/(n·d)`，`d` 来自这个量出来的采样率，而不是请求的那个数。
`MonitorCurrent` 同一趟量到 5.00e-11 A ± 1.05e-13（真隧道电流）。

---

## 7. 我核出来与 `survey-remaining.md` 不一样的地方

| 它说 | 实际 |
|---|---|
| **A26** `scan_watch`：要 `_scan_readout.py` 整个 **143 行** + `atomic_lines:usable_rows` **15 行** | **一行都不用写。** 两件**批 4a 都已经落了**（`l0/analysis-lines.ts` 的 `resolveReadout`/`grabFrame`/`readoutDict`、`vision` 的 `usableRows`），因为 `AssessAtomicLines` 用的是同一份 —— 而旧仓那个文件的抬头写的正是「两个技能各写一份的下场是两边迟早只有一边对」。**这 158 行的成本上一批就付过了** |
| **A15** `tip_sharpness`：`tip_metrics` 三个判据函数（24+46+19）+ `_detrend` 8 | `_fft_sharpness`(24) 与 `_detrend`(8) **批 4b 已落**。真正缺的只有 `_edge_resolution`(19) + `_fwd_bwd_instability`(46) = **65 行**，不是 97 行。`judge_frame` 同理（批 4a 已落） |
| **A18** `force_inversion`：「savgol 只在可选参数那条路上 —— 落地时要么不声明这个参数、要么声明了就明说本仓不提供」 | **那个前提没了**：`numerics/savgol.ts` 已经有 `savgolFilter`（上一轮落的）。这个技能现在两条路都走得通，`smooth_points` 可以照声明移 |
| **A25** `pattern`：「多要的唯一一件是动态计划，`runPlan(AsyncIterable)` 已有」 | 计划那一件**属实**。但盘点数的是**依赖**，没数**判据**：`_phase_tick` 的超时读的是**墙钟**，而本仓只有单调钟 —— 这是 A 档里唯一一个卡在「钟的种类」上的技能。见 §5.1 |
| **A21** `acquire_psd`：「8 个动词齐；`DataGet` 的补丁已带」 | ✔ 两条都属实（`methods.ts:588` 带 `source: 'patch'`）。盘点没说的是**另外四个动词的错一律被忽略**，于是在没装这个模块的机器上（stmsim 就是）技能要到第六次调用才说得出话（D-PSD-2） |
| **A31** `batch_regions_scan`：「5 个子技能全已移；唯一未移的那步默认不进计划且 optional」 | ✔ 逐字核过，完全属实。补一句：`_parse_regions` 与 `ParseRegions`（`builtins.scan_frame`）**边界值一模一样而报错粒度不同**，`label` 的缺省规则也不同 —— 两份并存，合并会让至少三格的答案变掉 |
| **A23** `current_origin`：「五个 `context.run` 全已移且数据键逐字对上」 | ✔ 属实（`zctrl-state.ts:62` 的 `controller_on`、`writes-verified.ts` 的 `z_controller_on`+`verified` 都对得上）。补一句：`is_saturated` 是**三态**的，而它同时被 `saturation_recovery` 与 `current_origin` 用 —— 所以本仓把它放进 kernel 而不是某一个技能文件里 |
| **A22/A24/A27/A30** 这四条「零风险可随时插队」 | ✔ 属实，四个都是半天的量。但 `monitor_current_fft` 的**金样**不是半天的量：通用驱动器给的常数样本让整条谱变成 500 个零，判据要另开一台导出器 |

### 7.3 `numerics` / `vision` 那两条支线要的东西（**我一个字没改那两个包**）

判断标准只有一个：**它有没有第二个消费方？**

| 件 | 现在在哪 | 建议 | 理由 |
|---|---|---|---|
| `npHanning` / `npHamming`（`np.hanning` / `np.hamming`，**对称窗**） | `stm-skills/l0/current-monitor.ts` | **先别搬** | 只有一个消费方。等 `CharacteriseCurrentNoise` 或谱分析那一族真要它们时再搬，那时签名才有第二个人来定 |
| `rfft` / `rfftfreq` | 同上 | **先别搬** | 同上。⚠️ 搬的时候连 `rfftfreq` 那条「`k/(n·d)` 不是 `k·fs/n`」的注释一起搬 |
| `statisticsMedian`（Python `statistics.median`） | `kernel/current-diag.ts` | **可以搬到 `si.ts` 那一族** | 它是 `pyFloatRepr` / `pyStr` / `pySum` 的第八个成员，而且与 `numerics.median`（`percentile(50)`）、`vision.npMedian`（`np.median`）**三者并存**是有意的 —— 三个不同的语义，谁都不能顶谁 |
| `_edge_resolution` / `_fwd_bwd_instability` | **没有** | 落进 `vision/tip-metrics.ts` | 见 §5.2。`PreScanCheck` 与 `AssessTipSharpness` 两个消费方 |

另外：**`numerics.median` 顶不掉 `statisticsMedian`** —— 前者是 `np.percentile(50)`
（D-VISION-2），偶数长度差最后一位，而这一族读的是「三次电流取中位」，
那一位会一路走进「饱和没饱和」的判决里。理由写在 `current-diag.ts` 的那个函数上。

---

## 8. 值得进课时的几件

### ① 「金样缺一格」这次是**提前**发现的，而办法是问一句「拆掉它，答案变吗」

批 4a / 4c 的经验是「变异跑出绿色 ⇒ 金样缺一格」。这一批**在写变异之前**就做了一遍
同样的检查 —— 对着每一道闸问「我有没有一格输入，能让**拆掉它**的那个实现给出不同的答案」，
当场找出**四处**分辨不出两种候选的输入（§4.3 那张表）。

四处的共同形状值得记：**它们都是「两条判据在这组数据上恰好等价」**——
「连续 3 次」与「累计 3 次」在一段没有中断的高电流上等价；
`|I|` 与 `I` 在一串全正的读数上等价；加窗与不加窗在整周期音上等价；
「还原成初态」与「写死 True」在一台本来就开着反馈的机器上等价。

> 变异演练回答的是「这道闸在不在挡」。
> 而在写它之前先问一句「**这组数据分得开吗**」，回答的是同一个问题的上游 ——
> 代价小一个数量级（改几个常数，不是跑一遍全量构建）。

### ② 一个「用哪种钟」的分歧，能让一个零缺件的技能落不了地

`RunGridExperiment` 的依赖表是**全绿**的：动词齐、动态计划有、中止白名单里有。
它卡在 `pattern.py` 里**四行**代码上，而那四行的问题不是「难移植」，是
**旧仓用墙钟、本仓只有单调钟，而金样那台导出器把墙钟钉死了**。

三方各自都对：墙钟对真机（`time.sleep(2)` 真的过去 2 秒）；
钉死墙钟对金样（「重跑逐字节相同」是金样最重要的性质）；
单调钟对本仓（`ctx.now()` 存在的全部理由就是「测试里不能真等 30 分钟」）。
三个对的东西叠起来，结论是**这个技能在当前的验收框架下验不了**。

> 盘点的「缺件表回答的是『移得动吗』，不是『移过来对不对』」（批 4c §10③）
> 在这里又多了一层：**它也回答不了「验得了吗」**。

### ③ 一条绝对阈值卡在物理量上，会让一条提醒在**整整一类图**上恒真

`WatchScanLines` 的 `_SATURATION_TOL = 1e-12`（米）是绝对的。于是：

* 12 列的帧上，每行至少一个 max 一个 min 贴着自己 ⇒ `2/12 = 0.167 > 0.02` ⇒ **恒真**；
* 一张起伏 20 pm 的原子分辨图上，峰顶附近十几个点都落在 1e−12 以内 ⇒ 仍然恒真；
* 要它说得出话，得起伏 ≫ 1 pm **且**列数 ≫ 50。

这与 `_fwd_bwd_instability` 那条 `na < 1e-9`（旧仓 2026-08-10 改成 `1e-30` 的那一条）
是**同一个形状**：一道绝对阈值卡在有量纲的量上，答案就取决于**帧有多少像素、数据用什么单位**。
旧仓那次的现场原话是「一道绝对阈值卡在物理量上就是个 bug」，而这一条**还在**。

照移了（它是一条提醒不是判定，而且没有消费方在读它），但要写下来：
**这条提醒在窄帧上恒真，也就是说它在窄帧上不携带信息。**

---

## 9. 给合并方的提醒

- **只动了锚点**：`l0/index.ts` 三处 `批 5b`、`gen-skill-specs.ts` 的 `BATCH_5B`、
  `export_skill_traces.py` 的 `BATCH_5B`、`kernel/src/index.ts` 的 `批 5b`、
  `mutations.ts` 的 `批 5b`、`spec/deviations.md` 的 `批 5b` 注释锚点。
  **`3g`–`4d` 与 `5a`/`5c` 一个字没碰。**
- **锚点之外动过的共享文件**（只有一处，与批 4a/4c 同一个）：
  - `packages/host/stm-skills/src/l0/traces.test.ts` —— 两处**追加**：
    ① `DEVIATIONS` 表末尾加 2 条（`WatchScanLines/empty@0` 的 D-SKILL-2、
    两个轮询技能的 `clockApprox`）；
    ② `CLOCK_KEYS` 末尾加 4 个叶子（`contact_at_s` / `nyquist_hz` / `df_hz` / `freqs_hz`）。
    ⚠️ `CLOCK_KEYS` 是**按名字**的全局集合，但它**只在登记了 `clockApprox` 的那几格上
    起作用** —— 所以加名字不会放松任何别的技能（`AcquirePSD` 的 `df_hz` 来自仪器，照旧逐位比）。
  - `tsconfig.json` / `vitest.config.ts` / `pnpm-lock.yaml` / `package.json` **全部原样**
    （这一批没有新包）。
- **一处名字冲突已改**：`bias_settle.py` 的 `DEFAULT_SLEW_V_PER_S` 与 `bias_ramp.py`
  的**同名同值**，而本仓 kernel 的导出是平的 ⇒ 改名 `SETTLE_DEFAULT_SLEW_V_PER_S`，
  理由写在常量上（两个数各归各的文件，哪天其中一个改了另一个不跟着动）。
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑；
  合并后请**统一再跑一次**：
  ```
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  node scripts/gen-skill-specs.ts
  node scripts/build-progress.ts
  ```
- `spec/golden/batch5b.json` 与 `tools/spec-export/export_batch5b.py` 是本支线独有的
  新文件，不会冲突。**重跑逐字节相同**（md5 两次一致，已验）。
- **`packages/host/vision/` 与 `packages/host/numerics/` 一个字节都没动。**
- ⚠️ **一条与本批无关、但合并方会撞到的观察**：`--coverage` 打开之后
  `l0/lattice-skills.test.ts` 的
  「AssessAtomicResolution：成像条件闸门产出 `undetermined`」那一条要跑 **6.35 s**，
  超过 vitest 默认的 5 s ⇒ 整趟覆盖率报红。不带 `--coverage` 时它 **1.3 s** 就过。
  本批一个字没碰那个文件（批 4b 的），但 `pnpm test:coverage` 现在**需要**
  `--testTimeout=60000` 才跑得完。要么给那一条挂一个显式 timeout，
  要么把 `vitest.config.ts` 的覆盖率那一档调高 —— 两样都不该由本支线单方面改。
