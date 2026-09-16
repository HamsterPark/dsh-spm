# 交接：数值底座的四件缺件（+ savgol）

接 [`numerics.md`](numerics.md) / [`numerics-2.md`](numerics-2.md)，把
`docs/handoff/survey-remaining.md` B 档里**杠杆最大的四件**补上，外加自成一体的
`savgol_filter`。

包还是 `packages/host/numerics`，**零 dsh 依赖、零 I/O、零新 npm 依赖**。
numerics 的测试从 152 条涨到 **245 条**，全仓 4034 → **4127 条**，全绿。
金样从 18 节 1736 KB 涨到 **24 节 2283 KB**，重跑逐字节相同（md5 两次一致）。

> ✅ 金样的 `versions` 这次**没变**（numpy 2.4.3 / scipy 1.17.1 / skimage 0.26.0），
> 与 `numerics-2.md` 那条提醒里的一致。
> 而且 `git diff` 是**纯插入**（新增 18851 行、删除 **0** 行）—— 新节全部追加在
> `export_numerics.py` 末尾，于是那条共用的 `rng` 流一格没动，已有 18 节的数据
> 逐字节没变。**这是给下一个人加节时的做法**：往中间插一次 `rng` 调用，
> 后面每一节的数都会跟着变，而那次改动在 diff 里看起来像「金样全变了」。

---

## 一、这一轮补了什么

| 件 | 文件 | 解锁 |
|---|---|---|
| `find_peaks`（`prominence` / `distance` / `width`） | `peaks.ts`（新） | **7 个**：AnalyseAtomicLattice · AssessAtomicResolution · AssessAtomicConsistency · AssessHerringbone · AssessDomainPhase · FindFlatRegion · AssessAtomicPhase |
| `curveFit` 回 `pcov` / `perr` | `curve-fit.ts`（改） | **3 个**：FitFano_Kondo · FitGap_BCS（另需 bounds）· FindSpectralPeaks |
| `correlate2d(mode='same')` | `correlate.ts`（新） | **2 个**：ComputeDriftVector · TrackDrift_ReferenceScan |
| 非归一化互相关 + `error` / `phase` + hanning 窗 | `fft.ts`（改）+ `correlate.ts` | **2 个**：CorrectDrift_XCorr · DiffScans_ChangeDetect |
| `savgol_filter` + `polyfit` / `polyval` | `savgol.ts`（新） | 补齐 FindSpectralPeaks 的数值侧（另见 §5） |
| Cholesky 分解与前代回代抽成共用 | `fit.ts`（改） | 上面两件各用一次 |

---

## 二、容差表（每行一句推导）

照旧：**每一条都写在被测函数自己的 docstring 里，连同推导**；
测试引用那些常量与函数，**没有一个字面量容差**。

