# 批 4b 交接 —— 晶格判据底座（**4 / 9**）+ 两件数值原语

**落地 4 个技能 / 2 个模块**，外加「晶格判据底座」那 ≈950 行的整块（六个新文件进
`packages/host/vision`、一个进 `kernel`）与两件新的数值原语。

技能 **376 → 380**（分母 515），模块 **60 → 62**（分母 165），
测试 **4179 → 4555**，变异 **282 → 350 条全红**，偏差登记 **+5 条**（编号留空）。

| 组 | 技能 | 底层件 |
|---|---|---|
| 晶格 `measure_cell` 组（**批 4a 欠下的两个**） | `AssessScanTexture` · `MeasureLatticeCell` | K1 峰表 + `measureCell` 链 + `frame_texture` |
| 原子相判据环 | `AssessAtomicResolution` · `AnalyseAtomicLattice` | `assessAtomicPhase` + K1 + `seg_scale_adaptive` 切片 + `tip_metrics` + 成像条件窗口 |

**没做的五个**：`AssessAtomicPhase` · `AssessHerringbone` · `AssessDomainPhase` ·
`AssessAtomicConsistency` · `FindFlatRegion` —— 逐条卡在哪个**函数**上见 §6，
其中**两个与盘点说的不一样**（§8）。

---

## 0. 一句话

> 这一批的产品是**四个不同的问题**，而它们的错法是同一种：
> **把「我回答不了」说成「答案是否定的」**。
> 2026-08-26 真机上那句话值一根 asp 1.295 / snr 37.3 的针尖 ——
> 修针流程把偏压留在 1.0 V，此后每一帧的读数都在说「针尖极其糟糕」。

---

## 1. 落了什么

```
新增（判据，零 I/O）
  packages/host/vision/src/lattice-peaks.ts   470  K1：二维布拉格峰 + 脊点剔除 + 表面查表
  packages/host/vision/src/lattice-cell.ts    851  measureCell / combineUpDown / superstructureTest
  packages/host/vision/src/frame-texture.ts   574  带通与相干两个口径 + 逐块比值图 + 条纹幅值
  packages/host/vision/src/atomic-phase.ts    632  原子相判据环（角向集中度 / 阶序 / 快轴周期）
  packages/host/vision/src/seg-texture.ts     354  flattenRobust + 径向带内取峰（seg_scale_adaptive 切片）
  packages/host/vision/src/tip-metrics.ts     167  detrend32 + fftSharpness（**float32 那一步照抄**）
  packages/host/kernel/src/imaging-window.ts  123  成像条件窗口（零 numpy，所以留在 kernel）

新增（数值原语）
  packages/host/numerics/src/pairwise.ts      110  np.add.reduce 的成对求和 + np.mean / np.var / np.std
  packages/host/numerics/src/pcg64.ts         195  numpy 的 SeedSequence + PCG64，**逐位**

新增（技能与金样）
  packages/host/stm-skills/src/l0/analysis-lattice.ts        710
  packages/host/vision/src/lattice.test.ts                   502
  packages/host/stm-skills/src/l0/lattice-skills.test.ts     220
  tools/spec-export/export_lattice.py                       1084
  spec/golden/lattice.json                                  3.3 MB / 18 节（重跑逐字节相同）
```

### 为什么又多了两件**数值原语**（而不是留在 `vision`）

`nd.ts` 抬头那条判断标准只有一个：**它有没有第二个消费方？**
这两件不但有，而且它们对的是 **numpy 本身**，不是本族的判据：

| 件 | 对的是 | 容差 | 谁会再用 |
|---|---|---|---|
| `pairwise.ts` | `np.sum` / `np.mean` / `np.std` | **0** | 每一个移植 numpy 归约的地方（现在是 `sumRelTol(n)` 那一族的全部调用方） |
| `pcg64.ts` | `np.random.default_rng` | **0** | 每一个旧仓用 `default_rng(seed)` 的判据（本批是 `superstructure_test` 的 8 个空白对照） |

`pairwise` 那一件值得单说：**它把一族「有容差」的断言换成了零容差**。
`sumRelTol(n)` 那条界是在「本仓 Neumaier 补偿 vs numpy 成对」这个前提下推的 ——
两种**不同的**算法之间只能给界；而把 numpy 那一种**照着写一遍**，两边就是同一串
浮点运算，差为 0（本机十一组 `n = 3…4096` 全部按 `float.hex()` 逐位相同）。

