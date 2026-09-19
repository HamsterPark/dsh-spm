/**
 * 批 6c 四个技能对 `spec/golden/batch6c.json` 的**逐格**比对（DoD ③ + ⑤）。
 *
 * 体例与批 4b 的 `lattice-skills.test.ts` 相同：金样里每一格都是**旧仓真技能**
 * 跑在同一批 `.sxm` / `.dat` 字节上的完整 `SkillResult`，这里把 TS 那一侧的返回值
 * 整棵摆过去逐叶子比 —— 字符串逐字（里面印着 `%.2f` / `%.1f` / `%.0f` 的数，
 * 于是**一条字符串断言等于一条「这个数精确到那一位」的断言**，而且它顺带钉住了措辞）。
 *
 * ## 本批**有两处**刻意不同（登记 deviation，编号留空）
 *
 * | 处 | 旧仓 | 本仓 | 为什么 |
 * |---|---|---|---|
 * | `InvertForceSaderJarvis` 的 `curve_path` 前缀 | `project_root()/artifacts/force_inversion`（`MAST2_PROJECT_ROOT` 或仓根） | `<cwd>/artifacts/force_inversion`（可注入） | 本仓没有 `project_root()`；同 `readback-stream.saveTrace` 的既有做法 |
 * | `ForceInversionResult.notes` | 一个恒为 `{}` 的 dict | **不实现** | 技能层一个字段都不读它（消融精神） |
 *
 * 两处都在比对前**从两侧同样地摘掉**：路径归一成 `<artifacts>`，`notes` 删掉。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { CELL_REL_TOL, corrugationRelTol, diffTree, fftSharpnessRelTol, formatMismatches, scalesOf, toGolden } from 'dsh-spm-vision'
import { EDGE_RESOLUTION_REL_TOL, instabilityAbsTol } from './vision-tip-metrics.js'
import { SPECTRO_REL_TOL } from './vision-spectroscopy.js'
import { decayLengthRelTol, forceAbsTolFactor } from './vision-force-inversion.js'
import { ANALYSIS_TIP } from './analysis-tip.js'
import { makeInvertForceSaderJarvis } from './analysis-force.js'
import { ANALYSIS_MULTIFRAME } from './analysis-multiframe.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/batch6c.json', import.meta.url)), 'utf8'),
) as Record<string, any>

let TMP = ''
let ART = ''
let SKILLS: Record<string, Skill> = {}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'batch6c-skills-')).replaceAll('\\', '/')
  ART = `${TMP}/artifacts`
  for (const [key, b64] of Object.entries(GOLDEN['sxm_files'] as Record<string, string>)) {
    writeFileSync(`${TMP}/${key}.sxm`, Buffer.from(b64, 'base64'))
  }
  for (const [key, b64] of Object.entries(GOLDEN['dat_files'] as Record<string, string>)) {
    writeFileSync(`${TMP}/${key}.dat`, Buffer.from(b64, 'base64'))
  }
  SKILLS = {
    ...ANALYSIS_TIP,
    ...ANALYSIS_MULTIFRAME,
    InvertForceSaderJarvis: makeInvertForceSaderJarvis({ curveDir: () => ART }),
  }
})

/** 金样里的 `<tmp>` 换成本次运行的临时目录。 */
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

