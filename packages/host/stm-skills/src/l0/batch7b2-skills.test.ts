/**
 * 批 7b-2 —— 势垒链与线缆，对 `spec/golden/batch7b2.json` 的逐格比对（DoD ③ + ⑤）。
 *
 * ## 容差表：四档，其余**全部逐位**
 *
 * | 字段 | 容差 | 一句推导 |
 * |---|---|---|
 * | `kappa_per_nm` / `phi_ev` / `decade_nm` / `phi_fraction_of_vacuum` / `vacuum_decade_nm` | {@link FIT_REL_TOL} | 旧仓走 `np.polyfit`（LAPACK `gelsd`，SVD），本仓走**列缩放正规方程**（`savgol.ts` 的 `polyfit`，D-LSQ-1）。列缩放之后 deg=1 的设计阵条件数 κ ≲ 10（两列是归一化的 `d` 与常数列，而退开量跨 0–0.55 nm，两列的夹角远离 0），正规方程把它平方 ⇒ 相对误差 ~κ²·eps ≈ 2e−14。取 `1024·eps ≈ 2.3e−13`，约 10 倍余量 |
 * | `fit_resid_rms` | {@link residAbsTolOf}，**绝对** | 残差是 `lnI − (slope·d + intercept)` 的**相消结果**：一条合成的纯指数上它只剩浮点噪声（金样里 `2.1e−15`）。误差主项是每个元素的 `eps·max\|lnI\|`，**与残差多小无关** —— 写成相对的话它会在第 25 位上提问（同批 7a-3 `localRmsAbsTol` 那一课） |
 * | `phase_shift` 的 `snr` | {@link phaseShiftSnrRelTol} | 推导写在 `numerics/src/phase-shift.ts` 的抬头（三次二维变换，每次 `fftRelTol(rows)+fftRelTol(cols)`） |
 * | `_progress` 的 `started_at` / `last_update_at` / `partial_data.start_time` | **丢掉** | 两侧的钟**原点不同**（导出侧是秒、本仓是毫秒/1000，而读钟次数由两个执行器各自决定）。它们的**值**没有判据可言 —— 而超时那条判据（`elapsed ≥ timeout`）的**符号**由睡掉的秒数决定，`grid/timeout` 那一格就是它 |
 *
 * `dx` / `dy`（整像素）· 每一档的 `points`（脚本值原样过一次 `mean·1e12`）·
 * 散布 / 比值 / 中位数（4 个元素的顺序累加，两侧同序）· 全部报文 · 调用序列 ·
 * 子技能序列 —— **容差 0**。
 *
 * ## ⚠️ 两条「今天到不了」的路，写在这里而不是假装验过
 *
 * 1. **`ScanAt` 从不返回路径** ⇒ `AcquireBiasSeries` 的 `AssessFrameTrust` 与
 *    `CalibrateCoarseStep` 的整条标定循环在两仓都是死代码。金样里
 *    `series/dead_path` 与 `coarse/dead_path` 录的就是那个事实；
 *    名字带 `hypothetical` 的那几格明写是**假设**。
 *    量着它的那条测试在 §「`ScanAt` 的回包里没有任何一个路径键」——
 *    `ScanAt` 哪天补上了，它当场变红。
 * 2. **`.dat` 归属**：`AcquireDeltaFCurve` 的三道闸要真的碰文件系统与 mtime，
 *    而金样那一侧的墙钟是假的 ⇒ 编不出一格。这里用临时目录 + 注入的 `nowS`
 *    单独验，**期望值来自代码契约而不是金样**，并在这里说明。
 */
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  emptyHardwareState,
  slowCallFrom,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { EPS } from 'dsh-spm-numerics'
import { IMPLEMENTED } from './index.js'
import {
  barrierVerdict,
  fitKappa,
  relSpread,
  verdictFrom,
  type BarrierPoint,
} from '../composite/barrier.js'
import { setpointsFor } from '../composite/bias-series.js'
import { makeAcquireDeltaFCurve } from './deltaf-curve.js'
import { meanStd, parseIndices } from './optics-acquire.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/batch7b2.json', import.meta.url)), 'utf8'),
) as Record<string, any>

/** 见抬头那张表的第一行。 */
const FIT_REL_TOL = 1024 * EPS