---

## 2. 该登记成 deviation 的（**编号留空**，我按 `D-LATTICE-*` 等临时编了）

已写进 `spec/deviations.md` 的 `批 4b` 锚点下方（新增 5 条）：

| 临时编号 | 一句话 |
|---|---|
| **D-LATTICE-1** | ±k 孪生峰**谁排在前面没有定义** —— 精确算术里那是一个精确平局，而 numpy 自己也差一个 ulp。折到上半平面再比 |
| **D-SHARP-1** | `_fft_sharpness` 旧仓在 **float32** 里做整条 FFT（`astype` + NEP 50 弱标量 + complex64）。本仓只降输入、变换留 float64，差额 `8·eps32·sharp` |
| **D-SUPER-1** | `superstructure_test` 的相干求和是**相消**的（三个量级）且 numpy 走 BLAS 矩阵乘 ⇒ 只能给**绝对**容差。**但对照波矢本身逐位复现了** |
| **D-LATTICE-2** | 同一件事两套措辞（通道那句差两个字；没有像素标度时一族报错、另一族给 `unknown_pixel_size`）—— **两套都照移** |
| **D-LATTICE-3** | 两个 `_MIN_PERIODS_IN_FRAME`，同名不同值（判据 5 / 测量 12）。D-PIEZO-1 的形状 |

⚠️ **这一批一处「本仓更严」都没有** —— 四个技能逐格与旧仓相同，包括那三段成像
条件的中文、那句 `scale_reduced` 的解释、超结构的三态判决。唯一需要在测试里解释的
只有容差。

**顺带修正了一条旧的**：`numerics/src/rng.ts` 抬头原先写着「复现 PCG64 要实现一个
128 位状态的 LCG」，语气像「做不到」。做到了。那一份**仍然不换** ——
理由写进了它的抬头：RANSAC 的抽样序列**对面没有一个被比的答案**。

---

## 3. 变异演练（**68 条，全部实跑到 red**）

```
node tools/mutate/run.ts <id…>          # 一条一条
MUTATE=1 pnpm vitest run --project mutation
```

分十组，每组挡的是一件具体的事：

| 组 | 条数 | 代表 |
|---|---|---|
| K1 峰表 | 10 | 脊分取两轴的**大**者 · 邻居取中位数 · `nRidge` 是证据 · 预算算上脊点 · 谱心抹零 · 一阶峰是行间距 |
| 实空间原胞 | 13 | 带上界跟帧宽收 · 基矢必须是强峰 · 指标得分按功率 · 每周期 ≥4 px · a₁ 是长的 · γ 取锐角 · 亚像素精修 |
| 超结构 | 4 | 对照来自 numpy 的 PCG64 · 对照避开半序 · `present` / `absent` 两个阈值 |
| 帧纹理 | 8 | 条纹带加窗 · 慢轴 ≤16 行 · 分母挖掉晶格带 · 块 ≥8 周期 / ≥16 px · 扇区双侧 · 中位不均值 |
| 原子相判据环 | 10 | **半径散布用全部极大** · `peaks_are_ridges` 是证据 · 快轴分歧判否 · 取最小周期 · 过渡带默认拒 · 裁未扫行 |
| `seg` 切片 | 5 | 带内取最小周期 · 行对齐用中位差 · 迭代三轮 · 2.5σ 内点 · 信噪门 |
| 成像条件窗口 | 3 | **读不到就放行** · 偏压看绝对值 · 电流下限 |
| 技能层 | 8 | 扫描先后按 `SCAN_DIR` 映射 · `good_ratio` 无默认 · 只差尺度不说「抖动」 · IO 失败 ≠ 判不了 |
| 数值原语 | 6 | 成对求和的块长与切点 · PCG 的 `inc` 与 11 位 · SeedSequence 双向混 · 小端拼 |
| 其余 | 1 | 两族对「没有像素标度」的处置不同 |

### ⚠️ 「一条编不过的变异」第十六~二十一次

第一轮 68 条里 **6 条 inconclusive**，全是同一族的两个形状：

