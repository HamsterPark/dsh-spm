/**
 * `AssessAtomicLines` —— 扫描**进行中**的线级原子分辨建议。
 *
 * 用户的手法（2026-08-21 演示 + 真机复现）是边扫边扰动偏压，然后
 *
 * > 每做两下就停下来看扫描线，如此循环，直到扫描线出现规则的跳动
 *
 * 这个技能是「看看扫描线」那一步的机器版：**不停扫**，抓一次帧缓冲，只给**已经
 * 扫出来的行**打分。回合从「重扫一整帧」的 6.6 分钟降到几十秒。
 *
 * ## 两个必须由本技能自己去问、不许由调用方猜的数
 *
 * 1. **Z 通道的信号索引**：`Scan_FrameDataGrab` 的通道参数要的是**信号索引**
 *    （本机 `Scan_BufferGet` 回 `[0, 30]`），不是缓冲位。问一个不在缓冲里的通道
 *    会得到一个对不齐的回包，报出来是 `response layout mismatch` —— 那句话会把人
 *    送去查解析器，而错的是通道号。所以这里先读缓冲，读不到就**拒绝并说清缓冲里
 *    有哪些**，不去猜一个 30。
 * 2. **nm/px**：由 `Scan_FrameGet` 的视野除以缓冲的像素数得出。写死或者由调用方
 *    传一个「应该是多少」，就会在别人改了视野之后安静地按错的尺度找周期。
 *
 * ## `resolveReadout` 只有一份
 *
 * 旧仓把它提到 `_scan_readout.py`，理由写在那个文件的抬头：「两个技能各写一份的
 * 下场是两边迟早只有一边对」。本仓同样只有一份，就在下面。
 */
