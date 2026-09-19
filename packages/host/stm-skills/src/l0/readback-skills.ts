/**
 * 流式读回一族 —— **一边动手，一边看着**。
 *
 * 三个技能，同一件事的三个尺度：
 *
 * | | 做什么 | 判据 |
 * |---|---|---|
 * | `BiasPulseWithReadback` | 打一发电脉冲 | Z 在脉冲前后的稳定值差了多少、往哪边 |
 * | `TipShapeWithReadback` | 跑硬件 tip shaper | 同一套判据，换成扎针的读法 |
 * | `CaptureSignalBuffer` | 只采不动 | 没有判据 —— 但有一条**异常检测** |
 *
 * 前两个与它们不带读回的孪生兄弟（`BiasPulse` / `TipShape`）只差一个参数：
 * 那两个用 `Wait_until_done=1` 阻塞到动作结束，期间什么也看不到；这两个传 0，
 * 动作在控制器上跑，宿主侧在同一条 TCP 连接上轮询电流与 Z。
 *
 * **方向不作物理解释。** 判据（`dsh-spm-kernel` 的 `stepVerdict`）报的是 Z 自己的
 * 方向（`up`/`down`），因为「Z 变大」到底是针尖退开还是靠近取决于接线，而
 * 「向上几十 nm 算修成功」是策略层的判据，不是这一层的。扎针那一路的读法由
 * `indentVerdict` 给出 —— 判据只有一份，语义各归各家。
 *
 * ## 诚实守卫：`wait=0` 真的立即返回了吗
 *
 * 截至 2026-08-01 **尚未在真机上验证过**。若固件忽略了 wait=0 而阻塞了整个动作
 * 时长，结果里会打上 `start_blocked` —— 那时曲线主要反映事后状态。**判定本身仍然
 * 成立**（它比的本来就是前后稳定值），只是中间过程没采到，这一点必须说出来而不是
 * 让读者以为拿到了过程曲线。
 *
 * 两处阈值**刻意不同**：脉冲那边的绝对下限是 20 ms，整形那边是 200 ms。脉冲的
 * 时间尺度比整形短一个数量级（500 ms 对几秒），照抄 200 ms 会让这个守卫在任何短于
 * 400 ms 的脉冲上**永远不触发** —— 守卫在，却只在不需要它的地方管用。
 */
import {
  DEFAULT_JUMP_K,
  detectJumps,
  formatG,
  indentVerdict,
  indentVerdictFields,
  jumpReportFields,
  pyFixed,
  pyMean,
  pySum,
  stepVerdict,
  stepVerdictFields,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, formatG6, ok, pyExp } from './common.js'
import {
  captureIsEmpty,
  channelBlock,
  pollLoop,
  saveTrace,
  scalar,
  streamWithAction,
  traceRef,
  type ReadbackCapture,
  type TraceDeps,
} from './readback-stream.js'
import { applyTipPolicy, resolvedLiftHeightM, shaperBiasDefault, tipDepthRefusals } from './tip-policy.js'
import { tipXyFields } from './tip-xy.js'

const num = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const flag = (p: Readonly<Record<string, unknown>>, k: string, dflt: boolean): boolean =>
  p[k] === undefined || p[k] === null ? dflt : Boolean(p[k])

/** Python 的 `f"{v:+.<n>f}"`。符号**总是**印出来，`-0.0` 也印成负号。 */
function pySigned(v: number, digits: number): string {
  return (v < 0 || Object.is(v, -0) ? '-' : '+') + pyFixed(Math.abs(v), digits)
}

/** 落盘接线。**宿主可以换掉这一处**（测试、以及将来的数据根）。 */
export const processTraceDeps: { current: TraceDeps } = { current: {} }

// ════════════════════════════════════════════════════════════════════════════
// BiasPulseWithReadback
// ════════════════════════════════════════════════════════════════════════════

/**
 * 脉冲后 Z 大多需要一小会儿才安定（压电蠕变）。默认 0.3 s 是估计值，真机验收项
 * 之一就是量出这个时间；偏小会系统性低估 delta（尾窗还在爬）。
 */
