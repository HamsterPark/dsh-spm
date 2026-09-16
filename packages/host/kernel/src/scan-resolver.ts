/**
 * `resolveScan` —— 把「扫哪、多大、什么目的」解析成一整套扫描参数，**外加每个数字的来历**。
 *
 * 这是「LLM 不填数字」那条设计原则的落点。分工：
 *
 * | | 谁定 | 例 |
 * |---|---|---|
 * | **意图** | 模型 / 用户 | 扫哪（center）、多大（size）、什么目的（purpose），以及**用户逐字点过名的**物理量 |
 * | **策略** | 本模块 + `scan-policy.ts` | 速度、像素、PI 增益、setpoint 缺省 —— 从尺度推导出来的执行细节 |
 *
 * 分界判据：**出现在用户自然语言里的量 = 意图**（「在这里扫一张 200 nm 的图」）；
 * **从尺度推导出来的 = 策略**（「200 nm 的图该用多少像素、多慢」）。
 *
 * 为什么不能靠提示词让模型别填数字：旧仓 2026 年的三模式 assembler 就是那么做的
 * （靠改变喂给模型的知识量间接改变行为），最后被丢弃。活下来的是**把发明数字的
 * 诱因移除**：`ScanAt` 的可选参数「不填」是默认路径，策略层接得住。
 *
 * ## 它是纯函数，所以就把它写成纯函数
 *
 * 零 I/O、零硬件、零 LLM，判据全是值。旧仓那三处「顺手读一下」在本仓是**入参**：
 *
 * | 旧仓 | 本仓 |
 * |---|---|
 * | `_read_prefs()` 延迟 import `experiment_prefs`，读不到 → `{}` | `opts.prefs`，不给就是 `{}` |
 * | `_read_v_tip_max()` 读 `instrument_profile`，读不到 → `2e-6` | `opts.vTipMaxMS`，不给就是 {@link DEFAULT_V_TIP_MAX} |
 * | `scan_policy` 模块级活动档位表（`get_policy()` 带进程状态） | `opts.tiers`，不给就是 {@link FACTORY_LOOKUP} |
 *
 * 同 D-VAC-1 / D-LIMITS-1 / D-PRESET-2：**限值与偏好是台架的属性，不是模块的属性**。
 * 三条降级路径的**取值**逐字照移（旧仓读不到时就是这三个值），换掉的只是「谁去读」。
 *
 * ## clamp 是参数卫生，不是安全边界
 *
 * 这里的修剪把偏好表里一个手滑的数字修成可用值**并声明**；SafetyGate 那一层只拒不改。
 * 两层语义不同，都保留，互不豁免 —— 解析出来的东西仍然全量过 SafetyGate。
 *
 * 而「非法」分两种，处置刻意相反：
 *
 * | | 是什么 | 怎么办 |
 * |---|---|---|
 * | `size_m` 非数值 / ≤ 0 | **上游出错的信号**（变量没初始化、解析失败） | **抛**。把 `0` 静默修成 0.1 nm 会扫出一张荒谬的图却什么都不说 |
 * | `size_m` 正数但超量程 | 一个人真的打出来的数字 | 修剪并在 `warnings` 里说一句 |
 */
import { formatG, pyFloatRepr } from './si.js'
import { SOURCE_TIER_FACTORY, SOURCE_TIER_OPERATOR } from './zctrl-preset.js'
import {
  estimateScanSeconds,
  tierByName as factoryTierByName,
  tierForSize as factoryTierForSize,
  tierNames as factoryTierNames,
  type ScanTier,
} from './scan-policy.js'

// ── 参数卫生边界（与既有技能的 ParameterSpec 对齐） ──────────────────────────
//
//   size/center      → ConfigureScan.width_m/height_m 的 1e-10..1e-5
//   line_time_s      → ConfigureScan.line_time_s 的 1e-4..600
//   pixels           → SetScanBuffer 的 16..4096
//   setpoint_a       → SetSetpoint 的 1e-12..1e-7。**刻意不放宽**：产出一个必然被下游
//                      `validateParams` 拒掉的值，等于把错误推迟到硬件路径上才发现
//   bias_v           → SafetyGate 的全局 ±10 V
//   p_gain / t_const → SetZCtrlGain 的上界（2026-08-03 起它才有上界）。这两行原本是
//                      1e6 / 1e3 —— 比技能自己的上界还宽 6 个数量级
export const CLAMP_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  size_m: [1e-10, 1e-5],
  line_time_s: [1e-4, 600.0],
  pixels: [16, 4096],
  setpoint_a: [1e-12, 1e-7],
  bias_v: [-10.0, 10.0],
  angle_deg: [-180.0, 180.0],
  p_gain: [0.0, 1e-6],
  time_constant_s: [0.0, 10.0],
}

