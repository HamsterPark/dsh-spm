/**
 * 偏压斜坡的目标电压序列。
 *
 * 这里唯一的难点是**浮点要逐位对得上**：交出去的每一个数都会被原样下发给硬件，
 * 差一个 ulp 就是下发的电压差一点。旧仓用的是 `np.linspace`，而 linspace 不是
 * 「`start + i * (Δ/div)`」也不是「`start + (i·Δ)/div`」——它是前者，而且**最后一个
 * 元素被直接赋成 `stop`**。三种写法给的数不同，金样 `float_repeating` 那一格
 * （0 → 1 切 3 步）就是分辨它们的标尺。
 */

/** 低于这个幅度不排斜坡，一发到位。 */
export const SINGLE_SHOT_THRESHOLD_V = 0.001
export const DEFAULT_SLEW_V_PER_S = 1.0
export const DEFAULT_STEP_INTERVAL_S = 0.1

/**
 * `np.linspace(start, stop, num)` 的**逐位等价**实现。
 *
 * numpy 的算法（`endpoint=True`）：
 *
 * ```
 * step = (stop - start) / (num - 1)
 * y = arange(0, num) * step + start
 * y[-1] = stop            // ← 最后一个不算，直接赋值
 * ```
 *
 * 那一行赋值不是修饰：`0 → 1` 切 3 份时 `3 * (1/3)` 是 `0.9999999999999998`，
 * 而斜坡的**终点**是调用方要求的那个电压，不是一个差着一个 ulp 的近似值。
 */
export function linspace(start: number, stop: number, num: number): number[] {
  if (num <= 0) return []
  if (num === 1) return [start]
  const step = (stop - start) / (num - 1)
  const out: number[] = []
  for (let i = 0; i < num; i += 1) out.push(i * step + start)
  out[num - 1] = stop
  return out
}

/**
 * 斜坡要经过的目标电压（**不含起点**）。
 *
 * 幅度小于 1 mV 就一发到位——把一个毫伏级的改动切成几十步，只是在同一个电压上
 * 反复写几十次。
 *
 * 步数 `max(1, trunc(|Δv| / (slew · interval)))` 里的**截断**是真判据，不是凑数：
 * `0.3 / (1.0 × 0.1)` 在浮点里是 `2.9999999999999996`，于是 0 → 0.3 V 切的是
 * **2 步**而不是 3 步。金样 `odd_divisor` 那一格钉的就是它。
 */
export function biasRampTargets(args: {
  readonly startV: number
  readonly endV: number
  readonly slewVPerS: number
  readonly stepIntervalS: number
}): number[] {
  const { startV, endV, slewVPerS, stepIntervalS } = args
  const diff = Math.abs(endV - startV)
  if (diff <= SINGLE_SHOT_THRESHOLD_V) return [endV]
  const n = Math.max(1, Math.trunc(diff / (slewVPerS * stepIntervalS)))
  return linspace(startV, endV, n + 1).slice(1)
}
