# 批 7b-2 交接 —— 势垒链与线缆（8 个技能 / **7 个**模块收口）

落了 **8 个技能**、收口 **7 个模块**，外加一件数值原语（`phase_shift`）与一台专用导出器。

技能 **424 → 432**（分母 515），模块 **98 → 105**（分母 165），**0 partial**。

| 组 | 技能 | 模块 |
|---|---|---|
| 势垒链 | `MeasureBarrierHeight` · `MapBarrierHeight` · `CleanTipUntilBarrier` | `builtins.barrier_height` ✅ · `barrier_map` ✅ · `clean_tip` ✅（各 1/1） |
| 线缆 | `AcquireBiasSeries` · `CalibrateCoarseStep` · `AcquireDeltaFCurve` | `builtins.bias_series` ✅ · `coarse_step_calib` ✅ · `deltaf_curve` ✅（各 1/1） |
| 网格谱学 | `RunGridExperiment` | `builtins.pattern` ✅ **7/7**（前六个批 3 已落） |
| 光学取点 | `AcquireSignalPoint` | `builtins.optics_scan` ◐ **1/2 —— 永远到不了 complete** |

---

## 0. 一句话

> 任务书说这一批「零数值缺口零 vision 依赖，唯一要拼的是 `phase_shift` 那 15 行」——
> **两句都对，而它们说的不是这一批的成本。**
>
> 真正的活在三处：① 那 15 行**能不能和旧仓比**取决于一个与它无关的东西
> （合成帧的谱里有没有数值为零的格，§3）；② 两个技能的主路**在两仓都是死的**，
> 而「把死的东西如实录下来」比把它做活要多写一半（§4）；
> ③ 两处求和分岔（CPython 的 `sum` 与 numpy 的 `mean`）各让一族数字差最后一位，
> 而两处**都不是我推出来的，是金样红出来的**（§5）。

---

## 1. 落地的件

```
新增（数值原语 —— 对的是 numpy 与旧仓那 15 行）
  packages/host/numerics/src/phase-shift.ts                 190  phaseShift + phaseShiftSnrRelTol

新增（技能）
  packages/host/stm-skills/src/l0/optics-acquire.ts         192  AcquireSignalPoint
                                                                 + parseIndices/nanonisScalar/meanStd
  packages/host/stm-skills/src/l0/deltaf-curve.ts           337  AcquireDeltaFCurve
  packages/host/stm-skills/src/composite/barrier.ts         770  MeasureBarrierHeight
                                                                 + MapBarrierHeight
                                                                 + CleanTipUntilBarrier
  packages/host/stm-skills/src/composite/bias-series.ts     265  AcquireBiasSeries
  packages/host/stm-skills/src/composite/coarse-step-calib.ts 302  CalibrateCoarseStep
  packages/host/stm-skills/src/composite/pattern-grid.ts    292  RunGridExperiment
                                                      合计 2158

新增（测试与金样）
  packages/host/numerics/src/batch7b2.test.ts                89（ 14 条）
  packages/host/stm-skills/src/l0/batch7b2-skills.test.ts   707（186 条）
  packages/host/stm-skills/integration/barrier-cable.test.ts 222（  6 条，对真 stmsim）
  tools/spec-export/export_batch7b2.py                     1104
  spec/golden/batch7b2.json                          817 393 B / 10 节（重跑逐字节相同）
  spec/golden/skill_traces.json                      +201 271 B（八个技能 65 条轨迹）
```

测试：`--project '!integration'` **6946 → 7211**（114 → 116 个文件）；
集成 **+6 条 / +1 个文件**（合计 19 / 104）。变异 **712 → 813**（+101，全红）。

**一件都没进 `kernel`**（`pySum` / `pyFixed` / `reshapeSpectrum` 本来就在那儿）。

---

## 2. 任务书点的四个坑，逐个复核 + 怎么处理的

### 坑 ①：`AcquireSignalPoint` 不是 D 档 —— **核对为真**

逐行核过（登记为 D-OPTICS-1）：

| 核的是 | 结果 |
|---|---|
| `optics_scan.py:100-132`（`execute` 全文） | **一次 `get_instrument_registry` 都没有**。对照同文件 `OpticalStageScan.execute:303` —— 它在 `:314` 就取 |
| 可达调用面 | 三个函数全在 `optics_acquire.py`：`parse_indices`(`:37-48`) · `PointAcquirer.__init__`(`:148-165`) · `acquire`(`:208-254`)；`acquire` 往下只调同文件两个纯函数 |
| 模块抬头 | `optics_acquire.py:10-11` 逐字：「**Nothing here touches the instruments registry**」 |
| 唯一指向驱动层的 | 异常类 `InstrumentError`（`instruments/base.py:44-45`，两行、无行为）—— **不搬**，理由见下 |

**处理**：落成 A 档。`InstrumentError` 这个类不搬 —— 它在旧仓的全部作用是让
`optics_scan.py:117` 的 `except` 接得住 `acquire` 抛的那几句话，而本仓 `safeCall`
永不抛；「抛一个名字来自驱动层的异常再自己接住」那一圈没有消费方（消融精神）。
措辞逐字照抄。

