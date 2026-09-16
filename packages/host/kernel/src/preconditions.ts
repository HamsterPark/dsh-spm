/**
 * 前置条件 —— 逐字移植 `mast/core/preconditions.py`。
 *
 * ## 精确名单优先，子串规则只兜底
 *
 * 2026-08-10 之前这一层**只有子串规则**，而 **`"on"` 是 `"z_controller_off"` 的子串**
 * （c-**on**-troller）。于是第一条规则（要求控制器 ON）命中了 `z_controller_off`、
 * `break` 掉，第二条规则**从来没被执行过，是不可达的死代码**。净效果是
 * `z_controller_off` 被**完全反过来**判：
 *
 * | 硬件实际 | 应该 | 实际发生 |
 * |---|---|---|
 * | OFF（正是它要求的） | 放行 | **拒绝**，理由还写着「Z controller is OFF」 |
 * | ON（正是它禁止的） | 拒绝 | **放行** |
 *
 * 放行那一侧才是要命的：`MotorMove` / `MotorMoveClosedLoop` 声明的就是
 * `z_controller_off`，而「反馈环还闭着的时候跑开环粗进针马达」正是这条前置存在的
 * 全部理由——**那是撞针**。
 *
 * 2026-08-10 真机逐字复现了拒绝那一侧：针尖顶在压电行程尽头、要粗动退针，
 * 而退针被这道门拒了两次，理由是「Z controller is OFF」——**它正是关着的**。
 * 中间还夹了一次真实状态读，仍然拒：**快照一直是对的，错的是规则。**
 *
 * 与安全表的 `_GLOBAL_CHECKS` 是同一族教训（那次是「避免宽泛的 `x`/`z`，
 * 用 `x_m`/`bias_v`」）。**宽泛子串在否定形式上尤其危险：一个词的否定词往往包含它自己。**
 *
 * ## 两种相反的失败方向
 *
 * 上面所有比较状态字段的规则都**读不到就放行**（未知状态下拦住，可能让人在针要撞
 * 上去时按不动按钮）。而 `vacuum_ok_for_coarse` 恰好相反：**读不到的压强正是它存在
 * 要拒绝的那个条件**——一个看不见的规压计，与「在放电带里」或「在大气下」无法区分，
 * 而在那里驱动粗动压电会击穿叠层绝缘，**没有重试**。
 *
 * 回答它的那个判定机在 `vacuum-interlock.ts`（`vacuumCoarseCheck()` 造出一个
 * `ComputedCheck`）。**本模块不替它 fail-closed**：没接上时 `vacuum_ok_for_coarse`
 * 落回子串层、认不出、当没这条。fail-closed 是那只闸自己的性质，
 * 而「宿主有没有把闸接上」是宿主的决定 —— 在这里替它拒绝，会让一个**从未接过**
 * 真空计的台架永远动不了粗动，并且说不清是谁拒的。接法见 `vacuumCoarseCheck` 的注释。
 */
import type { HardwareState } from './hardware-state.js'

/** 精确名单：前置名 → `[状态字段, 期望值]`。**判定只认这张表**，子串只兜底。 */
export const PRECONDITION_CHECKS: Readonly<Record<string, readonly [keyof HardwareState, boolean]>> = {
  z_controller_on: ['z_controller_on', true],
  z_controller_off: ['z_controller_on', false],
  scan_running: ['scan_running', true],
  scan_stopped: ['scan_running', false],
  scan_not_running: ['scan_running', false],
}

/**
 * 布尔背后那个更精确的字段——**报违反时必须一起印出来**。
 *
 * `z_controller_on` 是**六个可区分状态坍缩成的一个布尔**（状态码 == 2），
 * 所以 Off(1) / Hold(3) / SwitchingOff(4) / SafeTip(5) / Withdrawing(6) 全都读成 false。
 * 「被挂起」「Nanonis 自己进了保护态」「有人关掉了它」**是三件事，要三句话**。
 */
export const PRECONDITION_CONTEXT_FIELDS: Readonly<Record<string, keyof HardwareState>> = {
  z_controller_on: 'z_controller_status',
}

/** 布尔为 false 时，各个模块状态各自意味着什么（只用于措辞，不参与判定）。 */
export const ZCTRL_STATUS_HINT: Readonly<Record<string, string>> = {
  Off: '确实被关掉了',
  Hold: '被**挂起**(hold)——不是被关掉;挂起它的那一步没有把它放回来',
  SwitchingOff: '正在关闭中(switch-off delay 未走完)——再等一下可能就好了',
  SafeTip: 'Nanonis 自己进了 **SafeTip 保护态**——没有人关它,是仪器躲开了',
  Withdrawing: '正在退针',
}

/** `(字段, 期望)` → 人话。措辞与旧的子串模板逐字相同。 */
const EXACT_MESSAGES: Readonly<Record<string, string>> = {
  'z_controller_on|true': 'Z controller is OFF',
  'z_controller_on|false': 'Z controller is ON',
  'scan_running|true': 'scan is not running',
  'scan_running|false': 'scan is running',
}

/**
 * 子串兜底规则：`[名字子串们, 字段, 违反值, 消息模板]`。
 * **每个子串都出现**才算命中；**第一条命中的赢**。`违反值` 是**违反**这条前置的状态值。
 *
 * ⚠️ 这张表**只对精确名单里没有的名字生效**——否定形式排在前面只是纵深防御。
 */
