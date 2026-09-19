# 批 5a 交接 —— 针尖登记表底座，外加 **D-TIP-1 结清**

**落地 4 个技能 / 4 个模块 + 针尖登记表三件套进内核**，并把挂了两轮的 **D-TIP-1**
（针尖安全包络 `validateParams`）真正接上。

| | |
|---|---|
| 技能 | 394 → **398 / 515**（模块 71 → **75 / 165**） |
| 测试 | `--project '!integration'` **91 文件 / 5232 条全绿**（新增 334 条） |
| 集成 | 63 → **68 条**（新增 5 条，对真 stmsim） |
| 新金样 | `spec/golden/tip_policy.json`（**第五台专用驱动器**：12 支针尖 × 22 个请求 = 264 格，**111 格被拒**） |
| 变异 | **新增 23 条，全部实跑到 red** |
| 偏差 | 新登记 **14 条**（编号留空，主线统一编），其中一条是 **D-TIP-1 的结清**并**更正了它原文里一句已经不成立的话** |

落地的：

1. `core/tip_state.py`(441) 的**数据层** → `packages/host/kernel/src/tip-registry.ts`
2. `core/tip_conditioning_policy.py`(368) → `kernel/src/tip-conditioning-policy.ts`
3. `core/tip_conditioning_resolver.py`(221) → `kernel/src/tip-conditioning-resolver.ts`
4. `builtins/_tip_policy.py` 的另外两样（`apply_tip_policy` / `policy_fields_for_result`）
   → `stm-skills/src/l0/tip-policy.ts`（批 3j 已落前两样）
5. 技能：**`TipShape`**（builtins.tip_shaper）· **`TipPulse`**（composite.tip_pulse）·
   **`TipConditioningSelfCheck`** · **`TipForgeSelfCheck`**

---

## 0. 我核出来与盘点（和 D-TIP-1 原文）不一样的地方

盘点与 deviation 都是人写的，这四条我自己核过。

### 0.1 ⚠️ **「铂铱 8 V、qPlus 3 V 会被拒绝」在今天的旧仓已经不成立**

D-TIP-1 原文、`readback-skills.ts` 的欠账注释、盘点 §C 档都写着这句话。
**2026-08-12 现场把这两个上限统一拉满了**，`tip_conditioning_policy.py` 里逐字记着理由：

> 凭多年 STM 经验，这个安全包络定得过严、没有实际意义，针尖没有那么容易损坏。

我逐档核过（金样 `tip_policy.json` 的 `tips` 那一半就是照着抄的，12 支针尖）：

| 包络字段 | 全表取值 |
|---|---|
| `max_abs_pulse_v` | **10.0，一档都不差** |
| `max_poke_depth_m` | **1.0e-8，一档都不差** |
| `max_pulse_count` | 通用 **5** / qPlus **2** ← **全表唯一还在分辨针尖的包络字段** |

`kernel/src/tip-conditioning.test.ts` 有一条测试把这三组值钉住 —— 哪天旧仓再收紧，它会变红。

**这不代表这道闸是摆设**，三条：

1. `TipPulse.count` 的**声明上限是 50**，包络是 5（qPlus 2）—— K6 的范围检查放行的值，
   这道闸会拒。这是它今天真正在挡的那一格；
2. 宿主覆写可以**收紧**（`processTipRegistry.overrides`），而覆写那条路在旧仓
   **从上线起就是坏的**（见 0.2）；
3. 它在**任何硬件调用之前**拒，而全局 ±10 V 的 SafetyGate 按**参数名子串**判，
   **不知道台上装的是哪根针**。

**但欠账那句话得改**：`readback-skills.ts` 里那段「铂铱（包络 8 V）…」我在这一批里
一并改掉了 —— 一句修好之后静静变成假话的理由，比没有理由更坏。

### 0.2 旧仓的用户覆写**从上线起一次都没被读到过**

`tip_conditioning_resolver._read_overrides()` 调的是 `SettingsStore()`，而它的 `config_dir`
是**必填位置参数** —— 无参调用抛 `TypeError`、被 `except` 吞掉，于是这个函数**恒返回 `{}`**。
旧仓自己的注释记着这件事（2026-08-10 实测），并点出它为什么难查：
**返回 `{}` 正好等于「没设覆写」，整条链看上去完全正常。**

