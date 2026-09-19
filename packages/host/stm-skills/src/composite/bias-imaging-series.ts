/**
 * `AcquireBiasImagingSeries` —— 同一位置变偏压扫一组图，逐帧判原子分辨质量。
 *
 * ## 这个技能的整个设计是**一把刻度**
 *
 * 偏压序列先按 `|V|` 升序、同 `|V|` 正负相邻（`interleaveBiases`），
 * 然后**把第一个偏压再扫一遍放在末尾**（`repeat_first_at_end`，缺省开）。
 * 首尾两帧同条件，它们的差就是「这段时间里与偏压无关的漂变」——
 * **跨偏压的差异要大于这个比值才算数**。没有它，偏压效应与针尖劣化分不开，
 * 而一个「1.0 V 成像最好」的结论可能只是说「针尖在第三帧时最好」。
 *
 * ## 三道拒绝，各说各的话
 *
 * | | 何时 | `refused` |
 * |---|---|---|
 * | 偏压不够 | 去重之后 < 2 个 | `need_two_biases` |
 * | 框读不到 | 调用方没给、`GetScanFrame` 也没给出来 | `no_scan_frame` |
 * | 每一帧 | 偏压没跟上 / setpoint 被带偏 / 没拿到路径 | 逐帧记进 `frames[].error` |
 *
 * **不猜一个框去扫**：`no_scan_frame` 那一条是拒绝，不是拿个缺省值顶上。
 *
 * ## 每改一次偏压，都要**读回来**确认
 *
 * `SetBias` 报成功只说明命令发出去了。偏压是这个实验唯一的自变量 ——
 * 它没跟上，这一帧就没有意义。两条回读判据：
 *
 * * `|读回 − 要的| > max(1e-3, |要的|·5%)` ⇒ 这一帧记失败，**跳过**后面四步；
 * * `setpoint` 相对变化 > 5% ⇒ 同样记失败 —— 「只变偏压」这句话不成立了。
 *
 * ⚠️ `setpoint` 那一条**只在 `sp` 为真值时**才判（Python 的 `elif sp:`）：
 * 读不到设定点、或者它是 0 时整条判据不存在。照移。
 *
 * ## 整定等待走 `ctx.sleep`，**不是**一个叫 `Wait` 的技能
 *
 * 旧仓那行注释写得很直白：全仓没有那个技能，写成步骤的话每一轮都会被
 * 「未知技能」拒掉，而 `optional=True` 会让这件事悄悄过去（第一版就是这么写的）。
 *
 * ## 它**没有** `GetLatestScanFile` 兜底
 *
 * `save` 那一步拿不到 `saved_path` 就直接记这一帧失败（旧仓
 * `bias_imaging_series.py:249-254`，与 `angle_series_calibration.py:261-267`
 * 的有兜底版**刻意不同**）。所以本仓给 `SaveScan` 注入 `findLatestSxm` 是
 * 这个技能的前置（`l0/scan.ts` 的 `findLatestSxmInSession`，批 7b-3 唯一
 * 改到的共享文件）—— 不接的话每一帧都落进「没拿到文件路径」，
 * 整条流程只会说「成功的帧不足两张」。
 */
