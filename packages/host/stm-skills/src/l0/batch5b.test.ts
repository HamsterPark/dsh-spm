/**
 * 批 5b 的**判据**金样比对 —— `spec/golden/batch5b.json` 的 71 格逐条重放。
 *
 * 与 `traces.test.ts` 的分工：
 *
 * | | 那一份 | 这一份 |
 * |---|---|---|
 * | 驱动器 | 通用（每个动词一个常数回包、每个子技能空 `data`） | **脚本化**（每格自己给回答） |
 * | 钉的是 | 「它在注册表里、被真调度链调得动」 | **判据本身**（判别表六个结论、退针阶梯、谱、区域账） |
 * | `MonitorCurrentFFT` 的谱 | 500 个零（全常数样本去趋势之后） | 两个音 + 泄漏，三种窗各不相同 |
 *
 * 脚本**进金样**，两边用同一份 —— 「两边各自重建同一个输入」本身就是一处没有人
 * 在看的差异（批 4a §4 那一课）。
 *
 * ## 三种容差，其余一律**逐位**
 *
 * | 比什么 | 容差 | 推导 |
 * |---|---|---|
 * | 判决、文案、计数、下标、路径、区域账 | **0** | 整数与搬运；给容差等于把一次「挑错了元素」藏起来 |
 * | 每格 `clock_keys` 列出的那几个叶子 | 相对 {@link CLOCK_REL} | 两侧的假钟摆在不同量级（导出那边 1e6 **秒** / 每读 +1e-3，这边 1e6 **毫秒** / 每读 +1）⇒ 同一个时刻在两边差第 10 位。实测最坏 4.7e−8（`actual_fs_hz`），留了 20 倍余量 |
 * | `MonitorCurrentFFT` 的 `spectrum` | {@link spectrumTol} | 见下 |
 *
 * ### `spectrum` 的容差**按整幅谱的最大值归一**，不是按每一格自己
 *
 * FFT 的误差本底与**整幅谱的最大值**挂钩，不与某一个 bin 自己挂钩
 * （`numerics/fft.ts` 抬头那一条；相消毁掉相对精度的另一面）。于是
 *
 * ```
 * |a − b| ≤ max|golden| · 4 · fftRelTol(n)            （magnitude 档）
 * |a − b| ≤ max|golden| · (4 · fftRelTol(n) + CLOCK_REL)   （power 档）
 * ```
 *
 * `4·` 里的 2 是「本仓 radix-2/Bluestein 对 numpy pocketfft，两条不同的蝶形顺序」
 * 的余量，另一个 2 是 `power` 档的平方（`Δ(m²) ≈ 2m·Δm`）。
 * `power` 那一项额外的 `CLOCK_REL` 是因为它把 `actual_fs` 乘进了每一格 ——
 * 而那个数从钟上来。
 *
 * 实测（本机，n = 999，四格）：`hann` 占容差 **1.6e−3**、`hamming` 2.9e−3、
 * `rect` 1.6e−3、`no_detrend` 1.1e−3；`power` 那一格里钟那一项才是大头
 * （fs 的相对差 4.7e−8，占 `CLOCK_REL` 的 4.7 %）。
 * 也就是说这条界比实测松两到三个数量级 —— **按推导写，不按试出来的那个数写**
 * （`numerics-3.md` 第六节）：`fftRelTol` 是这一层已经推过的那条界，
 * 而一条「刚好让我这版通过」的容差在下一次换 FFT 实现时会当场骗人。
 *
 * ⚠️ **`spectrum` 不能进 `clock_keys`**：那条按 `max(1, |a|)` 归一的相对容差
 * 在 1e−22 量级的 PSD 上退化成「绝对 1e−6」，也就是什么都不判。
 *
 * ⚠️ **按整幅谱最大值归一的代价：这条容差对「小格」没有分辨力**（2026-09-19）。
 * `monitor_fft/power` 的 Nyquist 那一格是 4.18e−39，比峰值低十几个数量级 ——
 * 把它乘 2，差额远在容差以下。推导没错（FFT 的误差本底本来就与整幅谱挂钩），
 * 但这意味着**单边归一化折不折两端，这一份验不了**。那道闸由
 * `batch5b-edges.test.ts` 用一个脉冲输入单独钉（两端与中间同量级，容差 0）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  emptyHardwareState,
  slowCallFrom,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { fftRelTol } from 'dsh-spm-numerics'
import { IMPLEMENTED } from './index.js'

interface VerbReply {
  readonly body?: unknown[]
  readonly error?: string
}
interface RunReply {
  readonly success?: boolean
  readonly data?: Record<string, unknown>
  readonly error?: string
}
interface Case {
  readonly skill: string
  readonly params: Record<string, unknown>
  readonly verbs: Record<string, VerbReply[]>
  readonly runs: Record<string, RunReply[]>
  readonly clock_keys: string[]
  readonly calls: { verb: string; args: unknown[]; error: string | null }[]
  readonly run_log: { skill: string; params: Record<string, unknown> }[]
  readonly result: {
    success?: boolean
    error?: string
    summary?: string
    data?: Record<string, unknown>
    raised?: string
  }
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/batch5b.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, Case>

/** 两个假钟之间的相对容差。实测最坏 4.7e−8，留 20 倍余量。 */
export const CLOCK_REL = 1e-6

