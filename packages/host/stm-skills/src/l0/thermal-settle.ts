/**
 * `WaitForThermalSettle` —— 等温度**不再变**，而不是等它低于某个数。
 *
 * ## 为什么判据是速率不是绝对值（2026-08-27 换样品实测）
 *
 * ```
 * +  0 s  36.646 K      +301 s   5.331 K   -1.08 K/min
 * + 12 s  35.669 K      +401 s   4.493 K   -0.59 K/min
 * + 24 s  34.447 K      +502 s   4.363 K   -0.11 K/min
 * + 85 s  28.582 K      +577 s   4.349 K   -0.02 K/min   ← 到这里才算稳
 * ```
 *
 * **5.0 K 那一刻早就「低于 6 K」了，但当时还在以 1 K/min 下降。** 判据只写
 * `T < 5 K` 会让人在 +301 s 就开工，而真正稳是在 +577 s —— 差的这四分半，
 * 正是所有测量都不作数的四分半（Z 在漂、结阻在变、势垒读数带着趋势）。
 *
 * 指数逼近还有一条：温度会长时间停在离目标不远处慢慢挪。只等绝对值的话，
 * 要么等不到（目标定得太死），要么等早了（目标定得松）。速率判据两边都躲开。
 *
 * ## 它不做的事
 *
 * 不控温、不碰加热器、**一次裸动词都不发** —— 只 `ctx.runSkill('GetTemperature')`
 * 并等。读不到温度就**如实说读不到**，不假装稳定：`_MAX_MISSES` 那一条是这个技能
 * 唯一的安全论证（「每次读不到都当稳了」是最危险的降级）。
 */
