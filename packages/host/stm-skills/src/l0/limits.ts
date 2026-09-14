/**
 * 安全边界**本身**：Z 限值、压电电压限值、退针速率、SafeTip。
 *
 * 本仓整个安全论证是「Nanonis 把它框住了」——偏压量程、压电量程、Z 限值、
 * SafeTip 阈值。那条论证正是 `TipShape`（一个**故意**把针尖开进表面的技能）
 * 只被判成 AUTO 的理由。
 *
 * 而旧仓 2026-07-13 的一次清点发现：这些界**每一条都读得到、一条都设不了**。
 *
 * | 读 | 写 |
 * |---|---|
 * | `ZCtrl_LimitsGet` ✓ | `ZCtrl_LimitsSet` ✗ |
 * | `ZCtrl_WithdrawRateGet` ✓ | `ZCtrl_WithdrawRateSet` ✗ |
 * | `Piezo_XYZLimitsGet` ✓ | `Piezo_XYZLimitsSet` ✗ |
 * | `SafeTip_PropsGet` ✓ | `SafeTip_PropsSet` ✗ |
 * | `ZCtrl_HomePropsGet` ✓ | `ZCtrl_Home` ✗（看得见 home，去不了） |
 *
 * 于是智能体看得出针尖保护的阈值对这根针尖是错的，却改不了；看得出 Z 限值是按
 * 另一块样品高度配的，却纠正不了。
 *
 * ## 把护栏放宽
 *
 * **一个能放宽自己限值的智能体，严格地说就是没有限值。** 但操作员已经在用户输出上
 * 裁决过一次同类问题：那里**物理层才是真屏障**（接线、放大器、接什么）。
 * 那条理由对一个用户输出成立，对 **Z 压电不成立**：没有任何接线能拦住压电把针尖撞进去。
 *
 * 所以这一族不是禁止，而是：CONFIRM 闸 + **每一次改动都连同改前/改后的值与一个显式的
 * `widened` 标志留痕**。放宽是合法的、看得见的、有归属的。**唯一不许的是「悄悄地」。**
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { scalarFloat } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, cell, fail, formatG6, ok, pyExp } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt

/**
 * 回包里的前 n 个数，**扁平地**取（body 可能是 `[a, b]`，也可能嵌一层）。
 * 数不够就给 `null` —— 半份限值比没有限值更危险。
 */
export function floatsOf(rec: SkillCallRecord, n: number): number[] | null {
  const out: number[] = []
  const walk = (v: unknown): void => {
    if (out.length >= n) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (typeof v === 'boolean') return
    const s = scalarFloat(v)
    if (s !== null) out.push(s)
  }
  walk([...body(rec)])
  return out.length >= n ? out.slice(0, n) : null
}

/** `decode_reply` 的等价物：body 只有一个元素就解一层，否则原样。读不到给 `null`。 */


/**
 * 限值**当前启用着吗**。三态：读到 `true` / 读到 `false` / **读不到 `null`**。
 *
 * 提成一个**有声明返回类型**的函数，而不是写在 `if` 里：
 * 写在里面的话，`enabledNow` 的流类型会被那一支收窄成 `true | null`，
 * 于是后面那句 `enabledNow === false` 变成一条「两个类型没有交集」的编译错 ——
 * 而一条编不过的变异什么都没验（本仓第十一次撞上这个形状）。
 */
function readEnabled(rec: SkillCallRecord): boolean | null {
  if (failed(rec)) return null
  const flags = floatsOf(rec, 1)
  return flags === null ? null : flags[0] !== 0
}