```
atomic-phase.ts(57,27):  TS6133 'cropRows' is declared but its value is never read
seg-texture.ts(338,9):   TS6133 'latSnr' is declared but its value is never read
lattice-cell.ts(493,7):  TS2367 类型 '"full"|"reduced"|"off"|null' 与 '"nope"' 没有重叠
imaging-window.ts(112):  TS18047 's' is possibly 'null'   ← `if (false && s !== null)` 撤掉了收窄
```

修法三种，**都不是「把变异改软」**：

1. **打在那个数上**（`RIDGE_SPAN`/`clip`/`snr >= latSnr − 1e9`/`s < −1`）——
   与 `readback-uses-tolerance` 同一条；
2. **打在那个 `if` 上而不是它调用的那个函数上**（`cropRows` 留在死支里，TS 照样
   算它被用了）；
3. **打在 import 的别名上** —— 这一次新出现的：
   ```ts
   find:    "import { finiteOf, npMedian } from './nd.js'"
   replace: "import { finiteOf, nanMean as npMedian } from './nd.js'"
   ```
   把两处 `npMedian(...)` 都换成 `npMean(...)` 会让那个 import 变成未使用；
   换**别名**则每一个标识符都还有人读，而实现真的换了一个。
   这一招比「提一个带返回类型的函数」更省 —— 它不改生产代码的形状。

### 还有**五条一开始是绿的** —— 而绿的意思是那道闸没有人在验

| 变异 | 为什么绿 | 怎么修的 |
|---|---|---|
| `lattice-dc-block-is-zeroed` | 默认搜索带（上界 0.80 nm）的最小半径 = `视野/0.80`，**够不到那个 7×7** | 加 `tri_skew` 一格带 1.43 nm 长波（半径 3.5，正落在方块里）+ 一个把带放宽到 2.0 nm 的用例 |
| `lattice-hex-needs-all-three-gaps` | 三个夹角要么全在 60°±8°（hex）要么全不在（rect）⇒ `every` 与 `some` **同解** | `tri_skew` 的方向取 0°/62°/140° ⇒ 夹角 63.4 / 78.4 / 38.2，**恰好一个**在容差里 |
| `lattice-angles-are-python-modulo` | 打错了行：去重那一行改完，`angles` 仍由 `pyMod` 重算 ⇒ 结果不变 | 改打在 `angles` 那一行上（`latticeAngleDeg = min(angles)` 会当场变号） |
| `phase-radius-cv-uses-all-maxima` | `half` 那一格**只用幸存的峰也够 3 个**、CV 也够大 ⇒ 两种写法同解 | 加 `stripe_loud`（同一条纹放大 150 倍）：幸存峰只有 2 个，`peaks` 单独连 `>= 3` 都够不到 |
| `seg-texture-needs-the-snr-floor` | 每一帧要么信噪远超 4、要么压根没有带内峰 ⇒ 那道门**从来没有做过决定** | 加 `noise_weak`（同一种噪声换一个 salt）：信噪 2.58，在门下 |
| `phase-detrend-output-is-float32` | 容差是**一个 ulp**，而去掉 `fround` 只挪**半个** ulp | 补一条**结构性**断言：输出的每个数必须 `=== Math.fround(自己)`，零容差 |

> 最后那一条值得单记。它不是「金样缺一格」，是**容差的形状不对**：
> 一个「输出是不是 float32」的问题，用「两个数差多少」永远问不出来。
> `numerics-3.md` 第四节那条「结构性判据顶上」在这里第二次用上。

---

## 4. 金样怎么来的

### `spec/golden/lattice.json`（新，3.3 MB，18 节，**重跑逐字节相同**）

```
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe \
    tools/spec-export/export_lattice.py
```

**自己开一台，不往 `export_analysis.py` 里插** —— 那份文件是批 4a 的，而三条支线
同时跑。代价是重复四十行合成器，收益是**零冲突**。

十八节：`condition_numbers` · `sxm_files`（19 份 `.sxm` 字节）· `first_order_period` ·
`lattice_peaks` · `measure_cell` · `combine_up_down` · `superstructure` ·
`frame_texture` · `frame_texture_reject` · `streak_edge` · `scale_gate` ·
`flatten_robust` · `detect_texture` · `tip_metrics` · `concentration` ·
`atomic_phase` · `imaging_window` · `skills`。

