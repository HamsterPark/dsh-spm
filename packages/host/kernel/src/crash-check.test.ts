/**
 * 撞针判据。
 *
 * 这一组的重点在**三态**：`ok` / `crash` / `skipped`。
 * 「我没发现撞针」和「我没能看」是两句话，而下游拿它来决定要不要接着扫。
 */
import { describe, expect, it } from 'vitest'
import {
  CRASH_RANGE_EPS,
  DEFAULT_CRASH_CHANNELS,
  crashVerdict,
  parseChannels,
  type ChannelSamples,
} from './crash-check.js'

const ch = (channel: number, samples: readonly number[] | null, threw?: true): ChannelSamples =>
  threw === true ? { channel, samples, threw } : { channel, samples }

describe('parseChannels', () => {
  it('逗号与分号都认', () => {
    expect(parseChannels('0,14')).toEqual([0, 14])
    expect(parseChannels('0;14;7')).toEqual([0, 14, 7])
    expect(parseChannels(' 1 , 2 ')).toEqual([1, 2])
  })

  it('**认不出的记号跳过，不是整趟失败**', () => {
    // 一串里夹了个错字，不该让这次撞针检测不做 —— 剩下那几路照样回答得了问题
    expect(parseChannels('0, x, 14;7')).toEqual([0, 14, 7])
    expect(parseChannels('0,1.5,2')).toEqual([0, 2])
  })

  it('全都认不出就回落到默认两路', () => {
    for (const bad of ['', '   ', 'x,y', null, undefined]) {
      expect(parseChannels(bad), String(bad)).toEqual([...DEFAULT_CRASH_CHANNELS])
    }
  })

  it('给一个裸数字就是那一路 —— 同 Python 的 `str(x)` 再解析', () => {
    expect(parseChannels(5)).toEqual([5])
  })

  it('默认是形貌 + Z-controller', () => {
    // 撞针会把 Z 压平，**哪怕通道 0 看起来还说得过去**
    expect([...DEFAULT_CRASH_CHANNELS]).toEqual([0, 14])
  })
})

describe('crashVerdict —— 三态', () => {
  it('有信号 ⇒ ok', () => {
    const v = crashVerdict([ch(0, [1, 2, 3]), ch(14, [0, 5])])
    expect(v).toEqual({
      crashIndicator: false,
      status: 'ok',
      perChannel: { ch0: 'ok', ch14: 'ok' },
      crashChannel: null,
      dataRange: null,
    })
  })

  it('**极差接近零 ⇒ crash**：撞针之后不是「有点怪」，是没有信号了', () => {
    const v = crashVerdict([ch(0, [1, 2, 3]), ch(14, [7, 7, 7])])
    expect(v.status).toBe('crash')
    expect(v.crashIndicator).toBe(true)
    expect(v.crashChannel).toBe('ch14')
    expect(v.dataRange).toBe(0)
    expect(v.perChannel).toEqual({ ch0: 'ok', ch14: 'crash' })
  })

  it('极差恰在阈上/阈下', () => {
    expect(crashVerdict([ch(0, [0, CRASH_RANGE_EPS * 0.5])]).status).toBe('crash')
    expect(crashVerdict([ch(0, [0, CRASH_RANGE_EPS * 2])]).status).toBe('ok')
  })

  it('**有 NaN ⇒ crash**，即使剩下的数摆得很开', () => {
    const v = crashVerdict([ch(0, [1, Number.NaN, 100])])
    expect(v.status).toBe('crash')
    expect(v.perChannel['ch0']).toBe('crash')
  })

  it('**整帧 NaN ⇒ crash**，不是「没读到」', () => {
    // 一整帧 NaN 正是撞针最典型的样子。把它归进「没读到」，
    // 会让最该报警的那一帧变成最安静的那一帧。
    const v = crashVerdict([ch(0, [Number.NaN, Number.NaN])])
    expect(v.status).toBe('crash')
    expect(Number.isNaN(v.dataRange as number)).toBe(true)
  })

  it('**一路都没读到 ⇒ skipped，永远不是 ok**', () => {
    const v = crashVerdict([ch(0, null), ch(14, null)])
    expect(v.status).toBe('skipped')
    expect(v.crashIndicator).toBe(false)
    expect(v.perChannel).toEqual({ ch0: 'no_data', ch14: 'no_data' })
  })

  it('空采样也算没读到 —— 算不出极差就不是一个判断', () => {
    expect(crashVerdict([ch(0, [])]).status).toBe('skipped')
    expect(crashVerdict([ch(0, [])]).perChannel['ch0']).toBe('no_data')
  })

  it('一路读不到、另一路好 ⇒ ok（有证据就敢下结论）', () => {
    const v = crashVerdict([ch(0, null), ch(14, [1, 2])])
    expect(v.status).toBe('ok')
    expect(v.perChannel).toEqual({ ch0: 'no_data', ch14: 'ok' })
  })

  it('一路读不到、另一路撞了 ⇒ crash（撞针压过一切）', () => {
    const v = crashVerdict([ch(0, null), ch(14, [7, 7])])
    expect(v.status).toBe('crash')
  })

  it('**读那一路时抛了 ⇒ error**，与「读回来没数据」分得开', () => {
    const v = crashVerdict([ch(0, null, true), ch(14, [1, 2])])
    expect(v.perChannel).toEqual({ ch0: 'error', ch14: 'ok' })
  })

  it('`crash_channel` 记**第一路**撞的，`data_range` 是那一路的', () => {
    const v = crashVerdict([ch(0, [5, 5]), ch(14, [9, 9])])
    expect(v.crashChannel).toBe('ch0')
    expect(v.dataRange).toBe(0)
  })

  it('一路都没有 ⇒ skipped', () => {
    expect(crashVerdict([])).toEqual({
      crashIndicator: false,
      status: 'skipped',
      perChannel: {},
      crashChannel: null,
      dataRange: null,
    })
  })
})
