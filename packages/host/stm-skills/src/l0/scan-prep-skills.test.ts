/**
 * 批 6b 两个技能对 `spec/golden/scan_prep.json` 的**逐格**比对（DoD ③ + ⑤）。
 *
 * 体例同批 4a/4b：金样里每一格都是**旧仓真技能**跑在同一批 `.sxm` 字节上的完整
 * `SkillResult`，这里把 TS 那一侧整棵摆过去逐叶子比 —— 字符串逐字（里面印着
 * `%.2f` / `%.3f` / `%.0%` 的数，于是一条字符串断言顺带钉住了那个数的位数与措辞）。
 *
 * ## 这一批**有一处刻意不同**：PNG
 *
 * 旧仓 `_render` 走 matplotlib（盘点 D 档），本仓没有等价物 ⇒ `png_path` 恒为空串、
 * `images` 恒为空表。金样因此一律以 `save_png=False` / `render=False` 录，
 * 而「`save_png=true` 时除了这两处每一格逐字相同」由下面一条断言单独钉住。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  diffTree,
  formatMismatches,
  scalesOf,
  toGolden,
  fftSharpnessRelTol,
  FB_INSTABILITY_ABS_TOL,
  FLATTEN_REL_TOL,
  FINE_PEAK_REL_TOL,
  OSC_REL_TOL,
} from 'dsh-spm-vision'
import type { Skill, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { AnalyzeScanImage, AutoProcessScanBatch } from './scan-prep-skills.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/scan_prep.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const SKILLS: Record<string, Skill> = { AnalyzeScanImage, AutoProcessScanBatch }

let TMP = ''
let BATCH = ''
let OUT = ''

/** 批次那一组四个文件（导出器写在 `<batch>` 子目录里）。 */
const BATCH_KEYS = ['g_line_a', 'g_line_b', 'g_plane', 'g_steps']

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'scanprep-golden-')).replaceAll('\\', '/')
  BATCH = `${TMP}/batch`
  OUT = `${TMP}/out`
  mkdirSync(BATCH, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  for (const [key, b64] of Object.entries(GOLDEN['sxm_files'] as Record<string, string>)) {
    const dir = BATCH_KEYS.includes(key) ? BATCH : TMP
    writeFileSync(`${dir}/${key}.sxm`, Buffer.from(b64, 'base64'))
  }
})

/** 把金样里的占位换回本次运行的真实目录。 */
function realPath(v: unknown): unknown {
  if (typeof v === 'string') return v.replaceAll('<batch>', BATCH).replaceAll('<out>', OUT).replaceAll('<tmp>', TMP)
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
      .replaceAll('\\', '/')
      .replaceAll(BATCH, '<batch>')
      .replaceAll(OUT, '<out>')
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
  return {
    success: r.success,
    error: r.error ?? '',
    summary: r.summary ?? '',
    data: r.data ?? {},
    images: [],
  }
}

const CTX = {} as unknown as SkillContext

/**
 * 数值容差按字段分三档，**全部来自被测件自己导出的常量**：
 * `fine_*` 三个的尺度是一次 `fft2`（{@link FINE_PEAK_REL_TOL}），其余数值的尺度是
 * 残差的 std（{@link FLATTEN_REL_TOL}）—— 两个数今天相同（`1e−9`）而**理由不同**，
 * 所以分开引用；第三档是下面那一个。字符串、布尔、计数**逐字**。
 */
/**
 * `fft_sharpness` 走**另一条**容差（批 4b 的 {@link fftSharpnessRelTol}）。
 *
 * 旧仓那次 FFT 在 **float32** 里做（`_detrend` 的输出是 float32，numpy 的 `fft2`
 * 对 float32 回 complex64），而本仓只把输入降到 float32、变换留在 float64。
 * 那条容差**随锐度线性放大**，推导写在 `vision/tip-metrics.ts` 上。
 * 它是这一批**唯一**一个不能走 `FLATTEN_REL_TOL` 的字段。
 */
const SHARPNESS_FIELDS = new Set(['.data.metrics.atomic.fft_sharpness'])

