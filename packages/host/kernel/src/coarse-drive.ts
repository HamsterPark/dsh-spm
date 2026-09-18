/**
 * 粗动驱动幅度 / 频率 —— **操作员的参数，不是 agent 的**。
 *
 * 旧仓 `mast/core/coarse_drive.py`（346 行，一张 `_SPEC` 表 + 两道闸）。
 *
 * ## 为什么它自成一个模块
 *
 * 平移式粗动步进器靠几百伏的锯齿波驱动。**控制器的上限和这台机器叠堆的上限是两个数**，
 * 而只有第二个要紧：
 *
 * > 「有些 Nanonis 控制器支持 400V，但是有时候 300V 就烧坏了」
 *
 * **没有任何读数、状态位或报错会告诉你自己在哪一台机器上。** 那个数只住在一个地方 ——
 * 装这台机器的那个人脑子里 —— 所以 MAST 的活是**持有它、对照它、绝不猜**。
 *
 * ## 四道锁（旧仓原话，逐条照移）
 *
 * 1. **agent 看不见这个技能**：`SetMotorFreqAmp` 在 `advanced_capabilities` 门后面，
 *    默认关；开它要 admin PIN（fail-closed：没设 PIN 就根本写不了）。
 * 2. **就算看见了也调不动**：`isCoarseDriveChange` 在自主路径上直接拒
 *    （本仓 `kernel/src/safety.ts:164` 已经有了）。两把独立的锁，因为第一把是个人能扳的开关。
 * 3. **本机上限**：{@link authorize} 拒绝任何高于声明值的请求 —— 并且**什么都没声明时
 *    拒绝一切**。沉默不是同意：不知道这只叠堆受得了多少，是「什么都别做」的理由，
 *    不是「退回一个别人为另一台机器挑的数」的理由。
 * 4. **一条配置放宽不了的绝对上限**（对应 `safety._PHYSICAL_ABSURD`）：400 V 是这一类
 *    粗动控制器的输出上限，更大的请求是**种类错了**，不是程度错了。
 *
 * ## 为什么拒绝而不夹紧
 *
 * 越界请求**一律拒**，绝不悄悄降下来。夹紧会把「300 V 会烧掉这只叠堆」变成
 * 「按 300 V 跑了」而调用方以为自己要的是 400 —— 一个**做错了却报成功**的动作。
 * 持有一个按机器的上限，全部意义就在于让这个不匹配**看得见**。
 *
 * ## 读回核对为什么存在
 *
 * 声明约束的是**MAST 会写什么**，它对驱动**当前被设成多少**一无所知 ——
 * 可能有人在 Nanonis 界面上改过，也可能上一场把它留在高位。所以每一次粗动移动
 * 之前都要读回（`Motor_FreqAmpGet`）再比。{@link readbackMatches} 就是那个比较，
 * 而**读不到就是拒绝**，不是放行：这道检查的全部价值就在于它在看不见的时候会失败。
 *
 * ---
 *
 * ## 三个问题（同 `tip-crash-tracker.ts` / `instrument-profile.ts`）
 *
 * ### ① 住哪里
 *
 * **进程级**（{@link processCoarseDrive}），与 `processInstrumentProfile` 同族。
 * 一台机器一只叠堆，「本机上限 220 V」必须跨调用活着。
 *
 * ### ② 谁注入
 *
 * **宿主**：`source` 是读口函数（旧仓那边是 settings 键 `coarse_drive` 的水合 +
 * admin 写入）。同 D-VAC-1 / D-LIMITS-1：**限值是台架的属性，不是类的属性**。
 *
 * ### ③ 宿主不接时
 *
 * **拒绝一切**，而且说的是同一句话（{@link UNDECLARED}）。这一条与别处**不同**，
 * 值得说清：`processVacuum` 没接时退回出厂阈值继续判，因为压强有一条与机器无关的物理
 * 判据；这里没有 —— 「这只叠堆能受多少伏」没有出厂默认，只有一个填了或没填的事实。
 * 所以这里的 fail-closed 是**唯一**可能的行为。
 */

import { formatG, pyFloatRepr } from './si.js'

/** 宿主存这份声明的设置键（旧仓 `SettingsStore.KNOWN_KEYS` + `admin_pin.GUARDED_KEYS`）。 */
export const SETTINGS_KEY = 'coarse_drive'

