/**
 * 等 Z 反馈**停下来**，再读 Z —— 以及「这个读数意味着什么」。
 *
 * 旧仓 `mast/skills/composite/_z_settle.py`（402 行 / 285 代码行）。
 * 轮询那一半在技能层（`stm-skills/src/composite/z-settle.ts`：它要发调用）；
 * **判据在这里**，因为判据全是值。
 *
 * ## 为什么存在（2026-08-04，真机）
 *
 * `RelocateCoarseXY` 的清障自检跑了两次，除了 `retract_motor_dir` 什么都没改：
 *
 * ```
 * retract_motor_dir = z+  → 第 1 级 = approaching, 「Z 压电缩回 465.8 nm」
 * retract_motor_dir = z-  → 第 1 级 = approaching, 「Z 压电缩回  78.3 nm」
 * ```
 *
 * **把方向反过来，结论没有反过来。一个检查，它的答案在你把被测对象反过来时不变，
 * 那它就不是在测那个东西。**
 *
 * 根因是 `ZCtrl_OnOffSet(1)` 与 `ZCtrl_ZPosGet` 之间一个**写死的 1.5 s**。这台机器上
 * 反馈要 4–5 s 才从退针位置找到表面（当天 1 Hz 实测：1.5 s 时 +193.8 nm、2.8 s 时
 * −17.0 nm、4.1 s 时 −258.3 nm、5.4 s 时 −324.0 nm）。基线和退针后的读数**都取在斜坡上**，
 * 于是相减得到的是斜坡上两点的距离 —— 一个**「我们等了多久」的度量**，不是表面在哪里。
 * 它 fail-closed，所以没撞过针；它也让这台机器上的横向换位彻底做不成，
 * 并且盖住了它本来要回答的那个问题。
 *
 * **修法不是把 sleep 调大。** 更大的常数是同一个缺陷，只不过把这台机器的数字烤进去了，
 * 而反馈的快慢随温度、增益、针尖变。
 *
 * ## 「稳定」在这里是什么意思
 *
 * 判据比的是 **Z**，所以要等的量就是 Z。电流有另一件同样必要的活：它说明一个稳定的 Z
 * **意味着什么**。
 *
 * | | |
 * |---|---|
 * | Z 停了、有电流 | 反馈正握着隧道结。Z 是针尖–样品间距的测量值，**可比** |
 * | Z 停了、电流在底噪 | 压电跑到极限并停在那里，量程内没有东西可找。Z 是**轨**——「比压电够得着的还远」，一个下界，不是距离 |
 * | Z 还在走 | **没有读数可取**。此刻读到的任何东西都是上面那个 465.8 nm |
 *
 * 到轨不是失败 —— 清障阶梯从第 2 级起它就是**预期**结局，因为整件事的目的正是把针尖
 * 送到压电够不着的地方。而它保住了这道检查里**性命攸关**的那一半：一个**靠近了**的针尖
 * 会把压电从轨上拉下来，那是一个真实可读的信号。轨做不到的事是**证明一段距离**，
 * 所以它的数值作为界报出去，永远不作为位移。
 *
 * ## 两件会咬到后来编辑者的事
 *
 * 1. **每一次 settle 都从退针位置开始。** 不是为了整洁 —— 只有每次都从同一个地方起步，
 *    稳定后的 Z 才是针尖–样品间距的函数。08-04 那一对之所以不同，部分原因正是一次
 *    从咬合态起步、一次从退针态起步，于是**即使两个读数都收敛了也仍然不可比**。
 * 2. **光是「不动」不够 —— 一个还没开始跑的反馈环也是不动的。** 所以收敛还要求
 *    要么有活的隧道结（电流），要么有压电确实走过的证据。少了第二个子句，
 *    第一个轮询窗口（在斜坡开始之前）会读成「已收敛」，于是我们又拿到了一个
 *    什么都不表示的数。
 */
import { getConfigNum, zExtendSignOrNone } from './instrument-profile.js'
import { formatG } from './si.js'
import { pyRound } from './spectroscopy.js'

/** 低于此值的「电流」是前放底噪，不是隧穿。与两个组合技能的咬合底噪同值 —— 一台仪器，一个底噪。 */
export const Z_NOISE_FLOOR_A = 1e-12

