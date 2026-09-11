/**
 * 扫描主链的判定件 —— 逐格对旧仓。
 *
 * 每一组都钉着一次真机事故，注释里写着是哪一次。这些判据的共同形状是
 * **「一个不是答案的值，被折进了那个让人安心的答案」**——0.1 s 的默认、回声当读数、
 * 空数组当「没选」、`None == 1` 为假当「已关」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BOUND_REL_TOL,
  FACTORY_TIERS,
  estimateScanSeconds,
  resolveLineTime,
  tierByName,
  tierForSize,
} from './scan-policy.js'
import {
  FRAME_TOL_ABS_M,
  FRAME_TOL_DEG,
  FRAME_TOL_FRAC,
  frameExceeds,
  frameExtent,
  frameReadbackMismatch,
  matchSignal,
  piezoHalfRangeM,
} from './scan-frame.js'
import {
  GET_OFF,
  GET_ON,
  PROPS_IX_MODULES,
  PROPS_IX_MODULES_COUNT,
  PROPS_IX_SERIES_NAME,
  PROPS_N_FIELDS,
  SET_AUTOSAVE_ALL,
  SET_NO_CHANGE,
  SET_OFF,
  continuousState,
  scanPropsContinuous,
  scanPropsModuleCount,
  scanPropsModules,
  scanPropsSeriesName,
  unwrapScalar,
} from './scan-reply.js'
import { revive } from './scan-reply.test.js'

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/scan_chain.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: Record<string, number>
  tiers: { name: string; upper_size_m: number | null; pixels: number; line_time_s: number }[]
  tier_for_size: Record<string, { size_m: number; tier: string; line_time_s: number; pixels: number }>
  resolve_line_time: Record<string, { explicit: unknown; size_m: number | null; line_time_s: number; source: string }>
  estimate_scan_seconds: Record<string, number>
  frame_extent: Record<string, { input: unknown[]; extent: number[] }>
  piezo_half_range: Record<string, { input: unknown[]; half_m: number | null }>
  frame_exceeds: Record<string, { input: unknown[]; over: Record<string, unknown> | null }>
  frame_readback_mismatch: Record<string, { requested: unknown[]; readback: unknown; mismatch: unknown }>
  match_signal: { signals: string[]; cases: Record<string, number | null> }
  scan_props: Record<string, Record<string, unknown>>
  continuous_state: Record<string, boolean | null>
  unwrap_scalar: Record<string, { input: unknown; out: unknown }>
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)

describe('常量', () => {
  it('逐字相等', () => {
    const c = golden.constants
    expect(FRAME_TOL_FRAC).toBe(c['frame_tol_frac'])
    expect(FRAME_TOL_ABS_M).toBe(c['frame_tol_abs_m'])
    expect(FRAME_TOL_DEG).toBe(c['frame_tol_deg'])
    expect(BOUND_REL_TOL).toBe(c['bound_rel_tol'])
    expect(PROPS_N_FIELDS).toBe(c['props_n_fields'])
    expect(PROPS_IX_SERIES_NAME).toBe(c['props_ix_series_name'])
    expect(PROPS_IX_MODULES_COUNT).toBe(c['props_ix_modules_count'])
    expect(PROPS_IX_MODULES).toBe(c['props_ix_modules'])
    expect([SET_NO_CHANGE, SET_OFF, SET_AUTOSAVE_ALL]).toEqual([
      c['set_no_change'], c['set_off'], c['set_autosave_all'],
    ])
    expect([GET_ON, GET_OFF]).toEqual([c['get_on'], c['get_off']])
  })

  it('⚠️ SET 的「关」是 **2**，GET 的「关」是 **0** —— 两套编码', () => {
    // 一个 2 到了 GET 那一侧曾经算成「确认已关」，那正是 2026-08-19 的形状。
    expect(SET_OFF).toBe(2)
    expect(GET_OFF).toBe(0)
    expect(continuousState(SET_OFF)).toBeNull()
  })
})

describe('档位表 —— 2026-08-09「一帧 34 分钟」那次改档', () => {
  it('六档逐字相等', () => {
    expect(
      FACTORY_TIERS.map((t) => ({
        name: t.name,
        upper_size_m: t.upperSizeM,
        pixels: t.pixels,
        line_time_s: t.lineTimeS,
      })),
    ).toEqual(golden.tiers.map((t) => ({
      name: t.name, upper_size_m: t.upper_size_m, pixels: t.pixels, line_time_s: t.line_time_s,
    })))
  })

  for (const [name, c] of Object.entries(golden.tier_for_size)) {
    it(`tierForSize ${name}`, () => {
      const t = tierForSize(c.size_m)
      expect([t.name, t.lineTimeS, t.pixels]).toEqual([c.tier, c.line_time_s, c.pixels])
    })
  }

  it('**闭上界**：边界值落在小的那一档', () => {
    // 出厂表里正好 100 nm 属 highres 而不是 roi。
    expect(tierForSize(100e-9).name).toBe('highres')
    expect(tierForSize(100.001e-9).name).toBe('roi')
    expect(tierForSize(2e-9).name).toBe('slow')
  })

  it('兜底档接住所有更大的尺寸', () => {
    expect(tierForSize(1).name).toBe('survey')
    expect(FACTORY_TIERS[FACTORY_TIERS.length - 1]?.upperSizeM).toBeNull()
  })

  it('像素统一 256 **不牺牲针尖** —— 真正压针尖的是 lineTime', () => {
    // 行数减半让帧时减半，而每像素驻留时间反而翻倍。
    const highres = tierByName('highres')!
    expect(highres.pixels).toBe(256)
    expect(estimateScanSeconds(highres.pixels, highres.lineTimeS)).toBe(512)
    // 旧表那一档：512 px × 2.0 s × 2 = 2048 s = 34 分 8 秒
    expect(estimateScanSeconds(512, 2.0)).toBe(2048)
  })

  it('按名字取档 —— `slow` 可以选给任意尺寸', () => {
    expect(tierByName('slow')?.lineTimeS).toBe(1.75)
    expect(tierByName('SLOW')?.name).toBe('slow')
    expect(tierByName('nope')).toBeNull()
    expect(tierByName('')).toBeNull()
  })
})

describe('resolveLineTime —— 14 格（2026-08-12 刮坏针尖那次）', () => {
  for (const [name, c] of Object.entries(golden.resolve_line_time)) {
    it(name, () => {
      const got = resolveLineTime(c.explicit, c.size_m)
      expect([got.lineTimeS, got.source]).toEqual([c.line_time_s, c.source])
    })
  }

  it('**显式 > 档位表 > 兜底**，而 `source` 说得出是哪一条', () => {
    // 一个光秃秃的 1.2 决定不了它来自档位表还是来自某人手打。
    expect(resolveLineTime(0.25, 50e-9).source).toBe('explicit')
    expect(resolveLineTime(null, 50e-9).source).toBe('tier:highres')
  })

  it('显式给 0 / 负数 / 垃圾 ⇒ **退回档位表**，不是退回 0.1', () => {
    // 三份实现里两份把 0.1 s 当默认，而 0.1 s 在 50 nm 图上是 488 nm/s。
    for (const bad of [0, -1, 'nope', Number.NaN]) {
      expect(resolveLineTime(bad, 50e-9).lineTimeS).toBe(1.0)
    }
  })

  it('尺寸读不到 ⇒ 落到**最慢**那一档 —— 不知道就别扫快', () => {
    expect(resolveLineTime(null, null).source).toBe('tier:slow')
    expect(resolveLineTime(null, 0).source).toBe('tier:slow')
  })

  for (const [name, want] of Object.entries(golden.estimate_scan_seconds)) {
    it(`estimateScanSeconds ${name}`, () => {
      const [px, lt] = name.split('px@')
      expect(estimateScanSeconds(Number(px), Number((lt ?? '').replace('s', '')))).toBe(want)
    })
  }
})

describe('frameExtent —— 必须算角度', () => {
  for (const [name, c] of Object.entries(golden.frame_extent)) {
    it(name, () => {
      const [cx, cy, w, h, a] = c.input as (number | null)[]
      const e = frameExtent(n(cx), n(cy), n(w), n(h), a)
      expect([e.minX, e.maxX, e.minY, e.maxY]).toEqual(c.extent)
    })
  }

  it('转 45° 的框对角线伸出去 √2 倍 —— 只比 `center ± size/2` 会系统性少算', () => {
    const flat = frameExtent(0, 0, 100e-9, 100e-9, 0)
    const rot = frameExtent(0, 0, 100e-9, 100e-9, 45)
    expect(flat.maxX).toBeCloseTo(50e-9, 15)
    expect(rot.maxX).toBeCloseTo(50e-9 * Math.SQRT2, 15)
  })
})

describe('piezoHalfRangeM —— 增益已经折进 calibration 里了', () => {
  for (const [name, c] of Object.entries(golden.piezo_half_range)) {
    it(name, () => {
      const [cal, lo, hi, on] = c.input as (number | null | boolean)[]
      expect(piezoHalfRangeM(cal as number | null, lo as number | null, hi as number | null, on as boolean)).toBe(
        c.half_m,
      )
    })
  }

  it('本机实测：sensitivity 8.8966e-9 × HVA gain 15 = calibration，**别再乘一次**', () => {
    expect(piezoHalfRangeM(1.3345e-7)).toBeCloseTo(1.3345e-6, 15)
  })

  it('限位**没启用**时那对数字不收窄任何东西', () => {
    expect(piezoHalfRangeM(1.3345e-7, -3, 3, false)).toBe(piezoHalfRangeM(1.3345e-7))
    expect(piezoHalfRangeM(1.3345e-7, -3, 3, true)).toBeCloseTo(1.3345e-7 * 3, 15)
  })

  it('标定读不到 ⇒ `null`，**不是** 0', () => {
    expect(piezoHalfRangeM(null)).toBeNull()
  })
})

describe('frameExceeds —— 2026-08-28：那 15 % 不是数据', () => {
  for (const [name, c] of Object.entries(golden.frame_exceeds)) {
    it(name, () => {
      const [cx, cy, w, h, a, hx, hy] = c.input as (number | null)[]
      const got = frameExceeds(n(cx), n(cy), n(w), n(h), a, hx, hy)
      expect(got === null ? null : JSON.parse(JSON.stringify(got))).toEqual(c.over)
    })
  }

  it('真机那一帧：中心 (639, −597) nm、边长 2 µm ⇒ +x 超 304.5 nm', () => {
    // 溢出的 39 列里相邻列差从 119 pm 掉到 43 pm —— 针尖已经不再横向移动。
    const over = frameExceeds(639e-9, -597e-9, 2e-6, 2e-6, 0, 1.3345e-6, 1.3345e-6)!
    expect((over.x_high_m as number) * 1e9).toBeCloseTo(304.5, 6)
    expect((over.y_low_m as number) * 1e9).toBeCloseTo(262.5, 6)
  })

  it('**半程读不到 ⇒ `null`（判不了），不是「没超」**', () => {
    // 5 µm 的框在任何机器上都超，但没有半程就不该下断言。
    expect(frameExceeds(0, 0, 5e-6, 5e-6, 0, null, 1.3345e-6)).toBeNull()
  })

  it('转角会把一个轴对齐时装得下的框推出去', () => {
    // 中心 1.27 µm、边长 100 nm：轴对齐时 maxX = 1.32 µm < 半程 1.3345 µm；
    // 转 45° 之后半对角线是 50√2 = 70.7 nm ⇒ maxX = 1.3407 µm，超出去。
    const inside = frameExceeds(1.27e-6, 0, 100e-9, 100e-9, 0, 1.3345e-6, 1.3345e-6)
    const rotated = frameExceeds(1.27e-6, 0, 100e-9, 100e-9, 45, 1.3345e-6, 1.3345e-6)
    expect(inside).toBeNull()
    expect(rotated).not.toBeNull()
  })
})

describe('frameReadbackMismatch —— 回声不是读数', () => {
  for (const [name, c] of Object.entries(golden.frame_readback_mismatch)) {
    it(name, () => {
      const req = (c.requested as unknown[]).map((v) => (typeof v === 'number' ? v : null))
      const got = frameReadbackMismatch(req, revive(c.readback) as unknown[] | null)
      expect(got === null ? null : JSON.parse(JSON.stringify(got))).toEqual(c.mismatch)
    })
  }

  it('仪器把框夹到量程内 ⇒ 报出来，**不夹紧**', () => {
    // 上层完全看不出来的话，之后每一张图的坐标都是假的，而图本身看着完全正常。
    const m = frameReadbackMismatch([639e-9, -597e-9, 2e-6, 2e-6, 0], [500e-9, -597e-9, 2e-6, 2e-6, 0]) as Record<
      string,
      { requested: number; readback: number }
    >
    expect(Object.keys(m)).toEqual(['center_x_m'])
    expect(m['center_x_m']?.readback).toBe(500e-9)
  })

  it('**读不到不是对上了**', () => {
    expect(frameReadbackMismatch([0, 0, 1e-7, 1e-7, 0], null)).toEqual({ unreadable: true })
    expect(frameReadbackMismatch([0, 0, 1e-7, 1e-7, 0], [0, 0, 1e-7])).toEqual({ unreadable: true })
    expect(frameReadbackMismatch([0, 0, 1e-7, 1e-7, 0], [Number.NaN, 0, 1e-7, 1e-7, 0])).toEqual({
      unreadable: true,
    })
  })

  it('容差是**相对的**，但请求值接近 0 时有绝对下限', () => {
    expect(frameReadbackMismatch([0, 0, 1e-7, 1e-7, 0], [0, 0, 1e-7 * 1.0001, 1e-7, 0])).toBeNull()
    expect(frameReadbackMismatch([0, 0, 1e-7, 1e-7, 0], [1e-11, 0, 1e-7, 1e-7, 0])).not.toBeNull()
  })
})

describe('matchSignal —— 跳过而不是猜', () => {
  for (const [q, want] of Object.entries(golden.match_signal.cases)) {
    it(`${q === '' ? '(空串)' : q}`, () => {
      expect(matchSignal(q, golden.match_signal.signals)).toBe(want)
    })
  }

  it('前缀匹配要**带边界** —— 否则 `Z` 会撞上 `Z-Controller` 那一类', () => {
    expect(matchSignal('Z', ['Z-Controller (m)', 'Z (m)'])).toBe(1)
    expect(matchSignal('Cur', ['Current (A)'])).toBeNull()
  })

  it('对不上就是 `null` —— 调用方跳过这个通道，不往下猜', () => {
    expect(matchSignal('Nope', golden.match_signal.signals)).toBeNull()
  })
})

describe('Scan_PropsGet 的五个解析器', () => {
  for (const [name, c] of Object.entries(golden.scan_props)) {
    it(name, () => {
      const body = revive(c['body'])
      expect(scanPropsContinuous(body) ?? null).toEqual(c['continuous_flag'])
      expect(continuousState(scanPropsContinuous(body))).toEqual(c['continuous_state'])
      expect(scanPropsModules(body)).toEqual(c['modules'])
      expect(scanPropsModuleCount(body)).toEqual(c['module_count'])
      expect(scanPropsSeriesName(body)).toEqual(c['series_name'])
    })
  }

  it('**零个模块是一个事实，找不到数组不是** —— 它们不能折成同一个 `[]`', () => {
    // 选了零个模块时写回 `[]` 在两种可能的协议语义下都可证是空操作，
    // 那是唯一一种没读到清单也能安全下发的情形。
    const zero = Array.from({ length: 16 }, (_, i) => (i === 8 ? 0 : i === 9 ? [] : 0))
    expect(scanPropsModuleCount(zero)).toBe(0)
    expect(scanPropsModules(zero)).toEqual([])
    // 而一个找不到数组的回包是 `null`（未知）
    expect(scanPropsModuleCount([0, 1, 2, 3])).toBeNull()
    expect(scanPropsModules([0, 1, 2, 3])).toEqual([])
  })

  it('声明的个数与解出的数组**不一致 ⇒ 未知，绝不修补**', () => {
    const bad = Array.from({ length: 16 }, (_, i) => (i === 8 ? 3 : i === 9 ? ['A', 'B'] : 0))
    expect(scanPropsModuleCount(bad)).toBeNull()
    // 但数组本身照样读得出来 —— 那是另一个问题
    expect(scanPropsModules(bad)).toEqual(['A', 'B'])
  })

  it('模块名数组在 **body 里面**，不在顶层 —— 原来那段循环找错了层', () => {
    // 找错层 ⇒ moduleNames 每次都空 ⇒ 兜底一直在生效 ⇒ 写死的 5 个名字
    // 每一次扫描都覆盖掉用户配的清单。
    expect(scanPropsModules(['', '<bytes>', ['Bias', 'Z-Controller']])).toEqual([
      'Bias',
      'Z-Controller',
    ])
  })

  it('序列名：**一次读，一个答案**', () => {
    // 空序列名写进 Scan_PropsSet 会把用户配的文件名前缀打回 unnamed####。
    const full = Array.from({ length: 16 }, (_, i) => (i === 4 ? 'Au111' : 0))
    expect(scanPropsSeriesName(full)).toBe('Au111')
    expect(scanPropsSeriesName([0, ['A'], 'Au111'])).toBe('Au111') // 短 body 走启发式
    expect(scanPropsSeriesName([0, 1, 2])).toBe('')
  })
})

describe('continuousState —— 三态', () => {
  for (const [flag, want] of Object.entries(golden.continuous_state)) {
    it(`flag=${flag}`, () => {
      // 键是 Python 的 `repr`：`'0'`（带引号）是字符串，`0` 是整数。
      const v: unknown =
        flag === 'None' ? null
        : flag === 'True' ? true
        : flag === 'False' ? false
        : flag.startsWith("'") ? flag.slice(1, -1)
        : Number(flag)
      expect(continuousState(v)).toBe(want)
    })
  }

  it('**读不到不是「没开着」** —— 2026-08-19 那次就是这么答成「一切正常」的', () => {
    expect(continuousState(null)).toBeNull()
    expect(continuousState(undefined)).toBeNull()
    expect(continuousState(2)).toBeNull()
    expect(continuousState(-1)).toBeNull()
  })
})

describe('unwrapScalar', () => {
  for (const [name, c] of Object.entries(golden.unwrap_scalar)) {
    it(name, () => {
      expect(unwrapScalar(revive(c.input))).toEqual(c.out)
    })
  }

  it('多元素 ⇒ `null`，**不取第 0 个**', () => {
    expect(unwrapScalar([7, 8])).toBeNull()
    expect(unwrapScalar([])).toBeNull()
    expect(unwrapScalar([7])).toBe(7)
  })
})
