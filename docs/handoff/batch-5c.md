# 批 5c 交接 —— 三个子系统：仪器档案 · Z 稳定 · 粗动驱动

**落地 4 个技能 / 3 个子系统 + 4 台判定机进内核。**

| | |
|---|---|
| 技能 | 394 → **398 / 515**（模块 71 → **75 / 165**） |
| 测试 | `--project '!integration'` **94 文件 / 5258 条全绿**（+321 条） |
| 集成 | 63 → **75 条**（新增 12 条，全部对真 stmsim，**一步粗动都不发**） |
| 新金样 | `instrument_profile.json` · `coarse_drive.json` · `z_settle.json`（各一台独立驱动器）+ `skill_traces.json` 里 4 个技能 23 条轨迹 |
| 变异 | **新增 23 条，全部实跑到 red** |
| 偏差 | 新登记 **12 条**（编号留空，主线统一编），其中 **4 条是旧仓的真缺陷** |

落地的三个子系统：

1. **`core/instrument_profile.py`（1237）** → `kernel/src/instrument-profile.ts`（按消融精神裁到 8+2 个键）
2. **`core/coarse_drive.py`（346）** → `kernel/src/coarse-drive.ts`（四道锁里的第 3、4 道）
3. **`composite/_z_settle.py`（402）** → `kernel/src/z-settle.ts`（判据）+ `stm-skills/src/composite/z-settle.ts`（轮询）

直接解锁并当场落掉的技能：**`ReadCalibrations`** · **`RetractForSampleChange`** ·
**`RelocateCoarseXY`** · **`StepCoarseXY`**。

**`AutoTilt` / `TiltCalibrate` 没做。** 差什么逐条写在 §5 —— 它们卡在
`packages/host/vision/`，而那个包这一轮有别的支线在动。

---

## 0. 我核出来与盘点不一样的地方

盘点是人写的，这五条我自己核过。

### 0.1 批次表头把 `AutoTilt` / `TiltCalibrate` 算给了仪器档案，**而它们卡在别处**

任务书那张表写着 `core/instrument_profile.py` 解锁
`ReadCalibrations · AutoTilt · TiltCalibrate`。**盘点自己的 §C 那一行是对的**
（「差 `TiltProbeCircle`（**唯一**测量来源）+ `instrument_profile` 的 4 个入口」），
是表头把「档案」这一件说成了全部。逐条核的结果：

| 缺的 | 在哪 | 状态 |
|---|---|---|
| `TiltProbeCircle` | `spec/progress.json` | **todo** |
| `vision/tilt.py` 的 `fit_circle_tilt` / `circle_tilt_resolution_deg` / `z_span_for_frame` | `packages/host/vision/src/` | **不存在**（`grep -l tilt` 零命中） |

而 `auto_tilt.py` 第 43 行是 `from mast.vision.tilt import circle_tilt_resolution_deg, z_span_for_frame`
—— **顶层 import，无 try/except**；两个类的 `_measure()` 都是
`context.run("TiltProbeCircle", …)`，`TiltCalibrate` 的标定步与 `AutoTilt` 的每一轮复测**都走它**。
所以：**档案落了也解不开这两个**，⇒ 没落。

连带的一条：`set_tilt_calibration`（含 `cond > 10 拒写` 那道闸）**也没移** ——
它唯一的调用方是 `TiltCalibrate`。`TILT_CAL_MAX_COND = 10.0` 这个常量**移了**
（`ReadCalibrations` 在复述它），写入侧接上来的那天用同一个，不许再抄一份。

### 0.2 `_tip_evidence` 的「四个函数已有 ✓」**只对了一半**

盘点写着 `_tip_evidence` 四个函数 → `qplus_amplitude` → **已有 ✓**。
核下来：**判据**那一半确实在（`kernel/src/qplus-amplitude.ts` 的
`amplitudeVerdict` / `findAmplitudeChannel` / `excitationDriving` / `CRASH_FRACTION`），
**问的那一半一个都没有** —— `qplus_fields` / `qplus_says_crashed` /
`capture_qplus_baseline` / `qplus_recovered` 在本仓不存在，而 `RelocateCoarseXY`
的三处（清障后取基线、脱离确认的第二个证人、横移每一块的看护）全要它们。

