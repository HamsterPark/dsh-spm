# 批 7b-3 —— composite 零新原语五个 + paper 四个纯函数

**2026-09-20。** 九个技能，一件新原语都没拉
（`packages/host/{vision,kernel,numerics}/src/index.ts` 三个锚点一个字都没动）。

| | 开工前 | 收工 |
|---|---|---|
| 技能 | 424 / 515 | **433 / 515** |
| 模块 | 98 / 165 | **105 / 165**（+7，见 §1） |
| partial | 0 | **0** |
| 单元 + 契约（`--project '!integration'`） | 114 文件 / 6946 条 | **115 文件 / 7118 条** |
| 全量（含 integration，`STMSIM_*` 就位） | —— | **134 文件 / 7225 条**（⚠️ 有一条**先于本批就存在**的间歇红，见 §7.8） |
| 变异清单 | 712 条 | **758 条**（+46，**46/46 实跑变红**） |

---

## 一、落了什么

### 甲 · `composite` 五个（`packages/host/stm-skills/src/composite/`）

| 技能 | 文件 | 行 | 模块清零 |
|---|---|---|---|
| `GridSTS` | `grid-sts.ts` | 258 | `composite.grid_sts` ✓ |
| `DemoScanAndSTS` | `demo-scan-and-sts.ts` | 268 | `composite.demo_scan_and_sts` ✓ |
| `TrackDrift_ReferenceScan` | `drift-track.ts` | 299 | `composite.drift_track` ✓ |
| `AcquireBiasImagingSeries` | `bias-imaging-series.ts` | 367 | `composite.bias_imaging_series` ✓ |
| `MoveAtomTo` | `move-atom-to.ts` | 427 | `composite.move_atom_to` ✓ |

### 乙 · `paper` 四个（`l0/paper-region.ts` 一个文件，651 行）

| 技能 | 模块清零 |
|---|---|
| `DiffScans_ChangeDetect` | `paper.scan_diff` ✓ |
| `DeconvolveTip_RL` | `paper.deconvolution` ✓ |
| `SegmentRegion_UNet` · `DetectAtoms_FCN` | `paper.region_analysis` **不清零** —— 剩下两个（`PredictStructure_ASD` / `IdentifyTopology_CARP`）是盘点 D 档（`model_path` 必填、零回退）。**那个模块的可移植部分这一批做完了** |

**七个模块清零** = 5 个 composite + 2 个 paper。

---

## 二、金样：几节几格

| 金样 | 导出器 | 格数 |
|---|---|---|
| `spec/golden/batch7b3.json`（新） | `tools/spec-export/export_batch7b3.py`（新，611 行） | **54 格 / 5 节**：`GridSTS` 7 · `DemoScanAndSTS` 10 · `TrackDrift_ReferenceScan` 11 · `AcquireBiasImagingSeries` 10 · `MoveAtomTo` 16 |
| `spec/golden/paper_data.json`（并进批 4c 那一份） | `export_paper_data.py`（+4 个技能、+4 张合成图、+1 节 `rl_facts`） | **+35 格**：`DiffScans` 10 · `DeconvolveTip_RL` 11 · `SegmentRegion_UNet` 7 · `DetectAtoms_FCN` 7 |
| `spec/golden/skill_traces.json` | `export_skill_traces.py`（`BATCH_7B_3` 名单 + 汇总处一行） | **+9 个技能 / +63 条轨迹**（1669 → 1732）。**其余 424 个技能一个字节都没动**（逐键比过，`changed count: 0`） |

**DoD ⑤ · 重跑逐字节相同**：三台导出器各跑两遍，`cmp` 三个全 `IDENTICAL`。
**旧仓只读自证**：`find <MAST_ROOT> -newermt "2026-09-19 22:16:55"`
（排除 `__pycache__` / `.git`）**输出为空**；三台导出器都
`os.environ.setdefault("MAST2_PROJECT_ROOT", tempfile.mkdtemp(...))`。

---

## 三、变异演练：**46 条，46 条全红**

日志三份，都在 `docs/handoff/`：

| 日志 | 内容 |
|---|---|
| `drill-7b-3-2026-09-20.log` | **第一趟 46 条**：33 红 · 7 inconclusive（`noUnusedLocals` / 类型收窄，构建不过）· **6 绿** |
| `drill-7b-3-redo-2026-09-20.log` | 修完之后那 13 条重跑：**13/13 红** |
| `drill-7b-3-final-46-2026-09-20.log` | **在最终树上把 46 条整趟重跑**：46/46 红。<br>（要重跑是因为期间改过生产代码与金样 —— 「一次演练的有效期只到下一次重构为止」） |

