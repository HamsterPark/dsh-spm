# 批 6c 交接 —— 批 5b 欠下的数值原语（**3 / 4**）+ 晶格一族最便宜的那一个

落了 **4 个技能 / 3 个模块收口**，外加**四件判据本体**（旧仓 `mast/vision/` 的四个文件）
与**三件 numpy 原语**。

技能 **411 → 415**（分母 515），模块 **88 → 91**（分母 165），
测试 **5761 → 5926**（101 → 103 个文件），变异 **510 → 542 条全红**（基线干净，见 §4），
偏差登记 **+7 条**（编号留空）。

| 组 | 技能 | 模块 | 判据本体 |
|---|---|---|---|
| 判针尖（图） | `AssessTipSharpness` | `builtins.tip_sharpness` ✅ | `_edge_resolution` + `_fwd_bwd_instability` |
| 判针尖（谱） | `AssessTipFromSpectrum` | `builtins.tip_from_spectrum` ✅ | `assess_iz` + `assess_iv` |
| 力反演 | `InvertForceSaderJarvis` | `builtins.force_inversion` ✅ | `sader_jarvis` + `forward_df` + `_decay_length` + `invert_force_curve` |
| 多帧晶格 | `AssessAtomicConsistency` | `builtins.atomic_multiframe` **1/2** | `_independent_pair` + `collect_observation` + `assess_atomic_consistency` |

**没做的**：`AssessSpectrum`（批 5b 四个里的第四个，§5.1）·
`FindFlatRegion` · `AssessDomainPhase` · `CalibratePiezoMultiAngle`（§5.2）。
每一条卡在**哪个函数、多少行**都写在 §5。

---

## 0. 一句话

> 这一批的四个技能**一次 Nanonis 调用都不发**，判据全在磁盘上的那几个字节里。
> 于是力气分成两半：一半是 **850 行密集 numpy 的移植**，
> 另一半是**造出那些字节** —— 而后者才是判据在不在的地方。
> 三次「一格分辨不出两种候选」当场被逼出来（§4.1），其中一次是**变异演练**抓的、
> 一次是**金样第一次跑**就红的、一次是我在写容差时发现**分母配错了入口**。

---

## 1. 落地的件

```
新增（数值原语，对的是 numpy 本身）
  packages/host/numerics/src/calculus.ts        116  np.gradient(y, x)（非均匀分支）+ np.trapezoid
  packages/host/numerics/src/stats.ts           +65  np.corrcoef + corrcoefAbsTol

新增（判据本体 —— ⚠️ 四件都**该住进 `packages/host/vision/`**，见 §8）
  packages/host/stm-skills/src/l0/vision-tip-metrics.ts        254
  packages/host/stm-skills/src/l0/vision-spectroscopy.ts       236
  packages/host/stm-skills/src/l0/vision-force-inversion.ts    398
  packages/host/stm-skills/src/l0/vision-lattice-multiframe.ts 340

新增（技能外壳 —— 只做 IO 与阈值取用，一个判据都不写）
  packages/host/stm-skills/src/l0/analysis-tip.ts        444  两个判针尖的
  packages/host/stm-skills/src/l0/analysis-force.ts      275  Sader–Jarvis
  packages/host/stm-skills/src/l0/analysis-multiframe.ts 131  多帧一致性

新增（测试与金样）
  packages/host/stm-skills/src/l0/batch6c-units.test.ts   419
  packages/host/stm-skills/src/l0/batch6c-skills.test.ts  368
  tools/spec-export/export_batch6c.py                    1008
  spec/golden/batch6c.json                               4.1 MB / 12 节（重跑逐字节相同）
  packages/host/numerics/src/numerics.test.ts             +86（3 族）
  tools/spec-export/export_numerics.py                   +106（第 17 节，**纯插入**）
  spec/golden/numerics.json                             +1566 行（插入 1566 / 删除 0）
```

### 为什么 `gradient1d` / `trapezoid` / `corrcoef` 进 `numerics/`，而那四件没有

`nd.ts` 抬头那条标准：**它对的是 numpy 本身，还是本族的判据？**

| 件 | 对的是 | 容差 |
|---|---|---|
| `gradient1d` / `trapezoid` | `np.gradient` / `np.trapezoid` | **0**（累加与运算顺序照抄） |
| `corrcoef` | `np.corrcoef` | `corrcoefAbsTol(n)`（numpy 那次 `dot` 走 BLAS，顺序照抄不了） |
| `edgeResolution` / `assessIz` / `saderJarvis` / `assessAtomicConsistency` | 旧仓 `mast/vision/` 的**判据** | 各自一条，见 §2 |

Sader–Jarvis 不是一个 numpy 调用，它是一条物理反演 —— 所以它不该进 `numerics/`，
它该进 `vision/`（而这一轮 `vision/` 不归我，见 §8）。

---

## 2. 容差表（每行一句推导）

**每一条都写在被测件自己的 docstring 里**，测试里一个字面量容差都没有。

