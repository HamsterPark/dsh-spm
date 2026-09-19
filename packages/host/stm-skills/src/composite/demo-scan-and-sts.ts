/**
 * `DemoScanAndSTS` —— **仅供演示**的一次「扫一张图 + 采几条谱」。
 *
 * 它刻意**跳过全部针尖质量检查**（`AssessImageQuality` / `ConditionTip` /
 * `TipShape` / `PreScanCheck`），六个固定步骤加每个谱点两步。
 * 存在的理由写在旧仓模块抬头上：现场演示时要一条**不由模型二次判断**的确定序列。
 *
 * ## 两处「报告，但不判死」—— 而它们是两个**不同**的事实
 *
 * | 字段 | 说的是 |
 * |---|---|
 * | `scan_saved` | 存盘那一步成了没有（`optional: true`） |
 * | `scan_completed` | **这一帧扫完了没有**（超时 / 中途停 都算没完） |
 *
 * 两者分开，是因为**一张截断的帧可以存得好好的** —— 那样磁盘上的 `.sxm`
 * 对下游所有人来说都像一张完整的图。旧仓 v6.1.3 之前两个标志一个都没消费
 * （KNOWN_ISSUES §2.24）。
 *
 * 「报告而不中止」是一个**判断**，旧仓把理由写下来了，照移：
 *
 * 1. 谱点**不来自这张图** —— `buildStsPositions` 只用 (中心, 边长) 算，
 *    一张截断的帧作废不了任何一条谱。为一步不相干的失败把好数据扔掉不划算；
 * 2. 同文件已有先例：`SaveScan` 就是 `optional: true` + 把结果**报出来**；
 * 3. 这个技能是给现场演示用的 —— 演示到一半变成硬失败，正好与它的用途相反。
 *
 * **不许发生的是把那一帧当成完整的图交出去。**
 *
 * ## `plan_dynamic` 只做一件事：移动失败就**跳掉**那一点的谱
 *
 * 静态 `plan()` 仍然在（步数断言与续跑记账靠它），执行器走的是动态那一版：
 * `move_N` 落在 `failedSteps` 里 ⇒ `sts_N` 整个不排。
 * ⚠️ 判据是 `failedSteps`，**不是** `completedSteps` —— 续跑被跳过的移动在
 * `completedSteps` 里，它仍然应当**放行**后面的谱（那一点上次真的移到了）。
 *
 * ## `sts_failed` 是个**累加器**，不是 `total − succeeded` 算出来的
 *
 * 两个计数都由钩子实时维护：成功那条走 `onStepResult`，失败那条走
 * `onStepFailed`（同时盖住「采谱失败」与「移动失败、谱被跳掉」两种）。
 * 拿 `sts_total − sts_succeeded` 反推会在续跑与「还在路上的点」上给错数。
 */
