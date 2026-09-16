/**
 * 同区域撞针追踪。
 *
 * 参考系统曾出现以下循环：一次撞针之后，agent 在**同一个 XY 点**上反复执行
 * PreScanCheck → FullScan（整帧 NaN）→ ConditionTip → TipPulse。
 * 在原地修针修不好一个**一直把针撞坏的位置**（碎屑 / 台阶边 / 一块脏斑）：答案是
 * **离开** —— 退针 + 粗动换区 —— 不是在同一个坐标上继续脉冲。因此状态机需要记录
 * 同一区域的重复撞针，并在达到阈值时拒绝再次尝试。该观测尚未在本仓独立验证。
 *
 * 分工：`FullScan` 的撞针检测**记**一次（记在它的扫描中心），扫描 / 修针类组合技能
 * 在开跑前**问**一次；一个区域撞满 `blockThreshold` 次（默认 2）之后，它们拒绝在那儿
 * 再扫 / 再修，并告诉 agent 怎么逃（退针 + 粗动横移）。一次粗动横移**清空**记录 ——
 * 那就是恢复动作本身；一条过期的记录也会自己作废，于是一次通宵跑不可能被永久卡死。
 *
 * ---
 *
 * ## 三个问题，写在动手之前
 *
 * ### ① 它住在哪里
 *
 * **进程级**（{@link processTipCrash}），与 `processApproachRefusalLatch` /
 * `processVacuum` / `processPresetStore` 同一族。理由与进针拒绝闩逐字相同：
 * **一根针、一块样品** —— 「这个点已经撞过两次」这件事必须跨调用、跨链活着。
 * 换成「每次调用新建一个」就等于每一次都从「没撞过」开始，也就等于这台状态机不存在。
 *
 * ⚠️ **进程级不等于持久**。本仓和旧仓一样**不落盘**：宿主重启之后，30 秒前撞了两次的
 * 那个点重新变成「没撞过」。这是照移，不是新增的洞；但它是**真的洞**，所以
 * {@link TipCrashTracker.snapshot} 交出 `since_s`（这台追踪器活了多久）——
 * 「一条记录都没有」与「我刚出生」是两句话，而只有前者能支持「这儿没撞过」。
 *
 * ### ② 由谁注入
 *
 * **阈值、容差、TTL 是台架的属性，不是类的属性**（D-VAC-1 / D-LIMITS-1 / D-QPLUS-1
 * 同一条）：8 nm 的「同一个点」取决于你在什么尺度上扫，30 分钟的 TTL 取决于漂移有多快。
 * 所以它们走 {@link processTipCrash}`.config`，**墙钟**走 `.nowS`（D-VAC-2：一份每跑
 * 一次都换个数的金样，`git diff` 回答不了「有没有变」）。宿主不接 ⇒ 出厂默认生效，
 * 而出厂默认是旧仓那三个数。
 *
 * ### ③ 宿主不接时是什么行为
 *
 * **不是 fail-open 成「没撞过」。** 具体三条：
 *
 * | 没接什么 | 行为 |
 * |---|---|
 * | `config` | 出厂阈值 2 / 8 nm / 1800 s 生效。闸**照常关**，不是放行 |
 * | `nowS` | `Date.now()/1000`。闸照常关 |
 * | 拒绝台账（`diag`） | 拒绝**照发**，只是少一条面包屑。留痕失败绝不许把一次拒绝变成一次放行 —— 所以 {@link crashGuard} 先做判断、再留痕，留痕在自己的 try 里 |
 *
 * ### 「读不到 ≠ 零 ≠ 否」
 *
 * 一次**读不到扫描中心**的撞针不是「没撞过」。它落进哨兵格 `?:?`，照样计数、照样
 * 拦人（旧仓行为，照移）。而 {@link TipCrashTracker.crashPoints} 把这些**单独交出来**
 * （`unlocated`），**绝不**当成一个点：在一个猜出来的坐标上画避让圈，是在编造一个事实。
 * 拿它选点的调用方避不开它们，就得**把这句话说出来**，而不是让「没有要避的东西」
 * 顶替「我们知道它在这附近发生过」。
 */

import { pyNum } from './scan-resolver.js'
import { pyRound } from './spectroscopy.js'

/** 同一个点撞两次就是「该走了」的信号（现场指令：同点连续 crash ≥ 2 次）。 */
export const DEFAULT_BLOCK_THRESHOLD = 2