/**
 * 收敛带从**决策阈值**（`z_recede_min_nm`）派生，而不是在它旁边另配一个 ——
 * 两者并不独立：带必须比阈值更紧，否则一个读数可以被判成「已稳定」，
 * 而它仍在漂移、漂的量足够翻转它正要去喂的那个结论。
 *
 * 一半是「残余运动不可能解释掉整整一个阈值的答案」这个条件下最松的取值。
 * 派生还顺带意味着：一个为噪声大的机器调高了阈值的操作员，**免费**得到一条配套的带 ——
 * 第二个配置键会悄悄停在旧值上，而那正是限值与它的量纲漂开的方式。
 */
export const TOL_FRACTION_OF_THRESHOLD = 0.5

/**
 * 轮询节奏与窗口长度。0.1 s × 5 个样本 = 0.5 s 的窗口。
 *
 * 给个尺度：上面实测的斜坡约 110 nm/s，也就是每个窗口约 55 nm 的行程，
 * 对着默认 0.5 nm 的带 —— 「在走」与「到了」之间隔着两个数量级，
 * 这才是这条判据对 Z 噪声**稳健**而不是**敏感**的原因。
 */
export const DEFAULT_POLL_S = 0.1
export const DEFAULT_WINDOW_N = 5

/** 五种结局的人话。**逐字** —— 它们会出现在操作员眼前。 */
export const Z_SETTLE_STATE_LABELS: Readonly<Record<string, string>> = {
  tracking: '已稳定,反馈正握着隧道结(Z 是真实的间距读数)',
  out_of_range: '已稳定在压电极限,量程内没有表面(Z 是下界,不是距离)',
  moving: '超时:Z 还在走,没有可读的稳定值',
  unreadable: '读不到 Z',
  aborted: '被中止',
}

export type ZSettleState = 'tracking' | 'out_of_range' | 'moving' | 'unreadable' | 'aborted'

/**
 * 一次 settle 的结果。**`usable` 是判据唯一可以分支的东西。**
 *
 * 其余每一项存在的理由都是：一次**产不出读数**的运行要说出它看到了什么，
 * 而不是悄悄递过去一个数。
 */
export interface ZSettle {
  zM: number | null
  currentA: number | null
  setpointA: number | null
  /**
   * `setpointA === null` 时，**为什么**读不到。空串 = 读到了。
   *
   * 下游的危险判据是**相对的**，没有 setpoint 就退化 —— 而在此之前「读不到」这件事
   * 一个理由都没留，于是没人查得下去（2026-08-10 真机）。
   */
  setpointWhy: string
  settled: boolean
  state: ZSettleState
  elapsedS: number
  samples: number
  tolM: number
  timeoutS: number
  /** 最后一个窗口上的**净**漂移 —— 判据测的就是这个量。 */
  driftM: number | null
  /** settle 开始以来看到的总行程。把「到了」和「从没开始」分开。 */
  excursionM: number | null
  /**
   * 开始时 `ZCtrl_OnOffGet` 说了什么。`null` = 读不到。**永不作为闸**
   * （实时控制器按设计滞后于写入）—— 它在这里是为了让一次超时能说出反馈到底合没合上。
   */
  loopConfirmedOn: boolean | null
}

/** 一个空壳（每个字段的初值与旧仓 dataclass 默认实参逐字对应）。 */
export function newZSettle(tolM: number, timeoutS: number): ZSettle {
  return {
    zM: null,
    currentA: null,
    setpointA: null,
    setpointWhy: '',
    settled: false,
    state: 'unreadable',
    elapsedS: 0.0,
    samples: 0,
    tolM,
    timeoutS,
    driftM: null,
    excursionM: null,
    loopConfirmedOn: null,
  }
}

/**
 * 退针判据可以拿这个 Z 去和另一个比吗？
 *
 * 只有收敛了的读数才算。一个半途中的 Z 不是一个**更差**的间距测量 ——
 * 它是一个**时间**的测量。
 */
export function zSettleUsable(s: ZSettle): boolean {
  return s.settled && s.zM !== null && (s.state === 'tracking' || s.state === 'out_of_range')
}