export const DEFAULT_POST_ROLL_S = 0.3

const PULSE_DIRECTION_CN: Readonly<Record<string, string>> = {
  up: 'Z 向上跳变',
  down: 'Z 向下跳变',
  none: 'Z 无跳变',
  insufficient_data: '数据不足,判不了',
}

/**
 * 打一发电脉冲，并在脉冲前后流式采 Z/电流，判定 Z 跳变的方向与幅度。
 *
 * ## 针尖安全包络：**D-TIP-1 的欠账在批 5a 结清了**
 *
 * 旧仓的 `validate_params` 在这里调 `apply_tip_policy(params, ("pulse_v",), …)`：
 * 按**当前登记的针尖**检查方案表包络，**超上限拒绝、不夹紧**（同一条哲学贯穿
 * 粗动电压四重锁 —— 悄悄把 10 V 改成 8 V 会让用户以为自己做的是他要的实验）。
 *
 * 批 3j 当时**没有写一个空的 `validateParams`**（写了会让人以为这道闸在），
 * 欠账写在这儿。针尖登记表底座落地之后，下面这个 `validateParams` 是**实的**：
 * 它装在内核 K6，也就是**任何硬件调用之前**，而 K6 的拒绝原样回给调用方。
 *
 * ⚠️ 方案表管这个量叫 `pulse_v`，本技能的参数名是 `bias_v` —— 全局 ±10 V 的安全帽
 * 按**参数名子串**匹配，叫 `pulse_v` 也在帽内，但 `bias_v` 与 `BiasPulse` 保持一致。
 */
