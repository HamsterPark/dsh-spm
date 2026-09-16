# 批 4a 交接 —— 分析技能第一批（**9 / 11**）+ 一个新包

**落地 9 个技能 / 9 个模块**，外加一个新包 `packages/host/vision`（分析判定件）
与两件留在 `kernel` 的零 numpy 判据。

技能 **329 → 338**（分母 515），模块 **50 → 59**（分母 165），
测试 **4034 → 4179**（另 40 → **43** 条集成）。

| 组 | 技能 | 共用的底层件 |
|---|---|---|
| 掩膜 / 团簇 | `ExtractClusters` · `AssessClusterRoundness` · `SelectPokedCluster` · `VerifyAdatomAt` | `parseXyMeta` + `pxToM` + `acquiredRowMask` + `assessMask` 一族 |
| 平面族（K2） | `MeasureStepHeight` · `AssessFrameTrust` | `noiseFloor` + `lstsqPlane` + `fitPlaneRobust` + 两个 `planeSubtract` |
| 各自自足 | `LocateStepEdge` · `AssessAtomicLines` · `AssessFrameCorrugation` | `vision/step_edge` 179 · `vision/atomic_lines` 202 · `corrugation_gate` 259 + 阈值表 |

**没做的两个**：`AssessScanTexture` · `MeasureLatticeCell`（晶格 `measure_cell` 组）——
理由与剩下的清单在 §6。

---

## 0. 一句话

> **这一层每一个错都长成「一个合法的数」的样子**，所以这一批花在
> 「判据写在它们被算出来之前」上的力气，比花在写实现上的多。
> 而它逼出来的**不是**容差，是四次「**这一格的答案是掷骰子**」——
> 那四次都改的是**输入**，不是那个数。

---

## 1. 为什么多了一个包（`dsh-spm-vision`）

`kernel` 是零依赖的纯域核心，而 **`numerics` 依赖 kernel**（`pySum` 住在 `si.ts`）。
所以 kernel 用不了 numerics —— 一个需要 `labelConnected` / `fft` / `histogram` 的判据
放进 kernel，只能靠**再写一份**，而那正是本仓「十份 `cell()`」那一课要避免的东西。

先例现成：`nanonis-files` 也因为同时要 kernel 与 numerics 而单独成包。

留在 `kernel` 的是**零 numpy** 的那两件（旧仓 `corrugation_gate.py` 259 行连
numpy 都没 import）：

```
packages/host/kernel/src/corrugation-gate.ts        起伏门（四态 + 判定顺序）
packages/host/kernel/src/scan-prep-thresholds.ts    它的阈值 profile（只两个字段，见 D-SCANPREP-1）
```

新包共 12 个文件，**零 dsh 依赖、零 I/O**；`nanonis-files` 只是**测试**依赖
（金样里录的是 `.sxm` 的字节，解回帧的那一份读法不归这一层）。

---

## 2. 该登记成 deviation 的（**编号留空 —— 我按 `D-VISION-*` 等临时编了，主线改**）

已按本仓体例写进 `spec/deviations.md`（新增 8 条，共 95 条）：

| 临时编号 | 一句话 |
|---|---|
| **D-VISION-1** | `fit_plane_robust` 的 RANSAC 不与 numpy 逐位一致 ⇒ 判据分两层（定死内点集那一格逐位比，抽签那几格按「平面在帧上差多少」） |
| **D-VISION-2** | `numerics.median` 是 `np.percentile(50)`，**不是** `np.median`（偶数长度差最后一位） |
| **D-VISION-3** | `judge_frame` 的 `std` 走 **float32**，而那不是精度问题 —— 它**翻分支** |
| **D-ADATOM-1** | `VerifyAdatomAt` 的 `min_peak_height_m` 在旧仓把候选**全滤光**（读错了键），报 `not_found` |
| **D-ATOMLINE-1** | 「按信号名找 Z」那一支在旧仓是**死的**（`first_values` 取的是整个 body） |
| **D-SCANPREP-1** | 阈值 profile：外部 JSON → 注入；22 个字段只移**有消费方的那 4 个** |
| **D-SCANART-1** | `detect_scan_artifacts` 只移 `bad_row_frac` 那条路（19 行）；`_drift_px` 尤其别顺手补 |
| **D-CLUSTER-1** | `AssessClusterRoundness` 读**裸块**（不经几何归位）—— 照移，**没修**，欠账写在代码抬头 |
| **D-ANALYSIS-1** | 六个读 `.sxm` 的技能里只有一个报文带异常类名；操作系统那句错两侧都归一化成 `<oserror>` |

