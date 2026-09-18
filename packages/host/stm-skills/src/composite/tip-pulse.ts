/**
 * `TipPulse` —— 打偏压脉冲修针。先快照当前偏压，打脉冲，再恢复。
 *
 * 本仓第一个**参数由方案表填、包络由方案表判**的组合技能。三处接线，缺一不可：
 *
 * | | 在哪 | 拆掉会怎样 |
 * |---|---|---|
 * | **判** | {@link TipPulse.validateParams}（内核 K6） | 超包络的一发在**任何硬件调用之前**拦不住，只剩全局 ±10 V 那道按参数名判的闸 |
 * | **填** | `#resolve()`，排计划之前 | 模型不填就得替物理发明一个电压 —— 而钨的电化学腐蚀针和 PtIr 剪切针受不住同一个脉冲 |
 * | **记** | `policyFieldsForResult` 进 `data` | 「实际打了什么」与「模型给了什么」分不开；事后没人说得清这一发是谁定的 |
 *
 * ## 为什么 `validateParams` 与 `execute` 里各判一次
 *
 * 照移旧仓：`validate_params` 判的是**调用方给的值**（K6，硬件之前），
 * `run_composite` 判的是**方案表填完之后的整组值**。两次判的不是同一组数 ——
 * 第一次拦的是「你给的 8 V 超了」，第二次拦的是「你什么都没给，而这支针的方案表
 * 本身就超了它自己的包络」。后者在旧仓真的发生过：`NobleTipWorkflow.pulse_v` 出厂
 * 10 V 曾经 > 通用档的 6 V ⇒ **没有登记针尖时，ForgeAuTip 的大修相一发脉冲都打不出去**，
 * 而「未登记」是这套系统最常见的状态。
 *
 * ## 硬件计时的脉冲，不是软件循环
 *
 * v1 是 `Bias_Set` + sleep + `Bias_Set`。这里每一发走 `BiasPulse` 子技能
 * （`Bias_Pulse` 一条 TCP，由硬件计时），`z_hold=1`。
 * **`z_hold` 曾经是 0（"no change"）**：脉冲期间反馈仍在追电流，而几伏的脉冲会让
 * 电流暴冲若干数量级 —— Z 会被一路压向表面。
 */
import {
  GraphExecutor,
  progressToDict,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { applyTipPolicy, policyFieldsForResult } from '../l0/tip-policy.js'
import { runSubSkill } from './run-sub.js'

/** 方案表字段 → 本技能的参数名。 */
const RENAME: Readonly<Record<string, string>> = { pulse_duration_s: 'duration_s', pulse_count: 'count' }
const FIELDS = ['pulse_v', 'pulse_duration_s', 'pulse_count'] as const

const numOr = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)

class Pulse {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  async run(): Promise<SkillResultLike> {
    // 先按当前针尖补齐没给的参数，**再**种 partial_data —— 否则报出去的会是
    // 「模型给了什么」而不是「实际打了什么」。
    const { params, plan } = applyTipPolicy(this.#params, FIELDS, RENAME)
    if (!plan.ok) return { success: false, error: plan.refusals.join('；') }

    this.#ex = new GraphExecutor('TipPulse', {
      now: () => this.#ctx.now(),
      run: (skill, p) => runSubSkill(this.#ctx, skill, p),
      checkAbort: () => this.#ctx.signal.aborted,
      onStepResult: (step, res) => this.#onStepResult(step, res),
    })

    // 方案表也没给（表里就没有这个字段）⇒ 退到既有的保守默认，而不是一个 undefined
    // 一路漏进报文。**这三个 fallback 是旧仓的原值**，不是新发明的数。
    const pulseV = numOr(params['pulse_v'], 3.0)
    const durationS = numOr(params['duration_s'], 0.1)
    const count = Math.trunc(numOr(params['count'], 1))
    this.#ex.setPartial('pulse_v', pulseV)
    this.#ex.setPartial('duration_s', durationS)
    this.#ex.setPartial('count', count)
    for (const [k, v] of Object.entries(policyFieldsForResult(plan))) this.#ex.setPartial(k, v)

    const allGood = await this.#ex.runPlan(this.#plan(pulseV, durationS, count))
    const p = this.#ex.progress
    const data: Record<string, unknown> = {
      pulse_v: p.partialData['pulse_v'] ?? null,
      duration_s: p.partialData['duration_s'] ?? null,
      count: p.partialData['count'] ?? null,
      original_bias_v: p.partialData['original_bias_v'] ?? null,
      _progress: progressToDict(p),
    }
    // 参数来源痕迹：每个数字是调用方给的还是方案表给的，事后必须查得到。
    for (const key of ['tip_policy', 'tip_policy_notes', 'tip_registered', 'tip_name']) {
      if (key in p.partialData) data[key] = p.partialData[key]
    }
    if (allGood) return { success: true, data }
    return { success: false, error: p.abortedReason || 'tip_pulse aborted', data }
  }

  /** 静态计划：`count` 一个数就定得下步骤表。 */
  *#plan(pulseV: number, durationS: number, count: number): Generator<CompositeStep> {
    // 1. 把当前偏压快照下来，调用方好在结果里核对「恢复成功了没有」。
    yield {
      stepId: 'snapshot_bias',
      skillName: 'GetBias',
      params: {},
      optional: false,
      checkpointAfter: false,
      tags: ['snapshot'],
    }
    // 2. N 发硬件计时的脉冲。
    for (let i = 1; i <= count; i += 1) {
      yield {
        stepId: `pulse_${i}`,
        skillName: 'BiasPulse',
        params: { width_s: durationS, bias_v: pulseV, z_hold: 1, absolute: true },
        optional: false,
        // 只在最后一发落检查点：N 发短脉冲是个紧内循环，每发都刷是白花的开销。
        checkpointAfter: i === count,
        tags: ['pulse', `i=${i}`],
      }
    }
  }

  #onStepResult(step: CompositeStep, res: StepResult): void {
    if (step.stepId !== 'snapshot_bias') return
    const original = (res.data ?? {})['bias_v']
    if (original !== null && original !== undefined) this.#ex.setPartial('original_bias_v', original)
  }
}

export const TipPulse: Skill = {
  spec: S.TipPulseSpec,
  /**
   * 标准校验 + **针尖安全包络**。
   *
   * 包络在这里而不是 `execute`：它必须在任何硬件调用之前拦住，而 K6 的错误**原样回给
   * 调用方** —— 模型看到的是「为什么被拒」，不是一次静默的 no-op。
   * **超上限拒绝，不夹紧**：夹了调用方会以为自己用的是原来那个值。
   *
   * 请求的两个字段与旧仓逐字相同（`pulse_v` / `pulse_count`，**不含时长** ——
   * 方案表对时长没有上限）。
   */
  validateParams: (params) => [...applyTipPolicy(params, ['pulse_v', 'pulse_count'], RENAME).plan.refusals],
  execute: (ctx, params) => new Pulse(ctx, params).run(),
}