import {
  channelIdsFromBuffer,
  parseBufferGet,
  parseFrameGrab,

  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { matOf, type Mat } from 'dsh-spm-numerics'
import { frameLineAdvisory, usableRows } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'

/** `Signals_NamesGet` 里 Z 与电流的写法（小写比对）。 */
export const Z_NAME_HINTS: readonly string[] = ['z (m)', 'z(m)', 'z']

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/** 一次「看现在扫到哪儿了」需要的全部上下文。`why` 非空即表示解不出来。 */
export interface ScanReadout {
  zIndex: number | null
  nmPerPx: number | null
  pixels: number | null
  lines: number | null
  channels: number[]
  widthM: number | null
  zSource: string
  why: string
}

function emptyReadout(): ScanReadout {
  return {
    zIndex: null,
    nmPerPx: null,
    pixels: null,
    lines: null,
    channels: [],
    widthM: null,
    zSource: '',
    why: '',
  }
}

/** `as_dict()` —— 解不出来时也要交出可核对的证据，不是一个空 dict。 */
export function readoutDict(r: ScanReadout): Record<string, unknown> {
  return {
    channel_index: r.zIndex,
    channel_source: r.zSource,
    nm_per_px: r.nmPerPx,
    pixels: r.pixels,
    lines: r.lines,
    scan_channels: [...r.channels],
    frame_width_m: r.widthM,
  }
}

/**
 * 去问仪器：Z 的信号索引、像素数、视野 → nm/px。
 *
 * 读不到就把 `why` 填上并返回 —— **不猜一个 30，也不猜一个 5 nm**。
 *
 * ## ⚠️ D-ATOMLINE-1：信号名那条路在旧仓是**死的**，本仓把它接活
 *
 * 旧仓的 `first_values(rec)` 取的是三段信封的第三段，也就是**整个 body**
 * （`Signals_NamesGet` 的 body 是 `[size, declared_n, names]`），然后拿它当名字表
 * 去遍历 —— 于是 `flat` 是 `['4', '2', 'current (a)']` 这样的三个串，
 * 而 `flat[c]`（c 是 0 / 30 这种**信号索引**）几乎不可能命中 `Z_NAME_HINTS`。
 * 结果永远落到兜底那一支「缓冲里非电流的那一路」。
 *
 * 兜底本身是诚实的（它**说自己是兜底**），但它在缓冲里有第三路时会挑错：
 * `[0(Current), 5(Bias), 30(Z)]` ⇒ 兜底给 **5**，而本模块的抬头明写
 * 「必须读 Z：Z 的线级 SNR 中位 211–225，电流只有 52–82」。
 *
 * ⇒ 本仓按 `body[2]` 取名字表（与 `ListSignalChannels` 同一条口径），
 * 于是那一支真的能命中。**这是本批唯一一处刻意改了旧仓行为的解析**，
 * 登记在 `spec/deviations.md`。
 */
export async function resolveReadout(
  ctx: SkillContext,
  calls: SkillCallRecord[],
  forcedChannel = -1,
): Promise<ScanReadout> {
  const out = emptyReadout()

  const recBuf = await ctx.safeCall('Scan_BufferGet')
  calls.push(recBuf)
  if (failed(recBuf)) {
    out.why = `读不到扫描缓冲：${recBuf.error ?? ''}`
    return out
  }
  const body = recBuf.values ?? null
  const buf = parseBufferGet(body)
  // ⚠️ 提成一个**有声明返回类型**的调用，而不是内联的 `if (buf === null || …)`：
  // 把那道闸改成 `if (false)` 会让 TS 判它不可达、连带撤掉 `buf` 的非空收窄，
  // 于是变异编不过 —— 而「一条编不过的变异，那道闸就永远验不到」。
  const ids: number[] | null = readableChannels(buf, body)
  if (ids === null) {
    out.why = `扫描缓冲的回包读不懂 —— 不去猜通道号。原始回包：${JSON.stringify(body).slice(0, 200)}`
    return out
  }
  out.channels = ids
  out.pixels = buf?.pixels ?? null
  out.lines = buf?.lines ?? null

  if (forcedChannel >= 0) {
    out.zIndex = Math.trunc(forcedChannel)
    out.zSource = '参数指定'
  } else {
    const recNames = await ctx.safeCall('Signals_NamesGet')
    calls.push(recNames)
    const names = signalNames(recNames)
    if (names !== null) {
      const flat = names.map((n) => String(n).trim().toLowerCase())
      for (const c of out.channels) {
        const nm = c >= 0 && c < flat.length ? (flat[c] as string) : null
        if (nm !== null && Z_NAME_HINTS.includes(nm)) {
          out.zIndex = c
          out.zSource = '按信号名 Z 解出'
          break
        }
      }
    }
    if (out.zIndex === null) {
      // 兜底：缓冲里**不是**电流的那一路。会在结果里说明是兜底来的 ——
      // 一个不说自己是兜底的兜底值，正是最难发现的那种错。
      const nonCur = out.channels.filter((c) => c !== 0)
      if (nonCur.length > 0) {
        out.zIndex = nonCur[0] as number
        out.zSource = '兜底：缓冲里非电流的那一路'
      }
    }
  }
  if (out.zIndex === null) {
    out.why =
      `扫描缓冲里找不到 Z 通道，缓冲里只有 [${out.channels.join(', ')}]。` +
      '把 Z 加进扫描通道，或者显式指定通道号。'
    return out
  }

  const recFr = await ctx.safeCall('Scan_FrameGet')
  calls.push(recFr)
  const vals = recFr.values ?? null
  if (!failed(recFr) && Array.isArray(vals) && vals.length >= 3) {
    const w = Number(vals[2])
    out.widthM = Number.isFinite(w) ? w : null
  }
  // 同上：一个**有声明返回类型**的算子，好让「猜一个尺度」那条变异编得过。
  const scale: number | null = nmPerPixel(out.widthM, out.pixels)
  if (scale === null) {
    out.why =
      `算不出 nm/px：视野 ${fmtNone(out.widthM)}、像素 ${fmtNone(out.pixels)} —— 宁可拒绝，` +
      '也不按一个猜的尺度做判读。'
    return out
  }
  out.nmPerPx = scale
  return out
}

/** 缓冲里的通道号。读不懂（或一个都没有）给 `null` —— **不猜**。 */
function readableChannels(buf: ReturnType<typeof parseBufferGet>, body: unknown): number[] | null {
  const ids = buf === null ? channelIdsFromBuffer(body) : buf.channelIndexes
  return buf === null || ids.length === 0 ? null : ids
}

/** 视野 ÷ 像素数。任一读不到给 `null` —— **不猜一个 5 nm**。 */
function nmPerPixel(widthM: number | null, pixels: number | null): number | null {
  if (widthM === null || widthM === 0 || pixels === null || pixels === 0) return null
  return (widthM * 1e9) / pixels
}

/** Python 的 `"%s" % None` 是 `'None'`。 */
function fmtNone(x: number | null): string {
  return x === null ? 'None' : String(x)
}

/** `Signals_NamesGet` 的 body → 名字表（`body[2]`）。读不懂给 `null`。见 D-ATOMLINE-1。 */
function signalNames(rec: SkillCallRecord): string[] | null {
  if (failed(rec)) return null
  const body = rec.values
  if (!Array.isArray(body) || body.length < 3) return null
  const raw = body[2]
  if (!Array.isArray(raw)) return null
  return raw.map((n) => (Array.isArray(n) && n.length > 0 ? String(n[0]) : String(n)))
}

/** 抓一次帧缓冲（不停扫）。回 `[图或 null, why]`。 */
export async function grabFrame(
  ctx: SkillContext,
  channelIndex: number,
  direction: number,
  calls: SkillCallRecord[],
): Promise<[Mat | null, string]> {
  const rec = await ctx.safeCall('Scan_FrameDataGrab', Math.trunc(channelIndex), Math.trunc(direction))
  calls.push(rec)
  if (failed(rec)) return [null, rec.error ?? '']
  const arr = parseFrameGrab(rec.values ?? null, true)
  if (arr === null || !Array.isArray(arr[0])) return [null, '回包读不懂']
  const rows = arr as number[][]
  const ny = rows.length
  const nx = (rows[0] as number[]).length
  const data = new Float64Array(ny * nx)
  for (let r = 0; r < ny; r += 1) {
    const row = rows[r] as number[]
    for (let c = 0; c < nx; c += 1) data[r * nx + c] = row[c] as number
  }
  return [matOf(ny, nx, data), '']
}

export const AssessAtomicLines: Skill = {
  spec: S.AssessAtomicLinesSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const direction = typeof params['direction'] === 'number' ? Math.trunc(params['direction']) : 1
    const nRecentRaw = typeof params['n_recent_lines'] === 'number' ? Math.trunc(params['n_recent_lines']) : 0
    const nRecent = Number.isFinite(nRecentRaw) ? nRecentRaw : 0
    const advSnr = typeof params['advisory_snr'] === 'number' ? params['advisory_snr'] : 80.0
    const forced = typeof params['channel_index'] === 'number' ? Math.trunc(params['channel_index']) : -1

    const calls: SkillCallRecord[] = []
    // 解通道与尺度只有一份实现 —— 两个技能各写一份的下场是两边迟早只有一边对。
    const ro = await resolveReadout(ctx, calls, forced)
    if (ro.why !== '' || ro.zIndex === null || ro.nmPerPx === null) {
      return { success: false, error: ro.why, data: readoutDict(ro) }
    }
    const ch = ro.zIndex
    const nmPerPx = ro.nmPerPx
    const chans = ro.channels

    const [img, why] = await grabFrame(ctx, ch, direction, calls)
    if (img === null) {
      return {
        success: false,
        error:
          `取不到通道 ${ch} 的帧：${why}` +
          (chans.length > 0
            ? `　（扫描缓冲里的通道是 [${chans.join(', ')}] —— 这个参数要的是**信号索引**，不是缓冲位）`
            : ''),
      }
    }

    const filled = usableRows(img)
    let rows = filled
    if (nRecent > 0) {
      const idx: number[] = []
      for (let i = 0; i < filled.length; i += 1) if (filled[i] === 1) idx.push(i)
      if (idx.length > 0) {
        // 扫描方向决定新行在哪一头，所以两头都不假设：取**紧邻未扫区**的那 n 行。
        // 未扫区在低号一侧（`direction="up"`）时是 idx 的前 n 个。
        const unscannedLow = (filled[0] ?? 0) === 0
        const take = unscannedLow ? idx.slice(0, nRecent) : idx.slice(Math.max(0, idx.length - nRecent))
        rows = new Uint8Array(filled.length)
        for (const i of take) rows[i] = 1
      }
    }

    const out: Record<string, unknown> = {
      ...frameLineAdvisory(img, nmPerPx, { rows, advisorySnr: advSnr }),
      channel_index: ch,
      channel_source: ro.zSource,
      direction,
      nm_per_px: nmPerPx,
      n_rows_filled: Array.from(filled).reduce<number>((a, b) => a + b, 0),
      n_rows_total: img.rows,
    }
    if (out['ok'] !== true) {
      return {
        success: false,
        error: (out['why'] as string | undefined) ?? '线级判读没算出结果',
        data: out,
      }
    }
    return { success: true, data: out, summary: out['advisory'] as string }
  },
}

/** 这一族的登记表（就一个）。 */
export const ANALYSIS_LINES: Readonly<Record<string, Skill>> = { AssessAtomicLines }



