/**
 * 温度公共只读口 —— 一个读数，外加「读不到」的**几种不同答案**。
 *
 * 旧仓在这之前只有一个私有取数口，返回 `float | None`，而那个 `None` 同时表示：
 *
 *   - 这台机器根本没装温度计（插什么都不会好）；
 *   - 装了，但此刻读不到（真机上最常见的形态是 COM3 被 `Lakeshore Logger.exe`
 *     独占 —— 关掉那个程序就好了）；
 *   - 有读数，但已经很旧了（还在降温的实验按它判「到温了」就会判错）。
 *
 * 这三件事对**调用方要做什么**的指示完全相反：第一种要立刻拒绝（等下去永远等不到），
 * 第二种要去看端口占用，第三种要再等一拍。把它们折叠成同一个 `null`，
 * 等待条件就会悄悄变成「永远等」——「读不到 ≠ 出故障 ≠ 零 ≠ 干净」。
 *
 * 所以这里给出的是 {@link TempReading}：**值 + 年龄 + 出处 + 通道 + 为什么没有值**。
 *
 * ## 年龄由调用方判陈旧，不由这里判
 *
 * `ageS` 随值一起返回，{@link freshness} 把「多旧算旧」这个**只有调用方知道**的阈值
 * 留给调用方。它返回三态字符串而不是 `boolean`：`boolean | null` 的返回类型
 * 会被 `if (!r.isStale(60))` 一句悄悄把「不知道」当成「新鲜」——那正是要防的错。
 *
 * `ageS` 读不出来时是 `null`，**绝不是 0**。伪造一个 0 秒的年龄会让任何
 * `age <= limit` 的判据无条件通过，把「不知道多旧」变成「刚刚读的」。
 */
import { pyFloat } from './vacuum-interlock.js'

// ── 「没有值」的几种原因 —— 刻意不折叠 ─────────────────────────────────────

/** 这台机器上没有真的温度传感器。**等下去永远等不到**：该拒绝，不该重试。 */
export const NO_SENSOR = 'no_sensor'
/** 有真的传感器，但此刻拿不到读数（串口被占、读失败、缓存空）。**可能会好**。 */
export const UNAVAILABLE = 'unavailable'
/** 有读数但太旧。**本模块永不产出它** —— 多旧算旧只有调用方知道。 */
export const STALE = 'stale'
/** 指名的那个通道这台机器上没有。**不是**「没有温度计」。 */
export const UNKNOWN_CHANNEL = 'unknown_channel'
/** 名字同时对上不止一个通道。也不是「没有」，是「你得说清是哪个」。 */
export const AMBIGUOUS_CHANNEL = 'ambiguous_channel'
/** 宿主**自己这一侧**没接上温度源。与仪器无关，重启/接线才会变。 */
export const NO_SOURCE = 'no_source'

export const TEMPERATURE_REASONS = [
  NO_SENSOR, UNAVAILABLE, STALE, UNKNOWN_CHANNEL, AMBIGUOUS_CHANNEL, NO_SOURCE,
] as const

/** 多个通道都可读时**优先样品台**：磁体杜瓦的温度不等于样品台的温度。 */
const STAGE_HINTS = ['spm', 'stage', 'sample', 'tip', 'cryo'] as const

const KELVIN_UNITS = ['k', 'kelvin'] as const
const CELSIUS_UNITS = ['c', '°c', 'degc', 'celsius'] as const

/**
 * 哪些 status 算「这一拍真的读到了一个数」。
 *
 * `warning` / `alarm` **在内**：它们表示值越过了报警带，不表示读不到。
 * 一台正在从 300 K 降下来的机器降温途中必然长时间落在 warn 带里，
 * 而那恰恰是等降温的实验唯一要看的那个数。
 *
 * `error` / `unavailable` 在外，且必须在外：读失败时上游写的是
 * `value=0.0, unit="", status="error"` —— 把它当读数就是把 **0 K** 记进实验记录。
 */
