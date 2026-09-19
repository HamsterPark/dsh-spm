/**
 * 批 4b 四个技能对 `spec/golden/lattice.json` 的**逐格**比对（DoD ③ + ⑤）。
 *
 * 体例与批 4a 的 `analysis-skills.test.ts` 相同：金样里每一格都是**旧仓真技能**
 * 跑在同一批 `.sxm` 字节上的完整 `SkillResult`，这里把 TS 那一侧的返回值整棵
 * 摆过去逐叶子比 —— 字符串逐字（里面印着 `%.1f` / `%.4f` 的数，于是一条字符串
 * 断言等于一条「这个数精确到那一位」的断言，而且它顺带钉住了措辞）。
 *
 * ## 这一批**没有**「刻意不同」的字段
 *
 * 批 4a 有两处（D-ADATOM-1 / D-ATOMLINE-1）。这一批一处都没有：四个技能
 * 逐格与旧仓相同，包括那三段成像条件的中文、那句 `scale_reduced` 的解释、
 * 以及超结构的三态判决。**唯一需要在测试里解释的只有容差**，而容差来自
 * `dsh-spm-vision` 那一侧导出的常量。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { CELL_REL_TOL, diffTree, formatMismatches, fftSharpnessRelTol, scalesOf, toGolden } from 'dsh-spm-vision'
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { ANALYSIS_LATTICE } from './analysis-lattice.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/lattice.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const SKILLS: Record<string, Skill> = { ...ANALYSIS_LATTICE }

let TMP = ''

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'lattice-golden-'))
  for (const [key, b64] of Object.entries(GOLDEN['sxm_files'] as Record<string, string>)) {
    writeFileSync(`${TMP.replaceAll('\\', '/')}/${key}.sxm`, Buffer.from(b64, 'base64'))
  }
})

/** 把金样里的 `<tmp>` 换成本次运行的临时目录。 */
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

