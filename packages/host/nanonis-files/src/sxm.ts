/**
 * Nanonis `.sxm` —— 扫描帧文件。**这一族解锁的是剩下 115 个分析技能的输入。**
 *
 * 布局：一段文本头 → 结束记号 → 一整块大端 float32 的帧数据。
 *
 * ## 三条判据，每一条都对着一次真事故
 *
 * **① 单方向通道只存一帧。** `:DATA_INFO:` 的 Direction 列写 `both` / `fwd` / `bwd`。
 * 旧读取器一律按「先 forward 再 backward」消费两帧，于是一个 `fwd` 通道之后
 * **字节偏移错位，后面每一个通道的数据都被移位**（2026-07-03 复盘）。
 * 移位之后的图**看起来完全正常**——它是另一路真实信号，只是标错了名字。
 *
 * **② `nx <= 0` 而不是 `nx == 0`。** 一个负的像素数会被 `reshape` 当成
 * 「这一维你替我算」的通配符，**从任意字节里造出一帧形状不对的图**。
 * `== 0` 挡得住零，挡不住负数。
 *
 * **③ `:SCAN_DIR:` 读不出来就不翻。** Nanonis 按**采集顺序**写行：`down` 从帧顶
 * 开始（行 0 已经是顶），`up` 从帧底开始（行 0 是底，要 flipud）。
 * 而方向读不到时**原样返回**——恒等是唯一不声称我们没有的知识的操作。
 * 旧仓 `mosaic` 曾经按 `!= "down"` 翻，也就是**把读不出方向的文件也翻了**；
 * 两条规则在每一个真实文件上都一致（它们都写 up 或 down），只在证据缺席处
 * 分岔，而那正是该安静的地方。
 *
 * ## 截断：**丢掉那一帧**，不补零、也不抛
 *
 * 三种格式三种策略，见 `docs/handoff/nanonis-files.md`。这里丢帧的理由是
 * `.sxm` 是**多通道容器**：一个通道截断不该让前面几个通道作废，而「这一帧不在」
 * 在返回值里表示得出来（键缺席）。补零则不行——补出来的下半张图是一片平坦的
 * 「干净表面」，而那正是撞针检测要找的形状。
 */
import { matFromRows, type Mat } from 'dsh-spm-numerics'
import {
  assertReadableSize,
  decodeHeaderText,
  firstFloat,
  indexOfBytes,
  readBigEndianFloat32,
} from './common.js'

/** 解析出来的 `.sxm` 头。除下面几个具名字段外，其余键是原样字符串。 */
export interface SxmHeader {
  readonly [key: string]: unknown
  /** `[nx, ny]`。**记号解析不出整数时这个键不存在**——不是 `[0, 0]`。 */
  readonly scan_pixels?: readonly [number, number]
  readonly channel_names?: readonly string[]
  readonly channel_directions?: readonly string[]
}

export interface SxmChannel {
  readonly forward?: Mat
  readonly backward?: Mat
}

export interface SxmScan {
  readonly header: SxmHeader
  readonly channels: Readonly<Record<string, SxmChannel>>
}

const MARKER_LITERAL = new TextEncoder().encode('\\1A\\04')
const MARKER_RAW = Uint8Array.from([0x1a, 0x04])

/**
 * 找头的结束记号。**先找六字节的字面量 `\1A\04`，再找两字节的 0x1A 0x04。**
 *
 * 顺序有讲究：有些产生器把记号写成 ASCII 字面量，而那六个字节里不含 0x1A，
 * 所以反过来找会在字面量文件上找不到。先字面量后裸字节在两种文件上都对。
 */
function findHeaderEnd(bytes: Uint8Array): { end: number; markerLength: number } | null {
  const lit = indexOfBytes(bytes, MARKER_LITERAL)
  if (lit >= 0) return { end: lit, markerLength: MARKER_LITERAL.length }
  const raw = indexOfBytes(bytes, MARKER_RAW)
  if (raw >= 0) return { end: raw, markerLength: MARKER_RAW.length }
  return null
}

/**
 * 解析 `.sxm` 的文本头。
 *
 * `:KEY:` 起一个字段（小写、空格换下划线），随后的非空行是它的值。
 * `scan_pixels` 与 `data_info` 两个字段有自己的解析；其余**最后一行胜出**。
 */
