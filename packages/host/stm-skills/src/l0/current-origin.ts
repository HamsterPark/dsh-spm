/**
 * 电流诊断两件：**这股电流是什么**（`ClassifyUnexplainedCurrent`）与
 * **放大器锁在满量程时把针尖退开**（`RecoverTipFromSaturation`）。
 *
 * 两个都**一次裸动词都不发** —— 全走 `ctx.runSkill`（`GetCurrent` / `GetBias` /
 * `GetZControllerState` / `ZControllerOnOff` / `SetBias` / `MotorMove` /
 * `WithdrawTip`，七个全已移）。判据本体在 `kernel/current-diag.ts`，
 * 这里只负责去问、按顺序摆、把答案拼成 `data`。
 *
 * ## 两条「顺序即判据」的线
 *
 * ### ① 先查饱和，再进判别表（`ClassifyUnexplainedCurrent`）
 *
 * 放大器满量程时**每个偏压读数都一样**，落进判别表就是「随偏压不变 ⇒ 串扰」——
 * **正好判反**。「读数不动」有两个原因：没有电流，或者量程满了。
 *
 * ### ② 先查锁，再撤针（`RecoverTipFromSaturation`）
 *
 * 2026-08-28 真机：撞针后连发降偏压、撤针，读数一动不动（10003.6 pA）。
 * 不是命令无效，是它们**根本没到仪器** —— `ScanAt` 还持有仪器锁 363 秒。
 * 「被挡在门外」与「发出去了但没效果」长得一模一样，而两者要做的事相反。
 * 所以第一步是用一次 `steps=0` 的 `MotorMove` 去**敲门**。
 *
 * ## 还原的对象是「进来时的样子」，不是「一般情况下该是的样子」
 *
 * `ClassifyUnexplainedCurrent` 要关反馈才能量 I(V)（反馈开着时 I(V) 描述的是反馈环
 * 不是结）。旧仓第一版在 `finally` 里无条件 `enable: True` —— 用户本来把反馈关着
 * （手动操作中／已退针）的话，它就替人开了，而开反馈会驱动 Z 去够 setpoint。
 * 所以**读不到初态就拒答**：猜错的代价是一根针尖。
 */