⚠️ **这一批收口 7 个模块，不是 8 个**：`builtins.optics_scan` 的另一半
`OpticalStageScan` 是真 D 档，这个模块永远到不了 complete。`spec/progress.json`
里它是 `1/2`，`modules_complete` 不因它 +1。

### 坑 ②：`ScanAt` 从不返回 `scan_path` —— **核对为真，两仓都是**

逐键比过（登记为 **D-SCANPATH-1**）：

| | 写了哪些键 |
|---|---|
| 旧仓 `scan_at.py:368-389` | `wait_timed_out` · `wait_stopped_early` · `scan_lines_done` · `scan_lines_total` · `budget_s` · `elapsed_s` · `extensions` · `lines_done` · `lines_total` · `pixels` · `lines` · `resolution_verified` · `angle_deg` · `linear_speed_m_s` |
| 旧仓 `aggregate`(`:392-396`) | 上面那些 + `_resolved_snapshot`（解析出来的**扫描参数**，不含路径） |
| 本仓 `scan-at.ts:183-198` + `:211-228` | **一模一样**，外加 `_progress` / `abort_facts` |

**处理**（照任务书：登记 + 一条量着它的测试，不假装它活着）：

1. **照移**这条路，**不补那个键**（独立决定，不在这一批）；
2. **登记** D-SCANPATH-1；
3. **量它的测试**在 `l0/batch7b2-skills.test.ts` 的
   「`ScanAt` 从不返回路径（两段死代码的唯一证人）」三条 ——
   第一条直接跑真的 `ScanAt` 并断言 `scan_path` / `path` / `file` 三个键都不在，
   另两条断言后果（`drift_check` 恒 `null` 且一次 `AssessFrameTrust` 都不调；
   `CalibrateCoarseStep` 恒在「基准帧扫描失败」返回且一次 `MotorMove(x+)` 都不发）。
   **`ScanAt` 哪天补上了，它当场变红。**
4. 金样里 `series/dead_path` 与 `coarse/dead_path` 录的就是今天的行为；
   循环内部那几支由 TS 侧一份**名字带 `hypothetical`** 的脚本驱动，
   期望值从 `phase_shift` 那一节算出来（§4）。

### 坑 ③：`RunGridExperiment` 的两件事 —— **一件是假的，一件是真的**

**`decode_reply` 是不可达 import：核对为真**，而且它对移植**没有影响** ——
`RunGridExperiment` 在本仓根本不引它（那是同文件另外 6 个已落技能用的）。
按「不看 import 行下结论」，这一条在本仓自动消失，不需要登记。

**墙钟那一条是真的，而且批 5b 因此整个搁置了这个技能。** 我没有走它列出的三条路
（改钟 / 给 `Deviation` 加 `success` 逃逸口 / 只落实现不进 `BATCH`），
走的是第四条：**让两个钟给出同一个答案**（登记为 **D-GRID-1**）。

| 哪一份金样 | 怎么做 | 它验的是什么 |
|---|---|---|
| `skill_traces.json`（通用驱动器，墙钟钉死） | `PARAM_OVERRIDES` 给 `wait_timeout_s = 11.0` ⇒ `max_ticks = ⌊11/2⌋ = 5`，五拍睡满 **10 s < 11 s** ⇒ **两侧都是「计划跑完、没超时」** | 动词序列、`Pattern_GridSet` 的九个实参、`_progress` 台账 |
| `batch7b2.json`（本批专用驱动器，**假钟会走**） | 把 `time.time` 也接到那个会前进的假钟上 ⇒ 旧仓的 `elapsed` 真的涨 ⇒ **超时那一支真的被录到**（`grid/timeout`，第 5 拍触发） | 超时、提前完成、中止、三处下发失败、Stop→Pause 兜底 |

`⌊T/2⌋·2 < T` 这条算术**是**通用金样那一格的判据：它保证「计划的拍数上限先到」
在两个钟上**同时**成立，而不是碰巧成立。取 T = 11 而不是缺省 3600，
顺带把那一格从 1800 拍缩到 5 拍（批 5b 实测 3600 那一档一个技能就让
`skill_traces.json` 涨 1.10 MB；这次只涨了 0.20 MB，含全部八个技能）。

**`traces.test.ts` 的 `success` 一行没有动。** 动的是两处：
`VOLATILE` 加了 `start_time`（它是一个**时刻**，两侧的钟连原点都不同 ——
值没有判据可言，而形状由 `batch7b2-skills.test.ts` 单独钉），
以及 `reshapeReason` 多认一个键名 `parse_error`（见 §7）。

### 坑 ④：`monitoring/store.py:2066 get_store()` —— **与这一批无关，逐条核过**

`grep "store is None"` 在 `skills/builtins/` 里五处，分别在
`characterise_noise.py:395` · `hardware_events.py:115` · `history_query.py:170/213` ·
`quiet_drift.py:185` —— **一处都不在这一批的九个文件里**。
把这一批的九个源文件（`barrier_height` / `barrier_map` / `clean_tip` / `bias_series` /
`coarse_step_calib` / `deltaf_curve` / `pattern` / `optics_scan` / `optics_acquire`）
`grep -l "monitoring\|get_store"` ⇒ **零命中**。