⚠️ **D-ADATOM-1 / D-ATOMLINE-1 是本批仅有的两处「本仓更严」**，两处各有一组
专门的测试（不是靠容差让它过去），而且**旧仓那一侧也钉住了** ——
差异消失时那条登记会当场变红。

---

## 3. 变异演练（**37 条，全部实跑到 red**）

```
node tools/mutate/run.ts <id…>      # 一条一条
pnpm vitest run --project mutation  # 全部（约五分钟）
```

| id | 拆掉它，系统重新犯哪一次错 |
|---|---|
| `frame-row-mask-is-the-whole-row` | 「已扫完」判成「有任何有限值」⇒ 正在扫的那一行进来，任何平面拟合碰一个 NaN 就整幅 NaN ⇒ 24 张里 11 张报「flat or unreadable」，而它们的起伏是 11.5–502.5 pm |
| `frame-zero-rows-are-not-data` | 活体缓冲里的**全零行**当成真数据 ⇒ 半张图按整帧判，实测 162.4 对 818.4（差 5 倍） |
| `frame-dead-flat-second-gate-is-a-ratio` | 带倾斜的死平帧（残差 2e-15 而不是 0）过关 ⇒ 下游去修一根好针尖 |
| `frame-dead-flat-std-is-float32` | `std` 改在 float64 里算 ⇒ 同一张帧改走第二档，**报的是另一句话** |
| `np-median-is-not-percentile` | 换成 `percentile(50)` ⇒ `noiseFloor` 与旧仓在最后一位分岔，而那条写的是容差 0 |
| `plane-inlier-threshold-is-adaptive` | 内点阈写死 100 pm ⇒ RANSAC 退化成普通最小二乘，台阶被当斜坡减掉（实测低估 30–51%） |
| `plane-zero-noise-floor-has-a-fallback` | 噪声底为 0 时没有退路 ⇒ `\|r\| < 0` 永不成立，一个内点都找不到 |
| `plane-refits-on-all-inliers` | 拿三点解当结果 ⇒ 平面由三个带噪的点定 |
| `cluster-line-leveling-is-refused` | 逐行平场放进来 ⇒ 575px/1531pm 的团簇被打成 508px/1329pm，还凭空多一个 717px 伪影 |
| `cluster-axes-are-full-length` | 少乘那个 4 ⇒ 尺寸低报四倍，把「还不够小」说成「已经很小了」 |
| `cluster-covariance-is-in-metres` | 协方差在像素里算完再乘 ⇒ 非方像素上悄悄错（长轴不一定沿 x） |
| `xy-meta-angle-known-is-a-flag` | `angle_known` 恒真 ⇒ 转过的图被当成轴对齐，而调用方拿那个坐标去移动针尖 |
| `xy-meta-rotates-around-the-centre` | 少一次绕中心旋转 ⇒ 30° 的图上坐标落在别处 |
| `roundness-subtracts-the-pixelation-floor` | 不减 floor ⇒ 固定阈值系统性判小团簇「不圆」（6 倍量程差全是像素化） |
| `roundness-small-blobs-are-undecidable` | A<20 px 也给个数 ⇒ 一个完美的圆读出 0.64 的轴比 |
| `roundness-background-is-the-mode` | 背景取 mean ⇒ 被团簇自己拉走，自指阈值的病根 |
| `step-levels-min-sep-keeps-shoulders-out` | 峰间最小间距放开 ⇒ 同一台面的肩部成了第二个台面 |
| `step-edge-direction-is-double-angle` | 不用倍角平均 ⇒ 梯度两侧相反、互相抵消，方向是噪声 |
| `step-edge-not-straight-is-undecidable` | 不直也报 ⇒ 整排谱落在错地方，**而每条谱都会「成功」** |
| `step-edge-box-cumsum-order` | 两次 cumsum 顺序换 ⇒ 候选像素数差 2 个，而那是容差 0 的一档 |
| `row-jump-is-mad-not-std` | 主指标换标准差 ⇒ 被沿慢轴的真实台阶骗（156.19 对 0.51） |
| `big-jump-needs-both-conditions` | 只留倍数 ⇒ 极干净的帧把普通噪声数成跳变 |
| `line-score-says-it-cannot-tell` | 算不出时回 0 ⇒ 下游读成「测了，没有」 |
| `advisory-uses-the-median` | 线级统计换均值 ⇒ 一条坏线把结论拽走 |
| `corrugation-threshold-pair-is-atomic` | 拿 profile 补另一半 ⇒ 两次不同标定的数拼成一个判据 |
| `corrugation-no-threshold-is-undecidable` | 没上限当放行 ⇒ 没标定过的机器上每一帧都报 normal |
| `corrugation-scale-is-never-converted` | 放宽尺度门 ⇒ 100 nm 上标的阈值拿去判 10 nm 的帧 |
| `scan-prep-unknown-profile-says-so` | 回落不说 ⇒ 悄悄用另一套阈值算完再报一个数 |
| `select-out-of-tolerance-abstains` | 够不着不弃权 ⇒ 把「最近的东西」当成新扎的那个交出去 |
| `select-thresholds-are-not-guessed` | 补默认值 ⇒ 一个未标定的工作点被当成「系统推荐」 |
| `roundness-retired-param-is-refused` | `round_threshold` 静默别名 ⇒ 漏改的 0.65 把闸门放宽到「长短轴差 35%」 |
| `adatom-frame-block-is-where-the-geometry-is` | 到顶层找几何 ⇒ 这道检查**静默地永远不跑** |
| `atomline-z-channel-is-not-guessed` | 猜一个 30 ⇒ 对不齐的回包报成 `response layout mismatch`，把人送去查解析器 |
| `atomline-scale-is-not-guessed` | 猜一个尺度 ⇒ 别人改了视野之后安静地按错的尺度找周期 |
| `frame-trust-needs-100-finite-px` | 不足 100 个有限像素也给分 ⇒ 「判不了」变成「针尖坏」 |
| `step-height-does-not-normalise-to-d111` | 按 d111 归一 ⇒ 任何数都变回 d111，自我实现不是测量 |
| `corrugation-rel-tol-zero-is-a-threshold` | `rel_tol = 0` 被 `\|\|` 吃掉 ⇒ 最严那档退化成 5%（**D-ZERO-1 第六次**） |

