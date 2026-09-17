# 批 4d 交接 —— 两件「一件解锁一串」的底座

**落地 2 个技能 / 2 个模块 + 两台判定机进内核**。

| | |
|---|---|
| 技能 | 376 → **378 / 515**（模块 60 → **62 / 165**） |
| 测试 | `--project '!integration'` **86 文件 / 4677 条全绿**（+48 条） |
| 集成 | 52 → **60 条**（新增 8 条，**第一条「组合技能 ↔ 真 stmsim」的缝**） |
| 新金样 | `scan_resolver.json`（77 格）· `tip_crash.json`（21 条脚本 / 121 步 + 5 条文案） |
| 变异 | **新增 23 条，全部实跑到 red** |（主线核：锚点区实数 23，§4 那张表也正好 23 行）
| 偏差 | 新登记 **9 条**（编号留空，主线统一编），其中一条**更正了 D-FLOAT-1 里一句说反的话** |

落地的两件底座：

1. **`core/scan_resolver.py:resolve_scan`** → `packages/host/kernel/src/scan-resolver.ts`（纯函数）
2. **`core/tip_crash_tracker.py`** → `packages/host/kernel/src/tip-crash-tracker.ts`（跨调用状态机）

直接解锁并当场落掉的技能：**`ScanAt`**（composite.scan_at）· **`FullScan`**（composite.full_scan）。
`ConditionTip` / `PreScanCheck` **没做**，差什么逐条写在 §5。

---

## 0. 我核出来与盘点不一样的地方

盘点是人写的，这四条我自己核过。

### 0.1 `PreScanCheck` 的缺件表已经过期了一半 —— `frame_validity` 早就在仓里

盘点 B 档写着：

> `vision/frame_validity`(275) + `tip_metrics` 三函数(144) | 纯 numpy，自成一体 | **≈420 行** | **2 个**：PreScanCheck · CheckLineQuality

`packages/host/vision/src/frame-validity.ts` **已经存在**（批 4a/4b 落的），
`judgeFrame` / `acquiredRowMask` / `cropRows` / `detrend` / `corrugationRelTol` 全都导出着。
`readSxm` / `sxmOrientedFrames` 也在（`packages/host/nanonis-files/src/sxm.ts`），
`OperatingMode` 在 `kernel/src/safety.ts`。

**所以那 ≈420 行里只剩 `tip_metrics` 那 144 行**（`trace_retrace_correlation` 74 +
`_detrend` 8 + `_fwd_bwd_instability` 46 + 头）。缺件表该改成 **144 行解锁 2 个**。

⚠️ 但它落在 `packages/host/vision/`，这一轮另有支线在动那个包，我没碰。

### 0.2 `resolve_scan` 的「329 代码行、零外部子系统」**成立**，但有一处盘点没提

盘点说「五个查表里四个已在 `scan-policy.ts`，`atomic_working_point` 就一行常量」——
对的。没提的是：`atomic_working_point` 住在 **`mast/vision/imaging_window.py`**，
而那个文件的其余部分（`check_atomic_window` 一族）是**判帧**用的，不在这条路上。
我只搬了那两个数（0.02 V / 500 pA），跟着唯一的消费方走，写在
`scan-resolver.ts` 的 `ATOMIC_WORKING_POINT` 上并带上 2026-08-26 的现场。

另一处盘点点名对了、值得再强调：**本仓 `resolveLineTime()` 顶不掉任何东西**。
`resolve_scan` 的 line_time 优先级链是 explicit > 档位表(用户) > prefs > 档位表(出厂) >
针尖横向速度回压，**五节**，而 `resolveLineTime` 是三节的另一件事。两个都留着，
`FullScan` 用后者（它就是那条三节链），`ScanAt` 用前者。

### 0.3 `tip_crash_tracker` 的「250 行纯 stdlib」成立，但**它不是一个类，是三件事**

