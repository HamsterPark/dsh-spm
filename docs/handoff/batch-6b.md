# 批 6b 交接 —— vision 的 `scan_prep` 链（**2 / 5**）+ 三份判据本体

**落地 2 个技能 / 1 个模块**（`builtins.scan_prep` **整模块清零**），
外加 `scan_prep`（855 行）· `scan_artifacts`（157 行整份）· `tip_change`（395 行）
三份判据本体，与 `scan_prep_thresholds` 那 20 个批 4a 欠下的字段。

技能 **411 → 413**（分母 515），模块 **88 → 89**（分母 165），
测试 **5761 → 5983**，变异 **510 → 553 条全红**，偏差登记 **+8 条**（编号留空）。

**没做的三个**：`VerifyAtomicResolution` · `PreScanCheck` · `CheckLineQuality` ——
逐条卡在哪个**函数**、多少行，见 §6。

---

## 0. 一句话

> 盘点说这一块是「**≈2800 行**，`FrameMetrics` 每个字段都是判据本体，移了壳就是一张空表」。
> 核出来 2800 里有 **817 行批 4b 已经落了**（`atomic_phase`），而真正的活是另一件事：
> **那张表里有三分之一的字段，在本仓原有的输入上一次都不会被算出来。**
> 43 条演练第一轮 **10 条绿**，没有一条是代码写错 —— 全部是「那道闸没有输入」。

---

## 1. 落了什么

```
新增（判据，零 I/O）
  packages/host/vision/src/scan-prep.ts      1175  量 → 选 → 说清楚（measureFrame / planFor /
                                                   frameNotes / applyFlatten / harmoniseBatch）
  packages/host/vision/src/tip-change.ts      592  扫描中途针尖突变 v2（空库标定 + 滞后 k 差分）
  packages/host/vision/src/ndfilters.ts       170  scipy.ndimage 三件：uniform_filter / median_filter(1D/2D)
  packages/host/vision/src/lsq.ts             116  Householder QR 最小二乘 + np.polyfit
改动（判据）
  packages/host/vision/src/scan-artifacts.ts  107 → 387  补上 _oscillation / _drift_px / _spike_frac 与整份入口
  packages/host/vision/src/plane.ts           +85  polySubtract（order 1 与 2，**两条求解路**）
  packages/host/vision/src/tip-metrics.ts     +110 fwdBwdInstability
  packages/host/vision/src/frame-texture.ts   −44  它那一份 polySubtract 搬去 plane.ts，只留 re-export
  packages/host/kernel/src/scan-prep-thresholds.ts  118 → 342  20 个字段 + from_mapping + numeric_mapping

新增（技能与金样）
  packages/host/stm-skills/src/l0/scan-prep-skills.ts        505
  packages/host/vision/src/scan-prep.test.ts                 653（179 条）
  packages/host/stm-skills/src/l0/scan-prep-skills.test.ts   271（38 条）
  tools/spec-export/export_scan_prep.py                      977
  spec/golden/scan_prep.json                                 4.0 MB / 15 节（重跑逐字节相同）
```

### 金样一览（**37 张合成 `.sxm`**，一律从字节读回来）

| 节 | 格数 | 节 | 格数 |
|---|---|---|---|
| `primitives` | 8 | `scan_artifacts` | 19 |
| `terrace_mask` | 4 | `tip_change` | 9 |
| `fine_peak` | 6 | `fb_instability` | 6 |
| `measure_frame` | 30 | `plan_for` | 34 |
| `apply_flatten` | 33 | `harmonise_batch` | 4 |
| `thresholds`（含 7 格 `from_mapping`） | — | `report_md`（报告全文，逐字比） | — |
| `skills` | `AnalyzeScanImage` **27** + `AutoProcessScanBatch` **6** | | |

---

## 2. 该登记成 deviation 的（**编号留空**，我按 `D-SCANPREP-*` 等临时编了）

已写进 `spec/deviations.md` 的 `批 6b` 锚点下方（新增 8 条）：

| 临时编号 | 一句话 |
|---|---|
| **D-SCANPREP-2** | PNG 没移（matplotlib = D 档），而 `png_path` 恒为空串**正好是旧仓自己的一条合法路径**；`_write_report` 反过来照移，报告全文逐字比 |
| **D-SCANPREP-3** | 阈值那 20 个字段**带着消费方**补上了（销 D-SCANPREP-1 的一半）；`KNOB_LABELS` 仍不移；**两种越界处理并存**照移，外加「丢弃要说出来」与「收 snake_case 键」两处本仓新增 |
| **D-SCANPREP-6** | 两处**旧仓自己就不确定**的地方：多数票的平局（CPython 的集合迭代序由哈希定）与输出目录缺省（本仓没有 figures 目录）。两处都没有金样，登记是为了让下一个人分得清「移错了」与「那里本来就没有答案」 |
| **D-SCANART-2** | `detect_scan_artifacts` 补齐另外三条路，而 D-SCANART-1 的警告**没有被推翻** —— 它警告的是拿循环相关量**漂移矢量**，这一份不是那个用途且自带两道闸 |
| **D-SCANART-3** | 整条路在 float32 里；本仓照抄**输入量化**、累加留 float64 ⇒ `OSC_REL_TOL = 32·eps32`，计数与下标容差 0 |
| **D-TIPCHANGE-1** | `tr` 通道**没有移**（消费方给的是一帧，旧仓自己这条路上也没跑过；移它还要一件没有消费方的 `irfft`） |
| **D-SCANPREP-4** | ±k 孪生峰 ⇒ `fine_angle_deg` 可能与旧仓差**正好 180°**；测试两侧折到 `(−90, 90]`。**同 D-LATTICE-1** |
| **D-SCANPREP-5** | `kernel` 的 `pyFixed(-0, n)` 丢了负号（Python 给 `'-0.0'`）—— 这一格**真的印在报文里**。本批在两处 `fx()` 里挡了一层，**没改 kernel**，写成给主线的欠账 |

