/**
 * 实时状态提示块——**逐字移植** `mast/agents/_shared/live_state_mw.py:format_live_state_block`。
 *
 * 这块存在的唯一理由是**防量纲错**：扫描框是 100 nm 而模型要一个 1 米宽的扫描，
 * 那是 10⁷ 倍的错。把真实框尺寸同时以 SI 前缀和 nm 印出来，模型就有一个正确的数可以照抄
 * ——不给数，它就得自己换算，而那正是 2026-07-27 坐标事故的成因。
 *
 * **措辞就是契约**（PLAN §3.2-1）：整段文本对 `spec/golden/state.json` 的 `live_state` 一节，
 * 由真 Python 印出来。改一个字都要先改金样，而改金样意味着「我确实想改模型读到的东西」。
 *
 * 数值一律走 `formatSi`，**偏压是唯一的例外**：它天然在 1 附近，`formatSi` 会印成
 * `-2000m`——正确但没法看，所以走 `%g`。这不是随手写的，是 2026-08-04 全块统一时留下的例外。
 */
import { formatG, formatSi, type HardwareState } from 'dsh-spm-kernel'

/** 这一段在提示里的名字。dsh 用它给贡献归属，UI 也按它显示来源。 */
export const LIVE_STATE_NAME = 'stm-live-state'

/**
 * Python `repr()` 用在字符串上的形状：默认单引号，串里有单引号而没有双引号时改用双引号。
 * 只转义引号与反斜杠——控制字符与非 ASCII 的转义没复刻，因为这里印的是**仪器回报的
 * Z 控制器名**（`Current` / `log Current` / `df` 这类）。真出现控制字符时形状会与 Python
 * 不同，那时再补。
 */
function pyReprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  return q + s.replaceAll('\\', '\\\\').replaceAll(q, `\\${q}`) + q
}

/**
 * 把一份快照渲染成给模型看的 markdown 块。**每个字段都为空时返回空串**——
 * 空块不该占位置，dsh 那边空文本的 context 本来也不贡献任何东西。
 */
export function formatLiveState(state: HardwareState): string {
  const lines: string[] = []

  if (state.bias_v !== null) lines.push(`- Bias voltage: ${formatG(state.bias_v, 6)} V`)
  if (state.current_a !== null) lines.push(`- Tunneling current: '${formatSi(state.current_a)}' A`)
  if (state.setpoint_a !== null) lines.push(`- Setpoint: '${formatSi(state.setpoint_a)}' A`)
  if (state.z_pos_m !== null) lines.push(`- Z position: '${formatSi(state.z_pos_m)}' m`)
  if (state.x_pos_m !== null && state.y_pos_m !== null) {
    lines.push(`- XY position: ('${formatSi(state.x_pos_m)}', '${formatSi(state.y_pos_m)}') m`)
  }
  if (state.z_controller_status !== null) {
    lines.push(`- Z controller: ${state.z_controller_status}`)
  } else if (state.z_controller_on !== null) {
    lines.push(`- Z controller: ${state.z_controller_on ? 'ON' : 'OFF'}`)
  }

  // 活动 Z 控制器的身份。一台机器可以定义多个，engage/approach 只作用于**活动的那个**；
  // 不在这里点名，模型会在「Z 反馈还是没闭合」上绕好几轮，最后才手工查列表发现活动的是
  // `log Current`。参考系统曾出现这种通道选择，尚未在本仓独立验证。
  if (state.z_controller_name !== null) {
    let line = `- Active Z controller: ${pyReprStr(state.z_controller_name)}`
    if (state.z_controller_index !== null && hasNames(state.z_controller_names)) {
      const n = state.z_controller_names.length
      line += ` (index ${state.z_controller_index} of ${n}; available: ${state.z_controller_names.join(', ')})`
    }
    line +=
      ' — this is the LIVE feedback channel; engage/approach act on THIS ' +
      "controller. If feedback won't close, check that the intended " +
      'controller is the active one (GetZCtrlList to inspect, ' +
      'SetActiveZController to switch) before assuming a hardware fault.'
    lines.push(line)
  }
  if (state.scan_running !== null) {
    lines.push(`- Scan: ${state.scan_running ? 'RUNNING' : 'STOPPED'}`)
  }

  // 扫描框几何 + 量级提醒 —— 整块的头号功能
  if (state.scan_width_m !== null && state.scan_height_m !== null) {
    const wNm = state.scan_width_m * 1e9
    const hNm = state.scan_height_m * 1e9
    lines.push(
      `- Scan frame size: '${formatSi(state.scan_width_m)}' x ` +
        `'${formatSi(state.scan_height_m)}' m  (= ${wNm.toFixed(1)} x ${hNm.toFixed(1)} nm)`,
    )
  }
  if (state.scan_center_x_m !== null && state.scan_center_y_m !== null) {
    const cxNm = state.scan_center_x_m * 1e9
    const cyNm = state.scan_center_y_m * 1e9
    lines.push(
      `- Scan frame center: ('${formatSi(state.scan_center_x_m)}', ` +
        `'${formatSi(state.scan_center_y_m)}') m  ` +
        `(= ${cxNm.toFixed(1)}, ${cyNm.toFixed(1)} nm)`,
    )
  }
  if (state.scan_angle_deg !== null) {
    lines.push(`- Scan rotation: ${state.scan_angle_deg.toFixed(2)}°`)
  }

  // 量级警告只看 width：宽度读到了就印，即使高度没读到。看着别扭，但**是对的**
  // ——量级这件事一个维度就够说清，而少印一次警告的代价是 10⁹ 倍的参数。
  if (state.scan_width_m !== null) {
    const scaleNm = state.scan_width_m * 1e9
    lines.push(
      '- ⚠️ MAGNITUDE CHECK: lengths are METRE quantities, written as ' +
        'STRINGS WITH AN SI PREFIX. The current scan frame is ' +
        `**${scaleNm.toFixed(1)} nm wide** (= '${formatSi(state.scan_width_m)}'). ` +
        "Any skill parameter with unit 'm' must be on this order — " +
        "typically '1n' … '100n'. Never pass `1` for nm (`1` = 1 metre = " +
        '10⁹ nm), and do NOT switch to exponent form — on these parameters ' +
        'it is rejected outright.',
    )
  }

  if (lines.length === 0) return ''
  return '## Live instrument state (refreshed every LLM call)\n' + lines.join('\n')
}

/** `names` 非空——Python 那侧是 `and state.z_controller_names` 的真值判断，空表也算假。 */
function hasNames(v: readonly string[] | null): v is readonly string[] {
  return v !== null && v.length > 0
}
