/**
 * 批 4a 九个技能对 `spec/golden/analysis.json` 的**逐格**比对（DoD ③ + ⑤）。
 *
 * ## 这一份比的是**整棵返回值**，不是几个挑出来的字段
 *
 * 金样里每一格都是**旧仓真技能**跑在同一批 `.sxm` 字节上的完整
 * `SkillResult`（`success` / `error` / `summary` / `data`）。这里把 TS 那一侧的
 * 返回值整棵摆过去逐叶子比：
 *
 * * **字符串逐字**。它们里面印着 `%.1f` / `%.0f` / `%g` 的数 ——
 *   于是一条字符串断言等于一条「这个数精确到那一位」的断言，
 *   而且它顺带钉住了措辞（模型读的就是那句话）。
 * * **布尔 / null / 整数计数逐位**。
 * * **浮点**按各自那条容差，归一化用「同一字段在这一批用例上的最大绝对值」
 *   （见 `vision/golden.ts` 的抬头：一个逐元素的相对比较不是容差，是抽签）。
 *
 * ## 两处**刻意**对不上的地方，在这里归一化掉
 *
 * | | 为什么 |
 * |---|---|
 * | `[WinError 2] …` / `ENOENT: …` | 操作系统那句话带着本机的语言环境，而 Node 与 Python 的措辞本来就不同。**判据是它前面那半句**（谁在报、报的是哪条路径） |
 * | `原始回包：(…)` | 信封在本仓的 wire 层已经拆掉（D-SKILL-1），两边的「原始回包」不是同一个对象 |
 *
 * 归一化在**两侧**都做（导出器那边同一组正则），所以它是一条写下来的规则，
 * 不是一次「让它过去」。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { diffTree, formatMismatches, scalesOf, toGolden } from 'dsh-spm-vision'
import { ROW_JUMP_REL_TOL } from 'dsh-spm-vision'
import { RANSAC_REL_TOL } from 'dsh-spm-vision'
import { scanPrepProfiles } from 'dsh-spm-kernel'
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { ANALYSIS_CLUSTERS } from './analysis-clusters.js'
import { ANALYSIS_FRAMES } from './analysis-frames.js'
import { ANALYSIS_LINES } from './analysis-lines.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/analysis.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const SKILLS: Record<string, Skill> = { ...ANALYSIS_CLUSTERS, ...ANALYSIS_FRAMES, ...ANALYSIS_LINES }

/** 技能返回值里那几个 RANSAC 下游的字段 —— 容差与推导在 `vision` 那一侧。 */
const RANSAC_FIELDS = new Set([
  '.data.row_jump_mad_pm',
  '.data.row_jump_sigma_pm',
  '.data.rms_pm',
  '.data.pv_pm',
  '.data.per_direction.forward.levels_pm',
  '.data.per_direction.backward.levels_pm',
  '.data.per_direction.forward.gaps_pm',
  '.data.per_direction.backward.gaps_pm',
  '.data.per_direction.forward.kept_gaps_pm',
  '.data.per_direction.backward.kept_gaps_pm',
  '.data.per_direction.forward.step_pm',
  '.data.per_direction.backward.step_pm',
  '.data.per_direction.forward.inlier_ratio',
  '.data.per_direction.backward.inlier_ratio',
  '.data.step_pm',
  '.data.fwd_bwd_diff_pm',
])

let TMP = ''
const PATHS: Record<string, string> = {}

beforeAll(() => {
  // 那份**标定过的**外部 profile —— 旧仓从 `config/scan_prep_profiles.json` 读，
  // 本仓是注入（D-VAC-1 那一族）。两边喂同一份，否则 `AssessFrameCorrugation`
  // 的三格 `calibrated_*` 比的是「空 profile」而不是那套阈值。
  scanPrepProfiles.external['calibrated-10nm'] = {
    name: 'calibrated-10nm',
    provenance: '合成的一份：10 nm 上标的 40 pm 上限（导出器写的）',
    corrugationHighPm: 40.0,
    corrugationRefScanNm: 10.0,
  }
  TMP = mkdtempSync(join(tmpdir(), 'analysis-golden-'))
  for (const [key, b64] of Object.entries(GOLDEN['sxm_files'] as Record<string, string>)) {
    const p = `${TMP.replaceAll('\\', '/')}/${key}.sxm`
    writeFileSync(p, Buffer.from(b64, 'base64'))
    PATHS[key] = p
  }
})

