/**
 * Lock-in 常用参数组 —— **解析层，不是第二存储**。
 *
 * 与 {@link ./zctrl-preset.ts | zctrl-preset} 同一套架构、同一条纪律：**数字不经过模型**。
 * 组里的每个值都从仪器档案取，逐键标注来源；档案没填的键**不下发**，
 * 而不是补一个默认值下去。
 *
 * ## 为什么 phase 不在组里（而且永远不该进来）
 *
 * 真机 2026-08-05，全分辨率截图 + TCP 实测，三条硬事实：
 *
 * - 被拒的**只有** `LockIn_ModPhasSet` 一条命令——解调侧 phase 写得进、频率与幅度
 *   都写得进，所以不是家族锁也不是模块锁；
 * - Lock-In 面板的 **Modulate 区根本没有 phase 字段**（只有 Amplitude / Frequency）。
 *   「Parameter is Locked」不是谁锁了一个标定量，是**该参数在本机配置下不存在于
 *   操作面、固件恒拒写**；
 * - **写同值也被拒**——拒绝由写入动作本身触发，与值无关。
 *
 * ⇒ 挑不出「更好的相位值」来绕过它；唯一有用的动作是**这条命令根本不出现在调用
 * 序列里**。所以判据落在**调用序列**上，不落在参数值上（D-LOCKIN-1）。
 *
 * ## D-LOCKIN-2 · 调制参数**没有出厂默认**
 *
 * 旧仓这两个键在 `instrument_profile` 里带出厂默认（`973 Hz` / `0.02 V`），而
 * `sanitize()` 又把空值**丢掉**——于是 `get_config` 永远给得出数，`unset` 那一支
 * 永远走不到，模块 docstring 里「档案没填就不下发」这句话**从来没有机会执行**。
 *
 * 代价不是空谈：0.02 V 是出厂值而不是本机标定，而 `sources` 却说它来自
 * 「仪器档案 lockin_mod_amp_v」——读的人会当成用户填的。这与 `fromProfile`
 * 拒绝编造进针增益是同一条理由：**没配就拒，绝不拿一组「常见值」顶上**，
 * 因为 20 mV 的调制是一次真实的物理动作，加在谁也没确认过的隧道结上。
 */
import { pyFloatRepr } from './si.js'
import { PresetRejected } from './zctrl-preset.js'

/** 保留组名。与 zctrl 的 `approach` / `scan` 同性质：名字固定，值来自档案。 */
export const PRESET_DIDV = 'didv'
export const RESERVED_LOCKIN_NAMES: readonly string[] = [PRESET_DIDV]

/**
 * 组会下发的档案键 → `ConfigureLockIn` 的参数名。
 *
 * ⚠️ 用的是旧仓**已有**的两个键名，没有新建同义键：同一个物理量两个来源迟早各自漂移。
 *
 * **phase 不在这张表里，而且不是遗漏**——见文件抬头。加它之前请先回答：
 * 本机 Modulate 区什么时候有了 phase 字段？
 */
const PROFILE_KEYS: readonly (readonly [string, string])[] = [
  ['lockin_mod_freq_hz', 'frequency_hz'],
  ['lockin_mod_amp_v', 'amplitude_v'],
]

/**
 * 仪器档案里 lock-in 那一节。**全是 `number | null`，`null` = 用户没填。**
 *
 * X / Y 走哪两路 RT 信号是**接线事实，软件观测不到**，只能由用户填 ——
 * `AutoPhase` 在两者缺一时直接拒绝而不是猜。
 */
export interface LockInProfile {
  /** 档案键 `lockin_mod_freq_hz`。 */
  readonly modFreqHz: number | null
  /** 档案键 `lockin_mod_amp_v`。 */
  readonly modAmpV: number | null
  /** 档案键 `lockin_x_signal_index`。 */
  readonly xSignalIndex: number | null
  /** 档案键 `lockin_y_signal_index`。 */
  readonly ySignalIndex: number | null
}

/**
 * 组里的参数名 → `GetLockInConfig` 结果里**真正**的键名。
 *
 * ⚠️ 两边不同名，而这个不同名就是旧仓的缺陷⑩（真机 2026-08-05，可复现 ×2）：
 * `GetLockInConfig` 的幅度键叫 `amplitude`（无单位后缀），而回读校验原来照着
 * **自己的**参数名 `amplitude_v` 去查——查不到，于是把一次**写入成功**报成
 * 「读不回来」的失败。写进去的值是对的，坏的是校验环节自己。
 *
 * 假阴性比不校验更坏：它带着「我核对过」的权威口气，把人往硬件方向送。
 *
 * **不要**改成「两边名字都收」那种写法：那会把「两边名字对不上」这件事永远藏起来。
 */
