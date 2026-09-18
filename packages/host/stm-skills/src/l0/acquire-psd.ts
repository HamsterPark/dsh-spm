/**
 * `AcquirePSD` —— 从 Nanonis 侧的 **Spectrum Analyzer（硬件 FFT）**读功率谱密度。
 *
 * 与 `MonitorCurrentFFT`（软件 FFT）的分工写在两边的描述里：硬件这条一次 TCP
 * 往返（~0.5 ms）就拿回整条谱，真机上 Nyquist 可到 ~10 kHz；软件那条封顶在
 * TCP 往返能力上（~1 kHz），但窗、重叠、去趋势全由自己说了算。
 *
 * ## 它是一个**图**技能，而图的价值在于「每个频段自己一格进度」
 *
 * `configure` 一步 + 每个请求的频率量程各一步。多量程扫（`freq_range_indices`
 * 传 `'[0, 2, 5]'`）时，UI 上看到的是 1/3、2/3、3/3，而不是一个转三次的黑盒。
 *
 * ⚠️ **每一格捕获都是 `optional: false`** —— 一条读不回来的谱没有替代品，
 * 补零不是「少一点数据」，是一条**看起来正常**的平谱。
 *
 * ## `nanonis_patch` 那件事本仓早就有了
 *
 * 旧仓模块顶 `from mast.core import nanonis_patch`，看着像一个子系统依赖，实际只用
 * 其中 `_patched_SpectrumAnlzr_DataGet`：把上游库错写的 `["f","f","i","*f"]` 改成
 * `["d","d","i","*d"]`（否则每个 float64 差 4 字节，最后在错位偏移上炸
 * `UnicodeDecodeError`）。本仓 `nanonis-wire/src/generated/methods.ts:588` 里
 * 这条已经带着 `source: 'patch'` 了 —— 盘点（A21）说得对，一件都不多要。
 */
