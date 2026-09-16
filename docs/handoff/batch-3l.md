# 批 3l 交接 —— `builtins.spectroscopy` 整族 + `SafeCall` 的 per-call recv 预算

**落地 38 个技能 / 1 个模块**（`builtins.spectroscopy` 一次清零），外加一件内核判定件
与一条新的内核接缝。

| 文件 | 源 | 行数（旧仓） |
|---|---|---|
| `packages/host/kernel/src/spectroscopy.ts` | `_reshape_spectrum` + `_match_channel` + `_sweep_duration_s` | 53 + 7 + 54 |
| `packages/host/stm-skills/src/l0/spectroscopy.ts` | `mast/skills/builtins/spectroscopy.py` | 2359 |
| `packages/host/kernel/src/skill-kernel.ts` | `core/connection.py:200-243`（`_raised_recv_timeout`） | 44 |

技能 329 → **367**，模块 50 → **51**，测试 4145 → **4212**（另集成 40 → **49**）。

这一批整个是同一句话的三次展开：

> **一串合法的浮点，不等于一条对的谱。**

行列转置了 —— 每个数都是真的、量纲也对，只是不属于它被贴上的那个通道。
解不开而不说 —— 没有任何一个数看起来是错的。recv 预算不够 —— TCP 层面确实连着，
`degraded` 报 false，而这条连接上后续每一个调用都是垃圾。

---

## 1. 那条新的内核接缝：`ctx.slowCall`

### 1.1 开工前那两个问题的答案（**已经写进 `skill-kernel.ts` 的抬头**）

**① 超时之后那次调用算发生了没有？——算。**

命令已经打进线里，仪器那头很可能正在扫。超时说的是「我们不等了」，不是
「它没发生」。三个后果落进了结构，不是只落进注释：

| | |
|---|---|
| **不重试** | 重试等于在同一个点上再起一条扫掠。`slowCallFrom` 只发一次，一条测试钉着它 |
| **不当成「这次没动」** | 上层若据此认为针尖没动过，后面每一步都错 |
| **error 原样透传** | 传输层那条带机器可判前缀的 `error`（`Timeout:` / `comms_circuit_open:`）不再包一层 —— 包了就把前缀埋掉了（同 `l0/common.ts`） |

**② 谁来定这个数？—— 每次的预算由调用方算，上限由外面注入。**

- **每一次的值**：`AcquireSTS` 从**仪器自己的设定**算（点数 × (settling+integration)
  × 往返 × sweep 数 + 每趟的固定开销）。写死一个缺省，用户改一次配置就又不够了。
- **上限**：`DEFAULT_MAX_RECV_TIMEOUT_S = 900`，可由 `deps.maxRecvTimeoutS` 覆盖。
  它是**台架的属性**（必须低于传输层那个「假超时」阈值，否则抬了也会被换回默认值），
  于是照 D-LIMITS-1 / D-VAC-1 的老规矩：模块给默认、宿主可注入、**技能类里没有这个数**。

### 1.2 形状

```ts
export type BudgetedCall = (method, recvTimeoutS, ...args) => Promise<SkillCallRecord>
export type SlowCall     = (method, recvTimeoutS, ...args) => Promise<SlowCallResult>
export interface SlowCallResult { record: SkillCallRecord; recvTimeoutS: number | null }

export function effectiveRecvBudget(requestedS: number, capS: number): number | null
export function slowCallFrom(call: SafeCall, budgeted: BudgetedCall | null, capS?): SlowCall
```

三条判据，各一条变异：

| | |
|---|---|
| **按上限夹住** | 不夹 ⇒ 抬了个寂寞，而 `data` 里还写着一个大数 |
| **`0` / 负数 / 非有限不是预算** | 当成预算下发 = 把 recv 超时设成立刻到期（D-ZERO-1 又一次） |
| **没接那条口 ⇒ 报 `null`** | 不是悄悄退回连接缺省然后声称抬过。`recv_timeout_s: null` 就是「这台机器上一条长扫掠仍然会打废连接」在数据里的样子 |

