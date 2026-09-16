/**
 * 现在可以驱动粗动压电吗 —— 一个压强问题，**fail-closed** 地回答。
 *
 * ## 物理
 *
 * 粗动步进器靠几百伏的锯齿波驱动。**高真空里没问题**（平均自由程极大，没有东西可电离），
 * **大气下也大致没问题**（所以台架能在空气里测）。危险在**中间**：Paschen 极小值附近，
 * 几百伏足以在驱动电极之间击穿，而电弧会沿着压电的绝缘层爬。
 *
 * ```
 * corona 危险区 = 1e-3 … 10 mbar = 0.1 … 1000 Pa
 * ```
 *
 * 这条带一点都不冷僻：**它正是腔体抽气与放气途中经过的那一段**，
 * 而那恰恰是人最可能在搬东西的时刻。
 *
 * ## 规则，而且这条规则与具体哪只规无关
 *
 * > 放行需要**压强低于上限的正面证据**。一个读数只在落在**规的可用量程内**时才算证据。
 * > 出了量程 —— 两端都算 —— 规不是在测量，是在饱和，而**一只饱和的规给的数不是数据**。
 *
 * 所有与型号有关的东西只有两个由操作员填的数：`minPa` 与 `fullScalePa`。
 *
 * 值得说清楚为什么，因为 DL-7 很容易让人以为不是这样：它的上限 `1e-1 Pa = 1e-3 mbar`
 * **正好**是危险带的下沿，于是在这台机器上「一个量程内的有效读数」与「低于危险带」
 * 恰好重合。那是**这组默认值**的一个好性质（DL-7 的机器开箱即安全），**不是前提**。
 * 建立在这个巧合上，会得到一个在换规那天悄悄不再表示任何事的互锁。
 *
 * 真正因规而异的是量程的**下沿**：
 *
 * - DL-7 / 电离规，下限 `5e-8 Pa` —— 远低于放行上限。触底意味着「比这还低」，那显然安全。
 *   因为「太干净」而拒绝一个 UHV 腔体是荒谬的。
 * - Pirani / 电容薄膜规，下限 ~0.5–1 Pa —— **高于**放行上限，而且就在放电带里。
 *   触底意味着「在 1 Pa 以下某处」，那包括 0.5 Pa，那在带里。**那个读数什么都没证明**，
 *   而它吐出来的数（下限值、零、或噪声）看起来**正是一个极好的真空** ——
 *   与占位实现那个 `0.0` 是同一种失败形状，只是从另一头到达。
 *
 * 所以欠量程那一测不是「它触底了吗」，而是「**这只规的下限本身是不是已经低于上限**」。
 *
 * ## 六种会搞错的方式，每一种都真实发生过
 *
 * 1. 占位传感器 `read()` 回 `value=0.0, status="unavailable"`。一个只看 `.value`
 *    再与阈值比较的互锁，会把**没装规**变成**完美真空**然后放行。
 * 2. DL-7 报 `Pa`，占位实现报 `mbar`。**同一个数差 100 倍。** 不看单位就比，
 *    会在自以为低两个数量级的时候落进危险带。
 * 3. 环境告警路径**有意忽略** `status="unavailable"`（掉线的规不该中止一整夜的实验）。
 *    那对**告警**是对的，对**互锁**是反的。两个不同的问题，不能共用一个谓词。
 * 4. DL-7 的帧解析器不校验指数字段，于是一次超量程可能解码成一个看起来合理的小数。
 *    量程检查就是抓这个的 —— 驱动不会抛。
 * 5. 五分钟前的读数对**现在**的压强什么都没说。年龄是判据的一部分，不是细节。
 * 6. 低于下限的规吐出一个小数，读起来像极好的真空（见上）。
 *
 * ## 没有规的时候
 *
 * 操作员的裁决（2026-07-31）：**默认拒绝，但用户可以签字**。
 * 默认模式 `gauge_or_attest` —— 有效读数放行；否则操作员可以签一份限时声明
 * （「已通大气」/「已抽至高真空但真空计不可用」），在它过期之前放行。
 *
 * 签署**随进程而亡**：重启是一次场景变更，重新签只要十秒，
 * 而一份活得比它签署时的条件更久的授权要赔一整摞压电。
 *
 * `gauge_only` 根本不接受签名。`off` 不阻断 —— 但**照样算出并报出判据**，
 * 于是「我们选择不检查」保持可见，而不是悄悄变成「没有什么可检查的」。
 */
