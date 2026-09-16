/**
 * 异步硬件动作 + 同连接双通道读回 —— **采集循环的单一实现**，以及它的落盘。
 *
 * TipShaper 和 Bias_Pulse 都有一个 `Wait_until_done` 参数：传 0 时调用立即返回，
 * 动作在 Nanonis 控制器上自己跑完，于是宿主侧可以在**同一条** TCP 连接上边跑边
 * 轮询电流与 Z —— 拿到的是过程中的曲线，不是事后的前后对比。
 *
 * 两个技能的循环本来就是同一个，且其中四个细节都容易写错：
 *
 * * **绝对时刻调度**（`nextPoll += period`，不是 `sleep(period)`）。相对睡眠会把
 *   每次 RTT 和处理时间累积成相位漂移。
 * * **pre-roll 基线**要在开火之前采够，否则判据没有 z1 可比。
 * * **开火那一次调用阻塞了多久**要计时：某些固件忽略 wait=0，真的把整个过程跑完
 *   才返回。那时采到的主要是事后状态，必须如实标注而不是假装拿到了过程曲线。
 * * **abort 早退**每帧都要查。
 *
 * 写两份的下场是其中一份的修复到不了另一份，所以这里只写一份 —— 而且连
 * `CaptureSignalBuffer` 那条单通道的循环也走同一个骨架（{@link pollLoop}）。
 * 旧仓那两个循环是分开写的（`capture_signal_buffer.py` 早于 `_readback_stream.py`），
 * 于是「绝对时刻调度」这一条在旧仓里确实有**两份**。
 *
 * ## 动词仍然是字面量
 *
 * 骨架收成一份，但 `safeCall('Current_Get')` 这样的**字面动词留在调用点**。
 * 旧仓 `capture_signal_buffer` 的注释把理由写死了：本仓所有安全工具（中止策略
 * 检查、安全审计、API 覆盖普查）都是靠 grep `safe_call("…")` 找 Nanonis 调用的，
 * 一个经变量到达的动词对这三样**全部不可见** —— 调用发生了，而看管这套系统的
 * 东西一个都看不见。
 *
 * ## D-STREAM-1 · 取数走 `scalarFloat`，不走旧仓那第四份 `_scalar`
 *
 * 旧仓把三份手写的 `_scalar` 收进了 `io/nanonis_files.scalar_float`，而
 * `_readback_stream.scalar` 是**没被收进去的第四份**。它在多元素 body 上
 * 直接取 `d[0]`、在嵌套表上再取 `v[0]` —— 正是 `scalar_float` 的 docstring 点名
 * 说最难查的那一种（「双通道回包上悄悄选一路」）。这里走 `scalarFloat`：
 * 多元素 body **一个样本都不记**，而不是猜一路。
 *
 * 两条动词（`Current_Get` / `ZCtrl_ZPosGet`）的协议声明都是单个 `f`，所以这条
 * 偏离在金样上一格都不体现 —— 它只在协议被违反时才分岔，而那时沉默比猜好。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pyMean, pySum, scalarFloat, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'

/** 回包里第一个能当读数用的标量。取不出给 `null`（D-STREAM-1）。 */
export function scalar(rec: SkillCallRecord): number | null {
  const b = rec.values ?? []
  return b.length === 0 ? null : scalarFloat(b[0])
}

/** 一条通道的摘要。空表时四个统计量全是 `null` —— **不是 0**。 */
export interface ChannelStats {
  readonly n: number
  readonly min: number | null
  readonly max: number | null
  readonly mean: number | null
  readonly std: number | null
}

export function stats(xs: readonly number[]): ChannelStats {
  const n = xs.length
  if (n === 0) return { n: 0, min: null, max: null, mean: null, std: null }
  let lo = xs[0]!
  let hi = xs[0]!
  for (const x of xs) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  const mean = pyMean(xs)
  const varr = pySum(xs.map((x) => (x - mean) ** 2)) / n
  return { n, min: lo, max: hi, mean, std: varr ** 0.5 }
}

/**
 * 一个通道的 `{samples_<u>, t_s, n, min_<u>, …}` 结果块。
 *
 * 存的是**完整样本**，不是摘要 —— 摘要在 `stats` 里，两者都要。
 */
export function channelBlock(
  samples: readonly number[],
  times: readonly number[],
  unit: string,
): Record<string, unknown> {
  const s = stats(samples)
  return {
    [`samples_${unit}`]: [...samples],
    t_s: [...times],
    n: s.n,
    [`min_${unit}`]: s.min,
    [`max_${unit}`]: s.max,
    [`mean_${unit}`]: s.mean,
    [`std_${unit}`]: s.std,
  }
}

