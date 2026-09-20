/**
 * `TrackDrift_ReferenceScan` —— 拿一张参考图跟踪样品漂移，并按测得的漂移
 * 平移扫描框。
 *
 * ## 半动态计划：步数小而已知，**排不排最后一步**要看互相关的结果
 *
 * `SetBias` → `FullScan` →（在两次 yield **之间**）抓帧 + 读参考图 + 互相关
 * →（漂移显著才排）`ConfigureScan`。
 * 分析不做成子技能，是因为旧仓 v1 就是直接 `safe_call("Scan_FrameDataGrab")`
 * 加进程内的 numpy/scipy —— 照移这个形状。
 *
 * ## 第一次调用**要留下一张参考图**，不是留一句「下次带参数来」
 *
 * 没给 `ref_image_path` 时这一趟就是「采参考」：抓到的帧存成
 * `experiments/frames/drift_ref_<ms>.npy`，路径原样交回去。
 * 旧仓原来把 `current_image` 丢掉、只说一句「再调一次，带上 ref_image_path」
 * —— 而它从没产出过那个路径，整条流程是个死胡同（2026-07-03 复核）。
 *
 * 抓不到帧 / 存不下去 ⇒ **abort**，而两句话不一样：一句是「仪器没给出可用的
 * 二维数据」，一句是「抓到了但写不下去」。合成一句会把人送去查错的地方。
 *
 * ## `_compute_drift` 的三条，每一条都改得动答案
 *
 * 1. **两张图各自减自己的均值**（不是减同一个数）；
 * 2. 尺寸对不上 ⇒ **0 漂移**（并留一条日志），不是报错、也不是缩放；
 * 3. `dx` 取的是峰的**列**偏移、`dy` 取**行**偏移，像素尺寸是
 *    `scan_width_m / ref.shape[1]`（**列数**，即使图不是方的）。
 *    反过来用在方图上看不出来 —— 而方图正是它平时吃的东西。
 *
 * 出事一律回 `(0, 0)`：这个技能的产物是一个**补偿量**，而一个算错的补偿量
 * 会主动把框挪到别处去。「没测出来」比「测出一个错的」安全。
 *
 * ## 显著性闸：`|drift| > 1e-12`（1 pm）
 *
 * 低于它就**不排**补偿那一步，`compensated` 留 `false`。
 * 排了也可能不成 —— 那一步 `optional: true`（v1 用的是 `self.step()`，
 * 不是 `step_or_fail`），失败时漂移照报、`compensated` 仍是 `false`。
 *
 * ## 这一个走的是基类 `_graph_execute`，所以顶层多两件东西
 *
 * `abort_facts`（`aborted` / `aborted_by_operator` / `abort_reason`）
 * 与产物有效性闸。本仓没有 composite 基类（survey7-composite ⚠️ 第 22 条），
 * 于是就地展开：`abortFacts` 有现成的；产物闸在这里是**空过** ——
 * 它的 `data` 里没有任何一个 `_PRODUCT_PATH_KEYS`、也没有 `crash_indicator`，
 * 旧仓那道闸 positive-evidence-only，无证据就放行。写成一句注释而不是
 * 一段永远为真的代码（消融精神）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GraphExecutor,
  abortFacts,
  encodeNpyFrame,
  parseFrameGrab,
  progressToDict,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { correlate2d, decodeNpy, matOf, mean, type Mat } from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { matRows } from '../l0/paper-common.js'
import { runSubSkill } from './run-sub.js'

export interface DriftTrackDeps {
  /** 参考图落在哪个目录。缺省 `<cwd>/experiments/frames`（同 `LoadScanFrameFromFile`）。 */
  readonly framesDir?: () => string
  /** 文件名里那个毫秒戳。缺省真墙钟 —— 金样与测试把它钉住。 */
  readonly stamp?: () => number
}