⚠️ **除 PNG 之外一处「本仓更严」都没有**：两个技能逐格与旧仓相同，包括那三段
「原子相判不了」的中文、`lod` 那句「本可以看见 ≥ …」、以及正反扫那句带口径的话。

---

## 3. 变异演练（**43 条，43/43 实跑到 red；基线连测五趟 5/5 干净**）

```
pnpm build && node scripts/gen-skill-specs.ts && node scripts/build-progress.ts
node tools/mutate/run.ts <43 个 id…>
```

**基线**：`run.ts` 开跑前那一趟不带任何变异的 `packages/host`
（**5788** 条）**全绿**，连量五趟 **5/5 干净**（抬预算之前是 2/4 脏，见 §6 那一条），所以整趟没有底噪 —— 这是 2026-09-19 那条新判据
（green-8 §3.4 第 1 条）第一次在新支线上用。演练前按要求重跑过
`pnpm build → gen:skills → gen:progress`。

分七组：

| 组 | 条数 | 代表 |
|---|---|---|
| 平场选择与色阶 | 5 | `line_gain` 的分子分母 · 行纯度不是台阶 · `masked_line` 要两个条件 · **精细结构优先于台阶** · NaN 标注有阈值 |
| 量（粗糙度 / 行相关 / 行段 / 受限带峰） | 10 | **均值滤波不是中值** · 窗是 `(1,9)` · 数据太少给 NaN 不给 0 · 取**最长**行段 · 轴向死区两条轴 · 带内 ≥3 px · 带内 ≥50 格 · 半宽用峰间距 · masked_line 先去行偏置 · 少像素行插值 |
| 转发与批次 | 4 | 行号换算回整帧 · 形状不一致要记 delegate error · 台阶帧豁免多数票 · 多数票要够票 |
| 伪影三件 | 9 | 轴上是 ±1 格 · 挖掉谱心 · **偏移峰要赢零位移峰 8%** · 中心圆窗 · 尖峰要孤立 · 早退不是判决 · 坏行看均值**和** std · 保留逐行偏置 · 抄近道与整份同一道早退 |
| 针尖突变 v2 | 9 | 空库按尺度 · 取**最好**通道 · med3 之后再定位 · 右移 `k//2` · **趋势进零假设**（窗 101） · MAD 下限只是数值守卫 · dc 要去平面 · 短帧不给结论 · Bragg 要凸显度 |
| `scipy.ndimage` | 2 | **跑动和**（NaN 会污染后继） · 偶数窗取上中位 |
| 阈值 profile 与技能层 | 4 | 可空阈值丢弃不夹紧 · 收 snake_case 键 · 通道那句要说清有什么 · 报告阈值行排序 |

### ⚠️ 自查那条「指纹」规则（green-8 §3.4 第 3 条）

那条规则是：**表里出现「多条变异红的条数完全相同、而且正好是全表最小值」，先去量基线。**

本批的最小值是 **1**，而且有 **5 条**取到它
（`artifacts-shortcut-has-the-same-early-exit` · `ndfilters-` 两条 ·
`scanprep-fine-band-needs-fifty-bins` · `scanprep-fine-band-needs-three-px` ·
`scanprep-harmonise-needs-a-quorum` · `scanprep-report-thresholds-are-sorted` ·
`tipchange-short-frame-is-not-a-verdict`）—— **形状上正好命中那条规则**。

量过了，**不是底噪**：基线连跑五趟 5/5 干净（`packages/host`，5788 条），
而这几条各自就是**只有一条测试在验的窄闸**（一条 `it` 专门为它而写，
见 §3 那张「第一轮绿」的表）。把它们的 `it` 名字对一遍就能确认：
每一条都指向那一格为它造的输入。

> 规则没有说错，是这一批真的有一批「一条测试一道闸」的窄闸。
> **值得记的是：那条规则是个提示，不是判决 —— 而验证它只要六分钟。**

### ⚠️ 第一轮 **10 条绿**，而这一批的主要收获全在修它们的过程里

绿的成因**一条都不是**「代码写错了」，全部是 green-8 §4 的前两种形状。
逐条的修法与它照出来的事实：

