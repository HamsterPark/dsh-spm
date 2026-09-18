/**
 * `RelocateCoarseXY` —— 把样品台**横向**粗动到一片新表面，安全地。
 *
 * ## 为什么存在
 *
 * 「要不要换区」早就有人能回答；真正去做的动作一直是一条裸的
 * `MotorMove(direction='x+', steps=N)`：
 *
 * - 它唯一的前置是 `state.withdrawn` —— **细 Z 压电**在高位，一两微米 ——
 *   而这个检查在状态未知时也会通过；
 * - 它从不把粗动 Z 马达退回去，而几十微米的真实间隙正是从那里来的；
 * - 它不看腔体压强，而让粗动压电穿过 Paschen 带就是在叠堆上打电弧；
 * - 它不看驱动幅度当前被设成了多少；
 * - 它发一条阻塞的 `Motor_StartMove` 然后在它返回之前什么都不看；
 * - 它不留下任何「台子已经去过样品上哪些地方」的记录。
 *
 * 操作员对这个缺口的总结很精确：
 * *「比如xy位移前要退针100步以免撞针这种事情llm现在是不知道的。」*
 *
 * ## 五个相
 *
 * `preflight` → `clear` → `move` → `verify` → `reapproach`
 *
 * `clear` 是有意思的那个。它复用退针梯子的**想法**而不是它的代码路径：走一步，
 * 然后开反馈看 Z 压电往哪边走。配置的方向是一个**意图**；运行时自检才是真正的
 * 防撞守卫，而第一级只有一步，所以一个装反的配置只要一步就能被发现。
 *
 * 脱离随后被**确认**，不是被假定：电流必须在噪声底，而在有 qPlus 传感器的机器上，
 * 振荡振幅必须回到接近自由值。第二个证人回答的是电流答不了的那个问题 ——
 * 电流在针尖很远时是零，在前放坏掉时也是零，而振幅回答的是
 * 「针尖机械上自由吗」。
 *
 * `move` 分块走，每块之间看一眼：一次几百步的阻塞移动是几百步**无人看管**。
 *
 * ## 三件会咬到后来编辑者的事
 *
 * 1. **这条组合直接用 `safeCall` 发 `Motor_StartMove`**（和 `RetractForSampleChange`
 *    一样），以免继承 `MotorMove` 写死的语义。于是记录器看不到 `MotorMove` 的载荷 ——
 *    宿主那边的横向粗动技能名单必须包含它，否则台子动了、每一个记下来的坐标都失去意义，
 *    而坐标代次不会推进去说明这件事。
 * 2. **结果必须在 `data` 里报 `direction` 与 `steps`。** 那是记录器写 `coarse_move`
 *    标记的依据，而那个标记是粗动地图里程表唯一的来源。
 * 3. **……以及 `lateral_steps_taken`，因为一次失败的组合同样移动了台子。**
 *    2026-08-05 之前，失败时整份结果被丢弃，于是一次滑了 301 步然后重新进针失败的运行
 *    让里程表、粗动地图、坐标代次**全部**描述着样品**已经离开**的那个位置 ——
 *    物理台子与之后每一个计划之间，静静地差了 301 步。
 *    `steps` 自己扛不住这个意思：失败路径上读的人得知道哪些失败发生在移动前、
 *    哪些在移动后。`lateral_steps_taken` 是那句明说的承诺
 *    （「台子物理上走了这么多，无论判决如何」），而且在 `dry_run` 下是 0。
 *
 * ## 与旧仓的差别（各有登记）
 *
 * - **落点复核（`io/coarse_map` 604 行 + `coarse_map_provider`）不移植。**
 *   旧仓那段本来就包在 try/except、失败即放行（「落点复核不可用，放行」），
 *   所以技术上可降级 —— **但降级掉的正是「别回到去过的站点」那条保护**，
 *   而 2026-08-16 那条链断掉的症状是**第二轮把第一轮的坑原路重打了一遍**，
 *   没有任何一处报错。这条在 deviation 里点了名。
 * - **温度只报 `null`**：它来自同一个 provider。它本来就只记录、从不当闸。
 * - **急停失败的记法改了**：本仓 `safeCall` **永不抛**，所以旧仓那个
 *   `except → _panic_failures` 分支在这里会是**死代码**。改成看 `rec.error` ——
 *   而这顺带修了旧仓的一个真缺陷，见 deviation。
 */