三条纪律与批 4a 相同（输入与答案一起录 / 帧从 `.sxm` 字节读回来 / 墙钟与随机数不进），
**第三条这一批放宽了半句**：`superstructure_test` 用 `np.random.default_rng(0)`，
而本仓复现得了它，所以那一节照录、不绕开。

#### ⚠️ 帧的边长必须是 **2 的幂**，而这是测试超时教的

第一版取 `192`（= 2⁶·3）。本仓的 `fft` 只对 2 的幂走 radix-2，别的长度走
**Bluestein**（补零到 512 再做三次变换）——于是
`assessAtomicPhase` 那一格从 1.4 秒涨到**超过 vitest 缺省的 5 秒**，
整份测试 45 秒且两格红。换成 256 之后**帧更大而整份回到 9 秒**。

这不是优化：一个因为超时而没跑完的测试，与一个绿的测试，
**在汇总行上长得不一样但同样没有验到东西**（批 3d 那条「挂住 ≠ 通过」的另一面）。
顺带把 `assessAtomicPhase` 那一格拆成**一格一个 `it`** —— 红的时候直接看得出是哪一帧。

#### 五张**为某一道闸而造**的帧

| 帧 | 它一个人撑着哪道闸 |
|---|---|
| `rect_weak`（无二阶谐波 + 一个非公度杂峰） | 「这一对基矢只指标上了它自己」那条告警（要 `indexed=2` **且** `indexed_total>2`） |
| `stripe_clean`（干净正弦 + 二次谐波） | `no_independent_pair`（两个紧致的**共线**峰） |
| `stripe_loud`（同一条纹 ×150） | `peaks_not_one_lattice` 的「并且」两半同时成立，而幸存峰只有 2 个 |
| `tri_skew`（0°/62°/140° + 1.43 nm 长波） | 六重判据的 `every` vs `some`；以及谱心 7×7 抹零 |
| `noise_weak`（同一种噪声换 salt） | `detect_texture` 的信噪门（2.58 在门下，`noise` 的 5.54 在门上） |

#### ⚠️ 一格从金样里**拿掉**的：`dead_flat` 不进 `lattice_peaks`

去平面之后它只剩 float32 的量化噪声（`std ≈ 3.2e−17`），于是谱上哪两个 bin 最高
**完全由那次最小二乘的最后一位决定**（一边 SVD、一边正规方程）。
实测峰位两边一致、`power` 相对差 `3.6e−10` —— 而 FFT 自己的精度是 `3e−14`。

> 批 4a §9① 的原话：**一个答案是掷骰子的用例不是判据**，而修法是**改输入**。
> 这里的「改输入」就是把这一格从这一节拿掉 —— 它在 `measure_cell` /
> `atomic_phase` / `flatten_robust` 三节里照旧在，因为那三处的判决由**稳健量**定。

#### 还有一条**反过来**的：金样要能证明自己有鉴别力

`lattice.test.ts` 里有一格不比任何金样：把帧按相对 `1e−12` 抖一下（比
`fftRelTol(256²) ≈ 3e−14` 大三十倍），断言**峰位一个都不动**。
`argmax` 是离散判据，而「这一格的答案不是掷骰子」这件事只能这么证。

### 容差表（**每一条都写在被测件自己的 docstring 里，连同推导**）

测试里**没有一个字面量容差**。实测占比是本机 2026-09-16 量的，每一条取最坏那一格。