| 件 | 对的是 | 容差 | 推导 |
|---|---|---|---|
| `findPeaks` 的 `peaks` / `leftBases` / `rightBases` | `scipy.signal.find_peaks` | **0** | 它们是整数下标。一个「差不多的下标」不是精度问题，是另一个峰 |
| `findPeaks` 的 `prominences` | 同上 | **0** | `x[peak] − max(left_min, right_min)`：**两个操作数都是输入数组里的元素原样**，中间只有一次 IEEE 减法。没有累加、没有相消放大 |
| `findPeaks` 的 `widths` / `leftIps` / `rightIps` / `widthHeights` | 同上 | **保证 `8·eps`**<br>**实测 0** | 每个数至多 5 次舍入：`height = x[peak] − prom·0.5`（`·0.5` 是 2 的幂，精确）、`height − x[i]`、`x[i±1] − x[i]`、一次除法、一次加减。界 `5·eps`，取 8 留余量；运算顺序照抄 scipy ⇒ 实测逐位相同 |
| `correlate2d` · 小整数输入 | `scipy.signal.correlate2d` | **0** | 乘积与部分和都在 `2⁵³` 以内 ⇒ 浮点加法在整数上是精确的 |
| `correlate2d` · 浮点 | 同上 | `convRelTol(taps)` = `4·(Mb·Nb)·eps` | 每个输出是 `taps` 次乘加的顺序累加，界 `taps·eps`。与 `filters.ts` 共用同一条式子：两处的 k 都是「一个输出经过多少次乘加」 |
| `hanning` | `numpy.hanning` | `2·eps`（相对，按窗的尺度 1 归一） | 唯一误差源是 `cos`：V8 与 C 的 libm 都不是正确舍入的，差至多 1 ulp；`\|cos\| ≤ 1` ⇒ 绝对 ≤ `eps`，乘 0.5 ⇒ `0.5·eps`。4 倍余量 |
| `phaseCrossCorrelation` 的 `phase` | `skimage.phase_cross_correlation` | `fftRelTol(N)`，**绝对**（弧度） | 一个复数的相对误差 `δ` 最多把辐角挪 `δ` 弧度 |
| `phaseCrossCorrelation` 的 **`error²`** | 同上 | `32·fftRelTol(N)`，**绝对** | `CCmax` 经两次 `fft2` + 一次 `ifft2` ⇒ `3·fftRelTol`，平方 ⇒ `6`；两条功率和各 `2·fftRelTol + sumRelTol = 3`，相乘 ⇒ `6`；合计 `12·fftRelTol`，取 32（约 2.7 倍余量） |
| `curveFit` 的 `pcov` / `perr` | `scipy.optimize.curve_fit` | `pcovRelTol(relStep) = 4·0.05·relStep`，`relStep = max(perrᵢ/\|pᵢ\|)` | `sse/(n−p)` 那一项已由「SSE 相对差 ≤ 1e−9」那条断言盖住；`(JᵀJ)⁻¹` 那一项由「参数差 < `0.05·perr`」定：`ΔJ/J ≲ \|Δp\|/\|p\|`，`Δperr/perr ≲ ΔJ/J` |
| `polyfit` | `numpy.polyfit` | `lstsqRelTol(κ)`（保证）+ `lstsqObservedTol(κ)`（实测） | 走正规方程 ⇒ κ 平方；两条各管一件事，同 `fit.ts` |
| `savgolCoeffs` | `scipy.signal.savgol_coeffs` | `4·κ(A'A'ᵀ)·eps` | 解的是 `A'A'ᵀ z = y'`，**κ 不平方**（那个矩阵本来就是要解的那一个，不是又乘出来的） |
| `savgolFilter` | `scipy.signal.savgol_filter` | 三项之和（保证 / 实测两条） | 系数 `4·κ_N·eps` + 中间那段 `convRelTol(w)` + 两端 `lstsqRelTol(κ_E)`（正规方程，**这个要平方**） |

### 实测水平（这台机器，2026-09-16）

**一条没人量过的容差只是一个数。** 每一条都测了：

| 件 | 实测 | 容差 | 占比 |
|---|---|---|---|
| `findPeaks` widths 一族 | **0** | `1.78e−15` | 0 |
| `correlate2d` 整数七格 | **0** | — | — |
| `correlate2d` 24×20 浮点 | `3.2e−16` | `4.26e−13` | `7.5e−4` |
| `hanning` 八个窗长 | **0** | `4.44e−16` | 0 |
| xcorr `error²` | — | — | `5.9e−4` |
| xcorr `phase` | — | — | `1.7e−2` |
| `pcov` / `perr` | `3.6e−6` | `1.97e−3` | `1.8e−3` |
| `polyfit` deg 1/2/3 | `6e−16 … 1.9e−14` | 实测那条 | `0.21 … 0.43` |
| `savgolCoeffs` | `1.1e−15 … 5.5e−15` | `6.7e−15 … 2.3e−14` | `0.05 … 0.26` |
| `savgolFilter` | `1.5e−15 … 1.7e−14` | 实测那条 | `0.04 … 0.15` |

三条余量偏大（`correlate2d` 浮点、xcorr `error²`、`pcov`）。前两条不要紧：
**它们各有一档零容差或结构性的孪生在真正把关**（整数相关、`n−p` 那条）。
第三条见 §4 的第一行 —— 那是这一轮唯一一处我明知余量大而**没有**补第二条的地方，
理由写在那里。

---

## 三、与 scipy/skimage 语义不同 / 容易搞错的地方

**deviation 编号留空** —— 由主线统一编。下面用 `D-NUM-??(a)…(f)` 临时指代。

### D-NUM-??(a) · `find_peaks` 的 `distance` 在 `prominence` **之前**筛

