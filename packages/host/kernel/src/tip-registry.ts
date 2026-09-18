/**
 * 针尖登记表 —— **当前装在仪器里的是哪一根针，以及它意味着什么**。
 *
 * 针尖是仪器级的耗材：换实验、换样品都未必换针尖，但换了针尖，一批「学出来的」量
 * 立刻失效（dI/dV 接触标定、qPlus 自由振幅基线），而且**修针方案本身就依赖针尖是
 * 什么** —— 钨腐蚀针、铂铱剪切针、qPlus 传感器，能承受的处理完全不同。
 *
 * 在这一层之前，系统里**没有针尖实体这个概念**：视觉那边的 `tip_quality` / `tip_change`
 * 是「当前这根针的瞬时状态」，{@link TipCrashTracker} 是位置状态，「针尖是钨还是铂铱、
 * 腐蚀还是剪切」这一维**完全不存在** —— 于是修针技能的参数只能硬编码成一个常数
 * （旧仓 `tip_shaper` 的 bias 3.0 V 对钨针和铂铱针是同一个数）。
 *
 * ---
 *
 * ## 三个问题，写在动手之前（同 {@link processTipCrash} 那一份）
 *
 * ### ① 它住在哪里
 *
 * **进程级**（{@link processTipRegistry}），与 `processTipCrash` / `processVacuum` /
 * `processPresetStore` 同一族。理由同样是**一根针、一块样品**：「现在装的是一支 qPlus」
 * 这件事必须跨调用、跨链活着，否则每一次调用都从「不知道装的是什么」开始 ——
 * 而那正好等于这张表不存在。
 *
 * ⚠️ **进程级不等于持久**。旧仓的真源是 SQLite 的 `tips` 表，这个 holder 只是它的
 * live-read 副本（每次模型调用都要读当前针尖，不该为此打一次库）。本仓**没有那张表**：
 * 宿主重启之后针尖回到「未登记」。这不是新增的洞 —— 旧仓的 holder 也是进程级的 ——
 * 但本仓少了背后那张表，所以 {@link currentTipFacts} 读不到时**返回 `null` 而不是猜**，
 * 下游按「未登记」走通用保守档（见 `tip-conditioning-policy.ts`）。
 *
 * ### ② 由谁注入
 *
 * 宿主（换针事务 / 设置界面 / `register_tip` 那条路）调 {@link setCurrentTip}。
 * **针尖是台架的属性，不是类的属性**（D-VAC-1 / D-LIMITS-1 / D-QPLUS-1 / D-CRASH-1
 * 同一条）：这里一个字段都不猜，全部来自外面。
 * 用户在设置里填的方案覆写走 {@link processTipRegistry}`.overrides`（旧仓读
 * `SettingsStore["tip_conditioning_overrides"]`）。
 *
 * ### ③ 宿主不接时是什么行为
 *
 * | 没接什么 | 行为 |
 * |---|---|
 * | 针尖（`current`） | **未登记** ⇒ 方案表落到通用保守档，而那一档**有自己的包络**，闸照常关 |
 * | 覆写（`overrides`） | 空表 ⇒ 出厂包络生效，闸照常关 |
 *
 * **绝不 fail-open。** 旧仓 `tip_conditioning_resolver` 的模块 docstring 曾经写着
 * 「未登记针尖时不拒绝任何东西（fail-open）」——**那句是假的**，2026-08-10 更正过：
 * 未登记时用的是通用档，`_check_envelope` 照样对着它判、照样拒绝。fail-open 的是
 * **另一件事**（`_tip_policy.qplus_gate` 那道**策略**门，而且它出厂就是关的）。
 * 两道门、两条哲学，而那段注释把其中一道的性质安到了另一道头上。
 *
 * ---
 *
 * ## 术语纪律（照移）
 *
 * 「换针 / tip change」这个词**已经被视觉占用**（mid-scan 针尖态突变检测）。
 * 物理更换针尖一律用 register / install / 装入 / 登记，面向模型的文本同此。
 *
 * ## 没有移植的那一半（旧仓 `core/tip_state.py` 441 行里的渲染层）
 *
 * `format_tip_block`（注入块渲染，约 140 行）+ `_service_days` / `_fmt_hz` /
 * `_bias_polarity_line` / `_preamp_line` / `_MATERIAL_NOTES` / `_FAB_NOTES` /
 * `_QPLUS_POKE_NOTE` / `auto_name` / `*_candidates` / `*_LABELS` **都没有移植**。
 * 它们的消费方是两样本仓还没有的东西：**提示块的针尖段**（要 `instrument_profile`
 * 的偏压极性与前置放大器两个字段，批 5c）与 **`register_tip` 工具**（要那张 SQLite 表）。
 * 消融精神：没有消费方的形状不移。行数与缺件写在 `docs/handoff/batch-5a.md`。
 */