/** 见抬头第二行：绝对容差，入口是**被拟合的那一列 `ln|I|` 的量程**。 */
function residAbsTolOf(points: readonly (readonly [number, number | null])[], floor: number): number {
  let m = 0
  for (const [, i] of points) {
    if (i === null || !(i > floor)) continue
    m = Math.max(m, Math.abs(Math.log(i)))
  }
  return 64 * EPS * m
}

// ── 脚本化上下文：与 `export_batch7b2.py` 的 `_ScriptedContext` 同一套 ────────

/** `{"__nan__": true}` / `{"__inf__": ±1}` → 真值。与导出侧同一张表。 */
function materialise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(materialise)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('__nan__' in o) return Number.NaN
    if ('__inf__' in o) return Number(o['__inf__']) > 0 ? Infinity : -Infinity
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(o)) out[k] = materialise(x)
    return out
  }
  return v
}

interface Replay {
  readonly ctx: SkillContext
  readonly calls: { verb: string; args: unknown[]; error: string }[]
  readonly runLog: { skill: string; params: Record<string, unknown> }[]
}

function scriptedCtx(
  verbs: Record<string, any[]>,
  runs: Record<string, any[]>,
  abortAtS: number | null,
): Replay {
  const calls: { verb: string; args: unknown[]; error: string }[] = []
  const runLog: { skill: string; params: Record<string, unknown> }[] = []
  const vi = new Map<string, number>()
  const ri = new Map<string, number>()
  // **毫秒**，起点 1e9 ms = 1e6 s —— 与导出侧那个 1e6 **秒**的假钟逐位对齐：
  // 每读一次 +1 ms（= +1e-3 s），`sleep` 往前拨。
  let clock = 1_000_000_000
  const t0 = clock
  const ac = new AbortController()
  const maybeAbort = (): void => {
    if (abortAtS !== null && (clock - t0) / 1000 >= abortAtS) ac.abort()
  }

  const next = (queue: any[] | undefined, idx: Map<string, number>, key: string): any => {
    const i = idx.get(key) ?? 0
    idx.set(key, i + 1)
    if (queue === undefined || queue.length === 0) return undefined
    return queue[Math.min(i, queue.length - 1)]
  }

  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    if (calls.length > 5000) throw new Error(`调用预算用尽（${method}）—— 轮询没有出口`)
    const spec = next(verbs[method], vi, method)
    if (spec !== undefined && 'error' in spec) {
      calls.push({ verb: method, args, error: String(spec.error) })
      return Promise.resolve({ method, args, error: String(spec.error) })
    }
    const values = spec === undefined ? [0.0] : (materialise(spec.body) as unknown[])
    calls.push({ verb: method, args, error: '' })
    return Promise.resolve({ method, args, values })
  }

  const S0 = emptyHardwareState('T0')
  const ctx: SkillContext = {
    signal: ac.signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: slowCallFrom(safeCall, (method, _t, ...args) => safeCall(method, ...args)),
    now: () => {
      clock += 1
      maybeAbort()
      return clock
    },
    sleep: (ms: number) => {
      clock += ms
      maybeAbort()
      return Promise.resolve()
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'batch7b2',
    rootCallId: 'b7b2',
    approvalSource: 'llm',
    runSkill: (name: string, params: Readonly<Record<string, unknown>>) => {
      runLog.push({ skill: name, params: { ...params } })
      const spec = next(runs[name], ri, name)
      if (spec === undefined) return Promise.resolve({ success: true, data: {} })
      return Promise.resolve({
        success: spec.success !== false,
        data: materialise(spec.data ?? {}) as Record<string, unknown>,
        error: String(spec.error ?? ''),
      } as SkillResultLike)
    },
  }
  return { ctx, calls, runLog }
}

// ── 比对：按键分档 ────────────────────────────────────────────────────────

/** 走相对容差的那几个叶子名（见抬头第一行）。 */
const FIT_KEYS = new Set([
  'kappa_per_nm', 'phi_ev', 'decade_nm', 'phi_fraction_of_vacuum', 'vacuum_decade_nm',
])
/** 走绝对容差的那一个（见抬头第二行）。 */
const RESID_KEY = 'fit_resid_rms'
/** 两侧钟原点不同 ⇒ 丢掉（见抬头第四行）。 */
const DROP_KEYS = new Set(['started_at', 'last_update_at', 'start_time'])

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue
      out[k] = strip(x)
    }
    return out
  }
  return v
}

