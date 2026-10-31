/**
 * 粗动接线 —— STM 粗动是 Nanonis 的**哪一组**马达，以及哪些数字口是**保留口**。
 *
 * 参考实现（MAST 7.1.0 `instruments/motor_groups.py`）把这两项放在一个独立的配置文件里：
 * 没有文件 ⇒ 组 0、不保留任何口；文件在但读不了 ⇒ **拒绝粗动、拒写所有数字口**；
 * 保留口列表里有一项畸形 ⇒ **整个列表作废**（不逐项丢 —— 丢掉的那条保留就是一个没有保护的口），
 * 同样拒写所有数字口。本仓没有那个文件：两项住在**仪器档案读口返回的对象**里
 * （`processInstrumentProfile.source`，与 `retract_motor_dir` 同一条通道，见 D-PROF-1）。
 *
 * ## 为什么自己读读口的原始返回值，不走 `readProfile()`
 *
 * `readProfile()` 先过 {@link sanitizeProfile}：只留已登记的键，数值键被**夹进区间**，
 * 非法值被**静默丢掉**。这两个键哪一头都过不了 ——
 *
 * - 登记进 {@link CONFIG_SPEC} / {@link CHOICE_SPEC}（键集还被金样双向钉住）：值会被夹，
 *   `stm_coarse_group: 7` 变成 5，一份损坏的配置于是变成「驱动第 5 组」；
 * - 不登记：键被**整键丢掉**，哪怕值是合法的，结果回落成「组 0、不保留任何口」。
 *
 * 「损坏即拒」只能由这里的严格校验表达，所以这两个键**不登记**，这里直接读读口的原始返回值。
 * 同一个理由的另一面：宿主**不要先把档案过一遍 `sanitizeProfile` 再交给读口** ——
 * 那是一句写得干干净净、读回来永远是缺省的话（D-QPLUS-1 记过的那种陷阱）。
 *
 * ## 只按键取值
 *
 * 档案对象可以带「取某个键就抛」的 getter（测试里用它表达「只有退针方向读不出」）。
 * 这里只按名读 `stm_coarse_group` 与 `reserved_digital_ports` 两个键，
 * **不展开、不枚举、不序列化**整个对象 —— 否则一个无关键的 getter 就能让粗动被拒。
 *
 * ## 宿主没接读口
 *
 * `source === null` ⇒ 组 0、不保留任何口：与接线配置出现之前的行为逐字相同（缺省值与现状等价）。
 * 这与 `retract_motor_dir` **不对称是有意的**：出厂 Z+ 不中性（它是两个互斥答案里的一个），
 * 而组 0 与空保留表就是参考实现的「无文件」缺省。
 *
 * ## 比参考实现更严的几处（登记在 D-GROUP-1）
 *
 * - 组号与保留口的端口号只收整数 number（参考实现的 `float()` 还收 `"2"` 这样的字符串）；
 * - 值是 `undefined` 的键算「键在、值非法」⇒ 拒绝。JSON 表达不了 `undefined`，JS 对象可以，
 *   而静默回落成组 0 正是这个特性要防的事；
 * - 读口返回 Promise 之类的 thenable ⇒ 读不到（`readProfile()` 会把它当成 `{}`）。
 *
 * 不在这里的：驱动锁存（只有光学组会触发，而光学族不迁移）。
 */
import { processInstrumentProfile } from './instrument-profile.js'

/** `Motor_StartMove` 的 Group 实参上限：0 = Group 1 … 5 = Group 6。 */
const GROUP_MAX = 5
/** Nanonis `DigLines` 的端口号：0=A … 3=D，4 以上是扩展 DIO；保留口表里收到 15。 */
const PORT_MAX = 15
const PORT_LETTERS = ['A', 'B', 'C', 'D'] as const
const DEFAULT_REASON = '本机配置的保留口'

/** STM 粗动组，或者**为什么取不到**。取不到时一律不发粗动。 */
export type StmGroup =
  | { readonly ok: true; readonly group: number }
  | { readonly ok: false; readonly why: string }

interface ReservedPort {
  readonly port: number
  readonly reason: string
}

type ReservedPorts =
  | { readonly ok: true; readonly list: readonly ReservedPort[] }
  | { readonly ok: false; readonly why: string }

type Read<T> =
  | { readonly kind: 'unwired' }
  | { readonly kind: 'unreadable'; readonly why: string }
  | { readonly kind: 'value'; readonly value: T }

type Rec = Readonly<Record<string, unknown>>

/** 把原值印进拒绝理由：字符串带引号（`'2'` 与 `2` 要分得开），其余原样（`NaN` 不能印成 `null`）。 */
function show(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

/** 普通对象：不是 null、数组，也不是 Promise 之类的 thenable。 */
function isRecord(v: unknown): v is Rec {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as { then?: unknown }).then !== 'function'
  )
}

/** `0..hi` 的整数（布尔、字符串、小数、NaN 都不是）。 */
function intIn(v: unknown, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= hi
}

/**
 * 调一次读口，再让 `pick` 按名取它要的键。读口抛、返回的不是普通对象、取键时抛，
 * 都是「读不到」；`source === null` 单独成一态。
 */
function readWiring<T>(pick: (raw: Rec) => T): Read<T> {
  const src = processInstrumentProfile.source
  if (src === null) return { kind: 'unwired' }
  try {
    const raw = src()
    if (!isRecord(raw)) return { kind: 'unreadable', why: '读口返回的不是普通对象' }
    return { kind: 'value', value: pick(raw) }
  } catch (exc) {
    return { kind: 'unreadable', why: `读口抛出: ${String(exc)}` }
  }
}