/** 稳定了，而压电够得着的范围里什么都没有（Z 是界，不是间距）。 */
export function zSettleAtRail(s: ZSettle): boolean {
  return s.settled && s.state === 'out_of_range'
}

/**
 * 这个读数是一把**尺子**吗 —— 一个真实的针尖–样品距离？
 *
 * 刻意比 {@link zSettleUsable} 更窄。到轨的读数是可用的（可以比，也仍然能揭示一次逼近），
 * 但它是一个界，所以两个界分不出「台子移出了量程」和「台子根本没动」。
 * 只有两个间距读数分得出 —— 而那正是让一个量到的零表示**零位移**
 * 而不是**没有测量**的东西，也正是「没位移」那道守卫赖以成立的区别。
 */
export function zSettleMeasuresGap(s: ZSettle): boolean {
  return s.settled && s.state === 'tracking'
}

/** 给操作员的一行：发生了什么，以及失败时该去做什么。 */
export function zSettleWhy(s: ZSettle): string {
  const base = Z_SETTLE_STATE_LABELS[s.state] ?? s.state
  if (s.state === 'moving') {
    let rate = ''
    if (s.driftM !== null && s.samples > 1) {
      rate = `,最后一个窗口仍在以 ~${(Math.abs(s.driftM) * 1e9).toFixed(1)} nm/窗口 移动`
    }
    let loop = ''
    if (s.loopConfirmedOn === false) {
      loop =
        '。**实时控制器在开始时回报 Z 反馈是断开的** —— ' +
        '先查 Z 反馈开关是否真的合上了,而不是加大预算'
    } else if (s.loopConfirmedOn === null) {
      loop = '。(无法读回 Z 反馈开关状态,不能排除反馈根本没合上)'
    }
    return (
      `${base}(等了 ${s.elapsedS.toFixed(1)}s / 预算 ${s.timeoutS.toFixed(1)}s,` +
      `稳定判据 ${(s.tolM * 1e9).toFixed(2)} nm${rate})${loop}`
    )
  }
  if (s.state === 'out_of_range') {
    return (
      `${base};已等 ${s.elapsedS.toFixed(1)}s,` +
      `压电共走了 ${(Math.abs(s.excursionM ?? 0.0) * 1e9).toFixed(0)} nm`
    )
  }
  if (s.state === 'tracking') {
    return `${base};已等 ${s.elapsedS.toFixed(1)}s,|I| = ${formatG(Math.abs(s.currentA ?? 0.0), 3)} A`
  }
  if (s.state === 'unreadable') {
    return (
      `${base}(ZCtrl_ZPosGet 连试 ${s.samples} 次都没有可解析的读数)` +
      ' —— 这是读回链路的问题,不是等得不够久,加大预算没有用'
    )
  }
  return base
}

/** 进台账的那一份。`setpoint` 与「为什么没读到」都在里面（2026-08-10 现场想查却没有）。 */
export function zSettleDict(s: ZSettle): Record<string, unknown> {
  return {
    z_m: s.zM,
    current_a: s.currentA,
    setpoint_a: s.setpointA,
    setpoint_why: s.setpointWhy,
    settled: s.settled,
    state: s.state,
    usable: zSettleUsable(s),
    elapsed_s: pyRound(s.elapsedS, 3),
    samples: s.samples,
    tol_m: s.tolM,
    timeout_s: s.timeoutS,
    drift_m: s.driftM,
    excursion_m: s.excursionM,
    loop_confirmed_on: s.loopConfirmedOn,
    why: zSettleWhy(s),
  }
}

/**
 * 这台机器声明的「让反馈找到表面」的预算。
 *
 * 一个**预算**，不是物理常数 —— 所以超了之后要把实测漂移率摆在它旁边一起报，
 * 就像 `ZControllerOnOff` 把 `waited_s` 摆在这台机器自己的关断延时旁边一样。
 * 那两个数才分得开「我们放弃得太早」和「这个环根本没在动」，
 * 而一次两个都不印的超时只会让操作员去猜。
 */
export function settleTimeoutS(): number {
  return getConfigNum('z_settle_timeout_s', 20.0)
}

/** 收敛带，从决策阈值派生。见 {@link TOL_FRACTION_OF_THRESHOLD}。 */
export function settleToleranceM(): number {
  const thresh = getConfigNum('z_recede_min_nm', 1.0) * 1e-9
  return Math.max(TOL_FRACTION_OF_THRESHOLD * thresh, 0.0)
}