import {
  GraphExecutor,
  progressToDict,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { runSubSkill } from './run-sub.js'

function numOr(p: Readonly<Record<string, unknown>>, k: string, d: number): number {
  const v = p[k]
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * 谱点表。`sts_count ≤ 5` 走历史布局（中心 + 内接正方形四角，偏移 `size/3`）；
 * 更多点时铺一张**真的**网格。
 *
 * ⚠️ 超过 5 个点从前是**拿中心坐标补齐**的 —— 于是每一条「多出来的」谱
 * 都在同一个点上重测一遍，却被当成一次独立测量交出去。
 */
export function buildStsPositions(
  cx: number, cy: number, size: number, stsCount: number,
): [number, number][] {
  const offset = size / 3.0
  if (stsCount <= 5) {
    const corners: [number, number][] = [
      [cx, cy],
      [cx - offset, cy - offset],
      [cx + offset, cy - offset],
      [cx + offset, cy + offset],
      [cx - offset, cy + offset],
    ]
    return corners.slice(0, Math.max(0, stsCount))
  }
  // 能装下 `stsCount` 个不同点的最小 n×n，按行优先取前 `stsCount` 个。
  let n = Math.ceil(Math.sqrt(stsCount))
  if (n < 2) n = 2
  const span = 2.0 * offset
  const step = span / (n - 1)
  const out: [number, number][] = []
  for (let iy = 0; iy < n; iy += 1) {
    for (let ix = 0; ix < n; ix += 1) {
      out.push([cx - offset + ix * step, cy - offset + iy * step])
      if (out.length === stsCount) return out
    }
  }
  return out.slice(0, stsCount)
}

class Demo {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  /** 静态计划：6 个固定步骤 + 每个谱点两步。 */
  #plan(): CompositeStep[] {
    const p = this.#params
    const cx = numOr(p, 'center_x_m', 0.0)
    const cy = numOr(p, 'center_y_m', 0.0)
    const size = numOr(p, 'scan_size_m', 50e-9)
    const lineTime = numOr(p, 'line_time_s', 0.1)
    const stsCount = Math.trunc(numOr(p, 'sts_count', 5))
    const scanTimeout = numOr(p, 'scan_timeout_s', 180.0)
    const speed = lineTime > 0 ? size / lineTime : 200e-9

    const steps: CompositeStep[] = [
      {
        stepId: 'configure_scan',
        skillName: 'ConfigureScan',
        params: { center_x_m: cx, center_y_m: cy, width_m: size, height_m: size },
        optional: false, checkpointAfter: false, tags: ['setup', 'scan'],
      },
      {
        stepId: 'set_scan_speed',
        skillName: 'SetScanSpeed',
        params: {
          fwd_speed: speed, bwd_speed: speed,
          fwd_line_time: lineTime, bwd_line_time: lineTime, keep_const: 0,
        },
        optional: false, checkpointAfter: false, tags: ['setup', 'scan'],
      },
      {
        stepId: 'start_scan', skillName: 'StartScan', params: {},
        optional: false, checkpointAfter: false, tags: ['scan'],
      },
      {
        stepId: 'wait_scan', skillName: 'WaitScanComplete',
        params: { timeout_ms: Math.trunc(scanTimeout * 1000) },
        optional: false, checkpointAfter: true, tags: ['scan', 'wait'],
      },
      {
        stepId: 'save_scan', skillName: 'SaveScan', params: { timeout_ms: 30000 },
        optional: true, // 尽力而为；与 v1 同，失败不致命
        checkpointAfter: true, tags: ['scan', 'save'],
      },
      {
        stepId: 'configure_sts', skillName: 'ConfigureSTS',
        params: {
          start_v: numOr(p, 'sts_start_v', -1.0),
          end_v: numOr(p, 'sts_end_v', 1.0),
          num_points: Math.trunc(numOr(p, 'sts_num_points', 100)),
        },
        optional: false, checkpointAfter: false, tags: ['setup', 'sts'],
      },
    ]
    buildStsPositions(cx, cy, size, stsCount).forEach(([x, y], i) => {
      const idx = i + 1
      steps.push({
        stepId: `move_${idx}`, skillName: 'MoveToXY',
        params: { x_m: x, y_m: y, wait: true },
        optional: true, checkpointAfter: false, tags: ['sts', 'move', `point=${idx}`],
      })
      steps.push({
        stepId: `sts_${idx}`, skillName: 'AcquireSTS', params: {},
        optional: true, checkpointAfter: true, tags: ['sts', 'acquire', `point=${idx}`],
      })
    })
    return steps
  }

  *#planDynamic(): Generator<CompositeStep> {
    for (const step of this.#plan()) {
      if (step.stepId.startsWith('sts_')) {
        const moveId = `move_${step.stepId.slice('sts_'.length)}`
        // **本次调用**里失败的移动才跳；续跑跳过的移动在 `completedSteps` 里，放行。
        if (this.#ex.progress.failedSteps.includes(moveId)) continue
      }
      yield step
    }
  }

  #bump(key: string): void {
    this.#ex.setPartial(key, Math.trunc(Number(this.#ex.progress.partialData[key] ?? 0)) + 1)
  }

  #onStepResult(step: CompositeStep, res: StepResult): void {
    if (step.stepId.startsWith('sts_')) {
      this.#bump('sts_succeeded')
      return
    }
    if (step.stepId === 'save_scan') {
      this.#ex.setPartial('scan_saved', true)
      return
    }
    if (step.stepId !== 'wait_scan') return
    const data = (res.data ?? {}) as Record<string, unknown>
    const timedOut = data['timed_out'] === true
    const stoppedEarly = data['stopped_early'] === true
    const outcome =
      data['outcome'] !== null && data['outcome'] !== undefined && data['outcome'] !== ''
        ? String(data['outcome'])
        : timedOut ? 'timed_out' : stoppedEarly ? 'stopped_early' : 'completed'
    this.#ex.setPartial('scan_completed', !(timedOut || stoppedEarly))
    this.#ex.setPartial('scan_outcome', outcome)
    this.#ex.setPartial('scan_lines_done', data['lines_done'] ?? null)
    this.#ex.setPartial('scan_lines_total', data['lines_total'] ?? null)
  }

  #onStepFailed(step: CompositeStep, _msg: string): boolean {
    if (step.stepId.startsWith('sts_') || step.stepId.startsWith('move_')) {
      this.#bump('sts_failed')
    } else if (step.stepId === 'save_scan') {
      this.#ex.setPartial('scan_saved', false)
    }
    return step.optional === true
  }

  #aggregate(): Record<string, unknown> {
    const pd = this.#ex.progress.partialData
    return {
      scan_size_m: pd['scan_size_m'] ?? null,
      scan_center: pd['scan_center'] ?? null,
      scan_saved: Boolean(pd['scan_saved'] ?? false),
      // 只有 wait 那一步**从没跑过**时才缺省 True（没有任何东西反驳它）；
      // 真跑过一次，钩子一定会显式写下来。
      scan_completed: Boolean(pd['scan_completed'] ?? true),
      scan_outcome: pd['scan_outcome'] ?? null,
      scan_lines_done: pd['scan_lines_done'] ?? null,
      scan_lines_total: pd['scan_lines_total'] ?? null,
      sts_total: Math.trunc(Number(pd['sts_total'] ?? 0)),
      sts_succeeded: Math.trunc(Number(pd['sts_succeeded'] ?? 0)),
      sts_failed: Math.trunc(Number(pd['sts_failed'] ?? 0)),
    }
  }

  async run(): Promise<SkillResultLike> {
    const p = this.#params
    this.#ex = new GraphExecutor('DemoScanAndSTS', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
      onStepResult: (step, res) => this.#onStepResult(step, res),
      onStepFailed: (step, msg) => this.#onStepFailed(step, msg),
    })
    this.#ex.setPartial('scan_size_m', numOr(p, 'scan_size_m', 50e-9))
    this.#ex.setPartial('scan_center', [numOr(p, 'center_x_m', 0.0), numOr(p, 'center_y_m', 0.0)])
    this.#ex.setPartial('sts_total', Math.trunc(numOr(p, 'sts_count', 5)))
    this.#ex.setPartialDefault('sts_succeeded', 0)
    this.#ex.setPartialDefault('sts_failed', 0)
    this.#ex.setPartialDefault('scan_saved', false)

    const allGood = await this.#ex.runPlan(this.#planDynamic())
    const data = this.#aggregate()
    data['_progress'] = progressToDict(this.#ex.progress)
    if (allGood) return { success: true, data }
    return {
      success: false,
      error: this.#ex.progress.abortedReason || 'DemoScanAndSTS aborted',
      data,
    }
  }
}

export const DemoScanAndSTS: Skill = {
  spec: S.DemoScanAndSTSSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => new Demo(ctx, params).run(),
}