| 变异 | 为什么绿 | 修法（**一律是造一格为它而造的输入**） |
|---|---|---|
| `artifacts-dc-core-is-excluded` · `drift-must-beat-zero-lag` · `drift-search-is-central` · `spikes-are-isolated`（第一轮）· `bad-rows-keep-row-offsets` | **伪影那三件一次也没跑过** —— `std < 1e-9` 的早退在 pm 级的帧上恒成立（D-SCANART-1 写着「真机上几乎总是」，而我一开始把那句话当成一条注解而不是一条**测试设计约束**） | 四张 **nm 级起伏**的帧：`rough_tilt`（快轴碗）· `badrows_offset`（八行抬 40 nm）· `rough_farshift`（挪 40 px）· `rough_weakshift`（挪 5 px 权重 1.0 + 没挪 0.97 ⇒ 峰比 **1.031**，超过 1 而够不到 1.08） |
| `scanprep-tip-change-row-is-frame-coords` | 每张帧的 `r0` 都是 0 ⇒ `+ r0` 加不加同一个答案；而**能检出针尖突变**的那张帧又是满帧的 | `unfinished_top`：顶上 20 行没扫 + 第 90 行起**行内噪声 ×20**。为什么必须是纹理变化见下 |
| `scanprep-fine-band-needs-fifty-bins` | 每张帧的带里都有上千个格 | `tiny_band`：16×16、0.3 nm/px ⇒ 带内只剩三十几个格 |
| `scanprep-thin-rows-are-interpolated` | 未扫的行是**整行** NaN，连 `polyfit` 的门槛都够不到 | `unfinished` 的第 84 行**扫了一半**（前 6 个像素有数）—— 这是「正在扫的那一行」的真样子 |
| `artifacts-shortcut-has-the-same-early-exit` | 抄近道与整份在每一格上都给 0 | `near_flat_badrows`：几乎死平 + 五行抬 **40 nm**。⚠️ 第一版抬 10 pm **还是绿的**，因为 `_bad_rows` 的 `mad + 1e-9` 防零除**本身也是一道卡在物理量上的绝对阈** |
| `scanprep-harmonise-needs-a-quorum` | **第一道闸挡住了第二道** —— 我一开始把方向想反了，见 §4 | 造一组「四张同组、两张台阶帧豁免」⇒ `idx = 4 ≥ 3` 过得去而 `free = 2 < 3` 拦得住（`free_below_quorum`） |
| `scanprep-batch-harmonises-only-in-auto` | **那道闸不可达** | **证明后整条拿掉**，只在生产代码里留一段注释（见 §4） |

### ⚠️ 「一条编不过的变异」四次

| 变异 | 编不过的原因 | 修法 |
|---|---|---|
| `scanprep-roughness-is-a-mean-filter` | 换掉调用 ⇒ `uniformFilter2d` 这个 import 未使用（TS6133） | **打在 import 上**（批 4b 那一招的第三种），`replace` 里现造一个同签名的 `const` |
| `scanprep-terrace-half-width-uses-separation` | 删掉那一项 ⇒ `sep` 未使用 | 打在**那个数**上（`sep / 3.0` → `sep / 1e9`） |
| `tipchange-bragg-needs-prominence` | `prom >= 0` ⇒ `braggMinProm` 未使用 | 同上（`prom >= braggMinProm * 0`） |
| `scanprep-missing-channel-says-what-is-there` | 去掉那半句 ⇒ `have` 与 `pyList` 都未使用（**两次**，第一版只救了 `have`） | `replace` 里把 `pyList(have).length` 印出来 |

---

## 4. 「两道闸挨在一起」的两种结局 —— 而我第一次把方向想反了

`harmoniseBatch` 里那两行长得几乎一样：

```ts
if (idx.length < th.groupMin) continue              // ①
const free = idx.filter((i) => !out[i].stepLike)
if (free.length < th.groupMin) continue             // ②
```

**① 是冗余的**（可证）：`free ⊆ idx` ⇒ `free.length >= groupMin` 蕴含
`idx.length >= groupMin`，所以 ① 从来不**多**拒任何东西。
我据此把变异从 ① 改打到 ②，报告里写了「先证明不可达，再改打在做决定的那一行上」。

**然后 ② 也绿了。** 因为「① 冗余」与「拆掉 ② 会被 ① 挡住」是**两件事**：
我手上唯一一格两张图的用例，`idx = 2 < 3`，**① 先拒掉了它**。
② 要做一次决定，需要一格 `idx >= groupMin > free.length` ——
也就是**同组里有台阶帧被豁免掉之后票数不够**。

修法是造那一格（`free_below_quorum`：四张同组、两张台阶帧豁免 ⇒ `idx = 4`、`free = 2`），
而不是把变异挪回 ①。**这一格同时是那条判据的字面意思**：
「够票」数的是**可投票的帧**，不是这一组一共几张。

> 一句话：**「这一行是冗余的」与「这一行挡住了另一行」是两个不同的命题**，
> 而它们在源码里长得一模一样。证了前者不等于证了后者。

**另一道真的不可达**：`AutoProcessScanBatch` 的 `if (flatten === 'auto')`
（`scan-prep-skills.ts`）—— 给了 override 时 `planFor` 把**每一帧**的 `method`
都设成那个值 ⇒ `methods` 全同 ⇒ `nWin === methods.length` ⇒ `harmoniseBatch`
直接 `continue`。「跳过投票」与「投一次全票一致的票」输出相同，**造不出输入**。
这一条**没有变异**，生产代码里留了一段注释说明它在什么条件下会重新开始做决定。
两处都**没删代码**（都是旧仓那一行的逐字照移）。