/** 见文件抬头那一节。`n` 是样本数，`maxAbs` 是**金样那一幅**谱的最大值。 */
export function spectrumTol(n: number, maxAbs: number, isPower: boolean): number {
  return maxAbs * (4 * fftRelTol(n) + (isPower ? CLOCK_REL : 0))
}

const S0 = emptyHardwareState('T0')

/** 脚本队列：取完之后**重复最后一个**（与导出脚本 `_ScriptedContext._next` 同）。 */
function pick<T>(queue: readonly T[] | undefined, i: number): T | undefined {
  if (queue === undefined || queue.length === 0) return undefined
  return queue[Math.min(i, queue.length - 1)]
}

/** 脚本里的 `{"__nd__": [[…]]}` → 本仓线协议解出来的那个形状（`number[][]`）。 */
function materialise(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && '__nd__' in (v as object)) {
    return (v as { __nd__: number[][] }).__nd__
  }
  if (Array.isArray(v)) return v.map(materialise)
  return v
}

interface Recorded {
  ctx: SkillContext
  calls: { verb: string; args: unknown[]; error: string | null }[]
  runs: { skill: string; params: Record<string, unknown> }[]
}

/**
 * 与导出脚本同形的脚本化 context。
 *
 * 假钟与 `traces.test.ts` **同一套**：`now()` 每读一次 +1 **毫秒**，
 * `sleep(ms)` 把钟往前拨 —— 于是轮询循环的**拍数**与导出那侧对得上
 * （那边是 +1e-3 秒）。
 */
function scriptedCtx(c: Case): Recorded {
  const calls: { verb: string; args: unknown[]; error: string | null }[] = []
  const runs: { skill: string; params: Record<string, unknown> }[] = []
  const vi = new Map<string, number>()
  const ri = new Map<string, number>()
  let clock = 1_000_000

  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    if (calls.length > 5000) throw new Error(`调用预算用尽（${method}）—— 轮询没有出口`)
    const i = vi.get(method) ?? 0
    vi.set(method, i + 1)
    const spec = pick(c.verbs[method], i)
    let rec: SkillCallRecord
    if (spec === undefined) rec = { method, args, values: [0.0] }
    else if (spec.error !== undefined) rec = { method, args, error: spec.error }
    else rec = { method, args, values: (materialise(spec.body ?? []) as unknown[]) }
    calls.push({ verb: method, args, error: rec.error ?? null })
    return Promise.resolve(rec)
  }

  const ctx: SkillContext = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: slowCallFrom(safeCall, (m, _t, ...a) => safeCall(m, ...a)),
    now: () => (clock += 1),
    sleep: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'batch5b-test',
    rootCallId: 'b5b',
    approvalSource: 'llm',
    runSkill: (name: string, params: Readonly<Record<string, unknown>>) => {
      const i = ri.get(name) ?? 0
      ri.set(name, i + 1)
      runs.push({ skill: name, params: { ...params } })
      const spec = pick(c.runs[name], i)
      if (spec === undefined) return Promise.resolve({ success: true, data: {} })
      const out: SkillResultLike = {
        success: spec.success !== false,
        data: { ...(spec.data ?? {}) },
        error: spec.error ?? '',
      }
      return Promise.resolve(out)
    },
  }
  return { ctx, calls, runs }
}

/**
 * D-PSD-1：本仓比旧仓**多报**的那一格（`freq_range_indices` 解析不了时退回单量程，
 * 而旧仓只写日志）。金样里没有它，所以期望值只能在这里逐格写明 ——
 * 键在表里 = 这一格必须有且等于这个串；不在表里 = 这一格必须**不存在**。
 */
const PSD_IGNORED: Readonly<Record<string, string>> = { 'psd/bad_indices_json': '0,2,5' }

/** 执行器的时刻台账不是判据（两侧的钟本来就不同量级）。 */
const PROGRESS_VOLATILE = new Set(['started_at', 'last_update_at'])

