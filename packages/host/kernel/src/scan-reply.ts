/**
 * 扫描缓冲区与帧回包的解析 —— 「这一帧到底采了多少行」。
 *
 * Nanonis 把**还没采到**的扫描缓冲区行整行填成 NaN，所以 **NaN 前沿就是扫描前沿**，
 * 数「不是整行 NaN」的行数就精确地量到了进度。这不是猜的：时钟估计法被抓到把一次扫描
 * 的每个里程碑都烧在头一小段里（2026-07-10 #76）之后，扫描视觉监视器就是照这个重
 * 建的。
 *
 * 这两个解析器是 `WaitScanComplete` 判「停了 = 扫完了吗」的全部依据。
 *
 * ## 与旧仓的两处形状差异
 *
 * 1. **信封在 `nanonis-wire` 那层已经拆掉**（D-SKILL-1）：旧仓这些函数吃的是
 *    `(error, raw_bytes, body)` 三段，本仓这一侧直接吃 **body**。
 * 2. **JS 只有一种数**（D-SCAN-1）：旧仓靠 `isinstance(x, int)` 从异构 body 里挑出
 *    `rows` / `cols` 两个表头整数，而 `2.0` 在 Python 里是 float、在 JS 里
 *    `Number.isInteger(2.0)` 为真。这只影响**扁平数值 body** 那条兜底路（桩/扁平
 *    仪器），真机 body 里那个二维元素会先被找到，表头路根本不参与。金样的 10 格
 *    在两种判据下结论相同——差异是真的，但它没落在任何一个已知回包上。
 */

/**
 * 一个 Nanonis 标量 → 整数，解掉 1 元素序列；读不出返回 `null`。
 *
 * 与 {@link scalarFloat} 同族，**拒绝同样的东西**：多元素序列 → `null`（不取第 0
 * 个）、字符串 → `null`、非有限 → `null`。永不用 0 兜底。
 *
 * ⚠️ 只解**一层**（旧仓如此）：`[[1]]` 是 `null`，不是 1。
 */
export function scalarInt(x: unknown): number | null {
  let v = x
  if (Array.isArray(v)) {
    if (v.length !== 1) return null
    v = v[0]
  }
  if (typeof v === 'string' || typeof v === 'boolean' || v instanceof Uint8Array) return null
  if (typeof v === 'bigint') return Number(v)
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.trunc(v)
}

/**
 * 从 `Scan_BufferGet` 的 body 里取出采集通道号。
 *
 * **真机上 `channel_indexes` 是一串 1-元组**，不是一串整数——2026-08-04 实测：
 * `[(0,), (30,)]`。仓里每一份桩与测试夹具给的都是裸整数 `[0, 14]`，所以这个差异
 * 一直到了仪器上才现形：`SetScanBuffer` 写的是 `[int(c) for c in raw_ch]`，
 * 在**第一次真调用**上就死在 "int() argument must be … not 'tuple'"，整条 ScanAt
 * 路被打断。
 *
 * 这里是全仓唯一知道这个形状的地方。两种形态都吃，读不动的元素**跳过而不是抛**
 * ——一个乱码元素不该让你连读得出来的那些通道也丢掉。
 */
export function channelIdsFromBuffer(body: unknown): number[] {
  if (!Array.isArray(body) || body.length < 2) return []
  const raw = body[1]
  if (typeof raw === 'string' || raw instanceof Uint8Array) return []
  if (!Array.isArray(raw)) {
    const n = scalarInt(raw)
    return n === null ? [] : [n]
  }
  const ids: number[] = []
  for (const item of raw) {
    const n = scalarInt(item)
    if (n !== null) ids.push(n)
  }
  return ids
}

export interface BufferGet {
  /** **仪器声明的**通道数（body[0]），逐字报出，不拿 `channelIndexes.length` 重算。 */
  readonly numChannels: number | null
  readonly channelIndexes: number[]
  readonly pixels: number | null
  readonly lines: number | null
}

/**
 * `Scan_BufferGet` 的 body → `{numChannels, channelIndexes, pixels, lines}`。
 *
 * body 根本不是一份能用的缓冲区回包时返回 `null`，于是调用方分得清「解不出来」
 * （拒绝下笔）与「解出来了，但一个通道都没选」（另一件事，也该拒绝）。
 *
 * `numChannels` 与 `channelIndexes.length` 万一对不上，那是调用方**应该看见**的
 * 解析失败，不是一件该被抹平的事。
 */
export function parseBufferGet(body: unknown): BufferGet | null {
  if (!Array.isArray(body) || body.length < 4) return null
  return {
    numChannels: scalarInt(body[0]),
    channelIndexes: channelIdsFromBuffer(body),
    pixels: scalarInt(body[2]),
    lines: scalarInt(body[3]),
  }
}

/** 二维数值表？（真机 body 里那个数据元素的形状） */
function is2D(x: unknown): x is number[][] {
  return Array.isArray(x) && x.length > 0 && Array.isArray(x[0])
}

