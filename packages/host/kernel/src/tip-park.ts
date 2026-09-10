/**
 * 针尖退到位了没有 —— **全仓唯一的一句「已退到静态安全态」**。
 *
 * ## 为什么有这个模块
 *
 * `SafeRetract` 从 v1 抄过来的时候是这样的：
 *
 * ```python
 * record = context.safe_call("ZCtrl_Withdraw", 0, 1)
 * return SkillResult(..., data={"retracted": True})   # ← 命令发出去了，不是针退到了
 * ```
 *
 * `(0, 1)` = 不等待、1 ms 超时。命令一发出就报 `retracted: True`，
 * 而压电这时**还在往上爬**。
 *
 * ## 判据：Withdraw 是**静态态**，不是过程
 *
 * 定义（STM 通用，不是某台机器的）：**Z 反馈环断开** 且 **Z 压电停在收回端**。
 *
 * - `ZCtrl_StatusGet` 的码 6 叫 `Withdrawing` —— 那是**正在退**，是过程，不是这个状态。
 * - 「反馈环断开」问的是**实时控制器**（`ZCtrl_OnOffGet`），不是 Z-Controller 模块。
 *   Nanonis 手册自己说模块可以显示 Off 而实时控制器还没跟上，两者不可互换。
 * - 「收回端是哪一端」由 `zExtendSign` 决定，**本机没声明过就必须说不知道**。
 *   猜错的代价**不对称**：猜反了会把「针顶在伸长端（朝样品那一侧）」判成已退针。
 *
 * ## 三态，而且「读不到」还要再分两种
 *
 * `state` ∈ `parked` / `not_parked` / `unreadable`。**读不到永远不折叠成具体值**——
 * 既不是「退到了」，也不是「没退到」。
 *
 * `unreadable` 里两种成因分开放，因为**处置完全相反**：
 * - `unreadable` 硬件读失败，可能是瞬时的，**再等一下有意义**；
 * - `undeclared` 本机从来没声明过（如 `zExtendSign`），等多久都不会变，**再轮询是白等**。
 */

export const PARKED = 'parked'
export const NOT_PARKED = 'not_parked'
export const UNREADABLE = 'unreadable'

export type ParkState = typeof PARKED | typeof NOT_PARKED | typeof UNREADABLE

/** `ZCtrl_StatusGet` 的码表。**只用来把码翻成给人看的词，不参与判定。** */
export const MODULE_STATUS: Readonly<Record<number, string>> = {
  1: 'Off',
  2: 'On',
  3: 'Hold',
  4: 'SwitchingOff',
  5: 'SafeTip',
  6: 'Withdrawing',
}

export const Z_SOURCE_PIEZO_HALF = 'Piezo_RangeGet/2'
export const Z_SOURCE_SOFT_LIMITS = 'ZCtrl_LimitsGet (enabled)'

/**
 * 「Z 停在收回端」的容差，取 Z 行程的这个比例。
 *
 * **为什么是派生的而不是一个绝对值**：Z 行程本身随温度腰斩
 * （本机 RT 全程 720 nm、LHe 339 nm），写死一个纳米数在其中一档上就是错的。
 *
 * **为什么是 1%**：两侧代价不对称。太紧 → 把一次真的退针判成 not_parked
 * （烦，安全，顶多多等一轮）；太松 → 把没退到的针判成 parked（危险）。
 * 本机 ⇒ 7.2 nm（RT）/ 3.4 nm（LHe）：比 float32 回包噪声高好几个数量级，
 * 又比「针还在隧穿区」离收回端的距离小两个数量级 —— **两边都不挨着**。
 */
export const RAIL_TOL_FRAC = 0.01

export interface ZTravel {
  readonly lo_m: number
  readonly hi_m: number
  readonly span_m: number
  /** 是哪一条 Nanonis 读答出来的。**不是装饰**——见下。 */
  readonly source: string
}

/**
 * Z 能走到哪 —— **全仓唯一的一份算法**。
 *
 * - `Piezo_RangeGet` 给的是**全程**，半程 = 全程 / 2，且半程**从中心算起**。
 *   把全程当半程用，余量会算成两倍。
 * - `ZCtrl_LimitsGet` 的那对数字**只有 `ZCtrl_LimitsEnabledGet == 1` 时才算数**。
 *   未启用时它是上次写进去的值，不拦任何东西。`null`（没问过 / 读不到）按
 *   **未启用**处理 —— 不知道它启没启用的时候拿它当边界，就是在猜。
 * - 两者都有且软限已启用 ⇒ **取交集**（谁更紧听谁的，逐端判断）。
 *
 * 读不到任何一条 ⇒ `null`。调用方必须把 `null` 当「不知道行程」处理并让判据静默，
 * **绝不拿一个猜的量程去判「快顶死了」**。
 *
 * `source` 存在的理由：这个模块的起因就是「一个算错分母的百分比和一个算对的
 * 长得一模一样」—— 软限值在未启用时**不起任何作用**，而对着它算的
 * 「Z 逼近量程」告警，顶死在行程尽头时不可能响。
 */