所以这一批**顺手补了 137 行**：`kernel/src/tip-evidence.ts`（`RECOVERED_FRACTION`
与那条**三态**判据）+ `stm-skills/src/composite/tip-evidence.ts`（四个问口）。
下一批要 `_tip_evidence` 的人（`_tip_phases` 那 6 个）现在只差 `didv_trend_fields`（81 行）。

### 0.3 `_z_settle` 的「只要 `ctx.safe_call` + 6 个配置读口」成立，但**它不是一件，是三件**

盘点把它记成「402 行 / 285 代码行的一个文件」。核下来它压着的是三样东西：

| | 谁做 | 拆掉会怎样 |
|---|---|---|
| **等** | `settle_and_read_z` 的轮询窗口 | 回到 2026-08-04：读一个还在爬的 Z，把方向自检变成秒表读数 |
| **判** | `ZSettle.usable / at_rail / measures_gap` | `usable` 少一条 ⇒ 半途的 Z 进判据；`measures_gap` 少一条 ⇒「没位移」那道守卫会在到轨的梯子上误报 |
| **两台判定机** | `_judge_recede` ×2（**旧仓就是两个**） | 合并 ⇒ 2026-08-10 那句「方向很可能搞反了」的错话会被搬回清障那一侧 |

`RetractForSampleChange` 与 `RelocateCoarseXY` 共用第一、二件，**第三件各有一台**。
「必须同批」这条判断是对的，而且比盘点说的更强：分开搬会搬出**两份 `ZSettle`**，
然后两份的 `usable` 会各自漂。

### 0.4 `RelocateCoarseXY` 的「1328 行」成立；`coarse_nudge` 的「半天」也成立

`relocate_coarse_xy.py` 1328 行逐行读过。`coarse_nudge.py` 137 行里 90 行是 docstring，
`execute` 一个旧仓函数都不调 —— 盘点说对了。

### 0.5 `RelocateCoarseXY` 的落点复核**技术上可降级，但它降级掉的比盘点说的还多一层**

盘点点名了「别回到去过的站点」。核下来 `_check_destination` 里还有两条同样没了：

* **单轴行程预算**（`travelled > cfg.axis_step_budget` ⇒ 拒）——「粗动台走到头只会空滑，
  但位置认知会全部丢失」；
* **里程表失效时只许沿上次方向前进**（`position_known == False` 那一支）——
  「回到某个位置需要绝对坐标，而那个数字现在是假的」。

三条一起写进了 deviation 与报文（`checks.destination.map_available = false`）。

---

## 1. `instrument-profile.ts` —— 这一批的要害在**三态**

`ReadCalibrations` 要回答的不是「有没有标定」，是

> **「从未标定过」** 还是 **「读不到档案」** ——「该去做的事完全不同」。

旧仓没有存储时三块**全走 `except`**，恒说后者。而本仓如果把「宿主没接存储」折成一个
空档案，就会恒说**前者** —— 一样是假话，只是反了个方向。所以读口做成了函数：

```ts
export const processInstrumentProfile: { source: (() => unknown) | null; nowS: () => number }
```

`source === null`（宿主没接）与 `source` 返回 `{}`（档案是空的）**在类型上就是两件事**。
三个问口各自的三态写在 `instrument-profile.ts` 的抬头表里（同 `tip-crash-tracker.ts`
那三个问题的形状：住哪里 / 谁注入 / 宿主不接时什么行为）。

**没接时闸照常关**：`getConfig` 退回出厂默认（旧仓在空档案上也是这个行为），
而 `zExtendSignOrNone()` 返回 `null` ⇒ **拒判**。最后这一条不是洁癖：

> 出厂 `+1` 在这一项上**不中性** —— 它是两个互斥答案里的一个，而本机实测三条独立证据
> 都指向 `-1`。**猜错的两个方向不对称**：猜成 approaching 只是白撤一次针（烦，安全）；
> 猜成 receding 是**针尖在靠近却说在远离**，然后梯子照爬到 89 步。

