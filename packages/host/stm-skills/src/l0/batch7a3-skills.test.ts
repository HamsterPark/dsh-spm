/**
 * 批 7a-3 两个技能 + `_local_plane_rms` + `_parse_excluded` 对
 * `spec/golden/batch7a3.json` 的逐格比对（DoD ③ + ⑤）。
 *
 * ## 三档容差，其余**全部逐位**
 *
 * | 字段 | 容差 | 为什么 |
 * |---|---|---|
 * | `rms_m` / `best_rms_m` / `smaller_windows[].best_rms_m` / `sites[].rms_m` | `LOCAL_RMS_REL_TOL` | 见 `analysis-flat-region.ts` 的推导（残差是相消的结果，窗内 z 的量程放大 eps） |
 * | `frame_rms_m` / `rms_ratio_to_frame` | `RANSAC_REL_TOL` | **整帧 std 由 RANSAC 扣掉的那个平面决定**，而两边的抽样序列不同（D-VISION-1）。局部残差不受影响（窗内再拟合一次平面把任何平面消掉），所以只有这两格要 |
 * | 坐标（`center_*` / `best_center_*` / `sites[].center_*`） | `16·EPS` | `rot30` 那一格过 `cos/sin`，libm 各 1 ulp |
 * | `burst_s` / `log[].t_s` | `CLOCK_REL_TOL` | 两侧的假钟摆在不同量级（旧仓 1e6 **秒**、本仓 1e6 **毫秒**），差在第 10 位。同批 5b 的 `clock_keys` |
 * | 其余（报文、计数、下标、`verdict`、`log[].target_v` / `reached_v`…） | **0** | 标签、整数、以及**随机数的直接产物** —— `target_v` 逐位相等正是「MT19937 复刻对了」的判据 |
 *
 * ⚠️ **`log[].target_v` 给容差就等于这个技能没有判据。** 一次 burst 打几次跳变
 * （`flips_executed`）由随机停留时长决定，落在哪些偏压上由随机目标决定 ——
 * 换一个 RNG，这两样全变，而每一样看起来都像一次合理的扰动。
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  emptyHardwareState,
  slowCallFrom,
  type HardwareState,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { EPS, matFromRows } from 'dsh-spm-numerics'
import { diffTree, formatMismatches, RANSAC_REL_TOL, scalesOf, toGolden } from 'dsh-spm-vision'
import { FindFlatRegion, localPlaneRms, localRmsAbsTol, parseExcluded } from './analysis-flat-region.js'
import { BiasWiggle } from './bias-wiggle.js'
import { gatedSafeCall } from '../gated-call.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/batch7a3.json', import.meta.url)), 'utf8'),
) as Record<string, any>

/**
 * 时钟派生字段的容差。
 *
 * 旧仓的假钟从 `1e6` **秒**起、每读一次 `+1e-3` 秒；本仓的从 `1e6` **毫秒**起、
 * 每读一次 `+1` 毫秒。两边的**增量**逐位相同（都是 1e-3 秒），差的是那次减法
 * 在哪个量级上做 —— `1e6` 的 ulp 是 `1.2e-10`，于是 `elapsed` 的绝对差在
 * `1e-10` 量级，相对差在 `1e-7`（burst 是零点几秒）。取 `1e-6` 留一个量级。
 *
 * 两个量都先过 `round(·, 3)`，所以实际上**多半逐位相等** —— 这条容差挡的是
 * 那个「恰好落在半分点上」的可能，而不是常态。
 */
const CLOCK_REL_TOL = 1e-6

/** 坐标那一族：`pxToM` 在转过角度的帧上过一次 `cos/sin`，libm 各 1 ulp。 */
const COORD_REL_TOL = 16 * EPS

let TMP = ''

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'batch7a3-')).replaceAll('\\', '/')
  for (const [key, b64] of Object.entries(GOLDEN['sxm_files'] as Record<string, string>)) {
    writeFileSync(`${TMP}/${key}.sxm`, Buffer.from(b64, 'base64'))
  }
})

