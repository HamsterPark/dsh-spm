/**
 * Z 参数组存储 —— `CreateZCtrlPreset` 的全部判据。
 *
 * ## 值以 **SI 字符串**存，不以数字存
 *
 * `'3p'` 存的就是 `'3p'`。于是**操作员在界面上看到的，就是模型要写的那个东西**，
 * 而一次经过存储的往返不可能悄悄把前缀变成指数。
 *
 * ## 前缀不可省略
 *
 * 裸数字（`'3'`）**直接拒**。理由是量级一旦丢失，裸数字仍然是一个合法的数——
 * 错一万亿倍也没人发现；而前缀掉了就解析失败，调用方立刻收到一次明确的拒绝。
 *
 * ## 从不夹紧
 *
 * 超范围就拒。「**被悄悄改小的值会让你以为自己设的是原来那个数**」——这与
 * `ConfigureScan` 的两道帧闸是同一条纪律。
 */
import { SIParseError, formatSi, parseSi, pyFloatRepr } from './si.js'
import { tierByName, tierForSize, tierNames, type ScanTier } from './scan-policy.js'

export const PRESET_APPROACH = 'approach'
export const PRESET_SCAN = 'scan'
/**
 * 保留名。
 *
 * `approach` 取自仪器档案的进针参数，`scan` 取自扫描档位表——自定义组不能遮蔽它们，
 * 否则你在档位表里改了扫图增益，而 `ApplyZCtrlPreset('scan')` 还用旧值。
 */
export const RESERVED_NAMES: readonly string[] = [PRESET_APPROACH, PRESET_SCAN]
export const MAX_PRESETS = 16
export const MAX_NAME_CHARS = 32
export const MAX_NOTE_CHARS = 200

/**
 * 每个字段的可接受量级。
 *
 * **有意比任何真机都宽、比 `SetZCtrlGain` 自己的上限都窄**：这一层拒的是「这根本
 * 不是一个 Z 增益」，技能的参数声明拒的是「对这台仪器不对」，两者**互不是对方的兜底**。
 */
export const PRESET_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  p_gain: [1e-15, 1e-6], // 米
  i_gain: [1e-12, 1e-3], // 米/秒
  setpoint_a: [1e-12, 1e-7], // 安培 —— 与 SetSetpoint 对齐
}

/**
 * 时间常数的界。**派生的，不存**：Nanonis 吃 (P, T, I) 而 T = P / I，把 T 也存下来
 * 只会让它和定义它的那一对漂移开。
 */
export const TIME_CONSTANT_BOUNDS: readonly [number, number] = [1e-9, 10.0]

/** 校验没过。**它是一个值，不是一次崩溃**——调用方要把这句话原样报给用户。 */
export class PresetRejected extends Error {
  override readonly name = 'PresetRejected'
}

export interface StoredPreset {
  readonly name: string
  /** SI 字符串，原样存。 */
  readonly p_gain: string
  readonly i_gain: string
  readonly setpoint_a?: string
  readonly note?: string
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) throw new PresetRejected('参数组必须有名字。')
  if (name.length > MAX_NAME_CHARS) {
    throw new PresetRejected(`参数组名最长 ${MAX_NAME_CHARS} 字符。`)
  }
  return name
}

function checkRange(field: string, value: number): void {
  const [lo, hi] = PRESET_BOUNDS[field] as readonly [number, number]
  if (value >= lo && value <= hi) return
  throw new PresetRejected(
    `${field} = ${pyFloatRepr(value)}(${formatSi(value)}) 超出允许范围 ` +
      `[${formatSi(lo)}, ${formatSi(hi)}]。**拒绝写入,不会自动夹到边界** —— ` +
      '被悄悄改小的值会让你以为自己设的是原来那个数。',
  )
}

/** 解析检查一个 SI 字符串，**原样**返回它去存。 */
function siField(field: string, raw: unknown): string {
  let value: number
  try {
    value = parseSi(raw, field)
  } catch (e) {
    throw new PresetRejected(e instanceof SIParseError ? e.message : String(e))
  }
  checkRange(field, value)
  return String(raw).trim()
}

/**
 * 校验一组自定义参数。**抛 {@link PresetRejected}，从不夹紧。**
 *
 * `tierNames` 由调用方给：档名已经可以直接当参数组名用，再建一个同名的自定义组
 * 只会让两者永远有一个是死的。
 */
