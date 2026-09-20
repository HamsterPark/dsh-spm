/**
 * `GridSTS` —— 在 N×N 栅格上逐点采 STS 谱。每点两步：`MoveToXY` → `AcquireSTS`。
 *
 * ## 这个技能的全部判据是**一次记账**，而它防的是一句假话
 *
 * 一次「移动失败、谱照采」的组合，采到的谱落在**上一个点**上。旧仓从前把它
 * 计进 `succeeded`（2026-07-03 复核），于是一张栅格图里混着几条位置不对的谱，
 * 而它们与真数据**长得一模一样**。现在那些谱进 `suspect`：
 *
 * | 计数 | 它说的是 |
 * |---|---|
 * | `succeeded` | 移动成功**且**采谱成功 —— 这一条谱在它该在的地方 |
 * | `suspect` | 采到了，但**位置不可信**（这一点的 `MoveToXY` 失败过） |
 * | `failed` | `move_*` 或 `sts_*` 自己失败的次数 |
 *
 * ⚠️ 三个数**不互补**：一个点的移动失败会同时给 `failed` +1（移动那一步）
 * 与 `suspect` +1（随后那条谱）。它们是三本账，不是一次划分。照移。
 *
 * ## `total_points` 是 `nx·ny`，不是 `total_steps − 1`
 *
 * 一个点两步，外加开头一个 `configure` ⇒ `total_steps = 1 + 2·nx·ny`。
 * 旧仓原来写 `total_steps − 1`，于是 3×3 的栅格自称 18 个点，
 * 全灭时说「All 18 spectra failed」而实际只有 9 条谱（反馈 #95）。
 * `nx`/`ny` 在执行器起跑**之前**就落进 `partialData`，所以聚合时直接读得回来；
 * 只有「configure 之前就中止」那一路才回落到 `(total_steps − 1) / 2`。
 *
 * ## `points` 用与 `plan()` **同一条公式**重建坐标
 *
 * 不是把 `MoveToXY` 的参数抄下来 —— 那样一次抄错就让地图和针尖去过的地方
 * 各说各话。原点与间距在开跑前落进 `partialData`，聚合时按同一条
 * `c + (i − (n−1)/2)·spacing` 算回来。原点缺失（中止得太早）⇒ **空表**，
 * 而不是一串猜出来的坐标。
 *
 * ## `clear_sidecar()` 那一行**不在这里**
 *
 * 旧仓在 `run_composite` 末尾显式清 sidecar，理由是它绕过了基类
 * `_graph_execute`（那里是唯一清的地方），于是一张跑完的栅格留下的断点
 * 会让**下一张同尺寸的栅格**跳过开头几个点（「第5个点扫描不到」，#95）。
 * 本仓 `GraphExecutor.runPlan` 自己在非中止收尾时就删（`graph-executor.ts` 的
 * ⭐ 那一段）—— **理由保留、动作不重写**（survey7-composite ⚠️ 第 15 条）。
 */
