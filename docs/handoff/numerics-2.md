# 交接：课时 4.1 收尾（形态学 / 重采样 / 亚像素互相关）

接 [`numerics.md`](numerics.md) 的「三、没做完的」那张表，把前三件补上。

包还是 `packages/host/numerics`，**零 dsh 依赖、零 I/O、零新 npm 依赖**。
numerics 的测试从 84 条涨到 **152 条**，全仓 3610 → **3678 条**，全绿。
金样从 15 节 670 KB 涨到 **18 节 1736 KB**，重跑逐字节相同（md5 两次一致）。

> ⚠️ 金样里 `versions.numpy` 从 `2.4.4` 变成了 `2.4.3` —— **本机的 python 环境被换过**
> （当时使用的 CPython 3.14 环境只安装了 2.4.3；
> 3.13 那个装的是 2.4.6 但没有 skimage）。
> 已有 15 节的数据**逐字节没变**，只有这个版本字符串变了 ——
> 也就是说这份金样刚顺带跨了一次 numpy 版本的验证。
> 谁下次重跑金样，先看一眼这一行对不对得上。

---

## 一、这一轮补了什么

| 件 | 文件 | 谁在等它 |
|---|---|---|
| 灰度形态学 腐蚀/膨胀/开/闭 | `morphology.ts`（新） | `Destripe_MorphOpen` |
| 重采样 `map_coordinates` / `shift` | `interpolate.ts`（新） | 漂移校正把图移回去那一步、`CalibratePiezoMultiAngle` |
| 亚像素相位互相关 `upsampleFactor > 1` | `fft.ts`（改） | `CorrectDrift_XCorr` 的高精度档 |
| 边界折叠抽出来一份共用 | `filters.ts` 的 `boundaryIndex`（改） | 上面头两件 |

顺手补的一格金样：`subpixel.cases` 里的 `near_flat`（两张几乎平坦的帧），
它是**唯一**能分辨相位归一化那个分母怎么写的输入 —— 详见下面的 D-??? 第 6 条。

---

## 二、容差表

照旧：**每一条都写在被测函数自己的 docstring 里，连同理由**；测试引用
`interpRelTol`，**没有一个字面量容差**。

| 件 | 对的是 | 容差 | 为什么是这个数 |
|---|---|---|---|
| `greyErosion` / `greyDilation` / `greyOpening` / `greyClosing` | `ndi.grey_*` | **0** | 平结构元的形态学**没有算术**：每个输出都是输入里的某一个数原样搬过来（min/max），中间一次乘加都没有。给它容差等于把一次「挑错了元素」藏起来，而挑错元素正是这一族唯一会犯的错 |
| `mapCoordinates` / `shiftImage`，`order = 0` | `ndi.map_coordinates` / `ndi.shift` | **0** | 同上，最近邻只搬数不算数 |
| `mapCoordinates` / `shiftImage`，`order = 1` | 同上 | **保证 `8·eps`**（相对，按 `max\|want\|` 归一）<br>**实测 `0`** | 每点是 4 项 `w·v` 的和：1 次减法定 frac、4 次乘、3 次加、权重本身 1 次舍入 ⇒ `8 eps`。而折叠照抄了 scipy 的运算顺序，连累加顺序都一样，于是**逐位相同** |
| `phaseCrossCorrelation(..., uf)` | `skimage.phase_cross_correlation` | **0** | 答案恒为 `round(整峰·uf)/uf + (上采样峰 − dftshift)/uf`，两项都是 `k/uf`；两边做同样两次「整数 ÷ uf」再相加，IEEE 除法正确舍入 ⇒ 只要挑中同一格就逐位相同。**这一族唯一会出的错不是精度，是 argmax 挑到了隔壁那一格，而那一跳就是整整 `1/uf`，给多少容差都接不住** |

### 重采样那一对（保证 8 eps / 实测 0）值得单说 —— 它救过一次

写这一版时 `order=1 / reflect` 一度超差 **1.09 倍**（`1.94e−15` 对 `1.78e−15`）。
第一反应是「界推紧了，重推一个松一点的」——**而那个松一点的界也推得出来**：
坐标折叠本身的舍入会乘上局部斜率，量级 `8·n·eps`，n=12 时是 `2.3e−14`，
完全讲得通，也完全能让那一格转绿。

