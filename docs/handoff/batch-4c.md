# 批 4c 交接 —— paper 数据处理 + 帧读一族（**12 / 12**），七个模块收口

技能 **376 → 388**（分母 515），模块 **60 → 67**（分母 165），
测试 **4472 → 4586**（另 52 → **55** 条集成）。

| 模块 | 技能 | 状态 |
|---|---|---|
| `builtins.scan_frame` | `LoadScanFrameFromFile` · `ParseRegions` · `ComputeDriftVector` | **5/5 收口** |
| `paper.data_processing` | `SubtractPlane_RANSAC` · `LevelLines_Median` · `FindEmptySpot` · `CorrectDrift_XCorr` | **4/4 收口** |
| `paper.background` | `SubtractPoly2D` | **1/1** |
| `paper.image_filters` | `Destripe_MorphOpen` | **1/1** |
| `paper.scan_crop` | `AutoCrop_UnscannedRegion` | **1/1** |
| `paper.denoise` | `Denoise_AE` | **1/1** |
| `paper.atom_jump` | `DetectAtomJump` | **1/1** |

盘点点名的两个坑**都核了、都成立**（`paper.background` 的张量积要自搭、
`paper.image_filters` 的 MorphOpen 是手写行程开运算），而第一个坑背后还藏着
第三件盘点没看到的事（§8）。

---

## 0. 一句话

> 这一族技能的 `data` 里只有形状与几个标量，**真正的产物是它写出去的那个 `.npy`**。
> 只比 `data` 等于**只比收据不比货** —— 一个把图整幅搬错一行的 destripe，
> `corrected_image_shape` 和 `stripes_removed` 一个字都不会变。
> 这一批一半的力气花在「让产物本身进金样」上，另一半花在
> **「让每一道闸在金样上真的有人走到」** —— 后者逼出了四张新图。

---

## 1. 落地的件

```
新增
  packages/host/kernel/src/scan-regions.ts        ParseRegions 的判据（零 numpy、零 I/O）
  packages/host/kernel/src/image-channel.ts       「哪一路当形貌图」的三档
  packages/host/stm-skills/src/l0/paper-common.ts      多格式加载外壳（只做 IO）
  packages/host/stm-skills/src/l0/paper-data.ts        data_processing 四件
  packages/host/stm-skills/src/l0/paper-image.ts       poly2d / destripe / denoise
  packages/host/stm-skills/src/l0/paper-crop.ts        autocrop / atom jump
  packages/host/stm-skills/src/l0/scan-frame-offline.ts  scan_frame 三件
  packages/host/stm-skills/src/l0/paper-skills.test.ts   114 条
  packages/host/stm-skills/integration/paper-drift.test.ts  3 条 e2e
  tools/spec-export/export_paper_data.py          金样导出器（新开的一台）
  spec/golden/paper_data.json                     6 节 · 1049 KB · 95 格
  docs/handoff/batch-4c.md                        本文

改（全部在预留的锚点下）
  packages/host/kernel/src/index.ts               批 4c 锚点 + 两行 export
  packages/host/stm-skills/src/l0/index.ts        批 4c 锚点三处
  scripts/gen-skill-specs.ts                      BATCH_4C 12 个名字
  tools/spec-export/export_skill_traces.py        BATCH_4C 12 个名字
  tools/mutate/mutations.ts                       批 4c 锚点 + 33 条
  spec/deviations.md                              批 4c 锚点 + 7 条（**编号留空**）
  packages/host/stm-skills/src/l0/traces.test.ts  `DEVIATIONS` 表末尾加 4 条
生成物（已按本支线重跑）
  packages/host/stm-skills/src/generated/specs.ts · spec/golden/skill_traces.json · spec/progress.json
```

**`packages/host/vision/` 与 `packages/host/numerics/` 一个字节都没动。**
本批要而基线没有的东西全落在自己的技能层文件里，清单见 §7。

---

## 2. 该登记成 deviation 的（**编号留空 —— 我按 `D-JUMP-*` 等临时编了，主线改**）

已按本仓体例写进 `spec/deviations.md` 的 `批 4c` 锚点下（新增 7 条）：