本仓没有那条延迟 import，覆写是一个注入点（`processTipRegistry.overrides`）。
变异 `tip-override-can-tighten-the-envelope` 钉着它。

### 0.3 `TipForgeSelfCheck` 的 fail-open **比盘点说的还要直白**

盘点说的是「依赖缺席 → `except → ok=None` → 只进 warnings → 打出 ✅」。
我把旧仓跑了一遍（`skill_traces.json` 的 `TipForgeSelfCheck/ok`，真旧仓、真注册表）：
**那一趟一个 `except` 都没触发**，而 `ready` 仍然是 `true`，摘要第一行就是 **`✅ 可以开工`** ——
因为「衬底可解析」那一条 `ok=False` 是 **`blocking=False`** 写的。

也就是说通往假许可有**两条**路：**依赖缺席（`None`）**与**「失败但不阻塞」（`False, blocking=False`）**。
分派单要我改的是前者；后者照移（它是旧仓刻意的分级）。**两条都写进了代码抬头**，
因为下一个读代码的人只会看见自己撞上的那一条。

### 0.4 三个导出在旧仓**零消费方**（我 grep 过整个 `MASTv2`）

`FIELD_OWNERS` · `envelope_of` · `policy_summary`，外加 `ResolvedConditioning.warnings`
（**没有一处写入、也没有一处读出**）。去留逐条写在 deviation 里：
`warnings` 与 `policy_summary` **不移**，另两个移了但各自有了本仓的第一个读者
（导出器的行标题 / 自检印包络）。

---

## 1. 这道闸现在长什么样

```
模型给的参数
   │
   ├─ K1 SI 解析 ─ K2 中止闩 ─ K3 样品闸 ─ K5 快照
   │
   ├─ **K6 参数校验** ──→ skill.validateParams()
   │                        └─ applyTipPolicy(params, 方案表字段, 改名表)
   │                             └─ resolveConditioning()
   │                                  ├─ 逐字段走链：explicit > 覆写 > 方案表 > 通用默认
   │                                  └─ checkEnvelope()：**超上限拒绝、不夹紧**
   │                                       ①|V| > max_abs_pulse_v  ②|depth| > max_poke_depth_m
   │                                       ③ count > max_pulse_count
   │
   └─ K7 荒谬 → 包络 → 模式 → 硬闸（全局 ±10 V 在这里，按参数名子串）
```

**四个接入点**：`TipPulse` / `BiasPulseWithReadback` / `TipShapeWithReadback` 的
`validateParams`（K6），`TipShape` 的 `execute` 最前面（**照旧仓**——它的两个策略字段要先经过
「方案表填不填」才知道最终值，而 `validateParams` 拿不到那一步的结果；代价登记了）。

**夹紧会把一次「这支针尖不能这么打」悄悄变成一次「按你能承受的最大值打」——
而调用方看到的是成功。** 这句话在三处代码抬头里各写了一遍，因为它是这一批的全部理由。

---

## 2. 金样怎么来的

### 2.1 第五台专用驱动器：`tools/spec-export/export_tip_policy.py`

    <MAST_ROOT>\.venv-v2-py313\Scripts\python.exe tools\spec-export\export_tip_policy.py

**通用轨迹金样一格都照不到这里**：它直调 `skill.execute(...)`，`validate_params` 一次都没被
调用（D-TIP-1 当初就写着「金样照不出这一条」）。而这一批的判据**全部**住在那一层。

形状照 `export_scan_resolver.py`：**输入网格**，无时钟、无随机数、无状态。
12 支针尖（未登记 / 钨三档 / 铂铱两档 / 磁性 / 超导 / 认不出的材料 / qPlus 三档）
× 22 个请求 = **264 格**，其中 **111 格被拒**。

> **2026-09-19 订正**（`docs/handoff/fix-pyfixed.md`）：请求表后来加了第 23 个
> `shaper_depth_at_limit`（深度正好等于上限），全表现在是 **12 × 23 = 276 格**，
> 被拒数不变仍是 **111**。本节其余数字是批 5a 当时的实况，不改。