export function resolveZTravel(opts: {
  readonly piezoZFullM?: number | null | undefined
  readonly zLimitsM?: readonly number[] | null | undefined
  readonly zLimitsEnabled?: boolean | null | undefined
}): ZTravel | null {
  let lo: number | null = null
  let hi: number | null = null
  let source = ''

  const full = opts.piezoZFullM
  if (typeof full === 'number' && Number.isFinite(full)) {
    const half = Math.abs(full) / 2
    if (half > 0) {
      lo = -half
      hi = half
      source = Z_SOURCE_PIEZO_HALF
    }
  }

  if (opts.zLimitsEnabled === true && opts.zLimitsM != null) {
    const vals = opts.zLimitsM.filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (vals.length >= 2) {
      const sLo = Math.min(...vals)
      const sHi = Math.max(...vals)
      if (sHi > sLo) {
        if (lo === null) {
          lo = sLo
          hi = sHi
          source = Z_SOURCE_SOFT_LIMITS
        } else if (sLo > lo || sHi < (hi as number)) {
          lo = Math.max(lo, sLo)
          hi = Math.min(hi as number, sHi)
          source = Z_SOURCE_SOFT_LIMITS
        }
      }
    }
  }

  if (lo === null || hi === null || hi <= lo) return null
  return { lo_m: lo, hi_m: hi, span_m: hi - lo, source }
}

export interface ParkVerdict {
  readonly state: ParkState
  /** 人话，给用户和 agent 看的那一句。 */
  readonly reason: string
  readonly feedback_on: boolean | null
  /** Z-Controller 模块状态词（GUI 显示的那个），**仅作证据**。 */
  readonly module_status: string | null
  readonly z_m: number | null
  readonly rail_m: number | null
  /** 收回端是行程的哪一端。 */
  readonly rail_side: 'high' | 'low' | null
  readonly gap_m: number | null
  readonly tolerance_m: number | null
  readonly travel_source: string | null
  /** 读失败的项 —— 可能是瞬时的，再读有意义。 */
  readonly unreadable: readonly string[]
  /** 本机没声明过的项 —— 等多久都不会变。 */
  readonly undeclared: readonly string[]
  readonly read_at: number
}

/**
 * **只有确认到位才是 true。** `unreadable` 和 `not_parked` 都是 false。
 *
 * 想区分「没退到」和「不知道」的调用方必须看 `state` —— 这个布尔**故意不承担三态**，
 * 免得有人拿 `!isParked(v)` 当「确认没退到」用。
 */
export function isParked(v: ParkVerdict): boolean {
  return v.state === PARKED
}

/**
 * 再轮询一次有没有可能改变结论。
 *
 * `undeclared` 非空 ⇒ **白等**（要人去填仪器档案），调用方应当**立刻**停止轮询
 * 并如实说是配置缺口，而不是耗光预算再报一个看起来像超时的东西。
 */
export function retryUseful(v: ParkVerdict): boolean {
  return v.undeclared.length === 0
}

/** 一行证据。数字带单位，不带任何没测过的猜测。 */
export function parkEvidence(v: ParkVerdict): string {
  const nm = (x: number): string => (x * 1e9).toFixed(1)
  const parts: string[] = []
  parts.push(v.feedback_on === null ? 'Z 反馈: 读不到' : `Z 反馈: ${v.feedback_on ? '闭合' : '断开'}`)
  if (v.module_status !== null && v.module_status !== '') parts.push(`模块: ${v.module_status}`)
  if (v.z_m !== null) parts.push(`Z = ${nm(v.z_m)} nm`)
  if (v.rail_m !== null) parts.push(`收回端 = ${nm(v.rail_m)} nm`)
  if (v.gap_m !== null && v.tolerance_m !== null) {
    parts.push(`差 ${nm(v.gap_m)} nm(容差 ${nm(v.tolerance_m)} nm)`)
  }
  if (v.travel_source !== null && v.travel_source !== '') parts.push(`行程来源: ${v.travel_source}`)
  if (v.unreadable.length > 0) parts.push(`读不到: ${v.unreadable.join(', ')}`)
  if (v.undeclared.length > 0) parts.push(`本机未声明: ${v.undeclared.join(', ')}`)
  return parts.join('；')
}

export interface ParkReadings {
  /** 实时控制器说反馈环闭没闭合；`null` = 没读到。 */
  readonly feedbackOn: boolean | null
  /** Z-Controller 模块状态词，**只作证据不作判据**。 */
  readonly moduleStatus: string | null
  readonly zM: number | null
  readonly travel: ZTravel | null
  /**
   * `+1` = 伸长（朝样品）表现为 Z 增大 ⇒ 收回端在**低**端；
   * `-1` = 收回端在**高**端；`null` = 本机没声明过，**不许猜**。
   */
  readonly zExtendSign: number | null
  readonly unreadable?: readonly string[] | undefined
  readonly readAt?: number | undefined
}

