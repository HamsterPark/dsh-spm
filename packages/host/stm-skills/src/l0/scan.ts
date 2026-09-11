/**
 * 批 3a 扫描主链里的两个简单件：`SetScanSpeed` 与 `SaveScan`。
 *
 * 带判据的那几个各有自己的文件：`configure-scan.ts`（三道拒绝）、
 * `start-scan.ts`（continuous 闸）、`composite/wait-scan-complete.ts`（六种结局）。
 */
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { bool, fail, ok } from './common.js'
import { lastString } from './reads-hw.js'

const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number => {
  const v = p[k]
  return typeof v === 'number' ? v : dflt
}

/**
 * `SetScanSpeed` —— **显式**控制扫描速度的那一个。
 *
 * 它存在的理由在 `ConfigureScan` 那边：后者从前**每次调用都悄悄**把速度覆盖成
 * `width/0.1s`，调用方无从退出。现在覆盖那件事由 `set_scan_speed` 明确开关，
 * 而「我就是要这个速度」走这里。
 */
export const SetScanSpeed: Skill = {
  spec: S.SetScanSpeedSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const fwdSpeed = n(params, 'fwd_speed')
    const bwdSpeed = n(params, 'bwd_speed')
    const fwdLine = n(params, 'fwd_line_time')
    const bwdLine = n(params, 'bwd_line_time')
    const keepConst = n(params, 'keep_const')
    const ratio = n(params, 'speed_ratio', 1)

    const rec = await ctx.safeCall(
      'Scan_SpeedSet',
      fwdSpeed, bwdSpeed, fwdLine, bwdLine, keepConst, ratio,
    )
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
    return ok({
      fwd_speed: fwdSpeed,
      bwd_speed: bwdSpeed,
      fwd_line_time: fwdLine,
      bwd_line_time: bwdLine,
      keep_const: keepConst,
      speed_ratio: ratio,
    })
  },
}

/** 找会话目录里最新的 `.sxm`。**注入的**——技能本身不碰文件系统。 */
export type FindLatestSxm = (dir: string, maxAgeS: number) => string | null

export interface SaveScanOptions {
  readonly findLatestSxm?: FindLatestSxm | undefined
}

/**
 * `SaveScan` —— 存图，并**把落盘路径说出来**。
 *
 * 两件事分开报：
 * - `timed_out` 是**仪器**说的（`Scan_Save` 的回包），
 * - `saved_path` 是**我们**去会话目录里找的。
 *
 * 找不到路径不算失败：`Scan_Save` 已经成功了，只是这一侧没定位到文件
 * （目录读不到、文件比 120 秒还旧、或者根本没接文件系统）。
 * 把它报成失败，等于让调用方以为图没存上。
 */
export function makeSaveScan(opts: SaveScanOptions = {}): Skill {
  return {
    spec: S.SaveScanSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const timeoutMs = n(params, 'timeout_ms', -1)
      // Scan_Save(Wait_until_saved, Timeout_ms)
      const rec = await ctx.safeCall('Scan_Save', 1, timeoutMs)
      if (rec.error !== undefined && rec.error !== '') return fail(rec.error)
      const timedOut = bool(rec, 0) ?? false

      // 会话目录问仪器，不猜。
      const dirRec = await ctx.safeCall('Util_SessionPathGet')
      const dir =
        dirRec.error === undefined || dirRec.error === '' ? lastString(dirRec) : ''
      const latest =
        dir !== '' && opts.findLatestSxm !== undefined
          ? opts.findLatestSxm(dir, 120)
          : null

      return ok({ timed_out: timedOut, saved_path: latest })
    },
  }
}

/** 默认实例：**不接文件系统**，`saved_path` 恒为 null。 */
export const SaveScan = makeSaveScan()

export const SCAN_CHAIN: Readonly<Record<string, Skill>> = {
  SetScanSpeed,
  SaveScan,
}