/**
 * 「同一个区域」的容差（m）。
 *
 * 现场那次循环重扫的是**一模一样**的中心，但几个纳米的抖动仍然该算同一块坏地方 ——
 * 一张测试图约 10 nm，所以 8 nm 的格子把「基本上是同一个地方」收拢到一起，
 * 又不至于把一次真正的换区也吞掉。
 */
export const DEFAULT_TOL_M = 8e-9

/**
 * 比这更老的撞针不再拦人（秒）。
 *
 * 一次**刻意的**逃逸（粗动横移）立刻清空；这条 TTL 保证的是**即使 agent 一次都没
 * 发起逃逸**，一次通宵跑也能自愈。30 分钟与本仓别处的「过期」窗口同一个数。
 */
export const DEFAULT_TTL_S = 1800.0

/** 哨兵格：一次**读不到扫描中心**的撞针。见抬头「读不到 ≠ 零 ≠ 否」。 */
export const UNLOCATED_CELL = '?:?'

export interface TipCrashConfig {
  readonly blockThreshold: number
  readonly tolM: number
  readonly ttlS: number
}

export const DEFAULT_TIP_CRASH_CONFIG: TipCrashConfig = {
  blockThreshold: DEFAULT_BLOCK_THRESHOLD,
  tolM: DEFAULT_TOL_M,
  ttlS: DEFAULT_TTL_S,
}

/** 一个记住位置的撞针点：格子中心 + 次数。 */
export interface CrashPoint {
  readonly xM: number
  readonly yM: number
  readonly count: number
}

export interface CrashPoints {
  readonly located: readonly CrashPoint[]
  /** 读不到位置的那些撞针**次数**（不是格数）。**永远不当成一个点交出去。** */
  readonly unlocated: number
}

export interface TipCrashSnapshot {
  readonly block_threshold: number
  readonly tracked_regions: number
  readonly blocked_regions: number
  readonly max_count: number
  /**
   * 这台追踪器活了多久（秒）。
   *
   * **本仓新增**，理由在抬头 ①：进程级的状态没有持久化，于是「一条记录都没有」
   * 在重启之后与「这儿真的没撞过」长得一模一样。把出生时刻交出来，读的人至少
   * 分得开这两句话。
   */
  readonly since_s: number
}

interface Cell {
  count: number
  last: number
}

/** 按量化后的 XY 格子数撞针次数；到阈值就把这个区域封掉。 */
export class TipCrashTracker {
  readonly #cells = new Map<string, Cell>()
  readonly #cfg: () => TipCrashConfig
  readonly #nowS: () => number
  readonly #bornS: number

  constructor(cfg: () => TipCrashConfig, nowS: () => number) {
    this.#cfg = cfg
    this.#nowS = nowS
    this.#bornS = nowS()
  }