**写成一个单独命名的入口**（`ctx.slowCall`）而不是 `safeCall` 的一个可选参数 ——
与 `emergencyCall` 同一条理由：这条路谁在走、走了几次要能一眼 grep 出来。
而它比 `emergencyCall` 更需要这一点：一条抬高了 recv 预算的调用会**占住这条连接
好几分钟**。

### 1.3 ⚠️ 宿主接线时的两件事

1. **`deps.budgetedCall` 要套上与 `safeCall` 同一道中止门**（`gatedSafeCall`）。
   它和 `emergencyCall` 一样是绕过主入口的第二条路；内核不替它补第二份闸门清单
   （D-KERNEL-1 同一条理由）。
2. `InstrumentService.call` **本来就收 `opts.timeoutMs`**，所以真接线只有一行：
   `(m, s, ...a) => inst.call(m, a, { timeoutMs: Math.ceil(s * 1000) })`。
   集成测试里就是这么接的，那是这条口子唯一一次跑在真 TCP 上。

本仓**默认不接**（`deps.budgetedCall` 缺省 `undefined`）：宿主还没有那条接线，
而默认接上会改掉 `AcquireSTS` 在所有已有夹具上的行为。默认关这件事本身由
`spectroscopy.test.ts` 的 `recv 预算：**没接那条口 ⇒ null**` 那一格钉着。

---

## 2. 该登记成 deviation 的（**主线已编号并登记进 `spec/deviations.md`**）

### D-STS-1 · `_reshape_spectrum` 的 `reason` 里不复刻 numpy 的异常文本

| | |
|---|---|
| **Python** | `np.array(...).reshape(rows, cols)` 抛 ValueError，`str(exc)` 拼进 reason：`6×7 装不下这段数据: cannot reshape array of size 4 into shape (6,7)` |
| **TS** | `6×7 装不下这段数据: 一共 4 个数,要 42 个` |
| **测试** | `traces.test.ts` 的 `reshapeReason()` —— 期望值**从金样算出来**（正则抠出 size/rows/cols 再重算），旧仓哪天改了那句话、或者 numpy 换了措辞，这条登记会当场变红 |

同 D-SKILL-2 / D-OSCI-1：逐字复刻一句 numpy 的异常，等于让诊断指向一个本仓根本
没有的库。**判据（几个数、要几个）一模一样**。

另有一条本仓多出来的分支：块里有不是数的元素时给
`… 装不下这段数据: 这段数据里有不是数的元素`（旧仓那边同样落在 `np.array` 抛上）。

### D-STS-2 · 通道串解析不了：旧仓抛，本仓拒

| | |
|---|---|
| **Python** | `ConfigureSTSChannels` 走 `int(x)`、`_coerce_int_list` 走 `int(float(x))` —— **两者都抛 ValueError**，于是技能以一句看不懂的异常失败 |
| **TS** | `strictIntList` / `coerceIntList` 解不出给 `null`，技能回一条说得清的拒绝，**一次调用都不发** |
| **测试** | `spectroscopy.test.ts` → `解析不了 ⇒ 一次调用都不发`；`traces.test.ts` 的「旧仓每一格都抛」那一格 |

同 D-SKILL-3。顺带：本仓两个解析器**照旧刻意不同**（见 §5.1），没有合并。

### D-STS-3 · `AcquireSTS` 报的是**真的用上的** recv 预算

| | |
|---|---|
| **Python** | `data["recv_timeout_s"] = round(recv_budget_s, 1)` —— 记的是**请求的**那个数，而 `connection.py` 会把它夹到 900 s |
| **TS** | 记的是 `ctx.slowCall` 回来的那个数（已夹过）；宿主没接这条口时是 `null` |
| **测试** | `spectroscopy.test.ts` → recv 预算那两格；`skill-kernel` 侧 `slowCallFrom` 三格 |

金样照不出它（夹具里的预算从来没超过 900 s），所以它由单测 + 变异钉住。
理由与 D-SCAN-4 那条「回声不是读数」同源：一个「我请求了 3000 s」的记账，
在一台上限 900 s 的台架上是假的。

