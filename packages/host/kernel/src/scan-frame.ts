/**
 * 扫描框的两道闸 —— **各管一半，缺一不可**。
 *
 * | 闸 | 管什么 |
 * |---|---|
 * | {@link frameExceeds}（算术） | 仪器会不会在**扫的时候**把输出电压夹住 |
 * | {@link frameReadbackMismatch}（回读） | 仪器有没有**偷偷改掉**我给的帧 |
 *
 * ## 2026-08-28：那 15 % 不是数据
 *
 * 用户一眼看出 2 µm 的框有一小半在量程外，而**全链路没有任何一环问过这件事**。
 * 中心 (639, −597) nm、边长 2 µm ⇒ +x 需要 1639 nm 而半程只有 1334 nm。原始数据里
 * 末 39 列的相邻列差从 119±13 pm 掉到 43±10 pm（针尖已经不再横向移动），拐点实测在
 * 右起第 37 列——与算出的 39 px 在平滑核宽度内吻合。
 *
 * **仪器不会拒绝一个超范围的帧**：它照单全收，`Scan_FrameGet` 原样回显。被夹的是
 * 扫描过程中的输出电压。所以回读那道闸抓不到这一格，算术这道闸才行。
 *
 * ## 「回声不是读数」
 *
 * `ConfigureScan` 从前调完 `Scan_FrameSet` 就把**请求值**原样放进 `data` 返回——
 * 与 `zcontrol.py` 修过的 `data={"z_controller_on": enable}` 是同一个形状。仪器把框
 * 夹到量程内时上层完全看不出来，之后每一张图的坐标都是假的，**而图本身看着完全正常**。
 *
 * ## 两道闸都**拒绝，不夹紧**
 *
 * 按夹紧后的框扫出来的图，坐标与请求的对不上，而图看着完全正常。把中心挪回量程内、
 * 或把尺寸调小，是调用方的决定。
 */

/** 相对容差。回读与请求差到这个比例以上就算「仪器改了」。 */
export const FRAME_TOL_FRAC = 2e-4
/** 绝对容差下限（米）——请求值接近 0 时相对容差没有意义。 */
export const FRAME_TOL_ABS_M = 1e-12
export const FRAME_TOL_DEG = 0.05

