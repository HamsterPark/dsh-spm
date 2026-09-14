# 批 3i 交接 —— 杂项 setter / qPlus 振幅 / 压电范围对账

**落地 11 个技能 / 3 个模块**（分派的是 28 个 / 11 个模块；其余 17 个**没做**，
理由在下面第 3 节，每一条都是本仓已经立过的那条规矩）。

- `builtins.misc_setters`（8）
- `builtins.qplus_amplitude`（2）
- `builtins.piezo_range_check`（1）

技能 207 → **218**，模块 32 → **35**。2850 → **2943** 条测试。

---

## 1. 该登记成 deviation 的（编号留空，请统一编）

### D-???? · `checkPiezoRange` 这个名字在本仓有**两个**，问的是两件事

| | |
|---|---|
| `configure-scan.ts` 里的私有 `checkPiezoRange` | 「**这一帧**超不超压电半程」——输入是帧的中心/宽高/角度 |
| 新的 `piezo-reconcile.ts` / `CheckPiezoRange` 技能 | 「**配置里的限值**与仪器报的量程对不对得上」——输入是 `SafetyLimits.xy_max_m` 与 `Piezo_RangeGet` |

**测试**：`packages/host/kernel/src/piezo-reconcile.test.ts`（整份）；
两者的调用点互不相交。

**为什么有意**：与 **D-CHANNELS-1** 完全同一条理由 ——
「两个看起来一样的名字，正是将来有人重构时最想合并的东西」。
合并的代价：帧闸会开始拿**配置**的限值去判一个**帧**，
而那个配置正是 2026-08-16 事故里比实际大 23 % 的那个数。
我**没有**改名（旧仓那个是私有的、只有一个调用点），只把差异登记下来。

### D-???? · qPlus 基线住在进程里，落盘由宿主接

| | |
|---|---|
| **Python** | 基线写进 `instrument_profile`，两个键必须在 `_CONFIG_SPEC` 里注册过，否则 `sanitize()` **静默丢掉**，读回来永远 `None`，撞针探测器**永久停在 `no_baseline`** |
| **TS** | `processQPlusBaseline`（显式对象，无 sanitize 过滤），`persist` 由宿主接；落盘失败**只记不抛** |
| **测试** | `tail-l0i.test.ts` → `取基线` / `落盘失败只记不抛` |

同 **D-PRESET-2**。旧仓那个「未登记键被静默丢掉」的坑本仓结构上不存在，
但「**写进去了**」与「**读得回来**」是两句话这条照旧。

### D-???? · `CheckPiezoRange` 的配置侧由外面注入

| | |
|---|---|
| **Python** | `_get_effective_limits(SafetyLimits())` —— 配置 + 管理员覆写 + 仪器事实收紧 |
| **TS** | `deps.effectiveLimits?.()`，没接退回 `DEFAULT_SAFETY_LIMITS` |
| **测试** | `tail-l0i.test.ts` → `没接生效限值 ⇒ 退回出厂默认` |

旧仓那句话值得抄进 deviations：**直接读类默认值会绕过管理员覆写，
于是报出来的数和实际生效的数不是同一个 —— 一个对账工具报错数字，比不对账更坏。**
本仓现在退回的正是出厂默认 `xy_max_m = 1.5e-6`，而**那就是事故里的那个数**；
宿主把生效限值接上之后这里自动跟着对。

---

## 2. 新增的变异演练（8 条，**全红**）

| id | 拆掉它，系统重新犯哪一次错 |
|---|---|
| `piezo-unknown-is-not-ok` | 仪器读不到 ⇒ 折成 ok，自检变成一句永远为真的安慰话 |
| `piezo-two-axes-take-the-smaller` | 取大不取小 ⇒ 放过一个 X 到不了的目标 |
| `qplus-excitation-needs-two-witnesses` | 只看开关不看幅度 ⇒ STM 模式下噪声底被判成「撞针」（缺陷⑰） |
| `qplus-unreadable-excitation-is-undecidable` | 读不到折成「没驱动」⇒ 「我不知道」变成「不适用」 |
| `qplus-no-baseline-is-not-ok` | 没基线折成 ok ⇒ 0 V 振幅被读成「针尖自由」 |
| `qplus-amplitude-channel-needs-both-hints` | 只配 `amplitude` ⇒ 认到「幅度设定点」，撞针判据从此读一个常数 |
| `qplus-sentinel-is-not-an-index` | `-1` 当下标用 ⇒ 把负通道号传给 `Signals_ValGet` |
| `scope-trigger-zero-is-a-value` | `trigger_mode/slope = 0` 下发不出去（D-ZERO-1 第三次） |

⚠️ **三条一开始是 `inconclusive`（构建失败）**，形状与前十一次一样：
那个 `if (x === null) return …` **本身就是类型收窄**，拆掉它下游就编不过。
按老规矩修 —— 提了三个**有声明返回类型**的函数：
`bothHalves` / `bothWitnesses` / `usableBaseline`。修完全红。

---

## 3. 分派了但**没做**的 17 个，以及为什么