### D-STS-4 · `.dat` 候选目录只有一个来源（**沿用 D-FRAME-1，不新开**）

旧仓 `_attach_saved_dat` 走 `_candidate_save_dirs`（四路）。本仓沿用
`GetLatestScanFile` 那一份：**问仪器**要 session 目录，只搜真目录，只认最近 120 s。
另外三路（落盘登记表、`working-sessions`、样品原位目录）依赖本仓还没有的东西，
已在 D-FRAME-1 登记过。**调用序列因此与旧仓一致**（都是一次 `Util_SessionPathGet`）。

`record_scan_path` 那一句（旧仓裹在 `except: pass` 里的落盘登记）**没移**：
本仓没有那份登记表，接一个没有消费方的写入，下一个人会以为有人在读它（消融精神，
同 D-VAC-3 / D-PLL-1）。

### D-STS-5 · `ConfigureSTS` 的 `AdvPropsSet` 被拒时那两个键是 `null`

这一条**与旧仓相同**（`True if adv_ok else None`），列在这里只是因为它值得被看见：
「没设上」不是「设成了 false」。一个宣称了 Z-Ctrl Hold 而那个寄存器根本没碰过的
返回值，正是这一族最想避免的东西（同 D-LOCKIN-1 的 `phase_deg: 0.0`）。

### D-LANG-2 · `pyRound`

`round(x, n)` 是**银行家舍入、按精确值算**；`toFixed` 明写「正好一半取大的那个」。
新增 `pyRound()`（在 `kernel/src/spectroscopy.ts`），与 `pyFixed` / `pyFloatRepr` /
`pyStr` / `pyMod` / `pySum` 同族。

⚠️ **`environment.ts` 里有一份特化的 `round2()`**（批 3k 写的，scale-by-100 那种写法）。
两份现在并存。`round2` 的写法在 `2.675` 这类数上**碰巧**与 Python 一致，但它的判据
（`diff > 0.5`）与 `pyRound` 的判据（精确值的第 n+1 位是 5 且后面全是 0）不是一回事。
**建议主线合成一份**（取 `pyRound`），这正是 `cell()` 那十份的形状 —— 我没合，因为
`environment.ts` 是别的支线刚落的文件。

---

## 3. 新增的变异演练（19 条，**全红**）

| id | 拆掉它，系统重新犯哪一次错 |
|---|---|
| `spectrum-rows-are-channels` | 2D Data 按列读（转置）⇒ 真机上返回一串混在一起的谱，**而每个数都是合法的浮点、量纲也对**（2026-07-03） |
| `spectrum-num-points-is-cols` | 点数报成行数 ⇒ 一条 200 点的谱自称有 3 个点，而 `channel_names` 恰好也是 3 个，看起来自洽 |
| `spectrum-block-may-be-a-typed-array` | 只认嵌套表 ⇒ 一整条真谱被判成「数据块不是列表」，而那是一句**说错了的**诊断 |
| `spectrum-unparsed-has-a-reason` | `reason` 空掉 ⇒ 「块解不开」与「这条谱真的只有 0 个点」一模一样（2026-08-15 普查 A3） |
| `spectrum-no-names-is-not-zero-points` | 「解开了但一个通道名都没有」被当成成功 ⇒ 0 个通道配一个像模像样的点数 |
| `sweep-budget-unreadable-is-not-fast` | 读不到设定时退回一个**小**数字 —— 那正是 2026-09-08 那个 bug 的形状 |
| `sweep-budget-backward-doubles` | 往返少算一半 ⇒ 预算不够，而不够的代价是连接报废 |
| `pyround-is-bankers-rounding` | `round(0.125,2)` 两边分岔，而这些数逐位进金样（D-LANG-1） |
| `recv-budget-is-capped` | 不夹上限 ⇒ 抬了个寂寞，而 `data` 里还写着一个大数 |
| `recv-budget-zero-is-not-a-budget` | `0` 被当成预算下发 ⇒ recv 超时设成立刻到期（D-ZERO-1） |
| `recv-budget-unwired-is-null` | 没接那条口还报请求的那个数 ⇒ 一台从没抬过预算的机器声称自己等了 422 秒 |
| `sts-unparsed-with-saved-dat-is-not-failure` | 盘上有数据却报失败 ⇒ agent 被推去重扫同一个点：多一次针尖变化的机会，而好数据本来就在 |
| `zspectr-unparsed-is-always-failure` | Z 谱不落盘，内联是唯一一份；解不开还报成功 ⇒ 一次什么都没拿到的采集被答成了数据 |
| `sts-spectrum-parsed-is-always-present` | 标志只在失败时落键 ⇒ 按它分支的调用方在**成功**路径上读到一个缺席的键 |
| `z-channel-fallback-is-load-bearing` | 真机上 z 那一路叫 `Z rel (m)`，四个显式 needle 一个都不命中；拆掉回退 ⇒ `data.z` 安静消失而技能照样 success |
| `mls-bias-bound-is-the-only-gate` | MLS 七串声明成 `str` ⇒ 内核 K6 的数值包络整个绕过去；这里不判 ⇒ 幻觉出来的段起点直达隧道结 |
| `mls-arrays-must-be-equal-length` | 段数与各串长度自相矛盾 ⇒ 帧错位 / 硬件上一份垃圾段配置（2026-07-03） |
| `mls-limits-are-injected` | 判的界和印的界不是同一个（D-LIMITS-1） |
| `sts-channels-strict-parser-stays-strict` | 两个解析器被合并 ⇒ `0; 1` 在一处被收下、在另一处被拒，而两处发的是同一条硬件命令 |