/**
 * 任何声明都不得超过的硬上限。性质同 `safety._PHYSICAL_ABSURD`：与机器无关、
 * 管理员放宽不了，违反它意味着「数字的种类错了」而不是「把限值调高一点」。
 */
export const ABSOLUTE_MAX_AMPLITUDE_V = 400.0
export const ABSOLUTE_MAX_FREQUENCY_HZ = 20_000.0

/**
 * 移动前读回比较的相对容差。驱动电子学对幅度 DAC 做量化，要求严格相等不合理；
 * 2 % 远比任何物理上要紧的差别都紧。
 */
export const COARSE_READBACK_REL_TOL = 0.02

/** 声明里的数值字段：`[标签, 单位, [下界, 上界]]`。未登记的键丢掉（同档案的 `sanitize`）。 */
export const DRIVE_SPEC: Readonly<Record<string, readonly [string, string, readonly [number, number]]>> = {
  max_amplitude_v: ['本机粗动驱动幅度上限(用户声明)', 'V', [0.0, ABSOLUTE_MAX_AMPLITUDE_V]],
  expected_frequency_hz: [
    '本机粗动驱动频率(用于移动前读回核对;留空=不核对频率)',
    'Hz',
    [0.0, ABSOLUTE_MAX_FREQUENCY_HZ],
  ],
}

const TEXT_KEYS: readonly string[] = ['declared_by', 'notes']
const STAMP_KEYS: readonly string[] = ['declared_at']

export const DRIVE_ALL_KEYS: readonly string[] = [
  ...Object.keys(DRIVE_SPEC),
  ...TEXT_KEYS,
  ...STAMP_KEYS,
]

/**
 * 未声明时那段话，**逐字**。
 *
 * ⚠️ 它与 `l0/reads-hw.ts` 的 `COARSE_AMP_UNDECLARED` 是**同一段文本的两份**，
 * 而旧仓那边是同一个常量（`coarse_drive._UNDECLARED`）。本仓这一份是内核的、
 * 有判据在用；那一份是批 1 写的、`GetMotorFreqAmp` 的 `note` 在用。
 * **没有合并**：那个文件这一轮不该动（见交接 §0）。合并它是下一次的事，
 * 而在合并之前有一条测试钉着两份**逐字相等**（`coarse-drive.test.ts`）。
 */
export const UNDECLARED =
  '本机粗动驱动幅度上限【尚未声明】,拒绝设置驱动电压。\n' +
  '控制器支持的电压和这台机器的压电叠堆能承受的电压是两个数 —— 有些控制器支持 400 V,' +
  '但有的叠堆 300 V 就烧了,而且没有任何读数会告诉你是哪一种。\n' +
  '请用户在【高级】页填写本机上限(需要 admin PIN)。在那之前 MAST 不会替这台机器猜。'

/** 进程内的声明**读口**。`source === null` = 宿主没接 ⇒ 一切驱动写入与粗动移动被拒。 */
export const processCoarseDrive: {
  source: (() => unknown) | null
} = { source: null }

function finiteNum(value: unknown): number | null {
  const v = pyFloatLike(value)
  return v !== undefined && Number.isFinite(v) ? v : null
}

/**
 * Python 的 `float(x)`：**转不了**给 `undefined`，转得了但非有限就**原样交出去**。
 *
 * 这个区别是判据本身：`float(None)` / `float('')` 在旧仓抛（⇒「读不到」），
 * 而 `float('nan')` 不抛（⇒「读数不是有限数值」）—— 两条不同的拒绝，两句不同的话。
 *
 * ⚠️ **不能用 `Number()`**：`Number(null)` / `Number('')` / `Number('  ')` **全是 `0`**，
 * 而 0 V 读起来正是一个合规的驱动幅度 —— 那是 D-VAC-4 的同一种失败形状，
 * 由类型转换伪造出来。布尔也当「转不了」：Python 的 `float(True)` 是 1.0，
 * 但一个布尔型的驱动幅度读数是 wire 层出了问题，不该被当成 1 V 放行。
 */
function pyFloatLike(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === 'boolean') return undefined
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const t = value.trim()
  if (t === '') return undefined
  if (/^[+-]?nan$/i.test(t)) return Number.NaN
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity
  const n = Number(t)
  return Number.isNaN(n) ? undefined : n
}

/**
 * 洗一份生声明。**永不抛**；非对象给 `{}`。
 *
 * 越界数值**丢掉，不夹紧** —— 一份声明是对硬件的断言，而一份需要我们替它改正的断言
 * 不是一份该照着做的断言。
 */
