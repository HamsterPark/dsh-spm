# 盘点七 · `paper.*` 一族

盘点日期 2026-09-20。两仓只读，未改动任何文件。
分母以 `spec/progress.json`（本仓，2026-09-19 17:16 生成）为准。

---

## 复核那张表

任务书抄的 13 个模块 / 25 个技能，**逐条对上了**，一个不差：

| 模块 | 缺口 | 模块 | 缺口 |
|---|---|---|---|
| `paper.autonomous` | 7 | `paper.line_check` | 1 |
| `paper.region_analysis` | 4 | `paper.montage` | 1 |
| `paper.optimization` | 2 | `paper.scan_diff` | 1 |
| `paper.spectral_analysis` | 2 | `paper.spectral_unmix` | 1 |
| `paper.tip_assessment` | 2 | `paper.deconvolution` | 1 |
| `paper.defect_cluster` | 1 | `paper.drift_bragg` | 1 |
| `paper.imspec` | 1 | | |

合计 13 模块 / 25 技能，全部 `done=0`。

**但「整族未开工」这句是错的** —— 见下面 ⚠️ 第 1 条。
`paper.*` 一共是 **19 个模块 / 34 个技能，已落 9 个**（26%）。
另外 6 个模块（`atom_jump` · `background` · `data_processing` · `denoise` ·
`image_filters` · `scan_crop`）在批 4c 就整模块做完了，代码在
`packages/host/stm-skills/src/l0/paper-{common,data,image,crop}.ts`。

**这件事改变了整个盘点的结论**：这一族不是从零开始，它有一个**已经建好并验收过的底座**。

---

# 一、`paper.*` 是什么

## 它住在哪

