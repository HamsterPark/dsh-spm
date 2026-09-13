/**
 * 解调相位对齐的算术 —— `AutoPhase` 那个「GUI 的 Auto 按钮」做的事。
 *
 * GUI 上的 Auto 按钮**没有对应的 TCP 命令**（38 条 `LockIn_*` 逐条核过），但它要的
 * 三步每一步都通：读 X/Y → `atan2(Y, X)` 算出偏角 → 写**解调侧** phase。
 * 这个文件只装中间那一步：全是值，没有 I/O。
 *
 * ## 两种模式，对应两种物理场景
 *
 * - `signal_to_x` —— **隧穿态**：把 dI/dV 信号转到 X 轴（常规 auto）。
 * - `crosstalk_to_y` —— **退针态**：此时 X/Y 上剩的是电容串扰，把它转到 Y，
 *   信号轴自然就对齐了 X。**不必进针就能定相位轴。**
 *
 * ## 算出来的是**增量**，不是目标
 *
 * `atan2` 给的是「信号现在偏离 X 轴多少度」，要加到**当前相位**上才是要写的值。
 * 所以读不到当前相位时不能写——没有起点，一个假起点会把相位转到谁也没要的地方。
 */
import { pyMean, pySum } from './si.js'

/**
 * 低于这个幅度就认为「没有可用信号」。与电流噪声底同量级（1 pA）。
 *
 * lock-in 读数的单位随机器而异，所以这是**下界守卫**而不是标定值：它拦的是
 * 「零信号上算出来的角」，不是「小信号」。噪声上算出来的角只是噪声的角，
 * 而它和一个真的相位角在数值上完全一样体面。
 */
export const AUTOPHASE_MIN_SIGNAL = 1e-12

export type PhaseMode = 'signal_to_x' | 'crosstalk_to_y'

/**
 * Python 的 `%`，**不是** JS 的 `%`。
 *
 * JS 的余数符号跟着被除数，Python 的模跟着除数。相位折叠 `(x + 180) % 360 - 180`
 * 里的 `x` 常常是负的（相位是 ±180 的量），于是两者会给出**完全不同**的结果：
 *
 * ```
 * 当前 -170°，增量 -90° ⇒ 和 = -80
 *   Python: -80 % 360 = 280  ⇒ 目标 +100°
 *   JS:     -80 % 360 = -80  ⇒ 目标 -260°   ← 越界，而且转到了别处
 * ```
 *
 * `-260°` 还会被硬件自己折回去，于是写进去的值和报出来的值不一样 ——
 * 一次「已对齐」的成功里藏着一个没人核得出的偏差。
 */
export function pyMod(a: number, n: number): number {
  // 写成「先取余，符号不对才补一个 n」而**不是** `((a % n) + n) % n`：
  // 后者对本来就为正的 a 也走一遍加 360 再取余，而那一来一回在浮点上不是恒等变换
  // ——目标相位会在最后一两位上和 Python 分岔，于是逐字比对的金样过不了。
  const r = a % n
  if (r === 0) {
    // CPython 的 `float_rem` 在余数为零时把符号**取自除数**（`copysign(0.0, wy)`）：
    // `-360 % 360` 是 `+0.0`，而 JS 的 `%` 给 `-0`。一个 `-0` 印出来是 `-0.0`，
    // 而本仓已经为「`-0` 是一条线索，别把符号擦掉」立过一次规矩（`formatG`）。
    return n < 0 ? -0 : 0
  }
  return r < 0 !== n < 0 ? r + n : r
}

/** 把任意角折进 `[-180, 180)` —— **上端开**：180° 折成 −180°，同 Python。 */
export function foldDeg(deg: number): number {
  return pyMod(deg + 180.0, 360.0) - 180.0
}

/**
 * 要写进解调器的目标相位。
 *
 * `crosstalk_to_y` 比 `signal_to_x` 多转 −90°：把串扰归到 Y 之后，信号轴落在 X。
 */
export function phaseTarget(
  mode: PhaseMode,
  currentDeg: number,
  xMean: number,
  yMean: number,
): { readonly deltaDeg: number; readonly targetDeg: number } {
  let delta = (Math.atan2(yMean, xMean) * 180.0) / Math.PI
  if (mode === 'crosstalk_to_y') delta -= 90.0
  return { deltaDeg: delta, targetDeg: foldDeg(currentDeg + delta) }
}

/**
 * 采样窗里 X/Y 的幅度。低于 {@link AUTOPHASE_MIN_SIGNAL} 就是「判不了」。
 *
 * ## D-HYPOT-1 · 两种语言的 `hypot` 不是同一个函数
 *
 * `Math.hypot` 与 CPython 的 `math.hypot` 各有自己的缩放与补偿，**在最后一位上会
 * 分岔**（`hypot(1e-15, 1e-15)`：JS `…0953e-15`，Python `…095e-15`）。
 * 换成 `sqrt(x² + y²)` 也不解决：那一格反而对上了，`hypot(0.7, 0.2)` 又对不上，
 * 而且它在 `1e-200` 上直接下溢成 0。
 *
 * 保留 `Math.hypot`（它是这里该用的那个原语），把差异登记掉：
 * `r` 进的是**证据**，判据是它与 `1e-12` 的比较，而模型读到的是三位有效数字 ——
 * 最后一位的差异在这两处都表示不出来。
 */
export function signalMagnitude(xMean: number, yMean: number): number {
  return Math.hypot(xMean, yMean)
}

/**
 * 样本标准差（`n - 1`），少于两个点给 `0`。
 *
 * 报它是因为**一个平均值不说自己有多稳**：X/Y 抖得比它们自己还大时，算出来的角
 * 也就抖同样多，而读的人看不见这一点。它不参与判据，只进证据。
 */
export function sampleSd(values: readonly number[]): number {
  if (values.length < 2) return 0.0
  const mean = pyMean(values)
  return Math.sqrt(pySum(values.map((v) => (v - mean) ** 2)) / (values.length - 1))
}

/** 回读的相位算不算「写进去了」。**0.5° 是绝对容差**——相位是角度，不是量级量。 */
export const PHASE_READBACK_TOL_DEG = 0.5

/**
 * 相位回读比对。**读不到（`null`）就是不符**——「读不到」不是「一样」。
 *
 * 与 {@link ./readback.ts | valuesMatch} 的相对容差刻意不同：相位跨零，
 * 一个 `rel_tol` 在 0° 附近要求的是无穷精度，而在 179° 附近又松到 0.18°。
 */
export function phaseMatches(targetDeg: number, readbackDeg: number | null): boolean {
  return readbackDeg !== null && Math.abs(readbackDeg - targetDeg) < PHASE_READBACK_TOL_DEG
}