export const BiasPulseWithReadback: Skill = {
  spec: S.BiasPulseWithReadbackSpec,
  validateParams: (params) => [...applyTipPolicy(params, ['pulse_v'], { pulse_v: 'bias_v' }).plan.refusals],
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const calls: SkillCallRecord[] = []
    const biasV = num(params, 'bias_v', 0)
    const widthS = num(params, 'width_s', 0.5)
    const zHold = Math.trunc(num(params, 'z_hold', 1))
    const absolute = flag(params, 'absolute', true)
    const absRel = absolute ? 2 : 1 // 1=relative, 2=absolute
    const pollHz = num(params, 'poll_hz', 2000.0)
    const preRoll = num(params, 'pre_roll_s', 0.1)
    const postRoll = num(params, 'post_roll_s', DEFAULT_POST_ROLL_S)
    const maxCapture = num(params, 'max_capture_s', 5.0)
    const jumpK = num(params, 'jump_k', DEFAULT_JUMP_K)

    // 脉冲落在哪里，在开火**之前**读回。脉冲会改造表面（那通常正是目的），扫描
    // 地图要的是它真正的坐标，不是 ≤1 s 前的缓存值。尽力而为。
    const spot = await tipXyFields(ctx)

    // 固件多留 50% 余量，与 shaper 那一路同口径。
    const totalCapture = Math.min(preRoll + widthS * 1.5 + postRoll, maxCapture)

    const capture = await streamWithAction(ctx, {
      fire: () => ctx.safeCall('Bias_Pulse', 0, widthS, biasV, zHold, absRel),
      totalCaptureS: totalCapture,
      preRollS: preRoll,
      pollHz,
      calls,
    })

    const rec = capture.fireRecord
    if (rec !== null && rec.error !== undefined && rec.error !== '') return fail(rec.error)
    if (!capture.fired) {
      // 圈数预算耗尽而始终没到开火时刻 ⇒ **不是中止，是注入的时钟没往前走**。
      // 旧仓那里只有一句「Aborted」，因为它用的是真墙钟、不可能停。照抄那一句
      // 会把一次夹具故障说成一次用户中止 —— 而这两件事要做的下一步完全不同。
      return fail(
        capture.budgetExhausted
          ? '采集循环用尽圈数预算却始终没到开火时刻 —— 注入的时钟没有前进。**没有发出脉冲。**'
          : 'Aborted before the pulse was fired — no pulse was applied.',
      )
    }
    if (captureIsEmpty(capture)) {
      return fail(
        'Pulse fired but no samples were collected (TCP errors); ' +
          'the tip state after this pulse is UNKNOWN.',
      )
    }

    // ⚠️ **电流通道刻意不传**（扎针那一路传）。四段结构是**扎入**才有的形状：
    // 反馈关掉、压进去、抬回来、反馈恢复。一发电脉冲没有那个过程 —— 反馈按
    // `z_hold` 要么一直开着、要么全程保持，电流不会先饱和再回落，于是
    // `feedbackRestoredT` 只会回一句 `no_press`，白读一遍。
    // 结果里的 `feedback_segment_source` 因此恒为 `no_current`：**后窗就是尾窗**，
    // 而对脉冲来说尾窗本来就是对的那一段。
    const verdict = stepVerdict(capture.zS, capture.zT, capture.fireTS, {
      postRollS: postRoll,
      tolK: num(params, 'step_tol_k', 4.0),
      tolAbsM: num(params, 'step_tol_nm', 0.5) * 1e-9,
    })

    // wait=0 本该毫秒级返回；若它耗掉了脉冲时长的一半以上，说明固件忽略了它。
    // **20 ms** 的绝对下限见文件抬头 —— 它仍远大于一次 TCP 往返（~1 ms），
    // 不会把正常抖动误报成阻塞。
    const startBlocked = capture.fireBlockedS >= Math.max(0.5 * widthS, 0.02)

    const data: Record<string, unknown> = {
      completed: true,
      bias_v: biasV,
      width_s: widthS,
      z_hold: zHold,
      absolute,
      current: channelBlock(capture.currentS, capture.currentT, 'a'),
      z: channelBlock(capture.zS, capture.zT, 'm'),
      jumps: {
        current: jumpReportFields(detectJumps(capture.currentS, capture.currentT, jumpK)),
        z: jumpReportFields(detectJumps(capture.zS, capture.zT, jumpK)),
      },
      step: stepVerdictFields(verdict),
      timing: timingTail(capture, {
        pre_roll_s: preRoll,
        post_roll_s: postRoll,
        capture_s: capture.captureS,
        pulse_t_s: capture.fireTS,
        fire_call_blocked_s: capture.fireBlockedS,
        start_blocked: startBlocked,
        aborted: capture.aborted,
        n_current: capture.currentS.length,
        n_z: capture.zS.length,
      }),
      ...spot,
    }
    if (startBlocked) {
      data['warning'] =
        'Bias_Pulse(wait=0) blocked for ~the pulse duration; the firmware ' +
        'likely ignored it, so the trace reflects the AFTER state rather ' +
        'than the pulse itself. The before/after verdict still holds.'
    }

    // ── 原始曲线落盘 ────────────────────────────────────────────────────────
    // 与扎针那一路同一个口（采集循环共用，落盘也就共用一份实现）。判定报的是前后
    // **稳定值**之差，中间那个瞬态峰按设计不参与；而 qPlus 针尖上「z 大幅弹起、
    // 音叉起振」恰恰就在那个峰里。判定不该改，过程要留得下来。
    const direction = verdict.direction
    const saved = saveTrace({
      capture,
      skill: 'BiasPulseWithReadback',
      deps: processTraceDeps.current,
      meta: {
        bias_v: biasV,
        width_s: widthS,
        z_hold: zHold,
        absolute,
        poll_hz: pollHz,
        pre_roll_s: preRoll,
        post_roll_s: postRoll,
        start_blocked: startBlocked,
        direction,
        delta_m: verdict.deltaM ?? null,
        z_min_m: verdict.zMinM ?? null,
        ...spot,
      },
    })
    Object.assign(data, saved)

    // `delta_m` 缺席时 Python 走的是 `or 0.0` —— 与 `?? 0.0` 只在 `-0.0` 上分岔，
    // 而这一句只在 up/down 分支里印出来，那时 |delta| > tol ≥ 0 ⇒ delta ≠ 0。
    const dzNm = (verdict.deltaM ?? 0.0) * 1e9
    let summary =
      `${pySigned(biasV, 1)} V / ${pyFixed(widthS * 1e3, 0)} ms 脉冲 → ` +
      `${PULSE_DIRECTION_CN[direction]!}`
    if (direction === 'up' || direction === 'down') summary += ` (${pySigned(dzNm, 2)} nm)`
    // 指针写进摘要：摘要是**唯一**穿过工具边界的东西。
    summary += traceRef(saved)
    return ok(data, summary)
  },
}