export const LOCKIN_READBACK_KEYS: Readonly<Record<string, string>> = {
  frequency_hz: 'frequency_hz',
  amplitude_v: 'amplitude',
}

/** 一个解析好的组：下发什么、每个数从哪来、以及**哪些键故意没有**。 */
export class ResolvedLockInPreset {
  constructor(
    readonly name: string,
    /** 参数名 → 值。**只含档案里真的填了的键。** */
    readonly values: Readonly<Record<string, number>>,
    readonly sources: Readonly<Record<string, string>>,
    /** 档案里没填、因而**不下发**的档案键名。 */
    readonly unset: readonly string[],
    readonly notes: readonly string[] = [],
  ) {}

  /**
   * `ConfigureLockIn` 的入参 —— **只包含档案里真的填了的键**。
   *
   * 没填的键连键名都不出现，而不是传一个 `null` 或 `0`：那两种写法在本仓都咬过人
   * （声明默认值把「没说」变成「说了 0」）。`phase_deg` 永远不在里面。
   */
  skillParams(modOn = true): Record<string, unknown> {
    return { mod_on: modOn, ...this.values }
  }

  /** 至少有一个值可下发，这个组才有意义。 */
  get usable(): boolean {
    return Object.keys(this.values).length > 0
  }

  why(): string {
    if (this.usable) {
      const got = Object.entries(this.values)
        .map(([k, v]) => `${k}=${pyFloatRepr(v)}`)
        .join('、')
      const tail = this.unset.length > 0 ? `;档案未填、因而不下发:${this.unset.join('、')}` : ''
      return `将下发 ${got}${tail}`
    }
    return (
      `仪器档案里这一组一个值都没有配置(${this.unset.join('、')})。` +
      '请在「设置 → 仪器档案 → lock-in」里填写 —— 这组数只由用户输入,不经模型。'
    )
  }

  asDict(): Record<string, unknown> {
    return {
      name: this.name,
      values: { ...this.values },
      sources: { ...this.sources },
      unset: [...this.unset],
      usable: this.usable,
      why: this.why(),
      notes: [...this.notes],
      // **明说出来**，免得有人以为是漏了。
      phase_deg: null,
      phase_note: LOCKIN_PHASE_NOTE,
    }
  }
}

/** 「调制侧 phase 为什么不在组里」的那一句话。返回值里逐字带着它。 */
export const LOCKIN_PHASE_NOTE =
  '调制侧 phase 永不下发:本机 Modulate 区没有该字段,TCP 写恒拒(写同值也拒)。' +
  '相位在解调侧 Ref. Phase。'

/** 档案里那个值能用吗。能用给它本身，不能用给 `null`（视为未配置）。 */
function profileNumber(raw: number | null | undefined): number | null {
  return raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw
}

/**
 * 把组名解析成「下发什么」。未知组名**直接拒绝，不猜**。
 *
 * `profile` 没接 ⇒ 视为一个键都没填 ⇒ 解析得出一个 `usable === false` 的组，
 * 而不是抛异常：「这台机器还没配 lock-in」是一个**答案**，`ListLockInPresets`
 * 要把它连同「去哪儿填」一起报出来。
 */
export function resolveLockInPreset(
  name: string = PRESET_DIDV,
  profile?: LockInProfile | null,
): ResolvedLockInPreset {
  const lowered = String(name ?? '').trim().toLowerCase()
  if (lowered !== PRESET_DIDV) {
    throw new PresetRejected(
      `没有名为 '${String(name ?? '')}' 的 lock-in 参数组;目前只有 ` +
        `${RESERVED_LOCKIN_NAMES.join('、')}。`,
    )
  }

  const raw: Readonly<Record<string, number | null>> = {
    lockin_mod_freq_hz: profileNumber(profile?.modFreqHz),
    lockin_mod_amp_v: profileNumber(profile?.modAmpV),
  }
  const values: Record<string, number> = {}
  const sources: Record<string, string> = {}
  const unset: string[] = []
  for (const [key, param] of PROFILE_KEYS) {
    const v = raw[key]
    if (v === null || v === undefined) {
      unset.push(key)
      continue
    }
    values[param] = v
    sources[param] = `仪器档案 ${key}`
  }
  return new ResolvedLockInPreset(PRESET_DIDV, values, sources, unset)
}

/** 所有保留组的解析结果（含 `usable` / `why`）—— 给只读盘点用。 */
export function listLockInPresets(profile?: LockInProfile | null): Record<string, unknown>[] {
  return RESERVED_LOCKIN_NAMES.map((name) => {
    try {
      return resolveLockInPreset(name, profile).asDict()
    } catch (e) {
      if (!(e instanceof PresetRejected)) throw e
      return { name, usable: false, why: e.message }
    }
  })
}