/**
 * 针尖横向速度的兜底上限（m/s）。
 *
 * 真值该由仪器档案给；这个默认值（2 µm/s）只是「明显过快」的护栏 —— 在 1 µm 帧上
 * 对应 0.5 s/线，已经是大多数机器的快扫极限。
 */
export const DEFAULT_V_TIP_MAX = 2e-6

/** `purpose` 的保留值：按尺寸自动定档。其余合法值是档名。 */
export const PURPOSE_AUTO = 'auto'

/** 显式点名这两档 = 一句「我要看原子」的物理意图，足以决定工作点。 */
const ATOMIC_TIERS: ReadonlySet<string> = new Set(['atomic', 'atomic_verify'])

/**
 * 「我要看原子」这个意图对应的标准工作点。
 *
 * 来源是旧仓流程表（`MakeAtomicResolutionTip.eval_bias_v` = 0.02 V、
 * `eval_setpoint_a` = 500 pA），住在 `mast/vision/imaging_window.py`。
 * 那个文件的其余部分（`check_atomic_window` 一族）是**判帧**用的，不在这条路上；
 * 搬过来的只有这两个数，所以它跟着唯一的消费方走。
 *
 * **为什么非有不可（2026-08-26 真机）**：档位表刻意不存 bias（「bias 不是尺度的
 * 函数」——那句话是对的），于是工作点一路 keep-current，也就是**沿用上一个技能留下
 * 的值**。修针流程把偏压留在 1.0 V，之后每帧 FFT 都给出周期 0.30–0.36 nm、散布
 * 80%+，读起来像「针尖极其糟糕」⇒ 打脉冲 ⇒ **真把一根好针尖打坏了**。
 * 现场那句话：「每一个技能在一开始会制定自己的工作点，而不是依赖上一个技能。」
 */
export const ATOMIC_WORKING_POINT: Readonly<{ biasV: number; setpointA: number }> = {
  biasV: 0.02,
  setpointA: 500e-12,
}

// ── trace 里 `source` 的全部取值。UI 与测试都按这个闭集断言。 ────────────────
/** 用户逐字点名（经 LLM 转述）。 */
export const SOURCE_EXPLICIT = 'explicit'
// `tier-operator` / `tier-factory` 这两个码 `zctrl-preset.ts` 已经有一份了（参数组
// 解析报的也是「这个增益哪一档给的」）。**不再写第二份** —— 十份 `cell()` 那一课：
// 名字一样、值一样、谁都看不见另一份，是本仓已经付过账的形状。
export { SOURCE_TIER_FACTORY, SOURCE_TIER_OPERATOR } from './zctrl-preset.js'
/** 实验默认参数偏好。 */
export const SOURCE_PREFS = 'prefs'
/** 由偏好推导（如 扫描速度 → 每线时间）。 */
export const SOURCE_PREFS_DERIVED = 'prefs-derived'
/** 模块内建默认（如 channels）。 */
export const SOURCE_DEFAULT = 'default'
/** **不下发**，保持硬件现值。 */
export const SOURCE_KEEP = 'keep-current'
/** 由 `purpose` 表达的物理意图（见 {@link ATOMIC_WORKING_POINT}）。 */
export const SOURCE_INTENT = 'intent'

/**
 * 查档位表的那三个口。
 *
 * 旧仓是 `scan_policy` 模块本身（带进程级的活动表）；本仓把它做成一个**入参**，
 * 于是「出厂表」与「操作员编辑过的表」在这里是同一个形状的两个值。
 */
export interface TierLookup {
  tierForSize(sizeM: number): ResolverTier
  tierByName(name: string): ResolverTier | null
  tierNames(): string[]
}

/**
 * 一档，外加「这一档是谁填的」。
 *
 * `source` / `factoryFilled` 是**操作员表**才有的东西：用户定制了表不代表每个数字都是
 * 他填的（必填字段缺省时按尺度从出厂表回填）。出厂表两项都不带 ⇒ 一律算出厂。
 */
export interface ResolverTier extends ScanTier {
  readonly source?: 'factory' | 'operator'
  readonly factoryFilled?: readonly string[]
}

/** 出厂档位表的那一份查表口。 */
export const FACTORY_LOOKUP: TierLookup = {
  tierForSize: (sizeM) => factoryTierForSize(sizeM),
  tierByName: (name) => factoryTierByName(name),
  tierNames: () => factoryTierNames(),
}

/**
 * LLM / 用户唯一能表达的东西。
 *
 * `explicit` 只装**用户逐字点名过的**值。它与「模型自己觉得合适的值」在结构上无法
 * 区分 —— 这一点老实承认，所以每个 explicit 值都会进 trace 并显示给用户看：一个标着
 * 「用户显式」而用户并没有给过的 `line_time`，是一眼能看出来的。
 */
