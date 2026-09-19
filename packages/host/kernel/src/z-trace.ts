/**
 * 事件前后「稳定值之差」—— z(t) 轨迹的跳变判定（**纯判据、零 I/O**）。
 *
 * 物理学家看一次电脉冲、或一次扎针尖时并不读整条曲线：看事件**之前**那段稳定的
 * z，和事件**之后**那段稳定的 z，两者差多少、往哪边。中间的瞬态峰（qPlus 音叉
 * 起跳那种）不参与判断 —— 它属于过程，不属于结果。
 *
 * **方向是信号自己的方向**（z 变大 / 变小），不是物理解释。同一个 `up` 在扎针尖
 * 时读作「针尖下面长了个 cluster」，在电脉冲时读作「针尖变短了几十 nm」，而 Z 增
 * 大到底是远离还是靠近样品取决于接线。把解释留给调用方是有意的：判据只有一份，
 * 语义各归各家 —— {@link indentVerdict} 就是「扎针那一家」的读法。
 *
 * 源：旧仓 `mast/io/z_trace.py`（本身是 2026-08-01 从 `tip_shaper_readback.py` 里
 * 提出来的，因为电脉冲要用同一套判据，而复制一份的下场是两边阈值各自漂移）。
 *
 * ## 移植时发现的两处旧仓文档瑕疵（**不改行为，只记账**）
 *
 * * `feedback_restored_t` 的返回标注写着 `-> "float | None"`，而它**返回的是一个
 *   二元组** `(t4, why)`。标注与实现分岔时，照标注写的人会去判 `if t4 is None` ——
 *   而那个名字绑的其实是元组，永远不是 `None`。
 * * 同一个函数的 docstring 把 `"no_current"` 列进了它的返回值，但那个值**只由
 *   `step_verdict` 产生**（「压根没给电流通道」）。这个函数自己给不出它。
 *
 * 两处都只是说明，行为逐位照搬。
 */
import { pyMean, pySum } from './si.js'

/**
 * 跳变检测的默认稳健倍数。**8 是实测出来的，不是口味问题**：纯高斯白噪声下，
 * k=5 时一段干净记录能报出约 6 次/秒的假跳变，k=7 恰好归零而注入的真阶跃仍然
 * 全中，8 留出余量。
 *
 * ⚠️ **误报率随样本数变化**，所以窗口长度或采样率变动一个数量级时必须重标。
 */
export const DEFAULT_JUMP_K = 8.0

/** 走 MAD-of-diffs 估噪声所需的最少样本。少于这个数中位数没有意义。 */
export const MIN_SAMPLES_FOR_MAD = 4

/**
 * 后窗兜底时至少要够到的样本数。
 *
 * **这个 2 不是新阈值** —— 它就是 {@link stepVerdict} 本来声明的下限
 * （那里的 `post.length < 2`）。取值依据与推翻它所需的观测写在那个函数的注释里。
 */
export const MIN_WINDOW_SAMPLES = 2

/**
 * 反馈重新接管之后，至少要有这么长的一段才敢下判断（秒）。
 *
 * 2026-08-20 真机的 168 条历史曲线：这一段在采集里的中位时长是 **0.012 s**，
 * 161/164 条比判读窗口本身还短。取 0.25 s 是因为电流从饱和回落到 setpoint
 * 实测要 0.1–0.2 s，之后还得留下够取中位数的样本。
 */
export const MIN_FEEDBACK_SEGMENT_S = 0.25

/**
 * 判「电流回到 setpoint 了」的倍数。基线电流就是 setpoint（反馈闭合时按定义
 * 如此），所以这是个相对判据，不需要谁把 setpoint 传进来。
 */
export const CURRENT_BACK_K = 3.0

/**
 * 判「针尖确实压进去了」的倍数。压 300 pm、kappa≈10/nm ⇒ 电流升约 e^6≈400 倍，
 * 所以 5 倍是个很松的门槛；它存在只是为了确认「有过一次压入」，从而不会在
 * 基线段上误取 t4。
 */
export const CURRENT_PRESSED_K = 5.0

/** 第四段（反馈恢复段）是**怎么定出来的**。 */
export type FeedbackSegmentSource =
  /** 由电流定位 —— 唯一可信的那一档 */
  | 'current'
  /** 电流从没升上去 ⇒ 可能根本没压到表面；尾窗照判 */
  | 'no_press'
  /** 电流升上去了、**再没回来** ⇒ 采集在反馈接管之前就结束了 ⇒ 判不了 */
  | 'no_return'
  /** 没给电流通道 ⇒ 退回尾窗，可能骑在三/四段边界上 */
  | 'no_current'
  /** 电流样本太少 */
  | 'too_few'
  /** 定位到了，但那一段短于 {@link MIN_FEEDBACK_SEGMENT_S} ⇒ 判不了 */
  | 'too_short'

