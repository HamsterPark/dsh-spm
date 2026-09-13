/**
 * 数据记录（DataLog / TCPLog）与扫描帧上的标记 —— 两个小模块。
 *
 * 它们是**留痕**类的技能：把「在哪儿做过什么」记在仪器自己的界面与文件里，
 * 于是操作员在 Nanonis 上看到的东西和我们记录里的对得上。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const s = (p: Readonly<Record<string, unknown>>, k: string, dflt = ''): string => {
  const v = p[k]
  return typeof v === 'string' && v !== '' ? v : dflt
}

/**
 * `'0, 2, 14'` → `[0, 2, 14]`。**严格**：有一个记号不是整数，整串作废（给 `null`）。
 *
 * 与 `crash-check.ts` 的 `parseChannels` 刻意不同——那边是「少探一路无所谓」，
 * 这边是「记的是哪几路」：默默丢掉一路，会让日志里少一个通道而没人知道。
 */
export function logChannels(raw: unknown): number[] | null {
  const toks = String(raw ?? '').replaceAll(',', ' ').split(/\s+/).filter((t) => t !== '')
  const out: number[] = []
  for (const t of toks) {
    if (!/^[+-]?\d+$/.test(t)) return null
    out.push(Number(t))
  }
  return out.length > 0 ? out : null
}

/** Python 的 `{x!r}`（这里只可能是字符串）。 */
const repr = (v: unknown): string => `'${String(v ?? '')}'`

// ── DataLog：记到 Nanonis 机器上的文件 ─────────────────────────────────────

const MODE_CONTINUOUS = 1
const MODE_TIMED = 2

export const StartDataLog: Skill = {
  spec: S.StartDataLogSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const chs = logChannels(params['channels'])
    if (chs === null) {
      return fail(`channels 解析失败：${repr(params['channels'])}（应为逗号分隔的索引）`)
    }
    const total = n(params, 'duration_s', 0)
    const avg = n(params, 'averaging', 1) || 1
    const base = s(params, 'basename', 'mast_log')
    const comment = s(params, 'comment', '')

    let rec = await ctx.safeCall('DataLog_Open')
    if (failed(rec)) return fail(`DataLog_Open failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('DataLog_ChsSet', chs)
    if (failed(rec)) return fail(`DataLog_ChsSet failed: ${rec.error ?? ''}`)

    const hours = Math.trunc(total / 3600)
    const minutes = Math.trunc((total % 3600) / 60)
    const seconds = total % 60
    // **给了时长就是定时，没给就是连续** —— 两者在仪器上是不同的模式，
    // 而一次「本来该定时、实际在连续记」的日志会一直写到磁盘满。
    const mode = total > 0 ? MODE_TIMED : MODE_CONTINUOUS
    rec = await ctx.safeCall(
      'DataLog_PropsSet', mode, hours, minutes, seconds, avg, base, comment, 0, [],
    )
    if (failed(rec)) return fail(`DataLog_PropsSet failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('DataLog_Start')
    if (failed(rec)) return fail(`DataLog_Start failed: ${rec.error ?? ''}`)

    return ok({
      channels: chs,
      duration_s: total,
      averaging: avg,
      basename: base,
      mode: total > 0 ? 'timed' : 'continuous',
    })
  },
}

export const StopDataLog: Skill = {
  spec: S.StopDataLogSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('DataLog_Stop')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ stopped: true })
  },
}

/**
 * 三份读一起交出去。
 *
 * **只有状态那一读失败才算整趟失败**：通道表与属性读不到时给空表 ——
 * 「在不在记」是这个技能要回答的问题，另外两样是补充。
 */
export const GetDataLogStatus: Skill = {
  spec: S.GetDataLogStatusSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const st = await ctx.safeCall('DataLog_StatusGet')
    const chs = await ctx.safeCall('DataLog_ChsGet')
    const props = await ctx.safeCall('DataLog_PropsGet')
    if (failed(st)) return fail(st.error ?? '')
    return ok({
      status: [...body(st)],
      channels: failed(chs) ? [] : [...body(chs)],
      props: failed(props) ? [] : [...body(props)],
    })
  },
}

// ── TCPLog：把通道推到一条 TCP 流上 ────────────────────────────────────────

