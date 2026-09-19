# 批 7a-3 交接 —— `kde_layers` + `FindFlatRegion` + `BiasWiggle`

落了 **2 个技能 / 2 个模块收口**（`builtins.flat_region` · `builtins.bias_wiggle`，
两个都是 1/1），外加**四类判据件**：`mast/vision/seg_scale_adaptive.py` 的层结构那一半、
`flat_region.py` 自己的 `_local_plane_rms`、四件 numpy 原语，以及
**CPython `random` 的逐位复刻**。

技能 **417 → 419**（分母 515），模块 **92 → 94**（分母 165），
测试 **6240 → 6444**（106 → 109 个文件，`--project '!integration'`），
变异 **+45 条全红**（基线干净，见 §5），偏差登记 **+4 条**（编号留空，其中一条是指回
D-SI-1 的第二例、**不要新编号**）。

| 组 | 技能 | 模块 | 判据本体 |
|---|---|---|---|
| 找平区 | `FindFlatRegion` | `builtins.flat_region` ✅ 1/1 | `kde_layers` + `_hist_modes` + `_local_plane_rms` |
| 偏压扰动 | `BiasWiggle` | `builtins.bias_wiggle` ✅ 1/1 | **零**（判据全在技能自己身上） |

---

## 0. 一句话

> 任务书说这一批「≈45 行缺口 + 一件零依赖」，两个数都对。
> **而它们说的不是这一批的成本。** 45 行判据落了 45 行，
> 真正的活在另外三处：827 行技能里十一个参数与三条失败路径**各自的输入**（§4）、
> 「一件都不缺」的那个技能其实缺一个**内核能力**（§7）、
> 以及为了让 `BiasWiggle` 的金样不只是一堆随机数，本仓多了**第三个 RNG**（§3）。
> 三处都不是行数能预告的东西。

---

## 1. 落地的件

```
新增（numpy 原语 —— 对的是 numpy 本身）
  packages/host/numerics/src/np-grid.ts    175  linspace · digitize
                                                · histogram(按边界数组) · gradient(2D)
                                                · argsortDesc
  packages/host/numerics/src/mt19937.ts    200  CPython `random.Random` 的逐位复刻

新增（判据本体）
  packages/host/vision/src/seg-scale-adaptive.ts  255  kde_layers(15) + _hist_modes(30)

新增（技能）
  packages/host/stm-skills/src/l0/analysis-flat-region.ts  728  FindFlatRegion
                                                                + localPlaneRms
                                                                + parseExcluded
  packages/host/stm-skills/src/l0/bias-wiggle.ts           331  BiasWiggle

新增（测试与金样）
  packages/host/numerics/src/batch7a3.test.ts              132（ 65 条）
  packages/host/vision/src/batch7a3-units.test.ts           82（ 27 条）
  packages/host/stm-skills/src/l0/batch7a3-skills.test.ts  390（112 条）
  packages/host/stm-skills/integration/bias-wiggle.test.ts 189（  3 条，对真 stmsim）
  tools/spec-export/export_batch7a3.py                     919
  spec/golden/batch7a3.json                                1.9 MB / 9 节（重跑逐字节相同）
```

### `kde_layers` 的行数：45，不是 49

`_hist_modes` 第 211–240 共 **30** 行，`kde_layers` 第 243–257 共 **15** 行 ⇒ **45**。
算上两段之间那两个空行是 49。任务书写的「≈45」对，协调那条消息写的「49」也对，
两个数量的是同一段代码的两种边界。**核过。**

### `kde_layers` **不是一个闭包**（自己往下追了一层）

它函数体里调 `_hist_modes`，而那一件在 `blockers-7a.md` 的账上没有名字。追到底：

```
kde_layers ──► np.gradient(2D) · np.hypot · np.percentile · np.digitize · ndi.median_filter
           └─► _hist_modes ──► np.percentile · np.linspace
                            · np.histogram(**边界数组**入口) · ndi.gaussian_filter1d
                            · scipy.find_peaks · np.argsort / sort / delete
```

本仓缺四件（二维 `gradient` · `linspace` · `digitize` · 按边界数组的 `histogram`），
落在 `numerics/np-grid.ts`；其余全已有。**再往下没有 `mast.*`。**

⚠️ 那个 `np.histogram` 是**第二个入口**：`stats.ts` 已有的那一份对的是
`np.histogram(x, bins=<整数>, range=…)`，numpy 在那条路上走「算术定位」
（`floor((v−lo)/width)`）；给一个**边界数组**时它走 `_search_sorted_inclusive`。
归属规则相同、算法不同，样本恰好落在内部边界上时可以差一个计数 ——
而 `kde_layers` 的调用形式恰恰是 `bins=np.linspace(lo, hi, 257)`。

### 任务书点名「本仓已有、别重写」的九件：**逐个确认过，九件全在**

