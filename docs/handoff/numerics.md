# 交接：课时 4.1 数值底座（`dsh-spm-numerics`）

新包 `packages/host/numerics`，零 dsh 依赖、零 I/O、**零新 npm 依赖**
（`pnpm-lock.yaml` 只多了一行 workspace link）。84 条测试，全部对
`spec/golden/numerics.json`（numpy 2.4.4 / scipy 1.17.1 / skimage 0.26.0 真跑出来的）。

金样 670 KB，重跑逐字节相同（md5 两次一致）。

---

## 一、容差表

**每一条都写在被测函数自己的 docstring 里，连同理由。** 测试引用那些函数
（`sumRelTol` / `convRelTol` / `fftRelTol` / `lstsqRelTol` / `lstsqObservedTol` /
`SSIM_ABS_TOL`），**测试里没有一个字面量容差** —— 一个字面量容差等于把理由
从代码搬进测试，而下一个人只会看见那个数。

| 件 | 对的是 | 容差 | 为什么是这个数 |
|---|---|---|---|
| `decodeNpy` | `np.lib.format.write_array` 的字节 | **0** | 对的是字节，中间没有一次算术 |
| `percentile` | `np.percentile(method='linear')` | **0** | 闭式插值，没有累加 |
| `histogram` / `labelConnected` | `np.histogram` / `ndi.label` | **0** | 数的是个数与整数标签 |
| `ptp` | `np.ptp` | **0** | 两个元素相减 |
| `sum` / `mean` / `std` | `np.sum` / `np.mean` / `np.std` | `8·eps·log₂N` | numpy 是**成对求和**、本仓是 **Neumaier**（`pySum`）。两种算法，误差界 `O(eps·log₂N)`；实测 N=2048 时相对差 `1.8e-16`，界 `2.4e-15`。系数 8 = 3 倍余量 |
| `gaussianFilter1d` / `laplace2d` | `ndi.gaussian_filter1d` / `ndi.laplace` | `4·k·eps`，k = 核长 | 核与 scipy **逐位相同**（实测），误差只来自 k 次乘加，界 `k·eps`。**实测最坏 `0.097·k·eps`，系数 4 有 41 倍余量** |
| `gaussianFilter2d` | `ndi.gaussian_filter` | `2·4·k·eps` | 沿两轴各一次，界翻倍。实测最坏 `0.155·k·eps` |
| `fft` / `fft2` | `np.fft.fft` / `fft2` | `8·eps·log₂N` | radix-2 每级一次复数乘加，共 log₂N 级。**Bluestein 那一路用 M 代 N**（M = 补到 2 的幂的卷积长度） |
| `fitPlane` / `fitPoly2d` | `np.linalg.lstsq` | 两条，见下 | |
| `ssim` | `skimage.structural_similarity` | `64·eps`（**绝对**） | SSIM 是 `[-1,1]` 的量，相对容差在近零处没有意义 |
| `curveFit` | `scipy.optimize.curve_fit` | 参数差 < `0.05·perr`，且 SSE 不劣于 scipy（相对 `1e-9`） | 两种 LM 实现不会收敛到同一串二进制位；有道理的是「落进同一个极小点的不确定域」 |

### 最小二乘那两条容差（值得单说）

正规方程**把条件数平方**（`κ(AᵀA) = κ(A)²`），所以**保证**是 `64·κ²·eps`。
但**实测两格都只有 `0.5·κ·eps`** —— 没有平方，也就是说这两个系统还远没到
正规方程开始吃亏的地方。

于是测试里有**两条**断言：

1. `lstsqRelTol = 64·κ²·eps` —— 算法的保证，对调用方可能送进来的任何设计矩阵成立；
2. `lstsqObservedTol = 4·κ·eps` —— 现在实际达到的水平。

只留第一条的话平面那一格有 **537 倍**余量（`16·κ`）、多项式那一格 **14900 倍**，
等于什么都没测；只留第二条的话，哪天真来了一个病态基组，一次**合法的**精度退化
会被当成回归。两条各管一件事，而它们的比值正好是 `16·κ` —— 有一条测试钉着这个关系。

---

## 二、与 numpy/scipy 语义不同 / 容易搞错的地方（按 deviation 格式写，编号留空）

### D-NUM-1 · `sum` 全仓只有一个，而它不是 numpy 的那个

| | |
|---|---|
| **numpy** | `np.sum` 用成对求和（pairwise） |
| **本仓** | `pySum`（CPython 3.12+ 的 Neumaier 补偿求和，`kernel/src/si.ts`） |
| **测试** | `numerics.test.ts` → `三种求和算法给三个答案` |

