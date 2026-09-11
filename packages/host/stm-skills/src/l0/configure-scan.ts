/**
 * `ConfigureScan` —— 配置扫描框、通道，顺带按档位表设速度。
 *
 * 它有**三道拒绝**，每一道都拒绝得很硬（拒绝，**不夹紧**）：
 *
 * 1. **读不回当前角度就不配帧。** 用一个假定的 0° 会**静默地把扫描框转正**，
 *    而调用方要的是「保持当前角度」。要 0° 就显式传 `angle_deg: 0`。
 * 2. **写完读回来对不上就拒**（{@link frameReadbackMismatch}）。「回声不是读数」：
 *    仪器把框夹到量程内时上层完全看不出来，之后每张图的坐标都是假的，而图看着正常。
 * 3. **框伸出压电量程就拒**（{@link frameExceeds}）。仪器**不会**拒绝超范围的帧，
 *    它照单全收、回读也原样返回；被夹的是扫描时的输出电压，于是超出去那部分像素
 *    **不是数据**（2026-08-28 实测：溢出的 39 列里相邻列差从 119 pm 掉到 43 pm）。
 *
 * 两道帧闸**各管一半，缺一不可**——回读那道抓不到量程越界，算术那道抓不到「仪器改了框」。
 */
import {
  formatG,
  frameExceeds,
  frameReadbackMismatch,
  matchSignal,
  piezoHalfRangeM,
  resolveLineTime,
  scalarFloat,
  scalarInt,
  unwrapScalar,
  type FrameMismatch,
  type FrameOverrun,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const num = (p: Readonly<Record<string, unknown>>, k: string): number =>
  typeof p[k] === 'number' ? (p[k] as number) : Number.NaN

/** 帧回读的五个数；读不懂给 `null`。 */
function readFrame(rec: SkillCallRecord): number[] | null {
  if (failed(rec)) return null
  const v = rec.values ?? []
  if (v.length < 5) return null
  const out = v.slice(0, 5).map((x) => scalarFloat(unwrapScalar(x)))
  return out.every((x): x is number => x !== null) ? out : null
}

/**
 * 两道帧闸各包一层**带返回类型**的函数。
 *
 * 不是为了复用（各只有一个调用点），是为了让它们**拆得开**：内联判空的话，
 * 一条把闸改成「永远放行」的变异会让下游类型收窄失效、编不过，而编不过的变异
 * 「红不算数」——那道闸就永远验不到（同 `stm-safety` 的 `approachRefusalFor`）。
 */
function checkFrameReadback(
  requested: readonly (number | null)[],
  readback: readonly unknown[] | null,
): FrameMismatch | null {
  return frameReadbackMismatch(requested, readback)
}

function checkPiezoRange(
  cx: number, cy: number, w: number, h: number,
  angle: number | null,
  halfX: number | null, halfY: number | null,
): FrameOverrun | null {
  return frameExceeds(cx, cy, w, h, angle, halfX, halfY)
}

/** 单位换算成 nm 的短写，只用于报文。 */
const nm = (x: number): string => (x * 1e9).toFixed(0)

export const ConfigureScan: Skill = {
  spec: S.ConfigureScanSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const centerX = num(params, 'center_x_m')
    const centerY = num(params, 'center_y_m')
    const width = num(params, 'width_m')
    const height = num(params, 'height_m')
    const channelsStr = typeof params['channels'] === 'string' ? params['channels'] : 'Z,Current'
    const setScanSpeed = params['set_scan_speed'] !== false

    // 档位按**长边**查：一个 8 nm × 200 nm 的条带该按 200 nm 定速。
    const sizeForTier = Math.max(width || 0, height || 0)
    const lt = resolveLineTime(params['line_time_s'], sizeForTier)

    // ── ① 角度：省略就回读，读不到就**拒** ──────────────────────────────
    let angle = typeof params['angle_deg'] === 'number' ? (params['angle_deg'] as number) : null
    if (angle === null) {
      const frame = readFrame(await ctx.safeCall('Scan_FrameGet'))
      angle = frame === null ? null : (frame[4] as number)
      if (angle === null || !Number.isFinite(angle)) {
        return {
          success: false,
          error:
            '无法读回当前扫描角度(Scan_FrameGet 失败或回包读不懂),' +
            '拒绝配置扫描帧 —— 用一个假定的 0° 会**静默地把扫描框转正**,' +
            '而调用方要的是「保持当前角度」。' +
            '若确实要 0°,请显式传 angle_deg=0.0。',
        }
      }
    }

    const recFrame = await ctx.safeCall('Scan_FrameSet', centerX, centerY, width, height, angle)
    if (failed(recFrame)) return { success: false, error: recFrame.error ?? '' }

    // ── ② 回读：对不上就拒，**不夹紧** ─────────────────────────────────
    const requested = [centerX, centerY, width, height, angle]
    const readback = readFrame(await ctx.safeCall('Scan_FrameGet'))
    const mismatch = checkFrameReadback(requested, readback)
    if (mismatch !== null) {
      if ('unreadable' in mismatch) {
        return {
          success: false,
          error:
            'Scan_FrameSet 发出去了，但**读不回**扫描帧' +
            '(Scan_FrameGet 失败或回包读不懂) —— 拒绝继续。' +
            '「读不到」不是「设上了」：仪器可能已经把框夹到量程内，' +
            '而此后每一张图的坐标都会是假的。',
          data: { requested_frame: requested, frame_readback: null },
        }
      }
      const parts = Object.entries(mismatch)
        .map(([k, v]) => `${k} 要 ${formatG(v.requested, 4)} 实得 ${formatG(v.readback, 4)}`)
        .join(', ')
      return {
        success: false,
        error:
          `仪器没有接受这个扫描帧，它把框改了：${parts}。` +
          '**拒绝，不夹紧** —— 按夹紧后的框扫出来的图，坐标与' +
          '请求的对不上，而图看着完全正常。' +
          '把中心挪回量程内，或把 size_m 调小。',
        data: { requested_frame: requested, frame_readback: readback, frame_mismatch: mismatch },
      }
    }

    // ── ③ 压电量程：算术那道闸 ────────────────────────────────────────
    let halfX: number | null = null
    let halfY: number | null = null
    const recCal = await ctx.safeCall('Piezo_CalibrGet')
    if (!failed(recCal) && (recCal.values ?? []).length >= 2) {
      const cal = recCal.values as unknown[]
      let lim: { on: boolean; xl: number; xh: number; yl: number; yh: number } | null = null
      const recLim = await ctx.safeCall('Piezo_XYZLimitsGet')
      if (!failed(recLim) && (recLim.values ?? []).length >= 5) {
        const l = recLim.values as unknown[]
        const g = (i: number): number | null => scalarFloat(unwrapScalar(l[i]))
        const on = scalarInt(unwrapScalar(l[0]))
        if (on !== null && g(1) !== null && g(2) !== null && g(3) !== null && g(4) !== null) {
          lim = { on: on !== 0, xl: g(1)!, xh: g(2)!, yl: g(3)!, yh: g(4)! }
        }
      }
      halfX = piezoHalfRangeM(scalarFloat(unwrapScalar(cal[0])), lim?.xl, lim?.xh, lim?.on ?? false)
      halfY = piezoHalfRangeM(scalarFloat(unwrapScalar(cal[1])), lim?.yl, lim?.yh, lim?.on ?? false)
    }
    const over = checkPiezoRange(centerX, centerY, width, height, angle, halfX, halfY)
    if (over !== null) {
      const overNm = Object.entries(over)
        .filter(([k]) => k.endsWith('_high_m') || k.endsWith('_low_m'))
        .map(([k, v]) => `${k} 超 ${nm(v as number)} nm`)
        .join(', ')
      return {
        success: false,
        error:
          `扫描帧伸出压电量程：${overNm}（半程 ±${nm(halfX ?? 0)}/±${nm(halfY ?? 0)} nm）。` +
          '**拒绝，不夹紧** —— 仪器不会拒绝超范围的帧，它照单全收、' +
          '读回也原样返回；被夹住的是扫描时的输出电压，于是超出去的' +
          '那部分像素**不是数据**（2026-08-28 实测：溢出的 39 列里' +
          '相邻列差从 119 pm 掉到 43 pm，而图看着完全正常）。' +
          '把中心挪回量程内，或把 size_m 调小。',
        data: {
          requested_frame: requested,
          frame_readback: readback,
          frame_exceeds_piezo_range: over,
          piezo_half_x_m: halfX,
          piezo_half_y_m: halfY,
        },
      }
    }

    // ── ④ 通道：对不上就**跳过**，不猜 ────────────────────────────────
    const requestedChannels = channelsStr
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
    if (requestedChannels.length > 0) {
      const recSignals = await ctx.safeCall('Signals_NamesGet')
      if (!failed(recSignals)) {
        const names = (recSignals.values ?? []).find(
          (v): v is string[] => Array.isArray(v) && v.length > 0 && typeof v[0] === 'string',
        )
        if (names !== undefined) {
          const idx = requestedChannels
            .map((ch) => matchSignal(ch, names))
            .filter((i): i is number => i !== null)
          // `Scan_BufferSet` 失败**不让整件事失败**：帧已经配好了，通道没设上是
          // 一个可以继续的降级（旧仓同此）。
          if (idx.length > 0) await ctx.safeCall('Scan_BufferSet', idx, 0, 0)
        }
      }
    }

    // ── ⑤ 速度：由每线时间推导，保持每行耗时恒定 ──────────────────────
    let speed: number | null = null
    let speedSet = false
    if (setScanSpeed) {
      speed = lt.lineTimeS > 0 ? width / lt.lineTimeS : 500e-9
      const recSpeed = await ctx.safeCall(
        'Scan_SpeedSet',
        speed,
        speed,
        lt.lineTimeS,
        lt.lineTimeS,
        2,
        1.0,
      )
      speedSet = !failed(recSpeed)
    }

    const rb = readback as number[]
    return {
      success: true,
      data: {
        center_x_m: rb[0],
        center_y_m: rb[1],
        width_m: rb[2],
        height_m: rb[3],
        angle_deg: rb[4],
        // **回读过了**才有这一位。它是「回声不是读数」那条的凭据。
        frame_verified: true,
        requested_frame: requested,
        frame_exceeds_piezo_range: null,
        piezo_half_x_m: halfX,
        piezo_half_y_m: halfY,
        channels: channelsStr,
        scan_speed_set: speedSet,
        line_time_s: setScanSpeed ? lt.lineTimeS : null,
        // 「这个速度是谁定的」必须可查。
        line_time_source: setScanSpeed ? lt.source : null,
        linear_speed_m_s: speed,
      },
    }
  },
}