| 旧仓 | 本仓 | 备注 |
|---|---|---|
| `read_sxm` | `nanonis-files/sxm.ts` `readSxm` | ⚠️ 见 §8 那条 `what` 的修正 |
| `sxm_oriented_frames` | 同上 `sxmOrientedFrames` | |
| `plane_subtract`（`vision/tilt`） | `vision/plane.ts` `planeSubtractRobust` | **不是** `planeSubtractOls`，那是 `data/processors` 那一份 |
| `judge_frame` | `vision/frame-validity.ts` | `FrameVerdict` **没有** `.meta()`，本批在技能里摆出同一组键 |
| `parse_xy_meta` / `px_to_m` | `vision/xy-meta.ts` | |
| `noise_floor` | `vision/plane.ts` | |
| `parse_quantity` / `SIParseError` | `kernel/si.ts` | |

---

## 2. 容差表（每行一句推导）

| 件 | 对的是 | 容差 | 一句推导 | 实测占比 |
|---|---|---|---|---|
| `linspace` / `digitize` / `histogramFromEdges` / `gradient2dUniform` / `argsortDesc` | 同名 numpy 调用 | **0** | 下标、计数、以及照抄了运算顺序的减法。没有累加 | 0 |
| `PyRandom` 五个入口 | **CPython 的 `random`** | **0，字节级** | 全是 32 位整数运算 + 两次除以 2 的幂；`((a>>5)·2²⁶+(b>>6))` < 2⁵³ 在 double 里精确 | 0 |
| `histModes` 的峰位 / `kdeLayers` 的 `peaks`、`labels` | `seg_scale_adaptive` | **0** | 输出是**直方图的格心**与整数标签 —— 选错峰是选错格 | 0 |
| `localPlaneRms` | `flat_region._local_plane_rms` | `localRmsAbsTol(zSpan) = 128·eps·zSpan`，**绝对** | 主项是 `z − (a·x+b·y+c)` 每个元素的 `eps·max\|z\|` 舍入，**与残差多小无关**（相消毁相对精度、不毁绝对精度）；解本身的差是二阶的（极小点上 `ΔᵀAᵀAΔ`，`1e−26` 量级） | **0.079**（`pure_plane`） |
| `FindFlatRegion` 的 `rms_m` 一族 | 同上 | 同上，`zSpan` = 该格 `leveled` 的量程（随金样录） | 同上 | **0.032**（`bwd_only`） |
| `frame_rms_m` / `rms_ratio_to_frame` | 同上 | `RANSAC_REL_TOL`（1e−3） | **整帧 std 由 RANSAC 扣掉的那个平面决定**，而两边抽样序列不同（D-VISION-1） | **0.0021** |
| 坐标（`center_*` / `sites[].center_*`） | `px_to_m` | `16·eps` | `rot30` 那一格过一次 `cos/sin`，libm 各 1 ulp | — |
| `burst_s` / `log[].t_s` | 假钟 | `1e−6`（相对） | 两侧的假钟摆在不同量级（旧仓 1e6 **秒**、本仓 1e6 **毫秒**），`1e6` 的 ulp 是 `1.2e−10` ⇒ 相对差 `1e−7` 量级，取 `1e−6` | — |
| 其余全部（报文、计数、下标、`verdict`、`log[].target_v` / `reached_v`、`flips_executed`…） | —— | **0** | 标签、整数、以及**随机数的直接产物** | — |

### ⚠️ `localRmsAbsTol` 的入口是 **z 的量程**，不是残差

第一版写成相对容差（`1024·eps × |rms|`），**当场红在 `pure_plane` 那一格上**：
残差是 `3.3e−25`（只剩浮点噪声），两边差了一倍 —— 而那正是对的，两个都是零，
各自的舍入路径不同。一条按 `rms` 归一的相对容差在那一格上要求第 25 位对上。

> 批 6c §9③ 说「容差是一个三元组（量、误差来源、**入口**）」。
> 这一批踩的是同一条的第四面：**入口可以在同一个函数里就换掉** ——
> 同一个 `localPlaneRms`，喂一个纯平面和喂一块带噪声的窗，
> 误差来源的**分母**不是同一个东西。

---

## 3. 本仓多了**第三个 RNG**，而这是这一批最该被质疑的一条

`rng.ts` 的抬头写着两个 RNG 的分工：`Xoshiro128` **只为可复现**（RANSAC 的抽样序列
对面没有答案），`Pcg64` **进判决**（`superstructure_test` 的对照波矢有一个被比的答案）。

`BiasWiggle` 落在 `Pcg64` 那一侧，**而且更硬**：

* 每一个扰动目标是 `rng.uniform(lower, upper) * rng.choice((-1., 1.))`，逐条进 `data.log`；
* 每一段停留是 `rng.uniform(dwell_lo, dwell_hi)`，而它决定一次 burst 打得出**几次**跳变；
* 于是 `flips_executed`、`log`、`summary` 里那个次数 —— **全部**是随机数的直接产物。