/** 金样里的 `{"__nan__":…}` 记号还原之后再比。 */
function want(v: unknown): unknown {
  return strip(materialise(v))
}

interface Mismatch {
  path: string
  got: unknown
  exp: unknown
}

function diff(got: unknown, exp: unknown, residTol: number, path = ''): Mismatch[] {
  const out: Mismatch[] = []
  if (typeof exp === 'number' && typeof got === 'number') {
    if (Number.isNaN(exp) !== Number.isNaN(got)) return [{ path, got, exp }]
    if (Number.isNaN(exp)) return out
    const leaf = path.replace(/.*\./, '')
    let allowed = 0
    if (FIT_KEYS.has(leaf)) allowed = FIT_REL_TOL * Math.abs(exp)
    else if (leaf === RESID_KEY) allowed = residTol
    if (!(Math.abs(got - exp) <= allowed)) out.push({ path, got, exp })
    return out
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(got) || got.length !== exp.length) return [{ path, got, exp }]
    for (let i = 0; i < exp.length; i += 1) out.push(...diff(got[i], exp[i], residTol, `${path}[${i}]`))
    return out
  }
  if (exp !== null && typeof exp === 'object') {
    if (got === null || typeof got !== 'object' || Array.isArray(got)) return [{ path, got, exp }]
    const e = exp as Record<string, unknown>
    const g = got as Record<string, unknown>
    const keys = new Set([...Object.keys(e), ...Object.keys(g)])
    for (const k of keys) {
      if (!(k in e) || !(k in g)) {
        out.push({ path: `${path}.${k}`, got: g[k], exp: e[k] })
        continue
      }
      out.push(...diff(g[k], e[k], residTol, `${path}.${k}`))
    }
    return out
  }
  if (got !== exp) out.push({ path, got, exp })
  return out
}

/**
 * **D-SKILL-2 的又一处**：旧仓 `nanonis_scalar` 抛的那句话里印的是三段信封
 * `('', b'', [])`；本仓 `SkillCallRecord.values` **就是** body，信封在
 * `nanonis-wire` 那层拆掉了，印的是我们真有的东西。
 *
 * 期望值**从金样算出来**（不抄一遍）：旧仓哪天改了那句话，这条登记会跟着变，
 * 不会悄悄过期。而如果金样里根本没有那个串，这个函数是恒等的 —— 于是
 * 「差异消失」也会被下面那条反向断言抓住。
 */
const ENVELOPE = "('', b'', [])"
function ourWording(s: string): string {
  return s.replaceAll(ENVELOPE, '[]')
}

const show = (ms: readonly Mismatch[]): string =>
  ms.map((m) => `  ${m.path || '<root>'}: got ${JSON.stringify(m.got)} want ${JSON.stringify(m.exp)}`).join('\n')

// ── ① 技能逐格 ───────────────────────────────────────────────────────────

const SKILLS = GOLDEN['skills'] as Record<string, any>

describe('批 7b-2 · 技能逐格对旧仓', () => {
  it('金样不是空的（104 格）', () => {
    expect(Object.keys(SKILLS).length).toBe(104)
  })

  // 旧仓那一侧也钉住：差异消失时这条会当场变红，而不是安静地留着。
  it('D-SKILL-2：旧仓那句「一个数都没有」里印的确实是三段信封', () => {
    expect(SKILLS['point/no_numeric_in_reply'].result.error).toContain(ENVELOPE)
  })

  for (const [name, c] of Object.entries(SKILLS)) {
    it(`${name}：动词序列、子技能序列、回包三样都相等`, async () => {
      const skill = IMPLEMENTED[c.skill as string]
      expect(skill, `${c.skill} 不在 IMPLEMENTED 里`).toBeDefined()
      const { ctx, calls, runLog } = scriptedCtx(
        c.verbs ?? {},
        c.runs ?? {},
        c.abort_at_s ?? null,
      )
      const got = await skill!.execute(ctx, materialise(c.params) as Record<string, unknown>)

      // 旧仓抛了 ⇒ 本仓不许抛（D-SKILL-3 同一条），而且要给一句说得清的拒绝。
      if ('raised' in c.result) {
        expect(got.success).toBe(false)
        expect(got.error ?? '').not.toBe('')
        return
      }

      expect(calls.map((x) => [x.verb, x.args, x.error])).toEqual(
        (c.calls as any[]).map((x) => [x.verb, materialise(x.args), x.error]),
      )
      expect(runLog).toEqual(
        (c.run_log as any[]).map((x) => ({ skill: x.skill, params: materialise(x.params) })),
      )
      expect(got.success).toBe(c.result.success)
      expect(got.error ?? '').toBe(ourWording(c.result.error as string))
      expect(got.summary ?? '').toBe(c.result.summary)

      const pts = ((c.result.data?.['points'] ?? []) as any[]).map(
        (p) => [p[0], p[1]] as readonly [number, number | null],
      )
      const floor = typeof c.result.data?.['noise_floor_pa'] === 'number'
        ? (c.result.data['noise_floor_pa'] as number)
        : 0
      const ms = diff(strip(got.data ?? {}), want(c.result.data ?? {}), residAbsTolOf(pts, floor))
      expect(ms, `${name} 有 ${ms.length} 处对不上：\n${show(ms)}`).toEqual([])
    })
  }
})

