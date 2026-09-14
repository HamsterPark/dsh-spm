/**
 * qPlus 振荡振幅 —— 一个**与电流无关**的撞针证人。
 *
 * 操作员 2026-07-25 的现场反馈：
 *
 * > 在有 qplus 的情况下，ocd1 amplitude 可以作为是否撞针的依据；
 * > 若进针时撞针了，振幅会归 0，针尖拔出来之后才会恢复
 *
 * ## 为什么值得单独一条判据
 *
 * 本仓此前每一条撞针判据读的都是**同一族物理量**：隧道电流，或者由它建起来的
 * 那张图的方差。而音叉的振荡振幅是**机械上独立**的证人：接触了的针尖会被阻尼到
 * 停住，与前放报什么无关。它还回答了电流回答不了的那个问题 ——
 * **「针尖还动得了吗」**。
 *
 * ## 四态，而后两态都不是「没事」
 *
 * | | |
 * |---|---|
 * | `ok` | 振幅仍在基线附近，针尖自由振荡 |
 * | `crash` | 振幅塌到基线的 {@link CRASH_FRACTION} 以下 |
 * | `unavailable` | **判不了**：没有这条通道／激励没开／读不到 |
 * | `no_baseline` | **判不了**：没有自由振荡基线，`0 V` 本身不表示任何事 |
 *
 * **一个失败模式长得像成功的撞针探测器，比没有探测器更坏。**
 *
 * ## 缺陷⑰（2026-08-06 首演）：音叉没被驱动时，这条通道没有判据能力
 *
 * 本机 STM 模式下实测 `excitation_on = 0` / `excitation_v = 0 V`，而振幅通道上
 * 那 7–8 pm 是**未驱动解调器的噪声底**。拿它跟自由振荡基线比，**永远比出「塌了」**
 * —— 当天的 crash advisory 反复出现，全部发生在激励关着的时候。
 *
 * 所以要**两条证据**：输出开关开着 **并且** 激励幅度大于 0。
 * 任一条读不到就是 `unavailable` —— **不知道音叉有没有被驱动的时候，
 * 振幅这个数不代表任何东西**。
 *
 * 这条的代价是「PLL 读不回来的机器上这条判据不可用」，收益是它不再在一台 STM
 * 模式的机器上永远误报。**后者是实测发生的，前者是假设的。**
 */

/**
 * 低于自由振荡基线的这个**比例**就判为接触。
 *
 * 撞了的音叉不是「垂下来」，是**停住**——所以「自由」与「撞了」之间的间隔很大，
 * 这个阈值不需要逐机标定。**刻意不是 0**：热漂移与前放偏置会留一点残余，
 * 要求精确为零会漏掉真正的撞针。
 */
export const CRASH_FRACTION = 0.10

/** 认振幅通道的两组关键词。**两组都要命中**才算。 */
const AMP_HINTS: readonly string[] = ['amplitude', 'amp']
const OSC_HINTS: readonly string[] = ['oc ', 'ocd', 'osc', 'pll', 'excitation']

/**
 * 通道名像不像「振荡控制模块的振幅」。
 *
 * 只配 `amplitude` 是不够的——信号表里带这个词的还有别的（激励幅度、设定点）。
 * 要求同时命中一个**振荡控制**的线索，是因为操作员那台机器叫它 `OCD1 Amplitude`，
 * 而别家对 Oscillation Control 模块的命名不一样：**按两个词配，不按一个准确的串配**。
 */
export function looksLikeAmplitudeChannel(name: string): boolean {
  const low = String(name ?? '').toLowerCase().split(/\s+/).filter((x) => x !== '').join(' ')
  return AMP_HINTS.some((a) => low.includes(a)) && OSC_HINTS.some((o) => low.includes(o))
}

/** 信号表里第一条像振幅的通道。`null` = **这台机器没有**（正常配置，不是故障）。 */
export function findAmplitudeChannel(
  names: readonly string[],
): { readonly index: number; readonly name: string } | null {
  for (let i = 0; i < names.length; i += 1) {
    const n = names[i] as string
    if (looksLikeAmplitudeChannel(n)) return { index: i, name: String(n) }
  }
  return null
}

export type AmplitudeStatus = 'ok' | 'crash' | 'unavailable' | 'no_baseline'

/**
 * 激励在不在驱动音叉。`true` / `false` / **`null`（读不到）**。
 *
 * **两条证据都要**：开关开着 **并且** 幅度 > 0。开关开着而幅度是 0，音叉照样没被
 * 驱动 —— 本机实测正是 `on=0 / v=0 V` 那一组。
 *
 * 写成一个**有声明返回类型**的函数而不是内联的 `if`：把它改成永远为真的那条变异
 * 要编得过，否则那道闸就永远验不到。
 */
export function excitationDriving(on: boolean | null, excitationV: number | null): boolean | null {
  const both = bothWitnesses(on, excitationV)
  if (both === null) return null
  return both[0] && both[1] > 0.0
}

/**
 * 两条证据都在吗。同 `piezo-reconcile.ts` 的 `bothHalves`：返回一对而不是布尔，
 * 好让「任一条读不到就判不了」这道闸**拆得开**。
 */
function bothWitnesses(on: boolean | null, v: number | null): [boolean, number] | null {
  return on === null || v === null ? null : [on, v]
}

/**
 * 能用来比的基线。缺失或非正 ⇒ `null`。
 *
 * 非正也算没有：基线是**除数**，而一个 0 基线会让任何振幅都判成「没塌」（∞ 倍）
 * —— **一个失败模式长得像成功的撞针探测器，比没有探测器更坏。**
 */
function usableBaseline(b: number | null): number | null {
  return b === null || b <= 0 ? null : b
}

/** 振幅塌到基线以下了吗。基线缺失或非正 ⇒ **判不了**。 */
export function amplitudeVerdict(
  amplitude: number,
  baseline: number | null,
): { readonly status: AmplitudeStatus; readonly fraction: number | null } {
  const base = usableBaseline(baseline)
  if (base === null) return { status: 'no_baseline', fraction: null }
  const frac = amplitude / base
  return { status: frac < CRASH_FRACTION ? 'crash' : 'ok', fraction: frac }
}

/**
 * 记住的那个振幅通道下标能用吗。
 *
 * **`-1` 是「自动发现」的哨兵，不是一个下标**——把它当真下标传给
 * `Signals_ValGet`，读到的是控制器对一个负通道号做的任何事。
 */
export function rememberedIndex(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw >= 0 ? Math.trunc(raw) : null
}
