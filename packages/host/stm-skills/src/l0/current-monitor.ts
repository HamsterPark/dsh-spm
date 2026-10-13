/**
 * 定速轮询隧道电流的两件：`MonitorCurrent`（统计 + 接触判定）与
 * `MonitorCurrentFFT`（软件 FFT）。
 *
 * 两个共一条骨架 —— **一个自己排拍的轮询循环**：
 *
 * ```
 * t0 = now();  nextPoll = t0
 * while (now() - t0 < duration) {
 *   if (now() < nextPoll) { sleep(min(nextPoll - now(), cap)); continue }
 *   safeCall('Current_Get');  nextPoll += period
 * }
 * ```
 *
 * 两处细节是判据，不是写法：
 *
 * 1. **`nextPoll += period` 而不是 `nextPoll = now() + period`。** 前者排的是
 *    **绝对**时刻表，往返抖动不会累积成越走越慢的采样率；后者每一次抖动都被
 *    加进下一拍，于是 `actual_fs_hz` 与请求的 `poll_hz` 会系统性偏低，
 *    而那个数正是频谱横轴的刻度。
 * 2. **睡眠有上限**（`MonitorCurrent` 10 ms / `MonitorCurrentFFT` 1 ms）。
 *    旧仓的注释写的是「cap so abort checks happen roughly every 10 ms」——
 *    一个 60 秒窗口的监控如果一口气睡到下一拍，中止就要等到那一拍才生效。
 *
 * ## 时钟：`ctx.now()` 是**毫秒**，旧仓 `perf_counter()` 是**秒**
 *
 * 所有内部算术都在毫秒上做，只在往 `data` 里放的时候除回秒。这不是风格问题：
 * 把 `period` 换算成秒再和毫秒钟比，是这一族最容易写出来的那个 bug，
 * 而它的症状是「采样率差 1000 倍」而**不报任何错**。
 *
 * ⚠️ 由此带来的一条**夹具**差异（不是技能的）：轨迹金样那一侧的假钟是
 * 「1e6 **秒**、每读一次 +1e-3」，本仓夹具是「1e6 **毫秒**、每读一次 +1」。
 * 于是 `timestamps_s[0]` 在那边是 `0.0010000000474974513`（1e6 量级上一个 ULP 的
 * 累积漂移），这边是 `0.001`。两个都不是「算错了」，差在第 10 位 ——
 * 所以这两个技能在 `traces.test.ts` 里按 `clockApprox` 比时间字段，
 * **判据字段（采了几点、接触没接触、谱本身）分毫不动**。
 *
 * ## 窗函数与 `rfft` 在 `numerics`
 *
 * 这里原有 `npHanning` / `npHamming` / `rfft` / `rfftfreq` 四件，当时只有这一个消费方，
 * 按消融精神没进底座（`docs/handoff/batch-5b.md`）。2026-10-13 起都在 `numerics`：
 * 汉宁窗有了别的消费方（`phase_shift`、视觉线束的 `stm_fft_peaks`，后者原先也各写一份），
 * 而 `numerics.hanning` 与这里的 `npHanning` 是**同一个式子、同一个运算次序**，逐位相同；
 * `npHamming` 随之成了 `numerics.hamming`，`rfft` / `rfftfreq` 一字未改地搬过去
 * （连 `rfftfreq` 那条「`k/(n·d)` 不是 `k·fs/n`」的注释）。
 */
