import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WireTypeError, binaryString, binaryStringBytes, decodeReturns, encodeArg } from './types.js'

/** 请求侧字节来自真实 nanonis_spm 客户端；回复侧来自 STM-Bench 服务端 codec。 */
const golden = JSON.parse(
  readFileSync(new URL('../../../../spec/golden/wire_types.json', import.meta.url), 'utf8'),
) as {
  encode_arg: Record<string, { fmt: string; value: unknown; bytes?: string; error?: string }>
  encode_returns: Record<string, { fmts: string[]; values: unknown[]; body?: string; error?: string }>
}

const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')

describe('请求参数编码与真实客户端逐字节一致', () => {
  it.each(Object.entries(golden.encode_arg).filter(([, c]) => c.bytes !== undefined))(
    'encodeArg(%s)',
    (_label, c) => {
      expect(hex(encodeArg(c.value, c.fmt))).toBe(hex(b(c.bytes!)))
    },
  )
})

describe('回复字段解码与服务端编码往返一致', () => {
  it.each(Object.entries(golden.encode_returns).filter(([, c]) => c.body !== undefined))(
    'decodeReturns(%s)',
    (_label, c) => {
      const { values, errorSection } = decodeReturns(b(c.body!), c.fmts)
      expect(values).toEqual(c.values)
      expect(errorSection.length).toBe(0) // 金样的 body 不含错误段
    },
  )
})

/**
 * 字符串回复的解法，对**真实客户端**（D-WIRE-4）。回复字节手工拼，期望值由客户端的
 * `parseGeneralResponse` 解出来；上面那份的字符串用例全是 ASCII，分不出五种格式各自怎么解。
 * 每种格式 × ASCII、空串、UTF-8 中文、GBK 中文、256 个字节值全表、两种编码都不合法的字节。
 */
const decodeGolden = JSON.parse(
  readFileSync(new URL('../../../../spec/golden/wire_decode.json', import.meta.url), 'utf8'),
) as { decode_reference: Record<string, { body: string; fmts: string[]; reference: unknown[] }> }

describe('字符串回复的解法与真实客户端逐格一致（wire_decode.json）', () => {
  it('五种格式 × 六种内容，用例数没有悄悄缩水', () => {
    const cells = Object.entries(decodeGolden.decode_reference)
    expect(cells.length).toBeGreaterThanOrEqual(30)
    const formats = new Set(cells.map(([, c]) => c.fmts.at(-1)))
    expect([...formats].sort()).toEqual(['**c', '*+c', '*-c', '*2c', '+*c'])
  })

  it.each(Object.entries(decodeGolden.decode_reference))('decodeReturns(%s)', (_label, c) => {
    const { values, errorSection } = decodeReturns(b(c.body), c.fmts)
    expect(values).toEqual(c.reference)
    expect(errorSection.length).toBe(0)
  })
})

describe('c 的二义：同一个格式串，字符串与数组产出不同的字节', () => {
  it('+*c 给 str 是「长度+内容」，给数组是「总字节+个数+逐条」', () => {
    expect(hex(encodeArg('hello', '+*c'))).toBe('0000000568656c6c6f')
    expect(hex(encodeArg(['a', 'bb'], '+*c'))).toBe('00000008000000020000000161000000026262')
  })
  it('这正是 array_string_args 存在的理由——格式串本身不说是哪种', () => {
    expect(hex(encodeArg('hi', '*+c'))).not.toBe(hex(encodeArg(['hi'], '*+c')))
  })
})

describe('计数来源三分', () => {
  const body = (hexStr: string) => new Uint8Array(Buffer.from(hexStr, 'hex'))

  it('*X 的计数来自**前一个**字段', () => {
    const { values } = decodeReturns(body('000000023f80000040000000'), ['i', '*f'])
    expect(values).toEqual([2, [1, 2]])
  })

  it('**X 的计数来自**第一个**字段，哪怕中间隔着别的', () => {
    // 首字段 2 决定末尾数组长度；中间那个 99 只是普通标量
    const { values } = decodeReturns(body('0000000200000063' + '3f80000040000000'), ['i', 'i', '**f'])
    expect(values).toEqual([2, 99, [1, 2]])
  })

  it('+*X 自带计数，不看任何别的字段', () => {
    const { values } = decodeReturns(body('00000003000000010000000200000003'), ['+*i'])
    expect(values).toEqual([[1, 2, 3]])
  })
})

describe('剩余字节就是错误段，交回给帧层', () => {
  it('声明字段读完后剩下的原样返回', () => {
    // i=1 + 零错误段(8B)
    const { values, errorSection } = decodeReturns(
      new Uint8Array(Buffer.from('00000001' + '0000000000000000', 'hex')),
      ['i'],
    )
    expect(values).toEqual([1])
    expect(errorSection.length).toBe(8)
  })

  it('剩下的不足 8 字节 ⇒ 明确报错，不当成「没有错误段」', () => {
    expect(() => decodeReturns(new Uint8Array(Buffer.from('00000001' + '0000', 'hex')), ['i'])).toThrow(
      /放不下.*错误段/,
    )
  })
})

describe('D-WIRE-3：*H 这类步长与元素大小不符的用法直接抛', () => {
  it('客户端会按 4 字节跨过 2 字节的元素，读出错位的数组', () => {
    expect(() => decodeReturns(new Uint8Array(8), ['i', '*H'])).toThrow(WireTypeError)
  })
  it('671 个方法里真实用到的 *X 都是 4 或 8 字节，不受影响', () => {
    for (const f of ['*f', '*i', '*I', '*d']) {
      expect(() => decodeReturns(new Uint8Array(Buffer.from('00000000', 'hex')), ['i', f])).not.toThrow()
    }
  })
})

