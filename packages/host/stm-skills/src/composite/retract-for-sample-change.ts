/**
 * `RetractForSampleChange` —— 换样品 / 关机前的**分级**粗动大退针。
 *
 * 现场共同设计（2026-07-20）。一次「大」退针：换样品/关机前把针尖用**粗动马达**
 * 沿保存的退针方向退几千步 —— 与只收压电的 `SafeRetract` / `WithdrawTip` 是两回事。
 * 危险在于：如果这台机器上配置的退针方向**是反的**，步进粗动马达就是把针尖往
 * 样品里送（撞针）。
 *
 * ## 防撞设计就是那把梯子（操作员原话）
 *
 * ```
 * 先收压电，再让粗动马达走 1 → 10 → 100 →（剩余），
 * 每一级走完开 Z 反馈、读**Z 压电的走向**：
 *   真的退远了 ⇒ 反馈会伸长压电去追那个变远的样品（Z 往伸长方向走）；
 *   方向反了   ⇒ 压电缩回 / 电流跳起来 —— 停。
 * ```
 *
 * **为什么看 Z 而不是电流**（操作员的裁决）：针尖一旦远了，电流衰减到 ~0、
 * 不带任何符号；而 Z 压电的伸长/缩回方向永远是干净的。电流只当额外的危险跳闸用。
 *
 * **为什么梯子从 1 开始**：第一级是**最小风险探针**。一个粗动步远小于压电量程，
 * 所以即使方向反了，走一步之后开反馈也能把那点逼近吸收掉 ——
 * 我们以**一步**的代价知道了方向是错的。只有在某一级**确认**了远离之后才升级。
 * 配置的方向是一个**意图**；这个逐级 Z 自检才是真正的防撞网。
 *
 * 方向 / 总步数 / 远离阈值 / lock-in dI/dV 信号号全部来自仪器档案（按机器，用户填）。
 *
 * ## 与旧仓的差别
 *
 * - **串扰导航报告（`crosstalk_report`）不移植**，同 D-APPROACH-2：它要一条参考曲线，
 *   而本仓没有。旧仓那段自己写着「这是报告，不是任何流程的目的」，整体包在
 *   try/except、**永不抛**、**不驱动任何决策** —— 梯子的进退只看 `judgeRecedeLadder`。
 * - **`nanonis_calls` 不在结果上**：本仓调用台账由内核记，`SkillResultLike` 没有这一栏
 *   （登记见 D-ZS-*）。旧仓靠它把 settle 的最后一对读数带回去，本仓那几个数
 *   已经在 `settle` 字典里。
 */