**那 6 条绿值钱，逐条记在 §7.4 / §7.5。** 一句话：
一条是**那一行根本不是闸**（`x ** 1.0` 精确等于 `x`），
五条是**闸只有一侧有输入**（金样分辨不出两种候选）。

四判据每条都满足：唯一命中并回读 · `tsc -b` 退 0 ·
scope（`packages/host/stm-skills`）覆盖被变异文件且打出了 `Tests` 汇总行 ·
**开跑前基线为 0**（`run.ts` 自己量，脏树整趟拒跑）。

---

## 四、偏差（`spec/deviations.md`，编号留 `?`，七条）

| | 说的是 |
|---|---|
| `D-PAPER-6` ML 支不移 | `SegmentRegion_UNet` / `DetectAtoms_FCN` 只留启发式，`method` 报**真的跑了哪一条**。巧的是旧仓的 `except` 分支本来就这么报 ⇒ 本仓**永远走旧仓的那一支**（与 `DetectAtomJump` 报「请求的那一条」刻意不同） |
| `D-PAPER-7` `ndim != 2` 的等价条件 | 本仓是 `rows === 1`，逐格等价，**只有 `(1,1)` 的报文差一处**（旧仓印 `()`，本仓印 `(1,)`）。没为它录金样，理由写了 |
| `D-PAPER-8` `_resolve_output_path` 不碰文件系统 | 旧仓 `Path.resolve()` 比，本仓归一分隔符逐字比。代价说清：经 symlink 指回输入的 `save_path` 挡不住 |
| `D-PAPER-9` `fftconvolve` ↔ `correlate2d` | 恒等式只在奇数核上连原点对上，偶数核**补一行零**。金样一格 4×4 专门验；`iterations_used` 容差 0，余量由 `rl_facts` 录着 |
| `D-MANIP-1` 「仪器没还原」印 `None` | **照移**，两条理由 + 该怎么修 + 对照的那一格（`explicit_manip_conditions_give_a_resistance`） |
| `D-GRID-2` 三条闸够不着 | `_MAX_TRACKED_POINTS` 的两条 + `has_dims` 回落。先证明够不着（`nx`/`ny` 各封顶 20 ⇒ 最多 400），再决定拿它怎么办 |
| `D-SAVE-1` `SaveScan` 接上文件系统 | 唯一改到的共享生产文件，见 §5 |

---

## 五、共享文件改了哪里（合并时看这一节）

**九个锚点文件里只动了四个，各自只在 `批 7b-3` 锚点里：**

| 文件 | 改了什么 |
|---|---|
| `scripts/gen-skill-specs.ts` | `BATCH_7B_3` 名单（9 个名字） |
| `tools/spec-export/export_skill_traces.py` | `BATCH_7B_3` 名单 |
| `spec/deviations.md` | 七条登记 |
| `spec/golden/README.md` | 两行表（新导出器 + paper_data 的增量） |
| `packages/host/stm-skills/src/l0/index.ts` | 锚点下的 import 与展开 |
| `tools/mutate/mutations.ts` | 锚点下 46 条 |
| `packages/host/{vision,kernel,numerics}/src/index.ts` | **一个字都没动**（零新原语） |

### 锚点之外的三处，逐条点名

1. **`packages/host/stm-skills/src/l0/scan.ts`** —— 这一批唯一改到的**共享生产文件**。
   新增 `findLatestSxmInSession()`（复用 `frames.ts` 的 `sessionDir` /
   `existingDirs` / `findLatestSaved`，不写第二份），并把
   `export const SaveScan = makeSaveScan()` 改成
   `makeSaveScan({ findLatestSxm: findLatestSxmInSession })`。
   **金样零变化** —— 旧仓那侧 `saved_path` 本来就是 `null`（合成的会话目录不存在）。
   真的找得到文件这件事只有真 stmsim 验得到，集成测试有一格专门为它。
2. **`gen-skill-specs.ts` 与 `export_skill_traces.py` 的 `main()` 汇总处**各加一行
   `+ BATCH_7B_3`（以及生成注释里的一行计数）。那两处**没有 7b 的锚点**；
   我顺手把 `+ BATCH_7B_1` / `+ BATCH_7B_2` 的位置也一并留好了
   （它们现在是空表，合进来时只要填名单，不用再动汇总处）。