scipy 的顺序是 `plateau_size → height → threshold → distance → prominence → width`。
反过来做**不会报错**，只在某些信号上多留或少留一个峰：

```
x = [0, 5, 0, 9.9, 9.8, 9.8, 9.8, 9.8, 10, 0]，prominence = 1，distance = 3
  scipy（distance 先）  ⇒ [8]      下标 3 那个高而**不突出**的峰先把下标 1 挤掉，
                                   然后它自己被 prominence 筛掉
  prominence 先         ⇒ [1, 8]   下标 3 先没了，于是没人挤下标 1
```

金样 `peaks.order_probe_{both,prom_only,dist_only}` 三格专为此录。
**别的输入上两种顺序同解。**

**变异**：`numerics-findpeaks-distance-keeps-the-taller`。

### D-NUM-??(b) · `prominence` 取两侧最小值的 **`max`**，不是 `min`

峰高减去「向左、向右各走到**遇见一个严格更高的样本**为止，这两段区间里各自的
最小值」的**较大者**。两个容易写成的错版本都给出完全合理的数：

- 取 `min` ⇒ 每个峰都偏突出（走到全局最低点那一侧几乎总是 0），噪声上的小包越过阈值；
- 只看**直接相邻**的谷 ⇒ 大山肩上的小凸起拿到和主峰一样的 prominence。

金样 `peaks.prominence_side`：`max ⇒ 0.4`，`min ⇒ 0.7`。

**变异**：`numerics-findpeaks-prominence-is-the-lower-base`。

### D-NUM-??(c) · 平台峰取中点**向下**取整；**紧贴数组两端的极大值不算峰**

`[0,1,1,1,1,0]` 的峰是下标 **2**（平台 `[1,4]`，`(1+4)>>1 = 2`）——
向上取整会给 3，而**奇数宽的平台上两种写法完全同解**。
`x[n−1]` 再高也不是峰：scipy 的扫描区间是 `[1, n−2]`。旧仓
`classical_seg.py` / `_hist_modes` 在直方图两端各补一个 0 就是为了后半句。

**变异**：`numerics-findpeaks-plateau-midpoint-floors`。

### D-NUM-??(d) · 等高峰在 `distance` 里谁赢，scipy **没有定义**

scipy 用 `np.argsort`（quicksort，**不稳定**）按高度排序再从高到低处理。
两个**等高**且互相在 `distance` 之内的峰，留下哪一个由排序实现决定 ——
换一版 numpy 就可能换一个答案，**没有金样能钉住那一侧**。

本仓用**稳定**排序（等高时下标小的排前），于是处理时**下标大的先赢**。
这是一条真实偏差：确定，但不保证等于 scipy。
金样里因此没有等高峰 —— 一格分辨不出两种候选的金样不是判据，
一格**答案本身没有定义**的金样更糟。

### D-NUM-??(e) · `correlate2d(mode='same')` 的原点是 `(Mb−1)//2`，而 `grey_*` 的是 `Mb//2`

| | 原点 | 4×4 的核 |
|---|---|---|
| `scipy.signal.correlate2d(mode='same')` | `(Mb − 1) // 2` | **1** |
| `scipy.ndimage.grey_erosion(size=…)` | `Mb // 2` | **2** |

**两个都是 scipy、两个都叫「中心」**，偶数尺寸时差一格（实测：一张只有一个 1 的图
× 一个 `arange` 的核，四种尺寸逐一确认）。猜错了整张相关面平移一格 ⇒
漂移向量整体偏一个像素，而那仍是一个合法读数。
金样里 **2×2 与 4×4** 两格偶数核为此而录 —— 奇数核上两种猜法完全同解。

**变异**：`numerics-correlate2d-origin-is-half-of-size-minus-one`。

### D-NUM-??(f) · 相位归一化**可关**，而关掉它是另一个算法不是另一档精度

| | 互功率谱 | 峰由谁说了算 |
|---|---|---|
| `'phase'`（skimage 缺省，本仓缺省） | `A·conj(B) / max(\|·\|, 100·eps)` | **每个频点一票** —— 没有信号的地方由噪声投票（D-NUM-14） |
| `null` | `A·conj(B)` 原样 | **按功率加权** —— 低频与强结构说了算 |