| 件 | 容差 | 为什么是这个数 | 实测占比 |
|---|---|---|---|
| 峰的 `kx`/`ky`/计数/标签/告警原文 | **0** | 下标与标签 | — |
| `power` | `latticePeakRelTol`，**尺度是 `‖F‖∞`** | 一次 FFT 的**绝对**误差由整幅谱的最大系数定，不由这个系数自己定 | `2.1e−2` |
| `periodNm` / `angleDeg` | `4·eps` | `hypot(整数,整数)` + 一次除法 / 一次 `atan2` | 同上 |
| `measureCell` 的每一项 | `CELL_REL_TOL = 1e−9` | 界在 `1e−13`；留四个量级是因为**这一族真正会犯的错是挑错基矢（差 2 倍）**，不是最后一位 | `5.8e−5` |
| `frame_texture` | `TEXTURE_REL_TOL = 1e−9` | 一次 `fft2` + 一次 `ifft2` + 一次 `mean(band²)`（同号无相消） | `1.4e−5` |
| `flattenRobust` | `flattenAbsTol`（**绝对**） | 去背景是相消 ⇒ 尺度是**基座**不是残差；主项是正规方程形成 `AᵀA` 的 `n·eps`，**不是 κ** | `1.1e−4` |
| `detectTexture` 的 `T` | **0** | 它是 bin 下标 | — |
| `detectTexture` 的 `snr` | `BAND_PEAK_REL_TOL = 1e−9` | 同 `CELL_REL_TOL` 的理由（离散判据的裕度） | `5.0e−4` |
| `detrend32` | `DETREND_ULP_TOL = eps32` **+ 一条结构性断言** | 输出是量化过的 float32，量化前的差额只有 ulp 的 1/11 | — |
| `fftSharpness` | `8·eps32·sharp` | 单精度 FFT 的本底 `eps32·‖F‖∞`，而 `median ≈ peak/sharp` ⇒ **容差随锐度线性放大** | `2.9e−2` |
| `angularConcentration` / `orderRatio` | `CONC_REL_TOL = 1e−9` | 同上 | `8.0e−4` |
| `superstructureTest` 的幅值 | `coherentAbsTol`（**绝对**） | 相消三个量级 + numpy 走 BLAS（**没有可照抄的累加顺序**） | `3.7e−7` |
| `npSum` / `npMean` / `npStd` / PCG64 四层 | **0** | 累加顺序照抄；PCG64 全是整数运算 | 0 |

### `spec/golden/numerics.json`（+2 节，diff **纯插入**）

按 `numerics-3.md` 第六节第三条：新节全部追加在 `export_numerics.py` 末尾，
而且这两节**不消耗那条共用的 `rng` 流**（输入是闭式的 `sin`）——
于是 `git diff` 是 6387 行插入、1 行删除（那一行是我改的 `_note`）。

---

## 5. stmsim e2e（**0 条，而且不该有**）

四个技能**一次 Nanonis 调用都不发**，读的是磁盘上的 `.sxm`。在模拟器上跑它们，
跑的是我自己合成的那份字节，而那份字节已经被旧仓亲自读过一遍了
（批 4a 同一条理由，那边九个里八个也没有）。

⚠️ 这与「stmsim 没有那个模块 ⇒ 只对 SpecEchoServer 做 e2e」不是同一种情况：
那种是**模拟器缺能力**，这种是**技能不碰仪器**。

`skill_traces.json` 里这四个录到的是「文件不存在」那一支（导出器的 `_params_for`
给不出真实的 `scan_path`）—— **那仍然是一条判据**（外壳在碰任何东西之前先拒），
但这一批的主判据在 `lattice.json` 的 `skills` 节，那是拿**真的合成 `.sxm`**
喂进旧仓四个技能录的 **37 格**。

---

## 6. 没做完的（逐条，卡在哪个**函数**上）

| 技能 | 卡在哪个函数 | 规模 / 性质 |
|---|---|---|
| **`AssessAtomicPhase`** | `mast.core.sample_facts.resolve_substrate` → `mast.knowledge.lookups.get_constants` / `match_material`，以及 `mast.logging.experiment_log.get_active_log` | **C 档，不是 B 档** —— 见 §8。它**每一条路径都调** `resolve_substrate`（`expected_a_nm` 给了也调），拿不到知识库就给不出 `substrate_source` |
| **`AssessHerringbone`** | 同上（`_resolve_prior` → `resolve_substrate` → `facts.reconstruction_period_nm`）。判据本体 `vision/herringbone.py` 的七个函数**倒是自足的**（≈450 判据行，纯 numpy） | 同上。**先移知识库那一层，这个技能就只剩搬运** |
| **`AssessDomainPhase`** | `mast.vision.domain_reference.load_reference`（一个跨会话的**参照系存储**，`config/<dir>/` 下的 JSON + mtime 缓存）+ `domain_phase.extract_fingerprint`(237) + `ring_peaks`(82) + `classify`(85) | 判据 ≈400 行纯 numpy；存储那一半是 D-VAC-1 那一族的形状（注入）。`load_reference` 取不到时返回 `None`，`classify(fp, None)` 仍然出数 ⇒ **可以先移判据、把存储做成注入** |
| **`AssessAtomicConsistency`** | `mast.vision.lattice_multiframe.collect_observation`(54) + `_independent_pair`(47) + `angle_conditioning`(24)，外加 `assess_atomic_consistency`(110) | **纯 numpy、零外部缺口**，而且它向 K1 要峰 —— K1 已经在这里了。**这是剩下五个里最便宜的一个**，约 240 行 |
| **`FindFlatRegion`** | `seg_scale_adaptive.kde_layers`(18) → `_hist_modes`(32)（要 `find_peaks`，**已有**）+ `tilt.noise_floor` / `plane_subtract`（**已有**，批 4a 的 K2）+ `frame_validity.judge_frame`（**已有**）+ `io.mosaic.parse_xy_meta` / `px_to_m`（**已有**） | 缺口只剩 **50 行**（`kde_layers` + `_hist_modes`）。真正的成本是技能本身 **827 行**（十一个参数、`exclude_used_spots` 的会话态、`same_terrace` 的层归属） |