import {
  GraphExecutor,
  getConfig,
  getRetractDirCode,
  judgeRecedeLadder,
  progressToDict,
  retractLadder,
  zSettleDict,
  zSettleUsable,
  zSettleWhy,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
  type ZSettle,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { num } from '../l0/common.js'
import { captureQplusBaseline } from './tip-evidence.js'
import { settleAndReadZ } from './z-settle.js'

const P_STOP = '_phase_stop_powered'
const P_BASELINE = '_phase_baseline'
const P_WITHDRAW = '_phase_withdraw_initial'
const P_RETRACT = '_phase_retract_verify'

/**
 * settle 的行为参数。注意这里**没有**什么：一个「开反馈之后等多久再读 Z」的旋钮。
 * 等一个固定时长**就是**这段代码替换掉的那个缺陷（2026-08-04，见 `z-settle.ts`）；
 * 更大的常数只会把这台机器的 4–5 s 烤进一个随温度、增益、针尖变的数里。
 * 剩下的是轮询节奏、窗口长度，以及一个**生产路径上不传**的预算覆盖
 * （于是这台机器自己的 `z_settle_timeout_s` 生效）。
 */
export const RETRACT_POLL_INTERVAL_S = 0.1
export const RETRACT_SETTLE_WINDOW_N = 5

class Retract {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  readonly #rungs: Record<string, unknown>[] = []
  #ex!: GraphExecutor
  #baseline: ZSettle | null = null
  #baselineZ: number | null = null
  #setpointA: number | null = null

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  #plan(): CompositeStep[] {
    const asked = this.#params['total_steps']
    const total =
      typeof asked === 'number' && Number.isInteger(asked) && asked > 0
        ? asked
        : Math.trunc(Number(getConfig('retract_total_steps', 3000)))
    const stepMax = Math.trunc(Number(getConfig('retract_step_max', 1000)))
    const rungs = retractLadder(total, stepMax)

    const steps: CompositeStep[] = [
      { stepId: 'stop_powered', skillName: P_STOP, params: {}, optional: false, checkpointAfter: false, tags: ['stop'] },
      { stepId: 'baseline_z', skillName: P_BASELINE, params: {}, optional: false, checkpointAfter: true, tags: ['read'] },
      {
        stepId: 'withdraw_initial',
        skillName: P_WITHDRAW,
        params: {},
        optional: false,
        checkpointAfter: true,
        tags: ['withdraw'],
      },
    ]
    let cumulative = 0
    rungs.forEach((n, i) => {
      cumulative += n
      steps.push({
        stepId: `retract_${i}_${n}`,
        skillName: P_RETRACT,
        params: { steps: n, level: i, cumulative },
        optional: false,
        checkpointAfter: true,
        tags: ['retract', 'verify'],
      })
    })
    return steps
  }

  #phase(name: string, params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    if (name === P_STOP) return this.#stopPowered()
    if (name === P_BASELINE) return this.#phaseBaseline()
    if (name === P_WITHDRAW) return this.#withdraw('withdraw_initial')
    if (name === P_RETRACT) {
      return this.#retractVerify(
        Math.trunc(Number(params['steps'] ?? 1)),
        Math.trunc(Number(params['level'] ?? 0)),
        Math.trunc(Number(params['cumulative'] ?? 0)),
      )
    }
    return Promise.resolve({ success: false, error: `Unknown phase: ${name}` })
  }

  /**
   * 先把**通电的**东西停掉 —— 一个还在跑的 AutoApproach / 马达会把这次退针吃掉。
   * 尽力而为：一次停不下来不该挡住退针。
   *
   * 动词写成**字面量**：安全工具（中止策略检查 / 安全审计 / API 覆盖率普查）
   * 全靠 grep `safeCall('…')`，一个藏在展开元组后面的动词对它们全都是隐形的。
   */
  async #stopPowered(): Promise<StepResult> {
    await this.#ctx.safeCall('AutoApproach_OnOffSet', 0)
    await this.#ctx.safeCall('Motor_StopMove')
    return { success: true, data: {} }
  }

  #settle(): Promise<ZSettle> {
    return settleAndReadZ(this.#ctx, {
      pollIntervalS: RETRACT_POLL_INTERVAL_S,
      windowN: RETRACT_SETTLE_WINDOW_N,
    })
  }

  /**
   * 把反馈环**停下来的地方**记成远离判据的基线。
   *
   * 等 Z 压电不再走，而不是睡一个固定窗口：一个取在斜坡上的 Z 测的是我们等了多久，
   * 不是表面在哪里，而下面每一级都是拿它去减。
   *
   * **基线不可用就中止。** 它曾经降级成只看电流的检查 —— 听起来宽容，
   * 直到你看清它降级成了什么：电流为零意味着「压电够得着的范围里没有表面」，
   * 而这对一根正在远离的针、一根还没进到量程里的针、一个坏掉的前放**同样成立**。
   * 把那叫做「在远离」就是一道不存在的守卫，而这条组合接着会在它之上驱动几千步粗动。
   * **拒绝是响的，代价是一次换样品；继续的代价是一根针。**
   */
  async #phaseBaseline(): Promise<StepResult> {
    const settle = await this.#settle()
    this.#baseline = settle
    this.#baselineZ = zSettleUsable(settle) ? settle.zM : null
    this.#setpointA = settle.setpointA
    this.#ex.setPartial('baseline_z_m', this.#baselineZ)
    this.#ex.setPartial('setpoint_a', this.#setpointA)
    this.#ex.setPartial('baseline_settle', zSettleDict(settle))
    if (settle.state === 'aborted') {
      return { success: false, error: 'aborted while settling for baseline Z' }
    }
    if (!zSettleUsable(settle)) {
      return {
        success: false,
        error:
          '退针方向自检无法建立基线 Z:' +
          zSettleWhy(settle) +
          '。每一级退针都是拿「反馈稳定后的 Z」跟这个基线比,' +
          '基线读不到就没有方向自检 —— 不会盲退几千步。' +
          '若本机反馈确实比这个预算慢,到设置页把「退针 Z 稳定预算」' +
          '(z_settle_timeout_s)调大。',
        data: { baseline_settle: zSettleDict(settle) },
      }
    }
    return {
      success: true,
      data: {
        baseline_z_m: this.#baselineZ,
        setpoint_a: this.#setpointA,
        baseline_settle: zSettleDict(settle),
      },
    }
  }

  /** 把细 Z 完全收回（`ZCtrl_Withdraw` 等到走完）。 */
  async #withdraw(tag: string): Promise<StepResult> {
    const rec = await this.#ctx.safeCall('ZCtrl_Withdraw', 1, -1)
    if (rec.error !== undefined && rec.error !== '') {
      return { success: false, error: `withdraw (${tag}) failed: ${rec.error}` }
    }
    return { success: true, data: { withdrawn: tag } }
  }

  /** lock-in R（dI/dV）幅度。信号号没配 / 读失败都是 `null` —— **不是 0**。 */
  async #readDidv(): Promise<number | null> {
    const idx = getConfig('lockin_signal_index', null)
    if (idx === null || idx === undefined) return null
    const rec = await this.#ctx.safeCall('Signals_ValGet', Math.trunc(Number(idx)), 0)
    if (rec.error !== undefined && rec.error !== '') return null
    const v = num(rec, 0)
    return v === null ? null : Math.abs(v)
  }

  /**
   * 沿远离方向走 `steps` 步，然后开反馈、核实针尖真的退开了
   * （Z 压电伸长方向），在逼近 / 电流跳变上跳闸。
   */
  async #retractVerify(steps: number, level: number, cumulative: number): Promise<StepResult> {
    const dirCode = getRetractDirCode()

    // 1. 粗动退针（方向来自配置；只往远离方向）。
    const recMove = await this.#ctx.safeCall('Motor_StartMove', dirCode, steps, 0, 1)
    if (recMove.error !== undefined && recMove.error !== '') {
      return {
        success: false,
        error: `coarse retract (rung ${level}, ${steps} steps) failed: ${recMove.error}`,
      }
    }

    // 2. 开反馈，等压电**停止**去追样品。不是一个固定窗口。
    const after = await this.#settle()
    if (after.state === 'aborted') {
      await this.#safeStopAndWithdraw()
      return { success: false, error: 'aborted during recede self-check' }
    }

    // 3. 读剩下的证据。
    const zAfter = zSettleUsable(after) ? after.zM : null
    const current = after.currentA
    const didv = await this.#readDidv()

    const { verdict, why } = judgeRecedeLadder(this.#baseline, after, this.#setpointA)
    const rung: Record<string, unknown> = {
      level,
      steps,
      cumulative,
      z_after_m: zAfter,
      current_a: current,
      didv_v: didv,
      verdict,
      reason: why,
      settle: zSettleDict(after),
      // ⚠️ 旧仓在这里还 `rung.update(crosstalk_report(ctx))` —— **串扰导航报告不移植**
      // （见抬头，同 D-APPROACH-2）。刻意**不塞一个占位键**：接一个永远返回同一句话的
      // 读口，等于给下一个人留一条永远不亮的分支（D-CRASH-3 同一条）。
      // 这条差异在 `traces.test.ts` 的 `withoutCrosstalk` 上钉着。
    }
    this.#rungs.push(rung)
    this.#ex.setPartial('rungs', [...this.#rungs])

    if (verdict === 'unsettled') {
      // **不是 `approaching`** —— 一个我们没能取到的读数不许戴上和「针尖在逼近」
      // 同一个标签，否则一个坏掉的判据就和一条接反的线分不出来。
      // 它会停下梯子：下一级是这一级的 10 倍，而那正是小探针级存在的理由。
      await this.#safeStopAndWithdraw()
      return {
        success: false,
        error:
          '退针方向自检**没有得出结论**(不是判定为逼近):' +
          why +
          '。已停止粗动并撤针。读不到稳定的 Z 就无法判断针尖是远离' +
          '还是靠近,而下一级步数是这一级的 10 倍。' +
          '若本机反馈确实较慢,到设置页把「退针 Z 稳定预算」' +
          '(z_settle_timeout_s)调大。',
        data: { rung, rungs: [...this.#rungs] },
      }
    }

    if (verdict === 'no_sign') {
      // 停在这一级，而且**处方与 unsettled 不同**：那一条的方子是「调大
      // z_settle_timeout_s」，对着一个没填的符号开那张方子只会把人指向没坏的东西。
      // 这条自检的全部内容就是把 Z 的走向翻译成方向，没有符号就没有翻译 ——
      // 不是「判不准」，是**根本没有判据**。
      await this.#safeStopAndWithdraw()
      return {
        success: false,
        error:
          '退针方向自检**无法进行**:' +
          why +
          '。已停止粗动并撤针,只赔了这一级的步数。这一项没有可用的默认值 —— 出厂给 `+1`,' +
          '而本机实测是 `-1`(WithdrawTip 后 Z 停在**正**轨),' +
          '所以「猜一个」和「猜对了」长得一模一样。' +
          '判法:开反馈让压电去找表面,看 Z 读数往哪边走 —— 那一边就是' +
          '**伸长**;再到设置页 → 退针 → `z_extend_sign` 如实填。',
        data: { rung, rungs: [...this.#rungs] },
      }
    }

    if (verdict === 'approaching') {
      // 方向反了 —— 针尖朝样品去了。**现在**停马达并撤针；不要再走（更大的）一步。
      await this.#safeStopAndWithdraw()
      return {
        success: false,
        error:
          '退针方向自检失败：粗动 ' +
          String(steps) +
          ' 步后开反馈检测到针尖在**逼近**样品（' +
          why +
          '）——退针方向很可能配置反了。已停止粗动并撤针，只赔了这一级的步数。' +
          '请核对 instrument_profile 的退针方向/z_extend_sign 后再试。',
        data: { rung, rungs: [...this.#rungs] },
      }
    }

    // 4. 在远离（或者在极小的早期级上「说不准但安全」）：再收一次压电，
    //    让**下一**次粗动步是安全的。
    const w = await this.#withdraw(`rung_${level}`)
    if (!w.success) {
      return { success: false, error: `post-rung withdraw failed: ${w.error ?? ''}`, data: { rung } }
    }
    return { success: true, data: { rung } }
  }

  /** 尽力而为的急停清理：停马达 + 撤针。**永不抛。** */
  async #safeStopAndWithdraw(): Promise<void> {
    await this.#ctx.safeCall('Motor_StopMove')
    await this.#ctx.safeCall('ZCtrl_Withdraw', 1, -1)
  }

  async run(): Promise<SkillResultLike> {
    this.#ex = new GraphExecutor('RetractForSampleChange', {
      now: () => this.#ctx.now(),
      run: (skill, params) => this.#phase(skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
    })

    const allGood = await this.#ex.runPlan(this.#plan())
    const p = this.#ex.progress
    const rungs = (p.partialData['rungs'] as Record<string, unknown>[] | undefined) ?? this.#rungs
    const confirmed = rungs.filter((r) => r['verdict'] === 'receding')
    const stepsOf = (r: Record<string, unknown>): number => Math.trunc(Number(r['steps'] ?? 0))

    const data: Record<string, unknown> = {
      retracted: allGood,
      baseline_z_m: p.partialData['baseline_z_m'] ?? null,
      total_steps_retracted: allGood
        ? rungs.reduce((a, r) => a + stepsOf(r), 0)
        : rungs.filter((r) => r['verdict'] !== 'approaching').reduce((a, r) => a + stepsOf(r), 0),
      rungs,
      recede_confirmed_rungs: confirmed.length,
      _progress: progressToDict(p),
    }

    if (!allGood) {
      return {
        success: false,
        error: p.abortedReason || 'RetractForSampleChange aborted',
        data,
      }
    }

    // 一次核实过的完整退针，是自由振荡振幅**唯一可知**的时刻：离表面几千个粗动步，
    // 每一级都自检为远离。在这里抓基线，而不是指望有人记得手动传 `set_baseline=True`
    // —— 那份指望正是振幅撞针探测器一直在回答「no_baseline」（也就是「判不了」）
    // 而不干活的原因。尽力而为：一台没有 qPlus 的机器只多一句说明。
    Object.assign(data, await captureQplusBaseline(this.#ctx, '退针自检全部通过后记录的自由振荡基线'))

    return { success: true, data }
  }
}

export const RetractForSampleChange: Skill = {
  spec: S.RetractForSampleChangeSpec,
  execute: (ctx, params) => new Retract(ctx, params).run(),
}
