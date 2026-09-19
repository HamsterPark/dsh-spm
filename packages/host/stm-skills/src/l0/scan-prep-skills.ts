/**
 * 扫描图自动预处理的技能外壳 —— **判据本体在 `dsh-spm-vision` 的 `scan-prep.ts`**。
 *
 * * `AnalyzeScanImage` —— 一张 `.sxm`：量指标、选平场方式与色阶、说清楚为什么。
 * * `AutoProcessScanBatch` —— 一个文件夹：同上 + 批次一致性 + `_report.md`。
 *
 * ## 这一层只做 IO，一个阈值都不判
 *
 * 判据是 `measureFrame` / `planFor` 两个纯函数（零 IO、阈值全参数化，
 * 所以合成数据测得动）。这里只负责：读文件、解析像素尺度、挑 profile、写报告。
 *
 * ## 结论从哪来
 *
 * 「这一帧上有什么」的结论**不在这里产生**，而是转发既有判据：原子相来自
 * `assessAtomicPhase`，针尖突变来自 `detectTipChange`，正反扫来自
 * `fwdBwdInstability`，坏行 / 振荡来自 `detectScanArtifacts`。
 * 本技能自己只回答一个问题：**这一帧该怎么处理**。
 *
 * ## 三态，不是两态
 *
 * 只要文件读得动就 `success = true`；判据的结论在 `data` 里。
 * 技能失败保留给「**这件事没做成**」—— 文件不存在、通道缺失。
 * 把「这一帧质量不好」表达成技能失败，会让 composite 里 `optional: false` 的步骤
 * 直接中止整条流程，而「这一帧不好」恰恰是流程要处理的**正常情况**。
 *
 * ## ⚠️ PNG **没有移**（deviation，见 `spec/deviations.md` 批 6b 那一节）
 *
 * 旧仓 `_render` 走 matplotlib，而盘点把 matplotlib 归在 **D 档**
 * （「本仓没有、也不该有 matplotlib 等价物」）。于是 `png_path` **恒为空串**、
 * `images` 恒为空表 —— 而这**正好是旧仓自己的一条合法路径**
 * （`_render` 画不出来时 `return ""`，注释写着「画不出来不该让分析失败」）。
 * 形状因此是对得上的，差的只是本仓永远走那一支。
 *
 * `_write_report` 反过来**照移**：它是纯字符串拼接 + 一次写文件，
 * 而报告正文是这个技能的产品之一（每一个实测数字 + 每一个决定的理由）。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve as pathResolve } from 'node:path'
import {
  formatG,
  pyFixed,
  pyFloatRepr,
  resolveScanPrepThresholds,
  type ScanPrepThresholds,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { type Mat } from 'dsh-spm-numerics'
import {
  METHOD_LABEL,
  harmoniseBatch,
  measureFrame,
  planFor,
  thresholdLine,
  type FlattenPlan,
  type FrameMetrics,
} from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { loadSxm, orient, strParam } from './analysis-common.js'

/** 一次批处理最多看多少个文件 —— 防止有人把整个数据盘指过来。 */
const MAX_BATCH = 200

/** 一帧读进来之后的样子（旧仓 `_load_frame` 交出来的那个 dict）。 */
interface LoadedFrame {
  readonly forward: Mat
  readonly backward: Mat | null
  readonly nmPerPx: number | null
  readonly widthNm: number | null
  readonly heightNm: number | null
  readonly biasV: number | null
  readonly recTime: string
}

type LoadResult = { ok: true; fr: LoadedFrame } | { ok: false; err: string }

/**
 * `(frames, error)` —— error 非空即读不动。
 *
 * ⚠️ 三条**不同**的失败话术照移，一个字都不合并：
 * 文件不存在 / 读不动 `.sxm`（**带异常类名**，D-ANALYSIS-1 的那一族）/ 没有这个通道
 * （后者把**这个文件里有什么**一起说出来 —— 否则调用方只知道自己错了，不知道该改成什么）。
 */
