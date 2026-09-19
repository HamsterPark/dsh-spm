/**
 * 自动调平 —— `TiltCalibrate`（一次性标定）+ `AutoTilt`（闭环）。
 *
 * Nanonis 界面上有 **SmarTilt** 按钮，但 **TCP 协议不暴露它**。所以自动调平要自己做
 * 闭环：**测 → 算 → 设 → 复测 → 验收 / 回滚**。
 *
 * ## 为什么必须先标定
 *
 * `Piezo_TiltSet(tilt_x, tilt_y)` 与图像上测到的斜率之间，轴对应、符号、增益都取决于
 * 仪器接线和 Nanonis 内部约定，**无法先验假定**。**猜错符号 = 把倾斜往反方向加倍。**
 *
 * * `TiltCalibrate` 用 ±0.2° 的小步试探解出一个 2×2 响应矩阵 `G`，
 *   把「符号 + 轴交换 + 增益」一次吃掉，存进 instrument profile；
 * * **没有 `G` 时 `AutoTilt` 一律跳过**，不带着猜来的方向去动硬件。
 *
 * ## 判定在 `kernel/src/tilt-loop.ts`，这一层只有 I/O 与措辞
 *
 * 那 654 行里真正做决定的不到 60 行，其余是 TCP、`sleep` 与报文。
 * 三条阈、控制律、限步限幅、收敛判据全在内核，由一张表验证。
 *
 * ## 软停：**只停，不动**
 *
 * 倾斜循环里的等待加起来是十几秒量级，而中间只有测量那一处能退出。
 * 十几秒对一个按了停止的人来说是很长的。停下来之后**不回滚** ——
 * 那是一次写类恢复，会让压电再动一次；软停的语义是「停手」，把仪器搬回去是
 * E_STOP / 用户的事。**停在哪儿说清楚就是了**，那句话在 `stopped_where` 里。
 */