| 临时编号 | 一句话 |
|---|---|
| **D-JUMP-1** | `DetectAtomJump` 的 `method` 报的是**请求**（`cnn`）而不是真跑了哪一条；同族 `Denoise_AE` 在同一个位置上是对的 ⇒ 本仓跟对的那个 |
| **D-JUMP-2** | 统计回退的 z 分数**上限恒为 2**，而缺省阈值 3.0 ⇒ 这个技能**在缺省参数下永远报不出跳变**。照移，没修 |
| **D-DRIFT-1** | `ComputeDriftVector` 偶数边长上系统性偏一个像素（`(M−1)//2` 对 `M//2`）；**一片死平的缓冲上它报半幅**，而 `success: true` |
| **D-PAPER-1** | 四处把别人的异常拼进报文（`json` / `np.load` / reader / OS）—— 两侧归一化，判据是前半句。⚠️ 反过来一处：`images must be same shape` **照抄了 skimage 的原话** |
| **D-PAPER-2** | `load_image_2d` 只落了 `.npy` / `.sxm` / `.dat`（+ 谱的 `.3ds`）；`.npz` / `.sm4` / `.txt` **当场说清楚**。模型面的描述因此超发了，**不改那句话** |
| **D-PAPER-3** | `SubtractPlane_RANSAC` 在**带裙边**的真图上与旧仓不逐位一致（RNG 不同）。金样刻意只放定死的那一类输入，判据是「离对的近、离错的远」 |
| **D-PAPER-4** | 三处照移的钝处：`angle_deg` 在 try 外面会**抛**；`_load_image` 把三件事压成一句；`LevelLines` 认不出的 `method` 什么都不做 |
| **D-PAPER-5** | `poly2d_subtract` 那条 `i + j > order_x + order_y` 的裁剪是**死代码**（见 §8） |

⚠️ **D-JUMP-1 是本批唯一一处「本仓与旧仓说的话不同」**，它有一组专门的测试
（不是靠容差让它过去），**而且旧仓那一侧也钉住了** —— 差异消失时那条登记会当场变红。

---

## 3. 变异演练（**33 条，全部实跑到 red**）

```
node tools/mutate/run.ts <id…>      # 一条一条
pnpm vitest run --project mutation  # 全部
```

| id | 拆掉它，系统重新犯哪一次错 |
|---|---|
| `regions-size-has-a-lower-bound` | 一个 1 pm 的「区域」过关，而 composite 会照着它去配置扫描 |
| `regions-max-is-a-limit` | 几千个区域排成几千步计划 —— 一次谁都停不下来的批扫 |
| `regions-missing-field-says-which` | 模型只知道「有个字段不对」，而它手上有六个字段 |
| `regions-non-numbers-are-refused` | `null` 静默变成 0，报的却是「尺寸越界」而不是「类型不对」 |
| `image-channel-looks-for-topography` | 退到「第一路」，而第一路常常是电流 —— 量出来的数完全正常，只是量的是另一个物理量 |
| `image-channel-current-is-not-topography` | 一个叫 `Z current` 的通道顶掉真正的 `Z` |
| `ransac-refits-on-all-inliers` | 结果由三个抽到的点定，而抽到哪三个两个 RNG 不一样 |
| `level-lines-median-is-np-median` | `np.median` 换成 `percentile(50)` ⇒ 每一行减的那个数差最后一位（D-VISION-2） |
| `level-lines-unknown-method-does-nothing` | 一次打错的方法名变成一次静默的平场，而返回值里那个 `method` 仍是打错的那个 |
| `empty-spot-empty-cells-stay-infinite` | 「这一格里一个像素都没有」变成「完美平坦」，而下游会去那儿扎针 |
| `xcorr-window-removes-dc` | 零频比任何结构都大几个数量级 ⇒ 峰永远在原点 ⇒ 漂移永远是 0 |
| `xcorr-nonfinite-pixels-are-filled` | 一个 NaN 穿过整个 FFT，而 `argmax` 会给一个完全合法的下标 |
| `poly2d-design-matrix-is-a-tensor-product` | 9 项变 6 项 —— 缺的那几列不报错，只把一层衬底留在图上 |
| `poly2d-mask-excludes-those-pixels` | 分子自己定义它脚下的衬底 |
| `destripe-soft-needs-a-hard-neighbour` | 一条孤立的、略高于软阈的行被当成仪器毛病换掉，而它多半是真形貌 |
| `destripe-short-runs-are-opened-away` | 一条**单行**的偏移（多半是个台阶）被插值抹平 |
| `destripe-interpolates-between-neighbours` | 权重反过来 ⇒ 图仍然「去过条纹」，只是那几行的形貌是倒着的 |
| `destripe-dead-flat-threshold-is-tiny` | 每一张图都从早退里出去，而返回值仍然说「我看过了，零条纹」 |
| `denoise-noise-is-what-was-removed` | `noise_estimate` 变成形貌的起伏，而它的名字说的是噪声 |
| `crop-block-threshold-is-a-fraction` | 每个块都过 ⇒ 整幅被判成「没扫到」，再被保险一刀不切 —— 两次错误互相掩护 |
| `crop-refuses-to-crop-everything` | 容差松一点就能把整张图切成 0×0，而 `cropped: true` |
| `crop-iterates-until-nothing-is-left` | 第二条边留在图上，而结果看起来完全正常（它确实切掉了点东西） |
| `crop-failed-write-is-not-success` | 调用方拿着 `cropped:true` + `output_path:null` 去读一个从来没被写出来的文件 |
| `jump-too-short-is-undecidable` | 三个点也给一个 z 分数 |
| `jump-dead-flat-is-not-a-jump` | `confidence` 变成 NaN，而 NaN 穿得过每一条 `>` 检查（同 D-SI-1） |
| `jump-length-is-the-first-axis` | 一份两列的 `.dat` 被说成「128 个采样点」 |
| `load-frame-backward-is-mirrored` | **正反扫一致性判据整个反过来**（76 张真机帧：阈值 0.80 上从「好帧 0/37 过、废帧 5/14 过」变成「好帧 27/37、废帧 0/14」） |
| `load-frame-missing-direction-is-its-own-failure` | 一次只扫了正扫的图被报成「通道不存在」，而那个通道就在文件里 |
| `load-frame-name-collision-takes-the-next-free` | 同一毫秒里的第二次读把第一次的帧毁掉（旧仓 2026-07-28） |
| `drift-size-mismatch-is-a-note-not-a-crash` | 当场按错的形状 reshape |
| `drift-centres-on-half-the-shape` | 每一帧的漂移整体偏一个像素，而那仍是一个合法读数（D-NUM-19） |
| `drift-reads-the-reference-before-the-instrument` | 一次注定失败的分析先占一次锁 |
| `spectrum-ext-list-is-the-old-repos` | 一条真实的谱路径被当成 JSON 去解析 |