import {
  GraphExecutor,
  progressToDict,
  type CompositeProgress,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { runSubSkill } from './run-sub.js'

/**
 * 逐点记账的上限。这份账随每一个检查点落盘，也是交给记录器的标记表；
 * 20×20 覆盖任何人手动跑的栅格，再大就只留计数（计数仍然说得清全部）。
 */
export const MAX_TRACKED_POINTS = 400

type PointStatus = 'ok' | 'suspect' | 'failed'

function numOr(p: Readonly<Record<string, unknown>>, k: string, d: number): number {
  const v = p[k]
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 栅格点坐标 —— `plan()` 与 `points` **共用**这一条。 */
function gridCoord(center: number, i: number, n: number, spacing: number): number {
  return center + (i - (n - 1) / 2.0) * spacing
}

class Grid {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  #plan(): CompositeStep[] {
    const p = this.#params
    const cx = numOr(p, 'center_x_m', 0)
    const cy = numOr(p, 'center_y_m', 0)
    const nx = Math.trunc(numOr(p, 'nx', 3))
    const ny = Math.trunc(numOr(p, 'ny', 3))
    const spacing = numOr(p, 'spacing_m', 0)
    const steps: CompositeStep[] = [
      {
        stepId: 'configure',
        skillName: 'ConfigureSTS',
        params: {
          start_v: numOr(p, 'start_v', -2.0),
          end_v: numOr(p, 'end_v', 2.0),
          // 兜底值**必须**与声明里的缺省一致（40）。旧仓这里一度写 200，
          // 于是省掉这个参数就悄悄采了声明值五倍的点。
          num_points: Math.trunc(numOr(p, 'num_points', 40)),
        },
        optional: false,
        checkpointAfter: true,
        tags: ['setup'],
      },
    ]
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        steps.push({
          stepId: `move_${ix}_${iy}`,
          skillName: 'MoveToXY',
          params: { x_m: gridCoord(cx, ix, nx, spacing), y_m: gridCoord(cy, iy, ny, spacing), wait: true },
          optional: true, // 一次移动失败 ≠ 整张栅格中止
          checkpointAfter: false,
          tags: ['move', `ix=${ix}`, `iy=${iy}`],
        })
        steps.push({
          stepId: `sts_${ix}_${iy}`,
          skillName: 'AcquireSTS',
          params: {},
          optional: true,
          checkpointAfter: true, // 每采到一条谱落一次检查点
          tags: ['sts', `ix=${ix}`, `iy=${iy}`],
        })
      }
    }
    return steps
  }

  #pd(): Record<string, unknown> {
    return this.#ex.progress.partialData
  }

  #notePoint(suffix: string, status: PointStatus): void {
    const seen = { ...((this.#pd()['point_status'] as Record<string, string>) ?? {}) }
    if (Object.keys(seen).length >= MAX_TRACKED_POINTS && !(suffix in seen)) return
    seen[suffix] = status
    this.#ex.setPartial('point_status', seen)
  }

  #bump(key: string): void {
    this.#ex.setPartial(key, Math.trunc(Number(this.#pd()[key] ?? 0)) + 1)
  }

  #onStepResult(step: CompositeStep, _res: StepResult): void {
    if (!step.stepId.startsWith('sts_')) return
    const suffix = step.stepId.slice('sts_'.length)
    const failedMoves = (this.#pd()['failed_moves'] as string[]) ?? []
    if (failedMoves.includes(suffix)) {
      // 这一点的 `MoveToXY` **失败了** ⇒ 这条谱采在（上一个）错的地方。
      // 不进 `succeeded`（2026-07-03 复核）。
      this.#bump('suspect')
      this.#notePoint(suffix, 'suspect')
      return
    }
    this.#bump('succeeded')
    this.#notePoint(suffix, 'ok')
  }

  #onStepFailed(step: CompositeStep, _msg: string): boolean {
    if (step.stepId.startsWith('move_')) {
      const suffix = step.stepId.slice('move_'.length)
      const fm = [...((this.#pd()['failed_moves'] as string[]) ?? [])]
      if (!fm.includes(suffix)) {
        fm.push(suffix)
        this.#ex.setPartial('failed_moves', fm)
      }
    }
    if (step.stepId.startsWith('move_') || step.stepId.startsWith('sts_')) {
      this.#bump('failed')
      this.#notePoint(step.stepId.slice(step.stepId.indexOf('_') + 1), 'failed')
    }
    return step.optional === true
  }

  #points(pr: CompositeProgress): Record<string, unknown>[] {
    const pd = pr.partialData
    const cx = pd['center_x_m']
    const cy = pd['center_y_m']
    const spacing = pd['spacing_m']
    if (cx === null || cx === undefined || cy === null || cy === undefined || !spacing) return []
    const nx = Math.max(1, Math.trunc(Number(pd['nx'] ?? 0) || 0))
    const ny = Math.max(1, Math.trunc(Number(pd['ny'] ?? 0) || 0))
    if (nx * ny > MAX_TRACKED_POINTS) return []
    const status = (pd['point_status'] as Record<string, string>) ?? {}
    const out: Record<string, unknown>[] = []
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const st = status[`${ix}_${iy}`]
        if (st === undefined) continue // 从没走到（中止 / 续跑跳过）
        out.push({
          x_m: gridCoord(Number(cx), ix, nx, Number(spacing)),
          y_m: gridCoord(Number(cy), iy, ny, Number(spacing)),
          index: iy * nx + ix + 1,
          label: `网格谱 (${ix},${iy})`,
          success: st === 'ok',
          error: st === 'ok' ? null : st === 'suspect' ? '移动失败,谱点位置不可信' : '失败',
        })
      }
    }
    return out
  }

  #aggregate(): Record<string, unknown> {
    const pr = this.#ex.progress
    const pd = pr.partialData
    const nx = Math.max(1, Math.trunc(Number(pd['nx'] ?? 0)))
    const ny = Math.max(1, Math.trunc(Number(pd['ny'] ?? 0)))
    const hasDims = 'nx' in pd && 'ny' in pd
    const totalPoints = hasDims ? nx * ny : Math.max(0, Math.trunc((pr.totalSteps - 1) / 2))
    return {
      total_points: totalPoints,
      succeeded: Math.trunc(Number(pd['succeeded'] ?? 0)),
      failed: Math.trunc(Number(pd['failed'] ?? 0)),
      suspect: Math.trunc(Number(pd['suspect'] ?? 0)),
      nx,
      ny,
      spacing_m: pd['spacing_m'] ?? null,
      points: this.#points(pr),
    }
  }

  async run(): Promise<SkillResultLike> {
    const p = this.#params
    this.#ex = new GraphExecutor('GridSTS', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
      onStepResult: (step, res) => this.#onStepResult(step, res),
      onStepFailed: (step, msg) => this.#onStepFailed(step, msg),
    })
    // 尺寸与原点**在执行器起跑之前**落账 —— 聚合要按同一条公式重建坐标。
    this.#ex.setPartial('nx', Math.trunc(numOr(p, 'nx', 3)))
    this.#ex.setPartial('ny', Math.trunc(numOr(p, 'ny', 3)))
    this.#ex.setPartial('spacing_m', p['spacing_m'] ?? null)
    this.#ex.setPartial('center_x_m', p['center_x_m'] ?? null)
    this.#ex.setPartial('center_y_m', p['center_y_m'] ?? null)
    // 累加器：续跑时要保住上一轮的值。
    this.#ex.setPartialDefault('succeeded', 0)
    this.#ex.setPartialDefault('failed', 0)

    await this.#ex.runPlan(this.#plan())
    const data = this.#aggregate()
    data['_progress'] = progressToDict(this.#ex.progress)

    // **至少一条谱成功**就算成功（部分成功语义，与 v1 同）。
    if (Number(data['succeeded'] ?? 0) > 0) return { success: true, data }
    const reason =
      this.#ex.progress.abortedReason || `All ${String(data['total_points'])} spectra failed`
    return { success: false, error: reason, data }
  }
}

export const GridSTS: Skill = {
  spec: S.GridSTSSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => new Grid(ctx, params).run(),
}