### ⚠️ 「一条编不过的变异」第十五~十九次

第一轮 37 条里 **6 条 inconclusive**，其中 **5 条是同一个形状**（把某道闸改成
`if (false && …)` ⇒ TS 判那一支不可达、**连带撤掉上面那道 `null` 早退带来的收窄**）：

```
analysis-lines.ts(125,16): TS18047: 'buf' is possibly 'null'.
analysis-lines.ts(176,18): TS18047: 'out.widthM' is possibly 'null'.
corrugation-gate.ts(208,25): TS18047: 'thisNm' is possibly 'null'.
plane.ts(293,19):           TS18047: 'refined' is possibly 'null'.
```

修法两种，都在代码里留下了注释：

1. **提一个有声明返回类型的函数** —— `readableChannels(buf, body): number[] | null`、
   `nmPerPixel(w, px): number | null`、`refitOnInliers(...): RobustPlane | null`。
   顺带把变异改成「**猜一个**」而不是「拆掉判断」：`?? [30]` / `?? 5e-9` ——
   那正是被挡住的那件事本身；
2. **打在那个数上**（同 `readback-uses-tolerance`）——
   `LEVELS_MIN_SEP_PM = 110 → 0`、`> tol → > tol + 1e9`。

第 6 条是另一个形状：`TS6133 'minSep'/'dm' is declared but its value is never read`
（把一整个表达式换掉之后，某个形参/局部变量没人读了）。修法是**把它留在表达式里**：
`nanStd(d)` → `nanStd(d.map((v) => v - dm))`。