| 件 | 对的是 | 容差 | 一句推导 | 实测占比 |
|---|---|---|---|---|
| `gradient1d` | `np.gradient(y, x)` | **0** | 三个系数与 `a·f+b·f+c·f` 的相加顺序与 numpy 逐字相同；等距时**照抄它退回标量分支那一条** | 0 |
| `trapezoid` | `np.trapezoid(y, x)` | **0** | `d·(y[1:]+y[:-1])/2` 逐元素同式，求和走 `npSum`（成对，批 4b 已逐位） | 0 |
| `corrcoef` | `np.corrcoef(a,b)[0,1]` | `8·sumRelTol(n)`，**绝对** | 分子的成对求和误差 ≤ `sumRelTol·Σ\|a'b'\|`，而柯西–施瓦茨给 `Σ\|a'b'\| ≤ √(S_aa·S_bb)` ⇒ 对 `r` 的**绝对**贡献就是 `sumRelTol`；分母两个 `√` 再半份；减均值再两份 ⇒ `4·sumRelTol`，取 8 | — |
| `edgeResolution`（技能路径） | `tip_metrics._edge_resolution` | `16·eps32` | 旧仓整条链在 float32（scipy 保留 dtype）：两次可分离高斯 `18·eps32` → 中心差分不放大 → `0.8·step/gmax` 两份相对误差相加 ≈ `4·eps32`，取 16 | **0.032** |
| `edgeResolution`（判据本体） | 同上，**喂 float64** | `64·eps` | 这条路一次降精度都没有：两次 9 抽头高斯 + 一次差分 + `hypot` ≈ `20·eps`，取 64 | **0.028** |
| `fwdBwdInstability` | `_fwd_bwd_instability` | `8·eps32·log₂N`，**绝对** | 三次 complex64 变换各 `eps32·log₂N`、两条 float32 范数各一份 ⇒ `5·eps32·log₂N`；`\|max_ncc\| ≤ 1` 所以相对即绝对，取 8 | **0.0045** |
| `assessIz` / `assessIv` | 旧仓两个纯函数 | `512·eps` | 只有两处不逐位：`corrcoef`（`8·sumRelTol(64) = 384·eps`）与 `polyfit`（`lstsqObservedTol(κ)`，κ 实测 3.63 ⇒ `15·eps`）。取大的再留 1.3 倍 | **0.045** |
| `saderJarvis` / `invertForceCurve` | 旧仓 `force_inversion` | `16·sumRelTol(n)` | 两处 libm（`a**1.5` 与 Chebyshev 的 `cos`）各 1 ulp 进每个被积函数值；梯形本身逐位；`head+rest`、`cumsum`、正向那次 BLAS 点乘各一份 ⇒ `4·sumRelTol`，取 16 | **0.0020** |
| `decay_length_m` 与 `A/λ` | 同上 | `16 · forceAbsTolFactor(n)` | λ = −1/slope，而 slope 拟合的是 `log(−F)` —— **相对误差进对数是绝对扰动**，斜率对它的敏感度是 `1/Δ(log F)`（拟合窗内对数力的跨度）。最窄的一格跨度 0.9 ⇒ 实测放大 3.3 倍，取 16 | **0.21** |
| 多帧一致性一族 | 旧仓 `lattice_multiframe` | `CELL_REL_TOL`（批 4b 的 1e−9） | 数来自 K1，与批 4b 同族；本层自己只做 `norm` / `atan2` / `acos` / 成对归约，`16·eps` 那一档（`CONSISTENCY_REL_TOL`） | — |
| `verdict` / `reason` / `why` / `n_jumps` / `n_spikes` / `has_step` / `gated_criteria` / 全部报文 | —— | **0** | 标签、计数、是非题。给它们容差等于把「挑错了分支」藏起来 | — |

### `decayLengthRelTol` 是一条 **`savgolObservedTol` 形状**的容差

形状推得出来（`1/Δ(log F)` 的放大），常数量出来（3.3 倍），余量写明（5 倍）。
按 `numerics-3.md` 第六节第二条的标准，它**不是**「刚好让我这版通过的那个数」——
它红的时候该先问的是「是不是有人送进来一条更平的尾巴」。

### ⚠️ 一条**分母配错了入口**的容差（这一批新踩的）

`edgeResolution` 有两个入口，而它们的精度差六个数量级：
技能那条 `hn` 是 float32（`judgeFrame` 的残差 ÷ float32 的 std），判据本体那条是导出器
直接喂的 float64。第一版两边共用 `16·eps32`，于是判据本体那一节的实测占比是 **2e−10**
—— **五十亿倍余量，那样的断言等于没写**。

> 「一条容差要么推得出来，要么就别写」的另一面：
> **推得出来的那条要配对入口。** 同一个函数，换一个调用方就换一档精度。

---

## 3. 该登记成 deviation 的（**主线已编号并登记进 `spec/deviations.md`**）