export function sanitizePreset(
  raw: Readonly<Record<string, unknown>>,
  tierNames: readonly string[] = [],
): StoredPreset {
  const name = cleanName(raw['name'])
  const lowered = name.toLowerCase()
  if (RESERVED_NAMES.includes(lowered)) {
    throw new PresetRejected(
      `'${name}' 是保留名。'approach' 取自仪器档案的进针参数,` +
        `'scan' 取自扫描档位表 —— 自定义组不能遮蔽它们` +
        `(否则你在档位表里改了扫图增益,ApplyZCtrlPreset('scan') 却还用旧值)。`,
    )
  }
  if (tierNames.some((t) => t.toLowerCase() === lowered)) {
    throw new PresetRejected(
      `'${name}' 与扫描档位表里的档名重名。档名已经可以直接当参数组名用,` +
        `再建一个同名的自定义组只会让两者永远有一个是死的。`,
    )
  }

  const out: Record<string, string> = { name }
  for (const field of ['p_gain', 'i_gain'] as const) {
    const v = raw[field]
    if (v === undefined || v === null || v === '') {
      throw new PresetRejected(`参数组 '${name}' 缺少 ${field}。`)
    }
    out[field] = siField(field, v)
  }
  const sp = raw['setpoint_a']
  if (sp !== undefined && sp !== null && sp !== '') out['setpoint_a'] = siField('setpoint_a', sp)

  // T = P / I。**派生的，不存。**
  const p = parseSi(out['p_gain'], 'p_gain')
  const i = parseSi(out['i_gain'], 'i_gain')
  if (i <= 0) throw new PresetRejected(`参数组 '${name}' 的 i_gain 必须为正(T = P / I)。`)
  const tConst = p / i
  const [lo, hi] = TIME_CONSTANT_BOUNDS
  if (!(tConst >= lo && tConst <= hi)) {
    throw new PresetRejected(
      `参数组 '${name}' 的 P/I 组合导出的时间常数 T = P/I = ` +
        `${formatSi(tConst)}s 不合理(应在 ${formatSi(lo)}s – ${hi}s)。` +
        `请检查 p_gain 与 i_gain 的量级。`,
    )
  }

  const note = String(raw['note'] ?? '').trim()
  if (note) out['note'] = note.slice(0, MAX_NOTE_CHARS)
  return out as unknown as StoredPreset
}

/**
 * 参数组存储。**进程内一份**，落盘由注入的 sink 负责。
 *
 * 落盘失败**只记不抛**：内存里已经改好了，报出去比把一次成功的写入变成失败要好。
 */
export class PresetStore {
  #presets: StoredPreset[] = []

  constructor(
    private readonly tierNames: () => readonly string[] = () => [],
    private readonly persist?: (all: readonly StoredPreset[]) => void,
  ) {}

  list(): readonly StoredPreset[] {
    return this.#presets.map((p) => ({ ...p }))
  }

