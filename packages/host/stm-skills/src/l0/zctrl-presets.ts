/**
 * 按**参数组名**应用 Z 控制器参数 —— 模型永远不打那几个数字。
 *
 * 模型说 `ApplyZCtrlPreset('approach')`。代码去**用户维护的那个地方**把值取出来、
 * 校验、写下去、读回来、在 TS 里比对。这条路上**一个数字参数都没有**，
 * 于是也就没有地方让一个丢掉的指数落进去。
 *
 * 它存在是因为 2026-08-03：模型被要求设 `p_gain=3e-12`，发出来的是 `3` ——
 * 三米的比例增益，静默地差 10¹² 倍。Z 环当时是开的，所以什么都没动；
 * 环闭着的话，反馈一接通针尖就扎进样品。
 *
 * 用户当时的结论，也是这里的设计：
 *
 * > 不让 agent 负责写这个数字。写这个数字的应该是一个 python 脚本，agent 一发话，
 * > 脚本就把默认参数组 A，或者默认参数组 B……写进去。
 */
import {
  PRESET_APPROACH,
  PRESET_SCAN,
  PresetRejected,
  PresetStore,
  RESERVED_NAMES,
  availableNames,
  formatSi,
  resolvePreset,
  tierNames,
  type ApproachProfile,
  type ResolvedPreset,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { num } from './common.js'
import { processPresetStore } from './frames.js'

/**
 * 四路真源里本仓要**接线**的两路。
 *
 * 自定义组在 `store` 里，扫描档位表在内核的出厂表里（两者都不用接）；
 * 剩下的是**仪器档案**（用户填的进针参数）与**当前帧宽**（`scan` 别名要）。
 */
export interface PresetSkillDeps {
  readonly store?: PresetStore
  /**
   * 仪器档案里的进针参数。没接 ⇒ 视为没配，`resolve('approach')` 如实拒绝并
   * 告诉用户去哪儿填 —— **绝不拿一组「常见值」顶上**：编一个出来会以本机标定
   * 的名义跑一次真实的进针。
   */
  readonly approachProfile?: () => ApproachProfile | null
}

/** 当前扫描帧宽（米）。读不到给 `null` —— 「读不到」不是「挑一档」。 */
async function frameSizeM(ctx: SkillContext): Promise<number | null> {
  const rec = await ctx.safeCall('Scan_FrameGet')
  if (rec.error !== undefined && rec.error !== '') return null
  return num(rec, 2) // (center_x, center_y, width, height, angle)
}

/** 解析要的四样东西。`scan` 别名**才**去读帧——别的名字读它没有意义。 */
async function sourcesFor(
  ctx: SkillContext,
  name: string,
  deps: PresetSkillDeps,
): Promise<{ presets: readonly ReturnType<PresetStore['list']>[number][]; approach: ApproachProfile | null; frameSizeM: number | null }> {
  const store = deps.store ?? processPresetStore
  const wantsFrame = String(name ?? '').trim().toLowerCase() === PRESET_SCAN
  return {
    presets: store.list(),
    approach: deps.approachProfile?.() ?? null,
    frameSizeM: wantsFrame ? await frameSizeM(ctx) : null,
  }
}

/**
 * `ApplyZCtrlPreset` —— 把一组具名参数写进硬件。
 *
 * 走 `SetZCtrlGain` / `SetSetpoint` 两个**子技能**的正门，而不是直接发裸动词：
 * 那样它们各自的边界检查、安全闸、以及写后回读比对全都照常生效，
 * 而 `(P, T, I)` 的参数顺序只在一个地方被知道。
 *
 * 名字在**这里**校验，不写进工具 schema 的枚举：合法名字的集合是运行期会变的
 * （用户能加一档、加一组），而 schema 在 agent 建起来的那一刻就冻住了。
 * 一句「当前可用是这些」的报错，胜过一个会过期的枚举。
 */
export function makeApplyZCtrlPreset(deps: PresetSkillDeps = {}): Skill {
  return {
    spec: S.ApplyZCtrlPresetSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const name = params['preset']
      let resolved: ResolvedPreset
      try {
        resolved = resolvePreset(name, await sourcesFor(ctx, String(name ?? ''), deps))
      } catch (e) {
        if (e instanceof PresetRejected) return { success: false, error: e.message }
        throw e
      }

      const applied: Record<string, unknown> = {}
      const gainRes = await ctx.runSkill('SetZCtrlGain', resolved.gainParams())
      if (!gainRes.success) {
        return {
          success: false,
          error: `参数组 '${resolved.name}' 的增益写入失败: ${gainRes.error ?? ''}`,
          data: { preset: resolved.name, trace: resolved.traceLines() },
        }
      }
      applied['gains'] = resolved.gainParams()

      if (resolved.setpointA !== null) {
        const spRes = await ctx.runSkill('SetSetpoint', { setpoint_a: resolved.setpointA })
        if (!spRes.success) {
          return {
            success: false,
            error:
              `参数组 '${resolved.name}' 的增益已写入,但设定点写入失败: ${spRes.error ?? ''}`,
            data: { preset: resolved.name, applied, trace: resolved.traceLines() },
          }
        }
        applied['setpoint_a'] = resolved.setpointA
      }

      // 上面每一次叶子写入**自己已经读回来比过了**。在这里再读一遍只会多几趟往返，
      // 外加多出第二处「怎么算一致」的规则，让它有机会跟第一处漂移开。
      const trace = resolved.traceLines()
      const notes = resolved.notes.join('\n')
      return {
        success: true,
        data: {
          preset: resolved.name,
          applied,
          trace,
          sources: resolved.sources,
          notes: resolved.notes,
          message:
            `已按参数组 '${resolved.name}' 设置 Z 控制器,写入后回读已确认:\n` +
            trace.join('\n') +
            (notes ? `\n${notes}` : ''),
        },
      }
    },
  }
}