import {
  GraphExecutor,
  abortFacts,
  progressToDict,
  resolveLineTime,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { pyG4 } from '../l0/paper-region.js'
import { runSubSkill } from './run-sub.js'

/** 缺省偏压表 —— 与声明里的 `default` 逐字同。 */
export const DEFAULT_BIASES: readonly number[] = [0.02, -0.02, 0.1, -0.1]

/**
 * `"0.02, -0.02; 0.1"` → `[0.02, -0.02, 0.1]`。
 *
 * 全角分号与半角分号都当逗号；转不动的那一段**跳过**（不是拒绝整串）。
 * 空串 / 没给 ⇒ 缺省表。
 */
export function parseBiases(raw: unknown): number[] {
  if (raw === null || raw === undefined || String(raw).trim() === '') return [...DEFAULT_BIASES]
  const out: number[] = []
  for (const part of String(raw).replaceAll('；', ',').replaceAll(';', ',').split(',')) {
    const s = part.trim()
    if (s === '') continue
    const v = Number(s)
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/**
 * 按 `|V|` 升序、同一 `|V|` **正的在前**，并去重。
 *
 * 排序键是 `(|x|, −x)`，于是 `0.1` 排在 `−0.1` 前面。
 * ⚠️ 去重用的是 `v in seen`，即**原值**（不是 `|v|`）—— `0.1` 与 `−0.1` 都留。
 */
export function interleaveBiases(vs: readonly number[]): number[] {
  const sorted = [...vs].sort((a, b) => (Math.abs(a) - Math.abs(b)) || (-a - -b))
  const seen = new Set<number>()
  const out: number[] = []
  for (const v of sorted) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

interface FrameRec {
  bias_v: number
  index: number
  ok: boolean
  error?: string
  path?: string
  verdict?: unknown
  concentration?: unknown
  snr?: unknown
  period_nm?: unknown
  coverage?: unknown
}

function numOrNull(p: Readonly<Record<string, unknown>>, k: string): number | null {
  const v = p[k]
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Python 的 `"%+.4g" % x`。 */
function pySignedG4(x: number): string {
  const s = pyG4(Math.abs(x))
  return x < 0 || Object.is(x, -0) ? `-${s}` : `+${s}`
}

/** Python 的 `"%.0f" % x` —— **banker's rounding**（`.5` 进到偶数）。 */
function pyF0(x: number): string {
  const f = Math.floor(x)
  const d = x - f
  let n: number
  if (d > 0.5) n = f + 1
  else if (d < 0.5) n = f
  else n = f % 2 === 0 ? f : f + 1
  return Object.is(n, -0) ? '-0' : String(n)
}

/** Python 的 `"%.2f" % x`。 */
function pyF2(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : x !== x ? 'nan' : x > 0 ? 'inf' : '-inf'
}

class Series {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  async #runData(name: string): Promise<Record<string, unknown>> {
    const r = await this.#ctx.runSkill(name, {})
    return (r.data ?? {}) as Record<string, unknown>
  }

  async *#plan(): AsyncGenerator<CompositeStep> {
    const p = this.#params
    let biases = interleaveBiases(parseBiases(p['biases_v']))
    if (biases.length < 2) {
      this.#ex.setPartial('refused', 'need_two_biases')
      return
    }
    if (p['repeat_first_at_end'] !== false) biases = [...biases, biases[0] as number]
    this.#ex.setPartial('bias_order', [...biases])

    let cx = numOrNull(p, 'center_x_m')
    let cy = numOrNull(p, 'center_y_m')
    let size = numOrNull(p, 'scan_size_m')
    let sp = numOrNull(p, 'setpoint_a')
    if (cx === null || cy === null || size === null) {
      let fd: Record<string, unknown> = {}
      try {
        fd = await this.#runData('GetScanFrame')
      } catch {
        fd = {}
      }
      cx = cx ?? (fd['center_x_m'] === undefined ? null : Number(fd['center_x_m']))
      cy = cy ?? (fd['center_y_m'] === undefined ? null : Number(fd['center_y_m']))
      size = size ?? (fd['width_m'] === undefined ? null : Number(fd['width_m']))
    }
    if (sp === null) {
      try {
        const sd = await this.#runData('GetSetpoint')
        sp = sd['setpoint_a'] === undefined || sd['setpoint_a'] === null
          ? null : Number(sd['setpoint_a'])
      } catch {
        sp = null
      }
    }
    // `not size` —— **0 也算没有**（Python 的真值判断）。
    if (cx === null || cy === null || size === null || !size) {
      this.#ex.setPartial('refused', 'no_scan_frame')
      return
    }

    const lt = resolveLineTime(p['line_time_s'], size)
    const lineTime = lt.lineTimeS
    const ltSrc = lt.source
    const speed = size / lineTime
    const settle = numOrNull(p, 'settle_s') ?? 3.0
    this.#ex.setPartial('line_time_s', lineTime)
    this.#ex.setPartial('line_time_source', ltSrc)

    const frames: FrameRec[] = [...((this.#ex.progress.partialData['frames'] as FrameRec[]) ?? [])]
    this.#ex.setTotalSteps(biases.length * 5)

    for (let i = 0; i < biases.length; i += 1) {
      const bv = biases[i] as number
      const tag = `b${i + 1}`

      yield {
        stepId: `${tag}:bias`, skillName: 'SetBias', params: { bias_v: bv },
        optional: true, checkpointAfter: false, tags: ['bias', `bias=${bv}`, 'set'],
      }
      if (this.#ex.progress.aborted) return
      // 整定等待：`ctx.sleep`，不是一个叫 `Wait` 的技能（见抬头）。
      if (settle > 0) await this.#ctx.sleep(settle * 1000)

      let bad = ''
      try {
        const got = (await this.#runData('GetBias'))['bias_v']
        const tol = Math.max(1e-3, Math.abs(bv) * 0.05)
        if (got === null || got === undefined || Math.abs(Number(got) - bv) > tol) {
          bad = `偏压没跟上：要 ${pyG4(bv)}，读回 ${got === null || got === undefined ? 'None' : String(got)}`
        } else if (sp) {
          const now = (await this.#runData('GetSetpoint'))['setpoint_a']
          if (now && Math.abs(Math.abs(Number(now)) - Math.abs(sp)) / Math.abs(sp) > 0.05) {
            bad = `setpoint 被带偏了：${pyG4(sp)} -> ${pyG4(Number(now))}`
          }
        }
      } catch (e) {
        bad = `读回失败: ${e instanceof Error ? e.message : String(e)}`
      }
      if (bad !== '') {
        frames.push({ bias_v: bv, index: i, ok: false, error: bad })
        this.#ex.setPartial('frames', [...frames])
        continue
      }

      yield {
        stepId: `${tag}:configure`, skillName: 'ConfigureScan',
        params: {
          center_x_m: cx, center_y_m: cy, width_m: size, height_m: size,
          set_scan_speed: false,
        },
        optional: true, checkpointAfter: false, tags: ['bias', `bias=${bv}`, 'configure'],
      }
      yield {
        stepId: `${tag}:speed`, skillName: 'SetScanSpeed',
        params: {
          fwd_speed: speed, bwd_speed: speed,
          fwd_line_time: lineTime, bwd_line_time: lineTime,
          keep_const: 1, speed_ratio: 1.0,
        },
        optional: true, checkpointAfter: false, tags: ['bias', `bias=${bv}`, 'speed'],
      }
      yield {
        stepId: `${tag}:scan`, skillName: 'FullScan',
        params: {
          center_x_m: cx, center_y_m: cy, width_m: size, height_m: size,
          line_time_s: lineTime,
        },
        optional: true, checkpointAfter: false, tags: ['bias', `bias=${bv}`, 'scan'],
      }
      if (this.#ex.progress.aborted) return
      yield {
        stepId: `${tag}:save`, skillName: 'SaveScan', params: {},
        optional: true, checkpointAfter: true, tags: ['bias', `bias=${bv}`, 'save'],
      }
      const sr = this.#ex.subResults.get(`${tag}:save`)
      const path = ((sr?.data ?? {}) as Record<string, unknown>)['saved_path']
      if (!path) {
        frames.push({ bias_v: bv, index: i, ok: false, error: '没拿到文件路径' })
        this.#ex.setPartial('frames', [...frames])
        continue
      }

      yield {
        stepId: `${tag}:assess`, skillName: 'AssessAtomicResolution',
        params: { scan_path: String(path), allow_reduced_scale: true },
        optional: true, checkpointAfter: false, tags: ['bias', `bias=${bv}`, 'assess'],
      }
      const ad = ((this.#ex.subResults.get(`${tag}:assess`)?.data ?? {}) as Record<string, unknown>)
      frames.push({
        bias_v: bv, index: i, ok: true, path: String(path),
        verdict: ad['verdict'] ?? null,
        concentration: ad['angular_concentration'] ?? null,
        snr: ad['snr'] ?? null,
        period_nm: ad['period_fast_axis_nm'] ?? null,
        coverage: ad['coverage'] ?? null,
      })
      this.#ex.setPartial('frames', [...frames])
    }
  }

  #aggregate(): Record<string, unknown> {
    const pd = this.#ex.progress.partialData
    const frames = [...((pd['frames'] as FrameRec[]) ?? [])]
    const order = [...((pd['bias_order'] as number[]) ?? [])]
    const good = frames.filter((f) => f.ok)
    const out: Record<string, unknown> = {
      refused: pd['refused'] ?? null,
      bias_order: order,
      line_time_s: pd['line_time_s'] ?? null,
      line_time_source: pd['line_time_source'] ?? null,
      frames,
      n_ok: good.length,
    }
    if (pd['refused']) {
      out['advice'] = `被拒：${String(pd['refused'])} —— 一帧都没扫。`
      return out
    }

    // 首尾同条件的两帧之差 = 这段时间里与偏压无关的漂变，是跨 |V| 比较的刻度。
    let driftNote: string | null = null
    if (order.length >= 2 && order[0] === order[order.length - 1]) {
      const first = good.find((f) => f.index === 0)
      const last = good.find((f) => f.index === order.length - 1)
      if (first && last && first.concentration && last.concentration) {
        const a = Number(first.concentration)
        const b = Number(last.concentration)
        const ratio = a ? b / a : NaN
        out['time_drift_ratio'] = ratio
        driftNote =
          `同一偏压 ${pySignedG4(order[0] as number)} V 在开头与结尾的角向集中度：` +
          `${pyF0(a)} → ${pyF0(b)}（比值 ${pyF2(ratio)}）。` +
          '**跨偏压的差异要大于这个比值才算数** —— 否则那只是针尖在这段时间里自己变了。'
        out['time_drift_note'] = driftNote
      }
    }

    if (good.length >= 2) {
      // `max(key=...)` —— 并列时**第一个**赢。
      let best = good[0] as FrameRec
      for (const f of good) {
        if (Number(f.concentration ?? 0) > Number(best.concentration ?? 0)) best = f
      }
      out['best_bias_v'] = best.bias_v
      out['best_concentration'] = best.concentration ?? null
      out['advice'] =
        `成像最好的偏压是 ${pySignedG4(best.bias_v)} V（角向集中度 ` +
        `${pyF0(Number(best.concentration ?? 0))}）。` +
        (driftNote ?? '没有时间对照帧 —— 跨偏压的比较缺一把刻度，下次把 repeat_first_at_end 打开。')
    } else {
      out['advice'] = '成功的帧不足两张，比不了。'
    }
    return out
  }

  async run(): Promise<SkillResultLike> {
    this.#ex = new GraphExecutor('AcquireBiasImagingSeries', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
    })
    const allGood = await this.#ex.runPlan(this.#plan())
    const data = this.#aggregate()
    data['_progress'] = progressToDict(this.#ex.progress)
    // 这一个走的是基类 `_graph_execute` ⇒ 顶层带中止事实
    // （`GridSTS` / `DemoScanAndSTS` / `MoveAtomTo` 自己重写了驱动器，**没有**这三个键）。
    // 产物有效性闸在这里空过：`frames[].path` 不在 `_PRODUCT_PATH_KEYS` 里。
    Object.assign(data, abortFacts(this.#ex.progress))
    if (allGood) return { success: true, data }
    return {
      success: false,
      error: this.#ex.progress.abortedReason || 'composite aborted',
      data,
    }
  }
}

export const AcquireBiasImagingSeries: Skill = {
  spec: S.AcquireBiasImagingSeriesSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => new Series(ctx, params).run(),
}
