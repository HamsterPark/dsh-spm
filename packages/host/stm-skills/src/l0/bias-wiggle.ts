/**
 * `BiasWiggle` —— 偏压随机扰动，用户在 GUI 上「把偏压条拉来拉去」的软件版。
 *
 * 物理上：恒流反馈开着时 `|V|` 变小 ⇒ 隧道电流掉 ⇒ 反馈把针尖推近样品。
 * 在 ±20 mV 内反复跳变，针尖顶端反复经历不同的场与距离，最不稳的那几个原子会重排。
 * 全程 `|V| ≤ 20 mV`，与修针脉冲的伏级差两个数量级 —— 这是**温和**的改性。
 *
 * ## 它为什么不复用 `BiasSettleChange`
 *
 * 那一个有一条硬规矩：反馈开着时目标偏压不许落在 `|V| < 50 mV` 的死区里。
 * 本技能**整个工作区间都在那条死区之内**，这是刻意的例外，所以它自带四道护栏
 * 取代那条规矩：`|V|` 有下限 · 穿零不停留 · 每一步都看电流 · 突发 ≤ 10 s。
 *
 * ## 判据一件都不缺，**而基础设施缺一件**
 *
 * 旧仓这个技能的函数体里**一个 `mast.*` 的 import 都没有**（405 行纯 A 档，
 * `blockers-7a.md` §1 那一行；本批逐行复核属实：顶层只有 `random` / `time` /
 * `core.types` / `skills.base`，收尾一个 `wrap_skill`）。
 *
 * **但它的收尾那一行用了 `safe_call(..., allow_on_abort=True)`** ——
 * 中止闩上之后 `Bias_Set` 不在 `ABORT_SAFE_WRITES` 里，那个逃生口正是为
 * 「这次写**是因为** abort 才要做的」存在的。本仓**没有这个口**：
 * `SafeCall` 的签名是 `(method, ...args)`，`gated-call.ts` 也只按动词与实参判。
 *
 * ⇒ **本批没有发明它。** 理由是本仓的原话（`SkillContext` 的抬头）：这种东西
 * 要写成一个**单独命名的入口**而不是 `safeCall` 的一个可选参数 ——
 * 而那是一次内核接口改动，会动到三十来处构造 `SkillContext` 的测试夹具。
 * 今天它**不改变本技能的行为**（本仓还没有任何地方把 `gatedSafeCall` 接进
 * `SkillContext.safeCall`），所以这里照直发，把缺口写进 deviation 与交接。
 * 见 `spec/deviations.md` 的 `D-WIGGLE-?`。
 *
 * ## 时钟：`ctx.now()` 是**毫秒**，旧仓 `time.monotonic()` 是**秒**
 *
 * 同批 5b 的 `current-monitor.ts`。这一条在这里尤其要紧：burst 的出口是
 * **墙钟**，而每一段停留是一个随机数 ⇒ 一次 burst 打出几次跳变
 * （`flips_executed`）由时钟与随机数共同决定。两侧的假钟摆在不同量级上
 * （旧仓 1e6 **秒**、本仓 1e6 **毫秒**），差在第 10 位 —— 所以
 * `burst_s` 与 `log[].t_s` 是**时钟派生**字段，金样按相对 1e-6 比；其余逐位。
 *
 * ## 随机数：这一个必须逐位追 **CPython 的 `random`**
 *
 * 见 `numerics/mt19937.ts` 的抬头。一句话：`log` 里每一格都是随机数的直接产物，
 * 换一个 RNG 等于这个技能整条轨迹没有判据。
 */