describe('body 不够读时报清楚，不静默截断', () => {
  it('缺字节 ⇒ 抛并指出位置', () => {
    expect(() => decodeReturns(new Uint8Array(2), ['i'])).toThrow(/不够读/)
  })
})

/**
 * 字符串回复分格式解码（D-WIRE-4）：`*-c` / `*+c` / `**c` 是二进制串（逐字节一字符），
 * `+*c` / `*2c` 仍是 UTF-8——与参考客户端一致（`nanonis_patch.py`），不许统一。
 * `wire_types.json` 的字符串用例全是 ASCII，latin-1 与 UTF-8 给同一个答案；非 ASCII 的回复由
 * 上面的 `wire_decode.json` 逐格对参考客户端，下面几条是手拼字节的补充（256 个字节值的全表、
 * 计数按字节、两个辅助函数互为反函数），不依赖金样。
 */
describe('字符串回复：二进制串与 UTF-8 分格式解码', () => {
  const i32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  const ALL = Array.from({ length: 256 }, (_, i) => i)
  const GBK_SHUJU = [0xca, 0xfd, 0xbe, 0xdd] // 「数据」的 GBK 字节
  const UTF8_SHUJU = [0xe6, 0x95, 0xb0, 0xe6, 0x8d, 0xae] // 「数据」的 UTF-8 字节
  const bytesOf = (s: string): number[] => [...Buffer.from(s, 'latin1')]

  it('W1 · 256 个字节值一个不丢：*-c、*+c、**c 解出的串按 latin1 编回去逐字节相等', () => {
    // 只测几个汉字字节发现不了「TextDecoder('latin1') 其实是 windows-1252」——0x80–0x9F 要全表才露馅
    const cases = [
      { fmt: '*-c', fmts: ['i', '*-c'], body: [...i32(256), ...ALL], pick: (v: unknown[]) => v[1] as string },
      {
        fmt: '*+c',
        fmts: ['i', 'i', '*+c'],
        body: [...i32(4 + 256), ...i32(1), ...i32(256), ...ALL],
        pick: (v: unknown[]) => (v[2] as string[])[0]!,
      },
      {
        fmt: '**c',
        fmts: ['i', '**c'],
        body: [...i32(1), ...i32(256), ...ALL],
        pick: (v: unknown[]) => (v[1] as string[])[0]!,
      },
    ]
    for (const c of cases) {
      const { values, errorSection } = decodeReturns(Uint8Array.from(c.body), c.fmts)
      const s = c.pick(values)
      expect(s, c.fmt).toHaveLength(256)
      expect(bytesOf(s), c.fmt).toEqual(ALL)
      expect(errorSection.length, c.fmt).toBe(0)
    }
  })

  it('binaryString 与 binaryStringBytes 互为反函数；含 >0xFF 的串不是二进制串，不能静默截断', () => {
    const whole = Uint8Array.from([9, 9, ...ALL, 9])
    const view = whole.subarray(2, 258) // 带 byteOffset 的视图：回复 body 里的串就是这么切出来的
    const s = binaryString(view)
    expect(s).toHaveLength(256)
    expect([...binaryStringBytes(s)!]).toEqual(ALL)
    // Buffer.from('数', 'latin1') 会静默截成 [0x70]；这里必须明说「它不是二进制串」
    expect(bytesOf('数')).toEqual([0x70])
    expect(binaryStringBytes('数')).toBeNull()
    expect(binaryStringBytes('ab数')).toBeNull()
    expect([...binaryStringBytes('')!]).toEqual([])
  })

  it('W2 · +*c 与 *2c 仍是 UTF-8；GBK 字节在这里恰好变成 4 个 U+FFFD（参考实现的 errors=replace 同形）', () => {
    expect(decodeReturns(Uint8Array.from([...i32(6), ...UTF8_SHUJU]), ['+*c']).values).toEqual(['数据'])
    expect(decodeReturns(Uint8Array.from([...i32(4), ...GBK_SHUJU]), ['+*c']).values).toEqual(['�'.repeat(4)])
    const grid = decodeReturns(
      Uint8Array.from([...i32(1), ...i32(2), ...i32(6), ...UTF8_SHUJU, ...i32(4), ...GBK_SHUJU]),
      ['i', 'i', '*2c'],
    )
    expect(grid.values).toEqual([1, 2, [['数据', '�'.repeat(4)]]])
  })

  it('W3 · 计数仍按字节：夹着 GBK 双字节串，后面紧跟的整型字段照样读对', () => {
    const two = [...i32(4), ...GBK_SHUJU, ...i32(2), 0x61, 0x62] // 「数据」(GBK) 与 'ab'
    // *+c：第一个整型是总字节数（含每串 4 字节前缀）= (4+4) + (4+2)，第二个是个数
    const plus = decodeReturns(Uint8Array.from([...i32(14), ...i32(2), ...two, ...i32(42)]), ['i', 'i', '*+c', 'i'])
    expect(plus.values[0]).toBe(14)
    expect((plus.values[2] as string[]).map(bytesOf)).toEqual([GBK_SHUJU, [0x61, 0x62]])
    expect(plus.values[3]).toBe(42)
    // **c：个数取自第一个字段
    const star = decodeReturns(Uint8Array.from([...i32(2), ...two, ...i32(7)]), ['i', '**c', 'i'])
    expect((star.values[1] as string[]).map(bytesOf)).toEqual([GBK_SHUJU, [0x61, 0x62]])
    expect(star.values[2]).toBe(7)
  })
})
