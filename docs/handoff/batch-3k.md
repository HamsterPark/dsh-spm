# 批 3k 交接 —— 真空互锁 + 温度源

**落地 2 个技能 / 2 个模块，外加两个子系统内核件。**

- `builtins.chamber`（1）—— `GetChamberPressure`
- `builtins.temperature`（1）—— `GetTemperature`

新的内核判定件两份：

| 文件 | 源 | 行数（旧仓） |
|---|---|---|
| `packages/host/kernel/src/vacuum-interlock.ts` | `mast/core/vacuum_interlock.py` | 631 |
| `packages/host/kernel/src/temperature.ts` | `mast/core/temperature.py` | 423 |

技能 324 → **326**，模块 46 → **47**。

这一批整个是同一句话的两次展开：

> **读不到 ≠ 零 ≠ 否 ≠ 干净。**

真空那边它长成 fail-closed（看不见的规压计**就是**要拒的那个条件）；
温度那边它长成六个刻意不折叠的 reason（三种「没有值」对调用方的指示完全相反）。
两个技能都**永远 `success: true`** —— 拒绝是一个答案，不是工具坏了。

---

## 1. 宿主该怎么接那个钩子（**本仓默认不接**）

`RelocateCoarseXY` 是旧仓 515 个技能里**唯一**声明 `vacuum_ok_for_coarse` 的那个。
判定机现在有了，接线留给宿主：

```ts
import { SkillKernel, vacuumCoarseCheck, processVacuum } from 'dsh-spm-kernel'

// 1) 把压强源接到环境监控上（`null` = 没有读数 = 拒；源抛了也算没有读数）
processVacuum.source = () => {
  const r = env.latest('chamber_pressure')       // 宿主自己的监控
  return r === null ? null : {
    value: r.value, unit: r.unit, status: r.status,
    timestamp: r.isoTimestamp,                    // 空串 = 判不了新旧 = 拒
    sensorName: r.name, sensorClass: r.driverClass,
  }
}
// 2) 阈值：不接就用模块默认（DL-7 的 5e-8…1e-1 Pa，放行上限 1e-2 Pa）
processVacuum.config = { mode: 'gauge_or_attest', maxPa: 1e-2 }
// 3) 真钟。默认已经是 `Date.now() / 1000`，只有测试需要钉住
processVacuum.nowS = () => Date.now() / 1000

// 4) 接上闸
const kernel = new SkillKernel({
  computedChecks: { vacuum_ok_for_coarse: vacuumCoarseCheck() },
  /* …其余 deps… */
})
```

界面上的「签署」按钮走 `attest('vented_to_atmosphere', { signedBy: '张三' })`
（理由**只认那两个**，认不出直接抛；签署随进程而亡）。

**为什么本仓默认不接**：`deps.computedChecks` 缺省是空表，
于是 `vacuum_ok_for_coarse` 落回子串层、认不出、当没这条。
接上会改变粗动那几个技能的行为，而它们的轨迹金样是按「没接」录的 ——
默认改掉会让一堆已有轨迹变红，而那不是这一批要证明的事。
「默认是关的」本身钉了一条测试
（`vacuum-precondition.test.ts` → **默认不接**那一组），
将来有人顺手打开时会**当场**看见代价，而不是在一片红里猜。

⚠️ **`preconditions.ts` 不替它 fail-closed。** 没接上时它放行。
这是有意的：fail-closed 是那只闸自己的性质，「宿主有没有把闸接上」是宿主的决定。
在 `preconditions.ts` 里替它拒绝，会让一个**从未接过真空计**的台架永远动不了粗动，
而且说不清是谁拒的。

---

## 2. 该登记成 deviation 的（**主线已编号并登记进 `spec/deviations.md`**）

### D-VAC-1 · 真空阈值从 `instrument_profile` 读 → 本仓**注入**

