/**
 * 修针方案表 —— **按针尖类型决定用什么参数处理它**。
 *
 * 现场 2026-07-31 拍板，逐字：
 *
 * > 「要有完整参数方案表。（当前水平的）LLM 可不懂 STM 实验，让他自己想参数就麻烦了。」
 *
 * 这与扫图智能那次的结论同源：**不是提示模型别乱填数字，而是移除它发明数字的诱因**。
 * 在此之前修针技能的参数只有两条来源 —— 模型在 tool call 里现编，或者一个写死的常量
 * （`tip_shaper` 的 bias 3.0 V 对钨腐蚀针和铂铱剪切针是同一个数）。两条都不对：
 * 前者让不懂 STM 的模型替物理做决定，后者假装所有针尖一样。
 *
 * ## 表的形状
 *
 * 键是 `(material, fabrication, form)`，查表**逐级回退**：
 *
 *     (W, etched, stm_wire) → (W, *, stm_wire) → (*, *, stm_wire) → 通用默认
 *
 * 所以只有真正需要区分的组合才写进表里，其余自动落到更粗的那一档。未登记针尖时落到
 * 通用默认 —— 那一档刻意保守。
 *
 * ## 数值从哪来
 *
 * 出厂值取自公开文献与常见实践，**逐项注明来源**，并一律标「待真机标定」。知识库值是
 * 近似，随仪器 / 样品 / 温度变，别当权威默认。用户覆写走
 * {@link processTipRegistry}`.overrides`（旧仓存 `SettingsStore` 的
 * `tip_conditioning_overrides`），优先级高于出厂值。
 *
 * ## 安全包络
 *
 * 每档带一组**上限**。它们与参数默认值是两回事：默认值是「不给就用这个」，上限是
 * 「给了也不许超」。超上限的处理是**拒绝，不 clamp** —— clamp 属参数卫生
 * （`scan-resolver.ts` 那一层），而这里是安全层，与粗动电压四重锁同一条哲学。
 *
 * ---
 *
 * ## ⚠️ 我核出来与 D-TIP-1 的描述不一样的地方（**这一条必须读**）
 *
 * D-TIP-1 与盘点都写着「铂铱（包络 8 V）、磁性 / 超导针、qPlus（3 V）会在那里被拒绝」。
 * **今天的旧仓不是这样。** 2026-08-12 现场把这两个上限**统一拉满**，逐字：
 *
 * > 凭多年 STM 经验，这个安全包络定得过严、没有实际意义，针尖没有那么容易损坏。
 *
 * 于是**全部档位**一律 `max_abs_pulse_v = 10.0 V`、`max_poke_depth_m = 1.0e-8`（10 nm）。
 * 我逐档核过（下面这张表就是照着抄的）：这两个上限**没有一档是不同的**。
 * 现在还能分辨针尖的包络字段只剩 **`max_pulse_count`**（通用 5 / qPlus 2）。
 *
 * **这不代表这道闸是摆设**，三条：
 *
 * 1. `max_pulse_count` 真的在挡：`TipPulse.count` 的声明上限是 **50**，包络是 5（qPlus 2）
 *    —— K6 的范围检查放行的值，这道闸会拒；
 * 2. **覆写可以收紧**：宿主把 `max_abs_pulse_v` 填成 3.0，这道闸立刻按 3.0 判；
 * 3. 它在**任何硬件调用之前**拒（`validateParams`，K6），而全局 ±10 V 的 SafetyGate
 *    只在 K7 按参数名子串判 —— 两者都在，但只有这一道知道**装的是哪根针**。
 *
 * 各档的**推荐值**（`pulse_v` / `poke_deep_depth_m` …）一个都没动，只动上限。
 * 附带影响（旧仓自己写下来的，免得以后当成 bug）：包络不再夹住任何默认值之后，
 * 「已改用这根针方案表里的值」那句提示**不会再出现**。
 */