export interface ScanIntent {
  readonly centerXM: unknown
  readonly centerYM: unknown
  readonly sizeM: unknown
  readonly purpose?: unknown
  readonly explicit?: Readonly<Record<string, unknown>>
}

/** trace 的一格：这个数字是什么、谁定的、哪一档、人类单位怎么读。 */
export interface TraceEntry {
  readonly value: number | string | null
  readonly source: string
  readonly tier: string | null
  readonly human: string | null
  /**
   * **本仓新增**：这一格在旧仓是 `int` 而不是 `float`。
   *
   * JS 只有一种数（D-SI-3），而 {@link summaryLines} 印的是 `f"{val}"` ——
   * Python 那边 `256` 与 `256.0` 印出来不一样，于是这份给人看的来源表会差一个字。
   * 全表只有 `pixels` 一格是 int（`_clamp(..., kind=int)`）。
   */
  readonly isInt?: true
}

/**
 * 解析结果 —— 一套可以直接喂给技能的完整参数，外加来源痕迹。
 *
 * `setSetpoint` / `setBias` / `setZctrlGain` 为 `null` 表示**不下发那个硬件写**
 * （空即 no-op），不是「下发 0」。
 */
export interface ResolvedScan {
  readonly tierName: string
  readonly configureScan: Readonly<Record<string, unknown>>
  readonly setScanBuffer: Readonly<{ pixels: number; lines: number }>
  readonly setSetpoint: Readonly<{ setpoint_a: number }> | null
  readonly setBias: Readonly<{ bias_v: number }> | null
  readonly setZctrlGain: Readonly<{ p_gain: number; time_constant_s: number; i_gain: number }> | null
  readonly trace: Readonly<Record<string, TraceEntry>>
  readonly warnings: readonly string[]
  readonly estimatedScanS: number
}

export interface ResolveScanOptions {
  readonly tiers?: TierLookup
  readonly prefs?: Readonly<Record<string, unknown>>
  readonly vTipMaxMS?: number
}

/**
 * Python 的 `float(x)`，**只认十进制**，`nan` / `inf` 判成「没有值」。
 *
 * D-FLOAT-1 那一族的第四份，站在 `readback.ts` 的 `toFloat` 这一侧：这里解析的是
 * **调用方给的参数**（显式覆盖、偏好表、档位表），不是仪器写出来的数据列。
 *
 * 两处比旧仓严：
 *
 * | 写法 | Python `float()` | 这里 | 为什么 |
 * |---|---|---|---|
 * | `'0x10'` | 抛 ⇒ `None` | `null` | JS 的 `Number('0x10')` 是 **16** —— 一个十六进制写法被当成十进制那个数送到硬件上（同批 3f 的 `lutValues`） |
 * | `'1_000'` | **1000.0**（不抛） | `null` | 一个写成 `1_000` 的每线时间，在旧仓是 1000 s/线 ⇒ clamp 到 600 ⇒ 256 线一帧 **85 小时**。落回档位表是那个不会烧掉机时的答案 |
 *
 * ⚠️ 顺带：`spec/deviations.md` 的 D-FLOAT-1 写着「Python `float("1_000")` 同样是抛的」
 * —— **那句话是错的**（CPython 3.6 起 `float()` 认下划线，本机 3.13 实测 `1000.0`）。
 */
export function pyNum(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Python 的 `int(x)`：数值**向零截断**，字符串只认整数字面量（`int('16.7')` 是抛的）。
 *
 * ⚠️ 与旧仓分岔一处：`int(float('inf'))` 抛的是 `OverflowError`，而 `_num` 的
 * `except` 只收 `TypeError` / `ValueError` —— 于是一个 `inf` 像素数在旧仓是**一次
 * 未捕获的异常**。本仓给 `null`，于是落到「档位表保证非空」那条兜底上。
 */
function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!/^[+-]?\d+$/.test(s)) return null
  return Number(s)
}

/**
 * 按 {@link CLAMP_BOUNDS} 修剪一个值，越界时往 `warnings` 里记一条。
 *
 * **修剪而不是拒绝**：这一层是参数卫生 —— 偏好表里一个手滑的数字不该让整次扫描失败。
 * 真正该拒绝的越界由 SafetyGate 负责（它只拒不改）。
 */