/** 针尖材料。`other` + `material_detail` 兜住合金 / 涂层等长尾。 */
export const TIP_MATERIALS = [
  'W', 'PtIr', 'Pt', 'Ir', 'Fe', 'Ni', 'Co', 'Cr', 'Au', 'Ag', 'Nb', 'other',
] as const

/** 制备方式（现场点名的四种 + unknown）。 */
export const TIP_FABRICATIONS = ['etched', 'cut', 'ground', 'fib', 'unknown'] as const

/** 针尖形态。qPlus 与普通金属丝针尖在「能承受什么」上差别最大。 */
export const TIP_FORMS = ['stm_wire', 'qplus'] as const

/**
 * 归一映射：用户 / 模型可能写的各种写法 → 词表值。键一律小写、无空格、无连字符。
 *
 * **认不出返回 `null`，绝不猜。** 一个认不出的材料落到「这一维不区分」那一档，
 * 而那一档是**更粗**的档 —— 猜错材料比不知道材料更糟。
 */
const MATERIAL_ALIASES: Readonly<Record<string, string>> = {
  w: 'W', tungsten: 'W', 钨: 'W', 钨丝: 'W',
  ptir: 'PtIr', 'pt/ir': 'PtIr', 'ptir alloy': 'PtIr',
  platinumiridium: 'PtIr', 'platinum-iridium': 'PtIr',
  pt80ir20: 'PtIr', pt90ir10: 'PtIr', 'ptir90/10': 'PtIr',
  铂铱: 'PtIr', 铂铱合金: 'PtIr', '铂/铱': 'PtIr',
  pt: 'Pt', platinum: 'Pt', 铂: 'Pt', 白金: 'Pt',
  ir: 'Ir', iridium: 'Ir', 铱: 'Ir',
  fe: 'Fe', iron: 'Fe', 铁: 'Fe',
  ni: 'Ni', nickel: 'Ni', 镍: 'Ni',
  co: 'Co', cobalt: 'Co', 钴: 'Co',
  cr: 'Cr', chromium: 'Cr', 铬: 'Cr',
  au: 'Au', gold: 'Au', 金: 'Au',
  ag: 'Ag', silver: 'Ag', 银: 'Ag',
  nb: 'Nb', niobium: 'Nb', 铌: 'Nb',
}

const FABRICATION_ALIASES: Readonly<Record<string, string>> = {
  etched: 'etched', etch: 'etched', electrochemical: 'etched',
  electrochemicaletching: 'etched', electrochemicallyetched: 'etched',
  电化学腐蚀: 'etched', 电化学: 'etched', 腐蚀: 'etched', 电解腐蚀: 'etched',
  cut: 'cut', clipped: 'cut', snipped: 'cut', mechanicalcut: 'cut',
  钳子剪: 'cut', 钳剪: 'cut', 剪切: 'cut', 剪的: 'cut', 剪: 'cut',
  ground: 'ground', grinding: 'ground', polished: 'ground',
  mechanicalgrinding: 'ground',
  打磨: 'ground', 机械打磨: 'ground', 研磨: 'ground', 抛光: 'ground',
  fib: 'fib', focusedionbeam: 'fib', fibmilled: 'fib', fibcut: 'fib',
  聚焦离子束: 'fib', 离子束切割: 'fib',
}

const FORM_ALIASES: Readonly<Record<string, string>> = {
  qplus: 'qplus', 'q-plus': 'qplus', qplussensor: 'qplus',
  tuningfork: 'qplus', 音叉: 'qplus', 石英音叉: 'qplus', qplus针尖: 'qplus',
  stmwire: 'stm_wire', stm: 'stm_wire', wire: 'stm_wire',
  metalwire: 'stm_wire', normal: 'stm_wire', plain: 'stm_wire',
  普通: 'stm_wire', 普通stm针尖: 'stm_wire', 金属丝: 'stm_wire',
  常规: 'stm_wire',
}

/** 归一比较用的键：小写、去空白 / 连字符 / 下划线。 */
function key(text: unknown): string {
  return String(text ?? '')
    .split(/\s+/)
    .join('')
    .replaceAll('-', '')
    .replaceAll('_', '')
    .toLowerCase()
}

function lookup(
  text: unknown,
  aliases: Readonly<Record<string, string>>,
  vocab: readonly string[],
): string | null {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  // 已经是词表值（大小写不敏感）。Python 用 `casefold()`，JS 的等价物是
  // `toLowerCase()` —— 这张词表全是 ASCII，两者在这里没有分歧。
  for (const v of vocab) if (raw.toLowerCase() === v.toLowerCase()) return v
  return aliases[key(raw)] ?? null
}

/** 「钨」「tungsten」「Pt80Ir20」→ 词表值；认不出返回 `null`。 */
export function normalizeMaterial(text: unknown): string | null {
  return lookup(text, MATERIAL_ALIASES, TIP_MATERIALS)
}

/** 「电化学腐蚀」「clipped」「FIB」→ 词表值；认不出返回 `null`。 */
export function normalizeFabrication(text: unknown): string | null {
  return lookup(text, FABRICATION_ALIASES, TIP_FABRICATIONS)
}