⇒ 这一条是 C 档（`characterise_noise` / `hardware_events`）的事，本批不处理、不登记。
写在这里只是为了让「核过了」这件事留下痕迹。

---

## 3. `phase_shift` 那 15 行：**它能不能比，取决于一件与它无关的事**

任务书说「四个原语全在」——`fft2`/`ifft2`/`hanning`/`median` 确实全在，
15 行也确实只有 15 行。而这一节花掉的时间不在那 15 行上。

### ⚠️ 归一化把「没有定义的量」放了出来

`phase_shift` 把互功率谱归一化成单位相位（`R /= max(|R|, 1e-30)`）。
我第一版的合成帧是**三个解析高斯求和**——那是一个光滑场，它的谱里有一批
**数值上为零**的格（实测 `max|R| / min|R| = 6.4e15`）。归一化把那些格的**相位**
整个放出来，而那些格的相位**不是数据决定的，是舍入决定的**：
pocketfft 与本仓的 FFT 在那里给出完全不同的角度。

后果：`snr` 两侧差 **2e−10 相对**，而我推得出来的界是 **1.4e−13**。

**这个差推不出界。** 我试着推了一条（把每一格的相位误差按 `‖F‖/|F_k|` 放大再求方根），
得到的界比实测大 **10 个数量级** —— 一条大 10 个数量级的界不是容差，是放弃。
真正的原因是：那个量取决于**输入谱的动态范围**，不取决于 N。

### 做法：给合成帧加一层 2% 的**非周期**宽带噪声

`max|R|/min|R|` 从 `6.4e15` 降到 `2.2e7`，那几格不再是数值零，相位由数据决定
⇒ 两侧的差回到 `phaseShiftSnrRelTol` 之内（**实测占比 0.30**，最大那一格）。

**为什么必须非周期**：第一版用的是 `(31r + 17c) mod 13`，它在列上周期 13。
归一化之后高频格由这层噪声主导，而周期噪声在格点偏移上自相关很强 ——
**相关峰整个挪了位**（`dx` 从 −5 变成 −1）。那不是精度问题，是答案变了。
换成非周期哈希之后位移回到 −5。

> 同批 7a-3「台阶是一像素锐变」那一条的另一面：
> **合成选择要交代，而理由是「让被测的那个量在这一格上是有定义的」。**
> 真机的帧本来就带噪声；一个由三个解析高斯求和而成的帧才是那个**退化**的输入。

### 两条与既有件的分界，写进源码抬头

`phaseCrossCorrelation`（`fft.ts:492`）**不能顶**，两条（登记为 D-PHASESHIFT-1）：
① 它给亚像素位移 + `error` + `phase`，**不给锐度**，而 `_MIN_CORR_SNR = 12.0`
是这个技能唯一的自证判据；② 归一化分母不同（skimage 的 `100·eps` vs 旧仓的
`1e-30`，差 16 个数量级）。

---

## 4. 两段死代码：怎么在「不假装它活着」的前提下还给它判据

`AcquireBiasSeries` 的 `AssessFrameTrust` 与 `CalibrateCoarseStep` 的整条标定循环
都挂在 `ScanAt` 的路径键上（坑 ②）。做法分三层，**每一层的身份都写在名字里**：

| 层 | 在哪 | 名字 | 它说的是 |
|---|---|---|---|
| 今天的行为 | `batch7b2.json` | `series/dead_path` · `coarse/dead_path` | 这条路走不到，而走不到的样子是这样 |
| 量着它 | `batch7b2-skills.test.ts` | 「`ScanAt` 从不返回路径」三条 | 补上的那天这里先红 |
| 那条路真被补上之后 | `batch7b2-skills.test.ts` | `hypothetical` 一节（7 条） | 循环里的判据是对的 |

`hypothetical` 那一节的期望值**没有一个是手抄的**：帧与位移来自
`batch7b2.json` 的 `phase_shift` 一节（同一对帧，写成 `.sxm` 字节喂进 `loadSxm`
→ `planeSubtractRobust` → `phaseShift` 这条真链路），`nm_per_step = dx_nm / n`
是它上面的算术。线性／非线性两侧各一格。

**`CalibrateCoarseStep` 的标定循环因此没有整技能金样，而那不是遗漏** ——
理由写在 `export_batch7b2.py` 的抬头与 `spec/golden/README.md` 里。

---

## 5. 两处求和分岔 —— **都是金样红出来的，不是我推出来的**

| 哪一处 | 旧仓写的 | 该对哪一个 | 不对会怎样 |
|---|---|---|---|
| `optics_acquire.mean_std` | **内建 `sum()`** | `kernel/si.ts` 的 `pySum`（Neumaier 补偿）—— CPython **3.12 起**内建 `sum` 对浮点走补偿求和 | `[0.2,0.4,0.6]` 的均值差一位（`0.4000000000000001` vs `0.39999999999999997`），一路进 `sig14_mean` 与摘要里的 `%.4g` |
| `phase_shift` 的 `np.nanmean` | **numpy**（成对求和） | `numerics/pairwise.ts` 的 `npSum` | `snr` 差 **1e−10 相对**，而那个差**看起来像 FFT 的锅** |

