/**
 * 线协议上的文本：「二进制串」怎么变回真字符。
 *
 * `*-c` / `*+c` / `**c` 的回复在 `nanonis-wire` 里解成**二进制串**——逐字节一字符，一个字节不丢
 * （`binaryString`）。字节属于哪个代码页，那一层不知道，也不该猜。本文件是两处要把它们变回
 * 真字符的地方：
 *
 * - {@link lastPath} / {@link repairWirePath}：会话路径。拿字节依次按 UTF-8、GBK、windows-1252 试，
 *   取第一个指向**真实存在**的路径（或其上级目录）的；
 * - {@link decodeWireText}：要把读到的串**写回**仪器的地方。不看文件系统，只看字节本身合不合法。
 *
 * 其余技能把二进制串原样交给调用方，与参考实现一致。见 spec/deviations.md D-WIRE-4。
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SkillCallRecord } from 'dsh-spm-kernel'
import { binaryStringBytes } from 'dsh-spm-nanonis-wire'
import { body } from './common.js'

/**
 * 「这条路径在不在」。注入是为了让测试不依赖本机的盘：默认读真文件系统（{@link fsProbe}）。
 *
 * `parentIsDirectory` 由探针自己回答，而不是传一个 `dirname` 的结果进来：上级怎么取
 * 取决于路径是哪个平台的写法，那该是探针的事。
 */
export interface PathProbe {
  readonly exists: (path: string) => boolean
  readonly parentIsDirectory: (path: string) => boolean
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const fsProbe: PathProbe = {
  exists: (path) => {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  },
  parentIsDirectory: (path) => isDirectory(dirname(path)),
}

/** 二进制串的原始字节。已经是真字符（有 >0xFF 的码元）或纯 ASCII，就没有可还原的东西，给 `null`。 */
function bytesToRepair(s: string): Uint8Array | null {
  const raw = binaryStringBytes(s)
  return raw === null || raw.every((b) => b < 0x80) ? null : raw
}

/** 严格解码：字节不合法就给 `null`，不换成 U+FFFD。 */
function decodeStrict(raw: Uint8Array, label: 'utf-8' | 'gbk'): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(raw)
  } catch {
    return null
  }
}

/**
 * 参考实现 `_repair_nanonis_path` 的对等物：把二进制串形式的路径还原成真字符。
 *
 * 仪器按哪个代码页发，这里不知道：STM-Bench 按 UTF-8；真控制器是否按系统 ANSI 代码页（中文
 * Windows 上是 GBK）发，是参考实现的推断，没有真机验证。所以逐个试，取第一个「自己存在，或者
 * 上级是目录」的；没有一个指向真实路径，就取第一个能解出来的。纯 ASCII 和已经是真字符的原样返回。
 *
 * 与参考实现的区别：它的第二档是本机 ANSI 代码页（`mbcs`），Node 取不到这个值，这里用 GBK 顶；
 * 最后一档 windows-1252 对任何字节都能解，所以总有一个候选。
 */
export function repairWirePath(s: string, probe: PathProbe = fsProbe): string {
  const raw = bytesToRepair(s)
  if (raw === null) return s
  const candidates = [
    decodeStrict(raw, 'utf-8'),
    decodeStrict(raw, 'gbk'),
    new TextDecoder('windows-1252').decode(raw),
  ].filter((c): c is string => c !== null)
  return candidates.find((c) => probe.exists(c) || probe.parentIsDirectory(c)) ?? candidates[0]!
}

/**
 * 二进制串 → 真字符，**不看文件系统**：严格 UTF-8，不成再试严格 GBK，都不成原样返回。
 *
 * 用在要把读到的串**写回**仪器的地方：`StartScan` 把 `Scan_PropsGet` 读到的系列名写回
 * `Scan_PropsSet`。读到的是二进制串，而请求侧把字符串按 UTF-8 编码——不先解回真字符，每个
 * 非 ASCII 字节都会被编成两个字节。参考实现在这里就是这样双重编码的，不照抄。
 * 没有 windows-1252 这一档：它对任何字节都「成功」，会把读不懂的字节硬解成别的字符再写回去。
 */
export function decodeWireText(s: string): string {
  const raw = bytesToRepair(s)
  if (raw === null) return s
  return decodeStrict(raw, 'utf-8') ?? decodeStrict(raw, 'gbk') ?? s
}

/**
 * body 里**最后一个字符串**。
 *
 * `Util.SessionPathGet` 的 `ResponseTypes = ["i", "*-c"]` ⇒ body 是
 * `[路径字节数, 路径]`，路径跟在它的长度后面。
 */
function lastString(rec: SkillCallRecord): string {
  const b = body(rec)
  for (let i = b.length - 1; i >= 0; i--) if (typeof b[i] === 'string') return b[i] as string
  return ''
}

/**
 * 会话路径：body 里最后一个字符串，并还原成真字符。
 *
 * **一个解析器，所有地方用**——`GetSessionPath`、`SetSessionPath` 的回读、各处找文件的目录。
 * 回读若由另一份单独写的解析器来读，它可以自己和自己一致而两边都是错的；「控制器存在哪」
 * 在本仓只该有一种答案。
 */
export function lastPath(rec: SkillCallRecord, probe: PathProbe = fsProbe): string {
  return repairWirePath(lastString(rec), probe)
}
