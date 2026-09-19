/**
 * 批 7b-1：`AssessAtomicPhase` 对 `spec/golden/batch7b1.json` 的逐格比对（DoD ③ + ⑤）。
 *
 * ## 两档容差，其余全部走 `CELL_REL_TOL`
 *
 * | 字段 | 容差 | 为什么 |
 * |---|---|---|
 * | `fft_sharpness` | `fftSharpnessRelTol(want)` | 旧仓那次 FFT 在 **float32** 里做，本仓只把输入降到 float32、变换留在 float64。推导在 `vision/tip-metrics.ts` |
 * | 其余数值 | `CELL_REL_TOL` | 与 `lattice-skills.test.ts` 同一台判据本体，同一条容差 |
 * | 报文 / 出局词 / 布尔 / `coverage` | **0** | `coverage` 是 `有限像素数 ÷ 总像素数`，两边都是整数除法，逐位相等 |
 *
 * ## 三处**不照抄**（DoD ⑤），每一处都有一条测试盯着差异本身
 *
 * 1. **D-EXTRA-SPLIT**：`extra_reasons` / `extra_warnings` 在旧仓被拆散在两个类里
 *    （这一侧赋值而不用，`AssessShockleyOnset` 那一侧用而未赋值 ⇒ 每条成功路径
 *    `NameError`）。本仓把它接回来 ⇒ 残帧那两格的 `reasons` / `warnings` / `summary`
 *    与金样**刻意不同**。
 * 2. **衬底模糊匹配整条不在**：旧仓精确查不中时还有一趟 `match_material`，
 *    本仓没有那张 30570 行的知识库。今天两边在这一族用例上**同解**，
 *    所以这一条只登记、不单独造格（造一格「模糊匹配得到不同答案」的用例，
 *    造出来的是本仓自己发明的行为）。
 * 3. **`substrate_source` 的第三个值**：本仓多一个 `sample_record`（注入口打开时），
 *    旧仓那一路是 `current_sample`。它默认关着，所以金样里一格都没有 —— 见下。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { CELL_REL_TOL, diffTree, fftSharpnessRelTol, formatMismatches, scalesOf, toGolden } from 'dsh-spm-vision'
import {
  AssessAtomicPhase,
  MIN_COVERAGE,
  incompleteWarning,
  resolveSubstrate,
  substrateFacts,
} from './tip-spectro-assess.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/batch7b1.json', import.meta.url)), 'utf8'),
) as Record<string, any>

/** 256² 的 FFT 跑二十来格。同 `lattice-skills.test.ts`：预算不是优化，是让「挂住」说得出话。 */
const GOLDEN_TIMEOUT_MS = 60_000

let TMP = ''

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'batch7b1-')).replaceAll('\\', '/')
  for (const [key, b64] of Object.entries(GOLDEN['sxm_files'] as Record<string, string>)) {
    writeFileSync(`${TMP}/${key}.sxm`, Buffer.from(b64, 'base64'))
  }
})

