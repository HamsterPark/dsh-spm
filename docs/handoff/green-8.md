# green-8 —— 510 条全量演练里那 8 条绿的，逐条

**2026-09-19。** 全量演练第一次跑出绿色：510 条里 **8 条 green**。
本仓的纪律是「一条变异跑出绿色，说的不是这个变异不重要，是**这条闸不存在**」。

这一支做了两件事：**把那 8 道闸补上输入**（§2，8/8 实跑到 red），
以及**查清楚批 5b / 5c 为什么都报了「全部实跑到 red」**（§3）。

§3 比 §2 值钱：那 8 条测试补的是 8 道闸，而 §3 说的是**验收流程本身漏了什么**。

---

## 0. 一句话

> 八条绿分三种形状：**五条是闸只有一侧有输入**、**两条是断言把自己抵消了**、
> **一条是那道闸根本不可达**。
> 而它们在两条支线上都被报成 red，原因是同一个：`run.ts` 的判据是
> `failed > 0`，而那两棵树上各有 **2 条 / 3 条与变异无关的常红**，
> 于是**每一条变异都继承了它**。两份交接里的「变红」一列，整列偏高 2（5b）与 3（5c）。

---

## 1. 现场（可复跑）

```
pnpm install --frozen-lockfile && pnpm build
node tools/mutate/run.ts \
  current-field-emission-threshold-is-three fft-onesided-skips-dc-and-nyquist \
  classify-biases-descend-by-magnitude psd-ignored-list-is-reported \
  batch-first-error-wins zsettle-window-of-one \
  relocate-prove-clear-accepts-a-live-junction relocate-panic-failure-is-still-a-success
```

| | 改之前 | 改之后 |
|---|---|---|
| 这 8 条 | **0/8 变红**（八条全 green，一条 inconclusive 都没有 —— 变异都落地了、都编得过、测试都真跑了） | **8/8 变红** |
| 全仓 `--project '!integration'` | 101 文件 / 5753 条全绿 | 101 文件 / **5761 条**全绿（+8） |
| `pnpm build` | 过 | 过 |

**生产代码只动了一处，而且是纯注释**（`relocate-coarse-xy.ts` 里标出那一支不可达，
见 §2.8）。其余全部落在测试文件与 `tools/mutate/mutations.ts` 上。

---

## 2. 八道闸，逐条

### 2.1 `current-field-emission-threshold-is-three`（`kernel/src/current-diag.ts`）

拆的是 `N_FIELD_EMISSION = 3.0 → 2.0`：判「场发射」的等效指数线。

| | |
|---|---|
| **原来被什么挡住** | 判别表六个结论的金样**一格都不落在 2 与 3 之间**。`classify/junction_current` 录的是 n = 1.0，`classify/field_emission` 是 n = 9.7；唯一一个 n = 2.0 的 `classify/mixed`，它的 0 V 是**脏**的 —— 于是它在指数那一档**之前**就被「0 V 有本底」那一支接走了。线两侧各有格，**线附近一格没有** |
| **补的那一格** | `current-diag.test.ts`：`classifyCurrentOrigin(1e-14, 2.5, 3e-10)` 必须判 `junction_current`（真实隧穿结在 1–2 V 上本来就超线性）；`3.0` 恰好在线上必须判 `field_emission`（端点闭） |
| **一处刻意** | 两条断言都写**字面量** 2.5 / 3.0，**不引用 `N_FIELD_EMISSION`** —— 引用常量的断言会跟着常量一起动，那样问的就不再是「线在哪」而是「代码等于它自己」 |
| **现在红** | 1 条 |

### 2.2 `fft-onesided-skips-dc-and-nyquist`（`stm-skills/src/l0/current-monitor.ts`）

拆的是 `for (k = 1; k < psd.length - 1; …)` 的上界：单边 PSD **只把中间那些格乘 2**。