  /**
   * 量化成格子键。**读不到坐标的一律收进同一个哨兵格**，于是「在某个不知道哪儿的
   * 地方反复撞」照样数得出来。
   */
  #cell(xM: unknown, yM: unknown): string {
    const x = finite(xM)
    const y = finite(yM)
    if (x === null || y === null) return UNLOCATED_CELL
    const tol = this.#cfg().tolM
    // Python 的 `round()` 是**银行家舍入**（`round(0.5)` = 0，D-LANG-2）。格子键上这个
    // 差别只在「正好落在格子边界」时出现，而那时两侧都是合法答案；走 `pyRound` 是为了
    // 与旧仓录下来的金样逐格对得上，不是因为哪一侧更对 —— 而且仓里只该有**一份**它。
    return `${pyRound(x / tol, 0)}:${pyRound(y / tol, 0)}`
  }

  #prune(now: number): void {
    const ttl = this.#cfg().ttlS
    for (const [key, rec] of [...this.#cells]) {
      if (now - rec.last > ttl) this.#cells.delete(key)
    }
  }

  /** 记一次撞针，返回这个区域的累计次数。 */
  recordCrash(xM?: unknown, yM?: unknown): number {
    const cell = this.#cell(xM, yM)
    const now = this.#nowS()
    this.#prune(now)
    const rec = this.#cells.get(cell) ?? { count: 0, last: 0.0 }
    rec.count += 1
    rec.last = now
    this.#cells.set(cell, rec)
    return rec.count
  }

  crashCount(xM?: unknown, yM?: unknown): number {
    const now = this.#nowS()
    this.#prune(now)
    return this.#cells.get(this.#cell(xM, yM))?.count ?? 0
  }

  /**
   * 这个区域已经撞满阈值了吗 —— 真则调用方**必须逃**（退针 + 粗动横移），不是在这儿重试。
   */
  isBlocked(xM?: unknown, yM?: unknown): boolean {
    return this.crashCount(xM, yM) >= this.#cfg().blockThreshold
  }

  /**
   * 把记着的撞针全部列出来。
   *
   * **为什么非有不可**：`crashCount` 回答的是「你在**这儿**撞过吗」，只对一个
   * **已经有点可问**的调用方有用。而**选点**的那一侧问题正相反 —— 它正在挑那个点，
   * 所以需要事先把撞针枚举出来才躲得开。没有这个方法，追踪器知道的事对任何一个
   * 选位置的人都是够不着的。
   *
   * 坐标是**格子中心**，不是撞针的精确点：追踪器只存过量化后的键。还原误差最多
   * `tolM / 2`（8 nm 默认下是 4 nm），比消费它的避让半径小两个数量级，改不了任何
   * 一个决定。**刻意不加一个补偿项**：半径属于避让模型，在这里再私藏一份，正是
   * 本仓一再付账的那种「第二套约定」。
   */
  crashPoints(): CrashPoints {
    const now = this.#nowS()
    this.#prune(now)
    const tol = this.#cfg().tolM
    const located: CrashPoint[] = []
    let unlocated = 0
    for (const [key, rec] of this.#cells) {
      if (rec.count <= 0) continue
      if (key === UNLOCATED_CELL) {
        unlocated += rec.count
        continue
      }
      const [cx, cy] = key.split(':')
      located.push({ xM: Number(cx) * tol, yM: Number(cy) * tol, count: rec.count })
    }
    return { located, unlocated }
  }

  /**
   * 清掉撞针历史 —— 逃逸发生了。
   *
   * 给了坐标就只清那一个区域（例如一次干净的扫描证明针尖在这儿是好的）；
   * **不给坐标就全清** —— 一次粗动横移是一句刻意的「换区」，此后每一个旧的坏点
   * 都在身后了。
   */
  noteRecovery(xM?: unknown, yM?: unknown): void {
    // `None` 在 TS 这一侧有**两个**拼法。只认一个，等于让一次「全清」在
    // `noteRecovery(null, null)` 上悄悄退化成「清掉哨兵格」。
    const noX = xM === undefined || xM === null
    const noY = yM === undefined || yM === null
    if (noX && noY) {
      this.#cells.clear()
      return
    }
    this.#cells.delete(this.#cell(xM, yM))
  }

  clear(): void {
    this.#cells.clear()
  }

  snapshot(): TipCrashSnapshot {
    const now = this.#nowS()
    this.#prune(now)
    const threshold = this.#cfg().blockThreshold
    const counts = [...this.#cells.values()].map((r) => r.count)
    return {
      block_threshold: threshold,
      tracked_regions: this.#cells.size,
      blocked_regions: counts.filter((c) => c >= threshold).length,
      max_count: counts.length > 0 ? Math.max(...counts) : 0,
      since_s: now - this.#bornS,
    }
  }
}

/**
 * 进程级的那一份 —— 扫描 / 修针类组合技能问的就是它。
 *
 * 三个字段的理由见抬头 ①②③。`tracker` 惰性建，于是改 `config` / `nowS` 在第一次
 * 使用之前都还来得及（测试与宿主接线都要这一点）。
 */
export const processTipCrash: {
  config: Partial<TipCrashConfig>
  nowS: () => number
  tracker: TipCrashTracker | null
} = { config: {}, nowS: () => Date.now() / 1000, tracker: null }

export function tipCrashConfig(): TipCrashConfig {
  return { ...DEFAULT_TIP_CRASH_CONFIG, ...processTipCrash.config }
}

/** 共用的那台追踪器。 */
export function getTipCrashTracker(): TipCrashTracker {
  processTipCrash.tracker ??= new TipCrashTracker(tipCrashConfig, () => processTipCrash.nowS())
  return processTipCrash.tracker
}

/** 测试 / 新一轮跑的清场：把共用追踪器的状态抹掉。 */
export function resetTipCrashTracker(): void {
  getTipCrashTracker().clear()
}

/**
 * 「离开这儿」的那条指令 —— 说给操作员与 agent 听。
 *
 * 逐字照移。里面那两句点名的东西各自承担一件事：
 * **`RelocateCoarseXY`** 是唯一一条带着「收压电 → 退针清障 → 逐级自检 → 核真空与驱动
 * 电压 → 分块移动时看电流 → 重新进针」的路；而 **`MotorMove`** 只检查压电有没有收到顶
 * （约 1 µm 余量，而且读不到状态时会放行）——**那正是又一次撞针的来路**。
 */