afterEach(() => {
  substrateFacts.currentSample = null
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

const ROWS = GOLDEN['assess_atomic_phase'] as any[]
const SCALES = scalesOf(ROWS.map(wantOf))
const rowOf = (name: string): any => {
  const r = ROWS.find((x) => x.case === name)
  expect(r, `金样里没有这一格：${name}`).toBeDefined()
  return r
}

/**
 * D-EXTRA-SPLIT 影响到的三个路径 —— 这三格**不走**逐字比对，
 * 由下面「差异本身」那一组各写一条断言。
 */
const SPLIT_FIELDS = new Set(['.data.reasons', '.data.warnings', '.summary'])

/** 残帧那两格（覆盖率 < 0.5）—— 只有它们受 D-EXTRA-SPLIT 影响。 */
const INCOMPLETE_CASES = new Set(['coverage_below_gate', 'coverage_below_gate_but_judged'])

function compare(name: string, got: SkillResultLike, row: any): void {
  const a = normalize(toGolden(asGolden(got)))
  const ms = diffTree(a, wantOf(row), CELL_REL_TOL, SCALES).filter((m) => {
    const flat = m.path.replace(/\[\d+\]/g, '')
    // ⚠️ 按**前缀**滤：`diffTree` 报的是 `.data.reasons.length` / `.data.reasons`，
    // 只挡后者的话长度那一条会漏出来，而它正是这三处差异最明显的形状。
    if (INCOMPLETE_CASES.has(name) && [...SPLIT_FIELDS].some((p) => flat === p || flat.startsWith(`${p}.`))) {
      return false
    }
    if (flat !== '.data.fft_sharpness') return true
    if (typeof m.actual !== 'number' || typeof m.want !== 'number') return true
    return !(Math.abs(m.actual - m.want) <= fftSharpnessRelTol(m.want) * Math.abs(m.want))
  })
  expect(ms.length === 0 || `${name}：${formatMismatches(ms)}`).toBe(true)
}

async function run(params: Record<string, unknown>): Promise<SkillResultLike> {
  return AssessAtomicPhase.execute({} as SkillContext, params)
}

// ──────────────────────────────────────────────────────────────────────────

describe('AssessAtomicPhase —— 逐格对旧仓', { timeout: GOLDEN_TIMEOUT_MS }, () => {
  for (const row of ROWS) {
    it(`${row.case as string}`, async () => {
      compare(row.case as string, await run(realPath(row.params) as Record<string, unknown>), row)
    })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// 覆盖率门 —— 这一层唯一自己判的东西
// ──────────────────────────────────────────────────────────────────────────

describe('覆盖率门 `MIN_COVERAGE`', { timeout: GOLDEN_TIMEOUT_MS }, () => {
  it('阈值随金样，不是本仓自己定的', () => {
    expect(MIN_COVERAGE).toBe(GOLDEN['min_coverage'])
  })

  it('**严格小于** —— 正好 0.5 不算残帧', async () => {
    // 门两侧各一格，而**线上那一格**（0.5）是这道闸唯一分得开 `<` 与 `<=` 的输入。
    // 金样里那三格的覆盖率是 0.25 / 0.4375 / 0.5，线上那一格必须判「不残」。
    const on = await run({ scan_path: `${TMP}/partial_50.sxm`, channel: 'Z' })
    const below = await run({ scan_path: `${TMP}/partial_44.sxm`, channel: 'Z' })
    expect([(on.data as any).coverage, (on.data as any).incomplete_frame]).toEqual([0.5, false])
    expect([(below.data as any).coverage, (below.data as any).incomplete_frame]).toEqual([0.4375, true])
  })

  it('门压住的是 `passed`，**不是**判据本身的结论', async () => {
    // 这一格才是那道门存在的理由：判据说「有原子相」，而这一帧只扫了 44%。
    // 一次残帧样本就是这个形状（2% 的像素，报 passed=True、角向集中度 94）。
    const r = await run({ scan_path: `${TMP}/partial_44.sxm`, channel: 'Z' })
    const d = r.data as any
    expect([d.passed, d.passed_before_coverage_gate, d.incomplete_frame]).toEqual([false, true, true])
    // 金样那一侧**也是**这个（这两格只有 reasons/warnings/summary 不同）。
    const want = rowOf('coverage_below_gate_but_judged').data
    expect([want.passed, want.passed_before_coverage_gate, want.incomplete_frame]).toEqual([false, true, true])
  })

  it('覆盖率满时这道门一个字都不说', async () => {
    const r = await run({ scan_path: `${TMP}/hex.sxm`, channel: 'Z' })
    const d = r.data as any
    expect([d.coverage, d.incomplete_frame, d.passed]).toEqual([1, false, true])
    expect(d.reasons).toEqual([])
    expect(d.warnings).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// D-EXTRA-SPLIT —— **差异本身**要有测试，否则差异消失的那天没人知道
// ──────────────────────────────────────────────────────────────────────────

describe('D-EXTRA-SPLIT：旧仓把 `extra_*` 拆散在两个类里', { timeout: GOLDEN_TIMEOUT_MS }, () => {
  it('旧仓那一侧**算了却没发出来** —— 金样把这件事钉着', () => {
    // `tip_spectro_assess.py:405-410` 赋值 `extra_reasons` / `extra_warnings`，
    // 而 `:412-435` 的 `data` 里一处都没用；同名的两个变量在
    // `AssessShockleyOnset.execute:236-237` 被**使用而未赋值**（那一侧每条成功
    // 路径都 NameError）。同一次重构的两半落进了两个类。
    const want = rowOf('coverage_below_gate_but_judged')
    expect(want.data.incomplete_frame).toBe(true)
    expect(want.data.reasons).not.toContain('incomplete_frame') // ← 算了，没进去
    expect(want.data.warnings).toEqual([]) // ← 那句长话一个字都没出来
    // 而 summary 分支在 `res.passed` 上（不是门后的 `passed`）：
    // 同一个回包里，模型读的那一句说「有原子相」，机器读的那一格是 false。
    expect(want.summary).toContain('有原子相')
    expect(want.data.passed).toBe(false)
  })

  it('本仓**不照抄**：把那两段接回它们本来要去的地方', async () => {
    const d = (await run({ scan_path: `${TMP}/partial_44.sxm`, channel: 'Z' })).data as any
    expect(d.reasons).toContain('incomplete_frame')
    expect(d.warnings).toEqual([incompleteWarning(0.4375)])
  })

  it('接回来的那句话是旧仓**逐字**写好的，不是新造的', async () => {
    const r = await run({ scan_path: `${TMP}/partial_44.sxm`, channel: 'Z' })
    // 百分比走 Python 的 `%.0f`（四舍六入五成双）—— 0.4375 → 44%。
    expect(incompleteWarning(0.4375)).toBe(
      '只有 44% 的像素有数据 —— 这一帧**判不了**原子分辨。' +
        '缺的部分在做谱之前会被当成常数，谱上因此多出与扫描无关的结构。' +
        '**不要把这个结果读成「针尖不好」**，它说的是这一帧没扫完。',
    )
    // summary 用的就是它 —— 于是「有原子相」那句矛盾的话没有了。
    expect(r.summary).toBe(incompleteWarning(0.4375))
    expect(r.summary).not.toContain('有原子相')
  })

  it('没残的帧一个字都不多说 —— 接回来的那一段**只**在残帧上出现', async () => {
    // 反面输入。没有它，把 `incomplete` 恒真也能过上面三条。
    const r = await run({ scan_path: `${TMP}/hex.sxm`, channel: 'Z' })
    expect(r.summary).toContain('有原子相')
    expect((r.data as any).reasons).not.toContain('incomplete_frame')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 衬底注入口 —— 默认关，关着的时候走「不知道」
// ──────────────────────────────────────────────────────────────────────────

describe('`resolveSubstrate`：注入口默认关', () => {
  it('不给名字 + 注入口关着 ⇒ 不知道（与旧仓读不到样品记录时同解）', () => {
    expect(resolveSubstrate(null)).toEqual({
      available: false,
      material: null,
      source: 'unknown',
      rowSpacingNm: null,
    })
    // 金样那一侧：`resolve_substrate(None)` 与 `resolve_substrate("")` 都是
    // `available=false` / `source='unknown'` / `material=null`。
    for (const arg of [null, '']) {
      const w = (GOLDEN['resolve_substrate'] as any[]).find((x) => x.arg === arg)
      expect([w.facts.available, w.facts.source, w.facts.material]).toEqual([false, 'unknown', null])
    }
  })

  it('十格**全部**逐位对旧仓 —— 认得的四个、认不得的四个、空的两个', () => {
    // ⚠️ 这一条曾经只比三个面，而那三个恰好全对上。把十格全比之后**两件事**露出来：
    //
    //   1. 旧仓的 `resolve_substrate` 只认**四个洁净金属面**。
    //      `SURFACE_LATTICE_NM` 里的另三个（HOPG / NaCl(100) / Si(111)-1x1）
    //      旧仓一律 `available=false` —— 拿那张表当衬底知识库，
    //      会让三个面凭空「知道」，而知道之后走的是完全另一条路。
    //   2. Pt(111) 上 `2.775/10 ≠ 0.2775`（差 1 ulp）。它是晶格常数比对的**入口**。
    //
    // 两件事都不是推出来的，是**多比七格**比出来的。
    for (const w of GOLDEN['resolve_substrate'] as any[]) {
      if (w.arg === null || w.arg === '') continue
      const got = resolveSubstrate(w.arg as string)
      expect([w.arg, got.available], w.arg).toEqual([w.arg, w.facts.available])
      expect([w.arg, got.material], w.arg).toEqual([w.arg, w.facts.material])
      expect([w.arg, got.rowSpacingNm], w.arg).toEqual([w.arg, w.facts.row_spacing_nm])
      expect([w.arg, got.source], w.arg).toEqual([w.arg, 'explicit'])
    }
  })

  it('认不出的名字 ⇒ 不知道（**不是**回落到 Au(111)）', () => {
    // 「不知道」不等于「Au(111)」：在 Ag(111) 上按 Au 的常数找判据会一直不过，
    // 而流程会把这个误读成「针尖不行」，反复去修一根其实没问题的针。
    for (const name of ['不认识这个衬底', 'HOPG', 'NaCl(100)', 'Si(111)-1x1']) {
      const w = (GOLDEN['resolve_substrate'] as any[]).find((x) => x.arg === name)
      expect(w.facts.available, name).toBe(false)
      expect(resolveSubstrate(name), name).toEqual({
        available: false,
        material: null,
        source: 'explicit',
        rowSpacingNm: null,
      })
    }
  })

  it('注入口打开时才有第三个来源 —— 而它**默认不在**', () => {
    substrateFacts.currentSample = () => 'Ag(111)'
    const got = resolveSubstrate(null)
    expect([got.available, got.material, got.source]).toEqual([true, 'Ag(111)', 'sample_record'])
    // 抛了也不许炸 —— 同旧仓那条 fail-soft（读不到样品记录报「不知道」，不抛）。
    substrateFacts.currentSample = () => {
      throw new Error('没有活的实验记录')
    }
    expect(resolveSubstrate(null).available).toBe(false)
    // 显式给的名字优先于注入口。
    substrateFacts.currentSample = () => 'Ag(111)'
    expect(resolveSubstrate('Au(111)').material).toBe('Au(111)')
  })

  it('降级是**诚实拒绝**：不做这一项比对，其余三条照跑（旧仓：不算失败）', async () => {
    const r = await run({ scan_path: `${TMP}/hex.sxm`, channel: 'Z' })
    const d = r.data as any
    expect([d.substrate, d.substrate_available, d.expected_a_nm]).toEqual([null, false, null])
    expect(d.passed).toBe(true) // ← 拿不到衬底**不算失败**
  })

  it('`expected_a_nm` 的三态各走各的（给正数 / 给 0 / 不给）', async () => {
    const explicit = (await run({ scan_path: `${TMP}/hex.sxm`, expected_a_nm: 0.2498 })).data as any
    const zero = (await run({ scan_path: `${TMP}/hex.sxm`, expected_a_nm: 0 })).data as any
    const named = (await run({ scan_path: `${TMP}/hex.sxm`, substrate: 'Au(111)' })).data as any
    expect(explicit.expected_a_nm).toBe(0.2498)
    // 填 0 = **关掉这项比对**，不是「期望值是 0」。
    expect(zero.expected_a_nm).toBeNull()
    // 不给 ⇒ 从衬底取。
    expect(named.expected_a_nm).toBe(resolveSubstrate('Au(111)').rowSpacingNm)
    // 三格都过 —— 这一项比对做不做，不改其余三条判据。
    expect([explicit.passed, zero.passed, named.passed]).toEqual([true, true, true])
  })

  it('**「填 0」与「留空」的分界** —— 只有「0 + 一个解得开的衬底」那一格分得开', async () => {
    // 参数说明是两句话：「留空则从衬底取；填 0 则关掉这项比较」。
    // 没有衬底时这两句给出同一个答案（都是 null）—— 于是把「填 0」读成
    // 「从衬底取」的那个**自然误读**，一格输入都验不到。
    const d = (await run({ scan_path: `${TMP}/hex.sxm`, expected_a_nm: 0, substrate: 'Au(111)' })).data as any
    expect([d.substrate, d.substrate_available]).toEqual(['Au(111)', true])
    expect(resolveSubstrate('Au(111)').rowSpacingNm).not.toBeNull() // ← 衬底那边**确实**取得到
    expect(d.expected_a_nm).toBeNull() //                            ← 而这一项仍然关着
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 每条错误分支一条单测（DoD ③）—— 不经金样，直接钉那一句话
// ──────────────────────────────────────────────────────────────────────────

describe('错误分支（五条，每条一句话）', { timeout: GOLDEN_TIMEOUT_MS }, () => {
  it('文件不存在', async () => {
    const r = await run({ scan_path: `${TMP}/nope.sxm`, channel: 'Z' })
    expect([r.success, r.error]).toEqual([false, `文件不存在: ${TMP}/nope.sxm`])
  })

  it('空路径**不走**「文件不存在」—— `Path("")` 是当前目录，它存在', async () => {
    // 这一条是实跑出来的，不是读代码读出来的（金样 `empty_path`）。
    // 一个「看起来显然」的分支走到了另一支，而模型读的正是这两句里的一句。
    const r = await run({ scan_path: '', channel: 'Z' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/^\.sxm 读取失败: /)
    expect(r.error).not.toContain('文件不存在')
    expect(rowOf('empty_path').error).toMatch(/^\.sxm 读取失败: /)
  })

  it('不是 .sxm', async () => {
    const r = await run({ scan_path: `${TMP}/garbage.sxm`, channel: 'Z' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/^\.sxm 读取失败: /)
  })

  it('通道表为空 —— 「没有可用通道」**唯一**走得到的路', async () => {
    const r = await run({ scan_path: `${TMP}/no_channels.sxm`, channel: 'Z' })
    expect([r.success, r.error]).toEqual([false, "文件里没有可用通道(要的是 'Z')"])
    // 而指名一个**不存在**的通道时它不报错，是回落 —— 下一组。
  })

  it('通道在、方向块不在（截断的文件）', async () => {
    const r = await run({ scan_path: `${TMP}/truncated.sxm`, channel: 'Z' })
    expect([r.success, r.error]).toEqual([false, '通道里没有正扫/反扫数据'])
  })
})

describe('通道回落 —— 与孪生技能 `AssessAtomicResolution` **刻意不同**', { timeout: GOLDEN_TIMEOUT_MS }, () => {
  it('要 `Z` 而文件里只有 `Current` ⇒ 取第一个通道接着算', async () => {
    const fallback = await run({ scan_path: `${TMP}/current_only.sxm`, channel: 'Z' })
    const named = await run({ scan_path: `${TMP}/current_only.sxm`, channel: 'Current' })
    expect(fallback.success).toBe(true)
    // 回落与指名给出同一个结果 —— 这就是「回落到第一个通道」的意思。
    expect((fallback.data as any).passed).toBe((named.data as any).passed)
    expect(fallback.summary).toBe(named.summary)
  })
})
