/**
 * 仪器状态缓存的**纯逻辑**——1 Hz 读什么、读不到怎么办、写回怎么把关。
 * 零 I/O：读由外面传进来的 `StateReader` 负责，所以这一层能被金样逐步驱动。
 *
 * 两条规则是整段的重点，它们只在**序列**里才显形：
 *
 * 1. **carry-forward**：一次读**失败**不许把已知值降级成未知。只有确定性的读
 *    （数、true/false）才覆盖；`null`（「没读到」）当作「没有新信息」。
 *    不这样的话，写回刚设的 `z_controller_on=true` 会被下一个 1 Hz tick 抹掉，
 *    `StartScan` 的前置条件永远不满足——2026-06-29 真机上的死循环。
 * 2. **stale**：五个核心读**一个都没落地** ⇒ 链路断了。此时 carry-forward 会端出
 *    几小时前的值，而时间戳如果照常刷新就等于说「刚读的」。所以亮 `stale` 并
 *    **保留上一次好读的时间戳**，让年龄诚实（2026-07-03 复查）。
 */
import { emptyHardwareState, scalarFloat, zctrlStatusName, type HardwareState } from 'dsh-spm-kernel'

/** 读一个动词。返回回包的 body；`null` = **没读到**（错误、超时、模块缺失都算）。 */
export type StateReader = (verb: string, args: readonly number[]) => Promise<readonly unknown[] | null>

/** 1 Hz 在 monitor 角色跑的 11 个读，**顺序即金样**（`spec/golden/state.json` 观测所得）。 */
export const REFRESH_VERBS: readonly (readonly [string, readonly number[]])[] = [
  ['Bias_Get', []],
  ['ZCtrl_StatusGet', []],
  ['ZCtrl_CtrlListGet', []],
  ['ZCtrl_SetpntGet', []],
  ['Current_Get', []],
  ['ZCtrl_ZPosGet', []],
  ['FolMe_XYPosGet', [0]],
  ['ZCtrl_LimitsGet', []],
  ['Scan_StatusGet', []],
  ['LockIn_ModOnOffGet', [1]],
  ['Scan_FrameGet', []],
]

/** 链路是否还活着，就看这五个。全没落地才算断（`stale`）。 */
const CORE_FIELDS = ['bias_v', 'z_controller_on', 'current_a', 'z_pos_m', 'scan_running'] as const

/** 技能结果的 `data` 能写回哪些字段。白名单在**收的一侧**——会犯错的一方不能同时当校验方。 */
const PATCHABLE = new Set([
  'bias_v', 'current_a', 'z_pos_m', 'x_pos_m', 'y_pos_m',
  'z_controller_on', 'z_controller_status', 'withdrawn', 'scan_running', 'setpoint_a',
  'scan_center_x_m', 'scan_center_y_m', 'scan_width_m', 'scan_height_m', 'scan_angle_deg',
  'z_controller_name', 'z_controller_index', 'z_controller_names',
])

/** 这些字段声明的是数，写进去的就必须是**一个数**。见 `scalarFloat` 的拒绝清单。 */
const NUMERIC = new Set([
  'bias_v', 'current_a', 'z_pos_m', 'x_pos_m', 'y_pos_m', 'setpoint_a',
  'scan_center_x_m', 'scan_center_y_m', 'scan_width_m', 'scan_height_m', 'scan_angle_deg',
])

export type HistoryChannel = 'bias' | 'current' | 'z'
const HISTORY_LEN = 20

/** 可变的中间态：拼 `HardwareState` 时用，拼完冻成只读快照。 */
type Draft = { -readonly [K in keyof HardwareState]: HardwareState[K] }

export interface CacheOptions {
  /** 注入时钟，测试要确定性的时间戳。 */
  readonly now?: () => string
}

export class HardwareStateCache {
  private cache: HardwareState
  private readonly hist: Record<HistoryChannel, number[]> = { bias: [], current: [], z: [] }
  private readonly now: () => string