/**
 * 一个窗口满了之后的收敛判定。**纯**。
 *
 * 净漂移而不是峰峰值：随机噪声不会累积成一个净位移，而一条斜坡会 ——
 * 所以这测的是**运动**而不是安静。一个噪但静止的 Z 过得去；一条平滑的慢斜坡过不去。
 */
export function zConverged(
  driftM: number,
  tolM: number,
  currentA: number | null,
  excursionM: number,
): { readonly settled: boolean; readonly state: 'tracking' | 'out_of_range' | null } {
  const tracking = currentA !== null && Math.abs(currentA) > Z_NOISE_FLOOR_A
  const travelled = excursionM > tolM
  // 见抬头第 2 条：「不动」对一个还没开始的环同样成立。要么有活的结，要么有压电
  // 确实去过某处的证据。
  if (driftM <= tolM && (tracking || travelled)) {
    return { settled: true, state: tracking ? 'tracking' : 'out_of_range' }
  }
  return { settled: false, state: null }
}

// ── 梯子（纯算术） ──────────────────────────────────────────────────────────

/**
 * 换样品退针的梯子：1 → 10 → 100 →（剩余，按单次上限分块），总数不超过 `total`。
 *
 * 第一级是一步，因为那是**最小风险的探针**：一个粗动步远小于压电量程，
 * 所以即使方向配反了，走一步之后开反馈也能把那点逼近吸收掉 ——
 * 我们以一步的代价知道了方向是错的。
 */
export function retractLadder(total: number, stepMax: number): number[] {
  const tot = Math.max(1, Math.trunc(total))
  const smax = Math.max(1, Math.min(1000, Math.trunc(stepMax)))
  const rungs: number[] = []
  const sum = (): number => rungs.reduce((a, b) => a + b, 0)
  for (const probe of [1, 10, 100]) if (sum() + probe <= tot) rungs.push(probe)
  let remaining = tot - sum()
  while (remaining > 0) {
    const chunk = Math.min(smax, remaining)
    rungs.push(chunk)
    remaining -= chunk
  }
  return rungs
}

/** 横移前清障的梯子：1 → 10 → 剩余（每块 100）。同一条「一步探针」的理由。 */
export function clearanceLadder(total: number): number[] {
  const tot = Math.max(0, Math.trunc(total))
  const out: number[] = []
  const sum = (): number => out.reduce((a, b) => a + b, 0)
  for (const probe of [1, 10]) if (sum() + probe <= tot) out.push(probe)
  let remaining = tot - sum()
  while (remaining > 0) {
    const n = Math.min(100, remaining)
    out.push(n)
    remaining -= n
  }
  return out
}

// ── 两台方向判定机 ─────────────────────────────────────────────────────────

export type RecedeVerdict = 'receding' | 'approaching' | 'ambiguous' | 'unsettled' | 'no_sign'
export interface RecedeJudgement {
  readonly verdict: RecedeVerdict
  readonly why: string
}

/** 退针时电流应当 ~0：高出 setpoint 这个倍数就是在**逼近**。 */
export const DANGER_CURRENT_MULT = 3.0
/** 没有相对量时那条绝对地板（1 nA）。⚠️ 它是照成像条件（~100 pA）定的。 */
export const DANGER_CURRENT_ABS_A = 1e-9

/**
 * **梯子版**方向判定（`RetractForSampleChange` 用）。
 *
 * 主证据是 Z 压电方向（伸长 = 在追一个更远的样品 = 在远离）；电流只在反方向上
 * 当危险跳闸用 —— 针尖一旦远了，电流衰减到 ~0，**不带符号**。
 *
 * **两个读数都必须收敛。** 拿别的东西比测的是等待时间，不是间距 —— 那就是 08-04 的缺陷。
 * 一个取不到的读数返回 `unsettled`，**而它不是 `approaching`**：
 * 把「针尖在逼近」和「这条检查没能跑」压成一个答案，正是让一个坏掉的判据
 * 看起来和一条接反的线一模一样的原因。
 *
 * ⚠️ **与 {@link judgeRecedeClearance} 刻意不合并。** 那一台演化得更细（它会说出
 * 阈值由哪一项决定、有一条与工作点无关的满量程退路、会把「电流这条没判」写进结论）。
 * 旧仓就是两个函数，而**两个看起来一样的东西，正是将来有人重构时最想合并的东西**
 * （D-CHANNELS-1 / D-PIEZO-1 同一条）。合并的代价是把一边的措辞悄悄搬到另一边的现场上。
 */