export function crashEscapeMessage(count: number, xM?: unknown, yM?: unknown): string {
  let where = ''
  const x = finite(xM)
  const y = finite(yM)
  if (x !== null && y !== null) where = `(≈${expo3(x)}, ${expo3(y)} m)`
  return (
    `repeated_crash_escape_required: 同一区域${where}已连续检测到针尖 crash ` +
    `${count} 次。原地扫描/修针/打脉冲无效——停止在此处重试。请用 ` +
    `**RelocateCoarseXY** 换到新区域(先用 get_coarse_map 看该往哪走多少步);` +
    `它会自己收压电、用粗动马达退针清障并逐级自检、核对真空与驱动电压、` +
    `分块移动时看着电流,最后重新进针。` +
    `**不要直接调 MotorMove 做横向移动** —— 它只检查压电是否收到顶(约 1 µm 余量,` +
    `而且读不到状态时会放行),这正是又一次撞针的来路。` +
    `切勿在同点继续 ConditionTip/TipPulse。`
  )
}

/** 留痕的口子。宿主接 `ctx.markers.emit`（D-DIAG-1）；不接就是没有面包屑。 */
export type CrashDiag = (kind: string, data: Record<string, unknown>) => void

/**
 * 这个区域被封了吗？封了就返回那条逃逸指令，没封返回 `null`。
 *
 * 组合技能在 `runComposite` 的最前面调它。
 *
 * ⚠️ **判断在前，留痕在后，而且留痕不许改变返回值。** 旧仓把 `diagnostics.record`
 * 包在一个吞掉一切的 `except` 里，意思是一样的；这里把顺序写死，是因为反过来写
 * （先留痕、失败就提前 return）会让一次**记不下来的拒绝**变成一次放行 —— 而那正是
 * 这道闸存在的全部理由的反面。
 */
export function crashGuard(xM?: unknown, yM?: unknown, diag?: CrashDiag): string | null {
  const tracker = getTipCrashTracker()
  if (!tracker.isBlocked(xM, yM)) return null
  const count = tracker.crashCount(xM, yM)
  const msg = crashEscapeMessage(count, xM, yM)
  try {
    diag?.('tip_crash', {
      subject: 'repeated_same_region',
      reason: '同区域连续 crash≥阈值,拒绝原地重试——需退针+粗动换区',
      count,
      x_m: xM ?? null,
      y_m: yM ?? null,
    })
  } catch {
    /* 留痕炸了不许把一次拒绝变成一次放行 */
  }
  return msg
}

/**
 * 能当坐标用的那种数 —— 就是 {@link pyNum}，仓里只该有这一份 `float()`。
 *
 * 旧仓这里是 `round(float(x) / tol)` 包在 `except (TypeError, ValueError)` 里：
 * `float('nan')` 走 `round(nan)` 抛 ValueError ⇒ 哨兵格（对）；而 `float('inf')` 走
 * `round(inf)` 抛的是 **OverflowError**，那个 `except` **收不住** ⇒ 一次撞针记录把
 * 整个技能炸掉。本仓 `pyNum(Infinity)` 给 `null` ⇒ 同样进哨兵格：
 * 一个读不出坐标的撞针仍然是一次撞针（抬头「读不到 ≠ 零 ≠ 否」）。
 */
function finite(v: unknown): number | null {
  return pyNum(v)
}

/**
 * Python 的 `f"{x:.3e}"`。JS 的 `toExponential(3)` 给 `1.000e-8`，Python 给 `1.000e-08`。
 *
 * ⚠️ 这是**第三份**（`stm-skills/src/l0/common.ts` 的 `pyExp`、`vision` 的 `exp2`）。
 * 它们不能互相 import：内核是最底下那层。收语言分歧那一族的时候这三份该一起搬进
 * `si.ts`（同 D-LANG-1 的 `pyFixed`）—— 这一轮并行支线在改文件，先各自留着。
 */
function expo3(x: number): string {
  const s = x.toExponential(3)
  const i = s.indexOf('e')
  const mant = s.slice(0, i)
  let exp = s.slice(i + 1)
  const sign = exp.startsWith('-') ? '-' : '+'
  if (exp.startsWith('-') || exp.startsWith('+')) exp = exp.slice(1)
  if (exp.length < 2) exp = `0${exp}`
  return `${mant}e${sign}${exp}`
}