⇒ 「一个仓里只能有一个 `sum`」（`stats.ts` 抬头）说的是
**一个调用点只能对一个 `sum`** —— 两族不能混。这一批把 `barrier.ts` 里
`np.mean`/`np.std` 的四处也一并接到 `npMean`/`npStd` 上。

登记为 D-POINT-2?。

---

## 6. 金样怎么来的（`spec/golden/batch7b2.json`，10 节，重跑逐字节相同）

`skills`（**104 格**）· `fit_kappa`（8）· `barrier_verdict`（8）· `rel_spread`（8）·
`verdict_from`（9）· `setpoints_for`（5）· `parse_indices`（9）· `mean_std`（4）·
`phase_shift`（**12**）· `validate`（2 个技能 / 11 格）。

* **脚本化上下文**（同 `export_batch5b.py`）：每个动词、每个子技能的回答由用例自己给；
* **闭式合成**：`I(d) = I₀·exp(−2κd)`，κ = 5.123·√φ —— **那是被测代码的逆运算**，
  于是「拟合对不对」在金样里可以独立验算（期望的 φ 就是输入的 φ，实测回到 4.0 的
  第 15 位）；
* **`allow_nan=False` 装不下的输入走记号**：`{"__nan__": true}` / `{"__inf__": ±1}`，
  两侧照同一张表还原 —— `arr[np.isfinite(arr)]` 是一道真的闸，不能因为 JSON 装不下就跳过；
* **墙钟会走**（只有这一台，见坑 ③）。

### 几格**专门为一道闸造的**输入

| 格 | 它分得开什么 |
|---|---|
| `barrier/direction_exactly_085` / `_120` | 两条边界是**严格**不等号 —— 正好落在线上走的是灰带那一支 |
| `barrier/zero_base_current` | `base <= 0` 与 `base is None` 走同一句话，两种候选只有这一格分得开 |
| `barrier/too_few_usable`（**显式**噪声底 100 pA） | ⭐ 自动底是「最远两档均值×2」，对一条纯指数它**恒**好剩下 4 个点 —— φ=9 的极陡衰减（`barrier/steep_decay`）也是 4。「可用点 < 3」这道闸只有显式底够得着 |
| `barrier/integration_floor`（`points_per_step = 2000`） | `max(0.002, …)` 那道下限的**唯一**入口：`3.0/npts*0.6 < 0.002` 要 `npts > 900`，而声明上限是 101（`execute` 不校验） |
| `barrier/nonfinite_filtered` / `all_nonfinite` | `arr[isfinite]` 那一道；后者钉住「滤完是空」≠「读到 0」 |
| `map/repeat_spread_zero`（四次一模一样） | `repeat_spread <= 0` 与 `repeat_spread is None` 是两条路，各要一格 |
| `map/median_even` | `statistics.median` 偶数个取中间两个的**平均** |
| `clean/improve_exactly_15pct` | 改善门槛是**严格**大于 —— 正好 15% 不算改善 |
| `clean/worse_from_baseline_does_not_stop` | `best_at == "baseline"` 时**不**走「变差立刻停」（照移） |
| `clean/phi_none_is_not_no_improvement` | ⭐「没测到」≠「没变好」：不计 stale、不算变差 |
| `series/ref_picks_first_of_tie`（2 与 −2 同模） | `max(key=abs)` 并列时取**第一个** |
| `series/all_frames_failed`（错误 **248 字**） | `[:200]` 那道截断只有在原话更长时才做决定 |
| `coarse/locked_busy_uppercase` / `locked_chinese` | 锁检查是两个子串（中文「占用」／英文 `busy` 走 `.lower()`），两格**互不重叠** —— 重叠的话拆掉任一半还有另一半接着 |
| `deltaf/bwd_column_skipped` | 回程那一列整列跳过；不跳 `df_min_hz` 会取到两条里的最小值 |
| `deltaf/amplitude_needs_osc_hint`（一个裸 `Amplitude (V)`） | 振幅那一路要**同时**像振幅、又像振荡控制器 |
| `deltaf/semicolon_is_a_separator` | 与 `ConfigureSTSChannels` 的解析器**刻意不同**（D-CHANNELS-1） |
| `grid/timeout`（`wait_timeout_s = 10`） | ⭐ 超时那一支 —— **只有在墙钟会走的时候才存在** |
| `grid/aborted_mid`（阈值 3.0 s） | 落在第 1 拍（2 s）与第 2 拍（4 s）**之间** ⇒ 两侧一定在同一拍看见，与读钟次数无关 |
| `point/nested_first_wins`（`[[9e-10], 1e-10]`） | `nanonis_scalar` 的**先序**遍历；只有一层嵌套那一格上先序与后序同解 |
| `phase_shift/uncorrelated_low_snr` | 低 SNR 要**真的换掉特征**：相位相关对同一幅图的平移永远给尖峰，哪怕幅度只有 1 pm |
| `phase_shift/identity` | `max(median, 1e-12)` 那道下限的唯一入口（两帧全等时中位是 1e−17 量级的浮点噪声） |