| 临时号 | 一句话 |
|---|---|
| `D-FORCE-1` | **`InvertForceSaderJarvis` 真的把 F(z)/U(z) 落盘** —— 旧仓 `_save_curve` 里 `from mast.core._runtime_paths import project_root` **那个模块不存在**（全仓另外十几处写的都是 `mast._runtime_paths`），外面套着 `except Exception: return None` ⇒ `curve_path` 恒为 `None`，这个技能的曲线**一次都没产出过**。按 DoD ⑤ 不照抄 |
| `D-FORCE-2` | `ForceInversionResult.notes`（恒为 `{}`、无人读）**不实现** |
| `D-FORCE-3` | `forward_df` 的**小振幅极限**（`a < 1e-13`）不实现，改成抛 —— 那一支从这个技能出发不可达（声明下界就是 `1e-13`） |
| `D-SHARP-2` | 没有像素标度时 `verdict` 报 `no_step`，**而同一格的 `has_step` 是 `true`、`edge_resolution_px` 是个数**。照移未改 |
| `D-LATTICE-4` | `_UNUSABLE_REASONS` 里的 `"too_small"` 与 `find_lattice_peaks` 报的 `"image_too_small"` **对不上** ⇒「帧太小」被算成「可用帧上没有晶格」。照移未改 |
| `D-NUM-24` | `np.gradient(y, x)` 在**间距恰好相等**时退回标量分支 —— 那**换的是算法不是速度**，必须照抄 |
| `D-NUM-25` | `np.corrcoef` **给不出零容差**（numpy 那次 `dot` 走 BLAS） |

前两条 `D-FORCE` 与 `D-SHARP` / `D-LATTICE` 的分界值得记一笔：
**「旧仓这里写错了」与「旧仓这里的话自相矛盾」不是同一件事。**
前者改（曲线从来没落过盘，那是产品缺失）；后者照移（改掉的是**模型读的那一句**）。

---

## 4. 变异演练（**32 条，全部实跑到 red**；⚠️ **基线干净**）

```
pnpm build && pnpm gen:skills && pnpm gen:progress     # 先重跑生成物
node tools/mutate/run.ts <32 个 id>
… 基线（2 个 scope）          ← 没有「✗ 基线不干净」⇒ 两个 scope 在无变异的树上全绿
32/32 变红
```

**基线是干净的**（`run.ts` 的第四判据 2026-09-19 才加，它会在基线不为 0 时整趟拒跑）。
合并后的全量：`103 文件 / 5926 条` 全绿（改之前 `101 / 5761`）。