export type StepDirection = 'up' | 'down' | 'none' | 'insufficient_data'

/** 判不了时的机器可判理由。**只有走电流那两支才有**。 */
export type StepReason = 'feedback_segment_too_short' | 'feedback_segment_not_captured'

/**
 * Python 的 `"%.<n>f" % v`。
 *
 * **不是 `toFixed`。** 两者只在**正好落在半分点**上分岔，而那种数并不罕见：
 * 3 位小数的半分点恰好是 1/16 的奇数倍（0.0625、0.1875、0.3125…），全是二进制
 * 精确表示的数。CPython 走 round-half-**even** ⇒ `"%.3f" % 0.0625` = `'0.062'`；
 * ECMA-262 的 `toFixed` 明写「有两个同样近的 n 时取**大**的那个」⇒ `'0.063'`。
 *
 * 这是 `pyFloatRepr` / `formatG` / `pyStr` / `pyMod` / `pySum` 那一族的第六个成员。
 * **它现在住在这里而不是 `si.ts`**：这一轮有四条并行支线在改文件，把它塞进
 * `si.ts` 会让四份改动撞在同一行上。收族的时候它该搬过去。
 *
 * ## 两个问题，各自的答案都**不能从算出来的那个数里读**
 *
 * 2026-09-19 收尾时对着 CPython 3.13 跑了 10 843 个 double × 7 档小数位
 * （75 901 格，含全部 `n/2^k` 半分点），这一份当时有 **70 格**与 CPython 不一致，
 * 分成三类 —— 而三类是**同一个毛病**：判据取自那个被舍入过的中间值。
 *
 * ### ① 符号取自**输入**（7 格）
 *
 * `toFixed` 判的是 `x < 0`，而 `-0 < 0` 是**假** ⇒ `pyFixed(-0, 1)` 给 `'0.0'`，
 * CPython 的 `"%.1f" % -0.0` 给 `'-0.0'`。这不只是 `-0` 自己：任何**舍入之后
 * 变成零、符号还在**的数都走这条路（`-1e-9`、`-0.0004`…），而那才是常见情形 ——
 * 批 6b 撞见的原话是报文里的「最接近的通道是 `dc`(-0.0)」。
 *
 * **与 `formatG` 是同一个坑**（`si.ts:57`，那边早就立过「`-0` 是一条线索，
 * 别把符号擦掉」的规矩），`pyFixed` 漏了。一个 `-0` 出现在读数里多半意味着
 * 上游做了一次乘负或取反；把符号擦掉，就把那条线索也擦掉了。
 *
 * ### ② 半分点的判据**是精确的**（63 格）
 *
 * 上一版判的是「`v · 10^(digits+1)` 是整数且末位是 ±5」，并断言「不精确的数
 * 落不到半分点上」。**那句断言是假的** —— 它正是 `pyRound`（`spectroscopy.ts`）
 * 抬头第一条警告写明的写法：**那个乘法自己要舍入**。`2.675` 的精确值是
 * 2.67499999999999982…，`2.675 * 1000` 却**恰好**得到 `2675`，于是一个不是
 * 半分点的数被判成半分点，取偶按到 `'2.68'`，而 CPython 给 `'2.67'`。
 *
 * 真判据不用看小数：`a` 正好落在第 `digits` 位的半分点上
 * ⟺ `a = q / 2^(digits+1)`、`q` 为**奇整数**
 * （因为 `a = (2j+1)/(2·10^d) = (2j+1)/(2^(d+1)·5^d)`，而 `a` 是二进制小数
 * ⇒ `5^d | (2j+1)`）。`a · 2^(digits+1)` 只是一次**指数平移**，在二进制浮点里
 * 不会舍入 —— 判据因此没有「像不像」的余地。
 *
 * ### ③ 两者叠在一起
 *
 * `"%.0f" % -0.5`：半分点分支算出 `0`，正负号在这一步一起没了 ⇒ `'0'`，
 * CPython 给 `'-0'`。
 *
 * 改完之后 75 901 格**零分岔**。探针在 `z-trace.test.ts`，deviation 见
 * `spec/deviations.md` 的「语言分歧一族」。
 */
export function pyFixed(v: number, digits: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf'
  // ① 符号来自**输入**，不来自算出来的那个数。
  const sign = v < 0 || Object.is(v, -0) ? '-' : ''
  const a = Math.abs(v)
  // ② 半分点：`a · 2^(digits+1)` 是**奇整数**。这个乘法是纯指数平移，不舍入。
  const halves = a * 2 ** (digits + 1)
  if (Number.isInteger(halves) && halves % 2 === 1) {
    const p = 10 ** digits
    const fl = Math.floor(a * p)
    return sign + ((fl % 2 === 0 ? fl : fl + 1) / p).toFixed(digits)
  }
  return sign + a.toFixed(digits)
}