export function judgeRecedeLadder(
  baseline: ZSettle | null,
  after: ZSettle,
  setpointA: number | null,
): RecedeJudgement {
  const current = after.currentA
  const sp = setpointA !== null ? setpointA : after.setpointA
  // 电流跳闸排在 Z 分支前面，正因为它**不需要**一个收敛的读数。
  if (current !== null && Math.abs(current) > Z_NOISE_FLOOR_A) {
    const dangerBySp = sp !== null && Math.abs(sp) > 0 && Math.abs(current) > DANGER_CURRENT_MULT * Math.abs(sp)
    if (dangerBySp || Math.abs(current) > DANGER_CURRENT_ABS_A) {
      return {
        verdict: 'approaching',
        why: `|I|=${pyExpFixed(Math.abs(current), 2)} A 远高于退针时应有的~0`,
      }
    }
  }

  if (!zSettleUsable(after)) return { verdict: 'unsettled', why: zSettleWhy(after) }
  if (baseline === null || !zSettleUsable(baseline)) {
    return {
      verdict: 'unsettled',
      why: '基线 Z 不可用:' + (baseline !== null ? zSettleWhy(baseline) : '没有基线读数'),
    }
  }

  const zMinM = getConfigNum('z_recede_min_nm', 1.0) * 1e-9
  // **没声明就不判**（2026-08-11）：出厂 `+1` 不是保守值，是两个互斥答案里的一个。
  const sign = zExtendSignOrNone()
  if (sign === null) return { verdict: 'no_sign', why: NO_SIGN_WHY }
  const dz = ((after.zM as number) - (baseline.zM as number)) * sign

  if (zSettleAtRail(after) && zSettleAtRail(baseline)) {
    return {
      verdict: 'ambiguous',
      why: '退针前后压电都到极限、量程内都没有表面 —— 与远离一致,但证明不了距离(也无逼近迹象)',
    }
  }
  if (dz > zMinM) {
    if (zSettleAtRail(after)) {
      return {
        verdict: 'receding',
        why: `压电走到极限仍未找到表面,较基线至少远离 ${(dz * 1e9).toFixed(2)} nm(极限值,实际更远)`,
      }
    }
    return { verdict: 'receding', why: `开反馈后 Z 朝伸长方向移动 ${(dz * 1e9).toFixed(2)} nm（在追更远的样品）` }
  }
  if (dz < -zMinM) {
    if (zSettleAtRail(baseline)) {
      return {
        verdict: 'approaching',
        why:
          `基线时量程内还没有表面,退针后反而找到了` +
          `(Z 缩回 ${(Math.abs(dz) * 1e9).toFixed(2)} nm)—— 针尖是靠近了`,
      }
    }
    return { verdict: 'approaching', why: `开反馈后 Z 朝缩回方向移动 ${(Math.abs(dz) * 1e9).toFixed(2)} nm（样品变近了）` }
  }
  return { verdict: 'ambiguous', why: 'Z 走向不明显，未确认但也无逼近迹象' }
}

/** 没声明 `z_extend_sign` 时那句话，**两台判定机共用一份**（旧仓两处逐字相同）。 */
export const NO_SIGN_WHY =
  '本机没有声明「压电伸长(趋向样品)对应 Z 读数符号」' +
  '(设置 → 退针 → `z_extend_sign`),Z 读数变化无法翻译成「在远离还是在靠近」'

/** Python `f"{x:.Ne}"`（指数两位）。`pyExp` 住在技能层，内核这边自带一份。 */
function pyExpFixed(v: number, digits: number): string {
  const s = v.toExponential(digits)
  const i = s.indexOf('e')
  let exp = s.slice(i + 1)
  const sign = exp.startsWith('-') ? '-' : '+'
  if (exp.startsWith('-') || exp.startsWith('+')) exp = exp.slice(1)
  if (exp.length < 2) exp = `0${exp}`
  return `${s.slice(0, i)}e${sign}${exp}`
}