export function parseSxmHeader(raw: string): SxmHeader {
  const header: Record<string, unknown> = {}
  let currentKey = ''

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith(':')) {
      currentKey = line.replace(/^:+|:+$/g, '').toLowerCase().replaceAll(' ', '_')
      continue
    }
    if (currentKey === '') continue

    if (currentKey === 'scan_pixels') {
      const parts = line.split(/\s+/).filter((t) => t !== '')
      if (parts.length >= 2) {
        // 记号本来是整数，而一份坏头可能带着 `128.0` / `NaN` / `-`。
        // **解析不出就整个字段不落**（不是落一个 0）—— 于是 `readSxm` 会走
        // 「一个通道都不读」那条路，而不是从任意字节里造一帧出来。
        const a = /^[+-]?\d+$/.test(parts[0] as string) ? Number(parts[0]) : null
        const b = /^[+-]?\d+$/.test(parts[1] as string) ? Number(parts[1]) : null
        if (a !== null && b !== null) header['scan_pixels'] = [a, b]
      }
      continue
    }

    if (currentKey === 'data_info') {
      const names = (header['channel_names'] as string[] | undefined) ?? []
      const dirs = (header['channel_directions'] as string[] | undefined) ?? []
      header['channel_names'] = names
      header['channel_directions'] = dirs
      const parts = line.split('\t')
      if (parts.length >= 2 && (parts[1] ?? '').trim() !== '') {
        const name = (parts[1] as string).trim()
        if (name === 'Name') continue // 表头行
        names.push(name)
        const direction = parts.length >= 4 ? (parts[3] as string).trim().toLowerCase() : ''
        dirs.push(direction === '' ? 'both' : direction)
      }
      continue
    }

    header[currentKey] = line
  }
  return header as SxmHeader
}

/** 这个通道存了几帧、哪几帧。**方向决定字节消费量**（判据 ①）。 */
function directionsFor(flag: string): readonly ('forward' | 'backward')[] {
  const hasFwd = flag.includes('fwd')
  const hasBwd = flag.includes('bwd')
  if (hasFwd && !hasBwd) return ['forward']
  if (hasBwd && !hasFwd) return ['backward']
  return ['forward', 'backward']
}

/** 只解析文本头，**不碰后面那一整块帧数据**（列目录用）。永不抛。 */
export function readSxmHeaderOnly(bytes: Uint8Array, maxHeaderBytes = 1_048_576): SxmHeader {
  const chunk = bytes.subarray(0, Math.max(0, Math.trunc(maxHeaderBytes)))
  const found = findHeaderEnd(chunk)
  if (found === null) return {} // 头比上限还长，或者根本不是 .sxm —— 便宜地放弃
  return parseSxmHeader(decodeHeaderText(chunk.subarray(0, found.end)))
}

/** 读一个 `.sxm`。**找不到结束记号就抛** —— 那说明它不是一个 `.sxm`。 */
export function readSxm(bytes: Uint8Array, what = '<sxm>'): SxmScan {
  assertReadableSize(bytes.byteLength, what)
  const found = findHeaderEnd(bytes)
  if (found === null) throw new Error(`Cannot find header end marker in ${what}`)

  const header = parseSxmHeader(decodeHeaderText(bytes.subarray(0, found.end)))
  const data = bytes.subarray(found.end + found.markerLength)

  const pixels = header.scan_pixels
  if (pixels === undefined) return { header, channels: {} }
  const [nx, ny] = pixels
  // 判据 ②：`<= 0`，不是 `== 0`
  if (nx <= 0 || ny <= 0) return { header, channels: {} }

  const names = header.channel_names ?? []
  const dirs = header.channel_directions ?? []
  const perFrame = nx * ny
  const channels: Record<string, SxmChannel> = {}

  let offset = 0
  for (let i = 0; i < names.length; i++) {
    const ch: { forward?: Mat; backward?: Mat } = {}
    for (const direction of directionsFor(dirs[i] ?? 'both')) {
      const nBytes = perFrame * 4
      // 截断：**丢掉这一帧**（见文件抬头）。跳出的是这个通道，外层继续 ——
      // 与旧仓 `break` 同形。
      if (offset + nBytes > data.length) break
      const flat = readBigEndianFloat32(data, offset, perFrame)
      const rows: number[][] = []
      for (let r = 0; r < ny; r++) rows.push(Array.from(flat.subarray(r * nx, (r + 1) * nx)))
      ch[direction] = matFromRows(rows)
      offset += nBytes
    }
    channels[names[i] as string] = ch
  }
  return { header, channels }
}

/**
 * 一帧，**行 0 = 高 y（顶）那一边**，不管 `:SCAN_DIR:` 说什么。
 *
 * 那一次翻转**只在这一个地方**做。它曾经用三种写法散在三处，而其中一处
 * 压根没做 —— 于是操作员反馈 #94「扫图的 up 和 down 好像只有一个方向会自动
 * 显示在扫描地图上」：Nanonis 的 bouncy 开着时相邻帧方向交替，扫描地图底图
 * 每隔一张就与邻居上下颠倒地画了出来。
 *
 * **方向读不出来（字段缺席 / `null` / 垃圾）⇒ 原样返回**，见文件抬头判据 ③。
 */
