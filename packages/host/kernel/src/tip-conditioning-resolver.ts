/**
 * 修针参数解析 —— **一个数字从哪来，必须查得到；超包络拒绝，不夹紧**。
 *
 * 形状照 `scan-resolver.ts`（逐字段独立走链 + 来源 trace + 依赖可注入），解决的是同一类
 * 问题：模型不该替物理发明数字，但也不能一刀切地拒绝它给的值。
 *
 * 优先级链（**逐字段独立**，不是整组切换）：
 *
 * 1. `explicit` —— 调用方显式给的值（模型或用户在 tool call 里写的）
 * 2. 宿主覆写方案表（{@link processTipRegistry}`.overrides`）
 * 3. 出厂方案表按当前针尖的「材料 × 制备 × 形态」查出来的档
 * 4. 通用保守默认（针尖未登记时就是这一档）
 *
 * ## clamp 还是拒绝
 *
 * 这一层**不 clamp**。`resolveScan` 里 clamp 是对的 —— 偏好表里一个手滑的数字不该让整次
 * 扫描失败，那是**参数卫生**。这里不一样：超出针尖安全包络的处理会**不可逆地毁掉硬件**
 * （qPlus 石英音叉尤其：损坏要拆机重装 + 重新标定 f₀/Q）。把 8 V 悄悄夹成 3 V，用户会
 * **以为自己打了 8 V** 而结果不对；把针戳穿了则什么都救不回来。所以超包络一律
 * **拒绝并说明**，与粗动电压四重锁同一条哲学。
 *
 * > 夹紧会把一次「这支针尖不能这么打」悄悄变成一次「按你能承受的最大值打」——
 * > 而调用方看到的是**成功**。
 *
 * ## 未登记针尖：这里**照样拒绝**
 *
 * 旧仓这段注释原本写着「未登记针尖时不拒绝任何东西（fail-open，与 sample_gate 同款）」。
 * **那句是假的**（2026-08-10 更正）：未登记时用的是通用保守档，而那一档**有自己的包络**，
 * 这里照样对着它判、照样拒绝。fail-open 的是**另一件事** —— `qplus_gate` 那道**策略**门
 * 在读不到针尖时放行，而且它出厂就是关的。两道门，两条哲学，而那段注释把其中一道的性质
 * 安到了另一道头上。
 *
 * **要推翻「未登记也拒绝」需要回答**：不知道装的是什么针时，按最保守档拒绝，和放行让
 * 用户自己负责，哪个更可能毁掉硬件？现在的实现选前者。
 *
 * ## 这道闸装在哪一层（本仓的接法）
 *
 * 技能的 `validateParams`（内核 **K6**）—— 也就是**任何硬件调用之前**，而且拒绝的文字
 * 原样回给调用方（模型看到的是「为什么被拒」而不是一次静默的 no-op）。
 * 这正是 D-TIP-1 当初决定「宁可不写 `validateParams`」要保护的东西：写一个空的会让人
 * 以为这道闸在。**现在它是实的。**
 */
import { formatG, pyFloatRepr } from './si.js'
import { pyNum } from './scan-resolver.js'
import {
  INT_FIELDS, LIMIT_FIELDS, TIP_SOURCE_EXPLICIT, resolvePolicy, type ResolvedPolicy,
} from './tip-conditioning-policy.js'
import { currentTipFacts, type TipFacts } from './tip-registry.js'

/** 解析结果：参数 + 每个值的来源 + 拒绝原因（如果有）。 */
export interface ResolvedConditioning {
  readonly params: Readonly<Record<string, unknown>>
  /** 字段 → 来源（explicit / operator_override / policy_table / factory_default）。 */
  readonly trace: Readonly<Record<string, string>>
  /** 非空 = **被拒绝**，调用方必须**不执行**并把这些话回给用户。 */
  readonly refusals: readonly string[]
  /** 当前针尖的说明（放进技能结果给模型看）。 */
  readonly notes: readonly string[]
  /** 解析时当前针尖的事实（`null` = 未登记）。 */
  readonly tip: TipFacts | null
  readonly ok: boolean
}

/**
 * 旧仓 `ResolvedConditioning.warnings` **没有移植**：它在旧仓全仓**没有一处写入、
 * 也没有一处读出**。一个永远是空表的字段，读的人只会以为「这次没有警告」。
 */

/**
 * Python 的 `repr`，只用在 {@link humanTrace} 上（见 `INT_FIELDS` 的注释）。
 *
 * 浮点走 `pyFloatRepr` 而**不是** `String(v)`：两种语言换指数记法的门槛不同，
 * 而这一族的数正好落在分岔带里 —— `-3e-9` 在 Python 是 `-3e-09`（两位指数），
 * 在 JS 是 `-3e-9`。方案表里每一个深度都是这个量级。
 */
