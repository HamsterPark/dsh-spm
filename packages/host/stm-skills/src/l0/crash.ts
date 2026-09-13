/**
 * `CheckScanForCrash` —— 扫完一帧之后问「刚才撞针了吗」。
 *
 * 判据全在内核的 `crashVerdict` 里，这里只负责**把几路通道读出来**，
 * 而且**一路坏掉不能带走整趟探测**：读哪一路炸了，就记它自己一个 `error`，
 * 接着读下一路。
 *
 * 技能**永远 success**——「分析跑过了」这件事成立，结论在 `data` 里，
 * 由调用它的组合技能去分支。
 */
import {
  crashVerdict,
  parseChannels,
  parseFrameGrab,
  type ChannelSamples,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'

/** 读一路通道，拉平成一维采样。读不到给 `null`，抛了给 `threw`。 */
async function grab(ctx: SkillContext, channel: number, direction: number): Promise<ChannelSamples> {
  try {
    const rec = await ctx.safeCall('Scan_FrameDataGrab', channel, direction)
    if (rec.error !== undefined && rec.error !== '') return { channel, samples: null }
    // 撞针判据只要极差与 NaN，**不需要拼成图** —— 一维就够，也少一次失败的可能
    const arr = parseFrameGrab(rec.values ?? null, false)
    return { channel, samples: arr === null ? null : (arr as number[]) }
  } catch {
    // 一路坏掉不能带走整趟探测
    return { channel, samples: null, threw: true }
  }
}

export const CheckScanForCrash: Skill = {
  spec: S.CheckScanForCrashSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const channels = parseChannels(params['channels'] ?? '0,14')
    const direction = typeof params['direction'] === 'number' ? params['direction'] : 1

    const read: ChannelSamples[] = []
    for (const ch of channels) read.push(await grab(ctx, ch, direction))

    const v = crashVerdict(read)
    return {
      success: true,
      data: {
        crash_indicator: v.crashIndicator,
        status: v.status,
        per_channel: v.perChannel,
        crash_channel: v.crashChannel,
        data_range: v.dataRange,
        channels_probed: channels,
      },
    }
  },
}