export function rowsTopFirst(m: Mat, scanDir: unknown): Mat {
  if (String(scanDir ?? '').trim().toLowerCase() !== 'up') return m
  const rows: number[][] = []
  for (let r = m.rows - 1; r >= 0; r--) {
    rows.push(Array.from(m.data.subarray(r * m.cols, (r + 1) * m.cols)))
  }
  return matFromRows(rows)
}

function flipLeftRight(m: Mat): Mat {
  const rows: number[][] = []
  for (let r = 0; r < m.rows; r++) {
    rows.push(Array.from(m.data.subarray(r * m.cols, (r + 1) * m.cols)).reverse())
  }
  return matFromRows(rows)
}

/** 通道名 → 物理单位的猜测表。表外一律空串——**不猜一个单位出来**。 */
const CHANNEL_UNIT_HINT: Readonly<Record<string, string>> = {
  z: 'm', current: 'A', bias: 'V', phase: 'deg',
  amplitude: 'm', 'frequency shift': 'Hz', excitation: 'V',
}

export interface OrientedFrames {
  readonly channel: string
  readonly forward: Mat | null
  readonly backward: Mat | null
  readonly nm_per_px: number | null
  readonly width_nm: number | null
  readonly height_nm: number | null
  readonly bias_v: number | null
  readonly setpoint_a: number | null
  readonly scan_dir: string | null
  readonly unit: string
  readonly rec_time: string
}

/**
 * 把一个通道的两帧放进**同一个几何朝向**，外加尺度。
 *
 * `readSxm` 刻意原样交出 Nanonis 写的块；这一层是让两帧**可比**的那一步：
 *
 * - **backward 块沿 −x 采集，所以它是镜像存的** → 左右翻。不翻的话，任何
 *   正/反扫比较（配准、trace/retrace 不稳定性、漂移）都是在拿一张图和它自己的
 *   镜像比，**而它返回的那个数没有意义**。
 * - `:SCAN_DIR: up` 时第一条采集线是帧底 → 上下翻，于是每个文件的行 0 都是帧顶。
 *
 * **永不抛**：通道不存在就 `forward = null`，由调用方决定怎么办。
 */
export function sxmOrientedFrames(scan: SxmScan, channel = 'Z'): OrientedFrames {
  const header = scan.header ?? {}
  const channels = scan.channels ?? {}
  let ch: SxmChannel | undefined = channels[channel]
  if (ch === undefined) {
    // 不分大小写的第二次机会 —— Nanonis 的通道名各机器不一（"Z" / "z"）
    const key = Object.keys(channels).find((k) => k.toLowerCase() === channel.toLowerCase())
    ch = key === undefined ? undefined : channels[key]
  }

  let fwd: Mat | null = null
  let bwd: Mat | null = null
  if (ch !== undefined) {
    fwd = ch.forward ?? null
    bwd = ch.backward === undefined ? null : flipLeftRight(ch.backward)
    if (fwd === null && bwd !== null) {
      // 只有 bwd 的通道：去镜像之后它**就是**这个通道仅有的一帧，当 forward 交出去
      fwd = bwd
      bwd = null
    }
    const scanDir = String(header['scan_dir'] ?? '').trim().toLowerCase()
    if (fwd !== null) fwd = rowsTopFirst(fwd, scanDir)
    if (bwd !== null) bwd = rowsTopFirst(bwd, scanDir)
  }

  const parts = String(header['scan_range'] ?? '').trim().split(/\s+/).filter((t) => t !== '')
  const widthM = firstFloat(parts[0])
  const heightM = firstFloat(parts[1], widthM)
  const widthNm = widthM !== null && widthM !== 0 ? widthM * 1e9 : null
  const heightNm = heightM !== null && heightM !== 0 ? heightM * 1e9 : null
  const nmPerPx = widthNm !== null && fwd !== null && fwd.cols > 0 ? widthNm / fwd.cols : null

  const recDate = String(header['rec_date'] ?? '').trim()
  const recTime = String(header['rec_time'] ?? '').trim()

  return {
    channel,
    forward: fwd,
    backward: bwd,
    nm_per_px: nmPerPx,
    width_nm: widthNm,
    height_nm: heightNm,
    bias_v: firstFloat(header['bias']),
    setpoint_a: firstFloat(header['z-controller>setpoint']),
    scan_dir: String(header['scan_dir'] ?? '').trim().toLowerCase() || null,
    unit: CHANNEL_UNIT_HINT[channel.trim().toLowerCase()] ?? '',
    rec_time: `${recDate} ${recTime}`.trim(),
  }
}

/** 紧凑的、可进 JSON 的帧描述符（给扫描登记表 / 断点用）。 */
export function sxmFrameMeta(header: SxmHeader): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const chans = header.channel_names
  if (chans !== undefined && chans.length > 0) out['channels'] = [...chans]
  for (const k of ['scan_offset', 'scan_range', 'scan_pixels'] as const) {
    if (k in header) {
      const v = header[k]
      out[k] = Array.isArray(v) ? [...v] : v
    }
  }
  return out
}
