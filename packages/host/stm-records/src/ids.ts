/**
 * 记录库里的两种时间标识：ULID（行 id）与 HLC（排序键）。
 *
 * 两者都**按时间排序**，这不是巧合而是要求：审计要回答的是「先发生的是哪一条」，
 * 而一张按插入顺序无序的表，问它这个问题只能靠猜。
 */

/** Crockford Base32。逐字与旧仓 `logging/v2/ulid.py` 一致。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeInt(n: bigint, length: number): string {
  let out = ''
  let v = n
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(v & 0x1fn)] + out
    v >>= 5n
  }
  return out
}

/** 48 位毫秒 + 80 位随机 = 26 个字符，字典序即时间序。 */
export function ulid(nowMs: number = Date.now(), random: () => number = Math.random): string {
  const ms = BigInt(Math.floor(nowMs)) & ((1n << 48n) - 1n)
  // 80 位随机：Math.random 一次给不满，拼四段 20 位
  let rand = 0n
  for (let i = 0; i < 4; i++) rand = (rand << 20n) | BigInt(Math.floor(random() * 0x100000))
  return encodeInt(ms, 10) + encodeInt(rand, 16)
}

/**
 * 混合逻辑时钟。编码 `{毫秒:013d}-{计数:04d}-{节点}`，逐字与旧仓一致。
 *
 * 为什么不能只用墙钟：**同一毫秒内的多次调用会撞**，而一次技能调用连着下一次
 * 恰好落在同一毫秒里是常态（被闸门拒掉的调用尤其快）。撞了之后「谁先谁后」就没了，
 * 而那正是记录层唯一要回答的问题。计数器就是为这一毫秒之内准备的。
 *
 * **只移植 `now()`，不移植 `update()`**：后者是把远端节点的 HLC 折进来，
 * 而我们现在只有一个节点。等真有第二个再说。
 */
export class HlcClock {
  private lastPt = 0
  private lastCounter = 0

  constructor(
    private readonly nodeId: string,
    private readonly wallMs: () => number = Date.now,
  ) {
    if (nodeId === '' || nodeId.includes('-')) {
      // `-` 是编码的分隔符：节点名里带它，parse 就再也切不回来
      throw new Error(`节点名不能为空、也不能含 '-'：${JSON.stringify(nodeId)}`)
    }
  }

  now(): string {
    const phys = Math.floor(this.wallMs())
    if (phys > this.lastPt) {
      this.lastPt = phys
      this.lastCounter = 0
    } else {
      this.lastCounter += 1
      if (this.lastCounter >= 10_000) {
        throw new Error(`HLC 同一毫秒内的计数器溢出（>= 10000）——时钟停了？`)
      }
    }
    return `${String(this.lastPt).padStart(13, '0')}-${String(this.lastCounter).padStart(4, '0')}-${this.nodeId}`
  }
}