import {
  GraphExecutor,
  checkVacuum,
  clearanceLadder,
  formatG,
  getConfig,
  getRetractDirCode,
  judgeRecedeClearance,
  noDisplacement,
  progressToDict,
  readbackMatches,
  verdictDict,
  zSettleDict,
  zSettleMeasuresGap,
  zSettleUsable,
  zSettleWhy,
  zExtendSignOrNone,
  approachPrescription,
  type ClearanceRung,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
  type ZSettle,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { num } from '../l0/common.js'
import { runSubSkill } from './run-sub.js'
import { captureQplusBaseline, qplusFields, qplusRecovered, qplusSaysCrashed } from './tip-evidence.js'
import { settleAndReadZ } from './z-settle.js'

const P_PREFLIGHT = '_phase_preflight'
const P_CLEAR = '_phase_clear'
const P_MOVE = '_phase_move'
const P_VERIFY = '_phase_verify'
const P_REAPPROACH = '_phase_reapproach'

/** 低于此值的「电流」是放大器噪声，不是隧穿。与进针路径的咬合底噪同值。 */
const NOISE_FLOOR_A = 1e-12

/** 横移期间针尖应该什么都看不见。台子在滑而电流高于这个值 ⇒ 脱离不是真的；立刻停。 */
const MOVE_DANGER_CURRENT_A = 1e-11

/**
 * 横移期间把结偏压降到这个值。**这不是「顺手调小一点」，是这道检查能不能用的前提。**
 *
 * 2026-08-28 真机：横移带着成像偏压 2.0 V 时，针尖离表面几十 nm 就**场发射**，
 * 电流读到 100+ pA —— 远超上面那条 10 pA 的危险线，于是每次粗动都在第 20–50 步
 * 被判「针尖离表面太近」而中止。同一根针尖、同一位置、只改偏压：
 *
 * ```
 * +2.00 V → 102.4 pA   （超阈值，粗动被拒）
 * +1.00 V →   0.13 pA
 * +0.50 V →  -0.00 pA  （降到这里后 x+ 20 步一次通过）
 * ```
 *
 * 场发射是**真电流**不是串扰，所以拦截判得没错 —— 错的是让针尖带着 2 V 去横移。
 * 与扎针前自动降到 20 mV 同一个道理：**动作开始前先把工作点设成这个动作需要的样子，
 * 别沿用上一个动作留下的。**
 */
const MOVE_BIAS_V = 0.5

const DIRECTIONS: Readonly<Record<string, string>> = {
  'x+': 'x+',
  'x-': 'x-',
  'y+': 'y+',
  'y-': 'y-',
}
/** Nanonis `Motor_StartMove` 的方向码。 */
const DIR_CODE: Readonly<Record<string, number>> = { 'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3 }

function directionOf(axis: unknown, sign: unknown): string | null {
  return DIRECTIONS[`${String(axis)}${String(sign)}`] ?? null
}

export const RELOCATE_POLL_INTERVAL_S = 0.1
export const RELOCATE_SETTLE_WINDOW_N = 5

class Relocate {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  readonly #rungs: Record<string, unknown>[] = []
  readonly #watches: Record<string, unknown>[] = []
  /** 急停动作里**没能下发**的那些。空 = 都发出去了。 */
  readonly #panicFailures: string[] = []
  #ex!: GraphExecutor
  #movedSteps = 0
  #baselineSettle: Record<string, unknown> | null = null
  #checks: Record<string, unknown> = {}
  #clearance: Record<string, unknown> = {}
  #temperatureK: number | null = null
  /** 横移前被本流程降下去的偏压原值；`null` = 没降过 / 已放回。 */
  #biasRestore: number | null = null

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  // ── plan ──────────────────────────────────────────────────────────────

  #plan(): CompositeStep[] {
    const asked = this.#params['prewithdraw_steps']
    const pre =
      typeof asked === 'number' && Number.isInteger(asked) && asked >= 0
        ? asked
        : Math.trunc(Number(getConfig('xy_prewithdraw_steps', 100)))
    const chunk = Math.max(1, Math.trunc(Number(getConfig('xy_move_chunk_steps', 50))))
    const total = Math.trunc(Number(this.#params['steps'] ?? 0))

    const steps: CompositeStep[] = [
      {
        stepId: 'preflight',
        skillName: P_PREFLIGHT,
        params: { ...this.#params },
        optional: false,
        checkpointAfter: true,
        tags: ['check'],
      },
      {
        stepId: 'clear',
        skillName: P_CLEAR,
        params: { prewithdraw_steps: pre },
        optional: false,
        checkpointAfter: true,
        tags: ['withdraw', 'verify'],
      },
    ]
    // 分块，好让两次爆发之间有东西在看。一次 `total` 步的阻塞 `Motor_StartMove`
    // 就是 `total` 步的「没有任何东西能注意到脱离不对劲」。
    let done = 0
    let idx = 0
    while (done < total) {
      const n = Math.min(chunk, total - done)
      done += n
      steps.push({
        stepId: `move_${idx}_${n}`,
        skillName: P_MOVE,
        params: {
          steps: n,
          index: idx,
          cumulative: done,
          total,
          axis: this.#params['axis'],
          direction: this.#params['direction'],
          dry_run: this.#params['dry_run'] === true,
        },
        optional: false,
        checkpointAfter: true,
        tags: ['move', 'watch'],
      })
      idx += 1
    }

    steps.push({ stepId: 'verify', skillName: P_VERIFY, params: {}, optional: true, checkpointAfter: true, tags: ['read'] })
    if (this.#params['reapproach'] !== false) {
      steps.push({
        stepId: 'reapproach',
        skillName: P_REAPPROACH,
        params: { dry_run: this.#params['dry_run'] === true },
        optional: false,
        checkpointAfter: true,
        tags: ['approach'],
      })
    }
    return steps
  }

  #phase(name: string, params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    if (name === P_PREFLIGHT) return this.#preflight(params)
    if (name === P_CLEAR) return this.#clear(Math.trunc(Number(params['prewithdraw_steps'] ?? 100)))
    if (name === P_MOVE) return this.#move(params)
    if (name === P_VERIFY) return this.#verify()
    if (name === P_REAPPROACH) return this.#reapproach(params)
    return Promise.resolve({ success: false, error: `Unknown phase: ${name}` })
  }

  // ── preflight ─────────────────────────────────────────────────────────

  /**
   * 任何东西动起来**之前**必须成立的每一条。
   *
   * 按「最便宜且最有决定性的排前面」排序，于是一次拒绝只花一次调用，
   * 并且说的是真正的理由而不是第一个症状。
   */
  async #preflight(params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    const checks: Record<string, unknown> = {}

    // 1. 真空。fail-closed：一个未知的压强正是这道闸要拒的情形 ——
    //    一只看不见的规，与一只在放电带里或在大气里的规，没有任何东西能把它们分开。
    const verdict = checkVacuum()
    checks['vacuum'] = verdictDict(verdict)
    if (!verdict.allow) {
      return { success: false, error: `真空互锁拒绝粗动:${verdict.reason}`, data: { checks } }
    }

    // 2. 驱动幅度**此刻**是多少。声明约束的是 MAST 写什么，它对有人在 Nanonis 界面上
    //    设成了多少一无所知。**读不到就是拒绝** —— 一道看不见的时候会通过的检查不是检查。
    const rec = await this.#ctx.safeCall('Motor_FreqAmpGet', 0)
    const bad = rec.error !== undefined && rec.error !== ''
    const freq = bad ? null : num(rec, 0)
    const amp = bad ? null : num(rec, 1)
    const drive = readbackMatches(amp, freq)
    checks['drive'] = { frequency_hz: freq, amplitude_v: amp, ok: drive.ok, note: drive.reason }
    if (!drive.ok) {
      return { success: false, error: `粗动驱动核对失败:${drive.reason}`, data: { checks } }
    }

    // 3. 落点是否压在去过的站点上。LLM 挑的 `steps`；这里是「别回到去过的地方」
    //    被强制执行的位置 —— 作为地图上的几何，而不是一条要谁记住的规矩。
    checks['destination'] = this.#checkDestination(params)
    if ((checks['destination'] as Record<string, unknown>)['blocked'] === true) {
      return {
        success: false,
        error: '目标落点被拒:' + String((checks['destination'] as Record<string, unknown>)['reason']),
        data: { checks },
      }
    }

    // 4. 值得**记录**而不是当闸的条件。粗动步长强烈依赖温度 —— 同样 100 步在 300 K
    //    走得比 4 K 远得多 —— 所以里程表那一条只有把温度摆在旁边才解释得了。
    checks['temperature_k'] = this.#temperatureK

    // 5. 振幅这个证人到底能不能用？现在就记下来，好让清障相分得开
    //    「针尖不自由」与「我们没有办法知道」。
    checks['qplus'] = await qplusFields(this.#ctx)

    this.#checks = checks
    return { success: true, data: { checks } }
  }

  /**
   * 这次移动会落到一块我们已经用过的表面上吗？
   *
   * ⚠️ **本仓没有粗动大地图**（`io/coarse_map` 604 行 + `coarse_map_provider` 未移植），
   * 所以这一条**永远放行**，与旧仓那条 try/except 降级路径落在同一个分支上。
   * 降级掉的正是「别回到去过的站点」那条保护 —— 见 deviation，那里点了名。
   *
   * `allow_revisit=True` **只**跳过这一条。2026-08-28：操作员要粗动步长的 nm 值，
   * 那需要几步的移动 —— 而每一次这样的移动都落在站点最小间距（200 步）之内，
   * 于是这条检查把它们全拒了。那条规则是**表面预算**规则（「别重复用地面」），
   * 它自己的注释就这么写；它不是安全规则。每一条**是**安全规则的东西 ——
   * 真空互锁、驱动电压读回、扫描已停、粗动 Z 清障梯子、降偏压、电流在噪声底 ——
   * 照跑。
   */
  #checkDestination(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (params['allow_revisit'] === true) {
      return {
        blocked: false,
        reason:
          'allow_revisit=True —— 跳过「别重复访问」这条效率约束' +
          '（标定步长、微调位置这类动作本来就要走回头路）。安全检查一条没跳。',
      }
    }
    return {
      blocked: false,
      reason:
        '落点复核不可用(粗动大地图未移植:io/coarse_map + coarse_map_provider),放行。' +
        '⚠️ **这一趟没有「别回到去过的站点」这条保护** —— ' +
        '2026-08-16 这条链断掉的症状是第二轮把第一轮的坑原路重打了一遍,而且一处都不报错。',
      map_available: false,
    }
  }

  // ── clear ─────────────────────────────────────────────────────────────

  #settle(): Promise<ZSettle> {
    return settleAndReadZ(this.#ctx, {
      pollIntervalS: RELOCATE_POLL_INTERVAL_S,
      windowN: RELOCATE_SETTLE_WINDOW_N,
    })
  }

  /**
   * 把针尖真的挪开，并且在移动**之前**证明它。
   *
   * 只收压电买到约 1 µm。而一个滑动的台子能递上来的是样品倾斜、垂直跳动、
   * 以及针尖自己的长度 —— 几十微米。所以粗动 Z 马达也要退，退的梯子第一级是一步：
   * 如果配置的退针方向反了，一步远小于压电量程，开反馈就能把它揭出来，代价是零。
   */
  async #clear(prewithdrawSteps: number): Promise<StepResult> {
    // ⭐ 降压必须排在**清障与自检之前** —— 清障阶梯本身也在读电流。
    await this.#lowerBiasForMove()

    // 先把通电的东西停掉 —— 一个在跑的 AutoApproach 会和每一个退针步打架，
    // 而一台已经在动的马达不许被重新下令。
    await this.#ctx.safeCall('AutoApproach_OnOffSet', 0)
    await this.#ctx.safeCall('Motor_StopMove')
    await this.#ctx.safeCall('Scan_Action', 1, 0)

    const rungs = this.#rungs
    let baseline: ZSettle | null = null
    if (prewithdrawSteps > 0) {
      // 基线：反馈去找表面时它**停在哪里**？每一级之后问同一个问题，而那个答案
      // 只有在压电停止行走之后才是针尖–样品间距的度量。
      baseline = await this.#settle()
      this.#baselineSettle = zSettleDict(baseline)
      if (baseline.state === 'aborted') {
        return { success: false, error: 'aborted before clearance retract' }
      }
      if (!zSettleUsable(baseline)) {
        // **FAIL CLOSED.** 每一级的判决都是对着这个读数的比较；没有它，梯子会在
        // **完全没有方向检查**的情况下把整个 prewithdraw 走完 ——
        // 那就是这条组合存在来替换掉的那条裸 MotorMove。
        // **拒绝的代价是一次换区；继续的代价是一根针。**
        return {
          success: false,
          error:
            '清障退针自检无法建立基线:' +
            zSettleWhy(baseline) +
            '。方向自检要拿「反馈稳定后的 Z」和退针后的同一个量比,' +
            '基线读不到就整条自检都不成立 —— 不会盲退。' +
            '若本机反馈确实比这个预算慢,到设置页把「退针 Z 稳定预算」' +
            '(z_settle_timeout_s)调大。',
          data: { baseline: zSettleDict(baseline) },
        }
      }

      const dirCode = getRetractDirCode()
      for (const n of clearanceLadder(prewithdrawSteps)) {
        // 粗动马达迈步**之前**先把压电挪开 —— 一个压电还伸着的粗动步正是这条梯子
        // 要防的那次撞针。（下面的 settle 也会退针，但那一次是为了让**测量**
        // 从一个可重复的地方开始；这一次是安全不变式，而它必须在这一行成立。）
        await this.#ctx.safeCall('ZCtrl_Withdraw', 1, -1)
        const rec = await this.#ctx.safeCall('Motor_StartMove', dirCode, n, 0, 1)
        if (rec.error !== undefined && rec.error !== '') {
          return { success: false, error: `清障退针失败(${n} 步):${rec.error}`, data: { rungs } }
        }

        const after = await this.#settle()
        if (after.state === 'aborted') {
          await this.#panic()
          return { success: false, error: 'aborted during clearance retract', data: { rungs } }
        }
        const { verdict, why } = judgeRecedeClearance(baseline, after)
        // 「没位移」那道守卫要的两列，逐级记下来，好让那次拒绝事后可核，
        // 而不是一个谁也重推不出来的结论。
        //
        // `dz_m` 是对着**共享基线**量的，不是对着上一级 —— 所以最后一级的 `dz_m`
        // 已经是整条梯子的**累计**位移。那就是这道守卫不用累加任何东西就成为累计的原因。
        //
        // 符号没声明时 `dz_m` 是 `null` 而不是「用出厂值算出来的数」：
        // 这一列是台账，一个方向可能反了的位移写进台账，事后没人分得出它是哪个方向 ——
        // 而 `noDisplacement` 只用 `abs(dz)`，不受影响。
        const sign = zExtendSignOrNone()
        const hasRuler = zSettleMeasuresGap(baseline) && zSettleMeasuresGap(after)
        const dzM =
          baseline.zM === null || after.zM === null || sign === null
            ? null
            : (after.zM - baseline.zM) * sign
        rungs.push({
          steps: n,
          z_after_m: after.zM,
          current_a: after.currentA,
          verdict,
          reason: why,
          settle: zSettleDict(after),
          has_ruler: hasRuler,
          dz_m: dzM,
        })

        if (verdict === 'approaching') {
          await this.#panic()
          return {
            success: false,
            // **拒绝的同时把处方给出来** —— 照同一个文件里那条写得好的守卫的形状
            //（「落点会压在已经去过的站点上……用 get_coarse_map 取一个可用的方向/步数」：
            // 它把人指向解决办法）。
            error:
              '清障退针自检失败:粗动 ' +
              String(n) +
              ' 步后判定针尖在**逼近**样品(' +
              why +
              ')。已停止粗动并撤针。' +
              approachPrescription(why),
            data: { rungs },
          }
        }
        if (verdict === 'unsettled') {
          // **不是 `approaching`。** 旧代码只可能走到 approaching 那一支，
          // 而那正是让一个坏掉的判据与一条接反的线分不出来的原因。
          await this.#panic()
          return {
            success: false,
            error:
              '清障退针自检**没有得出结论**(不是判定为逼近):' +
              why +
              '。已停止粗动并撤针。这一级读不到稳定的 Z,就无法判断针尖是远离还是靠近;' +
              '继续加大步数正是这条自检要挡住的事。' +
              '若本机反馈确实较慢,到设置页把「退针 Z 稳定预算」(z_settle_timeout_s)调大。',
            data: { rungs },
          }
        }
        if (verdict === 'no_sign') {
          // 与 `unsettled` 同样停梯子，但**处方完全不同**：那一条的方子是
          // 「调大 z_settle_timeout_s」，对着一个没填的符号开那张方子，
          // 又是一次把人指向没坏的东西。
          await this.#panic()
          return {
            success: false,
            error:
              '清障退针自检**无法进行**:' +
              why +
              '。已停止粗动并撤针。这一项没有可用的默认值 —— 出厂给 `+1`,而本机实测是 ' +
              '`-1`(WithdrawTip 后 Z 停在 **正**轨),所以「猜一个」和「猜对了」长得一模一样。' +
              '判法:开反馈让压电去找表面,看 Z 读数往哪边走 —— 那一边就是**伸长**;' +
              '再到设置页 → 退针 → `z_extend_sign` 如实填。',
            data: { rungs },
          }
        }
      }

      // 梯子走完了。台子**真的去了某个地方**吗？
      const { stuck, why } = noDisplacement(rungs as unknown as ClearanceRung[], prewithdrawSteps)
      if (stuck) {
        await this.#panic()
        return { success: false, error: why, data: { rungs } }
      }
    }

    // 横向移动之前把压电收起来。最后一次 settle 把它留在**追着表面**的状态
    //（那正是让读数有意义的东西），所以这一步不是可选的：带着伸出的压电滑动台子，
    // 就是整个相在防的那次撞针。
    await this.#ctx.safeCall('ZCtrl_Withdraw', 1, -1)
    // 横移期间反馈**关掉**：开着的话压电会去追从下面滑过去的表面，
    // 把针尖直接往下送。
    await this.#ctx.safeCall('ZCtrl_OnOffSet', 0)

    const proof = await this.#proveClear()
    if (proof['clear'] === false) {
      await this.#panic()
      return {
        success: false,
        error: '脱离确认失败:' + String(proof['reason']),
        data: { rungs, clearance: proof },
      }
    }

    // 针尖被核实脱离了 —— 自由振荡振幅唯一可知的那一刻。现在就抓；
    // 这就是让撞针探测器不必一辈子报 `no_baseline` 的东西。
    Object.assign(proof, await captureQplusBaseline(this.#ctx, '横向粗动前确认脱离后记录'))

    this.#clearance = proof
    return {
      success: true,
      data: {
        rungs,
        clearance: proof,
        prewithdraw_steps: prewithdrawSteps,
        // 每一级都是对着它判的那个参照。没有它，记录里的逐级判决事后不可证伪。
        baseline: baseline === null ? null : zSettleDict(baseline),
      },
    }
  }

  /**
   * 确认针尖离开了表面。**两个证人，单独哪一个都不够。**
   *
   * 电流归零是必要但弱的 —— 一个坏掉的前放也读零。qPlus 振幅回到自由值是
   * 「针尖机械上自由吗」的直接答案，但很多机器没有这个传感器。所以：
   * 电流必须安静，**并且**振幅要么同意、要么弃权。一个正面说「还被压着」的振幅
   * 会挡住移动，哪怕电流一声不吭。
   */
  async #proveClear(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    const rec = await this.#ctx.safeCall('Current_Get')
    const current = rec.error !== undefined && rec.error !== '' ? null : num(rec, 0)
    out['current_a'] = current
    if (current === null) {
      out['clear'] = null
      out['reason'] =
        '读不到电流,无法确认针尖已脱离。读不到 ≠ 已脱离,但也不足以判定失败 —— 继续依赖退针自检的结论。'
    } else if (Math.abs(current) > NOISE_FLOOR_A * 10) {
      out['clear'] = false
      out['reason'] =
        `退针后电流仍有 ${formatG(Math.abs(current), 3)} A(应到噪声底) —— 针尖可能还在隧穿距离内,**不要横向移动**。`
      return out
    } else {
      out['clear'] = true
      out['reason'] = `电流已到噪声底(${formatG(Math.abs(current), 3)} A)`
    }

    // 「取证没做成」和「没人试过取证」必须是两句话。三态，和 `clear` 同款：
    // True/False = 取到证了；null + note = 试过但没成。
    const { verdict, why } = await qplusRecovered(this.#ctx)
    out['qplus_recovered'] = verdict
    out['qplus_note'] = why
    if (verdict === false) {
      out['clear'] = false
      out['reason'] = why
    } else if (verdict === true && out['clear'] === null) {
      // 电流答不了的时候振幅答了。
      out['clear'] = true
      out['reason'] = why
    }
    return out
  }

  // ── move ──────────────────────────────────────────────────────────────

  /**
   * 一块横向行程，然后看一眼。
   *
   * 台子滑动时电学上**不该**发生任何事：针尖在几十微米外，反馈关着。
   * 所以任何电流都是「脱离不是我们证明的那样」的证据，而正确的反应是
   * **停在半路**，不是跑完再去发现。
   */
  async #move(params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    const n = Math.trunc(Number(params['steps'] ?? 0))
    const direction = directionOf(params['axis'], params['direction'])
    if (direction === null || n <= 0) {
      return { success: false, error: `无效的移动参数:${JSON.stringify(params)}` }
    }
    if (params['dry_run'] === true) {
      this.#movedSteps += n
      return {
        success: true,
        data: { dry_run: true, steps: n, direction, cumulative: params['cumulative'] ?? null },
      }
    }

    const rec = await this.#ctx.safeCall('Motor_StartMove', DIR_CODE[direction] as number, n, 0, 1)
    if (rec.error !== undefined && rec.error !== '') {
      await this.#panic()
      return {
        success: false,
        error: `横向粗动失败(第 ${String(params['index'])} 块,${n} 步):${rec.error}`,
        data: { moved_steps: this.#movedSteps },
      }
    }
    this.#movedSteps += n

    const watch: Record<string, unknown> = { cumulative: params['cumulative'] ?? null }
    const rc = await this.#ctx.safeCall('Current_Get')
    const current = rc.error !== undefined && rc.error !== '' ? null : num(rc, 0)
    watch['current_a'] = current
    if (current !== null && Math.abs(current) > MOVE_DANGER_CURRENT_A) {
      await this.#panic()
      return {
        success: false,
        error:
          `横向移动中检测到电流 ${formatG(Math.abs(current), 3)} A —— ` +
          '针尖离表面太近(清障不足或样品倾斜)。已立即停止粗动并撤针。' +
          `已移动 ${this.#movedSteps} 步。`,
        data: { moved_steps: this.#movedSteps, watch },
      }
    }

    const q = await qplusFields(this.#ctx)
    Object.assign(watch, q)
    if (qplusSaysCrashed(q)) {
      await this.#panic()
      return {
        success: false,
        error:
          '横向移动中 qPlus 振幅塌了 —— 针尖已经接触表面。已立即停止粗动并撤针。' +
          `已移动 ${this.#movedSteps} 步。`,
        data: { moved_steps: this.#movedSteps, watch },
      }
    }

    // 压强可以在移动**过程中**变（泵跳了、阀开了），而剩下的每一块仍然是几百伏的驱动。
    const v = checkVacuum()
    if (!v.allow) {
      await this.#panic()
      return {
        success: false,
        error: `移动过程中真空互锁转为拒绝:${v.reason} 已停止粗动。`,
        data: { moved_steps: this.#movedSteps, watch },
      }
    }

    this.#watches.push(watch)
    return { success: true, data: { steps: n, direction, watch } }
  }

  // ── verify / reapproach ───────────────────────────────────────────────

  /**
   * 与步进计数器对账 —— 在有计数器的机器上。
   *
   * 只有 Attocube ANC150 控制器暴露 `Motor_StepCounterGet`。其它一切机器上这里报
   * `unavailable` 并**说出来**，而不是给一个从没跑过的检查打一个让人安心的勾。
   */
  async #verify(): Promise<StepResult> {
    const rec = await this.#ctx.safeCall('Motor_StepCounterGet', 0, 0, 0)
    if (rec.error !== undefined && rec.error !== '') {
      return {
        success: true,
        data: {
          counter: 'unavailable',
          note:
            '本控制器不支持步进计数器读回(仅 Attocube ANC150 支持)—— ' +
            '移动步数无法对账,这是如实记录,不是通过。',
        },
      }
    }
    const data: Record<string, unknown> = { counter: 'read', commanded_steps: this.#movedSteps }
    const x = num(rec, 0)
    const y = num(rec, 1)
    const z = num(rec, 2)
    if (x !== null && y !== null && z !== null) {
      data['step_counter_x'] = Math.trunc(x)
      data['step_counter_y'] = Math.trunc(y)
      data['step_counter_z'] = Math.trunc(z)
    }
    return { success: true, data }
  }

  /**
   * 把针尖带回去 —— 走 `ApproachTip`，**绝不**靠迈 Z 步。
   *
   * `ApproachTip` 是控制器自己的电流反馈进针：它在接触时停。一个朝样品去的开环粗动
   * Z 步没有那个停，而它正是 MAST 里唯一一个闸到人的动作。
   */
  async #reapproach(params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    if (params['dry_run'] === true) {
      return { success: true, data: { dry_run: true, skipped: 'ApproachTip' } }
    }
    // 谁改谁恢复：横移前是这条流程把偏压降下去的，进针**之前**放回去。
    // 放在进针之前而不是之后 —— 进针要在调用方原本的工作点上完成，
    // 否则「进好的针」是在一个没人要求过的偏压下建立的。
    await this.#restoreBias()
    const res = await runSubSkill(this.#ctx, 'ApproachTip', {})
    const okRes = res.success === true
    return {
      success: okRes,
      // 这句话**可以主张什么**（2026-08-05）。它曾经断言「坐标代次已经推进」——
      // 一句作者相信记录器会做的事，写在「失败的组合其数据会被丢弃、
      // 因此代次并不会推进」的那个年代。真机上台子走了 301 步、账没动，
      // 而这句话说的正好相反。所以：陈述这个相亲眼看着发生的**物理事实**，
      // 并指向那个可以被核对的东西，而不是叙述一个在别处、在这之后运行、
      // 并且可以自己失败的记账步骤。
      error: okRes
        ? ''
        : `换区后重新进针失败:${res.error ?? 'unknown'}。` +
          `**横向移动本身已经完成**(实际走了 ${this.#movedSteps} 步),` +
          '针尖现在是退开的 —— 重新进针即可,**不要再移动一次**。' +
          '旧的压电坐标已经不指向原来那片表面了;' +
          '账面位置用 get_coarse_map 核对,不要凭这句话推断。',
      data: { approach: res.data ?? {} },
    }
  }

  // ── bias / panic ──────────────────────────────────────────────────────

  /**
   * 把结偏压降到 {@link MOVE_BIAS_V}，并**记下原值**（谁改谁恢复）。
   *
   * 本来就在安全值以下就**不碰** —— 「谁改谁恢复」的前提是只改该改的。
   * 判据取绝对值：负偏压一样会场发射。
   */
  async #lowerBiasForMove(): Promise<void> {
    const rec = await this.#ctx.safeCall('Bias_Get')
    const now = rec.error !== undefined && rec.error !== '' ? null : num(rec, 0)
    if (now !== null && Math.abs(now) > MOVE_BIAS_V) {
      this.#biasRestore = now
      await this.#ctx.safeCall('Bias_Set', MOVE_BIAS_V)
    }
  }

  /**
   * 把横移前降下去的偏压放回原值。**幂等**：放回一次就清掉记号。
   *
   * 三条路径都要调它：正常收尾（reapproach 之前）、panic、以及 `reapproach=false`
   * 时的结束。漏掉任何一条，调用方就会在一个自己没要求过的偏压上继续工作 ——
   * 而那正是 08-26 追了半夜的「工作点被上一个 skill 改掉且不改回来」。
   */
  async #restoreBias(): Promise<void> {
    const want = this.#biasRestore
    if (want === null) return
    this.#biasRestore = null
    await this.#ctx.safeCall('Bias_Set', want)
  }

  /**
   * 停马达并撤针。尽力而为。
   *
   * **但「没能停下来」必须留下痕迹。** 旧仓两个动作都包在 `except: pass` 里：
   * 急停发不出去、退针发不出去，调用方拿到的东西与两条都成功时**一模一样**
   * —— 而这是本技能里唯一一条「针尖可能正贴着表面而马达还在走」的路径。
   *
   * ⚠️ **本仓判据换了，而且这一换修了旧仓的一个真缺陷**：旧仓那两个 `except` 只抓
   * **异常**，而 `safe_call` 从不为仪器报错抛异常（它把错放进 `record.error`）——
   * 于是「急停下发了但仪器拒绝了」在旧仓**根本不会**进 `_panic_failures`。
   * 本仓的 `safeCall` **永不抛**，照抄那个形状会得到一条恒空的分支，
   * 所以这里看 `rec.error`。见 deviation。
   *
   * 动词写成**字面量**并各自单独发，不要表驱动 —— 那样一来本仓每一个安全工具
   *（中止策略检查 / 安全审计 / API 覆盖率普查）都看不见它们。
   * 这是同一个错误的**第二次**：旧仓 `core/runtime.py` 的急停原来也是一张 tuple 表
   * splat 进去，于是「急停自己发出的那三个动词」对中止策略检查器隐形。
   * **急停路径是最不该对审计工具隐形的地方。**
   */
  async #panic(): Promise<void> {
    const stop = await this.#ctx.safeCall('Motor_StopMove')
    if (stop.error !== undefined && stop.error !== '') {
      this.#panicFailures.push(`Motor_StopMove: ${stop.error}`)
    }
    const wd = await this.#ctx.safeCall('ZCtrl_Withdraw', 1, -1)
    if (wd.error !== undefined && wd.error !== '') {
      this.#panicFailures.push(`ZCtrl_Withdraw: ${wd.error}`)
    }
    // 急停也要把偏压放回去 —— 否则一次失败的粗动会让调用方停在 0.5 V 上，
    // 而它自己以为还在原来的成像偏压。
    await this.#restoreBias()
  }

  /** 急停没做成时，要顶到用户读的那句话里去的一行。空串 = 都发出去了。 */
  #panicNote(): string {
    if (this.#panicFailures.length === 0) return ''
    return (
      '\n⚠️ **紧急停止未能完整下发**(' +
      this.#panicFailures.join('；') +
      ')。请立即到 Nanonis 界面确认马达已停、针尖已退开 —— ' +
      '不要假设本技能已经把针尖收回去了。'
    )
  }

  // ── driver ────────────────────────────────────────────────────────────

  async run(): Promise<SkillResultLike> {
    const direction = directionOf(this.#params['axis'], this.#params['direction'])
    if (direction === null) {
      return {
        success: false,
        error:
          `无效的轴/方向:axis=${JSON.stringify(this.#params['axis'])} ` +
          `direction=${JSON.stringify(this.#params['direction'])};` +
          "轴取 'x'/'y',方向取 '+'/'-'。",
      }
    }

    this.#ex = new GraphExecutor('RelocateCoarseXY', {
      now: () => this.#ctx.now(),
      run: (skill, params) => this.#phase(skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
      onStepResult: (step, res) => {
        // **对账那一步的答复必须离开这一步。**
        //
        // ⚠️ 旧仓在这里漏了一条：`_phase_verify` 在不支持步进计数器的控制器上返回
        // 「本控制器不支持步进计数器读回 …… 这是如实记录,不是通过」，而
        // `run_composite` 的 `data` 里**没有这一格** —— 于是那句专门写来防止
        // 「打一个安心的勾」的话，从来没有离开过那个步骤。
        // 这台模拟器正好就是不支持的那一种（`NeedModule`），一跑就照出来了。
        if (step.stepId === 'verify') this.#ex.setPartial('step_counter', res.data ?? null)
      },
    })
    const allGood = await this.#ex.runPlan(this.#plan())
    // **谁改谁恢复，而且是在每一条路径上。** 幂等，所以正常收尾（`#reapproach` 里
    // 已经放回过）走到这里是个空动作。
    //
    // ⚠️ 旧仓这一条**有洞**，而洞的证据就是它自己那段注释：它写着「三条路径都要调它：
    // 正常收尾、panic、以及 `reapproach=False` 时的结束」，而代码里 `_restore_bias`
    // 只在 `_phase_reapproach` 与 `_panic` 里被调 —— 于是
    //   ① `reapproach=False` 时**永远不恢复**（那正是它自己点名的第三条路）；
    //   ② 清障基线不可用那条 fail-closed 返回**不经过 panic**，也不恢复。
    // 两种情况下调用方都会在一个自己没要求过的 0.5 V 上继续工作 ——
    // 而那正是 08-26 追了半夜的那件事。见 deviation。
    await this.#restoreBias()
    const p = this.#ex.progress

    const data: Record<string, unknown> = {
      // direction + steps 是与记录器的**契约**：它们是横向粗动标记的依据，
      // 而那个标记推进坐标代次、喂粗动地图的里程表。报的是**实际**走了多少，
      // 不是要求走多少 —— 一次半路停下的移动同样移动了台子，
      // 而一个被喂了请求而不是结果的里程表是虚构。
      direction,
      steps: this.#movedSteps,
      // 失败路径上里程表的入场券。**单独一个键，单独一个承诺**：
      //「台子物理上横向走了这么多步，无论这条组合的判决是什么」。
      // `dry_run` 下是 0：一次排练什么都没下令，而一次让样品上每个坐标都作废的排练
      // 和任何别的幻影换位没有区别。
      lateral_steps_taken: this.#params['dry_run'] === true ? 0 : this.#movedSteps,
      requested_steps: Math.trunc(Number(this.#params['steps'] ?? 0)),
      reapproached: this.#params['reapproach'] !== false && allGood,
      dry_run: this.#params['dry_run'] === true,
      checks: this.#checks,
      clearance: this.#clearance,
      // 步进计数器对账的答复（见上面 `onStepResult` 那段）。`null` = 这一步没跑到。
      step_counter: p.partialData['step_counter'] ?? null,
      // 方向自检自己的证据，成功时也带上。「针尖往哪边走了、我们怎么知道的」
      // 是唯一让脱离事后可证伪的东西。
      clearance_rungs: [...this.#rungs],
      clearance_baseline: this.#baselineSettle,
      watches: [...this.#watches],
      _progress: progressToDict(p),
    }
    if (this.#temperatureK !== null) data['temperature_k'] = this.#temperatureK

    // 急停有没有真的发出去，是**两条路都要说**的事。只在失败分支说不够：
    // 一次「成功」的移动里如果中途 panic 过而且没发下去，针尖状态同样不确定，
    // 而 success=true 会让人完全不去看。
    data['panic_failures'] = [...this.#panicFailures]
    const panicNote = this.#panicNote()

    if (!allGood) {
      return {
        success: false,
        error: (p.abortedReason || 'RelocateCoarseXY aborted') + panicNote,
        data,
      }
    }
    // ⚠️ **下面这一支在当前计划下走不到**（2026-09-19 变异演练查出来的，见
    // `docs/handoff/green-8.md`）：`#panicFailures` 只在 `#panic()` 里被 push，
    // 而 `#panic()` 的每一个调用点紧接着就 `return { success: false }`；发得出
    // panic 的两个相（`clear` / `move`）在 `#plan()` 里都是 `optional: false`，
    // 于是非可选步骤一失败 `runPlan` 就返回 false —— `panicNote !== ''` 蕴含
    // `allGood === false`，上一支已经把话说完了（它也带着 `panicNote`）。
    // 留着它是因为「哪天有一个相变成 optional」这件事完全可能发生；但**在那之前
    // 它没有任何输入能验**，别把它当成一道在挡的闸。真正在挡的是上面那个 `+ panicNote`。
    if (panicNote !== '') {
      // 走到这里说明：动作整体判成功，但中途某次急停没能下发。
      // 那不是「成功」—— 针尖是不是退开的，本技能答不上来。
      return {
        success: false,
        error: '横向移动的各项判据都过了,但' + panicNote.replace(/^\n+/, ''),
        data,
      }
    }
    return { success: true, data }
  }
}

export const RelocateCoarseXY: Skill = {
  spec: S.RelocateCoarseXYSpec,
  execute: (ctx, params) => new Relocate(ctx, params).run(),
}