| 组 | id | 变红 | 拆掉会怎样 |
|---|---|---|---|
| numerics | `numerics-gradient-uniform-spacing-is-its-own-branch` | 1 | 等距格上退不回标量分支 ⇒ 差一两个 ulp。**只有等距那一格分得开** |
| | `numerics-gradient-coefficients-are-not-symmetric` | 1 | `a`/`c` 对调。等距格上 `a = −c`，看不出来 |
| | `numerics-trapezoid-weighs-by-the-spacing` | 1 | 把 `x` 当成 `dx=1` |
| | `numerics-trapezoid-sums-pairwise` | 2 | 顺序累加。只有 `cancelling`（301 项、横跨 1e16）分得开 |
| | `numerics-corrcoef-centres-its-inputs` | 2 | 不减均值 ⇒ `offset_mean` 上给一个合理的、接近 1 的数 |
| `_edge_resolution` | `edge-resolution-step-floor-is-a-real-gate` | 1 | 起伏 0.2 的图也报「边缘宽度」（在量噪声）。`low_contrast` 只踩这一道 |
| | `edge-resolution-outlier-ratio-is-six` | 3 | 纯噪声帧也报宽度。`noise` 只踩这一道 |
| | `edge-resolution-width-is-point-eight-of-the-step` | 12 | 每帧偏大 25%，报出来仍是合理的纳米数 |
| | `edge-resolution-smooths-at-one-pixel` | 12 | σ 是分辨率单位不是去噪旋钮 |
| `_fwd_bwd_instability` | `instability-zero-guard-is-not-a-physical-threshold` | 4 | 退回 2026-08-10 之前的 `1e-9` ⇒ 一块 1 pm 起伏的好表面被判 1.0（判决线 0.40 的拒绝一侧） |
| | `instability-allows-a-lateral-shift` | 3 | 平移窗收到 ±2 px ⇒ 真机 6–7 px 的快轴偏移让判据饱和 |
| | `instability-conjugates-the-second-frame` | 13 | 少那次共轭 ⇒ 算的是卷积不是相关 |
| `assess_iz/iv` | `spectro-iz-floor-follows-the-curve` | 3 | `log(I)` 前的门限改成绝对值 ⇒ 放大器本底被拟进指数 |
| | `spectro-jump-is-eight-mads` | 11 | `8·MAD → 3·MAD` ⇒ 干净单指数上也数出跳变 |
| | `spectro-iv-symmetry-is-antisymmetry` | 10 | `−I(−V)` 少了负号 ⇒ 每根针都「不对称」 |
| | `spectro-iz-sorts-by-z` | 1 | ⚠️ **第一轮是绿的**，见 §4.1 |
| | `spectro-iv-sorts-by-bias` | 1 | 同上的 I(V) 半边（`shuffled` 那一格是入口） |
| Sader–Jarvis | `force-first-interval-is-integrated-analytically` | 28 | 第一段区间不解析积分 ⇒ 前几个点的力全错，而曲线看起来正常 |
| | `force-last-point-copies-its-neighbour` | 27 | 末点置 0 ⇒ 势能的累积分整体偏 |
| | `force-energy-is-referenced-far-away` | 24 | `U` 不在远处归零 ⇒ 结合能量纲对、量级对、意义没了 |
| | `force-smooth-needs-five-points` | 1 | `>= 5` 那道门槛。`smooth_too_few`（传 4）与 `smoothed`（传 9）两格差的就是它 |
| | `force-unbracketed-well-is-undecidable` | 3 | 没夹住阱时报 `no_well` —— 一个**肯定**的结论替换了「没测到」 |
| | `force-residual-line-is-ten-percent` | 5 | 0.10 → 0.50。`slow_decay_ok`（0.094）与 `slow_decay_undecidable`（0.212）是线两侧的两格 |
| 多帧晶格 | `lattice-consistency-subtracts-the-scan-angle` | 1 | 不扣扫描角 ⇒ 同一个晶格在两个角度下被判「不是同一个」 |
| | `lattice-unusable-is-not-evidence` | 3 | 残帧被算成证据 ⇒ 2026-08-19 那次的形状回来 |
| | `lattice-pair-is-forced-obtuse` | 3 | 不统一成 120° ⇒ 下游解出残差为零的假剪切 |
| | `lattice-angle-spread-is-per-sixty-degrees` | 5 | 六倍角算完不除回 6 ⇒ 散布是真值的 6 倍，阈值 4° |
| 技能外壳 | `tip-sharpness-floor-is-two-pixels` | 2 | 采样极限写成 1× ⇒ 比 Nyquist 还细的阈值被当成判得了（真机 72 帧中位数 1.21 px：随便给个阈值每帧都「够尖」） |
| | `tip-verdict-unrated-needs-a-gated-criterion` | 2 | 「阈值都没填」与「每条都通过」合成同一个 `tip_ok`（两者 flag 数都是零） |
| | `tip-barrier-needs-a-fit-that-stands-up` | 4 | 在一条不是指数的曲线上拿「指数拟合的斜率」判针尖 |
| | `consistency-scale-must-match` | 2 | 两种取图混在一起判一致性 |
| | `consistency-needs-two-frames` | 3 | 单帧也给结果，而单帧回答不了这个问题 |

### 4.1 三次「一格分辨不出两种候选」，三种被发现的方式

**① 变异演练抓的：`spectro-iz-sorts-by-z` 第一轮是绿的。**

当时只有一格 `descending`（整条 z 反过来）。去掉 `argsort` 之后它的答案**一点没变** ——
序列反转时 `diff(ll)` 全部变号，而判据是 `|d − median(d)|`，`median` 也跟着变号 ⇒ **逐位相同**。
补了一格 `shuffled`（偶数点在前、奇数点在后）才有输入。

> 一格「恰好同解」的金样看起来在验那道闸，其实一个字都没说 ——
> 而它与「没录那一格」的区别是：**前者会让人以为验过了**。

**② 金样第一次跑就红的：`_independent_pair` 在 `angle0 = 0` 上是一次掷骰子。**

六个峰关于 kx 轴**完全镜像**时，三对候选里有两对的夹角偏差
（`|120.466 − 120|` 与 `|59.534 − 60|`）**逐位相等** —— 而 `acos(−x) = π − acos(x)`
只到舍入为止。谁赢由 V8 与 CPython 的 `acos` 最后一位决定，实测两边真的选了不同的一对。
取 `angle0 = 11°` 之后三对的偏差是 0.396 / 1.139 / 1.535。

> 这是 D-NUM-18 那条的第二例：**一格答案本身没有定义的金样，比一格分辨不出两种候选的更糟。**

**③ 写容差时发现的：同一个函数的两个入口精度差六个数量级。** 见 §2 最后一节。

### 4.2 三道**没有输入**的闸（照移，写下来）

`_edge_resolution` 的三道出局闸里，只有两道有「只踩它自己」的输入：

| 闸 | 有输入吗 | 为什么 |
|---|---|---|
| `step < 0.3` | ✔ `low_contrast` | —— |
| `gmax/gmed < 6` | ✔ `noise` | —— |
| `gmax < 1e-6` | ✘ **被另外两道挡住** | 要 gmax < 1e−6 **且** step ≥ 0.3，意味着一个 0.3 的跨度摊在 30 万个像素上。64² 的帧上不可能 |
| `clip(..., 0.5, ...)` 的**下界** | ✘ | σ=1 高斯之后一个台阶的峰梯度约 `0.4·H` ⇒ `0.8·H/(0.4·H) = 2.0`，够不到 0.5 |
| `clip(..., rows/2)` 的**上界** | ✘ | 要 `0.8·step/gmax > rows/2` 就得让梯度摊到 60% 以上的帧宽，而那时 `gmax/gmed ≈ 1` ⇒ 先被第二道挡掉 |