### ⚠️ 「一条编不过的变异，那道闸就永远验不到」**第十五次**

`mls-limits-are-injected` 第一版打在

```ts
const lim = deps.effectiveLimits?.() ?? DEFAULT_SAFETY_LIMITS
```

上，拆成 `DEFAULT_SAFETY_LIMITS` 之后 `deps` 成了没人读的形参：

```
spectroscopy.ts(573,35): error TS6133: 'deps' is declared but its value is never read.
```

**前十四次的老办法（提一个有声明返回类型的函数）这次不管用**：`noUnusedParameters`
是开着的，把 `deps` 挪进辅助函数只是把同一个错误挪了个地方。

用的是批 3j 的那条新办法 —— **换一条同样拆掉判据、而所有绑定都还有人读的变异**：
打在 `const lo = lim.bias_min_v` 上（`lim` 仍被 `hi` 读、`deps` 仍被 `lim` 读）。
它拆掉的判据是同一条，而且症状更贴近 D-LIMITS-1 的原话：**判的界和印的界不是同一个**。
配套把那条测试从「一个界」扩成「两个界各一次，且报文里印的就是注入的那一对」。

---

## 4. 金样

### 轨迹金样（`skill_traces.json`，+107 格）

`export_skill_traces.py` 的 `BATCH_3L` 一次跑全 38 个，没有动任何夹具、
没有动 `EXTRA_PARAMS` / `PARAM_OVERRIDES` / `CUSTOM_ERRORS`（合并冲突面因此是零）。

**两件要写下来的事实**：

1. **这一族的金样里没有一格「谱真的解开了」。** 合成回包按协议表给 `2f` 一块 2×2，
   而表头（两个 `i`）说 6×7 —— 于是 `AcquireSTS` / `AcquireZSpectr` 的**每一条**轨迹
   都落在「装不下」那一支。成功解开的那条路、别名那张表、`.dat` 兜底那条判据，
   金样一格都没有，全部由 `l0/spectroscopy.test.ts`（38 格）+ 集成测试兜。
   这不是夹具的毛病 —— 合成器是按协议表摆的，`2f` 的形状信息本来就不在表里。
   要补的话得给导出器加一条「按 rows×cols 生成数据块」的特例，**而那要动夹具**，
   这一轮的锚点纪律不允许。留给主线定。