function loadFrame(scanPath: string, channel: string): LoadResult {
  if (!existsSync(scanPath)) return { ok: false, err: `文件不存在: ${scanPath}` }
  const got = loadSxm(scanPath)
  if (!got.ok) return { ok: false, err: `读不动 .sxm: ${got.why}` }
  const fr = orient(got.scan, channel)
  if (fr.forward === null) {
    const have = Object.keys(got.scan.channels ?? {})
    return { ok: false, err: `没有 ${pyRepr(channel)} 通道(这个文件里有: ${pyList(have)})` }
  }
  return {
    ok: true,
    fr: {
      forward: fr.forward,
      backward: fr.backward,
      nmPerPx: fr.nm_per_px,
      widthNm: fr.width_nm,
      heightNm: fr.height_nm,
      biasV: fr.bias_v,
      recTime: fr.rec_time,
    },
  }
}

/** Python 的 `repr(str)` —— 单引号。 */
function pyRepr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Python 的 `str(list_of_str)`。 */
function pyList(xs: readonly string[]): string {
  return `[${xs.map(pyRepr).join(', ')}]`
}

/**
 * `f"{x:+.2f}"` —— 非负数也带符号。
 *
 * 2026-09-19：这里原本还有一个本地的 `fx()` 包着 `pyFixed`，挡的是
 * 「`pyFixed(-0, n)` 丢负号」与非有限值两件事。`pyFixed` 现在两件都自己管
 * （负号取自输入，`nan`/`inf`/`-inf` 照 Python 印），**那层挡板撤了**，
 * 十处调用直接走 `pyFixed` —— 留着它，下一个人会以为这里有坑。行为一字未变。
 */
function fxSigned(x: number, d: number): string {
  const s = pyFixed(x, d)
  return s.startsWith('-') || s === 'nan' ? s : `+${s}`
}

/**
 * 格式化一个可能缺席的表头数值 —— 旧仓 `_g`。
 *
 * 头里没有 `SCAN_RANGE` / `BIAS` 的文件是存在的（截断的、别家软件导出的），
 * **不能让一个 `None` 把整份报告的格式化炸掉**。
 */
function gOpt(v: number | null | undefined, unit = ''): string {
  if (v === null || v === undefined) return '?'
  if (!Number.isFinite(v)) return '?'
  return `${formatG(v, 6)}${unit}`
}

/** `Path(p).stem` —— 去掉目录与最后一个扩展名。 */
function stemOf(p: string): string {
  const b = basename(p.replace(/\\/g, '/'))
  const i = b.lastIndexOf('.')
  return i <= 0 ? b : b.slice(0, i)
}

/** 输出目录：给了就用，没给就落在**扫描文件旁边**（本仓没有 `figures_dir()`）。 */
function outputDir(explicit: string, fallback: string): string {
  const d = explicit !== '' ? explicit : fallback
  mkdirSync(d, { recursive: true })
  return d
}

// ── AnalyzeScanImage ───────────────────────────────────────────────────────

export const AnalyzeScanImage: Skill = {
  spec: S.AnalyzeScanImageSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const scanPath = String(params['scan_path'] ?? '')
    const channel = strParam(params, 'channel', 'Z')
    const flatten = strParam(params, 'flatten', 'auto').toLowerCase()
    const profile = strParam(params, 'threshold_profile', '').trim()
    const got = loadFrame(scanPath, channel)
    if (!got.ok) return { success: false, error: got.err }
    const th = resolveScanPrepThresholds(profile === '' ? null : profile)
    let m: FrameMetrics
    let plan: FlattenPlan
    try {
      m = measureFrame(got.fr.forward, { bwd: got.fr.backward, nmPerPx: got.fr.nmPerPx, thresholds: th })
      plan = planFor(m, th, flatten)
    } catch (e) {
      const err = e as Error
      return { success: false, error: `分析失败: ${err.name}: ${err.message}` }
    }
    // PNG：见文件抬头。旧仓 `_render` 的失败支同样给空串。
    const png = ''
    const data = {
      scan_path: scanPath,
      channel,
      nm_per_px: got.fr.nmPerPx,
      width_nm: got.fr.widthNm,
      bias_v: got.fr.biasV,
      metrics: metricsDict(m),
      plan: planDict(plan),
      png_path: png,
    }
    const summary =
      `${basename(scanPath.replace(/\\/g, '/'))} [${channel}] → ${plan.method}` +
      `(${METHOD_LABEL[plan.method] ?? plan.method}), 色阶 ` +
      `${pyFloatRepr(plan.clip[0])}–${pyFloatRepr(plan.clip[1])} 百分位 | line_gain ${pyFixed(m.lineGain, 2)} ` +
      `bow_gain ${pyFixed(m.bowGain, 2)} 行相关 ${pyFixed(m.rowcorrMedian, 2)}` +
      `\n依据: ${plan.why.join(' / ')}` +
      (plan.notes.length > 0 ? `\n注意: ${plan.notes.join(' / ')}` : '') +
      `\n阈值 profile \`${plan.profile}\` — ${plan.provenance}`
    return { success: true, data, summary }
  },
}

