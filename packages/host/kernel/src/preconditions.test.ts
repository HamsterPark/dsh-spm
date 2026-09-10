/**
 * 前置条件对金样。**整片夹具网格**（10 个前置 × 14 个夹具 = 140 格）逐格比，
 * 而不是挑几个点：判定表里有子串匹配，而子串在**否定形式**上尤其危险
 * （`"on"` 是 `"z_controller_off"` 的子串），只挑点会正好挑不到那一格。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { emptyHardwareState, type HardwareState } from './hardware-state.js'
import { describe, expect, it } from 'vitest'
import {
  PRECONDITION_CHECKS,
  PRECONDITION_CONTEXT_FIELDS,
  ZCTRL_STATUS_HINT,
  checkStatePreconditions,
  contextSuffix,
  preconditionRecognized,
} from './preconditions.js'

interface Golden {
  exact_checks: Record<string, [string, boolean]>
  context_fields: Record<string, string>
  zctrl_status_hints: Record<string, string>
  exact_messages: Record<string, string>
  computed_names: string[]
  recognized: Record<string, boolean>
  grid: { precondition: string; fixture: string; violations: string[] }[]
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/preconditions.json', import.meta.url)), 'utf8'),
) as Golden

/** 与导出脚本里的 FIXTURES 一一对应。 */
const FIXTURES: Record<string, Partial<HardwareState>> = {
  zctrl_on: { z_controller_on: true, z_controller_status: 'On' },
  zctrl_off: { z_controller_on: false, z_controller_status: 'Off' },
  zctrl_hold: { z_controller_on: false, z_controller_status: 'Hold' },
  zctrl_switching_off: { z_controller_on: false, z_controller_status: 'SwitchingOff' },
  zctrl_safetip: { z_controller_on: false, z_controller_status: 'SafeTip' },
  zctrl_withdrawing: { z_controller_on: false, z_controller_status: 'Withdrawing' },
  zctrl_unknown: {},
  scan_running: { scan_running: true },
  scan_stopped: { scan_running: false },
  bias_zero: { bias_v: 0.0 },
  bias_live: { bias_v: 1.5 },
  withdrawn: { withdrawn: true },
  not_withdrawn: { withdrawn: false },
  empty: {},
}

describe('金样：词表', () => {
  it('精确名单', () => {
    const ours = Object.fromEntries(Object.entries(PRECONDITION_CHECKS).map(([k, v]) => [k, [v[0], v[1]]]))
    expect(ours).toEqual(golden.exact_checks)
  })
  it('伴随字段与状态提示（措辞逐字）', () => {
    expect({ ...PRECONDITION_CONTEXT_FIELDS }).toEqual(golden.context_fields)
    expect({ ...ZCTRL_STATUS_HINT }).toEqual(golden.zctrl_status_hints)
  })
  it('认不认得', () => {
    const ours: Record<string, boolean> = {}
    for (const n of Object.keys(golden.recognized)) {
      ours[n] = preconditionRecognized(n, { vacuum_ok_for_coarse: () => ({ ok: true, reason: '' }) })
    }
    expect(ours).toEqual(golden.recognized)
  })
})

describe('金样：140 格夹具网格', () => {
  for (const row of golden.grid) {
    it(`${row.precondition} @ ${row.fixture} ⇒ ${row.violations.length === 0 ? '满足' : '违反'}`, () => {
      const state = { ...emptyHardwareState('T0'), ...FIXTURES[row.fixture]! }
      expect(checkStatePreconditions([row.precondition], state)).toEqual(row.violations)
    })
  }
})

describe('2026-08-10 的反转 bug：z_controller_off 必须判对', () => {
  const st = (on: boolean | null): HardwareState => ({ ...emptyHardwareState('T0'), z_controller_on: on })

  it('硬件 OFF 时 z_controller_off **放行**（这正是它要求的）', () => {
    expect(checkStatePreconditions(['z_controller_off'], st(false))).toEqual([])
  })

  it('硬件 ON 时 z_controller_off **拒绝**（反馈环闭着跑开环粗进针 = 撞针）', () => {
    const v = checkStatePreconditions(['z_controller_off'], st(true))
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('Z controller is ON')
  })

  it('读不到时放行——未知状态下拦住可能让人在针要撞上去时按不动按钮', () => {
    expect(checkStatePreconditions(['z_controller_off'], st(null))).toEqual([])
    expect(checkStatePreconditions(['z_controller_on'], st(null))).toEqual([])
  })
})

describe('六种情况要六句话', () => {
  it('同一个布尔 False，四种模块状态给出四句不同的补充说明', () => {
    const texts = ['Off', 'Hold', 'SwitchingOff', 'SafeTip'].map((s) =>
      contextSuffix('z_controller_on', {
        ...emptyHardwareState('T0'),
        z_controller_on: false,
        z_controller_status: s,
      }),
    )
    expect(new Set(texts).size).toBe(4)
    expect(texts[1]).toContain('挂起')
    expect(texts[3]).toContain('仪器躲开了')
  })

  it('读不到伴随字段就返回空串，不编一个状态名出来', () => {
    expect(contextSuffix('z_controller_on', emptyHardwareState('T0'))).toBe('')
  })
})

describe('计算型前置的失败方向与其余相反', () => {
  const st = emptyHardwareState('T0')
  it('真空互锁说不行 ⇒ 拒，理由原样透传', () => {
    const v = checkStatePreconditions(['vacuum_ok_for_coarse'], st, {
      vacuum_ok_for_coarse: () => ({ ok: false, reason: '规压计读不到——按 fail-closed 拒绝粗动' }),
    })
    expect(v[0]).toContain('fail-closed')
  })
  it('说行就放行', () => {
    expect(
      checkStatePreconditions(['vacuum_ok_for_coarse'], st, {
        vacuum_ok_for_coarse: () => ({ ok: true, reason: '' }),
      }),
    ).toEqual([])
  })
  it('没接互锁时它退回子串层——认不出来就当没这条（本模块不替它 fail-closed）', () => {
    expect(checkStatePreconditions(['vacuum_ok_for_coarse'], st)).toEqual([])
  })
})