盘点把它记成一件「250 行的文件」。核下来它是**三条接线**，缺一台状态机就不成立：

| | 谁做 | 拆掉会怎样 |
|---|---|---|
| **问** | `crash_guard` 在 `run_composite` 最前面 | trace `5305868e` 那 5 分钟原地打转原样回来 |
| **记** | `FullScan` 判出撞针时 `record_crash` | 只问不记 ⇒ 那台状态机**永远是空的** |
| **清** | `FullScan` 扫干净时 `note_recovery` | 一次早已解决的撞针永远挡着一个好点 |

也就是说「移植 `tip_crash_tracker`」= 移植 250 行 **+ `FullScan` 里那三处接线**。
只移文件不接线，与批 3i 的 `optics_stage` 是同一种错的两面：那次是搬了壳留下屏障，
这次会是搬了屏障没人按。三条各有一条变异钉着（§4）。

### 0.4 `scan_at` 的子技能「7/7 全已移」成立，`full_scan` 的「4/4」也成立

逐个核过 `progress.json`：`SetBias` · `SetSetpoint` · `SetZCtrlGain` · `ConfigureScan` ·
`SetScanBuffer` · `StartScan` · `WaitScanComplete` · `SetScanSpeed` 全部 `done`。

---

## 1. `resolveScan` —— 它是纯函数，那就把它做成纯函数

`packages/host/kernel/src/scan-resolver.ts`。零 I/O、零硬件、判据全是值，
同 `z-trace.ts` / `vacuum-interlock.ts` 的分层。技能层只负责发调用与拼报文。

旧仓那三处「顺手读一下」在本仓是**入参**（同 D-VAC-1 / D-LIMITS-1 / D-PRESET-2）：

| 旧仓 | 本仓 | 不给时 |
|---|---|---|
| `_read_prefs()` 延迟 import `experiment_prefs` | `opts.prefs` | `{}` |
| `_read_v_tip_max()` 读 `instrument_profile` | `opts.vTipMaxMS` | `2e-6`（旧仓同值） |
| `scan_policy` 模块级活动表 | `opts.tiers` | `FACTORY_LOOKUP`（出厂表） |

**三条降级路径的取值逐字照移**，换掉的只是「谁去读」。
`preview()` 与 `scan_policy` 的写入侧（`sanitize` / `set_policy` / `format_policy_block`，
约 300 行）不移 —— 它们的消费方是设置界面，本仓还没有。`ResolverTier` 这个形状把
「操作员表」留成一个入参，那一侧接上来时这里不用改。

### 这一段照出来的三个真缺陷

**① `resolve_scan` 会抛 `TypeError`，而抛的那一支下面那句兜底是死代码。**

导出脚本第一次跑就死在这儿：

```
File "mast/core/scan_resolver.py", line 327, in resolve_scan
    note("line_time_s", line_time, SOURCE_EXPLICIT, human=f"{line_time:.4g} s/线")
TypeError: unsupported format string passed to NoneType.__format__
```

`_clamp` 是会给 `None` 的，而三处 `human` f-string 直接插值。四个入口，
**都从模型 / 偏好表直达**：`explicit.line_time_s` / `explicit.angle_deg` /
`explicit.bias_v` 解不出数，以及 `prefs.scan_speed_nm_s` 是个非数值字符串
（`if pref_speed` 是**真值**判断，一个 `'fast'` 会进那一支）。

连带的一件事更值得记：

```python
if line_time is None:                    # pragma: no cover
    line_time = 0.5
```

是**死代码** —— 每一条能让它变成 `None` 的路，都先在上面那个 f-string 上抛了。
`pragma: no cover` 让它看起来只是「测不到的兜底」，而它其实是「到不了的兜底」。
本仓补上 `human = null` 之后它第一次真的可达，也第一次有了一条测试。

**`human = null` 而不是 `0`**：`f"{None:.4g}"` 的替代品不该是 `0 V` / `0°` ——
那是给一个**没有的数**编一个读数。变异 `scan-null-human-is-not-zero` 钉着它。

