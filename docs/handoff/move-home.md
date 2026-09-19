# 收尾支线交接 —— 执行第六轮两批留下的两份搬家清单

批 6b 与批 6c 并行，各被禁止碰对方主用的包，于是各自把「该放在别处的件」留在手边
并写了清单。两批都合进 master 之后，由本支线执行。

**八件搬完、两处撞名。** 一处（`fwdBwdInstability`）**两份真的不一样**，
用旧仓的 Python 实跑分出了对错、只留一份；另一处（`polyfit`）**两份也不一样**，
而且**不该合并** —— 它没有搬，理由与证据在 §3。

测试 **6167 条**（与合并前同数）· 金样 **零字节改动** · 变异 **591 条预检全过**，
受影响的 **27 条逐条实跑到 red**。偏差登记 **+2 条**（编号留空）。

---

## 0. 一句话

> 两份清单都说这是「机械移动」。移动确实是机械的 ——
> **真正的活是那两处撞名，而它们都不是「一样的东西写了两遍」。**
> 一处是同一段 Python 的两种读法（**Python 切片的负起点会回绕**，一份照抄了、
> 一份夹紧了），另一处是同一个 numpy 函数的两种解法（QR 与正规方程，差 `5e−9`）。
> 两处的共同点是：**闭着眼合会静默改判据，而睁着眼看又看不出来** ——
> 分开它们的输入一个在 `H ≤ 3` 的帧上，一个在 `deg = 3` 的第九位上。

---

## 1. 搬了什么

### 清单一（批 6c 交接 §8）：四件判据本体 `l0/` → `vision/`

| 从 | 到 | 行 | 备注 |
|---|---|---|---|
| `stm-skills/src/l0/vision-tip-metrics.ts` | **并进** `vision/src/tip-metrics.ts` | 254 → 并入（464） | 撞名，见 §2 |
| `stm-skills/src/l0/vision-spectroscopy.ts` | `vision/src/spectroscopy.ts` | 236 | 机械 |
| `stm-skills/src/l0/vision-force-inversion.ts` | `vision/src/force-inversion.ts` | 397 | 机械 |
| `stm-skills/src/l0/vision-lattice-multiframe.ts` | `vision/src/lattice-multiframe.ts` | 341 | 机械 |
| `stm-skills/src/l0/batch6c-units.test.ts` | `vision/src/batch6c-units.test.ts` | 421 | **整份跟着搬**（金样相对路径 5 级 → 4 级） |

改动仅限：`import` 路径 · `vision/src/index.ts` 加三行 `export *`（`tip-metrics` 早已在导出）·
`l0/index.ts` 删四行 · 三个技能外壳与 `batch6c-skills.test.ts` 的 import 改指 `dsh-spm-vision` ·
各文件抬头里「这个文件住错了地方」那一节换成一行「来处」。
**判据、容差、断言一个字未改。**

### 清单二（批 6b 交接 §7）：数值原语 `vision/` → `numerics/`

| 件 | 从 | 到 | 结果 |
|---|---|---|---|
| `uniformFilter1d/2d` · `medianFilter1d/2d`（含 `windowSpan` / `rankOfWindow`） | `vision/src/ndfilters.ts` | `numerics/src/ndfilters.ts` | ✅ **整份搬**（170 行） |
| `lstsqQr` | `vision/src/lsq.ts` | `numerics/src/lsq.ts` | ✅ 搬（97 行） |
| `polyfit`（含 numpy 的列缩放） | `vision/src/lsq.ts` | — | ❌ **没搬**，见 §3 |

⚠️ 6b 特别交代的那段抬头（`uniformFilter1d` 是**跑动和**、一个 NaN 污染这一行剩下的
每一个输出、而那直接决定 `scan_prep` 里粗糙度的输入）**整段随文件搬走了，一个字未改** ——
它现在是 `numerics/src/ndfilters.ts` 抬头的第二节。钉住它的那条变异
（`ndfilters-uniform-is-a-running-sum`）跟着改了路径，实跑仍 red。

---

## 2. 两份 `fwdBwdInstability`：怎么验「它们真的一样吗」

清单一第一件就是 6c 预告的那个坑：批 6b 后来也往 `vision/src/tip-metrics.ts` 加了
一份 `fwdBwdInstability`。**先查、不许闭着眼合。**

### ① 先读，找出两份在哪一行上分岔

两份的数学骨架完全一样（`detrend` → 去均值 → 归一化互相关 → `1 − max`），
逐行比下来只有**一处结构性差异**：取那个允许平移的窗口时 ——

