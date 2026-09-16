/**
 * 谱学的三件判定：**谱数据块的行列**、**解不开时的理由**、**一条谱要跑多久**。
 *
 * 动作留在技能层（`l0/spectroscopy.ts`），判据在这里。这个分工在这一族上尤其
 * 要紧：下面每一条都在真机上错过一次，而三次的**症状都不是报错**。
 *
 * ## ① 行 = 通道，列 = 扫描点
 *
 * `BiasSpectr_Start` / `ZSpectr_Start` 回来的 2D Data 是 **行=通道、列=扫描点**：
 * 第 *i* 行是第 *i* 个通道在整条扫掠上的全部读数。官方 TCP 协议（LockInFreqSwp
 * 一族）与参考客户端 `nanonisTCP` 都是这么读的（`data[names[i]] = row_i`）。
 *
 * 老代码按 **行=点、列=通道**读（`arr[:, j]`）—— 也就是**转置**。真机上那返回的是
 * 一串混在一起的谱（2026-07-03 复盘），而**一张转置的谱在数值上仍然是一串合法的
 * 浮点**：每个数都是真的、量纲也对，只是不属于它被贴上的那个通道。所以这里的测试
 * 用**逐格互不相同**的数据把行列钉死 —— 用一格全是 0.25 的数据，转置与不转置
 * 给出的答案一模一样。
 *
 * ## ② `reason` 是这个解析器最重要的返回值
 *
 * 原来五个 bail-out 全都回 `({}, 0)`，于是「块解不开」与「这条谱真的只有 0 个点」
 * 在调用方眼里**一模一样**，而唯一的症状是 `data` 里**少了 `num_points` 这个键**。
 * **一个缺席的键分不出「没测出来」和「没解出来」。**（2026-08-15 普查 A3）
 *
 * 这是本仓「读不到 ≠ 零 ≠ 否」的又一次，而这一次比前几次更难发现：解错的时候
 * 至少有一串数看起来不对，解不出而不说的时候**没有任何一个数看起来是错的**。
 *
 * ## ③ 扫掠时长从**仪器自己的设定**算，不写死
 *
 * 用户随时会改点数 / 积分时间 / sweep 数，写死的预算下一次就又不够；而预算不够的
 * 代价不是「等久一点」，是**整条连接报废**（见 `skill-kernel.ts` 里 recv 预算那一段）。
 * 读不到设定时退到**上限**那一侧：「读不到」不是「很快」——退回一个小数字正是那个
 * bug 的形状。
 */

/** 抬 recv 超时时给算出来的扫掠时长留的余量（系数）。 */
export const SWEEP_BUDGET_FACTOR = 1.35
/** 同上，常数项（秒）—— 覆盖存 `.dat` 这类没建模的开销。 */
export const SWEEP_BUDGET_PAD_S = 45.0
/**
 * 读不到扫掠设定时的回退（秒）。
 *
 * **退到上限那一侧**：抬高超时的代价只是「真出故障时多等一会」，抬得不够的代价是
 * 一条 422 s 后到达的回包落在没人读的 socket 上，此后这条连接上每一个调用都废。
 */
export const SWEEP_BUDGET_FALLBACK_S = 600.0

/** 一条谱：通道名 → 这条扫掠上的一串读数。 */
export interface Spectrum {
  /** 通道名 → 整行读数。解不开时是空表。 */
  readonly channels: Readonly<Record<string, number[]>>
  /** 扫描点数 = **列数**。解不开时是 0。 */
  readonly numPoints: number
  /** 解不开的**原因**；解开了是 `''`。见抬头 ②。 */
  readonly reason: string
}

/**
 * 取不出数就给 `null`（D-SKILL-1 同一条：绝不拿一个不是测量值的东西当读数）。
 *
 * `inf` / `nan` **收下** —— `np.array(dtype=float64)` 也收，而一整帧 NaN 恰恰是
 * 最该被看见的那种数据（同 `crash-check.ts` 里 `np.ptp` 那一条）。
 */
function toFloat(v: unknown): number | null {
  if (typeof v === 'boolean') return null
  if (typeof v === 'bigint') return Number(v)
  if (typeof v !== 'number') return null
  return v
}

/** 把任意嵌套的数值块摊平；碰到解不出的元素整块作废（对应 `np.array` 抛）。 */
function flatten(v: unknown, out: number[]): boolean {
  if (Array.isArray(v)) {
    for (const x of v) if (!flatten(x, out)) return false
    return true
  }
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const a = v as unknown as ArrayLike<number>
    for (let k = 0; k < a.length; k += 1) out.push(Number(a[k]))
    return true
  }
  const n = toFloat(v)
  if (n === null) return false
  out.push(n)
  return true
}