每格记：`params` · `trace`（每个值哪一级给的）· `refusals` 逐字 · `ok` · `human_trace` · `notes`。
外加 `tips` 那一半：每支针尖**整档方案 + 来源 + 说明 + 包络**（表本身就是判据）。

**两次导出逐字节相同**（实测 `Get-FileHash` 相同）。`skill_traces.json` 重跑之后：
新增 4 个技能，已有 394 个 **0 处改变**。

### 2.2 网格里几格值得单独看

| 格 | 它回答的问题 |
|---|---|
| `*/pulse_10v` vs `*/pulse_10v001` | 边界是 `>` 不是 `>=`：方案表自己那一档的 10 V **放行**（2026-08-10 现场定的就是 10 V/500 ms），差一点点就拒 |
| `*/pulse_neg12v` | 按**绝对值**判 —— 一发 −12 V 与 +12 V 一样会改造针尖 |
| `qplus_*/count_3` | 全表唯一还在分辨针尖的包络字段（2 vs 5） |
| `*/zero_pulse` | `0` 是一个**真实的值**（D-ZERO-1）：显式 0 被采纳，不当「没给」 |
| `*/str_pulse` | 一个**非数值**的显式值会绕过包络（旧仓行为，照录 —— 见 §5.3） |
| `*/override_bad` | 坏覆写**被忽略**，不是变成 0（`Number([])` 是 0，而 Python `float([])` 是抛的） |
| `w_etched/defaults` | 逐级回退真的在回退：`(*,*,wire)` → `(W,*,wire)` → `(W,etched,wire)` |

### 2.3 `skill_traces.json` 里新增的 16 格

`TipShape` 7 格 · `TipPulse` 3 格 · 两个自检各 3 格。两个自检的 `data`/`summary`
**逐格登记成 deviation**（`traces.test.ts` 的 `selfCheckDev`），而 `missing_skills`
**从 `IMPLEMENTED` 算**、不抄一份 —— 后面几批每移一个技能它就变，抄下来的会静静过期。

为此给 `Deviation` 加了一个 `summary` 字段（与已有的 `error` 同一条规矩，包括
「旧仓那一侧也钉住」）。**两个自检的 `summary` 就是它们的结论**（「✅/❌」），
那句话正是这一批要改的东西，所以它必须**被比**，不能被豁免。

---

## 3. 变异清单（**23** 条，全部实跑到 red）

    node tools/mutate/run.ts tip-envelope-compares-absolute-value …