/** 「qPlus」「音叉」「普通」→ 词表值；认不出返回 `null`。 */
export function normalizeForm(text: unknown): string | null {
  return lookup(text, FORM_ALIASES, TIP_FORMS)
}

/** 宿主交进来的一行针尖登记。字段名照旧仓 `tips` 表。 */
export interface TipRow {
  readonly id?: unknown
  readonly name?: unknown
  readonly material?: unknown
  readonly material_detail?: unknown
  readonly fabrication?: unknown
  readonly form?: unknown
  readonly wire_diameter_mm?: unknown
  readonly installed_at?: unknown
  readonly qplus_sensor_model?: unknown
  readonly qplus_f0_hz?: unknown
  readonly qplus_q?: unknown
  readonly qplus_k_n_per_m?: unknown
}

/** 给技能层的精简事实。`current_tip_facts()` 的返回，键逐字照移。 */
export interface TipFacts {
  readonly tip_id: unknown
  readonly name: string
  readonly material: string
  readonly fabrication: string
  readonly form: string
  readonly wire_diameter_mm: unknown
  readonly installed_at: unknown
  readonly qplus_sensor_model: string
  readonly qplus_f0_hz: unknown
  readonly qplus_q: unknown
  readonly qplus_k_n_per_m: unknown
}

/**
 * 进程级 holder + 方案覆写的注入点。见抬头 ①②③。
 *
 * `current` 存的是**归一之后**的行（见 {@link setCurrentTip}）。
 */
export const processTipRegistry: {
  current: TipRow | null
  overrides: Readonly<Record<string, unknown>>
} = { current: null, overrides: {} }

/**
 * 刷新 holder。`null` = 仪器里没有已登记的针尖。
 *
 * **与旧仓有意不同：这里做词表归一**（D 登记见 `spec/deviations.md`）。
 * 旧仓归一发生在 `register_tip` 那个**工具层**，存进库的已经是词表值，
 * 于是 holder 只管转存。本仓没有那个工具层（也没有那张表），归一没有第二个落点：
 * 不归一的话，一行 `material: "钨"` 会在方案表里**静默落到通用档** ——
 * 而「静默落到一个更宽的档」正是这道闸最不该有的失败模式。
 *
 * 认不出的写法**留空**（不是留原文）：空串在查表链里表示「这一维不区分」，
 * 而原文会去撞一个永远命中不了的键 —— 两者行为相同，但空串**说得出**它不知道。
 */
export function setCurrentTip(row: TipRow | null): void {
  if (row === null || typeof row !== 'object') {
    processTipRegistry.current = null
    return
  }
  const material = normalizeMaterial(row.material)
  const fabrication = normalizeFabrication(row.fabrication)
  const form = normalizeForm(row.form)
  processTipRegistry.current = {
    ...row,
    material: material ?? '',
    fabrication: fabrication ?? 'unknown',
    form: form ?? 'stm_wire',
  }
}

/** 当前针尖的完整行副本；未登记返回 `null`。 */
export function getCurrentTip(): TipRow | null {
  const cur = processTipRegistry.current
  return cur === null ? null : { ...cur }
}

/**
 * 给技能层的精简事实（材料 / 制备 / 形态 / qPlus 参数）；未登记返回 `null`。
 *
 * **读不到就返回 `null`，绝不猜**（与 qPlus 振幅读基线同款）：未登记针尖时修针技能
 * 退回通用保守参数，而不是**假装它是钨腐蚀针**。
 */
export function currentTipFacts(): TipFacts | null {
  const tip = getCurrentTip()
  if (tip === null) return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
  return {
    tip_id: tip.id ?? null,
    name: str(tip.name),
    material: str(tip.material),
    fabrication: str(tip.fabrication) || 'unknown',
    form: str(tip.form) || 'stm_wire',
    wire_diameter_mm: tip.wire_diameter_mm ?? null,
    installed_at: tip.installed_at ?? null,
    qplus_sensor_model: str(tip.qplus_sensor_model),
    qplus_f0_hz: tip.qplus_f0_hz ?? null,
    qplus_q: tip.qplus_q ?? null,
    qplus_k_n_per_m: tip.qplus_k_n_per_m ?? null,
  }
}

/**
 * 当前针尖是不是 qPlus 传感器。未登记 → `false`。
 *
 * ⚠️ 旧仓这一行的注释写着「fail-open，不拦操作」，而**这个函数本身不是一道闸** ——
 * 它只回答「是不是」。真正按它做决定的是 `_tip_policy.qplus_gate`（出厂关着）
 * 与方案表的 qPlus 档包络（永远开着）。把「未登记 ⇒ false」读成 fail-open
 * 会以为包络也跟着放行了 —— **没有**：未登记走通用档，那一档照样有上限。
 */
export function isQPlus(): boolean {
  const facts = currentTipFacts()
  return facts !== null && facts.form === 'qplus'
}