import { pyNum } from './scan-resolver.js'
import type { TipFacts } from './tip-registry.js'
import { processTipRegistry } from './tip-registry.js'

/** 通配符：表里用它表示「这一维不区分」。 */
export const ANY = '*'

/**
 * 安全包络字段（上限，超了**拒绝**）。
 *
 * 旧仓把它导出了，而全仓**零消费方**（`envelope_of` 是唯一读它的地方，
 * 而 `envelope_of` 自己也没有调用方）。这里留着它是因为
 * `tip-conditioning-resolver.ts` 的 `envelopeOf` 确实按它交包络给自检用。
 */
export const LIMIT_FIELDS = ['max_abs_pulse_v', 'max_poke_depth_m', 'max_pulse_count'] as const

/**
 * 语义上是整数的字段。
 *
 * **JS 只有一种数**（D-FLOAT-1），而 `human_trace()` 印的是 Python 的 `repr`：
 * 一个 `pulse_count` 在旧仓印 `1`，一个 `pulse_v` 印 `3.0`。同 `scan-resolver.ts`
 * 的 `isInt`：这是一个**渲染提示**，不是一个新判据。
 */
export const INT_FIELDS: ReadonlySet<string> = new Set([
  'pulse_count', 'poke_steps', 'max_attempts', 'max_pulse_count',
])

interface Layer {
  readonly values: Readonly<Record<string, number>>
  readonly note: string
}

/**
 * 通用保守档 —— 未登记针尖 / 认不出的组合落到这里。
 *
 * 刻意保守：不知道针是什么的时候，宁可处理不够也不要一发把针打没。
 *
 * ⚠️ `shaper_bias_v` / `shaper_lift_v` **故意不在这里**（旧仓 2026-08-11 删除）。
 * 它们原本是 3.0 / 3.0 —— 与 `tip_shaper` 的声明默认同源、同为那个 v1 移植 stub 的
 * 后代，**没有任何物理来源**。留着它们的代价不是「多了一个可疑的数字」，而是
 * **让「跟随当前成像偏压」那条修法在 composite 路上成为死代码**：方案表先填 3.0，
 * 技能里那段 `if (biasV === null)` 就永远走不到。
 * 表里没有这个字段 ⇒ 解析器不填 ⇒ 技能自己去读**此刻的成像偏压**
 * （`shaperBiasDefault`），读不到就拒绝。
 *
 * **上限 `max_abs_pulse_v` 保留** —— 删掉的是「没人要也照打」的缺省值，不是包络。
 */
const FACTORY_DEFAULT: Layer = {
  values: {
    pulse_v: 3.0,
    pulse_duration_s: 0.1,
    pulse_count: 1,
    shaper_depth_m: -1.0e-9,
    poke_shallow_depth_m: -5.0e-10,
    poke_deep_depth_m: -2.0e-9,
    poke_steps: 5,
    target_quality: 0.3,
    max_attempts: 5,
    max_abs_pulse_v: 10.0,
    max_poke_depth_m: 1.0e-8,
    max_pulse_count: 5,
  },
  note: '针尖未登记或组合未收录 —— 用保守通用参数。登记针尖可得到更合适的方案。',
}