3. **`packages/host/stm-skills/src/l0/traces.test.ts`** —— 加了一条 scrub 规则
   （`drift_ref_<毫秒>.npy` 的毫秒 → `<stamp>`）。见 §7.7。

---

## 六、缺件清单：**空的**，而「追到哪儿为止」在这里

这一轮的纪律是「缺件清单要附一句追到哪儿为止」（EXECUTION §第七轮 7a）。
本批缺件为零 —— 但**零也要说清是怎么追出来的**，否则它和「没追」长得一样。

**composite 五个，追的是子技能名单。**
逐个抽出 `plan` / `plan_dynamic` / `run_composite` 里
`CompositeStep(skill_name=…)` 与 `context.run(…)` 的第一个实参，得到 21 个名字；
拿 `spec/progress.json` 的 `impl` 逐个核 —— **21 个全 `true`**：

```
VerifyAdatomAt · SetTipSpeed · GetTipSpeed · GetCurrentGains · SetCurrentGain ·
AssessAtomicResolution · GetScanFrame · GetSetpoint · GetBias · ConfigureSTS ·
AcquireSTS · MoveToXY · FullScan · ScanAt · SetBias · SetSetpoint ·
ConfigureScan · SetScanSpeed · StartScan · WaitScanComplete · SaveScan
```

**追到哪儿为止**：对每一个 `impl === true` 的子技能**不再往下追** ——
它已落 = 它自己的闭包在本仓跑过一遍 DoD（规格 / 金样 / 单测 / 集成 / 变异）。
这与 7a 撞的那四次不同形：那四次漏的是**没落**的件下面还有件，
而这里一个「没落」的件都没有。

⚠️ **这个量法照不到「本仓要先长出什么」**（7a 第 4 条的那一层）。
本批照到了一次：`AcquireBiasImagingSeries` 要的不是一个 import，是
**`SaveScan` 得真的会找文件** —— 那是下游能力，不是上游依赖。
它是怎么被照出来的：不是靠依赖扫描，是靠**通读它「什么都对」时会说什么**
（拿不到路径 ⇒ 每帧记失败 ⇒ `n_ok` 永远 < 2 ⇒ 建议永远是「比不了」）。
⇒ **一条「这个技能在一切正常时会说什么」的通读，比依赖表照得远。**

**paper 四个，追的是函数级。**
`scan_diff.py` / `deconvolution.py` / `region_analysis.py` 里被 `execute` 真正
调到的每一个函数（`diff_scans` · `drift_xcorr` · `make_gaussian_psf` ·
`richardson_lucy` · `heuristic_segment` · `heuristic_detect_atoms` ·
`load_image_2d`），逐个看它 import 了什么，**直到全部落在本仓已有的件上**：

| 旧仓 | 本仓 | 在哪 |
|---|---|---|
| `drift_xcorr` | `driftXcorr` | `l0/paper-data.ts`（批 4c） |
| `scipy.signal.fftconvolve(·, 'same')` | `correlate2d` + 补零 | `numerics/correlate.ts`（批 4c 为 `ComputeDriftVector` 写的） |
| `np.quantile` | `percentile` | `numerics/stats.ts` |
| `scipy.ndimage.maximum_filter` | `greyDilation` + `rectSE` | `numerics/morphology.ts` |
| `scipy.ndimage.label` | `labelConnected` | `numerics/label.ts` |
| `load_image_2d` / `.npy` 写 | `loadImage2d` / `siblingNpy` + `encodeNpyFrame` | `l0/paper-common.ts`（批 4c） |
| Python 的 `%.4g` / `%.Nf` | `formatG` / `pyFixed` | `kernel/si.ts` · `kernel/z-trace.ts` |

最后一行是**自查出来的**：第一版我自己写了 `pyG4` / `pyF0` / `pyF2` 三个格式化函数，
而 kernel 里三样都有，其中 `pyFixed` 是批 6b 拿 75 901 格对着 CPython 校过的那一份
（我那个 `pyF2` 用的 `toFixed` 在半分点上与 `%.2f` 不同）。**已删，全部改走 kernel。**

---

## 七、与任务书不一样的（九条）

### 7.1 ⚠️ **「三个 STS 技能采集路径不可达」那条不适用于本批**

任务书写着：

