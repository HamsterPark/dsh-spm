/**
 * `AcquireBiasSeries` —— 同一位置的偏压依赖图像序列，**按恒定结阻配 setpoint**。
 *
 * ## 为什么不能只改偏压不改 setpoint
 *
 * 隧道结的距离由**结阻** R = V / I 决定，不是由 setpoint 单独决定。
 * 偏压降下去而 setpoint 不动 ⇒ R 变小 ⇒ **针尖被推近**。
 *
 * 参考系统观测表明，较低结阻条件可能推动松散表面结构，并使 RMS 与 Z 摆幅显著增加；
 * 提高结阻后恢复稳定。该观测尚未在本仓独立验证，因此这里保留恒结阻控制原则，
 * 不把单次现场序列当作通用阈值。
 *
 * ## ⚠️ `drift_check` 这条路在**新旧两仓都是死的**
 *
 * `_one` 取的是 `ScanAt` 回包里的 `scan_path` / `path` / `file`，而 **`ScanAt`
 * 一个都不写**：
 *
 * | | 写了哪些键 |
 * |---|---|
 * | 旧仓 `composite/scan_at.py:368-389`（`set_partial`） | `wait_timed_out` · `wait_stopped_early` · `scan_lines_done` · `scan_lines_total` · `budget_s` · `elapsed_s` · `extensions` · `lines_done` · `lines_total` · `pixels` · `lines` · `resolution_verified` · `angle_deg` · `linear_speed_m_s` |
 * | 旧仓 `aggregate`（`:392-396`） | 上面那些 + `_resolved_snapshot`（解析出来的扫描参数） |
 * | 本仓 `scan-at.ts:183-198` + `:211-228` | **一模一样**，外加 `_progress` / `abort_facts` |
 *
 * ⇒ `path` 恒为假 ⇒ **`AssessFrameTrust` 从来不会被调**，`drift_check` 恒为 `null`，
 * 每一行的 `row_jump_mad_pm` / `tip_verdict` / `rms_pm` 三个键**根本不出现**。
 *
 * **这一批不给 `ScanAt` 补这个键** —— 那是一个独立决定（`GetLatestScanFile` /
 * `findLatestSaved` 本来就在手边，但「扫完之后最新的那个 `.sxm` 是不是这一帧」
 * 需要一道水位线，和 `AcquireDeltaFCurve` 的 `.dat` 归属是同一类问题）。
 * 这一批做的是：**照移这条路 + 登记它是死的 + 一条量着它的测试**
 * （`batch7b2-skills.test.ts` 里那条「`ScanAt` 的回包里没有任何一个路径键」）。
 * `ScanAt` 哪天补上了，那条测试当场变红，而不是这里安静地开始工作。
 */
import { pyFloatRepr, pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { fail } from '../l0/common.js'

/**
 * setpoint 的下界（A）。低偏压端按恒结阻算出来的电流可能低于噪声底，
 * 那时图上就没有信号 —— 宁可让那一档结阻偏小（针尖稍近），也不要采一张噪声。
 */
export const MIN_SETPOINT_A = 5e-12

/** setpoint 的上界（A）。恒结阻在高偏压端会要求很大的电流，那是另一种「太近」。 */
export const MAX_SETPOINT_A = 500e-12

export interface SetpointPlanRow {
  readonly biasV: number
  readonly setpointA: number
  readonly clamped: boolean
}

/**
 * `setpoints_for` —— 按恒定结阻给每个偏压算 setpoint，越界夹回来并**如实标记夹过**。
 *
 * 夹过的那几档结阻不再等于目标值，调用方在横向比较时必须知道这件事 ——
 * 所以标记要**跟着数据走**，不能只写日志。
 */
export function setpointsFor(biases: readonly number[], rOhm: number): SetpointPlanRow[] {
  const out: SetpointPlanRow[] = []
  for (const b of biases) {
    const want = Math.abs(b) / rOhm
    const sp = Math.min(Math.max(want, MIN_SETPOINT_A), MAX_SETPOINT_A)
    out.push({ biasV: b, setpointA: sp, clamped: Math.abs(sp - want) > 1e-15 })
  }
  return out
}

/** Python 的 `float(s)`（逗号串里每一项都过这一道）。 */
function pyFloat(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/i.test(t)) return Number.NaN
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null
  return Number(t)
}