/** 一维轨迹上的一次跳变。 */
export interface JumpEvent {
  readonly tS: number
  readonly delta: number
}

export interface JumpReport {
  readonly events: readonly JumpEvent[]
  readonly maxAbsDelta: number
  readonly count: number
}

/**
 * 事件前后稳定值之差的判定结果。
 *
 * ⚠️ **可选字段的「缺席」是有意义的**：旧仓每一条早退分支带的键**不一样**，
 * 而回包里「这个键不在」与「这个键是 null」是两句话（`feedback_segment_s` 两种
 * 都会出现）。所以这里用 `undefined` 表示「这一支不报这个量」、用 `null` 表示
 * 「报了，但它是 None」—— 与 D-SKILL-1 的「读不到就是 null」同一条纪律。
 */
export interface StepVerdict {
  readonly direction: StepDirection
  /** 只有 `too_short` / `no_return` 那两支有。 */
  readonly reason?: StepReason | undefined
  /** 同上。扎针那一层会在别的分支上补自己的那句（见 {@link indentVerdict}）。 */
  readonly advice?: string | undefined
  readonly deltaM?: number | undefined
  readonly z1M?: number | undefined
  readonly z3M?: number | undefined
  readonly zMinM?: number | undefined
  readonly zMaxM?: number | undefined
  readonly baselineSigmaM?: number | undefined
  readonly tolM?: number | undefined
  readonly nPre: number
  readonly nPost: number
  readonly postWindowStarved: boolean
  readonly postWindowS: number
  readonly maxGapS: number
  readonly feedbackSegmentSource?: FeedbackSegmentSource | undefined
  readonly feedbackSegmentS?: number | null | undefined
  readonly feedbackRestoredT?: number | null | undefined
}

/** {@link feedbackRestoredT} 的结果。`t === null` 时 `why` 说明是哪一种定位不了。 */
export interface FeedbackRestored {
  readonly t: number | null
  readonly why: FeedbackSegmentSource
}

/**
 * 反馈重新接管的时刻 —— **用电流定位，不用声明的分段边界**。
 *
 * ## 为什么不能信声明的边界
 *
 * 阶段边界是从**参数**算出来的（switch_off + lift_1 + settling + lift_2 +
 * end_wait）。2026-08-20 拿 167 条真机曲线对过账：硬件比声明**晚** 0.22 s
 * （扎入开始）到 0.33 s（抬回结束），10–90 分位 [0.12, 0.46]。
 * 照声明去切段，会把第三段当成第四段。
 *
 * ## 四段结构（电流通道把每一段都钉死了）
 *
 * | 段 | Z          | 电流              | 是什么                           |
 * | -- | ---------- | ----------------- | -------------------------------- |
 * | 1  | 基线       | **= setpoint**    | 反馈 ON                          |
 * | 2  | 压下 −d    | 饱和（实测 ×50）  | 反馈 OFF，压入                   |
 * | 3  | **回基线** | **仍饱和**        | Z 被斜坡抬回原位，反馈**还没开** |
 * | 4  | 新平衡     | **回到 setpoint** | 反馈恢复，控制器找到新高度       |
 *
 * 第三段按构造等于基线 —— 它是固件把 Z 放回命令位置，**与扎针的结果无关**。
 * 只有第四段说得出针尖/表面变没变。真机一发实测：第三段 Δz = +1 pm，
 * 第四段 Δz = +269 pm，而电流在第三段里是 10004 pA、在第四段里回到 197 pA。
 *
 * `why` 的三种「定位不了」**指向完全不同的下一步，不能合成一个词**：
 *
 * * `no_press` —— 电流从没升上去 ⇒ 这一发可能根本没压到表面。尾窗和别的窗一样好，
 *   判定照旧（可能就是「没扎上」，而那是**实话**）。
 * * `no_return` —— 电流升上去了、**再没回来** ⇒ 采集在反馈接管**之前**就结束了。
 *   整条曲线只有第一到第三段，而第三段按构造等于基线。这时任何 Δz 都不是答案
 *   ⇒ **判不了**。2026-08-20：168 条历史曲线里 160 条是这一种。
 * * `too_few` —— 样本太少、基线段一个点都没有、或基线电流不是正数。
 */