import { formatG, pyFloatRepr } from './si.js'
import type { ComputedCheck } from './preconditions.js'

/** corona / Paschen 危险带（Pa）= 1e-3 … 10 mbar。**这一族数字的唯一真源。** */
export const CORONA_ZONE_PA: readonly [number, number] = [0.1, 1.0e3]

/** 放行上限缺省：比危险带下沿再低一个数量级。任何真的 UHV STM 都在它下面很多。 */
export const DEFAULT_MAX_PRESSURE_PA = 1.0e-2

/** 规的**可用量程**缺省（DL-7 的 5e-8 … 1e-1 Pa）。换规就在设置里改这两个。 */
export const DEFAULT_GAUGE_FULL_SCALE_PA = 1.0e-1
export const DEFAULT_GAUGE_MIN_PA = 5.0e-8
const OVERRANGE_FRACTION = 0.8
const UNDERRANGE_FACTOR = 1.25

/** 比这更旧的读数授权不了任何事。 */
export const DEFAULT_MAX_AGE_S = 60.0

/** 操作员签名的缺省寿命。 */
export const DEFAULT_ATTESTATION_TTL_S = 8 * 3600.0

export const VACUUM_MODES = ['gauge_or_attest', 'gauge_only', 'off'] as const
export type VacuumMode = (typeof VACUUM_MODES)[number]

export const ATTESTATION_REASONS: Readonly<Record<string, string>> = {
  vented_to_atmosphere: '已通大气（腔体在常压）',
  high_vacuum_gauge_unavailable: '已抽至高真空，但真空计不可用',
}

/**
 * 真的压强规的类名。**白名单，不是黑名单**：认不出的类会被拒绝并把类名写进报文，
 * 那是一行就能修的事；而黑名单会默默接受未来的每一个占位实现。
 */
export const REAL_GAUGE_CLASSES: readonly string[] = ['DL7VacuumSensor']

/** 已知的替身。单独列出来只是为了让拒绝说得出**为什么**。 */
export const PLACEHOLDER_CLASSES: readonly string[] = ['PlaceholderSensor', 'VacuumSensor']

/** 单位 → 换算到 Pa 的倍数。**表里没有的一律拒绝，不假设。** */
const UNIT_TO_PA: Readonly<Record<string, number>> = {
  pa: 1.0, pascal: 1.0,
  mbar: 100.0, millibar: 100.0, hpa: 100.0,
  bar: 1.0e5,
  torr: 133.322, mmhg: 133.322,
  mtorr: 0.133322, micron: 0.133322,
}

/**
 * 复刻 Python 的 `float(x)`：认不出就 `null`（而不是 JS `Number()` 的 `0`）。
 *
 * 这个差别不是洁癖。`Number(null)`、`Number('')`、`Number('  ')` 全是 `0`，
 * 而 `0 Pa` 读起来正是一个完美真空 —— 与占位传感器那个 `0.0` 同一种失败形状，
 * 只是这回由类型转换伪造出来。
 */
export function pyFloat(value: unknown): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return null // None / 对象 / 数组 ⇒ TypeError
  const s = value.trim()
  if (s === '') return null
  const low = s.toLowerCase().replace(/^[+-]/, '')
  if (low === 'nan') return null
  if (low === 'inf' || low === 'infinity') return s.startsWith('-') ? -Infinity : Infinity
  const n = Number(s)
  return Number.isNaN(n) ? null : n
}

/** 一次规读数，**连同一切可以用来不信任它的东西**。 */
export interface PressureSample {
  readonly value: unknown
  readonly unit: string
  readonly status: string
  /** ISO 时间戳，照 `SensorReading` 原样带过来。空串 = 没有 ⇒ 判不了新旧 ⇒ 拒。 */
  readonly timestamp: string
  readonly sensorName: string
  readonly sensorClass: string
}

/**
 * 读数多旧（秒）。**解析不出来是 `null`，不是 0** ——
 * 伪造一个 0 秒的年龄会让任何 `age <= limit` 的判据无条件通过。
 */