// ── ② 纯函数逐格 ─────────────────────────────────────────────────────────

describe('批 7b-2 · 判据本体逐格', () => {
  for (const [name, c] of Object.entries(GOLDEN['fit_kappa'] as Record<string, any>)) {
    it(`fit_kappa/${name}`, () => {
      const pts = (c.points as any[]).map((p) => [p[0], p[1]] as BarrierPoint)
      const { fit, usable } = fitKappa(pts, c.noise_floor_pa as number)
      expect(usable.length).toBe(c.n_usable)
      if (c.fit === null) {
        expect(fit).toBeNull()
        return
      }
      expect(fit).not.toBeNull()
      const tol = residAbsTolOf(pts, c.noise_floor_pa as number)
      const ms = diff(fit as unknown, c.fit, tol)
      expect(ms, `fit_kappa/${name}：\n${show(ms)}`).toEqual([])
    })
  }

  for (const [name, c] of Object.entries(GOLDEN['barrier_verdict'] as Record<string, any>)) {
    it(`barrier_verdict/${name}`, () => {
      expect(barrierVerdict(c.phi_ev as number)).toEqual([c.verdict, c.message])
    })
  }

  for (const [name, c] of Object.entries(GOLDEN['rel_spread'] as Record<string, any>)) {
    it(`rel_spread/${name}`, () => {
      expect(relSpread(materialise(c.values) as (number | null)[])).toEqual(c.spread)
    })
  }

  for (const [name, c] of Object.entries(GOLDEN['verdict_from'] as Record<string, any>)) {
    it(`verdict_from/${name}`, () => {
      expect(verdictFrom(c.site as number | null, c.repeat as number | null)).toEqual([
        c.verdict,
        c.ratio,
      ])
    })
  }

  for (const [name, c] of Object.entries(GOLDEN['setpoints_for'] as Record<string, any>)) {
    it(`setpoints_for/${name}`, () => {
      expect(
        setpointsFor(c.biases as number[], c.r_ohm as number).map((r) => ({
          bias_v: r.biasV,
          setpoint_a: r.setpointA,
          clamped: r.clamped,
        })),
      ).toEqual(c.plan)
    })
  }

  for (const [name, c] of Object.entries(GOLDEN['parse_indices'] as Record<string, any>)) {
    it(`parse_indices/${name}`, () => {
      expect(parseIndices(c.text)).toEqual(c.indices)
    })
  }

  for (const [name, c] of Object.entries(GOLDEN['mean_std'] as Record<string, any>)) {
    it(`mean_std/${name}`, () => {
      expect([...meanStd(c.values as number[])]).toEqual(c.mean_std)
    })
  }

  // ⚠️ `phase_shift` 那一节**不在这里**，在 `numerics/src/batch7b2.test.ts` ——
  // 判据与看着它的测试要在同一个包里，否则那几条变异会被判 `narrow-scope`。
})

// ── ③ `validate_params` ──────────────────────────────────────────────────

describe('批 7b-2 · validate_params（通用驱动器从不调它，这一节是它唯一的金样）', () => {
  for (const [skillName, cases] of Object.entries(GOLDEN['validate'] as Record<string, any>)) {
    for (const [tag, c] of Object.entries(cases as Record<string, any>)) {
      it(`${skillName}/${tag}`, () => {
        const skill = IMPLEMENTED[skillName]!
        const errs = skill.validateParams?.(c.params as Record<string, unknown>) ?? []
        expect(errs).toEqual(c.errors)
      })
    }
  }
})