**但真正的原因是折叠算错了。** 把容差调松会把它盖住整整一年。

当场揪出来的是同一族里那个**零容差**的用例：`order=0 / mirror` 直接红了 0.93 ——
它没有容差可调，只能去查为什么。改对折叠之后，`order=1` 的偏差从
1.09 倍容差直接变成 **0**。

所以两条都留着，各有一条测试：一条按 `interpRelTol` 比，一条 `Object.is` 逐位比。

---

## 三、与 scipy/skimage 语义不同 / 容易搞错的地方（按 deviation 格式写，编号留空）

### D-??? · `grey_dilation` 用的是**翻转过的**结构元，`grey_erosion` 不翻

形态学的对偶要求 `(f ⊕ B)(x) = max_b f(x − b)`，而腐蚀是 `min_b f(x + b)`：偏移号相反。
写成「翻掩膜 + 原点从 `size>>1` 变 `size − 1 − size>>1`」与它等价。

**奇数尺寸时两者恰好一样**，所以 3×3 / 5×3 / 十字全都看不出来；
是金样里那一格 **4×4** 把它逼出来的 —— 同原点的膨胀在 4×4 上当场红。

猜错了整张图沿两轴各平移一个像素，而一张平移一个像素的形貌图看起来完全正常。

### D-??? · `wrap` 在 scipy 的**滤波族**与**插值族**里周期不同

| 名字 | `filters.ts`（`gaussian_filter` 那一族） | `interpolate.ts`（`map_coordinates` 那一族） |
|---|---|---|
| `wrap` | 周期 **`n`**：`a b c d \| a b c d` | 周期 **`n − 1`**：首尾两点重合 |

同一个字符串、同一个库、两族函数里含义不同。scipy 自己的文档把插值族的 `wrap`
画成 `(d b c d | a b c d | b c a b)`，并注明重合点取哪一个「没有定义」。

**于是 `interpolate.ts` 不复用 `filters.ts` 的 `boundaryIndex` —— 复用才是 bug。**
两处各有一条测试互相指认（`mapCoordinates(row, [0], [3.5], 1, 'wrap')` 给 `0.5`，
而 `boundaryIndex(4, 4, 'wrap')` 给 `0`）。

### D-??? · `mirror` 在 `(n−1, n)` 这一段上**根本不折坐标**

scipy 的 `map_coordinate` 外层判 `x > n−1` 才进来，**内层却判 `y >= n` 才翻**，
于是 `x = 11.5`（`n = 12`）一路活到取整：`floor(12.0) = 12`，
再由**下标**折叠给出第 **10** 行。先折坐标的话是 `10.5 → 11` —— 差一行。

而 `order = 1` 上两种做法**完全同解**（两个邻居折过去正好是对称的那一对），
只有 `order = 0` 的取整分得开。

### D-??? · `order ≥ 2` **抛，不近似**

scipy 的 `order ≥ 2` 先对整张图做一次**样条预滤波**（`spline_filter`，一条前向 +
一条后向的 IIR 递推），得到的系数图才拿去插值。那一步是**全局**的：
改一个像素会影响整张图的输出。拿三次卷积核去近似它误差在 `1e−2` 量级 ——
那不是容差，那是另一个算法。

`export_numerics.py` 仍然录了 `order=3` 的金样：**录下来是为了证明我们知道它长什么样、
并且确实没在复现它**，将来谁要补这一块，判据现成。

### D-??? · `shift` 改名叫 `shiftImage`

这个包是扁平导出的（60 多个顶层名字）。一个叫 `shift` 的导出迟早会被某个
局部变量遮住，**而那种遮蔽不报错**。方向照搬 scipy：`shiftImage(a, s)` 给
`out[i] = a[i − s]`，内容往 `+s` 方向搬。

### D-??? · 相位归一化的分母是 `max(|·|, 100·eps)`，而这条的理由是**对齐，不是更准**

本仓上一版写的是「模为零才置零」（`mag === 0 ? 0 : cr / mag`），
skimage 写的是 `image_product /= np.maximum(np.abs(image_product), 100 * eps)`。
差别只在模小于 `2.2e−14` 的那些频点上。

