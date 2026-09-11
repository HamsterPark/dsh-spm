/**
 * 扫描回包解析的网格金样 —— 22 格逐条对旧仓。
 *
 * ⚠️ 旧仓那些函数吃的是**三段信封**，本仓这一侧信封已经在 `nanonis-wire` 拆掉
 * （D-SKILL-1）。所以金样**同时录了 `input`（信封）与 `body`（我们收到的）**，
 * 这里喂 `body`——第一版让这边照着 `input` 自己判「像不像信封」，于是
 * `not_an_envelope` 那一格两边喂的根本不是同一个值。判据不该建立在一次猜测上。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  channelIdsFromBuffer,
  frameAcquiredLines,
  parseBufferGet,
  parseFrameGrab,
  scalarInt,
} from './scan-reply.js'

interface BufCase {
  body: unknown
  parse_buffer_get: {
    num_channels: number | null
    channel_indexes: number[]
    pixels: number | null
    lines: number | null
  } | null
  channel_ids: number[]
}
interface FrameCase {
  body: unknown
  frame_acquired_lines: [number, number] | null
  shape_2d: [number, number] | null
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/scan_wait.json', import.meta.url)),
    'utf8',
  ),
) as { parsers: { buffer: Record<string, BufCase>; frame: Record<string, FrameCase> } }

/** 导出时 NaN / inf 被写成记号（`allow_nan=False`）。读回来。 */
export function revive(v: unknown): unknown {
  if (v === 'NaN') return Number.NaN
  if (v === 'Infinity') return Number.POSITIVE_INFINITY
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY
  if (Array.isArray(v)) return v.map(revive)
  return v
}


describe('parseBufferGet —— 12 格', () => {
  for (const [name, c] of Object.entries(golden.parsers.buffer)) {
    it(name, () => {
      const body = revive(c.body)
      const got = parseBufferGet(body)
      if (c.parse_buffer_get === null) {
        expect(got).toBeNull()
      } else {
        expect(got).toEqual({
          numChannels: c.parse_buffer_get.num_channels,
          channelIndexes: c.parse_buffer_get.channel_indexes,
          pixels: c.parse_buffer_get.pixels,
          lines: c.parse_buffer_get.lines,
        })
      }
      expect(channelIdsFromBuffer(body)).toEqual(c.channel_ids)
    })
  }

  it('**真机的通道号是 1-元组** —— 桩全是裸整数，所以这个差异撑到仪器上才现形', () => {
    // `SetScanBuffer` 的 `[int(c) for c in raw_ch]` 在第一次真调用上就死了。
    expect(channelIdsFromBuffer([2, [[0], [30]], 256, 256])).toEqual([0, 30])
    expect(channelIdsFromBuffer([2, [0, 30], 256, 256])).toEqual([0, 30])
  })

  it('一个乱码元素不该让你连读得出来的通道也丢掉', () => {
    expect(channelIdsFromBuffer([3, [0, 'x', 30], 256, 256])).toEqual([0, 30])
  })

  it('`numChannels` 是**仪器声明的**，不拿长度重算', () => {
    // 两者对不上是调用方应该看见的解析失败，不是该被抹平的事。
    expect(parseBufferGet([9, [0], 256, 256])?.numChannels).toBe(9)
    expect(parseBufferGet([9, [0], 256, 256])?.channelIndexes).toEqual([0])
  })
})

describe('frameAcquiredLines / parseFrameGrab —— 10 格', () => {
  for (const [name, c] of Object.entries(golden.parsers.frame)) {
    it(name, () => {
      const body = revive(c.body)
      const got = frameAcquiredLines(body)
      expect(got).toEqual(c.frame_acquired_lines)
      const arr = parseFrameGrab(body, true)
      const shape =
        arr === null || !Array.isArray(arr[0]) ? null : [arr.length, (arr[0] as number[]).length]
      expect(shape).toEqual(c.shape_2d)
    })
  }

  it('**NaN 前沿就是扫描前沿**', () => {
    const frame = [
      [1, 2],
      [3, 4],
      [Number.NaN, Number.NaN],
      [Number.NaN, Number.NaN],
    ]
    expect(frameAcquiredLines([2, 'Z', 4, 2, frame, 1])).toEqual([2, 4])
  })

  it('半行 NaN **算采到了** —— 判据是「整行都是 NaN」', () => {
    expect(frameAcquiredLines([[1, Number.NaN], [Number.NaN, Number.NaN]])).toEqual([1, 2])
  })

  it('一行 NaN 都没有 ⇒ `(rows, rows)`，**不是 `null`**', () => {
    // 它回答的是「有没有看得见的缺失」。在一台用陈旧数据回填的仪器上，诚实的答案
    // 退化成「看不见缺失」——那是这条检查存在之前的行为，不是一条新的误报。
    expect(frameAcquiredLines([[1, 2], [3, 4]])).toEqual([2, 2])
  })

  it('取不出 ⇒ `null`，调用方必须把进度当**未知**，绝不当零', () => {
    expect(frameAcquiredLines([])).toBeNull()
    expect(frameAcquiredLines(null)).toBeNull()
    expect(frameAcquiredLines('nope')).toBeNull()
    expect(frameAcquiredLines([2, 'Z', 4, 2, [], 1])).toBeNull()
  })

  it('异构 body 里那个二维元素先被找到 —— 整表一起解会炸', () => {
    // 这个 bug 在扁平桩上看不见：它让每一次**真实**扫描的解析都失败。
    expect(parseFrameGrab([4, 'Zed', 2, 2, [[1, 2], [3, 4]], 1], true)).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(parseFrameGrab([4, 'Zed', 2, 2, [[1, 2], [3, 4]], 1])).toEqual([1, 2, 3, 4])
  })
})

describe('scalarInt', () => {
  it('解一层 1-元素序列，多元素 ⇒ null（**不取第 0 个**）', () => {
    expect(scalarInt([256])).toBe(256)
    expect(scalarInt([1, 2])).toBeNull()
    expect(scalarInt([[1]])).toBeNull() // 只解一层
  })

  it('字符串、布尔、非有限 ⇒ null；小数截断', () => {
    expect(scalarInt('7')).toBeNull()
    expect(scalarInt(true)).toBeNull()
    expect(scalarInt(Number.NaN)).toBeNull()
    expect(scalarInt(Number.POSITIVE_INFINITY)).toBeNull()
    expect(scalarInt(2.9)).toBe(2)
    expect(scalarInt(-2.9)).toBe(-2)
  })
})