// ── ④ 「这条路是死的」—— 量着它的那条测试 ────────────────────────────────

describe('批 7b-2 · `ScanAt` 从不返回路径（两段死代码的唯一证人）', () => {
  /**
   * ⚠️ **这条测试今天绿，而它绿的理由是一件缺陷。**
   *
   * `AcquireBiasSeries:157` 的 `AssessFrameTrust` 与 `CalibrateCoarseStep` 的整条
   * 标定循环都挂在「`ScanAt` 回包里有 `scan_path` / `path` / `file`」上，而它一个都不写。
   * 要不要给 `ScanAt` 补这个键**是一个独立决定**（不在这一批）。
   *
   * 补上的那天这条会当场变红 —— 那正是它存在的理由。
   */
  it('回包里没有 scan_path / path / file 中的任何一个', async () => {
    const { ctx } = scriptedCtx({}, {}, null)
    const got = await IMPLEMENTED['ScanAt']!.execute(ctx, {
      center_x_m: 0,
      center_y_m: 0,
      size_m: 2e-8,
      pixels: 32,
      line_time_s: 0.01,
      purpose: 'survey',
    })
    const data = (got.data ?? {}) as Record<string, unknown>
    expect(Object.keys(data).filter((k) => ['scan_path', 'path', 'file'].includes(k))).toEqual([])
  })

  it('于是 AcquireBiasSeries 的 drift_check 恒为 null，且一次 AssessFrameTrust 都不调', async () => {
    const { ctx, runLog } = scriptedCtx({}, {}, null)
    const got = await IMPLEMENTED['AcquireBiasSeries']!.execute(ctx, {
      center_x_m: 1e-8, center_y_m: 0, size_m: 2e-8, biases_v: '1,-1',
    })
    expect((got.data as Record<string, unknown>)['drift_check']).toBeNull()
    expect(runLog.map((r) => r.skill)).toEqual(['ScanAt', 'ScanAt', 'ScanAt', 'ScanAt'])
  })

  it('于是 CalibrateCoarseStep 恒在「基准帧扫描失败」返回，一次 MotorMove(x+) 都不发', async () => {
    const { ctx, runLog } = scriptedCtx({}, {}, null)
    const got = await IMPLEMENTED['CalibrateCoarseStep']!.execute(ctx, { axis: 'x' })
    expect(got.success).toBe(false)
    expect(got.error).toBe('基准帧扫描失败。')
    expect(runLog.filter((r) => r.skill === 'MotorMove' && r.params['direction'] === 'x+')).toEqual([])
  })
})

// ── ⑤ `RunGridExperiment` 的 `start_time`：丢的是值，钉的是形状 ───────────

describe('批 7b-2 · start_time 的形状（值被两侧不同的钟原点吃掉了）', () => {
  it('start_experiment 之后 partial_data 里有一个有限的 start_time，而且 elapsed 由它算', async () => {
    const c = SKILLS['grid/timeout']
    const { ctx } = scriptedCtx(c.verbs, c.runs, null)
    const got = await IMPLEMENTED['RunGridExperiment']!.execute(
      ctx,
      c.params as Record<string, unknown>,
    )
    const prog = (got.data as any)['_progress']
    const t = prog.partial_data['start_time']
    expect(typeof t).toBe('number')
    expect(Number.isFinite(t)).toBe(true)
    // 超时那条判据真的走到了 —— 而它算的是 `now − start_time`。
    expect(prog.partial_data['timed_out']).toBe(true)
    expect(got.error).toBe('Grid experiment timed out after 10.0s')
  })
})

// ── ⑥ `.dat` 归属的三道闸（金样编不出来，理由见抬头）────────────────────