/** 把金样里的 `<tmp>` 换成本次运行的临时目录（反过来也做一次，见下）。 */
function realPath(v: unknown): unknown {
  if (typeof v === 'string') return v.replaceAll('<tmp>', TMP.replaceAll('\\', '/'))
  if (Array.isArray(v)) return v.map(realPath)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = realPath(x)
    return out
  }
  return v
}

/** 与导出器同一组归一化：抹掉临时目录、操作系统那句错、以及信封。 */
function normalize(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replaceAll(TMP.replaceAll('\\', '/'), '<tmp>')
      .replaceAll(TMP, '<tmp>')
      .replace(/(ENOENT|EISDIR|EACCES|EPERM|EBUSY)[\s\S]*/, '<oserror>')
      .replace(/\[WinError [\s\S]*/, '<oserror>')
      .replace(/\[Errno [\s\S]*/, '<oserror>')
      .replace(/原始回包：[\s\S]*/, '原始回包：<envelope>')
  }
  if (Array.isArray(v)) return v.map(normalize)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = normalize(x)
    return out
  }
  return v
}

/**
 * 摆成旧仓 `SkillResult` 的形状。
 *
 * ⚠️ 两个缺省值**不一样**，而且这不是小事：旧仓 `error` 的缺省是**空串**
 * （「没有错误」），`summary` 的缺省是 `None`（「这个技能没写一句话」）。
 * 本仓的 `SkillResultLike` 两个都是 `undefined`，所以这里要分开还原 ——
 * 把 `error` 还成 `null` 会让每一格成功的用例都对不上，而把 `summary`
 * 还成 `''` 会让「没写摘要」看起来像「写了一句空话」。
 */
function asGolden(r: SkillResultLike): Record<string, unknown> {
  return {
    success: r.success,
    error: r.error ?? '',
    summary: r.summary ?? null,
    // `data` 的缺省是**空表**（旧仓 `SkillResult` 的 `field(default_factory=dict)`）。
    data: r.data ?? {},
  }
}

/**
 * ⚠️ **D-ADATOM-1**：旧仓 `VerifyAdatomAt` 读 `c["peak_height_m"]`，而
 * `ExtractClusters` 交出来的键叫 `peak_height_pm` —— 于是 `others[].peak_height_m`
 * 恒为 `None`，而 `min_peak_height_m` 一给就把**每一个**候选滤掉，
 * 技能报 `not_found`（「原子不在那儿」）。本仓按 pm 读并换算。
 *
 * 这两格因此**刻意**与金样不同；它们有自己的一条测试（下面那个 describe），
 * 在差分里排除，而不是靠调容差让它过去。
 */
const ADATOM_DEVIATION_FIELDS = /^\.data\.others\.peak_height_m$/
const ADATOM_DEVIATION_CASES = new Set(['min_peak_filter'])

/**
 * ⚠️ **D-ATOMLINE-1**：旧仓 `_scan_readout.first_values` 取的是三段信封的第三段，
 * 也就是**整个 body**，然后拿它当名字表用 —— 于是「按信号名找 Z」那一支
 * 在真回包上永远命不中，结果一律落到兜底那一支。本仓按 `body[2]` 取名字表，
 * 那一支真的能命中。这个字段因此**刻意**不同。
 */
const ATOMLINE_DEVIATION_FIELD = '.data.channel_source'

/**
 * ⚠️ **常数帧上的谱峰是抽签**：去趋势之后只剩舍入（1e-25 量级），
 * 峰位与 SNR 由两边各自的舍入决定。结构字段照比，这三个不比 ——
 * 比它们等于给一个抽签结果盖章（同 `vision.test.ts` 的 `flat_row`）。
 */
const FLAT_FRAME_LOTTERY = new Set(['.data.period_median_nm', '.data.line_snr_median',
  '.data.line_snr_p90', '.data.advisory', '.summary'])

/**
 * ⚠️ `MeasureStepHeight` 的 `terraces` 那一格走 `sigma=None` ⇒ RANSAC 抽签
 * （见 `plane.ts` 的 `RANSAC_REL_TOL`）。它的 `summary` 里印着 `%.2f` 的台阶高度
 * 与 `%.3f` 的内点率，于是**那句话本身**被抽签改掉了一位（236.23 对 236.24、
 * 0.391 对 0.390）。数值层已经按容差比过了；这一句在这一格不逐字比，
 * 而 `terraces_sigma` 那一格（内点集定死）**逐字比**，它替这一句把关。
 */
const STEP_HEIGHT_LOTTERY_SUMMARY = new Set(['terraces'])