/** 与导出器同一组归一化。 */
function normalize(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replaceAll(TMP.replaceAll('\\', '/'), '<tmp>')
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

/** 摆成旧仓 `SkillResult` 的形状（`error` 缺省是空串、`summary` 缺省是 `None`）。 */
function asGolden(r: SkillResultLike): Record<string, unknown> {
  return { success: r.success, error: r.error ?? '', summary: r.summary ?? null, data: r.data ?? {} }
}

/**
 * `fft_sharpness` 与它的下游（`AssessAtomicResolution` 的那个字段）走**另一条**容差。
 *
 * 旧仓那次 FFT 在 **float32** 里做（`_detrend` 的输出是 float32，
 * numpy 的 `fft2` 对 float32 回 complex64），而本仓只把输入降到 float32、
 * 变换留在 float64 —— 复现单精度 pocketfft 要把每一次蝶形都降精度。
 * 差额的推导写在 `vision/tip-metrics.ts` 的 `fftSharpnessRelTol` 上，
 * 它**随锐度线性放大**：锐得离谱的帧宽、贴着闸门的帧紧。
 */
const SHARPNESS_FIELDS = new Set(['.data.fft_sharpness'])

function expectCase(name: string, key: string, got: SkillResultLike, want: any, scales: Map<string, number>): void {
  const a = normalize(toGolden(asGolden(got)))
  const ms = diffTree(a, want, CELL_REL_TOL, scales).filter((m) => {
    const flat = m.path.replace(/\[\d+\]/g, '')
    if (!SHARPNESS_FIELDS.has(flat)) return true
    if (typeof m.actual !== 'number' || typeof m.want !== 'number') return true
    return !(Math.abs(m.actual - m.want) <= fftSharpnessRelTol(m.want) * Math.abs(m.want))
  })
  expect(ms.length === 0 || `${name}/${key}：${formatMismatches(ms)}`).toBe(true)
}

// ──────────────────────────────────────────────────────────────────────────

/**
 * 这一族的**预算**（批 6b 加）—— 不是把测试改软，是让它说得出话。
 *
 * `AssessAtomicResolution > hex` 单独跑是 **4209 ms**，vitest 的缺省预算是 5000 ms
 * ——只剩 16% 的余量。批 6b 往同一个 worker 池里加了 218 条测试之后，实测
 * **四趟里有两趟**这一格超时（不加那两个文件时四趟全绿）。
 *
 * 一次超时的代价不是「重跑一次」：`tools/mutate/run.ts` 的基线判据是
 * `failed > 0`，于是**整趟演练拒跑**（green-8 §3.4 第 1 条）。
 * 也就是说这 800 ms 的余量决定了 553 条变异跑不跑得起来。
 *
 * 预算抬到 30 s：这一格真正的开销是 4.2 s，整份文件 30 s，**一次真的挂住照样
 * 远远超出**——它分得开的仍然是「挂住」与「跑完」，只是不再分「机器忙」与「机器闲」。
 * 批 3d 的原话：**预算不是优化，是让「挂住」说得出话。**
 *
 * ⚠️ 真正的修法是**让它更快**（批 4b 自己就是这么干的：192 → 256 避开 Bluestein），
 * 而那要动 `lattice.json` 里 `hex` 那张 256² 的帧 —— 连带重录一整节。
 * 那是一次单独的决定，不该塞进批 6b。
 */
const GOLDEN_TIMEOUT_MS = 30_000

describe('批 4b —— 技能级差分（逐格对旧仓）', { timeout: GOLDEN_TIMEOUT_MS }, () => {
  for (const name of ['AssessScanTexture', 'MeasureLatticeCell', 'AssessAtomicResolution', 'AnalyseAtomicLattice'] as const) {
    describe(name, () => {
      const rows = GOLDEN['skills'][name] as any[]
      // 金样那一侧把 `SkillResult` 摊平成了 `{case, params, success, error, summary, data}`。
      const want = (r: any) => ({ success: r.success, error: r.error, summary: r.summary || null, data: r.data })
      const scales = scalesOf(rows.map(want))
      for (const row of rows) {
        it(row.case as string, async () => {
          const skill = SKILLS[name] as Skill
          const params = realPath(row.params) as Record<string, unknown>
          const got = await skill.execute({} as SkillContext, params)
          expectCase(name, row.case as string, got, want(row), scales)
        })
      }
    })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// 每条错误分支一条单测（DoD ③）—— **不经金样**，直接钉那一句话
// ──────────────────────────────────────────────────────────────────────────

describe('错误分支（每一条一句话）', { timeout: GOLDEN_TIMEOUT_MS }, () => {
  const run = async (name: string, params: Record<string, unknown>): Promise<SkillResultLike> =>
    (SKILLS[name] as Skill).execute({} as SkillContext, params)

  it('AssessScanTexture：空路径 / 不存在 / 没这个通道 —— 三句不同的话', async () => {
    expect((await run('AssessScanTexture', { scan_path: '' })).error).toBe('没有给 scan_path')
    expect((await run('AssessScanTexture', { scan_path: `${TMP}/nope.sxm` })).error).toBe(`文件不存在: ${TMP}/nope.sxm`)
    expect((await run('AssessScanTexture', { scan_path: `${TMP}/current_only.sxm` })).error).toBe(`没有通道 'Z' 的正扫数据`)
  })

  it('AssessAtomicResolution / AnalyseAtomicLattice：通道那句**多两个字**，照移', async () => {
    // 旧仓两处写法不同（`_sxm_frame.load_frame` vs `atomic_lattice._load_frame`），
    // 而模型读的就是这一句。统一成一种写法会让金样里两条报文有一条对不上。
    for (const n of ['AssessAtomicResolution', 'AnalyseAtomicLattice']) {
      expect([n, (await run(n, { scan_path: `${TMP}/current_only.sxm` })).error]).toEqual([n, `文件里没有通道 'Z' 的正扫数据`])
    }
  })

  it('MeasureLatticeCell：没给路径 / 一个都读不进来 —— 后者带 rejected', async () => {
    const a = await run('MeasureLatticeCell', { scan_paths: '' })
    expect(a.error).toBe('没有给 scan_paths')
    const b = await run('MeasureLatticeCell', { scan_paths: `${TMP}/nope.sxm` })
    expect(b.success).toBe(false)
    expect(b.error).toContain('1 个路径一个都读不进来')
    expect((b.data as any).rejected).toHaveLength(1)
  })

  it('MeasureLatticeCell：**读进来了但量不出晶格 ≠ 读不进来**', async () => {
    // 前者是判不了（`success=true` + `undetermined`），后者是技能失败。
    // 混在一起，调用方就分不清该去修路径还是该换帧。
    const r = await run('MeasureLatticeCell', { scan_paths: `${TMP}/noise.sxm`, superstructure: false })
    expect(r.success).toBe(true)
    expect((r.data as any).verdict).toBe('undetermined')
    expect((r.data as any).n_frames).toBe(0)
  })

  it('AnalyseAtomicLattice：不认识的表面名 —— 报出**已知的那张表**，不默默当 Au(111)', async () => {
    const r = await run('AnalyseAtomicLattice', { scan_path: `${TMP}/hex.sxm`, surface: 'unregistered-surface' })
    expect(r.success).toBe(false)
    expect(r.error).toContain(`不认识表面 'unregistered-surface'`)
    expect(r.error).toContain('Au(111)')
    expect(r.error).toContain(`也可以传 'none' 只测不比`)
  })

  it('AnalyseAtomicLattice：`require_atomic=false` 之后照样可能量不了晶格', async () => {
    const r = await run('AnalyseAtomicLattice', { scan_path: `${TMP}/noise.sxm`, require_atomic: false })
    expect(r.success).toBe(false)
    expect(r.error).toBe('量不了晶格：too_few_peaks')
    expect((r.data as any).reason).toBe('too_few_peaks')
  })

  it('AnalyseAtomicLattice：只差尺度时**不说「这是针尖抖动」**', async () => {
    // 第一版的拒绝语一律说「量出来的周期是针尖抖动的周期」，而它同一句里报出的
    // 角向集中度可能是六位数 —— 那句话一边断言，一边带着推翻自己的证据。
    const r = await run('AnalyseAtomicLattice', { scan_path: `${TMP}/hex_reduced.sxm` })
    expect(r.success).toBe(false)
    expect((r.data as any).scale_only).toBe(true)
    expect(r.error).toContain('这**不是**「没有原子相」')
    expect(r.error).toContain('allow_reduced_scale=true')
    expect(r.error).not.toContain('针尖抖动的周期')
    // 而**不是**只差尺度的那一帧，说的就是另一句话。
    const n = await run('AnalyseAtomicLattice', { scan_path: `${TMP}/noise.sxm` })
    expect((n.data as any).scale_only).toBe(false)
    expect(n.error).toContain('针尖抖动的周期')
  })

  it('AssessAtomicResolution：成像条件闸门产出 `undetermined`，而且**机器可读**', async () => {
    const r = await run('AssessAtomicResolution', { scan_path: `${TMP}/hex_badbias.sxm`, surface: 'Au(111)' })
    expect(r.success).toBe(true)
    expect((r.data as any).verdict).toBe('undetermined')
    expect((r.data as any).imaging_window.ok).toBe(false)
    expect((r.data as any).imaging_window.reason).toBe('bias_out_of_atomic_window')
    // 同一帧内容、只改头里的偏压 ⇒ 判决从 `atomic` 翻成 `undetermined`。
    // **两格的 `passed_forward` 都是 true** —— 闸门改的是结论，不是判据。
    expect((r.data as any).passed_forward).toBe(true)
    const ok = await run('AssessAtomicResolution', { scan_path: `${TMP}/hex.sxm`, surface: 'Au(111)' })
    expect((ok.data as any).verdict).toBe('atomic')
    expect((ok.data as any).imaging_window.ok).toBe(true)
  })

  it('AssessScanTexture：不传 `good_ratio` 就**不给占比**，但照样出数', async () => {
    const r = await run('AssessScanTexture', { scan_path: `${TMP}/rect_down.sxm`, tile_nm: 4.0 })
    expect((r.data as any).tile_good_fraction).toBe(null)
    expect(typeof (r.data as any).tile_median_ratio).toBe('number')
    expect(((r.data as any).notes as string[]).join('')).toContain('没传 good_ratio')
    const g = await run('AssessScanTexture', { scan_path: `${TMP}/rect_down.sxm`, tile_nm: 4.0, good_ratio: 0.6 })
    expect(typeof (g.data as any).tile_good_fraction).toBe('number')
    expect((g.data as any).tile_good_ratio_used).toBe(0.6)
  })

  it('AssessScanTexture：量不出晶格方向时**条纹幅值仍然给**', async () => {
    // 它不需要知道晶格在哪 —— 少给这一个数等于把一条能用的证据一起丢掉。
    const r = await run('AssessScanTexture', { scan_path: `${TMP}/noise.sxm`, tile_nm: 4.0 })
    expect(r.success).toBe(true)
    expect((r.data as any).verdict).toBe('undetermined')
    expect(typeof (r.data as any).streak_pm).toBe('number')
  })
})