**我为这一改编过一个理由，而探针当场把它证伪了。** 原话是「压住噪声，峰就留在直流」——
可是对一次精确的 `roll`，那些「噪声」频点带的是**同一个相位**（`B = A·e^{−2πi k·d}`
对每个频点都成立，dust 也不例外），不压反而给出更干净的峰。

所以改成去问 skimage：金样补了一格 `near_flat`（两张 16×16 的几乎常数帧，
各带独立的 1e−12 噪声）。**skimage 报的是 `(5, 5)`** —— 一个纯属虚构的位移。
我们的实现逐位复现了它。理由落回「对齐」，不落在「更准」。

### D-??? · 亚像素档在平坦帧上会报出一个纯属虚构的位移

相位互相关把每个频点都归一化成单位模长，**于是没有信号的地方由噪声说了算**：

- 几乎平坦的一对帧 ⇒ `(5, 5)`（上面那一格金样）；
- 一张**真正的**常数图 ⇒ 相关面全平，`argmax` 只会挑第 0 格，
  亚像素档下那一格等于 `−dftshift/uf`（`uf=2/4/10` 分别是 `−0.5 / −0.75 / −0.7`）。

再加上输出恒为 `1/uf` 的整数倍，**调用方要判「漂没漂」必须自己看峰有多尖、再设阈值**。
拿 `!== 0` 去判等于每一帧都在补偿噪声，而那会**制造**漂移。
这一层不替调用方做那个判断 —— 但两条测试把这个坑钉在原地了。

---

## 四、还没做完的

| 缺的 | 谁会等它 | 还差什么 |
|---|---|---|
| **样条插值 `order ≥ 2`** | 暂时没人；真要高保真重采样时会要 | `spline_filter` 的 IIR 预滤波（前向 + 后向递推，含边界的初值），golden 已就位 |
| **`zoom`** | `CalibratePiezoMultiAngle` 可能会要 | 就是 `map_coordinates` 加一层坐标生成；scipy 的 `zoom` 端点约定（`grid_mode`）要单独录金样 |
| **非对称结构元的膨胀** | 暂时没人 | 代码**已经**翻了掩膜（对偶要求如此），但金样里的矩形与十字都是中心对称的，**这一半没被验过**。真要用非对称结构元，先补一格金样 |
| **`grey_*` 的 `origin` 参数** | 暂时没人 | 现在原点恒为 `size>>1`。scipy 允许手动偏 |
| **峰质量指标** | `CorrectDrift_XCorr`（见上面最后一条 deviation） | 一个「这个峰有多可信」的标量（峰值 / 次峰、或峰值 / 面内均方）。**它属于技能层的判据，不是这一层的**，但没有它，亚像素档不该被直接信 |
| **`.sxm` / `.dat` / `.3ds` 读** | `LoadScanFrameFromFile` | 课时 4.2，另一条支线在做 |

---

## 五、值得进课时的三件

### 1. 给一族数值函数留一个**零容差的孪生档**

`order=0` 与 `order=1` 是同一件事的两档：一档搬数（没有算术 ⇒ 容差 0），
一档加权求和（有容差）。**有容差的那一档报不出来的事，零容差的那一档会替它喊。**

这一轮的实证：`order=1 / reflect` 超差 1.09 倍，而那个超差**推得出一个合理的解释**
（坐标折叠的舍入 × 局部斜率），照那个解释调松容差，测试就绿了 ——
真正的 bug（折叠在 `(n−1, n)` 那一段上算错）会被封存。
是 `order=0 / mirror` 那条零容差的断言红了 0.93，逼着人去查。

> 「数值代码没有红绿之分，只有容差」是对的，
> 但正因为如此，**一族里必须留一档是有红绿的**。

### 2. 一组**分辨不出两种候选**的金样，不是判据

这一轮有三处是特意为了「能分辨」才加的输入，而它们都不是第一版就有的：

| 探针 | 分辨的是 | 在别的输入上 |
|---|---|---|
| 结构元 **4×4**（偶数） | 膨胀翻不翻结构元 | 3×3 / 5×3 / 十字上两种候选**完全同解** |
| `round_probe` 的**半整数**坐标 | 四舍五入 vs 就近偶数 vs 向下 | 非半整数坐标上三者完全同解 |
| `edge_probe` 骑在 `[0, n−1]` 两端的坐标 | `constant` 的界外判据、`mirror` 的 `(n−1, n)` | 原来那 7 个坐标全都分辨不出 |

