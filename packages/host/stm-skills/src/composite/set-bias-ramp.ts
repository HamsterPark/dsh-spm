/**
 * `SetBiasRamp` —— 把偏压分小步 ramp 到目标值。
 *
 * GraphExecutor 的另一半验收：`WaitScanComplete` 走的是**流式**动态计划（步数事先
 * 不知道），这一个走的是**先算后排**——第 0 步先去读当前偏压，读到了才排得出后面
 * 那串步骤。两种形状合起来，执行器的两条计划入口都被真技能走过了。
 *
 * ## 读不到就拒绝，不要编一个起点
 *
 * 旧仓这里曾经有**两个各自独立的 `0.0` 兜底**：一个在读偏压那一步，一个在排计划时
 * 的 `partial_data.get("bias_v_start", 0.0)`。只修前一个等于没修——那一步失败时
 * `bias_v_start` 从来没被写过，后一个会把假起点补回来。
 *
 * 代价是实打实的：真实偏压 1 V 而起点被当成 0 时，**第一步就把硬件从 1 V 拽到近 0**
 * ——那正是 `slew_rate_v_per_s` 存在的意义所要防的突变（隧穿态下偏压骤降 → 电流塌 →
 * Z 反馈追设定点 → 把针尖往样品推）。一个失败的读取变成一个假的测量值，而那个假值
 * **废掉了一条安全保护**。
 *
 * 所以这里用 `null` 哨兵：拿不到起点就不排斜坡。
 */