| | |
|---|---|
| **Python** | `vac._config()` 从 `mast.core.instrument_profile` 取五个键（`vacuum_interlock_mode` / `coarse_motion_max_pressure_pa` / `vacuum_reading_max_age_s` / `vacuum_gauge_full_scale_pa` / `vacuum_gauge_min_pa`），读不出来就用模块默认，并把异常吞掉 |
| **TS** | `processVacuum.config`（`Partial<VacuumConfig>`），没接就是 `DEFAULT_VACUUM_CONFIG` |
| **测试** | `vacuum-interlock.test.ts` → `进程级源` 那一组 |

同 **D-PRESET-2** / **D-LOCKIN-2**。旧仓那句「defaults are the safe direction」
在本仓结构上成立：默认值是 DL-7 的，而 DL-7 的量程上限恰好压在放电带下沿。
⚠️ **那是这组默认值的一个好性质，不是判据的前提** —— 换一只规就得填那两个数，
而 `gaugeConfigProblem()` 会在**第一次**拒绝时就把原因说出来，不是第十次。

### D-VAC-2 · 墙钟注入：`processVacuum.nowS`

| | |
|---|---|
| **Python** | `sample.age_s(now=None)` / `att.remaining_s(now=None)` 直接读 `time.time()` |
| **TS** | 全部走 `processVacuum.nowS()`，默认 `Date.now() / 1000` |
| **测试** | `vacuum-interlock.test.ts` → `接上一只好规 ⇒ 放行，而且用的是注入的钟` |

理由与导出器把墙钟钉成 `1_700_000_000` 是同一条：一份每跑一次都换个数的金样，
`git diff` 回答不了「有没有变」。

### D-VAC-3 · 审计钩子（`set_audit_sink`）**没移**

| | |
|---|---|
| **Python** | `attest` / `revoke_attestation` 各发一条 `_audit(...)`，sink 由运行时注入，抛了只记不抛 |
| **TS** | **不存在** |

消融：本仓没有审计落点，接一个没有消费方的 sink 等于给下一个人留一条永远不亮的分支。
签署事件本身在 `processVacuum.attestation` 里看得见。
宿主要审计时在 `attest()` 外面包一层即可 —— 那是宿主的决定，不是判据。

### D-TEMP-1 · `TempChannel.as_dict()` **没移**，只移技能报的那一份

| | |
|---|---|
| **Python** | `TempChannel.as_dict()` 有 7 个键（多一个 `value`）；`GetTemperature` 报 `available_channels` 时**另拼**一份 6 键的 |
| **TS** | 只有 `channelDict()`（6 键，与技能报的那份同形） |
| **测试** | `temperature.test.ts` → `channelKelvin 与 channelDict 用的是同一条换算` |

`as_dict()` 在 `mast/skills/**` 与 `mast/agents/**` 里**零调用方**
（只有 `environment/` 那两处自己用）。移一个没有消费方的形状，
下一个人会以为这两份字典应该是同一份，然后把它们合并 —— 而它们刻意不是。
金样（`export_environment.py`）录的是**会上线的那一份**。

### D-VAC-4 · `pyFloat`：JS 的 `Number()` 会把三个「没有值」变成完美真空

| | |
|---|---|
| **Python** | `float(None)` / `float('')` 抛 ⇒ `to_pascal` 返回 `None` |
| **JS** | `Number(null)` / `Number('')` / `Number('  ')` **全是 `0`** |
| **TS** | `pyFloat()`（在 `vacuum-interlock.ts` 里，温度那边也用它） |
| **测试** | `vacuum-interlock.test.ts` → `` `Number()` 会把这些当 0，而 0 Pa 读起来正是完美真空 `` |

这条不是洁癖：`0 Pa` 与占位传感器那个 `0.0` 是**同一种失败形状**，
只是这回由类型转换伪造出来。本仓其他地方用 `scalarFloat`，
但它的语义是「body 的第 i 位取不出数就 null」，与 `float(x)` 不同 —— 没有复用。

### D-TEMP-2 · `age_s` 的日期-only 形式两边解释不同