旧仓 `drift_xcorr` 明确传 `normalization=None`，注释里写明理由：**对 SPM 的行噪声更稳**
（一条横贯整帧的噪声脊在相位归一化下与真信号一样有投票权）。

**两档在同一对帧上给不同的位移**：同一对几乎平坦的帧，`'phase'` 报虚构的 `(5, 5)`，
`null` 报 `(0, 0)`。只有这种帧分得开 —— 一组普通帧的金样会让这个开关
**没有任何测试在看**（D-NUM-13 那一次的教训）。

**变异**：`numerics-xcorr-normalization-is-switchable`。

### 另外三条值得记进 deviation 的

1. **`error` 只能在平方上给容差，而它有个下限**。`1 − |CC|²/(src·tgt)` 在对得上的
   一对帧上是两个几乎相等的数相减，`√` 又把剩下的放大（`d√u = du/(2√u)`）。
   结论对调用方直接有用：**`error` 的绝对精度只到 `√(32·fftRelTol)` ≈ 1e−6**
   （N=1024），也就是说 `error = 1e−8` 与 `error = 1e−7` 是同一个数。
   拿 `error` 判「配准好不好」，**阈值不能设在 1e−6 以下**。
2. **`savgol_filter(mode='interp')` 的两端不是「边界模式」，是另一个算法**：
   最外各 `w//2` 个点**完全不经过那串系数**，而是对最外 `w` 个样本做一次 `polyfit`
   再求值。拿 `mode='nearest'` 之类近似它，最外几个点差到 0.5 量级 ——
   而一条谱的最外几个点正是「有没有能隙」要看的地方。
3. **`savgol_coeffs` 解的是最小范数解不是最小二乘解**。`A c = y` 是欠定的
   （`polyorder+1` 个方程、`window_length` 个未知数）。写成 `(AᵀA)⁻¹Aᵀy` 会当场抛
   （`AᵀA` 秩亏，Cholesky 报错）—— 那算运气好；真正危险的是随手挑一个特解：
   它满足方程，滤出来的曲线仍然光滑，只是平滑的不是原来那条信号。

---

## 四、没做完的 / 明知余量大而没补的

**逐条列。** 前两条是我做了判断而**没做**的，不是忘了。

| 缺的 | 现在的状态 | 补它的判据是什么 |
|---|---|---|
| **`pcov` 缺一条「实测水平」的容差** | 只有保证那一条，余量 550 倍 | 推导要长成 `Δpcov/pcov ≈ 2·κ(JᵀJ)·ΔJ/J`，`ΔJ/J ≈ √eps/2`（MINPACK 用前向差分）。κ 可以免费拿到（`cond(pcov) = κ(JᵀJ) = 14.2`），但那条界给 `5e−7` 而**实测是 `3.6e−6`，差 7.5 倍而我说不清那 7.5 从哪来**。<br>**一条说不清来源的容差比没有更坏**：它会在下一次合法的精度变化上红，而红的时候没人知道该改它还是改代码。顶这个缺的是那条**结构性**判据（离「n−p」比离「n」近，余量 19 倍、零容差） |
| **`savgol` 的 `polyorder > 3`** | **抛**，金样照录（`supported: false`） | 行缩放治得了 `A'A'ᵀ` 的条件数，治不了最后那步重构 `c = A'ᵀz` 的相消：实测 `w=31/po=5` 超差 **6.5 倍**。要放开，得先推出一条把重构的相消算进去的界（量级 `(polyorder+1)·eps·maxₖ\|A'[k][i]·z[k]\|/max\|c\|`），再补至少两格 `polyorder ≥ 4` 的金样验证它。同 D-NUM-11 的形状 |
| **`savgol` 里那次翻核现在验不到** | 代码里有，注释写明了 | `deriv = 0` 的 SG 系数**恒对称** ⇒ 翻不翻结果一样。**实测把 `.reverse()` 去掉，245 条全绿。** 它留着是为了哪天补 `deriv > 0`（那时系数反对称，翻错整条导数变号）。要验到它，只能连 `deriv > 0` 一起做 |
| `find_peaks` 的 `height` / `threshold` / `wlen` / `plateau_size` / `rel_height ≠ 0.5` / 区间形式的条件 | 没实现 | 各自的判据写在 `peaks.ts` 抬头那张表里。`wlen` 那条值得单提：要一格**宽底座**上的峰，截断与不截断给不同的 prominence，别的输入分不出来 |
| `correlate2d` 的 `'full'` / `'valid'` / 别的 `boundary` | 没实现（两处消费方传的都是 `'same'` + 零补边，而且两个输入同形状） | 一格「`a` 与 `b` **不同形状**」的金样 —— `'same'` 取的是 `'full'` 的哪一段中心，只有不同形状分得开 |
| `savgol` 的 `deriv > 0` + `delta` / 偶数窗 / `mode ≠ 'interp'` | 没实现 | `y[deriv] = deriv!/delta^deriv` 一格；再加一格 `delta ≠ 1` —— **缺省 1 的时候那个幂次是恒等的，分不出来** |
| `curveFit` 的 box bounds（trf） | 没做（不在这一轮范围里） | scipy 给 bounds 就从 `lm` 切到 `trf`，**不是加 clamp**。FitGap_BCS / FitDispersion / AssessShockleyOnset 在等它 |
| `phaseCrossCorrelation` 的 `disambiguate` / `space='fourier'` / 掩膜 | 没实现 | 都没有消费方 |
| `zeroDegenerate`（1×N 的退化轴） | 做了，只有 `uf > 1` 的金样能照出来 | 已录 `xcorr_raw.single_row_uf10`；`uf = 1` 那一格**两种写法同解**，留着是为了说明这件事 |