export function sampleAgeS(sample: PressureSample, nowS: number): number | null {
  const ts = String(sample.timestamp ?? '').trim()
  if (ts === '') return null
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return null
  return Math.max(0.0, nowS - t / 1000)
}

/** 操作员签署的、限时的那句话。 */
export interface Attestation {
  readonly reason: string
  readonly signedBy: string
  readonly signedAtS: number
  readonly ttlS: number
  readonly note: string
}

export function attestationAgeS(a: Attestation, nowS: number): number {
  return Math.max(0.0, nowS - a.signedAtS)
}
export function attestationExpired(a: Attestation, nowS: number): boolean {
  return attestationAgeS(a, nowS) > a.ttlS
}
export function attestationRemainingS(a: Attestation, nowS: number): number {
  return Math.max(0.0, a.ttlS - attestationAgeS(a, nowS))
}
export function attestationLabel(a: Attestation): string {
  return ATTESTATION_REASONS[a.reason] ?? (a.reason || '未说明原因')
}

/** 可以驱动粗动压电吗 —— 外加这个答案所依据的一切。 */
export interface Verdict {
  readonly allow: boolean
  /** 中文，一句完整的话。 */
  readonly reason: string
  readonly source: 'gauge' | 'attestation' | 'disabled' | 'none'
  readonly pressurePa: number | null
  readonly ageS: number | null
  readonly mode: VacuumMode
  readonly overRange: boolean
  /** 存在一个量程内的有效读数。 */
  readonly gaugeOk: boolean
  readonly attested: boolean
  readonly attestationRemainingS: number | null
  readonly detail: Readonly<Record<string, unknown>>
}

/** 规的阈值配置。全部由操作员填，缺省是 DL-7 的。 */
export interface VacuumConfig {
  readonly mode: VacuumMode
  readonly maxPa: number
  readonly maxAgeS: number
  readonly fullScalePa: number
  readonly minPa: number
}

export const DEFAULT_VACUUM_CONFIG: VacuumConfig = {
  mode: 'gauge_or_attest',
  maxPa: DEFAULT_MAX_PRESSURE_PA,
  maxAgeS: DEFAULT_MAX_AGE_S,
  fullScalePa: DEFAULT_GAUGE_FULL_SCALE_PA,
  minPa: DEFAULT_GAUGE_MIN_PA,
}

/** `{x!r}` —— 报文里回显原始读数用。 */
function repr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'number') return pyFloatRepr(v)
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/**
 * 换算成 Pa，认不出单位就 `null`。
 *
 * **拒绝未知单位正是这个函数的意义。** `mbar` 与 `Pa` 在旧仓里都在用、差 100 倍；
 * 一个缺省倍数 1.0 会把 `1e-3 mbar`（安全）与 `1 mbar`（带正中，危险）
 * 按哪只传感器碰巧应答而放进同一个桶里。
 */
export function toPascal(value: unknown, unit: string): number | null {
  const val = pyFloat(value)
  if (val === null || !Number.isFinite(val)) return null
  const mult = UNIT_TO_PA[String(unit ?? '').trim().toLowerCase()]
  return mult === undefined ? null : val * mult
}

/**
 * 这只规为什么**永远**授权不了粗动 —— 能授权就回空串。
 *
 * 这是一次**配置检查**，不是读数检查。它回答一个操作员不该靠经验去发现的问题：
 * **我手上这只规，有能力证明这个互锁需要被证明的那件事吗？**
 *
 * 一只粗真空规（Pirani、电容薄膜规，下限 0.5–1 Pa）是一只完全好用的规，
 * 只是看不到那么低。只装了它的话，每一次粗动都会被拒、而且是对的 ——
 * 操作员值得被**明明白白地告知一次**，而不是每次读到一句费解的拒绝、
 * 然后怀疑是不是哪里坏了。
 */
