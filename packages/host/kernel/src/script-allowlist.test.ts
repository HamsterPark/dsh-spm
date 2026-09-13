/**
 * 脚本白名单 —— **fail-closed 的每一种「读不懂」都要归到同一个答案上**。
 *
 * 这道闸与本仓别的闸不同：它后面没有第二层。脚本跑在 RT 控制器上，一次 `safeCall`
 * 都不发，于是安全闸 / 模式闸 / 中止闸 / HITL 全都看不见它。
 * **对这份文件没有任何一种读法能把闸打开。**
 */
import { describe, expect, it } from 'vitest'
import {
  SCRIPT_ALLOWLIST_FILE,
  gateScriptSlot,
  lutOutOfRange,
  parseScriptAllowlist,
  scriptRefusal,
  vettedSlots,
  type VettedSlot,
} from './index.js'

const GOOD = {
  allowed_slots: [
    { slot: 3, name: '延时扫描', description: '泵浦-探测', allow_lut_write: true, lut_min: 0, lut_max: 10 },
    { slot: 5, name: '脉冲串', description: '', allow_lut_write: false },
  ],
}

describe('parseScriptAllowlist —— 读不懂就是空清单', () => {
  it('**四种读不懂是同一件事**：没文件 / 不是对象 / 没有那个键 / 键不是表', () => {
    // 「审核状态未知」不是「通过」。四种都归成 0 个已审槽位。
    for (const raw of [null, undefined, 42, '不是 JSON', {}, { allowed_slots: 7 }]) {
      expect(parseScriptAllowlist(raw).size, JSON.stringify(raw)).toBe(0)
    }
  })

  it('空清单就是空清单 —— 出厂状态，智能体一个脚本都跑不了', () => {
    expect(parseScriptAllowlist({ allowed_slots: [] }).size).toBe(0)
  })

  it('认不出槽位号的条目**整条跳过**，不猜一个', () => {
    const m = parseScriptAllowlist({
      allowed_slots: [
        { name: '没写 slot' },
        { slot: '三', name: '槽位号不是数' },
        { slot: 3, name: '好的' },
        '不是对象',
        null,
      ],
    })
    expect(vettedSlots(m)).toEqual([3])
  })

  it('缺省：`allow_lut_write` 是 `false`，两个界是 `null`', () => {
    const e = parseScriptAllowlist(GOOD).get(5) as VettedSlot
    expect(e.allowLutWrite).toBe(false)
    expect(e.lutMin).toBeNull()
    expect(e.lutMax).toBeNull()
    expect(e.notes).toBe('')
  })

  it('`allow_lut_write` 只认**显式的 true** —— `1` / `"yes"` 都不算', () => {
    // 一个「差不多算是真」的值不该打开写 LUT 这道口子。
    for (const v of [1, 'true', 'yes', {}]) {
      const m = parseScriptAllowlist({ allowed_slots: [{ slot: 1, allow_lut_write: v }] })
      expect((m.get(1) as VettedSlot).allowLutWrite, String(v)).toBe(false)
    }
  })
})

describe('gateScriptSlot', () => {
  it('空清单：拒，而且说的是「白名单为空」', () => {
    const g = gateScriptSlot(3, new Map())
    expect(g.entry).toBeNull()
    expect(g.refusal).toContain('脚本白名单为空')
  })

  it('未审槽位：拒，而且**点名是哪个槽位**', () => {
    const g = gateScriptSlot(7, parseScriptAllowlist(GOOD))
    expect(g.entry).toBeNull()
    expect(g.refusal).toContain('槽位 7 不在已审核的白名单里')
    // 「清单是空的」与「你要的那个不在里面」是两句话 —— 说错一句，
    // 调用方会去改错的那份东西。
    expect(g.refusal).not.toContain('白名单为空')
  })

  it('已审槽位：放行，并给出条目', () => {
    const g = gateScriptSlot(3, parseScriptAllowlist(GOOD))
    expect(g.entry?.name).toBe('延时扫描')
    expect(g.refusal).toBe('')
  })
})

describe('scriptRefusal —— 每一条拒绝都说得出「为什么有这道闸」', () => {
  it('带上已审槽位表与那份文件的名字', () => {
    const msg = scriptRefusal('拒绝：某某。', parseScriptAllowlist(GOOD))
    expect(msg).toContain('已审核的槽位：[3, 5]')
    expect(msg).toContain(SCRIPT_ALLOWLIST_FILE)
    // 读到它的人要有办法把事情推进下去
    expect(msg).toContain('_how_to_vet')
    expect(msg).toContain('安全门/模式门/中止门在它里面全部不生效')
  })

  it('空清单时印的是那句话，不是一对空方括号', () => {
    expect(scriptRefusal('拒绝。', new Map())).toContain('（空——没有任何脚本被批准）')
  })
})

describe('lutOutOfRange —— 范围由**审脚本的人**写定', () => {
  const didv = parseScriptAllowlist(GOOD).get(3) as VettedSlot

  it('范围内一个都不报', () => {
    expect(lutOutOfRange([0, 5, 10], didv)).toEqual([])
  })

  it('两端都是闭的', () => {
    expect(lutOutOfRange([-1e-9], didv)).toEqual([-1e-9])
    expect(lutOutOfRange([10.0000001], didv)).toEqual([10.0000001])
  })

  it('**只报前 5 个** —— 多了也看不过来', () => {
    expect(lutOutOfRange([11, 12, 13, 14, 15, 16, 17], didv)).toEqual([11, 12, 13, 14, 15])
  })

  it('两个界都没声明 ⇒ **不设限**（用户没写就没写，不替他编一个）', () => {
    const free = parseScriptAllowlist(GOOD).get(5) as VettedSlot
    expect(lutOutOfRange([-1e9, 0, 1e9], free)).toEqual([])
  })

  it('只声明一侧时，另一侧无限', () => {
    const onlyLow = parseScriptAllowlist({
      allowed_slots: [{ slot: 1, lut_min: 0 }],
    }).get(1) as VettedSlot
    expect(lutOutOfRange([-1], onlyLow)).toEqual([-1])
    expect(lutOutOfRange([1e9], onlyLow)).toEqual([])
  })
})