---

## 五、变异演练（**十条全部实跑到 red**）

```
node tools/mutate/run.ts <id>
```

| id | file | 结果 | 拆掉会怎样 |
|---|---|---|---|
| `numerics-findpeaks-prominence-is-the-lower-base` | `peaks.ts` | 红 10 条 | `max` → `min`：每个峰都偏突出，肩上的小凸起和主峰一样有份量 |
| `numerics-findpeaks-plateau-midpoint-floors` | `peaks.ts` | 红 3 条 | 平台中点向上取整 ⇒ 偶数宽平台整体偏一格（奇数宽同解） |
| `numerics-findpeaks-distance-keeps-the-taller` | `peaks.ts` | 红 5 条 | `distance` 从最矮的峰开始处理 ⇒ 矮卫星挤掉主峰，而剩下的仍然间隔合规 |
| `numerics-curvefit-pcov-divides-by-dof` | `curve-fit.ts` | 红 3 条 | 分母 `n−p` → `n` ⇒ 每根误差棒小 2.6%，一组完全合理的误差棒 |
| `numerics-correlate2d-origin-is-half-of-size-minus-one` | `correlate.ts` | 红 6 条 | 原点差一格 ⇒ 相关面整体平移 ⇒ 漂移向量偏一个像素 |
| `numerics-xcorr-normalization-is-switchable` | `fft.ts` | 红 10 条 | 归一化写死 ⇒ 开关还在签名里、还能传 `null`、还不报错，而它什么也不做 |
| `numerics-xcorr-conjugates-the-upsampled-peak` | `fft.ts` | 红 5 条 | 少取最后那次共轭 ⇒ `phase` 整个变号（只有 `b = −a` 那一格分得开） |
| `numerics-savgol-row-scaling-also-scales-y` | `savgol.ts` | 红 10 条 | 行缩放没连 `y` 一起缩 ⇒ 系数差一个常数因子，曲线**仍然光滑**，只是整条被缩放了 |
| `numerics-savgol-refits-both-edges` | `savgol.ts` | 红 5 条 | 少做右端那次 `polyfit` ⇒ 最后几个点退回补零卷积、被拉向 0 |
| `numerics-polyfit-scales-its-columns` | `savgol.ts` | 红 2 条 | 去掉列缩放 ⇒ 精度退化到 `κ²` 那一档。**这一条挡的是精度的量级不是对错** —— 本层唯一一条这种形状的闸，而它挡得住是因为 `polyfit` 有两条容差（保证 + 实测），退化会被紧的那条接住 |

**一条跑出绿色的**（没进清单，但值得写下来）：
把 `savgolFilter` 里的 `.reverse()` 去掉，245 条**全绿**。
理由见 §4 第三行 —— `deriv=0` 的系数恒对称，**这条闸现在不存在**，
而它不存在是有理由的，不是疏忽。

---

## 六、值得进课时的三件

### 1. 「什么样的容差是 0」比「容差取多少」更值得先问

