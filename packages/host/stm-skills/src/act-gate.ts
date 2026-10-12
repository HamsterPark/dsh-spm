/**
 * `ctx.stmActGate` —— 一动一观（VISUAL-HARNESS §4.5，决策 D12）接到 dsh 的工具管线上。
 *
 * 判据在 kernel 的 `act-gate.ts`（零 I/O）；这里只回答三件事：**问在哪**、**谁算一个会话**、
 * **什么时候算「结果已进入模型上下文」**。
 *
 * ## 「已进入上下文」= 同一 agent 的下一个 `agent/pre-step`
 *
 * dsh 没有「这条工具结果已送达模型」的事件（facts.md §9.5）。但 `dsh-agent-loop` 的顺序
 * 给了一个等价物：一步里的全部工具结果按模型顺序 `session.append('tool/result')` 之后
 * 这一步才返回，**然后**才提议下一步、跑 `agent/pre-step`；而每一次模型请求都由会话日志
 * 推导出来。于是 pre-step 之后模型再发的任何调用，都出自一个已经带着那些结果的请求。
 *
 * 回执落在一个随后被拒、或者根本没发出请求的 pre-step 上也不错：模型要再发调用，只能
 * 是在回应一次更晚的请求，而那次请求同样由日志推导、同样带着结果。所以这里在 pre-step
 * 一进来就回执，不看它最后放不放行这一步。
 *
 * 同一步里的第二个动作因此被拒（它出自同一个请求，那时第一个的结果还不存在）；并发调用
 * 由 `admit` 的「查与记同一个同步调用」保证只放一个。
 *
 * 例外写在这里，别以为它们被处理了：pre-step 上的压缩（`compaction-basic` 挂在同一个
 * 瀑布上）若恰好把上一个结果摘进了摘要，模型看到的是摘要而不是原文（facts.md §9.4）。
 *
 * ## 拒绝走 guard
 *
 * 与 `stm-safety` 同一条理由：guard **单调**，谁都翻不回来。guard 拒在 dispatch 之前，
 * 内核根本不会被调用，所以拒绝由这里自己记一行（记录库在场时）。
 *
 * ## 谁不受闸
 *
 * - **没有 agent 的调用**：那不是模型发的（测试、宿主直接调用），一动一观管的是模型。
 * - **没登记的工具**：视觉记忆的回看/读值/笔记、`stm_get_state`、dsh 自带的工具。
 * - **读与分析类技能**：不改变仪器状态。
 * - **补救动作**（退针、急停、Stop*）：**放行但记账**——见 kernel `act-gate.ts`。
 */
import { type Context, Service, type ToolExecution } from 'dsh-spm-compat'
import { ACT_GATE_REFUSAL, ActGate, isRemedySkill, isStateChangingSkill, type SkillSpec } from 'dsh-spm-kernel'
import type { ActionInput as RecordInput } from 'dsh-spm-stm-records'
import type {} from 'dsh-spm-stm-records'

export class ActGateService extends Service {
  readonly gate = new ActGate()
  /** 登记过的**改变仪器状态的**技能 → 是不是补救动作。读类技能不进这张表。 */
  private readonly acts = new Map<string, boolean>()
  /** 记录库。没装就是 `undefined`——闸照常拦，只是拦下来这件事没人留痕。 */
  private recordsSvc: { record: (i: RecordInput) => string | null } | undefined

  constructor(ctx: Context) {
    super(ctx, 'stmActGate')

    // ① 拒绝走 guard：单调，谁都翻不回来
    ctx.effect(() => ctx.tools.guard((exec) => this.check(exec)))

    // ② 回执：同一 agent 的下一步要开始了 ⇒ 它此前的结果都在下一次请求里
    ctx.effect(() =>
      ctx.on('agent/pre-step', (payload, next) => {
        this.gate.acknowledge(String(payload.agent.id))
        return next()
      }),
    )

    // ③ agent 走了：忘掉它（会话 id 不会被下一个 agent 复用成「还欠一次观察」）
    ctx.effect(() =>
      ctx.on('agent/disposed', (payload) => {
        this.gate.forget(String(payload.agent.id))
      }),
    )

    ctx.inject(['stmRecords'], (c) => {
      this.recordsSvc = c.stmRecords
    })
  }

  /**
   * 登记一个技能的声明。**只有登记过的、改变仪器状态的技能受闸**；返回注销函数。
   * 读与分析类登记了也不进表——它们永远不受闸。
   */
  registerSkill(spec: SkillSpec): () => void {
    if (!isStateChangingSkill(spec)) return () => {}
    this.acts.set(spec.name, isRemedySkill(spec, spec.name))
    return () => void this.acts.delete(spec.name)
  }

  /** guard 本体：放行返回 `undefined`（并已记账），拒绝返回固定短语。 */
  check(exec: Readonly<ToolExecution>): string | undefined {
    if (exec.agent === undefined) return undefined
    const remedy = this.acts.get(exec.name)
    if (remedy === undefined) return undefined
    if (this.gate.admit(String(exec.agent.id), remedy)) return undefined
    // **这一条要自己记。** guard 拒在 dispatch 之前，内核的 K16 看不见它。
    this.recordsSvc?.record({
      skill: exec.name,
      params: asArgs(exec.arguments),
      kind: 'refused',
      text: ACT_GATE_REFUSAL,
      agentId: String(exec.agent.id),
      toolCallId: String(exec.rootCallId),
      approvalSource: 'llm',
    })
    return ACT_GATE_REFUSAL
  }
}

function asArgs(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * 插件形态（`{ name, inject, apply }`）。不在包顶层导出 `name` / `apply`：
 * 这个包不是插件，那几个名字会和别的 `export *` 撞。
 */
export const actGateProvider = {
  name: 'mast-act-gate',
  /** `tools` 是硬依赖：没有工具注册表就没有可以挂闸的地方。 */
  inject: ['tools'],
  apply(ctx: Context): void {
    new ActGateService(ctx)
  },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    stmActGate: ActGateService
  }
}
