# 批 7a-1 交接 —— `vision/tilt` 一族 + **四**个调平技能（任务书说两个）

> 支线分支 `worktree-agent-a9a9ce710656d59e7`，**未合并回 master**。
>
> 一句话：`builtins.frame_tilt`（1/1）· `builtins.tilt_probe`（1/1）·
> `composite.auto_tilt`（2/2）**三个模块一次收口**，
> 而任务书里那张缺件清单少了 **483 行**、四条依赖 —— 原因是
> **封锁账记的是一层，不是闭包**（§9 第一条）。

---

## 0. 一句话

调平这条链现在是完整的：**测**（`TiltProbeCircle`，恒流内接圆）→
**算**（`vision/tilt-circle.ts` 的正弦拟合 / `kernel/tilt-loop.ts` 的控制律）→
**设**（`AutoTilt` 的限步限幅小步）→ **复测 / 验收 / 回滚**；
外加一条只读的旁路（`AnalyzeFrameTilt`，从一张 `.sxm` 上量倾斜与台阶主导），
以及一次性的 `TiltCalibrate`（把「符号 + 轴交换 + 增益」解成 2×2 的 G）。

**封锁账少了两行**：`AutoTilt` 与 `AnalyzeFrameTilt` 从六条特异化流程的
`BLOCKED` 表里划掉了。`PrepareNobleTip` / `ForgeAuTip` 从 5 件降到 3 件，
`PokeConditionTip` 从 3 降到 2，`MakeSpectroscopyTip` 从 4 降到 3，
`MakeAtomicResolutionTip` 从 5 降到 4。

---

## 1. 落地的件

### 判据本体

| 件 | 旧仓 | 行 | 落在 | 备注 |
|---|---|---|---|---|
| `detrend_quadratic` | `vision/tilt.py` | 42 | `vision/src/tilt-frame.ts` | 项序逐字照移 `[x², y², xy, x, y, 1]`；**不与 `polySubtract(m,2)` 合并** |
| `structure_dominance` | 同上 | 28 | 同上 | 四条退路都有输入（见 §4.2） |
| `step_dominance_multiscale` | 同上 | 27 | 同上 | |
| `_segmentation_step_signal` | 同上 | 23 | 同上 | 做成**注入口**，缺省落在旧仓自己的 fail-open 上（D-TILT-1） |
| `assess_steps` | 同上 | 36 | 同上 | **任务书没点它** —— `estimate_tilt` 要 |
| `_rotate_slope` | 同上 | 13 | 同上 | 同上 |
| `estimate_tilt` | 同上 | 158 | 同上 | |
| `circle_tilt_resolution_deg` | 同上 | 16 | 同上 | |
| `z_span_for_frame` | 同上 | 36 | 同上 | |
| `CircleTilt` + 4 个 `CIRCLE_*` + `fit_circle_tilt` | 同上 | ~130 | `vision/src/tilt-circle.ts` | **任务书没点它** —— `TiltProbeCircle` 要 |
| `AutoTilt` 的判定核心 | `composite/auto_tilt.py` | ~60 | `kernel/src/tilt-loop.ts` | 三条阈 / 控制律 / 限步限幅 / 收敛 / 2×2 条件数 |
| `format_si_readable` | `core/si_quantity.py` | 30 | `kernel/src/si.ts` | **任务书没点它** —— `diverged` / `not_converged` 那两句话里印的就是它 |
| `set_tilt_calibration` 的拒写闸 | `core/instrument_profile.py` | 50 | `kernel/src/instrument-profile.ts` | **任务书没点它** —— `TiltCalibrate` 要；本仓此前只有读口 |

### 技能（4 个，模块 3 个全收口）