这一轮九个新函数里，**四个的容差是 0**，而它们不是「顺便严一点」：

| 件 | 为什么做得到逐位 |
|---|---|
| `find_peaks` 的下标 | 它是整数 |
| `prominences` | `x[peak] − max(l, r)`：**两个操作数都是输入里的元素原样**，一次减法 |
| `correlate2d` 的小整数格 | 乘积与部分和都在 `2⁵³` 内 ⇒ 浮点加法在整数上精确 |
| `widths` 一族 | 保证 `8·eps`，而运算顺序照抄 scipy ⇒ 实测 0 |

写容差之前先问「这一步到底做了几次浮点运算」，答案常常是**零次或一次**。
`correlate2d` 那一格尤其值得学：**同一个函数，换一批输入就从有容差变成零容差**
—— 而零容差的那一批才是真正在测「对齐对不对」的那一批，
因为这一族唯一会犯的错是对齐而不是精度。

### 2. 一条推不出来的容差，**宁可不写**

`pcov` 那一件本该按 `fit.ts` 的经验配一条「实测水平」。推了：
`2·κ(JᵀJ)·ΔJ/J`，κ 免费（`cond(pcov)` 就是它）、`ΔJ/J ≈ √eps/2`（MINPACK 用前向差分）
—— 得 `5e−7`，而**实测 `3.6e−6`，差 7.5 倍**。

那 7.5 我说不清。往常数里塞一个 8 就能让它过，而那正是
「刚好让我这版通过的那个数」。所以没写，改成两件事顶上：

- 一条**结构性**判据：金样把「分母写成 n」那一版也录了，判据是
  **「离对的近、离错的远」**（同 RANSAC），零容差、余量 19 倍；
- 在这份交接里把「余量 550 倍」和「为什么没补」写清楚。

> **一条容差要么推得出来，要么就别写。** 一个说不清来源的数会在下一次
> 合法的精度变化上变红，而那时没人知道该改它还是改代码 ——
> 那比没有这条断言更坏。

### 3. 新加金样节，**往末尾追加**

`export_numerics.py` 里那个 `rng` 是**一条共用的流**，各节按书写顺序取数。
往中间插一次 `rng` 调用，后面每一节的输入全变 —— 而那次改动在 `git diff` 里
看起来像「金样全变了」，于是没人能从 diff 上判断「哪些是我这次真改的」。

这一轮六节全部追加在末尾，给已有节补的 `error`/`phase` 又不消耗 rng，
于是 `git diff --stat` 是 **18851 行插入、0 行删除**。
「diff 纯插入」本身就是一条可读的保证：**已有的每一格都没动过。**

---

## 七、文件清单

```
新增
  packages/host/numerics/src/peaks.ts      find_peaks / peak_prominences / peak_widths
  packages/host/numerics/src/correlate.ts  correlate2d(mode='same') + numpy.hanning + 2-D 窗
  packages/host/numerics/src/savgol.ts     savgol_coeffs / savgol_filter + polyfit / polyval
  docs/handoff/numerics-3.md               本文

改
  packages/host/numerics/src/fft.ts            + normalization 档、error / phase、退化轴置 0；
                                               亚像素那一路补回略掉的最后一次共轭
  packages/host/numerics/src/curve-fit.ts      + pcov / perr / pcovRelTol；雅可比抽成函数
  packages/host/numerics/src/fit.ts            Cholesky 分解与前代回代抽成 cholesky / choleskySolve
  packages/host/numerics/src/index.ts          三行 re-export
  packages/host/numerics/src/numerics.test.ts  152 → 245 条
  tools/spec-export/export_numerics.py         + 第 11–14 节（peaks / correlate2d+hanning /
                                               xcorr_raw / savgol+polyfit），全部追加在末尾
  spec/golden/numerics.json                    18 节 1736 KB → 24 节 2283 KB（diff 纯插入）
  tools/mutate/mutations.ts                    + 10 条（「课时 4.1 续」锚点下）
```

共享文件里**只动了 `tools/mutate/mutations.ts`**（在自己的锚点下加，锚点也是这次建的）。
`tsconfig.json` / `vitest.config.ts` / `pnpm-lock.yaml` / `l0/index.ts` /
`gen-skill-specs.ts` / `export_skill_traces.py` **全部原样**。