function numOr(p: Readonly<Record<string, unknown>>, k: string, d: number): number {
  const v = p[k]
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 旧仓 `_compute_drift`。返回米。出任何事都回 `(0, 0)` —— 见抬头。 */
export function computeDrift(
  refImage: Mat, current: Mat | null, scanWidthM: number,
): [number, number] {
  if (current === null) return [0.0, 0.0]
  try {
    if (current.data.length !== refImage.data.length) return [0.0, 0.0]
    // 两张图**各自**减自己的均值（不是减同一个数）。
    const mRef = mean(refImage.data)
    const mCur = mean(current.data)
    const ref = matOf(
      refImage.rows, refImage.cols,
      Float64Array.from(refImage.data, (v) => v - mRef),
    )
    const cur = matOf(
      refImage.rows, refImage.cols,
      Float64Array.from(current.data, (v) => v - mCur),
    )
    const corr = correlate2d(ref, cur)
    let peak = 0
    let best = -Infinity
    for (let i = 0; i < corr.data.length; i += 1) {
      const v = corr.data[i] as number
      if (v > best) {
        best = v
        peak = i
      }
    }
    const py = Math.trunc(peak / corr.cols)
    const px = peak % corr.cols
    const dyPx = py - (ref.rows >> 1)
    const dxPx = px - (ref.cols >> 1)
    const pixelSize = ref.cols > 0 ? scanWidthM / ref.cols : 1e-9
    return [dxPx * pixelSize, dyPx * pixelSize]
  } catch {
    return [0.0, 0.0]
  }
}

class Track {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  readonly #deps: Required<DriftTrackDeps>
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>, deps: DriftTrackDeps) {
    this.#ctx = ctx
    this.#params = params
    this.#deps = {
      framesDir: deps.framesDir ?? ((): string => join(process.cwd(), 'experiments', 'frames')),
      stamp: deps.stamp ?? ((): number => Date.now()),
    }
  }

  /** 抓一帧当前图。**不是子技能** —— 与 v1 一样是一次裸 `safe_call`。 */
  async #grab(): Promise<Mat | null> {
    try {
      const rec = await this.#ctx.safeCall('Scan_FrameDataGrab', 0, 1)
      if ((rec.error !== undefined && rec.error !== '') || rec.values === undefined) return null
      const g = parseFrameGrab(rec.values, true)
      if (g === null || !Array.isArray(g[0])) return null
      const rows = g as number[][]
      const cols = (rows[0] as number[]).length
      const data = new Float64Array(rows.length * cols)
      for (let r = 0; r < rows.length; r += 1) {
        for (let c = 0; c < cols; c += 1) data[r * cols + c] = (rows[r] as number[])[c] as number
      }
      return matOf(rows.length, cols, data)
    } catch {
      return null
    }
  }

  async *#plan(): AsyncGenerator<CompositeStep> {
    const p = this.#params
    const refX = numOr(p, 'ref_x_m', 0)
    const refY = numOr(p, 'ref_y_m', 0)
    const width = numOr(p, 'ref_width_m', 20e-9)
    const bias = numOr(p, 'bias_v', -0.5)
    const refPath = p['ref_image_path'] === null || p['ref_image_path'] === undefined
      ? '' : String(p['ref_image_path'])

    // 1. 参考扫描的偏压。失败**不致命**（v1 走 `self.step()`，不是 `step_or_fail`）。
    yield {
      stepId: 'set_bias', skillName: 'SetBias', params: { bias_v: bias },
      optional: true, checkpointAfter: false, tags: ['setup'],
    }
    if (this.#ex.progress.aborted) return

    // 2. 参考区扫描（必需）。
    yield {
      stepId: 'ref_scan', skillName: 'FullScan',
      params: {
        center_x_m: refX, center_y_m: refY,
        width_m: width, height_m: width, line_time_s: 0.1,
      },
      optional: false, checkpointAfter: true, tags: ['scan'],
    }
    if (this.#ex.progress.aborted) return

    // 3. 抓当前帧（裸 `safe_call`，不是子技能）。
    const current = await this.#grab()

    // 4. 没有参考图 ⇒ **这一趟就是采参考**。
    if (refPath === '') {
      if (current === null) {
        this.#ex.setPartial('ref_image_path', null)
        this.#ex.setPartial(
          'message',
          'Could not grab a reference image (Scan_FrameDataGrab returned no usable 2-D data) ' +
            '— cannot start drift tracking.',
        )
        this.#ex.abort('reference scan grab failed')
        return
      }
      let saved: string
      try {
        const dir = this.#deps.framesDir()
        mkdirSync(dir, { recursive: true })
        saved = join(dir, `drift_ref_${Math.trunc(this.#deps.stamp())}.npy`)
        writeFileSync(saved, encodeNpyFrame(matRows(current)))
      } catch (e) {
        this.#ex.setPartial('ref_image_path', null)
        this.#ex.setPartial('message', `Reference grabbed but could not be saved: ${msg(e)}`)
        this.#ex.abort(`failed to save reference image: ${msg(e)}`)
        return
      }
      this.#ex.setPartial('ref_image_path', saved)
      this.#ex.setPartial('drift_x_m', 0.0)
      this.#ex.setPartial('drift_y_m', 0.0)
      this.#ex.setPartial('compensated', false)
      this.#ex.setPartial(
        'message',
        `Reference captured and saved to ${saved}. Call again with ref_image_path='${saved}' ` +
          'to track drift.',
      )
      return
    }

    // 5. 读参考图。
    let refImage: Mat
    try {
      const a = decodeNpy(new Uint8Array(readFileSync(refPath)))
      const rows = (a.shape[0] as number) || 1
      refImage = matOf(rows, a.values.length / rows, a.values)
    } catch (e) {
      this.#ex.abort(`Failed to load reference: ${msg(e)}`)
      return
    }

    // 6. 互相关求漂移。
    const [dx, dy] = computeDrift(refImage, current, width)
    this.#ex.setPartial('drift_x_m', dx)
    this.#ex.setPartial('drift_y_m', dy)
    this.#ex.setPartial('compensated', false)

    // 7. 显著就补偿。
    if (Math.abs(dx) > 1e-12 || Math.abs(dy) > 1e-12) {
      yield {
        stepId: 'apply_compensation', skillName: 'ConfigureScan',
        params: {
          center_x_m: refX + dx, center_y_m: refY + dy,
          width_m: width, height_m: width,
        },
        optional: true, checkpointAfter: true, tags: ['compensation'],
      }
      if (this.#ex.progress.aborted) return
      const comp = this.#ex.subResults.get('apply_compensation')
      if (comp !== undefined && comp.success === true) this.#ex.setPartial('compensated', true)
    }
  }

  #aggregate(): Record<string, unknown> {
    const pd = this.#ex.progress.partialData
    const data: Record<string, unknown> = {
      drift_x_m: Number(pd['drift_x_m'] ?? 0.0),
      drift_y_m: Number(pd['drift_y_m'] ?? 0.0),
      compensated: Boolean(pd['compensated'] ?? false),
    }
    if ('ref_image_path' in pd) data['ref_image_path'] = pd['ref_image_path'] ?? null
    const m = pd['message']
    if (m !== null && m !== undefined && m !== '') data['message'] = m
    return data
  }

  async run(): Promise<SkillResultLike> {
    this.#ex = new GraphExecutor('TrackDrift_ReferenceScan', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
    })
    const allGood = await this.#ex.runPlan(this.#plan())
    const data = this.#aggregate()
    data['_progress'] = progressToDict(this.#ex.progress)
    // 顶层的中止事实（基类 `_graph_execute` 那一行）：下游判「用户喊停」还是
    // 「它自己失败了」不该去猜一句人话的措辞。
    Object.assign(data, abortFacts(this.#ex.progress))
    // 产物有效性闸在这里必然放行 —— 见文件抬头最后一段。
    if (allGood) return { success: true, data }
    return {
      success: false,
      error: this.#ex.progress.abortedReason || 'composite aborted',
      data,
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function makeTrackDriftReferenceScan(deps: DriftTrackDeps = {}): Skill {
  return {
    spec: S.TrackDrift_ReferenceScanSpec,
    execute: (ctx: SkillContext, params): Promise<SkillResultLike> =>
      new Track(ctx, params, deps).run(),
  }
}

export const TrackDrift_ReferenceScan: Skill = makeTrackDriftReferenceScan()