**② `int(float('inf'))` 抛 `OverflowError`，而 `_num` 的 `except` 只收 TypeError/ValueError。**

一个 `inf` 像素数在旧仓是一次**未捕获的异常**。本仓给 `null` ⇒ 落到 `pixels = 256`。
同一条在撞针追踪那边也成立（`round(float(inf))` 同样漏出去，而那会把整个技能炸掉）。

**③ `spec/deviations.md` 的 D-FLOAT-1 里有一句说反了。**

原文：「两者都不认下划线与十六进制（Python `float("1_000")` 同样是抛的）」。
本机 3.13 实测：

```
'1_000' → 1000.0 · '1_0.5' → 10.5 · '1e1_0' → 1e10 · '_1' / '1_' / '0x10' → ValueError
```

CPython 3.6 起 `float()` **认**数字间的下划线。也就是说「两者都不认」在本仓这一侧成立、
在旧仓那一侧不成立 —— 这从此是一条**真的偏差**（一个写成 `1_000` 的每线时间在旧仓是
1000 s/线 ⇒ clamp 到 600 ⇒ 256 线一帧 **85 小时**）。我在批 4d 的登记里写了更正，
**没有改 D-FLOAT-1 原文**（那是主线的编号区）。

---

## 2. 撞针追踪 —— 三个问题，答案写在代码抬头

`packages/host/kernel/src/tip-crash-tracker.ts`。抬头里逐条答完才动的手：

**① 它住在哪里** —— 进程级（`processTipCrash`），与 `processApproachRefusalLatch` /
`processVacuum` / `processPresetStore` 同一族。理由与进针拒绝闩逐字相同：
**一根针、一块样品**，「这个点已经撞过两次」必须跨调用、跨链活着。

⚠️ **进程级不等于持久**。本仓和旧仓一样不落盘，宿主重启之后 30 秒前撞了两次的那个点
重新变成「没撞过」。这是照移，不是新增的洞；但它是真的洞，所以
`snapshot()` **新增** `since_s`（这台追踪器活了多久）——
「一条记录都没有」与「我刚出生」是两句话，而只有前者能支持「这儿没撞过」。

**② 由谁注入** —— 阈值 / 容差 / TTL 走 `processTipCrash.config`，墙钟走 `.nowS`。
**限值是台架的属性，不是类的属性**（D-VAC-1 / D-LIMITS-1 / D-QPLUS-1）：
8 nm 的「同一个点」取决于你在什么尺度上扫，30 分钟的 TTL 取决于漂移有多快。

**③ 宿主不接时是什么行为** —— **不是 fail-open 成「没撞过」**：

| 没接什么 | 行为 |
|---|---|
| `config` | 出厂阈值 2 / 8 nm / 1800 s 生效，闸**照常关** |
| `nowS` | `Date.now()/1000`，闸照常关 |
| 留痕（`ctx.markers.emit`，D-DIAG-1） | 拒绝**照发**，只是少一条面包屑 |

第三条是有形状的：`crashGuard` **先判断、后留痕**，留痕在自己的 try 里。
反过来写（先留痕、失败就提前 return）会让一次**记不下来的拒绝**变成一次放行 ——
那正是这道闸存在的理由的反面。变异 `tipcrash-diag-failure-is-not-a-pass` 钉着这个顺序。

### 「读不到 ≠ 零 ≠ 否」落在哪两处

1. **哨兵格**：读不到扫描中心的撞针落进 `?:?`，照样计数、照样拦人（旧仓行为，照移）。
2. **`crashPoints()` 把它们单独交出来**（`unlocated`），**绝不**当成一个点：
   在一个猜出来的坐标上画避让圈，是在编造一个事实。
   两条各有一条变异（`tipcrash-unknown-position-still-counts` /
   `tipcrash-unlocated-is-never-a-point`）。

---

## 3. 金样怎么来的