export function gaugeConfigProblem(cfg: Pick<VacuumConfig, 'minPa' | 'fullScalePa' | 'maxPa'>): string {
  const { minPa, fullScalePa, maxPa } = cfg
  if (minPa <= 0 || fullScalePa <= 0) return ''
  if (minPa >= fullScalePa) {
    return (
      `真空计量程配置有误：下限 ${formatG(minPa, 3)} Pa ≥ 上限 ` +
      `${formatG(fullScalePa, 3)} Pa。在设置里把这两个数按规的实际量程填对。`
    )
  }
  if (minPa >= maxPa) {
    return (
      `这只真空计的量程下限是 ${formatG(minPa, 3)} Pa，高于粗动允许上限 ` +
      `${formatG(maxPa, 3)} Pa —— **它永远无法证明压强足够低**，` +
      '因此在只有这只规的情况下粗动会一直被拒绝。这不是故障：' +
      '粗糙真空规（Pirani / 电容薄膜规）本来就看不到那么低。' +
      '需要一只冷阴极规或电离规，或者由用户签署「当前气压安全」。'
    )
  }
  if (fullScalePa * OVERRANGE_FRACTION <= maxPa) {
    return (
      `真空计满量程 ${formatG(fullScalePa, 3)} Pa 太低：还没到粗动允许上限 ` +
      `${formatG(maxPa, 3)} Pa 就已经算超量程，判据永远给不出「通过」。` +
      '核对量程配置，或调低允许上限。'
    )
  }
  return ''
}

/** 状态字 → 人话。 */
const STATUS_HUMAN: Readonly<Record<string, string>> = {
  unavailable: '读不到（串口掉线/未接）',
  error: '帧校验失败',
  warning: '告警',
  alarm: '告警',
}

export interface GaugeOutcome {
  readonly ok: boolean
  readonly reason: string
  readonly detail: Record<string, unknown>
}

/**
 * **光凭规**允许粗动吗。六种拒绝，按「哪一句最有用」的顺序排。
 *
 * 它们没有一条是某个型号专有的 —— 型号相关的部分全在 `minPa` / `fullScalePa` 里，
 * 而那两个数由操作员填。
 */