/** 一次「开火 + 读回」采集的产物，时间轴以采集开始为 0。 */
export interface ReadbackCapture {
  readonly currentS: number[]
  readonly currentT: number[]
  readonly zS: number[]
  readonly zT: number[]
  /** 动作是否真的发出去了（pre-roll 期间被 abort 掉就没有）。 */
  fired: boolean
  /** 开火那次调用的 record，调用方要查它的 error。 */
  fireRecord: SkillCallRecord | null
  /** 开火时刻（采集时钟，秒）—— 判据用它切前后窗口。 */
  fireTS: number | null
  /** 开火那次调用自身阻塞了多久。见模块文档的诚实守卫。 */
  fireBlockedS: number
  captureS: number
  aborted: boolean
  /** 圈数预算耗尽（见 {@link pollLoop}）。**挂住 ≠ 通过**，所以它进回包。 */
  budgetExhausted: boolean
}

export function captureIsEmpty(cap: ReadbackCapture): boolean {
  return cap.currentS.length === 0 && cap.zS.length === 0
}

/** {@link pollLoop} 停下来的原因。 */
export type PollStop = 'done' | 'aborted' | 'break' | 'budget'

export interface PollLoopOptions {
  readonly totalS: number
  readonly pollHz: number
  /**
   * 采集时钟的原点（秒）。不给就由本函数自己读一次。
   *
   * 会给的只有一种情况：**调用方要用同一个原点给样本打时间戳**。各读各的
   * 会差一次时钟读取 —— 真机上是一个 RTT，假钟下是一整格，而那个偏移会一路
   * 渗进 `fireTS` 与前后窗的切分。
   */
  readonly t0S?: number | undefined
  /**
   * 每一圈**在调度闸之前**跑一次（开火检查住在这里）。返回 `'break'` 就收工。
   *
   * 它必须在调度闸之前，因为 pre-roll 结束的那一刻不一定正好是一个采样时刻 ——
   * 等到下一个采样时刻再开火，就把 pre-roll 拖长了一个周期。
   */
  readonly beforeSchedule?: ((elapsedS: number) => Promise<'break' | void>) | undefined
  /** 一个采样时刻到了。 */
  readonly poll: (elapsedS: number) => Promise<void>
}

/**
 * 绝对时刻调度的采样骨架。
 *
 * ## 圈数预算：**挂住 ≠ 通过**
 *
 * 这个循环的出口全都建立在「时钟会往前走」上。时钟不走（一个假钟的夹具忘了推、
 * 一次注入的 `now` 常量），它就是一个不发任何调用的死循环 —— 而**死循环与通过在
 * 退出码上长得一模一样**。
 *
 * 预算**从请求本身算出来**，不是一个拍脑袋的常数：时钟正常时，一圈要么是一次
 * 采样（每 `1/pollHz` 至多一次），要么是一次至多 1 ms 的睡眠（每毫秒至多一次）。
 * 所以 `totalS · (pollHz + 1000)` 是一个**宽松但有限**的上界，加 64 圈余量给
 * 边界与开火那一圈。超了就收工并把 `budgetExhausted` 如实报出去。
 */
export async function pollLoop(ctx: SkillContext, opts: PollLoopOptions): Promise<PollStop> {
  const periodS = 1.0 / Math.max(opts.pollHz, 1e-6)
  const nowS = (): number => ctx.now() / 1000
  const t0 = opts.t0S ?? nowS()
  let nextPoll = t0
  const budget = Math.ceil(opts.totalS * (opts.pollHz + 1000)) + 64

  for (let turn = 0; ; turn += 1) {
    if (turn >= budget) return 'budget'
    const now = nowS()
    const elapsed = now - t0
    if (elapsed >= opts.totalS) return 'done'
    if (ctx.signal.aborted) return 'aborted'

    if (opts.beforeSchedule !== undefined) {
      if ((await opts.beforeSchedule(elapsed)) === 'break') return 'break'
    }

    if (now < nextPoll) {
      await ctx.sleep(Math.min(nextPoll - now, 0.001) * 1000)
      continue
    }
    await opts.poll(elapsed)
    nextPoll += periodS
  }
}