### 3.1 两台判定机，两台**专用驱动器**

通用轨迹金样（`export_skill_traces.py`）喂常数回包、子技能一律
`success=True, data={}` —— 它走到的是**调用序列与报文**，
而这两台判定机的判据它**一格都碰不到**。所以各单开一台：

| 金样 | 驱动器 | 形状 | 规模 |
|---|---|---|---|
| `spec/golden/scan_resolver.json` | `tools/spec-export/export_scan_resolver.py` | **输入网格**（无状态） | 77 格，其中 7 格 `ValueError`（规格）+ 4 格 `TypeError`（缺陷） |
| `spec/golden/tip_crash.json` | `tools/spec-export/export_tip_crash.py` | **操作脚本**（全是状态） | 21 条脚本 / 121 步 + 5 条逃逸文案 |

`tip_crash` 为什么不是网格：这台机器的判据是「**第三次**调用为什么被拒」。
所以每条金样是 `record / count / blocked / points / recover / tick / snapshot` 依次执行，
每一步记下当时的答案，一格一格比，序列错一步就红。

### 3.2 钟与随机数

* `tip_crash` 的 `TipCrashTracker(clock=…)` 收一个**可以手动推**的假钟（从 0 起），
  `tick` 就是把它往前推若干秒。不钉死钟，TTL 那几条永远录不出稳定的数（D-VAC-2 同理）。
* `scan_resolver` 无时钟、无随机数。
* **两台驱动器都不走 `scan_policy` 的模块级活动表** —— 那是可变状态，导出时用它
  = 让相邻两格互相污染（本仓已经因为同类问题错过三次）。各自传一份**固定副本**。

### 3.3 两次导出逐字节相同（实测）

```
export_scan_resolver.py  → cmp 通过
export_tip_crash.py      → cmp 通过
export_skill_traces.py   → cmp 通过（1.8 MB）
```

`skill_traces.json` 重跑之后：**新增 2 个技能，已有 376 个 0 处改变**（逐 key JSON 比）。

### 3.4 `sort_keys=True` 把 `trace` 的插入序排掉了 —— 顺序由 `summary` 钉

导出器统一 `json.dumps(sort_keys=True)`，所以 JSON 里 `trace` 的键是字典序的。
`resolve_scan` 的 `summary_lines()` 按**插入序**生成，而它是一个**列表** ——
于是顺序的判据落在 `summary` 上，`trace` 那一行只比键的集合。
（第一版直接比 `Object.keys` 的顺序，71 格当场红，原因就是这个。）

---

## 4. 变异清单（**23** 条，全部实跑到 red）

> 抬头原写 24 —— 主线按 `MUTATIONS` 逐条数是 **23**，而这张表本来就是 23 行。
> 不是丢了一条：这 23 条全在那次 406/406 全红的全量演练里。