### ⚠️ 「一条编不过的变异」第二十~二十二次

三条 `inconclusive`，**三条都是同一个形状**（拆掉某道闸之后某个东西没人读了，
`noUnusedLocals` 当场拦下）：

```
paper-image.ts(330,11):  TS6133 'diff' is declared but its value is never read
paper-data.ts(45,1):     TS6133 'npMedian' is declared but its value is never read
image-channel.ts(26,7):  TS6133 'NOT_TOPO' is declared but its value is never read
```

修法照批 4a §3 的两条，一条没新发明：

1. **把它留在表达式里**：`std(denoised.data) + std(diff) * 0`；
   `!c.includes(NOT_TOPO + '\u0000')`（一个永远命不中的串）；
2. **留在一个永远为假的分支里**：`row.length < 0 ? npMedian(row) : …`。

另有一条 `paper-skills.test.ts` 的 `TS18047`（`tol` 可能是 `null`）—— 那不是变异
的锅，是**测试文件自己的类型窟窿**：`tolFor` 的返回类型还留着 `| null`，
而 `vitest` 的转译不做类型检查，`pnpm build` 那一趟又跑在改它之前。
**变异框架的判据②（构建必须过）把它揪出来了** —— 它比任何一条测试都早发现这件事。

### 还有**三条一开始是绿的** —— 而绿的意思是那道闸不存在

这一轮它指出来的全是**金样缺一格**，一条都不是代码缺闸（批 4a §9② 第二次）：

| 变异 | 为什么绿 | 怎么修的 |
|---|---|---|
| `ransac-refits-on-all-inliers` | 背景是一张**精确的**平面 ⇒ 任何三个背景点解出来的就是那张平面（差 1e-25）⇒「拿全部内点再拟合一次」什么都没改 | 加一张 `bowl_disks`：平面上叠一口**幅度 1e-11 的浅碗**（≪ 内点阈 1e-10，内点集照旧定死），于是三点解与全内点最小二乘差 ~3e-13/px，而斜率本身才 8e-13/px |
| `destripe-interpolates-between-neighbours` | 每一条干净行**完全相同** ⇒ 权重 `w` 与 `1−w` 给出同一个数 | 给 `stripes` 加一条 `1e-14·i` 的缓坡（小到不改三档判据：干净行的 normalized 从 0 涨到 0.022） |
| `level-lines-median-is-np-median` | `1e-9 ± 1e-13` 的行上两种中位写法**恒等**（实测三百万对一次都没分岔） | 加一张 `median_split`：一行里跨 20 倍高差（`lo=1.002e-10`、`hi=2.004e-9`），`(lo+hi)/2` 与 `lo+(hi−lo)·0.5` 差最后一位 |