### 还有**三条一开始是绿的** —— 而绿的意思是那道闸不存在

| 变异 | 为什么绿 | 怎么修的 |
|---|---|---|
| `frame-dead-flat-second-gate-is-a-ratio` | 金样里没有一格走得到第二档 | 加一张**斜得够的**死平帧（倾斜 0.25 nm → 8.9 nm，比值从 4e-7 掉到 3e-8） |
| `frame-dead-flat-std-is-float32` | 所有帧都走 `.sxm`（float32 量化噪声 ~1e-16，撞不到下溢门槛） | 加一格**不走 `.sxm`** 的 float64 帧（只有活体帧撞得到这一条） |
| `frame-trust-needs-100-finite-px` | 金样里没有小于 100 个像素的帧 | 加一张 8×8 的 `.sxm` |
| `corrugation-threshold-pair-is-atomic` / `-no-threshold-is-undecidable` | 内建 profile 两个键都是 `null`，「拿 profile 补另一半」补的是 `null` | 导出器写一份**标定过的**外部 profile（10 nm 上的 40 pm），两侧各喂一份 |

> **一条变异跑出绿色，说的不是「这个变异不重要」，是「这条闸不存在」**
> （`numerics-2.md` 第六节那句话的第四次）。这一轮它指出来的全是**金样缺一格**，
> 不是代码缺一道闸 —— 也就是说：**判据在，但没有人在验它**。

---

## 4. 金样怎么来的

### `spec/golden/analysis.json`（新，3.2 MB，12 节，**重跑逐字节相同**）

```
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe \
    tools/spec-export/export_analysis.py
```

**旧仓真实的那几个函数与技能真跑一遍**（`mast.vision.*` + `mast.skills.builtins.*`）。
十二节：`condition_numbers` · `xy_meta` · `frame_validity` · `np_median` · `plane` ·
`roundness` · `topography` · `lines` · `corrugation_gate` · `sxm_files` ·
`atomic_lines_stubs` · `skills`。

三条纪律：

1. **输入与答案一起录**，而合成用的是**一个闭式公式，不是随机数** ——
   于是「重跑逐字节相同」不依赖任何种子，也不依赖 numpy 的 PCG64；
2. **技能那一层录的是 `.sxm` 的字节**（base64，11 份），不是解析出来的数组。
   字节我们合成，**读法归旧仓** —— 两端都由我写的话，我对格式的同一个误解会
   严丝合缝地对上而东西是错的（同 `export_nanonis_files.py` 抬头）；
3. 墙钟与随机数一概不进；`MAST2_PROJECT_ROOT` 指向临时目录。

#### ⚠️ 第一版的帧是**两边各按同一个闭式重建**的，而那是一处没人在看的差异

`noiseFloor` 在 128×128 的台面帧上分岔了 `4.4e-14` 相对 —— 而那一条我写的是**容差 0**。
查下去不是 `sin` 的实现差异，是**加法的结合顺序**：numpy 先把
`tilt = 0.8e-12*j + 0.3e-12*i` 算成一个数组再加，TS 那边写成三次连加。
数学上相同、浮点上不同。

改成**从字节读回来**之后这一整类消失（float32 的字节两边读出来逐位相同），
而且那也正是技能在真机上看到的那一份。

> 「两边各自重建同一个输入」本身就是一处没有人在看的差异。

### `spec/golden/skill_traces.json`（+9 个技能，+329 行）

九个里**八个只读文件**，而那台导出器的 `_params_for` 给不出一条真实的 `scan_path`，
于是它们在那边录到的是「文件不存在」那一支，一次 TCP 都不发。
**那仍然是一条判据**（外壳在碰任何东西之前先拒），但不是这一批的主判据。