| | |
|---|---|
| **原来被什么挡住** | **不是没输入，是容差按定义看不见它**。金样 `monitor_fft/power` 的 Nyquist 那一格是 4.18e−39，而 `spectrum` 的容差**按整幅谱的最大值归一**（FFT 的误差本底与整幅谱挂钩，那条推导是对的）。把那一格乘 2，差额远在容差以下 —— 这不是容差写松了，是**这种容差对小格没有分辨力** |
| **补的那一格** | `batch5b-edges.test.ts`：给一个**脉冲**（第一拍 1 A，其余 0；`window: 'rect'`、`detrend: false`、`duration_s: 0.017` ⇒ **16 个样本**，偶数，于是最后一格**真的是** Nyquist）。脉冲的谱每一格模长都是 1，两端与中间同量级，折不折一眼看得出 |
| **判据两条** | ① 逐格 `psd[k] === mag[k]² · scale · (两端 1 / 中间 2)`，与生产代码**同一串运算**，容差 **0**（`scale = 1/(fs·n)`，rect 窗的 Σw² = n 写得出闭式）；② **Parseval**：`Σpsd · df == mean(x²) = 1/16`。两端也乘 2 的话这个积分会多出 1/16 |
| **一处刻意** | `detrend: false` 是必需的 —— 减掉均值会把 DC 那一格打成 0，而 0 折不折都一样 |
| **现在红** | 1 条 |

### 2.3 `classify-biases-descend-by-magnitude`（`stm-skills/src/l0/current-origin.ts`）

拆的是 `biases.sort(…)`：按模长从大到小量，**结束时停在最小偏压上**。

| | |
|---|---|
| **原来被什么挡住** | `classify/*` 七格的 `test_biases_v` 全是 `'2,1,0.5,0'` / `'2,1,0'` —— **本来就是降序**，那次排序是个恒等变换 |
| **补的那一格** | `test_biases_v: '0.5,2.0,1.0'`（乱序）⇒ `data.points` 必须是 `[2, 1, 0.5, 0]`，实际下发的 `SetBias` 序列必须是 `[2, 1, 0.5, 0, 1]` |
| **判据是什么** | 是**针尖真的依次经历了哪几个偏压**（以及最后停在哪一个上），不是「调了几次」。收尾那一次 1.0 V 是还原进来时的工作点，不属于扫描序列 |
| **现在红** | 1 条 |

### 2.4 `psd-ignored-list-is-reported`（`stm-skills/src/l0/acquire-psd.ts`）

拆的是 `if (badList !== null) data['freq_range_indices_ignored'] = badList`（D-PSD-1）。

| | |
|---|---|
| **原来被什么挡住** | **输入一直在**（`psd/bad_indices_json`，`freq_range_indices: '0,2,5'`）。挡住它的是**断言的形状**：`batch5b.test.ts` 里写的是 `if ('freq_range_indices_ignored' in gotData) { … }` —— **条件与被测的东西是同一件事**。字段不报了，整块断言跟着一起消失；而金样里本来就没有这一格，`toEqual` 那边也没话说。那段注释还写着「差异消失时这条会当场变红」——**它不会** |
| **补的那一格** | 期望值改由**用例名**给：`const PSD_IGNORED = { 'psd/bad_indices_json': '0,2,5' }`。在表里 = 这一格必须有且等于这个串；不在表里 = 这一格必须**不存在**（于是 `psd/multi_range_sweep` 那个合法列表不报这一格，也一起钉住了） |
| **同形先例** | 批 4b 的 `phase-detrend-output-is-float32`：「一个『是不是』的问题，用『差多少』永远问不出来」。这一条是它的近亲 —— **一个『报没报』的问题，不能写成『报了的话就检查一下』** |
| **现在红** | 1 条 |

### 2.5 `batch-first-error-wins`（`stm-skills/src/composite/batch-regions-scan.ts`）

拆的是 `if (rec.error === undefined) rec.error = …`：一个区域只记**第一条**出错原因。

| | |
|---|---|
| **原来被什么挡住** | `batch/every_region_refused` 里每个区域**只有一步失败**（`configure`）—— 先写赢与后写赢给出同一个答案 |
| **补的那一格** | 同一个区域**失败两次**：`ConfigureScan` 被安全闸拒（根因）+ `SaveScan` 报 `disk full`（后果）。`regions[0].error` 必须含 `configure:` 与那句安全闸原话，且**不许**出现 `disk full` |
| **现在红** | 1 条 |