> 第三条尤其值得记：**D-VISION-2 那条登记是批 4a 写的，而在这一批之前
> 全仓没有任何一格数据分得开那两种写法。** 一条登记过、写进代码、
> 写进 docstring 的差异，仍然可以一次都没被验过。

⚠️ 第三条还**露出第二层**：`median_split` 那一格的输出容差本来是
`lstsqRelTol(κ) ≈ 1.8e-13`，而两种中位写法只差 ~2e-25 —— **带容差时 114 条全绿**。
改成 0 才红。「做得到逐位就不要给容差」在这里不是洁癖，是这道闸的生死。

---

## 4. 金样怎么来的

### `spec/golden/paper_data.json`（新，1049 KB，6 节，**重跑逐字节相同**）

```
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe \
    tools/spec-export/export_paper_data.py
```

**旧仓真实的 12 个技能真跑一遍**。六节：`condition_numbers` · `ransac_facts` ·
`atom_jump_facts` · `files`（20 份合成文件的字节，base64） · `drift_stubs` · `skills`（95 格）。

四条纪律，前三条与 `export_analysis.py` 同，**第四条是这一批新加的**：

1. 输入与答案一起录，合成用**闭式公式、零随机数**；
2. **录的是文件的字节**（`.npy` / `.sxm` / `.dat`），读法两边各自的；
3. 墙钟与随机数一概不进（`time.time` 钉成常数 —— 见下）；
4. **产物也要录**：每一格跑完把技能写出去的 `.npy` **读回来**一起录。
   `LoadScanFrameFromFile` 写两个（`fwd` / `bwd`），两个都录 ——
   不录的话，「反扫有没有镜像回样品坐标」那条判据一格都验不到。

#### 墙钟钉死之后，**撞名那条路才走得到**

`LoadScanFrameFromFile` 把 `int(time.time()*1000) & 0xFFFFFFFF` 写进它造的文件名里。
不钉住它，金样每跑一次就换一批路径（「重跑逐字节相同」是假的）。
钉住之后**顺带**得到一件事：两次同文件同通道的调用**撞名**，于是
`_01` 后缀那条路真的被走到了 —— 那正是旧仓 2026-07-28 那次「第二发盖掉第一发」
的修补，而一个每次都不同的时间戳会让它**永远验不到**。

### 四张图是为了「让闸有人走到」而造的

| 图 | 为谁造的 |
|---|---|
| `plane_disks`（精确平面 + **平顶**圆盘） | RANSAC 的内点集**不是抽签**（见 §5） |
| `bowl_disks`（+ 浅碗） | 「全内点再拟合一次」那道闸 |
| `stripes`（96×16，四段条纹 + 缓坡） | `min_length` 在 3/5/6 上**换答案**、软的要挨着硬的、插值方向 |
| `median_split`（一行跨 20 倍） | `np.median` ≠ `percentile(50)` |
| `bordered`（上边框与左边框**取不同的常数**） | `max_iter`：切掉一条边会**露出**另一条 |
| `rough_gradient`（16 格幅度两两不等） | `argmin` 不并列 —— 并列时谁赢由最后一位浮点决定 |

### 容差表（**每一条都写在被测函数自己的 docstring 里，连同推导**）

测试里**没有一个字面量容差** —— 全部引用被测件导出的那个函数/常量。

| 件 | 容差 | 为什么是这个数 |
|---|---|---|
| 切边 / 计数 / 下标 / 路径 / 措辞 / 掩膜 | **0** | 整数与搬运 |
| `destripe` 的输出 | **0** | 输出要么是输入里某一行原样、要么是 `(1−w)·a + w·b`（两乘一加，同一个顺序） |
| `AutoCrop` 的输出 | **0** | 它是输入的一个**切片** |
| `LevelLines(median)` 的输出 | **0** | `行元素 − 该行中位`，**一次减法** |
| `LoadScanFrameFromFile` 的两个 `.npy` | **0** | 同一份 `.sxm` 字节读出来的 float32，归位只是翻转 |
| `ComputeDriftVector` 的 `shift_*_px` / `drift_*_m` | **0** | 下标；整数 × 一个浮点 |
| `rms_*` / `noise_estimate` / `roughness_map` | `sumRelTol(n)` | 一次两遍法 `std`；Neumaier 对成对求和（D-NUM-1） |
| `plane_coefficients` / 多项式与逐行拟合的输出 | `lstsqRelTol(κ)` | 正规方程（κ 平方）对 SVD；κ 随金样录 |
| `phase_diff` | `xcorrPhaseAbsTol(n)`，**绝对** | 复数的相对误差 δ 最多把辐角挪 δ 弧度 |
| `correlation_error` | 在**平方**上，`xcorrErrorSqAbsTol(n) · max(1, w²)` | D-NUM-21 的推广，见下 |
| `confidence` | `sumRelTol(n/2) · 相消系数` | 见下 |