import {
  formatG,
  pyFixed,
  pyFloatRepr,
  pyRound,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { PyRandom } from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { formatG6, fail, num, ok } from './common.js'
import { numOr } from './analysis-common.js'

/**
 * 绝对硬帽 —— 写死在代码里，配置放宽不了，`execute` 里**二次校验**。
 *
 * 与粗动电压四重锁同一条哲学：超上限**拒绝，不夹紧**。悄悄降下来的幅度
 * 是一个被报告成成功的错误动作。
 */
export const ABSOLUTE_MAX_V = 0.1
/** 一次突发的总时长上限（秒）。 */
export const ABSOLUTE_MAX_BURST_S = 10.0
/** 斜率上限（V/s），与 `bias_settle` 的穿零斜率同值。 */
export const ABSOLUTE_MAX_SLEW = 2.0

/**
 * 斜坡的时间网格（秒）。比出厂的最短停留（50 ms）细，
 * 这样「停留」和「爬坡」不会互相吃掉对方的时间粒度。
 */
const STEP_INTERVAL_S = 0.05

/** 小于这个幅度的改变直接下发，不分步 —— 分步只是多几次 TCP 往返。 */
const MIN_RAMP_V = 1e-3

/**
 * 旧仓 `_parse_scalar`：回包第一个标量，**取不出或调用失败都给 `null`**。
 *
 * 错误那一半由这里判，body 那一半走共用的 `num`（D-SKILL-1 的单一真源）。
 */
function scalarOf(rec: SkillCallRecord): number | null {
  if (rec.error !== undefined && rec.error !== '') return null
  return num(rec)
}

/** 一次跳变的记录（回包 `data.log` 的一项）。 */
interface FlipRow {
  readonly target_v: number
  readonly reached_v: number
  readonly crossed_zero: boolean
  readonly t_s: number
}

/**
 * 从 `start` 走到 `target`。返回 `[实际到达的偏压, 停止原因]`；
 * 原因为 `''` 表示走到了。
 *
 * 中途每一步都查 abort、看电流 —— 停在两个都通过边界检查的中间值上是安全的。
 */
async function rampTo(
  ctx: SkillContext,
  args: { start: number; target: number; slew: number; abortA: number },
): Promise<readonly [number, string]> {
  const { start, target, slew, abortA } = args
  const delta = Math.abs(target - start)
  if (delta < MIN_RAMP_V) {
    const rec = await ctx.safeCall('Bias_Set', target)
    if (rec.error !== undefined && rec.error !== '') return [start, `Bias_Set 失败: ${rec.error}`]
    // 小幅改变也要看电流。这条快捷路径最初漏了这一步 ——「每一步都看电流」一旦
    // 有例外，一次恰好落在例外里的跳变就会让针尖在超阈状态下继续走下一步。
    // **护栏不能有大小之分。**
    const curRec = await ctx.safeCall('Current_Get')
    const amps = scalarOf(curRec)
    if (amps !== null && Math.abs(amps) > abortA) {
      return [target, `电流 ${formatG(Math.abs(amps), 3)} A 超过中止阈 ${formatG(abortA, 3)} A`]
    }
    return [target, '']
  }

  const nSteps = Math.max(1, Math.trunc(pyRound(delta / Math.max(slew * STEP_INTERVAL_S, 1e-9), 0)))
  let current = start
  for (let i = 1; i <= nSteps; i += 1) {
    if (ctx.signal.aborted) return [current, 'aborted']
    const value = start + (target - start) * (i / nSteps)
    const rec = await ctx.safeCall('Bias_Set', value)
    if (rec.error !== undefined && rec.error !== '') return [current, `Bias_Set 失败: ${rec.error}`]
    current = value
    const curRec = await ctx.safeCall('Current_Get')
    const amps = scalarOf(curRec)
    if (amps !== null && Math.abs(amps) > abortA) {
      return [current, `电流 ${formatG(Math.abs(amps), 3)} A 超过中止阈 ${formatG(abortA, 3)} A`]
    }
    if (i < nSteps) await ctx.sleep(STEP_INTERVAL_S * 1000)
  }
  return [current, '']
}

/**
 * 把偏压放回去 —— **包括 abort 路径**。
 *
 * 收尾用加急斜率（仍不超绝对上限）：留在一个随机的扰动值上没有意义，
 * 而幅度本来就只有几十毫伏。
 *
 * ⚠️ 旧仓这里带 `allow_on_abort=True`，本仓**没有那个口**（见文件抬头）。
 *
 * ⚠️ 旧仓这一段外面套着 `except Exception: pass`（「收尾绝不能把已经发生的事变成
 * 异常」）。本仓**没有照抄**：`safeCall` 的约定就是**永不抛**（失败表达成
 * `record.error`），于是那个 `except` 在这一侧是一段**永远进不去**的代码 ——
 * 同 green-8 §2.8「那道闸不可达」的形状，而那一课的结论是先证明不可达、
 * 不要留一段没有闸的守卫。
 */
async function restoreBias(ctx: SkillContext, frm: number, to: number): Promise<void> {
  const delta = Math.abs(to - frm)
  if (delta < MIN_RAMP_V) {
    await ctx.safeCall('Bias_Set', to)
    return
  }
  const n = Math.max(1, Math.trunc(pyRound(delta / (ABSOLUTE_MAX_SLEW * STEP_INTERVAL_S), 0)))
  for (let i = 1; i <= n; i += 1) {
    const value = frm + (to - frm) * (i / n)
    await ctx.safeCall('Bias_Set', value)
    if (i < n) await ctx.sleep(STEP_INTERVAL_S * 1000)
  }
}

export const BiasWiggle: Skill = {
  spec: S.BiasWiggleSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const base = numOr(params, 'base_bias_v', 0)
    const lower = Math.abs(numOr(params, 'wiggle_lower_v', 0.004))
    const upper = Math.abs(numOr(params, 'wiggle_upper_v', 0.02))
    let dwellLo = numOr(params, 'dwell_min_s', 0.05)
    let dwellHi = numOr(params, 'dwell_max_s', 0.15)
    const slew = numOr(params, 'slew_rate_v_per_s', 1.0)
    const burst = numOr(params, 'burst_s', 5.0)
    const abortA = numOr(params, 'abort_current_a', 5e-9)
    const seed = Math.trunc(numOr(params, 'seed', 0))

    // ── 硬帽二次校验（ParameterSpec 之后再来一遍）──
    // spec 可以被改、被绕过；这几个数字关系到针尖是不是还在，所以在真正下发
    // 之前再查一次。**拒绝，不夹紧。**
    if (upper > ABSOLUTE_MAX_V || lower > ABSOLUTE_MAX_V) {
      return fail(
        `扰动幅值上限 ${formatG6(upper)} V 超过硬上限 ±${pyFloatRepr(ABSOLUTE_MAX_V)} V。这是` +
          `写死在代码里的界,配置改不了 —— 拒绝执行而不是替你降到上限。` +
          `要更大的幅度请用 BiasPulse(那是另一件事,有它自己的包络)。`,
      )
    }
    if (lower >= upper) {
      return fail(`扰动下限 ${formatG6(lower)} V 不小于上限 ${formatG6(upper)} V —— 区间是空的。`)
    }
    if (burst > ABSOLUTE_MAX_BURST_S) {
      return fail(
        `突发时长 ${formatG6(burst)} s 超过硬上限 ${pyFloatRepr(ABSOLUTE_MAX_BURST_S)} s。` +
          `这是一次短促扰动,不是一个可以一直开着的模式。`,
      )
    }
    if (slew > ABSOLUTE_MAX_SLEW) {
      return fail(`斜率 ${formatG6(slew)} V/s 超过硬上限 ${pyFloatRepr(ABSOLUTE_MAX_SLEW)} V/s。`)
    }
    if (dwellHi < dwellLo) {
      const t = dwellLo
      dwellLo = dwellHi
      dwellHi = t
    }
    if (Math.abs(base) > ABSOLUTE_MAX_V + upper) {
      // 从 1 V 的成像偏压跳进 ±20 mV 的扰动区，那一下不是扰动，是一次大跳变。
      return fail(
        `基准偏压 ${formatG6(base)} V 离扰动区间(±${formatG6(upper)} V)太远 —— 进出扰动` +
          `区的那两次跳变本身就是一次大的偏压变化。请先用 ` +
          `BiasSettleChange 把偏压带到成像值附近再打扰动。`,
      )
    }

    // ── 前置：反馈必须开着 ──
    // 这个技能的物理机制就是「|V| 变小 → 反馈把针尖推近」。反馈关着时它什么也不做
    // （z 不动），读不到状态时我们无法确认自己在做什么 —— 两种情况都不该照跑。
    if (!Boolean(params['allow_feedback_off'])) {
      const fbRec = await ctx.safeCall('ZCtrl_OnOffGet')
      const fb = scalarOf(fbRec)
      const feedbackOn = fb === null ? null : Math.trunc(fb) !== 0
      if (feedbackOn !== true) {
        return fail(
          (feedbackOn === false ? 'Z 反馈是关的' : '读不到 Z 反馈状态(ZCtrl_OnOffGet)') +
            ' —— 偏压扰动靠的是恒流反馈在低偏压下把针尖推近，' +
            '反馈不开这一步什么也不会发生。先开反馈' +
            '(ZControllerOnOff enable=true)，或显式传 ' +
            'allow_feedback_off=true。',
          { feedback_on: feedbackOn },
        )
      }
    }

    // ── 起点确认：读不到就拒绝斜坡 ──
    const startRec = await ctx.safeCall('Bias_Get')
    const start = scalarOf(startRec)
    if (start === null) {
      return fail(
        `读不到当前偏压(Bias_Get: ${startRec.error !== undefined && startRec.error !== '' ? startRec.error : '返回值无法解析'})` +
          ` —— 不知道起点就不能受控地改变偏压。拒绝执行，不从假设的 0 V ` +
          `开始。`,
      )
    }

    const rng = new PyRandom(seed)
    const nowS = (): number => ctx.now() / 1000
    const t0 = nowS()
    let current = start
    const log: FlipRow[] = []
    let stopReason = ''
    let aborted = false

    while (nowS() - t0 < burst) {
      // 目标：幅值在 [lower, upper] 内随机，符号随机。永不落在零附近 ——
      // 这是「在死区里跳」与「停在零点」的分界。
      const target = rng.uniform(lower, upper) * rng.choice([-1.0, 1.0])
      // 穿零段允许用绝对上限的斜率：停在零附近的每一毫秒反馈都在推针尖，
      // 所以跨过去要快，而且中间不设停留点。
      const crosses = current > 0 !== target > 0 && current !== 0
      const effSlew = crosses ? ABSOLUTE_MAX_SLEW : slew

      const [reached, why] = await rampTo(ctx, { start: current, target, slew: effSlew, abortA })
      current = reached
      log.push({
        target_v: pyRound(target, 6),
        reached_v: pyRound(current, 6),
        crossed_zero: crosses,
        t_s: pyRound(nowS() - t0, 3),
      })
      if (why !== '') {
        stopReason = why
        aborted = why === 'aborted'
        break
      }

      const dwell = rng.uniform(dwellLo, dwellHi)
      const remaining = burst - (nowS() - t0)
      if (remaining <= 0) break
      await ctx.sleep(Math.min(dwell, remaining) * 1000)
      if (ctx.signal.aborted) {
        stopReason = 'aborted'
        aborted = true
        break
      }
    }

    // ── 收尾：偏压一定要放回去（包括 abort 路径）──
    await restoreBias(ctx, current, base)

    const elapsed = nowS() - t0
    const data = {
      flips_executed: log.length,
      burst_s: pyRound(elapsed, 3),
      base_bias_v: base,
      wiggle_lower_v: lower,
      wiggle_upper_v: upper,
      slew_rate_v_per_s: slew,
      abort_current_a: abortA,
      seed,
      log: log.map((r) => ({ ...r })),
      bias_restored: true,
      aborted_reason: stopReason,
    }
    if (aborted) {
      return fail(
        `扰动被中止(已完成 ${log.length} 次跳变)，偏压已恢复到 ${formatG6(base)} V。`,
        data,
      )
    }
    if (stopReason !== '') {
      return fail(
        `扰动在第 ${log.length} 次跳变时停下：${stopReason}。偏压已恢复到 ${formatG6(base)} V。`,
        data,
      )
    }
    return ok(
      data,
      `偏压扰动 ${log.length} 次跳变／${pyFixed(elapsed, 1)} s ` +
        `(±${pyFixed(lower * 1e3, 0)}–${pyFixed(upper * 1e3, 0)} mV)，` +
        `已恢复到 ${pyFixed(base * 1e3, 0)} mV。`,
    )
  },
}

/** 这个文件里的技能。 */
export const BIAS_WIGGLE: Readonly<Record<string, Skill>> = { BiasWiggle }
