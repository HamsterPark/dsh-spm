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