**不是选哪个更准的问题**：技能金样那一侧要的是 CPython 的答案
（`AutoPhase` 的 `x_mean` 就卡在这一位上，2026-09-13）。
**一个仓里只能有一个 `sum`**，否则「均值」会随调用方而变。
代价是这一层对 numpy 的比对必须带容差 —— 那条容差就是上表第五行。

### D-NUM-2 · scipy 与 numpy 把 `reflect` / `mirror` 这两个名字**拧着用**

| scipy 的名字 | 序列 | numpy.pad 管它叫 |
|---|---|---|
| `reflect` | `d c b a \| a b c d` —— 边界元素**重复** | `symmetric` |
| `mirror` | `d c b \| a b c d` —— 边界元素**不重复** | `reflect` |

本仓按 **scipy 的命名**（因为被移植的那一侧调的是 scipy）。
认错了不报错，只让图像四条边各差一点 —— 而扣背景、找台阶、算漂移
全都从边上开始受影响。五种模式各有金样。

### D-NUM-3 · `phaseCrossCorrelation` 的符号 = 漂移方向

`phaseCrossCorrelation(reference, moving)` 给的是
**「把 moving 移动多少才能对上 reference」**，与 skimage 同：
`moving = roll(reference, +d)` 时返回 `−d`。

一次参数写反或一次轴对调**不会报错**，只会让漂移补偿往**反方向**走，
而图看起来只是「漂得更快了」。金样用不对称的位移（3≠5、有零有负）逐格钉住，
另有一条测试断言 `shift(a,b) === −shift(b,a)`。

### D-NUM-6（上半）· `histogram` 的最后一个 bin **右边界也闭**

落在 `range[1]` 上的样本进最后一个 bin，不被丢掉（同 numpy）。
这一条在「最高的那个 bin 是哪个」上会翻结论 —— 而那正是调用方要的答案。

### D-NUM-6（下半）· 连通域的**邻接数是语义**

同一张掩膜：4-邻接 5 个域，8-邻接 4 个。金样两个都录，
于是「默认用哪个」不可能被含糊过去。标签编号按**行优先首次出现**的顺序（同 scipy）。

### D-NUM-5 · `ssim` 的 `data_range` **必须显式给**

skimage 不给的话按 dtype 猜，而它对 float 图的猜测（`1.0`）在一张以米为单位的
形貌图上差九个数量级 —— C1/C2 两个稳定化常数完全失效，SSIM 退化成一个只反映噪声的数。
本仓**没有缺省值**，不给就抛。

### D-NUM-7 · RNG 不是 numpy 的

xoshiro128\*\*，不是 PCG64。判据是**可复现**（同种子同串），不是「与 numpy 相同」。
金样里钉的是本仓自己那一串 —— 将来任何一次「顺手换个 RNG」都会当场变红。

### D-NUM-4（上半）· `.npy` 的 `fortran_order` **在读的那一刻就转回行优先**

不把这个标志传给调用方：一个「记得自己是列优先」的数组，迟早会被某个
忘了检查它的人按行优先读一遍，而一张转置的扫描图在方形帧上看起来完全正常。

### D-NUM-4（下半）· 截断的 `.npy` **抛，不补零**

补零之后图的下半截是一片平坦的「干净表面」—— 那正是撞针检测要找的形状。

---

## 三、没做完的

| 缺的 | 谁在等它 | 还差什么 |
|---|---|---|
| **灰度形态学**（开/闭/腐蚀/膨胀） | `Destripe_MorphOpen` | 一个结构元 + 滑窗极值；对 `ndi.grey_opening` 录金样即可 |
| **插值 / 重采样**（`map_coordinates` / `zoom`） | 漂移校正把图移回去的那一步、`CalibratePiezoMultiAngle` | scipy 的 `spline_filter` 预滤波是个坑：`order≥2` 时它先做一次 IIR 预滤波，不做的话结果差得看得见 |
| **亚像素相位互相关**（`upsample_factor>1`） | `CorrectDrift_XCorr` 的高精度档 | 峰的邻域上再做一次上采样 DFT。**它会把「没漂」变成「漂了 0.3 像素」**，所以判据是另一件事，要单独想 |
| **`.sxm` / `.dat` / `.3ds` 读写** | `LoadScanFrameFromFile` | 那是**课时 4.2**，不在这一段范围里 |
| **`.npy` v2 写** | 暂时没人 | `kernel/src/npy.ts` 只写 v1.0，够用 |