第一版的插值金样有 7 个坐标、看着挺全，**但它没法区分 `x<0` 与 `x<−0.5`，
也没法区分四舍五入与就近偶数**。一组过得去的金样和一组有鉴别力的金样，
从行数上看不出区别。

写金样时该问的不是「够多了吗」，是「**如果我猜错了，哪一格会红**」。

### 3. 十份 `cell()` 的教训是「一样的东西别写十遍」，**不是「长得像就合并」**

这一轮差一点把 `boundaryIndex` 拿来给插值复用 —— 名字一样、签名一样、
五个模式一模一样。**而 `wrap` 在两族里周期不同**，复用会让每张图的最后一行/列
悄悄差一点，看图完全看不出来。

`cell()` 那一次是十份**行为本该相同**的拷贝里有三份不一样；
这一次是两份**行为本该不同**的东西长得一样。前者要合，后者要分，
而它们在代码里的样子**没有区别** —— 区别只在语义上，也就是只在文档和测试里。

所以这两处各写了一段互相指认的注释 + 一条互相指认的测试。这是 D-CHANNELS-1 的形状。

---

## 六、变异演练（已实测：五条**全部编得过、全部变红**）

按仓里的规矩**没有动** `tools/mutate/mutations.ts`，但每一条都真的跑过一遍
（改 → `tsc -b` → `vitest run --project '!integration' packages/host/numerics` → 还原）：

| id 建议 | file | find → replace | 结果 | 拆掉会怎样 |
|---|---|---|---|---|
| `numerics-morph-dilation-reflects-se` | `morphology.ts` | `se.rows - 1 - (se.rows >> 1), se.cols - 1 - (se.cols >> 1)` → `se.rows >> 1, se.cols >> 1` | 红 4 条 | 偶数结构元的膨胀整体平移一格，而图看起来完全正常 |
| `numerics-interp-mirror-keeps-last-span` | `interpolate.ts` | `return y >= n ? p - y : y` → `return y > n - 1 ? p - y : y` | 红 1 条 | `mirror` 在 `(n−1, n)` 上差一行；只有 `order=0` 看得见 |
| `numerics-interp-wrap-period-is-n-minus-1` | `interpolate.ts` | `const sz = n - 1` → `const sz = n`（`foldCoord` 的 `wrap` 支） | 红 6 条 | 插值族的 `wrap` 退化成滤波族的 `wrap` |
| `numerics-subpixel-dftshift-is-fix` | `fft.ts` | `const dftshift = Math.trunc(ups / 2)` → `Math.round(ups / 2)` | 红 1 条 | 亚像素位移整体偏 `1/uf`，而它仍然是个「合法」的数 |
| `numerics-xcorr-damps-tiny-magnitudes` | `fft.ts` | `Math.max(Math.hypot(cr, ci), 100 * EPS)` → `Math.hypot(cr, ci)` | 红 1 条 | 与 skimage 在平坦帧上分岔 |

> 最后那一条**第一次跑是绿的** —— 也就是说我改了归一化的分母而**没有任何测试在看**。
> 补上 `near_flat` 那一格金样之后才变红。
> 一条变异跑出绿色，说的不是「这个变异不重要」，是「**这条闸不存在**」。

---

## 七、文件清单

```
新增
  packages/host/numerics/src/morphology.ts     腐蚀/膨胀/开/闭 + 矩形/十字结构元
  packages/host/numerics/src/interpolate.ts    map_coordinates / shiftImage，order ∈ {0,1}
  docs/handoff/numerics-2.md                   本文

改
  packages/host/numerics/src/fft.ts            + upsampleFactor（上采样 DFT）、互功率谱抽成一函数
  packages/host/numerics/src/filters.ts        boundaryIndex 抽出来导出（+ 为什么插值不复用）
  packages/host/numerics/src/index.ts          两行 re-export
  packages/host/numerics/src/numerics.test.ts  84 → 152 条
  tools/spec-export/export_numerics.py         + 第 8/9/9b/10 节与 near_flat
  spec/golden/numerics.json                    15 节 670 KB → 18 节 1736 KB
```

共享文件**一个都没动**（`tsconfig.json` / `vitest.config.ts` / `pnpm-lock.yaml` /
`tools/mutate/mutations.ts` 全部原样）。
