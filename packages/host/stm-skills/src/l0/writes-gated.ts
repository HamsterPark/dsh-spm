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
import {
  readRetractDir,
  stmCoarseGroup,
  stmGroupRefusal,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
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

/**
 * 方向串 → Nanonis 的方向码（0 = X+、1 = X−、2 = Y+、3 = Y−、4 = Z+、5 = Z−）。
 *
 * 横向四个是定值。两个 Z 标签是**语义**的：`z-retract` = 远离样品，`z-approach` = 朝样品
 * （人闸 `isCoarseSampleApproach` 认的是这个标签，不看方向码）。它们按本机声明的退针方向
 * 换算成 Z+ / Z−，见 {@link motorZCodes}，所以这里是 `null`；键不能删，
 * 未知方向的报错要列出全部 6 个名字。
 */
const DIR_MAP: Readonly<Record<string, number | null>> = {
  'x+': 0,
  'x-': 1,
  'y+': 2,
  'y-': 3,
  'z-retract': null,
  'z-approach': null,
}

const Z_PLUS = 4
const Z_MINUS = 5

export const RETRACT_DIR_UNDECLARED_WARNING =
  '本机没声明粗动退针方向，按 Nanonis 标准 Z+ 视为远离样品；请在 设置 → 退针 → 退针方向 里声明'
export const Z_DIR_UNREADABLE = '读不到本机的粗动退针方向配置 —— 方向不明，不发粗动 Z'

type ZBasis = 'declared_z+' | 'declared_z-' | 'undeclared_nanonis_standard'
type ZCodes =
  | { readonly ok: true; readonly retract: number; readonly approach: number; readonly basis: ZBasis }
  | { readonly ok: false }

/**
 * 本机两个 Z 标签的方向码与依据；档案读不到时 `ok: false`，那时一个 Z 动词也不发。
 *
 * - 声明过：`z-retract` = 声明的方向码，`z-approach` = 另一个；
 * - 没声明：按 Nanonis 标准（Z+ 远离样品），结果里带一句请去声明的警告。
 *
 * 读不到时**没有保守默认**：出厂 z+ 是两个互斥答案之一，在 z− 退针的机器上
 * `z-retract` 就是朝样品，而它不经人审（D-MOTORZ）。
 */
export function motorZCodes(): ZCodes {
  const d = readRetractDir()
  if (d.state === 'unreadable') return { ok: false }
  if (d.state === 'declared' && d.code === Z_MINUS) {
    return { ok: true, retract: Z_MINUS, approach: Z_PLUS, basis: 'declared_z-' }
  }
  if (d.state === 'declared') {
    return { ok: true, retract: Z_PLUS, approach: Z_MINUS, basis: 'declared_z+' }
  }
  return { ok: true, retract: Z_PLUS, approach: Z_MINUS, basis: 'undeclared_nanonis_standard' }
}

export const MotorMove: Skill = {
  spec: S.MotorMoveSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const direction = String(params['direction'] ?? '')
    const steps = n(params, 'steps')

    // **不认识的方向就大声失败**，绝不默默按 X+ 走。
    // `allowed_values` 现在盖住了执行器与 composite 那两条路，但一次
    // 直接 execute 带着拼错的方向，不能把粗动马达送上另一根轴（2026-07-03 复查）。
    if (!Object.hasOwn(DIR_MAP, direction)) {
      return fail(
        `unknown motor direction '${direction}'; expected one of ` +
          `${JSON.stringify(Object.keys(DIR_MAP).sort())}`,
      )
    }

    // 两个 Z 标签按本机声明的退针方向换算；读不到档案就拒绝，一个 Z 动词也不发。
    let dirCode = DIR_MAP[direction] ?? null
    const zInfo: Record<string, unknown> = {}
    if (dirCode === null) {
      const z = motorZCodes()
      if (!z.ok) return fail(Z_DIR_UNREADABLE)
      dirCode = direction === 'z-retract' ? z.retract : z.approach
      zInfo['direction_code'] = dirCode
      zInfo['z_direction_basis'] = z.basis
      if (z.basis === 'undeclared_nanonis_standard') zInfo['warning'] = RETRACT_DIR_UNDECLARED_WARNING
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

    // STM 粗动是 Nanonis 的哪一组由仪器档案说了算（缺省 0）；档案坏了就不知道该驱动哪一组，
    // 一个 Motor_* 动词也不发。排在 Z 分支与「针没退」之后、下发之前，与参考实现同序。
    const grp = stmCoarseGroup()
    if (!grp.ok) return fail(stmGroupRefusal(grp.why))

    const rec = await ctx.safeCall('Motor_StartMove', dirCode, steps, grp.group, 1)
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok(
      { direction, steps, ...zInfo },
      'warning' in zInfo
        ? `MotorMove ${direction} ${steps} 步（方向码 ${dirCode}）。⚠ ${RETRACT_DIR_UNDECLARED_WARNING}`
        : undefined,
    )
  },
}

/**
 * 闭环粗动。`group` 缺省 = **配置的 STM 粗动组**；给了别的组就拒绝 ——
 * 这个技能只驱动 STM 粗动，光学组不归它管。
 *
 * 内核不做类型转换：字符串 `"1"` 若被当成「没给」，会静默驱动组 0，
 * 所以 `group` 给了就必须是整数 number，否则拒绝。
 * 顺序同参考实现：先取组（取不到 ⇒ 拒绝粗动），再核对 `group`，最后才下发 ——
 * 任何一道拒绝都发生在下发之前，`calls` 为空。
 */
export const MotorMoveClosedLoop: Skill = {
  spec: S.MotorMoveClosedLoopSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const stm = stmCoarseGroup()
    if (!stm.ok) return fail(stmGroupRefusal(stm.why))
    const asked = params['group']
    if (asked !== undefined && asked !== null) {
      if (typeof asked !== 'number' || !Number.isInteger(asked)) {
        // 数字走 String：NaN 与 ±Infinity 的 JSON 都是 "null"，会把收到的值印错
        const shown = typeof asked === 'number' ? String(asked) : JSON.stringify(asked)
        return fail(`group 必须是 0..5 的整数，收到 ${shown}`)
      }
      if (asked !== stm.group) {
        return fail(
          `group ${asked} 不是 STM 粗动组（stm_coarse_group=${stm.group}）—— ` +
            'STM 粗动技能不驱动其他电机组；光学组请用 NanonisMotorGroupMove。',
        )
      }
    }
    const absolute = b(params, 'absolute', false)
    // args = [Absolute_relative, X, Y, Z, Wait, Group]
    const rec = await ctx.safeCall(
      'Motor_StartClosedLoop',
      absolute ? 1 : 0,
      n(params, 'target_x_m'),
      n(params, 'target_y_m'),
      n(params, 'target_z_m'),
      b(params, 'wait', true) ? 1 : 0,
      stm.group,
    )
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok({
      absolute,
      target_x_m: n(params, 'target_x_m'),
      target_y_m: n(params, 'target_y_m'),
      target_z_m: n(params, 'target_z_m'),
    })
  },
}

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
