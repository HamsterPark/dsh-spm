/**
 * 传输层的三条策略：失败标记、哪些命令不能重发、模块首次加载的宽限。逐条移植自旧仓
 * `mast/core/connection.py`（v7.1.0）。纯函数与注入时钟，零 I/O、零 dsh；接线在仪器层
 * （`InstrumentService.callRaw`）与谱学技能（`l0/idempotent.ts`）。
 *
 * ## 本仓的连接层对任何命令都不重发
 *
 * 旧仓的连接池在 TCP 级失败后重连并**原样重发一次**，只对「每到一次就做一次事」的命令例外。
 * 本仓的 `callRaw` 一律只发一次：重发的决定放在最清楚读写语义的地方（技能层），
 * 连接层不知道一条命令是否幂等，而超时之后命令很可能已经送达。这里的分类只用来
 * ① 给这类命令的传输失败追加「可能已经执行」的提示；② 让技能层的幂等重试拒绝重做它们。
 * 见 spec/deviations.md D-CONN-?。
 *
 * ## 失败标记
 *
 * `TransportInfo` 说的是「这次失败发生在传输层」，不是控制器答了一个错误：只有这种失败，
 * 对幂等命令隔一会儿再做一次才可能有用（参数被锁、越界，重做一万次也一样）。
 * `maybeDelivered` 说的是「这条命令可能已经到了控制器」：帧写出之后超时、空回包、
 * 回声不符、socket 出错都算；连接没建立、或发送前就已断开（`NotConnected`），命令没发出去，
 * 这时提示「可能已执行」是说谎，会把调用方推去「先读状态」而不是直接重试。
 */

export type TransportKind = 'Timeout' | 'EmptyReply' | 'WrongEcho' | 'SocketError' | 'NotConnected' | 'ConnectFailed'

export interface TransportInfo {
  readonly kind: TransportKind
  readonly maybeDelivered: boolean
}

/** 连接建立失败：命令没发出去。 */
export const CONNECT_FAILED: TransportInfo = Object.freeze({ kind: 'ConnectFailed', maybeDelivered: false })

/** 帧已写出之后的四种失败。 */
const AFTER_SEND: readonly string[] = ['Timeout', 'EmptyReply', 'WrongEcho', 'SocketError']

/**
 * `RoleLinkError.kind` → 标记。`RoleBusy`（没拿到连接锁，命令没发）与认不出的种类
 * 都不是传输失败：给 `undefined`。
 */
export function transportOfKind(kind: string): TransportInfo | undefined {
  if (AFTER_SEND.includes(kind)) return { kind: kind as TransportKind, maybeDelivered: true }
  if (kind === 'NotConnected') return { kind: 'NotConnected', maybeDelivered: false }
  return undefined
}

// ── 哪些命令不能重发 ─────────────────────────────────────────────────────

/**
 * 「每到一次就做一次事」的命令：重发等于让仪器做两次（粗动走 2N 步、两发脉冲、
 * 再起一次扫掠或脚本）。名字里含 `Start` 但不在末尾、也不跟大写字母的，按可重发处理：
 * 照抄参考的正则，不要「更保守」地改成包含 `Start` 就算。
 */
const ACTS_EACH_TIME = /(Pulse|Start|_Run)$|_Start[A-Z]/
/** 名字上看不出、但每到一次也做一次事的命令：再存一份同一帧；把测得的漂移再补偿一次。 */
const ACTS_EACH_TIME_NAMES: ReadonlySet<string> = new Set(['Scan_Save', 'AtomTrack_DriftComp'])
/** 按第一个实参才「做一次事」的命令：命令名 → 不可重发的取值。 */
const ACTS_EACH_TIME_ARG0: Readonly<Record<string, readonly number[]>> = {
  Scan_Action: [0, 3], // 0 起扫、3 继续；停、暂停、冻结可重发
  AutoApproach_OnOffSet: [1], // 开 = 再起一次进针；关可重发
}

/**
 * 按参考那一侧 Python `int(x)` 的读法取第一个实参；读不出给 `undefined`。
 * 布尔读作 0/1，有限数截断取整，十进制整数字符串（可带空白与正负号）照读；
 * `'1.0'`、空串、`null`、缺实参、NaN、无穷大都读不出。
 */
