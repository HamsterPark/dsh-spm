/**
 * 扫完一帧之后判撞针。
 *
 * 判据只有两条，而且都很钝：**方差接近零**，或者**出现 NaN**。钝是对的——
 * 撞针之后的帧不是「有点怪」，是**没有信号了**：针尖压进样品，Z 环把一切压平，
 * 整帧变成一个常数或者一片 NaN。要检测的是这个，不是图像质量。
 *
 * ## 三态，不是两态
 *
 * `status ∈ {ok, crash, skipped}`。**一路都没读到就是 `skipped`，永远不是 `ok`。**
 * 「我没发现撞针」和「我没能看」是两句话，而下游会拿它来决定要不要接着扫。
 *
 * ## 为什么默认要探两路
 *
 * 默认 `0,14` = 形貌 + Z-controller 信号。**撞针会把 Z 压平，哪怕通道 0
 * 看起来还说得过去**——只看一路的话，一次真撞针可以完全不露头。
 */

/** 全帧极差小于它就算「没有信号」。 */
export const CRASH_RANGE_EPS = 1e-25

/** 默认探的两路：形貌 + Z-controller。 */
export const DEFAULT_CRASH_CHANNELS: readonly number[] = [0, 14]

/**
 * 解析逗号（或分号）分隔的通道号。
 *
 * **认不出的记号跳过，不是整趟失败**：一串里夹了个错字，不该让这次撞针检测
 * 不做——而剩下那几路照样能回答问题。全都认不出就回落到默认两路。
 */
export function parseChannels(raw: unknown): number[] {
  const out: number[] = []
  for (const tok of String(raw ?? '').replaceAll(';', ',').split(',')) {
    const t = tok.trim()
    if (!t) continue
    // 与 Python 的 `int(tok)` 同判据：**只收整数字面量**（`'1.5'` / `'x'` 都不收）
    if (!/^[+-]?\d+$/.test(t)) continue
    out.push(Number(t))
  }
  return out.length > 0 ? out : [...DEFAULT_CRASH_CHANNELS]
}

/** 一路通道的判语。 */
export type ChannelVerdict = 'ok' | 'crash' | 'no_data' | 'error'

/** 一路的采样（已拉平）。`null` = 这一路没读到。 */
export interface ChannelSamples {
  readonly channel: number
  readonly samples: readonly number[] | null
  /** 读这一路时抛了异常（而不是「读回来没数据」）。 */
  readonly threw?: boolean
}

export interface CrashVerdict {
  readonly crashIndicator: boolean
  readonly status: 'ok' | 'crash' | 'skipped'
  readonly perChannel: Readonly<Record<string, ChannelVerdict>>
  /** 第一路判成撞针的通道名（`ch0`），没有就 `null`。 */
  readonly crashChannel: string | null
  /** **那一路**的极差，没有就 `null`。 */
  readonly dataRange: number | null
}

/**
 * 极差（max − min），同 `np.ptp`。
 *
 * **空数组给 `null`**（没有采样就算不出极差）；**全是 NaN 给 `NaN`**——
 * 后者不能给 `null`：一整帧 NaN 正是撞针最典型的样子，把它归进「没读到」
 * 会让最该报警的那一帧变成最安静的那一帧。
 */
function ptp(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  let lo = Infinity
  let hi = -Infinity
  for (const x of xs) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : Number.NaN
}

/**
 * 把几路采样判成一个结论。
 *
 * **一路坏掉不能带走整趟探测**：调用方把每一路的读法与失败都装在
 * {@link ChannelSamples} 里交进来，这里只判。
 */
export function crashVerdict(channels: readonly ChannelSamples[]): CrashVerdict {
  const perChannel: Record<string, ChannelVerdict> = {}
  let readableAny = false
  let crash = false
  let crashChannel: string | null = null
  let dataRange: number | null = null

  for (const c of channels) {
    const label = `ch${c.channel}`
    if (c.threw === true) {
      perChannel[label] = 'error'
      continue
    }
    if (c.samples === null) {
      perChannel[label] = 'no_data'
      continue
    }
    const range = ptp(c.samples)
    if (range === null) {
      // 一条空采样算不出极差。**这不是「没撞」**——它和读不到是同一类。
      perChannel[label] = 'no_data'
      continue
    }
    readableAny = true
    // NaN 先判：`NaN < eps` 为假，光看极差会把一整帧 NaN 放过去。
    const hasNan = c.samples.some((v) => Number.isNaN(v))
    if (hasNan || range < CRASH_RANGE_EPS) {
      perChannel[label] = 'crash'
      if (!crash) {
        crash = true
        crashChannel = label
        dataRange = range
      }
    } else {
      perChannel[label] = 'ok'
    }
  }

  return { crashIndicator: crash, status: statusOf(crash, readableAny), perChannel, crashChannel, dataRange }
}

/**
 * **一路都没读到 ⇒ `skipped`，不是 `ok`。**「没发现撞针」与「没能看」是两句话。
 *
 * 提成函数而不是写在一个三元里，是为了让这道闸**拆得开**：写在原地的话，
 * 把 `readableAny` 那一支去掉会让它变成未使用的变量、`tsc` 报错，
 * 而一条编不过的变异什么都没验（本仓的老问题）。
 */
function statusOf(crash: boolean, readableAny: boolean): CrashVerdict['status'] {
  return crash ? 'crash' : readableAny ? 'ok' : 'skipped'
}