`datetime.fromisoformat('2026-09-16')` 按**本地**午夜解，
`Date.parse('2026-09-16')` 按 **UTC** 午夜解（ES 规范对纯日期串如此）。
本仓在 `ageS()` 里把纯日期补成 `T00:00:00`，让两边都走「本地朴素时间」那一支。
**测试**：`temperature.test.ts` → `ageS` 那一组（金样里的三条时区用例）。

### D-TEMP-3 · `latest_temperature` 的类型校验从 `isinstance` 变成结构校验

| | |
|---|---|
| **Python** | `isinstance(out, TempReading)`，不是就回 `no_source` |
| **TS** | 结构校验（五个键齐不齐），不是就回 `no_source` |
| **测试** | `temperature.test.ts` → `源回了个不是读数的东西 ⇒ no_source` |

TS 没有运行期类名。判据（「源给的不是一份读数 ⇒ 当作没接上」）一模一样。

---

## 3. 新增的变异演练（17 条，**全红**）

| id | 拆掉它，系统重新犯哪一次错 |
|---|---|
| `vac-allowlist-not-denylist` | 白名单改黑名单 ⇒ 每个未来的占位实现都被默认接受，而它们报的 `0.0` 读起来正是完美真空 |
| `vac-status-must-be-ok` | 一只掉线的规报的 `0.0` 直接授权粗动（告警路径有意忽略 `unavailable`，互锁上必须拦） |
| `vac-unknown-unit-is-refused` | 缺省倍数 1.0 ⇒ `1 mbar`（带正中）与 `1 Pa` 进同一个桶 |
| `vac-no-timestamp-is-not-now` | 没时间戳伪造成 0 秒 ⇒ 「不知道多旧」变成「刚刚读的」 |
| `vac-age-is-a-criterion` | 旧读数给现在授权，而抽气/放气正是压强变化最快的时候 |
| `vac-over-range-is-not-a-reading` | DL-7 帧解析器不校验指数，一次超量程解码出的小数被当成好真空 |
| `vac-under-range-depends-on-the-floor` | Pirani 触底报的小数（在放电带里）被读成极好的真空 |
| `vac-gauge-only-refuses-signatures` | 「只认真空计」的机器上一句签名照样放行 |
| `vac-expired-signature-is-not-a-signature` | 昨天签的「已通大气」在今天抽到中间真空时照样放行 |
| `temp-warning-is-still-a-reading` | 降温途中长期落在警带里的机器对「现在几度」一路回答「读不到」 |
| `temp-unknown-real-is-not-placeholder` | 把「不知道」当占位 ⇒ 正常报 77 K 的机器被判成「没装温度计」 |
| `temp-unknown-age-is-not-fresh` | 年龄不明补个 0 ⇒ 等到温那道闸当场通过 |
| `temp-ambiguous-is-not-a-pick` | 名字对上两个就悄悄挑一个 ⇒ 挑错的那半时间没人会发现 |
| `temp-stage-preference` | 「现在几度」回的是磁体杜瓦的温度 |
| `temp-channels-null-is-not-empty` | 「问不到」折成「一个都没有」⇒ 智能体得出「这台机器没温度计」，而那条建议是「别再等了」 |
| `temp-zero-max-age-is-a-threshold` | `max_age_s = 0` 被读成「没给」⇒ 最严的那一档静静退化成不判（**D-ZERO-1 第五次**） |
| `temp-freshness-is-explicit-only` | 拿默认阈值算一个结论 ⇒ 调用方以为看到的是自己的判据 |

### ⚠️ 三条一开始是 `inconclusive`（构建失败），第十二~十四次

老规矩：**一条编不过的变异，那道闸就永远验不到**。第一轮 14/17 红，
三条真空闸的变异全部构建失败，而且是同一个形状：

```
vacuum-interlock.ts(367,16): TS18047: 'age' is possibly 'null'.
vacuum-interlock.ts(379,39): TS18047: 'pa'  is possibly 'null'.
vacuum-interlock.ts(401,28): TS2345:  'number | null' 不能赋给 'number'.
```

