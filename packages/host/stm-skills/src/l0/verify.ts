/**
 * 问**实时控制器**：Z 反馈环闭着吗。
 *
 * 这是好几个技能共用的核心件，它的契约里有一条比实现更要紧：
 *
 * > **`on === null` 不是 `on === false`。**
 *
 * 一个「只有环开着才安全」的调用方，必须把「判断不出来」当成
 * **「假定它闭着」**——不安全的那一侧——然后拒绝。
 * 整件事的要点就在这里：**测量链自己失败，绝不能成为危险动作的触发条件。**
 * （同一条 fail-closed 规则救过 `TryEngageController` 一次：所有电流读取都失败时，
 * 它差点去建议一次盲目的粗进针。）
 *
 * 它**永不抛**——一个自己会炸的验证步骤不是安全网。
 */
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { bool, num } from './common.js'

const SETTLE_POLL_MS = 50
/** 仪器不肯说自己的延时时的预算。 */
const SETTLE_FALLBACK_MS = 500
/** 一个配错的延时不能把技能挂住。 */
const SETTLE_CEILING_MS = 10_000

export interface ZVerdict {
  /** `null` = **判断不出来**，不是「关着」。 */
  readonly on: boolean | null
  /** 这次读**成功了**吗。 */
  readonly verified: boolean
  /** `null` 表示没给 expect、或根本没读到。 */
  readonly matches: boolean | null
  readonly error: string | null
  readonly waitedMs: number
  readonly switchOffDelayS: number | null
  readonly moduleStatus: number | null
}

async function readOnOff(
  ctx: SkillContext,
): Promise<{ on: boolean | null; verified: boolean; error: string | null; rec: SkillCallRecord }> {
  const rec = await ctx.safeCall('ZCtrl_OnOffGet')
  if (rec.error !== undefined && rec.error !== '') {
    return { on: null, verified: false, error: rec.error, rec }
  }
  const v = bool(rec, 0)
  if (v === null) {
    return { on: null, verified: false, error: 'ZCtrl_OnOffGet returned nothing parseable', rec }
  }
  return { on: v, verified: true, error: null, rec }
}

/**
 * 当前控制器的切断延时（秒），读不到就是 `null`。
 *
 * **只用来给沉降预算定尺寸，绝不单独据它判断任何事。**
 */
async function switchOffDelayS(ctx: SkillContext): Promise<number | null> {
  const rec = await ctx.safeCall('ZCtrl_SwitchOffDelayGet')
  if (rec.error !== undefined && rec.error !== '') return null
  return num(rec, 0)
}

async function moduleStatus(ctx: SkillContext): Promise<number | null> {
  const rec = await ctx.safeCall('ZCtrl_StatusGet')
  if (rec.error !== undefined && rec.error !== '') return null
  const v = num(rec, 0)
  return v === null ? null : Math.trunc(v)
}

export interface VerifyOptions {
  /** 期望的状态。给了才会沉降轮询。 */
  readonly expect?: boolean | undefined
  /**
   * 第一次读与期望不符时**不要立刻下结论**，在仪器自己的切断延时预算内轮询。
   *
   * 缺省开着是有意的：一个忘了传这个参数的调用点应该拿到**安全的**行为，
   * 而不是掉回 2026-07 那个竞态里（读得太早，把「还在切」读成「没切成」）。
   */
  readonly settle?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

export async function verifyZController(
  ctx: SkillContext,
  opts: VerifyOptions = {},
): Promise<ZVerdict> {
  const settle = opts.settle ?? true
  const expect = opts.expect
  const t0 = ctx.now()

  let r = await readOnOff(ctx)
  let delay: number | null = null

  if (settle && expect !== undefined && (!r.verified || r.on !== expect)) {
    delay = await switchOffDelayS(ctx)
    const budget =
      opts.timeoutMs !== undefined
        ? opts.timeoutMs
        : delay !== null
          ? Math.min(delay * 1000 + 200, SETTLE_CEILING_MS)
          : SETTLE_FALLBACK_MS
    while (ctx.now() - t0 < budget) {
      // **中止只离开循环，不改变结论** —— 被取消绝不能被报成「已确认关闭」。
      if (ctx.signal.aborted) break
      await ctx.sleep(SETTLE_POLL_MS)
      r = await readOnOff(ctx)
      if (r.verified && r.on === expect) break
    }
  }

  const matches = expect === undefined || !r.verified ? null : r.on === expect
  return {
    on: r.on,
    verified: r.verified,
    matches,
    error: r.error,
    waitedMs: ctx.now() - t0,
    switchOffDelayS: delay,
    // 只在**不符**时才去问模块状态：符了就没有可解释的分歧
    moduleStatus: matches === true ? null : await moduleStatus(ctx),
  }
}