/** 旧仓那条 `isinstance(x, (int, float)) and not isinstance(x, bool)`——布尔在 JS 里
 *  本来就不是 number，所以只剩类型判断。NaN 照样算数（它是个 float）。 */
function numeric(x: unknown): x is number {
  return typeof x === 'number'
}

/**
 * 从 `Scan_FrameDataGrab` 的 body 里取出一个通道的采样。
 *
 * 真机 body 是**异构**表 `[name_len, name(str), rows, cols, data_2D, dir]`。整表
 * 一起当数组解会炸（int/str/二维混在一起），而这个 bug 在扁平桩上是看不见的——它
 * 让 CheckScanForCrash / 漂移解析在**每一次真实扫描**上都失败，只在桩上「能跑」。
 *
 * `shape2d` 为真时给二维表，否则拉平成一维。取不出可用数据返回 `null`。
 */
export function parseFrameGrab(body: unknown, shape2d = false): number[] | number[][] | null {
  let arr: number[] | number[][] | null = null
  let rows: number | null = null
  let cols: number | null = null

  if (is2D(body)) {
    arr = body
  } else if (Array.isArray(body) && body.length > 0) {
    const ints = body.filter((x): x is number => typeof x === 'number' && Number.isInteger(x))
    for (const el of body) {
      if (is2D(el)) {
        arr = el
        break
      }
    }
    if (arr === null && !body.some((x) => typeof x === 'string')) {
      // 扁平兜底（桩 / 扁平仪器）：纯数值 body。
      const nums = body.filter(numeric)
      if (nums.length > 0) arr = nums
    }
    // 表头 rows/cols：`[name_len, name, rows, cols, data, dir]` → ints[1], ints[2]
    if (ints.length >= 3) {
      rows = ints[1] ?? null
      cols = ints[2] ?? null
    }
  }

  if (arr === null || arr.length === 0) return null
  if (!shape2d) return is2D(arr) ? arr.flat() : arr
  if (is2D(arr)) return arr

  const flat = arr
  if (rows && cols && rows * cols === flat.length) return reshape(flat, rows, cols)
  // 拉平的一维轨迹尽量凑成方阵
  const side = Math.round(Math.sqrt(flat.length))
  if (side * side === flat.length) return reshape(flat, side, side)
  return null // 拼不出一张可靠的二维图
}

function reshape(flat: readonly number[], rows: number, cols: number): number[][] {
  const out: number[][] = []
  for (let r = 0; r < rows; r += 1) out.push(flat.slice(r * cols, (r + 1) * cols))
  return out
}

/**
 * `(采到的行数, 缓冲区里的行数)`，取自 `Scan_FrameDataGrab` 的 body。
 *
 * body 里没有可用的二维帧时返回 `null` —— 调用方那时必须把进度当成**未知**，
 * **绝不当成零**。
 *
 * ⚠️ 一帧里一个 NaN 行都没有时这里报 `(rows, rows)`，不是 `null`。这个函数回答的是
 * 「有没有**看得见的缺失**」，而在一台用陈旧数据回填（而不是 NaN 填）的仪器上，
 * 诚实的答案退化成「看不见缺失」——那正是这条检查存在之前的行为，而不是一条新的误报。
 */
export function frameAcquiredLines(body: unknown): [number, number] | null {
  const arr = parseFrameGrab(body, true)
  if (arr === null || !is2D(arr) || arr.length === 0) return null
  const rows = arr.length
  let done = 0
  for (const row of arr) {
    if (row.some((v) => !Number.isNaN(v))) done += 1
  }
  return [done, rows]
}

// ─────────────────────────────────────────────────────────────────────────
// `Scan_PropsGet` 的五个解析器
// ─────────────────────────────────────────────────────────────────────────

/** 声明的字段数。少于它就只能走启发式。 */
export const PROPS_N_FIELDS = 16
export const PROPS_IX_CONTINUOUS = 0
export const PROPS_IX_SERIES_NAME = 4
export const PROPS_IX_MODULES_COUNT = 8
export const PROPS_IX_MODULES = 9

/** SET 侧的编码。⚠️ 与 GET 侧**不同**：这边的「关」是 2。 */
export const SET_NO_CHANGE = 0
export const SET_OFF = 2
export const SET_AUTOSAVE_ALL = 1
/** GET 侧的编码。只有两个值。 */
export const GET_ON = 1
export const GET_OFF = 0

/**
 * 数组字段在真机上是 1-元组，标量不是。
 *
 * 多元素 ⇒ `null`（**不取第 0 个**）：那是一个我们没预料到的形状，猜一个值出来
 * 只会把形状错误变成一个看起来合理的数。
 */
export function unwrapScalar(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null
  return value
}