/** Python 的 `repr(str)`。 */
function reprStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Python 的 `"%s" % list_of_float` —— 列表的 `repr`，元素走 `repr(float)`。 */
function reprFloatList(xs: readonly number[]): string {
  return `[${xs.map((x) => pyFloatRepr(x)).join(', ')}]`
}

/** Python 的 `x or d`（`0` / `''` / `None` 都算假）。 */
function orDefault(v: unknown, d: number): number {
  if (v === undefined || v === null) return d
  const n = Number(v)
  if (Number.isNaN(n)) return d
  return n === 0 ? d : n
}

const data0 = (r: SkillResultLike): Record<string, unknown> =>
  (r.data as Record<string, unknown> | undefined) ?? {}

async function oneFrame(
  ctx: SkillContext,
  x: number,
  y: number,
  size: number,
  bias: number,
  sp: number,
  px: number,
  line: number,
  tag: string,
): Promise<Record<string, unknown>> {
  const res = await ctx.runSkill('ScanAt', {
    center_x_m: x,
    center_y_m: y,
    size_m: size,
    pixels: Math.trunc(px),
    line_time_s: line,
    bias_v: bias,
    setpoint_a: sp,
    purpose: 'survey',
  })
  const row: Record<string, unknown> = {
    tag,
    bias_v: bias,
    setpoint_a: sp,
    ok: res.success === true,
  }
  const data = data0(res)
  // ⚠️ 见文件抬头：这三个键 `ScanAt` 一个都不写 —— 这一段在两仓都是死的。
  const path = data['scan_path'] ?? data['path'] ?? data['file']
  if (path !== undefined && path !== null && path !== '' && path !== false) {
    row['scan_path'] = path
    const trust = await ctx.runSkill('AssessFrameTrust', { scan_path: path })
    const td = data0(trust)
    row['row_jump_mad_pm'] = td['row_jump_mad_pm'] ?? null
    row['tip_verdict'] = td['tip_verdict'] ?? null
    row['rms_pm'] = td['rms_pm'] ?? null
  }
  if (row['ok'] !== true) row['error'] = String(res.error ?? '').slice(0, 200)
  return row
}