/**
 * 这是不是「一块数据」。
 *
 * 对应旧仓那句 `hasattr(data_2d, 'tolist')` 之后的 `isinstance(data_2d, list)`：
 * ndarray 先被摊成 list，**然后**才判类型。本仓这一侧线协议可能给嵌套表、也可能
 * 给一条 typed array —— 两种都是同一块数据，把后者判成「不是列表」等于给出一句
 * **说错了的**诊断。
 *
 * ⚠️ 单独一个有声明返回类型的谓词：这一行上挂着变异，而内联写的话
 * `Array.isArray` 的类型收窄会让拆掉它变成一个编译错。
 */
function isBlock(v: unknown): boolean {
  return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))
}

/** 一个回包元素当整数用；不是整数就给 `null`。 */
function toInt(v: unknown): number | null {
  const n = toFloat(v)
  if (n === null || !Number.isFinite(n)) return null
  return Math.trunc(n)
}

/** Python 的 `type(x).__name__`，只为那句诊断文案。 */
function typeName(v: unknown): string {
  if (v === null) return 'NoneType'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'string') return 'str'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'boolean') return 'bool'
  return 'object'
}

/**
 * `BiasSpectr_Start` / `ZSpectr_Start` 的 Variables 块 → 一条谱。
 *
 * Variables 的布局（两条命令相同，`["i","i","*+c","i","i","2f","i","*f"]`）：
 *
 * ```
 * [0] 通道名字节数   [1] 通道数      [2] 通道名表     [3] 行数 = 通道数
 * [4] 列数 = 扫描点数 [5] 2D 数据    [6] 参数个数     [7] 参数表
 * ```
 *
 * 老代码读的是 `[0]` / `[1]`（两个表头整数）当成 z / current 数组 ——
 * 交出去的是通道计数，从来不是谱（`AcquireZSpectr`，2026-06-10）。
 */
export function reshapeSpectrum(variables: unknown): Spectrum {
  const none = (reason: string): Spectrum => ({ channels: {}, numPoints: 0, reason })

  if (!Array.isArray(variables) || variables.length < 6) {
    const n = Array.isArray(variables) ? String(variables.length) : '非序列'
    return none(`Variables 不足 6 项(实际 ${n}),不是一个谱数据块`)
  }
  const names = Array.isArray(variables[2]) ? (variables[2] as unknown[]) : []
  const rows = toInt(variables[3])
  const cols = toInt(variables[4])
  if (rows === null || cols === null) {
    return none(`行列数不是整数(rows=${pyRepr(variables[3])}, cols=${pyRepr(variables[4])})`)
  }
  // 两道各管一半，**顺序就是判据**（与旧仓同序）：先问「这是不是一块数据」，
  // 再问「这块数据装不装得进 rows×cols」。合成一道的话，两种完全不同的毛病
  // （回包根本不是谱 / 回包是谱但表头对不上）会得到同一句诊断。
  const block = variables[5]
  if (!isBlock(block) || rows <= 0 || cols <= 0) {
    return none(`数据块不是列表或行列数非正(rows=${rows}, cols=${cols}, data=${typeName(block)})`)
  }
  const flat: number[] = []
  const usable = flatten(block, flat)
  if (!usable || flat.length !== rows * cols) {
    // ⚠️ 与旧仓**同一条判据、不同的措辞**：那边印的是 numpy 的
    // `cannot reshape array of size 4 into shape (6,7)`。逐字复刻一句 numpy 的
    // 异常，等于让诊断指向一个这里根本不存在的库（同 D-SKILL-2 / D-OSCI-1）。
    const what = usable ? `一共 ${flat.length} 个数,要 ${rows * cols} 个` : '这段数据里有不是数的元素'
    return none(`${rows}×${cols} 装不下这段数据: ${what}`)
  }

  const channels: Record<string, number[]> = {}
  for (let i = 0; i < names.length && i < rows; i += 1) {
    // **行 = 通道**。第 i 行是 `flat[i*cols … (i+1)*cols)`，不是每隔 rows 取一个。
    channels[String(names[i])] = flat.slice(i * cols, (i + 1) * cols)
  }
  if (Object.keys(channels).length === 0) {
    return none(`数据解开了(${rows}×${cols}),但一个通道名都没有`)
  }
  return { channels, numPoints: cols, reason: '' }
}

/** 那句诊断里的 `{x!r}`。只有整数 / 浮点 / 字符串 / None 会走到这儿。 */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (Array.isArray(v)) return `[${v.map((x) => pyRepr(x)).join(', ')}]`
  return String(v)
}

/**
 * 第一个名字里**含**任一 needle 的通道（大小写不敏感）；没有就 `null`。
 *
 * **按名字认，不按固定列号** —— 固定列号正是转置那次解析弄错的东西。
 */