> 三个 STS 技能的采集路径旧仓出厂就不可达：`sts_workflow.py:251` 的 `CONDITIONS`
> 只有一个组、四个样品事实全 `None` ⇒ `usable` 恒 `False`。
> ⇒ 验收标准是「拒绝得对不对」，不是「采到了几条谱」。

**实测：我这五个技能里没有任何一个碰 `mast.core.sts_workflow`。**

```
grep -l sts_workflow mast/skills/composite/*.py
⇒ line_sts_across_wall.py · spectroscopy_at_positions.py · sts_condition_series.py
```

那三个是 survey7-composite 的 **C 档**（504 / 339 / 215 行），**一个都不在本批**。
`survey7-composite.md` ⚠️ 第 5 条本身写得很准（它点名的就是那三个），
任务书在转述时把它挂到了本批头上。

**那么本批的 STS 是怎么收的？**
`GridSTS` 与 `DemoScanAndSTS` 走的是 `ConfigureSTS` → `MoveToXY` → `AcquireSTS`
三件**裸子技能**，一次条件表都不查；三件在 `progress.json` 里全 `done`，
所以采集路径**是可达的**。于是验收分两层，两层都造了：

| 层 | 在哪 | 它能答什么 |
|---|---|---|
| **计划与记账** | `batch7b3.json`（旧仓真跑，子技能由脚本摆） | 排了谁、按什么次序、带什么参数；三本账（`succeeded` / `suspect` / `failed`）；成功与失败的判定 |
| **真的采到谱** | `integration/batch7b3.test.ts`（真 stmsim） | `GridSTS` 2×2 四条谱**全是真采的**（`succeeded: 4`）；`DemoScanAndSTS` 两条同理 |

**所以我没有按「拒绝得对不对」收这一批** —— 那个前提在这五个技能上不成立。
造金样时确实没造「采成功」那一格，但理由不是造不出来，而是
**那一格属于真 stmsim 那一层**：金样那一台的子技能返回由我摆，
拿它声称「采成功」等于拿我自己写的脚本给我自己发证。

（顺带核过：`AcquireBiasImagingSeries` / `MoveAtomTo` / `TrackDrift_ReferenceScan`
也都不碰条件表。）

### 7.2 `AcquireBiasImagingSeries` 走的是**基类驱动器**，另外四个不是

它没有 override `run_composite` ⇒ 走 `_base._graph_execute` ⇒ 顶层 `data`
多三个键（`aborted` / `aborted_by_operator` / `abort_reason`），外加一道产物有效性闸。
另外四个自己重写了驱动器，**这三个键没有**。盘点与任务书都没提这条分岔，
而它直接决定报文形状。逐个照移（`abortFacts` 有现成的；产物闸在这两个技能上
必然放行 —— 它们的 `data` 里没有 `_PRODUCT_PATH_KEYS`、也没有 `crash_indicator`，
旧仓那道闸 positive-evidence-only，所以写成一句注释而不是一段永远为真的代码）。

### 7.3 `approach_offset_m` 的**声明缺省与实现缺省不一样**

声明写 `default=3e-10`，代码是 `float(params.get("approach_offset_m") or 0.0)`
⇒ **省略时是 0，不是 3 Å**。也就是说「针尖从原子后方 3 Å 出发」这句描述，
在不显式传参时**从来没发生过**。照移（金样里每一格的 `a1:pre_move` 都落在
原子本身上，看得见）。这与 `GridSTS` 的 `num_points` 是同一个形状 ——
区别是后者旧仓修过并留了注释。

### 7.4 一条演练跑出绿色，而它**不是「没人看」**：`if (damping < 1.0)` 根本不是闸

第一版给 RL 的阻尼打的是 `<` ⇒ `<=`，实跑 green。查下去：
IEEE-754 与 ECMA-262（`Number::exponentiate` 第一条「指数是 +1 就回 base」）
都规定 `x ** 1.0` **精确等于** `x`，numpy 同。那个 `if` 只省一趟循环，
一个数都不改 —— **它是一次微优化，不是一道闸**。

按 green-8 §2.8 的做法改打在真正做决定的那一行（阻尼施不施加），
id 换成 `rl-damping-is-actually-applied`，重跑 **7 条变红**。
生产代码里那句注释也改了 —— 原来写的「`x ** 1.0` 在浮点上不恒等于 `x`」**是错的**。

### 7.5 另外五条绿：**金样分辨不出两种候选**（批 4b §5 ② 那一种）

