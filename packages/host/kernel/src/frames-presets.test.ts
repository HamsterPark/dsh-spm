/**
 * `.npy` 字节与 Z 参数组存储 —— 逐条对旧仓。
 *
 * `.npy` 那 8 份比的是**完整字节**：这个格式的产物是一份文件，而一个「大概能用
 * numpy 读回来」的实现，在 `np.load` 抛异常之前一切看起来都正常——那时那一帧
 * 已经扫完了，缓冲区里也没有第二份。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NPY_ALIGN, encodeNpyFloat64, encodeNpyFrame, npyShapeLiteral } from './npy.js'
import { pyFloatRepr } from './si.js'
import {
  MAX_NAME_CHARS,
  MAX_PRESETS,
  PRESET_BOUNDS,
  PresetRejected,
  PresetStore,
  RESERVED_NAMES,
  TIME_CONSTANT_BOUNDS,
  sanitizePreset,
  type StoredPreset,
} from './zctrl-preset.js'

interface NpyCase {
  shape: number[]
  size: number
  values: unknown
  bytes_hex: string
  n_bytes: number
}
interface SanCase {
  input: Record<string, unknown>
  ok: boolean
  out: Record<string, unknown> | null
  error: string
}
interface UpsertCase {
  steps: { name: string; overwrite: boolean; ok: boolean; error: string }[]
  stored: Record<string, unknown>[]
  available: string[]
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/frames_presets.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    max_presets: number
    max_name_chars: number
    reserved_names: string[]
    bounds: Record<string, number[]>
    time_constant_bounds: number[]
  }
  py_repr: Record<string, string>
  npy: Record<string, NpyCase>
  sanitize_preset: Record<string, SanCase>
  upsert_preset: Record<string, UpsertCase>
}

const hex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const revive = (v: unknown): unknown =>
  v === 'NaN' ? Number.NaN : Array.isArray(v) ? v.map(revive) : v

/** 导出时那几档扫描档名（`sanitizePreset` 的重名检查要它）。 */
const TIERS = ['slow', 'atomic_verify', 'atomic', 'highres', 'roi', 'survey']

describe('pyFloatRepr —— 换指数记法的那两条带', () => {
  // CPython 在 `decpt <= -4 || decpt > 16` 时用指数，而 JS 的 `String()` 要到
  // `< 1e-6` / `>= 1e21`。中间两条带分岔，而 `setpoint_a` 的上界正是 1e-7 ——
  // 超界报文里印的就是这个数。146 条 SI 金样没覆盖到这一带，是参数组那 28 格
  // 把它照出来的。
  for (const [key, want] of Object.entries(golden.py_repr)) {
    it(key, () => {
      expect(pyFloatRepr(Number(key))).toBe(want)
    })
  }

  it('负零保号 —— 一个 `-0` 多半意味着上游做过一次取反', () => {
    expect(pyFloatRepr(-0)).toBe('-0.0')
    expect(pyFloatRepr(0)).toBe('0.0')
  })
})