| 技能 | 旧仓 | 行 | 落在 |
|---|---|---|---|
| `AnalyzeFrameTilt` | `skills/builtins/frame_tilt.py` | 225 | `stm-skills/src/l0/frame-tilt.ts` |
| `TiltProbeCircle` | `skills/builtins/tilt_probe.py` | 353 | `stm-skills/src/l0/tilt-probe.ts` |
| `TiltCalibrate` | `skills/composite/auto_tilt.py` | 654（与下者同文件） | `stm-skills/src/composite/auto-tilt.ts` |
| `AutoTilt` | 同上 | 同上 | 同上 |

进度：**417 → 421 done**，`0 partial`，模块 **92 → 95 / 165**。

---

## 2. 容差表（每行一句推导）

| 件 | 容差 | 推导 |
|---|---|---|
| `noiseFloor` | **0** | 一次差分 + 两次中位数（同 `plane.ts`） |
| `detrendQuadratic` 每像素 | `detrendAbsTol(κ, 基座)` = `8·(κ+7)·eps·max\|z\|` | 去趋势是**相消** ⇒ 尺度取基座不取残差；κ **随金样录**（64² 上实测 1.1e5） |
| 主导比一族 | `DOMINANCE_REL_TOL = 1e−9` | 残差的绝对误差 δ 在比值上放大 `2δ/σ`；最小那格 σ = 1e−11 ⇒ 8e−11，12 倍余量 |
| `estimateTilt` 的 RANSAC 派生量 | `max(4 × ransac_spread, RANSAC_REL_TOL)` | **`ransac_spread` 由导出器跑 12 个种子量出来**，逐格录 |
| `estimateTilt` 的结论 / `noise_floor_m` | **0** | 它们不是数，是判决 |
| `circleTiltResolutionDeg` / `zSpanForFrame` | `TILT_TRIG_REL_TOL = 1e−12` | 一次 `atan`/`tan`/`sqrt`，两边各 1 ulp ⇒ 4.5e−16，三个量级余量 |
| `fitCircleTilt` 的**四个角** | `CIRCLE_REL_TOL = 1e−12` | 设计阵正交（κ = 1.41），**实测最坏 7.9e−15** |
| `fitCircleTilt` 的残差派生量与漂移 | `CIRCLE_RESIDUAL_REL_TOL = 1e−9` | 相消放大 `\|z\|/\|resid\| ≈ 1.4e3`，外加「小分量」那一条（同批 6c 的 `coef_ratio`）；**实测最坏 1.1e−11** |
| `cond2x2` | `cond2x2RelTol(cond)` = `4·eps·cond` | 两边都向后稳定 ⇒ σ 的**绝对**误差 `eps·σmax` ⇒ cond 的**相对**误差 `eps·cond` |
| hypot 派生量 | `HYPOT_REL_TOL = 4.5e−16` | D-HYPOT-1（原已登记），本批添了三个消费方 |
| `formatSiReadable` / 报文 / 调用序列 | **0（逐字）** | 措辞就是契约 |

### ⚠️ 两条容差是**改过一次**的，两次都是因为「盖得住一切」

1. `cond2x2RelTol` 第一版写成了常数 `1e−14`。近奇异那一格（cond ≈ 4e7）
   实测相对差 `4.4e−9` —— **比常数大五个量级，而它仍在 `eps·cond` 之内**。
   一条不随被测量的条件数走的容差，就是在替某一格调参。
   现在测试里有一条 `那条容差不是一个常数`：它断言那一格的相对差 **> 1e−10**
   （常数版会在那里红）。
2. `CIRCLE_REL_TOL` 第一版是 `1e−11` 一条包全部。而角度实测 8e−15、
   漂移系数实测 1.1e−11 —— 一条尺子同时太松（对角度）又太紧（对漂移）。
   拆成两条，**真的拿去调硬件的那四个角**单独按窄的那条比。

---

## 3. 偏差登记（**8 条**，写在 `spec/deviations.md` 批 7a-1 锚点下，编号留 `?`）