### 其余欠账

| 欠的 | 写在哪 |
|---|---|
| **DoD ⑦ 技能卡片** | 本仓**还没有** `scripts/gen-skill-cards.ts`（PLAN §6.2 列了，从没建过）。批 3g–4a 同样没做，这一批照旧 |
| `find_lattice_peaks` 的 `incomplete_frame`（有效像素 < 50%） | **一格金样都没有**：`.sxm` 里的未扫区是**零**不是 NaN，于是 `isfinite` 恒真。要走到它得喂一份带 NaN 的活体帧，而这一批没有活体帧的消费方 |
| `AssessAtomicResolution` 的 `coverage < 0.5` 闸 | 同上，而且它是**技能层**的第二道（`assess_atomic_phase` 里那道裁行的已经有 `half` 在验） |
| `measureCell` 的 `singular_basis` / `combineUpDown` 的 `*_sd`（≥2 帧的帧间散布） | 都要「同一方向 ≥2 帧」的用例；本批每个方向只给了一帧 |
| `lattice_calibration` 的**定标**那一半（`solve_affine` / `calibrate_from_lattice` / `calibrate_up_down`） | 没移。它要 `scipy.optimize.fsolve` 的多分支求根（盘点记的 98 行），消费方是 `CalibratePiezoFromLattice` / `CalibratePiezoMultiAngle` —— **不在这一批的名单里** |
| `frame_texture` 的 `directional_bandpass(angle=null)` 整环那一路 | 没有消费方（`lattice_amplitude_pm` 永远传角度）。消融精神 |
| `superstructure_test` 的 `fractions` / `n_controls` / `seed` 三个参数 | 实现了但金样只走缺省。要验它们得先有一个传非缺省的消费方 |

---

## 7. `numerics` 这一轮我动了什么（**这一轮没有别人动它**）

| 件 | 动作 | 理由 |
|---|---|---|
| `pairwise.ts` | **新增** | 数值原语：它对的是 `np.add.reduce` 本身，不是本族的判据 |
| `pcg64.ts` | **新增** | 同上，对的是 `np.random.default_rng` |
| `index.ts` | +2 行 re-export | —— |
| `numerics.test.ts` | +81 行（5 条） | 追加在末尾 |
| `rng.ts` | **只改抬头** | 那句「复现它要实现一个 128 位状态的 LCG」现在有了下文；**实现不换** |
| `export_numerics.py` / `numerics.json` | +2 节，**追加在末尾** | `numerics-3.md` 第六节第三条 |

**`vision/nd.ts` 一个字节都没动。** 批 4a §7 那张「建议搬进 numerics」的表
（`npMedian` / `nanMedian` / `gradient2d` / `std32` / `autoRange`）**仍然照原样待着** ——
这一批新增了两个消费方（`lattice-peaks` 用 `npMedian`、`atomic-phase` 用
`nanMedian`/`nanStd`），也就是说那张表的「有没有第二个消费方」这一列现在更硬了。
搬不搬还是主线决定。

---

## 8. 我核出来与 `survey-remaining.md` 不一样的地方