/**
 * GET 编码的 continuous 标志 → **三态**。
 *
 * `null` 同时覆盖「读不到」与「机器答了一个不在 GET 表里的值」——因为两者都**不是**
 * 「它开着吗」的答案。
 *
 * 后半句不是假设性的填充：GET 表恰好两个值（0=关、1=开），而 SET 表的「关」是 **2**，
 * 一个 2 到了这里曾经算成 `2 === GET_ON` → `false` → 「确认已关」。那与 2026-08-19
 * 那次故障是同一个形状：**一个不是答案的值，被折进了那个让人安心的答案**。
 */
export function continuousState(flag: unknown): boolean | null {
  // Python 那边 `bool` 是 `int` 的子类，于是 `True == 1` 成立。本仓的线协议这一格
  // 解出来永远是数字，所以这一支实际到不了；照移是为了**不引入一处无动机的分岔**
  // ——而 `true`/`false` 本来也确实就是那两个状态。
  if (typeof flag === 'boolean') return flag
  if (flag === GET_ON) return true
  if (flag === GET_OFF) return false
  return null
}

/** body 里第 0 位那个 continuous 标志（已解 1-元组）；读不到 `null`。 */
export function scanPropsContinuous(body: unknown): unknown {
  if (!Array.isArray(body) || body.length === 0) return null
  return unwrapScalar(body[PROPS_IX_CONTINUOUS])
}

/**
 * 「保存哪些模块参数」清单；读不到给空表。
 *
 * **这个函数存在，是因为原来那段循环找错了层。** 回包形状是 `(err, raw, body)`，
 * 模块名数组在 **body 里面**；原来的代码在**顶层**三个元素上找「全是字符串的 list」，
 * 那里永远没有，于是 `moduleNames` **每次都是空的**，紧接着的兜底每次都命中，
 * **写死的 5 个名字每一次扫描都被下发**，把用户在 GUI 里配的清单覆盖掉。
 *
 * 这不是「读失败时的兜底」，是**兜底一直在生效**。真机证据（2026-08-10）：用户全选
 * 之前的文件头里正好只有 4 个模块块——也就是那 5 个写死名字里**能对上的那 4 个**；
 * 第 5 个 `"Piezo"` 在 Nanonis 里实际叫 `Piezo Configuration`，所以它一次都没生效过，
 * 而代码读起来像包含了它。倾斜矫正角正是因此从来没进过文件。
 *
 * **只认全字符串的数组**——模块名数组是回包里唯一这样的东西。
 */
export function scanPropsModules(body: unknown): string[] {
  if (!Array.isArray(body)) return []
  for (const item of body) {
    if (Array.isArray(item) && item.length > 0 && item.every((s) => typeof s === 'string')) {
      return item.map((s) => String(s))
    }
  }
  return []
}

/**
 * **声明的**模块数，信不过就 `null`。
 *
 * 为什么要有它：{@link scanPropsModules} 对**两种不同的处境**都返回 `[]`——
 * 用户选了**零个**模块（一个事实），以及我们**没在回包里找到那个数组**（事实的缺席）。
 *
 * 把两者折在一起，正是这个仓库反复付账的那一步，而这里的代价很具体：选了零个模块时，
 * 写回 `[]` 在**两种可能的协议语义下都可证是空操作**——空数组若表示「清空」就清了一个
 * 已经空的表，若表示「不改」就什么都没改。那是唯一一种**没读到清单也能安全下发**
 * `Scan_PropsSet` 的情形，而把它与「未知」混为一谈就把这一格扔掉了。
 *
 * 只有当回包有完整的声明形状**且**声明的个数与解出的数组一致时才采信——同一个回包的
 * 两个字段，一次错解没有理由让它们保持一致。不一致 ⇒ `null`（未知），**绝不修补**。
 */
export function scanPropsModuleCount(body: unknown): number | null {
  if (!Array.isArray(body) || body.length < PROPS_N_FIELDS) return null
  const count = unwrapScalar(body[PROPS_IX_MODULES_COUNT])
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null
  const names = body[PROPS_IX_MODULES]
  if (!Array.isArray(names)) return null
  if (names.length !== count || !names.every((s) => typeof s === 'string')) return null
  return count
}

/**
 * 当前序列名；读不懂给 `""`。
 *
 * 有完整声明形状时按位取，否则取第一个非空字符串。它存在是为了让 `StartScan` **不再
 * 为它单发第二次 `Scan_PropsGet`**：两次读可以给出不同的答案，而分歧不是无害的——
 * 一个空序列名写进 `Scan_PropsSet` 会把用户配的文件名前缀打回 `unnamed####`。
 * **一次读，一个答案。**
 */
export function scanPropsSeriesName(body: unknown): string {
  if (!Array.isArray(body)) return ''
  if (body.length >= PROPS_N_FIELDS) {
    const name = body[PROPS_IX_SERIES_NAME]
    return typeof name === 'string' ? name : ''
  }
  for (const item of body) {
    if (typeof item === 'string' && item) return item
  }
  return ''
}