原因不在被改的那一行，在**它下面那几行**：`pa` / `age` 的非空是由上面那道
`if (x === null) return …` 收窄来的，而把某道闸改成 `if (false && …)`
会让 TS 判那一支不可达、**连带把收窄一起撤掉**，于是报文里的
`age.toFixed(0)` / `formatG(pa, 3)` 编不过。

修法与前十一次相同 —— 在两道 `null` 早退之后各钉一个**有声明类型**的常量：

```ts
const ageSec: number = age
const paValue: number = pa
```

下面每一道闸都用它们。改完 3/3 红。

### 另外两处是**预先**做的（避开同一个坑）

| 结构 | 挡住什么 |
|---|---|
| `knownAge(r): number \| null`（`temperature.ts`） | `freshness` 里 `r.ageS === null` 这一支**本身就是类型收窄**，拆掉它下游 `age > limit` 就编不过 |
| `givenMaxAge(params): boolean`（`environment.ts`） | 同一行上要挂两条变异（D-ZERO-1 一条、explicit-only 一条），拆成「谓词」与「调用点」两行才各挂各的 |

另外把 `matchChannel` 里子串档的 `hits` 改名成 `subHits`：
原来三档共用 `hits`，而 `find` 串要求**唯一命中**，
四空格缩进那行会把两空格那行整个包住。

---

## 4. 金样

### 轨迹金样（`skill_traces.json`，+11 格）

这两个技能**一次 Nanonis 调用都不发** ⇒ 注错点、空 body、回读失配三套开关
一个都碰不到它们。`GetChamberPressure` 因此只有 `ok` 一格；
`GetTemperature` 的十格全部由 `EXTRA_PARAMS` 撑出来
（`by_channel` / `casefold_channel` / `ambiguous_channel` / `unknown_channel` /
`placeholder_channel` / `fresh` / `stale` / `zero_max_age` / `bad_max_age` / `ok`）。

**夹具两侧同形**（`export_skill_traces.py` 的 `_reset_state`
与 `traces.test.ts` 的 `resetProcessState`）：一只 1e-3 Pa 的 DL-7 加一份活签署、
三个刻意各占一种形状的温度通道。不摆这一份的话，重放的是「空进程」而不是「那台机器」，
**而它会绿着比对另一件事**（同 `PRESET_FIXTURE` / `LOCKIN_FIXTURE`）。

### 判定机金样（`spec/golden/environment.json`，新，124 格）

`tools/spec-export/export_environment.py`，八节：
`to_pascal`(23) · `gauge_config`(7) · `gauge_verdict`(24) · `assess`(14) ·
`to_kelvin`(20) · `age_s`(11) · `read_temperature`(19) · `freshness`(6)。
输入与答案一起录，TS 那侧逐格重放（`vacuum-interlock.test.ts` 81 条 +
`temperature.test.ts` 74 条 + `vacuum-precondition.test.ts` 7 条 = **162 条新测试**）。

⚠️ JSON 没有 `inf` / `nan`。导出器把它们录成 `"Infinity"` / `"-Infinity"` / `"NaN"`
记号串，TS 那侧 `decode()` 解回来 —— 丢掉它们等于把 `to_pascal` 那道 `inf`
过滤器的金样一起丢掉。

### stmsim e2e：**这一批没有**，而且不该有

两个技能加起来发 **0 次** Nanonis 调用 —— 它们读的是宿主注入的进程级源。
在模拟器上跑它们，跑的是夹具而不是仪器。
判据全部落在上面那两份金样里（轨迹 11 格 + 判定机 124 格）。
这与「stmsim 没有那个模块 ⇒ 只对 SpecEchoServer 做 e2e」不是同一种情况：
那种是**模拟器缺能力**，这种是**技能不碰仪器**。

---

## 5. 值得进课时的三件事

### ① 同一个 `warning`，两个子系统给相反的答案 —— 而两个都对