#### 两条容差是**推广**出来的，不是抄的

**① `correlation_error`。** numerics-3 那条写的是「只能在**平方**上给**绝对**容差」，
推导是 `error² = |1 − r|`，`r ≈ 1` 时那是两个几乎相等的数相减。
但相位归一化那一档上 `r` 能到 `1e27`（skimage 拿**白化后**的 `CCmax` 去除
**没白化**的两条功率和），这时绝对容差是一句空话。两种情形合起来正好一条式子：

```
|a² − w²| ≤ max(1, w²) · 32 · fftRelTol(n)
```

`max(1, w²)` 那一项就是「r 在 1 附近时退化成绝对、r 很大时退化成相对」。

**② `confidence` 的相消系数。** `z = |mean₂ − mean₁| / std`，而这一族的曲线是
「1e-10 上下抖 1e-13」—— 两个均值几乎相等，它们的**差**把各自的舍入放大了
`(|m₁| + |m₂|) / |m₂ − m₁|` 倍（`json_flat` 那一格是 **2.36e4**）。
这个系数**只有从数据里才算得出来**，所以导出器把它按格录进了 `atom_jump_facts`。
实测 3.0e-12，容差 2.2e-10，占比 1.4%。

> 一条推不出来的容差宁可不写（numerics-3 §六②）；
> **一条推得出来但要数据的容差，就把那个数据一起录进金样。**

#### 输出文件的容差按**输入**的量级归一，不是输出的

`LevelLines_Median/poly1` 那一格最典型：输入在 1e-9 上，逐行减掉一次线性拟合
之后残差只剩 1e-13。拟合误差是按**输入**的量级走的，按残差归一等于要求
`1e4 × lstsqRelTol` 的精度 —— **做不到的容差不是严格，是一条迟早要被改松的断言**。
所以 `scale = max(|输入的峰值|, |这一格的期望值|)`，而输入是从技能自己的
`image_path` **读回来的同一份字节**。

### `spec/golden/skill_traces.json`（+12 个技能，+166 行）

十二个里**十一个只读文件**，而那台导出器的 `_params_for` 给不出一条真实的路径，
于是它们录到的是「读不动」那一支，一次 TCP 都不发。**那仍然是一条判据**
（外壳在碰任何东西之前先拒），但不是这一批的主判据。
`ComputeDriftVector` 是唯一跟仪器说话的那个，而它在这里先卡在读参考图上 ——
也就是说「参考图读不动就不发 TCP」这条**顺序**是这一份钉住的。

四条走进了 `traces.test.ts` 的 `DEVIATIONS` 表（D-PAPER-1 那四句话）。

---

## 5. RANSAC 那一格为什么**不是**抽签（批 4a §9① 的第二次应用）

`ransac_plane_subtract` 用 `np.random.default_rng(42)`（PCG64），本仓是
`Xoshiro128` —— 两边抽到的三元组必然不同。批 4a 的 `fit_plane_robust` 就是在这里
分的岔（D-VISION-1）。

**这一批改的是输入，不是容差**：

* 背景是一张**精确的平面**（float64 上残差 ~1e-25）；
* 特征是**平顶圆盘**，高 5e-9，**没有裙边** —— 每个像素要么在平面上、
  要么离它 5e-9，而内点阈是 1e-10，中间空着**十四个数量级**。

后果：任何一组「三点全落在背景上」的抽样都给出同一个平面 ⇒ `best_inliers`
恒等于背景像素数（933/1024，单独录在 `ransac_facts`）⇒ `inlier_mask` 恒等于背景
本身 ⇒ 最后那次全内点最小二乘两边解同一个方程组。**抽样序列不同，答案相同**，
而这不是运气，是这张图的构造。金样 `threshold_1e_15` 那一格是证据：
阈值从 1e-10 收到参数下界 1e-15，答案一个字不变。

一张有裙边的图（高斯包）做不到 —— 裙边上有一圈像素的高度**正好在阈值附近**。
所以 D-PAPER-3 登记的是：**本函数在真机的图上与旧仓不逐位一致**，
而判据落在「离对的近、离错的远」上（`ransac_facts.lstsq_all_coefficients`
把「不剔除圆盘」那一版也录了，两者差 **7 倍**）。

