/**
 * `BatchRegionsScan` —— 把操作员点名的一串区域一个接一个扫过去。
 *
 * 「我要去睡了 —— 给我把这几片地方过一遍」的那个技能。与
 * `SurveySurface_TileScan` 的分工：那一个把**一个**方区域切成规则的 N×N 网格，
 * 这一个扫的是一串**任意的、显式的**区域 —— 中心、尺寸、甚至角度都可以各不相同。
 *
 * ## 每区 4–6 步，全部 `optional: true`
 *
 * 一个坏区域不该毁掉整晚。但**部分成功不是成功** —— 2026-07-27 现场取证：
 * 一次 4 个区域里 3 个被全局安全闸当场拒掉（`center_y_m = 1.7031e-06 violates
 * global safety maximum 1.5e-06`）的批次，在 actions 表里记成 `success = true`，
 * 而那 3 个失败的区域**还带着 `sxm_path`** 进了 `scanned_paths`。
 *
 * 于是这里有三条各自独立的判据：
 *
 * | 判据 | 拆掉它会怎样 |
 * |---|---|
 * | `scanned_paths` **只收成功区域**的路径 | 一个被拒的区域把**上一个区域**的存盘路径当成自己的交出去 |
 * | 0 个成功 ⇒ **失败** | 一次全军覆没报 `success: true` |
 * | 部分成功 ⇒ 成功，但**差额写进 `summary`** | `fail_count` 躺在 `data` 里，而没有人读 data |
 *
 * ## 逐区查档，不是一个速度走到底
 *
 * `line_time_s` **除非用户点名说了一个数，否则别填**：省略时每个区域按**它自己的**
 * 尺寸查档位表。一个批次里的区域尺寸可以差很多，给它们同一个速度，
 * 对其中大多数都是错的。判据在 `kernel/batch-regions.ts:resolveRegionLineTime`。
 *
 * ## `AssessImageQuality` 那一步：**默认不进计划**
 *
 * `assess_quality` 缺省 `false`，而且那一步 `optional: true`。所以这个技能
 * **不欠**那个还没移的技能 —— 盘点（A31）说得对，这里逐字核过。
 * 打开它而那个技能不在时，`ctx.runSkill` 会给一条失败的返回（不是抛），
 * 步骤是可选的 ⇒ 记进 `regions[].error`，整批照跑。
 */