/**
 * 把一组读数判成一个结论。**纯函数，不碰硬件** —— 判据在这里，读在外面。
 *
 * 分开是为了测试能直接喂读数（不用假 context 也能钉住判据）。
 */
export function parkVerdictFromReadings(r: ParkReadings): ParkVerdict {
  const at = r.readAt ?? Date.now() / 1000
  const missing = [...(r.unreadable ?? [])]
  const undeclared: string[] = []

  const mk = (
    state: ParkState,
    reason: string,
    extra: {
      rail_m?: number
      rail_side?: 'high' | 'low'
      gap_m?: number
      tolerance_m?: number
    } = {},
  ): ParkVerdict => ({
    state,
    reason,
    feedback_on: r.feedbackOn,
    module_status: r.moduleStatus,
    z_m: r.zM,
    rail_m: extra.rail_m ?? null,
    rail_side: extra.rail_side ?? null,
    gap_m: extra.gap_m ?? null,
    tolerance_m: extra.tolerance_m ?? null,
    travel_source: r.travel?.source ?? null,
    unreadable: [...missing],
    undeclared: [...undeclared],
    read_at: at,
  })

  // ── 先看两个「一条读数就能定死」的否定 ──
  //
  // 它们不需要行程和方向符号，所以在那两项读不到 / 没声明的机器上照样给得出一个
  // 确定的「还没到」。**确定的否定比一个 unreadable 有用得多。**
  if (r.feedbackOn === true) {
    return mk(NOT_PARKED, 'Z 反馈环仍然闭合(实时控制器回报 ON)—— 针没有退到静态安全态。')
  }
  if (r.moduleStatus === 'Withdrawing') {
    // 码 6：模块自己说退针**正在进行**。这是过程，不是那个状态。
    return mk(NOT_PARKED, '退针正在进行中(模块状态 Withdrawing),还没到位。')
  }

  // ── 再看能不能判 ──
  if (r.feedbackOn === null && !missing.includes('feedback_on')) missing.push('feedback_on')
  if (r.zM === null && !missing.includes('z_m')) missing.push('z_m')
  if (r.travel === null && !missing.includes('z_travel')) missing.push('z_travel')
  if (r.zExtendSign === null) undeclared.push('z_extend_sign')

  // **没声明过排在读不到前面**：读不到再等一下有意义，没声明过等多久都白等，
  // 两者同时成立时该告诉调用方的是后者。
  if (undeclared.length > 0) {
    return mk(
      UNREADABLE,
      '判不了退针到位没有:本机从没声明过 ``z_extend_sign``(Z 压电伸长朝哪个' +
        '方向),所以不知道行程的哪一端是收回端。**不猜** —— 猜反了会把停在伸长端' +
        '(朝样品那一侧)的针判成已退针。请在仪器档案里声明后再判。',
    )
  }
  if (missing.length > 0) {
    return mk(
      UNREADABLE,
      `判不了退针到位没有:${missing.join(', ')} 读不到。读不到不等于没退到,也不等于退到了。`,
    )
  }

  const travel = r.travel as ZTravel
  const zM = r.zM as number
  const sign = r.zExtendSign as number

  // +1：伸长（朝样品）= Z 增大 ⇒ 收回端在低端；-1 反之。
  const [railM, railSide, farM] =
    sign > 0
      ? ([travel.lo_m, 'low', travel.hi_m] as const)
      : ([travel.hi_m, 'high', travel.lo_m] as const)

  const tolM = Math.abs(travel.span_m) * RAIL_TOL_FRAC
  const gapM = Math.abs(zM - railM)

  if (gapM <= tolM) {
    const note =
      r.moduleStatus === null || r.moduleStatus === 'Off' ? '' : `(模块状态 ${r.moduleStatus})`
    return mk(PARKED, `已退到静态安全态:Z 反馈环断开,Z 停在收回端${note}。`, {
      rail_m: railM,
      rail_side: railSide,
      gap_m: gapM,
      tolerance_m: tolM,
    })
  }

  // 停在**伸长端**要单独说一句：那是朝样品的那一侧，和「还差一点」不是一回事。
  const atFarEnd = Math.abs(zM - farM) <= tolM
  const where = atFarEnd
    ? '而是顶在**伸长端**(朝样品那一侧)'
    : `还差 ${(gapM * 1e9).toFixed(1)} nm`
  return mk(NOT_PARKED, `Z 反馈环已断开,但 Z 没停在收回端 —— ${where}。`, {
    rail_m: railM,
    rail_side: railSide,
    gap_m: gapM,
    tolerance_m: tolM,
  })
}