export function gaugeVerdict(
  sample: PressureSample | null,
  cfg: VacuumConfig,
  nowS: number,
): GaugeOutcome {
  if (sample === null) {
    return {
      ok: false,
      reason:
        '没有可用的真空计读数 —— 无法判断当前是否处在放电区间' +
        `（${formatG(CORONA_ZONE_PA[0], 6)}–${formatG(CORONA_ZONE_PA[1], 6)} Pa）。`,
      detail: {},
    }
  }

  const cls = (sample.sensorClass ?? '').trim()
  const detail: Record<string, unknown> = { sensor: sample.sensorName, sensor_class: cls }

  // 1. 替身不是规。它报 value=0.0，而那对任何只看数字的东西都读作完美真空。
  if (PLACEHOLDER_CLASSES.includes(cls)) {
    return {
      ok: false,
      reason:
        '真空计是**占位实现**（未接真实真空计）。它的读数恒为 0，' +
        '这不是「完美真空」而是「没有数据」—— 拒绝粗动。',
      detail,
    }
  }
  if (cls !== '' && !REAL_GAUGE_CLASSES.includes(cls)) {
    return {
      ok: false,
      reason:
        `传感器类型 ${cls} 不在已知真空计名单里，不能用它的读数授权粗动。` +
        '新增真空计驱动时要做两件事：把类名加进 ' +
        'vacuum_interlock.REAL_GAUGE_CLASSES，' +
        '并在设置里填这只规的**量程上下限**' +
        '（vacuum_gauge_min_pa / vacuum_gauge_full_scale_pa）——' +
        '判据本身与规的型号无关，型号相关的只有这两个数。',
      detail,
    }
  }

  // 2. 状态。告警路径**有意**放过 `unavailable`；这里必须拦，
  //    因为「规看不见」正是我们要拒的那种情况。
  const status = (sample.status ?? '').trim().toLowerCase()
  if (status !== 'ok') {
    const human = STATUS_HUMAN[status] ?? (status || '未知')
    return {
      ok: false,
      reason: `真空计状态为「${human}」，不是有效读数 —— 拒绝粗动。读不到 ≠ 真空好。`,
      detail,
    }
  }

  // 3. 单位。
  const pa = toPascal(sample.value, sample.unit)
  if (pa === null) {
    return {
      ok: false,
      reason:
        `真空计读数无法换算成 Pa（值 ${repr(sample.value)} 单位 ` +
        `${repr(sample.unit)}）—— 拒绝粗动。Pa 与 mbar 差 100 倍，` +
        '猜错方向正好落进放电区。',
      detail,
    }
  }
  detail['pressure_pa'] = pa

  // 4. 年龄。
  const age = sampleAgeS(sample, nowS)
  detail['age_s'] = age
  if (age === null) {
    return { ok: false, reason: '真空计读数没有时间戳，无法判断新旧 —— 拒绝粗动。', detail }
  }
  // 到这里 `age` 与 `pa` 已经**确定**是数（上面两道 `null` 早退）。各钉成一个
  // 有声明类型的常量再用。
  //
  // 不是洁癖：下面每一道闸的报文都要印它们，而**收窄正是那几个 `if` 自己给的**。
  // 一条把某道闸拆成 `if (false && …)` 的变异会让 TS 判那一支不可达、
  // 连带把收窄也撤掉，于是整份文件编不过 —— 而**编不过的变异，那道闸就永远验不到**
  // （本仓第十二次；前十一次的修法一律是「提一个有声明返回类型的东西挡住流类型」）。
  const ageSec: number = age
  const paValue: number = pa

  if (ageSec > cfg.maxAgeS) {
    return {
      ok: false,
      reason:
        `真空计读数已经是 ${ageSec.toFixed(0)} 秒前的了（上限 ${cfg.maxAgeS.toFixed(0)} 秒）` +
        '—— 抽气/放气时压强变化很快，旧读数不能给现在授权。',
      detail,
    }
  }

  // 5a. 超量程。贴近满量程时规分不出「刚过一点」与「大气」——
  //     而 DL-7 的帧解析器不校验指数，一次超量程可以解码成一个像样的小数。
  if (cfg.fullScalePa > 0 && paValue >= cfg.fullScalePa * OVERRANGE_FRACTION) {
    detail['over_range'] = true
    return {
      ok: false,
      reason:
        `真空计读数 ${formatG(paValue, 3)} Pa 已到量程上限附近` +
        `（满量程 ${formatG(cfg.fullScalePa, 3)} Pa）—— 这意味着「超量程、判断不了」，` +
        '不是「刚好卡在阈值下」。拒绝粗动。',
      detail,
    }
  }

  // 5b. **欠**量程 —— 换一只非 DL-7 的规就会暴露的那一半。
  //     低于下限的规不是在报告一个低压强，是在**触底**，而它吐出来的数
  //     （下限值、零、或噪声）看起来正是一个极好的真空。
  //     判据不是「它触底了吗」，而是「**这只规的下限本身是不是已经低于上限**」。
  if (cfg.minPa > 0 && paValue <= cfg.minPa * UNDERRANGE_FACTOR) {
    detail['under_range'] = true
    if (cfg.minPa >= cfg.maxPa) {
      return {
        ok: false,
        reason:
          `真空计读数 ${formatG(paValue, 3)} Pa 已到量程**下限**附近` +
          `（下限 ${formatG(cfg.minPa, 3)} Pa）—— 这是规在触底，不是「真空非常好」。` +
          `而这只规的下限本身就高于粗动允许上限 ${formatG(cfg.maxPa, 3)} Pa，` +
          '所以它**永远无法证明**压强足够低。' +
          '需要一只量程更低的规（冷阴极/电离规），或由用户签署。',
        detail,
      }
    }
    // 下限已经低于上限 ⇒「就算我在下限上，也已经安全了」。
    detail['under_range_safe'] = true
    return {
      ok: true,
      reason:
        `真空计已到量程下限（${formatG(cfg.minPa, 3)} Pa）以下 —— 真实压强比它更低，` +
        `而下限本身已经远低于允许上限 ${formatG(cfg.maxPa, 3)} Pa，` +
        `距放电区下沿 ${formatG(CORONA_ZONE_PA[0], 6)} Pa 还有数个数量级。`,
      detail,
    }
  }

  if (paValue > cfg.maxPa) {
    const band = paValue >= CORONA_ZONE_PA[0] ? '，已经进入放电区间' : ''
    return {
      ok: false,
      reason:
        `当前压强 ${formatG(paValue, 3)} Pa 高于粗动允许上限 ${formatG(cfg.maxPa, 3)} Pa${band}` +
        `（放电区 ${formatG(CORONA_ZONE_PA[0], 6)}–${formatG(CORONA_ZONE_PA[1], 6)} Pa）` +
        '—— 拒绝粗动，等抽到更低再动。',
      detail,
    }
  }

  return {
    ok: true,
    reason:
      `当前压强 ${formatG(paValue, 3)} Pa ≤ 允许上限 ${formatG(cfg.maxPa, 3)} Pa，` +
      `远低于放电区下沿 ${formatG(CORONA_ZONE_PA[0], 6)} Pa（读数 ${ageSec.toFixed(0)} 秒前）。`,
    detail,
  }
}

