# 批 3g 交接 —— `optional_*` 五族（58 个技能）

`optional_controllers`(17) · `optional_afm`(14) · `optional_multiprobe`(11) ·
`optional_sweepers`(9) · `optional_scopes`(7)。五个模块全部收口。

技能 207 → **265**，模块 32 → **37**，测试 2850 → **3186**，变异 +12（全红）。
`skill_traces.json` 265 个技能 / 1103 条轨迹，重跑逐字节相同。

---

## 一、该登记成 deviation 的差异（编号待你统一分配）

### D-???-1 · `num_sweeps = 0` 那个「无限」标志翻不起来（**D-ZERO-1 第四次**）

| | |
|---|---|
| **Python** | `n = int(params.get("num_sweeps", 1) or 1)`，然后 `HSSwp_NumSweepsSet(max(n,1), 1 if n == 0 else 0)` |
| **声明** | `num_sweeps`：`min_value=0`，描述逐字写着「**0 = 一直连续扫到被停止为止**」 |
| **后果** | `0 or 1` → `1` ⇒ `n` 永远不是 0 ⇒ 那个无限标志位**永远写 0**，代码里 `1 if n == 0 else 0` 是死分支 |
| **TS** | `0` 通过，标志位翻起来 |
| **测试** | `optional-modules.test.ts` → `num_sweeps = 0 是「一直扫」，不是「扫一次」`；`traces.test.ts` 的 `ConfigureHighSpeedSweep/infinite`（期望值从金样算出来，旧仓改了就变红） |

**与批 3e 那三处（`fft_window` / `averaging_mode` / `sweep_direction`）是同一个形状**，
但这一次更值得记：那三处丢的是一个**档位**，这一处丢的是一个**模式** ——
调用方要的是「扫到我喊停」，拿到的是「扫了一次就停了」，
而返回值里那句「HSSwp 已配置」两种情况下一模一样。

**为什么敢让 0 过去**：`StopHighSpeedSweep` 存在，且 `HSSwp_Stop` 在中止后的放行清单里。
**停得下来，才敢让它无限。** 这一条是这个决定的前提，不是补充说明。

⚠️ 与它**刻意相反**的是同一个文件里的 `RunRfFrequencySweep`：那里的 `Infinite` 位
**永远写 0**，旧仓注释写死了「an agent must never start an unbounded RF sweep」。
一个无限的 RF 扫描是持续往隧道结里灌功率。两个「无限」，两个相反的决定，
值得像 D-CHANNELS-1 那样单独登记一句——**它们看起来是同一个旋钮**。

### D-SKILL-1 补充（又 21 格）· 空 body 上的信封

`optional_*` 五族全走 `_multi_read` / 逐格 `_rv`，于是空 body 上旧仓把整个三段信封
`["", "<bytes 0>", []]` 当成那一格的读数交出去。21 格，全部登记在
`traces.test.ts` 的 `DEVIATIONS` 里（用现成的 `withoutEnvelope`）：

`GetPiController` `GetGenericPiController` `GetPreamp` `GetPllZoomFftData`
`GetPllSignalAnalyzerData` `GetOcSync` `GetTipRecorderData` `GetKelvinController`
`GetCpdCompensation` `GetInterferometer` `GetBeamDeflection` `GetLaser`
`GetProbeZController` `GetProbeBias` `GetProbeCurrent` `GetHighSpeedSweepStatus`
`GetRfGeneratorStatus` `GetHighResScopeData` `GetHighResScopeStatus`
`RunHighSpeedSweep` `RunPllPhaseSweep`

### 不算 deviation，但值得进 `spec/` 的一句话

`ConfigureBeamDeflection` 旧仓的注释里有一句**被证伪的自述**：它曾经把动词放进
一张表再 `safe_call(verb, …)`，注释写着「grep 照样看得见」——
**看不见，那句注释就是错的**，是一次 AST 检查把这个谎揭出来的。
旧仓已经改成三条字面量分支了，本仓照移。
这件事本身是「注释不是判据，检查才是」的一个好例子。