```python
# 旧仓 mast/vision/tip_metrics.py:118
win = xc[cy - ry:cy + ry + 1, cx - rx:cx + rx + 1]
max_ncc = float(win.max()) if win.size else float(xc.max())
```

这是一次 **Python 切片**：负起点**回绕**到 `H + start`、终点截断到 `H`、
绕过头就是空窗（于是退回全局 max）。

* **6c 那份**照抄了这条语义（`r0 = cy-ry < 0 ? H + (cy-ry) : cy-ry`）；
* **6b 那份**把越界的位移 `continue` 掉了 —— 那是**夹紧**，不是回绕。

`cy = H//2`、`ry = max(2, int(0.12·H))`，所以 `cy − ry < 0` 只在 **`H ≤ 3`** 时发生。

### ② 再造一个**能把两者分开**的输入，而不是抽象地论证

写了一份临时探针（跑完即删），在同一批合成帧上同时调两份：

| 帧 | 6b（夹紧） | 6c（切片） | 逐位相同？ |
|---|---|---|---|
| 48×48 / 64×64 / 128×128 / 32×48 / 8×8 / 5×5 / 4×4 | 一致到 `≤ 4.4e−16` | | 大多否，差在最后一两位 |
| **3×3** | `0.63707` | `1.00000` | ✗ **差 0.36** |
| **2×2** | `0.00000` | `1.00000` | ✗ **差 1.0** |
| **3×16** | `0.23251` | `0.43656` | ✗ |
| **16×3** | `0.15563` | `1.00000` | ✗ |

⇒ 分得开。`≥ 4×4` 上的 `4.4e−16` 只是成对求和 vs 朴素求和的最后一位
（容差是 `7.6e−6`）—— **也就是说没有一格现有金样能分开它们**，
这正是「逐位相同是一条可以自查的指纹」（批 6c §9①）的反面用法。

### ③ 再问「哪一份是对的」—— 对着旧仓那段 Python 实跑

**不 import 旧仓**（避免往只读仓里写 `__pycache__`）：把 `_detrend` 与
`_fwd_bwd_instability` 那十行逐字抄进 scratchpad 的一个独立脚本，用旧仓的
`.venv-v2-py313` 跑，并额外跑一路「把切片换成夹紧」的对照，
用来把**窗口语义之差**与 **float32 FFT 之差**分开：

| 帧 | 旧仓 Python（float32） | Python + f64 **切片** | Python + f64 **夹紧** | TS 6b | TS 6c |
|---|---|---|---|---|---|
| 3×3 | `1.00000` | `1.00000` | `0.63707` | `0.63707` | `1.00000` |
| 2×2 | `1.00000` | `1.00000` | `4.7e−14` | `0.00000` | `1.00000` |
| 3×16 | `0.43656` | `0.43656` | `0.23251` | `0.23251` | `0.43656` |
| 16×3 | `1.00000` | `1.00000` | `0.15563` | `0.15563` | `1.00000` |

**结论没有歧义**：6c 那份 = Python 切片那一路；6b 那份 = 夹紧那一路。

### ④ 最后问「这个形状够得着吗」—— 够得着

`scan_prep.measureFrame` 喂给它的不是整帧，是
`acquiredRowSpan` 切出来的**已扫行段**（`span = sliceRows(lined, r0, r1)`）。
一张刚开扫的帧就只有一两行。按真实形状（`h × 64` / `h × 256`）再跑一遍：

| 形状 | 旧仓 Python | TS 6c | TS 6b |
|---|---|---|---|
| 1×64 | `0.78273` | `NaN` ✗ | `1.6e−13` ✗ |
| 2×64 | `0.74833` | ✔ | ✔（巧合，见下） |
| 3×64 | `0.73831` | ✔ | `0.70016` ✗ |
| 2×256 | `0.86786` | ✔ | `0.86359` ✗ |
| 3×256 | `0.85660` | ✔ | `0.85582` ✗ |
| ≥ 4 行 | — | ✔ | ✔ |

（`2×64` 那一格 6b 也对：夹紧取的是切片的**超集**，多出来的那一行恰好没抬高 max。
`2×256` 上它就抬高了。**一格巧合的绿比红更坏** —— 又一次。）

### ⑤ 处置

**留 6c 那一份**，6b 那份连同它的 `FB_MAX_SHIFT_FRAC`（与 6c 的
`INSTABILITY_MAX_SHIFT_FRAC` 同值同义，`0.12`）一起删掉。
`scan-prep.ts` 的 import 路径不变（`./tip-metrics.js`），它现在拿到的是对的那一份。