import {
  RECOVERED_A,
  RETRACT_LADDER,
  SAFE_BIAS_V,
  SATURATION_A,
  REPRODUCE_RATIO,
  classifyCurrentOrigin,
  effectiveExponent,
  formatG,
  isSaturated,
  noiseFloorFromZero,
  pyFloatOrThrow,
  pyFixed,
  pyReprStr,
  statisticsMedian,
  type BiasCurrentPoint,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'

/** 每次读电流之间的间隔（ms）。旧仓 `_median_current` 的 `time.sleep(0.05)`。 */
const READ_GAP_MS = 50

/** `_settled_current` 的间隔（ms）。 */
const SETTLE_GAP_MS = 200

/** 改完偏压等多久再读（ms）。旧仓 `_settle_s = 0.4`。 */
const BIAS_SETTLE_MS = 400

/** 退针之后等多久再读（ms）。旧仓 `_settle_s = 1.2`。 */
const RETRACT_SETTLE_MS = 1200

/** 一次子技能的 `data`，取不到给空表。 */
function dataOf(r: SkillResultLike): Record<string, unknown> {
  return (r.data ?? {}) as Record<string, unknown>
}

/** `run("GetCurrent").data["current_a"]`。取不到是 `null`。 */
async function readCurrent(ctx: SkillContext): Promise<number | null> {
  const r = await ctx.runSkill('GetCurrent', {})
  const v = dataOf(r)['current_a']
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 读 `n` 次取中位。**读不到的那几次不进中位**（不是当 0）。
 *
 * `gapMs` 两个调用点不同（50 ms / 200 ms），所以是参数。
 */
async function medianCurrent(
  ctx: SkillContext,
  n: number,
  gapMs: number,
): Promise<number | null> {
  const vals: number[] = []
  for (let k = 0; k < Math.max(1, n); k += 1) {
    const v = await readCurrent(ctx)
    if (v !== null) vals.push(v)
    await ctx.sleep(gapMs)
  }
  return statisticsMedian(vals)
}

export const ClassifyUnexplainedCurrent: Skill = {
  spec: S.ClassifyUnexplainedCurrentSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const rawParam = params['test_biases_v']
    const raw =
      rawParam === null || rawParam === undefined || rawParam === ''
        ? '2.0,1.0,0.5,0.0'
        : String(rawParam)
    let biases: number[]
    try {
      biases = raw
        .split(',')
        .filter((t) => t.trim() !== '')
        .map((t) => pyFloatOrThrow(t))
    } catch {
      return fail(`test_biases_v 解析不了：${pyReprStr(raw)} —— 要逗号分隔的数。`)
    }
    if (biases.length === 0) return fail('test_biases_v 是空的。')

    // **0 会被自动补上** —— 缺了它整个判别就立不住（0 V 那一点是唯一的判别点）。
    const zeroAdded = !biases.some((b) => Math.abs(b) < 1e-9)
    if (zeroAdded) biases.push(0.0)
    // 从大到小：结束时停在最小偏压上比停在最大偏压上安全。
    // `sort` 在 ES2019 起是**稳定**的，与 Python 的 `list.sort` 同 —— 等模长的两个
    // 偏压保持调用方给的先后，而那决定了最后停在哪一个上。
    biases.sort((a, b) => -Math.abs(a) - -Math.abs(b))

    const repeatsRaw = params['repeats']
    const repeats =
      typeof repeatsRaw === 'number' && Number.isFinite(repeatsRaw) && repeatsRaw !== 0
        ? Math.trunc(repeatsRaw)
        : 3
    const obsRaw = params['observed_current_a']
    const observed =
      typeof obsRaw === 'number' && Number.isFinite(obsRaw) ? obsRaw : null

    // ① 饱和先查。饱和会伪装成「随偏压不变」，判别表会判反。
    const first = await medianCurrent(ctx, repeats, READ_GAP_MS)
    if (isSaturated(first) === true) {
      return ok({
        verdict: 'amplifier_saturated',
        current_a: first,
        message:
          `电流 ${formatG(first as number, 4)} A 贴在量程端点 —— 放大器**饱和**，` +
          '读的是端点不是电流。偏压依赖判别对饱和读数无效' +
          '（每个偏压都会读到同一个数，看起来像「与偏压无关」）。' +
          '先跑 RecoverTipFromSaturation 把针尖退开。',
        next_skill: 'RecoverTipFromSaturation',
      })
    }

    // ② 记住工作点，**结束必须还原**
    const gb = await ctx.runSkill('GetBias', {})
    const bias0Raw = dataOf(gb)['bias_v']
    const bias0 = typeof bias0Raw === 'number' && Number.isFinite(bias0Raw) ? bias0Raw : null

    // ③ 先读**初态**，结束时还原成它 —— 不是还原成 True。读不到就拒答。
    const zstate = await ctx.runSkill('GetZControllerState', {})
    const fbRaw = dataOf(zstate)['controller_on']
    const fbWasOn = typeof fbRaw === 'boolean' ? fbRaw : null
    if (fbWasOn === null) {
      return fail(
        '读不到 Z 反馈的当前状态（ZCtrl_OnOffGet）—— **判不了**它进来时' +
          '是开还是关，也就无从还原。不做：万一用户本来关着反馈，' +
          '我结束时替他开回来会把 Z 驱向 setpoint。',
        { controller_on: null },
      )
    }

    // ④ 关反馈：开着的话 I(V) 描述的是反馈环不是结
    const zres = await ctx.runSkill('ZControllerOnOff', { enable: false })
    const zdata = dataOf(zres)
    const fbOff = zdata['verified'] === true && zdata['z_controller_on'] === false
    if (!fbOff) {
      return fail(
        `关不掉 Z 反馈（读回 ${pyRepr(zdata['z_controller_on'])}）—— **不在反馈开着的时候量 I(V)**：` +
          'Z 会去追 setpoint，量到的是反馈环的响应不是结的性质，' +
          '而它长得像一条很正常的曲线。',
        { z_controller_on: zdata['z_controller_on'] ?? null },
      )
    }

    const points: { bias_v: number; current_a: number | null; saturated: boolean | null }[] = []
    let restored = false
    try {
      for (const b of biases) {
        await ctx.runSkill('SetBias', { bias_v: b })
        await ctx.sleep(BIAS_SETTLE_MS)
        const i = await medianCurrent(ctx, repeats, READ_GAP_MS)
        points.push({ bias_v: b, current_a: i, saturated: isSaturated(i) })
      }
    } finally {
      // ⑤ 还原**进来时的样子** —— 无论成败。诊断把偏压留在 0 V 上比不做诊断更糟；
      //    而把反馈还原成写死的 True 比留在 0 V 更糟（见 ③）。
      if (bias0 !== null) await ctx.runSkill('SetBias', { bias_v: bias0 })
      await ctx.runSkill('ZControllerOnOff', { enable: fbWasOn })
      restored = true
    }

    const pairs: BiasCurrentPoint[] = points.map((p) => ({
      biasV: p.bias_v,
      currentA: p.current_a,
    }))
    const zeroPt = points.find((p) => Math.abs(p.bias_v) < 1e-9)
    const iZero = zeroPt === undefined ? null : zeroPt.current_a
    const nonzero = points.filter((p) => Math.abs(p.bias_v) > 1e-9 && p.current_a !== null)
    const iMax =
      nonzero.length === 0 ? null : Math.max(...nonzero.map((p) => Math.abs(p.current_a as number)))
    const floor = noiseFloorFromZero(iZero)
    const fit = effectiveExponent(pairs, floor)
    const origin = classifyCurrentOrigin(iZero, fit.exponent, iMax)

    const data: Record<string, unknown> = {
      verdict: origin.verdict as string,
      message: origin.message,
      points,
      exponent_n: fit.exponent,
      i_zero_a: iZero,
      i_max_a: iMax,
      noise_floor_a: floor,
      fit_points: fit.used.length,
      zero_bias_added: zeroAdded,
      bias_restored_to: bias0,
      feedback_restored: restored,
      feedback_was_on: fbWasOn,
    }

    // ⑥ 静态复现：串扰假设说的是「**动的时候**」，静态量不到它。
    if (observed !== null) {
      let sameBias: (typeof points)[number] | null = null
      if (bias0 !== null) {
        const candidates = points.filter((p) => p.current_a !== null)
        for (const c of candidates) {
          if (sameBias === null || Math.abs(c.bias_v - bias0) < Math.abs(sameBias.bias_v - bias0)) {
            sameBias = c
          }
        }
      }
      const staticA = sameBias === null ? null : Math.abs(sameBias.current_a as number)
      data['observed_current_a'] = observed
      data['static_at_same_bias_a'] = staticA
      if (staticA === null || Math.abs(observed) <= 0) {
        data['reproduced'] = null
      } else {
        const hi = Math.max(Math.abs(observed), staticA)
        const lo = Math.max(Math.min(Math.abs(observed), staticA), 1e-18)
        const ratio = hi / lo
        data['reproduce_ratio'] = ratio
        data['reproduced'] = ratio <= REPRODUCE_RATIO
        if (data['reproduced'] !== true) {
          data['verdict'] = 'transient'
          data['static_verdict'] = origin.verdict
          data['message'] =
            `静态复现不出来：被怀疑的读数 ${formatG(observed, 3)} A，同偏压静止时只有 ${formatG(staticA, 3)} A` +
            `（差 ${pyFixed(ratio, 0)} 倍）—— 这股电流**只在某件事发生时存在**` +
            '（压电运动、偏压斜坡、扫描）。静态 I(V) 判不了它，' +
            '**要在那个动作进行中重测**。这不是「没有」，是「没在这儿」。'
        }
      }
    }

    return ok(data)
  },
}

export const RecoverTipFromSaturation: Skill = {
  spec: S.RecoverTipFromSaturationSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // ⚠️ `or 800` 而不是 `?? 800`：旧仓写的是 `int(params.get(...) or 800)`，
    // 于是**显式的 0 也退回 800**。照移 —— 一个「一步粗动都不许走」的预算
    // 在旧仓表达不出来，而把它悄悄改成表达得出来，等于改了这个技能的行为。
    const budgetRaw = params['max_coarse_steps']
    const budget =
      typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) && budgetRaw !== 0
        ? Math.trunc(budgetRaw)
        : 800
    const safeBiasRaw = params['safe_bias_v']
    const safeBias =
      typeof safeBiasRaw === 'number' && Number.isFinite(safeBiasRaw) ? safeBiasRaw : SAFE_BIAS_V

    // ① 查锁。**不查就撤针 = 08-28 那次的形状。**
    const busy = await ctx.runSkill('MotorMove', { direction: 'z-retract', steps: 0 })
    const busyErr = busy.error ?? ''
    if (busyErr.includes('占用') || busyErr.toLowerCase().includes('busy')) {
      return fail(
        '仪器正被另一条链路占用，**撤针命令到不了仪器**：' +
          busyErr.slice(0, 200) +
          ' —— 先中止对方，否则「撤针了但读数没变」会被读成「撤针无效」，' +
          '而真相是它根本没发出去。',
        { blocked_by_lock: true },
      )
    }

    const before = await medianCurrent(ctx, 3, SETTLE_GAP_MS)
    const sat = isSaturated(before)
    const stepsLog: Record<string, unknown>[] = []
    if (sat === null) {
      return fail('读不到电流 —— **判不了**是否饱和。不当作已恢复：针尖可能还压在样品上。', {
        current_a: null,
      })
    }
    if (!sat) {
      return ok({
        outcome: 'not_saturated',
        current_a: before,
        saturation_a: SATURATION_A,
        steps: [],
        message: `电流 ${formatG(before as number, 4)} A 未贴量程端点 —— 没有饱和，**一步都没做**。`,
      })
    }

    // ② 降偏压：带着成像偏压时读数会被场发射污染
    await ctx.runSkill('SetBias', { bias_v: safeBias })
    await ctx.sleep(500)

    // ③ 压电退针（买 ~1 µm；撞进去之后常常不够）
    await ctx.runSkill('WithdrawTip', {})
    await ctx.sleep(RETRACT_SETTLE_MS)
    const afterPiezo = await medianCurrent(ctx, 3, SETTLE_GAP_MS)
    stepsLog.push({
      stage: 'piezo_withdraw',
      current_a: afterPiezo,
      saturated: isSaturated(afterPiezo),
    })
    if (isSaturated(afterPiezo) === false) {
      return ok({
        outcome: 'recovered',
        by: 'piezo_withdraw',
        current_before_a: before,
        current_after_a: afterPiezo,
        coarse_steps_used: 0,
        steps: stepsLog,
        message: '压电退针即脱离饱和，没有动粗动。',
      })
    }

    // ④ 粗动 Z 逐级退
    let used = 0
    for (const n of RETRACT_LADDER) {
      if (used + n > budget) break
      const res = await ctx.runSkill('MotorMove', { direction: 'z-retract', steps: Math.trunc(n) })
      const good = res.success === true
      await ctx.sleep(RETRACT_SETTLE_MS)
      const now = await medianCurrent(ctx, 3, SETTLE_GAP_MS)
      used += good ? n : 0
      stepsLog.push({
        stage: 'coarse_z',
        steps: n,
        ok: good,
        cumulative: used,
        current_a: now,
        saturated: isSaturated(now),
        error: (res.error ?? '').slice(0, 160),
      })
      if (!good) continue
      if (now !== null && Math.abs(now) <= RECOVERED_A) {
        return ok({
          outcome: 'recovered',
          by: 'coarse_z',
          current_before_a: before,
          current_after_a: now,
          coarse_steps_used: used,
          steps: stepsLog,
          message:
            `粗动 Z 退 ${used} 步后电流 ${formatG(now, 4)} A，脱离饱和。` +
            '**针尖已远离样品，要继续工作需重新进针。**',
        })
      }
    }

    const lastRec = stepsLog.length > 0 ? stepsLog[stepsLog.length - 1] : undefined
    const last = (lastRec === undefined ? before : (lastRec['current_a'] as number | null)) ?? null
    return fail(
      `退了 ${used} 步仍未脱离饱和（最后读数 ${last === null ? '读不到' : `${formatG(last, 4)} A`}）。` +
        '**没有假装恢复** —— 继续退之前先确认 z-retract 方向配置是对的：方向反了的话，' +
        '每一步都在往样品里扎。',
      {
        outcome: 'not_recovered',
        coarse_steps_used: used,
        steps: stepsLog,
        current_after_a: last,
      },
    )
  },
}

/** Python 的 `%r` 用在一个可能是 `None` / `bool` / 数的值上（那句「关不掉 Z 反馈」）。 */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'string') return pyReprStr(v)
  return String(v)
}

/** 这一族的登记表。 */
export const CURRENT_ORIGIN: Readonly<Record<string, Skill>> = {
  ClassifyUnexplainedCurrent,
  RecoverTipFromSaturation,
}