/** 与导出器同一组归一化（外加产物目录那一条 deviation）。 */
function normalize(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replaceAll(ART.replaceAll('/', '\\'), '<artifacts>')
      .replaceAll(ART, '<artifacts>')
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

/** 摆成旧仓 `SkillResult` 的形状。 */
function asGolden(r: SkillResultLike): Record<string, unknown> {
  return { success: r.success, error: r.error ?? '', summary: r.summary ?? '', data: r.data ?? {} }
}

const wantOf = (r: any): Record<string, unknown> => ({
  success: r.success,
  error: r.error,
  summary: r.summary,
  data: r.data,
})

/** 单独放宽的字段：给出那一格允许的**绝对**差额。 */
type FieldTol = ReadonlyMap<string, (want: number, scale: number) => number>

/**
 * ⚠️ 这一族的容差**必须按绝对值给**，不能交给 `diffTree` 去乘那个尺度。
 *
 * `fwd_bwd_instability` 是最清楚的例子：它落在 `[0, 1]`，而本批**每一格都接近 0**
 * （帧都很稳）⇒ 那一列的批内最大值是 `5.96e−8`。把一条 `1.3e−5` 的**绝对**容差
 * 乘上 `5.96e−8`，得到的是 `8e−13` —— 于是这条断言在问一个 float32 量的第十三位。
 * 这正是 green-8 §2.2 那条「容差按整幅谱的最大值归一 ⇒ 对小格没有分辨力」的反面：
 * 同一条规则用错方向，一样会让断言问错问题。
 */
function runSection(name: string, tolOf: (row: any) => number, looseOf: (row: any) => FieldTol): void {
  const rows = GOLDEN['skills'][name] as any[]
  const scales = scalesOf(rows.map(wantOf))
  describe(name, () => {
    for (const row of rows) {
      it(row.case as string, async () => {
        const skill = SKILLS[name] as Skill
        const params = realPath(row.params) as Record<string, unknown>
        const got = await skill.execute({} as SkillContext, params)
        const a = normalize(toGolden(asGolden(got)))
        const loose = looseOf(row)
        const ms = diffTree(a, wantOf(row), tolOf(row), scales).filter((m) => {
          const key = m.path.replace(/\[\d+\]/g, '')
          if (SKIP_FIELDS.has(key)) return false
          const f = loose.get(key)
          if (f === undefined || typeof m.actual !== 'number' || typeof m.want !== 'number') return true
          const scale = Math.max(scales.get(key) ?? 0, Math.abs(m.want))
          return !(Math.abs(m.actual - m.want) <= f(m.want, scale))
        })
        expect(ms.length === 0 || `${name}/${row.case}：${formatMismatches(ms)}`).toBe(true)
      })
    }
  })
}

/**
 * 逐格比对时**摘掉**的字段（各自登记 deviation，编号留空）。
 *
 * `curve_path` —— 旧仓的 `_save_curve` 里那一行
 * `from mast.core._runtime_paths import project_root` **模块不存在**
 * （全仓别的十几处写的都是 `mast._runtime_paths`），而它外面套着
 * `except Exception: return None` ⇒ **F(z)/U(z) 从来没有落过盘**，
 * 这个技能的曲线产物一次都没产出过。
 *
 * 按 DoD ⑤「KNOWN_ISSUES 里的缺陷判据不照抄」：本仓**真的落盘**，
 * 于是这一格与金样必然不同。它由「真的落了盘」那条单测单独把关 ——
 * 那条读回文件、比点数、并确认 `data` 里**没有**曲线本身（曲线只在文件里）。
 */
const SKIP_FIELDS: ReadonlySet<string> = new Set(['.data.curve_path'])

// ──────────────────────────────────────────────────────────────────────────

describe('批 6c —— 技能级差分（逐格对旧仓）', () => {
  // `AssessTipSharpness` 的整条链在旧仓是 float32 ⇒ 基线就是 eps32 那一档。
  // 三个字段各有各的推导，所以各自放宽（`fft_sharpness` 的那条**随锐度线性放大**）。
  runSection(
    'AssessTipSharpness',
    () => EDGE_RESOLUTION_REL_TOL,
    () => {
      // 帧一律 128×128（拒判那两格是 64×64，而它们没有这几个字段）。
      const nPx = 128 * 128
      return new Map<string, (want: number, scale: number) => number>([
        // **绝对** —— 这个量落在 [0,1]，而本批每一格都接近 0（见 `runSection` 的抬头）。
        ['.data.fwd_bwd_instability', () => instabilityAbsTol(nPx)],
        // **随锐度线性放大**（`vision/tip-metrics.ts` 的推导）。
        ['.data.fft_sharpness', (want) => fftSharpnessRelTol(want) * Math.abs(want)],
        ['.data.corrugation_rms_m', (want) => corrugationRelTol(nPx) * Math.abs(want)],
      ])
    },
  )

  runSection('AssessTipFromSpectrum', () => SPECTRO_REL_TOL, () => new Map())

  runSection(
    'InvertForceSaderJarvis',
    (row) => forceAbsTolFactor(Math.max(((row.data ?? {})['n_points'] as number) ?? 2, 2)),
    (row) => {
      const n = Math.max(((row.data ?? {})['n_points'] as number) ?? 2, 2)
      const f = (_want: number, scale: number): number => decayLengthRelTol(n) * scale
      return new Map<string, (want: number, scale: number) => number>([
        ['.data.decay_length_pm', f],
        ['.data.amplitude_over_decay_length', f],
      ])
    },
  )

  runSection('AssessAtomicConsistency', () => CELL_REL_TOL, () => new Map())
})

// ──────────────────────────────────────────────────────────────────────────
// 每条错误分支一条单测（DoD ③）—— **不经金样**，直接钉那一句话
// ──────────────────────────────────────────────────────────────────────────

describe('错误分支与那几句「判不了」（每一条一句话）', () => {
  const run = async (name: string, params: Record<string, unknown>): Promise<SkillResultLike> =>
    (SKILLS[name] as Skill).execute({} as SkillContext, params)

  it('AssessTipSharpness：**「判不了」有三种，而它们说的不是同一件事**', async () => {
    // `no_step`（图里没台阶）/ `unresolved`（阈值细过采样极限）/ `measured`（没给阈值）。
    // 三者都**不是**「针尖不合格」—— 2026-08-11 之前 `ForgeAuTip` 的验收是一个白名单，
    // 于是 `measured` 被当成不合格，而那条流程从不传阈值 ⇒ 验收结构上不可能通过。
    const a = await run('AssessTipSharpness', { scan_path: `${TMP}/tip_noise.sxm` })
    expect((a.data as any).verdict).toBe('no_step')
    expect(a.summary).toContain('换一块有台阶的地方再扫一张')
    const b = await run('AssessTipSharpness', { scan_path: `${TMP}/step.sxm`, sharp_edge_nm: 0.2 })
    expect((b.data as any).verdict).toBe('unresolved')
    // 弃权时给的是**能照着做的下一步**（要多细的图），不是一句「判不了」。
    expect(b.summary).toContain('把验收图扫细到')
    expect((b.data as any).sampling_floor_nm).toBeCloseTo(2 * (b.data as any).nm_per_px, 12)
    const c = await run('AssessTipSharpness', { scan_path: `${TMP}/step.sxm` })
    expect((c.data as any).verdict).toBe('measured')
  })

  it('AssessTipSharpness：`judge_frame` 拒判的**两档报文不同**，而且拒判时也带证据', async () => {
    const flat = await run('AssessTipSharpness', { scan_path: `${TMP}/dead_flat.sxm` })
    expect(flat.success).toBe(false)
    expect(flat.error).toContain('去趋势后起伏为 0')
    expect((flat.data as any).frame_usable).toBe(false)
    expect((flat.data as any).rows).toBe(64)
    const plane = await run('AssessTipSharpness', { scan_path: `${TMP}/plane_big.sxm` })
    expect(plane.success).toBe(false)
    expect(plane.error).toContain('去趋势后残差只有原始起伏的')
    expect(plane.error).not.toBe(flat.error)
  })

  it('AssessTipSharpness：没有像素标度时 `verdict` 报 `no_step`，**而 `has_step` 是 true**', async () => {
    // 照移。旧仓的 `verdict` 只看 `edge_resolution_nm`，而那一项需要标度 ——
    // 于是同一格里两句话互相矛盾。登记 deviation，不改：改掉的是模型读的那一句。
    const r = await run('AssessTipSharpness', { scan_path: `${TMP}/step_no_scale.sxm`, sharp_edge_nm: 1.2 })
    expect((r.data as any).verdict).toBe('no_step')
    expect((r.data as any).has_step).toBe(true)
    expect(typeof (r.data as any).edge_resolution_px).toBe('number')
    expect((r.data as any).edge_resolution_nm).toBe(null)
  })

  it('AssessTipSharpness：单方向的帧上 `fwd_bwd_instability` 是 `null`，不是编出来的数', async () => {
    const r = await run('AssessTipSharpness', { scan_path: `${TMP}/step_fwd_only.sxm` })
    expect((r.data as any).fwd_bwd_instability).toBe(null)
    const both = await run('AssessTipSharpness', { scan_path: `${TMP}/step.sxm` })
    expect(typeof (both.data as any).fwd_bwd_instability).toBe('number')
  })

  it('AssessTipFromSpectrum：**`unrated` 与「每条都通过」在数值上都是零个 flag**', async () => {
    // 这一条比什么都重要：没给任何阈值的 I(V) ⇒ `gated_criteria` 空 ⇒ `unrated`。
    const none = await run('AssessTipFromSpectrum', { dat_path: `${TMP}/iv_clean.dat`, kind: 'iv' })
    expect([(none.data as any).verdict, (none.data as any).gated_criteria, (none.data as any).reasons])
      .toEqual(['unrated', [], []])
    const gated = await run('AssessTipFromSpectrum', { dat_path: `${TMP}/iv_clean.dat`, kind: 'iv', max_jumps: 0 })
    expect([(gated.data as any).verdict, (gated.data as any).reasons]).toEqual(['tip_ok', []])
    // 两格的 `reasons` **一模一样**，而 verdict 相反 —— 这就是那道闸的全部内容。
  })

  it('AssessTipFromSpectrum：拟合站不住时**势垒不参与判决**', async () => {
    // 纯噪声照样能 polyfit 出一个斜率，于是也照样能换算出一个「势垒」——
    // 那个数不是读数，是拟合的副产物。
    const r = await run('AssessTipFromSpectrum', {
      dat_path: `${TMP}/iz_noise.dat`, barrier_ev_min: 3.0, barrier_ev_max: 8.0,
    })
    expect((r.data as any).gated_criteria).not.toContain('barrier_ev')
    expect(((r.data as any).notes as string[]).join('')).toContain('势垒值没有物理意义')
    // 而一条真的单指数上，同样的窗**参与**判决。
    const ok = await run('AssessTipFromSpectrum', {
      dat_path: `${TMP}/iz_clean.dat`, barrier_ev_min: 3.0, barrier_ev_max: 8.0,
    })
    expect((ok.data as any).gated_criteria).toContain('barrier_ev')
  })

  it('AssessTipFromSpectrum：读得动但判不了的三种，都是 `success=true`', async () => {
    for (const [file, why] of [
      ['dat_no_current', 'no_current_column'],
      ['dat_no_sweep', 'no_sweep_column'],
    ] as const) {
      const r = await run('AssessTipFromSpectrum', { dat_path: `${TMP}/${file}.dat` })
      expect([file, r.success, (r.data as any).verdict, (r.data as any).reasons]).toEqual([file, true, 'unrated', [why]])
    }
    // 而 `[DATA]` 段是空的 ⇒ **技能失败**（这件事没做成，不是判不了）
    const empty = await run('AssessTipFromSpectrum', { dat_path: `${TMP}/dat_empty.dat` })
    expect([empty.success, empty.error]).toEqual([false, '.dat 里没有 [DATA] 段'])
  })

  it('AssessTipFromSpectrum：头说 iv、数据在扫 z ⇒ **按数据判**，但把分歧说出来', async () => {
    const r = await run('AssessTipFromSpectrum', { dat_path: `${TMP}/iv_header_lies.dat` })
    expect((r.data as any).kind).toBe('iz')
    expect(((r.data as any).notes as string[]).join('')).toContain('header_says=')
  })

  it('InvertForceSaderJarvis：三个传感器参数的**回落链**，每一档都在回包里点名', async () => {
    const p = await run('InvertForceSaderJarvis', {
      dat_path: `${TMP}/fz_well.dat`, f0_hz: 30000, k_n_per_m: 1800, amplitude_m: 3e-11,
    })
    expect([(p.data as any).f0_source, (p.data as any).amplitude_source]).toEqual(['param', 'param'])
    const h = await run('InvertForceSaderJarvis', { dat_path: `${TMP}/fz_well.dat`, k_n_per_m: 1800 })
    expect([(h.data as any).f0_source, (h.data as any).amplitude_source]).toEqual(['dat_header', 'dat_column'])
    // k **不在任何 Nanonis 头里** —— 拿不到就直接说，不猜。
    const miss = await run('InvertForceSaderJarvis', { dat_path: `${TMP}/fz_well.dat`, f0_hz: 30000, amplitude_m: 3e-11 })
    expect(miss.success).toBe(false)
    expect(miss.error).toContain('缺传感器参数:k_n_per_m')
    expect(miss.error).toContain('弹性常数 k 不在任何头里')
  })

  it('InvertForceSaderJarvis：F(z)/U(z) **真的落了盘**，而路径进回包', async () => {
    const r = await run('InvertForceSaderJarvis', {
      dat_path: `${TMP}/fz_well.dat`, f0_hz: 30000, k_n_per_m: 1800, amplitude_m: 3e-11,
    })
    const p = (r.data as any).curve_path as string
    // `path.join` 在 Windows 上给反斜杠（同旧仓 `str(Path(...))`）—— 比之前先归一。
    expect(p.replaceAll('\\', '/').startsWith(ART)).toBe(true)
    const saved = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    // 曲线**只在这个文件里** —— `data` 里没有 z_m / force_n。落盘失败无声无息的话，
    // 调用方拿到的是一份没有曲线的报告（同 `readback-stream.saveTrace` 那条）。
    expect((saved['z_m'] as number[]).length).toBe((r.data as any).n_points)
    expect((r.data as any).z_m).toBeUndefined()
    expect(saved['verdict']).toBe((r.data as any).verdict)
  })

  it('InvertForceSaderJarvis：0.10 那条线**两侧的判决不同**（同一条曲线，只改振幅）', async () => {
    const ok = await run('InvertForceSaderJarvis', {
      dat_path: `${TMP}/fz_slow.dat`, f0_hz: 30000, k_n_per_m: 1800, amplitude_m: 3e-10,
    })
    const bad = await run('InvertForceSaderJarvis', {
      dat_path: `${TMP}/fz_slow.dat`, f0_hz: 30000, k_n_per_m: 1800, amplitude_m: 1e-9,
    })
    expect([(ok.data as any).verdict, (bad.data as any).verdict]).toEqual(['well', 'undecidable'])
    expect((bad.data as any).reasons).toEqual(['inversion_does_not_describe_the_data'])
  })

  it('AssessAtomicConsistency：**残帧不是证据** —— 两种否定分开记', async () => {
    const un = await run('AssessAtomicConsistency', {
      scan_paths: `${TMP}/half_nan_a.sxm,${TMP}/half_nan_b.sxm`,
    })
    expect([(un.data as any).verdict, (un.data as any).n_unusable, (un.data as any).n_no_lattice])
      .toEqual(['undetermined', 2, 0])
    expect(((un.data as any).warnings as string[]).join('')).toContain('先把帧扫完整')
    const ab = await run('AssessAtomicConsistency', {
      scan_paths: `${TMP}/lat_noise_a.sxm,${TMP}/lat_noise_b.sxm`,
    })
    expect([(ab.data as any).verdict, (ab.data as any).n_unusable, (ab.data as any).n_no_lattice])
      .toEqual(['absent', 0, 2])
    expect(((ab.data as any).warnings as string[]).join('')).toContain('明确的否定')
  })

  it('AssessAtomicConsistency：标度差太多的那一帧报出**差了百分之几**', async () => {
    const r = await run('AssessAtomicConsistency', { scan_paths: `${TMP}/hex_a.sxm,${TMP}/hex_coarse.sxm` })
    expect(r.success).toBe(false)
    expect(r.error).toBe('能用的帧不足两张')
    expect(((r.data as any).rejected as any[])[0].error).toContain('不是同一种取图')
    expect(((r.data as any).rejected as any[])[0].error).toContain('25.0%')
  })

  it('AssessAtomicConsistency：只给一帧时**点名去用哪个技能**', async () => {
    const r = await run('AssessAtomicConsistency', { scan_paths: `${TMP}/hex_a.sxm` })
    expect(r.success).toBe(false)
    expect(r.error).toContain('AssessAtomicResolution')
    expect(r.error).toContain('不是「这个晶格是不是真的」')
  })

  it('AssessAtomicConsistency：头里没有 `scan_angle` ⇒ 拒这一帧，**不当成 0°**', async () => {
    const r = await run('AssessAtomicConsistency', { scan_paths: `${TMP}/hex_a.sxm,${TMP}/hex_no_angle.sxm` })
    expect(((r.data as any).rejected as any[])[0].error).toBe('文件头里没有 scan_angle')
  })

  it('三个技能的 spec 与注册表对得上（DoD ①的下游）', () => {
    for (const n of ['AssessTipSharpness', 'AssessTipFromSpectrum', 'InvertForceSaderJarvis', 'AssessAtomicConsistency']) {
      expect([n, (SKILLS[n] as Skill).spec.name]).toEqual([n, n])
    }
  })
})