---

## 6. stmsim e2e（3 条，都过）

**十二个里只有 `ComputeDriftVector` 有 e2e，另外十一个不该有** ——
它们一次 Nanonis 调用都不发，读的是磁盘上的 `.npy` / `.sxm` / `.dat`，
而那些字节已经被旧仓亲自读过一遍了（同批 4a 那八个）。

```
STMSIM_PYTHON=… STMSIM_ROOT=… npx vitest run --project integration
```

### ⚠️ 这一组当场照出一件事：**同一帧对它自己，这个技能从来不报 0**

拿模拟器刚给的那一帧当参考再问一次漂移，答案应该是 0。实测**不是**，而且有两种：

| 缓冲里是什么 | 报出来 | 换算（256 px / 10 nm） |
|---|---|---|
| 真有结构 | `−1` 像素（偶数边长） | 39 pm |
| **一片死平**（模拟器刚起来时就是这样，实测整幅 65536 个 0） | `−rows//2` | **−5 nm，半幅** |

第一行是 D-NUM-19（`(M−1)//2` 对 `M//2`，两个都是 scipy、两个都叫「中心」）。
第二行更糟：去均值之后整幅是 0 ⇒ 互相关面处处是 0 ⇒ `argmax` 落在下标 0。
技能报 `success: true`，四个数一个不缺，**没有任何字段说得出「这两帧里没有
可对齐的东西」**，而漂移补偿会照着那个数去驱动硬件。

两条都照移（金样把旧仓那一侧钉住了），e2e 把它们**演示**出来 ——
一个「看起来完全合理的漂移读数」是这类缺陷唯一的外部表现。
这与批 4a 那条「问错通道真模拟器不报错」是同一种产出：
**e2e 的价值不在于让绿的更绿，在于照出单测照不到的那种「合理」。**

---

## 7. `numerics` / `vision` 那两条支线要的东西（**我一个字没改那两个包**）

本批要而基线没有的语义都落在自己的技能层文件里。判断标准只有一个：
**它有没有第二个消费方？**

| 件 | 在哪 | 建议 | 理由 |
|---|---|---|---|
| `pickImageChannel`（`_pick_image_channel`） | `kernel/src/image-channel.ts` | **留在 kernel** | 零 numpy、零 I/O，而且它是一条**判决**（挑错通道，后面每个数都算得对、量的是另一个物理量） |
| `pyFloatOrThrow` / `pyTypeName` / `pyReprStr`（Python `float()` 的三句异常） | `kernel/src/scan-regions.ts` | **可以搬到 `si.ts` 那一族** | 那是 `pyFloatRepr` / `pyStr` / `pyFixed` / `pyMod` / `pySum` 的第七个成员；现在只有一个消费方，所以**先不搬** |
| `loadImage2d` / `loadSpectrum`（按扩展名分派） | `stm-skills/l0/paper-common.ts` | **先别搬** | 它要 `node:fs`，而 `nanonis-files` 的纪律是零 I/O |
| `.npz` / `.sm4` / `read_txt` | **没有** | 要不要补由消费方定 | 见 D-PAPER-2。`.txt` 那一条最可能先要（`DetectAtomJump` 与谱那一族都声明了它） |
| `correlate2d(mode='same')` · `hanning` · `xcorrErrorSqAbsTol` · `polyfit` | numerics（**上一轮已落**） | — | 这一批是它们的**第一个消费方**，四件全用上了，签名一处没改 |
| `npMedian` | vision（批 4a 已落） | — | 本批三个文件都在用它，**D-VISION-2 到这一批才第一次被验到**（见 §3） |

另外：`numerics.fitPoly2d` **顶不掉** `poly2dSubtract` —— 前者是固定二阶六项，
后者是 `order_x`/`order_y` 各 1..6 的张量积。理由写在 `paper-image.ts` 的抬头。

---

## 8. 我核出来与 `survey-remaining.md` 不一样的地方

