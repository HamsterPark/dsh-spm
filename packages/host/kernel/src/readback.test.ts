/**
 * `valuesMatch` —— 「仪器收下我发过去的那个数了吗」。
 *
 * 这一组的重点不是覆盖率，是**两端各自说清**：
 * 容差要宽到放得过 float32 往返噪声（~4e-9），窄到拦得住任何真的损坏（1e12 倍）。
 * 中间那一大片本来就不该有人踩进去。
 */
import { describe, expect, it } from 'vitest'
import { READBACK_REL_TOL, valuesMatch } from './readback.js'

/** float32 往返：`3e-12` 在线上打成 float32 再读回来就是这个数。 */
const F32_3P = 2.9999999880125916e-12

describe('valuesMatch', () => {
  it('相等', () => {
    expect(valuesMatch(1, 1)).toEqual({ ok: true, detail: '' })
    expect(valuesMatch(0, 0)).toEqual({ ok: true, detail: '' })
    expect(valuesMatch(-2.5, -2.5).ok).toBe(true)
  })

  it('**float32 往返照样算收下了** —— 真机上每一次写增益都要过这一关', () => {
    // 2026-09-13：这里曾经是精确相等，于是真机上 SetZCtrlGain 每次都失败回滚，
    // 而报文写着「相差 1 倍」。合成回包是精确回显，金样一次都照不出来。
    expect(valuesMatch(3e-12, F32_3P).ok).toBe(true)
    expect(valuesMatch(1e-4, 9.999999747378752e-5).ok).toBe(true)
    expect(valuesMatch(150e-12, 1.4999999853326784e-10).ok).toBe(true)
  })

  it('容差的两端：1e-3 之内放过，之外拒', () => {
    // 相对差恰好小于 / 大于 rel_tol。`isclose` 用的是 max(|a|,|b|) 作分母。
    expect(valuesMatch(1, 1 + READBACK_REL_TOL * 0.9).ok).toBe(true)
    expect(valuesMatch(1, 1 + READBACK_REL_TOL * 1.1).ok).toBe(false)
    expect(valuesMatch(1e-12, 1.0005e-12).ok).toBe(true)
    expect(valuesMatch(1e-12, 1.01e-12).ok).toBe(false)
  })

  it('**量级错照样拒** —— 容差不是放行', () => {
    const v = valuesMatch(3e-12, 3.0)
    expect(v.ok).toBe(false)
    // 那份 2026-08-03 的报告把这两个数叫做「float32 精度范围内」。
    expect(v.detail).toBe('请求 3e-12, 读回 3.0(相差 1e+12 倍)')
  })

  it('比值逐字：`%.3g`', () => {
    expect(valuesMatch(1, 2).detail).toBe('请求 1.0, 读回 2.0(相差 2 倍)')
    expect(valuesMatch(1, 0.5).detail).toBe('请求 1.0, 读回 0.5(相差 0.5 倍)')
    expect(valuesMatch(3, 1).detail).toBe('请求 3.0, 读回 1.0(相差 0.333 倍)')
  })

  it('请求 0：分母是 0，那句话换一种写法', () => {
    expect(valuesMatch(0, 1)).toEqual({ ok: false, detail: '请求 0, 读回 1.0' })
  })

  it('**读不到不是一样**', () => {
    for (const bad of [null, undefined, '很小', {}, []]) {
      const v = valuesMatch(1, bad)
      expect(v.ok, String(bad)).toBe(false)
      expect(v.detail).toMatch(/^无法比较: /)
    }
  })

  it('NaN 不可比较 —— 它穿得过任何一个不等式', () => {
    expect(valuesMatch(1, Number.NaN)).toEqual({
      ok: false,
      detail: '请求 1.0, 读回 nan(NaN 不可比较)',
    })
    expect(valuesMatch(Number.NaN, Number.NaN).ok).toBe(false)
  })

  it('±∞：自己跟自己相等，跟别的都不等', () => {
    expect(valuesMatch(Infinity, Infinity).ok).toBe(true)
    expect(valuesMatch(Infinity, 1e300).ok).toBe(false)
    expect(valuesMatch(Infinity, -Infinity).ok).toBe(false)
  })

  it('数值字符串按 Python 的 `float()` 认', () => {
    expect(valuesMatch('3e-12', F32_3P).ok).toBe(true)
    expect(valuesMatch(1, ' 1.0 ').ok).toBe(true)
    // `float('0x10')` 在 Python 里是 ValueError —— JS 的 Number() 会认，收窄掉
    expect(valuesMatch(16, '0x10').ok).toBe(false)
  })

  it('容差可以传，默认是 READBACK_REL_TOL', () => {
    expect(READBACK_REL_TOL).toBe(1e-3)
    expect(valuesMatch(1, 1.05).ok).toBe(false)
    expect(valuesMatch(1, 1.05, 0.1).ok).toBe(true)
  })
})