| id | 挡的是什么 | 变红 |
|---|---|---|
| `scan-size-zero-is-refused-not-clamped` | `size_m ≤ 0` 是上游出错的信号，不是「太小的尺寸」。改成修剪 ⇒ 0 被悄悄变成 0.1 nm | 4 |
| `scan-tip-speed-is-a-combined-constraint` | 像素 / 每线时间 / 帧宽单独看都合法，乘起来才是针尖速度。2026-08-12 那个 488 nm/s | 10 |
| `scan-intent-needs-the-tier-to-be-named` | 「被点名的档」≠「碰巧定到的档」：只有前者有资格决定工作点 | 5 |
| `scan-prefs-yield-to-operator-tier` | 偏好只在「档位表这个字段其实是出厂值」时插得进来 | 2 |
| `scan-pi-must-be-a-pair` | 只填了一半的 PI 不可执行；替用户发明缺的那一半 = 发明一个积分增益 | 67 |
| `scan-clamp-must-declare` | 参数卫生的前提是修剪**说出来** | 9 |
| `scan-null-human-is-not-zero` | `f"{None:.4g}"` 的替代品不是 `0 V` | 1 |
| `tipcrash-threshold-is-inclusive` | 「同点连续 crash≥2 次」是现场指令；`>` ⇒ 每个坏点多挨一次撞 | 25 |
| `tipcrash-unknown-position-still-counts` | 读不到 ≠ 零 ≠ 否 | 7 |
| `tipcrash-unlocated-is-never-a-point` | 猜出来的坐标上画避让圈 = 编造事实 | 7 |
| `tipcrash-stale-crash-expires` | TTL 让通宵跑自愈，哪怕 agent 一次逃逸都没发起 | 3 |
| `tipcrash-coarse-move-clears-everything` | 不给坐标 = 一次刻意的换区 | 2 |
| `tipcrash-diag-failure-is-not-a-pass` | 判断在前、留痕在后，留痕不许改变返回值 | 1 |
| `scanat-timeout-stops-the-scan` | 还在跑的扫描挡住之后每一步 | 2 |
| `scanat-stopped-early-does-not-write` | 中途停止那条路上扫描**已经停了**，再补一发是对已停扫描的写 | 1 |
| `scanat-explicit-timeout-is-a-floor` | 2026-08-23：常数 300 s 把 512 px 的帧判成 abort | 1 |
| `scanat-truncation-is-a-failure` | `WaitScanComplete` 在每一种结束方式上都报 success | 1 |
| `scanat-buffer-after-configure` | `Scan_BufferSet(ch,0,0)` 的 0/0 语义在真机上尚未证实 | 9 |
| `fullscan-crash-guard-refuses` | ⑫ 的主线：trace `5305868e` 那 5 分钟 | 2 |
| `fullscan-records-the-crash` | 只问不记，状态机永远是空的 | 3 |
| `fullscan-clean-scan-clears-the-ledger` | 一次早已解决的撞针永远挡着一个好点 | 1 |
| `fullscan-probes-the-acquired-channels` | 2026-06-29：写死的探针列表让检查每次都报 `skipped` | 7 |
| `fullscan-stopped-early-skips-crash-check` | 2026-08-04：拿 NaN 行去判撞针 ⇒ 把「帧没扫完」说成「针撞了」 | 2 |

另：`k2-abort-latch` / `tier-bound-tolerance` / `crash-status-is-three-valued` /
`crash-nan-is-a-crash` 抽查过，仍然红（我改了 `traces.test.ts` 与 `analysis.test.ts`）。

### 「一条编不过的变异，那道闸就永远验不到」—— 这一批撞了**三次**，第十六～十八次

三次都是同一个根因的不同面，值得单记，因为它们的修法**不一样**：

| # | 变异 | 为什么编不过 | 修法 |
|---|---|---|---|
| 十六 | `scan-tip-speed-…` | `if (false && …)` 让 TS 判该块**不可达**，而**不可达代码里 narrowing 退回声明类型** ⇒ 块内 `sizeM`（刚 `throw` 掉 null 的）又变回可空，TS18047 | 改打在**上限那个数**上（`vTipMax → Infinity`），不制造不可达代码 |
| 十七 | `scan-pi-must-be-a-pair` | `&& → \|\|` 之后块内 `pGain / tConst` 两个都可能是 null | 改打在**缺的那一半从哪来**上（`tier.timeConstantS ?? 1`）——判据一样被拆，收窄照旧成立 |
| 十八 | `scan-clamp-must-declare` | `void 0 && warnings.push(…)` 被 TS 6 直接判 **TS2873**（`This kind of expression is always falsy`） | 改成**推进一份副本**（`warnings.slice(0).push`）—— 而那正是这类缺陷真实的样子 |

`fullscan-crash-guard-refuses` 也差点撞上（`if (false && escape !== null)` 会让块内
`escape` 退回 `string | null`），提前照 `k3-sample-gate` 的形状写成
「把**问**那一下掏空」躲过去了。