⇒ 换一个 RNG 等于这个技能整条轨迹没有判据，剩下能比的只有参数回显与四条拒绝文案，
而那时金样说的是「拒绝分支移对了」，不是「这个技能移对了」。

它追的是 **CPython 的 `random`**（Mersenne Twister），不是 numpy ——
旧仓这个技能用的是标准库 `random.Random(seed)`。

**三处只能由金样确认的实现细节**，一次就对上了（`mt19937` 那一节 40 条全绿）：

1. `Random(n)` 对整数种子走 `init_by_array`，key 是 `abs(n)` 的小端 32 位字数组；
2. `getrandbits(k)` 是 `genrand() >> (32 − k)` —— 取**高**位；
3. `_randbelow(n)` 取 `k = n.bit_length()`（**不是** `(n−1).bit_length()`）——
   对 `n = 2` 要两位、于是平均拒绝一半。**两者消耗的随机数个数不同**，
   之后每一个数都跟着错位，而每一个看起来都是合理的随机数。

第 3 条我写对了，但**不是因为我记得**：期望值从金样里出来，写错会当场红。
那三条现在各有一条变异（`mt-randbelow-k-is-bit-length-of-n` 拆掉它红 15 条）。

---

## 4. 金样怎么来的（9 节，`spec/golden/batch7a3.json`，重跑逐字节相同）

`sxm_files`（18 张合成 `.sxm`，base64） · `np_grid` · `hist_modes`（11 格） ·
`kde_layers`（8 格） · `local_plane_rms`（7 格） · `parse_excluded`（13 格） ·
`mt19937`（5 个种子 × 8 串） · `wiggle`（27 格） · `skills.FindFlatRegion`（32 格）。

* **帧全是闭式合成**（sin-hash，零随机数），与 `export_batch6c.py` 同一条；
* **`.sxm` 一律录字节，读法归旧仓**；
* 墙钟走假钟（1e6 s 起、每读一次 +1e-3、`sleep` 往前拨），与
  `export_batch5b.py` / `export_skill_traces.py` **同一套**；
* **两处容差的入口随金样一起录**：`local_plane_rms` 每格的 `z_span`、
  `FindFlatRegion` 每格的 `leveled_span_m`（同批 6c 的 `polyfit_cond`）。

### 几格**专门为一道闸造的**输入

| 格 | 它分得开什么 |
|---|---|
| `fine_only`（干净区 24 px 放在 `[15:39]`） | ⭐「说『有』可以便宜，说『没有』必须贵」：粗扫落点 {0,12,24,…} **没有 15**，细扫落点 {0,3,6,…} **有 15** ⇒ 粗扫说没有、细扫说有。`windows_checked` 从 49 变 674 |
| `rough_patch`（干净区只有 14 px） | 「换小一档就有」：24 px 的窗怎么放都套不住，而探测的 0.5 档（12 px）整窗落得进去 |
| `rough`（整帧 90 pm） | 「**缩小窗口也没用**」——同一句话的另一侧 |
| `terraces_thin`（10 行一层）与 `terraces_micro`（3 行一层） | 全跨台阶那条路上的两句话：「换小一档就装得下」与「台面比窗口还窄」 |
| `terraces`（40/56 行两层，**一像素锐台阶**） | `same_terrace` 真的排掉 14 个跨台阶的窗；最大台面**唯一** ⇒ RANSAC 两边同解 |
| `kde_layers/pepper`（每 37 个像素丢一个到对面层） | `ndi.median_filter(lab, 5)` 的**唯一**入口 —— 合成的层标签干净到中值滤波一个像素都不改 |
| `local_plane_rms/too_few`（11 点，**不共线**） | 12 点那道门槛。第一版把 11 个点全放在第 0 行 ⇒ 就算拆掉门槛，`lstsq` 也因奇异给 `None`，两种候选同解 |
| `local_plane_rms/collinear`（16 点全在第 0 行） | 掉秩那一支（D-FLAT-?） |
| `window_floor_8px`（`window_fraction=0.05`） | `max(8, …)` 那道下限的唯一入口（`min_value` 就是 0.05，再小进不来） |
| `count_4_mixed`（在 `fine_only` 上要 4 个） | 「只收过线的」：整帧都干净的图上，收与不收给同一个答案 |
| `wiggle/current_trip_negative`（−8 nA） | 电流看护那个**绝对值**的唯一入口 —— 另外两格给的是正电流，判带号的与判绝对值的同解 |
| `wiggle/restore_multistep`（`base=0.2 V` + `upper=0.1 V`） | `_restore` 的**分步**路径：`n = round(Δ/0.1)` 要 Δ ≥ 0.15 V，而 `\|base\| ≤ 0.1 + upper` 只有把 upper 开到硬上限才够得着 |
| `wiggle/upper_exactly_cap` / `burst_exactly_cap` | 边界是 `>` 不是 `>=`：**正好等于硬上限放行** |
| `wiggle/aborted_mid`（第 9 次调用后中止）与 `aborted_at_dwell`（第 2 次） | 中止落在斜坡中段与落在停留里，是两条路 |