function realPath(v: unknown): unknown {
  if (typeof v === 'string') return v.replaceAll('<tmp>', TMP)
  if (Array.isArray(v)) return v.map(realPath)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = realPath(x)
    return out
  }
  return v
}

function normalize(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replaceAll(TMP, '<tmp>')
      .replace(/(ENOENT|EISDIR|EACCES|EPERM|EBUSY)[\s\S]*/, '<oserror>')
      .replace(/\[WinError [\s\S]*/, '<oserror>')
      .replace(/\[Errno [\s\S]*/, '<oserror>')
  }
  if (Array.isArray(v)) return v.map(normalize)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = normalize(x)
    return out
  }
  return v
}

const asGolden = (r: SkillResultLike): Record<string, unknown> => ({
  success: r.success,
  error: r.error ?? '',
  summary: r.summary ?? '',
  data: r.data ?? {},
})

const wantOf = (r: any): Record<string, unknown> => ({
  success: r.success,
  error: r.error,
  summary: r.summary,
  data: r.data,
})

/** 字段 → 允许的**绝对**差额（同批 6c：不能交给 `diffTree` 去乘那个尺度）。 */
type FieldTol = ReadonlyMap<string, (want: number, scale: number) => number>

const rel = (t: number) => (want: number, scale: number): number => t * Math.max(scale, Math.abs(want))

/** 残差那一族：容差的入口是**这一格的 `leveled` z 量程**（随金样一起录）。 */
function flatTol(span: number | null): FieldTol {
  const abs = (): ((want: number, scale: number) => number) => () => localRmsAbsTol(span ?? 0)
  return new Map([
    ['.data.rms_m', abs()],
    ['.data.best_rms_m', abs()],
    ['.data.smaller_windows.best_rms_m', abs()],
    ['.data.sites.rms_m', abs()],
    ['.data.frame_rms_m', rel(RANSAC_REL_TOL)],
    ['.data.rms_ratio_to_frame', rel(RANSAC_REL_TOL)],
    ['.data.center_x_m', rel(COORD_REL_TOL)],
    ['.data.center_y_m', rel(COORD_REL_TOL)],
    ['.data.best_center_x_m', rel(COORD_REL_TOL)],
    ['.data.best_center_y_m', rel(COORD_REL_TOL)],
    ['.data.sites.center_x_m', rel(COORD_REL_TOL)],
    ['.data.sites.center_y_m', rel(COORD_REL_TOL)],
  ])
}

const WIGGLE_TOL: FieldTol = new Map([
  ['.data.burst_s', rel(CLOCK_REL_TOL)],
  ['.data.log.t_s', rel(CLOCK_REL_TOL)],
])

function compare(what: string, got: SkillResultLike, row: any, scales: Map<string, number>, loose: FieldTol): void {
  const a = normalize(toGolden(asGolden(got)))
  const ms = diffTree(a, wantOf(row), 0, scales).filter((m) => {
    const key = m.path.replace(/\[\d+\]/g, '')
    const f = loose.get(key)
    if (f === undefined || typeof m.actual !== 'number' || typeof m.want !== 'number') return true
    const scale = Math.max(scales.get(key) ?? 0, Math.abs(m.want))
    return !(Math.abs(m.actual - m.want) <= f(m.want, scale))
  })
  expect(ms.length === 0 || `${what}：${formatMismatches(ms)}`).toBe(true)
}

// ──────────────────────────────────────────────────────────────────────────
// `_local_plane_rms` —— 窗内再拟合一次平面
// ──────────────────────────────────────────────────────────────────────────

/**
 * **设计矩阵奇异那一格不照抄**（D-FLAT-?，见 `analysis-flat-region.ts` 的推导）：
 * 旧仓的 SVD 给一个最小范数解 ⇒ `rms ≈ 4.5e−28`，读起来是**一块完美的平地**；
 * 本仓的正规方程掉秩就抛 ⇒ `null`，那个窗跳过。
 */