export interface StreamOptions {
  /** 发起一次**异步**硬件动作，返回它的 record。 */
  readonly fire: () => Promise<SkillCallRecord>
  readonly totalCaptureS: number
  readonly preRollS: number
  readonly pollHz: number
  /** 所有 record 都收进这里（含开火那一次），调用方拿去记账。 */
  readonly calls: SkillCallRecord[]
}

/**
 * 采 `preRollS` 秒基线 → 调 `fire()` → 继续采到 `totalCaptureS`。
 *
 * 每帧采一次电流再采一次 Z（相隔一个 RTT，视作同时）。**两个通道各自带自己的
 * 时间戳**，因为它们各自独立：任一次读失败就只有另一条记了点。
 */
export async function streamWithAction(
  ctx: SkillContext,
  opts: StreamOptions,
): Promise<ReadbackCapture> {
  const cap: ReadbackCapture = {
    currentS: [],
    currentT: [],
    zS: [],
    zT: [],
    fired: false,
    fireRecord: null,
    fireTS: null,
    fireBlockedS: 0.0,
    captureS: 0.0,
    aborted: false,
    budgetExhausted: false,
  }
  const t0 = ctx.now() / 1000
  const elapsedNow = (): number => ctx.now() / 1000 - t0

  const stop = await pollLoop(ctx, {
    totalS: opts.totalCaptureS,
    pollHz: opts.pollHz,
    t0S: t0,
    beforeSchedule: async (elapsed): Promise<'break' | void> => {
      if (cap.fired || elapsed < opts.preRollS) return
      const tc = elapsedNow()
      const rec = await opts.fire()
      cap.fireBlockedS = elapsedNow() - tc
      opts.calls.push(rec)
      cap.fired = true
      cap.fireRecord = rec
      cap.fireTS = tc
      // 开火本身就失败了 —— 再采下去只是在录一条没有事件的曲线。
      if (rec.error !== undefined && rec.error !== '') return 'break'
      return
    },
    poll: async (): Promise<void> => {
      const recI = await ctx.safeCall('Current_Get')
      opts.calls.push(recI)
      if (recI.error === undefined || recI.error === '') {
        const vi = scalar(recI)
        if (vi !== null) {
          cap.currentS.push(vi)
          cap.currentT.push(elapsedNow())
        }
      }
      const recZ = await ctx.safeCall('ZCtrl_ZPosGet')
      opts.calls.push(recZ)
      if (recZ.error === undefined || recZ.error === '') {
        const vz = scalar(recZ)
        if (vz !== null) {
          cap.zS.push(vz)
          cap.zT.push(elapsedNow())
        }
      }
    },
  })
  cap.aborted = stop === 'aborted'
  cap.budgetExhausted = stop === 'budget'
  cap.captureS = Math.max(
    cap.currentT.length > 0 ? cap.currentT[cap.currentT.length - 1]! : 0.0,
    cap.zT.length > 0 ? cap.zT[cap.zT.length - 1]! : 0.0,
  )
  return cap
}

// ════════════════════════════════════════════════════════════════════════════
// 落盘 —— 让这条曲线**取得到**
// ════════════════════════════════════════════════════════════════════════════
//
// ## 它以前去哪了
//
// `channelBlock` 存的是完整样本，但它到不了任何人手上：工具边界只把 `summary`
// 送过去，而记录层会把长列表截断。一条**专门为了看清扎针过程而采集**的曲线，
// 采完之后没有任何人能看到。
//
// ## 为什么是 JSON，不是 `.npy` / `.npz`
//
// 本仓既有的做法是 `GrabScanFrameData`：落 `.npy`、回包只带路径。这里**复用那条
// 路**（落盘 + 回指针），但换了容器，理由是读的人不同：帧是二维图像、消费者是
// numpy 代码；这条曲线的第一消费者是**用户本人**，而真机上没有独立的 python。
// 而且两个通道的点数**可以不一样**，还要带阶段边界与整形参数 —— 这是一个带结构
// 的记录，不是一个矩形数组。

/**
 * 产物结构的版本号。**读的人先看这个字段再决定怎么解**；改了结构就必须改它。
 *
 * ⚠️ 前缀保留旧仓的 `mast.`：这个串写进的是**磁盘上的文件**，而那些文件要被
 * 旧仓的读取侧、以及用户手上已经存着的分析脚本认出来。为「本仓改名了」而换掉
 * 它，等于让同一种文件在两个仓里长得不一样 —— 那正是版本号要防的事。
 */
export const TRACE_SCHEMA = 'mast.readback_trace/1'