### 一处必须交代的合成选择：**台阶是一像素锐变**

`plane_subtract` 是 RANSAC（旧仓 `np.random.default_rng(42)` vs 本仓 `Xoshiro128`，
D-VISION-1），两边扣掉的平面差 pm 量级。这件事对 `_local_plane_rms`
**在数学上完全没有影响**（窗内再拟合一次平面把任何平面消掉，本批实测相对差 ≤ 4e−15），
但它会动 `kde_layers` 的层分界。所以台面之间用 240 pm 的**锐**台阶：
没有任何像素落在分界（120 pm）附近，几个 pm 的平面差动不了一个标签。

⇒ 受 RANSAC 影响的只剩 `frame_rms_m` / `rms_ratio_to_frame` 两格。

---

## 5. 变异演练（**45 条，全部实跑到 red**；⚠️ **基线干净**）

```
node node_modules/typescript/lib/tsc.js -b
node scripts/gen-skill-specs.ts && node scripts/build-progress.ts   # 先重跑生成物
node tools/mutate/run.ts <45 个 id>
… 基线（3 个 scope）          ← 没有「✗ 基线不干净」
45/45 变红
```

三个 scope：`packages/host/numerics`（10 条）· `packages/host/vision`（8 条）·
`packages/host/stm-skills`（27 条）。合并后的全量：`109 文件 / 6444 条`全绿
（改之前 `106 / 6240`）。

| 组 | id | 变红 | 拆掉会怎样 |
|---|---|---|---|
| np-grid | `npgrid-linspace-last-point-is-stop` | 1 | 末项差一两个 ulp ⇒ 落在右边界上的样本换一个格子 |
| | `npgrid-digitize-is-left-closed` | 6 | `x === bins[k]` 归错层 |
| | `npgrid-histogram-last-bin-is-right-closed` | 1 | 落在 `edges[-1]` 上的样本被丢掉 |
| | `npgrid-gradient-interior-is-a-central-difference` | 2 | 前向差分 ⇒ 梯度大一倍、偏半格 |
| | `npgrid-gradient-edges-are-one-sided` | 3 | 两端砍半 ⇒ 边界两行被算进「低梯度」 |
| | `npgrid-argsort-desc-takes-the-largest` | 4 | `max_levels` 留下的是 prominence 最小的几个峰 |
| MT19937 | `mt-seed-goes-through-init-by-array` | 40 | 同一个 seed 给出另一整串数 |
| | `mt-getrandbits-takes-the-high-bits` | 25 | 取低位，一样「随机」 |
| | `mt-randbelow-k-is-bit-length-of-n` | 15 | 消耗的随机数个数变了 ⇒ 往后全错位 |
| | `mt-random-is-53-bits-from-two-draws` | 15 | 只抽一次，分布看着一样 |
| kde | `kde-histogram-is-padded-at-both-ends` | 15 | 贴着左端的**最低那一层**整个消失 |
| | `kde-prominence-is-relative-to-the-tallest-bin` | 1 | 门限与样本数挂钩 ⇒ 换个像素数就换一个层数 |
| | `kde-valley-merge-is-relative-to-the-shorter-peak` | 1 | 比高的 ⇒ 小峰永远并不掉 |
| | `kde-valley-merge-keeps-the-taller-peak` | 2 | 留矮的 ⇒ 台面高度记错一整格 |
| | `kde-samples-only-low-gradient-pixels` | 5 | 台阶上的中间高度把谷填平 ⇒ 两层并成一层 |
| | `kde-falls-back-to-the-whole-frame` | 2 | 小帧上层结构由十几个像素决定 |
| | `kde-layer-bounds-are-midway-between-peaks` | 6 | 分界挪半个台阶 ⇒ 一整条台面划给下一层 |
| | `kde-labels-are-median-filtered` | 1 | 边上几个摇摆像素让每个跨界的窗都「跨台阶」 |
| `_local_plane_rms` | `flat-local-rms-refits-inside-the-window` | 28 | **2026-08-14 之前那个量**：有台阶时两者指向相反的窗 |
| | `flat-fit-needs-twelve-points` | 2 | 几个有效像素也给一个很小的残差，然后赢下 argmin |
| `FindFlatRegion` | `flat-window-needs-half-its-pixels` | 1 | 未扫区边上的窗拿几十个像素算「最平」 |
| | `flat-same-terrace-frac-is-98-percent` | 4 | 跨台阶的窗被判「同层」 |
| | `flat-usable-line-is-25-pm` | 23 | argmin 永远过线 ⇒ 再也不会说「这里没有」 |
| | `flat-refusing-costs-a-fine-sweep` | 7 | 采样栅格给出**假的「这里没有」** |
| | `flat-min-window-refuses-instead-of-shrinking` | 1 | 静默缩窗 ⇒ 调用方以为条件满足了 |
| | `flat-window-floor-is-eight-pixels` | 1 | 一个 4×4 的窗报「完美平区」 |
| | `flat-coordinate-is-the-window-centre` | 24 | 差半个窗（12 nm 的窗差 6 nm） |
| | `flat-unparseable-exclusion-is-refused` | 2 | 静默丢弃 ⇒ 针尖被送回刚才那个坏点 |
| | `flat-verdict-says-no-usable-region` | 2 | 「没有」与「判不了」重新合并 |
| | `flat-small-window-carries-a-scale-caveat` | 4 | 选择偏倚不说了 |
| | `flat-sites-stop-at-the-usable-line` | 1 | 为凑满 count 交出不合格的窗 |
| | `flat-sites-are-spaced-apart` | 3 | N 个落点挤在同一处 |
| `BiasWiggle` | `wiggle-amplitude-cap-refuses-not-clamps` | 2 | 夹紧 ⇒ 一次被报告成成功的错误动作 |
| | `wiggle-range-must-not-be-empty` | 2 | 反向区间 ⇒ 每次跳变落在同一个值上 |
| | `wiggle-burst-cap-is-ten-seconds` | 2 | 变成一个可以一直开着的模式 |
| | `wiggle-slew-cap-is-two-volts-per-second` | 2 | 一次阶跃式跳变 |
| | `wiggle-base-must-be-near-the-band` | 2 | 从 1 V 跳进 ±20 mV |
| | `wiggle-dwell-bounds-are-swapped-not-refused` | 2 | 反向区间上的停留时长 |
| | `wiggle-needs-the-feedback-on` | 35 | 反馈关着时它什么也不做，而回包说「扰动完成」 |
| | `wiggle-unreadable-feedback-is-not-a-yes` | 4 | 一次读失败被当成「开着」 |
| | `wiggle-start-bias-must-be-read` | 5 | 从假设的 0 V 出发的一次大跨越 |
| | `wiggle-small-step-still-checks-the-current` | 15 | **护栏有了大小之分** |
| | `wiggle-zero-crossing-uses-the-max-slew` | 9 | 在零附近慢慢走，而那里反馈一直在推针尖 |
| | `wiggle-restores-the-bias-on-every-path` | 11 | abort 之后针尖停在一个随机扰动值上 |
| | `wiggle-current-trip-is-on-the-magnitude` | 2 | 负偏压那一半的过流**一次都拦不住** |

