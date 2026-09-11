/**
 * 「扫描停了」到底是什么意思 —— `WaitScanComplete` 的全部判断都在这里。
 *
 * ## 「没在扫」不等于「扫完了」
 *
 * v6.1.2 之前这个技能读到 `Scan_StatusGet == 0` 就宣布这一帧完成，没有任何东西看过
 * 行数。于是一次扫描能提前停下的**每一个理由**——用户按了 Stop、Nanonis 自己停了、
 * 一次安全停机、一次抖动——都以 `success=True, timed_out=False` 的形状到达上游，
 * 而调用方就凭一帧**从来没采到过**的图去保存 / 重配 / 重启。2026-08-04 真机上一次
 * 扫描确实在 24 % 处停下且没有出文件；当时没有 wait 在飞，所以下游没有据此动作，
 * 但这条路是可达的，而且被演示过了。
 *
 * 所以状态归 0 时要问一次缓冲区：**有几行真的带着数据**。
 *
 * ## 读不到就 fail open，而且要说出来
 *
 * 缓冲区读不出来时结局保持 `completed`、`linesVerified: false`——也就是「这条检查
 * 存在之前的行为」外加一句「什么都没验证」的自陈。另一种做法（把一次量不到的扫描叫
 * 「中途停止」）会为了防一个看不见的情况，砸掉每一台回包形状我们解不动的装机。
 *
 * **「不可测」不是「被截断」，`null` 不是 `0`。** 第一版把 `lines_done is None` 和
 * `== 0` 判成同一件事，于是一台缓冲区读不出来的装机会被告知「扫描从没开始」。
 */
import { frameAcquiredLines, type BufferGet } from './scan-reply.js'

/**
 * 「还没起来」的宽限期（秒）。**这不是等待预算，是开扫的握手窗口。**
 *
 * 真机 2026-08-13：一次预扫描 **0.31 秒**就报「中途停止 (0/256 行)」。那一跑的
 * `completed_steps` 是完整的六步、`failed_steps` 空——**`StartScan` 是成功的**。
 * 机制是：`StartScan` 返回之后 Nanonis 还没把扫描架起来，而轮询的**第一次**
 * `Scan_StatusGet` 就读到 0，于是走进「status 0 == 扫描停了」那一支；缓冲区当然是
 * 0 行 ⇒ `stopped_early`，报出来的话是「需排查停止方（用户 Stop / Nanonis 自停 /
 * 安全停机）」——**一句把人送去查一件没发生的事的话**。
 *
 * 这条竞态也解释了 2026-08-12 那次 ForgeAuTip 死在站点 2 的同一句报错，以及它为什么
 * 时有时无：开扫前那几个调用越慢，Nanonis 架起来就越晚。
 *
 * 5 秒的依据：实测竞态窗口 0.31 秒，给 10× 余量；而任何一次真实扫描至少几十秒，
 * 所以这个窗口对正常路径**不可见**。它只在「从没见它跑起来」时才计时。
 */
export const START_GRACE_S = 5.0

/**
 * 一次还在推进的扫描最多把死线往后推几次，每次推原始预算的多少。
 *
 * **有意封顶**：这是给一帧估错了时间的宽限，不是无限等待的许可证。两次 × 25 % 覆盖
 * 实测到的 32 % 低估还有余量，总超支封在预算的 50 %。
 */
export const MAX_EXTENSIONS = 2
export const EXTENSION_FRACTION = 0.25

/** 一次行数测量的结果。 */
export interface LineMeasurement {
  readonly linesDone: number | null
  readonly linesTotal: number | null
  /** 仪器**告诉过我们**了吗。false = 什么都没验证，按旧行为处理。 */
  readonly linesVerified: boolean
  readonly stoppedEarly: boolean
}

const UNMEASURED: LineMeasurement = {
  linesDone: null,
  linesTotal: null,
  linesVerified: false,
  stoppedEarly: false,
}

/** 抓哪一路通道。缓冲区读不出来时用 0——它是 Nanonis 的默认通道。 */
export function grabChannel(buffer: BufferGet | null): number {
  const ids = buffer?.channelIndexes ?? []
  return ids.length > 0 ? (ids[0] as number) : 0
}