const LIVE_STATUSES = ['ok', 'warning', 'alarm'] as const

/**
 * `(值, 单位, 状态)` → 开尔文，读不出来就 `null`。
 *
 * **按单位换算，不按传感器名字**：真机上那两个 Lake Shore 通道叫
 * `SPM (COM3)` / `Magnet (COM3)`，名字里一个 `temp` 都没有。
 * 单位不是温度单位时返回 `null` —— 一个 2e-13 A 的电流读数被当成 2e-13 K
 * 记进粗动里程表，比没有温度更糟。
 */
export function toKelvin(value: unknown, unit: string, status = 'ok'): number | null {
  if (!(LIVE_STATUSES as readonly string[]).includes(String(status ?? '').trim().toLowerCase())) {
    return null
  }
  const u = String(unit ?? '').trim().toLowerCase()
  const v = pyFloat(value)
  if (v === null) return null
  if ((KELVIN_UNITS as readonly string[]).includes(u)) return v
  if ((CELSIUS_UNITS as readonly string[]).includes(u)) return v + 273.15
  return null
}

/** 这个单位是温度单位吗（K / °C 的各种写法）。 */
export function isTemperatureUnit(unit: unknown): boolean {
  const u = String(unit ?? '').trim().toLowerCase()
  return (KELVIN_UNITS as readonly string[]).includes(u) ||
    (CELSIUS_UNITS as readonly string[]).includes(u)
}

/**
 * 一个**温度型**通道，按持有传感器对象的那一层分类完之后的样子。
 *
 * `real` 是三态，这很重要：
 *
 *   - `true`  —— 真驱动（Lake Shore 之类）。
 *   - `false` —— 占位实现：这台机器**没有**这个量的驱动，插什么都不会好 ⇒ `no_sensor`。
 *   - `null`  —— **不知道**（拿不到传感器对象，比如只有一份读数快照）。
 *     不知道**不等于**占位：把它当占位会让一台正常报着 77 K 的机器被判成「没装温度计」。
 */
export interface TempChannel {
  readonly name: string
  readonly value?: unknown
  readonly unit?: string
  readonly status?: string
  readonly timestamp?: string
  /** 驱动类名，读数的出处。占位与真驱动今天都报 `unavailable`，只有出处分得开。 */
  readonly driver?: string
  readonly real?: boolean | null
}

export function channelKelvin(c: TempChannel): number | null {
  return toKelvin(c.value, c.unit ?? '', c.status ?? '')
}

/** 技能 `available_channels` 里的那一格（键名照旧仓的蛇形）。 */
export function channelDict(c: TempChannel): Record<string, unknown> {
  return {
    name: c.name,
    unit: c.unit ?? '',
    status: c.status ?? '',
    driver: c.driver ?? '',
    real: c.real ?? null,
    value_k: channelKelvin(c),
  }
}

/**
 * 一次温度查询的完整答案。
 *
 * `valueK === null` 时 `reason` 一定不是 `null`，反之亦然 ——
 * 不存在「没有值也没有原因」的返回。
 */
export interface TempReading {
  /** 开尔文。`null` = 没有值，看 `reason`。 */
  readonly valueK: number | null
  /** 这个读数有多旧（秒）。`null` = **不知道多旧**，不是 0。 */
  readonly ageS: number | null
  /** 出处（驱动类名）。没有值时是 `''` —— 没人给出过读数。 */
  readonly source: string
  /** 落到哪个通道上。指名了但对不上时，回显的是**你要的那个名字**。 */
  readonly channel: string
  /** 为什么没有值。有值时是 `null`。 */
  readonly reason: string | null
}

function reading(p: Partial<TempReading>): TempReading {
  return {
    valueK: p.valueK ?? null,
    ageS: p.ageS ?? null,
    source: p.source ?? '',
    channel: p.channel ?? '',
    reason: p.reason ?? null,
  }
}

