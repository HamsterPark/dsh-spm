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

/**
 * 一组自定义参数的**来历行**——每个数字都说清自己从哪儿来。
 *
 * 操作员得能在不读代码的情况下回答「这个环为什么是**这个**值」，而一个没有来历的
 * 数字没人核得动。
 *
 * 只覆盖**自定义组**这一路：保留名 `approach`（仪器档案）、`scan` 与档名（扫描
 * 档位表）的解析要连 `ApplyZCtrlPreset` 一起落，见 `spec/deviations.md` D-PRESET-1。
 * 这里不写那三条分支，是因为本仓现在没有任何调用方会走到它们——而它们各自的
 * 「去哪儿改」报文写错了比没有更坏。
 *
 * `time_constant_s` **是算出来的**：Nanonis 吃 (P, T, I) 而 T = P / I。把 T 也存下来
 * 只会让它和定义它的那一对漂移开。
 */
export function presetTraceLines(item: StoredPreset): string[] {
  const p = parseSi(item.p_gain, 'p_gain')
  const i = parseSi(item.i_gain, 'i_gain')
  const origin = `自定义参数组 '${item.name}'`
  const rows = [
    `p_gain = ${formatSi(p)}m ← ${origin}`,
    `i_gain = ${formatSi(i)}m/s ← ${origin}`,
    `time_constant_s = ${formatSi(p / i)}s ← 由 P/I 导出`,
  ]
  const sp = item.setpoint_a
  rows.push(
    sp === undefined || sp === ''
      ? 'setpoint_a = 未配置(保持当前值,不下发)'
      : `setpoint_a = ${formatSi(parseSi(sp, 'setpoint_a'))}A ← ${origin}`,
  )
  return rows
}