import {
  CALIB_RESPONSE_MAX,
  CALIB_RESPONSE_MIN,
  CALIB_STEP_DEG,
  CONVERGENCE_RATIO,
  MAX_ITERATIONS,
  TILT_CAL_MAX_COND,
  calibResponseInRange,
  clampTiltAxis,
  cond2x2,
  formatSiReadable,
  getConfigNum,
  getTiltCalibration,
  pyFixed,
  pyFloatRepr,
  responseToG,
  setTiltCalibration,
  tiltConverging,
  tiltDelta,
  tiltSubSteps,
  tiltThresholds,
  type Matrix2,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { zSpanForFrame, circleTiltResolutionDeg } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { body, num } from '../l0/common.js'
import { runSubSkill } from './run-sub.js'

/** Python 的 `f"{x:.{n}f}"`。 */
function f(x: number, n: number): string {
  return pyFixed(x, n)
}

/** 回包里的 `(tilt_x, tilt_y)`。读不出给 `null` —— 那是「无法安全回滚」，不是 0。 */
function readTiltOf(rec: SkillCallRecord): [number, number] | null {
  if (rec.error !== undefined && rec.error !== '') return null
  if (body(rec).length < 2) return null
  const x = num(rec, 0)
  const y = num(rec, 1)
  return x === null || y === null ? null : [x, y]
}

async function readTilt(ctx: SkillContext): Promise<[number, number] | null> {
  return readTiltOf(await ctx.safeCall('Piezo_TiltGet'))
}

async function writeTilt(ctx: SkillContext, x: number, y: number): Promise<string> {
  const rec = await ctx.safeCall('Piezo_TiltSet', x, y)
  return rec.error ?? ''
}

/**
 * 软停的统一返回：**不是失败，不是超时，是有人喊停**。
 *
 * `aborted_by_operator` 是给下游用的机器可读位（与 `graph_executor.abort_facts`
 * 同名同义），`where` 是给人看的「停在哪儿了」—— 停下来之后仪器是什么状态，
 * 这句话必须有人说，否则下一个动作是在一个没人描述过的状态上做的。
 */
function stoppedByOperator(where: string): SkillResultLike {
  return {
    success: false,
    error: `aborted by user —— 用户要求停止。${where}`,
    data: {
      aborted: true,
      aborted_by_operator: true,
      abort_reason: 'aborted by user',
      stopped_where: where,
    },
  }
}

/** 跑一次 `TiltProbeCircle`，返回 `(data, error)`。 */
async function measure(
  ctx: SkillContext,
  probe: Readonly<Record<string, unknown>>,
): Promise<{ data: Record<string, unknown> | null; error: string }> {
  const res = await runSubSkill(ctx, 'TiltProbeCircle', probe)
  // Python 的 `getattr(res, "error", "TiltProbeCircle 失败")` —— 那句兜底只在
  // **没有** `error` 属性时出现；空串照样是空串。`runSubSkill` 把 `undefined`
  // 归一成 `''`，所以这里判空串。
  if (!res.success) {
    const e = res.error ?? ''
    return { data: null, error: e === '' ? 'TiltProbeCircle 失败' : e }
  }
  return { data: { ...(res.data ?? {}) }, error: '' }
}

/** `{k: params[k] for k in ("radius_m", "n_points") if params.get(k) is not None}`。 */
function probeParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['radius_m', 'n_points'] as const) {
    const v = params[k]
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

function numOf(d: Readonly<Record<string, unknown>>, k: string): number {
  return Number(d[k])
}

/** Python 的 `float(d.get(k) or fallback)` —— **0 与缺席同义**。 */
function orNum(d: Readonly<Record<string, unknown>>, k: string, fallback: number): number {
  const v = d[k]
  if (v === null || v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return fallback
  return n
}

// ── TiltCalibrate ──────────────────────────────────────────────────────────

export const TiltCalibrate: Skill = {
  spec: S.TiltCalibrateSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const stepRaw = Number(params['step_deg'] ?? 0)
    const step = Number.isFinite(stepRaw) && stepRaw !== 0 ? stepRaw : CALIB_STEP_DEG
    const probe = probeParams(params)

    const orig = await readTilt(ctx)
    if (orig === null) {
      return { success: false, error: '读不到当前压电倾斜(Piezo_TiltGet)—— 无法标定,也无法回滚' }
    }
    const restore = async (): Promise<void> => {
      await writeTilt(ctx, orig[0], orig[1])
    }

    const base = await measure(ctx, probe)
    if (base.data === null) return { success: false, error: `基线测量失败: ${base.error}` }
    const s0: [number, number] = [numOf(base.data, 'tilt_x_deg'), numOf(base.data, 'tilt_y_deg')]

    const responses: [number, number][] = []
    for (const axis of [0, 1] as const) {
      if (ctx.signal.aborted) {
        // 软停：**只停，不动**。不在这里 restore —— 那是一次写类恢复，会让压电再动一次。
        return stoppedByOperator(
          `压电倾斜停在试探步上(原值 ${f(orig[0], 4)}/${f(orig[1], 4)}°,` +
            `当前可能是轴 ${axis} 上 +${pyFloatRepr(step)}° 的试探值)。` +
            '需要的话用 SetPiezoTilt 手动写回原值。',
        )
      }
      const target: [number, number] = [orig[0], orig[1]]
      target[axis] += step
      const werr = await writeTilt(ctx, target[0], target[1])
      if (werr !== '') {
        await restore()
        return { success: false, error: `施加试探步失败(轴 ${axis}): ${werr}` }
      }
      await ctx.sleep(1000)

      const probed = await measure(ctx, probe)
      if (probed.data === null) {
        await restore()
        return { success: false, error: `试探测量失败(轴 ${axis}): ${probed.error}` }
      }
      // 响应是**二维向量**：x 轴的一步可能主要出现在测到的 y 上（轴交换），
      // 这正是要把它解成矩阵而不是两个标量的原因。
      responses.push([
        (numOf(probed.data, 'tilt_x_deg') - s0[0]) / step,
        (numOf(probed.data, 'tilt_y_deg') - s0[1]) / step,
      ])
      await restore()
      await ctx.sleep(1000)
    }

    const r0 = responses[0] as [number, number]
    const r1 = responses[1] as [number, number]
    // M 的**列** = 每个 tilt 轴引起的测量斜率变化。
    const m: Matrix2 = [
      [r0[0], r1[0]],
      [r0[1], r1[1]],
    ]
    const mag0 = Math.hypot(r0[0], r0[1])
    const mag1 = Math.hypot(r1[0], r1[1])
    const data: Record<string, unknown> = {
      step_deg: step,
      response_x: [...r0],
      response_y: [...r1],
      response_mag: [mag0, mag1],
      baseline_tilt_deg: [...s0],
      original_tilt: [...orig],
    }

    const mags = [mag0, mag1]
    for (let i = 0; i < 2; i += 1) {
      const mag = mags[i] as number
      if (!calibResponseInRange(mag)) {
        return {
          success: false,
          error:
            `轴 ${i} 的响应幅度 ${f(mag, 3)} 不在合理区间 ` +
            `[${pyFloatRepr(CALIB_RESPONSE_MIN)}, ${pyFloatRepr(CALIB_RESPONSE_MAX)}] —— ` +
            '该轴可能没有响应,或响应异常。**未写入任何标定**;' +
            '先确认压电倾斜通道接线与当前位置是否够平。',
          data,
        }
      }
    }

    const sol = responseToG(m)
    if (sol.g === null) {
      return { success: false, error: '响应矩阵奇异(两轴响应共线),未写入标定', data }
    }
    const g = sol.g

    // ⚠️ 算不出条件数就**让这个技能失败**，不要编一个数。旧仓这里以前兜底成
    // `cond = 1.0` —— 而 1.0 是条件数的**最优值**，于是拒写闸被彻底解除：
    // 一次没能验证过的标定照样被持久化，而摘要还会把编造的「条件数 1.00」
    // 印给用户当测量值看。**兜底值不是中性的** —— 它恰好是最令人放心、
    // 也就是使检查失效的那个值。
    //
    // 本仓 {@link cond2x2} 是闭式解，**不会抛** ⇒ 旧仓那条 `except` 分支在这里
    // 不可达（登记在 deviations）；`非有限` 那一条照样在，而且它才是真的在挡。
    const cond = cond2x2(m)
    if (!Number.isFinite(cond)) {
      data['matrix_m'] = [[m[0][0], m[0][1]], [m[1][0], m[1][1]]]
      data['matrix_g'] = [[g[0][0], g[0][1]], [g[1][0], g[1][1]]]
      return {
        success: false,
        error:
          `响应矩阵条件数非有限(${pyFloatRepr(cond)})—— 两轴响应实际上共线,` +
          '解出来的矩阵不可靠。**未写入**。',
        data,
      }
    }
    data['matrix_m'] = [[m[0][0], m[0][1]], [m[1][0], m[1][1]]]
    data['matrix_g'] = [[g[0][0], g[0][1]], [g[1][0], g[1][1]]]
    data['cond'] = cond

    const written = setTiltCalibration([[g[0][0], g[0][1]], [g[1][0], g[1][1]]], cond)
    if (!written.ok) {
      // ⚠️ 旧仓这里只有一个 `None`，于是这句话把**所有**拒写原因都说成「条件数超上限」。
      // 本仓的 `setTiltCalibration` 把理由带出来了，所以宿主没接写口那一条另说
      // （见 deviations 批 7a-1）——其余照旧仓逐字。
      if (written.why === 'no_sink') {
        return {
          success: false,
          error:
            '标定算出来了,但宿主没有接档案写口(processInstrumentProfile.write 未注入)—— ' +
            '**未写入**。这不等于「条件数超限」,该做的事完全不同。',
          data,
        }
      }
      return {
        success: false,
        error:
          `标定被拒绝(条件数 ${f(cond, 1)} 超过上限 ${pyFloatRepr(TILT_CAL_MAX_COND)})—— ` +
          '两轴响应几乎共线,解出来的矩阵不可靠。**未写入**。',
        data,
      }
    }

    data['stored'] = {
      g: [[g[0][0], g[0][1]], [g[1][0], g[1][1]]],
      cond: written.cal.state === 'ok' ? written.cal.cond : null,
      updated_at: written.cal.state === 'ok' ? written.cal.updatedAt : null,
    }
    return {
      success: true,
      data,
      summary: `倾斜响应标定完成:条件数 ${f(cond, 2)},响应幅度 ${f(mag0, 2)}/${f(mag1, 2)}`,
    }
  },
}

// ── AutoTilt ───────────────────────────────────────────────────────────────

/**
 * 标定读出来的 `G`，**没标定过给 `null`**。
 *
 * ⚠️ 提成一个**有声明返回类型**的函数，而不是内联的 `if (calib.state === 'never')`
 * —— 理由与 `vision/plane.ts` 的 `refitOnInliers` 一字不差：内联时一条把这道闸拆掉的
 * 变异会让 TS **连带撤掉后面 `calib.g` 的收窄**，于是变异编不过，
 * 而「一条编不过的变异，那道闸就永远验不到」。声明类型挡住了流收窄。
 */
function tiltMatrixOf(calib: ReturnType<typeof getTiltCalibration>): Matrix2 | null {
  return calib.state === 'ok' ? calib.g : null
}

/** `next_frame_m` 给了就用它，否则问 `Scan_FrameGet`，再否则 100 nm 兜底。 */
async function frameDiagonal(ctx: SkillContext, params: Readonly<Record<string, unknown>>): Promise<number> {
  const explicit = params['next_frame_m']
  // Python 的 `if explicit:` —— **0 与缺席同义**。
  if (explicit !== undefined && explicit !== null && explicit !== '' && Number(explicit) !== 0) {
    const side = Number(explicit)
    return Math.hypot(side, side)
  }
  const rec = await ctx.safeCall('Scan_FrameGet')
  if (rec.error === undefined || rec.error === '') {
    const b = body(rec)
    if (b.length >= 4) {
      const w = num(rec, 2)
      const h = num(rec, 3)
      if (w !== null && h !== null) return Math.hypot(Math.abs(w), Math.abs(h))
    }
  }
  return Math.hypot(1e-7, 1e-7) // 100 nm 兜底
}

export const AutoTilt: Skill = {
  spec: S.AutoTiltSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const maxIterRaw = Number(params['max_iterations'] ?? 0)
    const maxIter = Math.trunc(Number.isFinite(maxIterRaw) && maxIterRaw !== 0 ? maxIterRaw : MAX_ITERATIONS)
    const force = Boolean(params['force'] ?? false)
    const probe = probeParams(params)

    const report = (outcome: string, reason: string, extra: Record<string, unknown> = {}): SkillResultLike => {
      const data: Record<string, unknown> = { outcome, reason, ...extra }
      const ok = outcome === 'applied' || outcome === 'no_action_needed'
      return {
        success: ok,
        error: ok ? '' : `${outcome}: ${reason}`,
        data,
        summary: reason !== '' ? `AutoTilt: ${outcome}(${reason})` : `AutoTilt: ${outcome}`,
      }
    }

    // ① 标定 —— 没有它绝不动硬件
    const calib = getTiltCalibration()
    const g = tiltMatrixOf(calib)
    if (g === null) {
      if (calib.state === 'unreadable') {
        // 旧仓没有这一态（它的档案是进程内的一份 dict，永远读得到）。
        // **「读不到档案」与「从未标定过」该做的事完全不同**，所以 reason 也不同。
        return report('skipped', 'calibration_unreadable', {
          next_action_hint: 'fix_profile_host',
          detail: calib.why,
        })
      }
      return report('skipped', 'calibration_missing', {
        next_action_hint: 'run_tilt_calibrate',
        detail:
          '这台仪器还没做过倾斜响应标定。Piezo_TiltSet 的轴对应与' +
          '符号取决于接线,猜错方向会把倾斜往反方向加倍 —— ' +
          '先跑一次 TiltCalibrate。',
      })
    }

    // ② 原始倾斜（回滚目标是**它**，不是 0）
    const orig = await readTilt(ctx)
    if (orig === null) {
      return report('failed', 'tilt_unreadable', { detail: '读不到当前压电倾斜,无法安全回滚' })
    }

    const diag = await frameDiagonal(ctx, params)

    // ③ 测量
    const first = await measure(ctx, probe)
    if (first.data === null) {
      return report('skipped', 'measure_failed', { detail: first.error, next_action_hint: 'survey_first' })
    }

    const resolution = circleTiltResolutionDeg(
      orNum(first.data, 'noise_floor_m', 0.0),
      orNum(first.data, 'radius_m', 1.0),
      Math.trunc(orNum(first.data, 'n_points', 1)),
    )

    const zRange = getConfigNum('z_range_m', 1.5e-6)
    const surfaceRms = params['surface_rms_m']
    const th = tiltThresholds(
      surfaceRms === null || surfaceRms === undefined || surfaceRms === '' ? null : Number(surfaceRms),
      zRange,
    )
    let span = zSpanForFrame(numOf(first.data, 'slope_mag_deg'), diag)
    let accept = th.accept

    const before = {
      tilt_x_deg: orig[0],
      tilt_y_deg: orig[1],
      measured_slope_deg: numOf(first.data, 'slope_mag_deg'),
      z_span_m: span,
      z_span_frac: zRange > 0 ? span / zRange : 0.0,
    }
    // 用的是哪个矩阵，必须跟着**每一份**回包走 —— 否则拿到一句「diverged」的人
    // 无法判断是标定的问题还是控制律的问题，只能去 ssh 读 profile
    // （旧仓 2026-08-10 真机上就是这么定位的）。
    const common: Record<string, unknown> = {
      matrix_g: [[g[0][0], g[0][1]], [g[1][0], g[1][1]]],
      matrix_g_cond: calib.state === 'ok' ? calib.cond : null,
      before,
      frame_diagonal_m: diag,
      trigger_z_span_m: th.trigger,
      accept_z_span_m: accept,
      hard_limit_z_span_m: th.hard,
      measurement_resolution_deg: resolution,
      site: {
        x_m: first.data['center_x_m'] ?? null,
        y_m: first.data['center_y_m'] ?? null,
        radius_m: first.data['radius_m'] ?? null,
        from: 'current_position',
      },
    }

    // ④ 闸门
    if (span <= th.trigger && !force) {
      return report('no_action_needed', span < th.hard ? 'within_budget' : '', common)
    }

    // 验收阈不能低于测量分辨率 —— 否则「残余倾斜没达标」只是在追噪声。
    const minAcceptSpan = zSpanForFrame(resolution * 2.0, diag)
    if (accept < minAcceptSpan) {
      accept = minAcceptSpan
      common['accept_z_span_m'] = accept
      common['accept_raised_to_resolution'] = true
    }

    // ⑤ 迭代：施加 → 复测 → 验收 / 收敛 / 回滚
    const history: Record<string, unknown>[] = []
    let current: [number, number] = [orig[0], orig[1]]
    let latest = first.data
    let appliedAny = false

    for (let i = 0; i < maxIter; i += 1) {
      const slope: [number, number] = [numOf(latest, 'tilt_x_deg'), numOf(latest, 'tilt_y_deg')]
      const delta = tiltDelta(g, slope[0], slope[1])

      const mag = Math.hypot(delta[0], delta[1])
      const nSub = tiltSubSteps(mag)
      const limit = getConfigNum('tilt_limit_deg', 5.0)

      let truncated = false
      const subStep: [number, number] = [delta[0] / nSub, delta[1] / nSub]
      for (let k = 0; k < nSub; k += 1) {
        if (ctx.signal.aborted) {
          // 软停：停在当前这一小步上，**不回滚**。小步本来就是为了
          // 「随时停下都还在安全范围内」而拆的。
          return stoppedByOperator(
            `倾斜停在 ${f(current[0], 4)}/${f(current[1], 4)}°` +
              `(第 ${i + 1}/${maxIter} 轮的第 ${k}/${nSub} 小步)。` +
              '每一小步都在限幅内,停在这里是安全的。',
          )
        }
        const target: [number, number] = [current[0] + subStep[0], current[1] + subStep[1]]
        for (const axis of [0, 1] as const) {
          const c = clampTiltAxis(target[axis], limit)
          target[axis] = c.value
          if (c.truncated) truncated = true
        }
        const werr = await writeTilt(ctx, target[0], target[1])
        if (werr !== '') {
          // 写失败 → 回到原始倾斜。这里**要**回滚：前面的小步已经写进去了，
          // 把针尖留在一个走了一半的补偿量上比不补偿更糟。
          await writeTilt(ctx, orig[0], orig[1])
          return report('failed', 'hw_reject', { detail: werr, history, ...common })
        }
        current = target
        appliedAny = true
        await ctx.sleep(1000)
      }

      const verify = await measure(ctx, probe)
      if (verify.data === null) {
        await writeTilt(ctx, orig[0], orig[1])
        return report('rolled_back', 'verify_failed', { detail: verify.error, history, ...common })
      }

      const newSpan = zSpanForFrame(numOf(verify.data, 'slope_mag_deg'), diag)
      // 逐轮必须留下**能重算这一步**的东西，不只是结果。
      //
      // 旧仓 2026-08-10 真机：回包只有 `rolled_back(diverged)` 加一串**幅度**
      // （`residual_slope_deg` 是一个标量），于是「这一轮到底往哪个方向走了多少」
      // 在回包里**根本不存在** —— 定位只能靠 ssh 读 ui_settings.json 拿矩阵、
      // 再反推谱半径。**一个只报结论不报过程的判据，在它出错时无法被诊断。**
      history.push({
        iteration: i + 1,
        slope_in_deg: [slope[0], slope[1]],
        delta_tilt_deg: [delta[0], delta[1]],
        n_sub_steps: nSub,
        applied_tilt: [current[0], current[1]],
        residual_slope_vec_deg: [verify.data['tilt_x_deg'] ?? null, verify.data['tilt_y_deg'] ?? null],
        residual_slope_deg: numOf(verify.data, 'slope_mag_deg'),
        residual_z_span_m: newSpan,
        truncated_at_limit: truncated,
      })

      if (newSpan <= accept) {
        return report('applied', '', {
          after: {
            tilt_x_deg: current[0],
            tilt_y_deg: current[1],
            measured_slope_deg: numOf(verify.data, 'slope_mag_deg'),
            z_span_m: newSpan,
          },
          applied: { tilt_x_deg: current[0], tilt_y_deg: current[1] },
          iterations: i + 1,
          history,
          ...common,
        })
      }

      if (!tiltConverging(newSpan, span)) {
        // 没在收敛 —— 标定失效 / 表面变了 / 针尖事件。回到**原始**倾斜。
        await writeTilt(ctx, orig[0], orig[1])
        return report('rolled_back', 'diverged', {
          // `detail` 是给**人**读的那句话（它会被旁白原样念出去），所以数字走可读 SI，
          // 不是 `%g` —— 后者把 6.4 nm 印成 `6.4e-09 m`，一个用户当场比不出大小的形状。
          detail:
            `第 ${i + 1} 轮后残余 Z 占用 ${formatSiReadable(newSpan, 'm')},` +
            `未降到上一轮 ${formatSiReadable(span, 'm')} 的 ${pct0(CONVERGENCE_RATIO)} 以下`,
          iterations: i + 1,
          history,
          ...common,
        })
      }

      span = newSpan
      latest = verify.data
    }

    // 迭代用尽仍未达标：保留已改善的结果，但如实说没达标。
    //
    // ⚠️ 下面那句 `applied: appliedAny ? … : null` 里的 **null 那一支不可达**，
    // 三步（都可以 grep 核）：
    //   1. `maxIter ≥ 1`（`0 || MAX_ITERATIONS`，而参数下界是 1）；
    //   2. `tiltSubSteps(…) ≥ 1`（`Math.max(1, …)`）；
    //   3. 小步里唯一的出口是**写失败早退**与**软停早退**，两条都不会走到这里。
    // ⇒ 走到轮数用尽时至少写成过一次 ⇒ `appliedAny === true`。
    // **保留它**：`maxIter` 哪天允许 0 就用得上了；在那之前它是一段没有闸的代码，
    // 所以这一族的变异按 green-8 §2.8 改打在真正做决定的那一行
    // （`max_iterations` 的「0 与缺席同义」）上。
    return report('failed', 'not_converged', {
      detail:
        `${maxIter} 轮后残余 Z 占用 ${formatSiReadable(span, 'm')} 仍高于验收阈 ` +
        `${formatSiReadable(accept, 'm')}`,
      after: { tilt_x_deg: current[0], tilt_y_deg: current[1], z_span_m: span },
      applied: appliedAny ? { tilt_x_deg: current[0], tilt_y_deg: current[1] } : null,
      iterations: maxIter,
      history,
      ...common,
    })
  },
}

/** Python 的 `f"{x:.0%}"` —— `0.7` → `"70%"`。 */
function pct0(x: number): string {
  return `${pyFixed(x * 100, 0)}%`
}