---

## 7. 变异演练（**101 条，全部实跑到 red**；⚠️ **基线干净**）

```
node node_modules/typescript/lib/tsc.js -b
node scripts/gen-skill-specs.ts && node scripts/build-progress.ts   # 先重跑生成物
node tools/mutate/run.ts <101 个 id>   # 清单 = mutations.ts 里「批 7b-2」锚点下那 101 条
                                      # （`git diff tools/mutate/mutations.ts | grep "^+    id: '"`）
… 基线（2 个 scope）          ← 没有「✗ 基线不干净」
101/101 变红
```

日志：`docs/handoff/drill-7b-2-2026-09-20.log`（**最终树上的那一趟**，不是第一趟）。
两个 scope：`packages/host/numerics`（9 条）· `packages/host/stm-skills`（92 条）。
全仓 `--project '!integration'`：**116 文件 / 7211 条**全绿（这一批之前 6946）。

| 组 | 条数 | 变红条数区间 |
|---|---:|---|
| `phase_shift` | 9 | 1 – 10 |
| `AcquireSignalPoint` | 7 | 1 – 5 |
| `AcquireDeltaFCurve` | 12 | 1 – 22 |
| 势垒链（`MeasureBarrierHeight` / `MapBarrierHeight` / `CleanTipUntilBarrier`） | 39 | 1 – 28 |
| `AcquireBiasSeries` | 11 | 1 – 21 |
| `CalibrateCoarseStep` | 14 | 1 – 2 |
| `RunGridExperiment` | 10 | 1 – 15 |
| **合计** | **101** | |

### 7.1 第一趟 14 条没红，逐条 —— **这一节比上面那张表值钱**

第一趟 **87/101**：8 条 `inconclusive`（构建失败）+ 6 条 `green`。
八条构建失败是**我的锅**（变异让一个变量变成未用，`tsc` 退非零），一条条改打法即可；
**六条绿里有四条查出了金样自己的缺陷** ——

| # | id | 第一趟为什么不红 | 改了什么 |
|---|---|---|---|
| ① | `barrier-clean-line-is-three-ev` | ⭐ **金样里根本没有 φ=3.0 那一格。** 导出器用 `f"{phi:g}"` 当键，而 `g` 只给 6 位有效数字 ⇒ `2.999999 → "3"`、`0.999999 → "1"` —— 两条**闭区间边界**各与它们要区分的那一格撞成同一个键，后写的把先写的覆盖掉 | 键换成显式名字（`exactly_3eV_is_clean` / `just_below_3eV` …），八格回来了 |
| ② | `barriermap-surface-side-line-is-three` | ⭐ **`0.3 / 0.1 = 2.9999999999999996`** —— 「正好 3」那一格根本不在 3 上，`>= 3` 与 `> 3` 同解 | 换成 `0.75 / 0.25`（两个精确的二进制分数，商恰好 3）。`ratio_exactly_2` 的 `0.2 / 0.1` 本来就精确，不动 |
| ③ | `point-summary-prints-four-significant-figures` | 四个读数 1.0/1.2/0.9/1.1 ⇒ 均值 `1.05e-10`，`%.4g` 与 `%.3g` **印出同一个串** | 换成取满有效位的四个数 ⇒ `1.083e-10` vs `1.08e-10` |
| ④ | `deltaf-dat-must-be-newer-than-the-watermark` | ⭐ **这道闸在一个静止的目录上恒为假。** 水位线取「采集**之前**最新的那个 `.dat`」，归属取「采集**之后**最新的那个」—— 同一个目录里后者永远不可能更旧。第一版那一格被**名字**那道闸先接走了 | 摆出唯一够得着它的那一幕：**两次 `Util_SessionPathGet` 看到的不是同一个目录**（操作员中途换了 session 目录）。另补一条 ③′ 说明为什么必须换目录 |
| ⑤ | `phaseshift-fftshift-rolls-forward` | ⭐ **`fftshift` 的方向在偶数边长上给同一个答案**（`+n/2 ≡ −n/2 mod n`），而金样里的帧全是 2 的幂 | 加一格 **17×17**（走 Bluestein，不是朴素 DFT，精度仍是 `O(eps·log N)`） |
| ⑥ | `cleantip-unmeasured-is-not-unimproved` | 我**打错了行**：在 `continue` 之前加 `stale += 1`，而 `continue` 把读 `stale` 的那几行整个跳过了 ⇒ 输出一个字没变 | 改成把「计 stale 之后**真的去判**」整段写进 replace |
| ⑦ | `phaseshift-mean-is-numpy-pairwise`（**第二趟才红**） | 加了那层宽带噪声之后，顺序累加与成对求和在这些帧上的差掉到容差以下 —— **这道闸在 §3 之后失去了输入** | 加一格 `dc_offset_swamps_the_corrugation`（直流 1e4、起伏 1）：那是唯一能分开两种求和的输入，也是 `.sxm` 里 Z 的真实形状 |