/**
 * `"fresh"` / `"stale"` / `"unknown"` —— **三态，不是 bool**。
 *
 * `boolean` 会被 `if (!stale)` 一句把「不知道多旧」变成「新鲜」，而
 * 「不知道」恰恰是最该停下来的那种答案。
 */
export function freshness(r: TempReading, maxAgeS: unknown): string {
  const age = knownAge(r)
  if (r.valueK === null || age === null) return 'unknown'
  const limit = pyFloat(maxAgeS)
  if (limit === null) return 'unknown'
  return age > limit ? 'stale' : 'fresh'
}

/**
 * 这个读数的年龄，**只在真知道的时候**给一个数。
 *
 * 单拎出来是因为这一步最容易被「顺手补个默认值」抹掉：一个 0 会让
 * `age <= limit` 无条件成立，把「不知道多旧」变成「刚刚读的」——
 * 而那正是 `bool` 三态化要防的同一件事，只是发生在更上游。
 */
function knownAge(r: TempReading): number | null {
  return r.ageS
}

/** 技能 `data` 的那份形状（键名照旧仓的蛇形）。 */
export function readingDict(r: TempReading): Record<string, unknown> {
  return {
    value_k: r.valueK,
    age_s: r.ageS,
    source: r.source,
    channel: r.channel,
    reason: r.reason,
  }
}

/**
 * ISO 时间戳 → 距 `nowS` 多少秒。解析不出来就 `null`（**不是 0**）。
 *
 * 不夹到 0：一个**负**的年龄是「这台机器的钟不对」，那件事值得看见。
 */
export function ageS(timestamp: unknown, nowS: number): number | null {
  const ts = String(timestamp ?? '').trim()
  if (ts === '') return null
  // 只有日期没有时刻时 JS 按 **UTC** 解、Python 按**本地**解。补上 `T00:00:00`
  // 让两边都走「本地朴素时间」那一支。
  const norm = /^\d{4}-\d{2}-\d{2}$/.test(ts) ? `${ts}T00:00:00` : ts
  const t = Date.parse(norm)
  if (Number.isNaN(t)) return null
  return nowS - t / 1000
}

function preferStage(cands: readonly TempChannel[]): TempChannel {
  for (const c of cands) {
    const low = c.name.toLowerCase()
    if (STAGE_HINTS.some((h) => low.includes(h))) return c
  }
  return cands[0] as TempChannel
}

export interface MatchResult {
  readonly hit: TempChannel | null
  readonly why: string | null
}

/**
 * `(命中, 落空原因)`。名字先精确、再忽略大小写、最后**唯一**子串。
 *
 * 子串这一档是为真机准备的：配置里写 `SPM`，而监控里那个通道叫 `SPM (COM3)`。
 * 但只在**唯一**命中时才认 —— 对上两个就说「你得说清是哪个」，
 * 而不是悄悄挑一个（挑错的那半时间没人会发现）。
 */
export function matchChannel(chans: readonly TempChannel[], requested: string): MatchResult {
  const req = requested.trim()
  const preds: ((c: TempChannel) => boolean)[] = [
    (c) => c.name === req,
    (c) => c.name.toLowerCase() === req.toLowerCase(),
  ]
  for (const pred of preds) {
    const hits = chans.filter(pred)
    if (hits.length === 1) return { hit: hits[0] as TempChannel, why: null }
    if (hits.length > 1) return { hit: null, why: AMBIGUOUS_CHANNEL }
  }
  const fold = req.toLowerCase()
  const subHits = chans.filter((c) => c.name.toLowerCase().includes(fold))
  if (subHits.length === 1) return { hit: subHits[0] as TempChannel, why: null }
  if (subHits.length > 1) return { hit: null, why: AMBIGUOUS_CHANNEL }
  return { hit: null, why: UNKNOWN_CHANNEL }
}