2. **四个技能的金样只有一条 `raised`**（`ConfigureSTSChannels` / `SetSTSChannels` /
   `SetZSpectrChannels` / `SetSTSMLSVals`）：它们的必填参数是 `str`，通用规则给
   `'spec-export'`，而旧仓在参数强转上**当场抛**，一次调用都没发出去。

   `traces.test.ts` 原来对这种技能会生成一个**空的 describe**，vitest 报
   `No test found in suite` —— 一个长得像故障的通过，而且它把「这个技能一条判据
   都没验」藏在噪声里。现在补了一条通用判据：**旧仓每一格都抛；本仓不抛，
   给一条说得清的拒绝，而且一次调用都不发**。这条会对将来所有同形状的技能生效。

### 判定机金样：**这一批没有单独的一份**

`reshapeSpectrum` / `sweepDuration` 的输入是**回包**，不是一张参数表 ——
它们的判据落在轨迹金样（真旧仓驱动）与 30 条内核单测上。
与 `environment.json` 那种「纯函数网格」不是同一种东西：那边的输入空间是可枚举的，
这边的输入是一个 8 项异构信封。

---

## 5. 我核出来与 `survey-remaining.md` 不一样的三条

### 5.1 「`SetSTSChannels` 用 `_coerce_int_list`（认 `;`、**垃圾不抛**）」—— 后半句不成立

`_coerce_int_list(value)` 对字符串走
`[int(float(x.strip())) for x in value.replace(";", ",").split(",") if x.strip()]`，
而 `float('spec-export')` 是 **ValueError**。导出器实测把这一条钉死了：

```
SetSTSChannels/ok  RAISED  ValueError: could not convert string to float: 'spec-export'
ConfigureSTSChannels/ok  RAISED  ValueError: invalid literal for int() with base 10: 'spec-export'
```

**两者都抛。** 真正的差别是另外两件：

| | `ConfigureSTSChannels`（手写 split） | `_coerce_int_list` |
|---|---|---|
| `;` 当分隔符 | ✗ | ✓ |
| 小数写法 `'2.5'` | ✗（`int('2.5')` 抛） | ✓ **截成 2**（`int(float(...))`） |
| 非字符串入参（真 list / 标量 / None） | ✗（`.split` AttributeError） | ✓ |

**「刻意不同、别统一」那条结论仍然成立**，只是理由要换成上面这张表。
本仓两侧都**不抛**（D-SKILL-3），并留了一条变异钉住「别把严的那个换成宽的那个」。

### 5.2 「`_get_effective_limits` 对这个调用点是可证明的 no-op」—— 成立，但**结论要补一句**

盘点说得对：`_INSTRUMENT_CLAMPS` 里只有 `("setpoint_max_a","preamp_full_scale_a")`
一条，偏压不在里面，所以收紧层退化成「默认 ±10 V 或管理员覆写」。

要补的是：**那不代表这条路可以直接读 `DEFAULT_SAFETY_LIMITS`。** 管理员覆写那一半
是真的，而 `SetSTSMLSVals` 是**这条路上唯一的一道偏压闸**（七串声明成 `str`，
内核 K6 的数值包络整个不适用）。所以照 D-LIMITS-1 走注入，并为此留了两条变异。

### 5.3 `AcquireSTS` 的调用序列比盘点里写的多一次

盘点把它算成「28 纯线缆 + ... + `findLatestSaved`（已有）」，读起来像是只多一次文件系统
查找。实际上 `_attach_saved_dat → _candidate_save_dirs → _session_dir_from_caller`
会**再发一次 `Util_SessionPathGet`**，于是 `AcquireSTS/ok` 的动词序列是**五条**：

```
BiasSpectr_Open → BiasSpectr_PropsGet → BiasSpectr_TimingGet
  → BiasSpectr_Start(recv_timeout_s=…) → Util_SessionPathGet
```

前两次读是 `_sweep_duration_s`（盘点里没提），最后一次是找 `.dat`。
这一点影响的是「这个技能发几次调用」这条判据本身，所以写在这里。

---

## 6. 真 stmsim 上量到的三件（DoD ④）

集成测试 40 → **49** 条（`packages/host/stm-skills/integration/spectroscopy.test.ts`，9 条）。

### ① 行列：**真机上第一次被检验，而且对得上**

