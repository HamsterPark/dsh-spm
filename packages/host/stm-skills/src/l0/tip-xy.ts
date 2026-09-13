/**
 * 针尖横向位置 —— **在一个技能动手的那一刻**读出来。
 *
 * 对会留下**永久痕迹**的操作（修针、偏压脉冲），「在哪儿发生的」和「有没有成功」
 * 一样是结果的一部分。那些技能不收位置参数（它们就在针尖当下的位置动手），
 * 于是扫描图上的标记原先是从缓存的 `HardwareState` 快照里取坐标的 ——
 * 最多差一个刷新周期。而「躲开被弄坏的那几片」这件事完全建立在这些坐标上。
 *
 * ## 读不到就**什么都不报**
 *
 * 键不出现 = 「读不到」，于是记录侧照旧回落到快照并标注来源。
 * **一个诚实地写着「大概位置」的标记，胜过一个自信地写错的。**
 *
 * 这个读失败**绝不能**改变调用它的技能成功与否：它多花一次往返，不多花别的。
 */
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { body } from './common.js'

/**
 * 坐标的量级上限（米）。
 *
 * 超出它的「坐标」是一次解析残渣，不是位置：放它过去会使下游范围计算失效。
 * **扫描台的横向行程不到 1 mm。**
 */
export const TIP_XY_MAX_M = 1e-3

/** 活的 FolMe 针尖位置（米）。读不出、或者读出一个不像位置的数，都给 `null`。 */
export function parseTipXy(rec: SkillCallRecord): readonly [number, number] | null {
  if (rec.error !== undefined && rec.error !== '') return null
  const b = body(rec)
  const x = b[0]
  const y = b[1]
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (!(Math.abs(x) < TIP_XY_MAX_M && Math.abs(y) < TIP_XY_MAX_M)) return null
  return [x, y]
}

/**
 * `{x_m, y_m}`，读不到给 `{}`。
 *
 * 空对象是为了能无条件展开进 `data` —— **缺键就是「读不到」**，
 * 而那正是记录侧需要知道的、用来决定回落的那件事。
 */
export async function tipXyFields(ctx: SkillContext): Promise<Record<string, number>> {
  const pos = parseTipXy(await ctx.safeCall('FolMe_XYPosGet', 0))
  return pos === null ? {} : { x_m: pos[0], y_m: pos[1] }
}