---

## 5. 金样怎么来的

```
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe \
    tools/spec-export/export_scan_prep.py
```

**自己开一台**（同批 4b 的理由：三条支线同时跑，零冲突）。
三条纪律与批 4a/4b 相同（输入与答案一起录 / **帧从 `.sxm` 字节读回来** / 墙钟不进），
本批只补一条：

> **每一张帧的 docstring 里都写着「它一个人撑着哪道闸」。**

噪声这一批改走 `np.random.default_rng` 而不是闭式 sin-hash ——
**帧是从字节读回来的，两边都不重算它**，所以发生器不影响可复现性；
而 sin-hash 会引入一个强单频分量，把 `fine_periodic_peak` 的带内峰变成伪影。

### 几张为某一道闸而造的帧（其余见导出器的 docstring）

| 帧 | 它一个人撑着哪道闸 |
|---|---|
| `bow`（**只沿快轴**的碗） | bare `curved` 那一支。⚠️ 径向碗的逐行一阶拟合只吃掉 `i²` 那一半 ⇒ `line_gain = √2 > 1.30` ⇒ 那张帧会走 `line`，`curved` 永远拿不到输入 |
| `rowsplit`（每 8 行交替两档） | `row_purity > 0.70`。⚠️ 第一版是「上半帧高下半帧低」，**扣平面把它拟合成一条 y 斜坡**，两簇被拉成斜带、直方图并成一个峰 |
| `steps_flat` / `steps_bow` / `steps_drift`（**斜跨画面的两层条纹**，周期 96 px） | `stepLike` 的三条子路。⚠️ 用 `floor(...)` 的楼梯不行 —— 那就是一条对角斜坡，扣平面整个吃掉 |
| `lattice`（0.42 nm / 37°） | **`fine` 与 `stepLike` 同时为真** ⇒ 「色阶：精细结构优先于台阶」唯一的输入 |
| `axis_wave`（同样强，0°） | 轴向死区。外加一格换 `guard = 5°` 证明那个阈值真的在做决定 |
| `unfinished_top`（顶 20 行没扫 + 第 90 行起纹理变） | `change_row + r0`。见下 |
| `dead_flat`（**精确常数**） | 两条早退。⚠️ **不进** `measure_frame` / `plan_for` / 技能那几节 |

### ⚠️ 一格从 `measure_frame` 那几节**拿掉**的：`dead_flat`

扣平面之后只剩浮点舍入（~1e−25），而两边的最小二乘是两个算法
（本仓 `lstsqPlane` 的中心化正规方程 vs numpy 的 SVD）⇒ `fine_periodic_peak` 的
`argmax` 在两边**完全不同**。批 4a §9① 的原话：**一个答案是掷骰子的用例不是判据**，
修法是**改输入** —— 这里的「改输入」就是把它从那几节拿掉，换 `near_flat`
（常数 + 0.4 pm 噪声）顶上。它在两条**早退**那几节里照旧在，因为那两支是确定的。
同批 4b 把 `dead_flat` 从 `lattice_peaks` 一节拿掉。

### 反过来的一条：金样要能证明自己有鉴别力

`scan-prep.test.ts` 里有一格不比任何金样：把帧按相对 `1e−12` 抖一下，
断言受限带峰的**峰位一个都不动**。`argmax` 是离散判据，
而「这一格的答案不是掷骰子」这件事只能这么证（同批 4b）。

另有四条**结构性**断言（也不比金样），它们问的是「**金样有没有覆盖两侧**」：
四条平场分支与三档色阶各有输入 · 伪影三件的每一道阈值两侧都有格 ·
两张空库都有输入且判决两侧都有 · `tr` 通道确实不在。

### 容差表（**每一条连推导写在被测件自己的 docstring 里**）

测试里**没有一个字面量容差**。

| 件 | 容差 | 为什么是这个数 |
|---|---|---|
| `shape` / `deadRows` / `analysisRows` / `nPeaks` / `nanFrac` / `rowPurity` | **0** | 计数、下标、计数比 |
| `badRowFrac` / `spikeFrac` / `driftPx` / `oscillationCyclesPerLine` | **0** | 同上（`driftPx` 是 `hypot(整数,整数)`） |
| `method` / `clip` / `why` / `notes` / 报告全文 | **0** | 判决与原文 |
| `planeRmsPm` / `lineGain` / `bowGain` / `roughnessPm` / `stepSepPm` / `rowcorrMedian` | `FLATTEN_REL_TOL = 1e−9` | 它们是**残差的统计量**，而残差是往 A 正交补上的投影 —— 系数在近零奇异方向上的误差几乎不改变它。界在 `1e−14`，留五个量级的理由同 `CELL_REL_TOL`：**这一族真正会犯的错是选错平场方式**，不是最后一位 |
| `finePeriodicSnr` / `finePeriodNm` / `fineAngleDeg` | `FINE_PEAK_REL_TOL = 1e−9` | 分子分母同在一次 `fft2` 的 `‖F‖∞` 量级上，相对口径站得住 |
| `oscillationSeverity` | `OSC_REL_TOL = 32·eps32` | 两个 **float32** FFT 极大之比，再经一次除法 |
| `tipChange.score` / `lod` / `channelScores` | `TIP_CHANGE_REL_TOL = 1e−9` | `log` 把相对误差变绝对，再除以表里最小的 `mad`（0.145）⇒ 放大约 7 倍；界 `3e−13` |
| `fbInstability` | `FB_INSTABILITY_ABS_TOL = 64·eps32`（**绝对**） | `1 − max_ncc` 是一次**相消**；相消毁掉相对精度、不毁绝对精度 |
| `atomic.fft_sharpness` | `fftSharpnessRelTol(sharp)`（批 4b 那一条） | 单精度 FFT 的本底随锐度线性放大 |
| `medianFilter*` / `uniformFilter*` | **0** | 一个是搬运、一个是照抄的跑动和 |