```
BiasSpectr_Start => [53, 3, ["Bias calc (V)","Current (A)","Current [bwd] (A)"],
                     3, 200, [[…200 个],[…],[…]], …]
```

rows=3=**通道数**，cols=200=**点数**。判定件假设的正是这个。
两套自己造的回包（合成器 + 手写夹具）都由我决定 —— **一个「在两套自己造的回包上都
对」的解析器，仍然可以在真东西上一次都对不上**（D-READBACK-1 那条理由）。这一格
把它验掉了，而且顺带钉了一条只有真机说得出的断言：`channel_names.length < num_points`
（转置的读法会给出 200 个只有 3 个点的「通道」）。

### ② `Z rel (m)` —— 那条「名字以 z 开头」的回退**不是冗余**

```
ZSpectr_Start => [49, 3, ["Z rel (m)","Current (A)","Current [bwd] (A)"], 3, 100, …]
```

四个显式 needle（`z (` / `z(` / `z_m` / `z pos`）**一个都不命中** `z rel (m)` ——
`z` 后面跟的是空格再跟 `r`。真机上命中的只有那条回退。
删掉它，每一条真 Z 谱的 `data.z` 都会安静地消失，**而技能照样 `success`**。
这一条现在有一条变异 + 一条集成断言。

### ③ 通道索引：本机 stmsim 给的是**裸整数**

`BiasSpectr_ChsGet => [1, [0], 15, 1, ["Current (A)"]]`。
真机 2026-08-04 给的是 `[(0,), (30,)]`（1-元组）。`channelIdsFromBuffer` 两种都吃，
集成测试断言的是「**每一个都得是数**」而不是某一种形状 —— 因为这两台机器给的
就是不同的形状，而下游 `int()` 只认其中一种。

另外：`SetSTSSafeCond1` 那条「一次 TCP 都不发」的拒绝**只有在真能发 TCP 的地方验
才算数**（单测里「没发」和「发不出去」在调用记录上长得一样，同批 3f 的脚本白名单）。

---

## 7. 没做完的，逐条

1. **技能卡片（DoD ⑦）没做。** `scripts/gen-skill-cards.ts` 在 PLAN §（仓库结构）里
   列着，但**仓里不存在**，前面几批也都没做。这是仓库级的缺口，不是这一批的；
   `progress.json` 的 `status: done` 目前判的是 spec/model/traces/impl 四项。
2. **`EXTRA_PARAMS` / `CUSTOM_ERRORS` 一条都没加**（锚点纪律）。代价具体：
   `SetSTSMLSVals` 的三条参数级拒绝（空段、不等长、越界）、以及三个通道串技能的
   成功路径，**在轨迹金样里一格都没有**。它们由 `l0/spectroscopy.test.ts` 的 38 格
   兜住，但那不是「对旧仓的差分」。建议主线合并后补上：
   `{"SetSTSMLSVals": {"bias_start_v": "-1.0, 0.5", …}}` 之类的 `PARAM_OVERRIDES`
   一加，这四个技能的整条成功路径就有金样了。
3. **谱数据块的合成回包**（见 §4 第 1 条）：要让「解开了」那条路进金样，得给导出器
   的 `_synth_body` 加一条「`2f` 按同一回包里的 rows×cols 生成」的特例。那要动夹具，
   而动夹具是上一轮 3h 合并冲突的来源，所以没动。
4. **`environment.ts` 的 `round2()` 没合并进 `pyRound()`**（见 §2 最后一条）。
5. **`deps.budgetedCall` 没有宿主接线**（本仓还没有装配点，`new SkillKernel` 只在测试里
   出现）。集成测试里那一行就是接线的样子。
6. **`preconditions` 没动**：`AcquireSTS` / `AcquireZSpectr` 声明 `z_controller_on`，
   而那条前置已经在 `preconditions.ts` 里了，不需要新判据。

---

## 8. 值得进课时的四件

### ① 一张转置的谱，在数值上仍然是一串合法的浮点

这是整批里最值钱的一句。撞针检测那种缺陷有个「信号没了」的可见症状；
`checkPiezoRange` 那种有个对不上的数字。而转置的谱**没有任何可见症状**：
每个数都在量程里、量纲对、形状也像一条 I-V。它只在你拿两条谱去比、或者拿它去拟合
一个物理量时才现形 —— 而那时你已经据此做过一串决定了。