| 盘点说 | 实际 |
|---|---|
| **B 档缺件表**：`find_peaks` 一件解锁 **7 个**，含 `AssessAtomicPhase` · `AssessHerringbone` | **那两个不是 B 档，是 C 档。** 它们各自在**第一行**就调 `mast.core.sample_facts.resolve_substrate`，而那一条通到 `mast.knowledge.lookups`（一个 30570 行的知识库包 + 一份 17 MB 的 `material_coverage.json`）与 `experiment_log` 的样品记录存储。`find_peaks` 补上也解不开它们 |
| §3.3「晶格判据底座 ≈950 行，**外部缺口只有一个 `find_peaks`**」 | 行数属实（本批落地 3071 行 TS，含注释与容差推导）。「只缺 `find_peaks`」也属实 —— 但**还缺一个没人提的**：`superstructure_test` 要 `np.random.default_rng`，而那在本仓当时是「复现不了」的（`rng.ts` 抬头与 `export_analysis.py` 抬头都这么写着）。这一批把它实现了 |
| **A10/A11**：`AssessScanTexture` / `MeasureLatticeCell`「与 A10 共用 `measure_cell`，移一次解锁两个」 | ✔ 完全属实。而且这一条是全盘点**最准**的一句：两个技能确实一次就下来了 |
| §3.3「`atomic_phase.py:650-665` 那两条判据的**咬合关系**必须连同用例一起搬」 | ✔ 属实，而且比它说的更要紧：**只搬代码不搬用例，两条闸里有一条会静默失效**。本批第一轮的 `phase-radius-cv-uses-all-maxima` 正是绿的 —— 代码搬对了，而没有一格金样走得到它（修法见 §3） |
| **优先级 4**：K1 `find_lattice_peaks`(139) + `_is_ridge_point`(85) + `_plane_subtract`(12) ≈ 380 行连 `measure_cell` | ✔ 属实。⚠️ 但 `_plane_subtract` **不要重写一份**：批 4a 的 `lstsqPlane` 已经解决了「裸 `[x,y,1]` 的 κ 在 10³ 量级、正规方程把它平方」这件事。第一版我在 K1 里自己写了一份，代价当场可见 —— `half` 那一帧上一个脊点的 `|F|` 与 numpy 差 `2.4e−22`，**是 FFT 自己精度的 42 倍**，而那个差额根本不是 FFT 的 |
| `builtins.atomic_lattice` 在 A/B/C 表里没单独出现 | 它有**三个**技能，第三个是 `CalibratePiezoFromLattice`（要 `solve_affine` 的 fsolve 多分支求根）。所以**这个模块这一批到不了 complete** —— 落地的是 2/3 |

---

## 9. 值得进课时的四件

### ① 「相对容差」这个词在这一层要先问一句：**分母是谁**

批 4a 立的规矩是「按 `max|want|` 归一，不逐元素相对比」。这一批把它推进一步：
**同一个字段，它的尺度可能不在这个字段里。**

`find_lattice_peaks` 的 `power` 是 `|fft2|` 的一个元素。一次 FFT 的**绝对**误差由
`‖F‖∞` 定 —— 一个比主峰小五个量级的脊点，它的绝对误差**和主峰的一样大**。
第一版拿「这批脊点自己的最大值」当分母，于是 `stripe` 那一格超差 9.4 倍；
换成「这一帧谱的最大系数」（随金样录）之后占比 `0.008%`。

同一条在别处也成立：`flattenRobust` 的尺度是**基座**（1e−9）不是残差（1.7e−10），
因为去背景是一次相减；`superstructureTest` 的尺度是 `Σ|hw|/wsum`，因为那个和相消了
三个量级。

> 一句话：**先问「这个数的误差是谁给的」，再问「那个人有多大」。**

### ② 一道闸可以**被另一道闸挡住**，于是它永远不做决定

五条绿变异里有三条是这个形状，而它们在覆盖率上**全是 100%**：那几行跑到了，
只是每一次都给出同一个答案。

* 谱心 7×7 抹零 —— 默认搜索带的最小半径够不到那个方块；
* `detect_texture` 的信噪门 —— 每一帧要么远超、要么压根没有带内峰；
* 六重对称的 `every` —— 三个夹角要么全在容差里要么全不在。