function clamp(
  name: string,
  value: unknown,
  warnings: string[],
  kind: 'float' | 'int' = 'float',
): number | null {
  let val = kind === 'int' ? pyInt(value) : pyNum(value)
  if (val === null) return null
  const bounds = CLAMP_BOUNDS[name]
  if (bounds === undefined) return val
  const [lo, hi] = bounds
  if (val < lo || val > hi) {
    const clamped = Math.max(lo, Math.min(hi, val))
    warnings.push(
      `${name}=${formatG(val, 6)} 超出可用范围 [${formatG(lo, 6)}, ${formatG(hi, 6)}],` +
        `已修剪为 ${formatG(clamped, 6)}`,
    )
    val = clamped
  }
  return kind === 'int' ? Math.trunc(val) : val
}

/** 这一档的某个字段到底是用户填的，还是出厂回填的。 */
function tierSource(tier: ResolverTier, key: string): string {
  if (tier.source !== 'operator') return SOURCE_TIER_FACTORY
  if ((tier.factoryFilled ?? []).includes(key)) return SOURCE_TIER_FACTORY
  return SOURCE_TIER_OPERATOR
}

/** 一句 `name = value (human) ← 来源 @档` 的来源表，给人看「这些数字哪来的」。 */
const SOURCE_LABEL: Readonly<Record<string, string>> = {
  [SOURCE_EXPLICIT]: '用户显式指定',
  [SOURCE_TIER_OPERATOR]: '档位表(用户)',
  [SOURCE_TIER_FACTORY]: '档位表(出厂)',
  [SOURCE_PREFS]: '实验默认偏好',
  [SOURCE_PREFS_DERIVED]: '实验默认偏好(推导)',
  [SOURCE_DEFAULT]: '内建默认',
  [SOURCE_KEEP]: '保持硬件现值',
}

/**
 * 人类可读的来源表。
 *
 * 遵守「人类单位紧跟 SI 值」那条铁律：2026-07-27 的坐标事故就是「只印人类单位」造成的。
 *
 * ⚠️ {@link SOURCE_INTENT} **不在** {@link SOURCE_LABEL} 里 —— 旧仓那张表也没有它
 * （`label.get(src, src)` 兜底成原码）。于是意图来的那个偏压印出来是 `intent` 而不是
 * 一句中文。照移：这一行是给人看的，而「这个数不是任何一档给的」正是它要说的话。
 */
export function summaryLines(res: Pick<ResolvedScan, 'trace'>): string[] {
  const out: string[] = []
  for (const [name, rec] of Object.entries(res.trace)) {
    const src = SOURCE_LABEL[rec.source] ?? rec.source
    const v = pyStr(rec)
    const valS = rec.human === null ? v : `${v}  (${rec.human})`
    const tierS = rec.tier ? ` @${rec.tier}` : ''
    out.push(`- ${name} = ${valS} ← ${src}${tierS}`)
  }
  return out
}

/**
 * 一格的 `f"{val}"`。
 *
 * 两处语言分歧，一处照移一处不照移：
 *
 * | | Python | 这里 | |
 * |---|---|---|---|
 * | 浮点 | `1e-07` / `0.0` / `1.0` | 同左 | `pyFloatRepr`，**照移** —— 读的人要拿它跟面板上的数比 |
 * | 空值 | `None` | `null` | **不照移**（沿用 D-SCAN-5）：为了逐字去写一个 Python 字面量，等于让这一行指向一门这里没有在跑的语言 |
 */
function pyStr(rec: TraceEntry): string {
  const v = rec.value
  if (v === null) return 'null'
  if (typeof v === 'number') return rec.isInt === true ? String(Math.trunc(v)) : pyFloatRepr(v)
  return v
}

/** 等待预算相对估计帧时的余量：`est × 1.3 + 30 s`。 */
const WAIT_HEADROOM_FRAC = 1.3
const WAIT_HEADROOM_S = 30.0

/**
 * 扫描等待预算 = `max(floorS, 估计帧时 × 1.3 + 30 s)`。**单一真源。**
 *
 * `1.3` 来自 2026-08-05 那次真机：一帧跑了估计值的约 132 %（512 线 survey 在 99.8 %
 * 处被判死，而 Nanonis 其实已经写完整帧）。`+30 s` 吸收启动/存盘等固定开销。
 *
 * `ScanAt` 与 `PreScanCheck` 共用它。在此之前这条公式在 `ScanAt` 里写了一份，而
 * `PreScanCheck` 用的是一个从 v1 抄来的 15 s 常数 —— 真机两次「Pre-scan timed out」
 * 就是它（它继承了上一次扫描的 256 行 ⇒ 需要 51.2 s）。**抽出来共用，不是再抄一遍。**
 *
 * `floorS` 是各自的下限，**这一项才是可以不同的**：整帧扫描给 300 s，线级快速检查
 * 给它自己的下限。
 *
 * ⚠️ 它在旧仓住 `scan_policy`。这一轮有并行支线在改文件，先落在这里；收族的时候
 * 搬去 `scan-policy.ts`（同 D-LANG-1 的 `pyFixed`）。
 */
