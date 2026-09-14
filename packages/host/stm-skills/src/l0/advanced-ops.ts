/**
 * 多程扫描、等扫描结束，以及**退出 Nanonis**。
 *
 * ## `QuitNanonis`：三步，每一步各有一种不能糊弄的失败
 *
 * 退出 Nanonis 不是关一个窗口。**Z 反馈会随进程一起死掉** —— 带着进针状态退出，
 * 等于让针尖留在表面而没有任何软件看管它。所以这个技能的顺序本身就是判据：
 *
 * 1. **停扫描。** 一次撞进退出的扫描留下的是半张文件。失败只记一条警告 ——
 *    它不该拦住下一步。
 * 2. **退针。这一步不是可选的。** 失败 ⇒ 拒绝退出。
 * 3. **向实时控制器确认**退针到位——不是问模块的意见，也不是信我们自己「已经
 *    喊过了」的记忆（Nanonis 手册自己写着：通信延迟期间两者会不一致）。
 *    **确认不了也拒**：`on=None` 不是 `on=False`，测量链路的失败绝不能成为
 *    危险动作的触发条件。
 *
 * 然后才发退出。而**这一条的响应收不到是正常的**：Nanonis 退出时会把 socket
 * 直接拆掉。所以那里不报失败，也不假装收到了 —— 它如实说「指令发了，没等到回音」。
 *
 * ## `WaitForScanEndBlocking`：`Scan_WaitEndOfScan` 收的是**毫秒**
 *
 * 把秒直接传进去会短等 1000 倍，然后**在扫描刚开始的那一瞬间报告「扫描已结束」**。
 * 与 `waveform.ts` 里那次「周期不是频率」同一族：错了不会报错，只会安静地
 * 做另一件事。
 *
 * 它按 1 秒一片切着等，好让中止检查插得进去。而中止时那句话必须说清楚：
 * **扫描本身没有被停** —— 这个技能只负责等。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, cell, fail, ok } from './common.js'
import { verifyZController } from './verify.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const str = (p: Readonly<Record<string, unknown>>, k: string): string =>
  typeof p[k] === 'string' ? p[k] : ''



/** `Scan_Action` 的「停」。 */
const SCAN_STOP = 1
/** 等待切片。**1 秒一片**，好让中止检查插得进去。 */
const SLICE_S = 1.0

export const QuitNanonis: Skill = {
  spec: S.QuitNanonisSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // ① 停扫描。失败**不拦着退针** —— 半张文件比一根没人看管的针轻得多。
    const stop = await ctx.safeCall('Scan_Action', SCAN_STOP, 0)
    if (failed(stop)) {
      ctx.markers.emit('note', {
        subject: 'QuitNanonis',
        reason: `停止扫描失败（${stop.error ?? ''}）——继续退针`,
      })
    }

    // ② 退针。**这一步不是可选的。**
    const withdraw = await ctx.safeCall('ZCtrl_Withdraw', 1, -1)
    if (failed(withdraw)) {
      return fail(
        `**拒绝退出**：退针失败（${withdraw.error ?? ''}）。` +
          '带着进针状态退出 Nanonis，等于让针尖留在表面而没有任何软件看管它——' +
          'Z 反馈会随进程一起死掉。先把针退干净。',
      )
    }

    // ③ 向**实时控制器**确认。读不到也拒（fail-closed）。
    const v = await verifyZController(ctx, { expect: false })
    if (!(v.verified && v.on === false)) {
      const why = v.verified
        ? '实时控制器回报 Z 反馈仍然闭合'
        : `无法确认 Z 反馈状态（${v.error ?? ''}）`
      return fail(
        `**拒绝退出**：${why}。退针未确认就退出软件，` +
          '针尖会在无人看管的情况下留在表面。',
      )
    }

    const save = params['save_settings'] !== false
    ctx.markers.emit('note', {
      subject: 'QuitNanonis',
      reason: 'agent 退出了 Nanonis 软件（已先停扫描、已确认退针）',
      save_settings: save,
    })

    // Util_Quit(用存好的值, 设置名, 布局名, 保存信号)
    const rec = await ctx.safeCall(
      'Util_Quit', save ? 1 : 0, str(params, 'settings_name'), str(params, 'layout_name'),
      save ? 1 : 0,
    )
    // **这里的错不算「没退成」**：Nanonis 退出时会把 socket 拆掉，响应常常
    // 根本到不了。如实说，而不是替它宣布任何一种结局。
    if (failed(rec)) {
      return ok(
        { quit_sent: true, response: null, tip_retracted: true },
        '已发出退出指令，针尖已确认退回。未收到响应——这是正常的：' +
          'Nanonis 退出时会直接断开 socket。请确认 Nanonis 已关闭；' +
          '在它重启之前 MAST 无法再与仪器通信。',
      )
    }
    return ok(
      { quit_sent: true, response: cell(rec), tip_retracted: true },
      'Nanonis 已退出（已先停扫描、已确认退针）。重启 Nanonis 前 MAST 无法与仪器通信。',
    )
  },
}