对应的纪律很具体：**这种判据的测试必须用逐格互不相同的数据**。
用一格全是 0.25 的数据，转置与不转置给出的答案一模一样 —— 测试会绿，而且它
什么都没验。（同一条纪律在导出器的 `_synth_one` 抬头里已经写过一次，那次是
「5 个 float 进 5 个字段」；这次是二维的同一件事。）

### ② 一个缺席的键，分不出「没测出来」和「没解出来」

旧仓五个 bail-out 全回 `({}, 0)`，调用方唯一能看到的症状是 `data` 里少了
`num_points`。这跟 D-TEMP 的三个 reason、真空的 `null` 时间戳是同一件事的第 N 次：
**「读不到」必须是一个能被说出来的值，而不是一次缺席。**

而这一次比前几次更难发现 —— 解错的时候至少有一串数看起来不对，
**解不出而不说的时候没有任何一个数看起来是错的**。

### ③ 超时不等于「没发生」，而这决定了三件事

`recv` 超时之后：命令已经打进线里，仪器可能正在扫。于是
「不重试 / 不当成没动过 / 这条连接按流可能已错位处置」——**三件都是从同一句话推出来的**。
这也是为什么 2026-09-08 那次的症状是「整条连接后续全废」而不是「这次采集失败」：
回包 422 s 后才到，落在一个没人读的 socket 上，从此每一次读都读到上一次的尾巴。

`degraded` 还报 false，因为 TCP 层面确实连着 —— **一个只看得见连接、看不见流的健康
指标，在这种故障上永远是绿的。**

### ④ `noUnusedParameters` 让「提一个带返回类型的函数」这条老办法失效了一次

前十四次撞「编不过的变异」，修法都是抽一个有声明返回类型的辅助函数 ——
它挡住的是**流类型收窄**。这一次的构建错是 TS6133（形参没人读），
把 `deps` 挪进辅助函数只是把同一个错误挪了个地方。

换的是批 3j 那条新办法：**同样拆掉判据、而所有绑定都还有人读的另一条变异**。
值得记的是它比原来那条更好：打在 `const lo = lim.bias_min_v` 上之后，症状变成
「判的界和印的界不是同一个」—— 而那正是 D-LIMITS-1 原话里那句
「**一个对账工具报错数字，比不对账更坏**」。

**一条变异的形状，有时比它守的那道闸更能说清那道闸是干什么的。**

---

## 9. 给合并方的提醒

- 只动了 `批 3l` / `BATCH_3L` 的锚点，`3g`–`3k` 与 `4a` 一个字没碰。
- `packages/host/kernel/src/skill-kernel.ts` 是这一轮的独占改动（任务里点名的例外）：
  新增一段类型 + `ctx.slowCall` 的构造 + `KernelDeps` 两个可选字段，
  并把原来内联的 `safeCall` 兜底提成一个局部常量（`ctx.slowCall` 要用它）。
- `packages/host/stm-skills/src/l0/traces.test.ts` 改了三处：
  import 加 `slowCallFrom`、`fakeCtx` 加 `slowCall`、`DEVIATIONS` 加 `reshapeReason`，
  另加**一条通用分支**（全是 `raised` 的技能不再生成空 describe）。最后一条会影响
  将来所有同形状的技能，合并时值得多看一眼。
- `packages/host/stm-skills/src/l0/engage.test.ts` 只加了一行 `slowCall`（类型要求）。
- 生成物（`specs.ts` / `skill_traces.json` / `progress.json`）已按本支线重跑过，
  合并后请统一再跑一次。`spec/golden/` 下没有本支线独有的新文件。
- 验收命令：
  ```
  npx tsc -b
  npx vitest run --project '!integration'                      # 4212 条
  STMSIM_PYTHON=… STMSIM_ROOT=… npx vitest run --project integration   # 49 条
  node tools/mutate/run.ts <上表 19 个 id>                      # 19/19 red
  ```