export function feedbackRestoredT(
  currentS: readonly number[],
  currentT: readonly number[],
  eventStartT: number,
): FeedbackRestored {
  const n = Math.min(currentS.length, currentT.length)
  if (n < 4) return { t: null, why: 'too_few' }
  const base: number[] = []
  for (let k = 0; k < n; k += 1) if (currentT[k]! < eventStartT) base.push(Math.abs(currentS[k]!))
  if (base.length < 2) return { t: null, why: 'too_few' }
  const i0 = median(base)
  if (!(i0 > 0)) return { t: null, why: 'too_few' }
  // 先确认「压进去过」—— 否则基线段本身就满足「电流等于 setpoint」，t4 会落在扎针之前。
  let pressed = -1
  for (let k = 0; k < n; k += 1) {
    if (currentT[k]! >= eventStartT && Math.abs(currentS[k]!) > CURRENT_PRESSED_K * i0) {
      pressed = k
      break
    }
  }
  if (pressed < 0) return { t: null, why: 'no_press' }
  // 压入之后，电流第一次回到 setpoint 附近
  for (let k = pressed; k < n; k += 1) {
    if (Math.abs(currentS[k]!) <= CURRENT_BACK_K * i0) return { t: currentT[k]!, why: 'current' }
  }
  return { t: null, why: 'no_return' }
}

/**
 * 全程最长的相邻样本间隔。
 *
 * **每一条返回路径都要带上它**，判不出来的那几条尤其要 —— 那正是最想知道
 * 「是不是有一次超长往返」的时刻。
 */
export function maxGap(times: readonly number[]): number {
  let out = 0.0
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i]! - times[i - 1]!
    if (d > out) out = d
  }
  return out
}

/** 中位数。空表给 `0.0`（同旧仓）。 */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return 0.0
  return n % 2 ? s[n >> 1]! : 0.5 * (s[(n >> 1) - 1]! + s[n >> 1]!)
}

/** 总体标准差（除以 n，不是 n−1）。少于两个样本给 `0.0`。 */
export function std(xs: readonly number[]): number {
  const n = xs.length
  if (n < 2) return 0.0
  const m = pyMean(xs)
  return (pySum(xs.map((x) => (x - m) ** 2)) / n) ** 0.5
}

/**
 * 相邻差分的 MAD 换算成 σ。
 *
 * 差分先把慢漂移消掉：一段基线若在缓慢爬升，直接取标准差会把漂移当噪声，容差
 * 随之撑大，真跳变反而被吞掉。`/√2` 是因为做差把方差翻了一倍。
 */
export function madDiffSigma(xs: readonly number[]): number {
  const n = xs.length
  if (n < 2) return 0.0
  const diffs: number[] = []
  for (let i = 0; i < n - 1; i += 1) diffs.push(xs[i + 1]! - xs[i]!)
  const med = median(diffs)
  const mad = median(diffs.map((d) => Math.abs(d - med)))
  return (mad * 1.4826) / 2.0 ** 0.5
}

/**
 * 基线噪声底：优先 MAD-of-diffs，退化时回落到标准差。
 *
 * **退化保护不是装饰。** MAD 是中位数，一段只有两三个样本、或样本量化到同一台阶的
 * 基线会让它精确地等于 0，容差随之塌成 0 —— 之后任何一点点差异都会被判成「变了」。
 * 真机上 0.1 s @ 2 kHz 的基线有两百个点，走的一直是 MAD 那条路。
 */
export function baselineSigma(xs: readonly number[]): number {
  const n = xs.length
  if (n < 2) return 0.0
  if (n >= MIN_SAMPLES_FOR_MAD) {
    const s = madDiffSigma(xs)
    if (s > 0) return s
  }
  return std(xs)
}

/**
 * 一维轨迹上的稳健跳变检测。
 *
 * 标记幅度超过 `median(|Δ|) + k·σ_robust`（σ_robust = 1.4826·MAD）的一阶差分
 * —— 抓突变，同时忽略 shaper 强加在 Z 上的平滑斜坡。
 *
 * ⚠️ 这里的两个「中位数」**不是** {@link median}：旧仓取的是排序后的
 * `absd[len//2]`，偶数长度时**不取两个中间值的平均**。照搬，因为这两个数直接
 * 进阈值，差一点就是差一条事件。
 */