/** {@link judgeRecedeClearance} 的第二个返回物：电流这条**判没判**。 */
export interface ClearanceJudgement extends RecedeJudgement {
  /** 电流那条被跳过时的那段话（会拼进 `why`）。空串 = 没跳过。 */
  readonly currentTripNote: string
}

/**
 * **清障版**方向判定（`RelocateCoarseXY` 用）。见 {@link judgeRecedeLadder} 的
 * 「刻意不合并」那一段。
 *
 * 比梯子版多三件，每一件都是 2026-08-10 真机买来的：
 *
 * 1. **阈值由哪一项决定必须写进结论。** 当天这条判据把外环停在换位上，
 *    诊断是「退针方向很可能搞反了,请核对 z_extend_sign」—— 一句**自信而具体的错话**。
 *    报文里只有一个数（「阈值 1e-09 A」），而 `max(3×setpoint, 1e-9)` 的这个结果
 *    与两种完全不同的情况都相容（setpoint 没读到 ⇒ 相对项塌成 0 ⇒ 地板赢；
 *    setpoint = 1e-10 ⇒ 相对项 3e-10 < 地板 ⇒ 地板赢，而纯相对判据同样会触发）。
 *    一个数分不出这两件事。
 * 2. **读不到 setpoint 时退回一个与工作点无关的界**（前放满量程）：
 *    「电流大到放大器已经饱和」与「你打算跑在多少 pA」完全无关，所以它在任何工作点上
 *    都成立；而 1e-9 那个地板不是 —— 它是照成像条件定的，拿它去判一个刻意跑在 1 nA
 *    的流程，得到的不是保守，是**换了个量在回答另一个问题**。
 *    读不到满量程就**不用电流这条**，落到 Z 比较（Z 方向本来就是主证据）。
 *    **刻意不返回 `unsettled`**：那个词对上层的意思是「Z 读数取不到」，
 *    它的处方是「调大 z_settle_timeout_s」—— 对着一个 setpoint 读不到的毛病开那张方子，
 *    又是一次把人指向没坏的东西。
 * 3. **跳过一条判据必须出现在结论里**：否则「电流没超」与「电流这条没判」长得一模一样。
 */