| 变异 | 为什么第一版分辨不出 | 补了什么 | 重跑 |
|---|---|---|---|
| `detect-atoms-window-is-two-d-plus-one` | 次峰摆在离主峰 **3 列**处，半径 5 与半径 4 都压得掉 | 挪到**相距正好 5 列**、周围 ±5 内没有别的峰的地方（第 28 行）。中途还试错一次：摆在 `(8,13)` 时 Δrow=4 仍在半径 4 内，两种半径**又都**压得掉 | 2 条红 |
| `detect-atoms-threshold-is-strict` | 没有任何一格上「某像素的 `leveled` 恰好等于 `std`」 | 加一张**恰好全 1.0** 的 32×32 图：`leveled ≡ 0`、`std ≡ 0` ⇒ 那道闸问的正是 `0 > 0` 还是 `0 >= 0`（0 个原子 vs 1 个位于图心的假原子）。常数取 1.0、边长取 2 的幂是**必需的**（两侧 `mean` 要逐位相同；换成 `1e-9` 就不成立，`3 × 1e-9` 已经要舍入） | 1 条红 |
| `drift-each-image-subtracts-its-own-mean` | `ref` 与 `cur` 是同一族合成图，均值几乎相等 ⇒「各自减」与「都减 ref 的」给同一个峰 | 加一张 **+2e-8 直流偏置**的当前图。答案**必须与无偏置那一格一样**（正确实现对直流不敏感），而拆掉之后虚假项压过真峰 | 1 条红 |
| `drift-pixel-size-is-width-over-columns` | 所有帧都是方的 ⇒ 行数 == 列数 | 加一对 **16×24** 的非方帧。`dy` 落在 `-2 × 16e-9/24` 上，除以行数会给另一个数 | 1 条红 |
| `move-atom-retry-lowers-the-resistance-and-caps-it` | 起手是缺省 57 nA ⇒ ×1.5 = 85.5 nA，**够不着 100 nA 的顶** | 加一格起手 80 nA ⇒ 120 nA ⇒ 封到 100 nA，而 `a2:manip_setpoint` 的参数里看得见 | 1 条红 |

五条的共同形状：**闸的两侧只有一侧出现在金样里**。
不是容差写松了，也不是「这条闸不重要」。

### 7.6 仓里另一处夹具的 `slowCall` 形参写反了（不是我的地盘，点名给主线）

`packages/host/stm-skills/integration/scan-composites.test.ts:138`：

```ts
slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
```

而 `SlowCall` 是 `(method, recvTimeoutS, ...args) => Promise<{record, recvTimeoutS}>`
——**动词在前**，而且回的是一个信封。两处都反了。

它一直没咬到人，因为那个文件压的两个技能（`ScanAt` / `FullScan`）的子技能
都不走 `slowCall`。本批集成测试的初版沿用了该形状，于是 `AcquireSTS`
先把预算秒数 `45.1` 当动词发出去，收到
`UnknownMethod: 协议表里没有 45.109350005193846`，
`GridSTS` 报「All 4 spectra failed」——**与实际模拟器状态不符**。
本批这一份写对了并在注释里点名；那一处**没动**。

### 7.7 `traces.test.ts` 的 scrub 规则**只加在一侧**，理由写在规则抬头

`TrackDrift_ReferenceScan` 第一趟采参考时落 `drift_ref_<毫秒>.npy`，
路径原样进 `message`。导出器那侧墙钟钉死成 `1_700_000_000`，
所以**金样那一侧的毫秒本来就是常数**；会变的只有 TS 这一侧的 `Date.now()`。
而 `scrubPaths` 对 `want` 与 `got` **都跑一遍**，所以一条规则就够
（与上面两条 stamp 规则的「两侧各一条」不同）。

### 7.8 `integration/bias-wiggle.test.ts` **间歇性红，而它先于本批就在**

全量集成跑起来大约**三趟里红一趟**，红的总是同两条，报

```
扰动在第 1 次跳变时停下：电流 1e-08 A 超过中止阈 5e-09 A。偏压已恢复到 0.02 V。
```

**先把「是不是我」定下来**（本批唯一一次靠计数而不是靠推理下的结论）：

| | 6 趟里红几趟 |
|---|---|
| 把 `integration/batch7b3.test.ts` **移出仓外**，整组 18 个文件 | **2** |
| 放回来，整组 19 个文件 | **2**（另一次 5 趟里 2 趟） |