> ⑤ 与 ⑦ 是同一件事的两面：**一次为了让 A 能比而改的输入，会让 B 失去输入。**
> §3 那层噪声是为了让 `snr` 与旧仓可比才加的，而它顺手把 ⑦ 那道闸喂饱的那点误差抹平了。
> 只有**真跑**才看得见 —— 预检查不出来（变异唯一命中、编得过、scope 覆盖，三条全过）。

### 7.2 没有写变异的那几道闸（**它们没有输入，写下来而不是假装验过**）

| 闸 | 为什么没有输入 |
|---|---|
| `AcquireSignalPoint` 的 `if (k !== 0 && intervalS > 0)`（第 0 次不等） | `sleep` 不进 `calls`，金样与夹具都看不见它。拆掉它只多一次假钟前进，回包一个字不变 |
| `nanonisScalar` 的 `typeof item === 'boolean'` 跳过 | 金样的 body 里没有布尔（Nanonis 的线格式里 0/1 就是整数）。Python 那一行存在是因为 `isinstance(True, int)` 为真 —— **本仓 `typeof true !== 'number'`，这一行其实是冗余的**，照移并写在这里 |
| `RunGridExperiment` 的 `Math.max(1, …)`（拍数下限） | `wait_timeout_s` 的声明下限是 10 ⇒ `⌊10/2⌋ = 5 ≥ 1`，那道下限够不着 |
| `attachDat` 的「一个都没找到」与 120 s 年龄上限 | **有**输入（`.dat` 那一节的 ④ ⑤ 两条），只是它们由单测而不是金样喂 —— 理由见 §8 与文件抬头 |

同批 7a-3 §5.2：**照移、保留、没有为它编金样（编不出来），并在源码／这里写明。**

---

## 8. stmsim e2e（6 条，都过）

`packages/host/stm-skills/integration/barrier-cable.test.ts`。
八个技能里四个有 e2e，四个没有，理由逐条写在那个文件的抬头。值得单独说的两条：

* ⭐ **`AcquireSTS` 在真机上真的给出 `Current (A)` 这个键。** 整条势垒链压在这一个
  键名上：它不在，`_read_at` 就恒回 `null`，整个技能**安静地**退化成 `undetermined`
  —— 而单测与金样里那个键是我摆的。
* ⭐ **`MeasureBarrierHeight` 整条链在真仪器上跑得完**，给的是一个判读而不是「判不了」。
  第一版**红了**，而红得很有用：我把 `offsets_nm` 收成四档，而自动噪声底
  「最远两档均值×2」**总是**吃掉最后两档 ⇒ 只剩 2 个可用点，拟合要 3 个。
  真机的数据本身很干净（I(0)=80 pA → I(0.3)=0.088 pA，一条漂亮的指数）。
  **缺省那六档前密后疏，正是为这件事设计的** —— 改用缺省之后一次过。

两条「有意做不到」的：

* **模拟器没有 PLL 模块**（globalSetup 跑的是 `polar-spm`，PLL 要 `polar-spm-qplus`；
  换 profile 是改整组集成测试共用的那一份，不在这一批动）。于是
  `AcquireDeltaFCurve` 在真仪器上走到的是**第一道闸**（「读不到 PLL 输出状态」＋
  真文案里那个 `NeedModule` 子串，同 `lockin.test.ts`），而且**一条 `ZSpectr_*` 都不发**。
  ZSpectr 那一串的编码由第二条单独打出去（`ChsSet` 收**一个列表实参**、
  `PropsSet` 收六个），并把**真回包**喂给真的 `parseDeltaF` —— 回程那一列在真回包里
  确实存在，而 `freq_shift_hz` 取的是正程那一条。
* **模拟器没有 Pattern 模块**（`stmsim/` 里 `Pattern_` 零命中）。所以
  `RunGridExperiment` 那一条验的是**编码**（九个混合类型的实参真的打得出去、
  第 4 个实参是 0）与**失败被如实报成失败**（`Pattern_GridSet failed`，
  而且失败之后不许继续 `Pattern_ExpStart`），不是那条状态判据。

跑法：
```
STMSIM_PYTHON=<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe
STMSIM_ROOT=<STMSIM_ROOT>
node node_modules/vitest/vitest.mjs run --project integration \
     packages/host/stm-skills/integration/barrier-cable.test.ts
```
**本机实跑过，6/6 绿。**

---

## 9. 偏差登记（7 条，编号留 `?`）

| 编号 | 一句话 |
|---|---|
| **D-SCANPATH-1** | `ScanAt` 从不返回路径 ⇒ 两段死代码，新旧两仓都是。照移 + 登记 + 一条量着它的测试 |
| **D-COARSE-1** | `phase_shift` 回 `None` 时旧仓 `None / n` 抛 `TypeError` 穿出 `execute`（DoD ⑤：**不照抄**）。本仓给一句拒绝；「扫出来了但读不动」与「扫描失败」分成两句 |
| **D-POINT-1** | `no numeric value in Nanonis reply:` 后面印 body 不印信封（D-SKILL-2 的又一处）；`InstrumentError` 这个类不搬 |
| **D-POINT-2?** | `mean_std` 走 CPython 的 `sum()`（Neumaier），`phase_shift` 走 numpy 的成对 —— 两族不能混 |
| **D-GRID-1** | 超时判据在通用轨迹金样里是死代码；输入在 `batch7b2.json`，而两侧的符号由**睡掉的秒数**保证 |
| **D-OPTICS-1** | `AcquireSignalPoint` 不是 D 档；但 `builtins.optics_scan` 永远到不了 complete |
| **D-PHASESHIFT-1** | 归一化分母 `1e-30`（旧仓）而不是 `100·eps`（skimage）；合成帧那层宽带噪声是 `snr` 能不能比的前提 |

