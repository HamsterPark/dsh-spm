/**
 * `RunGridExperiment` —— 用 Nanonis 内建的 Pattern 模块跑网格谱学
 * （`builtins.pattern` 的第 7 个，另外 6 个批 3 已落）。
 *
 * 它是本仓**第一个用生成器计划**的组合技能（`src/composite/` 里此前 `function*`
 * 零命中，`runPlan` 的 `AsyncIterable` 那一支至今没有消费方）。形状：
 *
 *     setup_grid → start_experiment → tick_0 … tick_{N−1} → cleanup
 *
 * 轮询步**不是** `optional`：一次 `Pattern_ExpStatusGet` 失败必须中止，
 * 好让模型能暂停并恢复。计划在 `exp_done` 被某一拍置上之后**提前退出循环** ——
 * 那个标志由生成器在两次 `yield` 之间读 `partialData`。
 *
 * ## ⚠️ 超时那条判据读的是**墙钟**，而两侧的钟不是同一个 —— 这一批怎么收的
 *
 * 旧仓 `pattern.py:330-333`（4 行）：
 *
 * ```python
 * start_time = float(partial_data.get("start_time", time.time()))
 * elapsed = time.time() - start_time
 * if elapsed >= self._timeout_s: …停实验、置 timed_out
 * ```
 *
 * `time.time()` 是墙钟，而通用轨迹导出器 `export_skill_traces.py` 把墙钟
 * **钉死成常数**（`_fake_time` 恒回 `1_700_000_000.0`，理由是「重跑逐字节相同」）。
 * 于是那一侧 `elapsed ≡ 0`，超时判据**永远走不到**。
 * 本仓 `SkillContext` 只有单调钟 `now()`（而它正是真机上这条判据成立的钟：
 * `sleep(2)` 在真机上真的过去 2 秒），夹具的 `sleep` 把钟往前拨 ⇒ `elapsed` 真的涨。
 * 批 5b 因此把这个技能整个搁置了：`traces.test.ts` 的 `success` 一项**没有
 * deviation 逃逸口**，而两侧会给出相反的 `success`。
 *
 * **这一批的收法不是给 `success` 开逃逸口，是让两个钟给出同一个答案**，分两处：
 *
 * | 哪一份金样 | 怎么做 | 它验的是什么 |
 * |---|---|---|
 * | `skill_traces.json`（通用驱动器，墙钟钉死） | `PARAM_OVERRIDES` 给 `wait_timeout_s = 11.0` ⇒ `max_ticks = ⌊11/2⌋ = 5`，五拍睡满 **10 s < 11 s** ⇒ **两侧都是「计划跑完、没超时」** | 动词序列、`Pattern_GridSet` 的九个实参、`_progress` 台账 |
 * | `batch7b2.json`（本批专用驱动器，**假钟会走**） | 把 `time.time` 也接到那个会前进的假钟上 ⇒ 旧仓的 `elapsed` 真的涨 ⇒ 超时那一支**真的被录到** | 超时、提前完成、中止、三处下发失败 |
 *
 * 也就是说：`⌊T/2⌋ · 2 < T` 这条算术**是**通用金样那一格的判据 ——
 * 它保证「计划的拍数上限先到」在两个钟上同时成立，而不是碰巧成立。
 * 取 T = 11 而不是缺省的 3600，顺带把那一格从 1800 拍缩到 5 拍
 * （批 5b 实测：3600 那一档一个技能就让 `skill_traces.json` 涨 1.10 MB）。
 */
import {
  GraphExecutor,
  abortErrorText,
  progressToDict,
  pyFloatRepr,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body } from '../l0/common.js'

/** 每 2 秒一次 `Pattern_ExpStatusGet`。 */
export const TICK_INTERVAL_S = 2.0

const PHASE_SETUP = '_phase_setup_grid'
const PHASE_START = '_phase_start_experiment'
const PHASE_TICK_PREFIX = '_phase_tick_'
const PHASE_CLEANUP = '_phase_cleanup'

/** `params.get(k, d)`，缺席或 `null` 走 `d`（`float()` 一个 `None` 会抛）。 */
function numOr(params: Readonly<Record<string, unknown>>, key: string, d: number): number {
  const v = params[key]
  return v === undefined || v === null ? d : Number(v)
}