function groupOf(raw: Rec): StmGroup {
  if (!('stm_coarse_group' in raw)) return { ok: true, group: 0 }
  const v = raw['stm_coarse_group']
  return intIn(v, GROUP_MAX)
    ? { ok: true, group: v }
    : { ok: false, why: `stm_coarse_group=${show(v)} 不是 0..${GROUP_MAX} 的整数` }
}

function portsOf(raw: Rec): ReservedPorts {
  // 键缺席或值为 null ⇒ 没有保留口。键在而值是 undefined 不是缺席（同 stm_coarse_group）：
  // 拼装配置时漏掉的列表若被当成「不保留任何口」，每个保留口都会静默变成可写。
  if (!('reserved_digital_ports' in raw)) return { ok: true, list: [] }
  const list = raw['reserved_digital_ports']
  if (list === null) return { ok: true, list: [] }
  if (!Array.isArray(list)) return { ok: false, why: 'reserved_digital_ports 不是列表' }
  const out: ReservedPort[] = []
  for (const [i, e] of list.entries()) {
    if (!isRecord(e)) return { ok: false, why: `reserved_digital_ports[${i}] 不是对象` }
    const port = e['port']
    if (!intIn(port, PORT_MAX)) {
      return { ok: false, why: `reserved_digital_ports[${i}].port=${show(port)} 不是 0..${PORT_MAX} 的整数` }
    }
    out.push({ port, reason: String(e['reason'] || '').trim() || DEFAULT_REASON })
  }
  return { ok: true, list: out }
}

function portLabel(port: number): string {
  const letter = PORT_LETTERS[port]
  return letter === undefined ? `DIO port ${port}` : `Port ${letter}`
}

/** 接线配置整份不可用（读不出来、或 `stm_coarse_group` 不合法）时，所有数字口都拒写。 */
function wiringUnusable(why: string): string {
  return (
    `仪器档案里的粗动接线配置读不出来（${why}）—— 不知道哪些数字口是保留口，拒绝写数字口。` +
    '修好或删掉该配置后重试。'
  )
}

/**
 * 每一次 STM 粗动都要用的 Group 实参。
 *
 * | 读口状态 | 返回 |
 * |---|---|
 * | `source === null`（宿主没接）、或对象里没有 `stm_coarse_group` 键 | `ok`，组 0 |
 * | 读口抛、返回的不是普通对象、取键时抛 | `!ok` |
 * | 键在，值是 0–5 的整数 | `ok`，该值 |
 * | 键在，值是别的任何东西（`null`、`"2"`、布尔、1.5、NaN、6、−1、`undefined`） | `!ok`，`why` 含原值；**不回落到 0** |
 *
 * 只看 `stm_coarse_group`：保留口列表坏了不影响粗动（与参考实现一致）。
 */
export function stmCoarseGroup(): StmGroup {
  const r = readWiring(groupOf)
  if (r.kind === 'unwired') return { ok: true, group: 0 }
  if (r.kind === 'unreadable') return { ok: false, why: r.why }
  return r.value
}

/** 组取不到时的拒绝文案。六个粗动调用点共用这一句。 */
export function stmGroupRefusal(why: string): string {
  return (
    `仪器档案里的 stm_coarse_group 无法使用（${why}）—— 不知道 STM 粗动是哪一组，拒绝粗动。` +
    '修好或删掉该设置（删掉 = 回到 group 0）后重试。'
  )
}

/**
 * 这个数字口能写吗？`''` = 能；否则是拒绝的理由。读不受限（只有三个写技能调它）。
 *
 * **传进来的必须是实际要下发的那个 `port`**：检查一个、发另一个，等于没检查。
 *
 * | 状态 | 结果 |
 * |---|---|
 * | `source === null` | `''`（没配置 ⇒ 不保留任何口） |
 * | 读口读不出，或 `stm_coarse_group` 不合法（整份不可用） | 拒写所有口 |
 * | `reserved_digital_ports` 不是列表（含键在而值是 `undefined`），或里面有畸形的一项 | 拒写所有口（整个列表作废，不逐项丢） |
 * | `port` 不是整数 | 拒绝 |
 * | `port` 在保留列表里（多项同口取第一项的理由） | 拒绝，带那一项的理由 |
 * | 其余（含键缺席或值为 `null`） | `''` |
 */
export function digitalPortRefusal(port: unknown): string {
  const r = readWiring((raw) => ({ group: groupOf(raw), ports: portsOf(raw) }))
  if (r.kind === 'unwired') return ''
  if (r.kind === 'unreadable') return wiringUnusable(r.why)
  const { group, ports } = r.value
  if (!group.ok) return wiringUnusable(group.why)
  if (!ports.ok) {
    return (
      `仪器档案的 reserved_digital_ports 读不懂（${ports.why}）—— ` +
      '不知道哪些数字口是保留口，拒绝写数字口。'
    )
  }
  if (typeof port !== 'number' || !Number.isInteger(port)) return `数字口 ${show(port)} 不是整数`
  const hit = ports.list.find((p) => p.port === port)
  if (hit === undefined) return ''
  return (
    `拒绝写 ${portLabel(port)}（port=${port}）：本机配置把它列为保留数字口 —— ${hit.reason}。` +
    '误写它的方向位、电平或脉冲可能让接在上面的设备误动作；不会截断，也不会改用别的口。'
  )
}