/** 逐格比。RANSAC 下游的字段走 `ROW_JUMP_REL_TOL`，其余走 `RANSAC_REL_TOL`。 */
function expectCase(name: string, key: string, got: SkillResultLike, want: unknown, scales: Map<string, number>): void {
  const a = normalize(toGolden(asGolden(got)))
  const ms = diffTree(a, want, RANSAC_REL_TOL, scales).filter((m) => {
    const flat = m.path.replace(/\[\d+\]/g, '')
    if (name === 'VerifyAdatomAt' && ADATOM_DEVIATION_FIELDS.test(flat)) return false
    if (name === 'AssessAtomicLines' && flat === ATOMLINE_DEVIATION_FIELD) return false
    if (name === 'AssessAtomicLines' && key === 'err_flat_frame' && FLAT_FRAME_LOTTERY.has(flat)) return false
    if (name === 'MeasureStepHeight' && STEP_HEIGHT_LOTTERY_SUMMARY.has(key) && flat === '.summary') return false
    if (!RANSAC_FIELDS.has(m.path.replace(/\[\d+\]/g, ''))) return true
    // RANSAC 下游那几个：抽样序列不同 ⇒ 内点集在带边缘上差几个点。
    if (typeof m.actual !== 'number' || typeof m.want !== 'number') return true
    const scale = Math.max(scales.get(m.path.replace(/\[\d+\]/g, '')) ?? 0, Math.abs(m.want))
    return !(Math.abs(m.actual - m.want) <= ROW_JUMP_REL_TOL * scale)
  })
  expect(ms.length === 0 || `${name}/${key}：${formatMismatches(ms)}`).toBe(true)
}

/** 一个只答固定桩的 `SkillContext`（`AssessAtomicLines` 用）。 */
function fakeCtx(stub: Record<string, unknown>, calls: SkillCallRecord[]): SkillContext {
  const safeCall = async (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    const entry = stub[method]
    let rec: SkillCallRecord
    if (entry === undefined) rec = { method, args, error: `no stub for ${method}` }
    else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'error' in entry) {
      rec = { method, args, error: String((entry as Record<string, unknown>)['error']) }
    } else rec = { method, args, values: entry as readonly unknown[] }
    calls.push(rec)
    return rec
  }
  return { safeCall } as unknown as SkillContext
}

// ──────────────────────────────────────────────────────────────────────────