同批 4b §9② 的「**一道闸可以被另一道闸挡住，于是它永远不做决定**」。
覆盖率对这三道一言不发（那几行都跑到了）。**没有为它们编金样** —— 编不出来。

同一形状的还有一处：`InvertForceSaderJarvis` 的 `f_min >= 0 ⇒ no_attractive_minimum`
那一支**这一批没走到**。Δf 单调时极小必在端点 ⇒ 先被 `df_min_at_edge` 接走；
Δf 有内部极小时反演出的力几乎必有负极小。要走到它，得造一条「Δf 有内部极小、
而反演出的 F 全程为正」的曲线 —— 我没构造出来，写在这里。

---

## 5. 没做完的（逐条，卡在哪个**函数**上）

### 5.1 `AssessSpectrum` —— 批 5b 四个里唯一没落的那个

| 缺的函数 | 行 | 状态 |
|---|---|---|
| `spectroscopy.assess_iv` + `assess_iz` | 79 | ✅ **本批已落**（`vision-spectroscopy.ts`） |
| `resolve_spectrum_kind` | 44 | ✘ |
| `assess_spectrum_quality` | 219 | ✘ —— 一族**判据环**（谱型识别 → 饱和比 → 信噪 → 回滞），与批 4b 的 `atomic_phase` 同形 |
| `saturation_frac` | 37 | ✘ |
| `spectrum_snr` | 27 | ✘ |
| `assess_hysteresis` | 42 | ✘ |
| `io/exp_map.extract_dat_position` | 24 | ✘ |
| 技能本体 `spectrum_assess.py` | 369 | ✘（`_pick_directional` / `_header_kind` / 三个 patterns 表**本批已落**在 `analysis-tip.ts` 里，可直接搬） |

**剩余 ≈ 393 判据行 + 369 技能行**（批 5b 报的 544 里有 117 是 `assess_iv/iz`，本批付掉了）。
**零 scipy**，`.dat` 读取与列名解析本批也已落 —— 它现在是一个**纯判据环**的移植，
而那种东西的成本不在行数，在「两条判据咬在一起」的用例（批 4b §8③）。

### 5.2 其余三个

| 技能 | 卡在哪个函数 | 规模 |
|---|---|---|
| **`FindFlatRegion`** | `seg_scale_adaptive.kde_layers`(15) → `_hist_modes`(30)（要 `find_peaks`，**已有**）。`tilt.noise_floor` / `plane_subtract` / `judge_frame` / `parse_xy_meta` / `px_to_m` **全已落** | 数值缺口只剩 **45 行**（批 4b 报 50，实数 45）。真正的成本是技能自己的 **827 行**（十一个参数、`exclude_used_spots` 的会话态、`same_terrace` 的层归属）。**这一批没碰，因为那 827 行与本批四个技能一件共用件都没有** |
| **`AssessDomainPhase`** | `domain_phase.extract_fingerprint`(233) + `ring_peaks`(80) + `classify`(84) + `domain_reference.load_reference`(28，一个跨会话的**参照系存储**) | 判据 ≈397 行纯 numpy；存储那一半是 D-VAC-1 的形状（注入）。`load_reference` 取不到时回 `None`，而 `classify(fp, None)` **仍然出数** ⇒ 可以先移判据、把存储做成注入（批 4b 的原话，本批复核属实） |
| **`CalibratePiezoMultiAngle`**（`atomic_multiframe` 的第二个） | `lattice_calibration.solve_affine`(96，`scipy.optimize.fsolve` 的**多分支求根**) + `calibrate_multi_angle`(186) + `angle_conditioning`(22，要 `np.linalg.cond` 的 SVD) + `_match_to_reference`(22) | 所以这个模块本批**到不了 complete**（1/2）—— 同批 4b 的 `atomic_lattice`（2/3）。⚠️ 本批**没有**移 `angle_conditioning`：它的唯一消费方就是 `calibrate_multi_angle`（消融精神） |

⚠️ **`AssessAtomicPhase` / `AssessHerringbone` 一个字节都没碰** ——
批 4b 已核实它们是 C 档（第一行就调 `resolve_substrate` → 30570 行知识库 + 17 MB JSON）。
本批复核了一遍：`herringbone.py` 的七个判据函数确实自足，卡的仍然只有那一层。

### 5.3 其余欠账