**留下来的两条容差都没动**：`FB_INSTABILITY_ABS_TOL`（6b，`64·eps32` 定常）与
`instabilityAbsTol(n)`（6c，`8·eps32·log₂n`）是同一个量的两条独立推导，
分别被 `scan-prep.test.ts` / `scan-prep-skills.test.ts` 与 `batch6c-units.test.ts` 读。
动任何一条都是改断言，不是搬家。

**两份都没能复现的一格**：`H = 1`。那时 `[x, y, 1]` 秩亏，numpy 的 `lstsq` 给最小范数解、
照常去趋势，而本仓 `lstsqPlane` 回 `null` ⇒ `detrend` 整帧 NaN ⇒ 结果 NaN；
6b 那份走 `detrend32`（秩亏时系数退化成 `[0,0,0]`），给出 `~1e−13` 的**假「完全一致」**。
两种都不是旧仓的答案。**本轮不改**（没有金样，改它要动 `lstsqPlane` 的秩亏语义，
而那一份有十几个消费方与四份金样在读）——
登记为 `D-TIPMETRIC-1`，并写清销它需要什么。

> 顺带核出来的一件：`vision` 里**已经有两份 `_detrend`** ——
> `frame-validity.detrend`（批 4a）与 `tip-metrics.detrend32`（批 4b）。
> 实测在有限输入上 **2304 / 2304 个元素逐位相同**，分岔只在 NaN 与秩亏这两处
> （`detrend` 让整帧变 NaN，与 `np.median` 一致；`detrend32` 的 `npMedian` 用
> JS 的 `sort` 比较 NaN，不传播）。**本轮没有合并它们** —— 那是清单之外的事，
> 而且它同样需要先有一格能分开它们的金样。记在这里，给下一个人。

---

## 3. `polyfit` **没有搬**，而这是一条判据不是偷懒

`numerics` 里**已经住着一个 `polyfit`**（`savgol.ts`，批 5a/5b 落的），
而 `vision/lsq.ts` 那一份是另一个东西：

| | `vision/lsq.ts` | `numerics/savgol.ts` |
|---|---|---|
| 解法 | 列缩放 + Householder **QR** | 列缩放 + **正规方程** + Cholesky |
| 误差 | `κ·eps` | `κ²·eps`（`lstsqRelTol`） |
| 某列范数为 0 | 照解（`c[k] = 0`） | **抛**「设计矩阵不满秩」 |
| 实测差（`n=256, deg=3`） | 系数相对差 **`5e−9`** —— 不是最后一位 | |

三条路都不通：`export *` 会撞名（TS 直接编不过）；改名是重写；
统一成任一份会**同时**改动 `spec/golden/numerics.json`（`polyfit` 一节 + `savgol`
两端那一段）与 `spec/golden/scan_prep.json`（`line_subtract` 一族）——
而铁律是金样一个字节不动。

而且**各自的消费方要的正是各自那一档精度**：`scan_prep.poly_subtract(order=2)`
的设计阵在 256 边长上 κ(A) ≈ 1e6，正规方程只剩四位，而 `bow_gain` 要拿残差跟
1.15 比大小。这不是「哪一份更好」，是两个不同的问题。

⇒ **`lstsqQr` 搬了，`polyfit` 留在 `vision/src/lsq.ts`**（54 行，从
`dsh-spm-numerics` 拿 `lstsqQr`）。两个文件的抬头各写清了另一半在哪、为什么。
登记为 `D-LSQ-1`，并写明要合并的判据是**先有一格能分开它们的金样**。

---

## 4. 依赖方向核对

| 断言 | 怎么核的 | 结果 |
|---|---|---|
| `numerics` 不依赖 `vision` | `numerics/package.json` 的 `dependencies` 只有 `dsh-spm-kernel`；`numerics/tsconfig.json` 的 `references` 只有 `../kernel`；`grep -rn 'dsh-spm-vision\|dsh-spm-stm-skills' numerics/src/` 只剩 `calculus.ts` 抬头里一句**文字引用**（不是 import） | ✅ |
| 搬进 `numerics` 的两件零外部依赖 | `ndfilters.ts` 原来只 import `boundaryIndex`/`matOf`/`BoundaryMode`/`Mat`，全部在 `numerics` 内（改成 `./filters.js` 与 `./mat.js`）；`lsq.ts` 的 `lstsqQr` **一行 import 都没有** | ✅ 不可能成环 |
| `vision → numerics → kernel` 仍成立 | `vision/tsconfig.json` 的 `references` = kernel + numerics + nanonis-files（最后一个只给测试用） | ✅ |
| 搬进 `vision` 的四件不回指技能层 | 四份原文件的 import 只有 `dsh-spm-numerics` / `dsh-spm-vision` / `dsh-spm-kernel`，搬后全部改成包内相对路径或 `dsh-spm-kernel` | ✅ 6c「零技能层依赖」属实 |
| `tsc -b` | 全仓通过 | ✅ |

