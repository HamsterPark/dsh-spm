/**
 * **原子分辨的成像条件窗口** —— 「这一帧的偏压/电流，本来就出不了原子」。
 *
 * 零 numpy，所以它留在 `kernel`（同 `corrugation-gate.ts` / `scan-prep-thresholds.ts`）。
 *
 * ## 为什么需要它（2026-08-26 真机，同一个坑踩了两次）
 *
 * 修针类流程会把工作点改掉且**不改回来** —— `PulseConditionTip` 的 A 阶段把结偏压
 * 设成 0.05 V，大修路径上还出现过 **1.0 V**。改完之后如果没人回读，
 * 后续每一帧都是在错的工作点上采的。
 *
 * 真正咬人的不是数据没用，而是**症状会伪装成针尖坏了**：1.0 V 下 Au(111) 的 FFT
 * 给出周期 0.30–0.36 nm（理论行距 0.24974）、三方向散布 80%+、时而「无晶格」。
 * 按这个读数往下走，阶梯会判「针尖极其糟糕」⇒ 打脉冲 ⇒ **真的把一根好针尖打坏**。
 * 那一次损失的是一根 asp 1.295 / snr 37 的针尖。
 *
 * ⇒ 这道闸门的产物必须是 **`undetermined`（判不了）**，不是 `absent`（没有）——
 * **条件不支持作答时就说不知道，别给一个看起来合理的负面结论。**
 *
 * ## 窗口的依据（不是发明的数字）
 *
 * * 上限 `|bias| ≤ 0.15 V`：本仓流程表里所有原子分辨档位用的都是 0.02 V；
 *   2026-08-26 实测 **0.05 V 仍能出**（该批最好一帧 asp 1.295 / snr 37.3），
 *   而 **1.0 V 完全出不来**。阈值取在两者之间且靠近实测通过的一侧。
 * * 下限 `setpoint ≥ 50 pA`：流程表值 500 pA；电流越小针尖越远，原子起伏按指数衰减。
 *   50 pA 是「明显不该再指望原子」的量级，**不是最优值**。
 *
 * 这些是**否决用的粗窗口**，不是推荐值 —— 它只回答「这一帧值不值得判」，
 * 不回答「该用什么条件扫」。
 */

/** 偏压绝对值上限（V）。 */
export const ATOMIC_BIAS_MAX_V = 0.15

/** 电流设定下限（A）。 */
export const ATOMIC_SETPOINT_MIN_A = 50e-12

/**
 * 「我要看原子」这个意图对应的标准工作点。
 *
 * 为什么要有这个常量：`scan_policy` 的档位表**刻意不存 bias**（「bias 是物理意图
 * 参数，不是尺度的函数」——那句话是对的）。但 bias 虽然不是**尺度**的函数，
 * 却是**意图**的函数：说「我要原子分辨」就等于说了要什么偏压。
 * 现场 2026-08-26 原话：「**每一个 skill 在一开始会制定自己的工作点，
 * 而不是依赖上一个 skill**。」
 */
export const ATOMIC_WORKING_POINT: Readonly<Record<string, number>> = { bias_v: 0.02, setpoint_a: 500e-12 }

/** 一些衬底的窄窗口（留给以后按材料细化；缺省走通用值）。 */
const PER_SURFACE: Readonly<Record<string, readonly [number, number]>> = {
  'Au(111)': [0.15, 50e-12],
  'Ag(111)': [0.15, 50e-12],
  'Cu(111)': [0.15, 50e-12],
}

/** `ok` 为假时，`reason` 是**稳定的机读码**，`detailZh` 给人看。 */
export interface WindowVerdict {
  readonly ok: boolean
  readonly reason: string
  readonly detailZh: string
  readonly biasV: number | null
  readonly setpointA: number | null
  readonly biasMaxV: number
  readonly setpointMinA: number
}

/** 「出原子分辨」这个意图的标准工作点。当前不随衬底变，留参数是为了以后细化。 */
export function atomicWorkingPoint(_surface?: string | null): Record<string, number> {
  return { ...ATOMIC_WORKING_POINT }
}

/** 该衬底的 `(|bias| 上限 V, setpoint 下限 A)`。未知衬底走通用值。 */
export function windowFor(surface: string | null | undefined): readonly [number, number] {
  if (surface) {
    const hit = PER_SURFACE[String(surface).trim()]
    if (hit) return hit
  }
  return [ATOMIC_BIAS_MAX_V, ATOMIC_SETPOINT_MIN_A]
}

/** Python 的 `"%.3f"` / `"%.2f"` / `"%.1f"` / `"%.0f"`，这一族的数都远离半分点。 */
const f = (x: number, n: number): string => x.toFixed(n)

/**
 * 这一帧的成像条件支不支持「有没有原子分辨」这个问题。
 *
 * ⚠️ **读不到条件时放行**（返回 `ok`）—— 缺字段是「不知道」，不是「不合格」，
 * 把它当不合格会让所有缺头信息的旧帧凭空变成判不了。
 */
export function checkAtomicWindow(
  biasV: number | null | undefined,
  setpointA: number | null | undefined,
  surface?: string | null,
): WindowVerdict {
  const [bmax, smin] = windowFor(surface)
  const b = biasV === undefined ? null : biasV
  const s = setpointA === undefined ? null : setpointA
  const base = { biasV: b, setpointA: s, biasMaxV: bmax, setpointMinA: smin }
  if (b === null && s === null) return { ok: true, reason: '', detailZh: '', ...base }

  if (b !== null && Math.abs(b) > bmax) {
    return {
      ok: false,
      reason: 'bias_out_of_atomic_window',
      detailZh:
        `偏压 ${f(b, 3)} V 超出原子分辨窗口（|V| ≤ ${f(bmax, 2)} V）—— 这一帧**回答不了**` +
        `有没有原子分辨，**不要读成针尖不好**。多半是修针流程改了工作点` +
        `没改回来（PulseConditionTip 会设成 ${f(0.05, 2)} V）。`,
      ...base,
    }
  }
  if (s !== null && s < smin) {
    return {
      ok: false,
      reason: 'setpoint_below_atomic_window',
      detailZh:
        `电流设定 ${f(s * 1e12, 1)} pA 低于 ${f(smin * 1e12, 0)} pA —— 针尖太远，原子起伏按指数衰减，` +
        `这一帧**回答不了**，**不要读成针尖不好**。`,
      ...base,
    }
  }
  return { ok: true, reason: '', detailZh: '', ...base }
}