| id | 挡的是什么 | 变红 |
|---|---|---|
| `tip-envelope-compares-absolute-value` | 一发 −12 V 与 +12 V 一样会改造针尖；只比有符号大小 ⇒ **负半轴整个没有上限** | 25 |
| `tip-envelope-boundary-is-exclusive` | 上限是「不许超」不是「不许到」；`>=` ⇒ 方案表自己那一档的 10 V 被自己的包络拒掉 | 17 |
| `tip-depth-envelope-compares-absolute-value` | 下压深度是**负数**；只比有符号大小 ⇒ 扎针深度包络**整个失效**，而「2 nm 以内」正是它在执行 | 25 |
| `tip-count-limit-is-the-tips-not-the-specs` | 拿声明上限（50）当包络 ⇒ qPlus 上一口气 50 发 | 44 |
| `tip-unregistered-is-not-fail-open` | 把旧仓那句假注释（「未登记不拒绝任何东西」）变成真的 | 8 |
| `tip-explicit-zero-is-a-real-value` | D-ZERO-1 第六次：显式 `0` 被当成「没给」，方案表填一个真会改造针尖的默认值进去 | 12 |
| `tip-policy-chain-is-coarse-to-fine` | 查表倒过来 ⇒ 「这一维不区分」压掉精确档 | 208 |
| `tip-override-can-tighten-the-envelope` | 覆写永远落空，而宿主以为自己把包络收紧了（= 旧仓那个恒 `{}` 的洞） | 41 |
| `tip-registry-normalizes-at-the-door` | 一行「钨/电化学腐蚀/音叉」**静默落到通用档**（发数上限 5 而不是 2） | 2 |
| `tip-human-trace-prints-python-repr` | 整数性由**字段表**给、浮点走 Python `repr`；换一下 ⇒ `1.0` / `3` / `0` 三种全错 | 257 |
| `tippulse-envelope-is-checked-before-hardware` | **D-TIP-1 的正身**：包络在 K6 ⇒ 硬件之前拦住 | 2 |
| `tippulse-refuses-before-planning` | 「出厂默认落在自己包络之外」那条路（旧仓真出过） | 1 |
| `tippulse-counts-the-pulses` | 说打 3 发就打 3 发 —— 下一步的 Z 台阶判定建立在这个数上 | 5 |
| `tippulse-holds-z-during-the-pulse` | `z_hold=0` ⇒ 反馈追着暴冲的电流把 Z 一路压向表面 | 1 |
| `tippulse-original-bias-unknown-is-not-zero` | 读不到 ≠ 零 ≠ 否 | 4 |
| `tipshape-refuses-before-any-call` | 被拒的那一趟**一条命令都不许发出去** | 1 |
| `tipshape-bias-is-the-imaging-bias-not-3v` | 「shaper 应该自带 bias 变成扫图 bias，而不是锁死 3V」 | 10 |
| `tipshape-policy-wins-over-reading` | 方案表那一档（钨 4.0 / 铂铱 2.5）在这条路上成为死代码 | 1 |
| `selfcheck-missing-dependency-blocks` | **这一批的正身**：依赖缺席回到 `ok=None` ⇒ 一个什么都没验的自检打出「✅ 可以开工」 | 8 |
| `selfcheck-skill-coverage-blocks` | 缺 9 个技能照样说可以开工 | 6 |
| `selfcheck-dry-run-needs-a-counterexample` | 判据干跑只留正例 ⇒ 一个恒 `passed=true` 的坏判据照样「自测通过」 | 4 |
| `selfcheck-envelope-item-really-resolves` | 「0.3 nm 浅扎在包络内」变成一句祝福 | 1 |
| `readback-tip-envelope-is-wired` | D-TIP-1 当初的落点回到「只有全局 ±10 V 在挡」 | 1 |

### 3.1 「一条编不过的变异，那道闸就永远验不到」—— 撞了**两次**，第十九、二十次

两次都是 **TS6133（某个绑定没人读了）**，也就是分派单点名的第一种形状。修法各不同：

| # | 变异 | 为什么编不过 | 修法 |
|---|---|---|---|
| 十九 | `tip-human-trace-prints-python-repr` | 打在 `return pyFloatRepr(v)` → `String(v)` 上 ⇒ `pyFloatRepr` 从此没人读 | **换一条等效的**：把 int / float 两条分支**对调**。同一道闸拆得一样干净，而两个绑定都还有人读 |
| 二十 | `selfcheck-dry-run-needs-a-counterexample` | 把 `syntheticNoise(128)` 整个换成 `syntheticLattice(...)` ⇒ 反例那个函数没人读 | **留一个读**：`syntheticLattice(syntheticNoise(128).rows, nmPerPx)` |

### 3.2 还撞了一次**别的**：一条打在死路上的变异（green，不是 inconclusive）

`tipshape-bias-has-no-3v-fallback` 第一版打在 `biasV = read.v` → `read.v ?? 3.0` 上，
**跑出来是绿的**。原因不是没人看着这道闸，而是**那一行在 `if (read.v === null) return fail(...)`
之后 —— 读不到的时候根本走不到它**。

这个形状以前没记过，值得单列：**前二十次是「变异编不过」，这一次是「变异改了一行永远
执行不到的代码」**。两者在报告里长得不一样（`inconclusive` vs `green`），而
「绿」比「编不过」更危险：它读起来像「这道闸没人看着」，于是下一步会有人去**加一条测试**
来「补上」——补的是一条永远不会失败的测试。

修法：改打在**值从哪来**上（`const read = { ...(await shaperBiasDefault(ctx)), v: 3.0 }`）
—— 那正是 2026-08-10 那次真机故障的形状（设了 20 mV，回包 `bias_v: 3.0`）。改完 10 条变红。

