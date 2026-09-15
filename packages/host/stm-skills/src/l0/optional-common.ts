/**
 * `optional_*` 五族共用的两件读包工具。
 *
 * 这五个模块（通用 PI / AFM 光学 / 多探针 / 高速扫描与 RF / 示波器）**全部是选配，
 * 全部默认关**（设置 → 硬件模块）。关着的意思不是「调用会被拒」，是**它们根本不在
 * 模型的工具表里** —— 那比拒绝更强：一个看不见的工具，模型不会去想办法绕过它。
 *
 * ## ⚠️ `cell` 在本仓已经是第五份拷贝
 *
 * 旧仓自己的注释记着这件事：「**这段代码在本仓有 11 份拷贝**，只有 readback.py 那份
 * 做对了……其余 10 份的同一个错一直留到 2026-08-13/14 的真机只读全扫才被量出来」。
 * 本仓现在有 `reads-config.ts` / `spectrum.ts` / `limits.ts` / `pll.ts` 四份私有的，
 * 加上这一份是第五份 —— **它们该合并进 `common.ts`**，见 `docs/handoff/batch-3g.md`。
 * 这一批没合并只是因为那四个文件属于别的支线，跨界改会在合并时打架。
 */
import type { SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { cell, ok } from './common.js'

/** 一次调用失败了吗。 */
export const failed = (rec: SkillCallRecord): boolean =>
  rec.error !== undefined && rec.error !== ''

/**
 * 一组各自独立的读，**一个读不到不连累其余**：那一格给 `null`，别的照常交出去。
 *
 * 技能因此**永远 `success`** —— 它报的是「问到了什么」。一个问不到增益的 PI 控制器
 * 仍然回答得了「环闭没闭」，而把整趟判成失败会让调用方以为**什么都没问到**。
 *
 * `reads` 里的动词写成**字面量**：本仓每一件安全工具（中止策略核对、安全审计、
 * API 覆盖清点）都靠 grep `safeCall('…')` 找 Nanonis 调用，
 * 藏在变量后面的动词对它们全都不可见。
 */
export async function multiRead(
  reads: readonly (readonly [string, () => Promise<SkillCallRecord>])[],
  base: Record<string, unknown> = {},
): Promise<SkillResultLike> {
  const data: Record<string, unknown> = { ...base }
  for (const [key, thunk] of reads) {
    const rec = await thunk()
    data[key] = failed(rec) ? null : cell(rec)
  }
  return ok(data)
}

/** 取一个数值入参。**给了就用，`0` 也算给了。** */
export const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt

/** 取一个整数入参。**给了就用，`0` 也算给了。** */
export const i = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/**
 * 「调用方**真的给了**这个值吗」。`null` 与 `undefined` 都算没给。
 *
 * 判的是 `!= null` 而**不是** `k in p`：模型那条路上 schema 会把每一个可选字段都
 * 实例化出来，没设的以 `null` 到达 —— 用 `in` 判的话每一个都「给了」，
 * 于是把 `null` 送进硬件 setter。
 */
export const given = (p: Readonly<Record<string, unknown>>, k: string): boolean =>
  p[k] !== undefined && p[k] !== null

/** 一个布尔入参，缺省 `true`（旧仓那一族写的是 `bool(params.get(k, True))`）。 */
export const onByDefault = (p: Readonly<Record<string, unknown>>, k: string): boolean =>
  p[k] !== false

/** 一个布尔入参，缺省 `false`。 */
export const offByDefault = (p: Readonly<Record<string, unknown>>, k: string): boolean =>
  p[k] === true

/**
 * 一串逗号/空格分隔的信号索引。**有一个记号不是整数，整串作废**（给 `null`）。
 *
 * 与 `crash-check` 的「认不出就跳过」刻意不同（D-CHANNELS-1 那条）：
 * 这里记的是**采哪几路**，默默丢掉一路会让数据里少一个通道而没人知道。
 */
export function signalChannels(raw: unknown): number[] | null {
  const toks = String(raw ?? '').replaceAll(',', ' ').split(/\s+/).filter((t) => t !== '')
  const out: number[] = []
  for (const t of toks) {
    if (!/^[+-]?\d+$/.test(t)) return null
    out.push(Number(t))
  }
  return out.length > 0 ? out : null
}

/** 一次调用 + 失败时**带动词名**的报文。这一族的错都长这个样。 */
export async function step(
  ctx: SkillContext,
  verb: string,
  ...args: unknown[]
): Promise<{ rec: SkillCallRecord; error: string | null }> {
  const rec = await ctx.safeCall(verb, ...args)
  return { rec, error: failed(rec) ? `${verb} failed: ${rec.error ?? ''}` : null }
}