/** `(material, fabrication, form)` → 只写与上一级**不同**的字段。 */
const POLICY_TABLE: ReadonlyMap<string, Layer> = new Map<string, Layer>([
  // ── 普通金属丝针尖 ──────────────────────────────────────────────────
  [`${ANY}|${ANY}|stm_wire`, {
    // 10.0 = Nanonis bias 常见量程，也是 TipPulse 的声明上限
    values: { pulse_v: 4.0, max_abs_pulse_v: 10.0, max_poke_depth_m: 1.0e-8 },
    note: '金属丝针尖通用档。',
  }],
  // 钨：硬、耐打，但暴露大气后有氧化层，初次进针常需要更强的处理才出好态。
  [`W|${ANY}|stm_wire`, {
    values: { pulse_v: 5.0, shaper_bias_v: 4.0, shaper_depth_m: -1.5e-9, poke_deep_depth_m: -3.0e-9 },
    note: '钨针较硬、耐处理;氧化层可能需要偏强的首轮处理。待真机标定。',
  }],
  // 腐蚀针顶端细，单次不宜过猛；宁可多来一轮。
  ['W|etched|stm_wire', {
    values: { pulse_v: 5.0, max_attempts: 6 },
    note: '钨电化学腐蚀针:顶端细,宁可多轮轻处理。待真机标定。',
  }],
  // 剪切钨针顶端不规则、常有多个微尖 —— 双针尖先验高，需要更多轮成形。
  ['W|cut|stm_wire', {
    values: { pulse_v: 5.5, max_attempts: 8, poke_deep_depth_m: -4.0e-9 },
    note: '钨剪切针:多微尖先验高,通常需要更多轮成形。待真机标定。',
  }],
  // 铂铱：不氧化、惰性好、适合谱学，但材质软 —— 重手法容易钝掉甚至粘针。
  [`PtIr|${ANY}|stm_wire`, {
    values: {
      pulse_v: 3.0, shaper_bias_v: 2.5, shaper_depth_m: -8.0e-10,
      poke_shallow_depth_m: -3.0e-10, poke_deep_depth_m: -1.5e-9,
      max_abs_pulse_v: 10.0, max_poke_depth_m: 1.0e-8,
    },
    note: '铂铱软:处理要比钨针轻,深压容易钝尖/粘针。待真机标定。',
  }],
  ['PtIr|cut|stm_wire', {
    values: { max_attempts: 7 },
    note: '铂铱剪切针:软 + 多微尖,轻处理多轮。待真机标定。',
  }],
  [`Pt|${ANY}|stm_wire`, {
    values: { pulse_v: 3.0, shaper_bias_v: 2.5, max_abs_pulse_v: 10.0 },
    note: '铂针软且惰性,处理宜轻。待真机标定。',
  }],
  [`Ir|${ANY}|stm_wire`, {
    values: { pulse_v: 4.0 },
    note: '铱针硬度高于铂铱、惰性好。待真机标定。',
  }],
  // 磁性针尖（自旋极化）：磁构型是实验对象的一部分 —— 大力处理不只改几何，
  // 还会改磁性，把「修好了」变成「换了一根不同的针」。
  [`Fe|${ANY}|stm_wire`, {
    values: {
      pulse_v: 2.5, shaper_bias_v: 2.0, shaper_depth_m: -5.0e-10,
      poke_shallow_depth_m: -2.0e-10, poke_deep_depth_m: -1.0e-9,
      max_abs_pulse_v: 10.0, max_poke_depth_m: 1.0e-8, max_attempts: 4,
    },
    note: '磁性针尖:处理会改变磁构型,不只是几何形状。自旋极化实验中「修针」可能使之前的磁对比不可比。待真机标定。',
  }],
  [`Ni|${ANY}|stm_wire`, {
    values: { pulse_v: 2.5, max_abs_pulse_v: 10.0 },
    note: '镍针为磁性针尖,处理会改变磁构型。待真机标定。',
  }],
  [`Co|${ANY}|stm_wire`, {
    values: { pulse_v: 2.5, max_abs_pulse_v: 10.0 },
    note: '钴针为磁性针尖,处理会改变磁构型。待真机标定。',
  }],
  [`Cr|${ANY}|stm_wire`, {
    values: { pulse_v: 3.0, max_abs_pulse_v: 10.0 },
    note: '铬针为反铁磁针尖(杂散场小),处理会改变磁构型。待真机标定。',
  }],
  // 超导针尖：回温、污染、强脉冲都可能破坏针尖超导能隙 —— 而那正是测量对象。
  [`Nb|${ANY}|stm_wire`, {
    values: { pulse_v: 2.0, max_abs_pulse_v: 10.0, max_poke_depth_m: 1.0e-8, max_attempts: 3 },
    note: '超导针尖:强处理会破坏针尖能隙,而能隙正是测量对象。优先换针而不是反复修。待真机标定。',
  }],

  // ── qPlus 传感器 ────────────────────────────────────────────────────
  //
  // 石英音叉被戳坏**不可逆**，要拆机重装（往往还要重新粘针、重新标定 f₀/Q）。
  // 所以这一档的 `max_pulse_count` 是全表唯一还在分辨针尖的包络字段（2 而不是 5）。
  //
  // ⚠️ `shaper_bias_v` / `shaper_lift_v` 从这一档**删除**（2026-08-11）。它们原本是
  // 1.5 / 1.5，与本档其余数字一样是「未标定的保守占位」—— 而这一条恰好有一个
  // **真机来源的规则直接顶掉它**：「qPlus 扎针必须先把偏压降到 20 mV，否则音叉起振、
  // 每次扎针都在毁针」。1.5 V 是 20 mV 的 75 倍。一个未标定的占位不该压过一条实机规则。
  [`${ANY}|${ANY}|qplus`, {
    values: {
      pulse_v: 2.0, pulse_duration_s: 0.05, pulse_count: 1,
      shaper_depth_m: -2.0e-10, poke_shallow_depth_m: -1.0e-10,
      poke_deep_depth_m: -3.0e-10, poke_steps: 3, max_attempts: 3,
      // **10 V：包络需要覆盖该工作流程的脉冲幅度**。
      // 这是现场记录的仪器约束，工作流程使用
      // 10 V / 500 ms，成功判据 Z 抬升 30–50 nm。此前的 3.0 是**保守占位**，
      // 过低的占位值会让流程无法发出所需脉冲。
      max_abs_pulse_v: 10.0,
      // 同样来自旧仓现场记录：浅扎深度先定为 3 nm，随后调整为 5 nm，再随全表调整为 10 nm。
      // ⚠️ 本档**其余**数字仍是未标定占位，别因为这两行看起来很确定就以为整张表
      // 都标定过了。
      max_poke_depth_m: 1.0e-8,
      max_pulse_count: 2,
    },
    note: 'qPlus 传感器:石英音叉损坏不可逆(需拆机重装 + 重新标定 f₀/Q)。深压与大脉冲一律拒绝,不夹紧。``max_poke_depth_m`` = 5 nm 出自 2026-08-10 用户真机判断(「5 nm 以内的下压对本机 W-qPlus 音叉无损」);本档**其余**数值仍待真机标定。',
  }],
  [`PtIr|${ANY}|qplus`, {
    values: { pulse_v: 1.5 },
    note: 'qPlus + 铂铱针:软材质 + 易损传感器,最轻的一档。待真机标定。',
  }],
  [`W|${ANY}|qplus`, {
    values: { pulse_v: 2.0 },
    note: 'qPlus + 钨针:材质耐打但传感器不耐打,按传感器的包络来。待真机标定。',
  }],
])

