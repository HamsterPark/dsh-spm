/**
 * 参数摘要与哈希。要钉的是**规范化**：键序不影响哈希，而人读到的顺序与哈希算的顺序一致。
 */
import { describe, expect, it } from 'vitest'
import { approvalDigest, argsHash, canonicalJson } from './args-hash.js'

describe('规范化', () => {
  it('键序不影响结果——审批卡与内核各自构造对象，键序不该让它们对不上', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(argsHash({ b: 1, a: 2 })).toBe(argsHash({ a: 2, b: 1 }))
  })

  it('数组顺序**是**语义的一部分，不排序', () => {
    expect(argsHash({ a: [1, 2] })).not.toBe(argsHash({ a: [2, 1] }))
  })

  it('嵌套也规范化', () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}')
  })

  it('undefined 丢掉，非有限数写成 null——它们不该出现在参数里，出现了也不能炸', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(canonicalJson({ a: NaN, b: Infinity })).toBe('{"a":null,"b":null}')
  })

  it('值不同就哈希不同（这是它存在的全部意义）', () => {
    expect(argsHash({ steps: 10 })).not.toBe(argsHash({ steps: 11 }))
    expect(argsHash({ direction: 'z-approach' })).not.toBe(argsHash({ direction: 'z-retract' }))
  })

  it('哈希是 6 位十六进制', () => {
    expect(argsHash({ a: 1 })).toMatch(/^[0-9a-f]{6}$/)
  })
})

describe('摘要', () => {
  it('键按字母序，与哈希用的规范化一致', () => {
    const d = approvalDigest('MotorMove', { steps: 10, direction: 'z-approach' })
    expect(d).toBe(`MotorMove(direction='z-approach', steps=10) args#${argsHash({ direction: 'z-approach', steps: 10 })}`)
  })

  it('长字符串截断并标注长度——不让一个长值把摘要挤爆', () => {
    const d = approvalDigest('X', { note: 'あ'.repeat(100) })
    expect(d).toContain('…')
    expect(d).toContain('(100字)')
  })

  it('参数太多时只显示前几个并说明还有多少', () => {
    const args = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, i]))
    expect(approvalDigest('X', args)).toContain('另 3 个')
  })

  it('空参数也给得出摘要', () => {
    expect(approvalDigest('StopScan', {})).toBe(`StopScan() args#${argsHash({})}`)
  })
})