### 键表裁到了 8 + 2

旧仓 39 + 9 + 1。这里只登记**有消费方**的（每一行的注释就是消费方），
而金样把两侧的键集**双向**钉住 —— 少登记一个红，多登记一个也红。
裁掉的 39 个名字逐条在 `instrument_profile.json` 的 `ablated_keys` 里，
**让「少了」与「漏了」分得开**。

---

## 2. `coarse-drive.ts` —— 四道锁里的第 3、4 道

> 「有些 Nanonis 控制器支持 400V，但是有时候 300V 就烧坏了」

**没有任何读数、状态位或报错会告诉你自己在哪一台机器上。** 所以：
声明没填 ⇒ **拒绝一切**（沉默不是同意）；越界 ⇒ **拒绝，绝不夹紧**
（夹紧会把「300 V 会烧掉这只叠堆」变成「按 220 V 跑了」而调用方以为自己要的是 300）；
绝对上限 400 V **排在一切可配置的东西之前**（顺序是判据的一部分）；
移动前**读回核对**，而**读不到就是拒绝**。

这一条与别处不同，值得说清：`processVacuum` 没接时退回出厂阈值继续判，因为压强有一条
与机器无关的物理判据；这里没有 ——「这只叠堆能受多少伏」没有出厂默认，只有一个填了或没填的事实。
所以 fail-closed 是**唯一**可能的行为。

### ⚠️ 一处**没合并**的重复，留给下一批

`l0/reads-hw.ts` 的 `COARSE_AMP_UNDECLARED` 与 `kernel/src/coarse-drive.ts` 的 `UNDECLARED`
是**同一段文本的两份**（旧仓那边是同一个常量 `coarse_drive._UNDECLARED`）。
这一轮**没动 `reads-hw.ts`**（它不在批 5c 的锚点清单里，而批 1/2 的文件这一轮可能有别人在改）。
在合并之前有一条测试钉着两份逐字相等（`coarse-drive.test.ts` → 「未声明那段话**逐字**」
比的是金样，而 `reads-hw.ts` 那一份 batch-1 已有测试）。

**顺带的一件事没做**：`SetMotorFreqAmp` 现在仍然**无条件**返回那段拒绝
（`writes-gated.ts:220`），`GetMotorFreqAmp` 仍然写死 `declared_max_amplitude_v: null`
（`reads-hw.ts:102`）。`authorize()` 因此**暂时只有金样这一个消费方**。
接上去是 5 行的事（两处各一行 + 一条测试），但要动那两个文件 —— 见 §5。

---

## 3. `z-settle.ts` —— 2026-08-04 那条

现场：清障自检跑了两次，除了 `retract_motor_dir` 什么都没改，**两次都判 approaching**。

> **把方向反过来，结论没有反过来。一个检查，它的答案在你把被测对象反过来时不变，
> 那它就不是在测那个东西。**

根因是 `ZCtrl_OnOffSet(1)` 与 `ZCtrl_ZPosGet` 之间一个写死的 1.5 s，而这台机器要 4–5 s。
**修法不是把 sleep 调大**：更大的常数是同一个缺陷，只是把这台机器的数字烤了进去。

分层：**判据全在内核**（`zConverged` / `zSettleUsable` / `zSettleMeasuresGap` /
两台 `judgeRecede*` / `noDisplacement` / 两条梯子 / `approachPrescription`），
**轮询在技能层**（`composite/z-settle.ts`，它要发调用）—— 同 `wait-scan-complete.ts` 的分层。

三条容易被后来编辑者拆掉的，各有一条变异钉着：

1. 收敛还要求 **「要么有活的隧道结、要么压电确实走过」** —— 一个还没开始跑的环也是不动的；
2. 窗口下限 **3** —— 窗口为 1 时净漂移由构造恒为 0；
3. 收敛带**从决策阈值派生**（一半）—— 第二个配置键会悄悄停在旧值上。

### 两台判定机**刻意不合并**

