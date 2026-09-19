/**
 * 修针类技能共享的接线：方案表参数填充 + 两条不需要登记表的规则。
 *
 * 旧仓 `_tip_policy.py` 里有四样东西：
 *
 * | 旧仓 | 这里 |
 * |---|---|
 * | `shaper_bias_default` | ✅ 只发一条 `Bias_Get`，自成一体（批 3j） |
 * | `resolved_lift_height_m` | ✅ 纯参数逻辑（批 3j） |
 * | `apply_tip_policy` / `policy_fields_for_result` | ✅ **批 5a 还上了** —— 针尖登记表底座进了内核 |
 * | `qplus_gate` | ❌ **不移**，见下 |
 *
 * ## D-TIP-1 的欠账在这一批结清
 *
 * `BiasPulseWithReadback.validate_params` 在旧仓靠 `apply_tip_policy` 做针尖安全包络，
 * **超上限拒绝、不夹紧**。批 3j 当时**没有写一个空的 `validateParams`** —— 写了会让人
 * 以为这道闸在。现在它是实的：{@link applyTipPolicy} → `resolveConditioning` →
 * 包络判据，装在内核 K6（**任何硬件调用之前**）。
 *
 * ## `qplus_gate` 为什么不移
 *
 * 它**出厂就是关的**：旧仓 `_guard_on()` 读 `MAST_QPLUS_POKE_GUARD`，默认 `"0"`，
 * 第一行就 `return None`。这条检查对默认行为**零差别**，而移过来等于在本仓多一个
 * 「看起来在挡、其实关着」的东西。
 *
 * **真正护音叉的那两样都在**：扎针深度包络 `max_poke_depth_m`（超了拒绝不夹紧，
 * 就在这一批里）与「扎针前把偏压缓降到 20 mV」（`shaperBiasDefault` 那条「跟随成像偏压」
 * 已经在批 3j 落了 —— qPlus 实验里成像偏压就是 20 mV 本身）。
 */
import {
  humanTrace,
  pyFloatRepr,
  resolveConditioning,
  type ResolvedConditioning,
  type SkillContext,
} from 'dsh-spm-kernel'
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

/**
 * 按当前针尖的方案表补齐 *params* 里没给的值，并检查安全包络。
 *
 * *policyFields* 是方案表里的字段名；*rename* 把它们映射到技能自己的参数名
 * （例如方案表的 `shaper_bias_v` → TipShape 的 `bias_v`）。
 *
 * 返回 `{ params, plan }`。**`plan.ok` 为 `false` 时调用方必须不执行。**
 *
 * ## 与旧仓的一处结构差别：这里**不会**返回 `plan === null`
 *
 * 旧仓把 `import` 与调用各包一层 `try/except`，失败就 `return params, None`
 * ——「方案表读不到绝不能让修针技能失败，技能自己的声明默认值仍在」。那是**动态 import
 * 的属性**：旧仓那个模块可能因为任何一个传递依赖装不上而 import 失败。本仓这一条是
 * **静态 import**，掉一个模块是 `tsc` 编译错误 —— 这个不变量在 TypeScript 里不存在，
 * 而留着那条 `null` 分支等于留一条**永远走不到、却看起来是 fail-open 兜底**的路。
 *
 * ⚠️ 差别只在「解析层在不在」。**解析层在、但拒绝了**，仍然是拒绝 —— 那条路照移。
 */
export function applyTipPolicy(
  params: Readonly<Record<string, unknown>>,
  policyFields: readonly string[],
  rename: Readonly<Record<string, string>> = {},
): { params: Record<string, unknown>; plan: ResolvedConditioning } {
  // 技能参数名 → 方案表字段名，把调用方显式给的值带进解析。
  const explicit: Record<string, unknown> = {}
  for (const field of policyFields) {
    const skillKey = rename[field] ?? field
    const v = params[skillKey]
    if (v !== null && v !== undefined) explicit[field] = v
  }

  const plan = resolveConditioning(policyFields, explicit)

  const out: Record<string, unknown> = { ...params }
  for (const field of policyFields) {
    if (field in plan.params) out[rename[field] ?? field] = plan.params[field]
  }
  return { params: out, plan }
}