describe('批 7b-2 · AcquireDeltaFCurve 的 .dat 归属三道闸', () => {
  const NOW_S = 1_700_000_000

  function fixture(): { dir: string; put: (name: string, ageS: number) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'b7b2-dat-')).replaceAll('\\', '/')
    const put = (name: string, ageS: number): string => {
      const p = `${dir}/${name}`
      writeFileSync(p, 'x')
      utimesSync(p, NOW_S - ageS, NOW_S - ageS)
      // `existingDirs` 走 `realpathSync`，Windows 上还回来的是反斜杠 —— 技能报的
      // 路径由**它**决定，所以期望值也照它来（不是我们拼的那一串）。
      return p.replaceAll('/', sep)
    }
    return { dir, put }
  }

  /**
   * `dirs` 给两个时表示**两次 `Util_SessionPathGet` 看到的不是同一个目录** ——
   * 那正是水位线那道闸唯一够得着的形状（见 ③）。
   */
  async function run(
    dir: string | readonly [string, string],
    params: Record<string, unknown>,
  ): Promise<SkillResultLike> {
    const seq = typeof dir === 'string' ? [dir, dir] : [dir[0], dir[1]]
    let nth = 0
    const skill = makeAcquireDeltaFCurve({
      candidateDirs: async () => [seq[Math.min(nth++, 1)] as string],
      nowS: () => NOW_S,
    })
    const { ctx } = scriptedCtx(
      {
        PLL_OutOnOffGet: [{ body: [1] }],
        PLL_CenterFreqGet: [{ body: [30000.0] }],
        PLL_FreqShiftGet: [{ body: [-1.0] }],
        PLL_AmpCtrlSetpntGet: [{ body: [5e-11] }],
        ZSpectr_Start: [{ body: [0, 0, ['Z rel (m)', 'OC M1 Freq. Shift (Hz)'], 2, 3,
          [0, -1e-11, -2e-11, -2.0, -5.0, -3.0]] }],
      },
      {},
      null,
    )
    return skill.execute(ctx, { z_sweep_distance_m: 5e-10, channel_indexes: '3,0', ...params })
  }

  it('① 找得到 ⇒ 报路径', async () => {
    const { dir, put } = fixture()
    const p = put('Fe_atom001.dat', 10)
    const got = await run(dir, { save_basename: 'Fe_atom' })
    expect((got.data as Record<string, unknown>)['path']).toBe(p)
    expect((got.data as Record<string, unknown>)['warnings']).toBeUndefined()
  })

  it('② 名字里没有这个 basename ⇒ 不是这次的测量', async () => {
    const { dir, put } = fixture()
    put('OtherThing001.dat', 10)
    const got = await run(dir, { save_basename: 'Fe_atom' })
    expect((got.data as Record<string, unknown>)['path']).toBeUndefined()
    expect((got.data as Record<string, unknown>)['warnings']).toEqual(['dat_attribution_failed'])
  })

  /**
   * ⚠️ **这道闸只有一种形状够得着**，而找到它花了一次演练：
   *
   * 水位线取的是「采集**之前**盘上最新的那个 `.dat` 的 mtime」，而归属取的是
   * 「采集**之后**盘上最新的那个」。**同一个目录里，后者永远不可能比前者旧** ——
   * 于是 `mtime < watermark − 1e-6` 在一个静止的目录上恒为假（第一版的用例
   * 被**名字**那道闸先接走了，那条变异因此报绿）。
   *
   * 真的够得着它的只有一件事：**两次 `Util_SessionPathGet` 看到的不是同一个目录**
   * （操作员中途换了 session 目录，或者那个目录被移走了）。这里就摆这一幕。
   */
  it('③ 比采集开始前那道水位线**旧** ⇒ 不是这次的（继承上一个点的文件是唯一会安静毁掉一整轮的错）', async () => {
    const a = fixture()
    const b = fixture()
    a.put('zz_watermark.dat', 5) // 采集之前：水位线 = now − 5
    b.put('Fe_atom_OLD.dat', 50) // 采集之后换了目录，里面那份是 50 s 前的
    const got = await run([a.dir, b.dir], { save_basename: 'Fe_atom' })
    expect((got.data as Record<string, unknown>)['path']).toBeUndefined()
    expect((got.data as Record<string, unknown>)['warnings']).toEqual(['dat_attribution_failed'])
  })

  it('③′ 同一个目录、只有一份旧文件 ⇒ 水位线就是它自己，**名字**那道闸才是拦住它的那个', async () => {
    // 与 ③ 配对：说明为什么 ③ 必须换目录。这里 `mtime == watermark`，
    // `mtime < watermark − 1e-6` 为假 —— 拦住它的是 basename。
    const { dir, put } = fixture()
    put('Fe_atom_OLD.dat', 50)
    const got = await run(dir, { save_basename: 'Fe_atom' })
    // 名字带着 basename ⇒ 三道闸全过 ⇒ 它**被当成这次的**。
    expect((got.data as Record<string, unknown>)['path']).toBe(`${dir}/Fe_atom_OLD.dat`.replaceAll('/', sep))
  })

  it('④ 一个都没有 ⇒ 不编一个（一条错的路径会把分析 agent 指到别人的数据上）', async () => {
    const { dir } = fixture()
    const got = await run(dir, { save_basename: 'Fe_atom' })
    expect((got.data as Record<string, unknown>)['path']).toBeUndefined()
    expect((got.data as Record<string, unknown>)['warnings']).toEqual(['dat_attribution_failed'])
  })

  it('⑤ 超过 120 s 就不算「刚落盘」', async () => {
    const { dir, put } = fixture()
    put('Fe_atom001.dat', 300)
    const got = await run(dir, { save_basename: 'Fe_atom' })
    expect((got.data as Record<string, unknown>)['path']).toBeUndefined()
  })

  it('⑥ basename 为空 ⇒ 名字那一道不判（旧仓 `if basename and …`）', async () => {
    const { dir, put } = fixture()
    const p = put('WhateverNanonisPicked.dat', 10)
    const got = await run(dir, {})
    expect((got.data as Record<string, unknown>)['path']).toBe(p)
  })
})