### 5.1 四次「一格分辨不出两种候选」，全是变异演练当场抓的

**① `flat-sites-stop-at-the-usable-line` 第一轮绿 —— 而我打错了行。**

第一版把 `break` 换成 `continue`。它是绿的，理由很干净：候选**已按 rms 升序**，
一个超线之后后面全超线，于是 `continue` 逐个跳过、`break` 一次跳完，
**给出同一份 `sites`**。那一版问的是「循环怎么退出」（一个纯优化），
而这道闸问的是「不合格的窗收不收」。改打在判据本身上就红了。

> 同批 4b 的 `lattice-angles-are-python-modulo`：**打错了行 ⇒ 改打在真正做决定的那一行上。**

**② `flat-fit-needs-twelve-points` 第一轮绿 —— 一格被另一道闸接走了。**

`too_few` 那一格原本是 11 个点**全在第 0 行**。把 12 那道门槛拆掉之后，
`lstsq` 仍然因为设计阵奇异给 `None` —— 两种候选同解。摆成 4×3 减一个（不共线）才有输入。

**③ `kde-labels-are-median-filtered` 第一轮绿 —— 合成的输入太干净。**

层标签干净到 5×5 中值一个像素都不改。补了 `pepper` 那一格（每 37 个像素丢一个到对面层）。
真机上那些孤立像素来自台阶边缘的抖动与单个吸附物，而它们正是这道闸要挡的东西。

**④ `wiggle-current-trip-is-on-the-magnitude` 第一轮绿 —— 输入只有一半。**

三格过流用的都是**正**电流，而这个技能**一半时间在负偏压上**。
补了 `current_trip_negative`（−8 nA）。

### 5.2 一道**没有输入**的闸（照移，写下来）

`MIN_SEP_BINS`（`max(6, …)`，相邻层峰的格数下限）：
240 组合成样本（间隔 2–16 格 × `valleyRel` 0.55–0.01 × 四种高度比）逐一比过
`max(6, …)` 与 `max(1, …)`，**零处不同**。

理由是它被另外两道挡住了：σ=2 的平滑把 6 格以内的两个峰糊成一个鼓包，
而就算还分得开，`valley > valleyRel · min(峰)` 也会先把它们并掉 ——
两个等高高斯隔 6 格时谷峰比是 **0.64**，仍高于出厂的 0.55。

⇒ 照移、保留、**没有为它编金样**（编不出来），并在源码里写明。
同批 6c §4.2「一道闸可以被另一道闸挡住，于是它永远不做决定」。

### 5.3 三条**旧仓有、本仓不可达**的路（证明了不可达，没留没有闸的守卫）

