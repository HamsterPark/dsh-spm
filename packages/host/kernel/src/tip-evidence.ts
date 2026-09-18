/**
 * 针尖**脱离**的证人 —— 振幅那一路的判据（旧仓 `skills/builtins/_tip_evidence.py`）。
 *
 * 撞针那一半（`amplitudeVerdict` / `CRASH_FRACTION`）在 `qplus-amplitude.ts`，
 * 这里是它的**镜像**：不是「塌了吗」，是「回来了吗」。
 *
 * ## 为什么这条判据是三态而不是两态（2026-08-12 真机）
 *
 * `RelocateCoarseXY` 的清障相在 **79%** 上判「针尖可能仍在接触,不要横向移动」，
 * 把整条换位挡死。现场当场指出：
 *
 * > 「这个判定荒谬了,实际上我们说的是**完全不起振**,基本上意味着**恒为 0**」
 *
 * 他是对的，而且理由是物理的：**接触会把音叉压死** —— 振幅塌到基线的百分之几，
 * 不是塌到 79%。79% 离「死」差着一个数量级。更根本的一条：**STM 模式下 qPlus
 * 振幅通道基本是噪声**，它唯一可靠的用处就是「振幅归零 = 撞上了」。
 * 拿一个噪声通道去卡 80% 那条线，量的是噪声不是接触。
 *
 * 两个阈值**本来就都存在**，只是中间那一段从来没人管：
 *
 * ```
 * frac < CRASH_FRACTION(0.10)      ⇒ 振幅被压死,真的在接触
 * frac ≥ RECOVERED_FRACTION(0.80)  ⇒ 确认脱离
 * 中间                              ⇒ **这个证人答不了**
 * ```
 *
 * **代价方向也对**：判 `false` 会挡住换位（而针尖其实是自由的）；判 `null` 只是
 * 少一个证人，电流那条判据照样要过。**「答不了」不该有「不合格」的权力。**
 */
import { CRASH_FRACTION } from './qplus-amplitude.js'
import { pyRound } from './spectroscopy.js'

/**
 * 高于自由振荡基线这个比例算**已恢复** —— 用来**确认**一次退针，是撞针判据的镜像。
 *
 * 刻意低于 1.0：退针之后振幅会回到自由值，但不是瞬间、也不是分毫不差，
 * 要求相等会把一次完好的退针报成失败。
 */
export const RECOVERED_FRACTION = 0.8

/** 振幅恢复判据的三态答复。`verdict === null` = **这个证人弃权**，不是「不合格」。 */
export interface RecoveredVerdict {
  readonly verdict: boolean | null
  readonly why: string
}

/** Python 的 `f"{x:.0%}"`（半偶舍入，与 `pyRound` 同一把尺子）。 */
function pct(frac: number): string {
  return `${pyRound(frac * 100, 0)}%`
}

/**
 * 振荡回到（接近）自由值了吗。
 *
 * `baseline` 缺失或非正 ⇒ **弃权**（它是除数；一个 0 基线会让任何振幅都判成恢复）。
 */
export function qplusRecoveredVerdict(amplitude: number, baseline: number | null): RecoveredVerdict {
  if (baseline === null || baseline <= 0) {
    return { verdict: null, why: '没有自由振荡基线,无法判断振幅是否已恢复' }
  }
  const frac = amplitude / baseline
  if (frac >= RECOVERED_FRACTION) {
    return {
      verdict: true,
      why: `qPlus 振幅已恢复到自由振荡基线的 ${pct(frac)}(≥${pct(RECOVERED_FRACTION)}),针尖机械上是自由的。`,
    }
  }
  if (frac < CRASH_FRACTION) {
    return {
      verdict: false,
      why:
        `qPlus 振幅只有自由振荡基线的 ${pct(frac)}` +
        `(< ${pct(CRASH_FRACTION)} = 音叉被压死)—— 针尖**仍在接触**,不要横向移动。`,
    }
  }
  return {
    verdict: null,
    why:
      `qPlus 振幅是自由振荡基线的 ${pct(frac)},落在` +
      `${pct(CRASH_FRACTION)}(压死)与 ${pct(RECOVERED_FRACTION)}(确认自由)之间 —— ` +
      '**这个通道在这一段答不了**(STM 下振幅通道基本是噪声,它只在归零时说得准)。' +
      '本证人弃权,请依据电流判据。',
  }
}