export interface TraceDeps {
  /**
   * 曲线落盘的目录。宿主接线时给；没给就落在工作目录下（同 `frames.ts`）。
   *
   * 旧仓在这里读一个 `MAST_TRACES_DIR` 环境变量，它的职责是**测试隔离的抓手**
   * （17 个测试文件都够得着这条落盘路径）。本仓的抓手就是这个注入点本身，
   * 所以那个环境变量**没有移植** —— 同一件事两个开关，只会多一个漂移的地方。
   */
  readonly tracesDir?: (() => string) | undefined
  /** 文件名中段（`<UTC 时刻>_<8 位随机>`）。注入是为了让名字在测试里可复现。 */
  readonly stamp?: (() => string) | undefined
}

/** `YYYYMMDDTHHMMSSZ`。**时间戳负责按发生顺序排、肉眼对得上实验记录**。 */
function utcStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

export interface SaveTraceArgs {
  readonly capture: ReadbackCapture
  readonly skill: string
  readonly meta: Readonly<Record<string, unknown>>
  readonly stages?: readonly unknown[] | undefined
  readonly deps?: TraceDeps | undefined
}

/**
 * 把一次采集的**两条原始曲线 + 元数据**写成一个 JSON 产物。
 *
 * 返回 `{trace_path}`，失败时返回 `{trace_error}` —— 两者都直接展开进 `data`，
 * 于是「曲线在哪」和「曲线为什么没落成」都在回包里说得出口。**不返回空对象**：
 * 落盘失败若无声无息，下一个人看到的又会是一条采完就消失的曲线，而这正是
 * 本函数存在的理由。
 *
 * 落盘失败**不会**让技能失败：硬件动作已经做完了，一次写盘错误不该把一次成功的
 * 扎针变成一次报错。
 */
export function saveTrace(args: SaveTraceArgs): Record<string, string> {
  const deps = args.deps ?? {}
  const stamp = deps.stamp ?? ((): string => `${utcStamp(new Date())}_${randomBytes(4).toString('hex')}`)
  try {
    const dir = (deps.tracesDir ?? ((): string => join(process.cwd(), 'experiments', 'traces')))()
    mkdirSync(dir, { recursive: true })
    let slug = ''
    for (const ch of args.skill || 'readback') slug += /[0-9A-Za-z]/.test(ch) ? ch : '_'
    const base = `${slug.slice(0, 40)}_${stamp()}`
    // 唯一性靠「取第一个没被占用的名字」，**不靠时钟** —— 同 `frames.ts` 的
    // `freeName`：单靠毫秒戳会撞，旧仓用两次真机事故买过这个教训。
    let out = join(dir, `${base}.json`)
    let n = 1
    while (existsSync(out)) {
      out = join(dir, `${base}_${String(n).padStart(2, '0')}.json`)
      n += 1
    }
    const c = args.capture
    const payload = {
      schema: TRACE_SCHEMA,
      skill: args.skill,
      created_utc: new Date().toISOString(),
      event_t_s: c.fireTS,
      capture_s: c.captureS,
      fired: c.fired,
      aborted: c.aborted,
      stages: [...(args.stages ?? [])],
      meta: { ...args.meta },
      channels: {
        // **两个通道各自带自己的时间戳**，因为它们各自独立。把它们当同一根时间轴
        // 对齐是错的，所以这里不对齐，如实各存各的。
        z: { unit: 'm', n: c.zS.length, t_s: [...c.zT], samples: [...c.zS] },
        current: { unit: 'A', n: c.currentS.length, t_s: [...c.currentT], samples: [...c.currentS] },
      },
    }
    writeFileSync(out, JSON.stringify(payload), { encoding: 'utf8' })
    return { trace_path: out }
  } catch (exc) {
    const e = exc instanceof Error ? exc : null
    return { trace_error: e === null ? String(exc) : `${e.name}: ${e.message}` }
  }
}

/**
 * 回包摘要末尾那一句**指针**（或那一句「没落成」）。
 *
 * 两个技能共用同一句措辞，而且**失败也出声** —— 只在成功时才附一句的写法，
 * 会让「曲线没了」和「本来就没采」在摘要里长得一模一样。
 */
export function traceRef(saved: Readonly<Record<string, string>>): string {
  const p = saved['trace_path']
  if (p !== undefined && p !== '') return ` | 原始曲线: ${p}`
  const err = saved['trace_error']
  return err !== undefined && err !== '' ? ` | ⚠️ 原始曲线未落盘: ${err}` : ''
}