| 登记 | 一句话 |
|---|---|
| `D-TILT-1` 分割器 | 本仓没有 `segment_scale_adaptive` ⇒ 落在旧仓自己的 `except` 上；做成注入口，**金样两侧都录** |
| `D-TILT-2` `frame_not_2d` | `Mat` 保证二维 ⇒ 那一支构造不出来；1×N 走 `frame_too_small`，两侧答案都在金样里 |
| `D-TILT-3` `fit_failed` | **两侧都不可达**（`too_many_nan` 在前面），金样用 5 格量着这条推理 |
| `D-TILTCIRCLE-1` 秩亏 | 同一份输入两边差**整整一倍**（1.432° 对 2.862°），而两边残差都 ~1e−25 ⇒ 解不唯一。**不改**（没有下游），断言留着 |
| `D-TILTCAL-1` 写档案 | 旧仓只有一个 `None`；本仓五态，其中 `no_sink` 是旧仓没有的（它的档案在进程内） |
| `D-TILT-4` 空 `reason` | `trigger < hard` 恒成立 ⇒ `no_action_needed` 那句空 reason 不可达，15 格量着 |
| `D-HYPOT-1` 补充 | 本批添了三个消费方；`frame_fallback` 那一格**故意**把框改成 300×200 nm |
| `D-TILT-5` 裸块 | `AnalyzeFrameTilt` 不做几何归位（旧仓现状）；顺带 `.sxm` 读错那句话印**路径** |

---

## 4. 变异演练（**42 条，42/42 实跑到 red**；⚠️ **基线干净**）

```
MUTATE=1 node tools/mutate/run.ts <42 个 id>
… 基线（1 个 scope）        ← 没有拒跑 ⇒ 基线为 0
42/42 变红
```

**日志入仓**：`docs/handoff/drill-7a-1-2026-09-20.log`（87 行，最终树上重跑的那一趟）。
⚠️ 它是 `git add -f` 进来的 —— `.gitignore:16` 有一条 `*.log`，`git add -A` 会**静默**
跳过它。核的是 `git ls-files docs/handoff/ | grep log` 里那一行，不是 `ls` / `wc`。
（主线 7a-2 支线同一天独立撞到同一件事并加了 `!docs/handoff/*.log`；
本支线从它之前分叉，合并之后 `-f` 就多余了，不冲突。）

分布：`vision/tilt-frame.ts` 16 · `vision/tilt-circle.ts` 5 ·
`kernel/tilt-loop.ts` + `si.ts` + `instrument-profile.ts` 8 ·
`l0/frame-tilt.ts` 3 · `l0/tilt-probe.ts` 4 · `composite/auto-tilt.ts` 6。

### 4.1 五条第一轮**绿了**，逐条说清楚怎么修的（这一节比上一节值钱）

| 变异 | 为什么绿 | 修法 |
|---|---|---|
| `tilt-dominance-zero-local-sigma-is-not-a-ratio` | 「局部 σ 恰为 0」那条退路**一格输入都没有** —— 金样那一节喂的是**去趋势之后**的帧，而去趋势把块内的恒定打散了（`blocky_8` 的 tile=4 从 1.0 变成 1.146） | 新加一节 `structure_dominance_raw`：**不去趋势**直接喂原帧。四条退路这才各有一格 |
| `tilt-frame-too-small-uses-the-short-side` | 只有 32×32 一格，而它上面 `min` 与 `max` 给**同一个答案** | 新加 `tall_64x32`（短边 32、长边 64） |
| `tiltcircle-veto-is-or-not-and` | 两条否决线在现有格子上**总是一起越** | 新加 `peak_only`（二次谐波，光滑 ⇒ 峰值 6σ、跳变 3σ）与 `jump_only`（逐点交替 ⇒ 峰值 4σ、跳变 8σ） |
| `autotilt-rolls-back-to-the-original` | 测试只比了**动词名**，没比实参 —— 而把回滚目标从 `orig` 换成 `current`，动词序列一个字都不变 | 加 `expectCalls`：动词**与实参**逐条 |
| `autotilt-applied-is-null-when-nothing-was-written` | 那一支**不可达**（`maxIter ≥ 1` ∧ `nSub ≥ 1` ∧ 写失败一律早退） | 按 green-8 §2.8：先把不可达**量出来**（一条测试），再把变异改打在真正做决定的那一行上（`max_iterations` 的「0 与缺席同义」） |