/** `FrameMetrics.to_dict()` —— **去掉下划线开头的内部量**，键名按旧仓的 snake_case。 */
function metricsDict(m: FrameMetrics): Record<string, unknown> {
  return {
    shape: [m.shape[0], m.shape[1]],
    nm_per_px: m.nmPerPx,
    nan_frac: m.nanFrac,
    dead_rows: m.deadRows,
    analysis_rows: [m.analysisRows[0], m.analysisRows[1]],
    plane_rms_pm: m.planeRmsPm,
    line_gain: m.lineGain,
    bow_gain: m.bowGain,
    roughness_pm: m.roughnessPm,
    n_peaks: m.nPeaks,
    step_sep_pm: m.stepSepPm,
    sep_over_rough: m.sepOverRough,
    row_purity: m.rowPurity,
    fine_periodic_snr: m.finePeriodicSnr,
    fine_period_nm: m.finePeriodNm,
    fine_angle_deg: m.fineAngleDeg,
    rowcorr_median: m.rowcorrMedian,
    atomic: m.atomic,
    tip_change: m.tipChange,
    artifacts: m.artifacts,
    fb_instability: m.fbInstability,
    delegate_errors: m.delegateErrors,
  }
}

/** `FlattenPlan.to_dict()`。 */
function planDict(p: FlattenPlan): Record<string, unknown> {
  return {
    method: p.method,
    method_label: METHOD_LABEL[p.method] ?? p.method,
    clip_percentile: [p.clip[0], p.clip[1]],
    why: [...p.why],
    notes: [...p.notes],
    step_like: p.stepLike,
    fine_structure: p.fineStructure,
    threshold_profile: p.profile,
    threshold_provenance: p.provenance,
  }
}

// ── AutoProcessScanBatch ───────────────────────────────────────────────────

interface BatchItem {
  readonly path: string
  readonly fr: LoadedFrame
  readonly m: FrameMetrics
  plan: FlattenPlan
}