| 旧仓那一支 | 本仓为什么到不了 |
|---|---|
| `except ImportError ⇒ "missing dependency: {e}"` | 依赖是编译期的 import |
| `except Exception ⇒ leveled = img − nanmean(img)` | `planeSubtractRobust` 拟合失败时**原样返回**，不抛 |
| `no forward/backward frame in selected channel` | `sxmOrientedFrames` 从**反扫块**也能给出 `forward`（`bwd_only` 那一格实测 success=true）⇒ 只要文件里有一个通道就到不了这一支 |

**第四条留着**（`terrace_note`：分割失败降级为「不做同层约束」）：
`kdeLayers` 会抛 —— `gradient2dUniform` 在轴长 < 2 时抛（同 `np.gradient`），
而 `judgeFrame` 只挡 `cols < 2`、**不挡 `rows < 2`**。所以在本仓它是可达的。
⚠️ **但它没有金样**：一张 1×N 的帧走得到那个 `catch`，而那种帧上
`win_px ≥ 8 > ny` ⇒ 一个窗都扫不出来，于是走的是「no valid windows」那条返回路，
**而那条路不报 `note`**。写在这里而不是假装验过。

---

## 6. stmsim e2e（**3 条，而且只该有这 3 条**）

`FindFlatRegion` **一次 Nanonis 调用都不发** —— 它读磁盘上的 `.sxm`，
在模拟器上跑它跑的是我自己合成的那份字节，而那份字节已经被旧仓亲自读过一遍了
（批 4a / 4b / 6c 同一条理由）。

`BiasWiggle` 不一样，所以它有：`packages/host/stm-skills/integration/bias-wiggle.test.ts`
验三件单测与金样都验不到的事 ——
① `ZCtrl_OnOffGet` 的回包**真的是「1 = 开」**（夹具里那个 `[1.0]` 是我摆的，
极性搞反的话前置门会拒掉每一次合法调用，而单测照样绿）；
② 几十次 `Bias_Set` 打进一台真的在跑的仪器之后，**偏压读回来真的在 base 上**；
③ `Current_Get` 在隧道状态下给的是真的电流量级 —— 电流看护那道闸的分母。

⚠️ 这里**不验跳变序列**：那一串由 MT19937 决定，而这条缝用的是真墙钟，
跳几次由机器有多忙决定。拿它当判据就是拿一台机器的负载当判据。

跑法：`STMSIM_PYTHON=…\.venv-v2-py313\Scripts\python.exe STMSIM_ROOT=…\STM-Bench`
+ `vitest run --project integration`。**本机实跑过，3/3 绿。**

---

## 7. ⚠️ 本批唯一的欠账：`BiasWiggle` 缺一个**内核能力**，我没有发明它

任务书写的「`BiasWiggle` 一件都不缺」，**按「函数体里零 `mast.*` import」这个量法是对的**
（逐行复核属实：顶层只有 `random` / `time` / `core.types` / `skills.base`，
收尾一个 `wrap_skill`；`BaseSkill.validate_params` 是框架的通用类型/范围检查，
`preconditions=[]`）。**但那个量法照不到它缺的那件。**

缺的是：旧仓 `_restore` 的两行写着
`context.safe_call("Bias_Set", …, allow_on_abort=True)` ——
中止闩上之后 `Bias_Set` 被动词闸拒，而这次写**是因为 abort 才要做的**。
`bias_wiggle.py:25` 与 `:116` 把这条写成纪律：「立即恢复初始偏压并中止……**abort 也不例外**」。

### 我的判断：**这一批不开那个口**，三条理由

1. **它今天没有流量。** 本仓没有任何地方把 `gatedSafeCall` 接进 `SkillContext.safeCall`
   （中止闩在工具入口的 K2 与 `stm-safety` 的 guard 上；`gatedSafeCall` 目前只有
   `contract/batch2-criteria.test.ts` 一个调用方）。⇒ 金样到不了它、变异也红不了它。
   按 green-8 §2.8，那是一段没有闸的守卫；
2. **口的形状是内核接口改动，而这一轮是并行的。** 按 `SkillContext` 自己的原话，
   它要写成**一个单独命名的入口**（同 `emergencyCall` / `slowCall`：
   「这条路谁在走、走了几次，要能一眼 grep 出来」），而那会动到三十来处构造
   `SkillContext` 的夹具 —— 包括另外两条支线**此刻正在各自工作树里写的那些**，
   我看不见它们。**做成可选的更坏**：静默回落到 `safeCall`，洞还在、而且看起来补上了；
3. **它是一个安全口，缺的是政策不是通道。** 「中止之后谁还能发命令」在本仓一直由
   **一张按动词与实参判的表**回答（`ABORT_SAFE_WRITES`：`Scan_Action(1,…)` 放行、
   `Scan_Action(0,…)` 拒）。旧仓的答案是「任何技能想走就走」，
   照抄那个参数等于把更松的模型换个名字请回来。
   （也**不能**把 `Bias_Set` 塞进那张表 —— 它没有哪个实参形能表达「停」。）

