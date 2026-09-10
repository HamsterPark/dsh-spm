/**
 * 批 2 —— 停止类、退针类、**硬闸七件套**、DANGEROUS。
 *
 * 这一批的共同点不是形状，是**它们被谁允许**：
 *
 * - 停止类是**中止安全**的（`ABORT_SAFE_WRITES`）：中止闩上之后它们仍然放行，
 *   因为闩住之后唯一还该做的事就是停下来。
 * - 硬闸七件套在 `llm` 来源下**一律拒**（`stm-safety` 的 guard），
 *   人从命令路径发起才走「问一次」。这里的实现不重复那道闸——
 *   **一道闸只能有一个实现**，两份就会有两个答案。
 */
import { type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'
import { COARSE_AMP_UNDECLARED } from './reads-hw.js'

const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number => {
  const v = p[k]
  return typeof v === 'number' ? v : dflt
}
const b = (p: Readonly<Record<string, unknown>>, k: string, dflt: boolean): boolean => {
  const v = p[k]
  return typeof v === 'boolean' ? v : dflt
}

function write(
  spec: Skill['spec'],
  verb: string,
  args: (p: Readonly<Record<string, unknown>>) => unknown[],
  data: (p: Readonly<Record<string, unknown>>) => Record<string, unknown>,
  summary?: (p: Readonly<Record<string, unknown>>) => string,
): Skill {
  return {
    spec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const rec = await ctx.safeCall(verb, ...args(params))
      if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
      return ok(data(params), summary?.(params))
    },
  }
}

// ── 停止类（中止安全） ──────────────────────────────────────────────────────

/** `Scan_Action(1, 0)` = stop, 方向 0。 */
export const StopScan = write(
  S.StopScanSpec,
  'Scan_Action',
  () => [1, 0],
  () => ({ scan_running: false }),
)

export const StopAutoApproach = write(
  S.StopAutoApproachSpec,
  'AutoApproach_OnOffSet',
  () => [0],
  () => ({ stopped: true }),
)

export const StopMotor = write(
  S.StopMotorSpec,
  'Motor_StopMove',
  () => [],
  () => ({ stopped: true }),
)

export const StopFolMe = write(
  S.StopFolMeSpec,
  'FolMe_Stop',
  () => [],
  () => ({ stopped: true }),
)

// ── 退针 ────────────────────────────────────────────────────────────────────

/** `ZCtrl_Withdraw(wait=1, timeout=-1)` —— 等它做完，不设超时。 */
export const WithdrawTip = write(
  S.WithdrawTipSpec,
  'ZCtrl_Withdraw',
  () => [1, -1],
  () => ({ withdrawn: true }),
)

/**
 * 紧急退针 —— **三步全部下发，一步都不因为前一步失败而跳过**。
 *
 * 顺序是：开 Z 控制器 → 停扫 → 退针。三条都走**应急角色**，
 * 它有自己的连接、更短的锁超时，不排在主角色后面。
 *
 * 「不因为前一步失败就跳过」是这个技能的全部要点：一次退针里，
 * 前一步失败恰恰是后一步**更该发**的理由。错误最后一起报。
 */
export const EmergencyRetract: Skill = {
  spec: S.EmergencyRetractSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const errors: string[] = []
    const step = async (verb: string, ...args: unknown[]): Promise<void> => {
      const rec = await ctx.emergencyCall(verb, ...args)
      if (rec.error !== undefined && rec.error !== '') errors.push(rec.error)
    }
    await step('ZCtrl_OnOffSet', 1)
    await step('Scan_Action', 1, 0)
    await step('ZCtrl_Withdraw', 0, 1)

    if (errors.length > 0) {
      return fail(`Emergency retract errors: ${errors.join('; ')}`)
    }
    return ok({ retracted: true, emergency: true })
  },
}

// ── 硬闸七件套 ──────────────────────────────────────────────────────────────

/** 方向串 → Nanonis 的方向码。**z-approach 是 5，z-retract 是 4**。 */
const DIR_MAP: Readonly<Record<string, number>> = {
  'x+': 0,
  'x-': 1,
  'y+': 2,
  'y-': 3,
  'z-retract': 4,
  'z-approach': 5,
}