### 4.2 四条第一轮**编不过**（TS6133 / TS2339），也逐条说清楚

「一条编不过的变异，那道闸就永远验不到」——本仓第十五到十八次。

| 变异 | 编不过的原因 | 修法 |
|---|---|---|
| `tilt-dominance-local-sigma-is-median` | 换掉 `npMedian` ⇒ 那个 import 没人用 | 替换串里补一个 `+ npMedian(stds) * 0` |
| `tilt-z-span-takes-degrees` | 改调用点 ⇒ `radians` 成了没人用的函数 | **改打在 `radians` 自己身上**（`return deg`） |
| `tiltcircle-drift-column-needs-finite-times` | 去掉 `allFinite` ⇒ 变量没人用 | 替换串里补 `\|\| allFinite` |
| `autotilt-refuses-without-calibration` | `&& false` 让 TS 撤掉了 `calib.g` 的**类型收窄** | 提一个**有声明返回类型**的 `tiltMatrixOf()`（生产代码，抬头写着理由）—— 与 `plane.ts` 的 `refitOnInliers` 一字不差的先例 |

---

## 5. 金样（`spec/golden/tilt.json`，**24 节 / 314 格**，2.83 MB）

导出器 `tools/spec-export/export_tilt.py`。三台假东西，三种形状：

* `.sxm` **字节**由脚本合成（形状照 `export_batch6c.sxm_bytes`），读法归旧仓；
* `ZSim`：一台**闭式**假仪器（横移记位置、读 Z 按斜面给数 + 循环抖动）；
* 子技能 `TiltProbeCircle` 由**脚本**扮演（每一步交什么写在用例里）。

时钟两处都钉死：`time.monotonic` 换成「每调一次 +1 ms」的计数器，
`time.time` 钉在 `1_700_000_000`。

**重跑逐字节相同**：跑两遍 `cmp` —— 第一次**差了 12 处**，
全在 `data.stored.updated_at` 上（`set_tilt_calibration` 写的是真墙钟）。
钉住之后两遍 `cmp` 干净。`skill_traces.json` / `instrument_profile.json` 同样各跑两遍，
逐字节相同。

### 三条这一份特有的纪律

1. **RANSAC 的谱宽随每一格录**（`ransac_spread`，12 个种子）。
   主路那几格是 **0** —— 棋盘噪声让内点恒为全部（见下），而真高斯那一格是 `3.3e-3`。
   谱宽 > `LOTTERY_SPREAD`（0.05）的格子**只比结论**，而测试把那两格**点名列出来**：
   `expect(lottery).toEqual(['step_dense', 'step_dense_off'])` —— 不许悄悄多一格。
2. **分割器两侧都录**：把 `sys.modules['mast.vision.seg_scale_adaptive']` 设成 `None`
   逼出真的 `ImportError`，走的是**旧仓自己那条 except**。
3. **三处不可达各留一节**，量出来而不是写在注释里。

### ⚠️ 那个「棋盘噪声」是这一批最实用的一招

`estimate_tilt` 内部调 `fit_plane_robust`，而两边的抽样序列不同（D-VISION-1）。
高斯噪声那一格实测 12 个种子之间 `b` 差 **3.3e-3** —— 「倾斜是多少」在金样里
就是一次抽签。