export function detectJumps(
  samples: readonly number[],
  times: readonly number[],
  k: number = DEFAULT_JUMP_K,
): JumpReport {
  if (samples.length < 3) return { events: [], maxAbsDelta: 0.0, count: 0 }
  const diffs: number[] = []
  for (let i = 0; i < samples.length - 1; i += 1) diffs.push(samples[i + 1]! - samples[i]!)
  const absd = diffs.map((x) => Math.abs(x)).sort((a, b) => a - b)
  const mid = absd.length >> 1
  const med = absd[mid]!
  const mad = absd.map((a) => Math.abs(a - med)).sort((a, b) => a - b)[mid]!
  const sigma = 1.4826 * mad
  const thr = med + k * (sigma > 0 ? sigma : med > 0 ? med : 1e-30)
  const events: JumpEvent[] = []
  let maxAbs = 0.0
  for (let i = 0; i < diffs.length; i += 1) {
    const dv = diffs[i]!
    const a = Math.abs(dv)
    if (a > maxAbs) maxAbs = a
    if (a > thr) events.push({ tS: times[i + 1]!, delta: dv })
  }
  return { events, maxAbsDelta: maxAbs, count: events.length }
}

export interface StepVerdictOptions {
  readonly postRollS: number
  readonly tolK?: number | undefined
  readonly tolAbsM?: number | undefined
  readonly currentS?: readonly number[] | undefined
  readonly currentT?: readonly number[] | undefined
}

/**
 * 事件前后稳定值之差 —— 跳没跳、往哪边、跳了多少。
 *
 * 三个量：`z1` = 事件前基线，`zMin` = 全程最低点（**只作记录，不参与判定** ——
 * 那是过程里的瞬态），`z3` = 采集尾部安定下来的值。`delta = z3 − z1`。
 *
 * * `|delta| <= tol` → `none` 没变
 * * `delta >  tol`   → `up`   信号朝正方向跳
 * * `delta < -tol`   → `down` 信号朝负方向跳
 *
 * `tol = max(tolAbsM, tolK · baselineSigma(z1 窗口))`。
 *
 * 两个窗口都只取**后半段**：扎入的下降沿、回撤的斜坡都发生在窗口前半，让它们
 * 渗进 z1/z3 会把稳定值算歪。qPlus 音叉那种零均值振荡在这里自然被抵消（取的
 * 是中位数），而振荡撑大的 σ 又让容差自动变保守 —— 无需为它写特例。
 *
 * ## 后窗按**点数**兜底，不只按时间（2026-08-05）
 *
 * `postRollS` 想表达的是「事件之后有足够多的**稳定态样本**」，而它用**时间**
 * 来表达这件事 —— 两者**只在采样均匀时等价**。采集循环是墙钟驱动、在调用返回
 * 之后才打时间戳的，所以一次异常长的 TCP 往返就会造出一个时间戳远在窗口之外的
 * 样本。`cap = times[-1]` 于是被这一个离群值挟持，后窗往后平移，把**全部**真实
 * 样本挡在外面。
 *
 * 实测（2026-08-05）：一次 122 ms 卡顿把一次健康的 440 点采集（`nPost=161` → `up`）
 * 变成 `n=315 nPre=160 nPost=1 cap=0.3414` → `insufficient_data`。**而
 * `insufficient_data` 在真机上的意思是「打了一发脉冲，而我说不出针尖发生了什么」**
 * —— 即使已有 315 个稳定样本也会错误拒绝，造成可用数据损失。
 *
 * 所以：先按时间取窗；**若不足 {@link MIN_WINDOW_SAMPLES} 个，就往回够到这个数为止**，
 * 并把这件事如实标出来（`postWindowStarved`）。
 *
 * `MIN_WINDOW_SAMPLES = 2` 的依据（**不是随手挑的**）：
 *
 * * 它就是这个函数**本来就声明的下限**（下面那句 `post.length < 2`），不是新引入的；
 * * 统计上：容差是 `tolK·σ`（默认 4σ），而后窗只取后半段 —— 2 点的后半段是
 *   **1 点**，估计误差 1.0σ，仍比判据门限小 4 倍；
 * * **而且 2 是使偏倚最小的选择**：往回够会伸向尚未稳定的瞬态，而「越靠后越稳」
 *   正是上一段那条设计前提。取后半段意味着实际用的是**最后一个点**，即最稳的
 *   那个；K 越大反而够回越靠近瞬态的地方（K=20 → 中位数取自 10 点，伸得更远）。
 *
 * **要推翻这个取值，需要观测到**：①一次「扩窗判定」与用户所见不符；或 ②采集结束时
 * Z 仍在动（最后那个点本身没稳下来），导致方向判反。**这两种至今都没有被观测到过。**
 *
 * ⚠️ **扩窗是对判据的修复，不是对卡顿的修复。** 那次异常长的往返仍然是一个该被
 * 上报的事实，所以 `maxGapS` **每次都算**，判定正常时也算 —— 只在退化时才算的量，
 * 又会是一个「只在不需要它的地方管用的守卫」。
 */