覆盖率告诉你「那一行跑到了」，告诉不了你「那一行**做过一次决定**吗」。
**变异演练是唯一问得出后者的工具**，而它给出的那张清单（「哪一道闸没有输入」）
是别的办法列不出来的。

修法一律是**造一格专门的输入**，而且那一格要长成「两种候选各占一边」的样子 ——
`tri_skew` 的三个夹角取 63.4 / 78.4 / 38.2，**恰好一个**在 60°±8° 里。

### ③ **容差的形状**可以整个不对，而它看起来完全正常

`detrend32` 的判据是「输出是一个 float32」。我给它的容差是**一个 ulp**（推导没问题：
量化前两边的差额只有 ulp 的 1/11）。而去掉那次 `Math.fround` 只把每个值挪**半个**
ulp —— 于是那条断言**永远不会红**。

问题不在那个数，在**问法**：一个「是不是」的问题，用「差多少」永远问不出来。
补的是一条结构性断言：`v === Math.fround(v)`，零容差。

> `numerics-3.md` 第四节那条「一条推不出来的容差宁可不写」说的是数值太松；
> 这一条是它的另一面：**一条推得出来的容差，也可能在问错的问题。**

### ④ 一个「复现不了」的结论要定期重新问一遍

`rng.ts` 的抬头、`export_analysis.py` 的抬头、`export_numerics.py` 的 `_note` ——
三处都写着「TS 复现不了 numpy 的 PCG64」。那句话写下时是对的（本仓那时不需要它）。
这一批需要它了：`superstructure_test` 的三态判决就是「候选 ÷ 那 8 个空白对照的最大值」，
**对照抽在哪儿决定了结论**。

实际代价：**195 行，一次写对**（pool / state / raw / uniform 四层与 numpy 逐位相同）。
而绕开它的代价是这个技能的默认路径（`superstructure=True`）永远对不上。

判断标准不是「难不难」，是 **`D-VISION-1` 与 `D-SUPER-1` 的那条分界**：
**对面有没有一个被比的答案。** 有就追，没有就别追 ——
RANSAC 的抽样序列到今天仍然不追 numpy，而那一条也写进了 `rng.ts` 的抬头。

---

## 10. 给合并方的提醒

- **只动了锚点**：`l0/index.ts` 三处 `批 4b` · `gen-skill-specs.ts` 的 `BATCH_4B` ·
  `export_skill_traces.py` 的 `BATCH_4B` · `kernel/src/index.ts` 的 `批 4b` ·
  `mutations.ts` 的 `批 4b` · `spec/deviations.md` 的 `批 4b` 注释锚点。
  **`3g`–`4a` 一个字没碰。**
- **锚点之外动过的共享文件**（都是加一行 / 追加在末尾）：
  - `packages/host/vision/src/index.ts` —— 末尾一个 `批 4b` 注释 + 六行 `export *`；
  - `packages/host/numerics/src/{index.ts,numerics.test.ts,rng.ts}` ——
    这一轮 numerics **没有别人动**（任务书原话），两件新原语 + 抬头更正；
  - `tools/spec-export/export_numerics.py` 与 `spec/golden/numerics.json` ——
    **两节全部追加在末尾**，diff 是 6387 插入 / 1 删除（那一行是 `_note`）。
- **`tsconfig.json` / `vitest.config.ts` / `pnpm-lock.yaml` / `export_analysis.py` /
  `analysis-common.ts` / `nd.ts` / `plane.ts` / `frame-validity.ts` 全部原样。**
  `vision` 包是批 4a 建的，依赖与 project reference 都已经在。
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑；
  合并后请**统一再跑一次**：
  ```
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  node scripts/gen-skill-specs.ts
  node scripts/build-progress.ts
  ```
- `spec/golden/lattice.json` 与 `tools/spec-export/export_lattice.py` 是本支线独有的
  新文件，不会冲突。重跑逐字节相同（md5 两次一致）。
- ⚠️ 合并之后**把 68 条变异再跑一遍**：它们里有 9 条打在 `vision/` 与 `numerics/` 的
  共享件上（`nd.ts` 的 import 别名、`pairwise.ts`、`pcg64.ts`），
  别的支线如果动了那几个文件，`find` 串会不再唯一命中 ⇒ 判 `inconclusive`。