---

## 二、新增的变异演练（12 条，全红）

| id | 挡的是什么 |
|---|---|
| `hsswp-zero-means-continuous` | `0` 是「一直扫」（D-ZERO-1 第四次） |
| `pi-limits-before-tuning` | 输出限**先写** —— 后面失败时手上已经是带界的参数 |
| `pi-inverted-limits-refused` | 反了的一对输出限就拒 |
| `kelvin-inverted-limits-refused` | 同上，Kelvin 偏压界 |
| `probe-gain-pair-preserved` | 只给 P 时把 I 读回来保住（I 归零 = 死环） |
| `rf-stop-cuts-output-anyway` | 停扫失败时**更要**切输出 |
| `rf-sweep-never-infinite` | RF 扫描的 `Infinite` 位永远 0 |
| `psd-failure-keeps-the-trace` | PSD 读不到不许把曲线扔掉 |
| `preamp-nothing-given-is-refused` | 一个都不给就拒 |
| `optional-multiread-null-not-zero` | 聚合读里读不到给 `null` 不给 `0`（48 条变红） |
| `beam-deflection-unknown-axis` | 认不出的轴就拒，不落到 vertical |
| `optional-channels-all-or-nothing` | 采集通道清单严格（同 D-CHANNELS-1） |

---

## 三、**没做**的，以及为什么

这一批把五个模块全部做完了，**没有跳过任何一个技能**。

一件跨界的事留给你：**`cell()` 现在是第五份私有拷贝**。
`reads-config.ts` / `spectrum.ts` / `limits.ts` / `pll.ts` 各有一份，
我在 `optional-common.ts` 里又写了一份。旧仓自己的注释预言了这件事：

> **这段代码在本仓有 11 份拷贝**，只有 readback.py 那份做对了……
> 其余 10 份的同一个错一直留到 2026-08-13/14 的真机只读全扫才被量出来

**该合并进 `common.ts`**，让那五处都 import 同一个。我没做是因为那四个文件属于
别的支线，跨界改会在合并时打架。合并之后 `optional-common.ts` 里那一段注释
（以及本文这一节）可以一起删掉。

---

## 四、值得进课时的三件

**① 一个「无限」旋钮转不动，而另一个旋钮转得动才是 bug。**
同一个文件里两个模块都有「要不要一直跑下去」这个选项：HSSwp 的被 `or 1` 吃掉了
（声明说 0 有意义，代码里连分支都写好了，就是走不到），RF 的则是**故意**焊死在 0。
两个看起来一模一样的旋钮，一个是缺陷、一个是纪律 —— 分辨它们的唯一办法是问
**「停得下来吗」**：`HSSwp_Stop` 在中止放行清单里，所以无限是安全的；
RF 那边即使停得下来，持续灌功率的那段时间里已经发生的事情停不回来。

**② 「给了一半」这件事在这一批里出现了三次，而三次的代价不一样。**
`MProbeZCtrl_GainSet` 吃 (P, I)、`MProbeScanner_CalibrSet` 吃三维、
`PLLSignalAnlzr_TimebaseSet` 吃 (时基, 刷新率) —— 三处都是「API 要一整组，
调用方只想改一个」。三处都**先读再写**，而理由最硬的是第一处：
**I 增益被顶成 0 的环看上去还开着，实际上再也追不上设定点**。
一个死环比一个关掉的环危险，因为它不报错。

**③ 五族 58 个技能里，真正的判据只有九条。**
其余全是「一层薄壳包一族 Nanonis 动词」。这批的价值不在代码量，
在于把那九条判据（两处限值顺序、两处反界拒绝、三处半组读回、
一处失败也要切、一处零值有意义）**各钉了一条变异**——
而 `optional-multiread-null-not-zero` 一条就让 48 个测试变红，
说明那一族的「读不到给 null」是被真正依赖着的，不是写着好看。
