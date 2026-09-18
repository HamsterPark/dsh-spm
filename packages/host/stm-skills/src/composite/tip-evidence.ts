/**
 * 针尖在干什么 —— 三个独立证人里的**振幅**那一路（旧仓 `skills/builtins/_tip_evidence.py`）。
 *
 * 判据在内核（`qplus-amplitude.ts` 判塌、`tip-evidence.ts` 判恢复）。这里只去问。
 *
 * ## 两条规则贯穿下面每一个函数
 *
 * **「判不了」永远不是「没事」。** 每个 helper 要么给 `{}`，要么给一个明说读失败的
 * `status`。**一道失败模式长得像成功的探测器，比没有探测器更坏**，因为它被信任。
 *
 * **只做加法。** 这里没有任何东西能推翻基于电流的检查。电流那几条保留它们的判决，
 * 这些只是第二意见。一台没有 qPlus 的 STM 上整条振幅通道根本不存在，
 * 那是正常配置，不是故障。
 *
 * ## 为什么这几个证人**不走内核**
 *
 * `qplusFields` / `qplusRecovered` 直接 `execute` 那两个只读技能，而不是走
 * `ctx.runSkill`（D-KERNEL-1 那条是给**计划步**的）。理由与旧仓一致：它们是
 * **证人**，不是步骤 —— 它们在 `_panic` 之后、在移动的每一块之间被问到，
 * 而那些时刻不该在台账上多出一串子技能调用链。
 * 这是本仓 `qplus.ts` 自己就在用的形状（`CheckTipCrashByAmplitude` 内部正是这么调
 * `ReadTipOscillationAmplitude` 的）。
 */
import { qplusRecoveredVerdict, type RecoveredVerdict, type SkillContext } from 'dsh-spm-kernel'
import { CheckTipCrashByAmplitude, ReadTipOscillationAmplitude, processQPlusBaseline } from '../l0/qplus.js'

/**
 * qPlus 判决，拼成可以直接摊进 `data` 的几个字段；没什么可说时给 `{}`。
 *
 * 键都带前缀，免得撞名：
 *
 * - `qplus_status` —— `ok` | `crash` | `unavailable` | `no_baseline`
 * - `qplus_crash` —— True / False / **null**。null 是「判不了」，调用方**不许**当成 False
 * - `qplus_fraction` —— 振幅占自由振荡基线的比例
 */
export async function qplusFields(ctx: SkillContext): Promise<Record<string, unknown>> {
  try {
    const res = await CheckTipCrashByAmplitude.execute(ctx, {})
    const data = (res.data ?? {}) as Record<string, unknown>
    const status = data['status']
    if (status === undefined || status === null || status === '') return {}
    const out: Record<string, unknown> = {
      qplus_status: status,
      qplus_crash: data['crash_indicator'] ?? null,
    }
    if (data['fraction_of_baseline'] !== undefined && data['fraction_of_baseline'] !== null) {
      out['qplus_fraction'] = data['fraction_of_baseline']
    }
    if (data['note'] !== undefined && data['note'] !== null && data['note'] !== '') {
      out['qplus_note'] = data['note']
    }
    return out
  } catch {
    // 第二意见绝不许把第一意见带走。
    return {}
  }
}

/**
 * **只有**振幅通道正面报告接触时才为真。
 *
 * 写成自己的函数，好让每个调用点都不必记得 `qplus_crash` 是三态。`null`
 * （没有传感器、没有基线、读失败）在这里返回 `false` —— 但那是
 * **「没有撞针的正面证据」，不是「已确认脱离」**，调用方不许拿它去确认任何事。
 */
export function qplusSaysCrashed(fields: Readonly<Record<string, unknown>>): boolean {
  return fields['qplus_status'] === 'crash' && fields['qplus_crash'] === true
}

/**
 * 把自由振荡振幅记成撞针判据的分母。
 *
 * **只在针尖已被确认脱离的那一刻调它** —— 一次确认过的退针之后，绝不投机地调。
 * 基线是之后每一次「振幅塌了吗」的比较对象，一个在接触状态下取的基线会把接触定义成
 * 正常，然后**永久**闭上这个探测器的嘴。
 *
 * 在这里自动做掉正是要点：旧仓这个基线只有在有人记得传 `set_baseline=True` 时才存在，
 * 而实践中的结果是振幅撞针检查一辈子都在报 `no_baseline`。
 * 一次 MAST 自己执行并自检通过的退针，是它唯一能知道的时刻。
 */
export async function captureQplusBaseline(
  ctx: SkillContext,
  note = '',
): Promise<Record<string, unknown>> {
  try {
    const res = await ReadTipOscillationAmplitude.execute(ctx, { set_baseline: true })
    const data = (res.data ?? {}) as Record<string, unknown>
    if (data['status'] !== 'ok') {
      return {
        qplus_baseline_captured: false,
        qplus_baseline_note: data['note'] ?? '振幅通道不可用',
      }
    }
    return {
      qplus_baseline_captured: true,
      qplus_baseline: data['amplitude'],
      qplus_baseline_note: note !== '' ? note : '已在确认脱离后记录自由振荡基线',
    }
  } catch (exc) {
    return { qplus_baseline_captured: false, qplus_baseline_note: `基线记录失败:${String(exc)}` }
  }
}

/**
 * 振荡回到（接近）自由值了吗 —— 横移前**确认**一次退针。
 *
 * 振幅直接回答「针尖机械上自由吗」，那是电流答不了的：针尖一旦远了电流就是零，
 * 而零也正是一个短路的前放会读到的东西。
 *
 * 通道答不了时返回 `null`。**`null` 不是 `true`**：确认脱离的调用方必须把它当作
 * 「这个证人弃权」并倚靠电流那条判据，不是当作它同意了。
 */
export async function qplusRecovered(ctx: SkillContext): Promise<RecoveredVerdict> {
  try {
    const res = await ReadTipOscillationAmplitude.execute(ctx, {})
    const data = (res.data ?? {}) as Record<string, unknown>
    if (data['status'] !== 'ok') {
      const note = data['note']
      return { verdict: null, why: typeof note === 'string' && note !== '' ? note : '振幅通道不可用 —— 这条判据用不上' }
    }
    return qplusRecoveredVerdict(Number(data['amplitude'] ?? 0), processQPlusBaseline.amplitude)
  } catch (exc) {
    return { verdict: null, why: `振幅判据不可用:${String(exc)}` }
  }
}