### 2.6 `zsettle-window-of-one`（`stm-skills/src/composite/z-settle.ts`）

拆的是 `Math.max(3, …)`：收敛窗口的下限。

| | |
|---|---|
| **原来被什么挡住** | 生产路径上的窗口是 5（`RELOCATE_SETTLE_WINDOW_N`）或档案缺省 5 —— **没有任何一格传过 1 或 2**，于是那个下限从没做过一次决定 |
| **补的那一格** | 直接调 `settleAndReadZ(ctx, { windowN: 1 })` 两次：① Z 每读一次走 1 nm ⇒ 必须**不收敛**、`state === 'moving'`、净漂移 > 收敛带；② Z 站住 ⇒ 收敛，而 `samples === 3` |
| **为什么 `samples` 是判据而不是「调了几次」** | 窗口为 1 时净漂移 `\|w[last] − w[0]\|` **由构造恒等于 0**。这道闸的输出就是「这个结论建立在几个读数上」—— 一个读数的『净漂移 0』什么都没说 |
| **现在红** | 2 条 |

### 2.7 `relocate-prove-clear-accepts-a-live-junction`（`composite/relocate-coarse-xy.ts`）

拆的是 `Math.abs(current) > NOISE_FLOOR_A * 10` 那一支里的 `out['clear'] = false`。

| | |
|---|---|
| **原来被什么挡住** | 所有 relocate 用例里，**脱离确认那一读都是 5 pA** —— 在噪声底十倍线（10 pA）**以下**。`急停没能下发` 那一格给的 50 pA 落在**第 17 次**读（第一块横移之后），走的是移动中的电流看护，不是脱离确认 |
| **补的那一格** | 把 **第 16 次** `Current_Get`（= 脱离确认那一读）给成 50 pA：越十倍线，而远低于清障梯子自己的电流跳闸（1 nA）—— 于是跳闸的只可能是脱离确认这一条 |
| **判据是什么** | **台子有没有动**：清障走的是 z−（方向码 5），横移是 x+（方向码 0）。判成「已脱离」的下一步就是带着一个活的隧道结横向滑台子。断言 `Motor_StartMove` 只出现方向码 5、`lateral_steps_taken === 0`，外加拒绝的原话 |
| **现在红** | 1 条 |

### 2.8 `relocate-panic-failure-is-still-a-success` —— **这一条不是缺输入，是那道闸不可达**

原来打的是 `if (panicNote !== '') {`。**任何输入都走不到它**，于是它无论怎么拆，
输出一个字都不变。结构上的理由，三步（都可以 grep 核）：

1. `#panicFailures` 只在 `#panic()` 里被 push（`relocate-coarse-xy.ts:761` 与 `:765`，
   全文就这两处）；
2. `#panic()` 的 **10 个调用点**（395 / 426 / 445 / 461 / 479 / 494 / 587 / 601 / 615 / 628）
   **每一个**紧接着就 `return { success: false, … }` ——
   `grep -n -A 3 "await this\.#panic()"` 一眼看完；
3. 发得出 panic 的两个相（`clear` / `move`）在 `#plan()` 里都是 `optional: false`，
   而 `GraphExecutor.#handleFailure` 对非可选步骤的失败一律 `#abort` ⇒
   `runPlan` 返回 `false`。

⇒ `panicNote !== ''` **蕴含** `allGood === false`，于是永远在上一支就返回了。
（`Relocate` 没有传 `onStepFailed`，唯一 `optional: true` 的 `verify` 相又从不 panic，
两条「放行」路都关着。）

**做法**（同批 4b 的 `lattice-angles-are-python-modulo`：「打错了行 ⇒ 改打在真正做决定的那一行上」）：

