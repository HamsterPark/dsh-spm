import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WireTypeError, decodeReturns, encodeArg } from './types.js'

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