/**
 * 扎针**深度**过针尖包络 —— 只拒绝，不夹紧，**不填任何默认值**（批 6a 补，本仓新增）。
 *
 * ## 为什么要单独一个函数，而不是加进 {@link applyTipPolicy} 的 `policyFields`
 *
 * 批 6a 核出来：深度那半道包络（`max_poke_depth_m`）**生产路径上没有任何输入到得了它**。
 * 两个 shaper 技能报给方案表的是 `shaper_bias_v` / `shaper_lift_v` —— **两个都是电压**；
 * 而 `checkEnvelope` 判深度认的键是 `shaper_depth_m` / `poke_shallow_depth_m` /
 * `poke_deep_depth_m`，一个都没送进去。于是一发 **50 nm** 的下压：声明范围 ±100 nm 放行，
 * 全局硬闸**是管深度的**（`GLOBAL_CHECKS` 里 `tip_lift` / `lift_height` / `deep_depth` 三行），
 * 只是它的界 `tip_lift_min_m/max_m` = ±100 nm 与 K6 声明范围同宽 ⇒ **50 nm 照样放行**；
 * 针尖包络才是那道紧的，而它**看不见这个参数** —— 而 qPlus 档的上限是 10 nm。
 * （2026-09-19 订正：原文写「只管电压」。结论不变，理由是错的 —— 见 D-TIPDEPTH-1。）
 *
 * 旧仓同样如此，**而且旧仓自己的 `FIELD_OWNERS` 写着 `shaper_depth_m → ("TipShape",)`**：
 * 这个字段本来就是给它准备的，只是全仓没有一处把值送进去（生产方接好了、消费方缺席，
 * 同 `_tip_phases.py:2106` 那条 `exclude_used_spots`）。**本仓这一条比旧仓严。**
 *
 * 最自然的接法（把 `shaper_depth_m` 加进 `applyTipPolicy` 的 `policyFields`）**不行**：
 * `resolveConditioning` 对**没给**的字段会去方案表取值填进 `params`，于是调用方不传
 * `tip_lift_m` 时会凭空多出一个下压深度 —— 那是**行为改变**，不是补一道闸。
 * 更糟的是它会让「出厂默认落在自己包络之外」那条路复活（`tippulse-refuses-before-planning`
 * 钉着的那一条，旧仓真出过）：操作员把 `max_poke_depth_m` 收到 0.5 nm 时，
 * 通用档的出厂 `shaper_depth_m = -1 nm` 会让一次**根本没要求下压**的调用被拒。
 *
 * 所以这里**只在 `tip_lift_m` 显式给出时**单独判一次，且只取 `refusals`。
 *
 * ## 只判**下压**那一半
 *
 * `tip_lift_m` 是有符号的方向量（负 = 压向表面，正 = 抬离），而 `shaper_depth_m` 的
 * 定义域是**下压**（方案表里全表是负数）。`checkEnvelope` 按绝对值比，是因为那个字段
 * 按构造就是负的；把一次**抬起**送进去，等于拿抬起去撞下压的上限 ——
 * 凭空多一条方案表从来没声明过的限制。一次 50 nm 的**抬离**不会戳坏音叉。
 */
export function tipDepthRefusals(params: Readonly<Record<string, unknown>>): string[] {
  const given = params['tip_lift_m']
  if (typeof given !== 'number' || !Number.isFinite(given) || given >= 0) return []
  return [...resolveConditioning(['shaper_depth_m'], { shaper_depth_m: given }).refusals]
}

/**
 * 放进 `SkillResult.data` 的方案痕迹 —— **每个数字是谁给的，事后查得到**。
 *
 * 键与旧仓逐字相同（它们进金样）：`tip_policy` / `tip_policy_notes` /
 * `tip_registered` / `tip_name`。后两个的**缺席也是信息**：`tip_name` 只在真的登记了
 * 针尖时才有，`tip_policy_notes` 只在方案表确实说了什么时才有。
 */
export function policyFieldsForResult(plan: ResolvedConditioning | null): Record<string, unknown> {
  if (plan === null) return {}
  const out: Record<string, unknown> = { tip_policy: humanTrace(plan) }
  if (plan.notes.length > 0) out['tip_policy_notes'] = plan.notes.join(' ')
  out['tip_registered'] = plan.tip !== null
  if (plan.tip !== null) out['tip_name'] = plan.tip.name
  return out
}