每一条都是「压着一个没移植的子系统」，与批 3e 推迟 `GetChamberPressure` /
`StepCoarseXY`、批 3f 推迟 `BiasPulseWithReadback` 同一条规矩。

| 模块 | 个数 | 压着什么 |
|---|---|---|
| `optics_stage` + `optics_scan` | 10 | `mast/instruments/` 整层（`base` 329 行的 `MotionAxis`/`MotionController` 抽象 + `registry` + **5 个真驱动**：delay_line / pi_gcs / pztc_nm003 / thorlabs_kinesis / thorlabs_pdxc2） |
| `scan_prep` | 2 | `.sxm` 读 + `mast.vision` + 绘图 = **Phase 4.2 / 4.3** |
| `tip_shaper` | 1 | `_tip_policy` → **针尖方案表**（EXECUTION.md 的 **Phase 5.3**：tip registry） |
| `tip_shaper_readback` | 1 | `io/z_trace`(381) + `_readback_stream`(303) —— 与批 3e 推迟的 `BiasPulseWithReadback` **同一族，应一起落** |
| `calibration_readout` | 1 | 纯档案读，**零硬件调用**；它读的三样（倾斜标定 / 接触点 dI/dV / qPlus 实测 f₀·Q）本仓一样都还产不出 |
| `hardware_events` | 1 | `monitoring/store`(2107 行) + `buffer_hitl`(607) |
| `scan_intel_selfcheck` | 1 | 一半在自检**旧仓的打包问题**（冻结环境里 `walk_packages` 枚举不到东西），而本仓的注册表是静态对象 —— 少一个是编译错，不是静默断链 |

### ⚠️ `optics_stage` 这一条值得单独看一眼

它的 docstring 自己写着：

> Soft travel limits are enforced inside the drivers (Layer-0), so these skills
> only translate errors into SkillResults; **they cannot bypass the limits even
> with hallucinated parameters**.

也就是说这 8 个技能的**安全论证整个住在驱动层**。只移技能不移驱动，
搬过来的是 8 个错误翻译器，而**那道屏障留在原地** ——
与 `StepCoarseXY` 不带 `RelocateCoarseXY`、`GetChamberPressure` 不带
`vacuum_interlock` 是同一个形状。

### ⚠️ `calibration_readout` 与批 3f 的 D-PLL-1 是一对

D-PLL-1 推迟 `AcquirePLLFreqSweep` 的 f₀/Q 写回，理由是
「写一个没有读者的值只会让下一个人以为有人在用它」，并写明
「等有一个技能真的要问『当前这支音叉的 Q 是多少』的时候」再接上。

**`ReadCalibrations` 就是那个读者。** 现在移它，它只能把同一句
「从未标定过」说四遍。两者应当同一批落地 —— 那时 D-PLL-1 销账。

---

## 4. 值得进课时的三件事

### ①「两个同名的东西问的是两件事」第二次

批 3d 记过 D-CHANNELS-1（两处通道解析刻意不同）。这一次是**名字本身**撞车：
`checkPiezoRange` 在本仓已经有一个，问的是「这一帧超不超范围」；
新来的问的是「配置和仪器对不对得上」。
**输入不同、时机不同、后果不同，而名字一模一样。**
上一次的教训是「行为不一样的两个函数最想被合并」；这一次是它的前一步 ——
**名字一样的两件事，连发现它们不一样都要先花一分钟。**

### ② 一个失败模式长得像成功的探测器，比没有探测器更坏

qPlus 那两个技能把这句话展开成四态，而**后两态都不是「没事」**：

- `unavailable` —— 没这条通道／激励没开／读不到
- `no_baseline` —— 0 V 的振幅**本身不表示任何事**

缺陷⑰ 尤其值得讲：本机 STM 模式下 `excitation_on=0 / excitation_v=0 V`，
振幅通道上那 7–8 pm 是**未驱动解调器的噪声底**，拿它跟自由振荡基线比
**永远比出「塌了」**。所以判据要**两条证据**：开关开着**并且**幅度 > 0。
代价是「PLL 读不回来的机器上这条判据不可用」，收益是它不再永远误报 ——
**后者是实测发生的，前者是假设的。**

### ③ 浮点让两条边界测试撒了谎

我写的两条「正好等于阈值」的边界测试**一开始是红的**，而实现是对的：

```
1e-11 / 1e-10        = 0.09999999999999999   （不是 0.1）
(1020e-9 - 1000e-9) / 1000e-9 = 0.020000000000000004
```

两个都落在阈值**外面**。已经把这件事写进测试注释里，因为
**下一个人会把它读成「阈值差一个 ULP」然后去改阈值** ——
差的不是阈值，是那一对数除不尽。边界测试要用**除得尽**的数。

---

## 5. 给合并方的提醒

- 我只动了 `BATCH_3I` / `批 3i` 的锚点，`3g` / `3h` 一个字没碰。
- `packages/host/kernel/src/index.ts` 末尾加了两行 `export *`（`piezo-reconcile` / `qplus-amplitude`）——
  这一处三条支线都会改，可能要手工合。
- 生成物（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑过，
  合并后请统一再跑一次。