`AssessAtomicLines` 是九个里唯一跟仪器说话的，它在那边录到的是**真的**动词序列
（`Scan_BufferGet` → `Signals_NamesGet` → `Scan_FrameGet` → `Scan_FrameDataGrab`）
外加注错点派生的五条。

### 容差表（**每一条都写在被测函数自己的 docstring 里，连同推导**）

测试里**没有一个字面量容差** —— 全部引用被测件导出的那个函数/常量。

| 件 | 容差 | 为什么是这个数 |
|---|---|---|
| `acquiredRowMask` / `labelConnected` / 计数 / 下标 / 词表 / 字符串 | **0** | 掩膜、标签、行程 —— 整数与搬运。给容差等于把「挑错了元素」藏起来 |
| `noiseFloor` | **0** | 一次差分 + 两次取中位数，全是闭式 |
| `dispersionOfMask` 的边界掩膜 | **0** | `mask & ~binary_erosion` 只搬布尔位 |
| `badRowsFrac` | **0** | 它是**整数比**（`k/nRows`） |
| `lstsqPlane` / `fitPlaneRobust` 的系数 | `lstsqObservedTol(κ)` | 本仓**中心化之后**走正规方程（κ≈1，误差 `eps`），numpy 走 SVD（`κ·eps`）—— **大的那一边是 numpy**。κ 随金样录 |
| `dispersion` / `floor` / `excess` | `sumRelTol(n)` | 一次 `std/mean`；本仓 `sum` 是 Neumaier、numpy 是成对求和（D-NUM-1） |
| `axisRatioFromDispersion` | `Q_STEP/2`（=5e-4，**绝对**） | 它是在 981 格上插值的结果；半格 = 「不许挑到隔壁那一格」 |
| `corrugationRmsM` | `8·eps32·log₂n` | numpy 对 float32 用成对求和；系数 8 是 3 倍余量（`sumRelTol` 同一条推导，`eps → eps32`） |
| `lineSnr` | `4·lstsqRelTol(κ_u) + fftRelTol(n)` | 功率是幅度的平方（误差 ×2），比值再 ×2 |
| RANSAC **下游**（`plane` 的系数 / `rms` / `pv` / 台面位置） | `RANSAC_REL_TOL = 1e-3` | 内点集在带边缘差 Δn 个点，每点残差 ≤ `3σ` ⇒ 相对变化 `~(Δn/n)·3σ/量程`（实测 4.7e-5，20 倍余量） |
| 逐行统计量（`row_jump_mad_pm` 等） | `ROW_JUMP_REL_TOL = 0.05` | 平面斜率一变，行中位数会**跳到相邻的次序统计量**（间距 ~0.17 pm，MAD 才 1.4 pm）⇒ 几个百分点。实测 1.5%，3 倍余量。**而分档线在 40/250 pm 上，离它 29 倍** |

#### 「做得到逐位就不要给容差」这条，在这一层的代价是**改输入**

四次「这一格的答案是掷骰子」，四次改的都是输入而不是那个数：

| 撞上的 | 为什么是掷骰子 | 改了什么 |
|---|---|---|
| `locate_step_edge` 的 `n_edge_px`（228 对 226） | 一道边的候选像素是**等宽的带**，投影直方图在带宽上是平的 —— top4 = `116/115/99/96`，冠军只领先 **1 个计数** | 换成**两道平行台阶**（一道只占上半幅）⇒ top4 = `333/255/199/197`，领先 1.31 倍。**这一步本来就是给若干条平行台阶分簇用的，一道边上它没有东西可分** |
| `fit_plane_robust(sigma=20pm)` | 「沿楼梯斜穿的平面」与「一整条台面」内点数相当 | **删掉那一格**。一个答案是掷骰子的用例不是判据 |
| `lineScore` 在**常数线**上的峰位与 SNR | 去趋势后只剩舍入（1e-25），谱峰由两边各自的舍入决定 | 加一格 `noise_row`（宽带无主频，峰位由真实结构定）；常数那一格只比**结构字段**，并写明为什么 |
| `MeasureStepHeight(sigma=None)` 的 `summary` | 那句话里印着 `%.2f` 的台阶高度与 `%.3f` 的内点率，被 RANSAC 抽签改掉一位 | `terraces_sigma`（内点集定死）那一格**逐字比**，替它把关 |