**第十六次这个形状以前没出现过**，值得写进课时：前十五次都是「拆掉之后某个绑定没人读」，
这一次是「拆掉之后某个绑定的**类型**变宽了」。两者的共同点是 TS 的控制流分析，
而修法的方向相反 —— 前者要**多留一个读**，后者要**别制造不可达**。

---

## 5. 没做完的，逐条

### 5.1 `ConditionTip`（composite.condition_tip，500 行）—— 差**两个技能**，不是差函数

| 差的 | 在哪 | 规模 |
|---|---|---|
| `AssessImageQuality` | `composite/assess_quality.py` | 一个整技能（**零子技能**，`_PHASE_*` 是本地分发键；见盘点 §3.1） |
| `TipPulse` | `composite/tip_pulse.py` | 226 行；2/2 子技能已移，盘点归 A 档 |
| ~~`tip_crash_tracker`~~ | ✅ 本批已落 | —— |

`crash_guard` 的接线点在 `condition_tip.py:441`（`run_composite` 起手），
与 `FullScan` 那一处同形，接上就是一行。

⚠️ `apply_tip_policy` **在这里不构成阻塞**：import 与调用各包一层 try/except，
失败即 `return params, None`，技能自己的 `ParameterSpec` 默认值仍在
（`_tip_policy.py:117-123, 128-133`）。**但仍然按 D-TIP-1 走 ——
不要写空的 `validateParams`。**

### 5.2 `PreScanCheck`（composite/prescan_check.py，**1446 行**）—— 差**一个函数族 144 行**，加一个大技能本体

子技能 7/7 全已移（`ConfigureScan` / `SetScanSpeed` / `SetScanBuffer` / `StartScan` /
`WaitScanComplete` / `SaveScan` / `GetLatestScanFile`），一个都不欠。

判据侧盘点列了六件，**核下来只剩一件**：

| 件 | 状态 |
|---|---|
| `frame_validity:judge_frame`(58) + `acquired_row_mask`(77) | ✅ **已在** `packages/host/vision/src/frame-validity.ts`（`judgeFrame` / `acquiredRowMask`） |
| `io/nanonis_files:read_sxm` / `sxm_oriented_frames` | ✅ **已在** `packages/host/nanonis-files/src/sxm.ts` |
| `operating_mode:safe_mode_active`(6) | ✅ 等价物在 `kernel/src/safety.ts`（`OperatingMode`），技能层读 `SAFE` 即可 |
| `scan_policy:wait_budget_s` | ✅ **本批已落**（`kernel/src/scan-resolver.ts` 的 `waitBudgetS`） |
| `line_check:_DEFAULT_MIN_CORRUGATION_M`（一行常量 `15e-12`） | ❌ 还没有（一行） |
| **`vision/tip_metrics`：`trace_retrace_correlation`(74) + `_detrend`(8) + `_fwd_bwd_instability`(46)** | ❌ **≈144 行**，这是唯一真正的缺件 |

⚠️ `tip_metrics` 落在 `packages/host/vision/`，**这一轮有另一条支线在动那个包，我没碰**。

**另一半工作量在技能本体**：`prescan_check.py` 是 1446 行，本仓没有比它更大的单个技能。
它不是「补 144 行就能落」的形状 —— 补完缺件之后还有一整段移植。

### 5.3 本批范围内**没做**、但顺手能做的一条

`resolve_scan` 的 `waitBudgetS` 目前住在 `scan-resolver.ts`，而旧仓它在 `scan_policy`。
**收族的时候搬去 `scan-policy.ts`**（同 D-LANG-1 的 `pyFixed` 暂住 `z-trace.ts`）。
这一轮并行支线在改文件，塞进去会撞行。

同理，`pyExp`（Python 的 `f"{x:.3e}"`）现在是仓里**第三份**
（`stm-skills/src/l0/common.ts`、`vision/frame-validity.ts`、
`kernel/src/tip-crash-tracker.ts`）。它们**不能互相 import**（内核是最底下那层），
所以收语言分歧那一族时该一起搬进 `si.ts`。

