/**
 * 批 2 —— **写完读回来核对**的那些。
 *
 * 这一批与 `writes-simple.ts` 的分界只有一句话：
 *
 * > 一次没有 TCP 错误的写，说明它被**接收**了，不说明它被**应用**了。
 *
 * 实时控制器跑在自己的时钟上，Nanonis 手册明确警告过这个延迟。
 * 下游 `z_controller_on: false` 正是 `TryEngageController` 建议**粗进针**的依据 ——
 * 一个错了就变成撞针的判断。所以这几个技能读回来核对，不符就**还原**。
 */
import { valuesMatch, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, int, num, numList, ok } from './common.js'
import { lastString } from './reads-hw.js'
import { verifyZController } from './verify.js'

const n = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number => {
  const v = p[k]
  return typeof v === 'number' ? v : dflt
}

/** Python 的 `f"{x:.2f}"`。 */
const f2 = (v: number): string => v.toFixed(2)

// ── Z 反馈开关 ──────────────────────────────────────────────────────────────

export const ZControllerOnOff: Skill = {
  spec: S.ZControllerOnOffSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const enable = params['enable'] === true
    const rec = await ctx.safeCall('ZCtrl_OnOffSet', enable ? 1 : 0)
    if (rec.error !== undefined && rec.error !== '') return fail(rec.error)

    const v = await verifyZController(ctx, { expect: enable })

    if (v.verified && v.matches === false) {
      // **说清等了多久、机器自己声明的预算是多少。**
      //
      // 控制器状态可能在写入后仍未同步；若丢失验证耗时和预算，诊断无法区分
      // 状态尚未同步与等待预算不足。
      //
      // 带上之后两种成因一眼分开：
      //   等待 ≈ 声明的延迟 → 写入是真的没生效（接线 / 模块 / RT 配置）
      //   等待 ≪ 声明的延迟 → 我们判早了，该调大的是沉降预算
      const waitedS = v.waitedMs / 1000
      const budget = v.switchOffDelayS
      let timing = ` 已等待 ${f2(waitedS)}s`
      if (budget !== null && budget > 0) {
        timing += `（本机声明的 switch-off 延迟 ${f2(budget)}s）`
        timing +=
          waitedS < budget * 0.9
            ? '——**等待时间短于机器自己声明的延迟**，这更像是判早了而不是写入没生效'
            : '——已等满声明的延迟，写入很可能确实没生效'
      } else {
        timing += '（本机未声明 switch-off 延迟）'
      }
      return fail(
        `Z 反馈开关未生效：要求 ${enable ? 'ON' : 'OFF'}，` +
          `实时控制器回报 ${v.on === true ? 'ON' : 'OFF'}。${timing}`,
        {
          z_controller_on: v.on,
          requested: enable,
          verified: true,
          waited_s: waitedS,
          switch_off_delay_s: budget,
        },
      )
    }

    if (!v.verified) {
      // 写下去了，回读没成功。**说出来**，而不是把「不知道」悄悄升级成「如请求」。
      return {
        success: true,
        data: {
          z_controller_on: null,
          requested: enable,
          verified: false,
          verify_error: v.error,
        },
        summary:
          `已下发 Z 反馈 ${enable ? 'ON' : 'OFF'}，但无法读回确认（${v.error}）` +
          `——请勿据此认定它已生效。`,
      }
    }

    return ok({ z_controller_on: v.on, requested: enable, verified: true })
  },
}

// ── 设定点 ──────────────────────────────────────────────────────────────────