### 我做了的：**把洞钉住**

`l0/batch7a3-skills.test.ts` 里那条
「⚠️ 中止闩上时：`Bias_Set` 全被拒，而 `bias_restored` 照样报 true（本批的欠账）」
用 `gatedSafeCall({ abortLatched: () => true })` 真的摆出那一幕：
读全放行、**一次写都没到仪器**、第 1 次跳变就停、收尾也被拒，
**而回包说 `bias_restored: true`**。

它今天绿。**开口的那天它会红** —— 于是 `bias_restored` 必须跟着改成实话。
另一条测试从金样的 `calls[].kwargs` 里证明那个差异还在（旧仓那几次带
`allow_on_abort: true`），差异消失时它也会红。

### 落地建议（给主线，一个**串行**批）

一次做完三件，缺一件都不该开：
① 在 `SkillContext` 上加**必填**的第三个命名入口（建议 `cleanupCall`），
一次性改完所有夹具；② 同时把 `gatedSafeCall` 接进真实组合，让这条通道**有流量**；
③ 写下政策：哪些动词可以走、记录里怎么标（`emergencyCall` 的注释要的正是这一点）。
落完把 `bias_restored` 改成读实话，并把这条 deviation 删掉。

---

## 8. 与任务书不一样的地方

| # | 任务书 / 协调消息 | 实际 | 依据 |
|---|---|---|---|
| 1 | 「`BiasWiggle` **一件都不缺**」 | 判据件确实零缺；**但缺一个内核能力**（`allow_on_abort`） | §7（协调方后来自己订正了，两边结论一致） |
| 2 | 「827 行里真正的成本是……`exclude_used_spots` 的**会话态**」 | **它不是会话态。** 逐行核过：一个分号分隔的坐标串，调用方每次传进来，`_parse_excluded` 当场解析完就用掉，技能自己不记任何东西 —— `SkillContext` 一个字节都不需要 | `flat_region.py:206-217`（`ParameterSpec`）+ `:309`（`execute` 里一次性解析）。真正要跨调用记忆的是 `FindCleanSpot` 的实验地图，那是 7a-2 |
| 3 | 「如果会话态必须经过 `safe_mode_active` 那个口，**停下来写进交接**」 | **没走到那一步**（见 ②）。停下来的是另一个口（§7） | — |
| 4 | 「两个 RNG 是故意的」 | 本批**加了第三个**（CPython 的 MT19937） | §3。理由用的是 `rng.ts` 自己那条标准：**对面有没有一个被比的答案** |
| 5 | 「`kde_layers` ≈45 行 / 49 行」 | 两个数都对，量的是同一段的两种边界（45 = 两个函数体，49 = 含中间空行） | §1 |
| 6 | 「`vision/src/seg-*.ts`」 | 按协调方后来的要求定名 `seg-scale-adaptive.ts`（照旧仓文件名），**为了将来那 251 行只有一个落点** | 协调消息 |
| 7 | 「共享文件只许写在锚点里」 | **四处在锚点之外**，逐条见 §9 | — |

---

## 9. 给合并方的提醒

- **只动了锚点**：`numerics/src/index.ts` · `vision/src/index.ts` ·
  `l0/index.ts`（import / 展开 / re-export 三处；re-export 那里**顺手补了 7a-1 / 7a-2 两个锚点**，
  它们原先只有 import 与展开的锚点没有 re-export 的） ·
  `tools/mutate/mutations.ts` · `spec/deviations.md` · `spec/golden/README.md`。
  **`kernel/src/index.ts` 没动**（这一批一件都没进 kernel）。
- **锚点之外动过的共享文件（四处，逐条）**：
  1. `scripts/gen-skill-specs.ts` —— 这个文件**没有 7a 的锚点**，本批按房规补了三个
     （`BATCH_7A_1` / `BATCH_7A_2` 留空、`BATCH_7A_3` 两个名字），
     并在 `names` 与抬头计数串里各加三行。⚠️ **另两条支线会撞在同一处**，
     但它们各自只需要填自己那个空数组；
  2. `tools/spec-export/export_skill_traces.py` —— 同上，补了三个 `BATCH_7A_*` 锚点 +
     循环里三行，另加一条 `PARAM_OVERRIDES['BiasWiggle']`（⚠️ **必须有**：
     `seed` 缺省 0 = 非确定性分支，不显式给的话**整份 `skill_traces.json` 不再可复现**）；
  3. `l0/analysis-common.ts` 的 `loadSxm` —— **把路径传给 `readSxm` 的 `what`**。
     旧仓六个调用方转述的那句异常**全都带着文件名**（异常是 `read_sxm` 抛的），
     而本仓此前印的是字面量 `<sxm>`。这**不是 deviation，是消掉一个** ——
     在这之前没有金样踩到它（只有「文件不存在」那一支有格）。
     ⚠️ 合并后请核一遍另外五个调用方的金样（批 4a / 4c / 6b / 6c）：本批全量跑过，零影响；
  4. `l0/tip-phase-deps.test.ts` —— `BLOCKED` 表划掉 `FindFlatRegion`（五行）与
     `BiasWiggle`（一行），并把锻造自检那条断言从「`missing` 里有 `BiasWiggle`」
     换成「**两条链的分界**」（`FORGE_REQUIRED_SKILLS` 有它、`CONDITIONING_` 没有）——
     链的成员没变，变的是那条链上还差几件。