import {
  pyFixed,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { polyfit } from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'

/** 默认「算稳了」的速率（K/min）。08-27 实测：到 −0.02 K/min 时 Z 与结阻都不再跟着走。 */
export const DEFAULT_RATE_K_PER_MIN = 0.03

/** 拟合速率至少要几个采样点 —— **两点连线算出来的「速率」全是噪声**。 */
export const MIN_SAMPLES = 5

/** 连续读不到温度多少次就放弃。 */
export const MAX_MISSES = 5

/** 轮询间隔（ms）。旧仓 `_poll_s = 25.0` 是类属性，本仓是模块常量（测试里由假钟接管）。 */
export const POLL_MS = 25_000

/** 一次采样：`(相对 t0 的秒, 温度 K)`。 */
export type ThermalSample = readonly [number, number]

/**
 * 对 `(t_s, T_K)` 线性拟合，返回 **K/min**。点不够返回 `null`（**不是 0**）。
 *
 * ## 容差：`lstsqObservedTol(κ)`，κ 随金样录
 *
 * 旧仓是 `np.polyfit(t, T, 1)[0] * 60`。numpy 的 `polyfit` 走 **SVD** 最小二乘
 * （误差 `~κ·eps`），本仓 `polyfit` 走**列缩放后的正规方程**（误差 `~κ²·eps`，
 * 而缩放把 κ 压回 1 附近）——两条不同的路，所以**不给 0**。
 *
 * 界取 `lstsqObservedTol`（`numerics/fit.ts` 那一条实测收紧过的界）而不是
 * `lstsqRelTol`：这里的设计阵只有两列（`[t, 1]`，t 已被 `polyfit` 内部按列范数
 * 缩放），κ 在 1.x–3 量级，两条界差不了几倍，取紧的那一条。
 *
 * ⚠️ **`× 60` 放在最后**，不是把 t 先换成分钟：前者一次乘法，后者要先除 n 次。
 * 旧仓就是前者，而这条容差是按「一次最小二乘 + 一次乘法」推的。
 */
export function rateKPerMin(samples: readonly ThermalSample[]): number | null {
  const pts = samples.filter((s) => s[1] !== null && Number.isFinite(s[1]))
  if (pts.length < MIN_SAMPLES) return null
  const t0 = (pts[0] as ThermalSample)[0]
  const tn = (pts[pts.length - 1] as ThermalSample)[0]
  if (tn - t0 <= 0) return null
  const coef = polyfit(
    pts.map((p) => p[0]),
    pts.map((p) => p[1]),
    1,
  )
  // `polyfit` 回**高次在前**，所以斜率是第 0 个。
  return (coef[0] as number) * 60.0
}

/** Python 的 `"%+.3f"`：**正数也带号**。那个 `+` 是判据的一部分（升温还是降温）。 */
function signed3(v: number): string {
  const s = pyFixed(v, 3)
  return s.startsWith('-') ? s : `+${s}`
}

/** Python 的 `float(x) if x is not None else None`，只认数。 */
function optNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Python 的 `float(params.get(k) or dflt)` —— **`0` 也退回缺省**（照移）。 */
function orNum(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : dflt
}

export const WaitForThermalSettle: Skill = {
  spec: S.WaitForThermalSettleSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const maxRate = Math.abs(orNum(params['max_rate_k_per_min'], DEFAULT_RATE_K_PER_MIN))
    const maxTemp = optNum(params['max_temp_k'])
    const budgetS = orNum(params['timeout_s'], 3600.0)
    const window = Math.max(MIN_SAMPLES, Math.trunc(orNum(params['window'], 6)))

    const t0 = ctx.now()
    let samples: ThermalSample[] = []
    let misses = 0
    while ((ctx.now() - t0) / 1000 < budgetS) {
      const res = await ctx.runSkill('GetTemperature', {})
      const val = optNum(((res.data ?? {}) as Record<string, unknown>)['value_k'])
      if (val === null) {
        misses += 1
        if (misses >= MAX_MISSES) {
          return fail(
            `连续 ${misses} 次读不到温度 —— **不当成「稳了」**。` +
              '读不到与稳定是两件事，把前者当后者会让调用方' +
              '在未知热状态下开工。',
            { samples: samples.map((s) => [s[0], s[1]]), misses },
          )
        }
      } else {
        misses = 0
        samples.push([(ctx.now() - t0) / 1000, val])
        // 滑动窗口：只用最近 `window` 点拟合 —— 一条穿过整段降温史的直线
        // 说的是「平均降了多快」，而这里要问的是「**现在**还在不在降」。
        samples = samples.slice(-window)
        const rate = rateKPerMin(samples)
        if (rate !== null) {
          // 两条**并且**：温度够低（没给就不管）**且**速率够小。
          const tempOk = maxTemp === null || val <= maxTemp
          if (tempOk && Math.abs(rate) <= maxRate) {
            return ok({
              settled: true,
              temperature_k: val,
              rate_k_per_min: rate,
              elapsed_s: (ctx.now() - t0) / 1000,
              n_samples: samples.length,
              max_rate_k_per_min: maxRate,
              max_temp_k: maxTemp,
              message: `${pyFixed(val, 3)} K，速率 ${signed3(rate)} K/min —— 稳了，可以开工。`,
            })
          }
        }
      }
      await ctx.sleep(POLL_MS)
    }

    const last = samples.length > 0 ? (samples[samples.length - 1] as ThermalSample)[1] : null
    const rate = rateKPerMin(samples)
    return fail(
      `等了 ${pyFixed(budgetS / 60.0, 0)} min 仍未稳：${last === null ? '读不到温度' : `${pyFixed(last, 3)} K`}，` +
        `速率 ${rate === null ? '算不出' : `${signed3(rate)} K/min`}。**没有假装成功** —— ` +
        '在这个状态下开工，读到的东西会跟着温度走。',
      {
        settled: false,
        temperature_k: last,
        rate_k_per_min: rate,
        elapsed_s: (ctx.now() - t0) / 1000,
        n_samples: samples.length,
      },
    )
  },
}

/** 这一族的登记表（就一个）。 */
export const THERMAL_SETTLE: Readonly<Record<string, Skill>> = { WaitForThermalSettle }