export const SetMultiPass: Skill = {
  spec: S.SetMultiPassSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const on = params['on'] === true
    const rec = await ctx.safeCall('MPass_Activate', on ? 1 : 0)
    if (failed(rec)) return fail(`MPass_Activate failed: ${rec.error ?? ''}`)
    return ok({ multipass_on: on }, `多程扫描已${on ? '启用' : '关闭'}`)
  },
}

export const LoadMultiPassConfig: Skill = {
  spec: S.LoadMultiPassConfigSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = str(params, 'file_path')
    const rec = await ctx.safeCall('MPass_Load', path)
    if (failed(rec)) return fail(`MPass_Load failed: ${rec.error ?? ''}`)
    ctx.markers.emit('note', {
      subject: 'LoadMultiPassConfig',
      reason: '多程扫描配置已从文件载入（MAST 看不见文件内容——每一程的偏压/Z 偏移由它决定）',
      file_path: path,
    })
    return ok(
      { file_path: path },
      `多程配置已载入：${path}。` +
        '**扫描前请先确认每一程的偏压/Z 偏移**——MAST 看不见这个文件的内容。',
    )
  },
}

export const SaveMultiPassConfig: Skill = {
  spec: S.SaveMultiPassConfigSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = str(params, 'file_path')
    const rec = await ctx.safeCall('MPass_Save', path)
    if (failed(rec)) return fail(`MPass_Save failed: ${rec.error ?? ''}`)
    ctx.markers.emit('note', {
      subject: 'SaveMultiPassConfig',
      reason: '多程扫描配置已保存到文件',
      file_path: path,
    })
    return ok({ file_path: path }, `多程配置已保存到 ${path}`)
  },
}

/**
 * 回包第 0 位的超时位：`1` = 超时（还没结束）。
 *
 * **读不出来就当作「没有超时」**（= 扫描结束了，退出等待）。反过来猜的话，
 * 一个读不懂的回包会让这个技能一直等到总预算用完 ——
 * 把一次读取故障变成一次长等待。
 */
function stillRunning(rec: SkillCallRecord): boolean {
  const b = body(rec)
  let first: unknown = b[0]
  if (Array.isArray(first) && first.length > 0) first = first[0]
  return typeof first === 'number' && Math.trunc(first) === 1
}

export const WaitForScanEndBlocking: Skill = {
  spec: S.WaitForScanEndBlockingSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const timeoutS = f(params, 'timeout_s')
    const t0 = ctx.now()
    const deadline = t0 + timeoutS * 1000
    // **局部的**：超时那一支报的是最后一次回包，而两次并发的等待不该互相看见
    // 对方的那一份。（写成模块级变量就是一个跨调用泄漏的状态。）
    let lastResult: unknown = null

    for (;;) {
      if (ctx.signal.aborted) {
        const waited = (ctx.now() - t0) / 1000
        return fail(
          'aborted by operator — 已停止等待扫描结束。' +
            '**扫描本身没有被停**（这个技能只负责等，不负责停）；' +
            '需要停扫描请用 StopScan / 紧急停止。',
          {
            timeout_s: timeoutS,
            aborted: true,
            waited_s: Math.round(waited * 100) / 100,
          },
        )
      }
      const remainingMs = deadline - ctx.now()
      if (remainingMs <= 0) {
        return ok(
          { timeout_s: timeoutS, timed_out: true, result: lastResult },
          `等到上限仍未结束（上限 ${gfmt(timeoutS)} s）`,
        )
      }
      // **毫秒。** 见文件抬头：传秒会短等 1000 倍。
      const sliceMs = Math.max(1, Math.trunc(Math.min(SLICE_S * 1000, remainingMs)))
      const rec = await ctx.safeCall('Scan_WaitEndOfScan', sliceMs)
      if (failed(rec)) return fail(`Scan_WaitEndOfScan failed: ${rec.error ?? ''}`)
      lastResult = cell(rec)
      if (!stillRunning(rec)) {
        return ok(
          { timeout_s: timeoutS, timed_out: false, result: lastResult },
          `扫描已结束（上限 ${gfmt(timeoutS)} s）`,
        )
      }
    }
  },
}

/** Python 的 `{x:g}`。 */
const gfmt = (v: number): string => String(Number(v.toPrecision(6)))

export const ADVANCED_OPS: Readonly<Record<string, Skill>> = {
  QuitNanonis,
  SetMultiPass,
  LoadMultiPassConfig,
  SaveMultiPassConfig,
  WaitForScanEndBlocking,
}