describe('.npy —— 8 份逐字节', () => {
  for (const [name, c] of Object.entries(golden.npy)) {
    it(name, () => {
      const vals = revive(c.values) as number[] | number[][]
      const flat = (Array.isArray(vals[0]) ? (vals as number[][]).flat() : vals) as number[]
      const got = encodeNpyFloat64(flat, c.shape)
      expect(got.length).toBe(c.n_bytes)
      expect(hex(got)).toBe(c.bytes_hex)
    })
  }

  it('二维入口与展平入口写出**同一份字节**', () => {
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
    ]
    expect(hex(encodeNpyFrame(rows))).toBe(hex(encodeNpyFloat64(rows.flat(), [2, 3])))
  })

  it('头部补齐到 **64 的倍数** —— 那不是排版，是数据段的对齐', () => {
    for (const shape of [[1], [2, 3], [128, 1], [7, 11], [1000]]) {
      const n = shape.reduce((a, b) => a * b, 1)
      const b = encodeNpyFloat64(new Array<number>(n).fill(0), shape)
      const headerLen = b[8]! | (b[9]! << 8)
      expect((10 + headerLen) % NPY_ALIGN, `shape=${shape.join('x')}`).toBe(0)
      expect(b[10 + headerLen - 1]).toBe(0x0a) // 头以 \n 收尾
    }
  })

  it('shape 的写法：一维 `(4,)`、多维 `(2, 3)`、零维 `()`', () => {
    expect(npyShapeLiteral([4])).toBe('(4,)')
    expect(npyShapeLiteral([2, 3])).toBe('(2, 3)')
    expect(npyShapeLiteral([])).toBe('()')
  })

  it('**形状撒谎就抛** —— 一份几何错乱的图比一个错误更坏', () => {
    expect(() => encodeNpyFloat64([1, 2, 3], [2, 2])).toThrow(/形状与样本数对不上/)
    expect(() => encodeNpyFrame([[1, 2], [3]])).toThrow(/行长不齐/)
  })

  it('NaN 原样写出去 —— 它是「这一行没采到」的记号', () => {
    const b = encodeNpyFloat64([Number.NaN], [1])
    const dv = new DataView(b.buffer, b.byteLength - 8, 8)
    expect(Number.isNaN(dv.getFloat64(0, true))).toBe(true)
  })
})

describe('sanitizePreset —— 28 格逐条对旧仓', () => {
  for (const [name, c] of Object.entries(golden.sanitize_preset)) {
    it(name, () => {
      if (c.ok) {
        expect(sanitizePreset(c.input, TIERS)).toEqual(c.out)
      } else {
        expect(() => sanitizePreset(c.input, TIERS)).toThrow(PresetRejected)
        try {
          sanitizePreset(c.input, TIERS)
        } catch (e) {
          expect((e as Error).message).toBe(c.error)
        }
      }
    })
  }
})

describe('参数组的四条纪律', () => {
  it('**值以 SI 字符串存** —— 界面上看到的就是模型要写的那个', () => {
    // 一次经过存储的往返不可能悄悄把前缀变成指数。
    const out = sanitizePreset({ name: 'g', p_gain: '3p', i_gain: '180n' })
    expect(out.p_gain).toBe('3p')
    expect(out.i_gain).toBe('180n')
  })

  it('**前缀不可省略** —— 裸数字仍然是合法的数，错一万亿倍也没人发现', () => {
    for (const bare of ['3', '180', '3e-12']) {
      expect(() => sanitizePreset({ name: 'g', p_gain: bare, i_gain: '180n' })).toThrow(
        /前缀不可省略/,
      )
    }
  })

  it('**从不夹紧** —— 被悄悄改小的值会让你以为自己设的是原来那个数', () => {
    try {
      sanitizePreset({ name: 'g', p_gain: '1m', i_gain: '180n' })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toContain('**拒绝写入,不会自动夹到边界**')
    }
  })

  it('保留名与档名都不许遮蔽', () => {
    for (const n of [...RESERVED_NAMES, 'highres', 'SURVEY']) {
      expect(() => sanitizePreset({ name: n, p_gain: '3p', i_gain: '180n' }, TIERS)).toThrow(
        PresetRejected,
      )
    }
  })

  it('时间常数是**派生的**，不存 —— 存下来只会和定义它的那一对漂移开', () => {
    const out = sanitizePreset({ name: 'g', p_gain: '3p', i_gain: '180n' })
    expect(Object.keys(out).sort()).toEqual(['i_gain', 'name', 'p_gain'])
    // 但它照样是判据：P/I 落在界外就拒
    expect(() => sanitizePreset({ name: 'g', p_gain: '1u', i_gain: '1p' })).toThrow(/时间常数/)
  })

  it('常量与旧仓一致', () => {
    expect(MAX_PRESETS).toBe(golden.constants.max_presets)
    expect(MAX_NAME_CHARS).toBe(golden.constants.max_name_chars)
    expect([...RESERVED_NAMES]).toEqual(golden.constants.reserved_names)
    expect([...TIME_CONSTANT_BOUNDS]).toEqual(golden.constants.time_constant_bounds)
    for (const [k, v] of Object.entries(golden.constants.bounds)) {
      expect([...(PRESET_BOUNDS[k] as readonly number[])], k).toEqual(v)
    }
  })
})