export const AutoProcessScanBatch: Skill = {
  spec: S.AutoProcessScanBatchSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const folder = String(params['folder'] ?? '')
    const channel = strParam(params, 'channel', 'Z')
    const flatten = strParam(params, 'flatten', 'auto').toLowerCase()
    const profile = strParam(params, 'threshold_profile', '').trim()
    const doReport = params['write_report'] === undefined ? true : Boolean(params['write_report'])
    const maxFilesRaw = Number(params['max_files'] ?? MAX_BATCH)
    const maxFiles = Number.isFinite(maxFilesRaw) && maxFilesRaw !== 0 ? Math.trunc(maxFilesRaw) : MAX_BATCH

    let isDir = false
    try {
      isDir = statSync(folder).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) return { success: false, error: `不是一个目录: ${folder}` }
    // `sorted(folder.glob("*.sxm"))` —— 按**完整路径**排序（同目录下等价于按文件名）。
    const all = readdirSync(folder)
      .filter((f) => f.toLowerCase().endsWith('.sxm'))
      .map((f) => join(folder, f))
      .sort()
    const files = all.slice(0, Math.max(1, Math.min(maxFiles, MAX_BATCH)))
    if (files.length === 0) return { success: false, error: `${folder} 里没有 .sxm 文件` }

    const th = resolveScanPrepThresholds(profile === '' ? null : profile)
    const items: BatchItem[] = []
    const skipped: string[] = []
    for (const path of files) {
      const got = loadFrame(path, channel)
      if (!got.ok) {
        skipped.push(`${basename(path)}: ${got.err}`)
        continue
      }
      try {
        const m = measureFrame(got.fr.forward, {
          bwd: got.fr.backward,
          nmPerPx: got.fr.nmPerPx,
          thresholds: th,
        })
        items.push({ path, fr: got.fr, m, plan: planFor(m, th, flatten) })
      } catch (e) {
        const err = e as Error
        skipped.push(`${basename(path)}: ${err.name}: ${err.message}`)
      }
    }
    if (items.length === 0) {
      return { success: false, error: `这个目录里没有一张读得动的 .sxm。${skipped.slice(0, 5).join(' | ')}` }
    }

    // ── 批次一致性（**只在 auto 模式下**；调用方指定了方式就没有票可投） ──
    //
    // ⚠️ 这道 `if` **在当前形状下做不了决定**（演练照此没有给它变异，同 green-8 §2.8）：
    // 给了 override 时 `planFor` 把**每一帧**的 `method` 都设成那个值 ⇒ `methods`
    // 全同 ⇒ `nWin === methods.length` ⇒ `harmoniseBatch` 直接 `continue`，
    // 一个字都不改。也就是说「跳过投票」与「投一次全票一致的票」输出相同。
    // **不删它**：它是旧仓那一行的逐字照移，而且哪天 `planFor` 允许**部分**覆盖
    // （比如只覆盖某一类帧）它就会立刻开始做决定。
    if (flatten === 'auto') {
      const keyed = items.map(
        (it) =>
          [
            `(${pyFloatKey(round3(it.fr.widthNm ?? 0))}, ${pyFloatKey(round4(it.fr.biasV ?? 0))})`,
            it.plan,
          ] as const,
      )
      const merged = harmoniseBatch(keyed, th)
      items.forEach((it, i) => {
        it.plan = merged[i] as FlattenPlan
      })
    }

    const out = outputDir(String(params['output_dir'] ?? ''), pathResolve(folder))
    const rows = items.map((it) => ({
      file: basename(it.path),
      width_nm: it.fr.widthNm,
      bias_v: it.fr.biasV,
      nm_per_px: it.fr.nmPerPx,
      method: it.plan.method,
      clip_percentile: [it.plan.clip[0], it.plan.clip[1]],
      step_like: it.plan.stepLike,
      line_gain: round(it.m.lineGain, 3),
      bow_gain: round(it.m.bowGain, 3),
      row_purity: it.m.rowPurity,
      sep_over_rough: round(it.m.sepOverRough, 2),
      rowcorr_median: it.m.rowcorrMedian,
      fb_instability: it.m.fbInstability,
      nan_frac: round(it.m.nanFrac, 4),
      atomic_passed: it.m.atomic === null ? null : it.m.atomic.passed,
      atomic_reasons: it.m.atomic === null ? null : [...it.m.atomic.reasons],
      tip_changed: it.m.tipChange === null ? null : it.m.tipChange.changed,
      png_path: '',
    }))

    let reportPath = ''
    if (doReport) reportPath = writeReport(out, channel, th, items, skipped)

    const counts: Record<string, number> = {}
    for (const r of rows) counts[r.method] = (counts[r.method] ?? 0) + 1
    const data = {
      folder,
      channel,
      output_dir: out,
      report_path: reportPath,
      n_files: rows.length,
      method_counts: counts,
      skipped,
      frames: rows,
      threshold_profile: th.name,
    }
    // `sorted(counts.items(), key=lambda kv: -kv[1])` —— Python 的 sort 是**稳定**的，
    // 所以计数相同时按插入序（= 第一次出现的顺序）。JS 的 `sort` 自 ES2019 起也稳定。
    const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1])
    const summary =
      `${rows.length} 张 [${channel}] → ` +
      ordered.map(([k, v]) => `${k} × ${v}`).join(', ') +
      (skipped.length > 0 ? `;${skipped.length} 张读不动` : '') +
      (reportPath !== '' ? `\n报告(每张图测了什么、为什么这么处理): ${reportPath}` : '') +
      `\n阈值 profile \`${th.name}\` — ${th.provenance}`
    return { success: true, data, summary }
  },
}

/** `round(x, n)` 的 Python 语义（四舍六入五成双），返回**数**。 */
function round(x: number, n: number): number {
  if (!Number.isFinite(x)) return x
  return Number(pyFixed(x, n))
}

function round3(x: number): number {
  return round(x, 3)
}

function round4(x: number): number {
  return round(x, 4)
}

/** 分组键里那个 float 的 `repr` —— 键只用来分组与印在报文里，走 Python 的写法。 */
function pyFloatKey(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x)
}

/**
 * 把每张图测到的数与每一步依据写成 Markdown。**写不成返回空串** ——
 * 写不出报告不该让整个批处理失败（旧仓同）。
 */