| | |
|---|---|
| **变异改打在** | 上一支的 `error: (p.abortedReason \|\| '…') + panicNote` —— 拆掉它，一次「横移中电流跳闸」只会说「检测到电流……已撤针」，而**急停根本没发出去**这件事一个字都不提，读的人会以为针尖已经退开了。那正是这一条要防的事 |
| **谁在验** | 现成那格 `急停**没能下发**时…`（它断言 `error` 含「紧急停止未能完整下发」「不要假设本技能已经把针尖收回去了」）。**它一直是对的**，只是它验的是这一行，不是原来那一支 |
| **另补一条** | 成功那条路上 `panic_failures` 必须是**空表**，不是一个缺席的键 —— 缺席的键与「都发出去了」在读的人那里长得一样 |
| **生产代码** | 只加了 8 行注释，标出那一支在当前计划下不可达、别把它当成一道在挡的闸。**零语义改动**（`tsc -b` 与全仓测试前后完全一致） |
| **现在红** | 1 条 |

> **没有删掉那一支**：它防的是「哪天有一个相变成 `optional`」，而那件事完全可能发生。
> 但在那之前它**没有任何输入能验** —— 所以按本仓的说法，那里现在是**一段没有闸的注释**。
> 要不要按消融精神删掉它，是一个单独的决定，不该塞进一次「把演练弄绿」的提交里。

---

## 3. 任务二：两条支线为什么都报了 red

### 3.1 先把三个「不是」排掉（都可核）

| 猜测 | 核法 | 结论 |
|---|---|---|
| 它们跑的不是这些 id | 把 `b4ea031` / `0880c94` 的 `mutations.ts` import 进来，逐个比 `[file, find, replace, scope]` | **一模一样**，八条全对得上 |
| 后来的重构把闸挪了 | `git diff 0880c94 HEAD --` 那三个 5c 文件 · `git diff b4ea031 HEAD --` 那五个 5b 文件 | **零 diff**。生产代码、测试、`vitest.config.ts`、`tools/mutate/run.ts` 全都逐字节没变 |
| 合并把测试删了 | 两边都只有**新增**（`mutations.ts` 只有 insert）；支线的测试文件集是合并树的**子集** | 测试只多不少 ⇒ 支线上失败只会**更少**，不可能「那时红现在绿」 |

### 3.2 真正的原因：**每一条变异都继承了一个与它无关的常数**

把几条**声称红**的变异在今天的树上重跑，和交接里那一列比：

| id | 交接写的 | 今天实测 | 差 |
|---|---|---|---|
| `poll-schedule-is-absolute`（5b） | 18 | 16 | **2** |
| `rfft-keeps-half-plus-one`（5b） | 11 | 9 | **2** |
| `fft-detrend-removes-the-mean`（5b） | 10 | 8 | **2** |
| `watch-rows-are-centred-per-row`（5b） | 12 | 10 | **2** |
| `batch-assess-step-is-opt-in`（5b） | 8 | 6 | **2** |
| `psd-top-level-is-the-first-range`（5b） | 3 | 1 | **2** |
| `current-median-of-nothing-is-null`（5b） | 9 | 8 | 1 ※ |
| `coarse-undeclared-falls-back-to-a-number`（5c） | 16 | 13 | **3** |
| `profile-z-extend-sign-falls-back-to-factory`（5c） | 9 | 6 | **3** |
| `zsettle-no-displacement-fires-without-a-ruler`（5c） | 6 | 3 | **3** |
| `zsettle-not-moving-is-enough`（5c） | 4 | 1 | **3** |
| `relocate-move-current-trip-off`（5c） | 5 | 2 | **3** |

※ 今天的树是支线的**超集**，多出来的测试可以自己也红 —— 这一条就是多红了 1 条，
于是差从 2 变成 1。方向只会是这一边，不会反过来。

**偏移是常数：5b 是 2，5c 是 3。而那正好是两份交接里给那 8 条绿的数字**
—— 5b 表里那五个 `变红 = 2`、5c 表里那三个 `red = 3`，
**整张表里再没有别的格取到过这两个值**。

也就是说：那两棵树上各有 2 条 / 3 条**与变异无关的常红**。
`run.ts` 的判据是