const RMS_DEVIATIONS: ReadonlySet<string> = new Set(['collinear'])

describe('_local_plane_rms', () => {
  const rows = GOLDEN['local_plane_rms'] as any[]
  for (const c of rows) {
    it(c.case as string, () => {
      const patch = matFromRows((c.patch as unknown[][]).map((r) => r.map(num)))
      const got = localPlaneRms(patch)
      if (RMS_DEVIATIONS.has(c.case as string)) {
        // 登记里说的是「旧仓给一个**接近 0 的数**，本仓给 null」——
        // 这两句都断言，于是**差异消失的那天这条会红**，登记必须跟着删。
        expect(got).toBeNull()
        expect(typeof c.rms === 'number' && Math.abs(num(c.rms)) < 1e-20).toBe(true)
        return
      }
      expect([c.case, got === null]).toEqual([c.case, c.rms === null])
      if (c.rms !== null) {
        const want = num(c.rms)
        // ⚠️ 入口是**窗内 z 的量程**，不是残差本身 —— 见 `localRmsAbsTol` 的推导。
        const allowed = localRmsAbsTol(num(c.z_span))
        expect(
          Math.abs((got as number) - want) <= allowed ||
            `${c.case}: 得到 ${got}，金样 ${want}（差 ${Math.abs((got as number) - want)}，允许 ${allowed}）`,
        ).toBe(true)
      }
    })
  }
  it('少于 12 个有效点判不了，**12 个就判**（边界闭）', () => {
    const twelve = rows.find((r) => r.case === 'exactly_twelve')
    const few = rows.find((r) => r.case === 'too_few')
    expect([twelve.rms === null, few.rms === null]).toEqual([false, true])
    expect(localPlaneRms(matFromRows((twelve.patch as unknown[][]).map((r) => r.map(num))))).not.toBeNull()
    expect(localPlaneRms(matFromRows((few.patch as unknown[][]).map((r) => r.map(num))))).toBeNull()
  })
})

const num = (v: unknown): number =>
  v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : (v as number)

// ──────────────────────────────────────────────────────────────────────────
// `_parse_excluded` —— 解析不了要**说出来**
// ──────────────────────────────────────────────────────────────────────────

/**
 * `nan,0` / `inf,0` —— **D-SI-1 的第二例**（已登记）。
 *
 * 旧仓宽松档的 `parse_quantity` 直接走 `float()`，于是 `'nan'` / `'inf'` 被
 * **当成合法坐标收下**；本仓抛 `SIParseError`，于是它们进 `bad`、整次调用被拒。
 *
 * 这一处不是「更严格一点」，它正是 D-SI-1 那条登记里写的后果：
 * 一个 NaN 坐标穿过之后，`(cx − nan)² + (cy − nan)² < min_sep²` **恒为假**
 * ⇒ 「别再选这几个点」悄悄变成「一个都不排除」，而调用方会以为回避生效了。
 * 而这个技能的报文自己就写着：**「没有把这些点排除掉就选点是危险的」**。
 */
const EXCL_DEVIATIONS: ReadonlySet<string> = new Set(['nan,0', 'inf,0'])