// ── ⑦ `CalibrateCoarseStep` 的循环：**明写是假设**的那几格 ────────────────

describe('批 7b-2 · CalibrateCoarseStep 的标定循环（hypothetical —— 今天到不了，见抬头）', () => {
  /**
   * 这几条给的 `scan_path` 是**假的**：`ScanAt` 今天不返回它（§④ 那条测试量着）。
   * 它们验的是「那条路真的被补上之后，循环里的判据是对的」。
   *
   * 期望值的来源写清楚：位移与锐度来自本文件 §② 的 `phase_shift` 金样
   * （同一对帧、同一份 `.sxm` 字节），`nm_per_step = dx_nm / n` 是它上面的算术。
   * **没有**一个数是我手抄的。
   */
  // `nm_per_px = size_m·1e9 / 256`，而 `size_m` 缺省 1.5e-6 —— **256 是写死的**
  // （旧仓 `_scan` 固定 `pixels: 256`，与帧里真的有多少行无关）。
  const nmPx = (1.5e-6 * 1e9) / 256.0

  function sxm(frame: readonly (readonly number[])[]): Buffer {
    const rows = frame.length
    const cols = (frame[0] ?? []).length
    const head = [
      ':NANONIS_VERSION:', '2',
      ':SCANIT_TYPE:', '              FLOAT            MSBFIRST',
      ':SCAN_PIXELS:', `        ${cols}         ${rows}`,
      ':SCAN_RANGE:', `${(1.5e-6).toExponential(6).toUpperCase().padStart(22)}${(1.5e-6).toExponential(6).toUpperCase().padStart(22)}`,
      ':SCAN_OFFSET:', `${(0).toExponential(6).toUpperCase().padStart(22)}${(0).toExponential(6).toUpperCase().padStart(22)}`,
      ':SCAN_DIR:', 'down',
      ':SCAN_ANGLE:', '       0.000E+0',
      ':DATA_INFO:', '\tChannel\tName\tUnit\tDirection\tCalibration\tOffset',
      '\t0\tZ\tm\tboth\t9.000E-9\t0.000E+0',
      ':SCANIT_END:', '',
    ].join('\n')
    const body = Buffer.alloc(rows * cols * 4 * 2)
    let at = 0
    for (let pass = 0; pass < 2; pass += 1) {
      for (const row of frame) {
        for (const v of row) {
          body.writeFloatBE(v, at)
          at += 4
        }
      }
    }
    return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from('\\1A\\04', 'latin1'), body])
  }

  const PS = GOLDEN['phase_shift'] as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'b7b2-sxm-')).replaceAll('\\', '/')
  const paths: Record<string, string> = {}
  for (const key of ['identity', 'shift_x_plus5', 'shift_xy', 'uncorrelated_low_snr']) {
    for (const side of ['a', 'b'] as const) {
      const p = `${dir}/${key}_${side}.sxm`
      writeFileSync(p, sxm(PS[key][side] as number[][]))
      paths[`${key}_${side}`] = p
    }
  }

  async function runLoop(scanPaths: readonly string[], extra: Record<string, any[]> = {}) {
    const { ctx, runLog } = scriptedCtx(
      {},
      {
        ScanAt: scanPaths.map((p) => ({ success: true, data: { scan_path: p } })),
        GetCurrent: [{ success: true, data: { current_a: 2e-13 } }],
        ...extra,
      },
      null,
    )
    const got = await IMPLEMENTED['CalibrateCoarseStep']!.execute(ctx, {
      axis: 'x', steps: '2,4', make_pit: false,
    })
    return { got, runLog }
  }

  it('两帧完全一样 ⇒ 位移 0、锐度极高 ⇒ 每步 0 nm、线性（spread 算出来是 0/0 的保护）', async () => {
    const { got } = await runLoop([paths['identity_a']!, paths['identity_b']!, paths['identity_b']!])
    const d = got.data as any
    expect(d.runs.length).toBe(2)
    expect(d.runs[0].dx_nm).toBe(0)
    expect(d.runs[0].nm_per_step_x).toBe(0)
    expect(d.verdict).toBe('ok')
  })

  it('位移与锐度与 phase_shift 金样同源；nm_per_step = dx_nm / n', async () => {
    const { got } = await runLoop([
      paths['identity_a']!, paths['shift_x_plus5_b']!, paths['shift_xy_b']!,
    ])
    const d = got.data as any
    // 第 1 趟：identity_a → shift_x_plus5_b，就是金样 `shift_x_plus5` 那一对。
    expect(d.runs[0].dx_nm).toBeCloseTo((PS['shift_x_plus5'].dx as number) * nmPx, 9)
    expect(d.runs[0].nm_per_step_x).toBeCloseTo(d.runs[0].dx_nm / 2, 12)
    expect(d.runs[1].nm_per_step_x).toBeCloseTo(d.runs[1].dx_nm / 4, 12)
    // 两个步数给出的「每步多远」差得远超 35% ⇒ **不当刻度用**。
    // （线性那一侧由上一条给：两帧一样 ⇒ 两趟都是 0 ⇒ spread 0 ⇒ `ok`。）
    expect(d.spread_frac).toBeGreaterThan(0.35)
    expect(d.verdict).toBe('nonlinear')
    expect(String(d.message)).toContain('别当成刻度用')
  })

  it('锐度低于 12 ⇒ **拒答**，那一趟不给 nm_per_step', async () => {
    const { got } = await runLoop([
      paths['uncorrelated_low_snr_a']!, paths['uncorrelated_low_snr_b']!,
      paths['uncorrelated_low_snr_b']!,
    ])
    const d = got.data as any
    expect(d.runs[0].nm_per_step_x).toBeUndefined()
    expect(String(d.runs[0].refused)).toContain('没有可对齐的共同特征')
    expect(d.verdict).toBe('undetermined')
  })

  it('清障证不出来 ⇒ 一步马达都不动', async () => {
    const { got, runLog } = await runLoop(
      [paths['identity_a']!],
      { GetCurrent: [{ success: true, data: { current_a: 5e-11 } }] },
    )
    const d = got.data as any
    expect(d.runs[0].abort).toBe('清障未通过')
    expect(runLog.filter((r) => r.skill === 'MotorMove' && r.params['direction'] === 'x+')).toEqual([])
  })

  it('马达失败 / 重新进针失败 / 扫描失败 —— 三句不同的话', async () => {
    const a = await runLoop([paths['identity_a']!], {
      MotorMove: [
        { success: true, data: {} },
        { success: false, error: '马达没响应' },
      ],
    })
    expect((a.got.data as any).runs[0].abort).toBe('MotorMove 失败')
    const b = await runLoop([paths['identity_a']!], {
      ApproachTip: [{ success: false, error: '进不去' }],
    })
    expect((b.got.data as any).runs[0].abort).toBe('重新进针失败')
    const c = await runLoop([paths['identity_a']!, ''], {})
    expect((c.got.data as any).runs[0].abort).toBe('扫描失败')
  })

  it('扫出来了但读不动 ⇒ **与「扫描失败」分开的一句话**（旧仓这里直接抛）', async () => {
    const { got } = await runLoop([paths['identity_a']!, `${dir}/not-there.sxm`])
    expect((got.data as any).runs[0].abort).toBe('扫描图读不动')
  })
})