export const StartTcpLog: Skill = {
  spec: S.StartTcpLogSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const chs = logChannels(params['channels'])
    if (chs === null) return fail(`channels 解析失败：${repr(params['channels'])}`)
    const over = n(params, 'oversampling', 10) || 10

    let rec = await ctx.safeCall('TCPLog_ChsSet', chs.length, chs)
    if (failed(rec)) return fail(`TCPLog_ChsSet failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('TCPLog_OversamplSet', over)
    if (failed(rec)) return fail(`TCPLog_OversamplSet failed: ${rec.error ?? ''}`)

    rec = await ctx.safeCall('TCPLog_Start')
    if (failed(rec)) return fail(`TCPLog_Start failed: ${rec.error ?? ''}`)

    return ok({ channels: chs, oversampling: over })
  },
}

export const StopTcpLog: Skill = {
  spec: S.StopTcpLogSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('TCPLog_Stop')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ stopped: true })
  },
}

export const GetTcpLogStatus: Skill = {
  spec: S.GetTcpLogStatusSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('TCPLog_StatusGet')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ status: [...body(rec)] })
  },
}

// ── 扫描帧上的标记 ─────────────────────────────────────────────────────────

/** 颜色名 → `0xRRGGBB`。认不出就按红色——标记的颜色不值得让一次留痕失败。 */
const COLORS: Readonly<Record<string, number>> = {
  red: 0xff0000,
  green: 0x00ff00,
  blue: 0x0000ff,
  yellow: 0xffff00,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  white: 0xffffff,
  black: 0x000000,
}

export function markerColor(name: unknown): number {
  const key = String(name ?? 'red').trim().toLowerCase()
  if (key in COLORS) return COLORS[key] as number
  // 也认裸的 `0xRRGGBB` / 十进制
  const raw = String(name ?? '').trim()
  const v = /^0[xX][0-9a-fA-F]+$/.test(raw) ? Number.parseInt(raw, 16) : Number(raw)
  return Number.isFinite(v) && raw !== '' ? v : (COLORS['red'] as number)
}

const KIND_ERROR = (kind: string): string => `kind 必须是 'point' 或 'line'，收到 '${kind}'`

export const DrawScanMarker: Skill = {
  spec: S.DrawScanMarkerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const kind = String(params['kind'] ?? '').trim().toLowerCase()
    const x = n(params, 'x_m')
    const y = n(params, 'y_m')
    const col = markerColor(params['color'] ?? 'red')

    if (kind === 'line') {
      if (!(typeof params['x2_m'] === 'number') || !(typeof params['y2_m'] === 'number')) {
        return fail("kind='line' 需要 x2_m 与 y2_m（线的终点）")
      }
      const x2 = n(params, 'x2_m')
      const y2 = n(params, 'y2_m')
      const rec = await ctx.safeCall('Marks_LineDraw', x, y, x2, y2, col)
      if (failed(rec)) return fail(rec.error ?? '')
      return ok({ kind: 'line', start: [x, y], end: [x2, y2] })
    }
    if (kind !== 'point') return fail(KIND_ERROR(kind))

    const text = typeof params['text'] === 'string' ? params['text'] : ''
    const rec = await ctx.safeCall('Marks_PointDraw', x, y, text, col)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ kind: 'point', x_m: x, y_m: y, text })
  },
}

/**
 * 擦掉或**只是藏起来**一个标记。
 *
 * 动词写成字面量的四个分支，不走表驱动——同 `reads-config.ts` 抬头那条。
 */
export const EraseScanMarkers: Skill = {
  spec: S.EraseScanMarkersSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const kind = String(params['kind'] ?? '').trim().toLowerCase()
    const index = n(params, 'index')
    const hide = params['hide_only'] === true
    if (kind !== 'point' && kind !== 'line') return fail(KIND_ERROR(kind))

    const rec =
      hide && kind === 'point'
        ? await ctx.safeCall('Marks_PointsVisibleSet', index, 0) // 0 = 藏
        : hide
          ? await ctx.safeCall('Marks_LinesVisibleSet', index, 0)
          : kind === 'point'
            ? await ctx.safeCall('Marks_PointsErase', index)
            : await ctx.safeCall('Marks_LinesErase', index)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ kind, index, action: hide ? 'hidden' : 'erased' })
  },
}

/** 两份读**都**失败才算整趟失败——只有一种标记读不到时，另一种照样交出去。 */
export const ListScanMarkers: Skill = {
  spec: S.ListScanMarkersSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const pts = await ctx.safeCall('Marks_PointsGet')
    const lns = await ctx.safeCall('Marks_LinesGet')
    if (failed(pts) && failed(lns)) return fail(pts.error !== '' ? pts.error ?? '' : lns.error ?? '')
    return ok({
      points: failed(pts) ? [] : [...body(pts)],
      lines: failed(lns) ? [] : [...body(lns)],
    })
  },
}

export const DATALOG_MARKS: Readonly<Record<string, Skill>> = {
  StartDataLog,
  StopDataLog,
  GetDataLogStatus,
  StartTcpLog,
  StopTcpLog,
  GetTcpLogStatus,
  DrawScanMarker,
  EraseScanMarkers,
  ListScanMarkers,
}
