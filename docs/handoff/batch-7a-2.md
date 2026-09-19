# 批 7a-2 交接 —— 实验地图层 + `FindCleanSpot`（**六条针尖流程的公共前提**）

落了 **1 个技能 / 1 个模块收口**，外加**实验地图层的三件判据本体**
（旧仓 `core/map_scope` + `io/map_analysis` + `io/exp_map` 的函数级闭包）。

技能 **417 → 418**（分母 515），模块 **92 → 93**（分母 165），**0 partial**；
测试 **6317 → 6519**（单测+契约 6231 → 6429 / 对真 stmsim 的集成 86 → 90，
101 → 108 个文件）；变异 **593 → 625 条，新增 32 条全红**（基线干净，日志入仓）；
偏差登记 **+11 条**（编号留 `?`）。

| 组 | 落地 | 旧仓 |
|---|---|---|
| 行还原与代次 | `kernel/src/exp-map.ts` 165 行 | `io/exp_map.py` 的 `MapMarker` / `epoch_of_row` / `markers_from_rows` |
| 选点几何 | `kernel/src/map-analysis.ts` 458 行 | `io/map_analysis.py` 的 `AnalysisConfig` / `build_avoid_circles` / `_ring_cells` / `nearest_clean_from` + 三件代次工具 |
| 配置装配与两个来源 | `kernel/src/map-scope.ts` 365 行 | `core/map_scope.py` 的 `analysis_config` / `load_markers` / `crash_memory_markers` |
| 技能外壳 | `stm-skills/src/l0/clean-spot.ts` 405 行 | `builtins/clean_spot.py` |

**封锁账当场红了**（`tip-phase-deps.test.ts`，它就是为这一刻写的）：
`FindCleanSpot` 从**六行里全部**划掉，而 **`PulseConditionTip` 的缺件表空了** ——
那条流程现在可以移。

---

## 0. 一句话

> 这一批的难点不在 250 行几何本身，在**造出能把它和「另一种合理写法」分开的那些格**。
> 26 格选点金样是拿 **15 种拆法**在旧仓侧逐一重跑筛出来的：13 种被分开，
> 剩下两种**一格都分不出来** —— 而那不是金样不够，是**它们本来就不是闸**。
> 那两条因此没有进变异清单（§4.2）。

---

## 1. 落地的件