| 欠的 | 写在哪 |
|---|---|
| **DoD ⑦ 技能卡片** | 本仓**还没有** `scripts/gen-skill-cards.ts`（PLAN §6.2 列了，从没建过）。批 3g–5c 同样没做，这一批照旧 |
| `InvertForceSaderJarvis` 的 `direction` 参数 | 旧仓**声明了但一次都没读**。spec 照抄（DoD ①），实现照抄那份「不读」，在代码里写明。自作主张给它加语义会让金样每一格都对不上 —— 那不是修 bug，是换一个技能 |
| `amplitude_source: 'instrument_profile:*'` 那一档 | 没有金样：导出环境里 `MAST2_PROJECT_ROOT` 指向临时目录 ⇒ 档案是空的。要一格得先在导出器里写一份档案，而那会牵动 `export_instrument_profile.py` 那一族 |
| `_fwd_bwd_instability` 的**空窗**回退（`win.size == 0` ⇒ 用全局 max） | 实现了，没有输入：它要 `H ≤ 3`，而本批最小的帧是 48² |
| `np.gradient` 的**标量间距**入参 | 没实现。它与「等距数组」那一档**数值同解**（numpy 自己就是这么归并的）⇒ **分不开**，差别只在签名 |
| `trapezoid` 的 `dx=` / `axis=`、`gradient` 的 `edge_order=2` / 多维 | 各自「要什么金样」写在 `calculus.ts` 抬头那张表里 |

---

## 6. stmsim e2e（**0 条，而且不该有**）

四个技能**一次 Nanonis 调用都不发**，读的是磁盘上的 `.sxm` / `.dat`。
在模拟器上跑它们，跑的是我自己合成的那份字节，而那份字节已经被旧仓亲自读过一遍了
（批 4a / 4b 同一条理由）。

⚠️ 这与「stmsim 没有那个模块 ⇒ 只对 SpecEchoServer 做 e2e」不是同一种情况：
那种是**模拟器缺能力**，这种是**技能不碰仪器**。

`skill_traces.json` 里这四个录到的是「文件不存在」那一支（导出器的 `_params_for` 给不出
真实路径）—— **那仍然是一条判据**（外壳在碰任何东西之前先拒），
但这一批的主判据在 `spec/golden/batch6c.json` 的 `skills` 节：**62 格**，
拿真的合成字节喂进旧仓四个技能录的。

---

## 7. 金样怎么来的

`spec/golden/batch6c.json`（新，4.1 MB，12 节，**重跑逐字节相同**，md5 两次一致）。

* **帧与谱都是闭式合成**（`sin`-hash 噪声，零随机数），与 `export_analysis.py` / `export_lattice.py` 同一条；
* **判据本体那几节的帧，一律从 `.sxm` 的字节读回来**，不用手里那份 float64 原件。
  第一版喂的是原件，于是那一节的答案与技能那一节**对不上，而两节看起来都「对」**；
* **`polyfit` 的条件数与解向量分量比随每一格录**（一层包装拦住 `np.polyfit` 的每次调用）。
  容差里唯一的未知数因此不是未知数 —— `assess_iz/noise` 那一格的 `coef_ratio` 是 **96**，
  它解释了「为什么那一格最松」；
* **产物目录归一**：`InvertForceSaderJarvis` 落的 `artifacts/force_inversion/*.json`
  两侧都换成 `<artifacts>`（旧仓根是 `project_root()`，本仓是 `process.cwd()`，注入口
  `makeInvertForceSaderJarvis({ curveDir })`，同 `frames.ts` / `readback-stream.ts` 的体例）。

几格**专门为一道闸造的**输入：

| 格 | 它分得开什么 |
|---|---|
| `fwd_bwd_instability/quiet_pm`（1 pm 起伏） | `na ≈ 4.8e−11` **落在 `1e-9` 与 `1e-30` 之间** —— 2026-08-10 那条「绝对阈值卡在物理量上」的唯一可分辨输入 |
| `fwd_bwd_instability/shift_4px` 与 `shift_12px` | 平移窗（`0.12 × 48 = 5` px）的里外各一格 |
| `edge_resolution/low_contrast` 与 `noise` | 三道出局闸里**有输入**的那两道，各只踩自己 |
| `invert/slow_decay_ok`(0.094) 与 `slow_decay_undecidable`(0.212) | 正向残差 0.10 那条线的两侧，**同一条曲线只改振幅** |
| `invert/smooth_too_few`(4) 与 `smoothed`(9) | `smooth_points >= 5` 那道门槛的两侧 |
| `assess_iz/shuffled`、`assess_iv/shuffled` | `argsort` 的唯一入口（递增/递减都同解） |
| `consistency/consistent_rotated` 与 `rotated_but_angles_zero` | 「取向先扣掉扫描角」的两侧，**同一批帧只改角度** |
| `sxm/half_nan_*`（下半帧写 NaN） | `n_unusable` 的唯一入口（`.sxm` 的未扫区通常是零不是 NaN，批 4b 记过那一支一格都没有） |
| `sxm/dead_flat`（**恒定值**）与 `plane_big`（大斜面） | `judgeFrame` 两档拒判的两句不同的话。⚠️ 第一版用「小斜面」，而字节是 float32 写的 ⇒ 量化噪声 / ptp = 6e−7 > 1e−7 ⇒ **判可用**，那条路一格都没走到 |
| `calculus.trapezoid/cancelling`（301 项、横跨 1e16） | 成对求和 vs 顺序累加（普通输入上同解） |
| `calculus.gradient/uniform` 与 `nonuniform` | numpy 那条「间距相等就退回标量」的分支（非等距上一眼看得出，等距上只差最后一位） |