export function waitBudgetS(estimatedScanS: unknown, floorS: number): number {
  const est = pyNum(estimatedScanS) ?? 0.0
  return Math.max(floorS, est * WAIT_HEADROOM_FRAC + WAIT_HEADROOM_S)
}

/**
 * 把一个 {@link ScanIntent} 解析成完整参数集 + 来源痕迹。
 *
 * 优先级链（**逐字段独立**走，不是整组切换）：
 *
 * 1. `explicit` —— 用户单次显式指定（最高优先）
 * 2. 档位表里用户覆写过的值
 * 3. `prefs` 对应字段
 * 4. 档位表出厂默认
 * 5. keep-current —— **不下发**该硬件写
 *
 * `bias` 不走档位表（它不是尺度的函数），链是 explicit > prefs > 意图 > keep-current。
 *
 * @throws 当 `sizeM` 非数值 / ≤ 0，或者中心坐标读不出数时 —— 见模块抬头那张表。
 */
export function resolveScan(intent: ScanIntent, opts: ResolveScanOptions = {}): ResolvedScan {
  const warnings: string[] = []
  const trace: Record<string, TraceEntry> = {}
  const explicit = { ...(intent.explicit ?? {}) }
  const prefs = { ...(opts.prefs ?? {}) }
  const vTipMax = opts.vTipMaxMS ?? DEFAULT_V_TIP_MAX
  const lookup = opts.tiers ?? FACTORY_LOOKUP

  const note = (
    name: string,
    value: number | string | null,
    source: string,
    tierName: string | null = null,
    human: string | null = null,
  ): void => {
    // `pixels` 是**全表唯一**一格 int（`clamp(..., 'int')`）。标记它，`summaryLines`
    // 才印得出 `256` 而不是 `256.0`（见 {@link TraceEntry.isInt}）。
    trace[name] = { value, source, tier: tierName, human, ...(name === 'pixels' ? { isInt: true } : {}) }
  }

  // ── 尺寸（意图，必填） ──────────────────────────────────────────────────
  const rawSize = pyNum(intent.sizeM)
  if (rawSize === null || rawSize <= 0) {
    throw new Error(`size_m 无效: ${repr(intent.sizeM)}(扫描边长必须是正数;不替用户发明尺寸)`)
  }
  const sizeM = clamp('size_m', rawSize, warnings)
  /* c8 ignore next */
  if (sizeM === null) throw new Error(`size_m 无效: ${repr(intent.sizeM)}`)
  note('size_m', sizeM, SOURCE_EXPLICIT, null, `${formatG(sizeM * 1e9, 4)} nm`)

  const centerX = pyNum(intent.centerXM)
  const centerY = pyNum(intent.centerYM)
  if (centerX === null || centerY === null) {
    throw new Error(`扫描中心无效: (${repr(intent.centerXM)}, ${repr(intent.centerYM)})`)
  }
  note('center_x_m', centerX, SOURCE_EXPLICIT, null, `${formatG(centerX * 1e9, 4)} nm`)
  note('center_y_m', centerY, SOURCE_EXPLICIT, null, `${formatG(centerY * 1e9, 4)} nm`)

  // ── 定档 ────────────────────────────────────────────────────────────────
  // `str(intent.purpose or PURPOSE_AUTO)` —— Python 的 `or` 吃的是**假值**
  // （`None` / `''` / `0`），不只是 `None`。
  const purposeRaw = intent.purpose
  const purpose = String(pyTruthy(purposeRaw) ? purposeRaw : PURPOSE_AUTO)
    .trim()
    .toLowerCase()
  let tier: ResolverTier
  if (purpose !== '' && purpose !== PURPOSE_AUTO) {
    const named = lookup.tierByName(purpose)
    if (named === null) {
      warnings.push(
        `purpose='${String(intent.purpose)}' 不是已知档名` +
          `(可用: ${lookup.tierNames().join(', ')}),按尺寸自动定档`,
      )
      tier = lookup.tierForSize(sizeM)
    } else {
      tier = named
      const autoTier = lookup.tierForSize(sizeM)
      if (autoTier.name !== tier.name) {
        warnings.push(
          `purpose='${tier.name}' 强制换档:` +
            `${formatG(sizeM * 1e9, 4)} nm 按尺寸本应属 '${autoTier.name}' 档`,
        )
      }
    }
  } else {
    tier = lookup.tierForSize(sizeM)
  }
  const tierName = tier.name

  // 「档位是被**显式点名**的」与「按尺寸碰巧定到这一档」是两件事。前者是一句物理意图
  // （「我要看原子」），后者只是尺度巧合 —— 只有前者才有资格决定工作点。
  const purposeNamed = purpose !== '' && purpose !== PURPOSE_AUTO && tier.name === purpose
  const intentWp = purposeNamed && ATOMIC_TIERS.has(tierName) ? ATOMIC_WORKING_POINT : null

  // ── pixels ──────────────────────────────────────────────────────────────
  let pixels: number | null
  if (given(explicit['pixels'])) {
    pixels = clamp('pixels', explicit['pixels'], warnings, 'int')
    note('pixels', pixels, SOURCE_EXPLICIT)
  } else {
    const src = tierSource(tier, 'pixels')
    // 偏好只有在「档位表这个字段其实是出厂值」时才插得进来 —— 用户按尺度设过的值
    // 比一个全局标量更精确，不该被后者盖掉。
    if (src === SOURCE_TIER_FACTORY && given(prefs['scan_lines'])) {
      pixels = clamp('pixels', prefs['scan_lines'], warnings, 'int')
      note('pixels', pixels, SOURCE_PREFS)
    } else {
      pixels = clamp('pixels', tier.pixels, warnings, 'int')
      note('pixels', pixels, src, tierName)
    }
  }
  if (pixels === null) {
    pixels = 256
    note('pixels', pixels, SOURCE_DEFAULT)
  }

  // ── line_time_s ─────────────────────────────────────────────────────────
  let lineTime: number | null
  if (given(explicit['line_time_s'])) {
    lineTime = clamp('line_time_s', explicit['line_time_s'], warnings)
    note('line_time_s', lineTime, SOURCE_EXPLICIT, null, perLine(lineTime))
  } else {
    const src = tierSource(tier, 'line_time_s')
    const prefLt = prefs['line_time_s']
    // 旧仓这里是 `pref_speed = prefs.get(...)` 再 `if pref_speed`（真值判断）：
    // 一个**解不出数**的偏好（`'fast'`）在它那儿会进这一支，然后在 f-string 上抛
    // TypeError。本仓要求它解得出数才进来 —— 模块自己的话是「偏好读不到绝不能让
    // 扫描失败」，而一个抛出去的 TypeError 正是让扫描失败。
    const prefSpeed = pyNum(prefs['scan_speed_nm_s'])
    if (src === SOURCE_TIER_FACTORY && given(prefLt)) {
      lineTime = clamp('line_time_s', prefLt, warnings)
      note('line_time_s', lineTime, SOURCE_PREFS, null, perLine(lineTime))
    } else if (src === SOURCE_TIER_FACTORY && prefSpeed !== null && prefSpeed !== 0) {
      // 用户设的是「扫描速度」而不是「每线时间」—— 两者由帧宽换算。表里只存
      // line_time（单一真源），所以这里把速度折算过去。
      lineTime = clamp('line_time_s', sizeM / (prefSpeed * 1e-9), warnings)
      note(
        'line_time_s',
        lineTime,
        SOURCE_PREFS_DERIVED,
        null,
        `由 ${formatG(prefSpeed, 4)} nm/s 与 ${formatG(sizeM * 1e9, 4)} nm 帧宽推导`,
      )
    } else {
      lineTime = clamp('line_time_s', tier.lineTimeS, warnings)
      note('line_time_s', lineTime, src, tierName, perLine(lineTime))
    }
  }
  if (lineTime === null) {
    lineTime = 0.5
    note('line_time_s', lineTime, SOURCE_DEFAULT)
  }

  // ── 组合约束：针尖横向速度 ──────────────────────────────────────────────
  //
  // 这是模型必然漏掉的那一类约束 —— 像素、每线时间、帧宽**单独看都合法**，乘起来
  // 才知道针尖要以多快的速度扫过表面。太快会拖坏针尖，而且反馈跟不上。
  const speed = lineTime > 0 ? sizeM / lineTime : Infinity
  if (speed > vTipMax) {
    const needed = sizeM / vTipMax
    warnings.push(
      `针尖横向速度 ${formatG(speed * 1e9, 4)} nm/s 超过上限 ` +
        `${formatG(vTipMax * 1e9, 4)} nm/s,每线时间由 ${formatG(lineTime, 4)} s ` +
        `放慢到 ${formatG(needed, 4)} s`,
    )
    lineTime = clamp('line_time_s', needed, warnings) ?? needed
    const rec = trace['line_time_s']
    // **来源与档位不动**：改的是这个数，不是「这个数打哪来」。
    if (rec !== undefined) {
      trace['line_time_s'] = {
        ...rec,
        value: lineTime,
        human: `${formatG(lineTime, 4)} s/线(受针尖速度上限限制)`,
      }
    }
  }

  // ── angle_deg ───────────────────────────────────────────────────────────
  //
  // 不传给 `ConfigureScan` 时它会**保持硬件当前角度**（2026-07-03 修的坑：传 0 会让
  // 每次 recenter 都把画面转回 0°）。所以 keep-current 的实现是「不放进
  // `configureScan` 里」，而不是「放一个 0」。
  let angle: number | null = null
  if (given(explicit['angle_deg'])) {
    angle = clamp('angle_deg', explicit['angle_deg'], warnings)
    note('angle_deg', angle, SOURCE_EXPLICIT, null, deg(angle))
  } else if (given(prefs['scan_angle_deg'])) {
    angle = clamp('angle_deg', prefs['scan_angle_deg'], warnings)
    note('angle_deg', angle, SOURCE_PREFS, null, deg(angle))
  } else {
    note('angle_deg', null, SOURCE_KEEP)
  }

  // ── channels ────────────────────────────────────────────────────────────
  const rawChannels = explicit['channels']
  let channels: string
  if (typeof rawChannels === 'string' && rawChannels.trim() !== '') {
    channels = rawChannels.trim()
    note('channels', channels, SOURCE_EXPLICIT)
  } else {
    channels = 'Z,Current'
    note('channels', channels, SOURCE_DEFAULT)
  }

  // ── setpoint_a ──────────────────────────────────────────────────────────
  let setpoint: number | null = null
  if (given(explicit['setpoint_a'])) {
    setpoint = clamp('setpoint_a', explicit['setpoint_a'], warnings)
    note('setpoint_a', setpoint, SOURCE_EXPLICIT, null, pA(setpoint))
  } else if (given(tier.setpointA)) {
    setpoint = clamp('setpoint_a', tier.setpointA, warnings)
    note('setpoint_a', setpoint, tierSource(tier, 'setpoint_a'), tierName, pA(setpoint))
  } else if (given(prefs['setpoint_pa'])) {
    const spPa = pyNum(prefs['setpoint_pa'])
    setpoint = clamp('setpoint_a', (spPa ?? 0.0) * 1e-12, warnings)
    note('setpoint_a', setpoint, SOURCE_PREFS, null, spPa ? `${formatG(spPa, 4)} pA` : null)
  } else if (intentWp !== null) {
    setpoint = clamp('setpoint_a', intentWp.setpointA, warnings)
    note(
      'setpoint_a',
      setpoint,
      SOURCE_INTENT,
      null,
      setpoint ? `${formatG(setpoint * 1e12, 4)} pA（purpose='${tierName}'）` : null,
    )
  } else {
    note('setpoint_a', null, SOURCE_KEEP)
  }

  // ── bias_v ──────────────────────────────────────────────────────────────
  //
  // **bias 不进档位表**：它决定探测的电子态与成像对比，是物理意图参数，不是尺度的
  // 函数。知识库里 L1 那个 "0.5–2 V" 只是巡查建议，不是「1 µm 的图就该用 1 V」。
  // resolver 永远不为 bias 发明数值 —— 而 `purpose='atomic'` **本身就是那句意图**
  // （见 {@link ATOMIC_WORKING_POINT} 的 2026-08-26）。
  let bias: number | null = null
  if (given(explicit['bias_v'])) {
    bias = clamp('bias_v', explicit['bias_v'], warnings)
    note('bias_v', bias, SOURCE_EXPLICIT, null, volt(bias))
  } else if (given(prefs['bias_v'])) {
    bias = clamp('bias_v', prefs['bias_v'], warnings)
    note('bias_v', bias, SOURCE_PREFS, null, volt(bias))
  } else if (intentWp !== null) {
    bias = clamp('bias_v', intentWp.biasV, warnings)
    note(
      'bias_v',
      bias,
      SOURCE_INTENT,
      null,
      `${formatG(bias ?? 0, 4)} V（purpose='${tierName}' 的意图默认）`,
    )
  } else {
    note('bias_v', null, SOURCE_KEEP)
  }

  // ── PI 增益 ─────────────────────────────────────────────────────────────
  //
  // 刻意**不**在显式覆盖集里：增益不是用户在自然语言里会说的量（「用 P=1e-11 扫」
  // 不是人话）。要调就去档位表里调，或者直接用 `SetZCtrlGain`。
  const pGain = clamp('p_gain', tier.pGain, warnings)
  const tConst = clamp('time_constant_s', tier.timeConstantS, warnings)
  if (pGain !== null || tConst !== null) {
    note('p_gain', pGain, tierSource(tier, 'p_gain'), tierName)
    note('time_constant_s', tConst, tierSource(tier, 'time_constant_s'), tierName)
  } else {
    note('p_gain', null, SOURCE_KEEP)
    note('time_constant_s', null, SOURCE_KEEP)
  }

  // ── 装配 ────────────────────────────────────────────────────────────────
  const configure: Record<string, unknown> = {
    center_x_m: centerX,
    center_y_m: centerY,
    width_m: sizeM,
    height_m: sizeM,
    channels,
    set_scan_speed: true,
    line_time_s: lineTime,
  }
  if (angle !== null) configure['angle_deg'] = angle

  // `SetZCtrlGain` 三个参数全必填，且 `I = P/T`（积分增益由 P 与时间常数导出，不是
  // 独立自由度）。所以只填了一半的 PI 配置是**不可执行**的 —— 与其送一个必然被
  // `validateParams` 拒掉的调用，不如在这里说清楚缺什么。
  let setZctrl: ResolvedScan['setZctrlGain'] = null
  if (pGain !== null && tConst !== null) {
    if (tConst > 0) {
      setZctrl = { p_gain: pGain, time_constant_s: tConst, i_gain: pGain / tConst }
    } else {
      warnings.push(
        `档位 '${tierName}' 的时间常数为 0,无法导出积分增益(I = P/T),本次不下发 PI 设置`,
      )
    }
  } else if (pGain !== null || tConst !== null) {
    const missing = pGain !== null ? 'time_constant_s' : 'p_gain'
    warnings.push(
      `档位 '${tierName}' 的 PI 配置不完整(缺 ${missing}),` +
        `Z 反馈需要 P 与时间常数成对设置,本次不下发 PI 设置`,
    )
  }

  return {
    tierName,
    configureScan: configure,
    setScanBuffer: { pixels: Math.trunc(pixels), lines: Math.trunc(pixels) },
    setSetpoint: setpoint !== null ? { setpoint_a: setpoint } : null,
    setBias: bias !== null ? { bias_v: bias } : null,
    setZctrlGain: setZctrl,
    trace,
    warnings,
    estimatedScanS: estimateScanSeconds(pixels, lineTime),
  }
}