export const AcquireBiasSeries: Skill = {
  spec: S.AcquireBiasSeriesSpec,
  validateParams: (params): string[] => {
    const errors: string[] = []
    const raw = String(params['biases_v'] ?? '').trim()
    if (raw !== '') {
      const vals: number[] = []
      let bad = false
      for (const t of raw.split(',')) {
        if (t.trim() === '') continue
        const v = pyFloat(t)
        if (v === null) {
          bad = true
          break
        }
        vals.push(v)
      }
      if (bad) {
        errors.push(`biases_v 解析不了：${reprStr(raw)}（要逗号分隔的数字）`)
      } else {
        if (vals.length < 2) errors.push(`偏压序列至少要 2 档（给了 ${vals.length}）`)
        if (vals.some((v) => v === 0)) {
          errors.push('偏压序列里不能有 0 V —— 恒结阻在 0 V 处算出 0 电流，而且 0 偏压下本来就没有隧穿。')
        }
      }
    }
    return errors
  },
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    // 同 `MapBarrierHeight`：**不假设 `validateParams` 跑过**，坏参数在这里也要返回而不是炸。
    const raw = String(params['biases_v'] ?? '')
    let biases: number[] = []
    for (const t of raw.split(',')) {
      if (t.trim() === '') continue
      const v = pyFloat(t)
      if (v === null) return fail(`biases_v 解析不了：${reprStr(raw)}（要逗号分隔的数字）`)
      biases.push(v)
    }
    biases = biases.filter((b) => b !== 0.0) // 0 V 在恒结阻下算出 0 电流
    if (biases.length < 2) {
      return fail(
        `偏压序列至少要 2 档非零值（收到 ${biases.length}）。0 V 在恒结阻下算出 0 电流，` +
          '而且 0 偏压下本来就没有隧穿。',
      )
    }
    const rOhm = orDefault(params['junction_r_ohm'], 1e11)
    const x = Number(params['center_x_m'])
    const y = Number(params['center_y_m'])
    const size = Number(params['size_m'])
    const px = Math.trunc(orDefault(params['pixels'], 192))
    const line = orDefault(params['line_time_s'], 0.05)

    const plan = setpointsFor(biases, rOhm)
    const clamped = plan.filter((r) => r.clamped).map((r) => r.biasV)
    // 漂移对照用序列里绝对值最大的那一档（信号最强、最稳）。
    // Python 的 `max(key=…)` 在并列时取**第一个**，这里照同一条。
    let ref = plan[0] as SetpointPlanRow
    for (const r of plan) {
      if (Math.abs(r.biasV) > Math.abs(ref.biasV)) ref = r
    }

    const frames: Record<string, unknown>[] = []
    frames.push(await oneFrame(ctx, x, y, size, ref.biasV, ref.setpointA, px, line, 'pre_drift'))
    for (const r of plan) {
      frames.push(await oneFrame(ctx, x, y, size, r.biasV, r.setpointA, px, line, 'series'))
    }
    frames.push(await oneFrame(ctx, x, y, size, ref.biasV, ref.setpointA, px, line, 'post_drift'))

    const pre = frames[0] as Record<string, unknown>
    const post = frames[frames.length - 1] as Record<string, unknown>
    let drift: Record<string, unknown> | null = null
    if (
      pre['row_jump_mad_pm'] !== undefined &&
      pre['row_jump_mad_pm'] !== null &&
      post['row_jump_mad_pm'] !== undefined &&
      post['row_jump_mad_pm'] !== null
    ) {
      const a = pre['row_jump_mad_pm'] as number
      const b = post['row_jump_mad_pm'] as number
      const worse = b > Math.max(2.0 * a, a + 20.0)
      const better = a > Math.max(2.0 * b, b + 20.0)
      drift = {
        pre_row_mad_pm: a,
        post_row_mad_pm: b,
        comparable: !(worse || better),
        note: worse
          ? `针尖在序列中**变差**了（${pyFixed(a, 1)} → ${pyFixed(b, 1)} pm）—— 这组图不能横向比，` +
            '偏压的效应和针尖的变化混在一起。'
          : better
            ? `针尖在序列中**变稳**了（${pyFixed(a, 1)} → ${pyFixed(b, 1)} pm）—— 别把这段变化读成偏压的效应。`
            : `首尾针尖状态相当（${pyFixed(a, 1)} / ${pyFixed(b, 1)} pm）—— 这组图可以横向比。`,
      }
    }
    const okFrames = frames.filter((f) => f['ok'] === true)
    return {
      success: okFrames.length > 0,
      error: okFrames.length > 0 ? '' : '一帧都没扫成。',
      data: {
        junction_r_ohm: rOhm,
        plan: plan.map((r) => ({ bias_v: r.biasV, setpoint_a: r.setpointA, clamped: r.clamped })),
        clamped_biases: clamped,
        clamp_note:
          clamped.length > 0
            ? `这几档的 setpoint 被夹在 [${pyFixed(MIN_SETPOINT_A * 1e12, 0)}, ` +
              `${pyFixed(MAX_SETPOINT_A * 1e12, 0)}] pA 之内，结阻不再等于目标值：` +
              `${reprFloatList(clamped)} —— 横向比较时要知道它们的针尖距离与其余档不同。`
            : '',
        frames,
        n_ok: okFrames.length,
        n_total: frames.length,
        drift_check: drift,
      },
    }
  },
}

/** 这一族（`builtins.bias_series`，1/1）。 */
export const BIAS_SERIES: Readonly<Record<string, Skill>> = { AcquireBiasSeries }
