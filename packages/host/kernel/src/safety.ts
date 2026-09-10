/**
 * 安全闸门的**判定** —— 逐字移植 `mast/core/safety.py`。表在 `safety-tables.ts`。
 *
 * 这一层零 I/O：喂进来的是「技能声明 + 模型给的原始参数」，吐出来的是拒绝理由。
 * **报错原文是契约**：模型读到的就是这些句子，抄错一个词，它下一步就会做错事。
 */
import { parseQuantity } from './si.js'
import {
  ABORT_SAFE_WRITES,
  CAP_BIAS_PULSE,
  CAP_TIP_SHAPING,
  GLOBAL_CHECKS,
  PHYSICAL_ABSURD,
  SEMI_DEPTH_NAME_PATTERNS,
  SEMI_TIP_LIFT_MAX_M,
  type SafetyLimits,
} from './safety-tables.js'

/** 够闸门用的最小参数声明。 */
export interface ParamSpecLike {
  readonly name: string
  readonly unit?: string | null | undefined
}

/** 够闸门用的最小技能声明。 */
export interface SkillMetaLike {
  readonly name: string
  readonly parameters: readonly ParamSpecLike[]
  readonly capabilities?: readonly string[] | undefined
}

export type OperatingMode = 'SAFE' | 'SEMI' | 'AUTO'

/**
 * 把模型给的值解成一个数。**有量纲参数是以字符串到达的**（2026-08-04 起：
 * 这家 provider 上数字型工具参数 12/12 全被损坏），所以 `'3p'` 与 `'3e-12'` 都要认。
 * 裸 `Number()` 会在前缀形上失败并**跳过这条检查**——把「改成字符串」变成表上的一个洞。
 */
function coerce(value: unknown, what: string): number | null {
  if (typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  try {
    return parseQuantity(value, { strict: false, what })
  } catch {
    return null // 真的不是数
  }
}

/**
 * 物理荒谬：**跑在原始参数上，在可调包络检查之前**。
 *
 * 命中意味着值差了好几个数量级——单位/指数错了，而不是「超出配置的范围」。
 * 所以文案让模型**改量级、不要重发同一个数**，而不是暗示「把上限调高」。
 */
export function physicallyAbsurdViolations(
  meta: SkillMetaLike,
  params: Readonly<Record<string, unknown>>,
): string[] {
  const specs = new Map(meta.parameters.map((p) => [p.name, p]))
  const out: string[] = []
  for (const [name, raw] of Object.entries(params ?? {})) {
    const spec = specs.get(name)
    if (spec === undefined) continue
    const value = coerce(raw, name)
    if (value === null) continue
    const nameL = name.toLowerCase()
    const unitL = (spec.unit ?? '').toLowerCase()
    for (const [pat, unitPat, ceiling, hint] of PHYSICAL_ABSURD) {
      if (nameL.includes(pat) && unitPat === unitL && Math.abs(value) >= ceiling) {
        out.push(
          `物理荒谬值: '${name}' = ${pyNum(value)} ${spec.unit ?? ''} 在物理上不可能` +
            `(${hint})。这不是越界,是量级丢了——请把值写成**带 SI 前缀的` +
            `字符串**(100 pA→'100p'、1 nA→'1n'、3 pm→'3p';50 mV 这类接近 1 的` +
            `量写 '0.05' 即可)。切勿重试相同数值,也不要改用 '1e-10' 这种` +
            `指数写法——量级极小的参数会直接拒绝它。`,
        )
        break
      }
    }
  }
  return out
}

/** Python 的 `str(float)` 形状：整数值也带 `.0`，很小的数走指数。 */
function pyNum(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e16) {
    return Object.is(v, -0) ? '-0.0' : `${v}.0`
  }
  const s = String(v)
  // JS 的 1.5e-8 与 Python 的 5e-08：指数补零到两位
  return s.replace(/e([+-])(\d)$/, 'e$10$2')
}

// ── 五条硬闸 ────────────────────────────────────────────────────────────────