---

## 6. 没做完的（逐条，卡在哪个**函数**、多少行）

| 技能 | 卡在哪 | 规模 / 性质 |
|---|---|---|
| **`VerifyAtomicResolution`**（`composite/verify_atomic_resolution.py` **880 行**） | `mast.core.sample_facts.current_sample_facts`（`execute:422`）—— 与批 4b 记的 `AssessAtomicPhase` **同一条链**：通到 `mast.knowledge.lookups`（30570 行知识库 + 17 MB `material_coverage.json`）与 `experiment_log` 的样品记录存储 | **C 档，不是 B 档**（同批 4b §8 那条修正）。判据侧 `atomic_phase` 本批已全在；卡的是**样品事实那一层** |
| **`PreScanCheck`**（`composite/prescan_check.py` **1446 行**） | 三件：① `mast.core.operating_mode.safe_mode_active`（盘点说 6 行 + 接线，**本仓全仓零命中，我核过**）；② `mast.core.state.VERIFIED_STATE_KEY`（跨调用的会话态键）；③ `vision.tip_metrics.trace_retrace_correlation`（本仓没有，与已落的 `fwdBwdInstability` 是**两个不同的估计量**，见下） | `crash_guard` **已在**（`kernel/tip-crash-tracker.ts`，批 3k/4a），`frame_validity` / `tip_metrics` 也在 —— 盘点说的「缺口只剩 144 行」**属实但不完整**：真正的成本是那 1446 行技能体与上面三件 |
| **`CheckLineQuality`**（`paper/line_check.py` **629 行**） | 同 ① 与 ③：`safeModeActive` + `traceRetraceCorrelation`。`acquiredRowMask` / `judgeFrame` **已在**（批 4a） | 两件加起来约 **60 行**，是三个里最便宜的一个 —— 但 ① 是一件**安全侧**的预言机，而本仓缺的**不是那 6 行**（见 §8） |

### `trace_retrace_correlation` 与 `_fwd_bwd_instability` 是**两个**量，别合并

本批落的是后者（`1 − 允许横向位移的最大归一化互相关`）。
前者是**一维**姊妹（逐行零位移相关），`PreScanCheck` / `CheckLineQuality` 读的是它。
两个函数的除零守卫都已经是 `1e-30`（旧仓 2026-08-10 那次两半一致），
但**估计量不同**：一个补偿了压电迟滞的快轴偏移，一个没有。
**合并会默默改掉判决** —— D-CHANNELS-1 的形状。

### ⚠️ 顺手补的一处**不在计划里**：批 4b 那条 4.2 s 的测试与演练的基线闸

`lattice-skills.test.ts > AssessAtomicResolution > hex` 单独跑是 **4209 ms**，
而 vitest 的缺省预算是 **5000 ms** —— 只剩 16% 的余量。
批 6b 往同一个 worker 池里加了 218 条测试之后，实测：

| | 四趟里红几趟 |
|---|---|
| 全量（含本批两个新测试文件） | **2 / 4**（另有 `instrument-watchdog` 的一条 `sleep(80)` 计时测试同因，但它不在演练的 scope 里） |
| 排除本批那两个文件 | **0 / 4** |

**代价不是「重跑一次」**：`run.ts` 的基线判据是 `failed > 0` ⇒ **整趟演练拒跑**
（green-8 §3.4 第 1 条）。也就是说那 800 ms 的余量决定了 553 条变异跑不跑得起来 ——
我连撞两次，第二次白等了三十五分钟。

做法：给 `lattice-skills.test.ts` 的两个 `describe` 一个 **30 s** 的显式预算，
理由连推导写在那个常量上。抬完 **5/5 干净**（`packages/host`，5788 条）。

⚠️ **这不是把测试改软**：这一格真正的开销是 4.2 s、整份文件 30 s，
**一次真的挂住照样远远超出** —— 它分得开的仍然是「挂住」与「跑完」，
只是不再分「机器忙」与「机器闲」。批 3d 的原话：
**预算不是优化，是让「挂住」说得出话。**