---

## 5. stmsim e2e（3 条，都过）

**九个里只有 `AssessAtomicLines` 有 e2e，另外八个不该有** ——
它们一次 Nanonis 调用都不发，读的是磁盘上的 `.sxm`。在模拟器上跑它们，
跑的是我自己合成的那份字节，而那份字节已经被旧仓亲自读过一遍了。
（这与「stmsim 没有那个模块 ⇒ 只对 SpecEchoServer 做 e2e」不是同一种情况：
那种是**模拟器缺能力**，这种是**技能不碰仪器**，同批 3k 的两个环境读。）

`packages/host/stm-skills/integration/analysis.test.ts` 验的是单测验不到的那件事：
`resolveReadout` 一口气问四个动词，而它对每一个回包的**形状**都有假设
（三个是「第 k 个元素是什么」），**而自己造的回包会照着假设长**。

### ⚠️ 这一组当场照出一件事：问错通道，真模拟器**不报错**

旧仓抬头写的是「会得到一个对不齐的回包，报出来是 `response layout mismatch`」——
那是关于**真机**的。在 stmsim 上它退化成另一种形状：回包解得开、拼得成二维，
但**一行都不是扫出来的**，于是技能在下一步才失败（`这一帧里没有已扫出来的行`）。

两种形状的共同点才是判据：**「我问错了通道」不会以「通道号错了」的样子出现**。
所以那句「拒绝时把缓冲里有哪些说出来」**只挂在 `Scan_FrameDataGrab` 报错那一支上**，
而真机上那一支未必走得到。这一条已经钉成测试，免得下一个人以为那句提示是兜底的。

---

## 6. 没做完的（逐条）

| 缺的 | 谁在等 | 还差什么 |
|---|---|---|
| **`AssessScanTexture`** | 本批 | `frame_texture` 三个函数（57+58+72，整份 442 行）+ `measure_cell` 链 |
| **`MeasureLatticeCell`** | 本批 | `measure_cell`(145) + `combine_up_down`(76) + `superstructure_test`(89) + `_max_over_neighbourhood`(20) + **K1 晶格峰**（`find_lattice_peaks` 139 + `_is_ridge_point` 85）+ `scale_gate`(11) |

两个合起来约 **1000 行密集 numpy**，与已落的九个**没有共用件**
（它们共用的是彼此的 `measure_cell`，而那一条链本批一行都没动）。
按「模块级完成」的标准它们是一个独立的批次，硬塞进来只会让这一批的九个
拿不到完整的 DoD。**建议单独做一段**，那时 K1 也就有了（它是晶格判据底座的一半）。

### 其余欠账

| 欠的 | 写在哪 |
|---|---|
| **DoD ⑦ 技能卡片** | 本仓**还没有** `scripts/gen-skill-cards.ts`（PLAN §6.2 列了，从没建过）。批 3g–3k 同样没有。这一批照旧没做 |
| **`AssessClusterRoundness` 读裸块** | D-CLUSTER-1。修它要先造一张 `SCAN_DIR: up` 的帧量出偏差 |
| **`_spike_frac` / `_oscillation` / `_drift_px`** | D-SCANART-1。没有消费方，不移 |
| **`ScanPrepThresholds` 的另外 18 个字段** | D-SCANPREP-1。没有消费方，不移 |
| **`VerifyAdatomAt` 的 `resolve_substrate`** | `substrateTolerance.nearestNeighborNm` 是注入点，**默认关**（= 旧仓没有衬底声明时的行为：`undecidable` / `no_tolerance`） |

---

## 7. `numerics` 那条支线要的东西（**我一个字没改 numerics**）

本批要而基线没有的 numpy 语义都落在 `packages/host/vision/src/nd.ts`，
**由主线决定搬不搬**。判断标准只有一个，而且不是「长得像不像」：**它有没有第二个消费方？**

