/**
 * 一动一观（VISUAL-HARNESS §4.5，决策 D12）的判据——零 I/O、零 dsh。
 *
 * 一个改变仪器状态的调用跑过之后，**它的结果进入模型上下文之前**，同一会话里下一个改变
 * 仪器状态的调用不执行。参考实现（VISTA-SPM `host.py::_act`）的闸门是同一个形状：动作返回
 * 时置「待观察」，运行器看到那条工具结果进了模型的输入才回执清掉。
 *
 * 宿主怎么接（`dsh-spm-stm-skills` 的 `ActGateService`）：dsh 的 guard 上问 {@link ActGate.admit}，
 * 同一会话的下一个 `agent/pre-step` 上 {@link ActGate.acknowledge}。为什么是 pre-step、
 * 证据在哪，见那边的抬头与 `docs/dsh/facts.md` §9.5。
 *
 * ## 放行即记账，而且是同一个同步调用
 *
 * 「查」与「记」分两步做，两个并发调用会都查到「没有待观察的」、都放行。
 * `admit` 一次同步地做完两件事，JS 单线程于是保证并发下只放一个。
 *
 * ## 补救动作永不拒
 *
 * 退针、急停、各种 Stop 是**出事时立刻要能跑**的东西（与样品门控、中止闩同一条原则：
 * 安全操作绝不能被记账类的闸挡住）。它们照样记「待观察」——退针之后再动别的，
 * 也得先看过退针的结果。参考实现没有这条例外（spec/deviations.md D-VMEM-15）。
 */
import { GATE_EXEMPT_NAMES } from './sample-gate.js'

/** 只读的技能类别。其余——`write`、`composite`、缺类别——一律算改变仪器状态。 */
const READ_ONLY_CATEGORIES: ReadonlySet<string> = new Set([
  'read',
  'analysis',
  'skillcategory.read',
  'skillcategory.analysis',
])

/** 补救动作的标签。`withdraw` / `retract` 不在列：`SetWithdrawRate` 之类的配置写也带着它们。 */
const REMEDY_TAGS: ReadonlySet<string> = new Set(['stop', 'emergency'])

export interface ActMetaLike {
  readonly name?: string | undefined
  readonly category?: string | undefined
  readonly tags?: readonly string[] | undefined
}

/**
 * 这个技能会不会改变仪器状态。
 *
 * **分类不出来就算会**（fail-closed，与仪器锁 `needsToken` 同向）：漏闸一个写动作，
 * 模型就能在没看过上一个结果时连发两个；多闸一个读动作，代价只是晚一步。
 */
export function isStateChangingSkill(meta: ActMetaLike): boolean {
  return !READ_ONLY_CATEGORIES.has(String(meta.category ?? '').toLowerCase())
}

/** 补救动作：名字在样品门控的豁免表里，或带 `stop` / `emergency` 标签。 */
export function isRemedySkill(meta: ActMetaLike, skillName = ''): boolean {
  const name = skillName || meta.name || ''
  if (GATE_EXEMPT_NAMES.has(name)) return true
  return (meta.tags ?? []).some((t) => REMEDY_TAGS.has(String(t).toLowerCase()))
}

/** 每个会话一位「有一个改变仪器状态的结果还没被模型看到」。键是会话（agent）id。 */
export class ActGate {
  private readonly pending = new Set<string>()

  /**
   * 一个改变仪器状态的调用要执行：放行返回 `true`，并**同时**记下它待观察。
   * 补救动作永远放行（也记下）。
   */
  admit(session: string, remedy = false): boolean {
    if (!remedy && this.pending.has(session)) return false
    this.pending.add(session)
    return true
  }

  /** 这个会话此前的结果都已进入模型上下文：下一次模型请求必然带着它们。 */
  acknowledge(session: string): void {
    this.pending.delete(session)
  }

  /** 会话结束：忘掉它。 */
  forget(session: string): void {
    this.pending.delete(session)
  }

  isPending(session: string): boolean {
    return this.pending.has(session)
  }
}
