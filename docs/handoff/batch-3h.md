# 批 3h 交接 —— 输出 / 扫频 / 图样 / 函数发生器 / 谱学同步 / 高级操作

**48 个技能，5 个模块收口**（`user_output` 14 · `sweep` 11 · `function_generator` 6 ·
`spectroscopy_sync` 6 · `advanced_ops` 5 · `pattern` **6/7**）。

新文件：`l0/user-output.ts` · `l0/sweep.ts` · `l0/pattern.ts` · `l0/waveform.ts` ·
`l0/spectroscopy-sync.ts` · `l0/advanced-ops.ts` · `l0/tail-l0h.test.ts` ·
`tools/spec-export/export_advanced_ops.py` · `spec/golden/advanced_ops.json`

---

## 一、该登记成 deviation 的（**主线已编号并登记进 `spec/deviations.md`**）

### D-DIAG-1（补充）· `diagnostics.record` → `ctx.markers.emit`

| | |
|---|---|
| **Python** | `user_output` / `advanced_ops` 六处 `record("note", subject, reason, **fields)` |
| **TS** | `ctx.markers.emit('note', {subject, reason, ...fields})`，`kind` 与字段名逐字照搬 |
| **测试** | `tail-l0h.test.ts` → `SetUserOutputLimits —— 放宽合法，但要留痕`、`停扫失败不拦着退针，只留一条痕` |

**这条已经在批 3f 登记为 D-DIAG-1**，这里只是又一批用例。建议并进那一条而不是新开。

### D-SKILL-1 补充四 · `_rv` / `decode_reply` 在空 body 上交出整个信封

八格，逐格登记在 `traces.test.ts` 的 `DEVIATIONS` 里：

```
GenSwpAcqChsGet / GenSwpPropsGet / GenSwpSwpSignalGet /
GetLockInSweepLimits / GetLockInSweepProps /
GetPatternCloud / GetPatternProps / WaitForScanEndBlocking   （均为 empty@0）
```

旧仓的 `raw:` / `result:` 兜底拿到的是 `["", "<bytes 0>", []]`；本仓信封在 wire 层
就没了，手上只有 `[]`。**建议并进 D-SKILL-1 作为「补充四」**。

### D-LANG（一族的第三次，未单列号）· `str(int)` 与 `str(float)` 的分岔

| | |
|---|---|
| **Python** | `f"收到 {lines}"`，`lines` 是 `[int(x) …]` ⇒ `[1, 9]` |
| **TS（错的那版）** | 用 `pyStr` 渲染 ⇒ `[1.0, 9.0]` |
| **TS（现在）** | `pyIntList` 按整数印，`pyFloatList` 按浮点印 —— **两个渲染器，因为源头是两种类型** |
| **测试** | `tail-l0h.test.ts` → `digital line 必须在 1..8 之间，收到 [1, 9]` |

这是 `pyStr` 那一族的第三次（前两次：`pyFloatRepr`、`formatG`）。
**它是被金样照出来的**，不是读代码读出来的 —— 我第一版就写错了。
这一条本身不是行为差异（修好之后两侧一致），但值得进课时：
**「同一个列表印出来不一样」这件事，只有逐字比对的金样抓得住。**

---

## 二、导出器上动的两处（合并时请留意）

1. **`_FakeContext` 加了 `check_abort()`**（返回 `False`）。
   `WaitForScanEndBlocking` 直接调它，缺了就抛 `AttributeError` —— 那是夹具的毛病，
   不是技能的判据。**已验证：加之前/之后，已有技能的金样 0 处改变。**

2. **`PARAM_OVERRIDES` / `EXTRA_PARAMS` 各加了一批。** 原因统一是同一件事：
   **通用规则给的基准参数让 `ok` 那一趟落在拒绝上**，于是成功那一路一条金样都没有。
   四处：`SetUserOutput`（value 落在界外）· `PulseDigitalLine`（lines 解析不了）·
   `SetPatternCloud`（不是 JSON）· `SetSpectroscopyPulseSync`（两个开关都没给）。
   另外 `ConfigureBiasSweep` / `ConfigureLockInSweep` 的上下限被通用规则撞成同一个数。

---

## 三、没做的，与为什么

### `RunGridExperiment`（`builtins.pattern` 7 个里的 1 个）