import {
  pySum,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { hamming, hanning, npSum, rfft, rfftfreq } from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { num, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

const f = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt

const i32 = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/**
 * Python 的 `(params.get(k) or dflt).lower()`。
 *
 * 用 `or` 而不是 `is None`：一个**空串**也退回缺省 —— 模型把 `window=""` 传进来时
 * 「不加窗」与「按缺省加 Hann」是两条路，而旧仓选的是后者。照移。
 */
const strOr = (p: Readonly<Record<string, unknown>>, k: string, dflt: string): string => {
  const v = p[k]
  const s = v === null || v === undefined || v === false ? '' : String(v)
  return (s === '' ? dflt : s).toLowerCase()
}

/**
 * 一次轮询采到的东西。`tS` 是**相对 t0 的秒**（旧仓 `timestamps` 就是它）。
 */
interface Sample {
  readonly value: number
  readonly tS: number
}

/** `MonitorCurrent` 的睡眠上限（ms）。见文件抬头第 2 条。 */
export const MONITOR_SLEEP_CAP_MS = 10

/** `MonitorCurrentFFT` 的睡眠上限（ms）。它的目标速率高一个量级，上限也跟着。 */
export const FFT_SLEEP_CAP_MS = 1

/**
 * 定速轮询 `Current_Get`。返回采到的样本与**每一次**调用记录。
 *
 * `sleepCapMs` 是两个调用方唯一不同的地方，所以它是参数而不是两份循环。
 */
async function pollCurrent(
  ctx: SkillContext,
  durationS: number,
  pollHz: number,
  sleepCapMs: number,
): Promise<{ samples: Sample[]; calls: SkillCallRecord[]; t0: number }> {
  const periodMs = 1000 / pollHz
  const durationMs = durationS * 1000
  const samples: Sample[] = []
  const calls: SkillCallRecord[] = []
  const t0 = ctx.now()
  let nextPoll = t0
  for (;;) {
    const now = ctx.now()
    if (now - t0 >= durationMs) break
    // 中止是**退出**不是失败：已经采到的那几点仍然是真数据，旧仓 `break` 出去
    // 之后照样出统计。把它变成 `error` 会把一次正常的「够了，停」说成故障。
    if (ctx.signal.aborted) break
    if (now < nextPoll) {
      await ctx.sleep(Math.min(nextPoll - now, sleepCapMs))
      continue
    }
    const rec = await ctx.safeCall('Current_Get')
    calls.push(rec)
    if (failed(rec)) {
      // 软失败：丢掉这一拍，**时刻表照走**。
      nextPoll += periodMs
      continue
    }
    const value = num(rec, 0)
    if (value === null) {
      nextPoll += periodMs
      continue
    }
    samples.push({ value, tS: (now - t0) / 1000 })
    nextPoll += periodMs
  }
  // ⚠️ `t0` **交出去**而不是让调用方自己再读一次钟：多读一次就是多走一格，
  // 而 `actual_duration_s` 正好是「最后一次读钟减 t0」。旧仓一共读 N+2 次
  // （起手一次、循环 N 次、收尾一次），这里必须一样多。
  return { samples, calls, t0 }
}

export const MonitorCurrent: Skill = {
  spec: S.MonitorCurrentSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const duration = f(params, 'duration_s', 1.0)
    const pollHz = f(params, 'poll_hz', 100.0)
    const threshold = f(params, 'contact_threshold_a', 5e-8)
    const minStreak = i32(params, 'min_contact_samples', 3)

    const { samples, t0 } = await pollCurrent(ctx, duration, pollHz, MONITOR_SLEEP_CAP_MS)

    // 接触判定在采完之后按顺序重放 —— 与旧仓边采边判等价（判据只看**连续**超阈
    // 的次数），而分开写让「判定」这一段成为一个可以单独喂数据的函数。
    let consecutive = 0
    let contactAtS: number | null = null
    for (const s of samples) {
      if (Math.abs(s.value) >= threshold) {
        consecutive += 1
        if (consecutive >= minStreak && contactAtS === null) contactAtS = s.tS
      } else {
        consecutive = 0
      }
    }

    const n = samples.length
    if (n === 0) {
      return {
        success: false,
        error: 'No samples collected (TCP errors or aborted before first poll)',
      }
    }
    const signed = samples.map((s) => s.value)
    const abs = signed.map((v) => Math.abs(v))
    // Python 的内置 `sum()`（CPython 3.12 起是 Neumaier 补偿求和），**不是** `np.sum`。
    // 这一段旧仓一行 numpy 都没有。
    const mean = pySum(abs) / n
    const variance = pySum(abs.map((x) => (x - mean) ** 2)) / n
    const std = variance ** 0.5

    return ok({
      n_samples: n,
      duration_s: duration,
      actual_duration_s: (ctx.now() - t0) / 1000,
      min_abs_a: Math.min(...abs),
      max_abs_a: Math.max(...abs),
      mean_abs_a: mean,
      std_abs_a: std,
      signed_min_a: Math.min(...signed),
      signed_max_a: Math.max(...signed),
      contact_detected: contactAtS !== null,
      contact_at_s: contactAtS,
      contact_threshold_a: threshold,
      samples_a: signed,
      timestamps_s: samples.map((s) => s.tS),
    })
  },
}

export const MonitorCurrentFFT: Skill = {
  spec: S.MonitorCurrentFFTSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const duration = f(params, 'duration_s', 1.0)
    const pollHz = f(params, 'poll_hz', 1000.0)
    const windowName = strOr(params, 'window', 'hann')
    // `detrend` 缺省是 true；只有**显式的 false** 才关掉（旧仓 `bool(params.get(…, True))`）。
    const detrend = params['detrend'] !== false
    const output = strOr(params, 'output', 'magnitude')

    const { samples } = await pollCurrent(ctx, duration, pollHz, FFT_SLEEP_CAP_MS)
    const n = samples.length
    if (n < 4) {
      return {
        success: false,
        error: `Too few samples (${n}); polling failed or aborted`,
      }
    }

    const arr = Float64Array.from(samples.map((s) => s.value))
    const ts = samples.map((s) => s.tS)
    const actualDur = n > 1 ? (ts[n - 1] as number) - (ts[0] as number) : 1.0 / pollHz
    const actualFs = actualDur > 0 ? (n - 1) / actualDur : pollHz

    if (detrend) {
      // `arr.mean()` 是 **numpy 的成对求和**，不是 `pySum`。这一行在 numpy 里，
      // 上面那两个技能的统计在纯 Python 里 —— 同一个仓里两种求和，各归各的。
      const mu = npSum(arr) / n
      for (let k = 0; k < n; k += 1) arr[k] = (arr[k] as number) - mu
    }

    const win =
      windowName === 'hann' ? hanning(n) : windowName === 'hamming' ? hamming(n) : ones(n)
    const wArr = new Float64Array(n)
    for (let k = 0; k < n; k += 1) wArr[k] = (arr[k] as number) * (win[k] as number)

    const spec = rfft(wArr)
    const freqs = rfftfreq(n, 1.0 / actualFs)
    const mag = new Float64Array(spec.re.length)
    for (let k = 0; k < mag.length; k += 1) {
      mag[k] = Math.hypot(spec.re[k] as number, spec.im[k] as number)
    }

    let values: number[]
    if (output === 'power') {
      // 单边 PSD（W/Hz），Hann 归一化。`psd[1:-1] *= 2` —— **两端不乘 2**：
      // DC 与 Nyquist 在单边谱里没有镜像的那一半可以折过来。
      const scale = 1.0 / (actualFs * npSum(sq(win)))
      const psd = new Float64Array(mag.length)
      for (let k = 0; k < mag.length; k += 1) psd[k] = (mag[k] as number) ** 2 * scale
      for (let k = 1; k < psd.length - 1; k += 1) psd[k] = (psd[k] as number) * 2.0
      values = Array.from(psd)
    } else {
      values = Array.from(mag)
    }

    return ok({
      n_samples: n,
      actual_duration_s: actualDur,
      actual_fs_hz: actualFs,
      nyquist_hz: actualFs / 2.0,
      df_hz: actualFs / n,
      window: windowName,
      output,
      freqs_hz: Array.from(freqs),
      spectrum: values,
      source: 'software_fft_polled_current',
    })
  },
}

function ones(n: number): Float64Array {
  const out = new Float64Array(n)
  out.fill(1)
  return out
}

function sq(a: Float64Array): Float64Array {
  const out = new Float64Array(a.length)
  for (let k = 0; k < a.length; k += 1) out[k] = (a[k] as number) ** 2
  return out
}

/** 这一族的登记表。 */
export const CURRENT_MONITOR: Readonly<Record<string, Skill>> = {
  MonitorCurrent,
  MonitorCurrentFFT,
}