function writeReport(
  out: string,
  channel: string,
  th: ScanPrepThresholds,
  items: readonly BatchItem[],
  skipped: readonly string[],
): string {
  const path = join(out, '_report.md')
  try {
    const L: string[] = []
    L.push('# 扫描图自动预处理报告\n')
    L.push(`通道 \`${channel}\`,共 ${items.length} 个文件。下表是每张图测到的量,以及据此选择的处理方式。\n`)
    L.push(`**阈值 profile**:\`${th.name}\` —— ${th.provenance}\n`)
    L.push(
      '| 文件 | 视野 | 偏压 | NaN | line_gain | bow_gain | ' +
        '峰数/间距比/行纯度 | 精细SNR/周期 | 行相关 | 正反扫不稳 | ' +
        '原子相 | 针尖突变 | 处理 |',
    )
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const it of items) {
      const m = it.m
      const plan = it.plan
      const fr = it.fr
      const pur = Number.isNaN(m.rowPurity) ? '–' : pyFixed(m.rowPurity, 2)
      const fine = plan.fineStructure
        ? `**${pyFixed(m.finePeriodicSnr, 0)} / ${pyFixed(m.finePeriodNm, 3)}nm**`
        : `${pyFixed(m.finePeriodicSnr, 0)} / –`
      const a = m.atomic
      const atom = a !== null && a.passed ? '**通过**' : a !== null && a.reasons.includes('scale_gate') ? '判不了' : '未通过'
      const tc = m.tipChange
      const tcs =
        tc !== null && tc.changed
          ? `**是**@${String(tc.change_row)}`
          : tc !== null
            ? `否(z ${pyFixed(tc.score, 1)})`
            : '–'
      const fb = m.fbInstability === null ? '–' : pyFixed(m.fbInstability, 2)
      L.push(
        `| ${stemOf(it.path).slice(-4)} | ${gOpt(fr.widthNm, ' nm')} | ` +
          `${gOpt(fr.biasV, ' V')} | ` +
          `${pyFixed(m.nanFrac * 100, 0)}% | ${pyFixed(m.lineGain, 2)} | ${pyFixed(m.bowGain, 2)} | ` +
          `${m.nPeaks} / ${pyFixed(m.sepOverRough, 1)} / ${pur} | ${fine} | ` +
          `${fxSigned(m.rowcorrMedian, 2)} | ${fb} | ${atom} | ${tcs} | ` +
          `\`${plan.method}\` |`,
      )
    }
    L.push('')
    L.push(`判据阈值:${thresholdLine(th)}`)
    L.push('')
    L.push(
      '> 「原子相」「针尖突变」「正反扫不稳」三列**不是本模块自己判的**,' +
        '分别转发 `mast.vision.atomic_phase` / `mast.vision.tip_change` / ' +
        '`mast.vision.tip_metrics`。' +
        '「精细SNR」只用来决定色阶,不是「有没有晶格」的结论 —— ' +
        '峰强度分不开针尖抖动造出的准周期条纹。详见 ' +
        '`docs/v2/design/scan_prep_auto_flatten.md`。',
    )
    L.push('')
    if (skipped.length > 0) {
      L.push('## 读不动的文件\n')
      for (const s of skipped) L.push(`- ${s}`)
      L.push('')
    }
    L.push('---\n')
    L.push('## 逐张说明\n')
    for (const it of items) {
      const m = it.m
      const plan = it.plan
      const fr = it.fr
      L.push(`### ${stemOf(it.path)}\n`)
      L.push(
        `${gOpt(fr.widthNm)} × ${gOpt(fr.heightNm ?? fr.widthNm)} nm, ` +
          `V = ${gOpt(fr.biasV)} V, ${fr.recTime}, ` +
          `${m.shape[0]}×${m.shape[1]} px (${pyFixed(m.nmPerPx ?? 0, 4)} nm/px)\n`,
      )
      L.push(
        `**处理**:${METHOD_LABEL[plan.method] ?? plan.method};` +
          `色阶 ${pyFloatRepr(plan.clip[0])}–${pyFloatRepr(plan.clip[1])} 百分位\n`,
      )
      L.push('**依据**:')
      for (const w of plan.why) L.push(`- ${w}`)
      if (plan.notes.length > 0) {
        L.push('\n**注意**:')
        for (const n of plan.notes) L.push(`- ${n}`)
      }
      L.push('')
    }
    writeFileSync(path, L.join('\n'), 'utf8')
    return path
  } catch {
    return ''
  }
}

export const SCAN_PREP_SKILLS: Readonly<Record<string, Skill>> = {
  AnalyzeScanImage,
  AutoProcessScanBatch,
}