export const ApplyZCtrlPreset: Skill = makeApplyZCtrlPreset()

/**
 * `ListZCtrlPresets` —— 现在能应用的全部组名、数值与来历。
 *
 * **不做硬件 I/O**：`scan` 别名要当前帧宽才选得出档，而列清单不是干这个的地方。
 * 所以它对 `scan` 那一行如实说「应用时才确定」，而不是替用户先扫一眼仪器。
 */
export function makeListZCtrlPresets(deps: PresetSkillDeps = {}): Skill {
  return {
    spec: S.ListZCtrlPresetsSpec,
    execute: (_ctx: SkillContext): Promise<SkillResultLike> => {
      const store = deps.store ?? processPresetStore
      const presets = store.list()
      const approach = deps.approachProfile?.() ?? null
      const custom = new Set(presets.map((p) => p.name))
      const tiers = new Set(tierNames())

      const rows = availableNames(presets).map((name) => {
        const entry: Record<string, unknown> = { name }
        try {
          const r = resolvePreset(name, { presets, approach })
          entry['p_gain'] = `${formatSi(r.pGain)}m`
          entry['i_gain'] = `${formatSi(r.iGain)}m/s`
          entry['time_constant_s'] = `${formatSi(r.timeConstantS)}s`
          entry['setpoint_a'] = r.setpointA === null ? null : `${formatSi(r.setpointA)}A`
          entry['sources'] = r.sources
          entry['usable'] = true
        } catch (e) {
          if (!(e instanceof PresetRejected)) throw e
          entry['usable'] = false
          entry['why'] = e.message
        }
        entry['kind'] = RESERVED_NAMES.includes(name)
          ? 'reserved'
          : custom.has(name)
            ? 'custom'
            : tiers.has(name)
              ? 'scan-tier'
              : 'custom'
        return entry
      })

      return Promise.resolve({
        success: true,
        data: {
          presets: rows,
          note:
            "'scan' 按当前扫描帧尺寸选档,所以这里不显示它的具体数值 —— 应用时才确定。",
        },
      })
    },
  }
}

export const ListZCtrlPresets: Skill = makeListZCtrlPresets()

export const ZCTRL_PRESETS: Readonly<Record<string, Skill>> = {
  ApplyZCtrlPreset,
  ListZCtrlPresets,
}

export { PRESET_APPROACH }
