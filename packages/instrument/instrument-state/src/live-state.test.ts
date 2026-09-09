/**
 * 提示块对金样。**整段文本逐字比**，不是比字段——这块的措辞就是契约：
 * 模型读到的就是这些句子，抄错一个词等于把 2026-07-27 那次坐标事故的成因放回去。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { emptyHardwareState, type HardwareState } from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { formatLiveState } from './live-state.js'

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/state.json', import.meta.url)), 'utf8'),
) as { live_state: Record<string, string> }

/** 与导出脚本里的 LIVE_CASES 一一对应。只重复**输入**，期望值全部来自金样。 */
const CASES: Record<string, Partial<HardwareState>> = {
  empty: {},
  full: {
    bias_v: -2.0,
    current_a: 1.2e-10,
    setpoint_a: 1.0e-10,
    z_pos_m: -1.0e-8,
    x_pos_m: 5.0e-8,
    y_pos_m: -3.0e-8,
    z_controller_on: true,
    z_controller_status: 'On',
    z_controller_name: 'log Current',
    z_controller_index: 1,
    z_controller_names: ['Current', 'log Current', 'df'],
    scan_running: false,
    scan_center_x_m: 1.0e-8,
    scan_center_y_m: -2.0e-8,
    scan_width_m: 1.0e-7,
    scan_height_m: 5.0e-8,
    scan_angle_deg: 30.0,
  },
  status_fallback: { z_controller_on: false },
  ctrl_name_only: { z_controller_name: 'Current' },
  width_without_height: { scan_width_m: 2.0e-8 },
  bias_only: { bias_v: 1.5 },
  tiny_frame: { scan_width_m: 1.0e-9, scan_height_m: 1.0e-9 },
}

describe('金样：实时状态提示块', () => {
  for (const [name, fields] of Object.entries(CASES)) {
    it(name, () => {
      const expected = golden.live_state[name]
      expect(expected, `金样里没有用例 ${name}`).toBeDefined()
      expect(formatLiveState({ ...emptyHardwareState('T0'), ...fields })).toBe(expected)
    })
  }

  it('12 行封顶：字段全给满时正好 12 条', () => {
    // PLAN §7.2 说「≤12 行紧凑块」。这不是审美——它每个请求都进一次模型输入，
    // 长一行就是每轮多付一行的钱，而且把真正要看的数往下挤。
    const body = formatLiveState({ ...emptyHardwareState('T0'), ...CASES['full'] })
    expect(body.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(12)
  })
})