/**
 * `timing` 块。**本仓多一个键**：圈数预算耗尽时补 `budget_exhausted: true`。
 *
 * 只在发生时才写，缺键就是没发生 —— 与 `tipXyFields` 的空对象同一条纪律，
 * 也是旧仓 `warning` 那个键本来的形状。它存在是因为这一侧的时钟是注入的：
 * 一个不往前走的钟会把采集循环变成一个不发任何调用的死循环，而**挂住与通过
 * 在退出码上长得一模一样**。
 */
function timingTail(
  capture: ReadbackCapture,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return capture.budgetExhausted ? { ...fields, budget_exhausted: true } : fields
}

// ════════════════════════════════════════════════════════════════════════════
// TipShapeWithReadback
// ════════════════════════════════════════════════════════════════════════════

const INDENT_CN: Readonly<Record<string, string>> = {
  no_change: '没扎上',
  cluster: '扎上了(cluster)',
  tip_changed_or_pit: '针尖改变/坑',
  insufficient_data: '数据不足',
}

/**
 * 阶段边界（采集时钟，秒），以 shaper 启动时刻为锚。
 *
 * Nanonis 的顺序：switch_off → Z ramp 1（扎入）→ bias settle → Z ramp 2（回撤）
 * → end wait。**是估计值** —— 真固件另有小开销。
 *
 * ⚠️ 判据**不用**这张表定第四段（见 `feedbackRestoredT` 的长注释：硬件比声明晚
 * 0.22–0.33 s，照声明切段会把第三段当成第四段）。它留在回包里是给人看曲线用的。
 */