/** `"true"` / `1` / `true` 之类都算真；**认不出来也算真**（fail-closed）。 */
function truthyAbsolute(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['', '0', 'false', 'no', 'off', 'none', 'null'].includes(s)) return false
    return true
  }
  return true
}

/** enable/enabled 这类**默认为开**的旗标：只有明确的 off 才算「关掉保护」。 */
function falsey(v: unknown): boolean {
  if (v === undefined || v === null) return false // 缺省 = 开 = 不是一次关闭
  return !truthyAbsolute(v)
}

/**
 * **MAST 里唯一一类物理上危险的动作**（2026-06-11 安全重界定）：
 * 朝样品去的粗 Z 步进（pan 型压电步进器）**没有电流反馈停止**，步数/步长过大
 * 就把针撞进样品，针和样品一起报废。其它一切要么被 Nanonis 边界管着
 * （偏压/电流/精调 Z），要么被带电流反馈的 AutoApproach 模块管着。
 *
 * 认两种形状：
 * - `MotorMove` 开环步进——键在**语义方向** `direction='z-approach'`，与原始 Z 码无关
 * - `MotorMoveClosedLoop` 带 Z 分量的移动——闭环用**位置反馈**（伺服到目标 XYZ），
 *   **不会在接触时停下**，而朝向样品与否从静态目标里证不出来（取决于这台机器的
 *   Z 约定；相对移动还取决于当前位置）。所以**保守**：任何碰到 Z 的闭环移动都算。
 *   纯 XY 的闭环移动不算。
 */
export function isCoarseSampleApproach(
  skillName: string,
  params: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  const p = params ?? {}
  if (skillName === 'MotorMove') {
    const d = String(p['direction'] ?? '')
      .trim()
      .toLowerCase()
    return d === 'z-approach' || d === 'z_approach' || d === 'zapproach'
  }
  if (skillName === 'MotorMoveClosedLoop') {
    const targetZ = p['target_z_m']
    if (targetZ === undefined || targetZ === null) return false // 纯 XY，无 Z 分量
    // 绝对定位且带 Z 目标：**哪怕是 0.0 也闸**——绝对 Z 目标的「安全一侧」静态证不出来。
    //
    // 这道闸跑在**模型原始 JSON** 上（在任何强转之前）。弱模型常发
    // `absolute="true"` / `absolute=1`，而执行侧是 truthy 判断。一个裸的 `=== true`
    // 会把它们看成 false 掉进相对分支——那里 0.0 又读成「没动 Z」，
    // **整道人审闸门被完整跳过**。所以 truthy 要认全，认不出来也 fail-closed。
    if (truthyAbsolute(p['absolute'])) return true
    // 相对移动：任何非零 Z 步进都是粗 Z 运动 ⇒ 闸。解不出来的 Z 目标 fail-closed。
    const z = coerce(targetZ, 'target_z')
    return z === null ? true : z !== 0
  }
  return false
}

/** 改写全局偏压/电流**标定**刻度——它把此后所有读数与写入的含义都改了。 */
export function isCalibrationChange(skillName: string): boolean {
  return skillName === 'SetBiasCalibration' || skillName === 'SetCurrentCalibration'
}

/** 改粗动驱动参数（频率/幅值）——步长的物理含义随之改变。 */
export function isCoarseDriveChange(skillName: string): boolean {
  return skillName === 'SetMotorFreqAmp'
}

/** 无保护的**横向**粗动：没有反馈能告诉你撞上了侧壁。 */
export function isUnguardedLateralCoarseMove(
  skillName: string,
  params: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  if (skillName !== 'MotorMove') return false
  const d = String((params ?? {})['direction'] ?? '')
    .trim()
    .toLowerCase()
  return d.startsWith('x') || d.startsWith('y')
}

/**
 * 关掉一层**硬件保护**（SafeTip 或 Z 软限位）。
 * 打开永远安全（AUTO）；**关掉**不许在没有人在环里的情况下自动发生。
 * 这是值相关的——技能自身的 safety_level 表达不了「开是安全的、关要闸」。
 */