`spec/golden/numerics.json` 第 17 节（`calculus`）**追加在末尾**，于是那条共用的 `rng` 流
一格没动：`git diff` 是 **1566 插入 / 0 删除**（`numerics-3.md` 第六节第三条）。
⚠️ 重跑 `export_numerics.py` 前后其余 26 节**逐字节没变**（先备份后 diff 验过），
所以本机的 numpy 2.4.4 与金样里记的版本给出同一批数。

---

## 8. ⚠️ 哪些件**该进 `vision/` 而我没放**（留给主线）

**`packages/host/vision/` 这一轮由批 6b 主用，本支线一个字节都没碰。**
下面四个文件现在住在 `packages/host/stm-skills/src/l0/`，每一个的抬头都写着这件事。

| 现在在哪 | 该去哪 | 第二个消费方 | 搬家成本 |
|---|---|---|---|
| `l0/vision-tip-metrics.ts` | `vision/tip-metrics.ts`（**并进那个文件**，它已经住着同一个 Python 文件的 `detrend32` / `fftSharpness`） | `PreScanCheck`（批 4d §5.2 在等 `_fwd_bwd_instability`） | 机械移动 |
| `l0/vision-spectroscopy.ts` | `vision/spectroscopy.ts`（新文件） | `AssessSpectrum` 的 `assess_spectrum_quality` 里各调一次 | 机械移动 |
| `l0/vision-force-inversion.ts` | `vision/force-inversion.ts`（新文件） | 暂无第二个 —— 但它是旧仓 `mast/vision/` 的文件，判据层归属清楚 | 机械移动 |
| `l0/vision-lattice-multiframe.ts` | `vision/lattice-multiframe.ts`（新文件） | `CalibratePiezoMultiAngle`（§5.2） | 机械移动；它的**依赖已经全在那个包**（`findLatticePeaks` / `assessAtomicPhase`），只有它自己在外面 |

**四个文件都是零技能层依赖**（只 import `dsh-spm-numerics` / `dsh-spm-vision` / `dsh-spm-kernel`），
所以搬家 = 移文件 + 改 `vision/src/index.ts` 的四行 `export *` + 改
`l0/index.ts` 与两份测试的 import 路径。`batch6c-units.test.ts` 整份跟着搬。

⚠️ 搬之前先看一眼批 6b 有没有在 `vision/` 里也落了 `tip-metrics` 的东西 ——
`PreScanCheck` 那条链正是它的题目。

---

## 9. 值得进课时的四件

### ① 一个「恰好同解」的金样，比没有那一格更坏

`spectro-iz-sorts-by-z` 第一轮是绿的，而当时那一格叫 `descending` ——
一个看起来专门为「排序在不在」造的名字。它同解的理由很干净：
序列反转让 `diff` 全部变号，而判据是 `|d − median(d)|`，`median` 也跟着变号。

三件事叠在一起才形成这个陷阱：**名字像在验那道闸**、**答案确实录对了**、
**代码里那一行确实跑到了**（覆盖率 100%）。三样都对，而那道闸没有人在看。

> 「变异跑出绿色 = 这条闸不存在」（green-8）说的是**结论**。
> 这一次的补充是**前兆**：一格金样的名字里带着「专门为 X 造的」，而它与基准格
> 的答案**逐位相同** —— 那就是它。**逐位相同是一条可以自查的指纹**，
> 不必等到变异演练。

### ② 「掷骰子」有两种，而第二种在金样里看不出来

批 4a 记过第一种：`argmax` 的冠军只领先一两个计数。
这一批撞到第二种：**候选之间的排序键在数学上恰好相等**。

`_independent_pair` 在 `angle0 = 0` 的六角帧上，两对候选的夹角偏差是
`|acos(−x)·k − 120|` 与 `|acos(x)·k − 60|` —— 数学上相等，浮点上差最后一位，
而 V8 与 CPython 的 `acos` 各差 1 ulp。于是**同一份输入、同一份代码逻辑，两边选了不同的一对**。

两种的区别在于**能不能靠加大对比度躲开**：
第一种可以（把冠军的领先做到两个量级，批 4b 就是这么办的）；
第二种不行 —— 对比度再大，对称性还在。躲开它的办法是**破坏对称性本身**（取 11° 而不是 0°）。

> 造金样时问的那句「哪一格能把我可能犯的那个错照出来」，还要跟一句：
> **「这一格里有没有两条路在数学上恰好一样长」。**