/**
 * 「这个键给了没有」—— `!= null`，**不是** `key in params`。
 *
 * 与 D-LOCKIN-1 那条同一个理由：schema 会把每个可选字段都实例化出来，没设的以
 * `null` 到达，用 `in` 判的话每一个都「给了」。
 */
function given(v: unknown): boolean {
  return v !== undefined && v !== null
}

/** Python 的真值：`None` / `''` / `0` / `False` / 空表都是假。 */
function pyTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false
  // `bool(float('nan'))` 在 Python 里是 **True** —— 只有 `0` 是假。
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

/** `f"{x * 1e12:.4g} pA" if x else None` —— `0` 与 `null` 都不印。 */
function pA(setpoint: number | null): string | null {
  return setpoint ? `${formatG(setpoint * 1e12, 4)} pA` : null
}

// ── 「解不出数就没有人类读数」 ───────────────────────────────────────────────
//
// 旧仓这三处是 `f"{value:.4g} …"` 直接插值，而 `_clamp` 是会给 `None` 的 ——
// 于是一个解不出的 `line_time_s` / `angle_deg` / `bias_v` 让整个 `resolve_scan`
// 抛 `TypeError`，而它下面那句 `if line_time is None: line_time = 0.5`（带
// `pragma: no cover`）因此是**死代码**：没有任何一条路走得到它。
//
// 本仓给一个值（D-SKILL-3 那一族），而那个值是 `null` —— **不是 `0`**。
// `f"{None:.4g}"` 的替代品不该是 `0°` / `0 V`：那是在给一个没有的数编一个读数，
// 正好是这一层最该防的事。

/** `{x:.4g} s/线`，`null` 就没有。 */
function perLine(v: number | null): string | null {
  return v === null ? null : `${formatG(v, 4)} s/线`
}

/** `{x:.4g}°`，`null` 就没有。 */
function deg(v: number | null): string | null {
  return v === null ? null : `${formatG(v, 4)}°`
}

/** `{x:.4g} V`，`null` 就没有。 */
function volt(v: number | null): string | null {
  return v === null ? null : `${formatG(v, 4)} V`
}

/**
 * `{x!r}` —— 只用在那两句拒绝里。
 *
 * 数走 `pyFloatRepr`：`String(0)` 是 `'0'` 而 Python 的 `repr(0.0)` 是 `'0.0'`，
 * `String(-1e-7)` 是 `'-1e-7'` 而 Python 是 `'-1e-07'`。**这两句话是给人看的诊断**，
 * 而读它的人要拿去和调用记录里的数对（D-SI-3 那条差异照旧：JS 分不出 int 与 float）。
 */
function repr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return pyFloatRepr(v)
  return String(v)
}