export const SetZLimits: Skill = {
  spec: S.SetZLimitsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const hi = f(params, 'z_high_limit_m')
    const lo = f(params, 'z_low_limit_m')

    const cur = await ctx.safeCall('ZCtrl_LimitsGet')
    const before = failed(cur) ? null : floatsOf(cur, 2)

    const rec = await ctx.safeCall('ZCtrl_LimitsSet', hi, lo)
    if (failed(rec)) return fail(`ZCtrl_LimitsSet failed: ${rec.error ?? ''}`)

    const widened = before === null ? null : hi > (before[0] as number) || lo < (before[1] as number)

    const wantEnable = params['enable'] !== false
    if (wantEnable) {
      const recEn = await ctx.safeCall('ZCtrl_LimitsEnabledSet', 1)
      if (failed(recEn)) {
        return fail(
          `限值已写入但**未能启用**（ZCtrl_LimitsEnabledSet 失败：${recEn.error ?? ''}）` +
            '——未启用的限值不起任何作用',
        )
      }
    }

    // `enable=false` 是一个合法的请求，而它原先会为一次**什么都没做**的写入报一句
    // 欢快的成功。Nanonis 自己的原文就是「限值未启用时本函数无任何作用」——
    // 把这句话写在散文里而不写进**结果**里，正是调用方最后相信一条收紧的限值
    // 在保护他的那条路。**读回来，不要推断**。
    // 刻意**不**自动启用：调用方说了 `enable=false`，而悄悄做相反的事是它自己的 bug。
    let enabledNow: boolean | null = wantEnable ? true : null
    if (!wantEnable) {
      enabledNow = readEnabled(await ctx.safeCall('ZCtrl_LimitsEnabledGet'))
    }

    // 读回来。**这个文件的全部意义。**
    const after = await ctx.safeCall('ZCtrl_LimitsGet')
    const actual = failed(after) ? null : floatsOf(after, 2)

    ctx.markers.emit('note', {
      subject: 'SetZLimits',
      reason: `Z 位置限值被修改${widened === true ? '（放宽）' : ''}`,
      before,
      requested: [hi, lo],
      after: actual,
      widened,
      enabled: wantEnable,
      enabled_now: enabledNow,
    })

    if (
      actual !== null &&
      (Math.abs((actual[0] as number) - hi) > 1e-12 || Math.abs((actual[1] as number) - lo) > 1e-12)
    ) {
      return fail(
        `Z 限值未按要求生效：要求 [${pyExp(lo, 3)}, ${pyExp(hi, 3)}] m，` +
          `读回 [${pyExp(actual[1] as number, 3)}, ${pyExp(actual[0] as number, 3)}] m`,
        { requested: [lo, hi], actual: [actual[1], actual[0]] },
      )
    }

    const inert =
      enabledNow === false
        ? '；⚠ **限值当前未启用（z_limits_enabled = 0），这对数字不起任何作用** —— ' +
          '要让它生效请以 enable=true 重新调用'
        : enabledNow === null && !wantEnable
          ? '；⚠ 未能读回启用状态，无法确认这对限值是否真的在生效'
          : ''

    return ok(
      {
        z_low_limit_m: lo,
        z_high_limit_m: hi,
        before,
        widened,
        verified: actual !== null,
        enabled: enabledNow,
      },
      `Z 限值 = [${pyExp(lo, 3)}, ${pyExp(hi, 3)}] m` +
        (widened === true ? '（**已放宽**，已记入诊断台账）' : '') +
        (actual !== null ? '' : '（未能读回确认）') +
        inert,
    )
  },
}

export const SetWithdrawRate: Skill = {
  spec: S.SetWithdrawRateSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const rate = f(params, 'rate_m_per_s')

    const cur = await ctx.safeCall('ZCtrl_WithdrawRateGet')
    const before = failed(cur) ? null : floatsOf(cur, 1)

    const rec = await ctx.safeCall('ZCtrl_WithdrawRateSet', rate)
    if (failed(rec)) return fail(`ZCtrl_WithdrawRateSet failed: ${rec.error ?? ''}`)

    const after = await ctx.safeCall('ZCtrl_WithdrawRateGet')
    const actual = failed(after) ? null : floatsOf(after, 1)

    ctx.markers.emit('note', {
      subject: 'SetWithdrawRate',
      reason: '退针速率被修改',
      before: before === null ? null : before[0],
      requested: rate,
      after: actual === null ? null : actual[0],
    })

    return ok(
      {
        rate_m_per_s: actual === null ? rate : actual[0],
        before: before === null ? null : before[0],
        verified: actual !== null,
      },
      `退针速率 = ${pyExp(rate, 3)} m/s`,
    )
  },
}

export const HomeZController: Skill = {
  spec: S.HomeZControllerSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const home = await ctx.safeCall('ZCtrl_HomePropsGet')
    const rec = await ctx.safeCall('ZCtrl_Home')
    if (failed(rec)) return fail(`ZCtrl_Home failed: ${rec.error ?? ''}`)
    const pos = await ctx.safeCall('ZCtrl_ZPosGet')
    const z = failed(pos) ? null : floatsOf(pos, 1)
    return ok(
      { home_props: cell(home), z_m: z === null ? null : z[0] },
      z === null ? 'Z 已回到 home' : `Z 已回到 home（当前 Z = ${pyExp(z[0] as number, 3)} m）`,
    )
  },
}