export const MotorMove: Skill = {
  spec: S.MotorMoveSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const direction = String(params['direction'] ?? '')
    const steps = n(params, 'steps')

    // **不认识的方向就大声失败**，绝不默默按 X+ 走。
    // `allowed_values` 现在盖住了执行器与 composite 那两条路，但一次
    // 直接 execute 带着拼错的方向，不能把粗动马达送上另一根轴（2026-07-03 复查）。
    if (!(direction in DIR_MAP)) {
      return fail(
        `unknown motor direction '${direction}'; expected one of ` +
          `${JSON.stringify(Object.keys(DIR_MAP).sort())}`,
      )
    }

    // 横向粗动**拖着针尖横着走**。刚做完 STS 时 Z 控制器是关的，但针尖仍在表面
    // 附近（「已退针」只有显式退针才保证），这时横向一步就是刮过去。
    // **知道**针没退时拒绝；不知道时放行（与前置条件的 fail-open 同规矩）。
    // Z 方向豁免：`z-retract` 是往外走，`z-approach` 由别处的人闸管着。
    if (direction.startsWith('x') || direction.startsWith('y')) {
      const snap = ctx.state()
      if (snap.withdrawn === false) {
        return fail(
          'tip is not withdrawn — retract the tip (WithdrawTip) before a lateral ' +
            'coarse motor move to avoid scraping the surface.',
        )
      }
    }

    const rec = await ctx.safeCall('Motor_StartMove', DIR_MAP[direction], steps, 0, 1)
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok({ direction, steps })
  },
}

export const MotorMoveClosedLoop = write(
  S.MotorMoveClosedLoopSpec,
  'Motor_StartClosedLoop',
  // args = [Absolute_relative, X, Y, Z, Wait, Group]
  (p) => [
    b(p, 'absolute', false) ? 1 : 0,
    n(p, 'target_x_m'),
    n(p, 'target_y_m'),
    n(p, 'target_z_m'),
    b(p, 'wait', true) ? 1 : 0,
    n(p, 'group'),
  ],
  (p) => ({
    absolute: b(p, 'absolute', false),
    target_x_m: n(p, 'target_x_m'),
    target_y_m: n(p, 'target_y_m'),
    target_z_m: n(p, 'target_z_m'),
  }),
)

export const EnableSafeTip = write(
  S.EnableSafeTipSpec,
  'SafeTip_OnOffSet',
  (p) => [b(p, 'enabled', true) ? 1 : 0],
  (p) => ({ enabled: b(p, 'enabled', true) }),
)

export const SetZLimitsEnabled = write(
  S.SetZLimitsEnabledSpec,
  'ZCtrl_LimitsEnabledSet',
  (p) => [b(p, 'enabled', true) ? 1 : 0],
  (p) => ({ enabled: b(p, 'enabled', true) }),
)

export const SetBiasCalibration = write(
  S.SetBiasCalibrationSpec,
  'Bias_CalibrSet',
  (p) => [n(p, 'calibration'), n(p, 'offset')],
  (p) => ({ calibration: n(p, 'calibration'), offset: n(p, 'offset') }),
)

export const SetCurrentCalibration = write(
  S.SetCurrentCalibrationSpec,
  'Current_CalibrSet',
  // gain_index = -1 表示「当前档」，是缺省
  (p) => [n(p, 'gain_index', -1), n(p, 'calibration'), n(p, 'offset')],
  (p) => ({
    gain_index: n(p, 'gain_index', -1),
    calibration: n(p, 'calibration'),
    offset: n(p, 'offset'),
  }),
)

/**
 * `SetMotorFreqAmp` —— **本机上限未声明时一条调用都不发**。
 *
 * 控制器支持的电压和这台机器的压电叠堆能承受的电压是两个数，而**没有任何读数
 * 会告诉你是哪一种**。所以这里不是「限幅到某个值」，是拒绝：
 * 猜一个上限出来，猜错的后果是烧掉叠堆。
 */
export const SetMotorFreqAmp: Skill = {
  spec: S.SetMotorFreqAmpSpec,
  execute: (): Promise<SkillResultLike> => Promise.resolve(fail(COARSE_AMP_UNDECLARED)),
}

// ── DANGEROUS ───────────────────────────────────────────────────────────────

export const LockNanonisUI = write(
  S.LockNanonisUISpec,
  'Util_Lock',
  () => [],
  () => ({ locked: true }),
  () => 'Nanonis 界面已锁定——用户在解锁前无法在仪器端操作',
)

export const GATED_WRITES: Readonly<Record<string, Skill>> = {
  StopScan, StopAutoApproach, StopMotor, StopFolMe,
  WithdrawTip, EmergencyRetract,
  MotorMove, MotorMoveClosedLoop, EnableSafeTip, SetZLimitsEnabled,
  SetBiasCalibration, SetCurrentCalibration, SetMotorFreqAmp,
  LockNanonisUI,
}