describe('PresetStore —— 6 格逐条对旧仓', () => {
  for (const [name, c] of Object.entries(golden.upsert_preset)) {
    it(name, () => {
      const store = new PresetStore(() => TIERS)
      const log: { name: string; overwrite: boolean; ok: boolean; error: string }[] = []
      for (const step of c.steps) {
        // 重放金样那一串输入：名字与 overwrite 已经记下来了，其余取那一格的定值
        const raw = rawFor(name, step.name)
        try {
          store.upsert(raw, step.overwrite)
          log.push({ name: step.name, overwrite: step.overwrite, ok: true, error: '' })
        } catch (e) {
          log.push({
            name: step.name,
            overwrite: step.overwrite,
            ok: false,
            error: (e as Error).message,
          })
        }
      }
      expect(log).toEqual(c.steps)
      expect(store.list()).toEqual(c.stored)
      expect(store.availableNames()).toEqual(c.available)
    })
  }
})

/** 金样每一格的输入是定值，这里按名字还原。 */
function rawFor(caseName: string, name: string): Record<string, unknown> {
  const base = { name, p_gain: '3p', i_gain: '180n' }
  if (caseName === 'duplicate_overwritten' && name === 'gentle') {
    // 第二步换了 i_gain —— 覆盖之后存的必须是新的那个
    return { ...base, i_gain: '200n' }
  }
  if (caseName === 'two_distinct' && name === 'firm') return { ...base, p_gain: '5p' }
  return base
}

describe('存储的三条', () => {
  it('同名**默认拒**，覆盖要显式说', () => {
    const s = new PresetStore(() => TIERS)
    s.upsert({ name: 'g', p_gain: '3p', i_gain: '180n' })
    expect(() => s.upsert({ name: 'g', p_gain: '5p', i_gain: '180n' })).toThrow(/已存在/)
    s.upsert({ name: 'g', p_gain: '5p', i_gain: '180n' }, true)
    expect(s.list()[0]?.p_gain).toBe('5p')
  })

  it('重名**不分大小写** —— 否则 `gentle` 与 `GENTLE` 会各存一份', () => {
    const s = new PresetStore(() => TIERS)
    s.upsert({ name: 'gentle', p_gain: '3p', i_gain: '180n' })
    expect(() => s.upsert({ name: 'GENTLE', p_gain: '3p', i_gain: '180n' })).toThrow(/已存在/)
    expect(s.delete('Gentle')).toBe(true)
    expect(s.list()).toEqual([])
  })

  it('**落盘失败只记不抛** —— 内存里已经改好了', () => {
    const s = new PresetStore(
      () => TIERS,
      () => {
        throw new Error('磁盘满了')
      },
    )
    expect(() => s.upsert({ name: 'g', p_gain: '3p', i_gain: '180n' })).not.toThrow()
    expect(s.list()).toHaveLength(1)
  })

  it('落盘 sink 收到的是**快照**，不是内部那个数组', () => {
    let seen: readonly StoredPreset[] = []
    const s = new PresetStore(() => TIERS, (all) => (seen = all))
    s.upsert({ name: 'g', p_gain: '3p', i_gain: '180n' })
    const before = seen.length
    s.upsert({ name: 'h', p_gain: '3p', i_gain: '180n' })
    expect(before).toBe(1) // 那一份没有跟着长
  })

  it('删一个不存在的返回 false，而且不触发落盘', () => {
    let flushes = 0
    const s = new PresetStore(() => TIERS, () => (flushes += 1))
    expect(s.delete('nope')).toBe(false)
    expect(flushes).toBe(0)
  })

  it('`availableNames` = 两个保留名 + 档名 + 自定义组', () => {
    const s = new PresetStore(() => TIERS)
    s.upsert({ name: 'gentle', p_gain: '3p', i_gain: '180n' })
    expect(s.availableNames()).toEqual([...RESERVED_NAMES, ...TIERS, 'gentle'])
  })
})