```
新增（判据本体，住在 kernel —— 理由见 §2）
  packages/host/kernel/src/exp-map.ts             165   一行记录 → 一个 marker
  packages/host/kernel/src/map-analysis.ts        458   选点几何 + 代次
  packages/host/kernel/src/map-scope.ts           365   配置装配 + 两个避让来源

新增（技能外壳 —— 只做 IO 与话术）
  packages/host/stm-skills/src/l0/clean-spot.ts   405

新增（测试与金样）
  packages/host/kernel/src/map-layer.test.ts               565  （125 条）
  packages/host/stm-skills/src/l0/clean-spot.test.ts       313  （56 条）
  packages/host/stm-skills/integration/clean-spot.test.ts  152  （4 条，真 stmsim）
  tools/spec-export/export_map_scope.py                    965
  spec/golden/map_scope.json                               226 KB / 10 节（重跑逐字节相同）
  docs/handoff/drill-7a2-2026-09-20.log                     67  （32/32 red 的实跑记录）

改（共享文件，全部写在自己的锚点下面）
  kernel/src/index.ts · stm-skills/src/l0/index.ts · spec/deviations.md ·
  spec/golden/README.md · tools/mutate/mutations.ts

改（共享文件，**没有锚点**，见 §6 的冲突提示）
  kernel/src/instrument-profile.ts        +8 个键（地图层是它们的第一个消费方）
  kernel/src/instrument-profile.test.ts   +11 格（新键的洗法与回落）
  tools/spec-export/export_instrument_profile.py  同上（`ablated_keys` 少 8 个）
  tools/spec-export/export_skill_traces.py        +BATCH_7A2 + 撞针记忆清场
  scripts/gen-skill-specs.ts                      +BATCH_7A2
  stm-skills/src/l0/traces.test.ts                +两处清场 + `HYPOT_KEYS`
  stm-skills/src/l0/tip-phase-deps.test.ts        封锁账划掉 `FindCleanSpot`
  .gitignore                                      `!docs/handoff/*.log`（见 §7）
```

**`io/coarse_map.py`（604 行）一处都没碰** —— 与 `blockers-7a.md` §2 的判断一致，
`grep coarse_map` 在这三份源文件里零命中。

---

## 2. 为什么地图层住在 `kernel`，不在 `vision`

任务书建议 `vision/src/map-*.ts` 或新包，要求先说清理由。**选了 `kernel`**，三条：

1. **这一层零 numpy。** `vision` 的抬头写着它是「需要 `numerics`
   （`labelConnected` / `fft` / `histogram`）的那一族」，而留在 `kernel` 的是
   零 numpy 的判据（起伏门与它的阈值表）。这个闭包的全部运算是
   `hypot` / 乘加 / 比较，一个数组原语都不用。
2. **它的三个输入源已经全在 `kernel` 里** —— 档案（`instrument-profile.ts`）、
   撞针追踪器（`tip-crash-tracker.ts`）、实时状态（`hardware-state.ts`）。
   放进 `vision` 会让一层纯几何判据反过来依赖 `numerics`，只为了搬个家。
3. **不新建包。** 新包的门槛是「这一层的判据与邻居**互相稀释**」
   （`vision` / `nanonis-files` 的抬头各写过一次）。这一层的容差是 **0**，
   与 `kernel` 现有那一档**同口径**，没有要隔开的东西。

⇒ `packages/host/vision/src/index.ts` 与 `packages/host/numerics/src/index.ts`
那两个锚点**本批一个字都没加**。

---

## 3. 容差表

**除一个字段之外，全部是 0。**

| 件 | 对的是 | 容差 | 一句推导 |
|---|---|---|---|
| 落点的 `x_m` / `y_m`、个数、**顺序** | `nearest_clean_from` | **0** | 坐标是 `gx * step`（整数乘一个 double，IEEE 乘法两边逐位相同）；顺序是下标 |
| `distance_m` | 同上 | `4 · eps` | 这一路上只有一次 `Math.hypot` 不逐位（D-HYPOT-1：`hypot(4e-7,4e-7)` 差 1 ULP）。取 4 倍 ULP；**实测占比 < 1**（测试里打出来） |
| 配置的 21 → 15 个字段 | `analysis_config` | **0** | 逐位 —— 而这一档不是形式主义：出厂 `pulse_r_m` 是字面量 `200e-9`（`2e-7`），而走 `get_config` 会得到 `150.0 * 1e-9`（`1.5000000000000002e-7`）。**最后一位就分得开 `_nm_unless_set` 与 `_nm`** |
| 圈、marker、代次、报文 | 各自 | **0** | 标签、计数、是非题、逐字话术 |

`distance_m` 的那 1 ULP **改不了任何一个决定**，而那不是运气 —— 是造金样时刻意安排的
（三条边界判据全造在轴上，`hypot(a, 0)` 两边都精确）。推导写在 D-MAP-9 那一条里。

---

## 4. 变异演练：**32 条，32 条红**

基线干净（`run.ts` 判据④ 先量），日志 `docs/handoff/drill-7a2-2026-09-20.log`。

### 4.1 头一趟 25/32，而剩下的 7 条各自说明了一件事

| 判词 | 条数 | 为什么 | 怎么改的 |
|---|---|---|---|
| `inconclusive`（`tsc -b` 退非 0） | **5** | 拆掉一道闸之后某个符号**没人用了** ⇒ TS6133 ⇒ 编不过 ⇒ **这条演练什么都没验** | 改成「两支对调」或「乘一个恒为 0 的量」，让符号留在原地（同 `scanprep-missing-channel-says-what-is-there` 那条的先例） |
| `green`（拆了没人喊） | **2** | 一条是**金样里没有能分开的那一格**；另一条是**那道闸在 TS 里结构上不存在** | 见下 |

**① 金样少一格**：`clean-spot-pulse-drops-the-frame-margin`（打脉冲的落点上不扫图 ⇒
不减帧边距）。原来 37 格里**每一格的可用区都装得下同一批落点**，减不减那 50 nm
给出同一个答案。补的那一格：避让 **299 nm** ⇒ 格距 598 nm，而可用区半程 600 nm ——
不减边距是 **9 个**落点，减了只剩区心 **1 个**。
（299 不是 300：`300.0 * 1e-9 = 3.0000000000000004e-7` ⇒ 格距 `6.000000000000001e-7`
**比 600 nm 大一点点** ⇒ 外圈全被排除，两种写法又给出同一个答案。
**一格「刚好压在浮点边界上」的金样，和一格没有，是同一件事。**）

**② 那道闸在 TS 里不存在**：`epoch-of-row-rejects-booleans`。
Python 里 `isinstance(True, int)` 为真，所以「显式拒 bool」在旧仓是一条真的闸；
TS 里 `true` 既不是 `number` 也不是 `string`，最后那个 `else return null` 本来就接住了它。
**守卫留着**（它写的是意图），变异换成 `epoch-of-row-rejects-non-finite`
（NaN 代次会让 `filterEpoch` 的 `NaN === epoch` 恒为假 ⇒ 那一行的损伤标记
**从每一代里消失**）——那一条是真的在挡。

### 4.2 两道**故意不打**的：它们不是闸

造金样时先在旧仓侧拿 **15 种拆法**逐一重跑 26 格选点，要求至少一格结果变了。
13 种当场被分开；**两种一格都分不出来**，而追下去发现是结构性的：

| 拆法 | 为什么永远绿 |
|---|---|
| 去掉提前退出（`ring*step − d_tip > 最差的` 整条删掉） | 它是**纯优化**：删掉只会多收几个候选，而那些候选按三角不等式必然比第 `want` 个远 ⇒ 排序截断之后一个都进不来 |
| `maxRing = trunc(reach/step) + 2` 去掉 `+2` | 第 r 环上每个格至少有一个坐标是 `±r·step`，`r·step > reach` 时整环出局 ⇒ 超出 `trunc(reach/step)` 的环一个点都贡献不了。`+2` 是取整余量 |

⇒ 按 green-8 §4 第三种形状处理：**保留代码 + 就地注明 + 变异清单里不写**。
打了也永远绿，而那会让一条「闸不存在」混进 32 条真闸里。

同样处理的还有两处（写在 D-MAP-11 里）：`spacing()` 里 `v < 1` 那一支
（`sanitizeProfile` 已经把它夹进 `[1,20]`）、以及拒绝话术外面那道 `try`
（`nearestCleanFrom` 在同一份 marker 表上先调过一次 `buildAvoidCircles`
⇒ 唯一能让它抛的东西会在那里先炸）。后者有一条**证明**式的测试。

### 4.3 红得最多的两条，各自说明了一件事

| id | 红 | |
|---|---|---|
| `map-pulse-radius-does-not-read-the-spec-default` | **55** | 它一改，**整条配置装配的出口全变**（25 格配置 + 26 格几何 + 39 格技能都挂在 `pulse_r_m` 上）。2026-08-13 真机上它「症状完全正常、零报错」，是**数了那个圆的半径**才发现的 |
| `clean-spot-says-the-map-is-unreadable` | **32** | 「读不到实验记录」那句话进 `reason` 与 `summary`，而两者都逐字比 |

---

## 5. 金样：10 节，**26 格几何 + 39 格技能**是主体

`spec/golden/map_scope.json`（226 KB），驱动器 `tools/spec-export/export_map_scope.py`。
它自己摆世界：档案（`instrument_profile`）、实验记录、撞针追踪器、仪器回包，
四样都由驱动器给，再让**旧仓自己的函数**回答。

| 节 | 格数 | 它回答什么 |
|---|---|---|
| `ring_cells` | 5 | 环带的**生成顺序**（同距候选谁先谁后 —— 稳定排序把它变成判据） |
| `config` | 25 | 哪个键从档案来、哪个键**故意不看档案** |
| `markers` | 22 | 一行记录怎么变成 marker（`coord_epoch` 的七种坏值） |
| `epochs` | 9 | 存的那一列与数出来的那一列，不一致时听谁的 |
| `load_markers` | 7 | 读不到 / 读到了 / 读到了但是空的 —— **三态** |
| `crash_memory` | 5 | 第二个来源，以及 `unlocated` |
| `avoid_circles` | 8 | 每一种 marker 变成什么圈，以及**上限为什么常常不生效** |
| `nearest` | **26** | 250 行选点几何，逐条判据一格 |
| `parse_spots` | 10 | 坐标串：坏块跳过，不是整串作废 |
| `skill` | **39** | 三态压电来源、四种「谁答上了」、三种「没有落点」的话术、区外重搜 |

**重跑逐字节相同**（自己跑了两遍 `cmp`），`allow_nan=False` / `sort_keys=True` / LF。
`MAST2_PROJECT_ROOT` 指到临时目录；跑完 `find MASTv2 -newermt <开跑时刻>` **为空**。

另外两份金样因本批而重导出，**两份都只有插入、重跑逐字节相同**：

* `instrument_profile.json`：+8 个注册键（`ablated_keys` 少 8 个）、+11 格。
* `skill_traces.json`：+`FindCleanSpot`（6 条轨迹，其中 3 条由 `EXTRA_PARAMS` 给显式起点
  —— 不给的话通用驱动器合成的 `FolMe_XYPosGet` 回的是 0.25 **米**，量级判据一律拒，
  **三条轨迹会是同一句「读不到针尖位置」**）。

---

## 6. 与任务书不一样的地方

### 6.1 闭包比任务书那张表**大一些**（不是 1069 行）

任务书（引自 `blockers-7a.md` §2）列的是
`analysis_config 143 · crash_memory_markers 58 · load_markers 23 · AnalysisConfig 103 ·
nearest_clean_from 250 · build_avoid_circles 29 · _ring_cells 18 · exp_map 三件 93`。

**`load_markers` 的函数体还 import 了三件没在表上的**：
`marker_rows`（23）· `current_epoch_of`（3）· `filter_epoch`（10），
而 `filter_epoch` 又要 `epoch_series`（14）。`build_avoid_circles` 还要 `_finite`（9）与
`DAMAGE_KINDS` / `META_AVOID_RADIUS`。合计 **多约 60 行**。

不是任务书算错了尺度 —— 结论（「这一轮就能做」）完全成立。记下来是因为
**同一种漏项会在下一次 grep 里重复**：`load_markers` 那一行只数了它自己，
没有跟进它函数体里的三个 import，而追依赖的规矩正是「看函数体里的 import」。

### 6.2 写侧 `record_damage_marker` **没搬**（点名欠账）

`survey-remaining.md` 写着「写侧 `record_damage_marker` 必须同批」。**没搬**，
理由是本仓**还没有任何一个消费方**（没有技能写损伤标记）。
登记成一条点名的欠账（D-MAP-2）：第一个要写标记的技能落地时它必须同批，
否则 `map_known=true` 而地图永远是空的 —— 那正是 2026-08-16 的形状。

### 6.3 `AnalysisConfig` 只搬了 21 个字段里的 15 个

砍掉的六个在这个闭包里既没有生产方也没有消费方（服务于没移的栅格化与巡览路线）。
名单写成一个**导出的常量**而不是注释，金样比字段集时拿它去补 —— 见 D-MAP-1。

### 6.4 改了两个**没有锚点**的共享文件（冲突提示）

* `kernel/src/instrument-profile.ts`：地图层是那 8 个键的**第一个消费方**，
  而它的抬头明写「这里每加一个消费方，要同时加它的那一行」。
  连带改了它的导出器与测试（`ablated_keys` 少 8 个）。
* `scripts/gen-skill-specs.ts` / `tools/spec-export/export_skill_traces.py`：
  两处都照现有体例加了 `BATCH_7A2` 与一条 `// ↑ 上一条 ／ ↓ 7A-2` 分隔行。

`stm-skills/src/l0/tip-phase-deps.test.ts`（封锁账）**必然要改** —— 它就是设计成
一落地就红的。7a-1 / 7a-3 会改同几行（各自划掉自己的件），**这是预期内的冲突**。

### 6.5 `traces.test.ts` 加了一条 `HYPOT_KEYS` 对齐

通用轨迹是**逐字深比**，而 `distance_m` 走 `hypot`（1 ULP）。加了一个与
`CLOCK_KEYS`/`alignClock` 同形的 `HYPOT_KEYS`/`alignHypot`，容差 `4·eps`，
**无条件**应用。它盖不住任何一次真的算错（坐标是整数乘 step，逐位相同）。

### 6.6 `FindCleanSpot` 进了 `skill_traces.json`（本来打算不进）

原打算只靠专用驱动器。**进度表逼回来的**：`build-progress.ts` 判 `done` 要求
`traces ≥ 1`，不进就是 `partial` —— 而本仓已经连续几轮 **0 partial**。
进去之后反而多了一份独立交叉核对（§5 末）。

---

## 7. 顺手查出来的一件：**上一轮那条「日志已入仓」是假的**

`docs/EXECUTION.md` §1 第六轮那一段写着：

> 跑是真跑了，可 1189 行输出只落在会话的临时目录里，而结论已经写进了本文件。
> …… 日志已入仓（`docs/handoff/drill-593-2026-09-19.log`）。

**那个文件在磁盘上，但从来没进过 git**：`.gitignore` 第 16 行 `*.log` 把它挡住了，
`git ls-files docs/handoff/` 里一次都没出现过。

> 第六轮记录的问题是「**证据没进仓的绿**」，但当时写下的补救记录
> 仍然没有进入 git，因此没有解决同一项证据缺口。

本批加了 `!docs/handoff/*.log` 并把自己的 32 条演练日志入仓。
**`drill-593-2026-09-19.log` 在主检出上，需要主线补一次 `git add`** —— 这一支碰不到它。

---

## 8. 这一批学到的三条（形状，不是细节）

1. **一格「刚好压在浮点边界上」的金样，和一格没有，是同一件事。**
   `300.0 * 1e-9` 比 `300e-9` 大一个 ULP，于是「格距正好等于可用区半程」那一格
   变成了「格距比它大一点点」，两种写法给出同一个答案。
   造边界格时要**先跑一遍看它落在哪一侧**，不能按十进制算。

2. **「拆掉它会不会有人喊」要在造金样的时候问，不是在演练的时候问。**
   这一批把 15 种拆法在**旧仓侧**先跑了一遍（`nearest_clean_from` 的 Python 变体），
   于是 32 条演练只有 2 条绿 —— 而那 2 条各自指出一件别的事。
   演练是**验收**，不该拿它当设计工具。

3. **一条编不过的变异什么都没验，而它长得像一次失败。**
   5 条 `inconclusive` 全是 TS6133（拆掉闸之后某个符号没人用了）。
   `run.ts` 的判据②把它们逐条拦下来了 —— 这正是那条判据存在的理由。
   改法固定：**两支对调**，或者乘一个恒为 0 的量，让符号留在原地。

---

## 9. 解锁了什么

封锁账（`tip-phase-deps.test.ts`）**自己算**出来的：

| 流程 | 本批之前还缺 | 现在还缺 |
|---|---|---|
| `PulseConditionTip` | `FindCleanSpot` | **一件都不缺** |
| `PokeConditionTip` | `AutoTilt` · `FindCleanSpot` · `FindFlatRegion` | `AutoTilt` · `FindFlatRegion`（= 7a-1 + 7a-3） |
| `MakeSpectroscopyTip` | 四件 | `AssessShockleyOnset` · `AutoTilt` · `FindFlatRegion` |
| `MakeAtomicResolutionTip` | 五件 | `AssessAtomicPhase` · `AutoTilt` · `BiasWiggle` · `FindFlatRegion` |
| `PrepareNobleTip` / `ForgeAuTip` | 五件 | `AnalyzeFrameTilt` · `AutoTilt` · `FindFlatRegion` · `PreScanCheck` |

**7a 三批合完之后**，`PulseConditionTip` 与 `PokeConditionTip` 的缺件表都会空。
剩下四条各差 1–2 件，而 `PreScanCheck` 那两条的账见 `blockers-7a.md` §3。