⚠️ **真正的修法是让它更快**（批 4b 自己就是这么干的：192 → 256 避开 Bluestein），
而那要动 `lattice.json` 里 `hex` 那张 256² 的帧、连带重录一整节 ——
那是一次单独的决定，不该塞进批 6b。**合并时注意：批 6c 是「晶格一族剩余」，
很可能也动这个文件；冲突面是一行 `{ timeout: GOLDEN_TIMEOUT_MS }`。**

⚠️ 那条 watchdog 计时测试（`卸载后轮询停下`，`intervalMs: 10` + `sleep(80)` +
断言 `seen.length > 2`）**没动** —— 它不在 `packages/host` 里，拦不住演练。
但它是同一种病：**一个把「机器有多忙」当成判据的测试**。留给主线。

### 其余欠账

| 欠的 | 写在哪 |
|---|---|
| **DoD ⑦ 技能卡片** | 本仓仍然没有 `scripts/gen-skill-cards.ts`（批 3g–5c 同样没做） |
| `kernel` 的 `pyFixed(-0, n)` 丢符号 | D-SCANPREP-5。**共享文件，本批没改** —— 主线改的时候要连带重跑所有印定点数的金样 |
| `scan_prep_commission`（327 行标定工具）与 `KNOB_LABELS` / `CALIBRATABLE_FROM_DISTRIBUTION` | 消融：本仓既没有设置 UI 也没有标定工具，两张表一个读者都没有 |
| `tip_change.cusum_online`（严格因果的在线路径） | 旧仓自己写着「for a future streaming deployment」，**当前零调用点** |
| `detect_tip_change` 的 `tr` 通道 | D-TIPCHANGE-1（连带 `numerics` 的 `irfft`） |
| `applyFlatten` 目前**只有测试在读** | 它是 `planFor` 那个方案的**执行半边**。一个没人执行得了的方案不是方案，所以移了；但要说清它今天的唯一消费方是金样。真正的消费方会随渲染 / 导出那一族一起来 |

---

## 7. `numerics` 这一轮我**一个字节都没改**（任务书要求），但有四件该搬过去

按 `nd.ts` 抬头那条标准（**它有没有第二个消费方**），下面四件的答案都是「有」——
它们对的是 `scipy` / `numpy` 本身，不是本族的判据。**本批全部落在 `vision/`，
搬不搬由主线决定。**

| 件 | 现在在哪 | 对的是 | 容差 | 谁会再用 |
|---|---|---|---|---|
| `uniformFilter1d` / `uniformFilter2d` | `vision/ndfilters.ts` | `scipy.ndimage.uniform_filter` | **0** | 任何要滑动平均的地方（`_terrace_noise` / `quality.py` 的 3×3 laplacian 一族） |
| `medianFilter1d` / `medianFilter2d` | 同上 | `scipy.ndimage.median_filter` | **0** | `seg_scale_adaptive._hist_modes` · `scan_artifacts._spike_frac` · `frame_validity` 之外的一整族 |
| `lstsqQr` | `vision/lsq.ts` | `np.linalg.lstsq`（一般情形） | `κ·eps` | 每一个设计阵不是 `[x,y,1]` 的最小二乘（本批的 `poly_subtract(order=2)` 是第一个） |
| `polyfit` | 同上 | `np.polyfit`（**含列缩放**） | 同上 | `atomic_lines.line_score`（3 阶）· `thermal_settle` 的 `polyfit(1)` · `force_inversion` |

⚠️ `uniformFilter1d` 搬过去时**把那段抬头一起搬**：它是**跑动和**，
一个 NaN 会污染这一行剩下的每一个输出 —— 那不是实现细节，
它直接决定 `scan_prep` 里粗糙度的输入（未扫完的帧上「每一行只有第一个 NaN 之前
那一段参与了粗糙度」）。**照抄跑动和不是照抄一个 bug，是照抄那道闸的输入。**

---

## 8. 我核出来与 `survey-remaining.md` 不一样的地方

| 盘点说 | 实际 |
|---|---|
| C 档「`mast/vision/` 的 scan_prep 链 \| **855 + 489 + 817 + tip_change/scan_artifacts ≈ 2800**」 | 那 **817 是 `atomic_phase.py`，批 4b 已经整份落了**（`vision/atomic-phase.ts` 632 行）。489 的 `scan_prep_thresholds` 也已落了 4 个字段。真正剩下的是 855 + 395 + 157 + 阈值表的其余 ≈ **1500 行**。**盘点从「漏算已经还掉的」那个方向过期了**（批 5b 撞过同一种） |
| C 档「`FrameMetrics` 每个字段都是判据本体，技能层只做读文件拼表。**移了壳就是一张空表**」 | ✔ 属实，而且比它说的更要紧：**移了实现、没造对输入，得到的也是一张空表** —— 只是那张表上的数字看起来完全正常。43 条演练里 10 条绿全是这个形状 |
| B 档「`vision/frame_validity`(275) + `tip_metrics` 三函数(144) ≈420 行 ⇒ 解锁 **PreScanCheck** · CheckLineQuality」 | 那两件**批 4a/4b 已经落了**（任务书让我自己核，核实无误）。但 **`PreScanCheck` 并没有因此解锁**：它另外要 `safe_mode_active`（本仓零命中）· `VERIFIED_STATE_KEY` · `trace_retrace_correlation`，**外加 1446 行技能体**。盘点把「缺口只剩 144 行」写成了这个技能的全部成本 |
| B 档「`core/safety.ts` 侧 `safe_mode_active` 预言机 \| 6 行 + 接线 \| 解锁 3 个」 | 行数属实（`core/operating_mode.py:91-96`），但它解锁的是 **5 个**（那 3 个 + `PreScanCheck` + `CheckLineQuality`）。**这是本盘点里性价比最高的一件没做的事** |
| C 档没提 `VerifyAtomicResolution` 卡在样品事实 | 它 `execute:422` 调 `current_sample_facts` —— 与批 4b §8 给 `AssessAtomicPhase` / `AssessHerringbone` 的那条修正**同一条链**。盘点那张表把它归在「畴/平区/团簇判据」那一行，而真正挡住它的是知识库 |
| 优先级表没提 `builtins.scan_prep` | 它是 **A 档的形状**（判据全是纯 numpy，零外部子系统），而被归进 C 只因为行数。**两个技能一次落完一个模块**，是这一轮性价比最高的一刀 |

