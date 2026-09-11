/**
 * 进针升级的**逃逸闸** —— 堵 2026-07-27 那道侧门。
 *
 * 事故形状：`ApproachTip` 拒绝升级到粗进针 → **133 秒后** agent 直接调用
 * `AutoApproach`。而 `AutoApproach` 正是它刚拒绝的那个粗进针，直接调用等于绕过一个
 * **刚刚做出的**安全判断。
 *
 * ## 两条不对称的规矩，各自来自一次事故
 *
 * | | 作用域 | 为什么 |
 * |---|---|---|
 * | **记** 一次拒绝 | 进程全局 | 一根针、一块样品——一次拒绝必须挡住**每一条链** |
 * | **清** 一次拒绝 | 按链计 | 2026-07-28 调度审计 致命一(c)：私聊里的一次成功 engage 把群聊十秒前记下的拒绝抹掉了，**侧门重新打开** |
 *
 * 对称地清除看起来更「一致」，而那份一致正是缺陷本身。
 *
 * ## 出路在拒绝文案里，不在 TTL 里
 *
 * 重新调用 `ApproachTip` **立刻**取代这次拒绝——它会重新核验 Z 反馈状态，确实需要
 * 粗进针就自己升级。所以这个上限只在「agent 再也不走正门」的时候才起作用。
 */

/**
 * 一次拒绝挡多久。
 *
 * 足够长，覆盖那次事故的 133 秒还有余量；足够短，一次没人再回头看的拒绝不会活得比
 * 它描述的硬件状态更久。
 */
export const APPROACH_REFUSAL_TTL_S = 600.0

/** 没给理由时的占位——一条**没有理由的拒绝**仍然是一次拒绝，但它得说自己没理由。 */
export const NO_REASON_PLACEHOLDER = '(no reason recorded)'

/**
 * **就是**粗进针升级的那些技能。
 *
 * `MotorMove` 的 z-approach 有意不在内：它在安全闸 Layer 0 已经是 fail-closed 的，
 * 根本到不了这道检查。
 */
export const ESCALATION_SKILLS: readonly string[] = ['AutoApproach']

/** `skillName` 是不是那个粗电流反馈进针的起点。 */
export function isApproachEscalation(skillName: string): boolean {
  return ESCALATION_SKILLS.includes(skillName)
}

export interface ApproachRefusal {
  readonly reason: string
  readonly source: string
  /** **哪一条链**记的（群跑 / 私聊 / 信号 API）。见 {@link ApproachRefusalLatch.clear}。 */
  readonly owner: string
  readonly atMonotonicS: number
  readonly ttlS: number
}

/**
 * 那道闩。
 *
 * 时钟注入：一个「10 分钟内不许绕过」的闸，测试里不能真等 10 分钟，而把 TTL 改小
 * 又等于测了另一个东西。
 */
export class ApproachRefusalLatch {
  #refusal: ApproachRefusal | null = null

  constructor(private readonly nowS: () => number) {}

  /** 记一次拒绝。**覆盖**之前的——最新的判决才是活的那个。 */
  record(
    reason: string,
    opts: { readonly source?: string; readonly owner?: string; readonly ttlS?: number } = {},
  ): void {
    this.#refusal = {
      reason: (reason || '').trim() || NO_REASON_PLACEHOLDER,
      source: opts.source ?? 'ApproachTip',
      owner: opts.owner ?? '',
      atMonotonicS: this.nowS(),
      ttlS: opts.ttlS ?? APPROACH_REFUSAL_TTL_S,
    }
  }

  /**
   * 丢掉拒绝——一个新的判断取代了它。幂等。返回**是否真的丢掉了一条**。
   *
   * ⚠️ **按链计。** 给了 `owner` 就只能清掉**同一条链**记的那一条；没有 owner 的
   * 拒绝（老行为）谁都能清；`owner` 传 `null` 是管理员覆盖，无条件。
   *
   * 这个不对称是 2026-07-28 致命一(c) 的修复：拒绝本身是进程全局的（一根针一块样品），
   * 而它的**清除**曾经也是全局的——于是私聊里的一次成功 engage 抹掉了群聊十秒前记下
   * 的拒绝，把这道闸当初要堵的侧门重新打开。
   */
  clear(_why = '', opts: { readonly owner?: string | null } = {}): boolean {
    const cur = this.#refusal
    if (cur === null) return false
    const owner = opts.owner
    if (owner !== null && owner !== undefined && cur.owner !== '' && cur.owner !== owner) {
      return false
    }
    this.#refusal = null
    return true
  }

  /** 活着的那条拒绝，或 `null`。**过期的在读的时候顺手丢掉。** */
  active(): ApproachRefusal | null {
    const r = this.#refusal
    if (r === null) return null
    if (this.ageS(r) >= r.ttlS) {
      this.#refusal = null
      return null
    }
    return r
  }

  ageS(r: ApproachRefusal): number {
    return Math.max(0, this.nowS() - r.atMonotonicS)
  }
}

/**
 * 中间件拦下一次**直接**调用时说的那句话。
 *
 * 出路必须在话里：一条只说「被拒了」的拦截，会让 agent 要么重试（正是要防的），
 * 要么卡死。三条出路逐字照移。
 */
export function approachRefusedText(source: string, ageS: number, reason: string): string {
  return (
    '[safety_gate] approach_escalation_refused: ' +
    `${source} 在 ${ageS.toFixed(0)} 秒前拒绝了粗进针` +
    `升级，理由：${reason}。AutoApproach 就是它拒绝的那个` +
    '粗进针，直接调用等于绕过刚做出的安全判断。Do NOT retry ' +
    'AutoApproach. 出路有三条：(1) 重新调用 ApproachTip —— 它会' +
    '重新核验 Z 反馈状态，若确实需要粗进针会自己升级，本拦截随即' +
    '解除；(2) 先修好拒绝理由里说的那个状态（如 Z 反馈开关读不出' +
    '/ 关不掉）再走 ApproachTip；(3) 交给用户在 GUI 手动进针。'
  )
}

/**
 * **进程唯一**的那一把闩。
 *
 * 内核里出现一个模块级可变单例需要理由，这里有一条：**拒绝的全局性是规格本身**。
 * 一根针、一块样品——`ApproachTip` 的一次拒绝必须挡住每一条链，包括它自己不知道
 * 存在的那些。做成「每个服务一把」的话，群跑里记下的拒绝拦不住私聊里的直接调用，
 * 而那正是 2026-07-27 那道侧门。
 *
 * 放在内核而不是某个上层包，是为了让**记的那一侧**（`ApproachTip`）与**读的那一侧**
 * （安全闸）拿到同一个实例，而它们分处两个互不依赖的包。
 *
 * 测试要隔离就自己 `new ApproachRefusalLatch(clock)`——所有判据都在类上，这个单例
 * 只是「谁和谁共享」的答案。
 */
export const processApproachRefusalLatch = new ApproachRefusalLatch(
  () => Date.now() / 1000,
)