/**
 * 另外三个字段各有自己的容差，**每一个都有名字、都推得出来**：
 *
 * | 字段 | 容差 | 尺度是谁 |
 * |---|---|---|
 * | `artifacts.oscillation_severity` | {@link OSC_REL_TOL} | 两个 **float32** FFT 极大之比 |
 * | `fb_instability` | {@link FB_INSTABILITY_ABS_TOL}（**绝对**） | `1 − max_ncc` 是一次相消 |
 * | `fine_angle_deg` | ±k **孪生峰**：折到 `(−90, 90]` 再按 {@link FINE_PEAK_REL_TOL} 比 | 见 `scan-prep.test.ts` 的 `toCamelPeak` |
 *
 * 最后那一条不是「容差放宽」：实信号谱上 ±k 是一个**精确的平局**，
 * 谁先到手由最后一位浮点决定，而那两个角描述的是**同一条**周期结构。
 */
const OSC_FIELDS = new Set(['.data.metrics.artifacts.oscillation_severity'])
const FB_FIELDS = new Set(['.data.metrics.fb_instability', '.data.frames.fb_instability'])
const ANGLE_FIELDS = new Set(['.data.metrics.fine_angle_deg'])

/** 折到 `(−90, 90]`。 */
function foldAngle(a: number): number {
  if (!Number.isFinite(a)) return a
  let x = a
  while (x > 90) x -= 180
  while (x <= -90) x += 180
  return x
}

function expectResult(got: SkillResultLike, want: unknown): void {
  const a = normalize(asGolden(got))
  const b = normalize(want)
  const ms = diffTree(toGolden(a), b, Math.max(FLATTEN_REL_TOL, FINE_PEAK_REL_TOL), scalesOf(b)).filter((m) => {
    const flat = m.path.replace(/\[\d+\]/g, '')
    if (typeof m.actual !== 'number' || typeof m.want !== 'number') return true
    if (SHARPNESS_FIELDS.has(flat)) {
      return !(Math.abs(m.actual - m.want) <= fftSharpnessRelTol(m.want) * Math.abs(m.want))
    }
    if (OSC_FIELDS.has(flat)) return !(Math.abs(m.actual - m.want) <= OSC_REL_TOL * Math.abs(m.want))
    if (FB_FIELDS.has(flat)) return !(Math.abs(m.actual - m.want) <= FB_INSTABILITY_ABS_TOL)
    if (ANGLE_FIELDS.has(flat)) {
      const d = Math.abs(foldAngle(m.actual) - foldAngle(m.want))
      return !(d <= FINE_PEAK_REL_TOL * Math.max(1, Math.abs(foldAngle(m.want))))
    }
    return true
  })
  expect(ms.length === 0 || formatMismatches(ms, 20)).toBe(true)
}

/** 金样里存的路径是占位，跑的时候要换成真路径。 */
function realParams(p: Record<string, unknown>): Record<string, unknown> {
  return realPath(p) as Record<string, unknown>
}

for (const name of ['AnalyzeScanImage', 'AutoProcessScanBatch']) {
  describe(name, () => {
    for (const row of GOLDEN['skills'][name] as any[]) {
      it(`${row.case}`, async () => {
        const skill = SKILLS[name] as Skill
        const got = await skill.execute(CTX, realParams(row.params as Record<string, unknown>))
        expectResult(got, {
          success: row.success,
          error: row.error,
          summary: row.summary,
          data: row.data,
          images: row.images,
        })
      })
    }
  })
}