import {
  GraphExecutor,
  progressToDict,
  type CompositeStep,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'

const PHASE_CONFIGURE = '_phase_configure'
const PHASE_RANGE_PREFIX = '_phase_range_'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/** 回包的 body。错误回包给空表（旧仓 `_decoded(None)` 同）。 */
const decoded = (rec: SkillCallRecord): readonly unknown[] => rec.values ?? []

const i32 = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/** 一个频段的成果。 */
interface RangeCapture {
  freq_range_index: number
  f0_hz: number
  df_hz: number
  n_bins: number
  f_max_hz: number
  psd: number[]
}

class Psd {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  /**
   * 要扫哪几个频率量程。
   *
   * `freq_range_indices` 是一串 JSON；**解析失败不是失败**，是退回单量程模式
   * （旧仓 `logger.warning` + fallback）。照移：一个打错的可选参数不该让一次本来
   * 能成的采集变成一次拒绝 —— 但它也**不该静悄悄**，所以下面把它记进 `data`。
   */
  #indices(): { indices: number[]; badList: string | null } {
    const raw = this.#params['freq_range_indices']
    const s = raw === null || raw === undefined ? '' : String(raw)
    if (s !== '') {
      try {
        const items = JSON.parse(s) as unknown
        if (Array.isArray(items)) {
          const out = items.map((x) => {
            const n = typeof x === 'number' ? x : Number(x)
            if (!Number.isFinite(n)) throw new RangeError('not an int')
            return Math.trunc(n)
          })
          return { indices: out, badList: null }
        }
        throw new RangeError('not a list')
      } catch {
        return { indices: [i32(this.#params, 'freq_range_index', -1)], badList: s }
      }
    }
    return { indices: [i32(this.#params, 'freq_range_index', -1)], badList: null }
  }

  #plan(indices: readonly number[]): CompositeStep[] {
    const instance = i32(this.#params, 'instance', 1)
    const sigIdx = i32(this.#params, 'signal_index', -1)
    const resIdx = i32(this.#params, 'freq_resolution_index', -1)
    const steps: CompositeStep[] = [
      {
        stepId: 'configure',
        skillName: PHASE_CONFIGURE,
        params: { instance, signal_index: sigIdx, freq_resolution_index: resIdx },
        optional: false,
        checkpointAfter: false,
        tags: ['setup'],
      },
    ]
    const last = indices.length - 1
    indices.forEach((frIdx, i) => {
      steps.push({
        stepId: `range_${i}_capture`,
        skillName: `${PHASE_RANGE_PREFIX}${i}`,
        params: {
          instance,
          range_index_pos: i,
          freq_range_index: Math.trunc(frIdx),
          is_last: i === last,
        },
        // 任何一格捕获失败都中止 —— **我们没法拿零去顶一条谱**。
        optional: false,
        checkpointAfter: i === last,
        tags: ['capture', `range_idx=${frIdx}`, `pos=${i}`],
      })
    })
    return steps
  }

  async #run(name: string, params: Readonly<Record<string, unknown>>): Promise<StepResult> {
    if (name === PHASE_CONFIGURE) return this.#configure(params)
    if (name.startsWith(PHASE_RANGE_PREFIX)) return this.#capture(params)
    return { success: false, error: `Unknown phase: ${name}`, data: null }
  }

  async #configure(p: Readonly<Record<string, unknown>>): Promise<StepResult> {
    const instance = i32(p, 'instance', 1)
    const sigIdx = i32(p, 'signal_index', -1)
    const resIdx = i32(p, 'freq_resolution_index', -1)

    // 起分析仪。**幂等，所以不 fail-fast** —— 模块已经在跑时它会回一条无害的警告。
    await this.#ctx.safeCall('SpectrumAnlzr_Run', instance)

    if (sigIdx >= 0) {
      const rec = await this.#ctx.safeCall('SpectrumAnlzr_ChSet', instance, sigIdx)
      if (failed(rec)) return { success: false, error: `ChSet failed: ${rec.error ?? ''}`, data: null }
    }
    if (resIdx >= 0) await this.#ctx.safeCall('SpectrumAnlzr_FreqResSet', instance, resIdx)

    // 回读分辨率与通道，好让调用方知道这条谱是在什么配置下采的。**读失败不算失败**。
    await this.#ctx.safeCall('SpectrumAnlzr_FreqResGet', instance)
    const recCh = await this.#ctx.safeCall('SpectrumAnlzr_ChGet', instance)
    const ch = decoded(recCh)[0]
    if (typeof ch === 'number' && Number.isFinite(ch)) {
      this.#ex.setPartial('channel_index', Math.trunc(ch))
    }
    this.#ex.setPartial('instance', instance)
    return { success: true, error: '', data: { instance } }
  }

  async #capture(p: Readonly<Record<string, unknown>>): Promise<StepResult> {
    const instance = i32(p, 'instance', 1)
    const frIdx = i32(p, 'freq_range_index', -1)
    const pos = i32(p, 'range_index_pos', 0)

    if (frIdx >= 0) await this.#ctx.safeCall('SpectrumAnlzr_FreqRangeSet', instance, frIdx)
    const recRange = await this.#ctx.safeCall('SpectrumAnlzr_FreqRangeGet', instance)
    const recData = await this.#ctx.safeCall('SpectrumAnlzr_DataGet', instance)
    if (failed(recData)) {
      return { success: false, error: `DataGet failed: ${recData.error ?? ''}`, data: null }
    }

    const d = decoded(recData)
    if (d.length < 4) {
      return { success: false, error: `Unexpected response shape: got ${d.length} fields`, data: null }
    }
    const f0 = Number(d[0])
    const df = Number(d[1])
    const n = Math.trunc(Number(d[2]))
    const raw = d[3]
    if (!Number.isFinite(f0) || !Number.isFinite(df) || !Number.isFinite(n) || !Array.isArray(raw)) {
      return { success: false, error: 'PSD decode error: bad field types', data: null }
    }
    const psd = raw.map((v) => Number(Array.isArray(v) ? v[0] : v))

    // 可用频段表只取一次 —— 它在几次捕获之间不会变。
    if (!('available_freq_ranges_hz' in this.#ex.progress.partialData)) {
      const rd = decoded(recRange)
      const third = rd[2]
      const avail = Array.isArray(third) ? third.map((r) => Number(Array.isArray(r) ? r[0] : r)) : []
      this.#ex.setPartial('available_freq_ranges_hz', avail)
    }

    // 按**位置**入账，于是续跑时不会把同一段重复塞进去。
    const per = { ...((this.#ex.progress.partialData['per_range'] ?? {}) as Record<string, RangeCapture>) }
    per[String(pos)] = {
      freq_range_index: frIdx,
      f0_hz: f0,
      df_hz: df,
      n_bins: n,
      f_max_hz: f0 + (n - 1) * df,
      psd,
    }
    this.#ex.setPartial('per_range', per)
    return { success: true, error: '', data: { pos, freq_range_index: frIdx } }
  }

  async run(): Promise<SkillResultLike> {
    const { indices, badList } = this.#indices()
    this.#ex = new GraphExecutor('AcquirePSD', {
      now: () => this.#ctx.now(),
      run: (skill, params) => this.#run(skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
    })
    this.#ex.setPartialDefault('per_range', {})

    const allGood = await this.#ex.runPlan(this.#plan(indices))
    const pd = this.#ex.progress.partialData
    const per = (pd['per_range'] ?? {}) as Record<string, RangeCapture>
    const ordered = Object.keys(per)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => per[k] as RangeCapture)
    const instance =
      typeof pd['instance'] === 'number' ? Math.trunc(pd['instance']) : i32(this.#params, 'instance', 1)
    const channelIndex = typeof pd['channel_index'] === 'number' ? Math.trunc(pd['channel_index']) : -1
    const avail = Array.isArray(pd['available_freq_ranges_hz'])
      ? [...(pd['available_freq_ranges_hz'] as number[])]
      : []

    const data: Record<string, unknown> = {
      instance,
      channel_index: channelIndex,
      per_range: ordered,
      available_freq_ranges_hz: avail,
      source: 'nanonis_hardware_spectrum_analyzer',
      _progress: progressToDict(this.#ex.progress),
    }
    // 向后兼容：第一个频段的数摆在顶层，v1 的调用方读 `data["psd"]` 照旧能用。
    const first = ordered[0]
    if (first !== undefined) {
      data['f0_hz'] = first.f0_hz
      data['df_hz'] = first.df_hz
      data['n_bins'] = first.n_bins
      data['f_max_hz'] = first.f_max_hz
      data['psd'] = first.psd
    }
    // 一个解析不了的 `freq_range_indices` 退回单量程模式（旧仓行为），但**说出来** ——
    // 旧仓只写进日志，而日志不跟着回包走（D-PSD-1）。
    if (badList !== null) data['freq_range_indices_ignored'] = badList

    if (!allGood) {
      return {
        success: false,
        error: this.#ex.progress.abortedReason || 'AcquirePSD aborted',
        data,
      }
    }
    return { success: true, data }
  }
}

export const AcquirePSD: Skill = {
  spec: S.AcquirePSDSpec,
  execute: (ctx, params) => new Psd(ctx, params).run(),
}

/** 这一族的登记表（就一个）。 */
export const ACQUIRE_PSD: Readonly<Record<string, Skill>> = { AcquirePSD }