export function isProtectionDisable(
  skillName: string,
  params: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  const p = params ?? {}
  if (skillName === 'EnableSafeTip') return falsey(p['enable'])
  if (skillName === 'SetZLimitsEnabled') return falsey(p['enabled'])
  return false
}

// ── 能力标签 ────────────────────────────────────────────────────────────────

/** 这次调用会不会**机械地**修针（Z 下压 / tip shaper）。纯粹的能力标签查表。 */
export function isTipShaping(capabilities: readonly string[] | null | undefined): boolean {
  return capabilities?.includes(CAP_TIP_SHAPING) ?? false
}

/**
 * 这次调用会不会往针上**加电**。两种形状，对应两种物理机制。
 *
 * 1. 打了 `bias_pulse` 标签的技能——它们存在的目的就是脉冲。
 * 2. 打了 `tip_shaping` 标签、而且**会把电压加到结上**的技能。
 *
 * 第二条是 2026-08-11 买来的：**TipShaper 有两个偏压字段，只有一个是有条件的**
 * （厂商用同一句话写的，一个带条件一个不带）：
 *
 * > `Bias (V)` …**如果 Change Bias 为真**才施加到 Bias 信号上。
 * > `Bias Lift (V)` … 是**第一次 Z 斜坡之后**施加的偏压。
 *
 * 所以 `change_bias=False` **不等于「没有电压」**：`bias_lift_v` 照样落下去。
 * 这个函数原来一看到 `change_bias=False` 就短路成 false、从不看 `bias_lift_v`——
 * 而 `bias_lift_v` 自己的默认值是 **3.0 V**。结果：闸门放行了一批「纯机械」的扎针，
 * 它们其实**无条件、静默地**往针上加了 3 V。（qPlus 传感器上操作员的规矩是 20 mV，
 * 3 V 是它的 150 倍，会把音叉敲响。）
 *
 * **解不出来或者干脆没写的偏压一律 fail-closed**（当成带电）。「没说」不能读成「零」：
 * 技能后面会把省略的偏压解析成什么，从参数里看不见。
 */
export function isElectricalPulse(
  capabilities: readonly string[] | null | undefined,
  params: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  const caps = capabilities ?? []
  if (caps.includes(CAP_BIAS_PULSE)) return true
  if (!caps.includes(CAP_TIP_SHAPING)) return false
  const p = params ?? {}
  // (a) **有条件**的那一半：Bias(V)，只有 change_bias 为真时施加。
  //     change_bias 在 TipShape 系里默认是 **False**，所以缺省 = 不阶跃。
  if (truthyAbsolute(p['change_bias'])) {
    if (biasIsLive(p['bias_v'], 'bias_v')) return true
  }
  // (b) **无条件**的那一半：Bias Lift(V)。这里**故意没有** change_bias 判断——
  //     那正是当初那道以为是守卫、其实不是守卫的东西。
  return biasIsLive(p['bias_lift_v'], 'bias_lift_v')
}

/** 这个值会不会在针上留下一个（可能未知的）非零偏压。**只有明确且解得出的 0 能解除它。** */
function biasIsLive(value: unknown, what: string): boolean {
  if (value === undefined || value === null) return true
  const v = coerce(value, what)
  return v === null ? true : v !== 0
}

// ── 模式闸 ──────────────────────────────────────────────────────────────────

/**
 * SAFE/SEMI 对这次调用的拒绝句，`null` = 放行。
 *
 * 返回的是**不带调用方前缀**的句子——每个入口自己加前缀。绝不能漂的是开头那个
 * **KEY**：`safe_mode_tip_processing_blocked` / `semi_mode_shallow_only`。
 *
 * 三档，而中间那档才是重点：
 * - **SAFE** —— 电脉冲与机械修针**都**拒。
 * - **SEMI** —— 只拒**太深**的机械下压。刻意**不是**「拒绝任何修针」：
 *   让一个入口比另一个更严，正是「同一个技能因为走了哪扇门而给出不同答案」的造法。
 * - **AUTO** —— 放行。
 *
 * **未知档位放行。** `null` 意味着没人绑定模式来源（测试、无头管线、离线工具），
 * 而这一层是「别自作主张」的一层。
 */