| 件 | 建议 | 理由 |
|---|---|---|
| `npMedian`（`np.median`） | **搬**，而且要与 `median` **并存** | 整个 `mast/vision/` 都在用 `np.median`；见 D-VISION-2 —— 合并会默默改掉判决 |
| `nanMedian` / `nanMean` / `nanStd` / `nanMax` / `nanMin` | **搬** | `np.nan*` 一族，后面每个分析技能都要 |
| `gradient2d`（`np.gradient` 2-D） | **搬** | `step_edge` / `frame_texture` / `tilt` 都要 |
| `std32`（float32 上的 `np.std`） | **搬**，连同 D-VISION-3 那段理由 | 它不是「精度低一点」，它**翻分支** |
| `autoRange`（`np.histogram` 不给 range 那一路） | 搬 | `background_level` 与 `locate_step_edge` 各一处 |
| `eigvalsh2` / `interp` / `toFloat32` / `ptpFinite` | **先别搬** | 只在本包出现两三次，没有第二个消费方 |

另外：**`numerics.ransacPlane` 顶不掉 `fitPlaneRobust`**，三处语义不同（内点判据是
`<` 不是 `<=`、不认 NaN 掩膜、阈值是**算出来**的而不是传进来的），
理由写在 `vision/plane.ts` 的抬头。

---

## 8. 我核出来与 `survey-remaining.md` 不一样的地方

| 它说 | 实际 |
|---|---|
| **A4**：`cluster_roundness` 需要「`scipy.ndimage.find_objects` 等价（记 bbox）」 | **`find_objects` 是死 import**。`cluster_roundness.py:290` 导入它，函数体里**一次都没调**（与 §六第 2 条记的 `quality.py` 那个 `find_peaks` 是同一种）。本批因此没写 bbox |
| **A4**：`background_level` 的 `np.histogram(fl, bins=96)` 不给 range | ✔ 属实（`autoRange` 照移了那条 `min===max ⇒ (min−0.5, max+0.5)` 的分岔） |
| **A6**：`adatom_verify` 「只要 ExtractClusters」 | 属实，但它**还有一个真 bug**（D-ADATOM-1：读 `peak_height_m`，而交出来的键是 `peak_height_pm`）。盘点没看到它，因为那要把两个文件的键名对起来读 |
| **A12**：`atomic_lines` 「本族最干净的一个」 | 判据本体确实干净（202 行只 import numpy），但它的**外壳**压着 `_scan_readout`，而那里面有 D-ATOMLINE-1 那条死分支 |
| **A13**：`frame_corrugation` 要 `scan_prep_thresholds:resolve`(27) | 属实，但那 27 行背后是一个 **22 字段的 dataclass + 一条读外部 JSON 的路**。本批只移了有消费方的 4 个字段（D-SCANPREP-1） |
| **A7/A8**：K2 平面族 113 行「一次解锁 4 个」 | 属实。⚠️ 但 `survey` 那条「RNG 不同 …… 按 `rng.ts` 那条走，别去追 numpy」**不够**：真正的问题不是抽样序列，是**内点集在带边缘上差几个点**，而那会让下游的 `std` 差 `4.7e-5`、让 `_levels` 的峰位差一个 bin。判据要分两层，见 D-VISION-1 |
| **优先级 5** 说 `sxmFrameMeta` **不是** `parse_xy_meta` | ✔ 完全属实，而且 `angle_known` 那个旗标确实是 `SelectPokedCluster` 判 `coords_trustworthy` 的唯一来源 |

---

## 9. 值得进课时的三件

### ① 「先写下容差」这条纪律，在这一层第一次**顶不住**

数值层那一课的话是「数值代码没有红绿之分，只有容差」。这一层撞上的是它的另一面：

> **有些格子根本没有一个稳定的答案**，而给它一个容差，就是给一个掷骰子的结果盖章。

四次（§4 那张表）。四次的共同点是：**判据本身是离散的**——
「最密的是哪个 bin」「哪个台面是最大的」「谱峰在哪一格」。
一个离散判据在输入没有鉴别力时，答案由**最后一位浮点**决定，
而最后一位浮点在两个语言之间没有理由相同。