export function stepVerdict(
  samples: readonly number[],
  times: readonly number[],
  eventStartT: number | null,
  opts: StepVerdictOptions,
): StepVerdict {
  const postRollS = opts.postRollS
  const tolK = opts.tolK ?? 4.0
  const tolAbsM = opts.tolAbsM ?? 0.0
  // `times` 为空在旧仓是一次 IndexError（`times[-1]`）。调用方永远成对地喂这两条
  // 表，所以这里把它折进同一道「数据不够」的早退，而不是复制一次崩溃。
  if (eventStartT === null || samples.length < 4 || times.length === 0) {
    return {
      direction: 'insufficient_data',
      nPre: 0,
      nPost: 0,
      postWindowStarved: false,
      postWindowS: 0.0,
      maxGapS: maxGap(times),
    }
  }
  const pre: number[] = []
  const nz = Math.min(samples.length, times.length)
  for (let i = 0; i < nz; i += 1) if (times[i]! < eventStartT) pre.push(samples[i]!)
  const cap = times[times.length - 1]!

  // ── 后窗要落在**第四段**里 —— 有电流就用电流定位，没有才退回尾窗 ──────────
  //
  // 尾窗（最后 postRollS）在真机上几乎必然骑在第三/四段边界上：2026-08-20 的
  // 168 条历史曲线里，第四段的中位时长只有 **0.012 s**，而窗口是 0.1–0.2 s。
  // 于是 z3 取到的绝大部分是第三段 —— 那一段**按构造等于基线**（Z 被抬回原位、
  // 反馈还没开），Δz 因此恒为 0，判定输出「没扎上」。真簇被这样判掉了 62%。
  let t4: number | null = null
  let seg4Source: FeedbackSegmentSource = 'no_current'
  if (opts.currentS !== undefined && opts.currentT !== undefined) {
    const r = feedbackRestoredT(opts.currentS, opts.currentT, eventStartT)
    t4 = r.t
    seg4Source = r.why
  }
  const seg4S = t4 === null ? null : cap - t4
  const seg4Short = seg4S !== null && seg4S < MIN_FEEDBACK_SEGMENT_S
  if (seg4Short) seg4Source = 'too_short'
  let postIdx: number[] = []
  if (t4 !== null && !seg4Short) {
    for (let i = 0; i < times.length; i += 1) if (times[i]! >= t4) postIdx.push(i)
  } else {
    const win = cap > 0 ? Math.min(postRollS, cap * 0.4) : postRollS
    for (let i = 0; i < times.length; i += 1) if (times[i]! >= cap - win) postIdx.push(i)
  }
  // 后窗被一次超长往返饿死了 —— 往回够到下限为止。这是关于**这次采集**的事实，
  // 不是「判据自己搞定了」：标志与 maxGapS 一起把它如实报出去。
  const postStarved = postIdx.length < MIN_WINDOW_SAMPLES && samples.length >= MIN_WINDOW_SAMPLES
  if (postStarved) {
    postIdx = []
    for (let i = samples.length - MIN_WINDOW_SAMPLES; i < samples.length; i += 1) postIdx.push(i)
  }
  const post = postIdx.map((i) => samples[i]!)
  // ⚠️ pre 侧**刻意不做同样的兜底**。pre 由 `t < eventStartT` 选出 —— 它不靠尾锚，
  // 没有被离群值挟持的失败模式。前窗点数少，就是基线**真的**不够，那时
  // insufficient_data 是实话。
  if (pre.length < 2 || post.length < 2) {
    // ⚠️ 判不出来的时候，**恰恰最需要**「采了几个点、最长往返多久」。这两条早退
    // 以前只回一个 direction，把诊断全丢了 —— 于是那些字段在不需要它们时幸存、
    // 在需要它们时消失。
    return {
      direction: 'insufficient_data',
      nPre: pre.length,
      nPost: post.length,
      postWindowStarved: postStarved,
      postWindowS: postIdx.length > 0 ? cap - times[postIdx[0]!]! : 0.0,
      maxGapS: maxGap(times),
    }
  }
  if (seg4Source === 'too_short' || seg4Source === 'no_return') {
    // ── 「采集在反馈接管之前/之中就结束了」的答案是**判不了**，不是「没扎上」──
    //
    // 这两句话指向完全不同的下一步：一个是「把 post_roll_s 加长再扎」，一个是
    // 「加大扎入深度」。历史上这里输出的是后者，于是用户被送去一次次加深，
    // 而缺的其实是一秒钟的采集时间。
    //
    // `no_return` 尤其要命：电流升上去了、**再没回到 setpoint**，说明整条曲线
    // 只有第一到第三段。2026-08-20 的 168 条历史曲线里 160 条是这一种 —— 那一整批
    // 数据**没有一条**记录过判定真正需要的那一段，而它们当时全都给出了确定的判定。
    const why =
      seg4Source === 'too_short'
        ? `反馈恢复之后只录到 ${pyFixed(seg4S ?? 0.0, 3)} s（下限 ${pyFixed(MIN_FEEDBACK_SEGMENT_S, 2)} s）`
        : '电流压上去之后**再没回到 setpoint** —— 采集在反馈接管之前就结束了'
    return {
      direction: 'insufficient_data',
      reason:
        seg4Source === 'too_short' ? 'feedback_segment_too_short' : 'feedback_segment_not_captured',
      nPre: pre.length,
      nPost: post.length,
      postWindowStarved: postStarved,
      postWindowS: seg4S ?? 0.0,
      feedbackSegmentS: seg4S,
      feedbackSegmentSource: seg4Source,
      feedbackRestoredT: t4,
      advice: `${why} —— 判不了。**不要据此加大扎入深度**，先把 post_roll_s 调到 1.5 s 左右再扎一次。`,
      maxGapS: maxGap(times),
    }
  }
  const preS = pre.slice(pre.length >> 1)
  const postS = post.slice(post.length >> 1)
  const z1 = median(preS)
  const z3 = median(postS)
  const sigma1 = baselineSigma(preS)
  const tol = Math.max(tolAbsM, tolK * sigma1)
  const delta = z3 - z1
  const direction: StepDirection = Math.abs(delta) <= tol ? 'none' : delta > 0 ? 'up' : 'down'
  return {
    direction,
    deltaM: delta,
    z1M: z1,
    z3M: z3,
    zMinM: minOf(samples),
    zMaxM: maxOf(samples),
    baselineSigmaM: sigma1,
    tolM: tol,
    nPre: pre.length,
    nPost: post.length,
    // ── 这次采集本身的事实（与判定分开读）────────────────────────────────
    // postWindowStarved：预期的 postRollS 窗口里样本不够下限 —— 即**这次采集期间
    //   有一次异常长的往返**，长到把整个后窗清空了。它说的是采集，不是补救；
    //   补救体现在 postWindowS 上。
    // maxGapS：全程最长的相邻样本间隔。**每次都算**，判定正常时也算。
    postWindowStarved: postStarved,
    postWindowS: postIdx.length > 0 ? cap - times[postIdx[0]!]! : 0.0,
    maxGapS: maxGap(times),
    feedbackSegmentSource: seg4Source,
    feedbackSegmentS: seg4S,
    feedbackRestoredT: t4,
  }
}