---

## 4. 没做完的，逐条（差哪个函数、多少行）

### 4.1 `composite/_tip_phases.py` —— **2801 行 / 1664 代码行，六个技能，不在这一批**

`PrepareNobleTip` · `PokeConditionTip` · `PulseConditionTip` · `MakeAtomicResolutionTip` ·
`MakeSpectroscopyTip` · `ForgeAuTip`。分派单就是这么划的，我核过它还欠什么：

| 欠的 | 在哪 | 规模 |
|---|---|---|
| `AssessClusterRoundness` 的循环判据 | `vision/roundness`(359) + 技能本体 | `poke_phase` 每扎一次要它判成没成；判据缺席时它只会扎满 `max_rounds` 报 `not_refined` —— **一个只会消耗针尖、永远不会成功的流程** |
| `core/noble_tip_workflow.py` | **1273 行** | 这一批只取了**两个数**（`pulse_v = 10.0` / `critical_step_pm = 50.0`），跟着唯一的消费方（自检）走，出处写在数字旁边 |
| `core/special_tip_workflow.py` | **410 行** | 同上，取了**三个数**（`poke_depth_nm = 0.3` / `eval_frame_nm = 5.0` / `eval_pixels = 256`） |
| `reconcile_with_tip_envelope` | `noble_tip_workflow` 内 | 「出厂默认与包络对账」那一条。本仓 `TipPulse.execute` 里那一道判（`tippulse-refuses-before-planning`）是它的**下位替代**：对不上就失败，而不是报告 |

### 4.2 两个自检里**还没接上的**四块（都已在自检里报成 blocking，不是静默缺席）

| 检查项 | 差什么 | 行数 | 落在哪一批 |
|---|---|---|---|
| 扫描地图可读 / 避让半径 | `core/map_scope`(322) + `io/exp_map`(1015) + `io/coarse_map`(604) | ≈1941 | C 档，未分批 |
| Z 噪声底 / 临界步进可分辨 | `core/instrument_profile`(1237) 的 `z_noise_floor_m` 一个键 | 1237（整文件） | **批 5c** |
| 衬底可解析 / 有肖克利表面态 | `core/sample_facts`(241) + `knowledge/lookups`(579) | ≈820 | C 档 |
| 表面态判据自测 | `vision/spectroscopy`(954) 的 `assess_shockley_onset` + `broadening_floor_v` | ≈954 | C 档 |

### 4.3 `TipForgeSelfCheck` 的「评估帧能分辨原子」**落了，但绕开了 `plan_scale`**

`ATOMIC_TIP.scale_problem()` → `vision/atomic_phase.plan_scale`(约 30 行) +
`min_pixels_for_scale`(约 10 行)。本仓 `scaleGate` **已经在** `packages/host/vision/src/atomic-phase.ts`，
所以这一项直接消费 `scaleGate`，没有第二份 0.02/0.05。

⚠️ **代价**：`plan_scale` 的 `reduced` / `off` 两支措辞（「这个视野要 N px 以上」）没有移。
常数是固定的一对（5 nm / 256 px ⇒ `full`），那两支今天到不了；等哪天帧参数可配了，
要连 `min_pixels_for_scale` 一起补。**`packages/host/vision/` 这一轮有别的支线在动，我没碰。**

### 4.4 `tip_state.py` 的渲染层（约 200 行）

`format_tip_block` + `_service_days` / `_fmt_hz` / `_bias_polarity_line` / `_preamp_line` /
`_MATERIAL_NOTES` / `_FAB_NOTES` / `_QPLUS_POKE_NOTE` / `auto_name` / `*_candidates` / `*_LABELS`。
消费方是**提示块的针尖段**（要 `instrument_profile` 的偏压极性与前置放大器两个字段 → 批 5c）
与 **`register_tip` 工具**（要那张 SQLite 表）。

⚠️ 接提示块时注意 `_QPLUS_POKE_NOTE`：它 2026-08-17 被推翻重写过一次
（旧文案「qPlus 不能扎针、默认拒绝」两处都不成立，而且造成了真实伤害）。
**要接的是改过之后那一版。**

