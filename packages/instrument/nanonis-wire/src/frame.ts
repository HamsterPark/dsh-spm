/**
 * Nanonis TCP 线协议的**帧层**：成帧、拆帧、错误段、`NeedModule` 判定。
 * 零 dsh 依赖、零 I/O——socket 在课时 1.4，类型码表在 1.2b。
 *
 * 帧布局（`STM-Bench/stmsim/wire/codec.py` 的 docstring 是权威）：
 *
 *     请求：name 补零到 32 B │ uint32 body_size │ uint16 send_response_back │ 2 B 零 │ body
 *     回复：name 32 B（**逐字回声**）        │ uint32 body_size │ 4 B 零              │ body
 *
 * 回复 body 末尾**永远**是错误段 `[int32 status][int32 desc_len][desc]`。
 * 仪器拒绝命令时，body **只有**这一段——没有任何声明的返回字段。
 */

export const HEADER_LEN = 40
export const NAME_LEN = 32
export const ERROR_HEADER_LEN = 8

/** 名字段放不下就抛，不截断。见 `spec/deviations.md` D-WIRE-1/2：Python 侧的
 *  `ljust(32)` 对超长名字不截断、对非 ASCII 按字符补齐，两种都会产出**错位的帧**，
 *  而错位的帧会让整条 TCP 流失步——这比拒绝一次调用糟得多。 */
export class WireFrameError extends Error {
  override readonly name = 'WireFrameError'
}

function encodeName(command: string): Uint8Array {
  const bytes = new TextEncoder().encode(command)
  if (bytes.length > NAME_LEN) {
    throw new WireFrameError(
      `命令名 ${JSON.stringify(command)} 编码后 ${bytes.length} 字节，超过名字段的 ${NAME_LEN} 字节。` +
        `截断会让回声校验失败、补齐会让帧错位，两者都比拒绝更糟。`,
    )
  }
  const field = new Uint8Array(NAME_LEN)
  field.set(bytes)
  return field
}

/** 客户端成帧。`sendResponseBack=false` 的命令不会有回复——调用方不要去等。 */
export function encodeRequestFrame(command: string, body: Uint8Array, sendResponseBack = true): Uint8Array {
  const frame = new Uint8Array(HEADER_LEN + body.length)
  frame.set(encodeName(command), 0)
  const view = new DataView(frame.buffer)
  view.setUint32(NAME_LEN, body.length, false) // 大端，整条协议都是
  view.setUint16(NAME_LEN + 4, sendResponseBack ? 1 : 0, false)
  // 36..38 已是零
  frame.set(body, HEADER_LEN)
  return frame
}

export interface ReplyHeader {
  /** 32 字节原始名字段。回声校验比的是**这个**，不是解码后的字符串。 */
  readonly rawName: Uint8Array
  readonly name: string
  readonly bodySize: number
}

export function parseReplyHeader(header: Uint8Array): ReplyHeader {
  if (header.length !== HEADER_LEN) {
    throw new WireFrameError(`帧头必须是 ${HEADER_LEN} 字节，收到 ${header.length}`)
  }
  const rawName = header.slice(0, NAME_LEN)
  let end = rawName.length
  while (end > 0 && rawName[end - 1] === 0) end--
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  return {
    rawName,
    name: new TextDecoder().decode(rawName.subarray(0, end)),
    bodySize: view.getUint32(NAME_LEN, false),
  }
}

/**
 * 回复的名字段必须与请求**逐字节**相同。
 *
 * 旧仓的血泪（PLAN §3.2-9）：不匹配意味着**流已经失步**——我们正在把某个别的命令的
 * 回复当成这一个的。此时唯一安全的处置是断链重连，绝不是返回 `[]` 假装没事。
 */
export function echoMatches(sentRawName: Uint8Array, replyRawName: Uint8Array): boolean {
  if (sentRawName.length !== replyRawName.length) return false
  for (let i = 0; i < sentRawName.length; i++) if (sentRawName[i] !== replyRawName[i]) return false
  return true
}

export interface ErrorSection {
  readonly status: number
  readonly description: string
  /** body 里**只有**错误段——仪器拒绝了这条命令，没有任何返回字段。 */
  readonly errorOnly: boolean
}

/**
 * 读 body 末尾的错误段。
 *
 * `errorOnly` 用的是**长度恒等式** `len(body) === 8 + desc_len`——这正是旧仓区分
 * 「仪器拒绝」与「我们把返回字段声明错了」的办法（`stmsim/wire/errors.py` 明说
 * MAST 依赖这条）。不用它的话，一个声明多了字段的方法会把自己的解码失败误报成
 * 仪器错误，然后我们去查一台没问题的仪器。
 */
export function parseErrorSection(body: Uint8Array): ErrorSection {
  if (body.length < ERROR_HEADER_LEN) {
    throw new WireFrameError(`回复 body 只有 ${body.length} 字节，放不下 ${ERROR_HEADER_LEN} 字节的错误段`)
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const status = view.getInt32(0, false)
  const descLen = view.getInt32(4, false)
  if (descLen >= 0 && body.length === ERROR_HEADER_LEN + descLen) {
    return {
      status,
      description: new TextDecoder().decode(body.subarray(ERROR_HEADER_LEN)),
      errorOnly: true,
    }
  }
  // 不满足恒等式 ⇒ 前面还有声明的返回字段，错误段贴在 body **末尾**而不是开头。
  // 尾部起点要由类型码表算出（课时 1.2b），帧层拿不到那个信息，所以说清楚而不是猜。
  throw new WireFrameError(
    `body ${body.length} 字节不满足 error-only 的长度恒等式（8 + ${descLen}）；` +
      `带返回字段的回复要先用类型码表切出尾部错误段，再把那一段交给本函数`,
  )
}

/**
 * 描述里带 `NeedModule` = **模块没加载**，不是线路故障。
 *
 * 这两者的处置完全相反：模块没加载是配置问题，重连一百次也没用，该做的是告诉操作员
 * 去 Nanonis 里打开那个模块；线路故障才该重连并计入熔断。旧仓的 `pump._guard` /
 * `zburst._guard` / `acquire_osci_trace` 都靠这个子串分流（`stmsim/wire/errors.py`）。
 */
export function isNeedModule(description: string): boolean {
  return description.includes('NeedModule')
}