export function stageBoundaries(
  shaperStartT: number | null,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown>[] {
  if (shaperStartT === null) return []
  let t = shaperStartT
  const out: Record<string, unknown>[] = [
    { stage: 'pre_roll', t_start: 0.0, t_end: t, note: 'feedback-held baseline (z1)' },
  ]
  for (const [name, key] of [
    ['switch_off', 'switch_off_delay_s'],
    ['z_ramp_1_plunge', 'lift_time_1_s'],
    ['bias_settle', 'bias_settling_s'],
    ['z_ramp_2_retract', 'lift_time_2_s'],
    ['end_wait', 'end_wait_s'],
  ] as const) {
    const dur = num(params, key, 0.1)
    out.push({ stage: name, t_start: t, t_end: t + dur })
    t += dur
  }
  out.push({ stage: 'post_roll', t_start: t, t_end: null, note: 'feedback restored (z3)' })
  return out
}

/**
 * 跑硬件 tip shaper，**同时**在流程进行中连续采集电流+Z。
 *
 * ## `bias_v` 缺省 = **此刻的成像偏压**，不是写死的 3 V
 *
 * 2026-08-10 现场要求逐字：「shaper 应该自带 bias 变成扫图 bias，而不是锁死 3V。」
 * **读不到就说读不到** —— 拒绝执行，而不是悄悄在结上打一个没人要求过的 3 V。
 *
 * ## `bias_lift_v` 是**无条件**施加的，`change_bias` 解除不了它
 *
 * 厂商同一句话里一个带条件一个不带：「Bias (V) … **if Change Bias is True**」/
 * 「Bias Lift (V) … applied **just after the first Z ramping**」。
 * ⇒ `change_bias=False` **不等于不加电**。2026-08-10 只修好了 `bias_v`，
 * **没修它的孪生兄弟** —— 而 `bias_lift_v` 的声明默认还是 3.0，于是工具路径上
 * 先把 3.0 灌进来，那几行永远走不到。真机后果：成像偏压降到 20 mV、回包写着
 * `bias_v=0.02`，而结上照样过了一记 3 V（用户范本要求的 150 倍）。
 *
 * 所以它跟 `bias_v` 一样：**省略就跟随 bias_v**，没有 3 V 兜底，而且**回包里要写
 * 实际下发的那一组** —— 以前回包只写 `bias_v`，于是「我关掉了 change_bias」的
 * 调用方看着一份没有电压的回执，而针尖上刚刚过了 3 V。
 *
 * ## `validateParams`：**本仓新增**（批 5a，登记成 deviation）
 *
 * 旧仓这个技能**没有** `validate_params` —— 而它的孪生兄弟 `TipShape` 在 `execute`
 * 最前面就过一遍针尖包络。两个技能下发的是**同一串** `TipShaper_PropsSet` +
 * `TipShaper_Start`，也就是对针尖做同一件事，却一个有闸一个没有。
 * 这种不对称正是「同一条判据的两份实现，改了一处另一处还是旧的」那一类
 * （本仓在粗动那次付过账）。这里补上，**判据与 `TipShape` 那一侧逐字同源**。
 */
export const TipShapeWithReadback: Skill = {
  validateParams: (params) => [
    ...applyTipPolicy(params, ['shaper_bias_v', 'shaper_lift_v'], {
      shaper_bias_v: 'bias_v',
      shaper_lift_v: 'bias_lift_v',
    }).plan.refusals,
    // 上面那两个都是**电压**。下压深度走 `tip_lift_m`，而它此前谁都没送进包络 ——
    // 一发 50 nm 的下压全程放行。见 {@link tipDepthRefusals}（批 6a 补，本仓比旧仓严）。
    ...tipDepthRefusals(params),
  ],
  spec: S.TipShapeWithReadbackSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const calls: SkillCallRecord[] = []

    // ── 0) bias 缺省 = 此刻的成像偏压 ─────────────────────────────────────
    let biasV = typeof params['bias_v'] === 'number' ? (params['bias_v'] as number) : null
    let biasSrc = 'explicit'
    if (biasV === null) {
      const read = await shaperBiasDefault(ctx)
      biasSrc = 'read'
      if (read.v === null) {
        // **不回落到 3.0**：读不到就说读不到，让调用方看见。
        return fail(
          `读不到当前偏压(${read.why}),而 bias_v 没有显式给出 —— ` +
            '拒绝用写死的 3 V 代替。要么先修好偏压读取,要么显式传 bias_v。',
        )
      }
      biasV = read.v
    }
    const biasLiftV = typeof params['bias_lift_v'] === 'number' ? (params['bias_lift_v'] as number) : biasV

    // ── 1) PropsSet（与 TipShape 同一套编码）──────────────────────────────
    // change_bias 缺省 **False**（2026-08-11），与工作流层的判断一致：
    // 「TipShaper 的 change-bias 只能**阶跃**改偏压…那一次阶跃本身就是一记冲量」。
    const changeBias = flag(params, 'change_bias', false) ? 1 : 2
    const restoreFb = flag(params, 'restore_feedback', true) ? 1 : 2
    const liftHeightM = resolvedLiftHeightM(params)
    const recProps = await ctx.safeCall(
      'TipShaper_PropsSet',
      num(params, 'switch_off_delay_s', 0.1),
      changeBias,
      biasV,
      num(params, 'tip_lift_m', 0.0),
      num(params, 'lift_time_1_s', 0.1),
      biasLiftV,
      num(params, 'bias_settling_s', 0.1),
      liftHeightM,
      num(params, 'lift_time_2_s', 0.1),
      num(params, 'end_wait_s', 0.1),
      restoreFb,
    )
    calls.push(recProps)
    if (recProps.error !== undefined && recProps.error !== '') return fail(recProps.error)

    const pollHz = num(params, 'poll_hz', 2000.0)
    const preRoll = num(params, 'pre_roll_s', 0.05)
    const postRoll = num(params, 'post_roll_s', 0.1)
    const maxCapture = num(params, 'max_capture_s', 5.0)
    const jumpK = num(params, 'jump_k', 5.0)
    // 从整形自己的计时参数估时长（+50% 固件余量）
    const shapeS =
      num(params, 'switch_off_delay_s', 0.1) +
      num(params, 'lift_time_1_s', 0.1) +
      num(params, 'bias_settling_s', 0.1) +
      num(params, 'lift_time_2_s', 0.1) +
      num(params, 'end_wait_s', 0.1)
    const totalCapture = Math.min(preRoll + shapeS * 1.5 + postRoll, maxCapture)
    const timeoutMs = Math.trunc(num(params, 'timeout_ms', -1))

    // 扎针留下的是**永久痕迹**，所以「在哪扎的」和「扎没扎上」一样是结果的一部分。
    // 在开火**之前**读：扎针会改造表面，坐标要的是它真正发生的地方。
    const spot = await tipXyFields(ctx)

    const capture = await streamWithAction(ctx, {
      fire: () => ctx.safeCall('TipShaper_Start', 0, timeoutMs),
      totalCaptureS: totalCapture,
      preRollS: preRoll,
      pollHz,
      calls,
    })
    const startRec = capture.fireRecord
    if (startRec !== null && startRec.error !== undefined && startRec.error !== '') {
      return fail(startRec.error)
    }
    if (captureIsEmpty(capture)) {
      return fail('No samples collected (TCP errors or aborted before/while shaping).')
    }

    const cap = capture.captureS
    const nCur = capture.currentS.length
    const nZ = capture.zS.length
    // wait=0 本该毫秒级返回；耗掉了整个过程 ⇒ 固件忽略了它。
    const startBlocked = capture.fireBlockedS >= Math.max(0.5 * shapeS, 0.2)

    const stages = stageBoundaries(capture.fireTS, params)
    const indent = indentVerdict(capture.zS, capture.zT, capture.fireTS, {
      postRollS: postRoll,
      tolK: num(params, 'indent_tol_k', 4.0),
      tolAbsM: num(params, 'indent_tol_nm', 0.02) * 1e-9,
      currentS: capture.currentS,
      currentT: capture.currentT,
    })
    const indentBlock = indentVerdictFields(indent)

    const data: Record<string, unknown> = {
      completed: true,
      bias_v: biasV,
      bias_v_source: biasSrc,
      bias_lift_v: biasLiftV,
      change_bias: changeBias === 1,
      lift_height_m: liftHeightM,
      current: channelBlock(capture.currentS, capture.currentT, 'a'),
      z: channelBlock(capture.zS, capture.zT, 'm'),
      jumps: {
        current: jumpReportFields(detectJumps(capture.currentS, capture.currentT, jumpK)),
        z: jumpReportFields(detectJumps(capture.zS, capture.zT, jumpK)),
      },
      timing: timingTail(capture, {
        pre_roll_s: preRoll,
        post_roll_s: postRoll,
        estimated_shape_s: shapeS,
        capture_s: cap,
        shaper_start_t_s: capture.fireTS,
        start_call_blocked_s: capture.fireBlockedS,
        start_blocked: startBlocked,
        n_current: nCur,
        n_z: nZ,
        fs_current_hz: cap > 0 && nCur > 1 ? (nCur - 1) / cap : 0.0,
        fs_z_hz: cap > 0 && nZ > 1 ? (nZ - 1) / cap : 0.0,
      }),
      ...spot,
      stages,
      indent: indentBlock,
    }
    if (startBlocked) {
      data['warning'] =
        'TipShaper_Start(wait=0) blocked ~the full procedure; ' +
        'capture likely reflects the AFTER state, not the ' +
        'in-process trace. Consider the hardware oscilloscope.'
    }

    // ── 原始曲线落盘 ────────────────────────────────────────────────────────
    // 判定报的是 `Δz = z3 − z1`，即**针尖稳定高度的净变化**；`z_min`「只作记录，
    // 不参与判定 —— 那是过程里的瞬态」。一次干净的转移里表面高了 h、针尖短了 h，
    // 间隙几乎不变 ⇒ Δz ≈ 0。2026-08-11 实测把这条说穿了：`tip_lift_m` −300p→−2500p，
    // 团簇等效直径 1.96→5.53 nm **单调增长**，而 Δz 几乎不相关（−300p 报 Δz=−0.00
    // 「没扎上」，实际留下 1.96 nm/峰 500 pm 的团簇）。
    // ⇒ **用户要看的正是被判定丢掉的那一段**。判定不该改 —— 它答的是「结果」那个
    // 问题；要补的是让过程本身取得回来。
    const saved = saveTrace({
      capture,
      skill: 'TipShapeWithReadback',
      stages,
      deps: processTraceDeps.current,
      meta: {
        // 这次扎针**是怎么扎的** —— 下次要把「深度 → 曲线 → 团簇」串起来，
        // 靠的就是这几个数和曲线躺在同一个文件里。
        tip_lift_m: num(params, 'tip_lift_m', 0.0),
        lift_height_m: liftHeightM,
        bias_v: biasV,
        bias_v_source: biasSrc,
        bias_lift_v: biasLiftV,
        change_bias: changeBias === 1,
        switch_off_delay_s: num(params, 'switch_off_delay_s', 0.1),
        lift_time_1_s: num(params, 'lift_time_1_s', 0.1),
        bias_settling_s: num(params, 'bias_settling_s', 0.1),
        lift_time_2_s: num(params, 'lift_time_2_s', 0.1),
        end_wait_s: num(params, 'end_wait_s', 0.1),
        restore_feedback: restoreFb === 1,
        poll_hz: pollHz,
        pre_roll_s: preRoll,
        post_roll_s: postRoll,
        start_blocked: startBlocked,
        verdict: indent.verdict,
        delta_m: indent.step.deltaM ?? null,
        z_min_m: indent.step.zMinM ?? null,
        ...spot,
      },
    })
    Object.assign(data, saved)

    const cn = INDENT_CN[indent.verdict] ?? indent.verdict
    // 摘要是**唯一**穿过工具边界的东西，所以指针必须写在这里 —— 写进 data 而不写进
    // 摘要，agent 就还是只看得到那一行判定。
    const summary =
      `针尖整形: ${cn} (Δz=${pySigned((indent.step.deltaM ?? 0.0) * 1e9, 2)} nm) — ` +
      `${indent.advice}${traceRef(saved)}`
    return ok(data, summary)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// CaptureSignalBuffer
// ════════════════════════════════════════════════════════════════════════════

/**
 * 高速率采集单个 Nanonis 信号的时间序列。
 *
 * ## 四条**字面动词**分支，不是一张表
 *
 * 旧仓这里原先是 `method = _FAST_PATHS[channel]` 然后 `safe_call(method, *args)`。
 * 动词串在源码里，但**不在一个 `safe_call(...)` 里面**，而本仓每一样安全工具找
 * Nanonis 调用靠的正是 grep 那个形状：中止策略检查、安全审计、API 覆盖普查。
 * 一个经变量到达的动词对这三样**全部不可见** —— 调用发生了，而看管这套系统的
 * 东西一个都看不见。四条字面分支值这几行。
 *
 * ## 逐位重复 = 那不是一次测量
 *
 * 一个被采了几百次的物理信号不会重复到最后一位。真重复了，那个数就不是测量值 ——
 * 最可能是读数被缓存/冻结、通道未连接、或者（对 z 而言）控制器根本没在跑。
 *
 * 2026-07-27 现场记录，3 s @ 200 Hz 采 600 个 z：
 * `min = max = mean = -8.416716212877873e-08, std = 0.0`。agent 读完就往下走了。
 * `CheckScanForCrash` 自己的文档写着近零方差是撞针特征 —— 但**这个技能的输出
 * 什么都没说**，而那些数字单看完全合理。
 */
export const CaptureSignalBuffer: Skill = {
  spec: S.CaptureSignalBufferSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const rawCh = params['channel']
    // 旧仓写的是 `(params.get("channel") or "current").lower()` —— 空串也回落到
    // 默认，照搬。
    const channel = (rawCh === undefined || rawCh === null || rawCh === '' ? 'current' : String(rawCh)).toLowerCase()
    const duration = num(params, 'duration_s', 1.0)
    const pollHz = num(params, 'poll_hz', 1000.0)
    const includeSamples = flag(params, 'include_samples', true)

    let poll: () => Promise<SkillCallRecord>
    let unit: string
    let mode: string
    if (channel === 'current') {
      poll = (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('Current_Get')
      unit = 'A'
      mode = 'fast_path'
    } else if (channel === 'z') {
      poll = (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('ZCtrl_ZPosGet')
      unit = 'm'
      mode = 'fast_path'
    } else if (channel === 'bias') {
      poll = (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('Bias_Get')
      unit = 'V'
      mode = 'fast_path'
    } else {
      // 与 `parseChannels` 同判据：**只收整数字面量**（Python 的 `int(s)`）。
      // `Number()` 会把 `'0x10'` 收成 16，而 Python 那边是 ValueError。
      if (!/^[+-]?\d+$/.test(channel.trim())) {
        return fail(
          `Unknown channel: '${channel}'. ` +
            "Use 'current'/'z'/'bias' or a signal index 0-127.",
        )
      }
      const idx = Number(channel.trim())
      // wait_for_newest=0 → 不吃第二次 Tap 的延迟
      poll = (): ReturnType<SkillContext['safeCall']> => ctx.safeCall('Signals_ValGet', idx, 0)
      unit = ''
      mode = 'signals_valget'
    }

    const samples: number[] = []
    const timestamps: number[] = []
    const stop = await pollLoop(ctx, {
      totalS: duration,
      pollHz,
      poll: async (elapsed): Promise<void> => {
        const rec = await poll()
        if (rec.error !== undefined && rec.error !== '') return
        const v = scalar(rec)
        if (v !== null) {
          samples.push(v)
          timestamps.push(elapsed)
        }
      },
    })

    const n = samples.length
    if (n === 0) return fail('No samples collected (TCP errors or aborted)')

    const actualDur = n > 1 ? timestamps[n - 1]! - timestamps[0]! : 1.0 / pollHz
    const actualFs = actualDur > 0 ? (n - 1) / actualDur : pollHz
    let smin = samples[0]!
    let smax = samples[0]!
    for (const x of samples) {
      if (x < smin) smin = x
      if (x > smax) smax = x
    }
    // `pyMean` / `pySum`，不是朴素逐项相加：CPython 3.12 起 `sum()` 走 Neumaier
    // 补偿求和，差在最后两位，而金样是**逐字节**比的。
    const smean = pyMean(samples)
    const svar = pySum(samples.map((x) => (x - smean) ** 2)) / n

    const data: Record<string, unknown> = {
      channel,
      mode,
      unit,
      n_samples: n,
      requested_duration_s: duration,
      actual_duration_s: actualDur,
      actual_fs_hz: actualFs,
      min: smin,
      max: smax,
      mean: smean,
      std: svar ** 0.5,
    }
    if (n >= 8 && smax === smin) {
      data['anomaly'] =
        `⚠ ${n} 个采样点的值**完全相同**（${formatG6(smin)} ${unit}，std=0）。` +
        '真实物理信号不会逐位重复。最可能的原因：读数被缓存/冻结、' +
        '通道未连接、或该通道当前并未在采集。' +
        '**不要把这些数字当作测量结果使用**，先确认信号源。'
    } else if (n >= 8 && smean !== 0 && (smax - smin) / Math.abs(smean) < 1e-9) {
      data['anomaly'] =
        `⚠ ${n} 个采样点的极差仅 ${formatG(smax - smin, 3)} ${unit}` +
        `（相对均值 ${pyExp((smax - smin) / Math.abs(smean), 1)}），近乎恒定。` +
        '可能是读数被缓存或通道未在采集；请先确认信号源再使用这些数字。'
    }
    if (includeSamples) {
      data['samples'] = samples
      data['timestamps_s'] = timestamps
    }
    // 见 `timingTail`：缺键就是没发生。
    if (stop === 'budget') data['budget_exhausted'] = true
    return { success: true, data }
  },
}

export const READBACK_STREAM: Readonly<Record<string, Skill>> = {
  BiasPulseWithReadback,
  TipShapeWithReadback,
  CaptureSignalBuffer,
}