### 4.5 `module_down_hint` / `_preflight.py`(591)

`TipShape` 的两条错误路径上少一句「去 Nanonis 里打开 Tip Shaper 模块」。
跟着 `TipShapeWithReadback`（批 3j）走 —— 两个下发同一串命令的技能不该一个有一个没有。
整条 `_preflight`（探针表 + `_DOWN_SIGNATURES` + `_AMBIGUOUS` + `preflight_modules`）留给批 5c。

### 4.6 **这一批解锁了什么**（顺手核的，给下一轮分派）

| 技能 | 之前卡在 | 现在还差 |
|---|---|---|
| `ConditionTip`（composite.condition_tip，500 行） | `AssessImageQuality` + `TipPulse` + `tip_crash_tracker` | **只差 `AssessImageQuality`**（批 4d 落了 tracker，这一批落了 TipPulse）。盘点 §3.1 核过它**一条 scipy 都不欠**：`vision/atomic_phase` 三个函数(43 行) + `data/quality.py` 三个函数(102 行) |
| `clean_tip`（1） | `TipShape` + `MeasureBarrierHeight` | **只差 `MeasureBarrierHeight`**（它卡 STS 四件套） |
| `coarse_step_calib`（1） | `ScanAt` + `TipShape` + 两件数值 | **只差** K2 的 `noise_floor`(19 行) + Hann 窗/峰锐度(约 15 行) |
| `ShapeTipOnSurface` | 扎针深度包络 + 畴/平区/团簇判据 | **包络这一半到位了**（`poke_shallow_depth_m` / `poke_deep_depth_m` 就在这一批的判据里）；仍差 `vision` 的 roundness/flat_region 一族 |

---

## 5. 移植时照出来的旧仓瑕疵（**不改行为，只记账**）

### 5.1 `TipConditioningSelfCheck` 那句「10 V 大修脉冲会被拒」是假的

写它的时候通用档是 6.0 V，今天是 10.0 V ⇒ `abs(10) > 10` 为假 ⇒ **不会被拒**。
本仓这一句**不写断言，写实测**：拿同一台解析器真判一次，并把当前包络三个数印出来。
下次有人改包络，这句话自己跟着变。

### 5.2 `resolve_conditioning` 模块 docstring 里那段「未登记 = fail-open」

旧仓 2026-08-10 自己更正过（正文里留着更正），但同一份文档里那句「代价是具体的：
`NobleTipWorkflow.pulse_v` 出厂 10 V > 通用档的 6 V」**今天也过期了**（通用档已是 10 V）。
两处都照移到本仓抬头时改成了今天成立的说法，并把「为什么它曾经成立」留着。

### 5.3 一个**非数值**的显式值会绕过包络

`resolve_conditioning` 把 `pulse_v="abc"` 当成「调用方给了值」（`str(given).strip() != ""`），
而 `_check_envelope` 的 `_num("abc")` 是 `None` ⇒ **这一格不判**。金样 `*/str_pulse` 录着它。

本仓照移，因为**在本仓它到不了**：K1 的 SI 解析先于 K6，一个非数值的量纲参数在那里就被拒了
（而旧仓会把 `"abc"` 一路传给 `BiasPulse`）。**这是一条「旧仓的洞被本仓上游堵住」的记录**，
不是一条我们也有的洞 —— 但如果哪天有人把某个字段从量纲参数改成自由文本，它会回来。

---

## 6. 值得进课时的几件

1. **一条打在死路上的变异会「绿」，而绿比编不过更危险**（§3.2）。前二十次撞的都是
   「编不过」，这一次是「变异改了一行永远执行不到的代码」。判读规则：
   **一条变异变绿时，先问「它改的那一行跑得到吗」，再问「谁该看着这道闸」。**
2. **「修好之后旧理由会静静变成假话」**（§0.1 / §5.1）。这一批里同一句话有三份副本
   （D-TIP-1 原文、技能抬头注释、自检报给模型的那句话），而它在 2026-08-12 就不成立了。
   修法不是把三份都改对，是**让那句话由判据算出来**：自检现在拿解析器真判一次再说话。