function stripProgressClock(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripProgressClock)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !PROGRESS_VOLATILE.has(k))
        .map(([k, x]) => [k, stripProgressClock(x)]),
    )
  }
  return v
}

function close(a: unknown, b: unknown, rel: number): boolean {
  return (
    typeof a === 'number' &&
    typeof b === 'number' &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= rel * Math.max(1, Math.abs(a))
  )
}

/** 把 `want` 里**够近的**时钟数换成 `got` 的那一个；不够近时留在原地让 `toEqual` 印出来。 */
function alignClock(want: unknown, got: unknown, keys: Set<string>, key = ''): unknown {
  if (keys.has(key) && close(want, got, CLOCK_REL)) return got
  if (Array.isArray(want) && Array.isArray(got) && want.length === got.length) {
    return want.map((x, i) => alignClock(x, got[i], keys, key))
  }
  if (want !== null && typeof want === 'object' && got !== null && typeof got === 'object') {
    return Object.fromEntries(
      Object.entries(want as Record<string, unknown>).map(([k, x]) => [
        k,
        alignClock(x, (got as Record<string, unknown>)[k], keys, k),
      ]),
    )
  }
  return want
}

/** 谱那一条单独比（见文件抬头）。返回换过之后的 `want`。 */
function alignSpectrum(
  want: Record<string, unknown>,
  got: Record<string, unknown>,
  isPower: boolean,
): Record<string, unknown> {
  const w = want['spectrum']
  const g = got['spectrum']
  if (!Array.isArray(w) || !Array.isArray(g) || w.length !== g.length) return want
  const n = Number(want['n_samples'] ?? 0)
  const maxAbs = w.reduce<number>((m, x) => Math.max(m, Math.abs(Number(x))), 0)
  const tol = spectrumTol(n, maxAbs, isPower)
  const merged = w.map((x, i) =>
    Math.abs(Number(x) - Number(g[i])) <= tol ? (g[i] as number) : (x as number),
  )
  return { ...want, spectrum: merged }
}

describe('批 5b 判据金样：脚本化上下文逐格重放', () => {
  const names = Object.keys(golden).sort()
  it('金样不是空的（`describe.each` 空表会静静地通过）', () => {
    expect(names.length).toBeGreaterThan(60)
  })

  for (const name of names) {
    const c = golden[name] as Case
    it(`${name}：动词序列、子技能序列与返回都相等`, async () => {
      const skill = IMPLEMENTED[c.skill] as Skill | undefined
      expect(skill, `${c.skill} 没在 IMPLEMENTED 里`).toBeDefined()
      const { ctx, calls, runs } = scriptedCtx(c)
      const got = await (skill as Skill).execute(ctx, c.params)

      expect(calls.map((x) => [x.verb, x.args])).toEqual(
        c.calls.map((x) => [x.verb, x.args]),
      )
      expect(runs).toEqual(c.run_log)
      expect(got.success).toBe(c.result.success === true)
      expect(got.error ?? '').toBe(c.result.error ?? '')
      expect(got.summary ?? '').toBe(c.result.summary ?? '')

      const keys = new Set(c.clock_keys)
      let want = stripProgressClock(c.result.data ?? {}) as Record<string, unknown>
      const gotData = stripProgressClock(got.data ?? {}) as Record<string, unknown>
      if (c.skill === 'MonitorCurrentFFT' && 'spectrum' in want) {
        want = alignSpectrum(want, gotData, want['output'] === 'power')
      }
      // D-PSD-1：`freq_range_indices` 解析不了时本仓**多一个字段**说出来。
      //
      // ⚠️ 这一条原来写成 `if ('freq_range_indices_ignored' in gotData) { … }` ——
      // **条件与被测的东西是同一件事**：字段不报了，整块断言跟着一起消失，
      // `toEqual` 那边也没话说（金样里本来就没有这一格）。于是变异
      // `psd-ignored-list-is-reported` 一直是绿的（2026-09-19 查出来）。
      // 现在期望值由**用例名**给，不由回包给：该有就必须有，不该有就必须没有。
      const wantIgnored = PSD_IGNORED[name]
      if (wantIgnored !== undefined) {
        expect(want['freq_range_indices_ignored']).toBeUndefined() // 旧仓只写日志
        expect(gotData['freq_range_indices_ignored']).toBe(wantIgnored)
        delete gotData['freq_range_indices_ignored']
      } else {
        expect('freq_range_indices_ignored' in gotData).toBe(false)
      }
      expect(gotData).toEqual(alignClock(want, gotData, keys))
    })
  }
})