/** 整个互锁，作为一个**纯函数**。这里一行都不碰硬件。 */
export function assess(
  sample: PressureSample | null,
  opts: {
    readonly config?: Partial<VacuumConfig>
    readonly attestation?: Attestation | null
    readonly nowS: number
  },
): Verdict {
  const cfg: VacuumConfig = { ...DEFAULT_VACUUM_CONFIG, ...(opts.config ?? {}) }
  const mode: VacuumMode = VACUUM_MODES.includes(cfg.mode) ? cfg.mode : 'gauge_or_attest'
  const nowS = opts.nowS
  const attestation = opts.attestation ?? null

  const out = gaugeVerdict(sample, cfg, nowS)
  let reason = out.reason
  const detail = out.detail

  // 一只**证明不了**我们需要证明的事的规，是一个配置事实，不是一次读数。
  // 把它写进 reason，于是一条长期存在的拒绝在**第一次**就解释了自己，而不是第十次。
  const problem = gaugeConfigProblem(cfg)
  if (problem !== '' && !out.ok) {
    reason = `${reason} ${problem}`
    detail['gauge_config_problem'] = problem
  }

  const pa = (detail['pressure_pa'] as number | undefined) ?? null
  const age = (detail['age_s'] as number | null | undefined) ?? null
  const over = detail['over_range'] === true

  const base = {
    pressurePa: pa,
    ageS: age,
    mode,
    overRange: over,
    attested: false,
    attestationRemainingS: null,
    detail,
  } as const

  if (out.ok) {
    return { ...base, allow: true, reason, source: 'gauge', overRange: over, gaugeOk: true }
  }

  const liveAtt =
    attestation !== null && !attestationExpired(attestation, nowS) ? attestation : null

  if (mode === 'gauge_only') {
    const tail = attestation !== null ? '（本机模式为「只认真空计」，用户签署在此模式下无效。）' : ''
    return { ...base, allow: false, reason: reason + tail, source: 'none', gaugeOk: false }
  }

  if (mode === 'off') {
    return {
      ...base,
      allow: true,
      reason:
        '【真空互锁已被关闭】不阻断，但判据如下：' +
        reason +
        ' —— 关闭互锁不代表没有风险，只代表这次没人检查。',
      source: 'disabled',
      gaugeOk: false,
    }
  }

  if (liveAtt !== null) {
    return {
      ...base,
      allow: true,
      reason:
        `真空计不可用：${reason} 但用户已签署「${attestationLabel(liveAtt)}」` +
        `（${liveAtt.signedBy || '未署名'}，还剩 ` +
        `${(attestationRemainingS(liveAtt, nowS) / 3600.0).toFixed(1)} 小时）—— 按签署放行。`,
      source: 'attestation',
      gaugeOk: false,
      attested: true,
      attestationRemainingS: attestationRemainingS(liveAtt, nowS),
    }
  }

  const expiredNote =
    attestation !== null
      ? `（用户此前签署过「${attestationLabel(attestation)}」，` +
        `但已在 ${(attestationAgeS(attestation, nowS) / 3600.0).toFixed(1)} 小时前过期。）`
      : ''
  return {
    ...base,
    allow: false,
    reason:
      reason +
      expiredNote +
      ' 若确认当前气压安全（例如腔体已通大气），' +
      '请用户在界面上签署一次「当前气压安全」再重试。',
    source: 'none',
    gaugeOk: false,
  }
}