/** 恒流（反馈开）下扎针尖时，{@link StepDirection} 读作什么。 */
export type IndentVerdictKind = 'cluster' | 'tip_changed_or_pit' | 'no_change' | 'insufficient_data'

/**
 * 恒流扎针的读法。
 *
 * Z 变大 = 针尖退开 = 表面等效变高，所以向上是「表面上长了东西」。
 * 电脉冲那一路读法不同 —— 这正是判据保持中性、语义各归各家的原因。
 */
export const INDENT_VERDICT: Readonly<Record<StepDirection, IndentVerdictKind>> = {
  up: 'cluster',
  down: 'tip_changed_or_pit',
  none: 'no_change',
  insufficient_data: 'insufficient_data',
}

/** 每种判定的下一步。逐字照搬（含旧仓的半角逗号）—— 它是模型读的东西。 */
export const INDENT_ADVICE: Readonly<Record<IndentVerdictKind, string>> = {
  no_change: '没扎上 — 增大向下扎的深度(更负的 tip_lift_m)后重试。',
  cluster: '扎上了,表面已形成一个 cluster。',
  tip_changed_or_pit: '针尖状态改变(或扎出一个坑)。',
  // 旧仓的 `_INDENT_ADVICE` **没有**这一项：判不了那一支走的是
  // `setdefault("advice", _INDENT_ADVICE["no_change"])` —— 见 indentVerdict。
  insufficient_data: '',
}

/** {@link indentVerdict} 的结果：本层的判定 + 一句下一步 + 全部诊断。 */
export interface IndentVerdict {
  readonly verdict: IndentVerdictKind
  readonly advice: string
  /** 判据本体。序列化时 `direction` 与 `zMaxM` **由本层剥掉**（换成本层的词汇）。 */
  readonly step: StepVerdict
}