---

## 6. 集成测试：第一条「组合技能 ↔ 真 stmsim」的缝，当天就还了本

`packages/host/stm-skills/integration/scan-composites.test.ts`，8 条。
整条链第一次被端到端走通：

```
ScanAt → GraphExecutor → ctx.runSkill → ConfigureScan/SetScanBuffer/StartScan/WaitScanComplete
       → ctx.safeCall → InstrumentService.call → 真 stmsim
```

### 6.1 它当场推翻了旧仓一句注释的一半

旧仓写着「Z-controller 的信号号随装机而变（**标准模拟器上是 30，不是 14**）」。
本机实测：

```
Scan_BufferGet  → [2, [0, 14], 256, 256]        ← **裸整数**，不是那串 1-元组
Signals_NamesGet → [0]='Current (A)' … [14]='Z (m)'
```

在这台机器上那张**写死的兜底探针表碰巧是对的**。后果不是「注释错了」，
而是：**「探的是真正采到的那几路」这件事，用默认通道跑一趟证不出来** ——
两条路给的答案一模一样，一条绿着的测试什么都没验。
所以那一条换了一份通道清单（`channels: 'Z'`）去证：只采一路 ⇒ 只探一路，
而静态表会给两路。

（顺带：`channel_ids_from_buffer` 的注释说真机上是 `[(0,), (30,)]` 那种 1-元组 ——
那是 `nanonis_spm` 那条路的形状；stmsim 这条路回的是裸整数。两种本仓都吃。）

### 6.2 它也当场坑了整组集成测试一次 —— **共用一台模拟器**

`analysis.test.ts`（批 4a，只读）从**单独跑绿、整组跑红**：

```
expected '这一帧里没有已扫出来的行'
received '取不到通道 126 的帧：… channel 126 not in scan buffer（扫描缓冲里的通道是 [0, 14] …）'
```

根因两层：

1. **我改了仪器的全局状态**。`ConfigureScan` 会写帧几何与**采集通道清单**，
   `SetScanBuffer` 会写分辨率。默认通道 `"Z,Current"` 让缓冲从 `[0, 14]` 变成
   `[14, 0]`、分辨率从 256 变成 16。→ 我这一组加了 `beforeAll` 存档 /
   `afterAll` 还原（同 `applyApproachPreset` 的 `finally`：「这个状态是不是我改的」是判据）。
2. **还原之后它仍然红**，因为真正的前提是另一件事：
   `stmsim/modules/scan_module.py:_grab` 只在 `w.frame is None`
   （**这台模拟器从来没扫过任何一帧**）时才回一帧全零；跑过一次真扫描之后，
   它就去 `fr.data` 里查通道，查不到直接抛。
   **批 4d 之前没有任何一条集成测试真的扫过图**，于是那个前提一直白给。

→ 我把 `analysis.test.ts` 那一格改成断言**两种形状的并集**，并且把「是哪一种」
也断言出来（先探一次 `Scan_FrameDataGrab`，不是 `||` 一下就算数）。

### 6.3 改完之后它**间歇性**地红 —— vitest 会把上次失败的文件排到最前

第一版并集写错了一处：把「证据在 `data` 里」这句话挂在了**两条路的外面**。
而抓帧失败那一支是在 readout 之后直接 `return`，`data` 是空的 ——
证据在**那句话里**（它同时印出「你问的是哪一路」与「缓冲里实际有哪几路」）。

真正值得记的是它**为什么时红时绿**：`fileParallelism: false` 只保证文件串行，
不保证**顺序**；而 vitest 的默认 sequencer 会把**上一次失败的文件排到最前**。
于是：失败 → 下一次 `analysis` 先跑（还没扫过图）→ 绿 → 再下一次它不再被提前 →
跑在我后面 → 红。**一条会自己在红绿之间交替的测试，比一条一直红的更难查**，
因为「重跑一次就好了」看起来像个偶发。