棋盘（`± A · (−1)^(x+y)`）把它变成确定的：行内差分恒为 `±2A` ⇒ MAD 恒为 `2A` ⇒
内点阈 `3σ = 6.29A`，而任何一个够好的三点假设与真平面的偏差 ≤ ~3A ⇒
**全部 4096 个点都是内点**。`count > best_count` 在 `count == n` 之后再也不成立 ⇒
内点集**与抽样无关** ⇒ 精拟合逐位相同。实测 12 个种子给同一个 `a`、同一个 `b`、
`inlier_ratio === 1.0`。

这是 `plane.ts` 抬头那句「想要逐位，就**别让它抽签**」的另一种造法 ——
那边靠的是显式 sigma，这边靠的是**噪声的形状**（`estimate_tilt` 自己算 sigma，
传不进去）。

---

## 6. 测试

| | 之前 | 之后 |
|---|---|---|
| unit + contract | 6231 | **6535**（+304） |
| integration（真 stmsim） | 86 | **91**（+5） |
| 变异清单 | 593 | **635**（+42） |

新文件：`vision/src/tilt.test.ts`（**153**）· `kernel/src/tilt-loop.test.ts`（**62**）·
`stm-skills/src/l0/tilt-skills.test.ts`（**74**）· `stm-skills/integration/tilt.test.ts`（**5**）。
其余 15 条来自 `traces.test.ts`（四个新技能各若干条轨迹）。

`pnpm build` / `--project '!integration'` / `--project integration` 三样全绿。

### e2e 验的是单测验不到的那件事

`AnalyzeFrameTilt` **不在** e2e 里（它一次 Nanonis 调用都不发，同批 4a 那八个）。
另外三个在，验四条回包形状假设 + **针尖回到了起点** + 「没有标定时一次硬件都不碰」。
`AutoTilt` 的 `runSkill` 在 e2e 里**真的分发** `TiltProbeCircle`，不是脚本替身。

---

## 7. ⚠️ 与任务书不一样的地方（**7 条**）

### 7.1 任务书的缺件清单少了 **483 行 / 四条依赖**，而根因是封锁账的形状

| 少了的 | 行 | 谁要 | 怎么发现的 |
|---|---|---|---|
| `TiltProbeCircle` | 353 | `AutoTilt` / `TiltCalibrate` 的 `context.run(...)` | 读 `_measure()` 时撞见 |
| `fit_circle_tilt` + `CircleTilt` + 4 个常量 | ~130 | `TiltProbeCircle` | 顺藤摸瓜 |
| `assess_steps` | 36 | `estimate_tilt` | 同上 |
| `_rotate_slope` | 13 | `estimate_tilt` | 同上 |

`packages/host/stm-skills/src/l0/tip-phase-deps.test.ts` 的 `BLOCKED` 表里
**从来没有过 `TiltProbeCircle` 这一行** —— 那张表记的是「六条流程的 `sub_skills`
里谁还没落」，也就是**一层**。`AutoTilt` 自己还等着谁，它答不了。

⇒ 我在那张表上加了一段注释（**划掉一行之前，先问一句「它自己还等着谁」**），
主线要据此改那张账。选择走**甲**（收进来），理由：`TiltProbeCircle` 的动词全是
本仓已有的四个、时钟与中止都有现成注入口，而收进来之后三个模块一次收口、
`AutoTilt` 不是一个上来就 `skipped(measure_failed)` 的壳。

### 7.2 `_segmentation_step_signal` 不是 `step_dominance_multiscale` 的依赖

任务书写「上一件可能要 —— 自己核」。核完了：它是 **`assess_steps`** 的依赖，
而 `assess_steps` 是 `estimate_tilt` 的。再往下是 `seg_scale_adaptive`（**7a-3 的地盘**）。
做法见 §3 第一条。

### 7.3 `AutoTilt` / `TiltCalibrate` 放在 `composite/`，不是 `l0/`