export const SetActiveZController: Skill = {
  spec: S.SetActiveZControllerSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const idx = Math.trunc(f(params, 'controller_index'))
    const rec = await ctx.safeCall('ZCtrl_ActiveCtrlSet', idx)
    if (failed(rec)) return fail(`ZCtrl_ActiveCtrlSet failed: ${rec.error ?? ''}`)
    ctx.markers.emit('note', {
      subject: 'SetActiveZController',
      reason: '活动 Z 控制器被切换',
      controller_index: idx,
    })
    return ok({ controller_index: idx }, `活动 Z 控制器 = ${idx}`)
  },
}

export const SetPiezoLimits: Skill = {
  spec: S.SetPiezoLimitsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const axes: Record<string, [number, number]> = {}
    for (const ax of ['x', 'y', 'z'] as const) {
      const lo = f(params, `${ax}_low_v`)
      const hi = f(params, `${ax}_high_v`)
      // **拒，不换过来**：一对反过来的电压界多半是调用方把两个数搞混了，
      // 而这是压电退极化与针尖之间的那道界 —— 猜错的代价是永久的。
      if (lo >= hi) {
        return fail(`${ax}_low_v (${formatG6(lo)} V) 必须小于 ${ax}_high_v (${formatG6(hi)} V)`)
      }
      axes[ax] = [lo, hi]
    }

    const cur = await ctx.safeCall('Piezo_XYZLimitsGet')
    const before = failed(cur) ? null : floatsOf(cur, 6)

    // Piezo_XYZLimitsSet(Enable_limits, X_low, X_high, Y_low, Y_high, Z_low, Z_high)
    const rec = await ctx.safeCall(
      'Piezo_XYZLimitsSet',
      params['enable'] !== false ? 1 : 0,
      axes['x']![0], axes['x']![1],
      axes['y']![0], axes['y']![1],
      axes['z']![0], axes['z']![1],
    )
    if (failed(rec)) return fail(`Piezo_XYZLimitsSet failed: ${rec.error ?? ''}`)

    const after = await ctx.safeCall('Piezo_XYZLimitsGet')
    const actual = failed(after) ? null : floatsOf(after, 6)

    let widened: boolean | null = null
    if (before !== null) {
      // before 是 [x_low, x_high, y_low, y_high, z_low, z_high]（Nanonis 的顺序）
      const next = [
        axes['x']![0], axes['x']![1],
        axes['y']![0], axes['y']![1],
        axes['z']![0], axes['z']![1],
      ]
      widened =
        [0, 2, 4].some((i) => (next[i] as number) < (before[i] as number)) ||
        [1, 3, 5].some((i) => (next[i] as number) > (before[i] as number))
    }

    ctx.markers.emit('note', {
      subject: 'SetPiezoLimits',
      reason: `压电电压限值被修改${widened === true ? '（放宽）' : ''}`,
      before,
      after: actual,
      widened,
      enabled: params['enable'] !== false,
    })

    return ok(
      {
        limits_v: { x: [...axes['x']!], y: [...axes['y']!], z: [...axes['z']!] },
        before,
        widened,
        verified: actual !== null,
      },
      `压电电压限值已设置${widened === true ? '（**已放宽**，已记入诊断台账）' : ''}`,
    )
  },
}

export const SetSafeTipProps: Skill = {
  spec: S.SetSafeTipPropsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const cur = await ctx.safeCall('SafeTip_PropsGet')
    const before = cell(cur)

    const thr = f(params, 'threshold')
    const recovery = params['auto_recovery'] !== false
    const pause = params['auto_pause_scan'] !== false
    const rec = await ctx.safeCall('SafeTip_PropsSet', recovery ? 1 : 0, pause ? 1 : 0, thr)
    if (failed(rec)) return fail(`SafeTip_PropsSet failed: ${rec.error ?? ''}`)

    const after = await ctx.safeCall('SafeTip_PropsGet')
    const actual = cell(after)

    ctx.markers.emit('note', {
      subject: 'SetSafeTipProps',
      reason: '针尖保护(SafeTip)配置被修改',
      threshold: thr,
      auto_recovery: recovery,
      auto_pause_scan: pause,
    })

    return ok(
      {
        threshold: thr,
        auto_recovery: recovery,
        auto_pause_scan: pause,
        before,
        verified: actual !== null,
      },
      `SafeTip 阈值 = ${formatG6(thr)}`,
    )
  },
}

export const LIMITS: Readonly<Record<string, Skill>> = {
  SetZLimits,
  SetWithdrawRate,
  HomeZController,
  SetActiveZController,
  SetPiezoLimits,
  SetSafeTipProps,
}