export interface FrameExtent {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

/**
 * 扫描框四角在压电坐标里的包络。
 *
 * **必须算角度。** 转了 45° 的框，对角线伸出去 √2 倍；只比 `center ± size/2` 会在
 * 转角的帧上系统性地少算。
 */
export function frameExtent(
  centerXM: number,
  centerYM: number,
  widthM: number,
  heightM: number,
  angleDeg: number | null | undefined = 0,
): FrameExtent {
  const hw = widthM / 2
  const hh = heightM / 2
  const a = ((angleDeg ?? 0) * Math.PI) / 180
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const xs: number[] = []
  const ys: number[] = []
  for (const [dx, dy] of [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as const) {
    xs.push(centerXM + dx * ca - dy * sa)
    ys.push(centerYM + dx * sa + dy * ca)
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

/**
 * 由压电标定算这一轴的可达半程（米）。
 *
 * `calibration` 是**每 DAC 伏**的位移（Nanonis 自己的 range 就等于 `calibration × 20 V`），
 * DAC 是 ±10 V。2026-08-28 在本机核对过：
 * `sensitivity 8.8966e-9 m/V（压电端） × HVA gain 15 = 1.3345e-7 = calibration`
 * ——**增益已经折进 calibration 里了，别再乘一次**。
 *
 * 用户在 Piezo Calibration 里启用了更窄的电压限位时，可达范围随之变小。
 */
export function piezoHalfRangeM(
  calibMPerV: number | null | undefined,
  limitLowV: number | null | undefined = null,
  limitHighV: number | null | undefined = null,
  limitsEnabled = false,
): number | null {
  if (calibMPerV === null || calibMPerV === undefined) return null
  let v = 10.0
  if (limitsEnabled && limitLowV !== null && limitLowV !== undefined && limitHighV !== null && limitHighV !== undefined) {
    v = Math.min(v, Math.abs(limitLowV), Math.abs(limitHighV))
  }
  return Math.abs(calibMPerV) * v
}

export interface FrameOverrun {
  readonly x_high_m?: number
  readonly x_low_m?: number
  readonly y_high_m?: number
  readonly y_low_m?: number
  readonly extent_m: readonly number[]
  readonly half_m: readonly number[]
}

/**
 * 框有没有伸出 ±half 的方框。返回 `null`（没有）或超出量。
 *
 * ⚠️ 半程读不到时返回 `null`（**不作断言**）——「读不到」不是「没超」，调用侧要把它
 * 当成**判不了**，别当成通过。
 *
 * ⚠️ 树里还有两处直接调 `Scan_FrameSet`：那两处都是**还原**——把先前从仪器读到的框
 * 放回去。那个框按构造就是仪器自己的，给还原路径加越界闸门等于「替用户把他原本的
 * 设定改掉」。**该拒的时机是有人要拿这个框去扫**，那就是这里。
 */
/**
 * 两个半程都读到了吗。读不到给 `null`。
 *
 * 提成一个**带返回类型**的函数而不是内联两个判空：内联的话，一条把它改成「都当无穷大」
 * 的变异会让下游的类型收窄失效、编不过——而**编不过的变异「红不算数」，那道闸就永远
 * 验不到**（同 `stm-safety` 的 `approachRefusalFor`）。
 */
export function knownHalfRange(
  halfXM: number | null | undefined,
  halfYM: number | null | undefined,
): { readonly x: number; readonly y: number } | null {
  if (halfXM === null || halfXM === undefined || halfYM === null || halfYM === undefined) return null
  return { x: halfXM, y: halfYM }
}

export function frameExceeds(
  centerXM: number,
  centerYM: number,
  widthM: number,
  heightM: number,
  angleDeg: number | null | undefined,
  halfXM: number | null | undefined,
  halfYM: number | null | undefined,
): FrameOverrun | null {
  const half = knownHalfRange(halfXM, halfYM)
  if (half === null) return null
  const e = frameExtent(centerXM, centerYM, widthM, heightM, angleDeg)
  const over: Record<string, number> = {}
  if (e.maxX > half.x) over['x_high_m'] = e.maxX - half.x
  if (e.minX < -half.x) over['x_low_m'] = -half.x - e.minX
  if (e.maxY > half.y) over['y_high_m'] = e.maxY - half.y
  if (e.minY < -half.y) over['y_low_m'] = -half.y - e.minY
  if (Object.keys(over).length === 0) return null
  return {
    ...over,
    extent_m: [e.minX, e.maxX, e.minY, e.maxY],
    half_m: [half.x, half.y],
  } as FrameOverrun
}

export interface FieldMismatch {
  readonly requested: number
  readonly readback: number
  readonly delta_m?: number
}
/** `{unreadable: true}` = **读不到**，不是「对上了」。 */
export type FrameMismatch = Record<string, FieldMismatch> | { unreadable: true }

const FRAME_FIELDS = ['center_x_m', 'center_y_m', 'width_m', 'height_m', 'angle_deg'] as const

/**
 * 请求的帧与读回的帧对不对得上。返回 `null`（对得上）或差异。
 *
 * 读回缺项（回包读不懂）返回 `{unreadable: true}` —— **读不到不是对上了**。
 */
export function frameReadbackMismatch(
  requested: readonly (number | null | undefined)[],
  readback: readonly unknown[] | null | undefined,
): FrameMismatch | null {
  if (readback === null || readback === undefined) return { unreadable: true }
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)
  const req = requested.slice(0, 5).map((v) => num(v))
  const got = readback.slice(0, 5).map((v) => num(v))
  if (req.length < 5 || got.length < 5) return { unreadable: true }
  const diff: Record<string, FieldMismatch> = {}
  for (let i = 0; i < FRAME_FIELDS.length; i += 1) {
    const r = req[i] as number
    const g = got[i] as number
    if (!Number.isFinite(r) || !Number.isFinite(g)) return { unreadable: true }
    const nm = FRAME_FIELDS[i] as string
    if (nm === 'angle_deg') {
      if (Math.abs(g - r) > FRAME_TOL_DEG) diff[nm] = { requested: r, readback: g }
      continue
    }
    const tol = Math.max(Math.abs(r) * FRAME_TOL_FRAC, FRAME_TOL_ABS_M)
    if (Math.abs(g - r) > tol) diff[nm] = { requested: r, readback: g, delta_m: g - r }
  }
  return Object.keys(diff).length > 0 ? diff : null
}

/**
 * 把 `'Z'` / `'Current'` 这样的通道名对上 Nanonis 的信号名（`'Z (m)'` / `'Current (A)'`）。
 *
 * 先精确匹配，再**带边界的**前缀匹配：前缀之后必须是空格或左括号，否则 `'Z'` 会撞上
 * `'Z-Controller'` 那一类。找不到返回 `null`——**跳过而不是猜**。
 */
export function matchSignal(query: string, sigNames: readonly string[]): number | null {
  const q = (query ?? '').trim()
  for (let i = 0; i < sigNames.length; i += 1) {
    if (sigNames[i] === q) return i
  }
  const ql = q.toLowerCase()
  for (let i = 0; i < sigNames.length; i += 1) {
    const nl = (sigNames[i] as string).toLowerCase()
    if (nl.startsWith(ql) && (nl.length === ql.length || nl[ql.length] === ' ' || nl[ql.length] === '(')) {
      return i
    }
  }
  return null
}