修法**不是调容差，是改输入**：让冠军领先 1.31 倍而不是 1 个计数。
而「改输入」这件事在代码里看不出来 —— 它只出现在导出器那几个合成函数的 docstring 里。

> `numerics-2.md` 说「一组分辨不出两种候选的金样，不是判据」。
> 这一批把它推进一步：**分辨不出的可以不是两种实现，而是同一个实现的两个 bin**。

### ② 一条变异跑出绿色，四次指的都是**金样缺一格**，不是代码缺一道闸

`frame-dead-flat-second-gate-is-a-ratio` / `-std-is-float32` /
`frame-trust-needs-100-finite-px` / `corrugation-threshold-pair-is-atomic` ——
四条闸都写着、都对，而**没有任何一个用例走到它们**。

三判据（落地 / 编过 / 真跑了）挡住了「没红」被当成绿，但它们说不出**为什么**没红。
这一轮的答案全是同一句：**那条路上没有数据**。

所以变异演练在这一层的产出不只是「闸在不在挡」，还有**一张「金样缺哪几格」的清单**——
而那张清单是别的办法列不出来的（覆盖率能告诉你那一行没跑到，
但告诉不了你「跑到了，而那一格的输入分辨不出对错」）。

### ③ 同一个物理量，**换一次精度就换一句话**

`judge_frame` 的两档：第一档是「去趋势后精确为 0」，第二档是「残差/峰谷 < 1e-7」。
两句话指向不同的下一步。而分它们的，是一次 `np.std` 在 **float32** 里做还是 float64 里做 ——
`1e-25` 的平方在 float32 里下溢成 0。

这不是「精度差一点」。这是：**一个量的精度是它语义的一部分**。
把 `.astype(np.float32)` 当成「省内存」或「历史包袱」顺手删掉，
会让一张废帧从「这是数据的问题，别去修针尖」变成「残差只有原始起伏的 1.8e-15」——
后者也是真话，但它不会让人停下来。

同一族里还有两处：`npMedian` 与 `percentile(50)`（D-VISION-2）、
`float32` 的 `bad_row_frac` 早退（D-SCANART-1：**那个 0 的含义是「没算」**）。

---

## 10. 给合并方的提醒

- **只动了锚点**：`l0/index.ts` 三处 `批 4a`、`gen-skill-specs.ts` 的 `BATCH_4A`、
  `export_skill_traces.py` 的 `BATCH_4A`、`kernel/src/index.ts` 的 `批 4a`、
  `mutations.ts` 的 `批 4a`。**`3g`–`3l` 一个字没碰。**
  ⚠️ `mutations.ts` 里批 3k 的 17 条实际落在 **`批 4a` 锚点下方**（主线那边就是这样），
  我把本批 37 条插在**它们前面**，没有动它们。
- **锚点之外动过的共享文件**（都是加一行，与 `numerics.md` 第六节同一组）：
  - `tsconfig.json` —— `references` 加 `packages/host/vision`
  - `vitest.config.ts` —— 别名加 `dsh-spm-vision`
  - `pnpm-lock.yaml` —— workspace link
  - `packages/host/stm-skills/{package.json,tsconfig.json}` —— 加三个依赖/引用
  - `packages/host/stm-skills/src/l0/traces.test.ts` —— `DEVIATIONS` 表末尾加两条
    （`AssessFrameTrust/ok` 的操作系统错、`AssessAtomicLines/empty@0` 的信封）
  - `spec/deviations.md` —— 末尾追加 9 条
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑；
  合并后请**统一再跑一次**：
  ```
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  node scripts/gen-skill-specs.ts
  node scripts/build-progress.ts
  ```
- `spec/golden/analysis.json` 与 `tools/spec-export/export_analysis.py` 是本支线独有的新文件，
  不会冲突。重跑逐字节相同（md5 两次一致）。
- **`packages/host/numerics/` 一个字节都没动**。本批要而基线没有的 numpy 语义
  全在 `vision/nd.ts`，清单见 §7。
