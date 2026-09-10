/**
 * `tipParked` 的**读那一半** —— 判据在 `dsh-spm-kernel/tip-park.ts`，这里只负责读。
 *
 * 读五条（全部是 GET）：`ZCtrl_OnOffGet`（经 `verifyZController`，连带
 * `ZCtrl_StatusGet`）、`ZCtrl_ZPosGet`、`Piezo_RangeGet`、`ZCtrl_LimitsGet`、
 * `ZCtrl_LimitsEnabledGet`；再加一条本地配置 `zExtendSign`。
 *
 * **不走状态缓存。** 那份缓存有「读失败时沿用旧值」的语义，拿它做退针确认
 * 会用一份几秒前的读数说「已经退到了」。
 *
 * **永不抛异常。** 一个自己会炸的确认步骤不是安全网 —— 任何读失败都变成
 * `unreadable` 里的一项，结论是 `unreadable`，而不是一个看起来正常的判断。
 */
import {
  MODULE_STATUS,
  parkVerdictFromReadings,
  resolveZTravel,
  type ParkVerdict,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { body, num } from './common.js'
import { verifyZController } from './verify.js'

/** 本机 Z 压电伸长的方向符号。**没声明过就是 `null`，不许拿出厂值顶替。** */
export interface TipParkOptions {
  readonly zExtendSign?: number | null | undefined
}

export async function tipParked(
  ctx: SkillContext,
  opts: TipParkOptions = {},
): Promise<ParkVerdict> {
  const readAt = Date.now() / 1000
  const unreadable: string[] = []

  let feedbackOn: boolean | null = null
  let moduleStatus: string | null = null
  try {
    // `settle: false` —— 这是一次**单次读**，不长等。轮询由调用方按自己的预算做。
    const v = await verifyZController(ctx, { settle: false })
    feedbackOn = v.on
    if (!v.verified) unreadable.push('feedback_on')
    if (v.moduleStatus !== null) {
      moduleStatus = MODULE_STATUS[v.moduleStatus] ?? `Unknown(${v.moduleStatus})`
    }
  } catch {
    unreadable.push('feedback_on')
  }

  /** 读一条，取头 n 个数；任何失败都记进 `unreadable` 并返回 `null`。 */
  const read = async (key: string, verb: string, n: number): Promise<number[] | null> => {
    let rec: SkillCallRecord
    try {
      rec = await ctx.safeCall(verb)
    } catch {
      unreadable.push(key)
      return null
    }
    if (rec.error !== undefined && rec.error !== '') {
      unreadable.push(key)
      return null
    }
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const v = num(rec, i)
      if (v === null) {
        unreadable.push(key)
        return null
      }
      out.push(v)
    }
    return body(rec).length >= n ? out : (unreadable.push(key), null)
  }

  const zVals = await read('z_m', 'ZCtrl_ZPosGet', 1)
  const piezo = await read('piezo_range', 'Piezo_RangeGet', 3)
  const zlim = await read('z_limits', 'ZCtrl_LimitsGet', 2)
  const zen = await read('z_limits_enabled', 'ZCtrl_LimitsEnabledGet', 1)

  const travel = resolveZTravel({
    piezoZFullM: piezo?.[2] ?? null,
    zLimitsM: zlim,
    // `null`（没问到）**按未启用处理** —— 不知道软限启没启用时拿它当边界就是猜。
    zLimitsEnabled: zen === null ? null : zen[0] !== 0,
  })

  // 行程算出来了，那三条各自的读失败就**不是缺口了**（一条读到就够）。
  if (travel !== null) {
    for (const key of ['piezo_range', 'z_limits', 'z_limits_enabled']) {
      let i = unreadable.indexOf(key)
      while (i >= 0) {
        unreadable.splice(i, 1)
        i = unreadable.indexOf(key)
      }
    }
  }

  return parkVerdictFromReadings({
    feedbackOn,
    moduleStatus,
    zM: zVals?.[0] ?? null,
    travel,
    zExtendSign: opts.zExtendSign ?? null,
    unreadable,
    readAt,
  })
}