export function sanitizeDeclaration(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, [, , [lo, hi]]] of Object.entries(DRIVE_SPEC)) {
    const v = src[key]
    if (v === undefined || v === null || v === '') continue
    const num = finiteNum(v)
    if (num === null) continue
    if (num < lo || num > hi) continue
    out[key] = num
  }
  for (const key of TEXT_KEYS) {
    const v = src[key]
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim().slice(0, 200)
  }
  for (const key of STAMP_KEYS) {
    const v = finiteNum(src[key])
    if (v !== null) out[key] = v
  }
  return out
}

/** 当前声明。没接读口、读口抛了，都是**没有声明**（`{}`）。 */
export function getDeclaration(): Record<string, unknown> {
  const src = processCoarseDrive.source
  if (src === null) return {}
  try {
    return sanitizeDeclaration(src())
  } catch {
    // 一只坏掉的读口就是「没有声明」—— 而没有声明正是这道闸要拒的那件事。
    return {}
  }
}

/** 本机声明的幅度上限（V），没声明 ⇒ `null`。 */
export function maxAmplitudeV(): number | null {
  const v = getDeclaration()['max_amplitude_v']
  return typeof v === 'number' ? v : null
}

/** 本机声明的期望频率（Hz），没声明 ⇒ `null`（= 不核对频率）。 */
export function expectedFrequencyHz(): number | null {
  const v = getDeclaration()['expected_frequency_hz']
  return typeof v === 'number' ? v : null
}

export function isDeclared(): boolean {
  return maxAmplitudeV() !== null
}

/** 一道闸的答复：过没过，以及**为什么**（中文，直接给人看）。 */
export interface DriveVerdict {
  readonly ok: boolean
  readonly reason: string
}

/** Python `f"{v:g}"`。**用仓里那一份**，不另写 —— `%g` 的换挡门槛不是想当然的。 */
function g(v: number): string {
  return formatG(v, 6)
}

/**
 * 那几句拒绝里印的「你发过来的是什么」。
 *
 * 数值与字符串按 **Python `repr`** 印（`-1.0` / `'abc'`）：那只是格式，两侧一致
 * 才让整段措辞进得了金样。而 `null` / `undefined` **按 JS 印** —— 同 D-SKILL-2：
 * 为了逐字去伪造一个 `None`，等于让诊断指向一门这里没有在跑的语言。
 * 这一处差异在 `coarse-drive.test.ts` 上钉着。
 */
function pyRepr(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return pyFloatRepr(v)
  return JSON.stringify(v) ?? String(v)
}

/**
 * 可以写这个驱动设置吗？**拒绝，绝不夹紧。**
 *
 * 四道锁里的第 3、4 条在这儿。顺序是**判据的一部分**：绝对上限排在一切可配置的东西
 * 前面，于是没有任何声明能放宽它，一个填错了的本机上限也授权不了一个荒谬的请求。
 */
export function authorize(
  amplitudeV: unknown,
  frequencyHz: unknown = null,
  axis = 'all',
): DriveVerdict {
  const raw = pyFloatLike(amplitudeV)
  if (raw === undefined) {
    return { ok: false, reason: `驱动幅度不是一个数值:${pyRepr(amplitudeV)}` }
  }
  if (!Number.isFinite(raw)) return { ok: false, reason: '驱动幅度不是一个有限数值' }
  if (raw < 0) return { ok: false, reason: '驱动幅度不能为负' }

  // 锁 4 —— 绝对的，排在一切可配置的东西之前。
  if (raw > ABSOLUTE_MAX_AMPLITUDE_V) {
    return {
      ok: false,
      reason:
        `驱动幅度 ${g(raw)} V 超过绝对上限 ${g(ABSOLUTE_MAX_AMPLITUDE_V)} V —— ` +
        '这已经不是「上限设低了」,而是数量级/单位错了。任何配置都不能放宽这一条。',
    }
  }

  if (frequencyHz !== null && frequencyHz !== undefined) {
    const f = pyFloatLike(frequencyHz)
    if (f === undefined) {
      return { ok: false, reason: `驱动频率不是一个数值:${pyRepr(frequencyHz)}` }
    }
    if (Number.isNaN(f) || f < 0 || f > ABSOLUTE_MAX_FREQUENCY_HZ) {
      return {
        ok: false,
        reason: `驱动频率 ${pyRepr(frequencyHz)} 超出 0..${g(ABSOLUTE_MAX_FREQUENCY_HZ)} Hz`,
      }
    }
  }

  // 锁 3 —— 本机上限。**沉默不是同意。**
  const ceiling = maxAmplitudeV()
  if (ceiling === null) return { ok: false, reason: UNDECLARED }
  if (raw > ceiling) {
    return {
      ok: false,
      reason:
        `驱动幅度 ${g(raw)} V 超过本机声明上限 ${g(ceiling)} V —— 拒绝执行。\n` +
        `【不会自动降到上限】:那样调用方会以为自己设的是 ${g(raw)} V,` +
        `而实际跑的是 ${g(ceiling)} V。要用更高的电压,必须由用户先修改本机声明。`,
    }
  }
  return { ok: true, reason: `${g(raw)} V ≤ 本机声明上限 ${g(ceiling)} V（axis=${axis}）` }
}

