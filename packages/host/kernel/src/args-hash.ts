/**
 * 工具参数的**稳定摘要**。
 *
 * ## 为什么需要它
 *
 * dsh 的审批请求（`ApprovalRequestEvent`）里**只有** `agent` / `toolName` / `callId` /
 * `reason` / `signal`——**看不到参数**（课时 0.6 spike 第 1 条的边界：拿得到参数的是
 * `tools/pre-execute` 的 `exec`，拿不到的是 `ctx.approval.request()`）。
 *
 * 而人要批准的是「**这一次、带这些参数的**调用」，不是「这个工具」。
 * 所以摘要要走 `reason`，并带一个短哈希，让审批卡与实际执行**能对上**：
 *
 * > **审批卡上的 `argsHash` 必须等于内核执行时算的那个；不等就拒。**
 *
 * 不这样的话，「批准一次 `MotorMove`」与「执行一次**别的参数的** `MotorMove`」
 * 在系统里长得一模一样。
 *
 * ## 为什么自己写而不是拿现成的哈希库
 *
 * 要的不是密码学强度，是**规范化**：同样的参数不管键序如何都必须给同一个哈希，
 * 而且这个规范化要与 Python 侧一致。一个库只解决后半个问题的一半。
 */

/**
 * 规范化 JSON：**键按 code unit 排序**，`undefined` 丢掉，非有限数写成 `null`。
 * 数组保持顺序（顺序是语义的一部分）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return 'null' // function / symbol / bigint —— 参数里不该有，出现就当没有
}

/**
 * FNV-1a 32 位。**不是**密码学哈希，也不需要是：它防的是「批准的和执行的不是同一件事」
 * 这种**意外**，不是有人蓄意伪造（那一侧由 dsh 的 `callId` 与会话日志负责）。
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 参数的短哈希：6 位十六进制。审批卡与内核各算一次，**不等就拒**。 */
export function argsHash(args: unknown): string {
  return fnv1a32(canonicalJson(args)).toString(16).padStart(8, '0').slice(0, 6)
}

/** 摘要里一个值的显示形式：太长就截断并标注，**不让一个长字符串把摘要挤爆**。 */
function brief(v: unknown, max = 24): string {
  if (typeof v === 'string') return v.length <= max ? `'${v}'` : `'${v.slice(0, max)}…'(${v.length}字)`
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v)
  if (Array.isArray(v)) return `[${v.length}项]`
  if (typeof v === 'object') return `{${Object.keys(v as object).length}键}`
  return String(v)
}

/**
 * 给人看的参数摘要 + 短哈希。
 *
 * 形如：`MotorMove(direction='z-approach', steps=10) args#3f9a1c`
 *
 * **键按字母序**，与哈希用的规范化一致——这样人读到的顺序与哈希算的顺序是同一个，
 * 对不上时能一眼看出是哪个参数不一样。
 */
export function approvalDigest(toolName: string, args: unknown, maxParams = 6): string {
  const obj =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {}
  const keys = Object.keys(obj).sort()
  const shown = keys.slice(0, maxParams).map((k) => `${k}=${brief(obj[k])}`)
  if (keys.length > maxParams) shown.push(`…另 ${keys.length - maxParams} 个`)
  return `${toolName}(${shown.join(', ')}) args#${argsHash(args)}`
}