`<MAST_ROOT>\MASTv2\mast\skills\paper\`，21 个 `.py`（19 个技能模块
＋ `__init__.py` ＋ `_fit_utils.py`），共 34 个技能。
旧仓 `mast/skills/base.py:9` 的抬头自己写着这个三分法：「**130 builtins + 5 composite + 21 paper**」。

名字是**来源**，不是形状：每个文件的类 docstring 都挂着一篇论文
（`deconvolution.py:37` 「Reference: pySPM」、`region_analysis.py:74` 「Zhu et al., JACS (2024)」、
`tip_assessment.py:206` 「Krull et al., Commun. Phys. 3, 54 (2020)」……）。
这一族是**「把论文里的算法搬成技能」**的那一堆。

## 与 `builtins.*` / `composite.*` 的结构性区别

### 基类 —— **paper 不是第三种基类，它横跨前两种**

| | 基类 | 出处 |
|---|---|---|
| 16 个分析技能 | `BaseSkill` —— **与 builtins 同一个** | `deconvolution.py:25`、`region_analysis.py:68`、`tip_assessment.py:194`、`spectral_analysis.py:95` … |
| 9 个（`autonomous` 7 ＋ `optimization` 2） | `CompositeSkillGraph` —— **与 composite 同一个** | `autonomous.py:184/378/609/933/1238/1483/1807`、`optimization.py:47/513` |

也就是说：`paper/` 这个目录里装着两种完全不同的东西，它们之间**没有共同基类**，
只有共同的**出处**。盘点必须按这条线切，而不是按目录切。

### 注册方式 —— **与另外两族完全一样**

`paper/__init__.py:9-60` 逐个 import，`:62-101` 一张 `__all__`。
每个文件末尾一个 `make_tool*()` 调 `wrap_skill`（`deconvolution.py:236`、
`region_analysis.py:580-590`、`tip_assessment.py:417-420`）。
这条路 builtins 与 composite 走的是同一条。**注册上没有任何区别。**

### 返回什么 —— **同一个 `SkillResult`**

三族共用 `mast/core/types.py` 的 `SkillResult` / `SkillMetadata` / `ParameterSpec`。
没有 paper 专属的返回类型。

### 真正的区别有两条

**① 16 个分析技能吃的是文件路径，一次 TCP 都不发，`context` 收下但从不使用。**

`deconvolution.py:107` 的签名是 `def execute(self, context, params)`，而
`context` 在整个 66 行函数体里**零引用**。同一形状：`region_analysis.py:119/252/376/508`、
`tip_assessment.py:269/382`、`drift_bragg.py:83`、`scan_diff.py:124`、
`spectral_analysis.py:171/382`、`spectral_unmix.py:102`、`imspec.py:86`、
`defect_cluster.py:92`、`montage.py:218`、`line_check.py:332` —— **十六个全是**。

它们的入参是 `image_path`（`deconvolution.py:44`）/ `spectrum_path`
（`spectral_analysis.py:114`）/ `data_path`（`spectral_unmix.py`）/
`fwd_lines`+`bwd_lines`（`line_check.py:252/258`）。
产出要么只是 `data` 里几个标量，要么额外写一个 `.npy`
（`deconvolution.py:148-152`、`drift_bragg.py:107-114`、`region_analysis.py:428-437`、
`scan_diff.py:158-168`）。

> 这一点对移植是好消息：**它们是纯函数**。没有仪器、没有时序、没有中止、没有锁。
> 输入是字节，输出是数。金样能钉死。

**② 9 个 composite 技能只通过「排子技能」碰仪器。**

`autonomous` / `optimization` 的 `plan_dynamic` 产出 `CompositeStep`，
由 `GraphExecutor.run_plan` 执行（`autonomous.py:359/574/903/1221/1465/1784/2179`、
`optimization.py:415/827`）。它们自己**一条裸动词都不发**。

### 谁调它们

`paper/__init__.py` 导出 → `wrap_skill` 变成 LangChain 工具 → 模型直接点名。
**族内几乎没有互调**（见第二节）。

一个例外值得记下：`tip_assessment.py:28-32` 明写这两个技能
「**没有 agent 持有它们**……手动走判据目录时才会撞见」。

### 一个数字把定位说清楚了

`composition_level`（`grep -h "composition_level=" */*.py | sort | uniq -c`）：

| 族 | 分布 |
|---|---|
| `builtins/` | 357 个 `=0`、56 个 `=1`、22 个 `=2`、1 个 `=4` |
| `composite/` | 23 个 `=3`、8 个 `=4`、6 个 `=2`、1 个 `=5`、1 个 `=0` |
| `paper/` | **31 个 `=4`**、3 个 `=3` |

旧仓自己给这一族的定位是**最外面那一层**。这也解释了为什么它排在最后才做。

---

# 二、`paper.autonomous` 是不是中枢？

**不是。它是这一族的屋顶，不是它的地基。**

## 它调谁

7 个技能 `plan_dynamic` 排出的子技能，**没有一个是 paper 分析技能**：

| 子技能 | 出自 | 被哪几个 autonomous 排 |
|---|---|---|
| `FullScan` | `composite/full_scan.py:54` | Heuristic(461… 见下表) · UNet · DQN · Scanbot · ContinuousImaging · AutoOSS |
| `AssessImageQuality` | `composite/assess_quality.py:92` | **同上六个** |
| `MoveToXY` | `builtins/navigation.py:54` | Heuristic · UNet · Scanbot · SAC · AutoOSS |
| `SetBias` | `builtins/bias.py:102` | Scanbot · SAC |
| `SetSetpoint` | `builtins/zcontrol.py:100` | SAC |
| `TipPulse` | `composite/tip_pulse.py:44` | DQN · AutoOSS |
| `ConditionTip` | `composite/condition_tip.py:57` | Scanbot · ContinuousImaging |

逐个 yield 行号：
`Heuristic` 257/272/315 · `UNet` 461/476/530 · `DQN` 753/789/804 ·
`Scanbot` 1069/1093/1122/1137/1159 · `ContinuousImaging` 1344/1359/1387/1403 ·
`SAC` 1668/1679/1690 · `AutoOSS` 1926/1937/1951/2007/2022/2036。

族内**唯一**的技能级引用：`ContinuousImaging_Auto` 在 `autonomous.py:1387` 排了
同文件的 `FindGoodRegion_Heuristic`。

## 函数级上确实有两条族内的线（这是判据，不是 import）

- `autonomous.py:291-292` → `from mast.skills.paper.data_processing import find_empty_spot`
  然后 `find_empty_spot(image, grid_n)` —— `FindGoodRegion_Heuristic` 的**全部判据**就是它
  （`data_processing.py:629`）。**本仓已有**：`findEmptySpot`（`paper-data.ts:480`）。
- `autonomous.py:501-502` → `heuristic_segment(image, n_classes=3)`
  （`region_analysis.py:36`，7 行分位阈值）—— `FindGoodRegion_UNet` 的回退判据。
  **本仓还没有**，但它是 `SegmentRegion_UNet` 的本体，做那个就顺带有了。

## 谁调它

**没有人。** 34 个 paper 技能里没有任何一个排它们，`composite/` 里也没有
（`autonomous.py` 定义的 7 个类在旧仓其余代码里只出现在 `paper/__init__.py:53-61`）。
它们对 agent 是叶子（对模型是顶）。

## 结论

`paper.autonomous` 与其余 16 个分析技能之间**几乎没有依赖**。
两边可以完全并行开工，不存在「先做中枢」这件事。

**而它的真正阻塞在另一族**：

| 子技能 | 本仓状态（`spec/progress.json`） |
|---|---|
| `AssessImageQuality` | `composite.assess_quality`，**todo**，`impl=false traces=0` |
| `ConditionTip` | `composite.condition_tip`，**todo**，`impl=false traces=0` |
| `FullScan` / `MoveToXY` / `SetBias` / `SetSetpoint` / `TipPulse` / `GetScanFrame` / `ConfigureSTS` / `AcquireSTS` | 全部 **done** |

`AssessImageQuality` 卡住 6 个 autonomous ＋ 1 个 optimization；
`ConditionTip` 再卡住其中 2 个。**这条依赖跨到 `composite.*` 那一族去了，
应该跟盘点七的 composite 那份对一下。**

**唯二子技能齐全的**：
- `AtomManip_SAC`（只要 `SetBias` / `SetSetpoint` / `MoveToXY`）
- `AdaptiveSTS_GP`（只要 `ConfigureSTS` / `MoveToXY` / `AcquireSTS`）

---

# 三、有没有共用底座？

**有，而且它已经建好了。** 这是这次盘点最重要的一条。

## ① 共同的 IO —— `paper-common.ts`，**批 4c 已落**

`packages/host/stm-skills/src/l0/paper-common.ts`，193 行。
它对的是旧仓 `mast/data/loaders.py` 的 `load_image_2d` / `load_spectrum`。

| 导出 | 行 | 对的是 |
|---|---|---|
| `loadImage2d(path, prefer?)` | `paper-common.ts:124` | `load_image_2d` |
| `loadSpectrum(path)` | `:148` | `load_spectrum` |
| `siblingNpy(src, suffix)` | `:176` | `_src.with_name(f"{stem}_xxx.npy")` |
| `matRows(m)` | `:187` | 给 `encodeNpyFrame` 喂形状 |
| `ImageLoadError` | `:37` | 「读不动是一个值，不是一次崩溃」 |

**25 个 todo 技能里 16 个直接吃它**：

- `loadImage2d` ×13：`deconvolution.py:109`（另 `:136` 读 PSF）·
  `defect_cluster.py:94` · `drift_bragg.py:85` · `imspec.py:88` · `montage.py:248` ·
  `region_analysis.py:121/254/386/518`（四个）· `scan_diff.py:126/127`（两张）·
  `tip_assessment.py:271/384`（两个）
- 经 `autonomous.py:85 _load_image_for_analysis` 再 ×3：`:288` · `:493` · `:2073/2074`
- `loadSpectrum` ×3：`spectral_analysis.py:44`（服务 `FitFano_Kondo` / `FitGap_BCS`）·
  `spectral_unmix.py:104`

**不吃它的 9 个**：`line_check`（自己的 `_load_array`，`line_check.py:578`，
吃 `.npy` / JSON / 裸数组三种）· `optimization` ×2 · `autonomous` 里不读图的 4 个。

> 底座已在 ⇒ **第一批不需要先造东西，可以直接做技能。**

## ② 共同的产出层 —— 同样已落

`.npy` 兄弟文件那条路：`siblingNpy` + `matRows` + `encodeNpyFrame`（`kernel/src/npy.ts:65`），
外加 `paper-image.ts` 里那个 `persist()` 小壳（用于 `:296`、`:335`）。

todo 里要写 `.npy` 的：`DeconvolveTip_RL`（`deconvolution.py:148-152`，`_deconv`）·
`CorrectDrift_BraggPeak`（`drift_bragg.py:107-114`，`_bragg`）·
`PredictStructure_ASD`（`region_analysis.py:428-437`，`_asd_pred`）·
`DiffScans_ChangeDetect`（`scan_diff.py:158-168`，`_diff_`，**另有一条防覆盖输入的判据**
`scan_diff.py:189-218`）。

## ③ **没有**共同的 figure/report 输出层 —— 这一条要专门回答

任务书担心「这一族压着绘图 / 文件产出」。**实测：压得比想的轻得多。**

全族 `grep matplotlib|plt\.|savefig|imsave`：

| 文件 | 命中 |
|---|---|
| `montage.py` | `:122`（`plt.get_cmap`）· `:285-290`（Agg ＋ 4 个 import）· `:296-301`（`plt.subplots`）· `:302/306` · `:326-329`（`imshow`）· `:332-335` · `:341-349`（`AnchoredSizeBar`）· `:352-354`（`colorbar`）· `:358-363`（`ax.text` ＋ 描边）· `:365-366`（`savefig`）· `:373`（`close`） |
| **其余 24 个 todo 技能** | **零** |

`autonomous.py` 全文件只在 `:89` 的 docstring 里出现过字面量 `.npy`；
`optimization.py` / `_fit_utils.py` / `line_check.py` **一处都没有**。

**结论：绘图不是一层，是一个技能。**
`ComposePanelMontage` 一个人扛着全族 100% 的 matplotlib。
按本仓既有判断「判据进仓，呈现不进仓」，它应当**沿 `montage.py:283/284` 之间那条缝切开**
（283 是空行，284 是 `# 4) Render`；这一刀之上零 matplotlib、零写文件，之下全是）。
切法见第 4 节。

**这条切法本仓已经做过一次**，有现成先例：
`packages/host/stm-skills/src/l0/scan-prep-skills.ts:26-33` ——
旧仓 `_render` 走 matplotlib，盘点把它归 D 档，于是 `png_path` **恒为空串**、
`images` 恒为空表，而这**正好是旧仓自己的一条合法路径**（画不出来时 `return ""`）。
形状对得上，差的只是本仓永远走那一支。

## ④ 一个**决定**，不是一份代码：ML 回退壳

25 个里 9 个有 `model_path` 分支。先例已定，也在仓里：
`paper-image.ts:305-318`（`Denoise_AE`）—— **ML 那一支不移，只留回退，
并让 `method` 说实话**（返回 `'gaussian'` 而不是请求的那一条）。
抬头还点了名：同族的 `DetectAtomJump` 在同一位置说的是「请求的那一条」，
两个技能一个说实话一个说请求 —— 这条歧义已经登记过。

## ⑤ 还缺的共用件（真正要新写的，只有三小块）

| 件 | 谁要 | 规模 | 说明 |
|---|---|---|---|
| **运行模式读得到** | `CheckLineQuality`（`line_check.py:556`）· `AssessTip_VGG` · `AssessTip_ResNet`（经 `tip_assessment.py:181`） | `SkillContext` 加一个字段 | 见 ⚠️ 第 4 条：**内核那一半已经建好了** |
| `traceRetraceCorrelation` | `CheckLineQuality`（`line_check.py:418`） | ~30 行 | 二维支转发给**已有的** `fwdBwdInstability`（`vision/src/tip-metrics.ts:399`），只需写一维支 ＋ 分派 |
| `guardedParabolicMin` | `FitFano_Kondo`（`spectral_analysis.py:248`）· `FitGap_BCS`（`:454`） | ~40 行 | `_fit_utils.py:31-117`，87 行里 46 行是 docstring；**纯标量算术，零依赖** |

---

# 四、一页纸总表

**成本列 = 我自己要写的 TS 行数**，不含：
① `metadata` / `ParameterSpec`（`scripts/gen-skill-specs.ts` 从 `skills.json` **生成**，不手抄）；
② 本仓已有的数值原语与子技能；③ 注释搬运。

## A 档 —— 依赖全在本仓（7 个）

| 模块 | 技能 | 成本 | 卡在哪 |
|---|---|---|---|
| `scan_diff` | `DiffScans_ChangeDetect` | **~130** | 无。`driftXcorr` 已在 `paper-data.ts:391`，`loadImage2d` 已在，`.npy` 写已在。Python 侧 `diff_scans` 59 行（`scan_diff.py:220-278`）＋ 外壳 64（`:124-187`）＋ 防覆盖 30（`:189-218`） |
| `deconvolution` | `DeconvolveTip_RL` | **~110** | 无。`richardson_lucy` 50 行（`deconvolution.py:185-234`）＋ `make_gaussian_psf` 10（`:174-183`）＋ 外壳 66（`:107-172`）。`fftconvolve(x, psf, 'same')` ≡ `correlate2d(x, flip(psf))` —— 本仓 `correlate2d`（`numerics/src/correlate.ts:130`）正是**零补 + `'same'`**，形状与边界都对得上（差别只在 FFT vs 直接算的浮点，属容差） |
| `region_analysis` | `SegmentRegion_UNet` | **~50** | 无（只做启发式支）。`heuristic_segment` 7 行（`region_analysis.py:36-42`，`np.quantile` → 本仓 `percentile`）＋ 外壳 40（`:119-158`） |
| `region_analysis` | `DetectAtoms_FCN` | **~60** | 无（只做启发式支）。`heuristic_detect_atoms` 17 行（`:45-61`）要 `maximum_filter` → 本仓 `greyDilation`（`morphology.ts:121`）＋ `label` → `labelConnected`（`label.ts:41`）；外壳 34（`:252-285`） |
| `montage` | `ComposePanelMontage`（**判据层**） | **~180** | 无（呈现层单列 D 档）。四个纯计算 helper 58 行（`montage.py:58-115`）＋ 判据段 65（`:218-282`）＋ 返回 15（`:375-389`）。其中 `_rescale_to_ppnm`（`:103-115`）压着 `scipy.ndimage.zoom(order=1)`，本仓没有 `zoom` 但有 `mapCoordinates`（`interpolate.ts:214`，`order=1` 就够），自写双线性 ~50 行 |
| `spectral_analysis` | `FitFano_Kondo`（**砍 `hurwitz_fano`**） | **~200** | 无。`curveFit` 已在（`numerics/src/curve-fit.ts:198`，LM），而 Fano / Frota-Fano 两路**都不用 bounds**。`fit_fano` 86 行（`spectral_analysis.py:237-322`）＋ 两个线型 24（`:67-92`）＋ `lockin_convolve` 12（`:224-235`）＋ `_load_single_spectrum` 29（`:32-60`）＋ 外壳 33（`:171-203`）＋ `guardedParabolicMin` 40 |
| `autonomous` | `AtomManip_SAC`（**砍 SAC，只留直线回退**） | **~90** | 无。三个子技能 `SetBias` / `SetSetpoint` / `MoveToXY` **全部 done**。自算判据 82 行（`autonomous.py:1626-1706` ＋ `aggregate` `:1712-1737` ＋ 判定 `:1788-1800`），回退只有 `:1662`＋`:1664` 两行 |

**A 档合计 ≈ 820 行。**

## B 档 —— 差一件具体的东西（11 个）

| 模块 | 技能 | 成本 | 差的**那一件** |
|---|---|---|---|
| `tip_assessment` | `AssessTip_VGG` | **~110**（两个共用一份） | **运行模式**（`tip_assessment.py:181` `safe_mode_active()`）。其余全在：`fft2` ✓ `laplace2d` ✓ `gradient2d` ✓ `histogram` ✓；`np.partition` top-10（`:111`）改排序切片即可 |
| `tip_assessment` | `AssessTip_ResNet` | **~0**（见 ⚠️ 第 3 条） | 同上 |
| `line_check` | `CheckLineQuality` | **~270** | **运行模式**（`line_check.py:556`）＋ `traceRetraceCorrelation`（~30 行，二维支已有）。`judgeFrame` ✓（`frame-validity.ts:125`）`acquiredRowMask` ✓（`:194`）`fwdBwdInstability` ✓（`tip-metrics.ts:399`） |
| `drift_bragg` | `CorrectDrift_BraggPeak` | **~230** | **`mapCoordinates` 的 `order=3`**（`drift_bragg.py:322` 三次样条重采样）。本仓 `InterpOrder = 0 \| 1`（`interpolate.ts:87`），`order≥2` 要样条预滤波。其余全在：`fft2` ✓ `gaussianFilter2d` ✓ `greyDilation`（代 `maximum_filter`，`:139/152`）✓ `percentile` ✓ |
| `spectral_analysis` | `FitGap_BCS` | **~90** | **带 bounds 的 `curveFit`**（`spectral_analysis.py:441-443` 用 `bounds=([0,0,0,-inf],[e_range,e_range,inf,inf])`）。本仓 `curveFit(model, xs, ys, p0, {maxIterations, ftol})`（`curve-fit.ts:198-204`）**没有 bounds 形参** |
| `autonomous` | `FindGoodRegion_Heuristic` | **~100** | **`AssessImageQuality`（todo）**。判据全在：`findEmptySpot` ✓（`paper-data.ts:480`） |
| `autonomous` | `FindGoodRegion_UNet` | **~80**（砍 VM 支） | **`AssessImageQuality`（todo）**＋ 族内的 `heuristic_segment`（做 `SegmentRegion_UNet` 就有了） |
| `autonomous` | `ConditionTip_DQN` | **~110**（砍 DQN 支） | **`AssessImageQuality`（todo）**。回退是 `_select_pulse_voltage`（`autonomous.py:161-177`，10 行）。最易漏的是续跑跳步歧义 `:766-784`/`:813-821` |
| `autonomous` | `AutonomousSurvey_Scanbot` | **~120** | **`AssessImageQuality` ＋ `ConditionTip`（都 todo）** |
| `autonomous` | `ContinuousImaging_Auto` | **~90** | **`AssessImageQuality` ＋ `ConditionTip`（都 todo）**＋ 族内 `FindGoodRegion_Heuristic` |
| `autonomous` | `AutoOSS_Dehalogenation` | **~200** | **`AssessImageQuality`（todo）**。这一族最重的一个：反应判据双通道（Δquality `:2054-2055` ＋ 图像 MSE/方差比 `:2072-2083`）＋ 逐轮滚动基准 `:2101-2103` |

**B 档合计 ≈ 1400 行。** 其中 6 个只差同一件东西：`composite.assess_quality`。

## C 档 —— 压着一整个子系统（4 个）

| 模块 | 技能 | 压的是 | 出处 |
|---|---|---|---|
| `optimization` | `OptimizeResolution_BO` | **带 `return_std` 的 GP 回归（Matern ν=2.5 ＋ 超参 MLE 5 次重启）**＋ `scipy.stats.norm.cdf/pdf` | `optimization.py:477-482`、`:492`、`:501`。编排 ~300 行可机械翻译；数学 300-450 行（固定超参可压到 120-160）。**另差 `AssessImageQuality`** |
| `optimization` | `AdaptiveSTS_GP` | **同一份 GP（RBF 核）** —— 与上一个**共用一套 Cholesky ＋ 核矩阵，只差核函数一行** | `optimization.py:853-857`、`:942/961`。子技能**全在**。DKL 那 70 行（`:860-929`，torch＋gpytorch）**建议整块丢掉**：`:848-851` 本来就会静默降级到 sklearn，砍掉语义不变 |
| `spectral_unmix` | `UnmixSpectra` | **四个 sklearn 分解器**：`NMF` / `PCA` / `FastICA` / `GaussianMixture` | `spectral_unmix.py:200/208/215/223`。外加 `grid_to_spectra`（`:107`，本仓没有）。外壳 ~130 行 |
| `defect_cluster` | `ClusterDefects_rVAE` | **`PCA` ＋ `KMeans` ＋ `silhouette_score`** | `defect_cluster.py:167`、`:188/195/204/212`。外壳 ~100 行（`extract_patches` 16 行是纯切片） |

本仓机器学习栈是**零**：PCA / NMF / FastICA / GMM / KMeans / silhouette / GP 七项**全不在**
（全仓 grep 过）。唯一沾边的 `ransacPlane`（`numerics/src/fit.ts:208`）硬编码在平面模型上、换不了模型。

## D 档 —— 架构上不要（3 个技能 ＋ 1 个半技能）

| 模块 | 技能 | 为什么不要 |
|---|---|---|
| `imspec` | `PredictSpectrumFromTopo` | `model_path` **`required=True`**（`imspec.py:56-60`），`execute` 直接 `params["model_path"]`（`:96`），`imspec_predict` 第一行 `import torch` ＋ `torch.jit.load`（`:151/161`）。**零回退**。给不出模型就没有这个技能 |
| `region_analysis` | `PredictStructure_ASD` | `model_path` **`required=True`**（`region_analysis.py:364-369`），`execute:378-383` 缺了就直接失败。纯 torch（`:396-420`）。**零回退** |
| `region_analysis` | `IdentifyTopology_CARP` | `model_path` **`required=True`**（`:487-492`），`execute:510-515` 缺了就失败。压 **detectron2**（`:527-528`），装不上就 `ImportError` 返回（`:554-559`）。**零回退** |
| `montage` | `ComposePanelMontage` 的**呈现层** | 115 行 matplotlib（`montage.py:118-132` ＋ `:284-373` ＋ `:393-407`）。本仓**零绘图能力**（根 `package.json` 只有 `@types/node` / `@vitest/coverage-v8` / `typescript` / `vitest`；全仓无 `sharp`/`pngjs`/`canvas`）。而且**逐位对齐 matplotlib 不可能** —— 金样只能钉 `layout` / `shared_px_per_nm` / `panel_scalebars_nm` 这些数，钉不了像素。先例：`scan-prep-skills.ts:26-33` |

## 四档小计

| 档 | 技能数 | 自写 TS 行数 |
|---|---|---|
| A | **7** | ≈ 820 |
| B | **11** | ≈ 1400（＋ 三小块共用件 ≈ 90 行） |
| C | **4** | ≈ 660 外壳 ＋ **一个 GP 子系统（300-450）** ＋ **一个分解/聚类子系统** |
| D | **3**（＋ montage 的呈现半边） | 0 |

## 一条**所有 25 个都躲不掉**的固定成本

`status: done` 的四项 DoD（`scripts/build-progress.ts:14-22`）里，
`spec` 与 `traces` **都不是写代码能挣到的**：

- `spec` ← `packages/host/stm-skills/src/generated/specs.ts` 里有没有它。
  `scripts/gen-skill-specs.ts` 按**批次名单**生成（`:30/43/65/77/…/376`，`BATCH_4C` 在 `:376`）。
- `traces` ← `spec/golden/skill_traces.json` 里有几条。**实测：这 25 个一条都没有**
  （逐个查过，全部 `NOT PRESENT`；该文件 417 个键 = 417 个 done 技能，一一对应）。
  它由 `tools/spec-export/export_skill_traces.py` 的批次名单驱动（`BATCH_4C` 在 `:350-358`）。

所以每一批的固定动作是：**往两张名单里加名字 → 用旧仓 venv 跑两台导出器 → 金样入仓**。
`TRACE_SKIP` 现在是空集（`export_skill_traces.py:507`），没有人被排除。

真正的主判据还要第三台：`tools/spec-export/export_paper_data.py`
（批 4c 建的，`:520-655` 覆盖了已落的 9 个）。它**合成 `.npy`/`.sxm`/`.dat` 的字节、
让旧仓真技能跑一遍、连它写出去的文件一起录回来**（该文件抬头第 4 条纪律：
「只比 `data` 等于只比收据不比货」）。新一批的分析技能应当**加到这台里**，
而不是只靠通用驱动器 —— 通用驱动器给不出真实路径，录到的只是「文件读不动」那一支
（`export_skill_traces.py:359-363` 原话）。

---

# 五、共用底座清单

| 件 | 行数 | 状态 | 被几个 todo 技能用 |
|---|---|---|---|
| `loadImage2d`（`paper-common.ts:124`） | 全文件 193 | **已建（批 4c）** | **13 个直接 ＋ 3 个经 `_load_image_for_analysis`** |
| `loadSpectrum`（`paper-common.ts:148`） | 同上 | **已建** | 3（`FitFano_Kondo` · `FitGap_BCS` · `UnmixSpectra`） |
| `siblingNpy` + `matRows` + `encodeNpyFrame` | `paper-common.ts:176/187` ＋ `kernel/src/npy.ts:65` | **已建** | 4（`DeconvolveTip_RL` · `CorrectDrift_BraggPeak` · `PredictStructure_ASD` · `DiffScans_ChangeDetect`） |
| `GraphExecutor`（`kernel/src/graph-executor.ts:321`） | — | **已建**，8 个公开方法齐备，`runPlan` 同吃同步/异步迭代器 | **9**（autonomous 7 ＋ optimization 2） |
| `ctx.runSkill` → `runSub`（`skill-kernel.ts:254/742`）＋ `runSubSkill`（`composite/run-sub.ts:23`） | — | **已建**，12 个 composite 里 9 个在用 | 9 |
| ML 回退壳的**决定**（`paper-image.ts:305-318` 先例） | — | **已定** | 9（有 `model_path` 分支的） |
| — **以下是还要新写的** — | | | |
| 运行模式读得到（`SkillContext` 加字段） | ~15 | **缺**（内核那一半已在，见 ⚠️ 第 4 条） | 3 |
| `traceRetraceCorrelation` | ~30 | **缺**（二维支已有 `fwdBwdInstability`） | 1 |
| `guardedParabolicMin`（`_fit_utils.py:31`，87 行里 46 行是 docstring） | ~40 | **缺**，纯标量算术零依赖 | 2 |
| **带 bounds 的 `curveFit`** | ? | **缺** | 1（`FitGap_BCS`） |
| **`mapCoordinates` 的 `order=3`** | ? | **缺** | 1（`CorrectDrift_BraggPeak`） |
| **带 `return_std` 的 GP 回归**（Matern ＋ RBF 共用一套 Cholesky） | 300-450（固定超参 120-160） | **缺** | 2（两个 optimization 技能共用） |
| **PCA / NMF / FastICA / GMM / KMeans / silhouette** | ? | **缺** | 2 |
| 双线性 `zoom` | ~50 | **缺**（`mapCoordinates order=1` 拼得出来） | 1（montage 判据层） |
| 任何绘图能力 | — | **缺，且按判断不该有** | 1（montage 呈现层，D 档） |

**一句话**：这一族的底座**已经建好了**，缺的不是底座，是五件各自服务 1-2 个技能的数值原语。
按消融精神，那五件应该**跟着它们的消费方一起做**，不要先建。

---

# 六、A 档分批建议

分批的判据是**「每一批只拉一条新的共用件进来」**，这样一批红了知道是谁红的。

## 批 7a · 纯函数四件套（零新原语）

`DiffScans_ChangeDetect` · `DeconvolveTip_RL` · `SegmentRegion_UNet` · `DetectAtoms_FCN`

- 自写 ≈ **350 行**，四个技能。
- 一件新原语都不用拉：`driftXcorr` / `correlate2d` / `percentile` / `greyDilation` /
  `labelConnected` / `loadImage2d` / `.npy` 写 —— **全部已在**。
- 四个都是「一张图进来、几个数出去（＋ 有的落一个 `.npy`）」，
  与批 4c 那 9 个**同一形状**，能直接套 `export_paper_data.py` 的现成骨架。
- 顺带解锁：`heuristic_segment` 做完 ⇒ `FindGoodRegion_UNet` 的回退判据就有了。
- 要登记的 deviation：`SegmentRegion_UNet` / `DetectAtoms_FCN` 的 ML 支不移（照 `Denoise_AE` 的先例，
  且**要照它说实话那一条**，不要照 `DetectAtomJump` 说请求那一条）。

## 批 7b · 谱拟合两件（拉一件 `guardedParabolicMin`）

`FitFano_Kondo`（砍 `hurwitz_fano`）· ＋ 把 `FitGap_BCS` 一起带上**如果**顺手把 bounds 加进 `curveFit`

- `FitFano_Kondo` 自写 ≈ **200 行**，新原语只有 `guardedParabolicMin`（~40 行）。
- `FitGap_BCS` 只差 bounds。要不要在这一批加，取决于给 `curveFit` 加 bounds 的代价——
  Dynes 模型的四个参数里只有 `delta` / `gamma` 有上下界（`spectral_analysis.py:442-443`），
  最简的做法是**参数变换**（`delta = lo + (hi-lo)·sigmoid(θ)`）而不是改 LM 求解器。
  但那会改掉协方差矩阵的含义 —— **这件事要先想清楚再动**，否则 `delta_err` 就成了另一个数。
  所以我建议：**7b 只做 `FitFano_Kondo`**，`FitGap_BCS` 与 bounds 的判据单独一段。
- 要登记的 deviation：`hurwitz_fano` 那一支不移（差 `scipy.special.digamma`），
  而它是 `allowed_values=["fano","frota_fano","hurwitz_fano"]`（`spectral_analysis.py:143`）
  三选一里的一个 —— **参数表照抄，但选到它时要当场说清楚**，不要静默回退到 `fano`。

## 批 7c · montage 判据层（拉一件双线性 `zoom`）

`ComposePanelMontage`（判据层）

- 自写 ≈ **180 行**（含 ~50 行双线性重采样）。
- 呈现层照 `scan-prep-skills.ts` 的先例：`output_path` 恒为 `null`，
  其余 `n_panels` / `layout` / `shared_px_per_nm` / `panel_scalebars_nm` 照常给。
- ⚠️ 一个具体的坑：`panel_scalebars.append(sb_nm)` 在 `montage.py:339`，
  也就是**在绘图循环里面**，但它是 `_nice_scalebar_nm(fov_nm)`（`:338`）的纯函数结果。
  切掉绘图必须把这一行提到循环外，否则返回值里这个字段就没了。
  同理 `np.percentile` 的 1-99 拉伸（`:317-318`）算出的 `vmin`/`vmax` 也是**数**，
  该留在判据层、进返回值，让呈现层照着画。
- 这一批还要回答一个设计问题：**呈现层将来放哪**。我的建议是 SVG（~250-300 行，
  无二进制依赖、文本可 diff、比例尺与字母都好画），但那不属于这次盘点，
  也不该为了「全做」把一次不可测的像素比对塞进验收链。

## 批 7d · `AtomManip_SAC`（第一个 paper composite）

- 自写 ≈ **90 行**。三个子技能全部 done，`GraphExecutor` 齐备。
- 它的价值不在这一个技能，在于**它是这一族第一个走执行器的**：
  跑通之后，剩下 8 个 composite 就只差各自的子技能与数学。
- ⚠️ 这 9 个技能**全部 override 了 `run_composite`**，于是基类的 `_validate_products`
  （`composite/_base.py:281`）走不到 —— 也就是说**它们不过产物有效性闸**，
  返回数据里**没有** `aborted_by_operator` / `abort_reason` 顶层字段。
  本仓移植时要么照移这个「不过闸」，要么登记一条「补了闸」。**别默默补上。**

## 建议的第一批：**批 7a**

理由三条：
1. **零新原语** —— 四个技能一件共用件都不拉，红了只可能是判据本身红。
2. **形状与批 4c 完全一致** —— 金样导出器有现成骨架（`export_paper_data.py`），
   规格/轨迹两张名单加四个名字就行。
3. **一次把两个整模块清零**（`paper.scan_diff` 与 `paper.deconvolution` 各只有 1 个技能），
   模块完成数 +2，而 `paper.region_analysis` 的 4 个里去掉 2 个（剩下两个是 D 档，
   也就是说**那个模块的可移植部分这一批就做完了**）。

---

# 七、⚠️ 与现状不符

## 1 · 「这一族整族未开工」—— 不对，已落 26%

**任务书**：「`paper.*` 这一整族：13 个模块 / 25 个技能，全部 0/N —— 一个都没动过。
这是三族里唯一整族未开工的。」

**实测**（`spec/progress.json`，用 node 逐条读出）：
`paper.*` 是 **19 个模块 / 34 个技能，done=9**。

已落的 6 个模块：
`paper.atom_jump`(1/1) · `paper.background`(1/1) · `paper.data_processing`(4/4) ·
`paper.denoise`(1/1) · `paper.image_filters`(1/1) · `paper.scan_crop`(1/1)。

代码在 `packages/host/stm-skills/src/l0/paper-common.ts`（193 行）·
`paper-data.ts`（556 行）· `paper-image.ts`（344 行）· `paper-crop.ts`（353 行），
批 4c 落的，注册在 `l0/index.ts:177-179`。

**这条更正改变了第一批该做什么**：不需要先造底座，`loadImage2d` / `loadSpectrum` /
`.npy` 产出 / RANSAC / 逐行整平 / 相位互相关 / 形态学去条纹 **全都已经在了**。

## 2 · `PredictStructure_ASD` 与 `IdentifyTopology_CARP` 的**描述在说谎**

两个技能的 `description` 都写着：
> 「⚠️ No trained model ships with MAST — **without an explicit model_path this runs a
> rough heuristic** (not paper-grade ML)」

出处：`region_analysis.py:347-350` 与 `:470-473`（逐字相同的一段）。

**而代码里没有任何 heuristic**：
- `model_path` 的 `ParameterSpec` 是 `required=True`（`:369` 与 `:491`），
  于是 `BaseSkill.validate_params`（`base.py:63-66`）在 `execute` 之前就会拒；
- 就算绕过校验，`execute` 的第一件事是 `if not model_path: return SkillResult(success=False,
  error="model_path is required …")`（`:378-383` 与 `:510-515`）。

这两句描述**会原样出现在模型读到的工具 schema 里**（`spec/golden/tool_schemas_real.json`）。
移植时照抄它 = 把一句假话搬进本仓。建议：**照抄参数表，但这两句在 deviation 里点名**，
说明本仓也按代码走（缺 `model_path` 就拒），描述与行为的分歧是旧仓带来的。

## 3 · `AssessTip_VGG` 与 `AssessTip_ResNet` **逐字节相同**

`tip_assessment.py:24-36` 是旧仓自己写的（中文，2026-08-10）：
> 「**这两个技能的 `execute()` 归一化掉名字之后逐字节相同。**
> 不是「没权重时碰巧一样」：两条分支（启发式 / VisionModule）都是同一个函数，
> 后端也只有一个 tip 模型。所以名字里的 VGG / ResNet **在代码里没有对应物**。」

我核了：`:269-305` 与 `:382-418` 两个 `execute` 除 `skill_name` 外一字不差。
`metadata` 也只差 `name` / `description` 里的 "VGG"↔"ResNet" 与 `tags`。

**盘点后果**：这两个技能在总表里算 2 个，但**成本是 1 个**（一份实现挂两个名字）。
旧仓还记着「留下的是目录/命名问题（改名、合并还是删一个，是用户的决定）」——
移植时**不要替它做这个决定**，两个名字都注册，实现共用。

## 4 · SAFE 模式：**内核那一半已经建好了，就差一根线**

三个技能在 `execute` 里读运行模式来**翻转判决**：
`line_check.py:556`（`safe_mode_active()` 为真时把 `quality_ok` 从 False 翻成 True，
并把原判决落进 `safe_mode_raw`，`:566-570`）· `tip_assessment.py:181`
（经 `_safe_tip_verdict`，`:164-187`，服务两个 AssessTip）。

本仓现状：
- **有** `OperatingMode = 'SAFE' | 'SEMI' | 'AUTO'`（`kernel/src/safety.ts:32`），
  但它住在 `stm-safety` 的 Cordis 服务里（`stm-safety/src/plugin.ts:294` `this.currentMode`），
  只在**闸门**那一层用（`modeRefusal`，`safety.ts:264`）。
- **`SkillContext`（`skill-kernel.ts:198-258`）上没有任何模式字段** —— 技能读不到。
- **但是**：`AUDIT_ONLY_KEYS = ['safe_mode_raw', '_progress']`（`skill-kernel.ts:50`）
  **已经写好了**，注释是「技能结果里模型不该看到、但记录要留的键」。
  全仓 grep：`safe_mode_raw` 只出现在这一行和两条测试里 ——
  **今天没有任何技能产出它**。

也就是说：本仓的内核**预留了这三个技能的插座，而插头就在这一族里**。
这是一条「半建好」的状态，不是一条缺口，值得在动 `CheckLineQuality` 之前先说清楚
（加一个 `SkillContext` 字段是内核改动，会碰 K0–K18 那套机器）。

## 5 · `traceRetraceCorrelation` 的「未移植」记录**指的不是同一个函数**

`vision/src/tip-change.ts:259-273` 有一条显式记录：
> 「⚠️ **`tr` 通道没有移**（消融精神）……移它要的不是十行，是一整套 `rfft` / `irfft`
> 的逐行往返（本仓 `numerics` 没有 `irfft`，得现写一份）」

**那是另一个东西。** 那里说的 `tr` 是 `row_channels` 的第五个通道
（正反扫**逐行**最大归一化互相关）。

`CheckLineQuality` 在 `line_check.py:418` 调的是
`mast/vision/tip_metrics.py:241` 的 `trace_retrace_correlation` —— 而它
**二维输入直接转发给 `_fwd_bwd_instability`**（`tip_metrics.py:285-290`，
原话：「同一个概念不写第三份实现：一维用 `np.correlate`，二维转发给 `_fwd_bwd_instability`」），
而 `fwdBwdInstability` **本仓已有**（`vision/src/tip-metrics.ts:399`）。

`CheckLineQuality` 的 `fwd_lines` / `bwd_lines` 声明就是二维帧
（`line_check.py:252/258`「2D」），所以**走的正是已有的那一支**。
要新写的只有一维支（`np.correlate(mode='full')` ＋ 已有的 `detrend`，~25 行）＋ 分派（~5 行）。

**结论：这不是一个「差一整套 `irfft`」的技能。** 把那条记录直接套到 `CheckLineQuality`
头上会把它误判成 C 档。

## 6 · `paper.autonomous` / `paper.optimization` 的阻塞**在 `composite.*` 那一族**

7 个 autonomous 里 6 个、2 个 optimization 里 1 个，都排了
`AssessImageQuality`（`composite/assess_quality.py:92`）；另有 2 个排了
`ConditionTip`（`composite/condition_tip.py:57`）。

`spec/progress.json`：两个**都是 `todo`**（`impl=false`、`traces=0`）。

这条依赖**跨族**，不在本次盘点的范围里能解决。建议与盘点七的 `composite.*`
那一份对一次：如果 `AssessImageQuality` 排在它们那批的前面，
`paper.autonomous` 的 6 个就能从 B 档变成 A 档。

## 7 · `line_check.py` 开头 124 行里，**只有两个数**

`line_check.py:1-124`（`CheckLineQuality` 类之前）看起来像一张阈值表，
实际只有两条赋值：
- `_DEFAULT_CORR_THRESHOLD: float | None = None`（**第 92 行**，前面 `:24-91` 共 68 行
  `#:` 注释，全是「为什么撤回 0.40」的标定史）
- `_DEFAULT_MIN_CORRUGATION_M: float = 15e-12`（**第 122 行**，前面 `:94-121` 共 28 行注释）

这一段 97 行是注释、约 15 行 import、**2 行代码**。
两个常量各被引用两次（`:277`/`:290` 的 `ParameterSpec` 默认值、
`:405`/`:407` 的 `params.get` 兜底）—— **两处都要搬，缺一个就换掉了默认语义**。

而 `_DEFAULT_CORR_THRESHOLD is None` 是这个技能**三态判决**里的第三态：
`quality_ok` 会是 `True` / `False` / `None`，`None` 又分三种
（`unmeasurable` `:458-493` · `insufficient_corrugation` `:495-512` · `uncalibrated` `:514-526`），
**三种都返回 `success=True`**。移植时这五条出口路径是判决语义本体，不是错误处理。

## 8 · `_fit_utils.py` 的消费方**不在 `optimization.py` 里**

任务书把 `_fit_utils.py` 与 `optimization.py` 放在一起提。实测（在
`mast\skills\paper\` 下 grep 实际调用点，剔除 import 行）：

`guarded_parabolic_min` 的调用点只有两个，**都在 `spectral_analysis.py`**：
`:248`（`fit_fano` 里给 `e0` 初值做亚网格细化）与 `:454`（`fit_bcs_gap` 里算
`gap_edge_v_refined`）。`optimization.py` **一次都没调它**，`_fit_utils.py` 内部也没有。

所以它属于**批 7b（谱拟合）**，不属于 optimization。

## 9 · `line_check.py` 的入参声明**漏掉了一条真分支**

`metadata` 把 `fwd_lines` / `bwd_lines` 声明成 `type="str"`
（`line_check.py:250-259`），描述写「path to .npy or JSON array (2D)」。

但 `_load_array`（`:578-585`）实际吃**三种**：
`.npy` 路径 → `np.load`（`:581`）；其他 `str` → `json.loads`（`:584`）；
**非 `str`（list / ndarray）→ `np.asarray` 直接收**（`:585`）。

TS 侧若只按 schema 实现 `string`，会悄悄砍掉第三条分支。
本仓的口径是「schema 从金样生成、不手抄」，所以 schema 会是对的（`str`），
但**实现要不要收第三种**是一个要当场决定的事 —— 建议照移（旧仓的内部调用方可能走的正是它），
并在 deviation 里记一笔「声明与实现的分歧是旧仓带来的」。

---

## 附：这一族两句话

`paper.*` 是**「论文算法搬成技能」的那一堆**，它按来源分目录、不按形状分：
16 个是纯函数分析技能（吃文件路径、`context` 收下不用、与 builtins 同基类），
9 个是走 `GraphExecutor` 的自动化流程（与 composite 同基类，只排别人的技能、自己不发动词）。
它的共用底座是一条 IO（`load_image_2d` / `load_spectrum`）＋ 一条 `.npy` 产出，
**两条都已经在批 4c 建好并验收过了**；它压着的不是一个绘图层，而是**一个技能**里的 115 行 matplotlib。