function reprOf(field: string, v: unknown): string {
  if (typeof v === 'number') {
    if (INT_FIELDS.has(field)) return String(Math.trunc(v))
    return pyFloatRepr(v)
  }
  if (typeof v === 'string') return `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (v === null || v === undefined) return 'None'
  return String(v)
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  explicit: '调用方指定',
  operator_override: '用户覆写',
  policy_table: '针尖方案表',
  factory_default: '通用默认',
}

/**
 * 「pulse_v=5.0（针尖方案表）」这样的一行，放进技能结果里。
 *
 * ⚠️ **JS 只有一种数**（D-FLOAT-1）：`pulse_count` 在旧仓印 `1`、`pulse_v` 印 `3.0`，
 * 而这边两者都是 `number`。整数性由 `INT_FIELDS`（方案表的**字段表**）给，
 * 不是从值上猜 —— 从值上猜的话一个 `pulse_v=4`（整数伏）会印成 `4`。
 */
export function humanTrace(res: ResolvedConditioning): string {
  const bits: string[] = []
  for (const k of Object.keys(res.trace).sort()) {
    if (!(k in res.params)) continue
    const label = SOURCE_LABELS[res.trace[k]!] ?? res.trace[k]!
    bits.push(`${k}=${reprOf(k, res.params[k])}（${label}）`)
  }
  return bits.join('；')
}

export interface ResolveConditioningOptions {
  /** 当前针尖；不给就读 holder。`skipFactsLookup` 为真时**不读**（= 按未登记算）。 */
  readonly facts?: TipFacts | null | undefined
  readonly overrides?: Readonly<Record<string, unknown>> | undefined
  readonly skipFactsLookup?: boolean | undefined
}

/**
 * 把请求的 *fields* 解析成一整组参数 + 来源痕迹，并过一遍安全包络。
 *
 * *explicit* 里值为 `null` / 缺席的字段走方案表；给了值的字段被采纳，但**仍要过安全包络
 * 检查**（超了就拒绝，不夹紧）。
 *
 * 旧仓那两个「顺手读一下」在这里是**入参或进程级注入**（同 D-VAC-1 / D-LIMITS-1）：
 *
 * | 旧仓 | 这里 | 不给时 |
 * |---|---|---|
 * | `_read_tip_facts()` 读 holder，异常吞掉 | `opts.facts` / {@link currentTipFacts} | `null` = 未登记 ⇒ 通用档，**闸照常关** |
 * | `_read_overrides()` 延迟 import `SettingsStore` | `opts.overrides` / `processTipRegistry.overrides` | `{}` = 没设覆写 ⇒ 出厂包络 |
 *
 * ⚠️ 旧仓那个 `_read_overrides` 值得记一笔：它调的 `SettingsStore()` 的 `config_dir` 是
 * **必填位置参数**，无参调用抛 `TypeError`、被 `except` 吞掉 —— 于是这个函数从上线起
 * **恒返回 `{}`**，用户的覆写一次都没被读到过（2026-08-10 实测）。而返回 `{}` 正好等于
 * 「没设覆写」，所以整条链看上去完全正常。**本仓没有那条延迟 import，也就没有那个洞。**
 */
export function resolveConditioning(
  fields: readonly string[],
  explicit: Readonly<Record<string, unknown>> = {},
  opts: ResolveConditioningOptions = {},
): ResolvedConditioning {
  const facts =
    opts.facts !== undefined
      ? opts.facts
      : opts.skipFactsLookup === true
        ? null
        : currentTipFacts()
  const policy = resolvePolicy(facts, { overrides: opts.overrides })

  const params: Record<string, unknown> = {}
  const trace: Record<string, string> = {}
  for (const name of fields) {
    const given = explicit[name]
    // 旧仓：`given is not None and str(given).strip() != ""`。
    // **`0` 与 `false` 是真实的值**（D-ZERO-1 那一族）：`str(0).strip()` 是 `"0"`，
    // 非空 ⇒ 采纳。这里照移，不是 `if (given)`。
    if (given !== null && given !== undefined && String(given).trim() !== '') {
      params[name] = given
      trace[name] = TIP_SOURCE_EXPLICIT
      continue
    }
    if (name in policy.values) {
      params[name] = policy.values[name]!
      trace[name] = policy.sources[name] ?? 'policy_table'
    }
    // 表里没有这个字段就**不填** —— 由技能自己的声明默认兜底。
  }

  const refusals = checkEnvelope(params, policy, facts)
  return { params, trace, refusals, notes: policy.notes, tip: facts, ok: refusals.length === 0 }
}

/** 安全包络：超上限**拒绝**，不夹紧。 */
function checkEnvelope(
  params: Readonly<Record<string, unknown>>,
  policy: ResolvedPolicy,
  facts: TipFacts | null,
): string[] {
  const refusals: string[] = []
  const isQPlus = facts !== null && facts.form === 'qplus'
  const what =
    facts !== null ? `当前针尖（${facts.name === '' ? '未命名' : facts.name}）` : '未登记针尖的通用档'

  // ① 脉冲 / 整形电压：**按绝对值**比（一发 −10 V 与 +10 V 一样会改造针尖）。
  const maxPulse = pyNum(policy.values['max_abs_pulse_v'])
  for (const k of ['pulse_v', 'shaper_bias_v', 'shaper_lift_v']) {
    const val = pyNum(params[k])
    if (val === null || maxPulse === null) continue
    if (Math.abs(val) > maxPulse) {
      refusals.push(
        `${k}=${formatG(val, 6)} V 超出${what}的安全上限 ±${formatG(maxPulse, 6)} V。` +
          (isQPlus
            ? 'qPlus 石英音叉损坏不可逆（需拆机重装并重新标定 f₀/Q），所以这里拒绝而不是替你夹到上限。'
            : '拒绝而不是夹到上限——夹了你会以为自己用的是原来那个值。') +
          '确需更大幅度请先确认针尖类型登记正确，或在设置里调整该针尖的方案上限。',
      )
    }
  }

  // ② 下压深度：**深度是负数（向表面下压），比绝对值**。
  const maxDepth = pyNum(policy.values['max_poke_depth_m'])
  for (const k of ['shaper_depth_m', 'poke_shallow_depth_m', 'poke_deep_depth_m']) {
    const val = pyNum(params[k])
    if (val === null || maxDepth === null) continue
    if (Math.abs(val) > maxDepth) {
      refusals.push(
        `${k}=${expo3(val)} m 的下压深度超出${what}的上限 ${expo3(maxDepth)} m。` +
          (isQPlus ? 'qPlus 传感器被戳坏不可逆。' : '') +
          '拒绝执行。',
      )
    }
  }

  // ③ 发数。**全表现在只剩这一个还在分辨针尖的包络字段**（通用 5 / qPlus 2），
  // 而 `TipPulse.count` 的声明上限是 50 —— K6 的范围检查放行的值，这道闸会拒。
  const maxCount = pyNum(policy.values['max_pulse_count'])
  const cnt = pyNum(params['pulse_count'])
  if (cnt !== null && maxCount !== null && cnt > maxCount) {
    refusals.push(
      `pulse_count=${Math.trunc(cnt)} 超出${what}的上限 ${Math.trunc(maxCount)} 发。拒绝执行。`,
    )
  }

  return refusals
}

/**
 * Python 的 `f"{x:.3e}"`。JS 的 `toExponential(3)` 给 `1.000e-8`，Python 给 `1.000e-08`。
 *
 * ⚠️ 这是**第四份**（`tip-crash-tracker.ts` 的 `expo3`、`stm-skills/l0/common.ts` 的
 * `pyExp`、`vision` 的 `exp2`）。它们不能互相 import：内核是最底下那层，而另两份在上面的
 * 包里。收语言分歧那一族时这四份该一起搬进 `si.ts`（同 D-LANG-1 的 `pyFixed`）——
 * 这一轮并行支线在改文件，先各自留着。
 */
function expo3(x: number): string {
  const s = x.toExponential(3)
  const i = s.indexOf('e')
  const mant = s.slice(0, i)
  let exp = s.slice(i + 1)
  const sign = exp.startsWith('-') ? '-' : '+'
  if (exp.startsWith('-') || exp.startsWith('+')) exp = exp.slice(1)
  if (exp.length < 2) exp = `0${exp}`
  return `${mant}e${sign}${exp}`
}

/**
 * 当前针尖的安全包络（给自检 / UI 用）。
 *
 * 旧仓的 `envelope_of` 全仓**零调用方**；本仓有一个 —— `TipForgeSelfCheck` 要把
 * 「这支针尖现在的上限是多少」印出来。没有消费方的形状不移，有了就是这一个。
 */
export function envelopeOf(facts?: TipFacts | null): Readonly<Record<string, number>> {
  const f = facts === undefined ? currentTipFacts() : facts
  const pol = resolvePolicy(f)
  const out: Record<string, number> = {}
  for (const k of LIMIT_FIELDS) {
    const v = pol.values[k]
    if (v !== undefined) out[k] = v
  }
  return out
}