import {
  DEFAULT_SLEW_V_PER_S,
  DEFAULT_STEP_INTERVAL_S,
  GraphExecutor,
  biasRampTargets,
  progressToDict,
  scalarFloat,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'

const PHASE_GET_CURRENT = '_phase_get_current'
const PHASE_STEP_PREFIX = '_phase_set_step_'

/** 读不到当前偏压时那句拒绝 —— **逐字**，它是模型读的东西。 */
export const NO_START_BIAS_ERROR =
  'Cannot slew-ramp bias: Bias_Get returned an unparseable response, so the ' +
  'current bias is unknown. Refusing to ramp from an assumed 0.0V start, which ' +
  'would defeat slew protection. Retry, or pass bias_v_start explicitly.'

const numOr = (v: unknown, dflt: number): number => (typeof v === 'number' ? v : dflt)

class Ramp {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  readonly #endV: number
  readonly #slew: number
  readonly #intervalS: number
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
    this.#endV = numOr(params['bias_v_end'], 0)
    this.#slew = numOr(params['slew_rate_v_per_s'], DEFAULT_SLEW_V_PER_S)
    this.#intervalS = numOr(params['step_interval_s'], DEFAULT_STEP_INTERVAL_S)
  }

  async run(): Promise<SkillResultLike> {
    this.#ex = new GraphExecutor('SetBiasRamp', {
      now: () => this.#ctx.now(),
      run: (skill, p) => this.#phase(skill, p),
      checkAbort: () => this.#ctx.signal.aborted,
    })

    const allGood = await this.#ex.runPlan(this.#plan())
    const p = this.#ex.progress
    const data: Record<string, unknown> = {
      bias_v: this.#endV,
      slew_rate_v_per_s: this.#slew,
      steps: numOr(p.partialData['n_steps'], 0),
      _progress: progressToDict(p),
    }
    if (!allGood) return { success: false, error: p.abortedReason || 'ramp aborted', data }
    return { success: true, data }
  }

  async *#plan(): AsyncGenerator<CompositeStep> {
    // 第 0 步：定起点。用户给了就用给的，没给就去仪器上读。
    const given = this.#params['bias_v_start']
    let startV: number
    if (typeof given === 'number') {
      startV = given
      this.#ex.setPartial('bias_v_start', startV)
    } else {
      yield {
        stepId: 'get_current',
        skillName: PHASE_GET_CURRENT,
        params: {},
        checkpointAfter: false,
        tags: ['setup'],
      }
      if (this.#ex.progress.aborted) return
      const read = this.#recordedStart()
      if (read === null) return
      startV = read
    }

    const targets = biasRampTargets({
      startV,
      endV: this.#endV,
      slewVPerS: this.#slew,
      stepIntervalS: this.#intervalS,
    })
    this.#ex.setPartial('n_steps', targets.length)
    this.#ex.setPartial('bias_v_end', this.#endV)
    this.#ex.setPartial('slew_rate_v_per_s', this.#slew)
    this.#ex.setTotalSteps(targets.length + (typeof given === 'number' ? 0 : 1))

    const last = targets.length - 1
    for (let i = 0; i <= last; i += 1) {
      if (this.#ex.progress.aborted) return
      yield {
        stepId: `set_step_${i}`,
        skillName: `${PHASE_STEP_PREFIX}${i}`,
        params: { target_v: targets[i]!, is_last: i === last, step_interval_s: this.#intervalS },
        // 一步写坏就中止整条斜坡：把偏压停在半路，比走完或者不走都糟。
        optional: false,
        // 只在最后一步落检查点——内循环里每步都落会变成一场刷写风暴。
        checkpointAfter: i === last,
        tags: ['ramp', `step=${i}`],
      }
    }
  }

  /**
   * 读回来的起点，`null` = 没拿到。
   *
   * 旧仓这里写的是 `partial_data.get("bias_v_start", 0.0)`——**第二个假起点**，
   * 和读偏压那一步里的那个各自独立；当年只修前一个等于没修。
   *
   * ⚠️ 但在本仓，这个 `null` 分支是**类型上必要、行为上不可达**的：`get_current`
   * 是 `optional: false`，它失败时执行器已经把整条计划中止，上面那行
   * `if (this.#ex.progress.aborted) return` 先一步返回了。
   *
   * 我一开始把它当成「第二道安全闸」写进了变异清单，而那条演练**没变红**——
   * 没有任何输入能让它响。真正在挡的是 `#getCurrent` 里那句拒绝（`ramp-no-fake-start`
   * 现在指着它，5 个用例覆盖）。这里留 `null` 是因为 `partialData` 的类型是
   * `unknown`，**不是**因为我验过它。一个我说不清谁在挡的闸，不该被算进闸的数目里。
   */
  #recordedStart(): number | null {
    const raw = this.#ex.progress.partialData['bias_v_start']
    return typeof raw === 'number' ? raw : null
  }

  #phase(skillName: string, params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    if (skillName === PHASE_GET_CURRENT) return this.#getCurrent()
    if (skillName.startsWith(PHASE_STEP_PREFIX)) return this.#setStep(params)
    return Promise.resolve({ success: false, error: `Unknown phase: ${skillName}` })
  }

  async #getCurrent(): Promise<StepResult> {
    const rec = await this.#ctx.safeCall('Bias_Get')
    if (rec.error !== undefined && rec.error !== '') {
      return { success: false, error: `Bias_Get failed: ${rec.error}` }
    }
    // `scalarFloat` 已经把 NaN / Infinity / 多元素回包一并拒了（它们都不是测量值）。
    const v = scalarFloat((rec.values ?? [])[0])
    if (v === null) return { success: false, error: NO_START_BIAS_ERROR }
    this.#ex.setPartial('bias_v_start', v)
    return { success: true, data: { bias_v_start: v } }
  }

  async #setStep(params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    const targetV = numOr(params['target_v'], 0)
    const rec = await this.#ctx.safeCall('Bias_Set', targetV)
    if (rec.error !== undefined && rec.error !== '') {
      return { success: false, error: `Slew failed at ${targetV.toFixed(4)}V: ${rec.error}` }
    }
    this.#ex.setPartial('last_bias_v', targetV)
    // 最后一步不睡：调用方不需要一段斜坡之后的空等。
    const interval = numOr(params['step_interval_s'], DEFAULT_STEP_INTERVAL_S)
    if (params['is_last'] !== true && interval > 0) await this.#ctx.sleep(interval * 1000)
    return { success: true, data: { target_v: targetV } }
  }
}

export const SetBiasRamp: Skill = {
  spec: S.SetBiasRampSpec,
  execute: (ctx, params) => new Ramp(ctx, params).run(),
}