| 它说 | 实际 |
|---|---|
| **A33**：`paper.background` 的张量积要自搭，「外加一条 `i+j > order_x+order_y` 裁剪（第 352 行）」 | 张量积**属实**（`fitPoly2d` 确实顶不了）。但**那条裁剪是死代码**：循环是 `i ∈ [0, order_x]`、`j ∈ [0, order_y]`，`i+j` 的最大值**正好**等于 `order_x+order_y`，那个 `>` 一次都不成立。项数恒为 `(order_x+1)(order_y+1)`，`n_coefficients` 就是证据（`order31` 那一格是 **8** = 4×2）。见 D-PAPER-5 |
| **A34**：MorphOpen 是手写一维行程开运算，别用 `greyOpening` | ✔ 完全属实，而且比盘点说的更要紧：形态学开运算把短行程**截掉两端**（长行程会被削短、相邻行程会被连起来），而这里要的是**整段留或者整段丢**。两者在一段长 10、`k=5` 的行程上给出不同的行数，**而两个结果都是一张「去过条纹的图」** |
| **A38**：`SubtractPlane_RANSAC` 「RNG 不同，`inlier_ratio`/`plane_coefficients` 不可能与金样逐位对上」 | **不对 —— 取决于输入**。平顶盘 + 精确平面的图上内点集是**定死**的，两边逐位一致（`inlier_ratio` 容差 0）。盘点那句话对**真机的图**成立，对合成的判据图不成立，而这个区别正是「改输入不是改容差」那一课。见 §5 |
| **A37**：`atom_jump` 的「唯一缺口只是 `load_spectrum` 的 `.txt/.csv/.asc/.npz` 分支」 | 缺口属实，但它**不是唯一的问题**：这个技能的统计回退 **z 分数上限恒为 2**，而缺省阈值是 3.0 ⇒ **它在缺省参数下永远报不出跳变**（D-JUMP-2）。盘点只数了依赖，没算那条判据 |
| **A28**：`LoadScanFrameFromFile`「一件都不多要，只差一个 `_frames_dir()`」 | 属实。⚠️ 但 `_frames_dir()` 不只是一个目录：那条**撞名取下一个空位**的路（`freeFrameBase`）是 2026-07-28 事故的修补，而它要靠**钉死的墙钟**才验得到（见 §4） |
| **B 档**：`ComputeDriftVector` 差 `correlate2d(mode='same')` | 件属实（上一轮已落）。但盘点没说的是：**补上那一件之后这个技能仍然是错的** —— 中心差一格、空缓冲报半幅（D-DRIFT-1）。「缺的那一件有了」不等于「这个技能对了」 |
| `paper.denoise` / `paper.atom_jump` 的 `model_path` 分支「砍掉」 | ✔ 照办。但两个技能**对 `method` 字段的处理不一样**：`Denoise_AE` 报真跑了哪一条，`DetectAtomJump` 报请求的那一条。盘点把它们当成同一种「有回退的 ML 技能」，而它们在**返回值诚不诚实**这件事上是两类 |

---

## 9. 没做完的（逐条）

| 缺的 | 谁在等 | 还差什么 |
|---|---|---|
| **DoD ⑦ 技能卡片** | 全仓 | `scripts/gen-skill-cards.ts` **还没有**（PLAN §6.2 列了，从没建过）。批 3g–3l、4a 同样没做，这一批照旧 |
| **`.npz` / `.sm4` / `read_txt` 三种读法** | `DetectAtomJump` 的 `.txt/.csv/.asc`；谱那一族 | `.npz` 要 zip inflate；`.txt` 要 `read_txt`（旧仓 `io/nanonis_files.py`，纯文本分列）。D-PAPER-2 |
| **`Denoise_AE` / `DetectAtomJump` 的模型那一支** | Phase 8（`vision-onnx`） | 两个技能的 `model_path` 参数**照旧在模型面上**（描述逐字冻结），而本仓永远走回退。`Denoise_AE` 的 `method` 说得出实话，`DetectAtomJump` 由 D-JUMP-1 改成说实话 |
| **`_pick_image_channel` 的第三档（「都没有就第一路」）没有金样格** | — | 唯一一处「猜」，由一条直接打在 `pickImageChannel` 上的单测覆盖（金样里的三份 `.sxm` 都有 Z 或都只有 Current） |
| **`correlate2d` 的 `'full'` / `'valid'`、`phaseCrossCorrelation` 的 `disambiguate`** | 没有消费方 | 同 numerics-3 §四那张表，本批也没引入消费方 |
| **`CorrectDrift_XCorr` 的 `phase` 归一化档 + `uf > 1`** | — | 金样只录了 `uf=1` 的 `phase` 档：`uf>1` 时 skimage 的 `error` 跑到 4.5e13，而 D-NUM-21 那条容差是**平方上的绝对值**，一个 2e27 的平方上没有任何绝对容差说得出话。开关本身在 `uf=1` 上一样看得见 |
| **`ParseRegions` 的 `label` 是 `list` / `dict` 时** | 没有消费方 | `pyLabel` 只认 `null`/`bool`/数/串（Python 的 `str([1,2])` 是 `'[1, 2]'`，要的话得再写一个 `pyRepr`） |