3. **fail-open 有两种长相**（§0.3）：「判不了 ⇒ 不阻塞」与「判了、不合格、但不阻塞」。
   盘点抓到了第一种，而旧仓那一趟真正打出「✅ 可以开工」靠的是第二种。
   **看一个自检是不是空壳，要看 `ready` 怎么算出来的，不是看有几个 ❌。**
4. **一个从上线起就恒返回空的读取函数**（§0.2）：`SettingsStore()` 缺参 → `TypeError` →
   被 `except` 吞掉 → `{}` → 而 `{}` 正好等于「没设」。**降级值与真实值在语义上重合时，
   这条链的失败是不可观测的。** 本仓把它变成注入点，宿主接没接是**看得见**的。
5. **包络字段「拉满」之后，一道闸还剩多少**（§0.1）：三个字段里两个被拉平，
   而这道闸仍然在挡（声明上限 50 vs 包络 5）。**判断一道闸还有没有用，要看它与它
   上下游那几道闸的差集，不是看它自己的数好不好看。**

---

## 7. 共享文件我动了哪些

**只走锚点的**（按分派单）：

* `packages/host/kernel/src/index.ts` —— 批 5a 锚点 → 三个 `export *`
* `packages/host/stm-skills/src/l0/index.ts` —— 批 5a 三处锚点（import / 展开 / re-export）
* `scripts/gen-skill-specs.ts` 的 `BATCH_5A`
* `tools/spec-export/export_skill_traces.py` 的 `BATCH_5A`
* `tools/mutate/mutations.ts` 的批 5a 锚点（23 条）
* `spec/deviations.md` 的批 5a 注释锚点（**编号一律留空**）

**锚点之外动过的**（各有理由，都请过一眼）：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `l0/traces.test.ts` | ① `Deviation` 加 `summary` 字段 + 比对分支；② `selfCheckDev` / `shaperItem` / 4 条 `MISSING_*` 常量 + 6 格自检登记 + `TipShape/empty@0`；③ `resetProcessState` 里清针尖 holder | 新技能进通用轨迹金样就得登记差异；那个文件没有锚点（批 4d 同样动过） |
| `l0/readback-skills.ts` | `BiasPulseWithReadback` 加 `validateParams`（D-TIP-1 结清）+ 抬头欠账改成结清；`TipShapeWithReadback` 加 `validateParams`（**本仓新增**，已登记） | 这一批的正身 |
| `l0/tip-policy.ts` | 加 `applyTipPolicy` / `policyFieldsForResult` + 抬头那张表从「❌ 欠着」改成「✅ 还上了」 | 它就是旧仓 `_tip_policy.py` 的落点 |
| `spec/golden/README.md` | 「专用驱动器」表加一行 | 新增一份金样 |
| `spec/golden/skill_traces.json` · `spec/progress.json` · `generated/specs.ts` | 重跑生成 | 生成物，**不要手工解冲突** |

`packages/host/vision/` 与 `packages/host/numerics/` **一个字节都没碰**（只 import 了
`assessAtomicPhase` / `scaleGate` / `Xoshiro128` / `matOf`）。

---

## 8. 怎么自己验一遍

```
pnpm build
npx vitest run --project '!integration'                       # 91 文件 / 5232 条
STMSIM_PYTHON=… STMSIM_ROOT=… npx vitest run --project integration   # 13 文件 / 68 条
node tools/mutate/run.ts tip-envelope-compares-absolute-value …     # 23 条，全 red
D:\…\python.exe tools\spec-export\export_tip_policy.py        # 两次逐字节相同
node scripts/gen-skill-specs.ts && node scripts/build-progress.ts
```

**本段术语表**：*安全包络* = 按当前登记针尖查出来的一组上限（超了拒绝，不夹紧）；
*方案表* = `(材料 × 制备 × 形态)` → 一档参数，逐级回退；*来源痕迹* = 每个数字是
调用方给的、覆写给的、方案表给的还是通用默认；*fail-open* = 判不了就放行
（本批把自检里的那一种改成了 fail-closed）。
