/**
 * Nanonis 脚本白名单 —— **本仓唯一一道「人签过字」形态的闸**。
 *
 * ## 为什么这道闸是唯一的
 *
 * Nanonis 的 Script 模块是实时时序器：脚本编译后**部署到 RT 控制器上**，以硬件计时
 * 运行，一次 TCP 往返都不发。而本仓每一道闸——安全闸、运行模式闸、中止闸、HITL——
 * 都坐在 `safeCall` 那条路上。于是：
 *
 * - 全局边界（偏压 ±10 V、设定点、Z、扫描尺寸）**在脚本内部不生效**；
 * - **中止闸停不了它**：按下中止只是让本仓不再发命令，脚本照旧在驱动针尖；
 * - 能停它的只有 `Script_Stop`（因此它在中止后的放行清单里）。
 *
 * ⇒ 操作员维护的这份清单**就是那道屏障**，而且是仅有的一道。
 *
 * ## 三条纪律
 *
 * **① fail-closed。** 文件不存在、读不动、格式坏了、清单是空的 —— 四件事**是同一件事**：
 * 没有任何槽位被批准，一个脚本都不许跑。对这份文件没有任何一种读法能把闸打开，
 * 因为「审核状态未知」不是「通过」。
 *
 * **② 批准的是「这个槽位里的那个脚本」，不是槽位号。** 所以
 * `LoadNanonisScript` 的判据是**反的**：它拒绝往**已审**槽位里装别的文件。
 * 换掉内容会让那份批准变成一句假话。
 *
 * **③ 本仓不写这个文件。** 没有任何技能改它。它是操作员的东西 ——
 * 一份自己能改的「已获批准」清单，不是批准。
 */

/** 白名单文件名。路径由宿主拼（`<项目根>/config/<这个名字>`）。 */
export const SCRIPT_ALLOWLIST_FILE = 'nanonis_scripts.json'

/** 一个已审槽位声明了什么。除 `slot` 外全是可选 —— 缺了就是没声明。 */
export interface VettedSlot {
  readonly slot: number
  readonly name: string
  readonly description: string
  /** 允许智能体往这个槽位的 LUT 写值吗。**缺省 `false`**。 */
  readonly allowLutWrite: boolean
  /** LUT 的下界 / 上界。`null` = 用户没声明这一侧。 */
  readonly lutMin: number | null
  readonly lutMax: number | null
  readonly notes: string
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 解析白名单的内容。**永不抛**：任何读不懂都归成「空清单」。
 *
 * `raw` 是已经 `JSON.parse` 过的东西，或者 `null`（文件不存在 / 解析失败）——
 * 把读盘留在外面，是为了让这条判据**全是值**、测得动每一支。
 */
export function parseScriptAllowlist(raw: unknown): Map<number, VettedSlot> {
  const out = new Map<number, VettedSlot>()
  if (raw === null || typeof raw !== 'object') return out
  const list = (raw as Record<string, unknown>)['allowed_slots']
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const e = item as Record<string, unknown>
    // `int(entry["slot"])` —— 认不出槽位号的条目**整条跳过**，不猜一个。
    const slot = num(e['slot'])
    if (slot === null) continue
    out.set(Math.trunc(slot), {
      slot: Math.trunc(slot),
      name: str(e['name']),
      description: str(e['description']),
      allowLutWrite: e['allow_lut_write'] === true,
      lutMin: num(e['lut_min']),
      lutMax: num(e['lut_max']),
      notes: str(e['notes']),
    })
  }
  return out
}

/** 已审槽位号，升序。拒绝报文里印的就是它。 */
export function vettedSlots(allow: ReadonlyMap<number, VettedSlot>): number[] {
  return [...allow.keys()].sort((a, b) => a - b)
}

/**
 * 每一条拒绝都带着的那一段。**它说的是「为什么这道闸存在」**，
 * 而不只是「你被拒了」——读到它的人要有办法把事情推进下去。
 */
export function scriptRefusal(reason: string, allow: ReadonlyMap<number, VettedSlot>): string {
  const slots = vettedSlots(allow)
  return (
    `${reason}\n` +
    `已审核的槽位：${slots.length > 0 ? `[${slots.join(', ')}]` : '（空——没有任何脚本被批准）'}\n` +
    'MAST 看不见脚本内部：脚本跑在 RT 控制器上，安全门/模式门/中止门在它里面' +
    `全部不生效。所以只有你在 ${SCRIPT_ALLOWLIST_FILE} 里签过字的槽位才能跑。` +
    '审核步骤见该文件的 _how_to_vet。'
  )
}

/**
 * 这个槽位过审了吗。过了给条目，没过给**那句拒绝**（两者恰有一个非空）。
 *
 * 写成返回一对而不是抛异常，是为了让这道闸**拆得开**：判断写在 `if` 里时下游的
 * 类型收窄挂在它身上，把它改成永远放行会让 `tsc` 直接报错 ——
 * 而一条编不过的变异什么都没验。
 */
export function gateScriptSlot(
  slot: number,
  allow: ReadonlyMap<number, VettedSlot>,
): { readonly entry: VettedSlot | null; readonly refusal: string } {
  if (allow.size === 0) {
    return {
      entry: null,
      refusal: scriptRefusal('拒绝：脚本白名单为空，没有任何脚本槽位被批准供智能体运行。', allow),
    }
  }
  const entry = allow.get(slot)
  if (entry === undefined) {
    return { entry: null, refusal: scriptRefusal(`拒绝：槽位 ${slot} 不在已审核的白名单里。`, allow) }
  }
  return { entry, refusal: '' }
}

/**
 * LUT 的值都在这个槽位声明的范围里吗。**超范围的前 5 个**（多了也看不过来）。
 *
 * 范围由用户在审核脚本时写定 —— 因为**只有他知道脚本把这些数当什么单位用**。
 * 一个 LUT 以毫米计的延时线脚本，喂进去以微米计的数字，会把台子开到硬限位上。
 */
export function lutOutOfRange(values: readonly number[], entry: VettedSlot): number[] {
  if (entry.lutMin === null && entry.lutMax === null) return []
  const lo = entry.lutMin ?? -Infinity
  const hi = entry.lutMax ?? Infinity
  return values.filter((v) => !(lo <= v && v <= hi)).slice(0, 5)
}