  /** 现在能应用的全部组名：两个保留名 + 档名 + 自定义组。 */
  availableNames(): string[] {
    return [...RESERVED_NAMES, ...this.tierNames(), ...this.#presets.map((p) => p.name)]
  }

  /** 建或替换一组。**同名默认拒**——覆盖要显式说。 */
  upsert(raw: Readonly<Record<string, unknown>>, overwrite = false): StoredPreset {
    const item = sanitizePreset(raw, this.tierNames())
    const key = item.name.toLowerCase()
    const at = this.#presets.findIndex((p) => p.name.toLowerCase() === key)
    if (at >= 0 && !overwrite) {
      throw new PresetRejected(`参数组 '${item.name}' 已存在。要替换它请显式传 overwrite=true。`)
    }
    if (at < 0 && this.#presets.length >= MAX_PRESETS) {
      throw new PresetRejected(`参数组最多 ${MAX_PRESETS} 组,请先删除不用的。`)
    }
    if (at < 0) this.#presets.push(item)
    else this.#presets[at] = item
    this.#flush()
    return item
  }

  /** 删一组。返回**是否真的删掉了**。 */
  delete(name: string): boolean {
    const key = String(name ?? '').trim().toLowerCase()
    const before = this.#presets.length
    this.#presets = this.#presets.filter((p) => p.name.toLowerCase() !== key)
    const removed = this.#presets.length !== before
    if (removed) this.#flush()
    return removed
  }

  /** 测试用：清空。 */
  clear(): void {
    this.#presets = []
  }

  #flush(): void {
    if (this.persist === undefined) return
    try {
      this.persist(this.list())
    } catch {
      // 落盘失败不许把一次已经成功的写入变成失败 —— 内存里已经是新的了。
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 解析：一个**名字** → 一组数字 + 每个数字的来历
// ─────────────────────────────────────────────────────────────────────────

/**
 * 一个数字是从哪儿来的。UI 与测试都断言这几个值。
 *
 * 出厂档位表**不带增益**（`p_gain` / `time_constant_s` 都空），所以出厂配置下
 * `tier-factory` 这一支解析不出东西、只会拒——这不是「还没接线」，是**没配就该拒**：
 * 一台仪器的 Z 增益不可能有出厂默认值。
 */
export const SOURCE_TIER_OPERATOR = 'tier-operator'
export const SOURCE_TIER_FACTORY = 'tier-factory'

/**
 * 进针参数，取自**仪器档案**（用户在设置界面填，不经模型）。
 *
 * 三个都可能是 `null` = 没填。**读不到就拒**，绝不拿一组「常见值」顶上：
 * 编一个出来会以本机标定的名义跑一次真实的进针。
 */
export interface ApproachProfile {
  readonly pGainM: number | null
  readonly iGainMPerS: number | null
  readonly setpointA: number | null
}

/** 一组解析好的参数，**连同每个数字的来历**。 */
export class ResolvedPreset {
  readonly timeConstantS: number

  constructor(
    readonly name: string,
    readonly pGain: number,
    readonly iGain: number,
    readonly setpointA: number | null,
    readonly sources: Readonly<Record<string, string>>,
    readonly notes: readonly string[] = [],
  ) {
    // **派生的，不存**：Nanonis 吃 (P, T, I) 而 T = P / I，把 T 也存下来只会让它
    // 和定义它的那一对漂移开。
    this.timeConstantS = pGain / iGain
  }

  /** 正好是 `SetZCtrlGain` 的入参。**参数顺序只在这一处**。 */
  gainParams(): { p_gain: number; time_constant_s: number; i_gain: number } {
    return { p_gain: this.pGain, time_constant_s: this.timeConstantS, i_gain: this.iGain }
  }

  /**
   * 给人读的来历 —— **每个数字都说清自己从哪儿来**。
   *
   * 操作员得能在不读代码的情况下回答「这个环为什么是**这个**值」，
   * 而一个没有来历的数字没人核得动。
   */
  traceLines(): string[] {
    const rows = [
      `p_gain = ${formatSi(this.pGain)}m ← ${this.sources['p_gain'] ?? '?'}`,
      `i_gain = ${formatSi(this.iGain)}m/s ← ${this.sources['i_gain'] ?? '?'}`,
      `time_constant_s = ${formatSi(this.timeConstantS)}s ← 由 P/I 导出`,
    ]
    rows.push(
      this.setpointA === null
        ? 'setpoint_a = 未配置(保持当前值,不下发)'
        : `setpoint_a = ${formatSi(this.setpointA)}A ← ${this.sources['setpoint_a'] ?? '?'}`,
    )
    return rows
  }
}

/**
 * 解析要的四样东西。**全是值，不是 I/O** —— `scan` 别名要的帧宽由调用方读好传进来。
 *
 * 旧仓是 `resolve(name, context=...)`，在内核里发 `Scan_FrameGet`。本仓把那一次读
 * 留在技能层：判据进内核、动作留外面，这样 `resolve` 的每一支都测得动，
 * 而「读不到帧宽」这件事也就有了一个**明确的值**（`null`）而不是一次异常。
 */
export interface PresetSources {
  /** 仪器档案里的进针参数。没接就是没配。 */
  readonly approach?: ApproachProfile | null
  /** 自定义组。 */
  readonly presets?: readonly StoredPreset[]
  /** 当前扫描帧宽（米）。`scan` 别名要它；**读不到给 `null`**。 */
  readonly frameSizeM?: number | null
}

/** 现在 `resolve` 认的全部名字，保留名在前。 */
export function availableNames(presets: readonly StoredPreset[] = []): string[] {
  const names = [...RESERVED_NAMES, ...tierNames(), ...presets.map((p) => p.name)]
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const k = n.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out
}

function fromProfile(p: ApproachProfile | null | undefined): ResolvedPreset {
  const missing: string[] = []
  if (p?.pGainM === null || p?.pGainM === undefined) missing.push('P 增益')
  if (p?.iGainMPerS === null || p?.iGainMPerS === undefined) missing.push('I 增益')
  if (missing.length > 0) {
    // **如实失败并说去哪儿改。** 对一句明确的「应用进针参数」什么都不做还报成功，
    // 是一次假成功。
    throw new PresetRejected(
      `进针参数组尚未配置(${missing.join(', ')} 为空)。` +
        '请在「设置 → 仪器档案 → 进针参数」里填写 —— 这组数只由用户输入,不经模型。',
    )
  }
  return new ResolvedPreset(
    PRESET_APPROACH,
    p!.pGainM as number,
    p!.iGainMPerS as number,
    p!.setpointA,
    {
      p_gain: '仪器档案 approach_p_gain_m',
      i_gain: '仪器档案 approach_i_gain_m_per_s',
      setpoint_a: '仪器档案 approach_setpoint_a',
    },
  )
}

/**
 * 这一档配了增益吗。配了给 `[P, T]`，没配给 `null`。
 *
 * 提成函数而不是写在 `if` 里，是为了让这道闸**拆得开**：判断写在 `if` 里时
 * 下游的类型收窄挂在它身上，把它改成永远为假会让 `tsc` 直接报错，而一条编不过的
 * 变异什么都没验。
 */
function tierGains(tier: ScanTier): [number, number] | null {
  const p = tier.pGain
  const t = tier.timeConstantS
  return p === undefined || p === null || t === undefined || t === null ? null : [p, t]
}

function fromTier(tier: ScanTier, label: string): ResolvedPreset {
  const name = tier.name || label
  const gains = tierGains(tier)
  if (gains === null) {
    throw new PresetRejected(
      `扫描档位 '${name}' 没有配置 P 增益/时间常数。` +
        '请在「设置 → 扫描档位表」里补上,或改用别的参数组。',
    )
  }
  const [p, t] = gains
  if (t <= 0) {
    throw new PresetRejected(`扫描档位 '${name}' 的时间常数为 0,无法导出 I = P/T。`)
  }
  // 出厂表永远走不到这里（三个增益字段都空），能走到的只有操作员编辑过的档。
  const origin = `扫描档位表 '${name}'(${SOURCE_TIER_OPERATOR})`
  return new ResolvedPreset(name, p, p / t, tier.setpointA ?? null, {
    p_gain: origin,
    i_gain: `${origin},I = P/T 导出`,
    setpoint_a: origin,
  })
}

function fromCustom(item: StoredPreset): ResolvedPreset {
  const origin = `自定义参数组 '${item.name}'`
  return new ResolvedPreset(
    item.name,
    parseSi(item.p_gain, 'p_gain'),
    parseSi(item.i_gain, 'i_gain'),
    item.setpoint_a === undefined || item.setpoint_a === ''
      ? null
      : parseSi(item.setpoint_a, 'setpoint_a'),
    { p_gain: origin, i_gain: origin, setpoint_a: origin },
    item.note !== undefined && item.note !== '' ? [item.note] : [],
  )
}

/** 读到的帧宽。读不到、或者读到一个不是有限数的东西，都给 `null`。 */
function usableSize(size: number | null | undefined): number | null {
  return size === null || size === undefined || !Number.isFinite(size) ? null : size
}

function unknownMessage(wanted: string, presets: readonly StoredPreset[]): string {
  return (
    `没有名为 '${wanted}' 的参数组。当前可用: ` +
    availableNames(presets)
      .map((n) => `'${n}'`)
      .join(', ') +
    '。(用 ListZCtrlPresets 查看每一组的具体数值。)'
  )
}

/**
 * 一个**名字** → 一组数字。解析不出来抛 {@link PresetRejected}。
 *
 * 四路各有自己的真源，**没有一路是新开的存储**：
 *
 * | 名字 | 取自 |
 * |---|---|
 * | `approach` | 仪器档案（用户填） |
 * | `scan` | 按**当前帧宽**选中的那一档（与 `ScanAt` 同源） |
 * | 档名 | 扫描档位表 |
 * | 自定义名 | 参数组存储（模型唯一能写的那一处） |
 *
 * 诱人的设计是建一张「名 → 增益」的表。那会是一份**第二真源**：操作员在档位表里
 * 把 50 n 改成 180 n，下一次扫描却还用旧值。所以这里只解析，不存。
 */
export function resolvePreset(name: unknown, src: PresetSources = {}): ResolvedPreset {
  const presets = src.presets ?? []
  const wanted = String(name ?? '').trim()
  if (!wanted) throw new PresetRejected(unknownMessage('', presets))
  const lowered = wanted.toLowerCase()

  if (lowered === PRESET_APPROACH) return fromProfile(src.approach ?? null)

  if (lowered === PRESET_SCAN) {
    const size = usableSize(src.frameSizeM)
    if (size === null) {
      // **读不到 ≠ 挑一档**。挑错档等于用一组不对的增益扫一整帧。
      throw new PresetRejected(
        '读不到当前扫描帧的尺寸,无法确定该用哪一档扫图参数。' +
          '请直接指定档名(见 ListZCtrlPresets),或先设置扫描范围。',
      )
    }
    const res = fromTier(tierForSize(size), PRESET_SCAN)
    return new ResolvedPreset(res.name, res.pGain, res.iGain, res.setpointA, res.sources, [
      ...res.notes,
      `'scan' 按当前帧宽 ${formatSi(size)}m 选中档位 '${res.name}'`,
    ])
  }

  const tier = tierByName(wanted)
  if (tier !== null) return fromTier(tier, wanted)

  for (const item of presets) {
    if (item.name.toLowerCase() === lowered) return fromCustom(item)
  }

  throw new PresetRejected(unknownMessage(wanted, presets))
}