| | `warning` / `alarm` | 理由 |
|---|---|---|
| 真空互锁 | **拒绝** | 它要的是「压强低于上限」的**正面证据**，而一个报警状态的读数不是证据 |
| 温度源 | **算读到了** | 一台从 300 K 降下来的机器降温途中必然长期落在警带里，而那恰恰是等降温唯一要看的那个数 |

这不是不一致，是**两个不同的问题共用了一个状态字**。
旧仓在温度那边写得很清楚：原来的 `status != "ok" -> None` 会让降温中的机器
对「现在几度」一路回答「读不到」。而在真空那边，`unavailable`
在**告警路径**上被有意忽略（掉线的规不该中止一整夜实验），
在**互锁**上却必须拦 —— 同一个状态字，同一个子系统内部就分岔了。

> **一个谓词只能回答一个问题。** 把「这条消息可不可信」与
> 「这个数能不能授权一次动作」合成一个 `is_ok()`，
> 两个消费方里必然有一个是错的，而错的那个不会报错。

### ② 换一只规，判据的另一半才露出来

DL-7 的量程上限 `1e-1 Pa` **正好**是放电带的下沿。于是在这台机器上
「一个量程内的有效读数」与「低于危险带」**恰好重合** ——
一个只写了超量程检查、没写欠量程检查的互锁，在 DL-7 上跑一辈子都是对的。

换一只 Pirani（下限 ~0.5 Pa，**高于**放行上限、就在放电带里）：
触底时它吐出来的数（下限值、零、或噪声）看起来正是一个极好的真空 ——
与占位实现那个 `0.0` 是同一种失败形状，**只是从另一头到达**。

所以欠量程那一测不是「它触底了吗」，而是
「**这只规的下限本身是不是已经低于上限**」。这条判据在本仓有两个出口：
拒绝（`under_range_rough`）与**放行**（`under_range_safe` —— 因为「太干净」
而拒绝一个 UHV 腔体是荒谬的），两条各有一格金样。

> 一个巧合与一条判据，在代码里长得一模一样。区别只有换硬件那天才看得见。

### ③ 「等不到」与「等一下」用同一个 `null` 表示，等待条件就变成「永远等」

温度那边六个 reason 里，**三个**都表示「现在没有值」，而它们对调用方的指示相反：

- `no_sensor` —— 这台机器没装温度计。**等下去永远等不到**，别轮询；
- `unavailable` —— 装了，此刻不给数（真机上是 `Lakeshore Logger.exe` 占着 COM3）。
  可以等，并请用户去看端口；
- `no_source` —— 宿主自己没接上。与仪器无关，重启/接线才会变。

旧仓把这三个折叠成一个 `float | None` 时，「等降温」那类条件静静地变成了「永远等」。
而修法不是加日志，是**把建议放进数据里**（`what_to_do`）——
描述会被裁剪、会被总结，而这一句是跟着答案一起到调用方手上的。

同一条纪律的第二处：`freshness` 返回**三态字符串**而不是 `bool`。
`bool | null` 会被 `if (!isStale(60))` 一句悄悄把「不知道」当成「新鲜」,
而「不知道」恰恰是最该停下来的那种答案。

---

## 6. 给合并方的提醒

- 我只动了 `BATCH_3K` / `批 3k` 的锚点，`3g` / `3h` / `3i` / `3j` 一个字没碰。
- `packages/host/kernel/src/index.ts` 在 `批 3k` 锚点下加了两行 `export *`
  （`vacuum-interlock` / `temperature`）—— 这一处并行支线都会改，可能要手工合。
- `packages/host/kernel/src/preconditions.ts` 只在模块 docstring 末尾加了一段
  （指向 `vacuumCoarseCheck` 与「本模块不替它 fail-closed」的理由）。**判定代码没动。**
- `traces.test.ts` 只在 import 与 `resetProcessState` 里追加。
- 生成物（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑过，
  合并后请统一再跑一次；`environment.json` 是本支线独有的新文件，不会冲突。