⚠️ 中间量错过一次：第一版我用「显式文件清单」去掉我这一份，结果**顺带
漏掉了 instrument 那四个包的集成文件**（14 而不是 18），那一趟 5 趟全绿，
这曾被误判为本批引入的问题。**去掉一个文件要用「移出去」，不要用「列出其余」**
—— 后者同时改了别的东西。

**机制查到这一步**：整组共用一台 stmsim，而 `bias-wiggle.test.ts` 在自己的
`it` 里只做 `ZCtrl_OnOffSet(1)` + `Bias_Set(0.02)` 就开跑，
**既不设设定点、也不等 Z 环稳**。于是「上一份文件把针尖留在哪、留多深」
决定了偏压一变时那个瞬态冲到多高，而它的电流中止阈是 5 nA。
修在那一份文件里（设一次设定点 + 等条件），不在我这儿 —— **没动它**。

**本批顺手做的那一半**：`batch7b3.test.ts` 的存档/还原从三件（缓冲 / 帧 / 偏压）
补到六件 —— 加上**设定点**、**反馈开关**、**针尖 XY**，外加一次
「等电流回到 2× 设定点以内」的**条件**等待（不是固定时长）。
那不能修掉上面那条 race，但它让**我这一份不再是变量**（去掉我这份 6 趟 2 红，放回来 5 趟 2 红 —— 同一个率）。

### 7.9 行数账

任务书按盘点写「`MoveAtomTo` 自写行 236 ＋ 常量 4」，落出来的 TS 是 **427 行**
（含抬头与逐处理由注释），可执行部分约 250。差额全在注释，与前几批同一比例。

---

## 八、DoD §8.5 逐条

| | 怎么满足的 |
|---|---|
| ① 规格对齐 | 九个技能的 `SkillSpec` 由 `scripts/gen-skill-specs.ts` 从 `spec/golden/skills.json` **生成**，不手抄（`pnpm gen:skills` 退 0，433/433） |
| ② 面向模型的回包逐字对齐 | `error` / `summary` / `data` 逐叶子比：`batch7b3.test.ts`（54 格）· `paper-skills.test.ts`（+35 格）· `traces.test.ts`（+63 条轨迹）。归一化只做三件：两个临时目录、操作系统那句错、一个毫秒戳 —— 每一件都有写下来的理由 |
| ③ 每个错误分支一条单测 | 金样覆盖的那些走金样；金样造不出来的四条另写（参考图**存不下去** · `GetScanFrame` 抛出去 · 回读抛出去 · 写 `.npy` 写不动）。两条**够不着**的分支先证明够不着再决定（`GridSTS` 的三条上限 / `Deconvolution failed` 那道 catch） |
| ④ 对真 stmsim 的集成测试 | `packages/host/stm-skills/integration/batch7b3.test.ts`，9 格。其中一格专为 `SaveScan` 的注入而写（**桩上永远验不到**），一格专为 `Scan_FrameDataGrab` 的真 body 而写 |
| ⑤ 差分 | 三台导出器全部 `allow_nan=False` / `sort_keys=True` / LF；各跑两遍 `cmp` 全 `IDENTICAL`；旧仓 `find -newermt` 自证为空 |
| ⑥ 变异演练 | 46 条，**46/46 实跑到 red**，四判据齐。日志三份入仓 |
| ⑧ `pnpm gen:progress` | 顺序 `gen:skills` → `tsc -b` → `gen:progress`，退 0：433 done · 0 partial · 105/165 模块 |

---

## 九、留给下一批的四条

1. **`D-MANIP-1` 那条缺陷该修**：`MoveAtomTo` 的「仪器仍停在操纵条件上」
   印的是 `params.get(...)`，省略参数时是 `None`。修法是把
   `manip_*_used_*` 落成**计划真的程序下去的那两个值**，于是错误正文与
   `junction_resistance_ohm` 同时变真。金样里留了对照的一格
   （`explicit_manip_conditions_give_a_resistance`，电阻 = 5e5 Ω），
   差异消失时那一格会当场变红。
2. **`scan-composites.test.ts` 的 `slowCall` 形参**（§7.6）。
3. **`paper.region_analysis` 剩下两个是 D 档** —— 那个模块要清零，
   得先回答「本仓要不要 torch」。盘点已经把它归 D，本批不动。
4. **`integration/bias-wiggle.test.ts` 的间歇红**（§7.8）—— 大约三趟一红，
   **先于本批就在**（去掉我这一份重测过）。修在它自己那一份里：
   开跑前把设定点也设一次，并等 Z 环稳（等条件，不等固定时长）。