### ③ 同一个函数的两个入口，可以差六个数量级的精度

`edgeResolution` 经技能进来时 `hn` 是 float32，经金样的判据本体进来时是 float64。
第一版两边共用一条 `16·eps32` 的容差，判据本体那一节的实测占比是 **2e−10**。

它不会红，看起来也完全正常 —— 一条有推导、有出处、写在 docstring 里的容差。
坏就坏在**推导是对的，只是对的是另一个入口**。

> `numerics-3.md`「一条推不出来的容差宁可不写」；
> 批 4b「一条推得出来的容差，也可能在问错的问题」；
> 这一条是第三面：**一条推得出来、也在问对问题的容差，可能配错了调用方。**
> 三条合起来是同一句话：**容差是一个三元组（量、误差来源、入口），缺一不成立。**

### ④ 「旧仓写错了」与「旧仓自相矛盾」是两种东西，处置相反

这一批两样都遇上了：

| | 现象 | 处置 |
|---|---|---|
| **写错** | `_save_curve` 的 import 路径指向一个不存在的模块，外面套着 `except: return None` ⇒ F(z)/U(z) **从来没落过盘** | **改**（DoD ⑤：缺陷判据不照抄） |
| **自相矛盾** | 没有像素标度时 `verdict = no_step` 而同一格 `has_step = true` | **照移**（改掉的是模型读的那一句） |

分界不是「哪个更像 bug」，是**产品在不在**：
第一种缺的是一个**产物**（曲线），谁都没见过它，改了不会让任何人读到不同的话；
第二种缺的是**一致性**，而那两句话已经在金样里、在模型的上下文里。

一条推论：**`except Exception: return None` 会把一个 import 错误藏三个月。**
旧仓那个 `_save_curve` 的每一行都是对的，错的是它 import 的那个模块名 ——
而那个 `except` 让它看起来只是「这台机器上没配产物目录」。

---

## 10. 给合并方的提醒

- **只动了锚点**：`l0/index.ts` 三处 `批 6c` · `gen-skill-specs.ts` 的 `BATCH_6C` ·
  `export_skill_traces.py` 的 `BATCH_6C` · `mutations.ts` 的 `批 6c` 注释锚点 ·
  `spec/deviations.md` 的 `批 6c` 注释锚点 · `spec/golden/README.md` 的 `批 6c` 注释锚点。
  **`kernel/src/index.ts` 没动**（这一批一件都没进 kernel —— 四件判据都带 numpy）。
  **`3g`–`5c` 与 `6a`/`6b` 一个字没碰。**
- **锚点之外动过的共享文件**（都是追加）：
  - `packages/host/numerics/src/{index.ts, stats.ts, numerics.test.ts}` ——
    `index.ts` 加两行、`stats.ts` 末尾追加 `corrcoef` + `corrcoefAbsTol`、
    测试末尾追加三族。**这一轮 `numerics/` 归本支线**（任务书原话）；
  - `tools/spec-export/export_numerics.py` 与 `spec/golden/numerics.json` ——
    第 17 节**全部追加在末尾**，diff 是 1566 插入 / 0 删除。
- **`packages/host/vision/` 与 `packages/host/kernel/` 一个字节都没动。**
  `tsconfig.json` / `vitest.config.ts` / `pnpm-lock.yaml` / `package.json` 全部原样（没有新包）。
- `spec/golden/batch6c.json` 与 `tools/spec-export/export_batch6c.py` 是本支线独有的新文件。
  **重跑逐字节相同**（md5 两次一致，已验）。
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑；
  合并后请**统一再跑一次**：
  ```
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  node scripts/gen-skill-specs.ts
  node scripts/build-progress.ts
  ```
- ⚠️ **合并之后把 32 条变异再跑一遍**：其中 5 条打在 `numerics/` 的共享件上
  （`calculus.ts` / `stats.ts`），别的支线如果动了那两个文件，`find` 串会不再唯一命中
  ⇒ 判 `inconclusive`。
- ⚠️ **一条与本批相关、合并方会撞到的观察**：`lattice-skills.test.ts`（批 4b）的
  `AssessAtomicResolution/hex` 那一格单跑 4–6 秒，**在满载的机器上会顶穿 vitest 的 5 秒缺省超时**。
  批 5b §9 已经记过同一格（它说 `--coverage` 下 6.35 s）。这一批为此**把自己的测试砍过一刀**：
  `assess_atomic_consistency` 的十一格逐格比对从判据本体那一份里拿掉了
  （技能那一份 15 格逐格覆盖同一条链），本支线两个文件的测试时间从 **13.8 s 降到 4.6 s**。
  即便如此，机器同时跑别的支线时仍撞到过三次超时（**全是超时，不是断言**）；
  空闲时 `103 文件 / 5926 条` 稳定全绿。
  **该改的是 `vitest.config.ts` 的 `testTimeout` 或给那一格挂显式超时 ——
  两样都不该由本支线单方面改**（批 5b 的原话，本批同意）。