function readOne(c: TempChannel, nowS: number): TempReading {
  const k = channelKelvin(c)
  const age = ageS(c.timestamp, nowS)
  if (k === null) {
    return reading({
      valueK: null,
      ageS: age,
      source: '',
      channel: c.name,
      // `real === false` 才是占位；`null`（不知道）走 unavailable ——
      // 把「不知道」当占位，会让一台正常报着 77 K 的机器被判成「没装温度计」。
      reason: c.real === false ? NO_SENSOR : UNAVAILABLE,
    })
  }
  return reading({ valueK: k, ageS: age, source: c.driver ?? '', channel: c.name, reason: null })
}

/**
 * 从一组温度通道里给出一个答案。纯函数、永不抛。
 *
 * 没指名时：占位通道不参选 → 可读的优先 → 可读的里面样品台优先。
 * 一个都读不到时**仍然回报那个本该用的通道名和它的年龄**，
 * 因为「哪个温度计哑了」才是用户能动手的那条信息。
 */
export function readTemperature(
  channels: readonly TempChannel[] | null | undefined,
  opts: { readonly channel?: string | null; readonly nowS: number },
): TempReading {
  const chans = (channels ?? []).filter(
    (c): c is TempChannel => c !== null && typeof c === 'object' && typeof c.name === 'string',
  )
  const req = String(opts.channel ?? '').trim()

  if (chans.length === 0) {
    // 一个温度通道都没有。此时即使指名了也该说「没有温度计」，
    // 而不是「没有这个通道」—— 后者会让人去找一个不存在的配置项。
    return reading({ channel: req, reason: NO_SENSOR })
  }

  if (req !== '') {
    const { hit, why } = matchChannel(chans, req)
    if (hit === null) return reading({ channel: req, reason: why })
    return readOne(hit, opts.nowS)
  }

  const candidates = chans.filter((c) => (c.real ?? null) !== false)
  if (candidates.length === 0) {
    // 全是占位实现：这台机器没有温度计驱动，等下去永远等不到。
    return reading({ channel: '', reason: NO_SENSOR })
  }

  const readable = candidates.filter((c) => channelKelvin(c) !== null)
  return readOne(preferStage(readable.length > 0 ? readable : candidates), opts.nowS)
}

// ── 进程级注入口（技能层从这里取数，不 import 活的 app 对象）────────────────

export const processTemperature: {
  source: ((channel: string | null) => TempReading) | null
  channelsSource: (() => readonly TempChannel[] | null) | null
} = { source: null, channelsSource: null }

function isTempReading(x: unknown): x is TempReading {
  return (
    x !== null && typeof x === 'object' &&
    'valueK' in x && 'ageS' in x && 'source' in x && 'channel' in x && 'reason' in x
  )
}

/**
 * 当前温度。**永不抛** —— 没接上/源出错/源回了别的东西都回 `no_source`。
 *
 * `no_source` 与 `unavailable` 分开：前者说的是宿主自己没接上（重启、换进程才会变），
 * 后者说的是仪器此刻不给数（关掉占端口的程序就好）。
 */
export function latestTemperature(channel?: string | null): TempReading {
  const src = processTemperature.source
  const echo = String(channel ?? '')
  if (src === null) return reading({ channel: echo, reason: NO_SOURCE })
  let out: unknown
  try {
    out = src(channel ?? null)
  } catch {
    // 问一句温度绝不该把调用方搞崩。
    return reading({ channel: echo, reason: NO_SOURCE })
  }
  if (!isTempReading(out)) return reading({ channel: echo, reason: NO_SOURCE })
  return out
}

/**
 * 这台机器上的温度通道；`null` = **问不到**（没接上/源出错）。
 *
 * `null` 和 `[]` 刻意不同：`[]` 是「确实一个都没有」，`null` 是「不知道有没有」。
 */
export function temperatureChannels(): TempChannel[] | null {
  const src = processTemperature.channelsSource
  if (src === null) return null
  let out: readonly TempChannel[] | null
  try {
    out = src()
  } catch {
    return null
  }
  if (out === null || out === undefined) return null
  return out.filter(
    (c): c is TempChannel => c !== null && typeof c === 'object' && typeof c.name === 'string',
  )
}