export function judgeRecedeClearance(baseline: ZSettle, after: ZSettle): ClearanceJudgement {
  let note = ''
  const current = after.currentA
  const setpoint = after.setpointA !== null ? after.setpointA : baseline.setpointA

  if (current !== null && Math.abs(current) > Z_NOISE_FLOOR_A) {
    const floor = 1e-9
    const rel = setpoint === null ? null : 3.0 * Math.abs(setpoint)
    if (setpoint === null) {
      // `setpoint or 0.0` 在旧仓被特意拆开过：`or` 把 `None` 与 `0.0` 一视同仁，
      // 而「读不到」与「读出来是零」在本仓是必须分开的两句话。
      const fsRaw = getConfigNum('preamp_full_scale_a', Number.NaN)
      const fullScale = Number.isFinite(fsRaw) && fsRaw !== 0 ? fsRaw : null
      if (fullScale !== null && Math.abs(current) >= fullScale) {
        return {
          verdict: 'approaching',
          currentTripNote: '',
          why:
            `电流 ${formatG(Math.abs(current), 3)} A 已达前置放大器满量程 ` +
            `${formatG(fullScale, 3)} A —— 放大器饱和,与工作点无关。` +
            '(读不到 setpoint,所以用的是这个与工作点无关的界,不是相对判据。)',
        }
      }
      const whyNoSp = after.setpointWhy || baseline.setpointWhy || '两次读数都没有留下原因'
      note =
        `(电流 ${formatG(Math.abs(current), 3)} A 这一条**没判**:读不到 setpoint` +
        `[${whyNoSp}],相对判据 3×setpoint 无从算起;` +
        (fullScale !== null
          ? `满量程界 ${formatG(fullScale, 3)} A 也没超。`
          : '而 instrument_profile 也没声明 preamp_full_scale_a,没有与工作点无关的界可用。') +
        '已改用 Z 压电方向这条**主证据**。)'
    } else {
      const bar = Math.max(rel as number, floor)
      if (Math.abs(current) > bar) {
        const which = (rel as number) >= floor ? '相对项 3×setpoint' : '绝对地板'
        const settled = zSettleUsable(after) ? '读数已收敛' : `⚠️ **这次读数未收敛**(${zSettleWhy(after)})`
        return {
          verdict: 'approaching',
          currentTripNote: '',
          why:
            `电流 ${formatG(Math.abs(current), 3)} A 高于阈值 ${formatG(bar, 3)} A` +
            `(由**${which}**决定:setpoint 读到 ${formatG(setpoint, 3)} A,` +
            `相对项 ${formatG(rel as number, 3)} A,地板 ${formatG(floor, 3)} A);${settled}`,
        }
      }
    }
  }

  const say = (verdict: RecedeVerdict, why: string): ClearanceJudgement => ({
    verdict,
    why: note !== '' ? why + note : why,
    currentTripNote: note,
  })

  if (!zSettleUsable(after)) return say('unsettled', zSettleWhy(after))
  if (!zSettleUsable(baseline)) return say('unsettled', '基线 Z 不可用:' + zSettleWhy(baseline))

  const sign = zExtendSignOrNone()
  if (sign === null) return say('no_sign', NO_SIGN_WHY)
  const dz = ((after.zM as number) - (baseline.zM as number)) * sign
  const thresh = getConfigNum('z_recede_min_nm', 1.0) * 1e-9

  if (zSettleAtRail(after) && zSettleAtRail(baseline)) {
    return say(
      'ambiguous',
      '退针前后压电都到极限、量程内都没有表面 —— 与远离一致,但两次都是极限值,证明不了距离(没有逼近迹象)',
    )
  }
  if (dz > thresh) {
    if (zSettleAtRail(after)) {
      return say('receding', `压电走到极限仍未找到表面,较基线至少远离 ${(dz * 1e9).toFixed(1)} nm(极限值,实际更远)`)
    }
    return say('receding', `Z 压电伸长 ${(dz * 1e9).toFixed(1)} nm(在追远离的样品)`)
  }
  if (dz < -thresh) {
    if (zSettleAtRail(baseline)) {
      return say(
        'approaching',
        `基线时量程内还没有表面,退针后反而找到了(Z 缩回 ${(Math.abs(dz) * 1e9).toFixed(1)} nm)—— 针尖是靠近了`,
      )
    }
    return say('approaching', `Z 压电缩回 ${(Math.abs(dz) * 1e9).toFixed(1)} nm`)
  }
  return say('ambiguous', 'Z 压电几乎没动')
}

/**
 * 拒绝的同时把**处方**给出来，而且按**是哪条证据**给。
 *
 * 照同一个文件里那条写得好的守卫的形状（「落点会压在已经去过的站点上……
 * **用 get_coarse_map 取一个可用的方向/步数**」：它把人指向解决办法）。
 *
 * ⚠️ 2026-08-11 更正：这段原来还写着「(方向是好的)」。那个结论的依据是同日
 * `RetractForSampleChange` 判了 `receding` —— 而 `receding` 正是 `z_extend_sign`
 * 翻译出来的**结果**，**用被解释项去验证解释**。方向其实是坏的。
 */
export function approachPrescription(why: string): string {
  const fromCurrent = why.includes('阈值') || why.includes('满量程')
  if (!fromCurrent) {
    return (
      '—— 压电缩回就是针尖靠近了。请核对 instrument_profile 的' +
      '退针方向 / z_extend_sign(**方向很可能配反**),再重试换区。'
    )
  }
  return (
    '\n**下一步按上面那句话里的依据分**:\n' +
    '• 若写着「未收敛」——反馈可能还在追,先把设置页的' +
    '「退针 Z 稳定预算」(z_settle_timeout_s)调大再重试;\n' +
    '• 若写着「由**绝对地板**决定」而你的工作点本来就跑在接近 1 nA ——' +
    '那个地板是照成像条件(~100 pA)定的,对这条流程不适用,' +
    '先把工作电流降到成像量级再换区;\n' +
    '• 若写着「由**相对项**决定」且读数已收敛 ——这才是真的在逼近,' +
    '去核对 instrument_profile 的退针方向 / z_extend_sign。'
  )
}