见 deviation。最要紧的那一格：读不到 setpoint 时，**梯子版**拿一条照成像条件（~100 pA）
定的绝对地板去判，判 `approaching`；**清障版**改用一个与工作点无关的界（前放满量程），
拿不到就**不判电流**并把「这一条没判」写进结论。2026-08-10 真机上正是前者把一次正常的
退针判成了「方向搞反了」。金样两台都录着（`z_settle.json`：15 对 × 2 台）。

---

## 4. 变异清单（23 条 —— ⚠️ **「全部实跑到 red」不成立，见下**）

> **2026-09-19 订正**（`docs/handoff/green-8.md`）：下面那张表里的「red」
> **每一格都比真值多 3**，因为跑演练的那棵树上有 **3 条与变异无关的失败**
> （其中 2 条已复现：`spec/progress.json` 没跟着新技能重新生成；第 3 条查不到）。
> `run.ts` 的判据是 `failed > 0`，于是**每一条变异都继承了那 3 条**、一律判 red。
> 表里那三个 **`red = 3`** 的（`zsettle-window-of-one` ·
> `relocate-prove-clear-accepts-a-live-junction` ·
> `relocate-panic-failure-is-still-a-success`）**真值是 0**，也就是**绿的**。
> 前两条已补上输入并实跑到 red；第三条那一支**不可达**，变异改打在了真正做决定的那一行上。

| id | 拆掉会重新犯哪次错 | red |
|---|---|---|
| `profile-missing-source-is-not-an-empty-profile` | 「没接存储」折成「空档案」⇒ 永远说「从未标定过」 | 6 |
| `profile-z-extend-sign-falls-back-to-factory` | 没声明退回出厂 `+1` ⇒ 一次逼近被判 receding，梯子爬到 89 步 | 9 |
| `profile-tilt-three-of-four-is-enough` | 半张倾斜矩阵被当成标定值用 | 5 |
| `profile-blank-string-becomes-zero` | `Number('  ')` = 0 ⇒ 远离阈值变 0 nm | 4 |
| `coarse-undeclared-falls-back-to-a-number` | 没声明就替这台机器猜一个驱动上限 | 16 |
| `coarse-absolute-ceiling-after-the-configurable-one` | 一个填错的本机上限能授权一个荒谬请求 | 8 |
| `coarse-clamps-instead-of-refusing` | 越界请求被悄悄降到上限 —— 做错了却报成功 | 8 |
| `coarse-readback-unreadable-passes` | 一道失败模式是「通过」的检查 | 9 |
| `coarse-frequency-mismatch-refuses` | 把「里程表会漂」升格成拒绝，挡死一台好机器 | 5 |
| `zsettle-not-moving-is-enough` | 还没开始跑的环被判「已收敛」 | 4 |
| `zsettle-window-of-one` | 第一个读数就被判收敛（差一错重建那个缺陷） | 3 |
| `zsettle-tolerance-is-not-derived` | 阈值调大后收敛带停在旧值 | 5 |
| `zsettle-unsettled-is-approaching` | 坏掉的判据与接反的线长得一模一样 | 5 |
| `zsettle-no-sign-guesses` | 没声明符号时猜一个 | 4 |
| `zsettle-no-displacement-fires-without-a-ruler` | 到轨的梯子被误判成「台子没动」 | 6 |
| `retract-baseline-degrades-instead-of-refusing` | 基线不可用仍退几千步 | 4 |
| `relocate-clearance-baseline-degrades` | 清障梯子在没有方向检查的情况下走完 | 5 |
| `relocate-move-current-trip-off` | 横移中的电流看护拆掉（2026-08-28 场发射那次） | 5 |
| `relocate-prove-clear-accepts-a-live-junction` | 带着活的隧道结去横向滑台子 | 3 |
| `relocate-panic-failure-is-still-a-success` | 急停没下发却判成功 | 3 |
| `relocate-bias-not-lowered-before-move` | 带 2 V 横移 ⇒ 场发射 100+ pA ⇒ 每次粗动都自中止 | 4 |
| `step-coarse-xy-nudge-cap-off` | 拿「挪一下」那条路做大距离移动，架空效率约束 | 4 |
| `readcalibrations-summary-claims-it-read-the-archive` | 三块全空时无条件说「已确认读到档案」 | 5 |