---

## 10. 与任务书不一样的地方

| # | 任务书 | 实际 | 依据 |
|---|---|---|---|
| 1 | 「约 1396 行」 | 技能层实际 **2154 行**（含抬头与推导注释）。按旧仓 Python 行算的**判据密度**对得上；多出来的是抬头 —— 这一批有 7 条要写清楚的形状 | §1 |
| 2 | 「唯一要拼的是 `phase_shift` 那 15 行，四个原语全在」 | 两句都对，**而这一节的成本不在那 15 行上**：它能不能和旧仓比，取决于合成帧的谱里有没有数值为零的格 | §3 |
| 3 | 「`RunGridExperiment` …… `traces.test.ts` 的 `success` 没有 deviation 逃逸口。这一条你要先想清楚怎么收」 | **没有给 `success` 开逃逸口**，改成让两个钟给出同一个答案（一条算术 + 一台会走钟的导出器） | 坑 ③ |
| 4 | 「`pattern.py:34` 的 `decode_reply` 对它是不可达 import」 | 核对为真，**而它对移植没有影响**（本仓根本不引它）⇒ 不登记 | 坑 ③ |
| 5 | 「`monitoring/store.py:2066` …… 两处 `if store is None` 是死分支」 | 核对为真，**而五处调用点一处都不在这一批** ⇒ 不处理、不登记 | 坑 ④ |
| 6 | 「共享文件只许写在 `批 7b-2` 锚点里」（九个） | **五处在锚点之外**，逐条见 §11 | — |
| 7 | 「每道闸一条变异」 | 101 条，**全部实跑到 red**。⚠️ **有四道闸没有写变异**，因为它们**没有输入** —— 逐条写在 §7.2，不假装它们验过 | §7 |
| 8 | 「变异演练：每道闸一条，实跑到 red」 | 第一趟 **87/101**；那 14 条里**四条查出的是金样自己的缺陷**（两格被键函数合并、一格边界除不精确、一格摘要分辨不出），逐条见 §7.1 | §7.1 |

---

## 11. 给合并方的提醒

- **九个共享锚点里动了七个**：`tools/mutate/mutations.ts`（101 条，全在 7b-2 锚点里） ·
  `spec/deviations.md`（7 条） · `spec/golden/README.md`（一节） ·
  `packages/host/numerics/src/index.ts`（一行 export） ·
  `packages/host/stm-skills/src/l0/index.ts`（import / 展开 / re-export 三处） ·
  `scripts/gen-skill-specs.ts` · `tools/spec-export/export_skill_traces.py`。
  **`packages/host/vision/src/index.ts` 与 `kernel/src/index.ts` 一个字都没动。**
- **锚点之外动过的共享文件（五处，逐条）**：
  1. `scripts/gen-skill-specs.ts` —— 锚点只给了三个空数组，**消费它们的三处**
     （`names` 数组、抬头计数串）在锚点之外。我把 **7B-1 / 7B-2 / 7B-3 三条一起加了**，
     好让另外两条支线加的是**同一串字**（「两边都加了同样的行」比「各加一行」好合）；
  2. `tools/spec-export/export_skill_traces.py` —— 同上，主循环那三行也是三条一起加；
     另加 `PARAM_OVERRIDES` 八条（⚠️ `RunGridExperiment` 那一条**必须有**，
     不然那一格的 `success` 两侧相反，见坑 ③）；
  3. `packages/host/stm-skills/src/l0/index.ts` —— **7b 三条支线都没有 re-export 锚点**
     （只有 import 与展开）。我按 7a-3 的房规补了三条（7b-1 / 7b-2 / 7b-3），
     7b-1 与 7b-3 那两条留空；
  4. `packages/host/stm-skills/src/l0/traces.test.ts` —— 三处：
     `VOLATILE` / `EARLY_VOLATILE` 各加 `start_time`（**全份金样里只有
     `RunGridExperiment` 有这个键**，已核；两张表由一条现成的测试钉成同一张），
     `reshapeReason` 多认一个键名 `parse_error`，`DEVIATIONS` 加两条
     （`AcquireDeltaFCurve` 那一族的 reshape 措辞 + `AcquireSignalPoint/empty@0` 的信封）。
     ⚠️ **另两条支线如果也往 `DEVIATIONS` 里加行会撞**；
  5. `packages/host/numerics/src/batch7b2.test.ts` 是新文件，不算改动，但它的**位置**
     是一个决定：`phase_shift` 的判据与看着它的测试必须在同一个包里，
     否则那 9 条变异会被 `run.ts` 判 `narrow-scope`（批 6c 搬家那一课）。