任务书说「`stm-skills/src/l0/` 下你自己的两个技能文件」。`l0/index.ts` 的锚点注释
自己写着「**组合技能也从这个锚点走**」，而仓里所有 composite 都在 `composite/`。
按仓里的体例放，从 7a-1 的锚点注册。`composite/auto-tilt.ts` 是新文件，不碰别人。

### 7.4 动了三个**任务书没列**的共享文件

| 文件 | 改了什么 | 为什么非改不可 |
|---|---|---|
| `kernel/src/si.ts` | 追加 `formatSiReadable` + `pyFloat` | `diverged` / `not_converged` 那两句话逐字要它；放进 `si.ts` 而不是另开一个文件，理由是「一族里的成员各自为政，第六个和第七个就会互相拆台」 |
| `kernel/src/instrument-profile.ts` | 加 `processInstrumentProfile.write` + `setTiltCalibration`；`CONFIG_SPEC` 加 `z_range_m` / `tilt_limit_deg` | 该文件 `TILT_CAL_MAX_COND` 的抬头自己写着「写入侧接上来的那天，拒写闸要用同一个常量」。那两个配置键从 `ablated_keys` 移进来，是因为**它们现在有消费方了** |
| `l0/analysis-common.ts` | `loadSxm` 多一个**可选** `what` | 旧仓 `read_sxm(path)` 报错印路径；缺省不变。⚠️ **2026-09-20 订正**：括号里原写「改缺省会让四个批的报文整排变红」——**不成立**，`<sxm>` 在 `spec/golden/` 里零命中。真正的理由见 `analysis-common.ts` 抬头 |

### 7.5 改了三个共享**测试**文件（都在它们自己的机制里）

* `tip-phase-deps.test.ts`：`BLOCKED` 划掉两行（**这张表红了就是本批的验收**）；
  另外三条自检测试**改了问法** —— 它们原来问 `missing_skills` 里有没有那几个名字，
  而那等于把「链上有它」与「它还没移植」绑在一起，本批落了之后全红，**而链一个字没变**。
  改成问声明表（`*_REQUIRED_SKILLS`）。
* `traces.test.ts`：加 `fitApprox` + `FIT_KEYS`（与 `clockApprox` 同形、不同理由，
  所以另开一个名字），以及 `CUSTOM_BODIES`（与导出脚本**同一张表**）。
* `instrument-profile.test.ts`：没改，但它的金样重导了（多两个登记键）。

### 7.6 通用轨迹驱动器加了一个 `CUSTOM_BODIES` 钩子

`TiltProbeCircle` 在恒定回包上是**退化**的：一圈 Z 全相等 ⇒ 正弦拟合的 A、B 只剩
`1e−17` 量级的舍入噪声，而 `downhill_deg = atan2(−B, −A) % 360` 于是是一次掷骰子
（同一份输入两边给 0° / 90° / 254° / 316°）。

与 `CUSTOM_ERRORS` 同一条理由（「一条注错文案决定了走哪条分支，于是它必须是一个
单独的开关」），加了一个**按技能**覆写 body 的钩子，让 Z 跟着 XY 走。
**这不是为了让测试过而放松，是把夹具修对**：恒流下 Z 跟随表面，正是这个技能成立的前提。
两侧（导出脚本 / `traces.test.ts`）各一份表，抬头互指。

### 7.7 `estimate_tilt` 的 `step_dense_off` 那一格与我预想的不同

任务书没提，但值得记：关掉台阶闸之后，台阶帧上给出的**不是**「偏 13 倍的角度」，
而是 `low_inliers`（内点比 0.47 < 0.5）。也就是说在这张合成帧上，
**内点比那道闸先把它接走了**。原来的 why 写错了，已改。

---

## 8. 没做的（逐条，卡在哪儿）

1. **`segment_scale_adaptive`（210 + 40 行）** —— 7a-3 的地盘（`seg-*`）。
   接上来的那天，`assessSteps` 的 `segSignal` 注入口是现成的，
   `tilt-frame.ts` **一个字都不用改**。