### ⚠️ 「编不过的变异等于那道闸没验到」这次撞了 **5 回**

全是同一个形状：`if (false && x !== null && …)` **毁掉 TS 的类型收窄**，
于是下面用到 `x` 的地方报 `possibly undefined` / `not assignable`，`tsc -b` 失败 ⇒
`inconclusive`。`batch-4d.md` §4 记的 18 次里没有这一种，补上：

| 想拆的 | 不能写 | 要写 |
|---|---|---|
| 一条 `if (A && B)` 里的 B | `if (false && A && B)` | 把 **B 的阈值抬到天上**（`> X * 1e12`），留着 A |
| 一整条 `if` 守卫 | `if (false && …)` | 留着 `if`，把**块内 `return` 的 `ok` / `success` 翻过来** |
| 一次方法调用 | 删掉它 | 私有方法会变成「未使用」⇒ 编不过。改成把**方法内部**的判据抬到永远为假 |
| `if (A && (B \|\| C))` 的后半 | 删掉 `(B \|\| C)` | `B`/`C` 会变成未使用变量。改成 `(B \|\| C \|\| true)` |

---

## 5. 没做完的，逐条

### 5.1 `AutoTilt` / `TiltCalibrate` —— 差 `vision/tilt.py`，而 vision 这一轮不许碰

| 差的 | 在哪 | 规模 |
|---|---|---|
| `TiltProbeCircle` 技能 | 旧仓 `builtins/tilt_probe.py`（未核行数）；`progress.json` = **todo** | — |
| `fit_circle_tilt` + `CircleTilt` | `mast/vision/tilt.py` | **156 行 / 765**（盘点数，我没重核） |
| `circle_tilt_resolution_deg` / `z_span_for_frame` | 同文件 | `auto_tilt.py:43` 顶层 import，**无降级** |
| `set_tilt_calibration`（含 `cond > 10 拒写`） | `core/instrument_profile.py:840-901`（**62 行**） | 唯一调用方是 `TiltCalibrate` ⇒ 按消融精神没移 |

落地顺序建议：`vision/tilt.py` 那 156 行 → `TiltProbeCircle` → 这一对（两个类合计
`auto_tilt.py` 654 行，其中 `TiltCalibrate` 199 行 / `AutoTilt` 315 行）。
**档案那一侧已经就位**：`getTiltCalibration()` 的三态、`TILT_CAL_MAX_COND`、
`ReadCalibrations` 的 `convention_note`（`G = −M⁻¹`）都在。

### 5.2 `SetMotorFreqAmp` / `GetMotorFreqAmp` 还没接上 `authorize()`

`writes-gated.ts:220` 现在**无条件**返回那段拒绝；`reads-hw.ts:102-117` 写死
`declared_max_amplitude_v: null` / `within_declared_limit: false`。
接上去各是 3–5 行（`authorize(amplitude_v, frequency_hz)` / `maxAmplitudeV()`），
**但要动批 1/2 的两个共享文件**，这一轮的锚点清单里没有它们。

⚠️ 这条**不只是整洁问题**：盘点 §C 记着 `coarse_selfcheck` 的 `_drive` 探针会
**无条件**吐出「本机粗动耐压未声明 ⇒ 一切驱动写入与粗动移动都会被拒」，
于是那个自检**永远不可能变绿** —— 根就是 `reads-hw.ts:102` 那两行写死。
接上之后它才有可能变绿，而那是批 5a 那两个 fail-open 自检的邻居。

### 5.3 `_check_destination` 的三条保护（粗动大地图）

差 `io/coarse_map.py`（**604 行**，要 `derive_sites` / `_blocked_by` /
`_last_known_direction` / `AXIS_OF` / `SIGN_OF` / `CoarseMapConfig`）+
`core/coarse_map_provider.py`（`markers_and_config()` / `temperature_k()`，未核行数）。
现状：`#checkDestination` 永远放行，并在 `checks.destination` 里**说出**地图不在。

