/**
 * `TipShape` —— 跑硬件的 tip shaper 流程（受控修针）。
 *
 * 与批 3j 的 `TipShapeWithReadback` 是**孪生兄弟**：下发的是**同一串**
 * `TipShaper_PropsSet`（11 参）+ `TipShaper_Start`，差别只在 `wait`（这边 1，那边 0，
 * 因为那一个要边跑边采）。所以这一个是照那条已经走过的线落的。
 *
 * ## 三件事写在这里，因为它们各自都被真机推翻过一次
 *
 * ① **`bias_v` 的缺省是「此刻的成像偏压」，不是写死的 3 V**（2026-08-10 现场）。
 * 顺序是 `applyTipPolicy` **在前**、读偏压在后：方案表若给了 `shaper_bias_v`
 * （钨 4.0、铂铱 2.5…），那是一个**有主的、写了理由的**值，照旧胜出；表里没有才去读。
 * 读不到就**拒绝**，不回落到 3.0。
 *
 * ② **`bias_lift_v` 是无条件施加的**。厂商同一句话里一个带条件一个不带：
 * 「Bias (V) … **if Change Bias is True**」/「Bias Lift (V) … applied **just after the
 * first Z ramping**」。所以 `change_bias=false` **不等于不加电**。回包里两个都写，
 * 因为以前只写 `bias_v`，于是「我关掉了 change_bias」的调用方看着一份没有电压的回执，
 * 而针尖上刚刚过了 3 V。
 *
 * ③ **针尖安全包络在动手之前判**（D-TIP-1）。旧仓把它放在 `execute` 的最前面而不是
 * `validate_params`，这一个照移 —— 它的两个策略字段（`shaper_bias_v` / `shaper_lift_v`）
 * 要先经过「方案表填不填」这一步才知道最终值是多少，而 `validate_params` 拿不到
 * 那一步的结果。**两个读回技能那边不同**：它们的量是调用方直接给的，所以装在 K6。
 *
 * ## 没有移植：`module_down_hint`
 *
 * 旧仓在这两条错误路径上给报文追一句「去 Nanonis 里打开 Tip Shaper 模块」，判据是
 * 错误文本里有没有 `not running` / `未运行` 那一族子串。`TipShapeWithReadback`（批 3j）
 * 已经**没有**移它，这一个跟着它走 —— 两个下发同一串命令的技能不该一个有一个没有。
 * 整条 `_preflight.py`（探针表 + `_DOWN_SIGNATURES` + `_AMBIGUOUS` + `preflight_modules`）
 * 是批 5c 的事，缺件与行数写在交接里。
 */
import {
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'
import { applyTipPolicy, policyFieldsForResult, resolvedLiftHeightM, shaperBiasDefault } from './tip-policy.js'
import { tipXyFields } from './tip-xy.js'

const num = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const flag = (p: Readonly<Record<string, unknown>>, k: string, dflt: boolean): boolean =>
  p[k] === undefined || p[k] === null ? dflt : Boolean(p[k])

export const TipShape: Skill = {
  spec: S.TipShapeSpec,
  execute: async (ctx: SkillContext, rawParams): Promise<SkillResultLike> => {
    // ── 0) 方案表 + 安全包络 ────────────────────────────────────────────────
    const biasBeforePolicy = rawParams['bias_v']
    const { params, plan } = applyTipPolicy(rawParams, ['shaper_bias_v', 'shaper_lift_v'], {
      shaper_bias_v: 'bias_v',
      shaper_lift_v: 'bias_lift_v',
    })
    // **超上限拒绝，不夹紧。** 夹紧会把一次「这支针尖不能这么打」悄悄变成一次
    // 「按你能承受的最大值打」—— 而调用方看到的是成功。
    if (!plan.ok) return fail(plan.refusals.join('；'))

    // ── 1) bias 缺省 = 此刻的成像偏压 ───────────────────────────────────────
    let biasV = typeof params['bias_v'] === 'number' ? (params['bias_v'] as number) : null
    let biasSrc = biasBeforePolicy !== undefined && biasBeforePolicy !== null ? 'explicit' : 'policy'
    if (biasV === null) {
      const read = await shaperBiasDefault(ctx)
      biasSrc = 'read'
      if (read.v === null) {
        return fail(
          `读不到当前偏压(${read.why}),而 bias_v 既没有显式给出、方案表也没有 —— ` +
            '拒绝用写死的 3 V 代替。',
        )
      }
      biasV = read.v
    }
    const biasLiftV = typeof params['bias_lift_v'] === 'number' ? (params['bias_lift_v'] as number) : biasV

    // 这一下扎在**哪里**，现在读，不要事后重建：修针留下的是永久的坑与碎屑场，
    // 扫描地图的避让模型要知道它的中心到几个纳米；而 `restore_feedback` 之后针尖
    // 可能已经不在这儿了。尽力而为 —— 读不到就什么都不报（`tipXyFields` 给空对象）。
    const spot = await tipXyFields(ctx)

    // TipShaper_PropsSet(Switch_Off_Delay, Change_Bias, Bias_V, Tip_Lift_m,
    //   Lift_Time_1_s, Bias_Lift_V, Bias_Settling_Time_s, Lift_Height_m,
    //   Lift_Time_2_s, End_Wait_Time_s, Restore_Feedback)
    // Change_Bias / Restore_Feedback: 0=no change, 1=True, 2=False
    //
    // `change_bias` 缺省 **false**（2026-08-11）：工作流层自己拒绝走这条路 ——
    // 「TipShaper 的 change-bias 只能**阶跃**改偏压…那一次阶跃本身就是一记冲量」。
    // 裸技能的默认不该与那条判断相反。
    const changeBias = flag(params, 'change_bias', false) ? 1 : 2
    const restoreFb = flag(params, 'restore_feedback', true) ? 1 : 2
    const liftHeightM = resolvedLiftHeightM(params)
    const recProps = await ctx.safeCall(
      'TipShaper_PropsSet',
      num(params, 'switch_off_delay_s', 0.1),
      changeBias,
      biasV,
      num(params, 'tip_lift_m', 0.0),
      num(params, 'lift_time_1_s', 0.1),
      biasLiftV,
      num(params, 'bias_settling_s', 0.1),
      liftHeightM,
      num(params, 'lift_time_2_s', 0.1),
      num(params, 'end_wait_s', 0.1),
      restoreFb,
    )
    if (recProps.error !== undefined && recProps.error !== '') return fail(recProps.error)

    // TipShaper_Start(Wait_until_finished, Timeout_ms)。这一个**等它跑完**（wait=1）。
    const recStart = await ctx.safeCall('TipShaper_Start', 1, Math.trunc(num(params, 'timeout_ms', -1)))
    if (recStart.error !== undefined && recStart.error !== '') return fail(recStart.error)

    return ok({
      bias_v: biasV,
      bias_v_source: biasSrc,
      bias_lift_v: biasLiftV,
      change_bias: changeBias === 1,
      lift_height_m: liftHeightM,
      completed: true,
      ...spot,
      ...policyFieldsForResult(plan),
    })
  },
}