2. **`kernel` 里那条「`applied: null` 不可达」的分支**没删（消融精神的反面：
   它防的是「`maxIter` 哪天允许 0」，而那件事完全可能发生）。同 green-8 §2.8 的处置。
3. **`AnalyzeFrameTilt` 的「通道里没有正扫/反扫数据」那一支**在真文件上到不了
   （`readSxm` 对声明过的通道总会给出 `forward`）。留着，测试里写明了它到不了。
4. **`TiltCalibrate` 的「条件数非有限」那一支**同样不可达：`cond = ∞ ⟺ det = 0`，
   而 `|det| < 1e-9` 的奇异闸在它前面。照移，不删，不打变异。

---

## 9. 值得进课时的三件

### ① 一张「谁在等谁」的账，答不出「等的那个自己还等着谁」

批 6a 的封锁账把 `AutoTilt` 列成一行，任务书据此估了 52 行。
真实数字是 **535 行**（52 + 353 + 130），差**十倍**。
而两个数都对 —— 它们回答的是两个问题：
「这条流程的 `sub_skills` 里谁不在注册表」与「把它跑起来还缺什么」。

**账本身没错，错的是拿它当第二个问题的答案。**
修法不是记得更仔细，是让那张表**自己说出它记的是哪一层**（已在表上加注）。

### ② 「让它别抽签」有两种造法，而第二种是造输入不是造参数

`plane.ts` 早就写过「想要逐位，就别让它抽签 —— 给一个显式的 sigma」。
但 `estimate_tilt` 自己算 sigma，传不进去，那条路走不通。

第二种造法是**造噪声的形状**：棋盘让 `3σ` 大到把全部像素圈进内点集，
于是「best 是哪个三点假设」这个问题的答案不再影响结果。
**一个把搜索空间压成一个点的输入，比一条容差诚实。**

而两种格子都要留着：`valid_gaussian` 那一格存在的全部意义，
是让「这一格必须按谱宽比」这句话说得出口。

### ③ 「只比动词名」的调用序列断言，挡不住任何一次「写错了值」

`autotilt-rolls-back-to-the-original` 那条变异把回滚目标从原始倾斜换成当前倾斜
—— **动词序列一个字都不变**，而针尖被留在一个用户没同意过的位置上。
第一版测试只比了 `calls.map(c => c.method)`，于是它绿了。

这是「一个『是不是』的问题，用『差多少』永远问不出来」（批 4b）的近亲：
**一个『去了哪儿』的问题，用『发了几条』永远问不出来。**

---

## 10. 给合并方的提醒

1. **`skill_traces.json` / `instrument_profile.json` / `progress.json` / `specs.ts`
   都是生成物** —— 冲突机械处理，合完各跑一次生成器：
   `node scripts/gen-skill-specs.ts` · `node scripts/build-progress.ts` ·
   两台导出器（`export_skill_traces.py` / `export_instrument_profile.py`）。
2. **`tip-phase-deps.test.ts` 的 `BLOCKED` 表三条支线都会动。**
   合完请**重跑**它，而不是机械地把三份 diff 都留下 —— 那张表的值就在于它会红。
3. **`traces.test.ts` 的 `CUSTOM_BODIES` 与 `export_skill_traces.py` 的那张表必须同步。**
   两边抬头互指，但没有测试钉住它们相等（钉不住：一边是 Python）。
   哪天不同步，`TiltProbeCircle/ok` 会当场红 —— 那就是它的守卫。
4. **偏差编号留 `?`**，8 条，在 `spec/deviations.md` 批 7a-1 锚点下。
5. 我**没有**碰 `profiles/mast-rig`、没有在 `packages/host/compat/src/` 之外出现过
   `from '@deepseek-ai/`、没有动 7a-2 / 7a-3 的地盘。
   旧仓 `find MAST -newermt '-180 minutes'` 返回 **0 个文件**。