export function modeRefusal(
  toolName: string,
  meta: SkillMetaLike | null | undefined,
  args: Readonly<Record<string, unknown>> | null | undefined,
  mode: OperatingMode | null | undefined,
): string | null {
  if (mode === null || mode === undefined || mode === 'AUTO') return null
  if (meta === null || meta === undefined) return null

  const pulse = isElectricalPulse(meta.capabilities, args)
  const shaping = isTipShaping(meta.capabilities)
  if (!pulse && !shaping) return null

  if (mode === 'SAFE') {
    const caps = (meta.capabilities ?? []).filter((c) => c === CAP_BIAS_PULSE || c === CAP_TIP_SHAPING)
    return (
      `safe_mode_tip_processing_blocked: 当前是 SAFE 模式，'${toolName}' 含电脉冲` +
      `（能力标签 ${pyList(caps)}）—— 拒绝执行。SAFE 的契约是「当前针尖视为良好、` +
      `专注实验、不修针」，包一层组合技能、换一个入口都不会改变这一点。` +
      `请直接用当前针尖继续实验，或换一个不动针尖的做法；确实需要修针时请用户切换模式。` +
      `不要重试针尖处理。`
    )
  }

  // SEMI：只拦太深的机械下压
  const v = semiTipDepthViolation(meta, args ?? {})
  return v === null
    ? null
    : `semi_mode_shallow_only: 半自动模式仅允许浅层机械修针。${v}请减小下压深度后重试。`
}

/** SEMI 档的深度违规句（不含前缀），没有就是 `null`。 */
export function semiTipDepthViolation(
  meta: SkillMetaLike,
  args: Readonly<Record<string, unknown>>,
): string | null {
  if (!isTipShaping(meta.capabilities)) return null
  const specs = new Map(meta.parameters.map((p) => [p.name, p]))
  for (const [name, raw] of Object.entries(args)) {
    const nameL = name.toLowerCase()
    if (!SEMI_DEPTH_NAME_PATTERNS.some((pat) => nameL.includes(pat))) continue
    const spec = specs.get(name)
    if ((spec?.unit ?? '').toLowerCase() !== 'm') continue
    const value = coerce(raw, name)
    if (value === null) continue
    if (Math.abs(value) > SEMI_TIP_LIFT_MAX_M) {
      return (
        `'${name}' = ${pyNum(value)} m exceeds the half-auto shallow-plunge cap of ` +
        `${pyNum(SEMI_TIP_LIFT_MAX_M)} m。`
      )
    }
  }
  return null
}

/** Python 的 `repr(list[str])`：单引号、逗号加空格。 */
function pyList(items: readonly string[]): string {
  return `[${items.map((s) => `'${s}'`).join(', ')}]`
}

// ── 全局包络 ────────────────────────────────────────────────────────────────

export interface EnvelopeViolation {
  readonly param: string
  readonly value: number
  readonly min: number
  readonly max: number
}

/** 可调包络检查。**名字（子串）与单位都要匹配**才触发。 */
export function envelopeViolations(
  meta: SkillMetaLike,
  params: Readonly<Record<string, unknown>>,
  limits: SafetyLimits,
): EnvelopeViolation[] {
  const specs = new Map(meta.parameters.map((p) => [p.name, p]))
  const out: EnvelopeViolation[] = []
  for (const [name, raw] of Object.entries(params ?? {})) {
    const spec = specs.get(name)
    if (spec === undefined) continue
    const value = coerce(raw, name)
    if (value === null) continue
    const nameL = name.toLowerCase()
    const unitL = (spec.unit ?? '').toLowerCase()
    for (const [pat, unitPat, minKey, maxKey] of GLOBAL_CHECKS) {
      if (!nameL.includes(pat) || unitPat !== unitL) continue
      const min = limits[minKey]
      const max = limits[maxKey]
      if (value < min || value > max) out.push({ param: name, value, min, max })
      break
    }
  }
  return out
}