// ── trace 里 `source` 的全部取值 ──────────────────────────────────────────────
//
// ⚠️ **带 `TIP_` 前缀，而 `scan-resolver.ts` 那一族不带** —— 不是风格问题：
// 那边的 `SOURCE_DEFAULT` 是 **`'default'`**，这边是 **`'factory_default'`**。
// 名字一样、值不一样的两个常量放在同一个 `export *` 出口下，读的人只会看见离他最近
// 的那一个（D-CHANNELS-1 / D-PIEZO-1 记过同一件事的两个面）。`'explicit'` 两边同值，
// 但**一族里挑一个不带前缀**会让人以为另外三个也在那边有对应物。
export const TIP_SOURCE_EXPLICIT = 'explicit'
export const TIP_SOURCE_OVERRIDE = 'operator_override'
export const TIP_SOURCE_POLICY = 'policy_table'
export const TIP_SOURCE_FACTORY = 'factory_default'

export interface ResolvedPolicy {
  readonly values: Readonly<Record<string, number>>
  /** 字段 → 这个值是哪一级给的。与 `resolve_scan` 的 trace 同款：**一个数字从哪来，事后必须查得到**。 */
  readonly sources: Readonly<Record<string, string>>
  readonly notes: readonly string[]
}

/**
 * Python 的 `int(x)` 用在**整数字段的覆写**上：数值向零截断，字符串只认整数字面量。
 *
 * `scan-resolver.ts` 里那份是私有的，这里不去开它的口子 —— 两处的判据一样，
 * 而把一个私有函数导出来只为了这一个调用点，等于让两个模块从此绑在一起。
 * （收语言分歧那一族时 `pyInt` 该和 `pyFixed` / `pyExp` 一起搬进 `si.ts`。）
 */