- **`profiles/mast-rig` 没碰。** `packages/host/compat/src/` 之外零 `from '@deepseek-ai/`
  （`grep -rn "from '@deepseek-ai/" packages --include=*.ts | grep -v compat/src` ⇒ 0）。
- **只读旧仓已自证**：每次导出之后跑 `find MAST -newermt '-30 minutes'` ⇒ **0**。
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json` / `batch7b2.json`）
  已按本支线重跑；合并后请**统一再跑一次**，顺序照 DoD ⑧：
  ```
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  <venv>/python.exe tools/spec-export/export_batch7b2.py
  node scripts/gen-skill-specs.ts        # gen:skills
  node node_modules/typescript/lib/tsc.js -b
  node scripts/build-progress.ts         # gen:progress
  ```
- ⚠️ **合并之后把 101 条变异再跑一遍**：9 条打在 `numerics/phase-shift.ts` 上、
  92 条打在 `stm-skills` 的六个新文件上。另外两条支线如果动了同一批文件，
  `find` 串会不再唯一命中 ⇒ 判 `inconclusive`。
- ⚠️ 演练日志 `docs/handoff/drill-7b-2-2026-09-20.log` **已入仓**
  （`.gitignore:16` 的 `*.log` 被 `:24` 的 `!docs/handoff/*.log` 放行；
  用 `git ls-files` 验过，不是用 `ls` / `wc`）。
  它是**最终树上那一趟**的记录 —— 第一趟 87/101 的那份已被覆盖，
  那 14 条的经过写在 §7.1（结论比日志值钱）。

---

## 12. 值得进课时的三件

### ① 一条推不出来的容差，**说明该换的是输入，不是容差**

批 7a-3 记的是「推导给的是绝对界时别写成相对的」。这一批撞到它的上一层：
**有些量根本没有界。**

`phase_shift` 的 `snr` 在一个解析光滑的合成帧上，两侧差 2e−10 而我能推出来的界是
1.4e−13。我先试着把界放大（按最坏那一格的相位放大），得到的数比实测大 10 个数量级
—— 那时应该停下来问的不是「常数取多少」，而是**「这个量在这一格上有定义吗」**。

答案是没有：归一化之后，谱里数值为零的那几格的相位由舍入决定。
**改输入**（加一层真机本来就有的噪声）之后，同一条推导一次就对上了。

> 「容差要么推得出来，要么就别写」的下一句是：
> **推不出来的时候，先看看是不是这一格的输入让那个量失去了定义。**

### ② 一个「按函数级追」追得到的依赖，和一个追不到的

任务书说「零数值缺口」——**按「这个函数要调哪些函数」量，完全正确**。
这一批真正卡住的两处都不是函数依赖：

* `mean_std` 用的是**内建 `sum()`**，而它在 CPython 3.12 换了算法；
* `nanmean` 用的是 **numpy 的 `mean`**，而它是成对求和。

两处都不是 import、也不是「缺一个函数」，是**同一个名字在两个运行时里是两件事**。
它们被发现的方式也一样：**金样红了**，红在最后一位上。

> 批 7a-3 记的射程问题是「它需要框架允许它做什么」。
> 这一批的是第三面：**它踩着的那个内建，是哪个版本的哪一个。**

### ③ 「不假装它活着」是一个**三层**的动作，少一层就变成了假装

一条死代码，正确的处理不是「跳过」也不是「做活」，而是：

1. **今天的行为进金样**（`series/dead_path`）—— 否则下一个人会以为它没被验过；
2. **一条量着它的测试**（直接断言 `ScanAt` 的回包里没有那三个键）—— 否则
   「它是死的」只是一句注释，而注释不会在它活过来的那天变红；
3. **假设那一层单独命名**（`hypothetical_*`）—— 否则一份「这条路的判据都在」的
   金样，会让人以为这条路在跑。

这一批第一版只做了 ①，看起来完整；而 ② 才是那条会在未来某天替人省一整轮的东西。

### ④ **一个金样的「键」也是判据的一部分**

`barrier_verdict` 那一节我用 `f"{phi:g}"` 当键，写的时候想的是「给人看得懂的名字」。
`g` 给 6 位有效数字，于是 `2.999999` 与 `3.0` 变成同一个键 `"3"`，后写的覆盖先写的
—— **两条闭区间边界在金样里凭空消失了**，而那一节看起来有 8 格
（实际 6 格，且我从没数过）。同一个坑在 `0.999999` 与 `1.0` 上又来了一次。

它被抓住的唯一原因是：那两条边界**各有一条变异**，而两条都报绿。
如果我只写了「三条判读各一条变异」，这个缺陷会活到下一次有人去动那两条线为止。

> 「一格分辨不出两种候选的金样不是判据」的上一层：
> **一个会把两格合成一格的键函数，等于把那道闸从金样里删了** ——
> 而删掉的那一格，在 `git diff` 里看不见（它从来没出现过）。
>
> 配套的一条是同一批的 `0.3 / 0.1 = 2.9999999999999996`：
> 边界判据的**输入本身**要精确，否则「正好在线上」那一格根本不在线上。
> 批 7a-2 学过它的一半（「边界判据造在轴上」），这次学的是另一半：
> **造边界用的那个除法，也要是精确的。**
