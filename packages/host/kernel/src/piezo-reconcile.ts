/**
 * 压电范围对账 —— **配置说的和仪器说的是不是同一个数**。
 *
 * ## 2026-08-16 真机事故
 *
 * `SafetyLimits.xy_max_m` 出厂 **1.5 µm**，是一个**写死的常数，从不与仪器核对**。
 * 而真机实测 XY 半程只有 **1219.4999 nm**（`Piezo_RangeGet` 的全程 2438.9 nm）。
 *
 * 配置比实际大 **23 %**，后果一路传下去：
 *
 * ```
 * xy_max_m 1500 nm
 *   → 选点器提议 Y = 1224 nm（越过真实限位 1219.5）
 *   → 针尖夹在限位上，MoveToXY 报「超时」
 *   → 外环 optional=False ⇒ 中止，54 分钟的修针工作全丢
 * ```
 *
 * 用户当场指出了另一半原因：**「下液氦之后确实没有重置扫描框范围」**——
 * 换温度、换扫描器、改压电标定都会动这个数，而**没有任何东西会去看一眼**。
 *
 * ## 三态，而第三态是要害
 *
 * | | |
 * |---|---|
 * | `ok` | 两边一致（相对差 ≤ 容差） |
 * | `mismatch` | 两边都读到了，但不一致 —— 报出两个数和差多少 |
 * | `unknown` | **仪器那边读不到 ⇒ 判不了**，不是「一致」 |
 *
 * 把 `unknown` 折成 `ok`，这个自检就变成一句**永远为真的安慰话**——而那正是它
 * 要防的东西。本仓这一条已经复发过多次（`CheckScanForCrash` 的 `skipped`、
 * `AutoPhase` 的噪声底、`SetZLimits` 的 `widened: null`）。
 *
 * ## 名字撞车，而问的是两件事
 *
 * `configure-scan.ts` 里有一个**私有**的 `checkPiezoRange`，问的是
 * 「这一**帧**超不超压电半程」。这里问的是「**配置里的限值**与仪器报的量程
 * 对不对得上」。输入不同、时机不同、后果不同 —— 见 `spec/deviations.md`
 * 里 D-CHANNELS-1 那条的理由：**两个看起来一样的名字，正是将来最想合并的东西**。
 */

/** 相对差超过它就算不一致。`0.02` = 2 % —— 比读数抖动大得多，比那次事故的 23 % 小得多。 */
export const DEFAULT_PIEZO_TOLERANCE_FRAC = 0.02

export type PiezoVerdict = 'ok' | 'mismatch' | 'unknown'

export interface PiezoReconciliation {
  readonly verdict: PiezoVerdict
  /** 两轴取小的 —— **包络要保守**。`null` = 判不了。 */
  readonly minInstrumentHalfM: number | null
  readonly relativeDifference: number | null
  /** 配置比仪器**大**吗。大才是危险的那一侧（选点器会提议到不了的目标）。 */
  readonly configuredExceeds: boolean | null
}

/**
 * 两轴都读到了吗。**「读不到」不是「一致」** —— 一个 `null` 半程绝不能被当成
 * 一次成功的对账，那正是这个自检要防的东西。
 *
 * 写成返回一对而不是一个布尔，是为了让这道闸**拆得开**：判断写在 `if` 里时
 * 下游的类型收窄就挂在它身上，把它改成永远放行会让 `tsc` 直接报错 ——
 * 而一条编不过的变异什么都没验（本仓第十二次撞上这个形状）。
 */
function bothHalves(x: number | null, y: number | null): [number, number] | null {
  return x === null || y === null ? null : [x, y]
}

/**
 * 判一次对账。**全是值，没有 I/O** —— 读回包与读配置都留在技能层。
 *
 * 任一侧给 `null` 就是 `unknown`：这个函数**没有**「读不到就当一致」那条路。
 */
export function reconcilePiezoRange(
  instrumentHalfX: number | null,
  instrumentHalfY: number | null,
  configuredHalf: number | null,
  toleranceFrac: number = DEFAULT_PIEZO_TOLERANCE_FRAC,
): PiezoReconciliation {
  const unknown: PiezoReconciliation = {
    verdict: 'unknown',
    minInstrumentHalfM: null,
    relativeDifference: null,
    configuredExceeds: null,
  }
  const pair = bothHalves(instrumentHalfX, instrumentHalfY)
  if (pair === null) return unknown
  if (configuredHalf === null) return unknown

  const instHalf = Math.min(pair[0], pair[1])
  // `max(instHalf, 1e-15)`：仪器半程为 0 时不炸，而那一格照样会判成 mismatch。
  const rel = Math.abs(configuredHalf - instHalf) / Math.max(instHalf, 1e-15)
  return {
    verdict: rel <= toleranceFrac ? 'ok' : 'mismatch',
    minInstrumentHalfM: instHalf,
    relativeDifference: rel,
    configuredExceeds: configuredHalf > instHalf,
  }
}

/**
 * `Piezo_RangeGet` 回的是**全程**，半程 = 全程 / 2。
 *
 * 取绝对值：一个负的量程是解析残渣，而 `abs` 之后它仍然会在对账里显出来
 * （数值对不上），比在这里静默拒绝更容易查。
 */
export function halfRange(full: number | null): number | null {
  return full === null ? null : Math.abs(full) / 2.0
}