---

## 10. 值得进课时的三件

### ① 「只比 `data` 不比产物」= 只比收据不比货

这一族技能的返回值里只有 `corrected_image_shape` / `stripes_removed` /
`n_coefficients` 这种东西。**把 destripe 的插值权重反过来，这些字段一个字都不变。**

批 4a 的九个技能返回的是判决（`verdict` / `advisory` / 一句话），
所以「比整棵 `SkillResult`」就够了。这一批返回的是**一个文件路径**，
于是判据必须跟到文件里去 —— 而这件事在 `SkillResult` 的形状上看不出来。

> **一个技能的判据落在哪，由它的产物是什么决定，不由它的返回值长什么样决定。**

代价是金样从 95 KB 涨到 1049 KB（十一倍），而涨的那部分**全是产物**。
值不值：`destripe-interpolates-between-neighbours` 与
`load-frame-backward-is-mirrored` 两条闸**只有**产物比得出来。

### ② 一条登记过的差异，仍然可以一次都没被验过

D-VISION-2（`np.median` ≠ `percentile(50)`）是批 4a 登记的，代码里写着、
docstring 里写着推导、`vision/nd.ts` 有 `npMedian` 这个专门的函数。

**而在这一批之前，全仓没有任何一格数据分得开那两种写法。**
两个式子只在 `a` 与 `b` **量级相差很远**时才真的分岔 ——
`1e-9 ± 1e-13` 的行上，三百万对里一次都没分开过（实测）。

要验到它，得有一行**跨量级**的数据，而那正是「行里有个分子」的样子。
造了 `median_split`（`lo=1.002e-10` / `hi=2.004e-9`）之后，那一位才第一次进判据。

> 批 4a 的话是「一条变异跑出绿色，说的是这条闸不存在」。
> 这一批把它推进一步：**一条闸可以同时「写了、登记了、有专门的函数」而
> 仍然不存在** —— 不存在的不是闸，是**走到它的那条路**。

顺带露出第二层：那一格的容差本来是 `lstsqRelTol(κ) ≈ 1.8e-13`，而差只有 2e-25 ——
**带容差时 114 条全绿**。「做得到逐位就不要给容差」在这里不是洁癖，是这道闸的生死。

### ③ 「缺的那一件有了」不等于「这个技能对了」

盘点的 B 档是一张**缺件表**：`ComputeDriftVector` 差 `correlate2d(mode='same')`，
`CorrectDrift_XCorr` 差「非归一化互相关 + error/phase + hanning」。
上一轮把两件都补上了，这一批把两个技能落了地。

**而 `ComputeDriftVector` 仍然是错的**：中心差一格（每帧 39 pm 的凭空漂移）、
空缓冲报半幅（−5 nm，`success: true`）。这两条与那个缺件**没有任何关系** ——
它们在旧仓的 30 行 `execute` 里，一直都在。

缺件表回答的是「移得动吗」，不是「移过来对不对」。
后者只有**跑一遍**才知道，而空缓冲那一条是**真模拟器**告诉我们的，
不是读代码读出来的（金样那一侧我造的回包永远有结构）。

> **一张缺件表是路线图，不是验收单。**

---

## 11. 给合并方的提醒

- **只动了锚点**：`l0/index.ts` 三处 `批 4c`、`gen-skill-specs.ts` 的 `BATCH_4C`、
  `export_skill_traces.py` 的 `BATCH_4C`、`kernel/src/index.ts` 的 `批 4c`、
  `mutations.ts` 的 `批 4c`、`spec/deviations.md` 的 `批 4c` 注释锚点。
  **`3g`–`3l` 与 `4a` 一个字没碰。**
- **锚点之外动过的共享文件**（只有一处）：
  - `packages/host/stm-skills/src/l0/traces.test.ts` —— `DEVIATIONS` 表末尾加 4 条
    （批 4a 也在那里加过两条，加在它们**后面**，没有动它们）。
  - `tsconfig.json` / `vitest.config.ts` / `pnpm-lock.yaml` / `package.json`
    **全部原样**（这一批没有新包）。
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑；
  合并后请**统一再跑一次**：
  ```
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  node scripts/gen-skill-specs.ts
  node scripts/build-progress.ts
  ```
- `spec/golden/paper_data.json` 与 `tools/spec-export/export_paper_data.py` 是本支线
  独有的新文件，不会冲突。**重跑逐字节相同**（md5 两次一致，已验）。
- **`packages/host/vision/` 与 `packages/host/numerics/` 一个字节都没动。**