### 5.4 `crosstalk_report`（249 行）不移植

它要一条参考曲线。旧仓自述「这是报告，不是任何流程的目的」，不驱动任何决策。

### 5.5 `didv_trend_fields`（`_tip_evidence.py:194-263`，**约 81 行**）

这一批只移了振幅那一路的四个函数。dI/dV 趋势那一路 `RelocateCoarseXY` /
`RetractForSampleChange` 都不用（`RetractForSampleChange` 自己有一个 12 行的 `_read_didv`）。

### 5.6 拒绝路径上 `checks` 表不进最终 `data`（**照移，没改**）

`#checks` 只在整段 preflight 走完之后才赋值（旧仓同），于是一次拒绝的全部诊断只在
`error` 那一句里。改它会动到 `skill_traces.json` 里已经录好的 3 格，值得单独一次。

---

## 6. 金样怎么来的

四份，全部 `<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe` 跑，
**两次导出逐字节相同**（当场验过：`cmp` 三份全同）。旧仓**一个字节没写** ——
核过 `core/__pycache__/instrument_profile*.pyc` 等的 mtime 全是 9 月 10 日以前的。

| 文件 | 驱动器 | 为什么单开 |
|---|---|---|
| `skill_traces.json`（+4 技能 / 23 轨迹） | `export_skill_traces.py`（通用） | 录**调用序列与报文**。新加 `PROFILE_FIXTURE` + `NEEDS_PROFILE`（一台填过的机器），并把两条粗动组合加进 `NEEDS_VACUUM`，好让它们走到**驱动读回**那道闸而不是停在真空那道 |
| `instrument_profile.json` | `export_instrument_profile.py` | 通用驱动器喂常数回包，**碰不到档案自己的判据**（键表夹取、三级回落、`z_extend_sign` 三态、倾斜四缺一） |
| `coarse_drive.json` | `export_coarse_drive.py` | 通用驱动器只走得到「没声明 ⇒ 拒绝一切」那一格；声明装上之后的判据一条都到不了 |
| `z_settle.json` | `export_z_settle.py` | 恒定回包让 settle 每次都在第 5 个样本上收敛成 `tracking`，方向判据每次都在同一条电流跳闸上结束 ⇒ **五分之四的判据走不到** |

### 假钟

`export_skill_traces.py` 本来就把 `time.time` 钉在 `1_700_000_000`、`sleep` 换成拨钟
（见它第 42-72 行），所以 `ReadCalibrations` 的三个年龄分支（天 / 小时 / 分钟）
是**确定性**的。另外三台驱动器不读钟。

### ⚠️ 一条**时区耦合**，写下来

`ReadCalibrations` 的 `age_note` 里那个绝对时刻是
`time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))` —— **本地时区**。
导出器与 TS 测试跑在同一台机器上，所以对得上；换时区跑 CI 会红。
那是**如实的**红（金样里确实编码了一个本地时刻），不是假警报；
真要解耦就得把那一格从金样里摘出去，而摘出去等于不再比它。

---

## 7. 值得进课时的几件

1. **「读不到 ≠ 零 ≠ 否」这一族，这次是它的第三种形态。** 前两次是
   「读不到被当成 0」（D-VAC-4）与「读不到被当成否」（D-LIMITS-1）。
   这次是**两个否定被合成一个**，而且**合成的方向取决于实现选择**：
   旧仓恒说「读不到」，一个天真的 TS 移植会恒说「没标定过」。
   分辨它们的办法是让「没接」在**类型上**存在（`source: (() => T) | null`），
   而不是靠一个 `{}` 去代表两件事。

2. **一个检查，它的答案在你把被测对象反过来时不变，那它就不是在测那个东西。**
   （2026-08-04）这句话可以直接当验收判据用 —— 它比「测试通过了吗」强，
   因为它问的是「若事实相反，观测会不会不一样」。

3. **下游产物不能用来证明上游假设。** 仓里那些「伸长 / 收回 / receding」字样的标注
   全是 `z_extend_sign` 的下游产物；拿它们去验证那个符号，是在用被解释项验证解释
   （2026-08-11 撤回的那条结论就是这么来的）。能立论的只有**未经解释的原始读数**。

