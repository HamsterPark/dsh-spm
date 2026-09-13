/**
 * 脚本槽位的文件读写 —— **闸开了，栅栏还在**。
 *
 * `Script_Load` / `Script_Save` / `Script_LUTSave` 这三条，旧仓 2026-07-12
 * 有意没写，理由在 `nanonis-script.ts` 抬头：白名单是**唯一**的屏障，而
 * `Script_Load(slot, file)` 会让智能体把另一个文件放进一个已审槽位，
 * 那一刻「槽位 1 已批准」就什么也不表示了。
 *
 * 操作员 2026-07-13 还是要了它们（默认关，放在「高级」后面）。可以 ——
 * 但「闸开了」不等于「栅栏没了」。
 *
 * ## 白名单批准的到底是什么
 *
 * 它批准的是**一个脚本，在一个槽位里**。槽位号只是称呼它的方式。于是让这份批准
 * 保持诚实的规则只有一行：
 *
 * > **`LoadNanonisScript` 拒绝往一个在白名单上的槽位里装东西。**
 *
 * 往**未审**槽位里装是无害的：`RunNanonisScript` 只放行白名单上的槽位，所以
 * 智能体装进去的脚本正是它跑不了的那个。而这不是死胡同，是**正确的分工**：
 *
 * ```
 * 智能体把文件装进一个空槽位  →  人读它、审它
 * →  人把槽位加进白名单        →  智能体才跑得了
 * ```
 *
 * 机械活归智能体，批准归人。**那本来就是白名单存在的全部理由。**
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { vettedSlots } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'
import { loadAllowlist } from './nanonis-script.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt
const str = (p: Readonly<Record<string, unknown>>, k: string): string =>
  typeof p[k] === 'string' ? p[k] : String(p[k] ?? '')

/**
 * 这个槽位**已经**过审了吗 —— 过审就**不许装**。
 *
 * 提成函数是为了让这道**反的**闸有个名字：所有别处的闸都是「不在白名单上就拒」，
 * 只有这一条相反。合并它们的那个人会把它改成正的，而那正是它防的东西。
 */
function vettedAlready(slot: number, allow: ReadonlyMap<number, unknown>): boolean {
  return allow.has(slot)
}

export const LoadNanonisScript: Skill = {
  spec: S.LoadNanonisScriptSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const slot = int(params, 'slot')
    const path = str(params, 'file_path')
    const allow = loadAllowlist()

    if (vettedAlready(slot, allow)) {
      const reason =
        `槽位 ${slot} 在已审白名单上——不能往里装别的脚本。\n` +
        '白名单认的是「**这个槽位里的那个脚本**已经被人读过、批过」，' +
        '不是「这个槽位号被批过」。换掉内容，批准就成了谎言，而脚本跑在实时控制器上，' +
        'MAST 的安全门/模式门/中止门一个都看不见它在做什么。\n' +
        '请装进一个未审槽位；装完由人审阅，再把它加进 config/nanonis_scripts.json。'
      ctx.markers.emit('safety_block', {
        subject: `LoadNanonisScript[slot ${slot}]`,
        reason,
        slot,
        file_path: path,
        allowed_slots: vettedSlots(allow),
      })
      return fail(reason)
    }

    const rec = await ctx.safeCall(
      'Script_Load',
      slot,
      path,
      params['load_session'] === true ? 1 : 0,
    )
    if (failed(rec)) return fail(`Script_Load failed: ${rec.error ?? ''}`)

    // 每一次装载都留痕：**槽位内容变了**正是人在审它之前要看见的那个事件 ——
    // 出事之后也一样。
    ctx.markers.emit('note', {
      subject: `LoadNanonisScript[slot ${slot}]`,
      reason: '脚本已载入未审槽位（agent 还不能运行它——需人工加入白名单）',
      slot,
      file_path: path,
      allowed_slots: vettedSlots(allow),
    })

    return ok(
      { slot, file_path: path, runnable: false, allowed_slots: vettedSlots(allow) },
      `脚本已载入槽位 ${slot}。**agent 还不能运行它**——` +
        `请人工审阅后把槽位 ${slot} 加入 config/nanonis_scripts.json。`,
    )
  },
}

export const SaveNanonisScript: Skill = {
  spec: S.SaveNanonisScriptSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const slot = int(params, 'slot')
    const path = str(params, 'file_path')
    const rec = await ctx.safeCall(
      'Script_Save',
      slot,
      path,
      params['save_session'] === true ? 1 : 0,
    )
    if (failed(rec)) return fail(`Script_Save failed: ${rec.error ?? ''}`)
    ctx.markers.emit('note', {
      subject: `SaveNanonisScript[slot ${slot}]`,
      reason: '槽位脚本已导出到文件',
      slot,
      file_path: path,
    })
    return ok({ slot, file_path: path }, `槽位 ${slot} 的脚本已保存到 ${path}`)
  },
}

export const SaveNanonisScriptLut: Skill = {
  spec: S.SaveNanonisScriptLutSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const slot = int(params, 'slot')
    const path = str(params, 'file_path')
    const rec = await ctx.safeCall('Script_LUTSave', slot, path)
    if (failed(rec)) return fail(`Script_LUTSave failed: ${rec.error ?? ''}`)
    ctx.markers.emit('note', {
      subject: `SaveNanonisScriptLut[slot ${slot}]`,
      reason: '槽位 LUT 已导出到文件',
      slot,
      file_path: path,
    })
    return ok({ slot, file_path: path }, `槽位 ${slot} 的 LUT 已保存到 ${path}`)
  },
}

export const SCRIPT_FILES: Readonly<Record<string, Skill>> = {
  LoadNanonisScript,
  SaveNanonisScript,
  SaveNanonisScriptLut,
}