// ── 中止闩 ──────────────────────────────────────────────────────────────────

/**
 * 读永远放行。判据只有三个子串条件——**正因为简单，抄错了很难看出来**。
 *
 * ⚠️ **`endsWith('status')` 这一条在当前的 671 个动词上一次都不触发**
 * （2026-09-10 实测：以 `status` 结尾的动词数为 **0**；所有 `*StatusGet` 都已经被
 * `includes('get')` 命中）。所以它**任何测试都覆盖不到**——变红演练把它拆掉，
 * 92 条测试照样全绿。
 *
 * 仍然保留，理由与 D-WIRE-3 同类但结论相反：那一条是**复刻一个 bug**（所以我们改成
 * 抛错），这一条是**与 Python 保持一致的死条件**（无害，且上游哪天加一个 `*Status`
 * 动词它就会生效）。删掉它是一次没有收益的静默偏差。
 */
export function isReadVerb(method: string): boolean {
  const m = method.toLowerCase()
  return m.includes('get') || m.endsWith('status') || m.includes('read')
}

/** 中止闩上之后，这次 Nanonis 调用还能不能发。 */
export function isAbortSafe(method: string, args: readonly unknown[]): boolean {
  if (isReadVerb(method)) return true
  if (!Object.prototype.hasOwnProperty.call(ABORT_SAFE_WRITES, method)) return false
  const rule = ABORT_SAFE_WRITES[method]
  if (rule === null || rule === undefined) return true
  const [idx, stopValues] = rule
  const raw = args[idx]
  // 重载动词**只有停的那一形**安全——同一个调用换成开始值，会把我们正在中止的
  // 那个运动重新启动。证不出是「停」就拒。
  if (typeof raw !== 'number' && typeof raw !== 'string') return false
  const n = Number(raw)
  if (!Number.isInteger(n)) return false
  return stopValues.includes(n)
}

/**
 * 读回值的物理合理性——`physicallyAbsurdViolations` 的**读那一侧**，同一张表。
 *
 * 写那一侧问的是「模型要写的这个数可能吗」，读这一侧问的是
 * 「仪器回给我的这个数可能吗」。两个问题的答案由同一张 `PHYSICAL_ABSURD` 给出，
 * 于是「什么叫量级错」在系统里只有一个定义。
 *
 * **返回空不等于「数值正确」**，只等于「这一批里没有物理上不可能的」。
 *
 * @param readings `{名字: [值, 单位]}`。单位与表**精确匹配**（与写那侧同规则），
 *   于是一个同名的无量纲增益不会被误判。
 */
export function implausibleReadings(
  readings: Readonly<Record<string, readonly [number | null | undefined, string]>>,
): string[] {
  const notes: string[] = []
  for (const [name, pair] of Object.entries(readings)) {
    const [value, unit] = pair
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const nameL = name.toLowerCase()
    const unitL = (unit ?? '').toLowerCase()
    for (const [pat, unitPat, ceiling, hint] of PHYSICAL_ABSURD) {
      if (nameL.includes(pat) && unitPat === unitL && Math.abs(value) >= ceiling) {
        notes.push(
          `⚠ 读回值 '${name}' = ${pyRepr(value)} ${unit ?? ''} 在物理上不可能` +
            `(${hint})。这个读数**不是浮点精度误差**,它比典型值大若干个` +
            `数量级 —— 硬件里现在很可能真的是一个错误的量级。` +
            `不要据此判定「数值正常」,先在 Nanonis 面板上人工核对。`,
        )
        break
      }
    }
  }
  return notes
}

/** Python `repr(float)`。JS 的 `String()` 在这一段上与它一致（`0.25`、`1e-13`）。 */
function pyRepr(v: number): string {
  return String(v)
}