export const SetSetpoint: Skill = {
  spec: S.SetSetpointSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const requested = n(params, 'setpoint_a')

    // 先读**写入前**的值：不符时要还原，而还原到哪儿只有现在能知道。
    const before = await ctx.safeCall('ZCtrl_SetpntGet')
    const prior = before.error === undefined || before.error === '' ? num(before, 0) : null

    const set = await ctx.safeCall('ZCtrl_SetpntSet', requested)
    if (set.error !== undefined && set.error !== '') return fail(set.error)

    const after = await ctx.safeCall('ZCtrl_SetpntGet')
    if (after.error !== undefined && after.error !== '') {
      // **`readback_ok: null` 是显式的「不知道」**，不是 false。
      return ok({
        setpoint_a: requested,
        readback_ok: null,
        readback_unavailable: true,
        note: '设定点已写入,但回读失败,无法确认硬件真的接受了这个值。进针前请在 Nanonis 面板上人工核对。',
      })
    }
    const readback = num(after, 0)
    const m = valuesMatch(requested, readback)
    if (m.ok) {
      return ok({ setpoint_a: requested, readback, readback_ok: true })
    }

    // 不符 ⇒ 还原到写入前的值。**不要进针**。
    let restored = false
    if (prior !== null) {
      const back = await ctx.safeCall('ZCtrl_SetpntSet', prior)
      restored = back.error === undefined || back.error === ''
    }
    return fail(
      `写后回读不一致 —— 硬件里的设定点不是刚才请求的值: ${m.detail}。` +
        `${restored ? '已还原为写入前的值。' : '无法还原为写入前的值。'}` +
        `**不要进针**,先在 Nanonis 面板上人工核对设定点。`,
      { requested, readback, readback_ok: false, prior, restored },
    )
  },
}

// ── Z 增益 ──────────────────────────────────────────────────────────────────

const GAIN_FIELDS = ['p_gain', 'time_constant_s', 'i_gain'] as const

export const SetZCtrlGain: Skill = {
  spec: S.SetZCtrlGainSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const requested = {
      p_gain: n(params, 'p_gain'),
      time_constant_s: n(params, 'time_constant_s'),
      i_gain: n(params, 'i_gain'),
    }

    const before = await ctx.safeCall('ZCtrl_GainGet')
    const prior =
      before.error === undefined || before.error === ''
        ? { p_gain: num(before, 0), time_constant_s: num(before, 1), i_gain: num(before, 2) }
        : null

    const set = await ctx.safeCall(
      'ZCtrl_GainSet',
      requested.p_gain,
      requested.time_constant_s,
      requested.i_gain,
    )
    if (set.error !== undefined && set.error !== '') return fail(set.error)

    const after = await ctx.safeCall('ZCtrl_GainGet')
    if (after.error !== undefined && after.error !== '') {
      return ok({
        ...requested,
        readback_ok: null,
        readback_unavailable: true,
        note: '增益已写入,但回读失败,无法确认硬件真的接受了这组值。进针或扫图前请在 Nanonis 面板上人工核对 Z-Controller 增益。',
      })
    }
    const readback = {
      p_gain: num(after, 0),
      time_constant_s: num(after, 1),
      i_gain: num(after, 2),
    }
    // 判断在**这里**算，绝不是把两个数摆进返回值里问下游一不一样 ——
    // 见 `valuesMatch` 抬头那份 2026-08-03 的报告：被问的那个正是弄错的那个。
    const mismatches = GAIN_FIELDS.map((k) => ({ k, m: valuesMatch(requested[k], readback[k]) }))
      .filter((x) => !x.m.ok)
    if (mismatches.length === 0) {
      return ok({ ...requested, readback, readback_ok: true })
    }

    let restored = false
    if (prior !== null && GAIN_FIELDS.every((k) => prior[k] !== null)) {
      const back = await ctx.safeCall(
        'ZCtrl_GainSet',
        prior.p_gain,
        prior.time_constant_s,
        prior.i_gain,
      )
      restored = back.error === undefined || back.error === ''
    }
    const detail = mismatches.map((x) => `${x.k}: ${x.m.detail}`).join('; ')
    return fail(
      `写后回读不一致 —— 硬件里的增益不是刚才请求的值: ${detail}。` +
        `${restored ? '已还原为写入前的值。' : ''}` +
        `**不要进针、不要扫图**,先在 Nanonis 面板上人工核对 Z-Controller → Controller Adjustment。`,
      { requested, readback, readback_ok: false, prior, restored },
    )
  },
}

// ── 会话路径 ────────────────────────────────────────────────────────────────