---

## 9. 值得进课时的五件

### ① 「这道闸有没有被验到」要从**输入分布**问起，不是从覆盖率问起

批 4b §9② 说的是「一道闸可以被另一道闸挡住」。这一批给它添了**第二种形状**，
而且更常见：**一道闸可以被整个输入分布挡住。**

`detect_scan_artifacts` 的三件在本仓原有的每一张帧上都跑不到 ——
不是因为别的 `if` 拦着，是因为 `std < 1e-9` 这条早退在 **Z 以米计**的数据上
几乎恒真。D-SCANART-1 早就写着这句话（「真机上这条早退几乎总是成立」），
而我第一轮把它当成了一条**注解**，没当成一条**测试设计约束**。

> 一条写在 deviation 里的事实，如果没有一格金样按它造过输入，
> **它就只是一句话**。

### ② 「转发一个判据」不等于「那个判据在这条路上还管用」

`measure_frame` 转发 `detect_tip_change`，而它喂进去的是 `line_subtract` **之后**
那一段。逐行平场把行偏置整个擦掉 ⇒ `dc` 通道（那个「**最主要的** z 偏移特征，
旧版检测器整个丢掉了的那个」）**在这条路上是瞎的**。

实测：600 pm 的行 DC 跳变在独立调用里 `dc` 得分 **30.8**（判出来了），
经 `measure_frame` 那条路只剩 **−6.285**（判不出来）。

两边都是旧仓的行为，**都照移**。值钱的是这件事被一条变异照出来了：
`change_row + r0` 那一行一直是绿的，因为**没有任何一条路径能同时做到
「裁过行」且「检出突变」** —— 直到造了一张纹理变化的帧。

> **一个判据的灵敏度是它和它的输入一起定义的。**「我们转发了那个判据」
> 是一句关于代码的话，不是一句关于能力的话。

### ③ 绝对阈值卡在物理量上，这一批数到了**三处**

`tip_metrics` 那条注释（2026-08-10）写着「**一道绝对阈值卡在物理量上就是个 bug**」，
说的是 `_fwd_bwd_instability` 的 `1e-9` 除零守卫。这一批发现同一个仓里还有两处，
**都还活着**：

| 在哪 | 阈值 | 症状 |
|---|---|---|
| `detect_scan_artifacts` 开头 | `std < 1e-9` | Z 以米计 ⇒ **几乎每一帧都早退**，而返回的 `bad_row_frac = 0` 的含义是「没算」 |
| `_bad_rows` | `mad + 1e-9` | 防零除的 epsilon 本身就是 6×MAD 判据的下限 ⇒ **起伏小于 6 nm 的帧永远没有坏行**（造 `near_flat_badrows` 时第一版抬 10 pm 还是绿的，就是撞在这里） |

两条都**照移**（它们是旧仓的行为，改了就不是同一个判据），
但两条都**写进了金样的注释与 deviation** —— 因为读那个 0 的人需要知道它是「没算」。

### ④ 两个同名函数，一个该合并、一个必须分开 —— 判据是「**合并会不会改判决**」

这一批各撞到一次，答案相反：

* **`polySubtract` 该合并**：`frame-texture.ts`（批 4b）与我这一份是同一个旧仓函数
  的两次移植。合并了，而且 **order 1 那一路刻意保留 `lstsqPlane`**（中心化正规方程，
  κ ≈ 1），只有 order ≥2 走 QR —— 统一走一条会让其中一侧变差（批 4b 的
  `frame_texture` 金样全要重录，换来的是更差的条件数）。
* **`_detrend` 不合并**：`frame-validity.ts` 的 `detrend` 与 `tip-metrics.ts` 的
  `detrend32` 今天行为相同，但它们各自的容差推导挂在各自的消费方上
  （`corrugationRelTol` vs `DETREND_ULP_TOL`）。**这一条留给主线**，
  它是「十份 `cell()`」那一课的下一格。

### ⑤ **别人的测试预算，是我这一批的责任**

批 6b 没有改批 4b 的任何判据，却让批 4b 的一条测试**从稳定变成一半概率超时** ——
只因为往同一个 worker 池里加了 218 条 CPU 密集的测试。

