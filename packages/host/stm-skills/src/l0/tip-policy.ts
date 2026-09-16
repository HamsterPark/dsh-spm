/**
 * 修针类技能共享的两条**不需要针尖登记表**的规则。
 *
 * 旧仓 `_tip_policy.py` 里有四样东西，这里只搬得动两样：
 *
 * | 旧仓 | 这里 |
 * |---|---|
 * | `shaper_bias_default` | ✅ 只发一条 `Bias_Get`，自成一体 |
 * | `resolved_lift_height_m` | ✅ 纯参数逻辑 |
 * | `apply_tip_policy` / `policy_fields_for_result` | ❌ 要 `tip_conditioning_resolver`（针尖登记表，Phase 5.3） |
 * | `qplus_gate` | ❌ 要 `tip_state`；而且它**出厂就是关的**（2026-08-16 现场决定） |
 *
 * 没搬的那两样**是欠的账，不是删掉的东西** —— 见本批交接里那条登记：
 * `BiasPulseWithReadback.validate_params` 在旧仓靠 `apply_tip_policy` 做针尖安全
 * 包络（铂铱 8 V、qPlus 3 V…），**超上限拒绝、不夹紧**。登记表落地之前，
 * 本仓这一侧只有全局 ±10 V 的 SafetyGate 在挡。
 */
import { pyFloatRepr, type SkillContext } from 'dsh-spm-kernel'
import { body } from './common.js'

/** {@link shaperBiasDefault} 的结果。`v === null` 时 `why` 是**给人看的原因**。 */
export interface ShaperBias {
  readonly v: number | null
  readonly why: string
}

/**
 * Tip shaper 的 `bias_v` 缺省值 = **此刻的成像偏压**；读不到给 `(null, 原因)`。
 *
 * 修法如下：
 *
 * shaper 应继承扫图 bias，而不是固定为 3 V。
 *
 * 在此之前两个扎针技能都写着 `params.get("bias_v", 3.0)`。那个 3.0 追到 v1 移植时的
 * stub 占位，**没有任何物理来源** —— 它对应哪台机器、哪根针？哪台都不对。
 *
 * 换成读取之后有三处直接受益：qPlus 那条路**一处生效**（成像偏压设成 20 mV →
 * shaper 自带就是 20 mV），不再需要两处配合、也就不会再出现「一处设了、另一处顶掉」
 * 这避免了设定值被另一条默认路径覆盖；
 * 非 qPlus 针尖沿用成像偏压也是最小惊讶，3 V 是一个**会实际改变针尖**的动作，
 * 不该是默认发生的事；而 `change_bias` 这个参数**保留**，调用方仍可显式关掉。
 *
 * **读不到不回落到 3.0。** `lookup() || DEFAULT` 正是数不清第几次的形状；
 * 这里宁可让调用方看到一句「读不到当前偏压」，也不要悄悄在结上打一个没人要的 3 V。
 *
 * 两处与旧仓不同，都是结构性的：
 *
 * * 旧仓包了一层 `try/except` 抓 `safe_call` 抛异常 —— 本仓 `safeCall` 的契约是
 *   **永不抛**（失败表达成 `record.error`），那条分支在这里不存在。
 * * **D-SKILL-2**：旧仓读不懂时印 `str(return_value)[:80]`，也就是三段信封的
 *   Python repr。信封在 `nanonis-wire` 那层就拆掉了，这里印我们真有的东西。
 */
export async function shaperBiasDefault(ctx: SkillContext): Promise<ShaperBias> {
  const rec = await ctx.safeCall('Bias_Get')
  if (rec.error !== undefined && rec.error !== '') return { v: null, why: `Bias_Get 报错:${rec.error}` }
  const b = body(rec)
  const v0 = b[0]
  if (typeof v0 !== 'number') {
    return { v: null, why: `Bias_Get 回包读不懂(values=${JSON.stringify(b)})` }
  }
  // NaN / inf 不是读数。旧仓这里印的是 `repr(val)`，所以走 `pyFloatRepr`。
  if (!Number.isFinite(v0)) return { v: null, why: `Bias_Get 读回 ${pyFloatRepr(v0)}` }
  return { v: v0, why: '' }
}

/**
 * `float(value)` 或 `null`。
 *
 * **不是 `Number(value ?? 0)`，也不是 `value || 0`** —— `0.0` 是一个真实的高度
 * （D-ZERO-1 那一族）。旧仓这个函数的注释逐字写着这句话，而它存在的唯一理由
 * 就是不让下面那条「没给就取 −tip_lift_m」的规则被一个合法的 0 触发。
 */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return null
  const s = String(value).trim()
  if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null
  return Number(s)
}

/**
 * 第二段斜坡的高度：没给就 = `−tip_lift_m`（压进去多少就抬回来多少）。
 *
 * 这条规则本来只活在 composite 里（三处各写一遍），而**裸技能的默认是 0.0**：
 * 模型直接调 TipShape 只给 `tip_lift_m` 时，针压下去就不抬了，靠 `restore_feedback`
 * 把它拽回来。规则住在三个调用方而不是被调方，正是「规则没下沉」那一类（2026-08-11）。
 *
 * **显式给 0.0 仍然是 0.0** —— 「不抬」是一个合法意图，只是不该是**缺省**意图。
 */
export function resolvedLiftHeightM(params: Readonly<Record<string, unknown>>): number {
  const given = numOrNull(params['lift_height_m'])
  if (given !== null) return given
  const lift = numOrNull(params['tip_lift_m'])
  return lift === null ? 0.0 : -lift
}
