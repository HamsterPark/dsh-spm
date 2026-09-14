/**
 * 压电范围对账 —— **让两边的数字见面**，不改任何设置。
 *
 * 判据在内核的 `piezo-reconcile.ts` 里（三态、两轴取小、容差）。这个文件负责
 * 去问两边：仪器那边走 `Piezo_RangeGet`，配置那边走**生效的** `SafetyLimits`。
 *
 * ## 为什么不直接读 `DEFAULT_SAFETY_LIMITS`
 *
 * 旧仓在这里留了一句值得抄的话：直接读类默认值会**绕过管理员覆写**，
 * 于是报出来的数和实际生效的数不是同一个 ——
 * **一个对账工具报错数字，比不对账更坏。**
 *
 * 所以生效限值由外面注入（`effectiveLimits`），没接就退回出厂默认；
 * 宿主接上「配置 + 管理员覆写 + 仪器事实收紧」那一份之后，这里自动跟着对。
 *
 * ## 它只报数
 *
 * 改压电范围是会影响全仪器的动作。要改，人自己去 Nanonis 里改，或者调
 * `SetPiezoRange` —— 这个技能**从不改变任何东西**。
 */
import {
  DEFAULT_PIEZO_TOLERANCE_FRAC,
  DEFAULT_SAFETY_LIMITS,
  halfRange,
  reconcilePiezoRange,
  type SafetyLimits,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { scalarFloat } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

export interface PiezoCheckDeps {
  /**
   * **生效的**安全限值（配置 + 管理员覆写 + 仪器事实收紧）。
   *
   * 没接 ⇒ 退回出厂默认 —— 而出厂默认里那个 `xy_max_m = 1.5 µm` 正是
   * 2026-08-16 事故里的那个数。这个技能存在的全部意义就是去核对它。
   */
  readonly effectiveLimits?: () => SafetyLimits
}

/** nm，一位小数 —— 报文里的数要能直接和面板上的比。 */
const nm1 = (m: number): string => (m * 1e9).toFixed(1)
/** 百分比，一位小数。 */
const pct1 = (frac: number): string => (frac * 100).toFixed(1)

export function makeCheckPiezoRange(deps: PiezoCheckDeps = {}): Skill {
  return {
    spec: S.CheckPiezoRangeSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const tol = typeof params['tolerance_frac'] === 'number'
        ? params['tolerance_frac']
        : DEFAULT_PIEZO_TOLERANCE_FRAC

      // ── 仪器那边 ────────────────────────────────────────────────────
      const rec = await ctx.safeCall('Piezo_RangeGet')
      const vals = failed(rec)
        ? []
        : body(rec).map((v) => scalarFloat(v)).filter((v): v is number => v !== null)
      // `Piezo_RangeGet` 回 (x, y, z) —— **全程**，不是半程。
      const hx = vals.length >= 2 ? halfRange(vals[0] as number) : null
      const hy = vals.length >= 2 ? halfRange(vals[1] as number) : null
      const hz = vals.length >= 3 ? halfRange(vals[2] as number) : null

      // ── 配置那边 ────────────────────────────────────────────────────
      const limits = deps.effectiveLimits?.() ?? DEFAULT_SAFETY_LIMITS
      const cfg = typeof limits.xy_max_m === 'number' && limits.xy_max_m !== 0
        ? Math.abs(limits.xy_max_m)
        : null

      const data: Record<string, unknown> = {
        instrument_half_x_m: hx,
        instrument_half_y_m: hy,
        instrument_half_z_m: hz,
        configured_half_xy_m: cfg,
        tolerance_frac: tol,
      }

      const v = reconcilePiezoRange(hx, hy, cfg, tol)

      // ── 三态 ────────────────────────────────────────────────────────
      //
      // 仪器读不到 ⇒ **判不了**。折成「一致」会让这个自检变成一句永远为真的
      // 安慰话 —— 那正是它要防的东西。
      if (hx === null || hy === null) {
        return ok(
          {
            ...data,
            verdict: 'unknown',
            undecidable:
              '读不到扫描器的压电范围' +
              `(Piezo_RangeGet: ${failed(rec) ? rec.error ?? '' : '返回值里没有数字'})` +
              ' —— **判不了,不是「一致」**。',
          },
          '压电范围对账:**判不了** —— 仪器那边读不到。',
        )
      }
      if (cfg === null) {
        return ok(
          {
            ...data,
            verdict: 'unknown',
            undecidable: '读不到 SafetyLimits.xy_max_m —— **判不了**。',
          },
          '压电范围对账:**判不了** —— 读不到配置里的 xy_max_m。',
        )
      }

      const instHalf = v.minInstrumentHalfM as number
      const rel = v.relativeDifference as number
      data['min_instrument_half_m'] = instHalf
      data['relative_difference'] = rel
      data['configured_exceeds_instrument'] = v.configuredExceeds

      if (v.verdict === 'ok') {
        return ok(
          { ...data, verdict: 'ok' },
          `压电范围对账 **一致**:仪器半程 ${nm1(instHalf)} nm,` +
            `配置 ${nm1(cfg)} nm(差 ${pct1(rel)}%)。`,
        )
      }

      const worse = v.configuredExceeds === true
      return ok(
        { ...data, verdict: 'mismatch' },
        `压电范围 **对不上**:仪器半程 ${nm1(instHalf)} nm` +
          `(X ${nm1(hx)} / Y ${nm1(hy)}),` +
          `而配置 xy_max_m = ${nm1(cfg)} nm —— 差 ${pct1(rel)}%。` +
          (worse
            ? ' **配置比仪器大**:选点器会提议针尖到不了的目标,' +
              '移动会以「超时」失败,而重试没有用 —— 换温度/换扫描器/改压电' +
              '标定之后最常见的就是这一种。请把 xy_max_m 改成 ' +
              `≤ ${(instHalf * 1e9).toFixed(0)} nm,或在 Nanonis 里把压电范围调回去。`
            : ' 配置比仪器小 —— 不会撞限位,但会白白浪费可用面积。'),
      )
    },
  }
}

export const CheckPiezoRange: Skill = makeCheckPiezoRange()

export const PIEZO_CHECK: Readonly<Record<string, Skill>> = { CheckPiezoRange }