**它是一个 GraphExecutor 组合技能**，不是机械薄壳：有 `_phase_*` 的阶段分发、
一个包装真 context 的 `_RunGridExperimentPhaseCtx`、`set_partial` 的中间状态、
以及一个流式计划。`builtins.pattern` 只是它待的文件位置。

代价说清楚：**`pattern` 模块因此停在 6/7，不收口。** 换来的是不在一个 48 技能批次的
末尾仓促移植一个组合件 —— 批 3b 单独用一整段做 `SetBiasRamp` 正是这个理由。
建议与 `composite.*` 那 31 个一起排进 Phase 5。

顺带一个与它有关的夹具数字：它的 `wait_timeout_s` 缺省 3600 s ÷ 2 s 一拍 = **1800 拍**，
录出来 **542 KB**（占当时整个金样文件的四分之一），而那 1800 拍是同一拍。
我给它加了 `wait_timeout_s: 10.0` 的 override（取声明下界，同
`WaitScanComplete` 的 `timeout_ms`）—— **那条 override 我在移除它时一并撤掉了**，
将来移植它的人需要重新加回去。

---

## 四、值得进课时的三件

### ① 同一句话，一次成立、一次不成立

`user_output` 的模块 docstring 里，操作员驳回了「一个能放宽自己护栏的智能体等于没有
护栏」这条通则：

> 「nanonis 自己的硬件输出很小的，我们在硬件接线的时候就会注意的。」

而批 3f 的 `instrument_limits`（Z 压电限值）把**同一条论证**驳回了：
没有任何接线能拦住压电把针尖撞进去。

**判据是「有没有物理层」。** 这不是两处不一致，是同一条判据在两种硬件上给出两个
答案 —— 而两边留下的东西因此一模一样：放宽合法、CONFIRM 闸、连同改前/改后与一个
`widened` 标志留痕。这一对可以并排讲。

### ② 两次单位陷阱，都是「错了不会报错」

| 哪一处 | 收的是 | 传错的后果 |
|---|---|---|
| `FunGen2Ch_PropsSet` | **周期（s）**，不是频率 | 一次 1 kHz 的请求被设成 1000 秒的周期 —— **差六个数量级，静悄悄地，在一台谁也看不见的硬件上** |
| `Scan_WaitEndOfScan` | **毫秒**，不是秒 | 短等 1000 倍，然后**在扫描刚开始的那一瞬间报告「扫描已结束」** |

共同点：**两者都不会报错**，只会安静地做另一件事。各有一条变异钉着。

### ③ 合法的 JSON 还不够

`SetPatternCloud` 收两串 JSON 数组，而 `"5"` **是合法 JSON** —— 解出来是整数 5，
随后 `len()` 抛 `TypeError`，那个异常**到不了 `SkillResult`**：
没有错误分支、没有重试，一个死掉的回合。

而模型写 `x_coords="5"` 表示「就一个点」（忘了那对方括号）不是异国情调的输入，
**它是最可能的那个错**。所以解完之后还要问一句「它是不是一个数组」。

（另：`AcquireBiasSweep` 一个技能上记着四次真机事故 —— 采集通道从来没被设上、
`PropsSet` 把刚配好的安定时间清零、扫描期间 Z 反馈没断开会把针尖压进表面、
取到的「曲线」其实是两个表头整数。四条都逐条移了，`Z-Ctrl=1` 那条有专门的变异。）

---

## 五、我加的变异演练（14 条，**已全部单独跑过，全红**）

```
userout-unreadable-limits-refuse        userout-honours-instrument-envelope
userout-widened-is-recorded             userout-digital-line-range
waveform-period-not-frequency           waitscan-slice-is-milliseconds
waitscan-unreadable-means-finished      quit-withdraw-is-not-optional
quit-verifies-against-rt-controller     pattern-cloud-json-must-be-a-list
spectroscopy-firstint-rejects-floats    sweep-rows-all-or-nothing
sweep-acquire-turns-z-feedback-off      sweep-fallback-matches-declaration
```

最后一条值得单说：`sweep-fallback-matches-declaration` 把 `BIAS_SWEEP_PERIOD_MS`
改回旧仓那个 `20.0`。旧仓的 `execute()` 兜底与 `ParameterSpec` 的 `default` 曾经
各写各的（20 vs 4、3 vs 1），而组合路径上参数**不经过注册表回填** ——
于是省略一个参数拿到的是 `execute` 里那个数，模型看到的广告是声明里那个数。
**广告与实际是两个积分时间。** 本仓把兜底写成同一个值，并让这条变异盯着它。