而代价不是「重跑一次」：2026-09-19 刚给 `run.ts` 装上的基线闸
（`failed > 0` ⇒ **整趟拒跑**）把它放大成「553 条变异一条都跑不了」。
那道闸是对的 —— 它防的正是「每条变异继承同一条底噪」；
但它也意味着**任何一条 flaky 测试都能把整套演练锁死**。

> **一个有 16% 余量的预算，量的不是「这段代码有没有挂住」，是「这台机器忙不忙」。**
> 而当下游有一道 `failed > 0` 的闸时，那 16% 就成了整条流水线的单点。

三条可操作的：

1. **加测试的人要量基线的方差**，不只是量它绿不绿 —— 我连跑四趟才看出是 2/4 而不是偶然；
2. **排查顺序**：先 `--exclude` 掉自己新加的文件再跑四趟。全绿 ⇒ 是自己加的负载，
   不是别人的代码坏了。这一步花了六分钟，省掉了一整轮猜测；
3. 预算该按「这一格真正要多久」定，不按「缺省是多少」定。
   抬预算**不等于**把测试改软 —— 分界是：抬完之后，**一次真的挂住还分得出来吗**。

---

## 10. 给合并方的提醒

- **只动了锚点**：`l0/index.ts` 三处 `批 6b` · `gen-skill-specs.ts` 的 `BATCH_6B` ·
  `export_skill_traces.py` 的 `BATCH_6B` · `mutations.ts` 的 `批 6b` ·
  `spec/deviations.md` 的 `批 6b` · `spec/golden/README.md` 的 `批 6b`。
  **`kernel/src/index.ts` 没动** —— 本批往 kernel 加的全是
  `scan-prep-thresholds.ts` 里已经 re-export 过的符号。
- ⚠️ **锚点之外还动了一个批 4b 的测试文件**：
  `packages/host/stm-skills/src/l0/lattice-skills.test.ts` —— 两处 `describe` 加了
  `{ timeout: GOLDEN_TIMEOUT_MS }`（30 s），**零判据改动**，理由连实测写在那个常量上
  （见 §6 与 §9⑤）。**批 6c 是「晶格一族剩余」，很可能也动这个文件；
  冲突面就是那一行。**
- **锚点之外动过的共享文件**：
  - `packages/host/vision/src/index.ts` —— 末尾一个 `批 6b` 注释 + 四行 `export *`；
  - `packages/host/vision/src/{plane.ts,tip-metrics.ts,scan-artifacts.ts,frame-texture.ts}`
    —— **`vision` 这一轮由我主用**（任务书原话）。`frame-texture.ts` 那一处是
    **删掉重复实现换成 re-export**，合并时要注意它与批 6c 的冲突面；
  - `packages/host/kernel/src/scan-prep-thresholds.ts` —— 批 4a 建的，
    本批把它从 4 个字段补到 24 个。`corrugation-gate.ts` 与
    `l0/analysis-frames.ts` 两个既有消费方**一个字没改**，
    `scanPrepProfiles.external` 的类型从 `ScanPrepThresholds` 放宽成
    `ScanPrepProfilePatch`（部分覆盖），既有两处测试**照旧编得过**。
- **`packages/host/numerics/` 一个字节都没动**（§7 列了四件该搬过去的）。
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑；
  合并后请**统一再跑一次**：
  ```
  pnpm build
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  node scripts/gen-skill-specs.ts
  node scripts/build-progress.ts
  ```
- `spec/golden/scan_prep.json` 与 `tools/spec-export/export_scan_prep.py` 是本支线独有的。
- ⚠️ **旧仓这段时间有别人在写**（本机实测：`mast/vision/frame_validity.py` 的 mtime
  是 2026-09-19 16:46、`mast/_buildinfo.py` 写着 `RELEASED_AT = 16:12:51`、
  `scripts/apply_langgraph_removal.py` 是 16:59）。**不是这条支线写的** ——
  本支线对 `<MAST_ROOT>\` 只读，导出器把 `MAST2_PROJECT_ROOT`
  指向临时目录，实测那几次运行没有产生任何 `__pycache__` 写入
  （14:20–16:15 之间旧仓没有一个文件的 mtime 落在我的运行窗口里）。
  收尾时**又跑了一遍导出器**确认金样仍然逐字节相同 —— 那次 `frame_validity.py`
  的改动没有落在本批用到的判据上。
  **但这条要记着**：这份金样的可复现性依赖旧仓那几个文件不动，而它们现在会动。
  下次重跑对不上时，**先看旧仓的 `git status`**，别先怀疑本仓。
  **`spec/golden/analysis.json` / `lattice.json` / `numerics.json` 一个字节都没改。**
- **e2e / stmsim：0 条，而且不该有。** 两个技能一次 Nanonis 调用都不发，
  读的是磁盘上的 `.sxm`（同批 4a/4b 那条理由：在模拟器上跑它们，
  跑的是我自己合成的那份字节，而那份字节已经被旧仓亲自读过一遍了）。
  `skill_traces.json` 里这两个录到的是「文件不存在」那一支 ——
  **那仍然是一条判据**（外壳在碰任何东西之前先拒）。