describe('批 6b 的两处**刻意不同**', () => {
  it('PNG 没移：`save_png=true` 时除了 `png_path`/`images` 之外**每一格逐字相同**', async () => {
    // 一个「报没报」的问题不能写成「报了的话就检查一下」（green-8 §2.4）——
    // 所以这里把两次调用整棵比，而不是 `if ('png_path' in data)`。
    const base = await AnalyzeScanImage.execute(CTX, { scan_path: `${TMP}/plane.sxm`, channel: 'Z', save_png: false })
    const withPng = await AnalyzeScanImage.execute(CTX, { scan_path: `${TMP}/plane.sxm`, channel: 'Z', save_png: true })
    expect(withPng.data?.['png_path']).toBe('')
    expect((withPng as { images?: readonly string[] }).images ?? []).toEqual([])
    expect(JSON.stringify(withPng.data)).toBe(JSON.stringify(base.data))
    expect(withPng.summary).toBe(base.summary)
  })

  it('PNG 没移（批量那一半）：`render=true` 时每一帧的 `png_path` 也是空串', async () => {
    // ⚠️ 这一格顺带钉住那句**给模型的承诺**：技能描述里写着「它会渲染出这些 PNG，
    // 并写一份 _report.md」，而本仓只做得到后半句。DoD ② 要求描述与旧仓**逐字相同**，
    // 所以那句话改不了 —— 它只能是一条**响亮的** deviation（D-SCANPREP-2），
    // 外加这里这条断言：**报告在、图不在**，而两者都不许静默。
    const rendered = await AutoProcessScanBatch.execute(CTX, {
      folder: BATCH,
      channel: 'Z',
      render: true,
      write_report: false,
      output_dir: OUT,
    })
    expect(rendered.success).toBe(true)
    const frames = (rendered.data?.['frames'] as Array<Record<string, unknown>>) ?? []
    expect(frames.length).toBeGreaterThan(0)
    for (const f of frames) expect(f['png_path']).toBe('')
    expect((rendered as { images?: readonly string[] }).images ?? []).toEqual([])
  })

  it('报告正文与旧仓逐字相同（它是这个技能的产品之一）', async () => {
    const res = await AutoProcessScanBatch.execute(CTX, {
      folder: BATCH,
      channel: 'Z',
      render: false,
      write_report: true,
      output_dir: OUT,
    })
    expect(res.success).toBe(true)
    const path = String(res.data?.['report_path'] ?? '')
    expect(path).not.toBe('')
    const text = readFileSync(path, 'utf8')
    expect(text).toBe(GOLDEN['report_md'] as string)
  })
})

describe('技能层自己的几条', () => {
  it('三条**不同**的失败话术一个字都不合并', async () => {
    const missing = await AnalyzeScanImage.execute(CTX, { scan_path: `${TMP}/nope.sxm`, channel: 'Z' })
    expect(missing.error).toContain('文件不存在')
    const noChannel = await AnalyzeScanImage.execute(CTX, { scan_path: `${TMP}/current_only.sxm`, channel: 'Z' })
    // 「这个文件里有什么」必须一起说出来 —— 否则调用方只知道自己错了，不知道该改成什么。
    expect(noChannel.error).toContain("没有 'Z' 通道")
    expect(noChannel.error).toContain('Current')
  })

  it('**三态不是两态**：帧质量差照样 `success = true`', async () => {
    // 把「这一帧不好」表达成技能失败，会让 composite 里 `optional: false` 的步骤
    // 直接中止整条流程，而「这一帧不好」恰恰是流程要处理的正常情况。
    for (const key of ['noisy', 'tipchange', 'badrows_many', 'unfinished', 'near_flat']) {
      const r = await AnalyzeScanImage.execute(CTX, { scan_path: `${TMP}/${key}.sxm`, channel: 'Z' })
      expect(r.success || `${key} 不该失败：${String(r.error)}`).toBe(true)
    }
  })

  it('批次一致性**只在 auto 模式下**做（调用方指定了方式就没有票可投）', async () => {
    const auto = await AutoProcessScanBatch.execute(CTX, {
      folder: BATCH,
      channel: 'Z',
      render: false,
      write_report: false,
      output_dir: OUT,
    })
    const forced = await AutoProcessScanBatch.execute(CTX, {
      folder: BATCH,
      channel: 'Z',
      flatten: 'plane',
      render: false,
      write_report: false,
      output_dir: OUT,
    })
    const methodsOf = (r: SkillResultLike): string[] =>
      ((r.data?.['frames'] as Array<Record<string, unknown>>) ?? []).map((f) => String(f['method']))
    // auto：多数票把那张 `plane` 改成 `line`，而台阶那张豁免。
    expect(methodsOf(auto)).toEqual(['line', 'line', 'line', 'masked_line'])
    // 指定了方式：四张全是 `plane`，一次投票都没有。
    expect(methodsOf(forced)).toEqual(['plane', 'plane', 'plane', 'plane'])
  })

  it('`max_files` 截断，而**不是**报错', async () => {
    const r = await AutoProcessScanBatch.execute(CTX, {
      folder: BATCH,
      channel: 'Z',
      render: false,
      write_report: false,
      output_dir: OUT,
      max_files: 1,
    })
    expect(r.success).toBe(true)
    expect(r.data?.['n_files']).toBe(1)
  })
})