function pyIntStrict(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!/^[+-]?\d+$/.test(s)) return null
  return Number(s)
}

/** 从粗到细的命中序列（后者覆盖前者）。 */
function lookupChain(material: string, fabrication: string, form: string): Layer[] {
  const mat = material.trim() === '' ? ANY : material.trim()
  const fab = fabrication.trim() === '' ? ANY : fabrication.trim()
  const frm = form.trim() === '' ? 'stm_wire' : form.trim()
  const keys = [
    `${ANY}|${ANY}|${frm}`, // 形态通用
    `${mat}|${ANY}|${frm}`, // 材料 × 形态
    `${mat}|${fab}|${frm}`, // 精确组合
  ]
  const out: Layer[] = []
  for (const k of keys) {
    const layer = POLICY_TABLE.get(k)
    if (layer !== undefined) out.push(layer)
  }
  return out
}

/**
 * 当前针尖对应的一整档方案（参数 + 安全包络 + 说明 + 来源痕迹）。
 *
 * *facts* 是 {@link currentTipFacts} 的返回（`null` = 针尖未登记 → 通用保守档）。
 * *overrides* 是宿主在设置里填的覆盖，优先级最高；不传就读
 * {@link processTipRegistry}`.overrides`（没接 ⇒ 空表 ⇒ 出厂包络生效，闸照常关）。
 */
export function resolvePolicy(
  facts: TipFacts | null,
  opts: { readonly overrides?: Readonly<Record<string, unknown>> | undefined } = {},
): ResolvedPolicy {
  const values: Record<string, number> = { ...FACTORY_DEFAULT.values }
  const sources: Record<string, string> = {}
  for (const k of Object.keys(values)) sources[k] = TIP_SOURCE_FACTORY
  const notes: string[] = []
  if (facts === null) notes.push(FACTORY_DEFAULT.note)

  if (facts !== null) {
    for (const layer of lookupChain(facts.material, facts.fabrication, facts.form)) {
      notes.push(layer.note)
      for (const [k, v] of Object.entries(layer.values)) {
        values[k] = v
        sources[k] = TIP_SOURCE_POLICY
      }
    }
  }

  const overrides = opts.overrides ?? processTipRegistry.overrides
  for (const [k, raw] of Object.entries(overrides)) {
    // 旧仓：`if key.startswith("_") or key not in out: continue` ——
    // 覆写只能改**这一档已经有的**字段，不能凭空长出一个。
    if (k.startsWith('_') || !(k in values)) continue
    if (raw === null || raw === undefined) continue
    // 旧仓 `type(out[key])(val)`：数值字段强制转数，转不动就记一笔调试日志并忽略
    // （`Number(raw)` 不行：`Number([])` 是 **0**，而 Python `float([])` 是抛的 ——
    // 一个结构错的覆写会变成一个「有人填了 0」的上限）。整数字段按 Python `int()`
    // 截断（**向零**，不是 `Math.floor`），而 `int('3.7')` 在 Python 里是抛的。
    const n = INT_FIELDS.has(k) ? pyIntStrict(raw) : pyNum(raw)
    if (n === null) continue
    values[k] = n
    sources[k] = TIP_SOURCE_OVERRIDE
  }

  return { values, sources, notes }
}