另：除 `packages/host/compat/src/` 外无 `from '@deepseek-ai/`（未新增任何一处）。

---

## 5. 变异

**全仓预检**（每条 `find` 在 `file` 里唯一命中 + `scope` 覆盖 `file`）：
**591 条，0 条有问题。**

改了 **25 条**（另有 2 条虽未改条目，但所在文件被编辑，一并重跑）：

| 条数 | 改了什么 |
|---|---|
| 22 | `file`：`${SK}/l0/vision-{tip-metrics,spectroscopy,force-inversion,lattice-multiframe}.ts` → `${V}/{tip-metrics,spectroscopy,force-inversion,lattice-multiframe}.ts`；**`scope` 也得改** —— 旧的 `packages/host/stm-skills` 不再覆盖 `file`，判据③ 会当场判 `inconclusive`。19 条落在 `packages/host/vision`，3 条落在 `packages/host`（见下） |
| 2 | `ndfilters-*`：`file` `${V}/ndfilters.ts` → `${NU}/ndfilters.ts`（`scope` 本来就是 `packages/host`，不用动） |
| 1 | `scanprep-roughness-is-a-mean-filter`：它**打在 import 上**，而那一行的模块说明符从 `'./ndfilters.js'` 变成了 `'dsh-spm-numerics'` —— `find` 与 `replace` 一起改 |
| (2) | `phase-detrend-*`：条目没改，但 `vision/src/tip-metrics.ts` 被编辑过，重跑确认 |

**逐条实跑**（`build → gen:skills → gen:progress` 之后，基线干净）：**27 / 27 red**。

### ⚠️ 第一轮有 **3 条绿**，而它们照出了一件搬家自带的事

第一轮把 22 条一律改成 `scope: 'packages/host/vision'`（最窄、且覆盖 `file`）。
19 条 red，**3 条绿**：

```
lattice-consistency-subtracts-the-scan-angle
lattice-unusable-is-not-evidence
lattice-angle-spread-is-per-sixty-degrees
```

不是代码错，也不是闸没人看 —— 是**看它的那个人被搬到别的包去了**。
批 6c §10 说过：为了压测试时间，`assess_atomic_consistency` 的十一格逐格比对
**从判据本体那一份里拿掉了**，由技能那一份（`batch6c-skills.test.ts`，15 格）覆盖同一条链。
搬家之前，`file` 与那份测试都在 `stm-skills`，一个 `packages/host/stm-skills`
同时罩住两者；**搬完之后判据在 `vision`、唯一的证人还在 `stm-skills`** ——
没有哪个单包 scope 同时覆盖它们。

⇒ 这三条的 `scope` 是 `packages/host`（两者的公共前缀）。改完重跑 **3/3 red**。

> 这件事值得单记：**一次搬家会移动「谁在看这道闸」，而 `scope` 是那个关系的唯一声明。**
> 判据③（「跑的范围包含被变异的文件」）挡得住「文件不在范围里」，
> **挡不住「证人不在范围里」** —— 后者的表现是一条安安静静的绿。
> 只有把每一条真跑一遍才看得见；预检（唯一命中 + 覆盖 `file`）**全过**，一条都没报。

---

## 6. 我核出来与两份清单不一样的地方