/**
 * 驱动**此刻**在不在声明的包络里？每一次粗动移动之前问一遍。
 *
 * **读不到就是拒绝。** 一道失败模式是「通过」的检查不是检查，而这一道守着一个
 * 不可逆的后果。
 *
 * 频率不符只**警告**不拒绝：频率错了会改变每一步走多远（里程表会漂），
 * 但它不会烧掉叠堆。两种后果不同，所以两种答复不同。
 */
export function readbackMatches(
  readAmplitudeV: unknown,
  readFrequencyHz: unknown = null,
): DriveVerdict {
  const ceiling = maxAmplitudeV()
  if (ceiling === null) return { ok: false, reason: UNDECLARED }

  const amp = pyFloatLike(readAmplitudeV)
  if (amp === undefined) {
    return {
      ok: false,
      reason:
        '读不到当前粗动驱动幅度,拒绝粗动。' +
        '读不到 ≠ 没问题 —— 电压可能是别人在 Nanonis 界面里改的。',
    }
  }
  if (!Number.isFinite(amp)) return { ok: false, reason: '粗动驱动幅度读数不是有限数值,拒绝粗动' }
  if (amp > ceiling * (1.0 + COARSE_READBACK_REL_TOL)) {
    return {
      ok: false,
      reason:
        `当前粗动驱动幅度 ${g(amp)} V 高于本机声明上限 ${g(ceiling)} V —— 拒绝粗动。` +
        '请在 Nanonis 里把它调回来,或由用户更新本机声明。',
    }
  }

  const expected = expectedFrequencyHz()
  if (expected !== null && readFrequencyHz !== null && readFrequencyHz !== undefined) {
    // 旧仓这里把「转不了」折成 `nan` 再判 —— 于是两种成因走同一条拒绝。照移。
    const freq = pyFloatLike(readFrequencyHz) ?? Number.NaN
    if (Number.isNaN(freq)) {
      return { ok: false, reason: '读不到当前粗动驱动频率,而本机声明了期望频率,拒绝粗动' }
    }
    if (Math.abs(freq - expected) > Math.max(expected * 0.1, 1.0)) {
      return {
        ok: true,
        reason:
          `幅度 ${g(amp)} V 合规,但驱动频率 ${g(freq)} Hz 与声明的 ` +
          `${g(expected)} Hz 不符 —— 每步走的距离会变,里程表会漂。`,
      }
    }
  }
  return { ok: true, reason: `当前驱动幅度 ${g(amp)} V ≤ 本机声明上限 ${g(ceiling)} V` }
}

/**
 * 给系统提示块的一小段。**永不为空，也永不给出一个可以照着做的数。**
 *
 * 刻意**不**邀请模型提一个值：这一块的全部要点就是「这是别人的参数」。
 */
export function formatCoarseDriveBlock(): string {
  const ceiling = maxAmplitudeV()
  if (ceiling === null) {
    return (
      '【粗动驱动电压】本机上限未声明 —— 任何设置驱动电压的尝试都会被拒绝,' +
      '粗动移动也会被拒绝。这是用户在【高级】页填写的参数,不要尝试自己设定。'
    )
  }
  const freq = expectedFrequencyHz()
  const tail = freq === null ? '' : `、期望频率 ${g(freq)} Hz`
  return (
    `【粗动驱动电压】本机声明上限 ${g(ceiling)} V${tail}(用户设定,只读)。` +
    '这是唯一能保护压电叠堆的数字,**不要尝试修改它,也不要尝试设置驱动电压** —— ' +
    '需要改就交给用户。'
  )
}