  constructor(opts: CacheOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString())
    this.cache = emptyHardwareState(this.now())
  }

  snapshot(): HardwareState {
    return this.cache
  }

  history(ch: HistoryChannel): readonly number[] {
    return this.hist[ch]
  }

  /**
   * 把一个**成功**技能回报的硬件事实写回缓存，不等那最多 1 秒的后台刷新。
   *
   * `null`/`undefined` 跳过（不拿未知盖掉已知），但 **`false` 要写进去**
   * （`StopScan` 之后的 `scan_running=false` 是一条真信息）。非白名单键忽略。
   * 数值字段过 `scalarFloat`：**写不进去就不写**——陈的真值好过一个假形状。
   * 一次装错类型的缓存写入锁死过整台机器（2026-08-13）。
   */
  applyPatch(fields: Readonly<Record<string, unknown>>): void {
    const draft: Draft = { ...this.cache }
    for (const [k, raw] of Object.entries(fields)) {
      if (raw === null || raw === undefined || !PATCHABLE.has(k)) continue
      let v: unknown = raw
      if (NUMERIC.has(k)) {
        const n = scalarFloat(raw)
        if (n === null) continue
        v = n
      }
      ;(draft as Record<string, unknown>)[k] = v
    }
    this.cache = draft
  }

  /**
   * 跑一轮 11 个读，按 carry-forward / stale 规则合进缓存。**永不抛**：
   * 读不出数的字段就是「没读到」，而不是让整个 tick 连同其它十个读一起丢掉
   * （deviation D-STATE-1）。
   */
  async refresh(read: StateReader): Promise<HardwareState> {
    const body = new Map<string, readonly unknown[] | null>()
    for (const [verb, args] of REFRESH_VERBS) body.set(verb, await read(verb, args))

    const num = (verb: string, i = 0): number | null => {
      const b = body.get(verb)
      return b === null || b === undefined || b.length <= i ? null : scalarFloat(b[i])
    }

    const s: Draft = { ...emptyHardwareState(this.now()) }

    s.bias_v = num('Bias_Get')

    const statusCode = num('ZCtrl_StatusGet')
    if (statusCode !== null) {
      const code = Math.trunc(statusCode)
      s.z_controller_on = code === 2
      s.z_controller_status = zctrlStatusName(code)
    }

    const ctrl = parseCtrlList(body.get('ZCtrl_CtrlListGet'))
    if (ctrl !== null) {
      s.z_controller_names = ctrl.names
      s.z_controller_index = ctrl.activeIndex
      if (ctrl.activeIndex >= 0 && ctrl.activeIndex < ctrl.names.length) {
        s.z_controller_name = ctrl.names[ctrl.activeIndex]!
      }
    }

    s.setpoint_a = num('ZCtrl_SetpntGet')
    s.current_a = num('Current_Get')
    s.z_pos_m = num('ZCtrl_ZPosGet')

    const x = num('FolMe_XYPosGet', 0)
    const y = num('FolMe_XYPosGet', 1)
    if (x !== null && y !== null) {
      s.x_pos_m = x
      s.y_pos_m = y
    }

    const zHighLimit = num('ZCtrl_LimitsGet')
    // 退针 = 反馈关着**且** Z 顶在上限。任一前提读不到就答「不知道」，不答「没退」。
    if (s.z_controller_on === false && s.z_pos_m !== null && zHighLimit !== null) {
      s.withdrawn = Math.abs(s.z_pos_m - zHighLimit) < 1e-12
    } else {
      s.withdrawn = s.z_controller_on === true ? false : null
    }

    const scan = num('Scan_StatusGet')
    if (scan !== null) s.scan_running = scan !== 0

    const lockin = num('LockIn_ModOnOffGet')
    if (lockin !== null) s.lockin_mod_on = Math.trunc(lockin) !== 0

    // 扫描框几何是**一组**：读不齐就整组不写。写一半（中心新、宽高旧）比不写更危险。
    const frame = body.get('Scan_FrameGet')
    if (frame !== undefined && frame !== null && frame.length >= 5) {
      const f = frame.slice(0, 5).map(scalarFloat)
      if (f.every((v) => v !== null)) {
        s.scan_center_x_m = f[0]!
        s.scan_center_y_m = f[1]!
        s.scan_width_m = f[2]!
        s.scan_height_m = f[3]!
        s.scan_angle_deg = f[4]!
      }
    }

    const prev = this.cache
    const freshCore = CORE_FIELDS.filter((f) => s[f] !== null).length
    if (freshCore === 0 && CORE_FIELDS.some((f) => prev[f] !== null)) {
      s.stale = true
      s.timestamp = prev.timestamp // 年龄要诚实：不把陈值盖上一个刚出炉的时间戳
    }

    for (const f of PATCHABLE) {
      const key = f as keyof Draft
      if (s[key] === null && prev[key] !== null) (s as Record<string, unknown>)[f] = prev[key]
    }

    this.cache = s
    // 端过来的值也进历史。历史是「缓存这一秒读出来是什么」，不是「这一秒新读到了什么」。
    push(this.hist.bias, s.bias_v)
    push(this.hist.current, s.current_a)
    push(this.hist.z, s.z_pos_m)
    return s
  }
}

function push(buf: number[], v: number | null): void {
  if (v === null) return
  buf.push(v)
  if (buf.length > HISTORY_LEN) buf.shift()
}

/**
 * 从 `ZCtrl_CtrlListGet` 的回包里挑出（控制器名字, 活动下标）。
 * `ResponseTypes = ["i","i","*+c","i"]` ⇒ body 是 `[size, count, [名字…], 活动下标]`。
 *
 * 照 Python 的防御式扫描：**名字是第一串全是字符串的列表**；活动下标是**名字之后**
 * 出现的那个整数（前面两个 int 因此被忽略）。形状不认识就返回 `null`，不猜。
 */
function parseCtrlList(body: readonly unknown[] | null | undefined): {
  names: string[]
  activeIndex: number
} | null {
  if (body === null || body === undefined) return null
  let names: string[] | null = null
  let activeIndex = 0
  for (const item of body) {
    if (Array.isArray(item) && item.length > 0 && item.every((v) => typeof v === 'string')) {
      names = item as string[]
    } else if (names !== null && typeof item === 'number' && Number.isInteger(item)) {
      activeIndex = item
    }
  }
  return names === null ? null : { names, activeIndex }
}