/** `Verdict` → 技能 `data` 的那份形状（键名照旧仓的蛇形）。 */
export function verdictDict(v: Verdict): Record<string, unknown> {
  const out: Record<string, unknown> = {
    allow: v.allow,
    reason: v.reason,
    source: v.source,
    pressure_pa: v.pressurePa,
    age_s: v.ageS,
    mode: v.mode,
    over_range: v.overRange,
    gauge_ok: v.gaugeOk,
    attested: v.attested,
    attestation_remaining_s: v.attestationRemainingS,
  }
  if (Object.keys(v.detail).length > 0) out['detail'] = { ...v.detail }
  return out
}

/** 给系统提示块的一行。**永不为空。** */
export function formatBlock(v: Verdict): string {
  const head = v.allow ? '可以粗动' : '**禁止粗动**'
  const tail = v.allow
    ? ''
    : '（这不是建议，是硬闸门：粗动/换区技能会直接拒绝执行。' +
      '在中间真空区给粗动压电加几百伏会打火击穿。）'
  return `【真空互锁】${head} —— ${v.reason}${tail}`
}

// ── 进程级接线 ─────────────────────────────────────────────────────────────

/**
 * 进程内的那一份真空状态 —— 与 `processPresetStore` / `processLockInProfile` 同形。
 *
 * `source` 由宿主接到环境监控上；`attestation` **随进程而亡**，
 * 这是有意的：重启是一次场景变更，重新签只要十秒，
 * 而一份活得比它签署时的条件更久的授权要赔一整摞压电。
 */
export const processVacuum: {
  source: (() => PressureSample | null) | null
  attestation: Attestation | null
  config: Partial<VacuumConfig>
  /**
   * 墙钟（秒）。**注入而不是直接读时钟**：读数年龄与签署剩余时长都由它算，
   * 而一份每跑一次都换个数的金样，`git diff` 就回答不了「有没有变」。
   */
  nowS: () => number
} = { source: null, attestation: null, config: {}, nowS: () => Date.now() / 1000 }

/** 当前读数。源没接、或源抛了，都是「没有读数」。 */
export function currentSample(): PressureSample | null {
  const src = processVacuum.source
  if (src === null) return null
  try {
    return src()
  } catch {
    // 一个坏掉的源就是「没有读数」—— 而没有读数正是这道闸要拒的那件事。
    return null
  }
}

/**
 * 记下操作员签署的那句话。**认不出的理由直接拒**，不存一个自由文本 ——
 * 一份说不清自己在声明什么的授权，事后谁也核不动。
 */
export function attest(
  reason: string,
  opts: { signedBy?: string; ttlS?: number; note?: string; nowS?: number } = {},
): Attestation {
  if (!(reason in ATTESTATION_REASONS)) {
    throw new Error(
      `unknown attestation reason: '${reason}' ` +
        `(expected one of ${Object.keys(ATTESTATION_REASONS).sort().join(', ')})`,
    )
  }
  const att: Attestation = {
    reason,
    signedBy: opts.signedBy ?? '',
    signedAtS: opts.nowS ?? processVacuum.nowS(),
    ttlS: opts.ttlS ?? DEFAULT_ATTESTATION_TTL_S,
    note: opts.note ?? '',
  }
  processVacuum.attestation = att
  return att
}

export function revokeAttestation(): void {
  processVacuum.attestation = null
}

/** 此刻的判据 —— 每一次粗动都会问的那一句。 */
export function checkVacuum(nowS?: number): Verdict {
  return assess(currentSample(), {
    config: processVacuum.config,
    attestation: processVacuum.attestation,
    nowS: nowS ?? processVacuum.nowS(),
  })
}

/**
 * 把这道闸接成一个前置检查（`vacuum_ok_for_coarse`）。
 *
 * **本仓默认不接** —— `deps.computedChecks` 缺省是空表。宿主要接的话：
 *
 * ```ts
 * new SkillKernel({ computedChecks: { vacuum_ok_for_coarse: vacuumCoarseCheck() } })
 * ```
 *
 * 为什么默认不接：接上之后粗动那几个技能的行为会变，而它们的轨迹金样是按「没接」
 * 录的。默认改掉会让一堆已有轨迹变红，**而那不是这一批要证明的事**。
 */
export function vacuumCoarseCheck(nowS?: () => number): ComputedCheck {
  return () => {
    const v = checkVacuum(nowS === undefined ? undefined : nowS())
    return { ok: v.allow, reason: v.reason }
  }
}