/**
 * 扎针那一层的薄封装 —— 判据本体在 {@link stepVerdict}。
 *
 * ⚠️ **电流通道不是可选的**（签名允许缺省）。没有它，后窗只能退回「采集最后
 * postRollS」，而那一段在真机上几乎必然骑在第三/四段边界上：第三段是「Z 被斜坡
 * 抬回原位、反馈还没开」，按构造等于基线 ⇒ Δz 恒为 0 ⇒「没扎上」。
 *
 * ⚠️ 判不出来时**保留全部诊断**。旧仓这里以前是 `return {"verdict": "insufficient_data"}`
 * —— 把整个 dict 丢掉。于是诊断字段（`n_pre` / `n_post` / `max_gap_s` …）**恰好在
 * 不需要它们的时候幸存、在需要它们的时候消失**：判不出来正是最想知道「采了几个点、
 * 最长往返多久」的时刻。
 *
 * `feedback_segment_too_short` / `not_captured` 自带一句**具体的**下一步（加长
 * post_roll_s，别加深）。默认那句「增大扎入深度」在这种情形下正好是错的方向，
 * 所以**只在它没自带时才补**（旧仓的 `setdefault`）。
 */
export function indentVerdict(
  zS: readonly number[],
  zT: readonly number[],
  eventStartT: number | null,
  opts: StepVerdictOptions,
): IndentVerdict {
  const step = stepVerdict(zS, zT, eventStartT, opts)
  const verdict = INDENT_VERDICT[step.direction]
  const advice =
    verdict === 'insufficient_data'
      ? step.advice ?? INDENT_ADVICE.no_change
      : INDENT_ADVICE[verdict]
  return { verdict, advice, step }
}

// ════════════════════════════════════════════════════════════════════════════
// 回包形状 —— **哪些键在，本身就是判据**
// ════════════════════════════════════════════════════════════════════════════
//
// 这三个序列化函数住在内核而不是技能里，因为键的**有无**是判据的一部分：旧仓
// 每一条早退分支带的键不一样（数据不够那两条只带诊断，电流那两条另带
// `feedback_*` 与一句 `advice`，判得出来的那条才有 `delta_m` / `tol_m`），
// 而「这个键不在」与「这个键是 null」是两句话。
//
// 写在这里还有第二个理由：**金样回放与技能回包比的必须是同一份映射**。
// 两份拷贝时，其中一份改了，另一份的测试仍然绿。

/** {@link detectJumps} 的回包形状。 */
export function jumpReportFields(j: JumpReport): Record<string, unknown> {
  return {
    events: j.events.map((e) => ({ t_s: e.tS, delta: e.delta })),
    max_abs_delta: j.maxAbsDelta,
    count: j.count,
  }
}

/** {@link stepVerdict} 的回包形状。`undefined` 的字段**不出现**。 */
export function stepVerdictFields(v: StepVerdict): Record<string, unknown> {
  const out: Record<string, unknown> = { direction: v.direction }
  if (v.reason !== undefined) out['reason'] = v.reason
  if (v.deltaM !== undefined) out['delta_m'] = v.deltaM
  if (v.z1M !== undefined) out['z1_m'] = v.z1M
  if (v.z3M !== undefined) out['z3_m'] = v.z3M
  if (v.zMinM !== undefined) out['z_min_m'] = v.zMinM
  if (v.zMaxM !== undefined) out['z_max_m'] = v.zMaxM
  if (v.baselineSigmaM !== undefined) out['baseline_sigma_m'] = v.baselineSigmaM
  if (v.tolM !== undefined) out['tol_m'] = v.tolM
  out['n_pre'] = v.nPre
  out['n_post'] = v.nPost
  out['post_window_starved'] = v.postWindowStarved
  out['post_window_s'] = v.postWindowS
  if (v.feedbackSegmentS !== undefined) out['feedback_segment_s'] = v.feedbackSegmentS
  if (v.feedbackSegmentSource !== undefined) {
    out['feedback_segment_source'] = v.feedbackSegmentSource
  }
  if (v.feedbackRestoredT !== undefined) out['feedback_restored_t'] = v.feedbackRestoredT
  if (v.advice !== undefined) out['advice'] = v.advice
  out['max_gap_s'] = v.maxGapS
  return out
}

/**
 * {@link indentVerdict} 的回包形状：**剥掉 `direction` 与 `z_max_m`**。
 *
 * 剥掉是有意的（方向的物理解释归这一层），而**诊断一个都不剥**。
 */
export function indentVerdictFields(iv: IndentVerdict): Record<string, unknown> {
  const out = stepVerdictFields(iv.step)
  delete out['direction']
  delete out['z_max_m']
  out['verdict'] = iv.verdict
  out['advice'] = iv.advice
  return out
}

function minOf(xs: readonly number[]): number {
  let out = xs[0]!
  for (const x of xs) if (x < out) out = x
  return out
}

function maxOf(xs: readonly number[]): number {
  let out = xs[0]!
  for (const x of xs) if (x > out) out = x
  return out
}