describe('_parse_excluded（逐格对金样）', () => {
  for (const c of GOLDEN['parse_excluded'] as any[]) {
    const raw = c.raw as string
    it(JSON.stringify(raw), () => {
      const [pts, bad] = parseExcluded(raw)
      if (EXCL_DEVIATIONS.has(raw)) {
        // 两侧都断言：本仓拒，而**旧仓收下了** —— 差异消失这条就红。
        expect([pts.length, [...bad]]).toEqual([0, [raw]])
        expect((c.bad as string[]).length).toBe(0)
        expect((c.points as unknown[]).length).toBe(1)
        return
      }
      expect(pts.map((p) => [...p])).toEqual(c.points)
      expect([...bad]).toEqual(c.bad)
    })
  }
  it('**看不懂的块进 bad，不静默丢弃** —— 这是整条判据', () => {
    const row = (GOLDEN['parse_excluded'] as any[]).find((r) => r.raw === '1n,2n;oops;3n;4n,5n,6n')
    // 三种坏法各一个：不是数（`oops`）、只有一段（`3n`）、三段（`4n,5n,6n`）。
    // 而**能读懂的那一个照样留下** —— 拒绝的是整次调用，不是丢掉这几块。
    expect(row.bad).toEqual(['oops', '3n', '4n,5n,6n'])
    expect((row.points as unknown[]).length).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// `FindFlatRegion`
// ──────────────────────────────────────────────────────────────────────────

describe('FindFlatRegion', () => {
  const rows = GOLDEN['skills']['FindFlatRegion'] as any[]
  const scales = scalesOf(rows.map(wantOf))
  for (const row of rows) {
    it(row.case as string, async () => {
      const params = realPath(row.params) as Record<string, unknown>
      const got = await FindFlatRegion.execute({} as SkillContext, params)
      compare(`FindFlatRegion/${row.case}`, got, row, scales, flatTol(row.leveled_span_m as number | null))
    })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// `BiasWiggle`
// ──────────────────────────────────────────────────────────────────────────

const S0: HardwareState = emptyHardwareState('T0')

interface WiggleHarness {
  readonly ctx: SkillContext
  readonly calls: { verb: string; args: unknown[] }[]
}

/**
 * 与导出器 `_ScriptedContext` **同一份脚本**驱动的夹具。
 *
 * 三处必须与那一边逐条对齐，否则比的就不是同一件事：
 *
 * 1. **队列取完重复最后一个**（轮询要调几百次同一个动词）；
 * 2. **假钟**：`now()` 每读一次 +1 ms、`sleep(ms)` 往前拨 —— 与旧仓
 *    `+1e-3 s` / `sleep` 同一套，只差量级；
 * 3. **中止的谓词**：`calls.length >= abortAfter`，与那边
 *    `len(self.calls) >= abort_after` 同一个式子、同一个计数点
 *    （记完这一次调用之后）。
 */
function wiggleHarness(verbs: Record<string, any[]>, abortAfter: number | null): WiggleHarness {
  const calls: { verb: string; args: unknown[] }[] = []
  const idx: Record<string, number> = {}
  let clock = 1_000_000
  const ctl = new AbortController()
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    if (calls.length > 5000) throw new Error(`调用预算用尽（${method}）`)
    const q = verbs[method] ?? []
    const i = idx[method] ?? 0
    idx[method] = i + 1
    const spec = q.length === 0 ? null : q[Math.min(i, q.length - 1)]
    const rec: SkillCallRecord =
      spec === null
        ? { method, args, values: [0.0] }
        : spec.error !== undefined
          ? { method, args, error: spec.error as string }
          : { method, args, values: (spec.body as unknown[]).map(num) }
    calls.push({ verb: method, args })
    if (abortAfter !== null && calls.length >= abortAfter) ctl.abort()
    return Promise.resolve(rec)
  }
  const ctx: SkillContext = {
    signal: ctl.signal,
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
    owner: 'batch7a3',
    rootCallId: 'batch7a3',
    approvalSource: 'llm',
    runSkill: () => Promise.resolve({ success: false, error: 'no sub-skills here' }),
  }
  return { ctx, calls }
}

describe('BiasWiggle', () => {
  const rows = GOLDEN['wiggle'] as any[]
  const scales = scalesOf(rows.map(wantOf))
  for (const row of rows) {
    it(`${row.case}：回包`, async () => {
      const h = wiggleHarness(row.verbs as Record<string, any[]>, (row.abort_after ?? null) as number | null)
      const got = await BiasWiggle.execute(h.ctx, row.params as Record<string, unknown>)
      compare(`BiasWiggle/${row.case}`, got, row, scales, WIGGLE_TOL)
    })
    it(`${row.case}：动词序列与实参`, async () => {
      const h = wiggleHarness(row.verbs as Record<string, any[]>, (row.abort_after ?? null) as number | null)
      await BiasWiggle.execute(h.ctx, row.params as Record<string, unknown>)
      // ⚠️ 只比 `[verb, args]`，**不比 kwargs**：旧仓收尾那几次带
      // `allow_on_abort=True`，而本仓没有那个口（D-WIGGLE-?，见
      // `bias-wiggle.ts` 的抬头）。下面那条测试单独把这件事钉住。
      expect(h.calls.map((c) => [c.verb, c.args])).toEqual(
        (row.calls as any[]).map((c) => [c.verb, c.args]),
      )
    })
  }

  /**
   * **中止闩上之后，这个技能放不回偏压** —— 把这个洞钉住，而不是把它藏起来。
   *
   * 旧仓的收尾走 `safe_call(..., allow_on_abort=True)`；本仓没有那个口
   * （`SafeCall` 的签名是 `(method, ...args)`），而 `Bias_Set` 不在
   * `ABORT_SAFE_WRITES` 里 —— 那张表是按**「停」的语义**建的，而
   * `Bias_Set` 没有哪个实参形能表达「停」。
   *
   * 今天这不改变任何人的行为：本仓还没有任何地方把 `gatedSafeCall` 接进
   * `SkillContext.safeCall`（中止闩在工具入口的 K2 与 `stm-safety` 的 guard 上）。
   * 但**那一天一定会来**，而那时这个技能会：每一次 `Bias_Set` 被拒 ⇒ 第一次跳变
   * 就停 ⇒ 收尾也被拒 ⇒ 而 `data.bias_restored` **照样报 `true`**。
   *
   * 这条测试就是把那一幕摆出来。它红的那天，说明有人开了那个口 ——
   * 而那时 `bias_restored` 必须跟着改成实话。
   */
  it('⚠️ 中止闩上时：`Bias_Set` 全被拒，而 `bias_restored` 照样报 true（本批的欠账）', async () => {
    const sent: string[] = []
    const inner = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
      sent.push(method)
      const values = method === 'ZCtrl_OnOffGet' ? [1.0] : method === 'Bias_Get' ? [0.02] : [3e-10]
      return Promise.resolve({ method, args, values })
    }
    const gated = gatedSafeCall({ call: inner, abortLatched: () => true })
    const h = wiggleHarness({}, null)
    const ctx: SkillContext = { ...h.ctx, safeCall: gated }
    const got = await BiasWiggle.execute(ctx, { base_bias_v: 0.02, burst_s: 0.3, seed: 7 })

    expect(got.success).toBe(false)
    expect(got.error).toContain('扰动在第 1 次跳变时停下：Bias_Set 失败: abort_latched')
    // 读全放行、写一次都没到仪器 —— 针尖停在一个随机的扰动偏压上。
    expect(sent).toEqual(['ZCtrl_OnOffGet', 'Bias_Get'])
    // **这一格是那个洞**：回包说放回去了，而一次 `Bias_Set` 都没发出去。
    expect((got.data as Record<string, unknown>)['bias_restored']).toBe(true)
  })

  it('**收尾那几次在旧仓是带 `allow_on_abort=True` 的**，本仓没有那个口', () => {
    // 这条不是「差异登记」的装饰 —— 它证明**那个差异还在**。
    // 哪天 `gated-call.ts` 开了那个口，它会红，于是 deviation 必须跟着删。
    const withKw = (GOLDEN['wiggle'] as any[]).flatMap((r) =>
      (r.calls as any[]).filter((c) => Object.keys(c.kwargs ?? {}).length > 0).map((c) => [r.case, c.verb, c.kwargs]),
    )
    expect(withKw.length > 0).toBe(true)
    expect([...new Set(withKw.map((x) => JSON.stringify([x[1], x[2]])))]).toEqual([
      JSON.stringify(['Bias_Set', { allow_on_abort: true }]),
    ])
  })
})
