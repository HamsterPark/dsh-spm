/**
 * 仪器状态快照的形状，与「这算不算一个读数」的**唯一判据**。
 *
 * 字段名逐字沿用 Python（`bias_v` 而不是 `biasV`）。这不是懒：`applyPatch` 吃的是
 * **技能结果里的 `data` 字典**，键名由 515 个已移植技能给出，是契约的一部分。改成
 * 驼峰就等于给每个技能加一次翻译，**515 次犯错机会**换一个大小写习惯。同理 Nanonis
 * 的动词也保持 `Bias_Get`。
 */

/** `ZCtrl_StatusGet` 的码表。表外的码要**留痕**（`Unknown(7)`），不能悄悄当成 Off。 */
export const ZCTRL_STATUS: Readonly<Record<number, string>> = {
  1: 'Off',
  2: 'On',
  3: 'Hold',
  4: 'SwitchingOff',
  5: 'SafeTip',
  6: 'Withdrawing',
}

export function zctrlStatusName(code: number): string {
  return ZCTRL_STATUS[code] ?? `Unknown(${code})`
}

export interface HardwareState {
  /** ISO 时间戳。**stale 时保留上一次好读的值**——年龄要诚实，不能假装刚读过。 */
  readonly timestamp: string
  /** 上一轮刷新**五个核心读一个都没落地**（链路断了），下面的值全是端过来的旧值。 */
  readonly stale: boolean
  readonly bias_v: number | null
  readonly current_a: number | null
  readonly z_pos_m: number | null
  readonly x_pos_m: number | null
  readonly y_pos_m: number | null
  readonly z_controller_on: boolean | null
  readonly z_controller_status: string | null
  /** 活动 Z 控制器的身份。一台机器可以定义多个（`Current` / `log Current` / `df`），
   *  只有一个在反馈。进针时不知道活动的是哪个，模型会绕好几轮弯路。 */
  readonly z_controller_name: string | null
  readonly z_controller_index: number | null
  readonly z_controller_names: readonly string[] | null
  readonly withdrawn: boolean | null
  readonly scan_running: boolean | null
  readonly setpoint_a: number | null
  /** 锁相调制。`null` = **没读到**，而不是「关着」——后者会让电流监控的告警刷屏回来。 */
  readonly lockin_mod_on: boolean | null
  readonly scan_center_x_m: number | null
  readonly scan_center_y_m: number | null
  readonly scan_width_m: number | null
  readonly scan_height_m: number | null
  readonly scan_angle_deg: number | null
}

/** 字段全为 null 的初始快照。 */
export function emptyHardwareState(timestamp: string): HardwareState {
  return {
    timestamp,
    stale: false,
    bias_v: null,
    current_a: null,
    z_pos_m: null,
    x_pos_m: null,
    y_pos_m: null,
    z_controller_on: null,
    z_controller_status: null,
    z_controller_name: null,
    z_controller_index: null,
    z_controller_names: null,
    withdrawn: null,
    scan_running: null,
    setpoint_a: null,
    lockin_mod_on: null,
    scan_center_x_m: null,
    scan_center_y_m: null,
    scan_width_m: null,
    scan_height_m: null,
    scan_angle_deg: null,
  }
}

/**
 * 「这个值能不能当成一个读数」——逐字移植 `mast/io/nanonis_files.py:scalar_float`。
 *
 * **拒绝的东西才是重点，不要好心放宽**：
 *   - 多元素序列 → `null`，**不取第 0 个**（双通道回包上悄悄选一路，是最难查的那种错）
 *   - 字符串 / 布尔 / `null` → `null`
 *   - `NaN` / `Infinity` → `null`（一个非有限的读数不是测量值）
 *   - 单元素序列**递归解包**：`[[1.5]]` 仍是 1.5
 *
 * 也**永不返回 0 兜底**。Python 那边被这个函数替掉的三份手写 `_scalar` 里有两份写着
 * `float(v[0]) if v else 0.0`——一次读失败变成一个看起来很合理的测量值。
 */
export function scalarFloat(x: unknown): number | null {
  if (typeof x === 'boolean' || typeof x === 'string') return null
  if (x instanceof Uint8Array) return null
  if (Array.isArray(x)) {
    if (x.length !== 1) return null
    return scalarFloat(x[0])
  }
  if (typeof x !== 'number' && typeof x !== 'bigint') return null
  const f = Number(x)
  return Number.isFinite(f) ? f : null
}