4. **「拒绝的同时把处方给出来」，而且处方要按**是哪条证据**分岔。**
   `approachPrescription` 是这一条的样板：同一个 `approaching`，
   证据是 Z 方向 ⇒ 去核对接线；证据是电流 ⇒ 先看阈值由哪一项决定。
   2026-08-10 那句「方向很可能搞反了」之所以是**自信而具体的错话**，
   就是因为一句处方盖了三种成因。

5. **变异要先编得过。** §4 末那张表是这一批新买的四种形状 —— 而它们有一个共同点：
   **TS 的类型收窄是控制流的一部分**，`if (false && …)` 不只是让条件恒假，
   它会把收窄一起拿掉。拆闸门要拆**判据的值**，不要拆**控制流的形状**。

6. **一句写给人看的话，如果读不到，就等于没写。** `_phase_verify` 那句
   「这是如实记录，不是通过」在旧仓从来没有离开过那个步骤（§5.6 的邻居，
   但这一条我改了）。写它的人显然认为它要被读到。

---

## 8. 旧仓的真缺陷（4 条，各有登记）

1. **`ReadCalibrations` 的「标称 f₀/Q」恒为 `None`** —— 它用 `get_config` 去**仪器档案**
   取两个住在**针尖登记表**上的键，而那两个键从来没在档案的键表里注册过，
   `sanitize()` 静默丢掉它们。金样里逐格录着 `null`，就是证据。
2. **三块全空时那句 summary 说反了** —— 无条件写「已确认读到档案,不是读取失败」，
   而三块全空最常见的成因就是读不到档案。**一个专门用来分开两种否定的技能，
   在它自己的 summary 里把两者合成了。**
3. **`_panic` 的失败台账几乎是死代码** —— 它只抓异常，而 `safe_call` 不为仪器报错抛异常
   （`core/execution_context.py:274` 把错放进 `record.error`）。于是「急停下发了但仪器拒绝了」
   根本不会被记下来，而那是这条组合里唯一一条「针尖可能正贴着表面而马达还在走」的路径。
4. **偏压恢复漏了两条路径**，而**证据是它自己的注释**：注释写着「三条路径都要调它：
   正常收尾、panic、以及 `reapproach=False` 时的结束」，而代码里 `reapproach=False`
   那条没有调用点，清障基线不可用那条 fail-closed 返回也不经过 `_panic`。

第 1、3、4 条在本仓**改了**（各有变异或测试钉着）；第 2 条也改了。
四条都在 `spec/deviations.md` 的批 5c 段里点了名。

---

## 9. 怎么自己验一遍

```powershell
node node_modules/typescript/bin/tsc -b
node node_modules/vitest/vitest.mjs run --project '!integration'      # 94 文件 / 5258 条

$env:STMSIM_PYTHON='<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe'
$env:STMSIM_ROOT='<STMSIM_ROOT>'
node node_modules/vitest/vitest.mjs run --project integration          # 13 文件 / 75 条

# 金样重跑（两次逐字节相同）
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe tools\spec-export\export_instrument_profile.py
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe tools\spec-export\export_coarse_drive.py
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe tools\spec-export\export_z_settle.py
<MAST_ROOT>\.venv-v2-py313\Scripts\python.exe tools\spec-export\export_skill_traces.py

# 变异（23 条，各重建一次，约 12 分钟）
node tools/mutate/run.ts --json profile-missing-source-is-not-an-empty-profile …
```

**集成那 12 条一步粗动都不发**：`Motor_StartMove` 在 stmsim 里是**真的动**
（`world.motor_move` 改 `coarse_gap_m`，每步 0.28 µm ± 15 %，且 `Z-` 在隧穿态下直接判撞针），
而整组 `integration` 共用同一台模拟器。所以它们走的全是不动马达的路径：
驱动闸拒绝、`prewithdraw_steps: 0` + `dry_run: true` 的完整相链、以及直接跑
`settleAndReadZ`（只碰压电，跑完把 Z 反馈开关放回去）。