const SUBSTRING_RULES: readonly (readonly [readonly string[], keyof HardwareState, unknown, string])[] = [
  [['z_controller', 'off'], 'z_controller_on', true, "{precondition}' — Z controller is ON"],
  [['z_controller', 'on'], 'z_controller_on', false, "{precondition}' — Z controller is OFF"],
  [['scan', 'not_running'], 'scan_running', true, "{precondition}' — scan is running"],
  [['scan', 'stopped'], 'scan_running', true, "{precondition}' — scan is running"],
  [['scan', 'running'], 'scan_running', false, "{precondition}' — scan is not running"],
  [['bias', 'nonzero'], 'bias_v', 0.0, "{precondition}' — bias is zero"],
  // 粗动前的针尖间隙。注意它**不**意味着什么：`withdrawn` 是精调压电顶到上限，
  // 一两微米。横向粗动需要几十微米，那只有粗 Z 退针给得了——那是 RelocateCoarseXY
  // 的活，不是这条前置的。
  [
    ['withdrawn'],
    'withdrawn',
    false,
    "{precondition}' — tip is not withdrawn (retract the tip before a coarse motor move)",
  ],
  [
    ['tip', 'clear'],
    'withdrawn',
    false,
    "{precondition}' — tip is not withdrawn (retract the tip before a coarse motor move)",
  ],
]

/** 由**活的子系统**回答、而不是比对状态字段的前置。 */
export type ComputedCheck = () => { readonly ok: boolean; readonly reason: string }

/** 违反消息的补充说明。**读不到伴随字段就返回空串**——「没读到」不该被写成一个编出来的状态名。 */
export function contextSuffix(attr: string, state: HardwareState): string {
  const companion = PRECONDITION_CONTEXT_FIELDS[attr]
  if (companion === undefined) return ''
  const value = state[companion]
  if (value === null || value === undefined) return ''
  const text = String(value)
  const hint = attr === 'z_controller_on' ? ZCTRL_STATUS_HINT[text] : undefined
  return hint !== undefined ? `（${companion}=${text}：${hint}）` : `（${companion}=${text}）`
}

/** Python 的 `repr()` 形状，用在「读到 X，要求 Y」里。 */
function pyRepr(v: unknown): string {
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'number') return Number.isInteger(v) ? `${v}.0` : String(v)
  return String(v)
}

/** 判定用的两层共用实现。返回违反消息（空 = 全部满足）。 */
export function checkStatePreconditions(
  preconditions: readonly string[],
  state: HardwareState,
  computed: Readonly<Record<string, ComputedCheck>> = {},
): string[] {
  const violations: string[] = []
  for (const precondition of preconditions) {
    const pc = precondition.toLowerCase()

    const comp = computed[pc]
    if (comp !== undefined) {
      const { ok, reason } = comp()
      if (!ok) violations.push(`Precondition failed: '${precondition}' — ${reason}`)
      continue
    }

    // **精确名单优先**——这就是 2026-08-10 那个反转 bug 的修法
    const exact = PRECONDITION_CHECKS[pc] ?? PRECONDITION_CHECKS[precondition]
    if (exact !== undefined) {
      const [attr, expected] = exact
      const actual = state[attr]
      // `null` = 读不到 ⇒ **放行**（与子串层历来的 fail-open 一致）
      if (actual !== null && actual !== undefined && actual !== expected) {
        const msg = EXACT_MESSAGES[`${attr}|${expected}`] ?? `${attr} is ${pyRepr(actual)}, expected ${pyRepr(expected)}`
        violations.push(
          `Precondition failed: '${precondition}' — ${msg}` +
            `（读到 ${attr}=${pyRepr(actual)}，要求 ${pyRepr(expected)}）` +
            contextSuffix(attr, state),
        )
      }
      continue
    }

    for (const [substrings, attr, badValue, template] of SUBSTRING_RULES) {
      if (!substrings.every((s) => pc.includes(s))) continue
      const actual = state[attr]
      const violated =
        attr === 'bias_v'
          ? actual !== null && actual !== undefined && actual === badValue
          : actual === badValue // 布尔字段：恒等匹配，null/未知放行
      if (violated) {
        violations.push(
          `Precondition failed: '` + template.replace('{precondition}', precondition) + contextSuffix(attr, state),
        )
      }
      break // 第一条命中的赢
    }
  }
  return violations
}

/**
 * 这个名字本模块认不认得——精确名单、计算型、或子串规则命中。
 *
 * 让调用方分得清「**真的不认识**」（→「无法验证」）与「认得且已满足」（→ 放行）。
 * 没有它的时候，只活在子串规则里的 `bias_nonzero` 在每次逼近都被报成「无法验证」，
 * 哪怕偏压确实非零。
 */
export function preconditionRecognized(
  name: string,
  computed: Readonly<Record<string, ComputedCheck>> = {},
): boolean {
  if (name in PRECONDITION_CHECKS) return true
  const pc = name.toLowerCase()
  if (pc in computed) return true
  return SUBSTRING_RULES.some(([subs]) => subs.every((s) => pc.includes(s)))
}