```ts
verdict: failed > 0 ? 'red' : 'green'
```

于是**每一条变异都继承了它**，一律判 red；而那 8 条真正什么都没改的，
报出来的就是那个常数本身。

### 3.3 那几条常红是什么：复现出 2 条，第 3 条查不到

`packages/host` 里唯一一个会因为**树上别的东西没跟上**而常红的，是
`stm-skills/src/progress.test.ts` —— 它拿 `spec/progress.json` 和 `IMPLEMENTED` 对账。
把任一支线的 `spec/progress.json` 放回今天的树上跑一遍：

```
git show b4ea031:spec/progress.json > spec/progress.json   # 或 0880c94
node node_modules/vitest/vitest.mjs run --project '!integration' \
     packages/host/stm-skills/src/progress.test.ts
⇒ Tests  2 failed | 3 passed (5)
```

**恰好 2 条**：「与代码同步（跑一次生成器比对）」与
「每个 done 的技能都真的在 `IMPLEMENTED` 里」。也就是
**演练是在 `pnpm gen:progress` 之前跑的**，而 `progress.json` 那时还停在锚点上。
这和 5b 的常数 2 完全对上。

5c 的常数是 **3**，多出来的那一条**查不到**：支线尖端提交上的 `progress.json`
与它自己的注册表是自洽的（398 = 398），所以那条失败只存在于
「演练那一刻」的工作树里 —— 没有提交、没有日志，git 里追不到。
**不编一个说得通的原因**：就写查不到。

### 3.4 这决定了验收流程要改什么

1. **`run.ts` 必须先量基线**：不打任何变异跑一趟 `scope`。
   `failed > 0` ⇒ 整趟判 `inconclusive` 并**拒跑**，而不是让每条变异去继承它。
   —— 只改成 `failed > baseline` 不够：基线不为 0 时，连「这条变异自己红在哪」都不可信。
2. **判据三条要加第四条**。现在的三条是「变异落地 / 构建通过 / 测试确实跑了」，
   它们都在问「这一趟有没有跑起来」；缺的那一条是
   **「红的是**这条变异**吗」**。这次 8 条假红，全部死在这一条上。
3. **交接里那张表要连基线一起写**。一批里同一个最小值反复出现
   （5b 的五个 2、5c 的三个 3）就是这次的指纹 —— 它现在是一条可以自查的规则：
   **表里出现「多条变异红的条数完全相同、而且正好是全表最小值」，先去量基线。**
4. **演练之前先跑生成物**：`pnpm gen:progress`（以及任何 `gen:*`）。
   或者更好 —— 让 `run.ts` 把它并进基线那一趟，反正基线本来就要跑。
5. **「一次演练的有效期只到下一次重构为止」要补一句**：
   这次**不是**重构失效（两条支线的文件逐字节没变），是**跑的时候树上有别的东西没跟上**。
   有效期还受这一条限制，而这一条**不能靠人记得** —— 必须由工具自己排除（第 1 条）。

---

## 4. 归纳：绿有三种形状，修法各不相同

| 形状 | 这次哪几条 | 修法 |
|---|---|---|
| **闸只有一侧有输入**（覆盖率 100%，那几行跑到了，只是每次都给同一个答案） | §2.1 · §2.3 · §2.5 · §2.6 · §2.7（五条） | 造一格「两种候选各占一边」的输入 —— 同批 4b §5 ② |
| **断言的形状把自己抵消了** | §2.2（容差按整幅谱最大值归一 ⇒ 对小格没有分辨力）· §2.4（`if (key in got)` 的条件就是被测的东西） | 换问法：结构性断言 / 期望值由输入侧给，不由回包给 —— 同批 4b §5 ③ |
| **那道闸不可达** | §2.8（一条） | 先证明不可达，再把变异改打在真正做决定的那一行上 —— 同批 4b 的 `lattice-angles-are-python-modulo` |

> 三种形状都**不是**「金样少录了一次」。前两种是判据的**造型**问题，
> 第三种是代码的**结构**问题 —— 而覆盖率对三种都一言不发。