function intArg(x: unknown): number | undefined {
  if (typeof x === 'boolean') return x ? 1 : 0
  if (typeof x === 'number') return Number.isFinite(x) ? Math.trunc(x) : undefined
  if (typeof x === 'string' && /^\s*[+-]?\d+\s*$/.test(x)) return Number(x)
  return undefined
}

/**
 * 一条可能已经送达控制器的命令，再发一次安全吗。读、属性设置、停止、退针可以；
 * 脉冲、起动、运行、起扫与继续扫描、打开自动进针不可以。第一个实参读不出该有的代码时，
 * 一律按不安全处理。
 */
export function resendIsSafe(method: string, args: readonly unknown[] = []): boolean {
  if (ACTS_EACH_TIME.test(method) || ACTS_EACH_TIME_NAMES.has(method)) return false
  const codes = Object.hasOwn(ACTS_EACH_TIME_ARG0, method) ? ACTS_EACH_TIME_ARG0[method] : undefined
  if (codes === undefined) return true
  const first = args.length > 0 ? intArg(args[0]) : undefined
  if (first === undefined) return false
  return !codes.includes(first)
}

// ── 模块首次加载的宽限 ───────────────────────────────────────────────────

/** `<Module>_Open` 与紧随它的下一条命令至少等这么久回包（毫秒）。 */
export const MODULE_OPEN_RECV_MS = 30_000
/** 「紧随 Open 的下一条」只在 Open 之后这么久之内认（秒）。隔了一分钟的那条和模块加载无关。 */
export const MODULE_OPEN_FOLLOWUP_WINDOW_S = 60

/**
 * 模拟器启动后第一次 Open 一个模块时，Open 立即返回，紧跟的那条命令却要等模块加载完，
 * 在缺省的 5 s 内等不到回话。于是 `<Module>_Open` 本身、以及同一角色上紧跟它的**下一条**
 * 命令，recv 超时取 `max(调用方给的, 30 s)`。只延长等待，不重发任何东西。
 *
 * 这一条在参考那边是**推断**，没有在刚启动的控制器上复现过；这里照样继承这个状态。
 *
 * 与参考的一处差别：参考在拿到角色锁之后才取走「上膛」记录；这里在发请求之前取，
 * 于是一次 `RoleBusy` 也会把宽限用掉。代价只是那条命令少了一次宽限。
 */
export class ModuleOpenGrace {
  private readonly armed = new Map<string, number>()
  private readonly clock: () => number

  /** `clock`：单调秒，与熔断器用同一个。 */
  constructor(clock: () => number) {
    this.clock = clock
  }

  /**
   * 这一次调用的 recv 超时（毫秒）。`undefined` = 调用方没给、也不在宽限里，用连接的缺省值。
   * 不是 `*_Open` 的调用总会取走本角色的上膛记录，命中与否都只用一次。
   */
  budgetMs(role: string, method: string, callerMs: number | undefined): number | undefined {
    let grace = method.endsWith('_Open')
    if (!grace) {
      const at = this.armed.get(role)
      this.armed.delete(role)
      grace = at !== undefined && this.clock() - at <= MODULE_OPEN_FOLLOWUP_WINDOW_S
    }
    if (!grace) return callerMs
    return Math.max(callerMs ?? 0, MODULE_OPEN_RECV_MS)
  }

  /** 一次完整往返、控制器也没报错之后调用；只有 `*_Open` 会上膛。 */
  noteSuccess(role: string, method: string): void {
    if (method.endsWith('_Open')) this.armed.set(role, this.clock())
  }
}

// ── 可能已经执行的命令：错误里说清楚 ─────────────────────────────────────

export const NOT_RESENT_HINT =
  '；命令可能已被控制器收到并执行，这里没有重发（重发可能让仪器做两次）。重试之前先读仪器状态。'

/** 给不可重发命令的传输失败追加提示。已经带着就原样返回。 */
export function withNotResentHint(error: string): string {
  return error.includes(NOT_RESENT_HINT) ? error : error + NOT_RESENT_HINT
}