- **`packages/host/kernel/` 与 `packages/host/nanonis-files/` 一个字节都没动。**
  `tsconfig.json` / `vitest.config.ts` / `pnpm-lock.yaml` / `package.json` 全部原样。
- **`profiles/mast-rig` 没碰。** `packages/host/compat/src/` 之外零 `from '@deepseek-ai/`。
- **只读旧仓已自证**：跑完 `find MAST -newermt '-20 minutes'` 返回 **0**。
- **生成物**（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑；
  合并后请**统一再跑一次**：
  ```
  node node_modules/typescript/lib/tsc.js -b
  <venv>/python.exe tools/spec-export/export_skill_traces.py
  node scripts/gen-skill-specs.ts
  node scripts/build-progress.ts
  ```
- ⚠️ **合并之后把 45 条变异再跑一遍**：其中 10 条打在 `numerics/` 的新件上、
  8 条打在 `vision/seg-scale-adaptive.ts` 上。另外两条支线如果动了同一批文件，
  `find` 串会不再唯一命中 ⇒ 判 `inconclusive`。
- ⚠️ `docs/handoff/blockers-7a.md` 那张表**不要在上面打勾**（它自己那么写的）。
  本批落完之后六条针尖流程的封锁并集由 `tip-phase-deps.test.ts` 自己算：
  `FindCleanSpot`（7a-2）· `AutoTilt` / `AnalyzeFrameTilt`（7a-1）·
  `AssessShockleyOnset` / `AssessAtomicPhase`（未排期）· `PreScanCheck`（未排期）。
  **`PulseConditionTip` 现在只差 `FindCleanSpot` 一件。**

---

## 10. 值得进课时的三件

### ① 一条推得出来、也在问对问题的容差，**还可能配错了分母**

批 6c §9③ 记的是「同一个函数的两个入口精度差六个数量级」。
这一批是它的第四面：**同一个入口，喂不同的输入，误差来源的分母就换了。**

`localPlaneRms` 的误差主项是 `z − (a·x+b·y+c)` 每个元素的 `eps·max|z|` 舍入 ——
这是一个**绝对**量。把它写成「相对 `rms`」的形式，在一块带噪声的窗上看起来没问题
（`max|z|/rms` 是 10²–10³，常数吸收得掉），而在一个**纯平面**的窗上
`rms` 掉到 `3e−25`、比值变成 10¹⁴，那条容差立刻在问第 25 位。

> 「一条容差要么推得出来，要么就别写」的第四面：
> **推导给的是绝对界时，就别把它写成相对的。**
> 相对与绝对的区别不是书写风格，是**分母是谁**。

### ② 「打错了行」有两种，第二种更难看出来

批 4b 记的第一种是「这一行不可达」。这一批撞到第二种：
**这一行可达、也真的跑到了，但它做的不是那个决定。**

`if (c.rms > usableRmsM) break` 里，`break` 与 `continue` 在一份**已排序**的候选表上
给出同一个答案 —— 那个词是一个纯优化。真正做决定的是 `c.rms > usableRmsM`
这个条件本身。第一版的变异改的是前者，于是它问的是「循环怎么退出」，
而不是「不合格的窗收不收」。

两种的共同点是覆盖率对它们都一言不发；区别是第一种能靠 grep 调用链证明，
**第二种只能靠「拆掉它，答案变了吗」** —— 也就是变异演练本身。

### ③ 一个盘点用的量法，**会漏掉它量不到的那一类**

「函数体里有几个 `mast.*` import」是一个好量法：它便宜、可 grep、
而且这一轮三次都对（`FindCleanSpot` 的 1069 行、`FindFlatRegion` 的 45 行、
`BiasWiggle` 的 0 行）。

它漏掉的是**不以 import 形式出现的依赖**：
`BiasWiggle` 缺的 `allow_on_abort` 是 `safe_call` 的一个**关键字参数**，
`PreScanCheck` 缺的 `safe_mode_active` 是一个**内核接口**。
两件都不是 import，于是两件都不在那个量法的射程里。

> 一份盘点的价值在它的**射程**说得清楚。
> 「零 `mast.*` import」的射程是「它不从别的模块**拿东西**」——
> 而「它需要框架**允许它做什么**」是另一个问题，要另一次 grep
> （本批的办法：把函数体里每一次 `safe_call` 的**关键字参数**也扫一遍）。