/**
 * 这一帧到底采了多少行。
 *
 * `buffer` 为 `null` 表示读不到（读失败或解不出）；`frameBody` 为 `null` 同理。
 *
 * ⚠️ 帧的行数与缓冲区配置**对不上**时拒绝判断：抓回来的不是我们问的那一帧——回包
 * 形状搞错了、缓冲区在我们脚下被改了、或者这台仪器根本不整帧分配。不管是哪一种，
 * 那两个数描述的是**不同的对象**，相除只会**制造**一个截断出来。
 */
export function measureLines(buffer: BufferGet | null, frameBody: unknown): LineMeasurement {
  const configured = buffer !== null && buffer.lines !== null && buffer.lines > 0 ? buffer.lines : null
  const measured = frameBody === null || frameBody === undefined ? null : frameAcquiredLines(frameBody)
  // 抓不到帧：缓冲区那一半的答案照样留着（它是真读到的）
  if (measured === null) return { ...UNMEASURED, linesTotal: configured }
  const [done, rows] = measured
  if (configured !== null && rows !== configured) return { ...UNMEASURED, linesTotal: configured }
  const total = configured ?? rows
  return {
    linesDone: done,
    linesTotal: total,
    linesVerified: true,
    stoppedEarly: total > 0 && done < total,
  }
}

/** 状态归 0 之后的三选一。 */
export type TerminalOutcome = 'completed' | 'stopped_early' | 'never_started'

export interface TerminalVerdict {
  readonly outcome: TerminalOutcome
  readonly neverStarted: boolean
  readonly stoppedEarly: boolean
}

/**
 * 扫描停了。它**完成**了、被**中途停下**了、还是**从没开始**？
 *
 * 「它从没开始」与「它跑了一半被停下」是两个事实，指向的下一步也不同：前者查我们
 * 自己的发起时序，后者才该去查用户 Stop / Nanonis 自停。混成一句话，读的人会去查
 * 一件没发生的事。
 *
 * `seenRunning` 是那道分水岭——见过一次 `status != 0` 之后，再读到 0 就**确实**是
 * 「停了」。
 */
export function terminalVerdict(seenRunning: boolean, lines: LineMeasurement): TerminalVerdict {
  // ⚠️ `linesDone === null` 是**读不到**，不是**零行**。
  const neverStarted = !seenRunning && lines.linesDone === 0
  const stoppedEarly = lines.stoppedEarly && !neverStarted
  return {
    outcome: neverStarted ? 'never_started' : stoppedEarly ? 'stopped_early' : 'completed',
    neverStarted,
    stoppedEarly,
  }
}

/**
 * 状态读到 0、但**一次都没见它跑起来**、还在宽限期内 —— 这是 2026-08-13 那条竞态吗？
 *
 * ⚠️ 分岔靠**缓冲区**，不能只靠时间。第一版在宽限期内直接继续、不测行数，于是
 * 「等待开始前扫描就已经跑完了」这种完全正常的情况也要空等满 5 秒——一条既有测试
 * （「已经扫完 ⇒ 1 次轮询」）当场从 1 次变成 182 次。**一个只看时钟的判据答不出
 * 「它到底跑过没有」。**
 *
 * 三种answer：
 * - 有行数（> 0）⇒ 它跑过，走正常判定（旧行为逐字不变）；
 * - **确证** 0 行 ⇒ 还没起来，继续等（这才是那条竞态）；
 * - 读不到 ⇒ **fail open**，按旧行为走。
 */
export function stillStarting(
  seenRunning: boolean,
  elapsedS: number,
  probe: LineMeasurement,
): boolean {
  return !seenRunning && elapsedS < START_GRACE_S && probe.linesDone === 0
}

export interface ExtensionVerdict {
  /** 死线动了吗。 */
  readonly grant: boolean
  /** 动到哪儿（`grant` 为假时无意义）。 */
  readonly deadlineS: number
  /** 行数**掉下去**了 —— 不是卡住，是仪器换了一帧。 */
  readonly frameRestarted: boolean
  /** 这一轮读到的行数，留给下一轮当参照（读不到就保持上一轮的）。 */
  readonly lastLines: number | null
}