export function matchSpectrumChannel(
  channels: Readonly<Record<string, number[]>>,
  needles: readonly string[],
): number[] | null {
  for (const [name, trace] of Object.entries(channels)) {
    const low = name.toLowerCase()
    if (needles.some((n) => low.includes(n))) return trace
  }
  return null
}

/** `_sweep_duration_s` 的入参：从 `BiasSpectr_PropsGet` 读到的三项。 */
export interface SweepProps {
  /** 扫描点数；读不到给 `null`。 */
  readonly numPoints: number | null
  /** sweep 数；读不到给 `null`。 */
  readonly numSweeps: number | null
  /** 有没有反扫（往返 ⇒ 时长翻倍）。 */
  readonly backward: boolean
}

/** 扫掠时长的估算结果：一个数 + **算给人看的明细**。 */
export interface SweepBudget {
  /** 核心时长（秒）。 */
  readonly coreS: number
  /** 记账用的明细 —— 抬得不够时这是第一现场。 */
  readonly detail: Readonly<Record<string, unknown>>
}

/**
 * 从仪器自己的设定算一条谱要跑多久（秒）。
 *
 * ```
 * 时长 ≈ 点数 × (settling + integration) × (往返 ? 2 : 1) × sweep 数
 *        + sweep 数 × (initial_settling + end_settling + z_control + z_avg)
 * ```
 *
 * `timing` 少了 `integration_time_s`、或者点数/ sweep 数读不出来 ⇒ 退到
 * {@link SWEEP_BUDGET_FALLBACK_S}，并把「为什么退」一起交出去。
 */
export function sweepDuration(
  props: SweepProps,
  timing: Readonly<Record<string, number>>,
): SweepBudget {
  const npts = props.numPoints
  const nsw = props.numSweeps
  const integration = timing['integration_time_s']
  if (npts === null || nsw === null || integration === undefined) {
    return {
      coreS: SWEEP_BUDGET_FALLBACK_S,
      detail: {
        why: '读不到扫掠设定，退回保守上限',
        npts,
        nsweeps: nsw,
        timing_keys: Object.keys(timing).sort(),
      },
    }
  }
  const at = (k: string): number => timing[k] ?? 0.0
  const perPt = at('settling_time_s') + integration
  const perSweep =
    at('initial_settling_time_s') + at('end_settling_time_s') + at('z_control_time_s') + at('z_averaging_time_s')
  const core = npts * perPt * (props.backward ? 2 : 1) * nsw + perSweep * nsw
  return {
    coreS: core,
    detail: {
      npts,
      nsweeps: nsw,
      backward: props.backward,
      per_point_s: pyRound(perPt, 4),
      core_s: pyRound(core, 1),
    },
  }
}

/**
 * Python 的 `round(x, digits)` —— **银行家舍入**，而且是对这个 double 的
 * **精确值**做的。
 *
 * JS 的 `toFixed` 也按精确值算，但它明写「正好一半时取大的那个」（D-LANG-1 记的
 * 就是这一条），于是 `round(0.125, 2)` 两边分岔：Python 给 `0.12`，`toFixed` 给
 * `0.13`。这些数会逐位进金样。
 */
export function pyRound(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v
  // 「正好一半」这件事要按**精确值**判，而两种省事的判法都会错：
  //
  // · `v * 10**digits % 1 === 0.5` —— 那个乘法自己要舍入。
  //   `151*1.35+45 = 248.85000000000002`（精确值 248.8500000000000227…，**高于**
  //   中点）乘 10 之后恰好是 `2488.5`，于是一个不是一半的数被判成一半，
  //   银行家舍入按到 248.8，而 Python 给 248.9。**金样当场红**，这一条是它教的。
  // · `Number(v.toFixed(digits+1)) === v` —— 这只说明这个 double 的**最短写法**
  //   不超过 digits+1 位，而不是它的精确值就是那个数。`2.675` 的最短写法正是
  //   `2.675`，精确值却是 2.674999999999999822…（Python 给 2.67）。
  //
  // 真判据：把精确值写到第 20 位（`toFixed` 按精确值正确舍入，而任何可能成立的
  // 一半都落在很靠前的位上），第 digits+1 位是 5、再往后**全是 0**。
  if (Math.abs(v) >= 1e21) return v
  const exact = v.toFixed(20)
  const dot = exact.indexOf('.')
  const frac = dot < 0 ? '' : exact.slice(dot + 1)
  const isHalf =
    frac.length > digits && frac[digits] === '5' && /^0*$/.test(frac.slice(digits + 1))
  if (isHalf) {
    const p = 10 ** digits
    const fl = Math.floor(v * p)
    return (fl % 2 === 0 ? fl : fl + 1) / p
  }
  return Number(v.toFixed(digits))
}