四件里前三件都是分析类技能真正需要的，建议下一段接着做。

---

## 四、值得进课时的三件

### 1. 一个逐元素的相对比较**不是容差，是抽签**

第一版测试对每个元素各算各的相对差，15 格红了。查下去全是同一件事：
高斯滤波第 62 个输出是 `0.0024`，而整条信号的尺度是 `1.48` —— 那个位置
正好在过零点附近，绝对误差 `9e-17` 除以 `0.0024` 就成了 `3.9e-14`。
FFT 往返更极端：`n=61` 逐元素相对差冲到 **`2.5e-9`**，而绝对误差只有 `1.4e-15`。

道理是线性算子的误差界本来就写在**输入的尺度**上：输出是输入的加权和，
一个近零的输出是**相消**的结果，而相消毁掉相对精度、不毁绝对精度。

**它红不红取决于那串数里有没有一个碰巧靠近零的。** 这与本仓
「合成回包是精确回显，所以金样一次都照不出来」是同一种毛病的两面：
一个看起来在测东西、其实在掷骰子的判据。

### 2. 「容差不是摆设」这句话，**不能拿随机数据来证**

本来想写一条测试证明 numpy 与 `pySum` 确实分岔 —— 结果在金样那 2048 个
标准正态上**两者恰好相等**（`d === 0`），测试红了。

改成用一个**必然分岔**的输入：`[1e16, 1, -1e16]`，朴素累加给 `0`、
Neumaier 给 `1`。判据要由**构造**保证，不由抽样保证。

### 3. 一条**保证**与一条**实测**，两条都要

正规方程的保证是 `64·κ²·eps`，而实测只有 `0.5·κ·eps`。
只写保证 ⇒ 平面那一格 537 倍余量，什么都没测；
只写实测 ⇒ 哪天来了病态基组，一次合法的退化被当成回归。

**两条各管一件事**，而它们的比值 `16·κ` 本身也被钉住了 ——
于是「条件数越差、那条保证越松」这件事是写下来的，不是靠人记得。

---

## 五、建议加的变异演练

这一层的正确性主要由金样 + 写明的容差钉住，但有**三个真正的判据常量**值得加演练
（按仓里的规矩，我没有动 `tools/mutate/mutations.ts`）：

| id 建议 | file | find → replace | 拆掉会怎样 |
|---|---|---|---|
| `numerics-sum-is-compensated` | `stats.ts` | `return pySum(xs as Iterable<number>)` → 朴素 reduce | 均值在最后两位上与旧仓分岔，而技能金样那一侧要的是 CPython 的答案 |
| `numerics-xcorr-sign` | `fft.ts` | `const ci = ai * br - ar * bi` → `ar * bi - ai * br` | 漂移方向整个反过来，而图看起来只是「漂得更快了」 |
| `numerics-npy-no-zero-fill` | `npy-read.ts` | `throw new NpyParseError(...数据段短了...)` → 补零后继续 | 一份缺尾巴的帧下半截是平坦的「干净表面」，正是撞针检测要找的形状 |

三条都**编得过**（没有类型收窄问题），而且都有现成的测试会红。

---

## 六、文件清单

```
packages/host/numerics/package.json
packages/host/numerics/tsconfig.json
packages/host/numerics/src/index.ts
packages/host/numerics/src/mat.ts          Mat + 取行列/切片/转置
packages/host/numerics/src/stats.ts        sum/mean/std/percentile/histogram/ptp
packages/host/numerics/src/rng.ts          xoshiro128** + 无偏 sample
packages/host/numerics/src/filters.ts      gaussian 1d/2d + laplace + 五种边界
packages/host/numerics/src/fft.ts          radix-2 + Bluestein + fft2 + 相位互相关
packages/host/numerics/src/fit.ts          平面/多项式最小二乘 + RANSAC
packages/host/numerics/src/label.ts        连通域 + SSIM
packages/host/numerics/src/npy-read.ts     .npy v1/v2 读
packages/host/numerics/src/curve-fit.ts    Levenberg–Marquardt
packages/host/numerics/src/numerics.test.ts
tools/spec-export/export_numerics.py
spec/golden/numerics.json                  670 KB，重跑逐字节相同
```

改动的共享文件（只有这三个，都是加一行）：
`tsconfig.json`（references）· `vitest.config.ts`（别名）· `pnpm-lock.yaml`（workspace link）。