/**
 * 预算到点了。它是**卡住了**，还是只是比预计慢？
 *
 * 2026-08-05 真机：一次 512 行的普查在第 **511/512** 行——99.8 %——被掐掉，因为那一帧
 * 比估计超了约 32 %，而预算的 30 % 余量恰好就是这么大。Nanonis 其实已经扫完并写出了
 * 完整的 4,196,328 字节。**34 分钟的采集被一只秒表扔掉了。**
 *
 * 预算是用来抓一次**哪儿也没去**的扫描的。跟一次看得见还在出行的扫描赛跑，回答的是
 * 另一个问题。所以到点时看行数：还在爬 ⇒ 给一次有界的延期，并且说出来。
 *
 * 判据是**相对上一次严格增长**：
 * - 行数相等**不算**——一次冻在第 300 行的扫描照常耗光延期然后死掉；
 * - 行数**读不到**也不算——延期必须靠正面证据**挣**到，否则一台缓冲区读不出来的
 *   机器会在每一次超时上永远等下去（向旧行为退化，也就是放弃）；
 * - 行数**掉下去**是它自己的答案，而且不是「没有进展」。只有一件事会让这个数变小：
 *   我们数的那一帧被一个更新的换掉了——Nanonis 扫完了它又开了下一帧，因为
 *   `Continuous scan` 开着。那次扫描进展好得很；它只是**永远不会停**，所以再多死线
 *   也没用，而把它叫「卡住」会把下一个读的人送去找一个卡住的压电。
 *   （真机 2026-08-09 观测到：第 2 帧读到约 234 行，第 4 帧再读到约 208 行。两个读数
 *   都是对的。）
 */
export async function extensionVerdict(args: {
  readonly extensions: number
  readonly prev: number | null
  /**
   * 去量一次行数。**惰性**的：额度用完时这一下根本不该发生。
   *
   * 抓一整帧要搬约 1 MB（512²），而且是压在扫描自己用的那条套接字上。「什么时候
   * 值得花这一次」是判据的一部分，所以它留在这里，不下放给调用方——下放的结果是
   * 调用方自己也得知道 {@link MAX_EXTENSIONS}，于是同一条纪律有了两个主人。
   * （移植时就栽在这儿：每一次额度耗尽的超时都白抓了一帧。）
   */
  readonly measure: () => Promise<LineMeasurement>
  readonly timeoutS: number
  readonly elapsedS: number
}): Promise<ExtensionVerdict> {
  const { extensions, prev, timeoutS, elapsedS } = args
  const no = (frameRestarted: boolean, lastLines: number | null): ExtensionVerdict => ({
    grant: false,
    deadlineS: Number.NaN,
    frameRestarted,
    lastLines,
  })
  if (extensions >= MAX_EXTENSIONS) return no(false, prev)
  const done = (await args.measure()).linesDone
  if (done === null) return no(false, prev)
  if (prev !== null && done < prev) return no(true, done)
  if (prev === null || done <= prev) return no(false, done)
  return {
    grant: true,
    deadlineS: elapsedS + timeoutS * EXTENSION_FRACTION,
    frameRestarted: false,
    lastLines: done,
  }
}

/** 调用方**唯一**要读的那个字段。 */
export type WaitOutcome =
  | 'completed'
  | 'stopped_early'
  | 'never_started'
  | 'timed_out'
  | 'restarted'
  | 'aborted'
  | 'unknown'

/**
 * 汇总成一个字段，而不是一堆布尔让调用方自己去正确地组合。
 *
 * `aborted` 压过一切，因为它是唯一一个**也翻转 success** 的。没有任何一次轮询到达
 * 终态时（比如轮询步数用光了）结论是 `unknown`——**不是 `completed`**：没有任何东西
 * 说过它完成了。
 */
export function waitOutcome(aborted: boolean, recorded: string | null | undefined): WaitOutcome {
  if (aborted) return 'aborted'
  return (recorded || 'unknown') as WaitOutcome
}