| 清单说 | 实际 |
|---|---|
| 6c §8：四个文件「都是零技能层依赖 ⇒ 搬家 = 移文件 + 改 `vision/src/index.ts` 的**四行** `export *`」 | 零依赖属实；但只加**三行** —— `tip-metrics.js` 早就在 `index.ts` 里（批 4b 加的），第一件是**并进**它，不是新增一行 |
| 6c §8：第一件「机械移动」 | **不是机械的**。批 6b 在同一个文件里落了第二份 `fwdBwdInstability`，两份在 `H ≤ 3` 上给出不同答案，而那个形状在 `scan_prep` 的已扫行段上够得着。见 §2 |
| 6c §8：「⚠️ 搬之前先看一眼批 6b 有没有在 `vision/` 里也落了 `tip-metrics` 的东西」 | **它落了，而且不只是「也有一份」** —— 是**不对的那一份**。这条提醒值回票价 |
| 6b §7：四件都「有第二个消费方」⇒ 都该进 `numerics` | `uniformFilter*` / `medianFilter*` / `lstsqQr` 属实。**`polyfit` 不成立**：`numerics` 里已经有一个同名而不同解的 `polyfit`，它要的不是「搬过去」，是「先证明两份能不能合」。见 §3 |
| 6b §7：`lstsqQr`「每一个设计阵不是 `[x,y,1]` 的最小二乘」都会用 | 今天它的消费方只有两个，**都在 `vision` 里**（`plane.polySubtract(order=2)` 与同文件的 `polyfit`）。仍然搬了（它对的是 `np.linalg.lstsq` 本身，归属清楚），但「第二个消费方」这句话现在是**将来时** —— 记在这里，免得下一个人把它当成既成事实 |
| 任务书：全仓单测 **6167** | 属实，但要说清是**哪一个数**：`unit` + `contract` 是 **6167 / 106 文件**；加上 `integration`（要 `STMSIM_PYTHON` / `STMSIM_ROOT`，不给会**整趟拒跑**而不是跳过）是 **6253 / 121 文件**。两个数搬家前后都没变 |
| （两份清单都没提） | `vision` 里**已经有两份 `_detrend`**（`frame-validity.detrend` / `tip-metrics.detrend32`），有限输入上逐位相同、NaN 与秩亏上不同。本轮**没动**，见 §2 末尾 |
| （两份清单都没提） | 搬家会**拆散「判据」与「看它的那份测试」**。三条 `lattice-*` 的证人留在了 `stm-skills`，于是最窄 scope 下它们是绿的 —— 预检全过、只有实跑照得出来。见 §5 |

---

## 7. 验收

| 项 | 合并前 | 现在 |
|---|---|---|
| `pnpm build` | ✅ | ✅ |
| 单测（`unit` + `contract`） | **6167** / 106 文件 | **6167** / 106 文件 |
| 单测（含 `integration`） | 6253 / 121 文件 | 6253 / 121 文件 |
| 金样 | — | `git status -- spec/golden/` **零改动** |
| 变异预检 | — | 591 条 / 0 问题 |
| 受影响的变异 | — | 27 条逐条实跑 **red** |
| 生成物（`specs.ts` / `progress.json`） | 417 技能 · 92/165 模块 | **一个字节没变**（重跑确认） |

逐条 red 的 27 条：

```
phase-detrend-subtracts-the-row-median          phase-detrend-output-is-float32
scanprep-roughness-is-a-mean-filter             ndfilters-uniform-is-a-running-sum
ndfilters-even-window-takes-the-upper-median    edge-resolution-step-floor-is-a-real-gate
edge-resolution-outlier-ratio-is-six            edge-resolution-width-is-point-eight-of-the-step
edge-resolution-smooths-at-one-pixel            instability-zero-guard-is-not-a-physical-threshold
instability-allows-a-lateral-shift              instability-conjugates-the-second-frame
spectro-iz-floor-follows-the-curve              spectro-jump-is-eight-mads
spectro-iv-symmetry-is-antisymmetry             spectro-iz-sorts-by-z
spectro-iv-sorts-by-bias                        force-first-interval-is-integrated-analytically
force-last-point-copies-its-neighbour           force-energy-is-referenced-far-away
force-smooth-needs-five-points                  force-unbracketed-well-is-undecidable
force-residual-line-is-ten-percent              lattice-consistency-subtracts-the-scan-angle
lattice-unusable-is-not-evidence                lattice-pair-is-forced-obtuse
lattice-angle-spread-is-per-sixty-degrees
```

---

## 8. 留给下一个人的三件

1. **`D-TIPMETRIC-1`（`H = 1` 的帧）** —— 要销它需要 `H = 1/2/3` 三格
   `fwd_bwd_instability` 金样，由 `export_scan_prep.py` 从旧仓导出。
   有了那三格，`lstsqPlane` 的秩亏语义该怎么处置就是**被测出来的**，不是被决定的。
2. **`D-LSQ-1`（两份 `polyfit`）** —— 要合并，判据是**先有一格能分开它们的金样**
   （已经知道 `n=256, deg=3` 分得开，差 `5e−9`）。
3. **两份 `_detrend`** —— 同 2 的形状，而且更近：有限输入上逐位相同，
   所以「看起来一样」这一关它是过得去的。**正因为过得去，才要先造那一格。**