describe('批 4a —— 技能级差分（逐格对旧仓）', () => {
  for (const name of ['ExtractClusters', 'AssessClusterRoundness', 'SelectPokedCluster', 'VerifyAdatomAt',
    'MeasureStepHeight', 'AssessFrameTrust', 'LocateStepEdge', 'AssessFrameCorrugation'] as const) {
    describe(name, () => {
      const rows = GOLDEN['skills'][name] as any[]
      const scales = scalesOf(rows.map((r) => r.result))
      // `mean` 是**去平面之后**整帧的均值 —— 按构造它是 0，实际值是舍入
      // （实测 4e-26 对 -5e-25）。它的尺度是同一份数据里的 `std`，不是它自己。
      const std = scales.get('.data.std')
      if (std !== undefined) scales.set('.data.mean', std)
      for (const row of rows) {
        if (name === 'VerifyAdatomAt' && ADATOM_DEVIATION_CASES.has(row.key as string)) continue
        it(row.key as string, async () => {
          const skill = SKILLS[name] as Skill
          const params = realPath(fromGoldenParams(row.params)) as Record<string, unknown>
          const got = await skill.execute({} as SkillContext, params)
          expectCase(name, row.key as string, got, row.result, scales)
        })
      }
    })
  }

  describe('AssessAtomicLines', () => {
    const rows = GOLDEN['skills']['AssessAtomicLines'] as any[]
    const scales = scalesOf(rows.map((r) => r.result))
    for (const row of rows) {
      it(row.key as string, async () => {
        const stub = (GOLDEN['atomic_lines_stubs'] as Record<string, Record<string, unknown>>)[row.stub as string]
        const calls: SkillCallRecord[] = []
        const ctx = fakeCtx(fromGoldenStub(stub) as Record<string, unknown>, calls)
        const got = await (SKILLS['AssessAtomicLines'] as Skill).execute(ctx, row.params as Record<string, unknown>)
        // **调用序列也是判据**：读缓冲 → 读信号名 → 读视野 → 抓帧，一步都不能少或多。
        expect([row.key, calls.map((c) => c.method)]).toEqual([row.key, (row.calls as any[]).map((c) => c.verb)])
        expectCase('AssessAtomicLines', row.key as string, got, row.result, scales)
      })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 两条**刻意**与旧仓不同的判据，各自一条测试
// ──────────────────────────────────────────────────────────────────────────

describe('D-ADATOM-1：`min_peak_height_m` 在旧仓把候选全滤光了', () => {
  it('旧仓报 `not_found`（「原子不在那儿」），本仓照实报 `at_target`', () => {
    const row = (GOLDEN['skills']['VerifyAdatomAt'] as any[]).find((r) => r.key === 'min_peak_filter')
    // 先把旧仓那一侧钉住 —— 差异消失时这条登记会当场变红，而不是安静地留着。
    expect(row.result.data.verdict).toBe('not_found')
    expect(row.result.data.n_candidates).toBe(0)
  })

  it('同一格：本仓按 `peak_height_pm × 1e-12` 读，于是滤器真的在滤', async () => {
    const row = (GOLDEN['skills']['VerifyAdatomAt'] as any[]).find((r) => r.key === 'min_peak_filter')
    const params = realPath(row.params) as Record<string, unknown>
    const got = await (SKILLS['VerifyAdatomAt'] as Skill).execute({} as SkillContext, params)
    const d = got.data as Record<string, unknown>
    expect(d['verdict']).toBe('at_target')
    expect(d['n_candidates']).toBe(4)
    // `others` 里的峰高也是**真的数**，不是一串 `null`
    const others = d['others'] as Record<string, unknown>[]
    expect(others.every((o) => typeof o['peak_height_m'] === 'number' && (o['peak_height_m'] as number) > 0)).toBe(true)
  })

  it('滤器仍然会滤 —— 把门抬到 1 nm，四个候选一个不剩', async () => {
    const row = (GOLDEN['skills']['VerifyAdatomAt'] as any[]).find((r) => r.key === 'min_peak_filter')
    const params = { ...(realPath(row.params) as Record<string, unknown>), min_peak_height_m: 1e-9 }
    const got = await (SKILLS['VerifyAdatomAt'] as Skill).execute({} as SkillContext, params)
    expect((got.data as Record<string, unknown>)['n_candidates']).toBe(0)
  })
})

describe('D-ATOMLINE-1：「按信号名找 Z」那一支在旧仓是死的', () => {
  it('旧仓落到兜底（而兜底**说自己是兜底**）', () => {
    const row = (GOLDEN['skills']['AssessAtomicLines'] as any[]).find((r) => r.key === 'ok_default')
    expect(row.result.data.channel_source).toBe('兜底：缓冲里非电流的那一路')
  })

  it('本仓按 `body[2]` 取名字表，于是那一支真的命中', async () => {
    const row = (GOLDEN['skills']['AssessAtomicLines'] as any[]).find((r) => r.key === 'ok_default')
    const stub = (GOLDEN['atomic_lines_stubs'] as Record<string, Record<string, unknown>>)[row.stub as string]
    const calls: SkillCallRecord[] = []
    const got = await (SKILLS['AssessAtomicLines'] as Skill).execute(
      fakeCtx(fromGoldenStub(stub) as Record<string, unknown>, calls), {},
    )
    const d = got.data as Record<string, unknown>
    expect(d['channel_source']).toBe('按信号名 Z 解出')
    expect(d['channel_index']).toBe(30)
  })

  it('**而这不是同一个通道**：缓冲里多一路非电流时兜底会挑错', async () => {
    // `[0(Current), 5(Bias), 30(Z)]` ⇒ 兜底给 5，按名字找给 30。
    // 本模块的抬头明写「必须读 Z」（Z 的线级 SNR 211–225，电流只有 52–82），
    // 而 5 是偏压 —— 挑错的那一半时间没人会发现。
    const stub = GOLDEN['atomic_lines_stubs']['ok'] as Record<string, unknown>
    const wide = {
      ...(fromGoldenStub(stub) as Record<string, unknown>),
      Scan_BufferGet: [3, [[0], [5], [30]], 256, 32],
    }
    const calls: SkillCallRecord[] = []
    const got = await (SKILLS['AssessAtomicLines'] as Skill).execute(fakeCtx(wide, calls), {})
    expect((got.data as Record<string, unknown>)['channel_index']).toBe(30)
  })
})

/** 金样里的 `"NaN"` 之类占位在参数里不会出现，但 `null` 会 —— 原样带过去。 */
function fromGoldenParams(v: unknown): unknown {
  return v
}

/** 桩里的数值占位还原（帧数据里没有 NaN，但保持同一条路）。 */
function fromGoldenStub(v: unknown): unknown {
  if (v === 'NaN') return NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  if (Array.isArray(v)) return v.map(fromGoldenStub)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = fromGoldenStub(x)
    return out
  }
  return v
}