/** 清障梯子上的一级，进「没位移」那道守卫的那几列。 */
export interface ClearanceRung {
  readonly hasRuler: boolean
  readonly dzM: number | null
}

/**
 * 粗动马达收下了我们的命令，而台子**一点没动**吗？
 *
 * 一台马达可以接受 `Motor_StartMove`、返回成功、而样品台纹丝不动 ——
 * 粗逼近高压关着、驱动幅度低于起滑阈、该轴走到行程尽头、机械卡死。
 * 这条组合里没有别的东西会注意到：`Motor_StepCounterGet` 在大多数控制器上不支持，
 * 而移动中的电流看护只回答「有没有东西碰着针尖」，那对一台从没动过的台子同样成立。
 * 于是整趟会报成功，而里程表会记下一次**没有发生**的换位 ——
 * 之后每一次「我们在这儿扫过吗」都建立在一个从未进入过的坐标系上。
 *
 * ## 它建立在哪条区别上
 *
 * 「我们测不出来」与「我们测出来是零」是两个不同的事实，而把它们写成一个词，
 * 正是让一个坏掉的检查看起来像一个正常结果的原因（同 `unsettled` vs `approaching`）。
 *
 * 所以它**不**在 `ambiguous` 上触发。它在「有一把好用的尺子而且量出了零」上触发：
 * 基线与该级都在**握着真实隧道结**的状态下稳定，于是压电两端量的都是真实的
 * 针尖–样品距离，而那个距离没有变。
 *
 * 换成「每一级都 ambiguous 就拒」会是错的，反例还很常见：一根**起点就在压电量程外**
 * 的针给出到轨的基线与到轨的每一级 —— 合法地每次都 ambiguous —— 而马达工作得好好的。
 * 换样品退针之后、进针失败之后、手动退针之后，都是这个样子。
 *
 * ## 为什么它不需要模式开关
 *
 * 这道守卫只在它要检测的那种情形里适用：
 *
 * - 马达能动 → 针尖一两级之内就离开压电量程 → 到轨读数 → 没尺子 → 它**弃权**（不可能误报）；
 * - 马达死了 → 针尖整条梯子都留在量程内 → 每级都 tracking → 它开火。
 *
 * ## 累计，不是逐级
 *
 * 第一级只有一步，而黏滑行程在低温下缩得厉害，所以一步**合法地**可能低于阈值。
 * 逐级否决会在那里误报。`dzM` 是对着**共享基线**量的，所以最后一级的值已经是整条梯子
 * 的总行程 —— 第 2、3 级是 10 步和 89 步，10–100 倍的量。
 */
export function noDisplacement(
  rungs: readonly ClearanceRung[],
  commandedSteps: number,
): { readonly stuck: boolean; readonly why: string } {
  if (rungs.length === 0 || !rungs.every((r) => r.hasRuler)) return { stuck: false, why: '' }
  const dz = rungs[rungs.length - 1]?.dzM ?? null
  if (dz === null) return { stuck: false, why: '' }
  const thresh = getConfigNum('z_recede_min_nm', 1.0) * 1e-9
  if (Math.abs(dz) > thresh) return { stuck: false, why: '' }
  return {
    stuck: true,
    why:
      `粗动马达没有产生位移:下了 ${commandedSteps} 步退针命令,` +
      `而压电全程都握着隧道结、量到的总位移只有 ${(Math.abs(dz) * 1e9).toFixed(2)} nm` +
      `(阈值 ${(thresh * 1e9).toFixed(2)} nm)。` +
      '**这不是「测不出来」,是「测出来是零」** —— 每一级的基线与退针后读数都' +
      '稳定在真实隧道结上,尺子是好的,它说台子没动。\n' +
      '常见原因:**粗逼近高压没开**(压电马达靠高压黏滑步进,高压没了' +
      '`Motor_StartMove` 照样返回成功)、驱动幅度低于起动阈、' +
      '该轴走到行程尽头空滑、机械卡死。\n' +
      '已停止粗动并撤针,**本次不计入粗动里程表**(坐标代次不推进,' +
      '粗动大地图不加站点)—— 记下一次没发生的位移,比不换区危险得多。',
  }
}