修好之后连跑 4 次整组 `integration` 全绿。

**§6.2–6.3 这一段请 batch-4a / 主线过一眼**：我动了别人的测试文件，
虽然只是把一个隐藏的顺序依赖写明、并让两条路各自断言它真的有的那份证据。

---

## 7. 值得进课时的几件

1. **「不可达代码里 narrowing 退回声明类型」** —— 变异第十六次，一个以前没出现过的形状。
   前十五次是「拆掉之后某个绑定没人读」，修法是**多留一个读**；这一次是「拆掉之后某个
   绑定的类型变宽了」，修法是**别制造不可达**。同一个 TS 控制流分析，两个相反的方向。
2. **一条绿着的 e2e 可以什么都没验** —— §6.1：写死的探针表在这台机器上碰巧是对的，
   于是「问了仪器」与「用了写死的表」给出同一个答案。**要证一条路被走到，
   得让另一条路给出不同的答案。**
3. **整组集成测试共用一台仪器，而仪器有状态** —— §6.2。这是本仓第一次有测试
   **改**仪器状态，而它照出的红指向一个跟它完全无关的地方。存档/还原是最低要求；
   更难的是「跑过一次扫描」这种**不可还原**的状态改变。
4. **`pragma: no cover` 的两种含义** —— §1①：「测不到的兜底」与「到不了的兜底」在源码里
   长得一模一样，而后者是死代码。移植时补一个 `null` 就让它第一次可达。
5. **判定机与组合技能的分层**：`resolve_scan` 329 行进内核、`ScanAt` 只排计划拼报文。
   分界判据是「这件事用得着仪器吗」——用不着就进内核，于是它有网格金样、有变异、
   有 100% 可脚本化的测试。

---

## 8. 共享文件我动了哪些

**只走锚点的**（按分派单）：

* `packages/host/stm-skills/src/l0/index.ts` —— 批 4d 三处锚点（import / 展开 / re-export）。
  组合技能也从锚点走，**没碰底部那几行公共区**。
* `scripts/gen-skill-specs.ts` 的 `BATCH_4D`
* `tools/spec-export/export_skill_traces.py` 的 `BATCH_4D`
* `packages/host/kernel/src/index.ts` 的批 4d 锚点
* `tools/mutate/mutations.ts` 的批 4d 锚点
* `spec/deviations.md` 的批 4d 注释锚点（**编号一律留空**）

**锚点之外动过的**（各有理由，都请过一眼）：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `packages/host/stm-skills/src/l0/traces.test.ts` | 加 `scanAtNullRendering` / `fullScanChannelLabels` / `stripProgressClock` 三个函数 + `DEVIATIONS` 两条 + 一个 `describe` | 新技能进通用轨迹金样就得登记差异。那个文件没有锚点 |
| `packages/host/stm-skills/integration/analysis.test.ts` | 一格改成断言两种形状的并集 | §6.2 |
| `spec/golden/README.md` | 「专用驱动器」表加两行 | 新增两份金样 |
| `spec/golden/skill_traces.json` · `spec/progress.json` · `generated/specs.ts` | 重跑生成 | 生成物 |

`packages/host/vision/` 与 `packages/host/numerics/` **一个字节都没碰**。

⚠️ `traces.test.ts` 里的 `stripProgressClock` 是**第二份**剥时钟的实现
（`DEVIATIONS` 是模块级常量，在 `VOLATILE` 那行之前求值 ⇒ 撞 TDZ，调不到
`stripVolatile`）。我加了一个 `describe` 把两份钉在一起，哪天 `VOLATILE` 长出一个键
而 `_progress` 里恰好有它，这条当场变红。**合并时优先考虑把 `VOLATILE` /
`stripVolatile` 移到 `DEVIATIONS` 上面**，那样这两份就能合成一份。
