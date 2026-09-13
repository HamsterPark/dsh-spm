/**
 * `CheckScanForCrash` 的技能层 —— 判据在内核，这里钉的是**读法**。
 *
 * 通用轨迹金样只驱动得到「两路都好」那一支（合成回包永远有方差）。撞针本身、
 * 一路读不到、一路抛异常、以及「技能永远 success」这几条要自己摆。
 */
import { describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { CheckScanForCrash } from './crash.js'

/** 真机 body 是异构表 `[name_len, name, rows, cols, data_2D, dir]`。 */
const frame = (rows: number[][]): unknown[] => [1, 'Z', rows.length, rows[0]!.length, rows, 1]

interface Script {
  /** 通道号 → 这一路回什么。`null` = 读失败，`'throw'` = 读的时候抛。 */
  readonly byChannel: Record<number, unknown[] | null | 'throw'>
}

function rig(s: Script): { ctx: SkillContext; calls: { verb: string; args: unknown[] }[] } {
  const calls: { verb: string; args: unknown[] }[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push({ verb: m, args: a })
      const v = s.byChannel[a[0] as number]
      if (v === 'throw') throw new Error('读这一路的时候炸了')
      if (v === null || v === undefined) {
        return Promise.resolve({ method: m, args: a, error: '模拟故障：读不到' })
      }
      return Promise.resolve({ method: m, args: a, values: v })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
  } as unknown as SkillContext
  return { ctx, calls }
}

const GOOD = frame([[1, 2], [3, 4]])
const FLAT = frame([[7, 7], [7, 7]])
const NANS = frame([[Number.NaN, Number.NaN], [Number.NaN, Number.NaN]])

describe('CheckScanForCrash', () => {
  it('两路都有信号 ⇒ ok，且**技能本身永远 success**', async () => {
    const { ctx, calls } = rig({ byChannel: { 0: GOOD, 14: GOOD } })
    const r = await CheckScanForCrash.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(calls.map((c) => [c.verb, c.args])).toEqual([
      ['Scan_FrameDataGrab', [0, 1]],
      ['Scan_FrameDataGrab', [14, 1]],
    ])
    expect(r.data).toEqual({
      crash_indicator: false,
      status: 'ok',
      per_channel: { ch0: 'ok', ch14: 'ok' },
      crash_channel: null,
      data_range: null,
      channels_probed: [0, 14],
    })
  })

  it('**通道 0 看着没事，而 Z 被压平** —— 这正是默认探两路的理由', async () => {
    const { ctx } = rig({ byChannel: { 0: GOOD, 14: FLAT } })
    const r = await CheckScanForCrash.execute(ctx, {})
    const d = r.data as { status: string; crash_channel: string; crash_indicator: boolean }
    expect(d.status).toBe('crash')
    expect(d.crash_indicator).toBe(true)
    expect(d.crash_channel).toBe('ch14')
  })

  it('一整帧 NaN ⇒ crash', async () => {
    const { ctx } = rig({ byChannel: { 0: NANS, 14: GOOD } })
    expect((await CheckScanForCrash.execute(ctx, {})).data).toMatchObject({
      status: 'crash',
      crash_channel: 'ch0',
    })
  })

  it('**一路都没读到 ⇒ skipped**，而技能仍然 success', async () => {
    const { ctx } = rig({ byChannel: { 0: null, 14: null } })
    const r = await CheckScanForCrash.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({
      status: 'skipped',
      crash_indicator: false,
      per_channel: { ch0: 'no_data', ch14: 'no_data' },
    })
  })

  it('**一路抛了不带走整趟** —— 剩下那一路照样给结论', async () => {
    const { ctx, calls } = rig({ byChannel: { 0: 'throw', 14: GOOD } })
    const r = await CheckScanForCrash.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ status: 'ok', per_channel: { ch0: 'error', ch14: 'ok' } })
    // 炸了那一路之后**接着读下一路**
    expect(calls).toHaveLength(2)
  })

  it('通道清单与方向都照传', async () => {
    const { ctx, calls } = rig({ byChannel: { 3: GOOD, 9: GOOD } })
    await CheckScanForCrash.execute(ctx, { channels: '3;9', direction: 0 })
    expect(calls.map((c) => c.args)).toEqual([[3, 0], [9, 0]])
  })

  it('清单里夹了错字：跳过它，剩下的照探', async () => {
    const { ctx, calls } = rig({ byChannel: { 0: GOOD, 14: GOOD, 7: GOOD } })
    const r = await CheckScanForCrash.execute(ctx, { channels: '0, x, 14;7' })
    expect(calls.map((c) => c.args[0])).toEqual([0, 14, 7])
    expect((r.data as { channels_probed: number[] }).channels_probed).toEqual([0, 14, 7])
  })

  it('一维回包也判得了 —— 撞针判据不需要拼成图', async () => {
    const { ctx } = rig({ byChannel: { 0: [1, 2, 3, 4, 5], 14: [7, 7, 7, 7, 7] } })
    const r = await CheckScanForCrash.execute(ctx, {})
    expect(r.data).toMatchObject({ status: 'crash', crash_channel: 'ch14' })
  })
})