export const SetSessionPath: Skill = {
  spec: S.SetSessionPathSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const requested = String(params['session_path'] ?? '')
    const save = params['save_settings_to_previous'] !== false

    const set = await ctx.safeCall('Util_SessionPathSet', requested, save ? 1 : 0)
    if (set.error !== undefined && set.error !== '') return fail(set.error)

    const after = await ctx.safeCall('Util_SessionPathGet')
    if (after.error !== undefined && after.error !== '') {
      return {
        success: true,
        data: {
          requested,
          save_settings_to_previous: save,
          session_path: null,
          verified: false,
          verify_error: after.error,
        },
        summary: `已下发会话路径 ${requested}，但无法读回确认（${after.error}）——请勿据此认定它已生效。`,
      }
    }
    // **一个解析器两处用**（`GetSessionPath` 与这里的回读）：回读若由另一份
    // 单独写的解析器来读，它可以自己和自己一致而两边都是错的。
    const readback = lastString(after)
    if (readback === requested) {
      return ok({ requested, save_settings_to_previous: save, session_path: readback, verified: true })
    }
    return fail(
      `会话路径未生效：要求 '${requested}'，读回 '${readback}'。后续扫描仍会存到读回的那个目录。`,
      { requested, save_settings_to_previous: save, session_path: readback, verified: true },
    )
  },
}

// ── 扫描缓冲 ────────────────────────────────────────────────────────────────

export const SetScanBuffer: Skill = {
  spec: S.SetScanBufferSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // **先读当前配置**：这条命令必须连通道列表一起发，而通道列表只有仪器知道。
    const before = await ctx.safeCall('Scan_BufferGet')
    if (before.error !== undefined && before.error !== '') {
      return fail(`读取当前扫描缓冲失败,无法在保留通道的前提下改分辨率: ${before.error}`)
    }
    const channels = numList(before, 1)
    const prevPixels = int(before, 2)
    const prevLines = int(before, 3)
    if (channels.length === 0 || prevPixels === null || prevLines === null) {
      return fail(
        'Scan_BufferGet 回包格式无法解析,拒绝写入 —— 猜一个通道列表写回去会破坏当前的采集配置。',
        { raw: [...body(before)] },
      )
    }

    const pixels = n(params, 'pixels', prevPixels)
    const lines = typeof params['lines'] === 'number' ? (params['lines'] as number) : pixels

    const set = await ctx.safeCall('Scan_BufferSet', channels, pixels, lines)
    if (set.error !== undefined && set.error !== '') return fail(set.error)

    const after = await ctx.safeCall('Scan_BufferGet')
    // **整条 body 不到四段就一个都不取**：`Scan_BufferGet` 的形状是
    // `[通道数, 通道表, 像素, 行]`，短了说明这不是一个可信的回包 ——
    // 从半截回包里挑出「像素」，就是在不知道自己在读什么的情况下报一个数。
    const full = (after.error === undefined || after.error === '') && body(after).length >= 4
    const appliedPixels = full ? int(after, 2) : null
    const appliedLines = full ? int(after, 3) : null
    const verified = appliedPixels === pixels && appliedLines === lines

    const data: Record<string, unknown> = {
      channel_indexes: channels,
      pixels,
      lines,
      previous_pixels: prevPixels,
      previous_lines: prevLines,
      applied_pixels: appliedPixels,
      applied_lines: appliedLines,
      verified,
    }
    if (!verified) {
      data['warning'] =
        `分辨率写入后回读未能确认(请求 ${pixels}x${lines},` +
        `回读 ${appliedPixels === null ? 'None' : appliedPixels}x${appliedLines === null ? 'None' : appliedLines})` +
        ` —— 硬件可能对该值做了调整`
    }
    // 摘要里带上**从哪到哪**：一句「已设置」不足以让人发现分辨率其实没变。
    return ok(
      data,
      `扫描分辨率 ${prevPixels}x${prevLines} → ${pixels}x${lines}` +
        (verified ? '' : '(回读未确认)'),
    )
  },
}

export const VERIFIED_WRITES: Readonly<Record<string, Skill>> = {
  ZControllerOnOff, SetSetpoint, SetZCtrlGain, SetSessionPath, SetScanBuffer,
}