class GridRun {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor
  #timeoutS = 3600.0

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  /** 墙钟（秒）。本仓只有单调钟，而它正是真机上那条超时判据成立的钟。 */
  #nowS(): number {
    return this.#ctx.now() / 1000
  }

  // ── 动态计划：setup + start + N 拍 + cleanup ──────────────────────────
  //
  // 拍数上限由 `wait_timeout_s / TICK_INTERVAL_S` 封顶，于是界面有一个数，
  // 而我们永远不会转不出来。
  async *#plan(): AsyncGenerator<CompositeStep> {
    const timeout = numOr(this.#params, 'wait_timeout_s', 3600.0)
    const maxTicks = Math.max(1, Math.trunc(timeout / TICK_INTERVAL_S))
    this.#ex.setTotalSteps(3 + maxTicks)
    this.#timeoutS = timeout

    yield {
      stepId: 'setup_grid',
      skillName: PHASE_SETUP,
      params: { ...this.#params },
      optional: false,
      checkpointAfter: false,
      tags: ['setup'],
    }
    if (this.#ex.progress.aborted) return

    yield {
      stepId: 'start_experiment',
      skillName: PHASE_START,
      params: {},
      optional: false,
      checkpointAfter: true, // 实验已经在跑了 —— 落一次盘
      tags: ['start'],
    }
    if (this.#ex.progress.aborted) return

    for (let i = 0; i < maxTicks; i += 1) {
      if (this.#ex.progress.aborted) return
      if (this.#ex.progress.partialData['exp_done'] === true) break
      yield {
        stepId: `tick_${i}`,
        skillName: `${PHASE_TICK_PREFIX}${i}`,
        params: { index: i },
        optional: false,
        checkpointAfter: false,
        tags: ['poll', `i=${i}`],
      }
    }

    // cleanup 总是跑（好让 `SkillResult.data` 形状完整）。
    yield {
      stepId: 'cleanup',
      skillName: PHASE_CLEANUP,
      params: { nx: this.#params['nx'], ny: this.#params['ny'] },
      optional: false,
      checkpointAfter: true,
      tags: ['cleanup'],
    }
  }

  // ── 相分派 ────────────────────────────────────────────────────────────
  async #run(skillName: string, params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    if (skillName === PHASE_SETUP) return this.#setupGrid(params)
    if (skillName === PHASE_START) return this.#startExperiment()
    if (skillName.startsWith(PHASE_TICK_PREFIX)) return this.#tick()
    if (skillName === PHASE_CLEANUP) return this.#cleanup(params)
    return { success: false, error: `Unknown phase: ${skillName}` }
  }

  async #setupGrid(params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    const nx = Math.trunc(Number(params['nx']))
    const ny = Math.trunc(Number(params['ny']))
    const cx = numOr(params, 'center_x_m', 0.0)
    const cy = numOr(params, 'center_y_m', 0.0)
    const w = numOr(params, 'width_m', 100e-9)
    const h = numOr(params, 'height_m', 100e-9)
    const angle = numOr(params, 'angle_deg', 0.0)

    // `Pattern_GridSet(Set_active_pattern, nx, ny, Grid_Scan_frame,
    //                  Center_X_m, Center_Y_m, Width_m, Height_m, Angle_deg)`
    //
    // ⚠️ `Grid_Scan_frame` **必须是 0**：给 1 时 Nanonis 按**当前扫描框**定网格，
    // 并**忽略**下面这几个显式的中心／宽高／转角 —— 用户给的几何被静默丢掉。
    const rec = await this.#ctx.safeCall('Pattern_GridSet', 1, nx, ny, 0, cx, cy, w, h, angle)
    if (rec.error !== undefined && rec.error !== '') {
      return { success: false, error: `Pattern_GridSet failed: ${rec.error}` }
    }
    this.#ex.setPartial('nx', nx)
    this.#ex.setPartial('ny', ny)
    return { success: true, data: {} }
  }

  async #startExperiment(): Promise<StepResult> {
    const rec = await this.#ctx.safeCall('Pattern_ExpStart', 0)
    if (rec.error !== undefined && rec.error !== '') {
      return { success: false, error: `Pattern_ExpStart failed: ${rec.error}` }
    }
    this.#ex.setPartial('start_time', this.#nowS())
    return { success: true, data: {} }
  }

  /**
   * 尽力而为地停掉正在跑的网格实验。**永不抛**；`Stop` 不可用时退到 `Pause`。
   *
   * 老代码只置标志 —— 组合退出之后网格仍在控制器上**无人看管地跑着**
   * （2026-07-03 复核；对照 `WaitScanComplete`，它在中止时把扫描停掉）。
   */
  async #stopPattern(): Promise<void> {
    const rec = await this.#ctx.safeCall('Pattern_ExpStop')
    if (rec.error !== undefined && rec.error !== '') {
      await this.#ctx.safeCall('Pattern_ExpPause', 1)
    }
  }

  async #tick(): Promise<StepResult> {
    // 与 v1 同节拍：读状态之前先睡约 2 s。
    await this.#ctx.sleep(TICK_INTERVAL_S * 1000)

    if (this.#ctx.signal.aborted) {
      await this.#stopPattern()
      this.#ex.setPartial('exp_done', true)
      this.#ex.setPartial('aborted', true)
      return { success: false, error: 'aborted by user — pattern experiment stopped' }
    }

    // 超时（动态计划也封了拍数上限，但用户可以给一个比 `max_ticks × 2 s` 更短的预算）。
    const pd = this.#ex.progress.partialData
    const startTime = typeof pd['start_time'] === 'number' ? pd['start_time'] : this.#nowS()
    const elapsed = this.#nowS() - startTime
    if (elapsed >= this.#timeoutS) {
      await this.#stopPattern()
      this.#ex.setPartial('exp_done', true)
      this.#ex.setPartial('timed_out', true)
      return {
        success: false,
        error: `Grid experiment timed out after ${pyFloatRepr(this.#timeoutS)}s — pattern experiment stopped`,
      }
    }

    const rec = await this.#ctx.safeCall('Pattern_ExpStatusGet')
    if (rec.error !== undefined && rec.error !== '') {
      return { success: false, error: `Pattern_ExpStatusGet failed: ${rec.error}` }
    }
    // 旧仓从三段信封里取 `parsed[2][0]`；本仓 body 就是那一层。
    const b = body(rec)
    const status = b.length > 0 ? b[0] : null
    // status === 0 ⇒ 实验跑完了。
    if (status === 0) {
      this.#ex.setPartial('exp_done', true)
      this.#ex.setPartial('timed_out', false)
    }
    return { success: true, data: { status: status ?? null } }
  }

  #cleanup(params: Readonly<Record<string, unknown>>): StepResult {
    const nx = Math.trunc(Number(params['nx']))
    const ny = Math.trunc(Number(params['ny']))
    this.#ex.setPartial('total_points', nx * ny)
    return { success: true, data: { nx, ny, total_points: nx * ny } }
  }

  // ── 驱动 ──────────────────────────────────────────────────────────────
  async execute(): Promise<SkillResultLike> {
    this.#ex = new GraphExecutor('RunGridExperiment', {
      now: () => this.#ctx.now(),
      run: (skill, params) => this.#run(skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
    })
    this.#ex.setPartialDefault('exp_done', false)
    this.#ex.setPartialDefault('aborted', false)
    this.#ex.setPartialDefault('timed_out', false)

    const allGood = await this.#ex.runPlan(this.#plan())
    const p = this.#ex.progress
    const timedOut = p.partialData['timed_out'] === true
    const aborted = p.partialData['aborted'] === true

    const nxParam = Math.trunc(Number(this.#params['nx']))
    const nyParam = Math.trunc(Number(this.#params['ny']))
    const data: Record<string, unknown> = {
      nx: Math.trunc(Number(p.partialData['nx'] ?? nxParam)),
      ny: Math.trunc(Number(p.partialData['ny'] ?? nyParam)),
      total_points: Math.trunc(Number(p.partialData['total_points'] ?? nxParam * nyParam)),
      _progress: progressToDict(p),
    }

    if (allGood && !timedOut && !aborted) return { success: true, data }

    // 与 v1 一致：超时返回 success=false 并显式说明。
    const timeout = numOr(this.#params, 'wait_timeout_s', 3600.0)
    let error: string
    if (timedOut) {
      error = `Grid experiment timed out after ${pyFloatRepr(timeout)}s`
    } else if (aborted) {
      // 到底是谁停的（操作员中止 / 急停 / 针尖质量停机 / 一个必做步骤失败）——
      // **绝不**一句「是你干的」。
      error = abortErrorText(p)
    } else {
      error = p.abortedReason !== '' ? p.abortedReason : 'RunGridExperiment aborted'
    }
    return { success: false, error, data }
  }
}

export const RunGridExperiment: Skill = {
  spec: S.RunGridExperimentSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => new GridRun(ctx, params).execute(),
}

/** 这一族（`builtins.pattern` 的第 7 个 —— 落了它这个模块 7/7 收口）。 */
export const PATTERN_GRID: Readonly<Record<string, Skill>> = { RunGridExperiment }