import {
  GraphExecutor,
  progressToDict,
  resolveRegionLineTime,
  validateBatchRegions,
  type BatchRegion,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { runSubSkill } from './run-sub.js'

/**
 * Python `json.loads` 那句话，逐字（同 `l0/pattern.ts` / `l0/tail-l0.ts`）。
 * 位置写死在第 1 列：见 D-JSON-1。
 */
const PY_JSON_ERROR = 'Expecting value: line 1 column 1 (char 0)'

/** `line_time <= 0` 时的兜底扫描速度（m/s）。旧仓同值。 */
const FALLBACK_SPEED_M_S = 200e-9

/** 一个区域的账。`success` 起手是 `true`，任何一步出事把它翻成 `false`。 */
interface RegionRecord {
  index: number
  label: string
  success: boolean
  error?: string
  center_x_m?: unknown
  center_y_m?: unknown
  width_m?: unknown
  height_m?: unknown
  sxm_path?: unknown
  quality?: unknown
  assessment?: Record<string, unknown>
}

/** `region_{i}:{phase}` → `[i, phase]`。认不出给 `null`（那不是区域步）。 */
function parseRegionStep(stepId: string): [number, string] | null {
  if (!stepId.startsWith('region_')) return null
  const at = stepId.indexOf(':')
  const head = at < 0 ? stepId : stepId.slice(0, at)
  const phase = at < 0 ? '' : stepId.slice(at + 1)
  const n = Number(head.split('_')[1])
  if (!Number.isFinite(n)) return null
  return [Math.trunc(n), phase]
}

class Batch {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor
  #regions: readonly BatchRegion[] = []

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  /**
   * `regions` 参数 → 一串区域，或者一句拒绝。
   *
   * 四种「没给」在旧仓是**四句不同的话**，照移：没传 / 不是 JSON / 不是数组 / 空数组。
   * 合成一句会把「你忘了传」与「你传了一个 `{}`」说成同一件事。
   */
  #parse(): { regions: readonly BatchRegion[]; error: string } {
    const raw = this.#params['regions']
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      return { regions: [], error: 'regions is required (a JSON array of region objects).' }
    }
    let items: unknown
    if (Array.isArray(raw)) {
      items = [...raw]
    } else {
      try {
        items = JSON.parse(String(raw))
      } catch {
        return { regions: [], error: `regions is not valid JSON: ${PY_JSON_ERROR}` }
      }
    }
    const parsed = validateBatchRegions(items)
    return parsed.ok ? { regions: parsed.regions, error: '' } : { regions: [], error: parsed.error }
  }

  #plan(regions: readonly BatchRegion[]): CompositeStep[] {
    const channels = this.#params['channels'] ?? 'Z,Current'
    const explicitLineTime = this.#params['line_time_s']
    const waitS =
      typeof this.#params['wait_timeout_s'] === 'number' &&
      Number.isFinite(this.#params['wait_timeout_s'] as number)
        ? (this.#params['wait_timeout_s'] as number)
        : 180.0
    const waitTimeoutMs = Math.trunc(waitS * 1000)
    const saveEach = this.#params['save_each'] !== false
    const assess = this.#params['assess_quality'] === true

    const steps: CompositeStep[] = []
    regions.forEach((r, i) => {
      // **逐区**查档（见文件抬头）。
      const lineTime = resolveRegionLineTime(explicitLineTime, Math.max(r.width_m, r.height_m))
      const speed = lineTime > 0 ? Math.max(r.width_m, r.height_m) / lineTime : FALLBACK_SPEED_M_S
      const tag = [`region=${i}`, `label=${r.label}`]
      steps.push({
        stepId: `region_${i}:configure`,
        skillName: 'ConfigureScan',
        params: {
          center_x_m: r.center_x_m,
          center_y_m: r.center_y_m,
          width_m: r.width_m,
          height_m: r.height_m,
          angle_deg: r.angle_deg,
          channels,
        },
        optional: true,
        checkpointAfter: false,
        tags: ['configure', ...tag],
      })
      steps.push({
        stepId: `region_${i}:speed`,
        skillName: 'SetScanSpeed',
        params: {
          fwd_speed: speed,
          bwd_speed: speed,
          fwd_line_time: lineTime,
          bwd_line_time: lineTime,
          keep_const: 0,
        },
        optional: true,
        checkpointAfter: false,
        tags: ['speed', ...tag],
      })
      steps.push({
        stepId: `region_${i}:start`,
        skillName: 'StartScan',
        params: {},
        optional: true,
        checkpointAfter: false,
        tags: ['start', ...tag],
      })
      steps.push({
        stepId: `region_${i}:wait`,
        skillName: 'WaitScanComplete',
        params: { timeout_ms: waitTimeoutMs },
        optional: true,
        checkpointAfter: true,
        tags: ['wait', ...tag],
      })
      if (saveEach) {
        steps.push({
          stepId: `region_${i}:save`,
          skillName: 'SaveScan',
          params: {},
          optional: true,
          checkpointAfter: false,
          tags: ['save', ...tag],
        })
      }
      if (assess) {
        steps.push({
          stepId: `region_${i}:assess`,
          skillName: 'AssessImageQuality',
          params: {},
          optional: true,
          checkpointAfter: false,
          tags: ['assess', ...tag],
        })
      }
    })
    return steps
  }

  #records(): Record<string, RegionRecord> {
    const pd = this.#ex.progress.partialData
    if (pd['region_records'] === undefined) pd['region_records'] = {}
    return pd['region_records'] as Record<string, RegionRecord>
  }

  #recordFor(i: number): RegionRecord {
    const recs = this.#records()
    let rec = recs[String(i)]
    if (rec === undefined) {
      const label = this.#regions[i]?.label ?? `R${i + 1}`
      rec = { index: i + 1, label, success: true }
      recs[String(i)] = rec
    }
    return rec
  }

  #onStepResult(step: CompositeStep, res: StepResult): void {
    const parsed = parseRegionStep(step.stepId)
    if (parsed === null) return
    const [i, phase] = parsed
    const rec = this.#recordFor(i)
    const data = (res.data ?? {}) as Record<string, unknown>
    if (phase === 'configure') {
      rec.center_x_m = step.params['center_x_m']
      rec.center_y_m = step.params['center_y_m']
      rec.width_m = step.params['width_m']
      rec.height_m = step.params['height_m']
    } else if (phase === 'wait') {
      // 两种「没扫完」都只判**这一个区域**失败，不中止整批 —— 而且**分开写**：
      // 超时要去调 timeout，中途停止要去查是谁停的。合成一句会把人送去调错东西。
      if (data['timed_out'] === true) {
        rec.success = false
        if (rec.error === undefined) rec.error = 'scan timeout'
      } else if (data['stopped_early'] === true) {
        rec.success = false
        const done = data['lines_done']
        const total = data['lines_total']
        const where = done !== null && done !== undefined && total ? ` (${done}/${total} 行)` : ''
        if (rec.error === undefined) rec.error = `scan stopped early${where}`
      }
    } else if (phase === 'save') {
      if (data['saved_path']) rec.sxm_path = data['saved_path']
    } else if (phase === 'assess') {
      if (Object.keys(data).length > 0) {
        rec.quality = data['fft_quality']
        const keep: Record<string, unknown> = {}
        for (const k of ['fft_quality', 'label', 'confidence', 'snr_db']) {
          if (k in data) keep[k] = data[k]
        }
        rec.assessment = keep
      }
    }
  }

  #onStepFailed(step: CompositeStep, msg: string): boolean {
    const parsed = parseRegionStep(step.stepId)
    if (parsed === null) return step.optional === true
    const [i, phase] = parsed
    const rec = this.#recordFor(i)
    rec.success = false
    if (rec.error === undefined) rec.error = `${phase}: ${msg}`
    return step.optional === true
  }

  #aggregate(): Record<string, unknown> {
    const recs = this.#records()
    const ordered: RegionRecord[] = []
    for (let i = 0; i < this.#regions.length; i += 1) {
      const rec = recs[String(i)]
      ordered.push(
        rec ?? {
          index: i + 1,
          label: this.#regions[i]?.label ?? `R${i + 1}`,
          success: false,
          error: 'region not reached',
        },
      )
    }
    const successful = ordered.filter((r) => r.success)
    const rated = successful.filter((r) => r.quality !== null && r.quality !== undefined)
    let best: RegionRecord | null = null
    for (const r of rated) {
      if (best === null || (r.quality as number) > (best.quality as number)) best = r
    }
    return {
      region_count: this.#regions.length,
      regions: ordered,
      success_count: successful.length,
      fail_count: ordered.length - successful.length,
      // **只有成功的区域**贡献路径。见文件抬头那张表第一行（2026-07-27）。
      scanned_paths: successful.filter((r) => r.sxm_path).map((r) => r.sxm_path),
      recommended_region: best,
    }
  }

  async run(): Promise<SkillResultLike> {
    const { regions, error } = this.#parse()
    if (error !== '') return { success: false, error, data: {} }
    this.#regions = regions

    this.#ex = new GraphExecutor('BatchRegionsScan', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
      onStepResult: (step, res) => this.#onStepResult(step, res),
      onStepFailed: (step, msg) => this.#onStepFailed(step, msg),
    })
    this.#ex.setPartial('regions', [...regions])
    this.#ex.setPartialDefault('region_records', {})

    await this.#ex.runPlan(this.#plan(regions))
    const data = this.#aggregate()
    data['_progress'] = progressToDict(this.#ex.progress)

    if (this.#ex.progress.aborted) {
      return {
        success: false,
        error: this.#ex.progress.abortedReason || 'batch scan aborted',
        data,
      }
    }
    const failCount = Number(data['fail_count'] ?? 0)
    const regionCount = Number(data['region_count'] ?? 0)
    const successCount = Number(data['success_count'] ?? 0)
    // **0 个成功是失败，不是「部分成功」。**
    if (regionCount > 0 && successCount === 0) {
      return { success: false, error: `0/${regionCount} regions scanned — every region failed`, data }
    }
    if (failCount > 0) {
      // 差额必须到 `summary` —— `fail_count` 躺在 `data` 里，而没有人读 data。
      return {
        success: true,
        data,
        summary:
          `部分完成：${successCount}/${regionCount} 个区域实际扫描成功，` +
          `${failCount} 个失败（详见 regions[].error）。`,
      }
    }
    return { success: true, data }
  }
}

export const BatchRegionsScan: Skill = {
  spec: S.BatchRegionsScanSpec,
  execute: (ctx, params) => new Batch(ctx, params).run(),
}
